#!/usr/bin/env node
// Gate S3.1c-2 on the GPU — the drop ball as a moving solid (Batty, Bertails & Bridson 2007), FINAL-PLAN S3.1c.
//
//   node scripts/fluid-gates/s31c2-gpu.mjs [--solver=mgpcg]   (default server: the clean gate tree; FLUID_BASE to override)
//
// Kernel parity on the reference's exact inputs (src/bench/flipSelftest/sphere.ts; bounds derived there, fixed before
// the first run), on 16³, 64³ ring(5,11,3) and 24×16×12 ring(7,2,9):
// K21 solid fractions of faces, cells and the cell kernel volume vs flipRef.sphereFractions (≤ 1 × the f32 bound).
// K22 labels with the liquid extended into the ball (0 mismatches outside φ's sample bound) and the weighted operator
//     coefficients a·w and ghost extra diagonal (≤ 1 × bound).
// K23 divergence with the ball's flux (1 − S)u* + S·V (≤ 1 × bound); 0 unset divergence faces on both sides.
// K24 projection with unweighted coefficients (≤ 1 × bound), faces with S ≥ 1 carrying exactly V, the force J·p and V_J
//     vs the reference on the same pressure (≤ 1 × the fixed-point bound).
// K25 the density right-hand side with the ball's kernel volume (≤ 1 × bound).
// K25w the ψ operator's face weights w = max(0, 1 − S_f) (psiCoef): bitwise against the kernel's own f32 formula from
//     the GPU's faceSolid, ≤ 1 × (K21's bound + one rounding) against the reference operator's 1 − S_f, ≥ 1 partly solid
//     face. Added 2026-09-30 before its first run: the mutant "ψ operator without the fluid-fraction weights" had only
//     been scored caught by crashing, and survived every check once it ran (gpu-mutations INVALID rule, 089f90df).
// Physics at the page's production settings (MGPCG cap 18, tolerances 1e-2 / 1e-3, variable density), the s31c2-ref
// scenes and criteria:
// AR / ST fixed sphere in a still pool, 2 s: F_y / ρgV_J ±1 %, / ρg(4/3)πR³ ±3 %, |F_x|, |F_z| ≤ 1 % F_y; RMS speed
//     ≤ 1 % √(gH).
// MV scripted sphere at 0.3 m/s for 1 s: 0 particles inside after any substep; φ-volume ±1 %; the projected flux
//     divergence ≤ the production solver's own tolerance (the reference's 1e-3 was set for its 1e-6 solve — here the
//     check is that the ball's flux terms in divergence and projection agree, which a defect breaks by O(1)).
// WK steel ball ρ_s 7850 from rest: mean acceleration on [0.05, 0.20] s within 5 % of g(ρ_s − ρ)/(ρ_s + ½ρ).
// FS iron ball (NIST SRD 126) dropped 3·dx onto the pool, 2 s: 0 inside; φ-volume ±2 % every 0.1 s; energy minus the
//     density projection's ΣΔE_P never above E(0) by more than 2 %; resting on the floor for the last 0.5 s and never
//     below it (centre − R ≥ −1e-6 m: non-penetration).
// Every physics scene: pressure and ψ cap hits ≤ 1 % of solves (S3.5 G5's production bound), 0 breakdowns.
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.1c-2 (the drop ball as a moving solid on the GPU)')
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
    const r = await run('sphereKernels', c)
    report.kernels[c.label] = r
    const f = x => x.toFixed(3)
    gate.check(r.k21.faceRatio <= 1 && r.k21.cellRatio <= 1 && r.k21.kernelRatio <= 1 && r.k21.solidFaces > 0 && r.k21.fullFaces > 0,
      `K21 sphereFaces/sphereCells ${c.label}: |ΔS|/bound faces ${f(r.k21.faceRatio)}, cells ${f(r.k21.cellRatio)}, kernel volume ${f(r.k21.kernelRatio)} (≤ 1; bound ${r.k21.eps.toExponential(2)}); ${r.k21.solidFaces} partly and ${r.k21.fullFaces} fully solid faces`)
    gate.check(r.k22.labelMismatch === 0 && r.k22.extended > 0 && r.k22.aRatio <= 1 && r.k22.extraRatio <= 1 && r.k22.weightedFaces > 0,
      `K22 labels + sphereExtend + sphereCoef ${c.label}: label mismatches ${r.k22.labelMismatch} (+${r.k22.nearZero} inside φ's bound), ${r.k22.extended} cells extended into the ball; a·w |Δ|/bound ${f(r.k22.aRatio)}, extra diagonal ${f(r.k22.extraRatio)} (≤ 1) over ${r.k22.weightedFaces} weighted faces`)
    gate.check(r.k23.divRatio <= 1 && r.k23.rows > 0 && r.diag.unsetDivergenceFaces === 0 && r.diag.unsetDivergenceFacesRef === 0,
      `K23 divergence with the ball's flux ${c.label}: |Δb|/bound ${f(r.k23.divRatio)} over ${r.k23.rows} rows (≤ 1); unset divergence faces GPU ${r.diag.unsetDivergenceFaces}, reference ${r.diag.unsetDivergenceFacesRef} (0)`)
    gate.check(r.k24.bulkRatio <= 1 && r.k24.fullDiff === 0 && r.k24.fullCount > 0 && r.k24.forceRatio <= 1 && r.k24.volumeRatio <= 1,
      `K24 project + sphereFaceVel + sphereForce ${c.label}: bulk |Δu|/bound ${f(r.k24.bulkRatio)}; ${r.k24.fullCount} faces with S ≥ 1 carry V (max |Δ| ${r.k24.fullDiff}); F = (${r.k24.force.map(v => v.toFixed(2)).join(', ')}) N vs (${r.k24.forceRef.map(v => v.toFixed(2)).join(', ')}), |ΔF|/bound ${f(r.k24.forceRatio)}; V_J |Δ|/bound ${f(r.k24.volumeRatio)} (≤ 1)`)
    gate.check(r.k25.fRatio <= 1 && r.k25.bRatio <= 1 && r.k25.ballRows > 0,
      `K25 densityRhs with the ball ${c.label}: |Δf̃|/bound ${f(r.k25.fRatio)}, |Δb|/bound ${f(r.k25.bRatio)} over ${r.k25.rows} rows, ${r.k25.ballRows} touched by the ball (≤ 1)`)
    gate.check(r.k25w.cutFaces > 0 && r.k25w.wMismatch === 0 && r.k25w.refRatio <= 1,
      `K25w psiCoef ${c.label}: ${r.k25w.wMismatch} weights off the kernel's f32 formula (0); |Δw| vs the reference operator / bound ${f(r.k25w.refRatio)} (≤ 1); ${r.k25w.cutFaces} partly solid faces (≥ 1)`)
  }

  const caps = s => s.capHits <= 0.01 * s.solves && (s.psiCapHits ?? 0) <= 0.01 * (s.psiSolves ?? s.solves) && (s.breakdowns ?? 0) === 0
  const ar = await run('spherePhysics', { test: 'AR' })
  report.ar = ar
  const wantJ = RHO * G * ar.volumeJ, wantA = RHO * G * ar.sphereVolume, H = 18 * DX
  gate.check(Math.abs(ar.force[1] / wantJ - 1) <= 0.01 && Math.abs(ar.force[1] / wantA - 1) <= 0.03 && Math.abs(ar.force[0]) <= 0.01 * ar.force[1] && Math.abs(ar.force[2]) <= 0.01 * ar.force[1] && caps(ar),
    `AR on the GPU after 2 s (${ar.particles} particles): F = (${ar.force.map(v => v.toFixed(2)).join(', ')}) N; F_y / ρgV_J ${(ar.force[1] / wantJ).toFixed(4)} (±1 %), / ρg(4/3)πR³ ${(ar.force[1] / wantA).toFixed(4)} (±3 %); cap hits ${ar.capHits}/${ar.solves}`)
  gate.check(ar.rms <= 0.01 * Math.sqrt(G * H), `ST on the GPU: RMS speed ${ar.rms.toExponential(2)} m/s (≤ ${(0.01 * Math.sqrt(G * H)).toExponential(2)}); push-outs ${ar.pushOuts}`)
  const mv = await run('spherePhysics', { test: 'MV' })
  report.mv = mv
  gate.check(mv.inside === 0 && Math.abs(mv.volume - 1) <= 0.01 && mv.maxFluxDivergence <= mv.tolerance && caps(mv),
    `MV on the GPU, scripted sphere at 0.3 m/s for 1 s: particles inside after a substep ${mv.inside} (0); φ-volume ${mv.volume.toFixed(4)}·N·V_p (±1 %); max |∇·((1−S)u + S·V)| ${mv.maxFluxDivergence.toExponential(2)} 1/s (≤ the solver tolerance ${mv.tolerance}); cap hits ${mv.capHits}/${mv.solves}`)
  const wk = await run('spherePhysics', { test: 'WK' })
  const idx = wk.ts.map((t, i) => i).filter(i => wk.ts[i] >= 0.05)
  const tm = idx.reduce((q, i) => q + wk.ts[i], 0) / idx.length, vm = idx.reduce((q, i) => q + wk.vy[i], 0) / idx.length
  let sxy = 0, sxx = 0
  for (const i of idx) { sxy += (wk.ts[i] - tm) * (wk.vy[i] - vm); sxx += (wk.ts[i] - tm) ** 2 }
  const aMeas = -sxy / sxx, aTrue = G * (7850 - RHO) / (7850 + 0.5 * RHO), a1 = -wk.vy[0] / (1 / 120)
  report.wk = { aMeas, aTrue, a1, capHits: wk.capHits, solves: wk.solves }
  gate.check(Math.abs(aMeas / aTrue - 1) <= 0.05 && caps(wk),
    `WK on the GPU, ρ_s 7850 from rest: mean acceleration on [0.05, 0.20] s ${aMeas.toFixed(3)} m/s² vs potential-flow ${aTrue.toFixed(3)} (±5 %); first substep ${a1.toFixed(3)} (buoyancy only ${(G * (7850 - RHO) / 7850).toFixed(3)}); cap hits ${wk.capHits}/${wk.solves}`)
  const fs = await run('spherePhysics', { test: 'FS' })
  report.fs = fs
  gate.check(fs.inside === 0 && fs.worstVol <= 0.02 && fs.maxRise <= 0.02 && fs.restOk && Number.isFinite(fs.tFloor) && fs.minClearance >= -1e-6 && caps(fs),
    `FS on the GPU, iron ball (ρ_s ${fs.rhoIron}) dropped 3·dx onto the pool, 2 s (${fs.particles} particles): inside ${fs.inside} (0); max |φ-volume/N·V_p − 1| ${(100 * fs.worstVol).toFixed(2)} % (≤ 2 %); energy (minus density ΣΔE_P) max rise ${(100 * fs.maxRise).toFixed(3)} % (≤ 2 %); on the floor from ${fs.tFloor.toFixed(3)} s, resting: ${fs.restOk}, never into it (min clearance ${fs.minClearance.toExponential(1)} m ≥ −1e-6); cap hits ${fs.capHits}/${fs.solves}, ψ ${fs.psiCapHits}/${fs.psiSolves}, breakdowns ${fs.breakdowns}; peak ball speed ${fs.vMax.toFixed(2)} m/s, particle ${fs.maxParticleSpeed.toFixed(2)} m/s`)

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's31c2-gpu', pass, report, gate.results)
exitGate(pass ? 0 : 1)
