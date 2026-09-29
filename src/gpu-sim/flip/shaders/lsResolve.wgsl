// lsResolve.wgsl — the ghost-fluid labels' treatment of particle-holding cells with φ ≥ 0 (flipRef.classifyLevelSet):
// such a cell stays AIR only where φ resolves its interface — a face-neighbour inside the window has φ < 0 (liquid)
// and another is empty (no particle, φ ≥ 0, not inside the drop ball); otherwise it is LIQUID (enclosed by liquid and
// walls, or a film/sheet one cell thick). The test reads φ and occupancy only, which no invocation writes, so relabelling in place is
// race-free; the SOLID ghost layer (outside the window) and cells mostly inside the ball (solid, not empty space) are
// skipped.

@group(0) @binding(1) var<storage, read> phiCell: array<f32>;
@group(0) @binding(2) var<storage, read> occ: array<u32>;
@group(0) @binding(3) var<storage, read_write> labels: array<u32>;
@group(0) @binding(4) var<storage, read_write> diag: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> cellSolid: array<vec2<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  if (labels[li] != LABEL_AIR || occ[li] == 0u) { return; }
  var bordersLiquid = false;
  var bordersEmpty = false;
  for (var a = 0u; a < 3u; a++) {
    for (var side = -1; side <= 1; side += 2) {
      var e = vec3<i32>(0);
      e[a] = side;
      let m = c + e;
      if (any(m < vec3<i32>(0)) || any(m >= P.n)) { continue; }
      let lm = linIdx(m);
      if (cellSolid[lm].x >= 0.5) { continue; }
      if (phiCell[lm] < 0.0) { bordersLiquid = true; } else if (occ[lm] == 0u) { bordersEmpty = true; }
    }
  }
  if (!(bordersLiquid && bordersEmpty)) {
    labels[li] = LABEL_FLUID;
    atomicAdd(&diag[DIAG_UNRESOLVED_RELABELS], 1u);
  }
}
