// clearGrid.wgsl — Reset all grid cells to zero before each simulation step.
// Grid: 64^3 = 262,144 cells, 4 i32 slots each = 1,048,576 atomic<i32> entries.
// Layout per cell: [momentum_x, momentum_y, momentum_z, mass] as fixed-point integers.
//
// We use array<atomic<i32>> because WebGPU only supports atomicAdd on scalar
// atomic types — not on vec4<i32> members.

const NUM_SLOTS: u32 = 1048576u; // 64 * 64 * 64 * 4

@group(0) @binding(0) var<storage, read_write> grid: array<atomic<i32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= NUM_SLOTS) { return; }
    atomicStore(&grid[idx], 0);
}
