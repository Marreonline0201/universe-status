// ── FluidTest ────────────────────────────────────────────────────────────────
// SPH Fluid Simulation — Testing the physics from structure.md §3.2
// Real SPH algorithm with real material properties from §3.1
// Public demo page for universe-status site

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// ── Material definitions (§3.1 property calculator) ─────────────────────────

interface MaterialPacket {
  name: string
  composition: string
  density: number       // kg/m³
  viscosity: number     // Pa·s
  surfaceTension: number // N/m
  color: number
  restDensity: number   // kg/m³
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

// ── SPH Simulation Engine ───────────────────────────────────────────────────

// Simulation constants
const PARTICLE_RADIUS = 0.04
const KERNEL_RADIUS = PARTICLE_RADIUS * 4 // h
const KERNEL_RADIUS_SQ = KERNEL_RADIUS * KERNEL_RADIUS
const GAMMA = 7 // Tait equation exponent
const MAX_PARTICLES = 2000

// Box dimensions (in sim units)
const BOX_W = 2.0
const BOX_H = 1.5
const BOX_D = 1.5
const HALF_W = BOX_W / 2
const HALF_H = BOX_H / 2
const HALF_D = BOX_D / 2

// Cubic spline kernel (Monaghan M4) and derivatives
// W(r, h) = (1/(pi*h^3)) * { 1 - 1.5q^2 + 0.75q^3   if 0<=q<=1
//                           { 0.25*(2-q)^3              if 1<q<=2
//                           { 0                          if q>2
// where q = r/h
const KERNEL_NORM = 1.0 / (Math.PI * KERNEL_RADIUS * KERNEL_RADIUS * KERNEL_RADIUS)

function kernelW(rSq: number): number {
  const r = Math.sqrt(rSq)
  const q = r / KERNEL_RADIUS
  if (q >= 2) return 0
  if (q <= 1) return KERNEL_NORM * (1 - 1.5 * q * q + 0.75 * q * q * q)
  const t = 2 - q
  return KERNEL_NORM * 0.25 * t * t * t
}

// Gradient of cubic spline kernel (returns scalar factor, multiply by rij/|rij|)
function kernelGradFactor(rSq: number): number {
  const r = Math.sqrt(rSq)
  if (r < 1e-8) return 0
  const q = r / KERNEL_RADIUS
  if (q >= 2) return 0
  const gradNorm = KERNEL_NORM / (KERNEL_RADIUS * r) // 1/(pi*h^3) * 1/(h*r)
  if (q <= 1) return gradNorm * (-3 * q + 2.25 * q * q)
  const t = 2 - q
  return gradNorm * (-0.75 * t * t)
}

// Laplacian of cubic spline (for viscosity)
function kernelLaplacian(rSq: number): number {
  const r = Math.sqrt(rSq)
  const q = r / KERNEL_RADIUS
  if (q >= 2) return 0
  const lapNorm = KERNEL_NORM / (KERNEL_RADIUS * KERNEL_RADIUS)
  if (q <= 1) return lapNorm * (-3 + 4.5 * q)
  const t = 2 - q
  return lapNorm * (1.5 * t)  // simplified from derivative
}

// ── Spatial Hash Grid ───────────────────────────────────────────────────────
// Cell size = kernel_radius, check 27 neighboring cells for O(n) neighbor lookup

class SpatialHashGrid {
  private cellSize: number
  private cells: Map<number, number[]>
  private readonly PRIME1 = 73856093
  private readonly PRIME2 = 19349663
  private readonly PRIME3 = 83492791
  private readonly TABLE_SIZE = 10007

  // Pre-allocated neighbor buffer to avoid GC pressure (BUG 3 fix)
  private neighborBuffer: number[] = new Array(500)
  private neighborCount: number = 0

  constructor(cellSize: number) {
    this.cellSize = cellSize
    this.cells = new Map()
  }

  private hash(ix: number, iy: number, iz: number): number {
    return Math.abs((ix * this.PRIME1) ^ (iy * this.PRIME2) ^ (iz * this.PRIME3)) % this.TABLE_SIZE
  }

  clear() {
    this.cells.clear()
  }

  insert(index: number, x: number, y: number, z: number) {
    const ix = Math.floor(x / this.cellSize)
    const iy = Math.floor(y / this.cellSize)
    const iz = Math.floor(z / this.cellSize)
    const h = this.hash(ix, iy, iz)
    let cell = this.cells.get(h)
    if (!cell) {
      cell = []
      this.cells.set(h, cell)
    }
    cell.push(index)
  }

  getNeighborCount(): number { return this.neighborCount }
  getNeighborAt(idx: number): number { return this.neighborBuffer[idx] }

  fillNeighbors(x: number, y: number, z: number): void {
    this.neighborCount = 0
    const ix = Math.floor(x / this.cellSize)
    const iy = Math.floor(y / this.cellSize)
    const iz = Math.floor(z / this.cellSize)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const h = this.hash(ix + dx, iy + dy, iz + dz)
          const cell = this.cells.get(h)
          if (cell) {
            for (let k = 0; k < cell.length; k++) {
              this.neighborBuffer[this.neighborCount++] = cell[k]
            }
          }
        }
      }
    }
  }
}

// ── Particle data (SoA layout from §3.7) ───────────────────────────────────

interface ParticleSystem {
  count: number
  // Position
  px: Float32Array
  py: Float32Array
  pz: Float32Array
  // Velocity
  vx: Float32Array
  vy: Float32Array
  vz: Float32Array
  // Force accumulators
  fx: Float32Array
  fy: Float32Array
  fz: Float32Array
  // Per-particle properties
  mass: Float32Array
  density: Float32Array   // computed each step
  pressure: Float32Array  // computed each step
  // Material index per particle
  materialIdx: Uint8Array
}

function createParticleSystem(maxCount: number): ParticleSystem {
  return {
    count: 0,
    px: new Float32Array(maxCount),
    py: new Float32Array(maxCount),
    pz: new Float32Array(maxCount),
    vx: new Float32Array(maxCount),
    vy: new Float32Array(maxCount),
    vz: new Float32Array(maxCount),
    fx: new Float32Array(maxCount),
    fy: new Float32Array(maxCount),
    fz: new Float32Array(maxCount),
    mass: new Float32Array(maxCount),
    density: new Float32Array(maxCount),
    pressure: new Float32Array(maxCount),
    materialIdx: new Uint8Array(maxCount),
  }
}

function addParticles(
  ps: ParticleSystem,
  positions: [number, number, number][],
  materialIndex: number,
): number {
  const mat = MATERIALS[materialIndex]
  // Particle mass derived from rest density and kernel volume
  const volume = (4 / 3) * Math.PI * PARTICLE_RADIUS * PARTICLE_RADIUS * PARTICLE_RADIUS
  const particleMass = mat.restDensity * volume // no arbitrary scaling — correct physics

  let added = 0
  for (const [x, y, z] of positions) {
    if (ps.count >= MAX_PARTICLES) break
    const i = ps.count
    ps.px[i] = x
    ps.py[i] = y
    ps.pz[i] = z
    ps.vx[i] = 0
    ps.vy[i] = 0
    ps.vz[i] = 0
    ps.fx[i] = 0
    ps.fy[i] = 0
    ps.fz[i] = 0
    ps.mass[i] = particleMass
    ps.density[i] = mat.restDensity
    ps.pressure[i] = 0
    ps.materialIdx[i] = materialIndex
    ps.count++
    added++
  }
  return added
}

// ── SPH Step (§3.2 algorithm) ───────────────────────────────────────────────

function sphStep(
  ps: ParticleSystem,
  grid: SpatialHashGrid,
  gravity: number,
  dt: number,
) {
  const n = ps.count
  if (n === 0) return

  // === Build spatial hash ===
  grid.clear()
  for (let i = 0; i < n; i++) {
    grid.insert(i, ps.px[i], ps.py[i], ps.pz[i])
  }

  // === 1. Compute density: rho_i = sum_j m_j * W(r_ij, h) ===
  for (let i = 0; i < n; i++) {
    let rho = 0
    grid.fillNeighbors(ps.px[i], ps.py[i], ps.pz[i])
    const nCount = grid.getNeighborCount()
    for (let k = 0; k < nCount; k++) {
      const j = grid.getNeighborAt(k)
      const dx = ps.px[i] - ps.px[j]
      const dy = ps.py[i] - ps.py[j]
      const dz = ps.pz[i] - ps.pz[j]
      const rSq = dx * dx + dy * dy + dz * dz
      if (rSq < KERNEL_RADIUS_SQ * 4) { // q < 2
        rho += ps.mass[j] * kernelW(rSq)
      }
    }
    // Clamp minimum density
    const mat = MATERIALS[ps.materialIdx[i]]
    ps.density[i] = Math.max(rho, mat.restDensity * 0.5)
  }

  // === 2. Compute pressure: P = B * ((rho/rho0)^gamma - 1) (Tait equation) ===
  for (let i = 0; i < n; i++) {
    const mat = MATERIALS[ps.materialIdx[i]]
    const rho0 = mat.restDensity
    // B = rho0 * c_s^2 / gamma, where c_s ~ 10 * max_velocity (for stability)
    const cs = Math.max(5.0, Math.sqrt(9.81 * BOX_H)) // minimum for stability
    const B = rho0 * cs * cs / GAMMA
    const ratio = ps.density[i] / rho0
    // (ratio)^gamma using pow
    ps.pressure[i] = B * (Math.pow(ratio, GAMMA) - 1)
  }

  // === 3. Compute forces ===
  for (let i = 0; i < n; i++) {
    ps.fx[i] = 0
    ps.fy[i] = 0
    ps.fz[i] = 0
  }

  for (let i = 0; i < n; i++) {
    const mat_i = MATERIALS[ps.materialIdx[i]]
    const rho_i = ps.density[i]
    const P_i = ps.pressure[i]
    const mu_i = mat_i.viscosity

    let fpx = 0, fpy = 0, fpz = 0 // pressure force
    let fvx = 0, fvy = 0, fvz = 0 // viscosity force

    grid.fillNeighbors(ps.px[i], ps.py[i], ps.pz[i])
    const nCount = grid.getNeighborCount()
    for (let k = 0; k < nCount; k++) {
      const j = grid.getNeighborAt(k)
      if (i === j) continue

      const dx = ps.px[i] - ps.px[j]
      const dy = ps.py[i] - ps.py[j]
      const dz = ps.pz[i] - ps.pz[j]
      const rSq = dx * dx + dy * dy + dz * dz
      if (rSq >= KERNEL_RADIUS_SQ * 4) continue // outside support

      const rho_j = ps.density[j]
      const P_j = ps.pressure[j]
      const m_j = ps.mass[j]

      // F_pressure = -sum_j m_j * (P_i/rho_i^2 + P_j/rho_j^2) * grad_W
      const gradF = kernelGradFactor(rSq)
      const pressureTerm = -m_j * (P_i / (rho_i * rho_i) + P_j / (rho_j * rho_j))
      fpx += pressureTerm * gradF * dx
      fpy += pressureTerm * gradF * dy
      fpz += pressureTerm * gradF * dz

      // F_viscosity = mu * sum_j m_j * (v_j - v_i) / rho_j * laplacian_W
      const lap = kernelLaplacian(rSq)
      // Average viscosity for mixed materials
      const mat_j = MATERIALS[ps.materialIdx[j]]
      const mu = (mu_i + mat_j.viscosity) * 0.5
      // No clamp — sub-stepping handles stability for high-viscosity fluids (BUG 1 fix)
      const viscTerm = mu * m_j / rho_j * lap
      fvx += viscTerm * (ps.vx[j] - ps.vx[i])
      fvy += viscTerm * (ps.vy[j] - ps.vy[i])
      fvz += viscTerm * (ps.vz[j] - ps.vz[i])
    }

    // Accumulate pressure + viscosity
    ps.fx[i] += (fpx + fvx) * rho_i
    ps.fy[i] += (fpy + fvy) * rho_i
    ps.fz[i] += (fpz + fvz) * rho_i

    // F_gravity = (0, -g * rho_i, 0)
    ps.fy[i] += -gravity * rho_i

    // F_surface_tension (simplified CSF model for surface particles)
    // We approximate by adding a force toward the centroid of nearby same-material particles
    const sigma = mat_i.surfaceTension
    if (sigma > 0.01) {
      let cx = 0, cy = 0, cz = 0, cnt = 0
      // Re-use the same neighbor data (fillNeighbors already called above)
      grid.fillNeighbors(ps.px[i], ps.py[i], ps.pz[i])
      const nCount2 = grid.getNeighborCount()
      for (let k = 0; k < nCount2; k++) {
        const j = grid.getNeighborAt(k)
        if (i === j) continue
        const ddx = ps.px[i] - ps.px[j]
        const ddy = ps.py[i] - ps.py[j]
        const ddz = ps.pz[i] - ps.pz[j]
        const dSq = ddx * ddx + ddy * ddy + ddz * ddz
        if (dSq < KERNEL_RADIUS_SQ * 4) {
          cx += ps.px[j]
          cy += ps.py[j]
          cz += ps.pz[j]
          cnt++
        }
      }
      if (cnt > 0 && cnt < 20) { // surface particles have fewer neighbors
        cx /= cnt; cy /= cnt; cz /= cnt
        const toX = cx - ps.px[i]
        const toY = cy - ps.py[i]
        const toZ = cz - ps.pz[i]
        const dist = Math.sqrt(toX * toX + toY * toY + toZ * toZ)
        if (dist > 1e-6) {
          const surfaceForce = sigma * 50 * rho_i // reduced from 500 — was pushing particles upward (BUG 1 fix)
          ps.fx[i] += surfaceForce * toX / dist
          ps.fy[i] += surfaceForce * toY / dist
          ps.fz[i] += surfaceForce * toZ / dist
        }
      }
    }
  }

  // === 4. Integrate: symplectic Euler ===
  for (let i = 0; i < n; i++) {
    const invRho = 1.0 / ps.density[i]

    // v += (F / rho) * dt
    ps.vx[i] += ps.fx[i] * invRho * dt
    ps.vy[i] += ps.fy[i] * invRho * dt
    ps.vz[i] += ps.fz[i] * invRho * dt

    // Viscosity-dependent velocity damping (BUG 1 fix — replaces flat 0.98 threshold)
    const mat = MATERIALS[ps.materialIdx[i]]
    const dampFactor = 1.0 / (1.0 + mat.viscosity * dt * 10)
    ps.vx[i] *= dampFactor
    ps.vy[i] *= dampFactor
    ps.vz[i] *= dampFactor

    // Clamp velocity for stability
    const vMag = Math.sqrt(ps.vx[i] * ps.vx[i] + ps.vy[i] * ps.vy[i] + ps.vz[i] * ps.vz[i])
    const maxV = 2.0 // reduced from 5.0 — prevents extreme bouncing (BUG 2 fix)
    if (vMag > maxV) {
      const scale = maxV / vMag
      ps.vx[i] *= scale
      ps.vy[i] *= scale
      ps.vz[i] *= scale
    }

    // pos += v * dt
    ps.px[i] += ps.vx[i] * dt
    ps.py[i] += ps.vy[i] * dt
    ps.pz[i] += ps.vz[i] * dt

    // === 5. Wall collision (penalty force / boundary enforcement) ===
    const restitution = 0.05 // reduced from 0.3 — less bouncy walls (BUG 2 fix)
    const wallPad = PARTICLE_RADIUS

    if (ps.px[i] < -HALF_W + wallPad) {
      ps.px[i] = -HALF_W + wallPad
      ps.vx[i] = Math.abs(ps.vx[i]) * restitution
    }
    if (ps.px[i] > HALF_W - wallPad) {
      ps.px[i] = HALF_W - wallPad
      ps.vx[i] = -Math.abs(ps.vx[i]) * restitution
    }
    if (ps.py[i] < -HALF_H + wallPad) {
      ps.py[i] = -HALF_H + wallPad
      ps.vy[i] = Math.abs(ps.vy[i]) * restitution
    }
    if (ps.py[i] > HALF_H - wallPad) {
      ps.py[i] = HALF_H - wallPad
      ps.vy[i] = -Math.abs(ps.vy[i]) * restitution
    }
    if (ps.pz[i] < -HALF_D + wallPad) {
      ps.pz[i] = -HALF_D + wallPad
      ps.vz[i] = Math.abs(ps.vz[i]) * restitution
    }
    if (ps.pz[i] > HALF_D - wallPad) {
      ps.pz[i] = HALF_D - wallPad
      ps.vz[i] = -Math.abs(ps.vz[i]) * restitution
    }
  }
}

// ── React Component ─────────────────────────────────────────────────────────

export function FluidTest() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [selectedMaterial, setSelectedMaterial] = useState(0)
  const [gravityVal, setGravityVal] = useState(9.81)
  const [timeScale, setTimeScale] = useState(1.0)
  const [fps, setFps] = useState(0)
  const [particleCount, setParticleCount] = useState(0)
  const [showInfo, setShowInfo] = useState(true)
  const [fpsWarning, setFpsWarning] = useState(false)

  // Refs for simulation state that persists across frames
  const simRef = useRef<{
    ps: ParticleSystem
    grid: SpatialHashGrid
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
  } | null>(null)

  const resetSim = useCallback(() => {
    if (!simRef.current) return
    simRef.current.ps.count = 0
    // Clear all instanced meshes
    simRef.current.instancedMeshes.forEach((mesh) => {
      mesh.count = 0
    })
    setParticleCount(0)
    setFpsWarning(false)
  }, [])

  const spawnParticles = useCallback((worldPos: THREE.Vector3) => {
    if (!simRef.current) return
    const { ps } = simRef.current
    const matIdx = simRef.current.selectedMaterial

    // Spawn a cluster of 64 particles in a small sphere
    const positions: [number, number, number][] = []
    const spacing = PARTICLE_RADIUS * 2.2
    const gridSize = 4 // 4x4x4 = 64 particles
    for (let xi = 0; xi < gridSize; xi++) {
      for (let yi = 0; yi < gridSize; yi++) {
        for (let zi = 0; zi < gridSize; zi++) {
          const x = worldPos.x + (xi - gridSize / 2) * spacing
          const y = worldPos.y + (yi - gridSize / 2) * spacing
          const z = worldPos.z + (zi - gridSize / 2) * spacing
          // Clamp to box bounds
          if (Math.abs(x) < HALF_W - PARTICLE_RADIUS &&
              Math.abs(y) < HALF_H - PARTICLE_RADIUS &&
              Math.abs(z) < HALF_D - PARTICLE_RADIUS) {
            positions.push([x, y, z])
          }
        }
      }
    }
    const added = addParticles(ps, positions, matIdx)
    if (added > 0) {
      setParticleCount(ps.count)
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
    const sphereGeo = new THREE.SphereGeometry(PARTICLE_RADIUS, 8, 6)

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

    // ── Particle system ───────────────────────────────────────────────
    const ps = createParticleSystem(MAX_PARTICLES)
    const grid = new SpatialHashGrid(KERNEL_RADIUS)

    // Raycaster for click-to-spawn
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    // ── Store in ref ──────────────────────────────────────────────────
    simRef.current = {
      ps,
      grid,
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
    }

    // ── Click handler ─────────────────────────────────────────────────
    const onPointerDown = (e: PointerEvent) => {
      if (!simRef.current) return
      // Only handle left click, ignore right click (orbit)
      if (e.button !== 0) return
      // Ignore if the click is on the orbit controls (shift/ctrl for orbit)
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      raycaster.setFromCamera(mouse, camera)

      // Intersect with the glass box
      const intersects = raycaster.intersectObject(glassBox)
      if (intersects.length > 0) {
        const pt = intersects[0].point
        // Clamp y to be inside the box, slightly above center for nice drop effect
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
        setFpsWarning(currentFps < 30 && ps.count > 100)
        sim.fpsAccum = 0
        sim.fpsFrames = 0
      }

      // Simulation timestep (clamped for stability)
      const simDt = Math.min(rawDt, 1 / 30) * sim.timeScale
      // 4× sub-stepping prevents tunneling and pressure explosions (BUG 2 fix)
      const subSteps = 4
      const subDt = simDt / subSteps
      for (let s = 0; s < subSteps; s++) {
        sphStep(ps, grid, sim.gravity, subDt)
      }

      // ── Update instanced meshes ────────────────────────────────────
      // Count per material
      const counts = new Map<number, number>()
      MATERIALS.forEach((_, idx) => counts.set(idx, 0))

      // Group particles by material and update transforms
      // We need to set matrix for each particle in its material's instanced mesh
      const offsets = new Map<number, number>()
      MATERIALS.forEach((_, idx) => offsets.set(idx, 0))

      // First pass: count
      for (let i = 0; i < ps.count; i++) {
        const m = ps.materialIdx[i]
        counts.set(m, (counts.get(m) || 0) + 1)
      }

      // Set counts on meshes
      sim.instancedMeshes.forEach((mesh, idx) => {
        mesh.count = counts.get(idx) || 0
      })

      // Second pass: set transforms
      for (let i = 0; i < ps.count; i++) {
        const m = ps.materialIdx[i]
        const mesh = sim.instancedMeshes.get(m)
        if (!mesh) continue
        const localIdx = offsets.get(m) || 0
        offsets.set(m, localIdx + 1)

        dummy.makeTranslation(ps.px[i], ps.py[i], ps.pz[i])
        mesh.setMatrixAt(localIdx, dummy)

        // Color variation based on velocity (faster = brighter)
        const speed = Math.sqrt(
          ps.vx[i] * ps.vx[i] + ps.vy[i] * ps.vy[i] + ps.vz[i] * ps.vz[i],
        )
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
            structure.md S3.2
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
              LOW FPS - Consider Rust/WASM for production
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
            N: {particleCount}
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
                  <div>F_p = -\u03a3 m_j(P_i/\u03c1_i\u00b2 + P_j/\u03c1_j\u00b2)\u2207W</div>
                  <div>F_v = \u03bc\u03a3 m_j(v_j-v_i)/\u03c1_j \u2207\u00b2W</div>
                  <div>Kernel: Cubic spline (M4)</div>
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
