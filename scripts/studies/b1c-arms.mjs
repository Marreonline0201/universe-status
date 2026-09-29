#!/usr/bin/env node
// b1c-arms.mjs — the B1c decisive experiments, first pass: WHICH part of the drops' excess slip comes from the mercury
// film? (step 1 of the 2026-09-29 plan; design: the B1c synthesis memo of 2026-09-29 §2.0, §2.3, §2.4 — scratch
// s36e/b1c_synthesis_memo.md, summarised in vault project/active-plan.md step 1). PRE-REGISTERED in this header before
// any arm ran; nothing below is tuned after a result.
//
//   node scripts/studies/b1c-arms.mjs [--arms=E3,E6-0,E5p,E6-t0,E5] [--runs=3] [--selfcheck-only]   (the clean gate tree)
// Hook X self-checks run first (memo §2.0): the switch leaves slip memory bit-identical, an excluded liquid has 0 slip
// and 0 inputs, α_Hg ≤ 1e-6 for oil with mercury excluded, [] restores tracking, a typo throws — any failure aborts.
//
// Scene: s31c-page's B1 exactly (water pool 3.63 × 0.17 × 3.63 m, an olive-oil block and a mercury block released
// above it), seed 2, lockstep 1/60 s, g = 9.80665. Arms (bench hook X = configure({immExcludeLiquids})):
//   E3     the baseline (drift on for all three liquids)
//   E6-0   mercury excluded from the drift from t = 0 (untracked: no slip, not in α/ρ_m/μ_m/J; the film stays physical)
//   E5p    (E5′) olive oil excluded at t0 = 4 s — the true passive control: no drop slip, the mercury artifact kept
//   E6-t0  mercury excluded at t0 — the gaps without in-window mercury effects
//   E5     the whole drift switched off at t0 (disableImmiscible) — no drop slip and no artifact
// Every arm is identical to E3 up to t0 (E6-0 excepted); the set is chosen from the t0 sample ALONE (memo §2.0, which
// corrects design change 4's two-instant filter): oil drops dispersed (d > 0) and dilute (the cell's particle-count
// α < 0.3, water present), the kernel's α_Hg ≤ 1e-4, below the FIXED height y < 7.36 cm (the six baseline runs' mean
// 8-s water median), split into row 0 (y < dx) and row 1. The window is t0 → t1 = 4.5 s, sampled every frame.
// Per drop: Δ = its rise − the mean rise of the WATER that shared its cell at t0 (the cohort); A = ∫ s_y dt (the
// model's own slip, trapezoid over the frames); U_eq = the oil-in-water law at (d, α) at t0 (s31c's uSlip).
//   R = ΣΔ / (T·ΣU_eq)   measured slip ÷ the law (B1c's quantity on this set)
//   M = ΣΔ / ΣA          measured ÷ the model's own slip — gap (i)
//   K = Σ s_y / Σ law_y  the model ÷ its own instantaneous law with the kernel's inputs (a, ρ_m, μ_m), over the frames
//                        in [t0 + 0.1, t1] (after ~2τ) — gap (ii)
// Strata (reported): row 0 / row 1; mercury-exposed in the window (kernel α_Hg > 1e-4 or J_y = s_y − u_V,y < −1 cm/s
// at any frame) vs never; d over the window shrank / same / reset. 95 % CIs: cluster bootstrap over the t0 cells
// (2000 resamples, seeded). W-null: water below the band in the set's t0 cells through the same Δ (the cut's passive
// geometry term). Film (at 8 s): mercury centre of mass (physical film 4.99 mm), water median, and over 7 → 8 s wall
// clamps and density push-backs per substep (pre-drift 62–123 / 22–56). Film-transient proxy for the t0-switched arms:
// the mean |non-advective displacement| of rows 0–1 water per frame, |Δy − Δt·(v̄_y + ū_V,y)| (frame-end averages).
// Continuity: design change 4's own set and ratio from the same data (should reproduce s31c's × 1.33–1.35 in E3).
// READINGS, pre-set (memo §2.3–2.4; "holds" = in every run):
//   (ii) is in-window mercury memory  — E6-t0's K is 1 ± 0.03 while E3's K ≥ 1.05
//   (i)  is in-window mercury effects — E6-t0's M ≤ 1.05
//   passive contamination             — E5p's R ≥ 0.1 (the drift-on flow alone moves the observable that much);
//                                       |R_E5p| ≤ 0.05 → the excess needs the drops' own slip
//   E6-0 valid only if the mercury centre of mass at 8 s ≥ 2.5 mm and wall clamps ≤ 150 per substep; its readings as
//   E6-t0's. E6-t0 / E5 (i) readings void if their film-transient proxy exceeds twice E3's.
//   Inconclusive bands: K in 1.03–1.05 or M in 1.05–1.10 → no single-cause claim.
// Power: a GPU study — refuses to run on battery (owner rule 2026-09-29; scripts/lib/power.mjs).
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, waitStepped, provenance, G_STANDARD, DOMAIN_L_M, unitVelToMs } from '../lib/fluid-page.mjs'
import { powerState, describePower } from '../lib/power.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const L = DOMAIN_L_M, DX = L / 64, BAND_Y = 0.0736, F0 = 240, F1 = 270, FK = 246, FRAME = 1 / 60, T = (F1 - F0) * FRAME
const SCENE = { name: 's31c-buoyancy', materials: [], gravity_mps2: G_STANDARD, spawns: [
  { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } },
  { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } },
  { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] }
const ARMS = {
  E3: {}, 'E6-0': { from0: ['mercury'] }, E5p: { atT0: { immExcludeLiquids: ['olive-oil'] } },
  'E6-t0': { atT0: { immExcludeLiquids: ['mercury'] } }, E5: { atT0: { disableImmiscible: true } },
}
const argv = process.argv.slice(2), opt = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const arms = opt('arms')?.split(',') ?? Object.keys(ARMS), RUNS = Number(opt('runs') ?? 3)
for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm ${a} (${Object.keys(ARMS).join(', ')})`)

const power = powerState()
console.log(`power: ${describePower(power)}`)
if (power.ac !== true && !argv.includes('--allow-battery')) { console.error('refusing: a GPU study runs on AC only (owner rule; --allow-battery overrides)'); process.exit(3) }

function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const cellOf = (pos, i) => { const c = [0, 1, 2].map(a => Math.min(63, Math.max(0, Math.floor(pos[3 * i + a] * L / DX)))); return c[0] + 64 * (c[1] + 64 * c[2]) }
const med = v => { const q = [...v].sort((x, y) => x - y); return q.length ? q[Math.floor(q.length / 2)] : NaN }

/** The liquids' constants and laws from a sample's material table (s31c-page's B1c definitions, verbatim). */
function laws(s) {
  const mat = Object.fromEntries(s.materials.map(m => [m.name, m]))
  const RO = mat['Olive Oil'].rho, MUO = mat['Olive Oil'].mu, RW = mat.Water.rho, MUW = mat.Water.mu, RH = mat.Mercury.rho
  const fRe = Re => (Re < 1000 ? 1 + 0.15 * Re ** 0.687 : 0.44 * Re / 24)
  const Ueq = (d, F, rc, muM) => {
    const G2 = d ** 3 * rc * F / (18 * muM * muM)
    if (!(G2 > 0)) return 0
    let lo = 0, hi = G2
    for (let it = 0; it < 400 && hi - lo > 1e-15 * hi; it++) { const mid = 0.5 * (lo + hi); if (mid * fRe(mid) < G2) lo = mid; else hi = mid }
    return 0.5 * (lo + hi) * muM / (d * rc)
  }
  const muStar = (MUO + 0.4 * MUW) / (MUO + MUW)
  const uSlip = (d, a0) => { const a = Math.min(0.99, a0), rm = (1 - a) * RW + a * RO, muM = MUW * (1 - a) ** (-2.5 * muStar); return Ueq(d, Math.abs(RO - rm) * G_STANDARD, RW, muM) }
  const alphaHg = (s, i) => { if (!s.slipIn) return 0; const aD = s.slipIn[8 * i + 3], rm = s.slipIn[8 * i + 4]; return rm > 0 ? (rm - (1 - aD) * RW - aD * RO) / (RH - RO) : Infinity }
  /** the kernel-input law's vertical component at one instant (s31c's inst()), or null when not dispersed */
  const lawY = (s, i) => {
    if (!s.slipIn || !s.drift) return null
    const g = j => s.slipIn[8 * i + j], acc = [g(0), g(1), g(2)], rm = g(4), muM = g(5), dd = s.drift[4 * i + 3], aM = Math.hypot(...acc)
    return dd > 0 && rm > 0 && aM > 0 ? Ueq(dd, Math.abs(RO - rm) * aM, RW, muM) * Math.sign(RO - rm) * acc[1] / aM : null
  }
  return { ids: { oil: mat['Olive Oil'].id, w: mat.Water.id, hg: mat.Mercury.id }, uSlip, alphaHg, lawY }
}

/** Ratio of sums with a cluster bootstrap over cells: items [{cell, num, den}] → { v, lo, hi }. */
function ratioCI(items, seed = 7) {
  const v = items.reduce((q, r) => q + r.num, 0) / items.reduce((q, r) => q + r.den, 0)
  const byCell = new Map()
  for (const r of items) { const e = byCell.get(r.cell) ?? { num: 0, den: 0 }; e.num += r.num; e.den += r.den; byCell.set(r.cell, e) }
  const cl = [...byCell.values()], rng = mulberry32(seed), bs = []
  if (cl.length < 2) return { v, lo: NaN, hi: NaN, n: items.length }
  for (let b = 0; b < 2000; b++) { let n = 0, d = 0; for (let k = 0; k < cl.length; k++) { const e = cl[Math.floor(rng() * cl.length)]; n += e.num; d += e.den } bs.push(n / d) }
  bs.sort((x, y) => x - y)
  return { v, lo: bs[Math.floor(0.025 * bs.length)], hi: bs[Math.floor(0.975 * bs.length)], n: items.length }
}

async function runArm(page, arm, run) {
  const cfg = ARMS[arm]
  await page.evaluate(() => window.__fluidBench.configure({ immExcludeLiquids: [], disableImmiscible: false }))
  await loadScenario(page, SCENE, 2)
  // E6-0: after the load (the scene's own material table now holds mercury), before the first step — i.e. from t = 0
  if (cfg.from0) await page.evaluate(k => window.__fluidBench.configure({ immExcludeLiquids: k }), cfg.from0)
  let s = await sampleAtFrame(page, F0)
  const Lw = laws(s), { ids } = Lw
  if (!s.drift) throw new Error(`${arm}: no drift state at t0 — is the drift active?`)
  // the set, from the t0 sample alone
  const nAll = new Uint16Array(64 ** 3), nOil = new Uint16Array(64 ** 3), cohort = new Map()
  for (let i = 0; i < s.n; i++) {
    const c = cellOf(s.pos, i); nAll[c]++
    if (s.comp[i] === ids.oil) nOil[c]++
    else if (s.comp[i] === ids.w) { if (!cohort.has(c)) cohort.set(c, []); cohort.get(c).push(i) }
  }
  const set = [], oils = []
  for (let i = 0; i < s.n; i++) {
    if (s.comp[i] !== ids.oil) continue
    const c = cellOf(s.pos, i), y = s.pos[3 * i + 1] * L, a = nOil[c] / Math.max(1, nAll[c]), d = s.drift[4 * i + 3]
    oils.push({ i, c, y, a, d, hg0: Lw.alphaHg(s, i) })
    if (!(y < BAND_Y) || !(d > 0) || !(a < 0.3) || !cohort.has(c) || !(Lw.alphaHg(s, i) <= 1e-4)) continue
    set.push({ i, c, row: y < DX ? 0 : 1, y0: y, d0: d, a0: a, ueq: Lw.uSlip(d, a), A: 0, sPrev: s.drift[4 * i + 1], exposed: false, kS: 0, kL: 0, dEnd: d })
  }
  const setCells = new Set(set.map(r => r.c))
  // W-null water (below the band in the set's cells) and the film-transient probe (rows 0–1 water, every 7th)
  const wnull = [], probe = []
  for (const c of setCells) for (const i of cohort.get(c)) if (s.pos[3 * i + 1] * L < BAND_Y) wnull.push({ i, c, y0: s.pos[3 * i + 1] * L })
  { let k = 0; for (let i = 0; i < s.n; i++) if (s.comp[i] === ids.w && s.pos[3 * i + 1] * L < 2 * DX && (k++ % 7 === 0)) probe.push(i) }
  // cohort rises for every cell holding oil and water at t0 (a superset of the set's cells: design change 4's set too)
  const oilCells = new Set(oils.filter(o => cohort.has(o.c)).map(o => o.c))
  const cohortY0 = new Map([...oilCells].map(c => [c, cohort.get(c).map(i => s.pos[3 * i + 1] * L)]))
  let prevProbe = probe.map(i => ({ y: s.pos[3 * i + 1] * L, v: unitVelToMs(s.vel[3 * i + 1]), u: s.uV ? s.uV[4 * i + 1] : 0 })), probeSum = 0, probeN = 0
  const sub0 = await page.evaluate(() => window.__fluidBench.diagnostics().then(d => d.substeps))
  if (cfg.atT0) await page.evaluate(o => window.__fluidBench.configure(o), cfg.atT0)
  // the window, every frame
  for (let f = F0 + 1; f <= F1; f++) {
    s = await sampleAtFrame(page, f)
    for (const r of set) {
      const sy = s.drift && s.drift[4 * r.i + 3] > 0 ? s.drift[4 * r.i + 1] : 0
      r.A += 0.5 * (r.sPrev + sy) * FRAME; r.sPrev = sy
      const uy = s.uV ? s.uV[4 * r.i + 1] : 0
      if (Lw.alphaHg(s, r.i) > 1e-4 && Number.isFinite(Lw.alphaHg(s, r.i)) || sy - uy < -0.01) r.exposed = true
      if (f >= FK) { const ly = Lw.lawY(s, r.i); if (ly !== null) { r.kS += sy; r.kL += ly } }
      if (f === F1) { r.y1 = s.pos[3 * r.i + 1] * L; r.dEnd = s.drift ? s.drift[4 * r.i + 3] : 0; r.hg1 = Lw.alphaHg(s, r.i) }
    }
    probe.forEach((i, k) => {
      const y = s.pos[3 * i + 1] * L, v = unitVelToMs(s.vel[3 * i + 1]), u = s.uV ? s.uV[4 * i + 1] : 0, p = prevProbe[k]
      probeSum += Math.abs(y - p.y - FRAME * (0.5 * (p.v + v) + 0.5 * (p.u + u))); probeN++
      prevProbe[k] = { y, v, u }
    })
    if (f === F1) {
      for (const w of wnull) w.y1 = s.pos[3 * w.i + 1] * L
      for (const o of oils) { o.y45 = s.pos[3 * o.i + 1] * L; o.hg45 = Lw.alphaHg(s, o.i) }
      for (const [c, ys] of cohortY0) cohortY0.set(c, { rise: cohort.get(c).reduce((q, i, k) => q + s.pos[3 * i + 1] * L - ys[k], 0) / ys.length })
    }
  }
  const sub1 = await page.evaluate(() => window.__fluidBench.diagnostics().then(d => d.substeps))
  const s5 = await sampleAtFrame(page, 300)
  const rise5 = set.length ? set.reduce((q, r) => q + (s5.pos[3 * r.i + 1] * L - r.y0), 0) / set.length : NaN
  // the film, settled: diagnostics over 7 → 8 s
  await page.evaluate(() => window.__fluidBench.setStepLimit(420)); await waitStepped(page, 420)
  await page.evaluate(() => window.__fluidBench.configure({ resetDiagnostics: true }))
  const s8 = await sampleAtFrame(page, 480)
  const dg = await page.evaluate(() => window.__fluidBench.diagnostics())
  const hgY = [], wY = []
  for (let i = 0; i < s8.n; i++) { if (s8.comp[i] === ids.hg) hgY.push(s8.pos[3 * i + 1] * L); else if (s8.comp[i] === ids.w) wY.push(s8.pos[3 * i + 1] * L) }
  const wMed8 = med(wY)
  await page.evaluate(() => window.__fluidBench.configure({ immExcludeLiquids: [], disableImmiscible: false }))

  // measurements
  const riseOf = c => cohortY0.get(c).rise
  const D = r => (r.y1 - r.y0) - riseOf(r.c)
  const strata = { all: set, row0: set.filter(r => r.row === 0), row1: set.filter(r => r.row === 1), exposed: set.filter(r => r.exposed), never: set.filter(r => !r.exposed),
    shrank: set.filter(r => r.dEnd > 0 && r.dEnd < r.d0 * (1 - 1e-6)), same: set.filter(r => r.dEnd > 0 && Math.abs(r.dEnd - r.d0) <= r.d0 * 1e-6), reset: set.filter(r => !(r.dEnd > 0) || r.dEnd > r.d0 * (1 + 1e-6)) }
  const measure = rs => ({
    n: rs.length,
    R: rs.length ? ratioCI(rs.map(r => ({ cell: r.c, num: D(r), den: T * r.ueq }))) : null,
    M: rs.length && rs.some(r => r.A !== 0) ? ratioCI(rs.map(r => ({ cell: r.c, num: D(r), den: r.A }))) : null,
    K: rs.some(r => r.kL !== 0) ? ratioCI(rs.filter(r => r.kL !== 0).map(r => ({ cell: r.c, num: r.kS, den: r.kL }))) : null,
  })
  const out = { arm, run, n: set.length, strata: Object.fromEntries(Object.entries(strata).map(([k, rs]) => [k, measure(rs)])) }
  const meanUeq = set.reduce((q, r) => q + r.ueq, 0) / Math.max(1, set.length)
  out.wnull = { n: wnull.length, meanDeltaCms: wnull.length ? 100 * wnull.reduce((q, w) => q + (w.y1 - w.y0) - riseOf(w.c), 0) / wnull.length / T : NaN, ofUeq: wnull.length ? (wnull.reduce((q, w) => q + (w.y1 - w.y0) - riseOf(w.c), 0) / wnull.length / T) / meanUeq : NaN }
  out.meanUeqCms = 100 * meanUeq
  out.rise45Cms = 100 * rise5
  out.film = { hgComMm: 1000 * hgY.reduce((q, v) => q + v, 0) / hgY.length, waterMedianCm: 100 * wMed8, clampsPerSubstep: dg.clampHits / Math.max(1, dg.substeps), pushBacksPerSubstep: dg.densityPushBacks / Math.max(1, dg.substeps), vLag: dg.vLag, immMaxSlip: dg.immMaxSlip }
  out.transientProxyMm = 1000 * probeSum / Math.max(1, probeN)
  out.substepsPerFrame = (sub1 - sub0) / (F1 - F0)
  // continuity: design change 4's set and ratio (y < own 8-s median, dilute, two-liquid at 4 and 4.5 s, dispersed at 4)
  const dc4 = oils.filter(o => o.y < wMed8 && o.d > 0 && o.a < 0.3 && cohort.has(o.c) && o.hg0 <= 1e-4 && o.hg45 <= 1e-4)
  out.dc4 = { n: dc4.length, ratio: dc4.length ? (dc4.reduce((q, o) => q + (o.y45 - o.y) - riseOf(o.c) , 0) / dc4.length / T) / (dc4.reduce((q, o) => q + Lw.uSlip(o.d, o.a), 0) / dc4.length) : NaN }
  return out
}

const fmt = m => (m ? `${m.v.toFixed(3)} [${m.lo.toFixed(3)}, ${m.hi.toFixed(3)}]` : '—')

/** Hook X's self-checks (memo §2.0), run before any arm; the study aborts if one fails. */
async function selfCheck(page) {
  const out = []
  const ok = (c, msg) => { out.push(`${c ? 'ok  ' : 'FAIL'} ${msg}`); return c }
  await page.evaluate(() => window.__fluidBench.configure({ immExcludeLiquids: [], disableImmiscible: false }))
  await loadScenario(page, SCENE, 2)
  const a = await sampleAtFrame(page, 60), Lw = laws(a), { ids } = Lw
  await page.evaluate(() => window.__fluidBench.configure({ immExcludeLiquids: ['mercury'] }))
  const b = await sampleAtFrame(page, 60)   // no step in between
  let diff = 0
  for (let q = 0; q < 4 * a.n; q++) if (a.drift[q] !== b.drift[q] && !(Number.isNaN(a.drift[q]) && Number.isNaN(b.drift[q]))) diff++
  let pass = ok(diff === 0, `the switch leaves every particle's slip memory bit-identical (${diff} differing words of ${4 * a.n})`)
  const c = await sampleAtFrame(page, 61)
  let hgNon0 = 0, oilDisp = 0, oilBad = 0, maxHg = 0
  for (let i = 0; i < c.n; i++) {
    if (c.comp[i] === ids.hg) { for (let k = 0; k < 4; k++) if (c.drift[4 * i + k] !== 0) hgNon0++; for (let k = 0; k < 8; k++) if (c.slipIn[8 * i + k] !== 0) hgNon0++ }
    else if (c.comp[i] === ids.oil && c.drift[4 * i + 3] > 0) { oilDisp++; const h = Lw.alphaHg(c, i); maxHg = Math.max(maxHg, h); if (!(h <= 1e-6)) oilBad++ }
  }
  pass = ok(hgNon0 === 0, `mercury excluded: its slip state and slip inputs are exactly 0 after one frame (${hgNon0} nonzero words)`) && pass
  pass = ok(oilDisp > 0 && oilBad === 0, `mercury excluded: every dispersed oil drop's kernel α_Hg ≤ 1e-6 (${oilDisp} drops, max ${maxHg.toExponential(2)})`) && pass
  await page.evaluate(() => window.__fluidBench.configure({ immExcludeLiquids: [] }))
  const d = await sampleAtFrame(page, 62)
  let hgTracked = 0
  for (let i = 0; i < d.n; i++) if (d.comp[i] === ids.hg && d.slipIn[8 * i + 4] > 0) hgTracked++
  pass = ok(hgTracked > 0, `[] restores the default: mercury tracked again (${hgTracked} dispersed mercury particles with inputs)`) && pass
  const typo = await page.evaluate(() => { try { window.__fluidBench.configure({ immExcludeLiquids: ['mercurry'] }); return 'no error' } catch (e) { return String(e.message).slice(0, 80) } })
  pass = ok(typo !== 'no error', `an unknown liquid key throws (${typo})`) && pass
  for (const l of out) console.log(`SELFCHECK ${l}`)
  return pass
}

const prov = await provenance()
const { browser, page } = await openFluidPage(undefined, {})
const results = []
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  if (!(await selfCheck(page))) throw new Error('hook X self-check failed — no arm is valid')
  if (argv.includes('--selfcheck-only')) arms.length = 0
  for (const arm of arms) for (let k = 1; k <= RUNS; k++) {
    const r = await runArm(page, arm, k)
    results.push(r)
    const st = r.strata
    console.log(`${arm.padEnd(6)} run ${k}: set ${r.n} (row0 ${st.row0.n}, row1 ${st.row1.n}; exposed ${st.exposed.n}) R ${fmt(st.all.R)}  M ${fmt(st.all.M)}  K ${fmt(st.all.K)} | never-exposed R ${fmt(st.never.R)} M ${fmt(st.never.M)} K ${fmt(st.never.K)} | W-null ${r.wnull.ofUeq.toFixed(3)} U_eq | film: Hg COM ${r.film.hgComMm.toFixed(2)} mm, water median ${r.film.waterMedianCm.toFixed(2)} cm, clamps ${r.film.clampsPerSubstep.toFixed(0)}/substep | transient ${r.transientProxyMm.toFixed(3)} mm | substeps/frame ${r.substepsPerFrame.toFixed(2)} | DC4 ${r.dc4.ratio.toFixed(3)} (${r.dc4.n})`)
  }
} finally { await browser.close() }

// the pre-set readings
const of = a => results.filter(r => r.arm === a), every = (a, p) => of(a).length > 0 && of(a).every(p)
const lines = []
if (of('E3').length && of('E6-t0').length) {
  const iiMem = every('E6-t0', r => Math.abs(r.strata.all.K.v - 1) <= 0.03) && every('E3', r => r.strata.all.K.v >= 1.05)
  const iMerc = every('E6-t0', r => r.strata.all.M.v <= 1.05)
  const voidI = of('E6-t0').some(r => r.transientProxyMm > 2 * Math.max(...of('E3').map(q => q.transientProxyMm)))
  lines.push(`(ii) in-window mercury memory: ${iiMem ? 'HOLDS' : 'does not hold'} (E6-t0 K ${of('E6-t0').map(r => r.strata.all.K.v.toFixed(3)).join('/')}, E3 K ${of('E3').map(r => r.strata.all.K.v.toFixed(3)).join('/')})`)
  lines.push(`(i) in-window mercury effects: ${voidI ? 'VOID (film-transient proxy > 2 × E3)' : iMerc ? 'HOLDS' : 'does not hold'} (E6-t0 M ${of('E6-t0').map(r => r.strata.all.M.v.toFixed(3)).join('/')})`)
}
if (of('E5p').length) {
  const Rs = of('E5p').map(r => r.strata.all.R.v)
  lines.push(`passive contamination (E5p R ${Rs.map(v => v.toFixed(3)).join('/')}): ${Rs.every(v => v >= 0.1) ? 'the drift-on flow alone moves the observable ≥ 0.1' : Rs.every(v => Math.abs(v) <= 0.05) ? 'none — the excess needs the drops\' own slip' : 'between the pre-set bands'}`)
}
if (of('E6-0').length) {
  const valid = every('E6-0', r => r.film.hgComMm >= 2.5 && r.film.clampsPerSubstep <= 150)
  lines.push(`E6-0 film self-check: ${valid ? 'VALID' : 'VOID'} (Hg COM ${of('E6-0').map(r => r.film.hgComMm.toFixed(2)).join('/')} mm ≥ 2.5; clamps ${of('E6-0').map(r => r.film.clampsPerSubstep.toFixed(0)).join('/')} ≤ 150/substep)` +
    (valid ? `; K ${of('E6-0').map(r => r.strata.all.K.v.toFixed(3)).join('/')} (1 ± 0.03?), M ${of('E6-0').map(r => r.strata.all.M.v.toFixed(3)).join('/')} (≤ 1.05?)` : ''))
}
for (const l of lines) console.log(`READING ${l}`)
const outDir = path.join(repoRoot, 'bench-results', 'studies'); mkdirSync(outDir, { recursive: true })
const file = path.join(outDir, `b1c-arms-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
writeFileSync(file, JSON.stringify({ prov, power, end: powerState(), arms, runs: RUNS, results, readings: lines }, null, 1))
console.log(`→ ${path.relative(repoRoot, file)}`)
