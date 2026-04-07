// gridForces.wgsl — Grid update: decode momentum→velocity, apply gravity, boundary conditions.
// Ported from WebGPU-Ocean/mls-mpm/updateGrid.wgsl
//
// After P2G passes scatter mass+momentum+stress, this pass:
//   1. Divides accumulated momentum by mass → velocity
//   2. Applies gravity
//   3. Enforces boundary conditions (zero velocity near walls)
//   4. Re-encodes velocity as fixed-point
//
// IMPORTANT: After this pass, grid stores VELOCITY (not momentum).
// This matches WebGPU-Ocean's approach where G2P reads velocity directly.

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const NUM_CELLS: u32   = 262144u;         // 64^3
const FIXED_SCALE: f32 = 1e7;
const INV_FIXED: f32   = 1e-7;
const BOUNDARY: u32    = 2u;              // wall margin in cells

// Gravity in grid-space units (WebGPU-Ocean uses -0.3)
const GRAVITY: f32     = -0.3;

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

struct SphereObstacle {
    center:   vec3<f32>,
    radius:   f32,
    velocity: vec3<f32>,
    active:   u32,       // 0 = no sphere, 1 = sphere present
};

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read_write> grid:   array<atomic<i32>>;
@group(0) @binding(1) var<uniform>             params: SimParams;
@group(0) @binding(2) var<uniform>             sphere: SphereObstacle;

fn encodeFixedPoint(v: f32) -> i32 {
    return i32(v * FIXED_SCALE);
}

fn decodeFixedPoint(v: i32) -> f32 {
    return f32(v) * INV_FIXED;
}

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let cell_idx = id.x;
    if (cell_idx >= NUM_CELLS) { return; }

    let base_slot = cell_idx * 4u;

    // Load fixed-point values
    let mass_fixed = atomicLoad(&grid[base_slot + 3u]);

    // Empty cell — skip (comparison with 0 is fine for fixed-point)
    if (mass_fixed <= 0) { return; }

    let mass = decodeFixedPoint(mass_fixed);

    // Decode momentum → velocity (divide by mass)
    var vel = vec3<f32>(
        decodeFixedPoint(atomicLoad(&grid[base_slot + 0u])) / mass,
        decodeFixedPoint(atomicLoad(&grid[base_slot + 1u])) / mass,
        decodeFixedPoint(atomicLoad(&grid[base_slot + 2u])) / mass,
    );

    // ── Apply gravity (WebGPU-Ocean: vel.y += -0.3 * dt) ────────────────
    vel.y += GRAVITY * params.dt;

    // ── 3D cell coordinates ──────────────────────────────────────────────
    // Grid indexing: cell_idx = x * Ny * Nz + y * Nz + z
    let x = cell_idx / (GRID_RES * GRID_RES);
    let y = (cell_idx / GRID_RES) % GRID_RES;
    let z = cell_idx % GRID_RES;

    // ── Sphere obstacle: cells inside sphere move with sphere ────────────
    if (sphere.active > 0u) {
        // Cell center in MLS-MPM normalized coords [0,1]
        let cell_pos = (vec3<f32>(f32(x), f32(y), f32(z)) + 0.5) / f32(GRID_RES);
        let dist = length(cell_pos - sphere.center);
        if (dist < sphere.radius) {
            vel = sphere.velocity;
        }
    }

    // ── Boundary conditions: zero velocity near walls ────────────────────
    // (WebGPU-Ocean uses < 2 and > ceil(boxSize) - 3)
    if (x < BOUNDARY || x >= GRID_RES - BOUNDARY) { vel.x = 0.0; }
    if (y < BOUNDARY || y >= GRID_RES - BOUNDARY) { vel.y = 0.0; }
    if (z < BOUNDARY || z >= GRID_RES - BOUNDARY) { vel.z = 0.0; }

    // ── Store velocity (NOT momentum) as fixed-point ─────────────────────
    // This is the key difference from our old code: grid now stores velocity.
    atomicStore(&grid[base_slot + 0u], encodeFixedPoint(vel.x));
    atomicStore(&grid[base_slot + 1u], encodeFixedPoint(vel.y));
    atomicStore(&grid[base_slot + 2u], encodeFixedPoint(vel.z));
    // mass unchanged
}
