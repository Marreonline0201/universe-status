/// <reference types="@webgpu/types" />
// S3.5-i on the GPU (flip-selftest.html): the immiscible drift flux (ImmiscibleSolver, immiscible.wgsl) against the f64
// reference flipRef.driftFlux on IDENTICAL inputs — the same f32 particle positions, slip history, face velocities and
// face accelerations on both sides — K30–K33, and the face acceleration itself (K34, flipRef.captureFaceAccel) on the
// same f32 u* and projected u. Metrics only —
// scripts/fluid-gates/s35i-gpu.mjs applies the tolerances. Every bound below is derived from f32 rounding (u = 2^-24;
// WGSL: × − + and conversions correctly rounded, ÷ 2.5 ulp, pow via exp2(y·log2 x) ≤ 64 ulp here, exp (3 + 2|x|) ulp).
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, makeParticles, dragFactor, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { INCOMPRESSIBLE_NU_NUM } from '../../composition/liquidGate'
import { DX, L_REF, TAU, submit, mulberry32, solverConfig, capFor } from './util'

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
  // the reference's drift-flux inputs: u* after the grid update, the projected u and its valid flags (both f32-rounded:
  // K34's identical inputs), a = g − Du/Dt on the faces, then the final extrapolated u
  const r32 = (f: Float64Array[]) => { for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) f[ax][s] = Math.fround(f[ax][s]) }
  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); r32(cpu.u)
  cpu.uStar = [Float64Array.from(cpu.u[0]), Float64Array.from(cpu.u[1]), Float64Array.from(cpu.u[2])]
  cpu.classifyLevelSet(p); cpu.fillUnsetLiquidFaces(); cpu.solvePressure(dt); cpu.projectVelocities(dt); r32(cpu.u)
  const uProj = new Float32Array(3 * S), vProj = new Uint32Array(3 * S), uStar3 = new Float32Array(3 * S)
  for (const ax of [0, 1, 2]) { uProj.set(cpu.u[ax], ax * S); uStar3.set(cpu.uStar[ax], ax * S); for (let s = 0; s < S; s++) vProj[ax * S + s] = cpu.valid[ax][s] }
  cpu.captureFaceAccel(dt)
  const accRef = cpu.faceAccel.map(f => Float64Array.from(f))
  cpu.extrapolate(); cpu.applySolidFaces(); r32(cpu.u); r32(cpu.faceAccel)
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
  // K34 the face acceleration: faceAccel + the velocity's extrapolation kernel (two layers) on the reference's f32 u*,
  // projected u and valid flags. Bound: a projection-set face (u* − u)/Δt — the subtraction ½u·|u* − u|, the division
  // 2.5 ulp, f32(Δt) u — ≤ 4u·|a|; SOLID faces f32(g) ≤ u·|g|; each extrapolation layer averages ≤ 6 such faces
  // (≤ 6 roundings + the division) — +6u·A per layer, A = max|a|: 16u·A after two layers
  gpu.writeGrid(0, { u: uProj, valid: vProj })
  device.queue.writeBuffer(imm.bufs.uStar, 0, uStar3)
  await submit(device, e => gpu.encodeFaceAccel(e))
  const gAcc = new Float32Array(await gpu.readBuffer(imm.accFinal, 4 * 3 * S))
  let accMax = 0, accDiff = 0, accFaces = 0, accSolidFaces = 0
  for (const ax of [0, 1, 2] as const) for (let s = 0; s < S; s++) accMax = Math.max(accMax, Math.abs(accRef[ax][s]))
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k)
      if (accRef[ax][s] !== 0) accFaces++
      if (cpu.faceType[ax][s] === 1) accSolidFaces++
      accDiff = Math.max(accDiff, Math.abs(gAcc[ax * S + s] - accRef[ax][s]))
    }
  }
  const k34 = { accRatio: accDiff / (16 * U * accMax), accMax, accFaces, accSolidFaces }

  // K30–K33 inputs: the final u and the reference's face accelerations, f32 on both sides
  const u3 = new Float32Array(3 * S), a3 = new Float32Array(3 * S)
  for (const ax of [0, 1, 2]) { u3.set(cpu.u[ax], ax * S); a3.set(cpu.faceAccel[ax], ax * S) }
  gpu.writeGrid(gpu.finalVelocityBuffer, { u: u3 })
  device.queue.writeBuffer(imm.accFinal, 0, a3)
  const st4 = new Float32Array(4 * p.n)
  for (let q = 0; q < p.n; q++) st4.set([slip0[3 * q], slip0[3 * q + 1], slip0[3 * q + 2], drop0[q]], 4 * q)
  device.queue.writeBuffer(imm.bufs.slipState, 0, st4)
  await submit(device, e => imm.encode(e, p.n))
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

  // K31 slip and drop per particle: bound B_s from the chain T = (ρ_p − ρ_m)·a·k_d, k_d = d²/(18 μ_m f),
  // m = 1 − e^(−Δt/((ρ_p + ½ρ_c)k_d)), s = s₀ + (T − s₀)·m; a sampled from identical f32 face values, so its error is the
  // trilinear weights' (3·dT per weight) and the 8-term sum's (14u per tap, generous)
  const accBound = (x: number[]) => {
    const g = [0, 0, 0], dg = [0, 0, 0]
    for (let a = 0; a < 3; a++) {
      const [lo, hi] = L.faceRange(a as 0 | 1 | 2)
      const f = x.map((v, b) => v / DX - (a === b ? 0 : 0.5)), b0 = f.map(Math.floor), t = f.map((v, b) => v - b0[b])
      for (let m = 0; m < 8; m++) {
        const d = [m & 1, (m >> 1) & 1, (m >> 2) & 1], wv = d.map((dd, b) => (dd ? t[b] : 1 - t[b])), w = wv[0] * wv[1] * wv[2]
        const c = b0.map((v, b) => v + d[b])
        if (c.some((v, b) => v < lo[b] || v > hi[b])) continue
        const fa = cpu.faceAccel[a][L.idx(c[0], c[1], c[2])]
        g[a] += w * fa
        dg[a] += (3 * dT + 14 * U) * Math.abs(fa)
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
    const gb = accBound([p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]])
    const T = gb.g.map(v => (Pm.rho - rm) * v * kd), Tm = Math.hypot(...T)
    const dT_ = Tm * (dRm / Math.max(1e-30, Math.abs(Pm.rho - rm)) + eKd + 4 * U) + Math.abs(Pm.rho - rm) * kd * gb.dg
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
  return { kind, particles: p.n, k30, k31, k32, k33, k34 }
}

// ── physics on the GPU path (s35i-ref scenes) ──

async function makeImmSim(device: GPUDevice, n: Vec3, count: number, o: { tol?: number; density?: boolean; viscous?: boolean } = {}) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -G, 0], maxParticles: count, lRef: L_REF, tauS: TAU,
    projection: true, density: IMM.water.rho, pressureTolerance: o.tol ?? 1e-2, pressureCap: capFor(400), solverMethod: solverConfig.method,
    densityProjection: o.density ?? true, psiTolerance: 1e-3, psiCap: capFor(400), freeSurface: 'ghost', variableDensity: true,
    viscosity: o.viscous ?? false, immiscible: true,
  })
}

/** G-rest: s35i-ref B's column at rest on the GPU's full step — a regular lattice, mercury below (10 cells), `light` above
 *  (8 cells), four mercury drops per cell on the lattice sites of the light layer's first row; honey above takes the
 *  viscous path (two projections, a includes the viscous acceleration). After one step the face accelerations within
 *  two rows of the interface must be g: returns max |a − g|/g there (y faces) and max |a_x|, |a_z|/g. */
export async function immRest(device: GPUDevice, o: { light: 'water' | 'honey'; tol?: number }) {
  const nx = 8, ny = 20, nz = 8, h1 = 10, h2 = 8, dt = 1 / 120
  const HONEY = { rho: LIQUIDS['honey-20pct-25C'].density(25), mu: LIQUIDS['honey-20pct-25C'].viscosity(25) }
  const light = o.light === 'water' ? IMM.water : HONEY
  const pts: { x: Vec3; m: number }[] = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < h1 + h2; j++) for (let i = 0; i < nx; i++) for (let s = 0; s < 8; s++)
    pts.push({ x: [(i + ((s & 1) + 0.5) / 2) * DX, (j + (((s >> 1) & 1) + 0.5) / 2) * DX, (k + (((s >> 2) & 1) + 0.5) / 2) * DX], m: j < h1 ? 1 : 0 })
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (const [sx, sz] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]])
    pts.push({ x: [(i + sx) * DX, (h1 + 0.75) * DX, (k + sz) * DX], m: 1 })
  const props = [light, IMM.mercury]
  const gpu = await makeImmSim(device, [nx, ny, nz], pts.length, { tol: o.tol ?? 1e-4, density: false, viscous: o.light === 'honey' })
  gpu.dt = dt
  gpu.setParticles(pts.map(pt => ({ pos: pt.x.map(Math.fround) as Vec3, vel: [0, 0, 0] as Vec3, mass: props[pt.m].rho * DX ** 3 / 8, composition: pt.m, phase: 1, temperatureC: 20 })))
  if (o.light === 'honey') {
    gpu.viscositySolver!.setMuTable(new Float32Array([HONEY.mu, IMM.mercury.mu]))
    gpu.viscositySolver!.muDefault = IMM.mercury.mu
    gpu.viscosityActive = true
  }
  gpu.immiscibleSolver!.configure({ materials: props.map((pr, k) => ({ compositions: [k], ...pr })), sigma: (a, b) => (o.light === 'water' && a !== b ? SIGMA['mercury|water'] : null),
    dropDiameter: 1e-3, nuNum: INCOMPRESSIBLE_NU_NUM })
  gpu.immiscibleActive = true
  await submit(device, e => gpu.step(e, 1))
  const S = gpu.layout.size, acc = new Float32Array(await gpu.readBuffer(gpu.immiscibleSolver!.accFinal, 4 * 3 * S)), L = gpu.layout
  let yErr = 0, hErr = 0, faces = 0
  for (let k = 0; k < nz; k++) for (let j = h1 - 1; j <= h1 + 2; j++) for (let i = 0; i < nx; i++) {
    yErr = Math.max(yErr, Math.abs(acc[S + L.idx(i, j, k)] + G) / G); faces++
    hErr = Math.max(hErr, Math.abs(acc[L.idx(i, j, k)]) / G, Math.abs(acc[2 * S + L.idx(i, j, k)]) / G)
  }
  const d = await gpu.readDiagnostics(), stats = await gpu.immiscibleSolver!.readStats()
  const out = { light: o.light, viscous: gpu.viscosityActive, particles: pts.length, faces, yErr, hErr, dispersed: stats.dispersed, capHits: d.capHits, breakdowns: d.breakdowns }
  gpu.destroy()
  return out
}

/** s35i-ref's layered scenes on the GPU at the page's settings (pressure 1e-2, ψ 1e-3): F1's 16×40×8 tank, `lower`
 *  (12 cells) under `upper` (12 cells), Hinze sizing; wrong-side fraction every second (the denser liquid belongs
 *  below), the most particles ever dispersed and the largest slip (sampled every 12 steps). */
export async function immLayered(device: GPUDevice, o: { lower: MatName; upper: MatName; seconds: number; seed: number; immiscible: boolean }) {
  const nx = 16, ny = 40, nz = 8, h1 = 12, h2 = 12, rng = mulberry32(o.seed)
  const pts: { x: Vec3; m: number }[] = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < h1 + h2; j++) for (let i = 0; i < nx; i++) for (let s = 0; s < 8; s++) {
    const x: Vec3 = [(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX]
    pts.push({ x, m: x[1] < h1 * DX ? 0 : 1 })
  }
  const props = [IMM[o.lower], IMM[o.upper]], sig = sigmaOf(o.lower, o.upper)
  const gpu = await makeImmSim(device, [nx, ny, nz], pts.length)
  gpu.dt = 1 / 120
  gpu.setParticles(pts.map(pt => ({ pos: pt.x.map(Math.fround) as Vec3, vel: [0, 0, 0] as Vec3, mass: props[pt.m].rho * DX ** 3 / 8, composition: pt.m, phase: 1, temperatureC: 20 })))
  gpu.immiscibleSolver!.configure({ materials: props.map((pr, k) => ({ compositions: [k], ...pr })), sigma: (a, b) => (a !== b ? sig : null), nuNum: INCOMPRESSIBLE_NU_NUM })
  if (o.immiscible) gpu.immiscibleActive = true
  const heavy = props[0].rho > props[1].rho ? 0 : 1, steps = Math.round(o.seconds * 120), hist: { t: number; wrong: number }[] = []
  let everDispersed = 0, maxSlip = 0, nan = 0
  for (let s = 1; s <= steps; s++) {
    await submit(device, e => gpu.step(e, 1))
    if (o.immiscible && s % 12 === 0) { const st = await gpu.immiscibleSolver!.readStats(); everDispersed = Math.max(everDispersed, st.dispersed); maxSlip = Math.max(maxSlip, st.maxSlip) }
    if (s % 120 === 0) {
      const pos = (await gpu.readParticles()).pos
      let wrong = 0
      for (let q = 0; q < pts.length; q++) {
        const y = pos[4 * q + 1] / DX
        if (!Number.isFinite(y)) { nan++; continue }
        if (pts[q].m === heavy ? y > h1 + 0.5 : y < h1 - 0.5) wrong++
      }
      hist.push({ t: s / 120, wrong: wrong / pts.length })
    }
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { particles: pts.length, hist, everDispersed, maxSlip, nan, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** Cost of the drift flux on the FLUID TEST page's buoyancy scene (s31c-page B1: a 3-cell water pool over the 64² floor,
 *  an olive-oil block and a mercury block above it; production settings, viscous path on as the page runs it): GPU
 *  timestamps of every compute pass of one substep with the drift on, and the wall time per substep (clears and copies
 *  included) over `reps` substeps with the drift on and off, after `settle` substeps. */
export async function immCost(device: GPUDevice, o: { settle?: number; reps?: number } = {}) {
  const settle = o.settle ?? 240, reps = o.reps ?? 60, rng = mulberry32(12)
  const fillBox = (lo: Vec3, hi: Vec3, m: number) => {
    const out: { x: Vec3; m: number }[] = []
    for (let k = lo[2]; k < hi[2]; k++) for (let j = lo[1]; j < hi[1]; j++) for (let i = lo[0]; i < hi[0]; i++) for (let s = 0; s < 8; s++)
      out.push({ x: [(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX], m })
    return out
  }
  const pts = [...fillBox([0, 0, 0], [64, 3, 64], 0), ...fillBox([18, 10, 18], [40, 16, 40], 1), ...fillBox([23, 21, 23], [35, 26, 35], 2)]
  const props = [IMM.water, IMM.oil, IMM.mercury]
  const gpu = await FlipGpuSimulator.create(device, {
    nx: 64, ny: 64, nz: 64, dx: DX, gravity: [0, -G, 0], maxParticles: pts.length, lRef: L_REF, tauS: TAU,
    projection: true, density: IMM.water.rho, pressureTolerance: 1e-2, solverMethod: 'mgpcg', densityProjection: true, psiTolerance: 1e-3,
    freeSurface: 'ghost', variableDensity: true, viscosity: true, immiscible: true,
  })
  gpu.dt = 1 / 120
  gpu.setParticles(pts.map(pt => ({ pos: pt.x.map(Math.fround) as Vec3, vel: [0, 0, 0] as Vec3, mass: props[pt.m].rho * DX ** 3 / 8, composition: pt.m, phase: 1, temperatureC: 20 })))
  gpu.viscositySolver!.setMuTable(new Float32Array(props.map(p => p.mu)))
  gpu.viscositySolver!.muDefault = IMM.water.mu
  gpu.viscosityActive = true   // olive oil's ν ≥ VISCOUS_RUN_NU: the page runs the viscous path in this scene
  gpu.immiscibleSolver!.configure({ materials: props.map((pr, k) => ({ compositions: [k], ...pr })), sigma: (a, b) => sigmaOf(['water', 'oil', 'mercury'][a] as MatName, ['water', 'oil', 'mercury'][b] as MatName), nuNum: INCOMPRESSIBLE_NU_NUM })
  gpu.immiscibleActive = true
  for (let s = 0; s < settle; s++) await submit(device, e => gpu.step(e, 1))
  // wall time per substep: the command buffer encoded first, then submit → done (encoding excluded); drift on and off
  // alternated 4× each (GPU clocks drift over a run), the minimum of each kept
  const wall = async (on: boolean) => {
    gpu.immiscibleActive = on
    await submit(device, e => gpu.step(e, 1))
    const e = device.createCommandEncoder()
    for (let r = 0; r < reps; r++) gpu.step(e, 1)
    const cb = e.finish(), t0 = performance.now()
    device.queue.submit([cb])
    await device.queue.onSubmittedWorkDone()
    return (performance.now() - t0) / reps
  }
  const onRuns: number[] = [], offRuns: number[] = []
  for (let i = 0; i < 4; i++) { onRuns.push(await wall(true)); offRuns.push(await wall(false)) }
  gpu.immiscibleActive = true
  const onMs = Math.min(...onRuns)
  let top: { pass: string; us: number; passes: number }[] = [], immUs = 0, totalUs = 0
  if (device.features.has('timestamp-query')) {
    const MAX = 1024, qs = device.createQuerySet({ type: 'timestamp', count: 2 * MAX })
    const resolve = device.createBuffer({ size: 16 * MAX, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const read = device.createBuffer({ size: 16 * MAX, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const labels: string[] = [], e = device.createCommandEncoder()
    const wrapped = new Proxy(e, {
      get(t, p) {
        if (p === 'beginComputePass') return (d: GPUComputePassDescriptor = {}) => {
          const i = labels.length
          if (i >= MAX) return t.beginComputePass(d)
          labels.push(d.label ?? '?')
          return t.beginComputePass({ ...d, timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } })
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[p]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
    gpu.step(wrapped as GPUCommandEncoder, 1)
    const n = labels.length
    e.resolveQuerySet(qs, 0, 2 * n, resolve, 0)
    e.copyBufferToBuffer(resolve, 0, read, 0, 16 * n)
    device.queue.submit([e.finish()])
    await read.mapAsync(GPUMapMode.READ)
    const t = new BigUint64Array(read.getMappedRange().slice(0, 16 * n))
    read.unmap()
    const byLabel: Record<string, { us: number; passes: number }> = {}
    for (let i = 0; i < n; i++) {
      const us = Number(t[2 * i + 1] - t[2 * i]) / 1000, k = labels[i]
      byLabel[k] = byLabel[k] ?? { us: 0, passes: 0 }
      byLabel[k].us += us; byLabel[k].passes++; totalUs += us
      if (k.startsWith('imm.')) immUs += us
    }
    top = Object.entries(byLabel).sort((a, b) => b[1].us - a[1].us).slice(0, 20).map(([k, v]) => ({ pass: k, us: Math.round(v.us), passes: v.passes }))
    qs.destroy(); resolve.destroy(); read.destroy()
  }
  const offMs = Math.min(...offRuns)
  gpu.destroy()
  return { particles: pts.length, onMsPerSubstep: onMs, offMsPerSubstep: offMs, onRuns, offRuns, passUsTotal: Math.round(totalUs), immPassUs: Math.round(immUs), top }
}

/** Diagnostics for the page's B1 (s31c-page): the buoyancy scene on the GPU for `seconds`, then every olive-oil particle
 *  below the water's median height classified by what the drift flux did with it on the last substep: in an oil-majority
 *  cell (resolved), dispersed (slip, with its d), or a minority with no slip — too large (Hinze d ≥ dx) or no σ (its cell's
 *  carrier is mercury). */
export async function immB1(device: GPUDevice, o: { seconds?: number } = {}) {
  const rng = mulberry32(12), seconds = o.seconds ?? 8
  const fillBox = (lo: Vec3, hi: Vec3, m: number) => {
    const out: { x: Vec3; m: number }[] = []
    for (let k = lo[2]; k < hi[2]; k++) for (let j = lo[1]; j < hi[1]; j++) for (let i = lo[0]; i < hi[0]; i++) for (let s = 0; s < 8; s++)
      out.push({ x: [(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX], m })
    return out
  }
  const pts = [...fillBox([0, 0, 0], [64, 3, 64], 0), ...fillBox([18, 10, 18], [40, 16, 40], 1), ...fillBox([23, 21, 23], [35, 26, 35], 2)]
  const props = [IMM.water, IMM.oil, IMM.mercury], names: MatName[] = ['water', 'oil', 'mercury']
  const gpu = await FlipGpuSimulator.create(device, {
    nx: 64, ny: 64, nz: 64, dx: DX, gravity: [0, -G, 0], maxParticles: pts.length, lRef: L_REF, tauS: TAU,
    projection: true, density: IMM.water.rho, pressureTolerance: 1e-2, solverMethod: 'mgpcg', densityProjection: true, psiTolerance: 1e-3,
    freeSurface: 'ghost', variableDensity: true, viscosity: true, immiscible: true,
  })
  gpu.dt = 1 / 120
  gpu.setParticles(pts.map(pt => ({ pos: pt.x.map(Math.fround) as Vec3, vel: [0, 0, 0] as Vec3, mass: props[pt.m].rho * DX ** 3 / 8, composition: pt.m, phase: 1, temperatureC: 20 })))
  gpu.viscositySolver!.setMuTable(new Float32Array(props.map(p => p.mu)))
  gpu.viscositySolver!.muDefault = IMM.water.mu
  gpu.viscosityActive = true
  gpu.immiscibleSolver!.configure({ materials: props.map((pr, k) => ({ compositions: [k], ...pr })), sigma: (a, b) => sigmaOf(names[a], names[b]), nuNum: INCOMPRESSIBLE_NU_NUM })
  gpu.immiscibleActive = true
  const steps = Math.round(seconds * 120)
  for (let s = 0; s < steps; s++) await submit(device, e => gpu.step(e, 1))
  const imm = gpu.immiscibleSolver!, L = gpu.layout
  const pos = (await gpu.readParticles()).pos
  const slip = new Float32Array(await gpu.readBuffer(imm.bufs.slipState, 16 * pts.length))
  const inf = new Float32Array(await gpu.readBuffer(imm.bufs.cellInf, 4 * 8 * L.size))
  const wy = pts.map((pt, q) => (pt.m === 0 ? pos[4 * q + 1] : NaN)).filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  const wMedian = wy[Math.floor(wy.length / 2)]
  let oil = 0, below = 0, majority = 0, dispersed = 0, tooLarge = 0, noSigma = 0
  const dDisp: number[] = [], alphaStuck: number[] = [], yStuck: number[] = []
  for (let q = 0; q < pts.length; q++) {
    if (pts[q].m !== 1) continue
    oil++
    const y = pos[4 * q + 1]
    if (!(y < wMedian)) continue
    below++
    const nn = [L.nx, L.ny, L.nz], c = [0, 1, 2].map(a => Math.min(nn[a] - 1, Math.max(0, Math.floor(pos[4 * q + a] / DX))))
    const li = (c[0] + 1) + (L.nx + 2) * ((c[1] + 1) + (L.ny + 2) * (c[2] + 1)), cm = inf[8 * li + 1]
    if (cm === 1) { majority++; continue }
    if (slip[4 * q + 3] > 0) { dispersed++; dDisp.push(slip[4 * q + 3]); continue }
    if (cm === 2) { noSigma++; continue }
    tooLarge++; alphaStuck.push(inf[8 * li + 4 + 1]); yStuck.push(y)
  }
  const med = (v: number[]) => { const s2 = [...v].sort((a, b) => a - b); return s2.length ? s2[Math.floor(s2.length / 2)] : NaN }
  gpu.destroy()
  return { oil, below, fractionAbove: 1 - below / oil, wMedian, majority, dispersed, tooLarge, noSigma, dDispMedian: med(dDisp), alphaStuckMedian: med(alphaStuck), yStuckMedian: med(yStuck) }
}
