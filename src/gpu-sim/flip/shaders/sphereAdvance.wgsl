// sphereAdvance.wgsl — one thread: move the drop ball by Δt·V (Batty 2007 §3.2: the solid first), then non-penetration
// at the tank walls — the centre stays ≥ R from every wall and the velocity component into it is removed, no
// restitution and no friction (flipRef.advanceSphere; FINAL-PLAN limitation 10: no contact model beyond the solve).

@group(0) @binding(1) var<storage, read_write> sphere: array<f32>;

@compute @workgroup_size(1)
fn main() {
  if (sphere[SPH_ACTIVE] < 0.5) { return; }
  let R = sphere[SPH_R];
  for (var a = 0u; a < 3u; a++) {
    var c = sphere[a] + P.dt * sphere[SPH_V + a];
    var v = sphere[SPH_V + a];
    if (c < R) { c = R; v = max(v, 0.0); }
    if (c > P.extent[a] - R) { c = P.extent[a] - R; v = min(v, 0.0); }
    sphere[a] = c;
    sphere[SPH_V + a] = v;
  }
}
