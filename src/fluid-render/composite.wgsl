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
    time: f32,              // seconds since start — for animated ripples
    ior: f32,               // index of refraction (water=1.333, honey=1.5)
    _pad4: f32,
    _pad5: f32,
}

@group(0) @binding(0) var texture_sampler: sampler;
@group(0) @binding(1) var depth_texture: texture_2d<f32>;
@group(0) @binding(2) var thickness_texture: texture_2d<f32>;
@group(0) @binding(3) var scene_texture: texture_2d<f32>;
@group(0) @binding(4) var<uniform> uniforms: CompositeUniforms;

// Hash for procedural noise
fn hash2(p: vec2f) -> f32 {
    var p2 = fract(p * vec2f(443.8975, 397.2973));
    p2 += dot(p2, p2.yx + 19.19);
    return fract(p2.x * p2.y);
}

// Smooth value noise — bilinear interpolation of hash values
fn valueNoise(p: vec2f) -> f32 {
    var i = floor(p);
    var f = fract(p);
    // Smooth hermite interpolation
    var u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
        mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
        u.y
    );
}

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

    // Animated micro-surface wave perturbation — smooth ripples
    // Dielectrics (water) get more perturbation; metals (mercury) stay mirror-smooth
    var wave_strength = 0.05 * (1.0 - uniforms.metalness * 0.8);
    var t = uniforms.time;
    // Three octaves of smooth animated waves at different scales/speeds
    var p1 = pixel * 0.08 + vec2f(t * 6.0, t * 4.0);
    var p2 = pixel * 0.15 + vec2f(-t * 3.5, t * 5.5);
    var p3 = pixel * 0.03 + vec2f(t * 2.0, -t * 1.5);
    var nx = (valueNoise(p1) - 0.5) + 0.5 * (valueNoise(p2) - 0.5) + 0.25 * (valueNoise(p3) - 0.5);
    var ny = (valueNoise(p1 + vec2f(7.3, 13.7)) - 0.5) + 0.5 * (valueNoise(p2 + vec2f(31.1, 17.3)) - 0.5) + 0.25 * (valueNoise(p3 + vec2f(53.7, 41.9)) - 0.5);
    normal = normalize(normal + vec3f(nx, ny, 0.0) * wave_strength);

    // §3.2 Pass 5: Compositing — per-material Fresnel, refraction, absorption
    var thickness = textureLoad(thickness_texture, vec2u(pixel), 0).r;
    var ray_dir = normalize(view_pos);
    var NdotV = max(dot(normal, -ray_dir), 0.0);

    // Fresnel: F = F0 + (1-F0)(1 - N·V)^5 — metallic materials use colored F0
    var f0 = uniforms.F0;
    var fresnel = clamp(f0 + (1.0 - f0) * pow(1.0 - NdotV, 5.0), 0.0, 1.0);

    // Refraction: offset background UV — IOR from material properties
    var ior = mix(uniforms.ior, 1.0, uniforms.metalness); // metals: no refraction
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
    // Metals reflect more brightly — boost environment for mirror-like materials
    sky_color *= mix(1.0, 1.8, uniforms.metalness);
    var reflection_color = mix(sky_color, sky_color * diffuse_color, uniforms.metalness);

    // Specular highlights (Blinn-Phong) — primary + rim light
    var light_dir = normalize(uniforms.light_dir);
    var H = normalize(light_dir - ray_dir);
    var specular = pow(max(0.0, dot(H, normal)), uniforms.specular_power);
    // Secondary rim light from below-right for depth
    var light2 = normalize(vec3f(-0.3, -0.5, 0.8));
    var H2 = normalize(light2 - ray_dir);
    specular += 0.3 * pow(max(0.0, dot(H2, normal)), uniforms.specular_power * 0.5);

    // Fluid opacity — must be computed before SSS which depends on it
    var opacity = 1.0 - exp(-uniforms.density * thickness * 3.0);

    // Diffuse lighting for non-metals (Lambertian + secondary + SSS approximation)
    var NdotL = max(dot(normal, light_dir), 0.0);
    var NdotL2 = max(dot(normal, light2), 0.0);
    var diffuse_light = 0.25 + 0.6 * NdotL + 0.15 * NdotL2;
    // Cheap subsurface scattering: light wraps around thin edges
    var sss = max(0.0, dot(-ray_dir, light_dir)) * (1.0 - opacity) * 0.3;
    diffuse_light += sss;
    var fluid_contribution = diffuse_color * diffuse_light * opacity;

    // Emissive glow: lava and molten copper emit their own light
    // Glow intensity varies with thickness — thicker = brighter core, thin edges glow softly
    var glow_core = smoothstep(0.0, 0.5, thickness);
    var emissive = diffuse_color * uniforms.emissive_intensity * (0.7 + 0.5 * glow_core);
    // Subtle hot core for thick emissive regions — keeps base color dominant
    emissive += vec3f(1.0, 0.7, 0.3) * uniforms.emissive_intensity * 0.15 * glow_core * glow_core;

    // Mix: transparent fluid shows background through, opaque shows color
    var base_color = mix(refraction_color, fluid_contribution, opacity * 0.7);

    // Metals: high Fresnel, tinted reflections, no transmission
    var metal_color = mix(base_color, reflection_color, fresnel);
    var dielectric_color = mix(base_color, reflection_color, fresnel * 0.7);
    var shaded = mix(dielectric_color, metal_color, uniforms.metalness);

    // Add specular + emissive
    var spec_intensity = mix(1.2, 2.5, uniforms.metalness);
    var final_color = shaded + vec3f(specular * spec_intensity) + emissive;

    // Edge darkening — subtle contact shadow (reduced for emissive materials)
    var edge_ao = smoothstep(0.0, 0.3, thickness);
    var ao_strength = mix(0.7, 1.0, max(edge_ao, uniforms.emissive_intensity * 0.5));
    final_color *= ao_strength;

    // Alpha: smooth falloff at thin edges, emissive materials more opaque
    // Dielectrics: softer edges (min alpha 0.15), metals/emissive: harder edges (min 0.5)
    var min_alpha = mix(0.15, 0.5, max(uniforms.metalness, uniforms.emissive_intensity * 0.3));
    var alpha = clamp(opacity * 2.0, min_alpha, 1.0);

    // Premultiply alpha for correct canvas compositing (alphaMode: premultiplied)
    return vec4f(final_color * alpha, alpha);
}
