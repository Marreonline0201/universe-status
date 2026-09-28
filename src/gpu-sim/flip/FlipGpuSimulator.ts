/// <reference types="@webgpu/types" />
// FlipGpuSimulator — the incompressible APIC-MAC liquid solver on WebGPU (FINAL-PLAN S3).
// Stages implemented, each diffed kernel by kernel against the f64 CPU reference src/sim-ref/flipRef.ts:
//   S3.1a transfers: faceScatter → gridUpdate → extrapolate ×2 → g2pMac + RK2          (gate s31a-gpu.mjs)
//   S3.1b projection (`projection: true`, create()): labelClear → labelParticles (voxel free surface) → divergence
//         → PoissonSolver (JPCG until S3.3) → project, between gridUpdate and extrapolate  (gate s31b-gpu.mjs)
//   S3.2 density projection (`densityProjection: true`), before faceScatter: labels → cellScatter → densityRhs →
//         ψ solve (second PoissonSolver, unit coefficients, cold) → faceDisplacement → positionCorrect  (gate s32-gpu.mjs)
//
// State is SI in window-local metres (S3N-5), particles are structure-of-arrays (S3N-9):
//   pos  vec4 (x, y, z m, 0)          vel vec4 (v m/s, m̂ = mass / (ρ_ref·dx³))
//   aff  3×vec4 per particle (c_x, c_y, c_z in 1/s)
//   aux  vec4<u32> (composition id, phase, f32 bits of spawn °C, 0)
//   enthalpy vec2<u32> — reserved 64-bit slot (S3N-9), written 0 at spawn, bound by no kernel until HEAT-1.
// The renderer and every existing consumer read `presentationBuffer`, filled by present.wgsl in the legacy
// 80-byte layout (world units = lRef metres, time unit τ) — the only place solver and presentation units meet.
// Face grids: the three MAC grids concatenated (axis a at offset a·size), one slot per GridLayout.idx.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import commonWGSL from './shaders/common.wgsl?raw'
import faceScatterWGSL from './shaders/faceScatter.wgsl?raw'
import gridUpdateWGSL from './shaders/gridUpdate.wgsl?raw'
import extrapolateWGSL from './shaders/extrapolate.wgsl?raw'
import g2pMacWGSL from './shaders/g2pMac.wgsl?raw'
import presentWGSL from './shaders/present.wgsl?raw'
import labelClearWGSL from './shaders/labelClear.wgsl?raw'
import labelParticlesWGSL from './shaders/labelParticles.wgsl?raw'
import divergenceWGSL from './shaders/divergence.wgsl?raw'
import projectWGSL from './shaders/project.wgsl?raw'
import cellScatterWGSL from './shaders/cellScatter.wgsl?raw'
import densityRhsWGSL from './shaders/densityRhs.wgsl?raw'
import faceDisplacementWGSL from './shaders/faceDisplacement.wgsl?raw'
import positionCorrectWGSL from './shaders/positionCorrect.wgsl?raw'
import { PoissonSolver, type SolveConfig, type SolverMethod } from './poisson/PoissonSolver'

/** Fixed-point scales (FINAL-PLAN §5.7): mass in ρ_ref·dx³ at 2^24 (range ±128), momentum at 2^19 (±4096). */
export const MASS_SCALE = 2 ** 24
export const MOM_SCALE = 2 ** 19
/** Legacy presentation layout: 20 words per particle. */
export const PRESENT_STRIDE_BYTES = 80
const PARAMS_BYTES = 96

export interface FlipSimOptions {
  nx: number
  ny: number
  nz: number
  /** Cell size, m. */
  dx: number
  ring?: Vec3
  /** m/s², window axes (default none). */
  gravity?: Vec3
  /** false = PIC transfers (gates' positive control only). */
  apic?: boolean
  maxParticles: number
  /** Grid mass unit density, kg/m³ (default 1000). */
  rhoRef?: number
  /** Presentation length unit, m (1 world unit). */
  lRef: number
  /** Presentation time unit, s. */
  tauS: number
  /** Positions are kept this many metres inside the window (default 1e-6·dx, as flipRef). */
  wallEps?: number
  extrapolationLayers?: number
  /** Two-word fixed-point P2G (default true): sums resolved to the f32 precision of each contribution instead of to
   *  half a quantum per add (s31a P1: single-word momentum at 2^19 left c 1.4e-4 relative off at interior
   *  particles). false = one i32 per sum (fewer atomics; kept for the cost measurement). */
  preciseP2G?: boolean
  /** Pressure projection (S3.1b). Requires FlipGpuSimulator.create(). */
  projection?: boolean
  /** Liquid density, kg/m³ (uniform until S3.5). Default water at 20 °C (NIST). */
  density?: number
  /** Pressure solve tolerance ‖∇·u‖∞, 1/s (FINAL-PLAN §5.3 ε_div = 1e-2). */
  pressureTolerance?: number
  /** Encoded iteration cap of the pressure solve (a cap hit is counted in the solver's sticky faults). Default: MGPCG
   *  18 (Gate 0 dev p95 + 2; S3.3 measured ≤ 10 in the 64³ tank dam break), JPCG 400. */
  pressureCap?: number
  /** 'mgpcg' (default since S3.3: equivalent to JPCG within 2 Pa, 6 vs 24 iterations) or 'jpcg' (baseline). */
  solverMethod?: SolverMethod
  /** Kugelstadt et al. 2019 density projection before P2G (S3.2). Requires projection. */
  densityProjection?: boolean
  /** ψ solve tolerance ‖r‖∞ in volume-fraction units (FINAL-PLAN §5.3: 1e-3). */
  psiTolerance?: number
  /** Encoded iteration cap of the ψ solve. Default: MGPCG 10 (S3.3 measured ≤ 8), JPCG 200. */
  psiCap?: number
}

/** Remainder scale of the two-word fixed point (LO_SCALE in common.wgsl). */
export const LO_SCALE = 4096

export interface FlipParticleInit {
  /** Window-local metres. */
  pos: Vec3
  /** m/s. */
  vel: Vec3
  /** Affine vectors c_x, c_y, c_z (1/s); default 0. */
  c?: [Vec3, Vec3, Vec3]
  /** kg. */
  mass: number
  composition: number
  phase: number
  temperatureC: number
}

export interface FlipDiagnostics {
  wallClamps: number; unsetFaceReads: number; openFaces: number; unsetDivergenceFaces: number; densityClamps: number
  /** ψ solver sticky faults (0 without density projection). */
  psiSolves: number; psiCapHits: number; psiBreakdowns: number; psiMaxIterations: number
  /** Pressure solver sticky faults since the last reset (0 without projection). */
  solves: number; capHits: number; breakdowns: number; maxIterations: number
}

type Kernel = 'faceScatter' | 'gridUpdate' | 'extrapolate' | 'g2pMac' | 'present' | 'labelClear' | 'labelParticles' | 'divergence' | 'project'
  | 'cellScatter' | 'densityRhs' | 'faceDisplacement' | 'positionCorrect'

export class FlipGpuSimulator {
  readonly device: GPUDevice
  readonly layout: GridLayout
  readonly maxParticles: number
  readonly massUnit: number
  gravity: Vec3
  dt = 1 / 120
  readonly apic: boolean
  readonly extrapolationLayers: number
  readonly preciseP2G: boolean
  readonly projection: boolean
  readonly density: number
  readonly pressureTolerance: number
  readonly pressureCap: number
  readonly solverMethod: SolverMethod
  /** Pressure solver (projection only; created by create()). Its x vector is the pressure in Pa, padded layout. */
  solver: PoissonSolver | null = null
  private solveCfg: SolveConfig | null = null
  readonly densityProjection: boolean
  readonly psiTolerance: number
  readonly psiCap: number
  /** ψ solver (density projection only): unit coefficients, cold start. x = ψ̂ = ψ/dx², padded layout. */
  psiSolver: PoissonSolver | null = null
  private psiCfg: SolveConfig | null = null
  /** Density projection buffers: volume fraction (i32 fixed point, padded cells), f̃ (f32, padded cells), face displacements (m). */
  vfracBuf: GPUBuffer | null = null
  fCompBuf: GPUBuffer | null = null
  dispBuf: GPUBuffer | null = null
  private densBg: { cellScatter: GPUBindGroup; densityRhs: GPUBindGroup; faceDisplacement: GPUBindGroup; positionCorrect: GPUBindGroup } | null = null
  private coefFor = NaN
  private readonly lRef: number
  private readonly tauS: number
  private readonly wallEps: number
  private count = 0

  // particles
  readonly posBuf: GPUBuffer
  readonly velBuf: GPUBuffer
  readonly affBuf: GPUBuffer
  readonly auxBuf: GPUBuffer
  readonly enthalpyBuf: GPUBuffer
  readonly presentationBuffer: GPUBuffer
  // grid
  readonly faceTypeBuf: GPUBuffer
  readonly massBuf: GPUBuffer
  readonly momBuf: GPUBuffer
  readonly massLoBuf: GPUBuffer
  readonly momLoBuf: GPUBuffer
  readonly uBuf: [GPUBuffer, GPUBuffer]
  readonly validBuf: [GPUBuffer, GPUBuffer]
  readonly diagBuf: GPUBuffer
  private readonly paramsBuf: GPUBuffer

  private readonly pipelines: Partial<Record<Kernel, GPUComputePipeline>>
  private projBg: { labelClear: GPUBindGroup; labelParticles: GPUBindGroup; divergence: GPUBindGroup; project: GPUBindGroup } | null = null
  private readonly bg: {
    faceScatter: GPUBindGroup
    gridUpdate: GPUBindGroup
    extrapolate: [GPUBindGroup, GPUBindGroup]   // [A→B, B→A]
    g2pMac: [GPUBindGroup, GPUBindGroup]        // reads A or B
    present: GPUBindGroup
  }

  constructor(device: GPUDevice, opts: FlipSimOptions) {
    this.device = device
    this.layout = new GridLayout({ nx: opts.nx, ny: opts.ny, nz: opts.nz, dx: opts.dx, ring: opts.ring })
    this.maxParticles = opts.maxParticles
    this.gravity = opts.gravity ?? [0, 0, 0]
    this.apic = opts.apic ?? true
    this.extrapolationLayers = opts.extrapolationLayers ?? 2
    this.preciseP2G = opts.preciseP2G ?? true
    this.projection = opts.projection ?? false
    this.density = opts.density ?? 998.2072
    this.pressureTolerance = opts.pressureTolerance ?? 1e-2
    this.solverMethod = opts.solverMethod ?? 'mgpcg'
    this.pressureCap = opts.pressureCap ?? (this.solverMethod === 'mgpcg' ? 18 : 400)
    this.densityProjection = opts.densityProjection ?? false
    if (this.densityProjection && !this.projection) throw new Error('FlipGpuSimulator: densityProjection requires projection')
    this.psiTolerance = opts.psiTolerance ?? 1e-3
    this.psiCap = opts.psiCap ?? (this.solverMethod === 'mgpcg' ? 10 : 200)
    this.massUnit = (opts.rhoRef ?? 1000) * opts.dx ** 3
    this.lRef = opts.lRef
    this.tauS = opts.tauS
    this.wallEps = opts.wallEps ?? 1e-6 * opts.dx
    const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, R = GPUBufferUsage.COPY_SRC
    const buf = (label: string, size: number, usage = S | D | R) => device.createBuffer({ label: `flip.${label}`, size, usage })
    const N = this.maxParticles, G = 3 * this.layout.size
    this.posBuf = buf('pos', 16 * N)
    this.velBuf = buf('vel', 16 * N)
    this.affBuf = buf('aff', 48 * N)
    this.auxBuf = buf('aux', 16 * N)
    this.enthalpyBuf = buf('enthalpy', 8 * N)
    this.presentationBuffer = buf('present', PRESENT_STRIDE_BYTES * N)
    this.faceTypeBuf = buf('faceType', 4 * G)
    this.massBuf = buf('mass', 4 * G)
    this.momBuf = buf('mom', 4 * G)
    this.massLoBuf = buf('massLo', 4 * G)
    this.momLoBuf = buf('momLo', 4 * G)
    this.uBuf = [buf('uA', 4 * G), buf('uB', 4 * G)]
    this.validBuf = [buf('validA', 4 * G), buf('validB', 4 * G)]
    this.diagBuf = buf('diag', 32)
    this.paramsBuf = buf('params', PARAMS_BYTES, GPUBufferUsage.UNIFORM | D)

    const types = new Uint32Array(G)
    for (const a of [0, 1, 2] as const) types.set(this.layout.defaultFaceTypes(a), a * this.layout.size)
    device.queue.writeBuffer(this.faceTypeBuf, 0, types)

    const pipe = (name: Kernel, code: string) => device.createComputePipeline({
      label: `flip.${name}`, layout: 'auto',
      compute: { module: device.createShaderModule({ label: `flip.${name}`, code: `${commonWGSL}\n${code}` }), entryPoint: 'main',
        constants: code.includes('PRECISE_P2G') ? { PRECISE_P2G: this.preciseP2G ? 1 : 0 } : undefined },
    })
    this.pipelines = {
      faceScatter: pipe('faceScatter', faceScatterWGSL),
      gridUpdate: pipe('gridUpdate', gridUpdateWGSL),
      extrapolate: pipe('extrapolate', extrapolateWGSL),
      g2pMac: pipe('g2pMac', g2pMacWGSL),
      present: pipe('present', presentWGSL),
    }
    const group = (k: Kernel, bufs: GPUBuffer[]) => device.createBindGroup({
      label: `flip.${k}`, layout: this.pipelines[k]!.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.paramsBuf } }, ...bufs.map((b, i) => ({ binding: i + 1, resource: { buffer: b } }))],
    })
    const [uA, uB] = this.uBuf, [vA, vB] = this.validBuf
    this.bg = {
      faceScatter: group('faceScatter', [this.posBuf, this.velBuf, this.affBuf, this.massBuf, this.momBuf, this.massLoBuf, this.momLoBuf]),
      gridUpdate: group('gridUpdate', [this.faceTypeBuf, this.massBuf, this.momBuf, uA, vA, this.diagBuf, this.massLoBuf, this.momLoBuf]),
      extrapolate: [
        group('extrapolate', [this.faceTypeBuf, uA, vA, uB, vB]),
        group('extrapolate', [this.faceTypeBuf, uB, vB, uA, vA]),
      ],
      g2pMac: [
        group('g2pMac', [this.posBuf, this.velBuf, this.affBuf, uA, vA, this.diagBuf]),
        group('g2pMac', [this.posBuf, this.velBuf, this.affBuf, uB, vB, this.diagBuf]),
      ],
      present: group('present', [this.posBuf, this.velBuf, this.affBuf, this.auxBuf, this.presentationBuffer]),
    }
    this.resetDiagnostics()
  }

  /** Constructor + (projection) the pressure solver and the projection kernels. */
  static async create(device: GPUDevice, opts: FlipSimOptions): Promise<FlipGpuSimulator> {
    const sim = new FlipGpuSimulator(device, opts)
    if (sim.projection) await sim.initProjection()
    return sim
  }

  private async initProjection(): Promise<void> {
    const L = this.layout, device = this.device
    const solver = await PoissonSolver.create(device, { nx: L.nx, ny: L.ny, nz: L.nz, method: this.solverMethod, label: 'flip.pressure' })
    this.solver = solver
    this.solveCfg = solver.createSolveConfig({ criterion: 'inf', tol: this.pressureTolerance, cap: this.pressureCap })
    const pipe = (name: Kernel, code: string) => device.createComputePipeline({
      label: `flip.${name}`, layout: 'auto',
      compute: { module: device.createShaderModule({ label: `flip.${name}`, code: `${commonWGSL}\n${code}` }), entryPoint: 'main' },
    })
    this.pipelines.labelClear = pipe('labelClear', labelClearWGSL)
    this.pipelines.labelParticles = pipe('labelParticles', labelParticlesWGSL)
    this.pipelines.divergence = pipe('divergence', divergenceWGSL)
    this.pipelines.project = pipe('project', projectWGSL)
    const group = (k: Kernel, bufs: GPUBuffer[]) => device.createBindGroup({
      label: `flip.${k}`, layout: this.pipelines[k]!.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.paramsBuf } }, ...bufs.map((b, i) => ({ binding: i + 1, resource: { buffer: b } }))],
    })
    const sb = solver.buffers, [uA] = this.uBuf, [vA] = this.validBuf
    this.projBg = {
      labelClear: group('labelClear', [sb.labels]),
      labelParticles: group('labelParticles', [this.posBuf, sb.labels]),
      divergence: group('divergence', [this.faceTypeBuf, uA, vA, sb.labels, sb.rhs, this.diagBuf]),
      project: group('project', [this.faceTypeBuf, sb.labels, sb.x, uA, vA]),
    }
    if (!this.densityProjection) return
    const psi = await PoissonSolver.create(device, { nx: L.nx, ny: L.ny, nz: L.nz, method: this.solverMethod, label: 'flip.psi' })
    this.psiSolver = psi
    this.psiCfg = psi.createSolveConfig({ criterion: 'inf', tol: this.psiTolerance, cap: this.psiCap })
    psi.writeUnitCoefficients(1)
    const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, R = GPUBufferUsage.COPY_SRC
    this.vfracBuf = device.createBuffer({ label: 'flip.vfrac', size: 4 * psi.paddedCount, usage: S | D | R })
    this.fCompBuf = device.createBuffer({ label: 'flip.fComp', size: 4 * psi.paddedCount, usage: S | D | R })
    this.dispBuf = device.createBuffer({ label: 'flip.disp', size: 4 * 3 * L.size, usage: S | D | R })
    this.pipelines.cellScatter = pipe('cellScatter', cellScatterWGSL)
    this.pipelines.densityRhs = pipe('densityRhs', densityRhsWGSL)
    this.pipelines.faceDisplacement = pipe('faceDisplacement', faceDisplacementWGSL)
    this.pipelines.positionCorrect = pipe('positionCorrect', positionCorrectWGSL)
    this.densBg = {
      cellScatter: group('cellScatter', [this.posBuf, this.velBuf, this.vfracBuf]),
      densityRhs: group('densityRhs', [this.faceTypeBuf, sb.labels, this.vfracBuf, psi.buffers.rhs, this.fCompBuf]),
      faceDisplacement: group('faceDisplacement', [this.faceTypeBuf, sb.labels, psi.buffers.x, this.dispBuf]),
      positionCorrect: group('positionCorrect', [this.posBuf, this.dispBuf, this.diagBuf]),
    }
  }

  get particleCount(): number { return this.count }
  /** Which ping-pong buffer holds the final grid velocity after extrapolation (0 = A, 1 = B). */
  get finalVelocityBuffer(): 0 | 1 { return (this.extrapolationLayers % 2) as 0 | 1 }

  /** Replace all particles. */
  setParticles(ps: readonly FlipParticleInit[]): void { this.count = 0; this.addParticles(ps) }

  /** Append particles (throws past capacity — never silently clamps). */
  addParticles(ps: readonly FlipParticleInit[]): void {
    if (this.count + ps.length > this.maxParticles) throw new RangeError(`FlipGpuSimulator: ${this.count} + ${ps.length} particles exceed capacity ${this.maxParticles}`)
    const n = ps.length
    const pos = new Float32Array(4 * n), vel = new Float32Array(4 * n), aff = new Float32Array(12 * n)
    const aux = new Uint32Array(4 * n), tBits = new Float32Array(1), tU = new Uint32Array(tBits.buffer)
    ps.forEach((p, i) => {
      pos.set(p.pos, 4 * i)
      vel.set(p.vel, 4 * i); vel[4 * i + 3] = p.mass / this.massUnit
      if (p.c) for (let a = 0; a < 3; a++) aff.set(p.c[a], 12 * i + 4 * a)
      tBits[0] = p.temperatureC
      aux.set([p.composition >>> 0, p.phase >>> 0, tU[0], 0], 4 * i)
    })
    const q = this.device.queue, o = this.count
    q.writeBuffer(this.posBuf, 16 * o, pos)
    q.writeBuffer(this.velBuf, 16 * o, vel)
    q.writeBuffer(this.affBuf, 48 * o, aff)
    q.writeBuffer(this.auxBuf, 16 * o, aux)
    q.writeBuffer(this.enthalpyBuf, 8 * o, new Uint32Array(2 * n))
    this.count += n
  }

  /** Upload the per-call uniforms (once per step() call — FINAL-PLAN §5.1). */
  writeParams(): void {
    const b = new ArrayBuffer(PARAMS_BYTES), f = new Float32Array(b), i = new Int32Array(b), u = new Uint32Array(b)
    const L = this.layout
    i.set([L.nx, L.ny, L.nz], 0); u[3] = this.count
    i.set(L.ring, 4); u[7] = this.apic ? 1 : 0
    f.set(this.gravity, 8); f[11] = L.dx
    f.set(L.extent, 12); f[15] = this.dt
    f[16] = 1 / this.massUnit; f[17] = MASS_SCALE; f[18] = MOM_SCALE; f[19] = this.wallEps
    f[20] = this.lRef; f[21] = this.tauS; u[22] = L.size; f[23] = this.density
    this.device.queue.writeBuffer(this.paramsBuf, 0, b)
    // a_f = Δt/(ρ·dx²) on every face (uniform until S3.5); rewritten only when Δt changes
    const coef = this.dt / (this.density * L.dx * L.dx)
    if (this.solver && coef !== this.coefFor) { this.solver.writeUnitCoefficients(coef); this.coefFor = coef }
  }

  // ── kernels (each encodable alone, for the kernel-by-kernel self-test) ─────────────────────────────────────

  private dispatch(encoder: GPUCommandEncoder, k: Kernel, bg: GPUBindGroup, threads: number, wg: number): void {
    const pipeline = this.pipelines[k]
    if (!pipeline) throw new Error(`FlipGpuSimulator: kernel ${k} not created`)
    const pass = encoder.beginComputePass({ label: `flip.${k}` })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bg)
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(threads / wg)))
    pass.end()
  }

  encodeScatter(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.massBuf)
    encoder.clearBuffer(this.momBuf)
    if (this.preciseP2G) { encoder.clearBuffer(this.massLoBuf); encoder.clearBuffer(this.momLoBuf) }
    if (this.count > 0) this.dispatch(encoder, 'faceScatter', this.bg.faceScatter, this.count, 64)
  }
  encodeGridUpdate(encoder: GPUCommandEncoder): void {
    this.dispatch(encoder, 'gridUpdate', this.bg.gridUpdate, 3 * this.layout.size, 256)
  }
  encodeExtrapolate(encoder: GPUCommandEncoder): void {
    for (let layer = 0; layer < this.extrapolationLayers; layer++) {
      this.dispatch(encoder, 'extrapolate', this.bg.extrapolate[layer % 2], 3 * this.layout.size, 256)
    }
  }
  encodeG2P(encoder: GPUCommandEncoder): void {
    if (this.count > 0) this.dispatch(encoder, 'g2pMac', this.bg.g2pMac[this.finalVelocityBuffer], this.count, 64)
  }
  /** One substep after the density correction: P2G, grid update, (projection), extrapolation, G2P + advection. */
  encodeSubstepBody(encoder: GPUCommandEncoder): void {
    this.encodeScatter(encoder)
    this.encodeGridUpdate(encoder)
    if (this.projection) this.encodeProjection(encoder)
    this.encodeExtrapolate(encoder)
    this.encodeG2P(encoder)
  }

  /** Voxel labels, divergence, pressure solve (warm-started), projection (S3.1b). */
  encodeProjection(encoder: GPUCommandEncoder): void {
    this.encodeLabels(encoder)
    this.encodeDivergence(encoder)
    this.encodePressureSolve(encoder)
    this.encodeProject(encoder)
  }

  private proj() {
    if (!this.projBg || !this.solver || !this.solveCfg) throw new Error('FlipGpuSimulator: projection not initialised (use FlipGpuSimulator.create)')
    return { bg: this.projBg, solver: this.solver, cfg: this.solveCfg, cells: this.layout.nx * this.layout.ny * this.layout.nz }
  }
  encodeLabels(encoder: GPUCommandEncoder): void {
    const { bg, cells } = this.proj()
    this.dispatch(encoder, 'labelClear', bg.labelClear, cells, 256)
    if (this.count > 0) this.dispatch(encoder, 'labelParticles', bg.labelParticles, this.count, 64)
  }
  encodeDivergence(encoder: GPUCommandEncoder): void {
    const { bg, cells } = this.proj()
    this.dispatch(encoder, 'divergence', bg.divergence, cells, 256)
  }
  encodePressureSolve(encoder: GPUCommandEncoder, cfg?: SolveConfig): void {
    const p = this.proj()
    p.solver.encodePrepare(encoder)
    p.solver.encodeSolve(encoder, cfg ?? p.cfg, { warmStart: true })
  }
  encodeProject(encoder: GPUCommandEncoder): void {
    const { bg } = this.proj()
    this.dispatch(encoder, 'project', bg.project, 3 * this.layout.size, 256)
  }

  /** Kugelstadt density projection (S3.2): labels (pre-correction occupancy), volume fraction, ψ solve (cold),
   *  face displacements, particle positions corrected — velocities untouched. */
  encodeDensityCorrection(encoder: GPUCommandEncoder): void {
    this.encodeLabels(encoder)
    this.encodeCellScatter(encoder)
    this.encodeDensityRhs(encoder)
    this.encodePsiSolve(encoder)
    this.encodeFaceDisplacement(encoder)
    this.encodePositionCorrect(encoder)
  }

  private dens() {
    if (!this.densBg || !this.psiSolver || !this.psiCfg || !this.vfracBuf || !this.solver) throw new Error('FlipGpuSimulator: density projection not initialised')
    return { bg: this.densBg, psi: this.psiSolver, cfg: this.psiCfg, vfrac: this.vfracBuf, solver: this.solver, cells: this.layout.nx * this.layout.ny * this.layout.nz }
  }
  encodeCellScatter(encoder: GPUCommandEncoder): void {
    const d = this.dens()
    encoder.clearBuffer(d.vfrac)
    if (this.count > 0) this.dispatch(encoder, 'cellScatter', d.bg.cellScatter, this.count, 64)
  }
  encodeDensityRhs(encoder: GPUCommandEncoder): void {
    const d = this.dens()
    this.dispatch(encoder, 'densityRhs', d.bg.densityRhs, d.cells, 256)
    // the ψ operator is assembled from ITS labels: the same pre-correction voxel labels (level 0 region)
    encoder.copyBufferToBuffer(d.solver.buffers.labels, 0, d.psi.buffers.labels, 0, 4 * d.psi.paddedCount)
  }
  encodePsiSolve(encoder: GPUCommandEncoder): void {
    const d = this.dens()
    d.psi.encodePrepare(encoder)
    d.psi.encodeSolve(encoder, d.cfg, { warmStart: false })
  }
  encodeFaceDisplacement(encoder: GPUCommandEncoder): void {
    const d = this.dens()
    this.dispatch(encoder, 'faceDisplacement', d.bg.faceDisplacement, 3 * this.layout.size, 256)
  }
  encodePositionCorrect(encoder: GPUCommandEncoder): void {
    const d = this.dens()
    if (this.count > 0) this.dispatch(encoder, 'positionCorrect', d.bg.positionCorrect, this.count, 64)
  }

  encodePresent(encoder: GPUCommandEncoder): void {
    if (this.count > 0) this.dispatch(encoder, 'present', this.bg.present, this.count, 64)
  }

  /** `substeps` full transfer substeps of `dt` s each, then the presentation copy. */
  step(encoder: GPUCommandEncoder, substeps = 1): void {
    this.writeParams()
    for (let s = 0; s < substeps; s++) {
      if (this.densityProjection) this.encodeDensityCorrection(encoder)
      this.encodeSubstepBody(encoder)
    }
    this.encodePresent(encoder)
  }

  // ── readback (tests, benches) ───────────────────────────────────────────────────────────────────────────────

  async readBuffer(src: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: Math.max(4, bytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    try {
      const enc = this.device.createCommandEncoder()
      enc.copyBufferToBuffer(src, 0, staging, 0, Math.max(4, bytes))
      this.device.queue.submit([enc.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      return staging.getMappedRange().slice(0, bytes)
    } finally {
      staging.destroy()
    }
  }

  async readParticles(): Promise<{ pos: Float32Array; vel: Float32Array; aff: Float32Array }> {
    const n = this.count
    return {
      pos: new Float32Array(await this.readBuffer(this.posBuf, 16 * n)),
      vel: new Float32Array(await this.readBuffer(this.velBuf, 16 * n)),
      aff: new Float32Array(await this.readBuffer(this.affBuf, 48 * n)),
    }
  }

  async readGrid(which: 0 | 1 = 0): Promise<{ mass: Int32Array; mom: Int32Array; massLo: Int32Array; momLo: Int32Array; u: Float32Array; valid: Uint32Array }> {
    const G = 3 * this.layout.size
    return {
      mass: new Int32Array(await this.readBuffer(this.massBuf, 4 * G)),
      mom: new Int32Array(await this.readBuffer(this.momBuf, 4 * G)),
      massLo: new Int32Array(await this.readBuffer(this.massLoBuf, 4 * G)),
      momLo: new Int32Array(await this.readBuffer(this.momLoBuf, 4 * G)),
      u: new Float32Array(await this.readBuffer(this.uBuf[which], 4 * G)),
      valid: new Uint32Array(await this.readBuffer(this.validBuf[which], 4 * G)),
    }
  }

  /** Overwrite grid inputs (kernel self-test: every kernel runs on the reference's exact inputs). */
  writeGrid(which: 0 | 1, data: { mass?: Int32Array<ArrayBuffer>; mom?: Int32Array<ArrayBuffer>; u?: Float32Array<ArrayBuffer>; valid?: Uint32Array<ArrayBuffer> }): void {
    const q = this.device.queue
    if (data.mass) q.writeBuffer(this.massBuf, 0, data.mass)
    if (data.mom) q.writeBuffer(this.momBuf, 0, data.mom)
    if (data.u) q.writeBuffer(this.uBuf[which], 0, data.u)
    if (data.valid) q.writeBuffer(this.validBuf[which], 0, data.valid)
  }

  resetDiagnostics(): void {
    this.device.queue.writeBuffer(this.diagBuf, 0, new Uint32Array(8))
    if (this.solver) this.device.queue.writeBuffer(this.solver.buffers.faults, 0, new Uint32Array(4))
    if (this.psiSolver) this.device.queue.writeBuffer(this.psiSolver.buffers.faults, 0, new Uint32Array(4))
  }

  async readDiagnostics(): Promise<FlipDiagnostics> {
    const d = new Uint32Array(await this.readBuffer(this.diagBuf, 32))
    const f = this.solver ? await this.solver.readFaults() : null
    const g = this.psiSolver ? await this.psiSolver.readFaults() : null
    return { wallClamps: d[0], unsetFaceReads: d[1], openFaces: d[2], unsetDivergenceFaces: d[3], densityClamps: d[4],
      solves: f?.solves ?? 0, capHits: f?.capHits ?? 0, breakdowns: f?.breakdowns ?? 0, maxIterations: f?.maxIterations ?? 0,
      psiSolves: g?.solves ?? 0, psiCapHits: g?.capHits ?? 0, psiBreakdowns: g?.breakdowns ?? 0, psiMaxIterations: g?.maxIterations ?? 0 }
  }

  /** Pressure (Pa) and labels in the solver's padded layout: index (i+1) + (nx+2)·((j+1) + (ny+2)·(k+1)). */
  async readPressure(): Promise<{ pressure: Float32Array; labels: Uint32Array }> {
    if (!this.solver) throw new Error('no projection')
    return { pressure: await this.solver.readVector('x'), labels: await this.solver.readLabels(0) }
  }

  destroy(): void {
    for (const b of [this.posBuf, this.velBuf, this.affBuf, this.auxBuf, this.enthalpyBuf, this.presentationBuffer, this.faceTypeBuf,
      this.massBuf, this.momBuf, this.massLoBuf, this.momLoBuf, ...this.uBuf, ...this.validBuf, this.diagBuf, this.paramsBuf]) b.destroy()
    this.solver?.destroy()
    this.psiSolver?.destroy()
    for (const b of [this.vfracBuf, this.fCompBuf, this.dispBuf]) b?.destroy()
  }
}
