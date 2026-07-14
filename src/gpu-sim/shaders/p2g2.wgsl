// p2g2.wgsl — Particle-to-Grid pass 2: scatter constitutive stress forces.
// Ported from WebGPU-Ocean/mls-mpm/p2g_2.wgsl
//
// After p2g (pass 1) scatters mass and momentum, this pass computes
// per-particle density from the grid, then scatters stress-derived forces
// (pressure + viscosity) back onto the grid.
//
// Key physics (from WebGPU-Ocean):
//   density = sum(weight_i * cell_mass_i) at particle location
//   pressure = stiffness * (pow(density / rest_density, 5) - 1)
//   stress = -pressure * I + dynamic_viscosity * (C + C^T)
//   force contribution = -volume * 4 * stress * dt * weight * cell_dist

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const GRID_RESf: f32   = 64.0;
const FIXED_SCALE: f32 = 1e7;
const INV_FIXED: f32   = 1e-7;

// WebGPU-Ocean exact constants
const STIFFNESS: f32         = 3.0;
const REST_DENSITY: f32      = 4.0;

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
@group(0) @binding(0) var<storage, read>       particles:  array<Particle>;
@group(0) @binding(1) var<storage, read_write> grid:       array<atomic<i32>>;
@group(0) @binding(2) var<uniform>             params:     SimParams;
@group(0) @binding(3) var<storage, read>       comp_props: array<vec4<f32>>;

// Clamp at the fixed-point encode boundary: i32() of an out-of-range f32 is
// indeterminate in WGSL (silent wrap -> sign-flipped impulse). Safe input bound is
// i32::MAX / FIXED_SCALE = 214.7483647; +/-200 sits 6.9% under it and far above the
// legitimate momentum maximum (~O(10)) — a no-op for every working scenario, a net
// for high-viscosity materials (Lava 1e8 Pa*s) and dense pile-ups.
const MAX_FIXED_INPUT: f32 = 200.0; // margin under i32::MAX / FIXED_SCALE ≈ 214.7483647
fn encodeFixedPoint(v: f32) -> i32 {
    return i32(clamp(v, -MAX_FIXED_INPUT, MAX_FIXED_INPUT) * FIXED_SCALE);
}

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

    let p = particles[pid];

    // Convert [0,1] position to grid-space [0, GRID_RES)
    let position = vec3<f32>(p.pos_x, p.pos_y, p.pos_z) * GRID_RESf;

    // B-spline weights
    var weights: array<vec3<f32>, 3>;
    let cell_idx = floor(position);
    let cell_diff = position - (cell_idx + 0.5);
    weights[0] = 0.5 * (0.5 - cell_diff) * (0.5 - cell_diff);
    weights[1] = 0.75 - cell_diff * cell_diff;
    weights[2] = 0.5 * (0.5 + cell_diff) * (0.5 + cell_diff);

    // ── Compute density at particle position ─────────────────────────────
    // Gather mass from 3x3x3 neighborhood (same as WebGPU-Ocean p2g_2)
    var density: f32 = 0.0;
    for (var gx = 0; gx < 3; gx++) {
        for (var gy = 0; gy < 3; gy++) {
            for (var gz = 0; gz < 3; gz++) {
                let weight = weights[gx].x * weights[gy].y * weights[gz].z;
                let cell_x = vec3<f32>(
                    cell_idx.x + f32(gx) - 1.0,
                    cell_idx.y + f32(gy) - 1.0,
                    cell_idx.z + f32(gz) - 1.0,
                );
                let ci = grid_cell_index(i32(cell_x.x), i32(cell_x.y), i32(cell_x.z));
                let base_slot = u32(ci) * 4u;
                let cell_mass = decodeFixedPoint(atomicLoad(&grid[base_slot + 3u]));
                density += cell_mass * weight;
            }
        }
    }

    // ── Compute stress ───────────────────────────────────────────────────
    // Volume = 1/density (since particle mass = 1)
    let volume = 1.0 / density;

    // Equation of state pressure (WebGPU-Ocean exact formula)
    let pressure = max(-0.0, STIFFNESS * (pow(density / REST_DENSITY, 5.0) - 1.0));

    // Isotropic pressure stress
    var stress = mat3x3<f32>(
        -pressure, 0.0, 0.0,
        0.0, -pressure, 0.0,
        0.0, 0.0, -pressure,
    );

    // Viscous stress: dynamic_viscosity * (C + C^T)
    let C = mat3x3<f32>(
        p.C00, p.C10, p.C20,
        p.C01, p.C11, p.C21,
        p.C02, p.C12, p.C22,
    );
    let strain = C + transpose(C);
    let viscosity = comp_props[p.composition_id].y;   // per-material Pa·s (was scalar DYNAMIC_VISCOSITY)
    stress += viscosity * strain;

    // MLS-MPM equation 16 term: -volume * 4 * stress * dt
    let eq_16_term0 = -volume * 4.0 * stress * params.dt;

    // ── Scatter stress forces to grid ────────────────────────────────────
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

                let momentum = eq_16_term0 * weight * cell_dist;
                atomicAdd(&grid[base_slot + 0u], encodeFixedPoint(momentum.x));
                atomicAdd(&grid[base_slot + 1u], encodeFixedPoint(momentum.y));
                atomicAdd(&grid[base_slot + 2u], encodeFixedPoint(momentum.z));
            }
        }
    }
}
