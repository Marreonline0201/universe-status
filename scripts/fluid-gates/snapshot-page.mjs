#!/usr/bin/env node
// Gate SNAPSHOT — the bench-only GPU state snapshot / restore on the FLUID TEST page: §9 of the B1c forked drift-form study
// spec, rev 3 (FROZEN, sha256 a3290c5464eb3cc57f17f34ddd83151f2d1e1b6b5d49ec7007ec1444ef6189c6) — "the restore hook's own
// gate", G-R1 … G-R4, run BEFORE any study run, on B1 at the study's commit, in a page session of its own.
//
//   node scripts/fluid-gates/snapshot-page.mjs     (default server: the clean gate tree; FLUID_BASE to override)
//
// PRE-REGISTERED 2026-09-30 16:49 EDT (local time), before its first run, written with the facility on top of 65aa9057. The
// criteria below are fixed; any change is a dated revision appended below this header, never an edit of this text.
// (Before the stamp, this text ran only on CPU — against a mock page and a fake engine, to test its own logic and that
// each must-fail mutant's simulated effect fails exactly the catchers named below; never on a page, never on the GPU.)
//
// Under test: FlipGpuSimulator.namedBuffers; gpu-sim/flip/stateSnapshot.ts (take / restore in place by
// copyBufferToBuffer, one submit each; `omit`); FlipBackend.benchDrain / benchSnapshotState / benchRestoreState (the host
// values v_lag and the viscous PCG cap) / benchHostState / benchReadState; FluidEngine's frozen-only bench operations and
// its clock setter; the hook's drainReadbacks / snapshotState / restoreState / setClock / hostState / stateWords /
// disposeSnapshot.
// The history: the B1 scene of scripts/studies/b1c-driftform.mjs (water pool, olive-oil block, mercury block; seed 2),
// lockstep, in the FACE form (the page default), driven to F0 = frame 267 (4.0 s) on b1cDense's schedule and its F0
// sample (lib/b1cSuccessors.mjs b1cToF0: 1/60 s frames to 3.85 s, then 1/240 s); the page is then frozen at F0. There:
// drainReadbacks() (the device queue idle, then every FlipBackend readback slot idle — no frame stepped), status(),
// snapshotState() (pos, vel, aff, aux, slipState, the pressure x; v_lag and the viscous cap), hostState(), and R0 = the
// words of all six carried states (stateWords).
// A window frame is stepped by ONE page call (stepFrame): the step limit set to it; the frame awaited in an
// animation-frame callback, which runs right after the engine's own in the frame that steps it (the engine re-registers
// first thing in its callback), so drainReadbacks() is entered with that frame's readback slots still in flight — no task
// can deliver their map callbacks in between; then status() (n = the substepsTotal delta) and hostState(). Then the pos,
// vel and slipState words (stateWords). A pass = frames F0+1 … F0+12 so. A restore = restoreState({ omit }), the step
// limit back to F0, setClock(the snapshot's clock), drainReadbacks(), status(), hostState() and the six states' words.
// Pass R (the original run continued, FACE form) → restore → pass A → for each control: restore with one item omitted →
// its pass. Word comparisons are of the u32 words, bitwise.
// G-R1 round trip.
//   (snapshot) 6 items, every byte size > 0 and = 16/16/48/16/16 B × count and 4·66³ B (the pressure x).
//   (t0) after the restore, all six states' words at F0 equal R0 (the restore wrote back exactly what was saved).
//   (frames) 12/12 frames stepped in pass R and in pass A (each at its own frame), every frame's words 3 × 4·count; pass
//   A's pos, vel and slipState words equal pass R's at every frame; non-vacuity: pass R's pos words at F0+12 differ
//   from R0's. A failure reports the first differing frame, buffer and word (spec §3: the non-bitwise branch applies).
// G-R2 must-fail controls — restoreState({ omit: [item] }), the item keeping its live value (the end of the pass
//   before), then the 12 frames: (a) pressureX, (b) slipState, (c) vel. Each must (i) at t0 differ from R0 in the
//   omitted item and in no other (exactly one item omitted) and (ii) DIFFER from pass R in at least one pos / vel /
//   slipState word within the 12 frames. The host values have no must-fail control (spec §9) — asserted instead, and
//   reported "not sensitivity-tested": n = 1 on every frame of all five passes, and 0 new viscousCapHits in each pass.
// G-R3 isolation. After each of the 4 restores and its drain, status() equals the snapshot's — count, immiscible form
//   (face), the drift active, wallShear ∈ {off, guarded}, ball null, the Stokes path inactive, the clock back at F0 (frame,
//   sim time, substeps) — and hostState() gives the snapshotted v_lag and viscous cap with no slot in flight; the snapshot's
//   own status is B1's (the same list); t0 did not move over the drain and the snapshot (R0's pos and slipState words =
//   the F0 sample's posRaw and drift words, bitwise); every drain of the gate exited with no readback slot in flight, and
//   at least one drain found a slot in flight at its entry (the drain was exercised; the count is reported).
// G-R4 (after G-R1–G-R3; REPORTED — it changes no pre-registered reading): ONE more face history to F0 on b1cDense's
//   schedule (seed 2), the F0 sample only — no window frame stepped, no budget read. Counted: the frozen set (b1cDense's
//   rule, b1cFrozenSet) by row; its subset with no mercury particle in the drop's t0 cell or the 26 around it (the draft's
//   27-cell rule) by row; the film's floor footprint (row-0 cells holding ≥ 1 mercury particle, of 64²); the fraction of
//   mercury below 1e-3·dx (review_2 §1.7); each drop's gap g_i = the L∞ gap at t0 between its own kernel support S(c_i)
//   (the open box of half-width dx about its cell centre: immiscible.wgsl alphaScatter's trilinear reach + slipParticles'
//   own-cell lookup) and the nearest mercury particle, counted by row in the bins g < ¼dx, ¼–½dx, ≥ ½dx. Checked only that
//   it is the F0 sample (frame 267, the drift state, the face form active, mercury present) and the set is non-empty —
//   else the counts would describe nothing.
// Must-fail mutants: gpu-mutations --gate=snapshot — 'restore skips pressure x' (G-R1; G-R2 (b), (c)), 'restore skips
// slipState' (G-R1; G-R2 (a), (c)), 'snapshot copies vel from pos' (G-R1; G-R2 (a), (b)), 'the drain returns before the
// slots are idle' (G-R3); the catchers' derivation is in gpu-mutations.mjs beside the set.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, status, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { b1cToF0, b1cFrozenSet, b1cCellOf, B1C } from './lib/b1cSuccessors.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE SNAPSHOT (the bench state snapshot / restore on the FLUID TEST page)')
const report = { prov: await provenance(), spec: 'B1c fork spec rev 3 §9 (sha256 a3290c5464eb3cc57f17f34ddd83151f2d1e1b6b5d49ec7007ec1444ef6189c6)' }
const { F0, DX, L } = B1C
const FORM = 'face', SEED = 2, FRAMES = 12, GRID = 64, P0 = 66 ** 3
const WORDS = ['pos', 'vel', 'slipState']                            // G-R1 / G-R2: the words read at every window frame
const ALL = ['pos', 'vel', 'aff', 'aux', 'slipState', 'pressureX']   // every carried state (FlipGpuSimulator.namedBuffers)
const CONTROLS = [['a', 'pressureX'], ['b', 'slipState'], ['c', 'vel']]
// the B1 scene of scripts/studies/b1c-driftform.mjs:33-36 (s31c-page's B1), verbatim
const scene = { name: 's31c-buoyancy', materials: [], gravity_mps2: G_STANDARD, spawns: [
  { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } },
  { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } },
  { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] }

/** The live words of carried states, as u32 arrays over fresh copies of the bytes. */
async function words(page, names) {
  const r = await page.evaluate(n => window.__fluidBench.stateWords(n), names)
  const out = {}
  for (const [k, b64] of Object.entries(r)) { const b = Buffer.from(b64, 'base64'); out[k] = new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  return out
}
/** The u32 words of b that differ from a (another length: every word), the first index and its two values. */
function diffWords(a, b) {
  if (!a || !b || a.length !== b.length) return { n: Math.max(a?.length ?? 0, b?.length ?? 0) || 1, first: 0, lengths: [a?.length, b?.length] }
  let n = 0, first = -1
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (first < 0) first = i; n++ }
  return n ? { n, first, particle: first >> 2, component: first & 3, ref: a[first], got: b[first] } : { n: 0, first: -1 }
}
const busyN = s => s.speed + s.visc + s.ball + s.stokes
const drains = []   // every drain of the gate
const noteDrain = (where, d) => { drains.push({ where, entry: d.busyAtEntry, exit: d.busyAtExit, rounds: d.rounds, ms: d.ms }); return d }

/** One window frame in one page call (header: stepFrame). */
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

/** A pass: frames F0+1 … F0+12 (stepFrame, then the words); against `ref`'s words frame by frame (its own not kept). */
async function runPass(page, tag, ref) {
  const d0 = await page.evaluate(() => window.__fluidBench.diagnostics())
  let subPrev = (await status(page)).substepsTotal
  const frames = []
  for (let k = 1; k <= FRAMES; k++) {
    const f = F0 + k, r = await stepFrame(page, f)
    noteDrain(`${tag} frame ${f}`, r.drain)
    const n = r.substepsTotal - subPrev
    subPrev = r.substepsTotal
    const w = await words(page, WORDS)
    const fr = { f, stepped: r.framesStepped, n, vLag: r.host.vLag, viscCap: r.host.viscCap, lengths: WORDS.map(nm => w[nm].length) }
    if (ref) fr.diff = Object.fromEntries(WORDS.map(nm => [nm, diffWords(ref.frames[k - 1].w[nm], w[nm])]))
    else fr.w = w
    frames.push(fr)
  }
  const d1 = await page.evaluate(() => window.__fluidBench.diagnostics())
  return { tag, frames, capHits: d1.viscousCapHits - d0.viscousCapHits, pressureCapHits: d1.pressureCapHits - d0.pressureCapHits, psiCapHits: d1.psiCapHits - d0.psiCapHits, viscousSolves: d1.viscousSolves - d0.viscousSolves }
}
const stepped = p => p.frames.length === FRAMES && p.frames.every(fr => fr.stepped === fr.f)
const firstDiff = p => { for (const fr of p.frames) for (const nm of WORDS) if (fr.diff[nm].n) return { frame: fr.f, buffer: nm, ...fr.diff[nm] }; return null }
const totalDiff = p => p.frames.reduce((q, fr) => q + WORDS.reduce((s, nm) => s + fr.diff[nm].n, 0), 0)
const fmtDiff = d => d ? `frame ${d.frame} ${d.buffer} word ${d.first} (particle ${d.particle}, component ${d.component}: 0x${d.ref?.toString(16)} → 0x${d.got?.toString(16)}), ${d.n} words that frame` : 'none'

/** restoreState({ omit }), the step limit and the clock back to F0, a drain; status, host values, the six states' words. */
async function restoreTo(page, omit, clock) {
  const r = await page.evaluate(o => window.__fluidBench.restoreState({ omit: o }), omit)
  noteDrain(`restore [${omit}] (its drain before)`, r.drain.before)
  noteDrain(`restore [${omit}] (its drain after)`, r.drain.after)
  await page.evaluate(f => window.__fluidBench.setStepLimit(f), F0)
  const c = await page.evaluate(c => window.__fluidBench.setClock(c), clock)
  noteDrain(`after restore [${omit}]`, await page.evaluate(() => window.__fluidBench.drainReadbacks()))
  const st = await status(page), host = await page.evaluate(() => window.__fluidBench.hostState())
  return { restore: { restored: r.restored, kept: r.kept, host: r.host }, clock: c, st, host, w0: await words(page, ALL) }
}
/** B1's status at the snapshot and after every restore (G-R3): what differs, if anything. */
function b1Status(st, S0, clock) {
  const bad = []
  if (st.count !== S0.count) bad.push(`count ${st.count} ≠ ${S0.count}`)
  if (st.immiscible?.form !== FORM || st.immiscible?.form !== S0.immiscible?.form) bad.push(`form ${st.immiscible?.form}`)
  if (st.immiscible?.active !== true) bad.push(`drift active ${st.immiscible?.active}`)
  if (!['off', 'guarded'].includes(st.wallShear)) bad.push(`wallShear ${st.wallShear}`)
  if (st.ball !== null) bad.push('a ball')
  if (st.stokes?.active !== false) bad.push(`Stokes ${JSON.stringify(st.stokes)}`)
  if (clock && (st.framesStepped !== clock.steppedFrames || st.simTime !== clock.simTime || st.substepsTotal !== clock.substepsTotal)) bad.push(`clock ${st.framesStepped}/${st.simTime}/${st.substepsTotal} ≠ ${clock.steppedFrames}/${clock.simTime}/${clock.substepsTotal}`)
  return bad
}

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  const st0 = await status(page)
  gate.check(st0.solver === 'flip', `R the FLUID TEST page runs the incompressible solver (solver ${st0.solver})`)
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  await page.evaluate(f => window.__fluidBench.configure({ immDriftForm: f }), FORM)

  // ── the history to F0 and the snapshot ──
  const h = await b1cToF0(page, scene, SEED)
  noteDrain('F0: drainReadbacks', await page.evaluate(() => window.__fluidBench.drainReadbacks()))
  const S0 = await status(page)
  const snap = await page.evaluate(() => window.__fluidBench.snapshotState())
  noteDrain('F0: snapshotState (its drain)', snap.drain)
  const H0 = await page.evaluate(() => window.__fluidBench.hostState())
  const R0 = await words(page, ALL)
  const n = S0.count
  const u32 = a => new Uint32Array(a.buffer, a.byteOffset, a.length)
  const t0Pos = diffWords(u32(h.s.posRaw), R0.pos), t0Slip = diffWords(u32(h.s.drift), R0.slipState)
  report.history = { sampleFrame: h.s.frame, n: h.s.n, clockStepS: h.clockStepS, substepsAtF0: h.sub, nF0: h.nSub, status: S0 }
  report.snapshot = { items: snap.items, host: snap.host, clock: snap.clock, hostState: H0, t0Pos, t0Slip }

  // ── pass R, the G-R1 restore, pass A, the three controls ──
  const passR = await runPass(page, 'R', null)
  const moved = diffWords(R0.pos, passR.frames[FRAMES - 1].w.pos)
  const rA = await restoreTo(page, [], snap.clock)
  const passA = await runPass(page, 'A', passR)
  const ctl = []
  for (const [letter, item] of CONTROLS) {
    const rc = await restoreTo(page, [item], snap.clock)
    ctl.push({ letter, item, rc, pass: await runPass(page, `omit ${item}`, passR) })
  }

  // G-R1
  const want = { pos: 16 * n, vel: 16 * n, aff: 48 * n, aux: 16 * n, slipState: 16 * n, pressureX: 4 * P0 }
  const got = Object.fromEntries(snap.items.map(i => [i.name, i.bytes]))
  const sizesOk = n > 0 && snap.items.length === 6 && ALL.every(nm => got[nm] > 0 && got[nm] === want[nm]) && ALL.every(nm => R0[nm].length * 4 === want[nm])
  gate.check(sizesOk && snap.clock.steppedFrames === F0 && h.s.frame === F0,
    `G-R1 snapshot at F0 = frame ${snap.clock.steppedFrames} (the F0 sample's frame ${h.s.frame}; ${n} particles): ${snap.items.map(i => `${i.name} ${i.bytes} B`).join(', ')} (all > 0; expected 16/16/48/16/16 B × count and 4·66³ = ${4 * P0} B); host v_lag ${snap.host.vLag} m/s, viscous cap ${snap.host.viscCap}`)
  const t0A = Object.fromEntries(ALL.map(nm => [nm, diffWords(R0[nm], rA.w0[nm])]))
  gate.check(ALL.every(nm => t0A[nm].n === 0),
    `G-R1 t0: after restoreState() every carried state's words at F0 equal the snapshot's (R0) — ${ALL.map(nm => `${nm} ${t0A[nm].n} of ${R0[nm].length} differ`).join(', ')}`)
  const fdA = firstDiff(passA), lenOk = [passR, passA].every(p => p.frames.every(fr => fr.lengths.every(x => x === 4 * n)))
  gate.check(stepped(passR) && stepped(passA) && lenOk && moved.n > 0 && fdA === null && totalDiff(passA) === 0,
    `G-R1 round trip: ${passR.frames.length}/${FRAMES} frames stepped in pass R and ${passA.frames.length}/${FRAMES} in pass A (each at its frame: ${stepped(passR) && stepped(passA)}), ${3 * 4 * n} pos/vel/slipState words a frame (${lenOk ? 'all present' : 'MISSING WORDS'}); pass A vs pass R: ${totalDiff(passA)} differing words over ${FRAMES} frames — first difference ${fmtDiff(fdA)}; the state moved: ${moved.n} of ${R0.pos.length} pos words at F0+${FRAMES} differ from F0's`)

  // G-R2
  for (const c of ctl) {
    const t0 = Object.fromEntries(ALL.map(nm => [nm, diffWords(R0[nm], c.rc.w0[nm])]))
    const exactlyOne = ALL.every(nm => (nm === c.item) === (t0[nm].n > 0))
    const fd = firstDiff(c.pass), tot = totalDiff(c.pass)
    c.t0 = t0
    gate.check(stepped(c.pass) && exactlyOne && tot > 0,
      `G-R2 (${c.letter}) ${c.item} omitted: at t0 ${ALL.map(nm => `${nm} ${t0[nm].n}`).join(', ')} words differ from R0 (exactly the omitted item: ${exactlyOne}); over ${c.pass.frames.length}/${FRAMES} frames ${tot} pos/vel/slipState words differ from pass R (must be > 0) — first ${fmtDiff(fd)}`)
  }
  const passes = [passR, passA, ...ctl.map(c => c.pass)]
  const notOne = passes.flatMap(p => p.frames.filter(fr => fr.n !== 1).map(fr => `${p.tag} frame ${fr.f}: n ${fr.n}`))
  const vMax = Math.max(...passes.flatMap(p => p.frames.map(fr => fr.vLag))), caps = [...new Set(passes.flatMap(p => p.frames.map(fr => fr.viscCap)))]
  gate.check(notOne.length === 0 && passes.every(p => p.capHits === 0),
    `G-R2 host values inert (not sensitivity-tested, spec §9): n = 1 on ${passes.reduce((q, p) => q + p.frames.filter(fr => fr.n === 1).length, 0)} of ${passes.length * FRAMES} frames${notOne.length ? ` — NOT on ${notOne.slice(0, 4).join('; ')}` : ''}; new viscousCapHits per pass ${passes.map(p => p.capHits).join('/')} (0 each; viscous solves ${passes.map(p => p.viscousSolves).join('/')}); v_lag ≤ ${vMax.toFixed(3)} m/s (single substep while ≤ 10.86 m/s), viscous cap ${caps.join('/')}`)

  // G-R3
  const restores = [['G-R1', rA], ...ctl.map(c => [`(${c.letter}) omit ${c.item}`, c.rc])]
  const iso = restores.map(([tag, r]) => {
    const bad = b1Status(r.st, S0, snap.clock)
    if (r.host.vLag !== snap.host.vLag || r.host.viscCap !== snap.host.viscCap) bad.push(`host v_lag ${r.host.vLag} / cap ${r.host.viscCap} ≠ ${snap.host.vLag} / ${snap.host.viscCap}`)
    if (busyN(r.host.slotsBusy) !== 0) bad.push(`slots in flight ${JSON.stringify(r.host.slotsBusy)}`)
    return bad.length ? `${tag}: ${bad.join(', ')}` : null
  }).filter(Boolean)
  const s0bad = b1Status(S0, S0, null)
  if (H0.vLag !== snap.host.vLag || H0.viscCap !== snap.host.viscCap) s0bad.push('hostState ≠ the snapshot\'s host values')
  const exitBusy = drains.filter(d => busyN(d.exit) > 0), entryBusy = drains.filter(d => busyN(d.entry) > 0)
  const frameDrains = drains.filter(d => / frame \d+$/.test(d.where)), frameEntryBusy = frameDrains.filter(d => busyN(d.entry) > 0)
  gate.check(iso.length === 0 && s0bad.length === 0 && t0Pos.n === 0 && t0Slip.n === 0 && exitBusy.length === 0 && entryBusy.length >= 1,
    `G-R3 isolation: after each of the ${restores.length} restores status() = the snapshot's (count ${S0.count}, form ${S0.immiscible?.form}, drift active ${S0.immiscible?.active}, wallShear ${S0.wallShear}, ball ${S0.ball}, Stokes active ${S0.stokes?.active}, clock back at frame ${F0}) and v_lag / cap = ${snap.host.vLag} / ${snap.host.viscCap}${iso.length ? ` — ${iso.join('; ')}` : ': yes'}; the snapshot's own status B1's: ${s0bad.length ? s0bad.join(', ') : 'yes'}; t0 did not move (R0 vs the F0 sample: posRaw ${t0Pos.n}, slipState ${t0Slip.n} words differ); drains ${drains.length}: ${exitBusy.length} left a slot in flight${exitBusy.length ? ` (first: ${exitBusy[0].where} ${JSON.stringify(exitBusy[0].exit)})` : ''}, ${entryBusy.length} found one at entry (window frames: ${frameEntryBusy.length} of ${frameDrains.length})`)
  report.passes = passes.map(p => ({ tag: p.tag, capHits: p.capHits, pressureCapHits: p.pressureCapHits, psiCapHits: p.psiCapHits, viscousSolves: p.viscousSolves, frames: p.frames.map(({ w, ...fr }) => fr) }))
  report.restores = restores.map(([tag, r]) => ({ tag, restore: r.restore, clock: r.clock, status: r.st, host: r.host, t0: Object.fromEntries(ALL.map(nm => [nm, diffWords(R0[nm], r.w0[nm])])) }))
  report.drains = drains
  report.movedAtF0p12 = moved

  // back to b1cDense's end state, the snapshot freed
  await page.evaluate(() => window.__fluidBench.disposeSnapshot())
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, snapshotDensity: false }))

  // ── G-R4: one more face history to F0, the F0 sample only ──
  await page.evaluate(f => window.__fluidBench.configure({ immDriftForm: f }), FORM)
  const g4 = await b1cToF0(page, scene, SEED), s = g4.s, st4 = await status(page)
  const fz = b1cFrozenSet(s), mats = Object.fromEntries(s.materials.map(m => [m.name, m])), hgId = mats.Mercury?.id
  const nHg = new Uint16Array(GRID ** 3), hg = []
  let hgLow = 0
  for (let i = 0; i < s.n; i++) {
    if (s.comp[i] !== hgId) continue
    nHg[b1cCellOf(s.pos, i)]++
    const p = [s.pos[3 * i] * L, s.pos[3 * i + 1] * L, s.pos[3 * i + 2] * L]
    hg.push(p)
    if (p[1] < 1e-3 * DX) hgLow++
  }
  let footprint = 0
  for (let k = 0; k < GRID; k++) for (let i = 0; i < GRID; i++) if (nHg[i + GRID * GRID * k] > 0) footprint++   // row 0: y = 0
  const drops = fz.set.map((i, j) => {
    const c = b1cCellOf(s.pos, i), ci = [c % GRID, Math.floor(c / GRID) % GRID, Math.floor(c / GRID ** 2)]
    let clean27 = true
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = ci[0] + dx, y = ci[1] + dy, z = ci[2] + dz
      if (x >= 0 && y >= 0 && z >= 0 && x < GRID && y < GRID && z < GRID && nHg[x + GRID * (y + GRID * z)] > 0) clean27 = false
    }
    const cc = ci.map(v => (v + 0.5) * DX)
    let g = Infinity
    for (const p of hg) g = Math.min(g, Math.max(0, Math.abs(p[0] - cc[0]) - DX, Math.abs(p[1] - cc[1]) - DX, Math.abs(p[2] - cc[2]) - DX))
    return { i, row: fz.row[j], cell: ci, clean27, gDx: g / DX }
  })
  const byRow = f => [0, 1].map(r => drops.filter(d => d.row === r && f(d)).length)
  const bins = [['g < ¼dx', d => d.gDx < 0.25], ['¼–½dx', d => d.gDx >= 0.25 && d.gDx < 0.5], ['≥ ½dx', d => d.gDx >= 0.5]]
  const q = (arr, p) => { const v = [...arr].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN }
  report.gR4 = {
    sampleFrame: s.frame, n: s.n, status: { form: st4.immiscible?.form, active: st4.immiscible?.active, wallShear: st4.wallShear },
    frozen: { all: drops.length, row0: byRow(() => true)[0], row1: byRow(() => true)[1] },
    rule27: { all: drops.filter(d => d.clean27).length, row0: byRow(d => d.clean27)[0], row1: byRow(d => d.clean27)[1] },
    footprint: { cells: footprint, of: GRID * GRID }, mercury: { n: hg.length, belowMilliDx: hgLow, fraction: hg.length ? hgLow / hg.length : NaN },
    gBins: Object.fromEntries(bins.map(([k, f]) => [k, { row0: byRow(f)[0], row1: byRow(f)[1] }])),
    gDxQuantiles: [0, 1].map(r => { const g = drops.filter(d => d.row === r).map(d => d.gDx); return { row: r, min: q(g, 0), p25: q(g, 0.25), median: q(g, 0.5), p75: q(g, 0.75), max: q(g, 1) } }),
    drops,
  }
  const r4 = report.gR4
  gate.check(s.frame === F0 && !!s.drift && st4.immiscible?.form === FORM && st4.immiscible?.active === true && hg.length > 0 && drops.length > 0,
    `G-R4 t0 sample: frame ${s.frame} (F0 ${F0}), the drift state ${s.drift ? 'present' : 'ABSENT'}, form ${st4.immiscible?.form} active ${st4.immiscible?.active}, ${hg.length} mercury particles, frozen set ${drops.length} drops (non-empty)`)
  console.log(`  [reported] G-R4 frozen set ${r4.frozen.all} (row 0 ${r4.frozen.row0}, row 1 ${r4.frozen.row1}); the 27-cell rule's subset ${r4.rule27.all} (row 0 ${r4.rule27.row0}, row 1 ${r4.rule27.row1})`)
  console.log(`  [reported] G-R4 the film's floor footprint: ${footprint} of ${GRID * GRID} row-0 cells hold ≥ 1 mercury particle; mercury below 1e-3·dx: ${hgLow} of ${hg.length} (${(100 * r4.mercury.fraction).toFixed(1)} %)`)
  console.log(`  [reported] G-R4 g_i by row: ${bins.map(([k]) => `${k}: row 0 ${r4.gBins[k].row0}, row 1 ${r4.gBins[k].row1}`).join('; ')}; g/dx quantiles ${r4.gDxQuantiles.map(x => `row ${x.row} min ${x.min?.toFixed(3)} p25 ${x.p25?.toFixed(3)} median ${x.median?.toFixed(3)} p75 ${x.p75?.toFixed(3)} max ${x.max?.toFixed(3)}`).join('; ')}`)

  const stEnd = await status(page)
  gate.check(stEnd.gpuErrors === 0, `R GPU: ${stEnd.gpuErrors} uncaptured WebGPU errors on the gate page`)
  gate.check(errors.length === 0, `R console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'snapshot-page', pass, report, gate.results)
exitGate(pass ? 0 : 1)
