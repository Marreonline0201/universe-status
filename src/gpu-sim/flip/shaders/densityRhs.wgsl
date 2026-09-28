// densityRhs.wgsl — right-hand side of the density (ψ) solve (FINAL-PLAN §5.2 step 3; flipRef.densityCorrect):
//   f̃ = f + f_solid,  f_solid = 1 − Π_axes (1 − 0.125·[SOLID faces of the cell on that axis])   (design C §2.4)
//   f̃ ← clamp(f̃, 0.5, 1.5);  f̃ ← max(f̃, 1) if a 6-neighbour is AIR;  b = f̃ − 1 on LIQUID cells, 0 elsewhere.
// fComp keeps the unclamped f̃ (LIQUID) or the raw f (AIR) for the φ-volume diagnostic.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> vfrac: array<i32>;
@group(0) @binding(4) var<storage, read_write> rhs: array<f32>;
@group(0) @binding(5) var<storage, read_write> fComp: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let f = f32(vfrac[li]) / P.massScale;
  if (labels[li] != LABEL_FLUID) { rhs[li] = 0.0; fComp[li] = f; return; }
  var keep = 1.0;
  var airNbr = false;
  for (var a = 0u; a < 3u; a++) {
    var e = vec3<i32>(0);
    e[a] = 1;
    var solid = 0.0;
    if (faceType[gridBase(a) + slotOf(c)] == SOLID) { solid += 1.0; }
    if (faceType[gridBase(a) + slotOf(c + e)] == SOLID) { solid += 1.0; }
    keep *= 1.0 - 0.125 * solid;
    if (labels[linIdx(c - e)] == LABEL_AIR || labels[linIdx(c + e)] == LABEL_AIR) { airNbr = true; }
  }
  let ft = f + (1.0 - keep);
  fComp[li] = ft;
  var fc = clamp(ft, 0.5, 1.5);
  if (airNbr) { fc = max(fc, 1.0); }
  rhs[li] = fc - 1.0;
}
