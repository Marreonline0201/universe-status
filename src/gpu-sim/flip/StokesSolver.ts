/// <reference types="@webgpu/types" />
// StokesSolver — S3.6e the unified pressure–stress solve (Larionov, Batty & Bridson 2017) on the GPU: shaders/stokes.wgsl,
// the f64 reference is flipRef.stokesSolve (spec vault fluid/realism-2026-09/S3.6e-variational-stokes-spec.md §5).
// Owned by FlipGpuSimulator (created with `viscosity: true`); runs only when a monolithic ball is in a tank whose viscous
// path is on and the scheme is 'auto' (FlipGpuSimulator.stokesRuns) — replacing project → viscosity → project, the
// Poisson solve and the ball's update for that substep. It reuses the ViscositySolver's volumes and μ (encodePrepare).
// Jacobi-PCG in f32, warm-started from the last solve's y (the CPU study: 1e-2 moves the A5 fall by ≤ 0.25 % and a
// warm solve needs ~35 iterations where a cold one needs ~160 — at the f32 floor). Every entry binds ≤ 8 storage buffers.
import commonWGSL from './shaders/common.wgsl?raw'
import viscosityWGSL from './shaders/viscosity.wgsl?raw'
import stokesWGSL from './shaders/stokes.wgsl?raw'
import type { ViscositySolver } from './ViscositySolver'

export interface StokesInputs {
  device: GPUDevice
  params: GPUBuffer          // FlipParams uniform (binding 0)
  visc: ViscositySolver      // volumes, μ, VP (walls, μ default)
  faceType: GPUBuffer; faceSolid: GPUBuffer; sphere: GPUBuffer; cellSolid: GPUBuffer
  coefRaw: GPUBuffer         // ghostCoef's unweighted a_f (vec4 per padded cell)
  u: GPUBuffer; valid: GPUBuffer   // velocity buffer A (u* in, u out) and its valid flags
  size: number               // padded slots per grid
}

export interface StokesStats { iterations: number; converged: boolean; residualInf: number; residualInf0: number; breakdown: boolean; btV: [number, number, number] }
export interface StokesFaults { solves: number; capHits: number; breakdowns: number; maxIterations: number }

type Entry = { name: string; uses: number[]; entry?: string; constants?: Record<string, number> }
const ENTRIES: Entry[] = [
  { name: 'skFaces', uses: [0, 1, 16, 17, 19, 33, 60, 61] },
  { name: 'skRowsC', uses: [0, 1, 13, 20, 21, 26, 63, 81] },
  { name: 'skRowsB', uses: [0, 1, 16, 26, 37, 60, 62, 63, 65] },
  { name: 'skT', uses: [0, 1, 62, 64, 67, 75, 77, 79] },
  { name: 'skTF', uses: [0, 1, 62, 64, 67, 75, 77, 79], entry: 'skT', constants: { SK_FORCE: 1 } },
  { name: 'skReduceV', uses: [0, 26, 60, 77, 78] },
  { name: 'skReduceVF', uses: [0, 26, 60, 77, 78], entry: 'skReduceV', constants: { SK_FORCE: 1 } },
  { name: 'skApply', uses: [0, 1, 16, 62, 64, 67, 73, 76, 77, 79] },
  { name: 'skInit', uses: [0, 64, 68, 69, 71, 74, 77] },
  { name: 'skReduceInit', uses: [60, 77, 78] },
  { name: 'skReduceAlpha', uses: [60, 77, 78] },
  { name: 'skUpdate', uses: [0, 64, 65, 68, 69, 72, 74, 77, 79] },
  { name: 'skReduceBeta', uses: [60, 77, 78] },
  { name: 'skDupdate', uses: [0, 70, 71, 79] },
  { name: 'skBall', uses: [0, 60, 79, 82] },
  { name: 'skWrite', uses: [0, 16, 26, 48, 49, 60, 62, 76] },
  { name: 'skTally', uses: [79, 80] },
]

export class StokesSolver {
  readonly device: GPUDevice
  private readonly inp: StokesInputs
  private readonly sp: GPUBuffer
  readonly bufs: Record<string, GPUBuffer>
  private readonly pipelines = new Map<string, GPUComputePipeline>()
  private readonly groups = new Map<string, GPUBindGroup>()
  readonly rows: number
  private readonly nWgR: number
  private readonly nWgF: number
  /** Face-mass floor W_min (flipRef stokesFaceMin). */
  wMin = 1e-2
  /** ‖r‖∞ stop in the rows' units W·1/s (the page: 1e-2 — the CPU study, spec §5). */
  tol = 1e-2
  /** Iterations encoded per solve (converged iterations return at entry). */
  cap = 400
  /** Start from the last solve's y. */
  warm = true
  /** The ball's V is an unknown (set by the owner each substep). */
  ball = false

  private constructor(inp: StokesInputs) {
    this.inp = inp
    const d = inp.device
    this.device = d
    const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, R = GPUBufferUsage.COPY_SRC
    const mk = (label: string, bytes: number) => d.createBuffer({ label: `stokes.${label}`, size: Math.max(16, bytes), usage: S | D | R })
    this.rows = 7 * inp.size
    this.nWgR = Math.ceil(this.rows / 256)
    this.nWgF = Math.ceil(3 * inp.size / 256)
    this.sp = d.createBuffer({ label: 'stokes.params', size: 32, usage: GPUBufferUsage.UNIFORM | D })
    const N = 4 * this.rows
    this.bufs = {
      face: mk('face', 16 * 3 * inp.size), row: mk('row', 16 * this.rows),
      y: mk('y', N), res: mk('res', N), z: mk('z', N), d: mk('d', N), q: mk('q', N), w: mk('w', 4 * 3 * inp.size),
      part: mk('part', 16 * Math.max(this.nWgR, this.nWgF)), st: mk('st', 4 * 16), faults: mk('faults', 16),
    }
  }

  static async create(inp: StokesInputs): Promise<StokesSolver> {
    const s = new StokesSolver(inp)
    await s.build()
    return s
  }

  private bindingBuffer(b: number, over: Record<number, GPUBuffer>): GPUBuffer {
    if (over[b]) return over[b]
    const B = this.bufs, I = this.inp, V = I.visc.bufs
    switch (b) {
      case 0: return I.params
      case 1: return I.visc.paramsBuffer
      case 13: return V.muAcc
      case 16: return I.faceType
      case 17: return I.faceSolid
      case 19: return V.volFace
      case 20: return V.volCell
      case 21: return V.volEdge
      case 26: case 82: return I.sphere
      case 33: return I.coefRaw
      case 37: case 48: return I.u
      case 49: return I.valid
      case 60: return this.sp
      case 61: case 62: return B.face
      case 63: case 64: return B.row
      case 65: return B.y
      case 67: return B.d
      case 68: return B.res
      case 69: case 70: return B.z
      case 71: case 72: return B.d
      case 73: case 74: return B.q
      case 75: case 76: return B.w
      case 77: return B.part
      case 78: case 79: return B.st
      case 80: return B.faults
      case 81: return I.cellSolid
    }
    throw new Error(`StokesSolver: no buffer for binding ${b}`)
  }

  private async build() {
    const d = this.device
    d.pushErrorScope('validation')
    const module = d.createShaderModule({ label: 'stokes.wgsl', code: `${commonWGSL}\n${viscosityWGSL}\n${stokesWGSL}` })
    const info = await module.getCompilationInfo()
    const errs = info.messages.filter(m => m.type === 'error')
    if (errs.length) throw new Error(`stokes.wgsl: ${errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')}`)
    const maxSB = d.limits.maxStorageBuffersPerShaderStage
    for (const e of ENTRIES) {
      const storage = e.uses.filter(b => b !== 0 && b !== 1 && b !== 60).length
      if (storage > maxSB) throw new Error(`stokes ${e.name} binds ${storage} storage buffers > ${maxSB}`)
      const constants: Record<string, number> = { PRECISE_P2G: 1, ...(e.constants ?? {}) }
      this.pipelines.set(e.name, d.createComputePipeline({ label: `stokes.${e.name}`, layout: 'auto', compute: { module, entryPoint: e.entry ?? e.name, constants } }))
    }
    for (const e of ENTRIES) this.groups.set(e.name, this.group(e.name, e.uses))
    // the operator on y (the warm start's A·y, the finish's Bᵀy)
    const uses = (n: string) => ENTRIES.find(e => e.name === n)!.uses
    this.groups.set('skTY', this.group('skT', uses('skT'), { 67: this.bufs.y }))
    this.groups.set('skTFY', this.group('skTF', uses('skTF'), { 67: this.bufs.y }))
    this.groups.set('skApplyY', this.group('skApply', uses('skApply'), { 67: this.bufs.y }))
    const err = await d.popErrorScope()
    if (err) throw new Error(`StokesSolver: ${err.message}`)
  }

  private group(entry: string, uses: number[], over: Record<number, GPUBuffer> = {}): GPUBindGroup {
    return this.device.createBindGroup({
      label: `stokes.${entry}`, layout: this.pipelines.get(entry)!.getBindGroupLayout(0),
      entries: uses.map(b => ({ binding: b, resource: { buffer: this.bindingBuffer(b, over) } })),
    })
  }

  private writeParams() {
    const b = new ArrayBuffer(32), f = new Float32Array(b), u = new Uint32Array(b)
    f[0] = this.wMin; f[1] = this.tol; u[2] = this.nWgR; u[3] = this.nWgF; u[4] = this.warm ? 1 : 0; u[5] = this.ball ? 1 : 0
    this.device.queue.writeBuffer(this.sp, 0, b)
  }

  private run(pass: GPUComputePassEncoder, name: string, threads: number, group?: string) {
    pass.setPipeline(this.pipelines.get(name)!)
    pass.setBindGroup(0, this.groups.get(group ?? name)!)
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(threads / 256)))
  }

  /** The whole solve on velocity buffer A (the caller has run the level set with the ball's images, labels, fill,
   *  extrapolation, the unweighted a_f copy and ViscositySolver.encodePrepare; the FlipParams uniform is current, the
   *  sphere buffer holds V* = Vⁿ + Δt·g). Returns the dispatch count. */
  encode(encoder: GPUCommandEncoder): number {
    this.writeParams()
    const F = 3 * this.inp.size, Rw = this.rows, ball = this.ball
    encoder.clearBuffer(this.bufs.st)
    let n = 0
    const one = (pass: GPUComputePassEncoder, name: string, group?: string) => { pass.setPipeline(this.pipelines.get(name)!); pass.setBindGroup(0, this.groups.get(group ?? name)!); pass.dispatchWorkgroups(1); n++ }
    let pass = encoder.beginComputePass({ label: 'stokes.setup' })
    this.run(pass, 'skFaces', F); this.run(pass, 'skRowsC', Rw); this.run(pass, 'skRowsB', Rw); n += 3
    // r₀ = b − A·y (warm) — the operator on y
    this.run(pass, 'skT', F, 'skTY'); n++
    if (ball) one(pass, 'skReduceV')
    this.run(pass, 'skApply', Rw, 'skApplyY'); this.run(pass, 'skInit', Rw); n += 2
    one(pass, 'skReduceInit')
    pass.end()
    pass = encoder.beginComputePass({ label: 'stokes.pcg' })
    for (let k = 0; k < this.cap; k++) {
      this.run(pass, 'skT', F); n++
      if (ball) one(pass, 'skReduceV')
      this.run(pass, 'skApply', Rw); n++
      one(pass, 'skReduceAlpha')
      this.run(pass, 'skUpdate', Rw); n++
      one(pass, 'skReduceBeta')
      this.run(pass, 'skDupdate', Rw); n++
    }
    pass.end()
    pass = encoder.beginComputePass({ label: 'stokes.finish' })
    this.run(pass, 'skTF', F, 'skTFY'); n++
    if (ball) { one(pass, 'skReduceVF'); one(pass, 'skBall') }
    this.run(pass, 'skWrite', F); n++
    one(pass, 'skTally')
    pass.end()
    return n
  }

  /** Forget the warm start (a new scene). */
  resetWarm(encoder?: GPUCommandEncoder) {
    if (encoder) { encoder.clearBuffer(this.bufs.y); return }
    const e = this.device.createCommandEncoder()
    e.clearBuffer(this.bufs.y)
    this.device.queue.submit([e.finish()])
  }

  private async read(buf: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const d = this.device
    const staging = d.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const e = d.createCommandEncoder()
    e.copyBufferToBuffer(buf, 0, staging, 0, bytes)
    d.queue.submit([e.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = staging.getMappedRange().slice(0)
    staging.destroy()
    return out
  }
  async readStats(): Promise<StokesStats> {
    const s = new Float32Array(await this.read(this.bufs.st, 64))
    return { iterations: s[5], converged: s[4] > 0.5, residualInf: s[6], residualInf0: s[3], breakdown: s[7] > 0.5, btV: [s[11], s[12], s[13]] }
  }
  resetFaults() { this.device.queue.writeBuffer(this.bufs.faults, 0, new Uint32Array(4)) }
  async readFaults(): Promise<StokesFaults> {
    const u = new Uint32Array(await this.read(this.bufs.faults, 16))
    return { solves: u[0], capHits: u[1], breakdowns: u[2], maxIterations: u[3] }
  }
  /** Diagnostics (K40): face coefficients (g, gv, K⁻¹, kind), rows (C | −1, diag, W, b), y. */
  async readSystem(): Promise<{ face: Float32Array; row: Float32Array; y: Float32Array }> {
    return {
      face: new Float32Array(await this.read(this.bufs.face, 16 * 3 * this.inp.size)),
      row: new Float32Array(await this.read(this.bufs.row, 16 * this.rows)),
      y: new Float32Array(await this.read(this.bufs.y, 4 * this.rows)),
    }
  }

  destroy() { for (const b of Object.values(this.bufs)) b.destroy(); this.sp.destroy() }
}
