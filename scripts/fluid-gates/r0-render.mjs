#!/usr/bin/env node
// Gate R0 — physically based fluid rendering: r6-render.md §7 acceptance tests V1–V4, V6, the metal (mercury) gate,
// EXTENDED-ROADMAP OPT-1-s, and a sun-flux check, on the REAL composite pass (window.__fluidBench.probe renders an
// offscreen frame with a test camera and reads the targets back; nothing goes through a screenshot).
//
//   node scripts/fluid-gates/r0-render.mjs            (FLUID_BASE selects the server, as for every gate)
//
// Expected values come from scripts/fluid-gates/lib/opticsRef.mjs — an independent re-implementation over the same
// verbatim source files — and are cross-checked against r6's published Python numbers. Tolerances are fixed here,
// before any run, and are never widened to pass. Every test has a POSITIVE CONTROL: a deliberately wrong input
// (wrong IOR, no absorption, wrong particle volume, …) that the same check must reject.
//
// C  CPU: the reference reproduces r6 (n_D, F at 0/60/80°, white through 0.25 m / 1 m / 3.63 m / 10 m of water),
//    and the renderer's closed-form conductor Fresnel (src/fluid-render/optics/fresnel.ts) equals complex arithmetic.
// V1 Fresnel: still water slab, uniform white sky over a black floor → pixel = F(θ) exactly; centre pixel at 0°, 60°,
//    80° incidence: |F_render − F_exact| ≤ 1 % of F, and the 8-bit pixel = the encoded exact value ± 1.
// V2 Beer–Lambert over a white floor under a black sky → pixel = (1 − F)·T(ℓ); 0.25 m and 1.00 m: 8-bit ± 2/255.
//    OPT-1-s: 10 m and 30 m within 5/255.
// V3 thickness integral: a still block of N particles, orthographic top view, Σ thickness·pixel area = N·V_p ± 5 %,
//    at the default splat radius AND at the legacy 0.025 radius (independent of the splat size).
// V4 apparent depth: default camera at 1280×800 over a flat layer 0.30 wu and 0.05 wu deep, a marker on the floor at
//    the Snell hit of the ray through the surface centre (0.5, h, 0.5): its image centroid within 1 px of where Snell
//    puts it, and the shift from its dry position = r6's ray-trace (41.2 px, 6.4 px) ± 1 px.
// V6 no liquid → output bit-identical to the background (every non-fluid pixel of the page scene; the olive void =
//    #b1b366 = (177,179,102)); and a vacuum layer (n = 1, no absorption) in a uniform environment round-trips
//    bit-identically through the whole fluid path (decode → shade → encode).
// M  mercury: normal-incidence reflectance per channel = Inagaki n, k integrated over D65 (± 2/255 against a uniform
//    white sky); zero transmission: a black vs a red floor under the pool gives bit-identical mercury pixels.
// S  sun: the sun's image reflected in still water carries flux F·π (the disc radiance π/Ω☉ integrated over its
//    image) ± 5 %; the number of lit pixels against a 4.65 mrad disc is reported (rim pixels are partly lit).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, makeGate, writeReport, loadScenario, sample, waitStepped } from '../lib/fluid-page.mjs'
import * as ref from './lib/opticsRef.mjs'
import { loadTsModules } from './lib/loadTs.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE R0 (physically based fluid render)')
const report = {}
const deg = d => d * Math.PI / 180
const MPU = 3.63                           // metres per world unit (src/fluid-engine/units.ts DOMAIN_L_M)
const WATER = 0, MERCURY = 4               // CompositionTable default ids
const N_WATER = ref.waterN(0.5893)

// ── C: CPU reference checks ──────────────────────────────────────────────────────────────────────────────
{
  const F = d => ref.fresnelDielectric(Math.cos(deg(d)), 1, N_WATER)
  const c1 = [Math.abs(N_WATER - 1.33335) < 5e-6, Math.abs(((N_WATER - 1) / (N_WATER + 1)) ** 2 - 0.02041) < 5e-6,
    Math.abs(F(0) - 0.02041) < 5e-6, Math.abs(F(60) - 0.05976) < 5e-5, Math.abs(F(80) - 0.34803) < 5e-5]
  gate.check(c1.every(Boolean), `C1 reference: n(589.3 nm) = ${N_WATER.toFixed(5)}, F = ${F(0).toFixed(5)} / ${F(60).toFixed(5)} / ${F(80).toFixed(5)} at 0/60/80° (r6: 1.33335; 0.02041 / 0.05976 / 0.34803)`)
  const r6 = [[0.25, [247, 254, 255]], [1, [223, 250, 255]], [3.63, [150, 236, 254]], [10, [0, 204, 251]]]
  const got = r6.map(([L]) => ref.waterT(L).map(ref.to8))
  report.cpuWhiteThroughWater = r6.map(([L], i) => ({ L, rgb8: got[i] }))
  gate.check(r6.every(([, exp], i) => got[i].every((v, ch) => v === exp[ch])),
    `C2 reference: white through 0.25 / 1 / 3.63 / 10 m of water = ${got.map(v => `(${v})`).join(' ')} (r6 render_calc.py: (247,254,255) (223,250,255) (150,236,254) (0,204,251))`)
  const { fr } = await loadTsModules({ fr: 'src/fluid-render/optics/fresnel.ts' })
  let worstC = 0, worstD = 0
  for (let l = 360; l <= 830; l += 10) {
    const [n, k] = ref.mercuryNk(l)
    for (let i = 0; i <= 200; i++) {
      const c = i / 200
      worstC = Math.max(worstC, Math.abs(fr.fresnelConductor(c, n, k) - ref.fresnelConductorComplex(c, n, k)))
      worstD = Math.max(worstD, Math.abs(fr.fresnelDielectric(c, 1, N_WATER) - ref.fresnelDielectric(c, 1, N_WATER)))
    }
  }
  report.fresnelFormDiff = { conductor: worstC, dielectric: worstD }
  gate.check(worstC < 1e-12 && worstD < 1e-12, `C3 renderer Fresnel (fresnel.ts) = independent evaluation: conductor closed form vs complex arithmetic max |Δ| = ${worstC.toExponential(2)}, dielectric ${worstD.toExponential(2)} (Hg n,k over 360–830 nm, 201 angles; ≤ 1e-12)`)
  // positive control: a wrong k must show up
  const [n5, k5] = ref.mercuryNk(550)
  gate.check(Math.abs(fr.fresnelConductor(1, n5, 0) - ref.fresnelConductorComplex(1, n5, k5)) > 0.1, 'C3 positive control: k = 0 changes Hg normal reflectance by > 0.1 (the comparison can fail)')
}

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
const probe = async opts => ref.decodeProbe(await page.evaluate(o => window.__fluidBench.probe(o), opts))
const at = (r, key, x, y, ch = 4) => { const i = ((y - r.rect.y) * r.rect.w + (x - r.rect.x)) * ch; return Array.from(r.t[key].subarray(i, i + ch)) }
/** Incidence angle (rad) on a horizontal surface of the ray through pixel (x, y)'s centre. */
const incidence = (r, x, y) => Math.acos(-ref.pixelRay(r, x + 0.5, y + 0.5).d[1])
/** A camera whose centre ray meets the point `p` at incidence θ (from the vertical) in the x–y plane. */
const camAt = (thetaDeg, p, dist = 1, fovDeg = 20) => {
  const s = Math.sin(deg(thetaDeg)), c = Math.cos(deg(thetaDeg))
  return { eye: [p[0] + s * dist, p[1] + c * dist, p[2]], target: p, up: thetaDeg === 0 ? [0, 0, -1] : [0, 1, 0], fovDeg }
}
const W = 320, H = 200, CX = W / 2, CY = H / 2
const centreRect = { x: CX - 2, y: CY - 2, w: 4, h: 4 }   // the 4×4 pixels around the exact centre ray
const white = [1, 1, 1], black = [0, 0, 0]

try {
  await page.evaluate(() => window.__fluidBench.setStepLimit(0))   // freeze the page's own scene

  // ── V1 Fresnel ──────────────────────────────────────────────────────────────────────────────────────────
  const v1check = (r, label) => {
    let worstRel = 0, worst8 = 0
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
      const F = ref.fresnelDielectric(Math.cos(incidence(r, x, y)), 1, N_WATER)
      const lin = at(r, 'linear', x, y), c8 = at(r, 'color', x, y)
      for (let ch = 0; ch < 3; ch++) {
        worstRel = Math.max(worstRel, Math.abs(lin[ch] - F) / F)
        worst8 = Math.max(worst8, Math.abs(c8[ch] - ref.to8(F)))
      }
    }
    return { label, worstRel, worst8, F: at(r, 'linear', CX, CY)[0], Fexact: ref.fresnelDielectric(Math.cos(incidence(r, CX, CY)), 1, N_WATER), ok: worstRel <= 0.01 && worst8 <= 1 }
  }
  report.v1 = []
  for (const th of [0, 60, 80]) {
    const r = await probe({ width: W, height: H, camera: camAt(th, [0.5, 0.2, 0.5]), slab: { surfaceY: 0.2, compId: WATER }, env: { mode: 'uniform', sky: white, floor: black }, sun: false, hideParticles: true, targets: ['color', 'linear'], rect: centreRect })
    const v = v1check(r, `${th}°`)
    report.v1.push(v)
    gate.check(v.ok, `V1 Fresnel at ${th}°: rendered F = ${v.F.toFixed(5)} vs exact ${v.Fexact.toFixed(5)}; worst |ΔF|/F ${(v.worstRel * 100).toFixed(3)} % (≤ 1 %), worst 8-bit Δ ${v.worst8} (≤ 1) over the centre 4×4`)
  }
  {
    const r = await probe({ width: W, height: H, camera: camAt(0, [0.5, 0.2, 0.5]), slab: { surfaceY: 0.2, compId: WATER }, env: { mode: 'uniform', sky: white, floor: black }, sun: false, hideParticles: true, material: { compId: WATER, kind: 0, ior: 1.5, lutRow: 0 }, targets: ['color', 'linear'], rect: centreRect })
    const v = v1check(r, 'control n=1.5')
    report.v1control = v
    gate.check(!v.ok, `V1 positive control: IOR 1.5 instead of water's → rendered F ${v.F.toFixed(4)} is rejected (worst rel ${(v.worstRel * 100).toFixed(0)} %)`)
  }

  // ── V2 Beer–Lambert + OPT-1-s ──────────────────────────────────────────────────────────────────────────
  const n = N_WATER
  const v2check = (r, Lm, tol8) => {
    let worst8 = 0, worstLin = 0
    const Tt = new Map()
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
      const ci = Math.cos(incidence(r, x, y))
      const ct = Math.sqrt(1 - (1 - ci * ci) / (n * n))
      const path = Lm / ct                                          // refracted path, surface → floor
      const key = path.toFixed(7)
      if (!Tt.has(key)) Tt.set(key, ref.waterT(path))
      const F = ref.fresnelDielectric(ci, 1, n)
      const exp = Tt.get(key).map(t => (1 - F) * t)
      const lin = at(r, 'linear', x, y), c8 = at(r, 'color', x, y)
      for (let ch = 0; ch < 3; ch++) {
        worst8 = Math.max(worst8, Math.abs(c8[ch] - ref.to8(exp[ch])))
        worstLin = Math.max(worstLin, Math.abs(lin[ch] - exp[ch]))
      }
    }
    return { Lm, rendered8: at(r, 'color', CX, CY).slice(0, 3), whiteT8: ref.waterT(Lm).map(ref.to8), worst8, worstLin, ok: worst8 <= tol8 }
  }
  report.v2 = []
  for (const [Lm, tol8, name] of [[0.25, 2, 'V2'], [1.0, 2, 'V2'], [10, 5, 'OPT-1-s'], [30, 5, 'OPT-1-s']]) {
    const sY = Lm / MPU
    const r = await probe({ width: W, height: H, camera: camAt(0, [0.5, sY, 0.5]), slab: { surfaceY: sY, compId: WATER }, env: { mode: 'uniform', sky: black, floor: white }, sun: false, hideParticles: true, targets: ['color', 'linear'], rect: centreRect })
    const v = v2check(r, Lm, tol8)
    report.v2.push(v)
    gate.check(v.ok, `${name} white floor through ${Lm} m of water: rendered (${v.rendered8}) vs expected (1−F)·T; worst 8-bit Δ ${v.worst8} (≤ ${tol8}), worst linear Δ ${v.worstLin.toExponential(1)} [white·T alone = (${v.whiteT8})]`)
  }
  {
    const sY = 1 / MPU
    const r = await probe({ width: W, height: H, camera: camAt(0, [0.5, sY, 0.5]), slab: { surfaceY: sY, compId: WATER }, env: { mode: 'uniform', sky: black, floor: white }, sun: false, hideParticles: true, material: { compId: WATER, kind: 0, ior: N_WATER, lutRow: -1 }, targets: ['color', 'linear'], rect: centreRect })
    const v = v2check(r, 1.0, 2)
    report.v2control = v
    gate.check(!v.ok, `V2 positive control: water with NO absorption over 1 m → (${v.rendered8}) is rejected (worst Δ ${v.worst8})`)
  }

  // ── V3 thickness integral ──────────────────────────────────────────────────────────────────────────────
  {
    const scenario = { name: 'r0-v3-block', materials: [], gravity_mps2: 9.80665,
      spawns: [{ material: 'Water', box: { min: [1.0, 1.2, 1.1], max: [1.9, 1.7, 2.0] } }] }
    await loadScenario(page, scenario, 3)          // frozen at frame 0 (setStepLimit(0)): the lattice as spawned
    await page.waitForTimeout(200)
    const s = await sample(page)
    // the running solver's rest packing: 4 ppc on the legacy MPM, 8 on the incompressible solver (V_p = dx³/ppc)
    const ppc = (await page.evaluate(() => window.__fluidBench.status())).solver === 'mpm' ? 4 : 8
    const Vp = 1 / (64 ** 3 * ppc)
    const cam = { kind: 'orthographic', eye: [0.5, 2.0, 0.5], target: [0.5, 0, 0.5], up: [0, 0, -1], halfHeight: 0.6, near: 0.1, far: 5 }
    const V3W = 1000, V3H = 1000
    const areaPx = (2 * 0.6 / V3H) ** 2
    const integral = async (extra) => {
      const r = await probe({ width: V3W, height: V3H, camera: cam, targets: ['thickness'], sun: false, ...extra })
      let sum = 0
      for (const t of r.t.thickness) sum += t
      return { measuredM3: sum * areaPx * MPU * MPU, radius: r.splatRadius, volume: r.particleVolume, shape: r.splatShape }
    }
    const expectedM3 = s.n * Vp * MPU ** 3
    report.v3 = { n: s.n, expectedM3, runs: [] }
    for (const [label, extra] of [['default splats', {}], ['spheres, default radius', { splatShape: 'sphere' }], ['spheres, legacy radius 0.025 wu', { splatShape: 'sphere', splatRadiusFactor: 0.025 / Math.cbrt(Vp) }]]) {
      const m = await integral(extra)
      const ratio = m.measuredM3 / expectedM3
      report.v3.runs.push({ label, ...m, ratio })
      gate.check(Math.abs(ratio - 1) <= 0.05, `V3 thickness integral, ${label} (${m.shape === 'aniso' ? 'ellipsoids' : `r = ${m.radius.toFixed(5)} wu`}): Σ t·dA = ${m.measuredM3.toFixed(4)} m³ vs N·V_p = ${expectedM3.toFixed(4)} m³ (N = ${s.n}); ratio ${ratio.toFixed(4)} (1 ± 0.05)`)
    }
    const c = await integral({ particleVolume: 2 * Vp })
    report.v3.control = { ...c, ratio: c.measuredM3 / expectedM3 }
    gate.check(Math.abs(c.measuredM3 / expectedM3 - 1) > 0.05, `V3 positive control: renderer told V_p × 2 → ratio ${(c.measuredM3 / expectedM3).toFixed(3)} is rejected`)
  }

  // ── V4 apparent depth ──────────────────────────────────────────────────────────────────────────────────
  {
    const cam = { eye: [2, 1.5, 2], target: [0.5, 0.5, 0.5], fovDeg: 50 }
    const VW = 1280, VH = 800
    const red = [1, 0, 0]
    report.v4 = []
    const centroid = r => {
      let sx = 0, sy = 0, k = 0
      for (let y = 0; y < r.rect.h; y++) for (let x = 0; x < r.rect.w; x++) {
        const i = (y * r.rect.w + x) * 4, L = r.t.linear
        if (L[i] - L[i + 1] > 0.3 && L[i] - L[i + 2] > 0.3) { sx += r.rect.x + x + 0.5; sy += r.rect.y + y + 0.5; k++ }
      }
      return k ? [sx / k, sy / k, k] : [NaN, NaN, 0]
    }
    for (const [h, r6px] of [[0.30, 41.2], [0.05, 6.4]]) {
      // geometry from the probe's own matrices (identical camera for every probe below)
      const geo = await probe({ width: VW, height: VH, camera: cam, hideParticles: true, sun: false, targets: [], rect: { x: 0, y: 0, w: 1, h: 1 } })
      const camPos = ref.mulMat4Vec4(geo.invView, [0, 0, 0, 1]).slice(0, 3)
      const S = [0.5, h, 0.5]
      const d0 = S.map((v, i) => v - camPos[i]); const dn = Math.hypot(...d0); const dv = d0.map(v => v / dn)
      const eta = 1 / N_WATER, ci = dv[1] * -1
      const k = 1 - eta * eta * (1 - ci * ci)
      const t = dv.map((v, i) => eta * v + (eta * ci - Math.sqrt(k)) * [0, 1, 0][i])
      const B = S.map((v, i) => v + (-h / t[1]) * t[i])          // Snell hit on the floor
      const pS = ref.project(geo, S), pB = ref.project(geo, B)
      const shiftAnalytic = Math.hypot(pS[0] - pB[0], pS[1] - pB[1])
      const rect = { x: Math.round(Math.min(pS[0], pB[0])) - 40, y: Math.round(Math.min(pS[1], pB[1])) - 40, w: Math.round(Math.abs(pS[0] - pB[0])) + 80, h: Math.round(Math.abs(pS[1] - pB[1])) + 80 }
      const marker = { x: B[0], z: B[2], radius: 0.02, color: red }
      const wet = await probe({ width: VW, height: VH, camera: cam, slab: { surfaceY: h, compId: WATER }, marker, sun: false, hideParticles: true, targets: ['linear'], rect })
      const dry = await probe({ width: VW, height: VH, camera: cam, marker, sun: false, hideParticles: true, targets: ['linear'], rect })
      const ctrl = await probe({ width: VW, height: VH, camera: cam, slab: { surfaceY: h, compId: WATER }, marker, sun: false, hideParticles: true, material: { compId: WATER, kind: 0, ior: 1.0, lutRow: 0 }, targets: ['linear'], rect })
      const cw = centroid(wet), cd = centroid(dry), cc = centroid(ctrl)
      const eWet = Math.hypot(cw[0] - pS[0], cw[1] - pS[1]), eDry = Math.hypot(cd[0] - pB[0], cd[1] - pB[1])
      const shift = Math.hypot(cw[0] - cd[0], cw[1] - cd[1])
      const eCtrl = Math.hypot(cc[0] - pS[0], cc[1] - pS[1])
      report.v4.push({ h, pS, pB, shiftAnalytic, r6px, wet: cw, dry: cd, shift, eWet, eDry, control: cc, eCtrl })
      gate.check(Math.abs(shiftAnalytic - r6px) <= 0.1, `V4 geometry (${h} wu): analytic Snell shift ${shiftAnalytic.toFixed(2)} px reproduces r6's ${r6px} px (± 0.1)`)
      gate.check(eDry <= 1 && eWet <= 1 && Math.abs(shift - r6px) <= 1,
        `V4 apparent depth under ${h} wu: marker image ${eWet.toFixed(2)} px from the Snell prediction (≤ 1), dry image ${eDry.toFixed(2)} px from its projection (≤ 1); rendered shift ${shift.toFixed(2)} px vs ${r6px} px (± 1) [${cw[2]} / ${cd[2]} marker px]`)
      gate.check(eCtrl > 1, `V4 positive control (${h} wu): IOR 1.0 → marker ${eCtrl.toFixed(1)} px from the Snell image, rejected`)
    }
  }

  // ── V6 linear-light round trip ─────────────────────────────────────────────────────────────────────────
  {
    await page.evaluate(() => window.__fluidBench.action('defaultScene', 5))   // the page's own water block
    await page.evaluate(() => window.__fluidBench.setStepLimit(40))
    await waitStepped(page, 40)
    const r = await probe({ targets: ['color', 'bg', 'depth'] })
    let fluid = 0, diff = 0
    for (let i = 0; i < r.t.depth.length; i++) {
      const d = r.t.depth[i]
      if (d > 0 && d < 1000) { fluid++; continue }
      for (let ch = 0; ch < 4; ch++) if (r.t.color[4 * i + ch] !== r.t.bg[4 * i + ch]) { diff++; break }
    }
    const corner = at(r, 'color', 0, 0)
    report.v6a = { pixels: r.t.depth.length, fluid, nonFluidMismatch: diff, voidPixel: corner }
    gate.check(fluid > 1000 && diff === 0 && corner[0] === 177 && corner[1] === 179 && corner[2] === 102,
      `V6 page scene ${r.width}×${r.height}: ${diff} of ${r.t.depth.length - fluid} non-fluid pixels differ from the background (must be 0; ${fluid} fluid pixels); void = (${corner.slice(0, 3)}) = #b1b366 (177,179,102)`)

    const olive = [0.694, 0.702, 0.400].map(ref.srgbDecode)
    const vac = async (ior, lutRow) => probe({ width: W, height: H, camera: camAt(30, [0.5, 0.2, 0.5], 1, 40), slab: { surfaceY: 0.2, compId: WATER }, env: { mode: 'uniform', sky: white, floor: olive }, sun: false, hideParticles: true, material: { compId: WATER, kind: 0, ior, lutRow }, targets: ['color', 'bg', 'depth'] })
    const cmp = r => { let px = 0, bad = 0; for (let i = 0; i < r.t.depth.length; i++) { if (!(r.t.depth[i] > 0)) continue; px++; for (let ch = 0; ch < 3; ch++) if (r.t.color[4 * i + ch] !== r.t.bg[4 * i + ch]) { bad++; break } } return { px, bad } }
    const a = cmp(await vac(1.0, -1)), c = cmp(await vac(N_WATER, -1))
    report.v6b = { vacuum: a, control: c }
    gate.check(a.px > 1000 && a.bad === 0, `V6 vacuum layer (n = 1, no absorption) under a white sky over an olive floor: ${a.bad} of ${a.px} liquid pixels differ from the background (must be 0)`)
    gate.check(c.bad > 0.5 * c.px, `V6 positive control: n = 1.333 in the same scene reflects the white sky → ${c.bad} of ${c.px} pixels differ (detected)`)
  }

  // ── M mercury ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const mcheck = r => {
      let worst8 = 0, worstLin = 0
      for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
        const R = ref.mercuryR(Math.cos(incidence(r, x, y)))
        const lin = at(r, 'linear', x, y), c8 = at(r, 'color', x, y)
        for (let ch = 0; ch < 3; ch++) { worst8 = Math.max(worst8, Math.abs(c8[ch] - ref.to8(R[ch]))); worstLin = Math.max(worstLin, Math.abs(lin[ch] - R[ch])) }
      }
      return { rendered8: at(r, 'color', CX, CY).slice(0, 3), renderedLin: at(r, 'linear', CX, CY).slice(0, 3), expected: ref.mercuryR(Math.cos(incidence(r, CX, CY))), worst8, worstLin, ok: worst8 <= 2 }
    }
    const hg = (floor, compId = MERCURY, material) => probe({ width: W, height: H, camera: camAt(0, [0.5, 0.2, 0.5]), slab: { surfaceY: 0.2, compId }, env: { mode: 'uniform', sky: white, floor }, sun: false, hideParticles: true, material, targets: ['color', 'linear'], rect: centreRect })
    const m = mcheck(await hg(black))
    report.mercury = { ...m, sampled: [450, 550, 650].map(l => { const [nn, k] = ref.mercuryNk(l); return { l, n: nn, k, R: ((nn - 1) ** 2 + k * k) / ((nn + 1) ** 2 + k * k) } }) }
    gate.check(m.ok, `M mercury at normal incidence under a white sky: rendered (${m.rendered8}) = linear (${m.renderedLin.map(v => v.toFixed(4))}) vs Inagaki n,k over D65 (${m.expected.map(v => v.toFixed(4))}) = (${m.expected.map(ref.to8)}); worst 8-bit Δ ${m.worst8} (≤ 2)`)
    const redA = await hg(black), redB = await hg([1, 0, 0])
    const same = redA.t.color.every((v, i) => v === redB.t.color[i]) && redA.t.linear.every((v, i) => v === redB.t.linear[i])
    const wA = await hg(black, WATER), wB = await hg([1, 0, 0], WATER)
    const waterDiff = wA.t.color.some((v, i) => v !== wB.t.color[i])
    report.mercuryOpaque = { mercuryIdentical: same, waterDiffers: waterDiff }
    gate.check(same, 'M zero transmission: a red floor under the mercury pool changes no mercury pixel (bit-identical to a black floor)')
    gate.check(waterDiff, 'M positive control: the same red floor DOES show through a water pool of the same depth')
    const ctrl = mcheck(await hg(black, MERCURY, { compId: MERCURY, kind: 0, ior: 1.33, lutRow: -1 }))
    report.mercuryControl = ctrl
    gate.check(!ctrl.ok, `M positive control: mercury rendered as a dielectric (n = 1.33) → (${ctrl.rendered8}) is rejected`)
  }

  // ── S sun disc reflected in still water ────────────────────────────────────────────────────────────────
  {
    const s = [0.3, 1, 0.6]; const sn = Math.hypot(...s); const sun = s.map(v => v / sn)
    const P = [0.5, 0.2, 0.5], D = 1.2
    const cam = { eye: [P[0] - D * sun[0], P[1] + D * sun[1], P[2] - D * sun[2]], target: P, fovDeg: 8 }
    const SW = 400, SH = 400
    const r = await probe({ width: SW, height: SH, camera: cam, slab: { surfaceY: 0.2, compId: WATER }, env: { mode: 'uniform', sky: black, floor: black }, sun: true, hideParticles: true, targets: ['linear'] })
    let flux = 0, lit = 0
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const L = r.t.linear[(y * SW + x) * 4]
      if (L <= 0) continue
      lit++
      // solid angle of pixel (x, y): |d(ray)/dx × d(ray)/dy|
      const a = ref.pixelRay(r, x, y + 0.5).d, b = ref.pixelRay(r, x + 1, y + 0.5).d, c = ref.pixelRay(r, x + 0.5, y).d, e = ref.pixelRay(r, x + 0.5, y + 1).d
      const dx = b.map((v, i) => v - a[i]), dy = e.map((v, i) => v - c[i])
      const om = Math.hypot(dx[1] * dy[2] - dx[2] * dy[1], dx[2] * dy[0] - dx[0] * dy[2], dx[0] * dy[1] - dx[1] * dy[0])
      flux += L * om
    }
    const F = ref.fresnelDielectric(sun[1], 1, N_WATER)
    const expected = F * Math.PI
    const pxAngle = 2 * Math.tan(deg(4)) / SH
    const discPx = Math.PI * (Math.asin(6.957e8 / 149597870700) / pxAngle) ** 2
    report.sun = { flux, expected, F, litPixels: lit, discPixelsExpected: discPx }
    gate.check(Math.abs(flux / expected - 1) <= 0.05, `S sun image in still water: flux Σ L·Ω = ${flux.toExponential(4)} vs F·π = ${expected.toExponential(4)} (ratio ${(flux / expected).toFixed(4)}, 1 ± 0.05); ${lit} lit pixels vs a 4.65 mrad disc ≈ ${discPx.toFixed(0)} px`)
  }

  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'r0-render', pass, report, gate.results)
process.exit(pass ? 0 : 1)
