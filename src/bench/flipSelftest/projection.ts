/// <reference types="@webgpu/types" />
// S3.1b on the GPU (flip-selftest.html): the projection kernels against the f64 reference on identical inputs, then
// the S3.1b physics gates on the GPU path. Metrics only — scripts/fluid-gates/s31b-gpu.mjs applies the tolerances.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, CellLabel } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, RHO, L_REF, TAU, mulberry32, blob, f32round, toInit, submit } from './util'

const G = 9.80665
const GRAV: Vec3 = [0, -G, 0]

/** Solver (padded, no ring) index of interior cell (i, j, k). */
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))

async function makeSim(device: GPUDevice, n: Vec3, o: { ring?: Vec3; tol?: number; cap?: number; count: number; gravity?: Vec3 }) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, ring: o.ring, gravity: o.gravity ?? GRAV, maxParticles: o.count, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, pressureTolerance: o.tol ?? 1e-2, pressureCap: o.cap ?? 400, solverMethod: 'jpcg',
  })
}

/** Kernel parity: labels, divergence, pressure solve, projection — each on the reference's exact inputs. */
export async function projKernels(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; seed?: number }) {
  const n = o.n ?? [16, 16, 16], ring = o.ring ?? [0, 0, 0], dt = 1 / 120
  const rng = mulberry32(o.seed ?? 9)
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const cpu = new FlipRef(L, { gravity: GRAV, projection: true, density: RHO, pressureTolerance: 1e-9 })
  // a random-velocity block touching the x = 0 wall and the floor, with air above and beside it
  const p = blob([0, 0, 1], [Math.min(n[0] - 3, 10), Math.min(n[1] - 4, 8), Math.min(n[2] - 2, 12)], rng)
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) p.vel[3 * q + a] = rng() * 2 - 1
  f32round(p)
  const gpu = await makeSim(device, n, { ring, tol: 1e-6, cap: 3000, count: p.n })
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  const S = L.size, out: Record<string, unknown> = { n, ring, particles: p.n }

  // reference state before the solve
  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); cpu.classify(p)
  const uStar = cpu.u.map(a => new Float32Array(a)) as Float32Array[]
  const u3 = new Float32Array(3 * S), v3 = new Uint32Array(3 * S)
  for (const a of [0, 1, 2]) { u3.set(uStar[a], a * S); for (let s = 0; s < S; s++) v3[a * S + s] = cpu.valid[a][s] }

  // K6 labels (GPU from its own particles)
  await submit(device, e => gpu.encodeLabels(e))
  const { labels: gLab } = await gpu.readPressure()
  let labelMismatch = 0, liquid = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const c = cpu.label[L.idx(i, j, k)], g = gLab[lin(L, i, j, k)]
    const want = c === CellLabel.LIQUID ? 1 : c === CellLabel.AIR ? 0 : 2
    if (g !== want) labelMismatch++
    if (c === CellLabel.LIQUID) liquid++
  }
  out.k6 = { labelMismatch, liquidCells: liquid }

  // K7 divergence on the reference u* and valid flags
  const solve = cpu.solvePressure(dt)
  gpu.writeGrid(0, { u: u3, valid: v3 })
  gpu.resetDiagnostics()
  await submit(device, e => gpu.encodeDivergence(e))
  const rhsG = new Float32Array(await gpu.readBuffer(gpu.solver!.buffers.rhs, 4 * gpu.solver!.paddedCount))
  let rhsDiff = 0, rhsRef = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const r = cpu.rhs[L.idx(i, j, k)]
    rhsDiff = Math.max(rhsDiff, Math.abs(rhsG[lin(L, i, j, k)] - r)); rhsRef = Math.max(rhsRef, Math.abs(r))
  }
  const d7 = await gpu.readDiagnostics()
  out.k7 = { rhsDiff, rhsRef, unsetDivergenceFaces: d7.unsetDivergenceFaces, refUnset: cpu.diag.unsetDivergenceFaces }

  // K8 pressure solve (GPU JPCG to 1e-6 1/s from a cold start) vs the reference solved to 1e-9
  device.queue.writeBuffer(gpu.solver!.buffers.x, 0, new Float32Array(gpu.solver!.paddedCount))
  await submit(device, e => gpu.encodePressureSolve(e))
  const { pressure: pG } = await gpu.readPressure()
  const faults = await gpu.readDiagnostics()
  const stats = await gpu.solver!.readStats()
  let pDiff = 0, pRef = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] !== CellLabel.LIQUID) continue
    pDiff = Math.max(pDiff, Math.abs(pG[lin(L, i, j, k)] - cpu.pressure[s])); pRef = Math.max(pRef, Math.abs(cpu.pressure[s]))
  }
  out.k8 = { pDiff, pRef, gpuIterations: stats.iterations, gpuRInf: stats.rInf, converged: stats.converged, breakdown: stats.breakdown,
    capHits: faults.capHits, refIterations: solve.iterations, refResidual: solve.residualInf }

  // K9 projection: the reference pressure (as f32) and u* into the GPU, then project
  // AIR (and ghost) cells get a deliberately wrong 1e5 Pa: the kernel must use p = 0 there from the labels, not
  // rely on the solver vector happening to hold 0 (warm starts leave old values in cells that became AIR)
  const pPad = new Float32Array(gpu.solver!.paddedCount).fill(1e5)
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] === CellLabel.LIQUID) pPad[lin(L, i, j, k)] = cpu.pressure[s]
  }
  gpu.solver!.writeSolution(pPad)
  for (let s = 0; s < L.size; s++) cpu.pressure[s] = Math.fround(cpu.pressure[s])
  gpu.writeGrid(0, { u: u3, valid: v3 })
  cpu.projectVelocities(dt)
  await submit(device, e => gpu.encodeProject(e))
  const g9 = await gpu.readGrid(0)
  let uDiff = 0, uRef = 0, validMismatch = 0
  for (const a of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(a)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k)
      uDiff = Math.max(uDiff, Math.abs(g9.u[a * S + s] - cpu.u[a][s])); uRef = Math.max(uRef, Math.abs(cpu.u[a][s]))
      if (g9.valid[a * S + s] !== cpu.valid[a][s]) validMismatch++
    }
  }
  out.k9 = { uDiff, uRef, validMismatch, refDivergenceAfter: cpu.maxLiquidDivergence() }
  gpu.destroy()
  return out
}

/** Max |∇·u| over liquid cells of the GPU grid after a step (u in buffer A, labels from the solver). */
async function gpuDivergence(gpu: FlipGpuSimulator): Promise<number> {
  const L = gpu.layout, S = L.size
  const g = await gpu.readGrid(0), { labels } = await gpu.readPressure()
  let m = 0
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
    if (labels[lin(L, i, j, k)] !== 1) continue
    let div = 0
    for (const a of [0, 1, 2]) div += g.u[a * S + L.idx(i + (a === 0 ? 1 : 0), j + (a === 1 ? 1 : 0), k + (a === 2 ? 1 : 0))] - g.u[a * S + L.idx(i, j, k)]
    m = Math.max(m, Math.abs(div / L.dx))
  }
  return m
}

/** G1a on the GPU: 16×64×16, 24 cells deep, one substep solved to ‖r‖∞ ≤ 1e-5 1/s; p vs ρ·g·dx·(24 − j). */
export async function g1a(device: GPUDevice) {
  const p = blob([0, 0, 0], [15, 23, 15], mulberry32(1))
  const gpu = await makeSim(device, [16, 64, 16], { tol: 1e-5, cap: 3000, count: p.n })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  await submit(device, e => gpu.step(e, 1))
  const { pressure } = await gpu.readPressure()
  const stats = await gpu.solver!.readStats(), d = await gpu.readDiagnostics()
  let worst = 0
  for (let k = 0; k < 16; k++) for (let j = 0; j < 24; j++) for (let i = 0; i < 16; i++) {
    const exact = RHO * G * DX * (24 - j)
    worst = Math.max(worst, Math.abs(pressure[lin(gpu.layout, i, j, k)] - exact) / exact)
  }
  const div = await gpuDivergence(gpu)
  gpu.destroy()
  return { worst, iterations: stats.iterations, rInf: stats.rInf, converged: stats.converged, divAfter: div, unsetDivergenceFaces: d.unsetDivergenceFaces }
}

/** G1b + C5 + G5 on the GPU: the 6 s settling run (ε_div = 1e-2 1/s, JPCG cap 400). */
export async function settle(device: GPUDevice, o: { seconds?: number; sampleAt?: number }) {
  const seconds = o.seconds ?? 6, sampleAt = o.sampleAt ?? 3
  const p = blob([0, 0, 0], [15, 23, 15], mulberry32(3))
  const gpu = await makeSim(device, [16, 64, 16], { count: p.n })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const L = gpu.layout
  let g1b: Record<string, number> | null = null, trueDivMax = 0, trueDivSamples = 0
  const steps = Math.round(seconds * 120)
  for (let s = 1; s <= steps; s++) {
    await submit(device, e => gpu.step(e, 1))
    // FINAL-PLAN G5: the TRUE residual (post-projection divergence, recomputed here) on sampled frames
    if (s % 60 === 0) { trueDivMax = Math.max(trueDivMax, await gpuDivergence(gpu)); trueDivSamples++ }
    if (s === Math.round(sampleAt * 120)) {
      const { pressure, labels } = await gpu.readPressure()
      const ys: number[] = [], ps: number[] = []
      for (let j = 0; j < 64; j++) {
        let sum = 0, all = true
        for (let k = 1; k < 15 && all; k++) for (let i = 1; i < 15; i++) { const c = lin(L, i, j, k); if (labels[c] !== 1) { all = false; break } sum += pressure[c] }
        if (!all) break
        ys.push((j + 0.5) * DX); ps.push(sum / 196)
      }
      const fitN = ys.length - 2
      const xm = ys.slice(0, fitN).reduce((a, b) => a + b, 0) / fitN, pm = ps.slice(0, fitN).reduce((a, b) => a + b, 0) / fitN
      let sxy = 0, sxx = 0
      for (let i = 0; i < fitN; i++) { sxy += (ys[i] - xm) * (ps[i] - pm); sxx += (ys[i] - xm) ** 2 }
      const slope = sxy / sxx, pFloor = pm - slope * xm, hTrue = p.n * (DX ** 3 / 8) / (16 * DX * 16 * DX)
      g1b = { slope, relGrad: (-slope - RHO * G) / (RHO * G), pFloor, expect: RHO * G * hTrue, offset: pFloor - RHO * G * hTrue, layers: ys.length, hTrue }
    }
  }
  const r = await gpu.readParticles(), d = await gpu.readDiagnostics()
  let v2 = 0
  for (let q = 0; q < p.n; q++) v2 += r.vel[4 * q] ** 2 + r.vel[4 * q + 1] ** 2 + r.vel[4 * q + 2] ** 2
  const stats = await gpu.solver!.readStats()
  gpu.destroy()
  return { g1b, rms: Math.sqrt(v2 / p.n), H: 24 * DX, steps, solves: d.solves, capHits: d.capHits, breakdowns: d.breakdowns, maxIterations: d.maxIterations,
    lastIterations: stats.iterations, wallClamps: d.wallClamps, unsetDivergenceFaces: d.unsetDivergenceFaces, trueDivMax, trueDivSamples }
}

/** B1 + E1 on the GPU: dam break in the 128×24×4 slab (h0 = 8 cells), 1 s at Δt = 1/240 s. */
export async function damBreak(device: GPUDevice) {
  const p = blob([0, 0, 0], [7, 7, 3], mulberry32(4))
  const gpu = await makeSim(device, [128, 24, 4], { count: p.n })
  const dt = 1 / 240
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  const h0 = 8 * DX, T0 = Math.sqrt(h0 / G)
  const E = (pos: Float32Array, vel: Float32Array) => {
    let ek = 0, ep = 0
    for (let q = 0; q < p.n; q++) {
      ek += 0.5 * p.mass[q] * (vel[4 * q] ** 2 + vel[4 * q + 1] ** 2 + vel[4 * q + 2] ** 2)
      ep += p.mass[q] * G * pos[4 * q + 1]
    }
    return ek + ep
  }
  const r0 = await gpu.readParticles()
  const E0 = E(r0.pos, r0.vel)
  const ts: number[] = [], fronts: number[] = [], es: number[] = []
  let clampsInWindow = 0
  for (let s = 1; s * dt <= 1.0 + 1e-9; s++) {
    const c0 = (await gpu.readDiagnostics()).wallClamps
    await submit(device, e => gpu.step(e, 1))
    const r = await gpu.readParticles(), t = s * dt
    const xs = Array.from({ length: p.n }, (_, q) => r.pos[4 * q]).sort((a, b) => a - b)
    ts.push(t); fronts.push(xs[Math.floor(0.995 * (xs.length - 1))]); es.push(E(r.pos, r.vel))
    if (t / T0 >= 1 && t / T0 <= 3) clampsInWindow += (await gpu.readDiagnostics()).wallClamps - c0
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { h0, T0, E0, ts, fronts, es, extent: 128 * DX, clampsInWindow, wallClamps: d.wallClamps, solves: d.solves, capHits: d.capHits, breakdowns: d.breakdowns }
}

