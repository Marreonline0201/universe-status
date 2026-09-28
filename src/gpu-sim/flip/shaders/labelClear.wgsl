// labelClear.wgsl — every interior cell becomes AIR before particles mark theirs LIQUID (flipRef.classify).
// Ghost cells of the solver's padded layout are SOLID from creation and never written.

@group(0) @binding(1) var<storage, read_write> labels: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  labels[linIdx(c)] = LABEL_AIR;
}
