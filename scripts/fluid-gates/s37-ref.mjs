#!/usr/bin/env node
// Gate S3.7 on the f64 CPU reference — the two-way ball, monolithic (FINAL-PLAN S3.7; vault fluid/realism-2026-09/
// S3.7-two-way-ball-spec.md): Batty, Bertails & Bridson 2007 eq. 13 in this grid's discretisation — every pressure solve
// carries Δt/(M·dx³)·Σ_a J_a J_aᵀ and returns V_new = V* + Δt·(J·p)/M, V* = Vⁿ + Δt·g; the viscous solve takes V as
// three unknowns of mass M. M = ρ_s·V_J.
//
//   node scripts/fluid-gates/s37-ref.mjs
//
// Water 20 °C (NIST), ghost-fluid surface, density projection on; pressure tolerance 1e-6 (the reference's).
// Criteria (FINAL-PLAN S3.7, fixed before the first run):
// A1 s = 2 sphere released at rest, fully submerged, clearance ≥ 3R on every side (tank 8R × (8R + 2) × 8R cells, water
//    8R deep, centre 4R above the floor), settled 1 s with the sphere held: the acceleration of the first substep after
//    release (the monolithic solve carries the added mass at once) vs a₀ = g(s − 1)/(s + ½) = 3.923 m/s² (4.903 without
//    added mass) ±5 % at R = 3.5 cells; R = 2.5 and 5 cells reported, and |error(R = 5)| ≤ |error(R = 2.5)| (convergence).
// A2 iron (s = ρ_Fe/ρ_w, NIST SRD 126), R = 3.5 cells, the A1 scene: g(s − 1)/(s + ½) = 8.053 m/s² ±3 %.
// A3 neutral ball (s = 1), R = 3.5 cells, the A1 scene: centre drift ≤ 0.5 cell over 10 s.
// A4 floating ball s = ½, R = 3.5 cells, tank 28 × 22 × 28 cells, water 12 cells deep, the ball released at rest with
//    its centre at the still level: mean submerged fraction over the last 2 s of 6 s = ½ ± 5 % (Archimedes: ρ_s/ρ);
//    the fraction from the level L = (N·V_p + f·V)/A and the cap h = L − (y_c − R): f = h²(3R − h)/(4R³) (solved together).
// A5 Stokes fall, iron in the 1100 °C GRD melt (μ from materialData, ρ 2600), R = 3.5 cells, tank 24 × 30 × 24 cells:
//    U/U_Stokes REPORTED (FINAL-PLAN: the wall-correction reference is open). Known limit found building this gate: the
//    split pressure / viscosity steps over-damp a sphere in the Stokes regime (νΔt/dx² = 1.5: the viscous step, which
//    does not see incompressibility, drags a block of melt with the ball and the next projection removes that
//    momentum) — Larionov, Batty & Bridson 2017 (unified pressure–viscosity solve, plan S3.6e) is the remedy.
import { loadTsModules } from './lib/loadTs.mjs'

const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef, mat, two } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts`, two: `${SRC}/sim-ref/twoLayer.ts` })
const { GridLayout } = gridLayout, { FlipRef } = flipRef, { G_STD: G, mulberry32, fillMaterials } = two
const DX = 3.63 / 64, RHO = mat.waterDensity(20), VP = DX ** 3 / 8, RHO_FE = mat.SOLID_REFERENCE.iron.solidDensityKgM3
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
const t0 = Date.now()
const baseOpts = rhoS => ({ gravity: [0, -G, 0], density: RHO, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5, sphereCoupling: 'monolithic', sphereDensity: rhoS })

/** A pool nx × depth × nz cells in an nx × ny × nz tank with the particles inside the sphere removed; the sphere is
 *  held (weak coupling, V = 0) while the pool settles `settle` substeps, then switched to monolithic. */
function scene({ nx, ny, nz, depth, c, R, rhoS, seed, settle, liquid = [RHO, 0], opts = {} }) {
  const L = new GridLayout({ nx, ny, nz, dx: DX })
  const sim = new FlipRef(L, { ...baseOpts(rhoS), ...opts })
  const { p } = fillMaterials(nx, depth, nz, DX, mulberry32(seed), () => liquid)
  const keep = []
  for (let q = 0; q < p.n; q++) if (Math.hypot(p.pos[3 * q] - c[0], p.pos[3 * q + 1] - c[1], p.pos[3 * q + 2] - c[2]) >= R) keep.push(q)
  const P = { ...p, n: keep.length, pos: new Float64Array(3 * keep.length), vel: new Float64Array(3 * keep.length), mass: new Float64Array(keep.length), c: [0, 1, 2].map(() => new Float64Array(3 * keep.length)) }
  if (p.mu) P.mu = new Float64Array(keep.length).fill(p.mu[0])
  keep.forEach((q, i) => { P.pos.set(p.pos.subarray(3 * q, 3 * q + 3), 3 * i); P.mass[i] = p.mass[q] })
  sim.sphere = { center: [...c], radius: R, velocity: [0, 0, 0] }
  sim.sphereCoupling = 'weak'
  for (let k = 0; k < settle; k++) sim.step(P, 1 / 120)
  sim.sphereCoupling = 'monolithic'
  return { sim, p: P, L }
}
const release = (sim, p, dt) => { sim.advanceSphere(dt); const v0 = [...sim.sphere.velocity]; sim.step(p, dt); return v0 }

// A1 + A2: the first substep's acceleration
const a0 = s => G * (s - 1) / (s + 0.5)
function firstAccel(Rc, s, seed) {
  const n = Math.round(8 * Rc), R = Rc * DX
  const { sim, p } = scene({ nx: n, ny: n + 2, nz: n, depth: n, c: [n / 2 * DX + 0.3 * DX, 4 * Rc * DX, n / 2 * DX - 0.2 * DX], R, rhoS: s * RHO, seed, settle: 120 })
  const v0 = release(sim, p, 1 / 120)
  const a = -(sim.sphere.velocity[1] - v0[1]) * 120
  return { a, particles: p.n, n, torque: sim.sphereTorque, force: sim.sphereForce }
}
const aRef = a0(2)
const A1 = [2.5, 3.5, 5].map(Rc => ({ Rc, ...firstAccel(Rc, 2, 31) }))
const err = r => r.a / aRef - 1
for (const r of A1) info(`A1 R = ${r.Rc} cells (tank ${r.n}³, ${r.particles} particles): a₀ ${r.a.toFixed(4)} m/s² (${(100 * err(r)).toFixed(2)} %); discrete torque |T| ${Math.hypot(...r.torque).toExponential(2)} N·m vs |F|·R ${(Math.hypot(...r.force) * r.Rc * DX).toExponential(2)}`)
const r35 = A1.find(r => r.Rc === 3.5), r25 = A1.find(r => r.Rc === 2.5), r5 = A1.find(r => r.Rc === 5)
check(Math.abs(err(r35)) <= 0.05 && Math.abs(err(r5)) <= Math.abs(err(r25)),
  `A1 s = 2 sphere from rest, clearance 3R: a₀ ${r35.a.toFixed(3)} m/s² at R = 3.5 cells vs g(s−1)/(s+½) ${aRef.toFixed(3)} (${(100 * err(r35)).toFixed(2)} %, ±5 %; without added mass ${(G / 2).toFixed(3)}); |error| R = 2.5 / 3.5 / 5: ${A1.map(r => (100 * Math.abs(err(r))).toFixed(2)).join(' / ')} % (R = 5 ≤ R = 2.5)`)
const sFe = RHO_FE / RHO, A2 = firstAccel(3.5, sFe, 32)
check(Math.abs(A2.a / a0(sFe) - 1) <= 0.03, `A2 iron (s = ${sFe.toFixed(3)}), R = 3.5 cells: a₀ ${A2.a.toFixed(3)} m/s² vs ${a0(sFe).toFixed(3)} (${(100 * (A2.a / a0(sFe) - 1)).toFixed(2)} %, ±3 %; without added mass ${(G * (sFe - 1) / sFe).toFixed(3)})`)
info(`A1/A2 ${((Date.now() - t0) / 1000).toFixed(0)} s`)

// A3: neutral ball, 10 s
{
  const Rc = 3.5, n = 28, c = [n / 2 * DX + 0.3 * DX, 4 * Rc * DX, n / 2 * DX - 0.2 * DX]
  const { sim, p } = scene({ nx: n, ny: n + 2, nz: n, depth: n, c, R: Rc * DX, rhoS: RHO, seed: 33, settle: 120 })
  let maxDrift = 0
  for (let k = 1; k <= 1200; k++) {
    release(sim, p, 1 / 120)
    maxDrift = Math.max(maxDrift, Math.hypot(sim.sphere.center[0] - c[0], sim.sphere.center[1] - c[1], sim.sphere.center[2] - c[2]) / DX)
  }
  check(maxDrift <= 0.5, `A3 neutral ball (s = 1), R = 3.5 cells, 10 s: largest centre drift ${maxDrift.toFixed(3)} cells (≤ 0.5)`)
  info(`A3 ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

// A4: floating ball, s = 1/2
{
  const Rc = 3.5, R = Rc * DX, n = 28, depth = 12
  const { sim, p } = scene({ nx: n, ny: 22, nz: n, depth, c: [n / 2 * DX + 0.3 * DX, depth * DX, n / 2 * DX - 0.2 * DX], R, rhoS: 0.5 * RHO, seed: 34, settle: 0 })
  const A = (n * DX) ** 2, V = 4 / 3 * Math.PI * R ** 3
  const frac = yc => { let f = 0.5; for (let it = 0; it < 50; it++) { const Lv = (p.n * VP + f * V) / A, h = Math.min(2 * R, Math.max(0, Lv - (yc - R))); f = h * h * (3 * R - h) / (4 * R ** 3) } return f }
  const fs = []
  for (let k = 1; k <= 720; k++) {
    release(sim, p, 1 / 120)
    if (k > 480) fs.push(frac(sim.sphere.center[1]))
  }
  const f = fs.reduce((a, b) => a + b, 0) / fs.length, fMin = Math.min(...fs), fMax = Math.max(...fs)
  check(Math.abs(f - 0.5) <= 0.025, `A4 floating ball s = ½, R = 3.5 cells, released at the still level: mean submerged fraction over the last 2 s of 6 s ${f.toFixed(4)} (range ${fMin.toFixed(3)}–${fMax.toFixed(3)}) vs Archimedes 0.5 (±5 %)`)
  info(`A4 ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

// A5: Stokes fall in the dense melt (reported)
{
  const MU = mat.vftViscosity(mat.LAVA_GRD_PRESET, 1100), RHOM = 2600, Rc = 3.5, R = Rc * DX, n = 24, ny = 30
  const c = [n / 2 * DX, (ny - 2 - 2 * Rc - 3) * DX, n / 2 * DX]
  const L = new GridLayout({ nx: n, ny, nz: n, dx: DX })
  const sim = new FlipRef(L, { gravity: [0, -G, 0], density: RHOM, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5, sphereCoupling: 'monolithic', sphereDensity: RHO_FE, viscosity: 'force', viscosityDefault: MU, viscosityTolerance: 1e-8 })
  const { p } = fillMaterials(n, ny - 2, n, DX, mulberry32(35), () => [RHOM, 0])
  const keep = []
  for (let q = 0; q < p.n; q++) if (Math.hypot(p.pos[3 * q] - c[0], p.pos[3 * q + 1] - c[1], p.pos[3 * q + 2] - c[2]) >= R) keep.push(q)
  const P = { ...p, n: keep.length, pos: new Float64Array(3 * keep.length), vel: new Float64Array(3 * keep.length), mass: new Float64Array(keep.length), c: [0, 1, 2].map(() => new Float64Array(3 * keep.length)), mu: new Float64Array(keep.length).fill(MU) }
  keep.forEach((q, i) => { P.pos.set(p.pos.subarray(3 * q, 3 * q + 3), 3 * i); P.mass[i] = p.mass[q] })
  sim.sphere = { center: [...c], radius: R, velocity: [0, 0, 0] }
  const Us = 2 / 9 * (RHO_FE - RHOM) * G * R * R / MU
  for (let k = 1; k <= 30; k++) release(sim, P, 1 / 120)
  const U = -sim.sphere.velocity[1]
  info(`A5 Stokes fall (reported, known limit — see header), iron in GRD melt 1100 °C (μ ${MU.toFixed(0)} Pa·s), R = 3.5 cells, tank 24×30×24: U ${U.toExponential(3)} m/s = ${(U / Us).toFixed(3)} U_Stokes (${Us.toFixed(4)} m/s, Re ${(RHOM * Us * 2 * R / MU).toFixed(3)}) after 0.25 s; split pressure/viscosity over-damps it — S3.6e (Larionov et al. 2017)`)
}

console.log(`\ns3.7 reference gate: ${fails ? `FAIL (${fails})` : 'PASS'}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails ? 1 : 0)
