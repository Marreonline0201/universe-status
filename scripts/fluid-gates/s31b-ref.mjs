#!/usr/bin/env node
// Gate S3.1b on the f64 CPU reference — pressure projection with a voxel free surface (FINAL-PLAN §7 S3.1b).
// CPU only (src/sim-ref/flipRef.ts with projection on). Tolerances are the plan's, fixed before running.
//
//   node scripts/fluid-gates/s31b-ref.mjs [--quick]      (--quick skips the multi-second runs)
//
// G1a solver exactness: tank 16×64×16, water 24 cells deep, one substep solved to ‖r‖∞ ≤ 1e-5 1/s:
//     the exact discrete voxel solution p_j = ρ·g·dx·(24 − j) to ≤ 1e-3 relative [DERIVED-B].
// G1b hydrostatics after 3 s: dp/dy = −ρg ±0.5 % on the grid column; floor p vs ρ·g·h_true (h_true = N·V_p/A),
//     offset ≤ 1.5·ρ·g·dx = 834 Pa (the voxel surface sits 0.5–1.5 dx high [DERIVED-B]).
// C5 stillness after 6 s: RMS speed ≤ 1 % √(gH) = 0.036 m/s at H = 1.36 m [SRC-r3].
// G5 every solve reaches its tolerance (0 cap hits).
// B1 Ritter bound, dam break (quasi-2D slab): front speed on t√(g/h0) ∈ [1, 3] between 1.0√(gh0) and 2.1√(gh0)
//     (Ritter's inviscid dry-bed front is 2√(gh0) [SWASHES]; experiments 1.14–1.74 [Lobovský Table 1]).
// E1 energy: E_K + E_P never exceeds its initial value by more than 2 %, and its 1 s end trend is ≤ 0.
// CL closed tank (no air): solvable with the mean pinned, flagged, residual at tolerance, no NaN.
import { loadTsModules } from './lib/loadTs.mjs'

const QUICK = process.argv.includes('--quick')
const SRC = process.env.FLUID_REF_SRC ?? 'src/sim-ref'
const { gridLayout, flipRef } = await loadTsModules({ gridLayout: `${SRC}/gridLayout.ts`, flipRef: `${SRC}/flipRef.ts` })
const { GridLayout } = gridLayout
const { FlipRef, makeParticles, kineticEnergy, potentialEnergy, CellLabel } = flipRef

const G = 9.80665, DX = 3.63 / 64, RHO = 998.2072
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function blob(lo, hi, rng) {
  const pts = []
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
    for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX])
  const p = makeParticles(pts.length)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = RHO * DX ** 3 / 8 })
  return p
}
const gvec = [0, -G, 0]
const t0 = Date.now()

// G1a
{
  const L = new GridLayout({ nx: 16, ny: 64, nz: 16, dx: DX })
  const sim = new FlipRef(L, { gravity: gvec, projection: true, pressureTolerance: 1e-5 })
  const p = blob([0, 0, 0], [15, 23, 15], mulberry32(1))
  sim.step(p, 1 / 120)
  let worst = 0, cells = 0
  for (let k = 0; k < 16; k++) for (let j = 0; j < 24; j++) for (let i = 0; i < 16; i++) {
    const exact = RHO * G * DX * (24 - j)
    worst = Math.max(worst, Math.abs(sim.pressure[L.idx(i, j, k)] - exact) / exact); cells++
  }
  const s = sim.lastSolve
  check(worst <= 1e-3 && s.residualInf <= 1e-5 && !s.closed && sim.diag.unsetDivergenceFaces === 0,
    `G1a 16×64×16, 24 cells deep, one substep: max |p − ρg·dx·(24−j)|/p ${worst.toExponential(2)} over ${cells} liquid cells (≤ 1e-3); ‖r‖∞ ${s.residualInf.toExponential(2)} 1/s after ${s.iterations} JPCG iterations; unset divergence faces ${sim.diag.unsetDivergenceFaces}`)
}

// CL
{
  const L = new GridLayout({ nx: 8, ny: 8, nz: 8, dx: DX })
  const sim = new FlipRef(L, { gravity: gvec, projection: true, pressureTolerance: 1e-6 })
  const p = blob([0, 0, 0], [7, 7, 7], mulberry32(2))
  sim.step(p, 1 / 120)
  const s = sim.lastSolve
  let nan = 0
  for (const v of sim.pressure) if (!Number.isFinite(v)) nan++
  check(s.closed && s.residualInf <= 1e-6 && nan === 0, `CL closed 8³ tank, no air: flagged closed ${s.closed}, ‖r‖∞ ${s.residualInf.toExponential(2)} (≤ 1e-6, mean pinned), non-finite pressures ${nan}`)
}

if (!QUICK) {
  // G1b, C5, G5 — one 6 s settling run
  const L = new GridLayout({ nx: 16, ny: 64, nz: 16, dx: DX })
  const sim = new FlipRef(L, { gravity: gvec, projection: true, pressureTolerance: 1e-6 })
  const p = blob([0, 0, 0], [15, 23, 15], mulberry32(3))
  const dt = 1 / 120
  let capHits = 0, solves = 0, g1b = null
  for (let s = 1; s <= 720; s++) {
    sim.step(p, dt)
    solves++; if (sim.lastSolve.capHit) capHits++
    if (s === 360) {
      // grid pressure column: mean over the interior columns of each layer that is liquid everywhere
      const ys = [], ps = []
      for (let j = 0; j < 64; j++) {
        let sum = 0, all = true
        for (let k = 1; k < 15 && all; k++) for (let i = 1; i < 15; i++) { const c = L.idx(i, j, k); if (sim.label[c] !== CellLabel.LIQUID) { all = false; break } sum += sim.pressure[c] }
        if (!all) break
        ys.push((j + 0.5) * DX); ps.push(sum / 196)
      }
      const fitN = ys.length - 2                  // exclude the two layers under the (voxel) surface
      const xm = ys.slice(0, fitN).reduce((a, b) => a + b, 0) / fitN, pm = ps.slice(0, fitN).reduce((a, b) => a + b, 0) / fitN
      let sxy = 0, sxx = 0
      for (let i = 0; i < fitN; i++) { sxy += (ys[i] - xm) * (ps[i] - pm); sxx += (ys[i] - xm) ** 2 }
      const slope = sxy / sxx, pFloor = pm - slope * xm
      const hTrue = p.n * (DX ** 3 / 8) / (16 * DX * 16 * DX)
      g1b = { slope, relGrad: (-slope - RHO * G) / (RHO * G), pFloor, expect: RHO * G * hTrue, offset: pFloor - RHO * G * hTrue, layers: ys.length, hTrue }
    }
  }
  let v2 = 0
  for (let q = 0; q < p.n; q++) v2 += p.vel[3 * q] ** 2 + p.vel[3 * q + 1] ** 2 + p.vel[3 * q + 2] ** 2
  const rms = Math.sqrt(v2 / p.n), H = 24 * DX
  check(Math.abs(g1b.relGrad) <= 0.005 && Math.abs(g1b.offset) <= 1.5 * RHO * G * DX,
    `G1b after 3 s: dp/dy = ${g1b.slope.toFixed(1)} Pa/m vs −ρg = ${(-RHO * G).toFixed(1)} (${(100 * g1b.relGrad).toFixed(3)} %, ±0.5 %); floor p ${g1b.pFloor.toFixed(0)} Pa vs ρg·h_true ${g1b.expect.toFixed(0)} Pa (h_true ${g1b.hTrue.toFixed(4)} m): offset ${g1b.offset.toFixed(0)} Pa (≤ ${(1.5 * RHO * G * DX).toFixed(0)})`)
  check(rms <= 0.01 * Math.sqrt(G * H), `C5 stillness after 6 s: RMS speed ${rms.toExponential(2)} m/s (≤ ${(0.01 * Math.sqrt(G * H)).toFixed(4)} = 1 % √(gH), H ${H.toFixed(3)} m); wall clamps ${sim.diag.wallClamps}`)
  check(capHits === 0, `G5 ${solves} pressure solves, ${capHits} cap hits (every solve reached ‖r‖∞ ≤ 1e-6 1/s)`)

  // B1 + E1: dam break in a quasi-2D slab 128×24×4 (7.26 m long), column 8×8 cells against the x = 0 wall. Even at
  // Ritter's 2√(gh0) the front is 3.2 m from the release at the end of the window — the far wall is never reached.
  const Ld = new GridLayout({ nx: 128, ny: 24, nz: 4, dx: DX })
  const dsim = new FlipRef(Ld, { gravity: gvec, projection: true, pressureTolerance: 1e-6 })
  const dp = blob([0, 0, 0], [7, 7, 3], mulberry32(4))
  const h0 = 8 * DX, T0 = Math.sqrt(h0 / G), U = Math.sqrt(G * h0)
  const E = () => kineticEnergy(dp) + potentialEnergy(dp, gvec)
  const E0 = E()
  let Emax = E0
  const front = () => { const xs = []; for (let q = 0; q < dp.n; q++) xs.push(dp.pos[3 * q]); xs.sort((a, b) => a - b); return xs[Math.floor(0.995 * (xs.length - 1))] }
  const ts = [], fs = [], es = []
  const ddt = 1 / 240
  let clampsInWindow = 0
  for (let s = 1; s * ddt <= 3.2 * T0 + 1e-9 || s * ddt <= 1.0; s++) {
    const c0 = dsim.diag.wallClamps
    dsim.step(dp, ddt)
    const t = s * ddt, e = E()
    if (t / T0 >= 1 && t / T0 <= 3) clampsInWindow += dsim.diag.wallClamps - c0
    Emax = Math.max(Emax, e)
    ts.push(t); fs.push(front()); es.push(e)
  }
  const maxFrontInWindow = Math.max(...ts.map((t, i) => (t / T0 <= 3 ? fs[i] : 0)))
  const win = ts.map((t, i) => [t / T0, i]).filter(([tau]) => tau >= 1 && tau <= 3).map(([, i]) => i)
  const n = win.length, tm = win.reduce((a, i) => a + ts[i], 0) / n, fm = win.reduce((a, i) => a + fs[i], 0) / n
  let sxy = 0, sxx = 0
  for (const i of win) { sxy += (ts[i] - tm) * (fs[i] - fm); sxx += (ts[i] - tm) ** 2 }
  const speed = sxy / sxx
  check(speed >= 1.0 * U && speed <= 2.1 * U && maxFrontInWindow < Ld.extent[0] - 2 * DX, `B1 dam break h0 ${h0.toFixed(3)} m: front speed on t√(g/h0) ∈ [1,3] = ${speed.toFixed(3)} m/s = ${(speed / U).toFixed(3)}·√(gh0) (1.0–2.1; Ritter 2, experiments 1.14–1.74); front at window end ${maxFrontInWindow.toFixed(2)} m of ${Ld.extent[0].toFixed(2)} m (far wall never reached)`)
  info(`B1 particle wall push-backs (window clamp): ${clampsInWindow} inside the fit window, ${dsim.diag.wallClamps} over the whole run (${dp.n} particles; S3.2 adds the solid push-out)`)
  // E1: end trend over the last second of the run
  const tail = ts.map((t, i) => i).filter(i => ts[i] >= ts.at(-1) - 1)
  const tt = tail.reduce((a, i) => a + ts[i], 0) / tail.length, ee = tail.reduce((a, i) => a + es[i], 0) / tail.length
  let s2 = 0, s1 = 0
  for (const i of tail) { s2 += (ts[i] - tt) * (es[i] - ee); s1 += (ts[i] - tt) ** 2 }
  const trend = s2 / s1
  const ePot0 = potentialEnergy(dp, gvec)
  check((Emax - E0) / Math.abs(E0) <= 0.02 && trend <= 0, `E1 dam break energy: max rise over E(0) ${(100 * (Emax - E0) / Math.abs(E0)).toFixed(3)} % (≤ 2 %), last-second trend ${trend.toExponential(2)} J/s (≤ 0); E(end)/E(0) ${(es.at(-1) / E0).toFixed(4)}`)
  info(`dam break ran ${ts.length} substeps of 1/240 s to t = ${ts.at(-1).toFixed(3)} s; E_P(end) ${ePot0.toFixed(1)} J`)
}

console.log(`\ns3.1b reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
