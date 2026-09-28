// Lab scenario format: agents author company/lab/<experiment>/scenario.json;
// the LAB page runs it in the in-browser WebGPU fluid sim. Pure data — no
// agent-written code ever executes.
//
// Gravity: `gravity_mps2` is the downward magnitude in m/s² (default: standard gravity).
// The legacy `gravity` field is in the old grid-space code units (0.3 ≙ Earth gravity by the
// 2026-07-17 units contract) and is converted on load — see scenarioGravityMs2().
import { ELEMENTS, type ElementName } from '../composition/PropertyCalculator'
import type { RenderOverride } from '../composition/CompositionTable'
import { DX_M, G_STANDARD, TAU_S } from '../fluid-engine/units'

export interface LabMaterial {
  name: string
  formula?: string
  elements: Record<string, number>
  temperature?: number
  densityOverride?: number
  renderOverride?: RenderOverride
}

export interface LabSpawn {
  material: string
  count: number
  center: [number, number, number]
  spread?: number
  temperature?: number
  phase?: 0 | 1 | 2
}

export interface LabScenario {
  name?: string
  materials: LabMaterial[]
  spawns: LabSpawn[]
  /** Downward gravity magnitude, m/s². Takes precedence over the legacy `gravity`. */
  gravity_mps2?: number
  /** LEGACY: gravity in grid-space code units (cells/τ²); 0.3 means standard gravity. */
  gravity?: number
  temperature?: number
  ball?: { center?: [number, number, number]; radius?: number }
}

/** A scenario's gravity in m/s². Legacy code-unit gravity converts through the units
 *  contract; the canonical legacy value 0.3 was defined as Earth gravity, so it maps to
 *  standard gravity exactly rather than to 0.3·dx/τ² (9.801 at L = 3.63 m). */
export function scenarioGravityMs2(s: Pick<LabScenario, 'gravity' | 'gravity_mps2'>): number {
  if (s.gravity_mps2 !== undefined) return s.gravity_mps2
  if (s.gravity === undefined || Math.abs(s.gravity - 0.3) < 1e-9) return G_STANDARD
  return s.gravity * DX_M / (TAU_S * TAU_S)
}

const MAX_PER_SPAWN = 100_000
const MAX_TOTAL = 200_000
const ELEMENT_SET = new Set<string>(ELEMENTS)

export function parseScenario(text: string):
  | { ok: true; scenario: LabScenario; warning: string | null }
  | { ok: false; error: string } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) {
    return { ok: false, error: `scenario.json is not valid JSON: ${e instanceof Error ? e.message : e}` }
  }
  const s = raw as LabScenario
  if (!Array.isArray(s.materials) || s.materials.length === 0) {
    return { ok: false, error: 'scenario needs a non-empty "materials" array' }
  }
  for (const m of s.materials) {
    if (!m.name || typeof m.name !== 'string') return { ok: false, error: 'every material needs a "name"' }
    if (!m.elements || typeof m.elements !== 'object' || Object.keys(m.elements).length === 0) {
      return { ok: false, error: `material "${m.name}" needs an "elements" map (symbol → fraction)` }
    }
    const unknown = Object.keys(m.elements).filter(el => !ELEMENT_SET.has(el))
    if (unknown.length) {
      return { ok: false, error: `material "${m.name}" uses unknown element(s): ${unknown.join(', ')} — allowed: ${ELEMENTS.join(', ')}` }
    }
    if (Object.values(m.elements).some(v => typeof v !== 'number' || v <= 0)) {
      return { ok: false, error: `material "${m.name}" has non-positive element fractions` }
    }
  }
  if (!Array.isArray(s.spawns) || s.spawns.length === 0) {
    return { ok: false, error: 'scenario needs a non-empty "spawns" array' }
  }
  const names = new Set(s.materials.map(m => m.name))
  let total = 0
  for (const sp of s.spawns) {
    if (!names.has(sp.material)) return { ok: false, error: `spawn references unknown material "${sp.material}"` }
    if (typeof sp.count !== 'number' || sp.count < 1 || sp.count > MAX_PER_SPAWN) {
      return { ok: false, error: `spawn count must be 1..${MAX_PER_SPAWN} (got ${sp.count})` }
    }
    if (!Array.isArray(sp.center) || sp.center.length !== 3 || sp.center.some(c => typeof c !== 'number' || c < 0 || c > 1)) {
      return { ok: false, error: 'spawn center must be [x,y,z] with components in [0,1]' }
    }
    if (sp.spread !== undefined && (typeof sp.spread !== 'number' || sp.spread <= 0 || sp.spread > 0.5)) {
      return { ok: false, error: 'spawn spread must be in (0, 0.5]' }
    }
    total += sp.count
  }
  let warning: string | null = null
  if (total > MAX_TOTAL) warning = `total spawn count ${total} exceeds ${MAX_TOTAL} — spawns will be truncated`
  return { ok: true, scenario: s, warning }
}

export function elementsAs(elements: Record<string, number>): Partial<Record<ElementName, number>> {
  return elements as Partial<Record<ElementName, number>>
}
