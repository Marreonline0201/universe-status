/// <reference types="@webgpu/types" />
// S3.1c-2 on the GPU (flip-selftest.html): the drop-ball kernels against the f64 reference on identical inputs
// (K21–K25), then the s31c2-ref physics scenes on the GPU path at the page's production settings. Metrics only —
// scripts/fluid-gates/s31c2-gpu.mjs applies the tolerances (the same measurement definitions as s31c2-ref.mjs).
import { GridLayout, FaceType, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, CellLabel, makeParticles, type RefParticles } from '../../sim-ref/flipRef'
import { fillMaterials, mulberry32 as mb32 } from '../../sim-ref/twoLayer'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { SOLID_REFERENCE } from '../../composition/materialData'
import { DX, RHO, L_REF, TAU, f32round, toInit, submit, solverConfig, capFor } from './util'
import { lsW, phiOf, phiTol, thetaOf } from './ghost'

const G = 9.80665
const GRAV: Vec3 = [0, -G, 0]
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))
/** common.wgsl fixed-point scales of the force reduction. */
const FORCE_SCALE = 1024, SOLID_SCALE = 1048576

/** A pool of 8-ppc water (twoLayer.fillMaterials, the reference gate's fill) with the particles inside the sphere
 *  removed; positions and masses rounded to f32 so both sides start bit-identical. */
export function pool(n: Vec3, depth: number, c: Vec3, R: number, seed: number): RefParticles {
  const { p } = fillMaterials(n[0], depth, n[2], DX, mb32(seed), () => [RHO, 0])
  const keep: number[] = []
  for (let q = 0; q < p.n; q++) if (Math.hypot(p.pos[3 * q] - c[0], p.pos[3 * q + 1] - c[1], p.pos[3 * q + 2] - c[2]) >= R) keep.push(q)
  const out = makeParticles(keep.length)
  keep.forEach((q, i) => { out.pos.set(p.pos.subarray(3 * q, 3 * q + 3), 3 * i); out.mass[i] = Math.fround(p.mass[q]) })
  f32round(out)
  return out
}

// ── K21–K25 kernel parity ────────────────────────────────────────────────────────────────────────────────────────

/** A pool 8 cells deep with a sphere (R = 3·dx) straddling its surface and moving, so every sphere path runs: partial
 *  and fully solid faces, the label extension, ghost faces next to the ball, the −JᵀV flux, the force. */
export async function sphereKernels(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; seed?: number }) {
  const n = o.n ?? [16, 16, 16], ring = o.ring ?? [0, 0, 0], dt = 1 / 120
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const R = 3 * DX
  const ctr: Vec3 = [Math.fround((n[0] / 2 + 0.3) * DX), Math.fround(7.2 * DX), Math.fround((n[2] / 2 - 0.3) * DX)]
  const V: Vec3 = [Math.fround(0.1), Math.fround(-0.2), Math.fround(0.05)]
  const p = pool(n, 8, ctr, R, o.seed ?? 41)
  const cpu = new FlipRef(L, { gravity: GRAV, density: RHO, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-9, psiTolerance: 1e-9 })
  cpu.sphere = { center: [...ctr] as Vec3, radius: R, velocity: [...V] as Vec3 }
  const gpu = await FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: DX, ring, gravity: GRAV, maxParticles: p.n, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, pressureTolerance: 1e-2, pressureCap: capFor(400), solverMethod: solverConfig.method,
    densityProjection: true, psiTolerance: 1e-3, psiCap: capFor(400), freeSurface: 'ghost',
  })
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  gpu.setSphere({ center: ctr, radius: R, velocity: V, density: 0 })   // scripted: parity never integrates
  const S = L.size, pc = gpu.solver!.paddedCount
  const out: Record<string, unknown> = { n, ring, particles: p.n }

  // K21 solid fractions (faces, cells, cell kernel volume). Bound, fixed before the first run: each subsample's f32
  // |x − c| errs by ≤ 4 ulp of the window extent, and the clamp's slope is 1/(dx/2) → ε = 4·ulp(ext)/(dx/2) per
  // subsample; a box average and the unit-integral kernel both stay within ε.
  cpu.sphereFractions()
  await submit(device, e => gpu.encodeSphereFractions(e))
  const fsG = new Float32Array(await gpu.readBuffer(gpu.faceSolidBuf, 4 * 3 * S))
  const csG = new Float32Array(await gpu.readBuffer(gpu.cellSolidBuf!, 8 * pc))
  const ext = Math.max(...L.extent), ulp = 2 ** (Math.floor(Math.log2(ext)) - 23), eps21 = 4 * ulp / (DX / 2)
  let faceDiff = 0, cellDiff = 0, kernDiff = 0, solidFaces = 0, fullFaces = 0
  for (const ax of [0, 1, 2] as const) for (let s = 0; s < S; s++) {
    const ref = cpu.solidFraction[ax][s]
    faceDiff = Math.max(faceDiff, Math.abs(fsG[ax * S + s] - ref))
    if (ref > 0) solidFaces++
    if (ref >= 1) fullFaces++
  }
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const c = L.idx(i, j, k), li = lin(L, i, j, k)
    cellDiff = Math.max(cellDiff, Math.abs(csG[2 * li] - cpu.cellSolidFraction[c]))
    kernDiff = Math.max(kernDiff, Math.abs(csG[2 * li + 1] - cpu.cellSolidKernel[c]))
  }
  out.k21 = { eps: eps21, faceRatio: faceDiff / eps21, cellRatio: cellDiff / eps21, kernelRatio: kernDiff / eps21, solidFaces, fullFaces }

  // K22 labels with the liquid extended into the ball, and the weighted operator coefficients. Labels may differ only
  // where a φ lies within its sample bound of 0 (K15's rule, own or a face-neighbour's). a_f·w_f against f64 from the
  // GPU's own faceSolid, |Δ| ≤ 1e-6·a; the extra diagonal recomputed in f64 from the GPU's φ, labels and weights,
  // |Δ| ≤ 1e-5·(extra + a) (K16's bound).
  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); cpu.classifyLevelSet(p); cpu.extendLiquidIntoSphere()
  await submit(device, e => { gpu.encodeScatter(e); gpu.encodeGridUpdate(e); gpu.encodePressureLabels(e) })
  const labG = await gpu.solver!.readLabels(0)
  const phiG = new Float32Array(await gpu.readBuffer(gpu.phiCellBuf!, 4 * pc))
  const cellSums = new Int32Array(await gpu.readBuffer(gpu.lsCellBuf!, 32 * pc))
  const faceSums = new Int32Array(await gpu.readBuffer(gpu.lsFaceBuf!, 32 * 3 * S))
  const coefG = new Float32Array(await gpu.readBuffer(gpu.solver!.buffers.faceCoef, 16 * pc))
  const inWin = (c: number[]) => c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < n[0] && c[1] < n[1] && c[2] < n[2]
  let labelMismatch = 0, nearZero = 0, extended = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k), li = lin(L, i, j, k), want = cpu.label[s] === CellLabel.LIQUID ? 1 : 0
    if (want && cpu.levelSet[s] >= 0 && cpu.cellSolidFraction[s] >= 0.5) extended++
    if (labG[li] === want) continue
    let near = Math.abs(cpu.levelSet[s]) <= phiTol(lsW(cellSums, 8 * li), DX)
    for (const [di, dj, dk] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) {
      const m = [i + di, j + dj, k + dk]
      if (near || !inWin(m)) continue
      near = Math.abs(cpu.levelSet[L.idx(m[0], m[1], m[2])]) <= phiTol(lsW(cellSums, 8 * lin(L, m[0], m[1], m[2])), DX)
    }
    if (near) nearZero++; else labelMismatch++
  }
  const a = dt / (RHO * DX * DX), Rls = DX, rbar = DX / 4
  const wOf = (ax: number, c: number[]) => Math.max(0, 1 - fsG[ax * S + L.idx(c[0], c[1], c[2])])
  let aRatio = 0, extraRatio = 0, weightedFaces = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const li = lin(L, i, j, k)
    for (const ax of [0, 1, 2]) {
      const w = wOf(ax, [i, j, k])
      if (w < 1) weightedFaces++
      aRatio = Math.max(aRatio, Math.abs(coefG[4 * li + ax] - a * w) / (1e-6 * a))
    }
    if (labG[li] !== 1) continue
    let extra = 0
    for (const ax of [0, 1, 2] as const) for (const side of [0, 1]) {
      const c = [i, j, k]; c[ax] += side ? 1 : -1
      if (!inWin(c) || labG[lin(L, c[0], c[1], c[2])] !== 0) continue
      const f = [i, j, k]; f[ax] += side
      const fmG = phiOf(faceSums, 8 * (ax * S + L.idx(f[0], f[1], f[2])), DX, Rls, rbar)
      const th = thetaOf(phiG[li], fmG, phiG[lin(L, c[0], c[1], c[2])], gpu.thetaMin)
      extra += a * wOf(ax, f) * (1 - th) / th
    }
    extraRatio = Math.max(extraRatio, Math.abs(coefG[4 * li + 3] - extra) / (1e-5 * (extra + a)))
  }
  out.k22 = { labelMismatch, nearZero, extended, aRatio, extraRatio, weightedFaces }

  // K23 divergence with the ball's flux (1 − S)u* + S·V on the reference's u* and valid flags. Bound: f32 of each face
  // flux (≤ 2^-23 relative of |u| + |V|, 6 faces) over dx, plus the K21 fraction error times |u − V|: fixed before the
  // first run as 1e-5·(max|b| + (max|u| + |V|)/dx).
  cpu.solvePressure(dt)
  const u3 = new Float32Array(3 * S), v3 = new Uint32Array(3 * S)
  for (const ax of [0, 1, 2]) { u3.set(cpu.u[ax], ax * S); for (let s = 0; s < S; s++) v3[ax * S + s] = cpu.valid[ax][s] }
  gpu.writeGrid(0, { u: u3, valid: v3 })
  await submit(device, e => gpu.encodeDivergence(e))
  const rhsBuf = new Float32Array(await gpu.readBuffer(gpu.solver!.buffers.rhs, 4 * pc))
  let bRef = 0, uMax = 0, divDiff = 0, rows = 0
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) uMax = Math.max(uMax, Math.abs(cpu.u[ax][s]))
  for (let s = 0; s < S; s++) bRef = Math.max(bRef, Math.abs(cpu.rhs[s]))
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.rhs[s] === 0 && cpu.label[s] !== CellLabel.LIQUID) continue
    if (labG[lin(L, i, j, k)] !== 1 || cpu.label[s] !== CellLabel.LIQUID) continue
    divDiff = Math.max(divDiff, Math.abs(rhsBuf[lin(L, i, j, k)] - cpu.rhs[s])); rows++
  }
  const vMag = Math.hypot(...V)
  out.k23 = { rows, divRatio: divDiff / (1e-5 * (bRef + (uMax + vMag) / DX)), bRef }

  // K24 projection with unweighted coefficients, S ≥ 1 faces = V, and the force: the reference pressure (f32-rounded)
  // in the solver vector, AIR cells poisoned with 1e5 Pa. (a) faces not on the liquid–air interface: |Δu| ≤ 1e-5·max|u|
  // (K17); (b) faces with S ≥ 1: u = V exactly; (c) F vs the reference's J·p on the same pressure: fixed-point rounding
  // ≤ ½/FORCE_SCALE per solid face plus f32 of each term (2^-22 relative of Σ|term|); V_J: ½/SOLID_SCALE per y face
  // plus the K21 bound per y face (·dx³).
  const pPad = new Float32Array(pc).fill(1e5)
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] === CellLabel.LIQUID) pPad[lin(L, i, j, k)] = cpu.pressure[s]
  }
  gpu.solver!.writeSolution(pPad)
  for (let s = 0; s < S; s++) cpu.pressure[s] = Math.fround(cpu.pressure[s])
  cpu.projectVelocities(dt)
  await submit(device, e => gpu.encodeProject(e))
  const g24 = await gpu.readGrid(0)
  const st = await gpu.readSphere()
  const labAt = (c: number[]) => (inWin(c) ? labG[lin(L, c[0], c[1], c[2])] : 2)
  let bulkDiff = 0, fullDiff = 0, fullCount = 0, surfaceFaces = 0, termSum = 0, forceFaces = 0, yFaces = 0
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k), cp = [i, j, k], cm = [i, j, k]; cm[ax] -= 1
      const Sf = cpu.solidFraction[ax][s]
      if (Sf > 0) {
        if (ax === 1) yFaces++
        const lp = labAt(cp), lm = labAt(cm)
        const pp = lp === 1 ? cpu.pressure[L.idx(cp[0], cp[1], cp[2])] : 0, pm = lm === 1 ? cpu.pressure[L.idx(cm[0], cm[1], cm[2])] : 0
        termSum += Math.abs(Sf * DX * DX * (pp - pm)); forceFaces++
      }
      if (cpu.faceType[ax][s] === FaceType.SOLID) continue
      if (Sf >= 1) { fullDiff = Math.max(fullDiff, Math.abs(g24.u[ax * S + s] - V[ax])); fullCount++; continue }
      const lp = labAt(cp), lm = labAt(cm)
      if ((lp === 1 && lm === 0) || (lp === 0 && lm === 1)) { surfaceFaces++; continue }
      bulkDiff = Math.max(bulkDiff, Math.abs(g24.u[ax * S + s] - cpu.u[ax][s]))
    }
  }
  const Fref = cpu.sphereForce, vJref = cpu.sphereVolumeJ()
  const fBound = forceFaces * 0.5 / FORCE_SCALE + 2 ** -22 * termSum
  const vBound = (yFaces * (0.5 / SOLID_SCALE + eps21)) * DX ** 3
  out.k24 = {
    uMax, bulkRatio: bulkDiff / (1e-5 * uMax), fullDiff, fullCount, surfaceFaces,
    force: st.force, forceRef: Fref, forceRatio: Math.max(...[0, 1, 2].map(ax => Math.abs(st.force[ax] - Fref[ax]))) / fBound,
    volumeJ: st.volumeJ, volumeJRef: vJref, volumeRatio: Math.abs(st.volumeJ - vJref) / vBound,
  }

  // K25 the density right-hand side with the ball: f̃ = f + f_solid + (ball kernel volume); the air-neighbour flag only
  // across faces with 1 − S_f > 0. Compared as K11 on the same particles: |Δf̃|, |Δb| ≤ K11's 2e-6 plus the K21 bound.
  cpu.densityCorrect(p)
  await submit(device, e => { gpu.encodeLabels(e); gpu.encodeCellScatter(e); gpu.encodeDensityRhs(e) })
  const fcG = new Float32Array(await gpu.readBuffer(gpu.fCompBuf!, 4 * gpu.psiSolver!.paddedCount))
  const bG = new Float32Array(await gpu.readBuffer(gpu.psiSolver!.buffers.rhs, 4 * gpu.psiSolver!.paddedCount))
  const labD = await gpu.solver!.readLabels(0)
  let fDiff = 0, bDiff = 0, dRows = 0, ballRows = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k), li = lin(L, i, j, k)
    if (cpu.densityLabel[s] !== CellLabel.LIQUID || labD[li] !== 1) continue
    fDiff = Math.max(fDiff, Math.abs(fcG[li] - cpu.fCompensated[s]))
    bDiff = Math.max(bDiff, Math.abs(bG[li] - cpu.psiRhs[s]))
    dRows++
    if (cpu.cellSolidKernel[s] > 0) ballRows++
  }
  const eps25 = 2e-6 + eps21
  out.k25 = { rows: dRows, ballRows, fRatio: fDiff / eps25, bRatio: bDiff / eps25 }

  // K25w the ψ operator's face weights (psiCoef, added 2026-09-30: the S3.1c-2 mutant "ψ operator without the
  // fluid-fraction weights" had only ever been "caught" by crashing, and survived once it ran): w_a = max(0, 1 − S_f) on
  // each window cell's −x, −y, −z face. Bitwise against the kernel's own f32 formula from the GPU's faceSolid (one
  // correctly rounded subtraction on both sides), and against the reference operator's weight 1 − S_f
  // (flipRef.liquidSystem) within K21's bound + one rounding; ≥ 1 partly solid face (else the check has no teeth).
  await submit(device, e => gpu.encodePsiCoef(e))
  const pwG = new Float32Array(await gpu.readBuffer(gpu.psiSolver!.buffers.faceCoef, 16 * pc))
  let wMismatch = 0, wRefDiff = 0, cutFaces = 0
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k), li = lin(L, i, j, k)
    for (const ax of [0, 1, 2] as const) {
      const fs = fsG[ax * S + s], got = pwG[4 * li + ax]
      if (got !== Math.max(0, Math.fround(1 - fs))) wMismatch++
      wRefDiff = Math.max(wRefDiff, Math.abs(got - Math.max(0, 1 - cpu.solidFraction[ax][s])))
      if (fs > 0 && fs < 1) cutFaces++
    }
  }
  out.k25w = { wMismatch, refRatio: wRefDiff / (eps21 + 2 ** -24), cutFaces }
  const d = await gpu.readDiagnostics()
  out.diag = { unsetDivergenceFaces: d.unsetDivergenceFaces, unsetDivergenceFacesRef: cpu.diag.unsetDivergenceFaces }
  gpu.destroy()
  return out
}

// ── physics on the GPU path (s31c2-ref scenes) ──────────────────────────────────────────────────────────────────

const NX = 16, NY = 28, NZ = 16, DEPTH = 18, RB = 3 * DX, VP = DX ** 3 / 8
const C0: Vec3 = [8.3 * DX, 9.4 * DX, 7.7 * DX]

/** The page's production settings (FlipBackend.create): ghost surface, density projection, variable density, the
 *  default MGPCG cap/tolerances — nothing generous. */
async function prodSim(device: GPUDevice, count: number) {
  return FlipGpuSimulator.create(device, {
    nx: NX, ny: NY, nz: NZ, dx: DX, gravity: GRAV, maxParticles: count, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO, densityProjection: true, freeSurface: 'ghost', variableDensity: true, solverMethod: solverConfig.method,
  })
}

/** φ-volume of the last density RHS, liquid only: Σ over the density labels' LIQUID cells of max(0, min(f̃, 1) − S_cell)
 *  plus min(f, 1) elsewhere (flipRef.phiVolume). */
async function liquidVolume(device: GPUDevice, gpu: FlipGpuSimulator) {
  await submit(device, e => { gpu.writeParams(); gpu.encodeLabels(e); gpu.encodeCellScatter(e); gpu.encodeDensityRhs(e) })
  const L = gpu.layout, pc = gpu.psiSolver!.paddedCount
  const fc = new Float32Array(await gpu.readBuffer(gpu.fCompBuf!, 4 * pc))
  const cs = new Float32Array(await gpu.readBuffer(gpu.cellSolidBuf!, 8 * pc))
  const lab = await gpu.solver!.readLabels(0)
  let v = 0
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
    const li = lin(L, i, j, k)
    v += lab[li] === 1 ? Math.max(0, Math.min(fc[li], 1) - cs[2 * li]) : Math.min(fc[li], 1)
  }
  return v * L.dx ** 3
}

async function insideCount(gpu: FlipGpuSimulator, n: number) {
  const [r, sp] = await Promise.all([gpu.readParticles(), gpu.readSphere()])
  // f32 positions: the push-out lands on R + wallEps up to f32 rounding of |x − c| (≤ 4 ulp of the extent)
  const tol = 4 * 2 ** (Math.floor(Math.log2(Math.max(...gpu.layout.extent))) - 23)
  let inside = 0
  for (let q = 0; q < n; q++) if (Math.hypot(r.pos[4 * q] - sp.center[0], r.pos[4 * q + 1] - sp.center[1], r.pos[4 * q + 2] - sp.center[2]) < sp.radius - tol) inside++
  return { inside, r, sp }
}

export async function spherePhysics(device: GPUDevice, o: { test: 'AR' | 'MV' | 'WK' | 'FS' }) {
  const dt = 1 / 120
  if (o.test === 'AR') {   // AR + ST: a fixed sphere in a still pool, 2 s
    const p = pool([NX, NY, NZ], DEPTH, C0, RB, 11)
    const gpu = await prodSim(device, p.n)
    gpu.dt = dt; gpu.setParticles(toInit(p))
    gpu.setSphere({ center: C0, radius: RB, velocity: [0, 0, 0], density: 0 })
    for (let s = 0; s < 240; s++) await submit(device, e => gpu.step(e, 1))
    const sp = await gpu.readSphere(), r = await gpu.readParticles(), d = await gpu.readDiagnostics()
    let v2 = 0
    for (let q = 0; q < p.n; q++) v2 += r.vel[4 * q] ** 2 + r.vel[4 * q + 1] ** 2 + r.vel[4 * q + 2] ** 2
    gpu.destroy()
    return { particles: p.n, force: sp.force, volumeJ: sp.volumeJ, sphereVolume: 4 / 3 * Math.PI * RB ** 3, rms: Math.sqrt(v2 / p.n), capHits: d.capHits, solves: d.solves, psiCapHits: d.psiCapHits, pushOuts: d.spherePushOuts }
  }
  if (o.test === 'MV') {   // a scripted sphere at 0.3 m/s through the pool for 1 s
    const c: Vec3 = [5 * DX, 9.4 * DX, 7.7 * DX], V: Vec3 = [0.3, 0, 0]
    const p = pool([NX, NY, NZ], DEPTH, c, RB, 12)
    const gpu = await prodSim(device, p.n)
    gpu.dt = dt; gpu.setParticles(toInit(p))
    gpu.setSphere({ center: c, radius: RB, velocity: V, density: 0 })
    let worstInside = 0, worstDiv = 0
    for (let s = 0; s < 120; s++) {
      await submit(device, e => gpu.step(e, 1))
      worstInside += (await insideCount(gpu, p.n)).inside
      if (s % 12 === 11) worstDiv = Math.max(worstDiv, await fluxDivergence(gpu))
    }
    const vol = await liquidVolume(device, gpu) / (p.n * VP)
    const d = await gpu.readDiagnostics()
    gpu.destroy()
    return { particles: p.n, inside: worstInside, maxFluxDivergence: worstDiv, tolerance: gpu.pressureTolerance, volume: vol, capHits: d.capHits, solves: d.solves, pushOuts: d.spherePushOuts }
  }
  if (o.test === 'WK') {   // weak two-way coupling, ρ_s 7850 from rest in the settled pool
    const p = pool([NX, NY, NZ], DEPTH, C0, RB, 13)
    const gpu = await prodSim(device, p.n)
    gpu.dt = dt; gpu.setParticles(toInit(p))
    gpu.setSphere({ center: C0, radius: RB, velocity: [0, 0, 0], density: 0 })
    for (let s = 0; s < 120; s++) await submit(device, e => gpu.step(e, 1))
    gpu.setSphere({ center: C0, radius: RB, velocity: [0, 0, 0], density: 7850 })
    const ts: number[] = [], vy: number[] = []
    for (let s = 1; s * dt <= 0.2 + 1e-9; s++) {
      await submit(device, e => gpu.step(e, 1))
      const sp = await gpu.readSphere()
      ts.push(s * dt); vy.push(sp.velocity[1])
    }
    const d = await gpu.readDiagnostics()
    gpu.destroy()
    return { ts, vy, capHits: d.capHits, solves: d.solves }
  }
  // FS: the page's case — an iron ball dropped 3·dx onto the pool, through the surface onto the floor, 2 s
  const rhoIron = SOLID_REFERENCE.iron.solidDensityKgM3!
  const c: Vec3 = [8.3 * DX, (DEPTH + 3) * DX + RB, 7.7 * DX]
  const p = pool([NX, NY, NZ], DEPTH, [0, -10, 0], RB, 14)
  const gpu = await prodSim(device, p.n)
  gpu.dt = dt; gpu.setParticles(toInit(p))
  gpu.setSphere({ center: c, radius: RB, velocity: [0, 0, 0], density: rhoIron })
  let sp0 = await gpu.readSphere()
  // the ball's mass for the energy: ρ_s·V_J at the start (V_J from one fraction pass)
  await submit(device, e => { gpu.writeParams(); gpu.encodeSphereFractions(e) })
  const fs0 = new Float32Array(await gpu.readBuffer(gpu.faceSolidBuf, 4 * 3 * gpu.layout.size))
  let sy = 0
  for (let s = gpu.layout.size; s < 2 * gpu.layout.size; s++) sy += fs0[s]
  const mBall = rhoIron * sy * DX ** 3
  const energy = (pos: Float32Array, vel: Float32Array, sp: typeof sp0) => {
    let e = mBall * (0.5 * (sp.velocity[0] ** 2 + sp.velocity[1] ** 2 + sp.velocity[2] ** 2) + G * sp.center[1])
    for (let q = 0; q < p.n; q++) e += p.mass[q] * (0.5 * (vel[4 * q] ** 2 + vel[4 * q + 1] ** 2 + vel[4 * q + 2] ** 2) + G * pos[4 * q + 1])
    return e
  }
  let r0 = await gpu.readParticles()
  const E0 = energy(r0.pos, r0.vel, sp0)
  let inside = 0, worstVol = 0, dEp = 0, maxRise = -Infinity, tFloor = NaN, vMax = 0, restOk = true, maxParticleSpeed = 0, minClearance = Infinity
  const nvp = p.n * VP
  for (let s = 1; s * dt <= 2 + 1e-9; s++) {
    // the density correction's ΔE_P (S3.2 INV′): positions before and after it, within this substep
    const before = (await gpu.readParticles()).pos
    await submit(device, e => { gpu.writeParams(); gpu.encodeSphereStart(e); gpu.encodeDensityCorrection(e) })
    const after = (await gpu.readParticles()).pos
    for (let q = 0; q < p.n; q++) dEp += p.mass[q] * G * (after[4 * q + 1] - before[4 * q + 1])
    await submit(device, e => { gpu.encodeSubstepBody(e); gpu.encodePresent(e) })
    const ic = await insideCount(gpu, p.n)
    inside += ic.inside
    for (let q = 0; q < p.n; q++) maxParticleSpeed = Math.max(maxParticleSpeed, Math.hypot(ic.r.vel[4 * q], ic.r.vel[4 * q + 1], ic.r.vel[4 * q + 2]))
    if (s % 12 === 0) worstVol = Math.max(worstVol, Math.abs(await liquidVolume(device, gpu) / nvp - 1))
    maxRise = Math.max(maxRise, (energy(ic.r.pos, ic.r.vel, ic.sp) - dEp - E0) / E0)
    vMax = Math.max(vMax, Math.hypot(...ic.sp.velocity))
    minClearance = Math.min(minClearance, ic.sp.center[1] - RB)
    const onFloor = ic.sp.center[1] - RB <= 0.01 * DX
    if (onFloor && Number.isNaN(tFloor)) tFloor = s * dt
    if (s * dt > 1.5 && !onFloor) restOk = false
    sp0 = ic.sp
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { particles: p.n, rhoIron, inside, worstVol, capHits: d.capHits, solves: d.solves, psiCapHits: d.psiCapHits, psiSolves: d.psiSolves, breakdowns: d.breakdowns + d.psiBreakdowns,
    maxRise, tFloor, restOk, vMax, maxParticleSpeed, minClearance, pushOuts: d.spherePushOuts, wallClamps: d.wallClamps }
}

/** max |∇·((1 − S)u + S·V)| over the pressure solve's LIQUID cells after the last projection, 1/s. */
async function fluxDivergence(gpu: FlipGpuSimulator) {
  const L = gpu.layout, S = L.size
  const g = await gpu.readGrid(0)
  const fs = new Float32Array(await gpu.readBuffer(gpu.faceSolidBuf, 4 * 3 * S))
  const lab = await gpu.solver!.readLabels(0)
  const sp = await gpu.readSphere()
  let worst = 0
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) for (let i = 0; i < L.nx; i++) {
    if (lab[lin(L, i, j, k)] !== 1) continue
    let div = 0
    for (const ax of [0, 1, 2] as const) for (const side of [0, 1]) {
      const f = [i, j, k]; f[ax] += side
      const s = ax * S + L.idx(f[0], f[1], f[2]), Sf = fs[s]
      const flux = (1 - Sf) * g.u[s] + Sf * sp.velocity[ax]
      div += side ? flux : -flux
    }
    worst = Math.max(worst, Math.abs(div) / L.dx)
  }
  return worst
}
