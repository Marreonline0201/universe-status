// CompositionTable.ts — Manages named compositions and their GPU-side property data
// Updated: integrates with physics-based PropertyCalculator and ContactProcessor
//
// S1.5 material data (fluid-realism plan FINAL-PLAN.md §4.2, §7 S1.5; owner decisions D6, D7, D13, 2026-09-28):
//   - Known liquids take ρ(T), μ(T) from cited laws in materialData.ts (water NIST/IAPWS, mercury Assael 2012, glycerol
//     Cheng 2008, ethanol Sotiriadou 2023, lava GRD 2008, olive oil / honey as flagged secondary data). For a cited
//     liquid, caller densityOverride / fluidOverride are IGNORED for the solver (flagged 'override-ignored:*').
//   - Every composition carries a phase-gate verdict (liquidGate.validateSpawn) and an MPM viscosity verdict
//     (liquidGate.validateMpmViscosity). Refused: iron and salt (solid at 20 °C; liquid data unsourced above their
//     melting points), every element-model composition except element-detected water (its liquid values are
//     unsourced — PropertyCalculator states why in unsourcedReason), anything above the derived MPM limit on the MPM
//     path (honey 14 %, both lavas, cold glycerol). Hidden: copper (liquid density unsourced, D7).
//   - getGpuData() viscosity slot (.y) carries the CONVERTED MPM code-unit coefficient mpmViscosityCode(μ, ρ)
//     = 4μτ/(ρdx²), which is what p2g2.wgsl multiplies (C + Cᵀ) by — NOT raw Pa·s. A composition that fails either
//     gate gets 0 in that slot: never the raw value (injection), never a clamped value (silent clamp), never NaN (it
//     would poison neighbouring grid nodes through the shared atomics). Callers MUST block spawns of refused ids
//     (checkSpawn / isSpawnable / getMenuEntries) and show the reason — a refused row spawned anyway runs inviscid.
//   - Capacity: the GPU buffers hold MAX_COMPOSITIONS rows (MpmGpuSimulator compPropsBuf 256 × vec4, SSFRPipeline
//     256 × 8 floats). Registrations beyond it are recorded but refused ('refused:capacity'), their rows never written.
//     Temperature queries (evaluateAt, getMenuEntries(method, tempC)) register nothing; spawnIdAt registers a new
//     temperature only when that spawn is accepted.
//   - Default ids 0–6 are unchanged (Water 0 … Lava 6); new liquids are appended from id 7.

import { computeProperties, detectMaterialKey, type Composition, type DerivedProps, type ElementName } from './PropertyCalculator'
import { LIQUIDS, SOLID_REFERENCE, isLiquidKey, isSolidRefKey, type LiquidKey, type SolidRefKey } from './materialData'
import {
  phaseAt, validateSpawn, validateMpmViscosity, validateScene, fmtC,
  incompressibleViscosityVerdict, type SolverProps, type PhaseProps, type GateResult, type MpmViscosityVerdict,
  type MenuEntry, type SceneMaterial, type SceneVerdict, type SpawnCheck,
} from './liquidGate'

/** Rows in the GPU composition buffers (MpmGpuSimulator compPropsBuf = 256 × vec4; SSFRPipeline = 256 × 8 floats). */
export const MAX_COMPOSITIONS = 256

/** Partial render property overrides — physically correct values per material */
export interface RenderOverride {
  color?: [number, number, number]
  opacityDensity?: number
  F0?: number
  metalness?: number
  emissive?: number
  IOR?: number
}

export type MaterialKey = LiquidKey | SolidRefKey
/** 'mpm' = legacy MLS-MPM path (explicit viscosity limit applies); 'incompressible' = plan S3 (implicit viscosity). */
export type SolverMethod = 'mpm' | 'incompressible'

export interface NamedComposition {
  id: number
  name: string
  formula: string
  elements: Partial<Record<ElementName, number>>  // raw element fractions
  composition: Composition
  props: DerivedProps
  temperature: number
  /** S1.5: cited-material key when the composition uses materialData laws, else null (element-model estimate). */
  materialKey: MaterialKey | null
  /** S1.5: solver-facing state at `temperature` (same object shape as getSolverProps). */
  solver: SolverProps
  /** S1.5: phase bounds used by the phase / pairwise thermal gates. */
  phase: PhaseProps
  /** S1.5: phase gate at `temperature` (also carries the capacity refusal). */
  spawn: GateResult
  /** S1.5: legacy-MPM viscosity gate at `temperature` (μ_code and refusal reason). */
  mpm: MpmViscosityVerdict
  /** S1.5: id of the base material this row was derived from by spawnIdAt (== id for a base material). */
  baseId: number
}

type FluidOverride = { viscosity?: number; surfaceTension?: number }

interface RegisterArgs {
  name: string
  formula: string
  elements: Partial<Record<ElementName, number>>
  temperature: number
  densityOverride?: number
  renderOverride?: RenderOverride
  fluidOverride?: FluidOverride
  materialKey?: MaterialKey | null
}

interface Evaluated {
  props: DerivedProps
  materialKey: MaterialKey | null
  solver: SolverProps
  phase: PhaseProps
  spawn: GateResult
  mpm: MpmViscosityVerdict
}

/** A temperature query that registers nothing (evaluateAt). */
export interface SpawnEvaluation {
  /** Gate verdict for spawning this material at tempC on the given method (phase, data range, ρ/μ known, MPM limit). */
  verdict: GateResult
  solver: SolverProps
  phase: PhaseProps
  /** MPM code-unit viscosity at tempC (NaN when ρ or μ is unknown). */
  muCode: number
}

function normalizeElements(elements: Partial<Record<ElementName, number>>): Partial<Record<ElementName, number>> {
  const total = Object.values(elements).reduce((s, v) => s + (v ?? 0), 0)
  const normalized: Partial<Record<ElementName, number>> = {}
  for (const [el, frac] of Object.entries(elements)) {
    normalized[el as ElementName] = (frac ?? 0) / total
  }
  return normalized
}

/** Evaluate every property and gate for a composition at temperature tC (pure; used by register and by *At queries). */
function evaluate(a: RegisterArgs, normalized: Partial<Record<ElementName, number>>, tC: number): Evaluated {
  const composition: Composition = { elements: normalized }
  const props = computeProperties(composition, tC)
  let flags: string[] = [...(props.flags ?? [])]
  const key: MaterialKey | null = a.materialKey ?? detectMaterialKey(normalized)
  let rho: number
  let mu: number
  let phase: PhaseProps

  if (isLiquidKey(key)) {
    const L = LIQUIDS[key]
    rho = L.density(tC)
    mu = L.viscosity(tC)
    props.density = rho
    props.viscosity = mu
    props.surfaceTension = L.surfaceTension(tC) ?? NaN
    props.meltingPoint = L.phase.freezeC ?? NaN
    props.boilingPoint = L.phase.boilC ?? NaN
    const cp = L.specificHeat(tC)
    if (cp !== null) props.specificHeat = cp
    props.unsourcedReason = null
    flags = [...L.flags]
    if (key === 'mercury') {
      // Hg is not in the 25-element table; the Pb proxy only supplies non-solver fields (latent heats, k, E …) [U].
      props.thermalConductivity = NaN
      flags.push('proxy:Pb-elements-for-non-solver-fields')
    }
    // A cited law wins over caller overrides of solver values (they are recorded, not applied).
    if (a.densityOverride !== undefined) flags.push(`override-ignored:density=${a.densityOverride}`)
    if (a.fluidOverride?.viscosity !== undefined) flags.push(`override-ignored:viscosity=${a.fluidOverride.viscosity}`)
    if (a.fluidOverride?.surfaceTension !== undefined) flags.push(`override-ignored:surface-tension=${a.fluidOverride.surfaceTension}`)
    phase = { name: a.name, freezeC: L.phase.freezeC, boilC: L.phase.boilC, dataRangeC: L.phase.dataRangeC }
  } else if (isSolidRefKey(key)) {
    const S = SOLID_REFERENCE[key]
    const solidNow = tC < S.freezeC
    flags.push(`reference:${key}`)
    props.meltingPoint = S.freezeC
    props.unsourcedReason = null
    mu = NaN // a solid has no viscosity; the liquid viscosity is unsourced
    if (solidNow) {
      // Display only: the legacy solid density (override) or the element-model value.
      rho = a.densityOverride ?? props.density
      if (a.densityOverride !== undefined) flags.push('override:density:solid-display-only')
    } else {
      // Never carry a solid density into the liquid state.
      rho = NaN
      flags.push('unverified:liquid-properties')
      if (a.densityOverride !== undefined) flags.push(`override-ignored:solid-density=${a.densityOverride}`)
    }
    props.density = rho
    props.viscosity = mu
    phase = {
      name: a.name, freezeC: S.freezeC, boilC: null, dataRangeC: null,
      hiddenReason: key === 'copper' ? S.liquidUnsourced : null,
      liquidUnsourcedReason: S.liquidUnsourced,
    }
  } else {
    // Element-model estimate (AI MaterialGenerator, scenario materials). Element-detected water never lands here
    // (detectMaterialKey → 'water'), so every composition here has a non-null unsourcedReason and is refused.
    rho = props.density
    mu = props.viscosity
    if (a.densityOverride !== undefined) {
      rho = a.densityOverride
      props.density = rho
      flags.push('override:density:caller-supplied')
    }
    if (a.fluidOverride?.viscosity !== undefined) {
      mu = a.fluidOverride.viscosity
      props.viscosity = mu
      flags.push('override:viscosity:caller-supplied')
    }
    if (a.fluidOverride?.surfaceTension !== undefined) {
      props.surfaceTension = a.fluidOverride.surfaceTension
      flags.push('override:surface-tension:caller-supplied')
    }
    flags.push('unverified:phase-bounds')
    phase = {
      name: a.name, freezeC: null, boilC: null, dataRangeC: null,
      unsourcedReason: props.unsourcedReason ?? 'no sourced liquid-state data for this element composition (element-model estimate)',
    }
  }

  // Apply render overrides — physically correct values per material
  const r = a.renderOverride
  if (r) {
    if (r.color !== undefined) props.color = r.color
    if (r.opacityDensity !== undefined) props.opacityDensity = r.opacityDensity
    if (r.F0 !== undefined) props.F0 = r.F0
    if (r.metalness !== undefined) props.metalness = r.metalness
    if (r.emissive !== undefined) props.emissive = r.emissive
    if (r.IOR !== undefined) props.IOR = r.IOR
  }

  const phaseAtSpawn = phaseAt(phase, tC)
  const spawn = validateSpawn(phase, tC)
  const mpm = validateMpmViscosity(mu, rho, undefined, undefined, undefined, a.name)
  if (phase.hiddenReason) flags.push('hidden')
  else if (phase.unsourcedReason) flags.push('refused:unsourced')
  else if (!spawn.ok) {
    flags.push(phaseAtSpawn !== 'liquid' ? `refused:phase:${phaseAtSpawn}` : phase.liquidUnsourcedReason ? 'refused:liquid-unsourced' : 'refused:data-range')
  }
  if (!mpm.ok) flags.push('refused:mpm-viscosity')
  props.flags = flags

  return {
    props, materialKey: key, phase, spawn, mpm,
    solver: { rhoKgM3: rho, muPaS: mu, phaseAtSpawn, flags: [...flags] },
  }
}

/** Method-specific verdict from an evaluation (shared by isSpawnable and evaluateAt). */
function verdictOf(name: string, tC: number, ev: Pick<Evaluated, 'spawn' | 'solver' | 'mpm'>, method: SolverMethod): GateResult {
  if (!ev.spawn.ok) return ev.spawn
  const s = ev.solver
  if (!Number.isFinite(s.rhoKgM3) || !Number.isFinite(s.muPaS)) {
    return { ok: false, reason: `${name}: no validated ${!Number.isFinite(s.rhoKgM3) ? 'density' : 'viscosity'} at ${fmtC(tC)} °C (${s.flags.filter(f => /^(unmodelled|solid|unverified|hidden)/.test(f)).join(', ') || 'unsourced'})` }
  }
  if (method === 'mpm' && !ev.mpm.ok) return { ok: false, reason: ev.mpm.reason }
  if (method === 'incompressible') {
    const v = incompressibleViscosityVerdict(s.muPaS, s.rhoKgM3, name)
    if (!v.ok) return { ok: false, reason: v.reason }
  }
  return { ok: true }
}

export class CompositionTable {
  private compositions: NamedComposition[] = []
  private args: { a: RegisterArgs; normalized: Partial<Record<ElementName, number>> }[] = []
  private gpuData = new Float32Array(MAX_COMPOSITIONS * 4)  // vec4 per composition for GPU simulation
  private colorData = new Float32Array(MAX_COMPOSITIONS * 4) // vec4 per composition for SSFR rendering
  private blendCache = new Map<string, number>() // hash → composition ID

  /** Add a composition. Returns its ID. (Signature unchanged; S1.5 gates are recorded on the entry, never thrown.)
   *  densityOverride: legacy solid density for reference solids (display only); caller-supplied value for element-model
   *                   compositions (flagged; those are refused anyway); ignored for cited liquids.
   *  renderOverride: physically correct render properties that override PropertyCalculator values
   *  fluidOverride: explicit μ/σ (flagged 'override:*'; still subject to the MPM limit; ignored for cited liquids)
   */
  add(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature = 20, densityOverride?: number, renderOverride?: RenderOverride, fluidOverride?: FluidOverride): number {
    return this.register({ name, formula, elements, temperature, densityOverride, renderOverride, fluidOverride })
  }

  /** Add a cited material from materialData (or a reference solid). Element fractions are only used for
   *  find()/blend(); the solver values come from the cited laws. */
  addMaterial(key: MaterialKey, opts: {
    name?: string; formula?: string; elements: Partial<Record<ElementName, number>>
    temperature?: number; densityOverride?: number; renderOverride?: RenderOverride
  }): number {
    const liquid = isLiquidKey(key) ? LIQUIDS[key] : null
    return this.register({
      name: opts.name ?? liquid?.label ?? key,
      formula: opts.formula ?? liquid?.formula ?? key,
      elements: opts.elements,
      temperature: opts.temperature ?? liquid?.defaultTempC ?? 20,
      densityOverride: opts.densityOverride,
      renderOverride: opts.renderOverride,
      materialKey: key,
    })
  }

  /** AI / user path: add, then report whether it may be spawned on `method` (the caller must not spawn on ok:false). */
  addChecked(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature = 20, method: SolverMethod = 'mpm'): { id: number; verdict: GateResult } {
    const id = this.add(name, formula, elements, temperature)
    return { id, verdict: this.isSpawnable(id, method) }
  }

  private register(a: RegisterArgs, baseId?: number): number {
    const normalized = normalizeElements(a.elements)
    const ev = evaluate(a, normalized, a.temperature)
    const id = this.compositions.length
    const { props } = ev
    const overCapacity = id >= MAX_COMPOSITIONS
    if (overCapacity) {
      ev.spawn = { ok: false, reason: `${a.name}: composition table full (${MAX_COMPOSITIONS} GPU rows); id ${id} has no GPU row and cannot be spawned` }
      ev.solver.flags.push('refused:capacity')
      props.flags = [...(props.flags ?? []), 'refused:capacity']
    }

    this.compositions.push({
      id, name: a.name, formula: a.formula, elements: normalized, composition: { elements: normalized }, props,
      temperature: a.temperature, materialKey: ev.materialKey, solver: ev.solver, phase: ev.phase, spawn: ev.spawn, mpm: ev.mpm,
      baseId: baseId ?? id,
    })
    this.args.push({ a, normalized })
    if (overCapacity) return id // never written: the GPU buffers have MAX_COMPOSITIONS rows

    // GPU simulation data (comp_props in p2g2.wgsl), vec4 per composition:
    //   .x = 4·ρ/1000 (REST_DENSITY × specific gravity) — uploaded but NOT read by p2g2.wgsl today (r4 §C.1-2);
    //        0 when ρ is unknown (no floor clamp)
    //   .y = μ_code = mpmViscosityCode(μ, ρ) = 4μτ/(ρdx²) — the code-unit coefficient p2g2 multiplies (C + Cᵀ) by;
    //        0 for any composition refused by the phase gate or the MPM viscosity gate (see file header)
    //   .z = σ (N/m) at spawn T — not read by any solver pass (display/validity only); 0 when unsourced
    //   .w = 4.0 legacy "stiffness" — not read (the shader constant STIFFNESS = 3.0 is used)
    const rho = ev.solver.rhoKgM3
    const spawnableOnMpm = verdictOf(a.name, a.temperature, ev, 'mpm').ok
    this.gpuData[id * 4 + 0] = Number.isFinite(rho) ? 4.0 * rho / 1000 : 0
    this.gpuData[id * 4 + 1] = spawnableOnMpm && ev.mpm.ok ? ev.mpm.muCode : 0
    this.gpuData[id * 4 + 2] = Number.isFinite(props.surfaceTension) ? props.surfaceTension : 0
    this.gpuData[id * 4 + 3] = 4.0  // stiffness (unused)

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

  /** Find a composition id by name (case-insensitive exact match, first registered wins), or null. */
  findByName(name: string): number | null {
    const n = name.trim().toLowerCase()
    const hit = this.compositions.find(c => c.name.toLowerCase() === n)
    return hit ? hit.id : null
  }

  /** Get by ID */
  getById(id: number): NamedComposition | undefined { return this.compositions[id] }
  get(id: number): NamedComposition | undefined { return this.compositions[id] }
  getAll(): NamedComposition[] { return [...this.compositions] }
  /** vec4 per composition; .y is the MPM code-unit viscosity (see register()). */
  getGpuData(): Float32Array { return this.gpuData }
  get count(): number { return this.compositions.length }

  // ── S1.5 solver / gate API ────────────────────────────────────────────────

  private need(id: number): NamedComposition {
    const c = this.compositions[id]
    if (!c) throw new RangeError(`CompositionTable: no composition with id ${id}`)
    return c
  }

  /** Solver-facing ρ (kg/m³), μ (Pa·s), phase and provenance flags at the composition's spawn temperature. */
  getSolverProps(id: number): SolverProps {
    const s = this.need(id).solver
    return { rhoKgM3: s.rhoKgM3, muPaS: s.muPaS, phaseAtSpawn: s.phaseAtSpawn, flags: [...s.flags] }
  }

  /** Same as getSolverProps but evaluated at another temperature (nothing is registered or uploaded). */
  getSolverPropsAt(id: number, tempC: number): SolverProps {
    return this.evaluateAt(id, tempC).solver
  }

  /** Phase bounds for liquidGate.validateSpawn / validateScene. */
  getPhaseProps(id: number): PhaseProps {
    const p = this.need(id).phase
    return { ...p }
  }

  /** Phase gate (liquidGate.validateSpawn) at tempC, default = the composition's own temperature. */
  validateSpawnById(id: number, tempC?: number): GateResult {
    const c = this.need(id)
    return validateSpawn(c.phase, tempC ?? c.temperature)
  }

  /** Pure temperature query: every gate for this material at tempC on `method`. Registers and uploads NOTHING
   *  (use it for the temperature slider and the menu). */
  evaluateAt(id: number, tempC: number, method: SolverMethod = 'mpm'): SpawnEvaluation {
    const c = this.need(id)
    const { a, normalized } = this.args[id]
    const ev = tempC === c.temperature ? c : evaluate(a, normalized, tempC)
    const verdict = tempC === c.temperature ? this.isSpawnable(id, method) : verdictOf(c.name, tempC, ev, method)
    return {
      verdict,
      solver: { ...ev.solver, flags: [...ev.solver.flags] },
      phase: { ...ev.phase },
      muCode: ev.mpm.muCode,
    }
  }

  /** Per-id spawn gate. ok only if particles of this id, spawned at tempC, would be simulated with validated
   *  properties:
   *   - a composition's ρ, μ (and its uploaded GPU row) are fixed at its registration temperature — the solver never
   *     reads the per-particle temperature (r4 §C.1-10) — so a different tempC is refused: use spawnIdAt(id, tempC);
   *   - phase gate (liquid, sourced liquid data, inside the sourced data range, not hidden) and capacity;
   *   - ρ and μ finite (any method);
   *   - 'mpm': the uploaded row was accepted by the derived explicit-viscosity limit (its slot is not the refused 0).
   *  It does NOT look at the other materials in the scene — use checkSpawn / checkScene for that. */
  isSpawnable(id: number, method: SolverMethod = 'mpm', tempC?: number): GateResult {
    const c = this.need(id)
    if (tempC !== undefined && tempC !== c.temperature) {
      return { ok: false, reason: `${c.name}: properties are fixed at ${fmtC(c.temperature)} °C (the solver ignores particle temperature); get an id for ${fmtC(tempC)} °C with spawnIdAt(id, ${fmtC(tempC)}) and spawn that id` }
    }
    return verdictOf(c.name, c.temperature, c, method)
  }

  /** Id to spawn this material at tempC. Evaluates first and registers a new row ONLY if that spawn would be accepted
   *  on `method` (and capacity remains); an existing row for the same base material and temperature is reused. */
  spawnIdAt(id: number, tempC: number, method: SolverMethod = 'mpm'): { ok: true; id: number } | { ok: false; reason: string } {
    const c = this.need(id)
    if (tempC === c.temperature) {
      const v = this.isSpawnable(id, method)
      return v.ok ? { ok: true, id } : v
    }
    const base = this.compositions[c.baseId]
    if (base.temperature === tempC) return this.spawnIdAt(base.id, tempC, method)
    const hit = this.compositions.find(x => x.baseId === base.id && x.temperature === tempC)
    if (hit) {
      const v = this.isSpawnable(hit.id, method)
      return v.ok ? { ok: true, id: hit.id } : v
    }
    const ev = this.evaluateAt(base.id, tempC, method)
    if (!ev.verdict.ok) return ev.verdict
    if (this.compositions.length >= MAX_COMPOSITIONS) {
      return { ok: false, reason: `${base.name}: composition table full (${MAX_COMPOSITIONS} GPU rows); cannot register ${fmtC(tempC)} °C` }
    }
    const { a } = this.args[base.id]
    const newId = this.register({ ...a, name: `${base.name} @ ${fmtC(tempC)} °C`, temperature: tempC }, base.id)
    const v = this.isSpawnable(newId, method)
    return v.ok ? { ok: true, id: newId } : v
  }

  /** Menu entry for one composition: 'hidden' (not listed, e.g. copper), 'refused' (listed, disabled, with reason) or
   *  'show'. Evaluated at tempC when given (nothing is registered), else at the composition's own temperature. */
  menuVisibility(id: number, method: SolverMethod = 'mpm', tempC?: number): MenuEntry {
    const c = this.need(id)
    const t = tempC ?? c.temperature
    const ev = this.evaluateAt(id, t, method)
    const flags = [...ev.solver.flags]
    const base = { id, name: c.name, flags, tempC: t, dataRangeC: ev.phase.dataRangeC ?? null, muCode: ev.muCode }
    if (ev.phase.hiddenReason) return { ...base, visibility: 'hidden', reason: ev.phase.hiddenReason }
    return ev.verdict.ok
      ? { ...base, visibility: 'show', reason: null }
      : { ...base, visibility: 'refused', reason: ev.verdict.reason }
  }

  /** Menu entries for every BASE material (rows created by spawnIdAt are not listed), evaluated at tempC when given —
   *  pass the slider temperature so the menu agrees with what a spawn would do. Filter out 'hidden' for the menu;
   *  a fixed-temperature preset reports its single-point dataRangeC so the UI can offer that temperature. */
  getMenuEntries(method: SolverMethod = 'mpm', tempC?: number): MenuEntry[] {
    return this.compositions.filter(c => c.baseId === c.id).map(c => this.menuVisibility(c.id, method, tempC))
  }

  /** SceneMaterial for liquidGate.validateScene (tempC default = the composition's own temperature). */
  sceneMaterial(id: number, tempC?: number): SceneMaterial {
    const c = this.need(id)
    return { name: c.name, tempC: tempC ?? c.temperature, freezeC: c.phase.freezeC, boilC: c.phase.boilC, dataRangeC: c.phase.dataRangeC ?? null }
  }

  /** Pairwise thermal gate over compositions that will share one scene. */
  validateSceneIds(entries: readonly { id: number; tempC?: number }[]): SceneVerdict {
    return validateScene(entries.map(e => this.sceneMaterial(e.id, e.tempC)))
  }

  /** THE one-call gate for a spawn into an existing scene: isSpawnable(id, method, tempC) AND the pairwise thermal gate
   *  against every material already in the scene (`scene`: the ids — and temperatures — currently present). */
  checkSpawn(id: number, opts: { method?: SolverMethod; tempC?: number; scene?: readonly { id: number; tempC?: number }[] } = {}): SpawnCheck {
    const v = this.isSpawnable(id, opts.method ?? 'mpm', opts.tempC)
    const others = (opts.scene ?? []).filter(e => e.id !== id)
    const sv = this.validateSceneIds([...others, { id, tempC: opts.tempC }])
    const reasons = [...(v.ok ? [] : [v.reason]), ...sv.refusals]
    const warnings = [...sv.warnings, ...this.methodWarnings([{ id, tempC: opts.tempC }], opts.method ?? 'mpm')]
    return reasons.length === 0 ? { ok: true, warnings } : { ok: false, reason: reasons.join('; '), warnings }
  }

  /** Method-specific warnings (not refusals) for spawnable entries: on the incompressible solver, materials whose
   *  viscosity is real but not simulated until S3.6 (liquidGate.incompressibleViscosityVerdict). */
  private methodWarnings(entries: readonly { id: number; tempC?: number }[], method: SolverMethod): string[] {
    if (method !== 'incompressible') return []
    const out: string[] = []
    for (const e of entries) {
      const c = this.need(e.id)
      const s = e.tempC === undefined || e.tempC === c.temperature ? c.solver : this.evaluateAt(e.id, e.tempC, method).solver
      const v = incompressibleViscosityVerdict(s.muPaS, s.rhoKgM3, c.name)
      if (v.ok && v.warning) out.push(v.warning)
    }
    return out
  }

  /** Gate a whole scene (e.g. a lab scenario's material set) BEFORE spawning any of it: every entry must pass
   *  isSpawnable and the set must pass the pairwise thermal gate. */
  checkScene(entries: readonly { id: number; tempC?: number }[], method: SolverMethod = 'mpm'): SpawnCheck {
    const reasons: string[] = []
    const seen = new Set<string>()
    const unique: { id: number; tempC?: number }[] = []
    for (const e of entries) {
      const k = `${e.id}@${e.tempC ?? ''}`
      if (seen.has(k)) continue
      seen.add(k)
      unique.push(e)
      const v = this.isSpawnable(e.id, method, e.tempC)
      if (!v.ok) reasons.push(v.reason)
    }
    const sv = this.validateSceneIds(unique)
    reasons.push(...sv.refusals)
    const warnings = [...sv.warnings, ...this.methodWarnings(unique, method)]
    return reasons.length === 0 ? { ok: true, warnings } : { ok: false, reason: reasons.join('; '), warnings }
  }

  /** Get per-composition color data for SSFR shader binding */
  getColorData(): Float32Array { return this.colorData }

  /** LEGACY look record per composition: [R, G, B, metalness, F0, emissive, IOR, opacity] (8 floats). NOT rendered
   *  since 2026-09-28 — the SSFR composite takes its optics from fluid-render/optics/materials.ts opticsRenderData()
   *  (measured spectra, exact Fresnel, cited IOR / complex index). Kept because the S1.5 materials gate (K1, Q3)
   *  asserts this API. */
  getRenderData(): Float32Array {
    const data = new Float32Array(MAX_COMPOSITIONS * 8)
    for (const comp of this.compositions) {
      if (comp.id >= MAX_COMPOSITIONS) break
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

  /** Add common starting materials with physically correct render properties.
   *  Ids 0–6 keep their historical order (scenarios, FluidTest waterId = 0 and the UI index by id). */
  addDefaults(): void {
    // 0 Water — NIST ρ(T), μ(T); IAPWS σ(T)
    this.addMaterial('water', { name: 'Water', formula: 'H₂O', elements: { H: 0.111, O: 0.889 }, temperature: 20,
      renderOverride: { color: [0.8, 0.9, 1.0], opacityDensity: 0.15, F0: 0.02, metalness: 0.0, emissive: 0.0, IOR: 1.333 } })
    // 1 Salt — solid at 20 °C → refused by the phase gate (D7). 2170 kg/m³ is the legacy solid density (display only).
    this.addMaterial('salt', { name: 'Salt', formula: 'NaCl', elements: { Na: 0.393, Cl: 0.607 }, temperature: 20, densityOverride: 2170,
      renderOverride: { color: [0.95, 0.95, 0.95], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 0.0, IOR: 1.544 } })
    // 2 Iron — solid at 20 °C → refused by the phase gate (D7). 7874 kg/m³ is the legacy solid density (display only).
    this.addMaterial('iron', { name: 'Iron', formula: 'Fe', elements: { Fe: 1.0 }, temperature: 20, densityOverride: 7874,
      renderOverride: { color: [0.55, 0.55, 0.55], opacityDensity: 8.0, F0: 0.56, metalness: 0.95, emissive: 0.0, IOR: 2.95 } })
    // 3 Copper at 1100 °C — liquid, but its liquid density is unsourced → hidden (D7).
    this.addMaterial('copper', { name: 'Copper', formula: 'Cu', elements: { Cu: 1.0 }, temperature: 1100,
      renderOverride: { color: [0.85, 0.5, 0.2], opacityDensity: 6.0, F0: 0.6, metalness: 0.9, emissive: 1.2, IOR: 1.0 } })
    // 4 Mercury — Assael 2012 μ(T) (D6: 1.567e-3 Pa·s at 20 °C, overriding 0.00117); Bettin 2004 ρ. Pb is only an
    //   element-table proxy (Hg is not among the 25 elements) for non-solver fields.
    this.addMaterial('mercury', { name: 'Mercury', formula: 'Hg', elements: { Pb: 1.0 }, temperature: 20,
      renderOverride: { color: [0.75, 0.75, 0.78], opacityDensity: 10.0, F0: 0.9, metalness: 0.98, emissive: 0.0, IOR: 1.0 } })
    // 5 Olive oil — secondary data (Wikipedia), 20 °C only.
    this.addMaterial('olive-oil', { name: 'Olive Oil', formula: 'C₅₅H₁₀₄O₆', elements: { C: 0.77, H: 0.12, O: 0.11 }, temperature: 20,
      renderOverride: { color: [0.7, 0.65, 0.3], opacityDensity: 1.0, F0: 0.03, metalness: 0.0, emissive: 0.0, IOR: 1.473 } })
    // 6 Lava — default preset "degassed basaltic melt (GRD)", 1200 °C: 192.7 Pa·s, ρ 2600 → μ_code 3.85, far above the
    //   derived MPM limit 0.156, so it is refused on the legacy MPM path (valid for the implicit-viscosity S3 solver).
    this.addMaterial('lava-grd-degassed', { name: 'Lava', formula: 'Basalt',
      elements: { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }, temperature: 1200,
      renderOverride: { color: [0.9, 0.3, 0.05], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 1.5, IOR: 1.6 } })

    // ── Appended in S1.5 (ids 7+). Element fractions are stoichiometric mass fractions (glycerol, ethanol) or an
    //    ESTIMATE (honey = hexose + water at the stated moisture); they are not used by the solver.
    //    IOR is left to the render track (not sourced here). ──
    // 7 Glycerol C3H8O3 (anhydrous), Cheng 2008 / Volk & Kähler 2018
    this.addMaterial('glycerol', { name: 'Glycerol', formula: 'C₃H₈O₃', elements: { C: 0.39127, H: 0.08756, O: 0.52117 }, temperature: 20,
      renderOverride: { color: [0.95, 0.95, 0.97], opacityDensity: 0.15, metalness: 0.0, emissive: 0.0 } })
    // 8 Ethanol C2H5OH, Sotiriadou 2023 / CoolProp ancillary
    this.addMaterial('ethanol', { name: 'Ethanol', formula: 'C₂H₅OH', elements: { C: 0.52144, H: 0.13128, O: 0.34728 }, temperature: 20,
      renderOverride: { color: [0.95, 0.97, 1.0], opacityDensity: 0.1, metalness: 0.0, emissive: 0.0 } })
    // 9, 10 Honey — secondary data, stated moisture presets at 25 °C (14 % water is refused on MPM: μ_code 1.46)
    this.addMaterial('honey-14pct-25C', { name: 'Honey (14% water)', formula: 'honey', elements: { C: 0.34402, H: 0.07341, O: 0.58257 }, temperature: 25,
      renderOverride: { color: [0.85, 0.55, 0.1], opacityDensity: 1.5, metalness: 0.0, emissive: 0.0 } })
    this.addMaterial('honey-20pct-25C', { name: 'Honey (20% water)', formula: 'honey', elements: { C: 0.32002, H: 0.07609, O: 0.60389 }, temperature: 25,
      renderOverride: { color: [0.9, 0.62, 0.15], opacityDensity: 1.2, metalness: 0.0, emissive: 0.0 } })
    // 11 Lava — secondary preset "Kīlauea 2018 bulk lava, 1150 °C": measured 116 Pa·s; ρ 1661 derived, pairing unverified.
    this.addMaterial('lava-kilauea-2018-bulk', { name: 'Lava (Kīlauea 2018 bulk)', formula: 'Basalt lava',
      elements: { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }, temperature: 1150,
      renderOverride: { color: [0.9, 0.3, 0.05], opacityDensity: 3.0, F0: 0.04, metalness: 0.0, emissive: 1.4, IOR: 1.6 } })
  }
}
