// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — SSFR Depth Pipeline for smooth fluid surface rendering
//
// Proper Screen-Space Fluid Rendering:
//   Pass 1: Main scene (ball, box, grids) → sharp sceneColor
//   Pass 2: Fluid particles → fluidColor + fluidDepth
//   Bilateral blur on fluid color (merges particles, stops at fluid edge)
//   Normal reconstruction from fluid depth (Three.js getNormalFromDepth)
//   Composite: Beer's law + Fresnel + specular using reconstructed normals
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types
import {
  pass, Fn, vec3, vec4, float, mix, exp, clamp, pow, smoothstep,
  normalize, dot, max, sub, add, mul, reflect, screenUV,
  cameraProjectionMatrixInverse, getNormalFromDepth,
} from 'three/tsl'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4 bytes per float

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null

  private mainScene: THREE.Scene
  private fluidOnlyScene: THREE.Scene

  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false
  private currentCount = 0

  renderPipeline: any = null
  private pipelineInitialized = false

  constructor(mainScene: THREE.Scene) {
    this.mainScene = mainScene
    this.fluidOnlyScene = new THREE.Scene()
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
      size: 0.08,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
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

      // Pass 2: Fluid particles → color + depth
      const fluidPass = pass(this.fluidOnlyScene, camera)
      const fluidColor = fluidPass.getTextureNode()
      const fluidDepth = fluidPass.getLinearDepthNode()
      const fluidDepthTexture = fluidPass.getDepthNode().renderTarget.depthTexture

      // Bilateral blur: merges particles, stops at fluid edge
      const { bilateralBlur } = await import('three/examples/jsm/tsl/display/BilateralBlurNode.js')
      const smoothFluid = bilateralBlur(fluidColor, fluidDepth, 12, 0.15)

      // Normal reconstruction from fluid depth using Three.js built-in
      // Uses finite differences on the depth buffer (same technique as §3.2 spec)
      const fluidNormal = getNormalFromDepth(screenUV, fluidDepthTexture, cameraProjectionMatrixInverse)

      // ── SSFR Composite ──
      const output = Fn(() => {
        const scene = sceneColor
        const fluid = smoothFluid

        // Fluid presence
        const alpha = smoothstep(float(0.02), float(0.25), fluid.a)

        // Reconstruct surface normal from depth
        const normal = fluidNormal

        // View direction (camera looks along -Z in view space)
        const viewDir = vec3(0.0, 0.0, -1.0)

        // ── Beer's law absorption ──
        const thickness = alpha.mul(5.0)
        const absorption = vec3(1.8, 0.12, 0.03)
        const transmittance = exp(absorption.negate().mul(thickness))
        const transmitted = scene.rgb.mul(transmittance)

        // ── Volume scattering ──
        const scatterCol = vec3(0.04, 0.12, 0.22)
        const scatter = scatterCol.mul(sub(float(1.0), exp(thickness.negate().mul(1.5))))

        // ── Fresnel: F = F0 + (1-F0)(1 - N·V)^5 ──
        const F0 = float(0.02)
        const NdotV = max(dot(normal, viewDir.negate()), float(0.0))
        const fresnel = clamp(
          add(F0, mul(sub(float(1.0), F0), pow(sub(float(1.0), NdotV), float(5.0)))),
          float(0.0), float(1.0)
        )

        // ── Environment reflection ──
        const reflDir = reflect(viewDir, normal)
        const skyUp = max(reflDir.y, float(0.0))
        const envColor = mix(vec3(0.1, 0.15, 0.25), vec3(0.4, 0.5, 0.7), skyUp)

        // ── Specular (Blinn-Phong) ──
        const lightDir = normalize(vec3(3.0, 5.0, 3.0))
        const halfDir = normalize(add(lightDir, viewDir.negate()))
        const specAngle = max(dot(normal, halfDir), float(0.0))
        const specular = pow(specAngle, float(150.0)).mul(1.5)

        // ── Diffuse ──
        const NdotL = max(dot(normal, lightDir), float(0.0))
        const diffuse = float(0.3).add(NdotL.mul(0.5))

        // ── Combine ──
        const waterBody = add(transmitted, scatter).mul(diffuse)
        const reflectionContrib = envColor.mul(fresnel)
        const waterColor = add(waterBody, reflectionContrib).add(vec3(specular, specular, specular))

        const opacity = clamp(sub(float(1.0), exp(thickness.negate().mul(2.0))), float(0.0), float(1.0))

        return mix(scene, vec4(waterColor, float(1.0)), opacity)
      })()

      this.renderPipeline = new (THREE as any).RenderPipeline(renderer, output)
      this.pipelineInitialized = true
      console.log('SSFR pipeline: depth normals + Beer\'s law + Fresnel + specular')
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
