// s34scenes.mjs — the S3.4 dam-break scene builders (block, the column collapse, its front operator and the gate's
// kinematics), shared by s34-ref.mjs (A1, A2, A2g, V1 …) and the friction gates (FRICTION-spec §3.6: "Do not copy
// them: a copy of the harness would drift from A2g's own"). Moved out of s34-ref.mjs unchanged (its printed output is
// byte-identical before and after the move). The solver modules and the option builder are passed in, so a caller that
// loads src from FLUID_REF_SRC (the mutation harnesses) reaches every builder.

export const G = 9.80665, DX = 3.63 / 64, RHO = 998.2072

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** The builders, bound to one loaded solver ({ FlipRef, GridLayout, FaceType, makeParticles }) and its option builder
 *  `opts(extra)` (s34-ref's: the ghost-fluid solver with the density projection). */
export function s34Scenes({ FlipRef, GridLayout, FaceType, makeParticles }, opts) {
  // 8 ppc: 2×2×2 jittered sub-cells. Other ppc: a jittered lattice whose layer count per axis is round(cells·∛ppc), so
  // the block is filled exactly (spacing cells·h/layers, within 2.4 % of h/∛ppc) and the true surface stays at hi + 1.
  // 'random': uniform in each cell — no lattice (the disordered extreme).
  function block(lo, hi, rng, ppc = 8, h = DX, mode = 'lattice') {
    const pts = []
    let vp = h ** 3 / ppc
    if (ppc === 8 && mode === 'lattice') {
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
        for (let s = 0; s < 8; s++) pts.push([(i + ((s & 1) + rng()) / 2) * h, (j + (((s >> 1) & 1) + rng()) / 2) * h, (k + (((s >> 2) & 1) + rng()) / 2) * h])
    } else if (mode === 'random') {
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++)
        for (let s = 0; s < ppc; s++) pts.push([(i + rng()) * h, (j + rng()) * h, (k + rng()) * h])
    } else {
      const cells = [0, 1, 2].map(a => hi[a] - lo[a] + 1), layers = cells.map(c => Math.round(c * Math.cbrt(ppc))), sp = cells.map((c, a) => c * h / layers[a])
      vp = sp[0] * sp[1] * sp[2]
      for (let k = 0; k < layers[2]; k++) for (let j = 0; j < layers[1]; j++) for (let i = 0; i < layers[0]; i++)
        pts.push([lo[0] * h + (i + rng()) * sp[0], lo[1] * h + (j + rng()) * sp[1], lo[2] * h + (k + rng()) * sp[2]])
    }
    const p = makeParticles(pts.length)
    pts.forEach((x, q) => { p.pos.set(x, 3 * q); p.mass[q] = RHO * vp })
    return p
  }

  // r3 §1 front operator: the farthest one-cell x-slab holding ≥ 0.5·ppc·nz particles; x_f is that slab's leading edge
  // (at t = 0 the column's last slab gives x_f = a, Z = 1).
  function frontSlab(pos, n, h, nz, ppc = 8) {
    const counts = new Map()
    for (let q = 0; q < n; q++) { const i = Math.floor(pos[3 * q] / h); counts.set(i, (counts.get(i) ?? 0) + 1) }
    let best = -1
    for (const [i, c] of counts) if (c >= 0.5 * ppc * nz && i > best) best = i
    return (best + 1) * h
  }

  // gate: the release — 0 = instant (the column's side simply absent at t = 0), else a gate on the column's edge plane
  // lifted at that speed (m/s) from t = 0 (FlipRef options.gate)
  // A2g-kin (s34-ref header): the gate column's SOLID faces at step s against the pre-registered schedule
  // edge = speed·(s − ½)·Δt, read from the solver's face types — independent of its clock and gateEdge
  function gateKin(sim, L, gi, h, speed, s, dt, acc) {
    const edge = speed * (s - 0.5) * dt, t = sim.faceType[0]
    let solid = 0, mis = 0
    for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) {
      const yc = (j + 0.5) * h, isSolid = t[L.idx(gi, j, k)] === FaceType.SOLID
      if (isSolid) solid++
      if (Math.abs(yc - edge) > 1e-9 && isSolid !== (yc > edge)) mis++
    }
    acc.steps++; acc.mismatch += mis
    if (s === 1) acc.firstSolid = solid
  }

  /** The column collapse (A1/A2/A2g): `extra` adds solver options (the friction gates' wall shear, a liquid's
   *  properties) — absent, the solver is s34-ref's own; `onStep(sim, p, s)` sees every step (optional). */
  function column({ aCells, n2, h, nx, tauEnd, gate = 0, extra = {}, rho = RHO, onStep = null }) {
    const a = aCells * h, tUnit = Math.sqrt(a / G), rows = Math.round(n2 * aCells), nz = 8
    const L = new GridLayout({ nx, ny: rows + 8, nz, dx: h })
    const sim = new FlipRef(L, opts({ pressureTolerance: 1e-5, psiTolerance: 1e-4, ...(gate > 0 ? { gate: { i: aCells, speed: gate } } : {}), ...extra }))
    const p = block([0, 0, 0], [aCells - 1, rows - 1, nz - 1], mulberry32(60 + aCells), 8, h)
    if (rho !== RHO) for (let q = 0; q < p.n; q++) p.mass[q] *= rho / RHO
    const dt = (1 / 240) * (h / DX)
    const ts = [], Z = [], Zraw = [], Zpct = [], Hh = [], wallP = [], kin = { steps: 0, mismatch: 0, firstSolid: 0 }
    for (let s = 1; s * dt <= tauEnd * tUnit + 1e-9; s++) {
      sim.step(p, dt)
      if (gate > 0) gateKin(sim, L, aCells, h, gate, s, dt, kin)
      if (onStep) onStep(sim, p, s)
      let hMax = 0
      const xs = new Float64Array(p.n)
      for (let q = 0; q < p.n; q++) { xs[q] = p.pos[3 * q]; if (p.pos[3 * q] < h) hMax = Math.max(hMax, p.pos[3 * q + 1]) }
      xs.sort()
      // the pre-S3.4 operator (99.5th percentile of x) is kept only to report how much the verdict depends on the operator
      ts.push(s * dt); Z.push(frontSlab(p.pos, p.n, h, nz) / a); Zraw.push(xs[p.n - 1] / a); Zpct.push(xs[Math.floor(0.995 * (p.n - 1))] / a); Hh.push(hMax / (n2 * a))
      // downstream-wall bottom cell, averaged over the interior z cells (the sensor is on the centre line)
      let pw = 0
      for (let k = 1; k < nz - 1; k++) pw += sim.pressure[L.idx(nx - 1, 0, k)]
      wallP.push(pw / (nz - 2))
    }
    return { a, n: Math.sqrt(n2), tUnit, dt, ts, Z, Zraw, Zpct, H: Hh, wallP, particles: p.n, gateClamps: sim.diag.gateClamps, kin, sim, p }
  }

  return { block, frontSlab, gateKin, column }
}
