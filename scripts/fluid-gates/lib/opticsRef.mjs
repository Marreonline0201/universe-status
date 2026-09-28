// opticsRef.mjs — an INDEPENDENT reference implementation of the renderer's optics, for the render gates.
//
// It re-parses the same verbatim primary-source files the renderer ships (src/fluid-render/optics/data/) with its own
// code, and evaluates the physics with different formulations where one exists:
//   - conductor Fresnel with complex arithmetic (the renderer uses the closed real-arithmetic form);
//   - dielectric Fresnel directly from pbr-book §8.2 (same equations; separate code);
//   - the D65 × CIE 1931 × XYZ→linear-sRGB integration of r6-render.md §2b (render_calc.py), rewritten here.
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
const WHITE = toRgb(xyzOf(() => 1))

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
