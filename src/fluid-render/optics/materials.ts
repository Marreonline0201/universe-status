// Optical models of the liquids the renderer draws, from measured data only, and the GPU tables built from them.
//
// Two kinds of liquid:
//   dielectric — reflects by the exact dielectric Fresnel law at its refractive index, refracts by Snell's law,
//                absorbs along the in-liquid path by Beer–Lambert with its MEASURED spectral absorption a(λ);
//   conductor  — reflects by the exact conductor Fresnel law at its measured complex index η + ik and transmits
//                nothing (a metal is opaque within tens of nanometres, so Beer–Lambert on a metal is meaningless).
// Every colour is integrated from a spectrum (colorimetry.ts); nothing here is an RGB triple chosen by eye.
//
// Data (verbatim files in ./data):
//   Water absorption — Pope & Fry 1997, Appl. Opt. 36, 8710 (380–727.5 nm), https://omlc.org/spectra/water/data/pope97.txt,
//     spliced with Hale & Querry 1973, Appl. Opt. 12, 555 outside that range, https://omlc.org/spectra/water/data/hale73.txt
//     (both tabulated in 1/cm; the splice and the method are r6-render.md §2b's). ED-11: this ONE spectral dataset is
//     the only water absorption in the renderer; the (0.306, 0.047, 0.0002) m⁻¹ triple of r6/FINAL-PLAN R0 is its
//     1 m colorimetric fit and is NOT used (EXTENDED-ROADMAP §5.1, critique PH-B1).
//   Water refractive index — Daimon & Masumura 2007, Appl. Opt. 46, 3811, 20.0 °C (refractiveindex.info, CC0),
//     https://refractiveindex.info/?shelf=main&book=H2O&page=Daimon-20.0C → n(589.3 nm) = 1.33335.
//   Mercury complex index — Inagaki, Arakawa & Williams 1981, Phys. Rev. B 23, 5246, liquid Hg at room temperature
//     (refractiveindex.info, CC0), https://refractiveindex.info/?shelf=main&book=Hg&page=Inagaki
//     (linear interpolation in λ between the tabulated points; 9 points fall inside 380–780 nm).
//   Ethanol n — Rheims, Köser & Wriedt 1997, Meas. Sci. Technol. 8, 601, 20 °C (refractiveindex.info, CC0).
//   Glycerol n — Rheims, Köser & Wriedt 1997, 25 °C (refractiveindex.info, CC0); used at the sim's 20 °C.
// UNVERIFIED (reported, not invented): no measured visible absorption spectrum was found for glycerol, ethanol (Kedenburg
// 2012 tabulates k only from 500 nm up), olive oil or honey, so they render NON-ABSORBING; no sourced refractive index
// for olive oil, honey or the lava presets, so their legacy PropertyCalculator/renderOverride IOR is used and flagged.
import popeText from './data/pope-fry-1997-water-absorption.txt?raw'
import haleText from './data/hale-querry-1973-water-absorption.txt?raw'
import hgText from './data/hg-inagaki-1981-nk.yml?raw'
import waterNText from './data/h2o-daimon-2007-20C-n.yml?raw'
import ethanolNText from './data/ethanol-rheims-1997-n.yml?raw'
import glycerolNText from './data/glycerol-rheims-1997-n.yml?raw'
import { interp, parseNumericRows, spectrumToLinearSrgb, type Rgb } from './colorimetry'
import { fresnelConductor } from './fresnel'

// ── refractiveindex.info YAML (only the two record types used here) ─────────────────────────────────────────
interface RiiFormula { formula: number; coefficients: number[]; rangeUm: [number, number] | null }

function parseRiiFormula(text: string): RiiFormula {
  const f = /type:\s*formula\s+(\d+)/.exec(text)
  const c = /coefficients:\s*([^\r\n]+)/.exec(text)
  if (!f || !c) throw new Error('refractiveindex.info file has no formula record')
  const r = /wavelength_range:\s*([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(text)
  return { formula: Number(f[1]), coefficients: c[1].trim().split(/\s+/).map(Number), rangeUm: r ? [Number(r[1]), Number(r[2])] : null }
}

/** n(λ) of a refractiveindex.info dispersion formula; λ in µm. Formula 2: n² − 1 = C1 + Σ C(2i)·λ²/(λ² − C(2i+1));
 *  formula 5: n = C1 + Σ C(2i)·λ^C(2i+1) (refractiveindex.info database documentation). */
function riiN(f: RiiFormula, lambdaUm: number): number {
  const C = f.coefficients
  if (f.formula === 2) {
    const L2 = lambdaUm * lambdaUm
    let n2m1 = C[0]
    for (let i = 1; i + 1 < C.length; i += 2) n2m1 += C[i] * L2 / (L2 - C[i + 1])
    return Math.sqrt(1 + n2m1)
  }
  if (f.formula === 5) {
    let n = C[0]
    for (let i = 1; i + 1 < C.length; i += 2) n += C[i] * Math.pow(lambdaUm, C[i + 1])
    return n
  }
  throw new Error(`refractiveindex.info formula ${f.formula} not implemented`)
}

/** Rows of a "tabulated nk" record: [λ µm, n, k]. */
function parseRiiTabulatedNk(text: string): number[][] {
  const i = text.indexOf('tabulated nk')
  if (i < 0) throw new Error('refractiveindex.info file has no tabulated nk record')
  return parseNumericRows(text.slice(i), 3).filter(r => r.length === 3)
}

/** Sodium D line, the conventional wavelength for a single refractive index. */
export const LAMBDA_D_UM = 0.5893

// ── Water ────────────────────────────────────────────────────────────────────────────────────────────────────
const pope = parseNumericRows(popeText, 2)
const hale = parseNumericRows(haleText, 2)
const popeL = pope.map(r => r[0]), popeA = pope.map(r => r[1])
const haleL = hale.map(r => r[0]), haleA = hale.map(r => r[1])
const POPE_MIN_NM = popeL[0], POPE_MAX_NM = popeL[popeL.length - 1]

/** Pure-water absorption coefficient a(λ) in 1/m: Pope & Fry inside their 380–727.5 nm range, Hale & Querry outside. */
export function waterAbsorptionPerM(lambdaNm: number): number {
  const perCm = lambdaNm >= POPE_MIN_NM && lambdaNm <= POPE_MAX_NM ? interp(lambdaNm, popeL, popeA) : interp(lambdaNm, haleL, haleA)
  return perCm * 100
}

const waterN = parseRiiFormula(waterNText)
/** Water refractive index (Daimon & Masumura 2007, 20.0 °C), λ in µm. */
export const waterIor = (lambdaUm: number) => riiN(waterN, lambdaUm)

// ── Mercury ──────────────────────────────────────────────────────────────────────────────────────────────────
const hg = parseRiiTabulatedNk(hgText)
const hgL = hg.map(r => r[0] * 1000), hgN = hg.map(r => r[1]), hgK = hg.map(r => r[2])
/** Liquid-mercury complex index (Inagaki et al. 1981), λ in nm, linear interpolation between tabulated points. */
export function mercuryNk(lambdaNm: number): [number, number] {
  return [interp(lambdaNm, hgL, hgN), interp(lambdaNm, hgL, hgK)]
}

const ethanolN = parseRiiFormula(ethanolNText)
const glycerolN = parseRiiFormula(glycerolNText)

// ── Registry ─────────────────────────────────────────────────────────────────────────────────────────────────
export type OpticalKind = 'dielectric' | 'conductor'

export interface OpticalModel {
  kind: OpticalKind
  /** Refractive index for Snell refraction and dielectric Fresnel, at 589.3 nm (NaN for conductors). */
  iorD: number
  /** Measured spectral absorption, 1/m (dielectrics); null = no measured spectrum → rendered non-absorbing. */
  absorptionPerM: ((lambdaNm: number) => number) | null
  /** Measured complex index η + ik (conductors), λ in nm. */
  nk: ((lambdaNm: number) => [number, number]) | null
  /** What in this model is not from a primary source (shown in reports). */
  unverified: string[]
}

export const OPTICAL_MODELS: Record<string, OpticalModel> = {
  water: { kind: 'dielectric', iorD: waterIor(LAMBDA_D_UM), absorptionPerM: waterAbsorptionPerM, nk: null,
    unverified: ['n and a(λ) held at their 20 °C values at every temperature'] },
  mercury: { kind: 'conductor', iorD: NaN, absorptionPerM: null, nk: mercuryNk, unverified: [] },
  ethanol: { kind: 'dielectric', iorD: riiN(ethanolN, LAMBDA_D_UM), absorptionPerM: null, nk: null,
    unverified: ['visible absorption spectrum: none sourced (rendered non-absorbing)'] },
  glycerol: { kind: 'dielectric', iorD: riiN(glycerolN, LAMBDA_D_UM), absorptionPerM: null, nk: null,
    unverified: ['n measured at 25 °C, used at 20 °C', 'visible absorption spectrum: none sourced (rendered non-absorbing)'] },
}

/** Rows of the optics look-up table, in buffer order. The shader addresses them by index (materials record .z). */
export type LutRowSpec = { key: string; kind: 'transmittance' | 'reflectance' }
export const LUT_ROWS: readonly LutRowSpec[] = [
  { key: 'water', kind: 'transmittance' },
  { key: 'mercury', kind: 'reflectance' },
]
/** Entries per LUT row. */
export const LUT_N = 1024
/** Transmittance rows cover in-liquid path lengths 0 … LUT_LMAX_M, sampled at L_i = LUT_LMAX_M·(i/(N−1))²
 *  (dense at short paths; linear-interpolation error < 1e-5 in T over the tank's 0–6 m, see r0-render.mjs). */
export const LUT_LMAX_M = 128

/** Linear sRGB transmittance of D65 white light through `pathM` metres of a liquid with absorption a(λ).
 *  Negative channels (red beyond ≈ 9 m of water leaves the sRGB gamut, r6 §2b caveat ii) are clamped to 0 in linear
 *  light — the one disclosed gamut clamp. */
export function transmittanceRgb(absorptionPerM: (lambdaNm: number) => number, pathM: number): Rgb {
  const t = spectrumToLinearSrgb(l => Math.exp(-absorptionPerM(l) * pathM))
  return [Math.max(0, t[0]), Math.max(0, t[1]), Math.max(0, t[2])]
}

/** Linear sRGB reflectance of a conductor for D65 white light at incidence cosθ. */
export function conductorReflectanceRgb(nk: (lambdaNm: number) => [number, number], cosTheta: number): Rgb {
  return spectrumToLinearSrgb(l => { const [n, k] = nk(l); return fresnelConductor(cosTheta, n, k) })
}

/** The optics LUT for the GPU: LUT_ROWS.length rows × LUT_N vec4 (rgb, 0).
 *  transmittance rows: entry i ↔ path LUT_LMAX_M·(i/(N−1))²;  reflectance rows: entry i ↔ cosθ = i/(N−1). */
export function buildOpticsLut(): Float32Array<ArrayBuffer> {
  const out = new Float32Array(LUT_ROWS.length * LUT_N * 4)
  LUT_ROWS.forEach((row, r) => {
    const m = OPTICAL_MODELS[row.key]
    for (let i = 0; i < LUT_N; i++) {
      const u = i / (LUT_N - 1)
      const v = row.kind === 'transmittance'
        ? transmittanceRgb(m.absorptionPerM!, LUT_LMAX_M * u * u)
        : conductorReflectanceRgb(m.nk!, u)
      out.set([v[0], v[1], v[2], 0], (r * LUT_N + i) * 4)
    }
  })
  return out
}

/** The per-composition optics record the composite shader reads: vec4(kind, ior, lutRow, 0) + vec4(0).
 *  kind 0 = dielectric, 1 = conductor; lutRow −1 = none (non-absorbing dielectric). */
export interface OpticsRecord { kind: 0 | 1; ior: number; lutRow: number; unverified: string[] }

/** Record for a composition: its cited optical model, or — with no model — a non-absorbing dielectric at the
 *  legacy (unsourced) IOR, flagged UNVERIFIED. */
export function opticsRecordFor(materialKey: string | null, legacyIor: number): OpticsRecord {
  const m = materialKey ? OPTICAL_MODELS[materialKey] : undefined
  if (!m) {
    const ior = Number.isFinite(legacyIor) && legacyIor >= 1 ? legacyIor : 1
    return { kind: 0, ior, lutRow: -1, unverified: [`no optical model for ${materialKey ?? 'this composition'}: legacy IOR ${ior} (unsourced), no absorption spectrum (rendered non-absorbing)`] }
  }
  const row = LUT_ROWS.findIndex(r => r.key === materialKey)
  if (m.kind === 'conductor') return { kind: 1, ior: 1, lutRow: row, unverified: m.unverified }
  return { kind: 0, ior: m.iorD, lutRow: m.absorptionPerM ? row : -1, unverified: m.unverified }
}

/** Optics records for every composition, as SSFRPipeline.updateMaterialProps expects them: 256 × 8 floats,
 *  [kind, ior, lutRow, 0, 0, 0, 0, 0] at id·8. Keyed by each composition's cited material key; the look values in
 *  PropertyCalculator props (color, opacityDensity, F0, metalness, emissive) are not rendered. */
export function opticsRenderData(comps: readonly { id: number; materialKey: string | null; props: { IOR: number } }[], capacity = 256): Float32Array<ArrayBuffer> {
  const data = new Float32Array(capacity * 8)
  for (const c of comps) {
    if (c.id >= capacity) continue
    const r = opticsRecordFor(c.materialKey, c.props.IOR)
    data.set([r.kind, r.ior, r.lutRow, 0], c.id * 8)
  }
  return data
}

/** Normal-incidence reflectance of a conductor at one wavelength (reported alongside the integrated colour). */
export function conductorNormalReflectance(nk: (lambdaNm: number) => [number, number], lambdaNm: number): number {
  const [n, k] = nk(lambdaNm)
  return ((n - 1) ** 2 + k * k) / ((n + 1) ** 2 + k * k)
}
