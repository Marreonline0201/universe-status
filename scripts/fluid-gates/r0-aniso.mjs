#!/usr/bin/env node
// Gate R0-aniso — the anisotropic splat kernel (owner decision 2026-09-29; vault fluid/realism-2026-09/research/
// x10-anisotropic-splats.md): the GPU kernel (src/fluid-render/AnisoKernel.ts + shaders/ssfr_aniso.wgsl) against the
// research bench's reference mapping (calc/aniso/aniso_lib.py final2, recommended parameters, ported to f64 in
// src/bench/flipSelftest/aniso.ts) on the bench's synthetic sets — a jittered block (bulk + top surface), one-layer
// sheets at spacing 1 / 1.5 / 2 s, a thread, a 3-particle splash, an isolated particle.
//
//   node scripts/fluid-gates/r0-aniso.mjs   (default server: the clean gate tree; FLUID_BASE to override)
//
// K50 per set, ‖M_gpu − M_ref‖_F ≤ 1e-3·‖M_ref‖_F (M = Σ a_k² v_k v_kᵀ, rotation-invariant) and the volume factor within
//     1e-3 relative — bound fixed before the first run (f32 sums over ~100 neighbours ≈ 1e-5 relative, through a mapping
//     of bounded slope); with the interior skip off and on (the sets have no fully interior particle: the same numbers).
// Recorded: the pass's GPU time per frame on a 164k / 82k settled-pool lattice (the page's 8 ppc), skip off / on.
// The render-side gates of the ellipsoids: r0-surface (B-aniso, C-aniso), r0-render (V3 with the ellipsoids).
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE R0-aniso (the anisotropic splat kernel vs the research reference)')
const report = { prov: await provenance() }
const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: [...windowArgs({ timing: true }), '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
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
  const run = (t, p = {}) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])
  for (const interiorMin of [0, 20]) {
    const r = await run('anisoKernels', { interiorMin })
    report[`k50_${interiorMin}`] = r
    for (const row of r.rows) {
      gate.check(row.mRel <= 1e-3 && row.volRel <= 1e-3,
        `K50 ${row.tag} (${row.particles} particles, interior skip ${interiorMin ? 'on' : 'off'}): ‖ΔM‖/‖M‖ ${row.mRel.toExponential(2)}, volume factor ${row.volRel.toExponential(2)} (≤ 1e-3); reference axes ${row.refAxesMean.join(' / ')} s`)
    }
  }
  const c = await run('anisoCost', {})
  report.cost = c
  console.log(`  [recorded] the aniso pass per frame: ${c.layers10.particles} particles ${(c.layers10.us_interiorMin0 / 1000).toFixed(2)} ms (skip on: ${(c.layers10.us_interiorMin20 / 1000).toFixed(2)} ms); ${c.layers5.particles} particles ${(c.layers5.us_interiorMin0 / 1000).toFixed(2)} ms (${(c.layers5.us_interiorMin20 / 1000).toFixed(2)} ms)`)
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'r0-aniso', pass, report, gate.results)
process.exit(pass ? 0 : 1)
