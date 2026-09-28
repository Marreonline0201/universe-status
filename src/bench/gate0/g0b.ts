/// <reference types="@webgpu/types" />
// G0-b — GPU Jacobi-PCG and MGPCG (src/gpu-sim/flip/poisson) against the numpy reference
// (bench/offline/poisson_ref.py) on IDENTICAL problems, then timing (FINAL-PLAN §7 S0.5).
//
// Correctness ladder (each step isolates one component). Every pass rule below was fixed BEFORE
// the run that reports it; none is ever widened to make a result pass.
//   1. operator      A.x   vs numpy float64 on a fixed random x
//   2. preconditioner M.r (one V-cycle) vs numpy float64 on a fixed random r
//      on dam_break, tank_half + interior ball, tank_half + odd step (McAdams coarse rule with
//      interior solids), and a variable-coefficient + extra-diagonal field on the ball domain.
//      pass: max|gpu - np64| / max|np64| <= 4 * max(numpy f32-vs-f64 relative error of the same
//      fixture, 2^-23)
//   3. every case: GPU iteration count within +-2 of numpy f64 AND of numpy f32 (FINAL-PLAN G0-b);
//      warm cases start from the SAME x0 (numpy f64 solution rounded to f32, uploaded); residual
//      history compared.
//   4. true residual, recomputed on the CPU in f64 from the GPU's x (the recursive residual is
//      not trusted by itself). GATE (fixed 2026-09-28, before the run): for every production case
//      (solve class p or psi) the MGPCG true ||r||_inf <= tol. JPCG and the rel2 parity cases are
//      REPORTED next to numpy float32's own true residual, not gated (f32 recursive-residual drift
//      is a property of the arithmetic, visible in numpy f32 as well).
//   5. zero right-hand side: b = 0 with a stale nonzero warm x must be iterated (inf criterion) and
//      never accepted as converged (rel2 criterion); b = 0 from x = 0 converges at iteration 0.
// Timing (pass timestamps, median of `reps`):
//   t_iter = slope of T(N) over N with tol < 0 (exactly N iterations execute)
//   T_exact = solve encoded with cap = its iteration count; T_cap = at the production cap
//   (p95 + 2 of this run's GPU counts, per solve class), including early-exit no-op iterations
//   prepare pass, one V-cycle, and the single-workgroup tail (coarse) kernel timed separately.
import { PoissonSolver, type SolveConfig, type SolverMethod, type SolveStats, LABEL_FLUID, LABEL_SOLID } from '../../gpu-sim/flip/poisson/PoissonSolver'
import { GpuTimer, linfit, timingInvalid, median, quantile, type Gate0Device } from './gpu'

interface NpRes { iters: number | null; ran: number; true_rel2: number; true_inf: number; hist_rel2: number[]; hist_inf: number[] }
type SolveClass = 'parity' | 'p' | 'psi'
interface CaseEntry {
  name: string; domain: string; criterion: 'inf' | 'rel2'; tol: number; note: string; solve: SolveClass; source: string
  rhs: string; binf: number; b2: number; x0?: string; x0_note?: string; fcoef?: string
  numpy: { f64: Record<SolverMethod, NpRes>; f32: Record<SolverMethod, NpRes> }
}
interface UnitEntry {
  name: string; domain: string; fcoef: string | null; x: string; r: string
  Ax_f64: string; Ax_f32: string; Mr_f64: string; Mr_f32: string
}
interface Manifest {
  n: number; padded: number; dx_m: number; g_mps2: number; numpy: string
  domains: Record<string, { file: string; fluid_cells: number }>
  fcoef: Record<string, { file: string; domain: string; note: string }>
  cases: CaseEntry[]
  unit: UnitEntry[]
  mg: Record<string, unknown>
}

export interface G0bParams {
  n?: number
  methods?: SolverMethod[]
  timing?: boolean
  reps?: number
  caseFilter?: string
  fixturesUrl?: string
  /** only the unit fixtures (operator / preconditioner), e.g. for a mutation check */
  unitOnly?: boolean
}

const F32_EPS = 2 ** -23
// Water at 20 degC, 0.101325 MPa: 998.207 kg/m^3 (NIST Chemistry WebBook, IAPWS-95 isobar).
// Source: https://webbook.nist.gov/cgi/fluid.cgi?Action=Load&ID=C7732185&Type=IsoBar&Digits=6&P=0.101325&THigh=25&TLow=15&TInc=5&RefState=DEF&TUnit=C&PUnit=MPa&DUnit=kg%2Fm3&HUnit=kJ%2Fmol&WUnit=m%2Fs&VisUnit=Pa*s&STUnit=N%2Fm
// Used only to give the coefficient-scaling checks a production-sized a_f = dt/(rho dx^2).
const RHO_WATER_20C = 998.207

async function fetchBin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status} (run: python bench/offline/poisson_ref.py --n <N>)`)
  return r.arrayBuffer()
}

/**
 * f64 CPU residual b - A x for labels + face coefficients: either a uniform nominal a (every face)
 * or a padded vec4 array (a-x, a-y, a-z, extraDiag) in the solver's layout. A face is open iff
 * neither cell is SOLID; diag = sum of open faces + extraDiag; off-diagonals to FLUID neighbours.
 */
function trueResidual(labels: Uint8Array, P: number, coef: number | Float32Array, x: Float32Array, b: Float32Array): { rel2: number; inf: number } {
  const sy = P, sz = P * P
  let r2 = 0, b2 = 0, inf = 0
  const uni = typeof coef === 'number' ? coef : 0
  const fc = typeof coef === 'number' ? null : coef
  // [neighbour offset, index of the cell that owns the face (minus-face convention), component]
  const faces: [number, number, number][] = [[1, 1, 0], [-1, 0, 0], [sy, sy, 1], [-sy, 0, 1], [sz, sz, 2], [-sz, 0, 2]]
  for (let k = 1; k < P - 1; k++) for (let j = 1; j < P - 1; j++) for (let i = 1; i < P - 1; i++) {
    const c = i + sy * j + sz * k
    if (labels[c] !== LABEL_FLUID) continue
    let diag = fc ? fc[4 * c + 3] : 0, off = 0
    for (const [o, own, comp] of faces) {
      const l = labels[c + o]
      if (l === LABEL_SOLID) continue
      const a = fc ? fc[4 * (c + own) + comp] : uni
      diag += a
      if (l === LABEL_FLUID) off += a * x[c + o]
    }
    const r = b[c] - (diag * x[c] - off)
    r2 += r * r; b2 += b[c] * b[c]
    if (Math.abs(r) > inf) inf = Math.abs(r)
  }
  return { rel2: b2 > 0 ? Math.sqrt(r2 / b2) : 0, inf }
}

function maxAbsDiff(gpu: Float32Array, ref: Float32Array): { maxAbs: number; refMax: number } {
  let m = 0, rm = 0
  for (let i = 0; i < ref.length; i++) { m = Math.max(m, Math.abs(gpu[i] - ref[i])); rm = Math.max(rm, Math.abs(ref[i])) }
  return { maxAbs: m, refMax: rm }
}

/** max over the common range of |log10(gpu/np)| of the residual curve used by the criterion */
function historyDeviation(gpu: number[], np: number[]): { maxAbsLog10: number; atIter: number; len: number } {
  let worst = 0, at = -1
  const len = Math.min(gpu.length, np.length)
  for (let k = 0; k < len; k++) {
    if (!(gpu[k] > 0) || !(np[k] > 0) || !Number.isFinite(np[k])) continue
    const d = Math.abs(Math.log10(gpu[k] / np[k]))
    if (d > worst) { worst = d; at = k }
  }
  return { maxAbsLog10: worst, atIter: at, len }
}

export async function runG0b(g: Gate0Device, p: G0bParams = {}) {
  const device = g.device
  const n = p.n ?? 64
  const methods = p.methods ?? ['mgpcg', 'jpcg']
  const reps = p.reps ?? 5
  const base = p.fixturesUrl ?? `/bench-results/gate0/fixtures/n${n}/`
  const manifest: Manifest = await (await fetch(base + 'manifest.json')).json()
  if (manifest.n !== n) throw new Error(`manifest n ${manifest.n} != ${n}`)
  if (!Array.isArray(manifest.unit)) throw new Error('fixture manifest predates the unit-fixture list: regenerate with python bench/offline/poisson_ref.py')
  const P = manifest.padded
  const binCache = new Map<string, ArrayBuffer>()
  const bin = async (file: string) => { let v = binCache.get(file); if (!v) { v = await fetchBin(base + file); binCache.set(file, v) } return v }
  const labelsOf = async (dom: string) => {
    const l = new Uint8Array(await bin(manifest.domains[dom].file))
    if (l.length !== P * P * P) throw new Error(`labels ${dom}: ${l.length}`)
    return l
  }
  const f32 = async (file: string): Promise<Float32Array<ArrayBuffer>> => new Float32Array((await bin(file)).slice(0))
  const fcoefOf = async (name: string) => {
    const f = await f32(manifest.fcoef[name].file)
    if (f.length !== 4 * P * P * P) throw new Error(`fcoef ${name}: ${f.length}`)
    return f
  }

  const solvers: Partial<Record<SolverMethod, PoissonSolver>> = {}
  for (const m of methods) solvers[m] = await PoissonSolver.create(device, { nx: n, ny: n, nz: n, method: m, historyCap: 4096 })
  const current = new Map<SolverMethod, string>()
  /** labels + coefficients (uniform value, or a named fcoef fixture) + operator build */
  const setDomain = async (m: SolverMethod, dom: string, coef: number | string = 1) => {
    const s = solvers[m]!
    const key = `${dom}|${coef}`
    if (current.get(m) === key) return
    s.writeLabels(await labelsOf(dom))
    if (typeof coef === 'number') s.writeUnitCoefficients(coef)
    else s.writeFaceCoefficients(await fcoefOf(coef))
    const enc = device.createCommandEncoder()
    s.encodePrepare(enc)
    device.queue.submit([enc.finish()])
    await device.queue.onSubmittedWorkDone()
    current.set(m, key)
  }
  const cfgCache = new Map<string, SolveConfig>()
  const cfgFor = (m: SolverMethod, criterion: 'inf' | 'rel2', tol: number, cap: number) => {
    const key = `${m}|${criterion}|${tol}|${cap}`
    let c = cfgCache.get(key)
    if (!c) { c = solvers[m]!.createSolveConfig({ criterion, tol, cap }); cfgCache.set(key, c) }
    return c
  }
  const solve = (m: SolverMethod, cfg: SolveConfig, warm: boolean, tw?: GPUComputePassTimestampWrites) => {
    const enc = device.createCommandEncoder()
    const nd = solvers[m]!.encodeSolve(enc, cfg, { warmStart: warm, timestampWrites: tw })
    return { cb: enc.finish(), dispatches: nd }
  }

  // ── 1+2: operator and preconditioner fixtures ────────────────────────────────────────────
  const unit: Record<string, { relErr: number; numpyF32RelErr: number; limit: number; pass: boolean; relErrVsNumpyF32?: number }> = {}
  for (const U of manifest.unit) {
    const x = await f32(U.x), r = await f32(U.r)
    const ax64 = await f32(U.Ax_f64), ax32 = await f32(U.Ax_f32)
    const mr64 = await f32(U.Mr_f64), mr32 = await f32(U.Mr_f32)
    for (const m of methods) {
      await setDomain(m, U.domain, U.fcoef ?? 1)
      const s = solvers[m]!
      s.writeD(x)
      let enc = device.createCommandEncoder()
      s.encodeApplyA(enc)
      device.queue.submit([enc.finish()])
      const q = await s.readVector('q')
      const e = maxAbsDiff(q, ax64), e32 = maxAbsDiff(ax32, ax64)
      const limA = 4 * Math.max(e32.maxAbs / e32.refMax, F32_EPS)
      unit[`${m}:${U.name}:Ax`] = { relErr: e.maxAbs / e.refMax, numpyF32RelErr: e32.maxAbs / e32.refMax, limit: limA, pass: e.maxAbs / e.refMax <= limA }
      if (m === 'mgpcg') {
        s.writeR(r)
        enc = device.createCommandEncoder()
        s.encodeApplyPreconditioner(enc)
        device.queue.submit([enc.finish()])
        const z = await s.readVector('z')
        const em = maxAbsDiff(z, mr64), em32 = maxAbsDiff(mr32, mr64), emg32 = maxAbsDiff(z, mr32)
        const limM = 4 * Math.max(em32.maxAbs / em32.refMax, F32_EPS)
        unit[`${m}:${U.name}:Mr`] = { relErr: em.maxAbs / em.refMax, relErrVsNumpyF32: emg32.maxAbs / emg32.refMax, numpyF32RelErr: em32.maxAbs / em32.refMax, limit: limM, pass: em.maxAbs / em.refMax <= limM }
      }
    }
  }
  const unitPass = Object.values(unit).every(u => u.pass)
  if (p.unitOnly) {
    for (const s of Object.values(solvers)) s?.destroy()
    return { test: 'g0b', n, methods, unitOnly: true, manifestNumpy: manifest.numpy, unit, unitPass, casePass: true, trueResidualPass: true, scaledPass: true }
  }

  // ── 3+4: every case, correctness ─────────────────────────────────────────────────────────
  const CAP_CORRECT: Record<SolverMethod, number> = { mgpcg: 200, jpcg: 4000 }
  const cases = manifest.cases.filter(c => !p.caseFilter || c.name.includes(p.caseFilter))
  const results: Record<string, unknown>[] = []
  const gpuIters = new Map<string, number>()
  for (const c of cases) {
    const coef = c.fcoef ?? 1
    const b = await f32(c.rhs)
    const x0 = c.x0 ? await f32(c.x0) : null
    for (const m of methods) {
      const s = solvers[m]!
      await setDomain(m, c.domain, coef)
      s.writeRhs(b)
      if (x0) s.writeSolution(x0)
      const { cb, dispatches } = solve(m, cfgFor(m, c.criterion, c.tol, CAP_CORRECT[m]), !!x0)
      device.queue.submit([cb])
      const st: SolveStats = await s.readStats(true)
      const x = await s.readVector('x')
      const tr = trueResidual(await labelsOf(c.domain), P, c.fcoef ? await fcoefOf(c.fcoef) : 1, x, b)
      const np64 = c.numpy.f64[m], np32 = c.numpy.f32[m]
      const gi = st.converged && !st.breakdown ? st.iterations : null
      const within = (a: number | null, b2: number | null) => a !== null && b2 !== null && Math.abs(a - b2) <= 2
      const hist = st.history!
      const gpuCurve = c.criterion === 'rel2' ? hist.rel2 : hist.inf
      const npCurve32 = c.criterion === 'rel2' ? np32.hist_rel2 : np32.hist_inf
      const npCurve64 = c.criterion === 'rel2' ? np64.hist_rel2 : np64.hist_inf
      if (gi !== null) gpuIters.set(`${m}|${c.name}`, gi)
      const trueMetric = c.criterion === 'rel2' ? tr.rel2 : tr.inf
      const gated = c.solve !== 'parity' && m === 'mgpcg'
      results.push({
        name: c.name, source: c.source, method: m, solve: c.solve, criterion: c.criterion, tol: c.tol, binf: c.binf, warm: !!x0, fcoef: c.fcoef ?? null,
        gpu: { iters: gi, converged: st.converged, breakdown: st.breakdown, rInf: st.rInf, rInf0: st.rInf0, rel2: st.rel2, trueRel2: tr.rel2, trueInf: tr.inf, dispatchesEncoded: dispatches },
        numpy: { f64: np64.iters, f32: np32.iters, f64TrueInf: np64.true_inf, f32TrueRel2: np32.true_rel2, f32TrueInf: np32.true_inf },
        matchF64: within(gi, np64.iters), matchF32: within(gi, np32.iters),
        pass: within(gi, np64.iters) && within(gi, np32.iters),
        trueResidual: { metric: c.criterion, value: trueMetric, numpyF32: c.criterion === 'rel2' ? np32.true_rel2 : np32.true_inf, withinTol: trueMetric <= c.tol, gated },
        historyVsNumpyF32: historyDeviation(gpuCurve, npCurve32),
        historyVsNumpyF64: historyDeviation(gpuCurve, npCurve64),
        gpuHistory: gpuCurve.slice(0, 40),
      })
    }
  }
  const casePass = results.every(r => r.pass)
  const trueResidualPass = results.every(r => { const t = r.trueResidual as { withinTol: boolean; gated: boolean }; return !t.gated || t.withinTol })

  // ── scaled coefficients a_f = dt/(rho dx^2) (the production pressure operator, unknown p in Pa) ──
  //  (a) iteration count must equal the unit-coefficient run within +-1 (CG + this MG are scale
  //      invariant in exact arithmetic)
  //  (b) discrete hydrostatic solver check: a full-width still layer of N cells after one gravity
  //      step from rest has the exact DISCRETE solution p_y = rho g dx (N - y) of this voxel system
  //      (free surface at the first AIR cell centre). This checks the solver against the exact
  //      solution of the linear system it is given; it is NOT a physics validation of
  //      rho g (depth) with a sub-cell surface. Solved to rel2 1e-5; pass if max|p/p_exact - 1| <= 1e-3.
  const scaled: Record<string, unknown>[] = []
  {
    const dt = 1 / 120
    const a = dt / (RHO_WATER_20C * manifest.dx_m * manifest.dx_m)
    const c = manifest.cases.find(q => q.name === 'pub/perfcritic/dam_break/gravity_only')
    const h = manifest.cases.find(q => q.name === 'pub/perfcritic/tank_half/gravity_only')
    for (const m of methods) {
      const s = solvers[m]!
      if (c) {
        await setDomain(m, c.domain, a)
        const b = await f32(c.rhs)
        s.writeRhs(b)
        const { cb } = solve(m, cfgFor(m, c.criterion, c.tol, CAP_CORRECT[m]), false)
        device.queue.submit([cb])
        const st = await s.readStats(false)
        const x = await s.readVector('x')
        const tr = trueResidual(await labelsOf(c.domain), P, a, x, b)
        const unitIters = gpuIters.get(`${m}|${c.name}`) ?? null
        scaled.push({ check: 'scale-invariance', name: c.name, method: m, a_f: a, iters: st.converged ? st.iterations : null, unitIters, trueInf: tr.inf,
          pass: unitIters !== null && st.converged && Math.abs(st.iterations - unitIters) <= 1 })
      }
      if (h) {
        await setDomain(m, h.domain, a)
        const b = await f32(h.rhs)
        s.writeRhs(b)
        const { cb } = solve(m, cfgFor(m, 'rel2', 1e-5, CAP_CORRECT[m]), false)
        device.queue.submit([cb])
        const st = await s.readStats(false)
        const x = await s.readVector('x')
        const lab = await labelsOf(h.domain)
        const layers = n / 2
        let worst = 0, pBottom = 0
        for (let k = 1; k <= n; k++) for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
          const idx = i + P * (j + P * k)
          if (lab[idx] !== LABEL_FLUID) continue
          const y = j - 1
          const exact = RHO_WATER_20C * manifest.g_mps2 * manifest.dx_m * (layers - y)
          worst = Math.max(worst, Math.abs(x[idx] / exact - 1))
          if (y === 0) pBottom = Math.max(pBottom, x[idx])
        }
        const exactBottom = RHO_WATER_20C * manifest.g_mps2 * manifest.dx_m * layers
        scaled.push({ check: 'hydrostatic-discrete', name: h.name, method: m, a_f: a, iters: st.iterations, converged: st.converged,
          pBottomPa: pBottom, pBottomExactPa: exactBottom, maxRelErr: worst, pass: st.converged && worst <= 1e-3 })
      }
    }
  }

  // ── warm start across a label change (production: labels move every substep, x keeps stale
  //    values where cells stopped being FLUID). Solve dam_break impact cold, switch the labels to
  //    the wedge, warm-solve the wedge impact from the GPU's OWN x. Pass (fixed in advance):
  //    converged and the TRUE residual, recomputed on the CPU in f64 from the GPU's x, is <= tol.
  const relabel: Record<string, unknown>[] = []
  const zeroRhs: Record<string, unknown>[] = []
  {
    const a = manifest.cases.find(q => q.name === 'pub/perfcritic/dam_break/impact_only')
    const w = manifest.cases.find(q => q.name === 'pub/reviewB/wedge/impact_u6')
    if (a && w) {
      for (const m of methods) {
        const s = solvers[m]!
        await setDomain(m, a.domain)
        s.writeRhs(await f32(a.rhs))
        let r = solve(m, cfgFor(m, a.criterion, a.tol, CAP_CORRECT[m]), false)
        device.queue.submit([r.cb])
        await s.readStats(false)
        await setDomain(m, w.domain)             // new labels + operator; x is NOT cleared
        const b = await f32(w.rhs)
        s.writeRhs(b)
        r = solve(m, cfgFor(m, w.criterion, w.tol, CAP_CORRECT[m]), true)
        device.queue.submit([r.cb])
        const st = await s.readStats(false)
        const x = await s.readVector('x')
        const tr = trueResidual(await labelsOf(w.domain), P, 1, x, b)
        relabel.push({ from: a.name, to: w.name, method: m, iters: st.iterations, coldIters: gpuIters.get(`${m}|${w.name}`) ?? null,
          converged: st.converged, recursiveInf: st.rInf, trueInf: tr.inf, tol: w.tol, pass: st.converged && !st.breakdown && tr.inf <= w.tol })

        // ── 5: b = 0 with the stale x of the wedge solve (nonzero), same labels
        const zero = new Float32Array(P * P * P)
        s.writeRhs(zero)
        const xStale = await s.readVector('x')
        let maxStale = 0
        for (const v of xStale) maxStale = Math.max(maxStale, Math.abs(v))
        // (a) inf criterion: must iterate and reach true ||A x||_inf <= tol
        r = solve(m, cfgFor(m, 'inf', 1e-2, CAP_CORRECT[m]), true)
        device.queue.submit([r.cb])
        const sa = await s.readStats(false)
        const xa = await s.readVector('x')
        const ta = trueResidual(await labelsOf(w.domain), P, 1, xa, zero)
        zeroRhs.push({ method: m, check: 'b=0, stale warm x, inf 1e-2', staleMaxAbsX: maxStale, rInf0: sa.rInf0, iters: sa.iterations, converged: sa.converged, trueInf: ta.inf,
          pass: sa.converged && !sa.breakdown && sa.iterations >= 1 && ta.inf <= 1e-2 })
        // (b) rel2 criterion from a stale x: relative residual undefined -> never accepted
        s.writeSolution(new Float32Array(xStale))
        r = solve(m, cfgFor(m, 'rel2', 1e-4, 5), true)
        device.queue.submit([r.cb])
        const sb = await s.readStats(false)
        zeroRhs.push({ method: m, check: 'b=0, stale warm x, rel2 1e-4, cap 5', iters: sb.iterations, converged: sb.converged, pass: !sb.converged && !sb.breakdown && sb.iterations === 5 })
        // (c) b = 0 from x = 0: converged at iteration 0
        r = solve(m, cfgFor(m, 'rel2', 1e-4, 5), false)
        device.queue.submit([r.cb])
        const sc = await s.readStats(false)
        zeroRhs.push({ method: m, check: 'b=0, cold x=0, rel2', iters: sc.iterations, converged: sc.converged, pass: sc.converged && sc.iterations === 0 })
      }
    }
  }
  // sticky fault counters: case (b) above hit its cap without converging exactly once per method
  const faults: Record<string, unknown> = {}
  for (const m of methods) {
    const f = await solvers[m]!.readFaults()
    faults[m] = { ...f, pass: f.capHits >= 1 && f.breakdowns === 0 }
  }

  // ── production caps from this run: p95 + 2 per solve class (FINAL-PLAN §5.1) ─────────────
  const caps: Record<string, Record<string, number | null>> = {}
  const capBasis: Record<string, Record<string, number[]>> = {}
  for (const m of methods) {
    caps[m] = {}
    capBasis[m] = {}
    for (const cls of ['p', 'psi'] as const) {
      const its = cases.filter(c => c.solve === cls).map(c => gpuIters.get(`${m}|${c.name}`)).filter((v): v is number => v !== undefined)
      caps[m][cls] = its.length ? quantile(its, 0.95) + 2 : null
      capBasis[m][cls] = its.sort((x, y) => x - y)
    }
  }

  // ── timing ───────────────────────────────────────────────────────────────────────────────
  let timing: Record<string, unknown> | null = null
  if (p.timing !== false) {
    const timer = new GpuTimer(device, 1)
    const allNs: number[] = []
    const timeCb = async (build: (tw: GPUComputePassTimestampWrites) => GPUCommandBuffer, before?: () => Promise<void>) => {
      const ns: number[] = []
      for (let r = 0; r < reps + 1; r++) {
        if (before) await before()
        const cb = build(timer.whole(0))
        device.queue.submit([cb])
        const enc = device.createCommandEncoder()
        timer.resolve(enc, 1)
        device.queue.submit([enc.finish()])
        await device.queue.onSubmittedWorkDone()
        const [v] = await timer.read(1)
        if (r > 0) ns.push(v)          // first run = warm-up
      }
      allNs.push(...ns)
      return median(ns) / 1e6           // ms
    }
    const perDomain: Record<string, unknown>[] = []
    const perCase: Record<string, unknown>[] = []
    const domains = [...new Set(cases.filter(c => !c.fcoef).map(c => c.domain))]
    for (const m of methods) {
      const s = solvers[m]!
      const Ns = m === 'mgpcg' ? [5, 10, 20] : [50, 100, 200]
      for (const dom of domains) {
        await setDomain(m, dom)
        const c0 = cases.find(c => c.domain === dom && !c.fcoef)!
        s.writeRhs(await f32(c0.rhs))
        const prepMs = await timeCb(tw => { const e = device.createCommandEncoder(); s.encodePrepare(e, tw); return e.finish() })
        const TN: number[] = []
        for (const N of Ns) TN.push(await timeCb(tw => { const e = device.createCommandEncoder(); s.encodeSolve(e, cfgFor(m, 'inf', -1, N), { warmStart: false, timestampWrites: tw }); return e.finish() }))
        const fit = linfit(Ns, TN)
        // did the tol<0 runs really execute N iterations? (breakdown would stop early)
        const chk = await s.readStats(false)
        const row: Record<string, unknown> = { method: m, domain: dom, prepareMs: prepMs, N: Ns, T_N_ms: TN, tIterMs: fit.slope, initMs: fit.intercept, r2: fit.r2, lastRunIters: chk.iterations, lastRunBreakdown: chk.breakdown, tIterValid: chk.iterations === Ns[Ns.length - 1] && !chk.breakdown, dispatchesPerIter: s.dispatches.perIteration, dispatchesInit: s.dispatches.init }
        if (m === 'mgpcg') {
          const vc = await timeCb(tw => { const e = device.createCommandEncoder(); s.encodeVcycleOnly(e, 10, tw); return e.finish() })
          const tl = await timeCb(tw => { const e = device.createCommandEncoder(); s.encodeTailOnly(e, 50, tw); return e.finish() })
          row.vcycleMs = vc / 10
          row.tailKernelMs = tl / 50
          row.tailLevels = s.levels.slice(s.tail).map(L => `${L.nx}x${L.ny}x${L.nz}`)
        }
        perDomain.push(row)
      }
      if (m !== 'mgpcg') continue          // per-case production timing: the shipping solver only
      for (const c of cases) {
        if (c.solve === 'parity') continue
        const gi = gpuIters.get(`${m}|${c.name}`)
        if (gi === undefined) continue
        await setDomain(m, c.domain, c.fcoef ?? 1)
        const b = await f32(c.rhs)
        s.writeRhs(b)
        const x0 = c.x0 ? await f32(c.x0) : null
        const warm = !!x0
        const before = x0 ? async () => { s.writeSolution(x0) } : undefined
        const tExact = await timeCb(tw => { const e = device.createCommandEncoder(); s.encodeSolve(e, cfgFor(m, c.criterion, c.tol, Math.max(1, gi)), { warmStart: warm, timestampWrites: tw }); return e.finish() }, before)
        const cap = caps[m][c.solve]
        let tCap: number | null = null
        let encodeCapMs: number | null = null
        if (cap !== null && cap !== undefined) {
          tCap = await timeCb(tw => { const e = device.createCommandEncoder(); s.encodeSolve(e, cfgFor(m, c.criterion, c.tol, cap), { warmStart: warm, timestampWrites: tw }); return e.finish() }, before)
          // main-thread CPU cost of encoding this solve (setPipeline/setBindGroup/dispatch per kernel)
          const encMs: number[] = []
          for (let r = 0; r < reps; r++) {
            const t0 = performance.now()
            const e = device.createCommandEncoder()
            s.encodeSolve(e, cfgFor(m, c.criterion, c.tol, cap), { warmStart: warm })
            e.finish()
            encMs.push(performance.now() - t0)
          }
          encodeCapMs = median(encMs)
        }
        perCase.push({
          name: c.name, method: m, solve: c.solve, domain: c.domain, warm, iters: gi, cap, T_exact_ms: tExact, T_cap_ms: tCap,
          skippedIterMs: tCap !== null && cap !== null && cap > gi ? (tCap - tExact) / (cap - gi) : null,
          dispatchesAtCap: cap !== null ? s.dispatches.init + cap * s.dispatches.perIteration + s.dispatches.finalize : null, encodeCapMs,
        })
      }
    }
    timer.destroy()
    timing = { reps, invalidTimestamps: timingInvalid(allNs), perDomain, perCase }
  }

  const solverInfo = methods.map(m => {
    const s = solvers[m]!
    return { method: m, levels: s.levels.map(L => `${L.nx}x${L.ny}x${L.nz}`), tailFromLevel: s.tail, dispatches: s.dispatches }
  })
  for (const s of Object.values(solvers)) s?.destroy()
  const scaledPass = scaled.every(r => r.pass) && relabel.every(r => r.pass) && zeroRhs.every(r => r.pass) && Object.values(faults).every(f => (f as { pass: boolean }).pass)
  return {
    test: 'g0b', n, methods, solverInfo,
    manifestNumpy: manifest.numpy, unit, unitPass, cases: results, casePass, trueResidualPass, scaled, relabel, zeroRhs, faults, scaledPass, caps, capBasis, timing,
  }
}
