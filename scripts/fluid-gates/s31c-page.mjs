#!/usr/bin/env node
// Gate S3.1c — the incompressible solver behind the real FLUID TEST page (FINAL-PLAN §7 S3.1c: page wiring; the S3.1b
// checks re-run through the FLUID TEST route; render proof; FPS measured and recorded, not gated).
//
//   node scripts/fluid-gates/s31c-page.mjs     (default server: the clean gate tree; FLUID_BASE to override)
//
// Criteria (fixed before the first run). Lockstep clock, 1/60 s per frame; tank = the 64³ window, 3.63 m, floor at y = 0.
// P1 stillness (C5 through the page): a water pool (scenario box 3.63 × 0.17 × 3.63 m: the whole floor, so it starts at rest);
//    after 6 s the RMS particle speed ≤ 1 % √(gH), H = N·V_p / (3.63 m)² (V_p = dx³/8).
// P2 level: the pool's mean particle height after 6 s = H/2 within ±¼·dx (a flat pool of uniform density).
// B1 buoyancy order (the owner's check "oil floats, mercury sinks"): the same pool with an olive-oil block and a mercury
//    block released above it; after 8 s COM_y(mercury) < COM_y(water) < COM_y(oil), each gap ≥ ½·dx.
// B1c creaming, PHYSICS-DERIVED (owner decision 2026-09-29; replaces "≥ 90 % of the oil above the water's median at 8 s",
//    an unsourced threshold that 89–92 % runs straddled — vault research/x8-coalescence-b1: that is what physics gives for
//    the sim's ~1.6 mm drops). The set: at 4 s (the impact over) every DISPERSED oil particle (drift d > 0) below the
//    water's 8-s median height; its dilute part: cell oil fraction α < 0.3 (particle counts). The law: a drop SLIPS
//    through the water around it at U_eq(d, α), the equilibrium of the drift model's drag law (Schiller–Naumann,
//    Re·f(Re) = d³ρ_c|ρ_d − ρ_m|g/(18μ_m²), bisection — s35i-ref's independent oracle), ρ_m and Ishii–Zuber μ_m at α,
//    ρ and μ the page's own; it is the model's s = u_d − u_c (immiscible.wgsl slipParticles, MTK 1996's slip) — the
//    law's validated uncertainty ±10 % (1.04 vs the 0.9–1.0 cm/s front measured by Jeelani & Hartland 1998, via
//    Mousavi et al. 2024).
//    B1c-slip (validated): per dilute drop, its rise over 4 → 4.5 s minus the mean rise of the WATER particles that
//      shared its 4-s cell (the plume carries both, so it cancels), ÷ 0.5 s; the mean over the drops ÷ the mean of
//      U_eq(d, α) over the same drops = 1 ± 0.1, in each of B1C_RUNS runs (default 3; same seed, lockstep). Two-sided.
//    B1c-control (the checks' teeth): the same scene with the drift switched off (bench configure disableImmiscible):
//      its would-be-dispersed dilute oil (cell α < 0.3 at 4 s, below its own water median), each drop given the
//      drift-on runs' median d, goes through B1c-slip too and must land OUTSIDE its band (its slip ≈ 0).
//    B1c-spread: the slip ratio's run-to-run spread (max − min) ≤ the band's width 0.2 (a band narrower than the page's
//      own run-to-run noise would pass or fail by chance — the band is not widened, the check fails instead).
//    Reported, not gated (the end state is NOT predictable from the page's physics — it depends on the dense layer's
//      packing, r_V* unmeasured, and on the blob's plume, which moves dilute oil at ~2.4 cm/s with no drift at all): the
//      fraction of the set above the median at 8 s against the Kynch hindered march at ×0.9 (the no-convection
//      minimum; the march: the 4-s state, each drop rising in its own (x, z) column at (1 − α(t))·U_eq, α recounted
//      every 1/120 s, a drop stopping at its column's 4-s top), the control's fraction, and the lab-frame rise over
//      4 → 5 s against (1 − α)·U_eq. The oil in oil-majority cells (resolved, d = 0) and the mercury are reported.
//    History — three failed designs (each fixed its band before its one run; no band was widened): (1) each drop's α
//      frozen at 4 s, arrival by 8 s: 84.2 % vs 79.6–82.9 %, replaced for its slow bias; (2) the Kynch march as a
//      two-sided end prediction: 85.7 % vs 56.3–59.9 %; (3) the lab-frame rise over 4 → 5 s ≥ 0.9 × (1 − α)·U_eq plus
//      the end fraction inside [hindered march ×0.9, unhindered march ×1.1]: rise 2.7–2.9 × the law, end 87.3 / 85.0
//      above the bound in 2 of 3 runs — and the drift-off control rose at 0.99 × the law, i.e. it would have PASSED the
//      rate check: the lab-frame rise measures the plume, not the drift. A quiescent-batch law needs a convection-free
//      observable (the slip), and the negative control must go through every check.
//    First run of this design (2026-09-29, live checkout): slip × 1.442 / 1.377 / 1.237 of U_eq, spread 0.205; control
//      × −0.057 — the observable is clean, so the in-situ drift slips 24–44 % faster than its own equilibrium law: an
//      OPEN finding about the drift model (vault active-plan, B1c), not a reason to move this band.
//    Design change 4 (2026-09-29 evening, fixed before its run; the band is unchanged): the drift kernel's own inputs,
//      logged per drop (slipInputs), put the excess in its mixture density — the law with the kernel's inputs × 1.32–1.42
//      of U_eq, the model × 1.005–1.045 of that — because the scene's mercury (0.13 m³ over the floor: a 1 cm film,
//      thinner than a cell) sits in the bottom-row water cells, where the kernel counts it as dispersed and the drops feel
//      MTK's suspension density (a model limitation at a resolved interface, recorded in the vault, not changed here).
//      The law checked here is the OIL-IN-WATER law (Jeelani & Hartland's system), so B1c-slip's set is restricted to
//      the two-liquid drops: their kernel mixture holds no mercury — α_Hg = (ρ_m − (1 − α_d)ρ_w − α_d·ρ_o)/(ρ_Hg − ρ_o)
//      ≤ 1e-4 at BOTH samples (ρ_m, α_d the kernel's own, water the carrier). The drift-off control has no kernel inputs:
//      its drops qualify with no mercury particle in their own cell or the 26 around it at 4 s (the trilinear reach).
//      The unrestricted ratio stays in the INFO line.
//      Its run (clean tree d3450893): FAIL — slip × 1.127 / 1.514 / 1.529 over 1276 / 1324 / 1131 two-liquid drops, spread
//      0.40; the law with the kernel's inputs × 0.969–0.991 of U_eq (the mercury diagnosis holds), the model × 1.07–1.16
//      of its own law and the measured slip × 1.09–1.42 of the model's: a second gap (transport or this observable in a
//      still-convecting plume), OPEN — the band is not moved.
//    RE-SCOPE, REGISTERED 2026-09-29 19:12 BEFORE ANY E3/E6 DATA (the B1c synthesis memo's recommendation (a); vault
//      active-plan step 1; the arms study scripts/studies/b1c-arms.mjs was running, its output unread). For reasons that
//      do not depend on any E3/E6 result: (1) this observable does not measure the slip — per drop it measures A + B +
//      C + D (the model's slip, the drop–cohort difference of the resolved velocity, of J, and of the density
//      correction + RK2 terms); "the plume carries both, so it cancels" holds only for velocity uniform within a cell,
//      and near the floor it is trilinear with w = 0 on the floor face, the density correction a trilinear displacement,
//      and the height cut inside row 1; (2) the ±10 % band is a quiescent batch creaming front's (Jeelani & Hartland
//      1998 via Mousavi et al. 2024), not a decaying plume at 4 s (real drops in residual turbulence depart from their
//      quiescent slip by −8 % to −35 %: Fornari, Picano & Brandt 2016; Poorte & Biesheuvel 2002); (3) design change 4's
//      filter selects on the END of the window. Decided: design change 4's FAIL stays on record and the ±0.1 band is
//      unchanged. The successors, each with a control that must fail: B1c-T (gated) in-situ transport closure
//      Λ = Σ(Δy − Δt·v_y)/Σ Δt·u_V,y = 1 ± 0.02 per substep at the drops over [4, 4.5] s (control: J omitted → ≈ 1 − α,
//      outside); B1c-M (gated) in-situ replay exactness (≥ 99.9 % of dispersed drop-substeps |s_n − s_rep| ≤
//      1e-4·max(|s_n|, 1e-4 m/s); control: μ_w in place of μ_m fails); model / own law reported with its attribution; the
//      law-vs-reality physics check moves to E1 (a quiescent dispersion on the page, needs hooks H1 + H2 — H2 is an
//      owner decision); this slip ratio becomes REPORTED once B1c-T and B1c-M run here — until then B1c-slip stays gated
//      (and failing). Nothing here — band, window, height cut, subset — is to be tuned after the E3/E6 data.
//    REVISION, REGISTERED 2026-09-29 23:16 (the commit that adds it), BEFORE THE NEXT RUN — after the memo's adversarial
//      verification (workflow wf_90984d05-2b5, code and experiments lenses; vault research/b1c-arms-2026-09-29.md):
//      (1) B1c-T becomes REPORTED, with its control: by the code order (positionCorrect moves every particle by δ_dp
//      first, G2P samples v at the corrected position, then x += Δt·(u(x_mid) + u_V)) its numerator Σ(Δy − Δt·v_y) is
//      Σ[δ_dp + Δt·(u(mid) − v) + Δt·u_V + clamp] — the density correction and the RK2 midpoint are in it by
//      construction, and its ±0.02 was never derived (neither f32 nor a bound on those terms); its J-omitted control
//      assumed J ≈ +0.29 s while the data give ΣJ/Σs = −0.01 to −0.10. Its FAIL at 996e0bff (Λ 0.738 / 1.000 / 0.857)
//      stays on record. The successor gates the identity Δy = δ_dp + Δt·(u(mid) + u_V) + clamp once a hook logs δ_dp
//      and u(mid) per particle (H6), pre-registered with that hook before its first run. (2) B1c-control and B1c-spread
//      become REPORTED: both existed only to support B1c-slip's gate (a control that must fail; a run-to-run bound),
//      and B1c-slip is reported since the 19:12 re-scope — the re-scope left their fate unstated. (3) The dense window
//      runs 1/240 s frames (one substep while v_lag ≤ 10.86 m/s; at 1/120 s the bound was 5.38 and run 2 of c4369d4f
//      lost all 60 frames) and a run is VALID only with ≥ 100 of its 120 window frames single-substep; a VOID run is
//      repeated (up to 5 attempts for the 3 valid runs) — missing data is VOID, never a physics FAIL; failing to collect
//      3 valid runs fails the separate protocol check B1c-validity. B1c-M (and its μ_w control) stays gated, over the
//      valid runs. Nothing else changes.
// B2 iron floats on mercury (added 2026-09-29 with S3.7's monolithic ball, fixed before its first run): a mercury pool
//    over the whole floor, 0.28 m deep, the page's iron ball (R = 0.05 world units = 0.18 m) released at rest just above
//    the surface; mean submerged fraction over 6–8 s = ρ_Fe/ρ_Hg (NIST SRD 126 / materialData) ± 5 % (Archimedes; the
//    fraction from the ball's centre and the level L = (N·V_p + f·V)/A, solved together — s37-ref A4's measure).
// R  the page runs the incompressible solver; SSFR drew; no NaN positions; 0 uncaptured GPU errors; 0 console errors.
// FPS (recorded): the B1 scene on the real-time clock for 10 s — present interval p50/p95, real-time factor, substeps — in
//     its own window on the PRIMARY display (owner 2026-09-29: timing runs stay there; lib/window.mjs).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sample, sampleAtFrame, waitStepped, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { b1cDense } from './lib/b1cSuccessors.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S3.1c (incompressible solver on the FLUID TEST page)')
const report = { prov: await provenance() }
const L = 3.63, DX = L / 64, VP = DX ** 3 / 8, TAU = 1 / 24
const pool = { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } }
const oil = { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } }
const hg = { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }

const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
try {
  const st0 = await status(page)
  gate.check(st0.solver === 'flip', `R the FLUID TEST page runs the incompressible solver (status.solver = ${st0.solver})`)
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)

  // P1 + P2: the pool alone
  await loadScenario(page, { name: 's31c-pool', materials: [], spawns: [pool], gravity_mps2: G_STANDARD }, 1)
  const s = await sampleAtFrame(page, 360)
  const n = s.n, H = n * VP / (L * L)
  let v2 = 0, ySum = 0, bad = 0
  for (let i = 0; i < n; i++) {
    const vx = s.vel[3 * i] * L / TAU, vy = s.vel[3 * i + 1] * L / TAU, vz = s.vel[3 * i + 2] * L / TAU, y = s.pos[3 * i + 1] * L
    if (!Number.isFinite(vx + vy + vz + y)) { bad++; continue }
    v2 += vx * vx + vy * vy + vz * vz; ySum += y
  }
  const rms = Math.sqrt(v2 / (n - bad)), meanY = ySum / (n - bad), lim = 0.01 * Math.sqrt(G_STANDARD * H)
  report.pool = { n, H, rms, meanY, bad }
  gate.check(rms <= lim && bad === 0, `P1 stillness after 6 s (${n} particles, H = N·V_p/A = ${(100 * H).toFixed(2)} cm): RMS speed ${rms.toExponential(2)} m/s (≤ ${lim.toExponential(2)} = 1 % √(gH)); non-finite ${bad}`)
  gate.check(Math.abs(meanY - H / 2) <= 0.25 * DX, `P2 level: mean particle height ${(100 * meanY).toFixed(2)} cm vs H/2 ${(100 * H / 2).toFixed(2)} cm (±¼·dx = ${(25 * DX).toFixed(2)} cm)`)

  // B1: pool + oil + mercury
  await loadScenario(page, { name: 's31c-buoyancy', materials: [], spawns: [pool, oil, hg], gravity_mps2: G_STANDARD }, 2)
  const b4 = await sampleAtFrame(page, 240)
  const b45 = await sampleAtFrame(page, 270)
  const b5 = await sampleAtFrame(page, 300)
  const b = await sampleAtFrame(page, 480)
  const nameOf = new Map(b.materials.map(m => [m.id, m.name]))
  const ys = { Water: [], 'Olive Oil': [], Mercury: [] }
  let nan = 0
  for (let i = 0; i < b.n; i++) {
    const y = b.pos[3 * i + 1] * L, name = nameOf.get(b.comp[i])
    if (!Number.isFinite(y)) { nan++; continue }
    if (ys[name]) ys[name].push(y)
  }
  const mean = a => a.reduce((q, v) => q + v, 0) / a.length
  const wSorted = [...ys.Water].sort((p, q) => p - q), wMedian = wSorted[Math.floor(wSorted.length / 2)]
  const cW = mean(ys.Water), cO = mean(ys['Olive Oil']), cH = mean(ys.Mercury)
  const oilAbove = ys['Olive Oil'].filter(y => y > wMedian).length / ys['Olive Oil'].length
  const hgBelow = ys.Mercury.filter(y => y < wMedian).length / ys.Mercury.length
  report.buoyancy = { counts: Object.fromEntries(Object.entries(ys).map(([k, v]) => [k, v.length])), cW, cO, cH, wMedian, oilAbove, hgBelow, nan }
  gate.check(cH + 0.5 * DX <= cW && cW + 0.5 * DX <= cO && nan === 0,
    `B1 order after 8 s (water ${ys.Water.length}, oil ${ys['Olive Oil'].length}, mercury ${ys.Mercury.length} particles): COM height mercury ${(100 * cH).toFixed(1)} cm < water ${(100 * cW).toFixed(1)} cm < oil ${(100 * cO).toFixed(1)} cm (each gap ≥ ½·dx = ${(50 * DX).toFixed(1)} cm)`)
  console.log(`INFO B1 separation at 8 s: ${(100 * oilAbove).toFixed(1)} % of the oil above the water's median height ${(100 * wMedian).toFixed(1)} cm, ${(100 * hgBelow).toFixed(1)} % of the mercury below it (the old unsourced ≥ 90 % criteria, reported)`)

  // B1c: creaming of the page's own drops — the slip validated (convection-free), the end state reported, a drift-off control
  {
    const mat = Object.fromEntries(b4.materials.map(m => [m.name, m]))
    const oilId = mat['Olive Oil'].id, wId = mat.Water.id
    const RO = mat['Olive Oil'].rho, MUO = mat['Olive Oil'].mu, RW = mat.Water.rho, MUW = mat.Water.mu
    const fRe = Re => (Re < 1000 ? 1 + 0.15 * Re ** 0.687 : 0.44 * Re / 24)
    const Ueq = (d, F, rc, muM) => {   // s35i-ref's oracle: Re·f(Re) = d³ρ_c F/(18 μ_m²) by bisection
      const G2 = d ** 3 * rc * F / (18 * muM * muM)
      if (!(G2 > 0)) return 0
      let lo = 0, hi = G2
      for (let it = 0; it < 400 && hi - lo > 1e-15 * hi; it++) { const mid = 0.5 * (lo + hi); if (mid * fRe(mid) < G2) lo = mid; else hi = mid }
      return 0.5 * (lo + hi) * muM / (d * rc)
    }
    const muStar = (MUO + 0.4 * MUW) / (MUO + MUW)
    /** the drop's equilibrium slip through the water at α (u_d − u_c) */
    const uSlip = (d, a0) => { const a = Math.min(0.99, a0), rm = (1 - a) * RW + a * RO, muM = MUW * (1 - a) ** (-2.5 * muStar); return Ueq(d, Math.abs(RO - rm) * G_STANDARD, RW, muM) }
    const med = v => { const q = [...v].sort((x, y) => x - y); return q[Math.floor(q.length / 2)] }
    const waterMedian = s8 => med(Array.from({ length: s8.n }, (_, i) => i).filter(i => s8.comp[i] === wId).map(i => s8.pos[3 * i + 1] * L))
    const SLIP_DT = 0.5   // s: frames 240 → 270
    /** One B1 run's creaming analysis. dFixed: the drift-off control's drop size (its sample has no drift state). */
    const analyse = (s4, s45, s5, s8, dFixed) => {
      const wMed = waterMedian(s8)
      const cellOf = i => { const c = [0, 1, 2].map(a => Math.min(63, Math.max(0, Math.floor(s4.pos[3 * i + a] * L / DX)))); return c[0] + 64 * (c[1] + 64 * c[2]) }
      const colOf = c => c % 64 + 64 * Math.floor(c / 4096)
      const nAll = new Uint16Array(64 ** 3), nOil = new Uint16Array(64 ** 3), top = new Float64Array(64 * 64)
      const wRise = new Float64Array(64 ** 3), nW = new Uint16Array(64 ** 3)
      for (let i = 0; i < s4.n; i++) {
        const c = cellOf(i); nAll[c]++; top[colOf(c)] = Math.max(top[colOf(c)], s4.pos[3 * i + 1] * L)
        if (s4.comp[i] === oilId) nOil[c]++
        else if (s4.comp[i] === wId) { wRise[c] += (s45.pos[3 * i + 1] - s4.pos[3 * i + 1]) * L; nW[c]++ }
      }
      const set = [], resolved = []
      for (let i = 0; i < s4.n; i++) {
        if (s4.comp[i] !== oilId) continue
        const y = s4.pos[3 * i + 1] * L
        if (!(y < wMed)) continue
        const c = cellOf(i), a = nOil[c] / Math.max(1, nAll[c])
        const d = dFixed ?? s4.drift[4 * i + 3]
        if (dFixed !== undefined ? !(a < 0.5) : !(d > 0)) { resolved.push(i); continue }
        set.push({ i, y, d, a, c, col: colOf(c) })
      }
      /** Kynch march over 4 s at the rate multiplier k: fraction of the set above the median at 8 s (reported). */
      const march = k => {
        const oilCell = Uint16Array.from(nOil), ys = set.map(r => r.y), cells = set.map(r => r.c)
        for (let step = 0; step < 480; step++) {
          const us = set.map((r, n) => { const a = oilCell[cells[n]] / Math.max(1, nAll[cells[n]]); return k * (1 - Math.min(0.99, a)) * uSlip(r.d, a) })
          for (let n = 0; n < set.length; n++) {
            const yNew = Math.min(top[set[n].col], ys[n] + us[n] / 120)
            const cNew = cells[n] % 64 + 64 * Math.min(63, Math.floor(yNew / DX)) + 4096 * Math.floor(cells[n] / 4096)
            if (cNew !== cells[n]) { oilCell[cells[n]]--; oilCell[cNew]++; cells[n] = cNew }
            ys[n] = yNew
          }
        }
        return ys.filter(y => y > wMed).length / set.length
      }
      // design change 4: two-liquid drops only (no mercury in the kernel's mixture at either sample; control: within a cell)
      const hgMat = mat.Mercury, RH = hgMat?.rho
      const nHg = new Uint16Array(64 ** 3)
      if (hgMat) for (let i = 0; i < s4.n; i++) if (s4.comp[i] === hgMat.id) nHg[cellOf(i)]++
      const hgNear = c => {
        const x = c % 64, y = Math.floor(c / 64) % 64, z = Math.floor(c / 4096)
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy, Z = z + dz
          if (X >= 0 && X < 64 && Y >= 0 && Y < 64 && Z >= 0 && Z < 64 && nHg[X + 64 * (Y + 64 * Z)] > 0) return true
        }
        return false
      }
      const alphaHg = (s, i) => { const aD = s.slipIn[8 * i + 3], rm = s.slipIn[8 * i + 4]; return rm > 0 ? (rm - (1 - aD) * RW - aD * RO) / (RH - RO) : Infinity }
      const twoLiquid = r => !hgMat || (dFixed !== undefined ? !hgNear(r.c) : (s4.slipIn && s45.slipIn && alphaHg(s4, r.i) <= 1e-4 && alphaHg(s45, r.i) <= 1e-4))
      const diluteAll = set.filter(r => r.a < 0.3 && nW[r.c] > 0)
      const dilute = diluteAll.filter(twoLiquid)
      const slipOf = rs => rs.length ? rs.reduce((q, r) => q + ((s45.pos[3 * r.i + 1] - s4.pos[3 * r.i + 1]) * L - wRise[r.c] / nW[r.c]) / SLIP_DT, 0) / rs.length : NaN
      const lawOf = rs => rs.length ? rs.reduce((q, r) => q + uSlip(r.d, r.a), 0) / rs.length : NaN
      const ratioAll = slipOf(diluteAll) / lawOf(diluteAll)
      const meanOf = f => dilute.length ? dilute.reduce((q, r) => q + f(r), 0) / dilute.length : NaN
      const slip = meanOf(r => ((s45.pos[3 * r.i + 1] - s4.pos[3 * r.i + 1]) * L - wRise[r.c] / nW[r.c]) / SLIP_DT)
      const slipLaw = meanOf(r => uSlip(r.d, r.a))
      // diagnostic (INFO): the drift model's OWN slip (slipState s_y, averaged over the window's two samples) — splits the
      // excess into the model vs its law (its inputs α and a = g − Du/Dt, or its integration) and the transport vs the model
      const modelSlip = s4.drift && s45.drift ? meanOf(r => 0.5 * (s4.drift[4 * r.i + 1] + s45.drift[4 * r.i + 1])) : NaN
      // diagnostic (INFO): the same law with the KERNEL's own inputs (slipInputs: a = g − Du/Dt, ρ_m, μ_m; per instant,
      // drops dispersed at both samples) — splits the model's excess into its inputs vs its integration; and how many
      // drops' mixture density is raised above water + oil at their α by other liquids in the kernel's (trilinear) cell
      let lawK = NaN, modelK = NaN, nK = 0, nRhoUp = 0
      if (s4.slipIn && s45.slipIn) {
        const inst = (s, i) => {
          const g = j => s.slipIn[8 * i + j], acc = [g(0), g(1), g(2)], rm = g(4), muM = g(5), dd = s.drift[4 * i + 3], aM = Math.hypot(...acc)
          return dd > 0 && rm > 0 && aM > 0 ? { rm, u: Ueq(dd, Math.abs(RO - rm) * aM, RW, muM) * Math.sign(RO - rm) * acc[1] / aM, sy: s.drift[4 * i + 1] } : null
        }
        let sl = 0, sm = 0
        for (const r of dilute) {
          const A = inst(s4, r.i), B = inst(s45, r.i)
          if (!A || !B) continue
          nK++; sl += 0.5 * (A.u + B.u); sm += 0.5 * (A.sy + B.sy)
          if (0.5 * (A.rm + B.rm) > (1 - r.a) * RW + r.a * RO + 50) nRhoUp++
        }
        if (nK) { lawK = sl / nK; modelK = sm / nK }
      }
      return {
        wMed, n: set.length, nDilute: dilute.length, nDiluteAll: diluteAll.length, ratioAll, slip, slipLaw, ratio: slip / slipLaw, modelSlip, lawK, modelK, nK, nRhoUp,
        rise: meanOf(r => (s5.pos[3 * r.i + 1] - s4.pos[3 * r.i + 1]) * L), riseLaw: meanOf(r => (1 - r.a) * uSlip(r.d, r.a)),
        floor: march(0.9), measured: set.filter(r => s8.pos[3 * r.i + 1] * L > wMed).length / set.length,
        resolved: resolved.length, resolvedUp: resolved.filter(i => s8.pos[3 * i + 1] * L > wMed).length,
        dMedian: set.length ? med(set.map(r => r.d)) : NaN, aMedian: set.length ? med(set.map(r => r.a)) : NaN,
      }
    }
    const BAND = 0.1
    const slipOk = r => r.nDilute > 0 && Math.abs(r.ratio - 1) <= BAND
    const pct = v => (100 * v).toFixed(1), cms = v => (100 * v).toFixed(2)
    if (!b4.drift) throw new Error('B1c: the page sample carries no drift state (is the immiscible drift active?)')
    const scene = { name: 's31c-buoyancy', materials: [], spawns: [pool, oil, hg], gravity_mps2: G_STANDARD }
    const runs = [analyse(b4, b45, b5, b, undefined)]
    const nRuns = Number(process.env.B1C_RUNS ?? 3)
    for (let k = 1; k < nRuns; k++) {
      await loadScenario(page, scene, 2)
      const r4 = await sampleAtFrame(page, 240), r45 = await sampleAtFrame(page, 270), r5 = await sampleAtFrame(page, 300), r8 = await sampleAtFrame(page, 480)
      runs.push(analyse(r4, r45, r5, r8, undefined))
    }
    // the drift-off control
    const dCtl = med(runs.map(r => r.dMedian))
    await page.evaluate(() => window.__fluidBench.configure({ disableImmiscible: true }))
    await loadScenario(page, scene, 2)
    const c4 = await sampleAtFrame(page, 240), c45 = await sampleAtFrame(page, 270), c5 = await sampleAtFrame(page, 300), c8 = await sampleAtFrame(page, 480)
    await page.evaluate(() => window.__fluidBench.configure({ disableImmiscible: false }))
    if (c4.drift) throw new Error('B1c control: the drift is still on (the sample carries drift state)')
    const ctl = analyse(c4, c45, c5, c8, dCtl)
    report.creaming = { runs, control: ctl, dControl: dCtl, band: BAND }

    const line = (tag, r) => `INFO B1c ${tag}: set ${r.n} (dilute ${r.nDiluteAll}, of them two-liquid ${r.nDilute}; all dilute: slip × ${r.ratioAll.toFixed(3)} of the law), median d ${(1e3 * r.dMedian).toFixed(2)} mm, median α ${r.aMedian.toFixed(2)}; slip through the water ${cms(r.slip)} cm/s vs U_eq ${cms(r.slipLaw)} cm/s (× ${r.ratio.toFixed(3)}); the model's own slip ${Number.isFinite(r.modelSlip) ? `${cms(r.modelSlip)} cm/s (× ${(r.modelSlip / r.slipLaw).toFixed(3)} of U_eq; measured/model × ${(r.slip / r.modelSlip).toFixed(3)})` : 'n/a (drift off)'}${Number.isFinite(r.lawK) ? `; the law with the kernel's own inputs (ρ_m, μ_m, a; ${r.nK} drops dispersed at both samples) ${cms(r.lawK)} cm/s = × ${(r.lawK / r.slipLaw).toFixed(3)} of U_eq, the model × ${(r.modelK / r.lawK).toFixed(3)} of it; ${r.nRhoUp} drops with ρ_m > water + oil at their α + 50 kg/m³ (another liquid in the kernel's cell)` : ''}; lab-frame rise 4→5 s ${cms(r.rise)} cm/s vs (1 − α)·U_eq ${cms(r.riseLaw)} cm/s; at 8 s ${pct(r.measured)} % above the water median (no-convection floor, hindered march ×0.9: ${pct(r.floor)} %); resolved oil below at 4 s ${r.resolved}, ${r.resolvedUp} above by 8 s`
    runs.forEach((r, k) => console.log(line(`run ${k + 1}`, r)))
    console.log(line(`control (drift off, d = ${(1e3 * dCtl).toFixed(2)} mm)`, ctl))
    // the re-scope registered 2026-09-29 19:12 (header): the slip ratio is REPORTED now that B1c-T and B1c-M run below
    console.log(`INFO B1c-slip (reported since the re-scope; design change 4's FAIL stays on record): the dilute two-liquid drops' mean slip through the water that shared their cell, 4 → 4.5 s, ÷ U_eq = ${runs.map(r => r.ratio.toFixed(3)).join(', ')} over ${runs.length} runs (the old band 1 ± ${BAND}: ${runs.every(slipOk) ? 'inside' : 'outside'})`)
    // the successors: in-situ transport closure and replay, three dense-window runs (lib/b1cSuccessors.mjs)
    // revision 23:16 (header): 1/240 s frames, a validity floor; a VOID run is repeated, up to 5 attempts for 3 valid runs
    const attempts = [], dense = []
    while (dense.length < 3 && attempts.length < 5) {
      const d = await b1cDense(page, scene, 2)
      attempts.push({ usable: d.usable, frames: d.frames, valid: d.valid, minUsable: d.minUsable })
      if (d.valid) dense.push(d)
      else console.log(`VOID dense run (attempt ${attempts.length}): ${d.usable} of ${d.frames} window frames single-substep (< ${d.minUsable}) — repeated`)
    }
    report.creaming.dense = dense
    report.creaming.denseAttempts = attempts
    const fmt3 = v => v.toFixed(3), fmtPct = v => (100 * v).toFixed(2)
    gate.check(dense.length === 3,
      `B1c-validity (protocol): ${dense.length} valid dense-window runs of 3 needed, in ${attempts.length} attempts (usable single-substep frames ${attempts.map(a => `${a.usable}/${a.frames}`).join(', ')}; floor ≥ ${attempts[0]?.minUsable} of ${attempts[0]?.frames})`)
    console.log(`INFO B1c-T (reported since the 23:16 revision — its numerator holds the density correction and the RK2 midpoint by construction; the H6 identity is its successor): Λ = Σ(Δy − Δt·v_y)/Σ Δt·u_V,y = ${dense.map(d => fmt3(d.T.lambda)).join(', ')}; J-omitted control ${dense.map(d => fmt3(d.T.lambdaCtrl)).join(', ')} (${dense.map(d => `${d.T.n} drop-substeps, ${d.excluded}/${d.frames} frames with > 1 substep excluded`).join('; ')})`)
    gate.check(dense.length > 0 && dense.every(d => d.M.n > 0 && d.M.frac >= 0.999 && d.M.reFrac >= 0.999),
      `B1c-M in-situ replay exactness: dispersed drop-substeps replayed from the kernel's own inputs within 1e-4·max(|s|, 1e-4 m/s): ${dense.map(d => `${fmtPct(d.M.frac)} % of ${d.M.n} (Re ${fmtPct(d.M.reFrac)} %; worst × ${d.M.maxRel.toFixed(2)} of the tolerance)`).join('; ')} (≥ 99.9 % each)`)
    gate.check(dense.length > 0 && dense.every(d => d.M.ctrlFrac < 0.999),
      `B1c-M control (μ_w in place of μ_m): ${dense.map(d => `${fmtPct(d.M.ctrlFrac)} %`).join(', ')} — must fall BELOW 99.9 %`)
    console.log(`INFO B1c model ÷ its own instantaneous law over the dense window: ${dense.map(d => fmt3(d.modelOverLaw)).join(', ')}; sets ${dense.map(d => d.set).join(', ')}; the clock switch advanced ${dense.map(d => (1000 * d.clockStepS).toFixed(3)).join(', ')} ms per frame (4.167 expected at 1/240 s)`)
    console.log(`INFO B1c-T by stratum (reported): ${dense.map((d, k) => `run ${k + 1}: never-exposed ${fmt3(d.strata.never.lambda)} (${d.strata.never.drops}), exposed ${fmt3(d.strata.exposed.lambda)} (${d.strata.exposed.drops}), row 0 ${fmt3(d.strata.row0.lambda)} (${d.strata.row0.drops}), row 1 ${fmt3(d.strata.row1.lambda)} (${d.strata.row1.drops})`).join('; ')}`)
    console.log(`INFO ${ctl.nDilute > 0 && !slipOk(ctl) ? '(would pass)' : '(would fail)'} B1c-control (reported since the 23:16 revision): with the drift switched off the would-be-dispersed dilute oil with no mercury within a cell (${ctl.nDilute} particles) slips at × ${ctl.ratio.toFixed(3)} of its law — ${slipOk(ctl) ? 'INSIDE' : 'outside'} the band (must be outside: the observable sees the drift, not the plume); its 8-s fraction ${pct(ctl.measured)} % [reported]`)
    const spread = Math.max(...runs.map(r => r.ratio)) - Math.min(...runs.map(r => r.ratio))
    console.log(`INFO ${runs.length >= 2 && spread <= 2 * BAND ? '(would pass)' : '(would fail)'} B1c-spread (reported since the 23:16 revision): the slip ratio's run-to-run spread ${spread.toFixed(3)} over ${runs.length} identical runs ≤ the band's width ${(2 * BAND).toFixed(1)}`)
    const lo = Math.min(...runs.map(r => r.ratio)), hi = Math.max(...runs.map(r => r.ratio))
    const how = runs.every(slipOk) ? `at the drag law's speed (× ${lo.toFixed(2)}–${hi.toFixed(2)}, within ±${100 * BAND} %)`
      : `${lo >= 1 ? 'FASTER' : hi <= 1 ? 'SLOWER' : 'off'} than the drag law predicts (× ${lo.toFixed(2)}–${hi.toFixed(2)}; ±${100 * BAND} % allowed) — an open finding about the drift model`
    console.log(`OWNER NOTE B1c: the oil drops slip up through the water around them ${how}; the drift-off run ${slipOk(ctl) ? 'did NOT separate from the law — the check has no teeth' : 'shows the check catches a page whose drops stop slipping'}. Where the oil ends up after 8 s is set by the blob's stirring (which moves oil even with the drift off), so it is reported, not judged.`)
  }

  // B2: iron floats on mercury
  {
    const depth = 0.28, Rw = 0.05, R = Rw * L, RHO_FE = 7874, RHO_HG = 13545.859
    const cy = depth / L + Rw + 0.005
    await loadScenario(page, { name: 's31c-iron-on-mercury', materials: [], spawns: [{ material: 'Mercury', box: { min: [0, 0, 0], max: [3.63, depth, 3.63] } }], gravity_mps2: G_STANDARD, ball: { center: [0.5, cy, 0.5], radius: Rw } }, 3)
    const A = L * L, V = 4 / 3 * Math.PI * R ** 3, fRef = RHO_FE / RHO_HG
    const fs = []
    let nHg = 0, ballGone = false
    for (let f = 360; f <= 480; f += 12) {
      await page.evaluate(fr => window.__fluidBench.setStepLimit(fr), f)
      const st = await waitStepped(page, f)
      if (!st.ball) { ballGone = true; break }
      if (!nHg) nHg = (await sample(page)).n
      const yc = st.ball.center[1] * L
      let fr = 0.5
      for (let it = 0; it < 50; it++) { const Lv = (nHg * VP + fr * V) / A, h = Math.min(2 * R, Math.max(0, Lv - (yc - R))); fr = h * h * (3 * R - h) / (4 * R ** 3) }
      fs.push(fr)
    }
    const fMean = fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : NaN
    report.ironOnMercury = { fs, fMean, fRef, nHg, ballGone }
    gate.check(!ballGone && Math.abs(fMean / fRef - 1) <= 0.05,
      `B2 iron floats on mercury (${nHg} mercury particles, ball R = ${(100 * R).toFixed(1)} cm): mean submerged fraction over 6–8 s ${fMean.toFixed(4)} (range ${Math.min(...fs).toFixed(3)}–${Math.max(...fs).toFixed(3)}) vs ρ_Fe/ρ_Hg ${fRef.toFixed(4)} (${(100 * (fMean / fRef - 1)).toFixed(2)} %, ±5 %)`)
  }

  // R: render path, then FPS on the real-time clock (the B1 scene again, settled 8 s, in a primary-display window)
  const r = await status(page)
  gate.check(r.renderPath === 'ssfr', `R SSFR drew the frame (render path ${r.renderPath})`)
  const fp = await openFluidPage(undefined, { timing: true })
  let f, d
  try {
    await fp.page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    await loadScenario(fp.page, { name: 's31c-buoyancy', materials: [], spawns: [pool, oil, hg], gravity_mps2: G_STANDARD }, 2)
    await sampleAtFrame(fp.page, 480)   // the settled B1 state, as measured before the window moved (8 s lockstep)
    await fp.page.evaluate(() => window.__fluidBench.configure({ clock: 'realtime', resetClockStats: true, resetDiagnostics: true }))
    await fp.page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
    await fp.page.waitForTimeout(10_000)
    f = await status(fp.page)
    d = await fp.page.evaluate(() => window.__fluidBench.diagnostics())
    errors.push(...fp.errors)
  } finally {
    await fp.browser.close()
  }
  report.fps = { count: f.count, fps: f.fps, rtFactor: f.rtFactor, p50: f.presentIntervalP50, p95: f.presentIntervalP95, droppedTime: f.droppedTime, diagnostics: d }
  console.log(`  [recorded] FPS, ${f.count} particles on the real-time clock for 10 s: ${f.fps} fps, present interval p50 ${f.presentIntervalP50?.toFixed(1)} ms / p95 ${f.presentIntervalP95?.toFixed(1)} ms, real-time factor ${f.rtFactor.toFixed(3)}, dropped ${f.droppedTime.toFixed(2)} s; substeps ${d.substeps}, v_lag ${d.vLag?.toFixed(2)} m/s, p caps ${d.pressureCapHits}/${d.pressureSolves}, ψ caps ${d.psiCapHits}/${d.psiSolves}, breakdowns ${d.breakdowns}, CFL > 1 substeps ${d.cflExceeded}`)
  const gpuErr = (await status(page)).gpuErrors + f.gpuErrors
  gate.check(gpuErr === 0, `R GPU: ${gpuErr} uncaptured WebGPU errors (gate page + FPS window)`)
  gate.check(errors.length === 0, `R console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's31c-page', pass, report, gate.results)
process.exit(pass ? 0 : 1)
