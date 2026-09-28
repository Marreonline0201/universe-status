// ssfr_bg.wgsl — Background pass: the scene around the fluid (ssfr_scene.wgsl, prepended), seen by the camera.
// Outputs the sRGB-encoded colour (canvas format; the composite passes it through untouched wherever there is
// no fluid, so the background is bit-identical with and without the fluid pipeline) and the eye-space depth of
// the first surface (r32float) for the fluid's occlusion and thickness clipping.

struct BgCamera {
    invProjMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    invViewMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> cam: BgCamera;
@group(0) @binding(1) var<uniform> scene: Scene;

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

struct FragOutput {
    @location(0) color: vec4<f32>,
    @location(1) depth: f32,
};

@fragment
fn fs_main(in: VertexOutput) -> FragOutput {
    let ray = rayThroughNdc(uvToNdc(in.uv), cam.invProjMatrix, cam.invViewMatrix);
    let cone = footprintCone(ray.dir);
    let hit = traceScene(ray.origin, ray.dir, cone);

    // Eye depth of the hit in the fluid depth convention (positive distance along −z); a far sentinel for the
    // void, so "no surface" can never occlude fluid.
    var eyeDepth = 1e6;
    if (hit.t < 1e8) {
        eyeDepth = -(cam.viewMatrix * vec4<f32>(ray.origin + hit.t * ray.dir, 1.0)).z;
    }
    var out: FragOutput;
    out.color = vec4<f32>(srgbEncode(clamp(hit.radiance, vec3<f32>(0.0), vec3<f32>(1.0))), 1.0);
    out.depth = eyeDepth;
    return out;
}
