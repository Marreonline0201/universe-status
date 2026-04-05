// ── FluidTest ────────────────────────────────────────────────────────────────
// SPH Fluid Simulation — Testing the physics from structure.md section 3.2
// Real SPH algorithm with real material properties from section 3.1
// Simulation runs in a Web Worker for 60fps rendering with 5000 particles
// Public demo page for universe-status site

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

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
    surfaceTension: 0.073,
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
    viscosity: 0.0015,
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
    color: 0x8b0000,
    restDensity: 1060,
    description: 'Slightly thicker than water. Non-Newtonian \u2014 thins under shear.',
  },
]

// ── Simulation constants (must match worker) ─────────────────────────────────

const PARTICLE_RADIUS = 0.02
const MAX_PARTICLES = 5000

// Box dimensions
const BOX_W = 2.0
const BOX_H = 1.5
const BOX_D = 1.5
const HALF_W = BOX_W / 2
const HALF_H = BOX_H / 2
const HALF_D = BOX_D / 2

// Visual radius for rendering (smaller looks more natural)
const VISUAL_RADIUS = 0.012

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

  // Refs for simulation state
  const simRef = useRef<{
    worker: Worker
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: THREE.WebGLRenderer
    controls: OrbitControls
    instancedMeshes: Map<number, THREE.InstancedMesh>
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
    // Latest simulation data from worker
    latestPositions: Float32Array | null
    latestVelocities: Float32Array | null
    latestMaterials: Uint8Array | null
    latestCount: number
    workerBusy: boolean
    workerReady: boolean
  } | null>(null)

  const resetSim = useCallback(() => {
    if (!simRef.current) return
    simRef.current.worker.postMessage({ type: 'reset' })
    simRef.current.instancedMeshes.forEach((mesh) => {
      mesh.count = 0
    })
    simRef.current.latestCount = 0
    simRef.current.latestPositions = null
    simRef.current.latestVelocities = null
    simRef.current.latestMaterials = null
    setParticleCount(0)
    setFpsWarning(false)
  }, [])

  const spawnParticles = useCallback((worldPos: THREE.Vector3) => {
    if (!simRef.current || !simRef.current.workerReady) return
    const matIdx = simRef.current.selectedMaterial

    // Spawn a cluster of particles: 6x6x6 = 216 per click
    const spacing = PARTICLE_RADIUS * 2.2
    const gridSize = 6
    const positions: number[] = []

    for (let xi = 0; xi < gridSize; xi++) {
      for (let yi = 0; yi < gridSize; yi++) {
        for (let zi = 0; zi < gridSize; zi++) {
          const x = worldPos.x + (xi - gridSize / 2) * spacing
          const y = worldPos.y + (yi - gridSize / 2) * spacing
          const z = worldPos.z + (zi - gridSize / 2) * spacing
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
      simRef.current.worker.postMessage(
        { type: 'addParticles', positions: buf, materialIndex: matIdx },
        [buf.buffer],
      )
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

    // ── Create Web Worker ──────────────────────────────────────────────
    const worker = new Worker(
      new URL('../workers/sph-worker.ts', import.meta.url),
      { type: 'module' },
    )

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x060810)

    // Camera
    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      50,
    )
    camera.position.set(2.5, 1.8, 2.5)
    camera.lookAt(0, 0, 0)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
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

    // ── Instanced meshes (one per material for color) ─────────────────
    const instancedMeshes = new Map<number, THREE.InstancedMesh>()
    const sphereGeo = new THREE.SphereGeometry(VISUAL_RADIUS, 8, 6)

    MATERIALS.forEach((mat, idx) => {
      const color = new THREE.Color(mat.color)
      const meshMat = new THREE.MeshStandardMaterial({
        color: color,
        roughness: 0.3,
        metalness: mat.name === 'Mercury' ? 0.9 : 0.1,
        emissive: mat.emissive ? color.clone().multiplyScalar(0.5) : new THREE.Color(0x000000),
        emissiveIntensity: mat.emissive ? 1.5 : 0,
      })
      const instMesh = new THREE.InstancedMesh(sphereGeo, meshMat, MAX_PARTICLES)
      instMesh.count = 0
      instMesh.frustumCulled = false
      scene.add(instMesh)
      instancedMeshes.set(idx, instMesh)
    })

    // Raycaster for click-to-spawn
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    // ── Store in ref ──────────────────────────────────────────────────
    simRef.current = {
      worker,
      scene,
      camera,
      renderer,
      controls,
      instancedMeshes,
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
      latestPositions: null,
      latestVelocities: null,
      latestMaterials: null,
      latestCount: 0,
      workerBusy: false,
      workerReady: false,
    }

    // ── Worker message handler ────────────────────────────────────────
    worker.onmessage = (e: MessageEvent) => {
      const sim = simRef.current
      if (!sim) return

      const msg = e.data
      switch (msg.type) {
        case 'ready':
          sim.workerReady = true
          worker.postMessage({ type: 'init' })
          break

        case 'initDone':
          // Worker is initialized
          break

        case 'stepResult':
          sim.latestPositions = msg.positions as Float32Array
          sim.latestVelocities = msg.velocities as Float32Array
          sim.latestMaterials = msg.materials as Uint8Array
          sim.latestCount = msg.count as number
          sim.workerBusy = false
          break

        case 'particlesAdded':
          setParticleCount(msg.count as number)
          break

        case 'resetDone':
          setParticleCount(0)
          break
      }
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

    // ── Dummy matrix for instance updates ─────────────────────────────
    const dummy = new THREE.Matrix4()
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
        setFpsWarning(currentFps < 30 && sim.latestCount > 100)
        sim.fpsAccum = 0
        sim.fpsFrames = 0
      }

      // Send step to worker if it's not busy
      if (!sim.workerBusy && sim.workerReady && sim.latestCount > 0) {
        sim.workerBusy = true
        const simDt = Math.min(rawDt, 1 / 30) * sim.timeScale
        // More substeps for high-viscosity materials (honey, lava) to keep simulation stable
        const matVisc = MATERIALS[sim.selectedMaterial].viscosity
        const subSteps = matVisc > 1 ? 8 : 4
        sim.worker.postMessage({
          type: 'step',
          gravity: sim.gravity,
          dt: simDt,
          subSteps,
        })
      }

      // ── Update instanced meshes from latest worker data ──────────
      if (sim.latestPositions && sim.latestCount > 0) {
        const positions = sim.latestPositions
        const velocities = sim.latestVelocities!
        const mats = sim.latestMaterials!
        const cnt = sim.latestCount

        // Count per material
        const counts = new Map<number, number>()
        const offsets = new Map<number, number>()
        MATERIALS.forEach((_, idx) => {
          counts.set(idx, 0)
          offsets.set(idx, 0)
        })

        for (let i = 0; i < cnt; i++) {
          const m = mats[i]
          counts.set(m, (counts.get(m) || 0) + 1)
        }

        sim.instancedMeshes.forEach((mesh, idx) => {
          mesh.count = counts.get(idx) || 0
        })

        // Set transforms and colors
        for (let i = 0; i < cnt; i++) {
          const m = mats[i]
          const mesh = sim.instancedMeshes.get(m)
          if (!mesh) continue
          const localIdx = offsets.get(m) || 0
          offsets.set(m, localIdx + 1)

          dummy.makeTranslation(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
          )
          mesh.setMatrixAt(localIdx, dummy)

          // Color variation based on velocity magnitude
          const svx = velocities[i * 3]
          const svy = velocities[i * 3 + 1]
          const svz = velocities[i * 3 + 2]
          const speed = Math.sqrt(svx * svx + svy * svy + svz * svz)
          const brightness = Math.min(1.0, 0.6 + speed * 0.15)
          const mat = MATERIALS[m]
          tempColor.setHex(mat.color)
          tempColor.multiplyScalar(brightness)
          mesh.setColorAt(localIdx, tempColor)
        }

        // Mark for GPU upload
        sim.instancedMeshes.forEach((mesh) => {
          if (mesh.count > 0) {
            mesh.instanceMatrix.needsUpdate = true
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
          }
        })

        setParticleCount(cnt)
      }

      // Update controls and render
      sim.controls.update()
      sim.renderer.render(sim.scene, sim.camera)
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

    // ── Cleanup ───────────────────────────────────────────────────────
    return () => {
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      if (simRef.current) {
        cancelAnimationFrame(simRef.current.animId)
        simRef.current.worker.terminate()
      }
      renderer.dispose()
      container.removeChild(renderer.domElement)
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
            structure.md S3.2 | Web Worker
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
              CLICK THE BOX TO DROP FLUID
              <br />
              <span style={{ fontSize: 10, opacity: 0.6 }}>
                Drag to orbit / Scroll to zoom
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
                  <div>Solver: Web Worker, 4-8 substeps</div>
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
