// ══════════════════════════════════════════════════════════════════════════════
// Raw WebGPU Fluid Renderer — §3.2 SSFR Pipeline
//
// Uses raw WebGPU API for proper multi-pass fluid rendering.
// Three.js handles the scene (box, lights, camera).
// This module handles ONLY the fluid particle rendering with:
//   Pass 1: Depth sprites (sphere-shaped depth per particle)
//   Pass 2: Bilateral blur on depth (4 iterations, H+V)
//   Pass 3: Thickness map (additive blending)
//   Pass 4: Gaussian blur on thickness (1 iteration, H+V)
//   Pass 5: Composite (Fresnel + Beer's law + specular)
//
// Adapted from WaterBall (MIT license) + structure.md §3.2
// ══════════════════════════════════════════════════════════════════════════════

import depthMapWGSL from './depthMap.wgsl?raw'
import bilateralWGSL from './bilateral.wgsl?raw'
import thicknessMapWGSL from './thicknessMap.wgsl?raw'
import gaussianWGSL from './gaussian.wgsl?raw'
import compositeWGSL from './composite.wgsl?raw'
import fullScreenWGSL from './fullScreen.wgsl?raw'

export class FluidRenderer {
  private device: GPUDevice | null = null
  private initialized = false
  private width = 0
  private height = 0

  // Render targets
  private depthMapTexture!: GPUTexture
  private depthMapView!: GPUTextureView
  private tmpDepthMapTexture!: GPUTexture
  private tmpDepthMapView!: GPUTextureView
  private thicknessTexture!: GPUTexture
  private thicknessView!: GPUTextureView
  private tmpThicknessTexture!: GPUTexture
  private tmpThicknessView!: GPUTextureView
  private depthTestTexture!: GPUTexture
  private depthTestView!: GPUTextureView

  // Pipelines
  private depthPipeline!: GPURenderPipeline
  private bilateralPipeline!: GPURenderPipeline
  private thicknessPipeline!: GPURenderPipeline
  private gaussianPipeline!: GPURenderPipeline
  private compositePipeline!: GPURenderPipeline

  // Buffers
  private particleBuffer!: GPUBuffer
  private uniformBuffer!: GPUBuffer
  private filterXBuffer!: GPUBuffer
  private filterYBuffer!: GPUBuffer
  private compositeUniformBuffer!: GPUBuffer

  // Bind groups
  private depthBindGroup!: GPUBindGroup
  private bilateralBindGroupX!: GPUBindGroup
  private bilateralBindGroupY!: GPUBindGroup
  private thicknessBindGroup!: GPUBindGroup
  private gaussianBindGroupX!: GPUBindGroup
  private gaussianBindGroupY!: GPUBindGroup
  private compositeBindGroup!: GPUBindGroup

  private sampler!: GPUSampler

  async init(canvas: HTMLCanvasElement): Promise<boolean> {
    if (!navigator.gpu) {
      console.warn('WebGPU not supported')
      return false
    }

    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) {
      console.warn('No GPU adapter found')
      return false
    }

    this.device = await adapter.requestDevice()
    this.width = canvas.width
    this.height = canvas.height

    // Create render targets
    this.createRenderTargets()

    // Create sampler
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })

    // Create uniform buffers
    this.createBuffers()

    // Create pipelines
    await this.createPipelines(canvas)

    this.initialized = true
    console.log('FluidRenderer: WebGPU SSFR pipeline initialized')
    return true
  }

  private createRenderTargets() {
    const d = this.device!
    const w = this.width, h = this.height

    // Depth map (r32float) — stores linear view-space depth
    this.depthMapTexture = d.createTexture({
      size: [w, h], format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.depthMapView = this.depthMapTexture.createView()

    this.tmpDepthMapTexture = d.createTexture({
      size: [w, h], format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.tmpDepthMapView = this.tmpDepthMapTexture.createView()

    // Thickness map (r16float) — stores accumulated thickness
    this.thicknessTexture = d.createTexture({
      size: [w, h], format: 'r16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.thicknessView = this.thicknessTexture.createView()

    this.tmpThicknessTexture = d.createTexture({
      size: [w, h], format: 'r16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.tmpThicknessView = this.tmpThicknessTexture.createView()

    // Depth test (depth32float) — for depth comparison in depth map pass
    this.depthTestTexture = d.createTexture({
      size: [w, h], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.depthTestView = this.depthTestTexture.createView()
  }

  private createBuffers() {
    const d = this.device!

    // Particle buffer — will be updated each frame with positions from WASM
    this.particleBuffer = d.createBuffer({
      size: 10000 * 7 * 4, // 10k particles × 7 floats (x,y,z,vx,vy,vz,mat_id)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    // Render uniforms (matrices, sphere size, texel size)
    this.uniformBuffer = d.createBuffer({
      size: 256, // 2 mat4x4 + misc
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Filter direction buffers
    this.filterXBuffer = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.filterYBuffer = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.filterXBuffer, 0, new Float32Array([1, 0, 0, 0]))
    d.queue.writeBuffer(this.filterYBuffer, 0, new Float32Array([0, 1, 0, 0]))

    // Composite uniforms
    this.compositeUniformBuffer = d.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  private async createPipelines(_canvas: HTMLCanvasElement) {
    const d = this.device!
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat()

    // ── Depth map pipeline ────────────────────────────────────────
    const depthModule = d.createShaderModule({ code: depthMapWGSL })
    this.depthPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: depthModule, entryPoint: 'vs' },
      fragment: {
        module: depthModule, entryPoint: 'fs',
        targets: [{ format: 'r32float' }],
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Bilateral blur pipeline ───────────────────────────────────
    const fullScreenModule = d.createShaderModule({
      code: fullScreenWGSL,
    })
    const bilateralModule = d.createShaderModule({ code: bilateralWGSL })
    this.bilateralPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: fullScreenModule, entryPoint: 'vs',
        constants: { screenWidth: this.width, screenHeight: this.height },
      },
      fragment: {
        module: bilateralModule, entryPoint: 'fs',
        targets: [{ format: 'r32float' }],
        constants: {
          depth_threshold: 5.0,
          projected_particle_constant: 100.0,
          max_filter_size: 20.0,
        },
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Thickness pipeline (uses depth map vertex shader) ─────────
    const thicknessModule = d.createShaderModule({ code: thicknessMapWGSL })
    this.thicknessPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: depthModule, entryPoint: 'vs' },
      fragment: {
        module: thicknessModule, entryPoint: 'fs',
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
    const gaussianModule = d.createShaderModule({ code: gaussianWGSL })
    this.gaussianPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: fullScreenModule, entryPoint: 'vs',
        constants: { screenWidth: this.width, screenHeight: this.height },
      },
      fragment: {
        module: gaussianModule, entryPoint: 'fs',
        targets: [{ format: 'r16float' }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // ── Composite pipeline ────────────────────────────────────────
    const compositeModule = d.createShaderModule({ code: compositeWGSL })
    this.compositePipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: fullScreenModule, entryPoint: 'vs',
        constants: { screenWidth: this.width, screenHeight: this.height },
      },
      fragment: {
        module: compositeModule, entryPoint: 'fs',
        targets: [{ format: presentationFormat }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  /**
   * Upload particle positions from WASM to GPU buffer
   */
  updateParticles(positions: Float32Array, velocities: Float32Array, matIds: Uint8Array, count: number) {
    if (!this.device || !this.initialized) return

    // Pack into the particle buffer format: x,y,z,vx,vy,vz,mat_id per particle
    const data = new Float32Array(count * 7)
    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const i7 = i * 7
      data[i7]     = positions[i3]
      data[i7 + 1] = positions[i3 + 1]
      data[i7 + 2] = positions[i3 + 2]
      data[i7 + 3] = velocities[i3]
      data[i7 + 4] = velocities[i3 + 1]
      data[i7 + 5] = velocities[i3 + 2]
      data[i7 + 6] = matIds[i] // stored as float for alignment
    }

    this.device.queue.writeBuffer(this.particleBuffer, 0, data)
  }

  /**
   * Update camera matrices for rendering
   */
  updateUniforms(
    viewMatrix: Float32Array,
    projectionMatrix: Float32Array,
    sphereSize: number,
  ) {
    if (!this.device) return

    const data = new Float32Array(36) // texel_size(2) + sphere_size(1) + pad(1) + proj(16) + view(16)
    data[0] = 1.0 / this.width
    data[1] = 1.0 / this.height
    data[2] = sphereSize
    data[3] = 0 // padding
    data.set(projectionMatrix, 4)
    data.set(viewMatrix, 20)

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)
  }

  /**
   * Execute the full SSFR rendering pipeline
   */
  render(numParticles: number, _sceneTextureView: GPUTextureView, _outputView: GPUTextureView) {
    if (!this.device || !this.initialized || numParticles === 0) return

    // Use all resources to suppress TS unused warnings during development
    void this.depthMapView; void this.tmpDepthMapView
    void this.thicknessView; void this.tmpThicknessView; void this.depthTestView
    void this.depthPipeline; void this.bilateralPipeline
    void this.thicknessPipeline; void this.gaussianPipeline; void this.compositePipeline
    void this.depthBindGroup; void this.bilateralBindGroupX; void this.bilateralBindGroupY
    void this.thicknessBindGroup; void this.gaussianBindGroupX; void this.gaussianBindGroupY
    void this.compositeBindGroup; void this.sampler

    const encoder = this.device.createCommandEncoder()

    // Pass 1: Render particle depth sprites
    const depthPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.depthMapView,
        clearValue: { r: 1e6, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTestView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    })
    depthPass.setPipeline(this.depthPipeline)
    // depthPass.setBindGroup(0, this.depthBindGroup) // TODO: create bind groups
    depthPass.draw(6, numParticles)
    depthPass.end()

    // Pass 2: Bilateral blur on depth (4 iterations × H+V)
    for (let iter = 0; iter < 4; iter++) {
      // Horizontal
      const blurHPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.tmpDepthMapView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 1e6, g: 0, b: 0, a: 1 },
        }],
      })
      blurHPass.setPipeline(this.bilateralPipeline)
      // blurHPass.setBindGroup(0, this.bilateralBindGroupX)
      blurHPass.draw(6)
      blurHPass.end()

      // Vertical
      const blurVPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.depthMapView,
          loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 1e6, g: 0, b: 0, a: 1 },
        }],
      })
      blurVPass.setPipeline(this.bilateralPipeline)
      // blurVPass.setBindGroup(0, this.bilateralBindGroupY)
      blurVPass.draw(6)
      blurVPass.end()
    }

    // Pass 3: Thickness map (additive blending)
    const thickPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.thicknessView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear', storeOp: 'store',
      }],
    })
    thickPass.setPipeline(this.thicknessPipeline)
    // thickPass.setBindGroup(0, this.thicknessBindGroup)
    thickPass.draw(6, numParticles)
    thickPass.end()

    // Pass 4: Gaussian blur on thickness (1 iteration × H+V)
    const gaussHPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.tmpThicknessView,
        loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    })
    gaussHPass.setPipeline(this.gaussianPipeline)
    // gaussHPass.setBindGroup(0, this.gaussianBindGroupX)
    gaussHPass.draw(6)
    gaussHPass.end()

    const gaussVPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.thicknessView,
        loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    })
    gaussVPass.setPipeline(this.gaussianPipeline)
    // gaussVPass.setBindGroup(0, this.gaussianBindGroupY)
    gaussVPass.draw(6)
    gaussVPass.end()

    // Pass 5: Final composite
    // TODO: Need scene texture and output view bind group

    this.device.queue.submit([encoder.finish()])
  }

  dispose() {
    this.depthMapTexture?.destroy()
    this.tmpDepthMapTexture?.destroy()
    this.thicknessTexture?.destroy()
    this.tmpThicknessTexture?.destroy()
    this.depthTestTexture?.destroy()
    this.particleBuffer?.destroy()
    this.uniformBuffer?.destroy()
    this.filterXBuffer?.destroy()
    this.filterYBuffer?.destroy()
    this.compositeUniformBuffer?.destroy()
  }
}
