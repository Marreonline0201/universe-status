#!/usr/bin/env node
// Gate S3.6e on the GPU — the unified pressure–stress (Variational Stokes) solve for a ball in a thick liquid (owner
// decision 2026-09-29; spec vault fluid/realism-2026-09/S3.6e-variational-stokes-spec.md §5; the f64 reference and its
// criteria: s36e-ref.mjs).
//
//   node scripts/fluid-gates/s36e-gpu.mjs   (default server: the clean gate tree; FLUID_BASE to override)
//
// Criteria (fixed before the first run of each):
// G0 the level set with the ball's radial images ("a solid is not air" — required by the Stokes ball): a honey pool with
//    a submerged ball (R = 3·dx), the GPU's cell-centre φ (lsScatter) and viscous quarter-lattice φ (latScatter) vs
//    flipRef.zhuBridson with levelSetSphere 'mirror' on the same particles, each ≤ 1 × the per-sample bound (ghost.ts
//    phiTol; samples within reach of an image add the image's f32 construction error, stokes.ts IMAGE_ULPS = 13 ulp);
//    the images must be exercised (samples they move by more than their bound > 0, cells and lattice); negative control:
//    the GPU with its images off must exceed the bound (> 1).
// K40 (the K35 pattern) the A5 scene (iron in the 1100 °C GRD melt, R = 3.5 cells, tank 24 × 30 × 24), one Stokes step
//    (cold) and the next (warm-started), at the page tolerance 1e-2 (spec §5: it moves the CPU's A5 fall by ≤ 0.25 %): the
//    TRUE residual of the GPU's y against the operator assembled in f64 from the GPU's own read-back coefficients, rows
//    enumerated independently of the shader, ≤ 1 × (tol + (it + 2)·8u·max_r Σ|A_rj y_j|); converged; no live row touches a
//    free face; discrimination: the τ unknowns' share of A·y and the ball's rank term each ≥ 10 × that bound; the GPU's own
//    diag and b vs their f64 recomputation ≤ 1 × an f32 accumulation bound (8u·(terms + 4) × the sum of magnitudes).
// A1S-G s36e-ref's A1S on the GPU (s = 2 ball in water, R = 3.5, settled on the split path, released by ONE Stokes step):
//    a₀ within ±5 % of g(s − 1)/(s + ½) at the page tolerance 1e-2 (the reference: −2.17 % at 1e-6).
// A5S-G s36e-ref's A5S on the GPU at 1e-2: U/U_Stokes within ±10 % of the square-duct reference 0.470 at R = 3.5 and
//    |err(R = 5)| ≤ |err(R = 2.5)| (the reference: 0.531 / 0.516 / 0.491); no Stokes cap hit.
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.6e on the GPU (the unified Stokes solve)')
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
  const run = (t, p = {}) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])
  report.solver = (await run('configure', { solver: 'mgpcg' })).solver

  // G0
  const g0 = await run('stokesImages', {}), g0c = await run('stokesImages', { gpuImages: false })
  report.g0 = { on: g0, control: g0c }
  const f = x => x.toFixed(4)
  gate.check(g0.cellRatio <= 1 && g0.latRatio <= 1 && g0.cellImaged > 0 && g0.latImaged > 0,
    `G0 the level set with the ball's radial images (${g0.particles} particles, R = 3·dx submerged): cell φ ${f(g0.cellRatio)} × bound (${g0.cellImaged} cells moved by the images beyond it), viscous lattice φ ${f(g0.latRatio)} × bound over ${g0.latPoints} band points (${g0.latImaged} moved by the images)`)
  gate.check(g0c.cellRatio > 1 || g0c.latRatio > 1,
    `G0 control: the GPU without its images reads cell φ ${g0c.cellRatio.toFixed(1)} × / lattice φ ${g0c.latRatio.toFixed(1)} × the bound (must exceed 1)`)

  // K40
  const k40 = await run('stokesK40', { tol: 1e-2, steps: 2 })
  report.k40 = k40
  for (const s of k40.steps) {
    gate.check(s.ratio <= 1 && s.converged && !s.breakdown && s.freeHit === 0 && s.tauDisc >= 10 && s.rankDisc >= 10 && s.diagRatio <= 1 && s.bRatio <= 1,
      `K40${s.step ? 'w (warm-started)' : ' (cold)'} the Stokes solve on the A5 scene (${s.rows} live rows, ${s.iterations} it): true residual ‖b − Ay‖∞ ${s.resInf.toExponential(3)} = ${f(s.ratio)} × bound ${s.bound.toExponential(3)}; τ share ${s.tauDisc.toFixed(1)} ×, rank term ${s.rankDisc.toFixed(1)} × the bound (≥ 10); diag ${f(s.diagRatio)}, b ${f(s.bRatio)} of their f32 bounds; free faces touched ${s.freeHit}`)
  }
  // A1S-G
  const a1 = await run('stokesPhysics', { test: 'A1S', tol: 1e-2 })
  report.a1s = a1
  gate.check(Math.abs(a1.a / a1.a0 - 1) <= 0.05 && a1.converged,
    `A1S-G s = 2 ball released by one GPU Stokes step (R = 3.5 cells, ${a1.particles} particles, ${a1.iterations} it): a₀ ${a1.a.toFixed(4)} m/s² vs g(s − 1)/(s + ½) ${a1.a0.toFixed(4)} (${(100 * (a1.a / a1.a0 - 1)).toFixed(2)} %, ±5 %; the reference −2.17 %)`)
  // A5S-G
  const rows = []
  for (const Rc of [2.5, 3.5, 5]) rows.push(await run('stokesPhysics', { test: 'A5S', Rc, tol: 1e-2 }))
  report.a5s = rows
  const REF = 0.470, err = r => r.u / REF - 1
  gate.check(Math.abs(err(rows[1])) <= 0.10 && Math.abs(err(rows[2])) <= Math.abs(err(rows[0])) && rows.every(r => r.faults.capHits === 0),
    `A5S-G iron in GRD melt 1100 °C on the GPU Stokes path, terminal U/U_Stokes ${rows.map(r => `${r.u.toFixed(4)} at R = ${r.Rc} (${(100 * err(r)).toFixed(1)} %, tank ${r.n.join('×')}, ${r.t.toFixed(2)} s, max ${r.faults.maxIterations} it)`).join('; ')} vs the square-duct reference 0.470 (±10 % at R = 3.5, |err| R = 5 ≤ R = 2.5; the reference 0.531 / 0.516 / 0.491); Stokes cap hits ${rows.map(r => r.faults.capHits).join('/')}`)

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's36e-gpu', pass, report, gate.results)
exitGate(pass ? 0 : 1)
