// sphereMonoUpdate.wgsl — S3.7 monolithic ball, one thread after sphereForce, after EVERY pressure projection (both on
// the viscous path; flipRef.solvePressure): store F and V_J, and V ← V + Δt·F/M, M = ρ_s·V_J — no gravity here (it went
// into V* before the solve, sphereGravity). The solve that produced p already carried the ball's response (the rank-3
// term), so this is the implicit update of Batty et al. 2007 eq. 13, not a lagged force.

@group(0) @binding(1) var<storage, read_write> sphere: array<f32>;
@group(0) @binding(2) var<storage, read> forceAcc: array<i32>;

@compute @workgroup_size(1)
fn main() {
  if (sphere[SPH_ACTIVE] < 0.5) { return; }
  let F = vec3<f32>(f32(forceAcc[0]), f32(forceAcc[1]), f32(forceAcc[2])) / FORCE_SCALE;
  let vJ = f32(forceAcc[3]) / SOLID_SCALE * P.dx * P.dx * P.dx;
  for (var a = 0u; a < 3u; a++) { sphere[SPH_FORCE + a] = F[a]; }
  sphere[SPH_VJ] = vJ;
  let rhoS = sphere[SPH_DENSITY];
  if (rhoS <= 0.0 || vJ <= 0.0) { return; }
  let M = rhoS * vJ;
  for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += P.dt * F[a] / M; }
}
