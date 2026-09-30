#!/usr/bin/env node
// Gate PERF-1 L0 on the GPU — the per-kernel dispatch budget (S3N-23; vault fluid/realism-2026-09 PERF-1 spec §4 L0):
// FlipGpuSimulator.step(encoder, n) encoded through a counting wrapper (never submitted) for every flag combination of
// src/bench/flipSelftest/budget.ts — transfers only; voxel; voxel + variable density; ghost + density (with particles,
// with none, with 3 extrapolation layers, with JPCG); the split viscous path; the weak and the monolithic ball (and the
// monolithic ball with the split viscous path); the Stokes path; the drift in both forms (and the face form with the
// split viscous path); the floor's wall shear (with particles, in an empty tank, and set but guarded off by the split
// viscous path; added 2026-09-30 with the friction stage, criteria unchanged; and set but guarded off by the immiscible
// drift, added with the friction fix round's INT-7 guard, criteria unchanged) — at 64³, 48³ and 24×16×12, n = 1, 2, 3, 4.
// Criteria, fixed 2026-09-30 02:48 at `3810066c` before the first run: every frame's dispatches per pass label equal
// src/gpu-sim/flip/dispatchBudget.ts frameDispatches(sim.budgetState(n)) exactly (tolerance 0); every combination ×
// shape ran all 4 frames; 0 uncaptured WebGPU errors, 0 console errors. Its positive controls are gpu-mutations
// --gate=perf1 (D1 one extra dispatch in the encode; D2 the rank term dropped from the formula; D3 one extra wall-shear
// cell dispatch — each must fail here).
//
//   node scripts/fluid-gates/perf1-gpu.mjs     (default server: the clean gate tree; FLUID_BASE to override)
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE PERF-1 L0 (dispatch budget on the GPU)')
const report = { prov: await provenance() }
const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: [...windowArgs(), '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation/i.test(m.text()))) errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
  await page.goto(`${BASE}/flip-selftest.html`, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__flipTest && (window.__flipTest.ready || window.__flipTest.error), null, { timeout: 90_000 })
  const init = await page.evaluate(() => ({ err: window.__flipTest.error, info: window.__flipTest.info() }))
  if (init.err) throw new Error(`self-test page init failed: ${init.err}`)
  if (init.info.vendor !== 'nvidia') throw new Error(`adapter is ${init.info.vendor}, not the NVIDIA dGPU`)
  report.adapter = init.info
  const r = await page.evaluate(() => window.__flipTest.run('budgetKernels', {}))
  report.budget = r
  const expectFrames = r.combos * r.shapes * 4
  for (const row of r.rows) {
    gate.check(row.frames === 4 && row.mismatches.length === 0,
      `L0 ${row.combo}, ${row.shape}: ${row.frames} frames (n = 1…4, dispatches ${row.totals.join(' / ')}) — ${row.mismatches.length ? `MISMATCH ${row.mismatches.slice(0, 4).map(m => `n ${m.n} ${m.label} counted ${m.counted} vs budget ${m.budget}`).join('; ')}` : 'every label equals the budget'}`)
  }
  gate.check(r.frames === expectFrames && r.mismatchedFrames === 0, `L0 total: ${r.frames} frames of ${expectFrames} (${r.combos} combinations × ${r.shapes} shapes × n = 1…4), ${r.mismatchedFrames} with a mismatch (0)`)
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'perf1-gpu', pass, report, gate.results)
exitGate(pass ? 0 : 1)
