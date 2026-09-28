// ssfr_composite.wgsl — SSFR final pass: physically based shading of the liquid surface, in linear light.
// (ssfr_scene.wgsl is prepended: traceScene, Scene, srgbEncode/Decode, footprintCone, rayThroughNdc.)
//
// Per pixel with liquid in front of the background (single front surface; r6 rungs 0, 1 and 5):
//   dielectric:  C = F·L_refl + (1 − F)·T(ℓ)·L_refr
//     F      exact unpolarised Fresnel at the material's refractive index (pbr-book 3rd ed. §8.2), no Schlick;
//     L_refl the room traced along reflect(−V, N) — including the sun disc (its flux averaged over the pixel's
//            reflected-direction footprint), so the sun glint is F·L_sun and needs no separate specular term;
//     L_refr the room traced along the Snell-refracted ray refract(−V, N, 1/n): exact apparent depth for a
//            flat surface over the floor, and no screen-edge clamping (the room is analytic, not a screen image);
//     T(ℓ)   Beer–Lambert transmittance of D65 light over the in-liquid path ℓ, from the spectral LUT built out
//            of the material's measured a(λ) (optics/materials.ts);
//     ℓ      thickness (metres of liquid along the straight view ray, ssfr_thickness.wgsl) × cosθi / cosθt —
//            the refracted path through a flat layer (r6 §4: the straight chord overestimates it, 1.43× at 57°).
//   conductor:   C = R(θ)·L_refl, R from the measured complex index, integrated over the spectrum; nothing is
//                transmitted.
// Output: alpha = 1 (no blending over a clear colour), clipped to [0,1] per channel, sRGB-encoded (CSS Color 4).
// Where there is no liquid (or the background is in front of it) the background texel is passed through
// untouched, so the background is bit-identical to ssfr_bg.wgsl's output (acceptance test V6).
//
// Stated approximations (not modelled here; later rungs): one refracting surface — a ray leaving a mid-air blob
// is not bent again, TIR at an exit surface cannot occur (rung 3, back faces); the liquid neither reflects nor
// shadows itself; per-channel T × L is exact only for grey backgrounds; the submerged floor keeps its authored
// radiance (its underwater illumination, the n² radiance law and TIR re-trapping are rung-3 floor lighting);
// polarisation is not tracked; mixed liquids use the front composition's optics for the whole path.

struct CompositeParams {
    viewMatrix: mat4x4<f32>,
    invViewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    invProjMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    lutN: f32,
    lutLmaxM: f32,
};

// Per composition: [kind (0 dielectric, 1 conductor), refractive index, LUT row (−1 none), 0] + [reserved].
struct Materials {
    data: array<vec4<f32>, 512>,
};

@group(0) @binding(0) var<uniform> params: CompositeParams;
@group(0) @binding(1) var depthTex: texture_2d<f32>;        // smoothed fluid eye depth (0 = no fluid)
@group(0) @binding(2) var thicknessTex: texture_2d<f32>;    // metres of liquid along the view ray
@group(0) @binding(3) var bgTex: texture_2d<f32>;           // background, sRGB-encoded (canvas format)
@group(0) @binding(4) var compIdTex: texture_2d<u32>;       // composition id of the front-most splat
@group(0) @binding(5) var<storage, read> materials: Materials;
@group(0) @binding(6) var bgDepthTex: texture_2d<f32>;      // background eye depth (1e6 = void)
@group(0) @binding(7) var<uniform> scene: Scene;
@group(0) @binding(8) var<storage, read> lut: array<vec4<f32>>;

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

// Eye-space position of the surface at SSFR pixel coordinate `pc` (pixel centres at +0.5) and positive eye
// depth `depth`, for any projection: the point at eye z = −depth on the line through the pixel's near- and
// far-plane points. (Reconstructing through NDC z instead, as before 2026-09-28, loses ~2 mrad of normal
// precision to the perspective depth mapping at 1 m — enough to break a sun glint into speckle; gate R0 "S".)
fn eyePosAt(pc: vec2<f32>, depth: f32) -> vec3<f32> {
    let ndcXY = uvToNdc(pc / params.screenSize);
    let a4 = params.invProjMatrix * vec4<f32>(ndcXY, 0.0, 1.0);
    let b4 = params.invProjMatrix * vec4<f32>(ndcXY, 1.0, 1.0);
    let a = a4.xyz / a4.w;
    let b = b4.xyz / b4.w;
    return a + ((-depth - a.z) / (b.z - a.z)) * (b - a);
}

fn validDepth(d: f32) -> bool { return d > 0.0 && d < 1000.0; }

fn loadDepth(p: vec2<i32>) -> f32 {
    let size = vec2<i32>(params.screenSize);
    return textureLoad(depthTex, clamp(p, vec2<i32>(0), size - 1), 0).r;
}

// Exact unpolarised dielectric Fresnel reflectance (pbr-book 3rd ed. §8.2).
fn fresnelDielectric(cosI: f32, etaI: f32, etaT: f32) -> f32 {
    let ci = clamp(cosI, 0.0, 1.0);
    let r = etaI / etaT;
    let sinT2 = r * r * max(0.0, 1.0 - ci * ci);
    if (sinT2 >= 1.0) { return 1.0; }
    let ct = sqrt(1.0 - sinT2);
    let rPar = (etaT * ci - etaI * ct) / (etaT * ci + etaI * ct);
    let rPerp = (etaI * ci - etaT * ct) / (etaI * ci + etaT * ct);
    return 0.5 * (rPar * rPar + rPerp * rPerp);
}

// Linear interpolation in one row of the optics LUT at normalised coordinate u ∈ [0,1].
fn lutFetch(row: f32, u: f32) -> vec3<f32> {
    let n = u32(params.lutN);
    let x = clamp(u, 0.0, 1.0) * (params.lutN - 1.0);
    let i0 = u32(floor(x));
    let f = x - floor(x);
    let base = u32(row) * n;
    return mix(lut[base + i0].rgb, lut[base + min(i0 + 1u, n - 1u)].rgb, f);
}

// Transmittance rows are sampled at path L = Lmax·u² (see optics/materials.ts buildOpticsLut).
fn transmittance(row: f32, pathM: f32) -> vec3<f32> {
    if (row < 0.0) { return vec3<f32>(1.0); }
    return lutFetch(row, sqrt(clamp(pathM / params.lutLmaxM, 0.0, 1.0)));
}

struct Shaded {
    encoded: vec4<f32>,   // what goes to the canvas
    linear: vec4<f32>,    // the same colour before the clip and the sRGB encode (bench probe target)
};

fn shade(uv: vec2<f32>) -> Shaded {
    let size = vec2<i32>(params.screenSize);
    let pix = clamp(vec2<i32>(uv * params.screenSize), vec2<i32>(0), size - 1);
    let pc = vec2<f32>(pix) + 0.5;

    let depth = loadDepth(pix);
    let hasFluid = validDepth(depth);
    let dc = select(1.0, depth, hasFluid);
    // Neighbour depths; a neighbour without liquid is replaced by the centre depth (a flat tangent there).
    let dR = select(dc, loadDepth(pix + vec2<i32>(1, 0)), validDepth(loadDepth(pix + vec2<i32>(1, 0))));
    let dL = select(dc, loadDepth(pix - vec2<i32>(1, 0)), validDepth(loadDepth(pix - vec2<i32>(1, 0))));
    let dD = select(dc, loadDepth(pix + vec2<i32>(0, 1)), validDepth(loadDepth(pix + vec2<i32>(0, 1))));   // +y = down the screen
    let dU = select(dc, loadDepth(pix - vec2<i32>(0, 1)), validDepth(loadDepth(pix - vec2<i32>(0, 1))));

    let posC = eyePosAt(pc, dc);
    let posR = eyePosAt(pc + vec2<f32>(1.0, 0.0), dR);
    let posL = eyePosAt(pc - vec2<f32>(1.0, 0.0), dL);
    let posD = eyePosAt(pc + vec2<f32>(0.0, 1.0), dD);
    let posU = eyePosAt(pc - vec2<f32>(0.0, 1.0), dU);
    // One-sided differences on the side with the smaller depth step (keeps silhouettes from bending normals).
    let ddx = select(posR - posC, posC - posL, abs(posR.z - posC.z) > abs(posC.z - posL.z));
    let ddy = select(posU - posC, posC - posD, abs(posU.z - posC.z) > abs(posC.z - posD.z));
    var nEye = normalize(cross(ddx, ddy));
    if (nEye.z < 0.0) { nEye = -nEye; }

    let ray = rayThroughNdc(uvToNdc(pc / params.screenSize), params.invProjMatrix, params.invViewMatrix);
    let V = -ray.dir;
    let P = (params.invViewMatrix * vec4<f32>(posC, 1.0)).xyz;
    var N = normalize((params.invViewMatrix * vec4<f32>(nEye, 0.0)).xyz);
    if (dot(N, V) < 0.0) { N = -N; }
    let cosI = clamp(dot(N, V), 1e-4, 1.0);

    let compId = min(textureLoad(compIdTex, pix, 0).r, 255u);
    let m0 = materials.data[2u * compId];
    let isConductor = m0.x > 0.5;
    let ior = max(m0.y, 1.0);
    let row = m0.z;

    // Reflected and Snell-refracted directions (air → liquid, η = 1/n; no TIR on entry).
    let rDir = reflect(-V, N);
    let eta = 1.0 / ior;
    let cosT = sqrt(max(0.0, 1.0 - eta * eta * (1.0 - cosI * cosI)));
    let tDir = normalize(eta * (-V) + (eta * cosI - cosT) * N);
    // Pixel footprints of both rays (derivatives: uniform control flow, before any branch).
    let coneR = footprintCone(rDir);
    let coneT = footprintCone(tDir);

    let bgEnc = textureLoad(bgTex, pix, 0);
    let bgDepth = textureLoad(bgDepthTex, pix, 0).r;
    let bgInFront = (bgDepth + 1e-4) < depth;
    if (!hasFluid || bgInFront) {
        return Shaded(bgEnc, vec4<f32>(srgbDecode(bgEnc.rgb), 1.0));
    }

    let Lrefl = traceScene(P, rDir, coneR).radiance;
    var L: vec3<f32>;
    if (isConductor) {
        L = lutFetch(row, cosI) * Lrefl;
    } else {
        let F = fresnelDielectric(cosI, 1.0, ior);
        let thickness = textureLoad(thicknessTex, pix, 0).r;
        let pathM = thickness * cosI / max(cosT, 1e-4);
        let Lrefr = traceScene(P, tDir, coneT).radiance;
        L = F * Lrefl + (1.0 - F) * transmittance(row, pathM) * Lrefr;
    }
    return Shaded(vec4<f32>(srgbEncode(clamp(L, vec3<f32>(0.0), vec3<f32>(1.0))), 1.0), vec4<f32>(L, 1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return shade(in.uv).encoded;
}

// Bench probe (SSFRPipeline.probe): the same shading, plus the linear colour before the clip and encode.
struct ProbeOut {
    @location(0) encoded: vec4<f32>,
    @location(1) linear: vec4<f32>,
};

@fragment
fn fs_probe(in: VertexOutput) -> ProbeOut {
    let s = shade(in.uv);
    return ProbeOut(s.encoded, s.linear);
}
