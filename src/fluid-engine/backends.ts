// backends.ts — the solver behind FluidEngine (FINAL-PLAN S3.1c): the legacy MLS-MPM (kept behind ?solver=mpm, owner
// decision D8) or the incompressible APIC-MAC solver (S3.0–S3.6: MGPCG pressure, Kugelstadt density projection,
// ghost-fluid free surface, per-face variable density, implicit viscosity). Both present particles in the same legacy 80-byte layout in
// world units (tank-normalised [0,1]³ of the 64³ grid, velocities per τ), so the renderer and every consumer are
// unchanged; each backend converts to its own solver units here and nowhere else.
import { MpmGpuSimulator, type GpuParticle } from '../gpu-sim/MpmGpuSimulator'
import { FlipGpuSimulator, PRESENT_STRIDE_BYTES } from '../gpu-sim/flip/FlipGpuSimulator'
import { SOLID_REFERENCE, type LiquidKey } from '../composition/materialData'
import type { SolverMethod } from '../composition/CompositionTable'
import { DOMAIN_L_M, GRID_RES, TAU_S, accelToCode, accelToUnitPerTau2, mpmSubsteps, unitVelToMs } from './units'
import { FLIP_PACKING, MPM_PACKING, flipPacking, type Packing, type Vec3 } from './spawn'
import { waterDensity } from '../composition/materialData'
import { VISCOUS_RUN_NU, INCOMPRESSIBLE_NU_NUM } from '../composition/liquidGate'
import { interfacialTension } from '../composition/interfacialTension'
import { IMMISCIBLE_MAX_SLOTS } from '../gpu-sim/flip/ImmiscibleSolver'

export type SolverKind = 'mpm' | 'flip'

/** One particle to spawn, in world units; ρ is the material's density at its spawn temperature (kg/m³). */
export interface SpawnParticle { pos: Vec3; vel: Vec3; compositionId: number; temperatureC: number; phase: number; rhoKgM3: number }

/** `drift` (FLIP with the immiscible drift active): per particle the slip (m/s, xyz) and the drop diameter d (m, 0: not
 *  dispersed) of the last substep — the gates' check of the page's creaming (s31c-page B1). */
export interface ParticleSample { positions: Float32Array; velocities: Float32Array; compIds: Uint32Array; affine: Float32Array; drift?: Float32Array }

/** The drop-ball obstacle, world units (velocity per τ). Mutated in place by a backend that integrates it. */
export interface BallState { active: boolean; radius: number; center: Vec3; velocity: Vec3 }

/** readViscosityProbe: μ = w/(2V) of the last viscous solve over cells with V ≥ 0.999 (inactive: no cells). */
export interface ViscosityProbe { active: boolean; fullCells: number; muMin: number; muMax: number; distinct: number[] }

export interface BackendDiagnostics {
  /** Particles pushed back inside the solver's walls (MPM: clamp hits; FLIP: advection wall clamps). */
  clampHits: number
  [key: string]: number
}

export interface SimBackend {
  readonly kind: SolverKind
  /** Short name for the HUD. */
  readonly label: string
  /** Material-gate method (CompositionTable). */
  readonly method: SolverMethod
  readonly packing: Packing
  /** false: the drop-ball obstacle is not coupled on this solver yet. */
  readonly supportsBall: boolean
  /** Why the ball cannot be coupled with the current tank contents (null = it can). */
  ballRefusal?(): string | null
  /** The 80-byte legacy particle layout the renderer reads. */
  readonly particleBuffer: GPUBuffer
  readonly particleCount: number
  setParticles(ps: readonly SpawnParticle[]): void
  addParticles(ps: readonly SpawnParticle[]): void
  setGravity(gMs2: number): void
  setCompositionProps(gpuData: Float32Array): void
  /** μ (Pa·s) per composition id — the incompressible solver's viscous solve (S3.6); the MPM path takes μ in its props. */
  setViscosities?(muPaS: Float32Array): void
  /** The cited liquid of each composition id (null: not a cited liquid) — the incompressible solver's immiscible drift. */
  setLiquidKeys?(keys: readonly (LiquidKey | null)[]): void
  /** Advance `intervalS` of sim time (the ball, when coupled, included); returns the substeps taken. */
  advance(intervalS: number, ball: BallState, gMs2: number): number
  setBall(ball: BallState): void
  clearBall(): void
  readParticleSample(): Promise<ParticleSample | null>
  resetDiagnostics(): void
  readDiagnostics(): Promise<BackendDiagnostics | null>
  /** Test hook: the μ the incompressible viscous solve used at its last run, over the cells it counted full. */
  readViscosityProbe?(): Promise<ViscosityProbe>
  /** S3.6e: the unified pressure–viscosity solve for a ball in a thick liquid — whether it runs, and its last solve's
   *  iterations (null: this backend has none). */
  stokesStatus?(): StokesStatus | null
  /** Tank resize (TANK-RESIZE spec): grid cells per axis (dx fixed); the particles inside the new walls are kept, shifted
   *  by `shiftM` metres first (a −x / −z face moved); the ball is kept when it still fits. Absent: a fixed tank. */
  resize?(cells: Vec3, shiftM?: Vec3): Promise<{ kept: number; removed: number; ballRemoved: boolean }>
  /** The tank's grid cells per axis (a resizable backend). */
  readonly cells?: Vec3
  /** Most particles the tank holds (scales with the cell count). */
  readonly maxParticles?: number
  destroy(): void
}

/** The page's view of the S3.6e solve (FlipBackend.stokesStatus). */
export interface StokesStatus { active: boolean; iterations: number; converged: boolean; cap: number; capHits: number; maxIterations: number }

/** Decode the 80-byte legacy layout (present.wgsl / MpmGpuSimulator): pos 0–2, composition 3 (u32), vel 4–6, C 8–16. */
function decodeLegacy(buf: ArrayBuffer, n: number): ParticleSample {
  const f32 = new Float32Array(buf), u32 = new Uint32Array(buf), W = PRESENT_STRIDE_BYTES / 4
  const positions = new Float32Array(3 * n), velocities = new Float32Array(3 * n), compIds = new Uint32Array(n), affine = new Float32Array(9 * n)
  for (let i = 0; i < n; i++) {
    const o = i * W
    positions.set(f32.subarray(o, o + 3), 3 * i)
    compIds[i] = u32[o + 3]
    velocities.set(f32.subarray(o + 4, o + 7), 3 * i)
    affine.set(f32.subarray(o + 8, o + 17), 9 * i)
  }
  return { positions, velocities, compIds, affine }
}

// ── legacy MLS-MPM ─────────────────────────────────────────────────────────────────────────────────────────────────

export class MpmBackend implements SimBackend {
  readonly kind = 'mpm' as const
  readonly label = 'MLS-MPM (legacy, weakly compressible)'
  readonly method: SolverMethod = 'mpm'
  readonly packing = MPM_PACKING
  readonly supportsBall = true
  private readonly device: GPUDevice
  private readonly sim: MpmGpuSimulator
  private constructor(device: GPUDevice, sim: MpmGpuSimulator) { this.device = device; this.sim = sim }

  static async create(device: GPUDevice): Promise<MpmBackend | null> {
    const sim = new MpmGpuSimulator()
    return (await sim.init(device)) ? new MpmBackend(device, sim) : null
  }

  get particleBuffer() { return this.sim.particleBuffer }
  get particleCount() { return this.sim.particleCount }
  private toGpu(ps: readonly SpawnParticle[]): GpuParticle[] {
    return ps.map(p => ({ pos: p.pos, vel: p.vel, composition_id: p.compositionId, temperature: p.temperatureC, phase: p.phase }))
  }
  setParticles(ps: readonly SpawnParticle[]) { this.sim.spawnParticles(this.toGpu(ps)) }
  addParticles(ps: readonly SpawnParticle[]) { this.sim.addParticles(this.toGpu(ps)) }
  setGravity(gMs2: number) { this.sim.setGravity(accelToCode(gMs2)) }
  setCompositionProps(gpuData: Float32Array) { this.sim.updateCompositionProps(gpuData) }
  setBall(ball: BallState) { this.sim.setSphereObstacle(ball.center, ball.radius, ball.velocity) }
  clearBall() { this.sim.clearSphereObstacle() }

  /** Equal substeps no longer than the verified MPM substep; the ball integrated per substep with one submit per
   *  substep (uniforms are written once per submit) — the pre-S3.1c FluidEngine.macroStep, moved here unchanged. */
  advance(intervalS: number, ball: BallState, gMs2: number): number {
    const sim = this.sim, device = this.device
    const { n, dtCode } = mpmSubsteps(intervalS)
    sim.setTimestep(dtCode)
    if (ball.active) {
      const g = accelToUnitPerTau2(gMs2)
      const lo = ball.radius, hi = 1.0 - ball.radius
      for (let sub = 0; sub < n; sub++) {
        ball.velocity[1] -= g * dtCode
        for (let axis = 0; axis < 3; axis++) ball.center[axis] += ball.velocity[axis] * dtCode
        for (let axis = 0; axis < 3; axis++) {
          if (ball.center[axis] < lo) { ball.center[axis] = lo; ball.velocity[axis] = Math.abs(ball.velocity[axis]) * 0.3 }
          if (ball.center[axis] > hi) { ball.center[axis] = hi; ball.velocity[axis] = -Math.abs(ball.velocity[axis]) * 0.3 }
        }
        sim.setSphereObstacle(ball.center, ball.radius, ball.velocity)
        if (sim.particleCount > 0) {
          const encoder = device.createCommandEncoder()
          sim.step(encoder, 1)
          device.queue.submit([encoder.finish()])
        }
      }
    } else if (sim.particleCount > 0) {
      const encoder = device.createCommandEncoder()
      sim.step(encoder, n)
      device.queue.submit([encoder.finish()])
    }
    return n
  }

  readParticleSample() { return this.sim.readParticleSample() }
  resetDiagnostics() { this.sim.resetDiagnostics() }
  async readDiagnostics(): Promise<BackendDiagnostics | null> { const d = await this.sim.readDiagnostics(); return d ? { clampHits: d.clampHits } : null }
  destroy() { this.sim.destroy() }
}

// ── incompressible APIC-MAC ────────────────────────────────────────────────────────────────────────────────────────

/** Most particles the incompressible window holds (100k is the plan's D3 budget; the buffers take 2× headroom). */
export const FLIP_MAX_PARTICLES = 200_000
/** FINAL-PLAN §5.1: at most 4 equal substeps per 1/60 s macro-step, CFL number C = 1 (Kugelstadt ran at C ≈ 1). */
const FLIP_MAX_SUBSTEPS_PER_60HZ = 4
const FLIP_CFL = 1
/** Largest substep: every S3 physics gate (D1, A1, G1c, F2–F4, …) was verified at Δt = 1/120 s, so the page never runs
 *  coarser. It also keeps Δt constant while a free fall speeds up — a CFL-only count (1 substep at rest, more later)
 *  changes Δt mid-fall and biased the fitted g by 1.5–4 % through the first-order position update (s1-clock G1). */
const FLIP_MAX_DT = 1 / 120

export class FlipBackend implements SimBackend {
  readonly kind = 'flip' as const
  readonly label = 'incompressible APIC-MAC (ghost-fluid surface, variable density, implicit viscosity, immiscible drift)'
  readonly method: SolverMethod = 'incompressible'
  packing: Packing = FLIP_PACKING
  /** Grid cells per axis (TANK-RESIZE: multiples of 8, 16…88, dx fixed at 3.63 m / 64). */
  cells: Vec3 = [GRID_RES, GRID_RES, GRID_RES]
  readonly supportsBall = true
  private readonly dx = DOMAIN_L_M / GRID_RES
  /** The ball: solid iron, NIST SRD 126 (materialData), coupled monolithically (S3.7, Batty et al. 2007 eq. 13: the fluid's
   *  response, added mass included, arrives in the same solve — any density ratio, so iron floats on mercury). Limit
   *  (disclosed): in a viscous liquid the GPU viscous solve holds the ball's faces at its velocity — no skin friction on
   *  the ball yet (flipRef couples V into the viscous solve; spec S3.7 §2). */
  static readonly BALL_DENSITY = SOLID_REFERENCE.iron.solidDensityKgM3!
  /** S3.6: μ per composition id (Pa·s), and the viscous extremes of what is in the tank: the solve runs while the largest
   *  ν = μ/ρ reaches VISCOUS_RUN_NU; the smallest μ fills samples no particle reaches (the harmonic mean's own bias: the
   *  least viscous liquid dominates a mixed sample). */
  private readonly muTable = new Float32Array(256)
  private maxNu = 0
  private minMu = Infinity
  /** The viscous PCG's encoded iteration cap follows the iterations the last solve needed (read back 1–2 frames late,
   *  like v_lag): 2·n + 8 within [16, 200], doubled after a cap hit. A converged solve stops at its tolerance whatever
   *  the cap; the cap only bounds the dispatches the unneeded iterations cost (each returns at entry, ~15 µs apiece —
   *  52 of 60 after an 8-iteration honey solve: ~5 ms per substep, viscCost). Cap hits are counted (diagnostics). */
  private readonly viscSlots: { buf: GPUBuffer; busy: boolean }[]
  static readonly VISC_CAP_MIN = 16
  static readonly VISC_CAP_MAX = 200
  /** S3.6e (spec §5): tolerance 1e-2 moves the A5 fall by ≤ 0.25 % (CPU study); warm solves need a few to ~100 iterations
   *  on the page (a ball entering the lava: jumps from ~5 to ~80 within a frame), a scene's first (cold) one ~110 — the cap
   *  follows the most any of the last 32 solves needed (2·that + 16, doubled on a miss), with a floor of 128: an idle
   *  iteration costs ~20 µs at 64³ (measured), so the floor costs ≤ 2.6 ms per substep and absorbs the jumps. */
  static readonly STOKES_TOL = 1e-2
  static readonly STOKES_CAP_MIN = 128
  static readonly STOKES_CAP_MAX = 800
  private stokesSlots: { buf: GPUBuffer; busy: boolean }[] = []
  private stokesLast: { iterations: number; converged: boolean } = { iterations: 0, converged: true }
  private stokesCapHits = 0
  private stokesMaxIt = 0
  private stokesRecent: number[] = []
  /** S3.5-i immiscible drift flux: the cited liquid of each composition id, the ρ each composition spawned with, and how
   *  many of its particles are in the tank. The drift runs while ≥ 2 liquids with a sourced σ between them are in the
   *  tank; its material slots are the tank's LIQUIDS (temperature variants of one liquid are one miscible slot). */
  private readonly liquidOf: (LiquidKey | null)[] = new Array(256).fill(null)
  private readonly compRho = new Float64Array(256)
  private readonly compCount = new Float64Array(256)
  /** Why the drift is off with immiscible liquids in the tank (null: on, or nothing to separate). */
  private immReason: string | null = null
  /** Bench negative control (s31c-page B1c): the drift is kept off whatever the tank holds. */
  private immDisabled = false
  /** The ball as the GPU left it, read back 1–2 frames late (FINAL-PLAN S3.1c: the mesh uses a late readback, disclosed). */
  private ballLag: { center: Vec3; velocity: Vec3 } | null = null
  private readonly ballSlots: { buf: GPUBuffer; busy: boolean }[]
  private ballEpoch = 0
  private readonly mPerRho: number
  /** Max particle speed (m/s) from the GPU, read back asynchronously 1–2 frames late (FINAL-PLAN §5.1 v_lag). */
  private vLag = 0
  private readonly speedSlots: { buf: GPUBuffer; busy: boolean }[]
  /** Substeps whose lagged max|v|·Δt/dx exceeded C: an accuracy flag, not a crash risk (§5.1). */
  private cflExceeded = 0
  private substepsTotal = 0

  private readonly device: GPUDevice
  private sim: FlipGpuSimulator
  /** The last gravity set (m/s², downward): a rebuilt simulator gets it again. */
  private gMs2 = 0
  private constructor(device: GPUDevice, sim: FlipGpuSimulator) {
    this.device = device; this.sim = sim
    this.mPerRho = this.dx ** 3 / FLIP_PACKING.ppc
    this.speedSlots = [0, 1, 2].map(i => ({ buf: device.createBuffer({ label: `flip.speed${i}`, size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }))
    this.ballSlots = [0, 1, 2].map(i => ({ buf: device.createBuffer({ label: `flip.ball${i}`, size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }))
    this.viscSlots = [0, 1, 2].map(i => ({ buf: device.createBuffer({ label: `flip.visc${i}`, size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }))
    // S3.6e (owner decision 2026-09-29): the unified solve where a ball meets a thick liquid, the split path elsewhere
    this.stokesSlots = [0, 1, 2].map(i => ({ buf: device.createBuffer({ label: `flip.stokes${i}`, size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }))
    FlipBackend.configureSim(sim)
  }
  /** The page's solver settings on a (new) simulator. */
  private static configureSim(sim: FlipGpuSimulator) {
    sim.viscositySolver!.cap = FlipBackend.VISC_CAP_MAX
    sim.viscosityScheme = 'auto'
    sim.stokesSolver!.tol = FlipBackend.STOKES_TOL
    sim.stokesSolver!.cap = FlipBackend.STOKES_CAP_MAX
  }
  /** The particle capacity of a tank: FLIP_MAX_PARTICLES per 64³, scaled with the cell count (TANK-RESIZE budget). */
  static capacityFor(cells: Vec3): number { return Math.round(FLIP_MAX_PARTICLES * cells[0] * cells[1] * cells[2] / GRID_RES ** 3) }
  private static makeSim(device: GPUDevice, cells: Vec3) {
    return FlipGpuSimulator.create(device, {
      nx: cells[0], ny: cells[1], nz: cells[2], dx: DOMAIN_L_M / GRID_RES, gravity: [0, 0, 0],
      maxParticles: FlipBackend.capacityFor(cells), lRef: DOMAIN_L_M, tauS: TAU_S,
      projection: true, density: waterDensity(20), densityProjection: true, freeSurface: 'ghost', variableDensity: true,
      ppc: FLIP_PACKING.ppc, viscosity: true, immiscible: true,
    })
  }

  static async create(device: GPUDevice, cells: Vec3 = [GRID_RES, GRID_RES, GRID_RES]): Promise<FlipBackend> {
    const b = new FlipBackend(device, await FlipBackend.makeSim(device, cells))
    b.cells = [...cells] as Vec3
    b.packing = cells.every(c => c === GRID_RES) ? FLIP_PACKING : flipPacking(cells)
    return b
  }
  get maxParticles(): number { return this.sim.maxParticles }

  /** Tank resize (TANK-RESIZE spec): rebuild the simulator at `cells` (every solver is sized at creation), then the
   *  page's settings, the μ table, the tank's liquids (drift slots), gravity; the particles inside the new walls (after
   *  the shift) with their velocities, affine terms, masses, compositions and temperatures; the ball if it still fits. */
  async resize(cells: Vec3, shiftM: Vec3 = [0, 0, 0]): Promise<{ kept: number; removed: number; ballRemoved: boolean }> {
    if (!cells.every(c => Number.isInteger(c) && c % 8 === 0 && c >= 16 && c <= 88)) throw new RangeError(`tank cells must be multiples of 8 in [16, 88] (got ${cells.join(' × ')})`)
    const old = this.sim
    const state = await old.readParticleState()
    const sphere = old.hasSphere ? await old.readSphere() : null
    const coupling = old.sphereCoupling
    const next = await FlipBackend.makeSim(this.device, cells)
    const ext = cells.map(c => c * this.dx), eps = 1e-6
    const kept = state
      .map(p => ({ ...p, pos: [p.pos[0] + shiftM[0], p.pos[1] + shiftM[1], p.pos[2] + shiftM[2]] as Vec3 }))
      .filter(p => p.pos.every((v, a) => v > eps && v < ext[a] - eps))
      .slice(0, next.maxParticles)
    this.sim = next
    old.destroy()
    this.cells = [...cells] as Vec3
    this.packing = flipPacking(cells)
    FlipBackend.configureSim(next)
    next.viscositySolver!.setMuTable(this.muTable)
    next.gravity = [0, -this.gMs2, 0]
    this.compCount.fill(0)
    for (const p of kept) this.compCount[p.composition]++
    next.setParticles(kept)
    this.vLag = 0
    this.applyViscosity()
    this.applyImmiscible()
    this.stokesLast = { iterations: 0, converged: true }; this.stokesMaxIt = 0; this.stokesRecent = []
    let ballRemoved = false
    if (sphere?.active) {
      const c: Vec3 = [sphere.center[0] + shiftM[0], sphere.center[1] + shiftM[1], sphere.center[2] + shiftM[2]]
      if (c.every((v, a) => v - sphere.radius > 0 && v + sphere.radius < ext[a])) {
        next.setSphere({ center: c, radius: sphere.radius, velocity: sphere.velocity, density: FlipBackend.BALL_DENSITY, coupling })
      } else ballRemoved = true
    }
    this.ballLag = null
    this.ballEpoch++
    this.present()
    return { kept: kept.length, removed: state.length - kept.length, ballRemoved }
  }

  get particleBuffer() { return this.sim.presentationBuffer }
  get particleCount() { return this.sim.particleCount }

  private toInit(ps: readonly SpawnParticle[]) {
    const L = DOMAIN_L_M
    return ps.map(p => ({
      pos: [p.pos[0] * L, p.pos[1] * L, p.pos[2] * L] as Vec3,
      vel: [unitVelToMs(p.vel[0]), unitVelToMs(p.vel[1]), unitVelToMs(p.vel[2])] as Vec3,
      mass: p.rhoKgM3 * this.mPerRho,        // m = ρ·dx³/ppc: V_p = dx³/ppc for every material (§4.1)
      composition: p.compositionId, phase: p.phase, temperatureC: p.temperatureC,
    }))
  }
  /** The presentation buffer is otherwise written only by step(): refresh it so a spawn shows (and reads back) at once. */
  private present() {
    const e = this.device.createCommandEncoder()
    this.sim.writeParams()
    this.sim.encodePresent(e)
    this.device.queue.submit([e.finish()])
  }
  setParticles(ps: readonly SpawnParticle[]) {
    this.maxNu = 0; this.minMu = Infinity; this.compCount.fill(0)
    this.track(ps)
    this.sim.setParticles(this.toInit(ps)); this.vLag = 0; this.present()
    if (this.sim.stokesSolver) { this.sim.stokesSolver.resetWarm(); this.sim.stokesSolver.cap = FlipBackend.STOKES_CAP_MAX; this.stokesLast = { iterations: 0, converged: true }; this.stokesMaxIt = 0; this.stokesRecent = [] }
  }
  addParticles(ps: readonly SpawnParticle[]) {
    const room = FLIP_MAX_PARTICLES - this.sim.particleCount
    if (ps.length > room) throw new RangeError(`the incompressible solver holds at most ${FLIP_MAX_PARTICLES} particles (${room} free); refusing ${ps.length}`)
    this.track(ps)
    this.sim.addParticles(this.toInit(ps)); this.present()
  }
  /** The tank's densest liquid (the ball gate) and viscous extremes (the S3.6 run rule) after a spawn. */
  private track(ps: readonly SpawnParticle[]) {
    for (const p of ps) {
      const mu = this.muTable[p.compositionId]
      if (!(mu > 0)) throw new Error(`composition ${p.compositionId} has no viscosity in the solver's table (spawned before its row was uploaded)`)
      this.maxNu = Math.max(this.maxNu, mu / p.rhoKgM3)
      this.minMu = Math.min(this.minMu, mu)
      this.compCount[p.compositionId]++
      this.compRho[p.compositionId] = p.rhoKgM3
    }
    this.applyViscosity()
    this.applyImmiscible()
  }
  /** Configure (or stop) the drift flux for the liquids now in the tank. Slots: the tank's liquids, ordered by their
   *  lowest composition id (the majority's tie-break, as flipRef's sorted material ids). A liquid present at two
   *  temperatures has two ρ and μ; the model's slot has one, so the drift is off then (disclosed through immReason) —
   *  per-cell slot properties arrive with HEAT-1, where every particle's ρ and μ vary. */
  private applyImmiscible() {
    const sim = this.sim, imm = sim.immiscibleSolver!
    if (this.immDisabled) { this.immReason = 'disabled (bench negative control)'; sim.immiscibleActive = false; return }
    const byLiquid = new Map<LiquidKey, number[]>()
    for (let id = 0; id < 256; id++) {
      if (!(this.compCount[id] > 0)) continue
      const key = this.liquidOf[id]
      if (!key) { this.immReason = `composition ${id} is not a cited liquid`; sim.immiscibleActive = false; return }
      byLiquid.set(key, [...(byLiquid.get(key) ?? []), id])
    }
    const keys = [...byLiquid.keys()]
    const pairs = keys.flatMap((a, i) => keys.slice(i + 1).filter(b => interfacialTension(a, b) !== null))
    this.immReason = null
    if (pairs.length === 0) { sim.immiscibleActive = false; return }   // nothing to separate
    const multi = keys.filter(k => byLiquid.get(k)!.length > 1)
    if (multi.length) { this.immReason = `${multi.join(', ')} at several temperatures: one slot needs one ρ and μ (per-cell slot properties come with HEAT-1)`; sim.immiscibleActive = false; return }
    if (keys.length > IMMISCIBLE_MAX_SLOTS) { this.immReason = `${keys.length} liquids > ${IMMISCIBLE_MAX_SLOTS} drift slots`; sim.immiscibleActive = false; return }
    keys.sort((a, b) => byLiquid.get(a)![0] - byLiquid.get(b)![0])
    imm.configure({
      materials: keys.map(k => { const id = byLiquid.get(k)![0]; return { compositions: [id], rho: this.compRho[id], mu: this.muTable[id] } }),
      sigma: (a, b) => interfacialTension(keys[a], keys[b]), nuNum: INCOMPRESSIBLE_NU_NUM,
    })
    sim.immiscibleActive = true
  }
  setImmiscibleDisabled(v: boolean) { this.immDisabled = v; this.applyImmiscible() }
  setLiquidKeys(keys: readonly (LiquidKey | null)[]) {
    for (let id = 0; id < 256; id++) this.liquidOf[id] = keys[id] ?? null
    this.applyImmiscible()
  }
  /** Whether the immiscible drift flux runs, and why not when liquids that could separate are in the tank. */
  get immiscibleDrift(): { active: boolean; reason: string | null } { return { active: this.sim.immiscibleActive, reason: this.immReason } }
  private applyViscosity() {
    const vs = this.sim.viscositySolver!
    this.sim.viscosityActive = this.maxNu >= VISCOUS_RUN_NU
    if (Number.isFinite(this.minMu)) vs.muDefault = this.minMu
  }
  setGravity(gMs2: number) { this.gMs2 = gMs2; this.sim.gravity = [0, -gMs2, 0] }
  setCompositionProps() { /* masses carry each material's density (toInit); μ comes through setViscosities */ }
  setViscosities(muPaS: Float32Array) {
    this.muTable.set(muPaS.subarray(0, this.muTable.length))
    this.sim.viscositySolver!.setMuTable(this.muTable)
  }
  /** Whether the implicit viscous solve is running (a liquid with ν ≥ VISCOUS_RUN_NU is in the tank). */
  get viscousSolve(): boolean { return this.sim.viscosityActive }
  async readViscosityProbe(): Promise<ViscosityProbe> {
    if (!this.sim.viscosityActive) return { active: false, fullCells: 0, muMin: NaN, muMax: NaN, distinct: [] }
    const vs = this.sim.viscositySolver!, pc = this.sim.solver!.paddedCount
    const w = new Float32Array(await this.sim.readBuffer(vs.bufs.wCell, 4 * pc))
    const v = new Float32Array(await this.sim.readBuffer(vs.bufs.volCell, 4 * pc))
    let n = 0, lo = Infinity, hi = -Infinity
    const seen = new Set<number>()
    for (let i = 0; i < pc; i++) {
      if (v[i] < 0.999) continue
      const mu = Math.fround(w[i] / (2 * v[i]))
      n++; lo = Math.min(lo, mu); hi = Math.max(hi, mu)
      if (seen.size < 16) seen.add(mu)
    }
    return { active: true, fullCells: n, muMin: lo, muMax: hi, distinct: [...seen].sort((a, b) => a - b) }
  }
  stokesStatus(): StokesStatus | null {
    const sk = this.sim.stokesSolver
    if (!sk) return null
    return { active: this.sim.stokesRuns, iterations: this.stokesLast.iterations, converged: this.stokesLast.converged, cap: sk.cap, capHits: this.stokesCapHits, maxIterations: this.stokesMaxIt }
  }
  /** The monolithic coupling takes any liquid (S3.7) — nothing refuses the ball any more. */
  ballRefusal(): string | null { return null }
  /** Place the ball (world units → window metres, velocity per τ → m/s): an iron sphere, monolithically coupled. */
  setBall(ball: BallState) {
    const L = DOMAIN_L_M
    this.sim.setSphere({
      center: [ball.center[0] * L, ball.center[1] * L, ball.center[2] * L], radius: ball.radius * L,
      velocity: [unitVelToMs(ball.velocity[0]), unitVelToMs(ball.velocity[1]), unitVelToMs(ball.velocity[2])], density: FlipBackend.BALL_DENSITY,
      coupling: 'monolithic',
    })
    this.ballLag = null
    this.ballEpoch++
  }
  clearBall() { if (this.sim.hasSphere) this.sim.clearSphere(); this.ballLag = null; this.ballEpoch++ }

  /** FINAL-PLAN §5.1: n = ⌈T·(1.25·v_lag + g·T)/(C·dx)⌉ equal substeps of T/n, at least ⌈T/Δt_max⌉ (FLIP_MAX_DT), at most
   *  4 per 1/60 s of T. */
  advance(intervalS: number, ball: BallState, gMs2: number): number {
    const T = intervalS
    // the ball moves through the grid too: its lagged speed enters the count like the particles' (a ball falling
    // through air has no particles near it, and a jump of more than dx per substep would throw them a cell on push-out)
    const vBall = ball.active && this.ballLag ? Math.hypot(...this.ballLag.velocity) : 0
    const vEff = Math.max(this.vLag, vBall)
    const cfl = Math.ceil(T * (1.25 * vEff + Math.abs(gMs2) * T) / (FLIP_CFL * this.dx) - 1e-9)
    const nMax = FLIP_MAX_SUBSTEPS_PER_60HZ * Math.max(1, Math.ceil(T * 60 - 1e-9))
    const n = Math.min(nMax, Math.max(1, Math.ceil(T / FLIP_MAX_DT - 1e-9), cfl))
    const dt = T / n
    if (vEff * dt / this.dx > FLIP_CFL) this.cflExceeded += n
    this.substepsTotal += n
    if (this.sim.particleCount === 0) return n
    this.sim.dt = dt
    const q = this.device.queue
    q.writeBuffer(this.sim.diagBuf, 28, new Uint32Array([0]))   // DIAG_MAX_SPEED: this macro-step's maximum
    const e = this.device.createCommandEncoder()
    this.sim.step(e, n)
    const slot = this.speedSlots.find(s => !s.busy)
    if (slot) e.copyBufferToBuffer(this.sim.diagBuf, 28, slot.buf, 0, 4)
    const bslot = ball.active && this.sim.hasSphere ? this.ballSlots.find(s => !s.busy) : undefined
    if (bslot) e.copyBufferToBuffer(this.sim.sphereBuf, 0, bslot.buf, 0, 64)
    const vs = this.sim.viscositySolver!
    const vslot = this.sim.viscosityActive && !this.sim.stokesRuns ? this.viscSlots.find(s => !s.busy) : undefined
    if (vslot) e.copyBufferToBuffer(vs.bufs.st, 0, vslot.buf, 0, 32)
    const sk = this.sim.stokesSolver
    const sslot = sk && this.sim.stokesRuns ? this.stokesSlots.find(s => !s.busy) : undefined
    if (sslot) e.copyBufferToBuffer(sk!.bufs.st, 0, sslot.buf, 0, 64)
    q.submit([e.finish()])
    if (sslot) {
      sslot.busy = true
      sslot.buf.mapAsync(GPUMapMode.READ).then(() => {
        const st = new Float32Array(sslot.buf.getMappedRange().slice(0))
        sslot.buf.unmap()
        sslot.busy = false
        const it = st[5], converged = st[4] > 0.5
        this.stokesLast = { iterations: it, converged }
        this.stokesMaxIt = Math.max(this.stokesMaxIt, it)
        this.stokesRecent.push(it)
        if (this.stokesRecent.length > 32) this.stokesRecent.shift()
        if (!converged) this.stokesCapHits++
        sk!.cap = converged ? Math.min(FlipBackend.STOKES_CAP_MAX, Math.max(FlipBackend.STOKES_CAP_MIN, 2 * Math.max(...this.stokesRecent) + 16)) : Math.min(FlipBackend.STOKES_CAP_MAX, 2 * sk!.cap)
      }, () => { sslot.busy = false })
    }
    if (vslot) {
      vslot.busy = true
      vslot.buf.mapAsync(GPUMapMode.READ).then(() => {
        const st = new Float32Array(vslot.buf.getMappedRange().slice(0))
        vslot.buf.unmap()
        vslot.busy = false
        const it = st[5], converged = st[4] > 0.5
        vs.cap = converged ? Math.min(FlipBackend.VISC_CAP_MAX, Math.max(FlipBackend.VISC_CAP_MIN, 2 * it + 8)) : Math.min(FlipBackend.VISC_CAP_MAX, 2 * vs.cap)
      }, () => { vslot.busy = false })
    }
    if (bslot) {
      bslot.busy = true
      const epoch = this.ballEpoch
      bslot.buf.mapAsync(GPUMapMode.READ).then(() => {
        const w = new Float32Array(bslot.buf.getMappedRange().slice(0))
        bslot.buf.unmap()
        bslot.busy = false
        if (epoch !== this.ballEpoch || !ball.active) return   // the ball was replaced or removed meanwhile
        const L = DOMAIN_L_M
        this.ballLag = { center: [w[0], w[1], w[2]], velocity: [w[4], w[5], w[6]] }
        for (let a = 0; a < 3; a++) { ball.center[a] = w[a] / L; ball.velocity[a] = w[4 + a] * TAU_S / L }
      }, () => { bslot.busy = false })
    }
    if (slot) {
      slot.busy = true
      slot.buf.mapAsync(GPUMapMode.READ).then(() => {
        this.vLag = new Float32Array(slot.buf.getMappedRange().slice(0))[0]
        slot.buf.unmap()
        slot.busy = false
      }, () => { slot.busy = false })
    }
    return n
  }

  async readParticleSample(): Promise<ParticleSample | null> {
    const n = this.sim.particleCount
    if (n === 0) return null
    try {
      const s = decodeLegacy(await this.sim.readBuffer(this.sim.presentationBuffer, PRESENT_STRIDE_BYTES * n), n)
      if (this.sim.immiscibleActive) s.drift = new Float32Array(await this.sim.readBuffer(this.sim.immiscibleSolver!.bufs.slipState, 16 * n))
      return s
    } catch { return null }
  }
  resetDiagnostics() { this.sim.resetDiagnostics(); this.sim.viscositySolver!.resetFaults(); this.cflExceeded = 0; this.substepsTotal = 0 }
  async readDiagnostics(): Promise<BackendDiagnostics | null> {
    const d = await this.sim.readDiagnostics()
    const vf = await this.sim.viscositySolver!.readFaults()
    const im = this.sim.immiscibleActive ? await this.sim.immiscibleSolver!.readStats() : null
    return {
      immiscibleDrift: im ? 1 : 0, immDispersed: im?.dispersed ?? 0, immTooLarge: im?.tooLarge ?? 0, immMaxSlip: im?.maxSlip ?? 0, immMeanDrop: im?.meanDrop ?? 0,
      viscousSolves: vf.solves, viscousCapHits: vf.capHits, viscousBreakdowns: vf.breakdowns, viscousMaxIterations: vf.maxIterations, viscousCap: this.sim.viscositySolver!.cap,
      clampHits: d.wallClamps, densityPushBacks: d.densityClamps, unsetFaceReads: d.unsetFaceReads,
      pressureSolves: d.solves, pressureCapHits: d.capHits, psiSolves: d.psiSolves, psiCapHits: d.psiCapHits,
      breakdowns: d.breakdowns + d.psiBreakdowns, densityNeighbourFaces: d.densityNeighbourFaces, densityDefaultFaces: d.densityDefaultFaces,
      vLag: this.vLag, cflExceeded: this.cflExceeded, substeps: this.substepsTotal,
      viscousSolve: this.sim.viscosityActive ? 1 : 0, maxNu: this.maxNu,
    }
  }
  destroy() { this.sim.destroy(); for (const s of [...this.speedSlots, ...this.ballSlots, ...this.viscSlots, ...this.stokesSlots]) s.buf.destroy() }
}

/** The solver for this page: `?solver=mpm` keeps the legacy MLS-MPM (D8); default the incompressible solver. */
export function solverFromUrl(): SolverKind {
  try { return new URLSearchParams(globalThis.location?.search ?? '').get('solver') === 'mpm' ? 'mpm' : 'flip' } catch { return 'flip' }
}
