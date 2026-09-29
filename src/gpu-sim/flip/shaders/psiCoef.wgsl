// psiCoef.wgsl — the density (ψ) solve's face coefficients with the drop ball: w_f = 1 − S_f on every window cell's
// −x, −y, −z face (unit coefficients otherwise), so the ψ operator carries the same fluid-fraction weights as the
// reference's (flipRef.densityCorrect → liquidSystem(() => 1)). Written each substep while a sphere is active; the
// host restores the unit coefficients when it is removed.

@group(0) @binding(1) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(2) var<storage, read_write> psiCoef: array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  var w = vec3<f32>(1.0);
  for (var a = 0u; a < 3u; a++) { w[a] = max(0.0, 1.0 - faceSolid[gridBase(a) + slotOf(c)]); }
  psiCoef[linIdx(c)] = vec4<f32>(w, 0.0);
}
