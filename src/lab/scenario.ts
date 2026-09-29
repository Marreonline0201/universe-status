// Lab scenario format: agents author company/lab/<experiment>/scenario.json;
// the LAB page runs it in the in-browser WebGPU fluid sim. Pure data — no
// agent-written code ever executes.
//
// Gravity: `gravity_mps2` is the downward magnitude in m/s² (default: standard gravity).
// The legacy `gravity` field is in the old grid-space code units (0.3 ≙ Earth gravity by the
// 2026-07-17 units contract) and is converted on load — see scenarioGravityMs2().
import { ELEMENTS, type ElementName } from '../composition/PropertyCalculator'
import { CompositionTable, type RenderOverride } from '../composition/CompositionTable'
import { DOMAIN_L_M, DX_M, G_STANDARD, TAU_S } from '../fluid-engine/units'
import { MPM_PACKING, packingHi, type Packing } from '../fluid-engine/spawn'

/** Built-in material names (lower-case) a spawn may reference without a "materials" entry. */
const BUILT_IN_NAMES: ReadonlySet<string> = (() => {
  const t = new CompositionTable()
  t.addDefaults()
  return new Set(t.getAll().map(c => c.name.trim().toLowerCase()))
})()

export interface LabMaterial {
  name: string
  formula?: string
  elements: Record<string, number>
  temperature?: number
  densityOverride?: number
  renderOverride?: RenderOverride
}

/** A spawn is either a BOX in metres (preferred: filled at rest packing), or the legacy
 *  count + center (+ unused spread), which is converted to a block of the same particle count
 *  at rest packing centred on `center` (the old uniform scatter was ~1.4 particles/cell). */
export interface LabSpawn {
  material: string
  /** Region to fill, in metres from the tank's inner (0,0,0) corner (the walls), within
   *  within the running solver's tank on each axis: [0, 3.290 m] on the legacy MPM (3-cell band), [0, 3.63 m] on the
   *  incompressible solver (walls at the grid edge). */
  box?: { min: [number, number, number]; max: [number, number, number] }
  /** Initial velocity of the spawned particles, m/s. */
  initialVelocity?: [number, number, number]
  /** LEGACY: particle count of a block centred on `center` ([0,1]³ tank coordinates). */
  count?: number
  center?: [number, number, number]
  /** LEGACY: ignored — blocks are sized by count at rest packing. */
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

/** Largest gravity a scenario may set (m/s²) — the GRAVITY slider's range. */
export const MAX_GRAVITY_MPS2 = 20

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

/** Parse and validate a scenario for the solver whose packing is given (default: the legacy MPM — its tank is the
 *  smaller one, so a scenario valid there is valid on every solver): box bounds follow that solver's tank, and the
 *  particle count its rest spacing. */
export function parseScenario(text: string, opts: { packing?: Packing } = {}):
  | { ok: true; scenario: LabScenario; warning: string | null }
  | { ok: false; error: string } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) {
    return { ok: false, error: `scenario.json is not valid JSON: ${e instanceof Error ? e.message : e}` }
  }
  const s = raw as LabScenario
  if (s.materials === undefined) s.materials = []
  if (!Array.isArray(s.materials)) {
    return { ok: false, error: '"materials" must be an array (it may be empty when every spawn names a built-in material)' }
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
  // Gravity is live in the solver: reject anything that is not a finite, bounded magnitude.
  const gravityOk = (g: unknown) => typeof g === 'number' && Number.isFinite(g) && g >= 0
  if (s.gravity_mps2 !== undefined && (!gravityOk(s.gravity_mps2) || s.gravity_mps2 > MAX_GRAVITY_MPS2)) {
    return { ok: false, error: `gravity_mps2 must be a number in [0, ${MAX_GRAVITY_MPS2}] m/s² (got ${JSON.stringify(s.gravity_mps2)})` }
  }
  const warnings: string[] = []
  if (s.gravity !== undefined) {
    if (!gravityOk(s.gravity)) return { ok: false, error: `legacy "gravity" must be a non-negative number (got ${JSON.stringify(s.gravity)})` }
    if (s.gravity_mps2 === undefined) {
      const g = scenarioGravityMs2(s)
      if (g > MAX_GRAVITY_MPS2) return { ok: false, error: `legacy gravity ${s.gravity} converts to ${g.toFixed(2)} m/s², above ${MAX_GRAVITY_MPS2}` }
      warnings.push(`legacy "gravity": ${s.gravity} (grid units) converted to ${g.toFixed(4)} m/s² — write "gravity_mps2" instead`)
    }
  }
  const names = new Set(s.materials.map(m => m.name))
  const builtIns = BUILT_IN_NAMES
  let total = 0
  const isVec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(c => typeof c === 'number' && Number.isFinite(c))
  for (const sp of s.spawns) {
    if (typeof sp.material !== 'string' || !(names.has(sp.material) || builtIns.has(sp.material.trim().toLowerCase()))) {
      return { ok: false, error: `spawn references unknown material "${sp.material}" (not in "materials" and not a built-in material)` }
    }
    if (sp.initialVelocity !== undefined && !isVec3(sp.initialVelocity)) {
      return { ok: false, error: 'spawn initialVelocity must be [vx,vy,vz] in m/s' }
    }
    if (sp.box !== undefined) {
      const pk = opts.packing ?? MPM_PACKING, hi = packingHi(pk), tankInner = hi.map(h => (h - pk.tankMin) * DOMAIN_L_M)
      const inner = tankInner.map(v => +v.toFixed(4))
      if (!isVec3(sp.box.min) || !isVec3(sp.box.max) || sp.box.min.some((v, i) => v < 0 || v >= sp.box!.max[i] || sp.box!.max[i] > tankInner[i] + 1e-9)) {
        return { ok: false, error: `spawn box must be {min:[x,y,z], max:[x,y,z]} in metres from the tank's inner corner, 0 ≤ min < max ≤ [${inner.join(', ')}]` }
      }
      // Same count the lattice spawner will place: floor(size / spacing) per axis.
      total += sp.box.max.reduce((acc, v, i) => acc * Math.max(1, Math.floor((v - sp.box!.min[i]) / DOMAIN_L_M / pk.spacing + 1e-9)), 1)
      continue
    }
    if (typeof sp.count !== 'number' || sp.count < 1 || sp.count > MAX_PER_SPAWN) {
      return { ok: false, error: `spawn needs a "box" (metres) or a count 1..${MAX_PER_SPAWN} (got ${sp.count})` }
    }
    if (!isVec3(sp.center) || sp.center!.some(c => c < 0 || c > 1)) {
      return { ok: false, error: 'spawn center must be [x,y,z] with components in [0,1]' }
    }
    total += sp.count
  }
  if (total > MAX_TOTAL) warnings.push(`total spawn count ${total} exceeds ${MAX_TOTAL} — spawns will be truncated`)
  return { ok: true, scenario: s, warning: warnings.length ? warnings.join('; ') : null }
}

export function elementsAs(elements: Record<string, number>): Partial<Record<ElementName, number>> {
  return elements as Partial<Record<ElementName, number>>
}
