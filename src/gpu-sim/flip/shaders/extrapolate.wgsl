// extrapolate.wgsl — one layer of velocity extrapolation (FINAL-PLAN §5.2 step 11; flipRef.extrapolate).
// Ping-pong (src → dst): a face that is unset in src and not SOLID takes the mean of its set, non-SOLID
// 6-neighbours on the same face grid. Faces set in src, and SOLID faces, are copied through unchanged.
// Reading only src makes the result independent of thread order (the reference's validity ping-pong).

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> uSrc: array<f32>;
@group(0) @binding(3) var<storage, read> validSrc: array<u32>;
@group(0) @binding(4) var<storage, read_write> uDst: array<f32>;
@group(0) @binding(5) var<storage, read_write> validDst: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }
  let s = gridBase(a) + slotOf(c);
  if (validSrc[s] == 1u || faceType[s] == SOLID) {
    uDst[s] = uSrc[s];
    validDst[s] = validSrc[s];
    return;
  }
  var sum = 0.0;
  var cnt = 0u;
  for (var k = 0u; k < 6u; k++) {
    var d = vec3<i32>(0);
    d[k / 2u] = select(-1, 1, (k & 1u) == 1u);
    let nc = c + d;
    if (!inFaceRange(a, nc)) { continue; }
    let ns = gridBase(a) + slotOf(nc);
    if (validSrc[ns] == 1u && faceType[ns] != SOLID) { sum += uSrc[ns]; cnt++; }
  }
  if (cnt > 0u) {
    uDst[s] = sum / f32(cnt);
    validDst[s] = 1u;
  } else {
    uDst[s] = uSrc[s];
    validDst[s] = 0u;
  }
}
