// common.wgsl — shared declarations for the 7-point pressure-Poisson solver.
// Concatenated in front of prepare.wgsl, cg.wgsl and mg.wgsl by PoissonSolver.ts (one module).
//
// Grid convention (FINAL-PLAN §5.2 "ghost padding"):
//   every cell array of level l is stored PADDED, (nx+2)(ny+2)(nz+2) cells, x fastest:
//     p = base + (i+1) + sy*(j+1) + sz*(k+1),  sy = nx+2,  sz = (nx+2)(ny+2)
//   ghost cells are SOLID, carry coef = 0 and value 0, and are never written by a kernel,
//   so the 7-point stencil never needs a bounds check.
// Labels: AIR = 0 (Dirichlet p = 0), FLUID = 1 (unknown), SOLID = 2 (Neumann, face dropped).
// Operator on FLUID cell i (Bridson 2015 §5.4; r1 poisson_bench.Level):
//   (A u)_i = diag_i u_i - sum_{faces f to FLUID nbr j} e_f u_j,
//   diag_i  = sum_{faces f to non-SOLID nbr} e_f + extraDiag_i   (AIR nbrs add to diag only)
// coef[p] = vec4(e_{-x}, e_{-y}, e_{-z}, diag). e_f = 0 on a face touching SOLID.
// diag = 0 marks a cell that is not an unknown (AIR, SOLID, or an isolated FLUID cell).
// Invariant: every solver vector is 0 on non-unknown cells, so the matvec needs no mask.

const AIR: u32 = 0u;
const FLUID: u32 = 1u;
const SOLID: u32 = 2u;
const WG: u32 = 256u;
const OMEGA: f32 = 2.0 / 3.0;          // damped Jacobi weight (McAdams et al. 2010)
const CRIT_INF: u32 = 0u;               // ||r||_inf <= tol   (production, FINAL-PLAN §5.3)
const CRIT_REL2: u32 = 1u;              // ||r||_2 <= tol ||b||_2   (G0-b parity with numpy)

struct Lvl {
  nx: u32, ny: u32, nz: u32, n: u32,        // interior dims, interior cell count
  sy: u32, sz: u32, base: u32, nwg: u32,    // padded strides, offset of this level, workgroups
};

// One 256-byte record per level (static uniform, written once at creation).
struct Params {
  lv: array<Lvl, 7>,
  cur: u32,            // level this bind group is for
  nlev: u32,           // number of MG levels (1 for JPCG)
  tail: u32,           // first level handled by the single-workgroup tail kernel
  coarseSweeps: u32,   // damped-Jacobi sweeps on the coarsest level (fixed; keeps M linear SPD)
  histCap: u32,
  _p0: u32, _p1: u32, _p2: u32,
};

// Per solve configuration (group 1, static uniform owned by a SolveConfig).
struct SolveParams {
  tol: f32,
  criterion: u32,
  _p0: u32, _p1: u32,
};

struct State {
  rz: f32, alpha: f32, beta: f32, pq: f32,
  rinf: f32, r2: f32, b2: f32, rinf0: f32,
  iter: u32, converged: u32, breakdown: u32, _p: u32,
  j0: f32, j1: f32, j2: f32, _p2: f32,     // S3.7 rank term: Ĵ_aᵀv of the vector the next kernel multiplies
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> st: State;
@group(0) @binding(2) var<storage, read_write> part: array<vec4<f32>>;   // per-workgroup partials
@group(0) @binding(3) var<storage, read_write> coef: array<vec4<f32>>;   // all levels
@group(0) @binding(4) var<storage, read_write> lab: array<u32>;          // all levels
@group(0) @binding(5) var<storage, read> fcoef: array<vec4<f32>>;        // user: (a-x, a-y, a-z, extraDiag), level 0
@group(0) @binding(6) var<storage, read_write> vx: array<f32>;           // solution x
@group(0) @binding(7) var<storage, read_write> vd: array<f32>;           // CG search direction d
@group(0) @binding(8) var<storage, read_write> vq: array<f32>;           // q = A d
@group(0) @binding(9) var<storage, read> vb: array<f32>;                 // user: right-hand side b
@group(0) @binding(10) var<storage, read_write> mb: array<f32>;          // MG rhs per level; level 0 = CG residual r
@group(0) @binding(11) var<storage, read_write> mua: array<f32>;         // MG iterate (ping)
@group(0) @binding(12) var<storage, read_write> mub: array<f32>;         // MG iterate (pong); level 0 = z = M r
@group(0) @binding(13) var<storage, read_write> mres: array<f32>;        // MG residual per level
@group(0) @binding(14) var<storage, read_write> hist: array<vec2<f32>>;  // per-iteration (rel2, inf)
@group(0) @binding(15) var<storage, read_write> nom: array<vec4<f32>>;   // nominal face coefficients, all levels
@group(0) @binding(16) var<storage, read_write> flt: array<u32>;         // sticky fault counters (see cg_finalize)
@group(0) @binding(17) var<storage, read> rj: array<vec4<f32>>;           // S3.7: Ĵ_a = √(Δt/(M dx³))·J_a per level-0 cell (xyz)
@group(1) @binding(0) var<uniform> S: SolveParams;

var<workgroup> wg_flag: u32;
var<workgroup> red: array<vec4<f32>, 256>;

// Padded index of interior cell number g (x fastest) on level L.
fn cellIndex(L: Lvl, g: u32) -> u32 {
  let i = g % L.nx;
  let t = g / L.nx;
  let j = t % L.ny;
  let k = t / L.ny;
  return L.base + (i + 1u) + L.sy * (j + 1u) + L.sz * (k + 1u);
}

fn cellIJK(L: Lvl, g: u32) -> vec3<u32> {
  let i = g % L.nx;
  let t = g / L.nx;
  return vec3<u32>(i, t % L.ny, t / L.ny);
}

fn padIndex(L: Lvl, i: u32, j: u32, k: u32) -> u32 {   // i,j,k are PADDED coordinates here
  return L.base + i + L.sy * j + L.sz * k;
}

// Early return for every solve kernel once the solve has converged (FINAL-PLAN §5.1):
// one invocation copies the flag, all read it uniformly BEFORE any other barrier.
fn solveDone(lid: u32) -> bool {
  if (lid == 0u) { wg_flag = st.converged; }
  return workgroupUniformLoad(&wg_flag) != 0u;
}

// Workgroup reduction: (sum, max, sum, sum). Must be called in uniform control flow.
fn wgReduce(lid: u32, v: vec4<f32>) -> vec4<f32> {
  red[lid] = v;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      let a = red[lid];
      let b = red[lid + s];
      red[lid] = vec4<f32>(a.x + b.x, max(a.y, b.y), a.z + b.z, a.w + b.w);
    }
    workgroupBarrier();
  }
  return red[0];
}

// Single-workgroup reduction of the first `count` partials.
fn reducePartials(lid: u32, count: u32) -> vec4<f32> {
  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var i = lid; i < count; i = i + WG) {
    let p = part[i];
    acc = vec4<f32>(acc.x + p.x, max(acc.y, p.y), acc.z + p.z, acc.w + p.w);
  }
  return wgReduce(lid, acc);
}

// inf: absolute. rel2 with b = 0: the relative residual is undefined, so only r = 0 exactly passes
// (a stale warm start is iterated, never accepted; numpy poisson_ref.pcg does the same).
fn converged(rinf: f32, r2: f32, b2: f32) -> bool {
  if (S.criterion == CRIT_INF) { return rinf <= S.tol; }
  return sqrt(r2) <= S.tol * sqrt(b2);
}

// history value; -1 marks "undefined" (b = 0 with r != 0)
fn rel2(r2: f32, b2: f32) -> f32 {
  if (b2 > 0.0) { return sqrt(r2) / sqrt(b2); }
  return select(-1.0, 0.0, r2 == 0.0);
}

// ---- 7-point operator, one copy per vector buffer (WGSL cannot pass storage pointers portably).
// Neighbour order +x, -x, +y, -y, +z, -z matches r1's SHIFTS so f32 rounding tracks numpy.
fn offd(c: u32, sy: u32, sz: u32, k0: vec4<f32>, vp: f32, vm: f32, vyp: f32, vym: f32, vzp: f32, vzm: f32) -> f32 {
  return coef[c + 1u].x * vp + k0.x * vm + coef[c + sy].y * vyp + k0.y * vym + coef[c + sz].z * vzp + k0.z * vzm;
}
fn applyD(c: u32, sy: u32, sz: u32, k0: vec4<f32>) -> f32 {
  return k0.w * vd[c] - offd(c, sy, sz, k0, vd[c + 1u], vd[c - 1u], vd[c + sy], vd[c - sy], vd[c + sz], vd[c - sz]);
}
fn applyUA(c: u32, sy: u32, sz: u32, k0: vec4<f32>) -> f32 {
  return k0.w * mua[c] - offd(c, sy, sz, k0, mua[c + 1u], mua[c - 1u], mua[c + sy], mua[c - sy], mua[c + sz], mua[c - sz]);
}
fn applyUB(c: u32, sy: u32, sz: u32, k0: vec4<f32>) -> f32 {
  return k0.w * mub[c] - offd(c, sy, sz, k0, mub[c + 1u], mub[c - 1u], mub[c + sy], mub[c - sy], mub[c + sz], mub[c - sz]);
}
