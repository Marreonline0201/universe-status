// g2p.wgsl — Grid-to-Particle gather (MLS-MPM).
// Ported from WebGPU-Ocean/mls-mpm/g2p.wgsl
//
// Each particle gathers velocity from its 3x3x3 grid neighborhood,
// computes the full 3x3 APIC affine velocity matrix C,
// advects its position, and enforces domain boundaries.
//
// IMPORTANT: After gridForces (updateGrid), the grid stores VELOCITY
// (not momentum), so we read velocity directly — no division by mass needed.

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const GRID_RESf: f32   = 64.0;
const INV_GRID_RES: f32 = 1.0 / 64.0;  // DX in world space
const FIXED_SCALE: f32 = 1e7;
const INV_FIXED: f32   = 1e-7;

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

// ── Particle layout (80 bytes) ───────────────────────────────────────────────
struct Particle {
    pos_x: f32, pos_y: f32, pos_z: f32,
    composition_id:  u32,
    vel_x: f32, vel_y: f32, vel_z: f32,
    temperature:     f32,
    C00: f32, C01: f32, C02: f32,
    C10: f32, C11: f32, C12: f32,
    C20: f32, C21: f32, C22: f32,
    phase:           u32,
    _pad0: u32, _pad1: u32,
};

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read>       grid:      array<i32>;
@group(0) @binding(2) var<uniform>             params:    SimParams;

fn decodeFixedPoint(v: i32) -> f32 {
    return f32(v) * INV_FIXED;
}

fn grid_cell_index(ix: i32, iy: i32, iz: i32) -> i32 {
    return ix * i32(GRID_RES) * i32(GRID_RES) + iy * i32(GRID_RES) + iz;
}

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let pid = id.x;
    if (pid >= params.num_particles) { return; }

    var p = particles[pid];

    // Convert [0,1] position to grid-space [0, GRID_RES)
    let position = vec3<f32>(p.pos_x, p.pos_y, p.pos_z) * GRID_RESf;

    // B-spline weights (must match p2g exactly)
    var weights: array<vec3<f32>, 3>;
    let cell_idx = floor(position);
    let cell_diff = position - (cell_idx + 0.5);
    weights[0] = 0.5 * (0.5 - cell_diff) * (0.5 - cell_diff);
    weights[1] = 0.75 - cell_diff * cell_diff;
    weights[2] = 0.5 * (0.5 + cell_diff) * (0.5 + cell_diff);

    // Accumulated new velocity and B matrix for APIC
    var new_vel = vec3<f32>(0.0, 0.0, 0.0);
    var B = mat3x3<f32>(
        vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0)
    );

    // Gather from 3x3x3 neighborhood
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

                let ci = grid_cell_index(i32(cell_x.x), i32(cell_x.y), i32(cell_x.z));
                let base_slot = u32(ci) * 4u;

                // Grid stores VELOCITY after updateGrid pass (not momentum)
                let cell_vel = vec3<f32>(
                    decodeFixedPoint(grid[base_slot + 0u]),
                    decodeFixedPoint(grid[base_slot + 1u]),
                    decodeFixedPoint(grid[base_slot + 2u]),
                );

                let weighted_velocity = cell_vel * weight;

                // Accumulate B matrix: B += weighted_vel ⊗ cell_dist
                // (outer product, matching WebGPU-Ocean exactly)
                B += mat3x3<f32>(
                    weighted_velocity * cell_dist.x,
                    weighted_velocity * cell_dist.y,
                    weighted_velocity * cell_dist.z,
                );

                new_vel += weighted_velocity;
            }
        }
    }

    // APIC affine velocity matrix: C = B * 4 (WebGPU-Ocean: 4/h² where h=1 in grid units)
    let C = B * 4.0;

    // Store C matrix as 9 scalars (column-major from mat3x3 → row-major scalars)
    // mat3x3 in WGSL: columns are [col0, col1, col2], column i = C[i]
    // C[0] = first column, C[1] = second column, C[2] = third column
    p.C00 = C[0][0]; p.C01 = C[1][0]; p.C02 = C[2][0]; // row 0
    p.C10 = C[0][1]; p.C11 = C[1][1]; p.C12 = C[2][1]; // row 1
    p.C20 = C[0][2]; p.C21 = C[1][2]; p.C22 = C[2][2]; // row 2

    // ── Advect position (in grid-space) ──────────────────────────────────
    // new_vel is already in grid-space units
    var new_position = position + new_vel * params.dt;

    // ── Clamp to domain (matching WebGPU-Ocean: clamp to [1, boxSize-2]) ─
    new_position = clamp(new_position, vec3<f32>(1.0), vec3<f32>(GRID_RESf - 2.0));

    // ── Wall repulsion (matching WebGPU-Ocean g2p) ───────────────────────
    let k = 3.0;
    let wall_stiffness = 0.3;
    let x_n = new_position + new_vel * params.dt * k;
    let wall_min = vec3<f32>(3.0);
    let wall_max = vec3<f32>(GRID_RESf - 4.0);

    if (x_n.x < wall_min.x) { new_vel.x += wall_stiffness * (wall_min.x - x_n.x); }
    if (x_n.x > wall_max.x) { new_vel.x += wall_stiffness * (wall_max.x - x_n.x); }
    if (x_n.y < wall_min.y) { new_vel.y += wall_stiffness * (wall_min.y - x_n.y); }
    if (x_n.y > wall_max.y) { new_vel.y += wall_stiffness * (wall_max.y - x_n.y); }
    if (x_n.z < wall_min.z) { new_vel.z += wall_stiffness * (wall_min.z - x_n.z); }
    if (x_n.z > wall_max.z) { new_vel.z += wall_stiffness * (wall_max.z - x_n.z); }

    // ── Convert back to [0,1] world space and store ──────────────────────
    p.pos_x = new_position.x * INV_GRID_RES;
    p.pos_y = new_position.y * INV_GRID_RES;
    p.pos_z = new_position.z * INV_GRID_RES;

    // Velocity stored in world-space [0,1] units
    p.vel_x = new_vel.x * INV_GRID_RES;
    p.vel_y = new_vel.y * INV_GRID_RES;
    p.vel_z = new_vel.z * INV_GRID_RES;

    particles[pid] = p;
}
