/// <reference types="@webgpu/types" />
// S3.3 on the GPU (flip-selftest.html): MGPCG replaces JPCG. Metrics only — scripts/fluid-gates/s33-gpu.mjs applies
// the tolerances. Every run here names its solver explicitly (it does not use the page-wide solverConfig).
import type { Vec3 } from '../../sim-ref/gridLayout'
import { makeParticles, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, RHO, L_REF, TAU, mulberry32, blob, toInit, submit } from './util'

const G = 9.80665
const lin = (n: Vec3, i: number, j: number, k: number) => (i + 1) + (n[0] + 2) * ((j + 1) + (n[1] + 2) * (k + 1))

async function sim(device: GPUDevice, n: Vec3, p: RefParticles, method: 'jpcg' | 'mgpcg', o: { cap: number; psiCap: number; tol?: number }) {
  const s = await FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -G, 0], maxParticles: p.n, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, pressureTolerance: o.tol ?? 1e-2, pressureCap: o.cap, solverMethod: method,
    densityProjection: true, psiTolerance: 1e-3, psiCap: o.psiCap,
  })
  s.dt = 1 / 120
  s.setParticles(toInit(p))
  return s
}

/** Same dam-break slab on JPCG and MGPCG: pressures after one substep, and centres of mass after 2 s. */
export async function equivalence(device: GPUDevice) {
  const n: Vec3 = [128, 24, 4]
  const p = blob([0, 0, 0], [7, 7, 3], mulberry32(4))
  const J = await sim(device, n, p, 'jpcg', { cap: 400, psiCap: 400 }), M = await sim(device, n, p, 'mgpcg', { cap: 100, psiCap: 100 })
  await submit(device, e => J.step(e, 1)); await submit(device, e => M.step(e, 1))
  const pj = (await J.readPressure()), pm = (await M.readPressure())
  let dp = 0, pMax = 0, liquid = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const li = lin(n, i, j, k)
    if (pj.labels[li] !== 1) continue
    liquid++
    dp = Math.max(dp, Math.abs(pj.pressure[li] - pm.pressure[li])); pMax = Math.max(pMax, Math.abs(pj.pressure[li]))
  }
  const com = (pos: Float32Array) => { const c = [0, 0, 0]; for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) c[a] += pos[4 * q + a]; return c.map(v => v / p.n) }
  for (let s = 1; s < 240; s++) { await submit(device, e => J.step(e, 1)); await submit(device, e => M.step(e, 1)) }
  const cj = com((await J.readParticles()).pos), cm = com((await M.readParticles()).pos)
  const dj = await J.readDiagnostics(), dm = await M.readDiagnostics()
  J.destroy(); M.destroy()
  return { liquid, dp, pMax, dCom: Math.hypot(cj[0] - cm[0], cj[1] - cm[1], cj[2] - cm[2]), dx: DX,
    jpcg: { maxIt: dj.maxIterations, psiMaxIt: dj.psiMaxIterations, capHits: dj.capHits + dj.psiCapHits, breakdowns: dj.breakdowns + dj.psiBreakdowns },
    mgpcg: { maxIt: dm.maxIterations, psiMaxIt: dm.psiMaxIterations, capHits: dm.capHits + dm.psiCapHits, breakdowns: dm.breakdowns + dm.psiBreakdowns } }
}

/** The 64³ tank (3.63 m) on MGPCG at the Gate 0 caps: a dam break of a 16×32×64-cell column, 2 s. */
export async function tankCaps(device: GPUDevice, o: { cap: number; psiCap: number; seconds?: number }) {
  const n: Vec3 = [64, 64, 64]
  const src = blob([0, 0, 0], [15, 31, 63], mulberry32(7))
  const p = makeParticles(src.n)
  p.pos.set(src.pos); p.mass.set(src.mass)
  const M = await sim(device, n, p, 'mgpcg', o)
  const steps = Math.round((o.seconds ?? 2) * 120)
  const t0 = performance.now()
  for (let s = 0; s < steps; s++) await submit(device, e => M.step(e, 1))
  const wall = (performance.now() - t0) / steps
  const d = await M.readDiagnostics()
  M.destroy()
  return { particles: p.n, steps, solves: d.solves, capHits: d.capHits, maxIt: d.maxIterations, psiSolves: d.psiSolves, psiCapHits: d.psiCapHits, psiMaxIt: d.psiMaxIterations,
    breakdowns: d.breakdowns + d.psiBreakdowns, msPerStep: wall }
}
