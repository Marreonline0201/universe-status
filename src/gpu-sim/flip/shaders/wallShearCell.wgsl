// wallShearCell.wgsl — the floor's wall shear, pass 2 of 3 (FRICTION spec §3.2–3.3; flipRef.applyWallShear per cell):
// per floor cell c = i + nx·k with n_c floor-row particles, from wallShearScatter's sums:
//   M̂_c = Σm̂, U_c = Σm̂·v_t/Σm̂ (x and z), h_c = R = min((n_c + n1_c)·V_p/dx², dx) with V_p = dx³/ppc and n1_c the
//   particles of row 1 over the cell (the depth from the counts of rows 0 and 1: prereg R-F2, review CPU-F2,
//   2026-09-30; a cell with n_c = 0 is not acted on, whatever n1_c), ρ_c = M_c/(n_c·V_p), μ_c = Σμ·m̂/Σm̂, ν_c = μ_c/ρ_c;
//   τ from the law — Keulegan 1938 eq. 32, ū/u* = a_s − b + b·ln(R·u*/ν) with R = h_c, τ = ρ_c·u*², and the developed
//   laminar film τ = 3μ_c·U/h_c where Re_h = U·h_c/ν_c < WP.reCross (428.26: the branches meet there) — or a gate's
//   test law (darcyTest τ = ρ_c·(f/8)·U², constantTest τ);
//   the semi-implicit update with the coefficient τ/|U_c| lagged: a = Δt·τ·dx²/(M_c·|U_c|), Δv = −U_c·a/(1 + a) (so
//   U_c′ = U_c/(1 + a): never reversed, the cell's tangential energy never raised; this form avoids U_c·(f − 1)'s
//   cancellation, which would raise the f32 error of W1a from 2.9e-5 to 1.0e-4).
// Out per cell (vec4): Δv_x, Δv_z, τ (Pa), branch (0 not acted on, 1 laminar, 2 eq. 32, 3 a test law); wallShearApply
// adds Δv to the cell's floor-row particles. The stage log (WS_ST_*) is summed per workgroup, then once globally.
// `lawTest` evaluates the law alone on a list of points (gate W1b on the GPU).

@group(0) @binding(2) var<storage, read> accR: array<i32>;
@group(0) @binding(3) var<storage, read_write> cellOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> lawIn: array<f32>;                // lawTest: per point U, h, ν, μ, ρ, 0, 0, 0
@group(0) @binding(6) var<storage, read_write> lawOut: array<vec4<f32>>;   // lawTest: per point τ, u*, 1 laminar / 0 eq. 32, 0

const LAW_KEULEGAN: u32 = 0u;
const LAW_DARCY: u32 = 1u;
const LAW_CONSTANT: u32 = 2u;

/// Keulegan 1938 eq. 32 with the laminar film below the crossing (flipRef.keuleganTau): (τ Pa, u* m/s, 1 on the laminar
/// branch / 0 on eq. 32) for a tangential mean speed U (m/s) over a depth h (m) of a liquid with ν (m²/s), μ = ρν
/// (Pa·s) and ρ (kg/m³). The film is 3μU/h with μ given (the W1g laminar bound's chain: two products and a quotient).
/// Eq. 32 by Newton on g(u*) = u*·(a_s − b + b·ln(h·u*/ν)) − U from U/25 for WP.newton steps; g' = a_s + b·ln(h·u*/ν)
/// > 0 while h·u*/ν > e^(−a_s/b), so an iterate that would leave that range is halved instead (the CPU's rule).
fn keulegan(U: f32, h: f32, nu: f32, mu: f32, rho: f32) -> vec3<f32> {
  if (!(U > 0.0) || !(h > 0.0) || !(nu > 0.0)) { return vec3<f32>(0.0, 0.0, 1.0); }
  if (U * h / nu < WP.reCross) {
    let tau = 3.0 * mu * U / h;
    return vec3<f32>(tau, sqrt(tau / rho), 1.0);
  }
  let xMin = exp(-WP.aS / WP.b);
  var us = U / 25.0;
  for (var it = 0u; it < WP.newton; it++) {
    let L = (WP.aS - WP.b) + WP.b * log(h * us / nu);
    var next = us - (us * L - U) / (L + WP.b);
    if (!(next > 0.0) || !(h * next / nu > xMin)) { next = 0.5 * us; }
    us = next;
  }
  return vec3<f32>(rho * us * us, us, 0.0);
}

/// One accumulator sum in quanta: the hi word plus (PRECISE_P2G) the remainder word (gridUpdate.wgsl's decode).
fn decode(base: u32, w: u32) -> f32 {
  var x = f32(accR[base + w]);
  if (PRECISE_P2G) { x += f32(accR[base + WS_LO + w]) / LO_SCALE; }
  return x;
}

var<workgroup> wgCells: atomic<u32>;
var<workgroup> wgBooked: atomic<u32>;
var<workgroup> wgLaminar: atomic<u32>;
var<workgroup> wgTauMax: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let c = gid.x;
  if (c < u32(P.n.x * P.n.z)) {
    var out = vec4<f32>(0.0);
    let base = WS_WORDS * c;
    let n = accR[base + WS_COUNT];
    let Mq = decode(base, WS_MASS);
    if (n > 0 && Mq > 0.0) {
      // U_c = (Σm̂·v/momScale)/(Σm̂/massScale): the quotient of the words times massScale/momScale (a power of two)
      let r = WP.massScale * WP.invMomScale;
      let Ux = decode(base, WS_MX) / Mq * r;
      let Uz = decode(base, WS_MZ) / Mq * r;
      let U = length(vec2<f32>(Ux, Uz));
      if (U > 0.0) {
        let Mh = Mq * WP.invMassScale;
        let nf = f32(n);
        let n1 = accR[base + WS_COUNT1];
        let hc = min(f32(n + n1) * P.dx * P.invPpc, P.dx);
        let rho = Mh * P.rhoPpc / nf;
        let muC = decode(base, WS_MU) / Mq;
        var tau = 0.0;
        var branch = 3.0;
        if (WP.law == LAW_DARCY) { tau = rho * (WP.f * 0.125) * U * U; }
        else if (WP.law == LAW_CONSTANT) { tau = WP.tau; }
        else {
          let kl = keulegan(U, hc, muC / rho, muC, rho);
          tau = kl.x;
          branch = select(2.0, 1.0, kl.z > 0.5);
        }
        let a = P.dt * tau * WP.kA / (Mh * U);
        let k = -a / (1.0 + a);
        out = vec4<f32>(Ux * k, Uz * k, tau, branch);
        atomicAdd(&wgCells, 1u);
        if (out.x != 0.0 || out.y != 0.0) { atomicAdd(&wgBooked, 1u); }
        if (branch == 1.0) { atomicAdd(&wgLaminar, 1u); }
        atomicMax(&wgTauMax, bitcast<u32>(abs(tau)));
      }
    }
    cellOut[c] = out;
  }
  workgroupBarrier();
  if (li == 0u) {
    let nc = atomicLoad(&wgCells);
    if (nc > 0u) {
      atomicAdd(&stats[WS_ST_CELLS], nc);
      atomicAdd(&stats[WS_ST_BOOKED], atomicLoad(&wgBooked));
      atomicAdd(&stats[WS_ST_LAMINAR], atomicLoad(&wgLaminar));
      atomicMax(&stats[WS_ST_TAUMAX], atomicLoad(&wgTauMax));
    }
  }
  if (c == 0u) { atomicAdd(&stats[WS_ST_APPLIED], 1u); }
}

@compute @workgroup_size(64)
fn lawTest(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&lawOut)) { return; }
  let s = 8u * i;
  lawOut[i] = vec4<f32>(keulegan(lawIn[s], lawIn[s + 1u], lawIn[s + 2u], lawIn[s + 3u], lawIn[s + 4u]), 0.0);
}
