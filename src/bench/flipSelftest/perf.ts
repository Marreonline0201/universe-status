/// <reference types="@webgpu/types" />
// Solver cost at the page's production settings (hardware budget, recorded — FINAL-PLAN S3.3 FPS gate context): how
// much of a pressure / ψ solve is iterations the solve did not need. Every solve is encoded at a FIXED cap with direct
// dispatches; once converged, each remaining kernel returns at entry (PoissonSolver header) — this measures what those
// returns cost. Wall time per submitted-and-completed solve; every non-empty submit carries the same ~3 ms round-trip
// floor (viscCost), so compare rows, not absolute values.
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { makeParticles } from '../../sim-ref/flipRef'
import { DX, L_REF, TAU, f32round, toInit, submit, solverConfig, mulberry32 } from './util'

export async function solveCost(device: GPUDevice, o: { pCaps?: number[]; psiCaps?: number[]; reps?: number } = {}) {
  const reps = o.reps ?? 20, rng = mulberry32(11)
  // an 88k-particle water block at rest packing in the page's 64³ tank (the viscCost block, as water)
  const pts: number[][] = []
  for (let k = 18; k <= 45; k++) for (let j = 0; j <= 13; j++) for (let i = 18; i <= 45; i++)
    for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX])
  const p = makeParticles(pts.length)
  const m = Math.fround(998.2 * DX ** 3 / 8)
  pts.forEach((x, q) => { p.pos.set(x.map(Math.fround), 3 * q); p.mass[q] = m })
  f32round(p)
  const gpu = await FlipGpuSimulator.create(device, {
    nx: 64, ny: 64, nz: 64, dx: DX, gravity: [0, -9.80665, 0], maxParticles: p.n, lRef: L_REF, tauS: TAU,
    projection: true, density: 998.2, densityProjection: true, freeSurface: 'ghost', solverMethod: solverConfig.method, variableDensity: true, ppc: 8,
  })
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const time = async (f: (e: GPUCommandEncoder) => void) => { await submit(device, f); const t0 = performance.now(); for (let r = 0; r < reps; r++) await submit(device, f); return (performance.now() - t0) / reps }
  for (let s = 0; s < 30; s++) await submit(device, e => gpu.step(e, 1))   // let it start falling/settling
  const step = await time(e => gpu.step(e, 1))
  const ps = gpu.solver!, psi = gpu.psiSolver!
  const pStats = await ps.readStats(), psiStats = await psi.readStats()
  const pressure: Record<number, number> = {}, psiMs: Record<number, number> = {}
  for (const cap of o.pCaps ?? [18, 12, 8, 4]) {
    const cfg = ps.createSolveConfig({ criterion: 'inf', tol: gpu.pressureTolerance, cap })
    pressure[cap] = await time(e => { ps.encodePrepare(e); ps.encodeSolve(e, cfg, { warmStart: true }) })
  }
  for (const cap of o.psiCaps ?? [10, 6, 3]) {
    const cfg = psi.createSolveConfig({ criterion: 'inf', tol: gpu.psiTolerance, cap })
    psiMs[cap] = await time(e => { psi.encodePrepare(e); psi.encodeSolve(e, cfg, { warmStart: false }) })
  }
  const empty = await time(() => {})
  gpu.destroy()
  return {
    particles: p.n, stepMs: step, emptySubmitMs: empty,
    pressure: { iterations: pStats.iterations, converged: pStats.converged, cap: gpu.pressureCap, msByCap: pressure, perIteration: ps.dispatches.perIteration },
    psi: { iterations: psiStats.iterations, converged: psiStats.converged, cap: gpu.psiCap, msByCap: psiMs, perIteration: psi.dispatches.perIteration },
  }
}

/** GPU time of every compute pass of one production substep, summed by pass label (timestamp queries; the self-test
 *  device enables 'timestamp-query' when the adapter has it). The encoder handed to the simulator is wrapped so each
 *  beginComputePass records its begin/end times. `viscous`: an 88k honey block with the viscous path on (else water). */
export async function profileStep(device: GPUDevice, o: { viscous?: boolean } = {}) {
  if (!device.features.has('timestamp-query')) return { error: 'timestamp-query not available on this adapter' }
  const { viscCostSim } = await import('./visc')
  const gpu = await viscCostSim(device, !!o.viscous)
  for (let s = 0; s < 20; s++) await submit(device, e => gpu.step(e, 1))
  const MAX = 1024   // passes profiled (2 queries each; a query set holds at most 4096)
  const qs = device.createQuerySet({ type: 'timestamp', count: 2 * MAX })
  const resolve = device.createBuffer({ size: 16 * MAX, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
  const read = device.createBuffer({ size: 16 * MAX, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const labels: string[] = []
  const e = device.createCommandEncoder()
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
  let total = 0
  for (let i = 0; i < n; i++) {
    const us = Number(t[2 * i + 1] - t[2 * i]) / 1000
    const k = labels[i]
    byLabel[k] = byLabel[k] ?? { us: 0, passes: 0 }
    byLabel[k].us += us; byLabel[k].passes++; total += us
  }
  const span = Number(t[2 * n - 1] - t[0]) / 1000
  const top = Object.entries(byLabel).sort((a, b) => b[1].us - a[1].us).slice(0, 25).map(([k, v]) => ({ pass: k, us: Math.round(v.us), passes: v.passes }))
  qs.destroy(); resolve.destroy(); read.destroy(); gpu.destroy()
  return { viscous: !!o.viscous, passes: n, sumOfPassesUs: Math.round(total), firstToLastUs: Math.round(span), top }
}
