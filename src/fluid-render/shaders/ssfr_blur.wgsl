// ssfr_blur.wgsl — SSFR Pass 3: one direction of the separable bilateral filter on the fluid depth.
// Run twice (horizontal, then vertical), each with its OWN uniform buffer: before 2026-09-28 both passes shared one
// buffer written twice before the submit, so both ran vertically. The kernel itself is unchanged (fixed pixel
// radius, σ = radius/2, range weight exp(−(Δz·falloff)²)); a world-space narrow-range filter is render rung 2.
// Texels are read with textureLoad (exact texel centres; no filtering sampler on r32float needed).

struct BlurParams {
    texSize: vec2<f32>,
    filterRadius: f32,       // kernel radius in pixels
    blurScale: f32,          // unused (kept for the layout)
    blurDepthFalloff: f32,   // range weight: exp(−(Δz·falloff)²), Δz in world units
    _pad0: f32,
    direction: vec2<f32>,    // (1,0) horizontal, (0,1) vertical
};

@group(0) @binding(0) var<uniform> params: BlurParams;
@group(0) @binding(1) var depthTex: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
    let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) f32 {
    let size = vec2<i32>(params.texSize);
    let pix = vec2<i32>(in.position.xy);
    let centerDepth = textureLoad(depthTex, pix, 0).r;
    if (centerDepth <= 0.0 || centerDepth > 1000.0) { return centerDepth; }   // no fluid

    let radius = i32(params.filterRadius);
    let step = vec2<i32>(params.direction);
    let sigma = params.filterRadius * 0.5;
    var sum = 0.0;
    var wsum = 0.0;
    for (var i = -radius; i <= radius; i++) {
        let p = pix + step * i;
        if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) { continue; }
        let sampleDepth = textureLoad(depthTex, p, 0).r;
        if (sampleDepth <= 0.0 || sampleDepth > 1000.0) { continue; }
        let spatialW = exp(-f32(i * i) / (2.0 * sigma * sigma));
        let diff = sampleDepth - centerDepth;
        let dz = diff * params.blurDepthFalloff;
        let w = spatialW * exp(-dz * dz);
        // Accumulate depth DIFFERENCES: summing absolute depths (≈1–3 world units) rounds away the sub-µm steps
        // between neighbouring pixels that the composite's normals are built from (measured: ~1 mrad normal noise).
        sum += diff * w;
        wsum += w;
    }
    return select(centerDepth, centerDepth + sum / wsum, wsum > 0.0);
}
