// ssfr_blur.wgsl — SSFR Pass 3: Bilateral filter on depth texture
// Smooths the depth map while preserving edges (depth discontinuities)
// Run twice: horizontal then vertical (separable)

struct BlurParams {
    texSize: vec2<f32>,      // texture dimensions
    filterRadius: f32,       // kernel radius in pixels
    blurScale: f32,          // depth-dependent blur scale
    blurDepthFalloff: f32,   // how quickly blur weight falls off with depth difference
    direction: vec2<f32>,    // (1,0) for horizontal, (0,1) for vertical
    _pad: f32,
};

@group(0) @binding(0) var<uniform> params: BlurParams;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var depthSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Full-screen triangle (3 vertices, no vertex buffer needed)
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    // Full-screen triangle trick: 3 vertices that cover [-1,1]²
    let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
    let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) f32 {
    // textureSampleLevel (explicit LOD 0) is safe inside non-uniform control
    // flow — no derivatives required. We use it here and at the inner-loop
    // sample below because the early `return` on line 41 creates non-uniform
    // flow for the remaining pixels. See ssfr_composite.wgsl for the same rule.
    let centerDepth = textureSampleLevel(depthTex, depthSampler, in.uv, 0.0).r;

    // Skip background (no fluid)
    if (centerDepth <= 0.0 || centerDepth > 1000.0) {
        return centerDepth;
    }

    let texelSize = 1.0 / params.texSize;
    let radius = i32(params.filterRadius);

    var sum = 0.0;
    var wsum = 0.0;

    // Bilateral filter kernel
    for (var i = -radius; i <= radius; i++) {
        let offset = params.direction * f32(i) * texelSize;
        let sampleUV = in.uv + offset;

        // Clamp to texture bounds
        if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
            continue;
        }

        let sampleDepth = textureSampleLevel(depthTex, depthSampler, sampleUV, 0.0).r;

        // Skip empty samples
        if (sampleDepth <= 0.0 || sampleDepth > 1000.0) {
            continue;
        }

        // Spatial weight (Gaussian)
        let r2 = f32(i * i);
        let sigma = params.filterRadius * 0.5;
        let spatialW = exp(-r2 / (2.0 * sigma * sigma));

        // Depth (range) weight — preserves edges
        let depthDiff = (sampleDepth - centerDepth) * params.blurDepthFalloff;
        let rangeW = exp(-depthDiff * depthDiff);

        let w = spatialW * rangeW;
        sum += sampleDepth * w;
        wsum += w;
    }

    if (wsum > 0.0) {
        return sum / wsum;
    }
    return centerDepth;
}
