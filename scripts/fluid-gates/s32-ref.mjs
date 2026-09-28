#!/usr/bin/env node
// Gate S3.2 on the f64 CPU reference — Kugelstadt et al. 2019 density projection (FINAL-PLAN §7 S3.2).
//
//   node scripts/fluid-gates/s32-ref.mjs            (D0, C4, WALL, A1 a = 12 and 8, INV′)
//   node scripts/fluid-gates/s32-ref.mjs --g2       (adds G2: 30 s double dam break — slow on the CPU)
//
// D0 direction (the sign of the whole method): a free blob at 12 ppc (f ≈ 1.5) must EXPAND and one at 6 ppc (f ≈ 0.75)
//    must CONTRACT in its interior, in one correction, with g = 0 and no velocity change.
// C4 volume at rest: after 3 s settling, the φ-volume Σ min(f̃,1)·dx³ equals N·V_p within ±1 %.
// WALL wall-cell density at rest: every LIQUID cell touching a wall (face, edge, corner) and not touching air reads
//    f̃ = 1 ± 1 %; the pool's centre of mass does not drift toward the walls (|Δx|,|Δz| ≤ 0.1 dx over 3 s).
// A1 Martin & Moyce 1952 n² = 2 column (a = 12 cells = 0.681 m; 128×32×8 slab, free-slip z walls):
//    RMS relative error of Z(T) against Table 2 ≤ 10 % with no time shift; dZ/dT on [1.43, 3.33] ∈ [1.19, 1.74]
//    (hard fail > 2.1); |ΔH| ≤ 0.05 against Table 6 up to τ = 5.25.
// A1c grid convergence (replaces the plan's "error(a=12) ≤ error(a=8) against the experiment", see below): one physical
//    column a = 0.4536 m at 8, 12 and 16 cells across; the RMS difference of Z(T) between successive resolutions must
//    shrink: RMS|Z16 − Z12| ≤ RMS|Z12 − Z8|. WHY: the plan's version compared a 68 cm and a 45 cm column (fixed dx)
//    against Martin & Moyce's 5.7 cm one. The simulated front runs AHEAD of the experiment at every resolution, and
//    further ahead as numerical damping falls — the inviscid, surface-tension-free model converges to a faster front
//    than a 5.7 cm column slowed by bottom friction and surface tension (Bond number ≈ 4e2 there vs ≈ 6e4 here).
//    Convergence toward the experiment is therefore not a property this model can have; convergence of the solver is.
//    The plan's comparison is still printed.
//    T = n·t·√(g/a), Z = front/a (Z(0) = 1), τ = t·√(g/a), H = height at the back wall/(n²a) [SRC-r3].
// INV′ E_K + E_P − ΣΔE_P(δx) never rises more than 2 % above its start; last-second trend ≤ 0 (A1 run).
// G2 (--g2) double dam break, 30 s, 64×64×8 slab: |φ-volume/(N·V_p) − 1| ≤ 2 % (target 0.5 %) [Kugelstadt: < 0.5 %
//    in 3D]. Reference N·V_p, not φ(0): the jittered start reads ~2.9 % low (min(f, 1) clips noisy over-full cells).
import { loadTsModules } from './lib/loadTs.mjs'

const G2 = process.argv.includes('--g2')
const SRC = process.env.FLUID_REF_SRC ?? 'src/sim-ref'
const { gridLayout, flipRef } = await loadTsModules({ gridLayout: `${SRC}/gridLayout.ts`, flipRef: `${SRC}/flipRef.ts` })
const { GridLayout } = gridLayout
const { FlipRef, makeParticles, kineticEnergy, potentialEnergy, centreOfMass, CellLabel } = flipRef

const G = 9.80665, DX = 3.63 / 64, RHO = 998.2072, gvec = [0, -G, 0]
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** ppc = 8: jittered 2×2×2 sub-cells (the rest packing); other ppc: uniform random in the cell. */
function blob(lo, hi, rng, ppc = 8, h = DX) {
  const pts = []
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
    for (let s = 0; s < ppc; s++) {
      if (ppc === 8) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
      else pts.push([(i + rng()) * h, (j + rng()) * h, (k + rng()) * h])
    }
  const p = makeParticles(pts.length)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = RHO * h ** 3 / 8 })   // V_p = dx³/8 always: ppc ≠ 8 ⇒ f ≠ 1
  return p
}
const t0 = Date.now()

// D0
{
  const spread = (ppc) => {
    const L = new GridLayout({ nx: 24, ny: 24, nz: 24, dx: DX })
    const sim = new FlipRef(L, { density: RHO, densityProjection: true })
    const p = blob([8, 8, 8], [15, 15, 15], mulberry32(ppc), ppc)
    const c = centreOfMass(p)
    const r2 = () => { let s = 0; for (let q = 0; q < p.n; q++) s += (p.pos[3 * q] - c[0]) ** 2 + (p.pos[3 * q + 1] - c[1]) ** 2 + (p.pos[3 * q + 2] - c[2]) ** 2; return s / p.n }
    // interior = particles in the central 4³ cells of the block
    const inner = q => [0, 1, 2].every(a => { const x = p.pos[3 * q + a] / DX; return x >= 10 && x < 14 })
    const innerIds = []; for (let q = 0; q < p.n; q++) if (inner(q)) innerIds.push(q)
    const ri = () => { let s = 0; for (const q of innerIds) s += (p.pos[3 * q] - c[0]) ** 2 + (p.pos[3 * q + 1] - c[1]) ** 2 + (p.pos[3 * q + 2] - c[2]) ** 2; return s / innerIds.length }
    const v0 = p.vel.slice(), a = r2(), ai = ri()
    const st = sim.densityCorrect(p)
    let dv = 0; for (let i = 0; i < p.vel.length; i++) dv = Math.max(dv, Math.abs(p.vel[i] - v0[i]))
    return { all: r2() / a - 1, inner: ri() / ai - 1, fMax: st.fMax, fMin: st.fMin, dv, maxMove: st.maxMove / DX }
  }
  const hi = spread(12), lo = spread(6)
  check(hi.all > 0 && lo.inner < 0 && hi.dv === 0 && lo.dv === 0,
    `D0 direction: 12-ppc blob (f̃ up to ${hi.fMax.toFixed(2)}) mean r² ${(100 * hi.all).toFixed(2)} % (must grow); 6-ppc blob (f̃ down to ${lo.fMin.toFixed(2)}) interior r² ${(100 * lo.inner).toFixed(2)} % (must shrink); velocities changed by ${Math.max(hi.dv, lo.dv)} (must be 0); max move ${hi.maxMove.toFixed(2)} / ${lo.maxMove.toFixed(2)} cells`)
}

// C4 + WALL: a 16×16×16 pool, 12 cells deep, settled 3 s
{
  const L = new GridLayout({ nx: 16, ny: 20, nz: 16, dx: DX })
  const sim = new FlipRef(L, { gravity: gvec, density: RHO, projection: true, densityProjection: true, pressureTolerance: 1e-6, psiTolerance: 1e-6 })
  const p = blob([0, 0, 0], [15, 11, 15], mulberry32(5))
  const c0 = centreOfMass(p)
  for (let s = 0; s < 360; s++) sim.step(p, 1 / 120)
  sim.densityCorrect(p)                       // f̃ of the final state
  const vNp = p.n * DX ** 3 / 8, vPhi = sim.phiVolume()
  check(Math.abs(vPhi / vNp - 1) <= 0.01, `C4 volume at rest after 3 s: φ-volume ${vPhi.toFixed(5)} m³ vs N·V_p ${vNp.toFixed(5)} m³ (${(100 * (vPhi / vNp - 1)).toFixed(3)} %, ±1 %)`)
  let worst = 0, n = 0, kinds = { face: 0, edge: 0, corner: 0 }
  for (let k = 0; k < 16; k++) for (let j = 0; j < 20; j++) for (let i = 0; i < 16; i++) {
    const s = L.idx(i, j, k)
    if (sim.label[s] !== CellLabel.LIQUID) continue
    const walls = (i === 0 || i === 15 ? 1 : 0) + (j === 0 ? 1 : 0) + (k === 0 || k === 15 ? 1 : 0)
    if (walls === 0) continue
    let air = false
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (sim.label[L.idx(i + di, j + dj, k + dk)] === CellLabel.AIR) air = true
    if (air) continue
    worst = Math.max(worst, Math.abs(sim.fCompensated[s] - 1)); n++
    kinds[walls === 1 ? 'face' : walls === 2 ? 'edge' : 'corner']++
  }
  const c1 = centreOfMass(p)
  const drift = Math.max(Math.abs(c1[0] - c0[0]), Math.abs(c1[2] - c0[2])) / DX
  check(worst <= 0.01 && drift <= 0.1, `WALL after 3 s: max |f̃ − 1| ${worst.toExponential(2)} over ${n} wall cells (${kinds.face} face, ${kinds.edge} edge, ${kinds.corner} corner; ±1 %); horizontal COM drift ${drift.toFixed(4)} dx (≤ 0.1)`)
  info(`C4/WALL run: density clamps ${sim.diag.densityClamps}, wall clamps ${sim.diag.wallClamps}, last ψ solve ${sim.lastDensity.iterations} it`)
}

// A1 Martin & Moyce
const TABLE2 = { T: [0, 0.41, 0.84, 1.19, 1.43, 1.63, 1.83, 1.98, 2.20, 2.32, 2.51, 2.65, 2.83, 2.98, 3.11, 3.33], Z: [1.00, 1.11, 1.22, 1.44, 1.67, 1.89, 2.11, 2.33, 2.56, 2.78, 3.00, 3.22, 3.44, 3.67, 3.89, 4.11] }
const TABLE6 = { tau: [0, 0.56, 0.77, 0.93, 1.08, 1.28, 1.46, 1.66, 1.84, 2.00, 2.21, 2.45, 2.70, 3.06, 3.44, 4.20, 5.25], H: [1.00, 0.94, 0.89, 0.83, 0.78, 0.72, 0.67, 0.61, 0.56, 0.50, 0.44, 0.39, 0.33, 0.28, 0.22, 0.17, 0.11] }
function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0]
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1])
  return ys.at(-1)
}
function martinMoyce(aCells, aPhys = aCells * DX) {
  const h = aPhys / aCells, a = aPhys, n = Math.SQRT2, tUnit = Math.sqrt(a / G)
  const L = new GridLayout({ nx: Math.max(128, 10 * aCells), ny: 2 * aCells + 8, nz: 8, dx: h })
  const sim = new FlipRef(L, { gravity: gvec, density: RHO, projection: true, densityProjection: true, pressureTolerance: 1e-5, psiTolerance: 1e-4 })
  const p = blob([0, 0, 0], [aCells - 1, 2 * aCells - 1, 7], mulberry32(aCells), 8, h)
  const dt = (1 / 240) * (h / DX), tEnd = TABLE6.tau.at(-1) * tUnit
  const E = () => kineticEnergy(p) + potentialEnergy(p, gvec)
  const E0 = E()
  let corr = 0, invMax = 0
  const ts = [], Zs = [], Hs = [], invs = []
  for (let s = 1; s * dt <= tEnd + 1e-9; s++) {
    sim.step(p, dt)
    corr += sim.lastDensity.deltaPotential
    const t = s * dt
    const xs = []; let hMax = 0
    for (let q = 0; q < p.n; q++) { xs.push(p.pos[3 * q]); if (p.pos[3 * q] < h) hMax = Math.max(hMax, p.pos[3 * q + 1]) }
    xs.sort((u, v) => u - v)
    const front = xs[Math.floor(0.995 * (xs.length - 1))]
    const inv = E() - corr
    invMax = Math.max(invMax, (inv - E0) / E0)
    ts.push(t); Zs.push(front / a); Hs.push(hMax / (2 * a)); invs.push(inv)
  }
  const T = ts.map(t => n * t / tUnit), tau = ts.map(t => t / tUnit)
  // RMS relative Z error over the Table 2 points (T > 0), no time shift
  let se = 0, cnt = 0
  for (let i = 1; i < TABLE2.T.length; i++) { const z = interp(T, Zs, TABLE2.T[i]); se += ((z - TABLE2.Z[i]) / TABLE2.Z[i]) ** 2; cnt++ }
  const rmsZ = Math.sqrt(se / cnt)
  // dZ/dT on [1.43, 3.33] (least squares)
  const idx = T.map((x, i) => [x, i]).filter(([x]) => x >= 1.43 && x <= 3.33).map(([, i]) => i)
  const tm = idx.reduce((q, i) => q + T[i], 0) / idx.length, zm = idx.reduce((q, i) => q + Zs[i], 0) / idx.length
  let sxy = 0, sxx = 0
  for (const i of idx) { sxy += (T[i] - tm) * (Zs[i] - zm); sxx += (T[i] - tm) ** 2 }
  const slope = sxy / sxx
  let dH = 0
  for (let i = 1; i < TABLE6.tau.length; i++) dH = Math.max(dH, Math.abs(interp(tau, Hs, TABLE6.tau[i]) - TABLE6.H[i]))
  const tail = ts.map((t, i) => i).filter(i => ts[i] >= ts.at(-1) - 1)
  const tt = tail.reduce((q, i) => q + ts[i], 0) / tail.length, ee = tail.reduce((q, i) => q + invs[i], 0) / tail.length
  let s2 = 0, s1 = 0
  for (const i of tail) { s2 += (ts[i] - tt) * (invs[i] - ee); s1 += (ts[i] - tt) ** 2 }
  const zAt = TABLE2.T.slice(1).map(Tt => +(interp(T, Zs, Tt) - interp(TABLE2.T, TABLE2.Z, Tt)).toFixed(3))
  const zSim = TABLE2.T.slice(1).map(Tt => interp(T, Zs, Tt))
  return { zSim, aCells, a, rmsZ, slope, dH, invMax, invTrend: s2 / s1, particles: p.n, densityClamps: sim.diag.densityClamps, wallClamps: sim.diag.wallClamps, tEnd, zAt }
}
{
  const a12 = martinMoyce(12), a8 = martinMoyce(8)
  check(a12.rmsZ <= 0.10, `A1 Martin & Moyce n²=2, a = 12 cells (${a12.a.toFixed(3)} m, ${a12.particles} particles): RMS relative Z error vs Table 2 ${(100 * a12.rmsZ).toFixed(2)} % (≤ 10 %, no time shift)`)
  check(a12.slope >= 1.19 && a12.slope <= 1.74, `A1 dZ/dT on T ∈ [1.43, 3.33] = ${a12.slope.toFixed(3)} (1.19–1.74; hard fail > 2.1)`)
  check(a12.dH <= 0.05, `A1 residual column height: max |H − Table 6| ${a12.dH.toFixed(3)} up to τ = 5.25 (≤ 0.05)`)
  info(`A1 plan comparison (not a gate, see header): Z error vs experiment a = 12 cells ${(100 * a12.rmsZ).toFixed(2)} %, a = 8 cells ${(100 * a8.rmsZ).toFixed(2)} % (dZ/dT a = 8: ${a8.slope.toFixed(3)}, ΔH ${a8.dH.toFixed(3)})`)
  const aP = 8 * DX, c8 = martinMoyce(8, aP), c12 = martinMoyce(12, aP), c16 = martinMoyce(16, aP)
  const rmsD = (u, v) => Math.sqrt(u.reduce((s, x, i) => s + (x - v[i]) ** 2, 0) / u.length)
  const d1 = rmsD(c12.zSim, c8.zSim), d2 = rmsD(c16.zSim, c12.zSim)
  check(d2 <= d1, `A1c grid convergence, one column a = ${aP.toFixed(4)} m at 8/12/16 cells: RMS|Z12 − Z8| ${d1.toFixed(4)}, RMS|Z16 − Z12| ${d2.toFixed(4)} (must shrink); Z error vs experiment ${(100 * c8.rmsZ).toFixed(2)} / ${(100 * c12.rmsZ).toFixed(2)} / ${(100 * c16.rmsZ).toFixed(2)} %`)
  check(a12.invMax <= 0.02 && a12.invTrend <= 0, `INV′ A1: E_K + E_P − ΣΔE_P(δx) max rise ${(100 * a12.invMax).toFixed(3)} % (≤ 2 %), last-second trend ${a12.invTrend.toExponential(2)} J/s (≤ 0)`)
  info(`A1 clamps: density ${a12.densityClamps}, advection ${a12.wallClamps} (a = 12, ${a12.tEnd.toFixed(2)} s)`)
  info(`A1 Z_sim − Z_exp at the Table 2 T points: a = 12 [${a12.zAt.join(', ')}]`)
  info(`A1 Z_sim − Z_exp at the Table 2 T points: a = 8  [${a8.zAt.join(', ')}]`)
}

// G2
if (G2) {
  const L = new GridLayout({ nx: 64, ny: 64, nz: 8, dx: DX })
  const sim = new FlipRef(L, { gravity: gvec, density: RHO, projection: true, densityProjection: true, pressureTolerance: 1e-5, psiTolerance: 1e-3 })
  const p = makeParticles(0)
  const left = blob([0, 0, 0], [15, 31, 7], mulberry32(21)), right = blob([48, 0, 0], [63, 31, 7], mulberry32(22))
  const q = makeParticles(left.n + right.n)
  for (const k of ['pos', 'vel', 'mass']) { q[k].set(left[k], 0); q[k].set(right[k], left[k].length) }
  void p
  sim.densityCorrect(q)
  const v0 = sim.phiVolume()
  let vMin = v0, vMax = v0
  for (let s = 1; s <= 3600; s++) {
    sim.step(q, 1 / 120)
    if (s % 120 === 0) { const v = sim.phiVolume(); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v) }
  }
  sim.densityCorrect(q)
  const v1 = sim.phiVolume(), vNp = q.n * DX ** 3 / 8
  check(Math.abs(v1 / vNp - 1) <= 0.02, `G2 double dam break 30 s (64×64×8, ${q.n} particles): φ-volume / N·V_p = ${(v1 / vNp).toFixed(4)} (${(100 * (v1 / vNp - 1)).toFixed(3)} %, ≤ 2 %, target 0.5 %); t = 0 reading ${(v0 / vNp).toFixed(4)}·N·V_p; range over the run ${(100 * (vMin / vNp - 1)).toFixed(2)} … ${(100 * (vMax / vNp - 1)).toFixed(2)} %`)
}

console.log(`\ns3.2 reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
