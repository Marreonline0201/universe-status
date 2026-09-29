// FluidEngine — the ONE fluid engine behind both the FLUID TEST and LABORATORY pages.
// A plain (non-React) class: WebGPU device + three.js scene, the solver backend (src/fluid-engine/backends.ts: the
// incompressible APIC-MAC solver by default since S3.1c, the legacy MLS-MPM behind ?solver=mpm), the SSFR renderer, the
// drop-ball obstacle, spawning, and the per-frame loop. The pages keep only their UI. (Before 2026-09-28 FluidTest.tsx carried its own inline copy of this loop; they were
// unified so every physics change lands once. Parity with the old FLUID TEST loop was gated
// bit-identically by scripts/fluid-parity.mjs.)
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { FlipBackend, MpmBackend, solverFromUrl, type BallState, type SimBackend, type SolverKind, type SpawnParticle } from './backends'
import { FluidScene } from '../fluid-render/FluidScene'
import { SSFRPipeline, type ProbeOptions, type ProbeResultWithCamera } from '../fluid-render/SSFRPipeline'
import { opticsRenderData } from '../fluid-render/optics/materials'
import { BG_BASE, clampBrightness, readBgBrightness } from '../fluid-render/bgBrightness'
import { CompositionTable, type NamedComposition } from '../composition/CompositionTable'
import type { MenuEntry } from '../composition/liquidGate'
import type { ElementName } from '../composition/PropertyCalculator'
import { isLiquidKey, type LiquidKey } from '../composition/materialData'
import { elementsAs, type LabScenario } from '../lab/scenario'
import type { BenchTarget } from '../bench/benchHook'
import { DOMAIN_L_M, GRID_RES, G_STANDARD, MACRO_DT_S, msToUnitVel } from './units'
import { PresentationClock } from './clock'
import { buildOccupancy, cellKey, cubeForCount, latticeBox, type Vec3 } from './spawn'
import { scenarioGravityMs2 } from '../lab/scenario'

const DEFAULT_BALL_RADIUS = 0.1   // ~6 grid cells in MLS-MPM [0,1] space

export type ClockMode = 'realtime' | 'lockstep'

export interface FluidStats {
  fps: number
  count: number
  /** Sim seconds advanced per wall second over the last ~2 s (1.0 = real time). */
  rtFactor: number
}

/** One motion-metrics sample from a GPU particle readback (sim [0,1]³ coords). */
export interface FluidMetricsSample {
  count: number
  meanSpeed: number
  meanY: number
  maxY: number
  spreadX: [number, number]
  spreadZ: [number, number]
  materials: {
    id: number; name: string; count: number
    meanSpeed: number; meanY: number; maxY: number; comX: number; comZ: number
  }[]
}

/** A message for the page: a spawn/scene the material gates refused (with the physical reason),
 *  or a warning they raised. */
export interface FluidNotice { kind: 'refused' | 'warning'; text: string }

/** Result of loading a scenario through the material gates. */
export type ScenarioLoad = { ok: true; warnings: string[] } | { ok: false; reason: string }

export interface FluidEngineOptions {
  /** 'default-water' spawns FLUID TEST's 10k-particle water block at init and on reset. */
  initialScene?: 'default-water' | 'empty'
  /** Solver: 'flip' (incompressible, default) or 'mpm' (legacy); default from the URL (?solver=mpm). */
  solver?: SolverKind
}

export class FluidEngine {
  private destroyed = false
  private renderer: any = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private controls: OrbitControls | null = null
  private device: GPUDevice | null = null
  private sim: SimBackend | null = null
  private fluidScene: FluidScene | null = null
  private ssfrPipeline: SSFRPipeline | null = null
  private sphereMesh: THREE.Mesh | null = null
  private ball: BallState = { active: false, radius: DEFAULT_BALL_RADIUS, center: [0.5, 0.9, 0.5], velocity: [0, 0, 0] }
  // The composition table is persistent (starts with defaults) so the material picker and
  // manual spawns work before/independently of a scenario.
  private compositionTable = new CompositionTable()
  private selectedComposition = 0
  private spawnTemperature = 20
  private lastScenario: LabScenario | null = null
  private glassBox: THREE.Mesh | null = null
  private raycaster = new THREE.Raycaster()
  private gravityMs2 = G_STANDARD   // downward gravity magnitude, m/s²
  private currentBgBrightness = readBgBrightness()
  private animId = 0
  private fpsAccum = 0
  private fpsFrames = 0
  private lastFps = 0
  private frameCount = 0
  // ── Clock ── each presented frame advances the sim by its own vsync-snapped interval
  // (PresentationClock, src/fluid-engine/clock.ts): real time, uniform motion, ~60 Hz presentation
  // on any panel. Lockstep benches advance exactly `lockstepDt` per callback instead.
  private clockMode: ClockMode = 'realtime'
  private lockstepDt = MACRO_DT_S   // lockstep (bench): sim seconds advanced per presented frame
  private clock = new PresentationClock()
  private lastPresentTs = 0         // rAF timestamp of the last presented frame
  private simTime = 0               // sim seconds since the last scene load
  private droppedTime = 0           // realtime: wall seconds not simulated (time dilation)
  private substepsTotal = 0
  private particleSubsteps = 0      // Σ particles × substeps since the last diagnostics reset
  private steppedFrames = 0         // frames that advanced the sim since the last scene load (bench clock)
  private stepLimit = Infinity      // bench: freeze the sim after this many advancing frames
  private ssfrDrewLastFrame = false  // render path of the previous presented frame
  private forceSsfrFailure = false   // bench: exercise the Points fallback
  private pointsReadbacks = 0
  private frameAdvances: number[] = []  // realtime: sim ms advanced per presented frame (last 600)
  private rtSamples: { wall: number; sim: number }[] = []
  private presentIntervals: number[] = []
  private gpuErrors = 0             // uncaptured WebGPU errors on this engine's device
  private sceneGeneration = 0       // bumped on every scene load; in-flight spawns then abort
  private spawnChain: Promise<unknown> = Promise.resolve()   // spawns run one at a time
  private sceneIds = new Set<number>()   // compositions currently in the tank (for the pairwise thermal gate)
  /** Page hook for refusals/warnings from the material gates. Called with null when a new spawn or scenario
   *  load starts, so what the page shows always describes the latest action. */
  onNotice: ((n: FluidNotice | null) => void) | null = null
  /** Reason of the most recent refusal (for callers that report it themselves, e.g. the AI chat). */
  lastRefusal: string | null = null
  private resizeObserver: ResizeObserver | null = null

  private container: HTMLDivElement
  private onStats: (s: FluidStats) => void
  private options: Required<FluidEngineOptions>

  constructor(container: HTMLDivElement, onStats: (s: FluidStats) => void, options: FluidEngineOptions = {}) {
    this.container = container
    this.onStats = onStats
    this.options = { initialScene: options.initialScene ?? 'empty', solver: options.solver ?? solverFromUrl() }
  }

  /** Which solver runs this page, and its HUD name. */
  get solverKind(): SolverKind { return this.options.solver }
  get solverLabel(): string { return this.sim?.label ?? '' }
  /** Material-gate method of the running solver. */
  private get method() { return this.sim?.method ?? (this.options.solver === 'mpm' ? 'mpm' : 'incompressible') }
  private get packing() { return this.sim!.packing }
  /** Scenario metres (from the tank's inner corner) → world units, for the running solver's tank. */
  private tankToUnit(m: number) { return this.packing.tankOrigin + m / DOMAIN_L_M }
  /** Particles of one composition for the backend: its density at the spawn state gives the incompressible solver
   *  each particle's mass (ρ·dx³/ppc); the legacy MPM ignores it. */
  private particlesOf(positions: readonly Vec3[], vel: Vec3, compId: number, temperatureC: number, phase: number): SpawnParticle[] {
    const rho = this.compositionTable.getSolverProps(compId).rhoKgM3
    return positions.map(pos => ({ pos, vel: [...vel] as Vec3, compositionId: compId, temperatureC, phase, rhoKgM3: rho }))
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) return false

    const scene = new THREE.Scene()
    // Base olive × the persisted brightness preference (fallback/no-particle paint path).
    const bb = this.currentBgBrightness
    scene.background = new THREE.Color(BG_BASE.r * bb, BG_BASE.g * bb, BG_BASE.b * bb)
    const camera = new THREE.PerspectiveCamera(50, this.container.clientWidth / this.container.clientHeight, 0.1, 50)
    camera.position.set(2.0, 1.5, 2.0)
    camera.lookAt(0.5, 0.5, 0.5)

    const renderer = new (THREE as any).WebGPURenderer({ antialias: true })
    await renderer.init()
    if (this.destroyed) { renderer.dispose(); return false }
    renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    this.container.appendChild(renderer.domElement)

    const device: GPUDevice = renderer.backend.device
    if (!device) return false

    const sim: SimBackend | null = this.options.solver === 'mpm' ? await MpmBackend.create(device) : await FlipBackend.create(device)
    if (!sim || this.destroyed) return false

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0.5, 0.5, 0.5)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 1.0
    controls.maxDistance = 8

    // Lighting + tank furniture
    scene.add(new THREE.AmbientLight(0x334466, 0.6))
    const directLight = new THREE.DirectionalLight(0xffffff, 1.0)
    directLight.position.set(3, 5, 3)
    scene.add(directLight)
    const pointLight = new THREE.PointLight(0x00aaff, 0.4, 10)
    pointLight.position.set(-2, 2, -2)
    scene.add(pointLight)

    const boxGeo = new THREE.BoxGeometry(1, 1, 1)
    const boxMesh = new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({ color: 0x00bbff, transparent: true, opacity: 0.35 }),
    )
    boxMesh.position.set(0.5, 0.5, 0.5)
    scene.add(boxMesh)

    const glassBox = new THREE.Mesh(boxGeo, new THREE.MeshPhysicalMaterial({
      color: 0x88ccff, transparent: true, opacity: 0.06, roughness: 0.05, metalness: 0.0, side: THREE.DoubleSide,
    }))
    glassBox.position.set(0.5, 0.5, 0.5)
    scene.add(glassBox)

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.98, 0.98, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.4 }),
    )
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.set(0.5, 0.001, 0.5)
    scene.add(floorMesh)

    const wallMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.98, 0.98, 20, 15),
      new THREE.MeshBasicMaterial({ color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    )
    wallMesh.position.set(0.5, 0.5, 0.001)
    scene.add(wallMesh)

    const sideMat = new THREE.MeshBasicMaterial({ color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    const sideGeo = new THREE.PlaneGeometry(0.98, 0.98, 15, 15)
    for (const x of [0.001, 0.999]) {
      const side = new THREE.Mesh(sideGeo, sideMat)
      side.rotation.y = Math.PI / 2
      side.position.set(x, 0.5, 0.5)
      scene.add(side)
    }

    const sphereMesh = new THREE.Mesh(
      new THREE.SphereGeometry(DEFAULT_BALL_RADIUS, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.95, roughness: 0.15 }),
    )
    sphereMesh.visible = false
    scene.add(sphereMesh)

    const fluidScene = new FluidScene(scene)
    fluidScene.init(device)

    let ssfrPipeline: SSFRPipeline | null = null
    try {
      // Particle rest volume from the solver's packing (world unit = grid edge); metres per world unit from units.ts.
      const ssfr = new SSFRPipeline({
        particleVolume: 1 / (GRID_RES ** 3 * sim.packing.ppc), metresPerUnit: DOMAIN_L_M,
        blurRadius: 10, blurDepthFalloff: 40.0,
      })
      await ssfr.init(device, this.container.clientWidth, this.container.clientHeight)
      if (this.destroyed) return false
      ssfr.setBgBrightness(bb) // persisted background brightness
      ssfrPipeline = ssfr
    } catch (e) {
      console.warn('[fluid] SSFR init failed, using Points fallback:', e)
    }

    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.controls = controls
    this.device = device
    this.sim = sim
    this.fluidScene = fluidScene
    this.ssfrPipeline = ssfrPipeline
    this.sphereMesh = sphereMesh
    this.glassBox = glassBox
    // Validation/OOM errors that nothing else catches: counted (bench gates require 0) and logged.
    device.addEventListener('uncapturederror', (e: Event) => {
      this.gpuErrors++
      console.error('[fluid GPU error]', (e as GPUUncapturedErrorEvent).error?.message)
    })
    sim.setGravity(this.gravityMs2)

    this.compositionTable.addDefaults()
    this.uploadCompositions()

    if (this.options.initialScene === 'default-water') this.loadDefaultScene()

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.camera || !this.renderer) return
      const w = this.container.clientWidth
      const h = this.container.clientHeight
      if (w === 0 || h === 0) return
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(w, h)
      this.ssfrPipeline?.resize(w, h)   // CSS size, capped at 1280×800-equivalent inside (ED-2)
    })
    this.resizeObserver.observe(this.container)

    this.animId = requestAnimationFrame(this.animate)
    return true
  }

  private uploadCompositions() {
    this.sim?.setCompositionProps(this.compositionTable.getGpuData())
    this.sim?.setViscosities?.(this.compositionTable.getViscosityData())
    this.sim?.setLiquidKeys?.(this.compositionTable.getAll().map((c): LiquidKey | null => (isLiquidKey(c.materialKey) ? c.materialKey : null)))
    this.ssfrPipeline?.updateMaterialProps(opticsRenderData(this.compositionTable.getAll()))
  }

  /** FLUID TEST's default scene: a ~0.77 m block of water (≈10k particles at rest packing)
   *  released in the middle of the tank. */
  loadDefaultScene() {
    if (!this.sim || this.destroyed) return
    this.lastScenario = null
    const { lo, size } = cubeForCount([0.5, 0.5, 0.5], 10000, this.packing)
    const block = latticeBox(lo, size, { packing: this.packing })
    this.sim.setParticles(this.particlesOf(block.positions, [0, 0, 0], 0, 20, 1))
    this.sceneIds = new Set([0])
    this.resetClock()
    this.uploadCompositions()
  }

  private notify(kind: FluidNotice['kind'], text: string) {
    if (kind === 'refused') this.lastRefusal = text
    this.onNotice?.({ kind, text })
  }

  /** Material gates for one spawn: the id to spawn `baseId` at `tempC` (a fixed-temperature preset such as
   *  honey uses its single sourced temperature), the per-material gates (phase, sourced data, the legacy
   *  solver's explicit-viscosity limit) and the pairwise thermal gate against what is already in the tank. */
  private resolveSpawn(baseId: number, tempC: number): { ok: true; id: number; tempC: number } | { ok: false; reason: string } {
    const table = this.compositionTable
    if (!table.get(baseId)) return { ok: false, reason: `unknown material id ${baseId}` }
    const range = table.menuVisibility(baseId, this.method, tempC).dataRangeC
    const t = range && range[0] === range[1] ? range[0] : tempC
    const before = table.count
    const sid = table.spawnIdAt(baseId, t, this.method)
    if (table.count !== before) this.uploadCompositions()      // a new temperature row was registered
    if (!sid.ok) return sid
    const chk = table.checkSpawn(sid.id, { method: this.method, scene: [...this.sceneIds].map(id => ({ id })) })
    if (!chk.ok) return { ok: false, reason: chk.reason }
    for (const w of chk.warnings) this.notify('warning', w)
    return { ok: true, id: sid.id, tempC: t }
  }

  /** Spawn through the gates; a refusal is reported (never clamped, never silently swapped for water). */
  private gatedSpawn(baseId: number, tempC: number, block: () => { lo: Vec3; size: Vec3 }): Promise<number> {
    this.onNotice?.(null)
    const g = this.resolveSpawn(baseId, tempC)
    if (!g.ok) { this.notify('refused', g.reason); return Promise.resolve(0) }
    return this.enqueueSpawn(block, g.id, g.tempC, 1)
  }

  /** Material menu for the control panel, evaluated at the temperature a spawn would really use — the
   *  slider temperature, or a fixed-temperature preset's single sourced point (as resolveSpawn does), so
   *  the menu never marks refused what a click would spawn. Hidden entries removed. */
  getMenuEntries(tempC = this.spawnTemperature): MenuEntry[] {
    const table = this.compositionTable
    return table.getMenuEntries(this.method, tempC)
      .map(e => (e.dataRangeC && e.dataRangeC[0] === e.dataRangeC[1] && e.dataRangeC[0] !== tempC
        ? table.menuVisibility(e.id, this.method, e.dataRangeC[0]) : e))
      .filter(e => e.visibility !== 'hidden')
  }

  /** Cells currently holding fluid, from a fresh GPU readback (spawns must not overlap them). */
  private async occupancyNow(): Promise<Set<number>> {
    const s = await this.readParticleSample()
    return s ? buildOccupancy(s.positions) : new Set()
  }

  /** Queue a spawn: spawns run strictly one after another, each reading occupancy only after the
   *  previous block was added (two quick clicks can never stack blocks into each other); the
   *  material, temperature and RNG are captured NOW (benches seed Math.random only around the
   *  synchronous part of a call); a scene change while waiting cancels the spawn. */
  private enqueueSpawn(block: () => { lo: Vec3; size: Vec3 }, compId: number, temperature: number, phase: number): Promise<number> {
    const rng = Math.random
    const generation = this.sceneGeneration
    const run = async () => {
      const occupied = await this.occupancyNow()
      if (this.destroyed || generation !== this.sceneGeneration) return 0
      return this.addBlock(block(), occupied, rng, compId, temperature, phase)
    }
    const p = this.spawnChain.then(run, run)
    this.spawnChain = p.catch(() => undefined)
    return p
  }

  /** Fill a block with one composition at rest packing, skipping cells already holding fluid.
   *  Returns the number of particles actually added. */
  private addBlock(block: { lo: Vec3; size: Vec3 }, occupied: Set<number>, rng: () => number, compId: number, temperature: number, phase: number): number {
    if (!this.sim) return 0
    const r = latticeBox(block.lo, block.size, { occupied, rng, packing: this.packing })
    if (r.positions.length > 0) {
      try {
        this.sim.addParticles(this.particlesOf(r.positions, [0, 0, 0], compId, temperature, phase))
      } catch (e) {
        this.notify('refused', e instanceof Error ? e.message : String(e))   // capacity: refused, never clamped
        return 0
      }
      this.sceneIds.add(compId)
      // a liquid denser than the ball arrived: the weakly coupled ball cannot stay (FlipBackend.ballRefusal)
      const why = this.ball.active ? this.sim.ballRefusal?.() ?? null : null
      if (why) { this.removeBall(); this.notify('warning', `the ball was removed: ${why}`) }
    }
    return r.positions.length
  }

  /** A new scene starts at sim time 0 (bench samples are indexed from here). */
  private resetClock() {
    this.steppedFrames = 0
    this.simTime = 0
    this.substepsTotal = 0
    this.sceneGeneration++
  }

  /** Load (or re-load) a scenario. spawnParticles replaces everything → doubles as RESET.
   *  The whole material set is gated BEFORE anything spawns: every material must pass the per-material
   *  gates at its spawn temperature and the set must pass the pairwise thermal gate (e.g. 1150 °C lava
   *  with 20 °C water is refused — there is no heat transfer yet). A refused scenario leaves the tank empty. */
  loadScenario(s: LabScenario): ScenarioLoad {
    if (!this.sim || this.destroyed) return { ok: false, reason: 'engine not ready' }
    this.lastScenario = s
    this.onNotice?.(null)
    // Fresh table seeded with defaults, then the scenario's materials — so the material picker
    // and manual spawns keep the built-in materials AND the scenario's.
    const table = new CompositionTable()
    table.addDefaults()
    this.compositionTable = table
    const idByName = new Map<string, number>()
    for (const m of s.materials) {
      idByName.set(m.name, table.add(
        m.name, m.formula ?? m.name, elementsAs(m.elements),
        m.temperature ?? s.temperature ?? 20, m.densityOverride, m.renderOverride,
      ))
    }
    this.uploadCompositions()

    // Resolve every spawn's material (scenario materials first, then built-ins by name — never a
    // silent fallback to water) at its temperature, then gate the whole set before spawning anything.
    const resolved: { id: number; tempC: number }[] = []
    for (const sp of s.spawns) {
      const base = idByName.get(sp.material) ?? table.findByName(sp.material)
      if (base === null || base === undefined) return this.refuseScenario(`spawn material "${sp.material}" is neither a scenario material nor a built-in one`)
      const reg = table.get(base)!.temperature
      const t = sp.temperature ?? s.materials.find(m => m.name === sp.material)?.temperature ?? s.temperature ?? reg
      const sid = table.spawnIdAt(base, t, this.method)
      if (!sid.ok) return this.refuseScenario(sid.reason)
      resolved.push({ id: sid.id, tempC: t })
    }
    this.uploadCompositions()
    const verdict = table.checkScene(resolved.map(r => ({ id: r.id })), this.method)
    if (!verdict.ok) return this.refuseScenario(verdict.reason)
    for (const w of verdict.warnings) this.notify('warning', w)

    // Spawns fill blocks at rest packing; later spawns skip cells earlier ones already filled.
    const particles: SpawnParticle[] = []
    const occupied = new Set<number>()
    this.sceneIds = new Set(resolved.map(r => r.id))
    for (const [k, sp] of s.spawns.entries()) {
      const temperature = resolved[k].tempC
      const compId = resolved[k].id
      const block = sp.box
        ? { lo: sp.box.min.map(m => this.tankToUnit(m)) as Vec3, size: sp.box.max.map((v, i) => (v - sp.box!.min[i]) / DOMAIN_L_M) as Vec3 }
        : cubeForCount(sp.center ?? [0.5, 0.5, 0.5], sp.count ?? 1000, this.packing)
      const vel = (sp.initialVelocity ?? [0, 0, 0]).map(v => msToUnitVel(v)) as Vec3
      const r = latticeBox(block.lo, block.size, { occupied, packing: this.packing })
      const kept: Vec3[] = []
      for (const pos of r.positions) {
        if (particles.length + kept.length >= 200_000) break
        occupied.add(cellKey(pos[0], pos[1], pos[2]))
        kept.push(pos)
      }
      for (const p of this.particlesOf(kept, vel, compId, temperature, sp.phase ?? 1)) particles.push(p)   // no spread: 1e5 arguments overflow the stack
    }
    this.sim.setParticles(particles)
    this.resetClock()
    this.setGravity(scenarioGravityMs2(s))

    const ballWhy = s.ball ? (!this.sim.supportsBall ? 'this solver does not couple the ball; ?solver=mpm runs the legacy ball' : this.sim.ballRefusal?.() ?? null) : null
    if (s.ball && ballWhy) {
      this.ball.active = false
      this.sim.clearBall()
      if (this.sphereMesh) this.sphereMesh.visible = false
      this.notify('warning', `this scenario's ball was left out: ${ballWhy}`)
    } else if (s.ball) {
      this.ball.active = true
      this.ball.radius = s.ball.radius ?? DEFAULT_BALL_RADIUS
      this.ball.center = [...(s.ball.center ?? [0.5, 0.9, 0.5])] as Vec3
      this.ball.velocity = [0, 0, 0]
      if (this.sphereMesh) {
        this.sphereMesh.visible = true
        this.sphereMesh.scale.setScalar(this.ball.radius / DEFAULT_BALL_RADIUS)
      }
      this.sim.setBall(this.ball)
    } else {
      this.ball.active = false
      this.sim.clearBall()
      if (this.sphereMesh) this.sphereMesh.visible = false
    }
    return { ok: true, warnings: verdict.warnings }
  }

  private refuseScenario(reason: string): ScenarioLoad {
    this.sim?.setParticles([])
    this.sceneIds.clear()
    this.resetClock()
    this.notify('refused', `scenario refused: ${reason}`)
    return { ok: false, reason }
  }

  /** Advance the simulation by `intervalS` of sim time through the backend (the ball, where coupled, included). */
  private macroStep(intervalS: number) {
    const sim = this.sim
    if (!sim) return
    const n = sim.advance(intervalS, this.ball, this.gravityMs2)
    if (this.ball.active) this.sphereMesh?.position.set(this.ball.center[0], this.ball.center[1], this.ball.center[2])
    this.particleSubsteps += n * sim.particleCount
    this.steppedFrames++
    this.substepsTotal += n
    this.simTime += intervalS
  }

  private animate = (ts: number) => {
    if (this.destroyed) return
    this.animId = requestAnimationFrame(this.animate)
    const sim = this.sim
    const device = this.device
    const renderer = this.renderer
    const camera = this.camera
    if (!sim || !device || !renderer || !camera || !this.fluidScene) return

    // `ts` is the rAF callback timestamp (vsync-aligned) — never performance.now() here.
    let advanceS: number
    if (this.clockMode === 'lockstep') {
      advanceS = this.steppedFrames < this.stepLimit ? this.lockstepDt : 0
    } else {
      const d = this.clock.tick(ts)
      if (!d.present) return                          // ~60 Hz presentation: skip this vsync
      this.droppedTime += d.droppedS
      advanceS = this.steppedFrames < this.stepLimit ? d.advanceS : 0
      if (advanceS > 0) {
        this.frameAdvances.push(advanceS * 1000)
        if (this.frameAdvances.length > 600) this.frameAdvances.shift()
      }
    }
    const wallDt = this.lastPresentTs > 0 ? (ts - this.lastPresentTs) / 1000 : 0
    this.lastPresentTs = ts
    if (wallDt > 0) {
      this.presentIntervals.push(wallDt * 1000)
      if (this.presentIntervals.length > 600) this.presentIntervals.shift()
    }

    const simBefore = this.simTime
    if (advanceS > 0) this.macroStep(advanceS)
    this.rtSamples.push({ wall: ts, sim: this.simTime })
    while (this.rtSamples.length > 2 && ts - this.rtSamples[0].wall > 2000) this.rtSamples.shift()

    this.fpsAccum += wallDt
    this.fpsFrames++
    if (this.fpsAccum >= 0.5) {
      this.lastFps = Math.round(this.fpsFrames / this.fpsAccum)
      this.onStats({ fps: this.lastFps, count: sim.particleCount, rtFactor: this.rtFactor })
      this.fpsAccum = 0
      this.fpsFrames = 0
    }
    this.frameCount++

    const count = sim.particleCount
    // Points-fallback position readback — only while the fallback is what's on screen. SSFR
    // reads the particle buffer on the GPU directly, so copying 80 B/particle back to the CPU
    // every frame (8 MB at 100k) was pure waste whenever SSFR drew. Keyed on LAST frame's SSFR
    // health, so a failing SSFR shows fresh Points positions from the next frame on.
    if (count === 0) {
      this.fluidScene.clear()                         // no stale "ghost" Points after the scene empties
    } else if (this.simTime !== simBefore && !this.ssfrDrewLastFrame) {
      const encoder = device.createCommandEncoder()
      this.fluidScene.scheduleReadback(encoder, sim.particleBuffer, count)
      device.queue.submit([encoder.finish()])
      this.fluidScene.startReadback(count)
      this.pointsReadbacks++
    }

    this.controls?.update()

    // SSFR render, or the Points fallback.
    let ssfrOk = false
    if (this.ssfrPipeline && count > 0 && !this.forceSsfrFailure) {
      try {
        camera.updateMatrixWorld()
        const ctx = renderer.backend.context as GPUCanvasContext
        const outputTex = ctx.getCurrentTexture()
        const outputView = outputTex.createView()
        if (this.frameCount < 2) device.pushErrorScope('validation')
        const encoder2 = device.createCommandEncoder()
        const ballSnapshot = this.ball.active
          ? { center: [...this.ball.center] as [number, number, number], radius: this.ball.radius, active: true }
          : undefined
        this.ssfrPipeline.render(
          encoder2,
          sim.particleBuffer,
          count,
          new Float32Array(camera.matrixWorldInverse.elements),
          new Float32Array(camera.projectionMatrix.elements),
          new Float32Array(camera.projectionMatrixInverse.elements),
          new Float32Array(camera.matrixWorld.elements),
          outputView,
          ballSnapshot,
          [outputTex.width, outputTex.height],   // canvas = CSS × DPR; SSFR passes stay at CSS size (ED-2)
        )
        device.queue.submit([encoder2.finish()])
        if (this.frameCount < 2) {
          device.popErrorScope().then(err => { if (err) console.error('[SSFR GPU ERROR]', err.message) })
        }
        ssfrOk = true
      } catch (e) {
        if (this.frameCount < 3) console.warn('[fluid] SSFR render error:', e)
      }
    }
    if (!ssfrOk && this.scene) renderer.render(this.scene, camera)
    this.ssfrDrewLastFrame = ssfrOk
  }

  // ── Hands-on controls (shared by FLUID TEST and LABORATORY) ─────────────────

  getCompositions(): NamedComposition[] { return this.compositionTable.getAll() }
  get selectedCompositionId(): number { return this.selectedComposition }
  setSelectedComposition(id: number) { this.selectedComposition = id }
  get spawnTemp(): number { return this.spawnTemperature }
  setTemperature(t: number) { this.spawnTemperature = t }
  get ballActive(): boolean { return this.ball.active }
  /** Downward gravity magnitude in m/s². */
  get gravity(): number { return this.gravityMs2 }
  /** Set gravity (m/s², downward magnitude). Fluid and ball both read this one value. */
  setGravity(gMs2: number) {
    this.gravityMs2 = gMs2
    this.sim?.setGravity(gMs2)
  }
  get particleCount(): number { return this.sim?.particleCount ?? 0 }

  /** Sim seconds advanced per wall second over the last ~2 s (1.0 = real time; <1 = dilated). */
  get rtFactor(): number {
    const a = this.rtSamples[0], b = this.rtSamples[this.rtSamples.length - 1]
    if (!a || !b || b.wall - a.wall < 250) return 1
    return (b.sim - a.sim) / ((b.wall - a.wall) / 1000)
  }

  /** Clock: 'realtime' (pages: each ~60 Hz presented frame advances its own vsync-snapped
   *  interval) or 'lockstep' (bench: exactly `frameDt` sim seconds per callback, no wall clock). */
  configureClock(mode: ClockMode, frameDt = MACRO_DT_S) {
    if (mode === 'realtime' && this.clockMode !== 'realtime') this.clock.resume()   // the lockstep period is not dropped time
    this.clockMode = mode
    this.lockstepDt = frameDt
  }

  /** Register a new composition (e.g. an AI-generated material) and upload it. Returns its id. */
  addComposition(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature: number): number {
    const id = this.compositionTable.add(name, formula, elements, temperature)
    this.uploadCompositions()
    return id
  }

  /** Spawn ≈`count` particles of one composition as a block at rest packing around `center`
   *  ([0,1]³ coords), skipping cells that already hold fluid. Resolves to the number added. */
  spawnCompositionBlock(compId: number, count: number, center: Vec3, temperature: number): Promise<number> {
    return this.gatedSpawn(compId, temperature, () => cubeForCount(center, count, this.packing))
  }

  /** Objective motion metrics from a GPU particle readback — positions in the sim's [0,1]³ space. */
  async sampleMetrics(): Promise<FluidMetricsSample | null> {
    if (!this.sim || this.sim.particleCount === 0) return null
    const sample = await this.sim.readParticleSample()
    if (!sample) return null
    const { positions, velocities, compIds } = sample
    const n = compIds.length

    const nameById = new Map<number, string>()
    for (const c of this.compositionTable.getAll()) nameById.set(c.id, c.name)

    interface Acc { count: number; sumSpeed: number; sumY: number; sumX: number; sumZ: number; maxY: number }
    const mk = (): Acc => ({ count: 0, sumSpeed: 0, sumY: 0, sumX: 0, sumZ: 0, maxY: 0 })
    const total = mk()
    const groups = new Map<number, Acc>()
    let minX = 1, maxX = 0, minZ = 1, maxZ = 0

    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
      const speed = Math.hypot(velocities[i * 3], velocities[i * 3 + 1], velocities[i * 3 + 2])
      const acc = (id: number): Acc => {
        let g = groups.get(id)
        if (!g) { g = mk(); groups.set(id, g) }
        return g
      }
      for (const a of [total, acc(compIds[i])]) {
        a.count++
        a.sumSpeed += speed
        a.sumY += y; a.sumX += x; a.sumZ += z
        if (y > a.maxY) a.maxY = y
      }
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }

    const round = (v: number) => Math.round(v * 1000) / 1000
    return {
      count: n,
      meanSpeed: round(total.sumSpeed / n),
      meanY: round(total.sumY / n),
      maxY: round(total.maxY),
      spreadX: [round(minX), round(maxX)],
      spreadZ: [round(minZ), round(maxZ)],
      materials: [...groups.entries()].map(([id, g]) => ({
        id,
        name: nameById.get(id) ?? `comp-${id}`,
        count: g.count,
        meanSpeed: round(g.sumSpeed / g.count),
        meanY: round(g.sumY / g.count),
        maxY: round(g.maxY),
        comX: round(g.sumX / g.count),
        comZ: round(g.sumZ / g.count),
      })),
    }
  }

  get bgBrightness(): number { return this.currentBgBrightness }
  /** Scale the olive background's brightness (hue fixed) — hits both paint paths:
      the SSFR bg/composite passes and the Three fallback scene.background. */
  setBgBrightness(b: number) {
    this.currentBgBrightness = clampBrightness(b)
    const v = this.currentBgBrightness
    if (this.scene) this.scene.background = new THREE.Color(BG_BASE.r * v, BG_BASE.g * v, BG_BASE.b * v)
    this.ssfrPipeline?.setBgBrightness(v)
  }

  /** +N button: pour ≈`count` particles of the selected material as a block at rest packing,
   *  centred horizontally and placed as high as the tank allows (skipping cells already full).
   *  Resolves to the number of particles actually added. */
  spawnBatch(count: number): Promise<number> {
    return this.gatedSpawn(this.selectedComposition, this.spawnTemperature, () => cubeForCount([0.5, 1, 0.5], count, this.packing))
  }

  /** Click-to-spawn: a ≈512-particle block (~0.29 m) of the selected material at a world point. */
  spawnAt(worldPos: { x: number; y: number; z: number }): Promise<number> {
    const c: Vec3 = [worldPos.x, worldPos.y, worldPos.z]
    return this.gatedSpawn(this.selectedComposition, this.spawnTemperature, () => cubeForCount(c, 512, this.packing))
  }

  /** Raycast a screen click against the glass box and spawn a block there. */
  async spawnAtPointer(clientX: number, clientY: number): Promise<number> {
    if (!this.camera || !this.glassBox) return 0
    const rect = this.container.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObject(this.glassBox, false)[0]
    if (!hit) return 0
    return this.spawnAt(hit.point)
  }

  dropBall() {
    if (!this.sim) return
    if (!this.sim.supportsBall) {
      this.notify('refused', 'this solver does not couple the ball; ?solver=mpm runs the legacy ball')
      return
    }
    const why = this.sim.ballRefusal?.() ?? null
    if (why) { this.notify('refused', why); return }
    this.ball.active = true
    this.ball.radius = DEFAULT_BALL_RADIUS
    this.ball.center = [0.5, 0.9, 0.5]
    this.ball.velocity = [0, 0, 0]
    if (this.sphereMesh) {
      this.sphereMesh.visible = true
      this.sphereMesh.scale.setScalar(1)
      this.sphereMesh.position.set(0.5, 0.9, 0.5)
    }
    this.sim.setBall(this.ball)
  }

  removeBall() {
    this.ball.active = false
    if (this.sphereMesh) this.sphereMesh.visible = false
    this.sim?.clearBall()
  }

  /** RESET: re-run the current scenario; otherwise the page's initial scene. */
  reset() {
    if (this.lastScenario) this.loadScenario(this.lastScenario)
    else if (this.options.initialScene === 'default-water') this.loadDefaultScene()
    else { this.sim?.setParticles([]); this.sceneIds.clear(); this.resetClock() }
  }

  // ── Bench/test surface ──────────────────────────────────────────────────────

  /** Frames the sim has advanced since the last scene load — the bench's clock. */
  get framesStepped(): number { return this.steppedFrames }
  /** Freeze the simulation after `frames` stepped frames (Infinity = run freely). */
  setStepLimit(frames: number) { this.stepLimit = frames }
  /** Raw GPU particle readback (positions/velocities/composition ids). */
  readParticleSample() { return this.sim?.readParticleSample() ?? Promise.resolve(null) }

  /** Bench: render one SSFR frame offscreen (SSFRPipeline.probe) with a gate-specified camera, returning the
   *  targets it asks for plus the exact matrices used. The canvas keeps rendering untouched. */
  async renderProbe(o: ProbeOptions): Promise<ProbeResultWithCamera | null> {
    const ssfr = this.ssfrPipeline, sim = this.sim, page = this.camera
    if (!ssfr || !sim || !page) return null
    const [w, h] = [o.width ?? ssfr.size[0], o.height ?? ssfr.size[1]]
    let cam: THREE.PerspectiveCamera | THREE.OrthographicCamera
    if (o.camera) {
      const c = o.camera, near = c.near ?? 0.1, far = c.far ?? 50
      if (c.kind === 'orthographic') {
        const hh = c.halfHeight ?? 1
        cam = new THREE.OrthographicCamera(-hh * w / h, hh * w / h, hh, -hh, near, far)
      } else {
        cam = new THREE.PerspectiveCamera(c.fovDeg ?? 50, w / h, near, far)
      }
      cam.coordinateSystem = THREE.WebGPUCoordinateSystem   // NDC z ∈ [0,1], as the depth attachment expects
      cam.up.set(...(c.up ?? [0, 1, 0]))
      cam.position.set(...c.eye)
      cam.lookAt(...c.target)
    } else {
      cam = page.clone()
      cam.aspect = w / h
    }
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const m = {
      view: new Float32Array(cam.matrixWorldInverse.elements), proj: new Float32Array(cam.projectionMatrix.elements),
      invProj: new Float32Array(cam.projectionMatrixInverse.elements), invView: new Float32Array(cam.matrixWorld.elements),
    }
    const ball = this.ball.active ? { center: [...this.ball.center] as [number, number, number], radius: this.ball.radius, active: true } : undefined
    const r = await ssfr.probe(sim.particleBuffer, sim.particleCount, { ...o, width: w, height: h, ...m, ball })
    return { ...r, view: [...m.view], proj: [...m.proj], invView: [...m.invView], invProj: [...m.invProj] }
  }

  /** Adapter for installBenchHook; `action` maps page-level user actions for scripted tests. */
  benchTarget(extra: Pick<BenchTarget, 'loadScenario' | 'action'> = {}): BenchTarget {
    return {
      framesStepped: () => this.steppedFrames,
      setStepLimit: (n) => this.setStepLimit(n),
      readParticleSample: () => this.readParticleSample(),
      probe: (o) => this.renderProbe(o),
      compositions: () => this.getCompositions().map(c => ({ id: c.id, name: c.name })),
      fps: () => this.lastFps,
      count: () => this.particleCount,
      configure: (opts) => {
        if (opts.clock) this.configureClock(opts.clock, opts.frameDt ?? MACRO_DT_S)
        if (opts.gravityMs2 !== undefined) this.setGravity(opts.gravityMs2)
        if (opts.resetClockStats) { this.droppedTime = 0; this.presentIntervals = []; this.frameAdvances = []; this.rtSamples = [] }
        if (opts.resetDiagnostics) { this.sim?.resetDiagnostics(); this.particleSubsteps = 0 }
        if (opts.forceSsfrFailure !== undefined) this.forceSsfrFailure = opts.forceSsfrFailure
      },
      viscosity: async () => (await this.sim?.readViscosityProbe?.()) ?? null,
      diagnostics: async () => {
        const d = await this.sim?.readDiagnostics()
        return { ...(d ?? {}), clampHits: d?.clampHits ?? null, particleSubsteps: this.particleSubsteps }
      },
      extraStatus: () => {
        const iv = [...this.presentIntervals].sort((a, b) => a - b)
        const target = this.clock.targetMs
        const adv = this.frameAdvances
        return {
          clock: this.clockMode,
          solver: this.options.solver,
          ball: this.ball.active ? { center: [...this.ball.center], velocity: [...this.ball.velocity], radius: this.ball.radius } : null,
          simTime: this.simTime,
          substepsTotal: this.substepsTotal,
          rtFactor: this.rtFactor,
          droppedTime: this.droppedTime,
          vsyncMs: this.clock.vsyncMs,
          presentEvery: this.clock.presentEvery,
          targetFrameMs: target,
          overloaded: this.clock.overloaded,
          framesAdvanced: adv.length,
          framesWithin1pct: adv.filter(a => Math.abs(a - target) <= 0.01 * target).length,
          maxFrameAdvanceMs: adv.length ? Math.max(...adv) : 0,
          renderPath: this.ssfrDrewLastFrame ? 'ssfr' : 'points',
          pointsReadbacks: this.pointsReadbacks,
          pointsReadbacksCompleted: this.fluidScene?.completedReadbacks ?? 0,
          gpuErrors: this.gpuErrors,
          gravityMs2: this.gravityMs2,
          presentIntervalP50: iv.length ? iv[Math.floor(iv.length * 0.5)] : null,
          presentIntervalP95: iv.length ? iv[Math.floor(iv.length * 0.95)] : null,
        }
      },
      ...extra,
    }
  }

  destroy() {
    this.destroyed = true
    cancelAnimationFrame(this.animId)
    this.resizeObserver?.disconnect()
    this.sim?.destroy()
    this.fluidScene?.dispose()
    if (this.renderer) {
      this.renderer.dispose()
      try { this.container.removeChild(this.renderer.domElement) } catch { /* already removed */ }
    }
    this.renderer = null
    this.sim = null
  }
}
