/// <reference types="@webgpu/types" />
// S3.7 on the GPU (flip-selftest.html): the monolithic ball (Batty, Bertails & Bridson 2007 eq. 13) — K35 the rank-3
// pressure solve, judged by its TRUE residual against A′ = A + Σ_a Ĵ_a Ĵ_aᵀ assembled in f64 from the GPU's own operator,
// right-hand side and Ĵ (a solver that silently solved A would leave a residual the size of the rank term, which the
// check requires to be ≫ its bound); K36 the ball's implicit update V = V* + Δt·F/M from the GPU's own pressure; then
// s37-ref's A1–A4 on the GPU path. Metrics only — scripts/fluid-gates/s37-gpu.mjs applies the tolerances.
import type { Vec3 } from '../../sim-ref/gridLayout'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { SOLID_REFERENCE } from '../../composition/materialData'
import { DX, RHO, L_REF, TAU, toInit, submit, solverConfig, capFor } from './util'
import { pool } from './sphere'

const G = 9.80665, U = 2 ** -24
/** common.wgsl fixed-point scales of the force reduction. */
const FORCE_SCALE = 1024, SOLID_SCALE = 1048576
const lin = (nx: number, ny: number, i: number, j: number, k: number) => (i + 1) + (nx + 2) * ((j + 1) + (ny + 2) * (k + 1))

/** s37-ref's settings on the GPU: one-density water, ghost surface, density projection; the pressure tolerance given
 *  (the reference runs 1e-6 in f64; f32 MGPCG is gated at 1e-4 and the page's 1e-2 reported). */
async function makeSim(device: GPUDevice, n: Vec3, count: number, tol: number) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -G, 0], maxParticles: count, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, densityProjection: true, freeSurface: 'ghost', solverMethod: solverConfig.method,
    pressureTolerance: tol, pressureCap: capFor(400), psiTolerance: 1e-3, psiCap: capFor(400),
  })
}

// ── K35 + K36 ──

/** A 16³ pool 13 cells deep with an s = 2 ball (R = 3 cells) submerged and moving, released monolithically: one substep
 *  up to the solve, then the projection and the ball's update. */
export async function s37Kernels(device: GPUDevice, o: { seed?: number; tol?: number }) {
  const n: Vec3 = [16, 16, 16], R = 3 * DX, c: Vec3 = [8.3 * DX, 7.6 * DX, 7.8 * DX], dt = 1 / 120, tol = o.tol ?? 1e-4, rhoS = 2 * RHO
  const p = pool(n, 13, c, R, o.seed ?? 51)
  const gpu = await makeSim(device, n, p.n, tol)
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.setSphere({ center: c, radius: R, velocity: [0.05, -0.1, 0.02], density: rhoS, coupling: 'monolithic' })
  gpu.writeParams()
  // gravity first (sphereGravity): V* = Vⁿ + Δt·g, after the ball moved by Δt·Vⁿ
  const s0 = await gpu.readSphere()
  await submit(device, e => gpu.encodeSphereStart(e))
  const s1 = await gpu.readSphere()
  let gRatio = 0
  for (let a = 0; a < 3; a++) {
    const want = s0.velocity[a] + dt * [0, -G, 0][a]
    gRatio = Math.max(gRatio, Math.abs(s1.velocity[a] - want) / (4 * U * (Math.abs(want) + Math.abs(s0.velocity[a])) + 1e-12))
  }
  await submit(device, e => {
    gpu.encodeDensityCorrection(e); gpu.encodeScatter(e); gpu.encodeGridUpdate(e)
    gpu.encodePressureLabels(e); gpu.encodeFillLiquidFaces(e); gpu.encodeDivergence(e); gpu.encodePressureSolve(e)
  })
  const sv = gpu.solver!, pc = sv.paddedCount, L = gpu.layout, nx = L.nx, ny = L.ny
  const coef = new Float32Array(await gpu.readBuffer(sv.buffers.coef, 16 * pc))
  const b = new Float32Array(await gpu.readBuffer(sv.buffers.rhs, 4 * pc))
  const J = new Float32Array(await gpu.readBuffer(sv.buffers.rankJ, 16 * pc))
  const x = new Float32Array(await gpu.readBuffer(sv.buffers.x, 4 * pc))
  const st = await sv.readStats()
  const sy = nx + 2, sz = (nx + 2) * (ny + 2)
  // f64: s_a = Ĵ_aᵀx over the solver's unknowns (diag > 0), then r = b − (A x + Σ_a Ĵ_a s_a) per unknown
  const s = [0, 0, 0]
  let unknowns = 0, jRows = 0
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const ci = lin(nx, ny, i, j, k)
    if (!(coef[4 * ci + 3] > 0)) continue
    unknowns++
    if (J[4 * ci] !== 0 || J[4 * ci + 1] !== 0 || J[4 * ci + 2] !== 0) jRows++
    for (let a = 0; a < 3; a++) s[a] += J[4 * ci + a] * x[ci]
  }
  let resInf = 0, mag = 0, rankInf = 0
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const ci = lin(nx, ny, i, j, k)
    const d = coef[4 * ci + 3]
    if (!(d > 0)) continue
    const terms = [d * x[ci], -coef[4 * (ci + 1)] * x[ci + 1], -coef[4 * ci] * x[ci - 1], -coef[4 * (ci + sy) + 1] * x[ci + sy], -coef[4 * ci + 1] * x[ci - sy],
      -coef[4 * (ci + sz) + 2] * x[ci + sz], -coef[4 * ci + 2] * x[ci - sz]]
    const rank = J[4 * ci] * s[0] + J[4 * ci + 1] * s[1] + J[4 * ci + 2] * s[2]
    const ax = terms.reduce((q, v) => q + v, 0) + rank
    resInf = Math.max(resInf, Math.abs(b[ci] - ax))
    mag = Math.max(mag, terms.reduce((q, v) => q + Math.abs(v), 0) + Math.abs(rank) + Math.abs(b[ci]))
    rankInf = Math.max(rankInf, Math.abs(rank))
  }
  // the solver stops on its RECURSIVE residual ≤ tol; the true residual departs from it by the f32 rounding of each
  // iteration's updates, ≤ ~8u·max_row(Σ|terms| + |b|) per iteration (+2 for the init and the final state)
  const bound = tol + (st.iterations + 2) * 8 * U * mag
  const k35 = { resInf, bound, ratio: resInf / bound, rankInf, discrimination: rankInf / bound, iterations: st.iterations, converged: st.converged, unknowns, jRows }

  // K36: the projection and the ball's update, against V* + Δt·F/M recomputed in f64 from the GPU's own p
  const before = await gpu.readSphere()
  await submit(device, e => gpu.encodeProject(e, true))
  const after = await gpu.readSphere()
  const lab = await sv.readLabels(0)
  const fsol = new Float32Array(await gpu.readBuffer(gpu.faceSolidBuf, 4 * 3 * L.size))
  const ftype = new Uint32Array(await gpu.readBuffer(gpu.faceTypeBuf, 4 * 3 * L.size))
  const F = [0, 0, 0], faces = [0, 0, 0], fAbs = [0, 0, 0]
  let sumS = 0, nY = 0
  for (const a of [0, 1, 2]) {
    const lo = [-1, -1, -1], hi = [nx, ny, L.nz]
    lo[a] = 0
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const sl = a * L.size + L.idx(i, j, k), S = fsol[sl]
      if (!(S > 0)) continue
      if (a === 1) { sumS += S; nY++ }
      if (ftype[sl] === 1) continue   // FaceType.SOLID (wall)
      const e = [0, 0, 0]; e[a] = 1
      const inWin = (q: number[]) => q.every((v, bb) => v >= 0 && v < [nx, ny, L.nz][bb])
      const cp = [i, j, k], cm = [i - e[0], j - e[1], k - e[2]]
      const pp = inWin(cp) && lab[lin(nx, ny, cp[0], cp[1], cp[2])] === 1 ? x[lin(nx, ny, cp[0], cp[1], cp[2])] : 0
      const pm = inWin(cm) && lab[lin(nx, ny, cm[0], cm[1], cm[2])] === 1 ? x[lin(nx, ny, cm[0], cm[1], cm[2])] : 0
      const f = -S * DX * DX * (pp - pm)
      F[a] += f; faces[a]++; fAbs[a] += Math.abs(f)
    }
  }
  const VJ = sumS * DX ** 3, M = rhoS * VJ
  const Vexp = [0, 1, 2].map(a => before.velocity[a] + dt * F[a] / M)
  // bound: each face's force is rounded to 1/FORCE_SCALE N (and its f32 product to 3u), V_J's sum to 1/SOLID_SCALE per
  // face; the update's f32 arithmetic 4u·|V|
  const dVJ = nY * 0.5 / SOLID_SCALE * DX ** 3
  let vRatio = 0, vChange = 0
  for (let a = 0; a < 3; a++) {
    const dF = faces[a] * 0.5 / FORCE_SCALE + 3 * U * fAbs[a]
    const B = dt / M * (dF + Math.abs(F[a]) * dVJ / VJ) + 4 * U * (Math.abs(after.velocity[a]) + Math.abs(before.velocity[a])) + 1e-12
    vRatio = Math.max(vRatio, Math.abs(after.velocity[a] - Vexp[a]) / B)
    vChange = Math.max(vChange, Math.abs(after.velocity[a] - before.velocity[a]))
  }
  const k36 = { vRatio, vChange, gRatio, force: F, forceGpu: after.force, volumeJ: VJ, volumeJGpu: after.volumeJ }
  gpu.destroy()
  return { particles: p.n, k35, k36 }
}

// ── s37-ref A1–A4 on the GPU ──

/** s37-ref's scene: a pool nx × depth × nz cells in an nx × ny × nz tank, the particles inside the ball removed; the
 *  ball held (scripted, V = 0) while the pool settles `settle` substeps, then released monolithically at ρ_s. */
async function scene(device: GPUDevice, o: { n: Vec3; depth: number; c: Vec3; R: number; rhoS: number; seed: number; settle: number; tol: number }) {
  const p = pool(o.n, o.depth, o.c, o.R, o.seed)
  const gpu = await makeSim(device, o.n, p.n, o.tol)
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  gpu.setSphere({ center: o.c, radius: o.R, velocity: [0, 0, 0], density: 0 })
  for (let k = 0; k < o.settle; k++) await submit(device, e => gpu.step(e, 1))
  gpu.setSphere({ center: o.c, radius: o.R, velocity: [0, 0, 0], density: o.rhoS, coupling: 'monolithic' })
  return { gpu, n: p.n }
}

export async function s37Physics(device: GPUDevice, o: { test: 'A1' | 'A3' | 'A4' | 'F0' | 'T0'; Rc?: number; s?: number; tol?: number; seed?: number }) {
  const tol = o.tol ?? 1e-4, dt = 1 / 120
  if (o.test === 'T0') {   // diagnostics: one monolithic substep at a time on the A3 neutral ball — V, V*, V_J, F per stage
    const Rc = 3.5, n = 28, c: Vec3 = [n / 2 * DX + 0.3 * DX, 4 * Rc * DX, n / 2 * DX - 0.2 * DX]
    const { gpu } = await scene(device, { n: [n, n + 2, n], depth: n, c, R: Rc * DX, rhoS: RHO, seed: 33, settle: 120, tol })
    const rows: Record<string, number>[] = []
    for (let k = 1; k <= 360; k++) {
      const s0 = await gpu.readSphere()
      gpu.writeParams()
      await submit(device, e => gpu.encodeSphereStart(e))
      const s1 = await gpu.readSphere()
      await submit(device, e => { if (gpu.densityProjection) gpu.encodeDensityCorrection(e); gpu.encodeSubstepBody(e) })
      const s2 = await gpu.readSphere()
      if (k % 30 === 0) {
        const M2 = RHO * s2.volumeJ
        rows.push({ k, v0: s0.velocity[1], vStar: s1.velocity[1], v2: s2.velocity[1], vj1: s1.volumeJ, vj2: s2.volumeJ, Fy: s2.force[1],
          gravStep: (s1.velocity[1] - s0.velocity[1]) / dt, forceStep: (s2.velocity[1] - s1.velocity[1]) / dt, FoverM: s2.force[1] / M2, dy: (s2.center[1] - c[1]) / DX })
      }
    }
    gpu.destroy()
    return { rows }
  }
  if (o.test === 'F0') {   // diagnostics: the pressure force on a HELD ball in the settled A3 pool vs ρ·g·V_J, per second
    const Rc = 3.5, n = 28, c: Vec3 = [n / 2 * DX + 0.3 * DX, 4 * Rc * DX, n / 2 * DX - 0.2 * DX]
    const p = pool([n, n + 2, n], n, c, Rc * DX, 33)
    const gpu = await makeSim(device, [n, n + 2, n], p.n, tol)
    gpu.dt = dt
    gpu.setParticles(toInit(p))
    gpu.setSphere({ center: c, radius: Rc * DX, velocity: [0, 0, 0], density: 0 })
    const rows: { t: number; ratio: number; Fy: number; VJ: number }[] = []
    for (let k = 1; k <= 600; k++) {
      await submit(device, e => gpu.step(e, 1))
      if (k % 60 === 0) { const sp = await gpu.readSphere(); rows.push({ t: k / 120, ratio: sp.force[1] / (RHO * G * sp.volumeJ) - 1, Fy: sp.force[1], VJ: sp.volumeJ }) }
    }
    gpu.destroy()
    return { rows }
  }
  if (o.test === 'A1') {   // A1 / A2: the first substep's acceleration after release
    const Rc = o.Rc ?? 3.5, s = o.s ?? 2, n = Math.round(8 * Rc), R = Rc * DX
    const { gpu, n: count } = await scene(device, { n: [n, n + 2, n], depth: n, c: [n / 2 * DX + 0.3 * DX, 4 * Rc * DX, n / 2 * DX - 0.2 * DX], R, rhoS: s * RHO, seed: o.seed ?? 31, settle: 120, tol })
    const v0 = (await gpu.readSphere()).velocity
    await submit(device, e => gpu.step(e, 1))
    const sp = await gpu.readSphere(), d = await gpu.readDiagnostics()
    gpu.destroy()
    return { a: -(sp.velocity[1] - v0[1]) / dt, particles: count, n, capHits: d.capHits, breakdowns: d.breakdowns }
  }
  if (o.test === 'A3') {   // neutral ball, 10 s
    const Rc = 3.5, n = 28, c: Vec3 = [n / 2 * DX + 0.3 * DX, 4 * Rc * DX, n / 2 * DX - 0.2 * DX]
    const { gpu, n: count } = await scene(device, { n: [n, n + 2, n], depth: n, c, R: Rc * DX, rhoS: RHO, seed: 33, settle: 120, tol })
    let maxDrift = 0
    const traj: { t: number; dc: number[]; v: number[]; F: number[] }[] = []
    for (let k = 1; k <= 1200; k++) {
      await submit(device, e => gpu.step(e, 1))
      if (k % 12 === 0) {
        const sp = await gpu.readSphere()
        maxDrift = Math.max(maxDrift, Math.hypot(sp.center[0] - c[0], sp.center[1] - c[1], sp.center[2] - c[2]) / DX)
        if (k % 120 === 0) traj.push({ t: k / 120, dc: sp.center.map((v, a) => +((v - c[a]) / DX).toFixed(4)), v: sp.velocity.map(v => +v.toExponential(3)), F: sp.force.map(v => +v.toFixed(3)) })
      }
    }
    const d = await gpu.readDiagnostics()
    gpu.destroy()
    return { maxDrift, particles: count, capHits: d.capHits, breakdowns: d.breakdowns, traj }
  }
  // A4: floating ball s = ½ (or the given s), released at the still level
  const Rc = 3.5, R = Rc * DX, n = 28, depth = 12, s = o.s ?? 0.5
  const { gpu, n: count } = await scene(device, { n: [n, 22, n], depth, c: [n / 2 * DX + 0.3 * DX, depth * DX, n / 2 * DX - 0.2 * DX], R, rhoS: s * RHO, seed: 34, settle: 0, tol })
  const A = (n * DX) ** 2, V = 4 / 3 * Math.PI * R ** 3, VP = DX ** 3 / 8
  const frac = (yc: number) => { let f = 0.5; for (let it = 0; it < 50; it++) { const Lv = (count * VP + f * V) / A, h = Math.min(2 * R, Math.max(0, Lv - (yc - R))); f = h * h * (3 * R - h) / (4 * R ** 3) } return f }
  const fs: number[] = []
  for (let k = 1; k <= 720; k++) {
    await submit(device, e => gpu.step(e, 1))
    if (k > 480 && k % 6 === 0) fs.push(frac((await gpu.readSphere()).center[1]))
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { f: fs.reduce((q, v) => q + v, 0) / fs.length, fMin: Math.min(...fs), fMax: Math.max(...fs), particles: count, capHits: d.capHits, breakdowns: d.breakdowns }
}

export const IRON_RHO = SOLID_REFERENCE.iron.solidDensityKgM3!
