#!/usr/bin/env node
// Gate S1.1 + S1.2 — real clock and SI gravity, on the owner's FLUID TEST page (clean gate tree).
//
//   node scripts/gate-server.mjs &   then   node scripts/fluid-gates/s1-clock.mjs
//
// G1 free fall (lockstep, frameDt ∈ {1/30, 1/60, 1/240} s): a blob in mid-air, centre of mass
//    fitted with y = y0 + v0·t − ½·g·t² (v0 free: symplectic Euler gives y_n = y0 − ½g·t(t+Δt),
//    which biases a 2-parameter fit by ~2% on correct code). Pass: g_fit = 9.80665 ± 1% at each
//    frameDt and the three agree within 0.5%. Reference: standard gravity (NIST, exact). Internal
//    pressure cannot move the COM (Σ w_i (x_i − x_p) = 0 per particle); the blob is spawned under
//    rest density (zero EOS pressure) anyway.
// G2 the GRAVITY SLIDER itself (React input → page state → engine): set to 5.00 → engine reports
//    5.00 m/s² and the fitted downward acceleration is 5.00 ± 1%.
// G3 real time, on the explicitly loaded default scene (count ≈ 10k, g = standard), realtime
//    clock, 10 s: sim seconds per wall second 1.00 ± 0.02; presentation ≈ 60 fps on this panel;
//    NO JUDDER: ≥ 99% of presented frames advance within 1% of the target interval (a 0-step or
//    2-step frame is 100% off); the fluid actually moved (GPU did the work).
// G4 hitch: a 3 s control window with no stall records zero dilation and no frame > 1.01 target;
//    then a 50 ms main-thread stall → that frame advances ≤ 2 targets and ≥ 10 ms of dilation is
//    recorded (proves the cap fired — background noise alone produces 0 in the control window).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, sample, centreOfMass, fitQuadratic, makeGate, status, writeReport, DOMAIN_L_M, G_STANDARD } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const blob = g => ({
  name: 'gate-freefall',
  materials: [{ name: 'water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }],
  spawns: [{ material: 'water', count: 500, center: [0.5, 0.75, 0.5], spread: 0.05 }],
  ...(g !== undefined ? { gravity_mps2: g } : {}),
})
const TIMES = [0, 2, 4, 6, 8, 10, 12].map(k => k / 30)   // 0 … 0.4 s, multiples of every frameDt

const gate = makeGate('GATE S1.1/S1.2 (clock + SI gravity)')
const report = { g: {}, rt: {}, hitch: {} }
const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
const bench = (fn, arg) => page.evaluate(fn, arg)
try {
  async function fitFall(frameDt) {
    const ts = [], ys = []
    let bad = 0
    for (const t of TIMES) {
      const frame = Math.round(t / frameDt)
      const c = centreOfMass(await sampleAtFrame(page, frame))
      bad += c.bad
      ts.push(frame * frameDt)
      ys.push(c.y * DOMAIN_L_M)
    }
    const fit = fitQuadratic(ts, ys)
    return { gFit: -2 * fit.c, resid: fit.resid, bad, drop: ys[0] - ys[ys.length - 1] }
  }

  // G1
  const gFits = []
  for (const [label, dt] of [['1/30', 1 / 30], ['1/60', 1 / 60], ['1/240', 1 / 240]]) {
    await bench(d => window.__fluidBench.configure({ clock: 'lockstep', frameDt: d }), dt)
    await loadScenario(page, blob(G_STANDARD), 7)
    const r = await fitFall(dt)
    report.g[label] = r
    gFits.push(r.gFit)
    const err = Math.abs(r.gFit - G_STANDARD) / G_STANDARD
    gate.check(err <= 0.01 && r.bad === 0, `G1 free fall frameDt ${label}: g_fit = ${r.gFit.toFixed(4)} m/s² (err ${(err * 100).toFixed(3)}%, fall ${r.drop.toFixed(3)} m)`)
  }
  const spread = (Math.max(...gFits) - Math.min(...gFits)) / G_STANDARD
  gate.check(spread <= 0.005, `G1 frameDt independence: g_fit spread ${(spread * 100).toFixed(3)}% (≤ 0.5%)`)

  // G2 — the real slider
  await bench(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60 }))
  await loadScenario(page, blob(undefined), 8)             // scenario leaves gravity at standard
  const slider = page.locator('div:has(> label:text-is("GRAVITY")) input[type="range"]')
  const setSlider = v => slider.evaluate((el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, String(v))
  await setSlider(5)
  await page.waitForTimeout(100)
  const g2 = (await status(page)).gravityMs2
  const r5 = await fitFall(1 / 60)
  report.g.slider5 = { engineGravity: g2, ...r5 }
  const e5 = Math.abs(r5.gFit - 5.0) / 5.0
  gate.check(Math.abs(g2 - 5) < 1e-9 && e5 <= 0.01 && r5.drop > 0, `G2 GRAVITY slider → 5.00: engine ${g2} m/s², fitted ${r5.gFit.toFixed(4)} m/s² downward (err ${(e5 * 100).toFixed(3)}%)`)
  await setSlider(G_STANDARD)

  // G3 — real time on the explicitly loaded default scene
  await bench(() => { const b = window.__fluidBench; b.setStepLimit(0); b.configure({ clock: 'realtime' }) })
  await bench(() => window.__fluidBench.action('defaultScene', 3))
  await bench(() => window.__fluidBench.setStepLimit(Infinity))
  await page.waitForTimeout(1500)
  const pre = await status(page)
  gate.check(pre.count >= 9500 && pre.count <= 10500 && Math.abs(pre.gravityMs2 - G_STANDARD) < 1e-6, `G3 scene: default water block, ${pre.count} particles, g = ${pre.gravityMs2} m/s²`)
  const sA = centreOfMass(await sample(page))
  await bench(() => window.__fluidBench.configure({ resetClockStats: true }))
  const a0 = await page.evaluate(() => ({ st: window.__fluidBench.status(), now: performance.now() }))
  await page.waitForTimeout(10_000)
  const a1 = await page.evaluate(() => ({ st: window.__fluidBench.status(), now: performance.now() }))
  const sB = centreOfMass(await sample(page))
  const rt = (a1.st.simTime - a0.st.simTime) / ((a1.now - a0.now) / 1000)
  const fps = 1000 / a1.st.presentIntervalP50
  const smooth = a1.st.framesWithin1pct / a1.st.framesAdvanced
  report.rt = { rt, fps, smooth, presentEvery: a1.st.presentEvery, vsyncMs: a1.st.vsyncMs, target: a1.st.targetFrameMs, dropped: a1.st.droppedTime, moved: Math.abs(sB.y - sA.y) * DOMAIN_L_M }
  gate.check(Math.abs(rt - 1) <= 0.02, `G3 real time: ${rt.toFixed(4)} sim s per wall s over 10 s (dilation ${a1.st.droppedTime.toFixed(3)} s)`)
  gate.check(Math.abs(fps - 60) <= 2, `G3 presentation: ${fps.toFixed(1)} fps (every ${a1.st.presentEvery} vsync of ${a1.st.vsyncMs.toFixed(3)} ms)`)
  gate.check(smooth >= 0.99, `G3 no judder: ${(smooth * 100).toFixed(2)}% of ${a1.st.framesAdvanced} frames advance within 1% of ${a1.st.targetFrameMs.toFixed(3)} ms (max ${a1.st.maxFrameAdvanceMs.toFixed(2)} ms)`)
  gate.check(report.rt.moved > 0.01, `G3 GPU did the work: fluid centre of mass moved ${report.rt.moved.toFixed(3)} m during the window`)

  // G4 — control window, then a stall
  await bench(() => window.__fluidBench.configure({ resetClockStats: true }))
  await page.waitForTimeout(3000)
  const c = await status(page)
  report.hitch.control = { dropped: c.droppedTime, maxAdvance: c.maxFrameAdvanceMs, target: c.targetFrameMs }
  gate.check(c.droppedTime === 0 && c.maxFrameAdvanceMs <= 1.01 * c.targetFrameMs, `G4 control (no stall, 3 s): dilation ${c.droppedTime} s, max frame advance ${c.maxFrameAdvanceMs.toFixed(2)} ms`)
  await bench(() => window.__fluidBench.configure({ resetClockStats: true }))
  await page.waitForTimeout(200)
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 50) { /* stall the main thread */ } })
  await page.waitForTimeout(300)
  const h = await status(page)
  report.hitch.stall = { dropped: h.droppedTime, maxAdvance: h.maxFrameAdvanceMs, target: h.targetFrameMs }
  gate.check(h.maxFrameAdvanceMs <= 2 * h.targetFrameMs * 1.001 && h.droppedTime >= 0.010, `G4 50 ms stall: max frame advance ${h.maxFrameAdvanceMs.toFixed(2)} ms (≤ 2 × ${h.targetFrameMs.toFixed(2)}), dilation ${(h.droppedTime * 1000).toFixed(1)} ms (≥ 10)`)

  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's1-clock', pass, report, gate.results)
process.exit(pass ? 0 : 1)
