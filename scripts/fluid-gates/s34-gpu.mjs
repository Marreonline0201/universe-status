#!/usr/bin/env node
// Gate S3.4 on the GPU — the ghost-fluid level-set kernels against the f64 CPU reference, then the S3.4 physics gates
// on the GPU path with the SAME measurement definitions as s34-ref.mjs (scripts/fluid-gates/lib/s34metrics.mjs).
//
//   node scripts/fluid-gates/s34-gpu.mjs [--solver=mgpcg]   (default server: the clean gate tree; FLUID_BASE to override)
//   node scripts/fluid-gates/s34-gpu.mjs --quick            (kernel parity + S34a only — used by gpu-mutations.mjs)
//
// Tolerances (fixed before the first run):
//  K15 lsScatter + lsFinalize  every cell: |φ − ref| ≤ phiTol(w) (ghost.ts: ≤ 64 adds × (2^-23 fixed-point rounding
//                              + 1.2e-5 f32 kernel weight), ×2/w for the ratio, + 1e-6·dx); labels identical except
//                              where |φ_ref| is inside that bound
//  K16 ghostCoef               face-centre φ within phiTol; the extra diagonal vs f64 on the GPU's own φ and labels
//                              ≤ 1e-5·(extra + a); a on every face within 1e-6 relative
//  K17 project (ghost branch)  AIR pressure poisoned to 1e5 Pa. Non-surface faces vs the reference ≤ 1e-5·max|u|;
//                              liquid–air faces vs u* − Δt/(ρdx)·(p₊ − p₋) with the GPU's θ ≤ 1e-5·max(|u|, Δt/(ρdx)·|p_g|);
//                              set/unset identical
//  cases: 16³, 64³ ring (5,11,3), 24×16×12 ring (7,2,9)
//  S34a, G1c, D1, D2, A1, A1c, A2 front, A2 impulse, V1 — exactly as s34-ref.mjs (see its header; its A1/A2
//  time-origin revision of 2026-09-29 applies here too). A2g (the gated release vs Lobovský) is CPU-only: the GPU solver
//  has no moving internal wall.
//  G2 again with the ghost-fluid surface: 30 s double dam break, |φ-volume/(N·V_p) − 1| ≤ 2 % (S3.2 G2's tolerance)
//  and: 0 solver breakdowns, 0 uncaptured WebGPU errors, 0 console errors.
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { MM1, MM1H, MM2, MM2H, LOBOVSKY_I600, fitOmega, nuNum, columnScore, impulse, selfConvergence } from './lib/s34metrics.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const QUICK = process.argv.includes('--quick')
const gate = makeGate(`GATE S3.4 (ghost-fluid free surface on the GPU)${QUICK ? ' — QUICK subset' : ''}`)
const report = { prov: await provenance() }
const G = 9.80665, DX = 3.63 / 64, RHO = 998.2072

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
  for (const c of [{ label: '16³', n: [16, 16, 16] }, { label: '64³ ring(5,11,3)', n: [64, 64, 64], ring: [5, 11, 3] }, { label: '24×16×12 ring(7,2,9)', n: [24, 16, 12], ring: [7, 2, 9] }]) {
    const r = await run('ghostKernels', c)
    report.kernels[c.label] = r
    gate.check(r.k15.phiRatio <= 1 && r.k15.labelMismatch === 0 && r.k15.relabelsRef > 0 && r.k15.particlesInAirCells > 0 && Math.abs(r.k15.relabelsGpu - r.k15.relabelsRef) <= r.k15.nearZero,
      `K15 lsScatter+lsFinalize+lsResolve ${c.label} (${r.particles} particles, ${r.k15.liquid} liquid cells): max |Δφ|/bound ${r.k15.phiRatio.toFixed(3)} (≤ 1); surface band |Δφ| ${r.k15.surfPhiDiffDx.toExponential(2)} dx; label mismatches ${r.k15.labelMismatch} (+${r.k15.nearZero} inside the bound of φ = 0, own or a neighbour's); unresolved relabels GPU ${r.k15.relabelsGpu} vs reference ${r.k15.relabelsRef} (> 0), particles left in AIR cells ${r.k15.particlesInAirCells} (> 0: both branches exercised)`)
    gate.check(r.k16.facePhiRatio <= 1 && r.k16.coefRatio <= 1 && r.k16.aDiffRel <= 1e-6 && r.k16.faces > 0, `K16 ghostCoef ${c.label} (${r.k16.faces} liquid–air faces): face φ |Δ|/bound ${r.k16.facePhiRatio.toFixed(3)}, extra diagonal |Δ|/(1e-5·(extra + a)) ${r.k16.coefRatio.toFixed(3)} (max extra ${(r.k16.extraMax / r.k16.a).toFixed(1)}·a), a rel ${r.k16.aDiffRel.toExponential(1)}; θ vs reference end to end ${r.k16.thetaDiff.toExponential(2)}`)
    gate.check(r.k17.bulkDiff <= 1e-5 * r.k17.uRef && r.k17.surfRatio <= 1 && r.k17.validMismatch === 0 && r.k17.surfFaces > 0, `K17 project ghost ${c.label} (air p poisoned): non-surface |Δu| ${r.k17.bulkDiff.toExponential(2)} m/s (≤ ${(1e-5 * r.k17.uRef).toExponential(2)}); ${r.k17.surfFaces} liquid–air faces |Δu|/bound ${r.k17.surfRatio.toFixed(3)} (≤ 1), vs reference end to end ${r.k17.surfEndToEnd.toExponential(2)} m/s; set/unset mismatches ${r.k17.validMismatch}`)
  }

  report.s34a = []
  for (const ppc of [8, 4]) {
    const r = await run('flatSurface', { ppc })
    report.s34a.push(r)
    gate.check(Math.abs(r.bias) <= 0.1 && r.holes === 0, `S34a on the GPU, ${ppc} ppc jittered lattice (${r.particles} particles, ${r.columns} columns): bias ${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(4)} dx (|bias| ≤ 0.1), spread ±${r.spread.toFixed(3)} dx, interior non-LIQUID cells ${r.holes}`)
  }

  if (!QUICK) {
    const g1 = await run('hydrostatic')
    report.g1c = g1
    const off = g1.pFloor - g1.expect
    gate.check(Math.abs(off) <= RHO * G * 0.2 * DX && g1.breakdowns === 0, `G1c on the GPU after 3 s: floor p ${g1.pFloor.toFixed(0)} Pa vs ρg·h_true ${g1.expect.toFixed(0)} Pa: offset ${off.toFixed(1)} Pa (≤ ${(RHO * G * 0.2 * DX).toFixed(0)}); p cap hits ${g1.capHits}, ψ cap hits ${g1.psiCapHits}`)

    const w28 = await run('standingWave', { cellsPerH: 28 }), w14 = await run('standingWave', { cellsPerH: 14 })
    const e28 = Math.abs(fitOmega(w28.ts, w28.es, w28.omega) / w28.omega - 1), e14 = Math.abs(fitOmega(w14.ts, w14.es, w14.omega) / w14.omega - 1)
    const n28 = nuNum(w28.ts, w28.es, w28.omega, w28.k), n14 = nuNum(w14.ts, w14.es, w14.omega, w14.k)
    report.d1 = { e28, e14, particles: w28.particles, capHits: [w28.capHits, w14.capHits], psiCapHits: [w28.psiCapHits, w14.psiCapHits] }
    report.d2 = { nu28: n28.nu, nu14: n14.nu, peaks: n28.peaks }
    gate.check(e28 <= 0.03 && e28 < e14 && w28.breakdowns + w14.breakdowns === 0, `D1 on the GPU: E_K period error ${(100 * e28).toFixed(2)} % at H/dx = 28 (≤ 3 %, ${w28.particles} particles), ${(100 * e14).toFixed(2)} % at H/dx = 14 (must be larger)`)
    gate.check(n28.nu <= 1.1e-4, `D2 on the GPU: ν_num ${n28.nu.toExponential(2)} m²/s at H/dx = 28 from ${n28.peaks} E_K peaks (≤ 1.1e-4); H/dx = 14: ${n14.nu.toExponential(2)}${n28.nu <= 1.1e-4 ? '' : ` — FINAL-PLAN consequence: glycerol-level viscosity unresolvable at dx = ${(100 * DX).toFixed(2)} cm; remedy is resolution, never tuning`}`)

    const r1 = await run('column', { aCells: 12, n2: 2, h: DX, nx: 128, tauEnd: 3.33 / Math.SQRT2 + 0.1 })
    const s1 = columnScore(r1, MM2, MM2H, [1.43, 3.33])
    report.a1 = { s1, capHits: r1.capHits, psiCapHits: r1.psiCapHits, breakdowns: r1.breakdowns }
    // s34-ref's time-origin revision (its header): the no-shift RMS vs MM is reported; the shape after the best shift is gated
    gate.check(s1.bestRms <= 0.10 && Math.abs(s1.bestShift) <= 0.3 && s1.slope >= 1.19 && s1.slope <= 1.74 && s1.dH <= 0.05 && r1.breakdowns === 0,
      `A1 on the GPU, n² = 2, a = 12 cells (${r1.particles} particles): after the best shift ΔT ${s1.bestShift.toFixed(2)} (|ΔT| ≤ 0.3) RMS Z error ${(100 * s1.bestRms).toFixed(2)} % over ${s1.points} points (≤ 10 %); no-shift RMS ${(100 * s1.rmsZ).toFixed(2)} % [reported: MM's time origin is unverified]; dZ/dT ${s1.slope.toFixed(3)} (1.19–1.74), max |ΔH| ${s1.dH.toFixed(3)} (≤ 0.05)`)
    const aP = 8 * DX, cr = []
    for (const c of [8, 12, 16]) cr.push(await run('column', { aCells: c, n2: 2, h: aP / c, nx: 2 * Math.ceil(2.75 * c), tauEnd: 3.33 / Math.SQRT2 + 0.1 }))
    const conv = selfConvergence(cr)
    report.a1c = conv
    gate.check(conv.e2 <= conv.e1, `A1c on the GPU, one column a = ${aP.toFixed(3)} m at 8/12/16 cells: RMS|Z12 − Z8| ${conv.e1.toFixed(4)}, RMS|Z16 − Z12| ${conv.e2.toFixed(4)} (must shrink)`)
    console.log(`  [info] A1 residuals (T:%) ${s1.resid}`)
    const r2 = await run('column', { aCells: 12, n2: 1, h: 0.05, nx: 72, tauEnd: 3.5 }), s2 = columnScore(r2, MM1, MM1H, [1, 3.3])
    report.a2 = { s2, capHits: r2.capHits, psiCapHits: r2.psiCapHits, breakdowns: r2.breakdowns }
    gate.check(s2.bestRms <= 0.10 && Math.abs(s2.bestShift) <= 0.3 && s2.slope >= 0.9 * 1.40 && s2.slope <= 1.74 && s2.dH <= 0.05 && r2.breakdowns === 0,
      `A2 front on the GPU, n² = 1, a = H = 0.6 m (${r2.particles} particles): vs MM after the best shift ΔT ${s2.bestShift.toFixed(2)} (|ΔT| ≤ 0.3) RMS Z error ${(100 * s2.bestRms).toFixed(2)} % over ${s2.points} points (≤ 10 %); no-shift RMS ${(100 * s2.rmsZ).toFixed(2)} % [reported: MM's time origin is unverified; the no-shift test is s34-ref's A2g, CPU-only — the GPU solver has no moving gate]; dZ/dT ${s2.slope.toFixed(3)} (1.26–1.74; MM 1.400), max |ΔH| ${s2.dH.toFixed(3)} (≤ 0.05)`)
    console.log(`  [info] A2 residuals (T:%) ${s2.resid}`)
    const ri = await run('column', { aCells: 12, n2: 1, h: 0.05, nx: 32, tauEnd: 6, wall: true })
    const imp = impulse(ri.ts, ri.wallP)
    report.a2impulse = { ...imp, dt: ri.dt }
    gate.check(imp.I >= 0.5 * LOBOVSKY_I600 && imp.I <= 2 * LOBOVSKY_I600 && ri.breakdowns === 0, `A2 impulse on the GPU, Lobovský tank (32 cells): I ${(imp.I / 100).toFixed(2)} mbar·s (within [0.5, 2] × 12.74); peak ${(imp.peak / 100).toFixed(1)} mbar at t = ${imp.tPeak.toFixed(3)} s, rise ${(1000 * imp.rise).toFixed(1)} ms, decay ${(1000 * imp.decay).toFixed(1)} ms (Lobovský medians 185.69 mbar, 7 ms, 104 ms)`)
    const v1 = await run('violentColumn', { ghost: true, seconds: 6 })
    report.v1 = v1
    const v1w = Math.max(...v1.series.map(v => Math.abs(v - 1)))
    gate.check(v1w <= 0.02 && v1.breakdowns === 0 && v1.firstNonFinite < 0, `V1 on the GPU, violent confined column (8×36 cells in 16×40×8, ghost surface): φ-volume/N·V_p every second ${v1.series.map(v => v.toFixed(4)).join(' ')} — max |Δ| ${(100 * v1w).toFixed(2)} % (≤ 2 %); p caps ${v1.capHits}, ψ caps ${v1.psiCapHits}, breakdowns ${v1.breakdowns}; non-finite particles ${v1.firstNonFinite < 0 ? 'none' : `from substep ${v1.firstNonFinite}`}; unresolved-cell relabels ${v1.relabels}`)
    const g2 = await run('doubleDamBreak', { density: true, ghost: true })
    report.g2ghost = { ...g2, series: undefined }
    gate.check(Math.abs(g2.endOverNVp - 1) <= 0.02 && g2.breakdowns === 0, `G2 again with the ghost-fluid surface, double dam break 30 s (${g2.particles} particles): φ-volume / N·V_p = ${g2.endOverNVp.toFixed(4)} (${(100 * (g2.endOverNVp - 1)).toFixed(3)} %, ≤ 2 %); p caps ${g2.capHits}/${g2.solves}, ψ caps ${g2.psiCapHits}/${g2.psiSolves}`)
  }

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's34-gpu', pass, report, gate.results)
exitGate(pass ? 0 : 1)
