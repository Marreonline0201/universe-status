#!/usr/bin/env node
// Gate S3.3 on the GPU — MGPCG replaces JPCG (FINAL-PLAN §7 S3.3). Kernel fusion is not done yet (the plan's
// "fused vs unfused" check applies when it is).
//
//   node scripts/fluid-gates/s33-gpu.mjs          (then: s31b-gpu.mjs --solver=mgpcg and s32-gpu.mjs --solver=mgpcg)
//
// Tolerances (fixed before the first run):
//  M1 equivalence, dam-break slab 128×24×4, same particles: after one substep max |p_MG − p_JPCG| over liquid cells
//     ≤ the pressure implied by 10·ε_div, 10·ε_div·ρ·dx²/Δt (ε_div = 1e-2 1/s → 38.5 Pa); after 2 s the centres of mass
//     differ by ≤ 0.25·dx.
//  M2 caps, the 64³ tank (3.63 m) dam break (16×32×64-cell column), 2 s, MGPCG at the Gate 0 dev caps (p 18, ψ 10):
//     ≤ 1 % of solves hit their cap (FINAL-PLAN G5), 0 breakdowns.
//  and: 0 uncaptured WebGPU errors, 0 console errors.
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.3 (MGPCG replaces JPCG)')
const report = { prov: await provenance() }
const RHO = 998.2072, DX = 3.63 / 64

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
  const run = (t, p = {}) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])

  const eq = await run('equivalence')
  report.equivalence = eq
  const pTol = 10 * 1e-2 * RHO * DX * DX / (1 / 120)
  gate.check(eq.dp <= pTol && eq.gpuErrors.length === 0, `M1 one substep, ${eq.liquid} liquid cells: max |p_MG − p_JPCG| ${eq.dp.toFixed(2)} Pa (≤ ${pTol.toFixed(1)} Pa = 10·ε_div·ρ·dx²/Δt); max p ${eq.pMax.toFixed(0)} Pa`)
  gate.check(eq.dCom <= 0.25 * eq.dx && eq.mgpcg.breakdowns === 0 && eq.jpcg.breakdowns === 0, `M1 after 2 s: |COM_MG − COM_JPCG| ${(eq.dCom * 1000).toFixed(3)} mm (≤ ${(250 * eq.dx).toFixed(1)} mm = 0.25·dx); max iterations p/ψ MGPCG ${eq.mgpcg.maxIt}/${eq.mgpcg.psiMaxIt} vs JPCG ${eq.jpcg.maxIt}/${eq.jpcg.psiMaxIt}`)

  const t = await run('tankCaps', { cap: 18, psiCap: 10 })
  report.tankCaps = t
  gate.check(t.capHits <= 0.01 * t.solves && t.psiCapHits <= 0.01 * t.psiSolves && t.breakdowns === 0,
    `M2 64³ tank dam break, ${t.particles} particles, ${t.steps} substeps at caps p 18 / ψ 10: p cap hits ${t.capHits}/${t.solves}, ψ cap hits ${t.psiCapHits}/${t.psiSolves} (≤ 1 %); max iterations p ${t.maxIt}, ψ ${t.psiMaxIt}; breakdowns ${t.breakdowns}; ${t.msPerStep.toFixed(1)} ms per substep incl. readback-free submit (busy machine, not a budget figure)`)

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's33-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
