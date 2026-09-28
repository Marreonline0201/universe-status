// FluidEngine — the ONE fluid engine behind both the FLUID TEST and LABORATORY pages.
// A plain (non-React) class: WebGPU device + three.js scene, the MLS-MPM simulator, the SSFR
// renderer, the drop-ball obstacle, spawning, and the per-frame loop. The pages keep only their
// UI. (Before 2026-09-28 FluidTest.tsx carried its own inline copy of this loop; they were
// unified so every physics change lands once. Parity with the old FLUID TEST loop was gated
// bit-identically by scripts/fluid-parity.mjs.)
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MpmGpuSimulator, type GpuParticle } from '../gpu-sim/MpmGpuSimulator'
import { FluidScene } from '../fluid-render/FluidScene'
import { SSFRPipeline } from '../fluid-render/SSFRPipeline'
import { BG_BASE, clampBrightness, readBgBrightness } from '../fluid-render/bgBrightness'
import { CompositionTable, type NamedComposition } from '../composition/CompositionTable'
import type { ElementName } from '../composition/PropertyCalculator'
import { elementsAs, type LabScenario } from '../lab/scenario'
import type { BenchTarget } from '../bench/benchHook'
import { DOMAIN_L_M, G_STANDARD, MACRO_DT_S, accelToCode, accelToUnitPerTau2, mpmSubsteps, msToUnitVel } from './units'
import { buildOccupancy, cellKey, cubeForCount, latticeBox, type Vec3 } from './spawn'
import { scenarioGravityMs2 } from '../lab/scenario'

const DEFAULT_BALL_RADIUS = 0.1   // ~6 grid cells in MLS-MPM [0,1] space

/** Presentation cap: rAF callbacks sooner than this after the last presented frame do nothing.
 *  Slightly under 1/60 s so a 240 Hz panel presents on every 4th vsync despite timer jitter. */
const PRESENT_MIN_MS = 1000 / 60 - 2
/** At most this many physics macro-steps per presented frame; any older backlog is dropped and
 *  reported as time dilation instead of spiralling (the physics per step never changes). */
const MAX_CATCHUP_STEPS = 2
/** Longest wall-clock gap credited to the accumulator (tab switch, debugger pause). */
const MAX_WALL_GAP_S = 0.25

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

export interface FluidEngineOptions {
  /** 'default-water' spawns FLUID TEST's 10k-particle water block at init and on reset. */
  initialScene?: 'default-water' | 'empty'
}

export class FluidEngine {
  private destroyed = false
  private renderer: any = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private controls: OrbitControls | null = null
  private device: GPUDevice | null = null
  private gpuSim: MpmGpuSimulator | null = null
  private fluidScene: FluidScene | null = null
  private ssfrPipeline: SSFRPipeline | null = null
  private sphereMesh: THREE.Mesh | null = null
  private ball = { active: false, radius: DEFAULT_BALL_RADIUS, center: [0.5, 0.9, 0.5] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }
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
  // ── Clock ── physics advances in fixed MACRO_DT_S steps of sim time, never "one per rAF".
  private clockMode: ClockMode = 'realtime'
  private lockstepDt = MACRO_DT_S   // lockstep (bench): sim seconds advanced per presented frame
  private lastTick = 0              // performance.now() of the last presented frame
  private accumulator = 0           // realtime: wall seconds owed to the sim
  private simTime = 0               // sim seconds since the last scene load
  private droppedTime = 0           // realtime: wall seconds dropped by the catch-up cap (time dilation)
  private substepsTotal = 0
  private particleSubsteps = 0      // Σ particles × substeps since the last diagnostics reset
  private steppedFrames = 0         // macro-steps since the last scene load (bench clock)
  private stepLimit = Infinity      // bench: freeze the sim after this many macro-steps
  private ssfrDrewLastFrame = false  // render path of the previous presented frame
  private forceSsfrFailure = false   // bench: exercise the Points fallback
  private pointsReadbacks = 0
  private maxFrameSteps = 0         // realtime: most macro-steps run in one presented frame (≤ MAX_CATCHUP_STEPS)
  private rtSamples: { wall: number; sim: number }[] = []
  private presentIntervals: number[] = []
  private resizeObserver: ResizeObserver | null = null

  private container: HTMLDivElement
  private onStats: (s: FluidStats) => void
  private options: Required<FluidEngineOptions>

  constructor(container: HTMLDivElement, onStats: (s: FluidStats) => void, options: FluidEngineOptions = {}) {
    this.container = container
    this.onStats = onStats
    this.options = { initialScene: options.initialScene ?? 'empty' }
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

    const gpuSim = new MpmGpuSimulator()
    const simOk = await gpuSim.init(device)
    if (!simOk || this.destroyed) return false

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
      const ssfr = new SSFRPipeline({
        particleRadius: 0.025, blurRadius: 10, blurDepthFalloff: 40.0,
        refractionStrength: 0.08, absorptionScale: 0.6,
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
    this.gpuSim = gpuSim
    this.fluidScene = fluidScene
    this.ssfrPipeline = ssfrPipeline
    this.sphereMesh = sphereMesh
    this.glassBox = glassBox
    this.lastTick = performance.now()
    gpuSim.setGravity(accelToCode(this.gravityMs2))

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
    })
    this.resizeObserver.observe(this.container)

    this.animate()
    return true
  }

  private uploadCompositions() {
    this.gpuSim?.updateCompositionProps(this.compositionTable.getGpuData())
    this.ssfrPipeline?.updateMaterialProps(this.compositionTable.getRenderData())
  }

  /** FLUID TEST's default scene: a ~0.77 m block of water (≈10k particles at rest packing)
   *  released in the middle of the tank. */
  loadDefaultScene() {
    if (!this.gpuSim || this.destroyed) return
    this.lastScenario = null
    const { lo, size } = cubeForCount([0.5, 0.5, 0.5], 10000)
    const block = latticeBox(lo, size)
    this.gpuSim.spawnParticles(block.positions.map(pos => ({ pos, vel: [0, 0, 0], composition_id: 0, temperature: 20, phase: 1 })))
    this.resetClock()
    this.uploadCompositions()
  }

  /** Cells currently holding fluid, from a fresh GPU readback (spawns must not overlap them). */
  private async occupancyNow(): Promise<Set<number>> {
    const s = await this.readParticleSample()
    return s ? buildOccupancy(s.positions) : new Set()
  }

  /** Fill a block with one composition at rest packing, skipping cells already holding fluid.
   *  `rng` must be captured synchronously by the caller (benches seed Math.random only around
   *  the synchronous part of a call). Returns the number of particles actually added. */
  private addBlock(block: { lo: Vec3; size: Vec3 }, occupied: Set<number>, rng: () => number, compId: number, temperature: number, phase: number): number {
    if (!this.gpuSim) return 0
    const r = latticeBox(block.lo, block.size, { occupied, rng })
    if (r.positions.length > 0) {
      this.gpuSim.addParticles(r.positions.map(pos => ({ pos, vel: [0, 0, 0], composition_id: compId, temperature, phase })))
    }
    return r.positions.length
  }

  /** A new scene starts at sim time 0 (bench samples are indexed from here). */
  private resetClock() {
    this.steppedFrames = 0
    this.simTime = 0
    this.substepsTotal = 0
    this.accumulator = 0
  }

  /** Load (or re-load) a scenario. spawnParticles replaces everything → doubles as RESET. */
  loadScenario(s: LabScenario) {
    if (!this.gpuSim || this.destroyed) return
    this.lastScenario = s
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

    // Spawns fill blocks at rest packing; later spawns skip cells earlier ones already filled.
    const particles: GpuParticle[] = []
    const occupied = new Set<number>()
    for (const sp of s.spawns) {
      const temperature = sp.temperature ?? s.materials.find(m => m.name === sp.material)?.temperature ?? s.temperature ?? 20
      const compId = idByName.get(sp.material) ?? 0
      const block = sp.box
        ? { lo: sp.box.min.map(v => v / DOMAIN_L_M) as Vec3, size: sp.box.max.map((v, i) => (v - sp.box!.min[i]) / DOMAIN_L_M) as Vec3 }
        : cubeForCount(sp.center ?? [0.5, 0.5, 0.5], sp.count ?? 1000)
      const vel = (sp.initialVelocity ?? [0, 0, 0]).map(v => msToUnitVel(v)) as Vec3
      const r = latticeBox(block.lo, block.size, { occupied })
      for (const pos of r.positions) {
        if (particles.length >= 200_000) break
        occupied.add(cellKey(pos[0], pos[1], pos[2]))
        particles.push({ pos, vel: [...vel] as Vec3, composition_id: compId, temperature, phase: sp.phase ?? 1 })
      }
    }
    this.gpuSim.spawnParticles(particles)
    this.resetClock()
    this.setGravity(scenarioGravityMs2(s))

    if (s.ball) {
      this.ball.active = true
      this.ball.radius = s.ball.radius ?? DEFAULT_BALL_RADIUS
      this.ball.center = [...(s.ball.center ?? [0.5, 0.9, 0.5])] as [number, number, number]
      this.ball.velocity = [0, 0, 0]
      if (this.sphereMesh) {
        this.sphereMesh.visible = true
        this.sphereMesh.scale.setScalar(this.ball.radius / DEFAULT_BALL_RADIUS)
      }
    } else {
      this.ball.active = false
      this.gpuSim.clearSphereObstacle()
      if (this.sphereMesh) this.sphereMesh.visible = false
    }
  }

  /** Advance the simulation by `intervalS` of sim time: the ball and the GPU fluid, in equal
   *  substeps no longer than the verified MPM substep. One submit per call, so per-step uniforms
   *  (sphere state) can never be overwritten by a later step before the GPU runs this one. */
  private macroStep(intervalS: number) {
    const sim = this.gpuSim, device = this.device
    if (!sim || !device) return
    const { n, dtCode } = mpmSubsteps(intervalS)
    sim.setTimestep(dtCode)

    // Ball obstacle: explicit Euler per substep, gravity in tank-normalised units ([0,1]/τ²).
    if (this.ball.active) {
      const g = accelToUnitPerTau2(this.gravityMs2)
      for (let sub = 0; sub < n; sub++) {
        this.ball.velocity[1] -= g * dtCode
        this.ball.center[0] += this.ball.velocity[0] * dtCode
        this.ball.center[1] += this.ball.velocity[1] * dtCode
        this.ball.center[2] += this.ball.velocity[2] * dtCode
      }
      const lo = this.ball.radius
      const hi = 1.0 - this.ball.radius
      for (let axis = 0; axis < 3; axis++) {
        if (this.ball.center[axis] < lo) { this.ball.center[axis] = lo; this.ball.velocity[axis] = Math.abs(this.ball.velocity[axis]) * 0.3 }
        if (this.ball.center[axis] > hi) { this.ball.center[axis] = hi; this.ball.velocity[axis] = -Math.abs(this.ball.velocity[axis]) * 0.3 }
      }
      sim.setSphereObstacle(this.ball.center, this.ball.radius, this.ball.velocity)
      this.sphereMesh?.position.set(this.ball.center[0], this.ball.center[1], this.ball.center[2])
    }

    if (sim.particleCount > 0) {
      const encoder = device.createCommandEncoder()
      sim.step(encoder, n)
      device.queue.submit([encoder.finish()])
      this.particleSubsteps += n * sim.particleCount
    }
    this.steppedFrames++
    this.substepsTotal += n
    this.simTime += intervalS
  }

  private animate = () => {
    if (this.destroyed) return
    this.animId = requestAnimationFrame(this.animate)
    const sim = this.gpuSim
    const device = this.device
    const renderer = this.renderer
    const camera = this.camera
    if (!sim || !device || !renderer || !camera || !this.fluidScene) return

    const now = performance.now()
    // 60 Hz presentation: on a 240 Hz panel most rAF callbacks do nothing (lockstep benches
    // present every callback so they finish quickly — their physics does not depend on it).
    if (this.clockMode === 'realtime' && now - this.lastTick < PRESENT_MIN_MS) return
    const wallDt = (now - this.lastTick) / 1000
    this.lastTick = now
    this.presentIntervals.push(wallDt * 1000)
    if (this.presentIntervals.length > 600) this.presentIntervals.shift()

    const simBefore = this.simTime
    if (this.clockMode === 'lockstep') {
      if (this.steppedFrames < this.stepLimit) this.macroStep(this.lockstepDt)
    } else {
      this.accumulator += Math.min(wallDt, MAX_WALL_GAP_S)
      let steps = 0
      while (this.accumulator >= MACRO_DT_S - 1e-6 && steps < MAX_CATCHUP_STEPS && this.steppedFrames < this.stepLimit) {
        this.macroStep(MACRO_DT_S)
        this.accumulator -= MACRO_DT_S
        steps++
      }
      this.maxFrameSteps = Math.max(this.maxFrameSteps, steps)
      if (this.steppedFrames >= this.stepLimit) this.accumulator = 0
      if (this.accumulator >= MACRO_DT_S) {          // backlog beyond the catch-up cap: drop it
        const drop = Math.floor(this.accumulator / MACRO_DT_S) * MACRO_DT_S
        this.droppedTime += drop
        this.accumulator -= drop
      }
    }
    this.rtSamples.push({ wall: now, sim: this.simTime })
    while (this.rtSamples.length > 2 && now - this.rtSamples[0].wall > 2000) this.rtSamples.shift()

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
    if (count > 0 && this.simTime !== simBefore && !this.ssfrDrewLastFrame) {
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
        const outputView = ctx.getCurrentTexture().createView()
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
    this.gpuSim?.setGravity(accelToCode(gMs2))
  }
  get particleCount(): number { return this.gpuSim?.particleCount ?? 0 }

  /** Sim seconds advanced per wall second over the last ~2 s (1.0 = real time; <1 = dilated). */
  get rtFactor(): number {
    const a = this.rtSamples[0], b = this.rtSamples[this.rtSamples.length - 1]
    if (!a || !b || b.wall - a.wall < 250) return 1
    return (b.sim - a.sim) / ((b.wall - a.wall) / 1000)
  }

  /** Clock: 'realtime' (pages: wall-clock accumulator, 60 Hz presentation) or 'lockstep'
   *  (bench: exactly `frameDt` sim seconds per presented frame, no wall clock involved). */
  configureClock(mode: ClockMode, frameDt = MACRO_DT_S) {
    this.clockMode = mode
    this.lockstepDt = frameDt
    this.accumulator = 0
  }

  /** Register a new composition (e.g. an AI-generated material) and upload it. Returns its id. */
  addComposition(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature: number): number {
    const id = this.compositionTable.add(name, formula, elements, temperature)
    this.uploadCompositions()
    return id
  }

  /** Spawn ≈`count` particles of one composition as a block at rest packing around `center`
   *  ([0,1]³ coords), skipping cells that already hold fluid. Resolves to the number added. */
  async spawnCompositionBlock(compId: number, count: number, center: Vec3, temperature: number, phase: number): Promise<number> {
    const rng = Math.random
    const occupied = await this.occupancyNow()
    return this.addBlock(cubeForCount(center, count), occupied, rng, compId, temperature, phase)
  }

  /** Objective motion metrics from a GPU particle readback — positions in the sim's [0,1]³ space. */
  async sampleMetrics(): Promise<FluidMetricsSample | null> {
    if (!this.gpuSim || this.gpuSim.particleCount === 0) return null
    const sample = await this.gpuSim.readParticleSample()
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
  async spawnBatch(count: number): Promise<number> {
    const rng = Math.random
    const occupied = await this.occupancyNow()
    return this.addBlock(cubeForCount([0.5, 1, 0.5], count), occupied, rng, this.selectedComposition, this.spawnTemperature, 1)
  }

  /** Click-to-spawn: a ≈512-particle block (~0.29 m) of the selected material at a world point. */
  async spawnAt(worldPos: THREE.Vector3): Promise<number> {
    const rng = Math.random
    const occupied = await this.occupancyNow()
    return this.addBlock(cubeForCount([worldPos.x, worldPos.y, worldPos.z], 512), occupied, rng, this.selectedComposition, this.spawnTemperature, 1)
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
    if (!this.gpuSim) return
    this.ball.active = true
    this.ball.radius = DEFAULT_BALL_RADIUS
    this.ball.center = [0.5, 0.9, 0.5]
    this.ball.velocity = [0, 0, 0]
    if (this.sphereMesh) {
      this.sphereMesh.visible = true
      this.sphereMesh.scale.setScalar(1)
      this.sphereMesh.position.set(0.5, 0.9, 0.5)
    }
    this.gpuSim.setSphereObstacle(this.ball.center, this.ball.radius, this.ball.velocity)
  }

  removeBall() {
    this.ball.active = false
    if (this.sphereMesh) this.sphereMesh.visible = false
    this.gpuSim?.clearSphereObstacle()
  }

  /** RESET: re-run the current scenario; otherwise the page's initial scene. */
  reset() {
    if (this.lastScenario) this.loadScenario(this.lastScenario)
    else if (this.options.initialScene === 'default-water') this.loadDefaultScene()
    else { this.gpuSim?.spawnParticles([]); this.resetClock() }
  }

  // ── Bench/test surface ──────────────────────────────────────────────────────

  /** Frames the sim has advanced since the last scene load — the bench's clock. */
  get framesStepped(): number { return this.steppedFrames }
  /** Freeze the simulation after `frames` stepped frames (Infinity = run freely). */
  setStepLimit(frames: number) { this.stepLimit = frames }
  /** Raw GPU particle readback (positions/velocities/composition ids). */
  readParticleSample() { return this.gpuSim?.readParticleSample() ?? Promise.resolve(null) }

  /** Adapter for installBenchHook; `action` maps page-level user actions for scripted tests. */
  benchTarget(extra: Pick<BenchTarget, 'loadScenario' | 'action'> = {}): BenchTarget {
    return {
      framesStepped: () => this.steppedFrames,
      setStepLimit: (n) => this.setStepLimit(n),
      readParticleSample: () => this.readParticleSample(),
      compositions: () => this.getCompositions().map(c => ({ id: c.id, name: c.name })),
      fps: () => this.lastFps,
      count: () => this.particleCount,
      configure: (opts) => {
        if (opts.clock) this.configureClock(opts.clock, opts.frameDt ?? MACRO_DT_S)
        if (opts.gravityMs2 !== undefined) this.setGravity(opts.gravityMs2)
        if (opts.resetClockStats) { this.maxFrameSteps = 0; this.droppedTime = 0; this.presentIntervals = []; this.rtSamples = [] }
        if (opts.resetDiagnostics) { this.gpuSim?.resetDiagnostics(); this.particleSubsteps = 0 }
        if (opts.forceSsfrFailure !== undefined) this.forceSsfrFailure = opts.forceSsfrFailure
      },
      diagnostics: async () => {
        const d = await this.gpuSim?.readDiagnostics()
        return { clampHits: d?.clampHits ?? null, particleSubsteps: this.particleSubsteps }
      },
      extraStatus: () => {
        const iv = [...this.presentIntervals].sort((a, b) => a - b)
        return {
          clock: this.clockMode,
          simTime: this.simTime,
          substepsTotal: this.substepsTotal,
          rtFactor: this.rtFactor,
          droppedTime: this.droppedTime,
          maxFrameSteps: this.maxFrameSteps,
          renderPath: this.ssfrDrewLastFrame ? 'ssfr' : 'points',
          pointsReadbacks: this.pointsReadbacks,
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
    this.gpuSim?.destroy()
    this.fluidScene?.dispose()
    if (this.renderer) {
      this.renderer.dispose()
      try { this.container.removeChild(this.renderer.domElement) } catch { /* already removed */ }
    }
    this.renderer = null
    this.gpuSim = null
  }
}
