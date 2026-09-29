// common.wgsl — shared by every APIC-MAC kernel (prepended at pipeline creation). WGSL mirror of
// src/sim-ref/gridLayout.ts: ONE index function for cells and all three face grids, a ghost layer per side,
// faces stored as each cell's LOWER face, toroidal window-relative addressing (S3N-1). Units are SI in
// window-local metres (S3N-5); gravity is a vector (S3N-6). Every kernel is diffed against src/sim-ref/flipRef.ts.

struct FlipParams {
  n: vec3<i32>,            // interior cells per axis (non-cubic allowed, S3N-2)
  numParticles: u32,
  ring: vec3<i32>,         // toroidal storage offsets, each in [0, n)
  apic: u32,               // 1 = APIC transfers, 0 = PIC (gate positive control only)
  gravity: vec3<f32>,      // m/s², window axes
  dx: f32,                 // m
  extent: vec3<f32>,       // window size, m (= n·dx)
  dt: f32,                 // s
  invMassUnit: f32,        // 1 / (ρ_ref·dx³), kg⁻¹ — grid mass unit (FINAL-PLAN §5.7)
  massScale: f32,          // fixed-point scale for mass (2^24)
  momScale: f32,           // fixed-point scale for momentum (2^19), unit (ρ_ref·dx³)·m/s
  wallEps: f32,            // m, particles kept this far inside the window
  lRef: f32,               // m, presentation length unit (1 world unit)
  tauS: f32,               // s, presentation time unit
  size: u32,               // padded slots per grid = (nx+2)(ny+2)(nz+2)
  rho: f32,                // kg/m³: the density of every face without variable density; the last-resort fallback with it
  lsR: f32,                // Zhu & Bridson kernel radius R = 2s, m (s = dx/∛ppc)
  lsRbar: f32,             // Zhu & Bridson particle radius r̄ = s/2, m
  thetaMin: f32,           // lower clamp of the liquid fraction θ of a liquid–air face
  ghost: u32,              // 1 = ghost-fluid free surface (S3.4), 0 = voxel (S3.1b)
  rhoPpc: f32,             // S3.5: ρ_ref·ppc, so a face density is ρ_f = rhoPpc·m̂_f/Σw (m̂ in ρ_ref·dx³ units, V_p = dx³/ppc)
  variable: u32,           // 1 = S3.5 variable density (per-face ρ_f), 0 = rho on every face
  wMin: f32,               // smallest Σw for which a face forms its own ρ_f (flipRef FACE_WEIGHT_MIN)
  invPpc: f32,             // 1/ppc = V_p/dx³ of every particle (the density projection's volume fraction)
}

@group(0) @binding(0) var<uniform> P: FlipParams;

const FLUID: u32 = 0u;
const SOLID: u32 = 1u;
const OPEN: u32 = 2u;
const GHOST: u32 = 3u;

// Diagnostics counters (u32): [0] wall clamps, [1] unset-face reads, [2] OPEN faces met (reserved type),
// [3] non-solid faces of liquid cells without u* when the divergence was formed, [4] density-correction push-backs,
// [5] / [6] S3.5 face-density fallbacks (neighbour mean / default rho).
const DIAG_WALL_CLAMPS: u32 = 0u;
const DIAG_UNSET_READS: u32 = 1u;
const DIAG_OPEN_FACES: u32 = 2u;
const DIAG_UNSET_DIVERGENCE: u32 = 3u;
const DIAG_DENSITY_CLAMPS: u32 = 4u;
const DIAG_RHO_NEIGHBOUR: u32 = 5u;   // faces whose ρ_f came from the neighbour mean (Σw < wMin)
const DIAG_RHO_DEFAULT: u32 = 6u;     // faces that fell back to rho (no neighbour had a density either)
const DIAG_MAX_SPEED: u32 = 7u;       // max particle speed after G2P (f32 bits: non-negative floats order like u32), m/s
const DIAG_UNRESOLVED_RELABELS: u32 = 8u;   // ghost labels: particle-holding φ ≥ 0 cells made LIQUID (lsResolve)
const DIAG_SPHERE_PUSHOUTS: u32 = 9u;       // particles pushed out of the drop ball (advection + density correction)

fn physIdx(i: i32, n: i32, ring: i32) -> i32 {
  if (i < 0) { return 0; }
  if (i >= n) { return n + 1; }
  return 1 + ((i + ring) % n);
}

/// THE index function: logical (i, j, k), each in −1 … n, to a slot of one grid.
fn slotOf(c: vec3<i32>) -> u32 {
  let p = P.n + vec3<i32>(2);
  return u32(physIdx(c.x, P.n.x, P.ring.x) + p.x * (physIdx(c.y, P.n.y, P.ring.y) + p.y * physIdx(c.z, P.n.z, P.ring.z)));
}

/// Offset of face grid `a` inside the concatenated three-grid buffers.
fn gridBase(a: u32) -> u32 { return a * P.size; }

/// Half-cell offsets of face grid `a`: 0 on its own axis, ½ on the others.
fn faceOffset(a: u32) -> vec3<f32> {
  var o = vec3<f32>(0.5);
  o[a] = 0.0;
  return o;
}

/// Window-local position (m) of face (a; c).
fn facePos(a: u32, c: vec3<i32>) -> vec3<f32> {
  return (vec3<f32>(c) + faceOffset(a)) * P.dx;
}

/// Logical coordinates of the thread that owns padded grid coordinate `t` (0 … n+1 per axis): logical = t − 1.
fn logicalOfThread(t: u32) -> vec3<i32> {
  let p = vec3<u32>(P.n + vec3<i32>(2));
  let x = t % p.x;
  let y = (t / p.x) % p.y;
  let z = t / (p.x * p.y);
  return vec3<i32>(i32(x), i32(y), i32(z)) - vec3<i32>(1);
}

/// Logical range check for face grid `a`: 0 … n on its own axis, −1 … n on the others.
fn inFaceRange(a: u32, c: vec3<i32>) -> bool {
  var lo = vec3<i32>(-1);
  lo[a] = 0;
  return all(c >= lo) && all(c <= P.n);
}

// Pressure-solver cell layout (PoissonSolver.ts level 0): padded, x fastest, NO ring — the pressure field is rebuilt
// every substep, so it needs no window-relative storage; kernels translate logical cells to this index.
const LABEL_AIR: u32 = 0u;
const LABEL_FLUID: u32 = 1u;
const LABEL_SOLID: u32 = 2u;
fn linIdx(c: vec3<i32>) -> u32 {
  return u32((c.x + 1) + (P.n.x + 2) * ((c.y + 1) + (P.n.y + 2) * (c.z + 1)));
}

fn encodeFixed(x: f32) -> i32 { return i32(round(x)); }

// Level-set sums (S3.4): per sample point Σw and Σw·(x_i − x_point)/dx, fixed point at LS_SCALE (range ±512).
const LS_SCALE: f32 = 4194304.0;   // 2^22

/// Zhu & Bridson φ (m) from the four sums of one sample point: |x_point − x̄| − r̄, or R where no particle is in reach.
fn phiFromSums(w: i32, rx: i32, ry: i32, rz: i32) -> f32 {
  if (w <= 0) { return P.lsR; }
  let r = vec3<f32>(f32(rx), f32(ry), f32(rz)) / f32(w) * P.dx;
  return length(r) - P.lsRbar;
}

/// Liquid fraction θ of the face between a LIQUID centre (φl) and an AIR centre (φa) with the face-centre sample φm
/// (flipRef.theta: the zero crossing on the two half-segments, clamped to [thetaMin, 1]).
fn thetaOf(fl: f32, fm: f32, fa: f32) -> f32 {
  // a LIQUID cell whose own φ ≥ 0 was relabelled (φ does not resolve its interface, flipRef.classifyLevelSet/theta):
  // its face is dry, θ = θmin
  if (fl >= 0.0) { return P.thetaMin; }
  var t: f32;
  if (fm >= 0.0) { t = 0.5 * fl / (fl - fm); } else { t = 0.5 + 0.5 * fm / (fm - fa); }
  return clamp(t, P.thetaMin, 1.0);
}

// Two-word fixed point (PRECISE_P2G): a sum is Σhi + Σlo/LO_SCALE quanta. hi = round(x) keeps the full range of one
// i32; lo = round((x − hi)·LO_SCALE) carries the remainder (|lo| ≤ LO_SCALE/2 per add), so a face with 64 adds is
// resolved to the f32 precision of each contribution instead of to half a quantum. x − hi is exact (Sterbenz).
const LO_SCALE: f32 = 4096.0;
override PRECISE_P2G: bool = true;
fn encodeLo(x: f32) -> i32 { return i32(round((x - round(x)) * LO_SCALE)); }

// ── S3.1c-2 the drop ball (flipRef sphere*; Batty, Bertails & Bridson 2007) ──────────────────────────────────────────
// Sphere state, one storage array<f32> of SPHERE_WORDS: centre (m, window-local) 0–2, radius 3, velocity (m/s) 4–6,
// active 7 (1/0), density 8 (kg/m³; 0 = scripted: the host sets the velocity, no integration), last pressure force
// (N) 9–11, discrete volume V_J (m³) 12. Written by the host (setSphere) and by sphereAdvance / sphereIntegrate.
const SPH_R: u32 = 3u;
const SPH_V: u32 = 4u;
const SPH_ACTIVE: u32 = 7u;
const SPH_DENSITY: u32 = 8u;
const SPH_FORCE: u32 = 9u;
const SPH_VJ: u32 = 12u;
// fixed-point scales of the force reduction (atomic i32): N·FORCE_SCALE, and V_J in face units ΣS·SOLID_SCALE
const FORCE_SCALE: f32 = 1024.0;
const SOLID_SCALE: f32 = 1048576.0;

/// Smooth partial volume of one subsample at x: clamp(½ − d/(dx/2), 0, 1), d = signed distance to the sphere surface.
fn sphereSub(x: vec3<f32>, c: vec3<f32>, R: f32) -> f32 {
  return clamp(0.5 - (length(x - c) - R) / (0.5 * P.dx), 0.0, 1.0);
}

/// Solid fraction of the dx³ control volume centred at x: 2×2×2 subsamples at ±dx/4 (flipRef.sphereFractions).
fn sphereBox(x: vec3<f32>, c: vec3<f32>, R: f32) -> f32 {
  var v = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3<f32>(f32(k & 1), f32((k >> 1) & 1), f32((k >> 2) & 1)) * 0.5 - vec3<f32>(0.25);
    v += sphereSub(x + o * P.dx, c, R);
  }
  return v / 8.0;
}

/// A particle position x pushed radially out of the sphere to its surface + wallEps (flipRef.sphereCollide); x itself
/// when it is outside. A particle exactly at the centre goes straight up.
fn sphereOut(x: vec3<f32>, c: vec3<f32>, R: f32) -> vec3<f32> {
  let d = x - c;
  let r = length(d);
  let Re = R + P.wallEps;
  if (r >= Re) { return x; }
  if (r <= 0.0) { return c + vec3<f32>(0.0, Re, 0.0); }
  return c + d * (Re / r);
}
