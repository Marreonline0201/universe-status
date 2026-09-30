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
// 1e-12); K32 the drift in the face form, the default (2026-09-30 01:56, fixed before the first GPU run; bounds derived in
// immiscible.ts): J_f per face ≤ 1 × its bound, wall faces and faces below FACE_WEIGHT_MIN exactly 0 on both sides, ≥ 1
// wall face reached by a drop (the wall rule is exercised), u_V per particle ≤ 1 × its bound, the reference's slip update
// identical in both forms (≤ 1e-12); the face form runs twice from the same history and BOTH runs are checked — run 1 from
// zeroed face buffers catches a stale-read kernel order, run 2 a face sum left uncleared (review 2026-09-30 #6; the
// 'ball' case, added then: a held ball among the drops — faces with S_f ≥ 1 exactly 0, ≥ 1 of them with Σw ≥
// FACE_WEIGHT_MIN reached by a drop, and u_V with the ball's J·n ramp checked within dx of its surface, review #1/#2/#7);
// K32c the cell form, the control (≤ 1 × its bound); K33 g2pMac's advection adds Δt·u_V (u = 0 on the grid; ≤ 2u·(|x| + Δt|u_V|));
// K34 the face acceleration a = g − Du/Dt (faceAccel + the velocity's extrapolation kernel; ≤ 16u·max|a|, derived there).
// Physics (full gate) on the GPU path: G-rest (s35i-ref B's lattice column at rest, water and honey — the viscous path —
// over mercury: after one full step a = g within two rows of the interface, ≤ 1e-3 at pressure tolerance 1e-4/s: the
// u* snapshot and the face acceleration are taken at the right places), D-b and M (s35i-ref's criteria, at the page's
// settings), D-c reported.
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
import { exitGate } from '../lib/exit.mjs'

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
    { kind: 'hinze', label: 'olive oil, Hinze sizing, drop history' }, { kind: 'mix4', label: 'four liquids, ids 0/3/7/12, Hinze' },
    { kind: 'ball', label: 'olive oil 1 mm around a held ball' }]) {
    const r = await run('immKernels', { kind: c.kind })
    report.kernels[c.kind] = r
    const a = r.k30, b = r.k31, d = r.k32, dc = r.k32c
    gate.check(a.cellsSeen > 0 && a.alphaRatio <= 1 && a.rhoRatio <= 1 && a.epsRatio <= 1 && a.majorityMismatch === 0 && (c.kind === 'oil' || c.kind === 'mercury' || c.kind === 'ball' || a.epsCells > 0),
      `K30 cells, ${c.label} (${r.particles} particles): α |Δα|/bound ${f(a.alphaRatio)}, ρ_m ${f(a.rhoRatio)}, ε ${f(a.epsRatio)} over ${a.epsCells} cells, majority mismatches ${a.majorityMismatch} of ${a.cellsSeen} cells (${a.majorityExcused} near ties excused)`)
    const branches = c.kind === 'mercury' ? b.seriesBranch > 0 && b.newton > 0 : c.kind === 'hinze' ? b.cpuTooLarge > 0 : true
    gate.check(b.dispersed > 0 && b.slipRatio <= 1 && b.dropRatio <= 1 && b.dispMismatch === 0 && b.recompute === 0 && branches
      && Math.abs(b.gpuDispersed - b.cpuDispersed) <= b.dispExcused,
      `K31 slip, ${c.label}: ${b.dispersed} dispersed compared (GPU ${b.gpuDispersed}, reference ${b.cpuDispersed}; ${b.dispExcused} at the d = dx edge or the Re = 1000 seam excused), |Δs|/bound ${f(b.slipRatio)}, |Δd|/bound ${f(b.dropRatio)}, dispersed-set mismatches ${b.dispMismatch}, too large GPU ${b.gpuTooLarge} / reference ${b.cpuTooLarge}; branches series ${b.seriesBranch} / exp ${b.expBranch}, Newton drag ${b.newton}; bound recomputation off in ${b.recompute}; largest slip GPU ${b.maxSlip.gpu.toExponential(4)} / reference ${b.maxSlip.cpu.toExponential(4)} m/s, mean drop ${(1e3 * b.meanDrop.gpu).toFixed(4)} / ${(1e3 * b.meanDrop.cpu).toFixed(4)} mm`)
    const ballOk = c.kind !== 'ball' || (d.ballTouched > 0 && d.rampParticles > 0)
    gate.check(d.facesChecked > 0 && d.faceRatio <= 1 && d.faceZeroMismatch === 0 && d.wallTouched > 0 && d.driftChecked > 0 && d.driftRatio <= 1 && d.slipFormDiff <= 1e-12 && ballOk,
      `K32 drift, face form, ${c.label}: J_f |ΔJ|/bound ${f(d.faceRatio)} (run 1 ${f(d.run1.faceRatio)}, run 2 ${f(d.run2.faceRatio)}) over ${d.facesChecked} faces (${d.facesExcused} excused; wall/ball/under-weight faces not exactly 0: ${d.faceZeroMismatch}; ${d.wallTouched} wall faces reached by drops, ${d.edgeTouched} ghost-layer edge faces${c.kind === 'ball' ? `; ${d.ballTouched} ball faces (S_f ≥ 1, Σw ≥ FACE_WEIGHT_MIN) reached by drops` : ''}), u_V |Δu_V|/bound ${f(d.driftRatio)} (run 1 ${f(d.run1.driftRatio)}, run 2 ${f(d.run2.driftRatio)}) over ${d.driftChecked} particles (${d.driftSkipped} skipped${c.kind === 'ball' ? `; ${d.rampParticles} within dx of the ball, the J·n ramp` : ''}; largest |u_V| ${d.driftMax.toExponential(3)} m/s); reference slip update identical in both forms: ${d.slipFormDiff.toExponential(1)}`)
    gate.check(dc.driftChecked > 0 && dc.driftRatio <= 1,
      `K32c drift, cell form (the control), ${c.label}: |Δu_V|/bound ${f(dc.driftRatio)} over ${dc.driftChecked} particles (${dc.driftSkipped} in cells with an excused particle skipped; largest |u_V| ${dc.driftMax.toExponential(3)} m/s)`)
    const g = r.k34
    gate.check(g.accFaces > 0 && g.accSolidFaces > 0 && g.accRatio <= 1,
      `K34 face acceleration a = g − Du/Dt, ${c.label}: |Δa|/(16u·max|a|) ${f(g.accRatio)} over ${g.accFaces} non-zero faces (${g.accSolidFaces} wall faces at g), max |a| ${(g.accMax / 9.80665).toFixed(3)} g`)
    const e = r.k33
    gate.check(e.advChecked > 0 && e.advMoved > 0 && e.advRatio <= 1,
      `K33 advection adds the drift, ${c.label} (u = 0 on the grid): |x′ − (x + Δt·u_V)|/bound ${f(e.advRatio)} over ${e.advChecked} particles (${e.advMoved} moved by the drift; ${e.advClamped} held by the wall clamp excluded)`)
  }

  if (QUICK) console.log('--quick: physics scenes skipped')
  else {
    report.physics = {}
    for (const light of ['water', 'honey']) {
      const r = await run('immRest', { light })
      report.physics[`rest-${light}`] = r
      gate.check(r.yErr <= 1e-3 && r.hErr <= 1e-3 && (light === 'water' || r.viscous) && r.breakdowns === 0,
        `G-rest ${light} over mercury at rest on the GPU's full step (lattice, drops on the interface row${light === 'honey' ? '; the viscous path: two projections' : ''}): max |a_y − g|/g ${r.yErr.toExponential(2)}, max |a_x|,|a_z|/g ${r.hErr.toExponential(2)} over ${r.faces} faces within two rows of the interface (≤ 1e-3; pressure tolerance 1e-4/s)`)
    }
    const db = await run('immLayered', { lower: 'water', upper: 'oil', seconds: 11, seed: 101, immiscible: true })
    report.physics.db = db
    const dbLast = db.hist[db.hist.length - 1]
    gate.check(db.everDispersed === 0 && dbLast.wrong === 0 && db.nan === 0,
      `D-b on the GPU at the page's settings (pressure 1e-2, ψ 1e-3): olive oil over water at rest, 11 s (${db.particles} particles), Hinze sizing: largest dispersed count ${db.everDispersed} (0), wrong side ${(100 * dbLast.wrong).toFixed(2)} % (0.0 %)`)
    const m = await run('immLayered', { lower: 'water', upper: 'ethanol', seconds: 3, seed: 111, immiscible: true })
    report.physics.m = m
    gate.check(m.everDispersed === 0 && m.nan === 0, `M on the GPU: ethanol over water (miscible, σ = null), 3 s: largest dispersed count ${m.everDispersed} (0)`)
    for (const [label, lower, upper, seconds, seed] of [['water over olive oil', 'oil', 'water', 15, 72], ['mercury over water', 'water', 'mercury', 8, 71]]) {
      const on = await run('immLayered', { lower, upper, seconds, seed, immiscible: true })
      const off = await run('immLayered', { lower, upper, seconds, seed, immiscible: false })
      report.physics[`dc-${upper}`] = { on, off }
      gate.check(on.nan === 0 && off.nan === 0, `D-c ${label} on the GPU: no non-finite position (${on.nan} / ${off.nan})`)
      console.log(`INFO D-c ${label} on the GPU, released inverted, ${seconds} s: wrong side with the drift flux ${on.hist.filter((h, i) => i % 2 === 1 || i === on.hist.length - 1).map(h => `${h.t.toFixed(0)} s ${(100 * h.wrong).toFixed(1)} %`).join(', ')}; without ${(100 * off.hist[off.hist.length - 1].wrong).toFixed(1)} % at ${seconds} s; largest slip ${on.maxSlip.toFixed(4)} m/s, most dispersed ${on.everDispersed}`)
    }
  }
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's35i-gpu', pass, report, gate.results)
exitGate(pass ? 0 : 1)
