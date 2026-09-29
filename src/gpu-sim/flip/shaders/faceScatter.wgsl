// faceScatter.wgsl — P2G onto the three MAC face grids (FINAL-PLAN §5.2 step 6; flipRef.p2g).
// Per particle and axis a: the 8 trilinear neighbours f receive
//   mass += w·m̂_p,   momentum += w·m̂_p·(v_a + c_a·(x_f − x_p))      (APIC-MAC, Jiang et al. 2015 §6)
// as fixed-point i32 atomics (WebGPU has no float atomics). m̂ is the particle mass in grid mass units ρ_ref·dx³.
// Also the weight sum Σw (at massScale), from which the S3.5 face density ρ_f = ρ_ref·ppc·m̂_f/Σw is formed.

@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;      // xyz m, w = material id bits
@group(0) @binding(2) var<storage, read> vel: array<vec4<f32>>;      // xyz m/s, w = m̂ (mass / (ρ_ref·dx³))
@group(0) @binding(3) var<storage, read> aff: array<vec4<f32>>;      // 3 per particle: c_x, c_y, c_z (1/s)
@group(0) @binding(4) var<storage, read_write> gMass: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> gMom: array<atomic<i32>>;
@group(0) @binding(6) var<storage, read_write> gMassLo: array<atomic<i32>>;   // PRECISE_P2G remainders
@group(0) @binding(7) var<storage, read_write> gMomLo: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read_write> gW: array<atomic<i32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let x = pos[q].xyz;
  let v = vel[q].xyz;
  let m = vel[q].w;
  for (var a = 0u; a < 3u; a++) {
    let ca = aff[3u * q + a].xyz;
    let f = x / P.dx - faceOffset(a);
    let base = vec3<i32>(floor(f));
    let t = f - floor(f);
    for (var dk = 0; dk < 2; dk++) {
      for (var dj = 0; dj < 2; dj++) {
        for (var di = 0; di < 2; di++) {
          let d = vec3<i32>(di, dj, dk);
          let wv = select(vec3<f32>(1.0) - t, t, d == vec3<i32>(1));
          let w = wv.x * wv.y * wv.z;
          if (w == 0.0) { continue; }
          let c = base + d;
          var val = v[a];
          if (P.apic == 1u) { val += dot(ca, facePos(a, c) - x); }
          let s = gridBase(a) + slotOf(c);
          let qm = w * m * P.massScale;
          let qp = w * m * val * P.momScale;
          atomicAdd(&gMass[s], encodeFixed(qm));
          atomicAdd(&gMom[s], encodeFixed(qp));
          atomicAdd(&gW[s], encodeFixed(w * P.massScale));
          if (PRECISE_P2G) {
            atomicAdd(&gMassLo[s], encodeLo(qm));
            atomicAdd(&gMomLo[s], encodeLo(qp));
          }
        }
      }
    }
  }
}
