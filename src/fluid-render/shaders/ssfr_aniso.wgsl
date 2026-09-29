// ssfr_aniso.wgsl — anisotropic splat shapes (owner decision 2026-09-29; vault fluid/realism-2026-09/research/
// x10-anisotropic-splats.md, the "recommended mapping" = the bench's final2 with r_b 1.0 s, r_i 3 s, a_min 0.5 s,
// a_max 2.5 s, α 1.25, κ 2, smoothstep 0.2 → 0.4, the volume floor, raw centres). Per particle the weighted covariance
// of its neighbours within r_i (w = 1 − (d/r_i)³, itself included), its eigen-decomposition (standard deviations — the
// PhysX 5 anisotropy.cu form), and the axes: the 3-D rule for bulk and surfaces, a sheet rule and a thread rule whose
// in-plane size comes from the weight sum W (PCA spread does not measure spacing), blended by the axis ratios.
// Output per particle: three axis vectors scaled to their semi-axis lengths (world units) and, in the first's w, the
// volume factor V_p/((4/3)π a₁a₂a₃) that keeps each splat's thickness integral equal to its rest volume.
// Neighbour search: a counting-sort grid of cell size r_i (count → one-workgroup scan → scatter). The order of the
// particles inside a cell varies frame to frame (atomic cursors): that moves only the f32 rounding of the sums, and a
// degenerate eigen-direction always comes with equal axis lengths, so the shape does not change.
// Interior skip (budget): a particle whose 27 cells all hold ≥ interiorMin particles is deep in the bulk, hidden behind
// the surface splats, and its covariance would give the bulk sphere anyway — it gets the sphere r_b without the loop.

struct AnisoParams {
  count: u32,        // particles
  gx: u32,           // cells per axis over the tank's extent (world units), cell size r_i
  gy: u32,
  gz: u32,
  s: f32,            // rest spacing ∛V_p, world units
  ri: f32,           // neighbour radius r_i = 3 s (world units) = the cell size
  rb: f32,           // bulk splat radius (s units)
  aMin: f32,         // s units
  aMax: f32,         // s units
  alpha: f32,
  kappa: f32,
  lo: f32,
  hi: f32,
  interiorMin: u32,  // particles per cell for the interior skip (0: never skip)
  pad2: f32,
  pad3: f32,
}
@group(0) @binding(0) var<uniform> AP: AnisoParams;

struct Particle {
  pos_x: f32, pos_y: f32, pos_z: f32,
  composition_id: u32,
  vel_x: f32, vel_y: f32, vel_z: f32,
  temperature: f32,
  C00: f32, C01: f32, C02: f32,
  C10: f32, C11: f32, C12: f32,
  C20: f32, C21: f32, C22: f32,
  phase: u32,
  _pad0: u32, _pad1: u32,
};
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellCursor: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> sorted: array<u32>;
@group(0) @binding(6) var<storage, read_write> aniso: array<vec4<f32>>;   // 3 per particle

fn posOf(i: u32) -> vec3<f32> { let p = particles[i]; return vec3<f32>(p.pos_x, p.pos_y, p.pos_z); }
fn gridDims() -> vec3<i32> { return vec3<i32>(i32(AP.gx), i32(AP.gy), i32(AP.gz)); }
fn cellCoord(x: vec3<f32>) -> vec3<i32> { return clamp(vec3<i32>(floor(x / AP.ri)), vec3<i32>(0), gridDims() - vec3<i32>(1)); }
fn cellIdx(c: vec3<i32>) -> u32 { return u32(c.x) + AP.gx * (u32(c.y) + AP.gy * u32(c.z)); }

@compute @workgroup_size(64)
fn aCount(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= AP.count) { return; }
  atomicAdd(&cellCount[cellIdx(cellCoord(posOf(i)))], 1u);
}

var<workgroup> scanW: array<u32, 256>;
fn exclusiveScan(lid: u32, v: u32) -> u32 {
  scanW[lid] = v;
  workgroupBarrier();
  for (var off = 1u; off < 256u; off <<= 1u) {
    var add = 0u;
    if (lid >= off) { add = scanW[lid - off]; }
    workgroupBarrier();
    scanW[lid] += add;
    workgroupBarrier();
  }
  return scanW[lid] - v;
}
/// One workgroup: exclusive prefix of the cell counts (each thread a contiguous chunk); cursors reset.
@compute @workgroup_size(256)
fn aScan(@builtin(local_invocation_index) lid: u32) {
  let n = AP.gx * AP.gy * AP.gz;
  let C = (n + 255u) / 256u;
  let lo = lid * C;
  let hi = min(lo + C, n);
  var acc = 0u;
  for (var j = lo; j < hi; j++) { acc += atomicLoad(&cellCount[j]); }
  var run = exclusiveScan(lid, acc);
  for (var j = lo; j < hi; j++) { cellStart[j] = run; run += atomicLoad(&cellCount[j]); atomicStore(&cellCursor[j], 0u); }
}
@compute @workgroup_size(64)
fn aScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= AP.count) { return; }
  let c = cellIdx(cellCoord(posOf(i)));
  sorted[cellStart[c] + atomicAdd(&cellCursor[c], 1u)] = i;
}

/// Symmetric 3×3 eigen-decomposition by cyclic Jacobi rotations: eigenvalues (descending) and unit eigenvectors.
struct Eig { l: vec3<f32>, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32> }
fn eigSym(m: mat3x3<f32>) -> Eig {
  var a = m;
  var v = mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0));
  for (var sweep = 0; sweep < 12; sweep++) {
    let off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    let diag = a[0][0] * a[0][0] + a[1][1] * a[1][1] + a[2][2] * a[2][2];
    if (off <= 1e-14 * diag || off == 0.0) { break; }
    for (var pq = 0; pq < 3; pq++) {
      var p = 0; var q = 1;
      if (pq == 1) { p = 0; q = 2; } else if (pq == 2) { p = 1; q = 2; }
      let apq = a[p][q];
      if (abs(apq) < 1e-30) { continue; }
      let th = (a[q][q] - a[p][p]) / (2.0 * apq);
      let t = sign(th + select(0.0, 1.0, th == 0.0)) / (abs(th) + sqrt(th * th + 1.0));
      let c = 1.0 / sqrt(t * t + 1.0);
      let s = t * c;
      // A ← Jᵀ A J, V ← V J (J the rotation in the (p, q) plane)
      for (var k = 0; k < 3; k++) { let akp = a[k][p]; let akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (var k = 0; k < 3; k++) { let apk = a[p][k]; let aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (var k = 0; k < 3; k++) { let vkp = v[p][k]; let vkq = v[q][k]; v[p][k] = c * vkp - s * vkq; v[q][k] = s * vkp + c * vkq; }
    }
  }
  // columns of v (stored as v[column][row]) are the eigenvectors; sort descending
  var l = vec3<f32>(a[0][0], a[1][1], a[2][2]);
  var e0 = v[0]; var e1 = v[1]; var e2 = v[2];
  if (l.x < l.y) { let tl = l.x; l.x = l.y; l.y = tl; let te = e0; e0 = e1; e1 = te; }
  if (l.y < l.z) { let tl = l.y; l.y = l.z; l.z = tl; let te = e1; e1 = e2; e2 = te; }
  if (l.x < l.y) { let tl = l.x; l.x = l.y; l.y = tl; let te = e0; e0 = e1; e1 = te; }
  var o: Eig;
  o.l = max(l, vec3<f32>(0.0)); o.v0 = normalize(e0); o.v1 = normalize(e1); o.v2 = normalize(e2);
  return o;
}
fn smooth01(e0: f32, e1: f32, x: f32) -> f32 { let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

fn writeSphere(i: u32, a: f32) {
  // a in s units; volume factor V_p/((4/3)π a³) with V_p = s³
  aniso[3u * i] = vec4<f32>(a * AP.s, 0.0, 0.0, 1.0 / (4.18879020 * a * a * a));
  aniso[3u * i + 1u] = vec4<f32>(0.0, a * AP.s, 0.0, 0.0);
  aniso[3u * i + 2u] = vec4<f32>(0.0, 0.0, a * AP.s, 0.0);
}

@compute @workgroup_size(64)
fn aAniso(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= AP.count) { return; }
  let xi = posOf(i);
  let ci = cellCoord(xi);
  let n = gridDims();
  // interior skip
  if (AP.interiorMin > 0u) {
    var interior = true;
    for (var dz = -1; dz <= 1 && interior; dz++) { for (var dy = -1; dy <= 1 && interior; dy++) { for (var dx = -1; dx <= 1 && interior; dx++) {
      let cc = ci + vec3<i32>(dx, dy, dz);
      if (any(cc < vec3<i32>(0)) || any(cc >= n)) { interior = false; }
      else if (atomicLoad(&cellCount[cellIdx(cc)]) < AP.interiorMin) { interior = false; }
    } } }
    if (interior) { writeSphere(i, AP.rb); return; }
  }
  // weighted moments in s units, relative to x_i
  let inv = 1.0 / AP.s;
  let r = AP.ri * inv;   // = 3
  var W = 0.0;
  var m = vec3<f32>(0.0);
  var cxx = 0.0; var cyy = 0.0; var czz = 0.0; var cxy = 0.0; var cxz = 0.0; var cyz = 0.0;
  for (var dz = -1; dz <= 1; dz++) { for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    let cc = ci + vec3<i32>(dx, dy, dz);
    if (any(cc < vec3<i32>(0)) || any(cc >= n)) { continue; }
    let c = cellIdx(cc);
    let st = cellStart[c];
    let en = st + atomicLoad(&cellCount[c]);
    for (var k = st; k < en; k++) {
      let d = (posOf(sorted[k]) - xi) * inv;
      let d2 = dot(d, d);
      if (d2 >= r * r) { continue; }
      let q = sqrt(d2) / r;
      let w = 1.0 - q * q * q;
      W += w; m += w * d;
      cxx += w * d.x * d.x; cyy += w * d.y * d.y; czz += w * d.z * d.z;
      cxy += w * d.x * d.y; cxz += w * d.x * d.z; cyz += w * d.y * d.z;
    }
  } } }
  if (W <= 1.0 + 1e-6) { writeSphere(i, 0.62035049); return; }   // isolated: the volume-equivalent sphere (3/(4π))^(1/3)
  let mu = m / W;
  let C = mat3x3<f32>(
    vec3<f32>(cxx / W - mu.x * mu.x, cxy / W - mu.x * mu.y, cxz / W - mu.x * mu.z),
    vec3<f32>(cxy / W - mu.x * mu.y, cyy / W - mu.y * mu.y, cyz / W - mu.y * mu.z),
    vec3<f32>(cxz / W - mu.x * mu.z, cyz / W - mu.y * mu.z, czz / W - mu.z * mu.z));
  let e = eigSym(C);
  let sd = sqrt(e.l);
  let ks = AP.rb / (0.38729833 * r);   // r_b / (√0.15·r_i)
  let s1 = max(sd.x, 1e-12);
  let g2 = sqrt(0.6 * 3.14159265 * r * r / W);
  let g1 = 1.5 * r / W;
  let A3 = clamp(ks * sd, vec3<f32>(AP.aMin), vec3<f32>(AP.aMax));
  let cap = min(AP.kappa * sd.x, AP.aMax);
  let at = max(min(ks * sd.x, AP.aMax), min(AP.alpha * g2, cap));
  let As = vec3<f32>(at, at, max(AP.aMin, 0.5 / (g2 * g2)));
  let al = max(min(ks * sd.x, AP.aMax), min(AP.alpha * g1, cap));
  let th = max(AP.aMin, sqrt(1.0 / (3.14159265 * g1)));
  let Al = vec3<f32>(al, th, th);
  let b3 = smooth01(AP.lo, AP.hi, sd.z / s1);
  let b2 = smooth01(AP.lo, AP.hi, sd.y / s1);
  var A = b3 * A3 + (1.0 - b3) * (b2 * As + (1.0 - b2) * Al);
  let v = A.x * A.y * A.z;
  let vmin = 0.23873241;   // 3/(4π)
  if (v < vmin) { A *= pow(vmin / max(v, 1e-12), 1.0 / 3.0); }
  aniso[3u * i] = vec4<f32>(e.v0 * (A.x * AP.s), 1.0 / (4.18879020 * A.x * A.y * A.z));
  aniso[3u * i + 1u] = vec4<f32>(e.v1 * (A.y * AP.s), 0.0);
  aniso[3u * i + 2u] = vec4<f32>(e.v2 * (A.z * AP.s), 0.0);
}
