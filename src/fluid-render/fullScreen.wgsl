// Fullscreen vertex shader — draws a quad covering the entire viewport
// Used by all post-processing passes (bilateral blur, gaussian blur, composite)

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) iuv: vec2f,
}

override screenWidth: f32;
override screenHeight: f32;

@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var corner_positions = array(
        vec2f( 1.0,  1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f( 1.0,  1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0,  1.0),
    );

    let pos = corner_positions[vertex_index];
    let uv = pos * 0.5 + 0.5;
    let iuv = uv * vec2f(screenWidth, screenHeight);

    return VertexOutput(vec4f(pos, 0.0, 1.0), uv, iuv);
}
