// prepare.wgsl — build the level-0 operator and the multigrid hierarchy from labels + face coefficients.
// Run once per solve setup (labels change every substep in the sim). All kernels: 1 thread per cell.
//
// Two coefficient arrays per level:
//   nom[p]  = NOMINAL coefficients (a on -x, -y, -z face, 0): label independent. Level 0 = the
//             user's fcoef.xyz; a coarse face's nominal value = (1/4) x mean of the 4 fine nominal
//             values it covers (the 1/4 is h^2 -> (2h)^2).
//   coef[p] = EFFECTIVE operator (e-x, e-y, e-z, diag): e_f = nominal if neither cell of the face
//             is SOLID at THIS level, else 0; diag = sum of the 6 e_f (+ extraDiag on level 0).
// This is McAdams, Sifakis & Teran 2010 §3.2 rediscretisation ("at every level ... a voxelized
// description ... The procedure of Section 3.1 is then followed to construct a discrete Poisson
// operator"): a coarse face is open iff both COARSE cells are non-Neumann, whatever the fine faces
// under it. With a uniform a_f it equals numpy's MG (0.25^l per level) exactly, interior solids
// included (bench/offline/poisson_ref.py VarMG == MG, asserted). The arithmetic mean for varying
// a_f is [PROPOSED]; FINAL-PLAN G0-c decides whether density contrasts need Galerkin coarsening.

// Level 0: effective face coefficients and diagonal.
//   e_f  = a_f if neither adjacent cell is SOLID, else 0        (solid faces dropped, Neumann)
//   diag = sum of e_f over the 6 faces + extraDiag              (only for FLUID; else 0)
// A FLUID cell whose diag comes out <= 0 (all faces solid, no extra term) is not an unknown.
@compute @workgroup_size(256)
fn prep_fine(@builtin(global_invocation_id) gid: vec3<u32>) {
  let L = P.lv[0];
  if (gid.x >= L.n) { return; }
  let c = cellIndex(L, gid.x);
  let sy = L.sy;
  let sz = L.sz;
  let lc = lab[c];
  let a = fcoef[c];
  let open = lc != SOLID;
  nom[c] = vec4<f32>(a.xyz, 0.0);
  let exm = select(0.0, a.x, open && lab[c - 1u] != SOLID);
  let eym = select(0.0, a.y, open && lab[c - sy] != SOLID);
  let ezm = select(0.0, a.z, open && lab[c - sz] != SOLID);
  var diag = 0.0;
  if (lc == FLUID) {
    let exp_ = select(0.0, fcoef[c + 1u].x, lab[c + 1u] != SOLID);
    let eyp = select(0.0, fcoef[c + sy].y, lab[c + sy] != SOLID);
    let ezp = select(0.0, fcoef[c + sz].z, lab[c + sz] != SOLID);
    diag = exp_ + exm + eyp + eym + ezp + ezm + a.w;
    if (!(diag > 0.0)) { diag = 0.0; }
  }
  coef[c] = vec4<f32>(exm, eym, ezm, diag);
}

// Coarse labels (McAdams et al. 2010 §3): AIR (Dirichlet) if ANY of the 8 children is AIR,
// else FLUID if any child is FLUID, else SOLID. Level P.cur -> P.cur + 1.
@compute @workgroup_size(256)
fn prep_labels(@builtin(global_invocation_id) gid: vec3<u32>) {
  let F = P.lv[P.cur];
  let C = P.lv[P.cur + 1u];
  if (gid.x >= C.n) { return; }
  let ijk = cellIJK(C, gid.x);
  var anyAir = false;
  var anyFluid = false;
  for (var dz = 0u; dz < 2u; dz = dz + 1u) {
    for (var dy = 0u; dy < 2u; dy = dy + 1u) {
      for (var dx = 0u; dx < 2u; dx = dx + 1u) {
        let lf = lab[padIndex(F, 2u * ijk.x + dx + 1u, 2u * ijk.y + dy + 1u, 2u * ijk.z + dz + 1u)];
        anyAir = anyAir || lf == AIR;
        anyFluid = anyFluid || lf == FLUID;
      }
    }
  }
  var lc = SOLID;
  if (anyFluid) { lc = FLUID; }
  if (anyAir) { lc = AIR; }
  lab[cellIndex(C, gid.x)] = lc;
}

// Nominal coarse face coefficient: a coarse face covers 4 coplanar fine faces;
//   a_F = (1/4) * mean(nominal a_f over those 4 fine faces) = (1/16) * sum   (see header).
// Reads the FINE level's nominal values (written by the previous dispatch of the prepare pass).
fn coarseFace(F: Lvl, fi: u32, fj: u32, fk: u32, axis: u32) -> f32 {
  // fi,fj,fk: PADDED fine coords of the first child cell whose minus-face lies on the coarse face
  var s = 0.0;
  if (axis == 0u) {
    s = nom[padIndex(F, fi, fj, fk)].x + nom[padIndex(F, fi, fj + 1u, fk)].x
      + nom[padIndex(F, fi, fj, fk + 1u)].x + nom[padIndex(F, fi, fj + 1u, fk + 1u)].x;
  } else if (axis == 1u) {
    s = nom[padIndex(F, fi, fj, fk)].y + nom[padIndex(F, fi + 1u, fj, fk)].y
      + nom[padIndex(F, fi, fj, fk + 1u)].y + nom[padIndex(F, fi + 1u, fj, fk + 1u)].y;
  } else {
    s = nom[padIndex(F, fi, fj, fk)].z + nom[padIndex(F, fi + 1u, fj, fk)].z
      + nom[padIndex(F, fi, fj + 1u, fk)].z + nom[padIndex(F, fi + 1u, fj + 1u, fk)].z;
  }
  return s * (1.0 / 16.0);
}

@compute @workgroup_size(256)
fn prep_coef(@builtin(global_invocation_id) gid: vec3<u32>) {
  let F = P.lv[P.cur];
  let C = P.lv[P.cur + 1u];
  if (gid.x >= C.n) { return; }
  let ijk = cellIJK(C, gid.x);
  let c = cellIndex(C, gid.x);
  let sy = C.sy;
  let sz = C.sz;
  let lc = lab[c];
  let open = lc != SOLID;
  // padded fine coords of child (0,0,0): 2I+1, 2J+1, 2K+1
  let fi = 2u * ijk.x + 1u;
  let fj = 2u * ijk.y + 1u;
  let fk = 2u * ijk.z + 1u;
  let nxm = coarseFace(F, fi, fj, fk, 0u);
  let nym = coarseFace(F, fi, fj, fk, 1u);
  let nzm = coarseFace(F, fi, fj, fk, 2u);
  nom[c] = vec4<f32>(nxm, nym, nzm, 0.0);              // label independent (next level needs it)
  let exm = select(0.0, nxm, open && lab[c - 1u] != SOLID);
  let eym = select(0.0, nym, open && lab[c - sy] != SOLID);
  let ezm = select(0.0, nzm, open && lab[c - sz] != SOLID);
  var diag = 0.0;
  if (lc == FLUID) {
    // plus faces = minus faces of the fine children two cells further along the axis
    let exp_ = select(0.0, coarseFace(F, fi + 2u, fj, fk, 0u), lab[c + 1u] != SOLID);
    let eyp = select(0.0, coarseFace(F, fi, fj + 2u, fk, 1u), lab[c + sy] != SOLID);
    let ezp = select(0.0, coarseFace(F, fi, fj, fk + 2u, 2u), lab[c + sz] != SOLID);
    diag = exp_ + exm + eyp + eym + ezp + ezm;
    if (!(diag > 0.0)) { diag = 0.0; }
  }
  coef[c] = vec4<f32>(exm, eym, ezm, diag);
}
