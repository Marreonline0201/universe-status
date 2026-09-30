#!/usr/bin/env node
// Gate OPT-2a — the sun's in-scatter, deep-water colour and the optics gates (vault fluid/realism-2026-09/OPT-2a-spec.md
// §4) on the REAL composite pass (window.__fluidBench.probe renders an offscreen frame and reads the targets back) and the
// renderer's own precompute (window.__fluidBench.optics(): optics/materials.ts, waterScattering.ts, qaa.ts as the page
// ships them). Expected values come from lib/opticsRef.mjs — an independent port over the same verbatim source files —
// never from the renderer's TypeScript. Tolerances are fixed here, before any run, and are never widened to pass; every
// test has a positive control that the same check must reject. "Reported (subsumed)" checks print ✓/✗ like any other
// but cannot fail unless a gated check fails (they keep the roadmap's numbers visible).
//
//   node scripts/fluid-gates/opt2a-render.mjs            (FLUID_BASE selects the server, as for every gate)
//
// OC1–OC4  CPU: the reference reproduces the spec's offline values — Zhang b_w at 400–700 nm (5 s.f.); R_rs(450), π·R_rs,rgb
//          and Y (5 / 4 / 4 s.f.); the single-scattering reference's deep limit β/(c(μs + μv)) and its S_rgb identity; the
//          §4.4 centre table (4 s.f.); naturalWater.validateConstituents with two must-fail controls.
// V7       apparent depth 5° off nadir under 0.9 and 0.3 wu: (ρ/tanα_wet − H)/h = cosα/√(n² − sin²α) ± 0.5 %, the dry
//          marker within 0.1 px of its projection; 0.750 ± 1 % reported (subsumed); controls IOR 1.0 and 1.36.
// V9       white and grey furnace (sun off, deep off, in-scatter on; a non-absorbing record carrying the scatter row and
//          R_rs): |C − L0| ≤ 1e-4·L0 on every liquid pixel of the linear target; controls absorption on, deep on at a = 0,
//          and the sun on (a sensitivity demonstration).
// V17      deep-water colour: rendered = R_rs,rgb(reference) × the gate's own E_d, |Δ| ≤ 1e-5·|ref_B| (black and white
//          sky); Y = 0.27 % ± 10 % and B > R > G reported (subsumed); controls b_b = b, the r6 fit triple, Hale & Querry.
// V18      a: 255·|enc(L₁) − enc(L₀)| ≤ 1 step over visible liquid over the tank (room, 0.35 m, three cameras, brightness
//          1 and 0.2; the unbounded slab's far field outside the tank is reported, not gated — see the V18a note below);
//          live: the page's default adds Δ_B > 0 on every visible non-glint liquid pixel, a record without a scatter row
//          adds exactly 0; b: black uniform scene, Δ = the reference per pixel within 0.5 % (4 cameras × 0.35 / 3.63 m);
//          controls ×n², ×100 (V18a; V18b linear), thin and isotropic references.
// OPT-2a-c optics(): R_rs(450) = the reference's to 1e-9 and 8.0856e-3 sr⁻¹ to 5 s.f.; R_rs,rgb to 1e-9·|B|; the scatter
//          row to 1e-9·|B|; the constants by value; five wrong-input controls through optics() itself.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, makeGate, writeReport } from '../lib/fluid-page.mjs'
import * as ref from './lib/opticsRef.mjs'
import { loadTsModules } from './lib/loadTs.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE OPT-2a (in-scatter, deep-water colour, optics)')
const report = { notes: [] }
const note = msg => { console.log(`  · ${msg}`); report.notes.push(msg) }
const deg = d => d * Math.PI / 180
const MPU = 3.63                           // metres per world unit (src/fluid-engine/units.ts DOMAIN_L_M)
const WATER = 0                            // CompositionTable default id
const N_WATER = ref.waterN(0.5893)
// the page's sun, built as R0's gate S builds it (r0-render.mjs): normalize(0.3, 1, 0.6) — the gate's own E_d uses it
const SUN = (() => { const s = [0.3, 1, 0.6], n = Math.hypot(...s); return s.map(v => v / n) })()
const MU_SUN = SUN[1]
const black = [0, 0, 0], white = [1, 1, 1]
/** v equals e to n significant figures: |v − e| ≤ half a unit in e's n-th figure. */
const sf = (v, e, n) => Math.abs(v - e) <= 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(e))) - n + 1)
const fmt = (v, p = 4) => v.map(x => x.toExponential(p)).join(', ')

// ── OC: CPU reference checks ─────────────────────────────────────────────────────────────────────────────
const R450 = ref.qaaRrs(ref.waterA(450), ref.zhangB(450).b / 2)
const RRS_REF = ref.waterRrsRgb()
{
  const table = [[400, 5.0386e-3], [450, 3.0499e-3], [500, 1.9575e-3], [550, 1.3150e-3], [600, 9.1636e-4], [650, 6.5819e-4], [700, 4.8494e-4]]
  const got = table.map(([l]) => ref.zhangB(l).b)
  report.oc1 = table.map(([l, e], i) => ({ l, b: got[i], spec: e }))
  gate.check(table.every(([, e], i) => sf(got[i], e, 5)), `OC1 reference b_w (Zhang, Hu & He 2009 code, 20 °C, S = 0, δ = 0.039) at 400…700 nm = ${fmt(got)} 1/m (spec §2.2 table to 5 s.f.)`)

  const a = ref.waterA(450), bb = ref.zhangB(450).b / 2, u = bb / (a + bb), rr = (0.089 + 0.125 * u) * u
  const trip = (R450 / (0.52 + 1.7 * R450)) / rr - 1
  const pi = RRS_REF.map(v => Math.PI * v)
  const Y = ref.luminanceY(pi), Ys = ref.spectralY(l => Math.PI * ref.qaaRrs(ref.waterA(l), ref.zhangB(l).b / 2))
  report.oc2 = { R450, u, rrs: rr, roundTrip: trip, piRrsRgb: pi, Y, Yspectral: Ys }
  gate.check(sf(R450, 8.0856e-3, 5) && Math.abs(trip) <= 1e-12, `OC2 reference R_rs(450) = ${R450.toExponential(5)} sr⁻¹ (u = ${u.toFixed(6)}; spec 8.0856e-3 to 5 s.f.); QAA_v5 Eq. 2 round trip ${trip.toExponential(1)} (≤ 1e-12)`)
  gate.check(sf(pi[0], 1.2726e-3, 4) && sf(pi[1], -1.4243e-4, 4) && sf(pi[2], 3.4965e-2, 4) && sf(100 * Y, 0.2692, 4) && Math.abs(Y / Ys - 1) <= 1e-12,
    `OC2 reference π·R_rs,rgb = (${fmt(pi)}) (spec 1.2726e-3, −1.4243e-4, 3.4965e-2 to 4 s.f.); Y = ${(100 * Y).toFixed(5)} % (spec 0.2692 %; the spectral route agrees to ${Math.abs(Y / Ys - 1).toExponential(1)})`)

  // deep limit of the SS reference = SSA Eq. (15) at ζ = 0 (ω₀ × Eq. 11): β/(c(μs + μv)) per unit E_d(0−) = E_w·μs
  const g = ref.ssGeometry([0, -1, 0], SUN, N_WATER)
  const i450 = ref.WAVELENGTHS.indexOf(450)
  const deep = ref.ssSpectrum(g, 1e6)[i450] / g.muS
  const zb = ref.zhangB(450), C = (1 - 0.039) / (1 + 0.039)
  const closed = zb.beta90 * (1 + C * g.cosPsi ** 2) / ((ref.waterA(450) + zb.b) * (g.muS + g.muV))
  // the S_rgb identity: E_w·(β/b)(ψ)·ℓ·S_rgb(ℓ·k) = the direct per-wavelength sum (V4 camera's centre ray, 0.35 m)
  const dV4 = (() => { const e = [2, 1.5, 2], t = [0.5, 0.5, 0.5], d = t.map((v, k) => v - e[k]), n = Math.hypot(...d); return d.map(v => v / n) })()
  const gv = ref.ssGeometry(dV4, SUN, N_WATER), ell = 0.35 / gv.muV, k = 1 + gv.muV / gv.muS
  const pOverB = (1 + C * gv.cosPsi ** 2) * 3 * (1 + 0.039) / (8 * Math.PI * (2 + 0.039))
  const viaS = ref.scatterRowRef(ell * k).map(v => gv.exit * Math.PI * gv.ewPerEsun * pOverB * ell * v)
  const direct = ref.scatterRef(dV4, SUN, 0.35, N_WATER)
  const idErr = Math.max(...viaS.map((v, ch) => Math.abs(v / direct[ch] - 1)))
  report.oc3 = { deep, closed, idErr }
  gate.check(Math.abs(deep / closed - 1) <= 1e-9 && sf(closed, 0.013970, 5) && idErr <= 1e-12,
    `OC3 SS reference: deep limit at 450 nm, nadir = ${deep.toPrecision(8)} per unit E_d(0−) vs β/(c(μs + μv)) = ${closed.toPrecision(8)} (≤ 1e-9; spec 0.013970); S_rgb identity vs the direct sum ${idErr.toExponential(1)} (≤ 1e-12)`)

  // the §4.4 centre table: the reference at each camera's exact centre ray, against the values the spec's table was
  // rounded from (its revise_calc.py output, 5 s.f.) — the printed 4 s.f. table double-rounds one entry (V4, 0.35 m, B:
  // 2.43947e-4 → 2.4395e-4 → "2.440e-4"; once-rounded it is 2.439e-4), which failed a 4 s.f. comparison on the first run
  // (2026-09-30 03:25) by 5.3e-8 against a half-unit of 5e-8: the comparison moved to the source values, one figure tighter
  const table44 = { 'nadir|0.35': [3.2029e-5, 7.6605e-5, 1.8706e-4], 'nadir|3.63': [8.2377e-5, 6.6461e-4, 1.8789e-3], 'V4|0.35': [4.0824e-5, 9.9631e-5, 2.4395e-4], 'V4|3.63': [7.6556e-5, 8.3895e-4, 2.4363e-3],
    'toward-sun|0.35': [2.6118e-5, 6.3576e-5, 1.5561e-4], 'toward-sun|3.63': [5.1135e-5, 5.3738e-4, 1.5552e-3], 'side|0.35': [3.2377e-5, 7.8814e-5, 1.9291e-4], 'side|3.63': [6.3391e-5, 6.6617e-4, 1.9280e-3] }
  let ok44 = true
  report.oc3table = {}
  for (const D of [0.35, 3.63]) for (const c of v18bCameras(D / MPU)) {
    const d = c.camera.target.map((v, k) => v - c.camera.eye[k]), n = Math.hypot(...d)
    const v = ref.scatterRef(d.map(x => x / n), SUN, D, N_WATER), t = table44[`${c.name}|${D}`]
    report.oc3table[`${c.name}|${D}`] = v
    ok44 &&= v.every((x, ch) => sf(x, t[ch], 5))
  }
  gate.check(ok44, 'OC3 SS reference at the four V18b cameras\' centre rays × 0.35 / 3.63 m reproduces the spec §4.4 table\'s source values (24 values to 5 s.f.)')

  const { nw } = await loadTsModules({ nw: 'src/fluid-render/optics/naturalWater.ts' })
  const pure = nw.validateConstituents(nw.NATURAL_WATER_PRESETS.pure)
  const humic = nw.validateConstituents(nw.NATURAL_WATER_PRESETS.humic)
  let unsourcedThrows = false
  try { nw.validateConstituents({ ...nw.NATURAL_WATER_PRESETS.humic, ag443PerM: 0.5 }) } catch { unsourcedThrows = true }
  const sOut = nw.validateConstituents({ ...nw.NATURAL_WATER_PRESETS.humic, ag443PerM: 0.5, sgPerNm: 0.03, source: 'positive control (not a measurement)' })
  const warned = sOut.unverified.some(m => /S_g = 0\.03/.test(m))
  report.oc4 = { pure, humic, unsourcedThrows, sOut }
  gate.check(pure.resolvesToPure && pure.usable && pure.unverified.length === 0 && humic.resolvesToPure && humic.unverified.some(m => /ED-32/.test(m)),
    `OC4 naturalWater: 'pure' validates (resolves to pure water, usable, nothing flagged); the unfilled 'humic' resolves to pure water with "${humic.unverified[0]}"`)
  gate.check(unsourcedThrows && warned, `OC4 positive controls: a set a_g(443) with no source is rejected (${unsourcedThrows ? 'threw' : 'NOT rejected'}); S_g = 0.03 nm⁻¹ with a source is flagged (${warned ? sOut.unverified.find(m => /S_g/.test(m)) : 'NO warning'})`)
}

/** The four V18b cameras (spec §4.4): nadir, V4's, toward the sun at 60° and 90° from its azimuth at 60°. */
function v18bCameras(sY) {
  return [
    { name: 'nadir', camera: { eye: [0.5, sY + 1, 0.5], target: [0.5, sY, 0.5], up: [0, 0, -1], fovDeg: 20 } },
    { name: 'V4', camera: { eye: [2, 1.5, 2], target: [0.5, 0.5, 0.5], fovDeg: 50 } },
    { name: 'toward-sun', camera: { eye: [0.1127, sY + 0.5, -0.2746], target: [0.5, sY, 0.5], fovDeg: 20 } },
    { name: 'side', camera: { eye: [1.2746, sY + 0.5, 0.1127], target: [0.5, sY, 0.5], fovDeg: 20 } },
  ]
}

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
const probe = async opts => ref.decodeProbe(await page.evaluate(o => window.__fluidBench.probe(o), opts))
const optics = opts => page.evaluate(o => window.__fluidBench.optics(o), opts ?? {})
const at = (r, key, x, y, ch = 4) => { const i = ((y - r.rect.y) * r.rect.w + (x - r.rect.x)) * ch; return Array.from(r.t[key].subarray(i, i + ch)) }
const incidence = (r, x, y) => Math.acos(-ref.pixelRay(r, x + 0.5, y + 0.5).d[1])
const camAt = (thetaDeg, p, dist = 1, fovDeg = 20) => {
  const s = Math.sin(deg(thetaDeg)), c = Math.cos(deg(thetaDeg))
  return { eye: [p[0] + s * dist, p[1] + c * dist, p[2]], target: p, up: thetaDeg === 0 ? [0, 0, -1] : [0, 1, 0], fovDeg }
}
const W = 320, H = 200, CX = W / 2, CY = H / 2
const centreRect = { x: CX - 2, y: CY - 2, w: 4, h: 4 }
const rect64 = { x: CX - 32, y: CY - 32, w: 64, h: 64 }
const EPS_BG = Math.fround(1e-4)
/** Visible liquid, exactly as the composite decides it (ssfr_composite.wgsl shade): valid depth (0 < d < 1000) and the
 *  background not in front (bgDepth + 1e-4 < depth, in f32). */
const visible = (r, i) => { const d = r.t.depth[i]; return d > 0 && d < 1000 && !(Math.fround(r.t.bgDepth[i] + EPS_BG) < d) }

try {
  await page.evaluate(() => window.__fluidBench.setStepLimit(0))   // freeze the page's own scene
  const opt = await optics()
  report.optics = opt
  const SCAT = opt.scatterRowIndex

  // ── OPT-2a-c: the renderer's own precompute against the reference ─────────────────────────────────────────
  {
    const relR = opt.rrs / R450 - 1
    const c = opt.constants
    const constOk = c.g0 === 0.089 && c.g1 === 0.125 && c.t === 0.52 && c.gamma === 1.7 && c.delta === 0.039 && c.tempC === 20 && c.salinity === 0 && c.kB === 1.3806503e-23 && c.kelvinOffset === 273.15
    gate.check(opt.shipped && Math.abs(relR) <= 1e-9 && Math.abs(opt.rrs - 8.0856e-3) <= 5e-8 && constOk,
      `OPT-2a-c renderer R_rs(450) = ${opt.rrs.toExponential(6)} sr⁻¹ vs the reference ${R450.toExponential(6)} (rel ${relR.toExponential(1)}, ≤ 1e-9; 8.0856e-3 ± 5e-8); constants g0 ${c.g0}, g1 ${c.g1}, ${c.t}, ${c.gamma}, δ ${c.delta}, ${c.tempC} °C, S ${c.salinity}, k_B ${c.kB}, ${c.kelvinOffset} ${constOk ? '= the sourced values' : 'DIFFER from the sourced values'}`)
    const dRgb = Math.max(...opt.rrsRgb.map((v, ch) => Math.abs(v - RRS_REF[ch]))) / Math.abs(RRS_REF[2])
    gate.check(dRgb <= 1e-9, `OPT-2a-c renderer R_rs,rgb (the water record's) = (${fmt(opt.rrsRgb, 5)}) vs the reference (${fmt(RRS_REF, 5)}): max |Δ| ${dRgb.toExponential(1)}·|B| (≤ 1e-9)`)
    let worstS = 0
    opt.scatterRow.x.forEach((x, k) => { const r = ref.scatterRowRef(x); worstS = Math.max(worstS, ...opt.scatterRow.rgb[k].map((v, ch) => Math.abs(v - r[ch]) / Math.abs(r[2]))) })
    const dB = Math.max(...opt.bRgb.map((v, ch) => Math.abs(v - ref.scatterRowRef(0)[ch]))) / Math.abs(ref.scatterRowRef(0)[2])
    gate.check(worstS <= 1e-9 && dB <= 1e-9 && SCAT >= 0, `OPT-2a-c renderer scatter row S_rgb(x) at x = ${opt.scatterRow.x.join(', ')} m vs the reference: max |Δ| ${worstS.toExponential(1)}·|S_B| (≤ 1e-9); B_rgb (${fmt(opt.bRgb)}) ${dB.toExponential(1)}; LUT row ${SCAT}`)
    // positive controls: the renderer's own functions with wrong inputs must miss the reference by more than 1e-9
    const controls = [['Hale & Querry a(λ)', { absorption: 'hale-querry' }, -68.0], ['δ = 0.051', { delta: 0.051 }, 2.14], ['a = 0.0002 m⁻¹ flat', { absorption: { flatPerM: 0.0002 } }, 1520], ['QAA_v6 g₁ = 0.1245', { g: [0.089, 0.1245] }, -0.068], ['T = 25 °C', { tempC: 25 }, -0.118]]
    report.opt2acControls = []
    for (const [label, o, expPct] of controls) {
      const r = await optics(o)
      const rel = r.rrs / R450 - 1
      report.opt2acControls.push({ label, rrs: r.rrs, relPct: 100 * rel, expectedPct: expPct })
      gate.check(!(Math.abs(rel) <= 1e-9), `OPT-2a-c positive control ${label}: R_rs(450) ${r.rrs.toExponential(5)} is ${(100 * rel).toFixed(3)} % off (spec ${expPct} %) → rejected`)
    }
  }

  // ── V7 apparent depth ─────────────────────────────────────────────────────────────────────────────────────
  {
    const VW = 1280, VH = 800, HE = 1, ALPHA = deg(5)
    const target = ref.sagittalRatio(ALPHA, N_WATER)
    const centroid = r => {
      let sx = 0, sy = 0, k = 0
      for (let y = 0; y < r.rect.h; y++) for (let x = 0; x < r.rect.w; x++) {
        const i = (y * r.rect.w + x) * 4, L = r.t.linear
        if (L[i] - L[i + 1] > 0.3 && L[i] - L[i + 2] > 0.3) { sx += r.rect.x + x + 0.5; sy += r.rect.y + y + 0.5; k++ }
      }
      return k ? [sx / k, sy / k, k] : [NaN, NaN, 0]
    }
    report.v7 = []
    for (const h of [0.9, 0.3]) {
      const cam = camAt(0, [0.5, h, 0.5], HE, 20)
      const st = Math.sin(ALPHA) / N_WATER
      const rho = HE * Math.tan(ALPHA) + h * st / Math.sqrt(1 - st * st)      // the 5° ray's Snell floor hit, from x = 0.5
      const marker = { x: 0.5 + rho, z: 0.5, radius: 0.02, color: [1, 0, 0] }
      const geo = await probe({ width: VW, height: VH, camera: cam, hideParticles: true, noBall: true, sun: false, targets: [], rect: { x: 0, y: 0, w: 1, h: 1 } })
      const pM = ref.project(geo, [0.5 + rho, 0, 0.5])                        // the dry marker's projection
      const pS = ref.project(geo, [0.5 + HE * Math.tan(ALPHA), h, 0.5])        // where the 5° ray meets the surface
      const rect = { x: Math.round(Math.min(pM[0], pS[0])) - 60, y: Math.round(Math.min(pM[1], pS[1])) - 60, w: Math.round(Math.abs(pM[0] - pS[0])) + 120, h: Math.round(Math.abs(pM[1] - pS[1])) + 120 }
      const shot = (ior, wet) => probe({ width: VW, height: VH, camera: cam, ...(wet ? { slab: { surfaceY: h, compId: WATER } } : {}), marker, sun: false, hideParticles: true, noBall: true,
        material: { compId: WATER, kind: 0, ior, lutRow: -1 }, targets: ['linear'], rect })
      const ratioOf = c => { const a = Math.acos(-ref.pixelRay(geo, c[0], c[1]).d[1]); return { alphaDeg: a * 180 / Math.PI, ratio: (rho / Math.tan(a) - HE) / h } }
      const cw = centroid(await shot(N_WATER, true)), cd = centroid(await shot(N_WATER, false))
      const eDry = Math.hypot(cd[0] - pM[0], cd[1] - pM[1])
      const w = ratioOf(cw)
      const c1 = ratioOf(centroid(await shot(1.0, true))), c136 = ratioOf(centroid(await shot(1.36, true)))
      const within = (v, t, tol) => Math.abs(v / t - 1) <= tol
      report.v7.push({ h, rho, target, wet: cw, dry: cd, eDry, ...w, controlIor1: c1, controlIor136: c136, pS })
      gate.check(within(w.ratio, target, 0.005) && eDry <= 0.1 && cw[2] > 100,
        `V7 apparent depth under ${h} wu at 5°: (ρ/tanα_wet − H)/h = ${w.ratio.toFixed(5)} (α_wet ${w.alphaDeg.toFixed(4)}°) vs cosα/√(n² − sin²α) = ${target.toFixed(5)} (± 0.5 %: ${(100 * (w.ratio / target - 1)).toFixed(3)} %); dry marker ${eDry.toFixed(3)} px from its projection (≤ 0.1) [${cw[2]} / ${cd[2]} marker px]`)
      gate.check(within(w.ratio, 0.75, 0.01), `V7 reported (subsumed): ratio ${w.ratio.toFixed(5)} = 0.750 ± 1 % (paraxial 1/n = ${(1 / N_WATER).toFixed(6)}; the roadmap's number, valid only at small angles)`)
      gate.check(!within(c1.ratio, target, 0.005) && !within(c136.ratio, target, 0.005) && !within(c136.ratio, 0.75, 0.01),
        `V7 positive controls (${h} wu): IOR 1.0 → ratio ${c1.ratio.toFixed(4)}, IOR 1.36 → ${c136.ratio.toFixed(5)} (spec 0.73400; ${(100 * (c136.ratio / target - 1)).toFixed(2)} %) — both rejected, 1.36 also by the 0.750 ± 1 % band`)
    }
  }

  // ── V9 furnace ────────────────────────────────────────────────────────────────────────────────────────────
  {
    const furnaceMat = { compId: WATER, kind: 0, ior: N_WATER, lutRow: -1, scatRow: SCAT, rrs: opt.rrsRgb, hasDeep: true }
    const R0 = ref.qaaRrs(0, 1)                                                // u = 1: π·R_rs = 0.5495, an invented glow
    const furnace = async (thetaDeg, sY, L0, extra = {}) => {
      const r = await probe({ width: W, height: H, camera: camAt(thetaDeg, [0.5, sY, 0.5]), slab: { surfaceY: sY, compId: WATER }, env: { mode: 'uniform', sky: [L0, L0, L0], floor: [L0, L0, L0] },
        sun: false, hideParticles: true, noBall: true, material: furnaceMat, inScatter: 1, targets: ['linear', 'depth', 'bgDepth'], ...extra })
      let px = 0
      const worst = [0, 0, 0], signed = [0, 0, 0]
      for (let i = 0; i < r.t.depth.length; i++) {
        if (!visible(r, i)) continue
        px++
        for (let ch = 0; ch < 3; ch++) { const e = r.t.linear[4 * i + ch] - L0; if (Math.abs(e) > worst[ch]) { worst[ch] = Math.abs(e); signed[ch] = e } }
      }
      return { thetaDeg, sY, L0, px, worst, signed, ok: px > 1000 && worst.every(w => w <= 1e-4 * L0) }
    }
    report.v9 = []
    for (const L0 of [1.0, 0.5]) for (const sY of [0.2, 1.0]) for (const th of [0, 60, 80]) {
      const v = await furnace(th, sY, L0)
      report.v9.push(v)
      gate.check(v.ok, `V9 furnace L0 = ${L0}, slab ${sY} wu, camera ${th}°: max |C − L0| = (${fmt(v.worst, 1)}) over ${v.px} liquid pixels (≤ 1e-4·L0 = ${(1e-4 * L0).toExponential(0)}, linear target)`)
    }
    const absorb = await furnace(0, 1.0, 1.0, { material: { ...furnaceMat, lutRow: 0 } })
    const deep0 = await furnace(0, 1.0, 1.0, { material: { ...furnaceMat, rrs: [R0, R0, R0] }, deep: true })
    const sunA = await furnace(0, 1.0, 1.0, { sun: true }), sunB = await furnace(0, 1.0, 0.5, { sun: true })
    report.v9controls = { absorb, deep0, sunL1: sunA, sunL05: sunB }
    gate.check(!absorb.ok, `V9 positive control (i): absorption on (LUT row 0, 1.0 wu) → max |C − L0| = (${fmt(absorb.worst, 2)}) → rejected`)
    gate.check(!deep0.ok, `V9 positive control (iii): deep on with R_rs from a = 0 (π·R_rs = ${(Math.PI * R0).toFixed(4)}) → max |C − L0| = (${fmt(deep0.worst, 3)}) → rejected`)
    const lateB = sunB.worst.every(w => w > 1e-4 * 0.5)
    gate.check(!sunA.ok && !sunB.ok && sunA.worst[1] > 1e-4 && sunA.worst[2] > 1e-4 && lateB,
      `V9 sensitivity (ii): the sun on adds the real in-scatter, C − L0 = (${fmt(sunA.signed, 2)}) at L0 = 1 (spec ≈ 8.2e-5, 6.6e-4, 1.9e-3 at the nadir centre) → rejected on G and B; at L0 = 0.5 on all three (${fmt(sunB.worst, 2)})`)
  }

  // ── V17 deep-water colour ─────────────────────────────────────────────────────────────────────────────────
  {
    const Ed = sky => sky.map(v => Math.PI * v + Math.PI * MU_SUN)      // the gate's own E_d(0+) (E_sun = π; sun toward SUN)
    const shot = (sky, material) => probe({ width: W, height: H, camera: camAt(0, [0.5, 0.2, 0.5]), slab: { surfaceY: 0.2, compId: WATER }, env: { mode: 'uniform', sky, floor: black },
      sun: true, deep: true, hideParticles: true, noBall: true, ...(material ? { material } : {}), targets: ['linear'], rect: centreRect })
    const code = (r, sky, rrs) => {
      const E = Ed(sky), exp = rrs.map((v, ch) => v * E[ch]), tol = 1e-5 * Math.abs(exp[2])
      let worst = 0
      for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
        const F = ref.fresnelDielectric(Math.cos(incidence(r, x, y)), 1, N_WATER), L = at(r, 'linear', x, y)
        for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(L[ch] - (F * sky[ch] + exp[ch])))
      }
      return { exp, worst, tol, ok: worst <= tol }
    }
    const model = r => {
      const pi = [0, 1, 2].map(ch => { let s = 0; for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) s += at(r, 'linear', x, y)[ch]; return s / (r.rect.w * r.rect.h) / MU_SUN })
      const Y = ref.luminanceY(pi)
      return { piRrs: pi, Y, inBand: Math.abs((100 * Y) / 0.27 - 1) <= 0.1, violetBlue: pi[2] > pi[0] && pi[0] > pi[1] }   // Y in % within 0.27 ± 10 %
    }
    const a = await shot(black), b = await shot(white)
    const ca = code(a, black, RRS_REF), cb = code(b, white, RRS_REF)
    const m = model(a)
    report.v17 = { a: ca, b: cb, model: m }
    gate.check(ca.ok, `V17-code (a) black sky: rendered = R_rs,rgb × E_d, E_d = π·μ☉ = ${(Math.PI * MU_SUN).toFixed(5)} (the gate's own): expected (${fmt(ca.exp)}) (spec 1.0569e-3, −1.1828e-4, 2.9037e-2); worst |Δ| ${ca.worst.toExponential(1)} (≤ 1e-5·|B| = ${ca.tol.toExponential(1)})`)
    gate.check(cb.ok, `V17-code (b) white sky: rendered − F(θ) = R_rs,rgb × (π + π·μ☉): expected (${fmt(cb.exp)}); worst |Δ| ${cb.worst.toExponential(1)} (≤ ${cb.tol.toExponential(1)})`)
    gate.check(m.inBand && m.violetBlue, `V17-model reported (subsumed): rendered π·R_rs = (${fmt(m.piRrs)}), Y = ${(100 * m.Y).toFixed(4)} % (the roadmap's 0.27 % ± 10 %); B > R > G ${m.violetBlue ? 'holds' : 'FAILS'} (an elastic-model property; Raman would make B > G > R)`)
    const hq = ref.waterRrsRgb({ absorption: ref.haleA }), hqPi = hq.map(v => Math.PI * v), hqY = ref.luminanceY(hqPi)
    note(`V17 report only — Hale & Querry absorption: π·R_rs = (${fmt(hqPi)}), Y = ${(100 * hqY).toFixed(4)} % (spec 0.2260 %), ${hqPi[2] > hqPi[1] && hqPi[1] > hqPi[0] ? 'B > G > R' : 'order differs'}`)
    const fitA = [0.306, 0.047, 0.0002], fitRrs = [650, 550, 450].map((l, ch) => ref.qaaRrs(fitA[ch], ref.zhangB(l).b / 2))
    const ctrl = [['b_b = b', ref.waterRrsRgb({ bbOverB: 1 }), false], ['the r6 1 m fit triple per channel', fitRrs, false], ['Hale & Querry', hq, true]]
    report.v17controls = []
    for (const [label, rrs, hue] of ctrl) {
      const r = await shot(black, { compId: WATER, kind: 0, ior: N_WATER, lutRow: 0, scatRow: SCAT, rrs, hasDeep: true })
      const c = code(r, black, RRS_REF), mm = model(r)
      report.v17controls.push({ label, rrs, code: c, model: mm })
      gate.check(!c.ok && !(mm.inBand && mm.violetBlue) && (!hue || !mm.violetBlue), `V17 positive control ${label}: rendered π·R_rs = (${fmt(mm.piRrs, 3)}), Y ${(100 * mm.Y).toFixed(4)} % → V17-code rejects (|Δ| ${c.worst.toExponential(1)}), V17-model rejects${hue ? `, hue ${mm.violetBlue ? 'NOT rejected' : 'rejected'}` : ''}`)
    }
  }

  // ── V18 in-scatter in the tank ────────────────────────────────────────────────────────────────────────────
  {
    const D = 0.35, sY = D / MPU
    const roomCams = [['page', undefined], ['V4', { eye: [2, 1.5, 2], target: [0.5, 0.5, 0.5], fovDeg: 50 }], ['nadir', camAt(0, [0.5, sY, 0.5])]]
    const room = (camera, brightness, extra) => probe({ width: 1280, height: 800, ...(camera ? { camera } : {}), slab: { surfaceY: sY, compId: WATER }, sun: true, hideParticles: true, noBall: true, brightness, ...extra })
    const enc = v => ref.srgbEncode(Math.min(1, Math.max(0, v)))
    // V18a's domain is the visible liquid over the tank's footprint: the analytic slab stands in for the tank's water, and
    // is unbounded. First run (2026-09-30 03:25, working tree): the V4/page camera failed at 9.2 steps — every failing pixel
    // at 85–90° incidence on the horizon, 14–362 wu outside a 1 wu tank, where the screen-space normal of the unbounded
    // layer breaks down and inflates the path and (1 − F) (rendered Δ/reference up to 2857×); over the tank the rendered
    // term equals the reference (Δ/ref = 1.000 at every sampled pixel, 0.157 steps). The far field is reported below, not
    // gated; V18-live keeps every visible pixel.
    const st = await page.evaluate(() => window.__fluidBench.status())
    const TANK = (st.tank?.cells ?? [64, 64, 64]).map(c => c / 64)    // the tank spans [0, cells/64] world units per axis
    const tankMask = r => {
      const m = new Uint8Array(r.width * r.height)
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
        const ray = ref.pixelRay(r, x + 0.5, y + 0.5)
        if (!(ray.d[1] < 0)) continue
        const t = (sY - ray.o[1]) / ray.d[1], hx = ray.o[0] + t * ray.d[0], hz = ray.o[2] + t * ray.d[2]
        m[y * r.width + x] = hx >= 0 && hx <= TANK[0] && hz >= 0 && hz <= TANK[2] ? 1 : 0
      }
      return m
    }
    const stepStats = (base, on, mask, want = 1) => {
      let maxStep = 0, maxD8 = 0, maxLin = 0, glint = 0, px = 0
      for (let i = 0; i < base.t.depth.length; i++) {
        if (!visible(base, i) || mask[i] !== want) continue
        px++
        let g = false
        for (let ch = 0; ch < 3; ch++) {
          const l0 = base.t.linear[4 * i + ch], l1 = on.t.linear[4 * i + ch]
          if (l0 > 1) g = true
          maxStep = Math.max(maxStep, 255 * Math.abs(enc(l1) - enc(l0)))
          maxLin = Math.max(maxLin, Math.abs(l1 - l0))
          maxD8 = Math.max(maxD8, Math.abs(on.t.color[4 * i + ch] - base.t.color[4 * i + ch]))
        }
        if (g) glint++
      }
      return { px, maxStep, maxD8, maxLin, glint }
    }
    report.v18a = []; report.v18live = []; report.tank = TANK
    const masks = new Map()
    for (const [name, camera] of roomCams) for (const brightness of [1.0, 0.2]) {
      const base = await room(camera, brightness, { inScatter: 0, targets: ['color', 'linear', 'depth', 'bgDepth'] })
      const on = await room(camera, brightness, { inScatter: 1, targets: ['color', 'linear'] })
      if (!masks.has(name)) masks.set(name, tankMask(base))
      const s = stepStats(base, on, masks.get(name)), far = stepStats(base, on, masks.get(name), 0)
      report.v18a.push({ camera: name, brightness, ...s, outsideTank: far })
      gate.check(s.px > 1000 && s.maxStep <= 1, `V18a ${name} camera, brightness ${brightness}: max continuous step change ${s.maxStep.toFixed(3)} (≤ 1) over ${s.px} visible liquid pixels over the tank; integer |Δ8| ≤ ${s.maxD8}; max linear Δ ${s.maxLin.toExponential(2)}; ${s.glint} glint pixels (L > 1: the clip hides any change)`)
      if (far.px) note(`V18a ${name} camera, brightness ${brightness}, the unbounded slab OUTSIDE the tank (not gated): ${far.px} px, max step ${far.maxStep.toFixed(2)}, max linear Δ ${far.maxLin.toExponential(2)} — the screen-space normal at grazing incidence (a pre-existing SSFR limit the term inherits)`)
      const def = await room(camera, brightness, { targets: ['linear'] })       // the page's default: no inScatter override
      let live = 0, dead = 0, glint = 0, same = true
      for (let i = 0; i < base.t.depth.length; i++) {
        for (let ch = 0; ch < 4 && same; ch++) if (def.t.linear[4 * i + ch] !== on.t.linear[4 * i + ch]) same = false
        if (!visible(base, i)) continue
        const l0 = base.t.linear.subarray(4 * i, 4 * i + 3)
        if (l0[0] > 1 || l0[1] > 1 || l0[2] > 1) { glint++; continue }
        if (def.t.linear[4 * i + 2] - l0[2] > 0) live++; else dead++
      }
      report.v18live.push({ camera: name, brightness, live, dead, glint, defaultEqualsOne: same })
      gate.check(live > 1000 && dead === 0, `V18-live ${name} camera, brightness ${brightness}: the page's default adds Δ_B > 0 on ${live} of ${live + dead} visible non-glint liquid pixels (must be all; ${glint} glint pixels not gated); default ${same ? '=' : '≠'} inScatter 1 bit for bit`)
    }
    // negative control: a record with no scatter row (as ethanol's and glycerol's) adds exactly 0 everywhere
    report.v18none = []
    for (const [name, camera] of roomCams) {
      const mat = { compId: WATER, kind: 0, ior: N_WATER, lutRow: 0 }
      const d1 = await room(camera, 1.0, { material: mat, targets: ['linear'] }), d0 = await room(camera, 1.0, { material: mat, inScatter: 0, targets: ['linear'] })
      let diff = 0
      for (let i = 0; i < d1.t.linear.length; i++) if (d1.t.linear[i] !== d0.t.linear[i]) diff++
      report.v18none.push({ camera: name, diff })
      gate.check(diff === 0, `V18-live negative control, ${name} camera: a water record with no scatter row → ${diff} of ${d1.t.linear.length} linear values change with the term on (must be 0)`)
    }
    {
      const base = await room(roomCams[2][1], 1.0, { inScatter: 0, targets: ['color', 'linear', 'depth', 'bgDepth'] })
      const x100 = await room(roomCams[2][1], 1.0, { inScatter: 100, targets: ['color', 'linear'] })
      const s = stepStats(base, x100, masks.get('nadir'))
      report.v18aControl = s
      gate.check(!(s.maxStep <= 1), `V18a positive control: in-scatter × 100 (nadir, brightness 1) → max step change ${s.maxStep.toFixed(2)} (spec ≈ 6.5 blue steps) → rejected`)
    }

    // V18b: the black uniform scene, the rendered Δ against the reference per pixel
    const tol = (m, r) => {   // per channel: 0.5 % of the reference; absolute 0.5 % of |ref_B| near red's zero crossing
      let worst = 0
      for (let ch = 0; ch < 3; ch++) {
        const scale = Math.abs(r[ch]) < 0.1 * Math.abs(r[2]) ? Math.abs(r[2]) : Math.abs(r[ch])
        worst = Math.max(worst, Math.abs(m[ch] - r[ch]) / scale)
      }
      return worst
    }
    const v18b = async (camera, sY2, inScatter) => probe({ width: W, height: H, camera, slab: { surfaceY: sY2, compId: WATER }, env: { mode: 'uniform', sky: black, floor: black }, sun: true, hideParticles: true, noBall: true, inScatter, targets: ['linear', 'depth', 'bgDepth'], rect: rect64 })
    const compare = (r1, r0, D2, scale = 1, opts = {}) => {
      let worst = 0, px = 0, notLiquid = 0
      const cRef = ref.scatterRef(ref.pixelRay(r1, CX + 0.5, CY + 0.5).d, SUN, D2, N_WATER, opts)
      for (let y = r1.rect.y; y < r1.rect.y + r1.rect.h; y++) for (let x = r1.rect.x; x < r1.rect.x + r1.rect.w; x++) {
        const i = (y - r1.rect.y) * r1.rect.w + (x - r1.rect.x)
        if (!visible(r1, i)) { notLiquid++; continue }
        px++
        const d = ref.pixelRay(r1, x + 0.5, y + 0.5).d
        const rv = ref.scatterRef(d, SUN, D2, N_WATER, opts).map(v => scale * v)
        const m = [0, 1, 2].map(ch => r1.t.linear[4 * i + ch] - r0.t.linear[4 * i + ch])
        worst = Math.max(worst, tol(m, rv))
      }
      const ci = (CY - r1.rect.y) * r1.rect.w + (CX - r1.rect.x)
      return { px, notLiquid, worst, centre: [0, 1, 2].map(ch => r1.t.linear[4 * ci + ch] - r0.t.linear[4 * ci + ch]), centreRef: cRef.map(v => scale * v) }
    }
    report.v18b = []
    const renders = []
    for (const D2 of [0.35, 3.63]) for (const c of v18bCameras(D2 / MPU)) {
      const r1 = await v18b(c.camera, D2 / MPU, 1), r0 = await v18b(c.camera, D2 / MPU, 0)
      const v = compare(r1, r0, D2)
      renders.push({ c, D2, r1, r0 })
      report.v18b.push({ camera: c.name, D: D2, thicknessFormat: r1.thicknessFormat, ...v })
      gate.check(v.px === 64 * 64 && v.worst <= 0.005, `V18b ${c.name} camera, ${D2} m: rendered Δ = the SS reference per pixel over ${v.px} px, worst ${(100 * v.worst).toFixed(3)} % (≤ 0.5 %); centre (${fmt(v.centre, 3)}) vs (${fmt(v.centreRef, 3)}) [thickness ${r1.thicknessFormat}]`)
    }
    // positive controls: × n² (the n² law left out) must be rejected; × 100 must match 100 × the reference (linear)
    let n2rejected = 0
    for (const c of v18bCameras(0.35 / MPU)) {
      const rn = await v18b(c.camera, 0.35 / MPU, 1.7778), r0 = renders.find(q => q.c.name === c.name && q.D2 === 0.35).r0
      if (compare(rn, r0, 0.35).worst > 0.005) n2rejected++
    }
    gate.check(n2rejected === 4, `V18b positive control (i): in-scatter × 1.7778 (= n_D², the n² law left out) rejected at ${n2rejected} of 4 cameras (0.35 m)`)
    {
      const c = v18bCameras(0.35 / MPU)[0]
      const r100 = await v18b(c.camera, 0.35 / MPU, 100), r0 = renders.find(q => q.c.name === 'nadir' && q.D2 === 0.35).r0
      const v = compare(r100, r0, 0.35, 100)
      report.v18bLinear = v
      gate.check(v.worst <= 0.005, `V18b linearity (ii): in-scatter × 100 matches 100 × the reference at nadir, 0.35 m: worst ${(100 * v.worst).toFixed(3)} % (≤ 0.5 %)`)
    }
    let thinRej = 0, isoRej = 0
    for (const q of renders) {
      if (compare(q.r1, q.r0, q.D2, 1, { thin: true }).worst > 0.005) thinRej++
      if (compare(q.r1, q.r0, q.D2, 1, { isotropic: true }).worst > 0.005) isoRej++
    }
    gate.check(thinRej === renders.length && isoRej === renders.length, `V18b positive control (iii): the reference with the thin form B_rgb·ℓ rejects ${thinRej} of ${renders.length} renders, with an isotropic phase function ${isoRej} of ${renders.length} (spec: +14.6 % red; −26 % at nadir, 0.35 m)`)
  }

  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'opt2a-render', pass, report, gate.results)
exitGate(pass ? 0 : 1)
