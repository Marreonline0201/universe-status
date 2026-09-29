/// <reference types="@webgpu/types" />
// Tank resize (owner request 2026-09-29; spec vault fluid/realism-2026-09/TANK-RESIZE-spec.md): the budget before the
// build — per tank size, the GPU buffer bytes a production FlipGpuSimulator allocates (every createBuffer during
// create() summed), the time create() takes (a resize rebuilds it), the multigrid's level count and coarsest grid, and
// the pressure / ψ solves on a settling pool (iterations, cap hits at the page's caps).
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { buildLevels } from '../../gpu-sim/flip/poisson/PoissonSolver'
import { makeParticles } from '../../sim-ref/flipRef'
import { DX, L_REF, TAU, toInit, submit, mulberry32, f32round } from './util'

export async function tankBudget(device0: GPUDevice, o: { dims?: [number, number, number][]; steps?: number; depthCells?: number; raised?: boolean } = {}) {
  // raised: a device with the adapter's own buffer limits (the default 128 MiB storage binding cannot hold 88³'s lattice)
  let device = device0
  if (o.raised) {
    const adapter = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))!
    device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] as GPUFeatureName[], requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension } })
  }
  const out: Record<string, unknown>[] = []
  for (const n of o.dims ?? [[64, 64, 64], [88, 88, 88], [48, 40, 72]]) {
    const cells = n[0] * n[1] * n[2]
    const maxParticles = Math.round(200_000 * cells / 64 ** 3)
    let bytes = 0, buffers = 0
    const orig = device.createBuffer.bind(device)
    ;(device as unknown as { createBuffer: (d: GPUBufferDescriptor) => GPUBuffer }).createBuffer = (d: GPUBufferDescriptor) => { bytes += d.size; buffers++; return orig(d) }
    const t0 = performance.now()
    let gpu: FlipGpuSimulator
    try {
      gpu = await FlipGpuSimulator.create(device, {
        nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -9.80665, 0], maxParticles, lRef: L_REF, tauS: TAU,
        projection: true, density: 998.2, densityProjection: true, freeSurface: 'ghost', variableDensity: true, ppc: 8, viscosity: true, immiscible: true,
      })
    } finally {
      ;(device as unknown as { createBuffer: (d: GPUBufferDescriptor) => GPUBuffer }).createBuffer = orig
    }
    const createMs = performance.now() - t0
    const levels = buildLevels(n[0], n[1], n[2], 'mgpcg')
    // a pool over the whole floor, depthCells deep, jittered 8 ppc
    const depth = o.depthCells ?? 4, rng = mulberry32(3)
    const pts: number[] = []
    for (let k = 0; k < 2 * n[2]; k++) for (let j = 0; j < 2 * depth; j++) for (let i = 0; i < 2 * n[0]; i++) pts.push((i + 0.5 + 0.5 * (rng() - 0.5)) * DX / 2, (j + 0.5 + 0.5 * (rng() - 0.5)) * DX / 2, (k + 0.5 + 0.5 * (rng() - 0.5)) * DX / 2)
    const count = Math.min(pts.length / 3, maxParticles)
    const p = makeParticles(count)
    const m = 998.2 * DX ** 3 / 8
    for (let q = 0; q < count; q++) { p.pos.set([pts[3 * q], pts[3 * q + 1], pts[3 * q + 2]], 3 * q); p.mass[q] = m }
    f32round(p)
    gpu.dt = 1 / 120
    gpu.setParticles(toInit(p))
    gpu.resetDiagnostics()
    const steps = o.steps ?? 60
    const t1 = performance.now()
    for (let s = 0; s < steps; s++) await submit(device, e => gpu.step(e, 1))
    const stepMs = (performance.now() - t1) / steps
    const d = await gpu.readDiagnostics()
    gpu.destroy()
    // a second create of the same size (the rebuild a resize does, shader cache warm)
    const t2 = performance.now()
    const again = await FlipGpuSimulator.create(device, {
      nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -9.80665, 0], maxParticles, lRef: L_REF, tauS: TAU,
      projection: true, density: 998.2, densityProjection: true, freeSurface: 'ghost', variableDensity: true, ppc: 8, viscosity: true, immiscible: true,
    })
    const recreateMs = performance.now() - t2
    again.destroy()
    out.push({ dims: n, cells, maxParticles, particles: count, bufferMB: +(bytes / 2 ** 20).toFixed(1), buffers, createMs: Math.round(createMs), recreateMs: Math.round(recreateMs),
      mgLevels: levels.length, coarsest: [levels.at(-1)!.nx, levels.at(-1)!.ny, levels.at(-1)!.nz], stepMs: +stepMs.toFixed(2), diagnostics: d })
  }
  return out
}
