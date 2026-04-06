# Hybrid Fluid Simulator with AI Interaction

**Date:** 2026-04-06
**Status:** Approved
**Repo:** universe-status

## Purpose

Rebuild the fluid test page into a hybrid GPU/CPU fluid simulator where:
- GPU compute shaders handle fluid dynamics (MLS-MPM, 20k-40k particles)
- CPU handles material composition, mixing, reactions, and phase transitions
- AI (Claude API) generates materials from natural language and runs autonomous experiments
- Multiple materials coexist simultaneously, each with full element composition
- Results are visible in real-time via the existing SSFR rendering pipeline

This is a prototype for the game's fluid system (structure.md 3.2). The physics must be real enough that discoveries are emergent, not scripted.

## Architecture

```
+-----------------------------------------------------------+
|                      TEST PAGE                             |
|                                                            |
|  +------------------------+  +---------------------------+ |
|  |                        |  |  AI Chat Panel            | |
|  |   Fluid Viewport       |  |  - User commands          | |
|  |   (Three.js + SSFR)    |  |  - AI observations        | |
|  |                        |  |  - Auto-experiment toggle  | |
|  |   WebGPU canvas        |  |  - Material list           | |
|  |   overlay              |  |  - Temperature control     | |
|  |                        |  |                            | |
|  +------------------------+  +---------------------------+ |
+-----------------------------------------------------------+
```

### Simulation Pipeline (per frame)

```
GPU Compute (every frame, all particles in parallel):
  1. Clear 64^3 grid
  2. P2G-1: scatter particle mass + velocity to grid (fixed-point atomics)
  3. P2G-2: apply pressure + viscosity forces on grid
  4. Grid Update: gravity, boundary conditions
  5. G2P: gather velocities back to particles, update positions
  6. Copy positions to render buffer

CPU Material Worker (async, triggered by contact events):
  1. Read back contact pairs from GPU (particles of different composition_id near each other)
  2. For each contact pair:
     a. Check mixing rules: composition interpolation (dissolving, blending)
     b. Check reactions: dG = dH - T*dS from element properties
     c. Check phase transitions: temperature vs melting/boiling point
  3. Create new composition entries if mixtures form
  4. Update particle composition_ids on GPU
  5. Recompute derived properties (viscosity, density, color) for changed compositions
  6. Push updated property buffers to GPU

GPU Rendering (SSFR, existing 5-pass pipeline):
  1. Depth map: particle spheres -> view-space depth
  2. Bilateral blur: smooth depth preserving edges (2 iterations)
  3. Thickness map: additive particle thickness
  4. Gaussian blur: smooth thickness
  5. Composite: Fresnel, refraction, Beer's law, specular, emissive
     - Per-particle material properties from composition table
```

## Particle Data Model

### GPU-Side (per particle, updated every frame)

```
struct Particle {
    // MLS-MPM dynamics (updated by compute shaders)
    pos: vec3<f32>,           // world position (12 bytes)
    velocity: vec3<f32>,      // velocity (12 bytes)
    C: mat2x2<f32>,           // affine velocity field (16 bytes) — MLS-MPM deformation

    // Material (updated by CPU only when composition changes)
    composition_id: u32,      // index into composition table (4 bytes)
    temperature: f32,         // degrees C (4 bytes)
    phase: u32,               // 0=solid, 1=liquid, 2=gas (4 bytes)
    _pad: f32,                // alignment (4 bytes)
}
// Total: 56 bytes per particle
// At 40,000 particles: 2.24 MB
```

### GPU-Side (composition property table, small, rarely updated)

```
struct CompositionProps {
    color: vec3<f32>,          // RGB for rendering
    density: f32,              // kg/m^3 — affects pressure
    viscosity: f32,            // Pa*s — affects flow resistance
    surface_tension: f32,      // N/m — affects droplet formation
    melting_point: f32,        // degrees C
    boiling_point: f32,        // degrees C
    F0: f32,                   // Fresnel reflectance at normal
    metalness: f32,            // 0-1
    emissive: f32,             // glow intensity
    IOR: f32,                  // index of refraction
    specular_power: f32,       // sharpness of highlights
    opacity_density: f32,      // Beer's law absorption rate
    _pad: vec2<f32>,           // alignment to 64 bytes
}
// Max 256 compositions (256 * 64 = 16 KB — fits in uniform buffer)
```

### CPU-Side (composition table, full detail)

```typescript
interface Composition {
    id: number
    name: string                        // "water", "NaCl", "Cu0.88Sn0.12"
    elements: Record<string, number>    // { Na: 0.393, Cl: 0.607 }
    derivedProps: CompositionProps       // the 14 GPU-side properties
    fullProps: MaterialPacket            // all 51 properties from structure.md
}
```

The `composition_id` indirection is critical: instead of storing 25 element fractions per particle on GPU (25 * 4 = 100 bytes * 40,000 = 4 MB of rarely-changing data), we store a single u32 that indexes into a small table. When particles mix, the CPU creates a new table entry.

## GPU Compute Shaders (MLS-MPM)

Based on WebGPU-Ocean's implementation, adapted for multi-material:

### Pass 1: Clear Grid
```
@compute @workgroup_size(256)
fn clearGrid(@builtin(global_invocation_id) id: vec3<u32>) {
    grid[id.x] = GridCell(0, 0, 0, 0);  // velocity.xyz + mass, all zero
}
```
Grid: 64^3 = 262,144 cells * 16 bytes = 4 MB

### Pass 2: P2G-1 (Particle to Grid — mass + momentum)

For each particle, scatter to 3^3 = 27 neighboring grid cells using quadratic B-spline weights. Uses fixed-point atomics: `atomicAdd(grid[cell].mass_fixed, i32(mass * weight * 1e7))`.

Each particle's viscosity (from composition table) affects the stress tensor in P2G-2.

### Pass 3: P2G-2 (Grid forces)

Apply material stiffness and viscosity. The viscosity per grid cell is the mass-weighted average of contributing particles' viscosities. This is where multi-material physics happens on GPU: honey cells resist flow more than water cells.

### Pass 4: Grid Update

Apply gravity, enforce boundary conditions (glass box walls). Boundary damping in a 2-cell band near walls.

### Pass 5: G2P (Grid to Particle)

Gather velocities from 27 grid cells back to each particle. Build affine velocity matrix C. Update positions. Enforce wall collisions.

### Pass 6: Contact Detection

A GPU compute pass that checks each particle's neighbors. If any neighbor has a different `composition_id`, write the pair to a contact buffer (append buffer with atomic counter). This buffer is read back by CPU for material processing.

Contact buffer: `storage buffer, max 10,000 contacts per frame * 8 bytes = 80 KB`

### Pass 7: Copy Positions

Copy particle positions to the render buffer used by SSFR.

### Simulation Parameters

- Grid: 64^3
- Particles: 20,000-40,000
- Timestep: 0.2 (MLS-MPM units)
- Substeps per frame: 2
- Gravity: configurable (default -9.81 in sim units)
- Workgroup size: 256 for particle passes, 64 for grid passes

## CPU Material Worker

Runs asynchronously, triggered when the contact buffer has entries.

### Contact Processing

```typescript
async function processContacts(contacts: ContactPair[]) {
    for (const { particleA, particleB } of contacts) {
        const compA = compositions[particles[particleA].composition_id]
        const compB = compositions[particles[particleB].composition_id]

        if (compA.id === compB.id) continue  // same material, skip

        // 1. Mixing: interpolate compositions based on contact ratio
        const mixRatio = computeMixRatio(particleA, particleB)  // from relative velocities
        const newElements = blendElements(compA.elements, compB.elements, mixRatio)

        // 2. Check if this blend already exists in the table
        const existingId = findComposition(newElements)
        if (existingId !== null) {
            particles[particleA].composition_id = existingId
        } else {
            // 3. New composition: compute all 51 properties from structure.md formulas
            const newComp = propertyCalculator(newElements, particles[particleA].temperature)
            const newId = addComposition(newComp)
            particles[particleA].composition_id = newId
        }

        // 4. Check reactions: dG = dH - T*dS
        const reaction = checkReaction(compA, compB, particles[particleA].temperature)
        if (reaction && reaction.deltaG < 0) {
            applyReaction(particleA, particleB, reaction)
        }

        // 5. Check phase transitions
        checkPhaseTransition(particleA)
    }

    // Push updated composition_ids and property table to GPU
    updateGPUBuffers()
}
```

### Property Calculator

Implements structure.md 3.1 formulas to compute derived properties from element composition:
- Density: Vegard's law (linear interpolation of component densities)
- Viscosity: Arrhenius mixing rule
- Melting/boiling point: CALPHAD-simplified (weighted by mole fractions)
- Color: Drude model for metals, band gap for non-metals
- Surface tension: Eotvos rule with defined k, Tc, V
- Thermal conductivity: Wiedemann-Franz for metals

This is the same property calculator described in structure.md 3.1 but implemented in TypeScript for the test page. In the full game it would be Rust on the server.

## AI Integration

### Chat Panel

A React component with text input, connected to Claude API via a server function or direct API call.

**System prompt includes:**
- structure.md 3.1 element table (25 elements with base properties)
- List of currently active compositions in the sim
- Current sim state (particle counts per material, temperature range)

**AI capabilities:**
- Parse natural language to material: "add salt" -> `{ formula: "NaCl", elements: { Na: 0.393, Cl: 0.607 }, state: "solid", temperature: 20 }`
- Spawn particles at specified location with specified composition
- Adjust temperature of a region
- Describe what it observes in the sim state
- Answer questions about why something happened

### Auto-Experiment Mode

When toggled on, AI runs a loop:

```
1. Read current sim state (what materials exist, their states, temperatures)
2. Generate a hypothesis ("what happens if I add iron to this acid solution?")
3. Execute: spawn particles, adjust temperature, wait
4. Observe: read particle states after N seconds
5. Interpret: "the iron dissolved, density increased, pH decreased"
6. Log the experiment and result
7. Pick next experiment based on what was learned
8. Repeat
```

The AI picks experiments that explore the material system systematically — starting with simple mixing (water + salt), then reactions (acid + metal), then phase transitions (heat water past 100C), then complex chains.

A "pause" button stops the loop. A speed slider controls how long the AI waits between experiments.

## Rendering Changes

The existing SSFR pipeline is kept with these modifications:

### Composite Shader Changes

Currently: uniform fluid color, density, F0, metalness, emissive, IOR per draw call (one material at a time).

New: per-particle lookup into composition property table.

```wgsl
// In composite.wgsl:
@group(1) @binding(0) var<storage, read> comp_table: array<CompositionProps, 256>;
@group(1) @binding(1) var<storage, read> particle_comp_ids: array<u32>;

// In fragment shader, after reconstructing position from depth:
// Find nearest particle's composition_id (stored in a per-pixel buffer from depth pass)
let comp = comp_table[comp_id];
let fluid_color = comp.color;
let density = comp.opacity_density;
let F0 = comp.F0;
// ... use per-pixel material properties instead of uniforms
```

### Depth Pass Changes

Store `composition_id` alongside depth so the composite pass knows which material is at each pixel.

Add a second render target (r32uint) to the depth pass that stores the composition_id of the closest particle per pixel.

### Thickness Pass Changes

Thickness remains additive across all materials (physically correct — overlapping water and oil both contribute to thickness).

## Page Layout

```
+------------------------------------------------------------------+
| FLUID SIMULATOR                              [SPH|MPM] [?] [X]  |
+------------------------------------------------------------------+
|                                    |                              |
|                                    |  MATERIALS IN SIM            |
|                                    |  [*] Water (12,000 ptcls)   |
|                                    |  [*] NaCl  (3,000 ptcls)    |
|        3D Fluid Viewport           |  [ ] + Add material...      |
|        (Three.js + SSFR overlay)   |                              |
|                                    |  CONTROLS                    |
|                                    |  Temp: [----o--------] 25C  |
|                                    |  Gravity: [------o---] 9.8  |
|                                    |  Particles: 15,000          |
|                                    |                              |
+------------------------------------+  AI CHAT                     |
|  FPS: 60 | Particles: 15,000      |  > add salt to the water     |
|  GPU: 4.2ms | CPU: 0.8ms          |  AI: Spawning NaCl (Na 39%,  |
|  Compositions: 3 | Contacts: 42   |  Cl 61%) as 3000 solid       |
|                                    |  particles above the water.  |
|                                    |  Observing dissolution...    |
|                                    |                              |
|                                    |  [Auto-experiment: OFF]      |
|                                    |  [___________________] Send  |
+------------------------------------------------------------------+
```

## What We Keep From Current Implementation

- SSFR shader files (depthMap.wgsl, bilateral.wgsl, thicknessMap.wgsl, gaussian.wgsl, composite.wgsl) — modified for multi-material
- FluidRenderer.ts structure — add composition table bind group, modify depth pass for comp_id output
- Three.js scene setup (glass box, camera, lighting)
- WebGPU initialization and canvas overlay logic
- Material visual properties concept (Fresnel, IOR, metalness, emissive per material)

## What We Replace

- Rust/WASM SPH solver -> GPU compute shaders (MLS-MPM)
- Single-material-at-a-time -> multi-material with composition table
- Material picker dropdown -> AI-powered material spawner
- No mixing support -> CPU-side contact processing with composition blending
- Hardcoded material list -> dynamic composition table generated from element properties

## What We Add

- 7 GPU compute shader passes (clear, P2G-1, P2G-2, grid update, G2P, contact detect, copy)
- CPU composition table + property calculator (structure.md 3.1 subset)
- AI chat panel (Claude API)
- Auto-experiment mode
- Per-pixel composition_id in depth pass
- Performance stats overlay (GPU time, CPU time, contact count, composition count)

## Constraints

- WebGPU required (no WebGL fallback for compute shaders)
- Particle limit: 40,000 max (GPU memory and performance budget)
- Composition table: 256 max entries (uniform buffer size)
- Contact buffer: 10,000 max contacts per frame
- AI API calls: rate limited, debounced to 1 call per 2 seconds max
- Single-user only (no multiplayer considerations for the test page)

## Success Criteria

1. 20,000+ particles at 60fps with smooth SSFR fluid surface
2. Two or more materials visible simultaneously with distinct visual properties
3. Pouring one material into another produces visible mixing (composition interpolation)
4. AI can parse "add salt" and spawn correct composition
5. Temperature changes cause visible phase transitions (water -> steam at 100C)
6. Auto-experiment mode runs at least 5 experiments without crashing
