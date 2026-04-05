// §3.2 SSFR Pass 5: Final composite
// Reconstructs normals from smoothed depth, applies Fresnel reflection,
// Beer's law absorption, refraction, and specular highlights.
//
// structure.md §3.2 lines 1936-1943:
//   — Fresnel reflection: F = F₀ + (1-F₀)(1 - N·V)⁵
//   — Refraction: offset background UV by normal.xy × thickness
//   — Beer's Law absorption: color = exp(-absorption × thickness)
//   — Specular highlights from scene lights
//   — Composite over the scene at the smoothed depth

struct FragmentInput {
    @location(0) uv: vec2f,
    @location(1) iuv: vec2f,
}

struct CompositeUniforms {
    texel_size: vec2f,
    _pad: vec2f,
    inv_projection_matrix: mat4x4f,
    light_dir: vec3f,
    _pad2: f32,
    fluid_color: vec3f,
    density: f32,
}

@group(0) @binding(0) var texture_sampler: sampler;
@group(0) @binding(1) var depth_texture: texture_2d<f32>;
@group(0) @binding(2) var thickness_texture: texture_2d<f32>;
@group(0) @binding(3) var scene_texture: texture_2d<f32>;
@group(0) @binding(4) var env_texture: texture_cube<f32>;
@group(0) @binding(5) var<uniform> uniforms: CompositeUniforms;

fn computeViewPos(coord: vec2f, depth: f32) -> vec3f {
    var ndc = vec4f(coord * 2.0 - 1.0, 0.0, 1.0);
    ndc.z = uniforms.inv_projection_matrix[2].z + uniforms.inv_projection_matrix[3].z / depth;
    var eye_pos = uniforms.inv_projection_matrix * ndc;
    eye_pos /= eye_pos.w;
    return eye_pos.xyz;
}

@fragment
fn fs(input: FragmentInput) -> @location(0) vec4f {
    var depth = abs(textureLoad(depth_texture, vec2u(input.iuv), 0).r);

    // No fluid — pass through scene
    if (depth >= 1e4) {
        return textureSample(scene_texture, texture_sampler, input.uv);
    }

    // §3.2 Pass 4: Normal reconstruction from smoothed depth
    // ∂z/∂x = (depth(x+1,y) - depth(x-1,y)) / 2
    // ∂z/∂y = (depth(x,y+1) - depth(x,y-1)) / 2
    var view_pos = computeViewPos(input.uv, depth);

    var ddx = computeViewPos(input.uv + vec2f(uniforms.texel_size.x, 0.0),
        abs(textureLoad(depth_texture, vec2u(input.iuv + vec2f(1.0, 0.0)), 0).r)) - view_pos;
    var ddy = computeViewPos(input.uv + vec2f(0.0, uniforms.texel_size.y),
        abs(textureLoad(depth_texture, vec2u(input.iuv + vec2f(0.0, 1.0)), 0).r)) - view_pos;
    var ddx2 = view_pos - computeViewPos(input.uv - vec2f(uniforms.texel_size.x, 0.0),
        abs(textureLoad(depth_texture, vec2u(input.iuv - vec2f(1.0, 0.0)), 0).r));
    var ddy2 = view_pos - computeViewPos(input.uv - vec2f(0.0, uniforms.texel_size.y),
        abs(textureLoad(depth_texture, vec2u(input.iuv - vec2f(0.0, 1.0)), 0).r));

    // Pick the closer neighbor to avoid silhouette artifacts
    if (abs(ddx.z) > abs(ddx2.z)) { ddx = ddx2; }
    if (abs(ddy.z) > abs(ddy2.z)) { ddy = ddy2; }

    var normal = normalize(cross(ddy, ddx));

    // §3.2 Pass 5: Compositing
    var thickness = textureLoad(thickness_texture, vec2u(input.iuv), 0).r;
    var ray_dir = normalize(view_pos);

    // Fresnel: F = F0 + (1-F0)(1 - N·V)^5
    let F0: f32 = 0.02;
    var fresnel = clamp(F0 + (1.0 - F0) * pow(1.0 - dot(normal, -ray_dir), 5.0), 0.0, 1.0);

    // Refraction: offset background UV
    var refract_dir = refract(ray_dir, normal, 1.0 / 1.333);
    var refract_uv = input.uv + refract_dir.xy * thickness * 0.03;
    var background = textureSample(scene_texture, texture_sampler, refract_uv);

    // Beer's law absorption: color = exp(-absorption × thickness)
    var diffuse_color = uniforms.fluid_color;
    var transmittance = exp(-uniforms.density * thickness * (1.0 - diffuse_color));
    var refraction_color = background.rgb * transmittance;

    // Reflection from environment
    var reflect_dir = reflect(ray_dir, normal);
    var reflection_color = textureSample(env_texture, texture_sampler, reflect_dir).rgb;

    // Specular highlight (Blinn-Phong)
    var light_dir = normalize(uniforms.light_dir);
    var H = normalize(light_dir - ray_dir);
    var specular = pow(max(0.0, dot(H, normal)), 250.0);

    // Final composite: mix refraction and reflection based on Fresnel
    var final_color = mix(refraction_color, reflection_color, fresnel) + vec3f(specular);

    return vec4f(final_color, 1.0);
}
