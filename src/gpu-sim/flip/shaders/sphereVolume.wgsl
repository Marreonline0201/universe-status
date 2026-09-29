// sphereVolume.wgsl — S3.7 monolithic ball, before the pressure solve: the discrete volume V_J = Σ over y faces of S_f·dx³
// (the sum sphereForce makes after the solve; flipRef.sphereVolumeJ) into forceAcc[3], cleared by the host. The solve's
// rank term and the ball's mass M = ρ_s·V_J need it before any pressure exists. One thread per y-face slot.

@group(0) @binding(1) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(2) var<storage, read_write> forceAcc: array<atomic<i32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= P.size) { return; }
  let c = logicalOfThread(tid);
  if (!inFaceRange(1u, c)) { return; }
  let S = faceSolid[gridBase(1u) + slotOf(c)];
  if (S > 0.0) { atomicAdd(&forceAcc[3], i32(round(S * SOLID_SCALE))); }
}
