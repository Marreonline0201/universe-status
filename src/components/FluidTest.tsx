// ── FluidTest ────────────────────────────────────────────────────────────────
// GPU MLS-MPM Fluid Simulation with multi-material composition system
// WebGPU compute (MpmGpuSimulator) + Three.js scene rendering
// Particles render as InstancedMesh in Three.js scene — shared depth buffer
// Public demo page for universe-status site

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MpmGpuSimulator, type GpuParticle } from '../gpu-sim/MpmGpuSimulator'
import { FluidScene } from '../fluid-render/FluidScene'
import { SSFRPipeline } from '../fluid-render/SSFRPipeline'
import { CompositionTable, type NamedComposition } from '../composition/CompositionTable'
import { ContactProcessor } from '../composition/ContactProcessor'
import { MaterialGenerator } from '../ai/MaterialGenerator'
import { AutoExperimenter } from '../ai/AutoExperimenter'
import { AIChatPanel } from './AIChatPanel'
import { FluidControls, type FluidController } from './fluid/FluidControls'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_PARTICLES = 1_000_000

// Everything uses the MLS-MPM [0,1]^3 coordinate system directly.
// No coordinate mapping needed — Three.js scene, glass box, and particle
// positions all live in the same [0,1]^3 space.

// Sphere obstacle constants
const SPHERE_RADIUS_MPM = 0.1     // ~6 grid cells in MLS-MPM space (visible)
// Ball gravity must match effective fluid gravity in [0,1] space.
// Shader applies GRAVITY=-0.3 in grid-space [0,64]. In [0,1] space that's 0.3/64.
// Ball runs in [0,1] space, so divide by grid resolution.
const SPHERE_GRAVITY_MPM = 0.3 / 64

// ── Composition render props will be handled by FluidScene in a later task ──

// ── React Component ──────────────────────────────────────────────────────────

export function FluidTest() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [selectedComposition, setSelectedComposition] = useState(0)
  const [gravityVal, setGravityVal] = useState(0.5)
  const [temperatureVal, setTemperatureVal] = useState(20)
  const [fps, setFps] = useState(0)
  const [particleCount, setParticleCount] = useState(0)
  const [fpsWarning, setFpsWarning] = useState(false)
  const [gpuReady, setGpuReady] = useState(false)
  const [compositions, setCompositions] = useState<NamedComposition[]>([])
  const [ballActive, setBallActive] = useState(false)

  // Sphere obstacle physics state (in MLS-MPM coords)
  const ballRef = useRef<{
    active: boolean
    center: [number, number, number]
    velocity: [number, number, number]
    mesh: THREE.Mesh | null
  }>({ active: false, center: [0, 0, 0], velocity: [0, 0, 0], mesh: null })

  // AI state
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('anthropic-api-key') || '')
  const [autoExperimentActive, setAutoExperimentActive] = useState(false)
  const materialGenRef = useRef<MaterialGenerator | null>(null)
  const autoExpRef = useRef<AutoExperimenter | null>(null)
  const chatAddMessageRef = useRef<((role: 'user' | 'ai' | 'system', text: string) => void) | null>(null)

  // Refs for simulation state
  const simRef = useRef<{
    gpuSim: MpmGpuSimulator
    compositionTable: CompositionTable
    contactProcessor: ContactProcessor
    device: GPUDevice
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: any /* WebGPURenderer */
    controls: OrbitControls
    fluidScene: FluidScene
    ssfrPipeline: SSFRPipeline | null
    animId: number
    lastTime: number
    fpsAccum: number
    fpsFrames: number
    frameCount: number
    selectedComposition: number
    gravity: number
    temperature: number
    raycaster: THREE.Raycaster
    mouse: THREE.Vector2
    boxMesh: THREE.LineSegments
    glassBox: THREE.Mesh
    sphereMesh: THREE.Mesh
    floorMesh: THREE.Mesh
    wallMesh: THREE.Mesh
    leftWall: THREE.Mesh
    rightWall: THREE.Mesh
  } | null>(null)

  const resetSim = useCallback(() => {
    if (!simRef.current) return
    // Re-spawn initial water particles
    const { gpuSim, compositionTable } = simRef.current
    const particles: GpuParticle[] = []
    const waterId = 0
    for (let i = 0; i < 10000; i++) {
      particles.push({
        pos: [0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3],
        vel: [0, 0, 0],
        composition_id: waterId,
        temperature: 20,
        phase: 1,
      })
    }
    gpuSim.spawnParticles(particles)
    setParticleCount(particles.length)

    // Re-upload composition data
    gpuSim.updateCompositionProps(compositionTable.getGpuData())
  }, [])

  const spawnParticlesAtClick = useCallback((worldPos: THREE.Vector3) => {
    if (!simRef.current) return
    const { gpuSim, selectedComposition: compId, temperature } = simRef.current

    // World position IS MLS-MPM position — same coordinate system
    const [cx, cy, cz] = [worldPos.x, worldPos.y, worldPos.z]

    // Spawn a cluster of ~343 particles (7x7x7)
    const particles: GpuParticle[] = []
    const spacing = 0.015
    const gridSize = 7
    const jitter = spacing * 0.25

    for (let xi = 0; xi < gridSize; xi++) {
      for (let yi = 0; yi < gridSize; yi++) {
        for (let zi = 0; zi < gridSize; zi++) {
          const x = cx + (xi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
          const y = cy + (yi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
          const z = cz + (zi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
          // Clamp to MLS-MPM domain [0.02, 0.98] (with margin)
          if (x > 0.02 && x < 0.98 && y > 0.02 && y < 0.98 && z > 0.02 && z < 0.98) {
            particles.push({
              pos: [x, y, z],
              vel: [0, 0, 0],
              composition_id: compId,
              temperature: temperature,
              phase: 1,
            })
          }
        }
      }
    }

    if (particles.length > 0) {
      gpuSim.addParticles(particles)
      setParticleCount(gpuSim.particleCount)
    }
  }, [])

  const spawnBatch = useCallback((count: number) => {
    if (!simRef.current) return
    const { gpuSim, selectedComposition: compId, temperature } = simRef.current

    const particles: GpuParticle[] = []
    for (let i = 0; i < count; i++) {
      particles.push({
        pos: [0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3],
        vel: [0, 0, 0],
        composition_id: compId,
        temperature: temperature,
        phase: 1,
      })
    }
    gpuSim.addParticles(particles)
    setParticleCount(gpuSim.particleCount)
  }, [])

  const dropBall = useCallback(() => {
    if (!simRef.current) return
    const ball = ballRef.current
    ball.active = true
    ball.center = [0.5, 0.9, 0.5]  // top-center of MLS-MPM domain
    ball.velocity = [0, 0, 0]
    setBallActive(true)
    // Make Three.js mesh visible — same coordinate system, no conversion needed
    if (ball.mesh) {
      ball.mesh.visible = true
      ball.mesh.position.set(...ball.center)
    }
    // Set obstacle in simulator
    simRef.current.gpuSim.setSphereObstacle(ball.center, SPHERE_RADIUS_MPM, ball.velocity)
  }, [])

  const removeBall = useCallback(() => {
    if (!simRef.current) return
    const ball = ballRef.current
    ball.active = false
    setBallActive(false)
    if (ball.mesh) ball.mesh.visible = false
    simRef.current.gpuSim.clearSphereObstacle()
  }, [])

  // Keep refs in sync with state
  useEffect(() => {
    if (simRef.current) simRef.current.selectedComposition = selectedComposition
  }, [selectedComposition])
  useEffect(() => {
    if (simRef.current) {
      simRef.current.gravity = gravityVal
      simRef.current.gpuSim.setGravity(gravityVal)
    }
  }, [gravityVal])
  useEffect(() => {
    if (simRef.current) simRef.current.temperature = temperatureVal
  }, [temperatureVal])

  // ── AI: Update MaterialGenerator when API key changes ─────────────────────
  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('anthropic-api-key', apiKey)
      materialGenRef.current = new MaterialGenerator(apiKey)
    } else {
      materialGenRef.current = null
    }
  }, [apiKey])

  // ── AI: Spawn material via Claude API ─────────────────────────────────────
  const handleSpawnMaterial = useCallback(async (description: string): Promise<string> => {
    if (!materialGenRef.current) return 'No API key set'
    if (!simRef.current) return 'Simulation not ready'

    const result = await materialGenRef.current.generate(description)
    if (!result) return 'Could not generate material. Try a different description.'

    const { compositionTable, gpuSim } = simRef.current

    // Add to composition table
    const compId = compositionTable.add(result.name, result.formula, result.elements, result.temperature)

    // Update GPU composition data
    gpuSim.updateCompositionProps(compositionTable.getGpuData())

    // Spawn 3000 particles of the new material
    const particles: GpuParticle[] = []
    for (let i = 0; i < 3000; i++) {
      particles.push({
        pos: [0.3 + Math.random() * 0.4, 0.6 + Math.random() * 0.3, 0.3 + Math.random() * 0.4],
        vel: [0, 0, 0],
        composition_id: compId,
        temperature: result.temperature,
        phase: result.state === 'solid' ? 0 : result.state === 'liquid' ? 1 : 2,
      })
    }
    gpuSim.addParticles(particles)
    setParticleCount(gpuSim.particleCount)
    setCompositions(compositionTable.getAll())
    setSelectedComposition(compId)

    return `Spawned 3000 ${result.name} (${result.formula}) at ${result.temperature} C [${result.state}]`
  }, [])

  // ── AI: Toggle auto-experiment ────────────────────────────────────────────
  const handleToggleAutoExperiment = useCallback(() => {
    if (autoExpRef.current?.isRunning) {
      autoExpRef.current.stop()
      setAutoExperimentActive(false)
    } else {
      if (!materialGenRef.current) return
      const exp = new AutoExperimenter(
        handleSpawnMaterial,
        (msg) => {
          chatAddMessageRef.current?.('system', msg)
        },
      )
      autoExpRef.current = exp
      exp.start()
      setAutoExperimentActive(true)
    }
  }, [handleSpawnMaterial])

  // Cleanup auto-experimenter on unmount
  useEffect(() => {
    return () => {
      if (autoExpRef.current?.isRunning) {
        autoExpRef.current.stop()
      }
    }
  }, [])

  // ── Main setup and render loop ─────────────────────────────────────────────
  useEffect(() => {
    const container = canvasRef.current
    if (!container) return

    let cancelled = false

    const setup = async () => {
      // ── Initialize Three.js WebGPU renderer first ─────────────────────
      if (!navigator.gpu) {
        console.error('WebGPU not available')
        return
      }

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x060810)

      const camera = new THREE.PerspectiveCamera(
        50,
        container.clientWidth / container.clientHeight,
        0.1,
        50,
      )
      camera.position.set(2.0, 1.5, 2.0)
      camera.lookAt(0.5, 0.5, 0.5)

      // Three.js WebGPU renderer — creates the GPUDevice
      const renderer = new (THREE as any).WebGPURenderer({ antialias: true })
      await renderer.init()
      renderer.setSize(container.clientWidth, container.clientHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.2
      container.appendChild(renderer.domElement)

      // Extract the raw GPUDevice from Three.js's WebGPU backend
      const device: GPUDevice = renderer.backend.device
      if (!device) {
        console.error('Failed to get GPUDevice from Three.js WebGPU renderer')
        return
      }
      console.log('GPUDevice extracted from Three.js WebGPU backend')

      // ── Init GPU MLS-MPM simulator with the shared device ─────────────
      const gpuSim = new MpmGpuSimulator()
      const simOk = await gpuSim.init(device)
      if (!simOk || cancelled) {
        console.error('MpmGpuSimulator init failed')
        return
      }

      // Init composition system
      const compositionTable = new CompositionTable()
      compositionTable.addDefaults()
      const contactProcessor = new ContactProcessor(compositionTable)

      // Upload composition simulation props to GPU simulator
      gpuSim.updateCompositionProps(compositionTable.getGpuData())

      if (cancelled) return
      setGpuReady(true)
      setCompositions(compositionTable.getAll())

      // ── Spawn initial water particles ──────────────────────────────────
      const initParticles: GpuParticle[] = []
      for (let i = 0; i < 10000; i++) {
        initParticles.push({
          pos: [0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.3],
          vel: [0, 0, 0],
          composition_id: 0,
          temperature: 20,
          phase: 1,
        })
      }
      gpuSim.spawnParticles(initParticles)
      console.log(`Spawned ${initParticles.length} initial particles`)
      setParticleCount(initParticles.length)

      // Controls
      const controls = new OrbitControls(camera, renderer.domElement)
      controls.target.set(0.5, 0.5, 0.5)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = 1.0
      controls.maxDistance = 8

      // Lighting
      const ambientLight = new THREE.AmbientLight(0x334466, 0.6)
      scene.add(ambientLight)
      const directLight = new THREE.DirectionalLight(0xffffff, 1.0)
      directLight.position.set(3, 5, 3)
      scene.add(directLight)
      const pointLight = new THREE.PointLight(0x00aaff, 0.4, 10)
      pointLight.position.set(-2, 2, -2)
      scene.add(pointLight)

      // Glass box (wireframe edges) — unit cube [0,1]^3, matching MLS-MPM domain
      const boxGeo = new THREE.BoxGeometry(1, 1, 1)
      const edgesGeo = new THREE.EdgesGeometry(boxGeo)
      const edgesMat = new THREE.LineBasicMaterial({
        color: 0x00bbff,
        transparent: true,
        opacity: 0.35,
      })
      const boxMesh = new THREE.LineSegments(edgesGeo, edgesMat)
      boxMesh.position.set(0.5, 0.5, 0.5)  // center of [0,1]^3
      scene.add(boxMesh)

      // Glass panels
      const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x88ccff,
        transparent: true,
        opacity: 0.06,
        roughness: 0.05,
        metalness: 0.0,
        side: THREE.DoubleSide,
      })
      const glassBox = new THREE.Mesh(boxGeo, glassMat)
      glassBox.position.set(0.5, 0.5, 0.5)
      scene.add(glassBox)

      // Ground plane for click detection
      const clickPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      clickPlane.rotation.x = -Math.PI / 2
      clickPlane.position.set(0.5, 0.5, 0.5)
      scene.add(clickPlane)

      // Floor grid inside box
      const floorGeo = new THREE.PlaneGeometry(0.98, 0.98, 20, 20)
      const floorMat = new THREE.MeshBasicMaterial({
        color: 0x1a3050,
        wireframe: true,
        transparent: true,
        opacity: 0.4,
      })
      const floorMesh = new THREE.Mesh(floorGeo, floorMat)
      floorMesh.rotation.x = -Math.PI / 2
      floorMesh.position.set(0.5, 0.001, 0.5)
      scene.add(floorMesh)

      // Back wall grid
      const wallGeo = new THREE.PlaneGeometry(0.98, 0.98, 20, 15)
      const wallMat = new THREE.MeshBasicMaterial({
        color: 0x1a3050,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      })
      const wallMesh = new THREE.Mesh(wallGeo, wallMat)
      wallMesh.position.set(0.5, 0.5, 0.001)
      scene.add(wallMesh)

      // Side wall grids
      const sideGeo = new THREE.PlaneGeometry(0.98, 0.98, 15, 15)
      const sideMat = new THREE.MeshBasicMaterial({
        color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
      })
      const leftWall = new THREE.Mesh(sideGeo, sideMat)
      leftWall.rotation.y = Math.PI / 2
      leftWall.position.set(0.001, 0.5, 0.5)
      scene.add(leftWall)
      const rightWall = new THREE.Mesh(sideGeo, sideMat)
      rightWall.rotation.y = Math.PI / 2
      rightWall.position.set(0.999, 0.5, 0.5)
      scene.add(rightWall)

      // Droppable metal sphere — radius in MLS-MPM [0,1] space directly
      const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS_MPM, 32, 32)
      const sphereMat = new THREE.MeshStandardMaterial({
        color: 0x888888,
        metalness: 0.95,
        roughness: 0.15,
      })
      const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat)
      sphereMesh.visible = false  // hidden until dropped
      scene.add(sphereMesh)
      ballRef.current.mesh = sphereMesh

      // ── Fluid particle rendering ──────────────────────────────────────
      const fluidScene = new FluidScene(scene)
      fluidScene.init(device)

      // SSFR pipeline: real fluid rendering (depth spheres, blur, composite)
      let ssfrPipeline: SSFRPipeline | null = null
      try {
        const ssfr = new SSFRPipeline({
          particleRadius: 0.025,
          blurRadius: 10,
          blurDepthFalloff: 40.0,
          // Water IOR ≈ 1.333. Refraction is small but visible.
          refractionStrength: 0.08,
          // Multiplier on Beer-Lambert RGB coefficients (0.45/0.09/0.04).
          // 0.6 keeps the blue tint without absorbing the bg to black
          // when particles clump and thickness spikes.
          absorptionScale: 0.6,
        })
        await ssfr.init(device, container.clientWidth, container.clientHeight)
        ssfrPipeline = ssfr
        console.log('SSFR pipeline active — real fluid rendering')
      } catch (e) {
        console.warn('SSFR init failed, using Points fallback:', e)
      }

      // Raycaster for click-to-spawn
      const raycaster = new THREE.Raycaster()
      const mouse = new THREE.Vector2()

      // ── Store in ref ──────────────────────────────────────────────────
      simRef.current = {
        gpuSim,
        compositionTable,
        contactProcessor,
        device,
        scene,
        camera,
        renderer,
        controls,
        fluidScene,
        ssfrPipeline,
        animId: 0,
        lastTime: performance.now(),
        fpsAccum: 0,
        fpsFrames: 0,
        frameCount: 0,
        selectedComposition: 0,
        gravity: 9.81,
        temperature: 20,
        raycaster,
        mouse,
        boxMesh,
        glassBox,
        sphereMesh,
        floorMesh,
        wallMesh,
        leftWall,
        rightWall,
      }

      // ── Click handler ─────────────────────────────────────────────────
      const onPointerDown = (e: PointerEvent) => {
        if (!simRef.current) return
        if (e.button !== 0) return
        const rect = renderer.domElement.getBoundingClientRect()
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

        raycaster.setFromCamera(mouse, camera)

        const intersects = raycaster.intersectObject(glassBox)
        if (intersects.length > 0) {
          const pt = intersects[0].point
          // Clamp to [0.05, 0.95] to keep spawn away from walls
          spawnParticlesAtClick(new THREE.Vector3(
            Math.max(0.05, Math.min(0.95, pt.x)),
            Math.max(0.05, Math.min(0.95, pt.y)),
            Math.max(0.05, Math.min(0.95, pt.z)),
          ))
        }
      }
      renderer.domElement.addEventListener('pointerdown', onPointerDown)

      // ── Animation loop ────────────────────────────────────────────────
      const animate = () => {
        const sim = simRef.current
        if (!sim) return
        sim.animId = requestAnimationFrame(animate)

        const now = performance.now()
        const rawDt = (now - sim.lastTime) / 1000
        sim.lastTime = now

        // FPS tracking
        sim.fpsAccum += rawDt
        sim.fpsFrames++
        if (sim.fpsAccum >= 0.5) {
          const currentFps = Math.round(sim.fpsFrames / sim.fpsAccum)
          setFps(currentFps)
          setFpsWarning(currentFps < 30 && sim.gpuSim.particleCount > 100)
          sim.fpsAccum = 0
          sim.fpsFrames = 0
        }

        sim.frameCount++
        const count = sim.gpuSim.particleCount

        // Update sphere obstacle physics (Euler integration matching MLS-MPM)
        // Ball runs in [0,1] space. Fluid sim runs 2 substeps × dt=0.2 per frame.
        // Ball must match: 2 substeps, same dt, gravity scaled from grid-space to [0,1].
        const ball = ballRef.current
        if (ball.active) {
          const simDt = 0.2  // match MLS-MPM substep dt
          for (let sub = 0; sub < 2; sub++) {
            ball.velocity[1] -= SPHERE_GRAVITY_MPM * simDt
            ball.center[0] += ball.velocity[0] * simDt
            ball.center[1] += ball.velocity[1] * simDt
            ball.center[2] += ball.velocity[2] * simDt
          }

          // Bounce off domain boundaries (with margin for sphere radius)
          const lo = SPHERE_RADIUS_MPM
          const hi = 1.0 - SPHERE_RADIUS_MPM
          for (let axis = 0; axis < 3; axis++) {
            if (ball.center[axis] < lo) {
              ball.center[axis] = lo
              ball.velocity[axis] = Math.abs(ball.velocity[axis]) * 0.3  // damped bounce
            }
            if (ball.center[axis] > hi) {
              ball.center[axis] = hi
              ball.velocity[axis] = -Math.abs(ball.velocity[axis]) * 0.3
            }
          }

          // Update GPU obstacle
          sim.gpuSim.setSphereObstacle(ball.center, SPHERE_RADIUS_MPM, ball.velocity)

          // Update Three.js mesh position — same coordinate system
          if (ball.mesh) {
            ball.mesh.position.set(ball.center[0], ball.center[1], ball.center[2])
          }
        }

        if (count > 0) {
          // GPU compute: MLS-MPM step (clearGrid -> P2G -> forces -> G2P x2 substeps)
          const encoder = sim.device.createCommandEncoder()
          sim.gpuSim.step(encoder)

          // Schedule particle position readback for rendering
          sim.fluidScene.scheduleReadback(encoder, sim.gpuSim.particleBuffer, count)
          sim.device.queue.submit([encoder.finish()])

          // Start async readback — updates instance matrices one frame behind
          sim.fluidScene.startReadback(count)

          setParticleCount(count)
        }

        // Update orbit controls
        sim.controls.update()

        // Render: SSFR (depth spheres + blur + composite) or Points fallback
        let ssfrOk = false
        if (sim.ssfrPipeline && count > 0) {
          try {
            sim.camera.updateMatrixWorld()
            const ctx = sim.renderer.backend.context as GPUCanvasContext
            const outputView = ctx.getCurrentTexture().createView()

            const invViewMat = sim.camera.matrixWorld  // matrixWorld = inverse of matrixWorldInverse
            // Enable error logging on first frame
            if (sim.frameCount < 2) {
              sim.device.pushErrorScope('validation')
            }

            const encoder2 = sim.device.createCommandEncoder()
            const ballSnapshot = ballRef.current.active
              ? {
                  center: [...ballRef.current.center] as [number, number, number],
                  radius: SPHERE_RADIUS_MPM,
                  active: true,
                }
              : undefined
            sim.ssfrPipeline.render(
              encoder2,
              sim.gpuSim.particleBuffer,
              count,
              new Float32Array(sim.camera.matrixWorldInverse.elements),
              new Float32Array(sim.camera.projectionMatrix.elements),
              new Float32Array(sim.camera.projectionMatrixInverse.elements),
              new Float32Array(invViewMat.elements),
              outputView,
              ballSnapshot,
            )
            sim.device.queue.submit([encoder2.finish()])

            // Check for GPU validation errors on first frame
            if (sim.frameCount < 2) {
              sim.device.popErrorScope().then((err: any) => {
                if (err) console.error('[SSFR GPU ERROR]', err.message)
                else console.log('[SSFR] No GPU validation errors')
              })
            }
            ssfrOk = true
          } catch (e: any) {
            if (sim.frameCount < 3) console.warn('[SSFR] Render error:', e?.message || e)
          }
        }
        if (!ssfrOk) {
          sim.renderer.render(sim.scene, sim.camera)
        }
      }

      animate()

      // ── Resize handler ────────────────────────────────────────────────
      const onResize = () => {
        if (!container || !simRef.current) return
        const w = container.clientWidth
        const h = container.clientHeight
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      }
      window.addEventListener('resize', onResize)

      // Store cleanup references
      cleanupRef.onResize = onResize
      cleanupRef.onPointerDown = onPointerDown
      cleanupRef.renderer = renderer
      cleanupRef.container = container
    }

    // Cleanup refs
    const cleanupRef: {
      onResize?: () => void
      onPointerDown?: (e: PointerEvent) => void
      renderer?: any
      container?: HTMLDivElement
    } = {}

    setup()

    // ── Cleanup ───────────────────────────────────────────────────────
    return () => {
      cancelled = true
      if (cleanupRef.onResize) {
        window.removeEventListener('resize', cleanupRef.onResize)
      }
      if (cleanupRef.renderer && cleanupRef.onPointerDown) {
        cleanupRef.renderer.domElement.removeEventListener('pointerdown', cleanupRef.onPointerDown)
      }
      if (simRef.current) {
        cancelAnimationFrame(simRef.current.animId)
        simRef.current.gpuSim.destroy()
        simRef.current.fluidScene.dispose()
      }
      if (cleanupRef.renderer) {
        cleanupRef.renderer.dispose()
      }
      if (cleanupRef.container && cleanupRef.renderer) {
        try {
          cleanupRef.container.removeChild(cleanupRef.renderer.domElement)
        } catch (_) {
          // Element may already be removed
        }
      }
      simRef.current = null
    }
  }, [spawnParticlesAtClick])

  // Adapter over simRef state/closures → the shared FluidControls panel (same one the LAB page uses).
  const ftController: FluidController = {
    gpuReady, compositions, selectedComposition,
    setSelectedComposition,
    spawnBatch,
    ballActive, dropBall, removeBall,
    gravity: gravityVal, setGravity: setGravityVal,
    temperature: temperatureVal, setTemperature: setTemperatureVal,
    reset: resetSim,
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#060810',
      color: '#c0d0e0',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        borderBottom: '1px solid rgba(0,180,255,0.1)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 12,
            fontWeight: 700,
            color: '#00d4ff',
            letterSpacing: 2,
          }}>
            GPU MLS-MPM FLUID
          </span>
          <span style={{
            fontSize: 9,
            color: 'rgba(100,150,200,0.5)',
            letterSpacing: 1,
          }}>
            WebGPU Compute + SSFR
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {fpsWarning && (
            <span style={{
              fontSize: 9,
              color: '#ffaa00',
              letterSpacing: 1,
              animation: 'blockedPulse 1.2s ease-in-out infinite',
            }}>
              LOW FPS
            </span>
          )}
          <span style={{
            fontSize: 10,
            color: fps >= 50 ? '#00ff88' : fps >= 30 ? '#ffaa00' : '#ff4444',
            letterSpacing: 1,
          }}>
            FPS: {fps}
          </span>
          {gpuReady && (
            <span style={{
              fontSize: 8,
              fontWeight: 700,
              color: '#000',
              background: '#00ff88',
              padding: '1px 5px',
              borderRadius: 3,
              letterSpacing: 1,
            }}>
              GPU
            </span>
          )}
          <span style={{
            fontSize: 10,
            color: 'rgba(100,150,200,0.6)',
            letterSpacing: 1,
          }}>
            N: {particleCount} / {MAX_PARTICLES}
          </span>
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* 3D Canvas */}
        <div
          ref={canvasRef}
          style={{
            flex: 1,
            minWidth: 0,
            cursor: 'crosshair',
            position: 'relative',
          }}
        >
          {/* Click hint overlay */}
          {!gpuReady && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontSize: 13,
              color: 'rgba(0,180,255,0.35)',
              letterSpacing: 2,
              pointerEvents: 'none',
              textAlign: 'center',
              lineHeight: 2,
            }}>
              INITIALIZING GPU...
              <br />
              <span style={{ fontSize: 10, opacity: 0.6 }}>
                Setting up WebGPU compute + SSFR render
              </span>
            </div>
          )}
        </div>

        {/* Right Panel: Controls + AI Chat */}
        <div style={{
          width: 260,
          flexShrink: 0,
          borderLeft: '1px solid rgba(0,180,255,0.1)',
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(4,8,18,0.6)',
        }}>
        {/* Control Panel (60%) \u2014 hands-on controls, shared with the LAB page */}
        <div style={{ flex: '0 0 60%', minHeight: 0 }}>
          <FluidControls controller={ftController} />
        </div>

        {/* AI Chat Panel (40%) */}
        <div style={{ flex: '0 0 40%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* API Key input (only shows if no key stored) */}
          {!apiKey && (
            <div style={{
              padding: '8px 10px',
              borderTop: '1px solid rgba(0,180,255,0.1)',
              display: 'flex',
              gap: 4,
            }}>
              <input
                type="password"
                placeholder="Anthropic API key..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setApiKey((e.target as HTMLInputElement).value)
                  }
                }}
                style={{
                  flex: 1,
                  background: 'rgba(0,180,255,0.04)',
                  border: '1px solid rgba(0,180,255,0.15)',
                  borderRadius: 3,
                  padding: '4px 8px',
                  color: '#c0d0e0',
                  fontSize: 9,
                  fontFamily: 'inherit',
                  outline: 'none',
                }}
              />
              <button
                onClick={(e) => {
                  const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement
                  if (input?.value) setApiKey(input.value)
                }}
                style={{
                  background: 'rgba(0,255,136,0.08)',
                  border: '1px solid rgba(0,255,136,0.2)',
                  borderRadius: 3,
                  padding: '4px 8px',
                  color: 'rgba(0,255,136,0.6)',
                  fontSize: 8,
                  fontFamily: 'inherit',
                  letterSpacing: 1,
                  cursor: 'pointer',
                }}
              >
                SET
              </button>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <AIChatPanel
              onSpawnMaterial={handleSpawnMaterial}
              onSetTemperature={(temp) => setTemperatureVal(temp)}
              autoExperimentActive={autoExperimentActive}
              onToggleAutoExperiment={handleToggleAutoExperiment}
              disabled={!apiKey}
            />
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

// (labelStyle / sliderStyle / valueStyle / InfoRow moved to ./fluid/FluidControls.tsx —
//  now shared with the LABORATORY page's control panel.)
