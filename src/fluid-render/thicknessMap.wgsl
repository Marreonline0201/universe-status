// §3.2 SSFR Pass 3: Thickness map
// Rendered with ADDITIVE blending and NO depth test.
// Each sprite contributes: t(x,y) = 2R * sqrt(1 - x² - y²)
// Overlapping particles' thicknesses sum up naturally.
//
// structure.md §3.2 lines 1923-1928

struct FragmentInput {
    @location(0) uv: vec2f,
    @location(1) view_position: vec3f,
}

@fragment
fn fs(input: FragmentInput) -> @location(0) vec4f {
    var normalxy = input.uv * 2.0 - 1.0;
    var r2 = dot(normalxy, normalxy);
    if (r2 > 1.0) {
        discard;
    }

    // §3.2: t(x,y) = 2R * sqrt(1 - x² - y²)
    var thickness = sqrt(1.0 - r2);
    let particle_alpha: f32 = 0.05;

    return vec4f(vec3f(particle_alpha * thickness), 1.0);
}
