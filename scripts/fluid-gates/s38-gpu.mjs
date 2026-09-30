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
//  W1a-K  one application, the production law (Keulegan 1938 eq. 32 + the Re_h rule), lab dx, Δt = 1/240 s, the
//         hand-built non-uniform set of wallShear.ts (0–9 and 12 floor-row particles per cell, rows 1–2 occupied,
//         v_y ≠ 0, APIC c ≠ 0, ±20 % spread + 5 % jitter, 45° directions, |U| 1e-3–5 m/s, wall cells, a μ table of
//         water/mercury/ethanol at 20 °C): every floor-row particle's tangential v within 3e-7·|U_c| of
//         flipRef.applyWallShear on the same f32 inputs (derived 2.14e-7 for the spec's chain at a_max 6.35e-3; this
//         chain — μ_c costs 6.5 ULP, not 4: K = 82.83 ULP — at this set's a_max 6.93e-3: 1.271·2^-23 + K·2^-23·a + the
//         fixed-point sums ≤ 4.1e-9 = 2.24e-7); rows ≥ 1: v and c bit-identical; every particle's v_y, m̂ and c
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
// Code-level positive controls: gpu-mutations.mjs --gate=wallShear (the Δv sign, τ×2, the floor row binned as
// y < dx/2, the momentum words at 2^24, the stage per frame instead of per substep) and --gate=perf1 (D3: one extra
// stage dispatch); they run against the clean gate tree only.
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
  gate.check(a.worst <= 3e-5 && a.otherNonZero === 0 && a.normalNonZero === 0 && a.massChanged === 0 && a.stats.applications === a.N && a.stats.cells === a.N * a.cells && a.stats.booked === a.N * a.cells,
    `W1a operator, Darcy f = 0.02, ${a.N} applications on ${a.cells} floor cells (${a.particles} particles, h_c ${(1000 * a.hc).toFixed(2)} mm, Δt ${(1000 * a.dt).toFixed(4)} ms): U_N ${a.minU.toFixed(9)}…${a.maxU.toFixed(9)} vs exact ${a.UN.toFixed(12)} m/s, worst |U_N/exact − 1| ${x(a.worst)} (≤ 3e-5); other tangential component ≠ 0: ${a.otherNonZero}, v_y ≠ 0: ${a.normalNonZero}, m̂ changed: ${a.massChanged}; log ${a.stats.applications} applications, ${a.stats.cells} cells acted on, ${a.stats.booked} booked`)
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
  gate.check(k.floorRowChecked > 0 && k.worst <= 3e-7 && k.offRowChanged === 0 && k.vyOrCChanged === 0 && k.unactedMoved === 0 && k.cellsRef > 0 && k.cellsGpu === k.cellsRef && k.applications === 1,
    `W1a-K production law through the stage, one application (${k.particles} particles, ${k.floorRowChecked} floor-row particles in acted cells): worst |Δv_GPU − Δv_ref|/|U_c| ${x(k.worst)} (≤ 3e-7; cell ${k.worstCell}); rows ≥ 1 changed ${k.offRowChanged}, v_y/m̂/c changed ${k.vyOrCChanged}, unacted floor-row particles moved ${k.unactedMoved}; cells acted on GPU ${k.cellsGpu} / reference ${k.cellsRef} (laminar ${k.laminarGpu} / ${k.laminarRef}), ${k.applications} application logged`)
  console.log(`  [info] W1a-K booked impulse (N·s): reference x ${k.booked.ref[0].toExponential(6)} z ${k.booked.ref[1].toExponential(6)}; GPU (Σ m_p·Δv_p) x ${k.booked.gpu[0].toExponential(6)} z ${k.booked.gpu[1].toExponential(6)}; per-cell τ, GPU vs reference, worst relative ${x(k.tauRel)}`)

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
