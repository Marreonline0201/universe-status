// Lab fluid engine: a plain (non-React) class that runs an agent-authored
// scenario in the same WebGPU MLS-MPM sim as the FLUID TEST page. Mirrors
// FluidTest.tsx's bootstrap (296-493), loop (553-683), and cleanup (714-738)
// minus the UI/AI/click-spawn code. No agent code runs here — scenarios are
// pure data (see scenario.ts).
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MpmGpuSimulator, type GpuParticle } from '../gpu-sim/MpmGpuSimulator'
import { FluidScene } from '../fluid-render/FluidScene'
import { SSFRPipeline } from '../fluid-render/SSFRPipeline'
import { CompositionTable, type NamedComposition } from '../composition/CompositionTable'
import { elementsAs, type LabScenario } from './scenario'

const DEFAULT_BALL_RADIUS = 0.1
const BALL_GRAVITY = 0.3 / 64 // shader gravity in [0,1] space (see FluidTest.tsx:28-32)

export interface LabStats { fps: number; count: number }

export class LabFluidEngine {
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
  // Hands-on control state (parity with FLUID TEST). The composition table is
  // persistent (starts with defaults) so the material picker + manual spawns work
  // even before/independently of a scenario.
  private compositionTable = new CompositionTable()
  private selectedComposition = 0
  private spawnTemperature = 20
  private lastScenario: LabScenario | null = null
  private glassBox: THREE.Mesh | null = null
  private raycaster = new THREE.Raycaster()
  private currentGravity = 0.3
  private animId = 0
  private lastTime = 0
  private fpsAccum = 0
  private fpsFrames = 0
  private frameCount = 0
  private resizeObserver: ResizeObserver | null = null

  private container: HTMLDivElement
  private onStats: (s: LabStats) => void

  constructor(container: HTMLDivElement, onStats: (s: LabStats) => void) {
    this.container = container
    this.onStats = onStats
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) return false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xb1b366)
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

    // Lighting + tank furniture (mirrors FluidTest 374-467, minus click plane)
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
      ssfrPipeline = ssfr
    } catch (e) {
      console.warn('[lab] SSFR init failed, using Points fallback:', e)
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
    this.lastTime = performance.now()

    // Seed the composition table with defaults so the material picker + manual
    // spawns work immediately (parity with FluidTest.tsx:340-345).
    this.compositionTable.addDefaults()
    gpuSim.updateCompositionProps(this.compositionTable.getGpuData())

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

  /** Load (or re-load) a scenario. spawnParticles replaces everything → doubles as RESET. */
  loadScenario(s: LabScenario) {
    if (!this.gpuSim || this.destroyed) return
    this.lastScenario = s
    // Fresh table seeded with defaults, then the scenario's materials — so the
    // material picker + manual spawns keep the built-in materials AND the scenario's.
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
    this.gpuSim.updateCompositionProps(table.getGpuData())

    const particles: GpuParticle[] = []
    for (const sp of s.spawns) {
      const spread = sp.spread ?? 0.1
      const temperature = sp.temperature ?? s.materials.find(m => m.name === sp.material)?.temperature ?? s.temperature ?? 20
      const compId = idByName.get(sp.material) ?? 0
      for (let i = 0; i < sp.count && particles.length < 200_000; i++) {
        particles.push({
          pos: [
            Math.min(0.98, Math.max(0.02, sp.center[0] + (Math.random() - 0.5) * 2 * spread)),
            Math.min(0.98, Math.max(0.02, sp.center[1] + (Math.random() - 0.5) * 2 * spread)),
            Math.min(0.98, Math.max(0.02, sp.center[2] + (Math.random() - 0.5) * 2 * spread)),
          ],
          vel: [0, 0, 0],
          composition_id: compId,
          temperature,
          phase: sp.phase ?? 1,
        })
      }
    }
    this.gpuSim.spawnParticles(particles)
    this.currentGravity = s.gravity ?? 0.3
    this.gpuSim.setGravity(this.currentGravity)

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

  private animate = () => {
    if (this.destroyed) return
    this.animId = requestAnimationFrame(this.animate)
    const sim = this.gpuSim
    const device = this.device
    const renderer = this.renderer
    const camera = this.camera
    if (!sim || !device || !renderer || !camera || !this.fluidScene) return

    const now = performance.now()
    const rawDt = (now - this.lastTime) / 1000
    this.lastTime = now
    this.fpsAccum += rawDt
    this.fpsFrames++
    if (this.fpsAccum >= 0.5) {
      this.onStats({ fps: Math.round(this.fpsFrames / this.fpsAccum), count: sim.particleCount })
      this.fpsAccum = 0
      this.fpsFrames = 0
    }
    this.frameCount++

    // Ball obstacle physics — mirrors FluidTest 577-611.
    if (this.ball.active) {
      const simDt = 0.2
      for (let sub = 0; sub < 2; sub++) {
        this.ball.velocity[1] -= BALL_GRAVITY * simDt
        this.ball.center[0] += this.ball.velocity[0] * simDt
        this.ball.center[1] += this.ball.velocity[1] * simDt
        this.ball.center[2] += this.ball.velocity[2] * simDt
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

    const count = sim.particleCount
    if (count > 0) {
      const encoder = device.createCommandEncoder()
      sim.step(encoder)
      this.fluidScene.scheduleReadback(encoder, sim.particleBuffer, count)
      device.queue.submit([encoder.finish()])
      this.fluidScene.startReadback(count)
    }

    this.controls?.update()

    // SSFR render or Points fallback — mirrors FluidTest 631-680.
    let ssfrOk = false
    if (this.ssfrPipeline && count > 0) {
      try {
        camera.updateMatrixWorld()
        const ctx = renderer.backend.context as GPUCanvasContext
        const outputView = ctx.getCurrentTexture().createView()
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
        ssfrOk = true
      } catch (e) {
        if (this.frameCount < 3) console.warn('[lab] SSFR render error:', e)
      }
    }
    if (!ssfrOk && this.scene) renderer.render(this.scene, camera)
  }

  // ── Hands-on controls (parity with FLUID TEST) ──────────────────────────────

  getCompositions(): NamedComposition[] { return this.compositionTable.getAll() }
  get selectedCompositionId(): number { return this.selectedComposition }
  setSelectedComposition(id: number) { this.selectedComposition = id }
  get spawnTemp(): number { return this.spawnTemperature }
  setTemperature(t: number) { this.spawnTemperature = t }
  get ballActive(): boolean { return this.ball.active }
  get gravity(): number { return this.currentGravity }
  setGravity(g: number) { this.currentGravity = g; this.gpuSim?.setGravity(g) }

  /** +N button: add `count` particles of the selected material in the center. */
  spawnBatch(count: number) {
    if (!this.gpuSim) return
    const particles: GpuParticle[] = []
    for (let i = 0; i < count; i++) {
      particles.push({
        pos: [0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3],
        vel: [0, 0, 0], composition_id: this.selectedComposition, temperature: this.spawnTemperature, phase: 1,
      })
    }
    this.gpuSim.addParticles(particles)
  }

  /** Click-to-spawn: a 7×7×7 cluster of the selected material at a world point. */
  spawnAt(worldPos: THREE.Vector3) {
    if (!this.gpuSim) return
    const [cx, cy, cz] = [worldPos.x, worldPos.y, worldPos.z]
    const particles: GpuParticle[] = []
    const spacing = 0.015, gridSize = 7, jitter = spacing * 0.25
    for (let xi = 0; xi < gridSize; xi++) for (let yi = 0; yi < gridSize; yi++) for (let zi = 0; zi < gridSize; zi++) {
      const x = cx + (xi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
      const y = cy + (yi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
      const z = cz + (zi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
      if (x > 0.02 && x < 0.98 && y > 0.02 && y < 0.98 && z > 0.02 && z < 0.98) {
        particles.push({ pos: [x, y, z], vel: [0, 0, 0], composition_id: this.selectedComposition, temperature: this.spawnTemperature, phase: 1 })
      }
    }
    if (particles.length > 0) this.gpuSim.addParticles(particles)
  }

  /** Raycast a screen click against the glass box and spawn at the hit point. */
  spawnAtPointer(clientX: number, clientY: number) {
    if (!this.camera || !this.glassBox) return
    const rect = this.container.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObject(this.glassBox, false)[0]
    if (hit) this.spawnAt(hit.point)
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

  /** RESET: re-run the current scenario, or clear to empty if none was loaded. */
  reset() {
    if (this.lastScenario) this.loadScenario(this.lastScenario)
    else this.gpuSim?.spawnParticles([])
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
