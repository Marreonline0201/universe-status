// §3.2 SSFR Pass 1: Depth sprites
// Renders each particle as a camera-facing quad with sphere-shaped depth.
// depth(x,y) = particle_z - R * sqrt(1 - x² - y²)
//
// Adapted from WaterBall (MIT license) + structure.md §3.2 lines 1901-1906

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) view_position: vec3f,
    @location(2) world_position: vec3f,
    @location(3) @interpolate(flat) comp_id: u32,
}

struct FragmentInput {
    @location(0) uv: vec2f,
    @location(1) view_position: vec3f,
    @location(2) world_position: vec3f,
    @location(3) @interpolate(flat) comp_id: u32,
}

struct FragmentOutput {
    @location(0) frag_color: vec4f,
    @location(1) comp_id: u32,
    @builtin(frag_depth) frag_depth: f32,
}

struct RenderUniforms {
    texel_size: vec2f,
    sphere_size: f32,
    _pad: f32,
    projection_matrix: mat4x4f,
    view_matrix: mat4x4f,
}

// Particle data — 80 bytes per particle (scalar layout)
struct Particle {
    pos_x: f32, pos_y: f32, pos_z: f32,
    composition_id: u32,
    vel_x: f32, vel_y: f32, vel_z: f32,
    temperature: f32,
    C00: f32, C01: f32, C02: f32,
    C10: f32, C11: f32, C12: f32,
    C20: f32, C21: f32, C22: f32,
    phase: u32,
    _pad0: u32, _pad1: u32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> uniforms: RenderUniforms;

@vertex
fn vs(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    // 6 vertices = 2 triangles = 1 quad
    var corner_positions = array(
        vec2f( 0.5,  0.5),
        vec2f( 0.5, -0.5),
        vec2f(-0.5, -0.5),
        vec2f( 0.5,  0.5),
        vec2f(-0.5, -0.5),
        vec2f(-0.5,  0.5),
    );

    let size = uniforms.sphere_size;
    let corner = vec3f(corner_positions[vertex_index] * size, 0.0);
    let uv = corner_positions[vertex_index] + 0.5;

    let p = particles[instance_index];
    // Use raw MLS-MPM [0,1] positions directly — no coordinate mapping needed.
    // Three.js scene is also set up in [0,1]^3 space.
    let world_pos = vec3f(p.pos_x, p.pos_y, p.pos_z);
    let view_position = (uniforms.view_matrix * vec4f(world_pos, 1.0)).xyz;

    // Billboard: offset in view space so quad always faces camera
    let out_position = uniforms.projection_matrix * vec4f(view_position + corner, 1.0);

    var out: VertexOutput;
    out.position = out_position;
    out.uv = uv;
    out.view_position = view_position;
    out.world_position = world_pos;
    out.comp_id = p.composition_id;
    return out;
}

@fragment
fn fs(input: FragmentInput) -> FragmentOutput {
    var out: FragmentOutput;

    // No box clipping needed — G2P already clamps particles to the domain.

    // Map UV to [-1, 1], compute sphere surface
    var normalxy = input.uv * 2.0 - 1.0;
    var r2 = dot(normalxy, normalxy);
    if (r2 > 1.0) {
        discard;
    }
    var normalz = sqrt(1.0 - r2);

    // §3.2: depth(x,y) = particle_z - R * sqrt(1 - x² - y²)
    var radius = uniforms.sphere_size / 2.0;
    var real_view_pos = vec4f(input.view_position + vec3f(normalxy, normalz) * radius, 1.0);
    var clip_space_pos = uniforms.projection_matrix * real_view_pos;

    out.frag_depth = clip_space_pos.z / clip_space_pos.w;
    out.frag_color = vec4f(real_view_pos.z, 0.0, 0.0, 1.0);
    out.comp_id = input.comp_id;

    return out;
}
