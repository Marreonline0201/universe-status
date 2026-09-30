#!/usr/bin/env node
// b1c-fork.mjs — the B1c forked same-state drift-form study: spec rev 3 (FROZEN, sha256
// a3290c5464eb3cc57f17f34ddd83151f2d1e1b6b5d49ec7007ec1444ef6189c6; scratch b1c_fork/spec_rev3.md, recorded in the vault
// session log) — §3 the arms and their order, §3a the strata, §4 the statistics, §5 the readings in their fixed order,
// §6 the consequences — on the facility snapshot-page.mjs certified at b8db4532 (G-R1 bitwise: the BITWISE branch).
//
//   node scripts/studies/b1c-fork.mjs                        (default server: the clean gate tree; AC only — a GPU run)
//   node scripts/studies/b1c-fork.mjs --analyze=<partial.jsonl>   (CPU only: the statistics and readings again from a
//                                                                 run's per-snapshot records — no page)
//
// Written 2026-09-30 18:36 EDT by implementer F, before any run (tested only on CPU: lib/b1cFork.test.mjs, and this text
// against a mock page and a fake engine). Nothing below is to be tuned after a result; a change is a dated amendment
// appended below, never an edit of this text.
//
// Amendments:
//   "A1 (2026-09-30, before any run): replicate k's history uses seed 2 as §3 says; if its F0 snapshot is bitwise identical
//   to an earlier replicate's of the same H (a deterministic history), that replicate is re-drawn with seed 2 + k (then
//   2 + k + 3, …), recorded — so the K = 3 snapshots are distinct states. The 02:30 study's same-seed histories diverged
//   (drop sets 1430/1342/1362), so the re-draw is expected to be unused."
//   Identity = the F0 pos, vel and slipState words (FlipGpuSimulator.namedBuffers via stateWords), word for word.
//
// Protocol (spec §3). One page session, the B1 scene of snapshot-page.mjs / b1c-driftform.mjs, lockstep, g = 9.80665.
// H = cell (k = 1…3), then H = face (k = 1…3). A history: configure({ immDriftForm: H }), lib/b1cSuccessors.mjs b1cToF0
// (b1cDense's schedule: 1/60 s frames to 3.85 s, then 1/240 s frames with the density snapshot, to t0 = frame 267, and the
// F0 sample); drainReadbacks; status(); snapshotState(); hostState(); the F0 pos/vel/slipState words — checked equal to the
// F0 sample's posRaw and drift (t0 did not move) and against every earlier F0 of H (A1). The frozen set D_H,k and its
// strata and t0 covariates come from THAT sample (b1cFrozenSet; §3a) and are printed before any budget is read.
// Arms: R (the original run continued, H's form) first, then restored in place: C (cell), F (face), A (H's form again)
// interleaved. A restore = restoreState(), the step limit and the clock back to F0 (setClock: the snapshot's), a drain.
// Before every arm, R included: configure({ immDriftForm: its form }), then asserted — status(): the arm's form, the
// drift active, wallShear off or guarded, no ball, the Stokes path inactive, the count; the clock at F0; hostState(): the
// snapshot's v_lag and viscous cap, no readback slot in flight. A window frame f = 268…387 is ONE page call (stepFrame,
// verbatim from snapshot-page.mjs: the step limit, the frame awaited in an animation-frame callback, drainReadbacks(),
// status()), then sample() (the full particle sample: every quantity b1cDense reads), then the vel words (stateWords).
// Per frame: n = the substepsTotal delta; the sha256 of the pos, vel and slipState words (pos and slipState = the sample's
// posRaw and drift, the same buffers); per drop of D_H,k b1cDense's own terms (b1cBudgetTerms: δ_dp, a, Δt·v_y, Δt·u_V,y,
// Δt·J_y) and exposure (b1cExposure: the kernel reading, α_Hg > 1e-4, J_y < −1 cm/s); the sample's frame, count and
// composition ids asserted. The first frame's `prev` is the ORIGINAL F0 sample in every arm. After the arm: 0 new
// viscousCapHits (diagnostics()) and the status again. Only derived per-frame terms are kept (~7 MB an arm), never samples.
// The determinism probe (k = 1 of each H, before any budget is read): A_H,1 vs the same-form restored arm (C on cell
// histories, F on face), bitwise at every window frame. Identical → the BITWISE branch: A ≡ 0, each restored arm runs
// once per snapshot (A not at k = 2, 3), and restore fidelity is R_H,k vs the same-form restored arm, bitwise at every
// frame (the first differing frame and buffer reported). Not identical → the NON-BITWISE branch (choice (4)): each
// restored arm 3 times per snapshot (C, F, A, C, F, A, C, F, A), A and Rg as in §4.
// Common frames: single-substep in EVERY run of the snapshot; fewer than 100 → VOID, replaced by a new history.
//
// Statistics (spec §4; lib/b1cFork.mjs). Per drop and run, sums over the common frames of δ_dp, a, Δt·v_y, Δt·J_y and
// Δt·u_V,y; per stratum D_dp, D_a, Λ_native, U exactly as b1cSuccessors forms them (b1cBudgetOf), with Σδ_dp and ΣΔt·u_V,y
// reported apart. E_H,k = D_dp(F_H,k) − D_dp(C_H,k), E_H = its mean over k (and per 30-frame sub-window); Δ_own =
// mean_k D_dp(C_cell,k) − mean_k D_dp(F_face,k) on the same stratum; s_H = −E_H/Δ_own. A_H,k, Rg_H,k and A_H, Rg_H (max
// over k) as §4. CIs: §4's block bootstrap of E_H,k within each snapshot (t0 blocks of 4³ cells; 2³ and 8³ reported), and
// §5's two-level bootstrap of s_H (snapshots resampled within each history, then blocks, jointly for every arm).
// Strata (§3a): row 1 PRIMARY, all GUARD, row 0 reported, the joint never stratum SECONDARY (kernel α_Hg ≤ 1e-4 at every
// common frame in every run — a principal stratum), its J_y-clause version (sensitivity); t0 covariates reported: the
// 27-cell rule and g_i (counts by row; D_dp and E per g bin and on the 27-cell subset).
//
// Readings (spec §5, verbatim; per history, the first that holds is the reading; primary row 1, guard all):
//   RESTORE NOT FAITHFUL  bitwise: R_H,k ≠ the same-form restored arm at any window frame of any k; non-bitwise:
//                         Rg_H > 0.037 AND Rg_H > 2·A_H in either history, on row 1 or on all → stop; repair the restore
//   NOTHING TO ATTRIBUTE  |Δ_own| < 0.10 on row 1 → s_H undefined
//   IN-WINDOW             s_H ≥ 0.75 and s_H's CI lower end ≥ 0.25 in both histories (non-bitwise: and |E_H| > 2·max(A_H, Rg_H))
//   HISTORY               s_H's CI inside [−0.25, +0.25] in both, AND Δ_own(row 1) inside [−0.369, −0.221]
//   PARTIAL               s_H's CI above 0 in both histories
//   MIXED                 anything else
//   The never question (SECONDARY): the same rules on the joint never stratum, NOTHING at |Δ_own| < 0.10, the primary's
//   fidelity verdict; its HISTORY reproduction on the 02:30-definition never stratum: Δ_own inside [0.28, 0.43].
// Consequences (spec §6) are printed with the readings.
//
// Implementation choices — what the spec leaves open, fixed here before any run (flagged to the lead):
//   (1) The CI level (LOAD-BEARING: IN-WINDOW, HISTORY and PARTIAL read the CI; the spec names none): 95 %, the percentile
//       limits sorted[floor(0.025·B)] and sorted[floor(0.975·B)] — the project's convention (b1c-arms.mjs ratioCI);
//       B = 2000; mulberry32 seed 20260930 for §5's two-level bootstrap, seed + 1000·(face) + (k − 1) for §4's per-snapshot E.
//   (2) The guard (not implementable as written without a choice): §5 lists "s_H(all) with a CI excluding 0 on the opposite
//       side from s_H(row 1) in either history" under MIXED, but under "the first that holds is the reading" it can never
//       change a reading (anything reaching MIXED is MIXED already). Implemented LITERALLY — the fixed order decides — and
//       the guard is computed and printed beside every reading, with whether it WOULD veto. "Opposite side": s_H(all)'s CI
//       entirely on the other side of 0 from the sign of s_H(row 1)'s point estimate (the secondary: s_H(joint never)'s).
//   (3) Bootstrap units: a stratum resamples the t0 blocks its drops occupy (as many draws as those blocks, with
//       replacement), the same draw for every arm and run of the snapshot; two-level: per resample cell then face, K
//       snapshots drawn with replacement per history, each drawn snapshot block-resampled on its own; one Δ* per resample
//       for both s*_H. A draw with an empty stratum (NaN) is dropped and counted.
//   (4) The branch: the study starts bitwise; the first k = 1 probe that fails (either history, any attempt) switches the
//       study to the non-bitwise branch — its current snapshot gets rounds 2 and 3 at once, every later snapshot 3 rounds —
//       and nothing switches back. Snapshots run before a switch keep the branch their own history's probe established,
//       so each history's snapshots share one branch, and §5 judges each history by its own (a later history's k = 1
//       probe is still run and reported). Bitwise: A runs at k = 1 only; A_H,k = 0 at k = 2, 3 (recorded "not run").
//   (5) Non-bitwise A_H,k: the RMS of the matched single-run differences D_dp(A_j) − D_dp(same-form_j), j = 1…3.
//   (6) A bitwise-branch fidelity mismatch stops the study after that snapshot (§5 "→ stop"): primary and secondary read
//       RESTORE NOT FAITHFUL with the first differing k, frame and buffer.
//   (7) The 02:30-definition never stratum: each R arm's own trajectory, exposed by the kernel or the J_y clause at ANY of
//       the 120 window frames (b1cDense's rule, multi-substep frames included); its D_dp over the snapshot's common frames.
//   (8) "Compared frames" = the common frames (the joint never stratum's test; the per-run no-kernel-reading counts).
//   (9) A snapshot is VOID as soon as its runs' multi-substep frames exceed 20 (the rest of its arms are not run); the
//       replacement history keeps the replicate's current seed (A1 moves it on identity only); at most 5 history attempts
//       per replicate, then the study stops INCOMPLETE (the spec sets no cap).
//  (10) A1's identity is checked against every earlier F0 of the same history in this study (valid, VOID or rejected).
//  (11) Every assert (§3's per-arm asserts, the per-frame checks, the F0 integrity check) is fatal: the study stops
//       INCOMPLETE with the failure; the snapshots already done stay in the partial file.
//  (12) E's sub-windows: frames 268–297, 298–327, 328–357, 358–387, each over its common frames.
//  (13) Power: refuses to start off AC; stops (partial file kept) if AC is lost before a history or an arm.
// Time (from the records: the 02:30 study ran 6 dense runs — each a history and 120 sampled window frames — between its
// 02:18 registration and its 02:30:38 JSON, so ≤ 2.1 min a run and ≤ ~0.9 s a sampled frame; snapshot-page ran two
// histories, 60 word-read frames and 4 restores in ~50 s, so a history ≲ 15–20 s): the bitwise plan is 6 histories and
// 20 arms × 120 = 2,400 sampled frames at ~0.7–1.0 s (the sample, plus the vel words and three sha256 a frame) ≈ 30–45 min;
// the non-bitwise plan 60 arms = 7,200 frames ≈ 1.5–2.2 h. The statistics (9 strata, 2000 resamples × 3 block sizes)
// add ≲ 1 min (measured on CPU at 1400 drops: 4.5 s bitwise, 8.2 s non-bitwise), the power checks (one per history and
// arm, three PowerShell calls each) ~1–2 min. Output: bench-results/studies/b1c-fork-<time>.json (provenance: the gate
// stamp), .report.txt (this console text) and -partial-<time>.jsonl (one record per snapshot as it completes: the
// per-drop sums, enough for --analyze; ~15–20 MB bitwise, ~40–60 MB non-bitwise; bench-results/ is git-ignored).
import path from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openFluidPage, provenance, status, sample, G_STANDARD } from '../lib/fluid-page.mjs'
import { b1cToF0, b1cFrozenSet, b1cExposure, b1cBudgetTerms, B1C } from '../fluid-gates/lib/b1cSuccessors.mjs'
import { powerState, describePower } from '../lib/power.mjs'
import { exitGate } from '../lib/exit.mjs'
import {
  FRAMES, NSUB, RULES, BOOT, MIN_COMMON, BUFFERS, G_BINS, ArmRecord, commonFrames, unionMulti, compareRuns, reduceRun, runBudget,
  t0Covariates, strataOf, never0230, armRuns, sameFormArm, stratumStudy, evaluateReading, consequences, seedFor, wordDiff,
} from './lib/b1cFork.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPEC = 'B1c fork spec rev 3 (FROZEN, sha256 a3290c5464eb3cc57f17f34ddd83151f2d1e1b6b5d49ec7007ec1444ef6189c6)'
const AMENDMENTS = ['A1 (2026-09-30, before any run): replicate k\'s history uses seed 2 as §3 says; if its F0 snapshot is bitwise identical to an earlier replicate\'s of the same H (a deterministic history), that replicate is re-drawn with seed 2 + k (then 2 + k + 3, …), recorded — so the K = 3 snapshots are distinct states. The 02:30 study\'s same-seed histories diverged (drop sets 1430/1342/1362), so the re-draw is expected to be unused.']
const { F0 } = B1C
const HISTORIES = ['cell', 'face'], K = 3, MAX_ATTEMPTS = 5, MAX_MULTI = FRAMES - MIN_COMMON, ALL_ITEMS = ['pos', 'vel', 'aff', 'aux', 'slipState', 'pressureX']
// the B1 scene of scripts/studies/b1c-driftform.mjs:33-36 (s31c-page's B1; snapshot-page.mjs), verbatim
const SCENE = { name: 's31c-buoyancy', materials: [], gravity_mps2: G_STANDARD, spawns: [
  { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } },
  { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } },
  { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] }
// the strata of §3a the statistics run on (PRIMARY row1, GUARD all, SECONDARY jointNever; the rest reported)
const STRATA = ['row1', 'all', 'row0', 'jointNever', 'jointNeverJy', ...G_BINS.map(([n]) => n), 'clean27']
const LABEL = { row1: 'row 1 (PRIMARY)', all: 'all (GUARD)', row0: 'row 0 (reported)', jointNever: 'joint never (SECONDARY; a principal stratum)', jointNeverJy: 'joint never with the J_y clause (sensitivity)', clean27: 'the 27-cell rule\'s subset (t0 covariate, reported)', 'g<1/4dx': 'g < ¼dx (reported)', 'g1/4-1/2dx': 'g ¼–½dx (reported)', 'g>=1/2dx': 'g ≥ ½dx (reported)' }

const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v))
const f4 = v => (Number.isFinite(v) ? v.toFixed(4) : String(v))
const ci = c => (c ? `[${f3(c.lo)}, ${f3(c.hi)}]${c.nan ? ` (${c.nan} NaN draws)` : ''}` : '—')
const lines = []
const log = (...a) => { const t = a.join(' '); lines.push(t); console.log(t) }
const T0 = Date.now(), elapsed = () => `${((Date.now() - T0) / 60000).toFixed(1)} min`
/** JSON with non-finite numbers as strings (NaN, ±Infinity survive a round trip through --analyze). */
const jsonText = (o, space) => JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : ArrayBuffer.isView(v) ? Array.from(v) : v), space)
const num = x => (typeof x === 'string' ? Number(x) : x)

class StudyStop extends Error { constructor(kind, detail) { super(`${kind}: ${detail}`); this.kind = kind; this.detail = detail } }

// ── the page protocol ────────────────────────────────────────────────────────────────────────────────────────────────
/** One window frame in one page call — snapshot-page.mjs's stepFrame, verbatim. */
const stepFrame = (page, f) => page.evaluate(async f => {
  const b = window.__fluidBench
  b.setStepLimit(f)
  await new Promise((resolve, reject) => {
    let done = false
    const watchdog = setTimeout(() => { done = true; reject(new Error(`frame ${f} not stepped within 60 s (at ${b.status().framesStepped}, page ${document.visibilityState})`)) }, 60_000)
    const tick = () => {
      if (done) return
      if (b.status().framesStepped >= f) { done = true; clearTimeout(watchdog); resolve() } else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const drain = await b.drainReadbacks()
  const st = b.status()
  return { drain, host: b.hostState(), framesStepped: st.framesStepped, substepsTotal: st.substepsTotal, simTime: st.simTime }
}, f)
/** The live words of carried states, as u32 arrays over fresh copies of the bytes (snapshot-page.mjs's words). */
async function words(page, names) {
  const r = await page.evaluate(n => window.__fluidBench.stateWords(n), names)
  const out = {}
  for (const [k, b64] of Object.entries(r)) { const b = Buffer.from(b64, 'base64'); out[k] = new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  return out
}
const u32 = a => new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4)
const sha = a => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex')
const busyN = s => (s ? s.speed + s.visc + s.ball + s.stokes : 0)
/** §3's per-arm status asserts (snapshot-page.mjs's b1Status, with the arm's form). */
function armStatus(st, form, count) {
  const bad = []
  if (st.count !== count) bad.push(`count ${st.count} ≠ ${count}`)
  if (st.immiscible?.form !== form) bad.push(`form ${st.immiscible?.form} ≠ ${form}`)
  if (st.immiscible?.active !== true) bad.push(`drift active ${st.immiscible?.active}`)
  if (!['off', 'guarded'].includes(st.wallShear)) bad.push(`wallShear ${st.wallShear}`)
  if (st.ball !== null) bad.push('a ball')
  if (st.stokes?.active !== false) bad.push(`Stokes ${JSON.stringify(st.stokes)}`)
  return bad
}
function checkPower(where) {
  const p = powerState()
  if (p.ac !== true) throw new StudyStop('power', `${where}: ${describePower(p)} — a GPU study runs on AC only (owner rule)`)
}

/** restoreState(), the step limit and the clock back to F0, a drain (snapshot-page.mjs's restoreTo, every item). */
async function restoreTo(page, snap) {
  const r = await page.evaluate(() => window.__fluidBench.restoreState({}))
  await page.evaluate(f => window.__fluidBench.setStepLimit(f), F0)
  const c = await page.evaluate(c => window.__fluidBench.setClock(c), snap.clock)
  const d = await page.evaluate(() => window.__fluidBench.drainReadbacks())
  const names = r.restored.map(i => i.name)
  if (r.kept.length || !ALL_ITEMS.every(n => names.includes(n))) throw new StudyStop('assert', `restore: restored ${names.join(', ')}, kept ${r.kept.join(', ') || 'none'} — every carried item must be restored`)
  if (busyN(d.busyAtExit)) throw new StudyStop('assert', `restore: a readback slot in flight after the drain ${JSON.stringify(d.busyAtExit)}`)
  return { restored: names, host: r.host, clock: c }
}

/** One arm run through the window (header: the per-frame protocol); returns its ArmRecord. */
async function runArm(page, ctx, tag, form, run, restored, plan) {
  checkPower(`${ctx.id} arm ${tag}`)
  const t0 = Date.now()
  const rs = restored ? await restoreTo(page, ctx.snap) : null
  await page.evaluate(f => window.__fluidBench.configure({ immDriftForm: f }), form)
  const st = await status(page), host = await page.evaluate(() => window.__fluidBench.hostState())
  const bad = armStatus(st, form, ctx.count)
  const c = ctx.snap.clock
  if (st.framesStepped !== F0 || st.substepsTotal !== c.substepsTotal || st.simTime !== c.simTime) bad.push(`clock ${st.framesStepped}/${st.simTime}/${st.substepsTotal} ≠ the snapshot's ${c.steppedFrames}/${c.simTime}/${c.substepsTotal}`)
  if (host.vLag !== ctx.snap.host.vLag || host.viscCap !== ctx.snap.host.viscCap) bad.push(`host v_lag ${host.vLag} / cap ${host.viscCap} ≠ the snapshot's ${ctx.snap.host.vLag} / ${ctx.snap.host.viscCap}`)
  if (busyN(host.slotsBusy)) bad.push(`readback slots in flight ${JSON.stringify(host.slotsBusy)}`)
  if (bad.length) throw new StudyStop('assert', `${ctx.id} arm ${tag} (${form}, run ${run}) at F0: ${bad.join('; ')}`)
  const d0 = await page.evaluate(() => window.__fluidBench.diagnostics())
  const rec = new ArmRecord(ctx.set.length, { arm: tag, form, run })
  let subPrev = st.substepsTotal, prev = ctx.h.s, entryBusy = 0
  for (let q = 0; q < FRAMES; q++) {
    const f = F0 + 1 + q
    const r = await stepFrame(page, f)
    if (busyN(r.drain.busyAtEntry)) entryBusy++
    const n = r.substepsTotal - subPrev
    subPrev = r.substepsTotal
    const s = await sample(page)
    if (r.framesStepped !== f || s.frame !== f || s.n !== ctx.count || !s.drift || !s.slipIn || !s.uV || !s.posDp || !s.posRaw || busyN(r.drain.busyAtExit))
      throw new StudyStop('assert', `${ctx.id} arm ${tag} frame ${f}: stepped ${r.framesStepped}, sample frame ${s.frame}, n ${s.n} (count ${ctx.count}), drift state ${!!(s.drift && s.slipIn && s.uV)}, density snapshot ${!!(s.posDp && s.posRaw)}, slots after the drain ${JSON.stringify(r.drain.busyAtExit)}`)
    const dc = wordDiff(ctx.comp, s.comp)
    if (dc.n) throw new StudyStop('assert', `${ctx.id} arm ${tag} frame ${f}: ${dc.n} composition ids differ from the snapshot's (first particle ${dc.first})`)
    const v = await words(page, ['vel'])
    rec.frame(q, n, { pos: sha(s.posRaw), vel: sha(v.vel), slipState: sha(s.drift) })
    for (let j = 0; j < ctx.set.length; j++) { const i = ctx.set[j]; rec.put(q, j, b1cBudgetTerms(s, prev, i), b1cExposure(s, i, ctx.rho)) }
    prev = s
    if (q % 30 === 29 && q < FRAMES - 1) console.log(`    ${ctx.id.replace(/^history /, '')} arm ${tag}${run > 1 ? ` run ${run}` : ''}: frame ${f} (${((Date.now() - t0) / 1000 / (q + 1)).toFixed(2)} s a frame)`)
  }
  const d1 = await page.evaluate(() => window.__fluidBench.diagnostics()), st1 = await status(page)
  const capHits = d1.viscousCapHits - d0.viscousCapHits, bad1 = armStatus(st1, form, ctx.count)
  if (capHits !== 0) bad1.push(`${capHits} new viscousCapHits over the window (must be 0)`)
  if (bad1.length) throw new StudyStop('assert', `${ctx.id} arm ${tag} (${form}, run ${run}) at F1: ${bad1.join('; ')}`)
  const ms = Date.now() - t0, multi = rec.multiFrames()
  plan.frameMs.push(ms / FRAMES)
  rec.meta = { ...rec.meta, ms, capHits, viscousSolves: d1.viscousSolves - d0.viscousSolves, drainsFoundBusy: entryBusy, multi: multi.map(q => F0 + 1 + q), restore: rs }
  log(`  arm ${tag} (${form}${restored ? ', restored' : ', the original run continued'}${run > 1 ? `, run ${run}` : ''}): ${FRAMES} frames in ${(ms / 1000).toFixed(0)} s, n = 1 on ${FRAMES - multi.length}${multi.length ? ` (not on ${multi.slice(0, 6).map(q => F0 + 1 + q).join(', ')}${multi.length > 6 ? ', …' : ''})` : ''}, new viscousCapHits ${capHits}, viscous solves ${rec.meta.viscousSolves}; ${plan.eta()}`)
  return rec
}

/** Replicate k of history H: a history to F0 and its snapshot (A1's identity check), the arms, the probe, the fidelity
 *  check, the common frames — until a valid snapshot (reduced: per-drop sums) or a stop. */
async function replicate(page, H, k, st, plan) {
  let j = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    checkPower(`history ${H} k=${k}`)
    const seed = seedFor(k, j), id = `history ${H} k=${k} attempt ${attempt} (seed ${seed})`, tH = Date.now()
    await page.evaluate(f => window.__fluidBench.configure({ immDriftForm: f }), H)
    const h = await b1cToF0(page, SCENE, seed)
    await page.evaluate(() => window.__fluidBench.drainReadbacks())
    const S0 = await status(page)
    const snap = await page.evaluate(() => window.__fluidBench.snapshotState())
    const host0 = await page.evaluate(() => window.__fluidBench.hostState())
    const w0 = await words(page, BUFFERS)
    // integrity: the F0 sample is the snapshot's state (t0 did not move over the drain and the snapshot)
    const bad = armStatus(S0, H, h.s.n), dPos = wordDiff(u32(h.s.posRaw), w0.pos), dSlip = wordDiff(u32(h.s.drift), w0.slipState)
    if (h.s.frame !== F0 || snap.clock.steppedFrames !== F0) bad.push(`the F0 sample at frame ${h.s.frame}, the snapshot at ${snap.clock.steppedFrames} (F0 ${F0})`)
    if (dPos.n || dSlip.n) bad.push(`the snapshot's words ≠ the F0 sample's (posRaw ${dPos.n}, drift ${dSlip.n} words differ)`)
    if (host0.vLag !== snap.host.vLag || host0.viscCap !== snap.host.viscCap) bad.push('hostState ≠ the snapshot\'s host values')
    if (snap.items.length !== ALL_ITEMS.length) bad.push(`the snapshot holds ${snap.items.map(i => i.name).join(', ')}`)
    if (bad.length) throw new StudyStop('assert', `${id}: ${bad.join('; ')}`)
    // A1: bitwise identity with an earlier F0 of this history
    const vs = st.earlier[H].map(e => ({ id: e.id, differ: Object.fromEntries(BUFFERS.map(b => [b, wordDiff(e.w[b], w0[b]).n])) }))
    const same = vs.find(e => BUFFERS.every(b => e.differ[b] === 0))
    st.earlier[H].push({ id, w: w0 })
    const fz = b1cFrozenSet(h.s), row0 = fz.row.filter(r => r === 0).length
    const att = { H, k, attempt, seed, F0words: { vsEarlier: vs }, set: fz.set.length, row0, row1: fz.set.length - row0, historyMs: Date.now() - tH }
    log(`${id}: F0 frame ${h.s.frame}, ${h.s.n} particles, v_lag ${f3(snap.host.vLag)} m/s, viscous cap ${snap.host.viscCap}; frozen set ${fz.set.length} (row 0 ${row0}, row 1 ${fz.set.length - row0}); F0 words vs earlier ${H} snapshots: ${vs.length ? vs.map(e => `${e.id.replace(/^history /, '')}: ${BUFFERS.map(b => `${b} ${e.differ[b]}`).join('/')} differ`).join('; ') : 'none earlier'} (${elapsed()})`)
    if (same) {
      att.outcome = `A1: bitwise identical to ${same.id} — re-drawn with seed ${seedFor(k, j + 1)}`
      log(`  ${att.outcome}`)
      st.attempts.push(att); await endSnapshot(page); j++; continue
    }
    const cov = t0Covariates(h.s, fz)
    const byRow = f => [0, 1].map(r => cov.drops.filter(d => d.row === r && f(d)).length)
    att.covariates = { footprint: cov.footprint, mercury: cov.mercury, clean27: byRow(d => d.clean27), gBins: Object.fromEntries(G_BINS.map(([n, f]) => [n, byRow(d => f(d.gDx))])) }
    log(`  t0 covariates (reported): the 27-cell rule's subset row 0 ${att.covariates.clean27[0]}, row 1 ${att.covariates.clean27[1]}; g bins ${G_BINS.map(([n]) => `${n} ${att.covariates.gBins[n].join('/')}`).join(', ')} (row 0/row 1); the film's floor footprint ${cov.footprint.cells} of ${cov.footprint.of} row-0 cells; mercury below 1e-3·dx ${cov.mercury.belowMilliDx} of ${cov.mercury.n}`)
    const mats = Object.fromEntries(h.s.materials.map(m => [m.name, m]))
    const ctx = { H, k, id, h, snap, set: fz.set, count: S0.count, comp: h.s.comp, rho: { RO: mats['Olive Oil'].rho, RW: mats.Water.rho, RH: mats.Mercury.rho } }
    const recs = []
    let voidAt = null, probe = null
    const tooMany = () => unionMulti(recs) > MAX_MULTI
    recs.push(await runArm(page, ctx, 'R', H, 1, false, plan))
    if (tooMany()) voidAt = 'R'
    const S = sameFormArm(H)
    for (let round = 1; !voidAt && round <= (st.branch === 'nonbitwise' ? 3 : 1); round++) {
      const withA = k === 1 || st.branch === 'nonbitwise'
      for (const [tag, form] of [['C', 'cell'], ['F', 'face'], ...(withA ? [['A', H]] : [])]) {
        recs.push(await runArm(page, ctx, tag, form, round, true, plan))
        if (tooMany()) { voidAt = `${tag} run ${round}`; break }
      }
      if (voidAt) break
      if (round === 1 && withA) {
        const pr = compareRuns(recs.find(r => r.meta.arm === 'A' && r.meta.run === 1), recs.find(r => r.meta.arm === S && r.meta.run === 1))
        if (k === 1) {
          probe = { identical: pr.identical, first: pr.first, frames: pr.frames }
          const was = st.branch
          if (!pr.identical && st.branch !== 'nonbitwise') { st.branch = 'nonbitwise'; st.switches.push({ H, k, attempt, first: pr.first }); plan.nonbitwise() }
          log(`  determinism probe (${H}): A vs ${S}, pos/vel/slipState words at every window frame — ${pr.identical ? 'IDENTICAL' : `DIFFER from frame ${pr.first.frame} (${pr.first.buffers.join(', ')}) on ${pr.frames} frames`} → ${was === 'nonbitwise' ? 'reported (the study is in the non-bitwise branch already)' : pr.identical ? 'the bitwise branch' : 'the NON-BITWISE branch from here on: each restored arm 3 times (this snapshot: rounds 2 and 3 now)'}`)
        } else log(`  A vs ${S} (non-bitwise branch, reported): ${pr.identical ? 'identical' : `differ from frame ${pr.first.frame} (${pr.first.buffer})`}`)
      }
    }
    // restore fidelity: R vs the same-form restored arm (run 1), bitwise — judged in the bitwise branch
    const sRec = recs.find(r => r.meta.arm === S && r.meta.run === 1)
    const fid = sRec ? compareRuns(recs[0], sRec) : null
    if (fid) log(`  restore fidelity: R vs ${S} — ${fid.identical ? 'identical at every window frame' : `DIFFER from frame ${fid.first.frame} (${fid.first.buffers.join(', ')}) on ${fid.frames} frames`}${st.branch === 'bitwise' ? '' : ' (non-bitwise branch: judged by Rg)'}`)
    const cf = commonFrames(recs)
    const snapRec = {
      type: 'snapshot', H, k, seed, attempt, label: `${H} k=${k}`, branch: st.branch, drops: fz.set.length, set: fz.set, row: Uint8Array.from(fz.row),
      cell: Int32Array.from(cov.drops.map(d => d.cell)), gDx: Float64Array.from(cov.drops.map(d => d.gDx)), clean27: Uint8Array.from(cov.drops.map(d => (d.clean27 ? 1 : 0))),
      common: cf.count, probe, fidelity: fid && { identical: fid.identical, first: fid.first, frames: fid.frames }, snapshot: { items: snap.items, host: snap.host, clock: snap.clock },
      covariates: att.covariates, runs: recs.map(r => reduceRun(r, cf.mask)),
    }
    if (fid && !fid.identical && st.branch === 'bitwise') {
      att.outcome = `RESTORE NOT FAITHFUL (bitwise branch): R ≠ ${S} from frame ${fid.first.frame}, ${fid.first.buffer}`
      st.attempts.push(att); await endSnapshot(page)
      throw Object.assign(new StudyStop('fidelity', `${id}: ${att.outcome}`), { snapRec })
    }
    if (voidAt || cf.count < MIN_COMMON) {
      att.outcome = `VOID: ${cf.count} common single-substep frames < ${MIN_COMMON}${voidAt ? ` (known after arm ${voidAt}; the rest not run)` : ''} — replaced by a new history`
      log(`  ${att.outcome}`)
      st.attempts.push(att); await endSnapshot(page); continue
    }
    att.outcome = 'valid'
    st.attempts.push(att)
    const sr = strataOf(snapRec)
    log(`  ${cf.count} common frames; strata: row 1 ${sr.row1.length}, all ${sr.all.length}, row 0 ${sr.row0.length}, joint never ${sr.jointNever.length} (row 1 ${sr.jointNever.filter(j2 => snapRec.row[j2] === 1).length}), with the J_y clause ${sr.jointNeverJy.length}; no kernel reading at common frames (drop-frames / drops) ${snapRec.runs.map(r => `${r.meta.arm}${r.meta.run > 1 ? r.meta.run : ''} ${r.noReading.reduce((a, b) => a + b, 0)}/${r.noReading.filter(x => x > 0).length}`).join(', ')}`)
    await endSnapshot(page)
    return snapRec
  }
  throw new StudyStop('attempts', `history ${H} k=${k}: no valid snapshot in ${MAX_ATTEMPTS} attempts`)
}
/** The held snapshot freed; b1cDense's end configuration (1/60 s frames, the density snapshot off). */
async function endSnapshot(page) {
  await page.evaluate(() => window.__fluidBench.disposeSnapshot())
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, snapshotDensity: false }))
}

// ── the analysis (live and --analyze) ────────────────────────────────────────────────────────────────────────────────
/** A snapshot record from its JSON line (typed arrays and non-finite numbers restored). */
function fromJson(o) {
  const F = a => Float64Array.from(a, num), U8 = a => Uint8Array.from(a, num)
  return { ...o, row: U8(o.row), cell: Int32Array.from(o.cell, num), gDx: F(o.gDx), clean27: U8(o.clean27),
    runs: o.runs.map(r => ({ ...r, sums: F(r.sums), sub: F(r.sub), hgCommon: U8(r.hgCommon), jyCommon: U8(r.jyCommon), noReading: Uint16Array.from(r.noReading, num), any0230: U8(r.any0230) })) }
}
/** §4 over every stratum, §5's readings, §6's consequences — from the valid snapshots (and a fidelity stop, if any). */
function analyze(snaps, stop) {
  const byH = { cell: snaps.filter(s => s.H === 'cell'), face: snaps.filter(s => s.H === 'face') }
  const fidelity = Object.fromEntries(HISTORIES.map(H => {
    const list = [...byH[H], ...(stop?.snapRec?.H === H ? [stop.snapRec] : [])]
    const mm = list.find(s => s.branch === 'bitwise' && s.fidelity && !s.fidelity.identical)
    return [H, { branch: list.some(s => s.branch === 'nonbitwise') ? 'nonbitwise' : 'bitwise', checked: list.filter(s => s.fidelity).length, mismatch: mm ? { k: mm.k, ...mm.fidelity.first } : null, Rg: { row1: NaN, all: NaN }, A: { row1: NaN, all: NaN } }]
  }))
  if (stop?.kind === 'fidelity') {
    const nanIn = { name: 'primary', stratum: 'row1', fidelity, delta: NaN, s: {}, ci: {}, E: {}, floors: {}, repro: { value: NaN, band: RULES.HIST_ROW1, what: '' } }
    const primary = evaluateReading(nanIn), secondary = evaluateReading({ ...nanIn, name: 'secondary', stratum: 'jointNever' })
    return { complete: false, fidelity, primary, secondary, consequences: consequences(primary, secondary) }
  }
  if (byH.cell.length < K || byH.face.length < K) return { complete: false, fidelity, primary: null, secondary: null, consequences: consequences(null, null) }
  const stats = {}
  for (const st of STRATA) stats[st] = stratumStudy(byH, sn => strataOf(sn)[st])
  for (const H of HISTORIES) {
    fidelity[H].Rg = { row1: stats.row1.per[H].Rg, all: stats.all.per[H].Rg }
    fidelity[H].A = { row1: stats.row1.per[H].A, all: stats.all.per[H].A }
  }
  // the secondary's reproduction: the 02:30-definition never stratum, each R arm on its own trajectory
  const n0230 = Object.fromEntries(HISTORIES.map(H => [H, byH[H].map(sn => { const R = armRuns(sn, 'R')[0], m = never0230(sn, R); return { k: sn.k, drops: m.length, Ddp: runBudget(R, m).Ddp } })]))
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length
  const never0230Delta = mean(n0230.cell.map(x => x.Ddp)) - mean(n0230.face.map(x => x.Ddp))
  const inputs = (name, st, repro) => ({
    name, stratum: st, fidelity, delta: stats[st].delta, s: stats[st].s, ci: { cell: stats[st].ci['4^3'].s.cell, face: stats[st].ci['4^3'].s.face },
    E: { cell: stats[st].per.cell.E, face: stats[st].per.face.E }, floors: Object.fromEntries(HISTORIES.map(H => [H, { A: stats[st].per[H].A, Rg: stats[st].per[H].Rg }])),
    repro, allS: stats.all.s, allCi: { cell: stats.all.ci['4^3'].s.cell, face: stats.all.ci['4^3'].s.face },
  })
  const primary = evaluateReading(inputs('primary', 'row1', { value: stats.row1.delta, band: RULES.HIST_ROW1, what: 'Δ_own(row 1)' }))
  const secondary = evaluateReading(inputs('secondary', 'jointNever', { value: never0230Delta, band: RULES.HIST_NEVER, what: 'Δ_own(the 02:30-definition never stratum, R arms)' }))
  return { complete: true, stats, fidelity, never0230: { perSnapshot: n0230, delta: never0230Delta }, primary, secondary, consequences: consequences(primary, secondary) }
}
/** The readable report of the analysis (appended to the console text). */
function report(a) {
  log('\n== statistics (spec §4) ==')
  if (a.stats) {
    for (const st of STRATA) {
      const S = a.stats[st]
      log(`${LABEL[st]}:`)
      for (const H of HISTORIES) {
        const P = S.per[H]
        for (const x of P.snapshots) {
          const arms = x.runs.map(r => `${r.arm}${r.run > 1 ? r.run : ''} D_dp ${f4(r.Ddp)} (Σδ_dp ${r.sumDp.toExponential(3)} m / ΣΔt·u_V,y ${r.sumDen.toExponential(3)} m) D_a ${f3(r.Da)} Λ ${f3(r.lambdaNative)} U ${f3(r.U)}`).join('; ')
          log(`  ${x.label}: ${x.drops} drops; E ${f4(x.E)} CI ${x.Eci ? Object.entries(x.Eci).map(([z, c]) => `${z} ${ci(c)}`).join(', ') : '—'}; sub-windows ${x.Ew.map(f4).join(' / ')}; A ${x.Aran ? f4(x.A) : '0 (not run: bitwise branch)'} Rg ${f4(x.Rg)}; ${arms}`)
        }
        const sTxt = Math.abs(S.delta) >= RULES.NOTHING ? `s_H ${f3(S.s[H])} CI ${Object.entries(S.ci).map(([z, c]) => `${z} ${ci(c.s[H])}`).join(', ')}; per-k s_H,k ${P.sk.map(f3).join(' / ')}` : `s_H undefined (|Δ_own| ${f4(Math.abs(S.delta))} < ${RULES.NOTHING}, §5)`
        log(`  ${H}: E_H ${f4(P.E)} (per k ${P.snapshots.map(x => f4(x.E)).join(' / ')}; SD ${f4(P.Esd)}, range ${P.Erange.map(f4).join('…')}); E_H per sub-window ${P.Ew.map(f4).join(' / ')}; own-form D_dp ${f4(P.own)}; A_H ${f4(P.A)}, Rg_H ${f4(P.Rg)}; ${sTxt}`)
      }
      log(`  Δ_own ${f4(S.delta)} (CI ${ci(S.ci['4^3'].delta)})`)
    }
    log(`the 02:30-definition never stratum (R arms, J_y clause included): ${HISTORIES.map(H => `${H} ${a.never0230.perSnapshot[H].map(x => `k=${x.k} ${x.drops} drops D_dp ${f4(x.Ddp)}`).join(', ')}`).join('; ')}; Δ_own ${f4(a.never0230.delta)}`)
  } else log(a.primary ? '(a fidelity stop: no statistics)' : '(incomplete: no statistics)')
  log('\n== readings (spec §5, fixed order: the first that holds) ==')
  for (const r of [a.primary, a.secondary]) {
    if (!r) { log('no reading: the study did not complete'); break }
    log(`${r.name === 'primary' ? 'PRIMARY (row 1; guard all)' : 'SECONDARY — the never question (joint never stratum; a principal stratum: post-treatment, the E contrast paired within it)'}:`)
    for (const s of r.steps) log(`  ${s.holds ? '✓' : '✗'} ${s.name}: ${s.text}`)
    log(`  → READING: ${r.reading}`)
    if (r.guard) log(`  guard (§5 MIXED's all-drop clause; implemented literally — the fixed order decides): ${r.guard.text}; fires ${r.guard.fires ? 'YES' : 'no'}${r.guard.wouldVeto ? ' — it WOULD veto this reading if read as a veto (flagged: the lead decides)' : ''}`)
  }
  log('\n== consequences (spec §6, decided before any run) ==')
  for (const c of a.consequences) log(`- ${c}`)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const outDir = path.join(repoRoot, 'bench-results', 'studies')
const tag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const analyzeArg = argv.find(a => a.startsWith('--analyze='))
if (analyzeArg) {
  const file = analyzeArg.slice('--analyze='.length)
  const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const snaps = recs.filter(r => r.type === 'snapshot').map(fromJson), stopRec = recs.find(r => r.type === 'stop')
  const stop = stopRec?.kind === 'fidelity' ? { kind: 'fidelity', snapRec: fromJson(stopRec.snapRec) } : null
  log(`${SPEC} — offline analysis of ${file}: ${snaps.length} snapshots${stopRec ? `; the run stopped: ${stopRec.kind}` : ''}`)
  const a = analyze(snaps, stop)
  report(a)
  mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `b1c-fork-analysis-${tag}.json`)
  writeFileSync(out, jsonText({ spec: SPEC, amendments: AMENDMENTS, source: file, analysis: a }, 1))
  log(`→ ${path.relative(repoRoot, out)}`)
  exitGate(a.complete ? 0 : 1)
} else {
  const p0 = powerState()
  log(`power: ${describePower(p0)}`)
  if (p0.ac !== true) { console.error('refusing: a GPU study runs on AC only (the owner\'s power rule)'); process.exit(3) }
  const prov = await provenance()
  log(`${SPEC}; amendments: A1; provenance ${prov.sha?.slice(0, 10)} ${prov.state}${prov.attributable ? '' : ' — NON-ATTRIBUTABLE (not the clean gate tree)'}`)
  mkdirSync(outDir, { recursive: true })
  const partial = path.join(outDir, `b1c-fork-partial-${tag}.jsonl`)
  const out = { study: 'b1c-fork', spec: SPEC, amendments: AMENDMENTS, prov, power: p0, started: new Date().toISOString(), partialFile: path.relative(repoRoot, partial), constants: { RULES, BOOT, K, MAX_ATTEMPTS, MIN_COMMON, FRAMES, NSUB } }
  const st = { earlier: { cell: [], face: [] }, branch: 'bitwise', attempts: [], switches: [] }
  const snaps = []
  let stop = null
  // the plan's frame count for the ETA (bitwise: 4 arms at k = 1, 3 at k = 2, 3; non-bitwise: 10 a snapshot)
  const plan = {
    frameMs: [], nb: false,
    left() { let n = 0; for (const H of HISTORIES) for (let k = 1; k <= K; k++) { if (snaps.some(s => s.H === H && s.k === k)) continue; n += this.nb ? 10 : k === 1 ? 4 : 3 } return n * FRAMES },
    nonbitwise() { this.nb = true },
    eta() { const ms = this.frameMs.reduce((a, b) => a + b, 0) / Math.max(1, this.frameMs.length); return `elapsed ${elapsed()}, ≈ ${(ms / 1000).toFixed(2)} s a frame` },
  }
  const { browser, page, errors, adapter } = await openFluidPage()
  out.adapter = adapter
  try {
    const s0 = await status(page)
    if (s0.solver !== 'flip') throw new StudyStop('assert', `the page runs solver ${s0.solver}, not the incompressible solver`)
    await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    for (const H of HISTORIES) {
      for (let k = 1; k <= K; k++) {
        const sn = await replicate(page, H, k, st, plan)
        snaps.push(sn)
        appendFileSync(partial, jsonText(sn) + '\n')
        log(`  → ${H} k=${k} recorded (${elapsed()}; about ${Math.round(plan.left() * (plan.frameMs.reduce((a, b) => a + b, 0) / Math.max(1, plan.frameMs.length)) / 60000)} min of window frames left, plus the histories)`)
      }
      st.earlier[H] = []   // A1 compares within one history
    }
  } catch (e) {
    // a stop (fidelity, assert, attempts, power) or any other error: recorded, the output still written
    stop = e instanceof StudyStop ? e : new StudyStop('error', e?.stack ?? String(e))
    log(`\nSTOPPED (${stop.kind}): ${stop.detail}`)
    appendFileSync(partial, jsonText({ type: 'stop', kind: stop.kind, detail: stop.detail, ...(stop.snapRec ? { snapRec: stop.snapRec } : {}) }) + '\n')
  } finally {
    const stEnd = await status(page).catch(() => null)
    out.gpuErrors = stEnd?.gpuErrors ?? null
    await browser.close()
  }
  out.errors = errors
  out.attempts = st.attempts
  out.branchSwitches = st.switches
  out.stopped = stop ? { kind: stop.kind, detail: stop.detail } : null
  const a = analyze(snaps, stop && stop.kind === 'fidelity' ? { kind: 'fidelity', snapRec: stop.snapRec } : null)
  report(a)
  log(`\nhygiene: ${out.gpuErrors} uncaptured WebGPU errors, ${errors.length} console errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}; ${elapsed()} in all`)
  out.finished = new Date().toISOString()
  out.snapshots = snaps.map(s => ({ H: s.H, k: s.k, seed: s.seed, attempt: s.attempt, branch: s.branch, drops: s.drops, common: s.common, probe: s.probe, fidelity: s.fidelity, snapshot: s.snapshot, covariates: s.covariates,
    strata: Object.fromEntries(Object.entries(strataOf(s)).map(([n, m]) => [n, { drops: m.length, row1: m.filter(j => s.row[j] === 1).length }])),
    runs: s.runs.map(r => ({ ...r.meta, frames: r.frames, noReading: { dropFrames: r.noReading.reduce((x, y) => x + y, 0), drops: r.noReading.filter(x => x > 0).length } })) }))
  out.analysis = a
  const file = path.join(outDir, `b1c-fork-${tag}.json`)
  writeFileSync(file, jsonText(out, 1))
  log(`→ ${path.relative(repoRoot, file)} (+ .report.txt; per-snapshot records ${path.relative(repoRoot, partial)}); provenance ${prov.sha?.slice(0, 8)} ${prov.state}`)
  writeFileSync(path.join(outDir, `b1c-fork-${tag}.report.txt`), lines.join('\n') + '\n')
  exitGate(a.complete && errors.length === 0 && out.gpuErrors === 0 ? 0 : 1)
}
