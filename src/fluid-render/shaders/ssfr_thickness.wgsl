// ssfr_thickness.wgsl — SSFR Pass 2: liquid path length along each view ray, in METRES, by additive blending.
//
// Volume-normalised (r6 §4): each splat adds its sphere's full chord 2r·√(1−d²) scaled by V_p / ((4/3)πr³), so
// its contribution integrated over the screen is exactly the particle's rest volume V_p whatever the splat radius:
//   Σ_pixels thickness × pixel area = N·V_p   (acceptance test V3).
// The old per-splat half-chord sum overcounted the true path ~34× at rest density because the splats overlap.
// Splats behind the background surface seen in this pixel (e.g. particles hidden behind the ball) are skipped
// (van der Laan et al. 2009: only particles in front of the scene geometry are rendered; r6 flaw 14).

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    invProjMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    particleRadius: f32,
    numParticles: u32,
    chordToMetres: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

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
};

@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var bgDepthTex: texture_2d<f32>;   // eye depth of the background surface (1e6 = void)

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) quadOffset: vec2<f32>,
    @location(1) @interpolate(flat) centerDepth: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let particleIdx = vertexIndex / 4u;
    let cornerIdx = vertexIndex % 4u;
    var out: VertexOutput;
    if (particleIdx >= camera.numParticles) {
        out.position = vec4<f32>(0.0, 0.0, -10.0, 1.0);
        return out;
    }
    let p = particles[particleIdx];
    let eyePos = (camera.viewMatrix * vec4<f32>(p.pos_x, p.pos_y, p.pos_z, 1.0)).xyz;
    var corner: vec2<f32>;
    switch (cornerIdx) {
        case 0u: { corner = vec2<f32>(-1.0, -1.0); }
        case 1u: { corner = vec2<f32>( 1.0, -1.0); }
        case 2u: { corner = vec2<f32>(-1.0,  1.0); }
        default: { corner = vec2<f32>( 1.0,  1.0); }
    }
    out.position = camera.projMatrix * vec4<f32>(eyePos + vec3<f32>(corner * camera.particleRadius, 0.0), 1.0);
    out.quadOffset = corner;
    out.centerDepth = -eyePos.z;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) f32 {
    let d2 = dot(in.quadOffset, in.quadOffset);
    if (d2 > 1.0) { discard; }
    let bgDepth = textureLoad(bgDepthTex, vec2<i32>(in.position.xy), 0).r;
    if (in.centerDepth > bgDepth) { discard; }
    return 2.0 * camera.particleRadius * sqrt(1.0 - d2) * camera.chordToMetres;
}
