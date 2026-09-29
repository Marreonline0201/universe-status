#!/usr/bin/env node
// Gate S3.1c — the incompressible solver behind the real FLUID TEST page (FINAL-PLAN §7 S3.1c: page wiring; the S3.1b
// checks re-run through the FLUID TEST route; render proof; FPS measured and recorded, not gated).
//
//   node scripts/fluid-gates/s31c-page.mjs     (default server: the clean gate tree; FLUID_BASE to override)
//
// Criteria (fixed before the first run). Lockstep clock, 1/60 s per frame; tank = the 64³ window, 3.63 m, floor at y = 0.
// P1 stillness (C5 through the page): a water pool (scenario box 3.63 × 0.17 × 3.63 m: the whole floor, so it starts at rest);
//    after 6 s the RMS particle speed ≤ 1 % √(gH), H = N·V_p / (3.63 m)² (V_p = dx³/8).
// P2 level: the pool's mean particle height after 6 s = H/2 within ±¼·dx (a flat pool of uniform density).
// B1 buoyancy order (the owner's check "oil floats, mercury sinks"): the same pool with an olive-oil block and a mercury
//    block released above it; after 8 s COM_y(mercury) < COM_y(water) < COM_y(oil), each gap ≥ ½·dx; ≥ 90 % of the oil
//    above the water's median height and ≥ 90 % of the mercury below it.
// B2 iron floats on mercury (added 2026-09-29 with S3.7's monolithic ball, fixed before its first run): a mercury pool
//    over the whole floor, 0.28 m deep, the page's iron ball (R = 0.05 world units = 0.18 m) released at rest just above
//    the surface; mean submerged fraction over 6–8 s = ρ_Fe/ρ_Hg (NIST SRD 126 / materialData) ± 5 % (Archimedes; the
//    fraction from the ball's centre and the level L = (N·V_p + f·V)/A, solved together — s37-ref A4's measure).
// R  the page runs the incompressible solver; SSFR drew; no NaN positions; 0 uncaptured GPU errors; 0 console errors.
// FPS (recorded): the B1 scene on the real-time clock for 10 s — present interval p50/p95, real-time factor, substeps — in
//     its own window on the PRIMARY display (owner 2026-09-29: timing runs stay there; lib/window.mjs).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sample, sampleAtFrame, waitStepped, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.1c (incompressible solver on the FLUID TEST page)')
const report = { prov: await provenance() }
const L = 3.63, DX = L / 64, VP = DX ** 3 / 8, TAU = 1 / 24
const pool = { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } }
const oil = { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } }
const hg = { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  const st0 = await status(page)
  gate.check(st0.solver === 'flip', `R the FLUID TEST page runs the incompressible solver (status.solver = ${st0.solver})`)
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)

  // P1 + P2: the pool alone
  await loadScenario(page, { name: 's31c-pool', materials: [], spawns: [pool], gravity_mps2: G_STANDARD }, 1)
  const s = await sampleAtFrame(page, 360)
  const n = s.n, H = n * VP / (L * L)
  let v2 = 0, ySum = 0, bad = 0
  for (let i = 0; i < n; i++) {
    const vx = s.vel[3 * i] * L / TAU, vy = s.vel[3 * i + 1] * L / TAU, vz = s.vel[3 * i + 2] * L / TAU, y = s.pos[3 * i + 1] * L
    if (!Number.isFinite(vx + vy + vz + y)) { bad++; continue }
    v2 += vx * vx + vy * vy + vz * vz; ySum += y
  }
  const rms = Math.sqrt(v2 / (n - bad)), meanY = ySum / (n - bad), lim = 0.01 * Math.sqrt(G_STANDARD * H)
  report.pool = { n, H, rms, meanY, bad }
  gate.check(rms <= lim && bad === 0, `P1 stillness after 6 s (${n} particles, H = N·V_p/A = ${(100 * H).toFixed(2)} cm): RMS speed ${rms.toExponential(2)} m/s (≤ ${lim.toExponential(2)} = 1 % √(gH)); non-finite ${bad}`)
  gate.check(Math.abs(meanY - H / 2) <= 0.25 * DX, `P2 level: mean particle height ${(100 * meanY).toFixed(2)} cm vs H/2 ${(100 * H / 2).toFixed(2)} cm (±¼·dx = ${(25 * DX).toFixed(2)} cm)`)

  // B1: pool + oil + mercury
  await loadScenario(page, { name: 's31c-buoyancy', materials: [], spawns: [pool, oil, hg], gravity_mps2: G_STANDARD }, 2)
  const b = await sampleAtFrame(page, 480)
  const nameOf = new Map(b.materials.map(m => [m.id, m.name]))
  const ys = { Water: [], 'Olive Oil': [], Mercury: [] }
  let nan = 0
  for (let i = 0; i < b.n; i++) {
    const y = b.pos[3 * i + 1] * L, name = nameOf.get(b.comp[i])
    if (!Number.isFinite(y)) { nan++; continue }
    if (ys[name]) ys[name].push(y)
  }
  const mean = a => a.reduce((q, v) => q + v, 0) / a.length
  const wSorted = [...ys.Water].sort((p, q) => p - q), wMedian = wSorted[Math.floor(wSorted.length / 2)]
  const cW = mean(ys.Water), cO = mean(ys['Olive Oil']), cH = mean(ys.Mercury)
  const oilAbove = ys['Olive Oil'].filter(y => y > wMedian).length / ys['Olive Oil'].length
  const hgBelow = ys.Mercury.filter(y => y < wMedian).length / ys.Mercury.length
  report.buoyancy = { counts: Object.fromEntries(Object.entries(ys).map(([k, v]) => [k, v.length])), cW, cO, cH, wMedian, oilAbove, hgBelow, nan }
  gate.check(cH + 0.5 * DX <= cW && cW + 0.5 * DX <= cO && nan === 0,
    `B1 order after 8 s (water ${ys.Water.length}, oil ${ys['Olive Oil'].length}, mercury ${ys.Mercury.length} particles): COM height mercury ${(100 * cH).toFixed(1)} cm < water ${(100 * cW).toFixed(1)} cm < oil ${(100 * cO).toFixed(1)} cm (each gap ≥ ½·dx = ${(50 * DX).toFixed(1)} cm)`)
  gate.check(oilAbove >= 0.9 && hgBelow >= 0.9, `B1 separation: ${(100 * oilAbove).toFixed(1)} % of the oil above the water's median height ${(100 * wMedian).toFixed(1)} cm (≥ 90 %), ${(100 * hgBelow).toFixed(1)} % of the mercury below it (≥ 90 %)`)

  // B2: iron floats on mercury
  {
    const depth = 0.28, Rw = 0.05, R = Rw * L, RHO_FE = 7874, RHO_HG = 13545.859
    const cy = depth / L + Rw + 0.005
    await loadScenario(page, { name: 's31c-iron-on-mercury', materials: [], spawns: [{ material: 'Mercury', box: { min: [0, 0, 0], max: [3.63, depth, 3.63] } }], gravity_mps2: G_STANDARD, ball: { center: [0.5, cy, 0.5], radius: Rw } }, 3)
    const A = L * L, V = 4 / 3 * Math.PI * R ** 3, fRef = RHO_FE / RHO_HG
    const fs = []
    let nHg = 0, ballGone = false
    for (let f = 360; f <= 480; f += 12) {
      await page.evaluate(fr => window.__fluidBench.setStepLimit(fr), f)
      const st = await waitStepped(page, f)
      if (!st.ball) { ballGone = true; break }
      if (!nHg) nHg = (await sample(page)).n
      const yc = st.ball.center[1] * L
      let fr = 0.5
      for (let it = 0; it < 50; it++) { const Lv = (nHg * VP + fr * V) / A, h = Math.min(2 * R, Math.max(0, Lv - (yc - R))); fr = h * h * (3 * R - h) / (4 * R ** 3) }
      fs.push(fr)
    }
    const fMean = fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : NaN
    report.ironOnMercury = { fs, fMean, fRef, nHg, ballGone }
    gate.check(!ballGone && Math.abs(fMean / fRef - 1) <= 0.05,
      `B2 iron floats on mercury (${nHg} mercury particles, ball R = ${(100 * R).toFixed(1)} cm): mean submerged fraction over 6–8 s ${fMean.toFixed(4)} (range ${Math.min(...fs).toFixed(3)}–${Math.max(...fs).toFixed(3)}) vs ρ_Fe/ρ_Hg ${fRef.toFixed(4)} (${(100 * (fMean / fRef - 1)).toFixed(2)} %, ±5 %)`)
  }

  // R: render path, then FPS on the real-time clock (the B1 scene again, settled 8 s, in a primary-display window)
  const r = await status(page)
  gate.check(r.renderPath === 'ssfr', `R SSFR drew the frame (render path ${r.renderPath})`)
  const fp = await openFluidPage(undefined, { timing: true })
  let f, d
  try {
    await fp.page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    await loadScenario(fp.page, { name: 's31c-buoyancy', materials: [], spawns: [pool, oil, hg], gravity_mps2: G_STANDARD }, 2)
    await sampleAtFrame(fp.page, 480)   // the settled B1 state, as measured before the window moved (8 s lockstep)
    await fp.page.evaluate(() => window.__fluidBench.configure({ clock: 'realtime', resetClockStats: true, resetDiagnostics: true }))
    await fp.page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
    await fp.page.waitForTimeout(10_000)
    f = await status(fp.page)
    d = await fp.page.evaluate(() => window.__fluidBench.diagnostics())
    errors.push(...fp.errors)
  } finally {
    await fp.browser.close()
  }
  report.fps = { count: f.count, fps: f.fps, rtFactor: f.rtFactor, p50: f.presentIntervalP50, p95: f.presentIntervalP95, droppedTime: f.droppedTime, diagnostics: d }
  console.log(`  [recorded] FPS, ${f.count} particles on the real-time clock for 10 s: ${f.fps} fps, present interval p50 ${f.presentIntervalP50?.toFixed(1)} ms / p95 ${f.presentIntervalP95?.toFixed(1)} ms, real-time factor ${f.rtFactor.toFixed(3)}, dropped ${f.droppedTime.toFixed(2)} s; substeps ${d.substeps}, v_lag ${d.vLag?.toFixed(2)} m/s, p caps ${d.pressureCapHits}/${d.pressureSolves}, ψ caps ${d.psiCapHits}/${d.psiSolves}, breakdowns ${d.breakdowns}, CFL > 1 substeps ${d.cflExceeded}`)
  const gpuErr = (await status(page)).gpuErrors + f.gpuErrors
  gate.check(gpuErr === 0, `R GPU: ${gpuErr} uncaptured WebGPU errors (gate page + FPS window)`)
  gate.check(errors.length === 0, `R console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's31c-page', pass, report, gate.results)
process.exit(pass ? 0 : 1)
