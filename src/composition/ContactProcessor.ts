// ContactProcessor.ts — CPU-side processing of multi-material contacts
// Handles mixing, dissolving, and phase transitions

import { CompositionTable } from './CompositionTable'

export interface ContactResult {
  particleId: number
  newCompositionId: number
}

export class ContactProcessor {
  constructor(private table: CompositionTable) {}

  /**
   * Process contact pairs from GPU readback.
   * Returns list of particles whose composition_id should change.
   */
  processContacts(
    contacts: { a: number, b: number }[],
    compositionIds: Uint32Array,
  ): ContactResult[] {
    const results: ContactResult[] = []
    const processed = new Set<number>()  // avoid processing same particle twice

    for (const { a, b } of contacts) {
      if (processed.has(a) || processed.has(b)) continue

      const compIdA = compositionIds[a]
      const compIdB = compositionIds[b]

      if (compIdA === compIdB) continue  // same material, skip

      const compA = this.table.get(compIdA)
      const compB = this.table.get(compIdB)
      if (!compA || !compB) continue

      // Simple mixing: 50/50 blend for now
      // Future: use relative velocities for mixing ratio
      const blendedId = this.table.blend(compIdA, compIdB, 0.5)

      // Only change particle A (particle B stays for symmetry)
      results.push({ particleId: a, newCompositionId: blendedId })
      processed.add(a)
    }

    return results
  }
}
