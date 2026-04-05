// Debug shader: visualize depth map as grayscale
// White = close to camera, black = far away, background = transparent

struct FragmentInput {
    @location(0) uv: vec2f,
    @location(1) iuv: vec2f,
}

@group(0) @binding(0) var depth_texture: texture_2d<f32>;

@fragment
fn fs(input: FragmentInput) -> @location(0) vec4f {
    var depth = abs(textureLoad(depth_texture, vec2u(input.iuv), 0).r);

    // No fluid pixel
    if (depth >= 1e4 || depth <= 0.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0); // transparent
    }

    // Visualize depth: map [0.5, 5.0] range to [1.0, 0.0] brightness
    var brightness = clamp(1.0 - (depth - 0.5) / 4.5, 0.0, 1.0);

    // Tint blue for water look
    return vec4f(brightness * 0.3, brightness * 0.6, brightness * 1.0, 0.9);
}
