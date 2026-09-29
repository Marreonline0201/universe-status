// Volume spawner: fills regions with particles on a jittered cubic lattice at the solver's rest
// packing, so new fluid starts at rest density instead of under-dense random scatter (the old
// spawns placed ~1.4 particles/cell against a rest density of 4, so pressure stayed zero until
// gravity crushed the fluid) — and never inside existing fluid (spawning into occupied cells
// compresses it far past rest density and the EOS pressure throws it apart).
//
// Pure functions of their inputs + an RNG (Math.random by default; benches swap in a seeded
// generator), all in the sim's tank-normalised [0,1]³ coordinates.
import { GRID_RES, WALL_BAND_CELLS } from './units'

/** MPM rest packing: particles per grid cell at rest density (REST_DENSITY in p2g2.wgsl). */
export const REST_PPC = 4

/** Lattice spacing that puts exactly REST_PPC particles in each cell volume. */
export const LATTICE_SPACING = 1 / (GRID_RES * Math.cbrt(REST_PPC))

/** The fluid region: inside the wall band on every face (gridForces.wgsl BOUND = WALL_BAND_CELLS). */
export const TANK_MIN = WALL_BAND_CELLS / GRID_RES
export const TANK_MAX = 1 - WALL_BAND_CELLS / GRID_RES

export type Vec3 = [number, number, number]

/** How a solver packs particles at rest and where its liquid may be, in world units (the 64³ grid = [0,1]³). */
export interface Packing {
  /** Particles per grid cell at rest. */
  ppc: number
  /** Jittered-lattice spacing that puts exactly ppc particles in each cell volume. */
  spacing: number
  /** The liquid region on every axis. */
  tankMin: number
  tankMax: number
  /** World coordinate of the tank's inner (0,0,0) corner — scenario metres are measured from it. */
  tankOrigin: number
  /** Per-axis upper bound of the liquid region (a resized tank, TANK-RESIZE spec); absent: tankMax on every axis. */
  tankHi?: Vec3
}
/** The liquid region's upper bound per axis. */
export const packingHi = (pk: Packing): Vec3 => pk.tankHi ?? [pk.tankMax, pk.tankMax, pk.tankMax]

/** Legacy MLS-MPM: 4 ppc (REST_DENSITY), liquid inside the 3-cell separating band. */
export const MPM_PACKING: Packing = { ppc: REST_PPC, spacing: LATTICE_SPACING, tankMin: TANK_MIN, tankMax: TANK_MAX, tankOrigin: TANK_MIN }

/** Incompressible APIC-MAC (FINAL-PLAN S3): 8 ppc (V_p = dx³/8, §4.1), walls at the grid edge (SOLID faces of the
 *  window), no band. */
export const FLIP_PACKING: Packing = { ppc: 8, spacing: 1 / (GRID_RES * 2), tankMin: 0, tankMax: 1, tankOrigin: 0 }

export const packingFor = (solver: 'mpm' | 'flip'): Packing => (solver === 'mpm' ? MPM_PACKING : FLIP_PACKING)
/** The incompressible solver's packing in a tank of `cells` (grid cells per axis, dx fixed): [0, cells/64] wu per axis. */
export const flipPacking = (cells: Vec3): Packing => ({ ...FLIP_PACKING, tankHi: cells.map(c => c / GRID_RES) as Vec3 })
/** Occupancy keys cover up to OCC_CELLS cells per axis (a tank up to 5 m = 88 cells of today's dx). */
const OCC_CELLS = 128

/** Grid cells (dx-sized, keys up to OCC_CELLS per axis) holding at least one particle — the "already fluid" test. */
export function buildOccupancy(positions: Float32Array, n = positions.length / 3): Set<number> {
  const occ = new Set<number>()
  for (let i = 0; i < n; i++) occ.add(cellKey(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]))
  return occ
}

export function cellKey(x: number, y: number, z: number): number {
  const c = (v: number) => Math.min(OCC_CELLS - 1, Math.max(0, Math.floor(v * GRID_RES)))
  return (c(x) * OCC_CELLS + c(y)) * OCC_CELLS + c(z)
}

export interface LatticeResult {
  positions: Vec3[]
  /** Lattice volume actually filled (whole spacings per axis), in [0,1]³ units. */
  latticeVolume: number
  skippedOutside: number
  skippedOccupied: number
}

/** Fill the box [lo, lo+size) with lattice sites at rest packing, jittered by ±jitter·spacing.
 *  The lattice holds floor(size/spacing) sites per axis (≥ 1), CENTRED in the box, so it never
 *  pokes out of the box and particle count and filled volume agree exactly (the unfilled margin
 *  is < 1 spacing per axis). Sites outside the fluid region are rejected (never clamped onto a
 *  wall), and sites in `occupied` cells are skipped. */
export function latticeBox(lo: Vec3, size: Vec3, opts: { occupied?: Set<number>; jitter?: number; rng?: () => number; packing?: Packing } = {}): LatticeResult {
  const pk = opts.packing ?? MPM_PACKING
  const s = pk.spacing
  const hi = packingHi(pk)
  const jitter = opts.jitter ?? 0.25
  const rng = opts.rng ?? Math.random
  const counts = size.map(v => Math.max(1, Math.floor(v / s + 1e-9))) as Vec3
  const origin = lo.map((l, a) => l + (size[a] - counts[a] * s) / 2) as Vec3   // centre the lattice
  const positions: Vec3[] = []
  let skippedOutside = 0, skippedOccupied = 0
  for (let i = 0; i < counts[0]; i++) for (let j = 0; j < counts[1]; j++) for (let k = 0; k < counts[2]; k++) {
    const p: Vec3 = [
      origin[0] + (i + 0.5) * s + (rng() * 2 - 1) * jitter * s,
      origin[1] + (j + 0.5) * s + (rng() * 2 - 1) * jitter * s,
      origin[2] + (k + 0.5) * s + (rng() * 2 - 1) * jitter * s,
    ]
    if (p.some((v, a) => v < pk.tankMin || v > hi[a])) { skippedOutside++; continue }
    if (opts.occupied?.has(cellKey(p[0], p[1], p[2]))) { skippedOccupied++; continue }
    positions.push(p)
  }
  return { positions, latticeVolume: counts[0] * counts[1] * counts[2] * s ** 3, skippedOutside, skippedOccupied }
}

/** A near-cubic block holding ≈`count` particles at rest packing (nx = nz = round(∛count),
 *  ny chosen so nx·ny·nz is closest to count), centred on `center` but shifted — never shrunk —
 *  to lie inside the fluid region. Returns [lo, size] with sizes an exact number of spacings. */
export function cubeForCount(center: Vec3, count: number, packing: Packing = MPM_PACKING): { lo: Vec3; size: Vec3 } {
  const s = packing.spacing
  const hi = packingHi(packing)
  const maxN = hi.map(h => Math.floor((h - packing.tankMin) / s))
  const nxz = Math.min(maxN[0], maxN[2], Math.max(1, Math.round(Math.cbrt(count))))
  const ny = Math.min(maxN[1], Math.max(1, Math.round(count / (nxz * nxz))))
  const size: Vec3 = [nxz * s, ny * s, nxz * s]
  const lo = center.map((c, a) => Math.min(hi[a] - size[a], Math.max(packing.tankMin, c - size[a] / 2))) as Vec3
  return { lo, size }
}
