// SSFRPipeline.ts — Screen Space Fluid Rendering (5-pass pipeline)
// Uses raw WebGPU for all render passes — bypasses Three.js TSL entirely
//
// Pipeline:
//   Pass 1: Depth     — particle spheres → depth texture
//   Pass 2: Thickness — particle spheres → additive thickness texture
//   Pass 3a: Blur H   — bilateral blur horizontal
//   Pass 3b: Blur V   — bilateral blur vertical
//   Pass 4: Composite — normals from depth + Fresnel + Beer-Lambert + refraction
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"

import bgShaderSrc from './shaders/ssfr_bg.wgsl?raw'
import { BG_BASE, clampBrightness } from './bgBrightness'
import depthShaderSrc from './shaders/ssfr_depth.wgsl?raw'
import thicknessShaderSrc from './shaders/ssfr_thickness.wgsl?raw'
import blurShaderSrc from './shaders/ssfr_blur.wgsl?raw'
import compositeShaderSrc from './shaders/ssfr_composite.wgsl?raw'

export interface SSFRConfig {
  particleRadius: number   // eye-space radius for sphere splatting
  blurRadius: number       // bilateral blur kernel radius (pixels)
  blurDepthFalloff: number // depth sensitivity for edge preservation
  refractionStrength: number
  absorptionScale: number
}

const DEFAULT_CONFIG: SSFRConfig = {
  particleRadius: 0.025,
  blurRadius: 12,
  blurDepthFalloff: 50.0,
  refractionStrength: 0.03,
  absorptionScale: 2.0,
}

export class SSFRPipeline {
  private device!: GPUDevice
  private config: SSFRConfig
  private width = 0
  private height = 0
  // Owner-adjustable background brightness (1 = base olive). Live-updatable: the
  // bg uniforms + both clearValues are rebuilt every frame in render().
  private bgBrightness = 1

  setBgBrightness(b: number) { this.bgBrightness = clampBrightness(b) }

  // Textures
  private bgTex!: GPUTexture         // background scene (for composite to sample)
  private bgView!: GPUTextureView
  // Per-pixel eye-space depth of the background geometry. Composite reads
  // this to decide — per pixel — whether the bg is in FRONT of the fluid
  // surface (then bg wins) or behind it (then fluid composites over bg).
  // Without this we had the two-layer problem: ball/box always rendered
  // "behind" fluid even when physically in front.
  private bgDepthTex!: GPUTexture
  private bgDepthView!: GPUTextureView
  private depthTex!: GPUTexture
  private depthView!: GPUTextureView
  private blurTempTex!: GPUTexture
  private blurTempView!: GPUTextureView
  private thicknessTex!: GPUTexture
  private thicknessView!: GPUTextureView
  private hwDepthTex!: GPUTexture
  private hwDepthView!: GPUTextureView

  // Pipelines
  private bgPipeline!: GPURenderPipeline
  private depthPipeline!: GPURenderPipeline
  private thicknessPipeline!: GPURenderPipeline
  private blurPipeline!: GPURenderPipeline
  private compositePipeline!: GPURenderPipeline

  // Uniform buffers
  private bgUBO!: GPUBuffer          // bg pass uniforms
  private cameraUBO!: GPUBuffer      // depth/thickness pass camera uniforms
  private blurUBO!: GPUBuffer        // blur pass params
  private compositeUBO!: GPUBuffer   // composite pass params

  // Bind group layouts
  private bgBGL!: GPUBindGroupLayout
  private depthBGL!: GPUBindGroupLayout
  private blurBGL!: GPUBindGroupLayout
  private compositeBGL!: GPUBindGroupLayout

  // Sampler
  private linearSampler!: GPUSampler

  // Index buffer for quads
  private quadIndexBuf!: GPUBuffer

  // Dummy comp-id texture + material buffer for composite pass.
  // Placeholders until the depth pass writes composition_id per pixel.
  // Created once in init(); reused every frame. (Previously these were
  // created+destroyed per frame, causing "Buffer used in submit while
  // destroyed" warnings and black output because submit() ran after destroy.)
  private compIdTex!: GPUTexture
  private compIdView!: GPUTextureView
  private matBuf!: GPUBuffer

  constructor(config?: Partial<SSFRConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async init(device: GPUDevice, width: number, height: number): Promise<void> {
    this.device = device
    this.width = width
    this.height = height

    this.linearSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    this.createTextures(width, height)
    this.createUniformBuffers()
    await this.createPipelines()
    this.createQuadIndexBuffer()
  }

  private createTextures(w: number, h: number) {
    // Background texture — scene behind fluid (box, grid, etc.)
    // MUST have TEXTURE_BINDING so composite can sample it for refraction.
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat()
    this.bgTex = this.device.createTexture({
      size: [w, h], format: canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.bgView = this.bgTex.createView()

    // BG depth (eye-space z, positive = in front of camera).
    // Written by ssfr_bg.wgsl as a second color attachment (r32float).
    this.bgDepthTex = this.device.createTexture({
      size: [w, h], format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.bgDepthView = this.bgDepthTex.createView()

    // Depth texture (R32Float — linear eye-space depth)
    this.depthTex = this.device.createTexture({
      size: [w, h], format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.depthView = this.depthTex.createView()

    // Blur temp texture (same format)
    this.blurTempTex = this.device.createTexture({
      size: [w, h], format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.blurTempView = this.blurTempTex.createView()

    // Thickness texture (R16Float with additive blending)
    this.thicknessTex = this.device.createTexture({
      size: [w, h], format: 'r16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.thicknessView = this.thicknessTex.createView()

    // Hardware depth texture for z-test in depth pass
    this.hwDepthTex = this.device.createTexture({
      size: [w, h], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.hwDepthView = this.hwDepthTex.createView()

    // Dummy comp-id texture (placeholder for per-pixel composition_id).
    // Created once here, reused every frame by the composite pass.
    // Real per-pixel composition_id texture, written by the depth pass's
    // second fragment target. Screen-sized — MUST be recreated on resize()
    // like the other per-size textures (unlike the old 1×1 dummy).
    this.compIdTex = this.device.createTexture({
      size: [w, h], format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.compIdView = this.compIdTex.createView()

    // Real per-composition material buffer, uploaded via updateMaterialProps().
    // Composition-count-sized (256*8 floats), NOT screen-sized — created once;
    // resize() must not recreate it or it would drop the uploaded data.
    if (!this.matBuf) {
      this.matBuf = this.device.createBuffer({
        size: 256 * 8 * 4,  // = CompositionTable.getRenderData() (2048 floats)
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    }
  }

  private createUniformBuffers() {
    // Camera UBO: 2 mat4x4 (128 bytes) + mat4x4 (64) + screenSize(8) + radius(4) + count(4) + near(4) + far(4) + pad(8) = 224 bytes
    this.cameraUBO = this.device.createBuffer({
      size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Blur UBO: texSize(8) + filterRadius(4) + scale(4) + falloff(4) + direction(8) + pad(4) = 32 bytes
    this.blurUBO = this.device.createBuffer({
      size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // BG UBO: matrices(256) + screenSize(8) + radius(4) + pad(4)
    //       + ballData(16: center.xyz + radius)
    //       + ballMeta(16: active + 3 pads) = 304 bytes
    this.bgUBO = this.device.createBuffer({
      size: 304, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Composite UBO: invProj(64) + proj(64) + screenSize(8) + near(4) + far(4) + refracStr(4) + absScale(4) + fresnelPow(4) + ambStr(4) + lightDir(12) + pad(4) = 176 bytes
    this.compositeUBO = this.device.createBuffer({
      size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  private async createPipelines(): Promise<void> {
    const device = this.device

    // ── Background pipeline ──────────────────────────────────────────
    // Renders the scene behind the fluid (grid floor + wireframe box).
    // Output goes to bgTex which the composite samples for refraction.
    const bgModule = device.createShaderModule({ code: bgShaderSrc })
    bgModule.getCompilationInfo().then(info => {
      for (const msg of info.messages) console.warn(`[BG WGSL ${msg.type}] L${msg.lineNum}: ${msg.message}`)
    })
    this.bgBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat()
    this.bgPipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bgBGL] }),
      vertex: { module: bgModule, entryPoint: 'vs_main' },
      fragment: {
        module: bgModule, entryPoint: 'fs_main',
        // Two color targets: color (canvasFormat) and eye-space depth (r32float).
        // Composite uses depth to decide if bg is in front of fluid or behind.
        targets: [{ format: canvasFormat }, { format: 'r32float' }],
      },
      primitive: { topology: 'triangle-list' },
    }).catch((e: any) => { console.error('[BG PIPELINE]', e); throw e })

    // ── Depth pipeline ────────────────────────────────────────────────
    const depthModule = device.createShaderModule({ code: depthShaderSrc })
    depthModule.getCompilationInfo().then(info => {
      for (const msg of info.messages) console.warn(`[DEPTH WGSL ${msg.type}] L${msg.lineNum}: ${msg.message}`)
    })
    this.depthBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })

    this.depthPipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }),
      vertex: { module: depthModule, entryPoint: 'vs_main' },
      fragment: {
        module: depthModule, entryPoint: 'fs_main',
        targets: [
          { format: 'r32float' as GPUTextureFormat },  // eyeDepth (unchanged)
          { format: 'r32uint' as GPUTextureFormat },   // NEW — compId
        ],
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Thickness pipeline (additive blending) ────────────────────────
    const thicknessModule = device.createShaderModule({ code: thicknessShaderSrc })

    this.thicknessPipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }), // same layout
      vertex: { module: thicknessModule, entryPoint: 'vs_main' },
      fragment: {
        module: thicknessModule, entryPoint: 'fs_main',
        targets: [{
          format: 'r16float' as GPUTextureFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false, // don't write depth, just use it for testing
        depthCompare: 'always',   // always draw (we want additive accumulation)
      },
    })

    // ── Blur pipeline ─────────────────────────────────────────────────
    const blurModule = device.createShaderModule({ code: blurShaderSrc })
    this.blurBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })

    this.blurPipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blurBGL] }),
      vertex: { module: blurModule, entryPoint: 'vs_main' },
      fragment: {
        module: blurModule, entryPoint: 'fs_main',
        targets: [{ format: 'r32float' as GPUTextureFormat }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Composite pipeline ────────────────────────────────────────────
    const compositeModule = device.createShaderModule({ code: compositeShaderSrc })
    compositeModule.getCompilationInfo().then(info => {
      for (const msg of info.messages) console.warn(`[COMPOSITE WGSL ${msg.type}] L${msg.lineNum}: ${msg.message}`)
    })
    this.compositeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },          // depth (fluid)
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },          // thickness
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },          // scene color
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },           // compId
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },     // materials
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // bg eye-space depth
      ],
    })

    this.compositePipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: {
        module: compositeModule, entryPoint: 'fs_main',
        targets: [{
          format: navigator.gpu.getPreferredCanvasFormat(),
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  private createQuadIndexBuffer() {
    // Triangle strip indices for a quad: 0,1,2,3 (with primitive restart)
    // Actually, we use vertex_index / 4 = particle, vertex_index % 4 = corner
    // with triangle-strip topology and stripIndexFormat
    // Indices: [0,1,2,3] per quad → 6 indices per particle.
    // Uint32 required: at 1M particles, max index = 4M which overflows Uint16.
    const MAX_PARTICLES = 1_000_000
    const indices32 = new Uint32Array(MAX_PARTICLES * 6)
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const base = i * 4
      const idx = i * 6
      indices32[idx + 0] = base + 0
      indices32[idx + 1] = base + 1
      indices32[idx + 2] = base + 2
      indices32[idx + 3] = base + 2
      indices32[idx + 4] = base + 1
      indices32[idx + 5] = base + 3
    }

    this.quadIndexBuf = this.device.createBuffer({
      size: indices32.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.quadIndexBuf, 0, indices32)
  }

  /** Resize textures when window size changes */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height

    // Destroy old textures
    this.depthTex.destroy()
    this.blurTempTex.destroy()
    this.thicknessTex.destroy()
    this.hwDepthTex.destroy()
    this.compIdTex.destroy()   // screen-sized now; recreated by createTextures() below

    this.createTextures(width, height)
  }

  /** Upload per-composition rendering properties to GPU. Sibling of
   *  MpmGpuSimulator.updateCompositionProps() — same call sites, same upload
   *  pattern. Feed CompositionTable.getRenderData(). */
  updateMaterialProps(data: Float32Array) {
    this.device.queue.writeBuffer(this.matBuf, 0, data.buffer, data.byteOffset, data.byteLength)
  }

  /**
   * Render the full SSFR pipeline including background.
   * No external scene texture needed — background is rendered internally.
   */
  render(
    encoder: GPUCommandEncoder,
    particleBuffer: GPUBuffer,
    particleCount: number,
    viewMatrix: Float32Array,
    projMatrix: Float32Array,
    invProjMatrix: Float32Array,
    invViewMatrix: Float32Array,
    outputView: GPUTextureView,
    ball?: { center: [number, number, number]; radius: number; active: boolean },
  ) {
    if (particleCount === 0) return

    const w = this.width
    const h = this.height

    // ── Update camera UBO ────────────────────────────────────────────
    const camData = new Float32Array(56) // 224 bytes / 4
    camData.set(viewMatrix, 0)          // offset 0: viewMatrix (16 floats)
    camData.set(projMatrix, 16)         // offset 16: projMatrix (16 floats)
    camData.set(invProjMatrix, 32)      // offset 32: invProjMatrix (16 floats)
    camData[48] = w                     // screenSize.x
    camData[49] = h                     // screenSize.y
    camData[50] = this.config.particleRadius // particleRadius
    new Uint32Array(camData.buffer, 204, 1)[0] = particleCount // numParticles
    camData[52] = 0.1                   // nearPlane
    camData[53] = 50                    // farPlane
    this.device.queue.writeBuffer(this.cameraUBO, 0, camData)

    // ── Pass 0: Background ──────────────────────────────────────────
    // Render the scene behind the fluid to bgTex (grid floor + wireframe box).
    {
      const bgData = new Float32Array(76) // 304 bytes / 4
      bgData.set(invProjMatrix, 0)    // offset 0: invProj (16 floats)
      bgData.set(projMatrix, 16)      // offset 16: proj (16 floats)
      bgData.set(viewMatrix, 32)      // offset 32: view (16 floats)
      bgData.set(invViewMatrix, 48)   // offset 48: invView (16 floats)
      bgData[64] = w                  // screenSize.x
      bgData[65] = h                  // screenSize.y
      bgData[66] = this.config.particleRadius
      bgData[67] = this.bgBrightness  // background brightness (was the reserved pad)
      // Ball data: center.xyz + radius packed as vec4
      if (ball && ball.active) {
        bgData[68] = ball.center[0]
        bgData[69] = ball.center[1]
        bgData[70] = ball.center[2]
        bgData[71] = ball.radius
        bgData[72] = 1.0  // active flag
      } else {
        bgData[72] = 0.0  // inactive
      }
      this.device.queue.writeBuffer(this.bgUBO, 0, bgData)

      const bgBindGroup = this.device.createBindGroup({
        layout: this.bgBGL,
        entries: [
          { binding: 0, resource: { buffer: this.bgUBO } },
        ],
      })

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.bgView,
            loadOp: 'clear', storeOp: 'store',
            // Olive × brightness — matches the fullscreen bg draw that overwrites it,
            // so a skipped/partial draw can never flash a different color.
            clearValue: { r: BG_BASE.r * this.bgBrightness, g: BG_BASE.g * this.bgBrightness, b: BG_BASE.b * this.bgBrightness, a: 1 },
          },
          {
            // Clear to a far-away depth (well beyond any fluid particle).
            // The shader will overwrite this for any pixel where a surface
            // is hit; leftover pixels keep the far value so "no bg hit"
            // never wins the depth comparison against fluid.
            view: this.bgDepthView,
            loadOp: 'clear', storeOp: 'store',
            clearValue: { r: 1e6, g: 0, b: 0, a: 0 },
          },
        ],
      })
      pass.setPipeline(this.bgPipeline)
      pass.setBindGroup(0, bgBindGroup)
      pass.draw(3) // fullscreen triangle
      pass.end()
    }

    // ── Depth bind group ─────────────────────────────────────────────
    const depthBG = this.device.createBindGroup({
      layout: this.depthBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUBO } },
        { binding: 1, resource: { buffer: particleBuffer } },
      ],
    })

    // ── Pass 1: Depth ────────────────────────────────────────────────
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.depthView,
            loadOp: 'clear', storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
          {
            view: this.compIdView,   // compId 0 = first addDefaults() composition; harmless:
            loadOp: 'clear', storeOp: 'store',   // hasFluid gate in composite discards
            clearValue: { r: 0, g: 0, b: 0, a: 0 },  // pixels where depth cleared to 0 (no particle)
          },
        ],
        depthStencilAttachment: {
          view: this.hwDepthView,
          depthLoadOp: 'clear', depthStoreOp: 'store',
          depthClearValue: 1.0,
        },
      })
      pass.setPipeline(this.depthPipeline)
      pass.setBindGroup(0, depthBG)
      pass.setIndexBuffer(this.quadIndexBuf, 'uint32')
      pass.drawIndexed(particleCount * 6)
      pass.end()
    }

    // ── Pass 2: Thickness ────────────────────────────────────────────
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.thicknessView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
        depthStencilAttachment: {
          view: this.hwDepthView,
          depthLoadOp: 'load', depthStoreOp: 'store',
          depthClearValue: 1.0,
        },
      })
      pass.setPipeline(this.thicknessPipeline)
      pass.setBindGroup(0, depthBG)
      pass.setIndexBuffer(this.quadIndexBuf, 'uint32')
      pass.drawIndexed(particleCount * 6)
      pass.end()
    }

    // ── Pass 3a: Blur Horizontal ─────────────────────────────────────
    {
      const blurData = new Float32Array(12)
      blurData[0] = w; blurData[1] = h
      blurData[2] = this.config.blurRadius
      blurData[3] = 1.0
      blurData[4] = this.config.blurDepthFalloff
      blurData[5] = 1.0; blurData[6] = 0.0 // direction = horizontal
      this.device.queue.writeBuffer(this.blurUBO, 0, blurData)

      const blurHBG = this.device.createBindGroup({
        layout: this.blurBGL,
        entries: [
          { binding: 0, resource: { buffer: this.blurUBO } },
          { binding: 1, resource: this.depthView },
          { binding: 2, resource: this.linearSampler },
        ],
      })

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.blurTempView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      })
      pass.setPipeline(this.blurPipeline)
      pass.setBindGroup(0, blurHBG)
      pass.draw(3) // full-screen triangle
      pass.end()
    }

    // ── Pass 3b: Blur Vertical ───────────────────────────────────────
    {
      const blurData = new Float32Array(12)
      blurData[0] = w; blurData[1] = h
      blurData[2] = this.config.blurRadius
      blurData[3] = 1.0
      blurData[4] = this.config.blurDepthFalloff
      blurData[5] = 0.0; blurData[6] = 1.0 // direction = vertical
      this.device.queue.writeBuffer(this.blurUBO, 0, blurData)

      const blurVBG = this.device.createBindGroup({
        layout: this.blurBGL,
        entries: [
          { binding: 0, resource: { buffer: this.blurUBO } },
          { binding: 1, resource: this.blurTempView },
          { binding: 2, resource: this.linearSampler },
        ],
      })

      // Write back to depthTex (overwrite raw depth with smoothed)
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.depthView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      })
      pass.setPipeline(this.blurPipeline)
      pass.setBindGroup(0, blurVBG)
      pass.draw(3)
      pass.end()
    }

    // ── Pass 4: Composite ────────────────────────────────────────────
    {
      // Update composite UBO
      const compData = new Float32Array(48) // 192 bytes / 4
      compData.set(invProjMatrix, 0)   // offset 0: invProj (16)
      compData.set(projMatrix, 16)     // offset 16: proj (16)
      compData[32] = w; compData[33] = h  // screenSize
      compData[34] = 0.1; compData[35] = 50 // near, far
      compData[36] = this.config.refractionStrength
      compData[37] = this.config.absorptionScale
      compData[38] = 5.0  // fresnelPower
      compData[39] = 0.3  // ambientStrength
      compData[40] = 3.0; compData[41] = 5.0; compData[42] = 3.0 // lightDir
      this.device.queue.writeBuffer(this.compositeUBO, 0, compData)

      // Use internally rendered background (not external sceneTexture)
      const sceneView = this.bgView

      // Dummy comp-id + materials are now cached on `this` (created in
      // createTextures). Previously they were created and destroyed every
      // frame — submit() then referenced destroyed resources.
      const compositeBG = this.device.createBindGroup({
        layout: this.compositeBGL,
        entries: [
          { binding: 0, resource: { buffer: this.compositeUBO } },
          { binding: 1, resource: this.depthView },       // smoothed fluid depth
          { binding: 2, resource: this.thicknessView },    // thickness
          { binding: 3, resource: sceneView },             // scene color
          { binding: 4, resource: this.compIdView },          // comp ID (real per-pixel)
          { binding: 5, resource: { buffer: this.matBuf } },  // materials (real, via updateMaterialProps)
          { binding: 6, resource: this.linearSampler },
          { binding: 7, resource: this.bgDepthView },      // bg eye-space depth
        ],
      })

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear',  // start fresh — composite reads scene from texture
          storeOp: 'store',
          // olive 0xb1b366 × the owner's brightness — matches scene.background
          clearValue: { r: BG_BASE.r * this.bgBrightness, g: BG_BASE.g * this.bgBrightness, b: BG_BASE.b * this.bgBrightness, a: 1 },
        }],
      })
      pass.setPipeline(this.compositePipeline)
      pass.setBindGroup(0, compositeBG)
      pass.draw(3) // full-screen triangle
      pass.end()
      // NOTE: dummy resources are cached on `this` and NOT destroyed here.
      // They're disposed in destroy() alongside the other pipeline resources.
    }
  }

  destroy() {
    this.bgTex?.destroy()
    this.bgDepthTex?.destroy()
    this.depthTex?.destroy()
    this.blurTempTex?.destroy()
    this.thicknessTex?.destroy()
    this.hwDepthTex?.destroy()
    this.bgUBO?.destroy()
    this.cameraUBO?.destroy()
    this.blurUBO?.destroy()
    this.compositeUBO?.destroy()
    this.quadIndexBuf?.destroy()
    this.compIdTex?.destroy()
    this.matBuf?.destroy()
  }
}
