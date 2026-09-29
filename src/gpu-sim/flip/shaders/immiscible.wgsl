// immiscible.wgsl — sub-grid drop slip for immiscible liquids (Manninen, Taivassalo & Kallio 1996 algebraic-slip drift
// flux; drop size from Hinze 1955 or a scenario's). The f64 reference is flipRef.driftFlux; spec: vault
// fluid/realism-2026-09/IMMISCIBILITY-spec.md. One module, several entry points (ImmiscibleSolver.ts); common.wgsl is
// prepended; every entry binds ≤ 8 storage buffers. Every sum is fixed point (order-independent, as the rest of the solver).
// The per-cell sums are never cleared wholesale: the pass that consumes them (cellInfo, driftCells) reads each word with
// atomicExchange(·, 0), so the buffers are all-zero between substeps and only what particles wrote is touched (clearing
// the 43 MB of a 64³ window every substep cost more than the drift's kernels together).
//   faceAccel      faces, after the final projection: a = g − Du/Dt = (u* − u)/Δt where the projection set u, g_a on
//                  SOLID faces, unset elsewhere — then extrapolated like the velocity (extrapolate.wgsl, the caller)
//   alphaScatter   particles → per cell and material slot Σw (trilinear to cell centres), and the cell total
//   cellInfo       cells → ε = 2·ν_eff·S:S, the majority slot c, ρ_m, α_c, α per slot
//   slipParticles  particles → slip s and drop diameter d (0 = resolved), cell sums of slip per slot, statistics
//   driftCells     cells → J = Σ_k α_k·ū_Ck
//   driftParticles particles → the drift u_V = (dispersed ? s : 0) − J, added to the advection by g2pMac

struct ImmParams {
  K: u32,               // material slots in use (≤ 4)
  nuNum: f32,           // the scheme's numerical viscosity, m²/s (ε's implicit-LES assumption)
  dropOverride: f32,    // m; > 0: every dispersed drop has this diameter (scenario), else Hinze
  pad0: f32,
  props: array<vec4<f32>, 4>,    // per slot (ρ kg/m³, μ Pa·s, 0, 0)
  sigma: array<vec4<f32>, 4>,    // σ[k][c] N/m of the pair (row k, column c); ≤ 0: miscible or unsourced — no slip
  slots: array<vec4<u32>, 64>,   // composition id → slot (≥ K: not tracked)
}
@group(0) @binding(1) var<uniform> IP: ImmParams;

@group(0) @binding(2) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> aux: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> alphaSums: array<atomic<i32>>;   // 10 words per padded cell
@group(0) @binding(6) var<storage, read_write> cellInf: array<f32>;             // 8 per padded cell
@group(0) @binding(7) var<storage, read> cellInfR: array<f32>;
@group(0) @binding(8) var<storage, read> u: array<f32>;
@group(0) @binding(11) var<storage, read> faceType: array<u32>;
@group(0) @binding(12) var<storage, read_write> slipState: array<vec4<f32>>;    // per particle (s, d)
@group(0) @binding(13) var<storage, read_write> slipSums: array<atomic<i32>>;   // 7 per (padded cell, slot), then the stats
@group(0) @binding(15) var<storage, read_write> driftCell: array<vec4<f32>>;
@group(0) @binding(16) var<storage, read> driftCellR: array<vec4<f32>>;
@group(0) @binding(17) var<storage, read_write> drift: array<vec4<f32>>;
@group(0) @binding(20) var<storage, read> slipStateR: array<vec4<f32>>;
@group(0) @binding(24) var<storage, read> faceSolid: array<f32>;
@group(0) @binding(25) var<storage, read> uStar: array<f32>;
@group(0) @binding(26) var<storage, read> validProj: array<u32>;
@group(0) @binding(27) var<storage, read_write> accOut: array<f32>;
@group(0) @binding(28) var<storage, read_write> accValidOut: array<u32>;
@group(0) @binding(29) var<storage, read> acc: array<f32>;
@group(0) @binding(30) var<storage, read> uProj: array<f32>;
// per particle, 2 × vec4 (diagnostics: the slip's own inputs at the last substep, zero when not dispersed):
// (a = g − Du/Dt xyz, α_d = 1 − α_c), (ρ_m, μ_m, Re, 0) — the gates split a slip's excess into its inputs vs its law
@group(0) @binding(31) var<storage, read_write> slipInputs: array<vec4<f32>>;

const MAXK: u32 = 4u;
fn slotOfComp(id: u32) -> u32 { if (id >= 256u) { return MAXK; } return IP.slots[id / 4u][id % 4u]; }
fn cellOfPos(x: vec3<f32>) -> vec3<i32> { return clamp(vec3<i32>(floor(x / P.dx)), vec3<i32>(0), P.n - vec3<i32>(1)); }
fn fixHi(v: f32) -> i32 { return i32(round(v)); }
fn fixLo(v: f32) -> i32 { return i32(round((v - round(v)) * LS_LO_SCALE)); }
fn dec2(hi: i32, lo: i32, scale: f32) -> f32 { return (f32(hi) + f32(lo) / LS_LO_SCALE) / scale; }
/// Slip sums: 2^16 per m/s (±32768 m/s per cell sum; the remainder word resolves each add to 2^-36 m/s). Volume
/// weights use LS_SCALE (w ≤ 1 per add, Σw ≤ 512 per cell).
const SLIP_SCALE: f32 = 65536.0;
/// The drag factor f = C_D·Re/24 (MTK (40), Schiller & Naumann 1933; Newton's C_D = 0.44 from Re 1000) — flipRef.dragFactor.
fn dragFactor(Re: f32) -> f32 {
  if (Re >= 1000.0) { return 0.44 * Re / 24.0; }
  if (Re <= 0.0) { return 1.0; }   // at rest (pow(0, y) is not defined in WGSL)
  return 1.0 + 0.15 * pow(Re, 0.687);
}
/// 1 − e^(−h) without the cancellation of 1 − exp(−h) at small h (the f64 reference uses −expm1(−h)): a heavy drop
/// from rest has h ~ 1e-4, where 1 − exp(−h) in f32 keeps ~3 digits. Below 0.1 the series to h⁵ (relative remainder
/// ≤ h⁵/720 = 1.4e-8); above it the exp's absolute error is ≤ 2e-6 of m.
fn oneMinusExpNeg(h: f32) -> f32 {
  if (h < 0.1) { return h * (1.0 - h * (0.5 - h * (1.0 / 6.0 - h * (1.0 / 24.0 - h / 120.0)))); }
  return 1.0 - exp(-h);
}

/// a = g − Du/Dt on the faces (flipRef.captureFaceAccel): in FLIP the grid step is the material derivative, so on the
/// faces the final projection set it is (u* − u)/Δt — the solver's own balance (g on every liquid face at rest,
/// whatever the density); static walls g_a (Du_n/Dt = 0 there); every other face unset for the extrapolation.
@compute @workgroup_size(256)
fn faceAccel(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= 3u * P.size) { return; }
  let a = tid / P.size;
  let c = logicalOfThread(tid % P.size);
  if (!inFaceRange(a, c)) { return; }
  let s = gridBase(a) + slotOf(c);
  if (faceType[s] == SOLID) { accOut[s] = P.gravity[a]; accValidOut[s] = 0u; return; }
  if (faceSolid[s] >= 1.0 || validProj[s] != 1u) { accOut[s] = 0.0; accValidOut[s] = 0u; return; }
  accOut[s] = (uStar[s] - uProj[s]) / P.dt;
  accValidOut[s] = 1u;
}

@compute @workgroup_size(64)
fn alphaScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let k = slotOfComp(aux[q].x);
  if (k >= IP.K) { return; }
  let f = pos[q].xyz / P.dx - vec3<f32>(0.5);
  let b = vec3<i32>(floor(f));
  let t = f - floor(f);
  for (var m = 0u; m < 8u; m++) {
    let d = vec3<i32>(i32(m & 1u), i32((m >> 1u) & 1u), i32((m >> 2u) & 1u));
    let c = b + d;
    if (any(c < vec3<i32>(0)) || any(c >= P.n)) { continue; }
    let wv = select(vec3<f32>(1.0) - t, t, d == vec3<i32>(1));
    let w = wv.x * wv.y * wv.z;
    if (w <= 0.0) { continue; }
    let base = 10u * linIdx(c);
    let v = w * LS_SCALE;
    atomicAdd(&alphaSums[base + 2u * k], fixHi(v)); atomicAdd(&alphaSums[base + 2u * k + 1u], fixLo(v));
    atomicAdd(&alphaSums[base + 8u], fixHi(v)); atomicAdd(&alphaSums[base + 9u], fixLo(v));
  }
}

fn uFace(a: u32, c: vec3<i32>) -> f32 { return u[gridBase(a) + slotOf(c)]; }
/// u_a at the centre of cell c: the mean of its two a-faces.
fn uCentre(a: u32, c: vec3<i32>) -> f32 { var c2 = c; c2[a] += 1; return 0.5 * (uFace(a, c) + uFace(a, c2)); }

@compute @workgroup_size(256)
fn cellInfo(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  let base = 10u * li;
  // a cell no tracked particle reaches: nothing to clear, and nothing reads its info (slipParticles reads the cells of
  // tracked particles, whose own weight makes Σw > 0; driftCells only where a drop was counted)
  let totHi = atomicExchange(&alphaSums[base + 8u], 0);
  let totLo = atomicExchange(&alphaSums[base + 9u], 0);
  if (totHi == 0 && totLo == 0) { return; }
  let tot = dec2(totHi, totLo, LS_SCALE);
  var al = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var k = 0u; k < IP.K; k++) {
    let hi = atomicExchange(&alphaSums[base + 2u * k], 0);
    let lo = atomicExchange(&alphaSums[base + 2u * k + 1u], 0);
    al[k] = dec2(hi, lo, LS_SCALE) / tot;
  }
  var cm = 0u;
  for (var k = 1u; k < IP.K; k++) { if (al[k] > al[cm]) { cm = k; } }
  var rm = 0.0;
  for (var k = 0u; k < IP.K; k++) { rm += al[k] * IP.props[k].x; }
  // ∇u (flipRef.driftFlux epsAt): diagonal from the cell's two faces, off-diagonal by central differences of the
  // cell-centred u_a over the neighbours along b, one-sided at the walls
  var G: array<array<f32, 3>, 3>;
  for (var a = 0u; a < 3u; a++) {
    for (var bb = 0u; bb < 3u; bb++) {
      if (a == bb) { var c2 = c; c2[a] += 1; G[a][bb] = (uFace(a, c2) - uFace(a, c)) / P.dx; continue; }
      var lo = c; var hi = c;
      lo[bb] = max(0, c[bb] - 1); hi[bb] = min(P.n[bb] - 1, c[bb] + 1);
      G[a][bb] = select(0.0, (uCentre(a, hi) - uCentre(a, lo)) / (f32(hi[bb] - lo[bb]) * P.dx), hi[bb] > lo[bb]);
    }
  }
  var ss = 0.0;
  for (var a = 0u; a < 3u; a++) { for (var bb = 0u; bb < 3u; bb++) { let s = 0.5 * (G[a][bb] + G[bb][a]); ss += s * s; } }
  let nuEff = IP.props[cm].y / IP.props[cm].x + IP.nuNum;
  let o = 8u * li;
  cellInf[o] = 2.0 * nuEff * ss;
  cellInf[o + 1u] = f32(cm);
  cellInf[o + 2u] = rm;
  cellInf[o + 3u] = al[cm];
  for (var k = 0u; k < 4u; k++) { cellInf[o + 4u + k] = al[k]; }
}

/// a = g − Du/Dt at a point: each face grid of the (extrapolated) face accelerations sampled trilinearly — the stencil of
/// g2pMac.sampleFace and flipRef.stencil.
fn accelAt(x: vec3<f32>) -> vec3<f32> {
  var g = vec3<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    let f = x / P.dx - faceOffset(a);
    let b = vec3<i32>(floor(f));
    let t = f - floor(f);
    var v = 0.0;
    for (var m = 0u; m < 8u; m++) {
      let d = vec3<i32>(i32(m & 1u), i32((m >> 1u) & 1u), i32((m >> 2u) & 1u));
      let wv = select(vec3<f32>(1.0) - t, t, d == vec3<i32>(1));
      let c = b + d;
      if (inFaceRange(a, c)) { v += wv.x * wv.y * wv.z * acc[gridBase(a) + slotOf(c)]; }
    }
    g[a] = v;
  }
  return g;
}

const ST_DISPERSED: u32 = 0u;
const ST_TOO_LARGE: u32 = 1u;
const ST_MAX_SLIP: u32 = 2u;     // f32 bits of |s| (non-negative floats order like integers)
const ST_DROP_LO: u32 = 3u;      // Σd in µm as a 64-bit sum: low word (wrapping), then the carries
const ST_DROP_HI: u32 = 4u;
fn statsBase() -> u32 { return 7u * MAXK * P.size; }

@compute @workgroup_size(64)
fn slipParticles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let k = slotOfComp(aux[q].x);
  slipInputs[2u * q] = vec4<f32>(0.0); slipInputs[2u * q + 1u] = vec4<f32>(0.0);
  if (k >= IP.K) { slipState[q] = vec4<f32>(0.0); return; }   // untracked: its cell's info may not exist
  let x = pos[q].xyz;
  let li = linIdx(cellOfPos(x));
  let o = 8u * li;
  let cm = u32(cellInfR[o + 1u]);
  if (k == cm) { slipState[q] = vec4<f32>(0.0); return; }
  let sig = IP.sigma[k][cm];
  if (!(sig > 0.0)) { slipState[q] = vec4<f32>(0.0); return; }
  let rp = IP.props[k].x; let mup = IP.props[k].y; let rc = IP.props[cm].x; let muc = IP.props[cm].y;
  var d = IP.dropOverride;
  if (!(d > 0.0)) {
    // Hinze 1955 d_max = 0.725·(ρ_c/σ)^(−3/5)·ε^(−2/5); breakup only
    let eps = cellInfR[o];
    var dMax = 3.0e38;
    if (eps > 0.0) { dMax = 0.725 * pow(rc / sig, -0.6) * pow(eps, -0.4); }
    let dOld = slipState[q].w;
    d = select(dMax, min(dOld, dMax), dOld > 0.0);
  }
  let sb = statsBase();
  if (!(d < P.dx)) { slipState[q] = vec4<f32>(0.0); atomicAdd(&slipSums[sb + ST_TOO_LARGE], 1); return; }
  let rm = cellInfR[o + 2u];
  let aD = 1.0 - cellInfR[o + 3u];
  let muStar = (mup + 0.4 * muc) / (mup + muc);
  let muM = muc * pow(max(1e-12, 1.0 - aD), -2.5 * muStar);
  // (ρ_p + ½ρ_c)·ds/dt = (ρ_p − ρ_m)·a − 18 μ_m f(Re)·s/d², a = g − Du/Dt, integrated over the step with f at its start
  // (OpenFOAM-10 MomentumParcel::calc + integrationSchemes::analytical; flipRef.driftFlux)
  let sOld = slipState[q].xyz;
  let Re = d * rc * length(sOld) / muM;
  let kd = d * d / (18.0 * muM * dragFactor(Re));
  let m = oneMinusExpNeg(P.dt / ((rp + 0.5 * rc) * kd));
  let acc = accelAt(x);
  let s = sOld + ((rp - rm) * acc * kd - sOld) * m;
  slipState[q] = vec4<f32>(s, d);
  slipInputs[2u * q] = vec4<f32>(acc, aD);
  slipInputs[2u * q + 1u] = vec4<f32>(rm, muM, Re, 0.0);
  let cb = 7u * (MAXK * li + k);
  let v = s * SLIP_SCALE;
  atomicAdd(&slipSums[cb], fixHi(v.x)); atomicAdd(&slipSums[cb + 1u], fixLo(v.x));
  atomicAdd(&slipSums[cb + 2u], fixHi(v.y)); atomicAdd(&slipSums[cb + 3u], fixLo(v.y));
  atomicAdd(&slipSums[cb + 4u], fixHi(v.z)); atomicAdd(&slipSums[cb + 5u], fixLo(v.z));
  atomicAdd(&slipSums[cb + 6u], 1);
  atomicAdd(&slipSums[sb + ST_DISPERSED], 1);
  atomicMax(&slipSums[sb + ST_MAX_SLIP], bitcast<i32>(length(s)));
  let um = u32(round(d * 1.0e6));
  let old = bitcast<u32>(atomicAdd(&slipSums[sb + ST_DROP_LO], bitcast<i32>(um)));
  if (old + um < old) { atomicAdd(&slipSums[sb + ST_DROP_HI], 1); }
}

@compute @workgroup_size(256)
fn driftCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = vec3<u32>(P.n);
  let t = gid.x;
  if (t >= n.x * n.y * n.z) { return; }
  let c = vec3<i32>(vec3<u32>(t % n.x, (t / n.x) % n.y, t / (n.x * n.y)));
  let li = linIdx(c);
  var J = vec3<f32>(0.0);
  for (var k = 0u; k < IP.K; k++) {
    let cb = 7u * (MAXK * li + k);
    let cnt = atomicExchange(&slipSums[cb + 6u], 0);
    if (cnt <= 0) { continue; }
    var w: array<i32, 6>;
    for (var i = 0u; i < 6u; i++) { w[i] = atomicExchange(&slipSums[cb + i], 0); }
    let sum = vec3<f32>(dec2(w[0], w[1], SLIP_SCALE), dec2(w[2], w[3], SLIP_SCALE), dec2(w[4], w[5], SLIP_SCALE));
    J += cellInfR[8u * li + 4u + k] * (sum / f32(cnt));
  }
  driftCell[li] = vec4<f32>(J, 0.0);
}

@compute @workgroup_size(64)
fn driftParticles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.numParticles) { return; }
  let li = linIdx(cellOfPos(pos[q].xyz));
  let st = slipStateR[q];
  let own = select(vec3<f32>(0.0), st.xyz, st.w > 0.0);
  drift[q] = vec4<f32>(own - driftCellR[li].xyz, 0.0);
}
