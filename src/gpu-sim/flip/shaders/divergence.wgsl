// divergence.wgsl — right-hand side of the pressure solve (FINAL-PLAN §5.2 step 10; flipRef.solvePressure):
// b_c = −(∇·u*)_c on LIQUID cells, 0 elsewhere. SOLID faces already hold the wall velocity (gridUpdate).
// The operator's face coefficients a_f = Δt/(ρ·dx²) are uniform until S3.5 and are written by the host.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> u: array<f32>;
@group(0) @binding(3) var<storage, read> valid: array<u32>;
@group(0) @binding(4) var<storage, read> labels: array<u32>;
@group(0) @binding(5) var<storage, read_write> rhs: array<f32>;
@group(0) @binding(6) var<storage, read_write> diag: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  if (labels[li] != LABEL_FLUID) { rhs[li] = 0.0; return; }
  var div = 0.0;
  var unset = 0u;
  for (var a = 0u; a < 3u; a++) {
    var e = vec3<i32>(0);
    e[a] = 1;
    let lo = gridBase(a) + slotOf(c);
    let hi = gridBase(a) + slotOf(c + e);
    if (valid[lo] == 0u && faceType[lo] != SOLID) { unset++; }
    if (valid[hi] == 0u && faceType[hi] != SOLID) { unset++; }
    div += u[hi] - u[lo];
  }
  if (unset > 0u) { atomicAdd(&diag[DIAG_UNSET_DIVERGENCE], unset); }
  rhs[li] = -div / P.dx;
}
