#!/usr/bin/env node
// Gate S3.5 on the f64 CPU reference — variable density (FINAL-PLAN §7 S3.5; §5.3 "face density").
//
//   node scripts/fluid-gates/s35-ref.mjs [--only=D,F1,F2,F3,F4,LX]
//
// Densities are the app's sourced values (src/composition/materialData.ts): water from the NIST 1 atm table
// (998.2072 at 20 °C, 999.7025 at 10 °C, 965.3096 at 90 °C), mercury 13545.859 (Bettin & Fehlauer 2004), olive oil 911
// ([S] secondary). Every particle carries m = ρ·dx³/8 (8 ppc); ghost-fluid surface and density projection on.
// Criteria (fixed before the first run):
// D   density cancels in a single-liquid free-surface flow: the A1 column (n² = 2, a = 12 cells) as water and as
//     mercury from identical particles — max particle position difference ≤ 0.02·a at every sample (the plan's
//     |ΔZ| ≤ 0.02, applied to every particle rather than to the quantised front; stricter).
// F1  stratification, heavy released on top (Hg over water; water over olive oil), 16×40×8 tank, 12 + 12 cells:
//     mean COM over the last 2 s of each material within ±0.5 cell of the static layers (heavy floor + h₁/2, light
//     floor + h₁ + h₂/2), and ≤ 1 % of particles on the wrong side (heavy above h₁ + s or light below h₁ − s,
//     s = dx/2 the particle spacing).
// F2  two-layer hydrostatics after 3 s at rest (Hg 12 cells under water 12 cells): dp/dy within each layer's interior
//     rows = −ρ_i·g ± 0.5 %.
// F3  interfacial standing wave, Hg under water, 14 + 14 cells (0.794 m each), λ = W = 3.63 m (j = 2), pure
//     interfacial eigenmode from rest (interface a·cos kx, surface b·cos kx with Lamb's eigen ratio b/a): ω from the
//     E_K period vs Lamb Art. 231 for the exact depths: ≤ 5 %, and the error at dx below the error at 2·dx.
// F4  Rayleigh–Taylor: Hg 14 cells over water 14 cells, free surface above the Hg, λ = W/2 (j = 4), growing eigenmode
//     from rest (A = A₀·cosh σt): σ fitted while |A| < 0.1λ vs the unstable root of the same quartic: ±15 %.
// LX  lock exchange, water 10 °C | 90 °C, H = 18 cells (1.021 m), lock at mid-tank (64×24×8): dense-front speed on
//     the bottom row fitted while the front is 0.3–1.4 m past the lock: U ∈ [0.23, 0.30] m/s (Shin, Dalziel &
//     Linden 2004: F_H 0.42–0.5 ⇒ 0.244–0.290 m/s at H = 1 m).
import { loadTsModules } from './lib/loadTs.mjs'
import { fitOmega } from './lib/s34metrics.mjs'

const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef, mat, two } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts`, two: `${SRC}/sim-ref/twoLayer.ts` })
const { GridLayout } = gridLayout
const { FlipRef, kineticEnergy } = flipRef
const { G_STD: G, mulberry32, fillMaterials: fill, lambTwoLayer, interfaceAmplitude, columnCounts, fitCosh, lockFront } = two
const ONLY = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const run = name => ONLY.length === 0 || ONLY.includes(name)

const DX = 3.63 / 64
const RHO_W20 = mat.waterDensity(20), RHO_W10 = mat.waterDensity(10), RHO_W90 = mat.waterDensity(90)
const RHO_HG = mat.HG_RHO_20C, RHO_OIL = mat.LIQUIDS['olive-oil'].density(20)
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
const opts = (extra = {}) => ({ gravity: [0, -G, 0], density: RHO_W20, projection: true, densityProjection: true, freeSurface: 'ghost', variableDensity: true, pressureTolerance: 1e-6, psiTolerance: 1e-5, ...extra })
const t0 = Date.now()

// D — density cancels
if (run('D')) {
  const aC = 12, a = aC * DX, rows = 24
  const make = rho => { const L = new GridLayout({ nx: 128, ny: rows + 8, nz: 8, dx: DX }); return { sim: new FlipRef(L, opts({ density: rho })), ...fill(aC, rows, 8, DX, mulberry32(60 + aC), () => [rho, 0]) } }
  const w = make(RHO_W20), hg = make(RHO_HG)
  const dt = 1 / 240, steps = Math.ceil(3.33 / Math.SQRT2 * Math.sqrt(a / G) / dt)
  let worst = 0, worstT = 0
  for (let s = 1; s <= steps; s++) {
    w.sim.step(w.p, dt); hg.sim.step(hg.p, dt)
    let m = 0
    for (let i = 0; i < w.p.pos.length; i++) m = Math.max(m, Math.abs(w.p.pos[i] - hg.p.pos[i]))
    if (m / a > worst) { worst = m / a; worstT = s * dt }
  }
  check(worst <= 0.02, `D density cancels, A1 column as water (${RHO_W20.toFixed(1)}) vs mercury (${RHO_HG.toFixed(1)} kg/m³), ${w.p.n} particles, ${steps} steps: max particle position difference ${worst.toExponential(2)}·a at t = ${worstT.toFixed(3)} s (≤ 0.02·a)`)
}

// F1 — stratification from an inverted start
function overturn(label, rhoHeavy, rhoLight, seconds, seed) {
  const nx = 16, nz = 8, h1 = 12, h2 = 12, L = new GridLayout({ nx, ny: 40, nz, dx: DX })
  const sim = new FlipRef(L, opts())
  const { p, tag } = fill(nx, h1 + h2, nz, DX, mulberry32(seed), (x, y) => (y < h1 * DX ? [rhoLight, 0] : [rhoHeavy, 1]))
  const dt = 1 / 120, steps = Math.round(seconds / dt)
  const comH = [], comL = []
  for (let s = 1; s <= steps; s++) {
    sim.step(p, dt)
    if (s * dt >= seconds - 2) {
      let sh = 0, nh = 0, sl = 0, nl = 0
      for (let q = 0; q < p.n; q++) { if (tag[q]) { sh += p.pos[3 * q + 1]; nh++ } else { sl += p.pos[3 * q + 1]; nl++ } }
      comH.push(sh / nh); comL.push(sl / nl)
    }
  }
  const mH = comH.reduce((s, v) => s + v, 0) / comH.length / DX, mL = comL.reduce((s, v) => s + v, 0) / comL.length / DX
  let wrong = 0
  for (let q = 0; q < p.n; q++) { const y = p.pos[3 * q + 1] / DX; if (tag[q] ? y > h1 + 0.5 : y < h1 - 0.5) wrong++ }
  const ok = Math.abs(mH - h1 / 2) <= 0.5 && Math.abs(mL - (h1 + h2 / 2)) <= 0.5 && wrong <= 0.01 * p.n
  check(ok, `F1 ${label} released inverted, ${seconds} s (${p.n} particles): mean COM over the last 2 s heavy ${mH.toFixed(2)} cells (static ${(h1 / 2).toFixed(1)}), light ${mL.toFixed(2)} (static ${(h1 + h2 / 2).toFixed(1)}), ±0.5; on the wrong side ${(100 * wrong / p.n).toFixed(2)} % (≤ 1 %); density fallbacks ${sim.diag.densityNeighbourFaces}/${sim.diag.densityDefaultFaces}`)
}
if (run('F1')) {
  overturn('mercury over water', RHO_HG, RHO_W20, 8, 71)
  overturn('water over olive oil', RHO_W20, RHO_OIL, 15, 72)
}

// F2 — two-layer hydrostatics
if (run('F2')) {
  const nx = 16, nz = 8, h1 = 12, h2 = 12, L = new GridLayout({ nx, ny: 32, nz, dx: DX })
  const sim = new FlipRef(L, opts())
  const { p } = fill(nx, h1 + h2, nz, DX, mulberry32(73), (x, y) => (y < h1 * DX ? [RHO_HG, 1] : [RHO_W20, 0]))
  for (let s = 0; s < 360; s++) sim.step(p, 1 / 120)
  const row = j => { let s = 0; for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) s += sim.pressure[L.idx(i, j, k)]; return s / ((nz - 2) * (nx - 2)) }
  const slope = (j0, j1) => { let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0; for (let j = j0; j <= j1; j++) { const y = (j + 0.5) * DX, v = row(j); sx += y; sy += v; sxx += y * y; sxy += y * v; n++ } return (n * sxy - sx * sy) / (n * sxx - sx * sx) }
  const gHg = slope(2, h1 - 3), gW = slope(h1 + 2, h1 + h2 - 3)
  const eHg = gHg / (-RHO_HG * G) - 1, eW = gW / (-RHO_W20 * G) - 1
  check(Math.abs(eHg) <= 0.005 && Math.abs(eW) <= 0.005, `F2 two-layer hydrostatics after 3 s: dp/dy mercury ${gHg.toFixed(0)} Pa/m (${(100 * eHg).toFixed(3)} % vs −ρg), water ${gW.toFixed(1)} Pa/m (${(100 * eW).toFixed(3)} %), ±0.5 %; floor p ${row(0).toFixed(0)} Pa (ρ₁gh₁ + ρ₂gh₂ at the first centre ≈ ${(RHO_HG * G * (h1 - 0.5) * DX + RHO_W20 * G * h2 * DX).toFixed(0)})`)
}

// F3 — interfacial standing wave
function interfacial(scale) {
  const h = DX * scale, nx = 64 / scale, nL = 14 / scale, nz = 8 / scale, W = 64 * DX, k = 2 * Math.PI / W
  const depth = nL * h
  const modes = lambTwoLayer({ rhoLower: RHO_HG, rhoUpper: RHO_W20, hLower: depth, hUpper: depth, k })
  const m = modes[0], omega = Math.sqrt(m.omega2), a = 0.05 * depth, b = m.ratio * a
  const L = new GridLayout({ nx, ny: 2 * Math.ceil((2 * nL + 3 / scale + 1) / 2), nz, dx: h })
  const sim = new FlipRef(L, opts())
  const { p } = fill(nx, 2 * nL + 2, nz, h, mulberry32(80 + scale), (x, y) => {
    const yi = depth + a * Math.cos(k * x), ys = 2 * depth + b * Math.cos(k * x)
    return y < yi ? [RHO_HG, 1] : y < ys ? [RHO_W20, 0] : null
  })
  const dt = (1 / 120) * scale, T = 3 * Math.PI / omega
  const ts = [0], es = [kineticEnergy(p)]
  for (let s = 1; s * dt <= T + 1e-9; s++) { sim.step(p, dt); ts.push(s * dt); es.push(kineticEnergy(p)) }
  const wFit = fitOmega(ts, es, omega)
  return { omega, wFit, err: Math.abs(wFit / omega - 1), particles: p.n, surfaceMode: Math.sqrt(modes[1].omega2), ratio: m.ratio }
}
if (run('F3')) {
  const f = interfacial(1), c = interfacial(2)
  check(f.err <= 0.05 && f.err < c.err, `F3 interfacial wave, Hg under water 0.794 + 0.794 m, λ = 3.63 m (${f.particles} particles): ω ${f.wFit.toFixed(4)} vs Lamb ${f.omega.toFixed(4)} rad/s (surface mode ${f.surfaceMode.toFixed(4)}; eigen surface/interface ${f.ratio.toFixed(3)}): error ${(100 * f.err).toFixed(2)} % (≤ 5 %); at 2·dx ${(100 * c.err).toFixed(2)} % (must be larger)`)
}

// F4 — Rayleigh–Taylor
if (run('F4')) {
  const nx = 64, nL = 14, nz = 8, W = nx * DX, lam = W / 2, k = 2 * Math.PI / lam, depth = nL * DX
  const unstable = lambTwoLayer({ rhoLower: RHO_W20, rhoUpper: RHO_HG, hLower: depth, hUpper: depth, k }).find(r => r.omega2 < 0)
  const sigma = Math.sqrt(-unstable.omega2), a = 0.03, b = unstable.ratio * a
  const L = new GridLayout({ nx, ny: 34, nz, dx: DX })
  const sim = new FlipRef(L, opts())
  const { p, tag } = fill(nx, 2 * nL + 2, nz, DX, mulberry32(90), (x, y) => {
    const yi = depth + a * Math.cos(k * x), ys = 2 * depth + b * Math.cos(k * x)
    return y < yi ? [RHO_W20, 0] : y < ys ? [RHO_HG, 1] : null
  })
  const amp = () => { const c = columnCounts(p.pos, 3, tag, p.n, nx, 34, DX, 1); return interfaceAmplitude(c.upper, c.lower, nx, 34, DX, k).amplitude }
  const dt = 1 / 240, ts = [0], as = [amp()]
  for (let s = 1; s * dt <= 1.0 && Math.abs(as.at(-1)) < 0.12 * lam; s++) { sim.step(p, dt); ts.push(s * dt); as.push(amp()) }
  const fit = fitCosh(ts, as, 0.1 * lam)
  const err = fit.sigma / sigma - 1
  check(Math.abs(err) <= 0.15, `F4 Rayleigh–Taylor, Hg 0.794 m over water 0.794 m, free surface, λ = ${lam.toFixed(3)} m (${p.n} particles): σ ${fit.sigma.toFixed(3)} s⁻¹ fitted to A₀·cosh σt over ${fit.samples} samples to t = ${fit.tEnd.toFixed(3)} s (A₀ measured ${as[0].toFixed(4)} m, seeded ${a}) vs Lamb ${sigma.toFixed(4)}: ${(100 * err).toFixed(1)} % (±15 %)`)
}

// LX — lock exchange
if (run('LX')) {
  const nx = 64, nH = 18, nz = 8, lock = 32 * DX, H = nH * DX
  const L = new GridLayout({ nx, ny: 24, nz, dx: DX })
  const sim = new FlipRef(L, opts())
  const { p, tag } = fill(nx, nH, nz, DX, mulberry32(95), x => (x < lock ? [RHO_W10, 1] : [RHO_W90, 0]))
  const gPrime = G * (RHO_W10 - RHO_W90) / RHO_W10
  const dt = 1 / 120, ts = [], xs = []
  for (let s = 1; s * dt <= 6; s++) {
    sim.step(p, dt)
    ts.push(s * dt); xs.push(lockFront(p.pos, 3, tag, p.n, nx, DX, 32))
  }
  const idx = ts.map((t, i) => i).filter(i => xs[i] >= 0.3 && xs[i] <= 1.4)
  const tm = idx.reduce((q, i) => q + ts[i], 0) / idx.length, xm = idx.reduce((q, i) => q + xs[i], 0) / idx.length
  let sxy = 0, sxx = 0
  for (const i of idx) { sxy += (ts[i] - tm) * (xs[i] - xm); sxx += (ts[i] - tm) ** 2 }
  const U = sxy / sxx
  check(U >= 0.23 && U <= 0.30, `LX lock exchange, water 10 °C (${RHO_W10.toFixed(2)}) | 90 °C (${RHO_W90.toFixed(2)} kg/m³), H = ${H.toFixed(3)} m, g′ = ${gPrime.toFixed(4)} m/s² (${p.n} particles): dense front ${U.toFixed(3)} m/s over ${idx.length} samples (U ∈ [0.23, 0.30]; F_H = U/√(g′H) = ${(U / Math.sqrt(gPrime * H)).toFixed(3)}, Shin et al. 0.42–0.5)`)
}

console.log(`\ns3.5 reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
