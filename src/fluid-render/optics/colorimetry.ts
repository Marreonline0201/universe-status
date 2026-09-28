// Colorimetry for the fluid renderer: spectrum → linear sRGB, and the sRGB transfer functions.
//
// Every optical quantity the renderer uses per colour channel (water transmittance, metal reflectance) is
// computed HERE from a measured spectrum, never typed in as an RGB triple (EXTENDED-ROADMAP ED-11 / PH-B1:
// one spectral dataset feeds every optical stage). Method, identical to r6-render.md §2b:
//   XYZ = Σ_λ D65(λ)·f(λ)·(x̄, ȳ, z̄)(λ)   (1 nm steps, 360–830 nm)   →   linear sRGB = M·XYZ
// and each channel is divided by the same sum for f ≡ 1 ("white-normalised"), so f ≡ 1 gives exactly
// (1, 1, 1): the result is the colour of D65 white light after the process f(λ).
//
// Sources (raw files verbatim in ./data, parsed at runtime — the gates parse the same files independently):
//   CIE 1931 2° colour-matching functions, 1 nm: CVRL, http://www.cvrl.org/database/data/cmfs/ciexyz31_1.csv
//   CIE standard illuminant D65, 1 nm: CIE dataset DOI 10.25039/CIE.DS.hjfjmt59,
//     https://files.cie.co.at/Publications-datasets/CIE_std_illum_D65.csv
//   XYZ(D65) → linear sRGB matrix, gam_sRGB and lin_sRGB: CSS Color Module Level 4, §19 sample code,
//     https://www.w3.org/TR/css-color-4/ (the rational matrix entries are copied verbatim).
//
// Stated limit: a per-channel product T_rgb × background is exact for a white or grey background and an
// approximation for a coloured one (EXTENDED-ROADMAP §5.1, "Disclosed").
import cmfText from './data/cie1931-2deg-cmf-1nm.csv?raw'
import d65Text from './data/cie-d65-1nm.csv?raw'

export type Rgb = [number, number, number]

/** Numeric rows of a whitespace/comma separated table; header and comment lines are skipped. */
export function parseNumericRows(text: string, minCols = 2): number[][] {
  const rows: number[][] = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,]+/).filter(p => p.length > 0)
    if (parts.length < minCols) continue
    const nums = parts.map(Number)
    if (nums.some(v => !Number.isFinite(v))) continue
    rows.push(nums)
  }
  return rows
}

/** Linear interpolation in a table sorted by x (held at the end values outside the table). */
export function interp(x: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = xs.length
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid; else hi = mid
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + t * (ys[hi] - ys[lo])
}

/** Integration grid: 360–830 nm at 1 nm, the CVRL table's own grid. */
export const LAMBDA_MIN_NM = 360
export const LAMBDA_MAX_NM = 830

interface SpectralBasis { lambdaNm: Float64Array; wX: Float64Array; wY: Float64Array; wZ: Float64Array; white: Rgb }

let basisCache: SpectralBasis | null = null

/** CSS Color 4 XYZ(D65) → linear-light sRGB, verbatim rational entries. */
export const XYZ_TO_LIN_SRGB: readonly (readonly number[])[] = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
]

function xyzToLinSrgb(x: number, y: number, z: number): Rgb {
  const M = XYZ_TO_LIN_SRGB
  return [M[0][0] * x + M[0][1] * y + M[0][2] * z, M[1][0] * x + M[1][1] * y + M[1][2] * z, M[2][0] * x + M[2][1] * y + M[2][2] * z]
}

/** D65(λ)·(x̄, ȳ, z̄)(λ) on the integration grid (Δλ is a common factor and cancels in the white normalisation). */
function basis(): SpectralBasis {
  if (basisCache) return basisCache
  const cmf = parseNumericRows(cmfText, 4)
  const d65 = parseNumericRows(d65Text, 2)
  const cl = cmf.map(r => r[0]), cx = cmf.map(r => r[1]), cy = cmf.map(r => r[2]), cz = cmf.map(r => r[3])
  const dl = d65.map(r => r[0]), dv = d65.map(r => r[1])
  const n = LAMBDA_MAX_NM - LAMBDA_MIN_NM + 1
  const lambdaNm = new Float64Array(n), wX = new Float64Array(n), wY = new Float64Array(n), wZ = new Float64Array(n)
  let sx = 0, sy = 0, sz = 0
  for (let i = 0; i < n; i++) {
    const l = LAMBDA_MIN_NM + i
    const e = interp(l, dl, dv)
    lambdaNm[i] = l
    wX[i] = e * interp(l, cl, cx); sx += wX[i]
    wY[i] = e * interp(l, cl, cy); sy += wY[i]
    wZ[i] = e * interp(l, cl, cz); sz += wZ[i]
  }
  basisCache = { lambdaNm, wX, wY, wZ, white: xyzToLinSrgb(sx, sy, sz) }
  return basisCache
}

/** Linear sRGB of D65 light after a spectral process f(λ) (λ in nm), white-normalised per channel. */
export function spectrumToLinearSrgb(f: (lambdaNm: number) => number): Rgb {
  const b = basis()
  let X = 0, Y = 0, Z = 0
  for (let i = 0; i < b.lambdaNm.length; i++) {
    const v = f(b.lambdaNm[i])
    X += b.wX[i] * v; Y += b.wY[i] * v; Z += b.wZ[i] * v
  }
  const rgb = xyzToLinSrgb(X, Y, Z)
  return [rgb[0] / b.white[0], rgb[1] / b.white[1], rgb[2] / b.white[2]]
}

/** CSS Color 4 lin_sRGB (sRGB-encoded → linear light), extended to negative values as the spec does. */
export function srgbDecode(v: number): number {
  const a = Math.abs(v)
  return a <= 0.04045 ? v / 12.92 : Math.sign(v) * Math.pow((a + 0.055) / 1.055, 2.4)
}

/** CSS Color 4 gam_sRGB (linear light → sRGB-encoded). */
export function srgbEncode(v: number): number {
  const a = Math.abs(v)
  return a > 0.0031308 ? Math.sign(v) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055) : 12.92 * v
}
