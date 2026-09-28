#!/usr/bin/env node
// Gate S3.0 + S3.1a on the GPU — the APIC-MAC kernels against the f64 CPU reference, then the S3.1a physics gates on
// the GPU path (FINAL-PLAN §7). Opens flip-selftest.html in headed Chrome on the NVIDIA dGPU; the page requests a
// device with DEFAULT limits (the app's three.js device has 8 storage buffers per stage).
//
//   node scripts/fluid-gates/s31a-gpu.mjs          (default server: the clean gate tree, FLUID_BASE to override)
//
// Tolerances (fixed before the first run):
//  K1 faceScatter  |mass − ref|, |mom − ref| ≤ max(1e-5·max|ref|, (adds/2 + 1) quanta)  — quanta 2^-24 / 2^-19
//  K2 gridUpdate   |u − ref| ≤ 1e-5·max|ref|; set/unset identical                    (ref ran on the GPU's own sums)
//  K3 extrapolate  |u − ref| ≤ 1e-5·max|ref|; set/unset identical                    (same f32 inputs)
//  K4 g2pMac+RK2   |v − ref| ≤ 1e-5·max|v|, |c − ref| ≤ 1e-5·max|c|, |x − ref| ≤ 1e-5·window; wall-clamp counts equal
//  K5 present      legacy layout = pos/lRef, v·τ/lRef to 1e-6 absolute; id, phase, temperature exact
//  each at 16³ (ring 0) and 64³ (all padded slots, ring (5,11,3)), plus 24×16×12 and a PIC run.
//  P1 linear field (dt = 0): v and c to 1e-5 relative   P1c PIC control: error > 1e-3
//  P2 rigid rotation: |ΔL|/|L| ≤ 1e-5                     P2c PIC control: > 1e-3
//  P3 ballistic: g_fit ±0.5 %; error ratio 0.45–0.55 when Δt halves; GPU COM within 1e-5·window of the reference path
//  P4 ring (3,5,7) bit-identical to ring 0 (fixed-point atomics make P2G order-independent)
//  and: 0 uncaptured WebGPU errors, 0 console errors.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { loadTsModules } from './lib/loadTs.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.0/S3.1a (APIC-MAC kernels + transfer physics on the GPU)')
const report = { prov: await provenance() }
const G = 9.80665

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
  report.adapter = init.info
  if (init.info.vendor !== 'nvidia') throw new Error(`adapter is ${init.info.vendor}, not the NVIDIA dGPU`)
  const run = (t, p) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])
  const noGpuErrors = r => r.gpuErrors.length === 0

  // ── kernel parity ──
  const cases = [
    { label: '16³', n: [16, 16, 16], ring: [0, 0, 0] },
    { label: '64³ ring(5,11,3)', n: [64, 64, 64], ring: [5, 11, 3] },
    { label: '24×16×12 ring(7,2,9)', n: [24, 16, 12], ring: [7, 2, 9] },
    { label: '16³ PIC', n: [16, 16, 16], ring: [0, 0, 0], apic: false },
    { label: '16³ one-word P2G', n: [16, 16, 16], ring: [0, 0, 0], precise: false },
  ]
  report.kernels = {}
  for (const c of cases) {
    const r = await run('kernels', c)
    report.kernels[c.label] = r
    const k1 = r.k1, k2 = r.k2, k3 = r.k3, k4 = r.k4, k5 = r.k5
    gate.check(k1.massExcessQuanta <= k1.massRelTolQuanta && k1.momExcessQuanta <= k1.momRelTolQuanta && noGpuErrors(r),
      `K1 faceScatter ${c.label} (${r.particles} particles, ≤ ${k1.maxAdds} adds/face): excess over the quantisation bound mass ${k1.massExcessQuanta.toFixed(2)} q (allowed ${k1.massRelTolQuanta.toFixed(1)}), momentum ${k1.momExcessQuanta.toFixed(2)} q (allowed ${k1.momRelTolQuanta.toFixed(1)})`)
    gate.check(k2.uDiff <= 1e-5 * k2.uRef && k2.validMismatch === 0, `K2 gridUpdate ${c.label}: max |Δu| ${k2.uDiff.toExponential(2)} m/s (≤ ${(1e-5 * k2.uRef).toExponential(2)}), set/unset mismatches ${k2.validMismatch}`)
    gate.check(k3.uDiff <= 1e-5 * k3.uRef && k3.validMismatch === 0, `K3 extrapolate ${c.label}: max |Δu| ${k3.uDiff.toExponential(2)} m/s (≤ ${(1e-5 * k3.uRef).toExponential(2)}), set/unset mismatches ${k3.validMismatch}`)
    gate.check(k4.velDiff <= 1e-5 * k4.velRef && k4.cDiff <= 1e-5 * k4.cRef && k4.posDiff <= 1e-5 * k4.extent && k4.wallClamps.gpu === k4.wallClamps.cpu && (k4.unsetReads.gpu === 0) === (k4.unsetReads.cpu === 0),
      `K4 g2pMac+RK2 ${c.label}: |Δv| ${k4.velDiff.toExponential(2)} (≤ ${(1e-5 * k4.velRef).toExponential(2)}), |Δc| ${k4.cDiff.toExponential(2)} (≤ ${(1e-5 * k4.cRef).toExponential(2)}), |Δx| ${k4.posDiff.toExponential(2)} m (≤ ${(1e-5 * k4.extent).toExponential(2)}); max step ${(k4.maxDisplacement * 1000).toFixed(2)} mm; wall clamps GPU ${k4.wallClamps.gpu} / ref ${k4.wallClamps.cpu}; unset reads ${k4.unsetReads.gpu} / ${k4.unsetReads.cpu}`)
    gate.check(k5.maxAbsErr <= 1e-6 && k5.idOrPhaseOrTempErrors === 0, `K5 present ${c.label}: legacy layout max error ${k5.maxAbsErr.toExponential(2)}, id/phase/temperature errors ${k5.idOrPhaseOrTempErrors}`)
  }

  // ── physics on the GPU path ──
  const lf = await run('linearField', {})
  const lfNc = await run('linearField', { n: [24, 16, 12], ring: [5, 2, 9], seed: 55 })
  const lfPic = await run('linearField', { apic: false })
  report.linearField = { lf, lfNc, lfPic }
  gate.check(lf.ev <= 1e-5 && lf.ec <= 1e-5 && lf.unset === 0 && noGpuErrors(lf), `P1 linear field 16³ on the GPU, ${lf.interior} interior of ${lf.particles} particles: max rel error v ${lf.ev.toExponential(2)}, c ${lf.ec.toExponential(2)} (≤ 1e-5); edge particles [reported] v ${lf.evEdge.toExponential(2)}, c ${lf.ecEdge.toExponential(2)}`)
  gate.check(lfNc.ev <= 1e-5 && lfNc.ec <= 1e-5 && lfNc.unset === 0, `P1 linear field 24×16×12 ring (5,2,9), ${lfNc.interior} interior: v ${lfNc.ev.toExponential(2)}, c ${lfNc.ec.toExponential(2)} (≤ 1e-5); edge [reported] v ${lfNc.evEdge.toExponential(2)}, c ${lfNc.ecEdge.toExponential(2)}`)
  gate.check(lfPic.ev > 1e-3, `P1c positive control, PIC on the GPU: v error ${lfPic.ev.toExponential(2)} (> 1e-3)`)
  const rot = await run('rotation', {}), rotPic = await run('rotation', { apic: false })
  report.rotation = { rot, rotPic }
  gate.check(rot.rel <= 1e-5, `P2 rigid rotation on the GPU: |ΔL|/|L| ${rot.rel.toExponential(2)} (≤ 1e-5)`)
  gate.check(rotPic.rel > 1e-3, `P2c positive control, PIC: |ΔL|/|L| ${rotPic.rel.toExponential(2)} (> 1e-3)`)

  const a = await run('ballistic', { dt: 1 / 120 }), b = await run('ballistic', { dt: 1 / 240 }), rr = await run('ballistic', { dt: 1 / 120, ring: [3, 5, 7] })
  const fit = (ts, ys) => {
    const S = k => ts.reduce((s, t) => s + t ** k, 0), Ty = k => ts.reduce((s, t, i) => s + ys[i] * t ** k, 0)
    const M = [[S(0), S(1), S(2)], [S(1), S(2), S(3)], [S(2), S(3), S(4)]], r = [Ty(0), Ty(1), Ty(2)]
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    return [0, 1, 2].map(j => det(M.map((row, i) => row.map((v, k) => (k === j ? r[i] : v))))) .map(v => v / det(M))
  }
  const T = 0.2, v0 = [1.2, 2.5, -0.7]
  const gFit = -2 * fit(a.ts, a.cs.map(c => c[1]))[2]
  const err = run_ => { const c0 = run_.cs[0], cN = run_.cs.at(-1); return Math.hypot(cN[0] - c0[0] - v0[0] * T, cN[1] - c0[1] - (v0[1] * T - 0.5 * G * T * T), cN[2] - c0[2] - v0[2] * T) }
  const eA = err(a), eB = err(b)
  gate.check(Math.abs(gFit - G) / G <= 0.005 && a.wallClamps === 0 && a.unset === 0, `P3 ballistic on the GPU, Δt 1/120 × ${a.steps}: g_fit ${gFit.toFixed(5)} m/s² (±0.5 %); wall clamps ${a.wallClamps}; unset reads ${a.unset}`)
  gate.check(eB / eA >= 0.45 && eB / eA <= 0.55, `P3 first order on the GPU: error ${(eA * 1e3).toFixed(3)} → ${(eB * 1e3).toFixed(3)} mm, ratio ${(eB / eA).toFixed(4)} (0.45–0.55)`)
  // the same trajectory on the CPU reference
  const { gridLayout, flipRef } = await loadTsModules({ gridLayout: 'src/sim-ref/gridLayout.ts', flipRef: 'src/sim-ref/flipRef.ts' })
  const refPath = (() => {
    // rebuild exactly the page's blob (same PRNG, f32-rounded inputs)
    const mulberry32 = seed => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
    const DX = 3.63 / 64, rng = mulberry32(33), pts = []
    for (let k = 13; k <= 18; k++) for (let j = 8; j <= 13; j++) for (let i = 10; i <= 15; i++) for (let s = 0; s < 8; s++)
      pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX].map(Math.fround))
    const p = flipRef.makeParticles(pts.length)
    pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = Math.fround(998.2072 * DX ** 3 / 8); p.vel.set(v0.map(Math.fround), 3 * q) })
    const sim = new flipRef.FlipRef(new gridLayout.GridLayout({ nx: 32, ny: 32, nz: 32, dx: DX }), { gravity: [0, -G, 0] })
    for (let s = 0; s < 24; s++) sim.step(p, 1 / 120)
    return flipRef.centreOfMass(p)
  })()
  const cN = a.cs.at(-1), dRef = Math.hypot(cN[0] - refPath[0], cN[1] - refPath[1], cN[2] - refPath[2])
  gate.check(dRef <= 1e-5 * 32 * 3.63 / 64, `P3 GPU vs CPU reference after 24 steps: COM differs by ${(dRef * 1e6).toFixed(3)} µm (≤ ${(1e-5 * 32 * 3.63 / 64 * 1e6).toFixed(1)} µm = 1e-5·window)`)
  let same = rr.finalPos.length === a.finalPos.length
  for (let i = 0; same && i < a.finalPos.length; i++) same = Object.is(rr.finalPos[i], a.finalPos[i])
  gate.check(same, `P4 ring (3,5,7) vs ring 0 on the GPU after ${a.steps} steps: particle positions bit-identical`)
  report.ballistic = { gFit, eA, eB, ratio: eB / eA, dRef }

  const cost = await run('p2gCost', {})
  report.p2gCost = cost
  console.log(`  [reported] P2G cost at ${cost.particles} particles, 64³: one-word ${cost.oneWordMs.toFixed(3)} ms, two-word ${cost.twoWordMs.toFixed(3)} ms per scatter (busy dev machine)`)
  const lf1 = await run('linearField', { precise: false })
  report.linearFieldOneWord = lf1
  console.log(`  [reported] one-word P2G linear field: interior v ${lf1.ev.toExponential(2)}, c ${lf1.ec.toExponential(2)}`)

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's31a-gpu', pass, report, gate.results)
process.exit(pass ? 0 : 1)
