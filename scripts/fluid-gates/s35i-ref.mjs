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
//     condition load-bearing). Criteria fixed 2026-09-30 01:42 at `089f90df`, before the first run (revised 01:50 and
//     04:42, below). Scene: D-a's (1 mm olive-oil drops, every 16th particle of the lower 10 cells of 24, 16×30×8) after
//     0.25 s, plus W2's two clusters; then P2G at the current positions and ONE driftFlux (frozen fields), so Σw is exact
//     for the drift. Every oracle is computed HERE — its own trilinear face stencil, its own Σw threshold WMIN = 1e-3,
//     its own ball geometry; from the simulation it reads only state (positions, slips, drop flags, face types), never
//     a quantity or constant under test (until 04:42 the threshold was flipRef.FACE_WEIGHT_MIN — see that revision):
//     W1  J_f = 0 exactly on every face of the zero set — every face in a window wall's plane (own-axis index 0 or n,
//         the ghost layer's edge faces included), every SOLID face, every GHOST face whose in-plane mirror (transverse
//         indices clamped into range) is SOLID, and every face with the ball's S_f ≥ 1 — and ≥ 1 of them lies in a
//         dispersed drop's stencil.
//     W2  Σw_f equals flipRef's P2G weight sum and J_f equals the oracle (S_f/Σw_f over the dispersed drops' slips, 0 on
//         the zero set and where Σw_f < WMIN) to ≤ 1e-12 absolute on every face (f64 rounding); and the threshold is
//         exercised — ≥ 1 face off the zero set with S_f ≠ 0 and Σw_f in [WMIN/4, WMIN), ≥ 1 in [WMIN, 4·WMIN): two
//         isolated clusters added after the run, each 3 water carriers low in a cell of row 27 and a 1 mm oil drop at
//         y = (27.5 + δ)·dx, δ = 1e-3 and 4e-3, off the stencil planes (x = i + 0.63, z = k + 0.57 cells), released
//         sideways at 0.01 m/s, more than 2 cells from every wall — only the drop reaches the row-28 x- and z-faces.
//     W3  every particle's u_V equals (dispersed ? s : 0) − J(x_q), J(x_q) = Σ_f w_f·J_f, its normal component ramped to
//         0 within dx of the ball (J −= (1 − max(0, φ)/dx)·(J·n̂)·n̂, φ = |x − c| − R), to ≤ 1e-12 m/s.
//     W4  carriers move normal to a window wall at most as the wall allows (two-sided): every non-dispersed particle
//         within dx of a wall has |u_V·n| ≤ (d/dx)·max|J_f| + 1e-12 (d its distance to the wall, the max over its
//         stencil's faces on that axis) — exact for the rule: its 4 wall-plane faces carry 0, the 4 one cell in weigh
//         d/dx in total. Positive control, same scene and state: the 'cell' form (J per cell, applied by NGP) must
//         VIOLATE it — the check fails if the control passes (a check that the old kernel meets tests nothing).
//     W5  REPORTED: the particle-level remainder of face-level (31), Σ_f |Σ_q w_qf·u_V,q| / Σ_f Σ_q w_qf·|ŝ_q| over the
//         non-wall faces with Σw ≥ 1 — the sub-kernel part (Σ_q w_qf·(J_f − J(x_q))) the density projection removes;
//         over the scene's own particles (the faces W2's clusters reach are theirs alone).
//     W1m–W4m  W1–W4 on the W scene reflected through the box centre (every coordinate x_a → extent_a − x_a, gravity +y,
//         the clusters with it): the planes at own-axis index n take the floor's and the lower planes' part.
//     Wb  a held ball (weak coupling, never integrated) among the drops: 16×28×16 filled 18 cells deep, no particle inside
//         the ball, R = 3dx at (8.3, 7.4, 7.7)·dx, mulberry32(81), the drops every 16th particle below 14·dx, 0.25 s. The
//         ball's S_f is this file's own 2×2×2 box (subsamples at ±dx/4, each clamp(½ − d/(dx/2), 0, 1) of its signed
//         distance d). Wb1 J_f = 0 on every face with S_f ≥ 1, ≥ 1 of them with Σw ≥ WMIN in a dispersed drop's
//         stencil. Wb2, Wb3 W2 and W3 with the ball (S_f also equal to flipRef's solidFraction to 1e-12). Wb4 every
//         carrier within dx of the ball has |u_V·n̂| ≤ (φ/dx)·Σ_a |n̂_a|·max_f|J_f,a| + 1e-12 (the max over its own
//         stencil faces per axis) — exact for the ramp; positive control: the same state's u_V without the ramp (the
//         oracle's) must violate it. The shell's |J·n̂| is reported.
//     Wg  the dam-break gate, in a scene of its own (a gate and a ball together throw): 16×20×8 filled 16 cells deep, the
//         gate at x-face plane 8 lifting at 1e-4 m/s (its edge 0.025 mm at 0.25 s: every row closed), the drops as in W,
//         on both sides. Wg1 J_f = 0 on the plane's closed faces — every x-face at i = 8 whose row (j clamped into
//         [0, ny)) has its centre above the edge, from the geometry — ghost-layer edge faces included; ≥ 1 in-window and
//         ≥ 1 edge face with Σw ≥ WMIN in a drop's stencil. Wg2, Wg3 W2 and W3 there (the mirror rule's scene). Wg4 W4 at
//         the gate plane, two-sided, for the carriers within dx of it whose stencil's faces on it are all closed;
//         positive control: the oracle without the mirror rule (the pre-fix rule) must violate it.
//     Revision 2026-09-30 01:50, after the first run (FAIL W4: 35× the bound, W1–W3 exact): the wall planes' edge faces in
//     the ghost layer are GHOST, not SOLID, in GridLayout.defaultFaceTypes, and W1/W2 had encoded the implementation's
//     "SOLID only" rule — so J_n did not vanish at a wall next to a corner. The implementation now zeroes every face in a
//     wall's plane; W1/W2 name the same physical set (J·n = 0 holds on the whole plane); W4, the physical criterion, is
//     unchanged.
//     Revision 2026-09-30 04:42 (review wf_c8d4ee53-cb7, findings #1, #2, #4, #7, #8, #10, #19). The criteria come from the
//     verified reviewers' recipes and were fixed before this revision's first run, on the code with the review's two
//     flipRef fixes (the mirror clause, #4; the ball's ramp, #1). Added: WMIN as this file's literal — the oracle had read
//     flipRef.FACE_WEIGHT_MIN from the module under test, so a changed constant passed W, and "independently of flipRef"
//     held only for the stencil (#10); W2's threshold coverage and its clusters — the scene had no face with
//     0 < Σw < WMIN that a drop reaches, so a bare Σw > 0 guard passed W and the "rule dropped" mutant was caught only by
//     0/0 → NaN on faces no particle reads (#10); the mirror rule and the ball's faces in the zero set (#2, #4, #7), the
//     ramp in W3's oracle (#1); W4 two-sided and W1m–W4m — the wall-ward part alone, in a scene whose drops reach no
//     upper plane, let a mistake that the rule and W1/W2 share at own-axis index n pass (#8); the arms Wb (#1, #2, #7)
//     and Wg (#2, #4).
//     Disclosure (#19): W5 (reported) was also changed after the first run, which the 01:50 note does not say — its max_f
//     over the non-SOLID faces became the aggregate Σ_f/Σ_f over the non-wall faces (the max, ~855, was dominated by
//     faces with near-zero Σw·|ŝ|), and the cell form's value was added at 01:46. "Fixed … before the first run" above
//     holds for W1–W4 only.
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
/** W2's Σw threshold: this file's own literal, the value fixed at 01:42 — not flipRef.FACE_WEIGHT_MIN, the module under
 *  test (read from there, a change of that constant passed W: review 2026-09-30 #10). */
const WMIN = 1e-3
const g3 = (T, size) => [0, 1, 2].map(() => new T(size))
const xOf = (p, q) => [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]]
/** flipRef's face J, or NaN on every face when it kept none (the cell form): every comparison then fails, none throws. */
const faceJ = (sim, size) => sim.driftFaceJ ?? g3(Float64Array, size).map(g => g.fill(NaN))
/** Visit the 8 faces of grid `a` in the trilinear stencil of x (the MAC face offsets: 0 on axis a, ½ on the others). */
function faceStencil(L, a, x, fn) {
  const f = x.map((v, b) => v / DX - (a === b ? 0 : 0.5)), b0 = f.map(Math.floor), t = f.map((v, b) => v - b0[b])
  for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++)
    fn(L.idx(b0[0] + di, b0[1] + dj, b0[2] + dk), (di ? t[0] : 1 - t[0]) * (dj ? t[1] : 1 - t[1]) * (dk ? t[2] : 1 - t[2]), [b0[0] + di, b0[1] + dj, b0[2] + dk])
}
/** Every face (a; i, j, k) of the three MAC grids over its logical range, ghost layers included — this file's own loop. */
function forFaces(L, fn) {
  const nn = [L.nx, L.ny, L.nz]
  for (let a = 0; a < 3; a++) {
    const lo = [-1, -1, -1], hi = [...nn]; lo[a] = 0
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) fn(a, i, j, k, L.idx(i, j, k))
  }
}
/** The ball's solid fraction S_f of every face's dx³ control volume, computed HERE (not flipRef.solidFraction): 2×2×2
 *  subsamples at ±dx/4 about the face centre, each the partial volume clamp(½ − d/(dx/2), 0, 1) of its signed distance d
 *  to the sphere — the definition flipRef.sphereFractions documents, in this file's own code. */
function ballFractions(L, ball) {
  const sf = g3(Float64Array, L.size)
  forFaces(L, (a, i, j, k, s2) => {
    const f = [i, j, k].map((v, b) => (v + (b === a ? 0 : 0.5)) * DX)
    let v = 0
    for (const ox of [-0.25, 0.25]) for (const oy of [-0.25, 0.25]) for (const oz of [-0.25, 0.25]) {
      const d = Math.hypot(f[0] + ox * DX - ball.c[0], f[1] + oy * DX - ball.c[1], f[2] + oz * DX - ball.c[2]) - ball.R
      v += Math.min(1, Math.max(0, 0.5 - d / (DX / 2)))
    }
    sf[a][s2] = v / 8
  })
  return sf
}
/** The W oracle, computed HERE: Σw and S_f from every particle with this file's stencil, the zero set, and J_f = 0 on it
 *  and where Σw < WMIN, S_f/Σw elsewhere. Zero set: every face in a window wall's plane (own-axis index 0 or n, the
 *  ghost layer's edge faces included), every SOLID face, every GHOST face whose in-plane mirror (transverse indices
 *  clamped into range) is SOLID — the gate plane's ghost-layer edges (review #4; mirrorRule false: the pre-fix rule,
 *  Wg4's control) — and, with a ball, every face with this file's S_f ≥ 1. The face types are the simulation's STATE
 *  (defaultFaceTypes, the gate's rows), not a result under test. */
function wOracle(L, sim, p, { ball = null, mirrorRule = true } = {}) {
  const S = L.size, nn = [L.nx, L.ny, L.nz], { SOLID, GHOST } = gridLayout.FaceType
  const Wo = g3(Float64Array, S), So = g3(Float64Array, S), nearDrop = g3(Uint8Array, S)
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) faceStencil(L, a, xOf(p, q), (s2, w) => {
    Wo[a][s2] += w
    if (p.drop[q] > 0 && w > 0) { So[a][s2] += w * p.slip[3 * q + a]; nearDrop[a][s2] = 1 }
  })
  const sfo = ball ? ballFractions(L, ball) : null, zero = g3(Uint8Array, S), cl = (v, m) => (v < 0 ? 0 : v >= m ? m - 1 : v)
  forFaces(L, (a, i, j, k, s2) => {
    const c = [i, j, k], t = sim.faceType[a]
    const ghostMirrorSolid = t[s2] === GHOST && t[L.idx(a === 0 ? i : cl(i, L.nx), a === 1 ? j : cl(j, L.ny), a === 2 ? k : cl(k, L.nz))] === SOLID
    if (c[a] === 0 || c[a] === nn[a] || t[s2] === SOLID || (mirrorRule && ghostMirrorSolid) || (sfo !== null && sfo[a][s2] >= 1)) zero[a][s2] = 1
  })
  const Jo = So.map((Sa, a) => Sa.map((v, s2) => (zero[a][s2] || !(Wo[a][s2] >= WMIN) ? 0 : v / Wo[a][s2])))
  return { Wo, So, nearDrop, sfo, zero, Jo }
}
/** Each particle's u_V from face values Jg: (dispersed ? s : 0) − J(x_q), J(x_q) = Σ_f w_f·Jg_f with this file's stencil;
 *  with `ball`, within dx of its surface J −= (1 − max(0, φ)/dx)·(J·n̂)·n̂, φ = |x − c| − R, n̂ = (x − c)/|x − c| — the
 *  ramp of review #1 (without `ball`: none, Wb4's control). */
function driftOf(L, p, Jg, ball = null) {
  const u = new Float64Array(3 * p.n)
  for (let q = 0; q < p.n; q++) {
    const x = xOf(p, q), J = [0, 1, 2].map(a => { let v = 0; faceStencil(L, a, x, (s2, w) => { v += w * Jg[a][s2] }); return v })
    if (ball) {
      const e = x.map((v, a) => v - ball.c[a]), r = Math.hypot(...e), phi = r - ball.R
      if (phi < DX && r > 0) {
        const nh = e.map(v => v / r), jn = J[0] * nh[0] + J[1] * nh[1] + J[2] * nh[2], ramp = (1 - Math.max(0, phi) / DX) * jn
        for (let a = 0; a < 3; a++) J[a] -= ramp * nh[a]
      }
    }
    for (let a = 0; a < 3; a++) u[3 * q + a] = (p.drop[q] > 0 ? p.slip[3 * q + a] : 0) - J[a]
  }
  return u
}
/** W4's worst ratio, two-sided (review #8): a carrier's |u_V,a| within dx of a window wall over (d/dx)·max|J_f| of its
 *  stencil's faces on that axis (≤ 1 passes). */
function wallRatio(L, p, drift, Jg) {
  let worst = 0, carriers = 0
  for (let q = 0; q < p.n; q++) {
    if (p.drop[q] > 0) continue
    const x = xOf(p, q)
    for (let a = 0; a < 3; a++) for (const side of [0, 1]) {
      const dWall = side ? L.extent[a] - x[a] : x[a]
      if (!(dWall < DX)) continue
      let jm = 0
      faceStencil(L, a, x, (s2, w) => { if (w > 0) jm = Math.max(jm, Math.abs(Jg[a][s2])) })
      carriers++
      worst = Math.max(worst, Math.abs(drift[3 * q + a]) / ((dWall / DX) * jm + 1e-12))
    }
  }
  return { worst, carriers }
}
/** D-a's oil cloud in the 16×30×8 tank; `reflected`: the same fill reflected through the box centre with gravity +y, so
 *  the planes at own-axis index n take the floor's and the lower planes' part (review #8). */
function wScene(reflected) {
  const d = 1e-3, nx = 16, nz = 8, L = new GridLayout({ nx, ny: 30, nz, dx: DX })
  const sim = new FlipRef(L, { ...opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: d, driftForm: 'face' }), gravity: [0, reflected ? G : -G, 0] })
  const { p } = fill(nx, 24, nz, DX, mulberry32(81), () => [W.rho, 0])
  for (let q = 0; q < p.n; q++) if (q % 16 === 5 && p.pos[3 * q + 1] < 10 * DX) { p.material[q] = 1; p.mass[q] = OIL.rho * VP }
  if (reflected) for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) p.pos[3 * q + a] = L.extent[a] - p.pos[3 * q + a]
  return { L, sim, p }
}
/** W2's Σw-threshold coverage (review #10): the particles with two isolated clusters appended — each 3 water carriers low
 *  in a cell of row 27 and one 1 mm oil drop at y = (27.5 + δ)·dx, δ = 1e-3 and 4e-3, off the stencil planes (x = i +
 *  0.63, z = k + 0.57 cells), released sideways at 0.01 m/s; more than 2 cells from every wall and 3 rows above the
 *  liquid, so nothing else reaches them. Only the drop reaches the row-28 x- and z-faces, with Σw ≈ δ·w_x·w_z: below
 *  and above WMIN. Reflected with the scene. */
function withClusters(L, p, reflected) {
  const add = []
  for (const [i, k, delta] of [[4, 2, 1e-3], [11, 4, 4e-3]]) {
    for (let r = 0; r < 3; r++) add.push({ x: [i + 0.41 + 0.09 * r, 27.21 + 0.03 * r, k + 0.53], mat: 0, slip: [0, 0, 0] })
    add.push({ x: [i + 0.63, 27.5 + delta, k + 0.57], mat: 1, slip: [0.01, 0, 0.01] })
  }
  const n0 = p.n, P = flipRef.makeParticles(n0 + add.length)
  P.pos.set(p.pos.subarray(0, 3 * n0)); P.vel.set(p.vel.subarray(0, 3 * n0)); P.c.forEach((c, a) => c.set(p.c[a].subarray(0, 3 * n0)))
  P.mass.set(p.mass.subarray(0, n0)); P.material.set(p.material.subarray(0, n0)); P.enthalpy.set(p.enthalpy.subarray(0, n0))
  P.slip = new Float64Array(3 * P.n); P.slip.set(p.slip.subarray(0, 3 * n0))
  P.drop = new Float64Array(P.n); P.drop.set(p.drop.subarray(0, n0))
  add.forEach((c, m) => {
    const q = n0 + m
    for (let a = 0; a < 3; a++) { P.pos[3 * q + a] = reflected ? L.extent[a] - c.x[a] * DX : c.x[a] * DX; P.slip[3 * q + a] = reflected ? -c.slip[a] : c.slip[a] }
    P.material[q] = c.mat; P.mass[q] = (c.mat ? OIL.rho : W.rho) * VP
  })
  return P
}
/** W1–W4 on the W scene (W1m–W4m reflected), W5 on the unreflected one. */
function wRun(reflected) {
  const tag = reflected ? 'm' : '', where = reflected ? ', mirrored scene' : ''
  const { L, sim, p: p0 } = wScene(reflected)
  for (let k = 0; k < 30; k++) sim.step(p0, DT)
  const n0 = p0.n, p = withClusters(L, p0, reflected)
  sim.p2g(p)
  const slip0 = p.slip.slice(), drop0 = p.drop.slice()
  sim.driftFlux(p, DT)
  const S = L.size, n = p.n, disp = q => p.drop[q] > 0, SOLID = gridLayout.FaceType.SOLID
  const { Wo, So, nearDrop, zero, Jo } = wOracle(L, sim, p), Jf = faceJ(sim, S)
  let wallNonzero = 0, wallTouched = 0, edgeTouched = 0, dW = 0, dJ = 0, jMax = 0, below = 0, above = 0
  for (let a = 0; a < 3; a++) for (let s2 = 0; s2 < S; s2++) {
    if (zero[a][s2]) { if (Jf[a][s2] !== 0) wallNonzero++; if (nearDrop[a][s2]) { wallTouched++; if (sim.faceType[a][s2] !== SOLID) edgeTouched++ } }
    else if (So[a][s2] !== 0 && Wo[a][s2] >= WMIN / 4 && Wo[a][s2] < 4 * WMIN) { if (Wo[a][s2] < WMIN) below++; else above++ }
    dW = Math.max(dW, Math.abs(Wo[a][s2] - sim.weight[a][s2])); dJ = Math.max(dJ, Math.abs(Jo[a][s2] - Jf[a][s2])); jMax = Math.max(jMax, Math.abs(Jo[a][s2]))
  }
  let nDisp = 0, nClus = 0
  for (let q = 0; q < n; q++) if (disp(q)) { if (q < n0) nDisp++; else nClus++ }
  check(wallNonzero === 0 && wallTouched > 0, `W1${tag} J_f = 0 on every wall face${where} (${nDisp} dispersed drops after 0.25 s, ${nClus} in W2's clusters): ${wallNonzero} wall faces with J ≠ 0 (0); ${wallTouched} wall faces in a drop's stencil (≥ 1), ${edgeTouched} of them ghost-layer edge faces`)
  check(dW <= 1e-12 && dJ <= 1e-12 && below >= 1 && above >= 1, `W2${tag} face counter-flux = the oracle (S_f/Σw_f, 0 on the zero set and where Σw_f < WMIN = 1e-3)${where}: max |ΔΣw| ${dW.toExponential(2)}, max |ΔJ_f| ${dJ.toExponential(2)} m/s (≤ 1e-12; max |J_f| ${jMax.toExponential(3)} m/s); the threshold exercised: ${below} faces off the zero set with S_f ≠ 0 and Σw in [WMIN/4, WMIN), ${above} in [WMIN, 4·WMIN) (each ≥ 1)`)
  const uO = driftOf(L, p, Jo)
  let dU = 0
  for (let i = 0; i < 3 * n; i++) dU = Math.max(dU, Math.abs(sim.drift[i] - uO[i]))
  check(dU <= 1e-12, `W3${tag} every particle's u_V = (dispersed ? s : 0) − Σ w_f·J_f${where}: max |Δu_V| ${dU.toExponential(2)} m/s over ${n} particles (≤ 1e-12)`)
  const wf = wallRatio(L, p, sim.drift, Jo)
  // the control from the same state: the cell form (its J lives per cell; the bound uses the face oracle's max, which
  // is what the wall condition allows)
  p.slip.set(slip0); p.drop.set(drop0)
  const ctl = new FlipRef(L, { ...opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: 1e-3, driftForm: 'cell' }), gravity: [...sim.gravity] })
  ctl.u = sim.u; ctl.faceAccel.forEach((f, a) => f.set(sim.faceAccel[a])); ctl.weight = sim.weight
  ctl.driftFlux(p, DT)
  const wc = wallRatio(L, p, ctl.drift, Jo)
  check(wf.worst <= 1 && wc.worst > 1, `W4${tag} carriers next to a wall move normal to it at most as the wall allows${where}: worst |u_V·n|/((d/dx)·max|J_f|) ${wf.worst.toFixed(4)} over ${wf.carriers} carrier-axes within dx of a wall (≤ 1, two-sided); control (cell form, same state) ${wc.worst.toExponential(2)} over ${wc.carriers} (must be > 1)`)
  if (reflected) return
  // W5 (reported): the particle-level remainder of face-level (31), over the scene's own particles (the faces W2's
  // clusters reach are theirs alone, so the value is the quantity reported since 01:46)
  p.slip.set(slip0); p.drop.set(drop0)
  const remainder = drift => {
    const R = g3(Float64Array, S), A = g3(Float64Array, S)
    for (let q = 0; q < n0; q++) for (let a = 0; a < 3; a++) faceStencil(L, a, xOf(p, q), (s2, w) => { R[a][s2] += w * drift[3 * q + a]; if (disp(q)) A[a][s2] += w * Math.abs(p.slip[3 * q + a]) })
    let remN = 0, remD = 0, faces = 0
    for (let a = 0; a < 3; a++) for (let s2 = 0; s2 < S; s2++) if (Wo[a][s2] >= 1 && A[a][s2] > 0 && !zero[a][s2]) { remN += Math.abs(R[a][s2]); remD += A[a][s2]; faces++ }
    return { r: remN / remD, faces }
  }
  const rf = remainder(sim.drift), rc = remainder(ctl.drift)
  info(`W5 particle-level remainder of face-level (31): Σ_f |Σ w·u_V| / Σ_f Σ w·|ŝ| ${rf.r.toFixed(4)} over ${rf.faces} non-wall faces with Σw ≥ 1 and drops; the cell form from the same state ${rc.r.toFixed(4)} (reported; the density projection removes it)`)
}
wRun(false)
wRun(true)

// Wb: a held ball among the drops (review #1, #2, #7) — the ball clause (S_f ≥ 1) and the ramp at its surface
{
  const nx = 16, ny = 28, nz = 16, c = [8.3 * DX, 7.4 * DX, 7.7 * DX], ball = { c, R: 3 * DX }, L = new GridLayout({ nx, ny, nz, dx: DX })
  const sim = new FlipRef(L, opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: 1e-3, driftForm: 'face' }))
  // a rest fill 18 cells deep with the particles inside the ball removed (s31c2-ref's pool), the drops every 16th particle
  // below 14·dx, around the ball; the ball held — weak coupling (the default), never integrated, its velocity stays 0
  const { p: all } = fill(nx, 18, nz, DX, mulberry32(81), () => [W.rho, 0])
  const keep = []
  for (let q = 0; q < all.n; q++) if (Math.hypot(all.pos[3 * q] - c[0], all.pos[3 * q + 1] - c[1], all.pos[3 * q + 2] - c[2]) >= ball.R) keep.push(q)
  const p = flipRef.makeParticles(keep.length)
  keep.forEach((q, i) => { p.pos.set(all.pos.subarray(3 * q, 3 * q + 3), 3 * i); p.mass[i] = all.mass[q] })
  for (let q = 0; q < p.n; q++) if (q % 16 === 5 && p.pos[3 * q + 1] < 14 * DX) { p.material[q] = 1; p.mass[q] = OIL.rho * VP }
  sim.sphere = { center: [...c], radius: ball.R, velocity: [0, 0, 0] }
  for (let k = 0; k < 30; k++) sim.step(p, DT)
  sim.sphereFractions()
  sim.p2g(p)
  sim.driftFlux(p, DT)
  const S = L.size, n = p.n, disp = q => p.drop[q] > 0
  const { Wo, nearDrop, sfo, Jo } = wOracle(L, sim, p, { ball }), Jf = faceJ(sim, S)
  let inBall = 0, inBallNonzero = 0, reached = 0, dW = 0, dS = 0, dJ = 0, jMax = 0
  for (let a = 0; a < 3; a++) for (let s2 = 0; s2 < S; s2++) {
    if (sfo[a][s2] >= 1) { inBall++; if (Jf[a][s2] !== 0) inBallNonzero++; if (nearDrop[a][s2] && Wo[a][s2] >= WMIN) reached++ }
    dW = Math.max(dW, Math.abs(Wo[a][s2] - sim.weight[a][s2])); dS = Math.max(dS, Math.abs(sfo[a][s2] - sim.solidFraction[a][s2]))
    dJ = Math.max(dJ, Math.abs(Jo[a][s2] - Jf[a][s2])); jMax = Math.max(jMax, Math.abs(Jo[a][s2]))
  }
  const nDisp = [...Array(n).keys()].filter(disp).length
  check(inBallNonzero === 0 && reached >= 1, `Wb1 J_f = 0 inside the ball (held, R = 3dx; ${nDisp} dispersed drops around it after 0.25 s): ${inBallNonzero} of the ${inBall} faces with S_f ≥ 1 (this file's box) have J ≠ 0 (0); ${reached} of them with Σw ≥ WMIN in a dispersed drop's stencil (≥ 1)`)
  check(dW <= 1e-12 && dS <= 1e-12 && dJ <= 1e-12, `Wb2 face counter-flux = the oracle with the ball (0 where S_f ≥ 1): max |ΔΣw| ${dW.toExponential(2)}, max |ΔS_f| (flipRef's solidFraction) ${dS.toExponential(2)}, max |ΔJ_f| ${dJ.toExponential(2)} m/s (≤ 1e-12; max |J_f| ${jMax.toExponential(3)} m/s)`)
  const uO = driftOf(L, p, Jo, ball)
  let dU = 0
  for (let i = 0; i < 3 * n; i++) dU = Math.max(dU, Math.abs(sim.drift[i] - uO[i]))
  check(dU <= 1e-12, `Wb3 every particle's u_V = (dispersed ? s : 0) − J(x_q), J·n̂ ramped to 0 at the ball's surface: max |Δu_V| ${dU.toExponential(2)} m/s over ${n} particles (≤ 1e-12)`)
  /** Wb4: a carrier within dx of the ball, |u_V·n̂| over (φ/dx)·Σ_a |n̂_a|·max|J_f,a| of its own stencil faces per axis. */
  const ballRatio = drift => {
    let worst = 0, carriers = 0, sumN = 0, sumAbs = 0
    for (let q = 0; q < n; q++) {
      if (disp(q)) continue
      const x = xOf(p, q), e = x.map((v, a) => v - c[a]), r = Math.hypot(...e), phi = r - ball.R
      if (!(phi < DX) || !(r > 0)) continue
      const nh = e.map(v => v / r), un = Math.abs(drift[3 * q] * nh[0] + drift[3 * q + 1] * nh[1] + drift[3 * q + 2] * nh[2])
      let bound = 0
      for (let a = 0; a < 3; a++) { let jm = 0; faceStencil(L, a, x, (s2, w) => { if (w > 0) jm = Math.max(jm, Math.abs(Jo[a][s2])) }); bound += Math.abs(nh[a]) * jm }
      carriers++; sumN += un; sumAbs += Math.hypot(drift[3 * q], drift[3 * q + 1], drift[3 * q + 2])
      worst = Math.max(worst, un / ((Math.max(0, phi) / DX) * bound + 1e-12))
    }
    return { worst, carriers, meanN: sumN / carriers, meanAbs: sumAbs / carriers }
  }
  const bf = ballRatio(sim.drift), bc = ballRatio(driftOf(L, p, Jo))
  check(bf.carriers > 0 && bf.worst <= 1 && bc.worst > 1, `Wb4 carriers next to the ball move normal to it at most as the ramp allows: worst |u_V·n̂|/((φ/dx)·Σ_a |n̂_a|·max|J_f,a|) ${bf.worst.toFixed(4)} over ${bf.carriers} carriers within dx of it (≤ 1); control (the same state's u_V without the ramp) ${bc.worst.toExponential(2)} (must be > 1)`)
  info(`Wb ball shell (the ${bc.carriers} carriers within dx): mean |J·n̂| ${bc.meanN.toExponential(3)} m/s = ${(bc.meanN / bc.meanAbs).toFixed(3)} of mean |J| without the ramp (the faces the surface cuts keep their J); with it mean |u_V·n̂| ${bf.meanN.toExponential(3)} m/s (reported)`)
}

// Wg: the dam-break gate's plane (review #4, #2) — a scene of its own: a gate and a ball together throw (applyGate)
{
  const nx = 16, ny = 20, nz = 8, GI = 8, SPEED = 1e-4, STEPS = 30, xg = GI * DX, L = new GridLayout({ nx, ny, nz, dx: DX })
  const sim = new FlipRef(L, { ...opts({ 0: W, 1: OIL }, () => SIGMA['oil|water'], { dropDiameter: 1e-3, driftForm: 'face' }), gate: { i: GI, speed: SPEED } })
  const { p } = fill(nx, 16, nz, DX, mulberry32(81), () => [W.rho, 0])
  for (let q = 0; q < p.n; q++) if (q % 16 === 5 && p.pos[3 * q + 1] < 10 * DX) { p.material[q] = 1; p.mass[q] = OIL.rho * VP }
  for (let k = 0; k < STEPS; k++) sim.step(p, DT)
  sim.p2g(p)
  sim.driftFlux(p, DT)
  const S = L.size, n = p.n
  // the plane's closed faces from the geometry, not the face types: the last step's edge (applyGate takes it at
  // mid-step) and every x-face at i = GI whose row — j clamped into [0, ny), so a ghost-layer edge face follows the row
  // it borders — has its centre above it
  const yEdge = SPEED * (STEPS - 0.5) * DT, closed = new Uint8Array(S), edge = new Uint8Array(S)
  let rowsClosed = 0
  for (let j = 0; j < ny; j++) if ((j + 0.5) * DX > yEdge) rowsClosed++
  for (let k = -1; k <= nz; k++) for (let j = -1; j <= ny; j++) if ((Math.min(Math.max(j, 0), ny - 1) + 0.5) * DX > yEdge) {
    const s2 = L.idx(GI, j, k)
    closed[s2] = 1
    if (j < 0 || j >= ny || k < 0 || k >= nz) edge[s2] = 1
  }
  const { Wo, nearDrop, Jo } = wOracle(L, sim, p), Jf = faceJ(sim, S)
  let closedNonzero = 0, nClosed = 0, nEdge = 0, inReached = 0, edgeReached = 0, dW = 0, dJ = 0, jMax = 0
  for (let s2 = 0; s2 < S; s2++) if (closed[s2]) {
    nClosed++
    if (edge[s2]) nEdge++
    if (Jf[0][s2] !== 0) closedNonzero++
    if (nearDrop[0][s2] && Wo[0][s2] >= WMIN) { if (edge[s2]) edgeReached++; else inReached++ }
  }
  for (let a = 0; a < 3; a++) for (let s2 = 0; s2 < S; s2++) {
    dW = Math.max(dW, Math.abs(Wo[a][s2] - sim.weight[a][s2])); dJ = Math.max(dJ, Math.abs(Jo[a][s2] - Jf[a][s2])); jMax = Math.max(jMax, Math.abs(Jo[a][s2]))
  }
  let left = 0, right = 0
  for (let q = 0; q < n; q++) if (p.drop[q] > 0) { if (p.pos[3 * q] < xg) left++; else right++ }
  check(closedNonzero === 0 && inReached >= 1 && edgeReached >= 1, `Wg1 J_f = 0 on the gate plane's closed faces, ghost-layer edges included (gate at x-face ${GI} lifting at ${SPEED} m/s: edge ${(yEdge * 1e3).toFixed(4)} mm after ${STEPS} steps, ${rowsClosed}/${ny} rows closed; dispersed drops ${left} left and ${right} right of it): ${closedNonzero} of the ${nClosed} closed faces (${nEdge} ghost-layer edge faces) with J ≠ 0 (0); ${inReached} in-window and ${edgeReached} edge faces with Σw ≥ WMIN in a drop's stencil (each ≥ 1)`)
  check(dW <= 1e-12 && dJ <= 1e-12, `Wg2 face counter-flux = the oracle with the gate (its closed rows SOLID, their ghost-layer edges by the mirror rule): max |ΔΣw| ${dW.toExponential(2)}, max |ΔJ_f| ${dJ.toExponential(2)} m/s (≤ 1e-12; max |J_f| ${jMax.toExponential(3)} m/s)`)
  const uO = driftOf(L, p, Jo)
  let dU = 0
  for (let i = 0; i < 3 * n; i++) dU = Math.max(dU, Math.abs(sim.drift[i] - uO[i]))
  check(dU <= 1e-12, `Wg3 every particle's u_V = (dispersed ? s : 0) − Σ w_f·J_f with the gate: max |Δu_V| ${dU.toExponential(2)} m/s over ${n} particles (≤ 1e-12)`)
  /** Wg4: a carrier within dx of the gate plane whose x-stencil's faces on it are all closed — |u_V,x| over
   *  (d/dx)·max|J_f,x| of its stencil faces (the plane's 4 carry 0, the 4 one cell off weigh d/dx). */
  const gateRatio = drift => {
    let worst = 0, carriers = 0
    for (let q = 0; q < n; q++) {
      if (p.drop[q] > 0) continue
      const x = xOf(p, q), d = Math.abs(x[0] - xg)
      if (!(d < DX)) continue
      let allClosed = true, jm = 0
      faceStencil(L, 0, x, (s2, w, cc) => { if (cc[0] === GI && !closed[s2]) allClosed = false; if (w > 0) jm = Math.max(jm, Math.abs(Jo[0][s2])) })
      if (!allClosed) continue
      carriers++
      worst = Math.max(worst, Math.abs(drift[3 * q]) / ((d / DX) * jm + 1e-12))
    }
    return { worst, carriers }
  }
  const gf = gateRatio(sim.drift), gc = gateRatio(driftOf(L, p, wOracle(L, sim, p, { mirrorRule: false }).Jo))
  check(gf.carriers > 0 && gf.worst <= 1 && gc.worst > 1, `Wg4 carriers next to the closed gate move normal to it at most as a wall allows: worst |u_V,x|/((d/dx)·max|J_f,x|) ${gf.worst.toFixed(4)} over ${gf.carriers} carriers within dx of the plane (≤ 1, two-sided); control (the oracle without the mirror rule — the pre-fix rule — same state) ${gc.worst.toExponential(2)} over ${gc.carriers} (must be > 1)`)
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
