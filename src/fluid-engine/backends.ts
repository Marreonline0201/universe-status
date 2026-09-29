// backends.ts — the solver behind FluidEngine (FINAL-PLAN S3.1c): the legacy MLS-MPM (kept behind ?solver=mpm, owner
// decision D8) or the incompressible APIC-MAC solver (S3.0–S3.5: MGPCG pressure, Kugelstadt density projection,
// ghost-fluid free surface, per-face variable density). Both present particles in the same legacy 80-byte layout in
// world units (tank-normalised [0,1]³ of the 64³ grid, velocities per τ), so the renderer and every consumer are
// unchanged; each backend converts to its own solver units here and nowhere else.
import { MpmGpuSimulator, type GpuParticle } from '../gpu-sim/MpmGpuSimulator'
import { FlipGpuSimulator, PRESENT_STRIDE_BYTES } from '../gpu-sim/flip/FlipGpuSimulator'
import type { SolverMethod } from '../composition/CompositionTable'
import { DOMAIN_L_M, GRID_RES, TAU_S, accelToCode, accelToUnitPerTau2, mpmSubsteps, unitVelToMs } from './units'
import { FLIP_PACKING, MPM_PACKING, type Packing, type Vec3 } from './spawn'
import { waterDensity } from '../composition/materialData'

export type SolverKind = 'mpm' | 'flip'

/** One particle to spawn, in world units; ρ is the material's density at its spawn temperature (kg/m³). */
export interface SpawnParticle { pos: Vec3; vel: Vec3; compositionId: number; temperatureC: number; phase: number; rhoKgM3: number }

export interface ParticleSample { positions: Float32Array; velocities: Float32Array; compIds: Uint32Array; affine: Float32Array }

/** The drop-ball obstacle, world units (velocity per τ). Mutated in place by a backend that integrates it. */
export interface BallState { active: boolean; radius: number; center: Vec3; velocity: Vec3 }

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
  /** The 80-byte legacy particle layout the renderer reads. */
  readonly particleBuffer: GPUBuffer
  readonly particleCount: number
  setParticles(ps: readonly SpawnParticle[]): void
  addParticles(ps: readonly SpawnParticle[]): void
  setGravity(gMs2: number): void
  setCompositionProps(gpuData: Float32Array): void
  /** Advance `intervalS` of sim time (the ball, when coupled, included); returns the substeps taken. */
  advance(intervalS: number, ball: BallState, gMs2: number): number
  setBall(ball: BallState): void
  clearBall(): void
  readParticleSample(): Promise<ParticleSample | null>
  resetDiagnostics(): void
  readDiagnostics(): Promise<BackendDiagnostics | null>
  destroy(): void
}

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
  private constructor(private readonly device: GPUDevice, private readonly sim: MpmGpuSimulator) {}

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
  readonly label = 'incompressible APIC-MAC (ghost-fluid surface, variable density)'
  readonly method: SolverMethod = 'incompressible'
  readonly packing = FLIP_PACKING
  readonly supportsBall = false
  private readonly dx = DOMAIN_L_M / GRID_RES
  private readonly mPerRho: number
  /** Max particle speed (m/s) from the GPU, read back asynchronously 1–2 frames late (FINAL-PLAN §5.1 v_lag). */
  private vLag = 0
  private readonly speedSlots: { buf: GPUBuffer; busy: boolean }[]
  /** Substeps whose lagged max|v|·Δt/dx exceeded C: an accuracy flag, not a crash risk (§5.1). */
  private cflExceeded = 0
  private substepsTotal = 0

  private constructor(private readonly device: GPUDevice, private readonly sim: FlipGpuSimulator) {
    this.mPerRho = this.dx ** 3 / FLIP_PACKING.ppc
    this.speedSlots = [0, 1, 2].map(i => ({ buf: device.createBuffer({ label: `flip.speed${i}`, size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }))
  }

  static async create(device: GPUDevice): Promise<FlipBackend> {
    const sim = await FlipGpuSimulator.create(device, {
      nx: GRID_RES, ny: GRID_RES, nz: GRID_RES, dx: DOMAIN_L_M / GRID_RES, gravity: [0, 0, 0],
      maxParticles: FLIP_MAX_PARTICLES, lRef: DOMAIN_L_M, tauS: TAU_S,
      projection: true, density: waterDensity(20), densityProjection: true, freeSurface: 'ghost', variableDensity: true,
      ppc: FLIP_PACKING.ppc,
    })
    return new FlipBackend(device, sim)
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
  setParticles(ps: readonly SpawnParticle[]) { this.sim.setParticles(this.toInit(ps)); this.vLag = 0; this.present() }
  addParticles(ps: readonly SpawnParticle[]) {
    const room = FLIP_MAX_PARTICLES - this.sim.particleCount
    if (ps.length > room) throw new RangeError(`the incompressible solver holds at most ${FLIP_MAX_PARTICLES} particles (${room} free); refusing ${ps.length}`)
    this.sim.addParticles(this.toInit(ps)); this.present()
  }
  setGravity(gMs2: number) { this.sim.gravity = [0, -gMs2, 0] }
  setCompositionProps() { /* masses carry each material's density; viscosity is not simulated until S3.6 */ }
  setBall() { /* not coupled until S3.1c-2 (supportsBall = false) */ }
  clearBall() { /* nothing coupled */ }

  /** FINAL-PLAN §5.1: n = ⌈T·(1.25·v_lag + g·T)/(C·dx)⌉ equal substeps of T/n, at least ⌈T/Δt_max⌉ (FLIP_MAX_DT), at most
   *  4 per 1/60 s of T. */
  advance(intervalS: number, _ball: BallState, gMs2: number): number {
    const T = intervalS
    const cfl = Math.ceil(T * (1.25 * this.vLag + Math.abs(gMs2) * T) / (FLIP_CFL * this.dx) - 1e-9)
    const nMax = FLIP_MAX_SUBSTEPS_PER_60HZ * Math.max(1, Math.ceil(T * 60 - 1e-9))
    const n = Math.min(nMax, Math.max(1, Math.ceil(T / FLIP_MAX_DT - 1e-9), cfl))
    const dt = T / n
    if (this.vLag * dt / this.dx > FLIP_CFL) this.cflExceeded += n
    this.substepsTotal += n
    if (this.sim.particleCount === 0) return n
    this.sim.dt = dt
    const q = this.device.queue
    q.writeBuffer(this.sim.diagBuf, 28, new Uint32Array([0]))   // DIAG_MAX_SPEED: this macro-step's maximum
    const e = this.device.createCommandEncoder()
    this.sim.step(e, n)
    const slot = this.speedSlots.find(s => !s.busy)
    if (slot) e.copyBufferToBuffer(this.sim.diagBuf, 28, slot.buf, 0, 4)
    q.submit([e.finish()])
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
    try { return decodeLegacy(await this.sim.readBuffer(this.sim.presentationBuffer, PRESENT_STRIDE_BYTES * n), n) } catch { return null }
  }
  resetDiagnostics() { this.sim.resetDiagnostics(); this.cflExceeded = 0; this.substepsTotal = 0 }
  async readDiagnostics(): Promise<BackendDiagnostics | null> {
    const d = await this.sim.readDiagnostics()
    return {
      clampHits: d.wallClamps, densityPushBacks: d.densityClamps, unsetFaceReads: d.unsetFaceReads,
      pressureSolves: d.solves, pressureCapHits: d.capHits, psiSolves: d.psiSolves, psiCapHits: d.psiCapHits,
      breakdowns: d.breakdowns + d.psiBreakdowns, densityNeighbourFaces: d.densityNeighbourFaces, densityDefaultFaces: d.densityDefaultFaces,
      vLag: this.vLag, cflExceeded: this.cflExceeded, substeps: this.substepsTotal,
    }
  }
  destroy() { this.sim.destroy(); for (const s of this.speedSlots) s.buf.destroy() }
}

/** The solver for this page: `?solver=mpm` keeps the legacy MLS-MPM (D8); default the incompressible solver. */
export function solverFromUrl(): SolverKind {
  try { return new URLSearchParams(globalThis.location?.search ?? '').get('solver') === 'mpm' ? 'mpm' : 'flip' } catch { return 'flip' }
}
