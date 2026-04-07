// ══════════════════════════════════════════════════════════════════════════════
// Raw WebGPU Fluid Renderer — §3.2 SSFR Pipeline
//
// 5-pass rendering:
//   1. Depth sprites (sphere depth per particle)
//   2. Bilateral blur × 4 iterations (smooth depth, preserve edges)
//   3. Thickness map (additive)
//   4. Gaussian blur × 1 iteration (smooth thickness)
//   5. Composite (Fresnel + Beer's law + refraction + specular)
//
// Adapted from WaterBall (MIT) + structure.md §3.2 lines 1898-1946
// ══════════════════════════════════════════════════════════════════════════════

import depthMapWGSL from './depthMap.wgsl?raw'
import bilateralWGSL from './bilateral.wgsl?raw'
import thicknessMapWGSL from './thicknessMap.wgsl?raw'
import gaussianWGSL from './gaussian.wgsl?raw'
import compositeWGSL from './composite.wgsl?raw'
import fullScreenWGSL from './fullScreen.wgsl?raw'
import debugDepthWGSL from './debugDepth.wgsl?raw'

export class FluidRenderer {
  private device!: GPUDevice
  private context!: GPUCanvasContext
  private initialized = false
  private width = 0
  private height = 0
  private presentationFormat!: GPUTextureFormat

  // Textures
  private depthMapTex!: GPUTexture
  private tmpDepthMapTex!: GPUTexture
  private thicknessTex!: GPUTexture
  private tmpThicknessTex!: GPUTexture
  private depthTestTex!: GPUTexture
  private sceneTexture!: GPUTexture
  private compIdTexture!: GPUTexture

  // Pipelines
  private depthPipeline!: GPURenderPipeline
  private bilateralPipeline!: GPURenderPipeline
  private thicknessPipeline!: GPURenderPipeline
  private gaussianPipeline!: GPURenderPipeline
  compositePipeline!: GPURenderPipeline
  debugPipeline!: GPURenderPipeline
  debugBGL!: GPUBindGroupLayout

  // Buffers
  private particleBuffer!: GPUBuffer
  private externalParticleBuffer: GPUBuffer | null = null
  private uniformBuffer!: GPUBuffer
  private filterXBuf!: GPUBuffer
  private filterYBuf!: GPUBuffer
  private compositeUniformBuf!: GPUBuffer
  private compRenderPropsBuf!: GPUBuffer

  // Bind group layouts
  private depthBGL!: GPUBindGroupLayout
  private filterBGL!: GPUBindGroupLayout
  private compositeBGL!: GPUBindGroupLayout

  private sampler!: GPUSampler
  private maxParticles = 10000
  private boxHalf = [0.75, 0.75, 0.75] // half-extents for clipping — must match cubic box (1.5/2)
  private fluidColor = [0.13, 0.4, 0.87]
  private fluidDensity = 3.0
  private fluidF0 = 0.02
  private fluidEmissive = 0.0
  private fluidSpecPower = 250.0
  private fluidMetalness = 0.0
  private fluidIOR = 1.333
  private invProj = new Float32Array(16) // cached inverse projection for composite

  /**
   * Initialize with a SEPARATE overlay canvas for fluid rendering.
   * This avoids conflicting with Three.js's WebGPU canvas context.
   */
  async init(container: HTMLElement, width: number, height: number): Promise<boolean> {
    if (!navigator.gpu) {
      console.warn('FluidRenderer: WebGPU not available')
      return false
    }

    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return false
    this.device = await adapter.requestDevice()

    this.width = width
    this.height = height
    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat()

    // Create overlay canvas on top of Three.js canvas
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.style.position = 'absolute'
    canvas.style.top = '0'
    canvas.style.left = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.pointerEvents = 'none' // clicks pass through to Three.js
    container.style.position = 'relative'
    container.appendChild(canvas)

    this.context = canvas.getContext('webgpu') as GPUCanvasContext
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    })

    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

    this.createTextures()
    this.createBuffers()
    this.createPipelines()

    this.initialized = true
    console.log(`FluidRenderer: SSFR initialized (${this.width}×${this.height})`)
    return true
  }

  private createTextures() {
    const d = this.device
    const w = this.width, h = this.height
    const rt = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING

    this.depthMapTex = d.createTexture({ size: [w, h], format: 'r32float', usage: rt })
    this.tmpDepthMapTex = d.createTexture({ size: [w, h], format: 'r32float', usage: rt })
    this.thicknessTex = d.createTexture({ size: [w, h], format: 'r16float', usage: rt })
    this.tmpThicknessTex = d.createTexture({ size: [w, h], format: 'r16float', usage: rt })
    this.depthTestTex = d.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.sceneTexture = d.createTexture({ size: [w, h], format: this.presentationFormat, usage: rt | GPUTextureUsage.COPY_DST })
    this.compIdTexture = d.createTexture({ size: [w, h], format: 'r32uint', usage: rt })
  }

  private createBuffers() {
    const d = this.device
    this.particleBuffer = d.createBuffer({ size: this.maxParticles * 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) // 80 bytes per particle (expanded for 3x3 C matrix)
    this.uniformBuffer = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.filterXBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.filterYBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.compositeUniformBuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.compRenderPropsBuf = d.createBuffer({ size: 256 * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) // 256 compositions × 48 bytes each

    // Initialize comp render props with default water material at index 0
    const defaultProps = new Float32Array(12) // 48 bytes = 12 floats
    defaultProps[0] = 0.13; defaultProps[1] = 0.4; defaultProps[2] = 0.87 // color (water blue)
    defaultProps[3] = 3.0   // density
    defaultProps[4] = 0.02  // F0
    defaultProps[5] = 0.0   // metalness
    defaultProps[6] = 0.0   // emissive
    defaultProps[7] = 1.333 // IOR
    defaultProps[8] = 250.0 // specular_power
    defaultProps[9] = 3.0   // opacity_density
    // 10-11: padding
    d.queue.writeBuffer(this.compRenderPropsBuf, 0, defaultProps)

    d.queue.writeBuffer(this.filterXBuf, 0, new Float32Array([1, 0, 0, 0]))
    d.queue.writeBuffer(this.filterYBuf, 0, new Float32Array([0, 1, 0, 0]))
  }

  private createPipelines() {
    const d = this.device
    const w = this.width, h = this.height

    // Shader modules
    const depthMod = d.createShaderModule({ code: depthMapWGSL })
    const fullScreenMod = d.createShaderModule({ code: fullScreenWGSL })
    const bilateralMod = d.createShaderModule({ code: bilateralWGSL })
    const thicknessMod = d.createShaderModule({ code: thicknessMapWGSL })
    const gaussianMod = d.createShaderModule({ code: gaussianWGSL })
    const compositeMod = d.createShaderModule({ code: compositeWGSL })

    // ── Depth pipeline (particles → depth map) ────────────────────
    this.depthBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })

    const boxConst = { box_half_w: this.boxHalf[0], box_half_h: this.boxHalf[1], box_half_d: this.boxHalf[2] }

    this.depthPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }),
      vertex: { module: depthMod, entryPoint: 'vs' },
      fragment: {
        module: depthMod, entryPoint: 'fs',
        targets: [
          { format: 'r32float' },   // location(0): depth (frag_color)
          { format: 'r32uint' },    // location(1): composition ID
        ],
        constants: boxConst,
      },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      primitive: { topology: 'triangle-list' },
    })

    // ── Bilateral blur pipeline ───────────────────────────────────
    this.filterBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })

    this.bilateralPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.filterBGL] }),
      vertex: { module: fullScreenMod, entryPoint: 'vs', constants: { screenWidth: w, screenHeight: h } },
      fragment: {
        module: bilateralMod, entryPoint: 'fs',
        targets: [{ format: 'r32float' }],
        constants: { depth_threshold: 5.0, projected_particle_constant: 200.0, max_filter_size: 25.0 },
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Thickness pipeline (same vertex as depth, additive blend) ─
    this.thicknessPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }),
      vertex: { module: depthMod, entryPoint: 'vs' },
      fragment: {
        module: thicknessMod, entryPoint: 'fs',
        constants: boxConst,
        targets: [{
          format: 'r16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Gaussian blur pipeline ────────────────────────────────────
    this.gaussianPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.filterBGL] }),
      vertex: { module: fullScreenMod, entryPoint: 'vs', constants: { screenWidth: w, screenHeight: h } },
      fragment: { module: gaussianMod, entryPoint: 'fs', targets: [{ format: 'r16float' }] },
      primitive: { topology: 'triangle-list' },
    })

    // ── Composite pipeline ────────────────────────────────────────
    this.compositeBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // depth
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // thickness
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },                                   // scene
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },               // comp_id
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },         // comp render props
      ],
    })

    this.compositePipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
      vertex: { module: fullScreenMod, entryPoint: 'vs', constants: { screenWidth: w, screenHeight: h } },
      fragment: {
        module: compositeMod, entryPoint: 'fs',
        targets: [{
          format: this.presentationFormat,
          blend: {
            // Premultiplied alpha: shader outputs (R*A, G*A, B*A, A)
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Debug: depth visualization pipeline ───────────────────────
    const debugMod = d.createShaderModule({ code: debugDepthWGSL })
    this.debugBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    })
    this.debugPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.debugBGL] }),
      vertex: { module: fullScreenMod, entryPoint: 'vs', constants: { screenWidth: w, screenHeight: h } },
      fragment: {
        module: debugMod, entryPoint: 'fs',
        targets: [{
          format: this.presentationFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  setFluidMaterial(opts: {
    r: number, g: number, b: number,
    density: number,
    F0?: number,
    emissive?: number,
    specularPower?: number,
    metalness?: number,
    ior?: number,
  }) {
    this.fluidColor = [opts.r, opts.g, opts.b]
    this.fluidDensity = opts.density
    this.fluidF0 = opts.F0 ?? 0.02
    this.fluidEmissive = opts.emissive ?? 0.0
    this.fluidSpecPower = opts.specularPower ?? 250.0
    this.fluidMetalness = opts.metalness ?? 0.0
    this.fluidIOR = opts.ior ?? 1.333
  }

  /**
   * Accept an external GPU particle buffer directly (e.g., from MpmGpuSimulator).
   * The buffer must match the 80-byte particle layout expected by the shaders.
   * When set, this buffer is used instead of the internal particleBuffer for rendering.
   */
  setParticleBuffer(buffer: GPUBuffer) {
    this.externalParticleBuffer = buffer
  }

  /**
   * CPU-side particle upload for backwards compatibility.
   * Packs positions, velocities, and composition IDs into the 80-byte layout.
   */
  updateParticles(positions: Float32Array, velocities: Float32Array, compIds: Uint32Array | Uint8Array, count: number) {
    if (!this.initialized) return
    this.externalParticleBuffer = null // switch back to internal buffer
    // 80 bytes per particle = 20 x u32/f32 values
    const buf = new ArrayBuffer(count * 80)
    const f32 = new Float32Array(buf)
    const u32 = new Uint32Array(buf)
    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const base = i * 20 // 20 x 4-byte values per particle
      f32[base + 0] = positions[i3]      // pos_x
      f32[base + 1] = positions[i3 + 1]  // pos_y
      f32[base + 2] = positions[i3 + 2]  // pos_z
      u32[base + 3] = compIds[i]         // composition_id (u32)
      f32[base + 4] = velocities[i3]     // vel_x
      f32[base + 5] = velocities[i3 + 1] // vel_y
      f32[base + 6] = velocities[i3 + 2] // vel_z
      f32[base + 7] = 0                  // temperature
      // C matrix (9 floats, all zero for CPU upload)
      for (let c = 0; c < 9; c++) { f32[base + 8 + c] = 0 }
      u32[base + 17] = 0                 // phase
      u32[base + 18] = 0; u32[base + 19] = 0 // padding
    }
    this.device.queue.writeBuffer(this.particleBuffer, 0, buf, 0, count * 80)
  }

  /**
   * Upload composition render properties table (up to 256 entries, 48 bytes each).
   * data: Float32Array with 12 floats per entry (color_rgb, density, F0, metalness,
   *       emissive, IOR, specular_power, opacity_density, pad0, pad1).
   */
  updateCompositionRenderProps(data: Float32Array) {
    if (!this.initialized) return
    this.device.queue.writeBuffer(this.compRenderPropsBuf, 0, data.buffer, data.byteOffset, data.byteLength)
  }

  /**
   * Build projection matrix directly for WebGPU (Z: 0 to 1)
   * instead of extracting from Three.js which may have wrong coordinate system.
   */
  updateCamera(
    viewMatrix: Float32Array,
    fov: number, aspect: number, near: number, far: number,
    sphereSize: number,
  ) {
    if (!this.initialized) return

    // Build perspective projection for WebGPU NDC (Z: 0 to 1)
    const f = 1.0 / Math.tan(fov / 2)
    const nf = 1.0 / (near - far)
    const proj = new Float32Array(16)
    proj[0] = f / aspect
    proj[5] = f
    proj[10] = far * nf           // WebGPU: Z maps to [0, 1]
    proj[11] = -1
    proj[14] = near * far * nf
    // All other elements are 0

    // Compute inverse projection matrix for composite shader normal reconstruction
    // For a perspective matrix P, the inverse has a known closed-form:
    //   P = | f/a  0    0           0          |
    //       | 0    f    0           0          |
    //       | 0    0    far*nf      near*far*nf|
    //       | 0    0   -1           0          |
    //
    //   P^-1 = | a/f  0    0           0       |
    //          | 0    1/f  0           0       |
    //          | 0    0    0          -1       |
    //          | 0    0    1/(n*f*nf)  far*nf/(n*f*nf) |
    //          where nf = 1/(near-far)
    const ip = this.invProj
    ip.fill(0)
    // Column-major: index = col*4 + row
    ip[0]  = aspect / f                         // (row=0, col=0)
    ip[5]  = 1.0 / f                            // (row=1, col=1)
    ip[11] = 1.0 / (near * far * nf)            // (row=3, col=2) = (near-far)/(near*far)
    ip[14] = -1.0                               // (row=2, col=3)
    ip[15] = 1.0 / near                         // (row=3, col=3)

    const buf = new Float32Array(36)
    buf[0] = 1 / this.width; buf[1] = 1 / this.height; buf[2] = sphereSize; buf[3] = 0
    buf.set(proj, 4)
    buf.set(viewMatrix, 20)
    this.device.queue.writeBuffer(this.uniformBuffer, 0, buf)
  }

  /**
   * Copy the Three.js canvas content to the scene texture for refraction
   */
  captureScene(threeCanvas: HTMLCanvasElement) {
    if (!this.initialized) return
    this.device.queue.copyExternalImageToTexture(
      { source: threeCanvas },
      { texture: this.sceneTexture },
      { width: Math.min(threeCanvas.width, this.width), height: Math.min(threeCanvas.height, this.height) },
    )
  }

  render(numParticles: number, time: number = 0) {
    if (!this.initialized) return

    // Always clear the overlay — even with 0 particles
    if (numParticles === 0) {
      if (this.context) {
        const encoder = this.device.createCommandEncoder()
        const outputView = this.context.getCurrentTexture().createView()
        const p = encoder.beginRenderPass({
          colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        })
        p.end()
        this.device.queue.submit([encoder.finish()])
      }
      return
    }

    const d = this.device
    const activeParticleBuf = this.externalParticleBuffer ?? this.particleBuffer
    const depthView = this.depthMapTex.createView()
    const tmpDepthView = this.tmpDepthMapTex.createView()
    const thickView = this.thicknessTex.createView()
    const tmpThickView = this.tmpThicknessTex.createView()
    const depthTestView = this.depthTestTex.createView()
    const compIdView = this.compIdTexture.createView()

    // Create bind groups fresh each frame (views may change)
    const depthBG = d.createBindGroup({
      layout: this.depthBGL,
      entries: [
        { binding: 0, resource: { buffer: activeParticleBuf } },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
      ],
    })

    const filterBG_depthX = d.createBindGroup({
      layout: this.filterBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: depthView },
        { binding: 2, resource: { buffer: this.filterXBuf } },
      ],
    })
    const filterBG_depthY = d.createBindGroup({
      layout: this.filterBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: tmpDepthView },
        { binding: 2, resource: { buffer: this.filterYBuf } },
      ],
    })
    const filterBG_thickX = d.createBindGroup({
      layout: this.filterBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: thickView },
        { binding: 2, resource: { buffer: this.filterXBuf } },
      ],
    })
    const filterBG_thickY = d.createBindGroup({
      layout: this.filterBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: tmpThickView },
        { binding: 2, resource: { buffer: this.filterYBuf } },
      ],
    })

    const encoder = d.createCommandEncoder()

    // ── Pass 1: Depth sprites + composition ID ────────────────────
    const p1 = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: depthView, clearValue: { r: 1e6, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store',
        },
        {
          view: compIdView, clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear', storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTestView, depthClearValue: 1.0,
        depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    })
    p1.setPipeline(this.depthPipeline)
    p1.setBindGroup(0, depthBG)
    p1.draw(6, numParticles)
    p1.end()

    // ── Pass 2: Bilateral blur × 2 — smooth surface, preserve curvature ──
    for (let i = 0; i < 2; i++) {
      // H blur: depth → tmpDepth
      const bh = encoder.beginRenderPass({
        colorAttachments: [{ view: tmpDepthView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1e6, g: 0, b: 0, a: 1 } }],
      })
      bh.setPipeline(this.bilateralPipeline)
      bh.setBindGroup(0, filterBG_depthX)
      bh.draw(6)
      bh.end()

      // V blur: tmpDepth → depth
      const bv = encoder.beginRenderPass({
        colorAttachments: [{ view: depthView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1e6, g: 0, b: 0, a: 1 } }],
      })
      bv.setPipeline(this.bilateralPipeline)
      bv.setBindGroup(0, filterBG_depthY)
      bv.draw(6)
      bv.end()
    }

    // ── Pass 3: Thickness (additive) ──────────────────────────────
    const p3 = encoder.beginRenderPass({
      colorAttachments: [{ view: thickView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    })
    p3.setPipeline(this.thicknessPipeline)
    p3.setBindGroup(0, depthBG)
    p3.draw(6, numParticles)
    p3.end()

    // ── Pass 4: Gaussian blur × 1 — smooth thickness for color gradient
    for (let i = 0; i < 1; i++) {
      const gh = encoder.beginRenderPass({
        colorAttachments: [{ view: tmpThickView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      })
      gh.setPipeline(this.gaussianPipeline)
      gh.setBindGroup(0, filterBG_thickX)
      gh.draw(6)
      gh.end()

      const gv = encoder.beginRenderPass({
        colorAttachments: [{ view: thickView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      })
      gv.setPipeline(this.gaussianPipeline)
      gv.setBindGroup(0, filterBG_thickY)
      gv.draw(6)
      gv.end()
    }

    // ── Pass 5: Composite ──────────────────────────────────────────
    // Update composite uniforms
    // CompositeUniforms: texel(8) + pad(8) + invProj(64) + lightDir(12) + pad(4) + color(12) + density(4) + F0(4) + emissive(4) + specPow(4) + metalness(4) + time(4) + pad(12) = 144 bytes
    const compData = new Float32Array(36)
    compData[0] = 1 / this.width; compData[1] = 1 / this.height // texel_size
    compData[2] = 0; compData[3] = 0 // _pad

    // Use cached inverse projection from last updateCamera call
    compData.set(this.invProj, 4) // offset 4 = byte 16

    compData[20] = 3.0; compData[21] = 5.0; compData[22] = 3.0 // light_dir (matches Three.js directional)
    compData[23] = 0 // _pad2
    compData[24] = this.fluidColor[0]; compData[25] = this.fluidColor[1]; compData[26] = this.fluidColor[2]
    compData[27] = this.fluidDensity
    compData[28] = this.fluidF0
    compData[29] = this.fluidEmissive
    compData[30] = this.fluidSpecPower
    compData[31] = this.fluidMetalness
    compData[32] = time
    compData[33] = this.fluidIOR
    // 34-35: padding
    d.queue.writeBuffer(this.compositeUniformBuf, 0, compData)

    const sceneView = this.sceneTexture.createView()

    const compositeBG = d.createBindGroup({
      layout: this.compositeBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: depthView },
        { binding: 2, resource: thickView },
        { binding: 3, resource: sceneView },
        { binding: 4, resource: { buffer: this.compositeUniformBuf } },
        { binding: 5, resource: compIdView },
        { binding: 6, resource: { buffer: this.compRenderPropsBuf } },
      ],
    })

    if (this.context) {
      const outputView = this.context.getCurrentTexture().createView()

      // Pass 5: Composite — Fresnel + Beer's law + refraction + specular
      const p5 = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      })
      p5.setPipeline(this.compositePipeline)
      p5.setBindGroup(0, compositeBG)
      p5.draw(6)
      p5.end()
    }

    d.queue.submit([encoder.finish()])
  }

  get isInitialized() { return this.initialized }
  get gpuDevice() { return this.device }

  dispose() {
    this.depthMapTex?.destroy()
    this.tmpDepthMapTex?.destroy()
    this.thicknessTex?.destroy()
    this.tmpThicknessTex?.destroy()
    this.depthTestTex?.destroy()
    this.sceneTexture?.destroy()
    this.compIdTexture?.destroy()
    this.particleBuffer?.destroy()
    this.uniformBuffer?.destroy()
    this.filterXBuf?.destroy()
    this.filterYBuf?.destroy()
    this.compositeUniformBuf?.destroy()
    this.compRenderPropsBuf?.destroy()
  }
}
