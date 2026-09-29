// liquidGate.ts — phase gate, pairwise thermal gate and MPM viscosity conversion/limit (pure functions, no GPU).
//
// Stage S1.5 of the fluid-realism plan (FINAL-PLAN.md §4.2 "Material rules", §7 S1.5, critic B-physics M6):
//   - Phase gate: a material must be a liquid, with SOURCED liquid-state data, inside its validated data range, at its
//     spawn temperature.
//   - Pairwise thermal gate: the sim is isothermal (no heat transfer), so a scene in which one material's temperature
//     lies across another material's phase-change temperature (e.g. 1150 °C lava with 20 °C water) is REFUSED;
//     any temperature difference is WARNED (the exchange of heat that would really happen is not modelled).
//   - MPM path only: SI viscosity → MLS-MPM code units, and an explicit-stability refusal limit DERIVED from the
//     kernels (see MPM_MU_CODE_LIMIT). No silent clamp.

import { TAU_S, DX_M, MPM_SUBSTEP_S } from '../fluid-engine/units'
import { REST_PPC } from '../fluid-engine/spawn'

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type Phase = 'liquid' | 'solid' | 'gas'

/** The solver-facing material state at the composition's spawn temperature (CompositionTable.getSolverProps). */
export interface SolverProps {
  rhoKgM3: number
  muPaS: number
  phaseAtSpawn: Phase
  flags: string[]
}

/** What the phase gate needs to know about a material. */
export interface PhaseProps {
  name: string
  /** 1-atm solid→liquid temperature (°C); null = unsourced (not checked, warned in scenes). */
  freezeC: number | null
  /** 1-atm liquid→gas temperature (°C); null = unsourced. */
  boilC: number | null
  /** Validated property range (°C). null/undefined = no range beyond the phase bounds. */
  dataRangeC?: readonly [number, number] | null
  /** Non-null = the material is withheld from the liquid menu for this reason (e.g. copper, D7). */
  hiddenReason?: string | null
  /** Non-null = no sourced liquid-state data at ANY temperature (element-model estimates, [U] legacy branches). */
  unsourcedReason?: string | null
  /** Non-null = a sourced reference SOLID whose liquid state is not sourced: refused whenever it would be liquid. */
  liquidUnsourcedReason?: string | null
}

export type GateResult = { ok: true } | { ok: false; reason: string }

/** Temperature for messages: up to 6 significant digits, never rounded across a bound (0.005 °C prints as 0.005). */
export const fmtC = (t: number): string => (Number.isFinite(t) ? String(Number(t.toPrecision(6))) : String(t))

/** Phase at tC from the sourced bounds; bounds that are null are treated as "not crossed". */
export function phaseAt(p: Pick<PhaseProps, 'freezeC' | 'boilC'>, tC: number): Phase {
  if (p.freezeC !== null && Number.isFinite(p.freezeC) && tC < p.freezeC) return 'solid'
  if (p.boilC !== null && Number.isFinite(p.boilC) && tC > p.boilC) return 'gas'
  return 'liquid'
}

/** Phase gate: may this material be spawned as a liquid at tempC? */
export function validateSpawn(props: PhaseProps, tempC: number): GateResult {
  if (props.hiddenReason) return { ok: false, reason: `${props.name} is not offered as a liquid: ${props.hiddenReason}` }
  if (!Number.isFinite(tempC)) return { ok: false, reason: `${props.name}: spawn temperature is not a number` }
  if (props.unsourcedReason) return { ok: false, reason: `${props.name}: ${props.unsourcedReason}` }
  const ph = phaseAt(props, tempC)
  if (ph === 'solid') {
    return { ok: false, reason: `${props.name} is a solid at ${fmtC(tempC)} °C (melts at ${fmtC(props.freezeC as number)} °C); only liquids can be spawned` }
  }
  if (ph === 'gas') {
    return { ok: false, reason: `${props.name} is a gas at ${fmtC(tempC)} °C (boils at ${fmtC(props.boilC as number)} °C at 1 atm); only liquids can be spawned` }
  }
  if (props.liquidUnsourcedReason) {
    return { ok: false, reason: `${props.name} would be liquid at ${fmtC(tempC)} °C, but ${props.liquidUnsourcedReason}` }
  }
  const r = props.dataRangeC
  if (r && !(tempC >= r[0] && tempC <= r[1])) {
    const span = r[0] === r[1] ? `only at ${fmtC(r[0])} °C` : `${fmtC(r[0])}–${fmtC(r[1])} °C`
    return { ok: false, reason: `${props.name}: no validated property data at ${fmtC(tempC)} °C (sourced ${span})` }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pairwise thermal gate
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SceneMaterial {
  name: string
  tempC: number
  freezeC: number | null
  boilC: number | null
  dataRangeC?: readonly [number, number] | null
}

export interface SceneVerdict {
  ok: boolean
  warnings: string[]
  refusals: string[]
}

/**
 * Validate a set of materials that will share one isothermal scene.
 * Refusal  — a material is not liquid at its own temperature, or material A's temperature lies below B's freezing
 *            point or above B's boiling point (contact would freeze/boil B; the sim has no heat transfer to do it).
 * Warning  — any two temperatures differ (heat exchange not modelled; ρ, μ stay at spawn values), a phase bound
 *            needed for the check is unsourced, or A's temperature is outside B's validated property range.
 */
export function validateScene(materials: readonly SceneMaterial[]): SceneVerdict {
  const warnings: string[] = []
  const refusals: string[] = []
  for (const m of materials) {
    const ph = phaseAt(m, m.tempC)
    if (ph !== 'liquid') refusals.push(`${m.name} is ${ph} at its own temperature ${fmtC(m.tempC)} °C`)
  }
  for (let i = 0; i < materials.length; i++) {
    for (let j = 0; j < materials.length; j++) {
      if (i === j) continue
      const a = materials[i], b = materials[j]
      if (b.freezeC !== null && a.tempC < b.freezeC) {
        refusals.push(`${a.name} at ${fmtC(a.tempC)} °C is below the freezing point of ${b.name} (${fmtC(b.freezeC)} °C): contact would freeze ${b.name}, and heat transfer is not modelled`)
      }
      if (b.boilC !== null && a.tempC > b.boilC) {
        refusals.push(`${a.name} at ${fmtC(a.tempC)} °C is above the boiling point of ${b.name} (${fmtC(b.boilC)} °C): contact would boil ${b.name}, and heat transfer is not modelled`)
      }
      if (b.freezeC === null && a.tempC < b.tempC) {
        warnings.push(`${b.name}: freezing point unsourced — cannot check whether ${a.name} at ${fmtC(a.tempC)} °C would solidify it`)
      }
      if (b.boilC === null && a.tempC > b.tempC) {
        warnings.push(`${b.name}: boiling point unsourced — cannot check whether ${a.name} at ${fmtC(a.tempC)} °C would boil it`)
      }
      const r = b.dataRangeC
      if (r && !(a.tempC >= r[0] && a.tempC <= r[1])) {
        warnings.push(`${a.name} at ${fmtC(a.tempC)} °C is outside ${b.name}'s validated property range (${fmtC(r[0])}–${fmtC(r[1])} °C)`)
      }
      if (i < j && a.tempC !== b.tempC) {
        warnings.push(`isothermal model: ${a.name} (${fmtC(a.tempC)} °C) and ${b.name} (${fmtC(b.tempC)} °C) exchange no heat; ρ and μ stay at their spawn values`)
      }
    }
  }
  return { ok: refusals.length === 0, warnings, refusals }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MLS-MPM code units (legacy MPM path only)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Units contract (owner-approved 2026-07-17, plan §4.3 / S1.1) — imported, never copied (src/fluid-engine/units.ts):
// 1 cell = DX_M, 1 code time unit = TAU_S, REST_DENSITY = REST_PPC particles per cell, particle mass 1 code unit.
export const MPM_TAU_S = TAU_S
export const MPM_DX_M = DX_M
export const MPM_PPC = REST_PPC
/** Largest legacy MPM substep in τ. units.mpmSubsteps never exceeds MPM_SUBSTEP_S, so this is the worst case. */
export const MPM_DT_CODE = MPM_SUBSTEP_S / TAU_S

/**
 * SI dynamic viscosity → the code-unit coefficient p2g2.wgsl multiplies (C + Cᵀ) by.
 *
 * Derivation. p2g2.wgsl forms σ_code = μ_code (C + Cᵀ), C in 1/τ, and scatters −V_p·4·σ·Δt (Hu et al. 2018 eq. 16 with
 * M_p⁻¹ = 4/dx², dx = 1). Code stress units are m_p/(dx·τ²), so μ_code carries m_p/(dx·τ). Each particle has code mass 1
 * and the rest state holds `ppc` particles per cell (REST_DENSITY == ppc), so one code mass unit is the physical mass of
 * 1/ppc of a cell of the material: m_p = ρ dx³/ppc. Hence 1 μ_code = ρ dx³/(ppc·dx·τ) = ρ dx²/(ppc·τ) Pa·s, and
 *
 *     μ_code = ppc · μ · τ / (ρ · dx²)   (= 4 ν τ/dx² at the defaults; r4 §B.4)
 *
 * Assumption carried by this formula: particle mass 1 and REST_DENSITY == ppc for EVERY material (true of p2g2 today),
 * i.e. each material's own ρ defines its mass unit. It therefore reproduces each material's kinematic viscosity ν = μ/ρ,
 * which is what a single-material scene sees; in mixed scenes the solver has no per-material mass (r4 §C.1-2) — that
 * is a solver limitation, not a conversion error.
 * Known bias [ESTIMATE, not corrected — correcting it would be tuning]: the viscous acceleration is μ_code/ρ_code with
 * the LOCAL code density; the weakly compressible EOS leaves a settled pool ≈ 17 % denser than REST_PPC (BASELINE.md,
 * survey-01: packing 4.5–4.75), so the effective ν there is ≈ 13–16 % below the material's ν.
 * Examples at the defaults [D]: water 20 °C 5.2e-5, olive oil 4.8e-3, glycerol 20 °C 5.8e-2, GRD lava 1200 °C 3.85.
 */
export function mpmViscosityCode(muPaS: number, rhoKgM3: number, tauS = MPM_TAU_S, dxM = MPM_DX_M, ppc = MPM_PPC): number {
  return (ppc * muPaS * tauS) / (rhoKgM3 * dxM * dxM)
}

/**
 * Smallest code density any particle can have: ρ_p = Σ_i w_ip m_i ≥ Σ_i w_ip² (its own mass, m_p = 1) = Π_axes Σ_a w_a²,
 * with the quadratic B-spline weights of p2g.wgsl, w = (½(½−d)², ¾−d², ½(½+d)²), d = cell_diff ∈ [−½, ½].
 * Σ_a w_a² = ¼(½−d)⁴ + (¾−d²)² + ¼(½+d)⁴ is 0.59375 at d = 0 and 0.5 at d = ±½ (its minimum), so the bound is 0.5³ = 1/8,
 * reached by a LONE particle at cell_diff = ±½ on every axis [D]. (The materials gate re-derives it by scanning d.)
 */
export const MPM_MIN_PARTICLE_CODE_DENSITY = 0.125

/**
 * Explicit-viscosity stability bound of the legacy MLS-MPM kernels, DERIVED from p2g → p2g2 → gridForces → g2p
 * (S1.5 review, replaces the plan's unverified FTCS-analogue estimate 3.3):
 *
 *  1. One substep maps the particle state s = {v_p, C_p} to G·P·E(s):
 *       E  (p2g2, per particle)  C_p ↦ C_p − 4·Δt·V_p·μ (C_p + C_pᵀ), V_p = 1/ρ_p   (v_p unchanged)
 *       P  (p2g + gridForces)    u_i = Σ_p w_ip (v_p + C_p d_ip) / m_i
 *       G  (g2p)                 v_p = Σ_i w_ip u_i,  C_p = 4 Σ_i w_ip u_i d_ipᵀ
 *     (the p2g2 impulse −V_p·4·σ·Δt·w·d is exactly what P scatters for the E-modified C). Gravity is an affine forcing
 *     and the wall band only removes grid velocity, so neither can make the homogeneous part grow.
 *  2. In the norms ‖s‖² = Σ_p (|v_p|² + ¼|C_p|²) and ‖u‖² = Σ_i m_i|u_i|²: G2P is the w-weighted least-squares affine
 *     fit, so ‖G u‖ ≤ ‖u‖ (Pythagoras; Σ_i w d dᵀ = ¼ I for quadratic B-splines), and P2G is its adjoint, so ‖P‖ ≤ 1.
 *  3. E is self-adjoint: skew(C) → skew(C), sym(C) → (1 − 8·Δt·μ/ρ_p)·sym(C).
 *  ⇒ ‖s'‖ ≤ ‖s‖ whenever |1 − 8Δtμ/ρ_p| ≤ 1 for every particle, i.e. μ_code ≤ ρ_p/(4Δt). With ρ_p ≥ 1/8 for ANY
 *     configuration (MPM_MIN_PARTICLE_CODE_DENSITY) the configuration-independent bound is
 *
 *         μ_code ≤ 1 / (32·Δt_code)  = 0.15625 at Δt = 0.2 τ
 *
 *     and it is SHARP: a lone particle at cell_diff = ±½ has sym(C) multiplied by exactly 1 − 8Δtμ/(1/8) each substep.
 *  Scope (stated, not hidden): linear viscous part only — the EOS pressure term, f32 arithmetic, the fixed-point grid
 *  encoding and the ±200 encode clamp are outside the proof. MEASURED on a float64 CPU replica of the four kernels
 *  (scripts/fluid-gates/lib/mpmReplica.mjs): energy non-increasing at the bound for random 1/2/4/8-particle clusters and
 *  a 4 ppc block, lone particle unstable at 1.01×. Not yet confirmed on the GPU.
 *  Consequence: a denser interior tolerates more (ρ_p ≈ 4 → 5), but splash droplets can always produce a lone particle,
 *  so a spawn-time material gate must use the lone-particle bound.
 */
export function mpmViscosityStabilityLimit(dtCode = MPM_DT_CODE): number {
  return MPM_MIN_PARTICLE_CODE_DENSITY / (4 * dtCode)
}

/** Refusal limit for μ_code on the legacy MPM path: the derived lone-particle bound at the largest substep (0.15625). */
export const MPM_MU_CODE_LIMIT = mpmViscosityStabilityLimit(MPM_DT_CODE)

/** The plan's earlier estimate (FINAL-PLAN.md §7 S1.5: FTCS analogue ppc/(6Δt) ≈ 3.3, "UNVERIFIED for the MLS stencil").
 *  Superseded by MPM_MU_CODE_LIMIT; kept only so reports can show the change. Not used by any gate. */
export const MPM_MU_CODE_LIMIT_PLAN_ESTIMATE = 3.3

/**
 * Numerical viscosity of the incompressible APIC-MAC solver at dx = 5.672 cm, MEASURED by gate D2 (S3.4, clean tree
 * 225d736): ν_num = 1.04e-3 m²/s from the E_K envelope of a standing wave at H/dx = 28 (GPU 1.02e-3). FINAL-PLAN §5.6:
 * the implicit viscous solve (S3.6) runs for ν_phys ≥ 0.01·ν_num; below that the physical term is invisible.
 * Until S3.6 exists the incompressible path therefore
 *   - REFUSES ν_phys ≥ ν_num: the missing physical viscosity would be at least the scheme's own — the liquid would flow
 *     qualitatively wrong (glycerol 1.1e-3, honey, lava); FINAL-PLAN D2 consequence: glycerol-level viscosity is
 *     unresolvable at this dx anyway;
 *   - WARNS for 0.01·ν_num ≤ ν_phys < ν_num (olive oil 9.2e-5): its viscosity is real but not simulated yet, so it flows
 *     more freely than it should.
 */
export const INCOMPRESSIBLE_NU_NUM = 1.04e-3

export type IncompressibleViscosityVerdict = { ok: true; warning: string | null } | { ok: false; reason: string }

export function incompressibleViscosityVerdict(muPaS: number, rhoKgM3: number, name = 'material'): IncompressibleViscosityVerdict {
  if (!Number.isFinite(muPaS) || muPaS < 0 || !Number.isFinite(rhoKgM3) || rhoKgM3 <= 0) {
    return { ok: false, reason: `${name}: no validated viscosity/density at this state` }
  }
  const nu = muPaS / rhoKgM3
  if (nu >= INCOMPRESSIBLE_NU_NUM) {
    return { ok: false, reason: `${name}: ν = ${nu.toExponential(2)} m²/s is at or above the solver's own numerical viscosity (${INCOMPRESSIBLE_NU_NUM.toExponential(2)} m²/s at 5.67 cm cells) — without the implicit viscous solve (plan S3.6) it would flow like a thin liquid; refused, not faked` }
  }
  if (nu >= 0.01 * INCOMPRESSIBLE_NU_NUM) {
    return { ok: true, warning: `${name}: its viscosity (ν = ${nu.toExponential(2)} m²/s) is not simulated until plan S3.6 — it flows more freely than the real liquid` }
  }
  return { ok: true, warning: null }
}

export type MpmViscosityVerdict =
  | { ok: true; muCode: number }
  | { ok: false; muCode: number; reason: string }

/** Refuse (never clamp) a material whose converted MPM viscosity exceeds MPM_MU_CODE_LIMIT, or whose ρ/μ is unknown. */
export function validateMpmViscosity(
  muPaS: number, rhoKgM3: number, tauS = MPM_TAU_S, dxM = MPM_DX_M, ppc = MPM_PPC, name = 'material',
): MpmViscosityVerdict {
  if (!Number.isFinite(muPaS) || muPaS < 0) {
    return { ok: false, muCode: NaN, reason: `${name}: viscosity unknown (${muPaS} Pa·s) — no validated value at this state` }
  }
  if (!Number.isFinite(rhoKgM3) || rhoKgM3 <= 0) {
    return { ok: false, muCode: NaN, reason: `${name}: density unknown (${rhoKgM3} kg/m³) — no validated value at this state` }
  }
  const muCode = mpmViscosityCode(muPaS, rhoKgM3, tauS, dxM, ppc)
  if (muCode > MPM_MU_CODE_LIMIT) {
    return {
      ok: false, muCode,
      reason: `${name}: μ = ${muPaS.toPrecision(4)} Pa·s (ρ = ${rhoKgM3.toPrecision(5)} kg/m³) is ${muCode.toPrecision(3)} in MPM code units, above the legacy MPM solver's explicit-viscosity stability limit ${MPM_MU_CODE_LIMIT} (a splashed lone particle would blow up); it is refused, not clamped. It needs the implicit-viscosity solver (plan S3).`,
    }
  }
  return { ok: true, muCode }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Menu visibility / spawn checks
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** 'show' = spawnable; 'refused' = listed but disabled with `reason`; 'hidden' = not listed (D7: copper). */
export type MenuVisibility = 'show' | 'refused' | 'hidden'

export interface MenuEntry {
  id: number
  name: string
  visibility: MenuVisibility
  reason: string | null
  flags: string[]
  /** Temperature the entry was evaluated at (°C). */
  tempC: number
  /** Sourced temperature range (°C) — a single point for fixed-temperature presets (the UI can snap to it). */
  dataRangeC: readonly [number, number] | null
  /** MPM code-unit viscosity at tempC (NaN when ρ or μ is unknown). */
  muCode: number
}

/** Result of CompositionTable.checkSpawn / checkScene: the material gates plus the pairwise thermal gate. */
export type SpawnCheck =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] }
