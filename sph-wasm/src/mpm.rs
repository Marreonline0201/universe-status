// ══════════════════════════════════════════════════════════════════════════════
// MLS-MPM (Moving Least Squares Material Point Method) — Rust/WASM
//
// structure.md §3.2 — Scale 2: Local environment (5,000–200,000 particles)
//
// Algorithm (APIC variant from Hu et al. 2018 "A Moving Least Squares
// Material Point Method with Displacement Discontinuity"):
//
//   For each substep:
//     1. P2G: Scatter particle mass, momentum, and forces to grid
//        - weight w_ip = N(x_p - x_i) using quadratic B-spline
//        - grid_mass[i] += w_ip * m_p
//        - grid_mv[i] += w_ip * (m_p * v_p + m_p * C_p * (x_i - x_p))
//     2. Grid update: Apply gravity and boundary conditions
//        - grid_v[i] = grid_mv[i] / grid_mass[i] + dt * gravity
//        - enforce boundary conditions (clamp velocity at walls)
//     3. G2P: Gather grid velocities back to particles
//        - v_p = Σ w_ip * grid_v[i]
//        - C_p = 4/(dx²) * Σ w_ip * grid_v[i] ⊗ (x_i - x_p)
//        - x_p += dt * v_p
//     4. Update deformation gradient F
//        - F_p = (I + dt * C_p) * F_p
//        - Apply constitutive model to compute stress
//
// Grid cell size = 2 × particle spacing (§3.2)
// Performance: ~2,700 FLOPs per particle per timestep (§3.2)
// ══════════════════════════════════════════════════════════════════════════════

use wasm_bindgen::prelude::*;

// ── Grid Parameters ──────────────────────────────────────────────────────────
const MPM_GRID_RES: usize = 32;        // lower res = more particles per cell = better pressure
const MPM_MAX_PARTICLES: usize = 200_000;
// Domain: grid covers [-DOMAIN_HALF, +DOMAIN_HALF]³ in world space
const MPM_DOMAIN_HALF: f32 = 1.1;      // slightly larger than half_w=1.0 for margin
const MPM_DX: f32 = 2.0 * MPM_DOMAIN_HALF / MPM_GRID_RES as f32; // ~0.034375
const MPM_INV_DX: f32 = MPM_GRID_RES as f32 / (2.0 * MPM_DOMAIN_HALF); // ~29.09

// ── 3×3 Matrix (column-major, for deformation gradient F and APIC C) ─────
#[derive(Clone, Copy)]
struct Mat3 {
    m: [f32; 9], // column-major: m[col*3+row]
}

impl Mat3 {
    fn identity() -> Self {
        Mat3 { m: [1.0, 0.0, 0.0,  0.0, 1.0, 0.0,  0.0, 0.0, 1.0] }
    }

    fn zero() -> Self {
        Mat3 { m: [0.0; 9] }
    }

    // Element access: (row, col)
    #[inline(always)]
    fn get(&self, row: usize, col: usize) -> f32 {
        self.m[col * 3 + row]
    }

    #[inline(always)]
    fn set(&mut self, row: usize, col: usize, val: f32) {
        self.m[col * 3 + row] = val;
    }

    // Matrix × Matrix
    fn mul(&self, b: &Mat3) -> Mat3 {
        let mut r = Mat3::zero();
        for i in 0..3 {
            for j in 0..3 {
                let mut sum = 0.0;
                for k in 0..3 {
                    sum += self.get(i, k) * b.get(k, j);
                }
                r.set(i, j, sum);
            }
        }
        r
    }

    // Matrix × scalar
    fn scale(&self, s: f32) -> Mat3 {
        let mut r = Mat3::zero();
        for i in 0..9 { r.m[i] = self.m[i] * s; }
        r
    }

    // Matrix + Matrix
    fn add(&self, b: &Mat3) -> Mat3 {
        let mut r = Mat3::zero();
        for i in 0..9 { r.m[i] = self.m[i] + b.m[i]; }
        r
    }

    // Determinant
    fn det(&self) -> f32 {
        self.get(0,0) * (self.get(1,1)*self.get(2,2) - self.get(1,2)*self.get(2,1))
      - self.get(0,1) * (self.get(1,0)*self.get(2,2) - self.get(1,2)*self.get(2,0))
      + self.get(0,2) * (self.get(1,0)*self.get(2,1) - self.get(1,1)*self.get(2,0))
    }

    // Transpose
    fn transpose(&self) -> Mat3 {
        let mut r = Mat3::zero();
        for i in 0..3 {
            for j in 0..3 {
                r.set(i, j, self.get(j, i));
            }
        }
        r
    }

    // Outer product: a ⊗ b
    fn outer(a: [f32; 3], b: [f32; 3]) -> Mat3 {
        let mut r = Mat3::zero();
        for i in 0..3 {
            for j in 0..3 {
                r.set(i, j, a[i] * b[j]);
            }
        }
        r
    }
}

// ── Quadratic B-spline interpolation weight ──────────────────────────────────
// N(x) for the range [-1.5, 1.5] in grid-space coordinates
#[inline(always)]
fn bspline_weight(x: f32) -> f32 {
    let ax = x.abs();
    if ax < 0.5 {
        0.75 - ax * ax
    } else if ax < 1.5 {
        let t = 1.5 - ax;
        0.5 * t * t
    } else {
        0.0
    }
}

// ── Grid node ────────────────────────────────────────────────────────────────
#[derive(Clone, Copy)]
struct GridNode {
    mass: f32,
    vx: f32, vy: f32, vz: f32, // momentum during P2G, velocity after normalization
}

impl GridNode {
    fn zero() -> Self {
        GridNode { mass: 0.0, vx: 0.0, vy: 0.0, vz: 0.0 }
    }
}

// ── MPM Particle ─────────────────────────────────────────────────────────────
#[derive(Clone, Copy)]
struct MpmParticle {
    px: f32, py: f32, pz: f32,     // position
    vx: f32, vy: f32, vz: f32,     // velocity
    j: f32,                          // J = det(F) — volume ratio (fluid optimization)
    f: Mat3,                         // full deformation gradient (for solids only)
    c: Mat3,                         // APIC affine velocity field
    mass: f32,
    volume0: f32,                    // initial volume
    mat_id: u8,
    temp: f32,                       // temperature (°C)
    phase: u8,                       // 0=liquid, 1=gas, 2=solid
}

// ── Material models ──────────────────────────────────────────────────────────
// Constitutive model: returns Cauchy stress σ from deformation gradient F
// For fluids: σ = -p·I where p comes from equation of state
// For elastic solids: Neo-Hookean σ = μ(F·Fᵀ - I)/J + λ·ln(J)/J · I
fn fluid_stress(f: &Mat3, bulk_modulus: f32, rest_density: f32) -> Mat3 {
    let j = f.det(); // J = det(F) — volume ratio
    // Equation of state: pressure from volume change
    // p = bulk_modulus * (1 - 1/J)  — Tait-like for weakly compressible
    let pressure = -bulk_modulus * (1.0 / j.max(0.1) - 1.0);
    // Cauchy stress σ = pressure * I (isotropic for fluids)
    let mut stress = Mat3::identity();
    stress = stress.scale(pressure);
    stress
}

fn elastic_stress(f: &Mat3, mu: f32, lambda: f32) -> Mat3 {
    let j = f.det();
    let j_clamped = j.max(0.01);
    let ln_j = j_clamped.ln();

    // Neo-Hookean: P = μ(F - F^-T) + λ·ln(J)·F^-T
    // Cauchy stress: σ = (1/J) * P * Fᵀ
    // Simplified: σ = μ/J * (F·Fᵀ - I) + λ/J * ln(J) * I
    let ft = f.transpose();
    let fft = f.mul(&ft);
    let mut stress = Mat3::identity();

    for i in 0..3 {
        for j_idx in 0..3 {
            let val = mu / j_clamped * (fft.get(i, j_idx) - if i == j_idx { 1.0 } else { 0.0 })
                    + lambda / j_clamped * ln_j * if i == j_idx { 1.0 } else { 0.0 };
            stress.set(i, j_idx, val);
        }
    }
    stress
}

// ══════════════════════════════════════════════════════════════════════════════
// MLS-MPM Simulation
// ══════════════════════════════════════════════════════════════════════════════

#[wasm_bindgen]
pub struct MpmSimulation {
    particles: Vec<MpmParticle>,
    n: usize,
    grid: Vec<GridNode>,
    grid_res: usize,
    dx: f32,
    inv_dx: f32,
    domain_half: f32, // grid covers [-domain_half, +domain_half]³
    // Mutable bounds (box walls, can be smaller than domain)
    half_w: f32, half_h: f32, half_d: f32,
    gravity: f32,
}

#[wasm_bindgen]
impl MpmSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let grid_res = MPM_GRID_RES;
        let total_nodes = grid_res * grid_res * grid_res;
        MpmSimulation {
            particles: Vec::with_capacity(MPM_MAX_PARTICLES),
            n: 0,
            grid: vec![GridNode::zero(); total_nodes],
            grid_res,
            dx: MPM_DX,
            inv_dx: MPM_INV_DX,
            domain_half: MPM_DOMAIN_HALF,
            half_w: 1.0,
            half_h: 0.75,
            half_d: 0.75,
            gravity: 9.81,
        }
    }

    #[wasm_bindgen]
    pub fn get_count(&self) -> usize { self.n }

    #[wasm_bindgen]
    pub fn reset(&mut self) {
        self.n = 0;
        self.particles.clear();
    }

    #[wasm_bindgen]
    pub fn set_bounds(&mut self, hw: f32, hh: f32, hd: f32) {
        self.half_w = hw;
        self.half_h = hh;
        self.half_d = hd;
    }

    /// Add particles at given positions
    #[wasm_bindgen]
    pub fn add_particles(&mut self, positions: &[f32], mat_idx: u8) -> usize {
        let num = positions.len() / 3;
        let vol = self.dx * self.dx * self.dx * 0.5; // particle volume
        let mass = vol * 1.0; // normalized density = 1.0 for water

        let mut added = 0;
        for p in 0..num {
            if self.n >= MPM_MAX_PARTICLES { break; }
            let particle = MpmParticle {
                px: positions[p*3],
                py: positions[p*3+1],
                pz: positions[p*3+2],
                vx: 0.0, vy: 0.0, vz: 0.0,
                j: 1.0, // volume ratio starts at 1 (undeformed)
                f: Mat3::identity(),
                c: Mat3::zero(),
                mass,
                volume0: vol,
                mat_id: mat_idx,
                temp: 20.0,
                phase: 0, // liquid
            };
            self.particles.push(particle);
            self.n += 1;
            added += 1;
        }
        added
    }

    /// Main simulation step: runs sub_steps substeps
    #[wasm_bindgen]
    pub fn step(&mut self, gravity: f32, dt: f32, sub_steps: u32) {
        self.gravity = gravity;
        let sdt = dt / sub_steps as f32;
        for _ in 0..sub_steps {
            self.substep(sdt);
        }
    }

    /// Get particle positions as flat array [x0,y0,z0, x1,y1,z1, ...]
    #[wasm_bindgen]
    pub fn get_positions(&self) -> Vec<f32> {
        let mut out = vec![0.0f32; self.n * 3];
        for i in 0..self.n {
            out[i*3]   = self.particles[i].px;
            out[i*3+1] = self.particles[i].py;
            out[i*3+2] = self.particles[i].pz;
        }
        out
    }

    /// Get particle velocities
    #[wasm_bindgen]
    pub fn get_velocities(&self) -> Vec<f32> {
        let mut out = vec![0.0f32; self.n * 3];
        for i in 0..self.n {
            out[i*3]   = self.particles[i].vx;
            out[i*3+1] = self.particles[i].vy;
            out[i*3+2] = self.particles[i].vz;
        }
        out
    }

    /// Get material IDs
    #[wasm_bindgen]
    pub fn get_mat_ids(&self) -> Vec<u8> {
        self.particles[..self.n].iter().map(|p| p.mat_id).collect()
    }

    // ── Core MLS-MPM substep ─────────────────────────────────────────────
    fn substep(&mut self, dt: f32) {
        if self.n == 0 { return; }

        let res = self.grid_res;
        let inv_dx = self.inv_dx;
        let dx = self.dx;
        let dh = self.domain_half;

        // ── Step 0: Clear grid ───────────────────────────────────────────
        for node in self.grid.iter_mut() {
            *node = GridNode::zero();
        }

        // ── Step 1: P2G (Particle to Grid) ──────────────────────────────
        let bulk_modulus = 50.0;
        for pi in 0..self.n {
            let p = &self.particles[pi];
            let gx = (p.px + dh) * inv_dx;
            let gy = (p.py + dh) * inv_dx;
            let gz = (p.pz + dh) * inv_dx;
            let base_x = (gx - 0.5).floor() as i32;
            let base_y = (gy - 0.5).floor() as i32;
            let base_z = (gz - 0.5).floor() as i32;

            let j_p = p.j.clamp(0.3, 3.0);
            let stress_scalar = -p.volume0 * 4.0 * inv_dx * inv_dx * bulk_modulus * (j_p - 1.0) * dt;

            for di in 0..3i32 {
                for dj in 0..3i32 {
                    for dk in 0..3i32 {
                        let ix = base_x + di;
                        let iy = base_y + dj;
                        let iz = base_z + dk;
                        if ix < 0 || ix >= res as i32
                        || iy < 0 || iy >= res as i32
                        || iz < 0 || iz >= res as i32 { continue; }
                        let idx = (ix as usize) * res * res + (iy as usize) * res + (iz as usize);
                        let fx = gx - ix as f32;
                        let fy = gy - iy as f32;
                        let fz = gz - iz as f32;
                        let w = bspline_weight(fx) * bspline_weight(fy) * bspline_weight(fz);
                        if w < 1e-10 { continue; }

                        let dpos = [fx * dx, fy * dx, fz * dx];

                        let ax = (stress_scalar + p.mass * p.c.get(0,0)) * dpos[0]
                               + p.mass * p.c.get(0,1) * dpos[1]
                               + p.mass * p.c.get(0,2) * dpos[2];
                        let ay = p.mass * p.c.get(1,0) * dpos[0]
                               + (stress_scalar + p.mass * p.c.get(1,1)) * dpos[1]
                               + p.mass * p.c.get(1,2) * dpos[2];
                        let az = p.mass * p.c.get(2,0) * dpos[0]
                               + p.mass * p.c.get(2,1) * dpos[1]
                               + (stress_scalar + p.mass * p.c.get(2,2)) * dpos[2];

                        let wm = w * p.mass;
                        let node = &mut self.grid[idx];
                        node.mass += wm;
                        node.vx += w * (p.mass * p.vx + ax);
                        node.vy += w * (p.mass * p.vy + ay);
                        node.vz += w * (p.mass * p.vz + az);
                    }
                }
            }
        }

        // ── Step 2: Grid velocity update ────────────────────────────────
        // Normalize momentum → velocity, apply gravity, enforce box walls
        // Convert box boundaries to grid coordinates
        let wall_pad = 1.0; // 1 grid cell padding
        let box_lo_x = (-self.half_w + dh) * inv_dx + wall_pad;
        let box_hi_x = ( self.half_w + dh) * inv_dx - wall_pad;
        let box_lo_y = (-self.half_h + dh) * inv_dx + wall_pad;
        let box_hi_y = ( self.half_h + dh) * inv_dx - wall_pad;
        let box_lo_z = (-self.half_d + dh) * inv_dx + wall_pad;
        let box_hi_z = ( self.half_d + dh) * inv_dx - wall_pad;

        let grid_bound = 2; // also enforce at grid edges for safety
        for ix in 0..res {
            for iy in 0..res {
                for iz in 0..res {
                    let idx = ix * res * res + iy * res + iz;
                    let node = &mut self.grid[idx];
                    if node.mass <= 1e-10 { continue; }

                    // Momentum → velocity
                    let inv_m = 1.0 / node.mass;
                    node.vx *= inv_m;
                    node.vy *= inv_m;
                    node.vz *= inv_m;

                    // Gravity
                    node.vy -= self.gravity * dt;

                    // Box wall boundary conditions
                    let fx = ix as f32;
                    let fy = iy as f32;
                    let fz = iz as f32;

                    // X walls
                    if fx <= box_lo_x && node.vx < 0.0 { node.vx = 0.0; }
                    if fx >= box_hi_x && node.vx > 0.0 { node.vx = 0.0; }
                    // Y floor (no downward) and ceiling (no upward)
                    if fy <= box_lo_y && node.vy < 0.0 { node.vy = 0.0; }
                    if fy >= box_hi_y && node.vy > 0.0 { node.vy = 0.0; }
                    // Z walls
                    if fz <= box_lo_z && node.vz < 0.0 { node.vz = 0.0; }
                    if fz >= box_hi_z && node.vz > 0.0 { node.vz = 0.0; }

                    // Grid edge safety
                    if ix < grid_bound || ix >= res - grid_bound { node.vx = 0.0; }
                    if iy < grid_bound || iy >= res - grid_bound { node.vy = 0.0; }
                    if iz < grid_bound || iz >= res - grid_bound { node.vz = 0.0; }
                }
            }
        }

        // ── Step 3: G2P (Grid to Particle) ──────────────────────────────
        // Gather grid velocities back to particles
        for pi in 0..self.n {
            let p = &mut self.particles[pi];

            // Same world→grid mapping as P2G
            let gx = (p.px + dh) * inv_dx;
            let gy = (p.py + dh) * inv_dx;
            let gz = (p.pz + dh) * inv_dx;

            let base_x = (gx - 0.5).floor() as i32;
            let base_y = (gy - 0.5).floor() as i32;
            let base_z = (gz - 0.5).floor() as i32;

            let mut new_vx = 0.0f32;
            let mut new_vy = 0.0f32;
            let mut new_vz = 0.0f32;
            let mut new_c = Mat3::zero();

            for di in 0..3i32 {
                for dj in 0..3i32 {
                    for dk in 0..3i32 {
                        let ix = base_x + di;
                        let iy = base_y + dj;
                        let iz = base_z + dk;

                        if ix < 0 || ix >= res as i32
                        || iy < 0 || iy >= res as i32
                        || iz < 0 || iz >= res as i32 { continue; }

                        let idx = (ix as usize) * res * res + (iy as usize) * res + (iz as usize);
                        let node = &self.grid[idx];

                        let fx = gx - ix as f32;
                        let fy = gy - iy as f32;
                        let fz = gz - iz as f32;

                        let w = bspline_weight(fx) * bspline_weight(fy) * bspline_weight(fz);
                        if w < 1e-10 { continue; }

                        // Gather velocity
                        new_vx += w * node.vx;
                        new_vy += w * node.vy;
                        new_vz += w * node.vz;

                        // APIC: accumulate affine velocity field C
                        // C = B * D^-1 where B = Σ w * v ⊗ dpos, D = Σ w * dpos ⊗ dpos
                        // For quadratic B-spline: D^-1 = 4/dx²
                        let dpos = [fx * dx, fy * dx, fz * dx];
                        let wv = [w * node.vx, w * node.vy, w * node.vz];
                        let outer = Mat3::outer(wv, dpos);
                        new_c = new_c.add(&outer.scale(4.0 * inv_dx * inv_dx));
                    }
                }
            }

            // Update particle
            p.vx = new_vx;
            p.vy = new_vy;
            p.vz = new_vz;
            p.c = new_c;

            // Light viscous damping — prevents pure gas behavior
            let damp = 1.0 / (1.0 + 0.5 * dt);
            p.vx *= damp;
            p.vz *= damp;

            // Advect position
            p.px += dt * p.vx;
            p.py += dt * p.vy;
            p.pz += dt * p.vz;

            // Update deformation
            if p.phase == 0 {
                // Fluid: J tracks volume ratio via velocity divergence
                let trace_c = p.c.get(0,0) + p.c.get(1,1) + p.c.get(2,2);
                p.j *= 1.0 + dt * trace_c;
                p.j = p.j.clamp(0.3, 3.0);
            } else {
                let dt_c = p.c.scale(dt);
                let update = Mat3::identity().add(&dt_c);
                p.f = update.mul(&p.f);
                p.j = p.f.det();
            }

            // Clamp to bounds AND zero velocity at walls (prevents velocity explosion)
            let pad = dx * 3.0;
            let lo_x = -self.half_w + pad;
            let hi_x =  self.half_w - pad;
            let lo_y = -self.half_h + pad;
            let hi_y =  self.half_h - pad;
            let lo_z = -self.half_d + pad;
            let hi_z =  self.half_d - pad;

            if p.px < lo_x { p.px = lo_x; if p.vx < 0.0 { p.vx = 0.0; } }
            if p.px > hi_x { p.px = hi_x; if p.vx > 0.0 { p.vx = 0.0; } }
            if p.py < lo_y { p.py = lo_y; if p.vy < 0.0 { p.vy = 0.0; } }
            if p.py > hi_y { p.py = hi_y; if p.vy > 0.0 { p.vy = 0.0; } }
            if p.pz < lo_z { p.pz = lo_z; if p.vz < 0.0 { p.vz = 0.0; } }
            if p.pz > hi_z { p.pz = hi_z; if p.vz > 0.0 { p.vz = 0.0; } }

            // Velocity cap for stability
            let max_v = 3.0;
            p.vx = p.vx.clamp(-max_v, max_v);
            p.vy = p.vy.clamp(-max_v, max_v);
            p.vz = p.vz.clamp(-max_v, max_v);
        }
    }
}
