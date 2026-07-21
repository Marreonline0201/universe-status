// CompositionTable.ts — Manages named compositions and their GPU-side property data
// Updated: integrates with physics-based PropertyCalculator and ContactProcessor

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
  elements: Partial<Record<ElementName, number>>  // raw element fractions
  composition: Composition
  props: DerivedProps
  temperature: number
}

export class CompositionTable {
  private compositions: NamedComposition[] = []
  private gpuData = new Float32Array(256 * 4)  // vec4 per composition for GPU simulation
  private colorData = new Float32Array(256 * 4) // vec4 per composition for SSFR rendering
  private blendCache = new Map<string, number>() // hash → composition ID

  /** Add a composition. Returns its ID.
   *  densityOverride: use this for molecular compounds where Vegard's law doesn't apply
   *  renderOverride: physically correct render properties that override PropertyCalculator values
   */
  add(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature = 20, densityOverride?: number, renderOverride?: RenderOverride, fluidOverride?: { viscosity?: number; surfaceTension?: number }): number {
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
    if (fluidOverride) {
      if (fluidOverride.viscosity !== undefined) props.viscosity = fluidOverride.viscosity
      if (fluidOverride.surfaceTension !== undefined) props.surfaceTension = fluidOverride.surfaceTension
    }
    const id = this.compositions.length

    this.compositions.push({ id, name, formula, elements: normalized, composition, props, temperature })

    // GPU simulation data: MLS-MPM grid-scale values
    const baseDensity = 4.0
    const densityRatio = props.density / 1000
    this.gpuData[id * 4 + 0] = baseDensity * Math.max(densityRatio, 0.1)
    this.gpuData[id * 4 + 1] = props.viscosity
    this.gpuData[id * 4 + 2] = props.surfaceTension
    this.gpuData[id * 4 + 3] = 4.0  // stiffness

    // Color data for SSFR rendering: [R, G, B, packed(metalness, F0, emissive, opacity)]
    this.colorData[id * 4 + 0] = props.color[0]
    this.colorData[id * 4 + 1] = props.color[1]
    this.colorData[id * 4 + 2] = props.color[2]
    // Pack rendering properties into w channel as follows:
    // w = metalness * 0.01 + F0 * 0.001 + emissive * 0.0001
    // (We'll use a separate uniform for these in the actual shader)
    this.colorData[id * 4 + 3] = props.opacityDensity

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

  /** Get by ID */
  getById(id: number): NamedComposition | undefined { return this.compositions[id] }
  get(id: number): NamedComposition | undefined { return this.compositions[id] }
  getAll(): NamedComposition[] { return [...this.compositions] }
  getGpuData(): Float32Array { return this.gpuData }
  get count(): number { return this.compositions.length }

  /** Get per-composition color data for SSFR shader binding */
  getColorData(): Float32Array { return this.colorData }

  /** Get full rendering properties for all compositions (for SSFR uniform buffer) */
  getRenderData(): Float32Array {
    // 8 floats per composition: [R, G, B, metalness, F0, emissive, IOR, opacity]
    const data = new Float32Array(256 * 8)
    for (const comp of this.compositions) {
      const base = comp.id * 8
      data[base + 0] = comp.props.color[0]
      data[base + 1] = comp.props.color[1]
      data[base + 2] = comp.props.color[2]
      data[base + 3] = comp.props.metalness
      data[base + 4] = comp.props.F0
      data[base + 5] = comp.props.emissive
      data[base + 6] = comp.props.IOR
      data[base + 7] = comp.props.opacityDensity
    }
    return data
  }

  /** Create a blended composition from two existing ones (ratio-based) */
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

  /** Mass-weighted blend for ContactProcessor */
  blendByMass(idA: number, idB: number, massA: number, massB: number): number {
    const ratio = massA / (massA + massB)
    return this.blend(idA, idB, ratio)
  }

  /** Add or find an existing blend by element composition */
  addOrFindBlend(name: string, elements: Partial<Record<ElementName, number>>, temperature: number): number {
    // Create a hash of the composition for fast lookup
    const hash = this.hashComposition(elements)
    const cached = this.blendCache.get(hash)
    if (cached !== undefined) return cached

    // Check existing compositions
    const existing = this.find(elements)
    if (existing !== null) {
      this.blendCache.set(hash, existing)
      return existing
    }

    // Create new composition
    const formula = Object.entries(elements)
      .filter(([, f]) => f > 0.01)
      .sort(([, a], [, b]) => b - a)
      .map(([el, f]) => `${el}${(f * 100).toFixed(0)}`)
      .join('')
    const id = this.add(name, formula, elements, temperature)
    this.blendCache.set(hash, id)
    return id
  }

  /** Hash composition for cache lookup */
  private hashComposition(elements: Partial<Record<ElementName, number>>): string {
    return Object.entries(elements)
      .filter(([, f]) => (f ?? 0) > 0.005)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([el, f]) => `${el}:${((f ?? 0) * 1000).toFixed(0)}`)
      .join('|')
  }

  /** Add common starting materials with physically correct render properties */
  addDefaults(): void {
    this.add('Water', 'H₂O', { H: 0.111, O: 0.889 }, 20, 1000,
      { color: [0.8, 0.9, 1.0], opacityDensity: 0.15, F0: 0.02, metalness: 0.0, emissive: 0.0, IOR: 1.333 })
    this.add('Salt', 'NaCl', { Na: 0.393, Cl: 0.607 }, 20, 2170,
      { color: [0.95, 0.95, 0.95], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 0.0, IOR: 1.544 })
    this.add('Iron', 'Fe', { Fe: 1.0 }, 20, 7874,
      { color: [0.55, 0.55, 0.55], opacityDensity: 8.0, F0: 0.56, metalness: 0.95, emissive: 0.0, IOR: 2.95 })
    this.add('Copper', 'Cu', { Cu: 1.0 }, 1100, 8960,
      { color: [0.85, 0.5, 0.2], opacityDensity: 6.0, F0: 0.6, metalness: 0.9, emissive: 1.2, IOR: 1.0 })
    // Using Pb as proxy (Hg not in element list)
    this.add('Mercury', 'Hg', { Pb: 1.0 }, 20, 13534,
      { color: [0.75, 0.75, 0.78], opacityDensity: 10.0, F0: 0.9, metalness: 0.98, emissive: 0.0, IOR: 1.0 },
      { viscosity: 0.00117, surfaceTension: 0.47 })
    this.add('Olive Oil', 'C₅₅H₁₀₄O₆', { C: 0.77, H: 0.12, O: 0.11 }, 20, 920,
      { color: [0.7, 0.65, 0.3], opacityDensity: 1.0, F0: 0.03, metalness: 0.0, emissive: 0.0, IOR: 1.473 })
    this.add('Lava', 'Basalt', { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }, 1200, 2700,
      { color: [0.9, 0.3, 0.05], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 1.5, IOR: 1.6 })
  }
}
