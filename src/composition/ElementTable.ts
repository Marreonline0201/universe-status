// ── Element Property Table ──────────────────────────────────────────────────
//
// 25 gameplay-relevant elements with REAL physical constants.
// Sources: NIST WebBook, CRC Handbook of Chemistry & Physics (97th ed.),
//          ASM International Handbook, Brandes & Brook "Smithells Metals
//          Reference Book", Iida & Guthrie "Physical Properties of Liquid
//          Metals", peer-reviewed literature as cited per property.
//
// Categories:
//   1. Atomic          6. Andrade viscosity     11. Fracture toughness
//   2. Thermal         7. Norton creep          12. Thermochemical
//   3. Mechanical      8. Avrami precipitation  13. Optical
//   4. Electrical      9. Fleischer             14. Electromagnetic
//   5. Liquid         10. Basquin fatigue
//
// For gases (H, N, O, Cl): mechanical/creep/fatigue = 0, crystal = 'diatomic'
// For non-metals (C, P, S): use covalent/molecular solid values
// Norton/Avrami/Fleischer: literature values where available, estimates noted
// ────────────────────────────────────────────────────────────────────────────

export type CrystalStructure = 'FCC' | 'BCC' | 'HCP' | 'diamond' | 'other' | 'gas' | 'diatomic'

export interface ElementProperties {
  // ── 1. Atomic ────────────────────────────────────────────────────────────
  atomicNumber: number
  atomicMass: number               // g/mol
  atomicRadius: number             // pm (metallic or covalent)
  electronegativity: number        // Pauling scale
  valence: number                  // most common oxidation state
  crystalStructure: CrystalStructure

  // ── 2. Thermal ───────────────────────────────────────────────────────────
  meltingPoint: number             // degC
  boilingPoint: number             // degC
  thermalConductivity: number      // W/(m*K) at 25C
  specificHeatCapacity: number     // J/(kg*K) at 25C
  debyeTemperature: number         // K
  thermalExpansion: number         // 1/K * 1e-6 (linear coefficient)
  emissivity: number               // 0-1, total hemispherical ~25C

  // ── 3. Mechanical (0 for gases) ──────────────────────────────────────────
  youngsModulus: number            // GPa
  tensileStrength: number          // MPa (ultimate)
  hardness: number                 // Mohs scale
  poissonRatio: number             // dimensionless

  // ── 4. Electrical / Acoustic ─────────────────────────────────────────────
  electricalConductivity: number   // S/m at 25C
  acousticEfficiency: number       // fraction impact energy -> sound
  dampingLossTangent: number       // internal friction

  // ── 5. Liquid ────────────────────────────────────────────────────────────
  liquidViscosity: number          // Pa*s at melting point
  liquidSurfaceTension: number     // N/m at melting point

  // ── 6. Andrade viscosity: mu = A * exp(Ea / (R*T)) ──────────────────────
  andradeA: number                 // Pa*s (pre-exponential)
  andradeEa: number                // J/mol (activation energy for viscous flow)

  // ── 7. Norton creep: deps/dt = A * sigma^n * exp(-Q/(R*T)) ──────────────
  nortonA: number                  // 1/(Pa^n * s)
  nortonN: number                  // stress exponent
  nortonQ: number                  // J/mol (activation energy for creep)

  // ── 8. Avrami precipitation: f(t) = 1 - exp(-(k*t)^n) ──────────────────
  avramiK0: number                 // 1/s (rate constant pre-exponential)
  avramiQ: number                  // J/mol (activation energy)
  avramiN: number                  // dimensionless (1-4)

  // ── 9. Fleischer ─────────────────────────────────────────────────────────
  fleischerB: number               // MPa (solid solution strengthening coeff)

  // ── 10. Basquin fatigue: N_f = C * sigma_a^(-1/b) ───────────────────────
  basquinSigmaF: number            // MPa (fatigue strength coefficient)
  basquinB: number                 // dimensionless (fatigue exponent, 0.05-0.12)

  // ── 11. Fracture toughness ───────────────────────────────────────────────
  fractureToughness: number        // MPa*sqrt(m) — K_IC

  // ── 12. Thermochemical ───────────────────────────────────────────────────
  standardEnthalpy: number         // kJ/mol (0 for elements in standard state)
  standardEntropy: number          // J/(mol*K)
  activationEnergy: number         // kJ/mol (oxidation reaction)

  // ── 13. Optical ──────────────────────────────────────────────────────────
  refractiveIndex: number          // dimensionless (real part; complex for metals)
  absorptionRGB: [number, number, number]  // 1/m per channel (bulk)

  // ── 14. Electromagnetic ──────────────────────────────────────────────────
  standardElectrodePotential: number // V (standard reduction potential)
  magneticPermeability: number       // relative mu_r
  triboelectricIndex: number         // -1 to +1
}

// ────────────────────────────────────────────────────────────────────────────
// The Table
// ────────────────────────────────────────────────────────────────────────────

export const ELEMENT_TABLE: Record<string, ElementProperties> = {

  // ════════════════════════════════════════════════════════════════════════
  // H — Hydrogen
  // ════════════════════════════════════════════════════════════════════════
  H: {
    // Atomic
    atomicNumber: 1,
    atomicMass: 1.008,
    atomicRadius: 25,              // covalent radius
    electronegativity: 2.20,
    valence: 1,
    crystalStructure: 'diatomic',

    // Thermal
    meltingPoint: -259.16,
    boilingPoint: -252.87,
    thermalConductivity: 0.1805,   // gas at 25C
    specificHeatCapacity: 14304,   // J/(kg*K) gas
    debyeTemperature: 110,         // solid H2
    thermalExpansion: 0,           // gas — not applicable
    emissivity: 0.05,              // estimate for transparent gas

    // Mechanical (gas)
    youngsModulus: 0,
    tensileStrength: 0,
    hardness: 0,
    poissonRatio: 0,

    // Electrical / Acoustic
    electricalConductivity: 0,     // insulating gas
    acousticEfficiency: 0,
    dampingLossTangent: 0,

    // Liquid
    liquidViscosity: 1.3e-5,      // liquid H2 at 20K
    liquidSurfaceTension: 0.00192, // N/m liquid H2

    // Andrade
    andradeA: 5.0e-6,             // estimate for liquid H2
    andradeEa: 500,               // J/mol — very low barrier

    // Norton (gas — not applicable)
    nortonA: 0,
    nortonN: 0,
    nortonQ: 0,

    // Avrami (gas — not applicable)
    avramiK0: 0,
    avramiQ: 0,
    avramiN: 0,

    // Fleischer (gas — not applicable)
    fleischerB: 0,

    // Basquin (gas — not applicable)
    basquinSigmaF: 0,
    basquinB: 0,

    // Fracture toughness (gas)
    fractureToughness: 0,

    // Thermochemical
    standardEnthalpy: 0,           // element in standard state
    standardEntropy: 130.68,       // J/(mol*K) — H2(g)
    activationEnergy: 0,           // elemental H2 does not oxidize in normal sense

    // Optical
    refractiveIndex: 1.000132,     // gas at STP
    absorptionRGB: [0.001, 0.001, 0.001],  // essentially transparent

    // Electromagnetic
    standardElectrodePotential: 0.000,  // reference electrode by definition
    magneticPermeability: 1.0,
    triboelectricIndex: 0,
  },

  // ════════════════════════════════════════════════════════════════════════
  // C — Carbon (graphite standard state, diamond noted)
  // ════════════════════════════════════════════════════════════════════════
  C: {
    // Atomic
    atomicNumber: 6,
    atomicMass: 12.011,
    atomicRadius: 77,              // covalent
    electronegativity: 2.55,
    valence: 4,
    crystalStructure: 'other',     // graphite layers; diamond = 'diamond'

    // Thermal
    meltingPoint: 3550,            // sublimation point (graphite)
    boilingPoint: 4027,            // sublimation
    thermalConductivity: 119,      // graphite in-plane ~119-165; using 119
    specificHeatCapacity: 709,     // graphite at 25C
    debyeTemperature: 2230,        // very high — light element
    thermalExpansion: 7.1,         // graphite parallel to basal plane
    emissivity: 0.85,             // graphite, rough surface

    // Mechanical (graphite)
    youngsModulus: 8,              // graphite cross-plane ~8 GPa (in-plane ~1000)
    tensileStrength: 25,           // graphite bulk
    hardness: 1.5,                 // graphite (diamond = 10)
    poissonRatio: 0.20,            // graphite

    // Electrical / Acoustic
    electricalConductivity: 3.0e4, // graphite ~3e4 S/m in-plane
    acousticEfficiency: 0.002,     // poor sound radiator
    dampingLossTangent: 0.01,      // moderate damping

    // Liquid
    liquidViscosity: 5.0e-3,      // estimate for liquid carbon at 4000K+
    liquidSurfaceTension: 1.77,    // liquid carbon, high surface energy

    // Andrade
    andradeA: 1.5e-4,             // estimate
    andradeEa: 60000,             // J/mol — high mp, high Ea

    // Norton (graphite creep)
    nortonA: 1.0e-20,             // estimate — graphite creeps slowly
    nortonN: 1.5,
    nortonQ: 200000,              // J/mol

    // Avrami (graphite->diamond or phase transformations)
    avramiK0: 1.0e6,              // estimate
    avramiQ: 350000,              // J/mol — high barrier
    avramiN: 2.0,

    // Fleischer
    fleischerB: 150,               // C dissolved in Fe: strong strengthener

    // Basquin (graphite)
    basquinSigmaF: 20,
    basquinB: 0.10,

    // Fracture toughness
    fractureToughness: 1.0,        // graphite — very brittle

    // Thermochemical
    standardEnthalpy: 0,           // graphite is standard state
    standardEntropy: 5.74,         // J/(mol*K) graphite
    activationEnergy: 170,         // kJ/mol — C oxidation (combustion)

    // Optical
    refractiveIndex: 2.42,         // diamond; graphite is opaque
    absorptionRGB: [1e6, 1e6, 1e6], // graphite: opaque black

    // Electromagnetic
    standardElectrodePotential: 0.207,  // C(s) + 4H+ + 4e- -> CH4; approx
    magneticPermeability: 1.0,
    triboelectricIndex: 0.0,
  },

  // ════════════════════════════════════════════════════════════════════════
  // N — Nitrogen
  // ════════════════════════════════════════════════════════════════════════
  N: {
    // Atomic
    atomicNumber: 7,
    atomicMass: 14.007,
    atomicRadius: 71,              // covalent
    electronegativity: 3.04,
    valence: -3,
    crystalStructure: 'diatomic',

    // Thermal
    meltingPoint: -210.0,
    boilingPoint: -195.79,
    thermalConductivity: 0.02583,  // gas at 25C
    specificHeatCapacity: 1040,    // gas, J/(kg*K)
    debyeTemperature: 56,         // solid N2
    thermalExpansion: 0,           // gas
    emissivity: 0.05,             // transparent gas estimate

    // Mechanical (gas)
    youngsModulus: 0,
    tensileStrength: 0,
    hardness: 0,
    poissonRatio: 0,

    // Electrical / Acoustic
    electricalConductivity: 0,
    acousticEfficiency: 0,
    dampingLossTangent: 0,

    // Liquid
    liquidViscosity: 1.58e-4,     // liquid N2 at 77K
    liquidSurfaceTension: 0.00885, // N/m at 77K

    // Andrade
    andradeA: 5.0e-5,
    andradeEa: 1500,              // J/mol — very low

    // Norton (gas)
    nortonA: 0,
    nortonN: 0,
    nortonQ: 0,

    // Avrami (gas)
    avramiK0: 0,
    avramiQ: 0,
    avramiN: 0,

    // Fleischer
    fleischerB: 0,

    // Basquin (gas)
    basquinSigmaF: 0,
    basquinB: 0,

    // Fracture toughness (gas)
    fractureToughness: 0,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 191.61,       // N2(g)
    activationEnergy: 0,           // N2 highly inert

    // Optical
    refractiveIndex: 1.000298,
    absorptionRGB: [0.0005, 0.0005, 0.0005],

    // Electromagnetic
    standardElectrodePotential: -3.04, // N2 + 4H2O + 4e- -> N2H4 + 4OH-; approx
    magneticPermeability: 1.0,
    triboelectricIndex: 0,
  },

  // ════════════════════════════════════════════════════════════════════════
  // O — Oxygen
  // ════════════════════════════════════════════════════════════════════════
  O: {
    // Atomic
    atomicNumber: 8,
    atomicMass: 15.999,
    atomicRadius: 66,              // covalent
    electronegativity: 3.44,
    valence: -2,
    crystalStructure: 'diatomic',

    // Thermal
    meltingPoint: -218.79,
    boilingPoint: -182.96,
    thermalConductivity: 0.02658,  // gas at 25C
    specificHeatCapacity: 919,     // gas
    debyeTemperature: 155,         // solid O2
    thermalExpansion: 0,           // gas
    emissivity: 0.05,             // transparent gas estimate

    // Mechanical (gas)
    youngsModulus: 0,
    tensileStrength: 0,
    hardness: 0,
    poissonRatio: 0,

    // Electrical / Acoustic
    electricalConductivity: 0,
    acousticEfficiency: 0,
    dampingLossTangent: 0,

    // Liquid
    liquidViscosity: 1.89e-4,     // liquid O2 at 90K
    liquidSurfaceTension: 0.01321, // N/m at 90K

    // Andrade
    andradeA: 6.0e-5,
    andradeEa: 1800,              // J/mol

    // Norton (gas)
    nortonA: 0,
    nortonN: 0,
    nortonQ: 0,

    // Avrami (gas)
    avramiK0: 0,
    avramiQ: 0,
    avramiN: 0,

    // Fleischer
    fleischerB: 0,

    // Basquin (gas)
    basquinSigmaF: 0,
    basquinB: 0,

    // Fracture toughness (gas)
    fractureToughness: 0,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 205.15,       // O2(g)
    activationEnergy: 0,           // O2 is the oxidizer itself

    // Optical
    refractiveIndex: 1.000271,
    absorptionRGB: [0.0005, 0.0005, 0.001],  // slight UV absorption

    // Electromagnetic
    standardElectrodePotential: 1.229, // O2 + 4H+ + 4e- -> 2H2O
    magneticPermeability: 1.000002,    // paramagnetic
    triboelectricIndex: 0,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Na — Sodium
  // ════════════════════════════════════════════════════════════════════════
  Na: {
    // Atomic
    atomicNumber: 11,
    atomicMass: 22.990,
    atomicRadius: 186,             // metallic
    electronegativity: 0.93,
    valence: 1,
    crystalStructure: 'BCC',

    // Thermal
    meltingPoint: 97.79,
    boilingPoint: 882.94,
    thermalConductivity: 142,
    specificHeatCapacity: 1228,
    debyeTemperature: 158,
    thermalExpansion: 71.0,        // very high — soft metal
    emissivity: 0.07,             // freshly cut Na, very reflective

    // Mechanical
    youngsModulus: 10,
    tensileStrength: 2,            // very soft
    hardness: 0.5,
    poissonRatio: 0.32,

    // Electrical / Acoustic
    electricalConductivity: 2.1e7,
    acousticEfficiency: 0.005,     // soft metal — poor sound
    dampingLossTangent: 0.02,

    // Liquid
    liquidViscosity: 6.8e-4,      // at 98C
    liquidSurfaceTension: 0.191,   // N/m at mp

    // Andrade
    andradeA: 4.5e-4,             // Smithells
    andradeEa: 10200,             // J/mol

    // Norton (Na creeps extremely easily)
    nortonA: 1.0e-4,              // estimate — very soft
    nortonN: 3.0,
    nortonQ: 45000,               // J/mol

    // Avrami
    avramiK0: 1.0e4,              // estimate
    avramiQ: 40000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 5,                 // weak strengthener

    // Basquin
    basquinSigmaF: 5,
    basquinB: 0.12,

    // Fracture toughness
    fractureToughness: 10,         // ductile but very weak

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 51.21,
    activationEnergy: 30,          // kJ/mol — Na oxidizes extremely easily

    // Optical
    refractiveIndex: 0.045,        // metallic — real part of complex n at visible
    absorptionRGB: [5e5, 5e5, 5e5], // silvery metal, reflective

    // Electromagnetic
    standardElectrodePotential: -2.714,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.3,       // metal, tends positive
  },

  // ════════════════════════════════════════════════════════════════════════
  // Mg — Magnesium
  // ════════════════════════════════════════════════════════════════════════
  Mg: {
    // Atomic
    atomicNumber: 12,
    atomicMass: 24.305,
    atomicRadius: 160,
    electronegativity: 1.31,
    valence: 2,
    crystalStructure: 'HCP',

    // Thermal
    meltingPoint: 650,
    boilingPoint: 1091,
    thermalConductivity: 156,
    specificHeatCapacity: 1023,
    debyeTemperature: 400,
    thermalExpansion: 24.8,
    emissivity: 0.07,

    // Mechanical
    youngsModulus: 45,
    tensileStrength: 190,
    hardness: 2.5,
    poissonRatio: 0.29,

    // Electrical / Acoustic
    electricalConductivity: 2.27e7,
    acousticEfficiency: 0.008,
    dampingLossTangent: 0.005,

    // Liquid
    liquidViscosity: 1.25e-3,     // at mp
    liquidSurfaceTension: 0.559,

    // Andrade
    andradeA: 5.0e-4,             // Iida & Guthrie
    andradeEa: 16000,

    // Norton (Mg creep — HCP, moderate)
    nortonA: 2.5e-12,             // Frost & Ashby
    nortonN: 5.0,
    nortonQ: 135000,

    // Avrami
    avramiK0: 1.0e5,
    avramiQ: 100000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 40,                // moderate strengthener

    // Basquin
    basquinSigmaF: 130,
    basquinB: 0.09,

    // Fracture toughness
    fractureToughness: 18,         // moderate

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 32.67,
    activationEnergy: 150,         // kJ/mol — Mg oxidation

    // Optical
    refractiveIndex: 0.37,
    absorptionRGB: [4e5, 4.2e5, 4.5e5],  // silvery white

    // Electromagnetic
    standardElectrodePotential: -2.372,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.2,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Al — Aluminum
  // ════════════════════════════════════════════════════════════════════════
  Al: {
    // Atomic
    atomicNumber: 13,
    atomicMass: 26.982,
    atomicRadius: 143,
    electronegativity: 1.61,
    valence: 3,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 660.32,
    boilingPoint: 2519,
    thermalConductivity: 237,
    specificHeatCapacity: 897,
    debyeTemperature: 428,
    thermalExpansion: 23.1,
    emissivity: 0.04,             // polished Al

    // Mechanical
    youngsModulus: 70,
    tensileStrength: 90,           // pure Al
    hardness: 2.75,
    poissonRatio: 0.35,

    // Electrical / Acoustic
    electricalConductivity: 3.77e7,
    acousticEfficiency: 0.010,
    dampingLossTangent: 0.001,     // very low damping

    // Liquid
    liquidViscosity: 1.3e-3,      // at 660C
    liquidSurfaceTension: 0.868,

    // Andrade
    andradeA: 4.7e-4,             // Iida & Guthrie
    andradeEa: 16500,

    // Norton (Al creep — FCC, well studied)
    nortonA: 1.7e-10,             // Frost & Ashby for pure Al
    nortonN: 4.4,
    nortonQ: 142000,              // close to self-diffusion Q

    // Avrami (Al precipitation, e.g. GP zones)
    avramiK0: 1.0e8,
    avramiQ: 130000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 30,

    // Basquin
    basquinSigmaF: 110,
    basquinB: 0.10,

    // Fracture toughness
    fractureToughness: 35,         // moderate-high for pure Al

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 28.33,
    activationEnergy: 200,         // kJ/mol — Al2O3 formation

    // Optical
    refractiveIndex: 1.44,         // complex; real part at 589nm
    absorptionRGB: [8e5, 8e5, 8e5], // highly reflective silvery

    // Electromagnetic
    standardElectrodePotential: -1.662,
    magneticPermeability: 1.000022,
    triboelectricIndex: 0.1,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Si — Silicon
  // ════════════════════════════════════════════════════════════════════════
  Si: {
    // Atomic
    atomicNumber: 14,
    atomicMass: 28.086,
    atomicRadius: 111,             // covalent
    electronegativity: 1.90,
    valence: 4,
    crystalStructure: 'diamond',

    // Thermal
    meltingPoint: 1414,
    boilingPoint: 3265,
    thermalConductivity: 150,
    specificHeatCapacity: 710,
    debyeTemperature: 645,
    thermalExpansion: 2.6,         // very low — covalent bonding
    emissivity: 0.65,             // polished Si wafer

    // Mechanical
    youngsModulus: 130,            // single crystal avg
    tensileStrength: 70,           // polycrystalline
    hardness: 7,
    poissonRatio: 0.22,

    // Electrical / Acoustic
    electricalConductivity: 1.0e-3, // intrinsic semiconductor
    acousticEfficiency: 0.005,
    dampingLossTangent: 0.0001,    // extremely low — single crystal

    // Liquid
    liquidViscosity: 7.0e-4,      // at mp
    liquidSurfaceTension: 0.865,

    // Andrade
    andradeA: 3.0e-4,
    andradeEa: 25000,

    // Norton (Si creep — very hard, high activation)
    nortonA: 1.0e-24,             // extremely creep resistant
    nortonN: 3.5,
    nortonQ: 510000,              // very high

    // Avrami
    avramiK0: 1.0e7,
    avramiQ: 300000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 100,               // Si in metals — strong strengthener

    // Basquin
    basquinSigmaF: 60,
    basquinB: 0.08,

    // Fracture toughness
    fractureToughness: 0.9,        // brittle semiconductor

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 18.83,
    activationEnergy: 180,         // kJ/mol — SiO2 formation

    // Optical
    refractiveIndex: 3.42,         // at 1550nm; 3.98 at 589nm
    absorptionRGB: [1e4, 5e3, 2e3], // absorbs visible (band gap 1.12eV)

    // Electromagnetic
    standardElectrodePotential: -0.857,
    magneticPermeability: 1.0,
    triboelectricIndex: -0.2,
  },

  // ════════════════════════════════════════════════════════════════════════
  // P — Phosphorus (white phosphorus reference)
  // ════════════════════════════════════════════════════════════════════════
  P: {
    // Atomic
    atomicNumber: 15,
    atomicMass: 30.974,
    atomicRadius: 107,             // covalent
    electronegativity: 2.19,
    valence: 5,
    crystalStructure: 'other',     // P4 molecular solid (white) or orthorhombic (black)

    // Thermal
    meltingPoint: 44.15,           // white phosphorus
    boilingPoint: 280.5,
    thermalConductivity: 0.236,    // white P
    specificHeatCapacity: 769,
    debyeTemperature: 195,
    thermalExpansion: 124.5,       // white P — very high
    emissivity: 0.90,             // waxy white surface

    // Mechanical (white P — soft waxy solid)
    youngsModulus: 5,              // estimate — very soft
    tensileStrength: 3,
    hardness: 0.5,
    poissonRatio: 0.30,

    // Electrical / Acoustic
    electricalConductivity: 1.0e-9, // insulator (white P)
    acousticEfficiency: 0.001,
    dampingLossTangent: 0.05,

    // Liquid
    liquidViscosity: 4.0e-3,      // liquid white P at 44C
    liquidSurfaceTension: 0.0699,

    // Andrade
    andradeA: 2.0e-3,
    andradeEa: 8000,

    // Norton (P — soft, low mp)
    nortonA: 1.0e-6,
    nortonN: 3.0,
    nortonQ: 30000,

    // Avrami
    avramiK0: 1.0e3,
    avramiQ: 25000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 80,                // P in steel: moderate strengthener, embrittler

    // Basquin
    basquinSigmaF: 5,
    basquinB: 0.12,

    // Fracture toughness
    fractureToughness: 0.5,        // extremely brittle

    // Thermochemical
    standardEnthalpy: 0,           // white P standard state
    standardEntropy: 41.09,
    activationEnergy: 60,          // kJ/mol — spontaneous in air (pyrophoric)

    // Optical
    refractiveIndex: 1.82,         // white P
    absorptionRGB: [1e2, 1e2, 5e1], // translucent waxy white

    // Electromagnetic
    standardElectrodePotential: -0.063,
    magneticPermeability: 1.0,
    triboelectricIndex: -0.1,
  },

  // ════════════════════════════════════════════════════════════════════════
  // S — Sulfur
  // ════════════════════════════════════════════════════════════════════════
  S: {
    // Atomic
    atomicNumber: 16,
    atomicMass: 32.06,
    atomicRadius: 105,             // covalent
    electronegativity: 2.58,
    valence: -2,
    crystalStructure: 'other',     // orthorhombic S8 rings

    // Thermal
    meltingPoint: 115.21,
    boilingPoint: 444.6,
    thermalConductivity: 0.269,
    specificHeatCapacity: 710,
    debyeTemperature: 200,
    thermalExpansion: 64.0,        // orthorhombic sulfur
    emissivity: 0.90,

    // Mechanical
    youngsModulus: 7.7,            // orthorhombic
    tensileStrength: 2,
    hardness: 2.0,
    poissonRatio: 0.33,

    // Electrical / Acoustic
    electricalConductivity: 5.0e-16, // excellent insulator
    acousticEfficiency: 0.001,
    dampingLossTangent: 0.03,

    // Liquid
    liquidViscosity: 1.1e-2,      // liquid S just above mp (lambda sulfur)
    liquidSurfaceTension: 0.0608,

    // Andrade
    andradeA: 5.0e-3,
    andradeEa: 12000,

    // Norton (S — very soft solid)
    nortonA: 1.0e-5,
    nortonN: 3.0,
    nortonQ: 40000,

    // Avrami
    avramiK0: 1.0e3,
    avramiQ: 30000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 70,                // S in Fe: moderate, causes hot shortness

    // Basquin
    basquinSigmaF: 3,
    basquinB: 0.12,

    // Fracture toughness
    fractureToughness: 0.2,        // extremely brittle molecular crystal

    // Thermochemical
    standardEnthalpy: 0,           // rhombic S
    standardEntropy: 31.80,
    activationEnergy: 85,          // kJ/mol — S combustion

    // Optical
    refractiveIndex: 2.04,         // orthorhombic S at 589nm
    absorptionRGB: [5e2, 2e3, 5e3], // yellow — absorbs blue/violet

    // Electromagnetic
    standardElectrodePotential: -0.476,
    magneticPermeability: 1.0,
    triboelectricIndex: -0.4,      // non-metal, tends negative
  },

  // ════════════════════════════════════════════════════════════════════════
  // Cl — Chlorine
  // ════════════════════════════════════════════════════════════════════════
  Cl: {
    // Atomic
    atomicNumber: 17,
    atomicMass: 35.45,
    atomicRadius: 102,             // covalent
    electronegativity: 3.16,
    valence: -1,
    crystalStructure: 'diatomic',

    // Thermal
    meltingPoint: -101.5,
    boilingPoint: -34.04,
    thermalConductivity: 0.0089,   // gas
    specificHeatCapacity: 479,     // gas
    debyeTemperature: 115,         // solid Cl2
    thermalExpansion: 0,           // gas
    emissivity: 0.10,             // pale green gas, some absorption

    // Mechanical (gas)
    youngsModulus: 0,
    tensileStrength: 0,
    hardness: 0,
    poissonRatio: 0,

    // Electrical / Acoustic
    electricalConductivity: 0,
    acousticEfficiency: 0,
    dampingLossTangent: 0,

    // Liquid
    liquidViscosity: 3.4e-4,      // liquid Cl2 at -34C
    liquidSurfaceTension: 0.0184,

    // Andrade
    andradeA: 1.0e-4,
    andradeEa: 3000,

    // Norton (gas)
    nortonA: 0,
    nortonN: 0,
    nortonQ: 0,

    // Avrami (gas)
    avramiK0: 0,
    avramiQ: 0,
    avramiN: 0,

    // Fleischer
    fleischerB: 0,

    // Basquin (gas)
    basquinSigmaF: 0,
    basquinB: 0,

    // Fracture toughness (gas)
    fractureToughness: 0,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 223.08,       // Cl2(g)
    activationEnergy: 0,

    // Optical
    refractiveIndex: 1.000773,     // gas
    absorptionRGB: [100, 50, 10],  // yellow-green gas, absorbs blue/red

    // Electromagnetic
    standardElectrodePotential: 1.358, // Cl2 + 2e- -> 2Cl-
    magneticPermeability: 1.0,
    triboelectricIndex: -0.6,      // highly electronegative
  },

  // ════════════════════════════════════════════════════════════════════════
  // K — Potassium
  // ════════════════════════════════════════════════════════════════════════
  K: {
    // Atomic
    atomicNumber: 19,
    atomicMass: 39.098,
    atomicRadius: 227,
    electronegativity: 0.82,
    valence: 1,
    crystalStructure: 'BCC',

    // Thermal
    meltingPoint: 63.5,
    boilingPoint: 759,
    thermalConductivity: 102.5,
    specificHeatCapacity: 757,
    debyeTemperature: 91,
    thermalExpansion: 83.3,
    emissivity: 0.07,

    // Mechanical
    youngsModulus: 3.5,
    tensileStrength: 1.3,
    hardness: 0.4,
    poissonRatio: 0.31,

    // Electrical / Acoustic
    electricalConductivity: 1.39e7,
    acousticEfficiency: 0.003,
    dampingLossTangent: 0.03,

    // Liquid
    liquidViscosity: 5.4e-4,
    liquidSurfaceTension: 0.115,

    // Andrade
    andradeA: 3.5e-4,
    andradeEa: 8500,

    // Norton
    nortonA: 5.0e-4,
    nortonN: 3.0,
    nortonQ: 35000,

    // Avrami
    avramiK0: 1.0e4,
    avramiQ: 30000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 3,

    // Basquin
    basquinSigmaF: 3,
    basquinB: 0.12,

    // Fracture toughness
    fractureToughness: 8,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 64.18,
    activationEnergy: 25,          // kJ/mol — extremely reactive

    // Optical
    refractiveIndex: 0.04,
    absorptionRGB: [5e5, 5e5, 5e5],

    // Electromagnetic
    standardElectrodePotential: -2.924,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.3,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Ca — Calcium
  // ════════════════════════════════════════════════════════════════════════
  Ca: {
    // Atomic
    atomicNumber: 20,
    atomicMass: 40.078,
    atomicRadius: 197,
    electronegativity: 1.00,
    valence: 2,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 842,
    boilingPoint: 1484,
    thermalConductivity: 201,
    specificHeatCapacity: 647,
    debyeTemperature: 230,
    thermalExpansion: 22.3,
    emissivity: 0.15,

    // Mechanical
    youngsModulus: 20,
    tensileStrength: 110,
    hardness: 1.75,
    poissonRatio: 0.31,

    // Electrical / Acoustic
    electricalConductivity: 2.98e7,
    acousticEfficiency: 0.007,
    dampingLossTangent: 0.008,

    // Liquid
    liquidViscosity: 1.4e-3,
    liquidSurfaceTension: 0.361,

    // Andrade
    andradeA: 6.0e-4,
    andradeEa: 18000,

    // Norton
    nortonA: 1.0e-8,
    nortonN: 4.0,
    nortonQ: 100000,

    // Avrami
    avramiK0: 1.0e5,
    avramiQ: 80000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 15,

    // Basquin
    basquinSigmaF: 80,
    basquinB: 0.10,

    // Fracture toughness
    fractureToughness: 15,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 41.42,
    activationEnergy: 120,         // kJ/mol

    // Optical
    refractiveIndex: 0.20,
    absorptionRGB: [3e5, 3.5e5, 4e5],

    // Electromagnetic
    standardElectrodePotential: -2.868,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.2,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Ti — Titanium
  // ════════════════════════════════════════════════════════════════════════
  Ti: {
    // Atomic
    atomicNumber: 22,
    atomicMass: 47.867,
    atomicRadius: 147,
    electronegativity: 1.54,
    valence: 4,
    crystalStructure: 'HCP',

    // Thermal
    meltingPoint: 1668,
    boilingPoint: 3287,
    thermalConductivity: 21.9,
    specificHeatCapacity: 523,
    debyeTemperature: 420,
    thermalExpansion: 8.6,
    emissivity: 0.19,

    // Mechanical
    youngsModulus: 116,
    tensileStrength: 434,          // commercially pure Ti Grade 2
    hardness: 6.0,
    poissonRatio: 0.32,

    // Electrical / Acoustic
    electricalConductivity: 2.38e6,
    acousticEfficiency: 0.010,
    dampingLossTangent: 0.002,

    // Liquid
    liquidViscosity: 2.2e-3,
    liquidSurfaceTension: 1.650,

    // Andrade
    andradeA: 6.5e-4,
    andradeEa: 30000,

    // Norton (Ti creep — HCP, moderate resistance)
    nortonA: 1.5e-14,             // ASM Handbook
    nortonN: 4.5,
    nortonQ: 240000,

    // Avrami (Ti alloy precipitation, e.g. alpha-beta)
    avramiK0: 1.0e7,
    avramiQ: 180000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 60,

    // Basquin
    basquinSigmaF: 350,
    basquinB: 0.07,

    // Fracture toughness
    fractureToughness: 60,         // high toughness

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 30.63,
    activationEnergy: 250,         // kJ/mol — TiO2 extremely stable

    // Optical
    refractiveIndex: 2.16,
    absorptionRGB: [3e5, 3e5, 3.5e5],  // silvery grey

    // Electromagnetic
    standardElectrodePotential: -1.630,
    magneticPermeability: 1.00018,
    triboelectricIndex: 0.05,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Cr — Chromium
  // ════════════════════════════════════════════════════════════════════════
  Cr: {
    // Atomic
    atomicNumber: 24,
    atomicMass: 51.996,
    atomicRadius: 128,
    electronegativity: 1.66,
    valence: 3,
    crystalStructure: 'BCC',

    // Thermal
    meltingPoint: 1907,
    boilingPoint: 2671,
    thermalConductivity: 93.9,
    specificHeatCapacity: 449,
    debyeTemperature: 630,
    thermalExpansion: 4.9,
    emissivity: 0.08,             // polished Cr

    // Mechanical
    youngsModulus: 279,
    tensileStrength: 280,          // pure Cr — hard but brittle
    hardness: 8.5,
    poissonRatio: 0.21,

    // Electrical / Acoustic
    electricalConductivity: 7.87e6,
    acousticEfficiency: 0.012,
    dampingLossTangent: 0.001,

    // Liquid
    liquidViscosity: 2.8e-3,
    liquidSurfaceTension: 1.700,

    // Andrade
    andradeA: 7.0e-4,
    andradeEa: 38000,

    // Norton (Cr creep — BCC, high mp)
    nortonA: 1.0e-16,
    nortonN: 4.0,
    nortonQ: 280000,

    // Avrami
    avramiK0: 1.0e6,
    avramiQ: 200000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 90,                // Cr in Fe: strong solid solution strengthener

    // Basquin
    basquinSigmaF: 200,
    basquinB: 0.08,

    // Fracture toughness
    fractureToughness: 10,         // BCC — brittle at RT

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 23.77,
    activationEnergy: 220,         // kJ/mol — Cr2O3 very stable

    // Optical
    refractiveIndex: 3.11,
    absorptionRGB: [4e5, 4e5, 4.5e5],  // bright silvery

    // Electromagnetic
    standardElectrodePotential: -0.744,
    magneticPermeability: 1.0003,  // antiferromagnetic, nearly paramagnetic at RT
    triboelectricIndex: 0.05,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Mn — Manganese
  // ════════════════════════════════════════════════════════════════════════
  Mn: {
    // Atomic
    atomicNumber: 25,
    atomicMass: 54.938,
    atomicRadius: 127,
    electronegativity: 1.55,
    valence: 2,
    crystalStructure: 'BCC',      // alpha-Mn is complex, but BCC-like for game

    // Thermal
    meltingPoint: 1246,
    boilingPoint: 2061,
    thermalConductivity: 7.81,
    specificHeatCapacity: 479,
    debyeTemperature: 410,
    thermalExpansion: 21.7,
    emissivity: 0.18,

    // Mechanical
    youngsModulus: 198,
    tensileStrength: 500,
    hardness: 6.0,
    poissonRatio: 0.24,

    // Electrical / Acoustic
    electricalConductivity: 6.94e5,
    acousticEfficiency: 0.008,
    dampingLossTangent: 0.003,

    // Liquid
    liquidViscosity: 2.5e-3,
    liquidSurfaceTension: 1.090,

    // Andrade
    andradeA: 6.5e-4,
    andradeEa: 25000,

    // Norton
    nortonA: 1.0e-14,
    nortonN: 4.5,
    nortonQ: 230000,

    // Avrami
    avramiK0: 1.0e6,
    avramiQ: 170000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 55,

    // Basquin
    basquinSigmaF: 350,
    basquinB: 0.08,

    // Fracture toughness
    fractureToughness: 22,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 32.01,
    activationEnergy: 150,

    // Optical
    refractiveIndex: 2.50,
    absorptionRGB: [4e5, 4e5, 4e5],

    // Electromagnetic
    standardElectrodePotential: -1.185,
    magneticPermeability: 1.001,   // paramagnetic
    triboelectricIndex: 0.05,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Fe — Iron
  // ════════════════════════════════════════════════════════════════════════
  Fe: {
    // Atomic
    atomicNumber: 26,
    atomicMass: 55.845,
    atomicRadius: 126,
    electronegativity: 1.83,
    valence: 3,
    crystalStructure: 'BCC',      // alpha-Fe at RT

    // Thermal
    meltingPoint: 1538,
    boilingPoint: 2861,
    thermalConductivity: 80.4,
    specificHeatCapacity: 449,
    debyeTemperature: 470,
    thermalExpansion: 11.8,
    emissivity: 0.16,             // polished Fe

    // Mechanical
    youngsModulus: 211,
    tensileStrength: 540,          // pure iron, annealed
    hardness: 4.0,
    poissonRatio: 0.29,

    // Electrical / Acoustic
    electricalConductivity: 1.03e7,
    acousticEfficiency: 0.012,
    dampingLossTangent: 0.001,

    // Liquid
    liquidViscosity: 6.93e-3,     // at 1538C — Iida & Guthrie
    liquidSurfaceTension: 1.862,

    // Andrade — well-studied system
    andradeA: 4.35e-4,            // Battezzati & Greer, verified Iida
    andradeEa: 41400,             // J/mol — Fe activation energy for viscous flow

    // Norton (Fe creep — BCC, well studied)
    nortonA: 6.7e-15,             // Frost & Ashby deformation-mechanism maps
    nortonN: 4.5,
    nortonQ: 284000,              // J/mol — self-diffusion in alpha-Fe

    // Avrami (Fe — pearlite/bainite transformation)
    avramiK0: 1.0e8,              // fitted from TTT diagrams
    avramiQ: 160000,
    avramiN: 3.0,

    // Fleischer
    fleischerB: 0,                 // Fe is the matrix in steels; B is for solutes IN Fe

    // Basquin
    basquinSigmaF: 400,
    basquinB: 0.08,

    // Fracture toughness
    fractureToughness: 36,         // pure iron, BCC — moderate

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 27.28,
    activationEnergy: 170,         // kJ/mol — Fe2O3 formation

    // Optical
    refractiveIndex: 2.87,
    absorptionRGB: [3.5e5, 3.5e5, 3.5e5],  // grey metallic

    // Electromagnetic
    standardElectrodePotential: -0.447,
    magneticPermeability: 5000,    // ferromagnetic! (initial permeability)
    triboelectricIndex: 0.1,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Ni — Nickel
  // ════════════════════════════════════════════════════════════════════════
  Ni: {
    // Atomic
    atomicNumber: 28,
    atomicMass: 58.693,
    atomicRadius: 124,
    electronegativity: 1.91,
    valence: 2,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 1455,
    boilingPoint: 2913,
    thermalConductivity: 90.9,
    specificHeatCapacity: 444,
    debyeTemperature: 450,
    thermalExpansion: 13.4,
    emissivity: 0.11,

    // Mechanical
    youngsModulus: 200,
    tensileStrength: 462,
    hardness: 4.0,
    poissonRatio: 0.31,

    // Electrical / Acoustic
    electricalConductivity: 1.43e7,
    acousticEfficiency: 0.011,
    dampingLossTangent: 0.001,

    // Liquid
    liquidViscosity: 4.90e-3,     // Iida & Guthrie
    liquidSurfaceTension: 1.778,

    // Andrade
    andradeA: 3.7e-4,             // Iida & Guthrie
    andradeEa: 40600,

    // Norton (Ni creep — FCC, well studied, superalloy base)
    nortonA: 4.0e-12,             // Frost & Ashby
    nortonN: 4.6,
    nortonQ: 284000,              // same as Fe approximately

    // Avrami (Ni — gamma prime precipitation in Ni-alloys)
    avramiK0: 1.0e9,
    avramiQ: 200000,
    avramiN: 3.0,

    // Fleischer
    fleischerB: 45,                // Ni in Fe: moderate strengthener

    // Basquin
    basquinSigmaF: 380,
    basquinB: 0.07,

    // Fracture toughness
    fractureToughness: 100,        // FCC — very tough

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 29.87,
    activationEnergy: 160,         // kJ/mol — NiO

    // Optical
    refractiveIndex: 1.97,
    absorptionRGB: [3.5e5, 3.5e5, 3.5e5],

    // Electromagnetic
    standardElectrodePotential: -0.257,
    magneticPermeability: 600,     // ferromagnetic
    triboelectricIndex: 0.1,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Cu — Copper
  // ════════════════════════════════════════════════════════════════════════
  Cu: {
    // Atomic
    atomicNumber: 29,
    atomicMass: 63.546,
    atomicRadius: 128,
    electronegativity: 1.90,
    valence: 2,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 1084.62,
    boilingPoint: 2562,
    thermalConductivity: 401,
    specificHeatCapacity: 385,
    debyeTemperature: 343,
    thermalExpansion: 16.5,
    emissivity: 0.03,             // polished Cu

    // Mechanical
    youngsModulus: 130,
    tensileStrength: 210,          // annealed pure Cu
    hardness: 3.0,
    poissonRatio: 0.34,

    // Electrical / Acoustic
    electricalConductivity: 5.96e7, // IACS reference
    acousticEfficiency: 0.012,
    dampingLossTangent: 0.001,

    // Liquid
    liquidViscosity: 4.0e-3,      // at mp — Iida & Guthrie
    liquidSurfaceTension: 1.285,

    // Andrade
    andradeA: 3.0e-4,             // Iida & Guthrie
    andradeEa: 30500,

    // Norton (Cu creep — FCC, well studied)
    nortonA: 2.0e-10,             // Frost & Ashby
    nortonN: 4.8,
    nortonQ: 197000,              // self-diffusion Q for Cu

    // Avrami (Cu alloy precipitation)
    avramiK0: 1.0e8,
    avramiQ: 140000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 0,                 // Cu is often the matrix

    // Basquin
    basquinSigmaF: 250,
    basquinB: 0.08,

    // Fracture toughness
    fractureToughness: 70,         // FCC — ductile and tough

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 33.15,
    activationEnergy: 140,         // kJ/mol — CuO formation

    // Optical
    refractiveIndex: 0.62,         // complex n at 589nm
    absorptionRGB: [2e5, 4e5, 5e5], // copper color: absorbs blue/green

    // Electromagnetic
    standardElectrodePotential: 0.342,  // Cu2+ + 2e- -> Cu
    magneticPermeability: 0.999994,     // diamagnetic
    triboelectricIndex: 0.15,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Zn — Zinc
  // ════════════════════════════════════════════════════════════════════════
  Zn: {
    // Atomic
    atomicNumber: 30,
    atomicMass: 65.38,
    atomicRadius: 134,
    electronegativity: 1.65,
    valence: 2,
    crystalStructure: 'HCP',

    // Thermal
    meltingPoint: 419.53,
    boilingPoint: 907,
    thermalConductivity: 116,
    specificHeatCapacity: 388,
    debyeTemperature: 327,
    thermalExpansion: 30.2,
    emissivity: 0.05,

    // Mechanical
    youngsModulus: 108,
    tensileStrength: 120,
    hardness: 2.5,
    poissonRatio: 0.25,

    // Electrical / Acoustic
    electricalConductivity: 1.69e7,
    acousticEfficiency: 0.009,
    dampingLossTangent: 0.002,

    // Liquid
    liquidViscosity: 3.85e-3,     // at mp
    liquidSurfaceTension: 0.782,

    // Andrade
    andradeA: 4.0e-4,
    andradeEa: 16500,

    // Norton
    nortonA: 5.0e-10,
    nortonN: 5.0,
    nortonQ: 92000,               // relatively low for HCP

    // Avrami
    avramiK0: 1.0e6,
    avramiQ: 80000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 35,                // Zn in Cu: brass strengthening

    // Basquin
    basquinSigmaF: 90,
    basquinB: 0.09,

    // Fracture toughness
    fractureToughness: 25,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 41.63,
    activationEnergy: 100,

    // Optical
    refractiveIndex: 1.93,
    absorptionRGB: [3.5e5, 4e5, 4.5e5],  // bluish-silver

    // Electromagnetic
    standardElectrodePotential: -0.762,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.1,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Sn — Tin
  // ════════════════════════════════════════════════════════════════════════
  Sn: {
    // Atomic
    atomicNumber: 50,
    atomicMass: 118.710,
    atomicRadius: 145,
    electronegativity: 1.96,
    valence: 4,
    crystalStructure: 'other',     // beta-tin: tetragonal

    // Thermal
    meltingPoint: 231.93,
    boilingPoint: 2602,
    thermalConductivity: 66.8,
    specificHeatCapacity: 228,
    debyeTemperature: 200,
    thermalExpansion: 22.0,
    emissivity: 0.06,

    // Mechanical
    youngsModulus: 50,
    tensileStrength: 15,           // pure Sn — very soft
    hardness: 1.5,
    poissonRatio: 0.36,

    // Electrical / Acoustic
    electricalConductivity: 9.17e6,
    acousticEfficiency: 0.010,     // tin cry phenomenon
    dampingLossTangent: 0.005,

    // Liquid
    liquidViscosity: 1.85e-3,     // at mp
    liquidSurfaceTension: 0.560,

    // Andrade
    andradeA: 5.5e-4,
    andradeEa: 10000,

    // Norton (Sn creep — very soft, low mp)
    nortonA: 1.0e-5,              // creeps readily
    nortonN: 7.0,                  // high stress exponent at low homologous T
    nortonQ: 60000,

    // Avrami
    avramiK0: 1.0e5,
    avramiQ: 50000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 25,                // Sn in Cu: bronze strengthening

    // Basquin
    basquinSigmaF: 12,
    basquinB: 0.10,

    // Fracture toughness
    fractureToughness: 30,         // ductile

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 51.18,        // white tin
    activationEnergy: 80,

    // Optical
    refractiveIndex: 1.75,
    absorptionRGB: [4e5, 4e5, 4e5],  // silvery-white

    // Electromagnetic
    standardElectrodePotential: -0.138,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.05,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Pb — Lead
  // ════════════════════════════════════════════════════════════════════════
  Pb: {
    // Atomic
    atomicNumber: 82,
    atomicMass: 207.2,
    atomicRadius: 175,
    electronegativity: 2.33,
    valence: 2,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 327.46,
    boilingPoint: 1749,
    thermalConductivity: 35.3,
    specificHeatCapacity: 129,
    debyeTemperature: 105,
    thermalExpansion: 28.9,
    emissivity: 0.28,

    // Mechanical
    youngsModulus: 16,
    tensileStrength: 18,
    hardness: 1.5,
    poissonRatio: 0.44,

    // Electrical / Acoustic
    electricalConductivity: 4.81e6,
    acousticEfficiency: 0.003,     // very damped
    dampingLossTangent: 0.015,

    // Liquid
    liquidViscosity: 2.65e-3,     // at mp
    liquidSurfaceTension: 0.458,

    // Andrade
    andradeA: 4.8e-4,             // Iida & Guthrie
    andradeEa: 9800,

    // Norton (Pb creep — very soft, extremely easy)
    nortonA: 1.0e-3,
    nortonN: 5.0,
    nortonQ: 50000,

    // Avrami
    avramiK0: 1.0e4,
    avramiQ: 40000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 10,

    // Basquin
    basquinSigmaF: 15,
    basquinB: 0.12,

    // Fracture toughness
    fractureToughness: 20,         // soft and ductile but very weak

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 64.81,
    activationEnergy: 60,

    // Optical
    refractiveIndex: 2.01,
    absorptionRGB: [4e5, 4e5, 4.2e5],  // dull grey

    // Electromagnetic
    standardElectrodePotential: -0.126,
    magneticPermeability: 1.0,
    triboelectricIndex: 0.05,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Ag — Silver
  // ════════════════════════════════════════════════════════════════════════
  Ag: {
    // Atomic
    atomicNumber: 47,
    atomicMass: 107.868,
    atomicRadius: 144,
    electronegativity: 1.93,
    valence: 1,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 961.78,
    boilingPoint: 2162,
    thermalConductivity: 429,      // highest of all metals
    specificHeatCapacity: 235,
    debyeTemperature: 225,
    thermalExpansion: 18.9,
    emissivity: 0.02,             // polished Ag — lowest emissivity

    // Mechanical
    youngsModulus: 83,
    tensileStrength: 170,
    hardness: 2.5,
    poissonRatio: 0.37,

    // Electrical / Acoustic
    electricalConductivity: 6.30e7, // highest of all metals
    acousticEfficiency: 0.013,
    dampingLossTangent: 0.0008,

    // Liquid
    liquidViscosity: 3.88e-3,     // at mp — Iida & Guthrie
    liquidSurfaceTension: 0.903,

    // Andrade
    andradeA: 3.2e-4,
    andradeEa: 25300,

    // Norton (Ag creep — soft FCC noble metal)
    nortonA: 5.0e-8,
    nortonN: 5.0,
    nortonQ: 185000,              // self-diffusion Q

    // Avrami
    avramiK0: 1.0e7,
    avramiQ: 120000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 20,

    // Basquin
    basquinSigmaF: 140,
    basquinB: 0.09,

    // Fracture toughness
    fractureToughness: 50,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 42.55,
    activationEnergy: 80,

    // Optical
    refractiveIndex: 0.18,         // highly reflective in visible
    absorptionRGB: [1e5, 1e5, 1e5], // highest reflectivity of all metals

    // Electromagnetic
    standardElectrodePotential: 0.799,  // Ag+ + e- -> Ag
    magneticPermeability: 0.999974,     // diamagnetic
    triboelectricIndex: 0.15,
  },

  // ════════════════════════════════════════════════════════════════════════
  // Au — Gold
  // ════════════════════════════════════════════════════════════════════════
  Au: {
    // Atomic
    atomicNumber: 79,
    atomicMass: 196.967,
    atomicRadius: 144,
    electronegativity: 2.54,
    valence: 3,
    crystalStructure: 'FCC',

    // Thermal
    meltingPoint: 1064.18,
    boilingPoint: 2856,
    thermalConductivity: 318,
    specificHeatCapacity: 129,
    debyeTemperature: 170,
    thermalExpansion: 14.2,
    emissivity: 0.03,

    // Mechanical
    youngsModulus: 78,
    tensileStrength: 120,
    hardness: 2.5,
    poissonRatio: 0.44,

    // Electrical / Acoustic
    electricalConductivity: 4.52e7,
    acousticEfficiency: 0.010,
    dampingLossTangent: 0.001,

    // Liquid
    liquidViscosity: 5.38e-3,     // at mp — Iida & Guthrie
    liquidSurfaceTension: 1.140,

    // Andrade
    andradeA: 3.8e-4,
    andradeEa: 26000,

    // Norton (Au creep — soft FCC)
    nortonA: 1.0e-7,
    nortonN: 5.0,
    nortonQ: 176000,

    // Avrami
    avramiK0: 1.0e7,
    avramiQ: 130000,
    avramiN: 2.5,

    // Fleischer
    fleischerB: 15,

    // Basquin
    basquinSigmaF: 100,
    basquinB: 0.09,

    // Fracture toughness
    fractureToughness: 45,

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 47.40,
    activationEnergy: 120,         // Au is very noble — high barrier

    // Optical
    refractiveIndex: 0.47,
    absorptionRGB: [1e5, 3e5, 6e5], // gold color: absorbs blue, reflects red/yellow

    // Electromagnetic
    standardElectrodePotential: 1.498,  // Au3+ + 3e- -> Au
    magneticPermeability: 0.999972,     // diamagnetic
    triboelectricIndex: 0.2,
  },

  // ════════════════════════════════════════════════════════════════════════
  // W — Tungsten
  // ════════════════════════════════════════════════════════════════════════
  W: {
    // Atomic
    atomicNumber: 74,
    atomicMass: 183.84,
    atomicRadius: 139,
    electronegativity: 2.36,
    valence: 6,
    crystalStructure: 'BCC',

    // Thermal
    meltingPoint: 3422,            // highest of all metals
    boilingPoint: 5555,
    thermalConductivity: 173,
    specificHeatCapacity: 132,
    debyeTemperature: 400,
    thermalExpansion: 4.5,         // very low — refractory
    emissivity: 0.04,             // polished W

    // Mechanical
    youngsModulus: 411,            // highest of common metals
    tensileStrength: 1510,
    hardness: 7.5,
    poissonRatio: 0.28,

    // Electrical / Acoustic
    electricalConductivity: 1.89e7,
    acousticEfficiency: 0.015,
    dampingLossTangent: 0.0005,    // very low damping

    // Liquid
    liquidViscosity: 8.0e-3,      // at mp — very high mp
    liquidSurfaceTension: 2.500,   // extremely high surface tension

    // Andrade
    andradeA: 8.0e-4,
    andradeEa: 65000,

    // Norton (W creep — BCC refractory, extremely creep resistant)
    nortonA: 1.0e-20,             // Frost & Ashby
    nortonN: 4.0,
    nortonQ: 586000,              // very high — self-diffusion of W

    // Avrami
    avramiK0: 1.0e5,
    avramiQ: 400000,
    avramiN: 2.0,

    // Fleischer
    fleischerB: 120,               // W in other metals: very strong strengthener

    // Basquin
    basquinSigmaF: 1200,
    basquinB: 0.06,

    // Fracture toughness
    fractureToughness: 12,         // BCC refractory — brittle at RT

    // Thermochemical
    standardEnthalpy: 0,
    standardEntropy: 32.64,
    activationEnergy: 300,         // kJ/mol — WO3 formation

    // Optical
    refractiveIndex: 3.39,
    absorptionRGB: [3e5, 3.2e5, 3.5e5],  // steel-grey

    // Electromagnetic
    standardElectrodePotential: -0.090,
    magneticPermeability: 1.00008,
    triboelectricIndex: 0.05,
  },

}

// ── Lookup helper ──────────────────────────────────────────────────────────

const _elements = Object.keys(ELEMENT_TABLE)

export function getElementProps(symbol: string): ElementProperties | undefined {
  return ELEMENT_TABLE[symbol]
}

export function getAllElementSymbols(): string[] {
  return _elements
}

/** Lookup by atomic number (linear scan — 25 elements, negligible cost) */
export function getElementByZ(z: number): ElementProperties | undefined {
  for (const sym of _elements) {
    if (ELEMENT_TABLE[sym].atomicNumber === z) return ELEMENT_TABLE[sym]
  }
  return undefined
}
