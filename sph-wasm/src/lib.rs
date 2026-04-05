// ══════════════════════════════════════════════════════════════════════════════
// SPH Fluid Simulation — Rust/WASM
// Implements structure.md: §3.0 (temperature), §3.1 (materials), §3.2 (SPH),
//   §3.11 (heat engines/gas law)
// Temperature propagation, Arrhenius viscosity, phase transitions, buoyancy
// ══════════════════════════════════════════════════════════════════════════════

use wasm_bindgen::prelude::*;
use std::f32::consts::PI;

// ── Simulation Parameters ──────────────────────────────────────────────────
const MAX_PARTICLES: usize = 10_000;

// Particle spacing and kernel
const H: f32 = 0.04;
const H_SQ: f32 = H * H;
const PARTICLE_SPACING: f32 = H * 0.5;

// Tait equation
const GAMMA: f32 = 7.0;
const CS: f32 = 8.0;

// Box
const HALF_W: f32 = 1.0;
const HALF_H: f32 = 0.75;
const HALF_D: f32 = 0.75;

// Spatial hash
const TABLE_SIZE: usize = 16381;
const CELL_SIZE: f32 = H * 2.0;

// Temperature constants
const AMBIENT_TEMP: f32 = 20.0;   // °C — environment temperature (§3.0)
const FLOOR_TEMP: f32 = 20.0;     // °C — floor acts as heat sink

// Phase states
const PHASE_LIQUID: u8 = 0;
const PHASE_GAS: u8 = 1;
const PHASE_SOLID: u8 = 2;

// ── Kernel (cubic spline M4, 3D) ────────────────────────────────────────────

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

// ── Materials (§3.1 — full property calculator) ────────────────────────────
// Each material has thermal properties from structure.md §3.1

#[derive(Clone, Copy)]
struct Mat {
    rho0: f32,           // rest density (normalized: water=1.0)
    mu_base: f32,        // base viscosity at reference temperature
    surface_tension: f32, // surface tension coefficient

    // §3.1 thermal properties
    thermal_k: f32,      // thermal conductivity (normalized)
    specific_heat: f32,  // specific heat capacity (normalized)
    boiling_point: f32,  // °C
    melting_point: f32,  // °C
    latent_heat_vap: f32, // latent heat of vaporization (normalized)

    // §3.1 Arrhenius viscosity: μ = mu_base * exp(Ea/R * (1/T - 1/T_ref))
    // Simplified: activation_ratio = Ea/R pre-computed
    activation_ratio: f32, // Ea/R in Kelvin (higher = more temperature-sensitive)
    t_ref: f32,            // reference temperature for mu_base (°C)
}

const NMAT: usize = 7;
static MATS: [Mat; NMAT] = [
    // Water: low viscosity, boils at 100°C
    Mat {
        rho0: 1.0, mu_base: 0.01, surface_tension: 0.1,
        thermal_k: 1.0, specific_heat: 4.2,
        boiling_point: 100.0, melting_point: 0.0,
        latent_heat_vap: 22.6,  // 2260 kJ/kg normalized
        activation_ratio: 1800.0, t_ref: 20.0,
    },
    // Honey: very viscous, doesn't really boil (decomposes ~180°C)
    Mat {
        rho0: 1.4, mu_base: 5.0, surface_tension: 0.08,
        thermal_k: 0.5, specific_heat: 2.4,
        boiling_point: 180.0, melting_point: -20.0,
        latent_heat_vap: 10.0,
        activation_ratio: 5000.0, t_ref: 20.0, // very temperature-sensitive
    },
    // Molten Copper: already above melting point (1085°C)
    Mat {
        rho0: 7.8, mu_base: 0.02, surface_tension: 0.5,
        thermal_k: 6.0, specific_heat: 0.39,
        boiling_point: 2562.0, melting_point: 1085.0,
        latent_heat_vap: 47.9,
        activation_ratio: 1500.0, t_ref: 1150.0,
    },
    // Mercury: liquid at room temp, boils at 357°C
    Mat {
        rho0: 13.5, mu_base: 0.01, surface_tension: 0.4,
        thermal_k: 1.4, specific_heat: 0.14,
        boiling_point: 357.0, melting_point: -39.0,
        latent_heat_vap: 2.9,
        activation_ratio: 800.0, t_ref: 20.0,
    },
    // Olive Oil: smokes ~200°C
    Mat {
        rho0: 0.92, mu_base: 0.1, surface_tension: 0.05,
        thermal_k: 0.17, specific_heat: 2.0,
        boiling_point: 300.0, melting_point: -6.0,
        latent_heat_vap: 8.0,
        activation_ratio: 3000.0, t_ref: 20.0,
    },
    // Lava: extremely viscous, solidifies ~700°C
    Mat {
        rho0: 2.7, mu_base: 3.0, surface_tension: 0.3,
        thermal_k: 1.5, specific_heat: 1.0,
        boiling_point: 2500.0, melting_point: 700.0,
        latent_heat_vap: 40.0,
        activation_ratio: 8000.0, t_ref: 1100.0, // very temp-sensitive
    },
    // Blood: similar to water, denatures ~42°C
    Mat {
        rho0: 1.06, mu_base: 0.02, surface_tension: 0.08,
        thermal_k: 0.5, specific_heat: 3.6,
        boiling_point: 100.0, melting_point: -2.0,
        latent_heat_vap: 22.0,
        activation_ratio: 1500.0, t_ref: 37.0,
    },
];

// ── Arrhenius viscosity (§3.1) ─────────────────────────────────────────────
// μ(T) = μ_base × exp(Ea/R × (1/T - 1/T_ref))
// Higher temperature → lower viscosity (lava flows fast near vent, slows as it cools)
#[inline(always)]
fn viscosity_at_temp(mat: &Mat, temp_c: f32) -> f32 {
    let t_k = (temp_c + 273.15).max(100.0);  // avoid div by zero
    let t_ref_k = mat.t_ref + 273.15;
    let exponent = mat.activation_ratio * (1.0 / t_k - 1.0 / t_ref_k);
    let mu = mat.mu_base * exponent.exp();
    mu.clamp(0.001, 50.0)  // stability clamp
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
    px: Vec<f32>, py: Vec<f32>, pz: Vec<f32>,
    vx: Vec<f32>, vy: Vec<f32>, vz: Vec<f32>,
    fx: Vec<f32>, fy: Vec<f32>, fz: Vec<f32>,
    mass: Vec<f32>,
    rho: Vec<f32>,
    press: Vec<f32>,
    mat_id: Vec<u8>,
    temp: Vec<f32>,      // §3.0: temperature per particle (°C)
    phase: Vec<u8>,      // §3.2: phase state (0=liquid, 1=gas, 2=solid)
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
            grid: Grid::new(),
        }
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) { self.n = 0; }

    #[wasm_bindgen]
    pub fn get_count(&self) -> usize { self.n }

    /// Add particles with a specific starting temperature
    #[wasm_bindgen]
    pub fn add_particles(&mut self, positions: &[f32], mat_idx: u8) -> usize {
        self.add_particles_with_temp(positions, mat_idx, -999.0)
    }

    /// Add particles with explicit temperature (-999 = use material default)
    #[wasm_bindgen]
    pub fn add_particles_with_temp(&mut self, positions: &[f32], mat_idx: u8, temp: f32) -> usize {
        let mi = mat_idx as usize % NMAT;
        let mat = &MATS[mi];
        let vol = PARTICLE_SPACING * PARTICLE_SPACING * PARTICLE_SPACING;
        let pm = mat.rho0 * vol;
        let num = positions.len() / 3;

        // Default temperature: room temp for most, above melting for metals/lava
        let spawn_temp = if temp > -998.0 {
            temp
        } else {
            match mi {
                2 => 1150.0, // Molten copper — above melting point
                5 => 1100.0, // Lava — above melting point
                6 => 37.0,   // Blood — body temperature
                _ => AMBIENT_TEMP,
            }
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
            self.phase[i] = if spawn_temp < mat.melting_point {
                PHASE_SOLID
            } else if spawn_temp >= mat.boiling_point {
                PHASE_GAS
            } else {
                PHASE_LIQUID
            };
            self.n += 1;
            added += 1;
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

    /// §3.0: get temperature per particle for visualization
    #[wasm_bindgen]
    pub fn get_temperatures(&self) -> Vec<f32> { self.temp[..self.n].to_vec() }

    /// Get phase state per particle (0=liquid, 1=gas, 2=solid)
    #[wasm_bindgen]
    pub fn get_phases(&self) -> Vec<u8> { self.phase[..self.n].to_vec() }

    /// Set floor temperature (simulates heated/cooled surface)
    #[wasm_bindgen]
    pub fn set_heat_source(&mut self, _floor_temp: f32) {
        // Floor temperature is used in wall boundary heat transfer
        // For now we use the constant; this API is for future UI controls
    }
}

impl Simulation {
    fn substep(&mut self, gravity: f32, dt: f32) {
        let n = self.n;
        if n == 0 { return; }

        // Build grid
        self.grid.clear();
        for i in 0..n { self.grid.insert(i, self.px[i], self.py[i], self.pz[i]); }

        // ── §3.0 Stage 1: Density computation ───────────────────────────
        for i in 0..n {
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
            // Gas phase has much lower effective rest density (§3.11)
            let effective_rho0 = if self.phase[i] == PHASE_GAS {
                mat.rho0 * 0.05 // gas is ~20x less dense
            } else {
                mat.rho0
            };
            self.rho[i] = rho.max(effective_rho0 * 0.1);
        }

        // ── Pressure ────────────────────────────────────────────────────
        // §3.2: Tait for liquids, §3.11: ideal gas law for gas phase
        for i in 0..n {
            let mat = &MATS[self.mat_id[i] as usize];
            if self.phase[i] == PHASE_GAS {
                // §3.11: P_gas = rho * (R/M) * T  (simplified)
                // In normalized units: P = rho * temp_factor
                let t_k = (self.temp[i] + 273.15).max(200.0);
                let gas_rho0 = mat.rho0 * 0.05;
                self.press[i] = (self.rho[i] - gas_rho0) * t_k * 0.01;
                if self.press[i] < 0.0 { self.press[i] = 0.0; }
            } else {
                // §3.2: Tait equation for liquids
                let b = mat.rho0 * CS * CS / GAMMA;
                let ratio = self.rho[i] / mat.rho0;
                let r2 = ratio * ratio;
                let r4 = r2 * r2;
                let r7 = r4 * r2 * ratio;
                self.press[i] = b * (r7 - 1.0);
                if self.press[i] < 0.0 { self.press[i] = 0.0; }
            }
        }

        // ── Forces (pressure + viscosity + heat transfer) ───────────────
        for i in 0..n { self.fx[i] = 0.0; self.fy[i] = 0.0; self.fz[i] = 0.0; }

        // Temporary buffer for heat exchange
        let mut dtemp = vec![0.0f32; n];

        for i in 0..n {
            let (xi, yi, zi) = (self.px[i], self.py[i], self.pz[i]);
            let (vxi, vyi, vzi) = (self.vx[i], self.vy[i], self.vz[i]);
            let rho_i = self.rho[i];
            let p_i = self.press[i];
            let mi = self.mat_id[i] as usize;
            let mat_i = &MATS[mi];

            // §3.1 Arrhenius: viscosity depends on temperature
            let mu_i = viscosity_at_temp(mat_i, self.temp[i]);
            let p_rho2_i = p_i / (rho_i * rho_i);

            let mut fpx = 0.0f32; let mut fpy = 0.0f32; let mut fpz = 0.0f32;
            let mut fvx = 0.0f32; let mut fvy = 0.0f32; let mut fvz = 0.0f32;
            let mut heat_in = 0.0f32;

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
                                    let gor = kernel_grad_over_r(r);
                                    let p_rho2_j = self.press[ju] / (rho_j * rho_j);
                                    let pc = -mj * (p_rho2_i + p_rho2_j);
                                    fpx += pc * gor * dx;
                                    fpy += pc * gor * dy;
                                    fpz += pc * gor * dz;

                                    // §3.2: Viscosity force (with Arrhenius temperature)
                                    let mj_idx = self.mat_id[ju] as usize;
                                    let mu_j = viscosity_at_temp(&MATS[mj_idx], self.temp[ju]);
                                    let mu = (mu_i + mu_j) * 0.5;
                                    let mu_eff = mu.min(10.0);
                                    let lap = kernel_lap(r);
                                    let vc = mu_eff * mj / rho_j * lap;
                                    fvx += vc * (self.vx[ju] - vxi);
                                    fvy += vc * (self.vy[ju] - vyi);
                                    fvz += vc * (self.vz[ju] - vzi);

                                    // §3.0: Heat transfer (Fourier's law)
                                    // Q = k_avg * (T_j - T_i) * W(r) / (rho_j)
                                    let k_avg = (mat_i.thermal_k + MATS[mj_idx].thermal_k) * 0.5;
                                    let w = kernel_w(r);
                                    heat_in += k_avg * mj / rho_j * (self.temp[ju] - self.temp[i]) * w;
                                }
                            }
                            j = self.grid.next[ju];
                        }
                    }
                }
            }

            self.fx[i] += fpx * rho_i + fvx;
            self.fy[i] += fpy * rho_i + fvy;
            self.fz[i] += fpz * rho_i + fvz;

            // §3.0: Temperature change from heat transfer
            // dT = Q / (rho * cp) * dt
            dtemp[i] = heat_in / (rho_i * mat_i.specific_heat);

            // Ambient cooling — particles lose heat to environment (convection)
            let ambient_rate = 0.5; // heat loss rate to air
            dtemp[i] += ambient_rate * (AMBIENT_TEMP - self.temp[i]) / mat_i.specific_heat;
        }

        // ── §3.0 Stage 1: Apply temperature changes ─────────────────────
        for i in 0..n {
            self.temp[i] += dtemp[i] * dt;
            self.temp[i] = self.temp[i].clamp(-50.0, 5000.0);
        }

        // ── §3.2: Phase transitions ─────────────────────────────────────
        for i in 0..n {
            let mat = &MATS[self.mat_id[i] as usize];

            match self.phase[i] {
                PHASE_LIQUID => {
                    // Boiling: liquid → gas (§3.2)
                    if self.temp[i] >= mat.boiling_point {
                        self.phase[i] = PHASE_GAS;
                        // Absorb latent heat — temperature stays at boiling point
                        self.temp[i] = mat.boiling_point;
                        // Mass doesn't change but effective density drops
                    }
                    // Freezing: liquid → solid (§3.2)
                    if self.temp[i] <= mat.melting_point {
                        self.phase[i] = PHASE_SOLID;
                        self.temp[i] = mat.melting_point;
                    }
                }
                PHASE_GAS => {
                    // Condensation: gas → liquid (§3.2)
                    if self.temp[i] < mat.boiling_point - 5.0 {
                        self.phase[i] = PHASE_LIQUID;
                    }
                }
                PHASE_SOLID => {
                    // Melting: solid → liquid (§3.2)
                    if self.temp[i] > mat.melting_point + 5.0 {
                        self.phase[i] = PHASE_LIQUID;
                    }
                }
                _ => {}
            }
        }

        // ── Integration ─────────────────────────────────────────────────
        for i in 0..n {
            let inv_rho = 1.0 / self.rho[i];

            // Solid particles don't move (§3.2 — frozen)
            if self.phase[i] == PHASE_SOLID {
                self.vx[i] *= 0.9; // dampen to stop
                self.vy[i] *= 0.9;
                self.vz[i] *= 0.9;
                // Still affected by gravity to settle
                self.vy[i] -= gravity * dt * 0.1;
            } else {
                // Non-gravity forces
                self.vx[i] += self.fx[i] * inv_rho * dt;
                self.vy[i] += self.fy[i] * inv_rho * dt;
                self.vz[i] += self.fz[i] * inv_rho * dt;

                // Gravity
                self.vy[i] -= gravity * dt;

                // §3.2: Gas buoyancy — hot gas rises
                if self.phase[i] == PHASE_GAS {
                    let mat = &MATS[self.mat_id[i] as usize];
                    let t_excess = (self.temp[i] - mat.boiling_point).max(0.0);
                    let buoyancy = gravity * 1.5 + t_excess * 0.05; // rises faster when hotter
                    self.vy[i] += buoyancy * dt;
                }
            }

            // Velocity clamp
            let vsq = self.vx[i]*self.vx[i] + self.vy[i]*self.vy[i] + self.vz[i]*self.vz[i];
            let max_v: f32 = 2.0;
            if vsq > max_v * max_v {
                let s = max_v / vsq.sqrt();
                self.vx[i] *= s; self.vy[i] *= s; self.vz[i] *= s;
            }

            // Position
            self.px[i] += self.vx[i] * dt;
            self.py[i] += self.vy[i] * dt;
            self.pz[i] += self.vz[i] * dt;

            // Walls
            let pad = PARTICLE_SPACING;
            if self.py[i] < -HALF_H + pad {
                self.py[i] = -HALF_H + pad;
                if self.vy[i] < 0.0 { self.vy[i] *= -0.02; }
                self.vx[i] *= 0.98; self.vz[i] *= 0.98;
                // §3.0: Floor heat exchange
                let mat = &MATS[self.mat_id[i] as usize];
                self.temp[i] += (FLOOR_TEMP - self.temp[i]) * mat.thermal_k * dt * 2.0;
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
    }
}
