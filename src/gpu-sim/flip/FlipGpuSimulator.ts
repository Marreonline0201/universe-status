/// <reference types="@webgpu/types" />
// FlipGpuSimulator — the incompressible APIC-MAC liquid solver on WebGPU (FINAL-PLAN S3).
// Stages implemented, each diffed kernel by kernel against the f64 CPU reference src/sim-ref/flipRef.ts:
//   S3.1a transfers: faceScatter → gridUpdate → extrapolate ×2 → g2pMac + RK2          (gate s31a-gpu.mjs)
//   S3.1b projection (`projection: true`, create()): labelClear → labelParticles (voxel free surface) → divergence
//         → PoissonSolver (JPCG until S3.3) → project, between gridUpdate and extrapolate  (gate s31b-gpu.mjs)
//   S3.4 ghost-fluid free surface (`freeSurface: 'ghost'`): lsScatter → lsFinalize (Zhu & Bridson φ, LIQUID where φ < 0)
//         → occupancy + lsResolve (a particle-holding φ ≥ 0 cell whose interface φ does not resolve becomes LIQUID)
//         → ghostCoef (a/θ at liquid–air faces) replace the voxel labels of the pressure solve; project uses the ghost
//         pressure. The density correction keeps the voxel labels (FINAL-PLAN §5.2 step 3)        (gate s34-gpu.mjs)
//   S3.2 density projection (`densityProjection: true`), before faceScatter: labels → cellScatter → densityRhs →
//         ψ solve (second PoissonSolver, unit coefficients, cold) → faceDisplacement → positionCorrect  (gate s32-gpu.mjs)
//   S3.1c-2 the drop ball (setSphere; ghost surface only): sphereAdvance (solid first, non-penetrating walls) →
//         sphereFaces / sphereCells (2×2×2-supersampled solid fractions, Batty 2007 eq. 10) → psiCoef → density
//         correction (ball kernel volume in f̃, push-out) → … labels extended into the ball (sphereExtendMark/Commit ×2) →
//         ghostCoef → sphereCoef (fluid-fraction weights 1 − S_f, eqs. 4–7) → divergence with the flux (1 − S)u + S·V →
//         solve → project (unweighted coefficients) → sphereFaceVel (S ≥ 1 faces take V) → sphereForce (J·p, eqs.
//         8–10) → sphereIntegrate (weak coupling V += Δt(g + F/M), s ≥ 1). All state on the GPU (FINAL-PLAN S3.1c).
//   S3.5 variable density (`variableDensity: true`): faceScatter also sums Σw; ghostCoef forms each face's density
//         ρ_f = ρ_ref·ppc·m̂_f/Σw and writes a_f = Δt/(ρ_f·dx²) (voxel or ghost surface); project reads the same a_f.
//         Particles must carry m = ρ_material·dx³/ppc                                            (gate s35-gpu.mjs)
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
import lsScatterWGSL from './shaders/lsScatter.wgsl?raw'
import lsFinalizeWGSL from './shaders/lsFinalize.wgsl?raw'
import lsResolveWGSL from './shaders/lsResolve.wgsl?raw'
import ghostCoefWGSL from './shaders/ghostCoef.wgsl?raw'
import sphereAdvanceWGSL from './shaders/sphereAdvance.wgsl?raw'
import sphereFacesWGSL from './shaders/sphereFaces.wgsl?raw'
import sphereCellsWGSL from './shaders/sphereCells.wgsl?raw'
import sphereExtendMarkWGSL from './shaders/sphereExtendMark.wgsl?raw'
import sphereExtendCommitWGSL from './shaders/sphereExtendCommit.wgsl?raw'
import sphereCoefWGSL from './shaders/sphereCoef.wgsl?raw'
import sphereFaceVelWGSL from './shaders/sphereFaceVel.wgsl?raw'
import sphereForceWGSL from './shaders/sphereForce.wgsl?raw'
import sphereIntegrateWGSL from './shaders/sphereIntegrate.wgsl?raw'
import psiCoefWGSL from './shaders/psiCoef.wgsl?raw'
import { PoissonSolver, type SolveConfig, type SolverMethod } from './poisson/PoissonSolver'
import { FACE_WEIGHT_MIN, THETA_MIN } from '../../sim-ref/flipRef'

/** Fixed-point scales (FINAL-PLAN §5.7): mass in ρ_ref·dx³ at 2^24 (range ±128), momentum at 2^19 (±4096). */
export const MASS_SCALE = 2 ** 24
export const MOM_SCALE = 2 ** 19
/** Legacy presentation layout: 20 words per particle. */
export const PRESENT_STRIDE_BYTES = 80
const PARAMS_BYTES = 128
/** u32 words of the diagnostics buffer (common.wgsl DIAG_*: 0–9). */
const DIAG_WORDS = 10
/** f32 words of the sphere state (common.wgsl SPH_*). */
const SPHERE_WORDS = 16

/** The drop ball handed to the solver, window-local SI: a free ball integrates with weak two-way coupling (density
 *  kg/m³, FINAL-PLAN S3.1c: s ≥ 1 only); density 0 = scripted (moves with the given velocity, no integration). */
export interface FlipSphere { center: Vec3; radius: number; velocity: Vec3; density: number }
/** The ball as the GPU last left it: after sphereIntegrate, the force of the last projection and its V_J. */
export interface FlipSphereState { center: Vec3; radius: number; velocity: Vec3; active: boolean; force: Vec3; volumeJ: number }

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
  /** Liquid density, kg/m³: every face's density without variableDensity, the last-resort fallback with it. Default water
   *  at 20 °C (NIST). */
  density?: number
  /** S3.5 per-face density from the particles' masses (FINAL-PLAN §5.3 "face density"). Default false. */
  variableDensity?: boolean
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
  /** Free surface of the pressure solve: 'voxel' (S3.1b) or 'ghost' (S3.4 Zhu & Bridson level set + ghost fluid). */
  freeSurface?: 'voxel' | 'ghost'
  /** Particles per cell of the rest packing (level-set spacing s = dx/∛ppc; R = 2s, r̄ = s/2). Default 8. */
  ppc?: number
  /** Lower clamp of θ (default THETA_MIN = 1e-2, the measured G0-e choice; flipRef). */
  thetaMin?: number
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
  /** S3.5 face-density fallbacks: neighbour mean (Σw < wMin), and default density (no neighbour either). */
  densityNeighbourFaces: number; densityDefaultFaces: number
  /** Ghost labels: particle-holding cells with φ ≥ 0 made LIQUID because φ does not resolve their interface (lsResolve). */
  unresolvedRelabels: number
  /** Particles pushed out of the drop ball (advection + density correction). */
  spherePushOuts: number
  /** ψ solver sticky faults (0 without density projection). */
  psiSolves: number; psiCapHits: number; psiBreakdowns: number; psiMaxIterations: number
  /** Pressure solver sticky faults since the last reset (0 without projection). */
  solves: number; capHits: number; breakdowns: number; maxIterations: number
}

type Kernel = 'faceScatter' | 'gridUpdate' | 'extrapolate' | 'g2pMac' | 'present' | 'labelClear' | 'labelParticles' | 'divergence' | 'project'
  | 'cellScatter' | 'densityRhs' | 'faceDisplacement' | 'positionCorrect' | 'lsScatter' | 'lsFinalize' | 'lsResolve' | 'ghostCoef'
  | 'sphereAdvance' | 'sphereFaces' | 'sphereCells' | 'sphereExtendMark' | 'sphereExtendCommit' | 'sphereCoef' | 'sphereFaceVel'
  | 'sphereForce' | 'sphereIntegrate' | 'psiCoef'

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
  readonly freeSurface: 'voxel' | 'ghost'
  readonly variableDensity: boolean
  readonly ppc: number
  readonly thetaMin: number
  /** Level-set buffers (projection only): sums at cell centres (4 i32 per padded cell) and face centres (4 i32 per face
   *  slot, three grids), φ at cell centres (f32, padded layout, m). */
  lsCellBuf: GPUBuffer | null = null
  lsFaceBuf: GPUBuffer | null = null
  phiCellBuf: GPUBuffer | null = null
  /** Ghost labels: 1 in every cell holding a particle (labelParticles into its own buffer), read by lsResolve. */
  occBuf: GPUBuffer | null = null
  private lsBg: { lsScatter: GPUBindGroup; lsFinalize: GPUBindGroup; occupancy: GPUBindGroup; lsResolve: GPUBindGroup; ghostCoef: GPUBindGroup } | null = null
  /** S3.1c-2 drop ball: state (SPHERE_WORDS f32), per-face solid fraction (three grids), per-cell (fraction, kernel
   *  volume) in the solver layout, ghostCoef's unweighted coefficients (project reads them), the force accumulator. */
  readonly sphereBuf: GPUBuffer
  readonly faceSolidBuf: GPUBuffer
  cellSolidBuf: GPUBuffer | null = null
  faceCoefRawBuf: GPUBuffer | null = null
  forceAccBuf: GPUBuffer | null = null
  private sphereActive = false
  private sphereBg: Partial<Record<'sphereAdvance' | 'sphereFaces' | 'sphereCells' | 'sphereExtendMark' | 'sphereExtendCommit' | 'sphereCoef'
    | 'sphereFaceVel' | 'sphereForce' | 'sphereIntegrate' | 'psiCoef' | 'projectRaw', GPUBindGroup>> = {}
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
  /** Σw per face (i32 at MASS_SCALE), for the S3.5 face density. */
  readonly weightBuf: GPUBuffer
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
    this.freeSurface = opts.freeSurface ?? 'voxel'
    this.variableDensity = opts.variableDensity ?? false
    if (this.variableDensity && !this.projection) throw new Error('FlipGpuSimulator: variableDensity requires projection')
    this.ppc = opts.ppc ?? 8
    this.thetaMin = opts.thetaMin ?? THETA_MIN
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
    this.weightBuf = buf('weight', 4 * G)
    this.uBuf = [buf('uA', 4 * G), buf('uB', 4 * G)]
    this.validBuf = [buf('validA', 4 * G), buf('validB', 4 * G)]
    this.diagBuf = buf('diag', 4 * DIAG_WORDS)
    this.sphereBuf = buf('sphere', 4 * SPHERE_WORDS)
    this.faceSolidBuf = buf('faceSolid', 4 * G)
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
      faceScatter: group('faceScatter', [this.posBuf, this.velBuf, this.affBuf, this.massBuf, this.momBuf, this.massLoBuf, this.momLoBuf, this.weightBuf]),
      gridUpdate: group('gridUpdate', [this.faceTypeBuf, this.massBuf, this.momBuf, uA, vA, this.diagBuf, this.massLoBuf, this.momLoBuf]),
      extrapolate: [
        group('extrapolate', [this.faceTypeBuf, uA, vA, uB, vB]),
        group('extrapolate', [this.faceTypeBuf, uB, vB, uA, vA]),
      ],
      g2pMac: [
        group('g2pMac', [this.posBuf, this.velBuf, this.affBuf, uA, vA, this.diagBuf, this.sphereBuf]),
        group('g2pMac', [this.posBuf, this.velBuf, this.affBuf, uB, vB, this.diagBuf, this.sphereBuf]),
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
      compute: { module: device.createShaderModule({ label: `flip.${name}`, code: `${commonWGSL}\n${code}` }), entryPoint: 'main',
        constants: code.includes('PRECISE_P2G') ? { PRECISE_P2G: this.preciseP2G ? 1 : 0 } : undefined },
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
    const Sg = GPUBufferUsage.STORAGE, Dg = GPUBufferUsage.COPY_DST, Rg = GPUBufferUsage.COPY_SRC
    this.lsCellBuf = device.createBuffer({ label: 'flip.lsCell', size: 16 * solver.paddedCount, usage: Sg | Dg | Rg })
    this.lsFaceBuf = device.createBuffer({ label: 'flip.lsFace', size: 16 * 3 * L.size, usage: Sg | Dg | Rg })
    this.phiCellBuf = device.createBuffer({ label: 'flip.phiCell', size: 4 * solver.paddedCount, usage: Sg | Dg | Rg })
    this.occBuf = device.createBuffer({ label: 'flip.occupancy', size: 4 * solver.paddedCount, usage: Sg | Dg | Rg })
    this.cellSolidBuf = device.createBuffer({ label: 'flip.cellSolid', size: 8 * solver.paddedCount, usage: Sg | Dg | Rg })
    this.faceCoefRawBuf = device.createBuffer({ label: 'flip.faceCoefRaw', size: 16 * solver.paddedCount, usage: Sg | Dg | Rg })
    this.forceAccBuf = device.createBuffer({ label: 'flip.sphereForce', size: 16, usage: Sg | Dg | Rg })
    this.pipelines.lsScatter = pipe('lsScatter', lsScatterWGSL)
    this.pipelines.lsFinalize = pipe('lsFinalize', lsFinalizeWGSL)
    this.pipelines.lsResolve = pipe('lsResolve', lsResolveWGSL)
    for (const [k, code] of [['sphereAdvance', sphereAdvanceWGSL], ['sphereFaces', sphereFacesWGSL], ['sphereCells', sphereCellsWGSL],
      ['sphereExtendMark', sphereExtendMarkWGSL], ['sphereExtendCommit', sphereExtendCommitWGSL], ['sphereCoef', sphereCoefWGSL],
      ['sphereFaceVel', sphereFaceVelWGSL], ['sphereForce', sphereForceWGSL], ['sphereIntegrate', sphereIntegrateWGSL]] as const) this.pipelines[k] = pipe(k, code)
    this.pipelines.ghostCoef = pipe('ghostCoef', ghostCoefWGSL)
    this.projBg = {
      labelClear: group('labelClear', [sb.labels]),
      labelParticles: group('labelParticles', [this.posBuf, sb.labels]),
      divergence: group('divergence', [this.faceTypeBuf, uA, vA, sb.labels, sb.rhs, this.diagBuf, this.faceSolidBuf, this.sphereBuf]),
      project: group('project', [this.faceTypeBuf, sb.labels, sb.x, uA, vA, this.phiCellBuf, this.lsFaceBuf, sb.faceCoef]),
    }
    this.lsBg = {
      lsScatter: group('lsScatter', [this.posBuf, this.lsCellBuf, this.lsFaceBuf]),
      lsFinalize: group('lsFinalize', [this.lsCellBuf, this.phiCellBuf, sb.labels]),
      occupancy: group('labelParticles', [this.posBuf, this.occBuf]),
      lsResolve: group('lsResolve', [this.phiCellBuf, this.occBuf, sb.labels, this.diagBuf, this.cellSolidBuf]),
      ghostCoef: group('ghostCoef', [sb.labels, this.phiCellBuf, this.lsFaceBuf, sb.faceCoef, this.massBuf, this.massLoBuf, this.weightBuf, this.diagBuf]),
    }
    this.sphereBg = {
      sphereAdvance: group('sphereAdvance', [this.sphereBuf]),
      sphereFaces: group('sphereFaces', [this.sphereBuf, this.faceSolidBuf]),
      sphereCells: group('sphereCells', [this.sphereBuf, this.cellSolidBuf]),
      sphereExtendMark: group('sphereExtendMark', [this.cellSolidBuf, sb.labels]),
      sphereExtendCommit: group('sphereExtendCommit', [sb.labels]),
      sphereCoef: group('sphereCoef', [sb.labels, this.phiCellBuf, this.lsFaceBuf, this.faceCoefRawBuf, sb.faceCoef, this.faceSolidBuf]),
      sphereFaceVel: group('sphereFaceVel', [this.faceTypeBuf, this.faceSolidBuf, this.sphereBuf, uA, vA]),
      sphereForce: group('sphereForce', [this.faceTypeBuf, sb.labels, sb.x, this.faceSolidBuf, this.forceAccBuf]),
      sphereIntegrate: group('sphereIntegrate', [this.sphereBuf, this.forceAccBuf]),
      projectRaw: group('project', [this.faceTypeBuf, sb.labels, sb.x, uA, vA, this.phiCellBuf, this.lsFaceBuf, this.faceCoefRawBuf]),
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
      cellScatter: group('cellScatter', [this.posBuf, this.vfracBuf]),
      densityRhs: group('densityRhs', [this.faceTypeBuf, sb.labels, this.vfracBuf, psi.buffers.rhs, this.fCompBuf, this.cellSolidBuf!, this.faceSolidBuf]),
      faceDisplacement: group('faceDisplacement', [this.faceTypeBuf, sb.labels, psi.buffers.x, this.dispBuf]),
      positionCorrect: group('positionCorrect', [this.posBuf, this.dispBuf, this.diagBuf, this.sphereBuf]),
    }
    this.pipelines.psiCoef = pipe('psiCoef', psiCoefWGSL)
    this.sphereBg.psiCoef = group('psiCoef', [this.faceSolidBuf, psi.buffers.faceCoef])
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
    const sp = L.dx / Math.cbrt(this.ppc)
    f[24] = 2 * sp; f[25] = sp / 2; f[26] = this.thetaMin; u[27] = this.freeSurface === 'ghost' ? 1 : 0
    f[28] = (this.massUnit / L.dx ** 3) * this.ppc; u[29] = this.variableDensity ? 1 : 0; f[30] = FACE_WEIGHT_MIN; f[31] = 1 / this.ppc
    this.device.queue.writeBuffer(this.paramsBuf, 0, b)
    // a_f = Δt/(ρ·dx²) on every face for the voxel, one-density path (ghostCoef rewrites faceCoef every substep in the
    // ghost and variable-density paths); rewritten only when Δt changes
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
    encoder.clearBuffer(this.weightBuf)
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
    this.encodePressureLabels(encoder)
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
  /** Labels of the pressure solve and the operator's face coefficients: voxel labels (S3.1b) or the ghost-fluid level set
   *  (S3.4); ghostCoef writes a_f (and the ghost extra diagonal) whenever the surface is ghost or the density varies
   *  (S3.5) — the voxel one-density path keeps the uniform coefficients from writeParams. */
  encodePressureLabels(encoder: GPUCommandEncoder): void {
    const { cells } = this.proj()
    if (this.freeSurface !== 'ghost') {
      this.encodeLabels(encoder)
      if (this.variableDensity) this.dispatch(encoder, 'ghostCoef', this.lsBg!.ghostCoef, cells, 256)
      return
    }
    if (!this.lsBg || !this.lsCellBuf || !this.lsFaceBuf) throw new Error('FlipGpuSimulator: level set not initialised')
    encoder.clearBuffer(this.lsCellBuf)
    encoder.clearBuffer(this.lsFaceBuf)
    if (this.count > 0) this.dispatch(encoder, 'lsScatter', this.lsBg.lsScatter, this.count, 64)
    this.dispatch(encoder, 'lsFinalize', this.lsBg.lsFinalize, cells, 256)
    // particle-holding cells with φ ≥ 0 whose interface φ does not resolve become LIQUID (flipRef.classifyLevelSet)
    encoder.clearBuffer(this.occBuf!)
    if (this.count > 0) this.dispatch(encoder, 'labelParticles', this.lsBg.occupancy, this.count, 64)
    this.dispatch(encoder, 'lsResolve', this.lsBg.lsResolve, cells, 256)
    if (this.sphereActive) {
      // the liquid extended into the ball (two passes, flipRef.extendLiquidIntoSphere)
      for (let pass = 0; pass < 2; pass++) {
        this.dispatch(encoder, 'sphereExtendMark', this.sphereBg.sphereExtendMark!, cells, 256)
        this.dispatch(encoder, 'sphereExtendCommit', this.sphereBg.sphereExtendCommit!, cells, 256)
      }
    }
    this.dispatch(encoder, 'ghostCoef', this.lsBg.ghostCoef, cells, 256)
    if (this.sphereActive) {
      encoder.copyBufferToBuffer(this.solver!.buffers.faceCoef, 0, this.faceCoefRawBuf!, 0, 16 * this.solver!.paddedCount)
      this.dispatch(encoder, 'sphereCoef', this.sphereBg.sphereCoef!, cells, 256)
    }
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
    // with the ball the operator's faceCoef carries the fluid-fraction weights; the velocity update reads ghostCoef's
    // unweighted copy (u −= Δt/(ρ_f·dx)·Δp on every face with 0 < S < 1, as flipRef.projectVelocities)
    this.dispatch(encoder, 'project', this.sphereActive ? this.sphereBg.projectRaw! : bg.project, 3 * this.layout.size, 256)
    if (this.sphereActive) {
      this.dispatch(encoder, 'sphereFaceVel', this.sphereBg.sphereFaceVel!, 3 * this.layout.size, 256)
      encoder.clearBuffer(this.forceAccBuf!)
      this.dispatch(encoder, 'sphereForce', this.sphereBg.sphereForce!, 3 * this.layout.size, 256)
      this.dispatch(encoder, 'sphereIntegrate', this.sphereBg.sphereIntegrate!, 1, 1)
    }
  }

  /** The substep's start with a ball: move it (solid first), then its solid fractions and the ψ weights. */
  encodeSphereStart(encoder: GPUCommandEncoder): void {
    if (!this.sphereActive) return
    const cells = this.layout.nx * this.layout.ny * this.layout.nz
    this.dispatch(encoder, 'sphereAdvance', this.sphereBg.sphereAdvance!, 1, 1)
    this.encodeSphereFractions(encoder)
    if (this.sphereBg.psiCoef) this.dispatch(encoder, 'psiCoef', this.sphereBg.psiCoef, cells, 256)
  }
  /** Solid fractions of the ball where it is now (faces and cells), without moving it — parity tests use this alone. */
  encodeSphereFractions(encoder: GPUCommandEncoder): void {
    const cells = this.layout.nx * this.layout.ny * this.layout.nz
    this.dispatch(encoder, 'sphereFaces', this.sphereBg.sphereFaces!, 3 * this.layout.size, 256)
    this.dispatch(encoder, 'sphereCells', this.sphereBg.sphereCells!, cells, 256)
  }

  /** Place the drop ball (S3.1c-2). Requires the projection with the ghost-fluid surface (the weights enter the ghost
   *  coefficients). A free ball needs density ≥ that of the liquid it is in (FINAL-PLAN S3.1c: weak coupling, s ≥ 1);
   *  the caller enforces that, this class only integrates. */
  setSphere(sp: FlipSphere): void {
    if (!this.projection || this.freeSurface !== 'ghost' || !this.cellSolidBuf) throw new Error('FlipGpuSimulator.setSphere: needs projection with the ghost-fluid surface')
    const w = new Float32Array(SPHERE_WORDS)
    w.set(sp.center, 0); w[3] = sp.radius; w.set(sp.velocity, 4); w[7] = 1; w[8] = sp.density
    this.device.queue.writeBuffer(this.sphereBuf, 0, w)
    this.sphereActive = true
  }
  /** Overwrite the ball's velocity (a scripted ball's next substeps move with it). */
  setSphereVelocity(v: Vec3): void { this.device.queue.writeBuffer(this.sphereBuf, 16, new Float32Array(v)) }
  /** Remove the ball: zero state and fractions, unit ψ coefficients again. */
  clearSphere(): void {
    this.sphereActive = false
    this.device.queue.writeBuffer(this.sphereBuf, 0, new Float32Array(SPHERE_WORDS))
    const e = this.device.createCommandEncoder()
    e.clearBuffer(this.faceSolidBuf)
    if (this.cellSolidBuf) e.clearBuffer(this.cellSolidBuf)
    this.device.queue.submit([e.finish()])
    this.psiSolver?.writeUnitCoefficients(1)
  }
  get hasSphere(): boolean { return this.sphereActive }
  /** The ball's state as the GPU last left it (tests; the page copies sphereBuf into its own staging ring). */
  async readSphere(): Promise<FlipSphereState> {
    const w = new Float32Array(await this.readBuffer(this.sphereBuf, 4 * SPHERE_WORDS))
    return { center: [w[0], w[1], w[2]], radius: w[3], velocity: [w[4], w[5], w[6]], active: w[7] > 0.5, force: [w[9], w[10], w[11]], volumeJ: w[12] }
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
      this.encodeSphereStart(encoder)
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
    this.device.queue.writeBuffer(this.diagBuf, 0, new Uint32Array(DIAG_WORDS))
    if (this.solver) this.device.queue.writeBuffer(this.solver.buffers.faults, 0, new Uint32Array(4))
    if (this.psiSolver) this.device.queue.writeBuffer(this.psiSolver.buffers.faults, 0, new Uint32Array(4))
  }

  async readDiagnostics(): Promise<FlipDiagnostics> {
    const d = new Uint32Array(await this.readBuffer(this.diagBuf, 4 * DIAG_WORDS))
    const f = this.solver ? await this.solver.readFaults() : null
    const g = this.psiSolver ? await this.psiSolver.readFaults() : null
    return { wallClamps: d[0], unsetFaceReads: d[1], openFaces: d[2], unsetDivergenceFaces: d[3], densityClamps: d[4],
      densityNeighbourFaces: d[5], densityDefaultFaces: d[6], unresolvedRelabels: d[8], spherePushOuts: d[9],
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
    for (const b of [this.vfracBuf, this.fCompBuf, this.dispBuf, this.lsCellBuf, this.lsFaceBuf, this.phiCellBuf, this.occBuf,
      this.cellSolidBuf, this.faceCoefRawBuf, this.forceAccBuf, this.sphereBuf, this.faceSolidBuf]) b?.destroy()
  }
}
