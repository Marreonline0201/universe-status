#!/usr/bin/env node
// Gate S3.7 on the GPU — the monolithic ball (Batty, Bertails & Bridson 2007 eq. 13): PoissonSolver's rank-3 term
// A′ = A + Σ_a Ĵ_a Ĵ_aᵀ, the ball's V_J / gravity-first / implicit update kernels (FlipGpuSimulator, coupling
// 'monolithic'). The f64 reference and the criteria: s37-ref.mjs; spec vault fluid/realism-2026-09/S3.7-two-way-ball-spec.md.
//
//   node scripts/fluid-gates/s37-gpu.mjs [--quick]   (default server: the clean gate tree; FLUID_BASE to override;
//   --quick: K35/K36 only — what gpu-mutations.mjs --gate=s37 runs)
//
// K35 the rank-3 solve: the TRUE residual of the GPU's pressure against A′ assembled in f64 from the GPU's own operator,
//     right-hand side and Ĵ ≤ 1 × (tolerance + the f32 drift of the recursive residual, (iterations + 2)·8u·max row);
//     and the rank term ≥ 10 × that bound (so a solver that ignored it could not pass); converged; Ĵ itself vs f64
//     (K35's A′ uses the GPU's own Ĵ, so its scale needs this). K35w the same on the next substep's warm-started solve.
// K36 gravity first, V* = Vⁿ + Δt·g (≤ 4u·|V|), then the ball's update after the projection: V = V* + Δt·F/M with F,
//     V_J recomputed in f64 from the GPU's own pressure,
//     labels and solid fractions ≤ 1 × a bound from the fixed-point force sums; and the update ≥ 10 × that bound.
// Physics (s37-ref's scenes and criteria at pressure tolerance 1e-4; the page's 1e-2 reported for A1):
// A1 s = 2 from rest, clearance 3R: a₀ = g(s − 1)/(s + ½) ±5 % at R = 3.5 cells; |error(5)| ≤ |error(2.5)|.
// A2 iron (NIST SRD 126), R = 3.5 cells: ±3 %.
// A3 neutral ball: centre drift ≤ 0.5 cell over 10 s.
// A4 floating s = ½: mean submerged fraction over the last 2 s of 6 s = ½ ± 5 %.
// Limit (disclosed): the GPU viscous solve keeps the ball's faces at V (no skin friction); s37-ref's A5 stays open (S3.6e).
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.7 (the monolithic ball on the GPU)')
const report = { prov: await provenance() }
const QUICK = process.argv.includes('--quick')
const G = 9.80665, RHO = 998.2072, RHO_FE = 7874

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
  const f = x => (Number.isFinite(x) ? x.toFixed(3) : String(x))

  report.kernels = []
  for (const seed of [51, 52]) {
    const r = await run('s37Kernels', { seed })
    report.kernels.push(r)
    const a = r.k35, b = r.k36, w = r.k35w
    gate.check(a.converged && a.ratio <= 1 && a.discrimination >= 10 && a.jRows > 0 && a.jRatio <= 1,
      `K35 rank-3 solve (seed ${seed}, ${a.unknowns} unknowns, ${a.jRows} with Ĵ ≠ 0, ${a.iterations} it): true residual ‖b − A′p‖∞ ${a.resInf.toExponential(3)} = ${f(a.ratio)} × bound ${a.bound.toExponential(3)}; rank term ${a.rankInf.toExponential(3)} = ${a.discrimination.toFixed(1)} × bound (≥ 10); Ĵ vs f64 (√(Δt/(M dx³))·dx²·Σ sgn S) ${f(a.jRatio)} of its bound`)
    gate.check(w.converged && w.ratio <= 1 && w.discrimination >= 10,
      `K35w the next substep's solve, warm-started from the last pressure (seed ${seed}, ${w.iterations} it): true residual ${w.resInf.toExponential(3)} = ${f(w.ratio)} × bound; rank term ${w.discrimination.toFixed(1)} × bound`)
    gate.check(b.vRatio <= 1 && b.vChange > 0 && b.gRatio <= 1,
      `K36 the ball's update, gravity first V* = Vⁿ + Δt·g (|ΔV*|/(4u|V|) ${f(b.gRatio)}) then V = V* + Δt·F/M (seed ${seed}): |ΔV|/bound ${f(b.vRatio)}; the projection changed V by ${b.vChange.toExponential(3)} m/s; F GPU (${b.forceGpu.map(v => v.toFixed(3)).join(', ')}) N vs f64 (${b.force.map(v => v.toFixed(3)).join(', ')}); V_J ${b.volumeJGpu.toExponential(5)} vs ${b.volumeJ.toExponential(5)} m³`)
  }

  if (QUICK) console.log('--quick: physics scenes skipped')
  else {
    const a0 = s => G * (s - 1) / (s + 0.5)
    const A1 = []
    for (const Rc of [2.5, 3.5, 5]) A1.push({ Rc, ...(await run('s37Physics', { test: 'A1', Rc, s: 2 })) })
    report.A1 = A1
    const err = r => r.a / a0(2) - 1, r25 = A1[0], r35 = A1[1], r5 = A1[2]
    gate.check(Math.abs(err(r35)) <= 0.05 && Math.abs(err(r5)) <= Math.abs(err(r25)) && A1.every(r => r.breakdowns === 0),
      `A1 s = 2 from rest on the GPU: a₀ ${r35.a.toFixed(3)} m/s² at R = 3.5 cells vs g(s−1)/(s+½) ${a0(2).toFixed(3)} (${(100 * err(r35)).toFixed(2)} %, ±5 %; without added mass ${(G / 2).toFixed(3)}); |error| R = 2.5 / 3.5 / 5: ${A1.map(r => (100 * Math.abs(err(r))).toFixed(2)).join(' / ')} % (R = 5 ≤ R = 2.5)`)
    const prod = await run('s37Physics', { test: 'A1', Rc: 3.5, s: 2, tol: 1e-2 })
    report.A1prod = prod
    console.log(`INFO A1 at the page's pressure tolerance 1e-2, R = 3.5 cells: a₀ ${prod.a.toFixed(3)} m/s² (${(100 * (prod.a / a0(2) - 1)).toFixed(2)} %)`)
    const sFe = RHO_FE / RHO, A2 = await run('s37Physics', { test: 'A1', Rc: 3.5, s: sFe, seed: 32 })
    report.A2 = A2
    gate.check(Math.abs(A2.a / a0(sFe) - 1) <= 0.03 && A2.breakdowns === 0,
      `A2 iron (s = ${sFe.toFixed(3)}) on the GPU, R = 3.5 cells: a₀ ${A2.a.toFixed(3)} m/s² vs ${a0(sFe).toFixed(3)} (${(100 * (A2.a / a0(sFe) - 1)).toFixed(2)} %, ±3 %)`)
    const A3 = await run('s37Physics', { test: 'A3' })
    report.A3 = A3
    gate.check(A3.maxDrift <= 0.5 && A3.breakdowns === 0, `A3 neutral ball on the GPU, R = 3.5 cells, 10 s: largest centre drift ${A3.maxDrift.toFixed(3)} cells (≤ 0.5)`)
    const A4 = await run('s37Physics', { test: 'A4' })
    report.A4 = A4
    gate.check(Math.abs(A4.f - 0.5) <= 0.025 && A4.breakdowns === 0,
      `A4 floating ball s = ½ on the GPU, R = 3.5 cells: mean submerged fraction over the last 2 s of 6 s ${A4.f.toFixed(4)} (range ${A4.fMin.toFixed(3)}–${A4.fMax.toFixed(3)}) vs Archimedes 0.5 (±5 %)`)
  }
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's37-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
