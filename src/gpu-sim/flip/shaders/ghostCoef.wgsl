// ghostCoef.wgsl — the pressure operator's face coefficients (FINAL-PLAN §5.3; flipRef.faceDensities + liquidSystem):
//   a_f = Δt/(ρ_f·dx²) on every window cell's −x, −y, −z face, with ρ_f = rho (P.variable = 0) or the S3.5 face density
//   ρ_f = ρ_ref·ppc·m̂_f/Σw (P.variable = 1; Σw < wMin → mean of the valid same-grid neighbours → rho, both counted),
//   and, with the ghost-fluid surface (P.ghost = 1, S3.4), each LIQUID cell's extra diagonal a_f·(1 − θ)/θ summed over
//   its liquid–air faces (Bridson eq. 4.37), so a liquid–air face contributes a_f/θ in total.
// Layout = PoissonSolver faceCoef: vec4 per padded cell (a on −x, −y, −z faces, extraDiag). project.wgsl reads the same
// a_f back (Δt/(ρ_f·dx) = a_f·dx), so the matrix and the velocity update can never use different densities.

@group(0) @binding(1) var<storage, read> labels: array<u32>;
@group(0) @binding(2) var<storage, read> phiCell: array<f32>;
@group(0) @binding(3) var<storage, read> faceSums: array<i32>;
@group(0) @binding(4) var<storage, read_write> faceCoef: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> gMass: array<i32>;
@group(0) @binding(6) var<storage, read> gMassLo: array<i32>;
@group(0) @binding(7) var<storage, read> gW: array<i32>;
@group(0) @binding(8) var<storage, read_write> diag: array<atomic<u32>>;

fn facePhi(a: u32, c: vec3<i32>) -> f32 {
  let b = 8u * (gridBase(a) + slotOf(c));
  return phiFromSums(vec4<i32>(faceSums[b], faceSums[b + 1u], faceSums[b + 2u], faceSums[b + 3u]),
                     vec4<i32>(faceSums[b + 4u], faceSums[b + 5u], faceSums[b + 6u], faceSums[b + 7u]));
}

/// The face's own density from its scatter sums, 0 where Σw < wMin (or the face does not exist).
fn ownRho(a: u32, c: vec3<i32>) -> f32 {
  if (!inFaceRange(a, c)) { return 0.0; }
  let s = gridBase(a) + slotOf(c);
  let w = f32(gW[s]) / P.massScale;
  if (w < P.wMin) { return 0.0; }
  var mq = f32(gMass[s]);
  if (PRECISE_P2G) { mq += f32(gMassLo[s]) / LO_SCALE; }
  return P.rhoPpc * (mq / P.massScale) / w;
}

fn faceRho(a: u32, c: vec3<i32>, count: bool) -> f32 {
  if (P.variable == 0u) { return P.rho; }
  let own = ownRho(a, c);
  if (own > 0.0) { return own; }
  var sum = 0.0;
  var cnt = 0.0;
  for (var d = 0u; d < 6u; d++) {
    var e = vec3<i32>(0);
    e[d / 2u] = select(-1, 1, (d & 1u) == 1u);
    let v = ownRho(a, c + e);
    if (v > 0.0) { sum += v; cnt += 1.0; }
  }
  if (cnt > 0.0) {
    if (count) { atomicAdd(&diag[DIAG_RHO_NEIGHBOUR], 1u); }
    return sum / cnt;
  }
  if (count) { atomicAdd(&diag[DIAG_RHO_DEFAULT], 1u); }
  return P.rho;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let k = P.dt / (P.dx * P.dx);
  // fallbacks are counted only on faces of the pressure system (a LIQUID cell on either side)
  let liq = labels[li] == LABEL_FLUID;
  let cx = liq || labels[linIdx(c - vec3<i32>(1, 0, 0))] == LABEL_FLUID;
  let cy = liq || labels[linIdx(c - vec3<i32>(0, 1, 0))] == LABEL_FLUID;
  let cz = liq || labels[linIdx(c - vec3<i32>(0, 0, 1))] == LABEL_FLUID;
  var am = vec3<f32>(k / faceRho(0u, c, cx), k / faceRho(1u, c, cy), k / faceRho(2u, c, cz));
  var extra = 0.0;
  if (P.ghost == 1u && labels[li] == LABEL_FLUID) {
    let fl = phiCell[li];
    for (var ax = 0u; ax < 3u; ax++) {
      var e = vec3<i32>(0);
      e[ax] = 1;
      if (labels[linIdx(c - e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c - e)]); extra += am[ax] * (1.0 - th) / th; }
      if (labels[linIdx(c + e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c + e), phiCell[linIdx(c + e)]); extra += k / faceRho(ax, c + e, false) * (1.0 - th) / th; }
    }
  }
  faceCoef[li] = vec4<f32>(am, extra);
}
