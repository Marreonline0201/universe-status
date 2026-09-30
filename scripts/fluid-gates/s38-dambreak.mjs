#!/usr/bin/env node
// Gate S3.8, the dam-break part — the floor's wall shear (FlipRef options.wallShear = { wall: 'y-', law: 'keulegan1938' },
// flipRef.ts applyWallShear) in the S3.4 column-collapse scenes and in a still pool, on the f64 CPU reference. Spec: vault
// fluid/realism-2026-09/FRICTION-spec.md, revision 2 — §4 W2b–W2e (REPORTED: never gated, never tuned) and W3's CPU
// pool energy check (GATED, its must-fail control in the same run).
//
//   node scripts/fluid-gates/s38-dambreak.mjs [--water-temp=<°C>] [--only=W2b,W2c,W2d,W2e,W3P1]
//
// Where W2/W3 live. W2a (A2g with the stage on — the dam-break gate), W3 D1 and the other s34-ref sections with the stage
// on run in s34-ref.mjs itself, behind --wall-shear=keulegan1938 [--water-temp=25]: its own A2g and D1 code and criteria,
// never copied (its header pre-registers the stage-on rules). This file holds only what s34-ref has no section for; it
// has no A2g criterion.
// Harness: s34-ref's solver (lib/s34solver.mjs s34Opts), its scene builders (lib/s34scenes.mjs column(), block() — never
// copied, spec §3.6) and its scorer (lib/s34metrics.mjs columnScore): every slope here is columnScore's least-squares
// dZ/dT over the run's own samples inside the window.
// Water. --water-temp=<°C> sets the column scenes' water: ρ = waterDensity(T), μ = LIQUIDS.water.viscosity(T)
// (src/composition/materialData.ts, the NIST WebBook isobar at 0.101325 MPa) as each particle's mass ρ·V_p
// (column({ rho })), the solver's density and its viscosityDefault (the stage's μ: the particles carry none); absent, the
// solver default, the NIST 20 °C row. Every W2 line names its water. The spec's scratch evidence is at 20 °C; its runs
// against Lobovský use his 25 °C (§2.1). The pool (W3P1) is P1's water, 20 °C, whatever --water-temp says (P1 is a page
// gate; the page's solver is built with waterDensity(20), backends.ts:282).
// Each W2 item runs the stage on and off at the same water, cells and release; each stage-on run's non-vacuity (spec §4:
// cell-applications > 0 and Σ|booked| = Σ over steps of |impX| + |impZ| > 0) is printed with it, and each stage-off
// run's log must be empty. A reported item whose stage-on run is vacuous, or whose stage-off run is not off, prints VOID.
// Criteria fixed 2026-09-30, written here before this file's first run. Output: `PASS|FAIL|INFO|VOID <label> …`; a
// `PASS ctl:<label>` line is a positive control that FAILED its criterion, as required.
//
// W2b  the late slope (spec W2b, REPORTED): dZ/dT on T ∈ [1, 3.3] for the gated (4.53 m/s) and the instant release,
//      stage on and off, at 12 cells (h = 0.05 m: s34-ref's A2) and 24 cells (h = 0.6/24 m, as the spec's scratch), the
//      same physical column a = H = 0.6 m, nx = 6·aCells, 8 deep, τ_end 3.5 (A2's). Three front operators: the r3 §1
//      bulk slab (s34scenes frontSlab, A1/A2/A2g's gated operator), the 0.5 cm front (lib/s38metrics.mjs depthFront, the
//      scratch operator: the farthest x-slab whose mean depth count·V_p/(nz·h²) ≥ 0.005 m) and raw max(x). Beside the
//      spec's 20 °C scratch table (bulk / 0.5 cm / raw): gated P 1.577/1.583/1.582 (12), 1.591/1.593/1.728 (24); gated
//      none 1.613/1.618/1.621, 1.653/1.666/1.894; instant P 1.669/1.727/1.734 (12); instant none 1.720/1.769/1.776,
//      1.791/1.799/1.943; and the spec's references, each on its own window. Spec W2b's one rule (the A1/A2 late-slope
//      bands REPORTED under the stage) is applied in s34-ref.
// W2c  Lobovský H = 300 mm (spec W2c, REPORTED): n² = 0.5 (their 600 mm reservoir), their median gate 3.46 m/s (§4.2), 6
//      cells per H (aCells 12, h = 0.05 m) and 12 (aCells 24, h = 0.6/24 m), nx = 6·aCells. On their axes, t* = t·√(g/H)
//      and X = (x_f − a)/H (columnScore on those axes: n = 1, t_unit = √(H/g)): the bulk-slab and raw dX/dt* on
//      t* ∈ [1, 2.4206] (their last point before the wall), the no-shift RMS X error and best shift at the ETSIN points
//      in that window — against the ETSIN H = 0.3 m extraction fitted on the same window (spec 1.537; their Table 1:
//      1.56 for t* > 1). The runs end at t* = 2.4206 + 0.55 (past the scorer's +0.5 shift). Spec scratch (20 °C): none
//      1.520 / 1.585, P 1.522 / 1.542 (6 / 12 per H).
//      W2c.data (GATED — the reference data, not the solver): the embedded ETSIN_H0.3 series (lib/s38metrics.mjs, copied
//      by script from the vault's extraction, sha256 recorded there) has its 117 points and, fitted on t* ∈ [1, 2.4206]
//      by the same least squares, reproduces the spec's 1.537 within ±5e-4 (its printed digits). Without it the W2c
//      comparison is VOID.
// W2d  drift with resolution (spec W2d, REPORTED): the gated release at 12 / 24 / 36 cells (h = 0.05, 0.6/24, 0.6/36 m),
//      stage on and off: the 0.5 cm front's slope on T ∈ [1, 3.3] and its change 12 → 36 (spec: P stage +0.038, grid
//      stage +0.008, none +0.083), the bulk slab and raw beside; and the A2g scorer's numbers at each resolution (ETSIN
//      H = 0.6 m, T ∈ [1, 1.5767]; reported — A2g, the gate, is s34-ref's 12-cell run; spec W2a table, P at 20 °C:
//      2.09 %/+0.03/1.392, 0.59 %/0.00/1.386, 0.50 %/−0.01/1.358).
// W2e  scale direction (spec W2e, REPORTED): Martin & Moyce's a = 57.15 mm (2.25 in), n² = 1, 12 cells (h = a/12),
//      nx = 72, the instant release (they had no gate; the physics memo's scale runs), stage on and off: the bulk-slab
//      slope on T ∈ [1, 3.3] set against the 0.6 m instant 12-cell runs of W2b. The spec's expectation: with the stage
//      the 57.15 mm column is slower than the 0.6 m one; without it the two are equal (Froude similarity; the physics
//      memo's grid stage gave 1.576 vs 1.664 with, 1.710 vs 1.720 without). For the particle stage: not run before.
// W3P1 the still pool, P1's CPU part (spec §4 W3; the pool of FR/spec/regress_test_p.mjs and s38-ref's W0a): a 16 × 8 × 16
//      grid of DX = 3.63/64 m, the block [0..15] × [0..2] × [0..15] (s34scenes block(), 8 ppc lattice, mulberry32(11)),
//      H = 3·DX = 17.02 cm, s34-ref's solver at tolerances 1e-5 / 1e-4, 720 steps of 1/120 s (6 s), 20 °C water.
//      W3P1.energy (GATED; the wall shear on, keulegan1938): at every application of the stage — each call of
//      applyWallShear inside step(), seen by a subclass that wraps it — no floor cell's tangential kinetic energy grows:
//      KE_after ≤ KE_before·(1 + 1e-12) in f64 (spec W3: "to 1e-12 relative"), KE = Σ ½m(v_x² + v_z²) over the cell's
//      floor-row particles (⌊y/dx⌋ = 0; cell (⌊x/dx⌋, ⌊z/dx⌋) clamped into the grid, the stage's own binning), every
//      cell holding one counted; pass: 0 grown cell-steps, cells checked > 0 (expected 720 × 256 = 184,320), the stage's
//      log non-vacuous and no non-finite speed. Why it must hold: the update sets the cell mean U′ = U/(1 + a), a ≥ 0,
//      by a uniform Δv, so ΔKE = ½M(|U′|² − |U|²) ≤ 0 exactly (spec §3.4); 1e-12 is ≥ 3 decades above the f64 rounding
//      of a cell's KE sum and far below the laminar branch's loss of the mean part per step, 2a = 6νΔt/h² ≈ 1.6e-5.
//      ctl:W3P1.signflip (must FAIL the energy criterion; same run; a harness-level defect): the same pool with the
//      stage's applied change reversed — after each call the subclass sets every particle's v to 2·v_before − v_after —
//      must grow some floor cell's energy (> 0 grown cell-steps; spec: 184,064 of 184,320 with the scratch stage).
//      REPORTED: the RMS speed after 6 s with the stage off, on and sign-flipped against P1's limit 1 % √(gH) (spec CPU
//      evidence 4.740e-3 / 4.738e-3 / 4.742e-3 m/s; P1 itself is a page gate, not run here), the laminar-branch share of
//      the cell-applications (spec 94.7 %), and the largest relative change of a cell's energy across the stage.
import { loadTsModules } from './lib/loadTs.mjs'
import { MM1, MM1H, ETSIN600_FRONT, columnScore } from './lib/s34metrics.mjs'
import { s34Scenes, mulberry32, G, DX } from './lib/s34scenes.mjs'
import { s34Opts, refuseUnknownArgs, waterTempArg, waterAt, waterOpts, waterText, stageActed, actedText } from './lib/s34solver.mjs'
import { ETSIN300, ETSIN300_FRONT, depthFront } from './lib/s38metrics.mjs'

refuseUnknownArgs(process.argv, ['--only=', '--water-temp='])
const WATER_T = waterTempArg(process.argv)
const SRC = process.env.FLUID_REF_SRC ?? 'src/sim-ref'
const { gridLayout, flipRef, materialData } = await loadTsModules({ gridLayout: `${SRC}/gridLayout.ts`, flipRef: `${SRC}/flipRef.ts`, materialData: `${SRC}/../composition/materialData.ts` })
const { GridLayout, FaceType } = gridLayout
const { FlipRef, makeParticles } = flipRef
const WATER = WATER_T !== null ? waterAt(materialData, WATER_T) : null
const SHEAR = { wallShear: { wall: 'y-', law: 'keulegan1938' } }

let fails = 0
const check = (ok, label, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${msg}`); if (!ok) fails++ }
const info = (label, msg) => console.log(`INFO ${label} ${msg}`)
const voidLine = (label, why, msg) => console.log(`VOID ${label} (${why}) ${msg}`)
const t0 = Date.now()
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',') ?? null
const SECTIONS = ['W2b', 'W2c', 'W2d', 'W2e', 'W3P1']
// an unknown name would run nothing and print PASS (s34-ref.mjs review 2026-09-29): refuse it
for (const s of ONLY ?? []) if (!SECTIONS.includes(s)) throw new Error(`--only: unknown section "${s}" (${SECTIONS.join(', ')})`)
const run = name => !ONLY || ONLY.includes(name)

const S = s34Scenes({ FlipRef, GridLayout, FaceType, makeParticles }, s34Opts)
const WTXT = waterText(WATER, new FlipRef(new GridLayout({ nx: 2, ny: 2, nz: 2, dx: DX }), s34Opts()))
const f3 = x => x.toFixed(3), sg2 = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`, sg3 = x => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`
const pct = x => `${(100 * x).toFixed(2)} %`
const cellH = aCells => (aCells === 12 ? 0.05 : 0.6 / aCells)   // the column a = H = 0.6 m: A2's 0.05 m, else 0.6/aCells (the scratch's)

// One column collapse (s34scenes column(): 8 deep, 8 ppc) at this file's water, the wall shear on or off. Only the series
// are kept (the solver and the particles are released); Zd05 is the 0.5 cm front at every step. Runs shared between
// sections are made once.
const memo = new Map()
function colRun({ aCells, h, n2 = 1, gate = 0, stage, tauEnd = 3.5 }) {
  const key = JSON.stringify({ aCells, h, n2, gate, stage, tauEnd })
  if (memo.has(key)) return memo.get(key)
  const t = Date.now(), Zd05 = []
  const r = S.column({
    aCells, n2, h, nx: 6 * aCells, tauEnd, gate, ...(WATER ? { rho: WATER.rho } : {}),
    extra: { ...(WATER ? waterOpts(WATER) : {}), ...(stage ? SHEAR : {}) },
    onStep: (sim, p) => Zd05.push(depthFront(p.pos, p.n, h, 8, 0.005) / (aCells * h)),
  })
  const rec = { a: r.a, n: r.n, tUnit: r.tUnit, dt: r.dt, ts: r.ts, Z: r.Z, Zraw: r.Zraw, H: r.H, Zd05, particles: r.particles, kin: r.kin, gateClamps: r.gateClamps,
    stage, acted: stageActed([r.sim]), sec: (Date.now() - t) / 1000 }
  memo.set(key, rec)
  return rec
}
// validity of a stage-on / stage-off pair: the stage acted in the one and never ran in the other
const pairBad = (on, off) => (!on.acted.ok ? 'the stage-on run is vacuous' : off.acted.steps !== 0 ? 'the stage-off run logged the stage' : null)
const report = (label, on, off, line) => { const bad = pairBad(on, off); if (bad) voidLine(label, bad, line); else info(label, line) }
const LATE = [1, 3.3]
const lateSlopes = r => ({ bulk: columnScore(r, MM1, MM1H, LATE).slope, d05: columnScore({ ...r, Z: r.Zd05 }, MM1, MM1H, LATE).slope, raw: columnScore({ ...r, Z: r.Zraw }, MM1, MM1H, LATE).slope })
const trio = s => `${f3(s.bulk)} / ${f3(s.d05)} / ${f3(s.raw)}`

// W2b
if (run('W2b')) {
  info('W2b.refs', 'the spec W2b references, each on its own window: Martin & Moyce n² = 1 (a = 57 mm) 1.400 on T ∈ [1, 3.3] (second-hand, Leakey 2021 Fig. 7; release not modelled); Lobovský ETSIN 600 mm 1.34 (t* > 1 until their wall, t* ≤ 1.58); ETSIN 300 mm 1.56 (t* > 1); MM 57 / 114 mm 1.48 / 1.69 (114 mm is n² = 2); Dressler 1954 55 / 110 / 220 mm 1.54 / 1.70 / 1.74; Dressler 1952 u_M 1.49–1.53 ("rough")')
  const SPEC = { '12 gated': ['1.577/1.583/1.582', '1.613/1.618/1.621'], '24 gated': ['1.591/1.593/1.728', '1.653/1.666/1.894'], '12 instant': ['1.669/1.727/1.734', '1.720/1.769/1.776'], '24 instant': ['not run', '1.791/1.799/1.943'] }
  for (const aCells of [12, 24]) for (const [rel, gate] of [['gated', 4.53], ['instant', 0]]) {
    const h = cellH(aCells), on = colRun({ aCells, h, gate, stage: true }), off = colRun({ aCells, h, gate, stage: false })
    const so = lateSlopes(on), sf = lateSlopes(off), sp = SPEC[`${aCells} ${rel}`]
    report(`W2b.${aCells}.${rel}`, on, off, `${aCells} cells (h = ${(100 * h).toFixed(3)} cm, ${on.particles} particles), the ${rel} release${gate ? ` (${gate} m/s)` : ''}, ${WTXT}: late dZ/dT on T ∈ [1, 3.3], bulk slab / 0.5 cm front / raw max(x) — stage ${trio(so)}, none ${trio(sf)}, stage − none ${sg3(so.bulk - sf.bulk)} / ${sg3(so.d05 - sf.d05)} / ${sg3(so.raw - sf.raw)}; the spec's scratch (20 °C): P ${sp[0]}, none ${sp[1]}; ${gate ? `A2g-kin ${on.kin.mismatch} / ${off.kin.mismatch} mismatching over ${on.kin.steps} steps; ` : ''}${actedText(on.acted)}; the stage-off run's log ${off.acted.steps} entries (0); ${on.sec.toFixed(0)} s + ${off.sec.toFixed(0)} s`)
  }
}

// W2c
if (run('W2c')) {
  const H300 = 0.3, W300 = [1, ETSIN300_FRONT.T.at(-1)], REF = { T: ETSIN300_FRONT.T, Z: ETSIN300_FRONT.X }
  // the reference's own fit: the ETSIN series scored against itself on the window (columnScore's least squares)
  const expFit = columnScore({ ts: REF.T, n: 1, tUnit: 1, Z: REF.Z, Zraw: REF.Z, H: [] }, REF, [], W300, W300).slope
  const dataOk = ETSIN300.T.length === 117 && ETSIN300.X.length === 117 && Math.abs(expFit - 1.537) <= 5e-4
  check(dataOk, 'W2c.data', `the embedded ETSIN H = 0.3 m series (lib/s38metrics.mjs: ${ETSIN300.T.length} points, 117 expected; ${ETSIN300_FRONT.T.length} before their wall) fitted on t* ∈ [1, ${W300[1]}]: dX/dt* ${expFit.toFixed(4)} (the spec's 1.537 ± 5e-4)`)
  // Lobovský's axes: t* = t·√(g/H) (columnScore's T with n = 1, t_unit = √(H/g)), X = (x_f − a)/H
  const lob = (r, Zs) => ({ ts: r.ts, n: 1, tUnit: Math.sqrt(H300 / G), Z: Zs.map(z => (z - 1) * r.a / H300), Zraw: r.Zraw.map(z => (z - 1) * r.a / H300), H: [] })
  const score = r => { const b = columnScore(lob(r, r.Z), REF, [], W300, W300), w = columnScore(lob(r, r.Zraw), REF, [], W300, W300); return { slope: b.slope, raw: w.slope, rms: b.rmsZ, s: b.bestShift, pts: b.points } }
  const SPEC = { 6: 'none 1.520, P 1.522 (raw: none 1.551, P 1.546; RMS none 10.32 %, P 10.43 %, s +0.11 both)', 12: 'P 1.542, none 1.585 (raw: P 1.593; RMS P 3.35 %, s +0.03)' }
  for (const [perH, aCells] of [[6, 12], [12, 24]]) {
    const h = cellH(aCells), tauEnd = (W300[1] + 0.55) * Math.sqrt(0.5)   // τ = t*·√n²: the run reaches t* = 2.97
    const on = colRun({ aCells, h, n2: 0.5, gate: 3.46, stage: true, tauEnd }), off = colRun({ aCells, h, n2: 0.5, gate: 3.46, stage: false, tauEnd })
    const so = score(on), sf = score(off)
    const line = `Lobovský H = 300 mm (n² = 0.5, gate 3.46 m/s), ${perH} cells per H (aCells ${aCells}, h = ${(100 * h).toFixed(3)} cm, ${on.particles} particles), ${WTXT}: bulk-slab dX/dt* on t* ∈ [1, ${W300[1]}] stage ${f3(so.slope)}, none ${f3(sf.slope)} (stage − none ${sg3(so.slope - sf.slope)}); raw max(x) stage ${f3(so.raw)}, none ${f3(sf.raw)}; ETSIN 0.3 m on the same window ${f3(expFit)} (their Table 1: 1.56 for t* > 1); no-shift RMS X error at ${so.pts} ETSIN points stage ${pct(so.rms)}, none ${pct(sf.rms)}, best shift stage ${sg2(so.s)}, none ${sg2(sf.s)}; the spec's scratch (20 °C): ${SPEC[perH]}; A2g-kin ${on.kin.mismatch} / ${off.kin.mismatch} mismatching over ${on.kin.steps} steps (${on.kin.firstSolid} SOLID at step 1); ${actedText(on.acted)}; the stage-off run's log ${off.acted.steps} entries (0); ${on.sec.toFixed(0)} s + ${off.sec.toFixed(0)} s`
    if (!dataOk) voidLine(`W2c.${perH}perH`, 'the reference data failed W2c.data', line); else report(`W2c.${perH}perH`, on, off, line)
  }
}

// W2d
if (run('W2d')) {
  const WIN = [1, ETSIN600_FRONT.T.at(-1)]   // A2g's scorer window (s34-ref header): the ETSIN 600 mm points with T ≥ 1 before their wall
  const res = [12, 24, 36].map(aCells => ({ aCells, on: colRun({ aCells, h: cellH(aCells), gate: 4.53, stage: true }), off: colRun({ aCells, h: cellH(aCells), gate: 4.53, stage: false }) }))
  const sl = res.map(({ on, off }) => ({ on: lateSlopes(on), off: lateSlopes(off) }))
  const row = (k, side) => `${sl.map(s => f3(s[side][k])).join(' → ')} (12 → 36: ${sg3(sl[2][side][k] - sl[0][side][k])})`
  const bad = res.map(({ on, off }) => pairBad(on, off)).find(b => b) ?? null
  const line = `the gated release (4.53 m/s) at 12 / 24 / 36 cells (${res.map(r => r.on.particles).join(' / ')} particles), ${WTXT}: the 0.5 cm front's dZ/dT on T ∈ [1, 3.3] — stage ${row('d05', 'on')}, none ${row('d05', 'off')}; the spec's scratch (20 °C): P 1.583 → 1.593 → 1.621 (+0.038), none 1.618 → 1.666 → 1.701 (+0.083), grid stage +0.008. Bulk slab: stage ${row('bulk', 'on')}, none ${row('bulk', 'off')}; raw max(x): stage ${row('raw', 'on')}, none ${row('raw', 'off')}; ${res.map(r => `${r.aCells} cells: ${actedText(r.on.acted)}, stage-off log ${r.off.acted.steps} entries (0), ${r.on.sec.toFixed(0)} s + ${r.off.sec.toFixed(0)} s`).join('; ')}`
  if (bad) voidLine('W2d', bad, line); else info('W2d', line)
  const a2g = r => { const s = columnScore(r, ETSIN600_FRONT, [], WIN, WIN); return `${pct(s.rmsZ)} / ${sg2(s.bestShift)} / ${f3(s.slope)}` }
  const line2 = `the A2g scorer (no-shift RMS / best shift s / dZ/dT on T ∈ [1, ${WIN[1]}] vs ETSIN H = 0.6 m; reported — A2g, the gate, is s34-ref's 12-cell run) at 12 / 24 / 36 cells, ${WTXT}: stage ${res.map(r => a2g(r.on)).join(', ')}; none ${res.map(r => a2g(r.off)).join(', ')}; the spec's W2a table (P, 20 °C): 2.09 % / +0.03 / 1.392, 0.59 % / 0.00 / 1.386, 0.50 % / −0.01 / 1.358; A2g-kin (stage) ${res.map(r => `${r.on.kin.mismatch} of ${r.on.kin.steps} steps`).join(', ')} mismatching`
  if (bad) voidLine('W2d.A2g', bad, line2); else info('W2d.A2g', line2)
}

// W2e
if (run('W2e')) {
  const A_MM = 0.05715   // Martin & Moyce's a = 2.25 in
  const mm = { on: colRun({ aCells: 12, h: A_MM / 12, stage: true }), off: colRun({ aCells: 12, h: A_MM / 12, stage: false }) }
  const big = { on: colRun({ aCells: 12, h: 0.05, stage: true }), off: colRun({ aCells: 12, h: 0.05, stage: false }) }
  const L = { mmOn: lateSlopes(mm.on), mmOff: lateSlopes(mm.off), bigOn: lateSlopes(big.on), bigOff: lateSlopes(big.off) }
  const bad = pairBad(mm.on, mm.off) ?? pairBad(big.on, big.off)
  const line = `scale direction, the instant release at 12 cells, ${WTXT}: bulk-slab dZ/dT on T ∈ [1, 3.3] — a = 57.15 mm (h = ${(1000 * A_MM / 12).toFixed(4)} mm): stage ${f3(L.mmOn.bulk)}, none ${f3(L.mmOff.bulk)}; a = 0.6 m: stage ${f3(L.bigOn.bulk)}, none ${f3(L.bigOff.bulk)}. With the stage the 57.15 mm column is ${L.mmOn.bulk < L.bigOn.bulk ? 'slower' : 'NOT slower'} than the 0.6 m one (57.15 mm − 0.6 m ${sg3(L.mmOn.bulk - L.bigOn.bulk)}); without it they differ by ${sg3(L.mmOff.bulk - L.bigOff.bulk)} (expected equal: Froude similarity). Raw max(x): 57.15 mm stage ${f3(L.mmOn.raw)}, none ${f3(L.mmOff.raw)}; 0.6 m stage ${f3(L.bigOn.raw)}, none ${f3(L.bigOff.raw)}. The physics memo's grid stage: 1.576 vs 1.664 with, 1.710 vs 1.720 without; the particle stage: not run before. 57.15 mm: ${actedText(mm.on.acted)}; stage-off log ${mm.off.acted.steps} entries (0); ${mm.on.sec.toFixed(0)} s + ${mm.off.sec.toFixed(0)} s`
  if (bad) voidLine('W2e', bad, line); else info('W2e', line)
}

// W3P1
if (run('W3P1')) {
  // floor-row tangential kinetic energy per floor cell, binned as the stage bins (⌊y/dx⌋ = 0; ⌊x/dx⌋, ⌊z/dx⌋ clamped)
  const floorKE = (p, L) => {
    const h = L.dx, E = new Float64Array(L.nx * L.nz), n = new Uint32Array(L.nx * L.nz)
    const clamp = (i, m) => (i < 0 ? 0 : i >= m ? m - 1 : i)
    for (let q = 0; q < p.n; q++) {
      if (Math.floor(p.pos[3 * q + 1] / h) !== 0) continue
      const c = clamp(Math.floor(p.pos[3 * q] / h), L.nx) + L.nx * clamp(Math.floor(p.pos[3 * q + 2] / h), L.nz)
      E[c] += 0.5 * p.mass[q] * (p.vel[3 * q] ** 2 + p.vel[3 * q + 2] ** 2); n[c]++
    }
    return { E, n }
  }
  class EnergyProbe extends FlipRef {
    constructor(layout, o, negate) { super(layout, o); this.negate = negate; this.ke = { calls: 0, checked: 0, grew: 0, worst: -Infinity } }
    applyWallShear(p, dt) {
      const e0 = floorKE(p, this.layout), v0 = this.negate ? Float64Array.from(p.vel) : null
      super.applyWallShear(p, dt)
      if (this.negate) for (let i = 0; i < p.vel.length; i++) p.vel[i] = 2 * v0[i] - p.vel[i]   // ctl: the applied change reversed
      const e1 = floorKE(p, this.layout)
      this.ke.calls++
      for (let c = 0; c < e0.n.length; c++) if (e0.n[c] > 0) {
        this.ke.checked++
        if (e1.E[c] > e0.E[c] * (1 + 1e-12)) this.ke.grew++
        if (e0.E[c] > 0) this.ke.worst = Math.max(this.ke.worst, (e1.E[c] - e0.E[c]) / e0.E[c])
      }
    }
  }
  const pool = (Cls, stage, negate = false) => {
    const t = Date.now(), L = new GridLayout({ nx: 16, ny: 8, nz: 16, dx: DX })
    const sim = new Cls(L, s34Opts({ pressureTolerance: 1e-5, psiTolerance: 1e-4, ...(stage ? SHEAR : {}) }), negate)
    const p = S.block([0, 0, 0], [15, 2, 15], mulberry32(11))
    let steps = 0
    for (let s = 1; s * (1 / 120) <= 6 + 1e-9; s++) { sim.step(p, 1 / 120); steps++ }
    let ss = 0, bad = 0
    for (let q = 0; q < p.n; q++) { const v2 = p.vel[3 * q] ** 2 + p.vel[3 * q + 1] ** 2 + p.vel[3 * q + 2] ** 2; if (!Number.isFinite(v2)) bad++; else ss += v2 }
    return { n: p.n, H: p.n * (DX ** 3 / 8) / (16 * DX * 16 * DX), steps, rms: Math.sqrt(ss / p.n), bad, ke: sim.ke ?? null, acted: stageActed([sim]), sec: (Date.now() - t) / 1000 }
  }
  const off = pool(FlipRef, false), on = pool(EnergyProbe, true), flip = pool(EnergyProbe, true, true)
  const lim = 0.01 * Math.sqrt(G * on.H), W20 = waterText(null, new FlipRef(new GridLayout({ nx: 2, ny: 2, nz: 2, dx: DX }), s34Opts()))
  const e = r => `${r.ke.grew} of ${r.ke.checked} cell-steps grew over ${r.ke.calls} applications (largest relative change ${r.ke.worst.toExponential(2)})`
  check(on.ke.grew === 0 && on.ke.checked > 0 && on.acted.ok && on.bad === 0, 'W3P1.energy',
    `the still pool (16 × 3 × 16 cells of ${(100 * DX).toFixed(2)} cm, H = ${(100 * on.H).toFixed(2)} cm, ${on.n} particles, ${on.steps} steps of 1/120 s, ${W20}) with the wall shear on: floor cells whose tangential kinetic energy grew across the stage ${e(on)} — 0 required, relative tolerance 1e-12 (f64); cells checked > 0 (expected ${on.steps} × 256 = ${on.steps * 256}); non-finite speeds ${on.bad}; ${actedText(on.acted)}`)
  check(flip.ke.grew > 0 && flip.acted.ok, 'ctl:W3P1.signflip',
    `(must FAIL the energy criterion) the same pool with the stage's applied change reversed after each call (harness-level: v ← 2·v_before − v_after): ${e(flip)} — > 0 required (spec, the scratch stage: 184,064 of 184,320); ${actedText(flip.acted)}`)
  info('W3P1.rms', `RMS speed after 6 s: stage off ${off.rms.toExponential(3)}, on ${on.rms.toExponential(3)}, sign-flipped ${flip.rms.toExponential(3)} m/s (P1's limit 1 % √(gH) = ${lim.toExponential(2)} m/s; the spec's CPU evidence 4.740e-3 / 4.738e-3 / 4.742e-3 at 20 °C; P1 itself is a page gate, not run here); non-finite off ${off.bad}, flipped ${flip.bad}; the stage-off run's log ${off.acted.steps} entries (0); laminar branch ${(100 * on.acted.laminar / on.acted.cells).toFixed(1)} % of the cell-applications (spec 94.7 %); ${off.sec.toFixed(0)} s / ${on.sec.toFixed(0)} s / ${flip.sec.toFixed(0)} s`)
}

console.log(`\ns3.8 dam-break (W2b–W2e reported, W3P1 and W2c.data gated; column ${WATER ? `water ${WATER.tC} °C` : 'water: the solver default'}): ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
