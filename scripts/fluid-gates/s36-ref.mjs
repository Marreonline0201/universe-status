#!/usr/bin/env node
// Gate S3.6 on the f64 CPU reference — implicit variational viscosity (Batty & Bridson 2008), FINAL-PLAN S3.6.
// Spec (criteria fixed before the first run): vault fluid/realism-2026-09/S3.6-viscosity-spec.md.
//
//   node scripts/fluid-gates/s36-ref.mjs [a|c|f|b|d]...   (default: all)
//   S36_SCHEME=stokes …   the same setups and criteria on S3.6e's unified pressure–stress solve (Larionov et al. 2017;
//                         its tolerance = the case's pressure tolerance, ‖r‖∞ in 1/s). Under it, f is D1-S (water wave:
//                         the Stokes path vs the ghost-fluid projection) and b is E2 on the Stokes path.
//
// S3.6a viscous decay of the 2D Taylor–Green mode u = A sin(kx)cos(ky), v = −A cos(kx)sin(ky), k = π/L, filling a closed
//       box with free-slip walls in the viscous solve (the exact mirror of the periodic mode FINAL-PLAN names; an exact
//       Stokes and Navier–Stokes solution, decaying as exp(−2νk²t)). NOT with a free surface on top: zero traction there
//       also needs −p + 2μ ∂v/∂y = 0, and the mode has ∂v/∂y ≠ 0 at y = L (measured: lava 24 % off). L = 8/16/32 cells, honey 14 % water
//       (μ 40 Pa·s, ρ 1415 kg/m³) and lava 1200 °C (GRD, μ 192.65 Pa·s, ρ 2600). ν_eff = −ln(A/A₀)/(2k²t) from a
//       least-squares fit of ln A; the scheme's own numerical viscosity ν_num for the SAME mode and L is measured with
//       the viscous solve off and subtracted. Pass: |(ν_eff − ν_num)/ν − 1| ≤ 5 %.
import { loadTsModules } from './lib/loadTs.mjs'
import { fitOmega, nuNum } from './lib/s34metrics.mjs'

const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef, mat } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts` })
const { GridLayout } = gridLayout, { FlipRef, makeParticles, kineticEnergy } = flipRef
const G = 9.80665
const DX = 3.63 / 64
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
const SCHEME = process.env.S36_SCHEME ?? 'split'
if (SCHEME !== 'split' && SCHEME !== 'stokes') throw new Error(`S36_SCHEME must be split or stokes, not ${SCHEME}`)
/** The viscous solve's report on either scheme: iterations and the residual (split: ‖r‖₂/‖b‖₂; stokes: ‖b − Ay‖∞, 1/s). */
const vstats = sim => (sim.lastStokes ? { iterations: sim.lastStokes.iterations, relResidual: sim.lastStokes.trueResidualInf, muFallbacks: sim.lastStokes.muFallbacks } : sim.lastViscosity)
const want = process.argv.slice(2).length ? new Set(process.argv.slice(2)) : new Set(['a', 'c', 'f', 'b', 'd'])
const t0 = Date.now()
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** 8 ppc jittered 2×2×2 sub-cells over the whole window, density rho, viscosity mu. */
function fillBox(L, rho, mu, rng) {
  const pts = []
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++)
    for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX])
  const p = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length).fill(mu)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = rho * DX ** 3 / 8 })
  return p
}
/** Least-squares slope of y(t). */
function slope(ts, ys) {
  const n = ts.length, tm = ts.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += (ts[i] - tm) * (ys[i] - ym); sxx += (ts[i] - tm) ** 2 }
  return sxy / sxx
}

// ── S3.6a ──
const HONEY = { name: 'honey 14 % water', mu: 40, rho: 1415 }
const LAVA = { name: 'lava 1200 °C (GRD)', mu: 10 ** (-4.55 + 5963 / (1200 + 273.15 - 600.7)), rho: 2600 }   // GRD, T in K: 192.65 Pa·s (materials gate G3)
function taylorGreen(cells, m, viscosity) {
  const L = new GridLayout({ nx: cells, ny: cells, nz: 4, dx: DX })
  const sim = new FlipRef(L, { gravity: [0, 0, 0], density: m.rho, projection: true, densityProjection: true, freeSurface: 'ghost',
    pressureTolerance: 1e-9, psiTolerance: 1e-9, viscosity: viscosity ? 'force' : 'off', viscousWalls: 'free-slip', viscosityDefault: m.mu, viscosityScheme: SCHEME, stokesTolerance: 1e-9 })
  const p = fillBox(L, m.rho, m.mu, mulberry32(60 + cells))
  const k = Math.PI / (cells * DX), A0 = 0.05
  const shape = (x, y) => [Math.sin(k * x) * Math.cos(k * y), -Math.cos(k * x) * Math.sin(k * y)]
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1]
    const [su, sv] = shape(x, y)
    p.vel.set([A0 * su, A0 * sv, 0], 3 * q)
    p.c[0].set([A0 * k * Math.cos(k * x) * Math.cos(k * y), -A0 * k * Math.sin(k * x) * Math.sin(k * y), 0], 3 * q)
    p.c[1].set([A0 * k * Math.sin(k * x) * Math.sin(k * y), -A0 * k * Math.cos(k * x) * Math.cos(k * y), 0], 3 * q)
  }
  const amp = () => {   // mass-weighted projection of the particle velocities on the mode shape
    let num = 0, den = 0
    for (let q = 0; q < p.n; q++) {
      const [su, sv] = shape(p.pos[3 * q], p.pos[3 * q + 1])
      num += p.mass[q] * (p.vel[3 * q] * su + p.vel[3 * q + 1] * sv); den += p.mass[q] * (su * su + sv * sv)
    }
    return num / den
  }
  const dt = 1 / 120, ts = [], ys = []
  const nu = m.mu / m.rho, T = Math.min(0.5, 1.5 / (2 * nu * k * k))   // ≤ 1.5 e-folds of the physical decay
  let last = null
  for (let s = 1; s * dt <= T + 1e-9; s++) { sim.step(p, dt); ts.push(s * dt); ys.push(Math.log(Math.abs(amp()) / A0)); last = vstats(sim) }
  return { nuEff: -slope(ts, ys) / (2 * k * k), k, T, steps: ts.length, visc: last }
}
if (want.has('a')) {
  for (const m of [HONEY, LAVA]) for (const cells of [8, 16, 32]) {
    const nu = m.mu / m.rho
    const off = taylorGreen(cells, m, false), on = taylorGreen(cells, m, true)
    const err = (on.nuEff - off.nuEff) / nu - 1
    check(Math.abs(err) <= 0.05, `S3.6a Taylor–Green, ${m.name} (ν ${nu.toExponential(3)} m²/s), L = ${cells} cells, ${on.steps} steps: ν_eff ${on.nuEff.toExponential(3)}, scheme ν_num ${off.nuEff.toExponential(3)} (viscous solve off) → (ν_eff − ν_num)/ν − 1 = ${(100 * err).toFixed(2)} % (±5 %); PCG ${on.visc?.iterations} it, rel. residual ${on.visc?.relResidual.toExponential(1)}, μ fallbacks ${on.visc?.muFallbacks}`)
  }
}

// ── S3.6c layered Couette: which μ average ships ──
// Two layers filling a 4×16×4 box, x periodic (viscous solve only — gate hook), bottom wall still, top wall moving at U,
// z walls free-slip; μ₁ = 1 Pa·s below, μ₂ = 1e3 or 1e5 Pa·s above; interface cell-aligned (y = 8·dx) and mid-cell
// (8.5·dx). One viscous solve with Δt = 1e6 s is the steady Stokes problem (the mass term is 1e-6 of the viscous one).
// Exact: τ = U/(h₁/μ₁ + h₂/μ₂), u piecewise linear. Pass (fixed before the first run): the low-viscosity layer's shear
// rate (fit over rows ≥ 1.5·dx from the interface) within 5 % of τ/μ₁, and u at the interface within 5 %·U. The rule
// (arithmetic or harmonic) that passes all four cases ships as the default; both are reported.
function couette(mean, contrast, yi) {
  const L = new GridLayout({ nx: 4, ny: 16, nz: 4, dx: DX }), U = 0.1, mu1 = 1, mu2 = contrast
  const sim = new FlipRef(L, { gravity: [0, 0, 0], density: 1000, projection: true, freeSurface: 'ghost', viscosity: 'force', viscosityMean: mean, viscosityScheme: SCHEME, stokesTolerance: 1e-9,
    viscousTestBC: { periodicX: true, walls: { 'y-': { slip: 'no-slip' }, 'y+': { slip: 'no-slip', velocity: [U, 0, 0] }, 'z-': { slip: 'free-slip' }, 'z+': { slip: 'free-slip' } } } })
  const p = fillBox(L, 1000, mu1, mulberry32(70))
  for (let q = 0; q < p.n; q++) if (p.pos[3 * q + 1] >= yi) p.mu[q] = mu2
  sim.p2g(p); sim.gridUpdate(1 / 120); sim.applySolidFaces(); sim.classifyLevelSet(p)
  if (SCHEME === 'stokes') sim.stokesSolve(p, 1e6); else sim.viscositySolve(p, 1e6)
  const st = vstats(sim)
  const prof = []
  for (let j = 0; j < L.ny; j++) {
    let s = 0
    for (let k = 0; k < L.nz; k++) for (let i = 0; i < L.nx; i++) s += sim.u[0][L.idx(i, j, k)]
    prof.push({ y: (j + 0.5) * DX, u: s / (L.nx * L.nz) })
  }
  const H = L.ny * DX, tau = U / (yi / mu1 + (H - yi) / mu2)
  const exact = y => (y < yi ? tau * y / mu1 : tau * yi / mu1 + tau * (y - yi) / mu2)
  const low = prof.filter(r => r.y <= yi - 1.5 * DX)
  const rate = slope(low.map(r => r.y), low.map(r => r.u))
  // u at the interface: linear interpolation of the profile
  let ui = NaN
  for (let j = 0; j + 1 < prof.length; j++) if (prof[j].y <= yi && prof[j + 1].y >= yi) ui = prof[j].u + (prof[j + 1].u - prof[j].u) * (yi - prof[j].y) / DX
  return { rateErr: rate / (tau / mu1) - 1, uiErr: (ui - exact(yi)) / U, it: st.iterations, res: st.relResidual }
}
if (want.has('c')) {
  const passes = {}
  for (const mean of ['arithmetic', 'harmonic']) {
    passes[mean] = true
    for (const contrast of [1e3, 1e5]) for (const [yi, where] of [[8 * DX, 'cell-aligned'], [8.5 * DX, 'mid-cell']]) {
      const r = couette(mean, contrast, yi)
      const ok = Math.abs(r.rateErr) <= 0.05 && Math.abs(r.uiErr) <= 0.05
      if (!ok) passes[mean] = false
      info(`S3.6c ${mean} mean, contrast ${contrast.toExponential(0)}, ${where} interface: low-layer shear rate ${(100 * r.rateErr).toFixed(2)} %, interface velocity ${(100 * r.uiErr).toFixed(2)} % of U (each ±5 %) → ${ok ? 'ok' : 'FAILS'}; PCG ${r.it} it, rel. residual ${r.res.toExponential(1)}`)
    }
  }
  const shipped = new FlipRef(new GridLayout({ nx: 4, ny: 4, nz: 4, dx: DX }), { freeSurface: 'ghost', viscosity: 'force' }).viscosityMean
  check(passes[shipped], `S3.6c layered Couette decides the μ average: arithmetic ${passes.arithmetic ? 'passes' : 'fails'}, harmonic ${passes.harmonic ? 'passes' : 'fails'} all four cases; the shipped default is ${shipped}`)
}

// ── the D1 standing wave with a material (s34-ref D1 setup: λ = 56 cells, kH = π, 8 cells deep, ε = 0.05) ──
function standingWave(cellsPerH, m, viscosity, walls, periods = 4, seed = 50 + cellsPerH) {
  const Lphys = 56 * DX, Hphys = 28 * DX, h = Hphys / cellsPerH
  const nx = Math.round(Lphys / h), nh = cellsPerH
  const L = new GridLayout({ nx, ny: 2 * Math.ceil(1.5 * nh / 2), nz: 8, dx: h })
  const sim = new FlipRef(L, { gravity: [0, -G, 0], density: m.rho, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5,
    viscosity, viscousWalls: walls, viscosityDefault: m.mu, viscosityScheme: SCHEME, stokesTolerance: 1e-6 })
  const pts = [], rng = mulberry32(seed)
  for (let k = 0; k < 8; k++) for (let j = 0; j < nh; j++) for (let i = 0; i < nx; i++)
    for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
  const p = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length).fill(m.mu)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = m.rho * h ** 3 / 8 })
  const k = 2 * Math.PI / Lphys, omega = Math.sqrt(G * k * Math.tanh(k * Hphys)), eps = 0.05
  const A = eps * Hphys * G / (2 * omega) / Math.cosh(k * Hphys)
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1]
    const ch = Math.cosh(k * y), sh = Math.sinh(k * y), sx = Math.sin(k * x), cx = Math.cos(k * x)
    p.vel.set([A * k * ch * sx, -A * k * sh * cx, 0], 3 * q)
    p.c[0].set([A * k * k * ch * cx, A * k * k * sh * sx, 0], 3 * q)
    p.c[1].set([A * k * k * sh * sx, -A * k * k * ch * cx, 0], 3 * q)
  }
  const dt = (1 / 120) * (h / DX), T = periods * Math.PI / omega
  const ts = [0], es = [kineticEnergy(p)]
  let visc = null
  for (let s = 1; s * dt <= T + 1e-9; s++) { sim.step(p, dt); ts.push(s * dt); es.push(kineticEnergy(p)); if (vstats(sim)) visc = vstats(sim) }
  return { ts, es, omega, k, H: Hphys, particles: p.n, visc }
}

// ── S3.6f the skip is invisible: water D1 with the viscous solve forced vs skipped (H/dx = 14 to keep the CPU run short;
//    the comparison is relative). Pass: E_K decay rates (s34metrics nuNum) within 1 %, E_K periods within 1 %.
//    On a SEED ENSEMBLE (2026-09-29): a single pair is chaotic — any perturbation moves the 4-period decay by ±1–3 %
//    (s36-gpu header) — so the criterion applies to the mean over six paired jitter seeds, which must resolve it
//    (2·standard error ≤ 1 %). ──
if (want.has('f')) {
  const WATER = { mu: 1.001596e-3, rho: 998.2072 }, SEEDS = [64, 101, 202, 303, 404, 505]
  const rows = SEEDS.map(seed => {
    const off = standingWave(14, WATER, 'off', 'no-slip', 4, seed), on = standingWave(14, WATER, 'force', 'no-slip', 4, seed)
    return { d: nuNum(on.ts, on.es, on.omega, on.k).nu / nuNum(off.ts, off.es, off.omega, off.k).nu - 1, w: fitOmega(on.ts, on.es, on.omega) / fitOmega(off.ts, off.es, off.omega) - 1, it: on.visc?.iterations }
  })
  const stats = xs => { const mm = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - mm) ** 2, 0) / (xs.length - 1)); return { m: mm, se: sd / Math.sqrt(xs.length) } }
  const dd = stats(rows.map(r => r.d)), dw = stats(rows.map(r => r.w))
  check(Math.abs(dd.m) <= 0.01 && 2 * dd.se <= 0.01 && Math.abs(dw.m) <= 0.01 && 2 * dw.se <= 0.01,
    `S3.6f water D1 (H/dx = 14) with the viscous solve forced vs skipped over ${SEEDS.length} seeds: mean decay difference ${(100 * dd.m).toFixed(3)} % ± ${(100 * dd.se).toFixed(3)} (SE; per seed ${rows.map(r => (100 * r.d).toFixed(2)).join(' / ')}), mean ω difference ${(100 * dw.m).toFixed(3)} % ± ${(100 * dw.se).toFixed(3)} (each ±1 %, resolved: 2·SE ≤ 1 %); forced PCG ${rows[0].it} it`)
}

// ── S3.6b E2 lava standing wave (D1 geometry, H/dx = 28, free-slip walls in the viscous solve — FINAL-PLAN S3.6b):
//    the linearised viscous gravity wave in this exact geometry (depth H, free-slip bottom and side walls, free surface),
//    derived here: φ = A cos(kx) cosh(ky), ψ = D sin(kx) sinh(my), m² = k² + s/ν (the free-slip bottom removes the
//    other two solutions); zero tangential stress and the normal-stress balance with gravity at y = H give
//      −2k² sinh(kH)·a22 − (m² + k²) sinh(mH)·a21 = 0,
//      a21 = s cosh kH + (gk/s) sinh kH + 2νk² cosh kH,  a22 = −(gk/s) sinh mH − 2νkm cosh mH,
//    which for kH, mH → ∞ is Lamb §349's (s + 2νk²)² + gk = 4ν²k³m (checked). s = −σ + iω solved by complex Newton.
//    Measured: E_K ~ e^{−2σt}(1 + cos 2ω't) → ω' from fitOmega, σ = 2k²·ν_fit from nuNum. Pass: ω' and σ within ±10 %. ──
const C = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]], mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d] },
  sqrt: a => { const r = Math.hypot(a[0], a[1]); const re = Math.sqrt((r + a[0]) / 2), im = Math.sign(a[1] || 1) * Math.sqrt(Math.max(0, (r - a[0]) / 2)); return [re, im] },
  exp: a => [Math.exp(a[0]) * Math.cos(a[1]), Math.exp(a[0]) * Math.sin(a[1])],
  sinh: a => { const e1 = C.exp(a), e2 = C.exp([-a[0], -a[1]]); return [(e1[0] - e2[0]) / 2, (e1[1] - e2[1]) / 2] },
  cosh: a => { const e1 = C.exp(a), e2 = C.exp([-a[0], -a[1]]); return [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2] },
  re: x => [x, 0],
}
function viscousWaveRoot(k, H, nu) {
  // det·e^{−kH−mH} with the hyperbolics scaled analytically (sinh z·e^{−z} = (1 − e^{−2z})/2, Re z > 0), finite at any depth
  const sh = z => C.mul(C.re(0.5), C.sub(C.re(1), C.exp(C.mul(C.re(-2), z)))), ch = z => C.mul(C.re(0.5), C.add(C.re(1), C.exp(C.mul(C.re(-2), z))))
  const f = s => {
    const m = C.sqrt(C.add(C.re(k * k), C.div(s, C.re(nu))))
    const kH = C.re(k * H), mH = C.mul(m, C.re(H)), gk = C.re(G * k)
    const a11 = C.mul(C.re(-2 * k * k), sh(kH))
    const a12 = C.mul(C.add(C.mul(m, m), C.re(k * k)), sh(mH))
    const a21 = C.add(C.add(C.mul(s, ch(kH)), C.mul(C.div(gk, s), sh(kH))), C.mul(C.re(2 * nu * k * k), ch(kH)))
    const a22 = C.sub(C.mul(C.re(-1), C.mul(C.div(gk, s), sh(mH))), C.mul(C.mul(C.re(2 * nu * k), m), ch(mH)))
    return C.sub(C.mul(a11, a22), C.mul(a12, a21))
  }
  let s = [-2 * nu * k * k, Math.sqrt(G * k * Math.tanh(k * H))]
  for (let it = 0; it < 100; it++) {
    const h = 1e-7 * Math.hypot(s[0], s[1]), fs = f(s)
    const dfs = C.div(C.sub(f(C.add(s, [h, 0])), fs), [h, 0])
    const step = C.div(fs, dfs)
    s = C.sub(s, step)
    if (Math.hypot(step[0], step[1]) < 1e-12 * Math.hypot(s[0], s[1])) break
  }
  return { sigma: -s[0], omega: s[1] }
}
if (want.has('b')) {
  // the root's deep-water limit against Lamb's closed form (a check of the derivation, not of the simulation)
  const kD = 1.978, nuD = 7.41e-2, deep = viscousWaveRoot(kD, 50, nuD)
  // Lamb §349's relation solved on its own (complex Newton), then compared with the finite-depth root at kH ≈ 99
  const lambF = s => { const m = C.sqrt(C.add(C.re(kD * kD), C.div(s, C.re(nuD)))), t = C.add(s, C.re(2 * nuD * kD * kD)); return C.sub(C.add(C.mul(t, t), C.re(G * kD)), C.mul(C.re(4 * nuD * nuD * kD ** 3), m)) }
  let sL = [-2 * nuD * kD * kD, Math.sqrt(G * kD)]
  for (let it = 0; it < 100; it++) {
    const hh = 1e-7 * Math.hypot(sL[0], sL[1]), f0 = lambF(sL), st = C.div(f0, C.div(C.sub(lambF(C.add(sL, [hh, 0])), f0), [hh, 0]))
    sL = C.sub(sL, st)
    if (Math.hypot(st[0], st[1]) < 1e-13) break
  }
  const rel = Math.max(Math.abs(deep.sigma / -sL[0] - 1), Math.abs(deep.omega / sL[1] - 1))
  check(rel <= 1e-6, `S3.6b derivation check: at kH = ${(kD * 50).toFixed(0)} the finite-depth root (σ ${deep.sigma.toFixed(6)}, ω ${deep.omega.toFixed(6)}) equals Lamb §349's deep-water root (σ ${(-sL[0]).toFixed(6)}, ω ${sL[1].toFixed(6)}) to ${rel.toExponential(1)} (≤ 1e-6)`)
  const r = standingWave(Number(process.env.S36B_H ?? 28), LAVA, 'force', 'free-slip', 3)
  const root = viscousWaveRoot(r.k, r.H, LAVA.mu / LAVA.rho)
  const wFit = fitOmega(r.ts, r.es, r.omega), sFit = 2 * r.k * r.k * nuNum(r.ts, r.es, r.omega, r.k).nu
  check(Math.abs(wFit / root.omega - 1) <= 0.10 && Math.abs(sFit / root.sigma - 1) <= 0.10,
    `S3.6b E2 lava standing wave (H/dx = ${process.env.S36B_H ?? 28}, ${r.particles} particles, free-slip walls in the viscous solve): ω' ${wFit.toFixed(4)} vs the viscous root ${root.omega.toFixed(4)} rad/s (${(100 * (wFit / root.omega - 1)).toFixed(2)} %, ±10 %; inviscid ${r.omega.toFixed(4)}); damping σ ${sFit.toFixed(4)} vs ${root.sigma.toFixed(4)} 1/s (${(100 * (sFit / root.sigma - 1)).toFixed(2)} %, ±10 %; 2νk² = ${(2 * LAVA.mu / LAVA.rho * r.k * r.k).toFixed(4)}); PCG ${r.visc?.iterations} it`)
}

// ── S3.6d Huppert 1982 viscous gravity current, lava 1200 °C, no-slip floor (the production wall BC): a lock of
//    9 × 17 cells (A ≈ 0.49 m² per unit width) against the x = 0 wall in a 64 × 24 × 8 box, z walls free-slip in the
//    viscous solve (a 2D current per unit width). x_N = 1.411·(gA³t/(3ν))^{1/5} with A = N·V_p/L_z from the particles.
//    Front = the farthest one-cell x-slab holding ≥ ½·ppc·nz particles (the r3 §2.7 bulk-front operator, as A1/A2).
//    Pass: least-squares exponent of x_N(t) on t ∈ [2, 10] s = 0.20 ± 0.02; x_N/prediction within ±10 % at 2, 5, 10 s. ──
if (want.has('d')) {
  const L = new GridLayout({ nx: 64, ny: 24, nz: 8, dx: DX })
  const sim = new FlipRef(L, { gravity: [0, -G, 0], density: LAVA.rho, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5,
    viscosity: 'force', viscosityDefault: LAVA.mu, viscosityScheme: SCHEME, stokesTolerance: 1e-6, viscousTestBC: { walls: { 'z-': { slip: 'free-slip' }, 'z+': { slip: 'free-slip' } } } })
  const pts = [], rng = mulberry32(80)
  for (let k = 0; k < 8; k++) for (let j = 0; j < 17; j++) for (let i = 0; i < 9; i++)
    for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX])
  const p = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length).fill(LAVA.mu)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = LAVA.rho * DX ** 3 / 8 })
  const A = p.n * DX ** 3 / 8 / (L.nz * DX), nu = LAVA.mu / LAVA.rho
  const pred = t => 1.411 * (G * A ** 3 * t / (3 * nu)) ** 0.2
  const front = () => {
    const cnt = new Int32Array(L.nx)
    for (let q = 0; q < p.n; q++) cnt[Math.min(L.nx - 1, Math.floor(p.pos[3 * q] / DX))]++
    for (let i = L.nx - 1; i >= 0; i--) if (cnt[i] >= 0.5 * 8 * L.nz) return (i + 1) * DX
    return 0
  }
  const dt = 1 / 120, ts = [], xs = [], at = {}
  for (let s = 1; s * dt <= 10 + 1e-9; s++) {
    sim.step(p, dt)
    const t = s * dt
    if (s % 12 === 0) { ts.push(t); xs.push(front()) }
    for (const T of [2, 5, 10]) if (Math.abs(t - T) < 1e-9) at[T] = front()
  }
  const late = ts.map((t, i) => i).filter(i => ts[i] >= 2)
  const expo = slope(late.map(i => Math.log(ts[i])), late.map(i => Math.log(xs[i])))
  const ratios = [2, 5, 10].map(T => at[T] / pred(T))
  check(Math.abs(expo - 0.2) <= 0.02 && ratios.every(r => Math.abs(r - 1) <= 0.10),
    `S3.6d Huppert viscous gravity current, lava 1200 °C (A = ${A.toFixed(3)} m², ν ${nu.toExponential(3)} m²/s, no-slip floor): late exponent ${expo.toFixed(3)} (0.20 ± 0.02); x_N at 2 / 5 / 10 s = ${[2, 5, 10].map(T => at[T].toFixed(2)).join(' / ')} m vs ${[2, 5, 10].map(T => pred(T).toFixed(2)).join(' / ')} (ratios ${ratios.map(r => r.toFixed(3)).join(' / ')}, ±10 %); PCG ${vstats(sim)?.iterations} it`)
}

console.log(`\ns3.6 reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
