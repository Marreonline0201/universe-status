// faceDisplacement.wgsl — δx = −∇ψ on the MAC faces (Kugelstadt eq. 11 with ψ = (Δt²/ρ₀)p₂; flipRef.densityCorrect):
// δ_f = −dx·(ψ̂₊ − ψ̂₋) on non-SOLID faces with a LIQUID cell on either side (ψ̂ = 0 in AIR), 0 on every other face.

@group(0) @binding(1) var<storage, read> faceType: array<u32>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> psi: array<f32>;
@group(0) @binding(4) var<storage, read_write> disp: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }
  let s = gridBase(a) + slotOf(c);
  if (faceType[s] == SOLID) { disp[s] = 0.0; return; }
  var e = vec3<i32>(0);
  e[a] = 1;
  let lm = labels[linIdx(c - e)];
  let lp = labels[linIdx(c)];
  if (lm != LABEL_FLUID && lp != LABEL_FLUID) { disp[s] = 0.0; return; }
  let pm = select(0.0, psi[linIdx(c - e)], lm == LABEL_FLUID);
  let pp = select(0.0, psi[linIdx(c)], lp == LABEL_FLUID);
  disp[s] = -P.dx * (pp - pm);
}
