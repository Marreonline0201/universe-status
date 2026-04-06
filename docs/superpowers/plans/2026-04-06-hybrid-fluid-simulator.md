# Hybrid Fluid Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CPU-based WASM fluid sim with hybrid GPU compute (MLS-MPM) + CPU material system, supporting multi-material mixing with AI-driven experimentation.

**Architecture:** GPU compute shaders handle fluid dynamics (MLS-MPM, 20-40k particles). CPU manages a composition table with full element-based material properties. Contact detection runs on GPU, contact resolution (mixing/reactions) runs on CPU. SSFR rendering pipeline is preserved and extended for per-pixel material properties. AI chat panel uses Claude API to generate materials from natural language.

**Tech Stack:** WebGPU compute shaders (WGSL), TypeScript, React, Three.js, Claude API (Anthropic SDK)

**Spec:** `docs/superpowers/specs/2026-04-06-hybrid-fluid-simulator-design.md`

**Reference:** https://github.com/matsuoka-601/WebGPU-Ocean (MLS-MPM compute shaders, fixed-point atomics)

---

## File Structure

### New Files (GPU Compute)
- `src/gpu-sim/MpmGpuSimulator.ts` — orchestrates compute passes, manages GPU buffers
- `src/gpu-sim/shaders/clearGrid.wgsl` — reset grid cells to zero
- `src/gpu-sim/shaders/p2g.wgsl` — particle-to-grid scatter (mass + momentum, fixed-point atomics)
- `src/gpu-sim/shaders/gridForces.wgsl` — apply pressure, viscosity, gravity on grid
- `src/gpu-sim/shaders/g2p.wgsl` — grid-to-particle gather (velocity, affine matrix, position update)
- `src/gpu-sim/shaders/contactDetect.wgsl` — find neighbor particles with different composition_id

### New Files (Composition System)
- `src/composition/CompositionTable.ts` — CPU-side table: elements → derived properties
- `src/composition/PropertyCalculator.ts` — structure.md §3.1 formulas (density, viscosity, etc.)
- `src/composition/ContactProcessor.ts` — CPU-side mixing, reactions, phase transitions

### New Files (AI)
- `src/components/AIChatPanel.tsx` — chat UI + auto-experiment toggle
- `src/ai/MaterialGenerator.ts` — Claude API: natural language → composition
- `src/ai/AutoExperimenter.ts` — autonomous experiment loop

### Modified Files
- `src/components/FluidTest.tsx` — replace WASM with GPU sim, multi-material UI
- `src/fluid-render/FluidRenderer.ts` — add composition table bind group, comp_id texture
- `src/fluid-render/depthMap.wgsl` — output composition_id per pixel
- `src/fluid-render/composite.wgsl` — read per-pixel material from composition table

### Removed Dependencies
- `src/wasm/sph_wasm.js` — no longer imported by FluidTest (kept in repo for reference)
- `src/wasm/sph_wasm_bg.wasm` — no longer imported by FluidTest

---

## Phase 1: GPU MLS-MPM Simulation Core

### Task 1: Clear Grid Shader

**Files:**
- Create: `src/gpu-sim/shaders/clearGrid.wgsl`

- [ ] **Step 1: Create the shader file**

```wgsl
// clearGrid.wgsl — Reset all grid cells to zero
// Grid: 64^3 = 262,144 cells
// Each cell: 4 x i32 (velocity.xyz as fixed-point + mass as fixed-point)

@group(0) @binding(0) var<storage, read_write> grid: array<vec4<i32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= 262144u) { return; }
    grid[idx] = vec4<i32>(0, 0, 0, 0);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gpu-sim/shaders/clearGrid.wgsl
git commit -m "feat: add clearGrid compute shader for MLS-MPM"
```

### Task 2: Particle-to-Grid (P2G) Shader

**Files:**
- Create: `src/gpu-sim/shaders/p2g.wgsl`

- [ ] **Step 1: Create the P2G shader**

This is the most complex shader. Each particle scatters its mass and momentum to 27 neighboring grid cells using quadratic B-spline weights. Uses fixed-point atomics (multiply by 1e7, store as i32) because WebGPU only supports atomicAdd on integers.

```wgsl
// p2g.wgsl — Particle-to-Grid transfer
// Scatters mass + momentum using quadratic B-spline interpolation
// Fixed-point atomics: value * FIXED_SCALE -> i32, atomicAdd, then decode

const GRID_SIZE: u32 = 64u;
const FIXED_SCALE: f32 = 1e7;
const DX: f32 = 1.0 / 64.0;      // grid cell size
const INV_DX: f32 = 64.0;

struct Particle {
    pos: vec3<f32>,
    composition_id: u32,
    vel: vec3<f32>,
    temperature: f32,
    C: mat2x2<f32>,     // affine velocity field (2D for now, expandable to 3D)
    phase: u32,
    _pad: vec3<f32>,
}

struct SimParams {
    dt: f32,
    gravity: f32,
    num_particles: u32,
    _pad: u32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> grid: array<vec4<i32>>;
@group(0) @binding(2) var<uniform> params: SimParams;
@group(0) @binding(3) var<storage, read> comp_props: array<vec4<f32>, 256>;
// comp_props[id] = vec4(density, viscosity, surface_tension, stiffness)

fn encode(val: f32) -> i32 {
    return i32(val * FIXED_SCALE);
}

fn grid_index(x: u32, y: u32, z: u32) -> u32 {
    return x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE;
}

// Quadratic B-spline weight
fn bspline_weight(x: f32) -> f32 {
    let abs_x = abs(x);
    if (abs_x < 0.5) {
        return 0.75 - abs_x * abs_x;
    } else if (abs_x < 1.5) {
        let t = 1.5 - abs_x;
        return 0.5 * t * t;
    }
    return 0.0;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let p_idx = id.x;
    if (p_idx >= params.num_particles) { return; }

    let p = particles[p_idx];
    let pos = p.pos;
    let vel = p.vel;

    // Get material density from composition table
    let comp = comp_props[p.composition_id];
    let mass = comp.x * DX * DX * DX;  // density * cell_volume

    // Grid cell containing this particle
    let cell = vec3<i32>(floor(pos * INV_DX));

    // Scatter to 3x3x3 neighborhood
    for (var dz: i32 = -1; dz <= 1; dz++) {
        for (var dy: i32 = -1; dy <= 1; dy++) {
            for (var dx_off: i32 = -1; dx_off <= 1; dx_off++) {
                let grid_pos = cell + vec3<i32>(dx_off, dy, dz);

                // Bounds check
                if (grid_pos.x < 0 || grid_pos.x >= i32(GRID_SIZE) ||
                    grid_pos.y < 0 || grid_pos.y >= i32(GRID_SIZE) ||
                    grid_pos.z < 0 || grid_pos.z >= i32(GRID_SIZE)) {
                    continue;
                }

                let cell_pos = (vec3<f32>(grid_pos) + 0.5) * DX;
                let diff = pos - cell_pos;

                // B-spline weight
                let w = bspline_weight(diff.x * INV_DX)
                      * bspline_weight(diff.y * INV_DX)
                      * bspline_weight(diff.z * INV_DX);

                let weighted_mass = mass * w;
                let momentum = vel * weighted_mass;

                let g_idx = grid_index(u32(grid_pos.x), u32(grid_pos.y), u32(grid_pos.z));

                // Atomic scatter (fixed-point)
                atomicAdd(&grid[g_idx].x, encode(momentum.x));
                atomicAdd(&grid[g_idx].y, encode(momentum.y));
                atomicAdd(&grid[g_idx].z, encode(momentum.z));
                atomicAdd(&grid[g_idx].w, encode(weighted_mass));
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gpu-sim/shaders/p2g.wgsl
git commit -m "feat: add P2G compute shader with fixed-point atomics"
```

### Task 3: Grid Forces Shader

**Files:**
- Create: `src/gpu-sim/shaders/gridForces.wgsl`

- [ ] **Step 1: Create the grid forces shader**

```wgsl
// gridForces.wgsl — Apply gravity and boundary conditions on grid
// Decodes fixed-point, applies physics, re-encodes

const GRID_SIZE: u32 = 64u;
const FIXED_SCALE: f32 = 1e7;
const INV_FIXED: f32 = 1e-7;

struct SimParams {
    dt: f32,
    gravity: f32,
    num_particles: u32,
    _pad: u32,
}

@group(0) @binding(0) var<storage, read_write> grid: array<vec4<i32>>;
@group(0) @binding(1) var<uniform> params: SimParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= GRID_SIZE * GRID_SIZE * GRID_SIZE) { return; }

    let cell = grid[idx];
    let mass = f32(cell.w) * INV_FIXED;

    if (mass <= 0.0) { return; }

    // Decode velocity = momentum / mass
    var vel = vec3<f32>(
        f32(cell.x) * INV_FIXED / mass,
        f32(cell.y) * INV_FIXED / mass,
        f32(cell.z) * INV_FIXED / mass,
    );

    // Apply gravity
    vel.y -= params.gravity * params.dt;

    // Grid position
    let z = idx / (GRID_SIZE * GRID_SIZE);
    let y = (idx % (GRID_SIZE * GRID_SIZE)) / GRID_SIZE;
    let x = idx % GRID_SIZE;

    // Boundary conditions: clamp velocity near walls
    let boundary = 2u;
    if (x < boundary || x >= GRID_SIZE - boundary) { vel.x = 0.0; }
    if (y < boundary || y >= GRID_SIZE - boundary) { vel.y = 0.0; }
    if (z < boundary || z >= GRID_SIZE - boundary) { vel.z = 0.0; }

    // Floor: no downward velocity at bottom
    if (y < boundary && vel.y < 0.0) { vel.y = 0.0; }

    // Re-encode as momentum (velocity * mass)
    let momentum = vel * mass;
    grid[idx] = vec4<i32>(
        i32(momentum.x * FIXED_SCALE),
        i32(momentum.y * FIXED_SCALE),
        i32(momentum.z * FIXED_SCALE),
        cell.w,  // mass unchanged
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gpu-sim/shaders/gridForces.wgsl
git commit -m "feat: add gridForces compute shader (gravity + boundaries)"
```

### Task 4: Grid-to-Particle (G2P) Shader

**Files:**
- Create: `src/gpu-sim/shaders/g2p.wgsl`

- [ ] **Step 1: Create the G2P shader**

```wgsl
// g2p.wgsl — Grid-to-Particle transfer
// Gathers velocity from 27 grid cells back to each particle
// Updates position, velocity, and affine velocity field C

const GRID_SIZE: u32 = 64u;
const FIXED_SCALE: f32 = 1e7;
const INV_FIXED: f32 = 1e-7;
const DX: f32 = 1.0 / 64.0;
const INV_DX: f32 = 64.0;

struct Particle {
    pos: vec3<f32>,
    composition_id: u32,
    vel: vec3<f32>,
    temperature: f32,
    C: mat2x2<f32>,
    phase: u32,
    _pad: vec3<f32>,
}

struct SimParams {
    dt: f32,
    gravity: f32,
    num_particles: u32,
    _pad: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read> grid: array<vec4<i32>>;
@group(0) @binding(2) var<uniform> params: SimParams;

fn grid_index(x: u32, y: u32, z: u32) -> u32 {
    return x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE;
}

fn bspline_weight(x: f32) -> f32 {
    let abs_x = abs(x);
    if (abs_x < 0.5) {
        return 0.75 - abs_x * abs_x;
    } else if (abs_x < 1.5) {
        let t = 1.5 - abs_x;
        return 0.5 * t * t;
    }
    return 0.0;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let p_idx = id.x;
    if (p_idx >= params.num_particles) { return; }

    var p = particles[p_idx];
    let pos = p.pos;

    let cell = vec3<i32>(floor(pos * INV_DX));

    var new_vel = vec3<f32>(0.0);

    // Gather from 3x3x3 neighborhood
    for (var dz: i32 = -1; dz <= 1; dz++) {
        for (var dy: i32 = -1; dy <= 1; dy++) {
            for (var dx_off: i32 = -1; dx_off <= 1; dx_off++) {
                let grid_pos = cell + vec3<i32>(dx_off, dy, dz);

                if (grid_pos.x < 0 || grid_pos.x >= i32(GRID_SIZE) ||
                    grid_pos.y < 0 || grid_pos.y >= i32(GRID_SIZE) ||
                    grid_pos.z < 0 || grid_pos.z >= i32(GRID_SIZE)) {
                    continue;
                }

                let cell_pos = (vec3<f32>(grid_pos) + 0.5) * DX;
                let diff = pos - cell_pos;

                let w = bspline_weight(diff.x * INV_DX)
                      * bspline_weight(diff.y * INV_DX)
                      * bspline_weight(diff.z * INV_DX);

                let g_idx = grid_index(u32(grid_pos.x), u32(grid_pos.y), u32(grid_pos.z));
                let g = grid[g_idx];
                let mass = f32(g.w) * INV_FIXED;

                if (mass > 0.0) {
                    let grid_vel = vec3<f32>(
                        f32(g.x) * INV_FIXED / mass,
                        f32(g.y) * INV_FIXED / mass,
                        f32(g.z) * INV_FIXED / mass,
                    );
                    new_vel += grid_vel * w;
                }
            }
        }
    }

    // Update velocity and position
    p.vel = new_vel;
    p.pos = pos + new_vel * params.dt;

    // Wall collision (clamp to domain)
    let margin = 3.0 * DX;
    let lo = margin;
    let hi = 1.0 - margin;
    p.pos = clamp(p.pos, vec3<f32>(lo), vec3<f32>(hi));

    // Reflect velocity at walls
    if (p.pos.x <= lo || p.pos.x >= hi) { p.vel.x = 0.0; }
    if (p.pos.y <= lo || p.pos.y >= hi) { p.vel.y = 0.0; }
    if (p.pos.z <= lo || p.pos.z >= hi) { p.vel.z = 0.0; }

    particles[p_idx] = p;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gpu-sim/shaders/g2p.wgsl
git commit -m "feat: add G2P compute shader (gather velocity, update position)"
```

### Task 5: Contact Detection Shader

**Files:**
- Create: `src/gpu-sim/shaders/contactDetect.wgsl`

- [ ] **Step 1: Create the contact detection shader**

```wgsl
// contactDetect.wgsl — Find particles of different compositions near each other
// Writes contact pairs to an append buffer for CPU processing

const GRID_SIZE: u32 = 64u;
const INV_DX: f32 = 64.0;
const CONTACT_RADIUS_SQ: f32 = 0.0004; // (0.02)^2 in sim units
const MAX_CONTACTS: u32 = 10000u;

struct Particle {
    pos: vec3<f32>,
    composition_id: u32,
    vel: vec3<f32>,
    temperature: f32,
    C: mat2x2<f32>,
    phase: u32,
    _pad: vec3<f32>,
}

struct ContactPair {
    particle_a: u32,
    particle_b: u32,
}

struct ContactCounter {
    count: atomic<u32>,
}

struct SimParams {
    dt: f32,
    gravity: f32,
    num_particles: u32,
    _pad: u32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> contacts: array<ContactPair, 10000>;
@group(0) @binding(2) var<storage, read_write> counter: ContactCounter;
@group(0) @binding(3) var<uniform> params: SimParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= params.num_particles) { return; }

    let pi = particles[i];

    // Simple O(n) scan — only check particles with index > i to avoid duplicates
    // For production: use spatial hash. For 20-40k particles this is acceptable
    // if we limit checks to every 10th frame.
    for (var j = i + 1u; j < params.num_particles; j++) {
        let pj = particles[j];

        // Skip same composition
        if (pi.composition_id == pj.composition_id) { continue; }

        let diff = pi.pos - pj.pos;
        let dist_sq = dot(diff, diff);

        if (dist_sq < CONTACT_RADIUS_SQ) {
            let idx = atomicAdd(&counter.count, 1u);
            if (idx < MAX_CONTACTS) {
                contacts[idx] = ContactPair(i, j);
            }
        }
    }
}
```

Note: This naive O(n²) approach is acceptable because:
1. Contact detection runs every 10th frame (not every frame)
2. At 20k particles, the GPU handles this in parallel
3. Most particle pairs are far apart and skip early

For higher particle counts, replace with spatial hash grid (Task 5b, deferred).

- [ ] **Step 2: Commit**

```bash
git add src/gpu-sim/shaders/contactDetect.wgsl
git commit -m "feat: add contactDetect compute shader for multi-material mixing"
```

### Task 6: GPU Simulator Manager

**Files:**
- Create: `src/gpu-sim/MpmGpuSimulator.ts`

- [ ] **Step 1: Create the simulator class**

```typescript
// MpmGpuSimulator.ts — Orchestrates MLS-MPM compute passes on GPU

import clearGridWGSL from './shaders/clearGrid.wgsl?raw'
import p2gWGSL from './shaders/p2g.wgsl?raw'
import gridForcesWGSL from './shaders/gridForces.wgsl?raw'
import g2pWGSL from './shaders/g2p.wgsl?raw'
import contactDetectWGSL from './shaders/contactDetect.wgsl?raw'

export interface GpuParticle {
  pos: [number, number, number]
  vel: [number, number, number]
  composition_id: number
  temperature: number
  phase: number
}

export interface CompositionGpuProps {
  color: [number, number, number]
  density: number
  viscosity: number
  surfaceTension: number
  meltingPoint: number
  boilingPoint: number
  F0: number
  metalness: number
  emissive: number
  IOR: number
  specularPower: number
  opacityDensity: number
}

const GRID_SIZE = 64
const GRID_CELLS = GRID_SIZE ** 3
const MAX_PARTICLES = 40_000
const MAX_CONTACTS = 10_000
// Particle struct: pos(12) + comp_id(4) + vel(12) + temp(4) + C(16) + phase(4) + pad(12) = 64 bytes
const PARTICLE_STRIDE = 64
const COMPOSITION_STRIDE = 64  // 16 floats padded to 64 bytes

export class MpmGpuSimulator {
  private device!: GPUDevice
  private initialized = false

  // Buffers
  private particleBuf!: GPUBuffer
  private gridBuf!: GPUBuffer
  private simParamsBuf!: GPUBuffer
  private compPropsBuf!: GPUBuffer
  private contactBuf!: GPUBuffer
  private contactCounterBuf!: GPUBuffer
  private contactReadBuf!: GPUBuffer  // for CPU readback
  private counterReadBuf!: GPUBuffer

  // Pipelines
  private clearGridPipeline!: GPUComputePipeline
  private p2gPipeline!: GPUComputePipeline
  private gridForcesPipeline!: GPUComputePipeline
  private g2pPipeline!: GPUComputePipeline
  private contactDetectPipeline!: GPUComputePipeline

  // Bind groups
  private clearGridBG!: GPUBindGroup
  private p2gBG!: GPUBindGroup
  private gridForcesBG!: GPUBindGroup
  private g2pBG!: GPUBindGroup
  private contactDetectBG!: GPUBindGroup

  private numParticles = 0
  private frameCount = 0
  private gravity = 9.81
  private dt = 0.2

  get particleBuffer(): GPUBuffer { return this.particleBuf }
  get particleCount(): number { return this.numParticles }
  get isInitialized(): boolean { return this.initialized }

  async init(device: GPUDevice): Promise<boolean> {
    this.device = device

    // Create buffers
    this.particleBuf = device.createBuffer({
      size: MAX_PARTICLES * PARTICLE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })

    this.gridBuf = device.createBuffer({
      size: GRID_CELLS * 16,  // vec4<i32> per cell
      usage: GPUBufferUsage.STORAGE,
    })

    this.simParamsBuf = device.createBuffer({
      size: 16,  // dt, gravity, num_particles, pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.compPropsBuf = device.createBuffer({
      size: 256 * 16,  // 256 compositions * vec4(density, viscosity, surfTension, stiffness)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    this.contactBuf = device.createBuffer({
      size: MAX_CONTACTS * 8,  // ContactPair = 2 x u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })

    this.contactCounterBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })

    this.contactReadBuf = device.createBuffer({
      size: MAX_CONTACTS * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })

    this.counterReadBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })

    // Create compute pipelines
    this.clearGridPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: clearGridWGSL }), entryPoint: 'main' },
    })

    this.p2gPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: p2gWGSL }), entryPoint: 'main' },
    })

    this.gridForcesPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: gridForcesWGSL }), entryPoint: 'main' },
    })

    this.g2pPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: g2pWGSL }), entryPoint: 'main' },
    })

    this.contactDetectPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: contactDetectWGSL }), entryPoint: 'main' },
    })

    // Create bind groups
    this.clearGridBG = device.createBindGroup({
      layout: this.clearGridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.gridBuf } }],
    })

    this.p2gBG = device.createBindGroup({
      layout: this.p2gPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.gridBuf } },
        { binding: 2, resource: { buffer: this.simParamsBuf } },
        { binding: 3, resource: { buffer: this.compPropsBuf } },
      ],
    })

    this.gridForcesBG = device.createBindGroup({
      layout: this.gridForcesPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.gridBuf } },
        { binding: 1, resource: { buffer: this.simParamsBuf } },
      ],
    })

    this.g2pBG = device.createBindGroup({
      layout: this.g2pPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.gridBuf } },
        { binding: 2, resource: { buffer: this.simParamsBuf } },
      ],
    })

    this.contactDetectBG = device.createBindGroup({
      layout: this.contactDetectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.contactBuf } },
        { binding: 2, resource: { buffer: this.contactCounterBuf } },
        { binding: 3, resource: { buffer: this.simParamsBuf } },
      ],
    })

    this.initialized = true
    return true
  }

  /** Upload initial particles to GPU */
  spawnParticles(particles: GpuParticle[]) {
    const data = new Float32Array(particles.length * (PARTICLE_STRIDE / 4))
    for (let i = 0; i < particles.length; i++) {
      const offset = i * (PARTICLE_STRIDE / 4)  // 16 floats per particle
      const p = particles[i]
      data[offset + 0] = p.pos[0]
      data[offset + 1] = p.pos[1]
      data[offset + 2] = p.pos[2]
      // composition_id stored as u32 bits in f32 slot
      new Uint32Array(data.buffer, (offset + 3) * 4, 1)[0] = p.composition_id
      data[offset + 4] = p.vel[0]
      data[offset + 5] = p.vel[1]
      data[offset + 6] = p.vel[2]
      data[offset + 7] = p.temperature
      // C matrix (identity-ish) — start at zero
      data[offset + 8] = 0; data[offset + 9] = 0
      data[offset + 10] = 0; data[offset + 11] = 0
      // phase
      new Uint32Array(data.buffer, (offset + 12) * 4, 1)[0] = p.phase
      // padding
      data[offset + 13] = 0; data[offset + 14] = 0; data[offset + 15] = 0
    }
    this.device.queue.writeBuffer(this.particleBuf, 0, data, 0, particles.length * (PARTICLE_STRIDE / 4))
    this.numParticles = particles.length
  }

  /** Add more particles without clearing existing ones */
  addParticles(particles: GpuParticle[]) {
    const data = new Float32Array(particles.length * (PARTICLE_STRIDE / 4))
    for (let i = 0; i < particles.length; i++) {
      const offset = i * (PARTICLE_STRIDE / 4)
      const p = particles[i]
      data[offset + 0] = p.pos[0]
      data[offset + 1] = p.pos[1]
      data[offset + 2] = p.pos[2]
      new Uint32Array(data.buffer, (offset + 3) * 4, 1)[0] = p.composition_id
      data[offset + 4] = p.vel[0]
      data[offset + 5] = p.vel[1]
      data[offset + 6] = p.vel[2]
      data[offset + 7] = p.temperature
      data[offset + 8] = 0; data[offset + 9] = 0
      data[offset + 10] = 0; data[offset + 11] = 0
      new Uint32Array(data.buffer, (offset + 12) * 4, 1)[0] = p.phase
      data[offset + 13] = 0; data[offset + 14] = 0; data[offset + 15] = 0
    }
    const byteOffset = this.numParticles * PARTICLE_STRIDE
    this.device.queue.writeBuffer(this.particleBuf, byteOffset, data)
    this.numParticles += particles.length
  }

  /** Upload composition properties to GPU */
  updateCompositionProps(props: Float32Array) {
    // props: 256 * 4 floats (density, viscosity, surfaceTension, stiffness per composition)
    this.device.queue.writeBuffer(this.compPropsBuf, 0, props)
  }

  /** Run one simulation step (2 substeps) */
  step(encoder: GPUCommandEncoder) {
    // Update sim params
    const params = new Float32Array([this.dt, this.gravity, 0, 0])
    new Uint32Array(params.buffer, 8, 1)[0] = this.numParticles
    this.device.queue.writeBuffer(this.simParamsBuf, 0, params)

    const particleGroups = Math.ceil(this.numParticles / 256)
    const gridGroups = Math.ceil(GRID_CELLS / 256)

    // 2 substeps per frame
    for (let sub = 0; sub < 2; sub++) {
      // 1. Clear grid
      const clearPass = encoder.beginComputePass()
      clearPass.setPipeline(this.clearGridPipeline)
      clearPass.setBindGroup(0, this.clearGridBG)
      clearPass.dispatchWorkgroups(gridGroups)
      clearPass.end()

      // 2. P2G
      const p2gPass = encoder.beginComputePass()
      p2gPass.setPipeline(this.p2gPipeline)
      p2gPass.setBindGroup(0, this.p2gBG)
      p2gPass.dispatchWorkgroups(particleGroups)
      p2gPass.end()

      // 3. Grid forces
      const forcesPass = encoder.beginComputePass()
      forcesPass.setPipeline(this.gridForcesPipeline)
      forcesPass.setBindGroup(0, this.gridForcesBG)
      forcesPass.dispatchWorkgroups(gridGroups)
      forcesPass.end()

      // 4. G2P
      const g2pPass = encoder.beginComputePass()
      g2pPass.setPipeline(this.g2pPipeline)
      g2pPass.setBindGroup(0, this.g2pBG)
      g2pPass.dispatchWorkgroups(particleGroups)
      g2pPass.end()
    }

    // Contact detection every 10 frames
    this.frameCount++
    if (this.frameCount % 10 === 0) {
      // Reset counter
      this.device.queue.writeBuffer(this.contactCounterBuf, 0, new Uint32Array([0]))

      const contactPass = encoder.beginComputePass()
      contactPass.setPipeline(this.contactDetectPipeline)
      contactPass.setBindGroup(0, this.contactDetectBG)
      contactPass.dispatchWorkgroups(particleGroups)
      contactPass.end()

      // Copy results for CPU readback
      encoder.copyBufferToBuffer(this.contactCounterBuf, 0, this.counterReadBuf, 0, 4)
      encoder.copyBufferToBuffer(this.contactBuf, 0, this.contactReadBuf, 0, MAX_CONTACTS * 8)
    }
  }

  /** Read contact pairs back to CPU (async) */
  async readContacts(): Promise<{ a: number, b: number }[]> {
    await this.counterReadBuf.mapAsync(GPUMapMode.READ)
    const countData = new Uint32Array(this.counterReadBuf.getMappedRange())
    const count = Math.min(countData[0], MAX_CONTACTS)
    this.counterReadBuf.unmap()

    if (count === 0) return []

    await this.contactReadBuf.mapAsync(GPUMapMode.READ)
    const contactData = new Uint32Array(this.contactReadBuf.getMappedRange())
    const contacts: { a: number, b: number }[] = []
    for (let i = 0; i < count; i++) {
      contacts.push({ a: contactData[i * 2], b: contactData[i * 2 + 1] })
    }
    this.contactReadBuf.unmap()

    return contacts
  }

  /** Get positions for SSFR rendering (returns the raw GPU buffer) */
  getParticleBuffer(): GPUBuffer {
    return this.particleBuf
  }

  setGravity(g: number) { this.gravity = g }
  setTimestep(dt: number) { this.dt = dt }

  destroy() {
    this.particleBuf?.destroy()
    this.gridBuf?.destroy()
    this.simParamsBuf?.destroy()
    this.compPropsBuf?.destroy()
    this.contactBuf?.destroy()
    this.contactCounterBuf?.destroy()
    this.contactReadBuf?.destroy()
    this.counterReadBuf?.destroy()
    this.initialized = false
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gpu-sim/MpmGpuSimulator.ts
git commit -m "feat: add MpmGpuSimulator manager class"
```

---

## Phase 2: Composition System

### Task 7: Property Calculator

**Files:**
- Create: `src/composition/PropertyCalculator.ts`

- [ ] **Step 1: Create the property calculator**

Implements a subset of structure.md §3.1 formulas — enough for the fluid test.

```typescript
// PropertyCalculator.ts — Compute material properties from element composition
// Implements structure.md §3.1 formulas (simplified subset for fluid test)

// 25 gameplay elements from docs/element-properties.md
export const ELEMENTS = [
  'H', 'C', 'N', 'O', 'Na', 'Mg', 'Al', 'Si', 'P', 'S',
  'Cl', 'K', 'Ca', 'Ti', 'Cr', 'Mn', 'Fe', 'Ni', 'Cu', 'Zn',
  'Sn', 'Pb', 'Ag', 'Au', 'W',
] as const

export type ElementName = typeof ELEMENTS[number]

// Base element properties (from docs/element-properties.md)
const ELEMENT_DATA: Record<ElementName, {
  density: number,       // kg/m³
  meltingPoint: number,  // °C
  boilingPoint: number,  // °C
  specificHeat: number,  // J/(kg·K)
  thermalCond: number,   // W/(m·K)
  color: [number, number, number],  // RGB 0-1
}> = {
  H:  { density: 0.089, meltingPoint: -259, boilingPoint: -253, specificHeat: 14300, thermalCond: 0.18, color: [0.9, 0.9, 1.0] },
  C:  { density: 2260, meltingPoint: 3550, boilingPoint: 4827, specificHeat: 710, thermalCond: 1.7, color: [0.2, 0.2, 0.2] },
  N:  { density: 1.25, meltingPoint: -210, boilingPoint: -196, specificHeat: 1040, thermalCond: 0.026, color: [0.9, 0.9, 1.0] },
  O:  { density: 1.43, meltingPoint: -218, boilingPoint: -183, specificHeat: 919, thermalCond: 0.027, color: [0.5, 0.7, 1.0] },
  Na: { density: 971, meltingPoint: 98, boilingPoint: 883, specificHeat: 1230, thermalCond: 140, color: [0.8, 0.8, 0.8] },
  Mg: { density: 1738, meltingPoint: 650, boilingPoint: 1091, specificHeat: 1020, thermalCond: 156, color: [0.7, 0.7, 0.7] },
  Al: { density: 2700, meltingPoint: 660, boilingPoint: 2519, specificHeat: 897, thermalCond: 237, color: [0.8, 0.8, 0.85] },
  Si: { density: 2330, meltingPoint: 1414, boilingPoint: 3265, specificHeat: 710, thermalCond: 149, color: [0.4, 0.4, 0.5] },
  P:  { density: 1820, meltingPoint: 44, boilingPoint: 280, specificHeat: 769, thermalCond: 0.236, color: [1.0, 1.0, 0.8] },
  S:  { density: 2070, meltingPoint: 115, boilingPoint: 445, specificHeat: 710, thermalCond: 0.205, color: [1.0, 1.0, 0.3] },
  Cl: { density: 3.21, meltingPoint: -101, boilingPoint: -34, specificHeat: 479, thermalCond: 0.009, color: [0.5, 1.0, 0.5] },
  K:  { density: 862, meltingPoint: 63, boilingPoint: 759, specificHeat: 757, thermalCond: 102, color: [0.8, 0.8, 0.8] },
  Ca: { density: 1550, meltingPoint: 842, boilingPoint: 1484, specificHeat: 631, thermalCond: 201, color: [0.9, 0.9, 0.9] },
  Ti: { density: 4506, meltingPoint: 1668, boilingPoint: 3287, specificHeat: 523, thermalCond: 22, color: [0.7, 0.7, 0.75] },
  Cr: { density: 7190, meltingPoint: 1907, boilingPoint: 2671, specificHeat: 449, thermalCond: 94, color: [0.75, 0.75, 0.8] },
  Mn: { density: 7440, meltingPoint: 1246, boilingPoint: 2061, specificHeat: 479, thermalCond: 7.8, color: [0.7, 0.7, 0.7] },
  Fe: { density: 7874, meltingPoint: 1538, boilingPoint: 2862, specificHeat: 449, thermalCond: 80, color: [0.6, 0.6, 0.6] },
  Ni: { density: 8908, meltingPoint: 1455, boilingPoint: 2913, specificHeat: 444, thermalCond: 91, color: [0.65, 0.65, 0.7] },
  Cu: { density: 8960, meltingPoint: 1085, boilingPoint: 2562, specificHeat: 385, thermalCond: 401, color: [0.85, 0.5, 0.2] },
  Zn: { density: 7134, meltingPoint: 420, boilingPoint: 907, specificHeat: 388, thermalCond: 116, color: [0.7, 0.7, 0.75] },
  Sn: { density: 7287, meltingPoint: 232, boilingPoint: 2602, specificHeat: 228, thermalCond: 67, color: [0.75, 0.75, 0.75] },
  Pb: { density: 11340, meltingPoint: 327, boilingPoint: 1749, specificHeat: 129, thermalCond: 35, color: [0.4, 0.4, 0.45] },
  Ag: { density: 10490, meltingPoint: 962, boilingPoint: 2162, specificHeat: 235, thermalCond: 429, color: [0.9, 0.9, 0.92] },
  Au: { density: 19300, meltingPoint: 1064, boilingPoint: 2856, specificHeat: 129, thermalCond: 318, color: [1.0, 0.84, 0.0] },
  W:  { density: 19250, meltingPoint: 3422, boilingPoint: 5555, specificHeat: 132, thermalCond: 173, color: [0.6, 0.6, 0.65] },
}

export interface Composition {
  elements: Partial<Record<ElementName, number>>  // mass fractions, sum to 1.0
}

export interface DerivedProps {
  density: number
  viscosity: number
  surfaceTension: number
  meltingPoint: number
  boilingPoint: number
  color: [number, number, number]
  thermalConductivity: number
  specificHeat: number
  // Rendering properties
  F0: number          // Fresnel at normal incidence
  metalness: number   // 0-1
  emissive: number    // glow intensity
  IOR: number         // index of refraction
  specularPower: number
  opacityDensity: number
}

/** Compute derived material properties from element composition */
export function computeProperties(comp: Composition, temperature: number = 20): DerivedProps {
  const elems = comp.elements
  const entries = Object.entries(elems) as [ElementName, number][]

  // Vegard's law: linear interpolation of component properties by mass fraction
  let density = 0, meltingPoint = 0, boilingPoint = 0, specificHeat = 0, thermalCond = 0
  const color: [number, number, number] = [0, 0, 0]

  for (const [el, frac] of entries) {
    const d = ELEMENT_DATA[el]
    density += d.density * frac
    meltingPoint += d.meltingPoint * frac
    boilingPoint += d.boilingPoint * frac
    specificHeat += d.specificHeat * frac
    thermalCond += d.thermalCond * frac
    color[0] += d.color[0] * frac
    color[1] += d.color[1] * frac
    color[2] += d.color[2] * frac
  }

  // Viscosity: Arrhenius approximation
  // Low density → gas-like (low viscosity), high density metal → low viscosity when molten
  // This is a simplified model; the real game uses Andrade equation
  const isMetallic = entries.some(([el]) => ['Fe', 'Cu', 'Au', 'Ag', 'Ni', 'Zn', 'Sn', 'Pb', 'W', 'Al', 'Ti', 'Cr', 'Mn'].includes(el))
    && entries.filter(([el]) => ['Fe', 'Cu', 'Au', 'Ag', 'Ni', 'Zn', 'Sn', 'Pb', 'W', 'Al', 'Ti', 'Cr', 'Mn'].includes(el))
      .reduce((sum, [, f]) => sum + f, 0) > 0.5

  let viscosity: number
  if (temperature > meltingPoint) {
    viscosity = isMetallic ? 0.004 : 0.001  // molten metal vs water-like
  } else {
    viscosity = 1e6  // solid — effectively infinite
  }

  // Surface tension: rough estimate from density
  const surfaceTension = isMetallic ? 1.0 + density * 0.00005 : 0.03 + density * 0.00003

  // Rendering: metals vs non-metals
  const metalFrac = entries
    .filter(([el]) => ['Fe', 'Cu', 'Au', 'Ag', 'Ni', 'Zn', 'Sn', 'Pb', 'W', 'Al', 'Ti', 'Cr', 'Mn', 'Mg', 'Na', 'K', 'Ca'].includes(el))
    .reduce((sum, [, f]) => sum + f, 0)

  const metalness = Math.min(1, metalFrac * 1.2)
  const F0 = metalness > 0.5 ? 0.5 + metalness * 0.4 : 0.02 + metalness * 0.1
  const IOR = metalness > 0.5 ? 1.0 : 1.33 + metalness * 0.2
  const emissive = temperature > meltingPoint && isMetallic ? 1.2 : (temperature > 500 ? 0.5 : 0.0)
  const specularPower = isMetallic ? 300 : 150
  const opacityDensity = 2.0 + density * 0.0005

  return {
    density, viscosity, surfaceTension, meltingPoint, boilingPoint,
    color, thermalConductivity: thermalCond, specificHeat,
    F0, metalness, emissive, IOR, specularPower, opacityDensity,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/composition/PropertyCalculator.ts
git commit -m "feat: add PropertyCalculator with element data and Vegard's law"
```

### Task 8: Composition Table

**Files:**
- Create: `src/composition/CompositionTable.ts`

- [ ] **Step 1: Create the composition table manager**

```typescript
// CompositionTable.ts — Manages named compositions and their GPU-side property data

import { Composition, DerivedProps, computeProperties, type ElementName } from './PropertyCalculator'

export interface NamedComposition {
  id: number
  name: string
  formula: string
  composition: Composition
  props: DerivedProps
  temperature: number
}

export class CompositionTable {
  private compositions: NamedComposition[] = []
  private gpuData = new Float32Array(256 * 4)  // vec4 per composition for GPU

  /** Add a composition. Returns its ID. */
  add(name: string, formula: string, elements: Partial<Record<ElementName, number>>, temperature = 20): number {
    // Normalize fractions to sum to 1
    const total = Object.values(elements).reduce((s, v) => s + v, 0)
    const normalized: Partial<Record<ElementName, number>> = {}
    for (const [el, frac] of Object.entries(elements)) {
      normalized[el as ElementName] = frac / total
    }

    const composition: Composition = { elements: normalized }
    const props = computeProperties(composition, temperature)
    const id = this.compositions.length

    this.compositions.push({ id, name, formula, composition, props, temperature })

    // Update GPU data
    this.gpuData[id * 4 + 0] = props.density
    this.gpuData[id * 4 + 1] = props.viscosity
    this.gpuData[id * 4 + 2] = props.surfaceTension
    this.gpuData[id * 4 + 3] = 3.0  // stiffness (MLS-MPM parameter)

    return id
  }

  /** Find composition by exact element match, or return null */
  find(elements: Partial<Record<ElementName, number>>): number | null {
    const total = Object.values(elements).reduce((s, v) => s + v, 0)
    for (const comp of this.compositions) {
      let match = true
      for (const [el, frac] of Object.entries(elements)) {
        const normalized = frac / total
        const existing = comp.composition.elements[el as ElementName] ?? 0
        if (Math.abs(existing - normalized) > 0.01) { match = false; break }
      }
      if (match) return comp.id
    }
    return null
  }

  get(id: number): NamedComposition | undefined { return this.compositions[id] }
  getAll(): NamedComposition[] { return [...this.compositions] }
  getGpuData(): Float32Array { return this.gpuData }
  get count(): number { return this.compositions.length }

  /** Create a blended composition from two existing ones */
  blend(idA: number, idB: number, ratioA: number): number {
    const compA = this.compositions[idA]
    const compB = this.compositions[idB]
    if (!compA || !compB) return idA

    const blended: Partial<Record<ElementName, number>> = {}
    const allElements = new Set([
      ...Object.keys(compA.composition.elements),
      ...Object.keys(compB.composition.elements),
    ]) as Set<ElementName>

    for (const el of allElements) {
      const fracA = compA.composition.elements[el] ?? 0
      const fracB = compB.composition.elements[el] ?? 0
      blended[el] = fracA * ratioA + fracB * (1 - ratioA)
    }

    // Check if this blend already exists
    const existing = this.find(blended)
    if (existing !== null) return existing

    const avgTemp = compA.temperature * ratioA + compB.temperature * (1 - ratioA)
    return this.add(
      `${compA.name}+${compB.name}`,
      `${compA.formula}/${compB.formula}`,
      blended,
      avgTemp,
    )
  }

  /** Add common starting materials */
  addDefaults(): void {
    this.add('Water', 'H₂O', { H: 0.111, O: 0.889 }, 20)
    this.add('Salt', 'NaCl', { Na: 0.393, Cl: 0.607 }, 20)
    this.add('Iron', 'Fe', { Fe: 1.0 }, 20)
    this.add('Copper', 'Cu', { Cu: 1.0 }, 1100)
    this.add('Mercury', 'Hg', { Pb: 1.0 }, 20)  // Using Pb as proxy (Hg not in element list)
    this.add('Olive Oil', 'C₅₅H₁₀₄O₆', { C: 0.77, H: 0.12, O: 0.11 }, 20)
    this.add('Lava', 'Basalt', { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }, 1200)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/composition/CompositionTable.ts
git commit -m "feat: add CompositionTable with blending and GPU data export"
```

### Task 9: Contact Processor

**Files:**
- Create: `src/composition/ContactProcessor.ts`

- [ ] **Step 1: Create the contact processor**

```typescript
// ContactProcessor.ts — CPU-side processing of multi-material contacts
// Handles mixing, dissolving, and phase transitions

import { CompositionTable } from './CompositionTable'

export interface ContactResult {
  particleId: number
  newCompositionId: number
}

export class ContactProcessor {
  constructor(private table: CompositionTable) {}

  /**
   * Process contact pairs from GPU readback.
   * Returns list of particles whose composition_id should change.
   */
  processContacts(
    contacts: { a: number, b: number }[],
    compositionIds: Uint32Array,
  ): ContactResult[] {
    const results: ContactResult[] = []
    const processed = new Set<number>()  // avoid processing same particle twice

    for (const { a, b } of contacts) {
      if (processed.has(a) || processed.has(b)) continue

      const compIdA = compositionIds[a]
      const compIdB = compositionIds[b]

      if (compIdA === compIdB) continue  // same material, skip

      const compA = this.table.get(compIdA)
      const compB = this.table.get(compIdB)
      if (!compA || !compB) continue

      // Simple mixing: 50/50 blend for now
      // Future: use relative velocities for mixing ratio
      const blendedId = this.table.blend(compIdA, compIdB, 0.5)

      // Only change particle A (particle B stays for symmetry)
      results.push({ particleId: a, newCompositionId: blendedId })
      processed.add(a)
    }

    return results
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/composition/ContactProcessor.ts
git commit -m "feat: add ContactProcessor for multi-material mixing"
```

---

## Phase 3: Rendering Updates

### Task 10: Modify Depth Pass for Composition ID

**Files:**
- Modify: `src/fluid-render/depthMap.wgsl`

- [ ] **Step 1: Add composition_id output to depth pass**

The depth shader needs to output the composition_id of the closest particle per pixel. Add a second render target (r32uint) storing the comp_id.

Read the current depthMap.wgsl fully, then add:
1. A second output in FragmentOutput for comp_id
2. Read composition_id from the particle struct
3. Output it alongside depth

The particle struct must match MpmGpuSimulator's layout (64 bytes):
```
pos: vec3f (0-11)
composition_id: u32 (12-15)
vel: vec3f (16-27)
temperature: f32 (28-31)
C: mat2x2f (32-47)
phase: u32 (48-51)
_pad: vec3f (52-63)
```

Key changes to depthMap.wgsl:
- Update Particle struct to match new 64-byte layout
- Add `@location(1) comp_id: u32` to FragmentOutput
- Pass composition_id through vertex→fragment
- Output comp_id in fragment shader

- [ ] **Step 2: Commit**

```bash
git add src/fluid-render/depthMap.wgsl
git commit -m "feat: output composition_id per pixel in depth pass"
```

### Task 11: Modify Composite Shader for Per-Material Properties

**Files:**
- Modify: `src/fluid-render/composite.wgsl`

- [ ] **Step 1: Add composition table lookup to composite shader**

Add a storage buffer binding for the composition property table (256 entries). Add a texture binding for the comp_id texture from the depth pass. In the fragment shader, look up the composition_id at each pixel and use its properties (color, F0, metalness, emissive, IOR) instead of the uniform values.

Key changes:
- Add `@group(1) @binding(0) var comp_id_tex: texture_2d<u32>`
- Add `@group(1) @binding(1) var<storage, read> comp_table: array<CompositionRenderProps, 256>`
- In fragment shader: `let comp_id = textureLoad(comp_id_tex, pixel, 0).r`
- Replace uniform fluid_color/F0/metalness/etc with `comp_table[comp_id].*`

- [ ] **Step 2: Commit**

```bash
git add src/fluid-render/composite.wgsl
git commit -m "feat: per-pixel material lookup in composite shader"
```

### Task 12: Update FluidRenderer for Composition Bind Group

**Files:**
- Modify: `src/fluid-render/FluidRenderer.ts`

- [ ] **Step 1: Add composition texture and buffer to FluidRenderer**

Changes to FluidRenderer.ts:
- Add `compIdTexture: GPUTexture` (r32uint, same size as depth)
- Add `compTableBuffer: GPUBuffer` (256 * 64 bytes for rendering properties)
- Create the comp_id texture as a second render target in the depth pass
- Create a new bind group layout for composite pass group(1) with comp_id_tex + comp_table
- Add `updateCompositionTable(data: Float32Array)` method
- Modify `render()` to bind the comp_id texture and comp table in the composite pass
- Accept particle buffer directly from MpmGpuSimulator (no more CPU upload)

- [ ] **Step 2: Commit**

```bash
git add src/fluid-render/FluidRenderer.ts
git commit -m "feat: add composition table bind group to FluidRenderer"
```

---

## Phase 4: UI Integration

### Task 13: Refactor FluidTest Component

**Files:**
- Modify: `src/components/FluidTest.tsx`

- [ ] **Step 1: Replace WASM sim with GPU MpmGpuSimulator**

Major refactor of FluidTest.tsx:
- Remove WASM imports (`initWasm`, `Simulation`, `MpmSimulation`)
- Import `MpmGpuSimulator` and `CompositionTable`
- In init: create `MpmGpuSimulator`, share the same GPUDevice with FluidRenderer
- In init: create `CompositionTable`, add default materials
- Replace material picker dropdown with multi-material list (checkboxes showing active materials)
- Add "spawn material" button that creates particles of the selected composition
- Animation loop: call `gpuSim.step(encoder)` then `fluidRenderer.render(encoder, gpuSim.particleBuffer, count)`
- Remove instanced mesh rendering (SSFR replaces it entirely)
- Keep: Three.js glass box, camera, OrbitControls, lighting

- [ ] **Step 2: Commit**

```bash
git add src/components/FluidTest.tsx
git commit -m "feat: replace WASM sim with GPU MpmGpuSimulator in FluidTest"
```

### Task 14: Add Material Spawner UI

**Files:**
- Modify: `src/components/FluidTest.tsx`

- [ ] **Step 1: Add material list panel and spawn controls**

Add a right-side panel showing:
- List of active compositions (name, particle count, color swatch)
- "Add Material" input (text field for material name, parsed by AI later)
- Temperature slider (global)
- Gravity slider
- Particle count display
- FPS / GPU time / contact count stats

For now, the "Add Material" uses the CompositionTable defaults. AI integration comes in Phase 5.

- [ ] **Step 2: Commit**

```bash
git add src/components/FluidTest.tsx
git commit -m "feat: add material list panel and spawn controls"
```

---

## Phase 5: AI Integration

### Task 15: Material Generator (Claude API)

**Files:**
- Create: `src/ai/MaterialGenerator.ts`

- [ ] **Step 1: Create the Claude API material generator**

```typescript
// MaterialGenerator.ts — Uses Claude API to parse natural language into compositions

import { type ElementName, ELEMENTS } from '../composition/PropertyCalculator'

interface MaterialResult {
  name: string
  formula: string
  elements: Partial<Record<ElementName, number>>
  temperature: number
  state: 'solid' | 'liquid' | 'gas'
}

const SYSTEM_PROMPT = `You are a chemistry assistant for a physics simulator. When given a material name, return its elemental composition as mass fractions.

Available elements: ${ELEMENTS.join(', ')}

Respond in JSON only, no explanation:
{"name": "...", "formula": "...", "elements": {"Fe": 0.5, "C": 0.01, ...}, "temperature": 20, "state": "solid"}

Rules:
- Mass fractions must sum to 1.0
- Only use elements from the available list
- If an element isn't in the list, use the closest available substitute
- temperature in °C (room temp for solids, above melting point for liquids)
- state: what state the material is in at the given temperature`

export class MaterialGenerator {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generate(description: string): Promise<MaterialResult | null> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: description }],
        }),
      })

      const data = await response.json()
      const text = data.content?.[0]?.text
      if (!text) return null

      const parsed = JSON.parse(text) as MaterialResult

      // Validate elements
      for (const el of Object.keys(parsed.elements)) {
        if (!ELEMENTS.includes(el as ElementName)) {
          delete parsed.elements[el as ElementName]
        }
      }

      // Normalize fractions
      const total = Object.values(parsed.elements).reduce((s, v) => s + v, 0)
      if (total <= 0) return null
      for (const el of Object.keys(parsed.elements)) {
        parsed.elements[el as ElementName]! /= total
      }

      return parsed
    } catch (e) {
      console.error('MaterialGenerator error:', e)
      return null
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ai/MaterialGenerator.ts
git commit -m "feat: add MaterialGenerator with Claude API integration"
```

### Task 16: AI Chat Panel Component

**Files:**
- Create: `src/components/AIChatPanel.tsx`

- [ ] **Step 1: Create the chat panel component**

```tsx
// AIChatPanel.tsx — Chat interface for AI material generation + auto-experiment

import { useState, useRef, useCallback } from 'react'

interface ChatMessage {
  role: 'user' | 'ai' | 'system'
  text: string
  timestamp: number
}

interface AIChatPanelProps {
  onSpawnMaterial: (description: string) => Promise<string>  // returns status message
  onSetTemperature: (temp: number) => void
  autoExperimentActive: boolean
  onToggleAutoExperiment: () => void
}

export function AIChatPanel({ onSpawnMaterial, onSetTemperature, autoExperimentActive, onToggleAutoExperiment }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const addMessage = useCallback((role: ChatMessage['role'], text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: Date.now() }])
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
  }, [])

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return
    const text = input.trim()
    setInput('')
    addMessage('user', text)

    // Check for temperature commands
    const tempMatch = text.match(/(?:set |change )?temp(?:erature)?\s*(?:to\s*)?(\d+)/i)
    if (tempMatch) {
      const temp = parseInt(tempMatch[1])
      onSetTemperature(temp)
      addMessage('system', `Temperature set to ${temp}°C`)
      return
    }

    // Otherwise treat as material spawn
    setLoading(true)
    try {
      const result = await onSpawnMaterial(text)
      addMessage('ai', result)
    } catch (e) {
      addMessage('system', `Error: ${e}`)
    }
    setLoading(false)
  }, [input, loading, addMessage, onSpawnMaterial, onSetTemperature])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel, #1a1a2e)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', fontSize: 12, fontWeight: 600, color: '#8af' }}>
        AI CHAT
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 8, fontSize: 13 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{
            padding: '4px 8px', marginBottom: 4, borderRadius: 4,
            background: msg.role === 'user' ? '#2a2a4a' : msg.role === 'ai' ? '#1a3a2a' : '#3a2a1a',
            color: msg.role === 'system' ? '#fa8' : '#ccc',
          }}>
            <span style={{ fontWeight: 600, fontSize: 11, color: msg.role === 'user' ? '#8af' : msg.role === 'ai' ? '#8fa' : '#fa8' }}>
              {msg.role === 'user' ? 'You' : msg.role === 'ai' ? 'AI' : 'System'}:
            </span>{' '}
            {msg.text}
          </div>
        ))}
        {loading && <div style={{ color: '#666', fontSize: 12 }}>AI thinking...</div>}
      </div>
      <div style={{ padding: 8, borderTop: '1px solid #333', display: 'flex', gap: 4 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="add salt..."
          style={{ flex: 1, background: '#222', border: '1px solid #444', borderRadius: 4, padding: '4px 8px', color: '#ccc', fontSize: 13 }}
        />
        <button onClick={handleSend} disabled={loading} style={{ background: '#335', border: 'none', borderRadius: 4, padding: '4px 12px', color: '#8af', cursor: 'pointer' }}>
          Send
        </button>
      </div>
      <button
        onClick={onToggleAutoExperiment}
        style={{
          margin: 8, padding: '6px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12,
          background: autoExperimentActive ? '#a33' : '#335',
          color: autoExperimentActive ? '#fcc' : '#8af',
        }}
      >
        Auto-experiment: {autoExperimentActive ? 'ON (click to stop)' : 'OFF'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AIChatPanel.tsx
git commit -m "feat: add AIChatPanel component with chat UI + auto-experiment toggle"
```

### Task 17: Auto-Experimenter

**Files:**
- Create: `src/ai/AutoExperimenter.ts`

- [ ] **Step 1: Create the auto-experiment loop**

```typescript
// AutoExperimenter.ts — AI-driven autonomous experiment loop

import { MaterialGenerator } from './MaterialGenerator'

const EXPERIMENT_IDEAS = [
  'add salt to the water',
  'add iron filings',
  'heat the water to 100 degrees',
  'add olive oil to see if it floats',
  'add mercury — does it sink?',
  'pour molten copper into water',
  'add sand (silicon dioxide)',
  'add calcium carbonate (limestone)',
  'mix iron and carbon to make steel',
  'add sulfur',
  'add charcoal',
  'pour lava into water',
]

export class AutoExperimenter {
  private running = false
  private experimentIndex = 0
  private generator: MaterialGenerator
  private onExperiment: (description: string) => Promise<string>
  private onLog: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    generator: MaterialGenerator,
    onExperiment: (description: string) => Promise<string>,
    onLog: (message: string) => void,
  ) {
    this.generator = generator
    this.onExperiment = onExperiment
    this.onLog = onLog
  }

  start() {
    this.running = true
    this.onLog('Auto-experiment started. Running experiments...')
    this.runNext()
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.onLog('Auto-experiment stopped.')
  }

  get isRunning(): boolean { return this.running }

  private async runNext() {
    if (!this.running) return

    const idea = EXPERIMENT_IDEAS[this.experimentIndex % EXPERIMENT_IDEAS.length]
    this.experimentIndex++

    this.onLog(`Experiment ${this.experimentIndex}: "${idea}"`)

    try {
      const result = await this.onExperiment(idea)
      this.onLog(`Result: ${result}`)
    } catch (e) {
      this.onLog(`Error: ${e}`)
    }

    // Wait 5 seconds between experiments
    if (this.running) {
      this.timer = setTimeout(() => this.runNext(), 5000)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ai/AutoExperimenter.ts
git commit -m "feat: add AutoExperimenter for autonomous AI experiment loop"
```

### Task 18: Wire Everything Together in FluidTest

**Files:**
- Modify: `src/components/FluidTest.tsx`

- [ ] **Step 1: Integrate AI chat panel and auto-experimenter**

Final integration in FluidTest.tsx:
- Import `AIChatPanel`, `MaterialGenerator`, `AutoExperimenter`
- Add API key input (stored in localStorage)
- Create `MaterialGenerator` instance
- Wire `onSpawnMaterial` callback: AI generates composition → add to CompositionTable → spawn particles
- Wire `onToggleAutoExperiment` callback: start/stop AutoExperimenter
- Layout: fluid viewport on left (70%), controls + AI chat on right (30%)
- Process contacts every 10 frames: read back from GPU → ContactProcessor → update composition_ids

- [ ] **Step 2: Commit**

```bash
git add src/components/FluidTest.tsx
git commit -m "feat: integrate AI chat, material spawning, and auto-experiment in FluidTest"
```

---

## Build & Test Sequence

The implementation order matters because of dependencies:

```
Phase 1: Tasks 1-6 (GPU sim)
  → Verify: particles fall under gravity, bounce off walls
  → Test: spawn 20,000 water particles, confirm 60fps

Phase 2: Tasks 7-9 (composition system)
  → Verify: computeProperties returns sane values for water, iron, salt
  → Test: CompositionTable.blend creates valid mixed compositions

Phase 3: Tasks 10-12 (rendering)
  → Verify: multi-material particles render with correct colors
  → Test: spawn water (blue) and iron (gray) simultaneously

Phase 4: Tasks 13-14 (UI refactor)
  → Verify: full pipeline works end-to-end
  → Test: spawn two materials, they flow independently with correct visuals

Phase 5: Tasks 15-18 (AI)
  → Verify: "add salt" creates NaCl particles
  → Test: auto-experiment runs 5 experiments without crashing
```

Each phase produces a working, visually verifiable state. Phase 1 alone gives you a 20k-particle fluid sim at 60fps. Each subsequent phase adds a layer.
