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
    F0: f32,                // Fresnel base reflectance (0.02 water, 0.8 mercury)
    emissive_intensity: f32,// Glow strength (0 = none, 1+ = glowing)
    specular_power: f32,    // Blinn-Phong exponent (250 water, 500 mercury)
    metalness: f32,         // 0 = dielectric, 1 = metallic (tints reflections)
}

@group(0) @binding(0) var texture_sampler: sampler;
@group(0) @binding(1) var depth_texture: texture_2d<f32>;
@group(0) @binding(2) var thickness_texture: texture_2d<f32>;
@group(0) @binding(3) var scene_texture: texture_2d<f32>;
@group(0) @binding(4) var<uniform> uniforms: CompositeUniforms;

fn computeViewPos(coord: vec2f, depth: f32) -> vec3f {
    // Reconstruct view-space position from screen UV and eye-space depth.
    // depth = |view.z|, stored by the depth sprite pass.
    // invProj[0].x = aspect/f, invProj[1].y = 1/f
    // view.x = ndc.x * depth * (aspect/f)
    // view.y = ndc.y * depth * (1/f)
    // view.z = -depth
    var ndc = coord * 2.0 - 1.0;
    return vec3f(
        ndc.x * depth * uniforms.inv_projection_matrix[0].x,
        ndc.y * depth * uniforms.inv_projection_matrix[1].y,
        -depth
    );
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

    // §3.2 Pass 5: Compositing — per-material Fresnel, refraction, absorption
    var thickness = textureLoad(thickness_texture, vec2u(pixel), 0).r;
    var ray_dir = normalize(view_pos);
    var NdotV = max(dot(normal, -ray_dir), 0.0);

    // Fresnel: F = F0 + (1-F0)(1 - N·V)^5 — metallic materials use colored F0
    var f0 = uniforms.F0;
    var fresnel = clamp(f0 + (1.0 - f0) * pow(1.0 - NdotV, 5.0), 0.0, 1.0);

    // Refraction: offset background UV — IOR varies (water=1.333, mercury≈infinite, honey=1.5)
    var ior = mix(1.333, 1.0, uniforms.metalness); // metals: no refraction
    var refract_dir = refract(ray_dir, normal, 1.0 / max(ior, 1.001));
    var refract_strength = mix(50.0, 0.0, uniforms.metalness); // metals don't refract
    var refract_uv = pixel + refract_dir.xy * thickness * refract_strength;
    var scene_dims = vec2f(f32(textureDimensions(scene_texture).x - 1u), f32(textureDimensions(scene_texture).y - 1u));
    var background = textureLoad(scene_texture, vec2u(clamp(refract_uv, vec2f(0.0), scene_dims)), 0);

    // Beer's law absorption: color = exp(-absorption × thickness)
    var diffuse_color = uniforms.fluid_color;
    var transmittance = exp(-uniforms.density * thickness * (1.0 - diffuse_color));
    var refraction_color = background.rgb * transmittance;

    // Reflection: procedural environment — brighter for metallic materials
    var reflect_dir = reflect(ray_dir, normal);
    // Gradient sky: dark at bottom, bright at top, with horizon glow
    var sky_up = max(reflect_dir.y, 0.0);
    var sky_down = max(-reflect_dir.y, 0.0);
    var sky_color = mix(vec3f(0.15, 0.2, 0.3), vec3f(0.5, 0.6, 0.8), sky_up)  // ground→sky
                  + vec3f(0.3, 0.25, 0.2) * exp(-8.0 * sky_down)                // warm horizon
                  + vec3f(0.1, 0.1, 0.12) * exp(-3.0 * abs(reflect_dir.y));     // horizon band
    var reflection_color = mix(sky_color, sky_color * diffuse_color, uniforms.metalness);

    // Specular highlights (Blinn-Phong) — primary + rim light
    var light_dir = normalize(uniforms.light_dir);
    var H = normalize(light_dir - ray_dir);
    var specular = pow(max(0.0, dot(H, normal)), uniforms.specular_power);
    // Secondary rim light from below-right for depth
    var light2 = normalize(vec3f(-0.3, -0.5, 0.8));
    var H2 = normalize(light2 - ray_dir);
    specular += 0.3 * pow(max(0.0, dot(H2, normal)), uniforms.specular_power * 0.5);

    // Diffuse lighting for non-metals (Lambertian)
    var NdotL = max(dot(normal, light_dir), 0.0);
    var diffuse_light = 0.3 + 0.7 * NdotL; // ambient + directional

    // Fluid color contribution — thicker = more opaque, thinner = more transparent
    var opacity = 1.0 - exp(-uniforms.density * thickness * 3.0);
    var fluid_contribution = diffuse_color * diffuse_light * opacity;

    // Emissive glow: lava and molten copper emit their own light
    var emissive = diffuse_color * uniforms.emissive_intensity;

    // Mix: transparent fluid shows background through, opaque shows color
    var base_color = mix(refraction_color, fluid_contribution, opacity * 0.7);

    // Metals: high Fresnel, tinted reflections, no transmission
    var metal_color = mix(base_color, reflection_color, fresnel);
    var dielectric_color = mix(base_color, reflection_color, fresnel * 0.4);
    var shaded = mix(dielectric_color, metal_color, uniforms.metalness);

    // Add specular + emissive
    var spec_intensity = mix(0.8, 2.0, uniforms.metalness);
    var final_color = shaded + vec3f(specular * spec_intensity) + emissive;

    // Alpha: fluid pixels are semi-transparent at thin edges, emissive fluids more opaque
    var alpha = clamp(opacity * 1.5 + uniforms.emissive_intensity * 0.3, 0.3, 1.0);

    return vec4f(final_color, alpha);
}
