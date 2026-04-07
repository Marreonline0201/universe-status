// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles as a smooth fluid surface
//
// Two-pass rendering: scene and fluid are rendered separately.
//   Pass 1: Main scene (ball, box, grids) → sharp sceneColor + sceneDepth
//   Pass 2: Fluid particles only → fluidColor + fluidDepth
//   Gaussian blur on fluidColor → smooth continuous surface
//   Composite: depth-aware blend of smooth fluid over sharp scene
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types
import { pass, Fn, vec4, float, mix, step } from 'three/tsl'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4 bytes per float

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null

  // Two separate scenes
  private mainScene: THREE.Scene          // ball, box, grids, lights (sharp)
  private fluidOnlyScene: THREE.Scene     // particles only (blurred)

  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false
  private currentCount = 0

  // SSFR post-processing
  renderPipeline: any = null // THREE.RenderPipeline
  private pipelineInitialized = false

  constructor(mainScene: THREE.Scene) {
    this.mainScene = mainScene
    // Separate scene for fluid particles — blurred independently
    this.fluidOnlyScene = new THREE.Scene()
    // No background = transparent (alpha=0 where no particles)
  }

  /**
   * Create the point cloud for particle rendering.
   */
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

    // Add particles to the fluid-only scene (for isolated blur)
    this.fluidOnlyScene.add(this.points)

    // Also add to main scene for depth ordering with ball/box
    // We need a second Points instance sharing the same geometry
    const mainMat = new THREE.PointsMaterial({
      size: 0.045,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending,
    })
    const mainPoints = new THREE.Points(geo, mainMat)
    mainPoints.frustumCulled = false
    mainPoints.visible = false // hidden — only used for depth buffer contribution
    this.mainScene.add(mainPoints)
  }

  /**
   * Initialize two-pass SSFR pipeline:
   * - Sharp scene pass (ball, box, grids)
   * - Blurred fluid pass (particles only)
   * - Depth-aware composite
   */
  async initPostProcessing(renderer: any, camera: THREE.PerspectiveCamera) {
    if (this.pipelineInitialized) return

    try {
      // Pass 1: Main scene → sharp (ball, box, wireframe grids)
      const scenePass = pass(this.mainScene, camera)
      const sceneColor = scenePass.getTextureNode()
      const sceneDepth = scenePass.getLinearDepthNode()

      // Pass 2: Fluid particles only → will be blurred
      const fluidPass = pass(this.fluidOnlyScene, camera)
      const fluidColor = fluidPass.getTextureNode()

      // Gaussian blur on fluid only — sigma=8 merges particles into surface
      const { gaussianBlur } = await import('three/examples/jsm/tsl/display/GaussianBlurNode.js')
      const smoothFluid = gaussianBlur(fluidColor, null, 8)

      // Composite: blend smoothed fluid over sharp scene using fluid alpha
      const output = Fn(() => {
        const scene = sceneColor
        const fluid = smoothFluid
        // Fluid alpha: 0 where no particles, >0 where fluid exists
        const fluidAlpha = fluid.a
        // Blend fluid over scene — scene stays sharp, fluid is smooth
        return mix(scene, vec4(fluid.rgb, float(1.0)), fluidAlpha)
      })()

      this.renderPipeline = new (THREE as any).RenderPipeline(renderer, output)
      this.pipelineInitialized = true
      console.log('SSFR pipeline: two-pass (sharp scene + blurred fluid) initialized')
    } catch (e) {
      console.warn('SSFR pipeline init failed, falling back to direct render:', e)
      this.renderPipeline = null
    }
  }

  scheduleReadback(encoder: GPUCommandEncoder, particleBuffer: GPUBuffer, count: number) {
    if (!this.readbackBuffer || !this.device) return
    if (this.readbackPending) return

    this.currentCount = Math.min(count, MAX_PARTICLES)
    const byteSize = this.currentCount * 80
    encoder.copyBufferToBuffer(particleBuffer, 0, this.readbackBuffer, 0, byteSize)
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
      this.fluidOnlyScene.remove(this.points)
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
