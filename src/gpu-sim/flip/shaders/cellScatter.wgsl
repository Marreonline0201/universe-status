// cellScatter.wgsl — particle volume fraction on cell centres (Kugelstadt et al. 2019 eq. 12; flipRef.densityCorrect):
// f_c += (V_p/dx³)·N(x_p − x_c) with the cell-centred trilinear N, into the solver's padded layout (ghost cells collect
// what is lost across the walls). V_p/dx³ = m̂·ρ_ref/ρ = m̂ / (invMassUnit·dx³·ρ). Fixed point at MASS_SCALE (single word:
// f ≤ ~4 even crowded, and the ψ tolerance is 1e-3).

@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vfrac: array<atomic<i32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let vp = vel[q].w / (P.invMassUnit * P.dx * P.dx * P.dx * P.rho);
  let f = pos[q].xyz / P.dx - vec3<f32>(0.5);
  let base = vec3<i32>(floor(f));
  let t = f - floor(f);
  for (var dk = 0; dk < 2; dk++) {
    for (var dj = 0; dj < 2; dj++) {
      for (var di = 0; di < 2; di++) {
        let d = vec3<i32>(di, dj, dk);
        let wv = select(vec3<f32>(1.0) - t, t, d == vec3<i32>(1));
        let w = wv.x * wv.y * wv.z;
        if (w == 0.0) { continue; }
        atomicAdd(&vfrac[linIdx(base + d)], encodeFixed(vp * w * P.massScale));
      }
    }
  }
}
