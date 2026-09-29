#!/usr/bin/env node
// Gate S3.4 on the f64 CPU reference — ghost-fluid free surface (FINAL-PLAN §7 S3.4; §5.3, §5.5).
//
//   node scripts/fluid-gates/s34-ref.mjs
//
// S34a flat-surface reconstruction bias: jittered 8- and 4-ppc lattices (FINAL-PLAN S3.4a) filling a block of height
//      H·dx; the interface the pressure solve uses — top LIQUID cell centre + θ·dx, θ from the face-centre-sampled φ —
//      vs the true surface H·dx over every column: |mean bias| ≤ 0.1 dx. A uniformly random 4-ppc fill (not a lattice)
//      is REPORTED: it is the disordered extreme, and its interior holes are counted.
// G1c hydrostatic offset after 3 s (ghost fluid): floor p vs ρ·g·h_true within ρ·g·0.2·dx = 111 Pa.
// D1  standing wave (Souto-Iglesias et al. 2013 eq. 65–66; Colagrossi 2012 setup): slab L = 56 cells, H = 28 cells
//     (λ = L, kH = π), 8 cells deep, free-slip walls, ε = 0.05, initial velocity ∇φ0, flat surface. E_K oscillates as
//     1 + cos(2ωt) with ω² = g·k·tanh(kH): the fitted E_K period π/ω' within 3 % of π/ω at H/dx = 28, AND the error at
//     H/dx = 28 below the error at H/dx = 14 (same physical tank, dx doubled).
// D2  numerical viscosity from the E_K envelope, ν_num = −ln(E_env(t)/E_env(0))/(4k²t) ≤ 1.1e-4 m²/s (one tenth of
//     glycerol's ν). If it fails, glycerol-level viscosity is unresolvable at this dx — never tuned.
// A1  Martin & Moyce n² = 2 passes again with the ghost-fluid surface, measured as r3 §2.7 specifies: the front x_f is
//     the r3 §1 operator (the farthest one-cell x-slab holding ≥ 0.5·ppc·nz particles — a bulk layer ≥ ½ cell deep, so
//     the thin spray jet Lobovský describes is not the front; raw max(x) is logged); RMS Z ≤ 10 % at the Table 2 points
//     with 0.84 ≤ T ≤ 3.33, no time shift (best shift reported, |ΔT| ≤ 0.3); dZ/dT on [1.43, 3.33] ∈ [1.19, 1.74]
//     (reference 1.319 = fit to Table 2); |ΔH| ≤ 0.05 at the Table 6 points τ ≤ 2.45.
// A1c grid self-convergence (the S3.2 replacement for the ill-posed error(a = 12) ≤ error(a = 8), decisions.md
//     2026-09-28 night): one physical column a = 8·dx₀ at 8/12/16 cells, RMS|Z16 − Z12| ≤ RMS|Z12 − Z8| at those points.
// A2  square column n² = 1 at the Lobovský scale (a = H = 0.6 m = 12 cells of 5 cm), two runs identical until the
//     front reaches x = 1.6 m:
//     front — 72-cell run-out: the same metrics as A1 against Martin & Moyce n² = 1 a = 2.25 in [r3 §2.3: extracted
//       from Leakey et al. 2021 Fig. 7 vector markers; second-hand — MM 1952 is paywalled]; dZ/dT on T ∈ [1, 3.3] with
//       reference 1.400 (fit to that table) and window [0.9·1.40, 1.74] — A1's lower bound is 0.9 × its reference.
//     impulse — Lobovský et al. 2014's 1610 mm tank, 32 cells: the pressure impulse on the downstream-wall bottom cell,
//       I = ∫ p dt over the impact time (§5.1.2–5.1.3, Fig. 21: rise time = 2 × (t_peak − t_half-rise), decay time =
//       2 × (t_half-fall − t_peak)), within [0.5, 2] × the H = 600 mm sensor-1 median 12.74 mbar·s (§5.2.3)
//       [FINAL-PLAN A2; the sensor is 4.2 mm across and 3 mm above the bed, the cell 5 cm].
import { loadTsModules } from './lib/loadTs.mjs'
import { MM1, MM1H, MM2, MM2H, LOBOVSKY_I600, fitOmega, nuNum, columnScore, impulse, selfConvergence } from './lib/s34metrics.mjs'

const SRC = process.env.FLUID_REF_SRC ?? 'src/sim-ref'
const { gridLayout, flipRef } = await loadTsModules({ gridLayout: `${SRC}/gridLayout.ts`, flipRef: `${SRC}/flipRef.ts` })
const { GridLayout } = gridLayout
const { FlipRef, makeParticles, kineticEnergy, CellLabel } = flipRef

const G = 9.80665, DX = 3.63 / 64, RHO = 998.2072, gvec = [0, -G, 0]
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
// 8 ppc: 2×2×2 jittered sub-cells. Other ppc: a jittered lattice whose layer count per axis is round(cells·∛ppc), so
// the block is filled exactly (spacing cells·h/layers, within 2.4 % of h/∛ppc) and the true surface stays at hi + 1.
// 'random': uniform in each cell — no lattice (the disordered extreme).
function block(lo, hi, rng, ppc = 8, h = DX, mode = 'lattice') {
  const pts = []
  let vp = h ** 3 / ppc
  if (ppc === 8 && mode === 'lattice') {
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
      for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
  } else if (mode === 'random') {
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
      for (let s = 0; s < ppc; s++) pts.push([(i + rng()) * h, (j + rng()) * h, (k + rng()) * h])
  } else {
    const cells = [0, 1, 2].map(a => hi[a] - lo[a] + 1), layers = cells.map(c => Math.round(c * Math.cbrt(ppc))), sp = cells.map((c, a) => c * h / layers[a])
    vp = sp[0] * sp[1] * sp[2]
    for (let k = 0; k < layers[2]; k++) for (let j = 0; j < layers[1]; j++) for (let i = 0; i < layers[0]; i++)
      pts.push([lo[0] * h + (i + rng()) * sp[0], lo[1] * h + (j + rng()) * sp[1], lo[2] * h + (k + rng()) * sp[2]])
  }
  const p = makeParticles(pts.length)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = RHO * vp })
  return p
}
const opts = (extra = {}) => ({ gravity: gvec, density: RHO, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5, ...extra })
const t0 = Date.now()

// S34a
for (const [ppc, mode] of [[8, 'lattice'], [4, 'lattice'], [4, 'random']]) {
  const H = 10
  const L = new GridLayout({ nx: 16, ny: 20, nz: 16, dx: DX })
  const sim = new FlipRef(L, opts({ ppc }))
  const p = block([0, 0, 0], [15, H - 1, 15], mulberry32(40 + ppc), ppc, DX, mode)
  sim.classifyLevelSet(p)
  let holes = 0
  for (let k = 1; k < 15; k++) for (let j = 1; j < H - 2; j++) for (let i = 1; i < 15; i++) if (sim.label[L.idx(i, j, k)] !== CellLabel.LIQUID) holes++
  const ys = []
  for (let k = 0; k < 16; k++) for (let i = 0; i < 16; i++) {
    for (let j = 0; j + 1 < 20; j++) {
      const sl = L.idx(i, j, k), sa = L.idx(i, j + 1, k)
      if (sim.label[sl] === CellLabel.LIQUID && sim.label[sa] === CellLabel.AIR) { ys.push((j + 0.5 + sim.theta(sl, sa)) * DX); break }
    }
  }
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length, bias = (mean - H * DX) / DX
  const spread = Math.max(...ys.map(y => Math.abs(y - mean))) / DX
  const msg = `S34a flat surface, ${ppc} ppc ${mode === 'random' ? 'uniform random fill' : 'jittered lattice'} (${p.n} particles, ${ys.length} columns): mean zero crossing ${bias >= 0 ? '+' : ''}${bias.toFixed(4)} dx from the true surface (|bias| ≤ 0.1 dx); column spread ±${spread.toFixed(3)} dx; interior non-LIQUID cells ${holes}`
  if (mode === 'random') info(msg); else check(Math.abs(bias) <= 0.1 && holes === 0, msg)
}

// G1c
{
  const L = new GridLayout({ nx: 16, ny: 36, nz: 16, dx: DX })
  const sim = new FlipRef(L, opts())
  const p = block([0, 0, 0], [15, 23, 15], mulberry32(3))
  for (let s = 0; s < 360; s++) sim.step(p, 1 / 120)
  let sum = 0
  for (let k = 1; k < 15; k++) for (let i = 1; i < 15; i++) sum += sim.pressure[L.idx(i, 0, k)]
  const pCell0 = sum / 196
  // the floor pressure extrapolated from the two lowest cell centres (p is linear in the interior at rest)
  let sum1 = 0
  for (let k = 1; k < 15; k++) for (let i = 1; i < 15; i++) sum1 += sim.pressure[L.idx(i, 1, k)]
  const pCell1 = sum1 / 196, pFloor = pCell0 + (pCell0 - pCell1) / 2
  const hTrue = p.n * (DX ** 3 / 8) / (16 * DX * 16 * DX)
  const off = pFloor - RHO * G * hTrue
  check(Math.abs(off) <= RHO * G * 0.2 * DX, `G1c ghost fluid after 3 s: floor p ${pFloor.toFixed(0)} Pa vs ρg·h_true ${(RHO * G * hTrue).toFixed(0)} Pa: offset ${off.toFixed(1)} Pa (≤ ${(RHO * G * 0.2 * DX).toFixed(0)} Pa = ρg·0.2dx; the voxel surface gave +277)`)
}

// D1 + D2
function standingWave(cellsPerH) {
  const Lphys = 56 * DX, Hphys = 28 * DX, h = Hphys / cellsPerH
  const nx = Math.round(Lphys / h), nh = cellsPerH
  // air headroom ≥ H/2, rounded up to an even count (the GPU gate runs the same grid on MGPCG, which halves only even grids)
  const L = new GridLayout({ nx, ny: 2 * Math.ceil(1.5 * nh / 2), nz: 8, dx: h })
  const sim = new FlipRef(L, opts())
  const p = block([0, 0, 0], [nx - 1, nh - 1, 7], mulberry32(50 + cellsPerH), 8, h)
  const k = 2 * Math.PI / Lphys, omega = Math.sqrt(G * k * Math.tanh(k * Hphys)), eps = 0.05
  const A = eps * Hphys * G / (2 * omega) / Math.cosh(k * Hphys)
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1]
    const ch = Math.cosh(k * y), sh = Math.sinh(k * y), sx = Math.sin(k * x), cx = Math.cos(k * x)
    p.vel.set([A * k * ch * sx, -A * k * sh * cx, 0], 3 * q)
    p.c[0].set([A * k * k * ch * cx, A * k * k * sh * sx, 0], 3 * q)
    p.c[1].set([A * k * k * sh * sx, -A * k * k * ch * cx, 0], 3 * q)
  }
  const dt = (1 / 120) * (h / DX), T = 2.2 * Math.PI / omega * 2
  const ts = [0], es = [kineticEnergy(p)]
  for (let s = 1; s * dt <= T + 1e-9; s++) { sim.step(p, dt); ts.push(s * dt); es.push(kineticEnergy(p)) }
  const wFit = fitOmega(ts, es, omega), d2 = nuNum(ts, es, omega, k)
  return { cellsPerH, particles: p.n, omega, wFit, err: Math.abs(wFit / omega - 1), nuNum: d2.nu, peaks: d2.peaks, E0: es[0], clamps: sim.diag.wallClamps + sim.diag.densityClamps }
}
{
  const s28 = standingWave(28), s14 = standingWave(14)
  check(s28.err <= 0.03 && s28.err < s14.err, `D1 standing wave: E_K period π/ω' vs π/ω (ω = ${s28.omega.toFixed(4)} rad/s, period ${(Math.PI / s28.omega).toFixed(4)} s): error ${(100 * s28.err).toFixed(2)} % at H/dx = 28 (≤ 3 %, ${s28.particles} particles), ${(100 * s14.err).toFixed(2)} % at H/dx = 14 (must be larger)`)
  check(s28.nuNum <= 1.1e-4, `D2 numerical viscosity at H/dx = 28: ν_num ${s28.nuNum.toExponential(2)} m²/s from ${s28.peaks} E_K peaks (≤ 1.1e-4 = ν_glycerol/10; water ν = 1.0e-6); H/dx = 14: ${s14.nuNum.toExponential(2)}${s28.nuNum <= 1.1e-4 ? '' : ` — FINAL-PLAN consequence: glycerol-level viscosity is unresolvable at dx = ${(100 * DX).toFixed(2)} cm (validity HUD); the remedy is resolution, never tuning; S3.6 runs the viscous solve for ν_phys ≥ 0.01·ν_num = ${(0.01 * s28.nuNum).toExponential(2)} m²/s`}`)
  info(`D1 push-backs (advection + density) ${s28.clamps} at H/dx = 28`)
}

// A1 again + A2 (column collapses with the ghost-fluid surface)
// r3 §1 front operator: the farthest one-cell x-slab holding ≥ 0.5·ppc·nz particles; x_f is that slab's leading edge
// (at t = 0 the column's last slab gives x_f = a, Z = 1).
function frontSlab(pos, n, h, nz, ppc = 8) {
  const counts = new Map()
  for (let q = 0; q < n; q++) { const i = Math.floor(pos[3 * q] / h); counts.set(i, (counts.get(i) ?? 0) + 1) }
  let best = -1
  for (const [i, c] of counts) if (c >= 0.5 * ppc * nz && i > best) best = i
  return (best + 1) * h
}
function column({ aCells, n2, h, nx, tauEnd }) {
  const a = aCells * h, tUnit = Math.sqrt(a / G), rows = Math.round(n2 * aCells), nz = 8
  const L = new GridLayout({ nx, ny: rows + 8, nz, dx: h })
  const sim = new FlipRef(L, opts({ pressureTolerance: 1e-5, psiTolerance: 1e-4 }))
  const p = block([0, 0, 0], [aCells - 1, rows - 1, nz - 1], mulberry32(60 + aCells), 8, h)
  const dt = (1 / 240) * (h / DX)
  const ts = [], Z = [], Zraw = [], Zpct = [], Hh = [], wallP = []
  for (let s = 1; s * dt <= tauEnd * tUnit + 1e-9; s++) {
    sim.step(p, dt)
    let hMax = 0
    const xs = new Float64Array(p.n)
    for (let q = 0; q < p.n; q++) { xs[q] = p.pos[3 * q]; if (p.pos[3 * q] < h) hMax = Math.max(hMax, p.pos[3 * q + 1]) }
    xs.sort()
    // the pre-S3.4 operator (99.5th percentile of x) is kept only to report how much the verdict depends on the operator
    ts.push(s * dt); Z.push(frontSlab(p.pos, p.n, h, nz) / a); Zraw.push(xs[p.n - 1] / a); Zpct.push(xs[Math.floor(0.995 * (p.n - 1))] / a); Hh.push(hMax / (n2 * a))
    // downstream-wall bottom cell, averaged over the interior z cells (the sensor is on the centre line)
    let pw = 0
    for (let k = 1; k < nz - 1; k++) pw += sim.pressure[L.idx(nx - 1, 0, k)]
    wallP.push(pw / (nz - 2))
  }
  return { a, n: Math.sqrt(n2), tUnit, dt, ts, Z, Zraw, Zpct, H: Hh, wallP, particles: p.n }
}
{
  const r1 = column({ aCells: 12, n2: 2, h: DX, nx: 128, tauEnd: 3.33 / Math.SQRT2 + 0.1 }), s1 = columnScore(r1, MM2, MM2H, [1.43, 3.33])
  check(s1.rmsZ <= 0.10 && Math.abs(s1.bestShift) <= 0.3 && s1.slope >= 1.19 && s1.slope <= 1.74 && s1.dH <= 0.05,
    `A1 again (ghost fluid), n² = 2, a = 12 cells: RMS Z error ${(100 * s1.rmsZ).toFixed(2)} % over ${s1.points} points (≤ 10 %; best shift ΔT ${s1.bestShift.toFixed(2)} → ${(100 * s1.bestRms).toFixed(2)} %, |ΔT| ≤ 0.3), dZ/dT ${s1.slope.toFixed(3)} (1.19–1.74; MM 1.319), max |ΔH| ${s1.dH.toFixed(3)} (≤ 0.05)`)
  const aP = 8 * DX, conv = selfConvergence([8, 12, 16].map(c => column({ aCells: c, n2: 2, h: aP / c, nx: 2 * Math.ceil(2.75 * c), tauEnd: 3.33 / Math.SQRT2 + 0.1 })))
  check(conv.e2 <= conv.e1, `A1c grid self-convergence, one column a = ${aP.toFixed(3)} m at 8/12/16 cells: RMS|Z12 − Z8| ${conv.e1.toFixed(4)}, RMS|Z16 − Z12| ${conv.e2.toFixed(4)} (must shrink)`)
  const p1 = columnScore({ ...r1, Z: r1.Zpct }, MM2, MM2H, [1.43, 3.33])
  info(`A1 residuals (T:%) ${s1.resid}; raw max(x) ahead of the bulk front by up to ${s1.rawAhead.toFixed(2)} a; operator sensitivity: the pre-S3.4 99.5th-percentile front gives RMS ${(100 * p1.rmsZ).toFixed(2)} % (best shift ${p1.bestShift.toFixed(2)})`)
  const r2 = column({ aCells: 12, n2: 1, h: 0.05, nx: 72, tauEnd: 3.5 }), s2 = columnScore(r2, MM1, MM1H, [1, 3.3])
  check(s2.rmsZ <= 0.10 && Math.abs(s2.bestShift) <= 0.3 && s2.slope >= 0.9 * 1.40 && s2.slope <= 1.74 && s2.dH <= 0.05,
    `A2 front, square column n² = 1, a = H = 0.6 m (${r2.particles} particles): RMS Z error vs MM n² = 1 ${(100 * s2.rmsZ).toFixed(2)} % over ${s2.points} points (≤ 10 %; best shift ΔT ${s2.bestShift.toFixed(2)} → ${(100 * s2.bestRms).toFixed(2)} %), dZ/dT on T ∈ [1, 3.3] ${s2.slope.toFixed(3)} (1.26–1.74; MM 1.400; Lobovský 600 mm 1.34), max |ΔH| ${s2.dH.toFixed(3)} (≤ 0.05)`)
  const p2 = columnScore({ ...r2, Z: r2.Zpct }, MM1, MM1H, [1, 3.3])
  info(`A2 residuals (T:%) ${s2.resid}; raw max(x) ahead of the bulk front by up to ${s2.rawAhead.toFixed(2)} a; operator sensitivity: 99.5th-percentile front RMS ${(100 * p2.rmsZ).toFixed(2)} % (best shift ${p2.bestShift.toFixed(2)})`)
  // impulse: Lobovský's tank (1610 mm → 32 cells of 5 cm)
  const ri = column({ aCells: 12, n2: 1, h: 0.05, nx: 32, tauEnd: 6 })
  const imp = impulse(ri.ts, ri.wallP), Imed = LOBOVSKY_I600
  check(imp.I >= 0.5 * Imed && imp.I <= 2 * Imed, `A2 impulse, Lobovský tank (32 cells, wall at 1.60 m): downstream-wall bottom-cell I = ∫p dt over the impact time ${(imp.I / 100).toFixed(2)} mbar·s (within [0.5, 2] × the H = 600 mm sensor-1 median 12.74 mbar·s); peak ${(imp.peak / 100).toFixed(1)} mbar at t = ${imp.tPeak.toFixed(3)} s, rise ${(1000 * imp.rise).toFixed(1)} ms, decay ${(1000 * imp.decay).toFixed(1)} ms (Lobovský medians: 185.69 mbar, 7 ms, 104 ms; dt = ${(1000 * ri.dt).toFixed(2)} ms)`)
}

console.log(`\ns3.4 reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
