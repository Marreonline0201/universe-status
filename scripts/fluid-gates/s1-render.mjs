#!/usr/bin/env node
// Gate S1.6 — no per-frame particle readback while SSFR draws; the Points fallback still works.
//
//   node scripts/fluid-gates/s1-render.mjs
//
// R1 100k particles, SSFR healthy: renderPath 'ssfr' and zero Points readbacks over 120 frames.
// R2 forced SSFR failure, in the REALTIME clock the owner sees: renderPath switches to 'points'
//    within 2 presented frames, and COMPLETED readbacks (positions actually copied into the Points
//    geometry) arrive for at least half the presented frames over 2 s — live positions, not the
//    last frame SSFR drew. (Lockstep at ~180 fps is reported too: a mapAsync in flight spans
//    several such frames there, which says nothing about what a viewer sees at 60 Hz.)
// R3 (reported) presented-frame rate at 100k in lockstep vs the a400506 baseline (159 FPS, which
//    paid an 8 MB readback every frame). The 240 Hz vsync caps what can be seen here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, waitStepped, makeGate, writeReport } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S1.6 (readback only for the fallback)')
const report = {}
const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665, forceSsfrFailure: false }))
  // a verbatim copy of the office lab scenario (company/ is untracked, so the clean gate tree does not have it)
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/fluid-gates/data/scenarios/survey-05-scaling-100k.json'), 'utf8'))
  await loadScenario(page, scenario, 51)
  await page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
  await waitStepped(page, 30)

  // R1
  const a = await status(page)
  const t0 = await page.evaluate(() => performance.now())
  await waitStepped(page, a.framesStepped + 120)
  const b = await status(page)
  const t1 = await page.evaluate(() => performance.now())
  const fps = (b.rafFrames - a.rafFrames) / ((t1 - t0) / 1000)
  report.r1 = { n: b.count, renderPath: b.renderPath, readbacks: b.pointsReadbacks - a.pointsReadbacks, fps }
  gate.check(b.renderPath === 'ssfr' && b.pointsReadbacks === a.pointsReadbacks, `R1 ${b.count} particles: render path ${b.renderPath}, ${b.pointsReadbacks - a.pointsReadbacks} readbacks over 120 frames (must be 0)`)
  console.log(`  R3 presented-frame rate at ${b.count} particles, lockstep: ${fps.toFixed(1)} fps (a400506 baseline with per-frame readback: 159)`)

  // R2
  // lockstep figure, reported only
  await page.evaluate(() => window.__fluidBench.configure({ forceSsfrFailure: true }))
  const l0 = await status(page)
  await waitStepped(page, l0.framesStepped + 30)
  const l1 = await status(page)
  report.r2lockstep = { completed: l1.pointsReadbacksCompleted - l0.pointsReadbacksCompleted, steppedFrames: l1.framesStepped - l0.framesStepped }
  // the gate, in the realtime clock
  // Reset the clock statistics at the switch: presentIntervalP50 kept the 5.6 ms lockstep intervals of R1, so the old
  // "presented = 2 s / p50" read ~346 frames at a real 60 fps (120). Presented frames are now COUNTED (framesAdvanced).
  await page.evaluate(() => window.__fluidBench.configure({ forceSsfrFailure: false, clock: 'realtime', resetClockStats: true }))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__fluidBench.configure({ forceSsfrFailure: true }))
  const c = await status(page)
  let switchedAfter = null
  for (let i = 0; i < 40 && switchedAfter === null; i++) {
    await page.waitForTimeout(5)
    const s = await status(page)
    if (s.renderPath === 'points') switchedAfter = s.framesAdvanced - c.framesAdvanced
  }
  const w0 = await page.evaluate(() => performance.now())
  const s0 = await status(page)
  await page.waitForTimeout(2000)
  const w1 = await page.evaluate(() => performance.now())
  const d = await status(page)
  const presented = d.framesAdvanced - s0.framesAdvanced
  const done = d.pointsReadbacksCompleted - s0.pointsReadbacksCompleted
  report.r2 = { switchedAfterPresentedFrames: switchedAfter, presented, completed: done, wallMs: w1 - w0, lockstep: report.r2lockstep }
  gate.check(switchedAfter !== null && switchedAfter <= 2, `R2 forced SSFR failure → Points path after ${switchedAfter} presented frame(s) (≤ 2)`)
  gate.check(done >= 0.5 * presented, `R2 fallback receives live positions: ${done} completed readbacks over ~${presented} presented frames in 2 s (≥ half); lockstep 180 fps: ${report.r2lockstep.completed}/${report.r2lockstep.steppedFrames} [reported]`)
  await page.evaluate(() => window.__fluidBench.configure({ forceSsfrFailure: false }))
  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's1-render', pass, report, gate.results)
process.exit(pass ? 0 : 1)
