// mpmReplica.mjs — float64 CPU replica of one legacy MLS-MPM substep, for checking the viscous stability bound.
//
// Mirrors, line for line, the arithmetic of src/gpu-sim/shaders/:
//   p2g.wgsl        mass + APIC momentum scatter (quadratic B-spline, particle mass 1, Q = C·cell_dist)
//   p2g2.wgsl       density gather, V = 1/ρ, σ = −p I + μ (C + Cᵀ), impulse −V·4·σ·Δt·w·cell_dist
//   gridForces.wgsl momentum / mass → velocity (gravity, walls and the sphere are OMITTED: see below)
//   g2p.wgsl        v = Σ w u, C = 4 Σ w u ⊗ cell_dist, x += v·Δt
// Deliberately omitted (stated in every result that uses it): gravity (affine forcing), the wall band (only zeroes
// velocity components), the sphere obstacle, f32 arithmetic, the fixed-point i32 grid encoding and its ±200 clamp.
// Pressure (the Tait-like EOS, STIFFNESS 3, REST_DENSITY 4) is optional so the viscous operator can be tested alone.
// Units: grid cells and τ, positions in [0, 64) grid space.

const REST_DENSITY = 4.0
const STIFFNESS = 3.0

/** Quadratic B-spline weights of one axis, exactly as the shaders compute them. */
export function axisWeights(x) {
  const c = Math.floor(x)
  const d = x - (c + 0.5)
  return { c, w: [0.5 * (0.5 - d) ** 2, 0.75 - d * d, 0.5 * (0.5 + d) ** 2] }
}

/** Particle: { x: [3], v: [3], C: [[3],[3],[3]] row-major (C[r][c]) }. */
export function particle(x, v = [0, 0, 0], C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]) {
  return { x: [...x], v: [...v], C: C.map(r => [...r]) }
}

function stencil(p) {
  const X = axisWeights(p.x[0]), Y = axisWeights(p.x[1]), Z = axisWeights(p.x[2])
  const out = []
  for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) for (let gz = 0; gz < 3; gz++) {
    const i = X.c + gx - 1, j = Y.c + gy - 1, k = Z.c + gz - 1
    out.push({
      key: (i * 4096 + j) * 4096 + k + 2 ** 40, // unique for |i|,|j|,|k| < 2048
      w: X.w[gx] * Y.w[gy] * Z.w[gz],
      d: [i + 0.5 - p.x[0], j + 0.5 - p.x[1], k + 0.5 - p.x[2]],
    })
  }
  return out
}

const matVec = (M, d) => [0, 1, 2].map(r => M[r][0] * d[0] + M[r][1] * d[1] + M[r][2] * d[2])

/** Advance particles P by one substep (mutates P). Returns the per-particle code densities ρ_p used by p2g2. */
export function step(P, { mu, dt, pressure = false }) {
  const grid = new Map()
  const st = P.map(stencil)
  // p2g
  P.forEach((p, n) => {
    for (const s of st[n]) {
      let g = grid.get(s.key)
      if (!g) grid.set(s.key, (g = { m: 0, q: [0, 0, 0], u: [0, 0, 0] }))
      const Q = matVec(p.C, s.d)
      g.m += s.w
      for (let r = 0; r < 3; r++) g.q[r] += s.w * (p.v[r] + Q[r])
    }
  })
  // p2g2 (reads the pass-1 mass; the scattered impulses are added after all densities are gathered, as on the GPU
  // where the mass slot is not modified by pass 2)
  const rho = new Array(P.length)
  const impulses = []
  P.forEach((p, n) => {
    let density = 0
    for (const s of st[n]) density += grid.get(s.key).m * s.w
    rho[n] = density
    const volume = 1 / density
    const pr = pressure ? Math.max(0, STIFFNESS * ((density / REST_DENSITY) ** 5 - 1)) : 0
    const S = [0, 1, 2].map(r => [0, 1, 2].map(c => mu * (p.C[r][c] + p.C[c][r]) - (r === c ? pr : 0)))
    for (const s of st[n]) {
      const f = matVec(S, s.d).map(x => -volume * 4 * dt * s.w * x)
      impulses.push([s.key, f])
    }
  })
  for (const [key, f] of impulses) { const g = grid.get(key); for (let r = 0; r < 3; r++) g.q[r] += f[r] }
  // gridForces (velocity only)
  for (const g of grid.values()) for (let r = 0; r < 3; r++) g.u[r] = g.m > 0 ? g.q[r] / g.m : 0
  // g2p
  P.forEach((p, n) => {
    const v = [0, 0, 0], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (const s of st[n]) {
      const u = grid.get(s.key).u
      for (let r = 0; r < 3; r++) {
        v[r] += s.w * u[r]
        for (let c = 0; c < 3; c++) B[r][c] += s.w * u[r] * s.d[c]
      }
    }
    p.v = v
    p.C = B.map(row => row.map(x => 4 * x))
    for (let r = 0; r < 3; r++) p.x[r] += v[r] * dt
  })
  return rho
}

/** The norm in which one viscous substep is a contraction: Σ_p (|v_p|² + ¼|C_p|²_F) (APIC kinetic energy ×2). */
export function energy(P) {
  let e = 0
  for (const p of P) {
    e += p.v[0] ** 2 + p.v[1] ** 2 + p.v[2] ** 2
    for (const row of p.C) e += 0.25 * (row[0] ** 2 + row[1] ** 2 + row[2] ** 2)
  }
  return e
}

export const maxAbsC = (P) => Math.max(...P.map(p => Math.max(...p.C.flat().map(Math.abs))))

/** Deterministic PRNG (mulberry32) so gate runs are reproducible. */
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
