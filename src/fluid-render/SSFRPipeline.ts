// SSFRPipeline.ts — Screen Space Fluid Rendering with physically based optics (raw WebGPU, no three.js TSL).
//
// Passes, per frame:
//   0 background  — the room (shaders/ssfr_scene.wgsl) seen by the camera → sRGB colour + eye depth
//   1 depth       — particles as sphere splats → front-surface eye depth + composition id
//   2 thickness   — volume-normalised splat chords → metres of liquid along each view ray
//   3 blur H, V   — separable bilateral filter on the depth
//   4 composite   — exact Fresnel, Snell refraction and reflection traced through the same room, measured
//                   spectral absorption (dielectrics) or conductor Fresnel (metals), linear light → sRGB
// Physics and sources: shaders/ssfr_composite.wgsl and optics/*.ts. Acceptance gates: scripts/fluid-gates/r0-render.mjs.
//
// Render size (ED-2): the CSS size of the container, scaled down to at most MAX_RENDER_PIXELS (1280×800-equivalent);
// never the device pixel ratio.

import sceneShaderSrc from './shaders/ssfr_scene.wgsl?raw'
import bgShaderSrc from './shaders/ssfr_bg.wgsl?raw'
import depthShaderSrc from './shaders/ssfr_depth.wgsl?raw'
import thicknessShaderSrc from './shaders/ssfr_thickness.wgsl?raw'
import blurShaderSrc from './shaders/ssfr_blur.wgsl?raw'
import compositeShaderSrc from './shaders/ssfr_composite.wgsl?raw'
import slabShaderSrc from './shaders/ssfr_slab.wgsl?raw'
import { BG_BASE, clampBrightness } from './bgBrightness'
import { srgbDecode, type Rgb } from './optics/colorimetry'
import { buildOpticsLut, LUT_LMAX_M, LUT_N } from './optics/materials'

export interface SSFRConfig {
  /** Rest volume of one particle in world units³ (the tank edge is 1 world unit). Set from the solver's packing:
   *  (1/GRID_RES)³ / REST_PPC for MLS-MPM at 4 particles per cell; a solver at 8 ppc halves it. */
  particleVolume: number
  /** Metres per world unit (src/fluid-engine/units.ts DOMAIN_L_M). */
  metresPerUnit: number
  /** Splat radius in units of the rest lattice spacing ∛V_p (default SPLAT_RADIUS_FACTOR). */
  splatRadiusFactor?: number
  blurRadius: number        // bilateral kernel radius, pixels
  blurDepthFalloff: number  // bilateral range falloff, 1/world unit
  /** ED-2 cap on the internal render size, in pixels (area). Default MAX_RENDER_PIXELS. */
  maxRenderPixels?: number
}

/** ED-2: never render the fluid above a 1280×800-equivalent pixel count. */
export const MAX_RENDER_PIXELS = 1280 * 800

/** Splat radius / rest lattice spacing s = ∛V_p: r = s, option A of r6 §6 / FINAL-PLAN D12 (splats sized by the
 *  particle spacing). Chosen by measurement (scripts/fluid-gates/r0-surface.mjs, settled 132k-particle layer, 2026-09-28):
 *  rendered − simulated free-surface height (top / oblique view) and holes in FLUID TEST's thin scene:
 *    r = 2.54 s (the legacy 0.025 wu)  +6.9 / +7.4 cm (r6 predicted 7.3 cm), no holes
 *    r = 1.0 s                         +1.0 / +1.2 cm, holes ≤ 0.76 %      ← smallest measured radius passing both
 *    r = 0.8 s                         +0.2 / +0.3 cm, holes 1.01 %        (misses the ≤ 1 % hole limit)
 *    r = 0.62 s (volume-equivalent)    −0.9 / −0.5 cm, holes up to 4.3 %
 *  (limits: |offset| ≤ 0.25 dx = 1.42 cm, holes ≤ 1 %). The rendered volume and colour do not depend on the radius:
 *  thickness is volume-normalised. A world-space narrow-range filter (render rung 2) could allow smaller splats. */
export const SPLAT_RADIUS_FACTOR = 1.0

// ── The sun ───────────────────────────────────────────────────────────────────────────────────────────────
/** IAU 2015 Resolution B3 nominal solar radius, 6.957 × 10⁸ m (Prša et al. 2016, AJ 152, 41; arXiv:1510.07674). */
const SUN_RADIUS_M = 6.957e8
/** IAU 2012 Resolution B2 astronomical unit, 149 597 870 700 m exactly (quoted in the same paper). */
const AU_M = 149_597_870_700
/** Angular radius of the solar disc at 1 au: asin(R☉/au) = 4.650 mrad (0.2664°). */
export const SUN_ANGULAR_RADIUS_RAD = Math.asin(SUN_RADIUS_M / AU_M)
/** Solid angle of the disc: 2π(1 − cos θ☉) = 6.794 × 10⁻⁵ sr. */
export const SUN_SOLID_ANGLE_SR = 2 * Math.PI * (1 - Math.cos(SUN_ANGULAR_RADIUS_RAD))
/** Disc radiance in the renderer's exposure units (1.0 = white Lambertian surface under the sun at normal incidence,
 *  i.e. E_sun = π): L☉ = π / Ω☉ ≈ 4.62 × 10⁴. A disc this bright saturates any pixel that contains its image,
 *  on water (F·L☉ ≈ 940) as on mercury (≈ 3.6 × 10⁴) — as a camera exposed for the room would. */
export const SUN_RADIANCE = Math.PI / SUN_SOLID_ANGLE_SR
/** World-space direction toward the sun: the key-light direction the background ball has always used, now the
 *  one sun of the whole scene (r6 flaw 9: the composite used a different light, in eye space). */
export const SUN_DIRECTION: readonly [number, number, number] = (() => {
  const v = [0.3, 1.0, 0.6], n = Math.hypot(v[0], v[1], v[2])
  return [v[0] / n, v[1] / n, v[2] / n] as const
})()

/** Authored (sRGB-encoded) colours of the room, decoded to linear light when the scene uniforms are built. */
const GRID_LINE_ENC: Rgb = [0.50, 0.51, 0.24]   // darker olive grid lines (scaled by the brightness slider)
const EDGE_ENC: Rgb = [0.0, 0.6, 1.0]           // tank box edges (not scaled)

// ── Bench probe (scripts/fluid-gates/*.mjs through window.__fluidBench.probe) ──────────────────────────────
export type ProbeTarget = 'color' | 'linear' | 'bg' | 'thickness' | 'depth' | 'compId'
export interface ProbeEnvironment { mode: 'room' | 'uniform'; sky?: Rgb; floor?: Rgb }
export interface ProbeOverrides {
  /** Analytic still layer filling y ∈ [0, surfaceY] (world units) of composition compId, instead of the particles. */
  slab?: { surfaceY: number; compId: number }
  env?: ProbeEnvironment
  sun?: boolean
  marker?: { x: number; z: number; radius: number; color: Rgb }
  particleVolume?: number
  splatRadiusFactor?: number
  /** Replace one composition's optics record: kind 0 dielectric / 1 conductor, IOR, LUT row (−1 none). */
  material?: { compId: number; kind: 0 | 1; ior: number; lutRow: number }
  /** Hide the drop-ball for this probe. */
  noBall?: boolean
  /** Draw no particles (the room alone, or the slab alone). */
  hideParticles?: boolean
}
/** A probe camera (world units; the tank is [0,1]³). Default: the page's own camera at the probe's aspect. */
export interface ProbeCamera {
  kind?: 'perspective' | 'orthographic'
  eye: [number, number, number]
  target: [number, number, number]
  up?: [number, number, number]
  fovDeg?: number       // perspective: vertical field of view
  halfHeight?: number   // orthographic: half the view height, world units
  near?: number
  far?: number
}
/** What a gate sends through window.__fluidBench.probe (JSON). */
export interface ProbeOptions extends ProbeOverrides {
  width?: number        // default: the page's internal render size
  height?: number
  camera?: ProbeCamera
  targets: ProbeTarget[]
  rect?: { x: number; y: number; w: number; h: number }
}
export interface ProbeRequest extends ProbeOverrides {
  width: number
  height: number
  view: Float32Array
  proj: Float32Array
  invProj: Float32Array
  invView: Float32Array
  targets: ProbeTarget[]
  rect?: { x: number; y: number; w: number; h: number }
  ball?: { center: [number, number, number]; radius: number; active: boolean }
}
export interface ProbeResult {
  width: number
  height: number
  rect: { x: number; y: number; w: number; h: number }
  canvasFormat: GPUTextureFormat
  thicknessFormat: GPUTextureFormat
  particleVolume: number
  splatRadius: number
  metresPerUnit: number
  /** color/bg: RGBA8 (logical channel order); linear: 4 × f32; thickness/depth: f32; compId: u32. */
  data: Partial<Record<ProbeTarget, ArrayBuffer>>
}
/** A probe result with the camera matrices it was rendered with (column-major, three.js convention). */
export interface ProbeResultWithCamera extends ProbeResult {
  view: number[]
  proj: number[]
  invView: number[]
  invProj: number[]
}

interface Targets {
  w: number
  h: number
  bg: GPUTexture; bgView: GPUTextureView
  bgDepth: GPUTexture; bgDepthView: GPUTextureView
  depth: GPUTexture; depthView: GPUTextureView
  blurTemp: GPUTexture; blurTempView: GPUTextureView
  thickness: GPUTexture; thicknessView: GPUTextureView
  hwDepth: GPUTexture; hwDepthView: GPUTextureView
  compId: GPUTexture; compIdView: GPUTextureView
}

interface FrameInputs {
  particleBuffer: GPUBuffer | null
  count: number
  view: Float32Array
  proj: Float32Array
  invProj: Float32Array
  invView: Float32Array
  ball?: { center: [number, number, number]; radius: number; active: boolean }
  overrides?: ProbeOverrides
}

/** The render size for a container of w×h CSS pixels under the ED-2 cap. */
export function renderSize(w: number, h: number, maxPixels = MAX_RENDER_PIXELS): [number, number] {
  const s = Math.min(1, Math.sqrt(maxPixels / Math.max(1, w * h)))
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

export class SSFRPipeline {
  private device!: GPUDevice
  private config: Required<SSFRConfig>
  private canvasFormat!: GPUTextureFormat
  private thicknessFormat: GPUTextureFormat = 'r16float'
  private main!: Targets
  // Owner-adjustable background brightness (1 = base olive), applied to the room's backdrop and grid.
  private bgBrightness = 1

  setBgBrightness(b: number) { this.bgBrightness = clampBrightness(b) }

  // Pipelines
  private bgPipeline!: GPURenderPipeline
  private depthPipeline!: GPURenderPipeline
  private thicknessPipeline!: GPURenderPipeline
  private blurPipeline!: GPURenderPipeline
  private compositePipeline!: GPURenderPipeline
  private compositeProbePipeline: GPURenderPipeline | null = null
  private slabPipeline: GPURenderPipeline | null = null

  // Bind group layouts
  private bgBGL!: GPUBindGroupLayout
  private depthBGL!: GPUBindGroupLayout
  private thicknessBGL!: GPUBindGroupLayout
  private blurBGL!: GPUBindGroupLayout
  private compositeBGL!: GPUBindGroupLayout
  private slabBGL: GPUBindGroupLayout | null = null

  // Uniform buffers (one per pass that reads them in the same submit — a buffer written twice before a submit
  // holds only the last write for every pass)
  private cameraUBO!: GPUBuffer
  private bgCamUBO!: GPUBuffer
  private sceneUBO!: GPUBuffer
  private blurHUBO!: GPUBuffer
  private blurVUBO!: GPUBuffer
  private compositeUBO!: GPUBuffer
  private slabUBO: GPUBuffer | null = null

  private quadIndexBuf!: GPUBuffer
  private matBuf!: GPUBuffer          // per-composition optics records (CompositionTable.getRenderData())
  private probeMatBuf!: GPUBuffer     // the same, with a probe's override applied
  private matData = new Float32Array(256 * 8)
  private lutBuf!: GPUBuffer          // optics LUT rows (optics/materials.ts buildOpticsLut)

  constructor(config: SSFRConfig) {
    this.config = {
      splatRadiusFactor: SPLAT_RADIUS_FACTOR,
      maxRenderPixels: MAX_RENDER_PIXELS,
      ...config,
    }
  }

  /** Splat radius in world units for a particle volume: factor × the rest lattice spacing ∛V_p. */
  splatRadius(particleVolume = this.config.particleVolume, factor = this.config.splatRadiusFactor): number {
    return factor * Math.cbrt(particleVolume)
  }

  /** The internal render size in use. */
  get size(): [number, number] { return [this.main.w, this.main.h] }

  /** Set the solver's particle rest volume (world units³) — e.g. when a solver with another packing takes over. */
  setParticleVolume(v: number) { this.config.particleVolume = v }

  async init(device: GPUDevice, cssWidth: number, cssHeight: number): Promise<void> {
    this.device = device
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat()
    // Additive r32float blending needs 'float32-blendable' (WebGPU §25.15); r16float otherwise (its 11-bit
    // significand drops increments below ~1/2000 of the running sum, r6 flaw 18).
    this.thicknessFormat = device.features.has('float32-blendable') ? 'r32float' : 'r16float'
    const [w, h] = renderSize(cssWidth, cssHeight, this.config.maxRenderPixels)
    this.main = this.createTargets(w, h, 0)
    this.createBuffers()
    await this.createPipelines()
  }

  private createTargets(w: number, h: number, extraUsage: number): Targets {
    const tex = (format: GPUTextureFormat, usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING) => {
      const t = this.device.createTexture({ size: [w, h], format, usage: usage | extraUsage })
      return [t, t.createView()] as const
    }
    const [bg, bgView] = tex(this.canvasFormat)
    const [bgDepth, bgDepthView] = tex('r32float')
    const [depth, depthView] = tex('r32float')
    const [blurTemp, blurTempView] = tex('r32float')
    const [thickness, thicknessView] = tex(this.thicknessFormat)
    const [hwDepth, hwDepthView] = tex('depth32float', GPUTextureUsage.RENDER_ATTACHMENT)
    const [compId, compIdView] = tex('r32uint')
    return { w, h, bg, bgView, bgDepth, bgDepthView, depth, depthView, blurTemp, blurTempView, thickness, thicknessView, hwDepth, hwDepthView, compId, compIdView }
  }

  private destroyTargets(t: Targets) {
    for (const x of [t.bg, t.bgDepth, t.depth, t.blurTemp, t.thickness, t.hwDepth, t.compId]) x.destroy()
  }

  private createBuffers() {
    const d = this.device
    const ubo = (size: number) => d.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.cameraUBO = ubo(224)      // 3 mat4 + screenSize + radius + count + chordToMetres + pad
    this.bgCamUBO = ubo(208)       // 3 mat4 + screenSize + pad
    this.sceneUBO = ubo(192)       // 12 vec4 (Scene in ssfr_scene.wgsl)
    this.blurHUBO = ubo(32)
    this.blurVUBO = ubo(32)
    this.compositeUBO = ubo(272)   // 4 mat4 + screenSize + lutN + lutLmax
    this.matBuf = d.createBuffer({ size: 256 * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.probeMatBuf = d.createBuffer({ size: 256 * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const lut = buildOpticsLut()
    this.lutBuf = d.createBuffer({ size: lut.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.lutBuf, 0, lut)

    // Two triangles per particle quad: [0,1,2, 2,1,3] + 4i. Uint32: 1M particles × 4 corners overflows Uint16.
    const MAX_PARTICLES = 1_000_000
    const idx = new Uint32Array(MAX_PARTICLES * 6)
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const b = i * 4, o = i * 6
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b + 2; idx[o + 4] = b + 1; idx[o + 5] = b + 3
    }
    this.quadIndexBuf = d.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.quadIndexBuf, 0, idx)
  }

  private module(label: string, code: string): GPUShaderModule {
    const m = this.device.createShaderModule({ label, code })
    m.getCompilationInfo().then(info => {
      for (const msg of info.messages) console.warn(`[${label} WGSL ${msg.type}] L${msg.lineNum}: ${msg.message}`)
    })
    return m
  }

  private async createPipelines(): Promise<void> {
    const d = this.device
    const U = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type: 'uniform' } })
    const S = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type: 'read-only-storage' } })
    const T = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType } })
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT

    // 0 background
    const bgModule = this.module('ssfr bg', sceneShaderSrc + '\n' + bgShaderSrc)
    this.bgBGL = d.createBindGroupLayout({ entries: [U(0, VF), U(1, GPUShaderStage.FRAGMENT)] })
    this.bgPipeline = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgBGL] }),
      vertex: { module: bgModule, entryPoint: 'vs_main' },
      fragment: { module: bgModule, entryPoint: 'fs_main', targets: [{ format: this.canvasFormat }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    })

    // 1 depth
    const depthModule = this.module('ssfr depth', depthShaderSrc)
    this.depthBGL = d.createBindGroupLayout({ entries: [U(0, VF), S(1, GPUShaderStage.VERTEX)] })
    this.depthPipeline = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.depthBGL] }),
      vertex: { module: depthModule, entryPoint: 'vs_main' },
      fragment: { module: depthModule, entryPoint: 'fs_main', targets: [{ format: 'r32float' }, { format: 'r32uint' }] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      primitive: { topology: 'triangle-list' },
    })

    // 2 thickness (additive; every splat in front of the background counts, so no depth test)
    const thicknessModule = this.module('ssfr thickness', thicknessShaderSrc)
    this.thicknessBGL = d.createBindGroupLayout({ entries: [U(0, VF), S(1, GPUShaderStage.VERTEX), T(2, 'unfilterable-float')] })
    this.thicknessPipeline = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.thicknessBGL] }),
      vertex: { module: thicknessModule, entryPoint: 'vs_main' },
      fragment: {
        module: thicknessModule, entryPoint: 'fs_main',
        targets: [{ format: this.thicknessFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // 3 blur
    const blurModule = this.module('ssfr blur', blurShaderSrc)
    this.blurBGL = d.createBindGroupLayout({ entries: [U(0, VF), T(1, 'unfilterable-float')] })
    this.blurPipeline = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.blurBGL] }),
      vertex: { module: blurModule, entryPoint: 'vs_main' },
      fragment: { module: blurModule, entryPoint: 'fs_main', targets: [{ format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    })

    // 4 composite (alpha = 1, no blending)
    this.compositeBGL = d.createBindGroupLayout({
      entries: [
        U(0, VF), T(1, 'unfilterable-float'), T(2, 'unfilterable-float'), T(3, 'float'), T(4, 'uint'),
        S(5, GPUShaderStage.FRAGMENT), T(6, 'unfilterable-float'), U(7, GPUShaderStage.FRAGMENT), S(8, GPUShaderStage.FRAGMENT),
      ],
    })
    const compositeModule = this.compositeModule()
    this.compositePipeline = await d.createRenderPipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_main', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    })
  }

  private compositeModuleCache: GPUShaderModule | null = null
  private compositeModule(): GPUShaderModule {
    this.compositeModuleCache ??= this.module('ssfr composite', sceneShaderSrc + '\n' + compositeShaderSrc)
    return this.compositeModuleCache
  }

  /** Probe-only pipelines (the composite with a second, linear-light target; the analytic slab), built on first use. */
  private async ensureProbePipelines(): Promise<void> {
    const d = this.device
    if (!this.compositeProbePipeline) {
      const m = this.compositeModule()
      this.compositeProbePipeline = await d.createRenderPipelineAsync({
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
        vertex: { module: m, entryPoint: 'vs_main' },
        fragment: { module: m, entryPoint: 'fs_probe', targets: [{ format: this.canvasFormat }, { format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
    }
    if (!this.slabPipeline) {
      const m = this.module('ssfr slab', slabShaderSrc)
      this.slabBGL = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] })
      this.slabUBO = d.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      this.slabPipeline = await d.createRenderPipelineAsync({
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.slabBGL] }),
        vertex: { module: m, entryPoint: 'vs_main' },
        fragment: { module: m, entryPoint: 'fs_main', targets: [{ format: 'r32float' }, { format: 'r32uint' }, { format: this.thicknessFormat }] },
        primitive: { topology: 'triangle-list' },
      })
    }
  }

  /** Resize for a container of cssWidth×cssHeight (the ED-2 cap applies). */
  resize(cssWidth: number, cssHeight: number) {
    const [w, h] = renderSize(cssWidth, cssHeight, this.config.maxRenderPixels)
    if (w === this.main.w && h === this.main.h) return
    this.destroyTargets(this.main)
    this.main = this.createTargets(w, h, 0)
  }

  /** Upload per-composition optics records (CompositionTable.getRenderData(): 256 × 8 floats). */
  updateMaterialProps(data: Float32Array) {
    this.matData.set(data.subarray(0, this.matData.length))
    this.device.queue.writeBuffer(this.matBuf, 0, data.buffer, data.byteOffset, data.byteLength)
  }

  /** Render one frame into `outputView` (the canvas texture; any size — the passes run at the internal size). */
  render(
    encoder: GPUCommandEncoder,
    particleBuffer: GPUBuffer,
    particleCount: number,
    viewMatrix: Float32Array,
    projMatrix: Float32Array,
    invProjMatrix: Float32Array,
    invViewMatrix: Float32Array,
    outputView: GPUTextureView,
    ball?: { center: [number, number, number]; radius: number; active: boolean },
  ) {
    if (particleCount === 0) return
    this.encodeFrame(encoder, this.main, {
      particleBuffer, count: particleCount, view: viewMatrix, proj: projMatrix, invProj: invProjMatrix, invView: invViewMatrix, ball,
    }, outputView, null, this.matBuf)
  }

  private writeUniforms(t: Targets, f: FrameInputs) {
    const o = f.overrides ?? {}
    const q = this.device.queue
    const volume = o.particleVolume ?? this.config.particleVolume
    const radius = this.splatRadius(volume, o.splatRadiusFactor ?? this.config.splatRadiusFactor)

    const cam = new Float32Array(56)
    cam.set(f.view, 0); cam.set(f.proj, 16); cam.set(f.invProj, 32)
    cam[48] = t.w; cam[49] = t.h
    cam[50] = radius
    new Uint32Array(cam.buffer, 51 * 4, 1)[0] = f.count
    cam[52] = volume / ((4 / 3) * Math.PI * radius ** 3) * this.config.metresPerUnit   // chordToMetres
    q.writeBuffer(this.cameraUBO, 0, cam)

    const bgCam = new Float32Array(52)
    bgCam.set(f.invProj, 0); bgCam.set(f.view, 16); bgCam.set(f.invView, 32)
    bgCam[48] = t.w; bgCam[49] = t.h
    q.writeBuffer(this.bgCamUBO, 0, bgCam)

    q.writeBuffer(this.sceneUBO, 0, this.sceneData(f))

    const blur = (dir: [number, number]) => {
      const b = new Float32Array(8)
      b[0] = t.w; b[1] = t.h; b[2] = this.config.blurRadius; b[3] = 1; b[4] = this.config.blurDepthFalloff
      b[6] = dir[0]; b[7] = dir[1]
      return b
    }
    q.writeBuffer(this.blurHUBO, 0, blur([1, 0]))
    q.writeBuffer(this.blurVUBO, 0, blur([0, 1]))

    const comp = new Float32Array(68)
    comp.set(f.view, 0); comp.set(f.invView, 16); comp.set(f.proj, 32); comp.set(f.invProj, 48)
    comp[64] = t.w; comp[65] = t.h; comp[66] = LUT_N; comp[67] = LUT_LMAX_M
    q.writeBuffer(this.compositeUBO, 0, comp)
  }

  /** The Scene uniform (ssfr_scene.wgsl): one sun, the room's decoded colours, the ball, probe test settings. */
  private sceneData(f: FrameInputs): Float32Array<ArrayBuffer> {
    const o = f.overrides ?? {}
    const s = new Float32Array(48)
    const bb = this.bgBrightness
    const dec = (c: Rgb, k = 1): Rgb => [srgbDecode(c[0] * k), srgbDecode(c[1] * k), srgbDecode(c[2] * k)]
    const sunOn = o.sun ?? true
    s.set([...SUN_DIRECTION, SUN_ANGULAR_RADIUS_RAD], 0)
    s.set([SUN_RADIANCE, SUN_RADIANCE, SUN_RADIANCE, sunOn ? 1 : 0], 4)
    s.set(dec([BG_BASE.r, BG_BASE.g, BG_BASE.b], bb), 8)
    s.set(dec(GRID_LINE_ENC, bb), 12)
    s.set(dec(EDGE_ENC), 16)
    const ball = o.noBall ? undefined : f.ball
    if (ball?.active) { s.set([...ball.center, ball.radius], 20); s[24] = 1 }
    if (o.env?.mode === 'uniform') {
      s[28] = 1
      s.set(o.env.sky ?? [0, 0, 0], 32)
      s.set(o.env.floor ?? [0, 0, 0], 36)
    }
    if (o.marker) { s.set([o.marker.x, o.marker.z, o.marker.radius, 1], 40); s.set(o.marker.color, 44) }
    return s
  }

  private encodeFrame(encoder: GPUCommandEncoder, t: Targets, f: FrameInputs, outputView: GPUTextureView, linearView: GPUTextureView | null, matBuf: GPUBuffer) {
    const d = this.device
    this.writeUniforms(t, f)
    const slab = f.overrides?.slab

    // 0 background
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: t.bgView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
          { view: t.bgDepthView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1e6, g: 0, b: 0, a: 0 } },
        ],
      })
      pass.setPipeline(this.bgPipeline)
      pass.setBindGroup(0, d.createBindGroup({ layout: this.bgBGL, entries: [{ binding: 0, resource: { buffer: this.bgCamUBO } }, { binding: 1, resource: { buffer: this.sceneUBO } }] }))
      pass.draw(3)
      pass.end()
    }

    // 1 + 2: the liquid's depth, composition id and thickness — from the particles, or the probe's analytic slab
    if (slab && this.slabPipeline && this.slabBGL && this.slabUBO) {
      const u = new Float32Array(52)
      u.set(f.invProj, 0); u.set(f.invView, 16); u.set(f.view, 32)
      u[48] = slab.surfaceY; u[49] = this.config.metresPerUnit
      new Uint32Array(u.buffer, 50 * 4, 1)[0] = slab.compId
      d.queue.writeBuffer(this.slabUBO, 0, u)
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: t.depthView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          { view: t.compIdView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          { view: t.thicknessView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      })
      pass.setPipeline(this.slabPipeline)
      pass.setBindGroup(0, d.createBindGroup({ layout: this.slabBGL, entries: [{ binding: 0, resource: { buffer: this.slabUBO } }] }))
      pass.draw(3)
      pass.end()
    } else {
      const draw = f.count > 0 && f.particleBuffer !== null && !f.overrides?.hideParticles
      const depthPass = encoder.beginRenderPass({
        colorAttachments: [
          { view: t.depthView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          // compId 0 where no splat lands is harmless: the composite gates on the depth (0 = no liquid).
          { view: t.compIdView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
        depthStencilAttachment: { view: t.hwDepthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1.0 },
      })
      if (draw) {
        depthPass.setPipeline(this.depthPipeline)
        depthPass.setBindGroup(0, d.createBindGroup({ layout: this.depthBGL, entries: [{ binding: 0, resource: { buffer: this.cameraUBO } }, { binding: 1, resource: { buffer: f.particleBuffer! } }] }))
        depthPass.setIndexBuffer(this.quadIndexBuf, 'uint32')
        depthPass.drawIndexed(f.count * 6)
      }
      depthPass.end()

      const thickPass = encoder.beginRenderPass({
        colorAttachments: [{ view: t.thicknessView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      })
      if (draw) {
        thickPass.setPipeline(this.thicknessPipeline)
        thickPass.setBindGroup(0, d.createBindGroup({
          layout: this.thicknessBGL,
          entries: [{ binding: 0, resource: { buffer: this.cameraUBO } }, { binding: 1, resource: { buffer: f.particleBuffer! } }, { binding: 2, resource: t.bgDepthView }],
        }))
        thickPass.setIndexBuffer(this.quadIndexBuf, 'uint32')
        thickPass.drawIndexed(f.count * 6)
      }
      thickPass.end()
    }

    // 3 blur: horizontal depth → temp, vertical temp → depth
    for (const [src, dst, ubo] of [[t.depthView, t.blurTempView, this.blurHUBO], [t.blurTempView, t.depthView, this.blurVUBO]] as const) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
      pass.setPipeline(this.blurPipeline)
      pass.setBindGroup(0, d.createBindGroup({ layout: this.blurBGL, entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: src }] }))
      pass.draw(3)
      pass.end()
    }

    // 4 composite
    {
      const colorAttachments: GPURenderPassColorAttachment[] = [{ view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
      if (linearView) colorAttachments.push({ view: linearView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } })
      const pass = encoder.beginRenderPass({ colorAttachments })
      pass.setPipeline(linearView ? this.compositeProbePipeline! : this.compositePipeline)
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.compositeBGL,
        entries: [
          { binding: 0, resource: { buffer: this.compositeUBO } },
          { binding: 1, resource: t.depthView },
          { binding: 2, resource: t.thicknessView },
          { binding: 3, resource: t.bgView },
          { binding: 4, resource: t.compIdView },
          { binding: 5, resource: { buffer: matBuf } },
          { binding: 6, resource: t.bgDepthView },
          { binding: 7, resource: { buffer: this.sceneUBO } },
          { binding: 8, resource: { buffer: this.lutBuf } },
        ],
      }))
      pass.draw(3)
      pass.end()
    }
  }

  /** Bench probe: render one frame offscreen at width×height with the given camera and overrides, and read back
   *  the requested targets. Never touches the canvas; the page keeps rendering normally. */
  async probe(particleBuffer: GPUBuffer | null, count: number, req: ProbeRequest): Promise<ProbeResult> {
    await this.ensureProbePipelines()
    const d = this.device
    const t = this.createTargets(req.width, req.height, GPUTextureUsage.COPY_SRC)
    const color = d.createTexture({ size: [req.width, req.height], format: this.canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const linear = d.createTexture({ size: [req.width, req.height], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    let matBuf = this.matBuf
    if (req.material) {
      const m = new Float32Array(this.matData)
      m.set([req.material.kind, req.material.ior, req.material.lutRow, 0, 0, 0, 0, 0], req.material.compId * 8)
      d.queue.writeBuffer(this.probeMatBuf, 0, m)
      matBuf = this.probeMatBuf
    }
    const rect = req.rect ?? { x: 0, y: 0, w: req.width, h: req.height }
    const sources: Record<ProbeTarget, { tex: GPUTexture; bpp: number }> = {
      color: { tex: color, bpp: 4 }, linear: { tex: linear, bpp: 16 }, bg: { tex: t.bg, bpp: 4 },
      thickness: { tex: t.thickness, bpp: this.thicknessFormat === 'r32float' ? 4 : 2 },
      depth: { tex: t.depth, bpp: 4 }, compId: { tex: t.compId, bpp: 4 },
    }
    const encoder = d.createCommandEncoder()
    this.encodeFrame(encoder, t, {
      particleBuffer, count, view: req.view, proj: req.proj, invProj: req.invProj, invView: req.invView, ball: req.ball, overrides: req,
    }, color.createView(), linear.createView(), matBuf)
    const reads: { name: ProbeTarget; buf: GPUBuffer; bpr: number; bpp: number }[] = []
    for (const name of req.targets) {
      const s = sources[name]
      const bpr = Math.ceil(rect.w * s.bpp / 256) * 256
      const buf = d.createBuffer({ size: bpr * rect.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      encoder.copyTextureToBuffer({ texture: s.tex, origin: { x: rect.x, y: rect.y } }, { buffer: buf, bytesPerRow: bpr }, { width: rect.w, height: rect.h })
      reads.push({ name, buf, bpr, bpp: s.bpp })
    }
    d.queue.submit([encoder.finish()])
    const data: Partial<Record<ProbeTarget, ArrayBuffer>> = {}
    const bgra = this.canvasFormat.startsWith('bgra')
    for (const r of reads) {
      await r.buf.mapAsync(GPUMapMode.READ)
      const raw = new Uint8Array(r.buf.getMappedRange())
      const packed = new Uint8Array(rect.w * rect.h * r.bpp)
      for (let y = 0; y < rect.h; y++) packed.set(raw.subarray(y * r.bpr, y * r.bpr + rect.w * r.bpp), y * rect.w * r.bpp)
      r.buf.unmap(); r.buf.destroy()
      if ((r.name === 'color' || r.name === 'bg') && bgra) {
        for (let i = 0; i < packed.length; i += 4) { const b = packed[i]; packed[i] = packed[i + 2]; packed[i + 2] = b }
      }
      data[r.name] = r.name === 'thickness' && r.bpp === 2 ? halfToFloat(new Uint16Array(packed.buffer)).buffer : packed.buffer
    }
    this.destroyTargets(t); color.destroy(); linear.destroy()
    const volume = req.particleVolume ?? this.config.particleVolume
    return {
      width: req.width, height: req.height, rect, canvasFormat: this.canvasFormat, thicknessFormat: this.thicknessFormat,
      particleVolume: volume, splatRadius: this.splatRadius(volume, req.splatRadiusFactor ?? this.config.splatRadiusFactor),
      metresPerUnit: this.config.metresPerUnit, data,
    }
  }

  destroy() {
    if (this.main) this.destroyTargets(this.main)
    for (const b of [this.cameraUBO, this.bgCamUBO, this.sceneUBO, this.blurHUBO, this.blurVUBO, this.compositeUBO, this.slabUBO, this.quadIndexBuf, this.matBuf, this.probeMatBuf, this.lutBuf]) b?.destroy()
  }
}

/** IEEE 754 binary16 → f32 (r16float thickness readback). */
function halfToFloat(h: Uint16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(h.length)
  for (let i = 0; i < h.length; i++) {
    const v = h[i], s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 0x1f, m = v & 0x3ff
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15)
  }
  return out
}
