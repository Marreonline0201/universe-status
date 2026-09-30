/// <reference types="@webgpu/types" />
// PERF-1 L0 on the GPU (flip-selftest.html): FlipGpuSimulator.step(encoder, n) of every flag combination the solver has
// — transfers only, voxel, voxel + variable density, ghost + density, the split viscous path, the weak and the
// monolithic ball (with and without the split viscous path), the Stokes path, the drift in both forms, an empty tank,
// three extrapolation layers, JPCG — at 64³, 48³ and 24×16×12, n = 1…4, encoded through a counting wrapper and NEVER
// submitted, against dispatchBudget.frameDispatches(sim.budgetState(n)) per pass label, tolerance 0 (vault
// fluid/realism-2026-09 PERF-1 spec L0). Metrics only — scripts/fluid-gates/perf1-gpu.mjs applies the rule.
import type { Vec3 } from '../../sim-ref/gridLayout'
import { FlipGpuSimulator, type FlipSimOptions, type FlipParticleInit } from '../../gpu-sim/flip/FlipGpuSimulator'
import { frameDispatches, budgetMismatch } from '../../gpu-sim/flip/dispatchBudget'
import { DX, L_REF, TAU } from './util'
import { LIQUIDS, waterDensity } from '../../composition/materialData'
import { INCOMPRESSIBLE_NU_NUM } from '../../composition/liquidGate'

const G = 9.80665
const WATER = { rho: waterDensity(20), mu: LIQUIDS.water.viscosity(20) }
const OIL = { rho: LIQUIDS['olive-oil'].density(20), mu: LIQUIDS['olive-oil'].viscosity(20) }

/** An encoder whose compute passes count their dispatches per pass label (nothing else is intercepted). */
function counting(e: GPUCommandEncoder, counts: Map<string, number>): GPUCommandEncoder {
  return new Proxy(e, {
    get(t, p) {
      if (p === 'beginComputePass') return (d: GPUComputePassDescriptor = {}) => {
        const pass = t.beginComputePass(d), label = d.label ?? '?'
        return new Proxy(pass, {
          get(pt, pp) {
            const v = (pt as unknown as Record<string | symbol, unknown>)[pp]
            if (typeof v !== 'function') return v
            if (pp === 'dispatchWorkgroups' || pp === 'dispatchWorkgroupsIndirect') return (...a: unknown[]) => { counts.set(label, (counts.get(label) ?? 0) + 1); return (v as (...x: unknown[]) => unknown).apply(pt, a) }
            return (v as (...x: unknown[]) => unknown).bind(pt)
          },
        })
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[p]
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
    },
  })
}

interface Combo { name: string; opts: Partial<FlipSimOptions>; particles?: boolean; setup?: (g: FlipGpuSimulator) => void }
const viscous = (g: FlipGpuSimulator, cap: number) => { g.viscositySolver!.setMuTable(new Float32Array([OIL.mu, OIL.mu])); g.viscositySolver!.muDefault = OIL.mu; g.viscositySolver!.cap = cap; g.viscosityActive = true }
const ball = (g: FlipGpuSimulator, coupling: 'weak' | 'monolithic') => {
  const n = g.layout, c: Vec3 = [0.5 * n.nx * DX, 0.5 * n.ny * DX, 0.5 * n.nz * DX]
  g.setSphere({ center: c, radius: 1.5 * DX, velocity: [0, 0, 0], density: coupling === 'monolithic' ? 7874 : 0, coupling })
}
const drift = (g: FlipGpuSimulator, form: 'face' | 'cell') => {
  g.immiscibleSolver!.configure({ materials: [{ compositions: [0], ...WATER }, { compositions: [1], ...OIL }], sigma: (a, b) => (a !== b ? 0.0245 : null), dropDiameter: 1e-3, nuNum: INCOMPRESSIBLE_NU_NUM })
  g.immiscibleSolver!.driftForm = form
  g.immiscibleActive = true
}
const GHOST: Partial<FlipSimOptions> = { projection: true, freeSurface: 'ghost', densityProjection: true, variableDensity: true }
const COMBOS: Combo[] = [
  { name: 'transfers only', opts: { projection: false } },
  { name: 'voxel', opts: { projection: true, freeSurface: 'voxel' } },
  { name: 'voxel + variable density', opts: { projection: true, freeSurface: 'voxel', variableDensity: true } },
  { name: 'ghost + density', opts: GHOST },
  { name: 'ghost + density, empty tank', opts: GHOST, particles: false },
  { name: 'ghost + density, 3 extrapolation layers', opts: { ...GHOST, extrapolationLayers: 3 } },
  { name: 'ghost + density, JPCG', opts: { ...GHOST, solverMethod: 'jpcg' } },
  { name: 'split viscous path', opts: { ...GHOST, viscosity: true }, setup: g => viscous(g, 16) },
  { name: 'weak ball', opts: GHOST, setup: g => ball(g, 'weak') },
  { name: 'monolithic ball', opts: GHOST, setup: g => ball(g, 'monolithic') },
  { name: 'monolithic ball + split viscous path', opts: { ...GHOST, viscosity: true }, setup: g => { viscous(g, 12); ball(g, 'monolithic'); g.viscosityScheme = 'split' } },
  { name: 'Stokes (monolithic ball, auto)', opts: { ...GHOST, viscosity: true }, setup: g => { viscous(g, 12); ball(g, 'monolithic'); g.viscosityScheme = 'auto'; g.stokesSolver!.cap = 30 } },
  { name: 'drift, face form', opts: { ...GHOST, immiscible: true }, setup: g => drift(g, 'face') },
  { name: 'drift, cell form', opts: { ...GHOST, immiscible: true }, setup: g => drift(g, 'cell') },
  { name: 'drift, face form + split viscous path', opts: { ...GHOST, immiscible: true, viscosity: true }, setup: g => { viscous(g, 16); drift(g, 'face') } },
]

/** A 2-particle-per-axis block over a quarter of the floor (materials 0 and 1 alternating by cell), f32 positions. */
function block(nx: number, ny: number, nz: number): FlipParticleInit[] {
  const out: FlipParticleInit[] = [], X = Math.min(8, nx), Y = Math.min(4, ny), Z = Math.min(8, nz)
  for (let k = 0; k < Z; k++) for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) for (let s = 0; s < 8; s++) {
    const m = (i + j + k) % 2
    out.push({ pos: [(i + 0.25 + 0.5 * (s & 1)) * DX, (j + 0.25 + 0.5 * ((s >> 1) & 1)) * DX, (k + 0.25 + 0.5 * ((s >> 2) & 1)) * DX].map(Math.fround) as Vec3,
      vel: [0, 0, 0], mass: (m ? OIL.rho : WATER.rho) * DX ** 3 / 8, composition: m, phase: 1, temperatureC: 20 })
  }
  return out
}

export async function budgetKernels(device: GPUDevice, o: { shapes?: [number, number, number][]; substeps?: number[] } = {}) {
  const shapes = o.shapes ?? [[64, 64, 64], [48, 48, 48], [24, 16, 12]], subs = o.substeps ?? [1, 2, 3, 4]
  const rows: { combo: string; shape: string; frames: number; mismatches: { n: number; label: string; counted: number; budget: number }[]; totals: number[] }[] = []
  for (const [nx, ny, nz] of shapes) for (const c of COMBOS) {
    const parts = c.particles === false ? [] : block(nx, ny, nz)
    const gpu = await FlipGpuSimulator.create(device, {
      nx, ny, nz, dx: DX, gravity: [0, -G, 0], maxParticles: Math.max(1, parts.length), lRef: L_REF, tauS: TAU,
      density: WATER.rho, solverMethod: 'mgpcg', ...c.opts,
    } as FlipSimOptions)
    try {
      gpu.dt = 1 / 120
      gpu.setParticles(parts)
      c.setup?.(gpu)
      const row = { combo: c.name, shape: `${nx}×${ny}×${nz}`, frames: 0, mismatches: [] as { n: number; label: string; counted: number; budget: number }[], totals: [] as number[] }
      for (const n of subs) {
        const counts = new Map<string, number>()
        gpu.step(counting(device.createCommandEncoder(), counts), n)   // encoded, never submitted
        const budget = frameDispatches(gpu.budgetState(n))
        for (const x of budgetMismatch(counts, budget)) row.mismatches.push({ n, ...x })
        row.totals.push([...counts.values()].reduce((q, v) => q + v, 0))
        row.frames++
      }
      rows.push(row)
    } finally { gpu.destroy() }
  }
  return { combos: COMBOS.length, shapes: shapes.length, frames: rows.reduce((q, r) => q + r.frames, 0), mismatchedFrames: rows.reduce((q, r) => q + new Set(r.mismatches.map(m => m.n)).size, 0), rows }
}
