/// <reference types="@webgpu/types" />
// Anisotropic splats (owner decision 2026-09-29): the GPU kernel (fluid-render/AnisoKernel + shaders/ssfr_aniso.wgsl)
// against the research bench's reference mapping (vault fluid/realism-2026-09/calc/aniso/aniso_lib.py final2 with the
// recommended parameters, ported here in f64) on the bench's synthetic particle sets. The comparison is the ellipsoid
// matrix M = Σ_k a_k² v_k v_kᵀ (rotation-invariant: a degenerate eigen-direction may turn, M may not) and the volume
// factor; bound fixed before the first run: ‖M_gpu − M_ref‖_F ≤ 1e-3·‖M_ref‖_F (f32 sums over ~100 neighbours ≈ 1e-5
// relative, through a mapping of bounded slope: clamps, min/max, a cubic smoothstep).
import { AnisoKernel, ANISO } from '../../fluid-render/AnisoKernel'
import { mulberry32, submit } from './util'

type V3 = [number, number, number]

function jacobiEig(A: number[][]) {
  const a = A.map(r => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2
    if (off < 1e-300) break
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq }
    }
  }
  return [0, 1, 2].map(i => ({ l: Math.max(0, a[i][i]), v: [V[0][i], V[1][i], V[2][i]] as V3 })).sort((x, y) => y.l - x.l)
}
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

/** final2 (aniso_lib.py) with the recommended parameters, in units of s (V_p = 1): axes (A) and directions (R). */
function final2(P: V3[]): { A: V3; R: V3[]; W: number }[] {
  const r = ANISO.riFactor, ks = ANISO.rb / (Math.sqrt(0.15) * r)
  return P.map(xi => {
    let W = 0; const m = [0, 0, 0]; const S2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (const xj of P) {
      const d = [xj[0] - xi[0], xj[1] - xi[1], xj[2] - xi[2]], dist = Math.hypot(d[0], d[1], d[2])
      if (dist >= r) continue
      const w = 1 - (dist / r) ** 3
      W += w
      for (let a = 0; a < 3; a++) { m[a] += w * d[a]; for (let b = 0; b < 3; b++) S2[a][b] += w * d[a] * d[b] }
    }
    const iso = (3 / (4 * Math.PI)) ** (1 / 3)
    if (W <= 1 + 1e-9) return { A: [iso, iso, iso], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], W }
    const mu = m.map(v => v / W)
    const C = [0, 1, 2].map(a => [0, 1, 2].map(b => S2[a][b] / W - mu[a] * mu[b]))
    const e = jacobiEig(C), sd = e.map(x => Math.sqrt(x.l))
    const s1 = Math.max(sd[0], 1e-12), g2 = Math.sqrt(0.6 * Math.PI * r * r / W), g1 = 1.5 * r / W
    const A3 = sd.map(v => Math.min(ANISO.aMax, Math.max(ANISO.aMin, ks * v)))
    const cap = Math.min(ANISO.kappa * sd[0], ANISO.aMax)
    const at = Math.max(Math.min(ks * sd[0], ANISO.aMax), Math.min(ANISO.alpha * g2, cap))
    const As = [at, at, Math.max(ANISO.aMin, 0.5 / (g2 * g2))]
    const al = Math.max(Math.min(ks * sd[0], ANISO.aMax), Math.min(ANISO.alpha * g1, cap))
    const th = Math.max(ANISO.aMin, Math.sqrt(1 / (Math.PI * g1)))
    const Al = [al, th, th]
    const b3 = smooth(ANISO.lo, ANISO.hi, sd[2] / s1), b2 = smooth(ANISO.lo, ANISO.hi, sd[1] / s1)
    let A = [0, 1, 2].map(k => b3 * A3[k] + (1 - b3) * (b2 * As[k] + (1 - b2) * Al[k]))
    const v = A[0] * A[1] * A[2], vmin = 3 / (4 * Math.PI)
    if (v < vmin) A = A.map(x => x * (vmin / Math.max(v, 1e-12)) ** (1 / 3))
    return { A: A as V3, R: e.map(x => x.v), W }
  })
}
const Mof = (A: number[], R: number[][]) => { const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += A[k] * A[k] * R[k][a] * R[k][b]; return M }
const frob = (M: number[][]) => Math.sqrt(M.flat().reduce((q, v) => q + v * v, 0))

/** The bench's synthetic sets (units of s), each tagged. */
function sets(seed: number) {
  const rng = mulberry32(seed), out: { tag: string; P: V3[] }[] = []
  const block: V3[] = []
  for (let i = 0; i < 14; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 14; k++) block.push([i + 0.5 + (rng() - 0.5), j + 0.5 + (rng() - 0.5), k + 0.5 + (rng() - 0.5)])
  out.push({ tag: 'jittered block (bulk + top surface)', P: block })
  for (const g of [1, 1.5, 2]) {
    const sh: V3[] = []
    const n = Math.floor(16 / g)
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) sh.push([(i + 0.3 * (rng() - 0.5)) * g, 0, (k + 0.3 * (rng() - 0.5)) * g])
    out.push({ tag: `one-layer sheet, spacing ${g} s`, P: sh })
  }
  const line: V3[] = []
  for (let i = 0; i < 14; i++) line.push([i * 1.2, 0.1 * (rng() - 0.5), 0.1 * (rng() - 0.5)])
  out.push({ tag: 'thread, spacing 1.2 s', P: line })
  out.push({ tag: '3-particle splash', P: [[0, 0, 0], [1.5, 0, 0], [0.75, 1.3, 0]] })
  out.push({ tag: 'isolated particle', P: [[0, 0, 0]] })
  return out
}

/** The budget (recorded): GPU time of the whole aniso pass (grid + shapes) per frame on a settled-pool-like jittered
 *  lattice at the page's packing (8 ppc, s = 1/128 wu) over the whole floor, `layers` particle layers deep (the page's
 *  164k lava pool = 10 layers; 5 layers ≈ 82k), with and without the interior skip; GPU timestamps. */
export async function anisoCost(device: GPUDevice, o: { layers?: number[]; reps?: number } = {}) {
  if (!device.features.has('timestamp-query')) return { error: 'timestamp-query not available' }
  const s = 1 / 128, reps = o.reps ?? 10, rng = mulberry32(9)
  const out: Record<string, unknown> = {}
  for (const layers of o.layers ?? [10, 5]) {
    const pts: number[] = []
    for (let k = 0; k < 128; k++) for (let j = 0; j < layers; j++) for (let i = 0; i < 128; i++) pts.push((i + 0.5 + (rng() - 0.5)) * s, (j + 0.5 + (rng() - 0.5)) * s, (k + 0.5 + (rng() - 0.5)) * s)
    const n = pts.length / 3
    const buf = new Float32Array(20 * n)
    for (let q = 0; q < n; q++) buf.set([pts[3 * q], pts[3 * q + 1], pts[3 * q + 2]], 20 * q)
    const particles = device.createBuffer({ size: buf.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(particles, 0, buf)
    const k = await AnisoKernel.create(device)
    const qs = device.createQuerySet({ type: 'timestamp', count: 2 })
    const res = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const rd = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const row: Record<string, number> = { particles: n }
    for (const im of [0, 20]) {
      k.interiorMin = im
      let us = 0
      for (let r = 0; r < reps + 2; r++) {
        const e = device.createCommandEncoder()
        const wrapped = new Proxy(e, {
          get(t, prop) {
            if (prop === 'beginComputePass') return (d: GPUComputePassDescriptor = {}) => t.beginComputePass({ ...d, timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } })
            const v = (t as unknown as Record<string | symbol, unknown>)[prop]
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
          },
        })
        k.encode(wrapped as GPUCommandEncoder, particles, n, s ** 3)
        e.resolveQuerySet(qs, 0, 2, res, 0)
        e.copyBufferToBuffer(res, 0, rd, 0, 16)
        device.queue.submit([e.finish()])
        await rd.mapAsync(GPUMapMode.READ)
        const t = new BigUint64Array(rd.getMappedRange().slice(0))
        rd.unmap()
        if (r >= 2) us += Number(t[1] - t[0]) / 1000
      }
      row[`us_interiorMin${im}`] = Math.round(us / reps)
    }
    out[`layers${layers}`] = row
    qs.destroy(); res.destroy(); rd.destroy(); particles.destroy(); k.destroy()
  }
  return out
}

export async function anisoKernels(device: GPUDevice, o: { seed?: number; interiorMin?: number } = {}) {
  const s = 1 / 128                        // the page's rest spacing at 8 ppc: ∛((1/64)³/8)
  const all = sets(o.seed ?? 5)
  // place the sets apart (≥ 2 r_i between them) inside the tank [0, 1]³
  const world: number[] = [], tags: number[] = []
  let ox = 0.05
  all.forEach((set, t) => {
    const lo = [0, 1, 2].map(a => Math.min(...set.P.map(p => p[a])))
    const hi = [0, 1, 2].map(a => Math.max(...set.P.map(p => p[a])))
    for (const p of set.P) { world.push(ox + (p[0] - lo[0]) * s, 0.3 + (p[1] - lo[1]) * s, 0.3 + (p[2] - lo[2]) * s); tags.push(t) }
    ox += (hi[0] - lo[0]) * s + 8 * ANISO.riFactor * s
  })
  const n = tags.length
  const buf = new Float32Array(20 * n)
  for (let q = 0; q < n; q++) buf.set([world[3 * q], world[3 * q + 1], world[3 * q + 2]], 20 * q)
  const particles = device.createBuffer({ size: buf.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(particles, 0, buf)
  const k = await AnisoKernel.create(device)
  k.interiorMin = o.interiorMin ?? 0
  let out: GPUBuffer | null = null
  await submit(device, e => { out = k.encode(e, particles, n, s ** 3) })
  const staging = device.createBuffer({ size: 48 * n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  await submit(device, e => e.copyBufferToBuffer(out!, 0, staging, 0, 48 * n))
  await staging.mapAsync(GPUMapMode.READ)
  const g = new Float32Array(staging.getMappedRange().slice(0))
  staging.unmap(); staging.destroy(); particles.destroy(); k.destroy()
  // the reference on the f32-rounded positions, per set (units of s)
  const rows: Record<string, unknown>[] = []
  let q0 = 0, worstM = 0, worstV = 0
  all.forEach(set => {
    const nP = set.P.length
    const Pw: V3[] = []
    for (let q = q0; q < q0 + nP; q++) Pw.push([Math.fround(world[3 * q]) / s, Math.fround(world[3 * q + 1]) / s, Math.fround(world[3 * q + 2]) / s])
    const ref = final2(Pw)
    let dM = 0, dV = 0, aMean = [0, 0, 0]
    for (let i = 0; i < nP; i++) {
      const q = q0 + i
      const ax = [0, 1, 2].map(kk => [g[12 * q + 4 * kk] / s, g[12 * q + 4 * kk + 1] / s, g[12 * q + 4 * kk + 2] / s])
      const lens = ax.map(v => Math.hypot(v[0], v[1], v[2]))
      const Mg = Mof(lens, ax.map((v, kk) => v.map(c => c / Math.max(lens[kk], 1e-30))))
      const Mr = Mof(ref[i].A, ref[i].R)
      const diff = frob(Mg.map((r, a) => r.map((v, b) => v - Mr[a][b]))) / frob(Mr)
      const vg = g[12 * q + 3], vr = 1 / ((4 / 3) * Math.PI * ref[i].A[0] * ref[i].A[1] * ref[i].A[2])
      dM = Math.max(dM, diff); dV = Math.max(dV, Math.abs(vg / vr - 1))
      ref[i].A.forEach((a, kk) => { aMean[kk] += a / nP })
    }
    worstM = Math.max(worstM, dM); worstV = Math.max(worstV, dV)
    rows.push({ tag: set.tag, particles: nP, mRel: dM, volRel: dV, refAxesMean: aMean.map(v => +v.toFixed(3)) })
    q0 += nP
  })
  return { particles: n, interiorMin: k.interiorMin, worstM, worstV, rows }
}
