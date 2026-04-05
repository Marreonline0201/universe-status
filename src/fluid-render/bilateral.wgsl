// §3.2 SSFR Pass 2: Bilateral blur on depth
// Smooths individual particle bumps into continuous surface while preserving edges.
// w(q) = G_spatial(||p-q||) * G_range(|depth(p) - depth(q)|)
//
// structure.md §3.2 lines 1908-1921:
//   G_spatial: standard Gaussian blur (σ = 5-10 pixels, kernel radius 10-20 px)
//   G_range: preserves edges — if two pixels have very different depths,
//            they are at a fluid boundary. Do not blur across it.
//   Done as two separable 1D passes (horizontal + vertical) for efficiency.

struct FragmentInput {
    @location(0) uv: vec2f,
    @location(1) iuv: vec2f,
}

struct FilterUniforms {
    blur_dir: vec2f,
}

@group(0) @binding(0) var texture_sampler: sampler;
@group(0) @binding(1) var depth_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: FilterUniforms;

// Configurable via pipeline constants
override depth_threshold: f32 = 5.0;
override projected_particle_constant: f32 = 100.0;
override max_filter_size: f32 = 20.0;

@fragment
fn fs(input: FragmentInput) -> @location(0) vec4f {
    var depth = abs(textureLoad(depth_texture, vec2u(input.iuv), 0).r);

    // No fluid at this pixel
    if (depth >= 1e4) {
        return vec4f(vec3f(depth), 1.0);
    }

    // Adaptive kernel: bigger particles on screen = wider blur
    var filter_size = min(i32(max_filter_size), i32(ceil(projected_particle_constant / depth)));
    var sigma = f32(filter_size) / 3.0;
    var two_sigma = 2.0 * sigma * sigma;
    var sigma_depth = depth_threshold / 3.0;
    var two_sigma_depth = 2.0 * sigma_depth * sigma_depth;

    var sum: f32 = 0.0;
    var wsum: f32 = 0.0;

    for (var x: i32 = -filter_size; x <= filter_size; x++) {
        var coords = vec2f(f32(x));
        var sampled_depth = abs(textureLoad(depth_texture, vec2u(input.iuv + coords * uniforms.blur_dir), 0).r);

        // Spatial Gaussian weight
        var rr = dot(coords, coords);
        var w = exp(-rr / two_sigma);

        // Range weight — preserve depth edges
        var r_depth = sampled_depth - depth;
        var wd = exp(-r_depth * r_depth / two_sigma_depth);

        sum += sampled_depth * w * wd;
        wsum += w * wd;
    }

    sum /= wsum;
    return vec4f(sum, 0.0, 0.0, 1.0);
}
