// viscosity.wgsl — S3.6 implicit variational viscosity (Batty & Bridson 2008) on the GPU; the f64 reference is
// flipRef.viscositySolve (spec: vault fluid/realism-2026-09/S3.6-viscosity-spec.md). Minimise
//   ½ Σ_f ρ_f V_f (u_f − u*_f)² + Δt [ Σ_c μ V Σ_a ε_aa² + Σ_edges μ V ½ γ² ]   ⇒   (M + Δt GᵀWG) u = M u*
// over the MAC face velocities with Jacobi-PCG, matrix-free: `strain` forms w·strain at every sample (cell centres: the
// three ε_aa, w = 2μV; edges: γ, w = μV), `gather` sums Δt·g·stress over each face's samples (g = ±1/dx, plus the
// mirror coefficient where the face stands behind a wall's ghost). Edge family e (running along axis e) at logical c
// with c ∈ [0, n] on the two axes ≠ e and [0, n − 1] on e, stored at gridBase(e) + slotOf(c).
// Face kinds (setupKinds): 0 zero (wall-normal, outside), 1 unknown, 2 constant u*, 3 inside the ball (V). A tangential
// ghost face (index −1 or n on an axis b ≠ a) is VP.walls[b]·(the face across that wall): −1 no-slip, +1 free-slip.
// Volumes: liquid fraction of each sample's dx³ cube from 2×2×2 subsamples of the Zhu–Bridson φ on the quarter lattice
// ((2a + 1)/4·dx per axis — every family's subsamples lie on it), clamp(½ − φ/(dx/2), 0, 1), φ mirrored into the walls;
// only samples overlapping a surface-band cell are subsampled (1 inside the liquid, 0 outside otherwise); an edge on a
// wall plane keeps the in-tank half of its volume.
// One module, many entry points (ViscositySolver.ts); common.wgsl is prepended. Every entry binds ≤ 8 storage buffers.

struct ViscParams {
  walls: vec3<f32>,     // per axis: −1 no-slip, +1 free-slip (the ghost face's sign)
  muDefault: f32,       // Pa·s, samples no particle reaches
  tol2: f32,            // PCG stops at ‖r‖₂² ≤ tol2·‖b‖₂²
  nWg: u32,             // workgroups of the face-vector passes (partials count)
  pad0: f32,
  pad1: f32,
}
@group(0) @binding(1) var<uniform> VP: ViscParams;

@group(0) @binding(2) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> latSums: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read> latSumsR: array<i32>;
@group(0) @binding(5) var<storage, read> labels: array<u32>;
@group(0) @binding(6) var<storage, read_write> band: array<u32>;
@group(0) @binding(7) var<storage, read> bandR: array<u32>;
@group(0) @binding(8) var<storage, read_write> volFace: array<f32>;
@group(0) @binding(9) var<storage, read_write> volCell: array<f32>;
@group(0) @binding(10) var<storage, read_write> volEdge: array<f32>;
@group(0) @binding(11) var<storage, read> aux: array<vec4<u32>>;
@group(0) @binding(12) var<storage, read> muTable: array<f32>;
@group(0) @binding(13) var<storage, read_write> muAcc: array<atomic<u32>>;
@group(0) @binding(14) var<storage, read_write> wCell: array<f32>;
@group(0) @binding(15) var<storage, read_write> wEdge: array<f32>;
@group(0) @binding(16) var<storage, read> faceType: array<u32>;
@group(0) @binding(17) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(18) var<storage, read_write> kind: array<u32>;
@group(0) @binding(19) var<storage, read> volFaceR: array<f32>;
@group(0) @binding(20) var<storage, read> volCellR: array<f32>;
@group(0) @binding(21) var<storage, read> volEdgeR: array<f32>;
@group(0) @binding(22) var<storage, read> wCellR: array<f32>;
@group(0) @binding(23) var<storage, read> wEdgeR: array<f32>;
@group(0) @binding(24) var<storage, read> kindR: array<u32>;
@group(0) @binding(25) var<storage, read> vecIn: array<f32>;
@group(0) @binding(26) var<storage, read> sphere: array<f32>;
@group(0) @binding(27) var<storage, read_write> stressCell: array<f32>;
@group(0) @binding(28) var<storage, read_write> stressEdge: array<f32>;
@group(0) @binding(29) var<storage, read> stressCellR: array<f32>;
@group(0) @binding(30) var<storage, read> stressEdgeR: array<f32>;
@group(0) @binding(31) var<storage, read> mass: array<f32>;
@group(0) @binding(32) var<storage, read_write> vecOut: array<f32>;
@group(0) @binding(33) var<storage, read> coefRaw: array<vec4<f32>>;
@group(0) @binding(34) var<storage, read_write> massW: array<f32>;
@group(0) @binding(35) var<storage, read_write> diagW: array<f32>;
@group(0) @binding(36) var<storage, read_write> constVal: array<f32>;
@group(0) @binding(37) var<storage, read> uStar: array<f32>;
@group(0) @binding(38) var<storage, read> diagR: array<f32>;
@group(0) @binding(39) var<storage, read> bR: array<f32>;
@group(0) @binding(40) var<storage, read_write> xV: array<f32>;
@group(0) @binding(41) var<storage, read_write> rV: array<f32>;
@group(0) @binding(42) var<storage, read_write> zV: array<f32>;
@group(0) @binding(43) var<storage, read_write> dV: array<f32>;
@group(0) @binding(44) var<storage, read> qR: array<f32>;
@group(0) @binding(45) var<storage, read_write> partials: array<vec4<f32>>;
@group(0) @binding(46) var<storage, read_write> st: array<f32>;
@group(0) @binding(47) var<storage, read> stR: array<f32>;
@group(0) @binding(48) var<storage, read_write> uOut: array<f32>;
@group(0) @binding(49) var<storage, read_write> validOut: array<u32>;
@group(0) @binding(50) var<storage, read> xR: array<f32>;
@group(0) @binding(51) var<storage, read> muTableR: array<f32>;
@group(0) @binding(52) var<storage, read_write> bandNear: array<u32>;
@group(0) @binding(53) var<storage, read> bandNearR: array<u32>;
@group(0) @binding(54) var<storage, read_write> faults: array<u32>;   // solves, cap hits, breakdowns, max iterations

override GATHER_MINUS: bool = false;   // gather: out = mass·in + Δt·Σ (A·x) or mass·in − Δt·Σ (the right-hand side b)

// PCG state (st): 0 rz, 1 alpha, 2 beta, 3 bb, 4 converged (0/1), 5 iterations, 6 rr, 7 dq
const ST_RZ: u32 = 0u;
const ST_ALPHA: u32 = 1u;
const ST_BETA: u32 = 2u;
const ST_BB: u32 = 3u;
const ST_CONV: u32 = 4u;
const ST_IT: u32 = 5u;
const ST_RR: u32 = 6u;
const ST_BRK: u32 = 7u;

// ── the quarter lattice ─────────────────────────────────────────────────────────────────────────────────────────
// lattice point (c, s) of window cell c, s ∈ {0,1}³: position (c + ¼ + ½·s)·dx; its 8 sum words (common.wgsl two-word
// level-set sums) at 8·(8·linIdx(c) + s)

fn latBase(c: vec3<i32>, s: vec3<i32>) -> u32 { return 8u * (8u * linIdx(c) + u32(s.x + 2 * s.y + 4 * s.z)); }

@compute @workgroup_size(64)
fn latScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  for (var m = 0u; m < 8u; m++) {   // the particle and its images across the walls (common.wgsl wallImage)
    let im = wallImage(pos[q].xyz, m);
    if (im.w > 0.0) { latScatterFrom(im.xyz); }
  }
}

fn latScatterFrom(x: vec3<f32>) {
  let R = P.lsR;
  let lo = vec3<i32>(ceil((x - vec3<f32>(R)) / (0.5 * P.dx) - vec3<f32>(0.5)));
  let hi = vec3<i32>(floor((x + vec3<f32>(R)) / (0.5 * P.dx) - vec3<f32>(0.5)));
  for (var nz = lo.z; nz <= hi.z; nz++) {
    for (var ny = lo.y; ny <= hi.y; ny++) {
      for (var nx = lo.x; nx <= hi.x; nx++) {
        let n = vec3<i32>(nx, ny, nz);
        if (any(n < vec3<i32>(0)) || any(n >= 2 * P.n)) { continue; }
        let xs = (vec3<f32>(n) * 0.5 + vec3<f32>(0.25)) * P.dx;
        let r = x - xs;
        let d2 = dot(r, r) / (R * R);
        if (d2 >= 1.0) { continue; }
        let k = (1.0 - d2) * (1.0 - d2) * (1.0 - d2);
        let c = vec3<i32>(n.x >> 1u, n.y >> 1u, n.z >> 1u);
        if (bandNearR[linIdx(c)] == 0u) { continue; }
        let b = latBase(c, n - 2 * c);
        let v = vec4<f32>(k, k * r / P.dx) * LS_SCALE;
        let hi = lsHi(v);
        let lo = lsLo(v);
        for (var q = 0u; q < 4u; q++) { atomicAdd(&latSums[b + q], hi[q]); atomicAdd(&latSums[b + 4u + q], lo[q]); }
      }
    }
  }
}

/// φ at the lattice point for position p (m), p mirrored into the window first (the subsample positions are lattice points).
fn latPhi(p0: vec3<f32>) -> f32 {
  var p = p0;
  for (var a = 0u; a < 3u; a++) {
    if (p[a] < 0.0) { p[a] = -p[a]; }
    if (p[a] > P.extent[a]) { p[a] = 2.0 * P.extent[a] - p[a]; }
  }
  let nn = clamp(vec3<i32>(floor(p / (0.5 * P.dx))), vec3<i32>(0), 2 * P.n - vec3<i32>(1));
  let c = vec3<i32>(nn.x >> 1u, nn.y >> 1u, nn.z >> 1u);
  let b = latBase(c, nn - 2 * c);
  return phiFromSums(vec4<i32>(latSumsR[b], latSumsR[b + 1u], latSumsR[b + 2u], latSumsR[b + 3u]),
                     vec4<i32>(latSumsR[b + 4u], latSumsR[b + 5u], latSumsR[b + 6u], latSumsR[b + 7u]));
}

// ── surface band and volumes ────────────────────────────────────────────────────────────────────────────────────

fn cellClamp(c: vec3<i32>) -> vec3<i32> { return clamp(c, vec3<i32>(0), P.n - vec3<i32>(1)); }
fn liquidAt(c: vec3<i32>) -> bool { return labels[linIdx(cellClamp(c))] == LABEL_FLUID; }

@compute @workgroup_size(256)
fn bandCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let me = liquidAt(c);
  var mixed = 0u;
  for (var dz = -1; dz <= 1; dz++) { for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    if (liquidAt(c + vec3<i32>(dx, dy, dz)) != me) { mixed = 1u; }
  } } }
  band[linIdx(c)] = mixed;
}

/// The cells whose lattice points a band sample can read: a sample is subsampled only if its dx³ cube overlaps a band
/// cell, and its subsamples lie in the cells that cube overlaps — all within one cell of that band cell (mirrored
/// subsamples land in the wall layer of the same cells). latScatter skips every other lattice point, so particles deep
/// inside (or far outside) the liquid do no atomics; the values read are unchanged.
@compute @workgroup_size(256)
fn bandDilate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  var near = 0u;
  for (var dz = -1; dz <= 1; dz++) { for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    if (bandR[linIdx(cellClamp(c + vec3<i32>(dx, dy, dz)))] == 1u) { near = 1u; }
  } } }
  bandNear[linIdx(c)] = near;
}

fn volumeAt(o: vec3<f32>, c: vec3<i32>) -> f32 {
  let cc = o + vec3<f32>(c);
  let lo = vec3<i32>(floor(cc - vec3<f32>(0.5) + vec3<f32>(1e-4)));
  let hi = vec3<i32>(floor(cc + vec3<f32>(0.5) - vec3<f32>(1e-4)));
  var anyBand = false;
  var allLiquid = true;
  for (var z = lo.z; z <= hi.z; z++) { for (var y = lo.y; y <= hi.y; y++) { for (var x = lo.x; x <= hi.x; x++) {
    let m = cellClamp(vec3<i32>(x, y, z));
    if (bandR[linIdx(m)] == 1u) { anyBand = true; }
    if (labels[linIdx(m)] != LABEL_FLUID) { allLiquid = false; }
  } } }
  if (!anyBand) { return select(0.0, 1.0, allLiquid); }
  var v = 0.0;
  for (var k = 0; k < 8; k++) {
    let s = vec3<f32>(f32(k & 1), f32((k >> 1) & 1), f32((k >> 2) & 1)) * 0.5 - vec3<f32>(0.25);
    v += clamp(0.5 - latPhi((cc + s) * P.dx) / (0.5 * P.dx), 0.0, 1.0);
  }
  return v / 8.0;
}

@compute @workgroup_size(256)
fn volumes(@builtin(global_invocation_id) gid: vec3<u32>) {
  // threads: 3·size faces, then 3·size edges, then the window cells
  let t = gid.x;
  let cells = u32(P.n.x * P.n.y * P.n.z);
  if (t < 3u * P.size) {
    let a = t / P.size;
    let c = logicalOfThread(t % P.size);
    var v = 0.0;
    if (inFaceRange(a, c) && all(c >= vec3<i32>(0))) { v = volumeAt(faceOffset(a), c); }
    volFace[gridBase(a) + slotOf(c)] = v;
  } else if (t < 6u * P.size) {
    let e = (t - 3u * P.size) / P.size;
    let c = logicalOfThread((t - 3u * P.size) % P.size);
    var ext = P.n + vec3<i32>(1);
    ext[e] = P.n[e];
    var o = vec3<f32>(0.0);
    o[e] = 0.5;
    var v = 0.0;
    if (all(c >= vec3<i32>(0)) && all(c < ext)) {
      v = volumeAt(o, c);
      // an edge on a wall plane keeps its in-tank half (a quarter on a corner): the strain reads the wall's ghost face,
      // so the full mirrored volume would count the ghost's share twice and put the no-slip wall dx/4 inside the
      // liquid (flipRef.viscousVolumes)
      for (var b = 0u; b < 3u; b++) { if (b != e && (c[b] == 0 || c[b] == P.n[b])) { v *= 0.5; } }
    }
    volEdge[gridBase(e) + slotOf(c)] = v;
  } else if (t < 6u * P.size + cells) {
    let u = t - 6u * P.size;
    let n = vec3<u32>(P.n);
    let c = vec3<i32>(vec3<u32>(u % n.x, (u / n.x) % n.y, u / (n.x * n.y)));
    volCell[linIdx(c)] = volumeAt(vec3<f32>(0.5), c);
  }
}

// ── μ (harmonic, trilinear kernel) and the sample weights w ─────────────────────────────────────────────────────
// μ = Σw/Σ(w/μ_i) in deterministic sums (the level set's two-word fixed point, common.wgsl). 1/μ spans the table's range
// (water 1e-3 … lava 1e2 Pa·s), so each sample first takes the smallest μ that reaches it (muMinScatter: atomicMax of the
// complemented bits — positive f32 bit patterns order like the values, and a cleared word reads as no particle), then
// sums w and w·μ_min/μ_i ∈ (0, w] (muScatter): μ = μ_min·Σw/Σ(w·μ_min/μ_i). A one-material sample gets its μ exactly: the
// two sums are the same adds, and the ratio and the quotient are taken as 1 where their operands are equal (WGSL f32
// division is accurate to 2.5 ulp, not correctly rounded — measured: x/x left μ 2 ulp high in a one-material box). (f32 compare-exchange sums depended on the order of the adds: two runs of one scene
// differed by 0.3 % in the S3.6f decay, where every other GPU sum is order-independent.)
// Five words per sample: ~bits(μ_min), Σw hi, Σw·μ_min/μ hi, Σw lo, Σw·μ_min/μ lo (fixed-point words as u32 bit patterns:
// the two's-complement adds are the same).

/// first word of family F's sample (0 = cells, solver layout; 1–3 = edges e = F − 1) at c
fn muSlot(F: u32, c: vec3<i32>) -> u32 {
  if (F == 0u) { return 5u * linIdx(c); }
  return 5u * (P.size + (F - 1u) * P.size + slotOf(c));
}

struct MuTap { slot: u32, w: f32, ok: bool }
/// Tap k ∈ [0, 8) of the trilinear stencil of the particle at x (cell units) on family F: the sample's slot and weight.
fn muTap(x: vec3<f32>, F: u32, k: u32) -> MuTap {
  var o = vec3<f32>(0.5);
  var ext = P.n;
  if (F > 0u) { o = vec3<f32>(0.0); o[F - 1u] = 0.5; ext = P.n + vec3<i32>(1); ext[F - 1u] = P.n[F - 1u]; }
  let f = x - o;
  let t = f - floor(f);
  let d = vec3<i32>(i32(k & 1u), i32((k >> 1u) & 1u), i32((k >> 2u) & 1u));
  let c = vec3<i32>(floor(f)) + d;
  var r: MuTap;
  r.slot = 0u; r.w = 0.0; r.ok = false;
  if (any(c < vec3<i32>(0)) || any(c >= ext)) { return r; }
  let wv = select(vec3<f32>(1.0) - t, t, d == vec3<i32>(1));
  r.w = wv.x * wv.y * wv.z;
  r.ok = r.w > 0.0;
  r.slot = muSlot(F, c);
  return r;
}

@compute @workgroup_size(64)
fn muMinScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let key = ~bitcast<u32>(muTableR[aux[q].x]);
  let x = pos[q].xyz / P.dx;
  for (var F = 0u; F < 4u; F++) {
    for (var k = 0u; k < 8u; k++) {
      let tp = muTap(x, F, k);
      if (tp.ok) { atomicMax(&muAcc[tp.slot], key); }
    }
  }
}

@compute @workgroup_size(64)
fn muScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let mu = muTableR[aux[q].x];
  let x = pos[q].xyz / P.dx;
  for (var F = 0u; F < 4u; F++) {
    for (var k = 0u; k < 8u; k++) {
      let tp = muTap(x, F, k);
      if (!tp.ok) { continue; }
      let muMin = bitcast<f32>(~atomicLoad(&muAcc[tp.slot]));
      let v = vec4<f32>(tp.w, tp.w * select(muMin / mu, 1.0, muMin == mu), 0.0, 0.0) * LS_SCALE;
      let hi = lsHi(v);
      let lo = lsLo(v);
      atomicAdd(&muAcc[tp.slot + 1u], bitcast<u32>(hi.x));
      atomicAdd(&muAcc[tp.slot + 2u], bitcast<u32>(hi.y));
      atomicAdd(&muAcc[tp.slot + 3u], bitcast<u32>(lo.x));
      atomicAdd(&muAcc[tp.slot + 4u], bitcast<u32>(lo.y));
    }
  }
}

/// μ at the sample whose words start at s (VP.muDefault where no particle reaches it).
fn muAt(s: u32) -> f32 {
  let key = atomicLoad(&muAcc[s]);
  let w = f32(bitcast<i32>(atomicLoad(&muAcc[s + 1u]))) + f32(bitcast<i32>(atomicLoad(&muAcc[s + 3u]))) / LS_LO_SCALE;
  let m = f32(bitcast<i32>(atomicLoad(&muAcc[s + 2u]))) + f32(bitcast<i32>(atomicLoad(&muAcc[s + 4u]))) / LS_LO_SCALE;
  if (key == 0u || w <= 0.0 || m <= 0.0) { return VP.muDefault; }
  return bitcast<f32>(~key) * select(w / m, 1.0, w == m);
}

/// w = 2μV at cells, μV at edges, μ = Σw/Σ(w/μ) (VP.muDefault where no particle reaches — counted into st[7] by the host
/// through a separate readback of zero-weight samples is not needed: the reference counts them, the GPU reports w only).
@compute @workgroup_size(256)
fn weights(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  let cells = u32(P.n.x * P.n.y * P.n.z);
  if (t < cells) {
    let n = vec3<u32>(P.n);
    let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
    wCell[linIdx(c)] = 2.0 * muAt(muSlot(0u, c)) * volCellR[linIdx(c)];
  } else if (t < cells + 3u * P.size) {
    let e = (t - cells) / P.size;
    let c = logicalOfThread((t - cells) % P.size);
    let es = gridBase(e) + slotOf(c);
    wEdge[es] = muAt(muSlot(e + 1u, c)) * volEdgeR[es];
  }
}

// ── face kinds, the unknown set, the Dirichlet constants ─────────────────────────────────────────────────────────

struct FRef { slot: u32, sign: f32, ok: bool }
/// A face reference with ghost mirrors resolved: ok = false for wall-normal faces and faces outside the range (value 0).
fn resolve(a: u32, c0: vec3<i32>) -> FRef {
  var c = c0;
  var sign = 1.0;
  for (var b = 0u; b < 3u; b++) {
    if (b == a) { continue; }
    if (c[b] == -1) { c[b] = 0; sign *= VP.walls[b]; } else if (c[b] == P.n[b]) { c[b] = P.n[b] - 1; sign *= VP.walls[b]; }
  }
  var r: FRef;
  r.slot = 0u; r.sign = sign; r.ok = false;
  if (!inFaceRange(a, c)) { return r; }
  let s = gridBase(a) + slotOf(c);
  if (faceType[s] == SOLID) { return r; }
  r.slot = s; r.ok = true;
  return r;
}

/// kind: 1 for an open face (not wall-normal, not a ghost, not fully inside the ball) with V_f > 0, else 0 (samples
/// then add their faces with markKinds). Ball faces (S ≥ 1) get 3 here and keep it.
@compute @workgroup_size(256)
fn kindFaces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= 3u * P.size) { return; }
  let a = t / P.size;
  let c = logicalOfThread(t % P.size);
  let s = gridBase(a) + slotOf(c);
  var k = 0u;
  if (inFaceRange(a, c) && all(c >= vec3<i32>(0)) && all(c <= P.n)) {
    let r = resolve(a, c);
    if (r.ok && r.slot == s) {
      if (faceSolid[s] >= 1.0) { k = 3u; } else if (volFaceR[s] > 0.0) { k = 1u; } else { k = 2u; }
    }
  }
  kind[s] = k;
}

fn markUnknown(a: u32, c: vec3<i32>) {
  let r = resolve(a, c);
  if (r.ok && kind[r.slot] == 2u) { kind[r.slot] = 1u; }
}

@compute @workgroup_size(256)
fn kindSamples(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  let cells = u32(P.n.x * P.n.y * P.n.z);
  if (t < cells) {
    let n = vec3<u32>(P.n);
    let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
    if (volCellR[linIdx(c)] <= 0.0) { return; }
    for (var a = 0u; a < 3u; a++) { var e = vec3<i32>(0); e[a] = 1; markUnknown(a, c + e); markUnknown(a, c); }
  } else if (t < cells + 3u * P.size) {
    let e = (t - cells) / P.size;
    let c = logicalOfThread((t - cells) % P.size);
    var ext = P.n + vec3<i32>(1);
    ext[e] = P.n[e];
    if (any(c < vec3<i32>(0)) || any(c >= ext)) { return; }
    if (volEdgeR[gridBase(e) + slotOf(c)] <= 0.0) { return; }
    let a = (e + 1u) % 3u;
    let b = (e + 2u) % 3u;
    var eb = vec3<i32>(0); eb[b] = 1;
    var ea = vec3<i32>(0); ea[a] = 1;
    markUnknown(a, c); markUnknown(a, c - eb); markUnknown(b, c); markUnknown(b, c - ea);
  }
}

/// The Dirichlet constant of each face (kind 2: u*, kind 3: the ball's V, else 0), the mass ρ_f·V_f of the unknowns
/// (ρ_f from ghostCoef's unweighted a_f = Δt/(ρ_f dx²)), and the start value x = u* on the unknowns.
@compute @workgroup_size(256)
fn constants(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= 3u * P.size) { return; }
  let a = t / P.size;
  let c = logicalOfThread(t % P.size);
  let s = gridBase(a) + slotOf(c);
  let k = kindR[s];
  var cv = 0.0;
  if (k == 2u) { cv = uStar[s]; } else if (k == 3u) { cv = sphere[SPH_V + a]; }
  constVal[s] = cv;
  var m = 0.0;
  if (k == 1u) {
    let af = coefRaw[linIdx(c)][a];
    let rho = select(P.rho, P.dt / (af * P.dx * P.dx), af > 0.0);
    m = rho * volFaceR[s];
  }
  massW[s] = m;
  xV[s] = select(0.0, uStar[s], k == 1u);
}

// ── strain → weighted stress; gather ────────────────────────────────────────────────────────────────────────────

/// A face's value: vecIn at the unknowns — the caller passes x or d (homogeneous) or constVal (the constants, with the
/// unknowns zeroed by `constants`' kind test below).
override CONST_MODE: bool = false;
fn val(a: u32, c: vec3<i32>) -> f32 {
  let r = resolve(a, c);
  if (!r.ok) { return 0.0; }
  let k = kindR[r.slot];
  if (CONST_MODE) { return select(r.sign * vecIn[r.slot], 0.0, k == 1u); }
  return select(0.0, r.sign * vecIn[r.slot], k == 1u);
}

@compute @workgroup_size(256)
fn strain(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (stR[ST_CONV] > 0.5) { return; }
  let t = gid.x;
  let cells = u32(P.n.x * P.n.y * P.n.z);
  if (t < cells) {
    let n = vec3<u32>(P.n);
    let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
    let li = linIdx(c);
    let w = wCellR[li];
    for (var a = 0u; a < 3u; a++) {
      var e = vec3<i32>(0); e[a] = 1;
      var sv = 0.0;
      if (w > 0.0) { sv = w * (val(a, c + e) - val(a, c)) / P.dx; }
      stressCell[3u * li + a] = sv;
    }
  } else if (t < cells + 3u * P.size) {
    let e = (t - cells) / P.size;
    let c = logicalOfThread((t - cells) % P.size);
    let s = gridBase(e) + slotOf(c);
    var ext = P.n + vec3<i32>(1);
    ext[e] = P.n[e];
    var sv = 0.0;
    if (all(c >= vec3<i32>(0)) && all(c < ext) && wEdgeR[s] > 0.0) {
      let a = (e + 1u) % 3u;
      let b = (e + 2u) % 3u;
      var eb = vec3<i32>(0); eb[b] = 1;
      var ea = vec3<i32>(0); ea[a] = 1;
      sv = wEdgeR[s] * ((val(a, c) - val(a, c - eb)) / P.dx + (val(b, c) - val(b, c - ea)) / P.dx);
    }
    stressEdge[s] = sv;
  }
}

/// Σ over the samples containing unknown face (a, c) of g·stress (g = the face's net coefficient in that sample).
fn sumStress(a: u32, c: vec3<i32>) -> f32 {
  var sum = 0.0;
  var e = vec3<i32>(0); e[a] = 1;
  for (var side = 0; side < 2; side++) {
    let cc = c - e * (1 - side);           // side 0: cell c − e_a (this face is its + face); side 1: cell c (its − face)
    if (all(cc >= vec3<i32>(0)) && all(cc < P.n)) {
      let g = select(-1.0, 1.0, side == 0) / P.dx;
      let li = linIdx(cc);
      sum += g * stressCellR[3u * li + a];
    }
  }
  for (var k = 1u; k < 3u; k++) {
    let b = (a + k) % 3u;
    let e3 = 3u - a - b;
    var eb = vec3<i32>(0); eb[b] = 1;
    var ext = P.n + vec3<i32>(1);
    ext[e3] = P.n[e3];
    for (var side = 0; side < 2; side++) {
      let ce = c + eb * side;                // side 0: edge c (this face is its +b face); side 1: edge c + e_b (its −b face)
      if (any(ce < vec3<i32>(0)) || any(ce >= ext)) { continue; }
      var g = select(-1.0, 1.0, side == 0) / P.dx;
      // the ghost behind a wall mirrors this face into the same edge: on the b− wall as its −b face, on the b+ wall as +b
      if (side == 0 && c[b] == 0) { g += -VP.walls[b] / P.dx; }
      if (side == 1 && c[b] + 1 == P.n[b]) { g += VP.walls[b] / P.dx; }
      let s = gridBase(e3) + slotOf(ce);
      sum += g * stressEdgeR[s];
    }
  }
  return sum;
}


/// Σ over the samples containing unknown face (a, c) of w·g² (the Jacobi diagonal's viscous part).
fn sumWeight(a: u32, c: vec3<i32>) -> f32 {
  var sum = 0.0;
  var e = vec3<i32>(0); e[a] = 1;
  for (var side = 0; side < 2; side++) {
    let cc = c - e * (1 - side);           // side 0: cell c − e_a (this face is its + face); side 1: cell c (its − face)
    if (all(cc >= vec3<i32>(0)) && all(cc < P.n)) {
      let g = select(-1.0, 1.0, side == 0) / P.dx;
      let li = linIdx(cc);
      sum += wCellR[li] * g * g;
    }
  }
  for (var k = 1u; k < 3u; k++) {
    let b = (a + k) % 3u;
    let e3 = 3u - a - b;
    var eb = vec3<i32>(0); eb[b] = 1;
    var ext = P.n + vec3<i32>(1);
    ext[e3] = P.n[e3];
    for (var side = 0; side < 2; side++) {
      let ce = c + eb * side;                // side 0: edge c (this face is its +b face); side 1: edge c + e_b (its −b face)
      if (any(ce < vec3<i32>(0)) || any(ce >= ext)) { continue; }
      var g = select(-1.0, 1.0, side == 0) / P.dx;
      // the ghost behind a wall mirrors this face into the same edge: on the b− wall as its −b face, on the b+ wall as +b
      if (side == 0 && c[b] == 0) { g += -VP.walls[b] / P.dx; }
      if (side == 1 && c[b] + 1 == P.n[b]) { g += VP.walls[b] / P.dx; }
      let s = gridBase(e3) + slotOf(ce);
      sum += wEdgeR[s] * g * g;
    }
  }
  return sum;
}

@compute @workgroup_size(256)
fn gather(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (stR[ST_CONV] > 0.5) { return; }
  let t = gid.x;
  if (t >= 3u * P.size) { return; }
  let a = t / P.size;
  let c = logicalOfThread(t % P.size);
  let s = gridBase(a) + slotOf(c);
  if (kindR[s] != 1u) { vecOut[s] = 0.0; return; }
  let visc = P.dt * sumStress(a, c);
  vecOut[s] = mass[s] * vecIn[s] + select(visc, -visc, GATHER_MINUS);
}

@compute @workgroup_size(256)
fn diagonal(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= 3u * P.size) { return; }
  let a = t / P.size;
  let c = logicalOfThread(t % P.size);
  let s = gridBase(a) + slotOf(c);
  var d = 0.0;
  if (kindR[s] == 1u) { d = mass[s] + P.dt * sumWeight(a, c); }
  diagW[s] = d;
}

// ── Jacobi-PCG (the same algebra as poisson/cg.wgsl; partials .x = dot, .y = Σr², .z = Σb²) ─────────────────────

var<workgroup> red: array<vec4<f32>, 256>;
/// Once the solve has converged, every remaining iteration kernel returns at entry, whole workgroups at once: one
/// invocation copies the flag, all read it with workgroupUniformLoad BEFORE any barrier (PoissonSolver's solveDone), so
/// a converged iteration costs only its dispatches. (Kernels without barriers return per thread.) Measured before: the
/// dot, update and reduce passes kept reading, writing and reducing — ~0.1 ms per idle iteration at 64³ (viscCost).
var<workgroup> wgDone: u32;
fn solveDone(lid: u32) -> bool {
  if (lid == 0u) { wgDone = select(0u, 1u, stR[ST_CONV] > 0.5); }
  return workgroupUniformLoad(&wgDone) != 0u;
}
/// solveDone for the reduce kernels, which bind the state read-write.
fn solveDoneRW(lid: u32) -> bool {
  if (lid == 0u) { wgDone = select(0u, 1u, st[ST_CONV] > 0.5); }
  return workgroupUniformLoad(&wgDone) != 0u;
}

fn wgSum(lid: u32, v: vec4<f32>) -> vec4<f32> {
  red[lid] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid < s) { red[lid] = red[lid] + red[lid + s]; }
    workgroupBarrier();
  }
  return red[0];
}

/// r = b − A x (qR = A x from strain + gather of x), z = r/diag, d = z; partials: r·z, r·r, b·b.
@compute @workgroup_size(256)
fn pcgInit(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  let s = gid.x;
  var v = vec4<f32>(0.0);
  if (s < 3u * P.size) {
    let r = bR[s] - qR[s];
    let z = select(0.0, r / diagR[s], diagR[s] > 0.0);
    rV[s] = r; zV[s] = z; dV[s] = z;
    v = vec4<f32>(r * z, r * r, bR[s] * bR[s], 0.0);
  }
  let sum = wgSum(lid, v);
  if (lid == 0u) { partials[wg.x] = sum; }
}

/// partials .x = d·q
@compute @workgroup_size(256)
fn pcgDot(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  if (solveDone(lid)) { return; }
  let s = gid.x;
  var v = vec4<f32>(0.0);
  if (s < 3u * P.size) { v = vec4<f32>(dV[s] * qR[s], 0.0, 0.0, 0.0); }
  let sum = wgSum(lid, v);
  if (lid == 0u) { partials[wg.x] = sum; }
}

/// x += αd, r −= αq, z = r/diag; partials: r·z (new), r·r
@compute @workgroup_size(256)
fn pcgUpdate(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  if (solveDone(lid)) { return; }
  let s = gid.x;
  var v = vec4<f32>(0.0);
  if (s < 3u * P.size) {
    let al = select(stR[ST_ALPHA], 0.0, stR[ST_CONV] > 0.5);   // (solveDone returned already; kept as a guard)
    xV[s] += al * dV[s];
    let r = rV[s] - al * qR[s];
    rV[s] = r;
    let z = select(0.0, r / diagR[s], diagR[s] > 0.0);
    zV[s] = z;
    v = vec4<f32>(r * z, r * r, 0.0, 0.0);
  }
  let sum = wgSum(lid, v);
  if (lid == 0u) { partials[wg.x] = sum; }
}

@compute @workgroup_size(256)
fn pcgDupdate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (stR[ST_CONV] > 0.5) { return; }
  let s = gid.x;
  if (s < 3u * P.size) { dV[s] = zV[s] + stR[ST_BETA] * dV[s]; }
}

fn sumPartials(lid: u32) -> vec4<f32> {
  var v = vec4<f32>(0.0);
  for (var i = lid; i < VP.nWg; i += 256u) { v += partials[i]; }
  return wgSum(lid, v);
}
/// after pcgInit: rz, bb; converged if ‖r‖² ≤ tol²·‖b‖²
@compute @workgroup_size(256)
fn reduceInit(@builtin(local_invocation_index) lid: u32) {
  let s = sumPartials(lid);
  if (lid == 0u) {
    st[ST_RZ] = s.x; st[ST_BB] = s.z; st[ST_RR] = s.y; st[ST_IT] = 0.0;
    st[ST_CONV] = select(0.0, 1.0, s.y <= VP.tol2 * s.z);
  }
}
/// after pcgDot: α = rz/(d·q)
@compute @workgroup_size(256)
fn reduceAlpha(@builtin(local_invocation_index) lid: u32) {
  if (solveDoneRW(lid)) { return; }
  let s = sumPartials(lid);
  if (lid == 0u && st[ST_CONV] < 0.5) {
    st[ST_ALPHA] = select(0.0, st[ST_RZ] / s.x, s.x > 0.0); if (s.x <= 0.0) { st[ST_CONV] = 1.0; st[ST_BRK] = 1.0; }
  }
}
/// after pcgUpdate: β = rz'/rz, convergence test, iteration count
@compute @workgroup_size(256)
fn reduceBeta(@builtin(local_invocation_index) lid: u32) {
  if (solveDoneRW(lid)) { return; }
  let s = sumPartials(lid);
  if (lid == 0u && st[ST_CONV] < 0.5) {
    st[ST_BETA] = select(0.0, s.x / st[ST_RZ], st[ST_RZ] != 0.0);
    st[ST_RZ] = s.x; st[ST_RR] = s.y; st[ST_IT] += 1.0;
    if (s.y <= VP.tol2 * st[ST_BB]) { st[ST_CONV] = 1.0; }
  }
}

/// After the loop: count the solve, a cap hit (not converged at the cap), a breakdown (d·q ≤ 0) and the most
/// iterations, in a buffer the host clears only on resetFaults (the page's diagnostics, like PoissonSolver.faults).
@compute @workgroup_size(1)
fn tally() {
  faults[0] += 1u;
  if (stR[ST_CONV] < 0.5) { faults[1] += 1u; }
  if (stR[ST_BRK] > 0.5) { faults[2] += 1u; }
  faults[3] = max(faults[3], u32(stR[ST_IT]));
}

/// u = x on the unknowns that hold liquid (V_f > 0); a mass-less unknown only carries the free surface's zero traction
/// inside the solve and keeps its pre-solve value (flipRef.viscositySolve).
@compute @workgroup_size(256)
fn writeBack(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= 3u * P.size) { return; }
  if (kindR[s] == 1u && volFaceR[s] > 0.0) { uOut[s] = xR[s]; validOut[s] = 1u; }
}
