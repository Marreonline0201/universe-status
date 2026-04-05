// Gaussian blur for thickness map smoothing
// Simpler than bilateral — no edge preservation needed for thickness

struct FragmentInput {
    @location(0) uv: vec2f,
    @location(1) iuv: vec2f,
}

struct FilterUniforms {
    blur_dir: vec2f,
}

@group(0) @binding(0) var texture_sampler: sampler;
@group(0) @binding(1) var thickness_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: FilterUniforms;

@fragment
fn fs(@builtin(position) frag_pos: vec4f, input: FragmentInput) -> @location(0) vec4f {
    var pixel = frag_pos.xy;
    var thickness = textureLoad(thickness_texture, vec2u(pixel), 0).r;

    if (thickness <= 0.0) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }

    var filter_size: i32 = 15;
    var sigma = f32(filter_size) / 3.0;
    var two_sigma = 2.0 * sigma * sigma;

    var sum: f32 = 0.0;
    var wsum: f32 = 0.0;

    for (var x: i32 = -filter_size; x <= filter_size; x++) {
        var coords = vec2f(f32(x));
        var sampled = textureLoad(thickness_texture, vec2u(pixel + coords * uniforms.blur_dir), 0).r;

        var w = exp(-coords.x * coords.x / two_sigma);
        sum += sampled * w;
        wsum += w;
    }

    sum /= wsum;
    return vec4f(sum, 0.0, 0.0, 1.0);
}
