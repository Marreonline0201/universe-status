/// <reference types="@webgpu/types" />
// flip-selftest.html entry — FINAL-PLAN S3.0/S3.1a: every APIC-MAC GPU kernel is diffed against the f64 CPU
// reference (src/sim-ref/flipRef.ts) on IDENTICAL inputs, then the S3.1a physics gates run on the GPU path.
// Driven by scripts/fluid-gates/s31a-gpu.mjs; by hand: `await __flipTest.run('kernels', { n: [16,16,16] })`.
// The device is requested with DEFAULT limits (8 storage buffers per stage, like the three.js device the app uses),
// so a kernel that only works with raised limits fails here.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef } from '../../sim-ref/flipRef'
import { DX, L_REF, TAU, mulberry32, blob, f32round, toInit, submit, maxDiff, solverConfig } from './util'
import { FlipGpuSimulator, MASS_SCALE, MOM_SCALE, LO_SCALE } from '../../gpu-sim/flip/FlipGpuSimulator'
import { projKernels, g1a, settle, damBreak } from './projection'
import { densKernels, direction, restVolume, martinMoyce, doubleDamBreak, violentColumn } from './density'
import { equivalence, tankCaps } from './mg'
import { ghostKernels, flatSurface, hydrostatic, standingWave, column } from './ghost'
import { varKernels, densityCancels, twoLayerHydrostatic, interfacialWave, rayleighTaylor, lockExchange, overturn, mixedCaps } from './varDensity'
import { sphereKernels, spherePhysics } from './sphere'
import { viscKernels, viscTaylorGreen, viscStandingWave, viscHuppert, viscCost } from './visc'
import { stokesImages, stokesK40, stokesPhysics, stokesCost, stokesProfile } from './stokes'
import { solveCost, profileStep } from './perf'
import { immKernels, immRest, immLayered, immCost, immB1 } from './immiscible'
import { s37Kernels, s37Physics } from './s37'

const log = document.getElementById('log') as HTMLPreElement
const say = (s: string) => { log.textContent += s + '\n'; console.log('[flip]', s) }

// ── kernel-by-kernel parity ─────────────────────────────────────────────────────────────────────────────────

interface KernelOpts { n?: Vec3; ring?: Vec3; seed?: number; apic?: boolean; dt?: number; precise?: boolean }

async function kernels(device: GPUDevice, o: KernelOpts) {
  const n = o.n ?? [16, 16, 16], ring = o.ring ?? [0, 0, 0], apic = o.apic ?? true, dt = o.dt ?? 1 / 120
  const rng = mulberry32(o.seed ?? 5)
  const layout = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const gravity: Vec3 = [0.7, -9.80665, 0.3]
  const cpu = new FlipRef(layout, { gravity, apic })
  // blob touching the x = 0 wall and the floor (exercises SOLID and GHOST faces), random linear field + noise
  const hi: Vec3 = [Math.min(n[0] - 2, 9), Math.min(n[1] - 2, 7), Math.min(n[2] - 3, 10)]
  const p = blob([0, 0, 2], hi, rng)
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) {
    p.vel[3 * q + a] = rng() * 2 - 1
    for (let b = 0; b < 3; b++) p.c[a][3 * q + b] = (rng() * 2 - 1) * 4
  }
  f32round(p)
  const precise = o.precise ?? true
  const gpu = new FlipGpuSimulator(device, { nx: n[0], ny: n[1], nz: n[2], dx: DX, ring, gravity, apic, preciseP2G: precise, maxParticles: p.n, lRef: L_REF, tauS: TAU })
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  const S = layout.size, mu = gpu.massUnit
  const out: Record<string, unknown> = { n, ring, apic, precise, particles: p.n }
  // decoded sums in quanta: hi + lo/LO_SCALE (two-word) or hi alone
  const dec = (hi: Int32Array, lo: Int32Array, i: number) => hi[i] + (precise ? lo[i] / LO_SCALE : 0)

  // K1 faceScatter
  cpu.p2g(p)
  await submit(device, e => gpu.encodeScatter(e))
  const g1 = await gpu.readGrid(0)
  const adds = [new Uint16Array(S), new Uint16Array(S), new Uint16Array(S)]
  for (let q = 0; q < p.n; q++) for (const a of [0, 1, 2] as const) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1], z = p.pos[3 * q + 2]
    const f = [x / DX - (a === 0 ? 0 : 0.5), y / DX - (a === 1 ? 0 : 0.5), z / DX - (a === 2 ? 0 : 0.5)]
    const b = f.map(Math.floor), t = f.map((v, i) => v - b[i])
    for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const w = (di ? t[0] : 1 - t[0]) * (dj ? t[1] : 1 - t[1]) * (dk ? t[2] : 1 - t[2])
      if (w !== 0) adds[a][layout.idx(b[0] + di, b[1] + dj, b[2] + dk)]++
    }
  }
  let massWorst = 0, momWorst = 0, massRef = 0, momRef = 0, maxAdds = 0
  for (const a of [0, 1, 2]) for (let s = 0; s < S; s++) {
    const gm = dec(g1.mass, g1.massLo, a * S + s) / MASS_SCALE, cm = cpu.mass[a][s] / mu
    const gp = dec(g1.mom, g1.momLo, a * S + s) / MOM_SCALE, cp = cpu.mom[a][s] / mu
    massRef = Math.max(massRef, Math.abs(cm)); momRef = Math.max(momRef, Math.abs(cp)); maxAdds = Math.max(maxAdds, adds[a][s])
    // excess over the quantisation bound, in quanta: single word (adds·½ + 1); two words (adds·½/LO_SCALE + 1)
    const qb = precise ? adds[a][s] / 2 / LO_SCALE + 1 : adds[a][s] / 2 + 1
    massWorst = Math.max(massWorst, Math.abs(gm - cm) * MASS_SCALE - qb)
    momWorst = Math.max(momWorst, Math.abs(gp - cp) * MOM_SCALE - qb)
  }
  // relative-error form for the report
  out.k1 = { massExcessQuanta: massWorst, momExcessQuanta: momWorst, massRef, momRef, maxAdds,
    massRelTolQuanta: 1e-5 * massRef * MASS_SCALE, momRelTolQuanta: 1e-5 * momRef * MOM_SCALE }

  // K2 gridUpdate — the reference runs on the GPU's own integer sums, so only the division/gravity are compared
  for (const a of [0, 1, 2]) for (let s = 0; s < S; s++) {
    cpu.mass[a][s] = dec(g1.mass, g1.massLo, a * S + s) / MASS_SCALE * mu
    cpu.mom[a][s] = dec(g1.mom, g1.momLo, a * S + s) / MOM_SCALE * mu
  }
  cpu.gridUpdate(dt); cpu.applySolidFaces()
  await submit(device, e => gpu.encodeGridUpdate(e))
  const g2 = await gpu.readGrid(0)
  const cu = new Float64Array(3 * S), cv = new Uint32Array(3 * S)
  for (const a of [0, 1, 2]) { cu.set(cpu.u[a], a * S); for (let s = 0; s < S; s++) cv[a * S + s] = cpu.valid[a][s] }
  const inRange = (i: number) => { const a = Math.floor(i / S) as 0 | 1 | 2; return rangeMask(layout, a)[i % S] === 1 }
  const u2 = maxDiff(g2.u, cu, inRange)
  let validMismatch2 = 0
  for (let i = 0; i < 3 * S; i++) if (inRange(i) && g2.valid[i] !== cv[i]) validMismatch2++
  out.k2 = { uDiff: u2.d, uRef: u2.ref, validMismatch: validMismatch2 }

  // K3 extrapolate — both start from the reference's gridUpdate result, rounded to f32
  const uIn = new Float32Array(cu), vIn = new Uint32Array(cv)
  for (const a of [0, 1, 2]) for (let s = 0; s < S; s++) cpu.u[a][s] = uIn[a * S + s]
  gpu.writeGrid(0, { u: uIn, valid: vIn })
  cpu.extrapolate(); cpu.applySolidFaces()
  await submit(device, e => gpu.encodeExtrapolate(e))
  const g3 = await gpu.readGrid(gpu.finalVelocityBuffer)
  const cu3 = new Float64Array(3 * S), cv3 = new Uint32Array(3 * S)
  for (const a of [0, 1, 2]) { cu3.set(cpu.u[a], a * S); for (let s = 0; s < S; s++) cv3[a * S + s] = cpu.valid[a][s] }
  const u3 = maxDiff(g3.u, cu3, inRange)
  let validMismatch3 = 0
  for (let i = 0; i < 3 * S; i++) if (inRange(i) && g3.valid[i] !== cv3[i]) validMismatch3++
  out.k3 = { uDiff: u3.d, uRef: u3.ref, validMismatch: validMismatch3 }

  // K4 g2pMac + RK2 — both read the reference's final grid, rounded to f32
  const uFin = new Float32Array(cu3)
  for (const a of [0, 1, 2]) for (let s = 0; s < S; s++) cpu.u[a][s] = uFin[a * S + s]
  gpu.writeGrid(gpu.finalVelocityBuffer, { u: uFin, valid: cv3 })
  gpu.resetDiagnostics()
  const before = p.pos.slice()
  cpu.diag.wallClamps = 0; cpu.diag.unsetFaceReads = 0
  cpu.g2p(p); cpu.advect(p, dt)
  await submit(device, e => gpu.encodeG2P(e))
  const gp4 = await gpu.readParticles(), d4 = await gpu.readDiagnostics()
  const pick3 = (src: Float32Array, stride: number, off: number) => {
    const r = new Float64Array(3 * p.n)
    for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) r[3 * q + a] = src[stride * q + off + a]
    return r
  }
  const gVel = pick3(gp4.vel, 4, 0), gPos = pick3(gp4.pos, 4, 0)
  const gC = [0, 1, 2].map(a => pick3(gp4.aff, 12, 4 * a))
  const dv = maxDiff(gVel, p.vel), dp = maxDiff(gPos, p.pos)
  let dc = 0, cRef = 0
  for (const a of [0, 1, 2]) { const m = maxDiff(gC[a], p.c[a]); dc = Math.max(dc, m.d); cRef = Math.max(cRef, m.ref) }
  let disp = 0
  for (let i = 0; i < p.pos.length; i++) disp = Math.max(disp, Math.abs(p.pos[i] - before[i]))
  out.k4 = { velDiff: dv.d, velRef: dv.ref, cDiff: dc, cRef, posDiff: dp.d, extent: Math.max(...layout.extent), maxDisplacement: disp,
    wallClamps: { gpu: d4.wallClamps, cpu: cpu.diag.wallClamps }, unsetReads: { gpu: d4.unsetFaceReads, cpu: cpu.diag.unsetFaceReads } }

  // K5 present — the legacy 80-byte layout, from the GPU's own post-K4 state
  await submit(device, e => { gpu.writeParams(); gpu.encodePresent(e) })
  const pres = await gpu.readBuffer(gpu.presentationBuffer, 80 * p.n)
  const pf = new Float32Array(pres), pu = new Uint32Array(pres)
  let presErr = 0, presIdErr = 0
  for (let q = 0; q < p.n; q++) {
    for (let a = 0; a < 3; a++) {
      presErr = Math.max(presErr, Math.abs(pf[20 * q + a] - gp4.pos[4 * q + a] / L_REF))
      presErr = Math.max(presErr, Math.abs(pf[20 * q + 4 + a] - gp4.vel[4 * q + a] * TAU / L_REF))
    }
    if (pu[20 * q + 3] !== 0 || pu[20 * q + 17] !== 1 || pf[20 * q + 7] !== 20) presIdErr++
  }
  out.k5 = { maxAbsErr: presErr, idOrPhaseOrTempErrors: presIdErr }
  gpu.destroy()
  return out
}

/** 1 for slots that belong to face grid `a`'s logical range (ghosts included), else 0. */
function rangeMask(layout: GridLayout, a: 0 | 1 | 2): Uint8Array {
  const key = `${layout.nx},${layout.ny},${layout.nz},${layout.ring},${a}`
  const hit = maskCache.get(key)
  if (hit) return hit
  const m = new Uint8Array(layout.size)
  const [lo, hi] = layout.faceRange(a)
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) m[layout.idx(i, j, k)] = 1
  maskCache.set(key, m)
  return m
}
const maskCache = new Map<string, Uint8Array>()

// ── S3.1a physics gates on the GPU path ─────────────────────────────────────────────────────────────────────

async function linearField(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; apic?: boolean; seed?: number; precise?: boolean }) {
  const n = o.n ?? [16, 16, 16], rng = mulberry32(o.seed ?? 11)
  const p = blob([3, 3, 3], [n[0] - 4, n[1] - 4, n[2] - 4], rng)
  const u0 = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]
  const A = [0, 1, 2].map(() => [0, 1, 2].map(() => (rng() * 2 - 1) * 3))
  const exact = (q: number, a: number) => u0[a] + A[a][0] * p.pos[3 * q] + A[a][1] * p.pos[3 * q + 1] + A[a][2] * p.pos[3 * q + 2]
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) { p.vel[3 * q + a] = exact(q, a); p.c[a].set(A[a], 3 * q) }
  f32round(p)
  const gpu = new FlipGpuSimulator(device, { nx: n[0], ny: n[1], nz: n[2], dx: DX, ring: o.ring, apic: o.apic ?? true, preciseP2G: o.precise ?? true, maxParticles: p.n, lRef: L_REF, tauS: TAU })
  gpu.dt = 0
  gpu.setParticles(toInit(p))
  await submit(device, e => gpu.step(e, 1))
  const r = await gpu.readParticles(), d = await gpu.readDiagnostics()
  // "interior" = every face of the particle's stencil lies at least one full cell inside the blob (FINAL-PLAN S3.1a
  // gates interior particles); edge particles are reported separately — their faces hold partial mass, which
  // magnifies the fixed-point momentum quantum.
  const lo = [3, 3, 3], hi = [n[0] - 4, n[1] - 4, n[2] - 4]
  const interior = (q: number) => [0, 1, 2].every(a => { const c = p.pos[3 * q + a] / DX; return c >= lo[a] + 2 && c <= hi[a] - 1 })
  let ev = 0, ec = 0, evEdge = 0, ecEdge = 0, vScale = 0, aScale = 0, nInt = 0
  for (const row of A) for (const v of row) aScale = Math.max(aScale, Math.abs(v))
  for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) vScale = Math.max(vScale, Math.abs(exact(q, a)))
  for (let q = 0; q < p.n; q++) {
    const inner = interior(q)
    if (inner) nInt++
    for (let a = 0; a < 3; a++) {
      const e1 = Math.abs(r.vel[4 * q + a] - exact(q, a)) / vScale
      let e2 = 0
      for (let b = 0; b < 3; b++) e2 = Math.max(e2, Math.abs(r.aff[12 * q + 4 * a + b] - A[a][b]) / aScale)
      if (inner) { ev = Math.max(ev, e1); ec = Math.max(ec, e2) } else { evEdge = Math.max(evEdge, e1); ecEdge = Math.max(ecEdge, e2) }
    }
  }
  gpu.destroy()
  return { ev, ec, evEdge, ecEdge, interior: nInt, particles: p.n, vScale, aScale, unset: d.unsetFaceReads }
}

async function rotation(device: GPUDevice, o: { apic?: boolean }) {
  const rng = mulberry32(22)
  const p = blob([3, 3, 3], [12, 12, 12], rng)
  let M = 0; const c = [0, 0, 0]
  for (let q = 0; q < p.n; q++) { M += p.mass[q]; for (let a = 0; a < 3; a++) c[a] += p.mass[q] * p.pos[3 * q + a] }
  const o0 = c.map(v => v / M), w = [1.3, -0.7, 2.1]
  for (let q = 0; q < p.n; q++) {
    const r = [p.pos[3 * q] - o0[0], p.pos[3 * q + 1] - o0[1], p.pos[3 * q + 2] - o0[2]]
    p.vel.set([w[1] * r[2] - w[2] * r[1], w[2] * r[0] - w[0] * r[2], w[0] * r[1] - w[1] * r[0]], 3 * q)
    p.c[0].set([0, -w[2], w[1]], 3 * q); p.c[1].set([w[2], 0, -w[0]], 3 * q); p.c[2].set([-w[1], w[0], 0], 3 * q)
  }
  f32round(p)
  const Lof = (pos: ArrayLike<number>, vel: ArrayLike<number>, sp: number, sv: number) => {
    const L = [0, 0, 0]
    for (let q = 0; q < p.n; q++) {
      const rx = pos[sp * q] - o0[0], ry = pos[sp * q + 1] - o0[1], rz = pos[sp * q + 2] - o0[2]
      const vx = vel[sv * q], vy = vel[sv * q + 1], vz = vel[sv * q + 2], m = p.mass[q]
      L[0] += m * (ry * vz - rz * vy); L[1] += m * (rz * vx - rx * vz); L[2] += m * (rx * vy - ry * vx)
    }
    return L
  }
  const L0 = Lof(p.pos, p.vel, 3, 3)
  const gpu = new FlipGpuSimulator(device, { nx: 16, ny: 16, nz: 16, dx: DX, apic: o.apic ?? true, maxParticles: p.n, lRef: L_REF, tauS: TAU })
  gpu.dt = 0
  gpu.setParticles(toInit(p))
  await submit(device, e => gpu.step(e, 1))
  const r = await gpu.readParticles()
  const L1 = Lof(r.pos, r.vel, 4, 4)
  gpu.destroy()
  return { rel: Math.hypot(L1[0] - L0[0], L1[1] - L0[1], L1[2] - L0[2]) / Math.hypot(...L0) }
}

async function ballistic(device: GPUDevice, o: { dt: number; T?: number; gravity?: Vec3; v0?: Vec3; ring?: Vec3 }) {
  const T = o.T ?? 0.2, v0 = o.v0 ?? [1.2, 2.5, -0.7], gravity = o.gravity ?? [0, -9.80665, 0]
  const rng = mulberry32(33)
  const p = blob([10, 8, 13], [15, 13, 18], rng)
  for (let q = 0; q < p.n; q++) p.vel.set(v0, 3 * q)
  f32round(p)
  const gpu = new FlipGpuSimulator(device, { nx: 32, ny: 32, nz: 32, dx: DX, ring: o.ring, gravity, maxParticles: p.n, lRef: L_REF, tauS: TAU })
  gpu.dt = o.dt
  gpu.setParticles(toInit(p))
  const steps = Math.round(T / o.dt)
  const com = (pos: Float32Array) => { const c = [0, 0, 0]; for (let q = 0; q < p.n; q++) for (let a = 0; a < 3; a++) c[a] += pos[4 * q + a]; return c.map(v => v / p.n) }
  const ts = [0], cs = [com((await gpu.readParticles()).pos)]
  for (let s = 1; s <= steps; s++) {
    await submit(device, e => gpu.step(e, 1))
    ts.push(s * o.dt); cs.push(com((await gpu.readParticles()).pos))
  }
  const d = await gpu.readDiagnostics()
  const final = await gpu.readParticles()
  gpu.destroy()
  return { ts, cs, steps, wallClamps: d.wallClamps, unset: d.unsetFaceReads, finalPos: Array.from(final.pos) }
}

/** P2G cost, single- vs two-word fixed point: ~100k particles (a 25×25×20-cell block at 8 ppc) in 64³, `reps`
 *  scatters in one command buffer, wall time to completion / reps (includes clears; timestamp-free). */
async function p2gCost(device: GPUDevice, o: { reps?: number }) {
  const reps = o.reps ?? 200, rng = mulberry32(7)
  const p = blob([20, 5, 22], [44, 29, 41], rng)
  for (let q = 0; q < p.n; q++) p.vel.set([rng() - 0.5, rng() - 0.5, rng() - 0.5], 3 * q)
  const res: Record<string, number> = { particles: p.n }
  for (const precise of [false, true, false, true]) {
    const gpu = new FlipGpuSimulator(device, { nx: 64, ny: 64, nz: 64, dx: DX, preciseP2G: precise, maxParticles: p.n, lRef: L_REF, tauS: TAU })
    gpu.setParticles(toInit(p)); gpu.writeParams()
    await submit(device, e => gpu.encodeScatter(e))          // warm-up
    const t0 = performance.now()
    await submit(device, e => { for (let r = 0; r < reps; r++) gpu.encodeScatter(e) })
    const ms = (performance.now() - t0) / reps
    const key = precise ? 'twoWordMs' : 'oneWordMs'
    res[key] = Math.min(res[key] ?? Infinity, ms)
    gpu.destroy()
  }
  return res
}

// ── page API ─────────────────────────────────────────────────────────────────────────────────────────────────

interface FlipTestApi { ready: boolean; error: string | null; info: () => unknown; run: (test: string, params?: Record<string, unknown>) => Promise<unknown> }
declare global { interface Window { __flipTest: FlipTestApi } }
const api: FlipTestApi = { ready: false, error: null, info: () => null, run: async () => { throw new Error('not ready') } }
window.__flipTest = api

try {
  if (!navigator.gpu) throw new Error('navigator.gpu unavailable')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('requestAdapter returned null')
  // default LIMITS (the production constraints, e.g. 8 storage buffers per stage); the timestamp feature only adds the
  // GPU profiler (perf.ts profileStep) where the adapter has it
  const device = await adapter.requestDevice({ label: 'flip-selftest (default limits)', requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] })
  const errors: string[] = []
  device.addEventListener('uncapturederror', ev => errors.push((ev as GPUUncapturedErrorEvent).error.message))
  api.info = () => ({ vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description,
    maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage, gpuErrors: errors.slice() })
  api.run = async (test, params = {}) => {
    say(`run ${test} ${JSON.stringify(params)}`)
    const errBefore = errors.length
    let out: unknown
    if (test === 'configure') { if (params.solver === 'jpcg' || params.solver === 'mgpcg') solverConfig.method = params.solver; out = { solver: solverConfig.method } }
    else if (test === 'kernels') out = await kernels(device, params as KernelOpts)
    else if (test === 'linearField') out = await linearField(device, params)
    else if (test === 'rotation') out = await rotation(device, params)
    else if (test === 'ballistic') out = await ballistic(device, params as { dt: number })
    else if (test === 'p2gCost') out = await p2gCost(device, params)
    else if (test === 'projKernels') out = await projKernels(device, params)
    else if (test === 'g1a') out = await g1a(device)
    else if (test === 'settle') out = await settle(device, params)
    else if (test === 'damBreak') out = await damBreak(device)
    else if (test === 'equivalence') out = await equivalence(device)
    else if (test === 'tankCaps') out = await tankCaps(device, params as { cap: number; psiCap: number; seconds?: number })
    else if (test === 'densKernels') out = await densKernels(device, params)
    else if (test === 'direction') out = await direction(device)
    else if (test === 'restVolume') out = await restVolume(device)
    else if (test === 'martinMoyce') out = await martinMoyce(device, params as { aCells: number; aPhys?: number })
    else if (test === 'doubleDamBreak') out = await doubleDamBreak(device, params as { density: boolean; seconds?: number; ghost?: boolean })
    else if (test === 'violentColumn') out = await violentColumn(device, params as { ghost: boolean; seconds?: number })
    else if (test === 'ghostKernels') out = await ghostKernels(device, params)
    else if (test === 'flatSurface') out = await flatSurface(device, params as { ppc: number })
    else if (test === 'hydrostatic') out = await hydrostatic(device)
    else if (test === 'standingWave') out = await standingWave(device, params as { cellsPerH: number })
    else if (test === 'column') out = await column(device, params as { aCells: number; n2: number; h: number; nx: number; tauEnd: number; wall?: boolean })
    else if (test === 'varKernels') out = await varKernels(device, params)
    else if (test === 'sphereKernels') out = await sphereKernels(device, params)
    else if (test === 'viscKernels') out = await viscKernels(device, params)
    else if (test === 'stokesImages') out = await stokesImages(device, params as { gpuImages?: boolean; seed?: number })
    else if (test === 'stokesK40') out = await stokesK40(device, params as { seed?: number; tol?: number; steps?: number })
    else if (test === 'stokesCost') out = await stokesCost(device, params as { reps?: number })
    else if (test === 'stokesProfile') out = await stokesProfile(device, params as { caps?: number[]; reps?: number })
    else if (test === 'stokesPhysics') out = await stokesPhysics(device, params as { test: 'A1S' | 'A5S'; Rc?: number; tol?: number; seed?: number })
    else if (test === 'immKernels') out = await immKernels(device, params as { kind?: string; seed?: number })
    else if (test === 's37Kernels') out = await s37Kernels(device, params as { seed?: number; tol?: number })
    else if (test === 's37Physics') out = await s37Physics(device, params as { test: 'A1' | 'A3' | 'A4' | 'F0' | 'T0'; Rc?: number; s?: number; tol?: number; seed?: number })
    else if (test === 'immB1') out = await immB1(device, params as { seconds?: number })
    else if (test === 'immCost') out = await immCost(device, params as { settle?: number; reps?: number })
    else if (test === 'immRest') out = await immRest(device, params as { light: 'water' | 'honey'; tol?: number })
    else if (test === 'immLayered') out = await immLayered(device, params as { lower: 'water' | 'oil' | 'mercury' | 'ethanol'; upper: 'water' | 'oil' | 'mercury' | 'ethanol'; seconds: number; seed: number; immiscible: boolean })
    else if (test === 'viscTaylorGreen') out = await viscTaylorGreen(device, params as { cells: number; material: 'honey' | 'lava'; on: boolean })
    else if (test === 'viscStandingWave') out = await viscStandingWave(device, params as { cellsPerH: number; material: 'water' | 'lava'; on: boolean; walls: 'no-slip' | 'free-slip'; periods: number })
    else if (test === 'viscHuppert') out = await viscHuppert(device)
    else if (test === 'profileStep') out = await profileStep(device, params as { viscous?: boolean })
    else if (test === 'solveCost') out = await solveCost(device, params as { pCaps?: number[]; psiCaps?: number[]; reps?: number })
    else if (test === 'viscCost') out = await viscCost(device, params as { caps?: number[]; reps?: number })
    else if (test === 'spherePhysics') out = await spherePhysics(device, params as { test: 'AR' | 'MV' | 'WK' | 'FS' })
    else if (test === 'densityCancels') out = await densityCancels(device)
    else if (test === 'twoLayerHydrostatic') out = await twoLayerHydrostatic(device)
    else if (test === 'interfacialWave') out = await interfacialWave(device, params as { scale: number })
    else if (test === 'rayleighTaylor') out = await rayleighTaylor(device)
    else if (test === 'lockExchange') out = await lockExchange(device)
    else if (test === 'overturn') out = await overturn(device, params as { pair: 'hg-water' | 'water-oil'; seconds: number })
    else if (test === 'mixedCaps') out = await mixedCaps(device, params as { cap: number; variable: boolean; seconds?: number; surface?: 'ghost' | 'voxel'; thetaMin?: number })
    else throw new Error(`unknown test ${test}`)
    return { ...(out as object), gpuErrors: errors.slice(errBefore) }
  }
  api.ready = true
  say(`adapter: ${adapter.info.vendor} / ${adapter.info.architecture} — default limits (storage buffers/stage ${device.limits.maxStorageBuffersPerShaderStage})`)
} catch (e) {
  api.error = e instanceof Error ? e.message : String(e)
  say(`INIT FAILED: ${api.error}`)
}
