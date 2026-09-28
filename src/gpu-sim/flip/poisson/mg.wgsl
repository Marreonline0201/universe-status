// mg.wgsl — McAdams, Sifakis & Teran 2010 V-cycle used as the CG preconditioner z = M r.
//   levels: n -> n/2 -> ... while n > 4 and even (64 -> 32 -> 16 -> 8 -> 4: 5 levels)
//   smoother: damped Jacobi, omega = 2/3, 2 pre + 2 post sweeps, pre-smoothing starts from u = 0
//   restriction R = B (x) B (x) B, B = [1/8, 3/8, 3/8, 1/8] on fine cells 2I-1, 2I, 2I+1, 2I+2
//   prolongation P = 8 R^T (1-D weights 3/4 parent, 1/4 neighbour), zero outside the grid
//   coarse labels: Dirichlet if ANY child is Dirichlet (prepare.wgsl)
//   coarsest level: a FIXED number of damped-Jacobi sweeps from zero in ONE workgroup, no early
//   exit, so M stays a fixed linear symmetric positive-definite operator (FINAL-PLAN §5.3).
// Levels >= P.tail run inside the single-workgroup tail kernel (8^3 = 512 cells -> 2 cells per
// invocation, then the 4^3 coarse solve); finer levels are one dispatch per step.
// Arithmetic order follows r1 poisson_bench.py (restrict/prolong separable x, y, z; sums in
// SHIFTS order) so f32 results track numpy's float32 run closely.
// Buffers per level (all-level arrays): mb = rhs (level 0: CG residual r), mua/mub = iterate
// ping-pong (final result of every level in mub; level 0 mub = z), mres = residual.

fn u1At(j: u32) -> f32 {                 // first sweep from zero: u1 = omega b / diag
  let dg = coef[j].w;
  if (dg > 0.0) { return OMEGA * mb[j] / dg; }
  return 0.0;
}

// Two damped-Jacobi sweeps from u = 0 in one pass (the first sweep is pointwise, so it is
// recomputed on the fly at the 6 neighbours; same f32 expression as a stored sweep).
fn presmoothCell(L: Lvl, c: u32) {
  let k0 = coef[c];
  if (!(k0.w > 0.0)) { mua[c] = 0.0; return; }
  let sy = L.sy;
  let sz = L.sz;
  let u1c = OMEGA * mb[c] / k0.w;
  let au = k0.w * u1c - offd(c, sy, sz, k0, u1At(c + 1u), u1At(c - 1u), u1At(c + sy), u1At(c - sy), u1At(c + sz), u1At(c - sz));
  mua[c] = u1c + OMEGA * (mb[c] - au) / k0.w;
}

fn residualCell(L: Lvl, c: u32) {
  let k0 = coef[c];
  var r = 0.0;
  if (k0.w > 0.0) { r = mb[c] - applyUA(c, L.sy, L.sz, k0); }
  mres[c] = r;
}

// one damped-Jacobi sweep  u_new = u + omega (b - A u) / diag
fn sweepUBtoUA(L: Lvl, c: u32) {
  let k0 = coef[c];
  var u = 0.0;
  if (k0.w > 0.0) { u = mub[c] + OMEGA * (mb[c] - applyUB(c, L.sy, L.sz, k0)) / k0.w; }
  mua[c] = u;
}
fn sweepUAtoUB(L: Lvl, c: u32) -> f32 {
  let k0 = coef[c];
  var u = 0.0;
  if (k0.w > 0.0) { u = mua[c] + OMEGA * (mb[c] - applyUA(c, L.sy, L.sz, k0)) / k0.w; }
  mub[c] = u;
  return u;
}
fn sweepFromZero(c: u32) { mua[c] = u1At(c); }

fn comb4(e: f32, o: f32, op: f32, en: f32) -> f32 {   // r1 restrict order
  return 0.375 * e + 0.375 * o + 0.125 * op + 0.125 * en;
}

// fine residual (level F) -> coarse rhs (level C), masked to coarse unknowns
fn restrictCell(F: Lvl, C: Lvl, g: u32) {
  let cc = cellIndex(C, g);
  if (!(coef[cc].w > 0.0)) { mb[cc] = 0.0; return; }
  let I = cellIJK(C, g);
  // padded fine coords in r1 order: e = 2I (+1 pad), o = 2I+1, o_prev = 2I-1, e_next = 2I+2
  let xs = vec4<u32>(2u * I.x + 1u, 2u * I.x + 2u, 2u * I.x, 2u * I.x + 3u);
  let ys = vec4<u32>(2u * I.y + 1u, 2u * I.y + 2u, 2u * I.y, 2u * I.y + 3u);
  let zs = vec4<u32>(2u * I.z + 1u, 2u * I.z + 2u, 2u * I.z, 2u * I.z + 3u);
  var uz = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var kz = 0u; kz < 4u; kz = kz + 1u) {
    var uy = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    for (var ky = 0u; ky < 4u; ky = ky + 1u) {
      let row = F.base + F.sy * ys[ky] + F.sz * zs[kz];
      uy[ky] = comb4(mres[row + xs.x], mres[row + xs.y], mres[row + xs.z], mres[row + xs.w]);
    }
    uz[kz] = comb4(uy.x, uy.y, uy.z, uy.w);
  }
  mb[cc] = comb4(uz.x, uz.y, uz.z, uz.w);
}

// fine u (presmoothed, mua) + P * coarse u (mub of level C) -> mub of fine level F
fn prolongCell(F: Lvl, C: Lvl, g: u32) {
  let c = cellIndex(F, g);
  if (!(coef[c].w > 0.0)) { mub[c] = 0.0; return; }
  let f = cellIJK(F, g);
  let I = f / 2u;
  // padded coarse coords of parent (I+1) and neighbour (I or I+2); ghosts hold 0 -> zero outside
  let pi = vec2<u32>(I.x + 1u, select(I.x + 2u, I.x, (f.x & 1u) == 0u));
  let pj = vec2<u32>(I.y + 1u, select(I.y + 2u, I.y, (f.y & 1u) == 0u));
  let pk = vec2<u32>(I.z + 1u, select(I.z + 2u, I.z, (f.z & 1u) == 0u));
  var py = vec2<f32>(0.0, 0.0);
  for (var a = 0u; a < 2u; a = a + 1u) {
    var px = vec2<f32>(0.0, 0.0);
    for (var b = 0u; b < 2u; b = b + 1u) {
      let row = C.base + C.sy * pj[b] + C.sz * pk[a];
      px[b] = 0.75 * mub[row + pi.x] + 0.25 * mub[row + pi.y];
    }
    py[a] = 0.75 * px.x + 0.25 * px.y;
  }
  mub[c] = mua[c] + (0.75 * py.x + 0.25 * py.y);
}

// ---------------------------------------------------------------- per-level dispatches
@compute @workgroup_size(256)
fn mg_presmooth(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[P.cur];
  if (gid.x >= L.n) { return; }
  presmoothCell(L, cellIndex(L, gid.x));
}

@compute @workgroup_size(256)
fn mg_residual(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[P.cur];
  if (gid.x >= L.n) { return; }
  residualCell(L, cellIndex(L, gid.x));
}

@compute @workgroup_size(256)
fn mg_restrict(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let C = P.lv[P.cur + 1u];
  if (gid.x >= C.n) { return; }
  restrictCell(P.lv[P.cur], C, gid.x);
}

@compute @workgroup_size(256)
fn mg_prolong(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let F = P.lv[P.cur];
  if (gid.x >= F.n) { return; }
  prolongCell(F, P.lv[P.cur + 1u], gid.x);
}

@compute @workgroup_size(256)
fn mg_post_ba(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[P.cur];
  if (gid.x >= L.n) { return; }
  sweepUBtoUA(L, cellIndex(L, gid.x));
}

// last post-smoothing sweep; on level 0 it also emits the partial r.z for CG
@compute @workgroup_size(256)
fn mg_post_ab(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[P.cur];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid.x < L.n) {
    let c = cellIndex(L, gid.x);
    let z = sweepUAtoUB(L, c);
    v.x = mb[c] * z;
  }
  if (P.cur == 0u) {
    let s = wgReduce(lid, v);
    if (lid == 0u) { part[gid.x / WG] = s; }
  }
}

// ---------------------------------------------------------------- single-workgroup tail
@compute @workgroup_size(256)
fn mg_tail(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let t = P.tail;
  let nl = P.nlev;
  // down-stroke through the tail levels
  for (var l = t; l + 1u < nl; l = l + 1u) {
    let L = P.lv[l];
    let C = P.lv[l + 1u];
    for (var g = lid; g < L.n; g = g + WG) { presmoothCell(L, cellIndex(L, g)); }
    storageBarrier();
    for (var g = lid; g < L.n; g = g + WG) { residualCell(L, cellIndex(L, g)); }
    storageBarrier();
    for (var g = lid; g < C.n; g = g + WG) { restrictCell(L, C, g); }
    storageBarrier();
  }
  // coarsest level: fixed sweep count from zero (result in mub)
  let Lc = P.lv[nl - 1u];
  for (var g = lid; g < Lc.n; g = g + WG) { sweepFromZero(cellIndex(Lc, g)); }
  storageBarrier();
  for (var s = 2u; s <= P.coarseSweeps; s = s + 1u) {
    if ((s & 1u) == 0u) {
      for (var g = lid; g < Lc.n; g = g + WG) { _ = sweepUAtoUB(Lc, cellIndex(Lc, g)); }
    } else {
      for (var g = lid; g < Lc.n; g = g + WG) { sweepUBtoUA(Lc, cellIndex(Lc, g)); }
    }
    storageBarrier();
  }
  if ((P.coarseSweeps & 1u) == 1u) {
    for (var g = lid; g < Lc.n; g = g + WG) { let c = cellIndex(Lc, g); mub[c] = mua[c]; }
    storageBarrier();
  }
  // up-stroke back to level t
  for (var l = nl - 1u; l > t; l = l - 1u) {
    let F = P.lv[l - 1u];
    let C = P.lv[l];
    for (var g = lid; g < F.n; g = g + WG) { prolongCell(F, C, g); }
    storageBarrier();
    for (var g = lid; g < F.n; g = g + WG) { sweepUBtoUA(F, cellIndex(F, g)); }
    storageBarrier();
    for (var g = lid; g < F.n; g = g + WG) { _ = sweepUAtoUB(F, cellIndex(F, g)); }
    storageBarrier();
  }
}
