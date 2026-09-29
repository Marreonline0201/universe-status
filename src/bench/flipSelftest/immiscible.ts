/// <reference types="@webgpu/types" />
// S3.5-i on the GPU (flip-selftest.html): the immiscible drift flux (ImmiscibleSolver, immiscible.wgsl) against the f64
// reference flipRef.driftFlux on IDENTICAL inputs — the same f32 particle positions, slip history, face velocities,
// pressure and labels on both sides — K30–K32; then s35i-ref scenes on the GPU path. Metrics only —
// scripts/fluid-gates/s35i-gpu.mjs applies the tolerances. Every bound below is derived from f32 rounding (u = 2^-24;
// WGSL: × − + and conversions correctly rounded, ÷ 2.5 ulp, pow via exp2(y·log2 x) ≤ 64 ulp here, exp (3 + 2|x|) ulp).
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, makeParticles, dragFactor, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { INCOMPRESSIBLE_NU_NUM } from '../../composition/liquidGate'
import { DX, L_REF, TAU, submit, mulberry32 } from './util'

import { LIQUIDS, waterDensity, HG_RHO_20C } from '../../composition/materialData'

const G = 9.80665
const U = 2 ** -24, PW = 64 * U
/** The liquids at 20 °C (materialData, sourced there; the s35i-ref gate uses the same). */
export const IMM = {
  water: { rho: waterDensity(20), mu: LIQUIDS.water.viscosity(20) },
  oil: { rho: LIQUIDS['olive-oil'].density(20), mu: LIQUIDS['olive-oil'].viscosity(20) },
  mercury: { rho: HG_RHO_20C, mu: LIQUIDS.mercury.viscosity(20) },
  ethanol: { rho: LIQUIDS.ethanol.density(20), mu: LIQUIDS.ethanol.viscosity(20) },
}
// pair tensions of the reference gate (spec §8): olive oil–water, mercury–water; the rest unsourced or miscible
const SIGMA: Record<string, number> = { 'oil|water': 0.0245, 'mercury|water': 0.375 }
type MatName = keyof typeof IMM

interface Scene { L: GridLayout; p: RefParticles; ids: number[]; names: MatName[]; drop?: number }

/** 8 ppc over cells [0, n) × [0, depth) × [0, n): material by `pick(q, x, y, z)` (an index into `names`), a random
 *  velocity of amplitude `amp(y)` per particle, and the slip/drop history `hist(q)`; all f32-rounded. */
function scene(n: Vec3, depth: number, ids: number[], names: MatName[], rng: () => number, pick: (q: number, x: Vec3) => number,
  amp: (y: number) => number, hist: (q: number, name: MatName) => { s: Vec3; d: number }, drop?: number): Scene {
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX })
  const pts: Vec3[] = []
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < depth; j++) for (let i = 0; i < n[0]; i++) for (let s = 0; s < 8; s++)
    pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX].map(Math.fround) as Vec3)
  const p = makeParticles(pts.length)
  const slipArr = new Float64Array(3 * p.n), dropArr = new Float64Array(p.n)
  p.slip = slipArr; p.drop = dropArr
  pts.forEach((x, q) => {
    p.pos.set(x, 3 * q)
    const m = pick(q, x), name = names[m]
    p.material[q] = ids[m]
    p.mass[q] = Math.fround(IMM[name].rho * DX ** 3 / 8)
    const a = amp(x[1])
    p.vel.set([a * (rng() - 0.5), a * (rng() - 0.5), a * (rng() - 0.5)].map(Math.fround), 3 * q)
    const h = hist(q, name)
    slipArr.set(h.s.map(Math.fround), 3 * q); dropArr[q] = Math.fround(h.d)
  })
  return { L, p, ids, names, drop }
}

function makeScene(kind: string, seed: number): Scene {
  const rng = mulberry32(seed), n: Vec3 = [16, 16, 8], none = () => ({ s: [0, 0, 0] as Vec3, d: 0 })
  const every16 = (q: number) => (q % 16 === 5 ? 1 : 0)
  if (kind === 'oil') {
    // 1 mm drops (scenario size) with a random slip history on half of them: the Schiller–Naumann regime, h ≈ 0.2
    return scene(n, 12, [0, 1], ['water', 'oil'], rng, every16, () => 0.2,
      (q, nm) => (nm === 'oil' && q % 32 === 5 ? { s: [0.03 * (rng() - 0.5), 0.03 * (rng() - 0.5), 0.03 * (rng() - 0.5)], d: 0 } : none()), 1e-3)
  }
  if (kind === 'mercury') {
    // 1 cm drops, half from rest (Δt/τ = 1.2e-4: the series branch of 1 − e^(−h), where 1 − exp(−h) in f32 errs 1.5e-3),
    // half with a slip of up to 1 m/s (Re up to ~6000: Newton's drag branch)
    return scene(n, 12, [0, 1], ['water', 'mercury'], rng, every16, () => 0.2,
      (q, nm) => (nm === 'mercury' && q % 32 === 5 ? { s: [2 * (rng() - 0.5), 2 * (rng() - 0.5), 2 * (rng() - 0.5)].map(v => v / Math.sqrt(3)) as Vec3, d: 0 } : none()), 1e-2)
  }
  if (kind === 'hinze') {
    // Hinze sizing: the velocity noise grows with height (quiet floor: d_max ≥ dx, resolved; stirred top: sub-grid drops),
    // a third of the oil carries an older, smaller drop (breakup only keeps it)
    return scene(n, 12, [0, 1], ['water', 'oil'], rng, every16, y => 0.6 * y / (12 * DX),
      (q, nm) => (nm === 'oil' && q % 48 === 5 ? { s: [0.01 * (rng() - 0.5), 0.01 * (rng() - 0.5), 0.01 * (rng() - 0.5)], d: 1e-3 * (0.5 + rng()) } : none()))
  }
  // 'mix4': four liquids with non-contiguous ids 0, 3, 7, 12 — water with an oil-majority band (x < 3 cells: water drops
  // in oil), mercury drops (x > 10), ethanol throughout (miscible with water: never slips); Hinze sizing
  return scene(n, 12, [0, 3, 7, 12], ['water', 'oil', 'mercury', 'ethanol'], rng,
    (q, x) => (x[0] < 3 * DX ? (q % 5 === 0 ? 0 : 1) : x[0] > 10 * DX && q % 8 === 3 ? 2 : q % 16 === 9 ? 3 : q % 24 === 1 ? 1 : 0),
    () => 0.5, none)
}

const sigmaOf = (a: MatName, b: MatName) => SIGMA[`${a}|${b}`] ?? SIGMA[`${b}|${a}`] ?? null

/** K30–K32 on one scene: the reference's inputs (projected, extrapolated u; pressure; labels) f32-rounded on both sides. */
export async function immKernels(device: GPUDevice, o: { kind?: string; seed?: number }) {
  const kind = o.kind ?? 'oil', sc = makeScene(kind, o.seed ?? 31), { L, p } = sc, dt = 1 / 120, S = L.size, n = [L.nx, L.ny, L.nz]
  const props: Record<number, { rho: number; mu: number }> = {}
  sc.ids.forEach((id, k) => { props[id] = IMM[sc.names[k]] })
  const nameOf = new Map(sc.ids.map((id, k) => [id, sc.names[k]]))
  const cpu = new FlipRef(L, { gravity: [0, -G, 0], density: IMM.water.rho, projection: true, freeSurface: 'ghost', variableDensity: true, pressureTolerance: 1e-9,
    immiscible: { props, sigma: (a, b) => sigmaOf(nameOf.get(a)!, nameOf.get(b)!), dropDiameter: sc.drop, nuNum: INCOMPRESSIBLE_NU_NUM } })
  // the reference's drift-flux inputs
  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); cpu.classifyLevelSet(p); cpu.fillUnsetLiquidFaces()
  cpu.solvePressure(dt); cpu.projectVelocities(dt); cpu.extrapolate(); cpu.applySolidFaces()
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) cpu.u[ax][s] = Math.fround(cpu.u[ax][s])
  for (let s = 0; s < S; s++) cpu.pressure[s] = Math.fround(cpu.pressure[s])
  cpu.pressureTotal = null
  const slip0 = Float64Array.from(p.slip!), drop0 = Float64Array.from(p.drop!)

  const gpu = await FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -G, 0], maxParticles: p.n, lRef: L_REF, tauS: TAU,
    projection: true, density: IMM.water.rho, freeSurface: 'ghost', variableDensity: true, immiscible: true,
  })
  gpu.dt = dt
  gpu.setParticles(Array.from({ length: p.n }, (_, q) => ({ pos: [p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]] as Vec3, vel: [0, 0, 0] as Vec3, mass: p.mass[q], composition: p.material[q], phase: 1, temperatureC: 20 })))
  gpu.writeParams()
  const imm = gpu.immiscibleSolver!
  imm.configure({ materials: sc.ids.map((id, k) => ({ compositions: [id], ...IMM[sc.names[k]] })), sigma: (a, b) => sigmaOf(sc.names[a], sc.names[b]),
    dropDiameter: sc.drop, nuNum: INCOMPRESSIBLE_NU_NUM })
  const u3 = new Float32Array(3 * S)
  for (const ax of [0, 1, 2]) u3.set(cpu.u[ax], ax * S)
  gpu.writeGrid(gpu.finalVelocityBuffer, { u: u3 })
  const sb = gpu.solver!.buffers
  device.queue.writeBuffer(sb.x, 0, Float32Array.from(cpu.pressure))
  device.queue.writeBuffer(sb.labels, 0, Uint32Array.from(cpu.label))
  const st4 = new Float32Array(4 * p.n)
  for (let q = 0; q < p.n; q++) st4.set([slip0[3 * q], slip0[3 * q + 1], slip0[3 * q + 2], drop0[q]], 4 * q)
  device.queue.writeBuffer(imm.bufs.slipState, 0, st4)
  await submit(device, e => { imm.encodeFirstPressure(e); imm.encode(e, p.n) })
  cpu.driftFlux(p, dt)
  const gSlip = new Float32Array(await gpu.readBuffer(imm.bufs.slipState, 16 * p.n))
  const gDrift = new Float32Array(await gpu.readBuffer(gpu.driftBuf, 16 * p.n))
  const gInf = new Float32Array(await gpu.readBuffer(imm.bufs.cellInf, 4 * 8 * S))
  const gStats = await imm.readStats()

  // ── the reference's per-cell quantities in f64 (for the bounds), from the same fields driftFlux read ──
  const K = sc.ids.length, kOf = new Map(sc.ids.map((id, k) => [id, k]))
  const dT = 3 * 2 ** (Math.floor(Math.log2(Math.max(...n))) - 23)   // |Δt| of a trilinear coordinate (muBounds)
  const W = new Float64Array(K * S), Wt = new Float64Array(S), D = new Float64Array(K * S), Dt = new Float64Array(S), Nc = new Float64Array(S)
  for (let q = 0; q < p.n; q++) {
    const k = kOf.get(p.material[q])!, f = [0, 1, 2].map(a => p.pos[3 * q + a] / DX - 0.5), b = f.map(Math.floor), t = f.map((v, a) => v - b[a])
    for (let m = 0; m < 8; m++) {
      const d = [m & 1, (m >> 1) & 1, (m >> 2) & 1], c = b.map((v, a) => v + d[a])
      if (c.some((v, a) => v < 0 || v >= n[a])) continue
      const wv = d.map((dd, a) => (dd ? t[a] : 1 - t[a])), w = wv[0] * wv[1] * wv[2]
      if (!(w > 0)) continue
      const s2 = L.idx(c[0], c[1], c[2]), dw = dT * (wv[1] * wv[2] + wv[0] * wv[2] + wv[0] * wv[1]) + 2 * U * w
      W[k * S + s2] += w; Wt[s2] += w; D[k * S + s2] += dw; Dt[s2] += dw; Nc[s2]++
    }
  }
  const alpha = (k: number, s2: number) => (Wt[s2] > 0 ? W[k * S + s2] / Wt[s2] : 0)
  const dAlpha = (k: number, s2: number) => (Wt[s2] > 0 ? (D[k * S + s2] + alpha(k, s2) * Dt[s2]) / Wt[s2] / Math.max(1e-30, 1 - Dt[s2] / Wt[s2]) + 3 * U + 2 * Nc[s2] * 2 ** -43 / Wt[s2] : 0)
  const majority = (s2: number) => { let c = 0; for (let k = 1; k < K; k++) if (alpha(k, s2) > alpha(c, s2)) c = k; return c }
  // ε and its bound per cell (the epsAt stencil, identical f32 inputs)
  const uc = (a: number, c: number[]) => { const c2 = [...c]; c2[a]++; return 0.5 * (cpu.u[a][L.idx(c[0], c[1], c[2])] + cpu.u[a][L.idx(c2[0], c2[1], c2[2])]) }
  const epsInfo = (s2: number, c: number[], nu: number) => {
    const Gm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], dG = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      if (a === b) { const c2 = [...c]; c2[a]++; Gm[a][b] = (cpu.u[a][L.idx(c2[0], c2[1], c2[2])] - cpu.u[a][s2]) / DX; dG[a][b] = 3.5 * U * Math.abs(Gm[a][b]); continue }
      const lo = [...c], hi = [...c]
      lo[b] = Math.max(0, c[b] - 1); hi[b] = Math.min(n[b] - 1, c[b] + 1)
      if (hi[b] > lo[b]) {
        const uh = uc(a, hi), ul = uc(a, lo), span = (hi[b] - lo[b]) * DX
        Gm[a][b] = (uh - ul) / span
        dG[a][b] = U * (Math.abs(uh) + Math.abs(ul)) / span + 4.5 * U * Math.abs(Gm[a][b])
      }
    }
    let ss = 0, dss = 0
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      const sab = 0.5 * (Gm[a][b] + Gm[b][a]), ds = 0.5 * (dG[a][b] + dG[b][a]) + U * Math.abs(sab)
      ss += sab * sab; dss += 2 * Math.abs(sab) * ds + ds * ds
    }
    dss += 10 * U * ss
    const eps = 2 * nu * ss
    return { eps, dEps: 2 * nu * dss + 5 * U * eps }
  }

  // K30 cells: α per slot, ρ_m, the majority slot, ε — every interior cell a particle reaches
  let alphaRatio = 0, rhoRatio = 0, epsRatio = 0, majorityMismatch = 0, majorityExcused = 0, epsCells = 0, cellsSeen = 0
  const ambiguous = new Uint8Array(S)
  const cellEps = new Float64Array(S), cellDEps = new Float64Array(S)
  for (let k3 = 0; k3 < n[2]; k3++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s2 = L.idx(i, j, k3), o = 8 * s2
    if (!(Wt[s2] > 0)) continue
    cellsSeen++
    for (let k = 0; k < K; k++) alphaRatio = Math.max(alphaRatio, Math.abs(gInf[o + 4 + k] - alpha(k, s2)) / dAlpha(k, s2))
    let rm = 0, dRm = 0
    for (let k = 0; k < K; k++) { rm += alpha(k, s2) * IMM[sc.names[k]].rho; dRm += IMM[sc.names[k]].rho * dAlpha(k, s2) }
    dRm += 2 * K * U * rm
    rhoRatio = Math.max(rhoRatio, Math.abs(gInf[o + 2] - rm) / dRm)
    const c = majority(s2)
    // a near tie (the two largest α within their bounds) may resolve either way: excused, and its particles excluded
    let tie = false
    for (let k = 0; k < K; k++) if (k !== c && alpha(c, s2) - alpha(k, s2) <= dAlpha(c, s2) + dAlpha(k, s2)) tie = true
    if (tie) { ambiguous[s2] = 1; majorityExcused++; continue }
    if (gInf[o + 1] !== c) majorityMismatch++
    const nm = sc.names[c], nu = IMM[nm].mu / IMM[nm].rho + INCOMPRESSIBLE_NU_NUM
    const e = epsInfo(s2, [i, j, k3], nu)
    cellEps[s2] = e.eps; cellDEps[s2] = e.dEps
    if (e.eps > 0 || gInf[o] > 0) { epsCells++; epsRatio = Math.max(epsRatio, Math.abs(gInf[o] - e.eps) / e.dEps) }
  }
  const k30 = { cellsSeen, alphaRatio, rhoRatio, epsRatio, epsCells, majorityMismatch, majorityExcused }

  // K31 slip and drop per particle: bound B_s from the chain T = (ρ_p − ρ_m)(∇p/ρ_m)·k_d, k_d = d²/(18 μ_m f),
  // m = 1 − e^(−Δt/((ρ_p + ½ρ_c)k_d)), s = s₀ + (T − s₀)·m
  const lab = cpu.label, pr = cpu.pressure
  const faceP = (a: number, c: number[]) => {
    const [lo, hi] = L.faceRange(a as 0 | 1 | 2)
    if (c.some((v, b) => v < lo[b] || v > hi[b])) return { g: 0, pp: 0, pm: 0 }
    const s2 = L.idx(c[0], c[1], c[2])
    if (cpu.faceType[a][s2] === 1) return { g: 0, pp: 0, pm: 0 }   // FaceType.SOLID
    const cm = [...c]; cm[a]--
    const sm = L.idx(cm[0], cm[1], cm[2]), pp = lab[s2] === 1 ? pr[s2] : 0, pm = lab[sm] === 1 ? pr[sm] : 0
    return { g: (pp - pm) / DX, pp, pm }
  }
  const gradBound = (x: number[]) => {
    const g = [0, 0, 0], dg = [0, 0, 0]
    for (let a = 0; a < 3; a++) {
      const f = x.map((v, b) => v / DX - (a === b ? 0 : 0.5)), b0 = f.map(Math.floor), t = f.map((v, b) => v - b0[b])
      for (let m = 0; m < 8; m++) {
        const d = [m & 1, (m >> 1) & 1, (m >> 2) & 1], wv = d.map((dd, b) => (dd ? t[b] : 1 - t[b])), w = wv[0] * wv[1] * wv[2]
        const fp = faceP(a, b0.map((v, b) => v + d[b]))
        g[a] += w * fp.g
        dg[a] += (3 * dT + 14 * U) * Math.abs(fp.g) + U * (Math.abs(fp.pp) + Math.abs(fp.pm)) / DX
      }
    }
    return { g, dg: dg[0] + dg[1] + dg[2] }
  }
  const cellOf = (q: number) => L.idx(...([0, 1, 2].map(a => Math.min(n[a] - 1, Math.max(0, Math.floor(p.pos[3 * q + a] / DX)))) as [number, number, number]))
  const Bs = new Float64Array(p.n), dispCpu = new Uint8Array(p.n), excusedQ = new Uint8Array(p.n)
  let slipRatio = 0, dropRatio = 0, dispMismatch = 0, dispExcused = 0, dispersed = 0, seriesBranch = 0, expBranch = 0, recompute = 0, newton = 0
  let worst: Record<string, number> = {}
  for (let q = 0; q < p.n; q++) {
    const s2 = cellOf(q)
    if (ambiguous[s2]) { excusedQ[q] = 1; continue }
    const k = kOf.get(p.material[q])!, c = majority(s2), sig = k === c ? null : sigmaOf(sc.names[k], sc.names[c])
    const cpuD = p.drop![q] > 0, gpuD = gSlip[4 * q + 3] > 0
    dispCpu[q] = cpuD ? 1 : 0
    if (sig === null || !(sig > 0)) { if (gpuD) dispMismatch++; continue }
    const Pm = IMM[sc.names[k]], Cm = IMM[sc.names[c]]
    // d and its relative bound
    let d: number, relD: number
    if (sc.drop !== undefined) { d = sc.drop; relD = U }
    else {
      const eps = cellEps[s2], dMax = eps > 0 ? 0.725 * Math.pow(Cm.rho / sig, -0.6) * Math.pow(eps, -0.4) : Infinity
      d = drop0[q] > 0 ? Math.min(drop0[q], dMax) : dMax
      relD = (drop0[q] > 0 && drop0[q] <= dMax * (1 - (eps > 0 ? 0.4 * cellDEps[s2] / eps : 0) - 2 * PW - 4 * U)) ? 0 : (eps > 0 ? 0.4 * cellDEps[s2] / eps : 0) + 2 * PW + 4 * U
    }
    if (Math.abs(d - DX) <= relD * d + U * DX) { excusedQ[q] = 1; dispExcused++; continue }   // at the resolved edge
    if (cpuD !== gpuD) { dispMismatch++; continue }
    if (!cpuD) continue
    dispersed++
    dropRatio = Math.max(dropRatio, Math.abs(gSlip[4 * q + 3] - p.drop![q]) / Math.max(relD * p.drop![q] + U * p.drop![q], 1e-30))
    let rm = 0, dRm = 0
    for (let kk = 0; kk < K; kk++) { rm += alpha(kk, s2) * IMM[sc.names[kk]].rho; dRm += IMM[sc.names[kk]].rho * dAlpha(kk, s2) }
    dRm += 2 * K * U * rm
    const aD = 1 - alpha(c, s2), muStar = (Pm.mu + 0.4 * Cm.mu) / (Pm.mu + Cm.mu), muM = Cm.mu * Math.pow(Math.max(1e-12, 1 - aD), -2.5 * muStar)
    const eMu = PW + 2.5 * muStar * dAlpha(c, s2) / Math.max(1e-12, 1 - aD) + 3 * U
    const s0 = [slip0[3 * q], slip0[3 * q + 1], slip0[3 * q + 2]], Re = d * Cm.rho * Math.hypot(...s0) / muM
    const relRe = relD + eMu + 4 * U
    if (Re > 0 && Math.abs(Re - 1000) <= relRe * Re) { excusedQ[q] = 1; dispExcused++; continue }   // at the drag-law seam
    const f = dragFactor(Re), eF = relRe + PW
    if (Re >= 1000) newton++
    const kd = d * d / (18 * muM * f), eKd = 2 * relD + eMu + eF + 5 * U
    const h = dt / ((Pm.rho + 0.5 * Cm.rho) * kd), m = -Math.expm1(-h), eH = eKd + 4 * U
    const eM = eH * (h * Math.exp(-h) / m) + (h < 0.1 ? 8 * U : ((3 + 2 * h) * U * Math.exp(-h) + U) / m)
    if (h < 0.1) seriesBranch++; else expBranch++
    const gb = gradBound([p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]])
    const T = gb.g.map(v => (Pm.rho - rm) * (v / rm) * kd), Tm = Math.hypot(...T)
    const dT_ = Tm * (dRm / Math.max(1e-30, Math.abs(Pm.rho - rm)) + dRm / rm + eKd + 5 * U) + Math.abs(Pm.rho - rm) / rm * kd * gb.dg
    const sNew = s0.map((v, a) => v + (T[a] - v) * m), dm = Math.hypot(...T.map((v, a) => v - s0[a]))
    // the recomputation must be the reference's own value (else these bounds describe a different computation)
    const rc = Math.hypot(sNew[0] - p.slip![3 * q], sNew[1] - p.slip![3 * q + 1], sNew[2] - p.slip![3 * q + 2])
    if (rc > 1e-12 * Math.max(1e-12, Math.hypot(...sNew))) recompute++
    Bs[q] = dT_ * m + dm * m * eM + 2 * U * dm * m + U * Math.hypot(...sNew) + 1e-30
    const err = Math.hypot(gSlip[4 * q] - p.slip![3 * q], gSlip[4 * q + 1] - p.slip![3 * q + 1], gSlip[4 * q + 2] - p.slip![3 * q + 2])
    if (err / Bs[q] > slipRatio) { slipRatio = err / Bs[q]; worst = { q, err, bound: Bs[q], h, Re, d, slip: Math.hypot(...sNew) } }
  }
  const k31 = { dispersed, cpuDispersed: cpu.lastDrift.dispersed, gpuDispersed: gStats.dispersed, cpuTooLarge: cpu.lastDrift.tooLarge, gpuTooLarge: gStats.tooLarge,
    slipRatio, dropRatio, dispMismatch, dispExcused, seriesBranch, expBranch, newton, recompute, worst,
    maxSlip: { cpu: cpu.lastDrift.maxSlip, gpu: gStats.maxSlip }, meanDrop: { cpu: cpu.lastDrift.meanDrop, gpu: gStats.meanDrop } }

  // K32 drift per particle: u_V = own − J, J = Σ_k α_k ū_Ck; cells with an excused particle are skipped
  const cellBad = new Uint8Array(S), cellCnt = new Float64Array(K * S), cellSum = new Float64Array(3 * K * S), cellB = new Float64Array(K * S)
  for (let q = 0; q < p.n; q++) {
    const s2 = cellOf(q)
    if (excusedQ[q]) cellBad[s2] = 1
    if (!dispCpu[q]) continue
    const k = kOf.get(p.material[q])!
    cellCnt[k * S + s2]++
    for (let a = 0; a < 3; a++) cellSum[3 * (k * S + s2) + a] += p.slip![3 * q + a]
    cellB[k * S + s2] = Math.max(cellB[k * S + s2], Bs[q])
  }
  let driftRatio = 0, driftChecked = 0, driftSkipped = 0, driftMax = 0
  for (let q = 0; q < p.n; q++) {
    const s2 = cellOf(q)
    if (cellBad[s2]) { driftSkipped++; continue }
    let dJ = 0, Jn = 0
    for (let k = 0; k < K; k++) {
      const cnt = cellCnt[k * S + s2]
      if (!cnt) continue
      const mean = Math.hypot(cellSum[3 * (k * S + s2)], cellSum[3 * (k * S + s2) + 1], cellSum[3 * (k * S + s2) + 2]) / cnt
      dJ += dAlpha(k, s2) * mean + alpha(k, s2) * cellB[k * S + s2] + alpha(k, s2) * mean * 4 * U
      Jn += alpha(k, s2) * mean
    }
    dJ += K * U * Jn
    const ref = [0, 1, 2].map(a => cpu.drift[3 * q + a]), dv = Math.hypot(...ref)
    const B = (dispCpu[q] ? Bs[q] : 0) + dJ + U * dv + 1e-30
    const err = Math.hypot(gDrift[4 * q] - ref[0], gDrift[4 * q + 1] - ref[1], gDrift[4 * q + 2] - ref[2])
    driftRatio = Math.max(driftRatio, err / B); driftChecked++; driftMax = Math.max(driftMax, dv)
  }
  const k32 = { driftRatio, driftChecked, driftSkipped, driftMax }

  // K33 the advection adds the drift (g2pMac, IMMISCIBLE): with u = 0 on every face (all valid), x ← x + Δt·u_V exactly
  // up to f32 rounding: |Δ| ≤ ulp-level ½u·|x| (the add) + u·Δt|u_V| (the product) + ½u·|x + Δt·u_V| — 2u·(|x| + Δt|u_V|)
  // covers them; particles the wall clamp moves are excluded (counted)
  const zeros = new Float32Array(3 * S), ones = new Uint32Array(3 * S).fill(1)
  gpu.writeGrid(gpu.finalVelocityBuffer, { u: zeros, valid: ones })
  const before = new Float32Array(await gpu.readBuffer(gpu.posBuf, 16 * p.n))
  await submit(device, e => gpu.encodeG2P(e))
  const after = new Float32Array(await gpu.readBuffer(gpu.posBuf, 16 * p.n))
  const ext = L.extent, wallEps = 1e-6 * DX
  let advRatio = 0, advChecked = 0, advClamped = 0, advMoved = 0
  for (let q = 0; q < p.n; q++) {
    const x = [0, 1, 2].map(a => before[4 * q + a]), dv = [0, 1, 2].map(a => dt * gDrift[4 * q + a]), want = x.map((v, a) => v + dv[a])
    if (want.some((v, a) => v < wallEps || v > ext[a] - wallEps)) { advClamped++; continue }
    advChecked++
    if (dv.some(v => v !== 0)) advMoved++
    for (let a = 0; a < 3; a++) advRatio = Math.max(advRatio, Math.abs(after[4 * q + a] - want[a]) / (2 * U * (Math.abs(x[a]) + Math.abs(dv[a])) + 1e-30))
  }
  const k33 = { advRatio, advChecked, advClamped, advMoved }
  gpu.destroy()
  return { kind, particles: p.n, k30, k31, k32, k33 }
}
