// MpmGpuSimulator.ts — Orchestrates MLS-MPM compute passes on GPU

import clearGridWGSL from './shaders/clearGrid.wgsl?raw'
import p2gWGSL from './shaders/p2g.wgsl?raw'
import gridForcesWGSL from './shaders/gridForces.wgsl?raw'
import g2pWGSL from './shaders/g2p.wgsl?raw'
import contactDetectWGSL from './shaders/contactDetect.wgsl?raw'

export interface GpuParticle {
  pos: [number, number, number]
  vel: [number, number, number]
  composition_id: number
  temperature: number
  phase: number
}

export interface CompositionGpuProps {
  color: [number, number, number]
  density: number
  viscosity: number
  surfaceTension: number
  meltingPoint: number
  boilingPoint: number
  F0: number
  metalness: number
  emissive: number
  IOR: number
  specularPower: number
  opacityDensity: number
}

const GRID_SIZE = 64
const GRID_CELLS = GRID_SIZE ** 3          // 262,144 cells
const GRID_SLOTS = GRID_CELLS * 4          // 1,048,576 i32 slots (4 per cell)
const MAX_PARTICLES = 40_000
const MAX_CONTACTS = 10_000
// Particle struct: pos(12) + comp_id(4) + vel(12) + temp(4) + C(16) + phase(4) + pad(12) = 64 bytes
const PARTICLE_STRIDE = 64
const FLOATS_PER_PARTICLE = PARTICLE_STRIDE / 4  // 16

export class MpmGpuSimulator {
  private device!: GPUDevice
  private initialized = false

  // Buffers
  private particleBuf!: GPUBuffer
  private gridBuf!: GPUBuffer
  private simParamsBuf!: GPUBuffer
  private compPropsBuf!: GPUBuffer
  private contactBuf!: GPUBuffer
  private contactCounterBuf!: GPUBuffer
  private contactReadBuf!: GPUBuffer   // MAP_READ for CPU readback
  private counterReadBuf!: GPUBuffer   // MAP_READ for counter readback

  // Pipelines
  private clearGridPipeline!: GPUComputePipeline
  private p2gPipeline!: GPUComputePipeline
  private gridForcesPipeline!: GPUComputePipeline
  private g2pPipeline!: GPUComputePipeline
  private contactDetectPipeline!: GPUComputePipeline

  // Bind groups
  private clearGridBG!: GPUBindGroup
  private p2gBG!: GPUBindGroup
  private gridForcesBG!: GPUBindGroup
  private g2pBG!: GPUBindGroup
  private contactDetectBG!: GPUBindGroup

  private numParticles = 0
  private frameCount = 0
  private gravity = 9.81
  private dt = 0.2

  get particleBuffer(): GPUBuffer { return this.particleBuf }
  get particleCount(): number { return this.numParticles }
  get isInitialized(): boolean { return this.initialized }

  async init(device: GPUDevice): Promise<boolean> {
    this.device = device

    // ── Create buffers ────────────────────────────────────────────────────

    this.particleBuf = device.createBuffer({
      size: MAX_PARTICLES * PARTICLE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })

    // Grid: array<atomic<i32>> with 4 slots per cell = 1,048,576 i32 entries
    // Total size = 1,048,576 * 4 bytes = 4,194,304 bytes
    this.gridBuf = device.createBuffer({
      size: GRID_SLOTS * 4,
      usage: GPUBufferUsage.STORAGE,
    })

    // SimParams uniform: { dt: f32, gravity: f32, num_particles: u32, _pad: u32 } = 16 bytes
    this.simParamsBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Composition properties: array<vec4<f32>, 256> = 256 * 16 = 4,096 bytes
    // Each vec4: (density, viscosity, surfaceTension, stiffness)
    this.compPropsBuf = device.createBuffer({
      size: 256 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    // Contact pairs: array<ContactPair> where ContactPair = { particle_a: u32, particle_b: u32 }
    // Max 10,000 pairs * 8 bytes = 80,000 bytes
    this.contactBuf = device.createBuffer({
      size: MAX_CONTACTS * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })

    // Atomic counter for contact detection
    this.contactCounterBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })

    // CPU-readable readback buffers (MAP_READ + COPY_DST)
    this.contactReadBuf = device.createBuffer({
      size: MAX_CONTACTS * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })

    this.counterReadBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })

    // ── Create compute pipelines ──────────────────────────────────────────

    this.clearGridPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: clearGridWGSL }), entryPoint: 'main' },
    })

    this.p2gPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: p2gWGSL }), entryPoint: 'main' },
    })

    this.gridForcesPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: gridForcesWGSL }), entryPoint: 'main' },
    })

    this.g2pPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: g2pWGSL }), entryPoint: 'main' },
    })

    this.contactDetectPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: contactDetectWGSL }), entryPoint: 'main' },
    })

    // ── Create bind groups ────────────────────────────────────────────────
    // Each bind group must match the shader's @group(0) @binding(N) declarations.

    // clearGrid: binding 0 = grid (read_write, atomic<i32>)
    this.clearGridBG = device.createBindGroup({
      layout: this.clearGridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.gridBuf } }],
    })

    // p2g: binding 0 = particles (read), 1 = grid (read_write, atomic<i32>),
    //       2 = params (uniform), 3 = comp_props (read)
    this.p2gBG = device.createBindGroup({
      layout: this.p2gPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.gridBuf } },
        { binding: 2, resource: { buffer: this.simParamsBuf } },
        { binding: 3, resource: { buffer: this.compPropsBuf } },
      ],
    })

    // gridForces: binding 0 = grid (read_write, atomic<i32>), 1 = params (uniform)
    this.gridForcesBG = device.createBindGroup({
      layout: this.gridForcesPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.gridBuf } },
        { binding: 1, resource: { buffer: this.simParamsBuf } },
      ],
    })

    // g2p: binding 0 = particles (read_write), 1 = grid (read, array<i32>),
    //       2 = params (uniform)
    // Note: g2p reads grid as array<i32> (not atomic), but same GPUBuffer works —
    // the shader declares var<storage, read> so WebGPU auto-layout infers read-only.
    this.g2pBG = device.createBindGroup({
      layout: this.g2pPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.gridBuf } },
        { binding: 2, resource: { buffer: this.simParamsBuf } },
      ],
    })

    // contactDetect: binding 0 = particles (read), 1 = contacts (read_write),
    //                2 = counter (read_write), 3 = params (uniform)
    this.contactDetectBG = device.createBindGroup({
      layout: this.contactDetectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.contactBuf } },
        { binding: 2, resource: { buffer: this.contactCounterBuf } },
        { binding: 3, resource: { buffer: this.simParamsBuf } },
      ],
    })

    this.initialized = true
    return true
  }

  /** Upload initial particles to GPU, replacing any existing particles */
  spawnParticles(particles: GpuParticle[]) {
    const data = new Float32Array(particles.length * FLOATS_PER_PARTICLE)
    for (let i = 0; i < particles.length; i++) {
      const offset = i * FLOATS_PER_PARTICLE
      const p = particles[i]
      data[offset + 0] = p.pos[0]
      data[offset + 1] = p.pos[1]
      data[offset + 2] = p.pos[2]
      // composition_id stored as u32 bits in the f32 slot
      new Uint32Array(data.buffer, (offset + 3) * 4, 1)[0] = p.composition_id
      data[offset + 4] = p.vel[0]
      data[offset + 5] = p.vel[1]
      data[offset + 6] = p.vel[2]
      data[offset + 7] = p.temperature
      // C matrix (affine velocity field) — start at zero
      data[offset + 8] = 0; data[offset + 9] = 0   // C0: vec2<f32>
      data[offset + 10] = 0; data[offset + 11] = 0  // C1: vec2<f32>
      // phase
      new Uint32Array(data.buffer, (offset + 12) * 4, 1)[0] = p.phase
      // padding
      data[offset + 13] = 0; data[offset + 14] = 0; data[offset + 15] = 0
    }
    this.device.queue.writeBuffer(this.particleBuf, 0, data, 0, particles.length * FLOATS_PER_PARTICLE)
    this.numParticles = particles.length
  }

  /** Add more particles without clearing existing ones */
  addParticles(particles: GpuParticle[]) {
    if (this.numParticles + particles.length > MAX_PARTICLES) {
      console.warn(`Particle overflow: ${this.numParticles} + ${particles.length} > ${MAX_PARTICLES}, clamping`)
      particles = particles.slice(0, MAX_PARTICLES - this.numParticles)
      if (particles.length === 0) return
    }
    const data = new Float32Array(particles.length * FLOATS_PER_PARTICLE)
    for (let i = 0; i < particles.length; i++) {
      const offset = i * FLOATS_PER_PARTICLE
      const p = particles[i]
      data[offset + 0] = p.pos[0]
      data[offset + 1] = p.pos[1]
      data[offset + 2] = p.pos[2]
      new Uint32Array(data.buffer, (offset + 3) * 4, 1)[0] = p.composition_id
      data[offset + 4] = p.vel[0]
      data[offset + 5] = p.vel[1]
      data[offset + 6] = p.vel[2]
      data[offset + 7] = p.temperature
      data[offset + 8] = 0; data[offset + 9] = 0
      data[offset + 10] = 0; data[offset + 11] = 0
      new Uint32Array(data.buffer, (offset + 12) * 4, 1)[0] = p.phase
      data[offset + 13] = 0; data[offset + 14] = 0; data[offset + 15] = 0
    }
    const byteOffset = this.numParticles * PARTICLE_STRIDE
    this.device.queue.writeBuffer(this.particleBuf, byteOffset, data)
    this.numParticles += particles.length
  }

  /** Upload composition properties to GPU */
  updateCompositionProps(props: Float32Array) {
    // props: up to 256 * 4 floats (density, viscosity, surfaceTension, stiffness per composition)
    this.device.queue.writeBuffer(this.compPropsBuf, 0, props)
  }

  /** Run one simulation step (2 substeps of clearGrid -> P2G -> gridForces -> G2P) */
  step(encoder: GPUCommandEncoder) {
    // Upload sim params
    const params = new Float32Array([this.dt, this.gravity, 0, 0])
    new Uint32Array(params.buffer, 8, 1)[0] = this.numParticles
    this.device.queue.writeBuffer(this.simParamsBuf, 0, params)

    const particleGroups = Math.ceil(this.numParticles / 256)
    const gridCellGroups = Math.ceil(GRID_CELLS / 256)
    // clearGrid iterates over all 1,048,576 i32 slots, not just 262,144 cells
    const gridSlotGroups = Math.ceil(GRID_SLOTS / 256)

    // 2 substeps per frame for stability
    for (let sub = 0; sub < 2; sub++) {
      // 1. Clear grid — dispatches over all GRID_SLOTS (1,048,576 entries)
      const clearPass = encoder.beginComputePass()
      clearPass.setPipeline(this.clearGridPipeline)
      clearPass.setBindGroup(0, this.clearGridBG)
      clearPass.dispatchWorkgroups(gridSlotGroups)
      clearPass.end()

      // 2. P2G — dispatches over particles
      const p2gPass = encoder.beginComputePass()
      p2gPass.setPipeline(this.p2gPipeline)
      p2gPass.setBindGroup(0, this.p2gBG)
      p2gPass.dispatchWorkgroups(particleGroups)
      p2gPass.end()

      // 3. Grid forces — dispatches over grid cells (262,144)
      const forcesPass = encoder.beginComputePass()
      forcesPass.setPipeline(this.gridForcesPipeline)
      forcesPass.setBindGroup(0, this.gridForcesBG)
      forcesPass.dispatchWorkgroups(gridCellGroups)
      forcesPass.end()

      // 4. G2P — dispatches over particles
      const g2pPass = encoder.beginComputePass()
      g2pPass.setPipeline(this.g2pPipeline)
      g2pPass.setBindGroup(0, this.g2pBG)
      g2pPass.dispatchWorkgroups(particleGroups)
      g2pPass.end()
    }

    // Contact detection every 10 frames
    this.frameCount++
    if (this.frameCount % 10 === 0) {
      // Reset counter to zero before detection pass
      this.device.queue.writeBuffer(this.contactCounterBuf, 0, new Uint32Array([0]))

      const contactPass = encoder.beginComputePass()
      contactPass.setPipeline(this.contactDetectPipeline)
      contactPass.setBindGroup(0, this.contactDetectBG)
      contactPass.dispatchWorkgroups(particleGroups)
      contactPass.end()

      // Copy results from STORAGE buffers to MAP_READ buffers for CPU readback
      encoder.copyBufferToBuffer(this.contactCounterBuf, 0, this.counterReadBuf, 0, 4)
      encoder.copyBufferToBuffer(this.contactBuf, 0, this.contactReadBuf, 0, MAX_CONTACTS * 8)
    }
  }

  /** Read contact pairs back to CPU (async). Call after command buffer submission. */
  async readContacts(): Promise<{ a: number; b: number }[]> {
    try {
      await this.counterReadBuf.mapAsync(GPUMapMode.READ)
      const countData = new Uint32Array(this.counterReadBuf.getMappedRange())
      const count = Math.min(countData[0], MAX_CONTACTS)
      this.counterReadBuf.unmap()

      if (count === 0) return []

      await this.contactReadBuf.mapAsync(GPUMapMode.READ)
      const contactData = new Uint32Array(this.contactReadBuf.getMappedRange())
      const contacts: { a: number; b: number }[] = []
      for (let i = 0; i < count; i++) {
        contacts.push({ a: contactData[i * 2], b: contactData[i * 2 + 1] })
      }
      this.contactReadBuf.unmap()

      return contacts
    } catch {
      return []
    }
  }

  /** Get the particle buffer for the SSFR renderer to bind */
  getParticleBuffer(): GPUBuffer {
    return this.particleBuf
  }

  setGravity(g: number) { this.gravity = g }
  setTimestep(dt: number) { this.dt = dt }

  destroy() {
    this.particleBuf?.destroy()
    this.gridBuf?.destroy()
    this.simParamsBuf?.destroy()
    this.compPropsBuf?.destroy()
    this.contactBuf?.destroy()
    this.contactCounterBuf?.destroy()
    this.contactReadBuf?.destroy()
    this.counterReadBuf?.destroy()
    this.initialized = false
  }
}
