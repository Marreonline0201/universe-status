// g2pMac.wgsl — G2P from the three MAC face grids, then RK2 (midpoint) advection
// (FINAL-PLAN §5.2 step 12; flipRef.g2p followed by flipRef.advect).
//   v_a = Σ w·u_f,   c_a = Σ ∇w·u_f   (APIC-MAC; PIC control: c := 0)
//   x_mid = x + ½Δt·u(x),  x ← x + Δt·u(x_mid), kept wallEps inside the window (each push-back counted), then pushed
//   radially out of the drop ball if it ended inside (flipRef.advect → sphereCollide; counted).

@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> aff: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> u: array<f32>;
@group(0) @binding(5) var<storage, read> valid: array<u32>;
@group(0) @binding(6) var<storage, read_write> diag: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> sphere: array<f32>;

struct Sample { v: f32, g: vec3<f32>, unset: u32 }

/// Trilinear value (and weight-gradient sum) of face grid `a` at window-local point x.
fn sampleFace(a: u32, x: vec3<f32>, wantGrad: bool) -> Sample {
  let f = x / P.dx - faceOffset(a);
  let base = vec3<i32>(floor(f));
  let t = f - floor(f);
  let invDx = 1.0 / P.dx;
  var out = Sample(0.0, vec3<f32>(0.0), 0u);
  for (var dk = 0; dk < 2; dk++) {
    for (var dj = 0; dj < 2; dj++) {
      for (var di = 0; di < 2; di++) {
        let d = vec3<i32>(di, dj, dk);
        let is1 = d == vec3<i32>(1);
        let wv = select(vec3<f32>(1.0) - t, t, is1);
        let dw = select(vec3<f32>(-invDx), vec3<f32>(invDx), is1);
        let w = wv.x * wv.y * wv.z;
        let s = gridBase(a) + slotOf(base + d);
        if (valid[s] == 0u && (w != 0.0 || wantGrad)) { out.unset++; }
        let uf = u[s];
        out.v += w * uf;
        if (wantGrad) {
          out.g += vec3<f32>(dw.x * wv.y * wv.z, wv.x * dw.y * wv.z, wv.x * wv.y * dw.z) * uf;
        }
      }
    }
  }
  return out;
}

fn sampleVel(x: vec3<f32>, unset: ptr<function, u32>) -> vec3<f32> {
  var v = vec3<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    let s = sampleFace(a, x, false);
    v[a] = s.v;
    *unset += s.unset;
  }
  return v;
}

/// G2P + RK2 advection of particle q; returns its new speed |v| (m/s).
fn advance(q: u32) -> f32 {
  let x = pos[q].xyz;
  var unset = 0u;

  // G2P
  var v = vec3<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    let s = sampleFace(a, x, P.apic == 1u);
    v[a] = s.v;
    unset += s.unset;
    aff[3u * q + a] = vec4<f32>(select(vec3<f32>(0.0), s.g, P.apic == 1u), aff[3u * q + a].w);
  }
  vel[q] = vec4<f32>(v, vel[q].w);

  // RK2 midpoint advection through the grid velocity (v1 = the G2P velocity at x)
  let lo = vec3<f32>(P.wallEps);
  let hi = P.extent - vec3<f32>(P.wallEps);
  let mid = clamp(x + 0.5 * P.dt * v, lo, hi);
  let nx = x + P.dt * sampleVel(mid, &unset);
  let cx = clamp(nx, lo, hi);
  if (any(cx != nx)) { atomicAdd(&diag[DIAG_WALL_CLAMPS], 1u); }
  if (unset > 0u) { atomicAdd(&diag[DIAG_UNSET_READS], unset); }
  var fx = cx;
  if (sphere[SPH_ACTIVE] > 0.5) {
    fx = sphereOut(cx, vec3<f32>(sphere[0], sphere[1], sphere[2]), sphere[SPH_R]);
    if (any(fx != cx)) { atomicAdd(&diag[DIAG_SPHERE_PUSHOUTS], 1u); }
  }
  pos[q] = vec4<f32>(fx, pos[q].w);
  return length(v);
}

// Max particle speed, pre-reduced in the workgroup before one global atomic (FINAL-PLAN §5.2 step 12): v_lag for the
// substep count (§5.1). Non-negative f32 bit patterns order like u32. Workgroup memory starts zeroed.
var<workgroup> wgMaxSpeed: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let q = gid.x;
  if (q < P.numParticles) { atomicMax(&wgMaxSpeed, bitcast<u32>(advance(q))); }
  workgroupBarrier();
  if (li == 0u) { atomicMax(&diag[DIAG_MAX_SPEED], atomicLoad(&wgMaxSpeed)); }
}
