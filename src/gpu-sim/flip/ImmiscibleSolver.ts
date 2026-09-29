/// <reference types="@webgpu/types" />
// ImmiscibleSolver — S3.5-i sub-grid drop slip for immiscible liquids on the GPU (Manninen, Taivassalo & Kallio 1996
// algebraic-slip drift flux; drop size from Hinze 1955 or the scenario): shaders/immiscible.wgsl, the f64 reference is
// flipRef.driftFlux. Owned by FlipGpuSimulator (created with `immiscible: true`); encode() runs after the final
// extrapolation and before g2pMac, which adds the per-particle drift to the advection. Every entry point binds ≤ 8
// storage buffers (the default WebGPU limit this code base keeps).
import commonWGSL from './shaders/common.wgsl?raw'
import immiscibleWGSL from './shaders/immiscible.wgsl?raw'

/** Material slots of the shader (MAXK in immiscible.wgsl). */
export const IMMISCIBLE_MAX_SLOTS = 4
const IP_BYTES = 16 + 16 * 4 + 16 * 4 + 16 * 64
/** Statistics words after the per-(cell, slot) sums (immiscible.wgsl ST_*). */
const ST_WORDS = 8

export interface ImmiscibleInputs {
  device: GPUDevice
  params: GPUBuffer          // FlipParams uniform (binding 0)
  pos: GPUBuffer; aux: GPUBuffer
  u: GPUBuffer               // the final (extrapolated) face velocity
  labels: GPUBuffer          // the pressure solve's labels (solver layout)
  faceType: GPUBuffer
  pressure: GPUBuffer        // the pressure solver's x (Pa, solver layout)
  drift: GPUBuffer           // per-particle drift, vec4 (read by g2pMac)
  size: number               // padded slots per grid
  paddedCount: number        // solver cells
  cells: number              // window cells
  maxParticles: number
}

/** One tracked liquid: its composition ids (particles' aux.x), ρ (kg/m³) and μ (Pa·s). */
export interface ImmiscibleMaterial { compositions: number[]; rho: number; mu: number }
export interface ImmiscibleConfig {
  /** Slot order = the tie-break of the majority (lowest slot wins a tie), as flipRef's sorted material ids. */
  materials: ImmiscibleMaterial[]
  /** Interfacial tension σ (N/m) of slots (a, b), or null: miscible or unsourced — never separated by slip. */
  sigma: (a: number, b: number) => number | null
  /** Scenario drop diameter (m); absent: Hinze from ε. */
  dropDiameter?: number
  /** The scheme's numerical viscosity added to the carrier's in ε (m²/s). */
  nuNum: number
}
/** Last encode's dispersed particles, those whose Hinze size is a cell or more, the largest |slip|, the mean d. */
export interface ImmiscibleStats { dispersed: number; tooLarge: number; maxSlip: number; meanDrop: number }

type Entry = { name: string; uses: number[] }
const ENTRIES: Entry[] = [
  { name: 'pressureSum', uses: [22, 23] },
  { name: 'alphaScatter', uses: [0, 1, 2, 3, 4] },
  { name: 'cellInfo', uses: [0, 1, 5, 6, 8] },
  { name: 'slipParticles', uses: [0, 1, 2, 3, 7, 9, 10, 11, 12, 13] },
  { name: 'driftCells', uses: [0, 1, 7, 14, 15] },
  { name: 'driftParticles', uses: [0, 2, 16, 17, 20] },
]

export class ImmiscibleSolver {
  readonly device: GPUDevice
  private readonly inp: ImmiscibleInputs
  private readonly ip: GPUBuffer
  readonly bufs: Record<'alphaSums' | 'cellInf' | 'slipState' | 'slipSums' | 'driftCell' | 'pTotal', GPUBuffer>
  private readonly pipelines = new Map<string, GPUComputePipeline>()
  private readonly groups = new Map<string, GPUBindGroup>()
  /** Slots in use (0 until configure). */
  K = 0

  private constructor(inp: ImmiscibleInputs) {
    this.inp = inp
    const d = inp.device
    this.device = d
    const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, R = GPUBufferUsage.COPY_SRC
    const mk = (label: string, bytes: number) => d.createBuffer({ label: `imm.${label}`, size: Math.max(16, bytes), usage: S | D | R })
    this.ip = d.createBuffer({ label: 'imm.params', size: IP_BYTES, usage: GPUBufferUsage.UNIFORM | D })
    this.bufs = {
      alphaSums: mk('alphaSums', 4 * 10 * inp.size),
      cellInf: mk('cellInf', 4 * 8 * inp.size),
      slipState: mk('slipState', 16 * inp.maxParticles),
      slipSums: mk('slipSums', 4 * (7 * IMMISCIBLE_MAX_SLOTS * inp.size + ST_WORDS)),
      driftCell: mk('driftCell', 16 * inp.size),
      pTotal: mk('pTotal', 4 * inp.paddedCount),
    }
  }

  static async create(inp: ImmiscibleInputs): Promise<ImmiscibleSolver> {
    const s = new ImmiscibleSolver(inp)
    await s.build()
    return s
  }

  private bindingBuffer(b: number): GPUBuffer {
    const B = this.bufs, I = this.inp
    switch (b) {
      case 0: return I.params
      case 1: return this.ip
      case 2: return I.pos
      case 3: return I.aux
      case 4: case 5: return B.alphaSums
      case 6: case 7: return B.cellInf
      case 8: return I.u
      case 9: case 23: return B.pTotal
      case 10: return I.labels
      case 11: return I.faceType
      case 12: case 20: return B.slipState
      case 13: case 14: return B.slipSums
      case 15: case 16: return B.driftCell
      case 17: return I.drift
      case 22: return I.pressure
    }
    throw new Error(`ImmiscibleSolver: no buffer for binding ${b}`)
  }

  private async build() {
    const d = this.device
    d.pushErrorScope('validation')
    const module = d.createShaderModule({ label: 'immiscible.wgsl', code: `${commonWGSL}\n${immiscibleWGSL}` })
    const info = await module.getCompilationInfo()
    const errs = info.messages.filter(m => m.type === 'error')
    if (errs.length) throw new Error(`immiscible.wgsl: ${errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')}`)
    const maxSB = d.limits.maxStorageBuffersPerShaderStage
    for (const e of ENTRIES) {
      const storage = e.uses.filter(b => b > 1).length
      if (storage > maxSB) throw new Error(`immiscible ${e.name} binds ${storage} storage buffers > ${maxSB}`)
      const pipeline = d.createComputePipeline({ label: `imm.${e.name}`, layout: 'auto', compute: { module, entryPoint: e.name, constants: { PRECISE_P2G: 1 } } })
      this.pipelines.set(e.name, pipeline)
      this.groups.set(e.name, d.createBindGroup({
        label: `imm.${e.name}`, layout: pipeline.getBindGroupLayout(0),
        entries: e.uses.map(b => ({ binding: b, resource: { buffer: this.bindingBuffer(b) } })),
      }))
    }
    const err = await d.popErrorScope()
    if (err) throw new Error(`ImmiscibleSolver: ${err.message}`)
  }

  /** The tracked liquids, their pair tensions and the drop-size rule. Throws past IMMISCIBLE_MAX_SLOTS materials or on a
   *  composition id outside 0 … 255 — never silently untracked. */
  configure(c: ImmiscibleConfig) {
    const K = c.materials.length
    if (K > IMMISCIBLE_MAX_SLOTS) throw new RangeError(`ImmiscibleSolver: ${K} materials > ${IMMISCIBLE_MAX_SLOTS} slots`)
    const b = new ArrayBuffer(IP_BYTES), f = new Float32Array(b), u = new Uint32Array(b)
    u[0] = K; f[1] = c.nuNum; f[2] = c.dropDiameter ?? 0
    const slots = new Uint32Array(b, 16 + 64 + 64, 256).fill(IMMISCIBLE_MAX_SLOTS)
    c.materials.forEach((m, k) => {
      f[4 + 4 * k] = m.rho; f[4 + 4 * k + 1] = m.mu
      for (const id of m.compositions) {
        if (!(id >= 0 && id < 256)) throw new RangeError(`ImmiscibleSolver: composition id ${id} outside 0 … 255`)
        slots[id] = k
      }
      for (let cc = 0; cc < K; cc++) f[20 + 4 * k + cc] = cc === k ? 0 : (c.sigma(k, cc) ?? 0)
    })
    this.device.queue.writeBuffer(this.ip, 0, b)
    this.K = K
  }

  private dispatch(pass: GPUComputePassEncoder, name: string, threads: number, wg: number) {
    pass.setPipeline(this.pipelines.get(name)!)
    pass.setBindGroup(0, this.groups.get(name)!)
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(threads / wg)))
  }

  /** The first projection's pressure into pTotal (every path; the drift reads pTotal). */
  encodeFirstPressure(encoder: GPUCommandEncoder) {
    encoder.copyBufferToBuffer(this.inp.pressure, 0, this.bufs.pTotal, 0, 4 * this.inp.paddedCount)
  }
  /** Viscous path: pTotal += the second projection's pressure (flipRef.step, pressureTotal). */
  encodeSecondPressure(encoder: GPUCommandEncoder) {
    const pass = encoder.beginComputePass({ label: 'imm.pressureSum' })
    this.dispatch(pass, 'pressureSum', this.inp.paddedCount, 256)
    pass.end()
  }

  /** α, ε, slip and drift for `count` particles (the FlipParams uniform is current; u is the final velocity). */
  encode(encoder: GPUCommandEncoder, count: number) {
    const B = this.bufs, I = this.inp
    encoder.clearBuffer(B.alphaSums); encoder.clearBuffer(B.slipSums)
    const pass = encoder.beginComputePass({ label: 'imm.drift' })
    if (count > 0) this.dispatch(pass, 'alphaScatter', count, 64)
    this.dispatch(pass, 'cellInfo', I.cells, 256)
    if (count > 0) this.dispatch(pass, 'slipParticles', count, 64)
    this.dispatch(pass, 'driftCells', I.cells, 256)
    if (count > 0) this.dispatch(pass, 'driftParticles', count, 64)
    pass.end()
  }

  /** New particles start with no slip and no drop history. */
  encodeClearParticles(encoder: GPUCommandEncoder, first: number, n: number) {
    if (n > 0) encoder.clearBuffer(this.bufs.slipState, 16 * first, 16 * n)
  }

  async readStats(): Promise<ImmiscibleStats> {
    const d = this.device, off = 4 * 7 * IMMISCIBLE_MAX_SLOTS * this.inp.size
    const staging = d.createBuffer({ size: 4 * ST_WORDS, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const e = d.createCommandEncoder()
    e.copyBufferToBuffer(this.bufs.slipSums, off, staging, 0, 4 * ST_WORDS)
    d.queue.submit([e.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const raw = staging.getMappedRange().slice(0)
    staging.destroy()
    const w = new Uint32Array(raw), fl = new Float32Array(raw)
    const dropUm = w[4] * 2 ** 32 + w[3]
    return { dispersed: w[0], tooLarge: w[1], maxSlip: fl[2], meanDrop: w[0] ? dropUm * 1e-6 / w[0] : 0 }
  }

  destroy() { for (const b of Object.values(this.bufs)) b.destroy(); this.ip.destroy() }
}
