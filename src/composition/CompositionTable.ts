// CompositionTable.ts — Manages named compositions and their GPU-side property data

import { computeProperties, type Composition, type DerivedProps, type ElementName } from './PropertyCalculator'

/** Partial render property overrides — physically correct values per material */
export interface RenderOverride {
  color?: [number, number, number]
  opacityDensity?: number
  F0?: number
  metalness?: number
  emissive?: number
  IOR?: number
}

export interface NamedComposition {
  id: number
  name: string
  formula: string
  composition: Composition
  props: DerivedProps
  temperature: number
}

export class CompositionTable {
  private compositions: NamedComposition[] = []
  private gpuData = new Float32Array(256 * 4)  // vec4 per composition for GPU

  /** Add a composition. Returns its ID.
   *  densityOverride: use this for molecular compounds where Vegard's law doesn't apply
   *  (e.g., water = 1000 kg/m³, not the 1.28 kg/m³ that element interpolation gives)
   *  renderOverride: physically correct render properties that override PropertyCalculator values
   */
  add(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature = 20, densityOverride?: number, renderOverride?: RenderOverride): number {
    // Normalize fractions to sum to 1
    const total = Object.values(elements).reduce((s, v) => s + v, 0)
    const normalized: Partial<Record<ElementName, number>> = {}
    for (const [el, frac] of Object.entries(elements)) {
      normalized[el as ElementName] = frac / total
    }

    const composition: Composition = { elements: normalized }
    const props = computeProperties(composition, temperature)
    if (densityOverride !== undefined) {
      props.density = densityOverride
    }
    // Apply render overrides — physically correct values per material
    if (renderOverride) {
      if (renderOverride.color !== undefined) props.color = renderOverride.color
      if (renderOverride.opacityDensity !== undefined) props.opacityDensity = renderOverride.opacityDensity
      if (renderOverride.F0 !== undefined) props.F0 = renderOverride.F0
      if (renderOverride.metalness !== undefined) props.metalness = renderOverride.metalness
      if (renderOverride.emissive !== undefined) props.emissive = renderOverride.emissive
      if (renderOverride.IOR !== undefined) props.IOR = renderOverride.IOR
    }
    const id = this.compositions.length

    this.compositions.push({ id, name, formula, composition, props, temperature })

    // GPU data uses MLS-MPM grid-scale values, NOT real-world units.
    // rest_density=4.0 is the standard MLS-MPM value for fluid (from WebGPU-Ocean).
    // Density RATIO between materials is preserved for relative behavior.
    const baseDensity = 4.0  // grid-scale rest density
    const densityRatio = props.density / 1000  // normalize to water=1.0
    this.gpuData[id * 4 + 0] = baseDensity * Math.max(densityRatio, 0.1)
    this.gpuData[id * 4 + 1] = props.viscosity
    this.gpuData[id * 4 + 2] = props.surfaceTension
    this.gpuData[id * 4 + 3] = 4.0   // stiffness — matches WebGPU-Ocean reference value

    return id
  }

  /** Find composition by exact element match, or return null */
  find(elements: Partial<Record<ElementName, number>>): number | null {
    const total = Object.values(elements).reduce((s, v) => s + v, 0)
    for (const comp of this.compositions) {
      let match = true
      for (const [el, frac] of Object.entries(elements)) {
        const normalized = frac / total
        const existing = comp.composition.elements[el as ElementName] ?? 0
        if (Math.abs(existing - normalized) > 0.01) { match = false; break }
      }
      if (match) return comp.id
    }
    return null
  }

  get(id: number): NamedComposition | undefined { return this.compositions[id] }
  getAll(): NamedComposition[] { return [...this.compositions] }
  getGpuData(): Float32Array { return this.gpuData }
  get count(): number { return this.compositions.length }

  /** Create a blended composition from two existing ones */
  blend(idA: number, idB: number, ratioA: number): number {
    const compA = this.compositions[idA]
    const compB = this.compositions[idB]
    if (!compA || !compB) return idA

    const blended: Partial<Record<ElementName, number>> = {}
    const allElements = new Set([
      ...Object.keys(compA.composition.elements),
      ...Object.keys(compB.composition.elements),
    ]) as Set<ElementName>

    for (const el of allElements) {
      const fracA = compA.composition.elements[el] ?? 0
      const fracB = compB.composition.elements[el] ?? 0
      blended[el] = fracA * ratioA + fracB * (1 - ratioA)
    }

    // Check if this blend already exists
    const existing = this.find(blended)
    if (existing !== null) return existing

    const avgTemp = compA.temperature * ratioA + compB.temperature * (1 - ratioA)
    return this.add(
      `${compA.name}+${compB.name}`,
      `${compA.formula}/${compB.formula}`,
      blended,
      avgTemp,
    )
  }

  /** Add common starting materials with physically correct render properties */
  addDefaults(): void {
    // densityOverride is required for molecular compounds — Vegard's law only works for solid alloys
    // renderOverride provides physically correct optical properties per material
    this.add('Water', 'H₂O', { H: 0.111, O: 0.889 }, 20, 1000,
      { color: [0.8, 0.9, 1.0], opacityDensity: 0.15, F0: 0.02, metalness: 0.0, emissive: 0.0, IOR: 1.333 })
    this.add('Salt', 'NaCl', { Na: 0.393, Cl: 0.607 }, 20, 2170,
      { color: [0.95, 0.95, 0.95], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 0.0, IOR: 1.544 })
    this.add('Iron', 'Fe', { Fe: 1.0 }, 20, 7874,
      { color: [0.55, 0.55, 0.55], opacityDensity: 8.0, F0: 0.56, metalness: 0.95, emissive: 0.0, IOR: 2.95 })
    this.add('Copper', 'Cu', { Cu: 1.0 }, 1100, 8960,
      { color: [0.85, 0.5, 0.2], opacityDensity: 6.0, F0: 0.6, metalness: 0.9, emissive: 1.2, IOR: 1.0 })
    this.add('Mercury', 'Hg', { Pb: 1.0 }, 20, 13534,
      { color: [0.75, 0.75, 0.78], opacityDensity: 10.0, F0: 0.9, metalness: 0.98, emissive: 0.0, IOR: 1.0 })
    this.add('Olive Oil', 'C₅₅H₁₀₄O₆', { C: 0.77, H: 0.12, O: 0.11 }, 20, 920,
      { color: [0.7, 0.65, 0.3], opacityDensity: 1.0, F0: 0.03, metalness: 0.0, emissive: 0.0, IOR: 1.473 })
    this.add('Lava', 'Basalt', { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }, 1200, 2700,
      { color: [0.9, 0.3, 0.05], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 1.5, IOR: 1.6 })
  }
}
