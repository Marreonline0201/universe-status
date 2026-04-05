// ══════════════════════════════════════════════════════════════════════════════
// Screen-Space Fluid Rendering (SSFR)
// Implements structure.md §3.2 Tier 2 — 5-pass GPU pipeline
//
// Pass 1: Depth sprites — sphere-shaped depth per particle
// Pass 2: Bilateral blur — smooth depth preserving edges (H+V)
// Pass 3: Thickness — additive blending, no depth test
// Pass 4: Normal reconstruction — finite differences on smoothed depth
// Pass 5: Compositing — Fresnel, Beer's law, specular
//
// Uses WebGLRenderTarget which works with both WebGL and WebGPU renderers.
// Shaders in GLSL — WebGPU renderer's WebGL fallback handles them.
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'

// ── Pass 1: Depth Sprite Shader ────────────────────────────────────────────

const DEPTH_VERT = /* glsl */ `
uniform float uPointRadius;
uniform float uScreenHeight;

varying float vViewZ;
varying float vRadius;

void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewZ = mvPos.z; // negative in view space (camera looks down -Z)
  vRadius = uPointRadius;

  gl_Position = projectionMatrix * mvPos;

  // Project sphere radius to screen pixels
  gl_PointSize = uPointRadius * uScreenHeight / max(-mvPos.z, 0.01);
  gl_PointSize = clamp(gl_PointSize, 1.0, 512.0);
}
`

const DEPTH_FRAG = /* glsl */ `
uniform mat4 projectionMatrix;
uniform float uPointRadius;

varying float vViewZ;
varying float vRadius;

void main() {
  // Map point coord from [0,1] to [-1,1]
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  if (r2 > 1.0) discard;

  // Sphere depth offset: R * sqrt(1 - x² - y²)
  float sphereZ = vRadius * sqrt(1.0 - r2);
  // View-space Z of this fragment on the sphere surface
  float fragViewZ = vViewZ + sphereZ;

  // Convert to linear [0,1] depth for storage
  // Using view-space Z directly (negative values)
  gl_FragColor = vec4(-fragViewZ, 0.0, 0.0, 1.0);
}
`

// ── Pass 2: Bilateral Blur Shader ──────────────────────────────────────────

const BLUR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uDirection; // (1/w, 0) or (0, 1/h) * blur scale
uniform float uSigmaS;  // spatial sigma in pixels
uniform float uSigmaR;  // range sigma in depth units

varying vec2 vUv;

void main() {
  float centerDepth = texture2D(tDepth, vUv).r;
  if (centerDepth <= 0.001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float weightSum = 0.0;
  float depthSum = 0.0;

  for (int i = -15; i <= 15; i++) {
    vec2 offset = uDirection * float(i);
    vec2 sampleUV = vUv + offset;

    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;

    float sampleDepth = texture2D(tDepth, sampleUV).r;
    if (sampleDepth <= 0.001) continue;

    // Spatial Gaussian
    float distSq = float(i * i);
    float ws = exp(-0.5 * distSq / (uSigmaS * uSigmaS));

    // Range Gaussian — preserve depth edges
    float dd = sampleDepth - centerDepth;
    float wr = exp(-0.5 * dd * dd / (uSigmaR * uSigmaR));

    float w = ws * wr;
    depthSum += sampleDepth * w;
    weightSum += w;
  }

  gl_FragColor = vec4(depthSum / max(weightSum, 0.0001), 0.0, 0.0, 1.0);
}
`

// ── Pass 3: Thickness Shader ───────────────────────────────────────────────

const THICKNESS_FRAG = /* glsl */ `
uniform float uPointRadius;

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  if (r2 > 1.0) discard;

  // §3.2: t(x,y) = 2R * sqrt(1 - x² - y²)
  float thickness = 2.0 * uPointRadius * sqrt(1.0 - r2);
  gl_FragColor = vec4(thickness, 0.0, 0.0, 1.0);
}
`

// ── Pass 5: Composite Shader ───────────────────────────────────────────────

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tSmoothedDepth;
uniform sampler2D tThickness;
uniform sampler2D tScene;
uniform vec2 uTexelSize;
uniform vec3 uFluidColor;
uniform vec3 uAbsorption; // Beer's law coefficients per RGB
uniform vec3 uLightDir;

varying vec2 vUv;

void main() {
  float depth = texture2D(tSmoothedDepth, vUv).r;

  // No fluid at this pixel — pass through scene
  if (depth <= 0.001) {
    gl_FragColor = texture2D(tScene, vUv);
    return;
  }

  // §3.2 Pass 4: Normal reconstruction from smoothed depth
  float dL = texture2D(tSmoothedDepth, vUv - vec2(uTexelSize.x, 0.0)).r;
  float dR = texture2D(tSmoothedDepth, vUv + vec2(uTexelSize.x, 0.0)).r;
  float dD = texture2D(tSmoothedDepth, vUv - vec2(0.0, uTexelSize.y)).r;
  float dU = texture2D(tSmoothedDepth, vUv + vec2(0.0, uTexelSize.y)).r;

  vec3 normal = normalize(vec3(
    (dR - dL) * 0.5,
    (dU - dD) * 0.5,
    -1.0  // looking down -Z
  ));

  // §3.2 Pass 5: Compositing
  float thickness = texture2D(tThickness, vUv).r;
  vec4 sceneColor = texture2D(tScene, vUv);

  // Fresnel: F = F0 + (1-F0)(1 - N·V)^5
  float NdotV = max(normal.z, 0.0); // view direction is (0,0,-1), so N·V = normal.z
  float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

  // Beer's law absorption: color = exp(-absorption * thickness)
  vec3 absorption = exp(-uAbsorption * thickness * 30.0);
  vec3 refracted = sceneColor.rgb * absorption;

  // Specular highlight
  vec3 lightDir = normalize(uLightDir);
  vec3 viewDir = vec3(0.0, 0.0, -1.0);
  vec3 halfDir = normalize(lightDir - viewDir);
  float spec = pow(max(dot(normal, halfDir), 0.0), 128.0);

  // Final composite: mix refracted scene with fluid color based on Fresnel
  vec3 finalColor = mix(refracted, uFluidColor, fresnel * 0.5) + vec3(spec * 0.8);

  gl_FragColor = vec4(finalColor, 1.0);
}
`

// ── SSFR Pipeline ──────────────────────────────────────────────────────────

export interface SSFROptions {
  particleRadius: number
  fluidColor: THREE.Color
  absorption: THREE.Vector3
}

export class SSFRPipeline {
  // Render targets
  private depthRT: THREE.WebGLRenderTarget
  private blurRT1: THREE.WebGLRenderTarget
  private blurRT2: THREE.WebGLRenderTarget
  private thicknessRT: THREE.WebGLRenderTarget
  private sceneRT: THREE.WebGLRenderTarget

  // Materials
  private depthMat: THREE.ShaderMaterial
  private thickMat: THREE.ShaderMaterial
  private blurHMat: THREE.ShaderMaterial
  private blurVMat: THREE.ShaderMaterial
  private compositeMat: THREE.ShaderMaterial

  // Fullscreen quad scene for post-processing
  private fsScene: THREE.Scene
  private fsCamera: THREE.OrthographicCamera
  private fsQuad: THREE.Mesh

  // Particle geometry for depth/thickness passes
  private particleGeo: THREE.BufferGeometry | null = null

  width: number = 0
  height: number = 0

  constructor(
    w: number,
    h: number,
    _camera: THREE.PerspectiveCamera,
    options: SSFROptions = {
      particleRadius: 0.012,
      fluidColor: new THREE.Color(0x2299dd),
      absorption: new THREE.Vector3(0.5, 0.1, 0.02),
    },
  ) {
    this.width = w
    this.height = h
    const width = w, height = h
    // Render targets with float precision for depth storage
    const floatOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
    }
    this.depthRT = new THREE.WebGLRenderTarget(width, height, floatOpts)
    this.blurRT1 = new THREE.WebGLRenderTarget(width, height, floatOpts)
    this.blurRT2 = new THREE.WebGLRenderTarget(width, height, floatOpts)
    this.thicknessRT = new THREE.WebGLRenderTarget(width, height, floatOpts)
    this.sceneRT = new THREE.WebGLRenderTarget(width, height)

    // Pass 1: Depth sprites
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: {
        uPointRadius: { value: options.particleRadius },
        uScreenHeight: { value: height },
      },
      depthTest: true,
      depthWrite: true,
    })

    // Pass 3: Thickness
    this.thickMat = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: THICKNESS_FRAG,
      uniforms: {
        uPointRadius: { value: options.particleRadius },
        uScreenHeight: { value: height },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })

    // Pass 2: Bilateral blur (H then V)
    this.blurHMat = new THREE.ShaderMaterial({
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDepth: { value: null },
        uDirection: { value: new THREE.Vector2(1.0 / width, 0) },
        uSigmaS: { value: 7.0 },
        uSigmaR: { value: 0.1 },
      },
      depthTest: false,
      depthWrite: false,
    })

    this.blurVMat = new THREE.ShaderMaterial({
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDepth: { value: null },
        uDirection: { value: new THREE.Vector2(0, 1.0 / height) },
        uSigmaS: { value: 7.0 },
        uSigmaR: { value: 0.1 },
      },
      depthTest: false,
      depthWrite: false,
    })

    // Pass 5: Composite
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: BLUR_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tSmoothedDepth: { value: null },
        tThickness: { value: null },
        tScene: { value: null },
        uTexelSize: { value: new THREE.Vector2(1.0 / width, 1.0 / height) },
        uFluidColor: { value: options.fluidColor },
        uAbsorption: { value: options.absorption },
        uLightDir: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
      },
      depthTest: false,
      depthWrite: false,
    })

    // Fullscreen quad for post-processing
    this.fsScene = new THREE.Scene()
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const fsGeo = new THREE.PlaneGeometry(2, 2)
    this.fsQuad = new THREE.Mesh(fsGeo, this.compositeMat)
    this.fsScene.add(this.fsQuad)
  }

  /**
   * Set the particle positions buffer geometry for depth/thickness passes.
   * This should be a BufferGeometry with a 'position' attribute.
   */
  setParticleGeometry(geo: THREE.BufferGeometry) {
    this.particleGeo = geo
  }

  /**
   * Update fluid color and absorption for different materials
   */
  setFluidAppearance(color: THREE.Color, absorption: THREE.Vector3) {
    this.compositeMat.uniforms.uFluidColor.value.copy(color)
    this.compositeMat.uniforms.uAbsorption.value.copy(absorption)
  }

  /**
   * Render the full SSFR pipeline
   */
  render(renderer: any, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    if (!this.particleGeo || this.particleGeo.drawRange.count === 0) {
      // No particles — just render scene normally
      renderer.render(scene, camera)
      return
    }

    void renderer // used below

    // Step 0: Render scene WITHOUT fluid particles to sceneRT
    // (This captures the background, box, etc.)
    renderer.setRenderTarget(this.sceneRT)
    renderer.clear()
    renderer.render(scene, camera)

    // Step 1: Render particle depth sprites to depthRT
    const depthPoints = new THREE.Points(this.particleGeo, this.depthMat)
    const depthScene = new THREE.Scene()
    depthScene.add(depthPoints)
    renderer.setRenderTarget(this.depthRT)
    renderer.clear()
    renderer.render(depthScene, camera)

    // Step 2a: Horizontal bilateral blur (depthRT → blurRT1)
    this.blurHMat.uniforms.tDepth.value = this.depthRT.texture
    this.fsQuad.material = this.blurHMat
    renderer.setRenderTarget(this.blurRT1)
    renderer.clear()
    renderer.render(this.fsScene, this.fsCamera)

    // Step 2b: Vertical bilateral blur (blurRT1 → blurRT2)
    this.blurVMat.uniforms.tDepth.value = this.blurRT1.texture
    this.fsQuad.material = this.blurVMat
    renderer.setRenderTarget(this.blurRT2)
    renderer.clear()
    renderer.render(this.fsScene, this.fsCamera)

    // Step 3: Render thickness to thicknessRT
    const thickPoints = new THREE.Points(this.particleGeo, this.thickMat)
    const thickScene = new THREE.Scene()
    thickScene.add(thickPoints)
    renderer.setRenderTarget(this.thicknessRT)
    renderer.clear()
    renderer.render(thickScene, camera)

    // Step 4+5: Normal reconstruction + compositing (to screen)
    this.compositeMat.uniforms.tSmoothedDepth.value = this.blurRT2.texture
    this.compositeMat.uniforms.tThickness.value = this.thicknessRT.texture
    this.compositeMat.uniforms.tScene.value = this.sceneRT.texture
    this.fsQuad.material = this.compositeMat
    renderer.setRenderTarget(null)
    renderer.clear()
    renderer.render(this.fsScene, this.fsCamera)

    // Cleanup temporary objects
    depthPoints.geometry = new THREE.BufferGeometry() // don't dispose shared geo
    thickPoints.geometry = new THREE.BufferGeometry()
  }

  dispose() {
    this.depthRT.dispose()
    this.blurRT1.dispose()
    this.blurRT2.dispose()
    this.thicknessRT.dispose()
    this.sceneRT.dispose()
    this.depthMat.dispose()
    this.thickMat.dispose()
    this.blurHMat.dispose()
    this.blurVMat.dispose()
    this.compositeMat.dispose()
  }
}
