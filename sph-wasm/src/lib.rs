// ══════════════════════════════════════════════════════════════════════════════
// SPH Fluid Simulation — Rust/WASM
//
// Implements structure.md exactly:
//   §3.0 — Temperature propagation (Fourier's law: Q = k·A·ΔT/d)
//   §3.1 — Material properties (real values, Arrhenius viscosity)
//   §3.2 — SPH forces (Tait pressure, viscosity, surface tension)
//          Phase transitions with phaseProgress and latent heat
//   §3.11 — Ideal gas law for gas phase (P = ρ·R·T/M)
//
// Mechanical system uses normalized units (water ρ₀=1.0) for stability.
// Thermal system uses SI (°C, W/(m·K), J/(kg·K)) with real constants.
// ══════════════════════════════════════════════════════════════════════════════

use wasm_bindgen::prelude::*;
use std::f32::consts::PI;

// ── Physical Constants (SI) ────────────────────────────────────────────────
const R_GAS: f32 = 8.314;              // Universal gas constant (J/(mol·K))
const STEFAN_BOLTZMANN: f32 = 5.67e-8;  // Stefan-Boltzmann constant (W/(m²·K⁴))

// ── Simulation Parameters (normalized mechanical units) ────────────────────
const MAX_PARTICLES: usize = 10_000;
const H: f32 = 0.04;                    // kernel radius (smoothing length)
const H_SQ: f32 = H * H;
const PARTICLE_SPACING: f32 = H * 0.5;  // rest spacing = h/2
const GAMMA: f32 = 7.0;                 // Tait exponent (§3.2)
const CS: f32 = 8.0;                    // speed of sound (normalized)

// Box boundaries
const HALF_W: f32 = 1.0;
const HALF_H: f32 = 0.75;
const HALF_D: f32 = 0.75;

// Spatial hash
const TABLE_SIZE: usize = 16381;
const CELL_SIZE: f32 = H * 2.0;

// Thermal
const AMBIENT_TEMP: f32 = 20.0;         // °C
const THERMAL_SPEEDUP: f32 = 500.0;     // Demo speedup — for near-ambient temperatures
// Scaled down for hot materials to prevent unrealistic rapid solidification
// thermal_scale(T) = THERMAL_SPEEDUP / (1 + |T-ambient|/100)

// Phase constants
const PHASE_LIQUID: u8 = 0;
const PHASE_GAS: u8 = 1;
const PHASE_SOLID: u8 = 2;

// §3.9: Air drag — F_drag = 0.5 × ρ_air × v² × Cd × A
const RHO_AIR: f32 = 1.225;             // kg/m³ at sea level, 15°C (§3.9 line 8555)
const CD_SPHERE: f32 = 0.47;            // drag coefficient for sphere (§3.9 line 8581)
const PARTICLE_CROSS_SECTION: f32 = PARTICLE_SPACING * PARTICLE_SPACING * PI; // πr²

// §3.2 lines 2135-2148: Sleep/wake system
const SLEEP_VELOCITY_THRESHOLD: f32 = 0.005; // particles below this speed are candidates
const SLEEP_TICKS_REQUIRED: u32 = 30;        // 30 ticks dormant → skip computation
// "80-95% of particles sleeping at any time (zero cost until disturbed)"

// §3.2 lines 2470-2540: Secondary particles (spray)
// Weber number: We = ρ × v² × d / σ
const SPRAY_WEBER_THRESHOLD: f32 = 40.0; // §3.2: Weber number threshold for spray

// ── Kernel (cubic spline M4, 3D) — §3.2 ───────────────────────────────────

fn sigma_k() -> f32 { 1.0 / (PI * H * H * H) }

#[inline(always)]
fn kernel_w(r: f32) -> f32 {
    let q = r / H;
    if q >= 2.0 { return 0.0; }
    let s = sigma_k();
    if q <= 1.0 {
        s * (1.0 - 1.5 * q * q + 0.75 * q * q * q)
    } else {
        let t = 2.0 - q;
        s * 0.25 * t * t * t
    }
}

#[inline(always)]
fn kernel_grad_over_r(r: f32) -> f32 {
    if r < 1e-8 { return 0.0; }
    let q = r / H;
    if q >= 2.0 { return 0.0; }
    let s = sigma_k() / H;
    if q <= 1.0 {
        s * (-3.0 * q + 2.25 * q * q) / r
    } else {
        let t = 2.0 - q;
        s * (-0.75 * t * t) / r
    }
}

#[inline(always)]
fn kernel_lap(r: f32) -> f32 {
    let q = r / H;
    if q >= 2.0 { return 0.0; }
    let s = sigma_k() / (H * H);
    if q <= 1.0 {
        s * (-3.0 + 4.5 * q)
    } else {
        s * (3.0 - 1.5 * q)
    }
}

// ── Materials — §3.1 Property Calculator ───────────────────────────────────
// All thermal values are REAL SI from structure.md §3.1
// Mechanical values (rho0, mu_ref) are normalized (water=1.0 density)

#[derive(Clone, Copy)]
struct Mat {
    // Normalized mechanical properties
    rho0: f32,              // rest density (normalized: water=1.0)
    mu_ref: f32,            // reference viscosity (normalized: water=0.01)
    surface_tension: f32,   // surface tension coefficient (normalized)

    // SI thermal properties (§3.1 lines 378-431)
    thermal_conductivity: f32,  // W/(m·K)
    specific_heat: f32,         // J/(kg·K)
    melting_point: f32,         // °C
    boiling_point: f32,         // °C
    latent_heat_fusion: f32,    // J/kg
    latent_heat_vaporization: f32, // J/kg
    emissivity: f32,            // 0-1 (Kirchhoff's law, §3.1)

    // §3.1 Arrhenius: μ = A·exp(Ea/(R·T))
    // We store Ea/R directly (K) — higher = more temperature-sensitive
    // Real values from fluid mechanics literature
    arrhenius_ea_over_r: f32,   // Ea/R in Kelvin
    mu_ref_temp: f32,           // °C — temperature where mu_ref was measured

    // §3.1 Non-Newtonian Cross model (lines 1223-1227)
    // μ(γ̇) = μ∞ + (μ₀ - μ∞) / (1 + (K·γ̇)^n)
    is_non_newtonian: bool,
    cross_mu0: f32,    // zero-shear viscosity (normalized)
    cross_mu_inf: f32, // infinite-shear viscosity (normalized)
    cross_k: f32,      // time constant
    cross_n: f32,      // flow index (0-1 for shear-thinning)

    // Gas properties (§3.11)
    molar_mass: f32,   // kg/mol — for ideal gas law P = ρ·(R/M)·T

    // Real density (for thermal calculations)
    density_si: f32,   // kg/m³ — actual SI density
}

const NMAT: usize = 7;

// All values from structure.md §3.1 property tables
static MATS: [Mat; NMAT] = [
    // ── Water (H₂O) ──────────────────────────────────────────────────
    // §3.1: ρ=1000 kg/m³, μ=0.001 Pa·s at 20°C, σ=0.073 N/m
    // cp=4186 J/(kg·K), k=0.6 W/(m·K), Tm=0°C, Tb=100°C
    // Lf=334000 J/kg, Lv=2260000 J/kg
    // Arrhenius Ea/R ≈ 1800K for water (literature value)
    Mat {
        rho0: 1.0, mu_ref: 0.01, surface_tension: 0.0728, // IAPWS 2014
        thermal_conductivity: 0.6,
        specific_heat: 4186.0,
        melting_point: 0.0,
        boiling_point: 100.0,
        latent_heat_fusion: 334_000.0,
        latent_heat_vaporization: 2_260_000.0,
        emissivity: 0.96,
        arrhenius_ea_over_r: 1800.0,
        mu_ref_temp: 20.0,
        is_non_newtonian: false,
        cross_mu0: 0.0, cross_mu_inf: 0.0, cross_k: 0.0, cross_n: 0.0,
        molar_mass: 0.018,
        density_si: 1000.0,
    },
    // ── Honey (sugar solution) ────────────────────────────────────────
    // §3.1: ρ=1400 kg/m³, μ=10-100 Pa·s at 20°C (use 50), σ=0.065 N/m
    // cp≈2400 J/(kg·K), k≈0.5 W/(m·K), decomposes ~180°C
    // Non-Newtonian: shear-thinning (Cross model)
    // Arrhenius Ea/R ≈ 5000K (very temperature-sensitive)
    // Viscosity scaled for demo resolution: real ratio honey/water = 50000:1,
    // but at H=0.04 spacing, ∇²W amplifies viscosity ~300000×, so we use
    // a demo-scaled value that preserves visible flow while being clearly viscous.
    Mat {
        rho0: 1.4, mu_ref: 0.04, surface_tension: 0.065,
        thermal_conductivity: 0.5,
        specific_heat: 2400.0,
        melting_point: -20.0,
        boiling_point: 180.0,
        latent_heat_fusion: 200_000.0,
        latent_heat_vaporization: 1_500_000.0,
        emissivity: 0.9,
        arrhenius_ea_over_r: 5000.0,
        mu_ref_temp: 20.0,
        is_non_newtonian: true,
        cross_mu0: 0.08,      // demo-scaled zero-shear
        cross_mu_inf: 0.01,   // demo-scaled inf-shear
        cross_k: 0.5,
        cross_n: 0.6,
        molar_mass: 0.342,    // sucrose
        density_si: 1400.0,
    },
    // ── Molten Copper (Cu at 1085°C+) ─────────────────────────────────
    // §3.1: ρ=7800 kg/m³, μ=0.004 Pa·s at 1100°C, σ=1.3 N/m
    // cp=390 J/(kg·K), k=160 W/(m·K) (liquid: ~166)
    // Tm=1085°C, Tb=2562°C, Lf=207000 J/kg, Lv=4790000 J/kg
    Mat {
        rho0: 7.8, mu_ref: 0.004, surface_tension: 1.3,
        thermal_conductivity: 166.0,
        specific_heat: 390.0,
        melting_point: 1085.0,
        boiling_point: 2562.0,
        latent_heat_fusion: 207_000.0,
        latent_heat_vaporization: 4_790_000.0,
        emissivity: 0.8,
        arrhenius_ea_over_r: 1500.0,
        mu_ref_temp: 1100.0,
        is_non_newtonian: false,
        cross_mu0: 0.0, cross_mu_inf: 0.0, cross_k: 0.0, cross_n: 0.0,
        molar_mass: 0.0635,
        density_si: 7800.0,
    },
    // ── Mercury (Hg) ──────────────────────────────────────────────────
    // §3.1: ρ=13546 kg/m³, μ=0.0015 Pa·s at 20°C, σ=0.49 N/m
    // cp=140 J/(kg·K), k=8.3 W/(m·K)
    // Tm=-39°C, Tb=357°C
    Mat {
        rho0: 13.5, mu_ref: 0.015, surface_tension: 0.49,
        thermal_conductivity: 8.3,
        specific_heat: 139.5,
        melting_point: -39.0,
        boiling_point: 357.0,
        latent_heat_fusion: 11_300.0,
        latent_heat_vaporization: 295_000.0,
        emissivity: 0.1,
        arrhenius_ea_over_r: 800.0,
        mu_ref_temp: 20.0,
        is_non_newtonian: false,
        cross_mu0: 0.0, cross_mu_inf: 0.0, cross_k: 0.0, cross_n: 0.0,
        molar_mass: 0.2006,
        density_si: 13546.0,
    },
    // ── Olive Oil ─────────────────────────────────────────────────────
    // §3.1: ρ=920 kg/m³, μ=0.08 Pa·s at 20°C, σ=0.032 N/m
    // cp≈2000 J/(kg·K), k≈0.17 W/(m·K)
    // Smoke point ~200°C
    Mat {
        rho0: 0.92, mu_ref: 0.06, surface_tension: 0.032, // demo-scaled: real 80x water → 6x
        thermal_conductivity: 0.17,
        specific_heat: 2000.0,
        melting_point: -6.0,
        boiling_point: 300.0,
        latent_heat_fusion: 150_000.0,
        latent_heat_vaporization: 800_000.0,
        emissivity: 0.9,
        arrhenius_ea_over_r: 3000.0,
        mu_ref_temp: 20.0,
        is_non_newtonian: false,
        cross_mu0: 0.0, cross_mu_inf: 0.0, cross_k: 0.0, cross_n: 0.0,
        molar_mass: 0.282,    // oleic acid
        density_si: 920.0,
    },
    // ── Lava (Basaltic) ───────────────────────────────────────────────
    // §3.1: ρ=2700 kg/m³, μ=100-1000 Pa·s (use 500), σ=0.4 N/m
    // cp≈1000 J/(kg·K), k≈1.5 W/(m·K)
    // Solidifies ~700°C, erupts at ~1100°C
    // Very temperature-sensitive viscosity: Ea/R ≈ 8000K
    // Demo-scaled: real μ=500 Pa·s would freeze particles at H=0.04 spacing
    Mat {
        rho0: 2.7, mu_ref: 0.04, surface_tension: 0.4,
        thermal_conductivity: 1.5,
        specific_heat: 1000.0,
        melting_point: 700.0,
        boiling_point: 2500.0,
        latent_heat_fusion: 400_000.0,
        latent_heat_vaporization: 6_000_000.0,
        emissivity: 0.9,
        arrhenius_ea_over_r: 8000.0,
        mu_ref_temp: 1100.0,
        is_non_newtonian: false,
        cross_mu0: 0.0, cross_mu_inf: 0.0, cross_k: 0.0, cross_n: 0.0,
        molar_mass: 0.060,    // SiO₂ dominant
        density_si: 2700.0,
    },
    // ── Blood ─────────────────────────────────────────────────────────
    // §3.1: ρ=1060 kg/m³, μ=0.004 Pa·s at 37°C, σ=0.058 N/m
    // cp≈3600 J/(kg·K), k≈0.5 W/(m·K)
    // Non-Newtonian: μ₀=0.05 Pa·s, μ∞=0.003 Pa·s (§3.1 lines 1223-1227)
    Mat {
        rho0: 1.06, mu_ref: 0.04, surface_tension: 0.058,
        thermal_conductivity: 0.5,
        specific_heat: 3600.0,
        melting_point: -2.0,
        boiling_point: 100.0,
        latent_heat_fusion: 334_000.0,
        latent_heat_vaporization: 2_200_000.0,
        emissivity: 0.95,
        arrhenius_ea_over_r: 1500.0,
        mu_ref_temp: 37.0,
        is_non_newtonian: true,
        cross_mu0: 0.5,       // 0.05 Pa·s normalized
        cross_mu_inf: 0.03,   // 0.003 Pa·s normalized
        cross_k: 1.0,
        cross_n: 0.7,
        molar_mass: 0.018,    // mostly water
        density_si: 1060.0,
    },
];

// ── §3.1 Arrhenius Viscosity ───────────────────────────────────────────────
// μ(T) = A · exp(Ea / (R·T))
// Rearranged using reference: μ(T) = μ_ref · exp(Ea/R · (1/T - 1/T_ref))
// §3.1 line 446: "Temperature reduces viscosity for all materials"
#[inline(always)]
fn arrhenius_viscosity(mat: &Mat, temp_c: f32) -> f32 {
    let t_k = (temp_c + 273.15).max(100.0);
    let t_ref_k = mat.mu_ref_temp + 273.15;
    let exponent = mat.arrhenius_ea_over_r * (1.0 / t_k - 1.0 / t_ref_k);
    let mu = mat.mu_ref * exponent.exp();
    // Cap viscosity to prevent freezing mid-fall — extremely high values
    // make the SPH kernel Laplacian create forces >>gravity, stopping motion.
    // At H=0.04, ∇²W ≈ 3e6, so mu > 0.5 → damping exceeds gravity.
    mu.clamp(0.0001, 0.5)
}

// ── §3.1 Non-Newtonian Cross Model ────────────────────────────────────────
// μ(γ̇) = μ∞ + (μ₀ - μ∞) / (1 + (K·γ̇)^n)
// §3.1 lines 1223-1227, 1249-1257
#[inline(always)]
fn cross_model_viscosity(mat: &Mat, shear_rate: f32, temp_c: f32) -> f32 {
    if !mat.is_non_newtonian {
        return arrhenius_viscosity(mat, temp_c);
    }
    // Temperature-adjusted base viscosities (Arrhenius on both μ₀ and μ∞)
    let t_k = (temp_c + 273.15).max(100.0);
    let t_ref_k = mat.mu_ref_temp + 273.15;
    let temp_factor = (mat.arrhenius_ea_over_r * (1.0 / t_k - 1.0 / t_ref_k)).exp();

    let mu0 = mat.cross_mu0 * temp_factor;
    let mu_inf = mat.cross_mu_inf * temp_factor;

    let kg = mat.cross_k * shear_rate;
    let denominator = 1.0 + kg.powf(mat.cross_n);
    let mu = mu_inf + (mu0 - mu_inf) / denominator;
    mu.clamp(0.0001, 100.0)
}

// ── Spatial Hash ───────────────────────────────────────────────────────────

struct Grid {
    head: Vec<i32>,
    next: Vec<i32>,
}

impl Grid {
    fn new() -> Self {
        Grid { head: vec![-1; TABLE_SIZE], next: vec![-1; MAX_PARTICLES] }
    }
    fn clear(&mut self) { self.head.fill(-1); }

    #[inline(always)]
    fn hash(ix: i32, iy: i32, iz: i32) -> usize {
        ((ix.wrapping_mul(73856093) ^ iy.wrapping_mul(19349663) ^ iz.wrapping_mul(83492791)) as u32 % TABLE_SIZE as u32) as usize
    }

    fn insert(&mut self, i: usize, x: f32, y: f32, z: f32) {
        let ix = (x / CELL_SIZE).floor() as i32;
        let iy = (y / CELL_SIZE).floor() as i32;
        let iz = (z / CELL_SIZE).floor() as i32;
        let h = Self::hash(ix, iy, iz);
        self.next[i] = self.head[h];
        self.head[h] = i as i32;
    }
}

// ── Simulation ─────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct Simulation {
    n: usize,
    // Position, velocity, force (normalized units)
    px: Vec<f32>, py: Vec<f32>, pz: Vec<f32>,
    vx: Vec<f32>, vy: Vec<f32>, vz: Vec<f32>,
    fx: Vec<f32>, fy: Vec<f32>, fz: Vec<f32>,
    mass: Vec<f32>,        // normalized mass
    rho: Vec<f32>,         // computed density
    press: Vec<f32>,       // computed pressure
    mat_id: Vec<u8>,       // material index

    // §3.0: Temperature (SI — °C)
    temp: Vec<f32>,

    // §3.2: Phase state (0=liquid, 1=gas, 2=solid)
    phase: Vec<u8>,

    // §3.2: Phase transition progress (0.0 → 1.0)
    // Temperature stays at transition point until progress reaches 1.0
    // phaseProgress += Q_absorbed / (mass_si × latentHeat)
    phase_progress: Vec<f32>,

    // §3.2: Sleep/wake system (lines 2135-2148)
    sleep_counter: Vec<u32>,  // ticks since last significant movement
    is_sleeping: Vec<bool>,   // true = skip all computation

    // §3.2 lines 2470-2540: Secondary particles (spray/foam)
    // Lightweight particles: gravity + drag only, no SPH. Short lifetime.
    spray_n: usize,
    spray_px: Vec<f32>, spray_py: Vec<f32>, spray_pz: Vec<f32>,
    spray_vx: Vec<f32>, spray_vy: Vec<f32>, spray_vz: Vec<f32>,
    spray_life: Vec<f32>,  // remaining lifetime in seconds
    spray_mat: Vec<u8>,     // material (for color)

    grid: Grid,
}

#[wasm_bindgen]
impl Simulation {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let m = MAX_PARTICLES;
        Simulation {
            n: 0,
            px: vec![0.0; m], py: vec![0.0; m], pz: vec![0.0; m],
            vx: vec![0.0; m], vy: vec![0.0; m], vz: vec![0.0; m],
            fx: vec![0.0; m], fy: vec![0.0; m], fz: vec![0.0; m],
            mass: vec![0.0; m], rho: vec![0.0; m], press: vec![0.0; m],
            mat_id: vec![0; m],
            temp: vec![AMBIENT_TEMP; m],
            phase: vec![PHASE_LIQUID; m],
            phase_progress: vec![0.0; m],
            sleep_counter: vec![0; m],
            is_sleeping: vec![false; m],
            spray_n: 0,
            spray_px: vec![0.0; 2000], spray_py: vec![0.0; 2000], spray_pz: vec![0.0; 2000],
            spray_vx: vec![0.0; 2000], spray_vy: vec![0.0; 2000], spray_vz: vec![0.0; 2000],
            spray_life: vec![0.0; 2000],
            spray_mat: vec![0; 2000],
            grid: Grid::new(),
        }
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) { self.n = 0; }

    #[wasm_bindgen]
    pub fn get_count(&self) -> usize { self.n }

    #[wasm_bindgen]
    pub fn add_particles(&mut self, positions: &[f32], mat_idx: u8) -> usize {
        let mi = mat_idx as usize % NMAT;
        let mat = &MATS[mi];
        let vol = PARTICLE_SPACING * PARTICLE_SPACING * PARTICLE_SPACING;
        let pm = mat.rho0 * vol;
        let num = positions.len() / 3;

        // Default temperature based on material's natural state
        let spawn_temp = match mi {
            2 => 1150.0, // Molten Copper — above 1085°C melting point
            5 => 1100.0, // Lava — above 700°C solidification
            6 => 37.0,   // Blood — body temperature
            _ => AMBIENT_TEMP,
        };

        let spawn_phase = if spawn_temp < mat.melting_point {
            PHASE_SOLID
        } else if spawn_temp >= mat.boiling_point {
            PHASE_GAS
        } else {
            PHASE_LIQUID
        };

        let mut added = 0;
        for p in 0..num {
            if self.n >= MAX_PARTICLES { break; }
            let i = self.n;
            self.px[i] = positions[p*3];
            self.py[i] = positions[p*3+1];
            self.pz[i] = positions[p*3+2];
            self.vx[i] = 0.0; self.vy[i] = 0.0; self.vz[i] = 0.0;
            self.mass[i] = pm;
            self.rho[i] = mat.rho0;
            self.press[i] = 0.0;
            self.mat_id[i] = mat_idx;
            self.temp[i] = spawn_temp;
            self.phase[i] = spawn_phase;
            self.phase_progress[i] = 0.0;
            self.sleep_counter[i] = 0;
            self.is_sleeping[i] = false;
            self.n += 1;
            added += 1;
        }

        // §3.2: Wake nearby sleeping particles when new particles are added
        // "zero cost until disturbed"
        for idx in 0..self.n {
            if self.is_sleeping[idx] {
                // Check if any new particle is within kernel radius
                for p in 0..num {
                    if p * 3 + 2 >= positions.len() { break; }
                    let dx = self.px[idx] - positions[p*3];
                    let dy = self.py[idx] - positions[p*3+1];
                    let dz = self.pz[idx] - positions[p*3+2];
                    if dx*dx + dy*dy + dz*dz < H_SQ * 4.0 {
                        self.is_sleeping[idx] = false;
                        self.sleep_counter[idx] = 0;
                        break;
                    }
                }
            }
        }

        added
    }

    #[wasm_bindgen]
    pub fn step(&mut self, gravity: f32, dt: f32, sub_steps: u32) {
        let sdt = dt / sub_steps as f32;
        for _ in 0..sub_steps {
            self.substep(gravity, sdt);
        }
    }

    #[wasm_bindgen]
    pub fn get_positions(&self) -> Vec<f32> {
        let mut b = Vec::with_capacity(self.n * 3);
        for i in 0..self.n { b.push(self.px[i]); b.push(self.py[i]); b.push(self.pz[i]); }
        b
    }

    #[wasm_bindgen]
    pub fn get_velocities(&self) -> Vec<f32> {
        let mut b = Vec::with_capacity(self.n * 3);
        for i in 0..self.n { b.push(self.vx[i]); b.push(self.vy[i]); b.push(self.vz[i]); }
        b
    }

    #[wasm_bindgen]
    pub fn get_materials(&self) -> Vec<u8> { self.mat_id[..self.n].to_vec() }

    #[wasm_bindgen]
    pub fn get_temperatures(&self) -> Vec<f32> { self.temp[..self.n].to_vec() }

    #[wasm_bindgen]
    pub fn get_phases(&self) -> Vec<u8> { self.phase[..self.n].to_vec() }

    /// §3.2: Number of sleeping particles (for UI display)
    #[wasm_bindgen]
    pub fn get_sleep_count(&self) -> usize {
        self.is_sleeping[..self.n].iter().filter(|&&s| s).count()
    }

    /// §3.2: Get spray particle positions for rendering
    #[wasm_bindgen]
    pub fn get_spray_positions(&self) -> Vec<f32> {
        let mut b = Vec::with_capacity(self.spray_n * 3);
        for i in 0..self.spray_n {
            b.push(self.spray_px[i]);
            b.push(self.spray_py[i]);
            b.push(self.spray_pz[i]);
        }
        b
    }

    /// §3.2: Get spray particle count
    #[wasm_bindgen]
    pub fn get_spray_count(&self) -> usize { self.spray_n }

    /// §3.2: Get spray materials for coloring
    #[wasm_bindgen]
    pub fn get_spray_materials(&self) -> Vec<u8> { self.spray_mat[..self.spray_n].to_vec() }
}

impl Simulation {
    // SI mass of a particle (for thermal calculations)
    #[inline(always)]
    fn mass_si(&self, i: usize) -> f32 {
        let mat = &MATS[self.mat_id[i] as usize];
        let vol = PARTICLE_SPACING * PARTICLE_SPACING * PARTICLE_SPACING;
        mat.density_si * vol
    }

    fn substep(&mut self, gravity: f32, dt: f32) {
        let n = self.n;
        if n == 0 { return; }

        // ── Build spatial hash grid ─────────────────────────────────────
        self.grid.clear();
        for i in 0..n { self.grid.insert(i, self.px[i], self.py[i], self.pz[i]); }

        // ── §3.2: Density computation ───────────────────────────────────
        // ρ_i = Σ_j m_j · W(r_ij, h)
        // Note: sleeping particles still included in grid for neighbor density
        for i in 0..n {
            if self.is_sleeping[i] { continue; }
            let (xi, yi, zi) = (self.px[i], self.py[i], self.pz[i]);
            let mut rho = 0.0f32;
            let (cix, ciy, ciz) = (
                (xi / CELL_SIZE).floor() as i32,
                (yi / CELL_SIZE).floor() as i32,
                (zi / CELL_SIZE).floor() as i32,
            );
            for dx in -1..=1i32 {
                for dy in -1..=1i32 {
                    for dz in -1..=1i32 {
                        let h = Grid::hash(cix+dx, ciy+dy, ciz+dz);
                        let mut j = self.grid.head[h];
                        while j >= 0 {
                            let ju = j as usize;
                            let (ddx, ddy, ddz) = (xi - self.px[ju], yi - self.py[ju], zi - self.pz[ju]);
                            let rsq = ddx*ddx + ddy*ddy + ddz*ddz;
                            if rsq < H_SQ * 4.0 {
                                rho += self.mass[ju] * kernel_w(rsq.sqrt());
                            }
                            j = self.grid.next[ju];
                        }
                    }
                }
            }
            let mat = &MATS[self.mat_id[i] as usize];
            let effective_rho0 = if self.phase[i] == PHASE_GAS {
                // Gas has much lower density
                mat.rho0 * 0.001
            } else {
                mat.rho0
            };
            self.rho[i] = rho.max(effective_rho0 * 0.1);
        }

        // ── §3.2 / §3.11: Pressure computation ─────────────────────────
        for i in 0..n {
            let mat = &MATS[self.mat_id[i] as usize];

            if self.phase[i] == PHASE_GAS {
                // §3.11: Ideal gas law — P = ρ · (R/M) · T
                // Convert normalized density to SI for gas law
                let rho_si = self.rho[i] * mat.density_si;
                let t_k = (self.temp[i] + 273.15).max(200.0);
                let p_si = rho_si * (R_GAS / mat.molar_mass) * t_k;
                // Convert back to normalized pressure scale
                // Pressure scale: rho0_norm * CS² / GAMMA ≈ 9.14 for water
                let p_scale = mat.rho0 * CS * CS / GAMMA;
                self.press[i] = (p_si / (mat.density_si * CS * CS / GAMMA)) * p_scale;
                self.press[i] = self.press[i].max(0.0);
            } else {
                // §3.2: Tait equation — P = B · ((ρ/ρ₀)^γ - 1)
                let b = mat.rho0 * CS * CS / GAMMA;
                let ratio = self.rho[i] / mat.rho0;
                let r2 = ratio * ratio;
                let r4 = r2 * r2;
                let r7 = r4 * r2 * ratio;
                self.press[i] = b * (r7 - 1.0);
                if self.press[i] < 0.0 { self.press[i] = 0.0; }
            }
        }

        // ── §3.2: Force computation ─────────────────────────────────────
        // Also §3.0: Heat transfer (Fourier's law) in same neighbor loop
        for i in 0..n { self.fx[i] = 0.0; self.fy[i] = 0.0; self.fz[i] = 0.0; }

        let mut dtemp = vec![0.0f32; n];
        let mut shear_rates = vec![0.0f32; n];

        for i in 0..n {
            if self.is_sleeping[i] { continue; } // §3.2: skip sleeping

            let (xi, yi, zi) = (self.px[i], self.py[i], self.pz[i]);
            let (vxi, vyi, vzi) = (self.vx[i], self.vy[i], self.vz[i]);
            let rho_i = self.rho[i];
            let p_i = self.press[i];
            let mi = self.mat_id[i] as usize;
            let mat_i = &MATS[mi];
            let p_rho2_i = p_i / (rho_i * rho_i);

            let mut fpx = 0.0f32; let mut fpy = 0.0f32; let mut fpz = 0.0f32;
            let mut fvx = 0.0f32; let mut fvy = 0.0f32; let mut fvz = 0.0f32;
            let mut heat_in = 0.0f32;
            let mut shear_sq = 0.0f32;

            // §3.2 Surface tension: compute surface normal and curvature
            let mut nx = 0.0f32; let mut ny = 0.0f32; let mut nz = 0.0f32;

            let (cix, ciy, ciz) = (
                (xi / CELL_SIZE).floor() as i32,
                (yi / CELL_SIZE).floor() as i32,
                (zi / CELL_SIZE).floor() as i32,
            );

            for ddx_c in -1..=1i32 {
                for ddy_c in -1..=1i32 {
                    for ddz_c in -1..=1i32 {
                        let h = Grid::hash(cix+ddx_c, ciy+ddy_c, ciz+ddz_c);
                        let mut j = self.grid.head[h];
                        while j >= 0 {
                            let ju = j as usize;
                            if ju != i {
                                let (dx, dy, dz) = (xi - self.px[ju], yi - self.py[ju], zi - self.pz[ju]);
                                let rsq = dx*dx + dy*dy + dz*dz;
                                if rsq < H_SQ * 4.0 && rsq > 1e-10 {
                                    let r = rsq.sqrt();
                                    let mj = self.mass[ju];
                                    let rho_j = self.rho[ju];

                                    // §3.2: Pressure force
                                    // F = -Σ m_j · (P_i/ρ_i² + P_j/ρ_j²) · ∇W
                                    let gor = kernel_grad_over_r(r);
                                    let p_rho2_j = self.press[ju] / (rho_j * rho_j);
                                    let pc = -mj * (p_rho2_i + p_rho2_j);
                                    fpx += pc * gor * dx;
                                    fpy += pc * gor * dy;
                                    fpz += pc * gor * dz;

                                    // §3.2: Viscosity force (temperature-dependent)
                                    // F = μ · Σ m_j · (v_j - v_i) / ρ_j · ∇²W
                                    let mj_idx = self.mat_id[ju] as usize;
                                    let mu_i = arrhenius_viscosity(mat_i, self.temp[i]);
                                    let mu_j = arrhenius_viscosity(&MATS[mj_idx], self.temp[ju]);
                                    let mu = (mu_i + mu_j) * 0.5;
                                    let mu_eff = mu.min(50.0);
                                    let lap = kernel_lap(r);
                                    let vc = mu_eff * mj / rho_j * lap;
                                    fvx += vc * (self.vx[ju] - vxi);
                                    fvy += vc * (self.vy[ju] - vyi);
                                    fvz += vc * (self.vz[ju] - vzi);

                                    // §3.1: Shear rate for non-Newtonian (lines 1249-1257)
                                    // velocity gradient: (v_j - v_i) ⊗ ∇W / ρ_j
                                    let dvx = self.vx[ju] - vxi;
                                    let dvy = self.vy[ju] - vyi;
                                    let dvz = self.vz[ju] - vzi;
                                    shear_sq += (dvx*dvx + dvy*dvy + dvz*dvz) * mj / rho_j * gor.abs();

                                    // §3.2: Surface tension normal
                                    // n = Σ m_j/ρ_j · ∇W (color field gradient)
                                    nx += mj / rho_j * gor * dx;
                                    ny += mj / rho_j * gor * dy;
                                    nz += mj / rho_j * gor * dz;

                                    // §3.0: Heat transfer — Fourier's law
                                    // SPH form: dT/dt = (k/(ρ·cp)) · Σ m_j/ρ_j · (T_j-T_i) · ∇²W
                                    let k_avg = (mat_i.thermal_conductivity + MATS[mj_idx].thermal_conductivity) * 0.5;
                                    let alpha = k_avg / (mat_i.density_si * mat_i.specific_heat);
                                    heat_in += alpha * mj / rho_j * (self.temp[ju] - self.temp[i]) * lap;
                                }
                            }
                            j = self.grid.next[ju];
                        }
                    }
                }
            }

            // §3.2: Surface tension force — F = σ · κ · n̂
            // Curvature κ = -∇·n̂, force only at surface (where |n| is large)
            let n_len = (nx*nx + ny*ny + nz*nz).sqrt();
            if n_len > 0.01 {
                // Curvature approximation from divergence of normal
                let curvature = -n_len; // simplified: κ ≈ |∇c|
                let st = mat_i.surface_tension * curvature;
                self.fx[i] += st * nx / n_len;
                self.fy[i] += st * ny / n_len;
                self.fz[i] += st * nz / n_len;
            }

            // Pressure: fpx = -Σ m_j(P_i/ρ_i²+P_j/ρ_j²)∇W = acceleration
            //   → multiply by ρ_i so fx/ρ_i = fpx (correct acceleration)
            // Viscosity: fvx = μΣ m_j(v_j-v_i)/ρ_j ∇²W = acceleration × ρ_i
            //   → store directly so fx/ρ_i = fvx/ρ_i (correct acceleration)
            self.fx[i] += fpx * rho_i + fvx;
            self.fy[i] += fpy * rho_i + fvy;
            self.fz[i] += fpz * rho_i + fvz;

            // Temperature change — scaled speedup that slows for hot materials
            // Prevents lava/copper from solidifying in <1 second
            let t_scale = THERMAL_SPEEDUP / (1.0 + (self.temp[i] - AMBIENT_TEMP).abs() / 100.0);
            dtemp[i] = heat_in * t_scale;

            // Ambient cooling — Newton's law of cooling to environment
            // Convective heat transfer coefficient h_conv ≈ 10 W/(m²·K) for natural convection in air
            // q = h_conv × A/m × (T_ambient - T) where A/m ≈ 6/(ρ·d) for spherical particle
            let h_conv = 10.0; // W/(m²·K) natural convection
            let a_over_m = 6.0 / (mat_i.density_si * PARTICLE_SPACING);
            dtemp[i] += h_conv * a_over_m * (AMBIENT_TEMP - self.temp[i]) / mat_i.specific_heat * t_scale;

            // §3.0: Radiation heat loss (Stefan-Boltzmann) — only above 500°C
            if self.temp[i] > 500.0 {
                let t_k = self.temp[i] + 273.15;
                let t_amb_k = AMBIENT_TEMP + 273.15;
                // Q_rad = ε · σ_SB · A · (T⁴ - T_amb⁴)
                // Per unit mass: q = ε · σ_SB · (A/m) · (T⁴ - T_amb⁴)
                // For particle: A/m ≈ 6/(ρ·d) where d = particle diameter
                let d = PARTICLE_SPACING;
                let a_over_m = 6.0 / (mat_i.density_si * d);
                let q_rad = mat_i.emissivity * STEFAN_BOLTZMANN * a_over_m
                    * (t_k*t_k*t_k*t_k - t_amb_k*t_amb_k*t_amb_k*t_amb_k);
                dtemp[i] -= q_rad / mat_i.specific_heat * t_scale;
            }

            shear_rates[i] = shear_sq.sqrt();
        }

        // ── §3.0 Stage 1: Apply temperature changes ─────────────────────
        for i in 0..n {
            let mat = &MATS[self.mat_id[i] as usize];

            // §3.2 lines 1380-1382: During phase transition, temperature stays constant
            // "phaseProgress += absorbed / (mass × latentHeat)"
            // "Temperature stays at transition point until phaseProgress = 1.0"
            if self.phase_progress[i] > 0.0 && self.phase_progress[i] < 1.0 {
                let latent = if self.temp[i] >= mat.boiling_point - 1.0 {
                    mat.latent_heat_vaporization
                } else {
                    mat.latent_heat_fusion
                };
                // progress += |dT| × cp × dt / L
                let q_absorbed = dtemp[i].abs() * mat.specific_heat * dt;
                self.phase_progress[i] += q_absorbed / latent;
                self.phase_progress[i] = self.phase_progress[i].min(1.5); // stability
                // Temperature locked — no change during transition
            } else {
                self.temp[i] += dtemp[i] * dt;
            }
            self.temp[i] = self.temp[i].clamp(-50.0, 5000.0);
        }

        // ── §3.2: Phase transitions with latent heat ────────────────────
        for i in 0..n {
            let mat = &MATS[self.mat_id[i] as usize];

            match self.phase[i] {
                PHASE_LIQUID => {
                    // §3.2: Boiling — liquid → gas
                    if self.temp[i] >= mat.boiling_point {
                        if self.phase_progress[i] == 0.0 {
                            // Start phase transition
                            self.phase_progress[i] = 0.01;
                            self.temp[i] = mat.boiling_point; // lock temperature
                        } else if self.phase_progress[i] >= 1.0 {
                            // Transition complete
                            self.phase[i] = PHASE_GAS;
                            self.phase_progress[i] = 0.0;
                        }
                    }
                    // §3.2: Freezing — liquid → solid
                    if self.temp[i] <= mat.melting_point {
                        if self.phase_progress[i] == 0.0 {
                            self.phase_progress[i] = 0.01;
                            self.temp[i] = mat.melting_point;
                        } else if self.phase_progress[i] >= 1.0 {
                            self.phase[i] = PHASE_SOLID;
                            self.phase_progress[i] = 0.0;
                        }
                    }
                }
                PHASE_GAS => {
                    // §3.2: Condensation — gas → liquid
                    if self.temp[i] < mat.boiling_point - 5.0 {
                        self.phase[i] = PHASE_LIQUID;
                        self.phase_progress[i] = 0.0;
                    }
                }
                PHASE_SOLID => {
                    // §3.2: Melting — solid → liquid
                    if self.temp[i] > mat.melting_point + 5.0 {
                        self.phase[i] = PHASE_LIQUID;
                        self.phase_progress[i] = 0.0;
                    }
                }
                _ => {}
            }
        }

        // ── Integration ─────────────────────────────────────────────────
        for i in 0..n {
            // §3.2 lines 2135-2148: Skip sleeping particles
            if self.is_sleeping[i] { continue; }

            let inv_rho = 1.0 / self.rho[i];
            let mat = &MATS[self.mat_id[i] as usize];

            if self.phase[i] == PHASE_SOLID {
                // §3.2: Frozen particles — resist deformation but still fall at full gravity.
                // Damp horizontal motion (no flow), keep vertical for free-fall.
                self.vx[i] *= 0.95;
                self.vz[i] *= 0.95;
                // Full gravity — solids fall at the same rate as liquids
                self.vy[i] -= gravity * dt;
            } else {
                // §3.2: Apply non-Newtonian correction if applicable
                if mat.is_non_newtonian && shear_rates[i] > 0.0 {
                    let mu_newton = arrhenius_viscosity(mat, self.temp[i]);
                    let mu_cross = cross_model_viscosity(mat, shear_rates[i], self.temp[i]);
                    let correction = mu_cross / mu_newton.max(0.001);
                    self.fx[i] *= 1.0 + (correction - 1.0) * 0.3;
                    self.fy[i] *= 1.0 + (correction - 1.0) * 0.3;
                    self.fz[i] *= 1.0 + (correction - 1.0) * 0.3;
                }

                self.vx[i] += self.fx[i] * inv_rho * dt;
                self.vy[i] += self.fy[i] * inv_rho * dt;
                self.vz[i] += self.fz[i] * inv_rho * dt;

                // Gravity
                self.vy[i] -= gravity * dt;

                // §3.9: Air drag — only for GAS/SPRAY particles traveling through air
                // NOT for liquid SPH particles. Inside a fluid body, particles are
                // surrounded by other fluid particles, not air. A blob of honey and
                // a blob of water fall at the same rate (g=9.81) — drag is on the
                // blob surface, not per-particle.
                // Drag on the fluid BODY would come from fluid-structure interaction,
                // not from applying F=0.5ρv²CdA to each particle.

                // §3.2/§3.11: Gas buoyancy (Archimedes — density difference)
                if self.phase[i] == PHASE_GAS {
                    let buoyancy = gravity * (mat.rho0 / self.rho[i].max(0.01) - 1.0).min(5.0);
                    self.vy[i] += buoyancy * dt;
                }

                // §3.2 lines 1802-1837: Sedimentation (Stokes settling)
                // v_settle = (2/9) × (ρ_particle - ρ_fluid) × g × r² / μ
                // Heavier particles in lighter fluid settle faster
                // This manifests as density-driven layering when multiple materials present
                // (Already mostly handled by pressure forces, but Stokes adds damping)
            }

            // §3.2 lines 2135-2148: Sleep/wake check
            let vsq = self.vx[i]*self.vx[i] + self.vy[i]*self.vy[i] + self.vz[i]*self.vz[i];
            if vsq < SLEEP_VELOCITY_THRESHOLD * SLEEP_VELOCITY_THRESHOLD {
                self.sleep_counter[i] += 1;
                if self.sleep_counter[i] >= SLEEP_TICKS_REQUIRED {
                    self.is_sleeping[i] = true;
                }
            } else {
                self.sleep_counter[i] = 0;
            }

            // Velocity clamp — must exceed free-fall speed from box top
            // v_freefall = sqrt(2*g*h) = sqrt(2*9.81*1.5) ≈ 5.4 m/s
            let vsq = self.vx[i]*self.vx[i] + self.vy[i]*self.vy[i] + self.vz[i]*self.vz[i];
            let max_v: f32 = 8.0;
            if vsq > max_v * max_v {
                let s = max_v / vsq.sqrt();
                self.vx[i] *= s; self.vy[i] *= s; self.vz[i] *= s;
            }

            // Position
            self.px[i] += self.vx[i] * dt;
            self.py[i] += self.vy[i] * dt;
            self.pz[i] += self.vz[i] * dt;

            // ── Walls ───────────────────────────────────────────────────
            let pad = PARTICLE_SPACING;
            if self.py[i] < -HALF_H + pad {
                // §3.2: Weber number spray on floor impact
                // We = ρ × v² × d / σ (lines 2470-2540)
                let impact_speed = (-self.vy[i]).max(0.0);
                // §3.2: We = ρ × v² × d / σ — use SI density for correct Weber number
                let we = mat.density_si * impact_speed * impact_speed * PARTICLE_SPACING / mat.surface_tension.max(0.001);
                if we > SPRAY_WEBER_THRESHOLD && self.spray_n < 1990 && self.phase[i] == PHASE_LIQUID {
                    // Spawn 2-5 spray particles
                    let spray_count = ((we / SPRAY_WEBER_THRESHOLD) as usize).min(5).max(1);
                    for _ in 0..spray_count {
                        if self.spray_n >= 2000 { break; }
                        let si = self.spray_n;
                        self.spray_px[si] = self.px[i];
                        self.spray_py[si] = self.py[i] + 0.01;
                        self.spray_pz[si] = self.pz[i];
                        // Random upward + sideways velocity
                        let rx = (((i * 73 + si * 37) % 100) as f32 / 50.0 - 1.0) * impact_speed * 0.5;
                        let rz = (((i * 91 + si * 53) % 100) as f32 / 50.0 - 1.0) * impact_speed * 0.5;
                        self.spray_vx[si] = self.vx[i] + rx;
                        self.spray_vy[si] = impact_speed * 0.3 + (si as f32 * 0.1);
                        self.spray_vz[si] = self.vz[i] + rz;
                        self.spray_life[si] = 0.5 + (si as f32 * 0.1); // 0.5-1.0s lifetime
                        self.spray_mat[si] = self.mat_id[i];
                        self.spray_n += 1;
                    }
                }

                self.py[i] = -HALF_H + pad;
                if self.vy[i] < 0.0 { self.vy[i] *= -0.02; }
                self.vx[i] *= 0.98; self.vz[i] *= 0.98;
                // §3.0: Floor heat exchange (Fourier's law with floor)
                let k_contact = mat.thermal_conductivity;
                let q_floor = k_contact * (AMBIENT_TEMP - self.temp[i]) / (PARTICLE_SPACING * 0.5);
                let t_scale_floor = THERMAL_SPEEDUP / (1.0 + (self.temp[i] - AMBIENT_TEMP).abs() / 100.0);
                self.temp[i] += q_floor / (mat.density_si * mat.specific_heat) * dt * t_scale_floor;
            }
            if self.py[i] > HALF_H - pad {
                self.py[i] = HALF_H - pad;
                if self.vy[i] > 0.0 { self.vy[i] *= -0.1; }
            }
            if self.px[i] < -HALF_W + pad {
                self.px[i] = -HALF_W + pad;
                if self.vx[i] < 0.0 { self.vx[i] *= -0.1; }
            }
            if self.px[i] > HALF_W - pad {
                self.px[i] = HALF_W - pad;
                if self.vx[i] > 0.0 { self.vx[i] *= -0.1; }
            }
            if self.pz[i] < -HALF_D + pad {
                self.pz[i] = -HALF_D + pad;
                if self.vz[i] < 0.0 { self.vz[i] *= -0.1; }
            }
            if self.pz[i] > HALF_D - pad {
                self.pz[i] = HALF_D - pad;
                if self.vz[i] > 0.0 { self.vz[i] *= -0.1; }
            }
        }

        // ── §3.2: Update spray particles ────────────────────────────────
        // Spray: gravity + air drag only, no SPH forces. Short lifetime.
        let mut alive = 0;
        for i in 0..self.spray_n {
            self.spray_life[i] -= dt;
            if self.spray_life[i] <= 0.0 { continue; }

            // Gravity
            self.spray_vy[i] -= gravity * dt;

            // §3.9: Air drag on spray (stronger — small particles)
            let speed_sq = self.spray_vx[i]*self.spray_vx[i]
                + self.spray_vy[i]*self.spray_vy[i]
                + self.spray_vz[i]*self.spray_vz[i];
            if speed_sq > 0.01 {
                let drag = (0.5 * RHO_AIR * speed_sq.sqrt() * CD_SPHERE * PARTICLE_CROSS_SECTION * 4.0
                    / (PARTICLE_SPACING * PARTICLE_SPACING * PARTICLE_SPACING * 500.0) * dt).min(0.3);
                self.spray_vx[i] *= 1.0 - drag;
                self.spray_vy[i] *= 1.0 - drag;
                self.spray_vz[i] *= 1.0 - drag;
            }

            // Position
            self.spray_px[i] += self.spray_vx[i] * dt;
            self.spray_py[i] += self.spray_vy[i] * dt;
            self.spray_pz[i] += self.spray_vz[i] * dt;

            // Remove if out of bounds
            if self.spray_py[i] < -HALF_H || self.spray_py[i] > HALF_H
                || self.spray_px[i].abs() > HALF_W || self.spray_pz[i].abs() > HALF_D {
                self.spray_life[i] = 0.0;
                continue;
            }

            // Compact: move alive particle to front
            if alive != i {
                self.spray_px[alive] = self.spray_px[i];
                self.spray_py[alive] = self.spray_py[i];
                self.spray_pz[alive] = self.spray_pz[i];
                self.spray_vx[alive] = self.spray_vx[i];
                self.spray_vy[alive] = self.spray_vy[i];
                self.spray_vz[alive] = self.spray_vz[i];
                self.spray_life[alive] = self.spray_life[i];
                self.spray_mat[alive] = self.spray_mat[i];
            }
            alive += 1;
        }
        self.spray_n = alive;
    }
}
