// ContactProcessor.ts — CPU-side material contact processing
// Handles physics-based material mixing from GPU contact pairs
// structure.md §3.1 "Compounding Rule"
//
// The GPU returns pairs of particles that are in contact
// (different composition_id, within contact distance). This processor
// determines whether and how they should mix.

import { CompositionTable, type NamedComposition } from './CompositionTable'
import { ELEMENT_DATA, type ElementName, computeProperties } from './PropertyCalculator'

export interface ContactPair {
  a: number  // particle index A
  b: number  // particle index B
}

export interface MixResult {
  newCompositionId: number
  shouldMix: boolean
  reason: string
}

export class ContactProcessor {
  private compositionTable: CompositionTable

  constructor(compositionTable: CompositionTable) {
    this.compositionTable = compositionTable
  }

  /**
   * Process a batch of contact pairs from GPU readback.
   * Returns new composition IDs for particles that should change.
   */
  processContacts(
    contacts: ContactPair[],
    compositionIds: Uint32Array | number[],
    temperatures: Float32Array | number[],
  ): Map<number, MixResult> {
    const results = new Map<number, MixResult>()
    const processed = new Set<string>()

    for (const { a, b } of contacts) {
      const compA = compositionIds[a]
      const compB = compositionIds[b]

      // Skip same-material contacts
      if (compA === compB) continue

      // De-duplicate: only process each comp pair once per frame
      const pairKey = compA < compB ? `${compA}_${compB}` : `${compB}_${compA}`
      if (processed.has(pairKey)) continue
      processed.add(pairKey)

      const matA = this.compositionTable.getById(compA)
      const matB = this.compositionTable.getById(compB)
      if (!matA || !matB) continue

      const tempA = temperatures[a]
      const tempB = temperatures[b]
      const avgTemp = (tempA + tempB) / 2

      // Check if mixing is allowed
      const mixCheck = this.checkMiscibility(matA, matB, avgTemp)
      if (!mixCheck.miscible) {
        results.set(a, { newCompositionId: compA, shouldMix: false, reason: mixCheck.reason })
        continue
      }

      // Perform mass-weighted composition blend
      // §3.1: result_fraction[el] = (frac_A × mass_A + frac_B × mass_B) / (mass_A + mass_B)
      // For equal-size particles, mass ∝ density
      const propsA = computeProperties({ elements: matA.elements }, tempA)
      const propsB = computeProperties({ elements: matB.elements }, tempB)
      const massA = propsA.density
      const massB = propsB.density
      const totalMass = massA + massB

      const blendedElements: Partial<Record<ElementName, number>> = {}
      const allElements = new Set<ElementName>([
        ...Object.keys(matA.elements) as ElementName[],
        ...Object.keys(matB.elements) as ElementName[],
      ])

      for (const el of allElements) {
        const fracA = matA.elements[el] ?? 0
        const fracB = matB.elements[el] ?? 0
        const blended = (fracA * massA + fracB * massB) / totalMass
        if (blended > 0.001) { // Filter out trace amounts
          blendedElements[el] = blended
        }
      }

      // Normalize to ensure sum = 1.0
      const total = Object.values(blendedElements).reduce((s, v) => s + (v ?? 0), 0)
      if (total > 0) {
        for (const el of Object.keys(blendedElements) as ElementName[]) {
          blendedElements[el]! /= total
        }
      }

      // Check if this blend already exists in the table
      const newId = this.compositionTable.addOrFindBlend(
        `${matA.name}+${matB.name}`,
        blendedElements,
        avgTemp,
      )

      results.set(a, { newCompositionId: newId, shouldMix: true, reason: 'mixed' })
      results.set(b, { newCompositionId: newId, shouldMix: true, reason: 'mixed' })
    }

    return results
  }

  /**
   * Check if two materials can mix based on physical rules.
   * §3.1: miscibility depends on phase, composition, temperature.
   */
  private checkMiscibility(
    matA: NamedComposition,
    matB: NamedComposition,
    temperature: number,
  ): { miscible: boolean; reason: string } {
    const propsA = computeProperties({ elements: matA.elements }, temperature)
    const propsB = computeProperties({ elements: matB.elements }, temperature)

    // Determine metal/non-metal/water/oil nature
    const isMetalA = this.isMetallic(matA.elements)
    const isMetalB = this.isMetallic(matB.elements)
    const isWaterA = this.isWater(matA.elements)
    const isWaterB = this.isWater(matB.elements)
    const isOilA = this.isOil(matA.elements)
    const isOilB = this.isOil(matB.elements)

    // ── Rule 1: Oil and water don't mix ─────────────────────────────────
    if ((isOilA && isWaterB) || (isOilB && isWaterA)) {
      return { miscible: false, reason: 'immiscible: oil/water' }
    }

    // ── Rule 2: Two metals mix only when BOTH are liquid ────────────────
    if (isMetalA && isMetalB) {
      if (temperature < propsA.meltingPoint || temperature < propsB.meltingPoint) {
        return { miscible: false, reason: 'solid metal: needs both to be liquid' }
      }
      return { miscible: true, reason: 'molten metals mix freely' }
    }

    // ── Rule 3: Metal + non-metal → potential reaction (flag) ───────────
    if ((isMetalA && !isMetalB && !isWaterB) || (isMetalB && !isMetalA && !isWaterA)) {
      // Check for oxide formation potential
      const hasOxygen = (matA.elements.O ?? 0) > 0.1 || (matB.elements.O ?? 0) > 0.1
      if (hasOxygen && temperature > 200) {
        return { miscible: false, reason: 'potential oxidation reaction (→reaction engine)' }
      }
    }

    // ── Rule 4: Solid doesn't dissolve into liquid unless hot enough ────
    if (temperature < propsA.meltingPoint && temperature > propsB.meltingPoint) {
      // A is solid, B is liquid — slow dissolving only if specific pairs
      const isSaltInWater = this.isSalt(matA.elements) && isWaterB
      if (isSaltInWater) {
        // Dissolving rate increases with temperature
        const rate = Math.min(1, temperature / 100) // 0 at 0°C, 1 at 100°C
        if (rate < 0.1) {
          return { miscible: false, reason: 'too cold to dissolve' }
        }
        return { miscible: true, reason: `salt dissolving (rate: ${(rate * 100).toFixed(0)}%)` }
      }
      return { miscible: false, reason: 'solid in liquid: no dissolution path' }
    }

    // ── Rule 5: Both liquid → generally miscible ────────────────────────
    if (temperature > propsA.meltingPoint && temperature > propsB.meltingPoint) {
      return { miscible: true, reason: 'both liquid' }
    }

    // ── Rule 6: Both solid → no mixing ──────────────────────────────────
    if (temperature < propsA.meltingPoint && temperature < propsB.meltingPoint) {
      return { miscible: false, reason: 'both solid' }
    }

    return { miscible: true, reason: 'default: allow' }
  }

  // ── Material nature detection ─────────────────────────────────────────────

  private isMetallic(elements: Partial<Record<ElementName, number>>): boolean {
    let metalFrac = 0
    for (const [el, frac] of Object.entries(elements) as [ElementName, number][]) {
      if (ELEMENT_DATA[el]?.isMetal) metalFrac += frac
    }
    return metalFrac > 0.5
  }

  private isWater(elements: Partial<Record<ElementName, number>>): boolean {
    const h = elements.H ?? 0
    const o = elements.O ?? 0
    return h > 0.05 && o > 0.7 && h + o > 0.9
  }

  private isOil(elements: Partial<Record<ElementName, number>>): boolean {
    const c = elements.C ?? 0
    const h = elements.H ?? 0
    return c > 0.6 && h > 0.05 && c + h > 0.8
  }

  private isSalt(elements: Partial<Record<ElementName, number>>): boolean {
    const na = elements.Na ?? 0
    const cl = elements.Cl ?? 0
    return na > 0.25 && cl > 0.4
  }
}
