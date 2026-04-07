# SSFR Three.js Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the SSFR fluid rendering pipeline into Three.js's scene graph so particles, ball, and box share one depth buffer — fixing the two-canvas depth ordering bug.

**Architecture:** Raw WebGPU compute (MLS-MPM) stays untouched. Fluid particles render as an InstancedMesh in the Three.js scene. SSFR post-processing (blur, thickness, composite) runs via Three.js RenderPipeline. The overlay canvas and standalone FluidRenderer are deleted.

**Tech Stack:** Three.js r183 (WebGPU renderer, TSL nodes, wgslFn, RenderPipeline, StorageInstancedBufferAttribute), existing WGSL compute shaders, Vite + React

---

## File Structure

**New files:**
- `src/fluid-render/FluidScene.ts` — Integration module: creates particle InstancedMesh with sphere-depth NodeMaterial, manages SSFR RenderPipeline, provides `init()` / `render()` / `dispose()` API

**Unchanged files (zero modifications):**
- `src/gpu-sim/MpmGpuSimulator.ts`
- `src/gpu-sim/shaders/*.wgsl` (all 6 compute shaders)
- `src/composition/CompositionTable.ts`
- `src/composition/ContactProcessor.ts`
- `src/composition/PropertyCalculator.ts`
- `src/ai/MaterialGenerator.ts`
- `src/ai/AutoExperimenter.ts`

**Modified files:**
- `src/components/FluidTest.tsx` — Rewrite init + render loop to use FluidScene instead of FluidRenderer

**Deleted files (after migration is verified working):**
- `src/fluid-render/FluidRenderer.ts`
- `src/fluid-render/depthMap.wgsl`
- `src/fluid-render/bilateral.wgsl`
- `src/fluid-render/thicknessMap.wgsl`
- `src/fluid-render/gaussian.wgsl`
- `src/fluid-render/composite.wgsl`
- `src/fluid-render/fullScreen.wgsl`
- `src/fluid-render/debugDepth.wgsl`
- `src/components/FluidSSFR.ts`

---

## Task 1: Get the shared GPUDevice from Three.js renderer

**Files:**
- Modify: `src/components/FluidTest.tsx`

The current code creates the FluidRenderer first (which creates its own GPUDevice), then shares that device with MpmGpuSimulator. We need to reverse this: Three.js creates the renderer + device, then we extract the device for the simulator.

- [ ] **Step 1: Modify FluidTest.tsx setup to create Three.js renderer first and extract the device**

In the `setup()` function inside the `useEffect` (around line 316), reorder initialization. Currently:

```ts
// CURRENT (lines 324-339):
const fluidRenderer = new FluidRenderer()
const frOk = await fluidRenderer.init(container, container.clientWidth, container.clientHeight)
// ...
const device = fluidRenderer.gpuDevice
const gpuSim = new MpmGpuSimulator()
const simOk = await gpuSim.init(device)
```

Change to:

```ts
// NEW: Three.js renderer creates the device, we extract it
const renderer = new (THREE as any).WebGPURenderer({ antialias: true })
await renderer.init()
renderer.setSize(container.clientWidth, container.clientHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.2
container.appendChild(renderer.domElement)

// Extract the raw GPUDevice from Three.js's WebGPU backend
const device: GPUDevice = renderer.backend.device
if (!device) {
  console.error('Failed to get GPUDevice from Three.js WebGPU renderer')
  return
}

// Init MLS-MPM simulator with the shared device
const gpuSim = new MpmGpuSimulator()
const simOk = await gpuSim.init(device)
if (!simOk || cancelled) {
  console.error('MpmGpuSimulator init failed')
  return
}
```

Remove the duplicate renderer creation that currently exists later in setup (around line 404).

- [ ] **Step 2: Remove FluidRenderer from imports and initialization**

Remove from FluidTest.tsx:
```ts
// DELETE this import:
import { FluidRenderer } from '../fluid-render/FluidRenderer'
```

Remove all FluidRenderer references from the simRef type and initialization. Remove `captureScene()`, `fluidRenderer.updateCamera()`, `fluidRenderer.render()`, `fluidRenderer.setParticleBuffer()`, `fluidRenderer.updateCompositionRenderProps()`, and `fluidRenderer.setFluidMaterial()` calls from the animation loop (around lines 639-660).

- [ ] **Step 3: Verify the app still loads — Three.js scene renders (ball, box, grid) but no fluid particles visible**

Run: `cd universe-status && npm run dev`

Open in browser. Confirm:
- Three.js scene shows: glass box, wireframe edges, grid floor, grid walls
- No fluid visible (expected — we removed the renderer but haven't added the new one yet)
- No console errors about WebGPU device
- MLS-MPM compute still runs (check console for "Spawned 10000 initial particles")

- [ ] **Step 4: Commit**

```bash
git add src/components/FluidTest.tsx
git commit -m "refactor: extract GPUDevice from Three.js renderer, remove FluidRenderer dependency"
```

---

## Task 2: Create the depth sprite InstancedMesh

**Files:**
- Create: `src/fluid-render/FluidScene.ts`

This is the core of the migration. We create an InstancedMesh whose instance positions come directly from the MpmGpuSimulator's GPU particle buffer — zero CPU readback.

- [ ] **Step 1: Create FluidScene.ts with the InstancedMesh setup**

```ts
// src/fluid-render/FluidScene.ts
// Renders MLS-MPM particles as instanced depth sprites in the Three.js scene.
// Shares the scene's depth buffer — objects behind/in front of fluid are correctly ordered.

import * as THREE from 'three'

const MAX_PARTICLES = 40_000

export class FluidScene {
  private instancedMesh: THREE.InstancedMesh | null = null
  private scene: THREE.Scene
  private dummy = new THREE.Object3D()

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  /**
   * Create the instanced mesh for particle rendering.
   * particleBuffer is the raw GPUBuffer from MpmGpuSimulator.
   */
  init(particleCount: number) {
    // Quad geometry: 2 triangles, camera-facing billboard
    const geo = new THREE.PlaneGeometry(0.12, 0.12) // sphere sprite size matching SPHERE_SIZE=0.12

    // Simple material for now — we'll add the full SSFR pipeline in later tasks
    // Using a basic translucent sphere material to verify particles appear in the scene
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2288dd,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: true,
    })

    this.instancedMesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES)
    this.instancedMesh.frustumCulled = false // particles fill the whole box
    this.instancedMesh.count = 0 // start with no visible instances
    this.scene.add(this.instancedMesh)
  }

  /**
   * Read particle positions from GPU back to CPU and update instance matrices.
   * This is a TEMPORARY approach — Task 5 will replace with GPU-direct instancing.
   */
  updateFromCPU(positions: Float32Array, count: number) {
    if (!this.instancedMesh) return
    this.instancedMesh.count = count

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      this.dummy.position.set(positions[i3], positions[i3 + 1], positions[i3 + 2])
      this.dummy.updateMatrix()
      this.instancedMesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true
  }

  /**
   * Update from the raw particle buffer layout (80 bytes per particle).
   * Reads pos_x, pos_y, pos_z from the first 3 floats of each 20-float stride.
   */
  updateFromBuffer(buffer: Float32Array, count: number) {
    if (!this.instancedMesh) return
    this.instancedMesh.count = count

    const FLOATS_PER_PARTICLE = 20 // 80 bytes / 4
    for (let i = 0; i < count; i++) {
      const offset = i * FLOATS_PER_PARTICLE
      this.dummy.position.set(buffer[offset], buffer[offset + 1], buffer[offset + 2])
      this.dummy.updateMatrix()
      this.instancedMesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh)
      this.instancedMesh.geometry.dispose()
      ;(this.instancedMesh.material as THREE.Material).dispose()
      this.instancedMesh = null
    }
  }
}
```

- [ ] **Step 2: Integrate FluidScene into FluidTest.tsx**

Add import and initialization after the scene setup:

```ts
import { FluidScene } from '../fluid-render/FluidScene'
```

After scene creation (after the sphere mesh is added, around line 514), add:

```ts
const fluidScene = new FluidScene(scene)
fluidScene.init(gpuSim.particleCount)
```

Add `fluidScene` to the simRef type and the ref assignment.

- [ ] **Step 3: Add GPU readback to update particle positions each frame**

The MpmGpuSimulator's particle buffer is GPU-only. For this temporary step, we need to read positions back. Add a readback buffer and copy in the animation loop.

In FluidTest.tsx, after MpmGpuSimulator init, create a readback buffer:

```ts
const readbackBuffer = device.createBuffer({
  size: MAX_PARTICLES * 80,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
})
```

In the animation loop, after `gpuSim.step(encoder)`, add a copy command and async readback:

```ts
// Copy particle data for CPU readback (temporary — Task 5 replaces with GPU-direct)
encoder.copyBufferToBuffer(gpuSim.particleBuffer, 0, readbackBuffer, 0, count * 80)
device.queue.submit([encoder.finish()])

// Async readback — updates positions one frame behind (acceptable for now)
if (readbackBuffer.mapState === 'unmapped') {
  readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
    const data = new Float32Array(readbackBuffer.getMappedRange())
    sim.fluidScene.updateFromBuffer(data, count)
    readbackBuffer.unmap()
  }).catch(() => {})
}
```

- [ ] **Step 4: Verify particles appear in the Three.js scene with correct depth ordering**

Run: `cd universe-status && npm run dev`

Open in browser. Confirm:
- Blue translucent quads appear inside the glass box
- Particles fall under gravity and pool at the bottom
- The metal ball (when dropped) appears IN FRONT of particles that are behind it
- The metal ball appears BEHIND particles that are in front of it
- Glass box edges render correctly in relation to particles
- No overlay canvas visible in DOM (only one canvas)

- [ ] **Step 5: Commit**

```bash
git add src/fluid-render/FluidScene.ts src/components/FluidTest.tsx
git commit -m "feat: render fluid particles as InstancedMesh in Three.js scene — depth ordering works"
```

---

## Task 3: SSFR depth sprite material with sphere-projected depth

**Files:**
- Modify: `src/fluid-render/FluidScene.ts`

Replace the basic material with a custom NodeMaterial that renders sphere-projected depth per fragment — matching the existing `depthMap.wgsl` behavior but integrated into Three.js.

- [ ] **Step 1: Replace MeshBasicMaterial with a custom NodeMaterial for depth sprites**

Update FluidScene.ts to use a NodeMaterial with a custom vertex and fragment shader that creates camera-facing billboards and writes sphere depth:

```ts
import * as THREE from 'three'
// @ts-ignore — TSL types
import { Fn, vec2, vec3, vec4, float, attribute, uniform, cameraProjectionMatrix, cameraViewMatrix, positionLocal, instanceIndex, sqrt, dot, sub, mul, normalize, discard as tslDiscard } from 'three/tsl'

// In init(), replace the material with:
const mat = new THREE.NodeMaterial()
mat.transparent = true
mat.depthWrite = true
mat.side = THREE.DoubleSide

// Vertex: billboard quad facing camera, offset by particle position
// Fragment: sphere depth carving — discard outside unit circle, write sphere z-depth
const sphereSize = uniform(0.12)

// Custom fragment node
mat.fragmentNode = Fn(() => {
  // UV comes from the quad geometry [0,1] -> remap to [-1,1]
  const uv = positionLocal.xy // quad local position
  const normalxy = uv.mul(2.0).sub(1.0)
  const r2 = dot(normalxy, normalxy)

  // Discard outside the sphere
  r2.greaterThan(1.0).discard()

  // Sphere depth — blue tinted, alpha from sphere shape
  const normalz = sqrt(sub(1.0, r2))
  return vec4(0.13, 0.4, 0.87, normalz.mul(0.6))
})()
```

Note: This is a simplified version. The full SSFR pipeline (separate depth RT, bilateral blur, composite) comes in Tasks 4-6. This step just gets sphere-shaped translucent sprites rendering in the scene with correct depth.

- [ ] **Step 2: Verify sphere-shaped particles in the scene**

Run: `cd universe-status && npm run dev`

Confirm:
- Particles are round (not square) — fragments outside the sphere radius are discarded
- Particles have sphere-like depth (closer in center, fading at edges)
- Depth ordering with ball still works
- Water pools at the bottom of the box

- [ ] **Step 3: Commit**

```bash
git add src/fluid-render/FluidScene.ts
git commit -m "feat: sphere-projected depth sprite material for fluid particles"
```

---

## Task 4: SSFR post-processing — depth blur + thickness

**Files:**
- Modify: `src/fluid-render/FluidScene.ts`

Add a RenderPipeline that:
1. Renders the scene (including particles) to a render target
2. Runs bilateral blur on the depth
3. Computes thickness with additive blending
4. Runs gaussian blur on thickness

- [ ] **Step 1: Set up multi-pass RenderPipeline in FluidScene**

Add render targets and a RenderPipeline that captures the scene pass and applies bilateral blur:

```ts
// @ts-ignore
import { pass, Fn, texture, screenUV, float, vec4, uniform, abs, exp, dot, floor, ceil, min, max, clamp } from 'three/tsl'

// In init():
private renderPipeline: any = null // THREE.RenderPipeline
private camera: THREE.PerspectiveCamera

initPostProcessing(renderer: any, camera: THREE.PerspectiveCamera) {
  this.camera = camera

  // Scene pass — renders everything (particles, ball, box) to render target
  const scenePass = pass(this.scene, camera)
  const sceneColor = scenePass.getTextureNode()
  const sceneDepth = scenePass.getLinearDepthNode()

  // Bilateral blur on scene color to smooth particle boundaries
  // This is a simplified SSFR — proper depth-only blur comes in Task 5
  const { bilateralBlur } = await import('three/examples/jsm/tsl/display/BilateralBlurNode.js')
  const blurred = bilateralBlur(sceneColor, sceneDepth, 4, 0.1)

  this.renderPipeline = new (THREE as any).RenderPipeline(renderer, blurred)
}
```

- [ ] **Step 2: Use RenderPipeline.render() instead of renderer.render() in the animation loop**

In FluidTest.tsx animation loop, replace:
```ts
sim.renderer.render(sim.scene, sim.camera)
```
with:
```ts
if (sim.fluidScene.renderPipeline) {
  sim.fluidScene.renderPipeline.render()
} else {
  sim.renderer.render(sim.scene, sim.camera)
}
```

- [ ] **Step 3: Verify the bilateral blur smooths particle boundaries**

Run: `cd universe-status && npm run dev`

Confirm:
- Individual particle sprites are smoothed into a more continuous surface
- Edges between particles and background are preserved (bilateral property)
- Depth ordering still works (ball in front/behind fluid)
- FPS remains above 30

- [ ] **Step 4: Commit**

```bash
git add src/fluid-render/FluidScene.ts src/components/FluidTest.tsx
git commit -m "feat: SSFR post-processing pipeline with bilateral blur on scene"
```

---

## Task 5: GPU-direct instancing (eliminate CPU readback)

**Files:**
- Modify: `src/fluid-render/FluidScene.ts`
- Modify: `src/components/FluidTest.tsx`

Replace the CPU readback + instance matrix update with GPU-direct instancing using StorageInstancedBufferAttribute. The particle positions stay on GPU — no CPU roundtrip.

- [ ] **Step 1: Create a StorageInstancedBufferAttribute for particle positions**

```ts
// In FluidScene.ts init():
const positionAttr = new (THREE as any).StorageInstancedBufferAttribute(
  MAX_PARTICLES, 3, Float32Array
)
// Attach to the instanced mesh geometry as a custom attribute
geo.setAttribute('particlePos', positionAttr)
```

- [ ] **Step 2: Write a compute shader that copies positions from the MLS-MPM particle buffer into the instanced attribute**

Since the MLS-MPM particle buffer has a 20-float stride with position at offset 0-2, we need a small compute shader that extracts positions:

```ts
// @ts-ignore
import { compute, storage, instanceIndex, float } from 'three/tsl'

// Compute node that reads from MLS-MPM particle buffer and writes to position attribute
const particleStorage = storage(mpmParticleBuffer, 'Particle', MAX_PARTICLES)
const posStorage = storage(positionAttr, 'vec3', MAX_PARTICLES)

const extractPositions = Fn(() => {
  const particle = particleStorage.element(instanceIndex)
  posStorage.element(instanceIndex).assign(vec3(
    particle.pos_x, particle.pos_y, particle.pos_z
  ))
})

const computeNode = extractPositions().compute(particleCount)
```

- [ ] **Step 3: Use the particlePos attribute in the vertex shader instead of instance matrices**

Update the NodeMaterial vertex shader to read from the `particlePos` attribute:

```ts
// In vertex shader:
const particlePos = attribute('particlePos')
// Billboard: offset quad vertices by particle position in world space
// Then transform through view + projection
```

- [ ] **Step 4: Run compute + render in the animation loop**

```ts
// In animation loop:
renderer.compute(computeNode) // extract positions from MLS-MPM buffer
renderer.render(scene, camera) // render scene with instanced particles
renderPipeline.render()         // SSFR post-processing
```

- [ ] **Step 5: Remove CPU readback code**

Delete the readbackBuffer creation, the mapAsync call, and the updateFromBuffer method from FluidScene.

- [ ] **Step 6: Verify GPU-direct rendering works**

Run: `cd universe-status && npm run dev`

Confirm:
- Particles render correctly (same visual as before)
- No CPU readback happening (check devtools — no mapAsync in timeline)
- FPS is higher than with CPU readback (GPU-direct is faster)
- Depth ordering still works

- [ ] **Step 7: Commit**

```bash
git add src/fluid-render/FluidScene.ts src/components/FluidTest.tsx
git commit -m "perf: GPU-direct instancing — eliminate CPU readback for particle positions"
```

---

## Task 6: Full SSFR composite shader (Fresnel + Beer's law + refraction)

**Files:**
- Modify: `src/fluid-render/FluidScene.ts`

Port the composite.wgsl shader into the RenderPipeline using `wgslFn()`. This is the final visual quality step — adds Fresnel reflections, Beer's law absorption, refraction, specular highlights, and per-composition material properties.

- [ ] **Step 1: Port the composite shader to wgslFn**

The composite.wgsl is 232 lines of fragment shader code. Use `wgslFn()` to embed it directly:

```ts
import { wgslFn } from 'three/tsl'

const compositeShader = wgslFn(`
  fn composite(
    depth: f32, thickness: f32, scene_color: vec4f,
    normal: vec3f, view_pos: vec3f,
    fluid_color: vec3f, density: f32, F0: f32,
    metalness: f32, emissive: f32, ior: f32,
    specular_power: f32, opacity_density: f32,
    light_dir: vec3f, time: f32
  ) -> vec4f {
    // ... port the compositing logic from composite.wgsl lines 91-232
    // Fresnel: F = F0 + (1-F0)(1 - N·V)^5
    // Beer's law: transmittance = exp(-density * thickness * (1 - color))
    // Refraction: offset UV by normal.xy * thickness
    // Specular: Blinn-Phong with primary + rim lights
    // Emissive: glow for lava/molten materials
    // Alpha: opacity from thickness + material properties
  }
`)
```

- [ ] **Step 2: Wire the composite into the RenderPipeline output**

Replace the bilateral blur output with the full composite chain:

```ts
// Scene pass
const scenePass = pass(scene, camera)
const sceneColor = scenePass.getTextureNode()
const sceneDepth = scenePass.getLinearDepthNode()

// Apply bilateral blur to smooth sphere boundaries
const blurred = bilateralBlur(sceneColor, sceneDepth, 4, 0.1)

// Apply composite (Fresnel + Beer's law + refraction)
const composited = compositeShader({
  sceneColor: blurred,
  depth: sceneDepth,
  // ... uniforms for fluid properties
})

this.renderPipeline = new (THREE as any).RenderPipeline(renderer, composited)
```

- [ ] **Step 3: Add per-composition material properties**

Create a uniform/storage buffer for the composition render properties table (256 entries x 48 bytes) and pass it to the composite shader. This mirrors the existing `compRenderPropsBuf` from FluidRenderer.

- [ ] **Step 4: Verify full SSFR visual quality**

Run: `cd universe-status && npm run dev`

Confirm:
- Water looks like water — blue, transparent, refractive
- Fresnel effect visible at glancing angles (edges brighter)
- Background visible through thin water (Beer's law)
- Specular highlights from lights
- Drop ball — ball visible behind AND in front of water (depth ordering)
- Spawn different materials (mercury, lava) — each has correct visual properties
- FPS comparable to original (1.5-3.5ms for SSFR passes)

- [ ] **Step 5: Commit**

```bash
git add src/fluid-render/FluidScene.ts
git commit -m "feat: full SSFR composite — Fresnel, Beer's law, refraction, per-material properties"
```

---

## Task 7: Cleanup — delete old files and update references

**Files:**
- Delete: `src/fluid-render/FluidRenderer.ts`
- Delete: `src/fluid-render/depthMap.wgsl`
- Delete: `src/fluid-render/bilateral.wgsl`
- Delete: `src/fluid-render/thicknessMap.wgsl`
- Delete: `src/fluid-render/gaussian.wgsl`
- Delete: `src/fluid-render/composite.wgsl`
- Delete: `src/fluid-render/fullScreen.wgsl`
- Delete: `src/fluid-render/debugDepth.wgsl`
- Delete: `src/components/FluidSSFR.ts`
- Modify: `src/components/FluidTest.tsx` (remove any remaining references)

- [ ] **Step 1: Delete old FluidRenderer and all raw WGSL render shaders**

```bash
rm src/fluid-render/FluidRenderer.ts
rm src/fluid-render/depthMap.wgsl
rm src/fluid-render/bilateral.wgsl
rm src/fluid-render/thicknessMap.wgsl
rm src/fluid-render/gaussian.wgsl
rm src/fluid-render/composite.wgsl
rm src/fluid-render/fullScreen.wgsl
rm src/fluid-render/debugDepth.wgsl
rm src/components/FluidSSFR.ts
```

- [ ] **Step 2: Verify no remaining imports reference deleted files**

```bash
grep -r "FluidRenderer\|FluidSSFR\|depthMap\.wgsl\|bilateral\.wgsl\|composite\.wgsl\|gaussian\.wgsl\|thicknessMap\.wgsl\|fullScreen\.wgsl\|debugDepth\.wgsl" src/
```

Expected: no matches. If any found, remove the imports.

- [ ] **Step 3: Verify the app builds cleanly**

```bash
cd universe-status && npm run build
```

Expected: clean build, no errors.

- [ ] **Step 4: Final visual verification**

Run: `cd universe-status && npm run dev`

Full test:
- Water falls, pools, pressure works
- Ball drops and displaces water — visible in front AND behind fluid
- Click to spawn particles — new clusters appear
- Spawn different materials via AI chat — each has correct rendering
- Gravity slider works
- Temperature slider works
- Reset button works
- FPS stays above 30 with 10K particles

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "cleanup: remove overlay canvas FluidRenderer and raw WGSL render shaders — SSFR fully integrated into Three.js"
```

---

## Task 8: Update FluidTest.tsx resize handler and edge cases

**Files:**
- Modify: `src/components/FluidTest.tsx`

- [ ] **Step 1: Update resize handler to resize the RenderPipeline**

The current resize handler only updates the Three.js renderer. It also needs to update the RenderPipeline's internal render targets:

```ts
const onResize = () => {
  if (!container || !simRef.current) return
  const w = container.clientWidth
  const h = container.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  // RenderPipeline auto-resizes with the renderer — no manual action needed
}
```

- [ ] **Step 2: Verify resize behavior**

Open dev tools, resize browser window. Confirm:
- Scene scales correctly
- Fluid rendering fills the new viewport
- No black bars or clipping

- [ ] **Step 3: Clean up the simRef type**

Remove `fluidRenderer` from the simRef type. Add `fluidScene` and `readbackBuffer` (if still used). Remove any dead references.

- [ ] **Step 4: Commit**

```bash
git add src/components/FluidTest.tsx
git commit -m "fix: update resize handler and clean up simRef for new FluidScene architecture"
```
