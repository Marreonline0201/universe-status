#!/usr/bin/env node
// Gate S3.0 — the f64 CPU reference of the APIC-MAC solver (src/sim-ref/flipRef.ts), transfer stage (S3.1a physics).
// CPU only; imports the REAL src modules (lib/loadTs.mjs). Tolerances are FINAL-PLAN §7 S3.1a's, fixed before running.
//
//   node scripts/fluid-gates/s30-ref.mjs
//
// R1 linear field: 16³, u = u0 + A·x (A random, non-symmetric), c_a = ∇u_a; ONE P2G → G2P. Every particle whose
//    stencil faces all received mass reproduces u and c to ≤ 1e-5 relative (trilinear APIC-MAC is exact for linear
//    fields, §5.4). POSITIVE CONTROL: the same test with PIC transfers must FAIL (error > 1e-3).
// R2 rigid rotation about the COM: angular momentum after one transfer within 1e-5 relative (a c ≡ 0 bug fails it,
//    where a ballistic test would pass). POSITIVE CONTROL: PIC loses more than 1e-3.
// R3 ballistic blob, g = 9.80665 m/s² along −y, no contact: 3-parameter fit g_fit within ±0.5 %; the position error
//    against the analytic trajectory halves (ratio 0.45–0.55) when Δt halves (first order, symplectic Euler).
// R4 window-relative addressing (S3N-1): R3 with ring offsets (3, 5, 7) is BIT-IDENTICAL to ring (0, 0, 0).
// R5 non-cubic grid (S3N-2): R1 on 24×16×12 with a ring offset.
// R6 gravity is a vector (S3N-6): R3 with g along +x gives g_fit on x and no drift on y, z.
// R7 advection order: particles advected through a STEADY rigid-rotation grid field (ω = 2 rad/s, Δt = 1/120 s,
//    1 s; advect() alone) keep their mean radius within 1e-4 relative. RK2 midpoint predicts growth (hω)⁴/8 per step
//    ≈ 1.2e-6 over 1 s; forward Euler (hω)²/2 per step ≈ 1.7e-2 — the uniform-velocity R3 cannot tell them apart.
// R7b Newton's first law: WITHOUT pressure (projection arrives in S3.1b) nothing supplies the centripetal force, so a
//    spinning blob must fly apart like free particles, r(t) = r0·√(1 + (ωt)²). Reported with its Δt-convergence
//    (the transfer-only scheme keeps c_p fixed between G2P calls, so it is not exact here).
// R9 walls: a blob at rest against the x = 0 wall and the floor, one step (g = 0): every face a G2P or advection
//    stencil reads holds a velocity (no unset reads), wall-normal faces hold exactly 0 although particles deposited
//    momentum on them, and nothing moves.
// R8 the index function is a bijection from the full logical range (−1 … n per axis) onto the storage slots, for
//    ring 0 and ring (3,5,7), and a non-zero ring really moves interior slots (else R4 would be vacuous).
import { loadTsModules } from './lib/loadTs.mjs'

// FLUID_REF_SRC lets s30-mutations.mjs point the gate at a mutated copy of src/sim-ref.
const SRC = process.env.FLUID_REF_SRC ?? 'src/sim-ref'
const { gridLayout, flipRef } = await loadTsModules({ gridLayout: `${SRC}/gridLayout.ts`, flipRef: `${SRC}/flipRef.ts` })
const { GridLayout } = gridLayout
const { FlipRef, makeParticles, angularMomentum, centreOfMass } = flipRef

const G = 9.80665                 // m/s², NIST standard gravity
const DX = 3.63 / 64              // m, the default tank cell (src/fluid-engine/units.ts)
const RHO = 998.2072              // kg/m³, water 20 °C (NIST)
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** 8 ppc jittered inside their 2×2×2 sub-cells (FINAL-PLAN §5.8), filling cells lo..hi (inclusive, per axis). */
function blob(lo, hi, rng) {
  const pts = []
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
    for (let s = 0; s < 8; s++) {
      const sx = s & 1, sy = (s >> 1) & 1, sz = (s >> 2) & 1
      pts.push([(i + (sx + rng()) / 2) * DX, (j + (sy + rng()) / 2) * DX, (k + (sz + rng()) / 2) * DX])
    }
  const p = makeParticles(pts.length)
  const vp = DX ** 3 / 8
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = RHO * vp })
  return p
}

/** R1/R5: linear-field reproduction on grid (nx, ny, nz) with ring offsets; returns worst relative errors. */
function linearField({ n = [16, 16, 16], ring = [0, 0, 0], apic = true, seed = 11 }) {
  const rng = mulberry32(seed)
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const sim = new FlipRef(L, { apic })
  const p = blob([3, 3, 3], [n[0] - 4, n[1] - 4, n[2] - 4], rng)
  const u0 = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]
  const A = [0, 1, 2].map(() => [0, 1, 2].map(() => (rng() * 2 - 1) * 3))   // 1/s, non-symmetric
  const exact = (x, a) => u0[a] + A[a][0] * x[0] + A[a][1] * x[1] + A[a][2] * x[2]
  for (let q = 0; q < p.n; q++) {
    const x = [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]]
    for (let a = 0; a < 3; a++) { p.vel[3 * q + a] = exact(x, a); p.c[a].set(A[a], 3 * q) }
  }
  sim.p2g(p); sim.gridUpdate(0); sim.extrapolate(); sim.applySolidFaces(); sim.g2p(p)
  let vScale = 0, aScale = 0, ev = 0, ec = 0, checked = 0
  for (const row of A) for (const v of row) aScale = Math.max(aScale, Math.abs(v))
  for (let q = 0; q < p.n; q++) {
    const x = [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]]
    for (let a = 0; a < 3; a++) vScale = Math.max(vScale, Math.abs(exact(x, a)))
  }
  for (let q = 0; q < p.n; q++) {
    const x = [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]]
    checked++
    for (let a = 0; a < 3; a++) {
      ev = Math.max(ev, Math.abs(p.vel[3 * q + a] - exact(x, a)) / vScale)
      for (let b = 0; b < 3; b++) ec = Math.max(ec, Math.abs(p.c[a][3 * q + b] - A[a][b]) / aScale)
    }
  }
  return { ev, ec, checked, unset: sim.diag.unsetFaceReads }
}

// R1
{
  const r = linearField({})
  check(r.ev <= 1e-5 && r.ec <= 1e-5 && r.unset === 0, `R1 linear field 16³, ${r.checked} particles (every one): max rel error v ${r.ev.toExponential(2)}, c ${r.ec.toExponential(2)} (≤ 1e-5); unset-face reads ${r.unset}`)
  const c = linearField({ apic: false })
  check(c.ev > 1e-3, `R1 positive control: PIC transfers on the same field → v error ${c.ev.toExponential(2)} (must be > 1e-3, else R1 cannot detect a lost affine term)`)
}

// R2
function rotation(apic) {
  const rng = mulberry32(22)
  const L = new GridLayout({ nx: 16, ny: 16, nz: 16, dx: DX })
  const sim = new FlipRef(L, { apic })
  const p = blob([3, 3, 3], [12, 12, 12], rng)
  const o = centreOfMass(p)
  const w = [1.3, -0.7, 2.1]   // rad/s
  for (let q = 0; q < p.n; q++) {
    const r = [p.pos[3 * q] - o[0], p.pos[3 * q + 1] - o[1], p.pos[3 * q + 2] - o[2]]
    p.vel.set([w[1] * r[2] - w[2] * r[1], w[2] * r[0] - w[0] * r[2], w[0] * r[1] - w[1] * r[0]], 3 * q)
    p.c[0].set([0, -w[2], w[1]], 3 * q); p.c[1].set([w[2], 0, -w[0]], 3 * q); p.c[2].set([-w[1], w[0], 0], 3 * q)
  }
  const L0 = angularMomentum(p, o)
  sim.p2g(p); sim.gridUpdate(0); sim.extrapolate(); sim.applySolidFaces(); sim.g2p(p)
  const L1 = angularMomentum(p, o)
  const mag = Math.hypot(...L0)
  return Math.hypot(L1[0] - L0[0], L1[1] - L0[1], L1[2] - L0[2]) / mag
}
{
  const e = rotation(true), ePic = rotation(false)
  check(e <= 1e-5, `R2 rigid rotation: |ΔL|/|L| after one transfer ${e.toExponential(2)} (≤ 1e-5)`)
  check(ePic > 1e-3, `R2 positive control: PIC loses |ΔL|/|L| = ${ePic.toExponential(2)} (must be > 1e-3)`)
}

// R3 / R4 / R6
function ballistic({ dt, ring = [0, 0, 0], gvec = [0, -G, 0], v0 = [1.2, 2.5, -0.7], T = 0.2 }) {
  const rng = mulberry32(33)
  const L = new GridLayout({ nx: 32, ny: 32, nz: 32, dx: DX, ring })
  const sim = new FlipRef(L, { gravity: gvec })
  const p = blob([10, 8, 13], [15, 13, 18], rng)
  for (let q = 0; q < p.n; q++) p.vel.set(v0, 3 * q)
  const steps = Math.round(T / dt)
  const ts = [0], cs = [centreOfMass(p)]
  for (let s = 1; s <= steps; s++) { sim.step(p, dt); ts.push(s * dt); cs.push(centreOfMass(p)) }
  return { ts, cs, p, sim, steps }
}
function fitQuad(ts, ys) {
  const S = k => ts.reduce((s, t) => s + t ** k, 0), Ty = k => ts.reduce((s, t, i) => s + ys[i] * t ** k, 0)
  const M = [[S(0), S(1), S(2)], [S(1), S(2), S(3)], [S(2), S(3), S(4)]], r = [Ty(0), Ty(1), Ty(2)]
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const D = det(M)
  return [0, 1, 2].map(j => det(M.map((row, i) => row.map((v, k) => (k === j ? r[i] : v)))) / D)
}
{
  const T = 0.2, v0 = [1.2, 2.5, -0.7]
  const a = ballistic({ dt: 1 / 120 }), b = ballistic({ dt: 1 / 240 })
  const gFit = -2 * fitQuad(a.ts, a.cs.map(c => c[1]))[2]
  const errAt = run => {
    const c0 = run.cs[0], cN = run.cs[run.cs.length - 1]
    const ex = [c0[0] + v0[0] * T, c0[1] + v0[1] * T - 0.5 * G * T * T, c0[2] + v0[2] * T]
    return Math.hypot(cN[0] - ex[0], cN[1] - ex[1], cN[2] - ex[2])
  }
  const eA = errAt(a), eB = errAt(b)
  check(Math.abs(gFit - G) / G <= 0.005 && a.sim.diag.wallClamps === 0 && a.sim.diag.unsetFaceReads === 0,
    `R3 ballistic, Δt 1/120 s × ${a.steps}: g_fit ${gFit.toFixed(5)} m/s² (${(100 * (gFit - G) / G).toFixed(3)} %, ±0.5 %); wall clamps ${a.sim.diag.wallClamps}; unset-face reads ${a.sim.diag.unsetFaceReads}`)
  check(eB / eA >= 0.45 && eB / eA <= 0.55, `R3 first-order convergence: position error ${ (eA * 1000).toFixed(3)} mm → ${(eB * 1000).toFixed(3)} mm when Δt halves, ratio ${(eB / eA).toFixed(4)} (0.45–0.55); analytic ½·g·T·Δt = ${(0.5 * G * T / 120 * 1000).toFixed(3)} mm`)

  const r = ballistic({ dt: 1 / 120, ring: [3, 5, 7] })
  let same = r.p.pos.length === a.p.pos.length
  for (let i = 0; same && i < a.p.pos.length; i++) same = Object.is(r.p.pos[i], a.p.pos[i]) && Object.is(r.p.vel[i], a.p.vel[i])
  for (let ax = 0; same && ax < 3; ax++) for (let i = 0; same && i < a.p.c[ax].length; i++) same = Object.is(r.p.c[ax][i], a.p.c[ax][i])
  check(same, `R4 ring offsets (3,5,7) vs (0,0,0) after ${a.steps} steps: particle position, velocity and affine state bit-identical`)

  const x = ballistic({ dt: 1 / 120, gvec: [G, 0, 0], v0: [-1.2, 0.4, 0.3] })
  const gx = 2 * fitQuad(x.ts, x.cs.map(c => c[0]))[2], gy = 2 * fitQuad(x.ts, x.cs.map(c => c[1]))[2], gz = 2 * fitQuad(x.ts, x.cs.map(c => c[2]))[2]
  check(Math.abs(gx - G) / G <= 0.005 && Math.abs(gy) <= 0.005 * G && Math.abs(gz) <= 0.005 * G,
    `R6 gravity along +x: fitted acceleration (${gx.toFixed(4)}, ${gy.toExponential(1)}, ${gz.toExponential(1)}) m/s²`)
}

// R5
{
  const r = linearField({ n: [24, 16, 12], ring: [5, 2, 9], seed: 55 })
  check(r.ev <= 1e-5 && r.ec <= 1e-5 && r.unset === 0, `R5 non-cubic 24×16×12, ring (5,2,9): max rel error v ${r.ev.toExponential(2)}, c ${r.ec.toExponential(2)} over ${r.checked} particles`)
}

// R7
{
  const rng = mulberry32(77)
  const L = new GridLayout({ nx: 32, ny: 32, nz: 32, dx: DX })
  const sim = new FlipRef(L)
  const p = blob([10, 10, 13], [21, 21, 18], rng)
  const o = centreOfMass(p), w = 2
  // prescribe the steady field u = ω ẑ × (x − o) on every face of all three grids
  for (const a of [0, 1, 2]) {
    const [lo, hi] = L.faceRange(a)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const f = L.facePos(a, i, j, k), s = L.idx(i, j, k)
      sim.u[a][s] = a === 0 ? -w * (f[1] - o[1]) : a === 1 ? w * (f[0] - o[0]) : 0
      sim.valid[a][s] = 1
    }
  }
  const radius = () => { let r = 0; for (let q = 0; q < p.n; q++) r += Math.hypot(p.pos[3 * q] - o[0], p.pos[3 * q + 1] - o[1]); return r / p.n }
  const r0 = radius()
  for (let s = 0; s < 120; s++) sim.advect(p, 1 / 120)
  const drift = radius() / r0 - 1
  check(Math.abs(drift) <= 1e-4 && sim.diag.wallClamps === 0 && sim.diag.unsetFaceReads === 0, `R7 advection through a steady rotation field, 1 s (ω 2 rad/s, Δt 1/120): mean radius drift ${drift.toExponential(2)} (≤ 1e-4; RK2 predicts ≈ 1.2e-6, Euler ≈ 1.7e-2)`)
}

// R7b
{
  const free = dt => {
    const rng = mulberry32(78)
    const L = new GridLayout({ nx: 48, ny: 48, nz: 32, dx: DX })
    const sim = new FlipRef(L)
    const p = blob([19, 19, 13], [28, 28, 18], rng)
    const o = centreOfMass(p), w = 2, T = 0.5
    const r0s = []
    for (let q = 0; q < p.n; q++) {
      const rx = p.pos[3 * q] - o[0], ry = p.pos[3 * q + 1] - o[1]
      r0s.push(Math.hypot(rx, ry))
      p.vel.set([-w * ry, w * rx, 0], 3 * q)
      p.c[0].set([0, -w, 0], 3 * q); p.c[1].set([w, 0, 0], 3 * q); p.c[2].set([0, 0, 0], 3 * q)
    }
    for (let s = 0; s < Math.round(T / dt); s++) sim.step(p, dt)
    let err = 0, mean = 0
    for (let q = 0; q < p.n; q++) {
      const r = Math.hypot(p.pos[3 * q] - o[0], p.pos[3 * q + 1] - o[1]), ex = r0s[q] * Math.sqrt(1 + (w * T) ** 2)
      err += Math.abs(r - ex); mean += ex
    }
    return { rel: err / mean, clamps: sim.diag.wallClamps }
  }
  const a = free(1 / 120), b = free(1 / 240)
  info(`R7b free flight of a spinning blob, 0.5 s (no pressure yet): mean |r − r0·√(1+(ωt)²)| / r = ${a.rel.toExponential(2)} at Δt 1/120, ${b.rel.toExponential(2)} at 1/240 (ratio ${(b.rel / a.rel).toFixed(3)}); wall clamps ${a.clamps + b.clamps}`)
}

// R8
{
  const bij = ring => {
    const L = new GridLayout({ nx: 7, ny: 5, nz: 4, dx: DX, ring })
    const seen = new Uint8Array(L.size)
    let dup = 0, out = 0
    for (let k = -1; k <= 4; k++) for (let j = -1; j <= 5; j++) for (let i = -1; i <= 7; i++) {
      const s = L.idx(i, j, k)
      if (!(s >= 0 && s < L.size)) out++
      else if (seen[s]++) dup++
    }
    return { dup, out, covered: seen.reduce((a, v) => a + (v ? 1 : 0), 0), size: L.size, origin: L.idx(0, 0, 0) }
  }
  const a = bij([0, 0, 0]), b = bij([3, 5, 7])
  check(a.dup === 0 && a.out === 0 && a.covered === a.size && b.dup === 0 && b.out === 0 && b.covered === b.size && a.origin !== b.origin,
    `R8 idx bijective over the logical range (ring 0: ${a.covered}/${a.size} slots, ring (3,5,7): ${b.covered}/${b.size}); cell (0,0,0) at slot ${a.origin} vs ${b.origin}`)
}

// R9
{
  const rng = mulberry32(99)
  const L = new GridLayout({ nx: 16, ny: 16, nz: 16, dx: DX })
  const sim = new FlipRef(L)
  const p = blob([0, 0, 5], [3, 3, 10], rng)
  for (let q = 0; q < p.n; q++) p.vel.set([-0.3, -0.2, 0], 3 * q)   // moving INTO both walls: P2G deposits momentum on wall faces
  sim.p2g(p)
  let wallMom = 0
  for (let k = 0; k < 16; k++) for (let j = 0; j < 16; j++) wallMom += Math.abs(sim.mom[0][L.idx(0, j, k)]) + Math.abs(sim.mom[1][L.idx(j, 0, k)])
  sim.gridUpdate(0); sim.extrapolate(); sim.applySolidFaces()
  let wallU = 0, wallValid = true
  for (let k = 0; k < 16; k++) for (let j = 0; j < 16; j++) {
    for (const [a, s1] of [[0, L.idx(0, j, k)], [0, L.idx(16, j, k)], [1, L.idx(j, 0, k)], [1, L.idx(j, 16, k)]]) { wallU = Math.max(wallU, Math.abs(sim.u[a][s1])); wallValid &&= sim.valid[a][s1] === 1 }
  }
  for (let q = 0; q < p.n; q++) p.vel.fill(0, 3 * q, 3 * q + 3), p.c.forEach(c => c.fill(0, 3 * q, 3 * q + 3))
  const before = p.pos.slice()
  sim.step(p, 1 / 120)
  let moved = 0
  for (let i = 0; i < p.pos.length; i++) moved = Math.max(moved, Math.abs(p.pos[i] - before[i]))
  check(wallMom > 0 && wallU === 0 && wallValid && sim.diag.unsetFaceReads === 0 && moved === 0,
    `R9 blob against two walls: momentum deposited on wall faces ${wallMom.toExponential(2)} kg·m/s → wall-normal u ${wallU} (must be 0, all set: ${wallValid}); unset-face reads ${sim.diag.unsetFaceReads}; max displacement at rest ${moved} m`)
}

// Grid-side angular momentum after P2G (MAC transfers: claim UNVERIFIED in the plan, reported not gated)
info('grid-side angular momentum of MAC transfers is not gated here (FINAL-PLAN §5.4: tested at S3.1a on the GPU path)')

console.log(`\ns3.0 reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}`)
process.exit(fails === 0 ? 0 : 1)
