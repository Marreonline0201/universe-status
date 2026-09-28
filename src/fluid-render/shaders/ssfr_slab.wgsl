// ssfr_slab.wgsl — BENCH PROBE ONLY: an analytic flat layer of liquid in place of the particle splats.
// Writes exactly what the particle passes write — front-surface eye depth, composition id and metres of liquid
// along the view ray — for a still layer filling y ∈ [0, surfaceY] (world units) over the floor, so the real
// blur and composite passes can be checked against closed-form optics (Fresnel, Beer–Lambert, apparent depth)
// without particle noise. Never used by the page's own rendering.

struct SlabParams {
    invProjMatrix: mat4x4<f32>,
    invViewMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    surfaceY: f32,           // world units
    metresPerUnit: f32,
    compId: u32,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> slab: SlabParams;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vi) / 2) * 4.0 - 1.0;
    let y = f32(i32(vi) % 2) * 4.0 - 1.0;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

struct SlabOut {
    @location(0) eyeDepth: f32,
    @location(1) compId: u32,
    @location(2) thicknessM: f32,
};

@fragment
fn fs_main(in: VertexOutput) -> SlabOut {
    let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, 1.0 - 2.0 * in.uv.y);
    let a4 = slab.invProjMatrix * vec4<f32>(ndc, 0.0, 1.0);
    let b4 = slab.invProjMatrix * vec4<f32>(ndc, 1.0, 1.0);
    let ro = (slab.invViewMatrix * vec4<f32>(a4.xyz / a4.w, 1.0)).xyz;
    let rd = normalize((slab.invViewMatrix * vec4<f32>(b4.xyz / b4.w, 1.0)).xyz - ro);
    var out: SlabOut;
    out.eyeDepth = 0.0;
    out.compId = slab.compId;
    out.thicknessM = 0.0;
    if (rd.y < 0.0 && ro.y > slab.surfaceY) {
        let t = (slab.surfaceY - ro.y) / rd.y;
        let p = ro + t * rd;
        out.eyeDepth = -(slab.viewMatrix * vec4<f32>(p, 1.0)).z;
        out.thicknessM = (slab.surfaceY / -rd.y) * slab.metresPerUnit;   // straight chord surface → floor
    }
    return out;
}
