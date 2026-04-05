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

  // Pipelines
  private depthPipeline!: GPURenderPipeline
  private bilateralPipeline!: GPURenderPipeline
  private thicknessPipeline!: GPURenderPipeline
  private gaussianPipeline!: GPURenderPipeline
  compositePipeline!: GPURenderPipeline
  private debugPipeline!: GPURenderPipeline
  private debugBGL!: GPUBindGroupLayout

  // Buffers
  private particleBuffer!: GPUBuffer
  private uniformBuffer!: GPUBuffer
  private filterXBuf!: GPUBuffer
  private filterYBuf!: GPUBuffer
  private compositeUniformBuf!: GPUBuffer

  // Bind group layouts
  private depthBGL!: GPUBindGroupLayout
  private filterBGL!: GPUBindGroupLayout
  private compositeBGL!: GPUBindGroupLayout

  private sampler!: GPUSampler
  private envCubemap!: GPUTexture
  private maxParticles = 10000

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

    // Cubemap for environment reflections (6 faces, each 4×4)
    this.envCubemap = d.createTexture({
      size: [4, 4, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '2d',
      viewFormats: ['rgba8unorm'],
    })
    const faceColors = [
      [15, 25, 50], // +X dark blue
      [10, 20, 45], // -X
      [20, 35, 60], // +Y slightly lighter (sky)
      [5, 10, 25],  // -Y dark (ground)
      [12, 22, 48], // +Z
      [12, 22, 48], // -Z
    ]
    for (let face = 0; face < 6; face++) {
      const faceData = new Uint8Array(4 * 4 * 4)
      for (let i = 0; i < 16; i++) {
        faceData[i*4] = faceColors[face][0]
        faceData[i*4+1] = faceColors[face][1]
        faceData[i*4+2] = faceColors[face][2]
        faceData[i*4+3] = 255
      }
      d.queue.writeTexture(
        { texture: this.envCubemap, origin: [0, 0, face] },
        faceData, { bytesPerRow: 16 }, { width: 4, height: 4 },
      )
    }
  }

  private createBuffers() {
    const d = this.device
    this.particleBuffer = d.createBuffer({ size: this.maxParticles * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) // 8 floats × 4 bytes
    this.uniformBuffer = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.filterXBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.filterYBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.compositeUniformBuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

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

    this.depthPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }),
      vertex: { module: depthMod, entryPoint: 'vs' },
      fragment: { module: depthMod, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
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
        constants: { depth_threshold: 10.0, projected_particle_constant: 200.0, max_filter_size: 30.0 },
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Thickness pipeline (same vertex as depth, additive blend) ─
    this.thicknessPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }),
      vertex: { module: depthMod, entryPoint: 'vs' },
      fragment: {
        module: thicknessMod, entryPoint: 'fs',
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
      ],
    })

    this.compositePipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
      vertex: { module: fullScreenMod, entryPoint: 'vs', constants: { screenWidth: w, screenHeight: h } },
      fragment: { module: compositeMod, entryPoint: 'fs', targets: [{ format: this.presentationFormat }] },
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
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  updateParticles(positions: Float32Array, velocities: Float32Array, matIds: Uint8Array, count: number) {
    if (!this.initialized) return
    const data = new Float32Array(count * 8) // 8 floats per particle (padded to 32 bytes)
    for (let i = 0; i < count; i++) {
      const i3 = i * 3, i8 = i * 8
      data[i8] = positions[i3]; data[i8+1] = positions[i3+1]; data[i8+2] = positions[i3+2]
      data[i8+3] = velocities[i3]; data[i8+4] = velocities[i3+1]; data[i8+5] = velocities[i3+2]
      data[i8+6] = matIds[i]
      data[i8+7] = 0 // padding
    }
    this.device.queue.writeBuffer(this.particleBuffer, 0, data, 0, count * 8)
  }

  updateCamera(viewMatrix: Float32Array, projMatrix: Float32Array, sphereSize: number) {
    if (!this.initialized) return
    const buf = new Float32Array(36)
    buf[0] = 1 / this.width; buf[1] = 1 / this.height; buf[2] = sphereSize; buf[3] = 0
    buf.set(projMatrix, 4)
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

  render(numParticles: number) {
    if (!this.initialized || numParticles === 0) return

    const d = this.device
    const depthView = this.depthMapTex.createView()
    const tmpDepthView = this.tmpDepthMapTex.createView()
    const thickView = this.thicknessTex.createView()
    const tmpThickView = this.tmpThicknessTex.createView()
    const depthTestView = this.depthTestTex.createView()

    // Create bind groups fresh each frame (views may change)
    const depthBG = d.createBindGroup({
      layout: this.depthBGL,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
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

    // ── Pass 1: Depth sprites ─────────────────────────────────────
    const p1 = encoder.beginRenderPass({
      colorAttachments: [{
        view: depthView, clearValue: { r: 1e6, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthTestView, depthClearValue: 1.0,
        depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    })
    p1.setPipeline(this.depthPipeline)
    p1.setBindGroup(0, depthBG)
    p1.draw(6, numParticles)
    p1.end()

    // ── Pass 2: Bilateral blur × 4 ───────────────────────────────
    for (let i = 0; i < 4; i++) {
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

    // ── Pass 4: Gaussian blur × 1 ────────────────────────────────
    const g1 = encoder.beginRenderPass({
      colorAttachments: [{ view: tmpThickView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    g1.setPipeline(this.gaussianPipeline)
    g1.setBindGroup(0, filterBG_thickX)
    g1.draw(6)
    g1.end()

    const g2 = encoder.beginRenderPass({
      colorAttachments: [{ view: thickView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    g2.setPipeline(this.gaussianPipeline)
    g2.setBindGroup(0, filterBG_thickY)
    g2.draw(6)
    g2.end()

    // ── Pass 5: Composite ──────────────────────────────────────────
    // Update composite uniforms
    const compData = new Float32Array(32)
    compData[0] = 1 / this.width; compData[1] = 1 / this.height // texel_size
    // inv_projection_matrix: identity for now (TODO: pass from camera)
    compData[4] = 1; compData[9] = 1; compData[14] = 1; compData[19] = 1
    compData[20] = 0.5; compData[21] = 1.0; compData[22] = 0.3 // light_dir
    compData[24] = 0.13; compData[25] = 0.4; compData[26] = 0.87 // fluid_color (water blue)
    compData[27] = 3.0 // density
    d.queue.writeBuffer(this.compositeUniformBuf, 0, compData)

    const sceneView = this.sceneTexture.createView()

    void d.createBindGroup({ // compositeBG — unused while debug mode active
      layout: this.compositeBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: depthView },
        { binding: 2, resource: thickView },
        { binding: 3, resource: sceneView },
        { binding: 4, resource: { buffer: this.compositeUniformBuf } },
      ],
    })

    if (this.context) {
      const outputView = this.context.getCurrentTexture().createView()

      // DEBUG: show depth map directly instead of composite
      // This verifies depth sprites + bilateral blur are working
      const debugBG = d.createBindGroup({
        layout: this.debugBGL,
        entries: [{ binding: 0, resource: depthView }],
      })
      const p5 = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0.96, g: 0.87, b: 0.7, a: 1 }, // sandy yellow background for debug visibility
        }],
      })
      p5.setPipeline(this.debugPipeline)
      p5.setBindGroup(0, debugBG)
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
    this.particleBuffer?.destroy()
    this.uniformBuffer?.destroy()
    this.filterXBuf?.destroy()
    this.filterYBuf?.destroy()
    this.compositeUniformBuf?.destroy()
  }
}
