/// <reference types="@webgpu/types" />
// S3.6e on the GPU (flip-selftest.html): the unified pressure–stress solve's pieces against the f64 reference on
// identical inputs (spec vault fluid/realism-2026-09/S3.6e-variational-stokes-spec.md §5). Metrics only —
// scripts/fluid-gates/s36e-gpu.mjs applies the criteria.
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, L_REF, TAU, toInit, submit, solverConfig, capFor } from './util'
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
