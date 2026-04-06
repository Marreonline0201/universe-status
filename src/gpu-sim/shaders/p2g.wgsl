// p2g.wgsl — Particle-to-Grid transfer (MLS-MPM).
// Scatters each particle's mass and momentum onto a 3x3x3 stencil of grid cells
// using quadratic B-spline weights and fixed-point atomicAdd.
//
// Grid is stored as array<atomic<i32>> with 4 slots per cell:
//   [4*cellIdx + 0] = momentum_x
//   [4*cellIdx + 1] = momentum_y
//   [4*cellIdx + 2] = momentum_z
//   [4*cellIdx + 3] = mass

// ── Constants ────────────────────────────────────────────────────────────────
const GRID_RES: u32    = 64u;
const DX: f32          = 1.0 / 64.0;       // cell size
const INV_DX: f32      = 64.0;             // 1 / DX
const FIXED_SCALE: f32 = 1e7;             // float → fixed-point multiplier

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

// ── Particle layout (64 bytes, 16 floats) ────────────────────────────────────
struct Particle {
    pos:             vec3<f32>,  // bytes  0-11
    composition_id:  u32,       // bytes 12-15
    vel:             vec3<f32>,  // bytes 16-27
    temperature:     f32,       // bytes 28-31
    C0:              vec2<f32>, // affine row 0 (bytes 32-39)
    C1:              vec2<f32>, // affine row 1 (bytes 40-47)
    phase:           u32,       // bytes 48-51
    _pad:            vec3<f32>, // bytes 52-63
};

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read>       particles:  array<Particle>;
@group(0) @binding(1) var<storage, read_write> grid:       array<atomic<i32>>;
@group(0) @binding(2) var<uniform>             params:     SimParams;
@group(0) @binding(3) var<storage, read>       comp_props: array<vec4<f32>>;
// comp_props[id]: x=density, y=viscosity, z=surfaceTension, w=stiffness

// ── Quadratic B-spline weight (1D) ──────────────────────────────────────────
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

// ── Grid cell index from integer coordinates ─────────────────────────────────
fn grid_cell_index(xi: u32, yi: u32, zi: u32) -> u32 {
    return xi + yi * GRID_RES + zi * GRID_RES * GRID_RES;
}

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let pid = id.x;
    if (pid >= params.num_particles) { return; }

    let p = particles[pid];
    let props = comp_props[p.composition_id];
    let density = props.x;

    // Mass per particle = density * cell_volume
    let mass = density * DX * DX * DX;

    // Position in grid-space (continuous)
    let pos_grid = p.pos * INV_DX;

    // Base cell (integer coords of the lower-left corner of the 3x3x3 stencil)
    let base = vec3<i32>(floor(pos_grid - 0.5));

    // Scatter to 3x3x3 neighborhood
    for (var di: i32 = 0; di < 3; di++) {
        for (var dj: i32 = 0; dj < 3; dj++) {
            for (var dk: i32 = 0; dk < 3; dk++) {
                let cell = base + vec3<i32>(di, dj, dk);

                // Skip out-of-bounds cells
                if (cell.x < 0 || cell.x >= i32(GRID_RES) ||
                    cell.y < 0 || cell.y >= i32(GRID_RES) ||
                    cell.z < 0 || cell.z >= i32(GRID_RES)) {
                    continue;
                }

                // Distance from particle to cell center (in grid units)
                let diff = pos_grid - vec3<f32>(f32(cell.x), f32(cell.y), f32(cell.z));

                // Trilinear B-spline weight
                let w = bspline_weight(diff.x)
                      * bspline_weight(diff.y)
                      * bspline_weight(diff.z);

                if (w <= 0.0) { continue; }

                // Weighted mass
                let wm = w * mass;

                // APIC momentum transfer: vel + C * (cell_pos - particle_pos) in world space
                let cell_world = vec3<f32>(f32(cell.x), f32(cell.y), f32(cell.z)) * DX;
                let dx_world = cell_world - p.pos;

                // Affine velocity contribution (C is 2x2 for the x-y plane, ignore z for now)
                let affine_vel = vec3<f32>(
                    p.C0.x * dx_world.x + p.C0.y * dx_world.y,
                    p.C1.x * dx_world.x + p.C1.y * dx_world.y,
                    0.0
                );

                let momentum = (p.vel + affine_vel) * wm;

                // Fixed-point encode
                let fm  = i32(wm * FIXED_SCALE);
                let fmx = i32(momentum.x * FIXED_SCALE);
                let fmy = i32(momentum.y * FIXED_SCALE);
                let fmz = i32(momentum.z * FIXED_SCALE);

                // Flat index: 4 i32 slots per cell
                let base_slot = grid_cell_index(u32(cell.x), u32(cell.y), u32(cell.z)) * 4u;

                // Atomic scatter — each component to its own slot
                atomicAdd(&grid[base_slot + 0u], fmx);
                atomicAdd(&grid[base_slot + 1u], fmy);
                atomicAdd(&grid[base_slot + 2u], fmz);
                atomicAdd(&grid[base_slot + 3u], fm);
            }
        }
    }
}
