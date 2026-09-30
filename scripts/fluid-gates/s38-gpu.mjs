#!/usr/bin/env node
// Gate S3.8 FRICTION on the GPU — the floor's wall shear (vault fluid/realism-2026-09/FRICTION-spec.md §3.3, §4 W1g):
// wallShearScatter → wallShearCell → wallShearApply, encoded FIRST in FlipGpuSimulator.encodeSubstepBody (skipped
// while the viscous path runs), against the analytic answers and the f64 reference src/sim-ref/flipRef.ts
// (applyWallShear, keuleganTau). Tests: src/bench/flipSelftest/wallShear.ts.
//
//   node scripts/fluid-gates/s38-gpu.mjs     (default server: the clean gate tree; FLUID_BASE to override)
//
// Bounds, pre-registered 2026-09-30 before the first run. The f32 bounds are the spec's W1g table (first-order sums of
// the WGSL accuracy table §15.7.4 along each kernel's operation chain, FR/revise/revise_numbers.py §4–§9), re-evaluated
// on THIS test set and THIS kernel chain in FR/impl/B/prereg.mjs (→ prereg.out); none is tuned.
//  W1a    240 applications of encodeWallShear, no transfers, Darcy test law f = 0.02 (ρ_c = M_c/V_c), dx = 5 cm, 8 ppc,
//         3 particles per floor cell (h_c = 18.75 mm), U0 = 3 m/s along x in half the cells and along z in the rest
//         (interior and wall-adjacent), Δt = 3.6731 ms (the A2 step): every particle |U_N/2.217922606925 − 1| ≤ 3e-5
//         (derived 2.86e-5 = the particle update's rounding Σ ULP(v_n)/U_N 2.58e-5 + Δv's 65.5 ULP 2.8e-6); the other
//         tangential component and v_y exactly 0, m̂ unchanged; the stage log: 240 applications, every cell acted on
//         and booked in each. In-gate controls through the same kernel — the Darcy law's exact equivalents of the
//         spec's W1a mutants: f = −0.02 (the sign flip: U/(1 − kU), derived +108.9 %) and f = 0.04 (τ×2: −20.7 %) —
//         must each FAIL the 3e-5 bound against the f = 0.02 answer.
//         Per-arm verdicts (2026-09-30 follow-up, the lead: nothing showed a kernel dropping Δv_z caught; pre-registered
//         here before the arms' first separate run). The scene is unchanged — its z set (the spec's "a second set along
//         z") was in it from the first run, the 32 cells with (i + k) odd, and the one combined line judged both arms
//         together. Now each arm is its own check with the same bound and exact answer: the x arm (32 cells, U0 along x)
//         and the z arm (32 cells, U0 along z), each 96 particles with interior and wall-adjacent cells: every particle
//         |U_N/2.217922606925 − 1| ≤ 3e-5; the arm's other tangential component (z for the x arm, x for the z arm) and
//         v_y exactly 0; m̂ unchanged. The stage log is its own check: 240 applications, all 64 cells acted on and booked
//         in each. A kernel that drops Δv_z leaves the z arm's films at U0: derived miss 3/2.217922606925 − 1 = +35.3 %.
//  W1a-K  one application, the production law (Keulegan 1938 eq. 32 + the Re_h rule), lab dx, Δt = 1/240 s, the
//         hand-built non-uniform set of wallShear.ts (0–9 and 12 floor-row particles per cell, rows 1–2 occupied,
//         v_y ≠ 0, APIC c ≠ 0, ±20 % spread + 5 % jitter, 45° directions, |U| 1e-3–5 m/s, wall cells, a μ table of
//         water/mercury/ethanol at 20 °C): every floor-row particle's tangential v within 3e-7·|U_c| of
//         flipRef.applyWallShear on the same f32 inputs (derived 2.14e-7 for the spec's chain at a_max 6.35e-3 — also
//         this set's own a_max, cell 61: water, 1 particle, 5 m/s, printed by the gate; this chain — μ_c costs 6.5 ULP,
//         not 4: K = 82.83 ULP — evaluated conservatively at the pre-registration envelope of FR/impl/B/prereg.out
//         (water/ethanol × U ≤ 5 m/s × 1–12 particles: a_max 6.93e-3, fixed-point sums ≤ 4.14e-9): 1.271·2^-23 +
//         K·2^-23·a + 4.14e-9 = 2.24e-7; ≈ 2.18e-7 at the set's 6.35e-3 — record corrected 2026-09-30, review REC-F8;
//         the bound and the precondition are unchanged); rows ≥ 1: v and c bit-identical; every particle's v_y, m̂ and c
//         bit-identical; floor-row particles of unacted cells unchanged; cells acted on equal the reference's (> 0),
//         one application logged. The derivation's preconditions, checked on the set: |v_t|/|U_c| ≤ 1.271; a_c ≤
//         1.46e-2 (where the bound reaches 3e-7); both branches present; a cell with h_c capped at dx; the ethanol
//         and water/ethanol μ cells; the dense cell of 8 mercury particles with Σm̂·|v_x| > 128, so a momentum word at
//         2^24 would overflow (spec §3.3) — its law bound at 11 m/s (7.33e-7) lies under the grid's 7.82e-7.
//  W1b    the lawTest entry against flipRef.keuleganTau (f64) at the f64 inputs (the GPU gets them rounded to f32),
//         water 20 °C: turbulent points u* ≤ 8e-7 (derived 7.82e-7), τ ≤ 2e-6 (derived 1.80e-6; with ρ's own f32
//         rounding 1.86e-6); laminar points τ ≤ 8e-7 (derived 7.15e-7: τ = 3μU/h with μ given); a point whose f32
//         branch differs from the f64 one is judged at 2e-6 (derived ≤ 1.11e-6: Re_h errs ≤ 5 ULP and τ_turb/τ_lam − 1
//         ≈ 0.654·δ at the crossing) and is allowed only within |Re_h/428.26 − 1| ≤ 1e-6; τ(0) = 0 exactly; on the eight
//         scans (1e-7–5 m/s, 4001 points) τ never decreases and τ/τ_lam at the low end is within 8e-7 (the scan's
//         steps, 4.4e-3, are ≫ 2·2e-6). Points: the 41 × 21 grid of the derivation, the spec's four references, the
//         scans. The f64 oracle must reproduce the spec's printed references to their printed digits.
//  W1c    the real step() with substeps = 2 (the A2 frame, 3.6731 ms, in two substeps), a one-cell sheet (8 ppc,
//         u0 = 2 m/s) in a 20 m tank (400 × 8 × 4, and 4 × 8 × 400 for z), window [9, 11] m, Darcy f = 0.02, pressure
//         tolerance 1e-5, ψ 1e-4 (the CPU W1c's): at t = 0.25, 0.5 and 1 s (nearest frame) the loss (control −
//         stage) within 3 % of u0 − u0/(1 + (f/8)·u0·t/h) — the CPU W1c's †bound, unchanged — in x and in z; the
//         control's drift ≤ 0.2 % at every frame t ≤ 1 s; the stage log: 2 applications per frame (the per-substep
//         placement), cells acted on > 0, booked > 0; 0 solver breakdowns. In-gate controls (x): f = 0.04 (τ×2, CPU
//         +85–95 %) and f = −0.02 (the sign, CPU −205–223 %) must FAIL the 3 % bound; the control itself is the
//         "stage skipped" case (loss 0, −100 %).
//         Verdicts (2026-09-30, after the first run, the lead's rule; no criterion changed): each axis prints the
//         control's validity (the 0.2 % drift), the stage log (2 applications per frame, non-vacuity, 0 breakdowns)
//         and the 3 % loss as separate checks. An axis whose control fails its validity is VOID — uncertified, neither
//         a stage PASS nor a stage FAIL: its loss is printed as a VOID line, and the gate exits red for the validity
//         check alone. (Run 1: the z control drifted to 0.245 %; the CPU reference's own z control, seed 7, reaches
//         0.280 % — FR/impl/B/w1c_cpu_drift_z.out.)
//  W0b    olive oil at 20 °C (ν = 9.2e-5 ≥ VISCOUS_RUN_NU), viscosity solver present and viscosityActive: stage set vs
//         never set, 20 frames: 0 differing words of pos, vel and c; the stage log empty (0 applications, 0 cells);
//         budgetState: viscous true, wallShear false. Sensitivity control: the same scene with viscosityActive false
//         (the guard open) must differ and log cells acted on > 0.
//  A2     ghost.ts's instant column (12 cells, n² = 1, h = 5 cm, 72 wide) with the stage on (water 20 °C): s34-gpu's
//         A2 criteria except the late-slope band (spec W2b) — after the best shift |ΔT| ≤ 0.3 and RMS Z ≤ 10 %, max
//         |ΔH| ≤ 0.05, 0 breakdowns — plus non-vacuity (one application per frame, cells acted on > 0, booked > 0).
//         dZ/dT on [1, 3.3] is REPORTED next to the same GPU column without the stage and the CPU's instant column
//         (scratch, 20 °C, FR/gatedesign/w2a_summary.out: 1.720 without, 1.669 with the particle stage).
//  and: 0 uncaptured WebGPU errors, 0 console errors.
// Fix round (review wf_fbc58c55-116, prereg FR/review/prereg_fixround.md): every new or changed check below was
// pre-registered 2026-09-30 before its first run; no bound, seed, window, tolerance or statistic widened.
//  W1a-K  (changed) the unacted-cell check made non-vacuous (GATE-F7): appended after the pre-registered set, no rng
//         draw, the zero-mean cell 40 — two water particles with tangential (+0.7, +0.2) m/s and its exact f32
//         negation, v_y and c +0 — whose sums cancel exactly (U_c = 0 on both sides: not acted on); its two floor-row
//         particles must come back bit-identical and unactedChecked > 0 is required. The first 567 particles are the
//         pre-registered set's, identical in f32 words (FR/fixround/Y/m3_miss.out).
//  W1a-K on the viscosity solver's μ table (the page's binding; M3): the same set and reference on a sim WITH the
//         viscosity solver (viscosityActive false, the stage encoded directly), μ uploaded with setMuTable and none
//         given to the stage: W1a-K's criterion (with unactedChecked > 0) and its preconditions, unchanged. Its
//         positive control, pre-registered from the CPU before any GPU run (FR/fixround/Y/m3_miss.out; flipRef pinned at
//         HEAD d8d2f102, LF sha256 1721551a…, and under prereg R-F2 alike): 'the stage always binds its own table'
//         gives every particle μ = f32(1.001596e-3), the own table's default fill (= the set's water entry) — CPU miss
//         4.4623e-5 at cell 23 (the dense mercury cell; ethanol cell 45: 9.5e-6), so the GPU misses by ≥ 4.4623e-5 −
//         3e-7 = 4.43e-5, 148× the 3e-7 bound (≥ 10× required).
//  W1a-K.skip (GATE-F7): a pair of water particles in one floor cell of a 4×4×4 lab-dx tank, Keulegan, Δt = 1/240 s:
//         at (+v, +v), v = (0.7, 0, 0.2) m/s, one application acts (1 cell, 1 booked); rewritten to (+v, −v) (U_c = 0),
//         a second application must act on 0 cells and leave the pair's pos, vel and c words bit-identical.
//  W0c on the GPU (M1/M2): setWallShear must throw — leaving the stage unset — on the laws 'Keulegan1938' and
//         'darcytest' and an absent law, darcyTest without f, constantTest without tau, a muDefault of NaN, 0 or −1 and
//         a muTable entry of NaN or 0 without the viscosity solver, and any muDefault with it (11 cases); it must accept
//         f = −0.02 and τ = −10 Pa (no sign rule) and the page's solver-sim configuration (3 cases).
//  W1g.reset (M4): 3 applications (applications 3, cells > 0), resetDiagnostics() (every word of the log 0), one more
//         application (applications 1, a third of the cells).
//  W0b drift arm (INT-7, prereg R-D): water over mercury (the page's pair; σ from interfacialTension; both ν <
//         VISCOUS_RUN_NU), the drift active, NO viscosity solver (so the viscous guard cannot be what keeps the stage
//         off): stage set vs never set, 20 frames — 0 differing words, an empty log, budgetState immiscible true and
//         wallShear false. Sensitivity control: the same scene with the drift configured but off — the stage must act
//         (words differ, cells > 0, budgetState wallShear true).
// Code-level positive controls: gpu-mutations.mjs --gate=wallShear (the Δv sign, τ×2, the floor row binned as
// y < dx/2, the momentum words at 2^24, the stage per frame instead of per substep, Δv_z dropped in wallShearApply
// (caught by W1a's z arm and W1a-K); added 2026-09-30 by the fix round: the stage always binds its own table (W1a-K on
// the solver's table only), cellOut written only for acted cells (W1a-K.skip), unknown law maps to constantTest and
// muDefault accepted on a solver sim (W0c), stage log not reset by resetDiagnostics (W1g.reset), drift guard removed
// (W0b's drift arm)) and --gate=perf1 (D3: one extra stage dispatch); they run against the clean gate tree only.
import { windowArgs } from '../lib/window.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'
import { MM1, MM1H, columnScore } from './lib/s34metrics.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.8 FRICTION (the floor\'s wall shear on the GPU)')
const report = { prov: await provenance() }
const x = v => v.toExponential(2), pc = v => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(2)} %`

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: [...windowArgs(), '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
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
  if (init.info.vendor !== 'nvidia') throw new Error(`adapter is ${init.info.vendor}, not the NVIDIA dGPU`)
  report.adapter = init.info
  const run = (t, p = {}) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])
  report.solver = (await run('configure', { solver: 'mgpcg' })).solver

  // ── W1a ──
  const a = await run('wallShearW1a', {})
  report.w1a = a
  for (const [name, other] of [['x', 'z'], ['z', 'x']]) {
    const r = a.arms[name]
    gate.check(r.cells > 0 && r.particles > 0 && r.worst <= 3e-5 && r.otherNonZero === 0 && r.normalNonZero === 0 && r.massChanged === 0,
      `W1a operator, ${name} arm, Darcy f = 0.02, ${a.N} applications, U0 along ${name} in ${r.cells} floor cells (${r.wallCells} wall-adjacent; ${r.particles} particles, h_c ${(1000 * a.hc).toFixed(2)} mm, Δt ${(1000 * a.dt).toFixed(4)} ms): U_N ${r.minU.toFixed(9)}…${r.maxU.toFixed(9)} vs exact ${a.UN.toFixed(12)} m/s, worst |U_N/exact − 1| ${x(r.worst)} (≤ 3e-5); v_${other} ≠ 0: ${r.otherNonZero}, v_y ≠ 0: ${r.normalNonZero}, m̂ changed: ${r.massChanged}`)
  }
  gate.check(a.stats.applications === a.N && a.stats.cells === a.N * a.cells && a.stats.booked === a.N * a.cells,
    `W1a stage log: ${a.stats.applications} applications (${a.N}), ${a.stats.cells} cells acted on and ${a.stats.booked} booked (${a.N * a.cells}: all ${a.cells} cells of both arms in every application)`)
  for (const [label, f, cpu] of [['the sign flip', -0.02, '+108.9 %'], ['τ×2', 0.04, '−20.7 %']]) {
    const c = await run('wallShearW1a', { f })
    const miss = Math.max(Math.abs(c.minU / a.UN - 1), Math.abs(c.maxU / a.UN - 1))
    report[`w1a_control_${f}`] = { ...c, miss }
    gate.check(miss > 3e-5, `W1a control ${label} (f = ${f} through the same kernel) FAILS the 3e-5 bound as required: U_N ${c.minU.toFixed(6)} vs ${a.UN.toFixed(6)}, miss ${pc(c.minU / a.UN - 1)} (derived ${cpu})`)
  }

  // ── W1a-K ──
  const k = await run('wallShearW1aK', {})
  report.w1aK = k
  const pre = k.pre
  gate.check(pre.spreadMax <= 1.271 && pre.aMax <= 1.46e-2 && pre.laminar > 0 && pre.turbulent > 0 && pre.capped > 0 && pre.denseN === 8 && pre.denseSum > 128 && pre.muMixed && pre.muEthanol !== null,
    `W1a-K set, the derivation's preconditions: max |v_t|/|U_c| ${pre.spreadMax.toFixed(4)} (≤ 1.271), max a_c ${x(pre.aMax)} (≤ 1.46e-2); ${pre.laminar} laminar and ${pre.turbulent} eq.-32 cells, ${pre.capped} with h_c capped at dx; μ cells: ethanol μ_c ${pre.muEthanol?.toPrecision(6)} Pa·s, water/ethanol μ_c ${pre.muMixed?.mu.toPrecision(6)} Pa·s (${pre.muMixed?.n} particles); dense cell ${pre.denseN} mercury particles, Σm̂·|v_x| ${pre.denseSum.toFixed(1)} (> 128)`)
  // (2026-09-30 fix round, GATE-F7: + unactedChecked > 0 — pre-registered 2026-09-30 before its first run)
  gate.check(k.floorRowChecked > 0 && k.worst <= 3e-7 && k.offRowChanged === 0 && k.vyOrCChanged === 0 && k.unactedMoved === 0 && k.unactedChecked > 0 && k.cellsRef > 0 && k.cellsGpu === k.cellsRef && k.applications === 1,
    `W1a-K production law through the stage, one application (${k.particles} particles, ${k.floorRowChecked} floor-row particles in acted cells): worst |Δv_GPU − Δv_ref|/|U_c| ${x(k.worst)} (≤ 3e-7; cell ${k.worstCell}); rows ≥ 1 changed ${k.offRowChanged}, v_y/m̂/c changed ${k.vyOrCChanged}, unacted floor-row particles moved ${k.unactedMoved} of ${k.unactedChecked} checked (> 0; the zero-mean cell acted: ${k.zeroMeanActed}); cells acted on GPU ${k.cellsGpu} / reference ${k.cellsRef} (laminar ${k.laminarGpu} / ${k.laminarRef}), ${k.applications} application logged`)
  console.log(`  [info] W1a-K booked impulse (N·s): reference x ${k.booked.ref[0].toExponential(6)} z ${k.booked.ref[1].toExponential(6)}; GPU (Σ m_p·Δv_p) x ${k.booked.gpu[0].toExponential(6)} z ${k.booked.gpu[1].toExponential(6)}; per-cell τ, GPU vs reference, worst relative ${x(k.tauRel)}`)
  console.log(`  [info] W1a-K per-component signal (the largest |Δv_ref|/|U_c| of one component over the checked particles — what a kernel dropping it would miss by, against the 3e-7 bound): x ${x(k.signal.x)}, z ${x(k.signal.z)}; the booked z SUM is small because the set's 45° directions cancel in it, not per particle`)

  // ── W1a-K on the viscosity solver's μ table (M3) and W1a-K.skip (GATE-F7): pre-registered 2026-09-30 before their first run ──
  const ks = await run('wallShearW1aK', { table: 'solver' })
  report.w1aKSolver = ks
  const ps = ks.pre
  gate.check(ks.table === 'solver' && ps.spreadMax <= 1.271 && ps.aMax <= 1.46e-2 && ps.laminar > 0 && ps.turbulent > 0 && ps.capped > 0 && ps.denseN === 8 && ps.denseSum > 128 && ps.muMixed && ps.muEthanol !== null
      && ks.floorRowChecked > 0 && ks.worst <= 3e-7 && ks.offRowChanged === 0 && ks.vyOrCChanged === 0 && ks.unactedMoved === 0 && ks.unactedChecked > 0 && ks.cellsRef > 0 && ks.cellsGpu === ks.cellsRef && ks.applications === 1,
    `W1a-K on the viscosity solver's μ table (the page's binding): a sim with the viscosity solver (viscosityActive false), μ uploaded with setMuTable, none given to the stage; the set's preconditions max |v_t|/|U_c| ${ps.spreadMax.toFixed(4)} (≤ 1.271), max a_c ${x(ps.aMax)} (≤ 1.46e-2), ${ps.laminar} laminar / ${ps.turbulent} eq.-32 cells, ${ps.capped} capped, ethanol μ_c ${ps.muEthanol?.toPrecision(6)}, water/ethanol μ_c ${ps.muMixed?.mu.toPrecision(6)}, dense cell ${ps.denseN} mercury particles Σm̂·|v_x| ${ps.denseSum.toFixed(1)} (> 128); worst |Δv_GPU − Δv_ref|/|U_c| ${x(ks.worst)} (≤ 3e-7; cell ${ks.worstCell}); rows ≥ 1 changed ${ks.offRowChanged}, v_y/m̂/c changed ${ks.vyOrCChanged}, unacted floor-row particles moved ${ks.unactedMoved} of ${ks.unactedChecked} checked (> 0); cells acted on GPU ${ks.cellsGpu} / reference ${ks.cellsRef} (laminar ${ks.laminarGpu} / ${ks.laminarRef}), ${ks.applications} application logged`)
  const sk = await run('wallShearW1aKSkip')
  report.w1aKSkip = sk
  gate.check(sk.first.applications === 1 && sk.first.cells === 1 && sk.first.booked === 1 && sk.second.applications === 1 && sk.second.cells === 0 && sk.differing === 0,
    `W1a-K.skip, a skipped cell after an acted one: the pair at (+v, +v) — ${sk.first.cells} cell acted, ${sk.first.booked} booked (Δv ${sk.first.dv.map(v => v.toExponential(3)).join(', ')} m/s, τ ${sk.first.tau.toPrecision(5)} Pa); rewritten to (+v, −v): ${sk.second.cells} cells acted in the second application (0), ${sk.differing} of ${sk.total} pos/vel/c words changed across it (0)`)

  // ── W1b ──
  const b = await run('wallShearW1b')
  report.w1b = b
  gate.check(b.oracle.every(o => o.ok), `W1b oracle: flipRef.keuleganTau reproduces the spec's printed references — ${b.oracle.map(o => `${o.what}(${o.U}, ${o.h}) ${o.got.toPrecision(13)} vs ${o.printed}${o.ok ? '' : ' ✗'}`).join('; ')}`)
  gate.check(b.turb.n > 0 && b.turb.u <= 8e-7 && b.turb.tau <= 2e-6, `W1b law on the GPU, eq.-32 points (${b.turb.n}): worst |u*/u*_ref − 1| ${x(b.turb.u)} (≤ 8e-7), |τ/τ_ref − 1| ${x(b.turb.tau)} (≤ 2e-6)`)
  gate.check(b.lam.n > 0 && b.lam.tau <= 8e-7, `W1b law on the GPU, laminar points (${b.lam.n}): worst |τ/τ_ref − 1| ${x(b.lam.tau)} (≤ 8e-7)`)
  gate.check(b.mis.n === 0 || (b.mis.tau <= 2e-6 && b.mis.reDev <= 1e-6), `W1b branch agreement: ${b.mis.n} points whose f32 branch differs from the f64 one${b.mis.n ? ` (worst |τ/τ_ref − 1| ${x(b.mis.tau)} ≤ 2e-6, |Re_h/Re_cross − 1| ≤ ${x(b.mis.reDev)} ≤ 1e-6)` : ''}`)
  gate.check(b.zeroTau === 0 && b.scanDecreases === 0 && b.lowEnd <= 8e-7, `W1b τ(0) on the GPU ${b.zeroTau} (exactly 0); ${b.scans} scans × ${b.scanPoints} points: ${b.scanDecreases} decreases (0), τ/τ_lam − 1 at U = 1e-7 m/s ${x(b.lowEnd)} (≤ 8e-7)`)
  for (const r of b.refs) console.log(`  [info] W1b reference (${r.U} m/s, ${r.h} m, ${r.laminar ? 'laminar' : 'eq. 32'}): τ GPU ${r.tauGpu.toPrecision(8)} / f64 ${r.tauRef.toPrecision(10)} Pa, u* GPU ${r.usGpu.toPrecision(8)} / f64 ${r.usRef.toPrecision(12)} m/s`)

  // ── W1c ──
  const F = 0.02, T_AT = [0.25, 0.5, 1]
  const lossRows = (ctl, st) => T_AT.map(t => {
    let i = 0
    for (let j = 1; j < ctl.ts.length; j++) if (Math.abs(ctl.ts[j] - t) < Math.abs(ctl.ts[i] - t)) i = j
    const loss = ctl.u[i] - st.u[i], ref = ctl.u0 - ctl.u0 / (1 + (F / 8) * ctl.u0 * ctl.ts[i] / ctl.depth)
    return { t: ctl.ts[i], loss, ref, rel: loss / ref - 1 }
  })
  const ctl = {}
  report.w1c = {}
  for (const axis of [0, 2]) {
    const c = await run('wallShearW1c', { axis, f: null }), s = await run('wallShearW1c', { axis, f: F })
    ctl[axis] = c
    report.w1c[axis] = { control: c, stage: s }
    const rows = lossRows(c, s), ax = axis === 0 ? 'x' : 'z'
    const d = c.u.map(v => v / c.u0 - 1), drift = Math.max(...d.map(Math.abs)), iMax = d.findIndex(v => Math.abs(v) === drift)
    const over = d.map((v, i) => [i, v]).filter(([, v]) => Math.abs(v) > 0.002), valid = drift <= 0.002
    gate.check(valid, `W1c validity, sheet along ${ax}: the control's (stage off) drift |ū/u0 − 1| ≤ ${(100 * drift).toFixed(3)} % over all ${c.frames} frames t ≤ 1 s (≤ 0.2 %; max at t ${c.ts[iMax].toFixed(4)} s, ${pc(d[iMax])})${valid ? '' : ` — VIOLATED at ${over.length} frames, t ${c.ts[over[0][0]].toFixed(4)}–${c.ts[over[over.length - 1][0]].toFixed(4)} s: W1c.${ax} is VOID (uncertified)`}`)
    gate.check(s.stats.applications === 2 * s.frames && s.stats.cells > 0 && s.stats.booked > 0 && c.breakdowns + s.breakdowns === 0,
      `W1c stage log, sheet along ${ax} through step() with substeps = ${s.substeps} (${s.particles} particles, ${s.frames} frames of ${(1000 * s.frame).toFixed(4)} ms): ${s.stats.applications} applications (2 per frame: the per-substep placement), ${s.stats.cells} cells acted on, ${s.stats.booked} booked; breakdowns ${c.breakdowns + s.breakdowns}, p cap hits ${c.capHits + s.capHits}`)
    const lossMsg = `sheet along ${ax}, depth ${(100 * s.depth).toFixed(3)} cm: loss (control − stage) vs exact Darcy ${rows.map(r => `t ${r.t.toFixed(3)} s ${r.loss.toFixed(5)}/${r.ref.toFixed(5)} (${pc(r.rel)})`).join(', ')} (each within 3 %)`
    if (valid) gate.check(rows.every(r => Math.abs(r.rel) <= 0.03), `W1c loss, ${lossMsg}`)
    else console.log(`VOID W1c loss (uncertified: its control failed the validity check above — neither a stage PASS nor a stage FAIL), ${lossMsg}`)
  }
  for (const [label, f, cpu] of [['τ×2', 0.04, '+85 to +95 %'], ['the sign flip', -0.02, '−205 to −223 %']]) {
    const s = await run('wallShearW1c', { axis: 0, f })
    const rows = lossRows(ctl[0], s)
    report.w1c[`control_${f}`] = s
    gate.check(rows.some(r => Math.abs(r.rel) > 0.03), `W1c control ${label} (x, f = ${f}) FAILS the 3 % bound as required: loss vs the f = 0.02 answer ${rows.map(r => `t ${r.t.toFixed(3)} s ${pc(r.rel)}`).join(', ')} (CPU ${cpu})`)
  }

  // ── W0b ──
  const w0 = await run('wallShearW0b', { viscous: true }), w0c = await run('wallShearW0b', { viscous: false })
  report.w0b = { guarded: w0, open: w0c }
  gate.check(w0.differing === 0 && w0.stats.applications === 0 && w0.stats.cells === 0 && w0.budget.viscous && !w0.budget.wallShear,
    `W0b the viscous guard on the GPU: olive oil ν ${x(w0.nu)} m²/s (${w0.particles} particles, ${w0.frames} frames), viscosityActive: stage set vs never set ${w0.differing} of ${w0.total} words differ (0); log ${w0.stats.applications} applications, ${w0.stats.cells} cells (0); budgetState viscous ${w0.budget.viscous}, wallShear ${w0.budget.wallShear}`)
  gate.check(w0c.differing > 0 && w0c.stats.cells > 0 && w0c.budget.wallShear,
    `W0b sensitivity control (the guard open: viscosityActive false) — the stage acts in this scene: ${w0c.differing} of ${w0c.total} words differ, ${w0c.stats.applications} applications, ${w0c.stats.cells} cells acted on; budgetState wallShear ${w0c.budget.wallShear}`)

  // ── W0b's drift arm (INT-7), W0c on the GPU (M1/M2), W1g.reset (M4): pre-registered 2026-09-30 before their first run ──
  const wd = await run('wallShearW0bDrift', { drift: true }), wdc = await run('wallShearW0bDrift', { drift: false })
  report.w0bDrift = { guarded: wd, open: wdc }
  gate.check(wd.differing === 0 && wd.stats.applications === 0 && wd.stats.cells === 0 && wd.budget.immiscible && !wd.budget.viscous && !wd.budget.wallShear,
    `W0b the drift guard on the GPU: water over mercury (σ ${wd.sigma} N/m; ν ${wd.nu.map(x).join(' / ')} m²/s; ${wd.particles} particles, ${wd.frames} frames; no viscosity solver), the drift active: stage set vs never set ${wd.differing} of ${wd.total} words differ (0); log ${wd.stats.applications} applications, ${wd.stats.cells} cells (0); budgetState immiscible ${wd.budget.immiscible}, viscous ${wd.budget.viscous}, wallShear ${wd.budget.wallShear}`)
  gate.check(wdc.differing > 0 && wdc.stats.cells > 0 && !wdc.budget.immiscible && wdc.budget.wallShear,
    `W0b drift sensitivity control (the same scene, the drift configured but off) — the stage acts: ${wdc.differing} of ${wdc.total} words differ, ${wdc.stats.applications} applications, ${wdc.stats.cells} cells acted on; budgetState immiscible ${wdc.budget.immiscible}, wallShear ${wdc.budget.wallShear}`)
  const rf = await run('wallShearRefusals')
  report.w0c = rf
  gate.check(rf.mustRefuse === 11 && rf.mustAccept === 3 && rf.refused === rf.mustRefuse && rf.accepted === rf.mustAccept,
    `W0c on the GPU: setWallShear refused ${rf.refused} of ${rf.mustRefuse} (the laws 'Keulegan1938', 'darcytest' and absent; darcyTest without f, constantTest without tau; without the viscosity solver a muDefault of NaN, 0 or −1 and a muTable entry of NaN or 0; with it any muDefault — each leaving the stage unset) and accepted ${rf.accepted} of ${rf.mustAccept} (f = −0.02 and τ = −10 Pa: no sign rule; the page's solver-sim configuration)${rf.results.filter(r => !r.ok).map(r => `; ✗ ${r.name} (threw ${r.threw}, set ${r.set})`).join('')}`)
  const rs = await run('wallShearReset')
  report.w1gReset = rs
  const zero = s => s.applications === 0 && s.cells === 0 && s.booked === 0 && s.laminar === 0 && s.tauMax === 0
  gate.check(rs.before.applications === 3 && rs.before.cells > 0 && zero(rs.reset) && rs.after.applications === 1 && 3 * rs.after.cells === rs.before.cells,
    `W1g.reset, the stage log's lifecycle: after 3 applications ${rs.before.applications} applications, ${rs.before.cells} cells acted on, ${rs.before.booked} booked (> 0); after resetDiagnostics() every word 0: ${zero(rs.reset)} (${rs.reset.applications}, ${rs.reset.cells}, ${rs.reset.booked}, ${rs.reset.laminar}, τ_max ${rs.reset.tauMax}); one more application: ${rs.after.applications} (1), ${rs.after.cells} cells (${rs.before.cells / 3})`)

  // ── A2 ──
  const A2 = { aCells: 12, n2: 1, h: 0.05, nx: 72, tauEnd: 3.5 }
  const on = await run('wallShearA2', A2), off = await run('column', A2)
  const sOn = columnScore(on, MM1, MM1H, [1, 3.3]), sOff = columnScore(off, MM1, MM1H, [1, 3.3])
  report.a2 = { on: { score: sOn, wallShear: on.wallShear, capHits: on.capHits, psiCapHits: on.psiCapHits, breakdowns: on.breakdowns }, off: { score: sOff, breakdowns: off.breakdowns } }
  gate.check(sOn.bestRms <= 0.10 && Math.abs(sOn.bestShift) <= 0.3 && sOn.dH <= 0.05 && on.breakdowns === 0 && on.wallShear.applications === on.ts.length && on.wallShear.cells > 0 && on.wallShear.booked > 0,
    `A2 on the GPU with the stage on, n² = 1, a = 0.6 m (${on.particles} particles): vs MM after the best shift ΔT ${sOn.bestShift.toFixed(2)} (|ΔT| ≤ 0.3) RMS Z ${(100 * sOn.bestRms).toFixed(2)} % over ${sOn.points} points (≤ 10 %); no-shift RMS ${(100 * sOn.rmsZ).toFixed(2)} % [reported]; max |ΔH| ${sOn.dH.toFixed(3)} (≤ 0.05); breakdowns ${on.breakdowns}; log ${on.wallShear.applications} applications over ${on.ts.length} frames, ${on.wallShear.cells} cells acted on (${on.wallShear.laminar} laminar), ${on.wallShear.booked} booked, τ_max ${on.wallShear.tauMax.toFixed(2)} Pa`)
  console.log(`INFO A2 late slope dZ/dT on T ∈ [1, 3.3] (REPORTED, spec W2b): GPU with the stage ${sOn.slope.toFixed(3)}, GPU without ${sOff.slope.toFixed(3)} (Δ ${(sOn.slope - sOff.slope).toFixed(3)}); CPU instant column, 12 cells, 20 °C (scratch stage, gatedesign/w2a_summary.out): with 1.669, without 1.720 (Δ −0.051); MM n² = 1: 1.400`)

  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's38-gpu', pass, report, gate.results)
exitGate(pass ? 0 : 1)
