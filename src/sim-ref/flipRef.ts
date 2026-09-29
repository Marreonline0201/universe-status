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
}

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
}

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
  /** The density projection's labels (the voxel rule at its particle positions), kept for phiVolume. */
  readonly densityLabel: Uint8Array
  readonly pressure: Float64Array
  /** Right-hand side −(∇·u*)/1 of the last solve per LIQUID cell slot, 1/s (0 elsewhere; kernel-parity tests). */
  readonly rhs: Float64Array
  lastSolve: SolveStats | null = null
  /** The drop ball for the next substep (null: none). The caller moves it; the solver only sees its state. */
  sphere: RefSphere | null = null
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
  }

  /** One substep: transfers (S3.1a), with the pressure projection between grid update and G2P when enabled (S3.1b). */
  step(p: RefParticles, dt: number): void {
    this.sphereFractions()
    if (this.densityProjection) this.densityCorrect(p)
    this.p2g(p)
    this.gridUpdate(dt)
    if (this.projection) {
      this.applySolidFaces()
      if (this.freeSurface === 'ghost') { this.classifyLevelSet(p); this.thetaCache.clear() }
      else this.classify(p)
      this.extendLiquidIntoSphere()
      this.solvePressure(dt)
      this.projectVelocities(dt)
    }
    this.extrapolate()
    this.applySolidFaces()
    this.g2p(p)
    this.advect(p, dt)
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
    const box = (x: number, y: number, z: number) => {
      let v = 0
      for (const ox of [-0.25, 0.25]) for (const oy of [-0.25, 0.25]) for (const oz of [-0.25, 0.25]) v += sub(x + ox * h, y + oy * h, z + oz * h)
      return v / 8
    }
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
          // Batty et al. 2007: the face flux is the fluid part (1 − S)·u* plus the sphere's part S·V (the −JᵀV term)
          const S = this.solidFraction[ax][fs], flux = (1 - S) * this.u[ax][fs] + (S > 0 ? S * this.sphere!.velocity[ax] : 0)
          if (this.faceType[ax][fs] !== FaceType.SOLID && S < 1 && !this.valid[ax][fs]) this.diag.unsetDivergenceFaces++
          div += side === 1 ? flux : -flux
        }
      }
      b[r] = -div / L.dx
    }
    this.rhs.fill(0)
    for (let r = 0; r < sys.n; r++) this.rhs[sys.cells[r]] = b[r]
    const stats = solveSystem(sys, b, this.pressureTolerance, this.pressureMaxIterations, this.pressure)
    this.lastSolve = stats
    return stats
  }

  /** Zhu & Bridson 2005 level set (their eqs. 7–10; FINAL-PLAN §5.5 stage 2) at every window cell centre x:
   *  φ(x) = |x − x̄| − r̄, x̄ = Σ k_i x_i / Σ k_i, k_i = max(0, 1 − (|x − x_i|/R)²)³, with particle spacing s = dx/∛ppc,
   *  R = 2s and r̄ = s/2 (r̄ = s/2, not s: for a flat lattice block the surface lies s/2 above the top particle centres).
   *  Cells with no particle within R get φ = R (air). Labels: LIQUID where φ < 0 or the cell holds a particle, AIR
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
    // cell is LIQUID — its liquid is not resolved by φ (the Zhu–Bridson centroid ignores how many particles there are,
    // and at a wall sees the particle-free side as air), and it must still be incompressible:
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
    for (let dk = -reach; dk <= reach; dk++) for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
      const ni = i0 + di, nj = j0 + dj, nk = k0 + dk
      if (ni < 0 || nj < 0 || nk < 0 || ni >= L.nx || nj >= L.ny || nk >= L.nz) continue
      for (let q = this.zbHead[L.idx(ni, nj, nk)]; q >= 0; q = this.zbNext[q]) {
        const rx = p.pos[3 * q] - x, ry = p.pos[3 * q + 1] - y, rz = p.pos[3 * q + 2] - z
        const d2 = (rx * rx + ry * ry + rz * rz) / (R * R)
        if (d2 >= 1) continue
        const w = (1 - d2) ** 3
        wsum += w; mx += w * p.pos[3 * q]; my += w * p.pos[3 * q + 1]; mz += w * p.pos[3 * q + 2]
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
  extrapolate(): void {
    const L = this.layout
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      const t = this.faceType[a], u = this.u[a], ok = this.valid[a]
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
      const nx = x + dt * this.sample(0, mx, my, mz, null)
      const ny = y + dt * this.sample(1, mx, my, mz, null)
      const nz = z + dt * this.sample(2, mx, my, mz, null)
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
function solveSystem(sys: LiquidSystem, bIn: Float64Array, tol: number, cap: number, out: Float64Array): SolveStats {
  const { n, diag, nbr, offd } = sys
  out.fill(0)
  const stats: SolveStats = { liquidCells: n, iterations: 0, residualInf: 0, rhsInf: 0, capHit: false, closed: sys.closed }
  if (n === 0) return stats
  const b = bIn.slice()
  for (let r = 0; r < n; r++) stats.rhsInf = Math.max(stats.rhsInf, Math.abs(b[r]))
  if (sys.closed) { let m = 0; for (let r = 0; r < n; r++) m += b[r]; m /= n; for (let r = 0; r < n; r++) b[r] -= m }
  const Ap = (x: Float64Array, o: Float64Array) => {
    for (let r = 0; r < n; r++) {
      let v = diag[r] * x[r]
      for (let k = 0; k < 6; k++) { const c = nbr[6 * r + k]; if (c >= 0) v -= offd[6 * r + k] * x[c] }
      o[r] = v
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
