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
const DX: f32          = 1.0 / 64.0;     // cell size
const CELL_VOLUME: f32 = DX * DX * DX;   // volume of one cell

// MLS-MPM fluid parameters (in grid units, NOT real-world units)
const REST_DENSITY: f32 = 4.0;           // target density in grid units
const STIFFNESS: f32    = 0.5;           // pressure stiffness (EOS) — tunable
const VISCOSITY_GRID: f32 = 0.1;         // grid-level viscosity damping

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

// ── Read neighbor cell mass (for pressure gradient) ─────────────────────────
fn read_cell_mass(cell_idx: u32) -> f32 {
    let mass_fixed = atomicLoad(&grid[cell_idx * 4u + 3u]);
    return f32(mass_fixed) * INV_FIXED;
}

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

    // Empty or negligible-mass cell — skip to avoid division by near-zero
    if (mass_fixed < 100) { return; }

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

    // ── Grid-density pressure gradient ──────────────────────────────────
    // Read neighbor cell masses for finite-difference pressure gradient
    let density = mass / CELL_VOLUME;

    let mass_xm = select(0.0, read_cell_mass(cell_idx - 1u), xi > 0u);
    let mass_xp = select(0.0, read_cell_mass(cell_idx + 1u), xi < GRID_RES - 1u);
    let mass_ym = select(0.0, read_cell_mass(cell_idx - GRID_RES), yi > 0u);
    let mass_yp = select(0.0, read_cell_mass(cell_idx + GRID_RES), yi < GRID_RES - 1u);
    let mass_zm = select(0.0, read_cell_mass(cell_idx - GRID_RES * GRID_RES), zi > 0u);
    let mass_zp = select(0.0, read_cell_mass(cell_idx + GRID_RES * GRID_RES), zi < GRID_RES - 1u);

    let density_xm = mass_xm / CELL_VOLUME;
    let density_xp = mass_xp / CELL_VOLUME;
    let density_ym = mass_ym / CELL_VOLUME;
    let density_yp = mass_yp / CELL_VOLUME;
    let density_zm = mass_zm / CELL_VOLUME;
    let density_zp = mass_zp / CELL_VOLUME;

    // Pressure gradient pushes velocity from high-density to low-density regions
    // Only apply pressure when local density exceeds rest density (compressed fluid).
    // Isolated low-density particles (splashes, droplets) should fall freely under
    // gravity without being pushed around by phantom pressure gradients.
    if (density > REST_DENSITY * 0.5) {
        let grad_p = vec3<f32>(
            STIFFNESS * (density_xp - density_xm) * 0.5,
            STIFFNESS * (density_yp - density_ym) * 0.5,
            STIFFNESS * (density_zp - density_zm) * 0.5,
        );

        vel -= grad_p * params.dt / max(density, REST_DENSITY * 0.1);
    }

    // ── Viscosity damping ───────────────────────────────────────────────
    vel *= 1.0 / (1.0 + VISCOSITY_GRID * params.dt);

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
