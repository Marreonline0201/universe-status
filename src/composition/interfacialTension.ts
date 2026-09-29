// Interfacial tension σ between liquid pairs (S3.5-i immiscible drift flux). Only measured, sourced pairs are listed; any
// pair not here is miscible or unsourced, and the solver never separates it by slip (the drift flux needs σ for Hinze's
// drop size). Sources: vault fluid/realism-2026-09/IMMISCIBILITY-spec.md §8.1.
import type { LiquidKey } from './materialData'

export interface InterfacialTension { a: LiquidKey; b: LiquidKey; sigmaNm: number; source: string }

export const INTERFACIAL_TENSIONS: readonly InterfacialTension[] = [
  {
    a: 'mercury', b: 'water', sigmaNm: 0.375,
    // five determinations within 1.5 % over 0–25 °C (370.1–375 mN/m at 20 °C): treated as temperature-flat
    source: 'Henry & Jackson 1938 (Nature 142:616): "about 375 dynes/cm, at 20° C"; NOAA CHRIS 9.9: 0.375 N/m at 20 °C',
  },
  {
    a: 'olive-oil', b: 'water', sigmaNm: 0.0245,
    // the abstract gives the triglyceride range, not olive oil by name, nor the temperature (disclosed in the spec)
    source: 'Fisher, Mitchell & Parker 1985 (J. Food Sci. 50:1201), pendant drop: triglyceride–water 23–26 mN/m',
  },
]

/** σ (N/m) of a liquid pair, or null: the same liquid, miscible, or not measured. */
export function interfacialTension(a: LiquidKey, b: LiquidKey): number | null {
  if (a === b) return null
  const hit = INTERFACIAL_TENSIONS.find(t => (t.a === a && t.b === b) || (t.a === b && t.b === a))
  return hit ? hit.sigmaNm : null
}
