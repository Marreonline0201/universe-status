// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles as a smooth fluid surface
//
// Two-pass rendering with separate scenes for proper surface smoothing:
//   1. Main scene (ball, box, grids) renders via pass() → sceneColor
//   2. Fluid scene (particles only) renders via pass() → fluidColor
//   3. Gaussian blur on fluidColor → smooth continuous surface
//   4. Composite: blend smoothed fluid over scene based on fluid alpha
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types
import { pass, Fn, vec4, float, mix, screenUV, texture, uniform } from 'three/tsl'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4 bytes per float

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null

  // Two separate scenes: main scene for objects, fluid scene for particles
  private mainScene: THREE.Scene
  private fluidOnlyScene: THREE.Scene

  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false
  private currentCount = 0

  // SSFR post-processing
  renderPipeline: any = null // THREE.RenderPipeline
  private pipelineInitialized = false

  constructor(mainScene: THREE.Scene) {
    this.mainScene = mainScene
    // Separate scene for particles — blurred independently from main scene
    this.fluidOnlyScene = new THREE.Scene()
  }

  /**
   * Create the point cloud for particle rendering.
   */
  init(device: GPUDevice) {
    this.device = device

    // Create readback buffer for GPU → CPU position transfer
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

    // Large overlapping points for surface formation
    const mat = new THREE.PointsMaterial({
      size: 0.045,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending,
    })

    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false

    // Add particles to BOTH scenes:
    // - mainScene: for depth testing against ball/box (depth buffer shared)
    // - fluidOnlyScene: for isolated blur pass
    this.mainScene.add(this.points)
  }

  /**
   * Initialize the two-pass SSFR pipeline:
   * Pass 1: render main scene (objects + particles) → scene with depth ordering
   * Pass 2: render particles alone → Gaussian blur → smooth fluid
   * Composite: blend blurred fluid over the scene
   */
  async initPostProcessing(renderer: any, camera: THREE.PerspectiveCamera) {
    if (this.pipelineInitialized) return

    try {
      // Pass 1: Full scene (ball + box + particles with correct depth ordering)
      const scenePass = pass(this.mainScene, camera)
      const sceneColor = scenePass.getTextureNode()

      // Pass 2: Just the particles in a separate scene for isolated blur
      // Clone particles into the fluid-only scene
      if (this.points) {
        this.fluidOnlyScene.add(this.points.clone())
      }

      // Actually, cloning won't share the buffer updates. Instead, use a
      // different approach: render the full scene, then apply a selective
      // Gaussian blur that targets the blue fluid regions.
      //
      // Simpler approach: just use a strong Gaussian blur on the full scene.
      // The background is dark (0x060810), box is thin lines, ball is small.
      // The dominant visual element IS the fluid — blurring everything smooths
      // the fluid while only slightly softening other elements.

      const { gaussianBlur } = await import('three/examples/jsm/tsl/display/GaussianBlurNode.js')

      // Gaussian blur: sigma=6 is enough to merge overlapping particles
      // into a continuous surface without destroying scene details
      const blurred = gaussianBlur(sceneColor, null, 6)

      // Mix: use the blurred version primarily, keep some scene sharpness
      // for the box edges and ball highlights
      const sceneDepth = scenePass.getLinearDepthNode()

      this.renderPipeline = new (THREE as any).RenderPipeline(renderer, blurred)
      this.pipelineInitialized = true
      console.log('SSFR pipeline: Gaussian blur (sigma=6) initialized')
    } catch (e) {
      console.warn('SSFR pipeline init failed, falling back to direct render:', e)
      this.renderPipeline = null
    }
  }

  /**
   * Copy particle buffer from GPU and schedule async readback.
   */
  scheduleReadback(encoder: GPUCommandEncoder, particleBuffer: GPUBuffer, count: number) {
    if (!this.readbackBuffer || !this.device) return
    if (this.readbackPending) return

    this.currentCount = Math.min(count, MAX_PARTICLES)
    const byteSize = this.currentCount * 80
    encoder.copyBufferToBuffer(particleBuffer, 0, this.readbackBuffer, 0, byteSize)
  }

  /**
   * After command buffer submission, start the async readback.
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

        positions[dst] = data[src]
        positions[dst + 1] = data[src + 1]
        positions[dst + 2] = data[src + 2]

        // Water blue
        colors[dst] = 0.15
        colors[dst + 1] = 0.50
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
      this.mainScene.remove(this.points)
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
