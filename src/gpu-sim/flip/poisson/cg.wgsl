// cg.wgsl — preconditioned conjugate gradient (Jacobi or MG preconditioner), f32, direct dispatch.
//
// Iteration k (identical algebra to r1 poisson_bench.pcg):
//   q = A d;  alpha = rz / (d.q);  x += alpha d;  r -= alpha q;  [test ||r||, count k]
//   z = M r;  rz' = r.z;  beta = rz'/rz;  d = z + beta d
// The test runs EVERY iteration on the partial sums produced by the update pass
// (FINAL-PLAN §5.3). Once `st.converged` is set every later kernel returns at entry, so a
// solve can be encoded at a fixed cap K (FINAL-PLAN §5.1) and costs only the dispatch floor
// for the iterations it did not need.
// Partials: .x = sum (dot product), .y = max |r|, .z = sum r^2, .w = sum b^2.

// r = b - A x (x = warm start, neighbours masked because x may hold stale values where the
// labels changed); x := 0 on non-unknowns. Jacobi variant also forms z = r/diag and r.z.
fn initCell(lid: u32, gid: u32, jacobi: bool) {
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid < L.n) {
    let c = cellIndex(L, gid);
    let k0 = coef[c];
    var r = 0.0;
    var z = 0.0;
    if (k0.w > 0.0) {
      let sy = L.sy;
      let sz = L.sz;
      let cxp = coef[c + 1u];
      let cyp = coef[c + sy];
      let czp = coef[c + sz];
      let m = vec3<f32>(coef[c - 1u].w, coef[c - sy].w, coef[c - sz].w);
      var off = 0.0;
      if (cxp.w > 0.0) { off = off + cxp.x * vx[c + 1u]; }
      if (m.x > 0.0) { off = off + k0.x * vx[c - 1u]; }
      if (cyp.w > 0.0) { off = off + cyp.y * vx[c + sy]; }
      if (m.y > 0.0) { off = off + k0.y * vx[c - sy]; }
      if (czp.w > 0.0) { off = off + czp.z * vx[c + sz]; }
      if (m.z > 0.0) { off = off + k0.z * vx[c - sz]; }
      let b = vb[c];
      r = b - (k0.w * vx[c] - off);
      v.w = b * b;
      if (jacobi) { z = r / k0.w; }
    } else {
      vx[c] = 0.0;
    }
    mb[c] = r;
    if (jacobi) { mub[c] = z; }
    v.x = r * z;
    v.y = abs(r);
    v.z = r * r;
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid / WG] = s; }
}

@compute @workgroup_size(256)
fn cg_init_mg(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  initCell(lid, gid.x, false);
}

@compute @workgroup_size(256)
fn cg_init_jacobi(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  initCell(lid, gid.x, true);
}

// Reduce the init partials: iteration 0 test (count 0 when ||r0|| already meets tol).
@compute @workgroup_size(256)
fn cg_init_reduce(@builtin(local_invocation_index) lid: u32) {
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) {
    st.rinf = s.y;
    st.rinf0 = s.y;
    st.r2 = s.z;
    st.b2 = s.w;
    st.rz = s.x;          // Jacobi variant; MG overwrites after its V-cycle
    st.beta = 0.0;
    st.iter = 0u;
    if (P.histCap > 0u) { hist[0] = vec2<f32>(rel2(s.z, s.w), s.y); }
    if (converged(s.y, s.z, s.w)) { st.converged = 1u; }
    if (!(s.y == s.y) || !(s.z == s.z)) { st.breakdown = 1u; st.converged = 1u; }
  }
}

// MG variant: rz = r.z from the partials written by the last level-0 post-smoothing pass.
@compute @workgroup_size(256)
fn cg_rz_init(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) { st.rz = s.x; st.beta = 0.0; }
}

// d = z + beta d   (beta = 0 on the first iteration: d = z exactly, even if d held NaN)
@compute @workgroup_size(256)
fn cg_dupdate(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[0];
  if (gid.x >= L.n) { return; }
  let c = cellIndex(L, gid.x);
  let beta = st.beta;
  if (beta == 0.0) { vd[c] = mub[c]; } else { vd[c] = mub[c] + beta * vd[c]; }
}

// q = A d and partial d.q
@compute @workgroup_size(256)
fn cg_matvec(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid.x < L.n) {
    let c = cellIndex(L, gid.x);
    let k0 = coef[c];
    var q = 0.0;
    if (k0.w > 0.0) { q = applyD(c, L.sy, L.sz, k0); }
    vq[c] = q;
    v.x = vd[c] * q;
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid.x / WG] = s; }
}

@compute @workgroup_size(256)
fn cg_alpha(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) {
    st.pq = s.x;
    let a = st.rz / s.x;
    if (!(s.x > 0.0) || !(a == a)) {
      st.breakdown = 1u;       // d.Ad <= 0 or NaN: stop (A is SPD, so this is a fault)
      st.converged = 1u;
      st.alpha = 0.0;
    } else {
      st.alpha = a;
    }
  }
}

// x += alpha d; r -= alpha q; (Jacobi) z = r/diag. Partials: (r.z, max|r|, r.r, 0).
fn updateCell(lid: u32, gid: u32, jacobi: bool) {
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid < L.n) {
    let c = cellIndex(L, gid);
    let dg = coef[c].w;
    if (dg > 0.0) {
      let a = st.alpha;
      vx[c] = vx[c] + a * vd[c];
      let r = mb[c] - a * vq[c];
      mb[c] = r;
      v.y = abs(r);
      v.z = r * r;
      if (jacobi) {
        let z = r / dg;
        mub[c] = z;
        v.x = r * z;
      }
    }
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid / WG] = s; }
}

@compute @workgroup_size(256)
fn cg_update_jacobi(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  updateCell(lid, gid.x, true);
}

@compute @workgroup_size(256)
fn cg_update_mg(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  updateCell(lid, gid.x, false);
}

// Convergence test of iteration k from the update partials; Jacobi variant also forms beta.
fn checkIter(s: vec4<f32>, formBeta: bool) {
  st.iter = st.iter + 1u;
  st.rinf = s.y;
  st.r2 = s.z;
  if (st.iter < P.histCap) { hist[st.iter] = vec2<f32>(rel2(s.z, st.b2), s.y); }
  if (!(s.y == s.y) || !(s.z == s.z)) { st.breakdown = 1u; st.converged = 1u; return; }
  if (converged(s.y, s.z, st.b2)) { st.converged = 1u; return; }
  if (formBeta) {
    st.beta = s.x / st.rz;
    st.rz = s.x;
  }
}

@compute @workgroup_size(256)
fn cg_check_jacobi(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) { checkIter(s, true); }
}

@compute @workgroup_size(256)
fn cg_check_mg(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) { checkIter(s, false); }
}

// MG: beta from r.z of the V-cycle output.
@compute @workgroup_size(256)
fn cg_beta(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) {
    st.beta = s.x / st.rz;
    st.rz = s.x;
  }
}

// Sticky fault counters, one dispatch at the END of every solve (never early-exits), so a later
// kernel in the SAME frame (validity HUD, sticky-counter pass of FINAL-PLAN §5.7) can see a failed
// solve without a CPU readback. Never cleared by a solve; PoissonSolver.encodeClearFaults resets.
//   flt[0] solves   flt[1] cap hits (not converged at the cap)   flt[2] breakdowns   flt[3] max iterations
@compute @workgroup_size(1)
fn cg_finalize() {
  flt[0] = flt[0] + 1u;
  if (st.breakdown != 0u) { flt[2] = flt[2] + 1u; }
  else if (st.converged == 0u) { flt[1] = flt[1] + 1u; }
  flt[3] = max(flt[3], st.iter);
}

// ── S3.7 the monolithic ball (Batty, Bertails & Bridson 2007 eq. 13; flipRef.solveSystem `rank`) ─────────────────────
// A′ = A + Σ_a Ĵ_a Ĵ_aᵀ with Ĵ_a = √(Δt/(M·dx³))·J_a, J_ac = dx²·Σ sgn·S_f over cell c's faces on axis a (rj, level 0; the
// FLIP side writes it every substep). The three sums Ĵ_aᵀv are packed into the partials' SUM lanes (.x .z .w — .y is
// the max lane) and reduced into st.j0..j2 before the kernel that multiplies. Every read of rj is gated on the solver's
// unknown set (diag > 0), so stale values at non-unknowns never enter. The V-cycle / Jacobi preconditioner stays M(A):
// still SPD; the rank-3 perturbation changes only the iteration count, not the answer.
fn jPart(c: u32, v: f32) -> vec4<f32> { let j = rj[c].xyz * v; return vec4<f32>(j.x, 0.0, j.y, j.z); }
fn rankTerm(c: u32) -> f32 { return dot(rj[c].xyz, vec3<f32>(st.j0, st.j1, st.j2)); }

// partials of Ĵᵀx (the warm start), before the init kernel
@compute @workgroup_size(256)
fn cg_jdot_x(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid.x < L.n) {
    let c = cellIndex(L, gid.x);
    if (coef[c].w > 0.0) { v = jPart(c, vx[c]); }
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid.x / WG] = s; }
}

@compute @workgroup_size(256)
fn cg_jreduce(@builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let s = reducePartials(lid, P.lv[0].nwg);
  if (lid == 0u) { st.j0 = s.x; st.j1 = s.z; st.j2 = s.w; }
}

// r = b − A′x (initCell with the rank term)
fn initCellRank(lid: u32, gid: u32, jacobi: bool) {
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid < L.n) {
    let c = cellIndex(L, gid);
    let k0 = coef[c];
    var r = 0.0;
    var z = 0.0;
    if (k0.w > 0.0) {
      let sy = L.sy;
      let sz = L.sz;
      let cxp = coef[c + 1u];
      let cyp = coef[c + sy];
      let czp = coef[c + sz];
      let m = vec3<f32>(coef[c - 1u].w, coef[c - sy].w, coef[c - sz].w);
      var off = 0.0;
      if (cxp.w > 0.0) { off = off + cxp.x * vx[c + 1u]; }
      if (m.x > 0.0) { off = off + k0.x * vx[c - 1u]; }
      if (cyp.w > 0.0) { off = off + cyp.y * vx[c + sy]; }
      if (m.y > 0.0) { off = off + k0.y * vx[c - sy]; }
      if (czp.w > 0.0) { off = off + czp.z * vx[c + sz]; }
      if (m.z > 0.0) { off = off + k0.z * vx[c - sz]; }
      let b = vb[c];
      r = b - (k0.w * vx[c] - off) - rankTerm(c);
      v.w = b * b;
      if (jacobi) { z = r / k0.w; }
    } else {
      vx[c] = 0.0;
    }
    mb[c] = r;
    if (jacobi) { mub[c] = z; }
    v.x = r * z;
    v.y = abs(r);
    v.z = r * r;
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid / WG] = s; }
}

@compute @workgroup_size(256)
fn cg_init_mg_rank(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  initCellRank(lid, gid.x, false);
}

@compute @workgroup_size(256)
fn cg_init_jacobi_rank(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  initCellRank(lid, gid.x, true);
}

// d = z + beta d, and the partials of Ĵᵀd for the matvec that follows (uniform control flow for the reduction)
@compute @workgroup_size(256)
fn cg_dupdate_rank(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid.x < L.n) {
    let c = cellIndex(L, gid.x);
    let beta = st.beta;
    var d = mub[c];
    if (beta != 0.0) { d = mub[c] + beta * vd[c]; }
    vd[c] = d;
    if (coef[c].w > 0.0) { v = jPart(c, d); }
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid.x / WG] = s; }
}

// q = A′d and partial d.q
@compute @workgroup_size(256)
fn cg_matvec_rank(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (solveDone(lid)) { return; }
  let L = P.lv[0];
  var v = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (gid.x < L.n) {
    let c = cellIndex(L, gid.x);
    let k0 = coef[c];
    var q = 0.0;
    if (k0.w > 0.0) { q = applyD(c, L.sy, L.sz, k0) + rankTerm(c); }
    vq[c] = q;
    v.x = vd[c] * q;
  }
  let s = wgReduce(lid, v);
  if (lid == 0u) { part[gid.x / WG] = s; }
}
