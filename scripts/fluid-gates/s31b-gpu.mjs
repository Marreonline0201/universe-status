#!/usr/bin/env node
// Gate S3.1b on the GPU — the projection kernels against the f64 CPU reference, then the S3.1b physics gates on the
// GPU path (FINAL-PLAN §7 S3.1b). flip-selftest.html in headed Chrome on the NVIDIA dGPU, default device limits.
//
//   node scripts/fluid-gates/s31b-gpu.mjs          (default server: the clean gate tree; FLUID_BASE to override)
//
// Tolerances (fixed before the first run):
//  K6 labels            identical to the reference (LIQUID / AIR / SOLID) on every cell
//  K7 divergence        |b − ref| ≤ 1e-5·max|ref|; no unset faces
//  K8 pressure solve    GPU JPCG (f32, ‖r‖∞ ≤ 1e-6 1/s, cold) vs the reference (f64, 1e-9): |p − ref| ≤ 1e-4·max p;
//                       converged, no breakdown, no cap hit
//  K9 projection        |u − ref| ≤ 1e-5·max|u|; set/unset identical
//  cases: 16³, 64³ ring (5,11,3), 24×16×12 ring (7,2,9)
//  G1a  p = ρ·g·dx·(24 − j) to ≤ 1e-3 (16×64×16, solved to 1e-5 1/s)
//  G1b  after 3 s: dp/dy = −ρg ±0.5 %; floor offset ≤ 1.5·ρ·g·dx
//  C5   after 6 s: RMS speed ≤ 1 % √(gH)
//  G5   ≤ 1 % of solves hit the cap (ε_div = 1e-2 1/s, JPCG cap 400); 0 breakdowns; the TRUE residual (max |∇·u| after
//       projection, recomputed on every 60th frame) ≤ 10·ε_div on every sample (f32 CG's recursive residual drifts)
//  B1   dam break front speed on t√(g/h0) ∈ [1,3] in [1.0, 2.1]·√(gh0); far wall never reached in the window
//  E1   E_K + E_P never above E(0) by more than 2 %; last-second trend ≤ 0
//  and: 0 uncaptured WebGPU errors, 0 console errors.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.1b (pressure projection on the GPU)')
const report = { prov: await provenance() }
const G = 9.80665, RHO = 998.2072, DX = 3.63 / 64

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
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

  report.kernels = {}
  for (const c of [{ label: '16³', n: [16, 16, 16] }, { label: '64³ ring(5,11,3)', n: [64, 64, 64], ring: [5, 11, 3] }, { label: '24×16×12 ring(7,2,9)', n: [24, 16, 12], ring: [7, 2, 9] }]) {
    const r = await run('projKernels', c)
    report.kernels[c.label] = r
    gate.check(r.k6.labelMismatch === 0 && r.gpuErrors.length === 0, `K6 labels ${c.label}: ${r.k6.labelMismatch} mismatches over ${r.n.reduce((a, b) => a * b, 1)} cells (${r.k6.liquidCells} liquid)`)
    gate.check(r.k7.rhsDiff <= 1e-5 * r.k7.rhsRef && r.k7.unsetDivergenceFaces === 0 && r.k7.refUnset === 0, `K7 divergence ${c.label}: |Δb| ${r.k7.rhsDiff.toExponential(2)} 1/s (≤ ${(1e-5 * r.k7.rhsRef).toExponential(2)}); unset faces GPU ${r.k7.unsetDivergenceFaces} / ref ${r.k7.refUnset}`)
    gate.check(r.k8.pDiff <= 1e-4 * r.k8.pRef && r.k8.converged && !r.k8.breakdown && r.k8.capHits === 0,
      `K8 pressure ${c.label}: |Δp| ${r.k8.pDiff.toExponential(2)} Pa (≤ ${(1e-4 * r.k8.pRef).toExponential(2)}); GPU ${r.k8.gpuIterations} it, ‖r‖∞ ${r.k8.gpuRInf.toExponential(2)}; ref ${r.k8.refIterations} it, ${r.k8.refResidual.toExponential(2)}`)
    gate.check(r.k9.uDiff <= 1e-5 * r.k9.uRef && r.k9.validMismatch === 0, `K9 project ${c.label}: |Δu| ${r.k9.uDiff.toExponential(2)} m/s (≤ ${(1e-5 * r.k9.uRef).toExponential(2)}); set/unset mismatches ${r.k9.validMismatch}; ref max |∇·u| after ${r.k9.refDivergenceAfter.toExponential(2)} 1/s`)
  }

  const a = await run('g1a')
  report.g1a = a
  gate.check(a.worst <= 1e-3 && a.converged && a.unsetDivergenceFaces === 0, `G1a on the GPU: max |p − ρg·dx·(24−j)|/p ${a.worst.toExponential(2)} (≤ 1e-3); ${a.iterations} JPCG it, ‖r‖∞ ${a.rInf.toExponential(2)} 1/s; max |∇·u| after projection ${a.divAfter.toExponential(2)} 1/s`)

  const s = await run('settle', { seconds: 6, sampleAt: 3 })
  report.settle = s
  gate.check(Math.abs(s.g1b.relGrad) <= 0.005 && Math.abs(s.g1b.offset) <= 1.5 * RHO * G * DX,
    `G1b on the GPU after 3 s: dp/dy ${s.g1b.slope.toFixed(1)} Pa/m (${(100 * s.g1b.relGrad).toFixed(3)} %, ±0.5 %); floor offset ${s.g1b.offset.toFixed(0)} Pa (≤ ${(1.5 * RHO * G * DX).toFixed(0)})`)
  gate.check(s.rms <= 0.01 * Math.sqrt(G * s.H), `C5 on the GPU after 6 s: RMS speed ${s.rms.toExponential(2)} m/s (≤ ${(0.01 * Math.sqrt(G * s.H)).toFixed(4)}); wall clamps ${s.wallClamps}`)
  gate.check(s.capHits <= 0.01 * s.solves && s.breakdowns === 0 && s.unsetDivergenceFaces === 0 && s.trueDivMax <= 0.1,
    `G5 on the GPU: ${s.solves} solves, ${s.capHits} cap hits (≤ 1 %), ${s.breakdowns} breakdowns, max ${s.maxIterations} iterations (cap 400); true residual max |∇·u| ${s.trueDivMax.toExponential(2)} 1/s over ${s.trueDivSamples} sampled frames (≤ 0.1 = 10·ε_div)`)

  const d = await run('damBreak')
  report.damBreak = { ...d, ts: undefined, fronts: undefined, es: undefined }
  const U = Math.sqrt(G * d.h0), win = d.ts.map((t, i) => [t / d.T0, i]).filter(([tau]) => tau >= 1 && tau <= 3).map(([, i]) => i)
  const tm = win.reduce((q, i) => q + d.ts[i], 0) / win.length, fm = win.reduce((q, i) => q + d.fronts[i], 0) / win.length
  let sxy = 0, sxx = 0
  for (const i of win) { sxy += (d.ts[i] - tm) * (d.fronts[i] - fm); sxx += (d.ts[i] - tm) ** 2 }
  const speed = sxy / sxx, maxFront = Math.max(...win.map(i => d.fronts[i]))
  gate.check(speed >= U && speed <= 2.1 * U && maxFront < d.extent - 2 * DX, `B1 on the GPU: front speed ${speed.toFixed(3)} m/s = ${(speed / U).toFixed(3)}·√(gh0) (1.0–2.1; experiments 1.14–1.74); front at window end ${maxFront.toFixed(2)} of ${d.extent.toFixed(2)} m; push-backs in window ${d.clampsInWindow}`)
  const Emax = Math.max(d.E0, ...d.es)
  const tail = d.ts.map((t, i) => i).filter(i => d.ts[i] >= d.ts.at(-1) - 1)
  const tt = tail.reduce((q, i) => q + d.ts[i], 0) / tail.length, ee = tail.reduce((q, i) => q + d.es[i], 0) / tail.length
  let s2 = 0, s1 = 0
  for (const i of tail) { s2 += (d.ts[i] - tt) * (d.es[i] - ee); s1 += (d.ts[i] - tt) ** 2 }
  gate.check((Emax - d.E0) / d.E0 <= 0.02 && s2 / s1 <= 0 && d.breakdowns === 0, `E1 on the GPU: max rise over E(0) ${(100 * (Emax - d.E0) / d.E0).toFixed(3)} % (≤ 2 %), last-second trend ${(s2 / s1).toExponential(2)} J/s (≤ 0); E(end)/E(0) ${(d.es.at(-1) / d.E0).toFixed(4)}; solves ${d.solves}, cap hits ${d.capHits}`)

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's31b-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
