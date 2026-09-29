// fillLiquidFaces.wgsl — before the divergence (flipRef.fillUnsetLiquidFaces): a non-SOLID face of a LIQUID cell that P2G
// left without velocity takes the mean of its P2G-valid 6-neighbours on the same face grid. It happens when f32 puts a
// particle exactly on a face (t = 0): the voxel label floors it into the cell above, whose far face gets weight 0 —
// measured in a settling pool on JPCG (1 face in 720 substeps); the f64 reference never rounds there. Filled faces are
// marked valid = 2 and only valid = 1 faces are read, so the result is independent of thread order. Faces partly inside
// the ball are left to the divergence's sphere rule.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read_write> u: array<f32>;
@group(0) @binding(4) var<storage, read_write> valid: array<u32>;
@group(0) @binding(5) var<storage, read> faceSolid: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }
  let s = gridBase(a) + slotOf(c);
  if (valid[s] != 0u || faceType[s] == SOLID || faceSolid[s] > 0.0) { return; }
  var e = vec3<i32>(0);
  e[a] = 1;
  if (labels[linIdx(c)] != LABEL_FLUID && labels[linIdx(c - e)] != LABEL_FLUID) { return; }
  var sum = 0.0;
  var cnt = 0u;
  for (var k = 0u; k < 6u; k++) {
    var d = vec3<i32>(0);
    d[k / 2u] = select(-1, 1, (k & 1u) == 1u);
    let nc = c + d;
    if (!inFaceRange(a, nc)) { continue; }
    let ns = gridBase(a) + slotOf(nc);
    if (valid[ns] == 1u && faceType[ns] != SOLID) { sum += u[ns]; cnt++; }
  }
  if (cnt > 0u) {
    u[s] = sum / f32(cnt);
    valid[s] = 2u;
  }
}
