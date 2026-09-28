// materialData.ts — cited liquid-material constants and temperature laws (pure CPU functions, no GPU).
//
// Stage S1.5 of the fluid-realism plan (FINAL-PLAN.md §4.2 "Constants", "Material rules").
// Owner doctrine: exact published equations, cited SI constants, no tuning, no invented numbers.
// Every number below carries a provenance tag:
//   [P]   primary source read (paper, standard, official data page, or the reference implementation's own code)
//   [S]   secondary source (encyclopaedia, vendor table, abstract) — surfaced to the UI as "secondary data"
//   [D]   derived here by arithmetic from cited inputs
//   [EST] estimate — labelled as such, never presented as data
//   [U]   unverified/unsourced — NOT used as a value; the field is null/NaN instead
//
// Units: SI throughout (kg/m³, Pa·s, N/m). Temperatures in °C unless a name says K.
// Temperature only sets ρ(T), μ(T) at spawn (plan §4.2 "Material rules"): there is no heat transfer.
// Outside a law's stated validity range every function returns NaN — no extrapolation, no clamping.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Liquid-state bounds used by the phase gate (liquidGate.validateSpawn / validateScene). */
export interface PhaseBounds {
  /** 1-atm solid→liquid temperature (°C); null = not sourced. */
  freezeC: number | null
  /** 1-atm liquid→gas temperature (°C); null = not sourced / decomposes first. */
  boilC: number | null
  /** Range (°C) over which the property laws below are validated. Spawning outside it is refused. */
  dataRangeC: readonly [number, number]
}

export type LiquidKey =
  | 'water'
  | 'mercury'
  | 'glycerol'
  | 'ethanol'
  | 'olive-oil'
  | 'honey-14pct-25C'
  | 'honey-20pct-25C'
  | 'lava-grd-degassed'
  | 'lava-kilauea-2018-bulk'

export interface LiquidMaterial {
  key: LiquidKey
  /** Menu label. */
  label: string
  formula: string
  defaultTempC: number
  /** kg/m³ at tC, NaN outside dataRangeC. */
  density: (tC: number) => number
  /** Pa·s at tC, NaN outside dataRangeC. */
  viscosity: (tC: number) => number
  /** N/m at tC (display / validity HUD only — the solver has no surface tension, plan §9.1); null when only a range is sourced. */
  surfaceTension: (tC: number) => number | null
  /** Display range for σ (N/m) when the sources disagree or only a range exists. */
  surfaceTensionRangeNm: readonly [number, number] | null
  /** Specific heat J/(kg·K) at tC when sourced; null otherwise (not used by the solver). */
  specificHeat: (tC: number) => number | null
  phase: PhaseBounds
  /** Machine-readable provenance flags, e.g. 'secondary-data', 'estimate:density'. */
  flags: readonly string[]
  /** Primary/secondary source URLs. */
  sources: readonly string[]
  note: string
}

function inRange(tC: number, r: readonly [number, number]): boolean {
  return Number.isFinite(tC) && tC >= r[0] && tC <= r[1]
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WATER
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Source: NIST Chemistry WebBook SRD 69, water isobar at 0.101325 MPa (density: IAPWS-95, Wagner & Pruss 2002;
//         viscosity: IAPWS 2008, Huber et al. 2009), fetched 2026-09-28 [P]:
// Source: https://webbook.nist.gov/cgi/fluid.cgi?Action=Data&Wide=on&ID=C7732185&Type=IsoBar&Digits=7&P=0.101325&THigh=99&TLow=1&TInc=1&RefState=DEF&TUnit=C&PUnit=MPa&DUnit=kg%2Fm3&HUnit=kJ%2Fkg&WUnit=m%2Fs&VisUnit=Pa*s&STUnit=N%2Fm
// The 0.01 °C and 99.9743 °C rows (first liquid row / saturated liquid) come from the same service with TLow=0,
// THigh=100, TInc=0.5. NIST lists liquid water at 0.101325 MPa only from 0.01 °C (triple-point temperature) to
// 99.9743 °C (saturation) — that is the validated range used here.
// Columns: [t °C, ρ kg/m³, μ Pa·s], copied verbatim by script from the NIST tab-delimited output.
//
// Why a table and not the Sharqawy 2010 closed form for μ: measured here against the NIST 0.5 °C isobar,
// Sharqawy Eq. 23 deviates by up to +0.1246 % (at 94.51 °C), above the plan's 0.12 % band, and its stated
// ±0.05 % (Sharqawy 2010 p. 362, Eq. 23 text) is not reproduced. Primary data wins; Sharqawy is kept below as a
// cited closed-form cross-check (e.g. for a future shader), not as the solver value.
const WATER_NIST_1ATM: readonly (readonly [number, number, number])[] = [
  [0.01, 999.8438, 0.001791132], [1, 999.9018, 0.001731021], [2, 999.9430, 0.001673515], [3, 999.9672, 0.001619009], [4, 999.9749, 0.001567292], [5, 999.9666, 0.001518173],
  [6, 999.9429, 0.001471477], [7, 999.9043, 0.001427043], [8, 999.8510, 0.001384724], [9, 999.7836, 0.001344385], [10, 999.7025, 0.001305900], [11, 999.6079, 0.001269155],
  [12, 999.5003, 0.001234043], [13, 999.3801, 0.001200468], [14, 999.2474, 0.001168337], [15, 999.1026, 0.001137568], [16, 998.9461, 0.001108081], [17, 998.7780, 0.001079806],
  [18, 998.5986, 0.001052674], [19, 998.4083, 0.001026624], [20, 998.2072, 0.001001596], [21, 997.9955, 0.0009775372], [22, 997.7735, 0.0009543962], [23, 997.5414, 0.0009321258],
  [24, 997.2994, 0.0009106817], [25, 997.0476, 0.0008900225], [26, 996.7864, 0.0008701093], [27, 996.5158, 0.0008509058], [28, 996.2360, 0.0008323778], [29, 995.9471, 0.0008144932],
  [30, 995.6495, 0.0007972218], [31, 995.3431, 0.0007805353], [32, 995.0281, 0.0007644068], [33, 994.7048, 0.0007488114], [34, 994.3731, 0.0007337251], [35, 994.0333, 0.0007191256],
  [36, 993.6855, 0.0007049918], [37, 993.3298, 0.0006913036], [38, 992.9663, 0.0006780421], [39, 992.5951, 0.0006651895], [40, 992.2164, 0.0006527287], [41, 991.8302, 0.0006406438],
  [42, 991.4366, 0.0006289195], [43, 991.0358, 0.0006175413], [44, 990.6279, 0.0006064956], [45, 990.2129, 0.0005957693], [46, 989.7909, 0.0005853500], [47, 989.3621, 0.0005752260],
  [48, 988.9264, 0.0005653861], [49, 988.4841, 0.0005558196], [50, 988.0350, 0.0005465163], [51, 987.5795, 0.0005374665], [52, 987.1174, 0.0005286611], [53, 986.6490, 0.0005200912],
  [54, 986.1742, 0.0005117483], [55, 985.6931, 0.0005036246], [56, 985.2058, 0.0004957123], [57, 984.7124, 0.0004880040], [58, 984.2129, 0.0004804928], [59, 983.7073, 0.0004731720],
  [60, 983.1958, 0.0004660351], [61, 982.6784, 0.0004590760], [62, 982.1552, 0.0004522887], [63, 981.6261, 0.0004456678], [64, 981.0913, 0.0004392077], [65, 980.5508, 0.0004329032],
  [66, 980.0047, 0.0004267494], [67, 979.4530, 0.0004207415], [68, 978.8957, 0.0004148749], [69, 978.3329, 0.0004091452], [70, 977.7646, 0.0004035482], [71, 977.1910, 0.0003980797],
  [72, 976.6119, 0.0003927360], [73, 976.0275, 0.0003875131], [74, 975.4378, 0.0003824076], [75, 974.8429, 0.0003774158], [76, 974.2427, 0.0003725345], [77, 973.6373, 0.0003677604],
  [78, 973.0268, 0.0003630903], [79, 972.4111, 0.0003585214], [80, 971.7904, 0.0003540507], [81, 971.1646, 0.0003496753], [82, 970.5338, 0.0003453927], [83, 969.8980, 0.0003412001],
  [84, 969.2572, 0.0003370952], [85, 968.6114, 0.0003330755], [86, 967.9608, 0.0003291385], [87, 967.3053, 0.0003252822], [88, 966.6449, 0.0003215043], [89, 965.9796, 0.0003178027],
  [90, 965.3096, 0.0003141753], [91, 964.6348, 0.0003106202], [92, 963.9551, 0.0003071355], [93, 963.2708, 0.0003037193], [94, 962.5817, 0.0003003698], [95, 961.8879, 0.0002970854],
  [96, 961.1894, 0.0002938644], [97, 960.4863, 0.0002907050], [98, 959.7785, 0.0002876059], [99, 959.0661, 0.0002845653], [99.9743, 958.3675, 0.0002816580],
]

export const WATER_T_MIN_C = WATER_NIST_1ATM[0][0]                           // 0.01 °C [P NIST]
export const WATER_T_MAX_C = WATER_NIST_1ATM[WATER_NIST_1ATM.length - 1][0]  // 99.9743 °C [P NIST saturation]

/** Bracketing index i with table[i][0] <= tC <= table[i+1][0]; -1 outside. */
function bracket(table: readonly (readonly number[])[], tC: number): number {
  if (!(tC >= table[0][0] && tC <= table[table.length - 1][0])) return -1
  let lo = 0, hi = table.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (table[mid][0] <= tC) lo = mid; else hi = mid
  }
  return lo
}

/** Water density (kg/m³) at 0.101325 MPa: linear interpolation of the NIST 1 °C table. NaN outside 0.01–99.9743 °C. */
export function waterDensity(tC: number): number {
  const i = bracket(WATER_NIST_1ATM, tC)
  if (i < 0) return NaN
  const [t0, r0] = WATER_NIST_1ATM[i], [t1, r1] = WATER_NIST_1ATM[i + 1]
  return r0 + (r1 - r0) * (tC - t0) / (t1 - t0)
}

/** Water dynamic viscosity (Pa·s) at 0.101325 MPa: log-linear interpolation of the NIST 1 °C table
 *  (μ is close to exponential in T, so ln μ is interpolated). NaN outside 0.01–99.9743 °C. */
export function waterViscosity(tC: number): number {
  const i = bracket(WATER_NIST_1ATM, tC)
  if (i < 0) return NaN
  const [t0, , m0] = WATER_NIST_1ATM[i], [t1, , m1] = WATER_NIST_1ATM[i + 1]
  const f = (tC - t0) / (t1 - t0)
  return Math.exp(Math.log(m0) + (Math.log(m1) - Math.log(m0)) * f)
}

/** Cross-check only (not the solver path). Sharqawy, Lienhard & Zubair 2010, Desalination & Water Treatment 16:354,
 *  Eq. (23): μ_w = 4.2844e-5 + [0.157 (t + 64.993)² − 91.296]⁻¹ kg/(m·s), stated valid 0–180 °C, stated ±0.05 %.
 *  MEASURED here vs NIST: max +0.1246 % at 94.51 °C (0.01–99.97 °C).
 *  Source: https://web.mit.edu/lienhard/www/Thermophysical_properties_of_seawater-DWT-16-354-2010.pdf */
export function waterViscositySharqawy2010(tC: number): number {
  if (!(tC >= 0 && tC <= 180)) return NaN
  return 4.2844e-5 + 1 / (0.157 * (tC + 64.993) ** 2 - 91.296)
}

/** Water–air surface tension (N/m), IAPWS R1-76(2014): σ = B τ^μ (1 + b τ), τ = 1 − T/Tc,
 *  Tc = 647.096 K, B = 235.8 mN/m, b = −0.625, μ = 1.256 [P]. Valid from the triple point to Tc.
 *  Reproduces the release's Table 1 column 4 (e.g. 72.74 mN/m at 20 °C); stated uncertainty ≈ ±0.36 mN/m near 20 °C.
 *  Source: https://iapws.org/technical-guidance/release/Surf-H2O.download */
export function waterSurfaceTension(tC: number): number {
  const T = tC + 273.15
  const Tc = 647.096
  // Triple point 273.16 K = 0.01 °C; compared in °C because 0.01 + 273.15 rounds to 273.15999… in binary floating point.
  if (!(tC >= 0.01 && T < Tc)) return NaN
  const tau = 1 - T / Tc
  return 235.8e-3 * tau ** 1.256 * (1 - 0.625 * tau)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MERCURY
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Density at 20 °C, 101 325 Pa: 13 545.859 kg/m³ — Bettin & Fehlauer 2004, Metrologia 41 S16 (reference value),
// as quoted in the Ayrinhac mercury data compilation [P].
// Source: http://www-ext.impmc.upmc.fr/~ayrinhac/documents/Hg_data.pdf
// Source: https://ui.adsabs.harvard.edu/abs/2004Metro..41S..16B/abstract
export const HG_RHO_20C = 13545.859
// Thermal expansion shape: Beattie polynomial as printed in the same compilation [P]:
//   ρ(t) = 13595.0828 / (1 + 1.815868e-4 t + 5.4583e-9 t² + 3.4980e-11 t³ + 1.5558e-14 t⁴)
// Beattie alone gives 13 545.850 at 20 °C (0.66 ppm below Bettin). We anchor to the newer Bettin reference and use
// Beattie only for the ratio ρ(t)/ρ(20 °C) [D]. The compilation plots Beattie over 250–600 K; its own stated
// validity range was not retrieved [U], so it is only used inside the Assael viscosity range below.
function hgBeattie(tC: number): number {
  return 13595.0828 / (1 + 1.815868e-4 * tC + 5.4583e-9 * tC ** 2 + 3.4980e-11 * tC ** 3 + 1.5558e-14 * tC ** 4)
}
// Viscosity: Assael et al. 2012, J. Phys. Chem. Ref. Data 41, 033101, Eq. (2) with Table 5 [P]:
//   log10(η / mPa·s) = −a1 + a2/T, a1 = 0.2561, a2 = 132.29 K, valid 234–600 K, deviation 2.1 % (95 % confidence).
//   (The minus sign on a1 is confirmed by the paper's Table 3: 1.875 mPa·s at 250 K.) → 1.567 mPa·s at 20 °C.
//   Owner decision D6 (2026-09-28): overrides the previously approved 0.00117 Pa·s.
// Source: https://elib.dlr.de/76579/1/Metal-Pub.pdf
const HG_ASSAEL_T_MIN_K = 234
const HG_ASSAEL_T_MAX_K = 600
// Phase temperatures: T_fus = 234.31 K, T_boil = 629.81 K — Marsh 1987 via NIST WebBook (TRC) [P].
// Source: https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439976&Mask=4
export const HG_FREEZE_C = 234.31 - 273.15   // −38.84 °C
export const HG_BOIL_C = 629.81 - 273.15     // 356.66 °C
const HG_RANGE_C: readonly [number, number] = [HG_FREEZE_C, HG_ASSAEL_T_MAX_K - 273.15]

export function mercuryDensity(tC: number): number {
  if (!inRange(tC, HG_RANGE_C)) return NaN
  return HG_RHO_20C * hgBeattie(tC) / hgBeattie(20)
}
export function mercuryViscosity(tC: number): number {
  const T = tC + 273.15
  if (!(T >= HG_ASSAEL_T_MIN_K && T <= HG_ASSAEL_T_MAX_K) || !inRange(tC, HG_RANGE_C)) return NaN
  return 1e-3 * 10 ** (-0.2561 + 132.29 / T)
}
// Specific heat: Holman & ten Seldam 1994 polynomial as printed in the Ayrinhac compilation [P via r4]:
//   c_p = 152.2958 − 0.0610935 T + 5.66063e-5 T² − 2.704e-9 T³ J/(kg·K) → 139.2 at 293.15 K.
function mercurySpecificHeat(tC: number): number | null {
  if (!inRange(tC, HG_RANGE_C)) return null
  const T = tC + 273.15
  return 152.2958 - 0.0610935 * T + 5.66063e-5 * T ** 2 - 2.704e-9 * T ** 3
}
// Surface tension: published values disagree (contamination-sensitive) — display the range only (D6):
//   0.4865 N/m in vacuo at 20 °C (Perry & Roberts 1981, J. Chem. Eng. Data 26:266, abstract) [S];
//   0.42541 N/m at 20 °C (DataPhysics vendor table) [S].
// Source: https://pubs.acs.org/doi/10.1021/je00025a012
// Source: https://www.dataphysics-instruments.com/resources/Downloads/Surface-Tensions-Energies.pdf?v=1.0
const HG_SIGMA_RANGE: readonly [number, number] = [0.42541, 0.4865]

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GLYCEROL (anhydrous)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Viscosity: Cheng 2008 (Ind. Eng. Chem. Res. 47:3285) as implemented in the Reading glycerol–water calculator,
//   source line verbatim: "var viscosity_glycerol=0.001*12100*Math.exp((-1233+T)*T/(9900+70*T));"  (Pa·s, T in °C)
//   → 1.414 Pa·s at 20 °C. Range 0–100 °C [P code; the paper itself was paywalled → S].
// Density: Volk & Kähler 2018 fit in the same source: "var density_glycerol=1273-0.612*T" (kg/m³) → 1260.8 at 20 °C [P code].
// Source: https://www.met.reading.ac.uk/~sws04cdw/viscosity_calc.html
// Source: https://pubs.acs.org/doi/10.1021/ie071349z
// Phase: triple point 291.8 K (18.65 °C), Wilhoit, Chao et al. 1985 via NIST WebBook (TRC) [P]; glycerol supercools
//   readily and Cheng's correlation covers the (metastable) liquid down to 0 °C, so the freezing bound is left null
//   and the 0–100 °C data range governs spawning. Boiling: NIST lists only an average of 6 values, 550 ± 40 K [P];
//   used as the boiling bound for the pairwise thermal gate.
// Source: https://webbook.nist.gov/cgi/cbook.cgi?ID=C56815&Mask=4
// Hygroscopy caveat (arXiv 2301.08329 abstract [S]): real glycerol absorbs water and thins; this is the anhydrous law.
const GLY_RANGE_C: readonly [number, number] = [0, 100]
export const GLYCEROL_TRIPLE_C = 291.8 - 273.15
export function glycerolDensity(tC: number): number {
  return inRange(tC, GLY_RANGE_C) ? 1273 - 0.612 * tC : NaN
}
export function glycerolViscosity(tC: number): number {
  return inRange(tC, GLY_RANGE_C) ? 12.1 * Math.exp((-1233 + tC) * tC / (9900 + 70 * tC)) : NaN
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ETHANOL
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Viscosity at 0.1 MPa: Sotiriadou et al. 2023 (NIST), Eq. (13) [P]:
//   η = exp(−0.721846 θ⁴ + 5.91281 θ³ − 15.0092 θ² + 20.9305 θ − 3.62716) µPa·s, θ = 273.15/T,
//   valid from the triple point (159 K) to the 0.1 MPa boiling temperature 351.57 K, uncertainty 2.3 % (95 %).
//   → 1.192 mPa·s at 20 °C.
// Source: https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=935954
// Density: CoolProp saturated-liquid ancillary fitted to the Schroeder et al. 2014 EOS (type rhoLnoexp) [P code]:
//   ρ' = ρc (1 + Σ nᵢ θ^tᵢ), θ = 1 − T/514.71 K, ρc = 5930 mol/m³, M = 0.04606844 kg/mol,
//   stated max error of the ancillary 0.737 % (vs. the EOS) → 789.31 kg/m³ at 20 °C.
// Source: https://raw.githubusercontent.com/CoolProp/CoolProp/master/dev/fluids/Ethanol.json
// Surface tension (display): Mulero et al. 2012 via the same file: σ = 0.05 (1 − T/513.9)^0.952 N/m [P code].
const ETH_T_TRIPLE_K = 159
const ETH_T_BOIL_K = 351.57
const ETH_RANGE_C: readonly [number, number] = [ETH_T_TRIPLE_K - 273.15, ETH_T_BOIL_K - 273.15]
// Validated SPAWN range starts at 200 K, not at the triple point [D, S1.5 review]: the same paper's Table 7 (0.1 MPa, full
// correlation Eqs. 1, 8–12, stated 4.2 %) and Eq. 13 (stated 2.3 %) differ by 6.99 % at 180 K — more than their combined
// 95 % uncertainty √(2.3² + 4.2²) = 4.79 % — while at 200–340 K they agree to ≤ 3.3 % (materials gate D0). So the value
// below 200 K is not validated to its stated uncertainty. The triple point (159 K) remains the freezing bound.
const ETH_DATA_T_MIN_K = 200
const ETH_DATA_RANGE_C: readonly [number, number] = [ETH_DATA_T_MIN_K - 273.15, ETH_T_BOIL_K - 273.15]
const ETH_ANC_N = [7.824518623386008, -338.93732001583646, 368.3422016038343, -90.14206962630433, 80.35347134933373, -26.00710239571597]
const ETH_ANC_T = [0.596, 1.495, 1.561, 2.737, 3.606, 4.943]
export function ethanolDensity(tC: number): number {
  if (!inRange(tC, ETH_RANGE_C)) return NaN
  const th = 1 - (tC + 273.15) / 514.71
  let s = 0
  for (let i = 0; i < ETH_ANC_N.length; i++) s += ETH_ANC_N[i] * th ** ETH_ANC_T[i]
  return 5930 * (1 + s) * 0.04606844
}
export function ethanolViscosity(tC: number): number {
  if (!inRange(tC, ETH_RANGE_C)) return NaN
  const th = 273.15 / (tC + 273.15)
  return 1e-6 * Math.exp(-0.721846 * th ** 4 + 5.91281 * th ** 3 - 15.0092 * th ** 2 + 20.9305 * th - 3.62716)
}
function ethanolSurfaceTension(tC: number): number | null {
  if (!inRange(tC, ETH_RANGE_C)) return null
  return 0.05 * (1 - (tC + 273.15) / 513.9) ** 0.952
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// OLIVE OIL — SECONDARY DATA (plan §4.2: flagged in the UI as "secondary data")
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wikipedia "Olive oil" infobox [S]: specific gravity 0.911 at 20 °C (citing the USDA olive-oil grading manual);
//   viscosity 84 cP at 20 °C (no footnote). The reference-water temperature of the specific gravity is not stated,
//   so ρ is 909.4–911 kg/m³; 911 is the plan's value.
// Cross-checks (r4, [P]): 0.070–0.074 Pa·s at 23 °C (Vallesquino-Laguna 2023, mill fluids); 182.9 mPa·s at 5 °C
//   (Stanciu 2019 compilation). No olive-oil-specific temperature law was obtained [U] → spawn only at 20 °C.
// Source: https://en.wikipedia.org/wiki/Olive_oil
const OLIVE_T_C = 20

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HONEY — SECONDARY DATA, only with a stated moisture preset (owner decision 2026-09-28)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wikipedia "Honey" [S]: "At 25 °C, honey with 14% water content generally has a viscosity around 400 poise, while a
//   honey containing 20% water has a viscosity around 20 poise." → 40 Pa·s and 2 Pa·s at 25 °C only.
//   "The density of honey typically ranges between 1.38 and 1.45 kg/L at 20 °C." — the moisture pairing of density is
//   not given, so ρ = 1415 kg/m³ is an ESTIMATE (midpoint of the stated range), flagged 'estimate:density'.
//   Surface tension "50–60 mJ/m²" (range, display only).
// Source: https://en.wikipedia.org/wiki/Honey
const HONEY_T_C = 25
const HONEY_RHO_EST = (1380 + 1450) / 2 // [EST] midpoint of the [S] 1380–1450 kg/m³ range at 20 °C

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LAVA — Giordano, Russell & Dingwell 2008 (GRD) silicate-melt viscosity model
// ─────────────────────────────────────────────────────────────────────────────────────────────
// GRD 2008, EPSL 271:123–134: log10 η (Pa·s) = A + B/(T[K] − C), A = −4.55, B and C from the melt's mole-% oxides.
// RMSE 0.40 log units; calibrated on SiO2 41–79, TiO2 0–3, Al2O3 0–23, FeOT 0–12, MnO 0–0.3, MgO 0–32, CaO 0–26,
// Na2O 0–11, K2O 0.3–9, P2O5 0–1.2 wt% (anhydrous data 535–1705 °C); Tg is where η = 10^12 Pa·s [P].
// Source: https://www.eoas.ubc.ca/~krussell/VISCOSITY/grdViscosity_files/grdViscosityPaper.pdf
// Port below is line-for-line from the authors' calculator (molePct, grdmodel) [P code]:
// Source: https://www.eoas.ubc.ca/~krussell/VISCOSITY/grd08.js

/** Oxide order used by GRD: SiO2, TiO2, Al2O3, FeO(T), MnO, MgO, CaO, Na2O, K2O, P2O5, H2O, F2O-1 (wt%). */
export const GRD_OXIDES = ['SiO2', 'TiO2', 'Al2O3', 'FeO', 'MnO', 'MgO', 'CaO', 'Na2O', 'K2O', 'P2O5', 'H2O', 'F2O-1'] as const
const GRD_MW = [60.0843, 79.8658, 101.961276, 71.8444, 70.937449, 40.3044, 56.0774, 61.97894, 94.1960, 141.9446, 18.01528, 18.9984]
/** GRD 2008 calibration ranges (wt%) for the 10 anhydrous oxides + H2O (0–8 wt%). */
export const GRD_CALIBRATION_WT: readonly (readonly [number, number])[] = [
  [41, 79], [0, 3], [0, 23], [0, 12], [0, 0.3], [0, 32], [0, 26], [0, 11], [0.3, 9], [0, 1.2], [0, 8], [0, 4],
]
export const GRD_A = -4.55
/** GRD 2008 §2 calibration temperature spans (°C): anhydrous data 535–1705 °C, volatile (H2O, F) enriched data
 *  245–1580 °C [P]. Viscosities outside the span a melt belongs to are extrapolation → NaN in the element model. */
export const GRD_CALIBRATION_T_C = { anhydrous: [535, 1705], volatileBearing: [245, 1580] } as const

export interface GrdVft { A: number; B: number; C: number; TgK: number }

/** GRD 2008 VFT coefficients for a melt given as 12 oxide wt% (order GRD_OXIDES). Port of grd08.js molePct+grdmodel. */
export function grdVft(wt: readonly number[]): GrdVft {
  const x = grdMolePct(wt)
  const bb = [159.56, -173.34, 72.13, 75.69, -38.98, -84.08, 141.54, -2.43, -0.91, 17.62]
  const cc = [2.75, 15.72, 8.32, 10.2, -12.29, -99.54, 0.3]
  const siti = x[0] + x[1], tial = x[1] + x[2], fmm = x[3] + x[4] + x[5], nak = x[7] + x[8]
  const b = [siti, x[2], x[3] + x[4] + x[9], x[5], x[6], x[7] + x[10] + x[11],
    x[10] + x[11] + Math.log(1 + x[10]), siti * fmm, (siti + x[2] + x[9]) * (nak + x[10]), x[2] * nak]
  const c11 = (x[2] + fmm + x[6] - x[9]) * (nak + x[10] + x[11])
  const c = [x[0], tial, fmm, x[6], nak, Math.log(1 + x[10] + x[11]), c11]
  let B = 0, C = 0
  for (let j = 0; j < 10; j++) B += bb[j] * b[j]
  for (let j = 0; j < 7; j++) C += cc[j] * c[j]
  const TgK = B / (12 - GRD_A) + C
  return { A: GRD_A, B, C, TgK }
}

/** GRD 2008 oxide wt% → mole % (grd08.js molePct: volatile-free renormalisation, F as F2O-1 halved). */
export function grdMolePct(wt: readonly number[]): number[] {
  if (wt.length !== 12) throw new Error('grdMolePct: need 12 oxide wt% values')
  const mult = 100 - wt[10]
  let div = 0
  for (let j = 0; j < 12; j++) div += wt[j]
  div -= wt[10]
  const m = mult / div
  const wtn: number[] = []
  for (let j = 0; j < 10; j++) wtn[j] = wt[j] * m
  wtn[10] = wt[10]
  wtn[11] = 0.5 * wt[11] * m
  const mp = wtn.map((w, j) => w / GRD_MW[j])
  const sum = mp.reduce((s, v) => s + v, 0)
  return mp.map(v => 100 * v / sum)
}

/** η (Pa·s) from VFT coefficients at tC. */
export function vftViscosity(v: { A: number; B: number; C: number }, tC: number): number {
  const T = tC + 273.15
  if (!(T > v.C)) return NaN
  return 10 ** (v.A + v.B / (T - v.C))
}

/** Which calibration bounds a composition violates (empty = inside GRD 2008 calibration). */
export function grdCalibrationViolations(wt: readonly number[]): string[] {
  const out: string[] = []
  const anhydrousSum = wt.slice(0, 10).reduce((s, v) => s + v, 0)
  for (let j = 0; j < 12; j++) {
    const v = j < 10 ? 100 * wt[j] / anhydrousSum : wt[j]
    const [lo, hi] = GRD_CALIBRATION_WT[j]
    if (v < lo || v > hi) out.push(`${GRD_OXIDES[j]} ${v.toFixed(2)} wt% outside GRD 2008 calibration ${lo}–${hi}`)
  }
  return out
}

// Preset "degassed basaltic melt (GRD)" — DEFAULT lava (owner decision D13, 2026-09-28):
//   GRD on the mean EPMA glass of Kīlauea 2018 Fissure 8 (USGS data release, Lee et al. 2019, n = 362; SiO2 51.22,
//   TiO2 3.03, Al2O3 13.10, FeOT 11.89, MnO 0.17, MgO 5.96, CaO 9.99, Na2O 2.58, K2O 0.57, P2O5 0.30 wt%, anhydrous)
//   → log10 η = −4.55 + 5963/(T[K] − 600.7) [D, r4]; 1477 / 501 / 193 / 82 Pa·s at 1100 / 1150 / 1200 / 1250 °C.
//   The port above on that 2-decimal composition gives B = 5962.0, C = 600.70; ±0.005 wt% composition rounding moves
//   B over 5959.5–5964.7 [D], so the owner-approved 5963 is inside rounding. TiO2 3.03 is 0.03 wt% above calibration.
// Source: https://www.sciencebase.gov/catalog/item/5d3279d2e4b01d82ce8791b2
// Density 2600 kg/m³ = dense-rock (DRE) default of PyFLOWGO's lava material, `self._density_dre = 2600.` [P code].
// Source: https://raw.githubusercontent.com/pyflowgo/pyflowgo/main/pyflowgo/flowgo_material_lava.py
// Spawn range 1100–1250 °C [PROPOSED]: the span r4 evaluated and the plan's own S3 gates use (S3.7 Stokes fall at 1100 °C,
//   S3.6d at 1200 °C); above 1250 °C it was not cross-checked. This preset is a crystal-free MELT by definition (plan D11
//   label "isothermal melt, Newtonian"). Real Fissure 8 lava is below its experimental whole-rock liquidus (1190–1200 °C,
//   Halverson & Whittington 2024 line 90) over most of this range and then carries crystals (Table 1: 5.6 % at 1150 °C,
//   12.6 % at 1115 °C, 30.8 % at 1105 °C) and shear-thins — that is the stated model limit of the melt preset, not a claim
//   that the bulk lava is a melt there. Solidus: not sourced [U] → freezeC null.
// Surface tension 350–370 mN/m (Walker & Mullins 1981 abstract [S]) — display range only.
// Model limits (plan D11): isothermal, Newtonian melt — no crust, crystallisation, yield strength or shear-thinning.
export const LAVA_GRD_F8_OXIDES_WT: readonly number[] = [51.22, 3.03, 13.10, 11.89, 0.17, 5.96, 9.99, 2.58, 0.57, 0.30, 0, 0]
export const LAVA_GRD_PRESET = { A: -4.55, B: 5963, C: 600.7 } as const
const LAVA_GRD_RANGE_C: readonly [number, number] = [1100, 1250]

// Preset "Kīlauea 2018 bulk lava, 1150 °C" (secondary preset, D13):
//   μ = 116 Pa·s: "average viscosities of 116 Pa·s at 1150 °C" for three-phase (crystals + bubbles) Fissure 8 lava,
//   Halverson & Whittington 2024, Geology 53:135 (NSF PAR manuscript line 34) [P]. Measured at one temperature only.
// Source: https://par.nsf.gov/servlets/purl/10621035
//   Bulk density is NOT measured in the source [U]. Vesicularity during the 1150 °C run [P, Table 1]: every HTTPI run starts
//   from the 20-min hold at 1175 °C (lines 89–93) whose quenched "zero-time sample" is 36.1 % vesicular, and the recovered
//   1150 °C product is 19.2 % (Table 1; the PDF text extraction shifts Table 1's values down one row — the mapping is fixed
//   by the prose, lines 116–124: crystallinity ~14/6/13/31 % and vesicularity 36/~19/~19/31 % at 1175/1150/1115/1105 °C).
//   Line 173's "16% vesicularity decrease from the zero-time material" is this 36.1 → 19.2 drop. (The "~34 %" of line 78 is
//   the cold starting rock F8.13 before the 1175 °C hold, not the run's start.) With the 2600 kg/m³ DRE above:
//   ρ_bulk = 2600 (1 − φ) = 1661.4 (start) – 2100.8 (end) kg/m³ [D]. Nominal = the start-of-run value, ≈ the owner-approved
//   "ρ ≈ 1660" (D13), flagged 'unverified:density-pairing'; the bracket is exported for the UI.
export const LAVA_KILAUEA_VESICULARITY_1150C: readonly [number, number] = [0.361, 0.192]
export const LAVA_KILAUEA_BULK_RHO_BRACKET: readonly [number, number] = [2600 * (1 - 0.361), 2600 * (1 - 0.192)]
const LAVA_KILAUEA_T_C = 1150

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Registry of cited liquids
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WATER_RANGE: readonly [number, number] = [WATER_T_MIN_C, WATER_T_MAX_C]

export const LIQUIDS: Readonly<Record<LiquidKey, LiquidMaterial>> = {
  water: {
    key: 'water', label: 'Water', formula: 'H₂O', defaultTempC: 20,
    density: waterDensity,
    viscosity: waterViscosity,
    surfaceTension: (t) => { const s = waterSurfaceTension(t); return Number.isFinite(s) ? s : null },
    surfaceTensionRangeNm: null,
    specificHeat: () => null,
    // Liquid bounds at 0.101325 MPa as tabulated by NIST (see table header above).
    phase: { freezeC: WATER_T_MIN_C, boilC: WATER_T_MAX_C, dataRangeC: WATER_RANGE },
    flags: ['source:primary'],
    sources: [
      'https://webbook.nist.gov/cgi/fluid.cgi?ID=C7732185',
      'https://iapws.org/technical-guidance/release/Surf-H2O.download',
    ],
    note: 'ρ(T), μ(T): NIST WebBook isobar 0.101325 MPa (IAPWS-95 / IAPWS 2008); σ(T): IAPWS R1-76 (display only).',
  },
  mercury: {
    key: 'mercury', label: 'Mercury', formula: 'Hg', defaultTempC: 20,
    density: mercuryDensity,
    viscosity: mercuryViscosity,
    surfaceTension: () => null,
    surfaceTensionRangeNm: HG_SIGMA_RANGE,
    specificHeat: mercurySpecificHeat,
    phase: { freezeC: HG_FREEZE_C, boilC: HG_BOIL_C, dataRangeC: HG_RANGE_C },
    flags: ['source:primary'],
    sources: [
      'https://elib.dlr.de/76579/1/Metal-Pub.pdf',
      'http://www-ext.impmc.upmc.fr/~ayrinhac/documents/Hg_data.pdf',
      'https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439976&Mask=4',
    ],
    note: 'μ: Assael 2012 (±2.1 %); ρ: Bettin & Fehlauer 2004 at 20 °C with Beattie expansion; σ disputed 0.425–0.487 N/m (display range).',
  },
  glycerol: {
    key: 'glycerol', label: 'Glycerol (anhydrous)', formula: 'C₃H₈O₃', defaultTempC: 20,
    density: glycerolDensity,
    viscosity: glycerolViscosity,
    // DataPhysics vendor table: 64.0 mN/m at 20 °C, dσ/dT = −0.0598 mN/(m·K) [S] — display only.
    surfaceTension: (t) => inRange(t, GLY_RANGE_C) ? (64.0 - 0.0598 * (t - 20)) * 1e-3 : null,
    surfaceTensionRangeNm: null,
    specificHeat: () => null,
    phase: { freezeC: null, boilC: 550 - 273.15, dataRangeC: GLY_RANGE_C },
    flags: ['source:primary', 'anhydrous:hygroscopic-caveat', 'secondary-data:surface-tension'],
    sources: [
      'https://www.met.reading.ac.uk/~sws04cdw/viscosity_calc.html',
      'https://webbook.nist.gov/cgi/cbook.cgi?ID=C56815&Mask=4',
    ],
    note: 'Cheng 2008 μ(T) and Volk & Kähler 2018 ρ(T) as coded in the Reading calculator, 0–100 °C. Supercooled below 18.65 °C (triple point).',
  },
  ethanol: {
    key: 'ethanol', label: 'Ethanol', formula: 'C₂H₅OH', defaultTempC: 20,
    density: ethanolDensity,
    viscosity: ethanolViscosity,
    surfaceTension: ethanolSurfaceTension,
    surfaceTensionRangeNm: null,
    specificHeat: () => null,
    phase: { freezeC: ETH_RANGE_C[0], boilC: ETH_RANGE_C[1], dataRangeC: ETH_DATA_RANGE_C },
    flags: ['source:primary', 'ancillary-density:max-0.74pct'],
    sources: [
      'https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=935954',
      'https://raw.githubusercontent.com/CoolProp/CoolProp/master/dev/fluids/Ethanol.json',
    ],
    note: 'μ: Sotiriadou 2023 Eq. 13 (2.3 %); ρ: CoolProp saturated-liquid ancillary of the Schroeder 2014 EOS (≤0.74 %).',
  },
  'olive-oil': {
    key: 'olive-oil', label: 'Olive Oil', formula: 'C₅₅H₁₀₄O₆', defaultTempC: OLIVE_T_C,
    density: (t) => t === OLIVE_T_C ? 911 : NaN,
    viscosity: (t) => t === OLIVE_T_C ? 0.084 : NaN,
    surfaceTension: () => null,
    surfaceTensionRangeNm: null,
    specificHeat: () => null,
    phase: { freezeC: null, boilC: null, dataRangeC: [OLIVE_T_C, OLIVE_T_C] },
    flags: ['secondary-data', 'no-temperature-law:20C-only'],
    sources: ['https://en.wikipedia.org/wiki/Olive_oil'],
    note: 'Secondary data (Wikipedia infobox): SG 0.911, 84 cP at 20 °C. No temperature law sourced → 20 °C only.',
  },
  'honey-14pct-25C': {
    key: 'honey-14pct-25C', label: 'Honey (14 % water, 25 °C)', formula: 'honey', defaultTempC: HONEY_T_C,
    density: (t) => t === HONEY_T_C ? HONEY_RHO_EST : NaN,
    viscosity: (t) => t === HONEY_T_C ? 40 : NaN,
    surfaceTension: () => null,
    surfaceTensionRangeNm: [0.050, 0.060],
    specificHeat: () => null,
    phase: { freezeC: null, boilC: null, dataRangeC: [HONEY_T_C, HONEY_T_C] },
    flags: ['secondary-data', 'moisture-preset:14pct', 'estimate:density', 'no-temperature-law:25C-only'],
    sources: ['https://en.wikipedia.org/wiki/Honey'],
    note: 'Secondary data: "around 400 poise" at 25 °C for 14 % water. ρ is an estimate (midpoint of 1.38–1.45 kg/L).',
  },
  'honey-20pct-25C': {
    key: 'honey-20pct-25C', label: 'Honey (20 % water, 25 °C)', formula: 'honey', defaultTempC: HONEY_T_C,
    density: (t) => t === HONEY_T_C ? HONEY_RHO_EST : NaN,
    viscosity: (t) => t === HONEY_T_C ? 2 : NaN,
    surfaceTension: () => null,
    surfaceTensionRangeNm: [0.050, 0.060],
    specificHeat: () => null,
    phase: { freezeC: null, boilC: null, dataRangeC: [HONEY_T_C, HONEY_T_C] },
    flags: ['secondary-data', 'moisture-preset:20pct', 'estimate:density', 'no-temperature-law:25C-only'],
    sources: ['https://en.wikipedia.org/wiki/Honey'],
    note: 'Secondary data: "around 20 poise" at 25 °C for 20 % water. ρ is an estimate (midpoint of 1.38–1.45 kg/L).',
  },
  'lava-grd-degassed': {
    key: 'lava-grd-degassed', label: 'Lava (degassed basaltic melt, GRD)', formula: 'Basalt melt', defaultTempC: 1200,
    density: (t) => inRange(t, LAVA_GRD_RANGE_C) ? 2600 : NaN,
    viscosity: (t) => inRange(t, LAVA_GRD_RANGE_C) ? vftViscosity(LAVA_GRD_PRESET, t) : NaN,
    surfaceTension: () => null,
    surfaceTensionRangeNm: [0.350, 0.370],
    specificHeat: () => null,
    phase: { freezeC: null, boilC: null, dataRangeC: LAVA_GRD_RANGE_C },
    flags: ['source:primary', 'model:isothermal-newtonian-melt', 'unsourced:solidus'],
    sources: [
      'https://www.eoas.ubc.ca/~krussell/VISCOSITY/grdViscosity_files/grdViscosityPaper.pdf',
      'https://www.sciencebase.gov/catalog/item/5d3279d2e4b01d82ce8791b2',
      'https://raw.githubusercontent.com/pyflowgo/pyflowgo/main/pyflowgo/flowgo_material_lava.py',
    ],
    note: 'GRD 2008 on Kīlauea 2018 Fissure 8 glass: log10 η = −4.55 + 5963/(T − 600.7); ρ 2600 (DRE). Isothermal Newtonian melt.',
  },
  'lava-kilauea-2018-bulk': {
    key: 'lava-kilauea-2018-bulk', label: 'Lava (Kīlauea 2018 bulk, 1150 °C)', formula: 'Basalt lava', defaultTempC: LAVA_KILAUEA_T_C,
    density: (t) => t === LAVA_KILAUEA_T_C ? LAVA_KILAUEA_BULK_RHO_BRACKET[0] : NaN,
    viscosity: (t) => t === LAVA_KILAUEA_T_C ? 116 : NaN,
    surfaceTension: () => null,
    surfaceTensionRangeNm: [0.350, 0.370],
    specificHeat: () => null,
    phase: { freezeC: null, boilC: null, dataRangeC: [LAVA_KILAUEA_T_C, LAVA_KILAUEA_T_C] },
    flags: ['source:primary:viscosity', 'unverified:density-pairing', 'model:isothermal-newtonian-melt', 'unsourced:solidus'],
    sources: ['https://par.nsf.gov/servlets/purl/10621035'],
    note: 'μ 116 Pa·s measured at 1150 °C (Halverson & Whittington 2024). ρ 1661 derived (start of run); vesicularity 36.1 %→19.2 % during the run brackets 1661–2101 kg/m³.',
  },
}

export const LIQUID_KEYS = Object.keys(LIQUIDS) as LiquidKey[]

export function isLiquidKey(k: string | undefined | null): k is LiquidKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(LIQUIDS, k)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference solids (phase gate for the legacy default menu entries)
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type SolidRefKey = 'salt' | 'iron' | 'copper'
export interface SolidReference {
  key: SolidRefKey
  /** 1-atm melting temperature, °C. */
  freezeC: number
  /** Why the liquid is not offered (null = liquid data would be acceptable above freezeC). */
  liquidUnsourced: string | null
  source: string
  note: string
}
export const SOLID_REFERENCE: Readonly<Record<SolidRefKey, SolidReference>> = {
  // NIST WebBook condensed-phase Shomate fits (Chase 1998, JANAF): solid 298–1073 K, liquid from 1074 K [P].
  salt: {
    key: 'salt', freezeC: 1074 - 273.15, liquidUnsourced: 'molten NaCl viscosity/density not sourced (legacy Arrhenius extrapolation is [U])',
    source: 'https://webbook.nist.gov/cgi/cbook.cgi?ID=C7647145&Mask=2',
    note: 'NaCl is a crystalline solid at 20 °C (melts at ≈ 1074 K per JANAF phase ranges).',
  },
  // NIST WebBook condensed-phase Shomate fits (Chase 1998, JANAF): solid 298–1809 K, liquid from 1809 K [P].
  iron: {
    key: 'iron', freezeC: 1809 - 273.15, liquidUnsourced: 'liquid Fe viscosity (Assael 2006) and density not retrieved [U]',
    source: 'https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439896&Mask=2',
    note: 'Iron is a solid at 20 °C (melts at ≈ 1809 K per JANAF phase ranges).',
  },
  // Freezing point of copper = ITS-90 defining fixed point, T90 = 1357.77 K (1084.62 °C) (Preston-Thomas 1990, Metrologia 27:3,
  // Table 1; transcription [S] at its-90.com). (NIST WebBook's TRC "catalog nominal" 1357.95 K is not the fixed point.)
  // Liquid density not sourced → hidden (owner decision D7).
  copper: {
    key: 'copper', freezeC: 1357.77 - 273.15, liquidUnsourced: 'liquid copper density not sourced from a primary reference (D7: hidden)',
    source: 'https://www.its-90.com/fixed-points',
    note: 'Liquid above 1084.62 °C, but its liquid density is unsourced, so it is hidden from the liquid menu.',
  },
}

export function isSolidRefKey(k: string | undefined | null): k is SolidRefKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(SOLID_REFERENCE, k)
}
