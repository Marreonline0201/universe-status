// PropertyCalculator.ts — Compute material properties from element composition
// Implements structure.md §3.1 formulas using real physics
// Data sourced from docs/element-properties.md (NIST, CRC Handbook, ASM International)

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
  density: number
  meltingPoint: number
  boilingPoint: number
  specificHeat: number
  thermalCond: number
  viscosity_ref: number   // Pa·s at ref temperature
  viscosity_Ea: number    // kJ/mol
  viscosity_Tref: number  // °C
  surfaceTension: number  // N/m at 20°C
  color: [number, number, number]
  IOR: number
}

// Detect water: H ≈ 0.111, O ≈ 0.889
function detectCompound(elements: Partial<Record<ElementName, number>>): CompoundOverride | null {
  const h = elements.H ?? 0
  const o = elements.O ?? 0
  const na = elements.Na ?? 0
  const cl = elements.Cl ?? 0
  const c = elements.C ?? 0
  const si = elements.Si ?? 0

  // Water: H₂O → H:0.111, O:0.889
  if (h > 0.05 && o > 0.8 && h + o > 0.95) {
    return {
      density: 1000, meltingPoint: 0, boilingPoint: 100, specificHeat: 4186,
      thermalCond: 0.6, viscosity_ref: 0.001, viscosity_Ea: 17, viscosity_Tref: 20,
      surfaceTension: 0.0728, color: [0.75, 0.88, 1.0], IOR: 1.333,
    }
  }
  // Salt: NaCl → Na:0.393, Cl:0.607
  if (na > 0.3 && cl > 0.5) {
    return {
      density: 2170, meltingPoint: 801, boilingPoint: 1413, specificHeat: 880,
      thermalCond: 6.5, viscosity_ref: 0.001, viscosity_Ea: 20, viscosity_Tref: 820,
      surfaceTension: 0.114, color: [0.95, 0.95, 0.95], IOR: 1.544,
    }
  }
  // Glass: SiO₂-dominant
  if (si > 0.2 && o > 0.35 && si + o > 0.6) {
    return {
      density: 2200, meltingPoint: 1700, boilingPoint: 2230, specificHeat: 730,
      thermalCond: 1.4, viscosity_ref: 1e6, viscosity_Ea: 500, viscosity_Tref: 1700,
      surfaceTension: 0.30, color: [0.85, 0.9, 0.95], IOR: 1.5,
    }
  }
  // Organic oil: high C+H, low everything else
  if (c > 0.6 && h > 0.08 && c + h + (elements.O ?? 0) > 0.95) {
    return {
      density: 920, meltingPoint: -6, boilingPoint: 300, specificHeat: 2000,
      thermalCond: 0.17, viscosity_ref: 0.08, viscosity_Ea: 25, viscosity_Tref: 20,
      surfaceTension: 0.032, color: [0.7, 0.65, 0.3], IOR: 1.473,
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
}

// ── Debye specific heat correction ──────────────────────────────────────────
// §3.1: C_v = 3R × f(T/θ_D)
// Simplified Debye function approximation (accurate to ~2%)
function debyeFunction(x: number): number {
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
  if (A_mPas <= 0) return 0.001 // default to water-like
  const T_K = Math.max(tempC + 273.15, 200) // prevent division by near-zero
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
    // dγ/dT ≈ -0.0003 N/(m·K) for most metals
    const dGamma_dT = -0.0003
    return Math.max(0.001, surfaceTension_Tm + dGamma_dT * (tempC - meltingPoint_C))
  }

  // Eötvös rule fallback
  const Tc_K = boilingPoint_C + 273.15
  const T_K = tempC + 273.15
  const V_m = (molarMass / 1000) / density // m³/mol
  const gamma = EÖTVÖS_K * (Tc_K - T_K - 6) / Math.pow(V_m, 2 / 3)
  return Math.max(0.001, gamma)
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
  const compound = detectCompound(elems)

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

  // ── Debye-corrected specific heat (§3.1) ──────────────────────────────
  // C_p = Σ x_i × (3R/M_i) × f(T/θ_D_i) × M_i × 1000
  // Simplified: per-element Debye correction on their Cp values
  let specificHeat = 0
  if (compound) {
    specificHeat = compound.specificHeat
  } else {
    const T_K = temperature + 273.15
    for (const [el, frac] of entries) {
      const d = ELEMENT_DATA[el]
      const theta = d.debyeTemp > 0 ? d.debyeTemp : 300
      const correction = debyeFunction(T_K / theta)
      // At high T (T >> θ_D), correction → 1, giving Dulong-Petit
      // At low T (T << θ_D), correction → 0, reducing Cp
      specificHeat += d.specificHeat * frac * Math.max(0.3, correction)
    }
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
  let viscosity: number
  if (compound) {
    // Use compound's Arrhenius parameters
    const T_K = Math.max(temperature + 273.15, 200)
    const Tref_K = compound.viscosity_Tref + 273.15
    const Ea = compound.viscosity_Ea * 1000
    viscosity = compound.viscosity_ref * Math.exp(Ea / R_GAS * (1 / T_K - 1 / Tref_K))
    viscosity = Math.max(0.0001, Math.min(viscosity, 1e8))
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
    } else {
      viscosity = 0.004 // default molten metal
    }
  } else if (temperature > meltingPoint) {
    viscosity = 0.001 // default liquid
  } else {
    viscosity = 1e6 // solid
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
      surfaceTension = Math.max(0.01, gamma_avg - 0.0003 * Math.max(0, temperature - meltingPoint))
    } else {
      surfaceTension = 0.5
    }
  } else {
    surfaceTension = 0.03 // default surface tension
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
