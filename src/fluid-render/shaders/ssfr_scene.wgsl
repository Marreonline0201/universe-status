// ssfr_scene.wgsl — the ONE description of the world around the fluid, as linear-light radiance.
//
// Prepended (as source text) to ssfr_bg.wgsl, which draws it behind the fluid, and to ssfr_composite.wgsl,
// which traces the fluid's reflected and refracted rays through it. So what the water mirrors and what the eye
// sees through it is, by construction, the same room the background shows.
//
// Radiance units (the exposure): 1.0 = a white Lambertian surface lit by the sun at normal incidence, so the
// sun's disc radiance is π / Ω_sun (set by SSFRPipeline.ts from the IAU nominal solar radius and the au).
// The room itself is the owner's authored, UNLIT backdrop (#b1b366 olive, darker grid lines, blue box edges):
// its colours are sRGB-encoded design values, decoded to linear light once (on the CPU) — they are not lit by the
// sun. The drop-ball keeps its legacy display shading, decoded to linear here. Neither is a physical light model.
//
// Requires the including shader to declare:  @group(0) @binding(N) var<uniform> scene: Scene;

const PI: f32 = 3.14159265358979;

struct Scene {
    sun: vec4<f32>,          // xyz: unit vector toward the sun (world); w: angular radius of the disc (rad)
    sunRadiance: vec4<f32>,  // rgb: linear radiance of the disc; w: 1 = sun on
    backdrop: vec4<f32>,     // rgb: linear radiance of the void and the floor (decoded authored olive × brightness)
    gridLine: vec4<f32>,     // rgb: floor grid lines
    edge: vec4<f32>,         // rgb: tank box edges
    ball: vec4<f32>,         // xyz centre, w radius
    ballMeta: vec4<f32>,     // x: 1 = ball present
    mode: vec4<f32>,         // x: 0 = the room, 1 = uniform test environment (bench probes only)
    testSky: vec4<f32>,      // test environment: radiance of every direction with y ≥ 0
    testFloor: vec4<f32>,    // test environment: radiance of every direction with y < 0
    marker: vec4<f32>,       // test marker disc on the floor (room mode): x, z, radius (world units), w = on
    markerColor: vec4<f32>,  // rgb linear radiance of the marker
    tank: vec4<f32>,         // xyz: the tank's extent in world units (the default tank is [0,1]³; TANK-RESIZE)
};

struct SceneHit {
    radiance: vec3<f32>,
    t: f32,                  // ray distance to the surface hit; 1e9 for the void
};

// CSS Color 4 gam_sRGB / lin_sRGB (https://www.w3.org/TR/css-color-4/ §19), per channel, for non-negative input.
fn srgbEncode(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3<f32>(0.0031308)), vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}
fn srgbDecode(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((max(c, vec3<f32>(0.04045)) + 0.055) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

// Area of the intersection of two discs of radii a and b whose centres are d apart (small-angle patch of the
// direction sphere, treated as planar: exact to O(θ²) for the 4.65 mrad sun).
fn discOverlap(a: f32, b: f32, d: f32) -> f32 {
    if (d >= a + b) { return 0.0; }
    let r = min(a, b);
    if (d <= abs(a - b)) { return PI * r * r; }
    let ca = clamp((d * d + a * a - b * b) / (2.0 * d * a), -1.0, 1.0);
    let cb = clamp((d * d + b * b - a * a) / (2.0 * d * b), -1.0, 1.0);
    let k = max((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b), 0.0);
    return a * a * acos(ca) + b * b * acos(cb) - 0.5 * sqrt(k);
}

// Mean radiance of the sun disc over a pixel whose ray directions fill a cone of angular radius `cone` around
// `rd` (the pixel footprint from ray differentials). A pixel that contains the sun's image — however small — gets
// the sun's flux averaged over its footprint, instead of hitting or missing a 0.53° disc by point sampling.
fn sunAlong(rd: vec3<f32>, cone: f32) -> vec3<f32> {
    if (scene.sunRadiance.w < 0.5) { return vec3<f32>(0.0); }
    let a = scene.sun.w;
    let b = max(cone, 1e-6);
    let d = 2.0 * asin(clamp(0.5 * length(rd - scene.sun.xyz), 0.0, 1.0));   // precise for small angles
    if (d >= a + b) { return vec3<f32>(0.0); }
    return scene.sunRadiance.rgb * (discOverlap(a, b, d) / (PI * b * b));
}

// Radiance arriving along the ray ro + t·rd from the world outside the fluid. `cone` = angular radius of the
// pixel footprint of the ray's direction.
fn traceScene(ro: vec3<f32>, rd: vec3<f32>, cone: f32) -> SceneHit {
    if (scene.mode.x > 0.5) {
        // Bench test environment: a uniform sky over a uniform floor, no geometry.
        let L = select(scene.testFloor.rgb, scene.testSky.rgb, rd.y >= 0.0);
        return SceneHit(L + sunAlong(rd, cone), 1e9);
    }

    var L = scene.backdrop.rgb + sunAlong(rd, cone);
    var nearestT = 1e9;

    // Floor (y = 0) over the tank footprint [0, tank.x] × [0, tank.z] with a small margin: olive with darker grid lines.
    if (abs(rd.y) > 1e-6) {
        let t = -ro.y / rd.y;
        if (t > 0.0) {
            let p = ro + t * rd;
            if (p.x > -0.02 && p.x < scene.tank.x + 0.02 && p.z > -0.02 && p.z < scene.tank.z + 0.02) {
                let gridSize = 0.05;      // 20 divisions across the unit box
                let lineWidth = 0.003;
                let onX = abs(fract(p.x / gridSize + 0.5) - 0.5) < lineWidth / gridSize;
                let onZ = abs(fract(p.z / gridSize + 0.5) - 0.5) < lineWidth / gridSize;
                L = select(scene.backdrop.rgb, scene.gridLine.rgb, onX || onZ);
                if (scene.marker.w > 0.5 && length(p.xz - scene.marker.xy) < scene.marker.z) { L = scene.markerColor.rgb; }
                nearestT = t;
            }
        }
    }

    // Tank box edges of [0, tank] (drawn as thin lines, the box has no walls).
    let edgeWidth = 0.004;
    let invDir = 1.0 / rd;
    let t1 = (vec3<f32>(0.0) - ro) * invDir;
    let t2 = (scene.tank.xyz - ro) * invDir;
    let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
    let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
    if (tmax > max(tmin, 0.0)) {
        let hitT = select(tmin, tmax, tmin < 0.0);
        if (hitT < nearestT) {
            let p = ro + hitT * rd;
            let nearX = abs(p.x) < edgeWidth || abs(p.x - scene.tank.x) < edgeWidth;
            let nearY = abs(p.y) < edgeWidth || abs(p.y - scene.tank.y) < edgeWidth;
            let nearZ = abs(p.z) < edgeWidth || abs(p.z - scene.tank.z) < edgeWidth;
            if (u32(nearX) + u32(nearY) + u32(nearZ) >= 2u) {
                L = scene.edge.rgb;
                nearestT = hitT;
            }
        }
    }

    // Drop-ball obstacle. Legacy display shading (key light = the scene's sun direction), decoded to linear.
    if (scene.ballMeta.x > 0.5) {
        let oc = ro - scene.ball.xyz;
        let b = dot(oc, rd);
        let c = dot(oc, oc) - scene.ball.w * scene.ball.w;
        let h = b * b - c;
        if (h >= 0.0) {
            let tBall = -b - sqrt(h);
            if (tBall > 0.0 && tBall < nearestT) {
                let p = ro + tBall * rd;
                let n = normalize(p - scene.ball.xyz);
                let NdotL = max(0.0, dot(n, scene.sun.xyz));
                let halfVec = normalize(scene.sun.xyz - rd);
                let spec = pow(max(0.0, dot(n, halfVec)), 60.0);
                let shaded = vec3<f32>(0.52, 0.52, 0.54) * (0.15 + NdotL * 0.75) + vec3<f32>(1.0, 0.98, 0.95) * spec * 0.9;
                L = srgbDecode(clamp(shaded, vec3<f32>(0.0), vec3<f32>(1.0)));
                nearestT = tBall;
            }
        }
    }
    return SceneHit(L, nearestT);
}

// Angular radius of the cone of directions one pixel spans, from the screen-space derivatives of a unit
// direction (first-order ray differentials). Must be called in uniform control flow.
fn footprintCone(dir: vec3<f32>) -> f32 {
    let omega = length(cross(dpdxFine(dir), dpdyFine(dir)));   // solid angle of the pixel's direction patch
    return sqrt(omega / PI);
}

// World-space ray through an NDC point, valid for perspective and orthographic cameras: unproject two NDC
// depths on the pixel's line of sight (either depth convention, [0,1] or [−1,1], has both 0 and 1 in range).
struct Ray { origin: vec3<f32>, dir: vec3<f32> };
fn rayThroughNdc(ndc: vec2<f32>, invProj: mat4x4<f32>, invView: mat4x4<f32>) -> Ray {
    let a4 = invProj * vec4<f32>(ndc, 0.0, 1.0);
    let b4 = invProj * vec4<f32>(ndc, 1.0, 1.0);
    let a = (invView * vec4<f32>(a4.xyz / a4.w, 1.0)).xyz;
    let b = (invView * vec4<f32>(b4.xyz / b4.w, 1.0)).xyz;
    return Ray(a, normalize(b - a));
}

// uv (0,0 = top-left) → NDC xy.
fn uvToNdc(uv: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y);
}
