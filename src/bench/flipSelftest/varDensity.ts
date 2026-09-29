/// <reference types="@webgpu/types" />
// S3.5 on the GPU (flip-selftest.html): variable-density kernels against the f64 reference on identical inputs, then
// the S3.5 physics scenes on the GPU path. Fixtures and measurements come from src/sim-ref/twoLayer.ts — the same code
// scripts/fluid-gates/s35-ref.mjs runs — so the CPU and GPU scenes hold identical particles. Metrics only;
// scripts/fluid-gates/s35-gpu.mjs applies the tolerances.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, CellLabel, FACE_WEIGHT_MIN, kineticEnergy, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator, MASS_SCALE } from '../../gpu-sim/flip/FlipGpuSimulator'
import { G_STD, mulberry32, fillMaterials, lambTwoLayer, interfaceAmplitude, columnCounts, lockFront } from '../../sim-ref/twoLayer'
import { waterDensity, HG_RHO_20C, LIQUIDS } from '../../composition/materialData'
import { DX, L_REF, TAU, f32round, toInit, submit, solverConfig, capFor } from './util'
import { phiOf } from './ghost'

const GRAV: Vec3 = [0, -G_STD, 0]
const RHO_W20 = waterDensity(20), RHO_W10 = waterDensity(10), RHO_W90 = waterDensity(90), RHO_HG = HG_RHO_20C
const RHO_OIL = LIQUIDS['olive-oil'].density(20)
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))

async function makeSim(device: GPUDevice, n: Vec3, count: number, o: { h?: number; ring?: Vec3; tol?: number; density?: number } = {}) {
  return FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: o.h ?? DX, ring: o.ring, gravity: GRAV, maxParticles: count, lRef: L_REF, tauS: TAU,
    projection: true, density: o.density ?? RHO_W20, pressureTolerance: o.tol ?? 1e-2, pressureCap: capFor(400), solverMethod: solverConfig.method,
    densityProjection: true, psiTolerance: 1e-3, psiCap: capFor(400), freeSurface: 'ghost', variableDensity: true,
  })
}
const thetaOf = (fl: number, fm: number, fa: number, tMin: number) => (fl >= 0 ? tMin : Math.min(1, Math.max(tMin, fm >= 0 ? 0.5 * fl / (fl - fm) : 0.5 + 0.5 * fm / (fm - fa))))

/** Kernel parity on a two-material block (mercury in the lower-left, water elsewhere, sloped noisy top):
 *  K18 faceScatter Σw; K19 ghostCoef a_f = Δt/(ρ_f·dx²) from the face density (and the ghost extra with per-face a_f);
 *  K20 project with per-face a_f — each on identical inputs. */
export async function varKernels(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; seed?: number }) {
  const n = o.n ?? [16, 16, 16], ring = o.ring ?? [0, 0, 0], dt = 1 / 120
  const rng = mulberry32(o.seed ?? 41)
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const cpu = new FlipRef(L, { gravity: GRAV, density: RHO_W20, projection: true, freeSurface: 'ghost', variableDensity: true, pressureTolerance: 1e-9 })
  const nx = Math.min(n[0] - 3, 11), ny = Math.min(n[1] - 4, 9), nz = Math.min(n[2] - 2, 13)
  const { p: p0 } = fillMaterials(nx, ny, nz, DX, rng, (x, y) =>
    (y < (4 + 0.4 * x / DX + 1.5 * rng()) * DX ? (x < 0.5 * nx * DX && y < 0.6 * ny * DX ? [RHO_HG, 1] : [RHO_W20, 0]) : null))
  const p: RefParticles = p0
  for (let q = 0; q < p.n; q++) { p.pos[3 * q + 2] += DX; p.vel.set([rng() - 0.5, rng() - 0.5, rng() - 0.5], 3 * q) }   // off the z = 0 wall
  f32round(p)
  for (let q = 0; q < p.n; q++) p.mass[q] = Math.fround(p.mass[q])
  const gpu = await makeSim(device, n, p.n, { ring })
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  gpu.writeParams()
  const S = L.size, pc = gpu.solver!.paddedCount, R = DX, rbar = DX / 4
  const out: Record<string, unknown> = { n, ring, particles: p.n }

  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); cpu.classifyLevelSet(p)
  await submit(device, e => { gpu.encodeScatter(e); gpu.encodeGridUpdate(e); gpu.encodePressureLabels(e) })
  // K18 Σw on every face slot of the three grids: ≤ 64 adds of ≤ 2^-25 rounding each, plus f32 weights (1e-6 relative)
  const wG = new Int32Array(await gpu.readBuffer(gpu.weightBuf, 4 * 3 * S))
  let wRatio = 0, wMax = 0
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k), ref = cpu.weight[ax][s]
      wRatio = Math.max(wRatio, Math.abs(wG[ax * S + s] / MASS_SCALE - ref) / (64 * 2 ** -25 + 1e-6 * ref)); wMax = Math.max(wMax, ref)
    }
  }
  out.k18 = { wRatio, wMax }
  // K19 a_f on every window cell's −x, −y, −z face vs Δt/(ρ_f^ref·dx²). Per-face bound: the GPU's ρ_f = ρ_ref·ppc·m̂/Σw
  // errs through Σw by ≤ 64·2^-25/Σw relative (mass is two-word, negligible), + 2e-6 f32 arithmetic. Faces whose Σw lies
  // within that absolute error of the wMin threshold may legitimately take the other branch — counted, not compared.
  const coefG = new Float32Array(await gpu.readBuffer(gpu.solver!.buffers.faceCoef, 16 * pc))
  const labG = await gpu.solver!.readLabels(0)
  const phiG = new Float32Array(await gpu.readBuffer(gpu.phiCellBuf!, 4 * pc))
  const faceSums = new Int32Array(await gpu.readBuffer(gpu.lsFaceBuf!, 32 * 3 * S))
  const k0 = dt / (DX * DX)
  let aRatio = 0, nearThreshold = 0, faces = 0, rhoMin = Infinity, rhoMax = 0, extraRatio = 0, extraFaces = 0
  const aTol = (ax: number, s: number) => 64 * 2 ** -25 / Math.max(cpu.weight[ax][s], FACE_WEIGHT_MIN) + 2e-6
  const near = (ax: number, s: number) => Math.abs(cpu.weight[ax][s] - FACE_WEIGHT_MIN) <= 64 * 2 ** -25
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const li = lin(L, i, j, k)
    for (const ax of [0, 1, 2] as const) {
      const s = L.idx(i, j, k), ref = k0 / cpu.rhoFace[ax][s]
      if (near(ax, s)) { nearThreshold++; continue }
      aRatio = Math.max(aRatio, Math.abs(coefG[4 * li + ax] - ref) / (ref * aTol(ax, s))); faces++
      if (cpu.weight[ax][s] >= FACE_WEIGHT_MIN) { rhoMin = Math.min(rhoMin, cpu.rhoFace[ax][s]); rhoMax = Math.max(rhoMax, cpu.rhoFace[ax][s]) }
    }
    // the ghost extra diagonal in f64 from the GPU's own φ and labels, with the reference a_f of each face
    if (labG[li] !== 1) continue
    let extra = 0, tol = 0
    for (const ax of [0, 1, 2] as const) for (const side of [0, 1]) {
      const c = [i, j, k]; c[ax] += side ? 1 : -1
      if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= n[0] || c[1] >= n[1] || c[2] >= n[2]) continue
      const la = lin(L, c[0], c[1], c[2])
      if (labG[la] !== 0) continue
      const f = [i, j, k]; f[ax] += side
      const fs = L.idx(f[0], f[1], f[2]), a = k0 / cpu.rhoFace[ax][fs]
      const th = thetaOf(phiG[li], phiOf(faceSums, 8 * (ax * S + fs), DX, R, rbar), phiG[la], gpu.thetaMin)
      extra += a * (1 - th) / th; tol += (a * (1 - th) / th + a) * (aTol(ax, fs) + 1e-5); extraFaces++
    }
    extraRatio = Math.max(extraRatio, Math.abs(coefG[4 * li + 3] - extra) / Math.max(tol, 1e-30))
  }
  out.k19 = { aRatio, faces, nearThreshold, rhoMin, rhoMax, extraRatio, extraFaces }
  // K20 project: u*, valid flags and the reference pressure (AIR poisoned 1e5 Pa) into the GPU; every face with a LIQUID
  // side vs u* − a_f·dx·(p₊ − p₋) in f64 on the GPU's own a_f and θ (identical inputs) ≤ 1e-5·max(|u|, a_f·dx·|Δp|)
  cpu.solvePressure(dt)
  const u3 = new Float32Array(3 * S), v3 = new Uint32Array(3 * S)
  for (const ax of [0, 1, 2]) { u3.set(cpu.u[ax], ax * S); for (let s = 0; s < S; s++) v3[ax * S + s] = cpu.valid[ax][s] }
  gpu.writeGrid(0, { u: u3, valid: v3 })
  const pPad = new Float32Array(pc).fill(1e5)
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const s = L.idx(i, j, k)
    if (cpu.label[s] === CellLabel.LIQUID) pPad[lin(L, i, j, k)] = cpu.pressure[s]
  }
  gpu.solver!.writeSolution(pPad)
  await submit(device, e => gpu.encodeProject(e))
  const g20 = await gpu.readGrid(0)
  const inWin = (c: number[]) => c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < n[0] && c[1] < n[1] && c[2] < n[2]
  const labAt = (c: number[]) => (inWin(c) ? labG[lin(L, c[0], c[1], c[2])] : 2)
  let uRatio = 0, projFaces = 0, uRef = 0
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) uRef = Math.max(uRef, Math.abs(u3[ax * S + L.idx(i, j, k)]))
  }
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const s = L.idx(i, j, k), cp = [i, j, k], cm = [i, j, k]; cm[ax] -= 1
      if (cpu.faceType[ax][s] === 1) continue   // SOLID
      const lp = labAt(cp), lm = labAt(cm)
      if (lp !== 1 && lm !== 1) continue
      if (!inWin(cp)) continue
      const aG = coefG[4 * lin(L, i, j, k) + ax]
      const pv = (c: number[]) => pPad[lin(L, c[0], c[1], c[2])]
      const ghostOf = (cl: number[], ca: number[], face: number[]) => {
        const th = thetaOf(phiG[lin(L, cl[0], cl[1], cl[2])], phiOf(faceSums, 8 * (ax * S + L.idx(face[0], face[1], face[2])), DX, R, rbar), phiG[lin(L, ca[0], ca[1], ca[2])], gpu.thetaMin)
        return -((1 - th) / th) * pv(cl)
      }
      const pp = lp === 1 ? pv(cp) : lp === 0 ? ghostOf(cm, cp, cp) : 0
      const pm = lm === 1 ? pv(cm) : lm === 0 ? ghostOf(cp, cm, cp) : 0
      const du = aG * DX * (pp - pm), uExp = u3[ax * S + s] - du
      uRatio = Math.max(uRatio, Math.abs(g20.u[ax * S + s] - uExp) / (1e-5 * Math.max(uRef, Math.abs(du)))); projFaces++
    }
  }
  out.k20 = { uRatio, projFaces, uRef }
  gpu.destroy()
  return out
}

/** D: the A1 column as water and as mercury from identical particles; max particle position difference per sample. */
export async function densityCancels(device: GPUDevice) {
  const aC = 12, a = aC * DX, rows = 24
  const make = async (rho: number) => {
    const { p } = fillMaterials(aC, rows, 8, DX, mulberry32(60 + aC), () => [rho, 0])
    f32round(p)
    const sim = await makeSim(device, [128, rows + 8, 8], p.n, { tol: 1e-4, density: rho })
    sim.dt = 1 / 240
    sim.setParticles(toInit(p))
    return sim
  }
  const w = await make(RHO_W20), hg = await make(RHO_HG)
  const steps = Math.ceil(3.33 / Math.SQRT2 * Math.sqrt(a / G_STD) * 240)
  let worst = 0
  for (let s = 1; s <= steps; s++) {
    await submit(device, e => { w.step(e, 1); hg.step(e, 1) })
    const [pw, ph] = [(await w.readParticles()).pos, (await hg.readParticles()).pos]
    let m = 0
    for (let i = 0; i < pw.length; i++) if ((i & 3) !== 3) m = Math.max(m, Math.abs(pw[i] - ph[i]))
    worst = Math.max(worst, m / a)
  }
  const d = [await w.readDiagnostics(), await hg.readDiagnostics()]
  w.destroy(); hg.destroy()
  return { worst, steps, capHits: d.map(x => x.capHits), psiCapHits: d.map(x => x.psiCapHits), breakdowns: d.reduce((s, x) => s + x.breakdowns + x.psiBreakdowns, 0) }
}

/** F2: Hg 12 cells under water 12 cells at rest for 3 s; row-mean pressure of the interior columns. */
export async function twoLayerHydrostatic(device: GPUDevice) {
  const nx = 16, nz = 8, h1 = 12, h2 = 12
  const { p } = fillMaterials(nx, h1 + h2, nz, DX, mulberry32(73), (_x, y) => (y < h1 * DX ? [RHO_HG, 1] : [RHO_W20, 0]))
  f32round(p)
  const gpu = await makeSim(device, [nx, 32, nz], p.n, { tol: 1e-4 })
  gpu.setParticles(toInit(p))
  for (let s = 0; s < 360; s++) await submit(device, e => gpu.step(e, 1))
  const { pressure } = await gpu.readPressure(), L = gpu.layout
  const rows: number[] = []
  for (let j = 0; j < 32; j++) { let s = 0; for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) s += pressure[lin(L, i, j, k)]; rows.push(s / ((nz - 2) * (nx - 2))) }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { rows, dx: DX, h1, h2, rhoLower: RHO_HG, rhoUpper: RHO_W20, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** F3: pure interfacial eigenmode of Hg under water (14 + 14 cells at `scale`·dx), E_K every step. */
export async function interfacialWave(device: GPUDevice, o: { scale: number }) {
  const scale = o.scale, h = DX * scale, nx = 64 / scale, nL = 14 / scale, nz = 8 / scale, W = 64 * DX, k = 2 * Math.PI / W, depth = nL * h
  const modes = lambTwoLayer({ rhoLower: RHO_HG, rhoUpper: RHO_W20, hLower: depth, hUpper: depth, k })
  const m = modes[0], omega = Math.sqrt(m.omega2), a = 0.05 * depth, b = m.ratio * a
  const { p } = fillMaterials(nx, 2 * nL + 2, nz, h, mulberry32(80 + scale), (x, y) => {
    const yi = depth + a * Math.cos(k * x), ys = 2 * depth + b * Math.cos(k * x)
    return y < yi ? [RHO_HG, 1] : y < ys ? [RHO_W20, 0] : null
  })
  f32round(p)
  const ny = 2 * Math.ceil((2 * nL + 3 / scale + 1) / 2)
  const gpu = await makeSim(device, [nx, ny, nz], p.n, { h, tol: 1e-4 })
  const dt = (1 / 120) * scale
  gpu.dt = dt
  gpu.setParticles(toInit(p))
  const ek = (vel: Float32Array) => { let e = 0; for (let q = 0; q < p.n; q++) e += 0.5 * p.mass[q] * (vel[4 * q] ** 2 + vel[4 * q + 1] ** 2 + vel[4 * q + 2] ** 2); return e }
  const ts = [0], es = [ek((await gpu.readParticles()).vel)]
  const T = 3 * Math.PI / omega
  for (let s = 1; s * dt <= T + 1e-9; s++) { await submit(device, e => gpu.step(e, 1)); ts.push(s * dt); es.push(ek((await gpu.readParticles()).vel)) }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { omega, surfaceMode: Math.sqrt(modes[1].omega2), ratio: m.ratio, particles: p.n, ts, es, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** F4: Rayleigh–Taylor, Hg 14 cells over water 14 cells, growing eigenmode from rest; interface amplitude every step. */
export async function rayleighTaylor(device: GPUDevice) {
  const nx = 64, nL = 14, nz = 8, W = nx * DX, lam = W / 2, k = 2 * Math.PI / lam, depth = nL * DX
  const unstable = lambTwoLayer({ rhoLower: RHO_W20, rhoUpper: RHO_HG, hLower: depth, hUpper: depth, k }).find(r => r.omega2 < 0)!
  const sigma = Math.sqrt(-unstable.omega2), a = 0.03, b = unstable.ratio * a
  const { p, tag } = fillMaterials(nx, 2 * nL + 2, nz, DX, mulberry32(90), (x, y) => {
    const yi = depth + a * Math.cos(k * x), ys = 2 * depth + b * Math.cos(k * x)
    return y < yi ? [RHO_W20, 0] : y < ys ? [RHO_HG, 1] : null
  })
  f32round(p)
  const gpu = await makeSim(device, [nx, 34, nz], p.n, { tol: 1e-4 })
  gpu.dt = 1 / 240
  gpu.setParticles(toInit(p))
  const amp = (pos: Float32Array | Float64Array, stride: number) => { const c = columnCounts(pos, stride, tag, p.n, nx, 34, DX, 1); return interfaceAmplitude(c.upper, c.lower, nx, 34, DX, k).amplitude }
  const ts = [0], as = [amp(p.pos, 3)]
  for (let s = 1; s / 240 <= 1.0 && Math.abs(as[as.length - 1]) < 0.12 * lam; s++) {
    await submit(device, e => gpu.step(e, 1)); ts.push(s / 240); as.push(amp((await gpu.readParticles()).pos, 4))
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { sigma, lam, seeded: a, ts, as, particles: p.n, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** LX: lock exchange, water 10 °C | 90 °C, H = 18 cells; dense-front distance every step. */
export async function lockExchange(device: GPUDevice) {
  const nx = 64, nH = 18, nz = 8, lock = 32 * DX
  const { p, tag } = fillMaterials(nx, nH, nz, DX, mulberry32(95), x => (x < lock ? [RHO_W10, 1] : [RHO_W90, 0]))
  f32round(p)
  const gpu = await makeSim(device, [nx, 24, nz], p.n, { tol: 1e-4 })
  gpu.setParticles(toInit(p))
  const ts: number[] = [], xs: number[] = []
  for (let s = 1; s / 120 <= 6; s++) {
    await submit(device, e => gpu.step(e, 1)); ts.push(s / 120); xs.push(lockFront((await gpu.readParticles()).pos, 4, tag, p.n, nx, DX, 32))
  }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { ts, xs, H: nH * DX, rhoDense: RHO_W10, rhoLight: RHO_W90, particles: p.n, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns }
}

/** F1: inverted two-layer overturn (16×40×8, 12 + 12 cells); COMs over the last 2 s and the wrong-side count at the end. */
export async function overturn(device: GPUDevice, o: { pair: 'hg-water' | 'water-oil'; seconds: number }) {
  const [rhoHeavy, rhoLight, seed] = o.pair === 'hg-water' ? [RHO_HG, RHO_W20, 71] : [RHO_W20, RHO_OIL, 72]
  const nx = 16, nz = 8, h1 = 12, h2 = 12
  const { p, tag } = fillMaterials(nx, h1 + h2, nz, DX, mulberry32(seed), (_x, y) => (y < h1 * DX ? [rhoLight, 0] : [rhoHeavy, 1]))
  f32round(p)
  const gpu = await makeSim(device, [nx, 40, nz], p.n, { tol: 1e-4 })
  gpu.setParticles(toInit(p))
  const comH: number[] = [], comL: number[] = []
  let pos: Float32Array = new Float32Array(0)
  const steps = Math.round(o.seconds * 120)
  for (let s = 1; s <= steps; s++) {
    await submit(device, e => gpu.step(e, 1))
    if (s / 120 >= o.seconds - 2) {
      pos = (await gpu.readParticles()).pos
      let sh = 0, nh = 0, sl = 0, nl = 0
      for (let q = 0; q < p.n; q++) { if (tag[q]) { sh += pos[4 * q + 1]; nh++ } else { sl += pos[4 * q + 1]; nl++ } }
      comH.push(sh / nh / DX); comL.push(sl / nl / DX)
    }
  }
  let wrong = 0
  for (let q = 0; q < p.n; q++) { const y = pos[4 * q + 1] / DX; if (tag[q] ? y > h1 + 0.5 : y < h1 - 0.5) wrong++ }
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  return { comHeavy: mean(comH), comLight: mean(comL), h1, h2, wrongFraction: wrong / p.n, particles: p.n, capHits: d.capHits, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns,
    fallbacks: [d.densityNeighbourFaces, d.densityDefaultFaces] }
}

export { kineticEnergy }

/** Iteration demand of the pressure solve under density contrast (S3.5 on the page's settings): the FLUID TEST page's
 *  buoyancy scene — a 3-cell water pool over the 64² floor, an olive-oil block and a mercury block above it — on the
 *  production solver (ghost surface, density projection, MGPCG at ε_div = 1e-2) with pressure cap `cap`; `variable`
 *  false is the one-density control. */
export async function mixedCaps(device: GPUDevice, o: { cap: number; variable: boolean; seconds?: number; surface?: 'ghost' | 'voxel'; thetaMin?: number }) {
  const rng = mulberry32(12)
  const W = fillMaterials(64, 3, 64, DX, rng, () => [RHO_W20, 0]).p
  const box = (lo: Vec3, hi: Vec3, rho: number) => fillMaterials(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], DX, rng, () => [rho, 1]).p
  const parts = [W, box([18, 10, 18], [40, 16, 40], RHO_OIL), box([23, 21, 23], [35, 26, 35], RHO_HG)]
  const offsets: Vec3[] = [[0, 0, 0], [18 * DX, 10 * DX, 18 * DX], [23 * DX, 21 * DX, 23 * DX]]
  const init = parts.flatMap((p, k) => toInit(p).map(q => ({ ...q, pos: [q.pos[0] + offsets[k][0], q.pos[1] + offsets[k][1], q.pos[2] + offsets[k][2]] as Vec3 })))
  const gpu = await FlipGpuSimulator.create(device, {
    nx: 64, ny: 64, nz: 64, dx: DX, gravity: GRAV, maxParticles: init.length, lRef: L_REF, tauS: TAU,
    projection: true, density: RHO_W20, pressureTolerance: 1e-2, pressureCap: o.cap, solverMethod: 'mgpcg',
    densityProjection: true, psiTolerance: 1e-3, freeSurface: o.surface ?? 'ghost', variableDensity: o.variable, thetaMin: o.thetaMin,
  })
  gpu.dt = 1 / 120
  gpu.setParticles(init)
  const steps = Math.round((o.seconds ?? 4) * 120)
  const t0 = performance.now()
  for (let s = 0; s < steps; s++) await submit(device, e => gpu.step(e, 1))
  const wall = (performance.now() - t0) / steps
  const d = await gpu.readDiagnostics()
  gpu.destroy()
  return { particles: init.length, steps, solves: d.solves, capHits: d.capHits, maxIt: d.maxIterations, psiCapHits: d.psiCapHits, breakdowns: d.breakdowns + d.psiBreakdowns, msPerStep: wall }
}
