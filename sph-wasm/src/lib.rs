// ══════════════════════════════════════════════════════════════════════════════
// SPH Fluid Simulation — Rust/WASM
// Implements SPH from structure.md §3.2 using NORMALIZED UNITS
// Real material differences come from relative density/viscosity ratios
// ══════════════════════════════════════════════════════════════════════════════

use wasm_bindgen::prelude::*;
use std::f32::consts::PI;

// ── Simulation Parameters (normalized units) ────────────────────────────────
// Using normalized units where the box is ~2m wide and particles are small.
// Real-world material RATIOS are preserved (mercury is 13.5× denser than water)
// but absolute values are scaled for numerical stability.

const MAX_PARTICLES: usize = 10_000;

// Particle spacing and kernel
const H: f32 = 0.04;                    // kernel radius (smoothing length)
const H_SQ: f32 = H * H;
const PARTICLE_SPACING: f32 = H * 0.5;  // rest spacing = h/2 (standard for SPH)

// Tait equation
const GAMMA: f32 = 7.0;
const CS: f32 = 40.0;    // speed of sound — MUST be >> max particle velocity for stability

// Box
const HALF_W: f32 = 1.0;
const HALF_H: f32 = 0.75;
const HALF_D: f32 = 0.75;

// Spatial hash
const TABLE_SIZE: usize = 16381;
const CELL_SIZE: f32 = H * 2.0;

// ── Kernel (cubic spline M4, 3D) ────────────────────────────────────────────

fn sigma() -> f32 { 1.0 / (PI * H * H * H) }

#[inline(always)]
fn kernel_w(r: f32) -> f32 {
    let q = r / H;
    if q >= 2.0 { return 0.0; }
    let s = sigma();
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
    let s = sigma() / H;
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
    let s = sigma() / (H * H);
    if q <= 1.0 {
        s * (-3.0 + 4.5 * q)
    } else {
        s * (3.0 - 1.5 * q)
    }
}

// ── Materials (normalized — ratios match real physics) ──────────────────────
#[derive(Clone, Copy)]
struct Mat {
    rho0: f32,   // rest density (normalized: water=1.0)
    mu: f32,     // viscosity (normalized: water=0.01)
    sigma: f32,  // surface tension coefficient
}

const NMAT: usize = 7;
static MATS: [Mat; NMAT] = [
    Mat { rho0: 1.0,  mu: 0.01,  sigma: 0.1 },    // Water
    Mat { rho0: 1.4,  mu: 5.0,   sigma: 0.08 },    // Honey (viscosity ratio preserved)
    Mat { rho0: 7.8,  mu: 0.02,  sigma: 0.5 },     // Molten Copper
    Mat { rho0: 13.5, mu: 0.01,  sigma: 0.4 },     // Mercury
    Mat { rho0: 0.92, mu: 0.1,   sigma: 0.05 },    // Olive Oil
    Mat { rho0: 2.7,  mu: 3.0,   sigma: 0.3 },     // Lava
    Mat { rho0: 1.06, mu: 0.02,  sigma: 0.08 },    // Blood
];

// ── Spatial Hash (flat linked list) ─────────────────────────────────────────

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

// ── Simulation ──────────────────────────────────────────────────────────────

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
            grid: Grid::new(),
        }
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) { self.n = 0; }

    #[wasm_bindgen]
    pub fn get_count(&self) -> usize { self.n }

    #[wasm_bindgen]
    pub fn add_particles(&mut self, positions: &[f32], mat_idx: u8) -> usize {
        let mat = &MATS[mat_idx as usize % NMAT];
        let vol = PARTICLE_SPACING * PARTICLE_SPACING * PARTICLE_SPACING;
        let pm = mat.rho0 * vol;
        let num = positions.len() / 3;
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
}

impl Simulation {
    fn substep(&mut self, gravity: f32, dt: f32) {
        let n = self.n;
        if n == 0 { return; }

        // Build grid
        self.grid.clear();
        for i in 0..n { self.grid.insert(i, self.px[i], self.py[i], self.pz[i]); }

        // ── Density ──────────────────────────────────────────────────────
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
            self.rho[i] = rho.max(mat.rho0 * 0.1);
        }

        // ── Pressure (Tait) ──────────────────────────────────────────────
        for i in 0..n {
            let mat = &MATS[self.mat_id[i] as usize];
            let b = mat.rho0 * CS * CS / GAMMA;
            let ratio = self.rho[i] / mat.rho0;
            let r2 = ratio * ratio;
            let r4 = r2 * r2;
            let r7 = r4 * r2 * ratio;
            self.press[i] = b * (r7 - 1.0);
            // Clamp negative pressure (tension instability)
            if self.press[i] < 0.0 { self.press[i] = 0.0; }
        }

        // ── Forces ───────────────────────────────────────────────────────
        for i in 0..n { self.fx[i] = 0.0; self.fy[i] = 0.0; self.fz[i] = 0.0; }

        for i in 0..n {
            let (xi, yi, zi) = (self.px[i], self.py[i], self.pz[i]);
            let (vxi, vyi, vzi) = (self.vx[i], self.vy[i], self.vz[i]);
            let rho_i = self.rho[i];
            let p_i = self.press[i];
            let mi = self.mat_id[i] as usize;
            let mu_i = MATS[mi].mu;
            let p_rho2_i = p_i / (rho_i * rho_i);

            let mut fpx = 0.0f32; let mut fpy = 0.0f32; let mut fpz = 0.0f32;
            let mut fvx = 0.0f32; let mut fvy = 0.0f32; let mut fvz = 0.0f32;

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

                                    // Pressure force
                                    let gor = kernel_grad_over_r(r);
                                    let p_rho2_j = self.press[ju] / (rho_j * rho_j);
                                    let pc = -mj * (p_rho2_i + p_rho2_j);
                                    fpx += pc * gor * dx;
                                    fpy += pc * gor * dy;
                                    fpz += pc * gor * dz;

                                    // Viscosity force
                                    let mj_idx = self.mat_id[ju] as usize;
                                    let mu = (mu_i + MATS[mj_idx].mu) * 0.5;
                                    let mu_eff = mu.min(10.0); // stability clamp
                                    let lap = kernel_lap(r);
                                    let vc = mu_eff * mj / rho_j * lap;
                                    fvx += vc * (self.vx[ju] - vxi);
                                    fvy += vc * (self.vy[ju] - vyi);
                                    fvz += vc * (self.vz[ju] - vzi);
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
        }

        // ── Integration ──────────────────────────────────────────────────
        for i in 0..n {
            let inv_rho = 1.0 / self.rho[i];

            // Non-gravity forces
            self.vx[i] += self.fx[i] * inv_rho * dt;
            self.vy[i] += self.fy[i] * inv_rho * dt;
            self.vz[i] += self.fz[i] * inv_rho * dt;

            // Gravity — NEVER damped
            self.vy[i] -= gravity * dt;

            // Velocity clamp
            let vsq = self.vx[i]*self.vx[i] + self.vy[i]*self.vy[i] + self.vz[i]*self.vz[i];
            let max_v: f32 = 4.0;
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
            // Floor
            if self.py[i] < -HALF_H + pad {
                self.py[i] = -HALF_H + pad;
                if self.vy[i] < 0.0 { self.vy[i] *= -0.02; }
                self.vx[i] *= 0.98; self.vz[i] *= 0.98;
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
