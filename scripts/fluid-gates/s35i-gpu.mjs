#!/usr/bin/env node
// Gate S3.5-i on the GPU — immiscible liquids by sub-grid drop slip (Manninen, Taivassalo & Kallio 1996 drift flux;
// ImmiscibleSolver + immiscible.wgsl against the f64 reference flipRef.driftFlux).
//
//   node scripts/fluid-gates/s35i-gpu.mjs [--quick]   (default server: the clean gate tree; FLUID_BASE to override;
//   --quick: the kernel parity cases only — what gpu-mutations.mjs --gate=s35i runs)
//
// Kernel parity on the reference's exact inputs (src/bench/flipSelftest/immiscible.ts; every bound derived there from
// f32 rounding): K30 the cell pass — α per material, ρ_m, ε = 2ν_eff·S:S (each ≤ 1 × its bound) and the majority
// material (identical; near ties within the α bounds excused and counted); K31 the slip and drop diameter of every
// particle (≤ 1 × its bound; the dispersed set identical, drops within their bound of the resolved edge d = dx or of the
// drag law's Re = 1000 seam excused and counted; the bound's recomputation must reproduce the reference's slip to
// 1e-12); K32 the drift (≤ 1 × its bound); K33 g2pMac's advection adds Δt·u_V (u = 0 on the grid; ≤ 2u·(|x| + Δt|u_V|)).
// Cases: olive-oil drops of 1 mm with a slip history (h ≈ 0.2, the exp branch),
// mercury drops of 1 cm, half from rest (h ≈ 1e-4: the series branch of 1 − e^(−h), where 1 − exp(−h) in f32 errs
// 1.5e-3), half with a slip of up to 1 m/s (Newton's drag branch must occur),
// Hinze sizing with a drop history (both too-large and sub-grid drops must occur), and four liquids with ids 0/3/7/12
// (an oil-majority band, mercury, ethanol — miscible with water, never slips).
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.5-i (immiscible drift flux on the GPU)')
const report = { prov: await provenance() }
const QUICK = process.argv.includes('--quick')

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
  report.solver = (await run('configure', { solver: 'mgpcg' })).solver

  report.kernels = {}
  const f = x => (Number.isFinite(x) ? x.toFixed(3) : String(x))
  for (const c of [{ kind: 'oil', label: 'olive oil 1 mm, slip history' }, { kind: 'mercury', label: 'mercury 1 cm from rest' },
    { kind: 'hinze', label: 'olive oil, Hinze sizing, drop history' }, { kind: 'mix4', label: 'four liquids, ids 0/3/7/12, Hinze' }]) {
    const r = await run('immKernels', { kind: c.kind })
    report.kernels[c.kind] = r
    const a = r.k30, b = r.k31, d = r.k32
    gate.check(a.cellsSeen > 0 && a.alphaRatio <= 1 && a.rhoRatio <= 1 && a.epsRatio <= 1 && a.majorityMismatch === 0 && (c.kind === 'oil' || c.kind === 'mercury' || a.epsCells > 0),
      `K30 cells, ${c.label} (${r.particles} particles): α |Δα|/bound ${f(a.alphaRatio)}, ρ_m ${f(a.rhoRatio)}, ε ${f(a.epsRatio)} over ${a.epsCells} cells, majority mismatches ${a.majorityMismatch} of ${a.cellsSeen} cells (${a.majorityExcused} near ties excused)`)
    const branches = c.kind === 'mercury' ? b.seriesBranch > 0 && b.newton > 0 : c.kind === 'hinze' ? b.cpuTooLarge > 0 : true
    gate.check(b.dispersed > 0 && b.slipRatio <= 1 && b.dropRatio <= 1 && b.dispMismatch === 0 && b.recompute === 0 && branches
      && Math.abs(b.gpuDispersed - b.cpuDispersed) <= b.dispExcused,
      `K31 slip, ${c.label}: ${b.dispersed} dispersed compared (GPU ${b.gpuDispersed}, reference ${b.cpuDispersed}; ${b.dispExcused} at the d = dx edge or the Re = 1000 seam excused), |Δs|/bound ${f(b.slipRatio)}, |Δd|/bound ${f(b.dropRatio)}, dispersed-set mismatches ${b.dispMismatch}, too large GPU ${b.gpuTooLarge} / reference ${b.cpuTooLarge}; branches series ${b.seriesBranch} / exp ${b.expBranch}, Newton drag ${b.newton}; bound recomputation off in ${b.recompute}; largest slip GPU ${b.maxSlip.gpu.toExponential(4)} / reference ${b.maxSlip.cpu.toExponential(4)} m/s, mean drop ${(1e3 * b.meanDrop.gpu).toFixed(4)} / ${(1e3 * b.meanDrop.cpu).toFixed(4)} mm`)
    gate.check(d.driftChecked > 0 && d.driftRatio <= 1,
      `K32 drift, ${c.label}: |Δu_V|/bound ${f(d.driftRatio)} over ${d.driftChecked} particles (${d.driftSkipped} in cells with an excused particle skipped; largest |u_V| ${d.driftMax.toExponential(3)} m/s)`)
    const e = r.k33
    gate.check(e.advChecked > 0 && e.advMoved > 0 && e.advRatio <= 1,
      `K33 advection adds the drift, ${c.label} (u = 0 on the grid): |x′ − (x + Δt·u_V)|/bound ${f(e.advRatio)} over ${e.advChecked} particles (${e.advMoved} moved by the drift; ${e.advClamped} held by the wall clamp excluded)`)
  }

  if (QUICK) console.log('--quick: physics scenes skipped')
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's35i-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
