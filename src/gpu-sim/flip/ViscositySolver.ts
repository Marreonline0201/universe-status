/// <reference types="@webgpu/types" />
// ViscositySolver — S3.6 implicit variational viscosity (Batty & Bridson 2008) on the GPU: shaders/viscosity.wgsl,
// the f64 reference is flipRef.viscositySolve. Owned by FlipGpuSimulator (created with `viscosity: true`); encode() runs
// the whole solve on the velocity buffer A between the first projection's extrapolation and the second projection.
// Every entry point binds ≤ 8 storage buffers (the default WebGPU limit this code base keeps).
import commonWGSL from './shaders/common.wgsl?raw'
import viscosityWGSL from './shaders/viscosity.wgsl?raw'

export interface ViscosityInputs {
  device: GPUDevice
  params: GPUBuffer          // FlipParams uniform (binding 0)
  pos: GPUBuffer; aux: GPUBuffer
  labels: GPUBuffer          // the pressure solve's labels (solver layout)
  faceType: GPUBuffer; faceSolid: GPUBuffer; sphere: GPUBuffer
  coefRaw: GPUBuffer         // ghostCoef's unweighted a_f (vec4 per padded cell)
  u: GPUBuffer; valid: GPUBuffer   // velocity buffer A and its valid flags
  size: number               // padded slots per grid
  paddedCount: number        // solver cells
  cells: number              // window cells
  maxParticles: number
}

export interface ViscosityStats { iterations: number; converged: boolean; relResidual: number }
/** Since the last resetFaults: solves, cap hits (not converged at the encoded cap), breakdowns, the most iterations. */
export interface ViscosityFaults { solves: number; capHits: number; breakdowns: number; maxIterations: number }

type Entry = { name: string; uses: number[]; constants?: Record<string, number> }
const ENTRIES: Entry[] = [
  { name: 'bandCells', uses: [0, 5, 6] },
  { name: 'bandDilate', uses: [0, 7, 52] },
  { name: 'latScatter', uses: [0, 2, 3, 53] },
  { name: 'volumes', uses: [0, 4, 5, 7, 8, 9, 10] },
  { name: 'muMinScatter', uses: [0, 2, 11, 13, 51] },
  { name: 'muScatter', uses: [0, 2, 11, 13, 51] },
  { name: 'weights', uses: [0, 1, 13, 14, 15, 20, 21] },
  { name: 'kindFaces', uses: [0, 1, 16, 17, 18, 19] },
  { name: 'kindSamples', uses: [0, 1, 16, 18, 20, 21] },
  { name: 'constants', uses: [0, 24, 37, 26, 36, 33, 19, 34, 40] },
  { name: 'strain', uses: [0, 1, 16, 24, 25, 22, 23, 27, 28, 47] },
  { name: 'strainConst', uses: [0, 1, 16, 24, 25, 22, 23, 27, 28, 47], constants: { CONST_MODE: 1 } },
  { name: 'gather', uses: [0, 1, 24, 25, 29, 30, 31, 32, 47] },
  { name: 'gatherMinus', uses: [0, 1, 24, 25, 29, 30, 31, 32, 47], constants: { GATHER_MINUS: 1 } },
  { name: 'diagonal', uses: [0, 1, 24, 31, 22, 23, 35] },
  { name: 'pcgInit', uses: [0, 39, 44, 38, 41, 42, 43, 45] },
  { name: 'pcgDot', uses: [0, 47, 43, 44, 45] },
  { name: 'pcgUpdate', uses: [0, 47, 40, 43, 44, 41, 38, 42, 45] },
  { name: 'pcgDupdate', uses: [0, 47, 43, 42] },
  { name: 'reduceInit', uses: [1, 45, 46] },
  { name: 'reduceAlpha', uses: [1, 45, 46] },
  { name: 'reduceBeta', uses: [1, 45, 46] },
  { name: 'tally', uses: [47, 54] },
  { name: 'writeBack', uses: [0, 19, 24, 50, 48, 49] },
]
const ENTRY_POINT: Record<string, string> = { strainConst: 'strain', gatherMinus: 'gather' }

export class ViscositySolver {
  readonly device: GPUDevice
  private readonly inp: ViscosityInputs
  private readonly vp: GPUBuffer
  readonly bufs: Record<string, GPUBuffer>
  private readonly pipelines = new Map<string, GPUComputePipeline>()
  private readonly groups = new Map<string, GPUBindGroup>()
  private readonly nWg: number
  /** Per axis: −1 no-slip (production), +1 free-slip (test gates). */
  walls: [number, number, number] = [-1, -1, -1]
  muDefault = 1.001596e-3
  tol = 1e-5
  cap = 60

  private constructor(inp: ViscosityInputs) {
    this.inp = inp
    const d = inp.device
    this.device = d
    const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, R = GPUBufferUsage.COPY_SRC
    const mk = (label: string, bytes: number) => d.createBuffer({ label: `visc.${label}`, size: Math.max(16, bytes), usage: S | D | R })
    const G = 3 * inp.size, PC = inp.paddedCount
    this.nWg = Math.ceil(G / 256)
    this.vp = d.createBuffer({ label: 'visc.params', size: 32, usage: GPUBufferUsage.UNIFORM | D })
    this.bufs = {
      latSums: mk('latSums', 4 * 64 * PC), band: mk('band', 4 * PC),
      volFace: mk('volFace', 4 * G), volCell: mk('volCell', 4 * PC), volEdge: mk('volEdge', 4 * G),
      muTable: mk('muTable', 4 * 256), muAcc: mk('muAcc', 4 * 5 * (PC + 3 * inp.size + inp.size)),
      wCell: mk('wCell', 4 * PC), wEdge: mk('wEdge', 4 * G), kind: mk('kind', 4 * G), constVal: mk('constVal', 4 * G),
      mass: mk('mass', 4 * G), diag: mk('diag', 4 * G), b: mk('b', 4 * G),
      x: mk('x', 4 * G), r: mk('r', 4 * G), z: mk('z', 4 * G), d: mk('d', 4 * G), q: mk('q', 4 * G),
      stressCell: mk('stressCell', 4 * 3 * PC), stressEdge: mk('stressEdge', 4 * G),
      partials: mk('partials', 16 * this.nWg), st: mk('st', 4 * 8), bandNear: mk('bandNear', 4 * PC),
      faults: mk('faults', 16),
    }
  }

  static async create(inp: ViscosityInputs): Promise<ViscositySolver> {
    const v = new ViscositySolver(inp)
    await v.build()
    return v
  }

  private bindingBuffer(entry: string, b: number): GPUBuffer {
    const B = this.bufs, I = this.inp
    const vecIn: Record<string, GPUBuffer> = { strain: B.d, strainConst: B.constVal, gather: B.d, gatherMinus: I.u }
    const vecOut: Record<string, GPUBuffer> = { gather: B.q, gatherMinus: B.b }
    switch (b) {
      case 0: return I.params
      case 1: return this.vp
      case 2: return I.pos
      case 3: case 4: return B.latSums
      case 5: return I.labels
      case 6: case 7: return B.band
      case 8: case 19: return B.volFace
      case 9: case 20: return B.volCell
      case 10: case 21: return B.volEdge
      case 11: return I.aux
      case 13: return B.muAcc
      case 14: case 22: return B.wCell
      case 15: case 23: return B.wEdge
      case 16: return I.faceType
      case 17: return I.faceSolid
      case 18: case 24: return B.kind
      case 25: return vecIn[entry]
      case 26: return I.sphere
      case 27: case 29: return B.stressCell
      case 28: case 30: return B.stressEdge
      case 31: case 34: return B.mass
      case 32: return vecOut[entry]
      case 33: return I.coefRaw
      case 35: case 38: return B.diag
      case 36: return B.constVal
      case 37: return I.u
      case 39: return B.b
      case 40: case 50: return B.x
      case 41: return B.r
      case 42: return B.z
      case 43: return B.d
      case 44: return B.q
      case 45: return B.partials
      case 46: case 47: return B.st
      case 48: return I.u
      case 49: return I.valid
      case 51: return B.muTable
      case 52: case 53: return B.bandNear
      case 54: return B.faults
    }
    throw new Error(`ViscositySolver: no buffer for binding ${b} (${entry})`)
  }

  private async build() {
    const d = this.device
    d.pushErrorScope('validation')
    const module = d.createShaderModule({ label: 'viscosity.wgsl', code: `${commonWGSL}\n${viscosityWGSL}` })
    const info = await module.getCompilationInfo()
    const errs = info.messages.filter(m => m.type === 'error')
    if (errs.length) throw new Error(`viscosity.wgsl: ${errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')}`)
    const maxSB = d.limits.maxStorageBuffersPerShaderStage
    for (const e of ENTRIES) {
      const storage = e.uses.filter(b => b > 1).length
      if (storage > maxSB) throw new Error(`viscosity ${e.name} binds ${storage} storage buffers > ${maxSB}`)
      const constants: Record<string, number> = { PRECISE_P2G: 1, ...(e.constants ?? {}) }
      const pipeline = d.createComputePipeline({ label: `visc.${e.name}`, layout: 'auto', compute: { module, entryPoint: ENTRY_POINT[e.name] ?? e.name, constants } })
      this.pipelines.set(e.name, pipeline)
    }
    // bind groups: the strain/gather variants that read x (the start value) get their own groups
    for (const e of ENTRIES) this.groups.set(e.name, this.group(e.name, e.uses))
    const B = this.bufs
    this.groups.set('strainX', this.group('strain', ENTRIES.find(e => e.name === 'strain')!.uses, { 25: B.x }))
    this.groups.set('gatherX', this.group('gather', ENTRIES.find(e => e.name === 'gather')!.uses, { 25: B.x }))
    const err = await d.popErrorScope()
    if (err) throw new Error(`ViscositySolver: ${err.message}`)
  }

  private group(entry: string, uses: number[], override: Record<number, GPUBuffer> = {}): GPUBindGroup {
    const pipeline = this.pipelines.get(entry)!
    return this.device.createBindGroup({
      label: `visc.${entry}`, layout: pipeline.getBindGroupLayout(0),
      entries: uses.map(b => ({ binding: b, resource: { buffer: override[b] ?? this.bindingBuffer(entry, b) } })),
    })
  }

  /** μ (Pa·s) per composition id (the particles' aux.x). */
  setMuTable(mu: Float32Array) { this.device.queue.writeBuffer(this.bufs.muTable, 0, mu.buffer, mu.byteOffset, Math.min(mu.byteLength, 4 * 256)) }

  private writeParams() {
    const b = new ArrayBuffer(32), f = new Float32Array(b), u = new Uint32Array(b)
    f.set(this.walls, 0); f[3] = this.muDefault; f[4] = this.tol * this.tol; u[5] = this.nWg
    this.device.queue.writeBuffer(this.vp, 0, b)
  }

  private dispatch(pass: GPUComputePassEncoder, name: string, threads: number, wg: number, group?: string) {
    pass.setPipeline(this.pipelines.get(name)!)
    pass.setBindGroup(0, this.groups.get(group ?? name)!)
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(threads / wg)))
  }

  /** The whole solve on velocity buffer A (the caller has projected and extrapolated it, and the FlipParams uniform is
   *  current). Returns the dispatch count. `stopAfter` (profiling): end the pass after the first dispatch of that kernel. */
  encode(encoder: GPUCommandEncoder, stopAfter?: string): number {
    this.writeParams()
    const I = this.inp, B = this.bufs, G = 3 * I.size
    encoder.clearBuffer(B.latSums); encoder.clearBuffer(B.muAcc); encoder.clearBuffer(B.st)
    const pass = encoder.beginComputePass({ label: 'viscosity' })
    let n = 0, stopped = false
    const run = (name: string, threads: number, wg = 256, group?: string) => {
      if (stopped) return
      this.dispatch(pass, name, threads, wg, group); n++
      if (name === stopAfter) stopped = true
    }
    run('bandCells', I.cells)
    run('bandDilate', I.cells)
    run('latScatter', I.maxParticles, 64)
    run('volumes', 6 * I.size + I.cells)
    run('muMinScatter', I.maxParticles, 64)
    run('muScatter', I.maxParticles, 64)
    run('weights', I.cells + G)
    run('kindFaces', G)
    run('kindSamples', I.cells + G)
    run('constants', G)
    run('diagonal', G)
    run('strainConst', I.cells + G)
    run('gatherMinus', G)
    run('strain', I.cells + G, 256, 'strainX')
    run('gather', G, 256, 'gatherX')
    run('pcgInit', G)
    run('reduceInit', 256)
    for (let k = 0; k < this.cap; k++) {
      run('strain', I.cells + G)
      run('gather', G)
      run('pcgDot', G)
      run('reduceAlpha', 256)
      run('pcgUpdate', G)
      run('reduceBeta', 256)
      run('pcgDupdate', G)
    }
    run('tally', 1, 1)
    run('writeBack', G)
    pass.end()
    return n
  }

  resetFaults() { this.device.queue.writeBuffer(this.bufs.faults, 0, new Uint32Array(4)) }
  async readFaults(): Promise<ViscosityFaults> {
    const d = this.device
    const staging = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const e = d.createCommandEncoder()
    e.copyBufferToBuffer(this.bufs.faults, 0, staging, 0, 16)
    d.queue.submit([e.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const u = new Uint32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return { solves: u[0], capHits: u[1], breakdowns: u[2], maxIterations: u[3] }
  }

  async readStats(): Promise<ViscosityStats> {
    const d = this.device
    const staging = d.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const e = d.createCommandEncoder()
    e.copyBufferToBuffer(this.bufs.st, 0, staging, 0, 32)
    d.queue.submit([e.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const s = new Float32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return { iterations: s[5], converged: s[4] > 0.5, relResidual: Math.sqrt(s[6] / Math.max(s[3], 1e-300)) }
  }

  destroy() { for (const b of Object.values(this.bufs)) b.destroy(); this.vp.destroy() }
}
