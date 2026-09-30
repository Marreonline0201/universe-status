// wallShearApply.wgsl — the floor's wall shear, pass 3 of 3 (FRICTION spec §3.3; flipRef.applyWallShear's update):
// every floor-row particle (⌊y/dx⌋ = 0, binned as wallShearScatter.wgsl does) gets its cell's Δv on its tangential
// components, v_x += Δv_x, v_z += Δv_z — the normal component, the mass and the APIC matrix untouched.

@group(0) @binding(2) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> cellR: array<vec4<f32>>;    // wallShearCell's out: Δv_x, Δv_z, τ, branch

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let c = vec3<i32>(floor(pos[q].xyz / P.dx));
  if (c.y != 0) { return; }
  let d = cellR[u32(clamp(c.x, 0, P.n.x - 1) + P.n.x * clamp(c.z, 0, P.n.z - 1))];
  let v = vel[q];
  vel[q] = vec4<f32>(v.x + d.x, v.y, v.z + d.y, v.w);
}
