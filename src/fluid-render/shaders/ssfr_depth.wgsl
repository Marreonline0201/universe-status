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
    metresPerUnit: f32,      // the ellipsoid thickness pass (its volume factor is per particle)
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

@group(0) @binding(2) var<storage, read> anisoAx: array<vec4<f32>>;   // 3 per particle (AnisoKernel)

// ── Anisotropic ellipsoid splats (SSFRConfig.splatShape 'aniso'; the shapes from AnisoKernel / ssfr_aniso.wgsl) ─────
// The quad is camera-facing at the centre's depth with half-size a_max·|c|/|c_z|·1.01: the tangent cone of the bounding
// sphere cuts that plane in an ellipse stretched radially by 1/cos θ (θ the off-axis angle; up to 1.33 at the page
// camera's corners), and on axis the silhouette needs a·z/√(z² − a²) ≤ 1.002·a at a ≤ 0.02 wu, z ≥ 0.3 wu. Per fragment
// the exact front hit of the view ray on the ellipsoid (x − c)ᵀ M (x − c) = 1, M = Σ ê_k ê_kᵀ / a_k², written through
// m_k = ê_k / a_k in eye space: p = m·d, q = m·c, and the cancellation-free discriminant D = 1 − |q − (p·q/|p|²) p|²
// (plain f32 would lose ~0.4 % of it at |q| ≈ 256 — vault x10).
struct VOutA {
    @builtin(position) position: vec4<f32>,
    @location(0) pEye: vec3<f32>,
    @location(1) @interpolate(flat) cEye: vec3<f32>,
    @location(2) @interpolate(flat) m0: vec3<f32>,
    @location(3) @interpolate(flat) m1: vec3<f32>,
    @location(4) @interpolate(flat) m2: vec3<f32>,
    @location(5) @interpolate(flat) compId: u32,
    @location(6) @interpolate(flat) volF: f32,
};

fn anisoVertex(vertexIndex: u32) -> VOutA {
    let particleIdx = vertexIndex / 4u;
    let cornerIdx = vertexIndex % 4u;
    var out: VOutA;
    if (particleIdx >= camera.numParticles) { out.position = vec4<f32>(0.0, 0.0, -10.0, 1.0); return out; }
    let p = particles[particleIdx];
    let cEye = (camera.viewMatrix * vec4<f32>(p.pos_x, p.pos_y, p.pos_z, 1.0)).xyz;
    if (cEye.z > -1e-4) { out.position = vec4<f32>(0.0, 0.0, -10.0, 1.0); return out; }   // behind the camera
    var aMax = 0.0;
    var m: array<vec3<f32>, 3>;
    for (var k = 0u; k < 3u; k++) {
        let e = anisoAx[3u * particleIdx + k];
        let a = length(e.xyz);
        aMax = max(aMax, a);
        let eEye = (camera.viewMatrix * vec4<f32>(e.xyz, 0.0)).xyz;   // ê_k·a_k in eye space
        m[k] = eEye / (a * a);                                         // ê_k / a_k
    }
    let half = aMax * length(cEye) / (-cEye.z) * 1.01;
    var corner: vec2<f32>;
    switch (cornerIdx) {
        case 0u: { corner = vec2<f32>(-1.0, -1.0); }
        case 1u: { corner = vec2<f32>( 1.0, -1.0); }
        case 2u: { corner = vec2<f32>(-1.0,  1.0); }
        default: { corner = vec2<f32>( 1.0,  1.0); }
    }
    let pEye = cEye + vec3<f32>(corner * half, 0.0);
    out.position = camera.projMatrix * vec4<f32>(pEye, 1.0);
    out.pEye = pEye;
    out.cEye = cEye;
    out.m0 = m[0]; out.m1 = m[1]; out.m2 = m[2];
    out.compId = p.composition_id;
    out.volF = anisoAx[3u * particleIdx].w;
    return out;
}

struct RayHit { ok: bool, t: f32, chord: f32 }
/// The eye ray through this fragment against the ellipsoid: front distance t and the chord length (eye units).
fn rayEllipsoid(in: VOutA) -> RayHit {
    var h: RayHit;
    let d = normalize(in.pEye);
    let pv = vec3<f32>(dot(in.m0, d), dot(in.m1, d), dot(in.m2, d));
    let qv = vec3<f32>(dot(in.m0, in.cEye), dot(in.m1, in.cEye), dot(in.m2, in.cEye));
    let pp = dot(pv, pv);
    let pq = dot(pv, qv);
    let qperp = qv - (pq / pp) * pv;
    let D = 1.0 - dot(qperp, qperp);
    h.ok = D >= 0.0;
    let sp = sqrt(pp);
    let sD = sqrt(max(D, 0.0));
    h.t = pq / pp - sD / sp;
    h.chord = 2.0 * sD / sp;
    return h;
}

@vertex
fn vs_aniso(@builtin(vertex_index) vertexIndex: u32) -> VOutA { return anisoVertex(vertexIndex); }

@fragment
fn fs_aniso(in: VOutA) -> FragOutput {
    let h = rayEllipsoid(in);
    if (!h.ok || h.t <= 0.0) { discard; }
    let hit = normalize(in.pEye) * h.t;
    let fragClip = camera.projMatrix * vec4<f32>(hit, 1.0);
    var out: FragOutput;
    out.depth = fragClip.z / fragClip.w;
    out.eyeDepth = -hit.z;
    out.compId = in.compId;
    return out;
}
