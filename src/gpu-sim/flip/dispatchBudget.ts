// dispatchBudget.ts — PERF-1 L0, S3N-23 "a per-kernel dispatch budget" (vault fluid/realism-2026-09 PERF-1 spec §4 L0):
// the dispatches ONE frame of FlipGpuSimulator.step(encoder, n) encodes, per compute-pass label, as a formula of the
// frame's state. It follows the encode paths (FlipGpuSimulator.step → encodeSphereStart, encodeDensityCorrection,
// encodeSubstepBody → encodeWallShear, encodeProjection | encodeStokes; PoissonSolver.encodePrepare / encodeSolve through its static
// `dispatches`; ViscositySolver.encode / encodePrepare; StokesSolver.encode; ImmiscibleSolver.encode) and never reads a
// count an encoder returns: it is the budget every later dispatch lever is checked against. The self-test kind
// 'dispatchBudget' and scripts/fluid-gates/perf-profile.mjs compare it with counted dispatches at tolerance 0 — a change
// to any encode path must change this file in the same commit.

/** A PoissonSolver's static dispatch structure (PoissonSolver.dispatches). */
export interface SolveShape { prepare: number; init: number; perIteration: number; finalize: number; rankInit: number; rankPerIteration: number }

/** Everything the frame's dispatch count depends on, snapshotted after step() encoded it (FlipGpuSimulator.budgetState). */
export interface BudgetState {
  substeps: number
  /** count > 0: the particle passes (faceScatter, g2pMac, the scatters) are dispatched */
  particles: boolean
  projection: boolean
  densityProjection: boolean
  /** freeSurface 'ghost' (the level set); else the voxel labels */
  ghost: boolean
  variableDensity: boolean
  sphere: boolean
  /** S3.7 monolithic coupling (rank term, V_J + gravity at the substep start, force/update after every projection) */
  monolithic: boolean
  /** the viscous solve is active (the split path unless `stokes`) */
  viscous: boolean
  /** S3.6e: the pressure–stress solve replaces the projection this frame (FlipGpuSimulator.stokesRuns) */
  stokes: boolean
  /** the drift flux runs (immiscibleActive) and where J is formed */
  immiscible: boolean
  driftForm: 'face' | 'cell'
  /** FRICTION: the floor's wall shear runs (set, and not guarded off by the viscous path or the immiscible drift —
   *  FlipGpuSimulator.wallShearRuns) */
  wallShear: boolean
  extrapolationLayers: number
  caps: { pressure: number; psi: number; viscous: number; stokes: number }
  pressure: SolveShape
  /** null without the density projection */
  psi: SolveShape | null
}

/** The frame's dispatches per compute-pass label (labels with zero dispatches are absent). */
export function frameDispatches(s: BudgetState): Map<string, number> {
  const m = new Map<string, number>()
  const add = (label: string, k: number) => { if (k > 0) m.set(label, (m.get(label) ?? 0) + k) }
  const P = s.particles ? 1 : 0
  const solve = (sh: SolveShape, cap: number, rank: boolean) =>
    sh.init + cap * sh.perIteration + sh.finalize + (rank ? sh.rankInit + cap * sh.rankPerIteration : 0)
  const rank = s.sphere && s.monolithic
  // encodePressureLabels: voxel labels (+ ghostCoef with variable density) or the ghost-fluid level set; the ball's
  // liquid extension (two mark/commit passes), its weighted coefficients and (monolithic) the rank vector
  const pressureLabels = () => {
    if (!s.ghost) {
      add('flip.labelClear', 1); add('flip.labelParticles', P)
      if (s.variableDensity) add('flip.ghostCoef', 1)
      return
    }
    add('flip.lsScatter', P); add('flip.lsFinalize', 1); add('flip.labelParticles', P); add('flip.lsResolve', 1)
    if (s.sphere) { add('flip.sphereExtendMark', 2); add('flip.sphereExtendCommit', 2) }
    add('flip.ghostCoef', 1)
    if (s.sphere) { add('flip.sphereCoef', 1); if (s.monolithic) add('flip.sphereRank', 1) }
  }
  // encodePressureSolve: prepare + solve (rank with the monolithic ball)
  const pressureSolve = () => { add('flip.pressure:prepare', s.pressure.prepare); add('flip.pressure:solve', solve(s.pressure, s.caps.pressure, rank)) }
  // encodeProject(couple)
  const project = (couple: boolean) => {
    add('flip.project', 1)
    if (s.sphere && s.monolithic) { add('flip.sphereForce', 1); add('flip.sphereMonoUpdate', 1); add('flip.sphereFaceVel', 1); return }
    if (s.sphere) add('flip.sphereFaceVel', 1)
    if (s.sphere && couple) { add('flip.sphereForce', 1); add('flip.sphereIntegrate', 1) }
  }
  // encodeFaceAccel: faceAccel, then the velocity's extrapolation kernel over the accelerations
  const faceAccel = () => { add('imm.faceAccel', 1); add('imm.extrapolateAccel', s.extrapolationLayers) }
  for (let sub = 0; sub < s.substeps; sub++) {
    // encodeSphereStart: advance, fractions, the ψ weights (with the density projection), V_J + gravity (monolithic)
    if (s.sphere) {
      add('flip.sphereAdvance', 1); add('flip.sphereFaces', 1); add('flip.sphereCells', 1)
      if (s.densityProjection) add('flip.psiCoef', 1)
      if (s.monolithic) { add('flip.sphereVolume', 1); add('flip.sphereGravity', 1) }
    }
    // encodeDensityCorrection: labels, cellScatter, densityRhs, the ψ solve (cold), faceDisplacement, positionCorrect
    if (s.densityProjection) {
      if (!s.psi) throw new Error('frameDispatches: densityProjection without a ψ solver shape')
      add('flip.labelClear', 1); add('flip.labelParticles', P)
      add('flip.cellScatter', P); add('flip.densityRhs', 1)
      add('flip.psi:prepare', s.psi.prepare); add('flip.psi:solve', solve(s.psi, s.caps.psi, false))
      add('flip.faceDisplacement', 1); add('flip.positionCorrect', P)
    }
    // encodeSubstepBody: (the wall shear: floor-row scatter, the per-cell law, the update), P2G, grid update,
    // (projection | Stokes), extrapolation, drift, G2P
    if (s.wallShear) { add('flip.wallShearScatter', P); add('flip.wallShearCell', 1); add('flip.wallShearApply', P) }
    add('flip.faceScatter', P); add('flip.gridUpdate', 1)
    if (s.projection) {
      if (s.stokes) {
        // encodeStokes: labels, fill, extrapolation, the viscous prepare, the one pressure–stress solve (always with the
        // ball: stokesRuns needs it), the face accelerations
        pressureLabels(); add('flip.fillLiquidFaces', 1); add('flip.extrapolate', s.extrapolationLayers)
        add('visc.lattice', 3); add('visc.volumes+mu', 3)
        add('stokes.setup', 11); add('stokes.pcg', 7 * s.caps.stokes); add('stokes.finish', 5)
        if (s.immiscible) faceAccel()
      } else {
        // encodeProjection: labels, fill, divergence, solve, project; the split viscous path adds extrapolation, the
        // viscous solve (19 fixed + 7 per iteration) and a second divergence, solve and project
        pressureLabels(); add('flip.fillLiquidFaces', 1); add('flip.divergence', 1); pressureSolve()
        project(!s.viscous)
        if (s.viscous) {
          add('flip.extrapolate', s.extrapolationLayers)
          add('visc.lattice', 3); add('visc.volumes', 1); add('visc.mu', 3); add('visc.system', 10)
          add('visc.pcg', 7 * s.caps.viscous); add('visc.finish', 2)
          add('flip.divergence', 1); pressureSolve(); project(true)
        }
        if (s.immiscible) faceAccel()
      }
    }
    add('flip.extrapolate', s.extrapolationLayers)
    // ImmiscibleSolver.encode: alphaScatter, cellInfo, slipParticles, driftCells, then the face form's slipFaces,
    // driftFaces, driftParticlesFace or the cell form's driftParticles (particle passes only with particles)
    if (s.immiscible) add('imm.drift', s.driftForm === 'face' ? 3 + 4 * P : 2 + 3 * P)
    add('flip.g2pMac', P)
  }
  add('flip.present', P)
  return m
}

/** Per-label differences counted − budget (only the labels that differ); empty when the frame matches. */
export function budgetMismatch(counted: Map<string, number> | Record<string, number>, budget: Map<string, number>): { label: string; counted: number; budget: number }[] {
  const c = counted instanceof Map ? counted : new Map(Object.entries(counted))
  const out: { label: string; counted: number; budget: number }[] = []
  for (const label of new Set([...c.keys(), ...budget.keys()])) {
    const a = c.get(label) ?? 0, b = budget.get(label) ?? 0
    if (a !== b) out.push({ label, counted: a, budget: b })
  }
  return out.sort((x, y) => x.label.localeCompare(y.label))
}
