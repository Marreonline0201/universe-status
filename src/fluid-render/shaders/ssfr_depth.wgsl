// ssfr_depth.wgsl — SSFR Pass 1: Render particles as screen-space spheres to depth texture
// Each particle is a screen-aligned quad that writes spherical depth

// ── Uniforms ─────────────────────────────────────────────────────────────────
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

// ── Particle data (from MpmGpuSimulator buffer) ─────────────────────────────
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

// ── Vertex output ────────────────────────────────────────────────────────────
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) centerEye: vec3<f32>,    // particle center in eye space
    @location(1) quadOffset: vec2<f32>,    // offset from center in NDC
    @location(2) @interpolate(flat) compId: u32,
    @location(3) @interpolate(flat) temp: f32,
    @location(4) radius_eye: f32,         // radius in eye space
};

// Each particle expands into 4 vertices (quad) via vertex ID
// vertexIndex = particleIndex * 4 + cornerIndex
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

    // Transform to eye space
    let eyePos4 = camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let eyePos = eyePos4.xyz;

    // Quad corners in [-1, 1] space
    var corner: vec2<f32>;
    switch(cornerIdx) {
        case 0u: { corner = vec2<f32>(-1.0, -1.0); }
        case 1u: { corner = vec2<f32>( 1.0, -1.0); }
        case 2u: { corner = vec2<f32>(-1.0,  1.0); }
        default: { corner = vec2<f32>( 1.0,  1.0); }
    }

    // Expand quad in eye space (billboard aligned to camera)
    let r = camera.particleRadius;
    let expandedEye = eyePos + vec3<f32>(corner * r, 0.0);

    // Project to clip space
    out.position = camera.projMatrix * vec4<f32>(expandedEye, 1.0);
    out.centerEye = eyePos;
    out.quadOffset = corner;
    out.compId = p.composition_id;
    out.temp = p.temperature;
    out.radius_eye = r;

    return out;
}

// ── Fragment: write spherical depth ──────────────────────────────────────────
struct FragOutput {
    @builtin(frag_depth) depth: f32,
    @location(0) eyeDepth: f32,          // linear eye-space depth for bilateral blur
    @location(1) compId: u32,            // NEW — per-pixel composition_id for the composite pass
};

@fragment
fn fs_main(in: VertexOutput) -> FragOutput {
    // Discard pixels outside the sphere radius
    let d2 = dot(in.quadOffset, in.quadOffset);
    if (d2 > 1.0) { discard; }

    // Sphere depth offset: z = sqrt(r² - x² - y²)
    let sphereZ = sqrt(1.0 - d2) * in.radius_eye;
    let fragEyeZ = in.centerEye.z + sphereZ; // closer to camera = less negative

    // Convert eye-space Z to NDC depth
    let fragClip = camera.projMatrix * vec4<f32>(in.centerEye.xy, fragEyeZ, 1.0);
    let ndcDepth = fragClip.z / fragClip.w;

    var out: FragOutput;
    out.depth = ndcDepth;
    out.eyeDepth = -fragEyeZ; // store positive linear depth
    out.compId = in.compId;   // NEW — already interpolated (flat) from vs_main, just carried through
    return out;
}
