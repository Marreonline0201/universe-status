// positionCorrect.wgsl — move each particle by the trilinear interpolation of the face displacements
// (Kugelstadt et al. 2019: "the particles are moved without changing the velocity"; flipRef.densityCorrect).
// Positions stay wallEps inside the window; each push-back is counted. A particle the correction moved into the drop
// ball is pushed radially back out (flipRef.densityCorrect → sphereCollide; counted).

@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> disp: array<f32>;
@group(0) @binding(3) var<storage, read_write> diag: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> sphere: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let x = pos[q].xyz;
  var d = vec3<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    let f = x / P.dx - faceOffset(a);
    let base = vec3<i32>(floor(f));
    let t = f - floor(f);
    var v = 0.0;
    for (var dk = 0; dk < 2; dk++) {
      for (var dj = 0; dj < 2; dj++) {
        for (var di = 0; di < 2; di++) {
          let o = vec3<i32>(di, dj, dk);
          let wv = select(vec3<f32>(1.0) - t, t, o == vec3<i32>(1));
          v += wv.x * wv.y * wv.z * disp[gridBase(a) + slotOf(base + o)];
        }
      }
    }
    d[a] = v;
  }
  let lo = vec3<f32>(P.wallEps);
  let hi = P.extent - vec3<f32>(P.wallEps);
  let nx = x + d;
  let cx = clamp(nx, lo, hi);
  if (any(cx != nx)) { atomicAdd(&diag[DIAG_DENSITY_CLAMPS], 1u); }
  var fx = cx;
  if (sphere[SPH_ACTIVE] > 0.5) {
    fx = sphereOut(cx, vec3<f32>(sphere[0], sphere[1], sphere[2]), sphere[SPH_R]);
    if (any(fx != cx)) { atomicAdd(&diag[DIAG_SPHERE_PUSHOUTS], 1u); }
  }
  pos[q] = vec4<f32>(fx, pos[q].w);
}
