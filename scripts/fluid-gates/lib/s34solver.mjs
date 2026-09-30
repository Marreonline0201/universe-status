// s34solver.mjs — s34-ref's solver options, and the switches the friction gates put on them (FRICTION-spec revision 2,
// vault fluid/realism-2026-09/FRICTION-spec.md §3.6: "give s34-ref a stage option that reaches opts()").
//
// s34Opts is s34-ref.mjs's opts(), moved here unchanged (s34-ref's printed output is byte-identical before and after the
// move), so every script that runs the S3.4 scenes — s34-ref.mjs, s38-dambreak.mjs — runs one solver: a copy would drift
// from A2g's own (spec §3.6, the reason the scene builders live in s34scenes.mjs).
//
// The switches (argv), each absent by default — absent, they add nothing:
//   --wall-shear=keulegan1938  the floor's wall shear, FlipRef options.wallShear = { wall: 'y-', law } (flipRef.ts
//                              applyWallShear). Only the production law: the test laws (darcyTest, constantTest) need
//                              their parameters and belong to s38-ref's W1 gates.
//   --water-temp=<°C>          a water temperature: ρ = waterDensity(T) and μ = LIQUIDS.water.viscosity(T) =
//                              waterViscosity(T) (src/composition/materialData.ts :119, :128, :418–422) — the NIST
//                              WebBook isobar at 0.101325 MPa (IAPWS-95 density, IAPWS 2008 viscosity), linear in ρ and
//                              log-linear in μ between its 1 °C rows, NaN outside 0.01–99.9743 °C (refused here). The
//                              caller decides which scenes take it (s34-ref: the column scenes).
import { G, RHO } from './s34scenes.mjs'   // RHO: s34-ref's solver density, the NIST 20 °C row

const gvec = [0, -G, 0]
/** s34-ref's solver: the ghost-fluid free surface with the density projection; pressure 1e-6 and ψ 1e-5 unless a scene
 *  says otherwise (s34scenes column() passes 1e-5 / 1e-4). */
export const s34Opts = (extra = {}) => ({ gravity: gvec, density: RHO, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5, ...extra })

export const WALL_SHEAR_LAWS = ['keulegan1938']

/** Refuses any argument that is not one of `allowed` (a flag ending in '=' takes a value): a misspelt switch would run
 *  the stage-off solver and print a stage-off PASS where a stage-on run was meant (s34-ref's --only rule, review
 *  2026-09-29: "an unknown name would run nothing and print PASS"). */
export function refuseUnknownArgs(argv, allowed) {
  for (const a of argv.slice(2)) {
    const ok = allowed.some(f => (f.endsWith('=') ? a.startsWith(f) && a.length > f.length : a === f))
    if (!ok) throw new Error(`unknown argument "${a}" (accepted: ${allowed.map(f => (f.endsWith('=') ? `${f}…` : f)).join(', ')})`)
  }
}

const argValue = (argv, flag) => {
  const hits = argv.slice(2).filter(a => a.startsWith(`${flag}=`))
  if (hits.length > 1) throw new Error(`${flag} given ${hits.length} times`)
  return hits.length ? hits[0].slice(flag.length + 1) : null
}

/** --wall-shear=<law>: the law, or null (off). An unknown law is refused. */
export function wallShearArg(argv) {
  const v = argValue(argv, '--wall-shear')
  if (v !== null && !WALL_SHEAR_LAWS.includes(v)) throw new Error(`--wall-shear: unknown law "${v}" (${WALL_SHEAR_LAWS.join(', ')})`)
  return v
}

/** --water-temp=<°C>: the temperature, or null (the solver default: the NIST 20 °C row). */
export function waterTempArg(argv) {
  const v = argValue(argv, '--water-temp')
  if (v === null) return null
  const t = Number(v)
  if (v.trim() === '' || !Number.isFinite(t)) throw new Error(`--water-temp: "${v}" is not a temperature in °C`)
  return t
}

/** Water at tC from the loaded materialData module (the functions the materials use; see the header). */
export function waterAt(materialData, tC) {
  const rho = materialData.waterDensity(tC), mu = materialData.LIQUIDS.water.viscosity(tC)
  if (!(rho > 0 && mu > 0)) throw new Error(`--water-temp: ${tC} °C is outside materialData's water table (0.01–99.9743 °C)`)
  return { tC, rho, mu, nu: mu / rho }
}

/** Solver options for that water: the solver's density (its pressure scale) and viscosityDefault — the stage's μ, as
 *  makeParticles allocates no per-particle μ. The particles' mass ρ·V_p is the caller's (s34scenes column({ rho })). */
export const waterOpts = w => ({ density: w.rho, viscosityDefault: w.mu })

/** One line naming a water, for every stage-on and reported line; with none given, the defaults read off a solver built
 *  with s34Opts (its density and viscosityDefault — the NIST 20 °C row at 7b248dc4). */
export const waterText = (w, sim) => (w
  ? `water ${w.tC} °C (materialData: ρ ${w.rho} kg/m³, μ ${w.mu.toPrecision(7)} Pa·s, ν ${w.nu.toExponential(4)} m²/s)`
  : `water: the solver default (ρ ${sim.density} kg/m³, μ ${sim.viscosityDefault} Pa·s, ν ${(sim.viscosityDefault / sim.density).toExponential(4)} m²/s)`)

/** Non-vacuity of stage-on runs (spec §4 "Non-vacuity, in every stage-on gate"): the stage's own log over the given
 *  solvers — cell-applications (Σ over steps of the cells acted on) > 0 and Σ|booked| = Σ over steps of |impX| + |impZ|
 *  (N·s; s38-ref's definition) > 0. Also the largest τ and the laminar-branch share of the cell-applications. */
export function stageActed(sims) {
  let steps = 0, cells = 0, booked = 0, laminar = 0, tauMax = 0
  for (const sim of sims) for (const e of sim.wallShearLog ?? []) {
    steps++; cells += e.cells; booked += Math.abs(e.impX) + Math.abs(e.impZ); laminar += e.laminar; tauMax = Math.max(tauMax, e.tauMax)
  }
  return { steps, cells, booked, laminar, tauMax, ok: cells > 0 && booked > 0 }
}

export const actedText = a => `the wall shear acted: ${a.cells} cell-applications over ${a.steps} steps, Σ|booked| ${a.booked.toExponential(3)} N·s (> 0 each: non-vacuity), τ_max ${a.tauMax.toPrecision(3)} Pa, laminar branch ${a.cells ? (100 * a.laminar / a.cells).toFixed(1) : '0.0'} % of them`
