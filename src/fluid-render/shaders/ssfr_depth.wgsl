// ssfr_depth.wgsl — SSFR Pass 1: particles as camera-facing sphere splats → front-surface depth + composition id.
// The splat radius is set by SSFRPipeline from the particle's rest volume (never a fixed world-unit constant), so
// the rendered surface follows the simulated one (r6 flaw 1b; see SSFRPipeline.ts SPLAT_RADIUS_FACTOR).

// ── Uniforms (shared layout with ssfr_thickness.wgsl) ──────────────────────────────────────────────────────
struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    invProjMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    particleRadius: f32,     // splat radius, world units
    numParticles: u32,
    chordToMetres: f32,      // thickness pass: V_p / ((4/3)π r³) × metres per world unit
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ── Particle data (MpmGpuSimulator buffer layout) ─────────────────────────────────────────────────────────
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
    @location(0) centerEye: vec3<f32>,
    @location(1) quadOffset: vec2<f32>,
    @location(2) @interpolate(flat) compId: u32,
};

// vertexIndex = particleIndex * 4 + cornerIndex (index buffer: two triangles per quad)
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
    out.centerEye = eyePos;
    out.quadOffset = corner;
    out.compId = p.composition_id;
    return out;
}

struct FragOutput {
    @builtin(frag_depth) depth: f32,
    @location(0) eyeDepth: f32,          // positive linear eye depth (for the blur and the composite)
    @location(1) compId: u32,            // composition id of the front-most splat
};

@fragment
fn fs_main(in: VertexOutput) -> FragOutput {
    let d2 = dot(in.quadOffset, in.quadOffset);
    if (d2 > 1.0) { discard; }
    let fragEyeZ = in.centerEye.z + sqrt(1.0 - d2) * camera.particleRadius;   // sphere front, toward the camera
    let fragClip = camera.projMatrix * vec4<f32>(in.centerEye.xy, fragEyeZ, 1.0);
    var out: FragOutput;
    out.depth = fragClip.z / fragClip.w;
    out.eyeDepth = -fragEyeZ;
    out.compId = in.compId;
    return out;
}
