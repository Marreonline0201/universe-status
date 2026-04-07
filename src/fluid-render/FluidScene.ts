// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles in the Three.js scene
//
// Particles render as THREE.Points sharing the scene's depth buffer with
// all other objects (ball, box, terrain). Depth ordering is correct.
//
// Current state: particles are visible dots. Smooth surface rendering (SSFR)
// requires proper Three.js TSL documentation and testing — deferred until
// the TSL API can be verified reliably.
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private scene: THREE.Scene
  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false

  // Public — checked by FluidTest.tsx render loop
  renderPipeline: any = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  init(device: GPUDevice) {
    this.device = device

    this.readbackBuffer = device.createBuffer({
      size: MAX_PARTICLES * 80,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })

    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(MAX_PARTICLES * 3)
    const colors = new Float32Array(MAX_PARTICLES * 3)

    this.positionAttr = new THREE.BufferAttribute(positions, 3)
    this.positionAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.positionAttr)

    this.colorAttr = new THREE.BufferAttribute(colors, 3)
    this.colorAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('color', this.colorAttr)

    geo.setDrawRange(0, 0)

    const mat = new THREE.PointsMaterial({
      size: 0.03,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: true,
      depthTest: true,
    })

    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  // No-op — SSFR pipeline deferred
  async initPostProcessing(_renderer: any, _camera: THREE.PerspectiveCamera) {}

  scheduleReadback(encoder: GPUCommandEncoder, particleBuffer: GPUBuffer, count: number) {
    if (!this.readbackBuffer || !this.device) return
    if (this.readbackPending) return

    const n = Math.min(count, MAX_PARTICLES)
    encoder.copyBufferToBuffer(particleBuffer, 0, this.readbackBuffer, 0, n * 80)
  }

  startReadback(count: number) {
    if (!this.readbackBuffer || !this.points || !this.positionAttr || !this.colorAttr) return
    if (this.readbackPending) return

    this.readbackPending = true
    const buf = this.readbackBuffer
    const posAttr = this.positionAttr
    const colAttr = this.colorAttr
    const geo = this.points.geometry
    const n = Math.min(count, MAX_PARTICLES)

    buf.mapAsync(GPUMapMode.READ).then(() => {
      const data = new Float32Array(buf.getMappedRange())
      const positions = posAttr.array as Float32Array
      const colors = colAttr.array as Float32Array

      for (let i = 0; i < n; i++) {
        const src = i * FLOATS_PER_PARTICLE
        const dst = i * 3

        positions[dst] = data[src]
        positions[dst + 1] = data[src + 1]
        positions[dst + 2] = data[src + 2]

        // Light blue-white (transparent water)
        colors[dst] = 0.7
        colors[dst + 1] = 0.8
        colors[dst + 2] = 0.95
      }

      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
      geo.setDrawRange(0, n)

      buf.unmap()
      this.readbackPending = false
    }).catch(() => {
      this.readbackPending = false
    })
  }

  dispose() {
    if (this.points) {
      this.scene.remove(this.points)
      this.points.geometry.dispose()
      ;(this.points.material as THREE.Material).dispose()
      this.points = null
    }
    this.readbackBuffer?.destroy()
    this.readbackBuffer = null
    this.positionAttr = null
    this.colorAttr = null
  }
}
