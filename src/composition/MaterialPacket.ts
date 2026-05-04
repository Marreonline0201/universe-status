// ── MaterialPacket ──────────────────────────────────────────────────────────
//
// The fundamental unit of matter in the simulation.
// A MaterialPacket is NOT a named material — it is a chunk of matter with a
// composition, mass, temperature, and phase. ALL properties are DERIVED from
// composition using the PropertyCalculator. Nothing is hardcoded per material.
//
// See structure.md §3.1 for the full specification.
// ────────────────────────────────────────────────────────────────────────────

export type Phase = 'solid' | 'liquid' | 'gas' | 'plasma'

/**
 * Composition: element symbol → mass fraction (sums to 1.0).
 * Example: bronze = { Cu: 0.88, Sn: 0.12 }
 */
export type Composition = Record<string, number>

/**
 * All 51 derived properties computed by the PropertyCalculator.
 * Every value here is CALCULATED from composition — never stored manually.
 */
export interface DerivedProperties {
  // ── Phase transition ──────────────────────────────────────────────────
  meltingPoint: number              // °C — CALPHAD weighted avg + eutectic corrections
  boilingPoint: number              // °C — Clausius-Clapeyron from vapor pressure
  latentHeatFusion: number          // J/kg — energy to melt (no temp change)
  latentHeatVaporization: number    // J/kg — energy to boil (no temp change)

  // ── Mechanical ────────────────────────────────────────────────────────
  density: number                   // kg/m³ — Vegard's law + packing corrections
  hardness: number                  // Mohs — Fleischer/Labusch solid solution strengthening
  tensileStrength: number           // Pa — empirical from hardness + crystal correction
  compressiveStrength: number       // Pa — ~10× tensile for stone, ~1× for metals
  shearStrength: number             // Pa — ~0.6× tensile (metals), ~0.15× compressive (stone)
  youngsModulus: number             // Pa — bonding energy × packing density
  frictionCoefficient: number       // dimensionless — surface roughness from crystal + hardness
  poissonRatio: number              // dimensionless — ν ≈ 0.5 - E/(6K)
  fractureToughness: number         // MPa·√m — K_IC from bond strength + crystal
  ductility: number                 // 0-1 — crystal structure + bond type

  // ── Thermal ───────────────────────────────────────────────────────────
  thermalConductivity: number       // W/(m·K) — Wiedemann-Franz (metals), phonon (non-metals)
  specificHeatCapacity: number      // J/(kg·K) — Dulong-Petit + Debye correction
  thermalExpansion: number          // 1/K — Grüneisen parameter
  emissivity: number                // 0-1 — Kirchhoff's law
  ignitionTemperature: number       // °C — bond dissociation (organic only, Infinity for metals)
  combustionEnergy: number          // J/kg — Hess's law (0 for non-combustibles)
  flammability: number              // 0-1 — ignition temp × surface area × moisture

  // ── Electrical ────────────────────────────────────────────────────────
  electricalConductivity: number    // S/m — Matthiessen's rule

  // ── Fluid (liquid/gas only) ───────────────────────────────────────────
  viscosity: number                 // Pa·s — Andrade/Arrhenius: μ = A·e^(Ea/RT)
  surfaceTension: number            // N/m — Eötvös rule

  // ── Non-Newtonian ─────────────────────────────────────────────────────
  isNonNewtonian: boolean
  zeroShearViscosity: number        // Pa·s — μ₀ (at rest)
  infShearViscosity: number         // Pa·s — μ_∞ (fast shear)
  crossTimeConstant: number         // s — Cross model K
  crossFlowIndex: number            // dimensionless — Cross model n

  // ── Acoustic ──────────────────────────────────────────────────────────
  acousticEfficiency: number        // dimensionless — impact energy → sound fraction
  dampingLossTangent: number        // dimensionless — vibration decay Q = 1/(2×tan)

  // ── Chemical ──────────────────────────────────────────────────────────
  standardEnthalpy: number          // J/mol — ΔH_f° (formation enthalpy)
  standardEntropy: number           // J/(mol·K) — S° (formation entropy)
  activationEnergy: number          // J/mol — Ea for reactions

  // ── Environmental ─────────────────────────────────────────────────────
  porosity: number                  // 0-1 — packing efficiency from crystal + grain
  waterAbsorption: number           // 0-1 — porosity × surface wettability

  // ── Optical ───────────────────────────────────────────────────────────
  refractiveIndex: number           // dimensionless — Lorentz-Lorenz
  absorptionRGB: [number, number, number]   // 1/m per channel — Beer-Lambert
  scatteringRGB: [number, number, number]   // 1/m per channel — subsurface
  color: [number, number, number]           // RGB 0-1 — Drude (metals), absorption (non-metals)
  crystalStructure: string          // FCC, BCC, HCP, amorphous — Hume-Rothery
  opacity: number                   // 0-1 — band gap absorption
  reflectivity: number              // 0-1 — Fresnel from refractive index

  // ── Biological ────────────────────────────────────────────────────────
  calorieContent: number            // kcal/kg — combustion energy × digestibility (0 for inorganic)
  nutrientContent: { N: number; P: number; K: number }  // fertilizer value

  // ── Electromagnetic ───────────────────────────────────────────────────
  standardElectrodePotential: number  // V — battery voltage calculation
  magneticPermeability: number        // relative μ_r
  permanentMagnetization: [number, number, number]  // Tesla vec3
  triboelectricIndex: number          // -1 to +1

  // ── Contact angle (derived from surface energy) ───────────────────────
  hydrophilicity: number            // 0-1 — surface wetting affinity
}

/**
 * MaterialPacket — the fundamental unit of matter.
 *
 * Everything in the world IS a packet or a collection of packets.
 * A copper ingot, a puddle of water, a chunk of granite, a piece of wood —
 * all are packets with different compositions.
 */
export interface MaterialPacket {
  // ── Identity: what is this made of? ───────────────────────────────────
  composition: Composition          // element → mass fraction (sums to 1.0)

  // ── Physical state ────────────────────────────────────────────────────
  mass: number                      // kg
  temperature: number               // °C
  phase: Phase
  pressure: number                  // Pa (default: 101325 = 1 atm)

  // ── Phase transition tracking ─────────────────────────────────────────
  phaseProgress: number             // 0-1 — progress through current phase transition
  targetPhase: Phase | null         // null if not transitioning

  // ── Mechanical state ──────────────────────────────────────────────────
  workHardeningState: number        // 0-1 — accumulated plastic strain (Hollomon)
  fatigueAccumulation: number       // 0-1 — accumulated fatigue damage (Basquin)
  crackLength: number               // m — accumulated from fatigue, freeze-thaw, impacts

  // ── Position (for world placement) ────────────────────────────────────
  x: number
  y: number
  z: number
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new MaterialPacket with sensible defaults.
 */
export function createPacket(
  composition: Composition,
  mass: number,
  temperature = 25,
  phase: Phase = 'solid',
): MaterialPacket {
  return {
    composition,
    mass,
    temperature,
    phase,
    pressure: 101325,
    phaseProgress: 0,
    targetPhase: null,
    workHardeningState: 0,
    fatigueAccumulation: 0,
    crackLength: 0,
    x: 0,
    y: 0,
    z: 0,
  }
}

/**
 * Normalize composition so mass fractions sum to 1.0.
 */
export function normalizeComposition(comp: Composition): Composition {
  const total = Object.values(comp).reduce((a, b) => a + b, 0)
  if (total === 0) return comp
  const result: Composition = {}
  for (const [el, frac] of Object.entries(comp)) {
    result[el] = frac / total
  }
  return result
}

/**
 * Blend two compositions by mass (the compounding rule: §3.1).
 * Two packets in contact as liquids merge by mass-weighted composition averaging.
 */
export function blendCompositions(
  compA: Composition,
  massA: number,
  compB: Composition,
  massB: number,
): Composition {
  const totalMass = massA + massB
  if (totalMass === 0) return {}
  const result: Composition = {}

  // Collect all elements from both
  const allElements = new Set([...Object.keys(compA), ...Object.keys(compB)])
  for (const el of allElements) {
    const fracA = compA[el] ?? 0
    const fracB = compB[el] ?? 0
    result[el] = (fracA * massA + fracB * massB) / totalMass
  }
  return result
}

/**
 * Split a packet into two with the same composition but divided mass.
 */
export function splitPacket(
  packet: MaterialPacket,
  fraction: number,
): [MaterialPacket, MaterialPacket] {
  const massA = packet.mass * fraction
  const massB = packet.mass * (1 - fraction)
  return [
    { ...packet, mass: massA },
    { ...packet, mass: massB },
  ]
}
