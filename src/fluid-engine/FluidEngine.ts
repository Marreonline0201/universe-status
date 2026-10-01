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
import { bgPreset, clampBrightnessFor, readBgBrightness, readBgPreset } from '../fluid-render/bgBrightness'
import { CompositionTable, type NamedComposition } from '../composition/CompositionTable'
import type { MenuEntry } from '../composition/liquidGate'
import type { ElementName } from '../composition/PropertyCalculator'
import { isLiquidKey, type LiquidKey } from '../composition/materialData'
import { elementsAs, type LabScenario } from '../lab/scenario'
import type { BenchTarget } from '../bench/benchHook'
import { DOMAIN_L_M, GRID_RES, G_STANDARD, MACRO_DT_S, msToUnitVel } from './units'
import { TankHandles } from './TankHandles'
import { PresentationClock } from './clock'
import { GpuTimer, median, quantile, mean, timingInvalid } from '../bench/gate0/gpu'
import { buildOccupancy, cellKey, cubeForCount, latticeBox, type Vec3 } from './spawn'
import { scenarioGravityMs2 } from '../lab/scenario'

const DEFAULT_BALL_RADIUS = 0.1   // ~6 grid cells in MLS-MPM [0,1] space

export type ClockMode = 'realtime' | 'lockstep'

export interface FluidStats {
  fps: number
  count: number
  /** Sim seconds advanced per wall second over the last ~2 s (1.0 = real time). */
  rtFactor: number
  /** S3.6e: the unified pressure–viscosity solve for a ball in a thick liquid, while it runs (null otherwise). */
  stokes?: { iterations: number; converged: boolean; capHits: number } | null
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
  /** Drag handles on the tank's faces, edges and corners (a page that also shows the TANK panel and follows
   *  onTankChange; off by default, so a page without them never gets a tank it cannot display). */
  tankHandles?: boolean
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
  // the tank's furniture, resized with it (TANK-RESIZE)
  private boxMesh: THREE.LineSegments | null = null
  private floorMesh: THREE.Mesh | null = null
  private wallMesh: THREE.Mesh | null = null
  private sideMeshes: THREE.Mesh[] = []
  /** While the simulator is being rebuilt the frames render but do not step. */
  private resizing = false
  /** While renderTiming measures offscreen frames the page draws nothing (no shared-buffer traffic, no extra GPU load). */
  private timingActive = false
  /** The tank diagonal (world units) the camera distance was framed for. */
  private framedDiag = Math.sqrt(3)
  /** Told after every tank resize (the page's TANK panel). */
  onTankChange: ((t: { cells: Vec3; sizeM: Vec3; resizable: boolean }) => void) | null = null
  private tankHandles: TankHandles | null = null
  private raycaster = new THREE.Raycaster()
  private gravityMs2 = G_STANDARD   // downward gravity magnitude, m/s²
  private currentBgPreset = readBgPreset()
  private currentBgBrightness = clampBrightnessFor(this.currentBgPreset, readBgBrightness())
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
    this.options = { initialScene: options.initialScene ?? 'empty', solver: options.solver ?? solverFromUrl(), tankHandles: options.tankHandles ?? false }
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
    // The persisted background preset × its brightness (fallback/no-particle paint path).
    const bb = this.currentBgBrightness
    scene.background = this.bgColor()
    const camera = new THREE.PerspectiveCamera(50, this.container.clientWidth / this.container.clientHeight, 0.1, 50)
    camera.position.set(2.0, 1.5, 2.0)
    camera.lookAt(0.5, 0.5, 0.5)

    // The adapter's own buffer limits (TANK-RESIZE budget): a 5 m tank (88³) needs a 187 MB storage binding (the viscous
    // lattice) against the default 128 MiB; this GPU allows 2 GB. The default 64³ tank fits either way. The renderer is
    // asked for the SAME adapter (three.js passes powerPreference through; left undefined it may pick another GPU than
    // the one whose limits were read); if its device still refuses them, it starts on the default limits and a resize
    // then refuses the tanks those cannot hold (resizeTank).
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    const requiredLimits = adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } : {}
    let renderer = new (THREE as any).WebGPURenderer({ antialias: true, powerPreference: 'high-performance', requiredLimits })
    try {
      await renderer.init()
    } catch {
      renderer.dispose?.()
      renderer = new (THREE as any).WebGPURenderer({ antialias: true, powerPreference: 'high-performance' })
      await renderer.init()
    }
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
    this.boxMesh = boxMesh

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
    this.floorMesh = floorMesh

    const wallMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.98, 0.98, 20, 15),
      new THREE.MeshBasicMaterial({ color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    )
    wallMesh.position.set(0.5, 0.5, 0.001)
    scene.add(wallMesh)
    this.wallMesh = wallMesh

    const sideMat = new THREE.MeshBasicMaterial({ color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    const sideGeo = new THREE.PlaneGeometry(0.98, 0.98, 15, 15)
    for (const x of [0.001, 0.999]) {
      const side = new THREE.Mesh(sideGeo, sideMat)
      side.rotation.y = Math.PI / 2
      side.position.set(x, 0.5, 0.5)
      scene.add(side)
      this.sideMeshes.push(side)
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
      ssfr.setBgPreset(this.currentBgPreset) // persisted background colour
      ssfrPipeline = ssfr
    } catch (e) {
      console.warn('[fluid] SSFR init failed, using Points fallback:', e)
    }

    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.controls = controls
    // drag handles on the tank's faces, edges and corners (a resizable solver only)
    if (sim.resize && this.options.tankHandles) this.tankHandles = new TankHandles(camera, this.container, controls, (cells, shiftM) => this.resizeTank(cells, shiftM))
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
    if (!this.sim || this.destroyed || this.rebuilding()) return
    const { lo, size } = cubeForCount(this.tankPoint(0.5, 0.5, 0.5), 10000, this.packing)
    const block = latticeBox(lo, size, { packing: this.packing })
    // capacity first (a small tank holds fewer than the block): refused, the tank and RESET's target left as they were
    const cap = this.sim.maxParticles
    if (block.positions.length > cap) {
      this.notify('refused', `the default block needs ${block.positions.length} particles; this tank holds at most ${cap}${this.canResizeTank ? ' — make the tank bigger' : ''}`)
      return
    }
    this.lastScenario = null
    this.sim.setParticles(this.particlesOf(block.positions, [0, 0, 0], 0, 20, 1))
    this.sceneIds = new Set([0])
    this.resetClock()
    this.uploadCompositions()
  }

  private notify(kind: FluidNotice['kind'], text: string) {
    if (kind === 'refused') this.lastRefusal = text
    this.onNotice?.({ kind, text })
  }

  /** Whether the owner can make this tank bigger on this page (a resizable solver and FLUID TEST's tank handles /
   *  TANK panel) — a refusal suggests it only then. */
  private get canResizeTank(): boolean { return !!this.sim?.resize && this.options.tankHandles }

  /** True (and the page told why) while the tank is being rebuilt: an action now would reach the simulator that is
   *  being replaced and be silently undone, so it is refused instead. */
  private rebuilding(): boolean {
    if (!this.resizing) return false
    this.notify('refused', 'the tank is being rebuilt — try again in a moment')
    return true
  }

  /** A point given as fractions of the tank, in world units (the tank spans [0, cells/64] per axis): the default
   *  64³ tank maps (0.5, 0.5, 0.5) to its centre as before, a resized tank to its own. */
  private tankPoint(fx: number, fy: number, fz: number): Vec3 {
    const e = this.tank.cells.map(c => c / GRID_RES)
    return [fx * e[0], fy * e[1], fz * e[2]]
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
    if (this.rebuilding()) return Promise.resolve(0)
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
      // the new contents may rule the ball out on this backend (ballRefusal; the monolithic FLIP ball never is)
      const why = this.ball.active ? this.sim.ballRefusal?.() ?? null : null
      if (why) { this.removeBall(); this.notify('warning', `the ball was removed: ${why}`) }
    } else {
      this.notify('warning', 'nothing was added: the spawn region has no free space (liquid already fills it)')
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
    if (this.resizing) return { ok: false, reason: 'the tank is being rebuilt — try again in a moment' }
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
        : cubeForCount(sp.center ?? this.tankPoint(0.5, 0.5, 0.5), sp.count ?? 1000, this.packing)
      const vel = (sp.initialVelocity ?? [0, 0, 0]).map(v => msToUnitVel(v)) as Vec3
      const r = latticeBox(block.lo, block.size, { occupied, packing: this.packing })
      for (const pos of r.positions) occupied.add(cellKey(pos[0], pos[1], pos[2]))
      for (const p of this.particlesOf(r.positions, vel, compId, temperature, sp.phase ?? 1)) particles.push(p)   // no spread: 1e5 arguments overflow the stack
    }
    // capacity: refused, never clamped (a truncated scenario would be a different experiment than the one asked for)
    const cap = this.sim.maxParticles   // each solver's own (MPM fell back to 200,000 here while holding 1,000,000)
    if (particles.length > cap) return this.refuseScenario(`the scenario needs ${particles.length} particles; this tank holds at most ${cap} — ${this.canResizeTank ? 'make the tank bigger or the spawns smaller' : 'make the spawns smaller'}`)
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
      this.ball.center = [...(s.ball.center ?? this.ballStart(this.ball.radius))] as Vec3
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
    if (this.timingActive) return   // renderTiming owns the GPU: no step, no frame

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
    if (advanceS > 0 && !this.resizing) this.macroStep(advanceS)
    if (!this.resizing) this.rtSamples.push({ wall: ts, sim: this.simTime })
    while (this.rtSamples.length > 2 && ts - this.rtSamples[0].wall > 2000) this.rtSamples.shift()

    this.fpsAccum += wallDt
    this.fpsFrames++
    if (this.fpsAccum >= 0.5) {
      this.lastFps = Math.round(this.fpsFrames / this.fpsAccum)
      const sk = sim.stokesStatus?.() ?? null
      this.onStats({ fps: this.lastFps, count: sim.particleCount, rtFactor: this.rtFactor, stokes: sk && sk.active ? { iterations: sk.iterations, converged: sk.converged, capHits: sk.capHits } : null })
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
    this.tankHandles?.update()

    // SSFR render, or the Points fallback. An empty tank goes through SSFR too — the room alone (SSFRPipeline.render), the
    // backdrop at its swatch's colour; the three.js fallback tone-maps the backdrop's sRGB values as if linear (bg-palette
    // note 2026-09-30 (c)). So renderPath reads 'ssfr' with 0 particles, and the first frame after an empty tank fills
    // schedules no Points readback (the readback above is keyed on the previous frame's SSFR health).
    let ssfrOk = false
    if (this.ssfrPipeline && !this.forceSsfrFailure) {
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
  /** The tank's particle capacity (null before init); a resize changes it (onTankChange). */
  get maxParticles(): number | null { return this.sim?.maxParticles ?? null }

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
  get bgPresetId(): string { return this.currentBgPreset }
  /** The background preset's colour × its brightness, for the Three fallback scene.background. */
  private bgColor(): THREE.Color {
    const c = bgPreset(this.currentBgPreset).base, v = this.currentBgBrightness
    return new THREE.Color(c.r * v, c.g * v, c.b * v)
  }
  /** Scale the background's brightness (its colour fixed) — hits both paint paths:
      the SSFR bg/composite passes and the Three fallback scene.background. */
  setBgBrightness(b: number) {
    this.currentBgBrightness = clampBrightnessFor(this.currentBgPreset, b)
    if (this.scene) this.scene.background = this.bgColor()
    this.ssfrPipeline?.setBgBrightness(this.currentBgBrightness)
  }
  /** Pick the background colour (bgBrightness.ts BG_PRESETS; an unknown id is the olive default) — both paint paths. */
  setBgPreset(id: string) {
    this.currentBgPreset = bgPreset(id).id
    this.currentBgBrightness = clampBrightnessFor(this.currentBgPreset, this.currentBgBrightness)   // the new preset's cap
    if (this.scene) this.scene.background = this.bgColor()
    this.ssfrPipeline?.setBgPreset(this.currentBgPreset)
    this.ssfrPipeline?.setBgBrightness(this.currentBgBrightness)
  }

  /** +N button: pour ≈`count` particles of the selected material as a block at rest packing,
   *  centred horizontally and placed as high as the tank allows (skipping cells already full).
   *  Resolves to the number of particles actually added. */
  spawnBatch(count: number): Promise<number> {
    return this.gatedSpawn(this.selectedComposition, this.spawnTemperature, () => cubeForCount(this.tankPoint(0.5, 1, 0.5), count, this.packing))
  }

  /** Click-to-spawn: a ≈512-particle block (~0.29 m) of the selected material at a world point. */
  spawnAt(worldPos: { x: number; y: number; z: number }): Promise<number> {
    const c: Vec3 = [worldPos.x, worldPos.y, worldPos.z]
    return this.gatedSpawn(this.selectedComposition, this.spawnTemperature, () => cubeForCount(c, 512, this.packing))
  }

  /** The tank: grid cells per axis and its inner size in metres (dx fixed). */
  get tank(): { cells: Vec3; sizeM: Vec3; resizable: boolean } {
    const cells = (this.sim?.cells ?? [GRID_RES, GRID_RES, GRID_RES]) as Vec3
    return { cells: [...cells] as Vec3, sizeM: cells.map(c => c * DOMAIN_L_M / GRID_RES) as Vec3, resizable: !!this.sim?.resize }
  }
  /** The running tank's packing (scenario validation against the tank as it is now). */
  get tankPacking() { return this.sim?.packing ?? null }
  /** Tank resize (TANK-RESIZE spec): cells per axis, multiples of 8 in [16, 88] (0.91–4.99 m at dx = 5.67 cm). The
   *  simulator is rebuilt; particles inside the new walls stay (shifted by `shiftM` metres first — a −x / −z face moved);
   *  the ball stays if it fits. Frames keep rendering while the rebuild runs, without stepping. */
  async resizeTank(cells: Vec3, shiftM: Vec3 = [0, 0, 0]): Promise<{ ok: boolean; reason?: string; kept?: number; removed?: number }> {
    const sim = this.sim
    if (!sim?.resize || this.destroyed) return { ok: false, reason: 'this solver has a fixed tank' }
    if (this.resizing) return { ok: false, reason: 'a resize is already running' }
    if (!cells.every(c => Number.isInteger(c) && c % 8 === 0 && c >= 16 && c <= 88)) return { ok: false, reason: `tank cells must be multiples of 8 in [16, 88] (got ${cells.join(' × ')})` }
    // the largest binding is the viscous lattice, 256 B per padded cell (TANK-RESIZE budget: 187 MB at 88³); on a device
    // left at the default limits a big tank is refused here instead of failing inside the GPU
    const latBytes = 256 * (cells[0] + 2) * (cells[1] + 2) * (cells[2] + 2)
    const lim = this.device?.limits
    if (lim && (latBytes > lim.maxStorageBufferBindingSize || latBytes > lim.maxBufferSize)) {
      return { ok: false, reason: `this GPU device binds at most ${(lim.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MiB per buffer; a ${cells.join(' × ')} tank needs ${(latBytes / 2 ** 20).toFixed(0)} MiB` }
    }
    this.resizing = true
    this.sceneGeneration++   // spawns queued against the old tank's occupancy are cancelled (enqueueSpawn checks it)
    try {
      const r = await sim.resize(cells, shiftM)
      this.sceneIds = new Set(r.compositions)
      if (this.ball.active) {
        if (r.ballRemoved) { this.ball.active = false; if (this.sphereMesh) this.sphereMesh.visible = false; this.notify('warning', 'the ball was removed: it no longer fits in the tank') }
        else for (let a = 0; a < 3; a++) this.ball.center[a] += shiftM[a] / DOMAIN_L_M
      }
      this.applyTankFurniture()
      this.onTankChange?.(this.tank)
      return { ok: true, kept: r.kept, removed: r.removed }
    } finally {
      this.resizing = false
      this.rtSamples = []   // the rebuild's paused frames are not "cannot keep up with real time"
    }
  }
  /** The glass box, its edges, floor and wall grids and the orbit target follow the tank (world units: cells/64). */
  private applyTankFurniture() {
    const [ex, ey, ez] = this.tank.cells.map(c => c / GRID_RES)
    this.boxMesh?.scale.set(ex, ey, ez); this.boxMesh?.position.set(ex / 2, ey / 2, ez / 2)
    this.glassBox?.scale.set(ex, ey, ez); this.glassBox?.position.set(ex / 2, ey / 2, ez / 2)
    this.floorMesh?.scale.set(ex, ez, 1); this.floorMesh?.position.set(ex / 2, 0.001, ez / 2)
    this.wallMesh?.scale.set(ex, ey, 1); this.wallMesh?.position.set(ex / 2, ey / 2, 0.001)
    this.sideMeshes.forEach((m, k) => { m.scale.set(ez, ey, 1); m.position.set(k === 0 ? 0.001 : ex - 0.001, ey / 2, ez / 2) })
    // the SSFR composite draws the frame, so three.js never renders this scene and never refreshes world matrices on its
    // own: click-to-spawn raycasts the glass box, which must carry its new matrix now
    for (const o of [this.boxMesh, this.glassBox, this.floorMesh, this.wallMesh, ...this.sideMeshes]) o?.updateMatrixWorld(true)
    this.ssfrPipeline?.setTankExtent([ex, ey, ez])
    this.tankHandles?.setCells(this.tank.cells)
    if (this.controls && this.camera) {
      // same view direction, distance and zoom limits scaled with the tank's diagonal: the tank keeps its framing
      const diag = Math.hypot(ex, ey, ez), k = diag / this.framedDiag
      const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(k)
      this.controls.target.set(ex / 2, ey / 2, ez / 2)
      this.controls.minDistance *= k; this.controls.maxDistance *= k
      this.camera.position.copy(this.controls.target).add(off)
      this.framedDiag = diag
      this.controls.update()
    }
  }

  /** Raycast a screen click against the glass box and spawn a block there. */
  async spawnAtPointer(clientX: number, clientY: number): Promise<number> {
    if (!this.camera || !this.glassBox) return 0
    const rect = this.container.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.camera.updateMatrixWorld()
    this.glassBox.updateMatrixWorld()
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObject(this.glassBox, false)[0]
    if (!hit) return 0
    return this.spawnAt(hit.point)
  }

  /** Where a ball is released: centred over the tank's floor, 0.9 of its height (the default tank's 0.9 wu) or lower
   *  so it fits under the lid. */
  private ballStart(radius: number): Vec3 {
    const e = this.tank.cells.map(c => c / GRID_RES)
    return [e[0] / 2, Math.min(0.9 * e[1], e[1] - radius - 1 / GRID_RES), e[2] / 2]
  }

  dropBall() {
    if (!this.sim || this.rebuilding()) return
    if (!this.sim.supportsBall) {
      this.notify('refused', 'this solver does not couple the ball; ?solver=mpm runs the legacy ball')
      return
    }
    const why = this.sim.ballRefusal?.() ?? null
    if (why) { this.notify('refused', why); return }
    this.ball.active = true
    this.ball.radius = DEFAULT_BALL_RADIUS
    this.ball.center = this.ballStart(DEFAULT_BALL_RADIUS)
    this.ball.velocity = [0, 0, 0]
    if (this.sphereMesh) {
      this.sphereMesh.visible = true
      this.sphereMesh.scale.setScalar(1)
      this.sphereMesh.position.set(...this.ball.center)
    }
    this.sim.setBall(this.ball)
  }

  removeBall() {
    if (this.rebuilding()) return
    this.ball.active = false
    if (this.sphereMesh) this.sphereMesh.visible = false
    this.sim?.clearBall()
  }

  /** RESET: re-run the current scenario (a scenario the page loaded, e.g. from the Lab); otherwise an EMPTY tank.
   *  Owner preference 2026-09-30: RESET leaves the tank empty — it no longer brings back FLUID TEST's default water
   *  block — and FLUID TEST OPENS empty too (owner, later the same day: options.initialScene 'empty'). A dropped ball is
   *  left as it is, as before. */
  reset() {
    if (this.rebuilding()) return
    if (this.lastScenario) this.loadScenario(this.lastScenario)
    else { this.sim?.setParticles([]); this.sceneIds.clear(); this.resetClock() }
  }

  // ── Bench/test surface ──────────────────────────────────────────────────────

  /** Frames the sim has advanced since the last scene load — the bench's clock. */
  get framesStepped(): number { return this.steppedFrames }
  /** Freeze the simulation after `frames` stepped frames (Infinity = run freely). */
  setStepLimit(frames: number) { this.stepLimit = frames }

  /** Bench (the B1c same-state fork, spec rev 3 §2/§9): the scene the held state snapshot was taken in (null: none) — a
   *  restore into another scene (a load or reset since) is refused. */
  private benchSnapGen: number | null = null
  /** Bench (the same-state fork): the FLIP backend, while the sim is frozen at its step limit — a drain, a snapshot, a
   *  restore or a state read steps no frame (spec §2: t0 does not move). */
  private frozenFlip(what: string): FlipBackend {
    const s = this.sim
    if (!(s instanceof FlipBackend)) throw new Error(`${what}: this solver has no state snapshot (the incompressible solver only)`)
    if (this.resizing) throw new Error(`${what}: the tank is being rebuilt`)
    if (!(this.steppedFrames >= this.stepLimit)) throw new Error(`${what}: the sim is not frozen (frame ${this.steppedFrames} < step limit ${this.stepLimit}) — setStepLimit(${this.steppedFrames}) first`)
    return s
  }
  /** `op` on the frozen FLIP backend; throws if a frame was stepped or the scene or simulator changed while it ran. */
  private async frozenOp<T>(what: string, op: (s: FlipBackend) => Promise<T>): Promise<T> {
    const s = this.frozenFlip(what), frame = this.steppedFrames, gen = this.sceneGeneration
    const r = await op(s)
    if (this.sim !== s || this.steppedFrames !== frame || this.sceneGeneration !== gen) throw new Error(`${what}: the sim stepped or changed while it ran (frame ${frame} → ${this.steppedFrames})`)
    return r
  }
  private benchClock() { return { steppedFrames: this.steppedFrames, simTime: this.simTime, substepsTotal: this.substepsTotal } }
  /** Bench (the same-state fork, spec rev 3 §2): set the clock a restore returns to — the frames stepped, the sim time and
   *  the substeps at the snapshot. Bookkeeping only: no physics reads them (a frame advances lockstepDt through the
   *  backend). Refused for an unknown key, a frame or substep count that is not an integer ≥ 0, a sim time that is not
   *  finite and ≥ 0, and when the sim would then step (the step limit above the new frame count: setStepLimit first). */
  private setBenchClock(c: { steppedFrames?: number; simTime?: number; substepsTotal?: number } | undefined) {
    const o = c ?? {}, keys = ['steppedFrames', 'simTime', 'substepsTotal'], bad = Object.keys(o).filter(k => !keys.includes(k))
    if (bad.length) throw new Error(`setClock: unknown key ${bad.join(', ')} (known: ${keys.join(', ')})`)
    const isCount = (v: number | undefined) => v === undefined || (Number.isInteger(v) && v >= 0)
    if (!isCount(o.steppedFrames) || !isCount(o.substepsTotal)) throw new Error(`setClock: steppedFrames and substepsTotal must be integers ≥ 0 (got ${o.steppedFrames}, ${o.substepsTotal})`)
    if (o.simTime !== undefined && !(Number.isFinite(o.simTime) && o.simTime >= 0)) throw new Error(`setClock: simTime must be finite and ≥ 0 (got ${o.simTime})`)
    const frames = o.steppedFrames ?? this.steppedFrames
    if (this.resizing || !(frames >= this.stepLimit)) throw new Error(`setClock: the sim would step (frame ${frames} < step limit ${this.stepLimit}) — setStepLimit(${frames}) first`)
    this.steppedFrames = frames
    if (o.simTime !== undefined) this.simTime = o.simTime
    if (o.substepsTotal !== undefined) this.substepsTotal = o.substepsTotal
    return this.benchClock()
  }
  /** Raw GPU particle readback (positions/velocities/composition ids). */
  readParticleSample() { return this.sim?.readParticleSample() ?? Promise.resolve(null) }

  /** Bench: render one SSFR frame offscreen (SSFRPipeline.probe) with a gate-specified camera, returning the
   *  targets it asks for plus the exact matrices used. The canvas keeps rendering untouched. */
  async renderProbe(o: ProbeOptions): Promise<ProbeResultWithCamera | null> {
    const ssfr = this.ssfrPipeline, sim = this.sim
    if (!ssfr || !sim || !this.camera) return null
    const [w, h] = [o.width ?? ssfr.size[0], o.height ?? ssfr.size[1]]
    const m = this.probeMatrices(o, w, h)
    const r = await ssfr.probe(sim.particleBuffer, sim.particleCount, { ...o, width: w, height: h, ...m, ball: this.probeBall() })
    return { ...r, view: [...m.view], proj: [...m.proj], invView: [...m.invView], invProj: [...m.invProj] }
  }

  /** Bench (OPT-1-cov): the GPU time of whole offscreen SSFR frames — the page's own path (ellipsoid kernel, splats,
   *  blur, composite) with a gate-specified camera, each frame its own submit, bracketed by timestamp marker passes
   *  (the Gate-0 GpuTimer method) — and the fraction of pixels the liquid covers. The canvas keeps rendering untouched. */
  async renderTiming(o: ProbeOptions & { frames?: number; warmup?: number }) {
    const ssfr = this.ssfrPipeline, sim = this.sim, device = this.device
    if (!ssfr || !sim || !device || !this.camera) return null
    const [w, h] = [o.width ?? ssfr.size[0], o.height ?? ssfr.size[1]]
    const m = this.probeMatrices(o, w, h)
    const frames = Math.max(30, o.frames ?? 120)
    // the page's own frames pause while timing: they share the SSFR uniforms and the ellipsoid buffers and would add GPU
    // load between the timed frames (animate() skips rendering while this is set)
    this.timingActive = true
    let rig: Awaited<ReturnType<SSFRPipeline['offscreenRig']>> | null = null
    let timer: GpuTimer | null = null
    let scoped = false
    try {
      rig = await ssfr.offscreenRig(sim.particleBuffer, sim.particleCount, { ...o, width: w, height: h, ...m, ball: this.probeBall() })
      timer = new GpuTimer(device, frames)
      device.pushErrorScope('validation'); scoped = true
      for (let f = 0; f < (o.warmup ?? 10); f++) { const e = device.createCommandEncoder(); rig.encode(e); device.queue.submit([e.finish()]) }
      await device.queue.onSubmittedWorkDone()
      const wall: number[] = []
      for (let f = 0; f < frames; f++) {
        const e = device.createCommandEncoder()
        timer.mark(e, timer.begin(f))
        rig.encode(e)
        timer.mark(e, timer.end(f))
        if (f === frames - 1) timer.resolve(e, frames)
        const t0 = performance.now()
        device.queue.submit([e.finish()])
        await device.queue.onSubmittedWorkDone()
        wall.push(performance.now() - t0)
      }
      const ns = await timer.read(frames)
      const err = await device.popErrorScope(); scoped = false
      if (err) throw new Error(`renderTiming: validation error: ${err.message.split('\n')[0]}`)
      const coverage = await rig.fluidFraction()
      return {
        width: w, height: h, frames, count: sim.particleCount, coverage, splatShape: o.splatShape ?? null,
        gpuMedianMs: median(ns) / 1e6, gpuP95Ms: quantile(ns, 0.95) / 1e6, gpuMeanMs: mean(ns) / 1e6, wallMedianMs: median(wall),
        invalidTimestamps: timingInvalid(ns),
        // the per-frame series, in submission order (a drift within one call shows here, not in the median)
        gpuFrameMs: Array.from(ns, v => v / 1e6),
      }
    } finally {
      if (scoped) await device.popErrorScope()
      timer?.destroy()
      rig?.destroy()
      this.timingActive = false
    }
  }

  private probeBall() {
    return this.ball.active ? { center: [...this.ball.center] as [number, number, number], radius: this.ball.radius, active: true } : undefined
  }

  /** A probe's camera matrices: the gate-specified camera, or the page's at the probe's aspect. */
  private probeMatrices(o: ProbeOptions, w: number, h: number) {
    const page = this.camera!
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
    return {
      view: new Float32Array(cam.matrixWorldInverse.elements), proj: new Float32Array(cam.projectionMatrix.elements),
      invProj: new Float32Array(cam.projectionMatrixInverse.elements), invView: new Float32Array(cam.matrixWorld.elements),
    }
  }

  /** Adapter for installBenchHook; `action` maps page-level user actions for scripted tests. */
  benchTarget(extra: Pick<BenchTarget, 'loadScenario' | 'action'> = {}): BenchTarget {
    return {
      framesStepped: () => this.steppedFrames,
      setStepLimit: (n) => this.setStepLimit(n),
      readParticleSample: () => this.readParticleSample(),
      probe: (o) => this.renderProbe(o),
      renderTiming: (o) => this.renderTiming(o),
      profileStep: () => {
        const s = this.sim as { profileNextStep?: () => Promise<unknown> } | null
        if (!s?.profileNextStep) throw new Error('profileStep: this solver has no step profiler')
        return s.profileNextStep()
      },
      compositions: () => this.getCompositions().map(c => ({ id: c.id, name: c.name, rho: c.solver.rhoKgM3, mu: c.solver.muPaS })),
      fps: () => this.lastFps,
      count: () => this.particleCount,
      resizeTank: (cells, shiftM) => this.resizeTank(cells, shiftM),
      tankHandle: (kind, sides) => this.tankHandles?.screenOf(kind, sides) ?? null,
      view: () => {
        if (!this.camera) return null
        this.camera.updateMatrixWorld()
        const r = this.container.getBoundingClientRect()
        return { matrixWorld: [...this.camera.matrixWorld.elements], projectionMatrixInverse: [...this.camera.projectionMatrixInverse.elements], rect: { left: r.left, top: r.top, width: r.width, height: r.height } }
      },
      configure: (opts) => {
        // bench (review 2026-09-30 INT-5): the floor's wall shear on ('keulegan1938') or off (false) — the twin-run
        // toggle, held by the backend across a tank resize. First, so that every refusal (a solver without the stage —
        // MPM —, a value the backend does not take) comes before any other option is applied.
        if (opts.wallShear !== undefined) {
          const s = this.sim
          if (!s?.setWallShear) throw new Error('wallShear: this solver has no wall-shear stage')
          s.setWallShear(opts.wallShear)
        }
        if (opts.clock) this.configureClock(opts.clock, opts.frameDt ?? MACRO_DT_S)
        if (opts.gravityMs2 !== undefined) this.setGravity(opts.gravityMs2)
        if (opts.resetClockStats) { this.droppedTime = 0; this.presentIntervals = []; this.frameAdvances = []; this.rtSamples = [] }
        if (opts.resetDiagnostics) { this.sim?.resetDiagnostics(); this.particleSubsteps = 0 }
        if (opts.forceSsfrFailure !== undefined) this.forceSsfrFailure = opts.forceSsfrFailure
        if (opts.splatShape) this.ssfrPipeline?.setSplatShape(opts.splatShape)
        if (opts.disableImmiscible !== undefined) (this.sim as { setImmiscibleDisabled?: (v: boolean) => void } | null)?.setImmiscibleDisabled?.(opts.disableImmiscible)
        // bench hook X (the B1c experiments): these liquids leave the drift slots (untracked); [] restores the default
        if (opts.immExcludeLiquids !== undefined) {
          const s = this.sim as { setImmiscibleExcluded?: (k: readonly string[]) => void } | null
          if (!s?.setImmiscibleExcluded) throw new Error('immExcludeLiquids: this solver has no drift slots')
          s.setImmiscibleExcluded(opts.immExcludeLiquids)
        }
        // bench (the face counter-flux's same-commit control): where the drift's J is formed
        if (opts.immDriftForm !== undefined) {
          const s = this.sim as { setImmiscibleDriftForm?: (f: string) => void } | null
          if (!s?.setImmiscibleDriftForm) throw new Error('immDriftForm: this solver has no drift flux')
          s.setImmiscibleDriftForm(opts.immDriftForm)
        }
        // bench (the B1c displacement budget): snapshot the positions after each substep's density correction
        if (opts.snapshotDensity !== undefined) {
          const s = this.sim as { setSnapshotDensity?: (on: boolean) => void } | null
          if (!s?.setSnapshotDensity) throw new Error('snapshotDensity: this solver has no density correction')
          s.setSnapshotDensity(opts.snapshotDensity)
        }
      },
      viscosity: async () => (await this.sim?.readViscosityProbe?.()) ?? null,
      // bench (the B1c same-state fork, spec rev 3 §2/§9 — FlipBackend bench*, gpu-sim/flip/stateSnapshot.ts): each refused
      // unless the sim is frozen at its step limit; a restore only into the scene its snapshot was taken in
      drainReadbacks: () => this.frozenOp('drainReadbacks', s => s.benchDrain()),
      snapshotState: async (o) => {
        const r = await this.frozenOp('snapshotState', s => s.benchSnapshotState(o))
        this.benchSnapGen = this.sceneGeneration
        return { ...r, clock: this.benchClock() }
      },
      restoreState: (o) => {
        if (this.benchSnapGen === null || this.benchSnapGen !== this.sceneGeneration) return Promise.reject(new Error('restoreState: no snapshot of this scene held (none taken, or a load or reset since)'))
        return this.frozenOp('restoreState', s => s.benchRestoreState(o))
      },
      disposeSnapshot: () => { this.benchSnapGen = null; return this.sim instanceof FlipBackend ? this.sim.benchDisposeSnapshot() : false },
      setClock: (c) => this.setBenchClock(c),
      hostState: () => {
        if (!(this.sim instanceof FlipBackend)) throw new Error('hostState: this solver has no state snapshot (the incompressible solver only)')
        return this.sim.benchHostState()
      },
      stateWords: (names) => this.frozenOp('stateWords', s => s.benchReadState(names)),
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
          // the drift flux as the backend runs it (active, why not, bench exclusions, the form of J) — studies prove their arm
          immiscible: (this.sim as { immiscibleDrift?: { active: boolean; reason: string | null; excluded: string[]; form: string } } | null)?.immiscibleDrift ?? null,
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
          stokes: this.sim?.stokesStatus?.() ?? null,
          // the floor's wall shear as the live simulator runs it: 'on' | 'off' | 'guarded' (null: a solver without it)
          wallShear: this.sim?.wallShearStatus?.() ?? null,
          tank: this.tank,
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
    this.tankHandles?.dispose()
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
