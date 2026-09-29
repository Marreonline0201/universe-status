// sphereCells.wgsl — per window cell (solver layout): x = the sphere's solid fraction of the cell (2×2×2 subsamples),
// y = its kernel-weighted solid volume, the trilinear N of the density projection over the [−dx, dx]³ support with
// 4×4×4 samples (flipRef.sphereFractions cellSolidKernel: the sphere's analogue of the wall compensation f_solid).
// Every window cell is written each substep; the padded ghost cells stay 0 from creation.

@group(0) @binding(1) var<storage, read> sphere: array<f32>;
@group(0) @binding(2) var<storage, read_write> cellSolid: array<vec2<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  var out = vec2<f32>(0.0);
  if (sphere[SPH_ACTIVE] > 0.5) {
    let ctr = vec3<f32>(sphere[0], sphere[1], sphere[2]);
    let R = sphere[SPH_R];
    let x = (vec3<f32>(c) + vec3<f32>(0.5)) * P.dx;
    if (length(x - ctr) <= R + 2.0 * P.dx) {
      out.x = sphereBox(x, ctr, R);
      var kv = 0.0;
      for (var m = 0; m < 64; m++) {
        let o = (vec3<f32>(f32(m & 3), f32((m >> 2) & 3), f32((m >> 4) & 3)) - vec3<f32>(1.5)) * 0.5;   // ±0.25, ±0.75 cells
        let w = (1.0 - abs(o.x)) * (1.0 - abs(o.y)) * (1.0 - abs(o.z));
        kv += w * sphereSub(x + o * P.dx, ctr, R);
      }
      out.y = kv / 8.0;   // Σ N·ΔV/dx³ with ΔV = (dx/2)³: the trilinear kernel integrates to 1
    }
  }
  cellSolid[linIdx(c)] = out;
}
