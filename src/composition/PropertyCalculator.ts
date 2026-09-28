// PropertyCalculator.ts — Compute material properties from element composition
// Implements structure.md §3.1 formulas using real physics
// Data sourced from docs/element-properties.md (NIST, CRC Handbook, ASM International)
//
// S1.5 material-data fixes (fluid-realism plan, r4 §C.1), 2026-09-28:
//   1. Silicate branch: compositions that used to match the silica-glass signature (Si > 0.2, O > 0.35) — including the
//      default basalt lava — got 1e6 Pa·s at 1700 °C with Ea = 500 kJ/mol, i.e. 3.1e10 Pa·s at 1200 °C, silently clamped
//      to 1e8. They now go through the Giordano–Russell–Dingwell 2008 melt model (materialData.grdVft) when the oxide
//      composition lies inside GRD's calibration; outside it the viscosity is NaN ("unmodelled"), never a guessed number.
//   2. Water: ρ(T), μ(T) from the NIST 0.101325 MPa isobar, σ(T) from IAPWS R1-76 (materialData), replacing the
//      ρ = 1000 constant, the Ea = 17 kJ/mol Arrhenius law (−20 % at 100 °C) and the constant σ.
//   3. debyeFunction() bug (returns up to ≈2, discontinuous at x = 3) is no longer applied: it multiplied MEASURED
//      room-temperature c_p values, double-counting the lattice correction (Fe 517.5 vs table 449 J/(kg·K)).
//   4. Placeholder numbers removed: 1e6 Pa·s "solid", 0.001 Pa·s "default liquid", 0.004 "default molten metal",
//      0.03/0.5 N/m "default" surface tensions, and the Math.min(…, 1e8) / Math.max(1e-4, …) clamps → NaN + a flag.
//      (Review fix: the display-only σ floors Math.max(0.001, …) / Math.max(0.01, …) are gone too → NaN when ≤ 0.)
//   5. Review fix: no extrapolation. The GRD branch returns NaN outside GRD 2008's calibrated temperature span and below
//      Tg; Tg is no longer used as a "melting point" (a silicate's liquidus is unsourced → NaN). Every branch except
//      water states in DerivedProps.unsourcedReason why its liquid-state values are not sourced, and the spawn gate
//      (liquidGate.validateSpawn via CompositionTable) refuses those compositions at every temperature.
//   Every derived value now carries provenance in DerivedProps.flags.

import {
  waterDensity, waterViscosity, waterSurfaceTension, WATER_T_MIN_C, WATER_T_MAX_C,
  grdVft, vftViscosity, grdCalibrationViolations, GRD_CALIBRATION_T_C,
} from './materialData'

// 25 gameplay elements from docs/element-properties.md
export const ELEMENTS = [
  'H', 'C', 'N', 'O', 'Na', 'Mg', 'Al', 'Si', 'P', 'S',
  'Cl', 'K', 'Ca', 'Ti', 'Cr', 'Mn', 'Fe', 'Ni', 'Cu', 'Zn',
  'Sn', 'Pb', 'Ag', 'Au', 'W',
] as const

export type ElementName = typeof ELEMENTS[number]

// ── Physical Constants ──────────────────────────────────────────────────────
const R_GAS = 8.314        // J/(mol·K)
const EÖTVÖS_K = 2.1e-7    // J/(K·mol^(2/3)) — Eötvös constant

// ── Element Property Table ──────────────────────────────────────────────────
// All values from docs/element-properties.md Tables 1-8, 15
// This is the ONLY static data — everything else is computed.

interface ElementProps {
  Z: number                 // atomic number
  mass: number              // g/mol
  density: number           // kg/m³ (solid phase)
  meltingPoint: number      // °C
  boilingPoint: number      // °C
  latentFusion: number      // kJ/kg
  latentVaporization: number // kJ/kg
  specificHeat: number      // J/(kg·K)
  debyeTemp: number         // K
  thermalCond: number       // W/(m·K)
  thermalExpansion: number  // 10⁻⁶/K
  youngsMod: number         // GPa
  poissonRatio: number      // dimensionless
  tensileStr: number        // MPa
  mohsHardness: number      // Mohs scale
  crystalStructure: 'FCC' | 'BCC' | 'HCP' | 'DC' | 'BCT' | 'Hex' | 'Orth' | 'Cub'
  emissivity: number        // 0-1 (polished)
  soundSpeed: number        // m/s
  electrodePotential: number // V vs SHE
  gruneisen: number         // dimensionless
  // Andrade/Arrhenius viscosity: μ = A·exp(Ea/(R·T))
  viscosity_A: number       // mPa·s
  viscosity_Ea: number      // kJ/mol
  // Liquid surface tension at melting point
  surfaceTension_Tm: number // N/m
  // Color (base RGB for rendering)
  color: [number, number, number]
  // Is this element metallic?
  isMetal: boolean
}

export const ELEMENT_DATA: Record<ElementName, ElementProps> = {
  H:  { Z:1,  mass:1.008,   density:71,    meltingPoint:-259, boilingPoint:-253, latentFusion:119,    latentVaporization:448,    specificHeat:14304, debyeTemp:122,  thermalCond:0.18,  thermalExpansion:0,    youngsMod:0,   poissonRatio:0,    tensileStr:0,   mohsHardness:0,   crystalStructure:'HCP',  emissivity:0.5,  soundSpeed:1310, electrodePotential:0,     gruneisen:0.6,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[0.9,0.9,1.0],  isMetal:false },
  C:  { Z:6,  mass:12.011,  density:2267,  meltingPoint:3550, boilingPoint:4027, latentFusion:9741,   latentVaporization:59529,  specificHeat:709,   debyeTemp:2230, thermalCond:140,   thermalExpansion:7.1,  youngsMod:33,  poissonRatio:0.17, tensileStr:0,   mohsHardness:0.5, crystalStructure:'Hex',  emissivity:0.81, soundSpeed:12000,electrodePotential:0,     gruneisen:1.0,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[0.15,0.15,0.15], isMetal:false },
  N:  { Z:7,  mass:14.007,  density:1026,  meltingPoint:-210, boilingPoint:-196, latentFusion:51.4,   latentVaporization:199.2,  specificHeat:1040,  debyeTemp:70,   thermalCond:0.026, thermalExpansion:0,    youngsMod:0,   poissonRatio:0,    tensileStr:0,   mohsHardness:0,   crystalStructure:'HCP',  emissivity:0.5,  soundSpeed:353,  electrodePotential:0,     gruneisen:0.7,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[0.9,0.9,1.0],  isMetal:false },
  O:  { Z:8,  mass:15.999,  density:1141,  meltingPoint:-218, boilingPoint:-183, latentFusion:27.5,   latentVaporization:213.1,  specificHeat:918,   debyeTemp:70,   thermalCond:0.027, thermalExpansion:0,    youngsMod:0,   poissonRatio:0,    tensileStr:0,   mohsHardness:0,   crystalStructure:'Cub',  emissivity:0.5,  soundSpeed:330,  electrodePotential:0,     gruneisen:0.7,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[0.5,0.7,1.0],  isMetal:false },
  Na: { Z:11, mass:22.990,  density:968,   meltingPoint:98,   boilingPoint:883,  latentFusion:113.1,  latentVaporization:4250,   specificHeat:1228,  debyeTemp:157,  thermalCond:142,   thermalExpansion:71,   youngsMod:10,  poissonRatio:0.32, tensileStr:0,   mohsHardness:0.5, crystalStructure:'BCC',  emissivity:0.07, soundSpeed:3200, electrodePotential:-2.71, gruneisen:1.25, viscosity_A:0.3,    viscosity_Ea:5,    surfaceTension_Tm:0.19, color:[0.8,0.8,0.8],  isMetal:true },
  Mg: { Z:12, mass:24.305,  density:1738,  meltingPoint:650,  boilingPoint:1090, latentFusion:349,    latentVaporization:5266,   specificHeat:1023,  debyeTemp:403,  thermalCond:156,   thermalExpansion:24.8, youngsMod:45,  poissonRatio:0.29, tensileStr:130, mohsHardness:2.5, crystalStructure:'HCP',  emissivity:0.07, soundSpeed:5770, electrodePotential:-2.37, gruneisen:1.51, viscosity_A:0.3,    viscosity_Ea:10,   surfaceTension_Tm:0.56, color:[0.75,0.75,0.75], isMetal:true },
  Al: { Z:13, mass:26.982,  density:2700,  meltingPoint:660,  boilingPoint:2519, latentFusion:397,    latentVaporization:10859,  specificHeat:897,   debyeTemp:433,  thermalCond:237,   thermalExpansion:23.1, youngsMod:70,  poissonRatio:0.35, tensileStr:45,  mohsHardness:2.75,crystalStructure:'FCC',  emissivity:0.05, soundSpeed:6420, electrodePotential:-1.66, gruneisen:2.35, viscosity_A:0.1549, viscosity_Ea:16.5, surfaceTension_Tm:1.02, color:[0.82,0.82,0.87], isMetal:true },
  Si: { Z:14, mass:28.085,  density:2330,  meltingPoint:1414, boilingPoint:3265, latentFusion:1788,   latentVaporization:12784,  specificHeat:705,   debyeTemp:645,  thermalCond:149,   thermalExpansion:2.6,  youngsMod:130, poissonRatio:0.22, tensileStr:165, mohsHardness:6.5, crystalStructure:'DC',   emissivity:0.65, soundSpeed:8433, electrodePotential:-0.91, gruneisen:0.56, viscosity_A:0.3,    viscosity_Ea:15,   surfaceTension_Tm:0.73, color:[0.4,0.4,0.5],  isMetal:false },
  P:  { Z:15, mass:30.974,  density:1823,  meltingPoint:44,   boilingPoint:281,  latentFusion:21.3,   latentVaporization:400,    specificHeat:769,   debyeTemp:576,  thermalCond:0.236, thermalExpansion:125,  youngsMod:0,   poissonRatio:0,    tensileStr:0,   mohsHardness:0,   crystalStructure:'Orth', emissivity:0.5,  soundSpeed:0,    electrodePotential:-0.51, gruneisen:0.7,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[1.0,1.0,0.8],  isMetal:false },
  S:  { Z:16, mass:32.060,  density:2080,  meltingPoint:115,  boilingPoint:445,  latentFusion:54,     latentVaporization:306,    specificHeat:710,   debyeTemp:527,  thermalCond:0.205, thermalExpansion:64,   youngsMod:0,   poissonRatio:0,    tensileStr:0,   mohsHardness:2.0, crystalStructure:'Orth', emissivity:0.5,  soundSpeed:0,    electrodePotential:0.14,  gruneisen:0.8,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[1.0,1.0,0.3],  isMetal:false },
  Cl: { Z:17, mass:35.450,  density:1563,  meltingPoint:-102, boilingPoint:-34,  latentFusion:181,    latentVaporization:288,    specificHeat:479,   debyeTemp:70,   thermalCond:0.009, thermalExpansion:0,    youngsMod:0,   poissonRatio:0,    tensileStr:0,   mohsHardness:0,   crystalStructure:'Orth', emissivity:0.5,  soundSpeed:206,  electrodePotential:1.36,  gruneisen:0.7,  viscosity_A:0,      viscosity_Ea:0,    surfaceTension_Tm:0,    color:[0.5,1.0,0.5],  isMetal:false },
  K:  { Z:19, mass:39.098,  density:890,   meltingPoint:63,   boilingPoint:759,  latentFusion:59.6,   latentVaporization:1967,   specificHeat:757,   debyeTemp:91,   thermalCond:103,   thermalExpansion:83.3, youngsMod:3.5, poissonRatio:0.31, tensileStr:0,   mohsHardness:0.4, crystalStructure:'BCC',  emissivity:0.07, soundSpeed:2000, electrodePotential:-2.93, gruneisen:1.34, viscosity_A:0.25,   viscosity_Ea:4,    surfaceTension_Tm:0.11, color:[0.8,0.8,0.8],  isMetal:true },
  Ca: { Z:20, mass:40.078,  density:1550,  meltingPoint:842,  boilingPoint:1484, latentFusion:213,    latentVaporization:3867,   specificHeat:647,   debyeTemp:229,  thermalCond:201,   thermalExpansion:22.3, youngsMod:20,  poissonRatio:0.31, tensileStr:110, mohsHardness:1.75,crystalStructure:'FCC',  emissivity:0.07, soundSpeed:3810, electrodePotential:-2.87, gruneisen:1.5,  viscosity_A:0.3,    viscosity_Ea:12,   surfaceTension_Tm:0.36, color:[0.9,0.9,0.9],  isMetal:true },
  Ti: { Z:22, mass:47.867,  density:4506,  meltingPoint:1668, boilingPoint:3287, latentFusion:296,    latentVaporization:8879,   specificHeat:523,   debyeTemp:420,  thermalCond:22,    thermalExpansion:8.6,  youngsMod:116, poissonRatio:0.32, tensileStr:310, mohsHardness:6.0, crystalStructure:'HCP',  emissivity:0.12, soundSpeed:6070, electrodePotential:-1.63, gruneisen:1.23, viscosity_A:0.3,    viscosity_Ea:25,   surfaceTension_Tm:1.56, color:[0.72,0.72,0.77], isMetal:true },
  Cr: { Z:24, mass:51.996,  density:7150,  meltingPoint:1907, boilingPoint:2671, latentFusion:404,    latentVaporization:6520,   specificHeat:449,   debyeTemp:606,  thermalCond:94,    thermalExpansion:4.9,  youngsMod:279, poissonRatio:0.21, tensileStr:282, mohsHardness:8.5, crystalStructure:'BCC',  emissivity:0.07, soundSpeed:6608, electrodePotential:-0.74, gruneisen:1.4,  viscosity_A:0.3,    viscosity_Ea:25,   surfaceTension_Tm:1.70, color:[0.77,0.77,0.82], isMetal:true },
  Mn: { Z:25, mass:54.938,  density:7210,  meltingPoint:1246, boilingPoint:2061, latentFusion:235,    latentVaporization:4005,   specificHeat:479,   debyeTemp:409,  thermalCond:7.8,   thermalExpansion:21.7, youngsMod:198, poissonRatio:0.24, tensileStr:496, mohsHardness:6.0, crystalStructure:'BCC',  emissivity:0.06, soundSpeed:5150, electrodePotential:-1.19, gruneisen:1.35, viscosity_A:0.3,    viscosity_Ea:22,   surfaceTension_Tm:1.10, color:[0.7,0.7,0.7],  isMetal:true },
  Fe: { Z:26, mass:55.845,  density:7860,  meltingPoint:1538, boilingPoint:2861, latentFusion:247,    latentVaporization:6213,   specificHeat:449,   debyeTemp:477,  thermalCond:80,    thermalExpansion:11.8, youngsMod:211, poissonRatio:0.29, tensileStr:350, mohsHardness:4.0, crystalStructure:'BCC',  emissivity:0.07, soundSpeed:5950, electrodePotential:-0.44, gruneisen:1.7,  viscosity_A:0.3837, viscosity_Ea:41.4, surfaceTension_Tm:1.93, color:[0.56,0.56,0.56], isMetal:true },
  Ni: { Z:28, mass:58.693,  density:8908,  meltingPoint:1455, boilingPoint:2913, latentFusion:298,    latentVaporization:6440,   specificHeat:444,   debyeTemp:477,  thermalCond:91,    thermalExpansion:13.4, youngsMod:200, poissonRatio:0.31, tensileStr:317, mohsHardness:4.0, crystalStructure:'FCC',  emissivity:0.06, soundSpeed:6040, electrodePotential:-0.26, gruneisen:1.88, viscosity_A:0.3,    viscosity_Ea:25,   surfaceTension_Tm:1.85, color:[0.66,0.66,0.72], isMetal:true },
  Cu: { Z:29, mass:63.546,  density:8960,  meltingPoint:1085, boilingPoint:2562, latentFusion:209,    latentVaporization:4722,   specificHeat:385,   debyeTemp:347,  thermalCond:401,   thermalExpansion:16.5, youngsMod:130, poissonRatio:0.34, tensileStr:220, mohsHardness:3.0, crystalStructure:'FCC',  emissivity:0.04, soundSpeed:4760, electrodePotential:0.34,  gruneisen:2.0,  viscosity_A:0.2684, viscosity_Ea:30.5, surfaceTension_Tm:1.40, color:[0.85,0.53,0.22], isMetal:true },
  Zn: { Z:30, mass:65.380,  density:7140,  meltingPoint:420,  boilingPoint:907,  latentFusion:112,    latentVaporization:1820,   specificHeat:388,   debyeTemp:329,  thermalCond:116,   thermalExpansion:30.2, youngsMod:108, poissonRatio:0.25, tensileStr:37,  mohsHardness:2.5, crystalStructure:'HCP',  emissivity:0.045,soundSpeed:4210, electrodePotential:-0.76, gruneisen:2.25, viscosity_A:0.3862, viscosity_Ea:12.7, surfaceTension_Tm:0.78, color:[0.72,0.72,0.77], isMetal:true },
  Sn: { Z:50, mass:118.710, density:7265,  meltingPoint:232,  boilingPoint:2602, latentFusion:59.2,   latentVaporization:2443,   specificHeat:228,   debyeTemp:199,  thermalCond:67,    thermalExpansion:22,   youngsMod:50,  poissonRatio:0.36, tensileStr:15,  mohsHardness:1.5, crystalStructure:'BCT',  emissivity:0.05, soundSpeed:3320, electrodePotential:-0.13, gruneisen:2.14, viscosity_A:0.341,  viscosity_Ea:7.1,  surfaceTension_Tm:0.61, color:[0.77,0.77,0.77], isMetal:true },
  Pb: { Z:82, mass:207.200, density:11340, meltingPoint:327,  boilingPoint:1749, latentFusion:23,     latentVaporization:859,    specificHeat:129,   debyeTemp:105,  thermalCond:35,    thermalExpansion:28.9, youngsMod:16,  poissonRatio:0.44, tensileStr:12,  mohsHardness:1.5, crystalStructure:'FCC',  emissivity:0.065,soundSpeed:2160, electrodePotential:-0.13, gruneisen:2.65, viscosity_A:0.3582, viscosity_Ea:10.0, surfaceTension_Tm:0.48, color:[0.42,0.42,0.47], isMetal:true },
  Ag: { Z:47, mass:107.868, density:10490, meltingPoint:962,  boilingPoint:2162, latentFusion:105,    latentVaporization:2364,   specificHeat:235,   debyeTemp:227,  thermalCond:429,   thermalExpansion:18.9, youngsMod:83,  poissonRatio:0.37, tensileStr:140, mohsHardness:2.5, crystalStructure:'FCC',  emissivity:0.025,soundSpeed:3650, electrodePotential:0.80,  gruneisen:2.4,  viscosity_A:0.3858, viscosity_Ea:23.7, surfaceTension_Tm:0.96, color:[0.91,0.91,0.93], isMetal:true },
  Au: { Z:79, mass:196.967, density:19300, meltingPoint:1064, boilingPoint:2856, latentFusion:63.7,   latentVaporization:1675,   specificHeat:129,   debyeTemp:162,  thermalCond:318,   thermalExpansion:14.2, youngsMod:78,  poissonRatio:0.44, tensileStr:130, mohsHardness:2.5, crystalStructure:'FCC',  emissivity:0.025,soundSpeed:3240, electrodePotential:1.52,  gruneisen:3.03, viscosity_A:0.3986, viscosity_Ea:28.4, surfaceTension_Tm:1.19, color:[1.0,0.84,0.0],   isMetal:true },
  W:  { Z:74, mass:183.840, density:19250, meltingPoint:3422, boilingPoint:5555, latentFusion:285,    latentVaporization:4352,   specificHeat:132,   debyeTemp:383,  thermalCond:173,   thermalExpansion:4.5,  youngsMod:411, poissonRatio:0.28, tensileStr:585, mohsHardness:7.5, crystalStructure:'BCC',  emissivity:0.035,soundSpeed:5220, electrodePotential:-0.12, gruneisen:1.62, viscosity_A:0.3,    viscosity_Ea:35,   surfaceTension_Tm:2.50, color:[0.62,0.62,0.67], isMetal:true },
}

// ── Special compound overrides ──────────────────────────────────────────────
// Vegard's law fails for molecular compounds. These define known compounds
// that need density/property overrides when detected by composition signature.
interface CompoundOverride {
  kind: 'water' | 'salt' | 'silicate-grd' | 'silicate-unmodelled' | 'organic-oil'
  density: number
  meltingPoint: number
  boilingPoint: number
  specificHeat: number
  thermalCond: number
  /** Pa·s at tC (liquid law only; the solid case is handled by the caller). NaN = no validated law. */
  viscosityAt: (tC: number) => number
  surfaceTension: number  // N/m at the requested temperature; NaN = unsourced
  color: [number, number, number]
  IOR: number
  flags: string[]
  /** Why this branch's liquid-state values are not sourced (null = cited law, currently only water). */
  unsourcedReason: string | null
}

/** Legacy Arrhenius form μ_ref·exp(Ea/R·(1/T − 1/T_ref)) — kept only for the salt/oil branches, whose parameters are [U]. */
function arrheniusFromRef(mu_ref: number, Ea_kJmol: number, Tref_C: number, tC: number): number {
  const T_K = tC + 273.15
  if (!(T_K > 0)) return NaN
  return mu_ref * Math.exp((Ea_kJmol * 1000) / R_GAS * (1 / T_K - 1 / (Tref_C + 273.15)))
}

// GRD oxide per element: [oxide index in materialData.GRD_OXIDES, oxide molar mass (GRD's own values), cations per oxide]
const GRD_OXIDE_OF: Partial<Record<ElementName, readonly [number, number, number]>> = {
  Si: [0, 60.0843, 1], Ti: [1, 79.8658, 1], Al: [2, 101.961276, 2], Fe: [3, 71.8444, 1], Mn: [4, 70.937449, 1],
  Mg: [5, 40.3044, 1], Ca: [6, 56.0774, 1], Na: [7, 61.97894, 2], K: [8, 94.1960, 2], P: [9, 141.9446, 2],
  H: [10, 18.01528, 2],
}

/** Element mass fractions → 12 GRD oxide wt% (total iron as FeO, H as H2O), normalised to 100 as the GRD calculator
 *  does. null if any element that is not a GRD oxide cation (other than O) is present. */
export function silicateOxidesWt(elements: Partial<Record<ElementName, number>>): number[] | null {
  const wt = new Array<number>(12).fill(0)
  for (const [el, frac] of Object.entries(elements) as [ElementName, number][]) {
    if (!(frac > 0) || el === 'O') continue
    const ox = GRD_OXIDE_OF[el]
    if (!ox) return null
    const [idx, molarMassOxide, nCation] = ox
    wt[idx] += frac * molarMassOxide / (nCation * ELEMENT_DATA[el].mass)
  }
  const sum = wt.reduce((s, v) => s + v, 0)
  if (!(sum > 0)) return null
  return wt.map(v => 100 * v / sum)
}

/** Composition key for materials that have a cited law in materialData (currently: water by element signature). */
export function detectMaterialKey(elements: Partial<Record<ElementName, number>>): 'water' | null {
  const h = elements.H ?? 0
  const o = elements.O ?? 0
  return h > 0.05 && o > 0.8 && h + o > 0.95 ? 'water' : null
}

function detectCompound(elements: Partial<Record<ElementName, number>>, tC: number): CompoundOverride | null {
  const h = elements.H ?? 0
  const o = elements.O ?? 0
  const na = elements.Na ?? 0
  const cl = elements.Cl ?? 0
  const c = elements.C ?? 0
  const si = elements.Si ?? 0

  // Water: H₂O → H:0.111, O:0.889. Laws from materialData (NIST isobar + IAPWS R1-76); NaN outside 0.01–99.9743 °C.
  if (detectMaterialKey(elements) === 'water') {
    return {
      kind: 'water',
      density: waterDensity(tC), meltingPoint: WATER_T_MIN_C, boilingPoint: WATER_T_MAX_C,
      specificHeat: 4186, thermalCond: 0.6,  // legacy, not used by the solver (NIST 20 °C: 4184.0, 0.59803) [unchanged]
      viscosityAt: waterViscosity, surfaceTension: waterSurfaceTension(tC),
      color: [0.75, 0.88, 1.0], IOR: 1.333,
      flags: ['source:primary:NIST-IAPWS'],
      unsourcedReason: null,
    }
  }
  // Salt: NaCl → Na:0.393, Cl:0.607. Legacy molten-salt values; parameters not sourced [U].
  if (na > 0.3 && cl > 0.5) {
    return {
      kind: 'salt',
      density: 2170, meltingPoint: 801, boilingPoint: 1413, specificHeat: 880,
      thermalCond: 6.5, viscosityAt: (t) => arrheniusFromRef(0.001, 20, 820, t),
      surfaceTension: 0.114, color: [0.95, 0.95, 0.95], IOR: 1.544,
      flags: ['unverified:molten-salt-parameters'],
      unsourcedReason: 'molten-salt ρ and μ(T) are legacy values (ρ 2170, μ 1 mPa·s at 820 °C, Ea 20 kJ/mol) with no source',
    }
  }
  // Silicate melt (was "Glass: SiO₂-dominant", which also caught basalt → the 1e8 Pa·s lava bug).
  if (si > 0.2 && o > 0.35) {
    const ox = silicateOxidesWt(elements)
    const violations = ox ? grdCalibrationViolations(ox) : ['contains elements that are not GRD 2008 oxide components']
    if (ox && violations.length === 0) {
      const vft = grdVft(ox)
      const TgC = vft.TgK - 273.15
      // GRD 2008 §2: anhydrous data span 535–1705 °C, volatile-bearing data 245–1580 °C → NaN outside (no extrapolation).
      const span = ox[10] > 0 || ox[11] > 0 ? GRD_CALIBRATION_T_C.volatileBearing : GRD_CALIBRATION_T_C.anhydrous
      return {
        kind: 'silicate-grd',
        // PyFLOWGO basalt DRE default (flowgo_material_lava.py `_density_dre = 2600.`) applied to an element-derived
        // silicate: an ESTIMATE, flagged — GRD gives no density.
        density: 2600,
        // The liquidus (fully molten above it) of an arbitrary composition is not sourced → NaN. GRD's Tg (η = 1e12 Pa·s,
        // the glass transition) is NOT a melting point and is only used as the lower end of the VFT law's validity.
        meltingPoint: NaN, boilingPoint: NaN,
        specificHeat: NaN, thermalCond: NaN,
        viscosityAt: (t) => (t >= span[0] && t <= span[1] && t >= TgC ? vftViscosity(vft, t) : NaN),
        surfaceTension: NaN,
        color: [0.85, 0.9, 0.95], IOR: 1.5,
        flags: ['model:GRD2008-melt', 'estimate:density:PyFLOWGO-DRE-2600', 'unsourced:liquidus', `GRD-calibrated-span:${span[0]}-${span[1]}C`, 'melt-only:crystallisation-not-modelled'],
        unsourcedReason: "GRD 2008 gives this silicate melt's viscosity, but its liquidus is not sourced, so a fully molten Newtonian melt cannot be certified at any temperature (use a Lava preset)",
      }
    }
    return {
      kind: 'silicate-unmodelled',
      density: NaN, meltingPoint: NaN, boilingPoint: NaN, specificHeat: NaN, thermalCond: NaN,
      viscosityAt: () => NaN, surfaceTension: NaN,
      color: [0.85, 0.9, 0.95], IOR: 1.5,
      flags: ['unmodelled:silicate-outside-GRD-calibration', ...violations],
      unsourcedReason: `silicate outside the GRD 2008 calibration (${violations.join('; ')}) — no viscosity model`,
    }
  }
  // Organic oil: high C+H, low everything else. Legacy values; Ea = 25 kJ/mol and c_p/k are [U] (r4 §C.1-12).
  if (c > 0.6 && h > 0.08 && c + h + (elements.O ?? 0) > 0.95) {
    return {
      kind: 'organic-oil',
      density: 920, meltingPoint: -6, boilingPoint: 300, specificHeat: 2000,
      thermalCond: 0.17, viscosityAt: (t) => arrheniusFromRef(0.08, 25, 20, t),
      surfaceTension: 0.032, color: [0.7, 0.65, 0.3], IOR: 1.473,
      flags: ['unverified:organic-oil-parameters'],
      unsourcedReason: 'legacy organic-oil parameters (ρ 920, μ 0.08 Pa·s at 20 °C, Ea 25 kJ/mol, melting −6 °C, boiling 300 °C) have no source (use Olive Oil, secondary data)',
    }
  }
  return null
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Composition {
  elements: Partial<Record<ElementName, number>>  // mass fractions, sum to 1.0
}

export interface DerivedProps {
  // Physical
  density: number            // kg/m³
  meltingPoint: number       // °C
  boilingPoint: number       // °C
  latentHeatFusion: number   // kJ/kg
  latentHeatVaporization: number // kJ/kg
  specificHeat: number       // J/(kg·K)
  thermalConductivity: number // W/(m·K)
  thermalExpansion: number   // 1/K
  youngsModulus: number      // GPa
  tensileStrength: number    // MPa
  hardness: number           // Mohs
  // Fluid
  viscosity: number          // Pa·s (at the given temperature)
  surfaceTension: number     // N/m (at the given temperature)
  // Rendering
  color: [number, number, number] // RGB 0-1
  F0: number                 // Fresnel reflectance at normal incidence
  metalness: number          // 0-1
  emissive: number           // glow intensity
  IOR: number                // index of refraction
  specularPower: number      // specular highlight sharpness
  opacityDensity: number     // how opaque per unit thickness
  emissivity: number         // 0-1 for thermal radiation
  /** Provenance of the derived values (S1.5): 'estimate:*', 'unverified:*', 'unmodelled:*', 'solid:*', 'model:*' … */
  flags?: string[]
  /** Why the liquid-state (solver) values of this composition are not sourced; null only for a cited law (water).
   *  The spawn gate refuses every composition with a non-null reason, at every temperature. */
  unsourcedReason?: string | null
}

// ── Debye specific heat correction — KNOWN BUG, NOT USED (S1.5, r4 §C.1-7) ──
// §3.1: C_v = 3R × f(T/θ_D)
// This "approximation" is not the Debye heat-capacity function: it returns values up to ≈ 2 (x = 2.79 → 1.97, where the
// true Debye C_v/3R is ≈ 0.99) and jumps to exactly 1.0 at x = 3. It was also applied to MEASURED room-temperature
// c_p values, which already contain the lattice behaviour. computeProperties no longer calls it; it is exported only
// so the materials gate can document the defect. Do not use.
/** @deprecated Known-wrong (see comment above). Kept for the S1.5 gate only. */
export function debyeFunctionLegacyBuggy(x: number): number {
  // x = T/θ_D
  if (x > 3) return 1.0 // Dulong-Petit limit
  if (x < 0.05) return 0.0
  // Padé approximation of the Debye integral
  const x2 = x * x
  const x3 = x2 * x
  return 1.0 - 3.0 / (20.0 * x2) + 1.0 / (560.0 * x2 * x2)
    + Math.min(1.0, x3 / (x3 + 0.2))
}

// ── Andrade/Arrhenius viscosity ─────────────────────────────────────────────
// §3.1: μ(T) = A · exp(Ea / (R·T))
// Given A, Ea from Table 8, compute viscosity at temperature T (°C)
function arrheniusViscosity(A_mPas: number, Ea_kJmol: number, tempC: number): number {
  if (!(A_mPas > 0)) return NaN // no Andrade parameters → no viscosity law (was a silent 0.001 "water-like" default)
  const T_K = tempC + 273.15
  if (!(T_K > 0)) return NaN
  const Ea = Ea_kJmol * 1000 // convert to J/mol
  const mu_mPas = A_mPas * Math.exp(Ea / (R_GAS * T_K))
  return mu_mPas * 0.001 // convert mPa·s to Pa·s
}

// ── Eötvös surface tension ──────────────────────────────────────────────────
// §3.1: γ = k·(Tc - T - 6) / V^(2/3)
// Tc ≈ boilingPoint (for rough estimate), V = molar volume
export function eötvösSurfaceTension(
  molarMass: number, density: number, boilingPoint_C: number, tempC: number,
  surfaceTension_Tm: number, meltingPoint_C: number
): number {
  // If we have a direct measurement at Tm, use linear interpolation from it
  if (surfaceTension_Tm > 0 && tempC >= meltingPoint_C) {
    // Surface tension decreases linearly with temperature
    // dγ/dT ≈ -0.0003 N/(m·K) for most metals — a universal slope that is [U] (r4 §C.1-13: Hg measures −0.2155
    // mN/(m·K); silicate melts have a small POSITIVE slope). Display-only: the solver has no surface tension.
    const dGamma_dT = -0.0003
    const g = surfaceTension_Tm + dGamma_dT * (tempC - meltingPoint_C)
    return g > 0 ? g : NaN // no floor: a non-positive value means the linear law is outside its range
  }

  // Eötvös rule fallback
  const Tc_K = boilingPoint_C + 273.15
  const T_K = tempC + 273.15
  const V_m = (molarMass / 1000) / density // m³/mol
  const gamma = EÖTVÖS_K * (Tc_K - T_K - 6) / Math.pow(V_m, 2 / 3)
  return gamma > 0 ? gamma : NaN // no floor (was Math.max(0.001, …))
}

// ── Wiedemann-Franz thermal conductivity ────────────────────────────────────
// §3.1: For metals, κ = L · σ_elec · T
// Lorenz number L = 2.44 × 10⁻⁸ W·Ω/K²
// Simplified: use element κ directly with mixing rule for alloys
function metalThermalCond(entries: [ElementName, number][]): number {
  // For alloys: 1/κ_alloy = Σ(x_i / κ_i) — harmonic mean (Matthiessen-like)
  let sumInv = 0
  for (const [el, frac] of entries) {
    const d = ELEMENT_DATA[el]
    if (d.thermalCond > 0.1 && d.isMetal) {
      sumInv += frac / d.thermalCond
    }
  }
  return sumInv > 0 ? 1 / sumInv : 1.0
}

// ── Drude color model for metals ────────────────────────────────────────────
// Metals reflect light based on their plasma frequency / band structure
// We use element colors as base and mix them — this is physically reasonable
// since alloy colors are generally close to weighted averages of constituents
function computeMetalColor(entries: [ElementName, number][]): [number, number, number] {
  const color: [number, number, number] = [0, 0, 0]
  for (const [el, frac] of entries) {
    const d = ELEMENT_DATA[el]
    color[0] += d.color[0] * frac
    color[1] += d.color[1] * frac
    color[2] += d.color[2] * frac
  }
  return color
}

// ── Incandescence (blackbody color) ─────────────────────────────────────────
// For hot materials, add glow based on temperature
function blackbodyColor(tempC: number): [number, number, number] {
  const T = tempC + 273.15
  if (T < 773) return [0, 0, 0] // below 500°C, no visible glow
  // Simplified Planckian locus approximation
  const t = T / 1000
  // Red channel ramps up first
  const r = Math.min(1, Math.max(0, (t - 0.5) * 1.2))
  // Green follows
  const g = Math.min(1, Math.max(0, (t - 0.8) * 0.9))
  // Blue last
  const b = Math.min(1, Math.max(0, (t - 1.5) * 0.7))
  return [r, g, b]
}

// ══════════════════════════════════════════════════════════════════════════════
// Main property calculator
// ══════════════════════════════════════════════════════════════════════════════

/** Compute derived material properties from element composition */
export function computeProperties(comp: Composition, temperature: number = 20): DerivedProps {
  const elems = comp.elements
  const entries = Object.entries(elems) as [ElementName, number][]

  // ── Check for known compound overrides first ──────────────────────────
  const compound = detectCompound(elems, temperature)
  const flags: string[] = compound ? [...compound.flags] : ['estimate:element-model']

  // ── Compute metal fraction ────────────────────────────────────────────
  const metalFrac = entries
    .filter(([el]) => ELEMENT_DATA[el].isMetal)
    .reduce((sum, [, f]) => sum + f, 0)
  const isMetallic = metalFrac > 0.5

  // ── Vegard's law for basic properties ─────────────────────────────────
  let density = 0, meltingPoint = 0, boilingPoint = 0
  let latentFusion = 0, latentVaporization = 0
  let youngsModulus = 0, tensileStrength = 0, hardness = 0
  let thermalExpansion = 0, emissivity_val = 0

  for (const [el, frac] of entries) {
    const d = ELEMENT_DATA[el]
    density += d.density * frac
    meltingPoint += d.meltingPoint * frac
    boilingPoint += d.boilingPoint * frac
    latentFusion += d.latentFusion * frac
    latentVaporization += d.latentVaporization * frac
    youngsModulus += d.youngsMod * frac
    tensileStrength += d.tensileStr * frac
    hardness += d.mohsHardness * frac
    thermalExpansion += d.thermalExpansion * frac
    emissivity_val += d.emissivity * frac
  }

  // ── Apply compound overrides ──────────────────────────────────────────
  if (compound) {
    density = compound.density
    meltingPoint = compound.meltingPoint
    boilingPoint = compound.boilingPoint
  }

  // ── Specific heat (§3.1) ──────────────────────────────────────────────
  // (§3.1 wrote C_p = Σ x_i (3R/M_i) f(T/θ_D) — f was the buggy approximation, see debyeFunctionLegacyBuggy)
  // S1.5: the per-element Debye "correction" is removed — debyeFunctionLegacyBuggy() is wrong (see above) and the
  // table values are already MEASURED room-temperature c_p. Mass weighting of element c_p (Kopp–Neumann style) is
  // itself an estimate for compounds/alloys → flagged. Not used by the solver.
  let specificHeat = 0
  if (compound) {
    specificHeat = compound.specificHeat
  } else {
    for (const [el, frac] of entries) specificHeat += ELEMENT_DATA[el].specificHeat * frac
    if (entries.length > 1) flags.push('estimate:specific-heat:mass-weighted')
  }

  // ── Thermal conductivity ──────────────────────────────────────────────
  let thermalConductivity: number
  if (compound) {
    thermalConductivity = compound.thermalCond
  } else if (isMetallic) {
    thermalConductivity = metalThermalCond(entries)
  } else {
    // Non-metals: simple weighted average (phonon transport)
    thermalConductivity = 0
    for (const [el, frac] of entries) {
      thermalConductivity += ELEMENT_DATA[el].thermalCond * frac
    }
  }

  // ── Andrade viscosity (§3.1) ──────────────────────────────────────────
  // No clamps: a value outside a law's range is NaN and the solver gate refuses it (liquidGate.validateMpmViscosity).
  let viscosity: number
  if (compound) {
    if (temperature < compound.meltingPoint) {
      viscosity = NaN // solid (or glass, for GRD melts below Tg): a viscosity is not defined
      flags.push('solid:no-viscosity')
    } else {
      viscosity = compound.viscosityAt(temperature)
    }
  } else if (temperature > meltingPoint && isMetallic) {
    // Liquid metal — Andrade from element table
    // Use weighted average of A and Ea
    let A_avg = 0, Ea_avg = 0, metalWeight = 0
    for (const [el, frac] of entries) {
      const d = ELEMENT_DATA[el]
      if (d.viscosity_A > 0 && d.isMetal) {
        A_avg += d.viscosity_A * frac
        Ea_avg += d.viscosity_Ea * frac
        metalWeight += frac
      }
    }
    if (metalWeight > 0) {
      A_avg /= metalWeight
      Ea_avg /= metalWeight
      viscosity = arrheniusViscosity(A_avg, Ea_avg, temperature)
      flags.push('estimate:viscosity:andrade-element-table')
    } else {
      viscosity = NaN // was a 0.004 Pa·s "default molten metal" placeholder
      flags.push('unmodelled:no-viscosity-law')
    }
  } else if (temperature > meltingPoint) {
    viscosity = NaN // was a 0.001 Pa·s "default liquid" placeholder
    flags.push('unmodelled:no-viscosity-law')
  } else {
    viscosity = NaN // solid: was a 1e6 Pa·s placeholder that the MPM kernel then fed to its ±200 clamp
    flags.push('solid:no-viscosity')
  }

  // ── Surface tension (§3.1) ────────────────────────────────────────────
  let surfaceTension: number
  if (compound) {
    surfaceTension = compound.surfaceTension
  } else if (temperature > meltingPoint && isMetallic) {
    // Weighted surface tension from element Tm values
    let gamma_avg = 0, metalWeight = 0
    for (const [el, frac] of entries) {
      const d = ELEMENT_DATA[el]
      if (d.surfaceTension_Tm > 0 && d.isMetal) {
        gamma_avg += d.surfaceTension_Tm * frac
        metalWeight += frac
      }
    }
    if (metalWeight > 0) {
      gamma_avg /= metalWeight
      // Temperature correction: -0.0003 N/(m·K) above melting point
      // −0.3 mN/(m·K) universal slope is [U] (see eötvösSurfaceTension); display-only.
      const g = gamma_avg - 0.0003 * Math.max(0, temperature - meltingPoint)
      surfaceTension = g > 0 ? g : NaN // no floor (was Math.max(0.01, …))
      flags.push('estimate:surface-tension:universal-slope')
    } else {
      surfaceTension = NaN // was a 0.5 N/m placeholder
    }
  } else {
    surfaceTension = NaN // was a 0.03 N/m placeholder
  }

  // ── Color ─────────────────────────────────────────────────────────────
  let color: [number, number, number]
  if (compound) {
    color = [...compound.color]
  } else {
    color = computeMetalColor(entries)
  }

  // Add incandescence for hot materials
  const glow = blackbodyColor(temperature)
  const glowIntensity = Math.min(1, Math.max(0, (temperature - 500) / 1000))
  if (glowIntensity > 0) {
    color[0] = color[0] * (1 - glowIntensity) + glow[0] * glowIntensity
    color[1] = color[1] * (1 - glowIntensity) + glow[1] * glowIntensity
    color[2] = color[2] * (1 - glowIntensity) + glow[2] * glowIntensity
  }

  // ── Rendering properties ──────────────────────────────────────────────
  const metalness = Math.min(1, metalFrac * 1.2)
  // Fresnel F0: metals are high (0.5-0.9), dielectrics are low (0.02-0.05)
  const F0 = isMetallic ? 0.5 + metalness * 0.4 : 0.02 + metalness * 0.06
  const IOR = compound?.IOR ?? (isMetallic ? 1.0 : 1.33 + metalness * 0.2)
  const emissive = glowIntensity > 0 ? glowIntensity * 2.0 : 0
  const specularPower = isMetallic ? 300 : 150
  const opacityDensity = isMetallic ? 5.0 + density * 0.0003 : (compound ? 0.15 : 2.0 + density * 0.0005)

  return {
    density, meltingPoint, boilingPoint, latentHeatFusion: latentFusion,
    latentHeatVaporization: latentVaporization, specificHeat,
    thermalConductivity, thermalExpansion: thermalExpansion * 1e-6,
    youngsModulus, tensileStrength, hardness,
    viscosity, surfaceTension,
    color, F0, metalness, emissive, IOR, specularPower, opacityDensity,
    emissivity: emissivity_val,
    flags,
    unsourcedReason: compound
      ? compound.unsourcedReason
      : isMetallic && flags.includes('estimate:viscosity:andrade-element-table')
        ? 'liquid-metal values from the element table are not sourced for this composition (the density is the solid-state Vegard mix; the Andrade A/Ea table rows are not individually cited and several are 0.3 mPa·s placeholders)'
        : 'no sourced liquid-state data for this element composition (element-model estimate: Vegard-mixed melting/boiling points and properties)',
  }
}

// ── Temperature-dependent property functions ────────────────────────────────
// These can be called per-tick without recomputing everything

/** Compute viscosity at a specific temperature for an existing composition */
export function computeViscosity(comp: Composition, temperature: number): number {
  return computeProperties(comp, temperature).viscosity
}

/** Compute surface tension at a specific temperature */
export function computeSurfaceTension(comp: Composition, temperature: number): number {
  return computeProperties(comp, temperature).surfaceTension
}
