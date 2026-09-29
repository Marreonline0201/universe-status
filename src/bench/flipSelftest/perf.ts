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
