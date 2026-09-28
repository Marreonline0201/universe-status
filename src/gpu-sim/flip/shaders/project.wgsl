// project.wgsl — pressure projection (FINAL-PLAN §5.2 step 11; flipRef.projectVelocities):
// u = u* − (Δt/ρ)·(p₊ − p₋)/dx on every non-SOLID face with a LIQUID cell on either side (p = 0 in AIR); those faces
// become the only extrapolation sources, every other non-SOLID face is unset. SOLID faces keep the wall velocity.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> pressure: array<f32>;
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
  if (faceType[s] == SOLID) { return; }
  var e = vec3<i32>(0);
  e[a] = 1;
  let lm = labels[linIdx(c - e)];
  let lp = labels[linIdx(c)];
  if (lm == LABEL_FLUID || lp == LABEL_FLUID) {
    let pm = select(0.0, pressure[linIdx(c - e)], lm == LABEL_FLUID);
    let pp = select(0.0, pressure[linIdx(c)], lp == LABEL_FLUID);
    u[s] -= P.dt / (P.rho * P.dx) * (pp - pm);
    valid[s] = 1u;
  } else {
    valid[s] = 0u;
  }
}
