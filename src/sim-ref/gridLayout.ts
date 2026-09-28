// Grid layout for the incompressible APIC-MAC solver (FINAL-PLAN §5.2, S3). ONE index function, used by the
// f64 CPU reference (flipRef.ts) and — mirrored in WGSL — by every GPU kernel, so the two can be diffed cell by cell.
//
// Geometry (window-local metres, FINAL-PLAN S3N-5): the window spans [0, nx·dx] × [0, ny·dx] × [0, nz·dx]. Cell
// (i, j, k) has its centre at ((i+½)dx, (j+½)dx, (k+½)dx). A MAC grid stores each velocity component on the faces
// normal to its axis: u (x) at (i·dx, (j+½)dx, (k+½)dx), v (y) at ((i+½)dx, j·dx, (k+½)dx), w (z) likewise.
//
// Storage: every array — cells and all three face grids — has the PADDED shape (nx+2)(ny+2)(nz+2): one ghost layer
// per side (FINAL-PLAN §5.2 "ghost padding": the tangential trilinear stencil at a wall reads a valid slot, never
// out-of-bounds memory). Face (a; i, j, k) is stored in the slot of cell (i, j, k): it is that cell's LOWER face on
// axis a. The upper boundary face on axis a (index n_a) therefore lives in the upper ghost slot, and the tangential
// ghost faces (index −1 or n) in the ghost slots of those axes. Every logical index −1 … n maps to a distinct slot.
//
// Window-relative addressing (S3N-1): interior cells are stored toroidally — logical i ↦ 1 + ((i + ring) mod n) — so
// a window that shifts by whole cells rewrites only the new slab. A face moves with the cell it is the lower face of.
// Physics never sees `ring`; the s30 gate proves results are bit-identical for any ring.
//
// Non-cubic dimensions (S3N-2) are first-class: nothing here assumes nx = ny = nz.

export type Vec3 = [number, number, number]

/** Boundary condition type of a face (S3N-3). Interior faces are FLUID. */
export const FaceType = {
  FLUID: 0,
  /** u·n = u_solid·n (static walls: u_solid = 0). */
  SOLID: 1,
  /** Normal velocity prescribed from outside (window seams, WIN-1). Reserved: rejected until implemented. */
  OPEN: 2,
  /** Tangential ghost-layer face (index −1 or n on an axis other than its own). Filled by velocity extrapolation,
   *  i.e. free slip for interpolation — the inviscid pressure solve only constrains u·n at walls (FINAL-PLAN §4.1);
   *  wall friction belongs to the viscous solve (S3.6, no-slip). */
  GHOST: 3,
} as const
export type FaceType = (typeof FaceType)[keyof typeof FaceType]

export interface GridSpec {
  nx: number
  ny: number
  nz: number
  /** Cell size, metres. */
  dx: number
  /** Toroidal storage offsets of the interior cells (S3N-1). Default [0, 0, 0]. */
  ring?: Vec3
}

export class GridLayout {
  readonly nx: number
  readonly ny: number
  readonly nz: number
  readonly dx: number
  readonly ring: Vec3
  /** Padded extents and total slot count (identical for cells and each face grid). */
  readonly px: number
  readonly py: number
  readonly pz: number
  readonly size: number

  constructor(spec: GridSpec) {
    for (const [name, n] of [['nx', spec.nx], ['ny', spec.ny], ['nz', spec.nz]] as const) {
      if (!Number.isInteger(n) || n < 2) throw new RangeError(`GridLayout: ${name} must be an integer ≥ 2 (got ${n})`)
    }
    if (!(spec.dx > 0) || !Number.isFinite(spec.dx)) throw new RangeError(`GridLayout: dx must be a positive finite length (got ${spec.dx})`)
    this.nx = spec.nx
    this.ny = spec.ny
    this.nz = spec.nz
    this.dx = spec.dx
    const r = spec.ring ?? [0, 0, 0]
    if (!r.every(Number.isInteger)) throw new RangeError(`GridLayout: ring offsets must be integers (got ${r})`)
    this.ring = [mod(r[0], spec.nx), mod(r[1], spec.ny), mod(r[2], spec.nz)]
    this.px = spec.nx + 2
    this.py = spec.ny + 2
    this.pz = spec.nz + 2
    this.size = this.px * this.py * this.pz
  }

  /** Window extent in metres. */
  get extent(): Vec3 { return [this.nx * this.dx, this.ny * this.dx, this.nz * this.dx] }

  /** THE index function: logical (i, j, k), each in −1 … n, to a storage slot. Valid for cells and every face grid. */
  idx(i: number, j: number, k: number): number {
    return phys(i, this.nx, this.ring[0]) + this.px * (phys(j, this.ny, this.ring[1]) + this.py * phys(k, this.nz, this.ring[2]))
  }

  /** Window-local position (metres) of face (axis; i, j, k). */
  facePos(axis: 0 | 1 | 2, i: number, j: number, k: number): Vec3 {
    const h = this.dx
    return [(i + (axis === 0 ? 0 : 0.5)) * h, (j + (axis === 1 ? 0 : 0.5)) * h, (k + (axis === 2 ? 0 : 0.5)) * h]
  }

  /** Logical index range [lo, hi] of face grid `axis` on each dimension, ghosts included: 0 … n on its own axis,
   *  −1 … n (tangential ghosts) on the others. */
  faceRange(axis: 0 | 1 | 2): [Vec3, Vec3] {
    const n: Vec3 = [this.nx, this.ny, this.nz]
    const lo: Vec3 = [-1, -1, -1], hi: Vec3 = [n[0], n[1], n[2]]
    lo[axis] = 0
    return [lo, hi]
  }

  /** Default face types over the whole logical range: the two window sides normal to `axis` are SOLID walls,
   *  tangential ghost-layer faces are GHOST, everything else FLUID. One entry per slot. */
  defaultFaceTypes(axis: 0 | 1 | 2): Uint32Array {
    const t = new Uint32Array(this.size)
    const n = [this.nx, this.ny, this.nz]
    const [lo, hi] = this.faceRange(axis)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const c = [i, j, k]
      let type: FaceType = FaceType.FLUID
      for (let d = 0; d < 3; d++) if (d !== axis && (c[d] < 0 || c[d] >= n[d])) type = FaceType.GHOST
      if (type === FaceType.FLUID && (c[axis] === 0 || c[axis] === n[axis])) type = FaceType.SOLID
      t[this.idx(i, j, k)] = type
    }
    return t
  }
}

function mod(a: number, n: number): number { return ((a % n) + n) % n }

/** Logical index −1 … n on an axis of n interior cells → padded storage coordinate 0 … n+1. */
function phys(i: number, n: number, ring: number): number {
  if (i < 0) return 0
  if (i >= n) return n + 1
  return 1 + ((i + ring) % n)
}
