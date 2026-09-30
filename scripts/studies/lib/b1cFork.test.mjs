#!/usr/bin/env node
// b1cFork.test.mjs — CPU unit tests of lib/b1cFork.mjs (the B1c fork study's statistics) on synthetic data whose answers
// are known: no page, no GPU.   node scripts/studies/lib/b1cFork.test.mjs   (exit 0 = every check passed)
// Synthetic snapshots go through the module's own path (ArmRecord → commonFrames → reduceRun → strataOf → stratumStudy →
// evaluateReading). A drop's per-frame terms: den = Δt·u_j, dp = den·(D_arm + η_j + ε_j,arm) — η_j a per-drop effect
// every arm of the snapshot shares (heterogeneity; cancels in the paired E), ε_j,arm an arm's own noise, plus a
// per-snapshot offset (the between-history spread). D_arm = h_H + w_form: h the history's effect, w the in-window form's —
// so s_H = (w_cell − w_face)/((h_cell − h_face) + (w_cell − w_face)) is known in advance.
import { B1C, b1cBudgetOf } from '../../fluid-gates/lib/b1cSuccessors.mjs'
import {
  FRAMES, SUB, RULES, BOOT, ArmRecord, commonFrames, unionMulti, compareRuns, reduceRun, runBudget, dropSums, strataOf, never0230,
  snapshotStats, blockSums, bootE, twoLevel, stratumStudy, evaluateReading, consequences, guardCheck, percentileCI, seedFor,
  wordDiff, t0Covariates, mulberry32,
} from './b1cFork.mjs'

let fails = 0, checks = 0
const check = (ok, msg) => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const near = (a, b, tol) => Math.abs(a - b) <= tol
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v))
const DT = B1C.DT

// ── the synthetic snapshot ──────────────────────────────────────────────────────────────────────────────────────────
/** gauss from a uniform generator (Box–Muller) */
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
/**
 * H, k; nDrops; h = { cell, face } history effects, w = { cell, face } in-window form effects; het (η SD), eps (ε SD),
 * snapSD (per-snapshot offset SD); branch 'bitwise' (A, R bitwise = the same-form arm: shared ε and hashes) or
 * 'nonbitwise' (3 runs per restored arm, each its own ε and hashes); rDiff: R's own offset (a non-faithful restore);
 * multi: { tag: [q…] } frames with n = 2 in that arm; expo: (j, tag, q) → { reading, hg, jy }; wWindow: (q) → weight of w
 * per frame (default 1: the in-window effect in every frame).
 */
function synth(o) {
  const { H, k, nDrops = 400, h, w, het = 0.3, eps = 0.05, snapSD = 0, seed = 1, branch = 'bitwise', rDiff = 0, multi = {}, expo = null, wWindow = () => 1, withA = true } = o
  const r = mulberry32(seed)
  const S = H === 'cell' ? 'C' : 'F', formOf = t => (t === 'C' ? 'cell' : t === 'F' ? 'face' : H)
  const cell = new Int32Array(nDrops), row = new Uint8Array(nDrops), gDx = new Float64Array(nDrops), clean27 = new Uint8Array(nDrops)
  const u = new Float64Array(nDrops), eta = new Float64Array(nDrops)
  for (let j = 0; j < nDrops; j++) {
    row[j] = j % 2
    const x = Math.floor(r() * 64), z = Math.floor(r() * 64)
    cell[j] = x + 64 * (row[j] + 64 * z)
    gDx[j] = [0.1, 0.4, 0.9][j % 3]; clean27[j] = j % 5 === 0 ? 1 : 0
    u[j] = 0.01 * (1 + 0.3 * r()); eta[j] = het * gauss(r)
  }
  const off = snapSD * gauss(r)
  const runsSpec = [['R', 1]]
  const rounds = branch === 'nonbitwise' ? 3 : 1
  for (let q = 1; q <= rounds; q++) { runsSpec.push(['C', q], ['F', q]); if (withA) runsSpec.push(['A', q]) }
  // ε per (drop, "trajectory"): bitwise — R, the same-form arm and A are one trajectory; non-bitwise — every run its own
  const epsOf = new Map()
  const traj = (tag, run) => (branch === 'bitwise' && (tag === 'R' || tag === 'A' || tag === S) ? 'same' : `${tag}${run}`)
  const records = runsSpec.map(([tag, run]) => {
    const t = traj(tag, run)
    if (!epsOf.has(t)) epsOf.set(t, Float64Array.from({ length: nDrops }, () => eps * gauss(r)))
    const e = epsOf.get(t), form = formOf(tag)
    const rec = new ArmRecord(nDrops, { arm: tag, form, run })
    for (let q = 0; q < FRAMES; q++) {
      const n = (multi[tag] ?? []).includes(q) ? 2 : 1
      rec.frame(q, n, { pos: `${H}${k}:${t}:${q}:p${tag === 'R' ? rDiff : 0}`, vel: `${H}${k}:${t}:${q}:v`, slipState: `${H}${k}:${t}:${q}:s` })
      for (let j = 0; j < nDrops; j++) {
        const den = DT * u[j], Dq = h[H] + off + w[form] * wWindow(q) + (tag === 'R' ? rDiff : 0) + eta[j] + e[j]
        rec.put(q, j, { dp: den * Dq, a: den * 0.9, dtv: den * 0.05, dtj: den * 0.2, den }, expo ? expo(j, tag, q) : { reading: true, hg: false, jy: false })
      }
    }
    return rec
  })
  const cf = commonFrames(records)
  return { H, k, label: `${H} k=${k}`, drops: nDrops, cell, row, gDx, clean27, branch, common: cf.count,
    runs: records.map(rec => reduceRun(rec, cf.mask)), records }
}
const study = (spec, strat = 'row1') => {
  const byH = { cell: [1, 2, 3].map(k => synth({ ...spec, H: 'cell', k, seed: 100 + k })), face: [1, 2, 3].map(k => synth({ ...spec, H: 'face', k, seed: 200 + k })) }
  const st = strataOf, pick = name => sn => st(sn)[name]
  return { byH, row1: stratumStudy(byH, pick(strat), { B: 400, sizes: [4], perSnapshotCI: false }), all: stratumStudy(byH, pick('all'), { B: 400, sizes: [4], perSnapshotCI: false }) }
}
const fidelityOf = byH => Object.fromEntries(['cell', 'face'].map(H => {
  const S = H === 'cell' ? 'C' : 'F'
  const mism = byH[H].map(sn => ({ k: sn.k, c: compareRuns(sn.records.find(x => x.meta.arm === 'R'), sn.records.find(x => x.meta.arm === S)) })).find(x => !x.c.identical)
  return [H, { branch: byH[H][0].branch, checked: byH[H].length, mismatch: mism ? { k: mism.k, ...mism.c.first } : null, Rg: { row1: 0, all: 0 }, A: { row1: 0, all: 0 } }]
}))
const readOf = (R, byH, fid = fidelityOf(byH)) => evaluateReading({ name: 'primary', stratum: 'row1', fidelity: fid, delta: R.row1.delta, s: R.row1.s,
  ci: { cell: R.row1.ci['4^3'].s.cell, face: R.row1.ci['4^3'].s.face }, E: { cell: R.row1.per.cell.E, face: R.row1.per.face.E },
  floors: { cell: { A: R.row1.per.cell.A, Rg: R.row1.per.cell.Rg }, face: { A: R.row1.per.face.A, Rg: R.row1.per.face.Rg } },
  repro: { value: R.row1.delta, band: RULES.HIST_ROW1, what: 'Δ_own(row 1)' }, allS: R.all.s, allCi: { cell: R.all.ci['4^3'].s.cell, face: R.all.ci['4^3'].s.face } })

// ── 1. small pieces ─────────────────────────────────────────────────────────────────────────────────────────────────
check([seedFor(1, 0), seedFor(1, 1), seedFor(1, 2), seedFor(1, 3)].join() === '2,3,6,9' && [seedFor(2, 1), seedFor(2, 2)].join() === '4,7' && [seedFor(3, 1), seedFor(3, 2)].join() === '5,8',
  'A1 seeds: replicate k draws seed 2, then 2 + k, 2 + k + 3, … (k=1: 2,3,6,9; k=2: 2,4,7; k=3: 2,5,8)')
{
  const v = Array.from({ length: 2000 }, (_, i) => 1999 - i), c = percentileCI([...v, NaN, NaN])
  check(c.lo === 50 && c.hi === 1950 && c.nan === 2, `percentile convention (b1c-arms ratioCI): sorted[floor(0.025·B)], sorted[floor(0.975·B)] of 2000 → 50, 1950 (got ${c.lo}, ${c.hi}); NaN draws dropped and counted (${c.nan})`)
}
{
  const a = new Uint32Array([1, 2, 3, 4]), b = new Uint32Array([1, 9, 3, 7])
  const d = wordDiff(a, b), same = wordDiff(a, a.slice()), len = wordDiff(a, new Uint32Array(3))
  check(d.n === 2 && d.first === 1 && same.n === 0 && len.n === 4, `wordDiff: 2 differing words from index 1; identical → 0; another length → every word (${len.n})`)
}
{   // runBudget = b1cBudgetOf on the same drops; the numerator and denominator reported separately
  const rec = new ArmRecord(3, { arm: 'C', form: 'cell', run: 1 })
  for (let q = 0; q < FRAMES; q++) {
    rec.frame(q, q === 7 ? 2 : 1, { pos: 'p', vel: 'v', slipState: 's' })
    for (let j = 0; j < 3; j++) rec.put(q, j, { dp: 1e-6 * (j + 1), a: 2e-6, dtv: 1e-7, dtj: 5e-7 * (j + 1), den: 4e-6 }, { reading: true, hg: false, jy: false })
  }
  const cf = commonFrames([rec]), run = reduceRun(rec, cf.mask), rb = runBudget(run, [0, 2])
  const direct = b1cBudgetOf([0, 2].map(j => dropSums(run, j)))
  check(cf.count === FRAMES - 1 && rb.Ddp === direct.Ddp && rb.U === direct.U && rb.Da === direct.Da && near(rb.U, 2, 1e-12) && rb.substeps === 2 * (FRAMES - 1) && near(rb.sumDp, (1e-6 + 3e-6) * 119, 1e-15) && near(rb.sumDen, 8e-6 * 119, 1e-15) && near(rb.Ddp, 0.5, 1e-12),
    `runBudget: b1cBudgetOf's own numbers over the common frames (${cf.count} of ${FRAMES}: frame q=7 took 2 substeps); D_dp ${f3(rb.Ddp)} = Σδ_dp ${rb.sumDp.toExponential(3)} / ΣΔt·u_V ${rb.sumDen.toExponential(3)}`)
}

// ── 2. common frames, VOID, the probe / fidelity comparison ─────────────────────────────────────────────────────────
{
  const sn = synth({ H: 'cell', k: 1, nDrops: 20, h: { cell: 0, face: 0 }, w: { cell: 0, face: 0 }, multi: { F: [3, 4, 5], A: [5, 90] } })
  const cf = commonFrames(sn.records)
  check(cf.count === FRAMES - 4 && !cf.mask[3] && !cf.mask[90] && cf.mask[6] && unionMulti(sn.records) === 4,
    `common frames: single-substep in EVERY run (F multi at q 3,4,5; A at 5,90 → ${cf.count} common, the union of multi frames ${unionMulti(sn.records)})`)
  const many = synth({ H: 'face', k: 1, nDrops: 5, h: { cell: 0, face: 0 }, w: { cell: 0, face: 0 }, multi: { C: Array.from({ length: 21 }, (_, i) => 10 + i) } })
  check(commonFrames(many.records).count === 99 && commonFrames(many.records).count < B1C.MIN_USABLE, `VOID: 21 multi-substep frames in one arm → 99 common frames < ${B1C.MIN_USABLE}`)
  const R = sn.records.find(x => x.meta.arm === 'R'), C = sn.records.find(x => x.meta.arm === 'C'), A = sn.records.find(x => x.meta.arm === 'A'), F = sn.records.find(x => x.meta.arm === 'F')
  const same = compareRuns(A, C), fid = compareRuns(R, C), other = compareRuns(F, C)
  check(same.identical && fid.identical && !other.identical && other.first.frame === B1C.F0 + 1 && other.frames === FRAMES,
    `word comparison by hash: A vs C and R vs C identical (bitwise branch); F vs C differ from frame ${other.first?.frame} (${other.first?.buffer}) on ${other.frames} frames`)
  const bad = synth({ H: 'cell', k: 2, nDrops: 5, h: { cell: 0, face: 0 }, w: { cell: 0, face: 0 }, rDiff: 0.01 })
  const fb = compareRuns(bad.records.find(x => x.meta.arm === 'R'), bad.records.find(x => x.meta.arm === 'C'))
  check(!fb.identical && fb.first.frame === 268 && fb.first.buffer === 'pos', `a non-faithful restore: R vs C first differ at frame ${fb.first?.frame}, buffer ${fb.first?.buffer}`)
}

// ── 3. strata: the joint never stratum, its J_y version, the 02:30 definition, no-reading counts ─────────────────────
{
  // drop 0: kernel-exposed in C only at a common frame; 1: in F only at a frame that is multi in A (not common);
  // 2: J_y only (in R); 3: no kernel reading at 10 common frames of C; 4: clean
  const expo = (j, tag, q) => ({ reading: !(j === 3 && tag === 'C' && q < 10), hg: (j === 0 && tag === 'C' && q === 50) || (j === 1 && tag === 'F' && q === 90), jy: j === 2 && tag === 'R' && q === 60 })
  const sn = synth({ H: 'face', k: 1, nDrops: 5, h: { cell: 0, face: 0 }, w: { cell: 0, face: 0 }, multi: { A: [90] }, expo })
  const st = strataOf(sn), R = sn.runs.find(x => x.meta.arm === 'R'), C = sn.runs.find(x => x.meta.arm === 'C')
  check(st.jointNever.join() === '1,2,3,4', `joint never (kernel α_Hg ≤ 1e-4 at every COMMON frame in every run): drops ${st.jointNever.join(',')} — drop 0 (exposed in C) out, drop 1 (exposed only at a non-common frame) in`)
  check(st.jointNeverJy.join() === '1,3,4', `joint never with the J_y clause (sensitivity): ${st.jointNeverJy.join(',')} — drop 2 (J_y in R) out`)
  check(never0230(sn, R).join() === '0,1,3,4' && never0230(sn, sn.runs.find(x => x.meta.arm === 'F')).join() === '0,2,3,4',
    `the 02:30 definition on one run's own trajectory, all 120 frames: R never ${never0230(sn, R).join(',')}, F never ${never0230(sn, sn.runs.find(x => x.meta.arm === 'F')).join(',')} (drop 1's non-common frame counts here)`)
  check(C.noReading[3] === 10 && C.noReading.reduce((a, b) => a + b, 0) === 10 && R.noReading[3] === 0, `no kernel reading: counted per arm (C: drop 3 at 10 common frames; R: 0) and NOT exposed (drop 3 is in the joint never stratum)`)
  check(st.row1.length + st.row0.length === 5 && st.all.length === 5 && st['g<1/4dx'].join() === '0,3' && st['g1/4-1/2dx'].join() === '1,4' && st['g>=1/2dx'].join() === '2' && st.clean27.join() === '0',
    'row 0 / row 1 partition the set; the g bins (< ¼, ¼–½, ≥ ½ dx) and the 27-cell rule select by the t0 covariates')
}

// ── 4. the planted shares — the readings in their fixed order ────────────────────────────────────────────────────────
const cases = [
  // name, h, w, expected s, expected reading
  ['planted in-window share 0.5', { cell: -0.10, face: 0.05 }, { cell: -0.20, face: -0.05 }, 0.5, 'PARTIAL'],
  ['zero in-window effect, Δ_own −0.295 (history only)', { cell: -0.295, face: 0 }, { cell: 0, face: 0 }, 0, 'HISTORY'],
  ['no own-form difference', { cell: 0, face: 0 }, { cell: 0.01, face: 0.01 }, NaN, 'NOTHING TO ATTRIBUTE'],
  ['share 1 (in-window only) — IN-WINDOW and PARTIAL both hold: the order decides', { cell: 0, face: 0 }, { cell: -0.3, face: 0 }, 1, 'IN-WINDOW'],
  ['negative share −0.5 (the in-window form opposing)', { cell: -0.45, face: 0 }, { cell: 0.15, face: 0 }, -0.5, 'MIXED'],
]
for (const [name, h, w, sWant, want] of cases) {
  const R = study({ h, w, nDrops: 600, het: 0.3, eps: 0.03, snapSD: 0.01 })
  const rd = readOf(R, R.byH)
  const ci = R.row1.ci['4^3'].s
  const sOk = Number.isNaN(sWant) ? true : near(R.row1.s.cell, sWant, 0.08) && near(R.row1.s.face, sWant, 0.08)
  const ciOk = Number.isNaN(sWant) ? true : ci.cell.lo <= sWant && sWant <= ci.cell.hi && ci.face.lo <= sWant && sWant <= ci.face.hi
  check(rd.reading === want && sOk && ciOk, `${name}: Δ_own ${f3(R.row1.delta)}, s_cell ${f3(R.row1.s.cell)} CI [${f3(ci.cell.lo)}, ${f3(ci.cell.hi)}], s_face ${f3(R.row1.s.face)} CI [${f3(ci.face.lo)}, ${f3(ci.face.hi)}]${Number.isNaN(sWant) ? '' : ` (planted ${sWant}: inside both CIs)`} → ${rd.reading} (expected ${want}; steps ${rd.steps.map(s => `${s.name} ${s.holds ? '✓' : '✗'}`).join(', ')})`)
  if (want === 'IN-WINDOW') check(rd.steps.length === 3 && ci.cell.lo > 0 && ci.face.lo > 0, 'the order: IN-WINDOW is the reading although PARTIAL (CI above 0) holds too — PARTIAL is never evaluated')
}
{   // E's sign and Δ_own's sign: an arm swap turns the planted 0.5 into a different number (a sign slip cannot pass)
  const R = study({ h: { cell: -0.10, face: 0.05 }, w: { cell: -0.20, face: -0.05 }, nDrops: 600 })
  const e = R.row1.per.cell.E, d = R.row1.delta
  check(near(e, 0.15, 0.02) && near(d, -0.30, 0.02) && near(-e / d, 0.5, 0.05), `signs: E_cell = D_dp(F) − D_dp(C) = ${f3(e)} (planted +0.15), Δ_own = own_cell − own_face = ${f3(d)} (planted −0.30), s = −E/Δ = ${f3(-e / d)}`)
  const sw = R.row1.per.cell.snapshots.map(x => x.runs.find(r => r.arm === 'F').Ddp - x.runs.find(r => r.arm === 'C').Ddp)
  check(sw.every((x, i) => near(x, R.row1.per.cell.snapshots[i].E, 1e-12)), 'E_H,k equals the F run\'s D_dp minus the C run\'s (per snapshot)')
}

// ── 5. the bootstrap's structure ────────────────────────────────────────────────────────────────────────────────────
{   // paired: with F − C constant per drop (ε shared, η shared), E* has no drop-sampling variance → a zero-width CI
  const sn = synth({ H: 'cell', k: 1, nDrops: 300, h: { cell: 0, face: 0 }, w: { cell: -0.2, face: 0 }, het: 0.5, eps: 0 })
  const m = strataOf(sn).all, ci = bootE(sn, m, 4, 500)
  check(near(ci.lo, 0.2, 1e-9) && near(ci.hi, 0.2, 1e-9) && ci.blocks > 50, `§4 blocks resampled JOINTLY for every arm: F − C = +0.2 in every drop (η SD 0.5 shared) → E CI [${f3(ci.lo)}, ${f3(ci.hi)}] of zero width over ${ci.blocks} blocks`)
  const bs4 = blockSums(sn, m, 4), bs2 = blockSums(sn, m, 2), bs8 = blockSums(sn, m, 8)
  check(bs2.nb > bs4.nb && bs4.nb > bs8.nb && bs8.nb <= 64 && bs4.nb <= 256, `t0 blocks: 2³ ${bs2.nb} > 4³ ${bs4.nb} > 8³ ${bs8.nb} occupied blocks (rows 0–1 are one block layer)`)
  const eps = synth({ H: 'cell', k: 1, nDrops: 300, h: { cell: 0, face: 0 }, w: { cell: -0.2, face: 0 }, het: 0.5, eps: 0.1 })
  const ci2 = bootE(eps, strataOf(eps).all, 4, 500)
  check(ci2.hi - ci2.lo > 0.005 && ci2.lo < 0.2 + 0.05 && ci2.hi > 0.2 - 0.05, `with arm noise ε SD 0.1 the E CI has width: [${f3(ci2.lo)}, ${f3(ci2.hi)}]`)
}
{   // the snapshot level: no within-snapshot variance (η = ε = 0) → E*_H takes at most 10 distinct values (K = 3 multisets)
  const byH = { cell: [1, 2, 3].map(k => synth({ H: 'cell', k, seed: 10 + k, nDrops: 60, h: { cell: -0.3, face: 0 }, w: { cell: -0.1 * k, face: 0 }, het: 0, eps: 0 })),
    face: [1, 2, 3].map(k => synth({ H: 'face', k, seed: 20 + k, nDrops: 60, h: { cell: -0.3, face: 0 }, w: { cell: -0.1, face: 0 }, het: 0, eps: 0 })) }
  const pick = sn => strataOf(sn).all
  const tl = twoLevel(byH, pick, 4, 600, BOOT.SEED, true)
  const Es = new Set(tl.raw.Ecell.map(x => x.toFixed(9))), Ek = byH.cell.map(sn => snapshotStats(sn, pick(sn)).E)
  check(Es.size <= 10 && Es.size >= 7 && tl.E.cell.lo < tl.E.cell.hi && near(Ek[1] - Ek[0], 0.1, 1e-9),
    `two-level: with no drop-level variance the snapshot level alone gives E*_cell ${Es.size} distinct values (≤ 10 multisets of K = 3; per-k E ${Ek.map(f3).join(' / ')}); E_cell CI [${f3(tl.E.cell.lo)}, ${f3(tl.E.cell.hi)}]`)
  check(tl.raw.cell.every((s, b) => s === -tl.raw.Ecell[b] / tl.raw.delta[b]) && tl.raw.face.every((s, b) => s === -tl.raw.Eface[b] / tl.raw.delta[b]),
    'two-level: s*_H = −E*_H/Δ* per resample, one Δ* shared by both histories')
  const one = twoLevel({ cell: [byH.cell[0], byH.cell[0], byH.cell[0]], face: byH.face }, pick, 4, 200)
  check(near(one.E.cell.lo, one.E.cell.hi, 1e-12) && near(one.E.cell.lo, 0.1, 1e-9), `two-level: three identical snapshots and no drop-level variance → a zero-width E_cell CI (to rounding: [${one.E.cell.lo}, ${one.E.cell.hi}])`)
}

// ── 6. §5's other branches ─────────────────────────────────────────────────────────────────────────────────────────
{
  const spec = { h: { cell: -0.10, face: 0.05 }, w: { cell: -0.20, face: -0.05 }, nDrops: 400 }
  const byH = { cell: [1, 2, 3].map(k => synth({ ...spec, H: 'cell', k, seed: 300 + k, rDiff: k === 2 ? 0.02 : 0 })), face: [1, 2, 3].map(k => synth({ ...spec, H: 'face', k, seed: 400 + k })) }
  const pick = name => sn => strataOf(sn)[name]
  const R = { row1: stratumStudy(byH, pick('row1'), { B: 300, sizes: [4], perSnapshotCI: false }), all: stratumStudy(byH, pick('all'), { B: 300, sizes: [4], perSnapshotCI: false }) }
  const rd = readOf(R, byH)
  check(rd.reading === 'RESTORE NOT FAITHFUL' && rd.steps.length === 1 && /k = 2, frame 268, pos/.test(rd.steps[0].text), `bitwise branch: R ≠ the same-form arm at k = 2 → ${rd.reading}, first ("${rd.steps[0].text.slice(0, 110)}…")`)
  check(near(R.row1.per.cell.Rg, 0.02, 1e-9), `Rg_H = max_k |D_dp(R) − D_dp(same-form)| = ${f3(R.row1.per.cell.Rg)} (planted 0.02 at k = 2)`)
}
{   // non-bitwise: Rg vs 0.037 and 2·A_H; the IN-WINDOW floor clause
  const mk = (rDiff, eps) => {
    const spec = { h: { cell: 0, face: 0 }, w: { cell: -0.3, face: 0 }, nDrops: 400, branch: 'nonbitwise', eps }
    const byH = { cell: [1, 2, 3].map(k => synth({ ...spec, H: 'cell', k, seed: 500 + k, rDiff })), face: [1, 2, 3].map(k => synth({ ...spec, H: 'face', k, seed: 600 + k, rDiff })) }
    const pick = name => sn => strataOf(sn)[name]
    const R = { row1: stratumStudy(byH, pick('row1'), { B: 300, sizes: [4], perSnapshotCI: false }), all: stratumStudy(byH, pick('all'), { B: 300, sizes: [4], perSnapshotCI: false }) }
    const fid = Object.fromEntries(['cell', 'face'].map(H => [H, { branch: 'nonbitwise', checked: 3, mismatch: null, Rg: { row1: R.row1.per[H].Rg, all: R.all.per[H].Rg }, A: { row1: R.row1.per[H].A, all: R.all.per[H].A } }]))
    return { R, byH, rd: readOf(R, byH, fid) }
  }
  const good = mk(0, 0.02), bad = mk(0.08, 0.02)
  check(good.byH.cell[0].runs.length === 10 && good.R.row1.per.cell.A > 0 && good.R.row1.per.cell.Rg < RULES.RG_BAR && good.rd.reading === 'IN-WINDOW',
    `non-bitwise: 10 runs a snapshot (R + 3 × C, F, A); A_H ${f3(good.R.row1.per.cell.A)} (the RMS of matched A_j − C_j), Rg_H ${f3(good.R.row1.per.cell.Rg)} → ${good.rd.reading}`)
  check(bad.rd.reading === 'RESTORE NOT FAITHFUL' && bad.R.row1.per.cell.Rg > RULES.RG_BAR, `non-bitwise: R offset 0.08 → Rg_H ${f3(bad.R.row1.per.cell.Rg)} > 0.037 and > 2·A_H ${f3(2 * bad.R.row1.per.cell.A)} → ${bad.rd.reading}`)
  const noisy = mk(0, 0.6)
  const E = noisy.R.row1.per.cell.E, fl = 2 * Math.max(noisy.R.row1.per.cell.A, noisy.R.row1.per.cell.Rg)
  const inStep = noisy.rd.steps.find(s => s.name === 'IN-WINDOW')
  check(!inStep || !inStep.holds || Math.abs(E) > fl, `non-bitwise IN-WINDOW floor: |E_H| ${f3(Math.abs(E))} vs 2·max(A_H, Rg_H) ${f3(fl)} → IN-WINDOW ${inStep?.holds ? 'holds' : 'does not hold'} (reading ${noisy.rd.reading})`)
  const fid = { cell: { branch: 'nonbitwise', mismatch: null, Rg: { row1: 0, all: 0 }, A: { row1: 0, all: 0 } }, face: { branch: 'nonbitwise', mismatch: null, Rg: { row1: 0, all: 0 }, A: { row1: 0, all: 0 } } }
  const forced = evaluateReading({ name: 'primary', stratum: 'row1', fidelity: fid, delta: -0.3, s: { cell: 1, face: 1 }, ci: { cell: { lo: 0.9, hi: 1.1 }, face: { lo: 0.9, hi: 1.1 } },
    E: { cell: 0.3, face: 0.3 }, floors: { cell: { A: 0.2, Rg: 0 }, face: { A: 0, Rg: 0 } }, repro: { value: -0.3, band: RULES.HIST_ROW1, what: 'Δ_own(row 1)' } })
  check(forced.reading === 'PARTIAL' && !forced.steps.find(s => s.name === 'IN-WINDOW').holds, `the floor clause decides: |E| 0.3 ≤ 2·A_H 0.4 in one history → IN-WINDOW fails, PARTIAL (got ${forced.reading})`)
}
{   // the guard (MIXED's all-drop clause): computed and reported; under the literal order it vetoes nothing
  const g = guardCheck({ cell: 0.5, face: 0.4 }, { cell: { lo: -0.9, hi: -0.1 }, face: { lo: 0.1, hi: 0.9 } })
  check(g.cell && !g.face && g.fires, 'guard: s_H(all) CI entirely below 0 while s_H(row 1) > 0 → opposite (cell); a CI on the same side → not (face)')
  const g2 = guardCheck({ cell: 0.5, face: -0.4 }, { cell: { lo: -0.2, hi: 0.3 }, face: { lo: -0.3, hi: 0.2 } }), g3 = guardCheck({ cell: -0.5, face: 0 }, { cell: { lo: 0.05, hi: 0.3 }, face: { lo: -0.9, hi: -0.1 } })
  check(!g2.cell && !g2.face && !g2.fires && g3.cell && !g3.face, 'guard: a CI straddling 0 excludes nothing (never opposite); s_H(row 1) < 0 with the CI above 0 → opposite; s_H = 0 has no side')
  const fid = { cell: { branch: 'bitwise', checked: 3, mismatch: null }, face: { branch: 'bitwise', checked: 3, mismatch: null } }
  const rd = evaluateReading({ name: 'primary', stratum: 'row1', fidelity: fid, delta: -0.3, s: { cell: 0.5, face: 0.4 }, ci: { cell: { lo: 0.2, hi: 0.8 }, face: { lo: 0.1, hi: 0.7 } },
    E: { cell: 0.15, face: 0.12 }, floors: { cell: { A: 0, Rg: 0 }, face: { A: 0, Rg: 0 } }, repro: { value: -0.3, band: RULES.HIST_ROW1, what: 'Δ_own(row 1)' }, allS: { cell: -0.5, face: 0.4 },
    allCi: { cell: { lo: -0.9, hi: -0.1 }, face: { lo: 0.1, hi: 0.9 } } })
  check(rd.reading === 'PARTIAL' && rd.guard.fires && rd.guard.wouldVeto, `guard reported beside the reading: ${rd.reading} (literal order) with "would veto" flagged — ${rd.guard.text.slice(0, 120)}…`)
}
{   // HISTORY needs the reproduction band too
  const fid = { cell: { branch: 'bitwise', checked: 3, mismatch: null }, face: { branch: 'bitwise', checked: 3, mismatch: null } }
  const base = { name: 'primary', stratum: 'row1', fidelity: fid, s: { cell: 0.02, face: -0.01 }, ci: { cell: { lo: -0.1, hi: 0.12 }, face: { lo: -0.15, hi: 0.1 } }, E: { cell: 0, face: 0 }, floors: { cell: { A: 0, Rg: 0 }, face: { A: 0, Rg: 0 } } }
  const inBand = evaluateReading({ ...base, delta: -0.30, repro: { value: -0.30, band: RULES.HIST_ROW1, what: 'Δ_own(row 1)' } })
  const outBand = evaluateReading({ ...base, delta: -0.20, repro: { value: -0.20, band: RULES.HIST_ROW1, what: 'Δ_own(row 1)' } })
  check(inBand.reading === 'HISTORY' && outBand.reading === 'MIXED', `HISTORY needs Δ_own(row 1) inside [−0.369, −0.221]: −0.30 → ${inBand.reading}; −0.20 → ${outBand.reading} (the CI alone is not enough)`)
  const edge = evaluateReading({ ...base, delta: -0.0999, repro: { value: -0.0999, band: RULES.HIST_ROW1, what: '' } })
  check(edge.reading === 'NOTHING TO ATTRIBUTE' && evaluateReading({ ...base, delta: -0.1, repro: { value: -0.1, band: RULES.HIST_ROW1, what: '' } }).reading !== 'NOTHING TO ATTRIBUTE',
    '|Δ_own| < 0.10 is strict: 0.0999 → NOTHING TO ATTRIBUTE, 0.100 → not')
}
{   // sub-window E: an in-window effect only in the third 30-frame sub-window
  const byH = { cell: [1, 2, 3].map(k => synth({ H: 'cell', k, seed: 700 + k, nDrops: 200, h: { cell: -0.1, face: 0 }, w: { cell: -0.4, face: 0 }, eps: 0.01, wWindow: q => (q >= 60 && q < 90 ? 1 : 0) })),
    face: [1, 2, 3].map(k => synth({ H: 'face', k, seed: 800 + k, nDrops: 200, h: { cell: -0.1, face: 0 }, w: { cell: -0.4, face: 0 }, eps: 0.01, wWindow: q => (q >= 60 && q < 90 ? 1 : 0) })) }
  const R = stratumStudy(byH, sn => strataOf(sn).all, { B: 100, sizes: [4], perSnapshotCI: false })
  const Ew = R.per.cell.Ew
  check(SUB === 30 && Ew.length === 4 && near(Ew[2], 0.4, 0.02) && [0, 1, 3].every(w => near(Ew[w], 0, 0.02)) && near(R.per.cell.E, 0.1, 0.01),
    `E per 30-frame sub-window: ${Ew.map(f3).join(' / ')} (planted 0 / 0 / 0.4 / 0); the whole window ${f3(R.per.cell.E)} (0.1 = a quarter of it)`)
}
{   // the consequences text (§6)
  const c1 = consequences({ reading: 'PARTIAL' }, { reading: 'IN-WINDOW' }), c2 = consequences({ reading: 'MIXED' }, { reading: 'MIXED' })
  check(c1.some(t => /in-window share/.test(t)) && c1.some(t => /disagree/.test(t)) && c1.some(t => /principal stratum/.test(t)) && c2.some(t => /no change/.test(t)) && !c2.some(t => /disagree/.test(t)) && c1.concat(c2).filter(t => /W4's must-fail control/.test(t)).length === 2,
    '§6: PARTIAL records the share; the secondary carries the principal-stratum label; a disagreement keeps the item open; MIXED changes nothing; the cell form stays in code either way')
}

// ── 7. the t0 covariates (snapshot-page's G-R4 computation) on a hand-built sample ──────────────────────────────────
{
  const L = B1C.L, DX = B1C.DX
  // positions in dx (y = 1e-7 m: a film particle at the wallEps floor). Drop A (10.5, 1.5, 10.5), row 1, with mercury M1 at
  // x 12.3 (cell 12: outside its 27 cells) → g = max(1.8 − 1, 1.5 − 1) = 0.8, clean. Drop B (40.5, 0.5, 40.5), row 0, M2 at
  // x 42.2 (cell 42: outside) → g = 0.7, clean. Drop C (20.5, 0.5, 20.5), M3 in its own cell → g 0, not clean. Drop D
  // (30.5, 1.5, 30.5), row 1, M4 at x 31.9 on the floor (cell (31, 0, 30): inside its 27) → g = max(0.4, 0.5 − 1e-7 m/dx) —
  // the knife edge G-R4 found (row-1 gaps at ½dx − wallEps): just below ½, the ¼–½ bin.
  const P = [[10.5, 1.5, 10.5], [12.3, 1e-7 / DX, 10.5], [40.5, 0.5, 40.5], [42.2, 1e-7 / DX, 40.5], [20.5, 0.5, 20.5], [20.7, 0.3, 20.6], [30.5, 1.5, 30.5], [31.9, 1e-7 / DX, 30.5]]
  const comp = [1, 2, 1, 2, 1, 2, 1, 2]
  const s = { n: P.length, pos: Float32Array.from(P.flat().map(v => (v * DX) / L)), comp: Uint32Array.from(comp), materials: [{ id: 0, name: 'Water' }, { id: 1, name: 'Olive Oil' }, { id: 2, name: 'Mercury' }] }
  const cov = t0Covariates(s, { set: [0, 2, 4, 6], row: [1, 0, 0, 1] })
  const g = cov.drops.map(d => d.gDx), c27 = cov.drops.map(d => d.clean27)
  check(near(g[0], 0.8, 1e-5) && near(g[1], 0.7, 1e-5) && g[2] === 0 && g[3] < 0.5 && near(g[3], 0.5, 1e-5) && c27.join() === 'true,true,false,false',
    `t0 covariates: g/dx ${g.map(v => v.toFixed(6)).join(', ')} (expected 0.8, 0.7, 0, just below 0.5); the 27-cell rule ${c27.join(', ')} (expected true, true, false, false)`)
  check(cov.footprint.cells === 4 && cov.mercury.belowMilliDx === 3 && cov.mercury.n === 4, `the film's floor footprint ${cov.footprint.cells} row-0 cells (4) and the mercury below 1e-3·dx ${cov.mercury.belowMilliDx} of ${cov.mercury.n} (3 of 4), counted as G-R4 counts them`)
}

console.log(`\nb1cFork.test: ${fails ? `FAILED ${fails} of ${checks}` : `PASSED ${checks}/${checks}`}`)
process.exit(fails ? 1 : 0)
