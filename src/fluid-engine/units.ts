// SI units for the MLS-MPM fluid — the ONE place code units are defined and converted.
//
// The MPM kernels (src/gpu-sim/shaders/*.wgsl) work in "code units": lengths in grid cells,
// time in τ, particle mass 1. The 2026-07-17 units contract ratified τ = 1/24 s (dt = 0.2 τ,
// 2 substeps per 1/60 s frame) and a ~3.63 m tank; here the tank edge L is the primary length
// and every other length follows from it. Convert through these helpers — never copy a
// numeric constant with a time or length dimension into another file (that is how gravity
// ended up hard-coded in three disagreeing places).

/** Standard gravity, exact by definition. Source: NIST CODATA, https://physics.nist.gov/cgi-bin/cuu/Value?gn */
export const G_STANDARD = 9.80665 // m/s²

/** Grid resolution of the MPM background grid (cells per tank edge). Must match GRID_RES in the shaders. */
export const GRID_RES = 64

/** Code time unit τ in seconds (2026-07-17 units contract). */
export const TAU_S = 1 / 24

/** Edge length of the simulation GRID in metres (default domain scale, owner decision D2
 *  2026-09-28). The water cannot use all of it: see TANK_INNER_M. */
export const DOMAIN_L_M = 3.63

/** Grid cell size in metres. */
export const DX_M = DOMAIN_L_M / GRID_RES

/** Cells between the grid edge and the tank wall on every face: the separating-boundary band
 *  in gridForces.wgsl (BOUND = 3). The fluid lives inside [3, 61] cells. */
export const WALL_BAND_CELLS = 3

/** Inside size of the tank, wall to wall, in metres: (64 − 2·3) cells × dx = 3.290 m.
 *  Scenario metres are measured from the tank's inner (0,0,0) corner, i.e. from the walls. */
export const TANK_INNER_M = (GRID_RES - 2 * WALL_BAND_CELLS) * DX_M

/** Tank metres (from the inner wall corner) → grid-normalised [0,1] coordinate. */
export const tankMetresToUnit = (m: number) => WALL_BAND_CELLS / GRID_RES + m / DOMAIN_L_M

/** Grid-normalised [0,1] coordinate → tank metres (from the inner wall corner). */
export const unitToTankMetres = (u: number) => (u - WALL_BAND_CELLS / GRID_RES) * DOMAIN_L_M

/** Fixed simulation macro-step: every presented frame's worth of physics is 1/60 s of sim time. */
export const MACRO_DT_S = 1 / 60

/** The legacy MPM substep (0.2 τ = 1/120 s): the explicit EOS was tuned and verified at this Δt. */
export const MPM_SUBSTEP_S = 0.2 * TAU_S

/** Acceleration m/s² → code units (cells/τ²). */
export const accelToCode = (aMs2: number) => aMs2 * TAU_S * TAU_S / DX_M

/** Acceleration m/s² → tank-normalised units ([0,1] lengths per τ²), used by the ball integrator. */
export const accelToUnitPerTau2 = (aMs2: number) => accelToCode(aMs2) / GRID_RES

/** Seconds → code time units τ. */
export const secondsToCode = (s: number) => s / TAU_S

/** Particle velocity as stored by g2p ([0,1] lengths per τ) → m/s. */
export const unitVelToMs = (v: number) => v * DOMAIN_L_M / TAU_S

/** m/s → particle velocity units ([0,1] lengths per τ). */
export const msToUnitVel = (v: number) => v * TAU_S / DOMAIN_L_M

/** Split a sim-time interval into equal MPM substeps no longer than the legacy substep
 *  (the explicit EOS is only verified up to that Δt, so never round up past it). */
export function mpmSubsteps(intervalS: number): { n: number; dtCode: number } {
  const n = Math.max(1, Math.ceil(intervalS / MPM_SUBSTEP_S - 1e-9))
  return { n, dtCode: secondsToCode(intervalS / n) }
}
