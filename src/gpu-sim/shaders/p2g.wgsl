// p2g.wgsl — Particle-to-Grid pass 1: scatter mass and APIC momentum.
// Ported from WebGPU-Ocean/mls-mpm/p2g_1.wgsl
//
// Grid layout: array<atomic<i32>> with 4 slots per cell:
//   [4*cellIdx + 0] = momentum_x  (fixed-point)
//   [4*cellIdx + 1] = momentum_y  (fixed-point)
//   [4*cellIdx + 2] = momentum_z  (fixed-point)
//   [4*cellIdx + 3] = mass        (fixed-point)
//
// Positions are stored in [0,1] world space. We convert to grid-space
// (0..GRID_RES) internally so the B-spline math matches WebGPU-Ocean exactly.

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const GRID_RESf: f32   = 64.0;
const FIXED_SCALE: f32 = 1e7;

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

// ── Particle layout (80 bytes) ───────────────────────────────────────────────
struct Particle {
    pos_x: f32, pos_y: f32, pos_z: f32,   // bytes  0-11
    composition_id:  u32,                   // bytes 12-15
    vel_x: f32, vel_y: f32, vel_z: f32,   // bytes 16-27
    temperature:     f32,                   // bytes 28-31
    // C matrix (3x3 affine velocity field) stored as 9 scalars, row-major:
    // C = [[C00,C01,C02],[C10,C11,C12],[C20,C21,C22]]
    C00: f32, C01: f32, C02: f32,          // bytes 32-43
    C10: f32, C11: f32, C12: f32,          // bytes 44-55
    C20: f32, C21: f32, C22: f32,          // bytes 56-67
    phase:           u32,                   // bytes 68-71
    _pad0: u32, _pad1: u32,               // bytes 72-79
};

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read>       particles:  array<Particle>;
@group(0) @binding(1) var<storage, read_write> grid:       array<atomic<i32>>;
@group(0) @binding(2) var<uniform>             params:     SimParams;

fn encodeFixedPoint(v: f32) -> i32 {
    return i32(v * FIXED_SCALE);
}

fn grid_cell_index(ix: i32, iy: i32, iz: i32) -> i32 {
    // Row-major: x * Ny * Nz + y * Nz + z (matching WebGPU-Ocean)
    return ix * i32(GRID_RES) * i32(GRID_RES) + iy * i32(GRID_RES) + iz;
}

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let pid = id.x;
    if (pid >= params.num_particles) { return; }

    let p = particles[pid];

    // Convert [0,1] position to grid-space [0, GRID_RES)
    let position = vec3<f32>(p.pos_x, p.pos_y, p.pos_z) * GRID_RESf;

    // Velocity also needs to be in grid-space units (grid_vel = world_vel * GRID_RES)
    let velocity = vec3<f32>(p.vel_x, p.vel_y, p.vel_z) * GRID_RESf;

    // Reconstruct C matrix (already in grid-space units from G2P)
    let C = mat3x3<f32>(
        p.C00, p.C10, p.C20,   // column 0
        p.C01, p.C11, p.C21,   // column 1
        p.C02, p.C12, p.C22,   // column 2
    );

    // B-spline weights (quadratic, matches WebGPU-Ocean exactly)
    var weights: array<vec3<f32>, 3>;
    let cell_idx = floor(position);
    let cell_diff = position - (cell_idx + 0.5);
    weights[0] = 0.5 * (0.5 - cell_diff) * (0.5 - cell_diff);
    weights[1] = 0.75 - cell_diff * cell_diff;
    weights[2] = 0.5 * (0.5 + cell_diff) * (0.5 + cell_diff);

    // Scatter mass and momentum to 3x3x3 neighborhood
    for (var gx = 0; gx < 3; gx++) {
        for (var gy = 0; gy < 3; gy++) {
            for (var gz = 0; gz < 3; gz++) {
                let weight = weights[gx].x * weights[gy].y * weights[gz].z;

                let cell_x = vec3<f32>(
                    cell_idx.x + f32(gx) - 1.0,
                    cell_idx.y + f32(gy) - 1.0,
                    cell_idx.z + f32(gz) - 1.0,
                );
                let cell_dist = (cell_x + 0.5) - position;

                // APIC affine velocity contribution: Q = C * cell_dist
                let Q = C * cell_dist;

                // Mass contribution (particle mass = 1.0, matching WebGPU-Ocean)
                let mass_contrib = weight * 1.0;
                let vel_contrib = mass_contrib * (velocity + Q);

                let ci = grid_cell_index(i32(cell_x.x), i32(cell_x.y), i32(cell_x.z));
                let base_slot = u32(ci) * 4u;

                atomicAdd(&grid[base_slot + 0u], encodeFixedPoint(vel_contrib.x));
                atomicAdd(&grid[base_slot + 1u], encodeFixedPoint(vel_contrib.y));
                atomicAdd(&grid[base_slot + 2u], encodeFixedPoint(vel_contrib.z));
                atomicAdd(&grid[base_slot + 3u], encodeFixedPoint(mass_contrib));
            }
        }
    }
}
