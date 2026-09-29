#!/usr/bin/env node
// Gate S3.6 on the FLUID TEST page — implicit viscosity through the page's wiring (the μ table from the composition
// table, the run rule, production settings, the lockstep clock), FINAL-PLAN S3.6.
//
//   node scripts/fluid-gates/s36-page.mjs     (default server: the clean gate tree; FLUID_BASE to override)
//
// Criteria (fixed before the first run). Tank = the 64³ window, 3.63 m, floor at y = 0, lockstep 1/60 s per frame.
// V1 viscous liquids load: Honey (14 % water), Glycerol and Lava scenarios are not refused (S3.6 simulates them);
//    Glycerol carries the numerical-damping disclosure (ν_num/ν ≥ 0.1), honey 14 % and lava do not.
// V2 the run rule (liquidGate.VISCOUS_RUN_NU = 0.01·ν_num): a water pool runs WITHOUT the viscous solve; a honey block
//    and a honey + water tank run WITH it.
// V3 the μ table: μ = w/(2V) of the viscous solve over its full cells (V ≥ 0.999) equals f32(μ) of the material
//    (honey 0–0.10 m under water 0.10–0.33 m, 191k particles: cell rows 3–4 reach only water with their trilinear taps,
//    row 0 only honey)
//    (CompositionTable, the page's own defaults): honey alone → exactly f32(40 Pa·s); honey under water → the smallest
//    exactly f32(μ_water(20 °C)), the largest exactly f32(μ_honey), every value between (harmonic means of mixed cells).
// V4 physics through the page: S3.6d's Huppert 1982 plane viscous gravity current, now a lava slab (1200 °C) filling
//    the tank's depth (3.63 m), x ∈ [0, 0.5] m, 1.0 m high: x_N = 1.411·(gA³t/(3ν))^{1/5}, A = N·V_p/L_z, the same bulk-
//    front operator (farthest one-cell x-slab holding ≥ ½·ppc·nz particles) and criteria: late exponent 0.20 ± 0.02 over
//    t ≥ 2 s, x_N/prediction within ±10 % at 2, 5, 10 s. The page's walls are no-slip on every side (production):
//    in a thin current the side-wall layers reach about one current depth, ≤ 0.3 m of the 3.63 m width.
// V5 the viscous PCG at the page's lagged cap (FlipBackend: 2·n + 8 of the last solve, doubled after a cap hit) over the
//    V4 run: cap hits ≤ 1 % of the solves, 0 breakdowns.
// R  0 uncaptured GPU errors, 0 console errors. FPS (recorded, the hardware budget): a honey block on the real-time clock,
//    in its own window on the PRIMARY display (owner 2026-09-29: timing runs stay there; lib/window.mjs).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sampleAtFrame, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { loadTsModules } from './lib/loadTs.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.6 (implicit viscosity on the FLUID TEST page)')
const report = { prov: await provenance() }
const L = 3.63, DX = L / 64, VP = DX ** 3 / 8, PPC = 8
const { ct, lg } = await loadTsModules({ ct: 'src/composition/CompositionTable.ts', lg: 'src/composition/liquidGate.ts' })
const table = new ct.CompositionTable(); table.addDefaults()
const props = n => table.getSolverProps(table.findByName(n))
const muW = Math.fround(props('Water').muPaS), muH = Math.fround(props('Honey (14% water)').muPaS)
const lava = props('Lava'), nuLava = lava.muPaS / lava.rhoKgM3

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
const viscosity = () => page.evaluate(() => window.__fluidBench.viscosity())
const diagnostics = () => page.evaluate(() => window.__fluidBench.diagnostics())
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  const scene = (name, spawns) => ({ name, materials: [], spawns, gravity_mps2: G_STANDARD })
  const block = (material, min, max) => ({ material, box: { min, max } })

  // V1: the viscous liquids load; the disclosure where ν_num inflates the liquid's own viscosity
  const loads = {}
  for (const m of ['Honey (14% water)', 'Glycerol', 'Lava']) {
    try { loads[m] = { ok: true, warning: (await loadScenario(page, scene(`s36-v1-${m}`, [block(m, [1.2, 0, 1.2], [2.4, 0.4, 2.4])]))).warning } }
    catch (e) { loads[m] = { ok: false, reason: String(e).slice(0, 200) } }
  }
  report.v1 = loads
  const damp = w => /numerical damping/.test(w ?? '')
  gate.check(Object.values(loads).every(r => r.ok) && damp(loads.Glycerol.warning) && !damp(loads['Honey (14% water)'].warning) && !damp(loads.Lava.warning),
    `V1 viscous liquids load on the page: ${Object.entries(loads).map(([m, r]) => `${m} ${r.ok ? (damp(r.warning) ? 'loaded, damping disclosed' : 'loaded') : `REFUSED (${r.reason})`}`).join('; ')}`)

  // V2 + V3: the run rule and the μ table
  await loadScenario(page, scene('s36-water', [block('Water', [0, 0, 0], [3.63, 0.17, 3.63])]))
  await sampleAtFrame(page, 30)
  const dW = await diagnostics(), pW = await viscosity()
  await loadScenario(page, scene('s36-honey', [block('Honey (14% water)', [1.2, 0, 1.2], [2.4, 0.6, 2.4])]))
  await sampleAtFrame(page, 30)
  const dH = await diagnostics(), pH = await viscosity()
  await loadScenario(page, scene('s36-honey-water', [block('Honey (14% water)', [0, 0, 0], [3.63, 0.1, 3.63]), block('Water', [0, 0.1, 0], [3.63, 0.33, 3.63])]))
  await sampleAtFrame(page, 30)
  const dM = await diagnostics(), pM = await viscosity()
  report.v2 = { water: dW.viscousSolve, honey: dH.viscousSolve, mixed: dM.viscousSolve, maxNu: [dW.maxNu, dH.maxNu, dM.maxNu], runNu: lg.VISCOUS_RUN_NU }
  report.v3 = { expected: { water: muW, honey: muH }, honey: pH, mixed: pM, water: pW }
  gate.check(dW.viscousSolve === 0 && !pW.active && dH.viscousSolve === 1 && dM.viscousSolve === 1,
    `V2 run rule (ν ≥ ${lg.VISCOUS_RUN_NU.toExponential(2)} m²/s): water pool ${dW.viscousSolve ? 'ON' : 'off'} (max ν ${dW.maxNu.toExponential(2)}), honey ${dH.viscousSolve ? 'on' : 'OFF'} (${dH.maxNu.toExponential(2)}), honey + water ${dM.viscousSolve ? 'on' : 'OFF'}`)
  const between = pM.distinct.every(v => v >= muW && v <= muH)
  gate.check(pH.active && pH.fullCells > 0 && pH.muMin === muH && pH.muMax === muH && pM.fullCells > 0 && pM.muMin === muW && pM.muMax === muH && between,
    `V3 μ in the viscous solve (full cells): honey alone ${pH.fullCells} cells, μ ${pH.muMin}…${pH.muMax} (f32(μ_honey) = ${muH}); honey under water ${pM.fullCells} cells, μ ${pM.muMin}…${pM.muMax} (f32(μ_water) = ${muW}), sampled values ${pM.distinct.length} all between: ${between}`)

  // V4: the plane viscous gravity current through the page
  await loadScenario(page, scene('s36-huppert', [block('Lava', [0, 0, 0], [0.5, 1.0, 3.63])]))
  await page.evaluate(() => window.__fluidBench.configure({ resetDiagnostics: true }))
  const ts = [], xs = [], at = {}
  let n = 0, A = 0
  for (let f = 12; f <= 600; f += 12) {
    const s = await sampleAtFrame(page, f)
    n = s.n; A = n * VP / L
    const cnt = new Int32Array(64)
    for (let i = 0; i < s.n; i++) { const x = s.pos[3 * i] * L; if (Number.isFinite(x)) cnt[Math.min(63, Math.floor(x / DX))]++ }
    let front = 0
    for (let i = 63; i >= 0; i--) if (cnt[i] >= 0.5 * PPC * 64) { front = (i + 1) * DX; break }
    const t = f / 60
    ts.push(t); xs.push(front)
    for (const T of [2, 5, 10]) if (Math.abs(t - T) < 1e-9) at[T] = front
  }
  const pred = t => 1.411 * (G_STANDARD * A ** 3 * t / (3 * nuLava)) ** 0.2
  const late = ts.map((t, i) => i).filter(i => ts[i] >= 2)
  const lx = late.map(i => Math.log(ts[i])), ly = late.map(i => Math.log(xs[i]))
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length
  const expo = lx.reduce((a, x, k) => a + (x - mx) * (ly[k] - my), 0) / lx.reduce((a, x) => a + (x - mx) ** 2, 0)
  const ratios = [2, 5, 10].map(T => at[T] / pred(T))
  const dV = await diagnostics()
  report.v4 = { n, A, nu: nuLava, ts, xs, at, expo, ratios, diagnostics: dV }
  gate.check(Math.abs(expo - 0.2) <= 0.02 && ratios.every(r => Math.abs(r - 1) <= 0.10) && dV.viscousSolve === 1,
    `V4 Huppert plane current through the page, lava 1200 °C (${n} particles, A = ${A.toFixed(3)} m², ν ${nuLava.toExponential(3)} m²/s): late exponent ${expo.toFixed(3)} (0.20 ± 0.02); x_N at 2 / 5 / 10 s = ${[2, 5, 10].map(T => at[T].toFixed(2)).join(' / ')} m vs ${[2, 5, 10].map(T => pred(T).toFixed(2)).join(' / ')} (ratios ${ratios.map(r => r.toFixed(3)).join(' / ')}, ±10 %); p caps ${dV.pressureCapHits}/${dV.pressureSolves}`)
  gate.check(dV.viscousSolves > 0 && dV.viscousCapHits <= 0.01 * dV.viscousSolves && dV.viscousBreakdowns === 0,
    `V5 viscous PCG at the page's lagged cap over the V4 run: ${dV.viscousSolves} solves, cap hits ${dV.viscousCapHits} (≤ 1 %), breakdowns ${dV.viscousBreakdowns}, most iterations ${dV.viscousMaxIterations}, cap now ${dV.viscousCap}`)

  await gate.hygiene(page, errors)

  // FPS (recorded): a honey block on the real-time clock, its own window on the primary display
  const fp = await openFluidPage(undefined, { timing: true })
  try {
    await fp.page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    await loadScenario(fp.page, scene('s36-fps', [block('Honey (14% water)', [1.0, 0, 1.0], [2.6, 0.8, 2.6])]))
    await fp.page.evaluate(() => window.__fluidBench.configure({ clock: 'realtime', resetClockStats: true, resetDiagnostics: true }))
    await fp.page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
    await fp.page.waitForTimeout(10_000)
    const f = await status(fp.page), d = await fp.page.evaluate(() => window.__fluidBench.diagnostics())
    console.log(`  [recorded] FPS, honey block ${f.count} particles with the viscous solve on the real-time clock for 10 s (primary display): ${f.fps} fps, present interval p50 ${f.presentIntervalP50?.toFixed(1)} ms / p95 ${f.presentIntervalP95?.toFixed(1)} ms, real-time factor ${f.rtFactor.toFixed(3)}, dropped ${f.droppedTime.toFixed(2)} s; substeps ${d.substeps}, viscous solves ${d.viscousSolves} (cap hits ${d.viscousCapHits}, most iterations ${d.viscousMaxIterations}, cap ${d.viscousCap}), p caps ${d.pressureCapHits}/${d.pressureSolves}, ψ caps ${d.psiCapHits}/${d.psiSolves}`)
    report.fps = { count: f.count, fps: f.fps, rtFactor: f.rtFactor, p50: f.presentIntervalP50, p95: f.presentIntervalP95, droppedTime: f.droppedTime, diagnostics: d }
    gate.check(fp.errors.length === 0, `R FPS window: ${fp.errors.length} console errors`)
  } finally {
    await fp.browser.close()
  }
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's36-page', pass, report, gate.results)
process.exit(pass ? 0 : 1)
