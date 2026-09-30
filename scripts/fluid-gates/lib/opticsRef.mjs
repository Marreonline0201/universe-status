// opticsRef.mjs — an INDEPENDENT reference implementation of the renderer's optics, for the render gates.
//
// It re-parses the same verbatim primary-source files the renderer ships (src/fluid-render/optics/data/) with its own
// code, and evaluates the physics with different formulations where one exists:
//   - conductor Fresnel with complex arithmetic (the renderer uses the closed real-arithmetic form);
//   - dielectric Fresnel directly from pbr-book §8.2 (same equations; separate code);
//   - the D65 × CIE 1931 × XYZ→linear-sRGB integration of r6-render.md §2b (render_calc.py), rewritten here.
//   - OPT-2a: Zhang, Hu & He 2009 pure-water scattering ported IN FULL from the authors' betasw_ZHH2009.m (the renderer
//     ports only its S = 0 branch), QAA_v5, and the sun's single scattering as a per-pixel exact spectral sum with the
//     in-water directions from the conserved tangential wave vector (the renderer: vector refraction + a spectral LUT).
// Expected values in the gates come from here (plus r6's published numbers, which came from Python/numpy), never
// from the renderer's own TypeScript.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DATA = path.join(REPO, 'src', 'fluid-render', 'optics', 'data')
const read = f => fs.readFileSync(path.join(DATA, f), 'latin1')

function rows(text, minCols) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/[\s,]+/).filter(Boolean)
    if (p.length < minCols) continue
    const v = p.map(Number)
    if (v.every(Number.isFinite)) out.push(v)
  }
  return out
}
function lerpTable(x, xs, ys) {
  if (x <= xs[0]) return ys[0]
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1]
  let i = 1
  while (xs[i] < x) i++
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
  return ys[i - 1] + t * (ys[i] - ys[i - 1])
}

const cmf = rows(read('cie1931-2deg-cmf-1nm.csv'), 4)
const d65 = rows(read('cie-d65-1nm.csv'), 2)
const pope = rows(read('pope-fry-1997-water-absorption.txt'), 2)
const hale = rows(read('hale-querry-1973-water-absorption.txt'), 2)
const hgText = read('hg-inagaki-1981-nk.yml')
const hg = rows(hgText.slice(hgText.indexOf('data:')), 3)
const daimon = read('h2o-daimon-2007-20C-n.yml').match(/coefficients:\s*([^\r\n]+)/)[1].trim().split(/\s+/).map(Number)

// 360–830 nm at 1 nm: D65·x̄ȳz̄ weights
const WL = [], WX = [], WY = [], WZ = []
for (let l = 360; l <= 830; l++) {
  const e = lerpTable(l, d65.map(r => r[0]), d65.map(r => r[1]))
  WL.push(l)
  WX.push(e * lerpTable(l, cmf.map(r => r[0]), cmf.map(r => r[1])))
  WY.push(e * lerpTable(l, cmf.map(r => r[0]), cmf.map(r => r[2])))
  WZ.push(e * lerpTable(l, cmf.map(r => r[0]), cmf.map(r => r[3])))
}
// CSS Color 4 XYZ(D65) → linear sRGB (https://www.w3.org/TR/css-color-4/ §19)
const M = [[12831 / 3959, -329 / 214, -1974 / 3959], [-851781 / 878810, 1648619 / 878810, 36519 / 878810], [705 / 12673, -2585 / 12673, 705 / 667]]
const toRgb = ([x, y, z]) => M.map(r => r[0] * x + r[1] * y + r[2] * z)
const xyzOf = f => { let x = 0, y = 0, z = 0; WL.forEach((l, i) => { const v = f(l); x += WX[i] * v; y += WY[i] * v; z += WZ[i] * v }); return [x, y, z] }
/** The un-normalised white: M·XYZ of D65 itself, the per-channel divisor of spectralRgb. */
export const WHITE = toRgb(xyzOf(() => 1))

/** Linear sRGB of D65 light after the spectral process f(λ nm), white-normalised per channel. */
export function spectralRgb(f) { const c = toRgb(xyzOf(f)); return [c[0] / WHITE[0], c[1] / WHITE[1], c[2] / WHITE[2]] }

/** Pure-water absorption, 1/m: Pope & Fry 1997 inside 380–727.5 nm, Hale & Querry 1973 outside (r6 splice). */
export function waterA(l) {
  const inPope = l >= pope[0][0] && l <= pope[pope.length - 1][0]
  const t = inPope ? pope : hale
  return lerpTable(l, t.map(r => r[0]), t.map(r => r[1])) * 100
}
/** Linear sRGB transmittance of white light through L metres of pure water (negative channels clamped to 0). */
export const waterT = L => spectralRgb(l => Math.exp(-waterA(l) * L)).map(v => Math.max(0, v))

/** Daimon & Masumura 2007 (20 °C), refractiveindex.info formula 2, λ in µm. */
export function waterN(um) {
  const L2 = um * um
  let s = daimon[0]
  for (let i = 1; i + 1 < daimon.length; i += 2) s += daimon[i] * L2 / (L2 - daimon[i + 1])
  return Math.sqrt(1 + s)
}

/** Dielectric Fresnel, unpolarised (pbr-book 3rd ed. §8.2). */
export function fresnelDielectric(cosi, n1, n2) {
  const sint2 = (n1 / n2) ** 2 * Math.max(0, 1 - cosi * cosi)
  if (sint2 >= 1) return 1
  const cost = Math.sqrt(1 - sint2)
  const rs = (n1 * cosi - n2 * cost) / (n1 * cosi + n2 * cost)
  const rp = (n2 * cosi - n1 * cost) / (n2 * cosi + n1 * cost)
  return 0.5 * (rs * rs + rp * rp)
}

// Complex arithmetic
const C = (re, im = 0) => ({ re, im })
const add = (a, b) => C(a.re + b.re, a.im + b.im)
const sub = (a, b) => C(a.re - b.re, a.im - b.im)
const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d) }
const abs2 = a => a.re * a.re + a.im * a.im
const csqrt = a => { const r = Math.hypot(a.re, a.im); const re = Math.sqrt((r + a.re) / 2); const im = Math.sign(a.im || 1) * Math.sqrt(Math.max(0, (r - a.re) / 2)); return C(re, im) }

/** Conductor Fresnel from air onto η + ik, by complex arithmetic: cosθt = √(1 − sin²θi/ñ²),
 *  r⊥ = (cosθi − ñ cosθt)/(cosθi + ñ cosθt), r∥ = (ñ cosθi − cosθt)/(ñ cosθi + cosθt), R = ½(|r⊥|² + |r∥|²). */
export function fresnelConductorComplex(cosi, n, k) {
  const nt = C(n, k), ci = C(cosi)
  const sin2 = C(1 - cosi * cosi)
  const ct = csqrt(sub(C(1), div(sin2, mul(nt, nt))))
  const rs = div(sub(ci, mul(nt, ct)), add(ci, mul(nt, ct)))
  const rp = div(sub(mul(nt, ci), ct), add(mul(nt, ci), ct))
  return 0.5 * (abs2(rs) + abs2(rp))
}

/** Liquid mercury η, k (Inagaki et al. 1981), λ in nm, linear in λ between the tabulated points. */
export function mercuryNk(l) {
  const L = hg.map(r => r[0] * 1000)
  return [lerpTable(l, L, hg.map(r => r[1])), lerpTable(l, L, hg.map(r => r[2]))]
}
/** Linear sRGB reflectance of liquid mercury for D65 light at incidence cosθ. */
export const mercuryR = cosi => spectralRgb(l => { const [n, k] = mercuryNk(l); return fresnelConductorComplex(cosi, n, k) })

export const srgbEncode = v => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v)
export const srgbDecode = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
/** 8-bit sRGB of a linear value (clipped to [0,1]). */
export const to8 = v => Math.round(srgbEncode(Math.min(1, Math.max(0, v))) * 255)

// ── camera geometry (three.js column-major matrices, as the probe returns them) ──
export const mulMat4Vec4 = (m, v) => [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3])
/** World-space ray through continuous pixel coordinates (x right, y down; pixel i spans [i, i+1]). */
export function pixelRay(res, px, py) {
  const ndc = [px / res.width * 2 - 1, 1 - py / res.height * 2]
  const un = z => { const e = mulMat4Vec4(res.invProj, [ndc[0], ndc[1], z, 1]); const w = mulMat4Vec4(res.invView, [e[0] / e[3], e[1] / e[3], e[2] / e[3], 1]); return w.slice(0, 3) }
  const a = un(0), b = un(1)
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...d)
  return { o: a, d: d.map(x => x / n) }
}
/** Continuous pixel coordinates of a world point. */
export function project(res, p) {
  const e = mulMat4Vec4(res.view, [p[0], p[1], p[2], 1])
  const c = mulMat4Vec4(res.proj, e)
  return [(c[0] / c[3] + 1) / 2 * res.width, (1 - c[1] / c[3]) / 2 * res.height]
}

/** Decode a probe result's base64 targets. */
export function decodeProbe(r) {
  const buf = k => { const b = Buffer.from(r.data[k], 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  const out = { ...r, t: {} }
  for (const k of Object.keys(r.data)) {
    out.t[k] = k === 'color' || k === 'bg' ? new Uint8Array(buf(k)) : k === 'compId' ? new Uint32Array(buf(k)) : new Float32Array(buf(k))
  }
  return out
}

// ── OPT-2a ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hale & Querry 1973 alone, 1/m (the V17 and OPT-2a-c controls). */
export const haleA = l => lerpTable(l, hale.map(r => r[0]), hale.map(r => r[1])) * 100

/** Linear sRGB (white-normalised) of samples v[i] of a spectral process on the 360–830 nm, 1 nm grid (WAVELENGTHS). */
export const WAVELENGTHS = WL
export function spectralRgbSamples(v) {
  let x = 0, y = 0, z = 0
  for (let i = 0; i < WL.length; i++) { x += WX[i] * v[i]; y += WY[i] * v[i]; z += WZ[i] * v[i] }
  const c = toRgb([x, y, z])
  return [c[0] / WHITE[0], c[1] / WHITE[1], c[2] / WHITE[2]]
}

// the inverse of the CSS XYZ→linear-sRGB matrix (cofactors), for luminance from a rendered triple
const MINV = (() => {
  const [[a, b, c], [d, e, f], [g, h, i]] = M
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]].map(r => r.map(v => v / det))
})()
const Y_WHITE = xyzOf(() => 1)[1]
/** CIE Y (D65 white = 1) of a white-normalised linear sRGB triple: undo the per-channel normalisation with WHITE, then
 *  the inverse of the XYZ→sRGB matrix. */
export function luminanceY(rgb) { const raw = rgb.map((v, i) => v * WHITE[i]); return (MINV[1][0] * raw[0] + MINV[1][1] * raw[1] + MINV[1][2] * raw[2]) / Y_WHITE }
/** CIE Y (D65 white = 1) of D65 light after the spectral process f(λ), directly. */
export const spectralY = f => xyzOf(f)[1] / Y_WHITE

// Zhang, Hu & He 2009, "Scattering by pure seawater: effect of salinity", Opt. Express 17:5698 — betasw_ZHH2009.m
// (X. Zhang, March 10 2009; SEANOE 42420) ported routine by routine: RInw (Ciddor 1996 air × Quan & Fry 1994), BetaT
// (Millero 1980 pure-water secant bulk + the seawater terms), rhou_sw (UNESCO 1981), dlnasw_ds (Millero & Leung 1976 fit),
// PMH. At S = 0 the concentration-fluctuation term is 0·(…) and only the density term remains.
const NA = 6.0221417930e23, KBZ = 1.3806503e-23, M0 = 18e-3
/** β(90) (1/(m·sr)), b (1/m) and the absolute index of (sea)water at λ nm, T °C, salinity S, depolarisation δ. */
export function zhangB(lambdaNm, { tempC = 20, S = 0, delta = 0.039 } = {}) {
  const Tc = tempC, Tk = Tc + 273.15, l = lambdaNm
  const il2 = 1 / (l / 1e3) ** 2
  const nAir = 1.0 + (5792105.0 / (238.0185 - il2) + 167917.0 / (57.362 - il2)) / 1e8
  const [n0, n1, n2, n3, n4, n5, n6, n7, n8, n9] = [1.31405, 1.779e-4, -1.05e-6, 1.6e-8, -2.02e-6, 15.868, 0.01155, -0.00423, -4382, 1.1455e6]
  const nsw = (n0 + (n1 + n2 * Tc + n3 * Tc ** 2) * S + n4 * Tc ** 2 + (n5 + n6 * S + n7 * Tc) / l + n8 / l ** 2 + n9 / l ** 3) * nAir
  const dnds = (n1 + n2 * Tc + n3 * Tc ** 2 + n6 / l) * nAir
  const kw = 19652.21 + 148.4206 * Tc - 2.327105 * Tc ** 2 + 1.360477e-2 * Tc ** 3 - 5.155288e-5 * Tc ** 4
  const a0 = 54.6746 - 0.603459 * Tc + 1.09987e-2 * Tc ** 2 - 6.167e-5 * Tc ** 3
  const b0 = 7.944e-2 + 1.6483e-2 * Tc - 5.3009e-4 * Tc ** 2
  const isoComp = 1 / (kw + a0 * S + b0 * S ** 1.5) * 1e-5
  const rhoW = 999.842594 + 6.793952e-2 * Tc - 9.09529e-3 * Tc ** 2 + 1.001685e-4 * Tc ** 3 - 1.120083e-6 * Tc ** 4 + 6.536332e-9 * Tc ** 5
  const rhoSw = rhoW + (8.24493e-1 - 4.0899e-3 * Tc + 7.6438e-5 * Tc ** 2 - 8.2467e-7 * Tc ** 3 + 5.3875e-9 * Tc ** 4) * S
    + (-5.72466e-3 + 1.0227e-4 * Tc - 1.6546e-6 * Tc ** 2) * S ** 1.5 + 4.8314e-4 * S ** 2
  const dlnawds = (-5.58651e-4 + 2.40452e-7 * Tc - 3.12165e-9 * Tc ** 2 + 2.40808e-11 * Tc ** 3)
    + 1.5 * (1.79613e-5 - 9.9422e-8 * Tc + 2.08919e-9 * Tc ** 2 - 1.39872e-11 * Tc ** 3) * S ** 0.5
    + 2 * (-2.31065e-6 - 1.37674e-9 * Tc - 1.93316e-11 * Tc ** 2) * S
  const n2w = nsw * nsw
  const dfri = (n2w - 1) * (1 + 2 / 3 * (n2w + 2) * (nsw / 3 - 1 / 3 / nsw) ** 2)
  const lm4 = (l * 1e-9) ** -4
  const betaDf = Math.PI * Math.PI / 2 * lm4 * KBZ * Tk * isoComp * dfri ** 2 * (6 + 6 * delta) / (6 - 7 * delta)
  const fluCon = S * M0 * dnds ** 2 / rhoSw / (-dlnawds) / NA
  const betaCf = 2 * Math.PI * Math.PI * lm4 * nsw ** 2 * fluCon * (6 + 6 * delta) / (6 - 7 * delta)
  const beta90 = betaDf + betaCf
  return { beta90, b: 8 * Math.PI / 3 * beta90 * (2 + delta) / (1 + delta), n: nsw }
}
// zhangB on the colour grid, per (T, S, δ)
const gridCache = new Map()
function zhangGrid(tempC, S, delta) {
  const key = `${tempC}|${S}|${delta}`
  if (!gridCache.has(key)) gridCache.set(key, WL.map(l => zhangB(l, { tempC, S, delta })))
  return gridCache.get(key)
}

/** QAA_v5 Table 1 (Lee, Lubac, Werdell & Arnone, IOCCG): g0, g1; t and γ of Eq. 2 (IOCCG Report 5 p. 74). */
export const QAA5 = { g0: 0.089, g1: 0.125, t: 0.52, gamma: 1.7 }
/** R_rs (1/sr) of optically deep water: u = b_b/(a + b_b), r_rs = (g0 + g1·u)·u, R_rs = t·r_rs/(1 − γ·r_rs) — the algebraic
 *  inverse of QAA_v5 Eq. 2, r_rs = R_rs/(0.52 + 1.7·R_rs). */
export function qaaRrs(a, bb, c = QAA5) { const u = bb / (a + bb); const r = (c.g0 + c.g1 * u) * u; return c.t * r / (1 - c.gamma * r) }

/** Linear sRGB R_rs (1/sr, white-normalised, signed) of optically deep pure water, QAA over the colour grid. Options for
 *  the controls: absorption a(λ) (default the Pope & Fry + Hale & Querry splice), b_b/b (default ½), the g-set, T, δ. */
export function waterRrsRgb({ absorption = waterA, bbOverB = 0.5, c = QAA5, tempC = 20, delta = 0.039 } = {}) {
  const z = zhangGrid(tempC, 0, delta)
  return spectralRgbSamples(WL.map((l, i) => qaaRrs(absorption(l), bbOverB * z[i].b, c)))
}

/** Apparent-depth ratio of a flat layer seen at α from its normal (the exact Snell, sagittal form): tanθt/tanα =
 *  cosα/√(n² − sin²α). */
export const sagittalRatio = (alphaRad, n) => Math.cos(alphaRad) / Math.sqrt(n * n - Math.sin(alphaRad) ** 2)

/** Geometry of the sun's single scattering in a flat layer (normal +y) seen along the unit view direction d (from the
 *  eye), with the sun toward the unit vector `sun`, index n: the in-water directions from the conserved tangential wave
 *  vector (sinθ_water = sinθ_air/n) — the light heading to the eye travels (−d_x/n, μv, −d_z/n), the sun's beam
 *  (−s_x/n, −μs, −s_z/n) — cos ψ between them, E_w per unit E_sun, and the exit factor (1 − F(θv))/n² (the n² law). */
export function ssGeometry(d, sun, n) {
  const cosV = -d[1], muSair = sun[1]
  if (!(cosV > 0) || !(muSair > 0)) return null
  const muV = Math.sqrt(1 - (1 - cosV * cosV) / (n * n))
  const muS = Math.sqrt(1 - (1 - muSair * muSair) / (n * n))
  const up = [-d[0] / n, muV, -d[2] / n], beam = [-sun[0] / n, -muS, -sun[2] / n]
  const cosPsi = up[0] * beam[0] + up[1] * beam[1] + up[2] * beam[2]
  return { cosV, muV, muS, cosPsi, ewPerEsun: (1 - fresnelDielectric(muSair, 1, n)) * muSair / muS, exit: (1 - fresnelDielectric(cosV, 1, n)) / (n * n) }
}

/** The in-water single-scattered radiance L_ss(0−) per unit E_w at each grid wavelength for a layer of depth D (m):
 *  β(ψ)·[1 − e^{−c·ℓ·k}]/(c·k), ℓ = D/μv, k = 1 + μv/μs, c = a + b (OOWB "The Single-Scattering Approximation", Eq. 6
 *  integrated over the layer); β(ψ) = β(90)·[1 + cos²ψ·(1 − δ)/(1 + δ)] (Zhang code line 68).
 *  opts.thin: ℓ in place of the attenuated path; opts.isotropic: β = b/4π (both are must-fail controls). */
export function ssSpectrum(g, depthM, { thin = false, isotropic = false, tempC = 20, delta = 0.039, absorption = waterA } = {}) {
  const z = zhangGrid(tempC, 0, delta)
  const ell = depthM / g.muV, k = 1 + g.muV / g.muS, C = (1 - delta) / (1 + delta)
  return WL.map((l, i) => {
    const { beta90, b } = z[i]
    const beta = isotropic ? b / (4 * Math.PI) : beta90 * (1 + C * g.cosPsi * g.cosPsi)
    const c = absorption(l) + b
    return beta * (thin ? ell : -Math.expm1(-c * ell * k) / (c * k))
  })
}

/** The OPT-2a in-scatter as added to the composite colour, linear sRGB: (1 − F(θv))/n²·E_w·L_ss(0−) — the exact spectral
 *  sum, no LUT (E_sun = π in the renderer's units). */
export function scatterRef(d, sun, depthM, n, opts = {}) {
  const g = ssGeometry(d, sun, n)
  if (!g) return [0, 0, 0]
  const Esun = opts.Esun ?? Math.PI
  return spectralRgbSamples(ssSpectrum(g, depthM, opts)).map(v => g.exit * Esun * g.ewPerEsun * v)
}

/** The effective scattering coefficient S_rgb(x) = spectral(b·[1 − e^{−c·x}]/(c·x)), 1/m (S_rgb(0) = spectral(b)): the
 *  renderer's LUT-row function, evaluated here directly. */
export function scatterRowRef(x, { tempC = 20, delta = 0.039, absorption = waterA } = {}) {
  const z = zhangGrid(tempC, 0, delta)
  return spectralRgbSamples(WL.map((l, i) => { const b = z[i].b, c = absorption(l) + b; return x > 0 ? -b * Math.expm1(-c * x) / (c * x) : b }))
}
