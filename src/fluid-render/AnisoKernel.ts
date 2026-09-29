/// <reference types="@webgpu/types" />
// AnisoKernel — per-frame anisotropic splat shapes for the SSFR depth and thickness passes (shaders/ssfr_aniso.wgsl;
// the mapping, its parameters and their sources: vault fluid/realism-2026-09/research/x10-anisotropic-splats.md).
// Input: the particle buffer in the 80-byte presentation layout (positions in world units, the tank [0, 1]³) and the
// rest volume V_p (world units³). Output: `anisoBuffer`, three vec4 per particle (the axes scaled to their semi-axis
// lengths; the first's w = V_p/((4/3)π a₁a₂a₃)).
import anisoWGSL from './shaders/ssfr_aniso.wgsl?raw'

/** The recommended mapping (x10 §"Recommended mapping"; lengths in units of the rest spacing s = ∛V_p). */
export const ANISO = { riFactor: 3, rb: 1.0, aMin: 0.5, aMax: 2.5, alpha: 1.25, kappa: 2.0, lo: 0.2, hi: 0.4 } as const
/** Interior skip: every one of the 27 cells around a particle holds at least this many particles (a full r_i-cell holds
 *  ppc·(r_i/dx)³ = 8·1.5³ = 27 at rest at 8 ppc; ¾ of that marks a filled cell). */
export const ANISO_INTERIOR_MIN = 20

export class AnisoKernel {
  readonly device: GPUDevice
  private capacity = 0
  private gridN = 0
  private bufs: { count: GPUBuffer; start: GPUBuffer; cursor: GPUBuffer; sorted: GPUBuffer; aniso: GPUBuffer } | null = null
  private readonly params: GPUBuffer
  private pipelines = new Map<string, GPUComputePipeline>()
  private group: GPUBindGroup | null = null
  private groupFor: GPUBuffer | null = null
  /** Interior skip threshold (0 = compute every particle — the parity test). */
  interiorMin = ANISO_INTERIOR_MIN

  private constructor(device: GPUDevice) {
    this.device = device
    this.params = device.createBuffer({ label: 'aniso.params', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }
  static async create(device: GPUDevice): Promise<AnisoKernel> {
    const k = new AnisoKernel(device)
    device.pushErrorScope('validation')
    const module = device.createShaderModule({ label: 'ssfr_aniso.wgsl', code: anisoWGSL })
    const info = await module.getCompilationInfo()
    const errs = info.messages.filter(m => m.type === 'error')
    if (errs.length) throw new Error(`ssfr_aniso.wgsl: ${errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')}`)
    // one explicit layout for every entry (they share the bind group)
    const S = (b: number, type: GPUBufferBindingType) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type } })
    const bgl = device.createBindGroupLayout({ entries: [S(0, 'uniform'), S(1, 'read-only-storage'), S(2, 'storage'), S(3, 'storage'), S(4, 'storage'), S(5, 'storage'), S(6, 'storage')] })
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] })
    for (const e of ['aCount', 'aScan', 'aScatter', 'aAniso']) k.pipelines.set(e, device.createComputePipeline({ label: `aniso.${e}`, layout, compute: { module, entryPoint: e } }))
    k.bgl = bgl
    const err = await device.popErrorScope()
    if (err) throw new Error(`AnisoKernel: ${err.message}`)
    return k
  }
  private bgl!: GPUBindGroupLayout

  private ensure(count: number, s: number) {
    const gridN = Math.max(1, Math.ceil(1 / (ANISO.riFactor * s)))
    if (this.bufs && count <= this.capacity && gridN === this.gridN) return
    if (this.bufs) for (const b of Object.values(this.bufs)) b.destroy()
    const d = this.device, S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const cap = Math.max(1024, Math.ceil(count * 1.25))
    const cells = gridN ** 3
    this.bufs = {
      count: d.createBuffer({ label: 'aniso.count', size: 4 * cells, usage: S }),
      start: d.createBuffer({ label: 'aniso.start', size: 4 * cells, usage: S }),
      cursor: d.createBuffer({ label: 'aniso.cursor', size: 4 * cells, usage: S }),
      sorted: d.createBuffer({ label: 'aniso.sorted', size: 4 * cap, usage: S }),
      aniso: d.createBuffer({ label: 'aniso.out', size: 48 * cap, usage: S }),
    }
    this.capacity = cap
    this.gridN = gridN
    this.group = null
  }

  /** The shapes of this frame's particles (s = ∛V_p in world units). Returns the output buffer. */
  encode(encoder: GPUCommandEncoder, particles: GPUBuffer, count: number, particleVolume: number): GPUBuffer {
    const s = Math.cbrt(particleVolume)
    this.ensure(count, s)
    const B = this.bufs!
    if (!this.group || this.groupFor !== particles) {
      this.group = this.device.createBindGroup({
        label: 'aniso', layout: this.bgl,
        entries: [
          { binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: particles } },
          { binding: 2, resource: { buffer: B.count } }, { binding: 3, resource: { buffer: B.start } }, { binding: 4, resource: { buffer: B.cursor } },
          { binding: 5, resource: { buffer: B.sorted } }, { binding: 6, resource: { buffer: B.aniso } },
        ],
      })
      this.groupFor = particles
    }
    const p = new ArrayBuffer(64), u = new Uint32Array(p), f = new Float32Array(p)
    u[0] = count; u[1] = this.gridN; u[2] = this.interiorMin
    f[4] = s; f[5] = ANISO.riFactor * s; f[6] = ANISO.rb; f[7] = ANISO.aMin; f[8] = ANISO.aMax; f[9] = ANISO.alpha; f[10] = ANISO.kappa; f[11] = ANISO.lo; f[12] = ANISO.hi
    this.device.queue.writeBuffer(this.params, 0, p)
    encoder.clearBuffer(B.count)
    const pass = encoder.beginComputePass({ label: 'ssfr.aniso' })
    const run = (e: string, groups: number) => { pass.setPipeline(this.pipelines.get(e)!); pass.setBindGroup(0, this.group!); pass.dispatchWorkgroups(Math.max(1, groups)) }
    run('aCount', Math.ceil(count / 64))
    run('aScan', 1)
    run('aScatter', Math.ceil(count / 64))
    run('aAniso', Math.ceil(count / 64))
    pass.end()
    return B.aniso
  }

  get anisoBuffer(): GPUBuffer | null { return this.bufs?.aniso ?? null }
  destroy() { if (this.bufs) for (const b of Object.values(this.bufs)) b.destroy(); this.params.destroy() }
}
