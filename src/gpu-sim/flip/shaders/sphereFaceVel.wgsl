// sphereFaceVel.wgsl — after project.wgsl: a non-SOLID face whose control volume lies entirely inside the sphere
// (S_f ≥ 1) carries the sphere's velocity and becomes an extrapolation source (flipRef.projectVelocities). Faces with
// 0 < S_f < 1 keep the projected fluid velocity; their volume flux is (1 − S)·u + S·V.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(3) var<storage, read> sphere: array<f32>;
@group(0) @binding(4) var<storage, read_write> u: array<f32>;
@group(0) @binding(5) var<storage, read_write> valid: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }
  let s = gridBase(a) + slotOf(c);
  if (faceType[s] == SOLID || faceSolid[s] < 1.0) { return; }
  u[s] = sphere[SPH_V + a];
  valid[s] = 1u;
}
