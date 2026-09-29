// sphereCoef.wgsl — the drop ball's fluid-fraction weights in the pressure operator (Batty, Bertails & Bridson 2007
// eqs. 4–7; flipRef.liquidSystem): every face coefficient a_f is multiplied by w_f = 1 − S_f (a face fully inside the
// sphere drops out of the system), and the ghost-fluid extra diagonal of a LIQUID cell, Σ a_f·w_f·(1 − θ)/θ over its
// liquid–air faces, is recomputed from the weighted coefficients. Reads ghostCoef's unweighted output (faceCoefRaw, a
// copy — the +side face of a cell is its neighbour's −side face, so reading and writing one buffer would race) and
// writes the operator's faceCoef. project.wgsl reads faceCoefRaw: the velocity update stays u −= Δt/(ρ_f·dx)·Δp.

@group(0) @binding(1) var<storage, read> labels: array<u32>;
@group(0) @binding(2) var<storage, read> phiCell: array<f32>;
@group(0) @binding(3) var<storage, read> faceSums: array<i32>;
@group(0) @binding(4) var<storage, read> faceCoefRaw: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> faceCoef: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> faceSolid: array<f32>;

fn facePhi(a: u32, c: vec3<i32>) -> f32 {
  let s = gridBase(a) + slotOf(c);
  return phiFromSums(faceSums[4u * s], faceSums[4u * s + 1u], faceSums[4u * s + 2u], faceSums[4u * s + 3u]);
}

fn weight(a: u32, c: vec3<i32>) -> f32 { return max(0.0, 1.0 - faceSolid[gridBase(a) + slotOf(c)]); }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let raw = faceCoefRaw[li];
  let am = raw.xyz * vec3<f32>(weight(0u, c), weight(1u, c), weight(2u, c));
  var extra = 0.0;
  if (P.ghost == 1u && labels[li] == LABEL_FLUID) {
    let fl = phiCell[li];
    for (var ax = 0u; ax < 3u; ax++) {
      var e = vec3<i32>(0);
      e[ax] = 1;
      if (labels[linIdx(c - e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c - e)]); extra += am[ax] * (1.0 - th) / th; }
      if (labels[linIdx(c + e)] == LABEL_AIR) {
        let th = thetaOf(fl, facePhi(ax, c + e), phiCell[linIdx(c + e)]);
        extra += faceCoefRaw[linIdx(c + e)][ax] * weight(ax, c + e) * (1.0 - th) / th;
      }
    }
  }
  faceCoef[li] = vec4<f32>(am, extra);
}
