// stokes.wgsl — S3.6e the unified pressure–stress solve (Larionov, Batty & Bridson 2017 "Variational Stokes") on the
// GPU; the f64 reference is flipRef.stokesSolve (spec: vault fluid/realism-2026-09/S3.6e-variational-stokes-spec.md §5).
// Compiled as common.wgsl + viscosity.wgsl + this file (StokesSolver.ts): it reuses viscosity.wgsl's volumes, μ
// (muAt), `resolve` (ghost faces with VP.walls) and the edge/face indexing; its own bindings start at 60.
//   (B K⁻¹ Bᵀ + C) y = B u* + B_V V*,  y = (p, τ) per row,  u = u* − K⁻¹ Bᵀ y,  V = V* − K_V⁻¹ B_Vᵀ y,  F = −dx³ B_Vᵀ y.
// Rows (the vector's storage index r): window cell c → 4·linIdx(c) + k (k = 0 p, 1 + a τ_aa); edge family e at logical
// c → 4·size + gridBase(e) + slotOf(c) (τ on the edge along e). A row exists where its W > 0; it is dead (y ≡ 0, diag 0)
// when a term reaches a free face or when it has no column, no V term and C = 0 (flipRef's drop rules). Every sum is a
// fixed-order workgroup tree (deterministic); ‖r‖∞ is a max (order-independent). No float atomics.
// Face coefficients (skFaces, one vec4 per face slot): (g = 1 − S, gv, K⁻¹, kind); kind 1 unknown (gv = S), 2 V-only
// (below the fluid-mass floor: the face moves with the ball, gv = 1), 3 free (mass-less, non-wall: its rows drop),
// 0 none (wall-normal, ghost slot, outside the range).

struct StokesParams {
  wMin: f32,    // face-mass floor W_min (volume fraction)
  tol: f32,     // stop at ‖r‖∞ ≤ tol (the rows' units W·1/s)
  nWgR: u32,    // workgroups of the row passes (partials)
  nWgF: u32,    // workgroups of the face pass (the V partials)
  warm: u32,    // 1: start from the last solve's y (rows dead now are zeroed)
  ball: u32,    // 1: the ball's V is an unknown (monolithic)
  pad0: u32,
  pad1: u32,
}
@group(0) @binding(60) var<uniform> SP: StokesParams;
@group(0) @binding(61) var<storage, read_write> skFace: array<vec4<f32>>;
@group(0) @binding(62) var<storage, read> skFaceR: array<vec4<f32>>;
@group(0) @binding(63) var<storage, read_write> skRow: array<vec4<f32>>;   // (C or −1 = no row, diag, W, b)
@group(0) @binding(64) var<storage, read> skRowR: array<vec4<f32>>;
@group(0) @binding(65) var<storage, read_write> skY: array<f32>;
@group(0) @binding(67) var<storage, read> skIn: array<f32>;          // the vector the operator multiplies (d or y)
@group(0) @binding(68) var<storage, read_write> skRes: array<f32>;
@group(0) @binding(69) var<storage, read_write> skZ: array<f32>;
@group(0) @binding(70) var<storage, read> skZR: array<f32>;
@group(0) @binding(71) var<storage, read_write> skD: array<f32>;
@group(0) @binding(72) var<storage, read> skDR: array<f32>;
@group(0) @binding(73) var<storage, read_write> skQ: array<f32>;
@group(0) @binding(74) var<storage, read> skQR: array<f32>;
@group(0) @binding(75) var<storage, read_write> skW: array<f32>;     // per face K⁻¹·g·(Bᵀ·in)
@group(0) @binding(76) var<storage, read> skWR: array<f32>;
@group(0) @binding(77) var<storage, read_write> skPart: array<vec4<f32>>;
@group(0) @binding(78) var<storage, read_write> skSt: array<f32>;
@group(0) @binding(79) var<storage, read> skStR: array<f32>;
@group(0) @binding(80) var<storage, read_write> skFaults: array<u32>;   // solves, cap hits, breakdowns, max iterations
@group(0) @binding(81) var<storage, read> skCellSolid: array<vec2<f32>>;
@group(0) @binding(82) var<storage, read_write> skSphere: array<f32>;

/// The loop kernels return once the solve has converged; the init and finish variants run regardless.
override SK_FORCE: bool = false;

// state (skSt): 0 rz, 1 α, 2 β, 3 ‖r₀‖∞, 4 converged, 5 iterations, 6 ‖r‖∞, 7 breakdown, 8–10 wV = K_V⁻¹·B_Vᵀ·in,
// 11–13 B_Vᵀ·in, 14 d·q
const SK_RZ: u32 = 0u;
const SK_ALPHA: u32 = 1u;
const SK_BETA: u32 = 2u;
const SK_R0: u32 = 3u;
const SK_CONV: u32 = 4u;
const SK_IT: u32 = 5u;
const SK_RINF: u32 = 6u;
const SK_BRK: u32 = 7u;
const SK_WV: u32 = 8u;
const SK_BTV: u32 = 11u;

// ── indexing ────────────────────────────────────────────────────────────────────────────────────────────────────

/// Logical cell of a solver-layout (padded, no ring) index.
fn skCellOf(li: u32) -> vec3<i32> {
  let p = vec3<u32>(P.n + vec3<i32>(2));
  return vec3<i32>(i32(li % p.x), i32((li / p.x) % p.y), i32(li / (p.x * p.y))) - vec3<i32>(1);
}
/// Logical coordinates of a grid slot (the inverse of slotOf, ring included).
fn skLogicalOfSlot(s: u32) -> vec3<i32> {
  let p = vec3<u32>(P.n + vec3<i32>(2));
  let q = vec3<i32>(i32(s % p.x), i32((s / p.x) % p.y), i32(s / (p.x * p.y)));
  var c = vec3<i32>(0);
  for (var a = 0u; a < 3u; a++) {
    if (q[a] == 0) { c[a] = -1; }
    else if (q[a] == P.n[a] + 1) { c[a] = P.n[a]; }
    else { c[a] = ((q[a] - 1) - P.ring[a] + P.n[a]) % P.n[a]; }
  }
  return c;
}
fn skInWindow(c: vec3<i32>) -> bool { return all(c >= vec3<i32>(0)) && all(c < P.n); }
fn skEdgeExt(e: u32) -> vec3<i32> { var x = P.n + vec3<i32>(1); x[e] = P.n[e]; return x; }
fn skInEdge(e: u32, c: vec3<i32>) -> bool { return all(c >= vec3<i32>(0)) && all(c < skEdgeExt(e)); }
fn skCellRow(c: vec3<i32>, k: u32) -> u32 { return 4u * linIdx(c) + k; }
fn skEdgeRow(e: u32, c: vec3<i32>) -> u32 { return 4u * P.size + gridBase(e) + slotOf(c); }
fn skUnit(a: u32) -> vec3<i32> { var e = vec3<i32>(0); e[a] = 1; return e; }

struct SkRow { kind: u32, c: vec3<i32>, ok: bool }   // kind 0 p, 1 + a τ_aa, 4 + e edge τ
fn skRowAt(r: u32) -> SkRow {
  var o: SkRow;
  if (r < 4u * P.size) {
    o.kind = r % 4u; o.c = skCellOf(r / 4u); o.ok = skInWindow(o.c);
  } else {
    let t = r - 4u * P.size;
    let e = t / P.size;
    o.kind = 4u + e; o.c = skLogicalOfSlot(t % P.size); o.ok = e < 3u && skInEdge(e, o.c);
  }
  return o;
}
fn skNTerms(kind: u32) -> u32 { if (kind == 0u) { return 6u; } if (kind < 4u) { return 2u; } return 4u; }
struct SkTerm { a: u32, c: vec3<i32>, coef: f32 }   // coef ±1 (× W/dx)
/// Term t of a row (flipRef.stokesSolve addRow order): p: (a, c) +, (a, c + e_a) −; τ_aa: (a, c + e_a) +, (a, c) −;
/// edge e (a = e + 1, b = e + 2 mod 3): (a, c) +, (a, c − e_b) −, (b, c) +, (b, c − e_a) −.
fn skTermOf(kind: u32, c: vec3<i32>, t: u32) -> SkTerm {
  var o: SkTerm;
  if (kind == 0u) {
    o.a = t / 2u;
    if ((t & 1u) == 0u) { o.c = c; o.coef = 1.0; } else { o.c = c + skUnit(o.a); o.coef = -1.0; }
  } else if (kind < 4u) {
    o.a = kind - 1u;
    if (t == 0u) { o.c = c + skUnit(o.a); o.coef = 1.0; } else { o.c = c; o.coef = -1.0; }
  } else {
    let e = kind - 4u;
    let a = (e + 1u) % 3u;
    let b = (e + 2u) % 3u;
    if (t == 0u) { o.a = a; o.c = c; o.coef = 1.0; }
    else if (t == 1u) { o.a = a; o.c = c - skUnit(b); o.coef = -1.0; }
    else if (t == 2u) { o.a = b; o.c = c; o.coef = 1.0; }
    else { o.a = b; o.c = c - skUnit(a); o.coef = -1.0; }
  }
  return o;
}

// ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// Face coefficients: unknown ⇔ the face itself (not a ghost), not a wall, S < 1 and volFace·(1 − S) ≥ W_min, with
/// K⁻¹ = Δt/(ρ_f·volFace·(1 − S)) = a_f·dx²/(volFace·(1 − S)) (ghostCoef's unweighted a_f = Δt/(ρ_f dx²); P.rho where
/// it has none); V-only ⇔ S > 0 and 1 − S < W_min; free ⇔ neither (a non-wall face below the floor).
@compute @workgroup_size(256)
fn skFaces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= 3u * P.size) { return; }
  let a = t / P.size;
  let s = gridBase(a) + (t % P.size);
  let c = skLogicalOfSlot(t % P.size);
  var out = vec4<f32>(0.0);
  if (inFaceRange(a, c)) {
    let r = resolve(a, c);
    if (r.ok && r.slot == s) {
      let S = faceSolid[s];
      let V = volFaceR[s];
      if (S < 1.0 && V * (1.0 - S) >= SP.wMin) {
        var kinv = P.dt / (P.rho * V * (1.0 - S));
        if (skInWindow(c)) {
          let af = coefRaw[linIdx(c)][a];
          if (af > 0.0) { kinv = af * P.dx * P.dx / (V * (1.0 - S)); }
        }
        out = vec4<f32>(1.0 - S, S, kinv, 1.0);
      } else if (S > 0.0 && 1.0 - S < SP.wMin) {
        out = vec4<f32>(0.0, 1.0, 0.0, 2.0);
      } else {
        out = vec4<f32>(0.0, 0.0, 0.0, 3.0);
      }
    }
  }
  skFace[s] = out;
}

/// C and W per row: τ_aa C = W·W_F/(2μ), edge τ C = W·W_F/μ, p C = 0 (W_F = 1 − the ball's solid fraction of the
/// sample: cellSolid at cells, sphereBox at the edge centre); C = −1 marks "no row" (W ≤ 0).
@compute @workgroup_size(256)
fn skRowsC(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= 7u * P.size) { return; }
  let row = skRowAt(r);
  var out = vec4<f32>(-1.0, 0.0, 0.0, 0.0);
  if (row.ok) {
    if (row.kind < 4u) {
      let li = linIdx(row.c);
      let W = volCellR[li];
      if (W > 0.0) {
        var C = 0.0;
        if (row.kind > 0u) { C = W * (1.0 - skCellSolid[li].x) / (2.0 * muAt(muSlot(0u, row.c))); }
        out = vec4<f32>(C, 0.0, W, 0.0);
      }
    } else {
      let e = row.kind - 4u;
      let W = volEdgeR[gridBase(e) + slotOf(row.c)];
      if (W > 0.0) {
        var WF = 1.0;
        if (sphere[SPH_ACTIVE] > 0.5) {
          var x = vec3<f32>(row.c) * P.dx;
          x[e] += 0.5 * P.dx;
          WF = 1.0 - sphereBox(x, vec3<f32>(sphere[0], sphere[1], sphere[2]), sphere[SPH_R]);
        }
        out = vec4<f32>(W * WF / muAt(muSlot(e + 1u, row.c)), 0.0, W, 0.0);
      }
    }
  }
  skRow[r] = out;
}

/// K_V⁻¹ = Δt·dx³/M (the rows are per dx³), M = ρ_s·V_J; 0 without a monolithic ball.
fn skKvInv() -> f32 {
  if (SP.ball == 0u) { return 0.0; }
  return P.dt * P.dx * P.dx * P.dx / (sphere[SPH_DENSITY] * sphere[SPH_VJ]);
}

/// diag, b and liveness per row, with duplicate columns merged before squaring (a wall edge reaches its own face twice
/// through the ghost) and the V coefficients vg summed per axis after the merge (flipRef's hasV): dead if a term reaches
/// a free face, or no column, vg = 0 and C = 0. b = Σ g·u* + vg·V*. y is zeroed on dead rows (and everywhere when cold).
@compute @workgroup_size(256)
fn skRowsB(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= 7u * P.size) { return; }
  var info = skRow[r];
  if (info.x < 0.0) { skRow[r] = vec4<f32>(-1.0, 0.0, 0.0, 0.0); skY[r] = 0.0; return; }
  let row = skRowAt(r);
  let h = info.z / P.dx;
  var slots: array<u32, 6>;
  var gs: array<f32, 6>;
  var nCols = 0u;
  var vg = vec3<f32>(0.0);
  var b = 0.0;
  var dead = false;
  let nt = skNTerms(row.kind);
  for (var t = 0u; t < nt; t++) {
    let tm = skTermOf(row.kind, row.c, t);
    let fr = resolve(tm.a, tm.c);
    if (!fr.ok) { continue; }
    let f = skFaceR[fr.slot];
    let kind = u32(f.w + 0.5);
    let k = tm.coef * fr.sign * h;
    if (kind == 3u) { dead = true; break; }
    if (kind == 1u) {
      let gk = k * f.x;
      b += gk * uStar[fr.slot];
      var m = 0u;
      for (; m < nCols; m++) { if (slots[m] == fr.slot) { break; } }
      if (m == nCols) { slots[m] = fr.slot; gs[m] = 0.0; nCols++; }
      gs[m] += gk;
      vg[tm.a] += k * f.y;
    } else if (kind == 2u) {
      vg[tm.a] += k * f.y;
    }
  }
  let kv = skKvInv();
  if (SP.ball == 0u) { vg = vec3<f32>(0.0); }
  if (!dead && nCols == 0u && all(vg == vec3<f32>(0.0)) && info.x == 0.0) { dead = true; }
  if (dead) { skRow[r] = vec4<f32>(info.x, 0.0, info.z, 0.0); skY[r] = 0.0; return; }
  var d = info.x + dot(vg, vg) * kv;
  for (var m = 0u; m < nCols; m++) { d += gs[m] * gs[m] * skFaceR[slots[m]].z; }
  b += dot(vg, vec3<f32>(sphere[SPH_V], sphere[SPH_V + 1u], sphere[SPH_V + 2u]));
  skRow[r] = vec4<f32>(info.x, d, info.z, b);
  if (SP.warm == 0u) { skY[r] = 0.0; }
}

// ── the operator: skT (faces) → skReduceV → skApply (rows) ─────────────────────────────────────────────────────

var<workgroup> skRed: array<vec4<f32>, 256>;
var<workgroup> skWgFlag: u32;
/// Workgroup-uniform "converged" (loop kernels only; SK_FORCE variants never stop).
fn skDone(lid: u32) -> bool {
  if (SK_FORCE) { return false; }
  if (lid == 0u) { skWgFlag = select(0u, 1u, skStR[SK_CONV] > 0.5); }
  return workgroupUniformLoad(&skWgFlag) != 0u;
}
fn skDoneRW(lid: u32) -> bool {
  if (SK_FORCE) { return false; }
  if (lid == 0u) { skWgFlag = select(0u, 1u, skSt[SK_CONV] > 0.5); }
  return workgroupUniformLoad(&skWgFlag) != 0u;
}
/// Workgroup reduction: x, z, w summed, y maxed.
fn skReduce(lid: u32, v: vec4<f32>) -> vec4<f32> {
  skRed[lid] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid < s) { let o = skRed[lid + s]; let m = skRed[lid]; skRed[lid] = vec4<f32>(m.x + o.x, max(m.y, o.y), m.z + o.z, m.w + o.w); }
    workgroupBarrier();
  }
  return skRed[0];
}
fn skSumPartials(lid: u32, n: u32) -> vec4<f32> {
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var i = lid; i < n; i += 256u) { let o = skPart[i]; v = vec4<f32>(v.x + o.x, max(v.y, o.y), v.z + o.z, v.w + o.w); }
  return skReduce(lid, v);
}
/// Row r's y-value in the vector the operator multiplies (0 for no row: the vector is 0 there).
fn skInAt(r: u32) -> f32 { return skIn[r]; }

/// t_f = Σ over the rows that reach face (a, c) — directly, or through a wall ghost (sumStress's mirror logic) — of
/// coef·(W/dx)·in_r; then skW = K⁻¹·g·t_f on the unknowns, and the V partials gv·t_f per axis (x/y/z of the partial;
/// the face-pass partials use .x .z .w for the axes' sums, .y stays a max slot = 0).
@compute @workgroup_size(256)
fn skT(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  if (skDone(lid)) { return; }
  let t = gid.x;
  var part = vec4<f32>(0.0);
  if (t < 3u * P.size) {
    let a = t / P.size;
    let s = gridBase(a) + (t % P.size);
    let f = skFaceR[s];
    let kind = u32(f.w + 0.5);
    var w = 0.0;
    if (kind == 1u || kind == 2u) {
      let c = skLogicalOfSlot(t % P.size);
      var sum = 0.0;
      // cells c − e_a (this is its + face: p −, τ_aa +) and c (its − face: p +, τ_aa −)
      let ea = skUnit(a);
      for (var side = 0; side < 2; side++) {
        let cc = c - ea * (1 - side);
        if (!skInWindow(cc)) { continue; }
        let r0 = skCellRow(cc, 0u);
        let sg = select(-1.0, 1.0, side == 0);
        sum += sg * skRowR[r0].z / P.dx * (skInAt(r0 + 1u + a) - skInAt(r0));
      }
      // edges: for each other axis b, the edge family e3 = 3 − a − b at c (this face +) and at c + e_b (−), with the
      // ghost's mirror on the b walls
      for (var k = 1u; k < 3u; k++) {
        let b = (a + k) % 3u;
        let e3 = 3u - a - b;
        let eb = skUnit(b);
        for (var side = 0; side < 2; side++) {
          let ce = c + eb * side;
          if (!skInEdge(e3, ce)) { continue; }
          var g = select(-1.0, 1.0, side == 0);
          if (side == 0 && c[b] == 0) { g += -VP.walls[b]; }
          if (side == 1 && c[b] + 1 == P.n[b]) { g += VP.walls[b]; }
          let r = skEdgeRow(e3, ce);
          sum += g * skRowR[r].z / P.dx * skInAt(r);
        }
      }
      if (kind == 1u) { w = f.z * f.x * sum; }
      let v = f.y * sum;
      if (a == 0u) { part.x = v; } else if (a == 1u) { part.z = v; } else { part.w = v; }
    }
    skW[s] = w;
  }
  let rs = skReduce(lid, part);
  if (lid == 0u) { skPart[wg.x] = rs; }
}

/// B_Vᵀ·in = Σ of the face partials (fixed order), wV = K_V⁻¹·B_Vᵀ·in.
@compute @workgroup_size(256)
fn skReduceV(@builtin(local_invocation_index) lid: u32) {
  if (skDoneRW(lid)) { return; }
  let s = skSumPartials(lid, SP.nWgF);
  if (lid == 0u) {
    let kv = skKvInv();
    let bt = vec3<f32>(s.x, s.z, s.w);
    skSt[SK_BTV] = bt.x; skSt[SK_BTV + 1u] = bt.y; skSt[SK_BTV + 2u] = bt.z;
    skSt[SK_WV] = kv * bt.x; skSt[SK_WV + 1u] = kv * bt.y; skSt[SK_WV + 2u] = kv * bt.z;
  }
}

/// q_r = C·in_r + Σ_t coef·(W/dx)·(g·skW + gv·wV) over the row's terms (0 on rows that are not live); partial in·q.
@compute @workgroup_size(256)
fn skApply(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  if (skDone(lid)) { return; }
  let r = gid.x;
  var part = vec4<f32>(0.0);
  if (r < 7u * P.size) {
    let info = skRowR[r];
    var q = 0.0;
    if (info.y > 0.0) {
      let row = skRowAt(r);
      let h = info.z / P.dx;
      let wV = vec3<f32>(skStR[SK_WV], skStR[SK_WV + 1u], skStR[SK_WV + 2u]);
      var s = info.x * skIn[r];
      let nt = skNTerms(row.kind);
      for (var t = 0u; t < nt; t++) {
        let tm = skTermOf(row.kind, row.c, t);
        let fr = resolve(tm.a, tm.c);
        if (!fr.ok) { continue; }
        let f = skFaceR[fr.slot];
        let k = tm.coef * fr.sign * h;
        s += k * (f.x * skWR[fr.slot] + f.y * wV[tm.a]);
      }
      q = s;
    }
    skQ[r] = q;
    part = vec4<f32>(skIn[r] * q, 0.0, 0.0, 0.0);
  }
  let rs = skReduce(lid, part);
  if (lid == 0u) { skPart[wg.x] = rs; }
}

// ── Jacobi-PCG ──────────────────────────────────────────────────────────────────────────────────────────────────

/// r = b − A·y (skQR = A·y), z = r/diag, d = z; partials: r·z, max|r|.
@compute @workgroup_size(256)
fn skInit(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  let r = gid.x;
  var part = vec4<f32>(0.0);
  if (r < 7u * P.size) {
    let info = skRowR[r];
    var res = 0.0;
    var z = 0.0;
    if (info.y > 0.0) { res = info.w - skQR[r]; z = res / info.y; }
    skRes[r] = res; skZ[r] = z; skD[r] = z;
    part = vec4<f32>(res * z, abs(res), 0.0, 0.0);
  }
  let rs = skReduce(lid, part);
  if (lid == 0u) { skPart[wg.x] = rs; }
}
@compute @workgroup_size(256)
fn skReduceInit(@builtin(local_invocation_index) lid: u32) {
  let s = skSumPartials(lid, SP.nWgR);
  if (lid == 0u) {
    skSt[SK_RZ] = s.x; skSt[SK_R0] = s.y; skSt[SK_RINF] = s.y; skSt[SK_IT] = 0.0; skSt[SK_BRK] = 0.0;
    skSt[SK_CONV] = select(0.0, 1.0, s.y <= SP.tol);
  }
}
/// α = rz/(d·q)
@compute @workgroup_size(256)
fn skReduceAlpha(@builtin(local_invocation_index) lid: u32) {
  if (skDoneRW(lid)) { return; }
  let s = skSumPartials(lid, SP.nWgR);
  if (lid == 0u) {
    skSt[14] = s.x;
    if (s.x > 0.0) { skSt[SK_ALPHA] = skSt[SK_RZ] / s.x; } else { skSt[SK_ALPHA] = 0.0; skSt[SK_CONV] = 1.0; skSt[SK_BRK] = 1.0; }
  }
}
/// y += α·d, r −= α·q, z = r/diag; partials: r·z, max|r|.
@compute @workgroup_size(256)
fn skUpdate(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  if (skDone(lid)) { return; }
  let r = gid.x;
  var part = vec4<f32>(0.0);
  if (r < 7u * P.size) {
    let al = skStR[SK_ALPHA];
    let diag = skRowR[r].y;
    skY[r] += al * skDR[r];
    let res = skRes[r] - al * skQR[r];
    skRes[r] = res;
    var z = 0.0;
    if (diag > 0.0) { z = res / diag; }
    skZ[r] = z;
    part = vec4<f32>(res * z, abs(res), 0.0, 0.0);
  }
  let rs = skReduce(lid, part);
  if (lid == 0u) { skPart[wg.x] = rs; }
}
/// β = rz'/rz, convergence on ‖r‖∞ ≤ tol, the iteration count
@compute @workgroup_size(256)
fn skReduceBeta(@builtin(local_invocation_index) lid: u32) {
  if (skDoneRW(lid)) { return; }
  let s = skSumPartials(lid, SP.nWgR);
  if (lid == 0u) {
    skSt[SK_BETA] = select(0.0, s.x / skSt[SK_RZ], skSt[SK_RZ] != 0.0);
    skSt[SK_RZ] = s.x; skSt[SK_RINF] = s.y; skSt[SK_IT] += 1.0;
    if (s.y <= SP.tol) { skSt[SK_CONV] = 1.0; }
  }
}
@compute @workgroup_size(256)
fn skDupdate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!SK_FORCE && skStR[SK_CONV] > 0.5) { return; }
  let r = gid.x;
  if (r < 7u * P.size) { skD[r] = skZR[r] + skStR[SK_BETA] * skD[r]; }
}

// ── finish ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// The ball: V = V* − K_V⁻¹·B_Vᵀy, F = −dx³·B_Vᵀy (pressure AND viscous stress), after skT/skReduceV on y.
@compute @workgroup_size(1)
fn skBall() {
  if (SP.ball == 0u) { return; }
  let d3 = P.dx * P.dx * P.dx;
  for (var a = 0u; a < 3u; a++) {
    skSphere[SPH_V + a] = skSphere[SPH_V + a] - skStR[SK_WV + a];
    skSphere[SPH_FORCE + a] = -d3 * skStR[SK_BTV + a];
  }
}
/// u = u* − K⁻¹·g·Bᵀy on the unknowns (valid); the faces the ball carries take its new V (valid); every other non-SOLID
/// face is invalid (the extrapolation that follows fills it, as after a projection).
@compute @workgroup_size(256)
fn skWrite(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= 3u * P.size) { return; }
  let a = t / P.size;
  let s = gridBase(a) + (t % P.size);
  if (faceType[s] == SOLID) { return; }
  let kind = u32(skFaceR[s].w + 0.5);
  if (kind == 1u) { uOut[s] = uOut[s] - skWR[s]; validOut[s] = 1u; }
  else if (kind == 2u && SP.ball == 1u) { uOut[s] = sphere[SPH_V + a]; validOut[s] = 1u; }
  else { validOut[s] = 0u; }
}
@compute @workgroup_size(1)
fn skTally() {
  skFaults[0] += 1u;
  if (skStR[SK_CONV] < 0.5) { skFaults[1] += 1u; }
  if (skStR[SK_BRK] > 0.5) { skFaults[2] += 1u; }
  skFaults[3] = max(skFaults[3], u32(skStR[SK_IT]));
}
