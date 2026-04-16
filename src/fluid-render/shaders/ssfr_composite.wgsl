// ssfr_composite.wgsl — SSFR Pass 5: Final compositing
// Reconstructs normals from depth, applies Fresnel, Beer-Lambert absorption,
// refraction, and incandescence. Composites fluid on top of scene.

struct CompositeParams {
    invProjMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    nearPlane: f32,
    farPlane: f32,
    // Fluid rendering parameters
    refractionStrength: f32,
    absorptionScale: f32,
    fresnelPower: f32,
    ambientStrength: f32,
    lightDir: vec3<f32>,
    _pad: f32,
};

// Material properties: 8 floats per composition [R, G, B, metalness, F0, emissive, IOR, opacity]
struct MaterialProps {
    data: array<vec4<f32>, 512>,  // 256 materials × 2 vec4s each
};

@group(0) @binding(0) var<uniform> params: CompositeParams;
@group(0) @binding(1) var depthTex: texture_2d<f32>;      // smoothed depth
@group(0) @binding(2) var thicknessTex: texture_2d<f32>;   // accumulated thickness
@group(0) @binding(3) var sceneTex: texture_2d<f32>;       // Three.js scene render
@group(0) @binding(4) var compIdTex: texture_2d<u32>;      // per-pixel composition ID
@group(0) @binding(5) var<storage, read> materials: MaterialProps;
@group(0) @binding(6) var linearSampler: sampler;

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

// Reconstruct eye-space position from LINEAR eye-space depth.
// The depth pass stores negative eye-space Z (like Splash).
// Uses projection matrix coefficients to reconstruct NDC z from linear depth.
fn eyePosFromDepth(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    var ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y, 0.0, 1.0);
    // Reconstruct NDC z from linear depth using projection matrix
    ndc.z = -params.projMatrix[2].z + params.projMatrix[3].z / depth;
    let eyePos = params.invProjMatrix * ndc;
    return eyePos.xyz / eyePos.w;
}

// Schlick Fresnel approximation
fn fresnelSchlick(cosTheta: f32, F0: f32) -> f32 {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, params.fresnelPower);
}

// Beer-Lambert absorption with per-channel water absorption.
// Real water absorbs red heavily, green moderately, blue barely.
// This is why deep water looks blue-green.
fn beerLambert(sceneColor: vec3<f32>, thickness: f32) -> vec3<f32> {
    // Absorption coefficients per channel (1/m): higher = more absorbed
    let absorption = vec3<f32>(0.45, 0.09, 0.04) * params.absorptionScale;
    return sceneColor * exp(-absorption * thickness);
}

// Blackbody incandescence color
fn incandescence(temperature: f32) -> vec3<f32> {
    if (temperature < 500.0) { return vec3<f32>(0.0); }
    let t = (temperature + 273.15) / 1000.0;
    let r = min(1.0, max(0.0, (t - 0.5) * 1.2));
    let g = min(1.0, max(0.0, (t - 0.8) * 0.9));
    let b = min(1.0, max(0.0, (t - 1.5) * 0.7));
    let intensity = min(3.0, max(0.0, (temperature - 500.0) / 400.0));
    return vec3<f32>(r, g, b) * intensity;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // WGSL requires ALL textureSample calls in uniform control flow.
    // Sample everything upfront, branch on results later.
    let texelSize = 1.0 / params.screenSize;

    let depth = textureSample(depthTex, linearSampler, in.uv).r;
    let depthR = textureSample(depthTex, linearSampler, in.uv + vec2<f32>(texelSize.x, 0.0)).r;
    let depthL = textureSample(depthTex, linearSampler, in.uv - vec2<f32>(texelSize.x, 0.0)).r;
    let depthU = textureSample(depthTex, linearSampler, in.uv + vec2<f32>(0.0, texelSize.y)).r;
    let depthD = textureSample(depthTex, linearSampler, in.uv - vec2<f32>(0.0, texelSize.y)).r;
    let thickness = textureSample(thicknessTex, linearSampler, in.uv).r;
    let sceneBg = textureSample(sceneTex, linearSampler, in.uv);

    // Determine if fluid exists at this pixel
    let hasFluid = depth > 0.0 && depth < 1000.0;

    // Use safe depth for position reconstruction (avoid div by zero)
    let safeDepth = select(1.0, depth, hasFluid);
    let posC = eyePosFromDepth(in.uv, safeDepth);
    let posR = eyePosFromDepth(in.uv + vec2<f32>(texelSize.x, 0.0), depthR);
    let posL = eyePosFromDepth(in.uv - vec2<f32>(texelSize.x, 0.0), depthL);
    let posU = eyePosFromDepth(in.uv + vec2<f32>(0.0, texelSize.y), depthU);
    let posD = eyePosFromDepth(in.uv - vec2<f32>(0.0, texelSize.y), depthD);

    let ddx = select(posR - posC, posC - posL, abs(posR.z - posC.z) > abs(posC.z - posL.z));
    let ddy = select(posU - posC, posC - posD, abs(posU.z - posC.z) > abs(posC.z - posD.z));

    var normal = normalize(cross(ddx, ddy));
    // Ensure normal faces the camera
    if (normal.z < 0.0) { normal = -normal; }

    // ── Read material properties ────────────────────────────────────────
    // Default material (water-like) if we can't read comp ID.
    // matColor is deliberately darkened: bright values drown out the
    // transmitted (Beer-Lambert) color and make the fluid look milky.
    // Water's apparent color comes mostly from absorption of scene light.
    var matColor = vec3<f32>(0.25, 0.45, 0.65);
    var metalness = 0.0;
    var F0 = 0.02;
    var emissive = 0.0;
    var IOR = 1.333;
    // Lower opacity = fluid becomes transparent faster with thickness.
    var opacity = 0.06;

    // ── Lighting ────────────────────────────────────────────────────────
    let viewDir = normalize(-posC);
    let lightDir = normalize(params.lightDir);

    // Diffuse (half-Lambert for softer look)
    let NdotL = dot(normal, lightDir);
    let diffuse = NdotL * 0.5 + 0.5;

    // Specular (Blinn-Phong)
    let halfVec = normalize(lightDir + viewDir);
    let NdotH = max(0.0, dot(normal, halfVec));
    let specular = pow(NdotH, 150.0);

    // Fresnel
    let NdotV = max(0.001, dot(normal, viewDir));
    let fresnel = fresnelSchlick(NdotV, F0);

    // ── Refraction ──────────────────────────────────────────────────────
    let refractOffset = normal.xy * params.refractionStrength * (1.0 - NdotV);
    let refractUV = clamp(in.uv + refractOffset, vec2<f32>(0.0), vec2<f32>(1.0));
    // Use textureLoad for refracted scene (avoids uniform control flow restriction)
    let refractPixel = vec2<u32>(vec2<f32>(refractUV.x, refractUV.y) * params.screenSize);
    let sceneColor = textureLoad(sceneTex, refractPixel, 0).rgb;
    let transmittedColor = beerLambert(sceneColor, thickness);

    // ── Compose final color ─────────────────────────────────────────────
    // Environment reflection (simplified cubemap substitute)
    let reflectDir = reflect(-viewDir, normal);
    let envColor = vec3<f32>(
        0.1 + 0.05 * reflectDir.x,
        0.12 + 0.08 * reflectDir.y,
        0.18 + 0.12 * max(0.0, reflectDir.y),
    );

    // Fluid color: blend between transmitted scene and fluid color based on thickness
    let fluidTint = matColor * (diffuse * 0.7 + params.ambientStrength);
    let thicknessFactor = 1.0 - exp(-thickness * opacity * 3.0);

    var finalColor = mix(transmittedColor, fluidTint, thicknessFactor);
    finalColor = mix(finalColor, envColor, fresnel * 0.5);
    // Specular highlight is narrower + weaker so the surface reads as water,
    // not polished plastic. Full-intensity whitish highlight looked milky.
    finalColor += specular * vec3<f32>(0.95, 0.95, 1.0) * 0.3;

    // Add emissive glow
    if (emissive > 0.0) {
        finalColor += matColor * emissive;
    }

    let alpha = max(0.3, min(1.0, thicknessFactor + fresnel * 0.3));

    // Select: fluid pixels show composited fluid, non-fluid pixels show background
    let result = select(sceneBg, vec4<f32>(finalColor, alpha), hasFluid);
    return result;
}
