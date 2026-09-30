// wallShearCommon.wgsl — shared by the floor's wall-shear kernels (vault fluid/realism-2026-09/FRICTION-spec.md §3.3;
// the f64 reference is flipRef.applyWallShear): the stage's own uniform, the floor-cell accumulator's layout and the
// stage log's words. Prepended after common.wgsl (FlipParams P: dt, dx, n, rhoPpc, invPpc are read from there).

struct WallShearParams {
  law: u32,            // 0 keulegan1938 (Keulegan 1938 eq. 32; the laminar film 3μU/h below Re_h = reCross), 1 darcyTest, 2 constantTest
  newton: u32,         // Newton steps of eq. 32 on the turbulent branch, from u* = U/25 (spec §3.3: 6; f64 needs ≤ 5 to 1e-14)
  f: f32,              // darcyTest: τ = ρ_c·(f/8)·U² (gates only)
  tau: f32,            // constantTest: τ, Pa (gates only)
  aS: f32,             // Keulegan's a_s (5.5)
  b: f32,              // Keulegan's b (2.5)
  reCross: f32,        // Re_h = U·h/ν where the laminar film and eq. 32 meet (flipRef WALL_SHEAR_RE_CROSS, 428.26)
  muDefault: f32,      // Pa·s, a particle whose composition id lies past the μ table
  massScale: f32,      // fixed point of the mass and μ·m̂ words (MASS_SCALE = 2^24)
  invMassScale: f32,   // 1/massScale (a power of two: exact)
  momScale: f32,       // fixed point of the momentum words (MOM_SCALE = 2^19: ±4096 m̂·m/s per i32)
  invMomScale: f32,    // 1/momScale (exact)
  kA: f32,             // dx²/(ρ_ref·dx³) = 1/(ρ_ref·dx): a_c = Δt·τ·dx²/(M_c·|U_c|) = Δt·τ·kA/(M̂_c·|U_c|)
  pad0: f32,
  pad1: f32,
  pad2: f32,
}
@group(0) @binding(1) var<uniform> WP: WallShearParams;

// Floor-cell accumulator: WS_WORDS i32 per floor cell (i + nx·k); the hi words, then (PRECISE_P2G) the remainder words
// of mass, momentum x, momentum z and μ·m̂ at WS_LO + their index, then the row-1 count. The particle counts are exact
// in one word each: WS_COUNT the floor row's (⌊y/dx⌋ = 0), WS_COUNT1 row 1's (⌊y/dx⌋ = 1), which only the depth reads
// (prereg R-F2, review CPU-F2: R = min(dx, (n₀ + n₁)·V_p/dx²)).
const WS_WORDS: u32 = 10u;
const WS_MASS: u32 = 0u;
const WS_MX: u32 = 1u;
const WS_MZ: u32 = 2u;
const WS_MU: u32 = 3u;
const WS_COUNT: u32 = 4u;
const WS_LO: u32 = 5u;
const WS_COUNT1: u32 = 9u;

// The stage log (u32 words, cumulative until the host resets it): encodes of the stage (applications), cells acted
// on (a floor-row particle and |U_c| > 0), of those the cells with Δv ≠ 0 (a non-zero booked impulse), cells on the
// laminar branch, and the largest |τ| (f32 bits: non-negative floats order like u32). The counts are modulo 2³² since
// the last set or reset (FlipGpuSimulator.readWallShearStats): cells and booked wrap after ≈ 1.05 M applications of a
// fully wetted 64×64 floor (2.4 h at 2 substeps, 60 frames/s); the host takes deltas as (b − a) >>> 0 or resets per scene.
const WS_ST_APPLIED: u32 = 0u;
const WS_ST_CELLS: u32 = 1u;
const WS_ST_BOOKED: u32 = 2u;
const WS_ST_LAMINAR: u32 = 3u;
const WS_ST_TAUMAX: u32 = 4u;
const WS_STATS_WORDS: u32 = 8u;
