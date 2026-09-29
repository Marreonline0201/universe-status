#!/usr/bin/env node
// Gate S3.6e on the FLUID TEST page — the unified pressure–stress solve wired into the page (spec vault
// fluid/realism-2026-09/S3.6e-variational-stokes-spec.md §5 G3; the solve itself: s36e-gpu.mjs, the reference s36e-ref.mjs).
//
//   node scripts/fluid-gates/s36e-page.mjs   (default server: the clean gate tree; FLUID_BASE to override)
//
// Criteria (fixed before the first run). Lockstep clock, 1/60 s per frame; tank = the 64³ window, 3.63 m. The page holds
// ≤ 200k particles, so a lava pool over the whole floor is ≤ 0.35 m deep: the scene is a 0.30 m pool of the page's Lava
// (degassed GRD melt) at 1100 °C (1478 Pa·s — S3.7 A5's melt, so the ball is still moving through the window) with the page's iron ball (R = 0.05 world units = 0.18 m) released just above it. This
// gate checks the WIRING; the physics (fall speed, added mass, the solve's residual) is s36e-gpu's.
// W1 routing ('auto', the measured rule): the Stokes path runs with the ball over the lava; not without the ball; not with
//    the ball over water (water's ν is below the viscous run rule, so the split path keeps it).
// W2 the solve converges on the page: no cap hit after the first 0.5 s (the adaptive cap's warm-up) up to 3 s, and the last
//    solve converged.
// W3 the ball enters the lava and sinks: at 3 s its centre is below the release height and its bottom below the pool's
//    surface; finite.
// W4 the on-page note: the FPS bar shows "BALL IN THICK LIQUID" with the iteration count while the solve runs.
// FPS (recorded): the same scene on the real-time clock for 10 s in a primary-display window (owner 2026-09-29: timing
//    runs stay there) — present interval p50/p95, real-time factor, the solve's iterations.
// R  0 uncaptured GPU errors; 0 console errors.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sampleAtFrame, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.6e on the FLUID TEST page (the unified solve, wired)')
const report = { prov: await provenance() }
const L = 3.63, DEPTH = 0.30, RW = 0.05, R = RW * L
const lava = { material: 'Lava', temperature: 1100, box: { min: [0, 0, 0], max: [3.63, DEPTH, 3.63] } }
const water = { material: 'Water', box: { min: [0, 0, 0], max: [3.63, DEPTH, 3.63] } }
const cy = (DEPTH + R + 0.02) / L
const ball = { center: [0.5, cy, 0.5], radius: RW }
const scene = (spawn, withBall) => ({ name: 's36e-page', materials: [], spawns: [spawn], gravity_mps2: G_STANDARD, ...(withBall ? { ball } : {}) })

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  // W1
  const routed = {}
  for (const [key, sp, b] of [['lava+ball', lava, true], ['lava', lava, false], ['water+ball', water, true]]) {
    await loadScenario(page, scene(sp, b), 1)
    await sampleAtFrame(page, 3)
    routed[key] = (await status(page)).stokes
  }
  report.routing = routed
  gate.check(routed['lava+ball']?.active === true && routed.lava?.active === false && routed['water+ball']?.active === false,
    `W1 routing: the unified solve runs for the ball over lava (${routed['lava+ball']?.active}), not for lava alone (${routed.lava?.active}), not for the ball over water (${routed['water+ball']?.active})`)
  // W2 + W3
  await loadScenario(page, scene(lava, true), 2)
  await sampleAtFrame(page, 30)
  const s05 = (await status(page)).stokes
  await sampleAtFrame(page, 180)
  const st = await status(page)
  const s3 = st.stokes
  report.solve = { at05: s05, at3: s3 }
  gate.check(s3.active && s3.capHits - s05.capHits === 0 && s3.converged,
    `W2 the solve on the page (0.5 → 3 s): cap hits ${s3.capHits - s05.capHits} (first 0.5 s: ${s05.capHits}), last solve converged ${s3.converged} in ${s3.iterations} iterations, most ${s3.maxIterations} since the load (adaptive cap now ${s3.cap})`)
  const b = st.ball, yc = b.center[1] * L, released = cy * L
  report.ball = { yc, released, velocity: b.velocity }
  gate.check(Number.isFinite(yc) && yc < released && yc - R < DEPTH,
    `W3 the ball in the lava at 3 s: centre ${(100 * yc).toFixed(1)} cm (released at ${(100 * released).toFixed(1)} cm), bottom at ${(100 * (yc - R)).toFixed(1)} cm, below the pool surface at ${(100 * DEPTH).toFixed(1)} cm; velocity ${(b.velocity[1] * L / (1 / 24)).toFixed(4)} m/s`)
  // W4 (the stats callback runs every 0.5 s of presented frames)
  await page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
  await page.waitForTimeout(1500)
  const badge = await page.evaluate(() => [...document.querySelectorAll('span')].map(s => s.textContent ?? '').find(t => t.includes('BALL IN THICK LIQUID')) ?? null)
  report.badge = badge
  gate.check(!!badge, `W4 the on-page note: ${badge ? `"${badge}"` : 'not shown'}`)

  // FPS on the real-time clock, primary display
  const fp = await openFluidPage(undefined, { timing: true })
  let f, d
  try {
    await fp.page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    await loadScenario(fp.page, scene(lava, true), 2)
    await sampleAtFrame(fp.page, 60)
    await fp.page.evaluate(() => window.__fluidBench.configure({ clock: 'realtime', resetClockStats: true, resetDiagnostics: true }))
    await fp.page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
    await fp.page.waitForTimeout(10_000)
    f = await status(fp.page)
    d = await fp.page.evaluate(() => window.__fluidBench.diagnostics())
    errors.push(...fp.errors)
  } finally {
    await fp.browser.close()
  }
  report.fps = { count: f.count, fps: f.fps, rtFactor: f.rtFactor, p50: f.presentIntervalP50, p95: f.presentIntervalP95, droppedTime: f.droppedTime, stokes: f.stokes, diagnostics: d }
  console.log(`  [recorded] FPS, ball in ${f.count} lava particles on the real-time clock for 10 s: ${f.fps} fps, present interval p50 ${f.presentIntervalP50?.toFixed(1)} ms / p95 ${f.presentIntervalP95?.toFixed(1)} ms, real-time factor ${f.rtFactor.toFixed(3)}, dropped ${f.droppedTime.toFixed(2)} s; substeps ${d.substeps}; Stokes: last ${f.stokes?.iterations} it, most ${f.stokes?.maxIterations}, cap ${f.stokes?.cap}, cap hits ${f.stokes?.capHits}`)
  const gpuErr = (await status(page)).gpuErrors + f.gpuErrors
  gate.check(gpuErr === 0, `R GPU: ${gpuErr} uncaptured WebGPU errors (gate page + FPS window)`)
  gate.check(errors.length === 0, `R console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's36e-page', pass, report, gate.results)
process.exit(pass ? 0 : 1)
