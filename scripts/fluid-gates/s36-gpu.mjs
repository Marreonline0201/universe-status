#!/usr/bin/env node
// Gate S3.6 on the GPU — implicit variational viscosity (Batty & Bridson 2008), FINAL-PLAN S3.6.
//
//   node scripts/fluid-gates/s36-gpu.mjs [--solver=mgpcg] [--quick]   (default server: the clean gate tree; FLUID_BASE to
//   override; --quick: the kernel parity cases only — what gpu-mutations.mjs --gate=s36 runs)
//
// Kernel parity on the reference's exact viscous input (src/bench/flipSelftest/visc.ts; bounds derived there): K26
// volumes (per sample ≤ 1 × the level set's own φ bound × the smooth step's slope), K27 the sample viscosity μ = w/(cV)
// (≤ 1 × a per-sample bound from the reference's taps: f32(μ) where one material reaches the sample, the harmonic mean's
// f32/fixed-point error where several do), K28 the unknown set (identical), K29 the solved velocity (≤ 1e-3·max|u*| — an
// f32 PCG to 1e-6 relative), on a honey pool with no-slip walls, the same pool with water above y = 4 cells (μ contrast
// 4e4: mixed samples must be exercised), a 64³ ring(5,11,3) copy, and a lava box with free-slip walls.
// Physics at the page's production settings (S3.6f excepted, below), the s36-ref scenes and criteria:
// S3.6a Taylor–Green, honey and lava, L = 8/16/32 cells: |(ν_eff − ν_num)/ν − 1| ≤ 5 %. The closed box has no air, so the
//       GPU ψ solve (no null-space pinning, unlike the reference) is singular there: this scene runs with the density
//       projection off (measured: with it on, lava L = 16 read 0.914·ν; off, 1.000·ν — the viscous solve is exact).
// S3.6b E2 lava standing wave, H/dx = 28, free-slip walls in the viscous solve: ω' and σ within ±10 % of the root of the
//       viscous dispersion relation (derived in s36-ref.mjs for this geometry; = Lamb §349 in deep water).
// S3.6d Huppert viscous gravity current, lava, no-slip floor: late exponent 0.20 ± 0.02; x_N/prediction ±10 % at 2, 5, 10 s.
// S3.6f water D1 (H/dx = 28) with the viscous solve on vs off: decay and E_K frequency within 1 %, at pressure/ψ tolerance
//       1e-4 (the reference's own condition: its solves run to 1e-9). The viscous path projects twice (paper §3), so at the
//       production 1e-2 the on/off difference measures the pressure solver's residual, not viscosity (measured: +0.96 %
//       at 1e-2, −0.16 % at 1e-4; the tolerance alone moves ν_num by 3.7 %) — the production pair is reported as INFO.
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { fitOmega, nuNum } from './lib/s34metrics.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.6 (implicit viscosity on the GPU)')
const report = { prov: await provenance() }
const G = 9.80665
const QUICK = process.argv.includes('--quick')

// the viscous standing-wave root (s36-ref.mjs, same derivation)
const C = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]], mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d] },
  sqrt: a => { const r = Math.hypot(a[0], a[1]); return [Math.sqrt((r + a[0]) / 2), Math.sign(a[1] || 1) * Math.sqrt(Math.max(0, (r - a[0]) / 2))] },
  exp: a => [Math.exp(a[0]) * Math.cos(a[1]), Math.exp(a[0]) * Math.sin(a[1])],
  re: x => [x, 0],
}
function viscousWaveRoot(k, H, nu) {
  const sh = z => C.mul(C.re(0.5), C.sub(C.re(1), C.exp(C.mul(C.re(-2), z)))), ch = z => C.mul(C.re(0.5), C.add(C.re(1), C.exp(C.mul(C.re(-2), z))))
  const f = s => {
    const m = C.sqrt(C.add(C.re(k * k), C.div(s, C.re(nu)))), kH = C.re(k * H), mH = C.mul(m, C.re(H)), gk = C.re(G * k)
    const a11 = C.mul(C.re(-2 * k * k), sh(kH)), a12 = C.mul(C.add(C.mul(m, m), C.re(k * k)), sh(mH))
    const a21 = C.add(C.add(C.mul(s, ch(kH)), C.mul(C.div(gk, s), sh(kH))), C.mul(C.re(2 * nu * k * k), ch(kH)))
    const a22 = C.sub(C.mul(C.re(-1), C.mul(C.div(gk, s), sh(mH))), C.mul(C.mul(C.re(2 * nu * k), m), ch(mH)))
    return C.sub(C.mul(a11, a22), C.mul(a12, a21))
  }
  let s = [-2 * nu * k * k, Math.sqrt(G * k * Math.tanh(k * H))]
  for (let it = 0; it < 100; it++) {
    const h = 1e-7 * Math.hypot(s[0], s[1]), fs = f(s), step = C.div(fs, C.div(C.sub(f(C.add(s, [h, 0])), fs), [h, 0]))
    s = C.sub(s, step)
    if (Math.hypot(step[0], step[1]) < 1e-12 * Math.hypot(s[0], s[1])) break
  }
  return { sigma: -s[0], omega: s[1] }
}
const slope = (ts, ys) => {
  const n = ts.length, tm = ts.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += (ts[i] - tm) * (ys[i] - ym); sxx += (ts[i] - tm) ** 2 }
  return sxy / sxx
}

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
  const SOLVER = (process.argv.find(a => a.startsWith('--solver=')) ?? '--solver=mgpcg').slice(9)
  report.solver = (await run('configure', { solver: SOLVER })).solver
  console.log(`  pressure/ψ solver: ${report.solver}`)

  report.kernels = {}
  for (const c of [{ label: 'honey pool 16×16×8, no-slip', n: [16, 16, 8] }, { label: 'honey under water 16×16×8, no-slip', n: [16, 16, 8], mixed: true },
    { label: 'honey pool 64³ ring(5,11,3)', n: [64, 64, 64], ring: [5, 11, 3] },
    { label: 'lava box 16×16×8, free-slip', n: [16, 16, 8], walls: 'free-slip', material: 'lava', full: true }]) {
    const r = await run('viscKernels', c)
    report.kernels[c.label] = r
    const f = x => x.toFixed(3)
    gate.check(r.k26.volRatio <= 1 && r.k27.wRatio <= 1 && (!c.mixed || r.k27.mixedSamples > 0) && r.k28.mismatch === 0 && r.k28.unknownsGpu > 0 && r.k29.uRatio <= 1 && r.k29.change > 0 && r.k29.masslessChanged === 0 && r.gpuConverged,
      `K26–K29 viscosity ${c.label}: volumes |ΔV|/bound ${f(r.k26.volRatio)} (${r.k26.surfaceSamples} surface samples), μ |Δμ|/bound ${f(r.k27.wRatio)}${c.mixed ? ` (${r.k27.mixedSamples} mixed samples: ${f(r.k27.mixedRatio)} of bounds up to ${r.k27.mixedBMax.toExponential(1)} relative)` : ''}, unknowns GPU ${r.k28.unknownsGpu} = reference ${r.k28.unknownsRef}, solved |Δu|/(1e-3·max|u*|) ${f(r.k29.uRatio)} (the step changed u by up to ${r.k29.change.toExponential(2)} m/s), mass-less unknowns left at u* ${r.k29.massless - r.k29.masslessChanged}/${r.k29.massless}; GPU PCG ${r.gpuIterations} it, rel. residual ${r.gpuRel.toExponential(1)}`)
  }

  if (QUICK) console.log('--quick: physics scenes skipped')
  else {
  report.tg = []
  for (const material of ['honey', 'lava']) for (const cells of [8, 16, 32]) {
    const on = await run('viscTaylorGreen', { cells, material, on: true, density: false }), off = await run('viscTaylorGreen', { cells, material, on: false, density: false })
    const err = (on.nuEff - off.nuEff) / on.nu - 1
    report.tg.push({ material, cells, on, off })
    gate.check(Math.abs(err) <= 0.05 && on.breakdowns === 0 && on.capHits <= 0.01 * on.solves,
      `S3.6a Taylor–Green on the GPU, ${material} (ν ${on.nu.toExponential(3)}), L = ${cells} cells (density projection off: closed box): ν_eff ${on.nuEff.toExponential(3)}, ν_num ${off.nuEff.toExponential(3)} → ${(100 * err).toFixed(2)} % (±5 %); viscous PCG ${on.viscIterations} it; cap hits ${on.capHits}/${on.solves}`)
  }

  const e2 = await run('viscStandingWave', { cellsPerH: 28, material: 'lava', on: true, walls: 'free-slip', periods: 3 })
  const LAVA_NU = 10 ** (-4.55 + 5963 / (1200 + 273.15 - 600.7)) / 2600
  const root = viscousWaveRoot(e2.k, e2.H, LAVA_NU), wFit = fitOmega(e2.ts, e2.es, e2.omega), sFit = 2 * e2.k * e2.k * nuNum(e2.ts, e2.es, e2.omega, e2.k).nu
  report.e2 = { wFit, sFit, root }
  gate.check(Math.abs(wFit / root.omega - 1) <= 0.10 && Math.abs(sFit / root.sigma - 1) <= 0.10,
    `S3.6b E2 lava standing wave on the GPU (H/dx = 28, ${e2.particles} particles): ω' ${wFit.toFixed(4)} vs the viscous root ${root.omega.toFixed(4)} rad/s (${(100 * (wFit / root.omega - 1)).toFixed(2)} %, ±10 %); σ ${sFit.toFixed(4)} vs ${root.sigma.toFixed(4)} 1/s (${(100 * (sFit / root.sigma - 1)).toFixed(2)} %, ±10 %; the CPU reference measures +12 % at this resolution, +23 % at H/dx = 14 — first-order convergence, the surface boundary layer spans 3 cells)`)

  const hu = await run('viscHuppert')
  const pred = t => 1.411 * (G * hu.A ** 3 * t / (3 * hu.nu)) ** 0.2
  const late = hu.ts.map((t, i) => i).filter(i => hu.ts[i] >= 2)
  const expo = slope(late.map(i => Math.log(hu.ts[i])), late.map(i => Math.log(hu.xs[i])))
  const ratios = [2, 5, 10].map(T => hu.at[T] / pred(T))
  report.huppert = { expo, ratios, A: hu.A }
  gate.check(Math.abs(expo - 0.2) <= 0.02 && ratios.every(r => Math.abs(r - 1) <= 0.10),
    `S3.6d Huppert on the GPU, lava (A = ${hu.A.toFixed(3)} m²): late exponent ${expo.toFixed(3)} (0.20 ± 0.02); x_N/prediction at 2 / 5 / 10 s ${ratios.map(r => r.toFixed(3)).join(' / ')} (±10 %); viscous PCG ${hu.viscIterations} it; cap hits ${hu.capHits}/${hu.solves}`)

  const fPair = async production => {
    const on = await run('viscStandingWave', { cellsPerH: 28, material: 'water', on: true, walls: 'no-slip', periods: 4, production })
    const off = await run('viscStandingWave', { cellsPerH: 28, material: 'water', on: false, walls: 'no-slip', periods: 4, production })
    return { dOn: nuNum(on.ts, on.es, on.omega, on.k).nu, dOff: nuNum(off.ts, off.es, off.omega, off.k).nu, wOn: fitOmega(on.ts, on.es, on.omega), wOff: fitOmega(off.ts, off.es, off.omega) }
  }
  const pct = (a, b) => (100 * (a / b - 1)).toFixed(3)
  const fT = await fPair(false), fP = await fPair(true)
  report.f = { tight: fT, production: fP }
  gate.check(Math.abs(fT.dOn / fT.dOff - 1) <= 0.01 && Math.abs(fT.wOn / fT.wOff - 1) <= 0.01,
    `S3.6f water D1 on the GPU (H/dx = 28, pressure/ψ tolerance 1e-4) with the viscous solve on vs off: decay ν ${fT.dOn.toExponential(3)} vs ${fT.dOff.toExponential(3)} m²/s (${pct(fT.dOn, fT.dOff)} %, ±1 %), ω ${fT.wOn.toFixed(4)} vs ${fT.wOff.toFixed(4)} (${pct(fT.wOn, fT.wOff)} %, ±1 %)`)
  console.log(`INFO S3.6f at the production tolerance 1e-2 (not gated: the viscous path runs the 1e-2 pressure solve a second time, so on vs off differs by the solver's residual): decay ν ${fP.dOn.toExponential(3)} vs ${fP.dOff.toExponential(3)} m²/s (${pct(fP.dOn, fP.dOff)} %), ω ${pct(fP.wOn, fP.wOff)} %`)

  }
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's36-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
