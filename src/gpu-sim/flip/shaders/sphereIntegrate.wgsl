// sphereIntegrate.wgsl — one thread after sphereForce: store the force F and the discrete volume V_J, and for a
// free ball (density > 0) apply weak two-way coupling V += Δt·(g + F/M), M = ρ_s·V_J (flipRef.integrateSphere;
// FINAL-PLAN S3.1c, s ≥ 1 only — the added-mass reaction arrives one substep late). A scripted ball (density 0)
// keeps the velocity the host set.

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
  for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += P.dt * (P.gravity[a] + F[a] / M); }
}
