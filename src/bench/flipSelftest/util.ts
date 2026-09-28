/// <reference types="@webgpu/types" />
// Shared helpers of the APIC-MAC self-test page (flip-selftest.html).
import type { Vec3 } from '../../sim-ref/gridLayout'
import { makeParticles, type RefParticles } from '../../sim-ref/flipRef'
import type { FlipParticleInit } from '../../gpu-sim/flip/FlipGpuSimulator'

export const DX = 3.63 / 64
export const RHO = 998.2072          // kg/m³, water 20 °C (NIST)
export const L_REF = 3.63, TAU = 1 / 24

/** Pressure/ψ solver used by every projection test on this page (set via __flipTest.configure). MGPCG converges in
 *  tens of iterations, so its encoded cap is bounded (encoding thousands of V-cycles per solve is pure CPU cost). */
export const solverConfig: { method: 'jpcg' | 'mgpcg' } = { method: 'jpcg' }
export const capFor = (cap: number) => (solverConfig.method === 'mgpcg' ? Math.min(cap, 100) : cap)

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** 8 ppc jittered in their 2×2×2 sub-cells over cells lo..hi (inclusive). Values are rounded to f32 so the CPU
 *  reference and the GPU start from bit-identical inputs. */
export function blob(lo: Vec3, hi: Vec3, rng: () => number): RefParticles {
  const pts: number[][] = []
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
    for (let s = 0; s < 8; s++) {
      pts.push([(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX])
    }
  const p = makeParticles(pts.length)
  const m = Math.fround(RHO * DX ** 3 / 8)
  pts.forEach((x, q) => { p.pos.set(x.map(Math.fround), 3 * q); p.mass[q] = m })
  return p
}

export function f32round(p: RefParticles) {
  for (const arr of [p.pos, p.vel, ...p.c]) for (let i = 0; i < arr.length; i++) arr[i] = Math.fround(arr[i])
}

export function toInit(p: RefParticles): FlipParticleInit[] {
  const out: FlipParticleInit[] = []
  for (let q = 0; q < p.n; q++) {
    const v3 = (a: Float64Array): Vec3 => [a[3 * q], a[3 * q + 1], a[3 * q + 2]]
    out.push({ pos: v3(p.pos), vel: v3(p.vel), c: [v3(p.c[0]), v3(p.c[1]), v3(p.c[2])], mass: p.mass[q], composition: 0, phase: 1, temperatureC: 20 })
  }
  return out
}

export async function submit(device: GPUDevice, f: (e: GPUCommandEncoder) => void) {
  const e = device.createCommandEncoder()
  f(e)
  device.queue.submit([e.finish()])
  await device.queue.onSubmittedWorkDone()
}

/** Largest |a − b| and the largest |b| over paired arrays (b = reference). */
export function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>, pick?: (i: number) => boolean) {
  let d = 0, ref = 0
  for (let i = 0; i < b.length; i++) {
    if (pick && !pick(i)) continue
    d = Math.max(d, Math.abs(a[i] - b[i])); ref = Math.max(ref, Math.abs(b[i]))
  }
  return { d, ref }
}
