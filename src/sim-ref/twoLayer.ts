// twoLayer.ts — S3.5 (variable density) fixtures and measurements, shared by the f64 gate (scripts/fluid-gates/
// s35-ref.mjs, loaded through loadTsModules) and the GPU self-test page (src/bench/flipSelftest/varDensity.ts), so both
// run identical particles and one copy of every measurement.
import { makeParticles, type RefParticles } from './flipRef'

export const G_STD = 9.80665

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** 8 ppc in jittered 2×2×2 sub-cells over [0, nx)×[0, ny)×[0, nz) cells of size h; `materialAt(x, y)` returns
 *  [ρ, tag] or null (no particle). Every particle carries V_p = h³/8 and m = ρ·h³/8 (FINAL-PLAN §4.1). */
export function fillMaterials(nx: number, ny: number, nz: number, h: number, rng: () => number,
  materialAt: (x: number, y: number) => readonly [number, number] | null): { p: RefParticles; tag: Uint8Array } {
  const pts: number[] = [], rho: number[] = [], tag: number[] = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (let s = 0; s < 8; s++) {
    const x = (i + ((s & 1) + rng()) / 2) * h, y = (j + (((s >> 1) & 1) + rng()) / 2) * h, z = (k + (((s >> 2) & 1) + rng()) / 2) * h
    const m = materialAt(x, y)
    if (m) { pts.push(x, y, z); rho.push(m[0]); tag.push(m[1]) }
  }
  const p = makeParticles(rho.length)
  p.pos.set(pts)
  for (let q = 0; q < rho.length; q++) p.mass[q] = rho[q] * h ** 3 / 8
  return { p, tag: Uint8Array.from(tag) }
}

export interface LambMode { omega2: number; ratio: number; residual: number }

/** Two superposed layers with a free surface on top (Lamb 1932 Art. 231): lower layer density ρ (depth h) on a rigid
 *  floor, upper layer density ρ′ (depth h′), free surface above. For waves ∝ cos kx, ω² solves
 *      ω⁴(ρ·coth kh·coth kh′ + ρ′) − ω²·ρgk(coth kh + coth kh′) + (ρ − ρ′)g²k² = 0.
 *  Checks: ρ′ → 0 gives (ω²coth kh − gk)(ω²coth kh′ − gk) = 0; ρ′ = ρ gives ω² = gk·tanh k(h + h′).
 *  Per root: the surface/interface displacement ratio b/a = ω²/(ω²cosh kh′ − gk·sinh kh′) of the eigenmode (upper
 *  layer's kinematic + dynamic surface conditions; ρ′ = ρ gives sinh k(h+h′)/sinh kh) and the relative residual of the
 *  interface pressure condition at that ratio (≈ 0 when the two are consistent). A negative ω² is the unstable root. */
export function lambTwoLayer(o: { rhoLower: number; rhoUpper: number; hLower: number; hUpper: number; k: number }): LambMode[] {
  const { rhoLower: r1, rhoUpper: r2, hLower: h1, hUpper: h2, k } = o, g = G_STD
  const C1 = 1 / Math.tanh(k * h1), C2 = 1 / Math.tanh(k * h2), ch2 = Math.cosh(k * h2), sh2 = Math.sinh(k * h2)
  const A = r1 * C1 * C2 + r2, B = r1 * g * k * (C1 + C2), Cc = (r1 - r2) * g * g * k * k
  const disc = Math.sqrt(B * B - 4 * A * Cc)
  return [(B - disc) / (2 * A), (B + disc) / (2 * A)].map(w2 => {
    const ratio = w2 / (w2 * ch2 - g * k * sh2)
    const lhs = r1 * (-w2 * C1 / k + g), rhs = r2 * (w2 * (ch2 - ratio) / (k * sh2) + g)
    return { omega2: w2, ratio, residual: (lhs - rhs) / (Math.abs(lhs) + Math.abs(rhs)) }
  })
}

/** Interface amplitude (r3 §1): per x-column the height where the UPPER material's particle fraction first reaches 0.5
 *  scanning up from the floor (linear between cell rows), then the least-squares amplitude of A·cos(k·x_centre).
 *  upper/lower: particle counts per (column i, row j) at index i·ny + j. */
export function interfaceAmplitude(upper: ArrayLike<number>, lower: ArrayLike<number>, nx: number, ny: number, dx: number, k: number) {
  const ys: [number, number][] = []
  for (let i = 0; i < nx; i++) {
    let prevJ = -1, prevF = 0
    for (let j = 0; j < ny; j++) {
      const tot = upper[i * ny + j] + lower[i * ny + j]
      if (tot === 0) continue
      const f = upper[i * ny + j] / tot
      if (prevJ >= 0 && prevF < 0.5 && f >= 0.5) { ys.push([i, (prevJ + 0.5 + (0.5 - prevF) / (f - prevF) * (j - prevJ)) * dx]); break }
      prevJ = j; prevF = f
    }
  }
  const mean = ys.reduce((s, [, y]) => s + y, 0) / ys.length
  let num = 0, den = 0
  for (const [i, y] of ys) { const c = Math.cos(k * (i + 0.5) * dx); num += (y - mean) * c; den += c * c }
  return { amplitude: num / den, mean, columns: ys.length }
}

/** Per-(column, row) counts of tagged particles (tag 1 = `upper` when upperTag = 1). */
export function columnCounts(pos: ArrayLike<number>, stride: number, tag: ArrayLike<number>, n: number, nx: number, ny: number, dx: number, upperTag: number) {
  const upper = new Float64Array(nx * ny), lower = new Float64Array(nx * ny)
  for (let q = 0; q < n; q++) {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(pos[stride * q] / dx))), j = Math.min(ny - 1, Math.max(0, Math.floor(pos[stride * q + 1] / dx)))
    if (tag[q] === upperTag) upper[i * ny + j]++; else lower[i * ny + j]++
  }
  return { upper, lower }
}

/** Least-squares fit of A(t) = A₀·cosh(σt) over the samples with |A| < limit (σ scanned, then golden section). */
export function fitCosh(ts: readonly number[], as: readonly number[], limit: number) {
  const idx = ts.map((_, i) => i).filter(i => Math.abs(as[i]) < limit)
  const res = (s: number) => {
    let num = 0, den = 0
    for (const i of idx) { const c = Math.cosh(s * ts[i]); num += as[i] * c; den += c * c }
    const a0 = num / den
    let r = 0
    for (const i of idx) r += (as[i] - a0 * Math.cosh(s * ts[i])) ** 2
    return r
  }
  let best = 0.1, bestR = Infinity
  for (let s = 0.1; s <= 30; s += 0.05) { const r = res(s); if (r < bestR) { bestR = r; best = s } }
  let lo = best - 0.05, hi = best + 0.05
  for (let it = 0; it < 60; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (res(m1) < res(m2)) hi = m2; else lo = m1 }
  return { sigma: (lo + hi) / 2, samples: idx.length, tEnd: idx.length ? ts[idx[idx.length - 1]] : 0 }
}

/** Dense-front distance past the lock (m): the farthest bottom-row column right of the lock whose dense fraction ≥ 0.5,
 *  its leading edge minus the lock position. */
export function lockFront(pos: ArrayLike<number>, stride: number, tag: ArrayLike<number>, n: number, nx: number, dx: number, lockCol: number) {
  const dense = new Float64Array(nx), all = new Float64Array(nx)
  for (let q = 0; q < n; q++) {
    if (pos[stride * q + 1] >= dx) continue
    const i = Math.min(nx - 1, Math.max(0, Math.floor(pos[stride * q] / dx))); all[i]++; if (tag[q]) dense[i]++
  }
  let front = 0
  for (let i = lockCol; i < nx; i++) if (all[i] > 0 && dense[i] / all[i] >= 0.5) front = (i + 1 - lockCol) * dx
  return front
}
