// ghostCoef.wgsl — pressure operator coefficients for the ghost-fluid surface (FINAL-PLAN §5.3, one form only;
// flipRef.liquidSystem with ghost): a_f = Δt/(ρ·dx²) on every face, and for each LIQUID cell the extra diagonal
// a·(1 − θ)/θ summed over its liquid–air faces (Bridson eq. 4.37), so a liquid–air face contributes a/θ in total.
// Layout = PoissonSolver faceCoef: vec4 per padded cell (a on −x, −y, −z faces, extraDiag).

@group(0) @binding(1) var<storage, read> labels: array<u32>;
@group(0) @binding(2) var<storage, read> phiCell: array<f32>;
@group(0) @binding(3) var<storage, read> faceSums: array<i32>;
@group(0) @binding(4) var<storage, read_write> faceCoef: array<vec4<f32>>;

fn facePhi(a: u32, c: vec3<i32>) -> f32 {
  let s = gridBase(a) + slotOf(c);
  return phiFromSums(faceSums[4u * s], faceSums[4u * s + 1u], faceSums[4u * s + 2u], faceSums[4u * s + 3u]);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let a = P.dt / (P.rho * P.dx * P.dx);
  var extra = 0.0;
  if (labels[li] == LABEL_FLUID) {
    let fl = phiCell[li];
    for (var ax = 0u; ax < 3u; ax++) {
      var e = vec3<i32>(0);
      e[ax] = 1;
      if (labels[linIdx(c - e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c - e)]); extra += a * (1.0 - th) / th; }
      if (labels[linIdx(c + e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c + e), phiCell[linIdx(c + e)]); extra += a * (1.0 - th) / th; }
    }
  }
  faceCoef[li] = vec4<f32>(a, a, a, extra);
}
