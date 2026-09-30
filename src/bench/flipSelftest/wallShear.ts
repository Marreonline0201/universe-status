/// <reference types="@webgpu/types" />
// The floor's wall shear on the GPU (flip-selftest.html; vault fluid/realism-2026-09/FRICTION-spec.md §3.3 and §4 W1g):
// the stage-level tests run through the stage's own encode function, FlipGpuSimulator.encodeWallShear (the one
// encodeSubstepBody calls first), against the analytic answer (W1a) and the f64 reference on identical f32 inputs
// (W1a-K: flipRef.applyWallShear; W1b: flipRef.keuleganTau); W1c runs the real step() with substeps = 2; W0b is the
// viscous guard's GPU part; A2 is ghost.ts's instant column with the stage on. Added 2026-09-30 by the review
// wf_fbc58c55-116's fix round: W1a-K on the viscosity solver's μ table (the page's binding, M3), W1a-K.skip (GATE-F7),
// W0c's refusals (M1/M2), W1g.reset (M4) and W0b's drift arm (INT-7). Metrics only —
// scripts/fluid-gates/s38-gpu.mjs applies the pre-registered bounds.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, makeParticles, keuleganTau, WALL_SHEAR_RE_CROSS, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator, type FlipParticleInit, type FlipWallShear } from '../../gpu-sim/flip/FlipGpuSimulator'
import { LIQUIDS } from '../../composition/materialData'
import { interfacialTension } from '../../composition/interfacialTension'
import { INCOMPRESSIBLE_NU_NUM } from '../../composition/liquidGate'
import { DX, L_REF, TAU, mulberry32, submit, solverConfig, capFor } from './util'
import { column } from './ghost'

const G = 9.80665
const liquid = (k: 'water' | 'mercury' | 'ethanol' | 'olive-oil') => ({ rho: LIQUIDS[k].density(20), mu: LIQUIDS[k].viscosity(20) })
const WATER = liquid('water')
/** Bits of an f32 array (bit identity: −0 ≠ +0, NaN = NaN). */
const bits = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length)

/** W1a (spec §4): hand-built floor cells, each a uniform film of 3 particles (h_c = 3·dx/8 = 18.75 mm at dx = 5 cm,
 *  8 ppc), U0 = 3 m/s along x in half the cells and along z in the rest (interior and wall-adjacent cells), the Darcy
 *  test law (f, ρ_c = M_c/V_c), Δt = the A2 step (1/240)(0.05/DX), 240 applications of encodeWallShear with no
 *  transfers. The exact answer is the recursion's closed form 1/U_N = 1/U0 + N·Δt·(f/8)/h_c. */
export async function wallShearW1a(device: GPUDevice, o: { f?: number } = {}) {
  const f = o.f ?? 0.02, h = 0.05, N = 240, U0 = 3, nx = 8, ny = 4, nz = 8
  const dt = (1 / 240) * (h / DX), hc = 3 * h / 8, massUnit = 1000 * h ** 3
  const mhat = Math.fround(WATER.rho / 8000)
  const parts: FlipParticleInit[] = [], along: (0 | 2)[] = []
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (let s = 0; s < 3; s++) {
    const axis: 0 | 2 = (i + k) % 2 === 0 ? 0 : 2
    const vel: Vec3 = [0, 0, 0]; vel[axis] = U0
    parts.push({ pos: [(i + 0.2 + 0.3 * s) * h, (0.25 + 0.25 * s) * h, (k + 0.3 + 0.2 * s) * h].map(Math.fround) as Vec3, vel, mass: mhat * massUnit, composition: 0, phase: 1, temperatureC: 20 })
    along.push(axis)
  }
  const gpu = new FlipGpuSimulator(device, { nx, ny, nz, dx: h, maxParticles: parts.length, lRef: L_REF, tauS: TAU })
  try {
    gpu.dt = dt
    gpu.setParticles(parts)
    gpu.setWallShear({ wall: 'y-', law: 'darcyTest', f })
    gpu.writeParams()
    await submit(device, e => { for (let s = 0; s < N; s++) gpu.encodeWallShear(e) })
    const vel = new Float32Array(await gpu.readBuffer(gpu.velBuf, 16 * parts.length))
    const UN = 1 / (1 / U0 + N * dt * (f / 8) / hc)
    let worst = 0, otherNonZero = 0, normalNonZero = 0, massChanged = 0, minU = Infinity, maxU = -Infinity
    // per arm (the films along x, the films along z): the same numbers, so a defect of one tangential component shows
    // in its own arm — 'other' is the component the arm's films do not flow along (z for x, x for z)
    const arm = () => ({ cells: 0, wallCells: 0, particles: 0, worst: 0, minU: Infinity, maxU: -Infinity, otherNonZero: 0, normalNonZero: 0, massChanged: 0 })
    const arms = { x: arm(), z: arm() }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const r = (i + k) % 2 === 0 ? arms.x : arms.z
      r.cells++
      if (i === 0 || i === nx - 1 || k === 0 || k === nz - 1) r.wallCells++
    }
    const vb = bits(vel), mb = new Uint32Array(new Float32Array([mhat]).buffer)[0]
    parts.forEach((_, q) => {
      const a = along[q], U = vel[4 * q + a], r = a === 0 ? arms.x : arms.z
      worst = Math.max(worst, Math.abs(U / UN - 1)); minU = Math.min(minU, U); maxU = Math.max(maxU, U)
      r.particles++; r.worst = Math.max(r.worst, Math.abs(U / UN - 1)); r.minU = Math.min(r.minU, U); r.maxU = Math.max(r.maxU, U)
      if (vb[4 * q + (2 - a)] !== 0) { otherNonZero++; r.otherNonZero++ }
      if (vb[4 * q + 1] !== 0) { normalNonZero++; r.normalNonZero++ }
      if (vb[4 * q + 3] !== mb) { massChanged++; r.massChanged++ }
    })
    const stats = await gpu.readWallShearStats()
    return { f, N, dt, hc, U0, UN, particles: parts.length, cells: nx * nz, worst, minU, maxU, otherNonZero, normalNonZero, massChanged, arms, stats }
  } finally { gpu.destroy() }
}

/** W1a-K (spec §4) on the GPU: ONE application of the production stage (Keulegan 1938 eq. 32 and the Re_h rule, h_c,
 *  ρ_c and ν_c from the particles) on a hand-built non-uniform set at the lab dx with Δt = 1/240 s — the set of the
 *  W1g derivation (revise_numbers.py §8): 0–9 floor-row particles per cell (sub-cell depths; a 12-particle cell whose
 *  h_c is capped at dx), particles in rows 1 and 2, v_y ≠ 0 and APIC c ≠ 0, a ±20 % spread of velocity within each cell
 *  plus a 5 % perpendicular jitter, tangential directions every 45°, |U| from 1e-3 to 5 m/s (both branches),
 *  wall-adjacent cells, a μ table [water, mercury, ethanol] at 20 °C with an ethanol cell and a water/ethanol cell (ν_c
 *  = μ_c/ρ_c exercised), and the dense cell: 8 mercury particles at 11 m/s along x, Σm̂·v ≈ 149 > 128 — a momentum
 *  word at 2^24 would overflow there (spec §3.3), so the momentum word's scale is observable. The reference is
 *  flipRef.applyWallShear (f64) on the same f32 inputs.
 *  Appended 2026-09-30 (review GATE-F7; after the pre-registered set, no rng draw): the zero-mean cell 40, whose two
 *  floor-row particles make the unacted-cell check non-vacuous (unactedChecked).
 *  `table` (review M3, 2026-09-30): 'own' (default) — a sim without the viscosity solver, the stage's own μ table;
 *  'solver' — the page's binding: a sim WITH the viscosity solver (viscosityActive false; the stage is encoded directly),
 *  μ uploaded to the solver's table (setMuTable) and none given to the stage. Same set, same reference. */
export async function wallShearW1aK(device: GPUDevice, o: { seed?: number; table?: 'own' | 'solver' } = {}) {
  const rng = mulberry32(o.seed ?? 38)
  const h = DX, dt = 1 / 240, nx = 10, ny = 6, nz = 10, massUnit = 1000 * h ** 3
  const LQ = [liquid('water'), liquid('mercury'), liquid('ethanol')]
  const muTable = new Float32Array(LQ.map(l => l.mu))
  const mhat = LQ.map(l => Math.fround(l.rho / 8000))
  const SPEEDS = [1e-3, 3e-3, 1e-2, 3e-2, 0.07, 0.2, 0.6, 1.5, 3.25, 5]
  const DENSE = 23, ETHANOL = 45, MIXED = 67, COMPRESSED = 81
  const pts: { pos: number[]; vel: number[]; c: number[]; id: number }[] = []
  const r = () => rng()
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const cell = i + nx * k
    let n = cell % 10, U = SPEEDS[(i + 3 * k) % 10], th = (Math.PI / 4) * ((i + k) % 8)
    let ids = (m: number) => { void m; return 0 }
    if (cell === DENSE) { n = 8; U = 11; th = 0; ids = () => 1 }
    if (cell === ETHANOL) { n = 5; ids = () => 2 }
    if (cell === MIXED) { n = 6; ids = m => (m % 2 ? 2 : 0) }
    if (cell === COMPRESSED) n = 12
    const dir = [Math.cos(th), Math.sin(th)], perp = [-Math.sin(th), Math.cos(th)]
    for (let q = 0; q < n; q++) {
      const s = n > 1 ? -1 + 2 * q / (n - 1) : 0, jit = n % 2 === 1 && q === n - 1 ? 0 : q % 2 === 0 ? 1 : -1
      const vt = [0, 1].map(a => U * (1 + 0.2 * s) * dir[a] + 0.05 * U * jit * perp[a])
      pts.push({ pos: [(i + 0.05 + 0.9 * r()) * h, (0.05 + 0.9 * r()) * h, (k + 0.05 + 0.9 * r()) * h], vel: [vt[0], 0.3 * U * (2 * r() - 1), vt[1]],
        c: Array.from({ length: 9 }, () => 4 * (2 * r() - 1)), id: ids(q) })
    }
    if ((i + 2 * k) % 3 === 0) for (const row of [1, 1, 2]) {
      pts.push({ pos: [(i + 0.05 + 0.9 * r()) * h, (row + 0.05 + 0.9 * r()) * h, (k + 0.05 + 0.9 * r()) * h], vel: [0, 1, 2].map(() => U * (2 * r() - 1)),
        c: Array.from({ length: 9 }, () => 4 * (2 * r() - 1)), id: 0 })
    }
  }
  // GATE-F7 (appended 2026-09-30, no rng draw): floor cell (i, k) = (0, 4), cell 40 — empty in the set above (0 floor-row
  // particles, no row-1/2 particles) — gets two water particles at fixed positions with tangential velocities (+0.7,
  // +0.2) m/s and their exact f32 negation; v_y and c are +0 (no −0 word). Their m̂·v terms cancel exactly, in the f64
  // sums and in the fixed-point words (round() is odd), so U_c = 0 on both sides: the cell is not acted on and its two
  // particles must come back bit-identical. The other cells' sums are integer adds of other particles: unchanged.
  const ZERO_MEAN = 40, vz = [0.7, 0.2].map(Math.fround)
  pts.push({ pos: [0.3 * h, 0.4 * h, 4.3 * h], vel: [vz[0], 0, vz[1]], c: Array(9).fill(0), id: 0 },
    { pos: [0.7 * h, 0.6 * h, 4.7 * h], vel: [-vz[0], 0, -vz[1]], c: Array(9).fill(0), id: 0 })
  // identical inputs: f32 positions, velocities and c; masses m̂·massUnit so that the GPU's m̂ = f32(m/massUnit) is m̂
  const p: RefParticles = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length)
  const init: FlipParticleInit[] = []
  const vIn = new Float32Array(4 * pts.length), cIn = new Float32Array(12 * pts.length)
  pts.forEach((t, q) => {
    const pos = t.pos.map(Math.fround), vel = t.vel.map(Math.fround), c = t.c.map(Math.fround)
    p.pos.set(pos, 3 * q); p.vel.set(vel, 3 * q)
    for (let a = 0; a < 3; a++) p.c[a].set(c.slice(3 * a, 3 * a + 3), 3 * q)
    p.mass[q] = mhat[t.id] * massUnit; p.mu![q] = muTable[t.id]
    init.push({ pos: pos as Vec3, vel: vel as Vec3, c: [c.slice(0, 3), c.slice(3, 6), c.slice(6, 9)] as [Vec3, Vec3, Vec3], mass: p.mass[q], composition: t.id, phase: 1, temperatureC: 20 })
    vIn.set([...vel, mhat[t.id]], 4 * q)
    for (let a = 0; a < 3; a++) cIn.set([...c.slice(3 * a, 3 * a + 3), 0], 12 * q + 4 * a)
  })
  const L = new GridLayout({ nx, ny, nz, dx: h })
  const cpu = new FlipRef(L, { wallShear: { wall: 'y-', law: 'keulegan1938' } })
  const vBefore = p.vel.slice()
  cpu.applyWallShear(p, dt)
  const field = new Map(cpu.wallShearField.map(e => [e.i + nx * e.k, e]))
  const floorRow = (q: number) => Math.floor(p.pos[3 * q + 1] / h) === 0
  const cellOf = (q: number) => Math.min(nx - 1, Math.max(0, Math.floor(p.pos[3 * q] / h))) + nx * Math.min(nz - 1, Math.max(0, Math.floor(p.pos[3 * q + 2] / h)))

  const solver = o.table === 'solver'
  const gpu = solver
    ? await FlipGpuSimulator.create(device, { nx, ny, nz, dx: h, maxParticles: pts.length, lRef: L_REF, tauS: TAU, density: WATER.rho, projection: true, freeSurface: 'ghost', viscosity: true })
    : new FlipGpuSimulator(device, { nx, ny, nz, dx: h, maxParticles: pts.length, lRef: L_REF, tauS: TAU })
  try {
    gpu.dt = dt
    gpu.setParticles(init)
    if (solver) {
      // the page's binding: μ in the viscosity solver's table (the page uploads it whatever viscosityActive is), the
      // viscous path off, no μ given to the stage (setWallShear refuses one on this sim)
      gpu.viscositySolver!.setMuTable(muTable)
      gpu.viscosityActive = false
      gpu.setWallShear({ wall: 'y-', law: 'keulegan1938' })
    } else gpu.setWallShear({ wall: 'y-', law: 'keulegan1938', muTable })
    gpu.writeParams()
    await submit(device, e => gpu.encodeWallShear(e))
    const vel = new Float32Array(await gpu.readBuffer(gpu.velBuf, 16 * pts.length))
    const aff = new Float32Array(await gpu.readBuffer(gpu.affBuf, 48 * pts.length))
    const cellsOut = await gpu.readWallShearCells()
    const stats = await gpu.readWallShearStats()
    const vb = bits(vel), vib = bits(vIn), ab = bits(aff), cib = bits(cIn)
    // (1) floor-row particles: |v_GPU − v_ref| per tangential component / |U_c|; (2) rows ≥ 1: v and c bit-identical;
    // (3) every particle's v_y, m̂ and c bit-identical; (4) floor-row particles of unacted cells: v bit-identical
    let worst = 0, worstAt = -1, floorN = 0, offRowChanged = 0, vyOrCChanged = 0, unactedMoved = 0, unactedChecked = 0
    let bookX = 0, bookZ = 0, gBookX = 0, gBookZ = 0, spreadMax = 0, xSignal = 0, zSignal = 0
    for (let q = 0; q < pts.length; q++) {
      if (vb[4 * q + 1] !== vib[4 * q + 1] || vb[4 * q + 3] !== vib[4 * q + 3]) vyOrCChanged++
      for (let w = 0; w < 12; w++) if (ab[12 * q + w] !== cib[12 * q + w]) { vyOrCChanged++; break }
      if (!floorRow(q)) { if (vb[4 * q] !== vib[4 * q] || vb[4 * q + 2] !== vib[4 * q + 2]) offRowChanged++; continue }
      const e = field.get(cellOf(q))
      if (!e) { unactedChecked++; if (vb[4 * q] !== vib[4 * q] || vb[4 * q + 2] !== vib[4 * q + 2]) unactedMoved++; continue }
      floorN++
      const Uc = Math.hypot(e.Ux, e.Uz)
      const err = Math.max(Math.abs(vel[4 * q] - p.vel[3 * q]), Math.abs(vel[4 * q + 2] - p.vel[3 * q + 2])) / Uc
      if (err > worst) { worst = err; worstAt = q }
      spreadMax = Math.max(spreadMax, Math.hypot(vBefore[3 * q], vBefore[3 * q + 2]) / Uc)
      // each component's signal: what a kernel dropping Δv_x (Δv_z) would miss this particle by, in |U_c|
      xSignal = Math.max(xSignal, Math.abs(e.dvx) / Uc); zSignal = Math.max(zSignal, Math.abs(e.dvz) / Uc)
      gBookX += p.mass[q] * (vel[4 * q] - vIn[4 * q]); gBookZ += p.mass[q] * (vel[4 * q + 2] - vIn[4 * q + 2])
    }
    // the set's preconditions (the derivation's assumptions) and its coverage, from the reference's per-cell field
    let aMax = 0, laminar = 0, turbulent = 0, capped = 0, tauRel = 0
    for (const [c, e] of field) {
      aMax = Math.max(aMax, dt * e.tau * h * h / (e.M * Math.hypot(e.Ux, e.Uz)))
      if (e.laminar) laminar++; else turbulent++
      if (e.n > 8) capped++
      bookX += e.M * e.dvx; bookZ += e.M * e.dvz
      tauRel = Math.max(tauRel, Math.abs(cellsOut[4 * c + 2] / e.tau - 1))
    }
    let denseSum = 0
    for (let q = 0; q < pts.length; q++) if (floorRow(q) && cellOf(q) === DENSE) denseSum += (p.mass[q] / massUnit) * Math.abs(vBefore[3 * q])
    const muCell = field.get(MIXED), etCell = field.get(ETHANOL)
    return {
      table: solver ? 'solver' : 'own', particles: pts.length, floorRowChecked: floorN, worst, worstAt, worstCell: worstAt >= 0 ? cellOf(worstAt) : -1,
      offRowChanged, vyOrCChanged, unactedMoved, unactedChecked, zeroMeanActed: field.has(ZERO_MEAN),
      cellsRef: cpu.wallShearLog[0].cells, cellsGpu: stats.cells, applications: stats.applications, bookedNonZero: stats.booked,
      laminarRef: cpu.wallShearLog[0].laminar, laminarGpu: stats.laminar,
      pre: { spreadMax, aMax, laminar, turbulent, capped, denseSum, denseN: field.get(DENSE)?.n ?? 0, muMixed: muCell ? { mu: muCell.nu * muCell.rho, n: muCell.n } : null, muEthanol: etCell ? etCell.nu * etCell.rho : null },
      booked: { ref: [bookX, bookZ], gpu: [gBookX, gBookZ] }, tauRel, signal: { x: xSignal, z: zSignal },
    }
  } finally { gpu.destroy() }
}

/** W1a-K.skip (review GATE-F7; pre-registered 2026-09-30 before its first run): a cell the stage skips must leave its
 *  particles bit-identical even when its per-cell record still holds an earlier application's Δv. A pair of water
 *  particles in floor cell (0, 0) of a 4×4×4 lab-dx tank, Δt = 1/240 s, Keulegan: at (+v, +v), v = (0.7, 0, 0.2) m/s,
 *  one application acts on the cell and books a Δv; the pair rewritten to (+v, −v) — the exact f32 negation, v_y and c
 *  +0 — cancels in the fixed-point sums (U_c = 0), so a second application must skip the cell: 0 cells acted in it and
 *  the pair's pos, vel and c words bit-identical across it. */
export async function wallShearW1aKSkip(device: GPUDevice) {
  const h = DX, dt = 1 / 240, massUnit = 1000 * h ** 3, mhat = Math.fround(WATER.rho / 8000)
  const v = [0.7, 0.2].map(Math.fround), plus: Vec3 = [v[0], 0, v[1]], minus: Vec3 = [-v[0], 0, -v[1]]
  const pos: Vec3[] = [[0.3 * h, 0.4 * h, 0.3 * h], [0.7 * h, 0.6 * h, 0.7 * h]].map(x => x.map(Math.fround) as Vec3)
  const pair = (second: Vec3): FlipParticleInit[] => pos.map((x, i) => ({ pos: x, vel: i === 0 ? plus : second, mass: mhat * massUnit, composition: 0, phase: 1, temperatureC: 20 }))
  const gpu = new FlipGpuSimulator(device, { nx: 4, ny: 4, nz: 4, dx: h, maxParticles: 2, lRef: L_REF, tauS: TAU })
  const words = async () => Promise.all(([[gpu.posBuf, 16], [gpu.velBuf, 16], [gpu.affBuf, 48]] as const).map(async ([b, n]) => new Uint32Array(await gpu.readBuffer(b, 2 * n))))
  try {
    gpu.dt = dt
    gpu.setParticles(pair(plus))
    gpu.setWallShear({ wall: 'y-', law: 'keulegan1938', muTable: new Float32Array([WATER.mu]) })
    gpu.writeParams()
    await submit(device, e => gpu.encodeWallShear(e))
    const first = await gpu.readWallShearStats()
    const rec = await gpu.readWallShearCells()
    gpu.setParticles(pair(minus))
    const before = await words()
    await submit(device, e => gpu.encodeWallShear(e))
    const after = await words(), second = await gpu.readWallShearStats()
    let differing = 0, total = 0
    before.forEach((a, i) => { total += a.length; for (let q = 0; q < a.length; q++) if (a[q] !== after[i][q]) differing++ })
    return { first: { applications: first.applications, cells: first.cells, booked: first.booked, dv: [rec[0], rec[1]], tau: rec[2] },
      second: { applications: second.applications - first.applications, cells: second.cells - first.cells, booked: second.booked - first.booked }, differing, total }
  } finally { gpu.destroy() }
}

/** W1b on the GPU: the law alone (wallShearCell.wgsl's lawTest entry) against flipRef.keuleganTau (f64) at the same
 *  inputs, water at 20 °C — the 41 × 21 grid U ∈ [1e-3, 5] m/s × h ∈ [1 mm, 56.7 mm] of the W1g derivation
 *  (revise_numbers.py §6), the spec's four references, U = 0, and the eight-depth scans U ∈ [1e-7, 5] (4001 points). */
export async function wallShearW1b(device: GPUDevice) {
  const RHO = WATER.rho, MU = WATER.mu, NU = MU / RHO
  const geom = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a * Math.pow(b / a, i / (n - 1)))
  const pts: { U: number; h: number; kind: string }[] = []
  for (const U of geom(1e-3, 5, 41)) for (const h of geom(1e-3, 0.0567, 21)) pts.push({ U, h, kind: 'grid' })
  const REFS: [number, number][] = [[3.25, 0.01], [4.17, 0.0567], [1e-3, 1e-3], [0.03, 0.01]]
  for (const [U, h] of REFS) pts.push({ U, h, kind: 'ref' })
  pts.push({ U: 0, h: 0.01, kind: 'zero' })
  const DEPTHS = [1e-3, 2e-3, 6.25e-3, 7.09e-3, 1e-2, 2.5e-2, 5e-2, 5.67e-2], SCAN = geom(1e-7, 5, 4001)
  for (const h of DEPTHS) for (const U of SCAN) pts.push({ U, h, kind: 'scan' })
  const inp = new Float32Array(8 * pts.length)
  pts.forEach((t, i) => inp.set([t.U, t.h, NU, MU, RHO], 8 * i))
  const gpu = new FlipGpuSimulator(device, { nx: 4, ny: 4, nz: 4, dx: DX, maxParticles: 1, lRef: L_REF, tauS: TAU })
  try {
    gpu.setWallShear({ wall: 'y-', law: 'keulegan1938' })
    const out = await gpu.wallShearLaw(inp)
    const agg = { turb: { n: 0, u: 0, tau: 0 }, lam: { n: 0, tau: 0 }, mis: { n: 0, tau: 0, reDev: 0 } }
    const refs: { U: number; h: number; tauGpu: number; usGpu: number; tauRef: number; usRef: number; laminar: boolean }[] = []
    let zeroTau = NaN, scanDecreases = 0, lowEnd = 0
    const prevByDepth = new Map<number, number>()
    pts.forEach((t, i) => {
      const tauG = out[4 * i], usG = out[4 * i + 1], lamG = out[4 * i + 2] > 0.5
      if (t.kind === 'zero') { zeroTau = tauG; return }
      const r = keuleganTau(t.U, t.h, NU, RHO)
      const tRel = Math.abs(tauG / r.tau - 1)
      if (r.laminar !== lamG) { agg.mis.n++; agg.mis.tau = Math.max(agg.mis.tau, tRel); agg.mis.reDev = Math.max(agg.mis.reDev, Math.abs(t.U * t.h / NU / WALL_SHEAR_RE_CROSS - 1)) }
      else if (r.laminar) { agg.lam.n++; agg.lam.tau = Math.max(agg.lam.tau, tRel) }
      else { agg.turb.n++; agg.turb.tau = Math.max(agg.turb.tau, tRel); agg.turb.u = Math.max(agg.turb.u, Math.abs(usG / r.ustar - 1)) }
      if (t.kind === 'ref') refs.push({ U: t.U, h: t.h, tauGpu: tauG, usGpu: usG, tauRef: r.tau, usRef: r.ustar, laminar: r.laminar })
      if (t.kind === 'scan') {
        const prev = prevByDepth.get(t.h)
        if (prev === undefined) lowEnd = Math.max(lowEnd, Math.abs(tauG / (3 * MU * t.U / t.h) - 1))
        else if (tauG < prev) scanDecreases++
        prevByDepth.set(t.h, tauG)
      }
    })
    // the f64 oracle against the spec's printed references (its W1b table): u*(3.25, 0.01), τ; u*(4.17, 0.0567), τ;
    // the laminar τ(1 mm/s, 1 mm), τ(0.03 m/s, 0.01 m) — each to its printed digits
    const printed: [number, number, 'us' | 'tau', number, number][] = [[3.25, 0.01, 'us', 0.152471658971, 0.5e-12], [3.25, 0.01, 'tau', 23.20592848, 0.5e-8],
      [4.17, 0.0567, 'us', 0.1616324490019, 0.5e-13], [4.17, 0.0567, 'tau', 26.07821158, 0.5e-8], [1e-3, 1e-3, 'tau', 3.004788e-3, 0.5e-9], [0.03, 0.01, 'tau', 9.014364e-3, 0.5e-9]]
    const oracle = printed.map(([U, hh, w, v, tol]) => { const r = keuleganTau(U, hh, NU, RHO); const got = w === 'us' ? r.ustar : r.tau; return { U, h: hh, what: w, got, printed: v, ok: Math.abs(got - v) <= tol } })
    return { points: pts.length, reCross: WALL_SHEAR_RE_CROSS, ...agg, zeroTau, refs, oracle, scans: DEPTHS.length, scanPoints: SCAN.length, scanDecreases, lowEnd }
  } finally { gpu.destroy() }
}

/** The ghost-fluid solver of the GPU sheet and pool scenes (ghost.ts makeSim with the CPU W1c's tolerances). */
function sheetSim(device: GPUDevice, n: Vec3, count: number, h: number, extra: Partial<Parameters<typeof FlipGpuSimulator.create>[1]> = {}) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: h, gravity: [0, -G, 0], maxParticles: count, lRef: L_REF, tauS: TAU, density: WATER.rho,
    projection: true, freeSurface: 'ghost', densityProjection: true, solverMethod: solverConfig.method,
    pressureTolerance: 1e-5, pressureCap: capFor(2000), psiTolerance: 1e-4, psiCap: capFor(2000), ...extra,
  })
}

/** W1c on the GPU (spec §4 W1c, W1g): a one-cell sheet (8 ppc jittered sub-cells in the floor row, dx = 5 cm, u0 =
 *  2 m/s along `axis`) in a 20 m tank (400 × 8 × 4 cells, or 4 × 8 × 400 for z), the full step() with `substeps`
 *  substeps per frame of the A2 frame time (1/240)(0.05/DX) — so a stage run once per frame instead of per substep
 *  applies half as often — the mean velocity of the particles in the window [9, 11] m every frame for t ≤ `seconds`.
 *  `f` null: the control (no stage); else the Darcy test law. */
export async function wallShearW1c(device: GPUDevice, o: { axis: 0 | 2; f: number | null; seconds?: number; substeps?: number }) {
  const h = 0.05, n = 400, w = 4, u0 = 2, T = o.seconds ?? 1, sub = o.substeps ?? 2
  const nx = o.axis === 0 ? n : w, nz = o.axis === 0 ? w : n
  const rng = mulberry32(7), init: FlipParticleInit[] = []
  const mass = WATER.rho * h ** 3 / 8
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (let s = 0; s < 8; s++) {
    const vel: Vec3 = [0, 0, 0]; vel[o.axis] = u0
    init.push({ pos: [(i + ((s & 1) + rng()) / 2) * h, ((((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h].map(Math.fround) as Vec3, vel, mass, composition: 0, phase: 1, temperatureC: 20 })
  }
  const gpu = await sheetSim(device, [nx, 8, nz], init.length, h)
  try {
    const frame = (1 / 240) * (h / DX)
    gpu.dt = frame / sub
    gpu.setParticles(init)
    if (o.f !== null) gpu.setWallShear({ wall: 'y-', law: 'darcyTest', f: o.f })
    const depth = init.length * (h ** 3 / 8) / (nx * h * nz * h)
    const ts: number[] = [], u: number[] = [], cnt: number[] = [], cross: number[] = []
    for (let s = 1; s * frame <= T + 1e-9; s++) {
      await submit(device, e => gpu.step(e, sub))
      const pos = new Float32Array(await gpu.readBuffer(gpu.posBuf, 16 * init.length)), vel = new Float32Array(await gpu.readBuffer(gpu.velBuf, 16 * init.length))
      let m = 0, su = 0, sv = 0
      for (let q = 0; q < init.length; q++) { const x = pos[4 * q + o.axis]; if (x >= 9 && x <= 11) { m++; su += vel[4 * q + o.axis]; sv += vel[4 * q + (2 - o.axis)] } }
      ts.push(s * frame); u.push(su / m); cnt.push(m); cross.push(sv / m)
    }
    const d = await gpu.readDiagnostics()
    const stats = o.f !== null ? await gpu.readWallShearStats() : null
    return { axis: o.axis, f: o.f, substeps: sub, frame, frames: ts.length, u0, depth, particles: init.length, ts, u, cnt, cross, stats, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
  } finally { gpu.destroy() }
}

/** W0b's GPU part (spec §4 W0b): olive oil at 20 °C (911 kg/m³, 0.084 Pa·s: ν = 9.2e-5 ≥ VISCOUS_RUN_NU) moving along
 *  the floor with the viscous solver present and `viscous` = viscosityActive; the same scene stepped with the stage
 *  set (keulegan1938) and never set, compared word for word. With the solve active the guard must keep the stage
 *  off: 0 differing words and an empty stage log. `viscous` false (the guard open) is the sensitivity control. */
export async function wallShearW0b(device: GPUDevice, o: { viscous: boolean; frames?: number }) {
  const OIL = liquid('olive-oil'), frames = o.frames ?? 20, rng = mulberry32(83), init: FlipParticleInit[] = []
  for (let k = 0; k < 8; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) for (let s = 0; s < 8; s++)
    init.push({ pos: [(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX].map(Math.fround) as Vec3,
      vel: [0.5, 0, 0.2], mass: OIL.rho * DX ** 3 / 8, composition: 0, phase: 1, temperatureC: 20 })
  const run = async (stage: boolean) => {
    const gpu = await FlipGpuSimulator.create(device, {
      nx: 16, ny: 12, nz: 16, dx: DX, gravity: [0, -G, 0], maxParticles: init.length, lRef: L_REF, tauS: TAU, density: OIL.rho,
      projection: true, freeSurface: 'ghost', densityProjection: true, solverMethod: solverConfig.method, viscosity: true,
    })
    try {
      gpu.dt = 1 / 120
      gpu.setParticles(init)
      gpu.viscositySolver!.setMuTable(new Float32Array([OIL.mu]))
      gpu.viscositySolver!.muDefault = OIL.mu
      gpu.viscosityActive = o.viscous
      if (stage) gpu.setWallShear({ wall: 'y-', law: 'keulegan1938' })
      for (let s = 0; s < frames; s++) await submit(device, e => gpu.step(e, 1))
      const state = [gpu.posBuf, gpu.velBuf, gpu.affBuf]
      const words = await Promise.all(state.map(async (b, i) => new Uint32Array(await gpu.readBuffer(b, [16, 16, 48][i] * init.length))))
      const budget = gpu.budgetState(1)
      return { words, stats: stage ? await gpu.readWallShearStats() : null, budget: { viscous: budget.viscous, wallShear: budget.wallShear } }
    } finally { gpu.destroy() }
  }
  const on = await run(true), off = await run(false)
  let differing = 0, total = 0
  on.words.forEach((a, i) => { total += a.length; for (let q = 0; q < a.length; q++) if (a[q] !== off.words[i][q]) differing++ })
  return { viscous: o.viscous, frames, particles: init.length, nu: OIL.mu / OIL.rho, differing, total, stats: on.stats, budget: on.budget }
}

/** W0b's drift arm on the GPU (review INT-7, prereg R-D; pre-registered 2026-09-30 before its first run): the stage is
 *  guarded off while the immiscible drift runs. Water over mercury at 20 °C (both ν < VISCOUS_RUN_NU: the page's case),
 *  σ from the page's interfacialTension, the drift solver configured as the page configures it; a sim WITHOUT the
 *  viscosity solver, so the viscous guard cannot be what keeps the stage off; 2 mercury rows under 2 water rows over an
 *  8 × 8-cell floor patch, moving at (0.5, 0, 0.2) m/s; the same scene stepped with the stage set (keulegan1938, its
 *  own μ table) and never set, compared word for word. `drift` true: the guard must keep the stage off — 0 differing
 *  words, an empty log, budgetState immiscible true and wallShear false. `drift` false (the same scene, the drift
 *  configured but off) is the sensitivity control: the stage must act. */
export async function wallShearW0bDrift(device: GPUDevice, o: { drift: boolean; frames?: number }) {
  const KEYS = ['water', 'mercury'] as const, LQ = KEYS.map(k => liquid(k)), frames = o.frames ?? 20, rng = mulberry32(84), init: FlipParticleInit[] = []
  for (let k = 0; k < 8; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) for (let s = 0; s < 8; s++) {
    const id = j < 2 ? 1 : 0
    init.push({ pos: [(i + ((s & 1) + rng()) / 2) * DX, (j + (((s >> 1) & 1) + rng()) / 2) * DX, (k + (((s >> 2) & 1) + rng()) / 2) * DX].map(Math.fround) as Vec3,
      vel: [0.5, 0, 0.2], mass: LQ[id].rho * DX ** 3 / 8, composition: id, phase: 1, temperatureC: 20 })
  }
  const run = async (stage: boolean) => {
    const gpu = await FlipGpuSimulator.create(device, {
      nx: 16, ny: 12, nz: 16, dx: DX, gravity: [0, -G, 0], maxParticles: init.length, lRef: L_REF, tauS: TAU, density: WATER.rho,
      projection: true, freeSurface: 'ghost', densityProjection: true, variableDensity: true, solverMethod: solverConfig.method, immiscible: true,
    })
    try {
      gpu.dt = 1 / 120
      gpu.setParticles(init)
      gpu.immiscibleSolver!.configure({ materials: LQ.map((l, k) => ({ compositions: [k], rho: l.rho, mu: l.mu })), sigma: (a, b) => interfacialTension(KEYS[a], KEYS[b]), nuNum: INCOMPRESSIBLE_NU_NUM })
      gpu.immiscibleActive = o.drift
      if (stage) gpu.setWallShear({ wall: 'y-', law: 'keulegan1938', muTable: new Float32Array(LQ.map(l => l.mu)) })
      for (let s = 0; s < frames; s++) await submit(device, e => gpu.step(e, 1))
      const words = await Promise.all(([[gpu.posBuf, 16], [gpu.velBuf, 16], [gpu.affBuf, 48]] as const).map(async ([b, n]) => new Uint32Array(await gpu.readBuffer(b, n * init.length))))
      const budget = gpu.budgetState(1)
      return { words, stats: stage ? await gpu.readWallShearStats() : null, budget: { immiscible: budget.immiscible, viscous: budget.viscous, wallShear: budget.wallShear } }
    } finally { gpu.destroy() }
  }
  const on = await run(true), off = await run(false)
  let differing = 0, total = 0
  on.words.forEach((a, i) => { total += a.length; for (let q = 0; q < a.length; q++) if (a[q] !== off.words[i][q]) differing++ })
  return { drift: o.drift, frames, particles: init.length, sigma: interfacialTension('water', 'mercury'), nu: LQ.map(l => l.mu / l.rho), differing, total, stats: on.stats, budget: on.budget }
}

/** W0c on the GPU (review M1/M2; pre-registered 2026-09-30 before its first run): setWallShear's refusals. On a sim
 *  without the viscosity solver it must throw on the laws 'Keulegan1938' and 'darcytest' and an absent law, darcyTest
 *  without f, constantTest without tau, a muDefault of NaN, 0 or −1, and a muTable entry of NaN or 0; on a sim with the
 *  solver on any muDefault — each refused call leaving the stage unset. It must accept the gates' sign-flip controls
 *  f = −0.02 and τ = −10 Pa (no sign rule) and, on the solver sim, the page's configuration (keulegan1938, no μ). */
export async function wallShearRefusals(device: GPUDevice) {
  const plain = new FlipGpuSimulator(device, { nx: 4, ny: 4, nz: 4, dx: DX, maxParticles: 1, lRef: L_REF, tauS: TAU })
  let withSolver: FlipGpuSimulator | null = null
  try {
    withSolver = await FlipGpuSimulator.create(device, { nx: 8, ny: 8, nz: 8, dx: DX, maxParticles: 1, lRef: L_REF, tauS: TAU, density: WATER.rho, projection: true, freeSurface: 'ghost', viscosity: true })
    const bad = (law: string) => law as FlipWallShear['law']
    const Y = { wall: 'y-' as const }
    const cases: { name: string; sim: FlipGpuSimulator; w: FlipWallShear; refuse: boolean }[] = [
      { name: "law 'Keulegan1938'", sim: plain, w: { ...Y, law: bad('Keulegan1938') }, refuse: true },
      { name: "law 'darcytest' (f 0.02)", sim: plain, w: { ...Y, law: bad('darcytest'), f: 0.02 }, refuse: true },
      { name: 'law absent', sim: plain, w: { ...Y } as FlipWallShear, refuse: true },
      { name: 'darcyTest without f', sim: plain, w: { ...Y, law: 'darcyTest' }, refuse: true },
      { name: 'constantTest without tau', sim: plain, w: { ...Y, law: 'constantTest' }, refuse: true },
      { name: 'muDefault NaN', sim: plain, w: { ...Y, law: 'keulegan1938', muDefault: NaN }, refuse: true },
      { name: 'muDefault 0', sim: plain, w: { ...Y, law: 'keulegan1938', muDefault: 0 }, refuse: true },
      { name: 'muDefault −1', sim: plain, w: { ...Y, law: 'keulegan1938', muDefault: -1 }, refuse: true },
      { name: 'muTable entry NaN', sim: plain, w: { ...Y, law: 'keulegan1938', muTable: new Float32Array([WATER.mu, NaN]) }, refuse: true },
      { name: 'muTable entry 0', sim: plain, w: { ...Y, law: 'keulegan1938', muTable: new Float32Array([WATER.mu, 0]) }, refuse: true },
      { name: 'muDefault (water) on the solver sim', sim: withSolver, w: { ...Y, law: 'keulegan1938', muDefault: WATER.mu }, refuse: true },
      { name: 'darcyTest f = −0.02 (sign-flip control)', sim: plain, w: { ...Y, law: 'darcyTest', f: -0.02 }, refuse: false },
      { name: 'constantTest τ = −10 Pa (sign-flip control)', sim: plain, w: { ...Y, law: 'constantTest', tau: -10 }, refuse: false },
      { name: 'keulegan1938, no μ, on the solver sim (the page)', sim: withSolver, w: { ...Y, law: 'keulegan1938' }, refuse: false },
    ]
    const results = cases.map(c => {
      let threw = false, message = ''
      try { c.sim.setWallShear(c.w) } catch (e) { threw = true; message = e instanceof Error ? e.message : String(e) }
      const set = c.sim.wallShear !== null
      c.sim.setWallShear(null)
      return { name: c.name, refuse: c.refuse, threw, set, ok: c.refuse ? threw && !set : !threw && set, message: message.slice(0, 200) }
    })
    return { cases: results.length, refused: results.filter(r => r.refuse && r.ok).length, mustRefuse: results.filter(r => r.refuse).length,
      accepted: results.filter(r => !r.refuse && r.ok).length, mustAccept: results.filter(r => !r.refuse).length, results }
  } finally { plain.destroy(); withSolver?.destroy() }
}

/** W1g.reset (review M4; pre-registered 2026-09-30 before its first run): resetDiagnostics clears the stage log. Four
 *  floor cells of a 4×4×4 lab-dx tank, four water particles each at (0.5, 0, 0.2) m/s, Keulegan, Δt = 1/240 s: three
 *  applications (the log shows 3 and cells > 0), resetDiagnostics() (every word of the log 0), one more application
 *  (applications 1 and the cells of one application). */
export async function wallShearReset(device: GPUDevice) {
  const h = DX, massUnit = 1000 * h ** 3, mhat = Math.fround(WATER.rho / 8000), init: FlipParticleInit[] = []
  for (let k = 0; k < 2; k++) for (let i = 0; i < 2; i++) for (let s = 0; s < 4; s++)
    init.push({ pos: [(i + 0.2 + 0.2 * s) * h, (0.2 + 0.2 * s) * h, (k + 0.8 - 0.2 * s) * h].map(Math.fround) as Vec3, vel: [0.5, 0, 0.2], mass: mhat * massUnit, composition: 0, phase: 1, temperatureC: 20 })
  const gpu = new FlipGpuSimulator(device, { nx: 4, ny: 4, nz: 4, dx: h, maxParticles: init.length, lRef: L_REF, tauS: TAU })
  try {
    gpu.dt = 1 / 240
    gpu.setParticles(init)
    gpu.setWallShear({ wall: 'y-', law: 'keulegan1938', muTable: new Float32Array([WATER.mu]) })
    gpu.writeParams()
    await submit(device, e => { for (let s = 0; s < 3; s++) gpu.encodeWallShear(e) })
    const before = await gpu.readWallShearStats()
    gpu.resetDiagnostics()
    const reset = await gpu.readWallShearStats()
    await submit(device, e => gpu.encodeWallShear(e))
    const after = await gpu.readWallShearStats()
    return { particles: init.length, floorCells: 4, before, reset, after }
  } finally { gpu.destroy() }
}

/** A2 on the GPU with the stage on (spec §4 W1g): ghost.ts's instant column itself — FlipGpuSimulator.create is wrapped
 *  for the call so the sim column() builds gets the stage (keulegan1938, water at 20 °C), and its destroy() is held
 *  back until the stage log is read; column() is not copied (spec §3.6: a copy of the harness would drift). */
export async function wallShearA2(device: GPUDevice, o: { aCells: number; n2: number; h: number; nx: number; tauEnd: number }) {
  const create = FlipGpuSimulator.create
  let sim: FlipGpuSimulator | null = null, finish: (() => void) | null = null
  const ws: FlipWallShear = { wall: 'y-', law: 'keulegan1938', muTable: new Float32Array([WATER.mu]) }
  FlipGpuSimulator.create = async (d: GPUDevice, opts: Parameters<typeof create>[1]) => {
    const g = await create.call(FlipGpuSimulator, d, opts)
    g.setWallShear(ws)
    const destroy = g.destroy.bind(g)
    g.destroy = () => { sim = g; finish = destroy }
    return g
  }
  let r: Awaited<ReturnType<typeof column>>
  try { r = await column(device, o) } finally { FlipGpuSimulator.create = create }
  const g = sim as FlipGpuSimulator | null
  if (!g || !finish) throw new Error('wallShearA2: column() built no simulator')
  try { return { ...r, wallShear: await g.readWallShearStats() } } finally { (finish as () => void)() }
}
