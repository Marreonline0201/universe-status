// f64 CPU reference of the incompressible APIC-MAC solver (FINAL-PLAN S3.0). Every GPU kernel of S3 is diffed
// against this file, so it implements the SAME discrete algorithm — not a nicer one — in plain double precision.
//
// Stages covered so far:
// - S3.1a transfers (FINAL-PLAN §5.2 steps 6, 8, 11, 12): P2G (faceScatter) → gridUpdate (u* = mom/mass + g·Δt)
//   → extrapolate (2 layers) → solid faces → G2P (g2pMac) → RK2 advection.
// - S3.1b pressure projection (`projection: true`; §5.3, Bridson 2015 ch. 5): voxel free surface (a cell holding a
//   particle is LIQUID, §5.5 stage 1), Δt·∇·((1/ρ)∇p) = ∇·u* on the 7-point stencil with a_f = Δt/(ρ·dx²), p = 0 in
//   AIR, SOLID faces keep the wall velocity, Jacobi-preconditioned CG to ‖r‖∞ ≤ tolerance, then u = u* − (Δt/ρ)∇p on
//   every non-solid face touching a LIQUID cell; those faces are the extrapolation sources.
// The density projection (S3.2), ghost-fluid surface (S3.4), variable density (S3.5) and viscosity (S3.6) are added
// here first, each before its GPU kernel.
//
// Physics conventions (SI, window-local metres — S3N-5):
// - APIC on a MAC grid (Jiang et al. 2015 §6): each particle carries, per velocity component a, an affine vector
//   c_a = ∇u_a (1/s). P2G: m_f += w·m_p, (m u)_f += w·m_p·(v_a + c_a·(x_f − x_p)). G2P: v_a = Σ w·u_f,
//   c_a = Σ ∇w·u_f. With trilinear weights both are exact for a linear velocity field (FINAL-PLAN §5.4).
// - Gravity is a VECTOR in window axes (S3N-6); nothing here assumes "up" is +y.
// - Walls (FaceType.SOLID): u·n = u_solid·n with static walls (u_solid = 0). Tangential ghost faces are filled by
//   extrapolation (free slip for interpolation); see FaceType.GHOST.
import { FaceType, type GridLayout, type Vec3 } from './gridLayout'
import { VISCOUS_RUN_NU, INCOMPRESSIBLE_NU_NUM } from '../composition/liquidGate'

type Axis = 0 | 1 | 2
const AXES: readonly Axis[] = [0, 1, 2]

/** Particle state, structure-of-arrays (S3N-9). All arrays are indexed by particle; vectors are 3 per particle. */
export interface RefParticles {
  n: number
  /** Window-local position, metres. */
  pos: Float64Array
  /** Velocity, m/s. */
  vel: Float64Array
  /** Affine vectors c_a = ∇u_a (1/s), one Float64Array (3 per particle) per velocity component a. */
  c: [Float64Array, Float64Array, Float64Array]
  /** Mass, kg (ρ_p·V_p). */
  mass: Float64Array
  /** Composition id (CompositionTable row). */
  material: Uint32Array
  /** Reserved enthalpy slot, J (S3N-9; carried, never read, until HEAT-1). */
  enthalpy: Float64Array
  /** Dynamic viscosity μ, Pa·s (S3.6; absent → FlipRefOptions.viscosityDefault). */
  mu?: Float64Array
  /** Immiscibility (drift flux): the particle's slip velocity relative to its cell's continuous phase, m/s (3 per
   *  particle), and its sub-grid drop diameter, m (0 = resolved, not a sub-grid drop). Created on first use. */
  slip?: Float64Array
  drop?: Float64Array
}

/** Immiscible liquids (vault fluid/realism-2026-09/IMMISCIBILITY-spec.md; owner decision 2026-09-29): Manninen,
 *  Taivassalo & Kallio 1996 algebraic-slip drift flux for SUB-GRID drops. */
export interface ImmiscibleOptions {
  /** ρ (kg/m³) and μ (Pa·s) per material id (RefParticles.material). */
  props: Record<number, { rho: number; mu: number }>
  /** Interfacial tension σ (N/m) of a pair, or null: miscible or unsourced — never separated by slip. */
  sigma: (a: number, b: number) => number | null
  /** Scenario override: every dispersed drop has this diameter (m) instead of Hinze's d_max. */
  dropDiameter?: number
  /** The scheme's numerical viscosity (m²/s), added to the carrier's in ε = 2·ν_eff·S:S (the implicit-LES assumption,
   *  disclosed); default liquidGate.INCOMPRESSIBLE_NU_NUM (gate D2). */
  nuNum?: number
}

/** Drag factor f = C_D·Re/24 of a sphere (MTK (40), Schiller & Naumann 1933): 1 + 0.15·Re^0.687 below Re 1000, the
 *  Newton regime C_D = 0.44 above (the two meet within 0.5 % at Re 1000). */
export function dragFactor(Re: number): number { return Re < 1000 ? 1 + 0.15 * Math.pow(Re, 0.687) : 0.44 * Re / 24 }

export function makeParticles(n: number): RefParticles {
  return {
    n,
    pos: new Float64Array(3 * n),
    vel: new Float64Array(3 * n),
    c: [new Float64Array(3 * n), new Float64Array(3 * n), new Float64Array(3 * n)],
    mass: new Float64Array(n),
    material: new Uint32Array(n),
    enthalpy: new Float64Array(n),
  }
}

export interface FlipRefOptions {
  /** Gravitational acceleration in window axes, m/s² (default: none). */
  gravity?: Vec3
  /** false = PIC transfers (c ignored in P2G, c := 0 in G2P). Exists ONLY as the gates' positive control. */
  apic?: boolean
  /** Extrapolation layers (FINAL-PLAN §5.2 step 11: 2). */
  extrapolationLayers?: number
  /** Pressure projection (S3.1b). Default false: transfer-only (S3.1a). */
  projection?: boolean
  /** Liquid density for the projection, kg/m³: the density of every face without `variableDensity`, and the last-resort
   *  fallback with it. */
  density?: number
  /** S3.5 variable density (FINAL-PLAN §5.3 "face density"): each face's ρ_f = Σw·m_p / (Σw·V_p), V_p = dx³/ppc — the
   *  kernel-weighted mean density of the particles around it; the pressure matrix uses a_f = Δt/(ρ_f·dx²) and the
   *  projection Δt/(ρ_f·dx). Particles must carry m_p = ρ_material·dx³/ppc. Default false (one density). */
  variableDensity?: boolean
  /** Pressure solve stops at ‖r‖∞ ≤ this, in divergence units 1/s (default 1e-9: the reference solves tight). */
  pressureTolerance?: number
  /** Pressure solve iteration cap (default 20000; a cap hit is recorded, never hidden). */
  pressureMaxIterations?: number
  /** Kugelstadt et al. 2019 density projection before P2G (S3.2). Default false. */
  densityProjection?: boolean
  /** Free surface of the pressure solve: 'voxel' (S3.1b: a cell holding a particle is LIQUID, p = 0 in AIR cells) or
   *  'ghost' (S3.4: Zhu & Bridson level set, LIQUID where φ < 0, Gibou/Bridson ghost-fluid pressure at the interface). */
  freeSurface?: 'voxel' | 'ghost'
  /** Particles per cell of the rest packing (sets the level-set particle spacing s = dx/∛ppc). Default 8. */
  ppc?: number
  /** Lower clamp of the liquid fraction θ of a liquid–air face (default THETA_MIN = 1e-2, the measured G0-e choice). */
  thetaMin?: number
  /** ψ solve tolerance, ‖r‖∞ in volume-fraction units (FINAL-PLAN §5.3: 1e-3; the reference default solves tight). */
  psiTolerance?: number
  /** S3.6 implicit viscosity (Batty & Bridson 2008; spec fluid/realism-2026-09/S3.6-viscosity-spec.md): 'off' (default),
   *  'auto' (runs when a particle's ν = μ/ρ ≥ viscosityThreshold), 'force' (always — gate S3.6f). Ghost surface only. */
  viscosity?: 'off' | 'auto' | 'force'
  /** ν of the auto rule, m²/s (FINAL-PLAN §5.6: 0.01·ν_num with ν_num from gate D2 — liquidGate.VISCOUS_RUN_NU, the page's rule). */
  viscosityThreshold?: number
  /** μ of particles without their own, Pa·s (default: water at 20 °C, 1.0016e-3 — NIST). */
  viscosityDefault?: number
  /** Tank walls in the viscous solve: 'no-slip' (production) or 'free-slip' (the Lamb and Taylor–Green gates only). */
  viscousWalls?: 'no-slip' | 'free-slip'
  /** μ at a stress sample from the particles around it: harmonic Σw/Σ(w/μ) (default — gate S3.6c: ≤ 3.5 % shear-rate error
   *  at μ contrast 1e3/1e5, where arithmetic Σwμ/Σw errs 10–17 %) or arithmetic. */
  viscosityMean?: 'arithmetic' | 'harmonic'
  /** Viscous PCG stops at ‖r‖₂ ≤ this·‖b‖₂ (default 1e-10: the reference solves tight). */
  viscosityTolerance?: number
  /** GATE-ONLY boundary conditions of the viscous solve (S3.6c layered Couette): x periodic (the x walls vanish from the
   *  viscous operator), and per-wall slip and wall velocity for the walls named 'x-' … 'z+' (default viscousWalls, 0). */
  viscousTestBC?: { periodicX?: boolean; walls?: Partial<Record<'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+', { slip: 'no-slip' | 'free-slip'; velocity?: Vec3 }>> }
  /** The viscous path (spec fluid/realism-2026-09/S3.6e-variational-stokes-spec.md): 'split' (default — S3.6: project,
   *  viscosity, project again), 'stokes' (S3.6e, Larionov, Batty & Bridson 2017: ONE unified pressure–stress solve), or
   *  'auto' — the measured rule (spec rev 4): Stokes only while a MONOLITHIC ball is in a viscous scene (the split path
   *  over-damps a ball 10×: A5 0.048 vs 0.47 U_Stokes), split everywhere else (the Stokes volume-fraction surface is
   *  worse for free-surface waves: E2 σ +21.5 % vs +12.2 %, D1-S ω −5.7 %). */
  viscosityScheme?: 'split' | 'stokes' | 'auto'
  /** Stokes: the face-mass floor W_min (a volume fraction). A non-wall face below it is not an unknown, and every
   *  constraint row touching it is dropped (spec §2; default 1e-2, like θ_min — a numerical choice). */
  stokesFaceMin?: number
  /** Stokes Jacobi-PCG stops at ‖r‖∞ ≤ this, in the rows' units W·1/s (default 1e-9: the reference solves tight). */
  stokesTolerance?: number
  /** The Zhu–Bridson level set at the tank walls: 'mirror' (default — the particles' images across each wall join the
   *  kernel, so a flat pool stays flat up to the wall; the GPU always does this) or 'air' (only the particles inside the
   *  tank: the surface bends down within R of every wall — kept as the gates' negative control; measured, a lattice
   *  honey pool at rest moves at 8.3e-4 m/s (split) / 2.3e-2 m/s (Stokes) whatever the tolerance). */
  levelSetWalls?: 'air' | 'mirror'
  /** The level set at the sphere's surface: 'air' (default: only the particles outside it) or 'mirror' (their radial
   *  images across the surface join the kernel). */
  levelSetSphere?: 'air' | 'mirror'
  /** How the sphere and the liquid exchange momentum (vault fluid/realism-2026-09/S3.7-two-way-ball-spec.md):
   *  'weak' (S3.1c-2, default) — the caller applies integrateSphere after the step (the force one substep late);
   *  'monolithic' (S3.7, Batty et al. 2007 eq. 13) — step() applies gravity to the sphere first, every pressure solve
   *  carries the rank-3 term Δt/(M·dx³)·Σ_a J_a J_aᵀ and updates V from F = J·p, and the viscous solve takes V as three
   *  more unknowns with mass M (the no-slip ball feels skin friction). Needs sphereDensity. */
  sphereCoupling?: 'weak' | 'monolithic'
  /** Sphere density ρ_s (kg/m³) for the monolithic coupling (M = ρ_s·V_J). */
  sphereDensity?: number
  /** Immiscible liquids: sub-grid drop slip (driftFlux). Absent: every material moves with the grid (F1's limit). */
  immiscible?: ImmiscibleOptions
}

/** S3.6 viscous solve report. */
export interface ViscosityStats { ran: boolean; unknowns: number; iterations: number; relResidual: number; capHit: boolean; muFallbacks: number }

/** S3.6e Stokes solve report: velocity unknowns, constraint rows (p + six τ components), rows dropped at mass-less
 *  faces, PCG iterations, the final ‖r‖∞ (W·1/s) and its true value ‖b − A y‖∞ recomputed after the loop. */
export interface StokesStats { faces: number; rows: number; dropped: number; iterations: number; residualInf: number; trueResidualInf: number; capHit: boolean; muFallbacks: number }

/** A solid sphere moving with prescribed velocity during a substep (S3.1c-2, the drop ball): Batty, Bertails & Bridson
 *  2007 — every face's pressure coefficient and divergence term are weighted by the fluid fraction of its control
 *  volume (their eqs. 4–7), the sphere's velocity enters the right-hand side (the −JᵀV term of eq. 13 with M_S⁻¹ → 0),
 *  and the pressure force on it is J·p = −Σ vol_f·(p₊ − p₋)/dx over the faces it occupies (eqs. 8–10). Window metres. */
export interface RefSphere { center: Vec3; radius: number; velocity: Vec3 }

/** Cell labels for the projection (a cell holding at least one particle is LIQUID; the ghost layer is SOLID). */
export const CellLabel = { AIR: 0, LIQUID: 1, SOLID: 2 } as const

export interface DensityStats extends SolveStats {
  /** Range of the compensated volume fraction f̃ over LIQUID cells before the clamp. */
  fMin: number
  fMax: number
  /** Potential-energy change of the position correction, J (logged for INV′). */
  deltaPotential: number
  /** Largest particle displacement, m. */
  maxMove: number
}

interface LiquidSystem {
  n: number
  cells: number[]
  coords: [number, number, number][]
  diag: Float64Array
  nbr: Int32Array
  /** Off-diagonal magnitude a_f of each row's six faces (index 6·row + 2·axis + side), 0 where there is no neighbour. */
  offd: Float64Array
  closed: boolean
  airNeighbour: Uint8Array
}

/** Smallest face weight Σw (a fraction of one particle's trilinear weight) for which ρ_f = Σw·m/(Σw·V_p) is formed;
 *  below it the face takes the mean of its valid same-grid neighbours (the GPU's fixed point resolves 2^-24, so 1e-3
 *  keeps the ratio's relative quantisation below 1e-4). */
export const FACE_WEIGHT_MIN = 1e-3

/** Lower clamp of the liquid fraction θ (FINAL-PLAN §5.3, G0-e: chosen from {1e-6, 1e-3, 1e-2} by measurement in f32).
 *  1e-2: the page's buoyancy scene needed at most 14 MGPCG iterations (29 at 1e-3, 9 with the voxel surface) — the
 *  a/θ diagonal of a nearly dry face dominates the conditioning — while moving an interface by at most 0.01·dx. */
export const THETA_MIN = 1e-2

export interface SolveStats {
  liquidCells: number
  iterations: number
  /** ‖b − A·p‖∞ at exit, 1/s. */
  residualInf: number
  /** ‖b‖∞ (the divergence of u* on liquid cells), 1/s. */
  rhsInf: number
  capHit: boolean
  /** No liquid cell touches air: the operator is singular; solved with the mean pinned (FINAL-PLAN S3.1b). */
  closed: boolean
}

export interface RefDiagnostics {
  /** Particles pushed back inside the window after advection (must stay 0 in any non-wall test). */
  wallClamps: number
  /** Faces still without a velocity after extrapolation that a G2P stencil touched. */
  unsetFaceReads: number
  /** Non-solid faces of LIQUID cells that had no u* when the divergence was formed (must stay 0). */
  unsetDivergenceFaces: number
  /** Particles pushed back inside the window after the density correction. */
  densityClamps: number
  /** Faces of the pressure system (a LIQUID cell on either side) whose ρ_f came from the neighbour mean (Σw <
   *  FACE_WEIGHT_MIN), and those that fell back to `density` — counted per solve. */
  densityNeighbourFaces: number
  densityDefaultFaces: number
  /** Ghost mode: particle-holding cells with φ ≥ 0 relabelled LIQUID because φ does not resolve their interface (no
   *  φ < 0 face-neighbour, or no empty one), summed over classifyLevelSet calls. */
  enclosedRelabels: number
}

/** Positions are kept this fraction of a cell inside the window (a particle exactly on the far wall would put its
 *  stencil's upper node in the ghost slot of the NEXT index). */
const WALL_EPS_CELLS = 1e-6

export class FlipRef {
  readonly layout: GridLayout
  gravity: Vec3
  readonly apic: boolean
  readonly extrapolationLayers: number
  /** Per face grid: face type (S3N-3), mass (kg), momentum (kg·m/s) and velocity (m/s), all in layout slots. */
  readonly faceType: [Uint32Array, Uint32Array, Uint32Array]
  readonly mass: [Float64Array, Float64Array, Float64Array]
  readonly mom: [Float64Array, Float64Array, Float64Array]
  readonly u: [Float64Array, Float64Array, Float64Array]
  /** 1 where u holds a velocity (fluid face with mass, extrapolated face, or solid face). */
  readonly valid: [Uint8Array, Uint8Array, Uint8Array]
  readonly diag: RefDiagnostics = { wallClamps: 0, unsetFaceReads: 0, unsetDivergenceFaces: 0, densityClamps: 0, densityNeighbourFaces: 0, densityDefaultFaces: 0, enclosedRelabels: 0 }
  /** Σw per face (the trilinear weights of the particles scattered to it) and the face density ρ_f (kg/m³). */
  readonly weight: [Float64Array, Float64Array, Float64Array]
  readonly rhoFace: [Float64Array, Float64Array, Float64Array]
  /** Where each ρ_f came from: 0 the face's own sums, 1 the neighbour mean, 2 the default density. */
  readonly rhoSource: [Uint8Array, Uint8Array, Uint8Array]
  readonly variableDensity: boolean
  readonly densityProjection: boolean
  readonly freeSurface: 'voxel' | 'ghost'
  readonly ppc: number
  readonly thetaMin: number
  /** Zhu & Bridson level set φ at cell centres (m; negative inside the liquid), layout slots. */
  readonly levelSet: Float64Array
  readonly psiTolerance: number
  /** Density projection state (layout slots): raw volume fraction, compensated f̃, ψ̂ and the face displacements (m). */
  readonly volumeFraction: Float64Array
  readonly fCompensated: Float64Array
  readonly psi: Float64Array
  /** Right-hand side f̃ − 1 of the last ψ solve per LIQUID cell slot (kernel-parity tests). */
  readonly psiRhs: Float64Array
  readonly displacement: [Float64Array, Float64Array, Float64Array]
  lastDensity: DensityStats | null = null
  readonly projection: boolean
  density: number
  readonly pressureTolerance: number
  readonly pressureMaxIterations: number
  /** Cell labels and pressure (Pa), in layout slots. */
  readonly label: Uint8Array
  // S3.6 viscosity
  readonly viscosity: 'off' | 'auto' | 'force'
  readonly viscosityThreshold: number
  readonly viscosityDefault: number
  readonly viscousWalls: 'no-slip' | 'free-slip'
  readonly viscosityMean: 'arithmetic' | 'harmonic'
  readonly viscosityTolerance: number
  readonly viscousTestBC: FlipRefOptions['viscousTestBC']
  /** Liquid volume fractions of the stress/mass samples (last viscous solve): faces (3 grids), cell centres, and the
   *  edges running along x, y, z (the yz-, xz-, xy-shear samples), window slots via layout.idx. */
  readonly volFace: [Float64Array, Float64Array, Float64Array]
  readonly volCell: Float64Array
  readonly volEdge: [Float64Array, Float64Array, Float64Array]
  /** μ at cell centres and edges (Pa·s, last viscous solve). */
  readonly muCell: Float64Array
  readonly muEdge: [Float64Array, Float64Array, Float64Array]
  lastViscosity: ViscosityStats | null = null
  /** Mutable like sphereCoupling: a gate may settle a scene on the split path and switch (S3.6e A1-S). */
  viscosityScheme: 'split' | 'stokes' | 'auto'
  readonly stokesFaceMin: number
  readonly stokesTolerance: number
  readonly levelSetWalls: 'air' | 'mirror'
  readonly levelSetSphere: 'air' | 'mirror'
  lastStokes: StokesStats | null = null
  /** Diagnostics (the S3.6e cost study): when true, the next stokesSolve keeps its assembled system in lastStokesSystem. */
  stokesExport = false
  lastStokesSystem: { rowCols: number[][]; rowG: number[][]; rowV: Vec3[]; rowC: number[]; rowKind: number[]; Kinv: Float64Array; KVinv: number; rhs: Float64Array; diag: Float64Array } | null = null
  /** The last Stokes solve's stresses (Pa): τ_aa at cell centres (cell[a]) and τ_ab on the edges running along the
   *  third axis (edge[e]), layout slots; 0 where no row. Its pressure goes to `pressure`. */
  stokesStress: { cell: [Float64Array, Float64Array, Float64Array]; edge: [Float64Array, Float64Array, Float64Array] } | null = null
  /** Faces the last viscous solve wrote (unknowns holding liquid), per axis — diagnostics (GPU parity). */
  readonly viscWritten: [Uint8Array, Uint8Array, Uint8Array]
  /** The density projection's labels (the voxel rule at its particle positions), kept for phiVolume. */
  readonly densityLabel: Uint8Array
  readonly pressure: Float64Array
  /** Right-hand side −(∇·u*)/1 of the last solve per LIQUID cell slot, 1/s (0 elsewhere; kernel-parity tests). */
  readonly rhs: Float64Array
  lastSolve: SolveStats | null = null
  /** The drop ball for the next substep (null: none). The caller moves it; the solver only sees its state. */
  sphere: RefSphere | null = null
  sphereCoupling: 'weak' | 'monolithic'
  sphereDensity: number
  readonly immiscible: ImmiscibleOptions | null
  /** The drift velocity u_V of each particle from the last driftFlux (m/s, 3 per particle), added in advect. */
  drift = new Float64Array(0)
  /** Immiscibility: the grid velocity after the grid update (u* = uⁿ + Δt·g, walls applied), and the acceleration each
   *  face received from the projection (and, on the viscous path, the viscous solve): a_f = (u*_f − u_f)/Δt = g − Du/Dt
   *  on the faces the final projection set (m/s²); 0 on SOLID faces, faces no liquid touches and faces inside the ball. */
  uStar: [Float64Array, Float64Array, Float64Array] | null = null
  readonly faceAccel: [Float64Array, Float64Array, Float64Array]
  /** Last driftFlux: dispersed particles, largest |slip| (m/s), the mean drop diameter of the dispersed (m). */
  lastDrift = { dispersed: 0, maxSlip: 0, meanDrop: 0, tooLarge: 0 }
  /** Monolithic coupling: the discrete pressure torque J_rot·p about the centre (N·m) of the last solve — logged, not
   *  applied (a sphere's continuum pressure torque is zero; FINAL-PLAN S3.7: rank 6 only if this is non-negligible). */
  sphereTorque: Vec3 = [0, 0, 0]
  /** Solid fraction of each face's dx³ control volume and of each cell's dx³ cube inside the sphere (2×2×2 subsamples,
   *  each a smooth partial volume clamp(½ − d/(dx/2), 0, 1) of its signed distance d), and the kernel-weighted solid
   *  volume of each cell (the density projection's compensation). Zero without a sphere. */
  readonly solidFraction: [Float64Array, Float64Array, Float64Array]
  readonly cellSolidFraction: Float64Array
  readonly cellSolidKernel: Float64Array
  /** Pressure force on the sphere from the last projection, J·p (N), and particles pushed out of it. */
  sphereForce: Vec3 = [0, 0, 0]
  spherePushOuts = 0

  constructor(layout: GridLayout, opts: FlipRefOptions = {}) {
    this.layout = layout
    this.gravity = opts.gravity ?? [0, 0, 0]
    this.apic = opts.apic ?? true
    this.extrapolationLayers = opts.extrapolationLayers ?? 2
    const f64 = () => [new Float64Array(layout.size), new Float64Array(layout.size), new Float64Array(layout.size)] as [Float64Array, Float64Array, Float64Array]
    this.faceType = [layout.defaultFaceTypes(0), layout.defaultFaceTypes(1), layout.defaultFaceTypes(2)]
    this.mass = f64()
    this.mom = f64()
    this.weight = f64()
    this.rhoFace = f64()
    this.rhoSource = [new Uint8Array(layout.size), new Uint8Array(layout.size), new Uint8Array(layout.size)]
    this.variableDensity = opts.variableDensity ?? false
    this.u = f64()
    this.valid = [new Uint8Array(layout.size), new Uint8Array(layout.size), new Uint8Array(layout.size)]
    this.projection = opts.projection ?? false
    this.density = opts.density ?? 998.2072
    this.pressureTolerance = opts.pressureTolerance ?? 1e-9
    this.pressureMaxIterations = opts.pressureMaxIterations ?? 20000
    this.label = new Uint8Array(layout.size)
    this.viscosity = opts.viscosity ?? 'off'
    this.viscosityThreshold = opts.viscosityThreshold ?? VISCOUS_RUN_NU
    this.viscosityDefault = opts.viscosityDefault ?? 1.001596e-3
    this.viscousWalls = opts.viscousWalls ?? 'no-slip'
    this.viscosityMean = opts.viscosityMean ?? 'harmonic'   // gate S3.6c: arithmetic errs 10–17 % in the soft layer's shear
    this.viscosityTolerance = opts.viscosityTolerance ?? 1e-10
    this.viscousTestBC = opts.viscousTestBC
    this.viscosityScheme = opts.viscosityScheme ?? 'split'
    this.stokesFaceMin = opts.stokesFaceMin ?? 1e-2
    this.stokesTolerance = opts.stokesTolerance ?? 1e-9
    this.levelSetWalls = opts.levelSetWalls ?? 'mirror'
    // the Stokes ball needs the ball-extended level set (stokesSolve asserts it), so the schemes that can take that
    // path default to it
    this.levelSetSphere = opts.levelSetSphere ?? (this.viscosityScheme === 'split' ? 'air' : 'mirror')
    this.immiscible = opts.immiscible ?? null
    if (this.immiscible && !(opts.projection ?? false)) throw new Error('FlipRef: immiscible needs the projection (the drift is driven by the projection\'s face accelerations)')
    this.sphereCoupling = opts.sphereCoupling ?? 'weak'
    this.sphereDensity = opts.sphereDensity ?? NaN
    if (this.sphereCoupling === 'monolithic' && !(this.sphereDensity > 0)) throw new Error('FlipRef: monolithic sphere coupling needs sphereDensity')
    if (this.viscosity !== 'off' && opts.freeSurface !== 'ghost') throw new Error('FlipRef: viscosity needs the ghost-fluid surface (its volumes come from φ)')
    const z3 = (): [Float64Array, Float64Array, Float64Array] => [new Float64Array(layout.size), new Float64Array(layout.size), new Float64Array(layout.size)]
    this.volFace = z3(); this.volEdge = z3(); this.muEdge = z3()
    this.volCell = new Float64Array(layout.size); this.muCell = new Float64Array(layout.size)
    this.viscWritten = [new Uint8Array(layout.size), new Uint8Array(layout.size), new Uint8Array(layout.size)]
    this.densityLabel = new Uint8Array(layout.size)
    this.pressure = new Float64Array(layout.size)
    this.rhs = new Float64Array(layout.size)
    this.densityProjection = opts.densityProjection ?? false
    this.freeSurface = opts.freeSurface ?? 'voxel'
    this.ppc = opts.ppc ?? 8
    this.thetaMin = opts.thetaMin ?? THETA_MIN
    this.levelSet = new Float64Array(layout.size)
    this.psiTolerance = opts.psiTolerance ?? 1e-9
    this.volumeFraction = new Float64Array(layout.size)
    this.fCompensated = new Float64Array(layout.size)
    this.psi = new Float64Array(layout.size)
    this.psiRhs = new Float64Array(layout.size)
    this.displacement = [new Float64Array(layout.size), new Float64Array(layout.size), new Float64Array(layout.size)]
    this.solidFraction = f64()
    this.cellSolidFraction = new Float64Array(layout.size)
    this.cellSolidKernel = new Float64Array(layout.size)
    this.faceAccel = [new Float64Array(layout.size), new Float64Array(layout.size), new Float64Array(layout.size)]
  }

  /** One substep: transfers (S3.1a), with the pressure projection between grid update and G2P when enabled (S3.1b). */
  step(p: RefParticles, dt: number): void {
    this.sphereFractions()
    // S3.7 (Batty et al. 2007 §3.2): body forces on every velocity before the pressure solve — V* = Vⁿ + Δt·g
    if (this.monolithic()) for (let a = 0; a < 3; a++) this.sphere!.velocity[a] += dt * this.gravity[a]
    if (this.densityProjection) this.densityCorrect(p)
    this.p2g(p)
    this.gridUpdate(dt)
    if (this.projection) {
      this.applySolidFaces()
      const viscous = this.viscosityRuns(p)
      const stokes = viscous && (this.viscosityScheme === 'stokes' || (this.viscosityScheme === 'auto' && this.monolithic()))
      const snapshot = () => { this.uStar = [Float64Array.from(this.u[0]), Float64Array.from(this.u[1]), Float64Array.from(this.u[2])] }
      if (this.immiscible && !stokes) snapshot()
      if (this.freeSurface === 'ghost') { this.classifyLevelSet(p); this.thetaCache.clear() }
      else this.classify(p)
      this.extendLiquidIntoSphere()
      this.fillUnsetLiquidFaces()
      if (stokes) {
        // S3.6e: u* on every face the solve may use (a face with liquid volume but no particle weight takes its
        // neighbours'), then ONE pressure–stress solve; the drift's u* is that same field
        this.extrapolate()
        this.applySolidFaces()
        if (this.immiscible) snapshot()
        this.stokesSolve(p, dt)
        this.lastViscosity = null
        this.lastSolve = null
      } else {
        this.solvePressure(dt)
        this.projectVelocities(dt)
        // S3.6 (Batty & Bridson 2008 §3): viscosity on the projected, extrapolated field, then a second projection
        if (viscous) {
          // the ball's pressure force over the substep is J·(p₁ + p₂): projectVelocities reports only its own solve,
          // and the second is a correction (measured: a held ball read F ≈ 0 instead of ρgV_J on this path)
          const F1: Vec3 = [...this.sphereForce]
          this.extrapolate()
          this.applySolidFaces()
          this.viscositySolve(p, dt)
          this.solvePressure(dt)
          this.projectVelocities(dt)
          for (let a = 0; a < 3; a++) this.sphereForce[a] += F1[a]
        } else this.lastViscosity = null
        this.lastStokes = null
      }
      if (this.immiscible) this.captureFaceAccel(dt)
    }
    this.extrapolate()
    this.applySolidFaces()
    this.g2p(p)
    if (this.immiscible) this.driftFlux(p, dt)
    this.advect(p, dt)
  }

  /** a = g − Du/Dt on the faces, the drift flux's forcing (MTK (58)), taken after the final projection and before the
   *  velocity extrapolation:
   *  - faces the final projection set (liquid on a side, outside the ball): a_f = (u*_f − u_f)/Δt — in FLIP the grid step
   *    IS the material derivative, so this is the solver's own discrete balance: at rest it is g on every liquid face
   *    whatever the density there. (The first draft used ∇p/ρ_m, an interpolated ∇p over a differently discretised
   *    density: phantom accelerations at density jumps — Popinet 2018 §2.2: a well-balanced scheme evaluates the
   *    pressure gradient and the force it balances with the same operator, at the same places.)
   *  - SOLID (static wall) faces: g_a — the liquid at a wall has Du_n/Dt = 0.
   *  - every other face (air, the tangential ghost faces outside the window, inside the ball): the velocity's
   *    extrapolation, so a drop's stencil reads the neighbouring liquid's a, as its velocity stencil reads u. */
  captureFaceAccel(dt: number): void {
    const L = this.layout, us = this.uStar!
    const known: [Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(L.size), new Uint8Array(L.size), new Uint8Array(L.size)]
    for (const a of AXES) {
      const acc = this.faceAccel[a], u = this.u[a], ok = this.valid[a], t = this.faceType[a], sf = this.solidFraction[a], kn = known[a]
      acc.fill(0)
      const [lo, hi] = L.faceRange(a)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k)
        if (t[s] === FaceType.SOLID) { acc[s] = this.gravity[a]; continue }
        if (sf[s] >= 1 || !ok[s]) continue
        acc[s] = (us[a][s] - u[s]) / dt
        kn[s] = 1
      }
    }
    this.extrapolateField(this.faceAccel, known)
  }

  /** Manninen, Taivassalo & Kallio 1996 algebraic-slip drift flux for sub-grid drops (spec §3–5, §8), after G2P:
   *  - α_k: kernel-weighted volume fraction of material k at each cell centre (V_p is the same for every particle);
   *    the continuous phase c of a cell is its majority material.
   *  - A particle whose material is not its cell's majority, and whose pair with c has a sourced σ, is a DISPERSED drop
   *    of diameter d: the scenario's, or Hinze 1955 d_max = 0.725·(ρ_c/σ)^(−3/5)·ε^(−2/5) with ε = 2·ν_eff·S:S at its
   *    cell (ν_eff = ν_c + ν_num), breakup only (d ← min(d, d_max)). A drop of a cell or more (d ≥ dx) is resolved
   *    by the grid itself, so it has no slip — this also keeps a quiet interface sharp (ε → 0 ⇒ d_max → ∞).
   *  - Slip (§8.3, (58) + (40) + virtual mass): the drop's equation of motion (ρ_p + ½ρ_c)·ds/dt = (ρ_p − ρ_m)·a −
   *    18 μ_m f(Re)·s/d² with a = g − Du_m/Dt (MTK (58)) sampled from the face accelerations (captureFaceAccel) with the
   *    velocity stencil, f = dragFactor (Schiller–Naumann / Newton),
   *    Re = d·ρ_c·|s|/μ_m and μ_m the Ishii–Zuber mixture viscosity μ_c(1 − α_d)^(−2.5 μ*) with α_pm = 1 — integrated
   *    exactly over the step with f taken at the step's start (the OpenFOAM-10 Lagrangian parcel scheme). Its fixed point
   *    is (58)'s equilibrium slip u_eq; from rest the drop accelerates at (ρ_p − ρ_m)·a/(ρ_p + ½ρ_c).
   *  - Drift (MTK (33)): u_V = u_C − Σ_k α_k ū_Ck (dispersed; ū_Ck the cell mean slip of material k), −Σ_k α_k ū_Ck for the
   *    others — no net volume moves through a cell. Particles advect with u + u_V; their carried velocity is unchanged. */
  driftFlux(p: RefParticles, dt: number): void {
    const I = this.immiscible!, L = this.layout, h = L.dx, S = L.size
    if (!p.slip || p.slip.length !== 3 * p.n) p.slip = new Float64Array(3 * p.n)
    if (!p.drop || p.drop.length !== p.n) p.drop = new Float64Array(p.n)
    if (this.drift.length !== 3 * p.n) this.drift = new Float64Array(3 * p.n)
    this.drift.fill(0)
    const out = { dispersed: 0, maxSlip: 0, meanDrop: 0, tooLarge: 0 }
    const mats = [...new Set(Array.from(p.material.subarray(0, p.n)))].sort((a, b) => a - b)
    const K = mats.length, kOf = new Map(mats.map((m, k) => [m, k]))
    if (K < 2) { p.slip.fill(0); p.drop.fill(0); this.lastDrift = out; return }
    const prop = mats.map(m => { const q = I.props[m]; if (!q) throw new Error(`FlipRef.driftFlux: no ρ, μ for material ${m}`); return q })
    const nuNum = I.nuNum ?? INCOMPRESSIBLE_NU_NUM
    // α_k at cell centres: trilinear weights of every particle
    const W = new Float64Array(K * S), Wt = new Float64Array(S)
    const n3 = [L.nx, L.ny, L.nz]
    const cellsOf = (x: number, y: number, z: number, fn: (s: number, w: number) => void) => {
      const fx = x / h - 0.5, fy = y / h - 0.5, fz = z / h - 0.5
      const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz), tx = fx - i0, ty = fy - j0, tz = fz - k0
      for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const i = i0 + di, j = j0 + dj, k = k0 + dk
        if (i < 0 || j < 0 || k < 0 || i >= n3[0] || j >= n3[1] || k >= n3[2]) continue
        const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz)
        if (w > 0) fn(L.idx(i, j, k), w)
      }
    }
    for (let q = 0; q < p.n; q++) {
      const k = kOf.get(p.material[q])!
      cellsOf(p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2], (s2, w) => { W[k * S + s2] += w; Wt[s2] += w })
    }
    const alpha = (k: number, s2: number) => (Wt[s2] > 0 ? W[k * S + s2] / Wt[s2] : 0)
    const cellOf = (q: number) => L.idx(cellIndex(p.pos[3 * q], h, L.nx), cellIndex(p.pos[3 * q + 1], h, L.ny), cellIndex(p.pos[3 * q + 2], h, L.nz))
    const majority = (s2: number) => { let c = 0; for (let k = 1; k < K; k++) if (alpha(k, s2) > alpha(c, s2)) c = k; return c }
    // a = g − Du/Dt at a point: the face accelerations sampled trilinearly like the velocity
    const accel = (x: number, y: number, z: number): Vec3 => AXES.map(a => {
      const st = stencil(L, a, x, y, z), fa = this.faceAccel[a]
      let v = 0
      for (let n = 0; n < 8; n++) v += st.w[n] * fa[L.idx(st.i[n], st.j[n], st.k[n])]
      return v
    }) as Vec3
    // ε = 2 ν_eff S:S at a cell centre (cached). ∇u: ∂u_a/∂x_a from the cell's own two faces; ∂u_a/∂x_b (b ≠ a) by central
    // differences of the cell-centred u_a = ½(u_a(c) + u_a(c + e_a)) over the neighbours along b, one-sided at the tank
    // walls — only in-range faces are read (the GPU cellInfo kernel computes the same)
    const epsCache = new Map<number, number>()
    const Gm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const uc = (a: Axis, c: number[]) => {
      const c2 = [...c]; c2[a]++
      return 0.5 * (this.u[a][L.idx(c[0], c[1], c[2])] + this.u[a][L.idx(c2[0], c2[1], c2[2])])
    }
    const epsAt = (s2: number, nuEff: number) => {
      const hit = epsCache.get(s2)
      if (hit !== undefined) return hit
      const c = this.coordsOf(s2)
      for (const a of AXES) for (const b of AXES) {
        if (a === b) { const c2 = [...c]; c2[a]++; Gm[a][b] = (this.u[a][L.idx(c2[0], c2[1], c2[2])] - this.u[a][s2]) / h; continue }
        const lo = [...c], hi = [...c]
        lo[b] = Math.max(0, c[b] - 1); hi[b] = Math.min(n3[b] - 1, c[b] + 1)
        Gm[a][b] = hi[b] > lo[b] ? (uc(a, hi) - uc(a, lo)) / ((hi[b] - lo[b]) * h) : 0
      }
      let ss = 0
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { const sab = 0.5 * (Gm[a][b] + Gm[b][a]); ss += sab * sab }
      const e = 2 * nuEff * ss
      epsCache.set(s2, e)
      return e
    }
    // pass 1: the slip of every dispersed particle; cell sums of slip per material
    const slipSum = new Float64Array(3 * K * S), slipCnt = new Float64Array(K * S)
    const dispersed = new Uint8Array(p.n)
    let dropSum = 0
    for (let q = 0; q < p.n; q++) {
      const s2 = cellOf(q), k = kOf.get(p.material[q])!, c = majority(s2)
      const sig = k === c ? null : I.sigma(mats[k], mats[c])
      if (sig === null || !(sig > 0)) { p.slip.fill(0, 3 * q, 3 * q + 3); p.drop[q] = 0; continue }
      const rp = prop[k].rho, rc = prop[c].rho, muC = prop[c].mu, muP = prop[k].mu
      const nuEff = muC / rc + nuNum
      let d: number
      if (I.dropDiameter !== undefined) d = I.dropDiameter
      else {
        const eps = epsAt(s2, nuEff)
        const dMax = eps > 0 ? 0.725 * Math.pow(rc / sig, -0.6) * Math.pow(eps, -0.4) : Infinity
        d = p.drop[q] > 0 ? Math.min(p.drop[q], dMax) : dMax
      }
      if (!(d < h)) { p.slip.fill(0, 3 * q, 3 * q + 3); p.drop[q] = 0; out.tooLarge++; continue }
      p.drop[q] = d
      let rm = 0
      for (let kk = 0; kk < K; kk++) rm += alpha(kk, s2) * prop[kk].rho
      const aD = 1 - alpha(c, s2), muStar = (muP + 0.4 * muC) / (muP + muC)
      const muM = muC * Math.pow(Math.max(1e-12, 1 - aD), -2.5 * muStar)
      const acc = accel(p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2])
      // the drop's equation of motion: (ρ_p + ½ρ_c)·ds/dt = (ρ_p − ρ_m)·a − 18 μ_m f(Re)·s/d², a = g − Du/Dt, integrated over
      // the step with the drag factor f taken at the step's start (OpenFOAM-10 MomentumParcel::calc, Re from the current
      // slip, + integrationSchemes::analytical): s ← s + (s_tgt − s)·(1 − e^(−Δt/τ)), s_tgt = (ρ_p − ρ_m)·a·d²/(18 μ_m f),
      // τ = (ρ_p + ½ρ_c)·d²/(18 μ_m f). Exact initial acceleration from rest; the fixed point is u_eq of (58) + (40)
      const sOld = [p.slip[3 * q], p.slip[3 * q + 1], p.slip[3 * q + 2]]
      const kd = d * d / (18 * muM * dragFactor(d * rc * Math.hypot(sOld[0], sOld[1], sOld[2]) / muM))
      const m = -Math.expm1(-dt / ((rp + 0.5 * rc) * kd))
      for (let a = 0; a < 3; a++) {
        const u = sOld[a] + ((rp - rm) * acc[a] * kd - sOld[a]) * m
        p.slip[3 * q + a] = u
        slipSum[3 * (k * S + s2) + a] += u
      }
      slipCnt[k * S + s2]++
      dispersed[q] = 1
      out.dispersed++
      dropSum += d
      out.maxSlip = Math.max(out.maxSlip, Math.hypot(p.slip[3 * q], p.slip[3 * q + 1], p.slip[3 * q + 2]))
    }
    // pass 2: the drift, u_V = u_C − Σ_k α_k ū_Ck (MTK (33)); the continuous phase and resolved drops: −Σ_k α_k ū_Ck
    const Jc = new Map<number, Vec3>()
    const Jof = (s2: number): Vec3 => {
      let v = Jc.get(s2)
      if (v) return v
      v = [0, 0, 0]
      for (let k = 0; k < K; k++) {
        const cnt = slipCnt[k * S + s2]
        if (!cnt) continue
        const al = alpha(k, s2)
        for (let a = 0; a < 3; a++) v[a] += al * slipSum[3 * (k * S + s2) + a] / cnt
      }
      Jc.set(s2, v)
      return v
    }
    for (let q = 0; q < p.n; q++) {
      const J = Jof(cellOf(q))
      for (let a = 0; a < 3; a++) this.drift[3 * q + a] = (dispersed[q] ? p.slip[3 * q + a] : 0) - J[a]
    }
    out.meanDrop = out.dispersed ? dropSum / out.dispersed : 0
    this.lastDrift = out
  }

  /** Solid fractions of the sphere (all zero without one): each face's and cell's dx³ control volume from 2×2×2
   *  subsamples at ±dx/4, each subsample a smooth partial volume clamp(½ − d/(dx/2), 0, 1) of its signed distance d to
   *  the sphere; the kernel-weighted solid volume of each cell (the trilinear N of the density projection, 4×4×4 samples
   *  over its [−dx, dx]³ support) — the sphere's analogue of the wall compensation f_solid. */
  sphereFractions(): void {
    const L = this.layout, h = L.dx, S = this.sphere
    for (const a of AXES) this.solidFraction[a].fill(0)
    this.cellSolidFraction.fill(0); this.cellSolidKernel.fill(0)
    if (!S) return
    const [cx, cy, cz] = S.center, R = S.radius
    const sub = (x: number, y: number, z: number) => Math.min(1, Math.max(0, 0.5 - (Math.hypot(x - cx, y - cy, z - cz) - R) / (h / 2)))
    const box = (x: number, y: number, z: number) => this.sphereSolidBox(x, y, z)
    const reach = R + 2 * h
    const near = (x: number, y: number, z: number) => Math.hypot(x - cx, y - cy, z - cz) <= reach
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const f = L.facePos(a, i, j, k)
        if (near(f[0], f[1], f[2])) this.solidFraction[a][L.idx(i, j, k)] = box(f[0], f[1], f[2])
      }
    }
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const x = (i + 0.5) * h, y = (j + 0.5) * h, z = (k + 0.5) * h
      if (!near(x, y, z)) continue
      const c = L.idx(i, j, k)
      this.cellSolidFraction[c] = box(x, y, z)
      let kv = 0
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let e = 0; e < 4; e++) {
        const u = (a - 1.5) / 2, v = (b - 1.5) / 2, w = (e - 1.5) / 2                    // ±0.25, ±0.75 cells
        kv += (1 - Math.abs(u)) * (1 - Math.abs(v)) * (1 - Math.abs(w)) * sub(x + u * h, y + v * h, z + w * h)
      }
      this.cellSolidKernel[c] = kv / 8   // Σ N·ΔV/dx³ with ΔV = (dx/2)³: the trilinear kernel integrates to 1
    }
  }

  /** Solid fraction of the dx³ cube centred at (x, y, z) inside the sphere: 2×2×2 subsamples at ±dx/4, each a smooth
   *  partial volume clamp(½ − d/(dx/2), 0, 1) of its signed distance d (0 without a sphere). */
  sphereSolidBox(x: number, y: number, z: number): number {
    const S = this.sphere
    if (!S) return 0
    const h = this.layout.dx, [cx, cy, cz] = S.center, R = S.radius
    let v = 0
    for (const ox of [-0.25, 0.25]) for (const oy of [-0.25, 0.25]) for (const oz of [-0.25, 0.25])
      v += Math.min(1, Math.max(0, 0.5 - (Math.hypot(x + ox * h - cx, y + oy * h - cy, z + oz * h - cz) - R) / (h / 2)))
    return v / 8
  }

  /** The liquid extended into the sphere (Batty & Bridson extrapolate the liquid level set into solids; FINAL-PLAN §5.5):
   *  a cell whose centre lies inside the sphere holds no particles and has φ > 0, so it would be AIR — a p = 0 vacuum
   *  pulling the surrounding water into the ball (measured: 1e5 Pa spikes, 14 m/s at the first substep). Two passes
   *  relabel such cells LIQUID when a face-neighbour is LIQUID: they become unknowns whose faces carry only the small
   *  fluid fractions (fully solid ones drop out of the system). */
  extendLiquidIntoSphere(): void {
    if (!this.sphere) return
    const L = this.layout, lab = this.label
    for (let pass = 0; pass < 2; pass++) {
      const add: number[] = []
      for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
        const c = L.idx(i, j, k)
        if (lab[c] !== CellLabel.AIR || this.cellSolidFraction[c] < 0.5) continue
        for (const [di, dj, dk] of NEIGHBOURS) {
          const ni = i + di, nj = j + dj, nk = k + dk
          if (ni < 0 || nj < 0 || nk < 0 || ni >= L.nx || nj >= L.ny || nk >= L.nz) continue
          if (lab[L.idx(ni, nj, nk)] === CellLabel.LIQUID) { add.push(c); break }
        }
      }
      for (const c of add) lab[c] = CellLabel.LIQUID
    }
  }

  /** Monolithic sphere coupling active (a sphere present and sphereCoupling = 'monolithic'). */
  monolithic(): boolean { return this.sphereCoupling === 'monolithic' && this.sphere !== null }

  /** The sphere's discrete volume V_J = Σ over y faces of S_f·dx³ (Batty 2007's J: the volume the pressure force acts
   *  on — hydrostatics give F_y = ρ·g·V_J exactly), m³. From the last sphereFractions. */
  sphereVolumeJ(): number {
    let v = 0
    for (const S of this.solidFraction[1]) v += S
    return v * this.layout.dx ** 3
  }

  /** Move the sphere by Δt·V (Batty 2007 §3.2: the solid is advanced first, the fluid then sees it at its new place),
   *  then non-penetration at the tank walls: the centre stays ≥ R from every wall and the velocity component into that
   *  wall is removed — no restitution and no friction (FINAL-PLAN limitation 10: no contact model beyond the solve). */
  advanceSphere(dt: number): void {
    const S = this.sphere
    if (!S) return
    const ext = this.layout.extent
    for (let a = 0; a < 3; a++) {
      S.center[a] += dt * S.velocity[a]
      if (S.center[a] < S.radius) { S.center[a] = S.radius; S.velocity[a] = Math.max(S.velocity[a], 0) }
      if (S.center[a] > ext[a] - S.radius) { S.center[a] = ext[a] - S.radius; S.velocity[a] = Math.min(S.velocity[a], 0) }
    }
  }

  /** Weak two-way coupling (FINAL-PLAN S3.1c, density ratio s ≥ 1): V += Δt·(g + F/M) with F the last projection's
   *  pressure force (sphereForce) and M = ρ_s·V_J — the discrete volume the force acts on, so a neutral sphere
   *  (s = 1) feels exactly zero net force at rest. The fluid's reaction to the sphere's acceleration (added mass)
   *  arrives one substep late; the plan enables this only for s ≥ 1 because lighter solids make explicit coupling
   *  unstable (Causin et al. 2005 [S]; this scheme's threshold is [UNVERIFIED]) — s31c2-ref WK measures it. */
  integrateSphere(dt: number, densityKgM3: number): void {
    const S = this.sphere
    if (!S) return
    const M = densityKgM3 * this.sphereVolumeJ()
    for (let a = 0; a < 3; a++) S.velocity[a] += dt * (this.gravity[a] + this.sphereForce[a] / M)
  }

  // ── S3.6 implicit viscosity (Batty & Bridson 2008) ─────────────────────────────────────────────────────────

  /** The whole-solve rule (FINAL-PLAN §5.6): 'auto' runs when any particle's ν = μ/ρ reaches viscosityThreshold. */
  viscosityRuns(p: RefParticles): boolean {
    if (this.viscosity === 'off') return false
    if (this.viscosity === 'force') return true
    const vp = this.layout.dx ** 3 / this.ppc
    for (let q = 0; q < p.n; q++) {
      const mu = p.mu ? p.mu[q] : this.viscosityDefault
      if (mu / (p.mass[q] / vp) >= this.viscosityThreshold) return true
    }
    return false
  }

  /** Liquid fraction of the dx³ cube centred at (x, y, z) m: 2×2×2 subsamples at ±dx/4 of the Zhu–Bridson φ, each
   *  clamp(½ − φ/(dx/2), 0, 1). Every subsample of every family lies on one lattice, ((2a+1)/4)·dx per axis (the GPU
   *  computes φ there once). φ is extended into the walls by mirroring (a subsample dx/4 behind a wall reads the one
   *  dx/4 in front), so the solve sees a smooth surface up to the wall (Batty & Bridson 2008 §5.2, Fig. 7 right); the
   *  edges on a wall plane then keep only their in-tank half (viscousVolumes). */
  private liquidFraction(x: number, y: number, z: number): number {
    const h = this.layout.dx, ext = this.layout.extent
    const mirror = (v: number, e: number) => (v < 0 ? -v : v > e ? 2 * e - v : v)
    let v = 0
    for (const ox of [-0.25, 0.25]) for (const oy of [-0.25, 0.25]) for (const oz of [-0.25, 0.25]) {
      const px = mirror(x + ox * h, ext[0]), py = mirror(y + oy * h, ext[1]), pz = mirror(z + oz * h, ext[2])
      v += Math.min(1, Math.max(0, 0.5 - this.zhuBridson(px, py, pz) / (h / 2)))
    }
    return v / 8
  }

  /** Volumes of every sample family, subsampled only in the surface band (cells whose 3×3×3 neighbourhood mixes
   *  LIQUID and AIR labels); elsewhere 1 inside the liquid, 0 outside. Offsets in cell units. */
  private viscousVolumes(): void {
    const L = this.layout, h = L.dx, lab = this.label
    const cellLiquid = (i: number, j: number, k: number) => {
      const c = L.idx(clampIn(i, 0, L.nx - 1), clampIn(j, 0, L.ny - 1), clampIn(k, 0, L.nz - 1))
      return lab[c] === CellLabel.LIQUID
    }
    const band = new Uint8Array(L.size)
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const me = cellLiquid(i, j, k)
      let mixed = false
      for (let dk = -1; dk <= 1 && !mixed; dk++) for (let dj = -1; dj <= 1 && !mixed; dj++) for (let di = -1; di <= 1 && !mixed; di++) if (cellLiquid(i + di, j + dj, k + dk) !== me) mixed = true
      band[L.idx(i, j, k)] = mixed ? 1 : 0
    }
    const inBand = (i: number, j: number, k: number) => band[L.idx(clampIn(i, 0, L.nx - 1), clampIn(j, 0, L.ny - 1), clampIn(k, 0, L.nz - 1))] === 1
    // a sample at o + (i, j, k) cells: its cube overlaps the cells floor(o + (i,j,k) ± ½) on each axis
    const volumeAt = (o: Vec3, i: number, j: number, k: number) => {
      const cx = o[0] + i, cy = o[1] + j, cz = o[2] + k
      const xs = [Math.floor(cx - 0.5 + 1e-9), Math.floor(cx + 0.5 - 1e-9)], ys = [Math.floor(cy - 0.5 + 1e-9), Math.floor(cy + 0.5 - 1e-9)], zs = [Math.floor(cz - 0.5 + 1e-9), Math.floor(cz + 0.5 - 1e-9)]
      let anyBand = false, allLiquid = true
      for (const a of xs) for (const b of ys) for (const c of zs) { if (inBand(a, b, c)) anyBand = true; if (!cellLiquid(a, b, c)) allLiquid = false }
      if (!anyBand) return allLiquid ? 1 : 0
      return this.liquidFraction(cx * h, cy * h, cz * h)
    }
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a), o: Vec3 = [a === 0 ? 0 : 0.5, a === 1 ? 0 : 0.5, a === 2 ? 0 : 0.5], vf = this.volFace[a]
      vf.fill(0)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        if (i < 0 || j < 0 || k < 0 || i > L.nx || j > L.ny || k > L.nz) continue
        vf[L.idx(i, j, k)] = volumeAt(o, i, j, k)
      }
    }
    this.volCell.fill(0)
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) this.volCell[L.idx(i, j, k)] = volumeAt([0.5, 0.5, 0.5], i, j, k)
    // An edge ON a wall plane: the energy integrates over the liquid inside the tank, so each sample weighs the part of
    // its control volume outside the solid (Larionov, Batty & Bridson 2017 §5.1, W_F: "the volume fractions … inside the
    // fluid (i.e., not solid) region"). For a grid-aligned wall that is exactly half the mirrored volume (a quarter on a
    // corner); cells and tangential faces lie wholly inside. The strain there reads the wall's ghost face (−u across a
    // no-slip wall); with the full volume the ghost's share counted twice and the discrete no-slip wall sat dx/4 inside
    // the liquid (measured, uniform-μ Couette: shear rate +6.67 / 3.22 / 1.59 % at 8 / 16 / 32 cells = n/(n − ½) − 1;
    // exact with the half — and Huppert's current, ratios 0.92–0.93 → 1.00). (Batty & Bridson 2008 §5.2 include the
    // Dirichlet side's volume in their ROW form, whose wall flux is vol·μ(u − u_ghost)/dx — the same discretisation.)
    const periodicX = !!this.viscousTestBC?.periodicX, nn = [L.nx, L.ny, L.nz]
    for (const e of AXES) {
      const ve = this.volEdge[e], o: Vec3 = [e === 0 ? 0.5 : 0, e === 1 ? 0.5 : 0, e === 2 ? 0.5 : 0]
      ve.fill(0)
      const n = [L.nx + (e === 0 ? 0 : 1), L.ny + (e === 1 ? 0 : 1), L.nz + (e === 2 ? 0 : 1)]
      for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
        const c = [i, j, k]
        let v = volumeAt(o, i, j, k)
        for (const b of AXES) if (b !== e && !(b === 0 && periodicX) && (c[b] === 0 || c[b] === nn[b])) v *= 0.5
        ve[L.idx(i, j, k)] = v
      }
    }
  }

  /** μ at cell centres and edges: the trilinear kernel of the particles' μ, arithmetic or harmonic (spec); a sample
   *  that no particle reaches takes viscosityDefault (counted). */
  private viscousMu(p: RefParticles): number {
    const L = this.layout, h = L.dx, harmonic = this.viscosityMean === 'harmonic'
    const fam = [{ o: [0.5, 0.5, 0.5] as Vec3, mu: this.muCell, n: [L.nx, L.ny, L.nz] }, ...AXES.map(e => ({
      o: [e === 0 ? 0.5 : 0, e === 1 ? 0.5 : 0, e === 2 ? 0.5 : 0] as Vec3, mu: this.muEdge[e], n: [L.nx + (e === 0 ? 0 : 1), L.ny + (e === 1 ? 0 : 1), L.nz + (e === 2 ? 0 : 1)] }))]
    let fallbacks = 0
    for (const F of fam) {
      const sw = new Float64Array(L.size), sm = new Float64Array(L.size)
      for (let q = 0; q < p.n; q++) {
        const mu = p.mu ? p.mu[q] : this.viscosityDefault
        const fx = p.pos[3 * q] / h - F.o[0], fy = p.pos[3 * q + 1] / h - F.o[1], fz = p.pos[3 * q + 2] / h - F.o[2]
        const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz), tx = fx - i0, ty = fy - j0, tz = fz - k0
        for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
          const i = i0 + di, j = j0 + dj, k = k0 + dk
          if (i < 0 || j < 0 || k < 0 || i >= F.n[0] || j >= F.n[1] || k >= F.n[2]) continue
          const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz)
          if (w === 0) continue
          const s = L.idx(i, j, k)
          sw[s] += w; sm[s] += harmonic ? w / mu : w * mu
        }
      }
      F.mu.fill(0)
      for (let k = 0; k < F.n[2]; k++) for (let j = 0; j < F.n[1]; j++) for (let i = 0; i < F.n[0]; i++) {
        const s = L.idx(i, j, k)
        if (sw[s] > 0) F.mu[s] = harmonic ? sw[s] / sm[s] : sm[s] / sw[s]
        else { F.mu[s] = this.viscosityDefault; fallbacks++ }
      }
    }
    return fallbacks
  }

  /** Batty & Bridson 2008 eq. 11 on the MAC grid (spec): minimise ½Σ ρ_f V_f (u_f − u*_f)² + Δt[Σ_c μ V Σ_a ε_aa² +
   *  Σ_edges μ V ½γ²] over the face velocities → (M + Δt GᵀWG) u = M u*, SPD, Jacobi-PCG. Unknowns: non-SOLID faces with
   *  V_f > 0 or inside a positive-volume sample (mass-less ones carry the free surface's zero traction). Walls:
   *  normal faces 0; tangential ghost faces −u (no-slip) or +u (free-slip) of the interior face across the wall. Faces
   *  fully inside the ball (S ≥ 1) are Dirichlet V. */
  viscositySolve(p: RefParticles, dt: number): ViscosityStats {
    const L = this.layout, h = L.dx
    this.viscousVolumes()
    const muFallbacks = this.viscousMu(p)
    const inRange = (a: Axis, i: number, j: number, k: number) => {
      const [lo, hi] = L.faceRange(a)
      return i >= lo[0] && j >= lo[1] && k >= lo[2] && i <= hi[0] && j <= hi[1] && k <= hi[2]
    }
    // resolve a face reference (axis, logical c) → { row, sign, konst }: value = sign·x[row] + konst
    const sphereV = (a: Axis) => (this.sphere ? this.sphere.velocity[a] : 0)
    const mono = this.monolithic(), Mball = mono ? this.sphereDensity * this.sphereVolumeJ() : 0
    let N0 = 0   // set after the face unknowns are collected (rows N0 … N0 + 2 are the ball's V)
    const rowOf: Int32Array[] = AXES.map(() => new Int32Array(L.size).fill(-1))
    const TB = this.viscousTestBC, periodicX = !!TB?.periodicX
    /** Periodic x (gate only): wrap the x index into the window (faces of axis x: 0 … nx−1; others: 0 … nx−1). */
    const wrap = (c: number[]) => {
      if (!periodicX) return c
      const m = [...c]
      m[0] = ((m[0] % L.nx) + L.nx) % L.nx
      return m
    }
    /** A tangential ghost face (index −1 or n on an axis b ≠ a): the wall it lies behind, and the interior face it mirrors. */
    const ghostOf = (a: Axis, c: number[]): { m: number[]; wall: 'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+' } | null => {
      for (const b of AXES) {
        if (b === a || (b === 0 && periodicX)) continue
        const n = [L.nx, L.ny, L.nz][b]
        if (c[b] === -1 || c[b] === n) {
          const m = [...c]; m[b] = c[b] === -1 ? 0 : n - 1
          return { m, wall: ((['x', 'y', 'z'] as const)[b] + (c[b] === -1 ? '-' : '+')) as 'x-' }
        }
      }
      return null
    }
    const ghostMirror = (a: Axis, c: number[]) => ghostOf(a, c)?.m ?? null
    type Ref = { row: number; sign: number; konst: number }
    const refFace = (a: Axis, c0: number[], sign = 1): Ref => {
      const c = wrap(c0)
      const g = ghostOf(a, c)
      if (g) {
        // no-slip with wall velocity U: u_ghost = 2U_a − u_interior; free-slip: u_ghost = u_interior. The mirror of a
        // ghost across a corner may itself be a wall-normal face: its value is 0 either way
        const bc = TB?.walls?.[g.wall]
        const slip = bc?.slip ?? this.viscousWalls, U = bc?.velocity?.[a] ?? 0
        const r = refFace(a, g.m, 1)
        return slip === 'no-slip' ? { row: r.row, sign: -sign * r.sign, konst: sign * (2 * U - r.konst) } : { row: r.row, sign: sign * r.sign, konst: sign * r.konst }
      }
      if (!inRange(a, c[0], c[1], c[2])) return { row: -1, sign: 0, konst: 0 }
      const fs = L.idx(c[0], c[1], c[2])
      if (this.faceType[a][fs] === FaceType.SOLID && !(periodicX && a === 0)) return { row: -1, sign: 0, konst: 0 }
      if (this.solidFraction[a][fs] >= 1) return mono ? { row: N0 + a, sign, konst: 0 } : { row: -1, sign: 0, konst: sign * sphereV(a) }
      const r = rowOf[a][fs]
      return r >= 0 ? { row: r, sign, konst: 0 } : { row: -1, sign: 0, konst: sign * this.u[a][fs] }
    }
    // unknowns: first every open face with V_f > 0, then faces met by any positive-volume sample
    const faces: { a: Axis; s: number; c: number[] }[] = []
    const addUnknown = (a: Axis, c0: number[]) => {
      const c = wrap(c0)
      if (ghostMirror(a, c) || !inRange(a, c[0], c[1], c[2])) return
      const fs = L.idx(c[0], c[1], c[2])
      if ((this.faceType[a][fs] === FaceType.SOLID && !(periodicX && a === 0)) || this.solidFraction[a][fs] >= 1 || rowOf[a][fs] >= 0) return
      rowOf[a][fs] = faces.length
      faces.push({ a, s: fs, c: [...c] })
    }
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        if (i < 0 || j < 0 || k < 0 || (periodicX && a === 0 && i === L.nx)) continue
        if (this.volFace[a][L.idx(i, j, k)] > 0) addUnknown(a, [i, j, k])
      }
    }
    // the samples: each a list of (face ref, coefficient) and a weight
    type Sample = { terms: { a: Axis; c: number[]; coef: number }[]; w: number }
    const samples: Sample[] = []
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const cs = L.idx(i, j, k), V = this.volCell[cs]
      if (V <= 0) continue
      for (const a of AXES) {
        const cp = [i, j, k]; cp[a] += 1
        samples.push({ terms: [{ a, c: cp, coef: 1 / h }, { a, c: [i, j, k], coef: -1 / h }], w: 2 * this.muCell[cs] * V })
      }
    }
    for (const e of AXES) {
      const [a, b] = AXES.filter(x => x !== e) as Axis[]
      const n = [L.nx + (e === 0 ? 0 : 1), L.ny + (e === 1 ? 0 : 1), L.nz + (e === 2 ? 0 : 1)]
      for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
        if (periodicX && e !== 0 && i === L.nx) continue   // the same edge as x = 0
        const es = L.idx(i, j, k), V = this.volEdge[e][es]
        if (V <= 0) continue
        const c = [i, j, k], cmb = [...c], cma = [...c]; cmb[b] -= 1; cma[a] -= 1
        samples.push({ terms: [{ a, c, coef: 1 / h }, { a, c: cmb, coef: -1 / h }, { a: b, c, coef: 1 / h }, { a: b, c: cma, coef: -1 / h }], w: this.muEdge[e][es] * V })
      }
    }
    for (const S of samples) for (const t of S.terms) addUnknown(t.a, t.c)
    // S3.7 monolithic: the ball's V joins as rows N0 … N0 + 2 (mass M, start value V); refFace sends S ≥ 1 faces there
    N0 = faces.length
    const resolved = samples.map(S => ({ w: S.w, refs: S.terms.map(t => { const r = refFace(t.a, t.c, 1); return { row: r.row, g: r.sign * t.coef, k: r.konst * t.coef } }) }))
    const N = faces.length + (mono ? 3 : 0)
    const mass = new Float64Array(N), ustar = new Float64Array(N)
    for (let r = 0; r < faces.length; r++) { const F = faces[r]; mass[r] = this.rhoFace[F.a][F.s] * this.volFace[F.a][F.s]; ustar[r] = this.u[F.a][F.s] }
    if (mono) for (let a = 0; a < 3; a++) { mass[N0 + a] = Mball; ustar[N0 + a] = this.sphere!.velocity[a] }
    // A·x (homogeneous) and the constant part
    const apply = (x: Float64Array, out: Float64Array, withConst: boolean, withMass: boolean) => {
      out.fill(0)
      if (withMass) for (let r = 0; r < N; r++) out[r] = mass[r] * x[r]
      for (const S of resolved) {
        let strain = 0
        for (const t of S.refs) { if (t.row >= 0) strain += t.g * x[t.row]; if (withConst) strain += t.k }
        if (strain === 0) continue
        const f = dt * S.w * strain
        for (const t of S.refs) if (t.row >= 0) out[t.row] += f * t.g
      }
    }
    const diag = new Float64Array(N)
    for (let r = 0; r < N; r++) diag[r] = mass[r]
    for (const S of resolved) {
      const acc = new Map<number, number>()
      for (const t of S.refs) if (t.row >= 0) acc.set(t.row, (acc.get(t.row) ?? 0) + t.g)
      for (const [row, g] of acc) diag[row] += dt * S.w * g * g
    }
    const b = new Float64Array(N), tmp = new Float64Array(N), zero = new Float64Array(N)
    apply(zero, tmp, true, false)
    for (let r = 0; r < N; r++) b[r] = mass[r] * ustar[r] - tmp[r]
    // Jacobi-PCG from u*
    const x = ustar.slice(), rr = new Float64Array(N), z = new Float64Array(N), d = new Float64Array(N), q = new Float64Array(N)
    apply(x, tmp, false, true)
    let bn = 0
    for (let r = 0; r < N; r++) { rr[r] = b[r] - tmp[r]; bn += b[r] * b[r] }
    bn = Math.sqrt(bn) || 1
    const cap = 20000
    let it = 0, rn = 0, rz = 0
    for (let r = 0; r < N; r++) { z[r] = diag[r] > 0 ? rr[r] / diag[r] : 0; d[r] = z[r]; rz += rr[r] * z[r] }
    for (; it < cap; it++) {
      rn = 0
      for (let r = 0; r < N; r++) rn += rr[r] * rr[r]
      if (Math.sqrt(rn) <= this.viscosityTolerance * bn) break
      apply(d, q, false, true)
      let dq = 0
      for (let r = 0; r < N; r++) dq += d[r] * q[r]
      if (dq <= 0) break
      const alpha = rz / dq
      let rz2 = 0
      for (let r = 0; r < N; r++) { x[r] += alpha * d[r]; rr[r] -= alpha * q[r]; z[r] = diag[r] > 0 ? rr[r] / diag[r] : 0; rz2 += rr[r] * z[r] }
      const beta = rz2 / rz
      rz = rz2
      for (let r = 0; r < N; r++) d[r] = z[r] + beta * d[r]
    }
    // only faces holding liquid take the solved velocity: a mass-less unknown (V_f = 0, inside a positive-volume
    // sample) exists to carry the free surface's zero traction inside the solve; its value is not a liquid velocity and
    // is weakly determined (measured on the GPU: f32 leaves such rows unconverged and they leaked into G2P — +1.8 %
    // damping on a water wave). It keeps its pre-solve value.
    for (const w of this.viscWritten) w.fill(0)
    for (let r = 0; r < faces.length; r++) { const F = faces[r]; if (this.volFace[F.a][F.s] > 0) { this.u[F.a][F.s] = x[r]; this.valid[F.a][F.s] = 1; this.viscWritten[F.a][F.s] = 1 } }
    if (mono) for (let a = 0; a < 3; a++) this.sphere!.velocity[a] = x[N0 + a]
    const out: ViscosityStats = { ran: true, unknowns: N, iterations: it, relResidual: Math.sqrt(rn) / bn, capHit: it >= cap, muFallbacks }
    this.lastViscosity = out
    return out
  }

  /** S3.6e unsteady Stokes in ONE solve (Larionov, Batty & Bridson 2017 "Variational Stokes", eqs. 15–21; spec
   *  fluid/realism-2026-09/S3.6e-variational-stokes-spec.md). Replaces project → viscosity → project on the viscous path.
   *  The discrete Lagrangian ÷ Δt, with the S3.6 volume fractions W as weights:
   *    ½(u − u*)ᵀK(u − u*) + Σ_c p_c W_c (Gᵀu)_c + Σ_s m_s W_s τ_s (Du)_s − Σ_s m_s W_s τ_s²/(4μ_s),   K = ρ_f W_f/Δt,
   *  m_s = 1 for τ_aa (cells), 2 for τ_ab (edges; τ:ε counts it twice); all six stress components are unknowns (no trace
   *  reduction). Eliminating u: (B K⁻¹ Bᵀ + C) y = B_var u*_var + B_const u_const, y = (p, τ) in Pa, SPD; then
   *  u = u* − K⁻¹ Bᵀ y. Rows: p: W·Σ_a (u_a(c) − u_a(c + e_a))/dx, C = 0; τ_aa: W·(u_a(c + e_a) − u_a(c))/dx, C = W/(2μ);
   *  τ_ab: W·[(u_a(c) − u_a(c − e_b)) + (u_b(c) − u_b(c − e_a))]/dx, C = W/μ — so B u = C y gives τ = 2με and ∇·u = 0.
   *  Faces: an open, non-wall face with W_f ≥ stokesFaceMin is an unknown; wall-normal faces are 0; a tangential ghost
   *  face mirrors the interior face (no-slip −u + 2U, free-slip +u, S3.6's refFace); periodic x wraps (gates). A row
   *  touching a mass-less face (non-wall, below the floor) is dropped: the free surface's natural condition (spec §2).
   *  Phase 2, the ball (eq. 19 — liquid weights W_L and fluid weights W_F = 1 − S together — with a MOVING rigid solid):
   *  every row sees a face's blended velocity ũ = (1 − S)·u + S·V; the fluid part is an unknown of mass ρ·W_L·(1 − S)
   *  when that is ≥ the floor, a face mostly inside the ball (1 − S below the floor) contributes S·V alone; the stress
   *  rows' C carries the sample's W_F (C = W_L·W_F/(2μ) or /μ: rigid inside the ball). Monolithic coupling: V is three
   *  more unknowns with K_V = M/(Δt·dx³) (the rows are per dx³) and V* = Vⁿ + Δt·g from step(); its Schur complement is
   *  S3.7's rank-3 term. Weak coupling: V enters as a constant. Either way F = −dx³·(B_Vᵀ y) — pressure AND viscous
   *  stress — is the force on the ball. */
  stokesSolve(p: RefParticles, dt: number): StokesStats {
    const L = this.layout, h = L.dx
    this.viscousVolumes()
    const muFallbacks = this.viscousMu(p)
    const TB = this.viscousTestBC, periodicX = !!TB?.periodicX, wMin = this.stokesFaceMin
    const inRange = (a: Axis, c: number[]) => { const [lo, hi] = L.faceRange(a); return c[0] >= lo[0] && c[1] >= lo[1] && c[2] >= lo[2] && c[0] <= hi[0] && c[1] <= hi[1] && c[2] <= hi[2] }
    const wrap = (c: number[]) => { if (!periodicX) return c; const m = [...c]; m[0] = ((m[0] % L.nx) + L.nx) % L.nx; return m }
    const ghostOf = (a: Axis, c: number[]): { m: number[]; wall: 'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+' } | null => {
      for (const b of AXES) {
        if (b === a || (b === 0 && periodicX)) continue
        const n = [L.nx, L.ny, L.nz][b]
        if (c[b] === -1 || c[b] === n) {
          const m = [...c]; m[b] = c[b] === -1 ? 0 : n - 1
          return { m, wall: ((['x', 'y', 'z'] as const)[b] + (c[b] === -1 ? '-' : '+')) as 'x-' }
        }
      }
      return null
    }
    const wallFace = (a: Axis, s: number) => this.faceType[a][s] === FaceType.SOLID && !(periodicX && a === 0)
    const Sph = this.sphere, mono = this.monolithic(), Sf = this.solidFraction
    // eq. 19's W_L is the liquid (not air) fraction: a submerged solid is NOT air. With the ball-as-air level set the
    // rows at its surface lose weight and so does its buoyancy (measured, S3.7 A1 scene at R = 3.5 cells: a₀ +37.8 %,
    // F 289 N vs ρgV_J 322 N; with the radial images −2.2 %) — so the Stokes ball requires them
    if (Sph && this.levelSetSphere !== 'mirror') throw new Error("FlipRef.stokesSolve: a ball needs levelSetSphere 'mirror' (the ball is not air)")
    const V0: Vec3 = Sph ? [Sph.velocity[0], Sph.velocity[1], Sph.velocity[2]] : [0, 0, 0]
    // the velocity unknowns
    const colOf: Int32Array[] = AXES.map(() => new Int32Array(L.size).fill(-1))
    const faces: { a: Axis; s: number }[] = []
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        if (i < 0 || j < 0 || k < 0 || (periodicX && a === 0 && i === L.nx)) continue
        const c = [i, j, k]
        if (ghostOf(a, c)) continue
        const s = L.idx(i, j, k)
        if (wallFace(a, s) || Sf[a][s] >= 1 || this.volFace[a][s] * (1 - Sf[a][s]) < wMin) continue
        colOf[a][s] = faces.length
        faces.push({ a, s })
      }
    }
    // a face reference → ũ = g·u[col] + gv·V[vA] + konst; `free`: a mass-less non-wall face (its rows are dropped)
    type Ref = { col: number; g: number; vA: number; gv: number; konst: number; free: boolean }
    const NONE: Ref = { col: -1, g: 0, vA: -1, gv: 0, konst: 0, free: false }
    const refFace = (a: Axis, c0: number[]): Ref => {
      const c = wrap(c0)
      const g = ghostOf(a, c)
      if (g) {
        const bc = TB?.walls?.[g.wall]
        const slip = bc?.slip ?? this.viscousWalls, U = bc?.velocity?.[a] ?? 0
        const r = refFace(a, g.m)
        return slip === 'no-slip' ? { col: r.col, g: -r.g, vA: r.vA, gv: -r.gv, konst: 2 * U - r.konst, free: r.free } : r
      }
      if (!inRange(a, c)) return NONE
      const s = L.idx(c[0], c[1], c[2])
      if (wallFace(a, s)) return NONE
      const S = Sf[a][s], col = colOf[a][s]
      if (col >= 0) return { col, g: 1 - S, vA: S > 0 ? a : -1, gv: S, konst: 0, free: false }
      // below the fluid-mass floor the face moves with the ball ENTIRELY (coefficient 1, not S): a cell whose faces are all
      // carried by the ball then sees a rigid V as divergence-free (with S, a V-only row W·Σ sgn S_f·V/dx = 0 pinned V)
      if (S > 0 && 1 - S < wMin) return { col: -1, g: 0, vA: a, gv: 1, konst: 0, free: false }
      return { ...NONE, free: true }
    }
    // the constraint rows: B's columns and coefficients, its constant part B_const·u_const, C, and what the row is
    const rowCols: number[][] = [], rowG: number[][] = [], rowV: Vec3[] = [], rowK: number[] = [], rowC: number[] = [], rowKind: number[] = [], rowAt: number[] = []
    let dropped = 0
    const addRow = (terms: [Axis, number[], number][], cDiag: number, kind: number, at: number) => {
      const cols: number[] = [], g: number[] = [], vg: Vec3 = [0, 0, 0]
      let konst = 0
      for (const [a, c, coef] of terms) {
        const r = refFace(a, c)
        if (r.free) { dropped++; return }
        konst += r.konst * coef
        if (r.vA >= 0) vg[r.vA] += r.gv * coef
        if (r.col < 0) continue
        const i = cols.indexOf(r.col)
        if (i >= 0) g[i] += r.g * coef; else { cols.push(r.col); g.push(r.g * coef) }
      }
      const hasV = mono && (vg[0] !== 0 || vg[1] !== 0 || vg[2] !== 0)
      if (cols.length === 0 && !hasV && cDiag === 0) { dropped++; return }   // no unknown in the row: no content
      if (!mono) { konst += vg[0] * V0[0] + vg[1] * V0[1] + vg[2] * V0[2] }   // weak coupling: V is prescribed
      rowCols.push(cols); rowG.push(g); rowV.push(vg); rowK.push(konst); rowC.push(cDiag); rowKind.push(kind); rowAt.push(at)
    }
    // kinds: 0 p, 1 + a τ_aa, 4 + e τ on the edges along e
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const cs = L.idx(i, j, k), W = this.volCell[cs]
      if (W <= 0) continue
      const up = (a: number) => { const c = [i, j, k]; c[a] += 1; return c }
      addRow(AXES.flatMap(a => [[a, [i, j, k], W / h], [a, up(a), -W / h]] as [Axis, number[], number][]), 0, 0, cs)
      const WF = 1 - this.cellSolidFraction[cs]
      for (const a of AXES) addRow([[a, up(a), W / h], [a, [i, j, k], -W / h]], W * WF / (2 * this.muCell[cs]), 1 + a, cs)
    }
    for (const e of AXES) {
      const [a, b] = AXES.filter(x => x !== e) as Axis[]
      const n = [L.nx + (e === 0 ? 0 : 1), L.ny + (e === 1 ? 0 : 1), L.nz + (e === 2 ? 0 : 1)]
      for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
        if (periodicX && e !== 0 && i === L.nx) continue   // the same edge as x = 0
        const es = L.idx(i, j, k), W = this.volEdge[e][es]
        if (W <= 0) continue
        const c = [i, j, k], cmb = [...c], cma = [...c]; cmb[b] -= 1; cma[a] -= 1
        const WF = Sph ? 1 - this.sphereSolidBox((i + (e === 0 ? 0.5 : 0)) * h, (j + (e === 1 ? 0.5 : 0)) * h, (k + (e === 2 ? 0.5 : 0)) * h) : 1
        addRow([[a, c, W / h], [a, cmb, -W / h], [b, c, W / h], [b, cma, -W / h]], W * WF / this.muEdge[e][es], 4 + e, es)
      }
    }
    const nF = faces.length, nR = rowC.length
    const Kinv = new Float64Array(nF), ustar = new Float64Array(nF)
    for (let f = 0; f < nF; f++) { const F = faces[f]; Kinv[f] = dt / (this.rhoFace[F.a][F.s] * this.volFace[F.a][F.s] * (1 - Sf[F.a][F.s])); ustar[f] = this.u[F.a][F.s] }
    const KVinv = mono ? dt * h ** 3 / (this.sphereDensity * this.sphereVolumeJ()) : 0
    const bt = new Float64Array(nF), btV: Vec3 = [0, 0, 0]
    const transpose = (y: Float64Array) => {   // bt = B_uᵀ y, btV = B_Vᵀ y
      bt.fill(0); btV[0] = 0; btV[1] = 0; btV[2] = 0
      for (let r = 0; r < nR; r++) {
        const v = y[r]; if (v === 0) continue
        const cols = rowCols[r], g = rowG[r], vg = rowV[r]
        for (let t = 0; t < cols.length; t++) bt[cols[t]] += g[t] * v
        btV[0] += vg[0] * v; btV[1] += vg[1] * v; btV[2] += vg[2] * v
      }
    }
    const apply = (y: Float64Array, out: Float64Array) => {   // out = B K⁻¹ Bᵀ y + C y
      transpose(y)
      for (let f = 0; f < nF; f++) bt[f] *= Kinv[f]
      const w0 = btV[0] * KVinv, w1 = btV[1] * KVinv, w2 = btV[2] * KVinv
      for (let r = 0; r < nR; r++) {
        const cols = rowCols[r], g = rowG[r], vg = rowV[r]
        let s = rowC[r] * y[r] + vg[0] * w0 + vg[1] * w1 + vg[2] * w2
        for (let t = 0; t < cols.length; t++) s += g[t] * bt[cols[t]]
        out[r] = s
      }
    }
    const rhs = new Float64Array(nR), diag = new Float64Array(nR)
    for (let r = 0; r < nR; r++) {
      const cols = rowCols[r], g = rowG[r], vg = rowV[r]
      let s = rowK[r], d = rowC[r] + (vg[0] * vg[0] + vg[1] * vg[1] + vg[2] * vg[2]) * KVinv
      if (mono) s += vg[0] * V0[0] + vg[1] * V0[1] + vg[2] * V0[2]
      for (let t = 0; t < cols.length; t++) { s += g[t] * ustar[cols[t]]; d += g[t] * g[t] * Kinv[cols[t]] }
      rhs[r] = s; diag[r] = d
    }
    if (this.stokesExport) this.lastStokesSystem = { rowCols, rowG, rowV, rowC, rowKind, Kinv: Kinv.slice(), KVinv, rhs: rhs.slice(), diag: diag.slice() }
    // Jacobi-PCG from y = 0 (the paper's solver, §6.3)
    const y = new Float64Array(nR), res = rhs.slice(), z = new Float64Array(nR), d = new Float64Array(nR), q = new Float64Array(nR)
    const infNorm = (v: Float64Array) => { let m = 0; for (let r = 0; r < v.length; r++) m = Math.max(m, Math.abs(v[r])); return m }
    let rz = 0
    for (let r = 0; r < nR; r++) { z[r] = res[r] / diag[r]; d[r] = z[r]; rz += res[r] * z[r] }
    const cap = 100000
    let it = 0, rInf = infNorm(res)
    for (; it < cap && rInf > this.stokesTolerance; it++) {
      apply(d, q)
      let dq = 0
      for (let r = 0; r < nR; r++) dq += d[r] * q[r]
      if (!(dq > 0)) break
      const alpha = rz / dq
      let rz2 = 0
      for (let r = 0; r < nR; r++) { y[r] += alpha * d[r]; res[r] -= alpha * q[r]; z[r] = res[r] / diag[r]; rz2 += res[r] * z[r] }
      rInf = infNorm(res)
      const beta = rz2 / rz
      rz = rz2
      for (let r = 0; r < nR; r++) d[r] = z[r] + beta * d[r]
    }
    apply(y, q)
    for (let r = 0; r < nR; r++) q[r] = rhs[r] - q[r]
    const trueInf = infNorm(q)
    // u = u* − K⁻¹Bᵀy on the unknowns: they alone are valid (the rest is extrapolated from them, as after a projection)
    transpose(y)
    for (const a of AXES) {
      const t = this.faceType[a], ok = this.valid[a]
      for (let s = 0; s < L.size; s++) if (t[s] !== FaceType.SOLID) ok[s] = 0
    }
    for (const w of this.viscWritten) w.fill(0)
    for (let f = 0; f < nF; f++) { const F = faces[f]; this.u[F.a][F.s] = ustar[f] - Kinv[f] * bt[f]; this.valid[F.a][F.s] = 1; this.viscWritten[F.a][F.s] = 1 }
    if (Sph) {
      // the ball: F = −dx³·B_Vᵀy (pressure and viscous stress), V updated (monolithic), the faces it carries take V
      this.sphereForce = [-(h ** 3) * btV[0], -(h ** 3) * btV[1], -(h ** 3) * btV[2]]
      this.sphereTorque = [0, 0, 0]   // not formed on this path (translation only)
      if (mono) for (let a = 0; a < 3; a++) Sph.velocity[a] = V0[a] - KVinv * btV[a]
      for (const a of AXES) {
        const [lo, hi] = L.faceRange(a)
        for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
          const s = L.idx(i, j, k), S = Sf[a][s]
          if (S > 0 && colOf[a][s] < 0 && !wallFace(a, s) && (S >= 1 || 1 - S < wMin)) { this.u[a][s] = Sph.velocity[a]; this.valid[a][s] = 1 }
        }
      }
    }
    this.pressure.fill(0)
    const st = { cell: [new Float64Array(L.size), new Float64Array(L.size), new Float64Array(L.size)], edge: [new Float64Array(L.size), new Float64Array(L.size), new Float64Array(L.size)] } as NonNullable<FlipRef['stokesStress']>
    for (let r = 0; r < nR; r++) {
      const kind = rowKind[r]
      if (kind === 0) this.pressure[rowAt[r]] = y[r]
      else if (kind < 4) st.cell[kind - 1][rowAt[r]] = y[r]
      else st.edge[kind - 4][rowAt[r]] = y[r]
    }
    this.stokesStress = st
    const out: StokesStats = { faces: nF, rows: nR, dropped, iterations: it, residualInf: rInf, trueResidualInf: trueInf, capHit: it >= cap, muFallbacks }
    this.lastStokes = out
    return out
  }

  /** Before the divergence: a non-SOLID face of a LIQUID cell that P2G left unset takes the mean of its P2G-valid
   *  6-neighbours on the same face grid (GPU fillLiquidFaces.wgsl). In f64 this never triggers in practice; on the GPU, f32
   *  can put a particle exactly on a face so the voxel label floors it into the cell whose far face gets weight 0
   *  (measured: 1 face in 720 substeps of a settling pool). Faces partly inside the ball are left to the sphere rule.
   *  Only faces valid from P2G are read, so the result does not depend on the order of the scan. Returns the count. */
  fillUnsetLiquidFaces(): number {
    const L = this.layout, lab = this.label
    let filled = 0
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a), t = this.faceType[a], u = this.u[a], ok = this.valid[a]
      const src = ok.slice()
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k)
        if (src[s] || t[s] === FaceType.SOLID || this.solidFraction[a][s] > 0) continue
        const sm = L.idx(i - (a === 0 ? 1 : 0), j - (a === 1 ? 1 : 0), k - (a === 2 ? 1 : 0))
        if (lab[s] !== CellLabel.LIQUID && lab[sm] !== CellLabel.LIQUID) continue
        let sum = 0, cnt = 0
        for (const [di, dj, dk] of NEIGHBOURS) {
          const ni = i + di, nj = j + dj, nk = k + dk
          if (ni < lo[0] || nj < lo[1] || nk < lo[2] || ni > hi[0] || nj > hi[1] || nk > hi[2]) continue
          const ns = L.idx(ni, nj, nk)
          if (src[ns] && t[ns] !== FaceType.SOLID) { sum += u[ns]; cnt++ }
        }
        if (cnt > 0) { u[s] = sum / cnt; ok[s] = 1; filled++ }
      }
    }
    return filled
  }

  /** Push a particle that ended inside the sphere radially out to its surface (+ wallEps); returns true if it did. */
  private sphereCollide(p: RefParticles, q: number): boolean {
    const S = this.sphere
    if (!S) return false
    const dx = p.pos[3 * q] - S.center[0], dy = p.pos[3 * q + 1] - S.center[1], dz = p.pos[3 * q + 2] - S.center[2]
    const r = Math.hypot(dx, dy, dz), R = S.radius + WALL_EPS_CELLS * this.layout.dx
    if (r >= R) return false
    const s = r > 0 ? R / r : 0
    if (s === 0) { p.pos[3 * q + 1] = S.center[1] + R; return true }
    p.pos[3 * q] = S.center[0] + dx * s; p.pos[3 * q + 1] = S.center[1] + dy * s; p.pos[3 * q + 2] = S.center[2] + dz * s
    return true
  }

  /** Voxel free surface (FINAL-PLAN §5.5 stage 1): the ghost layer is SOLID, a window cell holding at least one
   *  particle is LIQUID, every other window cell is AIR. */
  classify(p: RefParticles): void {
    const L = this.layout, lab = this.label
    lab.fill(CellLabel.SOLID)
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) lab[L.idx(i, j, k)] = CellLabel.AIR
    for (let q = 0; q < p.n; q++) {
      const i = cellIndex(p.pos[3 * q], L.dx, L.nx), j = cellIndex(p.pos[3 * q + 1], L.dx, L.ny), k = cellIndex(p.pos[3 * q + 2], L.dx, L.nz)
      lab[L.idx(i, j, k)] = CellLabel.LIQUID
    }
  }

  /** Face densities ρ_f (kg/m³) for the pressure matrix and the projection. Without `variableDensity`: `density` on
   *  every face. With it: ρ_f = Σw·m / (Σw·V_p), V_p = dx³/ppc, where Σw ≥ FACE_WEIGHT_MIN; below that, the mean ρ of
   *  the same-grid 6-neighbours that have one (counted), else `density` (counted). */
  faceDensities(): void {
    const L = this.layout, vp = L.dx ** 3 / this.ppc
    for (const a of AXES) {
      const rho = this.rhoFace[a], src = this.rhoSource[a]
      src.fill(0)
      if (!this.variableDensity) { rho.fill(this.density); continue }
      const [lo, hi] = L.faceRange(a)
      const own = (i: number, j: number, k: number) => { const s = L.idx(i, j, k); return this.weight[a][s] >= FACE_WEIGHT_MIN ? this.mass[a][s] / (this.weight[a][s] * vp) : 0 }
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        let r = own(i, j, k)
        if (r === 0) {
          let sum = 0, cnt = 0
          for (const [di, dj, dk] of NEIGHBOURS) {
            const ni = i + di, nj = j + dj, nk = k + dk
            if (ni < lo[0] || nj < lo[1] || nk < lo[2] || ni > hi[0] || nj > hi[1] || nk > hi[2]) continue
            const v = own(ni, nj, nk)
            if (v > 0) { sum += v; cnt++ }
          }
          if (cnt > 0) { r = sum / cnt; src[L.idx(i, j, k)] = 1 } else { r = this.density; src[L.idx(i, j, k)] = 2 }
        }
        rho[L.idx(i, j, k)] = r
      }
    }
  }

  /** Pressure Poisson solve on the LIQUID cells: Σ_f a_f·(p_c − p_nbr) = −(∇·u*)_c over non-solid faces,
   *  a_f = Δt/(ρ_f·dx²), p_nbr = 0 in AIR (ghost: a liquid–air face adds a_f/θ). Jacobi-preconditioned CG to
   *  ‖r‖∞ ≤ pressureTolerance. */
  solvePressure(dt: number): SolveStats {
    const L = this.layout, k = dt / (L.dx * L.dx)
    const sys = this.liquidSystem((ax, fs) => k / this.rhoFace[ax][fs], this.freeSurface === 'ghost')
    // density fallbacks on the faces this solve uses (each face once: the −side face of every row, the +side face only
    // when its other cell is not LIQUID)
    for (let r = 0; r < sys.n; r++) {
      const [i, j, kk] = sys.coords[r]
      for (const ax of AXES) for (const side of [0, 1] as const) {
        if (side === 1 && sys.nbr[6 * r + 2 * ax + 1] >= 0) continue
        const fs = L.idx(i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), kk + (ax === 2 ? side : 0))
        if (this.faceType[ax][fs] === FaceType.SOLID) continue
        const src = this.rhoSource[ax][fs]
        if (src === 1) this.diag.densityNeighbourFaces++; else if (src === 2) this.diag.densityDefaultFaces++
      }
    }
    const b = new Float64Array(sys.n)
    for (let r = 0; r < sys.n; r++) {
      const [i, j, k] = sys.coords[r]
      let div = 0
      for (const ax of AXES) {
        for (const side of [0, 1] as const) {
          const fs = L.idx(i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0))
          // Batty et al. 2007: the face flux is the fluid part (1 − S)·u* plus the sphere's part S·V (the −JᵀV term). A
          // partly solid face that no particle reached (beside a cell extended into the sphere) holds no liquid: its open
          // sliver moves with the sphere (u* := V — Batty's solvers extrapolate the velocity into the solid), else the
          // missing u* = 0 is a spurious source (measured: 10 such faces per substep around an R = 3·dx ball)
          const S = this.solidFraction[ax][fs], open = this.faceType[ax][fs] !== FaceType.SOLID
          const uf = S > 0 && open && !this.valid[ax][fs] ? this.sphere!.velocity[ax] : this.u[ax][fs]
          const flux = (1 - S) * uf + (S > 0 ? S * this.sphere!.velocity[ax] : 0)
          if (open && S === 0 && !this.valid[ax][fs]) this.diag.unsetDivergenceFaces++
          div += side === 1 ? flux : -flux
        }
      }
      b[r] = -div / L.dx
    }
    this.rhs.fill(0)
    for (let r = 0; r < sys.n; r++) this.rhs[sys.cells[r]] = b[r]
    // S3.7 monolithic (spec §1): with V_new = V* + (Δt/M)·J·p in the flux S·V, each row gains (Δt/(M·dx³))·Σ_a J_ac·(J_a·p),
    // J_ac = ∂F_a/∂p_c = dx²·Σ_{faces of c, axis a} sgn·S_f (sgn +1 on c's + face) — the rows of F = J·p below
    let rank: { J: Float64Array[]; c: number } | undefined
    const mono = this.monolithic()
    const M = mono ? this.sphereDensity * this.sphereVolumeJ() : 0
    if (mono && M > 0) {
      const J = AXES.map(() => new Float64Array(sys.n))
      for (let r = 0; r < sys.n; r++) {
        const [i, j, k] = sys.coords[r]
        for (const ax of AXES) for (const side of [0, 1] as const) {
          const fs = L.idx(i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0))
          if (this.faceType[ax][fs] === FaceType.SOLID) continue
          J[ax][r] += (side === 1 ? 1 : -1) * this.solidFraction[ax][fs] * L.dx * L.dx
        }
      }
      rank = { J, c: dt / (M * L.dx ** 3) }
    }
    const stats = solveSystem(sys, b, this.pressureTolerance, this.pressureMaxIterations, this.pressure, rank)
    this.lastSolve = stats
    if (mono && M > 0) {
      const F = this.pressureForceOnSphere()
      for (let a = 0; a < 3; a++) this.sphere!.velocity[a] += dt * F[a] / M
      this.sphereTorque = this.pressureTorqueOnSphere()
    }
    return stats
  }

  /** Zhu & Bridson 2005 level set (their eqs. 7–10; FINAL-PLAN §5.5 stage 2) at every window cell centre x:
   *  φ(x) = |x − x̄| − r̄, x̄ = Σ k_i x_i / Σ k_i, k_i = max(0, 1 − (|x − x_i|/R)²)³, with particle spacing s = dx/∛ppc,
   *  R = 2s and r̄ = s/2 (r̄ = s/2, not s: for a flat lattice block the surface lies s/2 above the top particle centres).
   *  The particles' images across the tank walls join the sums (levelSetWalls 'mirror'). Cells with no particle within R
   *  get φ = R (air). Labels: LIQUID where φ < 0 or the cell holds a particle, AIR
   *  elsewhere, ghost layer SOLID. */
  classifyLevelSet(p: RefParticles): void {
    const L = this.layout, h = L.dx, lab = this.label, phi = this.levelSet
    const s = h / Math.cbrt(this.ppc)
    this.zbR = 2 * s; this.zbRbar = s / 2
    // bin particles by cell (linked lists over layout slots)
    this.zbHead = new Int32Array(L.size).fill(-1); this.zbNext = new Int32Array(p.n); this.zbParticles = p
    for (let q = 0; q < p.n; q++) {
      const c = L.idx(cellIndex(p.pos[3 * q], h, L.nx), cellIndex(p.pos[3 * q + 1], h, L.ny), cellIndex(p.pos[3 * q + 2], h, L.nz))
      this.zbNext[q] = this.zbHead[c]; this.zbHead[c] = q
    }
    lab.fill(CellLabel.SOLID)
    phi.fill(this.zbR)
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const c = L.idx(i, j, k)
      phi[c] = this.zhuBridson((i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h)
      lab[c] = phi[c] < 0 ? CellLabel.LIQUID : CellLabel.AIR
    }
    // A particle-holding cell with φ ≥ 0 stays AIR only where the level set RESOLVES its interface: it borders liquid
    // (a face-neighbour with φ < 0) on one side and empty space (no particle, φ ≥ 0, neither wall nor sphere) on another, so the
    // ghost-fluid θ on the liquid neighbour's face places p = 0 at the sub-cell surface. Every other particle-holding
    // cell is LIQUID — its liquid is not resolved by φ (the Zhu–Bridson centroid ignores how many particles there are;
    // with levelSetWalls 'air' it also saw a wall's particle-free side as air), and it must still be incompressible:
    //  • enclosed by liquid and walls (no empty neighbour): left AIR it is a p = 0 sink inside pressurised liquid, and
    //    the particles draining into it pile up without limit (measured: violent 36-cell column in a 16×40×8 tank,
    //    φ-only labels: 4534 particles in one corner cell at 2.5 s, φ-volume 0.49);
    //  • a film or sheet one cell thick (no φ < 0 neighbour): left AIR it has no pressure and no incompressibility, and
    //    a decelerating film compresses (measured, same scene, AIR films: 77 particles in one wall cell, φ-volume 0.973).
    //    LIQUID with θ = θmin on its faces to air, p ≈ 0 — the atmospheric pressure of an unresolved film — while its
    //    divergence is held to zero by flow through those faces (the film thickens instead of compressing).
    // Making EVERY occupied cell LIQUID (the voxel union) also pins p ≈ 0 at the centre of a resolved surface cell whose
    // surface lies in its lower half, erasing the sub-cell height the ghost fluid exists for (measured: D1 standing-wave
    // period error 0.70 % → 7.1 %, ν_num 1.1e-3 → 1.5e-2 m²/s). The test reads φ and occupancy, which the relabelling
    // does not change, so one pass suffices.
    const occupied = (ni: number, nj: number, nk: number) => this.zbHead[L.idx(ni, nj, nk)] >= 0
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const c = L.idx(i, j, k)
      if (lab[c] !== CellLabel.AIR || !occupied(i, j, k)) continue
      let bordersEmpty = false, bordersLiquid = false
      for (const [di, dj, dk] of NEIGHBOURS) {
        const ni = i + di, nj = j + dj, nk = k + dk
        if (ni < 0 || nj < 0 || nk < 0 || ni >= L.nx || nj >= L.ny || nk >= L.nz) continue   // SOLID ghost layer
        const n = L.idx(ni, nj, nk)
        // a cell mostly inside the sphere is solid, not empty space (measured: counted as empty, the cells touching a
        // submerged sphere stayed AIR — p = 0 on its surface, 1.7 m/s currents; extendLiquidIntoSphere's threshold)
        if (this.cellSolidFraction[n] >= 0.5) continue
        if (phi[n] < 0) bordersLiquid = true
        else if (!occupied(ni, nj, nk)) bordersEmpty = true
      }
      if (!(bordersEmpty && bordersLiquid)) { lab[c] = CellLabel.LIQUID; this.diag.enclosedRelabels++ }
    }
  }

  // particle bins of the last classifyLevelSet (the θ evaluation re-uses them)
  private zbHead = new Int32Array(0)
  private zbNext = new Int32Array(0)
  private zbParticles: RefParticles | null = null
  private zbR = 0
  private zbRbar = 0

  /** φ(x) of Zhu & Bridson at an arbitrary point (the particles binned by the last classifyLevelSet). */
  zhuBridson(x: number, y: number, z: number): number {
    const L = this.layout, h = L.dx, p = this.zbParticles, R = this.zbR
    if (!p) return R
    const i0 = Math.floor(x / h), j0 = Math.floor(y / h), k0 = Math.floor(z / h), reach = Math.ceil(R / h)
    let wsum = 0, mx = 0, my = 0, mz = 0
    // 'mirror': the particles' images across every wall within R of x join the kernel (a wall is not air: without them
    // the centroid next to a wall shifts away from it and the surface bends down there)
    const ext = L.extent, X = [x, y, z]
    const images: [number, number][][] = [0, 1, 2].map(a => {
      const t: [number, number][] = [[1, 0]]
      if (this.levelSetWalls === 'mirror') { if (X[a] < R) t.push([-1, 0]); if (X[a] > ext[a] - R) t.push([-1, 2 * ext[a]]) }
      return t
    })
    for (let dk = -reach; dk <= reach; dk++) for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
      const ni = i0 + di, nj = j0 + dj, nk = k0 + dk
      if (ni < 0 || nj < 0 || nk < 0 || ni >= L.nx || nj >= L.ny || nk >= L.nz) continue
      for (let q = this.zbHead[L.idx(ni, nj, nk)]; q >= 0; q = this.zbNext[q]) {
        for (const [sx, ox] of images[0]) for (const [sy, oy] of images[1]) for (const [sz, oz] of images[2]) {
          const px = sx * p.pos[3 * q] + ox, py = sy * p.pos[3 * q + 1] + oy, pz = sz * p.pos[3 * q + 2] + oz
          const rx = px - x, ry = py - y, rz = pz - z
          const d2 = (rx * rx + ry * ry + rz * rz) / (R * R)
          if (d2 >= 1) continue
          const w = (1 - d2) ** 3
          wsum += w; mx += w * px; my += w * py; mz += w * pz
        }
      }
    }
    // levelSetSphere 'mirror': the ball is not air either — a particle within R outside its surface adds its radial
    // image c + (2R_s − r)·(x − c)/r. The reflection is not an isometry (it moves a particle by 2(r − R_s) < 2R), so
    // the particles whose images can reach x lie within 3R of it; images only exist in the shell (R_s − R, R_s], so x
    // must lie within R of that shell. (A wall's image of a ball image is not added: a ball touching a wall is rare.)
    const S = this.levelSetSphere === 'mirror' ? this.sphere : null
    if (S) {
      const Rs = S.radius, dc = Math.hypot(x - S.center[0], y - S.center[1], z - S.center[2])
      if (dc > Rs - 2 * R && dc < Rs + R) {
        const reach3 = Math.ceil(3 * R / h)
        for (let dk = -reach3; dk <= reach3; dk++) for (let dj = -reach3; dj <= reach3; dj++) for (let di = -reach3; di <= reach3; di++) {
          const ni = i0 + di, nj = j0 + dj, nk = k0 + dk
          if (ni < 0 || nj < 0 || nk < 0 || ni >= L.nx || nj >= L.ny || nk >= L.nz) continue
          for (let q = this.zbHead[L.idx(ni, nj, nk)]; q >= 0; q = this.zbNext[q]) {
            const qx = p.pos[3 * q] - S.center[0], qy = p.pos[3 * q + 1] - S.center[1], qz = p.pos[3 * q + 2] - S.center[2]
            const r = Math.hypot(qx, qy, qz)
            if (!(r >= Rs && r < Rs + R)) continue
            const f = (2 * Rs - r) / r
            const px = S.center[0] + f * qx, py = S.center[1] + f * qy, pz = S.center[2] + f * qz
            const rx = px - x, ry = py - y, rz = pz - z
            const d2 = (rx * rx + ry * ry + rz * rz) / (R * R)
            if (d2 >= 1) continue
            const w = (1 - d2) ** 3
            wsum += w; mx += w * px; my += w * py; mz += w * pz
          }
        }
      }
    }
    return wsum > 0 ? Math.hypot(x - mx / wsum, y - my / wsum, z - mz / wsum) - this.zbRbar : R
  }

  /** Liquid fraction θ of the face between LIQUID cell slot sl and AIR cell slot sa: where the Zhu & Bridson φ
   *  crosses zero on the segment between the two centres, located with the face-centre sample as well (the 2× grid of
   *  FINAL-PLAN S3.4a remedy 1 — inside the liquid ZB φ saturates near −r̄ instead of growing like a distance, so
   *  linear interpolation between the two centres alone sits 0.18 dx low on a flat surface; with the midpoint sample
   *  −0.016 dx, measured). Clamped to [thetaMin, 1]; 1 in voxel mode (p = 0 at the AIR cell centre); thetaMin on an
   *  enclosed particle-holding cell (φ ≥ 0, relabelled LIQUID by classifyLevelSet). */
  theta(sl: number, sa: number): number {
    if (this.freeSurface !== 'ghost') return 1
    const key = sl * 0x100000 + sa
    const hit = this.thetaCache.get(key)
    if (hit !== undefined) return hit
    const L = this.layout, h = L.dx
    const a = this.coordsOf(sl), b = this.coordsOf(sa)
    const fm = this.zhuBridson((a[0] + b[0] + 1) * h / 2, (a[1] + b[1] + 1) * h / 2, (a[2] + b[2] + 1) * h / 2)
    const fl = this.levelSet[sl], fa = this.levelSet[sa]
    // a LIQUID cell whose own φ ≥ 0 (relabelled: φ does not resolve its interface, see classifyLevelSet): φ says the
    // surface lies behind its centre, so the face is dry — θ = θmin, p ≈ 0 at the cell (Mantaflow's thetaHelper clamps
    // this case the same way). θ = 1 here put p = 0 a whole cell above the true surface (measured under the earlier
    // all-occupied rule: 5e-2 m/s spurious currents in a pool whose surface lies mid-cell, against 1e-8 with voxel labels).
    if (fl >= 0) { this.thetaCache.set(key, this.thetaMin); return this.thetaMin }
    let t = fm >= 0 ? 0.5 * fl / (fl - fm) : 0.5 + 0.5 * fm / (fm - fa)
    t = t < this.thetaMin ? this.thetaMin : t > 1 ? 1 : t
    this.thetaCache.set(key, t)
    return t
  }
  private thetaCache = new Map<number, number>()

  /** Logical cell coordinates of a window cell slot (inverse of layout.idx for interior cells). */
  private coordsOf(slot: number): [number, number, number] {
    const L = this.layout, px = L.px, py = L.py
    const pi = slot % px, pj = Math.floor(slot / px) % py, pk = Math.floor(slot / (px * py))
    const inv = (ph: number, n: number, ring: number) => ((ph - 1 - ring) % n + n) % n
    return [inv(pi, L.nx, L.ring[0]), inv(pj, L.ny, L.ring[1]), inv(pk, L.nz, L.ring[2])]
  }

  /** Rows of the 7-point operator on the LIQUID cells with face coefficients `coef(axis, face slot)` (SOLID faces
   *  dropped, AIR = Dirichlet 0; with `ghost`, a liquid–air face contributes a_f/θ — Bridson eq. 4.37, one form only,
   *  FINAL-PLAN §5.3), each weighted by its fluid fraction 1 − S_f (Batty et al. 2007 eqs. 4–7; 1 without a sphere).
   *  A LIQUID cell whose every face is fully solid has no row (the GPU solver's zero-diagonal rule). */
  private liquidSystem(coef: (ax: Axis, fs: number) => number, ghost = false): LiquidSystem {
    const L = this.layout, lab = this.label
    const cells: number[] = [], coords: [number, number, number][] = []
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const s = L.idx(i, j, k)
      if (lab[s] !== CellLabel.LIQUID) continue
      let open = false
      for (const ax of AXES) for (const side of [0, 1] as const) {
        const fs = L.idx(i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0))
        if (this.faceType[ax][fs] !== FaceType.SOLID && this.solidFraction[ax][fs] < 1) open = true
      }
      if (open) { cells.push(s); coords.push([i, j, k]) }
    }
    const n = cells.length
    const row = new Map<number, number>()
    cells.forEach((s, r) => row.set(s, r))
    const diag = new Float64Array(n), nbr = new Int32Array(6 * n).fill(-1), offd = new Float64Array(6 * n), airNeighbour = new Uint8Array(n)
    let closed = n > 0
    for (let r = 0; r < n; r++) {
      const [i, j, k] = coords[r]
      let d = 0
      for (const ax of AXES) {
        for (const side of [0, 1] as const) {
          const fs = L.idx(i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0))
          if (this.faceType[ax][fs] === FaceType.SOLID) continue
          const w = 1 - this.solidFraction[ax][fs]
          if (w <= 0) continue
          const a = coef(ax, fs) * w
          const ns = L.idx(i + (ax === 0 ? 2 * side - 1 : 0), j + (ax === 1 ? 2 * side - 1 : 0), k + (ax === 2 ? 2 * side - 1 : 0))
          if (lab[ns] === CellLabel.LIQUID) { nbr[6 * r + 2 * ax + side] = row.get(ns)!; offd[6 * r + 2 * ax + side] = a; d += a }
          else if (lab[ns] === CellLabel.AIR) { closed = false; airNeighbour[r] = 1; d += ghost ? a / this.theta(cells[r], ns) : a }
          else d += a
        }
      }
      diag[r] = d
    }
    return { n, cells, coords, diag, nbr, offd, closed, airNeighbour }
  }

  /** Kugelstadt et al. 2019 density projection (FINAL-PLAN §4.1, §5.2 steps 2–5), before P2G:
   *  f = Σ V_p·N(x_p − x_c)/dx³ (V_p = dx³/ppc) with the cell-centred trilinear N (their eq. 12), plus the solid-side kernel volume of a
   *  rest-density fill f_solid = 1 − Π_axes (1 − 0.125·[solid neighbours on that axis]) (design C §2.4 [DERIVED]) and of
   *  the sphere (cellSolidKernel);
   *  f̃ = clamp(f, 0.5, 1.5) and ≥ 1 in cells with an AIR neighbour; solve ∇²ψ = 1 − f̃ with ψ = 0 in AIR and Neumann at
   *  solids — in the solver's positive form Σ(ψ̂_c − ψ̂_nbr) = f̃ − 1 with ψ̂ = ψ/dx² — then move every particle by
   *  δx = −∇ψ (trilinear from the face values −dx·(ψ̂₊ − ψ̂₋)), WITHOUT changing its velocity. */
  densityCorrect(p: RefParticles): DensityStats {
    const L = this.layout, h = L.dx
    this.classify(p)
    this.densityLabel.set(this.label)
    // volume fraction on cell centres (logical −1 … n; ghost cells collect the mass that is lost across the walls)
    const f = this.volumeFraction
    f.fill(0)
    for (let q = 0; q < p.n; q++) {
      const vp = 1 / this.ppc   // V_p/dx³ = 1/ppc whatever the material (FINAL-PLAN §4.1; m/ρ would over-count a heavy particle)
      const fx = p.pos[3 * q] / h - 0.5, fy = p.pos[3 * q + 1] / h - 0.5, fz = p.pos[3 * q + 2] / h - 0.5
      const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz), tx = fx - i0, ty = fy - j0, tz = fz - k0
      for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz)
        if (w !== 0) f[L.idx(i0 + di, j0 + dj, k0 + dk)] += vp * w
      }
    }
    const sys = this.liquidSystem(() => 1)
    const b = new Float64Array(sys.n)
    let fMin = Infinity, fMax = -Infinity
    for (let r = 0; r < sys.n; r++) {
      const [i, j, k] = sys.coords[r], c = sys.cells[r]
      let keep = 1
      for (const ax of AXES) {
        let solidNbrs = 0
        for (const side of [0, 1] as const) {
          const fs = L.idx(i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0))
          if (this.faceType[ax][fs] === FaceType.SOLID) solidNbrs++
        }
        keep *= 1 - 0.125 * solidNbrs
      }
      // walls (analytic f_solid) + the sphere's kernel-weighted solid volume: disjoint solids, so they add
      let ft = f[c] + (1 - keep) + this.cellSolidKernel[c]
      this.fCompensated[c] = ft
      fMin = Math.min(fMin, ft); fMax = Math.max(fMax, ft)
      ft = Math.min(1.5, Math.max(0.5, ft))
      if (sys.airNeighbour[r]) ft = Math.max(ft, 1)
      b[r] = ft - 1
    }
    this.psiRhs.fill(0)
    for (let r = 0; r < sys.n; r++) this.psiRhs[sys.cells[r]] = b[r]
    const psi = this.psi
    const stats = solveSystem(sys, b, this.psiTolerance, this.pressureMaxIterations, psi)
    // face displacements δx = −dx·(ψ̂₊ − ψ̂₋) on non-SOLID faces touching LIQUID (ψ̂ = 0 in AIR), 0 elsewhere
    const lab = this.label
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      const t = this.faceType[a], dsp = this.displacement[a]
      dsp.fill(0)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k)
        if (t[s] === FaceType.SOLID) continue
        const sm = L.idx(i - (a === 0 ? 1 : 0), j - (a === 1 ? 1 : 0), k - (a === 2 ? 1 : 0))
        const pp = lab[s] === CellLabel.LIQUID ? psi[s] : 0, pm = lab[sm] === CellLabel.LIQUID ? psi[sm] : 0
        if (lab[s] === CellLabel.LIQUID || lab[sm] === CellLabel.LIQUID) dsp[s] = -h * (pp - pm)
      }
    }
    // move the particles; log the potential-energy change of the correction (INV′)
    const ext = L.extent, eps = WALL_EPS_CELLS * h
    let dEp = 0, maxMove = 0
    for (let q = 0; q < p.n; q++) {
      const x = p.pos[3 * q], y = p.pos[3 * q + 1], z = p.pos[3 * q + 2]
      const dxs = [0, 0, 0]
      for (const a of AXES) {
        const st = stencil(L, a, x, y, z)
        let v = 0
        for (let m = 0; m < 8; m++) v += st.w[m] * this.displacement[a][L.idx(st.i[m], st.j[m], st.k[m])]
        dxs[a] = v
      }
      const nx = x + dxs[0], ny = y + dxs[1], nz = z + dxs[2]
      const cx = clampIn(nx, eps, ext[0] - eps), cy = clampIn(ny, eps, ext[1] - eps), cz = clampIn(nz, eps, ext[2] - eps)
      if (cx !== nx || cy !== ny || cz !== nz) this.diag.densityClamps++
      dEp -= p.mass[q] * (this.gravity[0] * (cx - x) + this.gravity[1] * (cy - y) + this.gravity[2] * (cz - z))
      maxMove = Math.max(maxMove, Math.hypot(cx - x, cy - y, cz - z))
      p.pos[3 * q] = cx; p.pos[3 * q + 1] = cy; p.pos[3 * q + 2] = cz
      if (this.sphereCollide(p, q)) this.spherePushOuts++
    }
    const out: DensityStats = { ...stats, fMin, fMax, deltaPotential: dEp, maxMove }
    this.lastDensity = out
    return out
  }

  /** Liquid volume Σ min(f, 1)·dx³ over ALL window cells from the last densityCorrect, m³ (FINAL-PLAN S3.2 G2): f̃ with
   *  the wall compensation in the density projection's LIQUID cells, the raw fraction in its AIR cells — the
   *  cell-centred kernel of a surface particle spills up to 1/8 of its volume into the AIR cell above, which a
   *  LIQUID-only sum would lose. The labels are the density projection's own (densityLabel): f̃ exists only on its cells,
   *  and the ghost-fluid labels of the pressure solve differ from them. f̃ counts liquid + sphere (it is compensated by
   *  the sphere's kernel volume), so a cell's liquid is min(f̃, 1) − S_cell. */
  phiVolume(): number {
    const L = this.layout
    let v = 0
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const s = L.idx(i, j, k)
      v += this.densityLabel[s] === CellLabel.LIQUID ? Math.max(0, Math.min(this.fCompensated[s], 1) - this.cellSolidFraction[s]) : Math.min(this.volumeFraction[s], 1)
    }
    return v * L.dx ** 3
  }

  /** u = u* − (Δt/ρ_f)·(p₊ − p₋)/dx on every non-SOLID face with a LIQUID cell on either side (p = 0 in AIR); those
   *  faces become the only extrapolation sources. */
  projectVelocities(dt: number): void {
    const L = this.layout, lab = this.label, pr = this.pressure
    const k0 = dt / L.dx
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      const t = this.faceType[a], u = this.u[a], ok = this.valid[a], rho = this.rhoFace[a]
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k)
        if (t[s] === FaceType.SOLID) continue
        if (this.solidFraction[a][s] >= 1) { u[s] = this.sphere!.velocity[a]; ok[s] = 1; continue }   // inside the sphere: its velocity
        const sm = L.idx(i - (a === 0 ? 1 : 0), j - (a === 1 ? 1 : 0), k - (a === 2 ? 1 : 0))
        const lm = lab[sm], lp = lab[s]
        if (lm === CellLabel.LIQUID || lp === CellLabel.LIQUID) {
          // AIR side: 0 (voxel) or the ghost pressure −((1 − θ)/θ)·p_liquid that puts p = 0 on the interface (ghost)
          const pp = lp === CellLabel.LIQUID ? pr[s] : lp === CellLabel.AIR ? -((1 - this.theta(sm, s)) / this.theta(sm, s)) * pr[sm] : 0
          const pm = lm === CellLabel.LIQUID ? pr[sm] : lm === CellLabel.AIR ? -((1 - this.theta(s, sm)) / this.theta(s, sm)) * pr[s] : 0
          u[s] -= k0 / rho[s] * (pp - pm)
          ok[s] = 1
        } else {
          ok[s] = 0
        }
      }
    }
    this.sphereForce = this.pressureForceOnSphere()
  }

  /** Batty et al. 2007 eqs. 8–10: F = −∯ p n dA = −∭_solid ∇p ≈ −Σ_f S_f·dx³·(p₊ − p₋)/dx over the faces the sphere
   *  occupies (p of LIQUID cells, 0 elsewhere — interior terms telescope away), N. */
  pressureForceOnSphere(): Vec3 {
    const F: Vec3 = [0, 0, 0]
    if (!this.sphere) return F
    const L = this.layout, lab = this.label, pr = this.pressure, h = L.dx
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k), S = this.solidFraction[a][s]
        if (S <= 0 || this.faceType[a][s] === FaceType.SOLID) continue
        const sm = L.idx(i - (a === 0 ? 1 : 0), j - (a === 1 ? 1 : 0), k - (a === 2 ? 1 : 0))
        const pp = lab[s] === CellLabel.LIQUID ? pr[s] : 0, pm = lab[sm] === CellLabel.LIQUID ? pr[sm] : 0
        F[a] -= S * h * h * (pp - pm)
      }
    }
    return F
  }

  /** The discrete pressure torque about the centre, T = Σ over the faces the sphere occupies of (x_f − X)×F_f with
   *  F_f = −S_f·dx²·(p₊ − p₋)·e_a (Batty et al. 2007 eqs. 11–12, the same face weights as J) — logged only. */
  pressureTorqueOnSphere(): Vec3 {
    const T: Vec3 = [0, 0, 0]
    if (!this.sphere) return T
    const L = this.layout, lab = this.label, pr = this.pressure, h = L.dx, X = this.sphere.center
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k), S = this.solidFraction[a][s]
        if (S <= 0 || this.faceType[a][s] === FaceType.SOLID) continue
        const sm = L.idx(i - (a === 0 ? 1 : 0), j - (a === 1 ? 1 : 0), k - (a === 2 ? 1 : 0))
        const pp = lab[s] === CellLabel.LIQUID ? pr[s] : 0, pm = lab[sm] === CellLabel.LIQUID ? pr[sm] : 0
        const Fa = -S * h * h * (pp - pm), x = L.facePos(a, i, j, k)
        const r = [x[0] - X[0], x[1] - X[1], x[2] - X[2]], F = [0, 0, 0]
        F[a] = Fa
        T[0] += r[1] * F[2] - r[2] * F[1]; T[1] += r[2] * F[0] - r[0] * F[2]; T[2] += r[0] * F[1] - r[1] * F[0]
      }
    }
    return T
  }

  /** Volume flux velocity of a face: (1 − S)·u + S·V_sphere (u without a sphere). */
  private faceFlux(a: Axis, s: number): number {
    const S = this.solidFraction[a][s]
    return S > 0 ? (1 - S) * this.u[a][s] + S * this.sphere!.velocity[a] : this.u[a][s]
  }

  /** Max |∇·u| over LIQUID cells, 1/s (after projection: the solve's residual expressed as velocity divergence; with a
   *  sphere, the divergence of the volume flux (1 − S)·u + S·V). */
  maxLiquidDivergence(): number {
    const L = this.layout
    let m = 0
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      if (this.label[L.idx(i, j, k)] !== CellLabel.LIQUID) continue
      let div = 0
      for (const a of AXES) {
        const up = L.idx(i + (a === 0 ? 1 : 0), j + (a === 1 ? 1 : 0), k + (a === 2 ? 1 : 0)), lo = L.idx(i, j, k)
        div += this.faceFlux(a, up) - this.faceFlux(a, lo)
      }
      m = Math.max(m, Math.abs(div / L.dx))
    }
    return m
  }

  /** faceScatter: particle mass, (APIC) momentum and the weight Σw onto the three face grids. */
  p2g(p: RefParticles): void {
    for (const a of AXES) { this.mass[a].fill(0); this.mom[a].fill(0); this.weight[a].fill(0) }
    const L = this.layout
    for (let q = 0; q < p.n; q++) {
      const x = p.pos[3 * q], y = p.pos[3 * q + 1], z = p.pos[3 * q + 2]
      const m = p.mass[q]
      for (const a of AXES) {
        const s = stencil(L, a, x, y, z)
        const va = p.vel[3 * q + a]
        const ca = p.c[a]
        const cx = ca[3 * q], cy = ca[3 * q + 1], cz = ca[3 * q + 2]
        for (let n = 0; n < 8; n++) {
          const w = s.w[n]
          if (w === 0) continue
          let val = va
          if (this.apic) {
            const f = L.facePos(a, s.i[n], s.j[n], s.k[n])
            val += cx * (f[0] - x) + cy * (f[1] - y) + cz * (f[2] - z)
          }
          const slot = L.idx(s.i[n], s.j[n], s.k[n])
          this.mass[a][slot] += w * m
          this.weight[a][slot] += w
          this.mom[a][slot] += w * m * val
        }
      }
    }
  }

  /** u* = mom/mass on fluid faces with mass, then body force: u* += g_a·Δt; then the face densities (same scatter). */
  gridUpdate(dt: number): void {
    const L = this.layout
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      const g = this.gravity[a] * dt
      const t = this.faceType[a], ma = this.mass[a], mo = this.mom[a], u = this.u[a], ok = this.valid[a]
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k)
        if (t[s] === FaceType.OPEN) throw new Error('FlipRef: OPEN faces are reserved (WIN-1) and not implemented')
        if (t[s] === FaceType.FLUID && ma[s] > 0) { u[s] = mo[s] / ma[s] + g; ok[s] = 1 }
        else { u[s] = 0; ok[s] = 0 }
      }
    }
    this.faceDensities()
  }

  /** Velocity extrapolation into fluid faces without mass and into ghost faces: `extrapolationLayers` passes, each
   *  setting an unset face to the mean of its already-set 6-neighbours on the same face grid (validity ping-pongs,
   *  so the result is independent of traversal order). SOLID faces are neither sources nor targets. */
  extrapolate(): void { this.extrapolateField(this.u, this.valid) }

  /** The velocity extrapolation applied to any face field `f` with its known-face flags `ok` (updated in place). */
  extrapolateField(f: [Float64Array, Float64Array, Float64Array], known: [Uint8Array, Uint8Array, Uint8Array]): void {
    const L = this.layout
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      const t = this.faceType[a], u = f[a], ok = known[a]
      for (let layer = 0; layer < this.extrapolationLayers; layer++) {
        const prev = ok.slice()
        for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
          const s = L.idx(i, j, k)
          if (prev[s] || t[s] === FaceType.SOLID) continue
          let sum = 0, cnt = 0
          for (const [di, dj, dk] of NEIGHBOURS) {
            const ni = i + di, nj = j + dj, nk = k + dk
            if (ni < lo[0] || nj < lo[1] || nk < lo[2] || ni > hi[0] || nj > hi[1] || nk > hi[2]) continue
            const ns = L.idx(ni, nj, nk)
            if (prev[ns] && t[ns] !== FaceType.SOLID) { sum += u[ns]; cnt++ }
          }
          if (cnt > 0) { u[s] = sum / cnt; ok[s] = 1 }
        }
      }
    }
  }

  /** Solid faces carry the wall's normal velocity (static walls: 0). */
  applySolidFaces(): void {
    for (const a of AXES) {
      const t = this.faceType[a], u = this.u[a], ok = this.valid[a]
      for (let s = 0; s < t.length; s++) if (t[s] === FaceType.SOLID) { u[s] = 0; ok[s] = 1 }
    }
  }

  /** g2pMac: v_a = Σ w·u_f and (APIC) c_a = Σ ∇w·u_f. */
  g2p(p: RefParticles): void {
    const g: Vec3 = [0, 0, 0]
    for (let q = 0; q < p.n; q++) {
      const x = p.pos[3 * q], y = p.pos[3 * q + 1], z = p.pos[3 * q + 2]
      for (const a of AXES) {
        p.vel[3 * q + a] = this.sample(a, x, y, z, this.apic ? g : null)
        const ca = p.c[a]
        ca[3 * q] = this.apic ? g[0] : 0
        ca[3 * q + 1] = this.apic ? g[1] : 0
        ca[3 * q + 2] = this.apic ? g[2] : 0
      }
    }
  }

  /** RK2 (midpoint) advection through the grid velocity; positions leaving the window are pushed back and counted. */
  advect(p: RefParticles, dt: number): void {
    const ext = this.layout.extent
    const eps = WALL_EPS_CELLS * this.layout.dx
    for (let q = 0; q < p.n; q++) {
      const x = p.pos[3 * q], y = p.pos[3 * q + 1], z = p.pos[3 * q + 2]
      const v1x = this.sample(0, x, y, z, null), v1y = this.sample(1, x, y, z, null), v1z = this.sample(2, x, y, z, null)
      const mx = clampIn(x + 0.5 * dt * v1x, eps, ext[0] - eps)
      const my = clampIn(y + 0.5 * dt * v1y, eps, ext[1] - eps)
      const mz = clampIn(z + 0.5 * dt * v1z, eps, ext[2] - eps)
      // immiscibility: the drift velocity u_V (driftFlux), constant over the step, moves the particle relative to the grid
      const dr = this.immiscible && this.drift.length === 3 * p.n
      const nx = x + dt * (this.sample(0, mx, my, mz, null) + (dr ? this.drift[3 * q] : 0))
      const ny = y + dt * (this.sample(1, mx, my, mz, null) + (dr ? this.drift[3 * q + 1] : 0))
      const nz = z + dt * (this.sample(2, mx, my, mz, null) + (dr ? this.drift[3 * q + 2] : 0))
      const cx = clampIn(nx, eps, ext[0] - eps), cy = clampIn(ny, eps, ext[1] - eps), cz = clampIn(nz, eps, ext[2] - eps)
      if (cx !== nx || cy !== ny || cz !== nz) this.diag.wallClamps++
      p.pos[3 * q] = cx; p.pos[3 * q + 1] = cy; p.pos[3 * q + 2] = cz
      if (this.sphereCollide(p, q)) this.spherePushOuts++
    }
  }

  /** Trilinear interpolation of face grid `a` at a window-local point; optionally the gradient into `grad`. */
  sample(a: Axis, x: number, y: number, z: number, grad: Vec3 | null): number {
    const L = this.layout
    const s = stencil(L, a, x, y, z)
    const u = this.u[a], ok = this.valid[a]
    let v = 0
    if (grad) { grad[0] = 0; grad[1] = 0; grad[2] = 0 }
    for (let n = 0; n < 8; n++) {
      const slot = L.idx(s.i[n], s.j[n], s.k[n])
      if (!ok[slot] && (s.w[n] !== 0 || grad)) this.diag.unsetFaceReads++
      const f = u[slot]
      v += s.w[n] * f
      if (grad) { grad[0] += s.gx[n] * f; grad[1] += s.gy[n] * f; grad[2] += s.gz[n] * f }
    }
    return v
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────────────────────

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]

function clampIn(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v }

/** Jacobi-preconditioned CG on a LiquidSystem: A·x = b to ‖r‖∞ ≤ tol (cold start). A closed system (no AIR neighbour
 *  anywhere) is singular but consistent after the mean of b is removed; the mean of x is then pinned to 0. The residual
 *  reported is the TRUE residual recomputed from x. The solution is written into `out` at the system's cell slots. */
function solveSystem(sys: LiquidSystem, bIn: Float64Array, tol: number, cap: number, out: Float64Array, rank?: { J: Float64Array[]; c: number }): SolveStats {
  const { n, nbr, offd } = sys
  // S3.7: A + c·Σ_a J_a J_aᵀ (the monolithic sphere); the Jacobi diagonal includes c·Σ_a J_ar²
  const diag = sys.diag.slice()
  if (rank) for (const J of rank.J) for (let r = 0; r < n; r++) diag[r] += rank.c * J[r] * J[r]
  out.fill(0)
  const stats: SolveStats = { liquidCells: n, iterations: 0, residualInf: 0, rhsInf: 0, capHit: false, closed: sys.closed }
  if (n === 0) return stats
  const b = bIn.slice()
  for (let r = 0; r < n; r++) stats.rhsInf = Math.max(stats.rhsInf, Math.abs(b[r]))
  if (sys.closed) { let m = 0; for (let r = 0; r < n; r++) m += b[r]; m /= n; for (let r = 0; r < n; r++) b[r] -= m }
  const Ap = (x: Float64Array, o: Float64Array) => {
    for (let r = 0; r < n; r++) {
      let v = sys.diag[r] * x[r]
      for (let k = 0; k < 6; k++) { const c = nbr[6 * r + k]; if (c >= 0) v -= offd[6 * r + k] * x[c] }
      o[r] = v
    }
    if (rank) for (const J of rank.J) {
      let jx = 0
      for (let r = 0; r < n; r++) jx += J[r] * x[r]
      if (jx !== 0) for (let r = 0; r < n; r++) o[r] += rank.c * J[r] * jx
    }
  }
  const inf = (v: Float64Array) => { let m = 0; for (let r = 0; r < n; r++) m = Math.max(m, Math.abs(v[r])); return m }
  const x = new Float64Array(n), res = b.slice(), z = new Float64Array(n), d = new Float64Array(n), q = new Float64Array(n)
  for (let r = 0; r < n; r++) z[r] = res[r] / diag[r]
  d.set(z)
  let rz = 0
  for (let r = 0; r < n; r++) rz += res[r] * z[r]
  let it = 0
  while (inf(res) > tol && it < cap) {
    Ap(d, q)
    let dq = 0
    for (let r = 0; r < n; r++) dq += d[r] * q[r]
    if (dq <= 0) break
    const alpha = rz / dq
    for (let r = 0; r < n; r++) { x[r] += alpha * d[r]; res[r] -= alpha * q[r] }
    for (let r = 0; r < n; r++) z[r] = res[r] / diag[r]
    let rzNew = 0
    for (let r = 0; r < n; r++) rzNew += res[r] * z[r]
    const beta = rzNew / rz
    rz = rzNew
    for (let r = 0; r < n; r++) d[r] = z[r] + beta * d[r]
    it++
  }
  if (sys.closed) { let m = 0; for (let r = 0; r < n; r++) m += x[r]; m /= n; for (let r = 0; r < n; r++) x[r] -= m }
  Ap(x, q)
  let rInf = 0
  for (let r = 0; r < n; r++) rInf = Math.max(rInf, Math.abs(b[r] - q[r]))
  for (let r = 0; r < n; r++) out[sys.cells[r]] = x[r]
  stats.iterations = it
  stats.residualInf = rInf
  stats.capHit = rInf > tol
  return stats
}

/** Cell index of a coordinate (clamped into the window: positions are kept wallEps inside it). */
function cellIndex(x: number, dx: number, n: number): number { const i = Math.floor(x / dx); return i < 0 ? 0 : i >= n ? n - 1 : i }

interface Stencil {
  i: Int32Array; j: Int32Array; k: Int32Array
  w: Float64Array; gx: Float64Array; gy: Float64Array; gz: Float64Array
}
const S: Stencil = {
  i: new Int32Array(8), j: new Int32Array(8), k: new Int32Array(8),
  w: new Float64Array(8), gx: new Float64Array(8), gy: new Float64Array(8), gz: new Float64Array(8),
}

/** Trilinear stencil of face grid `a` at (x, y, z): the 8 surrounding faces, their weights and weight gradients
 *  (1/m). Returns a shared scratch object — consume before the next call. */
function stencil(L: GridLayout, a: Axis, x: number, y: number, z: number): Stencil {
  const h = L.dx
  const fx = x / h - (a === 0 ? 0 : 0.5), fy = y / h - (a === 1 ? 0 : 0.5), fz = z / h - (a === 2 ? 0 : 0.5)
  const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz)
  const tx = fx - i0, ty = fy - j0, tz = fz - k0
  const wx = [1 - tx, tx], wy = [1 - ty, ty], wz = [1 - tz, tz]
  const dw = [-1 / h, 1 / h]
  let n = 0
  for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
    S.i[n] = i0 + di; S.j[n] = j0 + dj; S.k[n] = k0 + dk
    S.w[n] = wx[di] * wy[dj] * wz[dk]
    S.gx[n] = dw[di] * wy[dj] * wz[dk]
    S.gy[n] = wx[di] * dw[dj] * wz[dk]
    S.gz[n] = wx[di] * wy[dj] * dw[dk]
    n++
  }
  return S
}

// ── diagnostics used by the gates ────────────────────────────────────────────────────────────────────────────────

/** Σ m·v (kg·m/s). */
export function linearMomentum(p: RefParticles): Vec3 {
  const P: Vec3 = [0, 0, 0]
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) P[a] += p.mass[q] * p.vel[3 * q + a]
  return P
}

/** Σ m·(x − o) × v about point o (kg·m²/s). The particle part only; the APIC affine term is reported separately. */
export function angularMomentum(p: RefParticles, o: Vec3): Vec3 {
  const L: Vec3 = [0, 0, 0]
  for (let q = 0; q < p.n; q++) {
    const rx = p.pos[3 * q] - o[0], ry = p.pos[3 * q + 1] - o[1], rz = p.pos[3 * q + 2] - o[2]
    const vx = p.vel[3 * q], vy = p.vel[3 * q + 1], vz = p.vel[3 * q + 2], m = p.mass[q]
    L[0] += m * (ry * vz - rz * vy)
    L[1] += m * (rz * vx - rx * vz)
    L[2] += m * (rx * vy - ry * vx)
  }
  return L
}

/** Kinetic energy Σ ½·m·|v|² (J), particle velocities only. */
export function kineticEnergy(p: RefParticles): number {
  let e = 0
  for (let q = 0; q < p.n; q++) e += 0.5 * p.mass[q] * (p.vel[3 * q] ** 2 + p.vel[3 * q + 1] ** 2 + p.vel[3 * q + 2] ** 2)
  return e
}

/** Potential energy −Σ m·g·x (J) for a uniform gravity vector g, relative to the window origin. */
export function potentialEnergy(p: RefParticles, g: Vec3): number {
  let e = 0
  for (let q = 0; q < p.n; q++) e -= p.mass[q] * (g[0] * p.pos[3 * q] + g[1] * p.pos[3 * q + 1] + g[2] * p.pos[3 * q + 2])
  return e
}

/** Mass-weighted centre of mass (m). */
export function centreOfMass(p: RefParticles): Vec3 {
  const c: Vec3 = [0, 0, 0]
  let M = 0
  for (let q = 0; q < p.n; q++) { M += p.mass[q]; for (let a = 0; a < 3; a++) c[a] += p.mass[q] * p.pos[3 * q + a] }
  return [c[0] / M, c[1] / M, c[2] / M]
}
