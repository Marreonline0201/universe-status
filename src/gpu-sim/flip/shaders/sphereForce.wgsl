// sphereForce.wgsl — the pressure force on the drop ball (Batty, Bertails & Bridson 2007 eqs. 8–10;
// flipRef.pressureForceOnSphere): F = −∯ p n dA = −∭_solid ∇p ≈ −Σ_f S_f·dx²·(p₊ − p₋) over the faces the sphere
// occupies (p of LIQUID cells, 0 elsewhere), and the discrete volume V_J = Σ over y faces of S_f·dx³. Summed in
// fixed point (N·FORCE_SCALE, ΣS·SOLID_SCALE) into forceAcc, cleared by the host before this pass.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> pressure: array<f32>;
@group(0) @binding(4) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(5) var<storage, read_write> forceAcc: array<atomic<i32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }
  let s = gridBase(a) + slotOf(c);
  let S = faceSolid[s];
  if (S <= 0.0) { return; }
  if (a == 1u) { atomicAdd(&forceAcc[3], i32(round(S * SOLID_SCALE))); }
  if (faceType[s] == SOLID) { return; }
  var e = vec3<i32>(0);
  e[a] = 1;
  let lp = labels[linIdx(c)];
  let lm = labels[linIdx(c - e)];
  let pp = select(0.0, pressure[linIdx(c)], lp == LABEL_FLUID);
  let pm = select(0.0, pressure[linIdx(c - e)], lm == LABEL_FLUID);
  let f = -S * P.dx * P.dx * (pp - pm);
  atomicAdd(&forceAcc[a], i32(round(f * FORCE_SCALE)));
}
