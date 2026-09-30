// wallShearScatter.wgsl — the floor's wall shear, pass 1 of 3 (FRICTION spec §3.3; flipRef.applyWallShear's binning):
// every particle of the floor row, ⌊y/dx⌋ = 0, adds to its floor cell (i, k) = (⌊x/dx⌋, ⌊z/dx⌋) — clamped into the
// window, as flipRef's cellIndex — its m̂, 1, m̂·v_x, m̂·v_z and μ·m̂ (μ from its composition's entry of the μ table:
// ViscositySolver's muTable, or the simulator's own), as fixed-point i32 atomics like faceScatter.wgsl: mass and μ·m̂
// at WP.massScale, momentum at WP.momScale (a momentum word at 2^24 would span only ±128 m̂·m/s — eight mercury
// particles overflow it above 9.5 m/s), the two-word form with PRECISE_P2G. m̂ = mass/(ρ_ref·dx³) (vel.w).

@group(0) @binding(2) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> aux: array<vec4<u32>>;       // x = composition id
@group(0) @binding(5) var<storage, read> muTable: array<f32>;         // μ (Pa·s) per composition id
@group(0) @binding(6) var<storage, read_write> acc: array<atomic<i32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let c = vec3<i32>(floor(pos[q].xyz / P.dx));
  if (c.y != 0) { return; }
  let base = WS_WORDS * u32(clamp(c.x, 0, P.n.x - 1) + P.n.x * clamp(c.z, 0, P.n.z - 1));
  let v = vel[q];
  let id = aux[q].x;
  var mu = WP.muDefault;
  if (id < arrayLength(&muTable)) { mu = muTable[id]; }
  let qm = v.w * WP.massScale;
  let qx = v.w * v.x * WP.momScale;
  let qz = v.w * v.z * WP.momScale;
  let qmu = mu * v.w * WP.massScale;
  atomicAdd(&acc[base + WS_MASS], encodeFixed(qm));
  atomicAdd(&acc[base + WS_MX], encodeFixed(qx));
  atomicAdd(&acc[base + WS_MZ], encodeFixed(qz));
  atomicAdd(&acc[base + WS_MU], encodeFixed(qmu));
  atomicAdd(&acc[base + WS_COUNT], 1);
  if (PRECISE_P2G) {
    atomicAdd(&acc[base + WS_LO + WS_MASS], encodeLo(qm));
    atomicAdd(&acc[base + WS_LO + WS_MX], encodeLo(qx));
    atomicAdd(&acc[base + WS_LO + WS_MZ], encodeLo(qz));
    atomicAdd(&acc[base + WS_LO + WS_MU], encodeLo(qmu));
  }
}
