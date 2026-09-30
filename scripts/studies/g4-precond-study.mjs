#!/usr/bin/env node
// g4-precond-study.mjs — S3.6e G4 on the f64 CPU reference: do block preconditioners (the P1 family — pressure-first
// symmetric factorization, P1 and its cost knob P1J — and D3 — the exact 4×4 cell block plus a pressure V-cycle) cut the
// modeled GPU time of the Variational Stokes solve (Larionov, Batty & Bridson 2017, ACM TOG 36(4):101,
// https://doi.org/10.1145/3072959.3073628, §6.3: Jacobi-PCG) by ≥ 3× on cold/impact solves without slowing warm ones?
// Study spec (pre-registered 2026-09-29, before any number): "S3.6e G4: verdict on the three preconditioner designs, and
// the CPU study spec" §3 (session scratch s36e/g4_judge.md); the solver spec: vault fluid/realism-2026-09/
// S3.6e-variational-stokes-spec.md §4–5 (G4: "plain Jacobi first … THEN a block preconditioner"; measure on the CPU first).
//
//   node scripts/studies/g4-precond-study.mjs <scene> [arm …] [--out DIR]      (CPU only, single-threaded; no page/GPU)
//
// scenes (one invocation each, every result a JSON in --out; default $G4_OUT or <os tmp>/g4-precond-study, never the repo):
//   selftest                      S0-a: the V-cycle port vs the gate-0 fixtures (bench-results/gate0/fixtures/n64)
//   E2.5 | E3.5                   native flipRef 4 steps at 1e-6 cold, step 5 exported (the cost-study protocol) and saved;
//                                 S0-b; at E2.5 also the CONTROLS (C-J1, native step-5 = harness J, C-IBD), S0-c/d/e
//   native-W2.5 | native-W3.5 | native-W3.5-4 | native-W3.5-cold   flipRef's own unwrapped solve, 60 steps (same-tree ref)
//   W2.5 | W3.5 | W3.5-4  <arm>   the closed loop (§3.3): 60 steps, warm, the arm drives its own trajectory; J saves the
//                                 systems of steps 1, 30, 60 (the paired cold set)
//   PP1                           the page proxy's settle step 1 (J, cold): the C-PP settle band and C2's cold system
//   cold [arm …]                  every saved cold-set system solved cold from y = 0 by the arms (hits 1e-2/1e-4/1e-6)
//   decide                        C1–C5, the outcome (§3.10), the §3.9 predictions, from the JSON files
//   verify [system]               EXPLORATORY (added after the first cold numbers; no decision weight): the P1 block
//                                 structure (M⁻¹Ax = x on P with the exact pivot), λ̂(P̂⁻¹A_PP) with/without the rank-3
//                                 term, P1/P1J with s = 1
// arms: J IBD P1 P1J D3 CB BDV P1S   (P1S = P1*, the exact-pivot diagnostic; IBD only on E2.5)
//
// Deviations from the study spec, stated before the first run:
//  (1) ONE file (the task's instruction) instead of §3.1's four (driver, replica, V-cycle, arms) — same content.
//  (2) The handover memoises viscousVolumes/viscousMu (pure recomputations the wrapper has just run; §3.3 step 1): the
//      same-tree reference (native vs harness J, bit for bit per step) runs WITH the memo, so it covers it.
//  (3) A missed stored control STOPS the study (the task's rule), instead of §3.8's "refresh and continue".
//  (4) PP is built with the A5 liquid and ball (GRD melt 1100 °C, ρ 2600, iron, monolithic, dt 1/120, tolerance 1e-2 warm
//      — the page's lava scene); §3.2 names only the tank, pool and ball geometry.
// Everything the decision uses is fixed in PRE below and printed at start; a variant added after a number is labelled
// exploratory and cannot change the decision.
import { loadTsModules, REPO } from '../fluid-gates/lib/loadTs.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// ───────────────────────────────────────────── CLI, output, provenance
const argv = process.argv.slice(2)
const oi = argv.indexOf('--out')
const OUT = resolve(oi >= 0 ? argv[oi + 1] : (process.env.G4_OUT ?? join(tmpdir(), 'g4-precond-study')))
const POS = argv.filter((_, i) => oi < 0 || (i !== oi && i !== oi + 1))
const SCENE = POS[0], ARGS = POS.slice(1)
if ((OUT + '\\').toLowerCase().startsWith((REPO + '\\').toLowerCase()) || (OUT + '/').toLowerCase().startsWith((REPO + '/').toLowerCase())) throw new Error(`--out must not be inside the repository (${OUT})`)
mkdirSync(OUT, { recursive: true })
const SRC = process.env.FLUID_REF_SRC ?? 'src'
function provenance() {
  const git = args => { try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim() } catch (e) { return `ERR ${e.message.split('\n')[0]}` } }
  const flip = resolve(REPO, SRC, 'sim-ref', 'flipRef.ts')
  return { head: git(['rev-parse', 'HEAD']), diffStatSimRef: git(['diff', '--stat', '--', 'src/sim-ref']), flipRefSha256: createHash('sha256').update(readFileSync(flip)).digest('hex'),
    src: SRC, node: process.version, date: new Date().toISOString(), argv: process.argv.slice(2) }
}
const PROV = provenance()
const T0 = Date.now()
const log = (...a) => console.log(...a)
const writeJSON = (name, obj) => { const f = join(OUT, name); writeFileSync(f, JSON.stringify({ prov: PROV, ...obj }, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 1)); log(`wrote ${f}`) }
const readJSON = name => { const f = join(OUT, name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }

// ───────────────────────────────────────────── pre-registered constants (§3.4–§3.10)
const PRE = {
  tolsCold: [1e-2, 1e-4, 1e-6], capJ: 2000, capArm: 400,
  P1J_omega: 0.6, D3_theta: 1, sRule: 'P̂⁻¹ F-part × s, s = 1/λ̂max(P̂⁻¹A_PP) if λ̂max > 1.2 (30 Lanczos steps, s = 1), held for a closed-loop run',
  lanczosSteps: 30, sLimit: 1.2, P1S_innerRel2: 1e-14, P1S_innerCap: 3000, IBD_innerRelInf: 1e-13, IBD_innerCap: 200000,
  mg: { omega: 2 / 3, nuPre: 2, nuPost: 2, coarseSweeps: 60, restrict: '[1,3,3,1]/8 per axis', prolong: '8·Rᵀ', coarseLabel: 'AIR if any child AIR, else FLUID if any child FLUID, else SOLID', coarseFace: '(1/16)·Σ 4 fine nominal', halving: 'while max dim > 4 and all dims even (PoissonSolver.buildLevels)', pad: 'window at the origin, SOLID to a multiple of 8' },
  // cost model (JIE = 55 µs, one active Jacobi-PCG iteration at 64³): a = active/iter, i = idle/iter, s = setup/solve;
  // [nominal, pessimistic]
  cost: {
    J: { disp: 7, a: [1.00, 1.00], i: [0.27, 0.27], s: [0, 0] },
    CB: { disp: 8, a: [1.15, 1.20], i: [0.31, 0.32], s: [0, 0] },
    BDV: { disp: 27, a: [2.55, 2.89], i: [0.78, 0.86], s: [2.33, 2.85] },
    D3: { disp: 28, a: [2.75, 3.13], i: [0.82, 0.90], s: [2.62, 3.25] },
    P1J: { disp: 34, a: [4.02, 4.76], i: [1.05, 1.15], s: [3.89, 4.89] },
    P1: { disp: 53, a: [5.47, 6.49], i: [1.52, 1.70], s: [5.35, 6.62] },
  },
  encodeUsPerDispatch: 2.8, JIEus: 55,
  capProd: { lo: 128, hi: 800, mult: 2, add: 16, window: 32, lag: 2 },
  scaled: { floorMult: 1.6, alsoFloor: [1.2, 2.0] },
  // controls (§3.8)
  CJ1: { hits: [183, 277, 356], tol: 2 },
  CIBD: { hits: [16, 51], tol: [3, 5] },
  // a5tol_1e-2_1.json / a5tol_1e-4_1.json / a5tol_1e-2_0.json (session scratch s36e/, 2026-09-29 09:36–09:41), copied here
  CJ2: { list: [161, 28, 79, 23, 9, 34, 10, 96, 61, 99, 25, 8, 92, 34, 31, 61, 37, 26, 71, 45, 24, 55, 36, 65, 17, 73, 37, 18, 11, 19, 24, 59, 30, 9, 25, 9, 1, 77, 41, 20, 85, 6, 55, 41, 42, 20, 7, 19, 9, 17, 19, 9, 18, 33, 11, 8, 15, 16, 6, 16], U: 0.5117999099226185, Utol: 1e-5, minEqual: 57, rest: 1 },
  CJ2_4: { list: [242, 193, 175, 177, 167, 158, 161, 192, 201, 198, 150, 155, 150, 145, 161, 159, 148, 146, 147, 169, 158, 178, 110, 159, 85, 91, 150, 84, 87, 99, 93, 93, 89, 84, 94, 103, 139, 81, 84, 79, 588, 130, 81, 208, 134, 117, 228, 99, 156, 93, 89, 171, 117, 229, 111, 134, 77, 87, 142, 79], U: 0.5131084467949328, Utol: 1e-5, minEqual: 57, rest: 1 },
  CJcold: { list: [161, 160, 160, 160, 161, 158, 160, 161, 176, 176, 176, 162, 162, 162, 162, 162, 161, 161, 156, 156, 156, 156, 156, 155, 155, 160, 161, 161, 158, 154, 154, 156, 157, 157, 166, 165, 163, 161, 162, 162, 162, 165, 167, 167, 167, 167, 165, 164, 156, 164, 164, 165, 178, 194, 194, 163, 162, 162, 162, 162], U: 0.5129500547098912 },
  CPP: { settle1: [75, 145], impactMax: [50, 120], restMedian: [1, 15] },
  // decision (§3.10)
  C1: { medianNominal: 1 / 3, medianPess: 1 / 2.5, maxPess: 1 / 2 },
  C3p: { NbarJ: 8, MJ: 80, FJ: 128, breakEven: { P1: 7.5, P1J: 4.9, D3: 3.6 } },
  C5: { Uref: 0.51311, band2: 0.0030, band4: 0.0005 },
  repTie: 0.05, goD3Unless: 0.20,
  // §3.9 predictions (E2.5 cold ranges at 1e-2 / 1e-4, κ̂) and the page reductions (predicted / needed, nominal)
  predict: {
    P1: { e2: [6, 18], e4: [21, 33], kappa: '≤ 45', kappaMax: 45, breakEven: 10, page: [5.1, 6.4] },
    P1J: { e2: [8, 26], e4: [28, 45], kappa: '~36', kappaNear: 36, breakEven: 14, page: [3.5, 4.3] },
    D3: { e2: [15, 47], e4: [47, 76], kappa: '~96', kappaNear: 96, breakEven: 21, page: [1.9, 3.2] },
    CB: { e2: [56, 171], e4: [154, 246], breakEven: 53, page: [1.2, 1.14] },
    BDV: { e2: [24, 75], e4: [79, 126], kappa: '~268', kappaNear: 268, breakEven: 23, page: [1.2, 3.0] },
    kappaNearFactor: 1.5,   // "~x" held when x/1.5 ≤ κ̂ ≤ 1.5x (this operationalisation fixed before the first run)
    P1S: { e2Above: 25, kappaAbove: 40 },
  },
}
const DX = 3.63 / 64, DT = 1 / 120, G = 9.80665
const COLD_SYSTEMS = ['E2.5', 'E3.5', 'W2.5-s1', 'W2.5-s30', 'W2.5-s60', 'W3.5-s1', 'W3.5-s30', 'W3.5-s60']
const ALL_ARMS = ['J', 'IBD', 'P1', 'P1J', 'D3', 'CB', 'BDV', 'P1S']

// ───────────────────────────────────────────── small numerics
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function randn(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()) }
const infNorm = v => { let m = 0; for (let r = 0; r < v.length; r++) m = Math.max(m, Math.abs(v[r])); return m }   // flipRef's
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2 }
/** Extreme eigenvalues of the symmetric tridiagonal (a diag, b off-diag) by Sturm-count bisection. */
function tridiagExtremes(a, b) {
  const m = a.length
  if (m === 0) return { min: NaN, max: NaN }
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < m; i++) { const r = (i > 0 ? Math.abs(b[i - 1]) : 0) + (i < m - 1 ? Math.abs(b[i]) : 0); lo = Math.min(lo, a[i] - r); hi = Math.max(hi, a[i] + r) }
  const below = x => { let c = 0, q = 1; for (let i = 0; i < m; i++) { q = a[i] - x - (i > 0 ? b[i - 1] * b[i - 1] / q : 0); if (q === 0) q = -1e-300; if (q < 0) c++ } return c }
  const kth = k => { let l = lo, h = hi; for (let it = 0; it < 200; it++) { const mid = 0.5 * (l + h); if (below(mid) > k) h = mid; else l = mid } return 0.5 * (l + h) }
  return { min: kth(0), max: kth(m - 1) }
}
/** Lanczos tridiagonal from PCG's α_k, β_k (Saad 2003 §6.7.3; the section number UNVERIFIED): T_kk = 1/α_k + β_{k−1}/α_{k−1},
 *  T_k,k+1 = √β_k/α_k. Returns its extreme Ritz values and κ̂. */
function lanczosKappa(al, be) {
  const m = al.length
  if (m < 2) return { lmin: NaN, lmax: NaN, kappa: NaN, steps: m }
  const a = new Float64Array(m), b = new Float64Array(m - 1)
  for (let k = 0; k < m; k++) a[k] = 1 / al[k] + (k > 0 ? be[k - 1] / al[k - 1] : 0)
  for (let k = 0; k < m - 1; k++) b[k] = Math.sqrt(Math.max(0, be[k])) / al[k]
  const e = tridiagExtremes(a, b)
  return { lmin: e.min, lmax: e.max, kappa: e.max / e.min, steps: m }
}

// ───────────────────────────────────────────── the V-cycle: a JS f64 port of bench/offline/poisson_ref.py VarMG
// (McAdams, Sifakis & Teran 2010, https://www.math.ucdavis.edu/~jteran/papers/MST10.pdf §3.2: damped Jacobi ω = 2/3,
// 2 + 2 sweeps, R = [1,3,3,1]/8 per axis, P = 8Rᵀ, coarse cell AIR if any child is, coarsest level 60 sweeps from 0),
// generalised to non-cubic grids with PoissonSolver.buildLevels' halving rule. Arrays are interior-only, x fastest.
const AIRL = 0, FLUIDL = 1, SOLIDL = 2
class VarMG {
  constructor(dims, lab, e, extra) {
    this.omega = 2 / 3; this.nu = 2; this.ci = 60
    this.levels = []
    let d = dims.slice(), L = lab, E = e, X = extra
    for (;;) {
      this.levels.push(this.level(d, L, E, X, this.levels.length))
      if (Math.max(...d) > 4 && d.every(v => v % 2 === 0)) { const c = coarsen(d, L, E); d = c.dims; L = c.lab; E = c.e; X = null } else break
    }
  }
  level(dims, lab, e, extra, l) {
    const [n0, n1, n2] = dims, N = n0 * n1 * n2, s1 = n0, s2 = n0 * n1
    const Fl = []
    for (let id = 0; id < N; id++) if (lab[id] === FLUIDL) Fl.push(id)
    const nF = Fl.length, nb = new Int32Array(6 * nF).fill(-1), cf = new Float64Array(6 * nF), diag = new Float64Array(N).fill(1)
    for (let m = 0; m < nF; m++) {
      const id = Fl[m], i = id % n0, j = ((id - i) / n0) % n1, k = (id - i - n0 * j) / s2
      // SHIFTS order of poisson_ref: +x, −x, +y, −y, +z, −z; the plus face of a cell is the minus face of the next
      const nbs = [i + 1 < n0 ? id + 1 : -1, i > 0 ? id - 1 : -1, j + 1 < n1 ? id + s1 : -1, j > 0 ? id - s1 : -1, k + 1 < n2 ? id + s2 : -1, k > 0 ? id - s2 : -1]
      const cs = [i + 1 < n0 ? e[0][id + 1] : 0, e[0][id], j + 1 < n1 ? e[1][id + s1] : 0, e[1][id], k + 1 < n2 ? e[2][id + s2] : 0, e[2][id]]
      let dg = 0
      for (let q = 0; q < 6; q++) {
        const t = nbs[q] < 0 ? SOLIDL : lab[nbs[q]]
        dg += t !== SOLIDL ? cs[q] : 0
        if (t === FLUIDL) { nb[6 * m + q] = nbs[q]; cf[6 * m + q] = cs[q] }
      }
      if (extra) dg += extra[id]
      if (!(dg > 0)) throw new Error(`VarMG: FLUID cell with non-positive diagonal ${dg} at level ${l} cell (${i}, ${j}, ${k}) of ${dims.join('×')}`)
      diag[id] = dg
    }
    return { dims, N, lab, F: Int32Array.from(Fl), nb, cf, diag, u: new Float64Array(N), tmp: new Float64Array(N), r: new Float64Array(N), b: new Float64Array(N), p: new Float64Array(N) }
  }
  A(Lv, u, out) {
    const { F, nb, cf, diag } = Lv
    for (let m = 0; m < F.length; m++) {
      const id = F[m]
      let off = 0
      for (let q = 6 * m; q < 6 * m + 6; q++) { const n = nb[q]; if (n >= 0) off += cf[q] * u[n] }
      out[id] = diag[id] * u[id] - off
    }
  }
  smooth(Lv, u, b, iters) {
    const { F, diag, tmp } = Lv, w = this.omega
    for (let it = 0; it < iters; it++) {
      this.A(Lv, u, tmp)
      for (let m = 0; m < F.length; m++) { const id = F[m]; u[id] = u[id] + w * (b[id] - tmp[id]) / diag[id] }
    }
  }
  /** One V-cycle M·b from a zero guess; returns level 0's buffer (copy it before the next call). */
  vcycle(b, l = 0) {
    const Lv = this.levels[l], u = Lv.u
    u.fill(0)
    if (l === this.levels.length - 1) { this.smooth(Lv, u, b, this.ci); return u }
    this.smooth(Lv, u, b, this.nu)
    this.A(Lv, u, Lv.tmp)
    const r = Lv.r
    r.fill(0)
    for (let m = 0; m < Lv.F.length; m++) { const id = Lv.F[m]; r[id] = b[id] - Lv.tmp[id] }
    const C = this.levels[l + 1]
    restrict3(r, Lv.dims, C.b)
    const bc = C.b, keep = C.tmp
    keep.fill(0)
    for (let m = 0; m < C.F.length; m++) keep[C.F[m]] = bc[C.F[m]]
    bc.set(keep)
    const ec = this.vcycle(bc, l + 1)
    prolong3(ec, C.dims, Lv.p)
    for (let m = 0; m < Lv.F.length; m++) { const id = Lv.F[m]; u[id] = u[id] + Lv.p[id] }
    this.smooth(Lv, u, b, this.nu)
    return u
  }
}
function coarsen(dims, lab, e) {
  const [n0, n1, n2] = dims, m0 = n0 / 2, m1 = n1 / 2, m2 = n2 / 2, M = m0 * m1 * m2
  const cl = new Uint8Array(M), ce = [new Float64Array(M), new Float64Array(M), new Float64Array(M)]
  const f = (i, j, k) => i + n0 * (j + n1 * k)
  for (let K = 0; K < m2; K++) for (let J = 0; J < m1; J++) for (let I = 0; I < m0; I++) {
    let anyAir = false, anyFl = false
    for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) { const t = lab[f(2 * I + di, 2 * J + dj, 2 * K + dk)]; if (t === AIRL) anyAir = true; if (t === FLUIDL) anyFl = true }
    const c = I + m0 * (J + m1 * K)
    cl[c] = anyAir ? AIRL : anyFl ? FLUIDL : SOLIDL
    ce[0][c] = (e[0][f(2 * I, 2 * J, 2 * K)] + e[0][f(2 * I, 2 * J + 1, 2 * K)] + e[0][f(2 * I, 2 * J, 2 * K + 1)] + e[0][f(2 * I, 2 * J + 1, 2 * K + 1)]) / 16
    ce[1][c] = (e[1][f(2 * I, 2 * J, 2 * K)] + e[1][f(2 * I + 1, 2 * J, 2 * K)] + e[1][f(2 * I, 2 * J, 2 * K + 1)] + e[1][f(2 * I + 1, 2 * J, 2 * K + 1)]) / 16
    ce[2][c] = (e[2][f(2 * I, 2 * J, 2 * K)] + e[2][f(2 * I + 1, 2 * J, 2 * K)] + e[2][f(2 * I, 2 * J + 1, 2 * K)] + e[2][f(2 * I + 1, 2 * J + 1, 2 * K)]) / 16
  }
  return { dims: [m0, m1, m2], lab: cl, e: ce }
}
/** R = Pᵀ/8: per axis c[I] = 0.375 f[2I] + 0.375 f[2I+1] + 0.125 f[2I−1] + 0.125 f[2I+2] (zero outside), axes x, y, z. */
function restrict3(f, dims, out) {
  let cur = f, d = dims.slice()
  for (let ax = 0; ax < 3; ax++) {
    const n = d[ax], m = n / 2, nd = d.slice(); nd[ax] = m
    const o = ax === 2 ? out : new Float64Array(nd[0] * nd[1] * nd[2])
    const sIn = ax === 0 ? 1 : ax === 1 ? d[0] : d[0] * d[1], sOut = ax === 0 ? 1 : ax === 1 ? nd[0] : nd[0] * nd[1]
    const [a0, a1] = [0, 1, 2].filter(x => x !== ax)
    const sa0In = a0 === 0 ? 1 : a0 === 1 ? d[0] : d[0] * d[1], sa1In = a1 === 0 ? 1 : a1 === 1 ? d[0] : d[0] * d[1]
    const sa0Out = a0 === 0 ? 1 : a0 === 1 ? nd[0] : nd[0] * nd[1], sa1Out = a1 === 0 ? 1 : a1 === 1 ? nd[0] : nd[0] * nd[1]
    for (let q1 = 0; q1 < d[a1]; q1++) for (let q0 = 0; q0 < d[a0]; q0++) {
      const bi = q0 * sa0In + q1 * sa1In, bo = q0 * sa0Out + q1 * sa1Out
      for (let I = 0; I < m; I++) {
        const e = cur[bi + 2 * I * sIn], od = cur[bi + (2 * I + 1) * sIn]
        const op = I > 0 ? cur[bi + (2 * I - 1) * sIn] : 0, en = 2 * I + 2 < n ? cur[bi + (2 * I + 2) * sIn] : 0
        o[bo + I * sOut] = 0.375 * e + 0.375 * od + 0.125 * op + 0.125 * en
      }
    }
    cur = o; d = nd
  }
}
/** Cell-centred trilinear prolongation: per axis fine[2I] = 0.75 c[I] + 0.25 c[I−1], fine[2I+1] = 0.75 c[I] + 0.25 c[I+1]. */
function prolong3(c, dims, out) {
  let cur = c, d = dims.slice()
  for (let ax = 0; ax < 3; ax++) {
    const m = d[ax], nd = d.slice(); nd[ax] = 2 * m
    const o = ax === 2 ? out : new Float64Array(nd[0] * nd[1] * nd[2])
    const sIn = ax === 0 ? 1 : ax === 1 ? d[0] : d[0] * d[1], sOut = ax === 0 ? 1 : ax === 1 ? nd[0] : nd[0] * nd[1]
    const [a0, a1] = [0, 1, 2].filter(x => x !== ax)
    const sa0In = a0 === 0 ? 1 : a0 === 1 ? d[0] : d[0] * d[1], sa1In = a1 === 0 ? 1 : a1 === 1 ? d[0] : d[0] * d[1]
    const sa0Out = a0 === 0 ? 1 : a0 === 1 ? nd[0] : nd[0] * nd[1], sa1Out = a1 === 0 ? 1 : a1 === 1 ? nd[0] : nd[0] * nd[1]
    for (let q1 = 0; q1 < d[a1]; q1++) for (let q0 = 0; q0 < d[a0]; q0++) {
      const bi = q0 * sa0In + q1 * sa1In, bo = q0 * sa0Out + q1 * sa1Out
      for (let I = 0; I < m; I++) {
        const cc = cur[bi + I * sIn], cm = I > 0 ? cur[bi + (I - 1) * sIn] : 0, cp = I + 1 < m ? cur[bi + (I + 1) * sIn] : 0
        o[bo + 2 * I * sOut] = 0.75 * cc + 0.25 * cm
        o[bo + (2 * I + 1) * sOut] = 0.75 * cc + 0.25 * cp
      }
    }
    cur = o; d = nd
  }
}

// ───────────────────────────────────────────── scene selftest: S0-a
function selftest() {
  const dir = join(REPO, 'bench-results', 'gate0', 'fixtures', 'n64'), n = 64, P = n + 2
  const f32 = name => { const b = readFileSync(join(dir, name)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  const interior = (arr, comp = 1, c = 0) => { const o = new Float64Array(n * n * n); for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) o[i + n * (j + n * k)] = arr[comp * ((i + 1) + P * ((j + 1) + P * (k + 1))) + c]; return o }
  const out = []
  for (const [tag, dom, var_] of [['dam_break', 'dam_break', false], ['tank_half_ball', 'tank_half_ball', false], ['tank_half_step', 'tank_half_step', false], ['tank_half_ball_var_ball', 'tank_half_ball', true]]) {
    const lb = readFileSync(join(dir, `labels_${dom}.u8`)), lab = new Uint8Array(n * n * n)
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) lab[i + n * (j + n * k)] = lb[(i + 1) + P * ((j + 1) + P * (k + 1))]
    let e, extra = null
    if (var_) { const fc = f32('fcoef_var_ball.f32'); e = [0, 1, 2].map(a => interior(fc, 4, a)); extra = interior(fc, 4, 3) }
    else e = [0, 1, 2].map(() => new Float64Array(n * n * n).fill(1))
    const r = interior(f32(`unit_${tag}_r.f32`)), ref = interior(f32(`unit_${tag}_Mr_f64.f32`))
    const t = performance.now(), mg = new VarMG([n, n, n], lab, e, extra), z = Float64Array.from(mg.vcycle(r)), ms = performance.now() - t
    let dmax = 0, rmax = 0
    for (let q = 0; q < z.length; q++) { dmax = Math.max(dmax, Math.abs(z[q] - ref[q])); rmax = Math.max(rmax, Math.abs(ref[q])) }
    const rel = dmax / rmax, ok = rel <= 4 * 2 ** -23
    out.push({ fixture: tag, levels: mg.levels.map(L => L.dims.join('×')), relMaxDiff: rel, tol: 4 * 2 ** -23, ok, ms })
    log(`S0-a ${ok ? 'PASS' : 'FAIL'} V-cycle vs unit_${tag}_Mr_f64: max|Δ|/max|Mr| ${rel.toExponential(2)} (≤ ${(4 * 2 ** -23).toExponential(2)}), levels ${mg.levels.map(L => L.dims.join('×')).join(' → ')}, ${ms.toFixed(0)} ms`)
  }
  const pass = out.every(o => o.ok)
  writeJSON('selftest.json', { scene: 'selftest', S0a: out, pass })
  return pass
}
if (SCENE === 'selftest') { printPre(); const ok = selftest(); log(`\nselftest ${ok ? 'PASS' : 'FAIL'} (${((Date.now() - T0) / 1000).toFixed(0)} s)`); process.exit(ok ? 0 : 1) }

// ───────────────────────────────────────────── load the reference (only the scenes that simulate)
const needSim = !['decide', 'cold', 'verify'].includes(SCENE)
const MOD = needSim ? await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts`, two: `${SRC}/sim-ref/twoLayer.ts` }) : null
const GridLayout = MOD?.gridLayout.GridLayout, FaceType = MOD?.gridLayout.FaceType, FlipRef = MOD?.flipRef.FlipRef
const fillMaterials = MOD?.two.fillMaterials, fillRng = MOD?.two.mulberry32
const MU = MOD ? MOD.mat.vftViscosity(MOD.mat.LAVA_GRD_PRESET, 1100) : NaN, RHOM = 2600, RHO_FE = MOD ? MOD.mat.SOLID_REFERENCE.iron.solidDensityKgM3 : NaN

function printPre() {
  log(`g4-precond-study ${SCENE} ${ARGS.join(' ')}  → ${OUT}`)
  log(`provenance: HEAD ${PROV.head}; git diff --stat -- src/sim-ref: "${PROV.diffStatSimRef}"; flipRef.ts sha256 ${PROV.flipRefSha256}; src ${SRC}; node ${PROV.node}`)
  log(`PRE-REGISTERED (study spec §3.4–§3.10): ${JSON.stringify(PRE)}`)
}

// ───────────────────────────────────────────── scenes (§3.2)
function cutBall(p, c, R, mu) {   // s36e-ref's, verbatim
  const keep = []
  for (let q = 0; q < p.n; q++) if (Math.hypot(p.pos[3 * q] - c[0], p.pos[3 * q + 1] - c[1], p.pos[3 * q + 2] - c[2]) >= R) keep.push(q)
  const P = { ...p, n: keep.length, pos: new Float64Array(3 * keep.length), vel: new Float64Array(3 * keep.length), mass: new Float64Array(keep.length), c: [0, 1, 2].map(() => new Float64Array(3 * keep.length)), mu: new Float64Array(keep.length).fill(mu) }
  keep.forEach((q, i) => { P.pos.set(p.pos.subarray(3 * q, 3 * q + 3), 3 * i); P.mass[i] = p.mass[q] })
  return P
}
function simOpts(tol, warm) {
  return { gravity: [0, -G, 0], density: RHOM, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5,
    sphereCoupling: 'monolithic', sphereDensity: RHO_FE, viscosity: 'force', viscosityDefault: MU, viscosityScheme: 'stokes', stokesTolerance: tol, stokesWarmStart: warm, levelSetSphere: 'mirror' }
}
/** The A5 scene (s36e-ref A5S = the cost study): iron in the 1100 °C GRD melt, the tank scaled with R. */
function buildA5(Rc, tol, warm) {
  const R = Rc * DX, n = Math.round(24 * Rc / 3.5), ny = Math.round(30 * Rc / 3.5), f = Rc / 3.5
  const c = [n / 2 * DX, (ny - 2 * f - 2 * Rc - 3 * f) * DX, n / 2 * DX]
  const L = new GridLayout({ nx: n, ny, nz: n, dx: DX })
  const sim = new FlipRef(L, simOpts(tol, warm))
  const P = cutBall(fillMaterials(n, Math.round(ny - 2 * f), n, DX, fillRng(35), () => [RHOM, 0]).p, c, R, MU)
  sim.sphere = { center: [...c], radius: R, velocity: [0, 0, 0] }
  return { sim, P, Us: 2 / 9 * (RHO_FE - RHOM) * G * R * R / MU, tank: [n, ny, n] }
}
/** The page proxy: 64 × 14 × 64, the page's 163 840 particles in a 5-cell pool; settle without the ball. */
function buildPP() {
  const L = new GridLayout({ nx: 64, ny: 14, nz: 64, dx: DX })
  const sim = new FlipRef(L, simOpts(1e-2, true))
  const { p } = fillMaterials(64, 5, 64, DX, fillRng(71), () => [RHOM, 0])
  p.mu = new Float64Array(p.n).fill(MU)
  sim.sphere = null
  return { sim, P: p, tank: [64, 14, 64] }
}

// ───────────────────────────────────────────── the assembly replica (§3.3): FlipRef.stokesSolve's assembly verbatim
// (src/sim-ref/flipRef.ts ~1097–1233: the face loop, refFace, addRow and its drop rules, the row loops, Kinv, KVinv,
// rhs, diag), reading the sim's fields after viscousVolumes()/viscousMu(); it also keeps rowAt, the face identities
// and each p row's fate. opt.noFreeDrop: the negative control S0-e(1) (a free face is skipped, not dropped).
const AXES = [0, 1, 2]
function assemble(sim, dt, opt = {}) {
  const L = sim.layout, h = L.dx
  const TB = sim.viscousTestBC, periodicX = !!TB?.periodicX, wMin = sim.stokesFaceMin
  const inRange = (a, c) => { const [lo, hi] = L.faceRange(a); return c[0] >= lo[0] && c[1] >= lo[1] && c[2] >= lo[2] && c[0] <= hi[0] && c[1] <= hi[1] && c[2] <= hi[2] }
  const wrap = c => { if (!periodicX) return c; const m = [...c]; m[0] = ((m[0] % L.nx) + L.nx) % L.nx; return m }
  const ghostOf = (a, c) => {
    for (const b of AXES) {
      if (b === a || (b === 0 && periodicX)) continue
      const n = [L.nx, L.ny, L.nz][b]
      if (c[b] === -1 || c[b] === n) { const m = [...c]; m[b] = c[b] === -1 ? 0 : n - 1; return { m, wall: ['x', 'y', 'z'][b] + (c[b] === -1 ? '-' : '+') } }
    }
    return null
  }
  const wallFace = (a, s) => sim.faceType[a][s] === FaceType.SOLID && !(periodicX && a === 0)
  const Sph = sim.sphere, mono = sim.monolithic(), Sf = sim.solidFraction
  if (Sph && sim.levelSetSphere !== 'mirror') throw new Error("replica: a ball needs levelSetSphere 'mirror'")
  const V0 = Sph ? [Sph.velocity[0], Sph.velocity[1], Sph.velocity[2]] : [0, 0, 0]
  const colOf = AXES.map(() => new Int32Array(L.size).fill(-1))
  const faces = []
  for (const a of AXES) {
    const [lo, hi] = L.faceRange(a)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      if (i < 0 || j < 0 || k < 0 || (periodicX && a === 0 && i === L.nx)) continue
      const c = [i, j, k]
      if (ghostOf(a, c)) continue
      const s = L.idx(i, j, k)
      if (wallFace(a, s) || Sf[a][s] >= 1 || sim.volFace[a][s] * (1 - Sf[a][s]) < wMin) continue
      colOf[a][s] = faces.length
      faces.push({ a, s })
    }
  }
  const NONE = { col: -1, g: 0, vA: -1, gv: 0, konst: 0, free: false }
  const refFace = (a, c0) => {
    const c = wrap(c0)
    const g = ghostOf(a, c)
    if (g) {
      const bc = TB?.walls?.[g.wall]
      const slip = bc?.slip ?? sim.viscousWalls, U = bc?.velocity?.[a] ?? 0
      const r = refFace(a, g.m)
      return slip === 'no-slip' ? { col: r.col, g: -r.g, vA: r.vA, gv: -r.gv, konst: 2 * U - r.konst, free: r.free } : r
    }
    if (!inRange(a, c)) return NONE
    const s = L.idx(c[0], c[1], c[2])
    if (wallFace(a, s)) return NONE
    const S = Sf[a][s], col = colOf[a][s]
    if (col >= 0) return { col, g: 1 - S, vA: S > 0 ? a : -1, gv: S, konst: 0, free: false }
    if (S > 0 && 1 - S < wMin) return { col: -1, g: 0, vA: a, gv: 1, konst: 0, free: false }
    return { ...NONE, free: true }
  }
  const rowCols = [], rowG = [], rowV = [], rowK = [], rowC = [], rowKind = [], rowAt = []
  const pFate = new Uint8Array(L.size), pCols = new Int32Array(L.size)   // p rows: 0 no row (W ≤ 0), 1 live, 2 free, 3 no content
  let dropped = 0, fate = 1
  const addRow = (terms, cDiag, kind, at) => {
    const cols = [], g = [], vg = [0, 0, 0]
    let konst = 0
    fate = 1
    for (const [a, c, coef] of terms) {
      const r = refFace(a, c)
      if (r.free) { if (opt.noFreeDrop) continue; dropped++; fate = 2; return }
      konst += r.konst * coef
      if (r.vA >= 0) vg[r.vA] += r.gv * coef
      if (r.col < 0) continue
      const i = cols.indexOf(r.col)
      if (i >= 0) g[i] += r.g * coef; else { cols.push(r.col); g.push(r.g * coef) }
    }
    const hasV = mono && (vg[0] !== 0 || vg[1] !== 0 || vg[2] !== 0)
    if (cols.length === 0 && !hasV && cDiag === 0) { dropped++; fate = 3; return }
    if (!mono) { konst += vg[0] * V0[0] + vg[1] * V0[1] + vg[2] * V0[2] }
    rowCols.push(cols); rowG.push(g); rowV.push(vg); rowK.push(konst); rowC.push(cDiag); rowKind.push(kind); rowAt.push(at)
    if (kind === 0) pCols[at] = cols.length
  }
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
    const cs = L.idx(i, j, k), W = sim.volCell[cs]
    if (W <= 0) continue
    const up = a => { const c = [i, j, k]; c[a] += 1; return c }
    addRow(AXES.flatMap(a => [[a, [i, j, k], W / h], [a, up(a), -W / h]]), 0, 0, cs)
    pFate[cs] = fate
    const WF = 1 - sim.cellSolidFraction[cs]
    for (const a of AXES) addRow([[a, up(a), W / h], [a, [i, j, k], -W / h]], W * WF / (2 * sim.muCell[cs]), 1 + a, cs)
  }
  for (const e of AXES) {
    const [a, b] = AXES.filter(x => x !== e)
    const n = [L.nx + (e === 0 ? 0 : 1), L.ny + (e === 1 ? 0 : 1), L.nz + (e === 2 ? 0 : 1)]
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
      if (periodicX && e !== 0 && i === L.nx) continue
      const es = L.idx(i, j, k), W = sim.volEdge[e][es]
      if (W <= 0) continue
      const c = [i, j, k], cmb = [...c], cma = [...c]; cmb[b] -= 1; cma[a] -= 1
      const WF = Sph ? 1 - sim.sphereSolidBox((i + (e === 0 ? 0.5 : 0)) * h, (j + (e === 1 ? 0.5 : 0)) * h, (k + (e === 2 ? 0.5 : 0)) * h) : 1
      addRow([[a, c, W / h], [a, cmb, -W / h], [b, c, W / h], [b, cma, -W / h]], W * WF / sim.muEdge[e][es], 4 + e, es)
    }
  }
  const nF = faces.length, nR = rowC.length
  const Kinv = new Float64Array(nF), ustar = new Float64Array(nF)
  for (let f = 0; f < nF; f++) { const F = faces[f]; Kinv[f] = dt / (sim.rhoFace[F.a][F.s] * sim.volFace[F.a][F.s] * (1 - Sf[F.a][F.s])); ustar[f] = sim.u[F.a][F.s] }
  const KVinv = mono ? dt * h ** 3 / (sim.sphereDensity * sim.sphereVolumeJ()) : 0
  const rhs = new Float64Array(nR), diag = new Float64Array(nR)
  for (let r = 0; r < nR; r++) {
    const cols = rowCols[r], g = rowG[r], vg = rowV[r]
    let s = rowK[r], d = rowC[r] + (vg[0] * vg[0] + vg[1] * vg[1] + vg[2] * vg[2]) * KVinv
    if (mono) s += vg[0] * V0[0] + vg[1] * V0[1] + vg[2] * V0[2]
    for (let t = 0; t < cols.length; t++) { s += g[t] * ustar[cols[t]]; d += g[t] * g[t] * Kinv[cols[t]] }
    rhs[r] = s; diag[r] = d
  }
  return { rowCols, rowG, rowV, rowC, rowKind, rowAt, faces, colOf, Kinv, KVinv, rhs, diag, nF, nR, dropped, pFate, pCols, mono }
}
/** S0-b: the replica against flipRef's export — structure, g, vg, C, Kinv, KVinv bit for bit; rhs and diag ≤ 1e-13 relative. */
function compareExport(R, E) {
  if (!E) return { ok: false, why: 'no export' }
  if (E.rowC.length !== R.rowC.length) return { ok: false, why: `rows ${E.rowC.length} vs replica ${R.rowC.length}` }
  if (E.Kinv.length !== R.Kinv.length) return { ok: false, why: `faces ${E.Kinv.length} vs replica ${R.Kinv.length}` }
  for (let r = 0; r < R.rowC.length; r++) {
    const a = E.rowCols[r], b = R.rowCols[r]
    if (a.length !== b.length) return { ok: false, why: `row ${r}: ${a.length} vs ${b.length} columns` }
    for (let t = 0; t < a.length; t++) if (a[t] !== b[t] || !Object.is(E.rowG[r][t], R.rowG[r][t])) return { ok: false, why: `row ${r} term ${t}` }
    for (let q = 0; q < 3; q++) if (!Object.is(E.rowV[r][q], R.rowV[r][q])) return { ok: false, why: `row ${r} vg` }
    if (!Object.is(E.rowC[r], R.rowC[r]) || E.rowKind[r] !== R.rowKind[r]) return { ok: false, why: `row ${r} C/kind` }
  }
  for (let f = 0; f < R.Kinv.length; f++) if (!Object.is(E.Kinv[f], R.Kinv[f])) return { ok: false, why: `Kinv ${f}` }
  if (!Object.is(E.KVinv, R.KVinv)) return { ok: false, why: 'KVinv' }
  let rel = 0
  for (let r = 0; r < R.rowC.length; r++) for (const [x, y] of [[E.rhs[r], R.rhs[r]], [E.diag[r], R.diag[r]]]) { const m = Math.max(Math.abs(x), Math.abs(y)); if (m > 0) rel = Math.max(rel, Math.abs(x - y) / m) }
  return { ok: rel <= 1e-13, why: rel <= 1e-13 ? '' : `rhs/diag rel ${rel}`, rel }
}

// ───────────────────────────────────────────── the typed system (+ what the arms need) and its operators
function toSystem(R, sim, meta = {}) {
  const L = sim.layout, h = L.dx, nR = R.nR, nF = R.nF, nx = L.nx, ny = L.ny, nz = L.nz, NW = nx * ny * nz
  let nnz = 0
  for (let r = 0; r < nR; r++) nnz += R.rowCols[r].length
  const S = { nR, nF, KVinv: R.KVinv, dims: [nx, ny, nz], meta, rowPtr: new Int32Array(nR + 1), col: new Int32Array(nnz), g: new Float64Array(nnz),
    vg0: new Float64Array(nR), vg1: new Float64Array(nR), vg2: new Float64Array(nR), C: new Float64Array(nR), kind: new Uint8Array(nR), at: new Int32Array(nR),
    Kinv: R.Kinv.slice(), rhs: R.rhs.slice(), diag: R.diag.slice(), rowW: new Float64Array(nR), rowWf: new Float64Array(nR), shell: new Uint8Array(nR),
    rowCell: new Int32Array(nR).fill(-1), cellLabel: new Uint8Array(NW).fill(SOLIDL), fc0: new Float64Array(NW), fc1: new Float64Array(NW), fc2: new Float64Array(NW) }
  const winOf = new Int32Array(L.size).fill(-1)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) winOf[L.idx(i, j, k)] = i + nx * (j + ny * k)
  let t = 0
  for (let r = 0; r < nR; r++) {
    S.rowPtr[r] = t
    const cols = R.rowCols[r], g = R.rowG[r]
    let wf = Infinity
    for (let q = 0; q < cols.length; q++) { S.col[t] = cols[q]; S.g[t] = g[q]; t++; const F = R.faces[cols[q]]; wf = Math.min(wf, sim.volFace[F.a][F.s] * (1 - sim.solidFraction[F.a][F.s])) }
    const vg = R.rowV[r]
    S.vg0[r] = vg[0]; S.vg1[r] = vg[1]; S.vg2[r] = vg[2]; S.C[r] = R.rowC[r]; S.kind[r] = R.rowKind[r]; S.at[r] = R.rowAt[r]
    S.rowW[r] = R.rowKind[r] < 4 ? sim.volCell[R.rowAt[r]] : sim.volEdge[R.rowKind[r] - 4][R.rowAt[r]]
    S.rowWf[r] = cols.length ? wf : NaN
    S.shell[r] = vg[0] !== 0 || vg[1] !== 0 || vg[2] !== 0 ? 1 : 0
    if (R.rowKind[r] < 4) S.rowCell[r] = winOf[R.rowAt[r]]
  }
  S.rowPtr[nR] = t
  // the MG's level 0 on the window (§3.5): labels (D1's rule) and the minus-a face coefficient (1 − S_f)²·K_f⁻¹/h²
  const fc = [S.fc0, S.fc1, S.fc2]
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const s = L.idx(i, j, k), w = i + nx * (j + ny * k), fateP = R.pFate[s]
    S.cellLabel[w] = fateP === 1 ? (R.pCols[s] > 0 ? FLUIDL : SOLIDL) : fateP === 0 || fateP === 2 ? AIRL : SOLIDL
    for (const a of AXES) { const c = R.colOf[a][s]; if (c >= 0) { const om = 1 - sim.solidFraction[a][s]; fc[a][w] = om * om * R.Kinv[c] / (h * h) } }
  }
  return S
}
const SYS_FIELDS = ['rowPtr', 'col', 'g', 'vg0', 'vg1', 'vg2', 'C', 'kind', 'at', 'Kinv', 'rhs', 'diag', 'rowW', 'rowWf', 'shell', 'rowCell', 'cellLabel', 'fc0', 'fc1', 'fc2']
function saveSystem(name, S) {
  const head = { name, nR: S.nR, nF: S.nF, KVinv: S.KVinv, dims: S.dims, meta: S.meta, fields: [] }
  const parts = []
  let off = 0
  for (const f of SYS_FIELDS) { const a = S[f], b = Buffer.from(a.buffer, a.byteOffset, a.byteLength); head.fields.push({ f, type: a.constructor.name, len: a.length, off }); parts.push(b); off += b.length }
  const hj = Buffer.from(JSON.stringify(head)), hl = Buffer.alloc(4)
  hl.writeUInt32LE(hj.length)
  writeFileSync(join(OUT, `sys-${name}.bin`), Buffer.concat([hl, hj, ...parts]))
}
function loadSystem(name) {
  const f = join(OUT, `sys-${name}.bin`)
  if (!existsSync(f)) return null
  const buf = readFileSync(f), hl = buf.readUInt32LE(0), head = JSON.parse(buf.subarray(4, 4 + hl).toString()), base = 4 + hl
  const S = { nR: head.nR, nF: head.nF, KVinv: head.KVinv, dims: head.dims, meta: head.meta }
  const T = { Int32Array, Float64Array, Uint8Array }
  for (const fd of head.fields) { const C = T[fd.type], n = fd.len * C.BYTES_PER_ELEMENT, ab = new ArrayBuffer(n); new Uint8Array(ab).set(buf.subarray(base + fd.off, base + fd.off + n)); S[fd.f] = new C(ab) }
  return S
}
/** A·y exactly as FlipRef.stokesSolve forms it (transpose over rows skipping zeros, ×K⁻¹, then per-row gather) — same
 *  operations in the same order, so the J arm is bit-identical to flipRef; masked variants (src rows → dst rows) for the
 *  block products A_TP·u, A_PT·v, A_PP·x. */
function makeOps(S) {
  const { nR, nF, rowPtr, col, g, vg0, vg1, vg2, C, Kinv, KVinv } = S
  const bt = new Float64Array(nF)
  const P = [], T = []
  for (let r = 0; r < nR; r++) (S.kind[r] === 0 ? P : T).push(r)
  const ops = { P: Int32Array.from(P), T: Int32Array.from(T), matvecs: 0 }
  ops.apply = (y, out) => {
    ops.matvecs++
    bt.fill(0)
    let b0 = 0, b1 = 0, b2 = 0
    for (let r = 0; r < nR; r++) {
      const v = y[r]; if (v === 0) continue
      for (let t = rowPtr[r]; t < rowPtr[r + 1]; t++) bt[col[t]] += g[t] * v
      b0 += vg0[r] * v; b1 += vg1[r] * v; b2 += vg2[r] * v
    }
    for (let f = 0; f < nF; f++) bt[f] *= Kinv[f]
    const w0 = b0 * KVinv, w1 = b1 * KVinv, w2 = b2 * KVinv
    for (let r = 0; r < nR; r++) {
      let s = C[r] * y[r] + vg0[r] * w0 + vg1[r] * w1 + vg2[r] * w2
      for (let t = rowPtr[r]; t < rowPtr[r + 1]; t++) s += g[t] * bt[col[t]]
      out[r] = s
    }
  }
  /** out[dst] = (A·ỹ)[dst] with ỹ = y on src, 0 elsewhere (C·ỹ only where dst ∈ src: pass same = true). */
  ops.applyMasked = (y, out, src, dst, same) => {
    bt.fill(0)
    let b0 = 0, b1 = 0, b2 = 0
    for (let m = 0; m < src.length; m++) {
      const r = src[m], v = y[r]; if (v === 0) continue
      for (let t = rowPtr[r]; t < rowPtr[r + 1]; t++) bt[col[t]] += g[t] * v
      b0 += vg0[r] * v; b1 += vg1[r] * v; b2 += vg2[r] * v
    }
    for (let f = 0; f < nF; f++) bt[f] *= Kinv[f]
    const w0 = b0 * KVinv, w1 = b1 * KVinv, w2 = b2 * KVinv
    for (let m = 0; m < dst.length; m++) {
      const r = dst[m]
      let s = (same ? C[r] * y[r] : 0) + vg0[r] * w0 + vg1[r] * w1 + vg2[r] * w2
      for (let t = rowPtr[r]; t < rowPtr[r + 1]; t++) s += g[t] * bt[col[t]]
      out[r] = s
    }
  }
  return ops
}
/** The independent operator for the true residual (§3.6): Bᵀ built as its own CSR (a face-wise gather, not flipRef's
 *  scatter), K⁻¹, B, C and the rank-3 term summed in a different order. */
function makeIndependentOp(S) {
  const { nR, nF, rowPtr, col, g, vg0, vg1, vg2, C, Kinv, KVinv } = S
  const cnt = new Int32Array(nF + 1)
  for (let t = 0; t < col.length; t++) cnt[col[t] + 1]++
  for (let f = 0; f < nF; f++) cnt[f + 1] += cnt[f]
  const fr = new Int32Array(col.length), fg = new Float64Array(col.length), fill = cnt.slice(0, nF)
  for (let r = 0; r < nR; r++) for (let t = rowPtr[r]; t < rowPtr[r + 1]; t++) { const q = fill[col[t]]++; fr[q] = r; fg[q] = g[t] }
  const w = new Float64Array(nF)
  return (y, out) => {
    for (let f = 0; f < nF; f++) { let s = 0; for (let q = cnt[f]; q < cnt[f + 1]; q++) s += fg[q] * y[fr[q]]; w[f] = Kinv[f] * s }
    let v0 = 0, v1 = 0, v2 = 0
    for (let r = nR - 1; r >= 0; r--) { v0 += vg0[r] * y[r]; v1 += vg1[r] * y[r]; v2 += vg2[r] * y[r] }
    for (let r = 0; r < nR; r++) {
      let s = 0
      for (let t = rowPtr[r]; t < rowPtr[r + 1]; t++) s += g[t] * w[col[t]]
      out[r] = s + C[r] * y[r] + KVinv * (vg0[r] * v0 + vg1[r] * v1 + vg2[r] * v2)
    }
  }
}
function trueResidual(S, Aind, y) { const q = new Float64Array(S.nR); Aind(y, q); for (let r = 0; r < S.nR; r++) q[r] = S.rhs[r] - q[r]; return { inf: infNorm(q), res: q } }

// ───────────────────────────────────────────── the pressure V-cycle on a system (§3.5) and the cell blocks (D3)
function stokesMG(S) {
  const [nx, ny, nz] = S.dims, M = [nx, ny, nz].map(n => Math.ceil(n / 8) * 8), N = M[0] * M[1] * M[2]
  const lab = new Uint8Array(N).fill(SOLIDL), e = [new Float64Array(N), new Float64Array(N), new Float64Array(N)], fc = [S.fc0, S.fc1, S.fc2]
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const w = i + nx * (j + ny * k), id = i + M[0] * (j + M[1] * k)
    lab[id] = S.cellLabel[w]
    for (const a of AXES) e[a][id] = fc[a][w]
  }
  const mg = new VarMG(M, lab, e, null)
  const Frows = [], Fidx = [], PnotF = []
  for (let r = 0; r < S.nR; r++) {
    if (S.kind[r] !== 0) continue
    const w = S.rowCell[r]
    if (S.cellLabel[w] === FLUIDL) { const i = w % nx, j = ((w - i) / nx) % ny, k = (w - i - nx * j) / (nx * ny); Frows.push(r); Fidx.push(i + M[0] * (j + M[1] * k)) } else PnotF.push(r)
  }
  return { mg, dims: M, Frows: Int32Array.from(Frows), Fidx: Int32Array.from(Fidx), PnotF: Int32Array.from(PnotF), b0: new Float64Array(N), levels: mg.levels.map(L => L.dims.join('×')), vcycles: 0 }
}
/** D_W⁻¹·V·D_W⁻¹ on the FLUID p rows: z[F] = scale·V(r[F]/W)/W (other entries untouched). */
function vcycleF(S, M, r, z, scale) {
  const b = M.b0
  b.fill(0)
  for (let m = 0; m < M.Frows.length; m++) { const row = M.Frows[m]; b[M.Fidx[m]] = r[row] / S.rowW[row] }
  const u = M.mg.vcycle(b)
  M.vcycles++
  for (let m = 0; m < M.Frows.length; m++) { const row = M.Frows[m]; z[row] = scale * u[M.Fidx[m]] / S.rowW[row] }
}
/** Cells with a live p row and three live τ_aa rows: the exact 4×4 block inverse (σ = Σ d̃_a C_a/e_a > 0); every other row
 *  (edges, partial cells, σ ≤ 0) takes 1/diag. sign = −1: the negative control with d̃'s sign flipped. */
function cellBlocks(S) {
  const NW = S.dims[0] * S.dims[1] * S.dims[2], slot = new Int32Array(4 * NW).fill(-1)
  for (let r = 0; r < S.nR; r++) if (S.kind[r] < 4) slot[4 * S.rowCell[r] + S.kind[r]] = r
  const grp = [], inGrp = new Uint8Array(S.nR)
  let sigmaBad = 0
  for (let w = 0; w < NW; w++) {
    const p = slot[4 * w], t = [slot[4 * w + 1], slot[4 * w + 2], slot[4 * w + 3]]
    if (p < 0 || t.some(x => x < 0)) continue
    const e = t.map(r => S.diag[r]), c = t.map(r => S.C[r]), dt = e.map((x, a) => x - c[a])
    const sigma = dt[0] * c[0] / e[0] + dt[1] * c[1] / e[1] + dt[2] * c[2] / e[2]
    if (!(sigma > 0)) { sigmaBad++; continue }
    grp.push({ p, t, e, dt, sigma }); inGrp[p] = 1; t.forEach(r => { inGrp[r] = 1 })
  }
  const jac = []
  for (let r = 0; r < S.nR; r++) if (!inGrp[r]) jac.push(r)
  const n = grp.length, gp = new Int32Array(n), gt = new Int32Array(3 * n), ge = new Float64Array(3 * n), gd = new Float64Array(3 * n), gs = new Float64Array(n)
  grp.forEach((q, m) => { gp[m] = q.p; gs[m] = q.sigma; for (let a = 0; a < 3; a++) { gt[3 * m + a] = q.t[a]; ge[3 * m + a] = q.e[a]; gd[3 * m + a] = q.dt[a] } })
  return { n, gp, gt, ge, gd, gs, jac: Int32Array.from(jac), sigmaBad }
}
function applyCellBlocks(S, B, r, z, sign = 1) {
  const { n, gp, gt, ge, gd, gs, jac } = B
  for (let m = 0; m < jac.length; m++) { const q = jac[m]; z[q] = r[q] / S.diag[q] }
  for (let m = 0; m < n; m++) {
    const p = gp[m]
    let num = r[p]
    for (let a = 0; a < 3; a++) num += sign * (gd[3 * m + a] / ge[3 * m + a]) * r[gt[3 * m + a]]
    const zp = num / gs[m]
    z[p] = zp
    for (let a = 0; a < 3; a++) { const t = gt[3 * m + a]; z[t] = (r[t] + sign * gd[3 * m + a] * zp) / ge[3 * m + a] }
  }
}

// ───────────────────────────────────────────── the arms (§3.4)
/** λ̂max of P̂⁻¹A_PP (s = 1): 30 Lanczos steps through PCG on A_PP x = b, b random on P (seeded). */
function pivotLambda(S, ops, M, steps = PRE.lanczosSteps) {
  const nR = S.nR, P = ops.P, rng = mulberry(4242)
  const r = new Float64Array(nR), z = new Float64Array(nR), d = new Float64Array(nR), q = new Float64Array(nR)
  for (const row of P) r[row] = randn(rng)
  const piv = (rr, zz) => { vcycleF(S, M, rr, zz, 1); for (const row of M.PnotF) zz[row] = rr[row] / S.diag[row] }
  piv(r, z); d.set(z)
  let rz = 0; for (const row of P) rz += r[row] * z[row]
  const al = [], be = []
  for (let k = 0; k < steps; k++) {
    ops.applyMasked(d, q, P, P, true)
    let dq = 0; for (const row of P) dq += d[row] * q[row]
    if (!(dq > 0)) break
    const a = rz / dq
    for (const row of P) r[row] -= a * q[row]
    al.push(a)
    piv(r, z)
    let rz2 = 0; for (const row of P) rz2 += r[row] * z[row]
    if (!(rz2 > 0) || rz2 < 1e-30 * rz) break
    const b = rz2 / rz; be.push(b); rz = rz2
    for (const row of P) d[row] = z[row] + b * d[row]
  }
  const lk = lanczosKappa(al, be.slice(0, Math.max(0, al.length - 1)))
  return { lmax: lk.lmax, lmin: lk.lmin, steps: al.length }
}
/** Builds an arm on a system: { prec(r, z) | null (J), flexible, info }. sHeld: a closed loop's held s (P1/P1J). */
function makeArm(name, S, ops, ctx = {}) {
  const nR = S.nR, P = ops.P, T = ops.T, diag = S.diag
  const need = ['P1', 'P1J', 'D3', 'D3flip', 'BDV', 'P1S'].includes(name)
  const t0 = performance.now()
  const M = need ? stokesMG(S) : null
  const B = ['D3', 'CB', 'D3flip'].includes(name) ? cellBlocks(S) : null
  const info = { arm: name, mgLevels: M?.levels, F: M?.Frows.length, PnotF: M?.PnotF.length, blocks: B?.n, sigmaBad: B?.sigmaBad }
  let s = 1
  if (name === 'P1' || name === 'P1J') {
    if (ctx.sHeld != null) { s = ctx.sHeld; info.sHeldFromRun = true } else { const lam = pivotLambda(S, ops, M); info.lambda = lam; s = lam.lmax > PRE.sLimit ? 1 / lam.lmax : 1 }
    info.s = s
  }
  const piv = (rr, zz) => { vcycleF(S, M, rr, zz, s); for (const row of M.PnotF) zz[row] = rr[row] / diag[row] }
  const u = new Float64Array(nR), tv = new Float64Array(nR), w = new Float64Array(nR), rp = new Float64Array(nR)
  let prec = null, flexible = false
  if (name === 'J') prec = null
  else if (name === 'P1') prec = (r, z) => {
    piv(r, u)
    ops.applyMasked(u, tv, P, T, false)
    for (const t of T) z[t] = (r[t] - tv[t]) / diag[t]
    ops.applyMasked(z, w, T, P, false)
    for (const p of P) rp[p] = r[p] - w[p]
    piv(rp, z)
  }
  else if (name === 'P1J') { const om = PRE.P1J_omega; prec = (r, z) => {
    for (const p of P) u[p] = om * r[p] / diag[p]
    ops.applyMasked(u, tv, P, T, false)
    for (const t of T) z[t] = (r[t] - tv[t]) / diag[t]
    ops.applyMasked(z, w, T, P, false)
    piv(r, rp)
    for (const p of P) z[p] = rp[p] - om * w[p] / diag[p]
  } }
  else if (name === 'D3' || name === 'D3flip') { const th = PRE.D3_theta, sg = name === 'D3flip' ? -1 : 1; prec = (r, z) => {
    applyCellBlocks(S, B, r, z, sg)
    vcycleF(S, M, r, rp, 1)
    for (const row of M.Frows) z[row] += th * rp[row]
  } }
  else if (name === 'CB') prec = (r, z) => applyCellBlocks(S, B, r, z, 1)
  else if (name === 'BDV') prec = (r, z) => {
    for (let q = 0; q < nR; q++) z[q] = r[q] / diag[q]
    vcycleF(S, M, r, z, 1)
  }
  else if (name === 'P1S') {
    // P1 with P̂⁻¹ = the exact A_PP⁻¹ (rank-3 term included): inner PCG preconditioned by the V-cycle pivot (s = 1) to
    // 1e-14 relative 2-norm; the outer loop is FCG(1) (Notay 2000, https://doi.org/10.1137/S1064827599362314 — the β
    // formula UNVERIFIED against the paper)
    flexible = true
    const pv = (rr, zz) => { vcycleF(S, M, rr, zz, 1); for (const row of M.PnotF) zz[row] = rr[row] / diag[row] }
    const xr = new Float64Array(nR), xz = new Float64Array(nR), xd = new Float64Array(nR), xq = new Float64Array(nR)
    info.innerIts = []
    const exact = (b, x) => {   // x[P] = A_PP⁻¹ b[P]
      let bn = 0; for (const p of P) { x[p] = 0; xr[p] = b[p]; bn += b[p] * b[p] }
      bn = Math.sqrt(bn)
      if (!(bn > 0)) return 0
      pv(xr, xz); for (const p of P) xd[p] = xz[p]
      let rz = 0; for (const p of P) rz += xr[p] * xz[p]
      let it = 0
      for (; it < PRE.P1S_innerCap; it++) {
        let rn = 0; for (const p of P) rn += xr[p] * xr[p]
        if (Math.sqrt(rn) <= PRE.P1S_innerRel2 * bn) break
        ops.applyMasked(xd, xq, P, P, true)
        let dq = 0; for (const p of P) dq += xd[p] * xq[p]
        if (!(dq > 0)) break
        const a = rz / dq
        for (const p of P) { x[p] += a * xd[p]; xr[p] -= a * xq[p] }
        pv(xr, xz)
        let rz2 = 0; for (const p of P) rz2 += xr[p] * xz[p]
        const bb = rz2 / rz; rz = rz2
        for (const p of P) xd[p] = xz[p] + bb * xd[p]
      }
      info.innerIts.push(it)
      return it
    }
    prec = (r, z) => {
      exact(r, u)
      ops.applyMasked(u, tv, P, T, false)
      for (const t of T) z[t] = (r[t] - tv[t]) / diag[t]
      ops.applyMasked(z, w, T, P, false)
      for (const p of P) rp[p] = r[p] - w[p]
      exact(rp, z)
    }
  }
  else if (name !== 'IBD') throw new Error(`unknown arm ${name}`)
  info.setupMs = performance.now() - t0
  return { name, prec, flexible, info, M, B, s }
}

// ───────────────────────────────────────────── the solvers (§3.3)
/** PCG as FlipRef.stokesSolve runs it (warm-start residual through its own apply; stop on the ∞-norm of the recursive
 *  residual; the dq > 0 guard). J (prec null): z = r/diag fused exactly as flipRef. Other arms: z = M⁻¹r and an rz > 0
 *  guard; flexible arms: FCG(1). Records the hits at `hits`, the iterates there (keepY), α/β (Lanczos) and breakdowns. */
function solve(S, ops, arm, { y0 = null, tol, cap, hits = [], keepY = false, resLoc = false }) {
  const nR = S.nR, rhs = S.rhs, diag = S.diag
  const y = new Float64Array(nR), res = rhs.slice(), z = new Float64Array(nR), d = new Float64Array(nR), q = new Float64Array(nR)
  if (y0) { y.set(y0); ops.apply(y, q); for (let r = 0; r < nR; r++) res[r] = rhs[r] - q[r] }
  const out = { hits: {}, yAt: {}, al: [], be: [], breakdown: null, resLoc: null }
  const t0 = performance.now()
  let it = 0, rInf = infNorm(res)
  const mark = () => {
    for (const t of hits) if (out.hits[t] === undefined && rInf <= t) {
      out.hits[t] = it
      if (keepY) out.yAt[t] = y.slice()
      if (resLoc && t === 1e-2) out.resLoc = residualLocation(S, res)
    }
  }
  mark()
  if (!arm.prec) {
    let rz = 0
    for (let r = 0; r < nR; r++) { z[r] = res[r] / diag[r]; d[r] = z[r]; rz += res[r] * z[r] }
    for (; it < cap && rInf > tol;) {
      ops.apply(d, q)
      let dq = 0
      for (let r = 0; r < nR; r++) dq += d[r] * q[r]
      if (!(dq > 0)) { out.breakdown = 'dq'; break }
      const alpha = rz / dq
      let rz2 = 0
      for (let r = 0; r < nR; r++) { y[r] += alpha * d[r]; res[r] -= alpha * q[r]; z[r] = res[r] / diag[r]; rz2 += res[r] * z[r] }
      rInf = infNorm(res)
      const beta = rz2 / rz
      rz = rz2
      for (let r = 0; r < nR; r++) d[r] = z[r] + beta * d[r]
      it++
      out.al.push(alpha); out.be.push(beta)
      mark()
    }
  } else if (!arm.flexible) {
    arm.prec(res, z); d.set(z)
    let rz = dot(res, z)
    if (!(rz > 0) && rInf > tol) out.breakdown = 'rz0'
    while (!out.breakdown && it < cap && rInf > tol) {
      ops.apply(d, q)
      const dq = dot(d, q)
      if (!(dq > 0)) { out.breakdown = 'dq'; break }
      const alpha = rz / dq
      for (let r = 0; r < nR; r++) { y[r] += alpha * d[r]; res[r] -= alpha * q[r] }
      rInf = infNorm(res)
      it++
      out.al.push(alpha)
      mark()
      if (!(rInf > tol) || it >= cap) break
      arm.prec(res, z)
      const rz2 = dot(res, z)
      if (!(rz2 > 0)) { out.breakdown = 'rz'; break }
      const beta = rz2 / rz
      rz = rz2
      out.be.push(beta)
      for (let r = 0; r < nR; r++) d[r] = z[r] + beta * d[r]
    }
  } else {
    // FCG(1): α = dᵀr/dᵀAd, d_{k+1} = z_{k+1} − (z_{k+1}ᵀAd_k / d_kᵀAd_k)·d_k; β_CG = r·z ratio kept for κ̂ (approximate)
    arm.prec(res, z); d.set(z)
    let rz = dot(res, z)
    if (!(rz > 0) && rInf > tol) out.breakdown = 'rz0'
    while (!out.breakdown && it < cap && rInf > tol) {
      ops.apply(d, q)
      const dq = dot(d, q)
      if (!(dq > 0)) { out.breakdown = 'dq'; break }
      const alpha = dot(d, res) / dq
      for (let r = 0; r < nR; r++) { y[r] += alpha * d[r]; res[r] -= alpha * q[r] }
      rInf = infNorm(res)
      it++
      out.al.push(alpha)
      mark()
      if (!(rInf > tol) || it >= cap) break
      arm.prec(res, z)
      const rz2 = dot(res, z)
      if (!(rz2 > 0)) { out.breakdown = 'rz'; break }
      out.be.push(rz2 / rz); rz = rz2
      const beta = -dot(z, q) / dq
      for (let r = 0; r < nR; r++) d[r] = z[r] + beta * d[r]
    }
  }
  out.N = it; out.rInf = rInf; out.capHit = rInf > tol && it >= cap && !out.breakdown; out.y = y; out.ms = performance.now() - t0
  return out
}
/** IBD (control, E2.5): the cost study's ideal block-diagonal, verbatim in arithmetic — inner Jacobi-PCG on each masked
 *  block (p, τ) to 1e-13 relative ∞-norm, plain outer PCG, cap 400; iteration semantics of its pcg(). */
function solveIBD(S, ops, tols, cap) {
  const nR = S.nR, diag = S.diag, P = ops.P, T = ops.T
  let innerIts = 0
  // coststudy pcg(b, jacobi, [], mask, 200000, 1e-13) on the rows: its vectors are zero off the mask, so the sums and
  // ∞-norms restricted to the rows are the same numbers in the same order
  const ir = new Float64Array(nR), iz = new Float64Array(nR), id = new Float64Array(nR), iq = new Float64Array(nR)
  const rowInf = (v, rows) => { let m = 0; for (const i of rows) m = Math.max(m, Math.abs(v[i])); return m }
  const inner = (b, rows, x) => {
    for (const i of rows) { ir[i] = b[i]; x[i] = 0 }
    for (const i of rows) iz[i] = ir[i] / diag[i]
    for (const i of rows) id[i] = iz[i]
    let rz = 0; for (const i of rows) rz += ir[i] * iz[i]
    const b0 = rowInf(ir, rows)
    let it = 0
    for (; it < PRE.IBD_innerCap; it++) {
      const rn = rowInf(ir, rows)
      if (rn <= PRE.IBD_innerRelInf * b0 || !(b0 > 0)) break
      ops.applyMasked(id, iq, rows, rows, true)
      let dq = 0; for (const i of rows) dq += id[i] * iq[i]
      if (!(dq > 0)) break
      const al = rz / dq
      for (const i of rows) { x[i] += al * id[i]; ir[i] -= al * iq[i] }
      for (const i of rows) iz[i] = ir[i] / diag[i]
      let rz2 = 0; for (const i of rows) rz2 += ir[i] * iz[i]
      const be = rz2 / rz; rz = rz2
      for (const i of rows) id[i] = iz[i] + be * id[i]
    }
    innerIts += it
  }
  const prec = (r, z) => { inner(r, P, z); inner(r, T, z) }
  const y = new Float64Array(nR), r = S.rhs.slice(), z = new Float64Array(nR), d = new Float64Array(nR), q = new Float64Array(nR)
  prec(r, z); d.set(z)
  let rz = dot(r, z)
  const hits = {}
  let it = 0
  const t0 = performance.now()
  for (; it < cap; it++) {
    const rn = infNorm(r)
    for (const t of tols) if (hits[t] === undefined && rn <= t) hits[t] = it
    if (tols.every(t => hits[t] !== undefined)) break
    ops.apply(d, q)
    const dq = dot(d, q)
    if (!(dq > 0)) break
    const al = rz / dq
    for (let i = 0; i < nR; i++) { y[i] += al * d[i]; r[i] -= al * q[i] }
    prec(r, z)
    const rz2 = dot(r, z), be = rz2 / rz; rz = rz2
    for (let i = 0; i < nR; i++) d[i] = z[i] + be * d[i]
  }
  return { hits, N: it, innerIts, y, ms: performance.now() - t0 }
}
/** Where the residual sits (§3.6): the ∞-norm share of each category at the 1e-2 hit. */
function residualLocation(S, res) {
  const tot = infNorm(res) || 1, cat = {}
  const put = (k, v) => { cat[k] = Math.max(cat[k] ?? 0, v) }
  let arg = -1, am = -1
  for (let r = 0; r < S.nR; r++) {
    const v = Math.abs(res[r]), k = S.kind[r], W = S.rowW[r], wf = S.rowWf[r]
    if (v > am) { am = v; arg = r }
    put(k === 0 ? 'kind:p' : k < 4 ? 'kind:τaa' : 'kind:τab', v)
    put(W >= 1 ? 'W:1' : W >= 0.5 ? 'W:[0.5,1)' : 'W:<0.5', v)
    put(Number.isNaN(wf) ? 'Wf:none' : wf >= 1 ? 'Wf:1' : wf >= 0.5 ? 'Wf:[0.5,1)' : wf >= 0.1 ? 'Wf:[0.1,0.5)' : 'Wf:<0.1', v)
    put(S.shell[r] ? 'ball-shell' : 'not-shell', v)
  }
  for (const k in cat) cat[k] = cat[k] / tot
  return { share: cat, argmax: arg >= 0 ? { kind: S.kind[arg], W: S.rowW[arg], Wf: S.rowWf[arg], shell: S.shell[arg] } : null }
}
/** One cold solve of an arm on a system (from y = 0, hits 1e-2/1e-4/1e-6): N, true residuals, κ̂, residual location. */
function coldSolve(S, ops, Aind, armName) {
  if (armName === 'IBD') {
    const r = solveIBD(S, ops, PRE.tolsCold, PRE.capArm)
    return { arm: 'IBD', hits: r.hits, N: r.N, innerIts: r.innerIts, ms: r.ms }
  }
  const arm = makeArm(armName, S, ops)
  const cap = armName === 'J' ? PRE.capJ : PRE.capArm
  const o = solve(S, ops, arm, { tol: PRE.tolsCold[2], cap, hits: PRE.tolsCold, keepY: true, resLoc: true })
  const trueAt = {}
  for (const t of PRE.tolsCold) if (o.yAt[t]) trueAt[t] = trueResidual(S, Aind, o.yAt[t]).inf
  const lk = lanczosKappa(o.al, o.be.slice(0, Math.max(0, o.al.length - 1)))
  return { arm: armName, hits: o.hits, N: o.N, capHit: o.capHit, breakdown: o.breakdown, rInf: o.rInf, trueAt, kappa: lk, resLoc: o.resLoc, ms: o.ms, info: { ...arm.info, innerIts: arm.info.innerIts ? { n: arm.info.innerIts.length, mean: arm.info.innerIts.reduce((a, b) => a + b, 0) / Math.max(1, arm.info.innerIts.length), max: Math.max(0, ...arm.info.innerIts) } : undefined }, vcycles: arm.M?.vcycles }
}

// ───────────────────────────────────────────── the closed loop (§3.3)
const gatherY = (sim, S) => {
  const y = new Float64Array(S.nR), st = sim.stokesStress
  for (let r = 0; r < S.nR; r++) { const k = S.kind[r], at = S.at[r]; y[r] = k === 0 ? sim.pressure[at] : k < 4 ? st.cell[k - 1][at] : st.edge[k - 4][at] }
  return y
}
function installClosedLoop(sim, cfg) {
  const L = sim.layout, proto = FlipRef.prototype.stokesSolve
  const state = { step: 0, sHeld: null, recs: [] }
  sim.stokesSolve = function (p, dt) {
    state.step++
    const t0 = performance.now()
    this.viscousVolumes()
    const fb = this.viscousMu(p)
    const R = assemble(this, dt)
    const S = toSystem(R, this, { tag: cfg.tag, step: state.step })
    const ops = makeOps(S)
    const warm = cfg.warm && this.stokesStress
    const y0 = warm ? gatherY(this, S) : null
    const armName = cfg.armAt ? cfg.armAt(state.step) : cfg.arm
    const arm = makeArm(armName, S, ops, { sHeld: cfg.holdS ? state.sHeld : null })
    if ((armName === 'P1' || armName === 'P1J') && state.sHeld === null && cfg.holdS) state.sHeld = arm.s
    const cap = armName === 'J' ? PRE.capJ : PRE.capArm
    const o = solve(S, ops, arm, { y0, tol: cfg.tol, cap })
    if (!this.stokesStress) this.stokesStress = { cell: [new Float64Array(L.size), new Float64Array(L.size), new Float64Array(L.size)], edge: [new Float64Array(L.size), new Float64Array(L.size), new Float64Array(L.size)] }
    const st0 = this.stokesStress
    for (let r = 0; r < S.nR; r++) { const k = S.kind[r], at = S.at[r]; if (k === 0) this.pressure[at] = o.y[r]; else if (k < 4) st0.cell[k - 1][at] = o.y[r]; else st0.edge[k - 4][at] = o.y[r] }
    // the handover: flipRef's own code applies y_X (0 iterations)
    const keep = { ws: this.stokesWarmStart, tol: this.stokesTolerance, ex: this.stokesExport }
    this.stokesWarmStart = true; this.stokesTolerance = Infinity; this.stokesExport = true
    this.viscousVolumes = () => {}; this.viscousMu = () => fb
    let st
    try { st = proto.call(this, p, dt) } finally { delete this.viscousVolumes; delete this.viscousMu; this.stokesWarmStart = keep.ws; this.stokesTolerance = keep.tol; this.stokesExport = keep.ex }
    if (st.iterations !== 0) throw new Error(`closed loop ${cfg.tag} step ${state.step}: the handover ran ${st.iterations} iterations`)
    const cmp = compareExport(R, this.lastStokesSystem)
    this.lastStokesSystem = null
    if (!cmp.ok) throw new Error(`closed loop ${cfg.tag} step ${state.step}: S0-b replica ≠ export (${cmp.why})`)
    if (!o.capHit && !(st.trueResidualInf <= cfg.tol * (1 + 1e-9))) throw new Error(`closed loop ${cfg.tag} step ${state.step}: true residual ${st.trueResidualInf} > ${cfg.tol}`)
    if (cfg.saveAt?.has(state.step)) { saveSystem(`${cfg.tag}-s${state.step}`, S); log(`  saved the step-${state.step} system (${S.nR} rows)`) }
    const rec = { step: state.step, arm: armName, N: o.N, capHit: o.capHit, breakdown: o.breakdown, rInf: o.rInf, trueRes: st.trueResidualInf, warm: !!warm, rows: S.nR, faces: S.nF, s: arm.s, lambda: arm.info.lambda, ms: performance.now() - t0 }
    state.recs.push(rec)
    return st
  }
  return state
}

// ───────────────────────────────────────────── scene runners
const Rc = tag => (tag.startsWith('W3.5') || tag === 'E3.5' ? 3.5 : 2.5)
function runE(tag) {
  printPre()
  const { sim, P, Us, tank } = buildA5(Rc(tag), 1e-6, false)
  const native = []
  for (let k = 0; k < 4; k++) { sim.advanceSphere(DT); sim.step(P, DT); native.push(sim.lastStokes.iterations) }
  let R = null, Rneg = null
  sim.stokesSolve = function (p, dt) {
    this.viscousVolumes(); this.viscousMu(p)
    R = assemble(this, dt)
    if (tag === 'E2.5') Rneg = assemble(this, dt, { noFreeDrop: true })
    return FlipRef.prototype.stokesSolve.call(this, p, dt)
  }
  sim.stokesExport = true
  sim.advanceSphere(DT); sim.step(P, DT)
  delete sim.stokesSolve
  const nat = sim.lastStokes
  native.push(nat.iterations)
  const E = sim.lastStokesSystem
  const s0b = compareExport(R, E), s0e1 = Rneg ? compareExport(Rneg, E) : null
  log(`${tag}: tank ${tank.join('×')}, ${P.n} particles, rows ${R.nR}, faces ${R.nF}, dropped ${R.dropped}; native iterations (1e-6, cold) steps 1–5: ${native.join(', ')}; U/U_S ${(-sim.sphere.velocity[1] / Us).toFixed(5)}`)
  log(`S0-b ${s0b.ok ? 'PASS' : 'FAIL'} replica = export at ${tag} ${s0b.why}`)
  if (s0e1) log(`S0-e(1) ${!s0e1.ok ? 'PASS' : 'FAIL'} replica without the free-face drop must differ: ${s0e1.ok ? 'IDENTICAL' : s0e1.why}`)
  const S = toSystem(R, sim, { tag, step: 5 })
  saveSystem(tag, S)
  const ops = makeOps(S), Aind = makeIndependentOp(S)
  // the independent operator vs flipRef's order (random y and the native solution y_nat from the fields via rowAt)
  const yNat = gatherY(sim, S), rng = mulberry(7), yR = new Float64Array(S.nR).map(() => randn(rng))
  const opChk = [yR, yNat].map(y => { const a = new Float64Array(S.nR), b = new Float64Array(S.nR); ops.apply(y, a); Aind(y, b); let dm = 0; for (let r = 0; r < S.nR; r++) dm = Math.max(dm, Math.abs(a[r] - b[r])); return dm / infNorm(a) })
  const tNat = trueResidual(S, Aind, yNat).inf
  log(`true-residual operator: independent vs flipRef-order ‖ΔAy‖∞/‖Ay‖∞ ${opChk.map(v => v.toExponential(2)).join(' (random y), ')} (y_native) — ≤ 1e-13: ${opChk.every(v => v <= 1e-13) ? 'PASS' : 'FAIL'}; native ‖b − Ay‖∞ flipRef ${nat.trueResidualInf.toExponential(4)} vs independent ${tNat.toExponential(4)}`)
  // CONTROL: J
  const J = coldSolve(S, ops, Aind, 'J')
  const hitsJ = PRE.tolsCold.map(t => J.hits[t])
  const cj1 = tag === 'E2.5' ? hitsJ.every((h, i) => Math.abs(h - PRE.CJ1.hits[i]) <= PRE.CJ1.tol) : null
  const natEq = J.hits[1e-6] === nat.iterations
  log(`J cold on the export: ${hitsJ.join(' / ')} to 1e-2 / 1e-4 / 1e-6${tag === 'E2.5' ? ` — C-J1 (183 / 277 / 356 ± 2): ${cj1 ? 'PASS' : 'FAIL'}` : ''}; native step 5 ${nat.iterations} = harness J 1e-6 hit ${J.hits[1e-6]}: ${natEq ? 'PASS' : 'FAIL'}; κ̂ ${J.kappa.kappa.toFixed(0)}`)
  const res = { scene: tag, tank, particles: P.n, rows: S.nR, faces: S.nF, dropped: R.dropped, pRows: ops.P.length, native, nativeTrue: nat.trueResidualInf, U: -sim.sphere.velocity[1] / Us,
    S0b: s0b, S0e1: s0e1 && { ok: !s0e1.ok, why: s0e1.why }, opCheck: { relRandom: opChk[0], relNative: opChk[1], ok: opChk.every(v => v <= 1e-13), nativeTrueFlip: nat.trueResidualInf, nativeTrueIndep: tNat },
    J: { hits: J.hits, kappa: J.kappa, trueAt: J.trueAt }, CJ1: cj1, nativeEqHarness: natEq }
  if (tag !== 'E2.5') { writeJSON(`${tag}.json`, res); return }
  if (!cj1 || !natEq || !s0b.ok) { res.stop = 'control failed'; writeJSON(`${tag}.json`, res); log('STOP: a control failed — the study does not continue (task rule)'); process.exit(2) }
  // CONTROL: IBD
  const ibd = coldSolve(S, ops, Aind, 'IBD')
  const cibd = Math.abs(ibd.hits[1e-2] - PRE.CIBD.hits[0]) <= PRE.CIBD.tol[0] && Math.abs(ibd.hits[1e-4] - PRE.CIBD.hits[1]) <= PRE.CIBD.tol[1]
  log(`C-IBD ${cibd ? 'PASS' : 'FAIL'} ideal block-diagonal outer ${ibd.hits[1e-2]} / ${ibd.hits[1e-4]} / ${ibd.hits[1e-6] ?? '—'} (16 ± 3 / 51 ± 5; inner Jacobi iterations ${ibd.innerIts}, ${(ibd.ms / 1000).toFixed(0)} s)`)
  res.IBD = ibd; res.CIBD = cibd
  if (!cibd) { res.stop = 'C-IBD failed'; writeJSON(`${tag}.json`, res); log('STOP: C-IBD failed'); process.exit(2) }
  // S0-c operator identities
  res.S0c = s0c(S, ops)
  // S0-d symmetry / positivity for every arm's M⁻¹
  res.S0d = {}
  for (const a of ['J', 'P1', 'P1J', 'D3', 'CB', 'BDV', 'P1S']) {
    const arm = makeArm(a, S, ops)
    const pr = arm.prec ?? ((r, z) => { for (let q = 0; q < S.nR; q++) z[q] = r[q] / S.diag[q] })
    const rg = mulberry(99), u = new Float64Array(S.nR), v = new Float64Array(S.nR), Mu = new Float64Array(S.nR), Mv = new Float64Array(S.nR)
    let asym = 0, pos = true
    for (let t = 0; t < 20; t++) {
      for (let q = 0; q < S.nR; q++) { u[q] = randn(rg); v[q] = randn(rg) }
      pr(u, Mu); pr(v, Mv)
      const uMv = dot(u, Mv), vMu = dot(v, Mu), uMu = dot(u, Mu), vMv = dot(v, Mv)
      asym = Math.max(asym, Math.abs(uMv - vMu) / Math.sqrt(Math.abs(uMu * vMv)))
      if (!(uMu > 0 && vMv > 0)) pos = false
    }
    const ok = asym <= 1e-12 && pos
    res.S0d[a] = { asym, pos, ok, gating: a !== 'P1S', s: arm.s }
    log(`S0-d ${ok ? 'PASS' : a === 'P1S' ? 'INFO' : 'FAIL'} ${a}: max |uᵀM⁻¹v − vᵀM⁻¹u|/√(uᵀM⁻¹u·vᵀM⁻¹v) ${asym.toExponential(2)} (≤ 1e-12), vᵀM⁻¹v > 0 on 40 vectors: ${pos}${a === 'P1S' ? ' (P1*: inexact inner solve, FCG — informational)' : ''}`)
  }
  // S0-e(2): the SPD probe flags D2's τ-first pressure operator A_PP − A_PT·diag_T⁻¹·A_TP
  {
    const P = ops.P, T = ops.T, x = new Float64Array(S.nR), a1 = new Float64Array(S.nR), a2 = new Float64Array(S.nR), a3 = new Float64Array(S.nR), rg = mulberry(5)
    let neg = 0, minQ = Infinity
    for (let t = 0; t < 20; t++) {
      x.fill(0); for (const p of P) x[p] = randn(rg)
      ops.applyMasked(x, a1, P, P, true); ops.applyMasked(x, a2, P, T, false)
      for (const q of T) a2[q] /= S.diag[q]
      ops.applyMasked(a2, a3, T, P, false)
      let qf = 0, nn = 0; for (const p of P) { qf += x[p] * (a1[p] - a3[p]); nn += x[p] * x[p] }
      minQ = Math.min(minQ, qf / nn); if (!(qf > 0)) neg++
    }
    res.S0e2 = { negatives: neg, of: 20, minRayleigh: minQ, ok: neg > 0 }
    log(`S0-e(2) ${neg > 0 ? 'PASS' : 'FAIL'} the SPD probe flags the τ-first pressure operator: ${neg}/20 random vectors with xᵀSx ≤ 0 (min Rayleigh ${minQ.toExponential(2)})`)
  }
  // S0-e(3): a y moved by 2·tol/diag_r in one entry is flagged by the true-residual check
  {
    const y = J.trueAt[1e-2] !== undefined ? coldSolveY(S, ops, 1e-2) : null
    const r0 = trueResidual(S, Aind, y), rMax = r0.res.reduce((m, v, i) => (Math.abs(v) > Math.abs(r0.res[m]) ? i : m), 0)
    const row = (rMax + 1) % S.nR
    y[row] += 2 * 1e-2 / S.diag[row]
    const r1 = trueResidual(S, Aind, y).inf
    res.S0e3 = { before: r0.inf, after: r1, row, ok: r0.inf <= 1e-2 && r1 > 1e-2 }
    log(`S0-e(3) ${res.S0e3.ok ? 'PASS' : 'FAIL'} true residual ${r0.inf.toExponential(3)} → ${r1.toExponential(3)} after moving row ${row} by 2·tol/diag (flag > 1e-2)`)
  }
  // S0-e(4): D3 with d̃'s sign flipped needs more iterations than D3 (at the 1e-2 hit, the study's tolerance)
  {
    const a = coldSolve(S, ops, Aind, 'D3'), b = coldSolve(S, ops, Aind, 'D3flip')
    const hA = PRE.tolsCold.map(t => a.hits[t] ?? `>${a.N}`), hB = PRE.tolsCold.map(t => b.hits[t] ?? `>${b.N}`)
    const nA = a.hits[1e-2] ?? Infinity, nB = b.hits[1e-2] ?? Infinity
    res.S0e4 = { D3: a.hits, D3flip: b.hits, ok: nB > nA }
    log(`S0-e(4) ${nB > nA ? 'PASS' : 'FAIL'} D3 with d̃ sign-flipped needs more iterations: D3 ${hA.join(' / ')} vs flipped ${hB.join(' / ')}`)
  }
  res.S0pass = s0b.ok && res.S0e1.ok && res.opCheck.ok && res.S0c.ok && Object.values(res.S0d).every(v => v.ok || !v.gating) && res.S0e2.ok && res.S0e3.ok && res.S0e4.ok
  writeJSON(`${tag}.json`, res)
  log(`\n${tag}: self-tests ${res.S0pass ? 'PASS' : 'FAIL'}; controls C-J1 ${cj1 ? 'PASS' : 'FAIL'}, C-IBD ${cibd ? 'PASS' : 'FAIL'} (${((Date.now() - T0) / 1000).toFixed(0)} s)`)
}
function coldSolveY(S, ops, tol) { const o = solve(S, ops, { prec: null }, { tol, cap: PRE.capJ }); return o.y }
/** S0-c: D_W·L·D_W = A_PP − rank-3 on F (per entry), D3's closed form = inverse of the principal 4×4 block, diag(p) = Σ d̃_a. */
function s0c(S, ops) {
  const M = stokesMG(S), L0 = M.mg.levels[0], Mx = M.dims[0], My = M.dims[1]
  // A_PP without the rank-3 term from B K⁻¹ Bᵀ: faces → the p rows touching them
  const fp = new Map()
  for (const r of ops.P) for (let t = S.rowPtr[r]; t < S.rowPtr[r + 1]; t++) { const c = S.col[t]; if (!fp.has(c)) fp.set(c, []); fp.get(c).push([r, S.g[t]]) }
  const idxRow = new Map()
  for (let m = 0; m < M.Frows.length; m++) idxRow.set(M.Fidx[m], M.Frows[m])
  let rel1 = 0, nonF = 0
  const Fset = new Set(M.Frows)
  for (let m = 0; m < M.Frows.length; m++) {
    const r = M.Frows[m], id = M.Fidx[m], W = S.rowW[r]
    const ent = new Map()
    for (let t = S.rowPtr[r]; t < S.rowPtr[r + 1]; t++) { const c = S.col[t]; for (const [r2, g2] of fp.get(c)) ent.set(r2, (ent.get(r2) ?? 0) + S.g[t] * S.Kinv[c] * g2) }
    // the MG row: diag and the FLUID neighbours
    const mm = binSearch(L0.F, id)
    const lrow = new Map([[r, W * L0.diag[id] * W]])
    for (let q = 0; q < 6; q++) { const nb = L0.nb[6 * mm + q]; if (nb >= 0) { const r2 = idxRow.get(nb); lrow.set(r2, (lrow.get(r2) ?? 0) - W * L0.cf[6 * mm + q] * S.rowW[r2]) } }
    for (const [r2, v] of ent) { if (!Fset.has(r2)) { nonF++; continue } const u = lrow.get(r2) ?? 0; rel1 = Math.max(rel1, Math.abs(u - v) / Math.max(Math.abs(u), Math.abs(v))) }
    for (const [r2, u] of lrow) if (!ent.has(r2)) rel1 = Math.max(rel1, 1)
  }
  // the 4×4 blocks
  const B = cellBlocks(S)
  const entry = (r1, r2) => {
    let s = 0
    for (let t = S.rowPtr[r1]; t < S.rowPtr[r1 + 1]; t++) for (let u = S.rowPtr[r2]; u < S.rowPtr[r2 + 1]; u++) if (S.col[t] === S.col[u]) s += S.g[t] * S.Kinv[S.col[t]] * S.g[u]
    s += S.KVinv * (S.vg0[r1] * S.vg0[r2] + S.vg1[r1] * S.vg1[r2] + S.vg2[r1] * S.vg2[r2])
    if (r1 === r2) s += S.C[r1]
    return s
  }
  let rel2 = 0, rel3 = 0
  // the closed form of applyCellBlocks for one cell (same arithmetic), on the unit vectors
  const closed = (m, rv) => {
    let num = rv[0]
    for (let a = 0; a < 3; a++) num += (B.gd[3 * m + a] / B.ge[3 * m + a]) * rv[1 + a]
    const zp = num / B.gs[m]
    return [zp, ...[0, 1, 2].map(a => (rv[1 + a] + B.gd[3 * m + a] * zp) / B.ge[3 * m + a])]
  }
  for (let m = 0; m < B.n; m++) {
    const rows = [B.gp[m], B.gt[3 * m], B.gt[3 * m + 1], B.gt[3 * m + 2]]
    const A = rows.map(a => rows.map(b => entry(a, b)))
    const inv = invert4(A)
    let im = 0; for (const row of inv) for (const v of row) im = Math.max(im, Math.abs(v))
    for (let c = 0; c < 4; c++) {
      const z = closed(m, [0, 1, 2, 3].map(q => (q === c ? 1 : 0)))
      for (let a = 0; a < 4; a++) rel2 = Math.max(rel2, Math.abs(z[a] - inv[a][c]) / im)
    }
    const sumd = B.gd[3 * m] + B.gd[3 * m + 1] + B.gd[3 * m + 2]
    rel3 = Math.max(rel3, Math.abs(S.diag[B.gp[m]] - sumd) / S.diag[B.gp[m]])
  }
  const ok = rel1 <= 1e-12 && nonF === 0 && rel2 <= 1e-12 && rel3 <= 1e-12
  log(`S0-c ${ok ? 'PASS' : 'FAIL'} D_W·L·D_W vs A_PP − rank-3 on F: max rel ${rel1.toExponential(2)} (couplings to non-F p rows: ${nonF}); closed-form 4×4 inverse vs numeric: ${rel2.toExponential(2)} over ${B.n} cells (σ ≤ 0: ${B.sigmaBad}); diag(p) vs Σd̃: ${rel3.toExponential(2)} (all ≤ 1e-12); MG levels ${M.levels.join(' → ')}, F ${M.Frows.length}, P∖F ${M.PnotF.length}`)
  return { relDWLDW: rel1, couplingsToNonF: nonF, relBlockInverse: rel2, relDiagSum: rel3, cells: B.n, sigmaBad: B.sigmaBad, levels: M.levels, F: M.Frows.length, PnotF: M.PnotF.length, ok }
}
function binSearch(a, v) { let lo = 0, hi = a.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] === v) return m; if (a[m] < v) lo = m + 1; else hi = m - 1 } return -1 }
function invert4(A) {
  const n = 4, M = A.map((row, i) => [...row, ...[0, 1, 2, 3].map(j => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i
    ;[M[c], M[p]] = [M[p], M[c]]
    const d = M[c][c]
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d
    for (let i = 0; i < n; i++) if (i !== c) { const f = M[i][c]; for (let j = 0; j < 2 * n; j++) M[i][j] -= f * M[c][j] }
  }
  return M.map(row => row.slice(n))
}

/** flipRef's own unwrapped solve, 60 steps (the same-tree reference, and the stored references' re-measurement). */
function runNative(tag) {
  printPre()
  const tol = tag.endsWith('-4') ? 1e-4 : 1e-2, warm = !tag.endsWith('-cold')
  const { sim, P, Us, tank } = buildA5(Rc(tag.replace('native-', '')), tol, warm)
  const recs = []
  for (let k = 0; k < 60; k++) {
    const t = performance.now()
    sim.advanceSphere(DT); sim.step(P, DT)
    recs.push({ step: k + 1, N: sim.lastStokes.iterations, trueRes: sim.lastStokes.trueResidualInf, U: -sim.sphere.velocity[1] / Us, yc: sim.sphere.center[1], rows: sim.lastStokes.rows, ms: performance.now() - t })
  }
  const Ns = recs.map(r => r.N)
  log(`${tag}: tank ${tank.join('×')}, tol ${tol}, warm ${warm}: iterations ${Ns.join(',')}; sum ${Ns.reduce((a, b) => a + b, 0)}, mean ${(Ns.reduce((a, b) => a + b, 0) / 60).toFixed(2)}; U/U_S(60) ${recs[59].U.toFixed(6)} (${((Date.now() - T0) / 1000).toFixed(0)} s)`)
  writeJSON(`${tag}.json`, { scene: tag, tol, warm, tank, particles: P.n, recs })
}
/** The closed loop of one arm on W2.5 / W3.5 / W3.5-4 (60 steps, warm). */
function runW(tag, armName) {
  printPre()
  const tol = tag.endsWith('-4') ? 1e-4 : 1e-2
  const { sim, P, Us, tank } = buildA5(Rc(tag), tol, true)
  const saveAt = armName === 'J' && (tag === 'W2.5' || tag === 'W3.5') ? new Set([1, 30, 60]) : null
  const state = installClosedLoop(sim, { tag, arm: armName, tol, warm: true, saveAt, holdS: true })
  for (let k = 0; k < 60; k++) {
    sim.advanceSphere(DT); sim.step(P, DT)
    const rec = state.recs.at(-1)
    rec.U = -sim.sphere.velocity[1] / Us; rec.yc = sim.sphere.center[1]
    if ((k + 1) % 10 === 0) log(`  ${tag} ${armName} step ${k + 1}: N ${rec.N}, true ${rec.trueRes.toExponential(2)}, U/U_S ${rec.U.toFixed(5)}, ${(rec.ms / 1000).toFixed(1)} s/solve, ${((Date.now() - T0) / 1000).toFixed(0)} s`)
  }
  const Ns = state.recs.map(r => r.N)
  log(`${tag} ${armName}: iterations ${Ns.join(',')}; sum ${Ns.reduce((a, b) => a + b, 0)}; U/U_S(60) ${state.recs[59].U.toFixed(6)}; cap hits ${state.recs.filter(r => r.capHit).length}; breakdowns ${state.recs.filter(r => r.breakdown).length}${state.sHeld != null ? `; s ${state.sHeld}` : ''}`)
  // same-tree / stored-reference comparisons when available
  if (armName === 'J') {
    const nat = readJSON(`native-${tag}.json`)
    if (nat) { const eqN = nat.recs.every((r, i) => r.N === Ns[i]), eqU = nat.recs.every((r, i) => Object.is(r.U, state.recs[i].U)); log(`same-tree reference vs native-${tag}: iterations ${eqN ? 'IDENTICAL' : 'DIFFER'}, U ${eqU ? 'IDENTICAL' : 'DIFFER'}`) }
  }
  writeJSON(`${tag}-${armName}.json`, { scene: tag, arm: armName, tol, tank, particles: P.n, recs: state.recs, sHeld: state.sHeld })
}
/** PP settle step 1 with J (cold): the C-PP settle band; the system is kept for C2 (a cold-set member of its own). */
function runPP1() {
  printPre()
  const { sim, P, tank } = buildPP()
  const state = installClosedLoop(sim, { tag: 'PP', arm: 'J', tol: 1e-2, warm: true, saveAt: new Set([1]), holdS: true })
  sim.advanceSphere(DT); sim.step(P, DT)
  const rec = state.recs[0], ok = rec.N >= PRE.CPP.settle1[0] && rec.N <= PRE.CPP.settle1[1]
  log(`PP settle step 1 (tank ${tank.join('×')}, ${P.n} particles, rows ${rec.rows}): J cold to 1e-2 in ${rec.N} iterations — C-PP settle band ${PRE.CPP.settle1.join('–')}: ${ok ? 'INSIDE' : 'OUTSIDE'} (true ‖r‖∞ ${rec.trueRes.toExponential(3)}, ${(rec.ms / 1000).toFixed(1)} s)`)
  writeJSON('PP1.json', { scene: 'PP1', tank, particles: P.n, rec, settleBandOk: ok })
}
/** Every saved cold-set system × the arms. */
function runCold(arms) {
  printPre()
  const systems = [...COLD_SYSTEMS, 'PP-s1']
  for (const name of systems) {
    const S = loadSystem(name)
    if (!S) { log(`cold: no system ${name} yet`); continue }
    const ops = makeOps(S), Aind = makeIndependentOp(S)
    for (const a of arms) {
      if (a === 'IBD' && name !== 'E2.5') continue
      const f = `cold-${name}-${a}.json`
      if (existsSync(join(OUT, f)) && !process.env.G4_REDO) { log(`cold ${name} ${a}: exists`); continue }
      const r = coldSolve(S, ops, Aind, a)
      const h = PRE.tolsCold.map(t => r.hits[t] ?? `>${r.N}`)
      log(`cold ${name} (${S.nR} rows) ${a}: ${h.join(' / ')}${r.kappa ? `; κ̂ ${r.kappa.kappa.toFixed(1)}` : ''}${r.trueAt ? `; true ‖r‖∞ at 1e-2 ${r.trueAt[1e-2]?.toExponential(2)}` : ''}${r.breakdown ? `; BREAKDOWN ${r.breakdown}` : ''}${r.info?.s !== undefined && r.info?.s !== 1 ? `; s ${r.info.s.toFixed(4)}` : ''}${r.info?.lambda ? ` (λ̂max ${r.info.lambda.lmax.toFixed(3)})` : ''} (${(r.ms / 1000).toFixed(1)} s)`)
      writeJSON(f, { scene: 'cold', system: name, rows: S.nR, ...r })
    }
  }
}

// ───────────────────────────────────────────── the cost model (§3.7) and the decision (§3.10)
const Tact = (arm, N, k) => PRE.cost[arm].s[k] + N * PRE.cost[arm].a[k]
/** Σ T_pol over solves s ≥ 2 (index 0 = solve 1) under a cap policy; returns the sum, cap hits, caps, encode ms. */
function Tpol(arm, Ns, k, policy) {
  const c = PRE.cost[arm], caps = []
  let sum = 0, hits = 0, encUs = 0
  for (let s = 1; s < Ns.length; s++) {
    let R = 0
    for (let q = Math.max(0, s - 33); q <= s - 2; q++) R = Math.max(R, Ns[q])
    const cap = policy(R)
    caps.push(cap)
    const N = Ns[s]
    if (N > cap) { hits++; sum += c.s[k] + cap * c.a[k] } else sum += c.s[k] + N * c.a[k] + (cap - N) * c.i[k]
    encUs += cap * c.disp * PRE.encodeUsPerDispatch
  }
  return { sum, capHits: hits, caps, encodeMsPerSolve: encUs / 1000 / Math.max(1, Ns.length - 1) }
}
const prodPolicy = R => Math.min(PRE.capProd.hi, Math.max(PRE.capProd.lo, PRE.capProd.mult * R + PRE.capProd.add))
const scaledPolicy = (MX, MJ, floorMult = PRE.scaled.floorMult) => R => Math.min(Math.ceil(800 * MX / MJ), Math.max(Math.ceil(floorMult * MX), 2 * R + Math.max(2, Math.ceil(16 * MX / MJ))))
const warmMax = Ns => Math.max(...Ns.slice(1))
function decide() {
  const J = n => readJSON(n)
  const out = { invalid: [], controls: {}, criteria: {}, notes: [] }
  const st = J('selftest.json'), e25 = J('E2.5.json'), e35 = J('E3.5.json'), pp1 = J('PP1.json')
  // INVALID gates
  if (!st?.pass) out.invalid.push('S0-a')
  if (!e25?.S0pass) out.invalid.push('S0 (E2.5)')
  if (!e35?.S0b?.ok) out.invalid.push('S0-b (E3.5)')
  if (!e25?.nativeEqHarness || (e35 && !e35.nativeEqHarness)) out.invalid.push('native step 5 = harness J')
  for (const w of ['W2.5', 'W3.5']) {
    const nat = J(`native-${w}.json`), h = J(`${w}-J.json`)
    const same = nat && h && nat.recs.every((r, i) => r.N === h.recs[i].N && Object.is(r.U, h.recs[i].U))
    out.controls[`same-tree ${w}`] = nat && h ? same : 'not run'
    if (nat && h && !same) out.invalid.push(`same-tree ${w}`)
  }
  // stored controls
  out.controls.CJ1 = e25?.CJ1; out.controls.CIBD = e25?.CIBD
  const cmpList = (got, ref) => { if (!got) return null; const eq = got.filter((v, i) => v === ref.list[i]).length, within = got.every((v, i) => Math.abs(v - ref.list[i]) <= ref.rest); return { equal: eq, within1: within } }
  const w35J = J('W3.5-J.json'), w354J = J('W3.5-4-J.json')
  if (w35J) { const c = cmpList(w35J.recs.map(r => r.N), PRE.CJ2), U = w35J.recs[59].U; out.controls.CJ2 = { ...c, U, ok: c.equal >= PRE.CJ2.minEqual && c.within1 && Math.abs(U - PRE.CJ2.U) <= PRE.CJ2.Utol } }
  if (w354J) { const c = cmpList(w354J.recs.map(r => r.N), PRE.CJ2_4), U = w354J.recs[59].U; out.controls.CJ2_4 = { ...c, U, ok: c.equal >= PRE.CJ2_4.minEqual && c.within1 && Math.abs(U - PRE.CJ2_4.U) <= PRE.CJ2_4.Utol } }
  const w35cold = J('native-W3.5-cold.json')   // the task's "R = 3.5, 1e-2 cold: 163 mean" (a5tol_1e-2_0.json)
  if (w35cold) { const Ns = w35cold.recs.map(r => r.N), c = cmpList(Ns, { ...PRE.CJcold, rest: 1 }), U = w35cold.recs[59].U; out.controls.CJcold = { ...c, mean: Ns.reduce((a, b) => a + b, 0) / Ns.length, U, ok: c.equal >= 57 && c.within1 && Math.abs(U - PRE.CJcold.U) <= 1e-5 } }
  // C-PP
  const cpp = pp1 ? pp1.settleBandOk : null
  out.controls.CPP_settle1 = pp1 ? { N: pp1.rec.N, band: PRE.CPP.settle1, ok: cpp } : 'not run'
  const cppFailed = pp1 && !cpp
  // cold set table
  const cold = {}
  for (const f of readdirSync(OUT)) { const m = f.match(/^cold-(.+)-(J|IBD|P1|P1J|D3|CB|BDV|P1S)\.json$/); if (m) { (cold[m[1]] ??= {})[m[2]] = J(f) } }
  out.coldTable = Object.fromEntries(Object.entries(cold).map(([s, arms]) => [s, Object.fromEntries(Object.entries(arms).map(([a, r]) => [a, { hits: r.hits, N: r.N, capHit: r.capHit, breakdown: r.breakdown, kappa: r.kappa?.kappa, trueAt: r.trueAt, s: r.info?.s }]))]))
  const pairSet = COLD_SYSTEMS.filter(s => cold[s]?.J)
  const c1 = arm => {
    const rows = pairSet.filter(s => cold[s][arm]).map(s => {
      const nJ = cold[s].J.hits['0.01'] ?? cold[s].J.hits[1e-2], nX = cold[s][arm].hits['0.01'] ?? cold[s][arm].hits[1e-2]
      const nXe = nX ?? PRE.capArm
      return { sys: s, NJ: nJ, NX: nX ?? `>${cold[s][arm].N}`, rNom: Tact(arm, nXe, 0) / Tact('J', nJ, 0), rPess: Tact(arm, nXe, 1) / Tact('J', nJ, 1) }
    })
    const medN = median(rows.map(r => r.rNom)), medP = median(rows.map(r => r.rPess)), maxP = Math.max(...rows.map(r => r.rPess))
    return { rows, medianNominal: medN, medianPess: medP, maxPess: maxP, n: rows.length, complete: rows.length === pairSet.length && pairSet.length === COLD_SYSTEMS.length, ok: medN <= PRE.C1.medianNominal && medP <= PRE.C1.medianPess && maxP <= PRE.C1.maxPess }
  }
  for (const a of ['P1', 'P1J', 'D3', 'CB', 'BDV']) out.criteria[`C1 ${a}`] = pairSet.length ? c1(a) : 'no cold set'
  // closed loops
  const loop = (w, a) => J(`${w}-${a}.json`)
  const loopCost = (w, a, JNs) => {
    const L = loop(w, a); if (!L) return null
    const Ns = L.recs.map(r => r.N), MX = warmMax(Ns), MJ = warmMax(JNs)
    const pol = a === 'J' ? prodPolicy : scaledPolicy(MX, MJ)
    const res = [0, 1].map(k => Tpol(a, Ns, k, pol))
    return { M: MX, sumNom: res[0].sum, sumPess: res[1].sum, capHits: res[1].capHits, encodeMs: res[1].encodeMsPerSolve, idleFreePess: Ns.slice(1).reduce((s, N) => s + Tact(a, N, 1), 0),
      alt: a === 'J' ? { scaledRule: Tpol('J', Ns, 1, scaledPolicy(MX, MJ)).sum } : { floor12: Tpol(a, Ns, 1, scaledPolicy(MX, MJ, 1.2)).sum, floor20: Tpol(a, Ns, 1, scaledPolicy(MX, MJ, 2.0)).sum },
      U60: L.recs[59]?.U, maxTrue: Math.max(...L.recs.map(r => r.trueRes)), breakdowns: L.recs.filter(r => r.breakdown).length, loopCapHits: L.recs.filter(r => r.capHit).length, N: Ns }
  }
  out.loops = {}
  for (const w of ['W2.5', 'W3.5', 'W3.5-4']) {
    const Jl = loop(w, 'J'); if (!Jl) continue
    const JNs = Jl.recs.map(r => r.N)
    out.loops[w] = {}
    for (const a of ['J', 'P1', 'P1J', 'D3', 'CB']) { const c = loopCost(w, a, JNs); if (c) out.loops[w][a] = c }
  }
  // the P1-family representative: lower pessimistic Σ T_pol over PP after release; over W3.5 if C-PP failed
  const repBasis = cppFailed ? 'W3.5' : 'PP'
  const cP1 = out.loops[repBasis]?.P1?.sumPess, cP1J = out.loops[repBasis]?.P1J?.sumPess
  let rep = null
  if (cP1 != null && cP1J != null) rep = Math.abs(cP1 - cP1J) <= PRE.repTie * Math.min(cP1, cP1J) ? 'P1J' : cP1 < cP1J ? 'P1' : 'P1J'
  else {
    // without closed loops the representative falls back to the cold-set C1 medians (pessimistic) — reported as such
    const m1 = out.criteria['C1 P1']?.medianPess, m2 = out.criteria['C1 P1J']?.medianPess
    if (m1 != null && m2 != null) { rep = Math.abs(m1 - m2) <= PRE.repTie * Math.min(m1, m2) ? 'P1J' : m1 < m2 ? 'P1' : 'P1J'; out.notes.push(`representative chosen on the cold-set C1 medians (no ${repBasis} closed loops): ${rep}`) }
  }
  out.representative = { arm: rep, basis: cP1 != null && cP1J != null ? repBasis : 'cold-set C1 (fallback)', P1: cP1, P1J: cP1J }
  const cand = [rep, 'D3'].filter(Boolean)
  const verdict = {}
  const Jw35 = out.loops['W3.5']?.J
  for (const a of cand) {
    const v = {}
    const C1 = out.criteria[`C1 ${a}`]
    v.C1 = typeof C1 === 'object' ? (C1.complete ? C1.ok : `${C1.ok} (incomplete cold set: ${C1.n} of ${COLD_SYSTEMS.length})`) : 'n/a'
    const X = out.loops['W3.5']?.[a]
    v.C4 = X && Jw35 ? X.sumPess <= Jw35.sumPess : 'not run'
    if (cppFailed) {
      v.C2 = 'dropped (C-PP failed)'
      v.C3p = X && Jw35 ? { reduction: Jw35.M / X.M, breakEven: PRE.C3p.breakEven[a], ok: Jw35.M / X.M >= PRE.C3p.breakEven[a] } : 'not run'
    } else { v.C2 = 'PP not run'; v.C3 = 'PP not run' }
    // C5: true residuals ≤ tol, 0 breakdowns, S0-d, cap hits ≤ J's, U bands
    const coldBad = Object.values(cold).map(s => s[a]).filter(Boolean).filter(r => r.breakdown || (r.trueAt?.['0.01'] ?? r.trueAt?.[1e-2] ?? 0) > 1e-2 * (1 + 1e-9))
    const X4 = out.loops['W3.5-4']?.[a]
    const loopsX = Object.values(out.loops).map(w => w[a]).filter(Boolean)
    const loopsJ = Object.values(out.loops).map(w => w.J).filter(Boolean)
    v.C5 = {
      coldResidualsAndBreakdowns: coldBad.length === 0,
      S0d: e25?.S0d?.[a]?.ok ?? null,
      loopResiduals: loopsX.every(l => l.maxTrue <= (l === X4 ? 1e-4 : 1e-2) * (1 + 1e-9)), loopBreakdowns: loopsX.every(l => l.breakdowns === 0),
      capHitsVsJ: loopsX.length ? loopsX.reduce((s, l) => s + l.capHits, 0) <= loopsJ.reduce((s, l) => s + l.capHits, 0) : 'no loops',
      U2: X ? { U: X.U60, dev: X.U60 / PRE.C5.Uref - 1, ok: Math.abs(X.U60 / PRE.C5.Uref - 1) <= PRE.C5.band2 } : 'not run',
      U4: X4 ? { U: X4.U60, dev: X4.U60 / PRE.C5.Uref - 1, ok: Math.abs(X4.U60 / PRE.C5.Uref - 1) <= PRE.C5.band4 } : 'not run',
    }
    const c5vals = [v.C5.coldResidualsAndBreakdowns, v.C5.S0d, v.C5.loopResiduals, v.C5.loopBreakdowns, v.C5.capHitsVsJ, v.C5.U2?.ok, v.C5.U4?.ok]
    v.C5ok = c5vals.every(x => x === true) ? true : c5vals.some(x => x === false) ? false : 'incomplete'
    verdict[a] = v
  }
  out.verdict = verdict
  // the outcome
  const c1ok = a => verdict[a]?.C1 === true, c5ok = a => verdict[a]?.C5ok === true, c5bad = a => verdict[a]?.C5ok === false
  let outcome
  if (out.invalid.length) outcome = `INVALID (${out.invalid.join(', ')})`
  else if (cand.every(a => verdict[a]?.C1 === false || c5bad(a))) outcome = 'NO-GO'
  else {
    const go = cand.filter(a => c1ok(a) && c5ok(a) && verdict[a].C4 === true && (cppFailed ? verdict[a].C3p?.ok === true : false))
    const owner = cand.filter(a => c1ok(a) && c5ok(a))
    outcome = go.length ? `GO${cppFailed ? ' (conditional: C-PP failed — the GPU stage first measures the page warm steady state behind a flag)' : ''}: ${go.length === 2 ? 'D3 unless the P1 family is ≥ 20 % cheaper' : go[0]}` : owner.length ? `OWNER (${owner.join(', ')} pass C1 and C5; ${cppFailed ? 'C3′' : 'C2/C3'} or C4 fails)` : 'INCOMPLETE (a candidate passes C1 but C5/C4 not yet measured)'
  }
  out.outcome = outcome
  // §3.9 predictions (E2.5)
  const pred = {}
  for (const a of ['P1', 'P1J', 'D3', 'CB', 'BDV']) {
    const r = cold['E2.5']?.[a]; if (!r) continue
    const p = PRE.predict[a], h2 = r.hits['0.01'] ?? r.hits[1e-2], h4 = r.hits['0.0001'] ?? r.hits[1e-4], k = r.kappa?.kappa
    pred[a] = { e2: { got: h2, range: p.e2, held: h2 >= p.e2[0] && h2 <= p.e2[1] }, e4: { got: h4, range: p.e4, held: h4 >= p.e4[0] && h4 <= p.e4[1] },
      kappa: p.kappa ? { got: k, pred: p.kappa, held: p.kappaMax ? k <= p.kappaMax : k >= p.kappaNear / PRE.predict.kappaNearFactor && k <= p.kappaNear * PRE.predict.kappaNearFactor } : undefined,
      breakEvenN: { threshold: p.breakEven, got: h2, within: h2 <= p.breakEven } }
  }
  const ps = cold['E2.5']?.P1S
  if (ps) pred.P1S = { e2: ps.hits['0.01'] ?? ps.hits[1e-2], kappa: ps.kappa?.kappa, above2xModel: (ps.hits['0.01'] ?? ps.hits[1e-2]) > PRE.predict.P1S.e2Above || ps.kappa?.kappa > PRE.predict.P1S.kappaAbove }
  out.predictions = pred
  writeJSON('decision.json', out)
  log(JSON.stringify(out, null, 1))
}

/** EXPLORATORY implementation check (added after the first cold numbers; cannot change the decision): the P1 structure.
 *  With an exact pivot, M = [[A_PP, A_PT], [A_TP, D_T + A_TP·A_PP⁻¹·A_PT]] shares A's P-columns, so M⁻¹·A·x = x for every x
 *  supported on P — a sign or block error in A_TP/A_PT breaks it. Also reports ‖M⁻¹Ax − x‖ for the V-cycle pivot (P1). */
function runVerify(name = 'E2.5') {
  printPre()
  const S = loadSystem(name), ops = makeOps(S), rng = mulberry(31)
  const out = {}
  for (const a of ['P1S', 'P1']) {
    const arm = makeArm(a, S, ops), x = new Float64Array(S.nR), Ax = new Float64Array(S.nR), z = new Float64Array(S.nR)
    let worst = 0
    for (let t = 0; t < 3; t++) {
      x.fill(0); for (const p of ops.P) x[p] = randn(rng)
      ops.apply(x, Ax); arm.prec(Ax, z)
      let d = 0; for (let r = 0; r < S.nR; r++) d = Math.max(d, Math.abs(z[r] - x[r]))
      worst = Math.max(worst, d / infNorm(x))
    }
    out[a] = { relErr: worst, s: arm.s }
    log(`verify ${name} ${a}: max ‖M⁻¹Ax − x‖∞/‖x‖∞ over 3 random x on P ${worst.toExponential(2)}${a === 'P1S' ? ' (exact pivot: must be ≈ 0 — the block structure is right)' : ` (V-cycle pivot, s = ${arm.s.toFixed(4)})`}`)
  }
  // why s < 1 on the ball scenes: λ̂max of P̂⁻¹A_PP with and without the rank-3 (ball) term
  const M = stokesMG(S), withV = pivotLambda(S, ops, M), S0 = { ...S, KVinv: 0 }, noV = pivotLambda(S0, makeOps(S0), M)
  out.lambda = { withRank3: withV, withoutRank3: noV }
  log(`verify ${name}: 30-step Lanczos of P̂⁻¹A_PP (s = 1): λ̂ ∈ [${withV.lmin.toFixed(3)}, ${withV.lmax.toFixed(3)}] with the rank-3 term, [${noV.lmin.toFixed(3)}, ${noV.lmax.toFixed(3)}] without it`)
  // EXPLORATORY variants (cannot change the decision): P1 / P1J with s = 1 instead of the pre-registered s rule
  out.sOne = {}
  const Aind = makeIndependentOp(S)
  for (const a of ['P1', 'P1J']) {
    const arm = makeArm(a, S, ops, { sHeld: 1 })
    const o = solve(S, ops, arm, { tol: 1e-6, cap: PRE.capArm, hits: PRE.tolsCold, keepY: true })
    const tr = o.yAt[1e-2] ? trueResidual(S, Aind, o.yAt[1e-2]).inf : NaN
    out.sOne[a] = { hits: o.hits, N: o.N, breakdown: o.breakdown, true1e2: tr }
    log(`verify ${name} EXPLORATORY ${a} with s = 1: ${PRE.tolsCold.map(t => o.hits[t] ?? `>${o.N}`).join(' / ')}${o.breakdown ? ` BREAKDOWN ${o.breakdown}` : ''}; true ‖r‖∞ at 1e-2 ${tr.toExponential(2)}`)
  }
  writeJSON(`verify-${name}.json`, { scene: 'verify', system: name, ...out, ok: out.P1S.relErr <= 1e-9 })
}

// ───────────────────────────────────────────── dispatch
if (SCENE === 'E2.5' || SCENE === 'E3.5') runE(SCENE)
else if (SCENE === 'verify') runVerify(ARGS[0] ?? 'E2.5')
else if (SCENE?.startsWith('native-W')) runNative(SCENE)
else if (['W2.5', 'W3.5', 'W3.5-4'].includes(SCENE)) { if (ARGS.length !== 1 || !['J', 'P1', 'P1J', 'D3', 'CB'].includes(ARGS[0])) throw new Error('closed loop: one arm of J P1 P1J D3 CB'); runW(SCENE, ARGS[0]) }
else if (SCENE === 'PP1') runPP1()
else if (SCENE === 'cold') runCold(ARGS.length ? ARGS : ALL_ARMS)
else if (SCENE === 'decide') { printPre(); decide() }
else { log('usage: node scripts/studies/g4-precond-study.mjs <selftest|E2.5|E3.5|native-W2.5|native-W3.5|native-W3.5-4|native-W3.5-cold|W2.5|W3.5|W3.5-4|PP1|cold|decide|verify> [arm …] [--out DIR]'); process.exit(1) }
log(`\ndone (${((Date.now() - T0) / 1000).toFixed(0)} s)`)
