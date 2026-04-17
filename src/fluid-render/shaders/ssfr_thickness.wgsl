// ssfr_thickness.wgsl — SSFR Pass 2: Accumulate fluid thickness with additive blending
// Used for Beer-Lambert absorption coloring

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    invProjMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    particleRadius: f32,
    numParticles: u32,
    nearPlane: f32,
    farPlane: f32,
    _pad0: f32,
    _pad1: f32,
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

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) quadOffset: vec2<f32>,
    @location(1) @interpolate(flat) compId: u32,
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
    let worldPos = vec3<f32>(p.pos_x, p.pos_y, p.pos_z);
    let eyePos = (camera.viewMatrix * vec4<f32>(worldPos, 1.0)).xyz;

    var corner: vec2<f32>;
    switch(cornerIdx) {
        case 0u: { corner = vec2<f32>(-1.0, -1.0); }
        case 1u: { corner = vec2<f32>( 1.0, -1.0); }
        case 2u: { corner = vec2<f32>(-1.0,  1.0); }
        default: { corner = vec2<f32>( 1.0,  1.0); }
    }

    let r = camera.particleRadius;
    let expandedEye = eyePos + vec3<f32>(corner * r, 0.0);
    out.position = camera.projMatrix * vec4<f32>(expandedEye, 1.0);
    out.quadOffset = corner;
    out.compId = p.composition_id;

    return out;
}

// Fragment: additive thickness contribution
// The weight falls off from center (sphere profile)
@fragment
fn fs_main(in: VertexOutput) -> @location(0) f32 {
    let d2 = dot(in.quadOffset, in.quadOffset);
    if (d2 > 1.0) { discard; }

    // Sphere thickness: t = 2 * sqrt(r² - d²) / (2r) = sqrt(1 - d²)
    let thickness = sqrt(1.0 - d2) * camera.particleRadius;
    return thickness;
}
