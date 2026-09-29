// The B1c successors — s31c-page's header, "RE-SCOPE, REGISTERED 2026-09-29 19:12 BEFORE ANY E3/E6 DATA" (commit
// 90d8cc9f; the B1c synthesis memo §2.2 E3-R / E3-X): B1c-M, in-situ replay exactness, and B1c-T, in-situ transport
// closure, each with a control that must fail.
// Dense window: the B1 scene at lockstep 1/60 s to 3.85 s (frame 231), then 1/120 s frames — ONE substep each while
// v_lag < 5.38 m/s (FlipBackend.advance: n = max(⌈T/FLIP_MAX_DT⌉, CFL)) — sampled every frame to 4.5 s (frame 309);
// a frame that took more than one substep is excluded from the per-substep sums and counted. The set is chosen at
// t0 = 4.0 s (frame 249) only: olive-oil drops dispersed (d > 0), dilute (their cell's particle-count α < 0.3, water
// present), kernel α_Hg ≤ 1e-4, below y = 7.36 cm.
// B1c-M: per dispersed drop-substep, the kernel's update (immiscible.wgsl slipParticles) replayed from its own logged
//   inputs — a, ρ_m, μ_m, ρ_c (slipInputs), the new d (slipState.w) and the previous substep's s:
//   Re = d·ρ_c·|s_old|/μ_m, k_d = d²/(18 μ_m f(Re)), m = 1 − e^(−Δt/((ρ_p + ½ρ_c)·k_d)), s = s_old + ((ρ_p − ρ_m)·a·k_d − s_old)·m.
//   Pass: ≥ 99.9 % of drop-substeps |s_n − s_rep| ≤ 1e-4·max(|s_n|, 1e-4 m/s) AND the logged Re within 1e-5·max(Re, 1)
//   of the replayed. Control: μ_w (water) in place of μ_m — must fall below 99.9 %.
// B1c-T: Λ = Σ(Δy − Δt·v_y) / Σ Δt·u_V,y over the set's drop-substeps (Δy the substep's displacement, v_y the particle
//   velocity the substep's G2P gave, u_V the drift it advected with). Pass: Λ = 1 ± 0.02. Control: the drops' own slip
//   s_y in the denominator (J omitted) — ≈ 1 − α, must fall outside the band.
// Reported: the model ÷ its own instantaneous law over the window (s_y vs the law with the kernel's inputs).
import { loadScenario, waitStepped, sampleAtFrame, DOMAIN_L_M, unitVelToMs } from '../../lib/fluid-page.mjs'

const L = DOMAIN_L_M, DX = L / 64, BAND_Y = 0.0736, DT = 1 / 120
const F_SWITCH = 231, F0 = F_SWITCH + 18, F1 = F_SWITCH + 78
const dragFactor = Re => (Re >= 1000 ? 0.44 * Re / 24 : Re <= 0 ? 1 : 1 + 0.15 * Re ** 0.687)
const oneMinusExpNeg = h => (h < 0.1 ? h * (1 - h * (0.5 - h * (1 / 6 - h * (1 / 24 - h / 120)))) : 1 - Math.exp(-h))
const cellOf = (pos, i) => { const c = [0, 1, 2].map(a => Math.min(63, Math.max(0, Math.floor(pos[3 * i + a] * L / DX)))); return c[0] + 64 * (c[1] + 64 * c[2]) }

/** One dense-window run of the B1 scene; returns the B1c-M / B1c-T sums and the reported model ÷ law. */
export async function b1cDense(page, scene, seed = 2) {
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, immExcludeLiquids: [], disableImmiscible: false }))
  await loadScenario(page, scene, seed)
  await page.evaluate(f => window.__fluidBench.setStepLimit(f), F_SWITCH); await waitStepped(page, F_SWITCH)
  const t0 = (await page.evaluate(() => window.__fluidBench.status())).simTime
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 120 }))
  const subs = async () => (await page.evaluate(() => window.__fluidBench.status())).substepsTotal   // the engine's CPU counter: no GPU readback per frame
  let subPrev = await subs(), prev = null, set = null, mats = null, excluded = 0, frames = 0
  const M = { n: 0, ok: 0, reOk: 0, ctrlOk: 0, maxRel: 0 }, T = { num: 0, den: 0, denCtrl: 0, n: 0 }, K = { s: 0, law: 0 }
  let tCheck = null
  for (let f = F_SWITCH + 1; f <= F1; f++) {
    const s = await sampleAtFrame(page, f)
    const sub = await subs(), nSub = sub - subPrev; subPrev = sub
    if (f === F_SWITCH + 1) tCheck = (await page.evaluate(() => window.__fluidBench.status())).simTime - t0
    if (!s.drift || !s.slipIn || !s.uV) throw new Error('B1c dense window: the sample carries no drift state')
    if (!mats) mats = Object.fromEntries(s.materials.map(m => [m.name, m]))
    const RO = mats['Olive Oil'].rho, RW = mats.Water.rho, MUW = mats.Water.mu, RH = mats.Mercury.rho, oilId = mats['Olive Oil'].id, wId = mats.Water.id
    if (f === F0) {
      const nAll = new Uint16Array(64 ** 3), nOil = new Uint16Array(64 ** 3), nW = new Uint16Array(64 ** 3)
      for (let i = 0; i < s.n; i++) { const c = cellOf(s.pos, i); nAll[c]++; if (s.comp[i] === oilId) nOil[c]++; else if (s.comp[i] === wId) nW[c]++ }
      set = []
      for (let i = 0; i < s.n; i++) {
        if (s.comp[i] !== oilId || !(s.drift[4 * i + 3] > 0) || !(s.pos[3 * i + 1] * L < BAND_Y)) continue
        const c = cellOf(s.pos, i)
        if (!(nOil[c] / Math.max(1, nAll[c]) < 0.3) || nW[c] === 0) continue
        const aD = s.slipIn[8 * i + 3], rm = s.slipIn[8 * i + 4]
        if (!(rm > 0) || !((rm - (1 - aD) * RW - aD * RO) / (RH - RO) <= 1e-4)) continue
        set.push(i)
      }
    } else if (set && prev && f > F0) {
      frames++
      if (nSub !== 1) excluded++
      else for (const i of set) {
        // B1c-T
        const dy = (s.pos[3 * i + 1] - prev.pos[3 * i + 1]) * L, vy = unitVelToMs(s.vel[3 * i + 1])
        T.num += dy - DT * vy; T.den += DT * s.uV[4 * i + 1]; T.denCtrl += DT * (s.drift[4 * i + 3] > 0 ? s.drift[4 * i + 1] : 0); T.n++
        // B1c-M (a dispersed drop-substep: the kernel logged its inputs)
        const g = k => s.slipIn[8 * i + k], rm = g(4), muM = g(5), ReLog = g(6), rc = g(7)
        if (!(rm > 0) || !(muM > 0) || !(rc > 0)) continue
        const acc = [g(0), g(1), g(2)], d = s.drift[4 * i + 3]
        const sOld = [0, 1, 2].map(a => prev.drift[4 * i + a]), sN = [0, 1, 2].map(a => s.drift[4 * i + a])
        const replay = mu => {
          const Re = d * rc * Math.hypot(...sOld) / mu, kd = d * d / (18 * mu * dragFactor(Re)), m = oneMinusExpNeg(DT / ((RO + 0.5 * rc) * kd))
          return { Re, s: sOld.map((so, a) => so + ((RO - rm) * acc[a] * kd - so) * m) }
        }
        const r = replay(muM), rC = replay(MUW)
        const err = v => Math.hypot(...sN.map((x, a) => x - v[a])), tol = 1e-4 * Math.max(Math.hypot(...sN), 1e-4)
        M.n++
        const e = err(r.s)
        if (e <= tol) M.ok++
        M.maxRel = Math.max(M.maxRel, e / tol)
        if (Math.abs(ReLog - r.Re) <= 1e-5 * Math.max(r.Re, 1)) M.reOk++
        if (err(rC.s) <= tol) M.ctrlOk++
        // reported: the model vs its own instantaneous law (the fixed point of the same update)
        const aM = Math.hypot(...acc)
        if (aM > 0) {
          let lo = 0, hi = 1e3 * d   // Re·f(Re) = d³ρ_c|ρ_p − ρ_m|·|a|/(18 μ_m²) by bisection (s31c's Ueq oracle)
          const G2 = d ** 3 * rc * Math.abs(RO - rm) * aM / (18 * muM * muM)
          hi = Math.max(1, G2)
          for (let it = 0; it < 200; it++) { const mid = 0.5 * (lo + hi); if (mid * dragFactor(mid) < G2) lo = mid; else hi = mid }
          const law = 0.5 * (lo + hi) * muM / (d * rc) * Math.sign(RO - rm) * acc[1] / aM
          K.s += sN[1]; K.law += law
        }
      }
    }
    prev = s
  }
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60 }))
  return {
    set: set?.length ?? 0, frames, excluded, clockStepS: tCheck,
    M: { n: M.n, frac: M.ok / Math.max(1, M.n), reFrac: M.reOk / Math.max(1, M.n), ctrlFrac: M.ctrlOk / Math.max(1, M.n), maxRel: M.maxRel },
    T: { n: T.n, lambda: T.num / T.den, lambdaCtrl: T.num / T.denCtrl },
    modelOverLaw: K.law !== 0 ? K.s / K.law : NaN,
  }
}
