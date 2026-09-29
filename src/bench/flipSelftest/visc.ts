/// <reference types="@webgpu/types" />
// S3.6 on the GPU (flip-selftest.html): the viscous solve against the f64 reference on identical inputs (K26–K29), then
// the s36-ref physics scenes on the GPU path at production settings. Metrics only — scripts/fluid-gates/s36-gpu.mjs
// applies the tolerances (the same measurement definitions as s36-ref.mjs).
import { GridLayout, type Vec3 } from '../../sim-ref/gridLayout'
import { FlipRef, makeParticles, kineticEnergy, type RefParticles } from '../../sim-ref/flipRef'
import { FlipGpuSimulator } from '../../gpu-sim/flip/FlipGpuSimulator'
import { DX, L_REF, TAU, f32round, toInit, submit, solverConfig, capFor, mulberry32 } from './util'
import { lsW, phiOf, phiTol } from './ghost'

const G = 9.80665
const lin = (L: GridLayout, i: number, j: number, k: number) => (i + 1) + (L.nx + 2) * ((j + 1) + (L.ny + 2) * (k + 1))
export const HONEY = { mu: 40, rho: 1415 }
export const LAVA = { mu: 10 ** (-4.55 + 5963 / (1200 + 273.15 - 600.7)), rho: 2600 }
const WATER = { mu: 1.001596e-3, rho: 998.2072 }

function fill(lo: Vec3, hi: Vec3, rho: number, mu: number, rng: () => number, h = DX): RefParticles {
  const pts: number[][] = []
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
    for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
  const p = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length).fill(mu)
  const m = Math.fround(rho * h ** 3 / 8)
  pts.forEach((x, q) => { p.pos.set(x.map(Math.fround), 3 * q); p.mass[q] = m })
  return p
}

async function makeViscSim(device: GPUDevice, n: Vec3, count: number, m: { rho: number; mu: number }, o: { gravity?: Vec3; ring?: Vec3; production?: boolean; h?: number; density?: boolean } = {}) {
  const gpu = await FlipGpuSimulator.create(device, {
    nx: n[0], ny: n[1], nz: n[2], dx: o.h ?? DX, ring: o.ring, gravity: o.gravity ?? [0, -G, 0], maxParticles: count, lRef: L_REF, tauS: TAU,
    projection: true, density: m.rho, densityProjection: o.density ?? true, freeSurface: 'ghost', solverMethod: solverConfig.method, viscosity: true,
    ...(o.production ? {} : { pressureTolerance: 1e-4, pressureCap: capFor(400), psiTolerance: 1e-4, psiCap: capFor(400) }),
  })
  gpu.viscositySolver!.setMuTable(new Float32Array([m.mu]))
  gpu.viscositySolver!.muDefault = m.mu
  return gpu
}

// ── K26–K29 ──

/** Per-sample bound on |μ_GPU/μ_ref − 1| (viscosity.wgsl muMinScatter/muScatter/muAt against flipRef.viscousMu,
 *  harmonic), one array per family (cells, then edges along x, y, z), from the reference's taps mirrored in f64.
 *  One-material samples: μ_GPU = f32(μ) exactly (the ratio and the quotient are 1 where their operands are equal) → 2^-24.
 *  Mixed samples: the GPU's trilinear weight errs by Δ_i ≤ δt·(w_y w_z + w_x w_z + w_x w_y) + 2·2^-24·w_i, δt ≤ 3·ulp(n)
 *  (x/dx divides to 2.5 ulp, x − ½ rounds by ½ ulp, t = f − ⌊f⌋ is exact); each term of M = Σw·μ_min/μ_i by a further
 *  6·2^-24 relative (the ratio to 2.5 ulp, the product ½ ulp); the fixed-point sums W = Σw and M by ≤ N·2^-43 each
 *  (common.wgsl). With H = Σw/μ_i = M/μ_min and μ = W/H, μ'/μ − 1 = (δW·H − W·δH)/(W·H'), so
 *  |μ'/μ − 1| ≤ [Σ Δ_i·|1 − μ/μ_i| + 6·2^-24·W + N·2^-43·(1 + W/M)] / (W·(1 − h)), h = Σ(Δ_i/μ_i)/H + 6·2^-24 + N·2^-43/M,
 *  then the quotient W/M (5·2^-24), μ_min·(W/M) and f32(μ_min) (2^-24 each). A sample no particle reaches, or whose Σw
 *  is below the fixed point's resolution, takes the default μ on the GPU. */
function muBounds(L: GridLayout, p: RefParticles, muDefault: number) {
  const u = 2 ** -24, q43 = 2 ** -43, h = L.dx, n = [L.nx, L.ny, L.nz]
  const dT = 3 * 2 ** (Math.floor(Math.log2(Math.max(...n))) - 23)
  let mixed = 0
  const out: Float64Array[] = []
  for (let F = 0; F < 4; F++) {
    const o = [0, 1, 2].map(a => (F === 0 || a === F - 1 ? 0.5 : 0)), ext = [0, 1, 2].map(a => n[a] + (F === 0 || a === F - 1 ? 0 : 1))
    const S = L.size, W = new Float64Array(S), H = new Float64Array(S), N = new Float64Array(S), E = new Float64Array(S), D = new Float64Array(S)
    const muLo = new Float64Array(S).fill(Infinity), muHi = new Float64Array(S)
    const taps = (q: number, f: (s: number, w: number, dw: number, mu: number) => void) => {
      const mu = p.mu![q], x = [0, 1, 2].map(a => p.pos[3 * q + a] / h - o[a]), b = x.map(Math.floor), t = x.map((v, a) => v - b[a])
      for (let k = 0; k < 8; k++) {
        const d = [k & 1, (k >> 1) & 1, (k >> 2) & 1], c = b.map((v, a) => v + d[a])
        if (c.some((v, a) => v < 0 || v >= ext[a])) continue
        const wv = d.map((dd, a) => (dd ? t[a] : 1 - t[a])), w = wv[0] * wv[1] * wv[2]
        if (w > 0) f(L.idx(c[0], c[1], c[2]), w, dT * (wv[1] * wv[2] + wv[0] * wv[2] + wv[0] * wv[1]) + 2 * u * w, mu)
      }
    }
    for (let q = 0; q < p.n; q++) taps(q, (s, w, _dw, mu) => { W[s] += w; H[s] += w / mu; N[s]++; muLo[s] = Math.min(muLo[s], mu); muHi[s] = Math.max(muHi[s], mu) })
    for (let q = 0; q < p.n; q++) taps(q, (s, _w, dw, mu) => { E[s] += dw * Math.abs(1 - W[s] / H[s] / mu); D[s] += dw / mu })
    const B = new Float64Array(S).fill(u)
    for (let s = 0; s < S; s++) {
      if (N[s] === 0) continue
      const mu = W[s] / H[s], M = muLo[s] * H[s]
      if (W[s] < 4 * N[s] * q43) { B[s] = Math.abs(muDefault / mu - 1) + 2 * u; continue }
      if (muLo[s] === muHi[s]) continue
      mixed++
      const hh = D[s] / H[s] + 6 * u + N[s] * q43 / M
      B[s] = (E[s] + 6 * u * W[s] + N[s] * q43 * (1 + W[s] / M)) / (W[s] * (1 - hh)) + 7 * u
    }
    out.push(B)
  }
  return { B: out, mixed }
}

/** A 16×16×8 pool 8 cells deep with a random, then projected, velocity field; honey (or lava); no-slip walls.
 *  `mixed`: water (μ 1.0e-3 Pa·s, contrast 4e4 to honey) above y = 4 cells — the harmonic μ at mixed samples; the
 *  density stays the base material's (the kernels under test are the viscous ones). */
export async function viscKernels(device: GPUDevice, o: { n?: Vec3; ring?: Vec3; seed?: number; walls?: 'no-slip' | 'free-slip'; material?: 'honey' | 'lava'; full?: boolean; mixed?: boolean }) {
  const n = o.n ?? [16, 16, 8], ring = o.ring ?? [0, 0, 0], dt = 1 / 120, m = o.material === 'lava' ? LAVA : HONEY, walls = o.walls ?? 'no-slip'
  const L = new GridLayout({ nx: n[0], ny: n[1], nz: n[2], dx: DX, ring })
  const rng = mulberry32(o.seed ?? 91)
  const p = fill([0, 0, 0], [n[0] - 1, o.full ? n[1] - 1 : 7, n[2] - 1], m.rho, m.mu, rng)
  for (let q = 0; q < p.n; q++) p.vel.set([0.2 * (rng() - 0.5), 0.2 * (rng() - 0.5), 0.2 * (rng() - 0.5)], 3 * q)
  f32round(p)
  if (o.mixed) for (let q = 0; q < p.n; q++) if (p.pos[3 * q + 1] >= 4 * DX) p.mu![q] = WATER.mu
  const cpu = new FlipRef(L, { gravity: [0, -G, 0], density: m.rho, projection: true, freeSurface: 'ghost', pressureTolerance: 1e-9,
    viscosity: 'force', viscosityDefault: m.mu, viscosityTolerance: 1e-12, viscousWalls: walls })
  const gpu = await makeViscSim(device, n, p.n, m, { ring })
  gpu.dt = dt
  if (o.mixed) gpu.viscositySolver!.setMuTable(new Float32Array([m.mu, WATER.mu]))
  gpu.setParticles(toInit(p).map((x, q) => ({ ...x, composition: p.mu![q] === m.mu ? 0 : 1 })))
  gpu.writeParams()
  // the reference's viscous input: projected and extrapolated u*
  cpu.p2g(p); cpu.gridUpdate(dt); cpu.applySolidFaces(); cpu.classifyLevelSet(p); cpu.fillUnsetLiquidFaces()
  cpu.solvePressure(dt); cpu.projectVelocities(dt); cpu.extrapolate(); cpu.applySolidFaces()
  const S = L.size, u3 = new Float32Array(3 * S), v3 = new Uint32Array(3 * S)
  for (const ax of [0, 1, 2]) { u3.set(cpu.u[ax], ax * S); for (let s = 0; s < S; s++) v3[ax * S + s] = cpu.valid[ax][s] }
  const uStar = [0, 1, 2].map(ax => Float64Array.from(cpu.u[ax], v => Math.fround(v)))
  for (const ax of [0, 1, 2]) cpu.u[ax].set(uStar[ax])
  // GPU: its own labels and coefficients from the same particles, then the reference's u* in buffer A
  await submit(device, e => { gpu.encodeScatter(e); gpu.encodeGridUpdate(e); gpu.encodePressureLabels(e) })
  await submit(device, e => e.copyBufferToBuffer(gpu.solver!.buffers.faceCoef, 0, gpu.faceCoefRawBuf!, 0, 16 * gpu.solver!.paddedCount))
  gpu.writeGrid(0, { u: u3, valid: v3 })
  const vs = gpu.viscositySolver!
  vs.tol = 1e-6; vs.cap = 400
  vs.walls = walls === 'no-slip' ? [-1, -1, -1] : [1, 1, 1]
  cpu.viscositySolve(p, dt)
  await submit(device, e => vs.encode(e))
  const st = await vs.readStats()
  const B = vs.bufs, pc = gpu.solver!.paddedCount
  const volFace = new Float32Array(await gpu.readBuffer(B.volFace, 4 * 3 * S)), volCell = new Float32Array(await gpu.readBuffer(B.volCell, 4 * pc)), volEdge = new Float32Array(await gpu.readBuffer(B.volEdge, 4 * 3 * S))
  const latSums = new Int32Array(await gpu.readBuffer(B.latSums, 4 * 64 * pc))
  const wCell = new Float32Array(await gpu.readBuffer(B.wCell, 4 * pc)), wEdge = new Float32Array(await gpu.readBuffer(B.wEdge, 4 * 3 * S))
  const kind = new Uint32Array(await gpu.readBuffer(B.kind, 4 * 3 * S))
  const g = await gpu.readGrid(0)
  const out: Record<string, unknown> = { n, ring, particles: p.n, gpuIterations: st.iterations, gpuConverged: st.converged, gpuRel: st.relResidual, cpu: cpu.lastViscosity }

  // K26 volumes: per sample, the bound is the largest of its 8 subsamples' φ bounds (K15's phiTol from the GPU's own
  // lattice sums) × 2/dx (the smooth step's slope), where that subsample is inside the step's ramp (else 0).
  const subBound = (x: number, y: number, z: number) => {
    const ext = L.extent, mir = (v: number, e: number) => (v < 0 ? -v : v > e ? 2 * e - v : v)
    const px = mir(x, ext[0]), py = mir(y, ext[1]), pz = mir(z, ext[2])
    const nn = [px, py, pz].map((v, a) => Math.min(2 * n[a] - 1, Math.max(0, Math.floor(v / (0.5 * DX)))))
    const c = nn.map(v => v >> 1), s = nn.map((v, a) => v - 2 * c[a])
    const base = 8 * (8 * lin(L, c[0], c[1], c[2]) + s[0] + 2 * s[1] + 4 * s[2])
    return 2 * phiTol(lsW(latSums, base), DX, Math.max(...ext)) / DX
  }
  const bound = (cx: number, cy: number, cz: number) => {
    let b = 1e-6
    for (const ox of [-0.25, 0.25]) for (const oy of [-0.25, 0.25]) for (const oz of [-0.25, 0.25]) b = Math.max(b, subBound((cx + ox) * DX, (cy + oy) * DX, (cz + oz) * DX) / 8)
    return b * 8   // the eight subsample bounds add; the max·8 is their upper bound
  }
  let volRatio = 0, surfaceSamples = 0
  for (const ax of [0, 1, 2] as const) {
    const [lo, hi] = L.faceRange(ax)
    for (let k = Math.max(0, lo[2]); k <= hi[2]; k++) for (let j = Math.max(0, lo[1]); j <= hi[1]; j++) for (let i = Math.max(0, lo[0]); i <= hi[0]; i++) {
      if (i > n[0] || j > n[1] || k > n[2]) continue
      const s = L.idx(i, j, k), ref = cpu.volFace[ax][s], d = Math.abs(volFace[ax * S + s] - ref)
      if (ref > 0 && ref < 1) surfaceSamples++
      if (d > 0) volRatio = Math.max(volRatio, d / bound(i + (ax === 0 ? 0 : 0.5), j + (ax === 1 ? 0 : 0.5), k + (ax === 2 ? 0 : 0.5)))
    }
  }
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const d = Math.abs(volCell[lin(L, i, j, k)] - cpu.volCell[L.idx(i, j, k)])
    if (d > 0) volRatio = Math.max(volRatio, d / bound(i + 0.5, j + 0.5, k + 0.5))
  }
  for (const e of [0, 1, 2] as const) {
    const ext = [n[0] + (e === 0 ? 0 : 1), n[1] + (e === 1 ? 0 : 1), n[2] + (e === 2 ? 0 : 1)]
    for (let k = 0; k < ext[2]; k++) for (let j = 0; j < ext[1]; j++) for (let i = 0; i < ext[0]; i++) {
      const s = L.idx(i, j, k), d = Math.abs(volEdge[e * S + s] - cpu.volEdge[e][s])
      if (d > 0) volRatio = Math.max(volRatio, d / bound(i + (e === 0 ? 0.5 : 0), j + (e === 1 ? 0.5 : 0), k + (e === 2 ? 0.5 : 0)))
    }
  }
  out.k26 = { volRatio, surfaceSamples }

  // K27 the sample viscosity: w = 2μV (cells), μV (edges) on the GPU's own volumes, so μ_GPU = w/(c·V_GPU) (f32
  // product: one more 2^-24) against μ_ref within the sample's bound B (muBounds); w = 0 where V_GPU = 0. (The volumes
  // are K26's: a w-level check with the measured |ΔV| in its bound sat at ratio ≈ 1 by construction.)
  const mb = muBounds(L, p, m.mu)
  let wRatio = 0, wWorst: Record<string, number> = {}, mixedRatio = 0, mixedBMax = 0
  const k27 = (cc: number, mu: number, B: number, vg: number, _vc: number, wg: number, at: number, kind: number) => {
    const r = vg > 0 ? Math.abs(wg / (cc * vg) - mu) / (mu * (B + 2 ** -24) * (1 + B)) : wg === 0 ? 0 : Infinity
    if (B > 2 ** -24 && vg > 0) { mixedRatio = Math.max(mixedRatio, r); mixedBMax = Math.max(mixedBMax, B) }
    if (r > wRatio) { wRatio = r; wWorst = { kind, at, mu, B, vg, wg, muGpu: vg > 0 ? wg / (cc * vg) : 0 } }
  }
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const c = L.idx(i, j, k), li = lin(L, i, j, k)
    k27(2, cpu.muCell[c], mb.B[0][c], volCell[li], cpu.volCell[c], wCell[li], c, -1)
  }
  for (const e of [0, 1, 2] as const) {
    const ext = [n[0] + (e === 0 ? 0 : 1), n[1] + (e === 1 ? 0 : 1), n[2] + (e === 2 ? 0 : 1)]
    for (let k = 0; k < ext[2]; k++) for (let j = 0; j < ext[1]; j++) for (let i = 0; i < ext[0]; i++) {
      const s = L.idx(i, j, k)
      k27(1, cpu.muEdge[e][s], mb.B[e + 1][s], volEdge[e * S + s], cpu.volEdge[e][s], wEdge[e * S + s], s, e)
    }
  }
  out.k27 = { wRatio, mixedSamples: mb.mixed, mixedRatio, mixedBMax, worst: wWorst }

  // K28 the unknown set: GPU kind 1 vs the reference's unknown faces (the reference marks them valid and writes them);
  // a mismatch is excused only where the face's own or a sample's volume differs across 0 within its bound
  // (faces with V_f > 0 are unknowns by rule 1 on both sides and must agree exactly; the mass-less auxiliary unknowns —
  // faces met only by a positive-volume sample — may differ where a sample volume is 0 on one side and within its bound
  // above 0 on the other: counted, excused)
  let unknownsGpu = 0, written = 0, mismatch = 0, nearZero = 0, worst = { d: 0, ax: -1, s: -1, vg: 0, vc: 0, ug: 0, uc: 0, us: 0 }
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) {
    if (kind[ax * S + s] === 1) unknownsGpu++
    const g1 = kind[ax * S + s] === 1 && volFace[ax * S + s] > 0, c1 = cpu.viscWritten[ax][s] === 1
    if (c1) written++
    if (g1 !== c1) { if (Math.min(volFace[ax * S + s], cpu.volFace[ax][s]) <= 1e-3) nearZero++; else mismatch++ }
  }
  out.k28 = { unknownsGpu, unknownsRef: cpu.lastViscosity?.unknowns ?? -1, written, mismatch, nearZero }

  // K29 the solved velocity on every GPU unknown vs the reference: |Δu| ≤ 1e-3·max|u*| (an iterative f32 solve to
  // 1e-6 relative, on volumes that differ within the K26 bound)
  let uMax = 0, uDiff = 0
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) uMax = Math.max(uMax, Math.abs(uStar[ax][s]))
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) if (kind[ax * S + s] === 1 && volFace[ax * S + s] > 0 && cpu.viscWritten[ax][s] === 1) {
    const d = Math.abs(g.u[ax * S + s] - cpu.u[ax][s])
    if (d > uDiff) { uDiff = d; worst = { d, ax, s, vg: volFace[ax * S + s], vc: cpu.volFace[ax][s], ug: g.u[ax * S + s], uc: cpu.u[ax][s], us: uStar[ax][s] } }
  }
  // the mass-less auxiliary unknowns (kind 1, V_f = 0) carry the free surface's zero traction inside the solve and are
  // not written back (flipRef: viscWritten only where V_f > 0): u stays u*, bit for bit
  let massless = 0, masslessChanged = 0
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) if (kind[ax * S + s] === 1 && volFace[ax * S + s] === 0) {
    massless++
    if (g.u[ax * S + s] !== uStar[ax][s]) masslessChanged++
  }
  const wc = worst.s >= 0 ? cpuCoords(L, worst.s) : null
  let subs: unknown[] = []
  if (wc) {
    const ax = worst.ax, o = [ax === 0 ? 0 : 0.5, ax === 1 ? 0 : 0.5, ax === 2 ? 0 : 0.5]
    for (const ox of [-0.25, 0.25]) for (const oy of [-0.25, 0.25]) for (const oz of [-0.25, 0.25]) {
      const x = (wc[0] + o[0] + ox) * DX, y = (wc[1] + o[1] + oy) * DX, z = (wc[2] + o[2] + oz) * DX
      const nn = [x, y, z].map((v, a) => Math.min(2 * n[a] - 1, Math.max(0, Math.floor(v / (0.5 * DX)))))
      const c = nn.map(v => v >> 1), sb = nn.map((v, a) => v - 2 * c[a])
      const base = 8 * (8 * lin(L, c[0], c[1], c[2]) + sb[0] + 2 * sb[1] + 4 * sb[2])
      const gphi = phiOf(latSums, base, DX, DX, DX / 4)
      subs.push({ at: [x, y, z].map(v => +(v / DX).toFixed(3)), cpu: +(cpu.zhuBridson(x, y, z) / DX).toFixed(4), gpu: +(gphi / DX).toFixed(4), w: lsW(latSums, base) })
    }
  }
  out.k29 = { uMax, uRatio: uDiff / (1e-3 * uMax), change: maxChange(uStar, cpu.u, S), massless, masslessChanged, worst, worstCoords: wc, subs }
  gpu.destroy()
  return out
}
/** Logical coordinates of a window slot (diagnostics). */
function cpuCoords(L: GridLayout, slot: number) {
  const px = L.nx + 2, py = L.ny + 2, pi = slot % px, pj = Math.floor(slot / px) % py, pk = Math.floor(slot / (px * py))
  const inv = (ph: number, n: number, ring: number) => (ph === 0 ? -1 : ph === n + 1 ? n : ((ph - 1 - ring) % n + n) % n)
  return [inv(pi, L.nx, L.ring[0]), inv(pj, L.ny, L.ring[1]), inv(pk, L.nz, L.ring[2])]
}
/** Largest |u − u*| the reference's viscous step made (so K29 is not passing on a no-op). */
function maxChange(a: Float64Array[], b: Float64Array[], S: number) {
  let m = 0
  for (const ax of [0, 1, 2]) for (let s = 0; s < S; s++) m = Math.max(m, Math.abs(a[ax][s] - b[ax][s]))
  return m
}

// ── physics (s36-ref scenes) ──

/** S3.6a Taylor–Green in a closed free-slip box, L cells, viscosity on/off; returns ν_eff from the amplitude fit. */
export async function viscTaylorGreen(device: GPUDevice, o: { cells: number; material: 'honey' | 'lava'; on: boolean; tight?: boolean; density?: boolean }) {
  const m = o.material === 'honey' ? HONEY : LAVA, cells = o.cells
  const p = fill([0, 0, 0], [cells - 1, cells - 1, 3], m.rho, m.mu, mulberry32(60 + cells))
  const k = Math.PI / (cells * DX), A0 = 0.05
  const shape = (x: number, y: number) => [Math.sin(k * x) * Math.cos(k * y), -Math.cos(k * x) * Math.sin(k * y)]
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1], [su, sv] = shape(x, y)
    p.vel.set([A0 * su, A0 * sv, 0], 3 * q)
    p.c[0].set([A0 * k * Math.cos(k * x) * Math.cos(k * y), -A0 * k * Math.sin(k * x) * Math.sin(k * y), 0], 3 * q)
    p.c[1].set([A0 * k * Math.sin(k * x) * Math.sin(k * y), -A0 * k * Math.cos(k * x) * Math.cos(k * y), 0], 3 * q)
  }
  f32round(p)
  const gpu = await makeViscSim(device, [cells, cells, 4], p.n, m, { gravity: [0, 0, 0], production: !o.tight, density: o.density })
  gpu.viscositySolver!.walls = [1, 1, 1]
  gpu.viscosityActive = o.on
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const nu = m.mu / m.rho, T = Math.min(0.5, 1.5 / (2 * nu * k * k)), ts: number[] = [], ys: number[] = []
  for (let s = 1; s * gpu.dt <= T + 1e-9; s++) {
    await submit(device, e => gpu.step(e, 1))
    const r = await gpu.readParticles()
    let num = 0, den = 0
    for (let q = 0; q < p.n; q++) { const [su, sv] = shape(r.pos[4 * q], r.pos[4 * q + 1]); num += p.mass[q] * (r.vel[4 * q] * su + r.vel[4 * q + 1] * sv); den += p.mass[q] * (su * su + sv * sv) }
    ts.push(s * gpu.dt); ys.push(Math.log(Math.abs(num / den) / A0))
  }
  const st = o.on ? await gpu.viscositySolver!.readStats() : null, d = await gpu.readDiagnostics()
  gpu.destroy()
  const tm = ts.reduce((a, b) => a + b, 0) / ts.length, ym = ys.reduce((a, b) => a + b, 0) / ys.length
  let sxy = 0, sxx = 0
  for (let i = 0; i < ts.length; i++) { sxy += (ts[i] - tm) * (ys[i] - ym); sxx += (ts[i] - tm) ** 2 }
  return { nuEff: -(sxy / sxx) / (2 * k * k), nu, steps: ts.length, viscIterations: st?.iterations ?? 0, viscConverged: st?.converged ?? true, capHits: d.capHits, solves: d.solves, breakdowns: d.breakdowns, psiBreakdowns: d.psiBreakdowns, ys }
}

/** The D1 standing wave with a material: E_K series (s34-ref / s36-ref standingWave on the GPU). */
export async function viscStandingWave(device: GPUDevice, o: { cellsPerH: number; material: 'water' | 'lava'; on: boolean; walls: 'no-slip' | 'free-slip'; periods: number; production?: boolean }) {
  const m = o.material === 'lava' ? LAVA : WATER
  const Lphys = 56 * DX, Hphys = 28 * DX, h = Hphys / o.cellsPerH
  const nx = Math.round(Lphys / h), nh = o.cellsPerH, ny = 2 * Math.ceil(1.5 * nh / 2)
  const p = fill([0, 0, 0], [nx - 1, nh - 1, 7], m.rho, m.mu, mulberry32(50 + o.cellsPerH), h)
  const k = 2 * Math.PI / Lphys, omega = Math.sqrt(G * k * Math.tanh(k * Hphys)), eps = 0.05
  const A = eps * Hphys * G / (2 * omega) / Math.cosh(k * Hphys)
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q], y = p.pos[3 * q + 1], ch = Math.cosh(k * y), sh = Math.sinh(k * y), sx = Math.sin(k * x), cx = Math.cos(k * x)
    p.vel.set([A * k * ch * sx, -A * k * sh * cx, 0], 3 * q)
    p.c[0].set([A * k * k * ch * cx, A * k * k * sh * sx, 0], 3 * q)
    p.c[1].set([A * k * k * sh * sx, -A * k * k * ch * cx, 0], 3 * q)
  }
  f32round(p)
  const gpu = await makeViscSim(device, [nx, ny, 8], p.n, m, { production: o.production ?? true, h })
  const wsgn = o.walls === 'no-slip' ? -1 : 1
  gpu.viscositySolver!.walls = [wsgn, wsgn, wsgn]
  gpu.viscosityActive = o.on
  gpu.dt = (1 / 120) * (h / DX)
  gpu.setParticles(toInit(p))
  const T = o.periods * Math.PI / omega, ts = [0], es = [kineticEnergy(p)]
  for (let s = 1; s * gpu.dt <= T + 1e-9; s++) {
    await submit(device, e => gpu.step(e, 1))
    const r = await gpu.readParticles()
    let e = 0
    for (let q = 0; q < p.n; q++) e += 0.5 * p.mass[q] * (r.vel[4 * q] ** 2 + r.vel[4 * q + 1] ** 2 + r.vel[4 * q + 2] ** 2)
    ts.push(s * gpu.dt); es.push(e)
  }
  const st = o.on ? await gpu.viscositySolver!.readStats() : null, d = await gpu.readDiagnostics()
  gpu.destroy()
  return { ts, es, omega, k, H: Hphys, particles: p.n, viscIterations: st?.iterations ?? 0, capHits: d.capHits, solves: d.solves }
}

/** S3.6d Huppert viscous gravity current, lava, no-slip floor, z free-slip. */
export async function viscHuppert(device: GPUDevice) {
  const m = LAVA
  const p = fill([0, 0, 0], [8, 16, 7], m.rho, m.mu, mulberry32(80))
  f32round(p)
  const gpu = await makeViscSim(device, [64, 24, 8], p.n, m, { production: true })
  gpu.viscositySolver!.walls = [-1, -1, 1]
  gpu.viscosityActive = true
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const A = p.n * DX ** 3 / 8 / (8 * DX), nu = m.mu / m.rho
  const front = (pos: Float32Array) => {
    const cnt = new Int32Array(64)
    for (let q = 0; q < p.n; q++) cnt[Math.min(63, Math.floor(pos[4 * q] / DX))]++
    for (let i = 63; i >= 0; i--) if (cnt[i] >= 0.5 * 8 * 8) return (i + 1) * DX
    return 0
  }
  const ts: number[] = [], xs: number[] = [], at: Record<number, number> = {}
  for (let s = 1; s * gpu.dt <= 10 + 1e-9; s++) {
    await submit(device, e => gpu.step(e, 1))
    const t = s * gpu.dt
    if (s % 12 === 0 || [2, 5, 10].some(T => Math.abs(t - T) < 1e-9)) {
      const x = front((await gpu.readParticles()).pos)
      if (s % 12 === 0) { ts.push(t); xs.push(x) }
      for (const T of [2, 5, 10]) if (Math.abs(t - T) < 1e-9) at[T] = x
    }
  }
  const st = await gpu.viscositySolver!.readStats(), d = await gpu.readDiagnostics()
  gpu.destroy()
  return { A, nu, ts, xs, at, viscIterations: st.iterations, capHits: d.capHits, solves: d.solves }
}

/** The viscous path's cost at the page's production settings (hardware budget, recorded): an 88k-particle honey block
 *  in the 64³ tank. Wall time per submitted-and-completed unit (includes the submit round trip, same for every row):
 *  a whole substep with the viscous path on / off, the viscous solve alone at `caps`, and its setup up to each kernel
 *  (prefixMs). Every non-empty submit here carries a ~3 ms round-trip floor (measured: clears of 9–74 MB and an empty
 *  compute pass all read ~3 ms): compare rows, not absolute values. */
export async function viscCost(device: GPUDevice, o: { caps?: number[]; reps?: number } = {}) {
  const m = HONEY, reps = o.reps ?? 20
  const p = fill([18, 0, 18], [45, 13, 45], m.rho, m.mu, mulberry32(7))
  f32round(p)
  const gpu = await makeViscSim(device, [64, 64, 64], p.n, m, { production: true })
  gpu.viscosityActive = true
  gpu.dt = 1 / 120
  gpu.setParticles(toInit(p))
  const time = async (f: () => Promise<void>) => { const t0 = performance.now(); for (let r = 0; r < reps; r++) await f(); return (performance.now() - t0) / reps }
  for (let s = 0; s < 10; s++) await submit(device, e => gpu.step(e, 1))
  const stepOn = await time(() => submit(device, e => gpu.step(e, 1)))
  const its = (await gpu.viscositySolver!.readStats()).iterations
  gpu.viscosityActive = false
  const stepOff = await time(() => submit(device, e => gpu.step(e, 1)))
  gpu.viscosityActive = true
  await submit(device, e => gpu.step(e, 1))
  const vs = gpu.viscositySolver!, cap0 = vs.cap, solve: Record<number, number> = {}
  for (const c of o.caps ?? [60, 24, 12]) { vs.cap = c; solve[c] = await time(() => submit(device, e => { vs.encode(e) })) }
  vs.cap = cap0
  const prefix: Record<string, number> = {}
  for (const k of ['latScatter', 'bandCells', 'volumes', 'muMinScatter', 'muScatter', 'weights', 'kindSamples', 'diagonal', 'gatherMinus', 'reduceInit']) prefix[k] = await time(() => submit(device, e => { vs.encode(e, k) }))
  const empty = await time(() => submit(device, () => {}))
  gpu.destroy()
  return { particles: p.n, stepOnMs: stepOn, stepOffMs: stepOff, viscIterations: its, solveMsByCap: solve, prefixMs: prefix, emptySubmitMs: empty }
}

