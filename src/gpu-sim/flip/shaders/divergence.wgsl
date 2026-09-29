// divergence.wgsl — right-hand side of the pressure solve (FINAL-PLAN §5.2 step 10; flipRef.solvePressure):
// b_c = −(∇·u*)_c on LIQUID cells, 0 elsewhere. SOLID faces already hold the wall velocity (gridUpdate).
// With the drop ball each face carries the volume flux (1 − S_f)·u* + S_f·V (Batty, Bertails & Bridson 2007: the −JᵀV
// term of eq. 13 with M_S⁻¹ → 0 within a substep); S_f = 0 everywhere without a ball.
// The operator's face coefficients a_f = Δt/(ρ·dx²) are uniform until S3.5 and are written by the host.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> u: array<f32>;
@group(0) @binding(3) var<storage, read> valid: array<u32>;
@group(0) @binding(4) var<storage, read> labels: array<u32>;
@group(0) @binding(5) var<storage, read_write> rhs: array<f32>;
@group(0) @binding(6) var<storage, read_write> diag: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(8) var<storage, read> sphere: array<f32>;

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
    let sl = faceSolid[lo];
    let sh = faceSolid[hi];
    let vb = sphere[SPH_V + a];
    // a partly solid face no particle reached holds no liquid: its open sliver moves with the ball (flipRef.solvePressure)
    let uLo = select(u[lo], vb, sl > 0.0 && valid[lo] == 0u && faceType[lo] != SOLID);
    let uHi = select(u[hi], vb, sh > 0.0 && valid[hi] == 0u && faceType[hi] != SOLID);
    if (valid[lo] == 0u && faceType[lo] != SOLID && sl == 0.0) { unset++; }
    if (valid[hi] == 0u && faceType[hi] != SOLID && sh == 0.0) { unset++; }
    div += ((1.0 - sh) * uHi + sh * vb) - ((1.0 - sl) * uLo + sl * vb);
  }
  if (unset > 0u) { atomicAdd(&diag[DIAG_UNSET_DIVERGENCE], unset); }
  rhs[li] = -div / P.dx;
}
