// sphereExtendMark.wgsl — one pass of flipRef.extendLiquidIntoSphere: an AIR window cell mostly inside the sphere
// (cell fraction ≥ ½) with a LIQUID face-neighbour becomes LIQUID — else it is a p = 0 vacuum inside the ball that
// pulls the pool in. Marked LABEL_PENDING first and committed by sphereExtendCommit, so each pass sees only the
// previous pass's labels (the reference collects a pass's additions before applying them).

const LABEL_PENDING: u32 = 3u;

@group(0) @binding(1) var<storage, read> cellSolid: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> labels: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  if (labels[li] != LABEL_AIR || cellSolid[li].x < 0.5) { return; }
  var nearLiquid = false;
  for (var a = 0u; a < 3u; a++) {
    for (var side = -1; side <= 1; side += 2) {
      var e = vec3<i32>(0);
      e[a] = side;
      let m = c + e;
      if (any(m < vec3<i32>(0)) || any(m >= P.n)) { continue; }
      if (labels[linIdx(m)] == LABEL_FLUID) { nearLiquid = true; }
    }
  }
  if (nearLiquid) { labels[li] = LABEL_PENDING; }
}
