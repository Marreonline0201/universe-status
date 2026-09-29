// lsScatter.wgsl — Zhu & Bridson level-set sums (FINAL-PLAN §5.5 stage 2; flipRef.classifyLevelSet / zhuBridson):
// every particle adds k = (1 − |x_p − x_s|²/R²)³ and k·(x_p − x_s)/dx to each sample point x_s within R — the window
// cell centres (solver padded layout) and the three MAC face-centre grids (the 2× samples that locate θ). Scattering
// instead of gathering gives the same sums (fixed point, order-independent).

@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> cellSums: array<atomic<i32>>;   // 4 per padded cell: w, rx, ry, rz
@group(0) @binding(3) var<storage, read_write> faceSums: array<atomic<i32>>;   // 4 per face slot (3 grids)

fn addTo(buf: u32, idx: u32, x: vec3<f32>, s: vec3<f32>) {
  let r = x - s;
  let d2 = dot(r, r) / (P.lsR * P.lsR);
  if (d2 >= 1.0) { return; }
  let k = (1.0 - d2) * (1.0 - d2) * (1.0 - d2);
  let v = vec4<f32>(k, k * r / P.dx) * LS_SCALE;
  if (buf == 0u) {
    atomicAdd(&cellSums[4u * idx], encodeFixed(v.x)); atomicAdd(&cellSums[4u * idx + 1u], encodeFixed(v.y));
    atomicAdd(&cellSums[4u * idx + 2u], encodeFixed(v.z)); atomicAdd(&cellSums[4u * idx + 3u], encodeFixed(v.w));
  } else {
    atomicAdd(&faceSums[4u * idx], encodeFixed(v.x)); atomicAdd(&faceSums[4u * idx + 1u], encodeFixed(v.y));
    atomicAdd(&faceSums[4u * idx + 2u], encodeFixed(v.z)); atomicAdd(&faceSums[4u * idx + 3u], encodeFixed(v.w));
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let x = pos[q].xyz;
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
