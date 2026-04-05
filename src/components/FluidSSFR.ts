// ══════════════════════════════════════════════════════════════════════════════
// Screen-Space Fluid Rendering (SSFR)
// Implements structure.md §3.2 Tier 2 using Three.js TSL node system
//
// Step 1 (current): Scene pass → bilateral blur → output
//   Smooths the instanced spheres into a softer, more liquid-like appearance.
//
// Step 2 (next): Depth-only pass → bilateral blur on depth → normal
//   reconstruction → Fresnel + Beer's law compositing
//
// Uses RenderPipeline (PostProcessing) with TSL nodes.
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'
// @ts-ignore — TSL types not in @types/three
import { pass } from 'three/tsl'
// @ts-ignore
import { bilateralBlur } from 'three/examples/jsm/tsl/display/BilateralBlurNode.js'

export interface SSFROptions {
  particleRadius: number
  fluidColor: THREE.Color
  absorption: THREE.Vector3
}

/**
 * SSFR Pipeline — wraps Three.js RenderPipeline with bilateral blur.
 *
 * On first render, initializes the pass(scene, camera) → bilateralBlur chain.
 * Uses lazy initialization because pass() requires the scene to be set up.
 */
export class SSFRPipeline {
  private pipeline: any = null
  private initialized = false

  constructor(
    _w: number,
    _h: number,
    _camera: THREE.PerspectiveCamera,
    _options?: SSFROptions,
  ) {}

  setParticleGeometry(_geo: THREE.BufferGeometry) {}

  setFluidAppearance(_color: THREE.Color, _absorption: THREE.Vector3) {}

  render(renderer: any, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    if (!this.initialized) {
      this.initialized = true
      try {
        const scenePass = pass(scene, camera)

        // §3.2 Pass 2: Bilateral blur — smooths individual sphere bumps
        // into a continuous fluid surface while preserving edges.
        // sigma=6: spatial blur radius, sigmaColor=0.15: depth edge preservation
        const smoothed = bilateralBlur(scenePass, undefined, 6, 0.15)

        this.pipeline = new (THREE as any).RenderPipeline(renderer, smoothed)
      } catch (e) {
        console.warn('SSFR: Failed to initialize pipeline, falling back to direct render', e)
        this.pipeline = null
      }
    }

    if (this.pipeline) {
      try {
        this.pipeline.render()
      } catch {
        // Fallback to direct render
        renderer.render(scene, camera)
      }
    } else {
      renderer.render(scene, camera)
    }
  }

  dispose() {
    // Pipeline cleanup handled by Three.js
  }
}
