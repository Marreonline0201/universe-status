#!/usr/bin/env node
// Gate S1.1 + S1.2 — real clock and SI gravity, measured on the owner's FLUID TEST page.
//
//   node scripts/fluid-gates/s1-clock.mjs [--url=...]
//
// G1 free fall (lockstep, frameDt ∈ {1/30, 1/60, 1/240} s): a blob in mid-air, centre of mass
//    fitted with the 3-parameter model y = y0 + v0·t − ½·g·t² (v0 free: symplectic Euler gives
//    y_n = y0 − ½g·t(t+Δt), which biases a 2-parameter fit by ~2% on correct code).
//    Pass: g_fit = 9.80665 m/s² ± 1% at each frameDt, and the three agree within 0.5%.
//    Reference: standard gravity (NIST CODATA, exact). Internal pressure cannot move the COM:
//    the MLS-MPM stress scatter sums Σ w_i (x_i − x_p) = 0 per particle, so momentum is exact
//    up to fixed-point rounding — the blob is also spawned under rest density (zero EOS pressure).
// G2 gravity slider: gravity 5.0 m/s² → fitted downward acceleration 5.0 ± 1%.
// G3 real time (realtime clock, default 10k water scene, 10 s): sim seconds per wall second
//    1.00 ± 0.02, and p95 presented-frame interval ≤ 1/60 s + one 240 Hz vsync (20.83 ms).
// G4 hitch: a 50 ms main-thread stall causes at most 2 catch-up macro-steps in one frame
//    (and the stall must actually trigger catch-up, or the test proved nothing).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, centreOfMass, fitQuadratic, makeGate, status, DOMAIN_L_M, G_STANDARD, FLUID_TEST_URL } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let url = FLUID_TEST_URL
for (const a of process.argv.slice(2)) { const m = /^--url=(.+)$/.exec(a); if (m) url = m[1] }

const blob = g => ({
  name: 'gate-freefall',
  materials: [{ name: 'water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }],
  spawns: [{ material: 'water', count: 500, center: [0.5, 0.75, 0.5], spread: 0.05 }],
  gravity_mps2: g,
})
const TIMES = [0, 2, 4, 6, 8, 10, 12].map(k => k / 30)   // 0 … 0.4 s, multiples of every frameDt

const gate = makeGate('GATE S1.1/S1.2 (clock + SI gravity)')
const report = { url, g: {}, rt: {}, hitch: {} }
const { browser, page, errors, adapter } = await openFluidPage(url)
report.adapter = adapter
try {
  async function freeFall(gMs2, frameDt) {
    await page.evaluate(([dt, g]) => window.__fluidBench.configure({ clock: 'lockstep', frameDt: dt, gravityMs2: g }), [frameDt, gMs2])
    await loadScenario(page, blob(gMs2), 7)
    const ts = [], ys = []
    let bad = 0
    for (const t of TIMES) {
      const frame = Math.round(t / frameDt)
      const s = await sampleAtFrame(page, frame)
      const c = centreOfMass(s)
      bad += c.bad
      ts.push(frame * frameDt)
      ys.push(c.y * DOMAIN_L_M)
    }
    const fit = fitQuadratic(ts, ys)
    return { gFit: -2 * fit.c, v0: fit.b, resid: fit.resid, bad, drop: ys[0] - ys[ys.length - 1] }
  }

  // G1
  const gFits = []
  for (const [label, dt] of [['1/30', 1 / 30], ['1/60', 1 / 60], ['1/240', 1 / 240]]) {
    const r = await freeFall(G_STANDARD, dt)
    report.g[label] = r
    gFits.push(r.gFit)
    const err = Math.abs(r.gFit - G_STANDARD) / G_STANDARD
    gate.check(err <= 0.01 && r.bad === 0, `G1 free fall frameDt ${label}: g_fit = ${r.gFit.toFixed(4)} m/s² (err ${(err * 100).toFixed(3)}%, fall ${r.drop.toFixed(3)} m, fit resid ${r.resid.toExponential(2)} m)`)
  }
  const spread = (Math.max(...gFits) - Math.min(...gFits)) / G_STANDARD
  gate.check(spread <= 0.005, `G1 frameDt independence: g_fit spread ${(spread * 100).toFixed(3)}% (≤ 0.5%)`)

  // G2
  const r5 = await freeFall(5.0, 1 / 60)
  report.g.slider5 = r5
  const e5 = Math.abs(r5.gFit - 5.0) / 5.0
  gate.check(e5 <= 0.01 && r5.drop > 0, `G2 gravity 5.0 m/s²: fitted ${r5.gFit.toFixed(4)} m/s² downward (err ${(e5 * 100).toFixed(3)}%)`)

  // G3
  await page.evaluate(() => { const b = window.__fluidBench; b.configure({ clock: 'realtime', gravityMs2: 9.80665 }); b.setStepLimit(0); b.action('reset', 3); b.setStepLimit(Infinity) })
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.__fluidBench.configure({ resetClockStats: true }))
  const a0 = await page.evaluate(() => ({ st: window.__fluidBench.status(), now: performance.now() }))
  await page.waitForTimeout(10_000)
  const a1 = await page.evaluate(() => ({ st: window.__fluidBench.status(), now: performance.now() }))
  const rt = (a1.st.simTime - a0.st.simTime) / ((a1.now - a0.now) / 1000)
  report.rt = { rt, p50: a1.st.presentIntervalP50, p95: a1.st.presentIntervalP95, dropped: a1.st.droppedTime, fps: a1.st.fps }
  gate.check(Math.abs(rt - 1) <= 0.02, `G3 real time: ${rt.toFixed(4)} sim s per wall s over 10 s (dropped ${a1.st.droppedTime.toFixed(3)} s)`)
  gate.check(a1.st.presentIntervalP95 <= 1000 / 60 + 1000 / 240, `G3 presentation: p95 frame interval ${a1.st.presentIntervalP95?.toFixed(2)} ms (p50 ${a1.st.presentIntervalP50?.toFixed(2)}) ≤ 20.83 ms; ${a1.st.fps} fps`)

  // G4
  await page.evaluate(() => window.__fluidBench.configure({ resetClockStats: true }))
  await page.waitForTimeout(300)
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 50) { /* stall the main thread */ } })
  await page.waitForTimeout(300)
  const h = await status(page)
  report.hitch = { maxFrameSteps: h.maxFrameSteps, dropped: h.droppedTime }
  gate.check(h.maxFrameSteps === 2, `G4 hitch: 50 ms stall → max ${h.maxFrameSteps} macro-steps in one frame (must be exactly the cap 2: triggered, and bounded)`)

  gate.check(errors.length === 0, `no unexpected console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
const out = path.join(repoRoot, 'bench-results', 'gates', `s1-clock-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ pass, ...report, checks: gate.results }, null, 2))
console.log(`→ ${path.relative(repoRoot, out)}`)
process.exit(pass ? 0 : 1)
