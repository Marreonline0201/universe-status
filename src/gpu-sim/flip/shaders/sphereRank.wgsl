// sphereRank.wgsl — S3.7 monolithic ball: the rank-3 term of the pressure matrix (Batty, Bertails & Bridson 2007 eq. 13;
// flipRef.solvePressure `rank`), A′ = A + (Δt/(M·dx³))·Σ_a J_a J_aᵀ, J_ac = ∂F_a/∂p_c = dx²·Σ over cell c's faces on
// axis a of sgn·S_f (sgn +1 on its + face; SOLID wall faces skipped, as sphereForce), written pre-scaled for the solver:
// Ĵ_a = √(Δt/(M·dx³))·J_a on every LIQUID cell (the solver gates on its own unknown set too), 0 elsewhere.
// M = ρ_s·V_J (sphereGravity stored V_J). One thread per window cell, after the labels are final.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(4) var<storage, read> sphere: array<f32>;
@group(0) @binding(5) var<storage, read_write> rankJ: array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let M = sphere[SPH_DENSITY] * sphere[SPH_VJ];
  if (labels[li] != LABEL_FLUID || sphere[SPH_ACTIVE] < 0.5 || !(M > 0.0)) { rankJ[li] = vec4<f32>(0.0); return; }
  var J = vec3<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    for (var side = 0; side < 2; side++) {
      var cf = c;
      cf[a] += side;
      let s = gridBase(a) + slotOf(cf);
      if (faceType[s] == SOLID) { continue; }
      J[a] += select(-1.0, 1.0, side == 1) * faceSolid[s];
    }
  }
  let h3 = P.dx * P.dx * P.dx;
  rankJ[li] = vec4<f32>(sqrt(P.dt / (M * h3)) * P.dx * P.dx * J, 0.0);
}
