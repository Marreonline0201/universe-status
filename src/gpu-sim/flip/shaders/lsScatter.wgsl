// lsScatter.wgsl — Zhu & Bridson level-set sums (FINAL-PLAN §5.5 stage 2; flipRef.classifyLevelSet / zhuBridson):
// every particle adds k = (1 − |x_p − x_s|²/R²)³ and k·(x_p − x_s)/dx to each sample point x_s within R — the window
// cell centres (solver padded layout) and the three MAC face-centre grids (the 2× samples that locate θ). Scattering
// instead of gathering gives the same sums (fixed point, order-independent). Each particle also scatters its images
// across the walls it lies within R of (common.wgsl wallImage — the tank wall is not air), and, when the sphere state
// asks for it (SPH_LS_IMAGES, the Stokes path), its radial image across the ball (sphereRadialImage — nor is the ball).

@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> cellSums: array<atomic<i32>>;   // 8 per padded cell: w, rx, ry, rz (hi, lo)
@group(0) @binding(3) var<storage, read_write> faceSums: array<atomic<i32>>;   // 8 per face slot (3 grids)
@group(0) @binding(4) var<storage, read> sphere: array<f32>;

fn addTo(buf: u32, idx: u32, x: vec3<f32>, s: vec3<f32>) {
  let r = x - s;
  let d2 = dot(r, r) / (P.lsR * P.lsR);
  if (d2 >= 1.0) { return; }
  let k = (1.0 - d2) * (1.0 - d2) * (1.0 - d2);
  let v = vec4<f32>(k, k * r / P.dx) * LS_SCALE;
  let hi = lsHi(v);
  let lo = lsLo(v);
  let b = 8u * idx;
  if (buf == 0u) {
    for (var q = 0u; q < 4u; q++) { atomicAdd(&cellSums[b + q], hi[q]); atomicAdd(&cellSums[b + 4u + q], lo[q]); }
  } else {
    for (var q = 0u; q < 4u; q++) { atomicAdd(&faceSums[b + q], hi[q]); atomicAdd(&faceSums[b + 4u + q], lo[q]); }
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  for (var m = 0u; m < 8u; m++) {
    let im = wallImage(pos[q].xyz, m);
    if (im.w > 0.0) { scatterFrom(im.xyz); }
  }
  if (sphere[SPH_ACTIVE] > 0.5 && sphere[SPH_LS_IMAGES] > 0.5) {
    let im = sphereRadialImage(pos[q].xyz, vec3<f32>(sphere[0], sphere[1], sphere[2]), sphere[SPH_R]);
    if (im.w > 0.0) { scatterFrom(im.xyz); }
  }
}

fn scatterFrom(x: vec3<f32>) {
  let reach = P.lsR / P.dx;
  // cell centres at (c + ½)·dx, window cells only
  let fc = x / P.dx - vec3<f32>(0.5);
  let lo = vec3<i32>(ceil(fc - vec3<f32>(reach)));
  let hi = vec3<i32>(floor(fc + vec3<f32>(reach)));
  for (var k = lo.z; k <= hi.z; k++) {
    for (var j = lo.y; j <= hi.y; j++) {
      for (var i = lo.x; i <= hi.x; i++) {
        let c = vec3<i32>(i, j, k);
        if (any(c < vec3<i32>(0)) || any(c >= P.n)) { continue; }
        addTo(0u, linIdx(c), x, (vec3<f32>(c) + vec3<f32>(0.5)) * P.dx);
      }
    }
  }
  // face centres of the three MAC grids
  for (var a = 0u; a < 3u; a++) {
    let ff = x / P.dx - faceOffset(a);
    let flo = vec3<i32>(ceil(ff - vec3<f32>(reach)));
    let fhi = vec3<i32>(floor(ff + vec3<f32>(reach)));
    for (var k = flo.z; k <= fhi.z; k++) {
      for (var j = flo.y; j <= fhi.y; j++) {
        for (var i = flo.x; i <= fhi.x; i++) {
          let c = vec3<i32>(i, j, k);
          if (!inFaceRange(a, c)) { continue; }
          addTo(1u, gridBase(a) + slotOf(c), x, facePos(a, c));
        }
      }
    }
  }
}
