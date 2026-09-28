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
  /** Liquid density for the projection, kg/m³ (uniform until S3.5 variable density). */
  density?: number
  /** Pressure solve stops at ‖r‖∞ ≤ this, in divergence units 1/s (default 1e-9: the reference solves tight). */
  pressureTolerance?: number
  /** Pressure solve iteration cap (default 20000; a cap hit is recorded, never hidden). */
  pressureMaxIterations?: number
}

/** Cell labels for the projection (a cell holding at least one particle is LIQUID; the ghost layer is SOLID). */
export const CellLabel = { AIR: 0, LIQUID: 1, SOLID: 2 } as const

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
  readonly diag: RefDiagnostics = { wallClamps: 0, unsetFaceReads: 0, unsetDivergenceFaces: 0 }
  readonly projection: boolean
  density: number
  readonly pressureTolerance: number
  readonly pressureMaxIterations: number
  /** Cell labels and pressure (Pa), in layout slots. */
  readonly label: Uint8Array
  readonly pressure: Float64Array
  lastSolve: SolveStats | null = null

  constructor(layout: GridLayout, opts: FlipRefOptions = {}) {
    this.layout = layout
    this.gravity = opts.gravity ?? [0, 0, 0]
    this.apic = opts.apic ?? true
    this.extrapolationLayers = opts.extrapolationLayers ?? 2
    const f64 = () => [new Float64Array(layout.size), new Float64Array(layout.size), new Float64Array(layout.size)] as [Float64Array, Float64Array, Float64Array]
    this.faceType = [layout.defaultFaceTypes(0), layout.defaultFaceTypes(1), layout.defaultFaceTypes(2)]
    this.mass = f64()
    this.mom = f64()
    this.u = f64()
    this.valid = [new Uint8Array(layout.size), new Uint8Array(layout.size), new Uint8Array(layout.size)]
    this.projection = opts.projection ?? false
    this.density = opts.density ?? 998.2072
    this.pressureTolerance = opts.pressureTolerance ?? 1e-9
    this.pressureMaxIterations = opts.pressureMaxIterations ?? 20000
    this.label = new Uint8Array(layout.size)
    this.pressure = new Float64Array(layout.size)
  }

  /** One substep: transfers (S3.1a), with the pressure projection between grid update and G2P when enabled (S3.1b). */
  step(p: RefParticles, dt: number): void {
    this.p2g(p)
    this.gridUpdate(dt)
    if (this.projection) {
      this.applySolidFaces()
      this.classify(p)
      this.solvePressure(dt)
      this.projectVelocities(dt)
    }
    this.extrapolate()
    this.applySolidFaces()
    this.g2p(p)
    this.advect(p, dt)
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

  /** Pressure Poisson solve on the LIQUID cells: Σ_f a·(p_c − p_nbr) = −(∇·u*)_c over non-solid faces, a = Δt/(ρ·dx²),
   *  p_nbr = 0 in AIR. Jacobi-preconditioned CG to ‖r‖∞ ≤ pressureTolerance. */
  solvePressure(dt: number): SolveStats {
    const L = this.layout, lab = this.label, pr = this.pressure
    pr.fill(0)
    const cells: number[] = [], coords: [number, number, number][] = []
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      const s = L.idx(i, j, k)
      if (lab[s] === CellLabel.LIQUID) { cells.push(s); coords.push([i, j, k]) }
    }
    const n = cells.length
    const stats: SolveStats = { liquidCells: n, iterations: 0, residualInf: 0, rhsInf: 0, capHit: false, closed: true }
    if (n === 0) { this.lastSolve = stats; return stats }
    const a = dt / (this.density * L.dx * L.dx)
    const row = new Map<number, number>()
    cells.forEach((s, r) => row.set(s, r))
    // per row: diagonal and liquid neighbour rows (faces that are SOLID are dropped)
    const diag = new Float64Array(n), nbr = new Int32Array(6 * n).fill(-1), b = new Float64Array(n)
    for (let r = 0; r < n; r++) {
      const [i, j, k] = coords[r]
      let d = 0, div = 0
      for (const ax of AXES) {
        for (const side of [0, 1] as const) {
          const fi = i + (ax === 0 ? side : 0), fj = j + (ax === 1 ? side : 0), fk = k + (ax === 2 ? side : 0)
          const fs = L.idx(fi, fj, fk)
          const uf = this.u[ax][fs]
          if (this.faceType[ax][fs] !== FaceType.SOLID && !this.valid[ax][fs]) this.diag.unsetDivergenceFaces++
          div += side === 1 ? uf : -uf
          if (this.faceType[ax][fs] === FaceType.SOLID) continue
          d += a
          const ni = i + (ax === 0 ? 2 * side - 1 : 0), nj = j + (ax === 1 ? 2 * side - 1 : 0), nk = k + (ax === 2 ? 2 * side - 1 : 0)
          const ns = L.idx(ni, nj, nk)
          if (lab[ns] === CellLabel.LIQUID) nbr[6 * r + 2 * ax + side] = row.get(ns)!
          else if (lab[ns] === CellLabel.AIR) stats.closed = false
        }
      }
      diag[r] = d
      b[r] = -div / L.dx
    }
    for (let r = 0; r < n; r++) stats.rhsInf = Math.max(stats.rhsInf, Math.abs(b[r]))
    if (stats.closed) {           // consistent singular system: remove the constant from the right-hand side
      let mean = 0
      for (let r = 0; r < n; r++) mean += b[r]
      mean /= n
      for (let r = 0; r < n; r++) b[r] -= mean
    }
    const Ap = (x: Float64Array, out: Float64Array) => {
      for (let r = 0; r < n; r++) {
        let v = diag[r] * x[r]
        for (let f = 0; f < 6; f++) { const c = nbr[6 * r + f]; if (c >= 0) v -= a * x[c] }
        out[r] = v
      }
    }
    // Jacobi-preconditioned conjugate gradient
    const x = new Float64Array(n), res = b.slice(), z = new Float64Array(n), d = new Float64Array(n), q = new Float64Array(n)
    const inf = (v: Float64Array) => { let m = 0; for (let r = 0; r < n; r++) m = Math.max(m, Math.abs(v[r])); return m }
    for (let r = 0; r < n; r++) z[r] = res[r] / diag[r]
    d.set(z)
    let rz = 0
    for (let r = 0; r < n; r++) rz += res[r] * z[r]
    let it = 0
    while (inf(res) > this.pressureTolerance && it < this.pressureMaxIterations) {
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
    if (stats.closed) {           // pin the mean: pressure is defined up to a constant
      let mean = 0
      for (let r = 0; r < n; r++) mean += x[r]
      mean /= n
      for (let r = 0; r < n; r++) x[r] -= mean
    }
    // true residual, recomputed from scratch
    Ap(x, q)
    let rInf = 0
    for (let r = 0; r < n; r++) rInf = Math.max(rInf, Math.abs(b[r] - q[r]))
    for (let r = 0; r < n; r++) pr[cells[r]] = x[r]
    stats.iterations = it
    stats.residualInf = rInf
    stats.capHit = rInf > this.pressureTolerance
    this.lastSolve = stats
    return stats
  }

  /** u = u* − (Δt/ρ)·(p₊ − p₋)/dx on every non-SOLID face with a LIQUID cell on either side (p = 0 in AIR); those
   *  faces become the only extrapolation sources. */
  projectVelocities(dt: number): void {
    const L = this.layout, lab = this.label, pr = this.pressure
    const g = dt / (this.density * L.dx)
    for (const a of AXES) {
      const [lo, hi] = L.faceRange(a)
      const t = this.faceType[a], u = this.u[a], ok = this.valid[a]
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const s = L.idx(i, j, k)
        if (t[s] === FaceType.SOLID) continue
        const sm = L.idx(i - (a === 0 ? 1 : 0), j - (a === 1 ? 1 : 0), k - (a === 2 ? 1 : 0))
        const lm = lab[sm], lp = lab[s]
        if (lm === CellLabel.LIQUID || lp === CellLabel.LIQUID) {
          const pp = lp === CellLabel.LIQUID ? pr[s] : 0, pm = lm === CellLabel.LIQUID ? pr[sm] : 0
          u[s] -= g * (pp - pm)
          ok[s] = 1
        } else {
          ok[s] = 0
        }
      }
    }
  }

  /** Max |∇·u| over LIQUID cells, 1/s (after projection: the solve's residual expressed as velocity divergence). */
  maxLiquidDivergence(): number {
    const L = this.layout
    let m = 0
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
      if (this.label[L.idx(i, j, k)] !== CellLabel.LIQUID) continue
      let div = 0
      for (const a of AXES) {
        const up = L.idx(i + (a === 0 ? 1 : 0), j + (a === 1 ? 1 : 0), k + (a === 2 ? 1 : 0))
        div += this.u[a][up] - this.u[a][L.idx(i, j, k)]
      }
      m = Math.max(m, Math.abs(div / L.dx))
    }
    return m
  }

  /** faceScatter: particle mass and (APIC) momentum onto the three face grids. */
  p2g(p: RefParticles): void {
    for (const a of AXES) { this.mass[a].fill(0); this.mom[a].fill(0) }
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
          this.mom[a][slot] += w * m * val
        }
      }
    }
  }

  /** u* = mom/mass on fluid faces with mass, then body force: u* += g_a·Δt. */
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
