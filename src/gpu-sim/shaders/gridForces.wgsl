// gridForces.wgsl — Apply gravity and enforce boundary conditions on the grid.
// For each cell: decode fixed-point → apply forces → re-encode.
//
// Grid is stored as array<atomic<i32>> with 4 slots per cell:
//   [4*cellIdx + 0] = momentum_x
//   [4*cellIdx + 1] = momentum_y
//   [4*cellIdx + 2] = momentum_z
//   [4*cellIdx + 3] = mass

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const NUM_CELLS: u32   = 262144u;         // 64^3
const INV_FIXED: f32   = 1e-7;           // fixed-point → float
const FIXED_SCALE: f32 = 1e7;            // float → fixed-point
const BOUNDARY: u32    = 2u;              // wall margin in cells

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

// ── Bindings ─────────────────────────────────────────────────────────────────
// Note: gridForces runs AFTER p2g and BEFORE g2p.
// No concurrent atomic writes happen during this pass, so we can use
// atomicLoad/atomicStore for read-modify-write on each cell sequentially.
@group(0) @binding(0) var<storage, read_write> grid:   array<atomic<i32>>;
@group(0) @binding(1) var<uniform>             params: SimParams;

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let cell_idx = id.x;
    if (cell_idx >= NUM_CELLS) { return; }

    let base_slot = cell_idx * 4u;

    // Load fixed-point values
    let mx_fixed = atomicLoad(&grid[base_slot + 0u]);
    let my_fixed = atomicLoad(&grid[base_slot + 1u]);
    let mz_fixed = atomicLoad(&grid[base_slot + 2u]);
    let mass_fixed = atomicLoad(&grid[base_slot + 3u]);

    // Empty cell — nothing to do
    if (mass_fixed == 0) { return; }

    let mass = f32(mass_fixed) * INV_FIXED;

    // Decode momentum → velocity
    var vel = vec3<f32>(
        f32(mx_fixed) * INV_FIXED / mass,
        f32(my_fixed) * INV_FIXED / mass,
        f32(mz_fixed) * INV_FIXED / mass,
    );

    // ── Apply gravity ────────────────────────────────────────────────────
    vel.y -= params.gravity * params.dt;

    // ── 3D cell coordinates ──────────────────────────────────────────────
    let xi = cell_idx % GRID_RES;
    let yi = (cell_idx / GRID_RES) % GRID_RES;
    let zi = cell_idx / (GRID_RES * GRID_RES);

    // ── Boundary conditions: clamp velocity near walls ───────────────────
    // X walls
    if (xi < BOUNDARY && vel.x < 0.0) { vel.x = 0.0; }
    if (xi >= GRID_RES - BOUNDARY && vel.x > 0.0) { vel.x = 0.0; }

    // Y walls (floor / ceiling)
    if (yi < BOUNDARY && vel.y < 0.0) { vel.y = 0.0; }
    if (yi >= GRID_RES - BOUNDARY && vel.y > 0.0) { vel.y = 0.0; }

    // Z walls
    if (zi < BOUNDARY && vel.z < 0.0) { vel.z = 0.0; }
    if (zi >= GRID_RES - BOUNDARY && vel.z > 0.0) { vel.z = 0.0; }

    // ── Re-encode as momentum (fixed-point) ──────────────────────────────
    let momentum = vel * mass;
    atomicStore(&grid[base_slot + 0u], i32(momentum.x * FIXED_SCALE));
    atomicStore(&grid[base_slot + 1u], i32(momentum.y * FIXED_SCALE));
    atomicStore(&grid[base_slot + 2u], i32(momentum.z * FIXED_SCALE));
    // mass unchanged — no need to re-store
}
