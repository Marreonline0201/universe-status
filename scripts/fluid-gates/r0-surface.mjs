#!/usr/bin/env node
// Gate R0-surface — the splat radius (r6 flaw 1b, FINAL-PLAN D12): OPT-1-h (EXTENDED-ROADMAP §5.1, [PROPOSED]) — in a
// settled pool the RENDERED free surface lies within ±0.25 dx (dx = 5.67 cm → ±1.42 cm) of the SIMULATED surface —
// and coverage: small splats must not open holes in thin liquid. r6 predicted the legacy 0.025-wu splats 7.3 cm high.
//
//   node scripts/fluid-gates/r0-surface.mjs
//
// A. Surface estimator, validated on a known answer: the pool scenario (water box 0–3.28 m × 0–0.60 m over the whole
//    floor) frozen at frame 0 is spawn.ts's jittered lattice, whose top is exactly origin_y + n_y·s. Estimator (gated):
//    the HALF-DENSITY height — where the particle number density, smoothed by a tent kernel of half-width s (a
//    partition of unity on the lattice), falls to half the bulk density n_b (n_b over [y₈₅ − 6 s, y₈₅], y₈₅ = the 85th
//    height percentile). It must recover the lattice top within 0.1 s. The "equivalent height"
//    y₈₅ + N(y > y₈₅)/(A·n_b) is reported too (used first while developing this gate; it assumes the density above y₈₅
//    equals n_b, which a stratified layer violates). A first half-density version (box window, "first ≥ ½ from above")
//    failed this very check with a +0.25 s plateau bias, which is why the tent kernel is used.
// B. Offset: the same scene stepped 1200 frames (20 s, lockstep 1/60 s; at 240 frames it still sloshes, measured) and
//    frozen; rendered surface = the smoothed depth the composite shades (probe 'depth'), converted to world y along each
//    pixel's ray, over the central 0.3–0.7 of the tank; (a) orthographic top view, (b) the page's default camera
//    (2, 1.5, 2) → (0.5, 0.5, 0.5), 50°, 1280×800. Check: |rendered − simulated| ≤ 0.25 dx in both views.
// C. Holes: FLUID TEST's own default scene (≈10k particles) at frame 45 (falling block) and frame 600 (spread into a
//    puddle one to two particle layers thick), page camera. A hole = an empty pixel with liquid within 4 px on both
//    sides horizontally AND vertically. Check: holes ≤ 1 % of (liquid + hole) pixels.
// The renderer's default radius (SSFRPipeline SPLAT_RADIUS_FACTOR, read back through the probe) must pass B and C;
// positive control: the legacy 0.025-wu radius must fail B. Every radius measured is reported, with the smallest that
// passes B and C. Limits: one seed, one settled state; the simulated surface itself is only defined to ~0.75 s at this
// particle spacing (the two estimators above differ by that much on the settled layer).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, makeGate, writeReport, loadScenario, waitStepped, sample } from '../lib/fluid-page.mjs'
import * as ref from './lib/opticsRef.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE R0-surface (splat radius: OPT-1-h surface height and coverage)')
const report = {}
const GRID = 64, DX = 1 / GRID, VP = 1 / (GRID ** 3 * 4), S = Math.cbrt(VP), MPU = 3.63
const TOL = 0.25 * DX, HOLE_LIMIT = 0.01
const R0 = 0.3, R1 = 0.7                          // central region in x and z (world units)
const R_EQ = Math.cbrt(3 / (4 * Math.PI))         // volume-equivalent radius / spacing = 0.6204
const LEGACY = 0.025 / S
const FACTORS = [LEGACY, 1.5, 1.25, 1.0, 0.8, 0.7, R_EQ]
const BOX_MAX_M = [3.28, 0.60, 3.28]
const pool = { name: 'r0-surface-pool', materials: [], gravity_mps2: 9.80665, spawns: [{ material: 'Water', box: { min: [0, 0, 0], max: BOX_MAX_M } }] }

/** Surface estimators over the particles in the central region. */
function estimate(s) {
  const ys = []
  for (let i = 0; i < s.n; i++) {
    const x = s.pos[3 * i], y = s.pos[3 * i + 1], z = s.pos[3 * i + 2]
    if (x >= R0 && x <= R1 && z >= R0 && z <= R1) ys.push(y)
  }
  ys.sort((a, b) => a - b)
  const A = (R1 - R0) ** 2
  const top = ys[ys.length - 1]
  const y85 = ys[Math.floor(0.85 * ys.length)]
  const count = (lo, hi) => { let k = 0; for (const y of ys) if (y > lo && y <= hi) k++; return k }
  const nb = count(y85 - 6 * S, y85) / (A * 6 * S)
  const equivalent = y85 + count(y85, Infinity) / (A * nb)
  // tent kernel of half-width s: a partition of unity on a lattice of spacing s, so the profile falls linearly from
  // n_b at the top-layer centres to 0 one spacing above, crossing n_b/2 exactly at the top of the top layer's cells
  const tent = y0 => { let w = 0; for (const y of ys) { const u = Math.abs(y - y0) / S; if (u < 1) w += 1 - u } return w / (A * S) }
  let half = NaN, prevY = top + 2 * S, prevD = tent(prevY)
  for (let y0 = prevY - S / 64; y0 > y85 - 2 * S; y0 -= S / 64) {
    const dns = tent(y0)
    if (dns >= 0.5 * nb) { half = y0 + (prevY - y0) * (dns - 0.5 * nb) / (dns - prevD); break }   // linear interpolation
    prevY = y0; prevD = dns
  }
  return { inRegion: ys.length, top, y85, nbOverRest: nb * VP, half, equivalent }
}

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
const probe = async opts => ref.decodeProbe(await page.evaluate(o => window.__fluidBench.probe(o), opts))
try {
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665 }))

  // ── A: estimator on the known lattice ──
  await loadScenario(page, pool, 17)                       // frozen at frame 0
  await page.waitForTimeout(200)
  {
    const lo = 3 / GRID, size = BOX_MAX_M[1] / MPU
    const ny = Math.floor(size / S + 1e-9)
    const latticeTop = lo + (size - ny * S) / 2 + ny * S   // spawn.ts latticeBox: lattice centred in the box
    const e = estimate(await sample(page))
    report.estimatorOnLattice = { latticeTop, ...e, halfErrS: (e.half - latticeTop) / S, equivalentErrS: (e.equivalent - latticeTop) / S }
    gate.check(Math.abs(e.half - latticeTop) <= 0.1 * S, `A half-density estimator on the frame-0 lattice: ${e.half.toFixed(5)} wu vs the lattice top ${latticeTop.toFixed(5)} wu (${((e.half - latticeTop) / S).toFixed(3)} s; within 0.1 s) [equivalent-height estimator: ${((e.equivalent - latticeTop) / S).toFixed(3)} s]`)
  }

  // ── B: offset on the settled layer ──
  await page.evaluate(() => window.__fluidBench.setStepLimit(1200))
  await waitStepped(page, 1200, 600_000)
  await page.waitForTimeout(300)
  const est = estimate(await sample(page))
  const hSim = est.half
  report.sim = { ...est, hSim, spreadCm: (est.equivalent - est.half) * MPU * 100 }
  console.log(`  settled layer: half-density surface ${hSim.toFixed(5)} wu; equivalent-height ${est.equivalent.toFixed(5)} wu (${report.sim.spreadCm.toFixed(2)} cm apart); near-surface density ${est.nbOverRest.toFixed(3)} × rest`)

  const surfaceOffset = async (factor, view) => {
    const cam = view === 'top'
      ? { kind: 'orthographic', eye: [0.5, 2, 0.5], target: [0.5, 0, 0.5], up: [0, 0, -1], halfHeight: 0.6, near: 0.1, far: 5 }
      : { eye: [2, 1.5, 2], target: [0.5, 0.5, 0.5], fovDeg: 50 }
    const [w, h] = view === 'top' ? [800, 800] : [1280, 800]
    const r = await probe({ width: w, height: h, camera: cam, splatRadiusFactor: factor, sun: false, targets: ['depth'] })
    const fwd = [-r.view[2], -r.view[6], -r.view[10]]                  // camera forward (world): view row 2, negated
    let sum = 0, sum2 = 0, k = 0
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const ray = ref.pixelRay(r, px + 0.5, py + 0.5)
      const tS = (hSim - ray.o[1]) / ray.d[1]                          // where this ray meets the simulated surface
      const hx = ray.o[0] + tS * ray.d[0], hz = ray.o[2] + tS * ray.d[2]
      if (!(hx >= R0 + 0.02 && hx <= R1 - 0.02 && hz >= R0 + 0.02 && hz <= R1 - 0.02)) continue
      const d = r.t.depth[py * w + px]
      if (!(d > 0 && d < 1000)) continue
      const oEye = ref.mulMat4Vec4(r.view, [...ray.o, 1])
      const t = (d + oEye[2]) / (fwd[0] * ray.d[0] + fwd[1] * ray.d[1] + fwd[2] * ray.d[2])   // eye depth d along the ray
      const y = ray.o[1] + t * ray.d[1]
      sum += y; sum2 += y * y; k++
    }
    const mean = sum / k
    return { offsetWu: mean - hSim, offsetCm: (mean - hSim) * MPU * 100, roughnessCm: Math.sqrt(Math.max(0, sum2 / k - mean * mean)) * MPU * 100, pixels: k }
  }
  const results = new Map(FACTORS.map(f => [f, { factor: f, radiusCm: f * S * MPU * 100 }]))
  for (const f of FACTORS) {
    for (const view of ['top', 'oblique']) results.get(f)[view] = await surfaceOffset(f, view)
    const m = results.get(f)
    console.log(`  r = ${f.toFixed(3)} s (${m.radiusCm.toFixed(2)} cm): surface offset top ${m.top.offsetCm.toFixed(2)} cm, oblique ${m.oblique.offsetCm.toFixed(2)} cm; roughness ${m.top.roughnessCm.toFixed(2)} / ${m.oblique.roughnessCm.toFixed(2)} cm rms`)
  }

  // ── C: holes in FLUID TEST's own scene ──
  const holeFraction = r => {
    const w = r.rect.w, h = r.rect.h, D = r.t.depth
    const liquid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && D[y * w + x] > 0 && D[y * w + x] < 1000
    let liq = 0, holes = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (liquid(x, y)) { liq++; continue }
      const side = (dx, dy) => { for (let k = 1; k <= 4; k++) if (liquid(x + dx * k, y + dy * k)) return true; return false }
      if (side(1, 0) && side(-1, 0) && side(0, 1) && side(0, -1)) holes++
    }
    return { liquidPx: liq, holePx: holes, frac: holes / Math.max(1, liq + holes) }
  }
  for (const [label, frames] of [['falling block (frame 45)', 45], ['puddle (frame 600)', 600]]) {
    await page.evaluate(() => window.__fluidBench.setStepLimit(0))
    await page.evaluate(() => window.__fluidBench.action('defaultScene', 5))
    await page.evaluate(f => window.__fluidBench.setStepLimit(f), frames)
    await waitStepped(page, frames, 300_000)
    await page.waitForTimeout(200)
    for (const f of FACTORS) {
      const r = await probe({ splatRadiusFactor: f, sun: false, targets: ['depth'] })
      const hf = holeFraction(r)
      results.get(f)[label] = hf
      console.log(`  r = ${f.toFixed(3)} s, ${label}: holes ${(hf.frac * 100).toFixed(3)} % (${hf.holePx} of ${hf.liquidPx + hf.holePx} px)`)
    }
  }

  // ── decision and checks ──
  const passes = m => Math.abs(m.top.offsetWu) <= TOL && Math.abs(m.oblique.offsetWu) <= TOL
    && m['falling block (frame 45)'].frac <= HOLE_LIMIT && m['puddle (frame 600)'].frac <= HOLE_LIMIT
  report.radii = [...results.values()].map(m => ({ ...m, passes: passes(m) }))
  const passing = report.radii.filter(m => m.passes).map(m => m.factor)
  report.smallestPassing = passing.length ? Math.min(...passing) : null
  const dflt = (await probe({ targets: [], width: 1, height: 1 })).splatRadius / S
  report.defaultFactor = dflt
  console.log(`  radii passing both: ${passing.map(f => f.toFixed(3)).join(', ') || 'none'}; smallest ${report.smallestPassing?.toFixed(3)}; renderer default ${dflt.toFixed(3)}`)
  const d = [...results.values()].find(m => Math.abs(m.factor - dflt) < 1e-6)
  gate.check(!!d, `default splat radius ${dflt.toFixed(4)} s is among the measured radii`)
  if (d) {
    gate.check(Math.abs(d.top.offsetWu) <= TOL && Math.abs(d.oblique.offsetWu) <= TOL, `B default radius (${dflt.toFixed(3)} s): rendered surface − simulated = ${d.top.offsetCm.toFixed(2)} cm (top), ${d.oblique.offsetCm.toFixed(2)} cm (oblique); within ±${(TOL * MPU * 100).toFixed(2)} cm = 0.25 dx`)
    gate.check(d['falling block (frame 45)'].frac <= HOLE_LIMIT && d['puddle (frame 600)'].frac <= HOLE_LIMIT, `C default radius: holes ${(d['falling block (frame 45)'].frac * 100).toFixed(3)} % (falling block), ${(d['puddle (frame 600)'].frac * 100).toFixed(3)} % (puddle); ≤ ${HOLE_LIMIT * 100} %`)
  }
  const L = results.get(LEGACY)
  gate.check(Math.abs(L.top.offsetWu) > TOL && Math.abs(L.oblique.offsetWu) > TOL, `B positive control, legacy 0.025 wu splats: ${L.top.offsetCm.toFixed(2)} / ${L.oblique.offsetCm.toFixed(2)} cm above the simulated surface — rejected (r6 predicted 7.3 cm)`)
  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'r0-surface', pass, report, gate.results)
process.exit(pass ? 0 : 1)
