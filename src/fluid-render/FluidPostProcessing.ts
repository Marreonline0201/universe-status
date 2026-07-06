// ══════════════════════════════════════════════════════════════════════════════
// FluidPostProcessing — SSFR via Three.js PostProcessing
//
// Two-scene approach: blur ONLY the fluid, keep scene objects sharp.
//
//   Pass 1: Render objectScene (box, ball, lights, particles) → sceneColor
//   Pass 2: Render fluidScene (particles only, black bg)     → fluidColor
//   Pass 3: Bilateral blur fluidColor → smooth fluid surface
//   Pass 4: Use fluid brightness as mask to composite:
//           Where fluid is bright → show smooth fluid
//           Where fluid is black (no particles) → show sharp scene
//
// Safety: Falls back to renderer.render() if anything fails.
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
import { pass, float, luminance } from 'three/tsl'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'

export interface FluidPostProcessingConfig {
  blurSigma?: number        // Spatial blur radius (default: 5)
  blurSigmaColor?: number   // Color similarity threshold (default: 0.3)
}

export class FluidPostProcessing {
  private postProcessing: any = null
  private ready = false

  private config: FluidPostProcessingConfig

  constructor(config: FluidPostProcessingConfig = {}) {
    this.config = config
  }

  async init(
    renderer: any,
    objectScene: THREE.Scene,
    fluidScene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): Promise<boolean> {
    try {
      const sigma = this.config.blurSigma ?? 5
      void (this.config.blurSigmaColor ?? 0.3) // reserved for bilateral blur (not yet wired)

      // ── Pass 1: Full scene (sharp) ────────────────────────────────────
      const scenePass = pass(objectScene, camera)
      const sceneColor = scenePass.getTextureNode('output')

      // ── Pass 2: Fluid only (particles on black background) ────────────
      const fluidPass = pass(fluidScene, camera)
      const fluidColor = fluidPass.getTextureNode('output')

      // ── Pass 3: Gaussian blur on fluid ────────────────────────────────
      // Gaussian (not bilateral) — completely dissolves individual particle
      // dots into a smooth continuous field. No edge preservation needed
      // here because this is the fluid-only pass; the scene stays sharp.
      const smoothFluid = gaussianBlur(fluidColor, sigma)

      // ── Pass 4: Transparent overlay composite ──────────────────────────
      // Fluid is additive blue-green: brighter = deeper water.
      // Luminance gives natural depth/opacity: thin water = faint, deep = opaque.
      // The scene shows through thin water (like looking through a pool).
      const fluidOpacity = luminance(smoothFluid).mul(float(8.0)).clamp(0.0, 0.88)

      // Tint the scene behind fluid: multiply by water absorption color.
      // Deep water absorbs red, passes blue-green.
      // scene × (1 - opacity) + fluid × opacity
      const composited = sceneColor.mul(float(1.0).sub(fluidOpacity)).add(smoothFluid.mul(fluidOpacity))

      // ── Wire up pipeline ──────────────────────────────────────────────
      const PipelineClass = (THREE as any).RenderPipeline || (THREE as any).PostProcessing
      this.postProcessing = new PipelineClass(renderer)
      this.postProcessing.outputNode = composited

      this.ready = true
      console.log('[FluidPostProcessing] SSFR pipeline ready (luminance mask)')
      return true
    } catch (e) {
      console.warn('[FluidPostProcessing] Init failed:', e)
      this.ready = false
      this.postProcessing = null
      return false
    }
  }

  render(): boolean {
    if (!this.ready || !this.postProcessing) return false
    try {
      this.postProcessing.render()
      return true
    } catch (e) {
      console.warn('[FluidPostProcessing] Render failed, disabling:', e)
      this.ready = false
      return false
    }
  }

  get isReady(): boolean { return this.ready }

  dispose() {
    this.postProcessing = null
    this.ready = false
  }
}
