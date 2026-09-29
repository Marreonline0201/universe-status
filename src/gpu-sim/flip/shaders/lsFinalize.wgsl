// lsFinalize.wgsl — φ at every window cell centre from the level-set sums, and the ghost-fluid labels
// (flipRef.classifyLevelSet): LIQUID where φ < 0, AIR elsewhere (ghost cells stay SOLID in the solver layout).

@group(0) @binding(1) var<storage, read> cellSums: array<i32>;
@group(0) @binding(2) var<storage, read_write> phiCell: array<f32>;
@group(0) @binding(3) var<storage, read_write> labels: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let b = 8u * li;
  let phi = phiFromSums(vec4<i32>(cellSums[b], cellSums[b + 1u], cellSums[b + 2u], cellSums[b + 3u]),
                        vec4<i32>(cellSums[b + 4u], cellSums[b + 5u], cellSums[b + 6u], cellSums[b + 7u]));
  phiCell[li] = phi;
  labels[li] = select(LABEL_AIR, LABEL_FLUID, phi < 0.0);
}
