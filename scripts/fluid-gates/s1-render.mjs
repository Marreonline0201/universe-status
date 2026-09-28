#!/usr/bin/env node
// Gate S1.6 — no per-frame particle readback while SSFR draws; the Points fallback still works.
//
//   node scripts/fluid-gates/s1-render.mjs
//
// R1 100k particles, SSFR healthy: renderPath 'ssfr' and zero Points readbacks over 120 frames.
// R2 forced SSFR failure: renderPath switches to 'points' within 2 presented frames and
//    readbacks resume (one per frame that moved the fluid), so the fallback shows live positions.
// R3 (reported) presented-frame rate at 100k in lockstep vs the a400506 baseline (159 FPS, which
//    paid an 8 MB readback every frame). The 240 Hz vsync caps what can be seen here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, waitStepped, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S1.6 (readback only for the fallback)')
const report = {}
const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665, forceSsfrFailure: false }))
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, 'company/lab/survey-05-scaling-100k/scenario.json'), 'utf8'))
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
  await page.evaluate(() => window.__fluidBench.configure({ forceSsfrFailure: true }))
  const c = await status(page)
  let switchedAfter = null
  for (let i = 0; i < 40 && switchedAfter === null; i++) {
    await page.waitForTimeout(5)
    const s = await status(page)
    if (s.renderPath === 'points') switchedAfter = s.rafFrames - c.rafFrames
  }
  await waitStepped(page, (await status(page)).framesStepped + 30)
  const d = await status(page)
  report.r2 = { switchedAfterFrames: switchedAfter, readbacks: d.pointsReadbacks - c.pointsReadbacks }
  gate.check(switchedAfter !== null && switchedAfter <= 2, `R2 forced SSFR failure → Points path after ${switchedAfter} presented frame(s) (≤ 2)`)
  gate.check(d.pointsReadbacks - c.pointsReadbacks >= 30, `R2 fallback receives live positions: ${d.pointsReadbacks - c.pointsReadbacks} readbacks over ≥ 30 stepped frames`)
  await page.evaluate(() => window.__fluidBench.configure({ forceSsfrFailure: false }))
  gate.check(errors.length === 0, `no unexpected console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
const out = path.join(repoRoot, 'bench-results', 'gates', `s1-render-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ pass, ...report, checks: gate.results }, null, 2))
console.log(`→ ${path.relative(repoRoot, out)}`)
process.exit(pass ? 0 : 1)
