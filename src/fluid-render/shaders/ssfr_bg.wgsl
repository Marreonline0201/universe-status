// ssfr_bg.wgsl — Background pass: renders scene behind the fluid.
// Dark background with a grid floor and wireframe box.
// Output goes to bgTexture which the composite pass samples for refraction.

struct RenderUniforms {
    invProjMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    invViewMatrix: mat4x4<f32>,
    screenSize: vec2<f32>,
    sphereRadius: f32,
    _pad: f32,
    // Ball: center.xyz packed with its own radius in .w
    ballData: vec4<f32>,
    // Ball meta: .x = 1.0 if active, 0.0 otherwise. .yzw pad.
    ballMeta: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: RenderUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Fullscreen triangle
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vi) / 2) * 4.0 - 1.0;
    let y = f32(i32(vi) % 2) * 4.0 - 1.0;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

fn getCameraPos() -> vec3<f32> {
    return (uniforms.invViewMatrix * vec4<f32>(0.0, 0.0, 0.0, 1.0)).xyz;
}

fn getRayDir(uv: vec2<f32>) -> vec3<f32> {
    // vs_main stores uv with Y flipped (uv.y=0 at top, uv.y=1 at bottom),
    // which is the screen-texture convention. To recover WebGPU NDC
    // (y=+1 top, y=-1 bottom), we must flip Y back when reconstructing
    // the ray. Without this flip the whole raytraced scene renders
    // upside-down relative to the particle-splatted fluid.
    let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y, -1.0, 1.0);
    let viewDir = uniforms.invProjMatrix * ndc;
    let worldDir = (uniforms.invViewMatrix * vec4<f32>(viewDir.xyz, 0.0)).xyz;
    return normalize(worldDir);
}

// Ray-sphere intersection. Returns distance along ray (negative if no hit).
fn intersectSphere(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, radius: f32) -> f32 {
    let oc = ro - center;
    let b = dot(oc, rd);
    let c = dot(oc, oc) - radius * radius;
    let h = b * b - c;
    if (h < 0.0) { return -1.0; }
    let t = -b - sqrt(h);
    return t;
}

// Fragment shader outputs: color (to bgTex) and eye-space depth (to bgDepthTex).
// The depth must use the same convention as the fluid depth texture
// (negative eye-space Z stored positive), so composite can compare them.
struct FragOutput {
    @location(0) color: vec4<f32>,
    @location(1) depth: f32,
};

@fragment
fn fs_main(in: VertexOutput) -> FragOutput {
    let camPos = getCameraPos();
    let rayDir = getRayDir(in.uv);

    // Dark blue-black background (like deep space / dark room)
    var bgColor = vec3<f32>(0.024, 0.031, 0.063);
    // Track nearest solid hit so later primitives can occlude farther ones.
    var nearestT = 1e9;

    // ── Floor grid (y = 0 plane) ────────────────────────────────────
    // The MLS-MPM sim domain is [0,1]³. Floor is at y=0.
    if (abs(rayDir.y) > 0.001) {
        let t = -camPos.y / rayDir.y;
        if (t > 0.0 && t < nearestT) {
            let hitPos = camPos + t * rayDir;
            // Only draw grid inside [0,1] × [0,1] with small margin
            if (hitPos.x > -0.02 && hitPos.x < 1.02 && hitPos.z > -0.02 && hitPos.z < 1.02) {
                let gridSize = 0.05;  // 20 divisions across the unit box
                let lineWidth = 0.003;

                let isLineX = abs(fract(hitPos.x / gridSize + 0.5) - 0.5) < lineWidth / gridSize;
                let isLineZ = abs(fract(hitPos.z / gridSize + 0.5) - 0.5) < lineWidth / gridSize;

                if (isLineX || isLineZ) {
                    bgColor = vec3<f32>(0.08, 0.12, 0.20); // subtle blue grid
                } else {
                    bgColor = vec3<f32>(0.035, 0.045, 0.08); // slightly lighter floor
                }
                nearestT = t;
            }
        }
    }

    // ── Wireframe box edges [0,1]³ ──────────────────────────────────
    // Check ray intersection with box faces and draw edges
    let boxMin = vec3<f32>(0.0);
    let boxMax = vec3<f32>(1.0);
    let edgeWidth = 0.004;

    // Ray-box intersection (slab method)
    let invDir = 1.0 / rayDir;
    let t1 = (boxMin - camPos) * invDir;
    let t2 = (boxMax - camPos) * invDir;
    let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
    let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));

    if (tmax > max(tmin, 0.0)) {
        let hitT = select(tmin, tmax, tmin < 0.0);
        if (hitT < nearestT) {
            let hitPos = camPos + hitT * rayDir;

            // Check if near an edge (where 2+ coordinates are near 0 or 1)
            let nearX0 = abs(hitPos.x) < edgeWidth;
            let nearX1 = abs(hitPos.x - 1.0) < edgeWidth;
            let nearY0 = abs(hitPos.y) < edgeWidth;
            let nearY1 = abs(hitPos.y - 1.0) < edgeWidth;
            let nearZ0 = abs(hitPos.z) < edgeWidth;
            let nearZ1 = abs(hitPos.z - 1.0) < edgeWidth;

            let nearX = nearX0 || nearX1;
            let nearY = nearY0 || nearY1;
            let nearZ = nearZ0 || nearZ1;

            // An edge is where at least 2 axes are near boundary
            let edgeCount = u32(nearX) + u32(nearY) + u32(nearZ);
            if (edgeCount >= 2u) {
                bgColor = vec3<f32>(0.0, 0.6, 1.0); // bright blue edges
                nearestT = hitT;
            }
        }
    }

    // ── Ball (metallic sphere obstacle) ─────────────────────────────
    // The ball lives in MLS-MPM [0,1]³ space. When the user drops one,
    // the simulator pushes it through the fluid — we need to show it
    // behind the water so refraction picks up a real object.
    if (uniforms.ballMeta.x > 0.5) {
        let ballCenter = uniforms.ballData.xyz;
        let ballRadius = uniforms.ballData.w;
        let tBall = intersectSphere(camPos, rayDir, ballCenter, ballRadius);
        if (tBall > 0.0 && tBall < nearestT) {
            let hitPos = camPos + tBall * rayDir;
            let normal = normalize(hitPos - ballCenter);
            // Simple metallic shading — directional key light + ambient.
            let lightDir = normalize(vec3<f32>(0.3, 1.0, 0.6));
            let NdotL = max(0.0, dot(normal, lightDir));
            let viewDir = -rayDir;
            let halfVec = normalize(lightDir + viewDir);
            let spec = pow(max(0.0, dot(normal, halfVec)), 60.0);
            let ambient = 0.15;
            // Grey metal (matches Three.js MeshStandardMaterial 0x888888)
            let base = vec3<f32>(0.52, 0.52, 0.54);
            bgColor = base * (ambient + NdotL * 0.75) + vec3<f32>(1.0, 0.98, 0.95) * spec * 0.9;
            nearestT = tBall;
        }
    }

    // Convert world-space ray distance to eye-space depth that matches
    // the fluid depth convention (positive-valued negative-Z).
    // If no surface hit (nearestT still 1e9), emit a far sentinel so
    // the composite's depth compare won't let bg occlude anything.
    var eyeDepth = 1e6;
    if (nearestT < 1e8) {
        let hitWorld = camPos + nearestT * rayDir;
        let hitEye = uniforms.viewMatrix * vec4<f32>(hitWorld, 1.0);
        // Fluid depth stores -eyeZ (positive). Match it.
        eyeDepth = -hitEye.z;
    }

    var out: FragOutput;
    out.color = vec4<f32>(bgColor, 1.0);
    out.depth = eyeDepth;
    return out;
}
