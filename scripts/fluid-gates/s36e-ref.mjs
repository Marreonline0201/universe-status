#!/usr/bin/env node
// Gate S3.6e on the f64 CPU reference — the unified pressure–stress (Variational Stokes) solve, Larionov, Batty &
// Bridson 2017. Spec (criteria fixed before the first run): vault fluid/realism-2026-09/S3.6e-variational-stokes-spec.md.
// The physics gates of S3.6 run on this scheme through `S36_SCHEME=stokes node scripts/fluid-gates/s36-ref.mjs`.
//
//   node scripts/fluid-gates/s36e-ref.mjs [u0|st2|st1]...   (default: all)
//
// U0  uniform shear between no-slip walls (x periodic, bottom still, top at U, z free-slip), u* = the exact Couette field
//     set on the grid, one solve. Exact: τ_xy = μγ̇ on every edge (τ = 2με), every other τ and p zero, u = u*. Pass at
//     tolerance 1e-12: |u − u*| ≤ 1e-9·U, |τ_xy/(μγ̇) − 1| ≤ 1e-9, other τ and p ≤ 1e-9·μγ̇; and the NEGATIVE CONTROL: the
//     same solve with the full (mirrored) volume on the wall edges — the pre-fix S3.6 weights — must miss u = u* by
//     ≥ 1e-3·U (else U0 cannot see the wall weight).
// ST2 rigid rotation of a free honey ball (R = 5 cells, g = 0, u* = ω × r through APIC P2G), ONE step: the paper's §6.2
//     exactness claim ("rigid translations and rotations of liquid bodies with pure free surface boundaries"). Pass at
//     tolerance 1e-12: |u − u*| ≤ 1e-9·ωR on every unknown, |τ| ≤ 1e-9·μω, |p| ≤ 1e-9·ρ(ωR)²; faces whose u* came from
//     the extrapolation (no particle weight) are counted and reported.
// ST1 hydrostatic honey pool (8 of 16 cells deep, no-slip walls, particles on the 2×2×2 sub-cell lattice so the surface
//     is flat — the discrete balance ρ W_f g = Bᵀp is exact only where the volumes are horizontally uniform, see the
//     spec), 1 s at tolerance 1e-4 / 1e-6 / 1e-8: pass if max |u| over the run falls ≥ 10× per 100× tolerance, and the
//     NEGATIVE CONTROL — the level set without the wall images (levelSetWalls 'air': the surface bends down at every
//     wall) — moves ≥ 1e-4 m/s at 1e-8 (else ST1 cannot see the wall representation). Reported: the split scheme on the
//     same pool, and both schemes on a jittered pool (density projection off: the random packing re-arranges).
import { loadTsModules } from './lib/loadTs.mjs'

const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts` })
const { GridLayout } = gridLayout, { FlipRef, makeParticles } = flipRef
const G = 9.80665
const DX = 3.63 / 64
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const info = msg => console.log(`INFO ${msg}`)
const want = process.argv.slice(2).length ? new Set(process.argv.slice(2)) : new Set(['u0', 'st2', 'st1'])
const t0 = Date.now()
const HONEY = { mu: 40, rho: 1415 }
const e = v => v.toExponential(2)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** 8 particles per cell of the box [lo, hi) cells: jittered 2×2×2 sub-cells (rng) or the sub-cell centres (rng null). */
function fill(lo, hi, m, rng, keep = () => true) {
  const pts = []
  for (let k = lo[2]; k < hi[2]; k++) for (let j = lo[1]; j < hi[1]; j++) for (let i = lo[0]; i < hi[0]; i++) for (let s = 0; s < 8; s++) {
    const r = () => (rng ? rng() : 0.5)
    const x = [(i + ((s & 1) + r()) / 2) * DX, (j + (((s >> 1) & 1) + r()) / 2) * DX, (k + (((s >> 2) & 1) + r()) / 2) * DX]
    if (keep(x)) pts.push(x)
  }
  const p = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length).fill(m.mu)
  pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = m.rho * DX ** 3 / 8 })
  return p
}

// ── U0 ──
function u0(tol, fullWallEdges) {
  const ny = 16, L = new GridLayout({ nx: 4, ny, nz: 4, dx: DX }), U = 0.1, gd = U / (ny * DX)
  const sim = new FlipRef(L, { gravity: [0, 0, 0], density: HONEY.rho, projection: true, freeSurface: 'ghost', viscosity: 'force', viscosityScheme: 'stokes', stokesTolerance: tol,
    viscousTestBC: { periodicX: true, walls: { 'y-': { slip: 'no-slip' }, 'y+': { slip: 'no-slip', velocity: [U, 0, 0] }, 'z-': { slip: 'free-slip' }, 'z+': { slip: 'free-slip' } } } })
  if (fullWallEdges) {   // the negative control: undo the wall-plane halving (the pre-fix S3.6 volumes)
    const orig = sim.viscousVolumes.bind(sim)
    sim.viscousVolumes = () => {
      orig()
      for (const ee of [0, 1, 2]) for (let k = 0; k <= L.nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= L.nx; i++) {
        const c = [i, j, k], n = [L.nx, ny, L.nz]
        let f = 1
        for (const b of [1, 2]) if (b !== ee && (c[b] === 0 || c[b] === n[b])) f *= 2
        if (ee < 3 && c[ee] < n[ee]) sim.volEdge[ee][L.idx(i, j, k)] *= f
      }
    }
  }
  const p = fill([0, 0, 0], [L.nx, ny, L.nz], HONEY, mulberry32(70))
  sim.p2g(p); sim.gridUpdate(1 / 120); sim.applySolidFaces(); sim.classifyLevelSet(p)
  // u* = the exact Couette field (the x-faces at i = 0 are window walls to P2G; x is periodic only in the solve)
  for (let k = 0; k < L.nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i <= L.nx; i++) { const s = L.idx(i, j, k); sim.u[0][s] = gd * (j + 0.5) * DX; sim.valid[0][s] = 1 }
  const us = sim.u.map(a => Float64Array.from(a))
  const st = sim.stokesSolve(p, 1 / 120)
  let du = 0, tauErr = 0, other = 0
  for (let a = 0; a < 3; a++) for (let s = 0; s < L.size; s++) if (sim.viscWritten[a][s]) du = Math.max(du, Math.abs(sim.u[a][s] - us[a][s]))
  for (let k = 0; k < L.nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i < L.nx; i++) { const s = L.idx(i, j, k); if (sim.volEdge[2][s] > 0) tauErr = Math.max(tauErr, Math.abs(sim.stokesStress.edge[2][s] / (HONEY.mu * gd) - 1)) }
  for (let s = 0; s < L.size; s++) other = Math.max(other, Math.abs(sim.pressure[s]), ...[0, 1, 2].map(a => Math.abs(sim.stokesStress.cell[a][s])), Math.abs(sim.stokesStress.edge[0][s]), Math.abs(sim.stokesStress.edge[1][s]))
  return { du: du / U, tauErr, other: other / (HONEY.mu * gd), st }
}
if (want.has('u0')) {
  for (const tol of [1e-6, 1e-9]) { const r = u0(tol, false); info(`U0 at tolerance ${tol}: |u − u*|/U ${e(r.du)}, |τ_xy/(μγ̇) − 1| ${e(r.tauErr)}, other τ and p ${e(r.other)} μγ̇; ${r.st.iterations} it`) }
  const r = u0(1e-12, false), neg = u0(1e-12, true)
  check(r.du <= 1e-9 && r.tauErr <= 1e-9 && r.other <= 1e-9 && neg.du >= 1e-3,
    `U0 uniform shear between no-slip walls (${r.st.faces} unknowns, ${r.st.rows} rows, ${r.st.dropped} dropped, ${r.st.iterations} it, true ‖r‖∞ ${e(r.st.trueResidualInf)}): |u − u*|/U ${e(r.du)} (≤ 1e-9), |τ_xy/(μγ̇) − 1| ${e(r.tauErr)} (≤ 1e-9), other τ and p ${e(r.other)} μγ̇ (≤ 1e-9); negative control with the full wall-edge volume: |u − u*|/U ${e(neg.du)} (≥ 1e-3)`)
}

// ── ST2 ──
function st2(tol) {
  const n = 16, L = new GridLayout({ nx: n, ny: n, nz: n, dx: DX }), R = 5 * DX, cx = n * DX / 2, w = 2, dt = 1 / 120
  const sim = new FlipRef(L, { gravity: [0, 0, 0], density: HONEY.rho, projection: true, freeSurface: 'ghost', viscosity: 'force', viscosityScheme: 'stokes', stokesTolerance: tol, viscosityDefault: HONEY.mu })
  const p = fill([0, 0, 0], [n, n, n], HONEY, mulberry32(90), x => (x[0] - cx) ** 2 + (x[1] - cx) ** 2 + (x[2] - cx) ** 2 < R * R)
  for (let q = 0; q < p.n; q++) {
    const x = p.pos[3 * q] - cx, y = p.pos[3 * q + 1] - cx
    p.vel.set([-w * y, w * x, 0], 3 * q); p.c[0].set([0, -w, 0], 3 * q); p.c[1].set([w, 0, 0], 3 * q)
  }
  sim.p2g(p); sim.gridUpdate(dt); sim.applySolidFaces(); sim.classifyLevelSet(p); sim.fillUnsetLiquidFaces()
  const p2gValid = sim.valid.map(a => Uint8Array.from(a))
  sim.extrapolate(); sim.applySolidFaces()
  const us = sim.u.map(a => Float64Array.from(a))
  const st = sim.stokesSolve(p, dt)
  let du = 0, tau = 0, pm = 0, extrap = 0, starErr = 0
  for (let a = 0; a < 3; a++) for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const s = L.idx(i, j, k)
    if (!sim.viscWritten[a][s]) continue
    du = Math.max(du, Math.abs(sim.u[a][s] - us[a][s]))
    if (!p2gValid[a][s]) { extrap++; continue }
    const fx = (i + (a === 0 ? 0 : 0.5)) * DX - cx, fy = (j + (a === 1 ? 0 : 0.5)) * DX - cx
    starErr = Math.max(starErr, Math.abs(us[a][s] - (a === 0 ? -w * fy : a === 1 ? w * fx : 0)))
  }
  for (let s = 0; s < L.size; s++) { pm = Math.max(pm, Math.abs(sim.pressure[s])); for (let a = 0; a < 3; a++) tau = Math.max(tau, Math.abs(sim.stokesStress.cell[a][s]), Math.abs(sim.stokesStress.edge[a][s])) }
  return { du: du / (w * R), tau: tau / (HONEY.mu * w), p: pm / (HONEY.rho * (w * R) ** 2), extrap, starErr: starErr / (w * R), st, particles: p.n }
}
if (want.has('st2')) {
  const r = st2(1e-12)
  check(r.du <= 1e-9 && r.tau <= 1e-9 && r.p <= 1e-9,
    `ST2 rigid rotation of a free honey ball, one Stokes step — B annihilates the rotation, so the right-hand side is 0 and the solve does no work: this checks the rows' structure (signs, the off-diagonal pairing), U0 checks the solver (${r.particles} particles, ${r.st.faces} unknowns, ${r.st.rows} rows, ${r.st.dropped} dropped, ${r.st.iterations} it): |u − u*|/(ωR) ${e(r.du)} (≤ 1e-9), |τ|/(μω) ${e(r.tau)} (≤ 1e-9), |p|/(ρ(ωR)²) ${e(r.p)} (≤ 1e-9); u* vs ω × r on the particle-weighted faces ${e(r.starErr)} ωR; unknowns whose u* was extrapolated: ${r.extrap}`)
}

// ── ST1 ──
function st1(scheme, tol, jitter, levelSetWalls = 'mirror') {
  const L = new GridLayout({ nx: 16, ny: 16, nz: 4, dx: DX }), dt = 1 / 120
  const sim = new FlipRef(L, { gravity: [0, -G, 0], density: HONEY.rho, projection: true, densityProjection: false, freeSurface: 'ghost', viscosity: 'force', viscosityDefault: HONEY.mu,
    viscosityScheme: scheme, stokesTolerance: tol, pressureTolerance: tol, viscosityTolerance: 1e-10, levelSetWalls })
  const p = fill([0, 0, 0], [16, 8, 4], HONEY, jitter ? mulberry32(110) : null)
  let uMax = 0, it = 0
  for (let s = 0; s < 120; s++) {
    sim.step(p, dt)
    for (let q = 0; q < p.n; q++) uMax = Math.max(uMax, Math.hypot(p.vel[3 * q], p.vel[3 * q + 1], p.vel[3 * q + 2]))
    it = Math.max(it, sim.lastStokes?.iterations ?? sim.lastViscosity?.iterations ?? 0)
  }
  return { uMax, it, particles: p.n }
}
if (want.has('st1')) {
  const tols = [1e-4, 1e-6, 1e-8], rs = tols.map(tol => st1('stokes', tol, false))
  const falls = rs.every((r, i) => i === 0 || r.uMax <= rs[i - 1].uMax / 10), neg = st1('stokes', 1e-8, false, 'air')
  check(falls && neg.uMax >= 1e-4, `ST1 hydrostatic honey pool on the sub-cell lattice, 1 s, Stokes: max |u| ${rs.map((r, i) => `${e(r.uMax)} m/s at ${tols[i]} (≤ ${r.it} it)`).join(', ')} — falls ≥ 10× per 100× tolerance; negative control without the wall images: ${e(neg.uMax)} m/s at 1e-8 (≥ 1e-4)`)
  const split = st1('split', 1e-8, false)
  info(`ST1 the split scheme on the same lattice pool (pressure tolerance 1e-8, viscous 1e-10 relative): max |u| ${e(split.uMax)} m/s`)
  const js = st1('stokes', 1e-8, true), jp = st1('split', 1e-8, true)
  info(`ST1 jittered pool (${js.particles} particles), max |u| over 1 s: Stokes ${e(js.uMax)} m/s, split ${e(jp.uMax)} m/s`)
}

console.log(`\ns3.6e reference gate: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails === 0 ? 0 : 1)
