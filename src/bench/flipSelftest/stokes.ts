/// <reference types="@webgpu/types" />
// S3.6e on the GPU (flip-selftest.html): the unified pressure–stress solve's pieces against the f64 reference on
// identical inputs (spec vault fluid/realism-2026-09/S3.6e-variational-stokes-spec.md §5). Metrics only —
// scripts/fluid-gates/s36e-gpu.mjs applies the criteria.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, makeParticles } from '../../sim-ref/flipRef'
import { fillMaterials, mulberry32 as mb32 } from '../../sim-ref/twoLayer'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { vftViscosity, LAVA_GRD_PRESET, SOLID_REFERENCE } from '../../composition/materialData'
import { DX, L_REF, TAU, toInit, submit, solverConfig, capFor, f32round } from './util'
import { lsW, phiOf, phiTol } from './ghost'
import { pool } from './sphere'
import { HONEY } from './visc'

const G = 9.80665
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))

/** f32 construction error of the ball's radial image c + (2R_s − r)·q/r, q = x − c (common.wgsl sphereRadialImage), per
 *  axis in ulp(ext), fixed before the first run: q ≤ ½ (the subtraction; x and c are f32 of the reference's values, ½
 *  each); r = length(q) ≤ 4u·r (dot of three, sqrt); 2R_s − r ≤ 2·½ + 4 (R_s's rounding, r's error) + ½; the ratio f adds
 *  u relative and the product q·f one more u on |q·f| = 2R_s − r ≤ R_s — so |q|·|δf| ≤ δ(2R_s − r) + 5u·R_s ≤ 10.5,
 *  plus |f|·|δq| ≤ 1 and the final add of c ½: ≤ 12 ulp(ext); with the sample point's ½ and the subtraction's ½, r = x_img
 *  − x_s errs by ≤ 13 ulp per axis (u·ext < ulp(ext)). A sample within reach of an image takes this in its phiTol. */
const IMAGE_ULPS = 13

/** G0 (spec §5): the Zhu–Bridson level set with the ball's radial images — the cell-centre φ (lsScatter) and the viscous
 *  quarter lattice (viscosity.wgsl latScatter) against flipRef.zhuBridson with levelSetSphere 'mirror' on the same
 *  particles. A honey pool 8 cells deep with a ball (R = 3·dx) fully submerged; `gpuImages: false` is the negative
 *  control (the reference keeps its images). Also reported: how many samples the images move by more than their bound
 *  (the reference with and without them), so a pass means the images were exercised. */
export async function stokesImages(device: GPUDevice, o: { gpuImages?: boolean; seed?: number } = {}) {
  const n: Vec3 = [16, 16, 16], dt = 1 / 120
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX })
  const R = 3 * DX
  const ctr: Vec3 = [Math.fround(8.3 * DX), Math.fround(4.4 * DX), Math.fround(7.7 * DX)]
  const p = pool(n, 8, ctr, R, o.seed ?? 43)
  const mk = (ls: 'mirror' | 'air') => {
    const c = new FlipRef(L, { gravity: [0, -G, 0], density: HONEY.rho, projection: true, freeSurface: 'ghost', pressureTolerance: 1e-9, levelSetSphere: ls })
    c.sphere = { center: [...ctr] as Vec3, radius: R, velocity: [0, 0, 0] }
    c.sphereFractions(); c.p2g(p); c.gridUpdate(dt); c.applySolidFaces(); c.classifyLevelSet(p); c.extendLiquidIntoSphere()
    return c
  }
  const cpu = mk('mirror'), air = mk('air')
  const gpu = await FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, gravity: [0, -G, 0], maxParticles: p.n, lRef: L_REF, tauS: TAU,
    projection: true, density: HONEY.rho, pressureTolerance: 1e-2, pressureCap: capFor(400), solverMethod: solverConfig.method,
    densityProjection: true, psiTolerance: 1e-3, psiCap: capFor(400), freeSurface: 'ghost', viscosity: true,
  })
  gpu.viscositySolver!.setMuTable(new Float32Array([HONEY.mu]))
  gpu.viscositySolver!.muDefault = HONEY.mu
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  gpu.sphereLevelSetImages = o.gpuImages ?? true
  gpu.setSphere({ center: ctr, radius: R, velocity: [0, 0, 0], density: 0 })
  await submit(device, e => { gpu.encodeSphereFractions(e); gpu.encodeScatter(e); gpu.encodeGridUpdate(e); gpu.encodePressureLabels(e) })
  await submit(device, e => gpu.viscositySolver!.encode(e, 'latScatter'))
  const pc = gpu.solver!.paddedCount, ext = Math.max(...L.extent), lsR = DX, rbar = DX / 4
  const cellSums = new Int32Array(await gpu.readBuffer(gpu.lsCellBuf!, 32 * pc))
  const phiG = new Float32Array(await gpu.readBuffer(gpu.phiCellBuf!, 4 * pc))
  const VB = gpu.viscositySolver!.bufs
  const latSums = new Int32Array(await gpu.readBuffer(VB.latSums, 4 * 64 * pc))
  const near = new Uint32Array(await gpu.readBuffer(VB.bandNear, 4 * pc))
  const reach = (x: number, y: number, z: number) => Math.abs(Math.hypot(x - ctr[0], y - ctr[1], z - ctr[2]) - R) < 2 * lsR + DX
  const tolAt = (W: number, x: number, y: number, z: number) => phiTol(W, DX, ext, reach(x, y, z) ? IMAGE_ULPS : 1.5)
  // (a) cell centres (lsScatter + lsFinalize)
  let cellRatio = 0, cellImaged = 0, cellsNearBall = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k), li = lin(L, i, j, k), x = (i + 0.5) * DX, y = (j + 0.5) * DX, z = (k + 0.5) * DX
    const tol = tolAt(lsW(cellSums, 8 * li), x, y, z)
    cellRatio = Math.max(cellRatio, Math.abs(phiG[li] - cpu.levelSet[s]) / tol)
    if (reach(x, y, z)) cellsNearBall++
    if (Math.abs(cpu.levelSet[s] - air.levelSet[s]) > tol) cellImaged++
  }
  // (b) the quarter lattice of the band cells (viscosity latScatter; lattice point (c, s) at (c + ¼ + ½·s)·dx)
  let latRatio = 0, latPoints = 0, latImaged = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const li = lin(L, i, j, k)
    if (near[li] === 0) continue
    for (let sb = 0; sb < 8; sb++) {
      const sx = sb & 1, sy = (sb >> 1) & 1, sz = (sb >> 2) & 1
      const x = (i + 0.25 + 0.5 * sx) * DX, y = (j + 0.25 + 0.5 * sy) * DX, z = (k + 0.25 + 0.5 * sz) * DX
      const base = 8 * (8 * li + sb)
      const phiLat = phiOf(latSums, base, DX, lsR, rbar)
      const ref = cpu.zhuBridson(x, y, z), tol = tolAt(lsW(latSums, base), x, y, z)
      latRatio = Math.max(latRatio, Math.abs(phiLat - ref) / tol)
      latPoints++
      if (Math.abs(ref - air.zhuBridson(x, y, z)) > tol) latImaged++
    }
  }
  gpu.destroy()
  return { particles: p.n, gpuImages: o.gpuImages ?? true, cellRatio, cellImaged, cellsNearBall, latRatio, latPoints, latImaged }
}

/** The S3.7 A5 scene (s36e-ref A5S): iron (ρ_s, NIST SRD 126 via materialData) in the 1100 °C GRD melt, R = Rc cells,
 *  tank 24 × 30 × 24 at Rc = 3.5 (scaled), melt 28 cells deep, the ball's centre 18 cells up — the GPU simulator with the
 *  Stokes path on (scheme 'auto', monolithic ball, viscous path on). */
export async function stokesScene(device: GPUDevice, o: { Rc?: number; seed?: number; tol?: number; cap?: number; warm?: boolean }) {
  const Rc = o.Rc ?? 3.5, f = Rc / 3.5, n = Math.round(24 * f), ny = Math.round(30 * f)
  const MU = vftViscosity(LAVA_GRD_PRESET, 1100), RHOM = 2600, RHO_FE = SOLID_REFERENCE.iron.solidDensityKgM3!, R = Rc * DX
  const L = new GridLayout({ nx: n, ny, nz: n, dx: DX })
  const ctr: Vec3 = [Math.fround(n / 2 * DX), Math.fround((ny - 2 * f - 2 * Rc - 3 * f) * DX), Math.fround(n / 2 * DX)]
  const { p: all } = fillMaterials(n, Math.round(ny - 2 * f), n, DX, mb32(o.seed ?? 35), () => [RHOM, 0])
  const keep: number[] = []
  for (let q = 0; q < all.n; q++) if (Math.hypot(all.pos[3 * q] - ctr[0], all.pos[3 * q + 1] - ctr[1], all.pos[3 * q + 2] - ctr[2]) >= R) keep.push(q)
  const p = makeParticles(keep.length)
  keep.forEach((q, i) => { p.pos.set(all.pos.subarray(3 * q, 3 * q + 3), 3 * i); p.mass[i] = all.mass[q] })
  f32round(p)
  const gpu = await FlipGpuSimulator.create(device, {
    nx: n, ny, nz: n, dx: DX, gravity: [0, -G, 0], maxParticles: p.n, lRef: L_REF, tauS: TAU,
    // the scaled tanks can be odd-sized (R = 2.5: 17 × 21 × 17), which multigrid cannot coarsen: the ψ solve takes JPCG there
    projection: true, density: RHOM, variableDensity: true, densityProjection: true, freeSurface: 'ghost', solverMethod: n % 2 || ny % 2 ? 'jpcg' : solverConfig.method,
    pressureTolerance: 1e-4, pressureCap: n % 2 || ny % 2 ? 400 : capFor(400), psiTolerance: 1e-4, psiCap: n % 2 || ny % 2 ? 400 : capFor(400), viscosity: true,
  })
  gpu.viscositySolver!.setMuTable(new Float32Array([MU]))
  gpu.viscositySolver!.muDefault = MU
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  gpu.viscosityActive = true
  gpu.viscosityScheme = 'auto'
  gpu.setSphere({ center: ctr, radius: R, velocity: [0, 0, 0], density: RHO_FE, coupling: 'monolithic' })
  const sk = gpu.stokesSolver!
  sk.tol = o.tol ?? 1e-2; sk.cap = o.cap ?? 2000; sk.warm = o.warm ?? true
  return { gpu, sk, L, n: [n, ny, n] as Vec3, R, ctr, MU, RHOM, RHO_FE, particles: p.n, Us: 2 / 9 * (RHO_FE - RHOM) * G * R * R / MU }
}

/** s36e-ref's ball scenes on the GPU Stokes path (spec §5 G2):
 *  A1S — the S3.7 A1 scene (s = 2 ball in water at rest, R = 3.5 cells, clearance 3R), settled 120 substeps on the split
 *        path with the ball held, released with ONE Stokes step (the viscous path on with water's μ, as the reference):
 *        a₀ = −ΔV/Δt (the gate compares with g(s − 1)/(s + ½)).
 *  A5S — stokesScene at Rc to terminal: U changes < 0.5 % over 0.05 s (cap 1 s), U/U_Stokes; iterations and wall time
 *        per substep recorded. */
export async function stokesPhysics(device: GPUDevice, o: { test: 'A1S' | 'A5S'; Rc?: number; tol?: number; seed?: number }) {
  const dt = 1 / 120
  if (o.test === 'A1S') {
    const Rc = 3.5, n = Math.round(8 * Rc), R = Rc * DX, s = 2
    const RHO_W = 998.2072, MU_W = 1.001596e-3
    const c: Vec3 = [Math.fround(n / 2 * DX + 0.3 * DX), Math.fround(4 * Rc * DX), Math.fround(n / 2 * DX - 0.2 * DX)]
    const p = pool([n, n + 2, n], n, c, R, o.seed ?? 31)
    const gpu = await FlipGpuSimulator.create(device, {
      nx: n, ny: n + 2, nz: n, dx: DX, gravity: [0, -G, 0], maxParticles: p.n, lRef: L_REF, tauS: TAU,
      projection: true, density: RHO_W, densityProjection: true, freeSurface: 'ghost', solverMethod: solverConfig.method,
      pressureTolerance: 1e-4, pressureCap: capFor(400), psiTolerance: 1e-3, psiCap: capFor(400), viscosity: true,
    })
    gpu.viscositySolver!.setMuTable(new Float32Array([MU_W]))
    gpu.viscositySolver!.muDefault = MU_W
    gpu.dt = dt
    gpu.setParticles(toInit(p))
    gpu.viscosityActive = true
    gpu.setSphere({ center: c, radius: R, velocity: [0, 0, 0], density: 0 })
    for (let k = 0; k < 120; k++) await submit(device, e => gpu.step(e, 1))
    gpu.setSphere({ center: c, radius: R, velocity: [0, 0, 0], density: s * RHO_W, coupling: 'monolithic' })
    gpu.viscosityScheme = 'auto'
    const sk = gpu.stokesSolver!
    sk.tol = o.tol ?? 1e-2; sk.cap = 4000
    const v0 = (await gpu.readSphere()).velocity
    await submit(device, e => gpu.step(e, 1))
    const sp = await gpu.readSphere(), st = await sk.readStats()
    gpu.destroy()
    return { a: -(sp.velocity[1] - v0[1]) / dt, a0: G * (s - 1) / (s + 0.5), particles: p.n, iterations: st.iterations, converged: st.converged, force: sp.force, stokesRan: true }
  }
  const sc = await stokesScene(device, { Rc: o.Rc, seed: o.seed, tol: o.tol, cap: 4000 })
  const { gpu, sk } = sc
  sk.resetFaults()
  let k = 0, prev = 0, uS = 0, wall = 0
  const its: number[] = []
  for (; k < 120; k++) {
    const t0 = performance.now()
    await submit(device, e => gpu.step(e, 1))
    wall += performance.now() - t0
    if (k < 3 || k % 12 === 0) its.push((await sk.readStats()).iterations)
    if ((k + 1) % 6 === 0) {
      const u = -(await gpu.readSphere()).velocity[1]
      if (k > 12 && Math.abs(u - prev) <= 0.005 * u) { uS = u; break }
      prev = u
    }
    uS = -(await gpu.readSphere()).velocity[1]
  }
  const f = await sk.readFaults(), d = await gpu.readDiagnostics()
  gpu.destroy()
  return { Rc: o.Rc ?? 3.5, n: sc.n, particles: sc.particles, u: uS / sc.Us, uMs: uS, Us: sc.Us, re: sc.RHOM * sc.Us * 2 * sc.R / sc.MU, t: (k + 1) * dt,
    iterationsSampled: its, faults: f, msPerStep: wall / (k + 1), psiCaps: d.capHits }
}

/** K40 (the K35 pattern, spec §5 G2): one Stokes step of the A5 scene, then the next (warm-started). Per step the TRUE
 *  residual of the GPU's y against the operator assembled here in f64 from the GPU's OWN read-back coefficients (face
 *  g, gv, K⁻¹, kinds; row C, W, b; the ball's V_J and ρ_s) with the rows' terms enumerated independently of the shader;
 *  the bound tol + (it + 2)·8u·max_r Σ|A_rj y_j| (the f32 recursive residual's drift); discrimination: the τ unknowns'
 *  share of A·y and the ball's rank term, each ≥ 10 × the bound. Also the GPU's own diag and b against their f64
 *  recomputation (diag from the merged columns, b = Σ g·u* + vg·V* on the u* read back before the solve). */
export async function stokesK40(device: GPUDevice, o: { seed?: number; tol?: number; steps?: number } = {}) {
  const sc = await stokesScene(device, { seed: o.seed, tol: o.tol })
  const { gpu, sk, L } = sc
  const S = L.size, u = 2 ** -24, dt = gpu.dt, h = L.dx, nn = [L.nx, L.ny, L.nz]
  const faceType = new Uint32Array(await gpu.readBuffer(gpu.faceTypeBuf, 4 * 3 * S))
  const walls = [-1, -1, -1]
  const linOf = (c: number[]) => (c[0] + 1) + (L.nx + 2) * ((c[1] + 1) + (L.ny + 2) * (c[2] + 1))
  const resolve = (a: number, c0: number[]) => {
    const c = [...c0]
    let sign = 1
    for (let b = 0; b < 3; b++) { if (b === a) continue; if (c[b] === -1) { c[b] = 0; sign *= walls[b] } else if (c[b] === nn[b]) { c[b] = nn[b] - 1; sign *= walls[b] } }
    for (let b = 0; b < 3; b++) { const lo = b === a ? 0 : -1; if (c[b] < lo || c[b] > nn[b]) return null }
    const slot = a * S + L.idx(c[0], c[1], c[2])
    return faceType[slot] === 1 ? null : { slot, sign }
  }
  const unit = (a: number) => { const e = [0, 0, 0]; e[a] = 1; return e }
  const add = (x: number[], y: number[], s = 1) => x.map((v, i) => v + s * y[i])
  const terms = (kind: number, c: number[]): [number, number[], number][] => {
    if (kind === 0) return [0, 1, 2].flatMap(a => [[a, c, 1], [a, add(c, unit(a)), -1]] as [number, number[], number][])
    if (kind < 4) { const a = kind - 1; return [[a, add(c, unit(a)), 1], [a, c, -1]] }
    const e = kind - 4, a = (e + 1) % 3, b = (e + 2) % 3
    return [[a, c, 1], [a, add(c, unit(b), -1), -1], [b, c, 1], [b, add(c, unit(a), -1), -1]]
  }
  // the rows (storage index → kind, logical c), enumerated here independently of the shader's decoding
  const rowList: { r: number; kind: number; c: number[] }[] = []
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) for (let kd = 0; kd < 4; kd++) rowList.push({ r: 4 * linOf([i, j, k]) + kd, kind: kd, c: [i, j, k] })
  for (let e = 0; e < 3; e++) {
    const ext = [0, 1, 2].map(a => nn[a] + (a === e ? 0 : 1))
    for (let k = 0; k < ext[2]; k++) for (let j = 0; j < ext[1]; j++) for (let i = 0; i < ext[0]; i++) rowList.push({ r: 4 * S + e * S + L.idx(i, j, k), kind: 4 + e, c: [i, j, k] })
  }
  const steps: Record<string, unknown>[] = []
  for (let step = 0; step < (o.steps ?? 2); step++) {
    await submit(device, e => { gpu.writeParams(); gpu.syncStokes(); gpu.encodeSphereStart(e); gpu.encodeDensityCorrection(e); gpu.encodeScatter(e); gpu.encodeGridUpdate(e); gpu.encodePressureLabels(e); gpu.encodeFillLiquidFaces(e); gpu.encodeExtrapolate(e) })
    const uStar = (await gpu.readGrid(0)).u
    const sph0 = new Float32Array(await gpu.readBuffer(gpu.sphereBuf, 64))
    await submit(device, e => { gpu.viscositySolver!.encodePrepare(e); sk.encode(e) })
    const st = await sk.readStats(), sys = await sk.readSystem()
    const sph1 = new Float32Array(await gpu.readBuffer(gpu.sphereBuf, 64))
    await submit(device, e => { gpu.encodeExtrapolate(e); gpu.encodeG2P(e); gpu.encodePresent(e) })
    const F = sys.face, Rw = sys.row, y = sys.y
    const kv = dt * h ** 3 / (sph0[8] * sph0[12])
    const Vs = [sph0[4], sph0[5], sph0[6]]
    // per live row: its terms (slot, k = coef·sign·W/dx, axis) on faces of kind 1 (unknown) or 2 (V-only)
    type T = { slot: number; k: number; a: number }
    const live: { r: number; C: number; b: number; ts: T[] }[] = []
    let freeHit = 0, diagRatio = 0, bRatio = 0
    for (const R0 of rowList) {
      const d = Rw[4 * R0.r + 1]
      if (!(d > 0)) continue
      const C = Rw[4 * R0.r], W = Rw[4 * R0.r + 2], b = Rw[4 * R0.r + 3]
      const ts: T[] = []
      for (const [a, c, coef] of terms(R0.kind, R0.c)) {
        const fr = resolve(a, c)
        if (!fr) continue
        const kind = Math.round(F[4 * fr.slot + 3])
        if (kind === 3) freeHit++
        if (kind === 1 || kind === 2) ts.push({ slot: fr.slot, k: coef * fr.sign * W / h, a })
      }
      live.push({ r: R0.r, C, b, ts })
      // the GPU's diag and b against f64 from its own coefficients (bound: f32 of ≤ 10 accumulated terms)
      const merged = new Map<number, number>(), vg = [0, 0, 0]
      let bJs = 0, bAbs = 0
      for (const t of ts) {
        const g = F[4 * t.slot], gv = F[4 * t.slot + 1]
        if (Math.round(F[4 * t.slot + 3]) === 1) { merged.set(t.slot, (merged.get(t.slot) ?? 0) + t.k * g); bJs += t.k * g * uStar[t.slot]; bAbs += Math.abs(t.k * g * uStar[t.slot]) }
        vg[t.a] += t.k * gv
      }
      let dJs = C + (vg[0] ** 2 + vg[1] ** 2 + vg[2] ** 2) * kv, dAbs = Math.abs(dJs)
      for (const [s, g] of merged) { dJs += g * g * F[4 * s + 2]; dAbs += g * g * F[4 * s + 2] }
      bJs += vg[0] * Vs[0] + vg[1] * Vs[1] + vg[2] * Vs[2]; bAbs += Math.abs(vg[0] * Vs[0]) + Math.abs(vg[1] * Vs[1]) + Math.abs(vg[2] * Vs[2])
      diagRatio = Math.max(diagRatio, Math.abs(d - dJs) / (8 * u * (ts.length + 4) * dAbs + 1e-30))
      bRatio = Math.max(bRatio, Math.abs(b - bJs) / (8 * u * (ts.length + 4) * bAbs + 1e-30))
    }
    // A·y in f64 (and |A|·|y|, the τ unknowns' share, the rank part)
    const apply = (yv: (r: number) => number, abs: boolean) => {
      const t = new Float64Array(3 * S), btV = [0, 0, 0]
      for (const R0 of live) { const v = yv(R0.r); if (v === 0) continue; for (const tm of R0.ts) { const kk = abs ? Math.abs(tm.k) : tm.k; t[tm.slot] += kk * v; btV[tm.a] += kk * F[4 * tm.slot + 1] * v } }
      const out = new Map<number, { total: number; rank: number }>()
      for (const R0 of live) {
        let s = (abs ? Math.abs(R0.C) : R0.C) * yv(R0.r), rank = 0
        for (const tm of R0.ts) {
          const kk = abs ? Math.abs(tm.k) : tm.k, g = F[4 * tm.slot], gv = F[4 * tm.slot + 1]
          s += kk * g * F[4 * tm.slot + 2] * g * t[tm.slot]
          const rv = kk * gv * kv * btV[tm.a]
          s += rv; rank += rv
        }
        out.set(R0.r, { total: s, rank })
      }
      return out
    }
    const Ay = apply(r => y[r], false), mag = apply(r => Math.abs(y[r]), true)
    const tauRow = new Set<number>()
    for (const R0 of rowList) if (R0.kind !== 0) tauRow.add(R0.r)
    const Atau = apply(r => (tauRow.has(r) ? y[r] : 0), false)
    let resInf = 0, magMax = 0, tauInf = 0, rankInf = 0, bInf = 0
    for (const R0 of live) {
      const a = Ay.get(R0.r)!
      resInf = Math.max(resInf, Math.abs(R0.b - a.total)); rankInf = Math.max(rankInf, Math.abs(a.rank))
      magMax = Math.max(magMax, mag.get(R0.r)!.total); tauInf = Math.max(tauInf, Math.abs(Atau.get(R0.r)!.total)); bInf = Math.max(bInf, Math.abs(R0.b))
    }
    const bound = sk.tol + (st.iterations + 2) * 8 * u * magMax
    steps.push({ step, rows: live.length, freeHit, iterations: st.iterations, converged: st.converged, breakdown: st.breakdown, gpuRinf: st.residualInf, gpuR0: st.residualInf0,
      resInf, bound, ratio: resInf / bound, tauInf, tauDisc: tauInf / bound, rankInf, rankDisc: rankInf / bound, bInf, magMax, diagRatio, bRatio,
      vStar: Vs, vNew: [sph1[4], sph1[5], sph1[6]], force: [sph1[9], sph1[10], sph1[11]] })
  }
  gpu.destroy()
  return { particles: sc.particles, tol: sk.tol, steps }
}
