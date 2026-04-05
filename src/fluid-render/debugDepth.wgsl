// Debug shader: visualize depth map as grayscale
// White = close to camera, black = far away, background = transparent

@group(0) @binding(0) var depth_texture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) frag_pos: vec4f) -> @location(0) vec4f {
    // Use @builtin(position) directly — (0,0) is top-left in WebGPU
    var depth = abs(textureLoad(depth_texture, vec2u(frag_pos.xy), 0).r);

    // No fluid pixel — fully transparent so Three.js shows through
    if (depth >= 1e4 || depth <= 0.0) {
        discard;
    }

    // Visualize depth: map [0.1, 5.0] range to [1.0, 0.0] brightness
    var brightness = clamp(1.0 - (depth - 0.1) / 4.9, 0.0, 1.0);

    // Solid blue where fluid exists
    return vec4f(brightness * 0.2, brightness * 0.5, brightness * 1.0, 1.0);
}
