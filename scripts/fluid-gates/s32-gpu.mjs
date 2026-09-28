#!/usr/bin/env node
// Gate S3.2 on the GPU — the density-projection kernels against the f64 CPU reference, then the S3.2 physics gates
// on the GPU path (FINAL-PLAN §7 S3.2; A1c replaces the plan's cross-scale convergence — see s32-ref.mjs header).
//
//   node scripts/fluid-gates/s32-gpu.mjs          (default server: the clean gate tree; FLUID_BASE to override)
//   node scripts/fluid-gates/s32-gpu.mjs --quick  (kernel parity, D0, C4/WALL only — used by gpu-mutations.mjs)
//
// Tolerances (fixed before the first run):
//  K10 cellScatter      |f − ref| ≤ max(1e-5·max f, 33 quanta of 2^-24)          (fixed point, ≤ 64 adds per cell)
//  K11 densityRhs       |b − ref| ≤ 1e-5 and |f̃ − ref| ≤ 1e-5 (volume-fraction units)
//  K12 ψ solve          GPU JPCG (f32, 1e-6, cold) vs the reference (1e-9): |ψ̂ − ref| ≤ 1e-4·max|ψ̂|; converged
//  K13 faceDisplacement |δ − ref| ≤ 1e-5·max|δ| with AIR/ghost ψ̂ poisoned to 1e3
//  K14 positionCorrect  |x − ref| ≤ 1e-5·window; push-back counts equal
//  cases: 16³, 64³ ring (5,11,3), 24×16×12 ring (7,2,9)
//  D0  a 12-ppc blob expands, a 6-ppc blob's interior contracts, velocities unchanged
//  C4  φ-volume at rest after 3 s = N·V_p ±1 %      WALL  wall cells f̃ = 1 ±1 %, COM drift ≤ 0.1 dx
//  A1  Martin & Moyce n² = 2, a = 12 cells: RMS Z error ≤ 10 %, dZ/dT on [1.43, 3.33] ∈ [1.19, 1.74], |ΔH| ≤ 0.05
//  A1c grid self-convergence on one column (8/12/16 cells): RMS|Z16 − Z12| ≤ RMS|Z12 − Z8|
//  INV′ E_K + E_P − ΣΔE_P(δx) max rise ≤ 2 %, last-second trend ≤ 0 (A1 run)
//  G2  double dam break 30 s (64×64×8): |φ-volume / (N·V_p) − 1| ≤ 2 % at 30 s (target 0.5 %); the same run WITHOUT
//      the density projection is recorded (FINAL-PLAN G2-baseline: expected to drift — proves S3.2 is needed).
//      Reference = N·V_p, the volume the particles represent, NOT the t = 0 measurement: the jittered start packing
//      has noisy f, and min(f, 1) clips the over-full cells but not the under-full ones, so φ(0) reads 2.9 % LOW
//      (measured: φ(0)/(N·V_p) = 0.9714); a start-relative figure would count that bias as volume "gained".
//  and: 0 solver breakdowns, 0 uncaptured WebGPU errors, 0 console errors.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const QUICK = process.argv.includes('--quick')
const gate = makeGate(`GATE S3.2 (density projection on the GPU)${QUICK ? ' — QUICK subset' : ''}`)
const report = { prov: await provenance() }
const DX = 3.63 / 64
const TABLE2 = { T: [0, 0.41, 0.84, 1.19, 1.43, 1.63, 1.83, 1.98, 2.20, 2.32, 2.51, 2.65, 2.83, 2.98, 3.11, 3.33], Z: [1.00, 1.11, 1.22, 1.44, 1.67, 1.89, 2.11, 2.33, 2.56, 2.78, 3.00, 3.22, 3.44, 3.67, 3.89, 4.11] }
const TABLE6 = { tau: [0, 0.56, 0.77, 0.93, 1.08, 1.28, 1.46, 1.66, 1.84, 2.00, 2.21, 2.45, 2.70, 3.06, 3.44, 4.20, 5.25], H: [1.00, 0.94, 0.89, 0.83, 0.78, 0.72, 0.67, 0.61, 0.56, 0.50, 0.44, 0.39, 0.33, 0.28, 0.22, 0.17, 0.11] }
const interp = (xs, ys, x) => { if (x <= xs[0]) return ys[0]; for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys.at(-1) }
const trend = (ts, ys) => { const idx = ts.map((t, i) => i).filter(i => ts[i] >= ts.at(-1) - 1); const tm = idx.reduce((q, i) => q + ts[i], 0) / idx.length, ym = idx.reduce((q, i) => q + ys[i], 0) / idx.length; let a = 0, b = 0; for (const i of idx) { a += (ts[i] - tm) * (ys[i] - ym); b += (ts[i] - tm) ** 2 } return a / b }
function mmMetrics(r) {
  const T = r.ts.map(t => Math.SQRT2 * t / r.tUnit), tau = r.ts.map(t => t / r.tUnit)
  let se = 0; for (let i = 1; i < TABLE2.T.length; i++) se += ((interp(T, r.Z, TABLE2.T[i]) - TABLE2.Z[i]) / TABLE2.Z[i]) ** 2
  const idx = T.map((x, i) => [x, i]).filter(([x]) => x >= 1.43 && x <= 3.33).map(([, i]) => i)
  const tm = idx.reduce((q, i) => q + T[i], 0) / idx.length, zm = idx.reduce((q, i) => q + r.Z[i], 0) / idx.length
  let sxy = 0, sxx = 0; for (const i of idx) { sxy += (T[i] - tm) * (r.Z[i] - zm); sxx += (T[i] - tm) ** 2 }
  let dH = 0; for (let i = 1; i < TABLE6.tau.length; i++) dH = Math.max(dH, Math.abs(interp(tau, r.H, TABLE6.tau[i]) - TABLE6.H[i]))
  return { rmsZ: Math.sqrt(se / (TABLE2.T.length - 1)), slope: sxy / sxx, dH, zSim: TABLE2.T.slice(1).map(t => interp(T, r.Z, t)),
    invMax: Math.max(...r.inv.map(e => (e - r.E0) / r.E0)), invTrend: trend(r.ts, r.inv) }
}

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
  const SOLVER = (process.argv.find(a => a.startsWith('--solver=')) ?? '--solver=jpcg').slice(9)
  report.solver = (await run('configure', { solver: SOLVER })).solver
  console.log(`  pressure/ψ solver: ${report.solver}`)

  report.kernels = {}
  for (const c of [{ label: '16³', n: [16, 16, 16] }, { label: '64³ ring(5,11,3)', n: [64, 64, 64], ring: [5, 11, 3] }, { label: '24×16×12 ring(7,2,9)', n: [24, 16, 12], ring: [7, 2, 9] }]) {
    const r = await run('densKernels', c)
    report.kernels[c.label] = r
    gate.check(r.k10.fDiff <= Math.max(1e-5 * r.k10.fRef, 33 / 2 ** 24) && r.gpuErrors.length === 0, `K10 cellScatter ${c.label} (${r.particles} particles): |Δf| ${r.k10.fDiff.toExponential(2)} (≤ ${Math.max(1e-5 * r.k10.fRef, 33 / 2 ** 24).toExponential(2)}), max f ${r.k10.fRef.toFixed(3)}`)
    gate.check(r.k11.bDiff <= 1e-5 && r.k11.fcDiff <= 1e-5, `K11 densityRhs ${c.label}: |Δb| ${r.k11.bDiff.toExponential(2)}, |Δf̃| ${r.k11.fcDiff.toExponential(2)} (≤ 1e-5); max |b| ${r.k11.bRef.toFixed(3)}`)
    gate.check(r.k12.psiDiff <= 1e-4 * r.k12.psiRef && r.k12.converged && !r.k12.breakdown && r.k12.capHits === 0, `K12 ψ solve ${c.label}: |Δψ̂| ${r.k12.psiDiff.toExponential(2)} (≤ ${(1e-4 * r.k12.psiRef).toExponential(2)}); GPU ${r.k12.iterations} it, ref ${r.k12.refIterations} it`)
    gate.check(r.k13.dDiff <= 1e-5 * r.k13.dRef, `K13 faceDisplacement ${c.label} (air ψ̂ poisoned): |Δδ| ${r.k13.dDiff.toExponential(2)} m (≤ ${(1e-5 * r.k13.dRef).toExponential(2)})`)
    gate.check(r.k14.xDiff <= 1e-5 * r.k14.extent && r.k14.densityClamps.gpu === r.k14.densityClamps.cpu, `K14 positionCorrect ${c.label}: |Δx| ${r.k14.xDiff.toExponential(2)} m (≤ ${(1e-5 * r.k14.extent).toExponential(2)}); max move ${(r.k14.maxMove / DX).toFixed(2)} cells; push-backs GPU ${r.k14.densityClamps.gpu} / ref ${r.k14.densityClamps.cpu}`)
  }

  const d0 = await run('direction')
  report.d0 = d0
  gate.check(d0.hi.all > 0 && d0.lo.inner < 0 && d0.hi.dv === 0 && d0.lo.dv === 0, `D0 on the GPU: 12-ppc blob r² ${(100 * d0.hi.all).toFixed(2)} % (grows), 6-ppc interior r² ${(100 * d0.lo.inner).toFixed(2)} % (shrinks), velocity change ${Math.max(d0.hi.dv, d0.lo.dv)}`)

  const rv = await run('restVolume')
  report.rest = rv
  gate.check(Math.abs(rv.vPhi / rv.vNp - 1) <= 0.01, `C4 on the GPU after 3 s: φ-volume ${(100 * (rv.vPhi / rv.vNp - 1)).toFixed(3)} % of N·V_p (±1 %)`)
  gate.check(rv.worst <= 0.01 && rv.drift <= 0.1, `WALL on the GPU: max |f̃ − 1| ${rv.worst.toExponential(2)} over ${rv.wallCells} wall cells (±1 %); COM drift ${rv.drift.toFixed(4)} dx; ψ cap hits ${rv.psiCapHits}/${rv.psiSolves}, p cap hits ${rv.capHits}`)

  if (!QUICK) {
  const a12 = await run('martinMoyce', { aCells: 12 }), m12 = mmMetrics(a12)
  report.a1 = { m12, densityClamps: a12.densityClamps, wallClamps: a12.wallClamps, capHits: a12.capHits, psiCapHits: a12.psiCapHits }
  gate.check(m12.rmsZ <= 0.10, `A1 on the GPU, a = 12 cells (${a12.particles} particles): RMS Z error vs Table 2 ${(100 * m12.rmsZ).toFixed(2)} % (≤ 10 %)`)
  gate.check(m12.slope >= 1.19 && m12.slope <= 1.74, `A1 dZ/dT on [1.43, 3.33] = ${m12.slope.toFixed(3)} (1.19–1.74)`)
  gate.check(m12.dH <= 0.05, `A1 residual height max |ΔH| ${m12.dH.toFixed(3)} (≤ 0.05)`)
  gate.check(m12.invMax <= 0.02 && m12.invTrend <= 0 && a12.breakdowns === 0, `INV′ on the GPU: max rise ${(100 * m12.invMax).toFixed(3)} % (≤ 2 %), last-second trend ${m12.invTrend.toExponential(2)} J/s (≤ 0); solver breakdowns ${a12.breakdowns}`)
  const aP = 8 * DX
  const c8 = mmMetrics(await run('martinMoyce', { aCells: 8, aPhys: aP })), c12 = mmMetrics(await run('martinMoyce', { aCells: 12, aPhys: aP })), c16 = mmMetrics(await run('martinMoyce', { aCells: 16, aPhys: aP }))
  const rmsD = (u, v) => Math.sqrt(u.reduce((s, x, i) => s + (x - v[i]) ** 2, 0) / u.length)
  const e1 = rmsD(c12.zSim, c8.zSim), e2 = rmsD(c16.zSim, c12.zSim)
  report.a1c = { e1, e2, rmsZ: [c8.rmsZ, c12.rmsZ, c16.rmsZ] }
  gate.check(e2 <= e1, `A1c on the GPU, one column at 8/12/16 cells: RMS|Z12 − Z8| ${e1.toFixed(4)}, RMS|Z16 − Z12| ${e2.toFixed(4)} (must shrink); Z error vs experiment ${[c8, c12, c16].map(c => (100 * c.rmsZ).toFixed(2)).join(' / ')} %`)

  const g2 = await run('doubleDamBreak', { density: true }), base = await run('doubleDamBreak', { density: false })
  report.g2 = { with: { ...g2, series: undefined }, without: { ...base, series: undefined }, seriesWith: g2.series, seriesWithout: base.series }
  const range = s => `${(100 * Math.min(...s)).toFixed(2)} … ${(100 * Math.max(...s)).toFixed(2)} %`
  gate.check(Math.abs(g2.endOverNVp - 1) <= 0.02 && g2.breakdowns === 0, `G2 on the GPU, double dam break 30 s (${g2.particles} particles): φ-volume / N·V_p = ${g2.endOverNVp.toFixed(4)} (${(100 * (g2.endOverNVp - 1)).toFixed(3)} %, ≤ 2 %, target 0.5 %); vs the biased t = 0 reading (${g2.v0OverNVp.toFixed(4)}·N·V_p) ${(100 * g2.end).toFixed(2)} %; p cap hits ${g2.capHits}/${g2.solves}, ψ cap hits ${g2.psiCapHits}/${g2.psiSolves}`)
  console.log(`  [recorded] G2-baseline WITHOUT density projection: φ-volume / N·V_p = ${base.endOverNVp.toFixed(4)} after 30 s (${(100 * (base.endOverNVp - 1)).toFixed(2)} %), range vs t = 0 ${range(base.series)} (Kugelstadt: APIC loses ~38 % in 3D)`)
  }

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's32-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
