/// <reference types="@webgpu/types" />
// S3.2 on the GPU (flip-selftest.html): the density-projection kernels against the f64 reference on identical inputs,
// then the S3.2 physics gates on the GPU path. Metrics only — scripts/fluid-gates/s32-gpu.mjs applies the tolerances.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, CellLabel, makeParticles, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator, MASS_SCALE } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, RHO, L_REF, TAU, mulberry32, f32round, toInit, submit, solverConfig, capFor } from './util'

const G = 9.80665
const GRAV: Vec3 = [0, -G, 0]
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))

/** Particles over cells lo..hi: ppc = 8 jittered sub-cells (rest packing), otherwise uniform random; V_p = h³/8 always. */
function block(lo: Vec3, hi: Vec3, rng: () => number, ppc = 8, h = DX): RefParticles {
  const pts: number[][] = []
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
    for (let s = 0; s < ppc; s++) {
      if (ppc === 8) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
      else pts.push([(i + rng()) * h, (j + rng()) * h, (k + rng()) * h])
    }
  const p = makeParticles(pts.length)
  const m = Math.fround(RHO * h ** 3 / 8)
  pts.forEach((x, q) => { p.pos.set(x.map(Math.fround), 3 * q); p.mass[q] = m })
  return p
}

function merge(a: RefParticles, b: RefParticles): RefParticles {
  const p = makeParticles(a.n + b.n)
  for (const k of ['pos', 'vel', 'mass'] as const) { p[k].set(a[k], 0); p[k].set(b[k], a[k].length) }
  return p
}

async function makeSim(device: GPUDevice, n: Vec3, o: { count: number; h?: number; density?: boolean; gravity?: Vec3; ring?: Vec3; psiTol?: number; psiCap?: number; tol?: number; cap?: number }) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: o.h ?? DX, ring: o.ring, gravity: o.gravity ?? GRAV, maxParticles: o.count, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, pressureTolerance: o.tol ?? 1e-2, pressureCap: capFor(o.cap ?? 400), solverMethod: solverConfig.method,
    densityProjection: o.density ?? true, psiTolerance: o.psiTol ?? 1e-3, psiCap: capFor(o.psiCap ?? 400),
  })
}

/** Kernel parity K10–K14 on the reference's exact inputs. */
export async function densKernels(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; seed?: number }) {
  const n = o.n ?? [16, 16, 16], ring = o.ring ?? [0, 0, 0]
  const rng = mulberry32(o.seed ?? 12)
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const cpu = new FlipRef(L, { gravity: GRAV, density: RHO, projection: true, densityProjection: true, psiTolerance: 1e-9 })
  // a compressed (12 ppc) block against the x = 0 wall and the floor, plus a sparse (6 ppc) one: f̃ spans the clamps
  const p = merge(block([0, 0, 1], [Math.min(n[0] - 4, 6), Math.min(n[1] - 5, 6), Math.min(n[2] - 3, 8)], rng, 12),
    block([Math.min(n[0] - 3, 9), 0, 1], [Math.min(n[0] - 1, 12), Math.min(n[1] - 5, 4), Math.min(n[2] - 3, 6)], rng, 6))
  f32round(p)
  const gpu = await makeSim(device, n, { count: p.n, ring, psiTol: 1e-6, psiCap: 4000 })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  const S = L.size, pc = gpu.psiSolver!.paddedCount, out: Record<string, unknown> = { n, ring, particles: p.n }
  const before = p.pos.slice()
  cpu.densityCorrect(p)                                             // reference: every quantity at once

  // K10 cellScatter (GPU labels + volume fraction from its own particles)
  await submit(device, e => { gpu.encodeLabels(e); gpu.encodeCellScatter(e) })
  const vf = new Int32Array(await gpu.readBuffer(gpu.vfracBuf!, 4 * pc))
  let fDiff = 0, fRef = 0
  for (let k = -1; k <= n[2]; k++) for (let j = -1; j <= n[1]; j++) for (let i = -1; i <= n[0]; i++) {
    const r = cpu.volumeFraction[L.idx(i, j, k)]
    fDiff = Math.max(fDiff, Math.abs(vf[lin(L, i, j, k)] / MASS_SCALE - r)); fRef = Math.max(fRef, Math.abs(r))
  }
  out.k10 = { fDiff, fRef }

  // K11 densityRhs (GPU from its own labels and volume fraction — both proven above)
  await submit(device, e => gpu.encodeDensityRhs(e))
  const rhs = new Float32Array(await gpu.readBuffer(gpu.psiSolver!.buffers.rhs, 4 * pc))
  const fc = new Float32Array(await gpu.readBuffer(gpu.fCompBuf!, 4 * pc))
  let bDiff = 0, bRef = 0, fcDiff = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k), li = lin(L, i, j, k)
    bDiff = Math.max(bDiff, Math.abs(rhs[li] - cpu.psiRhs[s])); bRef = Math.max(bRef, Math.abs(cpu.psiRhs[s]))
    if (cpu.label[s] === CellLabel.LIQUID) fcDiff = Math.max(fcDiff, Math.abs(fc[li] - cpu.fCompensated[s]))
  }
  out.k11 = { bDiff, bRef, fcDiff }

  // K12 ψ solve: the reference rhs (as f32) into the GPU, cold JPCG to 1e-6 vs the reference solved to 1e-9
  const bPad = new Float32Array(pc)
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) bPad[lin(L, i, j, k)] = cpu.psiRhs[L.idx(i, j, k)]
  gpu.psiSolver!.writeRhs(bPad)
  gpu.resetDiagnostics()
  await submit(device, e => gpu.encodePsiSolve(e))
  const psiG = await gpu.psiSolver!.readVector('x'), stats = await gpu.psiSolver!.readStats(), d12 = await gpu.readDiagnostics()
  let psiDiff = 0, psiRef = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] !== CellLabel.LIQUID) continue
    psiDiff = Math.max(psiDiff, Math.abs(psiG[lin(L, i, j, k)] - cpu.psi[s])); psiRef = Math.max(psiRef, Math.abs(cpu.psi[s]))
  }
  out.k12 = { psiDiff, psiRef, iterations: stats.iterations, rInf: stats.rInf, converged: stats.converged, breakdown: stats.breakdown, capHits: d12.psiCapHits, refIterations: cpu.lastDensity!.iterations }

  // K13 faceDisplacement: the reference ψ̂ (AIR and ghost cells poisoned to 1e3) into the GPU
  const psiPad = new Float32Array(pc).fill(1e3)
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] === CellLabel.LIQUID) psiPad[lin(L, i, j, k)] = cpu.psi[s]
  }
  gpu.psiSolver!.writeSolution(psiPad)
  await submit(device, e => gpu.encodeFaceDisplacement(e))
  const dsp = new Float32Array(await gpu.readBuffer(gpu.dispBuf!, 4 * 3 * S))
  let dDiff = 0, dRef = 0
  for (const a of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(a)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k)
      dDiff = Math.max(dDiff, Math.abs(dsp[a * S + s] - cpu.displacement[a][s])); dRef = Math.max(dRef, Math.abs(cpu.displacement[a][s]))
    }
  }
  out.k13 = { dDiff, dRef }

  // K14 positionCorrect: the reference displacements (as f32) and the original positions
  const dIn = new Float32Array(3 * S)
  for (const a of [0, 1, 2]) dIn.set(cpu.displacement[a], a * S)
  device.queue.writeBuffer(gpu.dispBuf!, 0, dIn)
  const pos0 = new Float32Array(4 * p.n)
  for (let q = 0; q < p.n; q++) pos0.set([before[3 * q], before[3 * q + 1], before[3 * q + 2], 0], 4 * q)
  device.queue.writeBuffer(gpu.posBuf, 0, pos0)
  gpu.resetDiagnostics()
  await submit(device, e => gpu.encodePositionCorrect(e))
  const r = await gpu.readParticles(), d14 = await gpu.readDiagnostics()
  let xDiff = 0, move = 0
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) {
    xDiff = Math.max(xDiff, Math.abs(r.pos[4 * q + a] - p.pos[3 * q + a])); move = Math.max(move, Math.abs(p.pos[3 * q + a] - before[3 * q + a]))
  }
  out.k14 = { xDiff, maxMove: move, extent: Math.max(...L.extent), densityClamps: { gpu: d14.densityClamps, cpu: cpu.diag.densityClamps } }
  gpu.destroy()
  return out
}

/** Energy E_K + E_P (J) of GPU particle arrays (pos/vel vec4), masses from the reference set. */
function energy(p: RefParticles, pos: Float32Array, vel: Float32Array) {
  let e = 0
  for (let q = 0; q < p.n; q++) e += 0.5 * p.mass[q] * (vel[4 * q] ** 2 + vel[4 * q + 1] ** 2 + vel[4 * q + 2] ** 2) + p.mass[q] * G * pos[4 * q + 1]
  return e
}

/** φ-volume Σ min(f, 1)·dx³ over the window cells from the GPU's last density RHS (f̃ in LIQUID, raw f in AIR). */
async function phiVolume(gpu: FlipGpuSimulator): Promise<number> {
  const L = gpu.layout, pc = gpu.psiSolver!.paddedCount
  const fc = new Float32Array(await gpu.readBuffer(gpu.fCompBuf!, 4 * pc))
  let v = 0
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) v += Math.min(fc[lin(L, i, j, k)], 1)
  return v * L.dx ** 3
}

/** D0 on the GPU: one density correction of a 12-ppc and a 6-ppc free blob (g = 0). */
export async function direction(device: GPUDevice) {
  const run = async (ppc: number) => {
    const p = block([8, 8, 8], [15, 15, 15], mulberry32(ppc), ppc)
    const gpu = await makeSim(device, [24, 24, 24], { count: p.n, gravity: [0, 0, 0] })
    gpu.dt = 1 / 120
    gpu.setParticles(toInit(p))
    await submit(device, e => { gpu.writeParams(); gpu.encodeDensityCorrection(e) })
    const r = await gpu.readParticles()
    let cx = 0, cy = 0, cz = 0
    for (let q = 0; q < p.n; q++) { cx += p.pos[3 * q]; cy += p.pos[3 * q + 1]; cz += p.pos[3 * q + 2] }
    cx /= p.n; cy /= p.n; cz /= p.n
    let a0 = 0, a1 = 0, i0 = 0, i1 = 0, ni = 0, dv = 0
    for (let q = 0; q < p.n; q++) {
      const r0 = (p.pos[3 * q] - cx) ** 2 + (p.pos[3 * q + 1] - cy) ** 2 + (p.pos[3 * q + 2] - cz) ** 2
      const r1 = (r.pos[4 * q] - cx) ** 2 + (r.pos[4 * q + 1] - cy) ** 2 + (r.pos[4 * q + 2] - cz) ** 2
      a0 += r0; a1 += r1
      if ([0, 1, 2].every(a => { const x = p.pos[3 * q + a] / DX; return x >= 10 && x < 14 })) { i0 += r0; i1 += r1; ni++ }
      for (let a = 0; a < 3; a++) dv = Math.max(dv, Math.abs(r.vel[4 * q + a] - p.vel[3 * q + a]))
    }
    gpu.destroy()
    return { all: a1 / a0 - 1, inner: i1 / i0 - 1, dv, interior: ni }
  }
  return { hi: await run(12), lo: await run(6) }
}

/** C4 + WALL on the GPU: 16×20×16 pool 12 cells deep, 3 s. */
export async function restVolume(device: GPUDevice) {
  const p = block([0, 0, 0], [15, 11, 15], mulberry32(5))
  const gpu = await makeSim(device, [16, 20, 16], { count: p.n })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const com = (pos: Float32Array) => { let x = 0, z = 0; for (let q = 0; q < p.n; q++) { x += pos[4 * q]; z += pos[4 * q + 2] } return [x / p.n, z / p.n] }
  const c0 = com((await gpu.readParticles()).pos)
  for (let s = 0; s < 360; s++) await submit(device, e => gpu.step(e, 1))
  await submit(device, e => { gpu.writeParams(); gpu.encodeLabels(e); gpu.encodeCellScatter(e); gpu.encodeDensityRhs(e) })
  const vPhi = await phiVolume(gpu), vNp = p.n * DX ** 3 / 8
  const L = gpu.layout, pc = gpu.psiSolver!.paddedCount
  const fc = new Float32Array(await gpu.readBuffer(gpu.fCompBuf!, 4 * pc)), { labels } = await gpu.readPressure()
  let worst = 0, n = 0
  for (let k = 0; k < 16; k++) for (let j = 0; j < 20; j++) for (let i = 0; i < 16; i++) {
    const li = lin(L, i, j, k)
    if (labels[li] !== 1) continue
    const walls = (i === 0 || i === 15 ? 1 : 0) + (j === 0 ? 1 : 0) + (k === 0 || k === 15 ? 1 : 0)
    if (walls === 0) continue
    let air = false
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (labels[lin(L, i + di, j + dj, k + dk)] === 0) air = true
    if (air) continue
    worst = Math.max(worst, Math.abs(fc[li] - 1)); n++
  }
  const c1 = com((await gpu.readParticles()).pos), d = await gpu.readDiagnostics()
  gpu.destroy()
  return { vPhi, vNp, worst, wallCells: n, drift: Math.max(Math.abs(c1[0] - c0[0]), Math.abs(c1[1] - c0[1])) / DX, densityClamps: d.densityClamps, psiCapHits: d.psiCapHits, psiSolves: d.psiSolves, capHits: d.capHits }
}

/** A1 (+ INV′) on the GPU: Martin & Moyce n² = 2 column, `aCells` across, physical width aPhys. */
export async function martinMoyce(device: GPUDevice, o: { aCells: number; aPhys?: number }) {
  const aCells = o.aCells, aPhys = o.aPhys ?? aCells * DX, h = aPhys / aCells
  const p = block([0, 0, 0], [aCells - 1, 2 * aCells - 1, 7], mulberry32(aCells), 8, h)
  const gpu = await makeSim(device, [Math.max(128, 10 * aCells), 2 * aCells + 8, 8], { count: p.n, h, tol: 1e-5, psiTol: 1e-4, cap: 2000, psiCap: 2000 })
  const dt = (1 / 240) * (h / DX)
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  const tUnit = Math.sqrt(aPhys / G), tEnd = 5.25 * tUnit
  const r0 = await gpu.readParticles()
  const E0 = energy(p, r0.pos, r0.vel)
  let corr = 0
  const ts: number[] = [], Z: number[] = [], H: number[] = [], inv: number[] = []
  let prev = r0.pos
  for (let s = 1; s * dt <= tEnd + 1e-9; s++) {
    await submit(device, e => { gpu.writeParams(); gpu.encodeDensityCorrection(e) })
    const mid = await gpu.readParticles()
    for (let q = 0; q < p.n; q++) corr += p.mass[q] * G * (mid.pos[4 * q + 1] - prev[4 * q + 1])
    await submit(device, e => { gpu.encodeSubstepBody(e) })
    const r = await gpu.readParticles()
    prev = r.pos
    const xs: number[] = []
    let hMax = 0
    for (let q = 0; q < p.n; q++) { xs.push(r.pos[4 * q]); if (r.pos[4 * q] < h) hMax = Math.max(hMax, r.pos[4 * q + 1]) }
    xs.sort((u, v) => u - v)
    ts.push(s * dt); Z.push(xs[Math.floor(0.995 * (xs.length - 1))] / aPhys); H.push(hMax / (2 * aPhys))
    inv.push(energy(p, r.pos, r.vel) - corr)
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { aCells, aPhys, particles: p.n, ts, Z, H, E0, inv, tUnit, densityClamps: d.densityClamps, wallClamps: d.wallClamps, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** G2 on the GPU: double dam break in a 64×64×8 slab, 30 s, with or without the density projection. */
export async function doubleDamBreak(device: GPUDevice, o: { density: boolean; seconds?: number }) {
  const seconds = o.seconds ?? 30
  const p = merge(block([0, 0, 0], [15, 31, 7], mulberry32(21)), block([48, 0, 0], [63, 31, 7], mulberry32(22)))
  // φ-volume needs the density buffers, so the baseline keeps them allocated but never encodes the correction
  const gpu = await makeSim(device, [64, 64, 8], { count: p.n, tol: 1e-2, psiTol: 1e-3 })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const measure = async () => { await submit(device, e => { gpu.writeParams(); gpu.encodeLabels(e); gpu.encodeCellScatter(e); gpu.encodeDensityRhs(e) }); return phiVolume(gpu) }
  const v0 = await measure()
  const series: number[] = []
  for (let s = 1; s <= seconds * 120; s++) {
    await submit(device, e => {
      gpu.writeParams()
      if (o.density) gpu.encodeDensityCorrection(e)
      gpu.encodeSubstepBody(e)
    })
    if (s % 120 === 0) series.push(await measure() / v0 - 1)
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  const vNp = p.n * DX ** 3 / 8
  return { density: o.density, particles: p.n, series, end: series.at(-1)!, v0OverNVp: v0 / vNp, endOverNVp: (1 + series.at(-1)!) * v0 / vNp, capHits: d.capHits, solves: d.solves, psiCapHits: d.psiCapHits, psiSolves: d.psiSolves, breakdowns: d.breakdowns + d.psiBreakdowns }
}
