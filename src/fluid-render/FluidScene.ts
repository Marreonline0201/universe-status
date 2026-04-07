// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles as a smooth fluid surface
//
// Three-pass rendering:
//   Pass 1: Main scene (ball, box, grids) → sharp sceneColor
//   Pass 2: Fluid particles only → fluidColor → Gaussian blur → smooth surface
//   Pass 3: Box mask (solid white box) → maskColor (1 inside box, 0 outside)
//   Composite: Beer's law + mask clipping (fluid only visible inside box)
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types
import { pass, Fn, vec4, vec3, float, mix, exp, clamp, pow, smoothstep } from 'three/tsl'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4 bytes per float

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null

  private mainScene: THREE.Scene
  private fluidOnlyScene: THREE.Scene
  private maskScene: THREE.Scene  // solid white box for boundary clipping

  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false
  private currentCount = 0

  renderPipeline: any = null
  private pipelineInitialized = false

  constructor(mainScene: THREE.Scene) {
    this.mainScene = mainScene
    this.fluidOnlyScene = new THREE.Scene()
    this.maskScene = new THREE.Scene()

    // Mask scene: solid white box at [0,1]^3
    // Pixels inside the box render white (mask=1), outside render black (mask=0)
    const maskBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide })
    )
    maskBox.position.set(0.5, 0.5, 0.5)
    this.maskScene.add(maskBox)
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
    this.fluidOnlyScene.add(this.points)
  }

  async initPostProcessing(renderer: any, camera: THREE.PerspectiveCamera) {
    if (this.pipelineInitialized) return

    try {
      // Pass 1: Main scene → sharp
      const scenePass = pass(this.mainScene, camera)
      const sceneColor = scenePass.getTextureNode()

      // Pass 2: Fluid particles → blurred
      const fluidPass = pass(this.fluidOnlyScene, camera)
      const fluidColor = fluidPass.getTextureNode()
      const { gaussianBlur } = await import('three/examples/jsm/tsl/display/GaussianBlurNode.js')
      const smoothFluid = gaussianBlur(fluidColor, null, 4)

      // Pass 3: Box mask → clips fluid to [0,1]^3 boundary
      const maskPass = pass(this.maskScene, camera)
      const maskColor = maskPass.getTextureNode()

      // Composite: Beer's law + box mask
      const output = Fn(() => {
        const scene = sceneColor
        const fluid = smoothFluid
        const mask = maskColor.r // 1.0 inside box, 0.0 outside

        // Kill fluid outside the box
        const rawAlpha = fluid.a.mul(mask)

        // Smooth threshold to clean up any remaining blur tail
        const alpha = smoothstep(float(0.05), float(0.25), rawAlpha)

        // Beer's law: thickness from alpha
        const thickness = alpha.mul(5.0)

        // Absorption: red absorbed most, blue passes through
        const absorption = vec3(1.8, 0.12, 0.03)
        const transmittance = exp(absorption.negate().mul(thickness))

        // Background seen through water
        const transmitted = scene.rgb.mul(transmittance)

        // Volume scattering (subtle blue glow in deep water)
        const scatterColor = vec3(0.05, 0.15, 0.25)
        const scatter = scatterColor.mul(float(1.0).sub(exp(thickness.negate().mul(1.5))))

        // Fresnel approximation at surface edges
        const edgeFactor = float(1.0).sub(alpha).mul(0.8)
        const fresnelBoost = pow(edgeFactor, float(3.0))
        const reflection = vec3(0.4, 0.5, 0.6).mul(fresnelBoost)

        const waterColor = transmitted.add(scatter).add(reflection)

        // Opacity from thickness
        const opacity = clamp(float(1.0).sub(exp(thickness.negate().mul(2.0))), float(0.0), float(1.0))

        return mix(scene, vec4(waterColor, float(1.0)), opacity)
      })()

      this.renderPipeline = new (THREE as any).RenderPipeline(renderer, output)
      this.pipelineInitialized = true
      console.log('SSFR pipeline: three-pass (scene + fluid + mask) initialized')
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
