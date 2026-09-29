/// <reference types="@webgpu/types" />
// S3.4 on the GPU (flip-selftest.html): the ghost-fluid level-set kernels against the f64 reference on identical
// inputs, then the S3.4 physics gates on the GPU path. Metrics only — scripts/fluid-gates/s34-gpu.mjs applies the
// tolerances (the same measurement definitions as scripts/fluid-gates/s34-ref.mjs).
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, CellLabel, makeParticles, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, RHO, L_REF, TAU, mulberry32, f32round, toInit, submit, solverConfig, capFor } from './util'

const G = 9.80665
const GRAV: Vec3 = [0, -G, 0]
/** Solver (padded, no ring) index of interior cell (i, j, k). */
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))

/** s34-ref.mjs block(): 8 ppc in jittered 2×2×2 sub-cells; other ppc a jittered lattice with round(cells·∛ppc) layers
 *  per axis (the block is filled exactly, so the true surface stays at hi + 1). Positions and masses rounded to f32. */
function block(lo: Vec3, hi: Vec3, rng: () => number, ppc = 8, h = DX): RefParticles {
  const pts: number[][] = []
  let vp = h ** 3 / ppc
  if (ppc === 8) {
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
      for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
  } else {
    const cells = [0, 1, 2].map(a => hi[a] - lo[a] + 1), layers = cells.map(c => Math.round(c * Math.cbrt(ppc))), sp = cells.map((c, a) => c * h / layers[a])
    vp = sp[0] * sp[1] * sp[2]
    for (let k = 0; k < layers[2]; k++) for (let j = 0; j < layers[1]; j++) for (let i = 0; i < layers[0]; i++)
      pts.push([lo[0] * h + (i + rng()) * sp[0], lo[1] * h + (j + rng()) * sp[1], lo[2] * h + (k + rng()) * sp[2]])
  }
  const p = makeParticles(pts.length)
  const m = Math.fround(RHO * vp)
  pts.forEach((x, q) => { p.pos.set(x.map(Math.fround), 3 * q); p.mass[q] = m })
  return p
}

async function makeSim(device: GPUDevice, n: Vec3, count: number, o: { h?: number; tol?: number; psiTol?: number; ppc?: number; ring?: Vec3 } = {}) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: o.h ?? DX, ring: o.ring, gravity: GRAV, maxParticles: count, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, pressureTolerance: o.tol ?? 1e-2, pressureCap: capFor(400), solverMethod: solverConfig.method,
    densityProjection: true, psiTolerance: o.psiTol ?? 1e-3, psiCap: capFor(400), freeSurface: 'ghost', ppc: o.ppc,
  })
}

/** One of a sample's four level-set sums, in quanta: the two-word fixed point of common.wgsl (hi word q, lo word 4 + q). */
const lsSum = (sums: Int32Array, at: number, q: number) => sums[at + q] + sums[at + 4 + q] / 2 ** 20
/** Σk of the sample whose eight sum words start at `at` (LS_SCALE divided out). */
export const lsW = (sums: Int32Array, at: number) => lsSum(sums, at, 0) / 2 ** 22
/** φ (m) from one sample point's eight fixed-point sum words (common.wgsl phiFromSums; the LS_SCALE cancels in the ratio). */
export function phiOf(sums: Int32Array, at: number, h: number, R: number, rbar: number) {
  const w = lsSum(sums, at, 0)
  if (w <= 0) return R
  return Math.hypot(lsSum(sums, at, 1) / w * h, lsSum(sums, at, 2) / w * h, lsSum(sums, at, 3) / w * h) - rbar
}
/** Per-sample bound on |φ_GPU − φ_ref| (m) for R = dx (8 ppc), ≤ N = 64 particles per sample, coordinates ≤ ext (m):
 *  - the sample point (f32 (c + ½)·dx) and the uploaded particle (f32 of the reference's f64) are each off by ≤ ½ ulp(ext)
 *    per axis, so r = x − x_s errs by ≤ 1.5·ulp per axis (with the subtraction) and d² = |r|²/R² by
 *    D ≤ 2√3·1.5·ulp/R + 8·2^-24 (dot, R², divide, 1 − d²);
 *  - k = (1 − d²)³ then errs by ≤ 3(1 − d²)²·D + 2·2^-24·k = 3D·k^(2/3) + 1.2e-7·k (relative to the particle's own
 *    weight: the earlier absolute 1.2e-5 per add let any φ through where Σk is a few 2^-22 quanta — K29 at 64³);
 *  - the two-word fixed point rounds each add by ≤ 2^-43 (common.wgsl).
 *  x̄ − x_s = Σk·r/Σk then errs by ≤ [2R·Σ|δk_i| + Σk_i·|δr_i| + (√3 + 1)·N·2^-43]/W, with Σk_i^(2/3) ≤ N^(1/3)·W^(2/3)
 *  (power mean), plus 1e-6·dx for f32 length() − r̄. W = Σk (lsW). */
export function phiTol(W: number, h: number, ext = 64 * h) {
  const N = 64, ulp = 2 ** (Math.floor(Math.log2(ext)) - 23)
  const D = 2 * Math.sqrt(3) * 1.5 * ulp / h + 8 * 2 ** -24, Wc = Math.max(W, 1e-30)
  return (2 * (3 * D * N ** (1 / 3) * Wc ** (-1 / 3) + 1.2e-7) + Math.sqrt(3) * 1.5 * ulp / h + (Math.sqrt(3) + 1) * N * 2 ** -43 / Wc + 1e-6) * h
}
/** common.wgsl thetaOf in f64. */
export const thetaOf = (fl: number, fm: number, fa: number, tMin: number) => {
  if (fl >= 0) return tMin   // a relabelled cell (φ does not resolve its interface): the face is dry
  const t = fm >= 0 ? 0.5 * fl / (fl - fm) : 0.5 + 0.5 * fm / (fm - fa)
  return Math.min(1, Math.max(tMin, t))
}

/** Kernel parity: φ and labels (lsScatter + lsFinalize), face-centre φ and ghost coefficients (ghostCoef), and the
 *  ghost-pressure projection (project.wgsl ghost branch) — each against the reference on the same inputs. */
export async function ghostKernels(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; seed?: number }) {
  const n = o.n ?? [16, 16, 16], ring = o.ring ?? [0, 0, 0], dt = 1 / 120
  const rng = mulberry32(o.seed ?? 31)
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const cpu = new FlipRef(L, { gravity: GRAV, density: RHO, projection: true, freeSurface: 'ghost', pressureTolerance: 1e-9 })
  // a block against the x = 0 wall with a sloped, noisy top, so every face orientation meets the surface
  const p0 = block([0, 0, 1], [Math.min(n[0] - 3, 10), Math.min(n[1] - 4, 8), Math.min(n[2] - 2, 12)], rng)
  const keep: number[] = []
  for (let q = 0; q < p0.n; q++) if (p0.pos[3 * q + 1] < (4 + 0.4 * p0.pos[3 * q] / DX + 1.5 * rng()) * DX) keep.push(q)
  // plus a sheet one particle thick floating above the block, 0.35·dx below a row of cell centres (φ ≈ +0.1·dx there):
  // particle-holding φ ≥ 0 cells with no φ < 0 neighbour, which the resolve rule must make LIQUID
  const sheet: number[][] = []
  for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) sheet.push([(2.25 + 0.5 * a) * DX, 12.15 * DX, (2.25 + 0.5 * b) * DX])
  const p = makeParticles(keep.length + sheet.length)
  keep.forEach((q, i) => { p.pos.set(p0.pos.subarray(3 * q, 3 * q + 3), 3 * i); p.mass[i] = p0.mass[q]; p.vel.set([rng() - 0.5, rng() - 0.5, rng() - 0.5], 3 * i) })
  sheet.forEach((x, i) => { const q = keep.length + i; p.pos.set(x, 3 * q); p.mass[q] = p0.mass[0]; p.vel.set([rng() - 0.5, rng() - 0.5, rng() - 0.5], 3 * q) })
  f32round(p)
  const gpu = await makeSim(device, n, p.n, { ring })
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  const S = L.size, pc = gpu.solver!.paddedCount, R = DX, rbar = DX / 4   // 8 ppc: s = dx/2, R = 2s, r̄ = s/2
  const out: Record<string, unknown> = { n, ring, particles: p.n }

  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); cpu.classifyLevelSet(p)
  // K15 φ at cell centres (lsScatter + lsFinalize) against the reference, sample by sample within phiTol, and labels
  await submit(device, e => gpu.encodePressureLabels(e))
  const phiG = new Float32Array(await gpu.readBuffer(gpu.phiCellBuf!, 4 * pc))
  const cellSums = new Int32Array(await gpu.readBuffer(gpu.lsCellBuf!, 32 * pc))
  const labG = await gpu.solver!.readLabels(0)
  let phiRatio = 0, surfPhiDiff = 0, labelMismatch = 0, nearZero = 0, liquid = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k), li = lin(L, i, j, k), ref = cpu.levelSet[s], tol = phiTol(lsW(cellSums, 8 * li), DX)
    const d = Math.abs(phiG[li] - ref)
    phiRatio = Math.max(phiRatio, d / tol)
    if (Math.abs(ref) < DX) surfPhiDiff = Math.max(surfPhiDiff, d)
    const want = cpu.label[s] === CellLabel.LIQUID ? 1 : 0
    if (want) liquid++
    // a label may legitimately differ only where the reference φ lies within that sample's bound of 0 — its own, or
    // (a particle-holding φ ≥ 0 cell, whose label the resolve rule takes from its neighbours' φ) a face-neighbour's
    if (labG[li] !== want) {
      let near = Math.abs(ref) <= tol
      for (const [di, dj, dk] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) {
        const ni = i + di, nj = j + dj, nk = k + dk
        if (near || ni < 0 || nj < 0 || nk < 0 || ni >= n[0] || nj >= n[1] || nk >= n[2]) continue
        near = Math.abs(cpu.levelSet[L.idx(ni, nj, nk)]) <= phiTol(lsW(cellSums, 8 * lin(L, ni, nj, nk)), DX)
      }
      if (near) nearZero++; else labelMismatch++
    }
  }
  // the resolve rule must be exercised on BOTH branches by this scene: relabelled cells, and φ ≥ 0 particle cells kept AIR
  const gd = await gpu.readDiagnostics()
  let keptAir = 0
  for (let q = 0; q < p.n; q++) {
    const s = L.idx(Math.floor(p.pos[3 * q] / DX), Math.floor(p.pos[3 * q + 1] / DX), Math.floor(p.pos[3 * q + 2] / DX))
    if (cpu.label[s] === CellLabel.AIR) keptAir++
  }
  out.k15 = { phiRatio, surfPhiDiffDx: surfPhiDiff / DX, labelMismatch, nearZero, liquid, relabelsRef: cpu.diag.enclosedRelabels, relabelsGpu: gd.unresolvedRelabels, particlesInAirCells: keptAir }
  // K16 (a) face-centre φ vs the reference within phiTol; (b) ghostCoef on its own inputs — the extra diagonal
  // recomputed in f64 from the GPU's φ (cells + faces) and labels, |Δ| ≤ 1e-5·(extra + a); (c) reported: θ from the GPU's
  // φ vs the reference θ, end to end
  const faceSums = new Int32Array(await gpu.readBuffer(gpu.lsFaceBuf!, 32 * 3 * S))
  const coefG = new Float32Array(await gpu.readBuffer(gpu.solver!.buffers.faceCoef, 16 * pc))
  const a = dt / (RHO * DX * DX)
  const thetaGpu = new Map<string, number>()   // "axis:face-slot" → θ from the GPU's own φ
  let facePhiRatio = 0, coefRatio = 0, extraMax = 0, thetaDiff = 0, faces = 0, aDiff = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const sl = L.idx(i, j, k), li = lin(L, i, j, k)
    aDiff = Math.max(aDiff, Math.abs(coefG[4 * li] - a) / a, Math.abs(coefG[4 * li + 1] - a) / a, Math.abs(coefG[4 * li + 2] - a) / a)
    if (labG[li] !== 1) continue
    let extraG = 0
    for (const ax of [0, 1, 2] as const) for (const side of [0, 1]) {
      const c = [i, j, k]; c[ax] += side ? 1 : -1
      if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= n[0] || c[1] >= n[1] || c[2] >= n[2]) continue
      const la = lin(L, c[0], c[1], c[2])
      if (labG[la] !== 0) continue
      const f = [i, j, k]; f[ax] += side
      const fs = 8 * (ax * S + L.idx(f[0], f[1], f[2])), fp = L.facePos(ax, f[0], f[1], f[2])
      const fmG = phiOf(faceSums, fs, DX, R, rbar)
      facePhiRatio = Math.max(facePhiRatio, Math.abs(fmG - cpu.zhuBridson(fp[0], fp[1], fp[2])) / phiTol(lsW(faceSums, fs), DX))
      const thG = thetaOf(phiG[li], fmG, phiG[la], gpu.thetaMin)
      thetaGpu.set(`${ax}:${L.idx(f[0], f[1], f[2])}`, thG)
      extraG += a * (1 - thG) / thG
      faces++
      const sa = L.idx(c[0], c[1], c[2])
      if (cpu.label[sl] === CellLabel.LIQUID && cpu.label[sa] === CellLabel.AIR) thetaDiff = Math.max(thetaDiff, Math.abs(thG - cpu.theta(sl, sa)))
    }
    coefRatio = Math.max(coefRatio, Math.abs(coefG[4 * li + 3] - extraG) / (1e-5 * (extraG + a))); extraMax = Math.max(extraMax, extraG)
  }
  out.k16 = { facePhiRatio, coefRatio, extraMax, aDiffRel: aDiff, a, faces, thetaDiff }
  // K17 projection with the ghost pressure: the reference u*, valid flags and pressure into the GPU. AIR cells get a
  // poisoned 1e5 Pa — the ghost side must come from −((1 − θ)/θ)·p_liquid, never from the solver vector.
  // (a) faces that are not liquid–air vs the reference projection, |Δu| ≤ 1e-5·max|u| (as K9); (b) liquid–air faces vs
  // u* − Δt/(ρ·dx)·(p₊ − p₋) in f64 with the GPU's θ (identical inputs), |Δu| ≤ 1e-5·max(|u|, Δt/(ρ·dx)·|p_ghost|);
  // (c) reported: liquid–air faces vs the reference end to end (differs only through θ).
  cpu.solvePressure(dt)
  const u3 = new Float32Array(3 * S), v3 = new Uint32Array(3 * S)
  for (const ax of [0, 1, 2]) { u3.set(cpu.u[ax], ax * S); for (let s = 0; s < S; s++) v3[ax * S + s] = cpu.valid[ax][s] }
  gpu.writeGrid(0, { u: u3, valid: v3 })
  const pPad = new Float32Array(pc).fill(1e5)
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] === CellLabel.LIQUID) pPad[lin(L, i, j, k)] = cpu.pressure[s]
  }
  gpu.solver!.writeSolution(pPad)
  for (let s = 0; s < S; s++) cpu.pressure[s] = Math.fround(cpu.pressure[s])
  cpu.projectVelocities(dt)
  await submit(device, e => gpu.encodeProject(e))
  const g17 = await gpu.readGrid(0)
  const inWin = (c: number[]) => c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < n[0] && c[1] < n[1] && c[2] < n[2]
  const labAt = (c: number[]) => (inWin(c) ? labG[lin(L, c[0], c[1], c[2])] : 2)
  const pAt = (c: number[]) => cpu.pressure[L.idx(c[0], c[1], c[2])]   // f32-rounded reference pressure (what the GPU holds)
  const K = dt / (RHO * DX)
  let uRef = 0, bulkDiff = 0, surfRatio = 0, surfEndToEnd = 0, surfFaces = 0, validMismatch = 0
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) uRef = Math.max(uRef, Math.abs(cpu.u[ax][L.idx(i, j, k)]))
  }
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k), cp = [i, j, k], cm = [i, j, k]; cm[ax] -= 1
      const lp = labAt(cp), lm = labAt(cm), uG = g17.u[ax * S + s]
      if (g17.valid[ax * S + s] !== cpu.valid[ax][s]) validMismatch++
      const surface = (lp === 1 && lm === 0) || (lp === 0 && lm === 1)
      if (!surface) { bulkDiff = Math.max(bulkDiff, Math.abs(uG - cpu.u[ax][s])); continue }
      const th = thetaGpu.get(`${ax}:${s}`)!
      const pl = lp === 1 ? pAt(cp) : pAt(cm), pg = -((1 - th) / th) * pl
      const pPlus = lp === 1 ? pl : pg, pMinus = lm === 1 ? pl : pg
      const uExp = u3[ax * S + s] - K * (pPlus - pMinus)
      surfRatio = Math.max(surfRatio, Math.abs(uG - uExp) / (1e-5 * Math.max(uRef, K * Math.abs(pg))))
      surfEndToEnd = Math.max(surfEndToEnd, Math.abs(uG - cpu.u[ax][s]))
      surfFaces++
    }
  }
  out.k17 = { uRef, bulkDiff, surfRatio, surfEndToEnd, surfFaces, validMismatch, refDivergenceAfter: cpu.maxLiquidDivergence() }
  gpu.destroy()
  return out
}

/** S34a on the GPU: flat block H = 10 cells (8-ppc sub-cells or a 4-ppc lattice); interface = top LIQUID centre +
 *  θ·dx with θ from the GPU's own φ (cell centres and face centres); interior non-LIQUID cells counted. */
export async function flatSurface(device: GPUDevice, o: { ppc: number }) {
  const H = 10, p = block([0, 0, 0], [15, H - 1, 15], mulberry32(40 + o.ppc), o.ppc)
  const gpu = await makeSim(device, [16, 20, 16], p.n, { ppc: o.ppc })
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  await submit(device, e => gpu.encodePressureLabels(e))
  const L = gpu.layout, S = L.size, sp = DX / Math.cbrt(o.ppc)
  const phi = new Float32Array(await gpu.readBuffer(gpu.phiCellBuf!, 4 * gpu.solver!.paddedCount))
  const labels = await gpu.solver!.readLabels(0)
  const fsum = new Int32Array(await gpu.readBuffer(gpu.lsFaceBuf!, 32 * 3 * S))
  const ys: number[] = []
  let holes = 0
  for (let k = 1; k < 15; k++) for (let j = 1; j < H - 2; j++) for (let i = 1; i < 15; i++) if (labels[lin(L, i, j, k)] !== 1) holes++
  for (let k = 0; k < 16; k++) for (let i = 0; i < 16; i++) for (let j = 0; j + 1 < 20; j++) {
    if (labels[lin(L, i, j, k)] === 1 && labels[lin(L, i, j + 1, k)] === 0) {
      const fm = phiOf(fsum, 8 * (S + L.idx(i, j + 1, k)), DX, 2 * sp, sp / 2)
      const fl = phi[lin(L, i, j, k)], fa = phi[lin(L, i, j + 1, k)]
      const t = thetaOf(fl, fm, fa, gpu.thetaMin)
      ys.push((j + 0.5 + t) * DX)
      break
    }
  }
  gpu.destroy()
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length
  return { ppc: o.ppc, particles: p.n, columns: ys.length, bias: (mean - H * DX) / DX, spread: Math.max(...ys.map(y => Math.abs(y - mean))) / DX, holes }
}

/** G1c on the GPU: pool 24 cells deep, 3 s; floor pressure extrapolated from the two lowest cell centres. */
export async function hydrostatic(device: GPUDevice) {
  const p = block([0, 0, 0], [15, 23, 15], mulberry32(3))
  const gpu = await makeSim(device, [16, 36, 16], p.n, { tol: 1e-4 })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  for (let s = 0; s < 360; s++) await submit(device, e => gpu.step(e, 1))
  const { pressure } = await gpu.readPressure(), L = gpu.layout
  let p0 = 0, p1 = 0
  for (let k = 1; k < 15; k++) for (let i = 1; i < 15; i++) { p0 += pressure[lin(L, i, 0, k)]; p1 += pressure[lin(L, i, 1, k)] }
  p0 /= 196; p1 /= 196
  const hTrue = p.n * (DX ** 3 / 8) / (16 * DX * 16 * DX)
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { pFloor: p0 + (p0 - p1) / 2, expect: RHO * G * hTrue, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** D1 + D2 on the GPU: standing wave (Souto-Iglesias eq. 65), E_K after every step. */
export async function standingWave(device: GPUDevice, o: { cellsPerH: number }) {
  const Lp = 56 * DX, Hp = 28 * DX, h = Hp / o.cellsPerH, nx = Math.round(Lp / h), nh = o.cellsPerH
  const p = block([0, 0, 0], [nx - 1, nh - 1, 7], mulberry32(50 + nh), 8, h)
  const k = 2 * Math.PI / Lp, omega = Math.sqrt(G * k * Math.tanh(k * Hp)), A = 0.05 * Hp * G / (2 * omega) / Math.cosh(k * Hp)
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1], ch = Math.cosh(k * y), sh = Math.sinh(k * y), sx = Math.sin(k * x), cx = Math.cos(k * x)
    p.vel.set([A * k * ch * sx, -A * k * sh * cx, 0], 3 * q)
    p.c[0].set([A * k * k * ch * cx, A * k * k * sh * sx, 0], 3 * q)
    p.c[1].set([A * k * k * sh * sx, -A * k * k * ch * cx, 0], 3 * q)
  }
  f32round(p)
  // air headroom ≥ H/2, rounded up so every dimension is even (MGPCG halves only even grids)
  const gpu = await makeSim(device, [nx, 2 * Math.ceil(1.5 * nh / 2), 8], p.n, { h, tol: 1e-4, psiTol: 1e-3 })
  const dt = (1 / 120) * (h / DX)
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  const ek = (vel: Float32Array) => { let e = 0; for (let q = 0; q < p.n; q++) e += 0.5 * p.mass[q] * (vel[4 * q] ** 2 + vel[4 * q + 1] ** 2 + vel[4 * q + 2] ** 2); return e }
  const ts = [0], es = [ek((await gpu.readParticles()).vel)]
  const T = 2.2 * Math.PI / omega * 2
  for (let s = 1; s * dt <= T + 1e-9; s++) { await submit(device, e => gpu.step(e, 1)); ts.push(s * dt); es.push(ek((await gpu.readParticles()).vel)) }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { cellsPerH: nh, particles: p.n, omega, k, ts, es, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** A1 / A2 on the GPU: column collapse with the ghost-fluid surface. Front = the r3 §1 bulk-layer operator (farthest
 *  one-cell x-slab holding ≥ 0.5·ppc·nz particles, its leading edge); raw max(x) too; residual height at the back
 *  wall; the downstream-wall bottom-cell pressure (interior z cells) when `wall` is set. */
export async function column(device: GPUDevice, o: { aCells: number; n2: number; h: number; nx: number; tauEnd: number; wall?: boolean }) {
  const rows = Math.round(o.n2 * o.aCells), a = o.aCells * o.h, tUnit = Math.sqrt(a / G), nz = 8
  const p = block([0, 0, 0], [o.aCells - 1, rows - 1, nz - 1], mulberry32(60 + o.aCells), 8, o.h)
  const gpu = await makeSim(device, [o.nx, rows + 8, nz], p.n, { h: o.h, tol: 1e-4, psiTol: 1e-3 })
  const dt = (1 / 240) * (o.h / DX)
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  const L = gpu.layout
  const ts: number[] = [], Z: number[] = [], Zraw: number[] = [], H: number[] = [], wallP: number[] = []
  for (let s = 1; s * dt <= o.tauEnd * tUnit + 1e-9; s++) {
    await submit(device, e => gpu.step(e, 1))
    const r = await gpu.readParticles()
    const counts = new Map<number, number>()
    let hMax = 0, xMax = 0
    for (let q = 0; q < p.n; q++) {
      const x = r.pos[4 * q], i = Math.floor(x / o.h)
      counts.set(i, (counts.get(i) ?? 0) + 1)
      xMax = Math.max(xMax, x)
      if (x < o.h) hMax = Math.max(hMax, r.pos[4 * q + 1])
    }
    let best = -1
    for (const [i, c] of counts) if (c >= 0.5 * 8 * nz && i > best) best = i
    ts.push(s * dt); Z.push((best + 1) * o.h / a); Zraw.push(xMax / a); H.push(hMax / (o.n2 * a))
    if (o.wall) {
      const { pressure } = await gpu.readPressure()
      let pw = 0
      for (let k = 1; k < nz - 1; k++) pw += pressure[lin(L, o.nx - 1, 0, k)]
      wallP.push(pw / (nz - 2))
    }
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { a, n: Math.sqrt(o.n2), tUnit, dt, ts, Z, Zraw, H, wallP, particles: p.n, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}
