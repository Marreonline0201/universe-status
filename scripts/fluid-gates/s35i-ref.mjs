#!/usr/bin/env node
// Gate S3.5-i on the f64 CPU reference — immiscible liquids by sub-grid drop slip (owner decision 2026-09-29: Manninen,
// Taivassalo & Kallio 1996 algebraic-slip drift flux; drop size from Hinze 1955 with the measured ε, a scenario may
// override it). Spec: vault fluid/realism-2026-09/IMMISCIBILITY-spec.md (§3–5 model, §8 sourced inputs).
//
//   node scripts/fluid-gates/s35i-ref.mjs [--quick]     (--quick: the drop-equation checks B, S, T and D-a, and W)
//   node scripts/fluid-gates/s35i-ref.mjs --only=W      (the face counter-flux checks alone — s35w-mutations runs this)
//
// Inputs (spec §8): σ olive oil–water 0.0245 N/m (Fisher, Mitchell & Parker 1985), mercury–water 0.375 N/m (Henry &
// Jackson 1938); ethanol–water miscible (σ = null → never separated); ρ, μ from materialData at 20 °C.
// The oracle of every slip check is written HERE, independently of flipRef: the equilibrium slip of (58) + (40) by f64
// bisection on Re·f(Re) = G, G = d³ρ_c·|ρ_p − ρ_m||a|/(18 μ_m²) (monotone in Re), and the drop's equation of motion
// (ρ_p + ½ρ_c)·ds/dt = (ρ_p − ρ_m)·a − 18 μ_m f(Re)·s/d² integrated by RK4 at 1000 substeps per Δt, each at the
// drop's own α, ρ_m, μ_m recomputed from the particles and a = g − Du/Dt: the simulation's face accelerations
// (FlipRef.faceAccel) sampled with the velocity stencil — or, in B, the exact g of a column at rest.
// Criteria (fixed before the first run):
// B   balance (added 2026-09-29 after D-c showed mercury slips of 3.4 m/s): stably stratified columns at rest — water
//     over mercury, olive oil over water — on a REGULAR particle lattice (sub-cell centres, no jitter), with drops of the
//     heavy liquid (1 mm) as extra particles ON the carrier's own sub-cell sites: the four (x, z) sites of the upper
//     sub-layer of every cell in the light layer's first row above the interface, where the face densities jump (drop
//     α ≈ ⅓, carrier-majority). At a side wall P2G sees no particles beyond it; with drops and carrier on the same sites
//     the truncation removes both in the same ratio, so every row's face densities are uniform up to the walls and the
//     column is an exact discrete equilibrium. The density projection is off here (the drop row is over-full by design;
//     moving it apart is that correction's job, not this check's). Drafts that were NOT at rest, recorded: the jittered
//     fill with every 8th particle (particle-sampled face densities vary across each row: real baroclinic motion,
//     median 4 %); one drop at a sub-cell or at the cell centre (the wall faces weight carrier and drop differently: a
//     density step at the walls, 1.4–3.3 % at the drop row in an 8-cell tank). Without drops the lattice column holds
//     a = g to 1e-6 at the interface.
//     Frozen fields (one step from rest, then only driftFlux): every drop's slip equals the equilibrium at a = g
//     exactly, ≤ 1e-3 relative. At rest the only
//     departure of g − Du/Dt from g is the pressure solve's residual (‖∇·u‖∞ ≤ 1e-6/s here: |Δa| ~ 1e-6·dx/Δt ≈ 7e-6
//     m/s², 1e-6 of g); a drift acceleration that pairs an interpolated ∇p with a differently discretised density
//     (∇p/ρ_m) errs there by ρ_f/ρ_m − 1, ≥ 10 % (Popinet 2018 §2.2 on well-balanced forcing).
// S   steady slip, frozen fields (after one step only driftFlux runs, so every drop's state is fixed): mercury 3 mm
//     (Newton regime, Re ≈ 3000), olive oil 1 mm (Re ≈ 20) and 0.2 mm (Δt/τ ≈ 3) in water, from rest — every drop's
//     slip equals its equilibrium vector to ≤ 1e-6 relative (the step's fixed point is exactly (58), so this is
//     "numerically converged", not a physics tolerance). Run length: until the slowest drop's linear contraction per
//     step, c = e^(−h)(1 + r) − r (h = Δt/τ_eq, r = Re·f′/f at u_eq), gives c^N ≤ 1e-12 — the 1e6 margin over the
//     tolerance covers the nonlinear start. (First run used a fixed 3 s, chosen before any drop's τ was known: mercury
//     drops in the weak ∇p by the walls have τ_eq/(1 + r) ≈ 0.38 s, so 3 s left 5e-4 — the run was short, the
//     tolerance is unchanged.)
// T   transient, frozen fields: the slip trajectory against the RK4 solution at Δt = 1/120, 1/240, 1/480 (mercury 3 mm
//     from rest over 0.5 s, olive oil 1 mm from rest and from a sideways slip over 0.15 s) — the error (max over drops
//     and checkpoints, relative to |u_eq|) decreases with Δt and the finest pair's ratio is ≥ √2 (observed order ≥ ½,
//     midway between a scheme converging to the wrong equation (0) and a consistent first-order one (1)).
// D-a the model's slip in a moving simulation: a dilute oil cloud (every 16th particle of the lower 10 cells) in still
//     water, drop diameter 1 mm (scenario override), after 1.5 s: mean |slip − u_eq|/|u_eq| ≤ 1 % over the dispersed
//     particles (u_eq at each drop's own current state); the dilute terminal velocity is reported beside it.
// D-b a gentle interface stays sharp: olive oil (12 cells) laid over water (12 cells) at rest, Hinze sizing, 11 s:
//     no particle ever dispersed (a quiet interface has ε → 0, so d_max ≥ dx: resolved) and 0.0 % on the wrong side.
// D-c F1's inverted release (water over olive oil; mercury over water), Hinze sizing: the wrong-side fraction over time
//     REPORTED with and without the model, with the largest slip — the physical reference (a hindered-settling
//     correlation for the creaming front, spec §6 D-c / §8.4) is not frozen: its sources are UNVERIFIED (spec §7).
// M   a miscible pair never slips: ethanol over water inverted, 3 s — 0 dispersed.
// V   volume: the D-c oil run keeps φ-volume within ±2 % of N·V_p at every second (the violent-flow tolerance of V1).
// W   the counter-flux J on the MAC faces (flipRef driftForm 'face', the default since 2026-09-30; decisions.md 01:32 —
//     derived from MTK (33) at a face and driftFluxFoam's Udm = 0 on walls; the CPU ablation of 01:17 measured its wall
//     condition load-bearing). Criteria fixed 2026-09-30 01:42 at `089f90df`, before the first run. Scene: D-a's (1 mm
//     olive-oil drops, every 16th particle of the lower 10 cells of 24, 16×30×8) after 0.25 s; then P2G at the current
//     positions and ONE driftFlux (frozen fields), so Σw is exact for the drift. Every oracle is computed HERE with its
//     own trilinear face stencil, independently of flipRef:
//     W1  J_f = 0 exactly on every wall face — every face in a window wall's plane (own-axis index 0 or n, the ghost
//         layer's edge faces included) and every SOLID face — and ≥ 1 of them lies in a dispersed drop's stencil.
//     W2  Σw_f equals flipRef's P2G weight sum and J_f equals the oracle (S_f/Σw_f over the dispersed drops' slips, 0 on
//         wall faces and where Σw_f < FACE_WEIGHT_MIN) to ≤ 1e-12 absolute on every face (f64 rounding).
//     W3  every particle's u_V equals (dispersed ? s : 0) − Σ_f w_f·J_f to ≤ 1e-12 m/s.
//     W4  carriers are not driven into a wall: every non-dispersed particle within dx of a SOLID face moves toward it
//         at most (d/dx)·max|J_f| (d its distance to the face, the max over its stencil's faces on that axis) + 1e-12.
//         Positive control, same scene and state: the 'cell' form (J per cell, applied by NGP) must VIOLATE it — the
//         check fails if the control passes (a check that the old kernel meets tests nothing).
//     W5  REPORTED: the particle-level remainder of face-level (31), Σ_f |Σ_q w_qf·u_V,q| / Σ_f Σ_q w_qf·|ŝ_q| over the
//         non-wall faces with Σw ≥ 1 — the sub-kernel part (Σ_q w_qf·(J_f − J(x_q))) the density projection removes.
//     Revision 2026-09-30 01:50, after the first run (FAIL W4: 35× the bound, W1–W3 exact): the wall planes' edge faces in
//     the ghost layer are GHOST, not SOLID, in GridLayout.defaultFaceTypes, and W1/W2 had encoded the implementation's
//     "SOLID only" rule — so J_n did not vanish at a wall next to a corner. The implementation now zeroes every face in a
//     wall's plane; W1/W2 name the same physical set (J·n = 0 holds on the whole plane); W4, the physical criterion, is
//     unchanged.
import { loadTsModules } from './lib/loadTs.mjs'

const QUICK = process.argv.includes('--quick')
const ONLY = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7)
if (ONLY && ONLY !== 'W') { console.error(`unknown --only=${ONLY} (have: W)`); process.exit(2) }
const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef, mat, two } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts`, two: `${SRC}/sim-ref/twoLayer.ts` })
const { GridLayout } = gridLayout, { FlipRef } = flipRef, { G_STD: G, mulberry32, fillMaterials: fill } = two
const DX = 3.63 / 64, VP = DX ** 3 / 8, DT = 1 / 120
const W = { rho: mat.waterDensity(20), mu: mat.LIQUIDS.water.viscosity(20) }
const OIL = { rho: mat.LIQUIDS['olive-oil'].density(20), mu: mat.LIQUIDS['olive-oil'].viscosity(20) }
const HG = { rho: mat.HG_RHO_20C, mu: mat.LIQUIDS.mercury.viscosity(20) }
const ETH = { rho: mat.LIQUIDS.ethanol.density(20), mu: mat.LIQUIDS.ethanol.viscosity(20) }
const SIGMA = { 'oil|water': 0.0245, 'mercury|water': 0.375 }
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
const t0 = Date.now()
const opts = (props, sigma, extra = {}) => ({ gravity: [0, -G, 0], density: W.rho, projection: true, densityProjection: true, freeSurface: 'ghost', variableDensity: true, pressureTolerance: 1e-6, psiTolerance: 1e-5,
  immiscible: { props, sigma, ...extra } })

// ── the independent oracle ────────────────────────────────────────────────────────────────────────────────────────
const fRe = Re => (Re < 1000 ? 1 + 0.15 * Re ** 0.687 : 0.44 * Re / 24)                   // MTK (40)
const rEq = Re => (Re < 1000 ? 0.687 * 0.15 * Re ** 0.687 / (1 + 0.15 * Re ** 0.687) : 1)   // Re·f′/f
/** Equilibrium slip speed of (58) + (40): Re·f(Re) = G by bisection (Re·f ≥ Re, so the root lies in [0, G]). */
function equilibrium(d, F, rc, muM) {
  const G2 = d ** 3 * rc * F / (18 * muM * muM)
  if (!(G2 > 0)) return { U: 0, Re: 0 }
  let lo = 0, hi = G2
  for (let i = 0; i < 400 && hi - lo > 1e-15 * hi; i++) { const mid = 0.5 * (lo + hi); if (mid * fRe(mid) < G2) lo = mid; else hi = mid }
  const Re = 0.5 * (lo + hi)
  return { U: Re * muM / (d * rc), Re }
}
/** Each dispersed drop's state from the simulation's fields: α of both materials at its cell (trilinear particle
 *  weights to cell centres), ρ_m, μ_m (Ishii–Zuber, α_pm = 1), a = the face accelerations sampled trilinearly (or
 *  `aFixed`). Materials: 0 the carrier C, 1 the drop D. */
function dropStates(sim, L, p, C, D, d, aFixed) {
  const [nx, ny, nz] = [L.nx, L.ny, L.nz], S = L.size, Wm = [new Float64Array(S), new Float64Array(S)]
  for (let q = 0; q < p.n; q++) {
    const fx = p.pos[3 * q] / DX - 0.5, fy = p.pos[3 * q + 1] / DX - 0.5, fz = p.pos[3 * q + 2] / DX - 0.5
    const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz)
    for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const i = i0 + di, j = j0 + dj, k = k0 + dk
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue
      const w = (di ? fx - i0 : 1 - fx + i0) * (dj ? fy - j0 : 1 - fy + j0) * (dk ? fz - k0 : 1 - fz + k0)
      if (w > 0) Wm[p.material[q]][L.idx(i, j, k)] += w
    }
  }
  const out = []
  for (let q = 0; q < p.n; q++) {
    if (p.material[q] !== 1 || !(p.drop[q] > 0)) continue
    const x = [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]]
    const s2 = L.idx(Math.floor(x[0] / DX), Math.floor(x[1] / DX), Math.floor(x[2] / DX))
    const aD = Wm[1][s2] / (Wm[0][s2] + Wm[1][s2])
    const rm = (1 - aD) * C.rho + aD * D.rho, muStar = (D.mu + 0.4 * C.mu) / (D.mu + C.mu), muM = C.mu * (1 - aD) ** (-2.5 * muStar)
    const acc = aFixed ?? [0, 1, 2].map(a => {
      const f = x.map((v, b) => v / DX - (a === b ? 0 : 0.5)), b0 = f.map(Math.floor)
      let v = 0
      for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++)
        v += (di ? f[0] - b0[0] : 1 - f[0] + b0[0]) * (dj ? f[1] - b0[1] : 1 - f[1] + b0[1]) * (dk ? f[2] - b0[2] : 1 - f[2] + b0[2]) * sim.faceAccel[a][L.idx(b0[0] + di, b0[1] + dj, b0[2] + dk)]
      return v
    })
    const aMag = Math.hypot(...acc), eq = equilibrium(d, Math.abs(D.rho - rm) * aMag, C.rho, muM)
    const dir = aMag > 0 ? Math.sign(D.rho - rm) / aMag : 0
    out.push({ q, rm, muM, acc, rp: D.rho, rc: C.rho, d, eq, ueq: acc.map(v => eq.U * dir * v) })
  }
  return out
}
/** RK4 of the drop's equation of motion from s0, at `sub` substeps per dt0, sampled at the checkpoint step counts. */
function rk4(st, s0, dt0, sub, checkpoints) {
  const m = st.rp + 0.5 * st.rc, h = dt0 / sub
  const rhs = s => { const c = 18 * st.muM * fRe(st.d * st.rc * Math.hypot(...s) / st.muM) / (st.d * st.d); return s.map((v, i) => ((st.rp - st.rm) * st.acc[i] - c * v) / m) }
  let s = [...s0], step = 0
  const out = []
  for (const cp of checkpoints) {
    for (; step < cp * sub; step++) {
      const k1 = rhs(s), k2 = rhs(s.map((v, i) => v + 0.5 * h * k1[i])), k3 = rhs(s.map((v, i) => v + 0.5 * h * k2[i])), k4 = rhs(s.map((v, i) => v + h * k3[i]))
      s = s.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]))
    }
    out.push(s)
  }
  return out
}

const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2])

// ── W: the counter-flux on the MAC faces ──────────────────────────────────────────────────────────────────────────
/** Visit the 8 faces of grid `a` in the trilinear stencil of x (the MAC face offsets: 0 on axis a, ½ on the others). */
function faceStencil(L, a, x, fn) {
  const f = x.map((v, b) => v / DX - (a === b ? 0 : 0.5)), b0 = f.map(Math.floor), t = f.map((v, b) => v - b0[b])
  for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++)
    fn(L.idx(b0[0] + di, b0[1] + dj, b0[2] + dk), (di ? t[0] : 1 - t[0]) * (dj ? t[1] : 1 - t[1]) * (dk ? t[2] : 1 - t[2]), [b0[0] + di, b0[1] + dj, b0[2] + dk])
}
function wScene(form) {
  const d = 1e-3, nx = 16, nz = 8, L = new GridLayout({ nx, ny: 30, nz, dx: DX })
  const sim = new FlipRef(L, opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: d, driftForm: form }))
  const { p } = fill(nx, 24, nz, DX, mulberry32(81), () => [W.rho, 0])
  for (let q = 0; q < p.n; q++) if (q % 16 === 5 && p.pos[3 * q + 1] < 10 * DX) { p.material[q] = 1; p.mass[q] = OIL.rho * VP }
  return { L, sim, p }
}
{
  const { L, sim, p } = wScene('face')
  for (let k = 0; k < 30; k++) sim.step(p, DT)
  sim.p2g(p)
  const slip0 = p.slip.slice(), drop0 = p.drop.slice()
  sim.driftFlux(p, DT)
  const S = L.size, n = p.n, disp = q => p.drop[q] > 0, SOLID = gridLayout.FaceType.SOLID
  // the oracle: Σw and S_f from every particle with this file's stencil, then the rule
  const Wo = [0, 1, 2].map(() => new Float64Array(S)), So = [0, 1, 2].map(() => new Float64Array(S)), nearDrop = [0, 1, 2].map(() => new Uint8Array(S))
  for (let q = 0; q < n; q++) for (let a = 0; a < 3; a++) faceStencil(L, a, [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]], (s2, w) => {
    Wo[a][s2] += w
    if (disp(q) && w > 0) { So[a][s2] += w * p.slip[3 * q + a]; nearDrop[a][s2] = 1 }
  })
  // wall faces: every face in a window wall's plane (own-axis logical index 0 or n — the ghost layer's edge faces too)
  // and every SOLID face; logical coordinates from this file's own loop over the face range
  const nn = [L.nx, L.ny, L.nz], wall = [0, 1, 2].map(() => new Uint8Array(S))
  for (let a = 0; a < 3; a++) {
    const lo = [-1, -1, -1], hi = [...nn]; lo[a] = 0
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const c = [i, j, k], s2 = L.idx(i, j, k)
      if (c[a] === 0 || c[a] === nn[a] || sim.faceType[a][s2] === SOLID) wall[a][s2] = 1
    }
  }
  const Jo = [0, 1, 2].map(a => So[a].map((v, s2) => (wall[a][s2] || !(Wo[a][s2] >= flipRef.FACE_WEIGHT_MIN) ? 0 : v / Wo[a][s2])))
  const Jf = sim.driftFaceJ
  let wallNonzero = 0, wallTouched = 0, edgeTouched = 0, dW = 0, dJ = 0, jMax = 0
  for (let a = 0; a < 3; a++) for (let s2 = 0; s2 < S; s2++) {
    if (wall[a][s2]) { if (!Jf || Jf[a][s2] !== 0) wallNonzero++; if (nearDrop[a][s2]) { wallTouched++; if (sim.faceType[a][s2] !== SOLID) edgeTouched++ } }
    dW = Math.max(dW, Math.abs(Wo[a][s2] - sim.weight[a][s2])); dJ = Math.max(dJ, Jf ? Math.abs(Jo[a][s2] - Jf[a][s2]) : Infinity); jMax = Math.max(jMax, Math.abs(Jo[a][s2]))
  }
  const nDisp = [...Array(n).keys()].filter(disp).length
  check(wallNonzero === 0 && wallTouched > 0, `W1 J_f = 0 on every wall face (${nDisp} dispersed drops after 0.25 s): ${wallNonzero} wall faces with J ≠ 0 (0); ${wallTouched} wall faces in a drop's stencil (≥ 1), ${edgeTouched} of them ghost-layer edge faces`)
  check(dW <= 1e-12 && dJ <= 1e-12, `W2 face counter-flux = the oracle (S_f/Σw_f, 0 on wall faces and below FACE_WEIGHT_MIN): max |ΔΣw| ${dW.toExponential(2)}, max |ΔJ_f| ${dJ.toExponential(2)} m/s (≤ 1e-12; max |J_f| ${jMax.toExponential(3)} m/s)`)
  // W3 + W4 on flipRef's drift, W4 also on the control's
  const uOracle = new Float64Array(3 * n)
  for (let q = 0; q < n; q++) for (let a = 0; a < 3; a++) { let j = 0; faceStencil(L, a, [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]], (s2, w) => { j += w * Jo[a][s2] }); uOracle[3 * q + a] = (disp(q) ? p.slip[3 * q + a] : 0) - j }
  let dU = 0
  for (let i = 0; i < 3 * n; i++) dU = Math.max(dU, Math.abs(sim.drift[i] - uOracle[i]))
  check(dU <= 1e-12, `W3 every particle's u_V = (dispersed ? s : 0) − Σ w_f·J_f: max |Δu_V| ${dU.toExponential(2)} m/s over ${n} particles (≤ 1e-12)`)
  /** W4's worst ratio: a carrier's wall-ward drift over (d/dx)·max|J_f| of its stencil faces on that axis (≤ 1 passes). */
  const wallRatio = (drift, Jgrid) => {
    let worst = 0, carriers = 0
    for (let q = 0; q < n; q++) {
      if (disp(q)) continue
      const x = [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]]
      for (let a = 0; a < 3; a++) for (const side of [0, 1]) {
        const dWall = side ? L.extent[a] - x[a] : x[a]
        if (!(dWall < DX)) continue
        const toward = side ? drift[3 * q + a] : -drift[3 * q + a]
        if (!(toward > 0)) continue
        let jm = 0
        faceStencil(L, a, x, (s2, w) => { if (w > 0) jm = Math.max(jm, Math.abs(Jgrid[a][s2])) })
        carriers++
        worst = Math.max(worst, toward / ((dWall / DX) * jm + 1e-12))
      }
    }
    return { worst, carriers }
  }
  const wf = wallRatio(sim.drift, Jo)
  // the control from the same state: the cell form (its J lives per cell; the bound uses the face oracle's max, which
  // is what the wall condition allows)
  p.slip.set(slip0); p.drop.set(drop0)
  const ctl = new FlipRef(L, opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: 1e-3, driftForm: 'cell' }))
  ctl.u = sim.u; ctl.faceAccel.forEach((f, a) => f.set(sim.faceAccel[a])); ctl.weight = sim.weight
  ctl.driftFlux(p, DT)
  const wc = wallRatio(ctl.drift, Jo)
  check(wf.worst <= 1 && wc.worst > 1, `W4 carriers next to a wall are not driven into it: worst wall-ward |u_V|/((d/dx)·max|J_f|) ${wf.worst.toFixed(4)} over ${wf.carriers} carrier-axes within dx of a wall (≤ 1); control (cell form, same state) ${wc.worst.toExponential(2)} over ${wc.carriers} (must be > 1)`)
  // W5 (reported): the particle-level remainder of face-level (31)
  p.slip.set(slip0); p.drop.set(drop0)
  const remainder = drift => {
    const R = [0, 1, 2].map(() => new Float64Array(S)), A = [0, 1, 2].map(() => new Float64Array(S))
    for (let q = 0; q < n; q++) for (let a = 0; a < 3; a++) faceStencil(L, a, [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]], (s2, w) => { R[a][s2] += w * drift[3 * q + a]; if (disp(q)) A[a][s2] += w * Math.abs(p.slip[3 * q + a]) })
    let remN = 0, remD = 0, faces = 0
    for (let a = 0; a < 3; a++) for (let s2 = 0; s2 < S; s2++) if (Wo[a][s2] >= 1 && A[a][s2] > 0 && !wall[a][s2]) { remN += Math.abs(R[a][s2]); remD += A[a][s2]; faces++ }
    return { r: remN / remD, faces }
  }
  const rf = remainder(sim.drift), rc = remainder(ctl.drift)
  info(`W5 particle-level remainder of face-level (31): Σ_f |Σ w·u_V| / Σ_f Σ w·|ŝ| ${rf.r.toFixed(4)} over ${rf.faces} non-wall faces with Σw ≥ 1 and drops; the cell form from the same state ${rc.r.toFixed(4)} (reported; the density projection removes it)`)
}

// ── B: balance at rest ────────────────────────────────────────────────────────────────────────────────────────────
if (ONLY !== 'W') for (const [label, heavy, light, key] of [['mercury drops in water over mercury', HG, W, 'mercury|water'], ['water drops in olive oil over water', W, OIL, 'oil|water']]) {
  const nx = 8, ny = 20, nz = 8, h1 = 10, h2 = 8, d = 1e-3, L = new GridLayout({ nx, ny, nz, dx: DX })
  // material 0 the light carrier, 1 the heavy liquid (the drops and the layer below)
  const sim = new FlipRef(L, { ...opts({ 0: light, 1: heavy }, () => SIGMA[key], { dropDiameter: d }), densityProjection: false })
  // the lattice: fill's jitter fixed at ½ puts every particle at its sub-cell centre; q % 8 is the sub-cell (fill loops
  // cells, then their 8 sub-cells)
  const lat = fill(nx, h1 + h2, nz, DX, () => 0.5, (x, y) => (y < h1 * DX ? [heavy.rho, 1] : [light.rho, 0]))
  const p = flipRef.makeParticles(lat.p.n + 4 * nx * nz)
  p.pos.set(lat.p.pos); p.mass.set(lat.p.mass)
  for (let q = 0; q < lat.p.n; q++) p.material[q] = lat.tag[q]
  let q = lat.p.n
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (const [sx, sz] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    p.pos.set([(i + sx) * DX, (h1 + 0.75) * DX, (k + sz) * DX], 3 * q); p.material[q] = 1; p.mass[q] = heavy.rho * VP; q++
  }
  sim.step(p, DT)
  const drops = dropStates(sim, L, p, light, heavy, d, [0, -G, 0])
  const n = drops.length
  if (!n) { check(false, `B ${label}: no dispersed drop after the first step`); continue }
  const cMax = Math.max(...drops.map(st => { const h = DT / ((st.rp + 0.5 * st.rc) * d ** 2 / (18 * st.muM * fRe(st.eq.Re))), r = rEq(st.eq.Re); return Math.abs(Math.exp(-h) * (1 + r) - r) }))
  const steps = Math.ceil(Math.log(1e-12) / Math.log(cMax))
  const [last] = frozenRun({ sim, p, drops }, drops.map(() => [0, 0, 0]), DT, DT, [steps])
  const errs = drops.map((st, i) => dist(last[i], st.ueq) / st.eq.U), worst = Math.max(...errs)
  const Um = drops.reduce((a, st) => a + st.eq.U, 0) / n
  check(worst <= 1e-3, `B balance at rest, ${label}, frozen fields, ${(steps * DT).toFixed(1)} s (${n} drops within a cell of the interface): max |s − u_eq(a = g)|/|u_eq| ${worst.toExponential(2)} (≤ 1e-3); mean u_eq ${Um.toFixed(5)} m/s; median error ${errs.sort((a, b) => a - b)[Math.floor(n / 2)].toExponential(2)}`)
}

// ── S + T: frozen fields ──────────────────────────────────────────────────────────────────────────────────────────
function frozenScene(D, key, d, seed) {
  const nx = 8, ny = 16, nz = 8, L = new GridLayout({ nx, ny, nz, dx: DX })
  const sim = new FlipRef(L, opts({ 0: W, 1: D }, () => SIGMA[key], { dropDiameter: d }))
  const { p } = fill(nx, 12, nz, DX, mulberry32(seed), () => [W.rho, 0])
  for (let q = 0; q < p.n; q++) if (q % 16 === 5) { p.material[q] = 1; p.mass[q] = D.rho * VP }
  sim.step(p, DT)
  const drops = dropStates(sim, L, p, W, D, d)
  return { sim, p, drops }
}
/** Only driftFlux from the slips s0 (per drop), returning the slips at the checkpoints (step counts of dt0). */
function frozenRun(sc, s0, dt, dt0, checkpoints) {
  const { sim, p, drops } = sc, per = Math.round(dt0 / dt), out = []
  p.slip.fill(0)
  drops.forEach((st, i) => { for (let a = 0; a < 3; a++) p.slip[3 * st.q + a] = s0[i][a] })
  let step = 0
  for (const cp of checkpoints) {
    for (; step < cp * per; step++) sim.driftFlux(p, dt)
    out.push(drops.map(st => [p.slip[3 * st.q], p.slip[3 * st.q + 1], p.slip[3 * st.q + 2]]))
  }
  return out
}
const CASES = [
  { label: 'mercury 3 mm in water', D: HG, key: 'mercury|water', d: 3e-3, seed: 91, T: [6, 12, 24, 36, 60], order: true },
  { label: 'olive oil 1 mm in water', D: OIL, key: 'oil|water', d: 1e-3, seed: 92, T: [1, 2, 6, 12, 18], order: true },
  { label: 'olive oil 1 mm in water, released sideways at |u_eq|', D: OIL, key: 'oil|water', d: 1e-3, seed: 92, T: [1, 2, 6, 12, 18], order: true, sideways: true },
  { label: 'olive oil 0.2 mm in water', D: OIL, key: 'oil|water', d: 2e-4, seed: 93, order: false },
]
for (const c of (ONLY === 'W' ? [] : CASES)) {
  const sc = frozenScene(c.D, c.key, c.d, c.seed), n = sc.drops.length
  if (!n) { check(false, `S ${c.label}: no dispersed drop after the first step`); continue }
  const Umean = sc.drops.reduce((s, st) => s + st.eq.U, 0) / n, ReMean = sc.drops.reduce((s, st) => s + st.eq.Re, 0) / n
  const st0 = sc.drops[0], tauEq = (st0.rp + 0.5 * st0.rc) * c.d ** 2 / (18 * st0.muM * fRe(st0.eq.Re))
  const zero = sc.drops.map(() => [0, 0, 0])
  const s0 = c.sideways ? sc.drops.map(st => { const a = st.acc, sd = Math.hypot(a[0], a[2]) > 0 ? [a[2], 0, -a[0]] : [1, 0, 0], m = Math.hypot(...sd); return sd.map(v => v * st.eq.U / m) }) : zero
  if (!c.sideways) {
    // the slowest drop's contraction per step at its fixed point
    const cMax = Math.max(...sc.drops.map(st => {
      const h = DT / ((st.rp + 0.5 * st.rc) * c.d ** 2 / (18 * st.muM * fRe(st.eq.Re))), r = rEq(st.eq.Re)
      return Math.abs(Math.exp(-h) * (1 + r) - r)
    }))
    const steps = Math.ceil(Math.log(1e-12) / Math.log(cMax))
    const [last] = frozenRun(sc, zero, DT, DT, [steps])
    const worst = Math.max(...sc.drops.map((st, i) => dist(last[i], st.ueq) / st.eq.U))
    check(worst <= 1e-6, `S steady slip, ${c.label}, frozen fields, ${(steps * DT).toFixed(1)} s from rest (${n} drops; slowest contraction ${cMax.toFixed(4)}/step): max |s − u_eq|/|u_eq| ${worst.toExponential(2)} (≤ 1e-6); u_eq mean ${Umean.toFixed(5)} m/s at Re ${ReMean.toFixed(1)}; drop 0: Δt/τ_eq ${(DT / tauEq).toFixed(3)}, r = Re·f′/f ${rEq(st0.eq.Re).toFixed(3)}`)
  }
  if (!c.order) continue
  const refs = sc.drops.map((st, i) => rk4(st, s0[i], DT, 1000, c.T))
  const errs = [DT, DT / 2, DT / 4].map(dt => {
    const traj = frozenRun(sc, s0, dt, DT, c.T)
    let e = 0
    traj.forEach((slips, j) => slips.forEach((s, i) => { e = Math.max(e, dist(s, refs[i][j]) / sc.drops[i].eq.U) }))
    return e
  })
  const ok = errs[0] > errs[1] && errs[1] > errs[2] && errs[1] / errs[2] >= Math.SQRT2
  check(ok, `T transient, ${c.label}, frozen fields, ${(c.T[c.T.length - 1] * DT).toFixed(3)} s (${n} drops): max |s − s_RK4|/|u_eq| at Δt 1/120, 1/240, 1/480 = ${errs.map(e => e.toExponential(2)).join(', ')}; observed order ${Math.log2(errs[1] / errs[2]).toFixed(2)} (errors decreasing, finest ratio ≥ √2)`)
}

// ── D-a: the moving simulation ────────────────────────────────────────────────────────────────────────────────────
if (ONLY !== 'W') {
  const d = 1e-3, nx = 16, nz = 8, L = new GridLayout({ nx, ny: 30, nz, dx: DX })
  const sim = new FlipRef(L, opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: d }))
  const { p } = fill(nx, 24, nz, DX, mulberry32(81), () => [W.rho, 0])
  for (let q = 0; q < p.n; q++) if (q % 16 === 5 && p.pos[3 * q + 1] < 10 * DX) { p.material[q] = 1; p.mass[q] = OIL.rho * VP }
  for (let k = 0; k < 180; k++) sim.step(p, DT)
  const drops = dropStates(sim, L, p, W, OIL, d)
  let errSum = 0, ueqMean = 0
  for (const st of drops) { errSum += Math.abs(Math.hypot(p.slip[3 * st.q], p.slip[3 * st.q + 1], p.slip[3 * st.q + 2]) - st.eq.U) / st.eq.U; ueqMean += st.eq.U }
  const n = drops.length, e = errSum / n, dil = equilibrium(d, (W.rho - OIL.rho) * G, W.rho, W.mu)
  check(n > 0 && e <= 0.01, `D-a model slip, 1 mm olive-oil drops in still water (${n} dispersed after 1.5 s): mean |slip − u_eq|/u_eq ${(100 * e).toFixed(3)} % (≤ 1 %; u_eq of (58)+(40)+(43) at each drop's own α, ρ_m, a = g − Du/Dt, mean ${n ? (ueqMean / n).toFixed(5) : '—'} m/s); dilute Schiller–Naumann u_t ${dil.U.toFixed(5)} m/s (Re ${dil.Re.toFixed(1)}) for reference`)
}

// overturn / layered scenes (F1's 16×40×8 tank, 12 + 12 cells)
function layered(lower, upper, key, seconds, seed, immiscible, sample) {
  const nx = 16, nz = 8, h1 = 12, h2 = 12, L = new GridLayout({ nx, ny: 40, nz, dx: DX })
  const o = opts({ 0: lower, 1: upper }, () => (key ? SIGMA[key] : null))
  if (!immiscible) delete o.immiscible
  const sim = new FlipRef(L, o)
  const { p, tag } = fill(nx, h1 + h2, nz, DX, mulberry32(seed), (x, y) => (y < h1 * DX ? [lower.rho, 0] : [upper.rho, 1]))
  for (let q = 0; q < p.n; q++) p.material[q] = tag[q]
  const dt = DT, steps = Math.round(seconds / dt), hist = []
  let everDispersed = 0, maxSlip = 0, maxAccel = 0
  for (let s = 1; s <= steps; s++) {
    sim.step(p, dt)
    everDispersed = Math.max(everDispersed, sim.lastDrift?.dispersed ?? 0)
    maxSlip = Math.max(maxSlip, sim.lastDrift?.maxSlip ?? 0)
    if (immiscible) for (let s2 = 0; s2 < L.size; s2++) maxAccel = Math.max(maxAccel, Math.hypot(sim.faceAccel[0][s2], sim.faceAccel[1][s2], sim.faceAccel[2][s2]))
    if (s % 120 === 0) {
      // "wrong side" relative to the STABLE order: the denser material belongs below h1
      const heavyTag = lower.rho > upper.rho ? 0 : 1
      let wrong = 0
      for (let q = 0; q < p.n; q++) { const y = p.pos[3 * q + 1] / DX; if (tag[q] === heavyTag ? y > h1 + 0.5 : y < h1 - 0.5) wrong++ }
      hist.push({ t: s * dt, wrong: wrong / p.n, vol: sample ? sim.phiVolume() / (p.n * VP) : NaN })
    }
  }
  return { hist, everDispersed, maxSlip, maxAccel, n: p.n }
}

if (!QUICK && ONLY !== 'W') {
  // D-b: oil over water, gentle
  {
    const r = layered(W, OIL, 'oil|water', 11, 101, true, false)
    const last = r.hist[r.hist.length - 1]
    check(r.everDispersed === 0 && last.wrong === 0, `D-b gentle interface, olive oil over water at rest, 11 s (${r.n} particles), Hinze sizing: largest dispersed count ${r.everDispersed} (0), wrong side ${(100 * last.wrong).toFixed(2)} % (0.0 %)`)
  }

  // D-c + V: inverted releases, with and without the model
  for (const [label, lower, upper, key, seconds, seed] of [['water over olive oil', OIL, W, 'oil|water', 15, 72], ['mercury over water', W, HG, 'mercury|water', 8, 71]]) {
    const on = layered(lower, upper, key, seconds, seed, true, key === 'oil|water')
    const off = layered(lower, upper, key, seconds, seed, false, false)
    // context for the largest slip: the terminal speed of the largest sub-grid drop (d → dx) of the heavy liquid in the
    // light one, under g and under the run's largest face acceleration (an upper reference: drops are smaller and the
    // largest |a| is brief)
    const [c, dd] = lower.rho > upper.rho ? [upper, lower] : [lower, upper]
    const ref = equilibrium(DX, Math.abs(dd.rho - c.rho) * G, c.rho, c.mu), refA = equilibrium(DX, Math.abs(dd.rho - c.rho) * on.maxAccel, c.rho, c.mu)
    info(`D-c ${label} released inverted, ${seconds} s: wrong side with the drift flux ${on.hist.filter((h, i) => i % 2 === 1 || i === on.hist.length - 1).map(h => `${h.t.toFixed(0)} s ${(100 * h.wrong).toFixed(1)} %`).join(', ')}; without ${(100 * off.hist[off.hist.length - 1].wrong).toFixed(1)} % at ${seconds} s; largest slip ${on.maxSlip.toFixed(4)} m/s; largest face |a| ${(on.maxAccel / G).toFixed(2)} g (a dx-sized drop's terminal speed: ${ref.U.toFixed(4)} m/s under g, ${refA.U.toFixed(4)} m/s at that |a|) (reported; the hindered-settling reference is not frozen)`)
    if (key === 'oil|water') {
      const worst = Math.max(...on.hist.map(h => Math.abs(h.vol - 1)))
      check(worst <= 0.02, `V volume with the drift flux (${label}): max |φ-volume/N·V_p − 1| ${(100 * worst).toFixed(2)} % over ${seconds} s (≤ 2 %)`)
    }
  }

  // M: a miscible pair never slips
  {
    const r = layered(W, ETH, null, 3, 111, true, false)
    check(r.everDispersed === 0, `M miscible pair (ethanol over water, σ = null): largest dispersed count over 3 s ${r.everDispersed} (0)`)
  }
}

console.log(`\ns3.5-i reference gate${ONLY ? ` (--only=${ONLY})` : QUICK ? ' (quick)' : ''}: ${fails ? `FAIL (${fails})` : 'PASS'}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails ? 1 : 0)
