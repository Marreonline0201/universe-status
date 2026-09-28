// labelParticles.wgsl — voxel free surface (FINAL-PLAN §5.5 stage 1; flipRef.classify): the cell holding a particle
// is LIQUID. Many particles store the same value into one cell, so the store is atomic.

@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> labels: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let c = clamp(vec3<i32>(floor(pos[q].xyz / P.dx)), vec3<i32>(0), P.n - vec3<i32>(1));
  atomicStore(&labels[linIdx(c)], LABEL_FLUID);
}
