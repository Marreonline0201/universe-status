// Shared S3.4 measurement definitions (s34-ref.mjs on the f64 reference, s34-gpu.mjs on the GPU path) — one copy, so
// the two gates can never measure differently.

/** Martin & Moyce 1952 n² = 2, a = 2.25 in: Table 2 front Z(T), Table 6 residual height H(τ) [r3 §2.2]. */
export const MM2 = { T: [0.41, 0.84, 1.19, 1.43, 1.63, 1.83, 1.98, 2.20, 2.32, 2.51, 2.65, 2.83, 2.98, 3.11, 3.33], Z: [1.11, 1.22, 1.44, 1.67, 1.89, 2.11, 2.33, 2.56, 2.78, 3.00, 3.22, 3.44, 3.67, 3.89, 4.11] }
export const MM2H = [[0.56, 0.94], [0.77, 0.89], [0.93, 0.83], [1.08, 0.78], [1.28, 0.72], [1.46, 0.67], [1.66, 0.61], [1.84, 0.56], [2.00, 0.50], [2.21, 0.44], [2.45, 0.39], [2.70, 0.33], [3.06, 0.28], [3.44, 0.22], [4.20, 0.17], [5.25, 0.11]]
/** n² = 1, a = 2.25 in [r3 §2.3: extracted from Leakey et al. 2021 Fig. 7 vector markers; MM 1952 itself is paywalled]. */
export const MM1 = { T: [0.43, 0.62, 0.80, 0.97, 1.14, 1.29, 1.45, 1.62, 1.76, 1.93, 2.07, 2.24, 2.40, 2.54, 2.71, 2.87, 3.04, 3.21, 3.29, 3.32], Z: [1.11, 1.22, 1.44, 1.67, 1.89, 2.11, 2.33, 2.56, 2.78, 3.00, 3.22, 3.44, 3.67, 3.89, 4.11, 4.33, 4.56, 4.78, 4.89, 5.00] }
export const MM1H = [[0.80, 0.89], [1.29, 0.78], [1.74, 0.67], [2.15, 0.56], [2.57, 0.44], [3.08, 0.33], [4.27, 0.22], [6.29, 0.11]]
/** Lobovský et al. 2014 §5.2.3, H = 600 mm, sensor 1: median pressure impulse (mbar·s → Pa·s). */
export const LOBOVSKY_I600 = 12.74 * 100

export const interp = (xs, ys, x) => { if (x <= xs[0]) return ys[0]; for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys.at(-1) }

/** D1: least-squares fit of E_K = a + b·cos(2wt) + c·sin(2wt), scanned over w ∈ [0.8, 1.2]·ω then golden-section. */
export function fitOmega(ts, es, omega) {
  const fit = w => {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0]
    for (let i = 0; i < ts.length; i++) {
      const f = [1, Math.cos(2 * w * ts[i]), Math.sin(2 * w * ts[i])]
      for (let a = 0; a < 3; a++) { r[a] += f[a] * es[i]; for (let b = 0; b < 3; b++) S[a][b] += f[a] * f[b] }
    }
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    const D = det(S), co = [0, 1, 2].map(j => det(S.map((row, i) => row.map((v, c) => (c === j ? r[i] : v)))) / D)
    let res = 0
    for (let i = 0; i < ts.length; i++) res += (es[i] - co[0] - co[1] * Math.cos(2 * w * ts[i]) - co[2] * Math.sin(2 * w * ts[i])) ** 2
    return res
  }
  let best = omega, bestR = Infinity
  for (let w = 0.8 * omega; w <= 1.2 * omega; w += omega * 0.002) { const r = fit(w); if (r < bestR) { bestR = r; best = w } }
  let lo = best - omega * 0.002, hi = best + omega * 0.002
  for (let it = 0; it < 60; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (fit(m1) < fit(m2)) hi = m2; else lo = m1 }
  return (lo + hi) / 2
}

/** D2: ν_num = −slope(ln E_env)/(4k²), the envelope being the largest E_K within ±¼ E_K period of each t = mπ/ω. */
export function nuNum(ts, es, omega, k) {
  const T = ts.at(-1), peaks = []
  for (let m = 0; m * Math.PI / omega <= T; m++) {
    const tc = m * Math.PI / omega, win = 0.25 * Math.PI / omega
    let bestE = -1, bestT = 0
    for (let i = 0; i < ts.length; i++) if (Math.abs(ts[i] - tc) <= win && es[i] > bestE) { bestE = es[i]; bestT = ts[i] }
    if (bestE > 0) peaks.push([bestT, bestE])
  }
  const tp = peaks.map(q => q[0]), lp = peaks.map(q => Math.log(q[1]))
  const tm = tp.reduce((a, b) => a + b, 0) / tp.length, lm = lp.reduce((a, b) => a + b, 0) / lp.length
  let sxy = 0, sxx = 0
  for (let i = 0; i < tp.length; i++) { sxy += (tp[i] - tm) * (lp[i] - lm); sxx += (tp[i] - tm) ** 2 }
  return { nu: -(sxy / sxx) / (4 * k * k), peaks: peaks.length }
}

/** r3 §2.7 column-collapse metrics: RMS relative Z error at the table points 0.84 ≤ T ≤ 3.33 (no shift; the best shift
 *  in ±0.5 reported), dZ/dT fitted on Twin, max |ΔH| at the height points τ ≤ 2.45, per-point residuals, and how far
 *  the raw max(x) runs ahead of the bulk front. r = { ts, Z, Zraw, H, n, tUnit }; T = n·t/tUnit, τ = t/tUnit. */
export function columnScore(r, table, hTable, Twin) {
  const T = r.ts.map(t => r.n * t / r.tUnit), tau = r.ts.map(t => t / r.tUnit), Tmax = Math.max(...T), tauMax = Math.max(...tau)
  const pts = table.T.map((t, i) => [t, table.Z[i]]).filter(([t]) => t >= 0.84 && t <= 3.33 && t <= Tmax)
  const rms = shift => Math.sqrt(pts.reduce((q, [t, z]) => q + ((interp(T, r.Z, t + shift) - z) / z) ** 2, 0) / pts.length)
  let bestShift = 0, bestRms = rms(0)
  for (let i = -50; i <= 50; i++) { const e = rms(i / 100); if (e < bestRms) { bestRms = e; bestShift = i / 100 } }
  const idx = T.map((x, i) => [x, i]).filter(([x]) => x >= Twin[0] && x <= Twin[1]).map(([, i]) => i)
  const tm = idx.reduce((q, i) => q + T[i], 0) / idx.length, zm = idx.reduce((q, i) => q + r.Z[i], 0) / idx.length
  let sxy = 0, sxx = 0
  for (const i of idx) { sxy += (T[i] - tm) * (r.Z[i] - zm); sxx += (T[i] - tm) ** 2 }
  let dH = 0
  for (const [tt, hh] of hTable) if (tt <= 2.45 && tt <= tauMax) dH = Math.max(dH, Math.abs(interp(tau, r.H, tt) - hh))
  const resid = pts.map(([t, z]) => `${t.toFixed(2)}:${(100 * (interp(T, r.Z, t) - z) / z).toFixed(1)}`).join(' ')
  const rawAhead = pts.reduce((q, [t]) => Math.max(q, interp(T, r.Zraw, t) - interp(T, r.Z, t)), 0)
  return { rmsZ: rms(0), points: pts.length, bestShift, bestRms, slope: sxy / sxx, dH, resid, rawAhead }
}

/** Lobovský et al. 2014 §5.1.2 (Fig. 21) and §5.1.3: rise time = 2·(t_peak − t at half-max on the rise), decay time
 *  the same after the peak, impact time = rise + decay, I = ∫ p dt over the impact time (trapezoid on the samples). */
export function impulse(ts, P) {
  const peak = Math.max(...P), ip = P.indexOf(peak), half = peak / 2
  let iR = ip; while (iR > 0 && P[iR] > half) iR--
  let iF = ip; while (iF < P.length - 1 && P[iF] > half) iF++
  const cross = (i0, i1) => ts[i0] + (half - P[i0]) * (ts[i1] - ts[i0]) / (P[i1] - P[i0])
  const tPeak = ts[ip], rise = 2 * (tPeak - cross(iR, iR + 1)), decay = 2 * (cross(iF - 1, iF) - tPeak)
  const t0 = tPeak - rise, t1 = tPeak + decay
  let I = 0
  for (let i = 1; i < P.length; i++) {
    const lo = Math.max(ts[i - 1], t0), hi = Math.min(ts[i], t1)
    if (hi > lo) I += 0.5 * (interp(ts, P, lo) + interp(ts, P, hi)) * (hi - lo)
  }
  return { I, peak, tPeak, rise, decay }
}

/** A1c grid self-convergence on ONE physical column run at three resolutions (the S3.2 replacement for the ill-posed
 *  "error(a = 12) ≤ error(a = 8) against the experiment"; decisions.md 2026-09-28 night): the RMS difference of the
 *  front Z between successive resolutions at the Table 2 points 0.84 ≤ T ≤ 3.33 must shrink. runs: coarse → fine. */
export function selfConvergence(runs, table = MM2) {
  const zs = runs.map(r => { const T = r.ts.map(t => r.n * t / r.tUnit); return table.T.filter(t => t >= 0.84 && t <= 3.33).map(t => interp(T, r.Z, t)) })
  const rmsD = (u, v) => Math.sqrt(u.reduce((s, x, i) => s + (x - v[i]) ** 2, 0) / u.length)
  return { e1: rmsD(zs[1], zs[0]), e2: rmsD(zs[2], zs[1]) }
}
