// ── SPH Fluid Simulation Worker ──────────────────────────────────────────────
// Runs the full SPH solver off the main thread for smooth 60fps rendering.
// Implements real SPH from structure.md section 3.2:
//   - Cubic spline kernel (M4) with proper normalization
//   - Tait equation of state: P = B * ((rho/rho0)^7 - 1)
//   - 5 forces: pressure, viscosity, gravity, surface tension, wall collision
//   - Spatial hash grid for O(n) neighbor search
//   - SoA layout for cache-friendly access

// Worker typing — cast self to any to avoid Window vs Worker postMessage conflicts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workerSelf = self as any
export {} // Make this a module so TS treats it as a worker scope

// ── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_RADIUS = 0.015
const KERNEL_RADIUS = PARTICLE_RADIUS * 4 // h = 0.06
const KERNEL_RADIUS_SQ = KERNEL_RADIUS * KERNEL_RADIUS
const KERNEL_RADIUS_INV = 1.0 / KERNEL_RADIUS
const GAMMA = 7 // Tait equation exponent
const MAX_PARTICLES = 5000

// Box dimensions (sim units)
const BOX_W = 2.0
const BOX_H = 1.5
const BOX_D = 1.5
const HALF_W = BOX_W / 2
const HALF_H = BOX_H / 2
const HALF_D = BOX_D / 2

// Kernel normalization for 3D cubic spline: sigma_3d = 1 / (pi * h^3)
const KERNEL_NORM = 1.0 / (Math.PI * KERNEL_RADIUS * KERNEL_RADIUS * KERNEL_RADIUS)

// ── Material definition ──────────────────────────────────────────────────────

interface Material {
  restDensity: number
  viscosity: number
  surfaceTension: number
}

const materials: Material[] = [
  { restDensity: 1000, viscosity: 0.001, surfaceTension: 0.073 },   // Water
  { restDensity: 1400, viscosity: 50, surfaceTension: 0.065 },      // Honey
  { restDensity: 7800, viscosity: 0.004, surfaceTension: 1.3 },     // Molten Copper
  { restDensity: 13546, viscosity: 0.0015, surfaceTension: 0.49 },  // Mercury
  { restDensity: 920, viscosity: 0.08, surfaceTension: 0.032 },     // Olive Oil
  { restDensity: 2700, viscosity: 500, surfaceTension: 0.4 },       // Lava
  { restDensity: 1060, viscosity: 0.004, surfaceTension: 0.058 },   // Blood
]

// ── Kernel functions ─────────────────────────────────────────────────────────
// Cubic spline (Monaghan M4):
//   W(r,h) = sigma * { 1 - 1.5*q^2 + 0.75*q^3    0 <= q <= 1
//                     { 0.25*(2-q)^3                1 <  q <= 2
//                     { 0                           q > 2
// where q = r/h

function kernelW(r: number): number {
  const q = r * KERNEL_RADIUS_INV
  if (q >= 2.0) return 0.0
  if (q <= 1.0) return KERNEL_NORM * (1.0 - 1.5 * q * q + 0.75 * q * q * q)
  const t = 2.0 - q
  return KERNEL_NORM * 0.25 * t * t * t
}

// Gradient magnitude of kernel divided by r (so you multiply by rij vector)
// dW/dr * (1/r) to avoid computing unit vector separately
function kernelGradOverR(r: number): number {
  if (r < 1e-8) return 0.0
  const q = r * KERNEL_RADIUS_INV
  if (q >= 2.0) return 0.0
  const factor = KERNEL_NORM * KERNEL_RADIUS_INV // sigma / h
  if (q <= 1.0) {
    // dW/dq = -3q + 2.25q^2
    return factor * (-3.0 * q + 2.25 * q * q) / r
  }
  const t = 2.0 - q
  // dW/dq = -0.75*(2-q)^2
  return factor * (-0.75 * t * t) / r
}

// Laplacian of kernel (for viscosity)
function kernelLaplacian(r: number): number {
  const q = r * KERNEL_RADIUS_INV
  if (q >= 2.0) return 0.0
  const lapNorm = KERNEL_NORM / (KERNEL_RADIUS * KERNEL_RADIUS)
  if (q <= 1.0) return lapNorm * (-3.0 + 4.5 * q)
  const t = 2.0 - q
  return lapNorm * (1.5 * t)
}

// ── Spatial Hash Grid ────────────────────────────────────────────────────────
// Cell size = kernel diameter (2h), check 27 neighboring cells

// Cell size = 2*h (kernel support radius) so we only check 3x3x3 = 27 neighbors
const CELL_SIZE = KERNEL_RADIUS * 2.0
const CELL_INV = 1.0 / CELL_SIZE
const TABLE_SIZE = 16381 // prime
const PRIME1 = 73856093
const PRIME2 = 19349663
const PRIME3 = 83492791

// Flat grid with head/next linked lists (no Map, no GC)
let gridHead: Int32Array = new Int32Array(TABLE_SIZE).fill(-1)
let gridNext: Int32Array = new Int32Array(MAX_PARTICLES).fill(-1)

function hashCell(ix: number, iy: number, iz: number): number {
  // Ensure non-negative by adding large offset before modulo
  return ((ix * PRIME1 + iy * PRIME2 + iz * PRIME3) & 0x7FFFFFFF) % TABLE_SIZE
}

function gridClear(): void {
  gridHead.fill(-1)
}

function gridInsert(index: number, x: number, y: number, z: number): void {
  const ix = Math.floor(x * CELL_INV)
  const iy = Math.floor(y * CELL_INV)
  const iz = Math.floor(z * CELL_INV)
  const h = hashCell(ix, iy, iz)
  gridNext[index] = gridHead[h]
  gridHead[h] = index
}

// ── Particle System (SoA layout) ────────────────────────────────────────────

let count = 0
const px = new Float32Array(MAX_PARTICLES)
const py = new Float32Array(MAX_PARTICLES)
const pz = new Float32Array(MAX_PARTICLES)
const vx = new Float32Array(MAX_PARTICLES)
const vy = new Float32Array(MAX_PARTICLES)
const vz = new Float32Array(MAX_PARTICLES)
const fx = new Float32Array(MAX_PARTICLES)
const fy = new Float32Array(MAX_PARTICLES)
const fz = new Float32Array(MAX_PARTICLES)
const mass = new Float32Array(MAX_PARTICLES)
const density = new Float32Array(MAX_PARTICLES)
const pressure = new Float32Array(MAX_PARTICLES)
const matIdx = new Uint8Array(MAX_PARTICLES)

// ── Add Particles ────────────────────────────────────────────────────────────

function addParticles(
  positions: Float32Array, // interleaved x,y,z
  materialIndex: number,
): number {
  const mat = materials[materialIndex]
  if (!mat) return 0

  const volume = (4.0 / 3.0) * Math.PI * PARTICLE_RADIUS * PARTICLE_RADIUS * PARTICLE_RADIUS
  const particleMass = mat.restDensity * volume

  const numPositions = positions.length / 3
  let added = 0

  for (let p = 0; p < numPositions; p++) {
    if (count >= MAX_PARTICLES) break
    const i = count
    px[i] = positions[p * 3]
    py[i] = positions[p * 3 + 1]
    pz[i] = positions[p * 3 + 2]
    vx[i] = 0
    vy[i] = 0
    vz[i] = 0
    mass[i] = particleMass
    density[i] = mat.restDensity
    pressure[i] = 0
    matIdx[i] = materialIndex
    count++
    added++
  }
  return added
}

// ── SPH Step ─────────────────────────────────────────────────────────────────

function sphStep(gravity: number, dt: number): void {
  const n = count
  if (n === 0) return

  // === Build spatial hash ===
  gridClear()
  for (let i = 0; i < n; i++) {
    gridInsert(i, px[i], py[i], pz[i])
  }

  // === 1. Compute density ===
  // rho_i = sum_j m_j * W(|r_i - r_j|, h)
  for (let i = 0; i < n; i++) {
    const xi = px[i], yi = py[i], zi = pz[i]
    let rho = 0.0

    // Determine cell for this particle
    const cix = Math.floor(xi * CELL_INV)
    const ciy = Math.floor(yi * CELL_INV)
    const ciz = Math.floor(zi * CELL_INV)

    // Check 5x5x5 neighborhood (since cell size = h and support = 2h, need +/-2)
    for (let dix = -1; dix <= 1; dix++) {
      for (let diy = -1; diy <= 1; diy++) {
        for (let diz = -1; diz <= 1; diz++) {
          const h = hashCell(cix + dix, ciy + diy, ciz + diz)
          let j = gridHead[h]
          while (j !== -1) {
            const ddx = xi - px[j]
            const ddy = yi - py[j]
            const ddz = zi - pz[j]
            const rSq = ddx * ddx + ddy * ddy + ddz * ddz
            if (rSq < KERNEL_RADIUS_SQ * 4.0) { // q < 2
              rho += mass[j] * kernelW(Math.sqrt(rSq))
            }
            j = gridNext[j]
          }
        }
      }
    }

    // Clamp minimum density to avoid division issues
    const mat = materials[matIdx[i]]
    density[i] = rho > mat.restDensity * 0.3 ? rho : mat.restDensity * 0.3
  }

  // === 2. Compute pressure via Tait equation ===
  // P = B * ((rho/rho0)^gamma - 1)
  // B = rho0 * cs^2 / gamma, with cs = 20 (high speed of sound for incompressibility)
  for (let i = 0; i < n; i++) {
    const mat = materials[matIdx[i]]
    const rho0 = mat.restDensity
    const cs = 20.0
    const B = rho0 * cs * cs / GAMMA
    const ratio = density[i] / rho0

    // Fast integer power for gamma=7: ratio^7 = ratio^4 * ratio^2 * ratio
    const r2 = ratio * ratio
    const r4 = r2 * r2
    const r7 = r4 * r2 * ratio

    pressure[i] = B * (r7 - 1.0)
  }

  // === 3. Compute forces ===
  // Zero force accumulators
  for (let i = 0; i < n; i++) {
    fx[i] = 0.0
    fy[i] = 0.0
    fz[i] = 0.0
  }

  for (let i = 0; i < n; i++) {
    const xi = px[i], yi = py[i], zi = pz[i]
    const vxi = vx[i], vyi = vy[i], vzi = vz[i]
    const rho_i = density[i]
    const P_i = pressure[i]
    const mi = matIdx[i]
    const mu_i = materials[mi].viscosity
    const sigma_i = materials[mi].surfaceTension

    let fpx = 0.0, fpy = 0.0, fpz = 0.0 // pressure
    let fvx = 0.0, fvy = 0.0, fvz = 0.0 // viscosity
    let stx = 0.0, sty = 0.0, stz = 0.0 // surface tension centroid
    let stCount = 0

    const cix = Math.floor(xi * CELL_INV)
    const ciy = Math.floor(yi * CELL_INV)
    const ciz = Math.floor(zi * CELL_INV)

    const P_over_rho2_i = P_i / (rho_i * rho_i)

    for (let dix = -1; dix <= 1; dix++) {
      for (let diy = -1; diy <= 1; diy++) {
        for (let diz = -1; diz <= 1; diz++) {
          const h = hashCell(cix + dix, ciy + diy, ciz + diz)
          let j = gridHead[h]
          while (j !== -1) {
            if (j !== i) {
              const ddx = xi - px[j]
              const ddy = yi - py[j]
              const ddz = zi - pz[j]
              const rSq = ddx * ddx + ddy * ddy + ddz * ddz

              if (rSq < KERNEL_RADIUS_SQ * 4.0) {
                const r = Math.sqrt(rSq)
                const rho_j = density[j]
                const m_j = mass[j]

                // --- Pressure force ---
                // F_pressure = -m_j * (P_i/rho_i^2 + P_j/rho_j^2) * gradW
                const gradOR = kernelGradOverR(r)
                const P_over_rho2_j = pressure[j] / (rho_j * rho_j)
                const pressCoeff = -m_j * (P_over_rho2_i + P_over_rho2_j)
                fpx += pressCoeff * gradOR * ddx
                fpy += pressCoeff * gradOR * ddy
                fpz += pressCoeff * gradOR * ddz

                // --- Viscosity force ---
                // F_visc = mu * m_j * (v_j - v_i) / rho_j * lap_W
                const mj = matIdx[j]
                const mu = (mu_i + materials[mj].viscosity) * 0.5
                // Clamp viscosity coefficient to prevent instability
                // For very high viscosity (honey, lava), limit the per-step effect
                const muClamped = Math.min(mu, 5.0)
                const lap = kernelLaplacian(r)
                const viscCoeff = muClamped * m_j / rho_j * lap
                fvx += viscCoeff * (vx[j] - vxi)
                fvy += viscCoeff * (vy[j] - vyi)
                fvz += viscCoeff * (vz[j] - vzi)

                // --- Surface tension (centroid tracking) ---
                stx += px[j]
                sty += py[j]
                stz += pz[j]
                stCount++
              }
            }
            j = gridNext[j]
          }
        }
      }
    }

    // Accumulate pressure + viscosity forces (per-unit-mass, multiply by density)
    fx[i] += (fpx + fvx) * rho_i
    fy[i] += (fpy + fvy) * rho_i
    fz[i] += (fpz + fvz) * rho_i

    // Surface tension: simplified CSF — pull toward centroid if on surface
    if (sigma_i > 0.005 && stCount > 0 && stCount < 40) {
      stx /= stCount
      sty /= stCount
      stz /= stCount
      const toX = stx - xi
      const toY = sty - yi
      const toZ = stz - zi
      const dist = Math.sqrt(toX * toX + toY * toY + toZ * toZ)
      if (dist > 1e-6) {
        const surfaceForce = sigma_i * 30.0 * rho_i
        fx[i] += surfaceForce * toX / dist
        fy[i] += surfaceForce * toY / dist
        fz[i] += surfaceForce * toZ / dist
      }
    }
  }

  // === 4. Integration: symplectic Euler ===
  for (let i = 0; i < n; i++) {
    const invRho = 1.0 / density[i]

    // Apply SPH forces (pressure + viscosity + surface tension)
    // NO artificial damping — the SPH viscosity IS the damping
    vx[i] += fx[i] * invRho * dt
    vy[i] += fy[i] * invRho * dt
    vz[i] += fz[i] * invRho * dt

    // Apply gravity DIRECTLY — never damped by anything
    vy[i] -= gravity * dt

    // Velocity clamping for stability (generous limit)
    const vMag2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]
    const maxV = 5.0
    if (vMag2 > maxV * maxV) {
      const scale = maxV / Math.sqrt(vMag2)
      vx[i] *= scale
      vy[i] *= scale
      vz[i] *= scale
    }

    // Position update
    px[i] += vx[i] * dt
    py[i] += vy[i] * dt
    pz[i] += vz[i] * dt

    // === 5. Wall collision ===
    const wallPad = PARTICLE_RADIUS

    // Floor: zero velocity (no bounce — fluid settles)
    if (py[i] < -HALF_H + wallPad) {
      py[i] = -HALF_H + wallPad
      vy[i] = 0.0
    }
    // Ceiling: slight bounce
    if (py[i] > HALF_H - wallPad) {
      py[i] = HALF_H - wallPad
      vy[i] = -Math.abs(vy[i]) * 0.05
    }
    // Walls: slight bounce
    if (px[i] < -HALF_W + wallPad) {
      px[i] = -HALF_W + wallPad
      vx[i] = Math.abs(vx[i]) * 0.1
    }
    if (px[i] > HALF_W - wallPad) {
      px[i] = HALF_W - wallPad
      vx[i] = -Math.abs(vx[i]) * 0.1
    }
    if (pz[i] < -HALF_D + wallPad) {
      pz[i] = -HALF_D + wallPad
      vz[i] = Math.abs(vz[i]) * 0.1
    }
    if (pz[i] > HALF_D - wallPad) {
      pz[i] = HALF_D - wallPad
      vz[i] = -Math.abs(vz[i]) * 0.1
    }
  }
}

// ── Get results as transferable buffers ──────────────────────────────────────

function getPositionsBuffer(): Float32Array {
  const buf = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    buf[i * 3] = px[i]
    buf[i * 3 + 1] = py[i]
    buf[i * 3 + 2] = pz[i]
  }
  return buf
}

function getVelocitiesBuffer(): Float32Array {
  const buf = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    buf[i * 3] = vx[i]
    buf[i * 3 + 1] = vy[i]
    buf[i * 3 + 2] = vz[i]
  }
  return buf
}

function getMaterialsBuffer(): Uint8Array {
  return new Uint8Array(matIdx.buffer, 0, count).slice()
}

// ── Worker message handler ───────────────────────────────────────────────────

workerSelf.onmessage = (e: MessageEvent) => {
  const msg = e.data

  switch (msg.type) {
    case 'addParticles': {
      const added = addParticles(msg.positions as Float32Array, msg.materialIndex as number)
      workerSelf.postMessage({ type: 'particlesAdded', count, added })
      break
    }

    case 'step': {
      const { gravity, dt, subSteps } = msg as { gravity: number; dt: number; subSteps: number }
      const subDt = dt / subSteps
      for (let s = 0; s < subSteps; s++) {
        sphStep(gravity, subDt)
      }

      // Send back positions, velocities, materials as transferable
      const posBuf = getPositionsBuffer()
      const velBuf = getVelocitiesBuffer()
      const matBuf = getMaterialsBuffer()

      workerSelf.postMessage(
        {
          type: 'stepResult',
          positions: posBuf,
          velocities: velBuf,
          materials: matBuf,
          count,
        },
        // Transfer ownership of the buffers (zero-copy)
        { transfer: [posBuf.buffer, velBuf.buffer, matBuf.buffer] },
      )
      break
    }

    case 'reset': {
      count = 0
      workerSelf.postMessage({ type: 'resetDone', count: 0 })
      break
    }

    case 'init': {
      // Reinitialize if needed
      count = 0
      gridHead = new Int32Array(TABLE_SIZE).fill(-1)
      gridNext = new Int32Array(MAX_PARTICLES).fill(-1)
      workerSelf.postMessage({ type: 'initDone', maxParticles: MAX_PARTICLES })
      break
    }

    default:
      break
  }
}

// Signal ready
workerSelf.postMessage({ type: 'ready' })
