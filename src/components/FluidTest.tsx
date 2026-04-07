// ── FluidTest ────────────────────────────────────────────────────────────────
// GPU MLS-MPM Fluid Simulation with multi-material composition system
// Replaces WASM CPU solver with WebGPU compute (MpmGpuSimulator)
// SSFR rendering via FluidRenderer — shares GPU device + particle buffer
// Public demo page for universe-status site

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { FluidRenderer } from '../fluid-render/FluidRenderer'
import { MpmGpuSimulator, type GpuParticle } from '../gpu-sim/MpmGpuSimulator'
import { CompositionTable, type NamedComposition } from '../composition/CompositionTable'
import { ContactProcessor } from '../composition/ContactProcessor'
import { MaterialGenerator } from '../ai/MaterialGenerator'
import { AutoExperimenter } from '../ai/AutoExperimenter'
import { AIChatPanel } from './AIChatPanel'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_PARTICLES = 40_000

// Glass box dimensions in Three.js world space
const BOX_W = 2.0
const BOX_H = 1.5
const BOX_D = 1.5
const HALF_W = BOX_W / 2
const HALF_H = BOX_H / 2
const HALF_D = BOX_D / 2

// Coordinate mapping: MLS-MPM domain [0,1] <-> Three.js world space
// MLS-MPM (0.5, 0.5, 0.5) maps to Three.js (0, 0, 0)
// MLS-MPM (0, 0, 0) maps to Three.js (-1.0, -0.75, -0.75)
// MLS-MPM (1, 1, 1) maps to Three.js (1.0, 0.75, 0.75)

function worldToMpm(x: number, y: number, z: number): [number, number, number] {
  return [
    x / BOX_W + 0.5,
    y / BOX_H + 0.5,
    z / BOX_D + 0.5,
  ]
}

// ── Build composition render props for FluidRenderer ─────────────────────────
// FluidRenderer expects 12 floats per composition (48 bytes):
// [color_r, color_g, color_b, density, F0, metalness, emissive, IOR, specular_power, opacity_density, pad, pad]
function buildCompositionRenderProps(table: CompositionTable): Float32Array {
  const all = table.getAll()
  const data = new Float32Array(256 * 12) // 256 max compositions * 12 floats
  for (const comp of all) {
    const base = comp.id * 12
    data[base + 0] = comp.props.color[0]
    data[base + 1] = comp.props.color[1]
    data[base + 2] = comp.props.color[2]
    data[base + 3] = comp.props.opacityDensity
    data[base + 4] = comp.props.F0
    data[base + 5] = comp.props.metalness
    data[base + 6] = comp.props.emissive
    data[base + 7] = comp.props.IOR
    data[base + 8] = comp.props.specularPower
    data[base + 9] = comp.props.opacityDensity
    // 10-11: padding
  }
  return data
}

// ── React Component ──────────────────────────────────────────────────────────

export function FluidTest() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [selectedComposition, setSelectedComposition] = useState(0)
  const [gravityVal, setGravityVal] = useState(0.5)
  const [temperatureVal, setTemperatureVal] = useState(20)
  const [fps, setFps] = useState(0)
  const [particleCount, setParticleCount] = useState(0)
  const [showInfo, setShowInfo] = useState(true)
  const [fpsWarning, setFpsWarning] = useState(false)
  const [gpuReady, setGpuReady] = useState(false)
  const [compositions, setCompositions] = useState<NamedComposition[]>([])

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
    fluidRenderer: FluidRenderer
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

    // Convert world position to MLS-MPM space
    const [cx, cy, cz] = worldToMpm(worldPos.x, worldPos.y, worldPos.z)

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

    const { compositionTable, gpuSim, fluidRenderer } = simRef.current

    // Add to composition table
    const compId = compositionTable.add(result.name, result.formula, result.elements, result.temperature)

    // Update GPU composition data
    gpuSim.updateCompositionProps(compositionTable.getGpuData())
    fluidRenderer.updateCompositionRenderProps(buildCompositionRenderProps(compositionTable))

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
      // ── Initialize WebGPU ────────────────────────────────────────────
      if (!navigator.gpu) {
        console.error('WebGPU not available')
        return
      }

      // Init FluidRenderer first — it creates the device + overlay canvas
      const fluidRenderer = new FluidRenderer()
      const frOk = await fluidRenderer.init(container, container.clientWidth, container.clientHeight)
      if (!frOk || cancelled) {
        console.error('FluidRenderer init failed')
        return
      }

      // Share the FluidRenderer's device with the simulator
      const device = fluidRenderer.gpuDevice

      // Init GPU MLS-MPM simulator
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

      // Upload composition render props to FluidRenderer
      fluidRenderer.updateCompositionRenderProps(buildCompositionRenderProps(compositionTable))

      // Connect simulator particle buffer to renderer
      fluidRenderer.setParticleBuffer(gpuSim.getParticleBuffer())

      // Set initial fluid material from water (composition 0)
      const waterComp = compositionTable.get(0)
      if (waterComp) {
        fluidRenderer.setFluidMaterial({
          r: waterComp.props.color[0],
          g: waterComp.props.color[1],
          b: waterComp.props.color[2],
          density: waterComp.props.opacityDensity,
          F0: waterComp.props.F0,
          emissive: waterComp.props.emissive,
          specularPower: waterComp.props.specularPower,
          metalness: waterComp.props.metalness,
          ior: waterComp.props.IOR,
        })
      }

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
      setParticleCount(initParticles.length)

      // ── Three.js Scene ─────────────────────────────────────────────────
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x060810)

      const camera = new THREE.PerspectiveCamera(
        50,
        container.clientWidth / container.clientHeight,
        0.1,
        50,
      )
      camera.position.set(2.5, 1.8, 2.5)
      camera.lookAt(0, 0, 0)

      // Renderer — WebGPU with WebGL fallback
      const renderer = new (THREE as any).WebGPURenderer({ antialias: true })
      await renderer.init()
      renderer.setSize(container.clientWidth, container.clientHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.2
      container.appendChild(renderer.domElement)

      // Controls
      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = 1.5
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

      // Glass box (wireframe edges)
      const boxGeo = new THREE.BoxGeometry(BOX_W, BOX_H, BOX_D)
      const edgesGeo = new THREE.EdgesGeometry(boxGeo)
      const edgesMat = new THREE.LineBasicMaterial({
        color: 0x00bbff,
        transparent: true,
        opacity: 0.35,
      })
      const boxMesh = new THREE.LineSegments(edgesGeo, edgesMat)
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
      scene.add(glassBox)

      // Ground plane for click detection
      const clickPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(BOX_W, BOX_D),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      clickPlane.rotation.x = -Math.PI / 2
      clickPlane.position.y = 0
      scene.add(clickPlane)

      // Floor grid inside box
      const floorGeo = new THREE.PlaneGeometry(BOX_W - 0.02, BOX_D - 0.02, 20, 20)
      const floorMat = new THREE.MeshBasicMaterial({
        color: 0x1a3050,
        wireframe: true,
        transparent: true,
        opacity: 0.4,
      })
      const floorMesh = new THREE.Mesh(floorGeo, floorMat)
      floorMesh.rotation.x = -Math.PI / 2
      floorMesh.position.y = -HALF_H + 0.001
      scene.add(floorMesh)

      // Back wall grid
      const wallGeo = new THREE.PlaneGeometry(BOX_W - 0.02, BOX_H - 0.02, 20, 15)
      const wallMat = new THREE.MeshBasicMaterial({
        color: 0x1a3050,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      })
      const wallMesh = new THREE.Mesh(wallGeo, wallMat)
      wallMesh.position.z = -HALF_D + 0.001
      scene.add(wallMesh)

      // Side wall grids
      const sideGeo = new THREE.PlaneGeometry(BOX_D - 0.02, BOX_H - 0.02, 15, 15)
      const sideMat = new THREE.MeshBasicMaterial({
        color: 0x1a3050, wireframe: true, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
      })
      const leftWall = new THREE.Mesh(sideGeo, sideMat)
      leftWall.rotation.y = Math.PI / 2
      leftWall.position.x = -HALF_W + 0.001
      scene.add(leftWall)
      const rightWall = new THREE.Mesh(sideGeo, sideMat)
      rightWall.rotation.y = Math.PI / 2
      rightWall.position.x = HALF_W - 0.001
      scene.add(rightWall)

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
        fluidRenderer,
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
          const spawnY = Math.min(HALF_H - 0.15, Math.max(-HALF_H + 0.15, pt.y))
          spawnParticlesAtClick(new THREE.Vector3(
            Math.max(-HALF_W + 0.2, Math.min(HALF_W - 0.2, pt.x)),
            spawnY,
            Math.max(-HALF_D + 0.2, Math.min(HALF_D - 0.2, pt.z)),
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

        if (count > 0) {
          // GPU compute: MLS-MPM step (clearGrid -> P2G -> forces -> G2P x2 substeps)
          const encoder = sim.device.createCommandEncoder()
          sim.gpuSim.step(encoder)
          sim.device.queue.submit([encoder.finish()])

          // Update camera for SSFR rendering
          const viewMat = new Float32Array(16)
          sim.camera.matrixWorldInverse.toArray(viewMat)
          const fov = sim.camera.fov * Math.PI / 180
          sim.fluidRenderer.updateCamera(viewMat, fov, sim.camera.aspect, sim.camera.near, sim.camera.far, 0.12)

          setParticleCount(count)
        }

        // Update orbit controls
        sim.controls.update()

        // Render: Three.js scene first
        sim.renderer.render(sim.scene, sim.camera)

        // SSFR fluid rendering — every frame
        if (sim.fluidRenderer.isInitialized) {
          if (count > 0) {
            sim.fluidRenderer.captureScene(sim.renderer.domElement as HTMLCanvasElement)
          }
          sim.fluidRenderer.render(count, now / 1000)
        }

        // Contact processing — DISABLED until multiple compositions are spawned.
        // The O(n²) contact detection shader kills FPS with >5k single-material particles.
        // TODO: Enable when user spawns a second material, and use spatial hashing.
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
        simRef.current.fluidRenderer.dispose()
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

  // Currently selected composition details
  const selectedComp = compositions[selectedComposition]

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
        {/* Control Panel (60%) */}
        <div style={{
          flex: '0 0 60%',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflowY: 'auto',
        }}>
          {/* Active Compositions List */}
          <div>
            <label style={labelStyle}>MATERIALS</label>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxHeight: 200,
              overflowY: 'auto',
            }}>
              {compositions.map((comp) => (
                <button
                  key={comp.id}
                  onClick={() => setSelectedComposition(comp.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 8px',
                    cursor: 'pointer',
                    background: selectedComposition === comp.id
                      ? 'rgba(0,180,255,0.15)'
                      : 'rgba(0,180,255,0.03)',
                    border: `1px solid ${selectedComposition === comp.id
                      ? 'rgba(0,180,255,0.4)'
                      : 'rgba(0,180,255,0.1)'}`,
                    borderRadius: 3,
                    color: '#c0d0e0',
                    fontFamily: 'inherit',
                    fontSize: 10,
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  {/* Color swatch */}
                  <div style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    flexShrink: 0,
                    background: `rgb(${Math.round(comp.props.color[0] * 255)},${Math.round(comp.props.color[1] * 255)},${Math.round(comp.props.color[2] * 255)})`,
                    boxShadow: comp.props.emissive > 0
                      ? `0 0 6px rgb(${Math.round(comp.props.color[0] * 255)},${Math.round(comp.props.color[1] * 255)},${Math.round(comp.props.color[2] * 255)})`
                      : 'none',
                  }} />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {comp.name}
                  </div>
                  <span style={{ fontSize: 8, color: 'rgba(100,150,200,0.4)', flexShrink: 0 }}>
                    {comp.formula}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Spawn button */}
          <button
            onClick={() => spawnBatch(3000)}
            disabled={!gpuReady}
            style={{
              padding: '7px 0',
              background: gpuReady ? 'rgba(0,180,255,0.1)' : 'rgba(0,180,255,0.03)',
              border: '1px solid rgba(0,180,255,0.3)',
              borderRadius: 3,
              color: gpuReady ? '#00d4ff' : 'rgba(100,150,200,0.3)',
              fontSize: 10,
              fontFamily: 'inherit',
              letterSpacing: 2,
              cursor: gpuReady ? 'pointer' : 'default',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              if (gpuReady) (e.target as HTMLButtonElement).style.background = 'rgba(0,180,255,0.2)'
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.background = gpuReady ? 'rgba(0,180,255,0.1)' : 'rgba(0,180,255,0.03)'
            }}
          >
            SPAWN 3K {selectedComp ? selectedComp.name.toUpperCase() : ''}
          </button>

          {/* Temperature slider */}
          <div>
            <label style={labelStyle}>TEMPERATURE</label>
            <input
              type="range"
              min={-50}
              max={2000}
              step={10}
              value={temperatureVal}
              onChange={(e) => setTemperatureVal(Number(e.target.value))}
              style={sliderStyle}
            />
            <div style={valueStyle}>{temperatureVal} C</div>
          </div>

          {/* Gravity slider */}
          <div>
            <label style={labelStyle}>GRAVITY</label>
            <input
              type="range"
              min={0}
              max={2.0}
              step={0.01}
              value={gravityVal}
              onChange={(e) => setGravityVal(Number(e.target.value))}
              style={sliderStyle}
            />
            <div style={valueStyle}>{gravityVal.toFixed(2)}</div>
          </div>

          {/* Reset button */}
          <button
            onClick={resetSim}
            style={{
              padding: '7px 0',
              background: 'rgba(255,60,60,0.1)',
              border: '1px solid rgba(255,60,60,0.3)',
              borderRadius: 3,
              color: '#ff6666',
              fontSize: 10,
              fontFamily: 'inherit',
              letterSpacing: 2,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.background = 'rgba(255,60,60,0.2)'
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.background = 'rgba(255,60,60,0.1)'
            }}
          >
            RESET
          </button>

          {/* Separator */}
          <div style={{ height: 1, background: 'rgba(0,180,255,0.1)' }} />

          {/* Info panel */}
          <div>
            <button
              onClick={() => setShowInfo(!showInfo)}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(0,180,255,0.5)',
                fontSize: 9,
                letterSpacing: 2,
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: 0,
                marginBottom: 8,
              }}
            >
              {showInfo ? '[-] MATERIAL INFO' : '[+] MATERIAL INFO'}
            </button>

            {showInfo && selectedComp && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                fontSize: 10,
                lineHeight: 1.6,
              }}>
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: `rgb(${Math.round(selectedComp.props.color[0] * 255)},${Math.round(selectedComp.props.color[1] * 255)},${Math.round(selectedComp.props.color[2] * 255)})`,
                }}>
                  {selectedComp.name}
                </div>

                <div style={{ color: 'rgba(100,150,200,0.55)', fontSize: 9 }}>
                  {selectedComp.formula}
                </div>

                <div style={{ marginTop: 4 }}>
                  <InfoRow label="Density" value={`${selectedComp.props.density.toFixed(0)} kg/m3`} symbol={'\u03c1'} />
                  <InfoRow label="Viscosity" value={`${selectedComp.props.viscosity.toFixed(4)} Pa\u00b7s`} symbol={'\u03bc'} />
                  <InfoRow label="Surface Tension" value={`${selectedComp.props.surfaceTension.toFixed(4)} N/m`} symbol={'\u03c3'} />
                  <InfoRow label="Melting Point" value={`${selectedComp.props.meltingPoint.toFixed(0)} C`} symbol={'Tm'} />
                  <InfoRow label="Boiling Point" value={`${selectedComp.props.boilingPoint.toFixed(0)} C`} symbol={'Tb'} />
                  <InfoRow label="Metalness" value={`${(selectedComp.props.metalness * 100).toFixed(0)}%`} symbol={'M'} />
                  <InfoRow label="F0" value={selectedComp.props.F0.toFixed(3)} symbol={'F'} />
                  <InfoRow label="IOR" value={selectedComp.props.IOR.toFixed(3)} symbol={'n'} />
                </div>

                <div style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  background: 'rgba(0,180,255,0.05)',
                  border: '1px solid rgba(0,180,255,0.1)',
                  borderRadius: 3,
                  fontSize: 9,
                  color: 'rgba(100,150,200,0.5)',
                  lineHeight: 1.8,
                }}>
                  <div style={{ color: 'rgba(0,180,255,0.6)', marginBottom: 2, letterSpacing: 1 }}>
                    GPU MLS-MPM
                  </div>
                  <div>Solver: WebGPU compute</div>
                  <div>Substeps: 2 per frame</div>
                  <div>Grid: 64x64x64</div>
                  <div>Render: SSFR (5-pass)</div>
                  <div>Transfer: P2G + G2P</div>
                  <div style={{ marginTop: 4, color: 'rgba(0,180,255,0.4)', letterSpacing: 1 }}>
                    From structure.md S3.2
                  </div>
                </div>
              </div>
            )}
          </div>
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

// ── Shared styles ─────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 9,
  letterSpacing: 2,
  color: 'rgba(0,180,255,0.5)',
  marginBottom: 6,
}

const sliderStyle: React.CSSProperties = {
  width: '100%',
  height: 4,
  appearance: 'none' as const,
  background: 'rgba(0,180,255,0.15)',
  borderRadius: 2,
  outline: 'none',
  cursor: 'pointer',
}

const valueStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(100,150,200,0.6)',
  marginTop: 4,
  textAlign: 'right',
}

// ── Sub-components ────────────────────────────────────────────────────────

function InfoRow({ label, value, symbol }: { label: string; value: string; symbol: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '2px 0',
      fontSize: 10,
    }}>
      <span style={{ color: 'rgba(100,150,200,0.5)' }}>
        <span style={{ color: 'rgba(0,180,255,0.5)', marginRight: 4 }}>{symbol}</span>
        {label}
      </span>
      <span style={{ color: '#c0d0e0', fontWeight: 500 }}>{value}</span>
    </div>
  )
}
