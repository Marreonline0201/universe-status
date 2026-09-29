// sphereGravity.wgsl — S3.7 monolithic ball, one thread before the pressure solve: store V_J (sphereVolume) and apply the
// body force first, V* = Vⁿ + Δt·g (Batty et al. 2007 §3.2; flipRef.step) — the solve's divergence then carries S·V*
// and each projection adds Δt·F/M (sphereMonoUpdate). A scripted ball (density 0) keeps the velocity the host set.

@group(0) @binding(1) var<storage, read_write> sphere: array<f32>;
@group(0) @binding(2) var<storage, read> forceAcc: array<i32>;

@compute @workgroup_size(1)
fn main() {
  if (sphere[SPH_ACTIVE] < 0.5) { return; }
  sphere[SPH_VJ] = f32(forceAcc[3]) / SOLID_SCALE * P.dx * P.dx * P.dx;
  if (sphere[SPH_DENSITY] <= 0.0) { return; }
  for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += P.dt * P.gravity[a]; }
}
