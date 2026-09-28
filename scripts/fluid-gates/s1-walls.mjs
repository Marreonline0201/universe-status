#!/usr/bin/env node
// Gate S1.4 — separating walls (no sticking, no wall spring), 60 s dam-break slosh, lockstep.
//
//   node scripts/fluid-gates/s1-walls.mjs [--seconds=60]
//
// W1 the g2p safety clamp fires on ≤ 0.1% of particle-substeps (walls are the grid boundary;
//    the clamp must be a net that is essentially never needed).
// W2 mechanical energy never grows: least-squares trend over every 10 s window ≤ 0, and no rise
//    E(t2) − E(t1) (t2 > t1) exceeds 2% of E(0).
//    Energy = kinetic + gravitational (datum: tank floor) + the EOS's stored elastic energy.
//    The weakly-compressible EOS p(ρ) = k((ρ/ρ0)^γ − 1)⁺ (p2g2.wgsl, k = 3, γ = 5, ρ0 = 4, code
//    units) stores e(ρ) = ∫_{ρ0}^{ρ} p/ρ'² dρ' = k[(ρ^{γ−1} − ρ0^{γ−1})/((γ−1)ρ0^γ) + 1/ρ − 1/ρ0]
//    per unit mass when compressed; leaving it out would flag physical kinetic↔elastic exchange
//    as an energy violation. Particle density is recomputed here with the SAME quadratic B-spline
//    P2G/gather as p2g/p2g2.wgsl. KE+PE alone is reported too, for transparency.
// W3 every sample finite (no NaN), front position defined.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, makeGate, DOMAIN_L_M, TAU_S, G_STANDARD } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let SECONDS = 60
for (const a of process.argv.slice(2)) { const m = /^--seconds=(\d+)$/.exec(a); if (m) SECONDS = Number(m[1]) }

const G = 64
const DX = DOMAIN_L_M / G
const G_CODE = G_STANDARD * TAU_S * TAU_S / DX     // cells/τ² (units.ts accelToCode)
const K = 3, GAMMA = 5, RHO0 = 4
const FLOOR_CELLS = 3                              // tank floor = wall band edge (3/64)
const eEl = rho => rho <= RHO0 ? 0 : K * ((rho ** (GAMMA - 1) - RHO0 ** (GAMMA - 1)) / ((GAMMA - 1) * RHO0 ** GAMMA) + 1 / rho - 1 / RHO0)

function energies(s) {
  const n = s.n
  const mass = new Float64Array(G * G * G)
  const base = new Int32Array(3 * n), wts = new Float64Array(9 * n)
  let bad = 0
  for (let p = 0; p < n; p++) {
    for (let a = 0; a < 3; a++) {
      const x = s.pos[3 * p + a] * G
      if (!Number.isFinite(x)) { bad++; break }
      const c = Math.floor(x), d = x - (c + 0.5)
      base[3 * p + a] = c - 1
      wts[9 * p + 3 * a] = 0.5 * (0.5 - d) ** 2
      wts[9 * p + 3 * a + 1] = 0.75 - d * d
      wts[9 * p + 3 * a + 2] = 0.5 * (0.5 + d) ** 2
    }
  }
  const idx = (i, j, k) => (i * G + j) * G + k
  for (let p = 0; p < n; p++) {
    const bx = base[3 * p], by = base[3 * p + 1], bz = base[3 * p + 2]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      mass[idx(bx + i, by + j, bz + k)] += wts[9 * p + i] * wts[9 * p + 3 + j] * wts[9 * p + 6 + k]
    }
  }
  let ke = 0, pe = 0, el = 0, maxX = -Infinity
  for (let p = 0; p < n; p++) {
    const bx = base[3 * p], by = base[3 * p + 1], bz = base[3 * p + 2]
    let rho = 0
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      rho += wts[9 * p + i] * wts[9 * p + 3 + j] * wts[9 * p + 6 + k] * mass[idx(bx + i, by + j, bz + k)]
    }
    const vx = s.vel[3 * p] * G, vy = s.vel[3 * p + 1] * G, vz = s.vel[3 * p + 2] * G   // cells/τ
    ke += 0.5 * (vx * vx + vy * vy + vz * vz)
    pe += G_CODE * (s.pos[3 * p + 1] * G - FLOOR_CELLS)
    el += eEl(rho)
    if (s.pos[3 * p] > maxX) maxX = s.pos[3 * p]
  }
  return { ke, pe, el, total: ke + pe + el, mech: ke + pe, bad, frontX: maxX }
}

const slope = (ts, ys) => {
  const n = ts.length, mt = ts.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
  return ts.reduce((a, t, i) => a + (t - mt) * (ys[i] - my), 0) / ts.reduce((a, t) => a + (t - mt) ** 2, 0)
}
const maxRise = ys => { let lo = Infinity, rise = 0; for (const y of ys) { lo = Math.min(lo, y); rise = Math.max(rise, y - lo) } return rise }

const gate = makeGate('GATE S1.4 (separating walls)')
const report = { seconds: SECONDS, samples: [] }
const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665 }))
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, 'company/lab/survey-01-dam-break/scenario.json'), 'utf8'))
  await loadScenario(page, scenario, 41)
  await page.evaluate(() => window.__fluidBench.configure({ resetDiagnostics: true }))
  for (let t = 0; t <= SECONDS; t++) {
    const s = await sampleAtFrame(page, t * 60)
    const e = energies(s)
    report.samples.push({ t, ...e })
    if (t % 10 === 0) console.log(`  t=${t}s E=${e.total.toFixed(1)} (KE ${e.ke.toFixed(1)}, PE ${e.pe.toFixed(1)}, EL ${e.el.toFixed(1)}) front x ${e.frontX.toFixed(3)}`)
  }
  const diag = await page.evaluate(() => window.__fluidBench.diagnostics())
  report.diag = diag

  // W1
  const frac = diag.clampHits / diag.particleSubsteps
  gate.check(frac <= 0.001, `W1 safety clamp: ${diag.clampHits} hits / ${diag.particleSubsteps} particle-substeps = ${(frac * 100).toFixed(5)}% (≤ 0.1%)`)

  // W2
  const S = report.samples, E0 = S[0].total
  let worstSlope = -Infinity
  for (let w = 0; w + 10 <= SECONDS; w += 5) {
    const win = S.filter(x => x.t >= w && x.t <= w + 10)
    worstSlope = Math.max(worstSlope, slope(win.map(x => x.t), win.map(x => x.total)))
  }
  const rise = maxRise(S.map(x => x.total))
  report.energy = { E0, Eend: S[S.length - 1].total, worstSlopePerS: worstSlope, maxRise: rise, mechMaxRise: maxRise(S.map(x => x.mech)) }
  gate.check(worstSlope <= 0, `W2 energy trend: worst 10 s-window slope ${(worstSlope / E0 * 100).toFixed(4)}% of E0 per s (≤ 0)`)
  gate.check(rise <= 0.02 * E0, `W2 transient rise: max ${(rise / E0 * 100).toFixed(3)}% of E0 (≤ 2%); KE+PE-only rise ${(report.energy.mechMaxRise / S[0].mech * 100).toFixed(3)}% [reported]`)
  console.log(`  energy E0 ${E0.toFixed(1)} → ${S[S.length - 1].total.toFixed(1)} at ${SECONDS}s (${((1 - S[S.length - 1].total / E0) * 100).toFixed(1)}% dissipated)`)

  // W3
  const nanSamples = S.filter(x => x.bad > 0 || !Number.isFinite(x.total) || !Number.isFinite(x.frontX)).length
  gate.check(nanSamples === 0, `W3 all ${S.length} samples finite (NaN particles / undefined front in ${nanSamples})`)
  gate.check(errors.length === 0, `no unexpected console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
const out = path.join(repoRoot, 'bench-results', 'gates', `s1-walls-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ pass, ...report, checks: gate.results }, null, 2))
console.log(`→ ${path.relative(repoRoot, out)}`)
process.exit(pass ? 0 : 1)
