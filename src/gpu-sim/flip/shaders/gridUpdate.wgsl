// gridUpdate.wgsl — u* = momentum/mass on fluid faces with mass, plus the body force g_a·Δt
// (FINAL-PLAN §5.2 step 8; flipRef.gridUpdate followed by flipRef.applySolidFaces).
// SOLID faces get the wall's normal velocity (static walls: 0) and are marked set here in the same pass —
// extrapolation never uses SOLID faces as sources or targets, so this equals the reference's order.
// One thread per slot of the three concatenated face grids, addressed through the logical index.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> gMass: array<i32>;
@group(0) @binding(3) var<storage, read> gMom: array<i32>;
@group(0) @binding(4) var<storage, read_write> u: array<f32>;
@group(0) @binding(5) var<storage, read_write> valid: array<u32>;
@group(0) @binding(6) var<storage, read_write> diag: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> gMassLo: array<i32>;
@group(0) @binding(8) var<storage, read> gMomLo: array<i32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }     // own-axis index −1 is not a face; its slot is never read
  let s = gridBase(a) + slotOf(c);
  let t = faceType[s];
  if (t == OPEN) { atomicAdd(&diag[DIAG_OPEN_FACES], 1u); }
  if (t == SOLID) { u[s] = 0.0; valid[s] = 1u; return; }
  var mq = f32(gMass[s]);
  var pq = f32(gMom[s]);
  if (PRECISE_P2G) {
    mq += f32(gMassLo[s]) / LO_SCALE;
    pq += f32(gMomLo[s]) / LO_SCALE;
  }
  if (t == FLUID && mq > 0.0) {
    let m = mq / P.massScale;
    let p = pq / P.momScale;
    u[s] = p / m + P.gravity[a] * P.dt;
    valid[s] = 1u;
  } else {
    u[s] = 0.0;
    valid[s] = 0u;
  }
}
