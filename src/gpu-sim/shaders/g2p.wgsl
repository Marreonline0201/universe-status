// g2p.wgsl — Grid-to-Particle gather (MLS-MPM).
// Each particle gathers velocity from its 3x3x3 grid neighborhood,
// updates its velocity and position, and enforces domain boundaries.
//
// Grid is stored as array<atomic<i32>> with 4 slots per cell:
//   [4*cellIdx + 0] = momentum_x
//   [4*cellIdx + 1] = momentum_y
//   [4*cellIdx + 2] = momentum_z
//   [4*cellIdx + 3] = mass
//
// Since g2p is a read-only pass on the grid (no concurrent writes),
// we use atomicLoad to read the values.

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const DX: f32          = 1.0 / 64.0;
const INV_DX: f32      = 64.0;
const INV_FIXED: f32   = 1e-7;           // fixed-point → float
const MARGIN: f32      = 3.0 / 64.0;     // 3 * DX clamp margin

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

// ── Particle layout (64 bytes) ───────────────────────────────────────────────
struct Particle {
    pos:             vec3<f32>,
    composition_id:  u32,
    vel:             vec3<f32>,
    temperature:     f32,
    C0:              vec2<f32>,
    C1:              vec2<f32>,
    phase:           u32,
    _pad:            vec3<f32>,
};

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read>       grid:      array<i32>;
@group(0) @binding(2) var<uniform>             params:    SimParams;

// ── Quadratic B-spline weight (1D) — must match p2g.wgsl exactly ─────────
fn bspline_weight(x: f32) -> f32 {
    let ax = abs(x);
    if (ax < 0.5) {
        return 0.75 - ax * ax;
    } else if (ax < 1.5) {
        let t = 1.5 - ax;
        return 0.5 * t * t;
    }
    return 0.0;
}

// ── Grid cell index ──────────────────────────────────────────────────────────
fn grid_cell_index(xi: u32, yi: u32, zi: u32) -> u32 {
    return xi + yi * GRID_RES + zi * GRID_RES * GRID_RES;
}

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let pid = id.x;
    if (pid >= params.num_particles) { return; }

    var p = particles[pid];

    // Position in grid-space
    let pos_grid = p.pos * INV_DX;
    let base = vec3<i32>(floor(pos_grid - 0.5));

    // Accumulated velocity and affine matrix
    var new_vel = vec3<f32>(0.0, 0.0, 0.0);
    var new_C0 = vec2<f32>(0.0, 0.0);
    var new_C1 = vec2<f32>(0.0, 0.0);

    // Gather from 3x3x3 neighborhood
    for (var di: i32 = 0; di < 3; di++) {
        for (var dj: i32 = 0; dj < 3; dj++) {
            for (var dk: i32 = 0; dk < 3; dk++) {
                let cell = base + vec3<i32>(di, dj, dk);

                // Bounds check
                if (cell.x < 0 || cell.x >= i32(GRID_RES) ||
                    cell.y < 0 || cell.y >= i32(GRID_RES) ||
                    cell.z < 0 || cell.z >= i32(GRID_RES)) {
                    continue;
                }

                let diff = pos_grid - vec3<f32>(f32(cell.x), f32(cell.y), f32(cell.z));

                let w = bspline_weight(diff.x)
                      * bspline_weight(diff.y)
                      * bspline_weight(diff.z);

                if (w <= 0.0) { continue; }

                // Read grid cell (4 consecutive i32 slots)
                let base_slot = grid_cell_index(u32(cell.x), u32(cell.y), u32(cell.z)) * 4u;
                let mx_fixed   = grid[base_slot + 0u];
                let my_fixed   = grid[base_slot + 1u];
                let mz_fixed   = grid[base_slot + 2u];
                let mass_fixed = grid[base_slot + 3u];

                // Skip empty cells
                if (mass_fixed == 0) { continue; }

                let inv_mass = 1.0 / (f32(mass_fixed) * INV_FIXED);
                let cell_vel = vec3<f32>(
                    f32(mx_fixed) * INV_FIXED * inv_mass,
                    f32(my_fixed) * INV_FIXED * inv_mass,
                    f32(mz_fixed) * INV_FIXED * inv_mass,
                );

                // Weighted velocity gather
                new_vel += w * cell_vel;

                // APIC affine matrix update (2D x-y plane)
                let dx_world = (vec3<f32>(f32(cell.x), f32(cell.y), f32(cell.z)) * DX) - p.pos;
                let weight_times_4_inv_dx2 = w * 4.0 * INV_DX * INV_DX;
                new_C0 += vec2<f32>(cell_vel.x * dx_world.x, cell_vel.x * dx_world.y) * weight_times_4_inv_dx2;
                new_C1 += vec2<f32>(cell_vel.y * dx_world.x, cell_vel.y * dx_world.y) * weight_times_4_inv_dx2;
            }
        }
    }

    // ── Update velocity ──────────────────────────────────────────────────
    p.vel = new_vel;
    p.C0 = new_C0;
    p.C1 = new_C1;

    // ── Advect position ──────────────────────────────────────────────────
    p.pos += p.vel * params.dt;

    // ── Clamp to domain with margin ──────────────────────────────────────
    let lo = MARGIN;
    let hi = 1.0 - MARGIN;

    if (p.pos.x < lo) { p.pos.x = lo; p.vel.x = 0.0; }
    if (p.pos.x > hi) { p.pos.x = hi; p.vel.x = 0.0; }
    if (p.pos.y < lo) { p.pos.y = lo; p.vel.y = 0.0; }
    if (p.pos.y > hi) { p.pos.y = hi; p.vel.y = 0.0; }
    if (p.pos.z < lo) { p.pos.z = lo; p.vel.z = 0.0; }
    if (p.pos.z > hi) { p.pos.z = hi; p.vel.z = 0.0; }

    // ── Write back ───────────────────────────────────────────────────────
    particles[pid] = p;
}
