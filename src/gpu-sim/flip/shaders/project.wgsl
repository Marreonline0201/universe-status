// project.wgsl — pressure projection (FINAL-PLAN §5.2 step 11; flipRef.projectVelocities):
// u = u* − (Δt/ρ_f)·(p₊ − p₋)/dx on every non-SOLID face with a LIQUID cell on either side (p = 0 in AIR); those faces
// become the only extrapolation sources, every other non-SOLID face is unset. SOLID faces keep the wall velocity.
// Ghost-fluid surface (P.ghost = 1, S3.4): the AIR side of a liquid–air face carries the ghost pressure
// −((1 − θ)/θ)·p_liquid that puts p = 0 on the interface (Gibou et al.; Bridson eq. 4.37; flipRef.projectVelocities).
// Δt/(ρ_f·dx) = a_f·dx with a_f read from the pressure operator's own face coefficients (ghostCoef.wgsl, or the uniform
// coefficients), so the projection always uses exactly the densities the solve used (S3.5).

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> pressure: array<f32>;
@group(0) @binding(4) var<storage, read_write> u: array<f32>;
@group(0) @binding(5) var<storage, read_write> valid: array<u32>;
@group(0) @binding(6) var<storage, read> phiCell: array<f32>;
@group(0) @binding(7) var<storage, read> faceSums: array<i32>;
@group(0) @binding(8) var<storage, read> faceCoef: array<vec4<f32>>;

fn facePhi(a: u32, c: vec3<i32>) -> f32 {
  let s = gridBase(a) + slotOf(c);
  return phiFromSums(faceSums[4u * s], faceSums[4u * s + 1u], faceSums[4u * s + 2u], faceSums[4u * s + 3u]);
}

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
    var pmE = pm;
    var ppE = pp;
    if (P.ghost == 1u) {
      if (lm == LABEL_AIR) { let th = thetaOf(phiCell[linIdx(c)], facePhi(a, c), phiCell[linIdx(c - e)]); pmE = -((1.0 - th) / th) * pp; }
      if (lp == LABEL_AIR) { let th = thetaOf(phiCell[linIdx(c - e)], facePhi(a, c), phiCell[linIdx(c)]); ppE = -((1.0 - th) / th) * pm; }
    }
    u[s] -= faceCoef[linIdx(c)][a] * P.dx * (ppE - pmE);
    valid[s] = 1u;
  } else {
    valid[s] = 0u;
  }
}
