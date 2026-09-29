#!/usr/bin/env node
// Gate S3.5 on the GPU — variable-density kernels against the f64 CPU reference, then the S3.5 physics scenes on the
// GPU path with the same fixtures and measurements as s35-ref.mjs (src/sim-ref/twoLayer.ts).
//
//   node scripts/fluid-gates/s35-gpu.mjs [--solver=mgpcg]   (default server: the clean gate tree; FLUID_BASE to override)
//   node scripts/fluid-gates/s35-gpu.mjs --quick            (kernel parity only — used by gpu-mutations.mjs)
//
// Tolerances (fixed before the first run):
//  K18 faceScatter Σw   every face slot: |Σw − ref| ≤ 64·2^-25 + 1e-6·ref (≤ 64 adds rounded at 2^-24)
//  K19 ghostCoef a_f    every window cell's −x/−y/−z face: |a_f − Δt/(ρ_f^ref dx²)| ≤ a_f·(64·2^-25/max(Σw, wMin) + 2e-6)
//                       (Σw error → ρ_f error); faces within that error of the wMin threshold are counted, not compared;
//                       the ghost extra diagonal (GPU φ, reference a_f) within the same relative bound + 1e-5;
//                       non-vacuity: the block holds both liquids (ρ_f range spans ≥ 10×)
//  K20 project          every face with a LIQUID side vs u* − a_f·dx·(p₊ − p₋) in f64 on the GPU's own a_f and θ, AIR
//                       pressure poisoned: ≤ 1e-5·max(|u|, a_f·dx·|Δp|)
//  cases: 16³, 64³ ring (5,11,3), 24×16×12 ring (7,2,9)
//  D, F1, F2, F3, F4, LX — exactly as s35-ref.mjs (see its header); p/ψ cap hits and breakdowns reported.
//  G5 on the production settings (FINAL-PLAN S3.1b G5: ≤ 1 % of solves hit the cap): the FLUID TEST buoyancy scene
//      (3-cell water pool + olive-oil block + mercury block, 127k particles, ghost surface, ε_div 1e-2, MGPCG cap 18),
//      4 s at Δt 1/120: pressure cap hits ≤ 1 % of solves, 0 breakdowns; the iteration maximum is reported.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { fitOmega } from './lib/s34metrics.mjs'
import { loadTsModules } from './lib/loadTs.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { two } = await loadTsModules({ two: 'src/sim-ref/twoLayer.ts' })
const QUICK = process.argv.includes('--quick')
const gate = makeGate(`GATE S3.5 (variable density on the GPU)${QUICK ? ' — QUICK subset' : ''}`)
const report = { prov: await provenance() }
const G = 9.80665

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation|WGSL/i.test(m.text()))) errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
  await page.goto(`${BASE}/flip-selftest.html`, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__flipTest && (window.__flipTest.ready || window.__flipTest.error), null, { timeout: 90_000 })
  const init = await page.evaluate(() => ({ err: window.__flipTest.error, info: window.__flipTest.info() }))
  if (init.err) throw new Error(`self-test page init failed: ${init.err}`)
  if (init.info.vendor !== 'nvidia') throw new Error(`adapter is ${init.info.vendor}, not the NVIDIA dGPU`)
  report.adapter = init.info
  const run = (t, p = {}) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])
  const SOLVER = (process.argv.find(a => a.startsWith('--solver=')) ?? '--solver=mgpcg').slice(9)
  report.solver = (await run('configure', { solver: SOLVER })).solver
  console.log(`  pressure/ψ solver: ${report.solver}`)

  report.kernels = {}
  for (const c of [{ label: '16³', n: [16, 16, 16] }, { label: '64³ ring(5,11,3)', n: [64, 64, 64], ring: [5, 11, 3] }, { label: '24×16×12 ring(7,2,9)', n: [24, 16, 12], ring: [7, 2, 9] }]) {
    const r = await run('varKernels', c)
    report.kernels[c.label] = r
    gate.check(r.k18.wRatio <= 1, `K18 faceScatter Σw ${c.label} (${r.particles} particles): max |ΔΣw|/bound ${r.k18.wRatio.toFixed(3)} (≤ 1); max Σw ${r.k18.wMax.toFixed(2)}`)
    gate.check(r.k19.aRatio <= 1 && r.k19.extraRatio <= 1 && r.k19.faces > 0 && r.k19.rhoMax / r.k19.rhoMin >= 10, `K19 ghostCoef a_f ${c.label}: |Δa|/bound ${r.k19.aRatio.toFixed(3)} over ${r.k19.faces} faces (${r.k19.nearThreshold} at the Σw threshold); ghost extra |Δ|/bound ${r.k19.extraRatio.toFixed(3)} (${r.k19.extraFaces} liquid–air faces); ρ_f ${r.k19.rhoMin.toFixed(1)} … ${r.k19.rhoMax.toFixed(1)} kg/m³`)
    gate.check(r.k20.uRatio <= 1 && r.k20.projFaces > 0, `K20 project, per-face a_f ${c.label} (air p poisoned): |Δu|/bound ${r.k20.uRatio.toFixed(3)} over ${r.k20.projFaces} faces (≤ 1)`)
  }

  if (!QUICK) {
    const d = await run('densityCancels')
    report.d = d
    gate.check(d.worst <= 0.02 && d.breakdowns === 0, `D on the GPU: A1 column as water vs mercury, max particle position difference ${d.worst.toExponential(2)}·a over ${d.steps} steps (≤ 0.02·a); p caps ${d.capHits.join('/')}, ψ caps ${d.psiCapHits.join('/')}`)

    const f2 = await run('twoLayerHydrostatic')
    const slope = (j0, j1) => { let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0; for (let j = j0; j <= j1; j++) { const y = (j + 0.5) * f2.dx, v = f2.rows[j]; sx += y; sy += v; sxx += y * y; sxy += y * v; n++ } return (n * sxy - sx * sy) / (n * sxx - sx * sx) }
    const gL = slope(2, f2.h1 - 3), gU = slope(f2.h1 + 2, f2.h1 + f2.h2 - 3), eL = gL / (-f2.rhoLower * G) - 1, eU = gU / (-f2.rhoUpper * G) - 1
    report.f2 = { gL, gU, eL, eU, capHits: f2.capHits, psiCapHits: f2.psiCapHits }
    gate.check(Math.abs(eL) <= 0.005 && Math.abs(eU) <= 0.005 && f2.breakdowns === 0, `F2 on the GPU: dp/dy mercury ${gL.toFixed(0)} Pa/m (${(100 * eL).toFixed(3)} %), water ${gU.toFixed(1)} Pa/m (${(100 * eU).toFixed(3)} %), ±0.5 %; p caps ${f2.capHits}, ψ caps ${f2.psiCapHits}`)

    const w1 = await run('interfacialWave', { scale: 1 }), w2 = await run('interfacialWave', { scale: 2 })
    const e1 = Math.abs(fitOmega(w1.ts, w1.es, w1.omega) / w1.omega - 1), e2 = Math.abs(fitOmega(w2.ts, w2.es, w2.omega) / w2.omega - 1)
    report.f3 = { e1, e2, omega: w1.omega, capHits: [w1.capHits, w2.capHits] }
    gate.check(e1 <= 0.05 && e1 < e2 && w1.breakdowns + w2.breakdowns === 0, `F3 on the GPU: interfacial ω error ${(100 * e1).toFixed(2)} % vs Lamb ${w1.omega.toFixed(4)} rad/s (≤ 5 %, ${w1.particles} particles); at 2·dx ${(100 * e2).toFixed(2)} % (must be larger); p caps ${w1.capHits}/${w2.capHits}`)

    const rt = await run('rayleighTaylor')
    const fit = two.fitCosh(rt.ts, rt.as, 0.1 * rt.lam), eR = fit.sigma / rt.sigma - 1
    report.f4 = { sigma: fit.sigma, ref: rt.sigma, err: eR, capHits: rt.capHits }
    gate.check(Math.abs(eR) <= 0.15 && rt.breakdowns === 0, `F4 on the GPU: σ ${fit.sigma.toFixed(3)} s⁻¹ over ${fit.samples} samples vs Lamb ${rt.sigma.toFixed(4)}: ${(100 * eR).toFixed(1)} % (±15 %); p caps ${rt.capHits}, ψ caps ${rt.psiCapHits}`)

    const lx = await run('lockExchange')
    const idx = lx.ts.map((t, i) => i).filter(i => lx.xs[i] >= 0.3 && lx.xs[i] <= 1.4)
    const tm = idx.reduce((q, i) => q + lx.ts[i], 0) / idx.length, xm = idx.reduce((q, i) => q + lx.xs[i], 0) / idx.length
    let sxy = 0, sxx = 0
    for (const i of idx) { sxy += (lx.ts[i] - tm) * (lx.xs[i] - xm); sxx += (lx.ts[i] - tm) ** 2 }
    const U = sxy / sxx, gP = G * (lx.rhoDense - lx.rhoLight) / lx.rhoDense
    report.lx = { U, FH: U / Math.sqrt(gP * lx.H), capHits: lx.capHits }
    gate.check(U >= 0.23 && U <= 0.30 && lx.breakdowns === 0, `LX on the GPU: dense front ${U.toFixed(3)} m/s over ${idx.length} samples (U ∈ [0.23, 0.30]; F_H ${(U / Math.sqrt(gP * lx.H)).toFixed(3)}, Shin et al. 0.42–0.5); p caps ${lx.capHits}, ψ caps ${lx.psiCapHits}`)

    const g5 = await run('mixedCaps', { cap: 18, variable: true, seconds: 4 })
    report.g5 = g5
    gate.check(g5.capHits <= 0.01 * g5.solves && g5.breakdowns === 0, `G5 on the production settings, mixed-density scene (${g5.particles} particles, cap 18): pressure cap hits ${g5.capHits}/${g5.solves} (≤ 1 %), max iterations ${g5.maxIt}, ψ cap hits ${g5.psiCapHits}, ${g5.msPerStep.toFixed(2)} ms per substep`)

    for (const [pair, seconds] of [['hg-water', 8], ['water-oil', 15]]) {
      const f1 = await run('overturn', { pair, seconds })
      report[`f1-${pair}`] = f1
      const ok = Math.abs(f1.comHeavy - f1.h1 / 2) <= 0.5 && Math.abs(f1.comLight - (f1.h1 + f1.h2 / 2)) <= 0.5 && f1.wrongFraction <= 0.01
      gate.check(ok && f1.breakdowns === 0, `F1 on the GPU, ${pair} released inverted, ${seconds} s: COM heavy ${f1.comHeavy.toFixed(2)} (static ${f1.h1 / 2}), light ${f1.comLight.toFixed(2)} (static ${f1.h1 + f1.h2 / 2}), ±0.5; wrong side ${(100 * f1.wrongFraction).toFixed(2)} % (≤ 1 %); fallbacks ${f1.fallbacks.join('/')}; p caps ${f1.capHits}`)
    }
  }

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors${info.gpuErrors.length ? ` — ${String(info.gpuErrors[0]).slice(0, 200)}` : ''}`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's35-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
