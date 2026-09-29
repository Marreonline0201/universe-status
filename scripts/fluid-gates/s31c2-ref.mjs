#!/usr/bin/env node
// Gate S3.1c-2 on the f64 CPU reference — the drop ball as a moving solid sphere (FINAL-PLAN §7 S3.1c: "the ball as a
// moving solid with fractional face and volume weights, Batty 2007"; weak two-way coupling for s ≥ 1).
//
//   node scripts/fluid-gates/s31c2-ref.mjs
//
// Batty, Bertails & Bridson 2007 (https://cs.uwaterloo.ca/~c2batty/papers/Batty07.pdf): fluid-fraction face weights in the
// pressure system (eqs. 4–7), the sphere's velocity in the right-hand side (eq. 13, M_S⁻¹ → 0 within a substep), force
// J·p = −Σ vol_f (p₊ − p₋)/dx (eqs. 8–10). Water 20 °C (NIST); ghost-fluid surface; density projection on.
// Criteria (fixed before the first run):
// SV the sphere's discrete volumes (Σ cell fractions·dx³ and the J volume Σ_y-faces S_f·dx³) vs (4/3)πR³, R = 3·dx: ±2 %.
// AR Archimedes: a fixed sphere fully submerged in a still pool, after 2 s: F_y = ρ·g·V_J ± 1 % (Batty: the discrete
//    hydrostatic pressure is exact, so the force is exact for the discrete volume) and within 3 % of ρ·g·(4/3)πR³;
//    |F_x|, |F_z| ≤ 1 % of F_y.
// ST stillness with the sphere after 2 s: RMS particle speed ≤ 1 % √(gH).
// MV a scripted sphere moving at 0.3 m/s through the pool for 1 s: no particle inside it after any substep; the
//    projected volume flux (1 − S)u + S·V divergence-free (max ≤ 1e-3 1/s); φ-volume within 1 % of N·V_p.
//    φ-volume is LIQUID volume: f̃ is compensated by the sphere's kernel volume (so a cell half inside it reads 1 at
//    rest), and flipRef.phiVolume subtracts the cell's solid fraction — the first run, before that correction, read
//    1.0238 = N·V_p + ~95 % of the sphere (a measurement of liquid + solid, not a volume loss or gain).
// WK weak two-way: a sphere of density 7850 kg/m³ released from rest in the still pool, V += Δt·(g + J·p/M) each
//    substep, M = ρ_s·V_J: mean acceleration over t ∈ [0.05, 0.20] s within 5 % of the potential-flow value
//    g(ρ_s − ρ_l)/(ρ_s + ½ρ_l) (sphere added mass ½ρV [S: Wikipedia "Added mass", citing Stokes 1851]); the first
//    substep's acceleration (buoyancy only, g(ρ_s − ρ_l)/ρ_s) is reported — the explicit coupling feeds the added-mass
//    reaction back one substep late, which converges for s ≥ 1 (the plan's restriction).
import { loadTsModules } from './lib/loadTs.mjs'

const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef, mat, two } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts`, two: `${SRC}/sim-ref/twoLayer.ts` })
const { GridLayout } = gridLayout, { FlipRef } = flipRef, { G_STD: G, mulberry32, fillMaterials } = two
const DX = 3.63 / 64, RHO = mat.waterDensity(20), R = 3 * DX, VP = DX ** 3 / 8
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
const opts = () => ({ gravity: [0, -G, 0], density: RHO, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5 })
const t0 = Date.now()
const NX = 16, NY = 28, NZ = 16, DEPTH = 18
const C0 = [8.3 * DX, 9.4 * DX, 7.7 * DX]
const inside = (x, y, z, c) => Math.hypot(x - c[0], y - c[1], z - c[2]) < R
function pool(c, seed) {
  const L = new GridLayout({ nx: NX, ny: NY, nz: NZ, dx: DX })
  const sim = new FlipRef(L, opts())
  // a rest fill of water, then the particles inside the sphere removed
  const { p } = fillMaterials(NX, DEPTH, NZ, DX, mulberry32(seed), () => [RHO, 0])
  const keep = []
  for (let q = 0; q < p.n; q++) if (!inside(p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2], c)) keep.push(q)
  const P = { ...p, n: keep.length, pos: new Float64Array(3 * keep.length), vel: new Float64Array(3 * keep.length), mass: new Float64Array(keep.length), c: [0, 1, 2].map(() => new Float64Array(3 * keep.length)) }
  keep.forEach((q, i) => { P.pos.set(p.pos.subarray(3 * q, 3 * q + 3), 3 * i); P.mass[i] = p.mass[q] })
  sim.sphere = { center: [...c], radius: R, velocity: [0, 0, 0] }
  return { L, sim, p: P }
}
const jVolume = sim => { let v = 0; for (const s of sim.solidFraction[1]) v += s; return v * DX ** 3 }
const rms = p => { let v = 0; for (let i = 0; i < p.vel.length; i++) v += p.vel[i] ** 2; return Math.sqrt(v / p.n) }

// SV + AR + ST
{
  const { sim, p } = pool(C0, 11)
  sim.sphereFractions()
  let vc = 0
  for (const s of sim.cellSolidFraction) vc += s
  vc *= DX ** 3
  const vJ = jVolume(sim), vA = 4 / 3 * Math.PI * R ** 3
  check(Math.abs(vc / vA - 1) <= 0.02 && Math.abs(vJ / vA - 1) <= 0.02, `SV sphere R = 3·dx: cell-fraction volume ${(vc / vA).toFixed(4)}·V, J volume (y faces) ${(vJ / vA).toFixed(4)}·V of (4/3)πR³ = ${(vA * 1e3).toFixed(3)} L (±2 %)`)
  for (let s = 0; s < 240; s++) sim.step(p, 1 / 120)
  const F = sim.sphereForce, want = RHO * G * vJ, wantA = RHO * G * vA
  check(Math.abs(F[1] / want - 1) <= 0.01 && Math.abs(F[1] / wantA - 1) <= 0.03 && Math.abs(F[0]) <= 0.01 * F[1] && Math.abs(F[2]) <= 0.01 * F[1],
    `AR Archimedes after 2 s (${p.n} particles): F = (${F.map(v => v.toFixed(2)).join(', ')}) N; F_y / ρgV_J ${(F[1] / want).toFixed(4)} (±1 %), / ρg(4/3)πR³ ${(F[1] / wantA).toFixed(4)} (±3 %)`)
  const H = DEPTH * DX, lim = 0.01 * Math.sqrt(G * H), v = rms(p)
  check(v <= lim, `ST stillness with the sphere after 2 s: RMS speed ${v.toExponential(2)} m/s (≤ ${lim.toExponential(2)} = 1 % √(gH)); push-outs ${sim.spherePushOuts}`)
}

// MV
{
  const c = [5 * DX, 9.4 * DX, 7.7 * DX], V = [0.3, 0, 0]
  const { sim, p } = pool(c, 12)
  sim.sphere.velocity = [...V]
  const dt = 1 / 120
  let worstInside = 0, worstDiv = 0
  for (let s = 0; s < 120; s++) {
    for (let a = 0; a < 3; a++) sim.sphere.center[a] += dt * V[a]     // Batty §3.2: advance the solid first
    sim.step(p, dt)
    worstDiv = Math.max(worstDiv, sim.maxLiquidDivergence())
    for (let q = 0; q < p.n; q++) if (Math.hypot(p.pos[3 * q] - sim.sphere.center[0], p.pos[3 * q + 1] - sim.sphere.center[1], p.pos[3 * q + 2] - sim.sphere.center[2]) < R - 1e-12) worstInside++
  }
  const vol = sim.phiVolume() / (p.n * VP)
  check(worstInside === 0 && worstDiv <= 1e-3 && Math.abs(vol - 1) <= 0.01, `MV scripted sphere at 0.3 m/s for 1 s: particles inside after a substep ${worstInside} (0); max |∇·((1−S)u + S·V)| ${worstDiv.toExponential(2)} 1/s (≤ 1e-3); φ-volume ${vol.toFixed(4)}·N·V_p (±1 %); push-outs ${sim.spherePushOuts}`)
}

// WK
{
  const { sim, p } = pool(C0, 13)
  for (let s = 0; s < 120; s++) sim.step(p, 1 / 120)                  // settle with the sphere held
  const rhoS = 7850, vJ = jVolume(sim), M = rhoS * vJ, dt = 1 / 120
  const V = [0, 0, 0], ts = [], vy = []
  let a1 = NaN
  for (let s = 1; s * dt <= 0.2 + 1e-9; s++) {
    for (let a = 0; a < 3; a++) sim.sphere.center[a] += dt * V[a]
    sim.sphere.velocity = [...V]
    sim.step(p, dt)
    const F = sim.sphereForce
    const acc = [F[0] / M, F[1] / M - G, F[2] / M]
    if (s === 1) a1 = -acc[1]
    for (let a = 0; a < 3; a++) V[a] += dt * acc[a]
    ts.push(s * dt); vy.push(V[1])
  }
  const idx = ts.map((t, i) => i).filter(i => ts[i] >= 0.05)
  const tm = idx.reduce((q, i) => q + ts[i], 0) / idx.length, vm = idx.reduce((q, i) => q + vy[i], 0) / idx.length
  let sxy = 0, sxx = 0
  for (const i of idx) { sxy += (ts[i] - tm) * (vy[i] - vm); sxx += (ts[i] - tm) ** 2 }
  const aMeas = -sxy / sxx, aTrue = G * (rhoS - RHO) / (rhoS + 0.5 * RHO), aBuoy = G * (rhoS - RHO) / rhoS
  check(Math.abs(aMeas / aTrue - 1) <= 0.05, `WK weak two-way, ρ_s 7850 kg/m³ from rest: mean acceleration on [0.05, 0.20] s ${aMeas.toFixed(3)} m/s² vs potential-flow g(ρ_s−ρ)/(ρ_s+½ρ) ${aTrue.toFixed(3)} (±5 %); first substep ${a1.toFixed(3)} (buoyancy only ${aBuoy.toFixed(3)})`)
}

console.log(`\ns3.1c-2 reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
