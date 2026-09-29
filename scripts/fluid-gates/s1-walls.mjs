#!/usr/bin/env node
// Gate S1.4 — separating walls (no sticking, no wall force), on the owner's FLUID TEST page.
//
//   node scripts/fluid-gates/s1-walls.mjs [--seconds=60]
//
// W0 POSITIVE CONTROL for the clamp counter: a block thrown at a wall at 20 m/s must register
//    safety-clamp hits (> 0, integer) — otherwise a dead counter would pass W1 forever.
// W1 60 s dam break: the safety clamp fires on ≤ 0.1% of particle-substeps.
// W2 mechanical energy never grows: sampled every 2 frames for the first 5 s (impact) and every
//    second after; least-squares trend over every 10 s window ≤ 0, and no rise E(t2) − E(t1)
//    (t2 > t1) above 2% of E(0). Energy = translational KE + APIC affine KE (½·m·(Δx²/4)·|C|²_F for
//    quadratic B-splines, Jiang et al. 2015) + gravitational PE (datum: tank floor) + the EOS's stored
//    elastic energy e(ρ) = ∫_{ρ0}^{ρ} p/ρ'² dρ' = k[(ρ^{γ−1} − ρ0^{γ−1})/((γ−1)ρ0^γ) + 1/ρ − 1/ρ0]
//    (p = k((ρ/ρ0)^γ − 1)⁺, k = 3, γ = 5, ρ0 = 4, code units; densities recomputed with the shaders'
//    own quadratic B-spline P2G/gather). Leaving the elastic term out would flag the physical
//    kinetic↔elastic exchange of a compressible EOS as an energy violation.
// W3 every sample finite; front position defined.
// W4 SEPARATION (the property the gate is named for): settle a pool 2 s (its bottom layer sinks
//    into the wall band), then flip gravity upward. With separating walls the whole pool must leave
//    the floor: 0.35 s later NO particle is within 0.10 m of the floor, and the centre of mass has
//    accelerated upward at 9.81 ± 5% (3-parameter fit over the first 0.25 s). A sticky wall (both
//    signs of the normal velocity zeroed in the band) would hold the band layer on the floor.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, makeGate, writeReport, fitQuadratic, centreOfMass, unitToTankM, DOMAIN_L_M, TAU_S, G_STANDARD, TANK_INNER_M, FLUID_TEST_URL_MPM } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let SECONDS = 60
for (const a of process.argv.slice(2)) { const m = /^--seconds=(\d+)$/.exec(a); if (m) SECONDS = Number(m[1]) }

const G = 64
const DX = DOMAIN_L_M / G
const G_CODE = G_STANDARD * TAU_S * TAU_S / DX     // cells/τ² (units.ts accelToCode)
const K = 3, GAMMA = 5, RHO0 = 4
const FLOOR_CELLS = 3                              // tank floor = wall band edge (3/64)
const eEl = rho => rho <= RHO0 ? 0 : K * ((rho ** (GAMMA - 1) - RHO0 ** (GAMMA - 1)) / ((GAMMA - 1) * RHO0 ** GAMMA) + 1 / rho - 1 / RHO0)
const water = { name: 'water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }

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
  let ke = 0, keAff = 0, pe = 0, el = 0, maxX = -Infinity
  for (let p = 0; p < n; p++) {
    const bx = base[3 * p], by = base[3 * p + 1], bz = base[3 * p + 2]
    let rho = 0
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      rho += wts[9 * p + i] * wts[9 * p + 3 + j] * wts[9 * p + 6 + k] * mass[idx(bx + i, by + j, bz + k)]
    }
    const vx = s.vel[3 * p] * G, vy = s.vel[3 * p + 1] * G, vz = s.vel[3 * p + 2] * G   // cells/τ
    ke += 0.5 * (vx * vx + vy * vy + vz * vz)
    if (s.aff) { let c2 = 0; for (let c = 0; c < 9; c++) c2 += s.aff[9 * p + c] ** 2; keAff += c2 / 8 }   // ½·(Δx²/4)·|C|², Δx = 1 cell
    pe += G_CODE * (s.pos[3 * p + 1] * G - FLOOR_CELLS)
    el += eEl(rho)
    if (s.pos[3 * p] > maxX) maxX = s.pos[3 * p]
  }
  return { ke, keAff, pe, el, total: ke + keAff + pe + el, mech: ke + pe, bad, frontX: maxX }
}

const slope = (ts, ys) => {
  const n = ts.length, mt = ts.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
  return ts.reduce((a, t, i) => a + (t - mt) * (ys[i] - my), 0) / ts.reduce((a, t) => a + (t - mt) ** 2, 0)
}
const maxRise = ys => { let lo = Infinity, rise = 0; for (const y of ys) { lo = Math.min(lo, y); rise = Math.max(rise, y - lo) } return rise }

const gate = makeGate('GATE S1.4 (separating walls)')
const report = { seconds: SECONDS, samples: [] }
// MPM-only mechanics (band walls / 4-ppc packing / MPM viscosity refusals): the legacy solver, kept behind ?solver=mpm (D8)
const { browser, page, errors, adapter } = await openFluidPage(FLUID_TEST_URL_MPM)
report.adapter = adapter
const bench = (fn, arg) => page.evaluate(fn, arg)
try {
  await bench(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665 }))
  const L = TANK_INNER_M

  // W0 positive control: a block thrown at the +x wall at 20 m/s
  await loadScenario(page, { name: 'gate-clamp-control', materials: [water], spawns: [{ material: 'water', box: { min: [L - 0.8, 1.0, 1.2], max: [L - 0.3, 1.5, 1.7] }, initialVelocity: [20, 0, 0] }], gravity_mps2: 0 }, 40)
  await bench(() => window.__fluidBench.configure({ resetDiagnostics: true }))
  await sampleAtFrame(page, 30)
  const d0 = await bench(() => window.__fluidBench.diagnostics())
  report.control = d0
  gate.check(Number.isInteger(d0.clampHits) && d0.clampHits > 0, `W0 positive control (20 m/s into a wall): ${d0.clampHits} clamp hits (> 0 proves the counter is alive)`)

  // W1–W3: 60 s dam break
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, 'company/lab/survey-01-dam-break/scenario.json'), 'utf8'))
  await loadScenario(page, scenario, 41)
  await bench(() => window.__fluidBench.configure({ resetDiagnostics: true }))
  const frames = []
  for (let f = 0; f <= 300; f += 2) frames.push(f)                    // every 2 frames for 5 s
  for (let t = 6; t <= SECONDS; t++) frames.push(t * 60)              // then 1 Hz
  for (const f of frames) {
    const e = energies(await sampleAtFrame(page, f, { affine: true }))
    report.samples.push({ t: f / 60, ...e })
    if (f % 600 === 0) console.log(`  t=${f / 60}s E=${e.total.toFixed(1)} (KE ${e.ke.toFixed(1)}, affine ${e.keAff.toFixed(1)}, PE ${e.pe.toFixed(1)}, EL ${e.el.toFixed(1)})`)
  }
  const diag = await bench(() => window.__fluidBench.diagnostics())
  report.diag = diag
  const frac = diag.clampHits / diag.particleSubsteps
  gate.check(Number.isInteger(diag.clampHits) && frac <= 0.001, `W1 safety clamp: ${diag.clampHits} hits / ${diag.particleSubsteps} particle-substeps = ${(frac * 100).toFixed(5)}% (≤ 0.1%)`)

  const S = report.samples, E0 = S[0].total
  let worstSlope = -Infinity
  for (let w = 0; w + 10 <= SECONDS; w += 5) {
    const win = S.filter(x => x.t >= w && x.t <= w + 10)
    worstSlope = Math.max(worstSlope, slope(win.map(x => x.t), win.map(x => x.total)))
  }
  const rise = maxRise(S.map(x => x.total))
  report.energy = { E0, Eend: S[S.length - 1].total, worstSlopePerS: worstSlope, maxRise: rise, mechMaxRise: maxRise(S.map(x => x.mech)) }
  gate.check(worstSlope <= 0, `W2 energy trend: worst 10 s-window slope ${(worstSlope / E0 * 100).toFixed(4)}% of E0 per s (≤ 0)`)
  gate.check(rise <= 0.02 * E0, `W2 transient rise (sampled every 33 ms through the impact): max ${(rise / E0 * 100).toFixed(3)}% of E0 (≤ 2%); KE+PE-only ${(report.energy.mechMaxRise / S[0].mech * 100).toFixed(3)}% [reported]`)
  const nanSamples = S.filter(x => x.bad > 0 || !Number.isFinite(x.total) || !Number.isFinite(x.frontX)).length
  gate.check(nanSamples === 0, `W3 all ${S.length} samples finite (NaN / undefined front in ${nanSamples})`)

  // W4 separation: settle, then flip gravity
  await loadScenario(page, { name: 'gate-separation', materials: [water], spawns: [{ material: 'water', box: { min: [0.8, 0, 0.8], max: [2.5, 0.35, 2.5] } }], gravity_mps2: G_STANDARD }, 42)
  const settled = await sampleAtFrame(page, 120)
  let inBand = 0
  for (let i = 0; i < settled.n; i++) if (settled.pos[3 * i + 1] * G < FLOOR_CELLS) inBand++
  await bench(() => window.__fluidBench.configure({ gravityMs2: -9.80665 }))   // "up" gravity (test-only)
  const ts = [], ys = []
  for (let k = 0; k <= 15; k++) {
    const s = await sampleAtFrame(page, 120 + k)
    ts.push(k / 60); ys.push(centreOfMass(s).y * DOMAIN_L_M)
  }
  const fit = fitQuadratic(ts, ys)
  const s35 = await sampleAtFrame(page, 120 + 21)                    // 0.35 s after the flip
  let near = 0
  for (let i = 0; i < s35.n; i++) if (unitToTankM(s35.pos[3 * i + 1]) < 0.10) near++
  report.separation = { settledInBand: inBand, aUp: 2 * fit.c, nearFloorAt035: near, n: s35.n }
  gate.check(inBand > 0, `W4 setup: ${inBand} particles settled inside the floor's wall band (the layer a sticky wall would hold)`)
  gate.check(near === 0, `W4 pool leaves the floor: ${near} of ${s35.n} particles within 0.10 m of the floor 0.35 s after gravity flips`)
  gate.check(Math.abs(2 * fit.c - G_STANDARD) / G_STANDARD <= 0.05, `W4 upward acceleration of the pool ${(2 * fit.c).toFixed(3)} m/s² (9.81 ± 5%)`)
  await bench(() => window.__fluidBench.configure({ gravityMs2: 9.80665 }))

  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's1-walls', pass, report, gate.results)
process.exit(pass ? 0 : 1)
