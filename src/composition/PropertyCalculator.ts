// PropertyCalculator.ts — Compute material properties from element composition
// Implements structure.md §3.1 formulas (simplified subset for fluid test)

// 25 gameplay elements from docs/element-properties.md
export const ELEMENTS = [
  'H', 'C', 'N', 'O', 'Na', 'Mg', 'Al', 'Si', 'P', 'S',
  'Cl', 'K', 'Ca', 'Ti', 'Cr', 'Mn', 'Fe', 'Ni', 'Cu', 'Zn',
  'Sn', 'Pb', 'Ag', 'Au', 'W',
] as const

export type ElementName = typeof ELEMENTS[number]

// Base element properties (from docs/element-properties.md)
const ELEMENT_DATA: Record<ElementName, {
  density: number,       // kg/m³
  meltingPoint: number,  // °C
  boilingPoint: number,  // °C
  specificHeat: number,  // J/(kg·K)
  thermalCond: number,   // W/(m·K)
  color: [number, number, number],  // RGB 0-1
}> = {
  H:  { density: 0.089, meltingPoint: -259, boilingPoint: -253, specificHeat: 14300, thermalCond: 0.18, color: [0.9, 0.9, 1.0] },
  C:  { density: 2260, meltingPoint: 3550, boilingPoint: 4827, specificHeat: 710, thermalCond: 1.7, color: [0.2, 0.2, 0.2] },
  N:  { density: 1.25, meltingPoint: -210, boilingPoint: -196, specificHeat: 1040, thermalCond: 0.026, color: [0.9, 0.9, 1.0] },
  O:  { density: 1.43, meltingPoint: -218, boilingPoint: -183, specificHeat: 919, thermalCond: 0.027, color: [0.5, 0.7, 1.0] },
  Na: { density: 971, meltingPoint: 98, boilingPoint: 883, specificHeat: 1230, thermalCond: 140, color: [0.8, 0.8, 0.8] },
  Mg: { density: 1738, meltingPoint: 650, boilingPoint: 1091, specificHeat: 1020, thermalCond: 156, color: [0.7, 0.7, 0.7] },
  Al: { density: 2700, meltingPoint: 660, boilingPoint: 2519, specificHeat: 897, thermalCond: 237, color: [0.8, 0.8, 0.85] },
  Si: { density: 2330, meltingPoint: 1414, boilingPoint: 3265, specificHeat: 710, thermalCond: 149, color: [0.4, 0.4, 0.5] },
  P:  { density: 1820, meltingPoint: 44, boilingPoint: 280, specificHeat: 769, thermalCond: 0.236, color: [1.0, 1.0, 0.8] },
  S:  { density: 2070, meltingPoint: 115, boilingPoint: 445, specificHeat: 710, thermalCond: 0.205, color: [1.0, 1.0, 0.3] },
  Cl: { density: 3.21, meltingPoint: -101, boilingPoint: -34, specificHeat: 479, thermalCond: 0.009, color: [0.5, 1.0, 0.5] },
  K:  { density: 862, meltingPoint: 63, boilingPoint: 759, specificHeat: 757, thermalCond: 102, color: [0.8, 0.8, 0.8] },
  Ca: { density: 1550, meltingPoint: 842, boilingPoint: 1484, specificHeat: 631, thermalCond: 201, color: [0.9, 0.9, 0.9] },
  Ti: { density: 4506, meltingPoint: 1668, boilingPoint: 3287, specificHeat: 523, thermalCond: 22, color: [0.7, 0.7, 0.75] },
  Cr: { density: 7190, meltingPoint: 1907, boilingPoint: 2671, specificHeat: 449, thermalCond: 94, color: [0.75, 0.75, 0.8] },
  Mn: { density: 7440, meltingPoint: 1246, boilingPoint: 2061, specificHeat: 479, thermalCond: 7.8, color: [0.7, 0.7, 0.7] },
  Fe: { density: 7874, meltingPoint: 1538, boilingPoint: 2862, specificHeat: 449, thermalCond: 80, color: [0.6, 0.6, 0.6] },
  Ni: { density: 8908, meltingPoint: 1455, boilingPoint: 2913, specificHeat: 444, thermalCond: 91, color: [0.65, 0.65, 0.7] },
  Cu: { density: 8960, meltingPoint: 1085, boilingPoint: 2562, specificHeat: 385, thermalCond: 401, color: [0.85, 0.5, 0.2] },
  Zn: { density: 7134, meltingPoint: 420, boilingPoint: 907, specificHeat: 388, thermalCond: 116, color: [0.7, 0.7, 0.75] },
  Sn: { density: 7287, meltingPoint: 232, boilingPoint: 2602, specificHeat: 228, thermalCond: 67, color: [0.75, 0.75, 0.75] },
  Pb: { density: 11340, meltingPoint: 327, boilingPoint: 1749, specificHeat: 129, thermalCond: 35, color: [0.4, 0.4, 0.45] },
  Ag: { density: 10490, meltingPoint: 962, boilingPoint: 2162, specificHeat: 235, thermalCond: 429, color: [0.9, 0.9, 0.92] },
  Au: { density: 19300, meltingPoint: 1064, boilingPoint: 2856, specificHeat: 129, thermalCond: 318, color: [1.0, 0.84, 0.0] },
  W:  { density: 19250, meltingPoint: 3422, boilingPoint: 5555, specificHeat: 132, thermalCond: 173, color: [0.6, 0.6, 0.65] },
}

export interface Composition {
  elements: Partial<Record<ElementName, number>>  // mass fractions, sum to 1.0
}

export interface DerivedProps {
  density: number
  viscosity: number
  surfaceTension: number
  meltingPoint: number
  boilingPoint: number
  color: [number, number, number]
  thermalConductivity: number
  specificHeat: number
  // Rendering properties
  F0: number          // Fresnel at normal incidence
  metalness: number   // 0-1
  emissive: number    // glow intensity
  IOR: number         // index of refraction
  specularPower: number
  opacityDensity: number
}

/** Compute derived material properties from element composition */
export function computeProperties(comp: Composition, temperature: number = 20): DerivedProps {
  const elems = comp.elements
  const entries = Object.entries(elems) as [ElementName, number][]

  // Vegard's law: linear interpolation of component properties by mass fraction
  let density = 0, meltingPoint = 0, boilingPoint = 0, specificHeat = 0, thermalCond = 0
  const color: [number, number, number] = [0, 0, 0]

  for (const [el, frac] of entries) {
    const d = ELEMENT_DATA[el]
    density += d.density * frac
    meltingPoint += d.meltingPoint * frac
    boilingPoint += d.boilingPoint * frac
    specificHeat += d.specificHeat * frac
    thermalCond += d.thermalCond * frac
    color[0] += d.color[0] * frac
    color[1] += d.color[1] * frac
    color[2] += d.color[2] * frac
  }

  // Viscosity: Arrhenius approximation
  // Low density → gas-like (low viscosity), high density metal → low viscosity when molten
  // This is a simplified model; the real game uses Andrade equation
  const isMetallic = entries.some(([el]) => ['Fe', 'Cu', 'Au', 'Ag', 'Ni', 'Zn', 'Sn', 'Pb', 'W', 'Al', 'Ti', 'Cr', 'Mn'].includes(el))
    && entries.filter(([el]) => ['Fe', 'Cu', 'Au', 'Ag', 'Ni', 'Zn', 'Sn', 'Pb', 'W', 'Al', 'Ti', 'Cr', 'Mn'].includes(el))
      .reduce((sum, [, f]) => sum + f, 0) > 0.5

  let viscosity: number
  if (temperature > meltingPoint) {
    viscosity = isMetallic ? 0.004 : 0.001  // molten metal vs water-like
  } else {
    viscosity = 1e6  // solid — effectively infinite
  }

  // Surface tension: rough estimate from density
  const surfaceTension = isMetallic ? 1.0 + density * 0.00005 : 0.03 + density * 0.00003

  // Rendering: metals vs non-metals
  const metalFrac = entries
    .filter(([el]) => ['Fe', 'Cu', 'Au', 'Ag', 'Ni', 'Zn', 'Sn', 'Pb', 'W', 'Al', 'Ti', 'Cr', 'Mn', 'Mg', 'Na', 'K', 'Ca'].includes(el))
    .reduce((sum, [, f]) => sum + f, 0)

  const metalness = Math.min(1, metalFrac * 1.2)
  const F0 = metalness > 0.5 ? 0.5 + metalness * 0.4 : 0.02 + metalness * 0.1
  const IOR = metalness > 0.5 ? 1.0 : 1.33 + metalness * 0.2
  const emissive = temperature > meltingPoint && isMetallic ? 1.2 : (temperature > 500 ? 0.5 : 0.0)
  const specularPower = isMetallic ? 300 : 150
  const opacityDensity = 2.0 + density * 0.0005

  return {
    density, viscosity, surfaceTension, meltingPoint, boilingPoint,
    color, thermalConductivity: thermalCond, specificHeat,
    F0, metalness, emissive, IOR, specularPower, opacityDensity,
  }
}
