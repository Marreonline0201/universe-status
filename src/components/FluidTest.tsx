// ── FluidTest ────────────────────────────────────────────────────────────────
// SPH Fluid Simulation — Rust/WASM SPH solver (replaces JS Web Worker)
// Real SPH algorithm with real material properties from structure.md S3.1
// WASM runs on main thread — fast enough for 5000+ tiny particles at 60fps
// Public demo page for universe-status site

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js'
import { FluidRenderer } from '../fluid-render/FluidRenderer'
import initWasm, { Simulation } from '../wasm/sph_wasm'

// ── Material definitions (section 3.1 property calculator) ───────────────────

interface MaterialPacket {
  name: string
  composition: string
  density: number       // kg/m^3
  viscosity: number     // Pa*s
  surfaceTension: number // N/m
  color: number
  restDensity: number   // kg/m^3
  description: string
  emissive?: boolean
}

const MATERIALS: MaterialPacket[] = [
  {
    name: 'Water',
    composition: 'H\u2082O',
    density: 1000,
    viscosity: 0.001,
    surfaceTension: 0.0728, // IAPWS 2014
    color: 0x3399ff,
    restDensity: 1000,
    description: 'The most common liquid. Low viscosity \u2014 flows freely and splashes easily.',
  },
  {
    name: 'Honey',
    composition: 'Sugar solution (C\u2086H\u2081\u2082O\u2086 + H\u2082O)',
    density: 1400,
    viscosity: 50,
    surfaceTension: 0.065,
    color: 0xdaa520,
    restDensity: 1400,
    description: 'Very thick. Pours slowly. Non-Newtonian \u2014 stirring makes it thinner.',
  },
  {
    name: 'Molten Copper',
    composition: 'Cu (1085\u00b0C)',
    density: 7800,
    viscosity: 0.004,
    surfaceTension: 1.3,
    color: 0xff6600,
    restDensity: 7800,
    description: 'Heavy but thin when molten. High surface tension \u2014 forms round blobs.',
    emissive: true,
  },
  {
    name: 'Mercury',
    composition: 'Hg',
    density: 13546,
    viscosity: 0.00153,
    surfaceTension: 0.49,
    color: 0xc0c0c0,
    restDensity: 13546,
    description: 'Extremely heavy, very high surface tension. Forms perfect spherical droplets.',
  },
  {
    name: 'Olive Oil',
    composition: 'Triglycerides (C\u2085\u2087H\u2081\u2080\u2084O\u2086)',
    density: 920,
    viscosity: 0.08,
    surfaceTension: 0.032,
    color: 0x8b8000,
    restDensity: 920,
    description: 'Lighter than water (floats on top). Moderate viscosity. Low surface tension.',
  },
  {
    name: 'Lava (Basaltic)',
    composition: 'SiO\u2082 50%, MgO, FeO',
    density: 2700,
    viscosity: 500,
    surfaceTension: 0.4,
    color: 0xff3300,
    restDensity: 2700,
    description: 'Heavy and extremely thick. Flows like thick paste. Glows orange-red.',
    emissive: true,
  },
  {
    name: 'Blood',
    composition: 'H\u2082O 55%, proteins, cells',
    density: 1060,
    viscosity: 0.004,
    surfaceTension: 0.058,
    color: 0xcc2222,
    restDensity: 1060,
    description: 'Slightly thicker than water. Non-Newtonian \u2014 thins under shear.',
  },
]

// ── Simulation constants ─────────────────────────────────────────────────────

const PARTICLE_RADIUS = 0.008
const MAX_PARTICLES = 8000

// Box dimensions
const BOX_W = 2.0
const BOX_H = 1.5
const BOX_D = 1.5
const HALF_W = BOX_W / 2
const HALF_H = BOX_H / 2
const HALF_D = BOX_D / 2
const AMBIENT_TEMP = 20.0

// §3.2: SPH kernel and MC grid constants (from structure.md lines 1855-1863)
const SPH_H = 0.04              // kernel radius (same as WASM)
const SPACING = SPH_H * 0.5     // particle rest spacing = 0.02
const MC_RES = 32               // 32³ grid (line 1855)
const MC_THRESHOLD = 0.3        // ~0.6 for thick 3D fluid, lower for thin pools in demo
void SPACING // used by sphere geometry above


// ── React Component ──────────────────────────────────────────────────────────

export function FluidTest() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [selectedMaterial, setSelectedMaterial] = useState(0)
  const [gravityVal, setGravityVal] = useState(9.81)
  const [timeScale, setTimeScale] = useState(1.0)
  const [fps, setFps] = useState(0)
  const [particleCount, setParticleCount] = useState(0)
  const [showInfo, setShowInfo] = useState(true)
  const [fpsWarning, setFpsWarning] = useState(false)
  const [wasmReady, setWasmReady] = useState(false)

  // Refs for simulation state
  const simRef = useRef<{
    simulation: Simulation
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: any /* WebGPURenderer */
    controls: OrbitControls
    instMeshes: THREE.InstancedMesh[]
    dummy: THREE.Matrix4
    sprayPoints: THREE.Points
    sprayPosAttr: THREE.BufferAttribute
    sprayColAttr: THREE.BufferAttribute
    mcubes: MarchingCubes
    fluidRenderer: FluidRenderer | null
    animId: number
    lastTime: number
    fpsAccum: number
    fpsFrames: number
    selectedMaterial: number
    gravity: number
    timeScale: number
    raycaster: THREE.Raycaster
    mouse: THREE.Vector2
    boxMesh: THREE.LineSegments
    avgTemp: number
  } | null>(null)

  const resetSim = useCallback(() => {
    if (!simRef.current) return
    simRef.current.simulation.reset()
    simRef.current.instMeshes.forEach(im => { im.count = 0 })
    simRef.current.sprayPoints.geometry.setDrawRange(0, 0)
    simRef.current.mcubes.reset()
    simRef.current.mcubes.update()
    setParticleCount(0)
    setFpsWarning(false)
  }, [])

  const spawnParticles = useCallback((worldPos: THREE.Vector3) => {
    if (!simRef.current) return
    const matIdx = simRef.current.selectedMaterial

    // Spawn a cluster of particles: 7x7x7 = 343 per click
    // Spacing matches WASM rest spacing (H*0.5 = 0.02) + jitter to break grid symmetry
    const spacing = 0.022
    const gridSize = 7
    const jitter = spacing * 0.25
    const positions: number[] = []

    for (let xi = 0; xi < gridSize; xi++) {
      for (let yi = 0; yi < gridSize; yi++) {
        for (let zi = 0; zi < gridSize; zi++) {
          const x = worldPos.x + (xi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
          const y = worldPos.y + (yi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
          const z = worldPos.z + (zi - gridSize / 2) * spacing + (Math.random() - 0.5) * jitter
          if (Math.abs(x) < HALF_W - PARTICLE_RADIUS &&
              Math.abs(y) < HALF_H - PARTICLE_RADIUS &&
              Math.abs(z) < HALF_D - PARTICLE_RADIUS) {
            positions.push(x, y, z)
          }
        }
      }
    }

    if (positions.length > 0) {
      const buf = new Float32Array(positions)
      const newCount = simRef.current.simulation.add_particles(buf, matIdx)
      setParticleCount(newCount)
    }
  }, [])

  // Keep refs in sync with state
  useEffect(() => {
    if (simRef.current) simRef.current.selectedMaterial = selectedMaterial
  }, [selectedMaterial])
  useEffect(() => {
    if (simRef.current) simRef.current.gravity = gravityVal
  }, [gravityVal])
  useEffect(() => {
    if (simRef.current) simRef.current.timeScale = timeScale
  }, [timeScale])

  // ── Main Three.js setup and render loop ─────────────────────────────────
  useEffect(() => {
    const container = canvasRef.current
    if (!container) return

    let cancelled = false

    const setup = async () => {
      // ── Initialize WASM ───────────────────────────────────────────
      await initWasm('/sph_wasm_bg.wasm')
      if (cancelled) return
      const simulation = new Simulation()
      setWasmReady(true)

      // Scene
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0xf5deb3) // sandy yellow for debug visibility

      // Camera
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

      // Glass panels (very transparent)
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
      const floorGeo = new THREE.PlaneGeometry(BOX_W - 0.02, BOX_D - 0.02, 10, 10)
      const floorMat = new THREE.MeshBasicMaterial({
        color: 0x0a1828,
        wireframe: true,
        transparent: true,
        opacity: 0.2,
      })
      const floorMesh = new THREE.Mesh(floorGeo, floorMat)
      floorMesh.rotation.x = -Math.PI / 2
      floorMesh.position.y = -HALF_H + 0.001
      scene.add(floorMesh)

      // ── InstancedMesh per material (works on WebGL and WebGPU) ────
      // One InstancedMesh per material type with correct color baked in
      // Larger spheres so they overlap at rest spacing — creates continuous surface
      // SPACING = 0.02, so radius 0.012 makes adjacent spheres overlap slightly
      const sphereGeo = new THREE.SphereGeometry(SPACING * 0.6, 8, 6)
      const instMeshes: THREE.InstancedMesh[] = []
      MATERIALS.forEach((mat) => {
        const meshMat = new THREE.MeshStandardMaterial({
          color: mat.color,
          roughness: 0.3,
          metalness: mat.name === 'Mercury' ? 0.8 : 0.0,
          emissive: mat.emissive ? new THREE.Color(mat.color).multiplyScalar(0.3) : new THREE.Color(0),
          emissiveIntensity: mat.emissive ? 1.0 : 0,
        })
        const im = new THREE.InstancedMesh(sphereGeo, meshMat, MAX_PARTICLES)
        im.count = 0
        im.frustumCulled = false
        scene.add(im)
        instMeshes.push(im)
      })
      const dummy = new THREE.Matrix4()

      // §3.2: Spray particles (secondary particles — smaller, brighter)
      const sprayGeo = new THREE.BufferGeometry()
      const sprayPosAttr = new THREE.BufferAttribute(new Float32Array(2000 * 3), 3)
      const sprayColAttr = new THREE.BufferAttribute(new Float32Array(2000 * 3), 3)
      sprayPosAttr.setUsage(THREE.DynamicDrawUsage)
      sprayColAttr.setUsage(THREE.DynamicDrawUsage)
      sprayGeo.setAttribute('position', sprayPosAttr)
      sprayGeo.setAttribute('color', sprayColAttr)
      sprayGeo.setDrawRange(0, 0)
      const sprayMat = new THREE.PointsMaterial({
        size: 3,
        sizeAttenuation: false,
        vertexColors: true,
      })
      const sprayPoints = new THREE.Points(sprayGeo, sprayMat)
      sprayPoints.frustumCulled = false
      scene.add(sprayPoints)

      // §3.2 Tier 1: Marching Cubes — smooth mesh surface from particles
      // Resolution 28 = 28³ grid cells. Document says 32³ (~0.6ms).
      const mcMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x2288dd,
        roughness: 0.1,
        metalness: 0.0,
        transmission: 0.5,
        thickness: 0.4,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      })
      // enableUvs=false, enableColors=false — colors cause shader mismatch with MeshStandardMaterial
      const mcubes = new MarchingCubes(MC_RES, mcMaterial, false, false, 50000)
      // MC generates geometry in [0,1]³. Scale to box size, offset to center at origin.
      mcubes.position.set(-HALF_W, -HALF_H, -HALF_D)
      mcubes.scale.set(BOX_W, BOX_H, BOX_D)
      mcubes.isolation = MC_THRESHOLD
      mcubes.visible = true
      scene.add(mcubes)

      // §3.2 Tier 2: SSFR — Screen-Space Fluid Rendering
      // Raw WebGPU fluid renderer — overlay canvas for SSFR
      // Init async — updates simRef when ready
      let fluidRenderer: FluidRenderer | null = null
      ;(async () => {
        const fr = new FluidRenderer()
        if (await fr.init(container, container.clientWidth, container.clientHeight)) {
          fluidRenderer = fr
          // Update the ref so the render loop picks it up
          if (simRef.current) simRef.current.fluidRenderer = fr
        }
      })()

      // Raycaster for click-to-spawn
      const raycaster = new THREE.Raycaster()
      const mouse = new THREE.Vector2()

      // ── Store in ref ──────────────────────────────────────────────────
      simRef.current = {
        simulation,
        scene,
        camera,
        renderer,
        controls,
        instMeshes,
        dummy,
        animId: 0,
        lastTime: performance.now(),
        fpsAccum: 0,
        fpsFrames: 0,
        selectedMaterial: 0,
        gravity: 9.81,
        timeScale: 1.0,
        raycaster,
        mouse,
        boxMesh,
        avgTemp: AMBIENT_TEMP,
        sprayPoints,
        sprayPosAttr,
        sprayColAttr,
        mcubes,
        fluidRenderer,
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
          spawnParticles(new THREE.Vector3(
            Math.max(-HALF_W + 0.2, Math.min(HALF_W - 0.2, pt.x)),
            spawnY,
            Math.max(-HALF_D + 0.2, Math.min(HALF_D - 0.2, pt.z)),
          ))
        }
      }
      renderer.domElement.addEventListener('pointerdown', onPointerDown)

      // ── Temp color for per-particle coloring ───────────────────────────
      const tempColor = new THREE.Color()

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
          const count = sim.simulation.get_count()
          setFpsWarning(currentFps < 30 && count > 100)
          sim.fpsAccum = 0
          sim.fpsFrames = 0
        }

        // ── Step WASM simulation ──────────────────────────────────────
        const count = sim.simulation.get_count()
        if (count > 0) {
          const simDt = Math.min(rawDt, 1 / 30) * sim.timeScale
          sim.simulation.step(sim.gravity, simDt, 2)

          // Get results from WASM (including temperature + phase)
          const positions = sim.simulation.get_positions()
          void sim.simulation.get_velocities() // velocities available for future use
          const mats = sim.simulation.get_materials()
          const temps = sim.simulation.get_temperatures()
          void sim.simulation.get_phases() // phases used by MC material adaptation

          // Update per-material InstancedMeshes
          let avgTemp = 0
          const matOffsets = new Array(MATERIALS.length).fill(0)

          // Count particles per material
          const matCounts = new Array(MATERIALS.length).fill(0)
          for (let i = 0; i < count; i++) {
            matCounts[mats[i]]++
            avgTemp += temps[i]
          }
          sim.instMeshes.forEach((im, idx) => { im.count = matCounts[idx] })
          let dominantMat = 0
          for (let m = 1; m < MATERIALS.length; m++) if (matCounts[m] > matCounts[dominantMat]) dominantMat = m

          // Set matrices per material
          for (let i = 0; i < count; i++) {
            const i3 = i * 3
            const m = mats[i]
            const localIdx = matOffsets[m]++
            sim.dummy.makeTranslation(positions[i3], positions[i3 + 1], positions[i3 + 2])
            sim.instMeshes[m].setMatrixAt(localIdx, sim.dummy)
          }

          // Mark instanced meshes for GPU upload
          const ssfrActive = sim.fluidRenderer?.isInitialized ?? false
          sim.instMeshes.forEach((im) => {
            if (im.count > 0) im.instanceMatrix.needsUpdate = true
            im.visible = !ssfrActive // hide when SSFR provides the surface
          })

          // Upload particles to WebGPU fluid renderer
          if (sim.fluidRenderer?.isInitialized) {
            const vels = sim.simulation.get_velocities()
            sim.fluidRenderer.updateParticles(positions, vels, mats, count)
            // Camera matrices from Three.js
            const viewMat = new Float32Array(16)
            const projMat = new Float32Array(16)
            sim.camera.matrixWorldInverse.toArray(viewMat)
            sim.camera.projectionMatrix.toArray(projMat)
            // Sphere size must be large enough for depth sprites to overlap
            // At SPACING=0.02, adjacent particles are 0.02 apart.
            // Sphere diameter should be >= spacing so sprites overlap: size >= 0.04
            sim.fluidRenderer.updateCamera(viewMat, projMat, 0.3) // DEBUG: very large to verify billboards
          }

          if (count > 0) sim.avgTemp = avgTemp / count

          // MC disabled — too coarse (32³ grid, 0.05m cells) and expensive.
          // Will re-enable when moved to WebGPU compute shader for finer grid.
          sim.mcubes.visible = false

          setParticleCount(count)

          // §3.2: Render spray particles
          const sprayCount = sim.simulation.get_spray_count()
          if (sprayCount > 0) {
            const sprayPos = sim.simulation.get_spray_positions()
            const sprayMats = sim.simulation.get_spray_materials()
            const sPosArr = sim.sprayPosAttr.array as Float32Array
            const sColArr = sim.sprayColAttr.array as Float32Array
            for (let s = 0; s < sprayCount; s++) {
              const s3 = s * 3
              sPosArr[s3]     = sprayPos[s3]
              sPosArr[s3 + 1] = sprayPos[s3 + 1]
              sPosArr[s3 + 2] = sprayPos[s3 + 2]
              // Bright white-tinted version of material color
              const sm = MATERIALS[sprayMats[s]]
              tempColor.setHex(sm.color).lerp(new THREE.Color(0xffffff), 0.5)
              sColArr[s3]     = tempColor.r
              sColArr[s3 + 1] = tempColor.g
              sColArr[s3 + 2] = tempColor.b
            }
            sim.sprayPosAttr.needsUpdate = true
            sim.sprayColAttr.needsUpdate = true
          }
          sim.sprayPoints.geometry.setDrawRange(0, sprayCount)
        }

        sim.controls.update()

        // Render: Three.js scene first, then WebGPU fluid overlay
        sim.renderer.render(sim.scene, sim.camera)

        // WebGPU SSFR fluid rendering — every frame
        if (sim.fluidRenderer?.isInitialized) {
          const count = sim.simulation.get_count()
          if (count > 0) {
            sim.fluidRenderer.captureScene(sim.renderer.domElement as HTMLCanvasElement)
          }
          sim.fluidRenderer.render(count) // always render (clears overlay when count=0)
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
      renderer?: any /* WebGPURenderer */
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
        simRef.current.simulation.free()
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
  }, [spawnParticles])

  // ── Render ──────────────────────────────────────────────────────────────
  const mat = MATERIALS[selectedMaterial]

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
            SPH FLUID SIMULATION
          </span>
          <span style={{
            fontSize: 9,
            color: 'rgba(100,150,200,0.5)',
            letterSpacing: 1,
          }}>
            structure.md S3.0+S3.1+S3.2+S3.11 | Rust/WASM
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
          {wasmReady && (
            <span style={{
              fontSize: 8,
              fontWeight: 700,
              color: '#000',
              background: '#00ff88',
              padding: '1px 5px',
              borderRadius: 3,
              letterSpacing: 1,
            }}>
              WASM
            </span>
          )}
          <span style={{
            fontSize: 10,
            color: 'rgba(100,150,200,0.6)',
            letterSpacing: 1,
          }}>
            N: {particleCount} / {MAX_PARTICLES}
          </span>
          {simRef.current && particleCount > 0 && (
            <span style={{
              fontSize: 10,
              color: 'rgba(100,150,200,0.4)',
              letterSpacing: 1,
            }}>
              {Math.round(simRef.current.avgTemp)}°C
            </span>
          )}
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
          {particleCount === 0 && (
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
              {wasmReady ? 'CLICK THE BOX TO DROP FLUID' : 'LOADING WASM...'}
              <br />
              <span style={{ fontSize: 10, opacity: 0.6 }}>
                {wasmReady ? 'Drag to orbit / Scroll to zoom' : 'Initializing Rust SPH solver'}
              </span>
            </div>
          )}
        </div>

        {/* Control Panel */}
        <div style={{
          width: 220,
          flexShrink: 0,
          borderLeft: '1px solid rgba(0,180,255,0.1)',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflowY: 'auto',
          background: 'rgba(4,8,18,0.6)',
        }}>
          {/* Material select */}
          <div>
            <label style={labelStyle}>MATERIAL</label>
            <select
              value={selectedMaterial}
              onChange={(e) => setSelectedMaterial(Number(e.target.value))}
              style={{
                width: '100%',
                padding: '6px 8px',
                background: 'rgba(0,20,40,0.8)',
                border: '1px solid rgba(0,180,255,0.2)',
                borderRadius: 3,
                color: '#c0d0e0',
                fontSize: 11,
                fontFamily: 'inherit',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {MATERIALS.map((m, i) => (
                <option key={m.name} value={i} style={{ background: '#0a1020' }}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Color swatch */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background: `#${mat.color.toString(16).padStart(6, '0')}`,
              boxShadow: mat.emissive
                ? `0 0 8px #${mat.color.toString(16).padStart(6, '0')}`
                : 'none',
            }} />
            <span style={{ fontSize: 10, color: 'rgba(100,150,200,0.6)' }}>
              {mat.composition}
            </span>
          </div>

          {/* Gravity slider */}
          <div>
            <label style={labelStyle}>GRAVITY</label>
            <input
              type="range"
              min={0}
              max={20}
              step={0.1}
              value={gravityVal}
              onChange={(e) => setGravityVal(Number(e.target.value))}
              style={sliderStyle}
            />
            <div style={valueStyle}>{gravityVal.toFixed(1)} m/s2</div>
          </div>

          {/* Time scale slider */}
          <div>
            <label style={labelStyle}>TIME SCALE</label>
            <input
              type="range"
              min={0.1}
              max={3.0}
              step={0.1}
              value={timeScale}
              onChange={(e) => setTimeScale(Number(e.target.value))}
              style={sliderStyle}
            />
            <div style={valueStyle}>{timeScale.toFixed(1)}x</div>
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
          <div style={{
            height: 1,
            background: 'rgba(0,180,255,0.1)',
          }} />

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
              {showInfo ? '[-] INFO' : '[+] INFO'}
            </button>

            {showInfo && (
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
                  color: `#${mat.color.toString(16).padStart(6, '0')}`,
                }}>
                  {mat.name}
                </div>

                <div style={{ color: 'rgba(100,150,200,0.55)', fontSize: 9 }}>
                  {mat.description}
                </div>

                <div style={{ marginTop: 4 }}>
                  <InfoRow label="Density" value={`${mat.density} kg/m3`} symbol={'\u03c1'} />
                  <InfoRow label="Viscosity" value={`${mat.viscosity} Pa\u00b7s`} symbol={'\u03bc'} />
                  <InfoRow label="Surface Tension" value={`${mat.surfaceTension} N/m`} symbol={'\u03c3'} />
                  <InfoRow label="Rest Density" value={`${mat.restDensity} kg/m3`} symbol={'\u03c1\u2080'} />
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
                    FORMULAS
                  </div>
                  <div>Pressure: P = B((\u03c1/\u03c1\u2080)^7 - 1)</div>
                  <div>B = \u03c1\u2080 * cs\u00b2 / 7, cs=8</div>
                  <div>F_p = -\u03a3 m_j(P_i/\u03c1_i\u00b2 + P_j/\u03c1_j\u00b2)\u2207W</div>
                  <div>F_v = \u03bc\u03a3 m_j(v_j-v_i)/\u03c1_j \u2207\u00b2W</div>
                  <div>Kernel: Cubic spline (M4)</div>
                  <div>Solver: Rust/WASM, 4 substeps</div>
                  <div style={{ marginTop: 4, color: 'rgba(0,180,255,0.4)', letterSpacing: 1 }}>
                    From structure.md S3.2
                  </div>
                </div>
              </div>
            )}
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
