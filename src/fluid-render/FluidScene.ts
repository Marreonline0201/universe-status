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
import { pass, Fn, vec4, vec3, float, mix, exp, clamp, max, pow, dot, normalize, smoothstep } from 'three/tsl'

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
      size: 0.055,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending,
    })

    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false

    // Add particles to the fluid-only scene (for isolated blur)
    this.fluidOnlyScene.add(this.points)

    // ── Depth clip box ──────────────────────────────────────────────────
    // Invisible box that writes depth but no color. Its walls block point
    // sprite fragments from rendering past the [0,1]^3 boundary.
    // From any external camera angle, the box walls are CLOSER to the camera
    // than particles inside → sprites extending past walls fail depth test.
    const clipBoxGeo = new THREE.BoxGeometry(1, 1, 1)
    const clipBoxMat = new THREE.MeshBasicMaterial({
      colorWrite: false,   // invisible — writes no color
      depthWrite: true,    // but DOES write depth
      side: THREE.FrontSide,
    })
    const clipBox = new THREE.Mesh(clipBoxGeo, clipBoxMat)
    clipBox.position.set(0.5, 0.5, 0.5)
    clipBox.renderOrder = -1 // render BEFORE particles so depth is ready
    this.fluidOnlyScene.add(clipBox)
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

      // Gaussian blur on fluid only — sigma=4 merges particles while limiting edge bleed
      const { gaussianBlur } = await import('three/examples/jsm/tsl/display/GaussianBlurNode.js')
      const smoothFluid = gaussianBlur(fluidColor, null, 4)

      // Composite: Beer's law absorption + Fresnel reflection
      // Water is transparent. Its color comes from PHYSICS:
      //   - Beer's law: light passing through water loses red first → blue tint
      //   - Thicker water = more absorption = deeper blue
      //   - Thin water = nearly invisible
      //   - Surface reflection adds brightness at glancing angles (Fresnel)
      const output = Fn(() => {
        const scene = sceneColor
        const fluid = smoothFluid

        // Cut blur tails: faint alpha outside the box (0.0-0.1) gets suppressed.
        // This prevents fluid bleeding past the glass walls.
        const rawAlpha = smoothstep(float(0.08), float(0.3), fluid.a)

        // Fluid alpha = proxy for optical thickness (0 = no water, 1 = thick water)
        const thickness = rawAlpha.mul(5.0) // scale for visual range

        // Beer's law: transmittance = exp(-absorption * thickness)
        // Water absorbs red >> green >> blue (real coefficients scaled for visual effect)
        const absorption = vec3(1.8, 0.12, 0.03) // red absorbed most, blue passes through
        const transmittance = exp(absorption.negate().mul(thickness))

        // Background light filtered through water (what you see through the surface)
        const transmitted = scene.rgb.mul(transmittance)

        // Scattered light within the water body (slight blue glow from volume scattering)
        const scatterColor = vec3(0.05, 0.15, 0.25)
        const scatter = scatterColor.mul(float(1.0).sub(exp(thickness.negate().mul(1.5))))

        // Fresnel-like surface reflection (brighter at edges where alpha transitions)
        const edgeFactor = float(1.0).sub(rawAlpha).mul(0.8)
        const fresnelBoost = pow(edgeFactor, float(3.0))
        const reflectionColor = vec3(0.4, 0.5, 0.6) // dim environment reflection
        const reflection = reflectionColor.mul(fresnelBoost)

        // Combine: transmitted background + volume scatter + surface reflection
        const waterColor = transmitted.add(scatter).add(reflection)

        // Opacity: thin water is nearly transparent, thick water is opaque
        const opacity = clamp(float(1.0).sub(exp(thickness.negate().mul(2.0))), float(0.0), float(1.0))

        return mix(scene, vec4(waterColor, float(1.0)), opacity)
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

        // Pure white — particles are thickness carriers only.
        // All color comes from Beer's law absorption in the composite shader.
        colors[dst] = 1.0
        colors[dst + 1] = 1.0
        colors[dst + 2] = 1.0
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
