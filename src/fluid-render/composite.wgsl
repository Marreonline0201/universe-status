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
@group(0) @binding(4) var<uniform> uniforms: CompositeUniforms;

fn computeViewPos(coord: vec2f, depth: f32) -> vec3f {
    var ndc = vec4f(coord * 2.0 - 1.0, 0.0, 1.0);
    ndc.z = uniforms.inv_projection_matrix[2].z + uniforms.inv_projection_matrix[3].z / depth;
    var eye_pos = uniforms.inv_projection_matrix * ndc;
    eye_pos /= eye_pos.w;
    return eye_pos.xyz;
}

@fragment
fn fs(@builtin(position) frag_pos: vec4f, input: FragmentInput) -> @location(0) vec4f {
    var pixel = frag_pos.xy;
    // Sample textures BEFORE any non-uniform branches (WGSL requirement)
    var scene_color = textureSample(scene_texture, texture_sampler, input.uv);
    var depth = abs(textureLoad(depth_texture, vec2u(pixel), 0).r);

    // No fluid — fully transparent, let Three.js canvas show through
    if (depth >= 1e4) {
        discard;
    }

    // §3.2 Pass 4: Normal reconstruction from smoothed depth
    // ∂z/∂x = (depth(x+1,y) - depth(x-1,y)) / 2
    // ∂z/∂y = (depth(x,y+1) - depth(x,y-1)) / 2
    var view_pos = computeViewPos(input.uv, depth);

    var ddx = computeViewPos(input.uv + vec2f(uniforms.texel_size.x, 0.0),
        abs(textureLoad(depth_texture, vec2u(pixel + vec2f(1.0, 0.0)), 0).r)) - view_pos;
    var ddy = computeViewPos(input.uv + vec2f(0.0, uniforms.texel_size.y),
        abs(textureLoad(depth_texture, vec2u(pixel + vec2f(0.0, 1.0)), 0).r)) - view_pos;
    var ddx2 = view_pos - computeViewPos(input.uv - vec2f(uniforms.texel_size.x, 0.0),
        abs(textureLoad(depth_texture, vec2u(pixel - vec2f(1.0, 0.0)), 0).r));
    var ddy2 = view_pos - computeViewPos(input.uv - vec2f(0.0, uniforms.texel_size.y),
        abs(textureLoad(depth_texture, vec2u(pixel - vec2f(0.0, 1.0)), 0).r));

    // Pick the closer neighbor to avoid silhouette artifacts
    if (abs(ddx.z) > abs(ddx2.z)) { ddx = ddx2; }
    if (abs(ddy.z) > abs(ddy2.z)) { ddy = ddy2; }

    var normal = normalize(cross(ddy, ddx));

    // §3.2 Pass 5: Compositing
    var thickness = textureLoad(thickness_texture, vec2u(pixel), 0).r;
    var ray_dir = normalize(view_pos);

    // Fresnel: F = F0 + (1-F0)(1 - N·V)^5
    let F0: f32 = 0.02;
    var fresnel = clamp(F0 + (1.0 - F0) * pow(1.0 - dot(normal, -ray_dir), 5.0), 0.0, 1.0);

    // Refraction: offset background UV (use textureLoad to avoid uniform control flow issue)
    var refract_dir = refract(ray_dir, normal, 1.0 / 1.333);
    var refract_uv = pixel + refract_dir.xy * thickness * 30.0;
    var background = textureLoad(scene_texture, vec2u(clamp(refract_uv, vec2f(0.0), vec2f(f32(textureDimensions(scene_texture).x - 1u), f32(textureDimensions(scene_texture).y - 1u)))), 0);

    // Beer's law absorption: color = exp(-absorption × thickness)
    var diffuse_color = uniforms.fluid_color;
    var transmittance = exp(-uniforms.density * thickness * (1.0 - diffuse_color));
    var refraction_color = background.rgb * transmittance;

    // Reflection: use simple environment color (avoid textureSample in non-uniform flow)
    var reflect_dir = reflect(ray_dir, normal);
    // Simple sky color based on reflection direction instead of cubemap sample
    var sky_color = vec3f(0.05, 0.1, 0.2) + reflect_dir.y * vec3f(0.02, 0.05, 0.1);
    var reflection_color = sky_color;

    // Specular highlight (Blinn-Phong)
    var light_dir = normalize(uniforms.light_dir);
    var H = normalize(light_dir - ray_dir);
    var specular = pow(max(0.0, dot(H, normal)), 250.0);

    // Add fluid's own color (visible even without background)
    var fluid_contribution = diffuse_color * (1.0 - exp(-uniforms.density * thickness * 2.0));

    // Final composite
    var final_color = mix(refraction_color + fluid_contribution, reflection_color, fresnel * 0.5) + vec3f(specular);

    return vec4f(final_color, 1.0);
}
