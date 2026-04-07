// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles as a smooth fluid surface
//
// Particles share the scene's depth buffer with all other objects (ball, box,
// terrain, organisms). Depth ordering is automatic — no overlay canvas needed.
//
// Rendering approach:
//   1. Particles as large, overlapping soft circles (THREE.Points + alphaMap)
//   2. Scene rendered via pass() into a render target
//   3. Strong bilateral blur merges particles into a continuous surface
//   4. Final output via RenderPipeline
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types not in @types/three
import { pass } from 'three/tsl'

const MAX_PARTICLES = 300_000
const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4 bytes per float

/**
 * Create a circular soft-edge texture for particle sprites.
 * Smooth radial falloff from center (opaque) to edge (transparent).
 */
function createSoftCircleTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half
      const dy = (y - half + 0.5) / half
      const r = Math.sqrt(dx * dx + dy * dy)
      // Smooth falloff: 1 at center, 0 at edge, with soft transition
      const alpha = Math.max(0, 1.0 - r)
      const smoothAlpha = alpha * alpha * (3 - 2 * alpha) // smoothstep
      const byte = Math.round(smoothAlpha * 255)
      const i = (y * size + x) * 4
      data[i] = 255     // R
      data[i + 1] = 255 // G
      data[i + 2] = 255 // B
      data[i + 3] = byte // A
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.needsUpdate = true
  return tex
}

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private scene: THREE.Scene
  private device: GPUDevice | null = null
  private readbackBuffer: GPUBuffer | null = null
  private readbackPending = false
  private currentCount = 0
  private softCircleTex: THREE.DataTexture | null = null

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

    // Soft circle texture for smooth particle edges
    this.softCircleTex = createSoftCircleTexture(64)

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

    geo.setDrawRange(0, 0)

    // Large overlapping soft circles — bilateral blur merges them into a surface
    const mat = new THREE.PointsMaterial({
      size: 0.06,               // large enough to overlap heavily
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending,
      map: this.softCircleTex,  // circular soft-edge shape
      alphaTest: 0.01,          // discard nearly invisible fragments
    })

    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  /**
   * Initialize the SSFR post-processing pipeline.
   * Strong bilateral blur smooths overlapping particles into a continuous surface.
   */
  async initPostProcessing(renderer: any, camera: THREE.PerspectiveCamera) {
    if (this.pipelineInitialized) return

    try {
      // Render the full scene (particles + ball + box) to a render target
      const scenePass = pass(this.scene, camera)
      const sceneColor = scenePass.getTextureNode()
      const sceneDepth = scenePass.getLinearDepthNode()

      // Strong bilateral blur: sigma=10 spatial to merge particles,
      // sigmaColor=0.05 to preserve edges between fluid and background
      const { bilateralBlur } = await import('three/examples/jsm/tsl/display/BilateralBlurNode.js')
      const blurred = bilateralBlur(sceneColor, sceneDepth, 10, 0.05)

      this.renderPipeline = new (THREE as any).RenderPipeline(renderer, blurred)
      this.pipelineInitialized = true
      console.log('SSFR post-processing pipeline initialized (sigma=10)')
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
   * Updates point positions when data arrives (one frame behind).
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

        // Water blue — per-composition coloring comes later
        colors[dst] = 0.15
        colors[dst + 1] = 0.45
        colors[dst + 2] = 0.9
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
    this.softCircleTex?.dispose()
    this.softCircleTex = null
    this.renderPipeline?.dispose()
    this.renderPipeline = null
    this.readbackBuffer?.destroy()
    this.readbackBuffer = null
    this.positionAttr = null
    this.colorAttr = null
  }
}
