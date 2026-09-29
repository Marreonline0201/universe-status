// sphereFaces.wgsl — the drop ball's solid fraction S_f of every face's dx³ control volume (flipRef.sphereFractions;
// Batty, Bertails & Bridson 2007 eq. 10 with 2×2×2 supersampling, FINAL-PLAN S3.1c). Every slot of the three face
// grids is written each substep (0 away from the sphere, outside the face range, or with no sphere), so the buffer
// needs no clearing.

@group(0) @binding(1) var<storage, read> sphere: array<f32>;
@group(0) @binding(2) var<storage, read_write> faceSolid: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  let s = gridBase(a) + slotOf(c);
  var v = 0.0;
  if (sphere[SPH_ACTIVE] > 0.5 && inFaceRange(a, c)) {
    let ctr = vec3<f32>(sphere[0], sphere[1], sphere[2]);
    let R = sphere[SPH_R];
    let x = facePos(a, c);
    if (length(x - ctr) <= R + 2.0 * P.dx) { v = sphereBox(x, ctr, R); }
  }
  faceSolid[s] = v;
}
