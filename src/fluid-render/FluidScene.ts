// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles in the Three.js scene with SSFR
//
// Particles share the scene's depth buffer with all other objects (ball, box,
// terrain, organisms). Depth ordering is automatic — no overlay canvas needed.
//
// Rendering approach:
//   1. Particles as THREE.Points in the scene (shared depth buffer)
//   2. Scene rendered via pass() into a render target
//   3. Bilateral blur smooths particle boundaries into a continuous surface
//   4. Final output via RenderPipeline
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types not in @types/three
import { pass, renderOutput } from 'three/tsl'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4 bytes per float

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private scene: THREE.Scene
  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false
  private currentCount = 0

  // SSFR post-processing
  renderPipeline: any = null // THREE.RenderPipeline
  private pipelineInitialized = false

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  /**
   * Create the point cloud for particle rendering.
   * device: shared GPUDevice from Three.js renderer
   */
  init(device: GPUDevice) {
    this.device = device

    // Create readback buffer for GPU → CPU position transfer
    this.readbackBuffer = device.createBuffer({
      size: MAX_PARTICLES * 80,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })

    // Buffer geometry with pre-allocated position + color arrays
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(MAX_PARTICLES * 3)
    const colors = new Float32Array(MAX_PARTICLES * 3)

    this.positionAttr = new THREE.BufferAttribute(positions, 3)
    this.positionAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.positionAttr)

    this.colorAttr = new THREE.BufferAttribute(colors, 3)
    this.colorAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('color', this.colorAttr)

    // Draw range starts at 0
    geo.setDrawRange(0, 0)

    // Point material with size attenuation — spherical sprites
    const mat = new THREE.PointsMaterial({
      size: 0.025,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: true,
      blending: THREE.NormalBlending,
    })

    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  /**
   * Initialize the SSFR post-processing pipeline.
   * Must be called after renderer.init() and scene setup.
   */
  async initPostProcessing(renderer: any, camera: THREE.PerspectiveCamera) {
    if (this.pipelineInitialized) return

    try {
      // Render the full scene (particles + ball + box) to a render target
      const scenePass = pass(this.scene, camera)
      const sceneColor = scenePass.getTextureNode()
      const sceneDepth = scenePass.getLinearDepthNode()

      // Bilateral blur: smooths particle boundaries while preserving depth edges
      // sigma=4 spatial, sigmaColor=0.1 for edge preservation
      const { bilateralBlur } = await import('three/examples/jsm/tsl/display/BilateralBlurNode.js')
      const blurred = bilateralBlur(sceneColor, sceneDepth, 4, 0.1)

      // Create the render pipeline with blurred output
      this.renderPipeline = new (THREE as any).RenderPipeline(renderer, blurred)
      this.pipelineInitialized = true
      console.log('SSFR post-processing pipeline initialized')
    } catch (e) {
      console.warn('SSFR pipeline init failed, falling back to direct render:', e)
      this.renderPipeline = null
    }
  }

  /**
   * Copy particle buffer from GPU and schedule async readback.
   * Call this after gpuSim.step() with the same command encoder.
   */
  scheduleReadback(encoder: GPUCommandEncoder, particleBuffer: GPUBuffer, count: number) {
    if (!this.readbackBuffer || !this.device) return
    if (this.readbackPending) return // previous readback still in flight

    this.currentCount = Math.min(count, MAX_PARTICLES)
    const byteSize = this.currentCount * 80
    encoder.copyBufferToBuffer(particleBuffer, 0, this.readbackBuffer, 0, byteSize)
  }

  /**
   * After command buffer submission, start the async readback.
   * Updates point positions when data arrives (one frame behind — acceptable).
   */
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

        // Position: first 3 floats of particle struct
        positions[dst] = data[src]
        positions[dst + 1] = data[src + 1]
        positions[dst + 2] = data[src + 2]

        // Default water color — per-composition coloring comes in Task 6
        colors[dst] = 0.13
        colors[dst + 1] = 0.4
        colors[dst + 2] = 0.87
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
    this.renderPipeline?.dispose()
    this.renderPipeline = null
    this.readbackBuffer?.destroy()
    this.readbackBuffer = null
    this.positionAttr = null
    this.colorAttr = null
  }
}
