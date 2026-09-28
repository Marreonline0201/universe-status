// present.wgsl — copies the solver's SI state into the legacy 80-byte particle layout that the renderer
// (SSFR, Points fallback), the bench readback and every downstream consumer already read
// (MpmGpuSimulator.ts: pos(3) comp(1) vel(3) temp(1) C(9) phase(1) pad(2), in world units and τ).
// This is the ONLY place solver units meet presentation units:
//   world position = x / lRef,   world velocity = v·τ / lRef,   C = c·τ  (rows c_x, c_y, c_z).
// Integers (composition id, phase) live in a u32 buffer and are written as u32 — never routed through an f32,
// where a small id would be a subnormal float that an implementation may flush to zero.

@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> aff: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> aux: array<vec4<u32>>;     // x = composition id, y = phase, z = f32 bits of spawn °C
@group(0) @binding(5) var<storage, read_write> outBuf: array<u32>;  // 20 words per particle

fn putF(i: u32, v: f32) { outBuf[i] = bitcast<u32>(v); }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let o = 20u * q;
  let x = pos[q].xyz / P.lRef;
  putF(o + 0u, x.x);
  putF(o + 1u, x.y);
  putF(o + 2u, x.z);
  outBuf[o + 3u] = aux[q].x;
  let vw = vel[q].xyz * P.tauS / P.lRef;
  putF(o + 4u, vw.x);
  putF(o + 5u, vw.y);
  putF(o + 6u, vw.z);
  outBuf[o + 7u] = aux[q].z;
  for (var a = 0u; a < 3u; a++) {
    let c = aff[3u * q + a].xyz * P.tauS;
    putF(o + 8u + 3u * a, c.x);
    putF(o + 9u + 3u * a, c.y);
    putF(o + 10u + 3u * a, c.z);
  }
  outBuf[o + 17u] = aux[q].y;
  outBuf[o + 18u] = 0u;
  outBuf[o + 19u] = 0u;
}
