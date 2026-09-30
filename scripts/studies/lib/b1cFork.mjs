// b1cFork.mjs — the B1c forked same-state drift-form study's bookkeeping and statistics: spec rev 3 (FROZEN, sha256
// a3290c5464eb3cc57f17f34ddd83151f2d1e1b6b5d49ec7007ec1444ef6189c6) §3 (common frames, VOID, the probe and fidelity by
// word hashes, A1's seeds), §3a (the strata and the t0 covariates), §4 (the statistics), §5 (the readings, in their fixed
// order) and §6 (the consequences). Pure functions — no page, no GPU: scripts/studies/b1c-fork.mjs drives the page and
// calls these; b1cFork.test.mjs checks them on synthetic data whose answers are known. Every choice the spec leaves open
// is listed in b1c-fork.mjs's header ("Implementation choices"); the constants of §5 are RULES below, verbatim.
import { B1C, b1cCellOf, b1cBudgetOf } from '../../fluid-gates/lib/b1cSuccessors.mjs'

/** The window: frames F0+1 … F1 (268 … 387) on the 1/240 s schedule; §4's 30-frame sub-windows (4). */
export const FRAMES = B1C.F1 - B1C.F0, SUB = 30, NSUB = FRAMES / SUB
/** b1cBudgetTerms' keys, stored per drop per frame; a drop's sums carry them and n (its summed substeps). */
export const TERMS = ['dp', 'a', 'dtv', 'dtj', 'den']
const NT = TERMS.length, NS = NT + 1
/** The words the probe and the fidelity check compare (spec §3: every particle's pos, vel and slipState). */
export const BUFFERS = ['pos', 'vel', 'slipState']
/** §3: fewer common frames make a snapshot VOID. */
export const MIN_COMMON = B1C.MIN_USABLE
/** §5, verbatim. */
export const RULES = Object.freeze({
  RG_BAR: 0.037, RG_FACTOR: 2,            // RESTORE NOT FAITHFUL, non-bitwise: Rg_H > 0.037 AND Rg_H > 2·A_H (row 1 or all)
  NOTHING: 0.10,                          // NOTHING TO ATTRIBUTE: |Δ_own| < 0.10
  IN_S: 0.75, IN_LO: 0.25, IN_FLOOR: 2,   // IN-WINDOW: s_H ≥ 0.75, CI lower end ≥ 0.25; non-bitwise: |E_H| > 2·max(A_H, Rg_H)
  HIST_CI: 0.25,                          // HISTORY: s_H's CI inside [−0.25, +0.25] …
  HIST_ROW1: [-0.369, -0.221],            // … and Δ_own(row 1) inside −0.295 ± 2·√2·0.026
  HIST_NEVER: [0.28, 0.43],               // the secondary's reproduction: Δ_own(02:30-definition never) inside 0.355 ± 2·√2·0.027
})
/** §4/§5 bootstrap: 2000 resamples, a fixed seed (mulberry32), 95 % percentile limits by the project's convention
 *  (scripts/studies/b1c-arms.mjs ratioCI: sorted[floor(0.025·B)], sorted[floor(0.975·B)]); t0 blocks of 4³ cells, 2³ and
 *  8³ as the sensitivity. */
export const BOOT = Object.freeze({ B: 2000, SEED: 20260930, LO: 0.025, HI: 0.975, SIZES: [4, 2, 8] })

/** mulberry32 (src/bench/benchHook.ts; b1c-arms.mjs) — the bootstrap's seeded generator. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** Amendment A1: replicate k's j-th history draw uses seed 2 (§3), then 2 + k, 2 + k + 3, … */
export const seedFor = (k, j) => (j === 0 ? 2 : 2 + k + 3 * (j - 1))

/** The u32 words of b that differ from a (another length: every word) and the first index. */
export function wordDiff(a, b) {
  if (!a || !b || a.length !== b.length) return { n: Math.max(a?.length ?? 0, b?.length ?? 0) || 1, first: 0 }
  let n = 0, first = -1
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (first < 0) first = i; n++ }
  return { n, first }
}

/** One arm run's record while it runs (§4: accumulate as you go — the 15 MB samples are never kept): per window frame q
 *  (0 … 119 = frame F0+1+q) its substeps n (−1: not stepped) and the sha256 of its pos, vel and slipState words; per frame
 *  and drop j of the frozen set, b1cBudgetTerms' dp, a, dtv, dtj, den and b1cExposure's flags (reading 1, hg 2, jy 4).
 *  ~7 MB per arm at 1400 drops; reduced to per-drop sums once the snapshot's common frames are known (reduceRun). */
export class ArmRecord {
  constructor(nDrops, meta) {
    this.nDrops = nDrops
    this.meta = meta
    this.n = new Int32Array(FRAMES).fill(-1)
    this.hash = Object.fromEntries(BUFFERS.map(b => [b, new Array(FRAMES).fill(null)]))
    this.terms = new Float64Array(FRAMES * nDrops * NT)
    this.flags = new Uint8Array(FRAMES * nDrops)
  }
  frame(q, n, hashes) {
    this.n[q] = n
    for (const b of BUFFERS) this.hash[b][q] = hashes[b]
  }
  put(q, j, t, e) {
    const o = (q * this.nDrops + j) * NT
    this.terms[o] = t.dp; this.terms[o + 1] = t.a; this.terms[o + 2] = t.dtv; this.terms[o + 3] = t.dtj; this.terms[o + 4] = t.den
    this.flags[q * this.nDrops + j] = (e.reading ? 1 : 0) | (e.hg ? 2 : 0) | (e.jy ? 4 : 0)
  }
  /** window frames with a substep count other than 1 (a frame not stepped counts: n = −1) */
  multiFrames() { const out = []; for (let q = 0; q < FRAMES; q++) if (this.n[q] !== 1) out.push(q); return out }
}

/** §3: the frames single-substep in EVERY run of a snapshot (mask over q) and their count. */
export function commonFrames(records) {
  const mask = new Uint8Array(FRAMES)
  let count = 0
  for (let q = 0; q < FRAMES; q++) if (records.every(r => r.n[q] === 1)) { mask[q] = 1; count++ }
  return { mask, count }
}
/** The frames outside the common set so far (for an early VOID: more than FRAMES − MIN_COMMON of them). */
export function unionMulti(records) {
  const s = new Set()
  for (const r of records) for (const q of r.multiFrames()) s.add(q)
  return s.size
}

/** Two runs' words frame by frame (by their sha256): the first differing frame and buffer, and how many frames differ. */
export function compareRuns(a, b) {
  let first = null, frames = 0
  for (let q = 0; q < FRAMES; q++) {
    const bad = BUFFERS.filter(x => a.hash[x][q] === null || b.hash[x][q] === null || a.hash[x][q] !== b.hash[x][q])
    if (bad.length) { frames++; if (!first) first = { frame: B1C.F0 + 1 + q, buffer: bad[0], buffers: bad } }
  }
  return { identical: frames === 0, first, frames }
}

/** A run reduced over the snapshot's common frames (mask): per drop the sums of dp, a, dtv, dtj, den and n (its substeps
 *  there — one per common frame), in frame order as b1cDense sums them; the same per 30-frame sub-window; per drop the
 *  exposure: hg / jy at ≥ 1 common frame, the common frames without a kernel reading, and b1cDense's own rule over all 120
 *  frames (hg or jy at any window frame, n ≠ 1 included — the 02:30 definition). */
export function reduceRun(rec, mask) {
  const nd = rec.nDrops, sums = new Float64Array(nd * NS), sub = new Float64Array(NSUB * nd * NS)
  const hgCommon = new Uint8Array(nd), jyCommon = new Uint8Array(nd), noReading = new Uint16Array(nd), any0230 = new Uint8Array(nd)
  for (let q = 0; q < FRAMES; q++) {
    const w = Math.floor(q / SUB)
    for (let j = 0; j < nd; j++) {
      const fl = rec.flags[q * nd + j]
      if (rec.n[q] !== -1 && (fl & 6)) any0230[j] = 1
      if (!mask[q]) continue
      if (fl & 2) hgCommon[j] = 1
      if (fl & 4) jyCommon[j] = 1
      if (!(fl & 1)) noReading[j]++
      const o = (q * nd + j) * NT, s = j * NS, u = (w * nd + j) * NS
      for (let t = 0; t < NT; t++) { sums[s + t] += rec.terms[o + t]; sub[u + t] += rec.terms[o + t] }
      sums[s + NT]++; sub[u + NT]++
    }
  }
  const multi = rec.multiFrames()
  return { meta: rec.meta, nDrops: nd, sums, sub, hgCommon, jyCommon, noReading, any0230,
    frames: { stepped: FRAMES - multi.filter(q => rec.n[q] === -1).length, multi: multi.length } }
}
/** Drop j's sums of a reduced run, over the whole window (w = null) or sub-window w, as b1cBudgetOf takes them. */
export function dropSums(run, j, w = null) {
  const a = w === null ? run.sums : run.sub, o = w === null ? j * NS : (w * run.nDrops + j) * NS
  return { dp: a[o], a: a[o + 1], dtv: a[o + 2], dtj: a[o + 3], den: a[o + 4], n: a[o + 5] }
}
/** A stratum's budget in one run, exactly as b1cSuccessors forms it (b1cBudgetOf, drops in set order), plus its numerator
 *  Σδ_dp and denominator ΣΔt·u_V,y (m) reported separately (spec §4). */
export function runBudget(run, members, w = null) {
  const ds = members.map(j => dropSums(run, j, w))
  return { ...b1cBudgetOf(ds), sumDp: ds.reduce((q, d) => q + d.dp, 0), sumDen: ds.reduce((q, d) => q + d.den, 0) }
}

/** §3a's t0 covariates of the frozen set — snapshot-page.mjs's G-R4 computation (its gate text, verbatim in substance):
 *  per drop the draft's 27-cell rule (no mercury particle in its t0 cell or the 26 around it) and g_i, the L∞ gap at t0
 *  between its own kernel support (the box of half-width dx about its cell centre) and the nearest mercury particle, in dx;
 *  the film's floor footprint (row-0 cells holding ≥ 1 mercury particle) and the mercury below 1e-3·dx. */
export function t0Covariates(s, fz) {
  const { L, DX } = B1C, GRID = 64
  const mats = Object.fromEntries(s.materials.map(m => [m.name, m])), hgId = mats.Mercury?.id
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
    return { i, row: fz.row[j], cell: c, clean27, gDx: g / DX }
  })
  return { drops, footprint: { cells: footprint, of: GRID * GRID }, mercury: { n: hg.length, belowMilliDx: hgLow } }
}
/** §3a's g bins (in dx). */
export const G_BINS = [['g<1/4dx', g => g < 0.25], ['g1/4-1/2dx', g => g >= 0.25 && g < 0.5], ['g>=1/2dx', g => g >= 0.5]]

/** A snapshot's strata (§3a) as lists of drop positions j in the frozen set: row 1 (PRIMARY), all (GUARD), row 0
 *  (REPORTED), the joint never (SECONDARY: kernel α_Hg ≤ 1e-4 at every common frame in every run), its J_y-clause version
 *  (sensitivity), the g bins and the 27-cell rule (t0 covariates, reported). */
export function strataOf(snap) {
  const all = Array.from({ length: snap.drops }, (_, j) => j)
  const st = {
    row1: all.filter(j => snap.row[j] === 1),
    all,
    row0: all.filter(j => snap.row[j] === 0),
    jointNever: all.filter(j => snap.runs.every(r => !r.hgCommon[j])),
    jointNeverJy: all.filter(j => snap.runs.every(r => !r.hgCommon[j] && !r.jyCommon[j])),
    clean27: all.filter(j => snap.clean27[j]),
  }
  for (const [name, f] of G_BINS) st[name] = all.filter(j => f(snap.gDx[j]))
  return st
}
/** The 02:30-definition never stratum of a run (the secondary's reproduction: each R arm on its own trajectory, the J_y
 *  clause included — b1cDense's rule over all 120 window frames). */
export const never0230 = (snap, run) => Array.from({ length: snap.drops }, (_, j) => j).filter(j => !run.any0230[j])

/** The runs of an arm (by tag) in a snapshot, in run order. */
export const armRuns = (snap, tag) => snap.runs.filter(r => r.meta.arm === tag)
/** The restored arm of the history's own form (spec §3: the probe's and the fidelity check's partner of A and R). */
export const sameFormArm = H => (H === 'cell' ? 'C' : 'F')
const mean = v => v.reduce((a, b) => a + b, 0) / v.length
const ddp = (run, members, w) => runBudget(run, members, w).Ddp
/** D_dp of an arm: its one run, or the mean over its runs (non-bitwise branch, §4). */
export const armDdp = (snap, tag, members, w = null) => mean(armRuns(snap, tag).map(r => ddp(r, members, w)))

/** One snapshot on one stratum (§4): per arm and run the budget; E_H,k = D_dp(F) − D_dp(C); own = D_dp of the history's
 *  own form (C on cell histories, F on face); A_H,k (bitwise: |D_dp(A) − D_dp(same-form)|, 0 when A did not run;
 *  non-bitwise: the RMS of the matched single-run differences A_j − same-form_j); Rg_H,k = |D_dp(R) − D_dp(same-form)|;
 *  E per 30-frame sub-window. */
export function snapshotStats(snap, members) {
  const S = sameFormArm(snap.H), runs = snap.runs.map(r => ({ arm: r.meta.arm, form: r.meta.form, run: r.meta.run, ...runBudget(r, members) }))
  const E = armDdp(snap, 'F', members) - armDdp(snap, 'C', members)
  const own = armDdp(snap, S, members)
  const aRuns = armRuns(snap, 'A'), sRuns = armRuns(snap, S)
  let A = 0, Aran = aRuns.length > 0
  if (Aran && snap.branch === 'nonbitwise') {
    const m = Math.min(aRuns.length, sRuns.length), d = []
    for (let j = 0; j < m; j++) d.push(ddp(aRuns[j], members) - ddp(sRuns[j], members))
    A = Math.sqrt(mean(d.map(x => x * x)))
  } else if (Aran) A = Math.abs(armDdp(snap, 'A', members) - own)
  const Rg = Math.abs(armDdp(snap, 'R', members) - own)
  const Ew = Array.from({ length: NSUB }, (_, w) => armDdp(snap, 'F', members, w) - armDdp(snap, 'C', members, w))
  return { drops: members.length, runs, E, own, A, Aran, Rg, Ew }
}

/** Per stratum, per snapshot and block size: the blocks its drops occupy at t0 and, per block and run, Σδ_dp and ΣΔt·u_V,y
 *  (the bootstrap's units; §4: blocks resampled jointly for every arm of the snapshot). */
export function blockSums(snap, members, size) {
  const byBlock = new Map()
  for (const j of members) {
    const c = snap.cell[j], b = Math.floor((c % 64) / size) + 64 * (Math.floor((Math.floor(c / 64) % 64) / size) + 64 * Math.floor(Math.floor(c / 4096) / size))
    if (!byBlock.has(b)) byBlock.set(b, [])
    byBlock.get(b).push(j)
  }
  const blocks = [...byBlock.values()], nr = snap.runs.length, v = new Float64Array(blocks.length * nr * 2)
  blocks.forEach((ms, bi) => snap.runs.forEach((r, ri) => {
    let dp = 0, den = 0
    for (const j of ms) { dp += r.sums[j * NS]; den += r.sums[j * NS + 4] }
    v[(bi * nr + ri) * 2] = dp; v[(bi * nr + ri) * 2 + 1] = den
  }))
  const idx = tag => snap.runs.map((r, i) => (r.meta.arm === tag ? i : -1)).filter(i => i >= 0)
  return { nb: blocks.length, nr, v, F: idx('F'), C: idx('C'), own: idx(sameFormArm(snap.H)) }
}
/** One block resample of a snapshot (nb draws with replacement, the same draw for every run): E* and own*. */
function resampleSnapshot(bs, rng, acc) {
  acc.fill(0)
  for (let d = 0; d < bs.nb; d++) {
    const b = Math.floor(rng() * bs.nb), o = b * bs.nr * 2
    for (let t = 0; t < bs.nr * 2; t++) acc[t] += bs.v[o + t]
  }
  const D = ri => acc[2 * ri] / acc[2 * ri + 1], m = ix => mean(ix.map(D))
  return { E: m(bs.F) - m(bs.C), own: m(bs.own) }
}
/** The percentile limits of a sample (the project's convention), NaN draws dropped and counted. */
export function percentileCI(values) {
  const v = values.filter(x => !Number.isNaN(x)).sort((a, b) => a - b)
  return { lo: v.length ? v[Math.floor(BOOT.LO * v.length)] : NaN, hi: v.length ? v[Math.min(v.length - 1, Math.floor(BOOT.HI * v.length))] : NaN, nan: values.length - v.length, n: values.length }
}
/** §4's within-snapshot CI of E_H,k: a block bootstrap over the stratum's t0 blocks, jointly for every arm. */
export function bootE(snap, members, size, B = BOOT.B, seed = BOOT.SEED) {
  const bs = blockSums(snap, members, size), rng = mulberry32(seed), acc = new Float64Array(bs.nr * 2), e = []
  if (bs.nb === 0) return { lo: NaN, hi: NaN, nan: B, n: B, blocks: 0 }
  for (let b = 0; b < B; b++) e.push(resampleSnapshot(bs, rng, acc).E)
  return { ...percentileCI(e), blocks: bs.nb }
}
/** §5's two-level percentile bootstrap: per resample, for each history (cell, then face) K snapshots drawn with
 *  replacement from its K, then each drawn snapshot's stratum blocks resampled (jointly for every arm); E*_H = the mean of
 *  its drawn snapshots' E*, own*_H likewise, Δ* = own*_cell − own*_face (one Δ* per resample, shared by both histories:
 *  Δ_own uses both), s*_H = −E*_H/Δ*. `byH` = { cell: [snap…], face: [snap…] }; `stratum(snap)` → its members; `keep`:
 *  also return the raw resamples (tests). */
export function twoLevel(byH, stratum, size, B = BOOT.B, seed = BOOT.SEED, keep = false) {
  const pre = Object.fromEntries(['cell', 'face'].map(H => [H, byH[H].map(sn => blockSums(sn, stratum(sn), size))]))
  const rng = mulberry32(seed), out = { cell: [], face: [], Ecell: [], Eface: [], delta: [] }
  const acc = new Float64Array(2 * Math.max(...['cell', 'face'].flatMap(H => pre[H].map(b => b.nr))))
  for (let b = 0; b < B; b++) {
    const E = {}, own = {}
    for (const H of ['cell', 'face']) {
      const K = pre[H].length
      let se = 0, so = 0
      for (let j = 0; j < K; j++) {
        const bs = pre[H][Math.floor(rng() * K)]
        const r = bs.nb ? resampleSnapshot(bs, rng, acc) : { E: NaN, own: NaN }
        se += r.E; so += r.own
      }
      E[H] = se / K; own[H] = so / K
    }
    const delta = own.cell - own.face
    out.delta.push(delta); out.Ecell.push(E.cell); out.Eface.push(E.face)
    out.cell.push(-E.cell / delta); out.face.push(-E.face / delta)
  }
  return { s: { cell: percentileCI(out.cell), face: percentileCI(out.face) }, E: { cell: percentileCI(out.Ecell), face: percentileCI(out.Eface) }, delta: percentileCI(out.delta), ...(keep ? { raw: out } : {}) }
}

/** The statistics of one stratum over the study (§4, §5): per history the per-snapshot values, E_H (mean over k), its
 *  spread, E per sub-window, own_H, A_H and Rg_H (max over k); Δ_own = own_cell − own_face; s_H = −E_H/Δ_own with the
 *  two-level CI (4³ blocks; 2³ and 8³ as the sensitivity); per-snapshot E CIs (4³, 2³, 8³); per-k s_H,k = −E_H,k/Δ_own. */
export function stratumStudy(byH, stratum, { B = BOOT.B, seed = BOOT.SEED, sizes = BOOT.SIZES, perSnapshotCI = true } = {}) {
  const per = {}
  for (const H of ['cell', 'face']) {
    const list = byH[H].map((sn, ix) => {
      const m = stratum(sn), st = snapshotStats(sn, m)
      if (perSnapshotCI) st.Eci = Object.fromEntries(sizes.map(z => [`${z}^3`, bootE(sn, m, z, B, seed + 1000 * (H === 'cell' ? 0 : 1) + ix)]))
      return { k: sn.k, label: sn.label, ...st }
    })
    const Ek = list.map(x => x.E), sd = Ek.length > 1 ? Math.sqrt(Ek.reduce((q, e) => q + (e - mean(Ek)) ** 2, 0) / (Ek.length - 1)) : NaN
    per[H] = { snapshots: list, E: mean(Ek), Esd: sd, Erange: [Math.min(...Ek), Math.max(...Ek)], Ew: Array.from({ length: NSUB }, (_, w) => mean(list.map(x => x.Ew[w]))),
      own: mean(list.map(x => x.own)), A: Math.max(...list.map(x => x.A)), Rg: Math.max(...list.map(x => x.Rg)) }
  }
  const delta = per.cell.own - per.face.own
  const s = { cell: -per.cell.E / delta, face: -per.face.E / delta }
  for (const H of ['cell', 'face']) per[H].sk = per[H].snapshots.map(x => -x.E / delta)
  const ci = Object.fromEntries(sizes.map(z => [`${z}^3`, twoLevel(byH, stratum, z, B, seed)]))
  return { per, delta, s, ci }
}

// ── §5 readings and §6 consequences ─────────────────────────────────────────────────────────────────────────────────
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v))
const ciTxt = c => `[${f3(c.lo)}, ${f3(c.hi)}]${c.nan ? ` (${c.nan} NaN draws dropped)` : ''}`
const inside = (x, [lo, hi]) => x >= lo && x <= hi
/** The guard (§5 MIXED: "s_H(all) with a CI excluding 0 on the opposite side from s_H(row 1) in either history"): per
 *  history, s_H(all)'s CI entirely on the other side of 0 from the sign of s_H of the reading's stratum. */
export function guardCheck(s, allCi) {
  const opp = H => (s[H] > 0 && allCi[H].hi < 0) || (s[H] < 0 && allCi[H].lo > 0)
  return { cell: opp('cell'), face: opp('face'), fires: opp('cell') || opp('face') }
}

/** §5, one reading (primary on row 1, or the never secondary on the joint never stratum), evaluated in the fixed order —
 *  the first that holds is the reading; every step is returned with the numbers that decided it.
 *  in = { name, stratum, fidelity: { cell, face } (each { branch, mismatch: first differing frame/buffer of any k (bitwise)
 *  or null, Rg: { row1, all }, A: { row1, all } }), delta, s: { cell, face }, ci: { cell, face }, E: { cell, face },
 *  floors: { cell: { A, Rg }, face } (this stratum), repro: { value, band, what }, allS, allCi (the guard) } */
export function evaluateReading(inp) {
  const steps = [], HS = ['cell', 'face']
  const step = (name, holds, text) => { steps.push({ name, holds, text }); return holds }
  // RESTORE NOT FAITHFUL — each history by its own branch
  const nf = HS.map(H => {
    const f = inp.fidelity[H]
    if (f.branch === 'bitwise') return { H, holds: !!f.mismatch, text: `${H} (bitwise branch): R vs the same-form restored arm ${f.mismatch ? `DIFFER — first at k = ${f.mismatch.k}, frame ${f.mismatch.frame}, ${f.mismatch.buffer}` : f.checked ? `identical at every window frame of ${f.checked} snapshot(s)` : 'not reached (no snapshot of this history)'}` }
    const one = st => f.Rg[st] > RULES.RG_BAR && f.Rg[st] > RULES.RG_FACTOR * f.A[st]
    return { H, holds: one('row1') || one('all'), text: `${H} (non-bitwise branch): Rg_H row 1 ${f3(f.Rg.row1)} (A_H ${f3(f.A.row1)}), all ${f3(f.Rg.all)} (A_H ${f3(f.A.all)}) against > ${RULES.RG_BAR} and > ${RULES.RG_FACTOR}·A_H` }
  })
  if (step('RESTORE NOT FAITHFUL', nf.some(x => x.holds), nf.map(x => x.text).join('; ') + (inp.name === 'secondary' ? ' (the primary\'s fidelity verdict)' : ''))) return finish('RESTORE NOT FAITHFUL')
  if (step('NOTHING TO ATTRIBUTE', !(Math.abs(inp.delta) >= RULES.NOTHING), `|Δ_own(${inp.stratum})| = ${f3(Math.abs(inp.delta))} against < ${RULES.NOTHING}${Math.abs(inp.delta) >= RULES.NOTHING ? '' : ' → s_H undefined; E_H and the strata reported'}`)) return finish('NOTHING TO ATTRIBUTE')
  const floorOk = H => inp.fidelity[H].branch === 'bitwise' || Math.abs(inp.E[H]) > RULES.IN_FLOOR * Math.max(inp.floors[H].A, inp.floors[H].Rg)
  const inW = H => inp.s[H] >= RULES.IN_S && inp.ci[H].lo >= RULES.IN_LO && floorOk(H)
  if (step('IN-WINDOW', HS.every(inW), HS.map(H => `${H}: s_H ${f3(inp.s[H])} CI ${ciTxt(inp.ci[H])}${inp.fidelity[H].branch === 'bitwise' ? ' (bitwise: the floor clause is vacuous)' : `, |E_H| ${f3(Math.abs(inp.E[H]))} vs 2·max(A_H, Rg_H) ${f3(2 * Math.max(inp.floors[H].A, inp.floors[H].Rg))}`}`).join('; ') + ` — needs s_H ≥ ${RULES.IN_S} and CI lower end ≥ ${RULES.IN_LO} in both`)) return finish('IN-WINDOW')
  const histCi = H => inp.ci[H].lo >= -RULES.HIST_CI && inp.ci[H].hi <= RULES.HIST_CI
  const repro = inside(inp.repro.value, inp.repro.band)
  if (step('HISTORY', HS.every(histCi) && repro, `CIs inside [−${RULES.HIST_CI}, +${RULES.HIST_CI}]: ${HS.map(H => `${H} ${ciTxt(inp.ci[H])} ${histCi(H) ? 'yes' : 'no'}`).join(', ')}; ${inp.repro.what} ${f3(inp.repro.value)} inside [${inp.repro.band.join(', ')}]: ${repro ? 'yes' : 'no'}`)) return finish('HISTORY')
  if (step('PARTIAL', HS.every(H => inp.ci[H].lo > 0), `CI above 0 in both: ${HS.map(H => `${H} lower end ${f3(inp.ci[H].lo)}`).join(', ')}`)) return finish('PARTIAL')
  step('MIXED', true, `anything else${HS.some(H => inp.ci[H].hi < 0) ? ` — an s_H CI below 0 (${HS.filter(H => inp.ci[H].hi < 0).join(', ')}: the in-window form opposing the own-form difference)` : ''}`)
  return finish('MIXED')

  function finish(reading) {
    const defined = reading !== 'RESTORE NOT FAITHFUL' && reading !== 'NOTHING TO ATTRIBUTE'
    const g = defined && inp.allCi ? guardCheck(inp.s, inp.allCi) : null
    return { name: inp.name, stratum: inp.stratum, reading, steps, guard: g && { ...g, wouldVeto: g.fires && ['IN-WINDOW', 'HISTORY', 'PARTIAL'].includes(reading),
      text: `s_H(all) CI ${HS.map(H => `${H} ${ciTxt(inp.allCi[H])} vs sign of s_H(${inp.stratum}) ${f3(inp.s[H])}: ${g[H] ? 'OPPOSITE' : 'not opposite'}`).join('; ')}` } }
  }
}

/** §6, decided before any run: the consequence text of the primary and the secondary readings. */
export function consequences(primary, secondary) {
  const out = []
  const p = primary?.reading, s = secondary?.reading
  if (!p) return ['No reading (the study did not complete): nothing changes; the item stays open.']
  if (p === 'IN-WINDOW') out.push('Primary IN-WINDOW: the row-1 (and all-drop) own-form difference of the 02:30 study is attributed in-window — the drift\'s form applied within the window carries it.')
  else if (p === 'HISTORY') out.push('Primary HISTORY: the row-1 (and all-drop) attribution of the 02:30 difference is corrected to "history, not in-window" — it came from accumulated state / drop selection.')
  else if (p === 'PARTIAL') out.push('Primary PARTIAL: s_H with its CI is recorded as the in-window share of the row-1 (and all-drop) own-form difference; no single-cause claim.')
  else out.push(`Primary ${p}: no change; the item stays open with the measured gaps.${p === 'RESTORE NOT FAITHFUL' ? ' (§5: stop — the first differing frame and buffer are reported above; repair the restore.)' : ''}`)
  if (s === 'IN-WINDOW' || s === 'HISTORY' || s === 'PARTIAL') out.push(`"ATTRIBUTED (candidate)" (the 02:30 NEVER reading) follows the never secondary's reading: ${s} — on the joint never stratum, a principal stratum (post-treatment; the E contrast is paired within it).`)
  else if (s) out.push(`"ATTRIBUTED (candidate)" (the 02:30 NEVER reading) follows the never secondary's reading: ${s} — no change to it; the item stays open with the measured gaps (a principal stratum).`)
  if (s && p !== s) out.push(`The primary (${p}) and the secondary (${s}) disagree: both are recorded and the item stays open.`)
  out.push('Whatever the reading: the cell form stays in code as W4\'s must-fail control and K32c\'s subject, bench-only (configure({ immDriftForm }) — on no page option list); the face form stays the default on its own gates (W, K32).')
  return out
}
