/// <reference types="@webgpu/types" />
// OBS-1 T1-report (vault fluid/realism-2026-09/EXTENDED-ROADMAP.md §5.3 1a; research/x3-turbulence-damping.md §6):
// the Taylor–Green bulk damping of the PRODUCTION solver with ZERO physical viscosity — every bit of decay is numerical.
// A closed, fully liquid slab (64 × 64 × 8 cells, g = 0, water), the 2-D mode u = U sin kx cos ky, v = −U cos kx sin ky,
// w = 0 (k = 2π/λ). λ divides 128 cells, so u = 0 on the x walls and v = 0 on the y walls and the shear stress vanishes on
// all four: the pressure solve's u·n = 0 walls are exact for this flow. The particles carry the mode's APIC affine
// matrix. A(t) = the particle velocities' least-squares projection on the mode; ν_num = −slope(ln A)/(2k²) (x3 §6).
// Solver settings are the page's (FlipBackend.makeSim / FlipGpuSimulator defaults: ghost surface — no air here —,
// variable density, density projection, the default tolerances and caps); the viscous and drift paths stay off (water).
import { makeParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, RHO, L_REF, TAU, mulberry32, f32round, toInit, submit } from './util'

export async function taylorGreen(device: GPUDevice, o: { lambdaCells: number; U: number; dt: number; seconds?: number; samples?: number; cells?: [number, number, number]; densityProjection?: boolean; freeSurface?: 'ghost' | 'voxel' }) {
  const [nx, ny, nz] = o.cells ?? [64, 64, 8], h = DX, k = 2 * Math.PI / (o.lambdaCells * h)
  if (!((2 * nx) % o.lambdaCells === 0 && (2 * ny) % o.lambdaCells === 0)) throw new Error(`taylorGreen: λ = ${o.lambdaCells} cells must divide 2·n (the walls on the mode's zero-stress lines)`)
  const rng = mulberry32(900 + o.lambdaCells)
  const n = nx * ny * nz * 8, p = makeParticles(n), m = RHO * h ** 3 / 8
  let q = 0
  for (let kk = 0; kk < nz; kk++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (let s = 0; s < 8; s++, q++) {
    const x = (i + ((s & 1) + rng()) / 2) * h, y = (j + (((s >> 1) & 1) + rng()) / 2) * h, z = (kk + (((s >> 2) & 1) + rng()) / 2) * h
    p.pos.set([x, y, z], 3 * q); p.mass[q] = m
    const sx = Math.sin(k * x), cx = Math.cos(k * x), sy = Math.sin(k * y), cy = Math.cos(k * y)
    p.vel.set([o.U * sx * cy, -o.U * cx * sy, 0], 3 * q)
    p.c[0].set([o.U * k * cx * cy, -o.U * k * sx * sy, 0], 3 * q)   // ∇u
    p.c[1].set([o.U * k * sx * sy, -o.U * k * cx * cy, 0], 3 * q)   // ∇v
  }
  f32round(p)
  const gpu = await FlipGpuSimulator.create(device, {
    nx, ny, nz, dx: h, gravity: [0, 0, 0], maxParticles: n, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, densityProjection: o.densityProjection ?? true, freeSurface: o.freeSurface ?? 'ghost', variableDensity: true, ppc: 8,
  })
  gpu.dt = o.dt
  gpu.setParticles(toInit(p))
  const amp = (r: { pos: Float32Array; vel: Float32Array }) => {
    let num = 0, den = 0
    for (let i = 0; i < n; i++) {
      const x = r.pos[4 * i], y = r.pos[4 * i + 1], su = Math.sin(k * x) * Math.cos(k * y), sv = -Math.cos(k * x) * Math.sin(k * y)
      num += r.vel[4 * i] * su + r.vel[4 * i + 1] * sv; den += su * su + sv * sv
    }
    return num / den
  }
  const T = o.seconds ?? 2, steps = Math.round(T / o.dt), every = Math.max(1, Math.round(steps / (o.samples ?? 12)))
  const ts = [0], As = [amp(await gpu.readParticles())]
  for (let s = 1; s <= steps; s++) {
    await submit(device, e => gpu.step(e, 1))
    if (s % every === 0 || s === steps) { ts.push(s * o.dt); As.push(amp(await gpu.readParticles())) }
  }
  // least squares on ln A over the samples after the first step (the first transfer's projection is excluded: A(0)
  // is the particles' own field, not the grid's)
  const pts = ts.map((t, i) => [t, Math.log(As[i])]).filter(([t, l]) => t > 0 && Number.isFinite(l))
  const tm = pts.reduce((s, [t]) => s + t, 0) / pts.length, lm = pts.reduce((s, [, l]) => s + l, 0) / pts.length
  let sxy = 0, sxx = 0
  for (const [t, l] of pts) { sxy += (t - tm) * (l - lm); sxx += (t - tm) ** 2 }
  const slope = sxy / sxx
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return {
    lambdaCells: o.lambdaCells, U: o.U, dt: o.dt, particles: n, k, ts, As, nuNum: -slope / (2 * k * k),
    // the simple two-point value too (x3's formula at the end of the run)
    nuEnd: -Math.log(As.at(-1)! / As[0]) / (2 * k * k * ts.at(-1)!),
    capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns,
  }
}
