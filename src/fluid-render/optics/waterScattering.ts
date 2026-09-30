// Scattering by pure water — Zhang, Hu & He 2009, "Scattering by pure seawater: effect of salinity", Optics Express 17,
// 5698–5710 — ported line by line from the authors' betasw_ZHH2009.m (Xiaodong Zhang, March 10 2009; SEANOE 42420) for
// S = 0 (fresh water), where the concentration-fluctuation term S·M0·(∂n/∂S)²/… vanishes and only the density term stays:
//   β(90) = (π²/2)·λ⁻⁴·k_B·T·β_T·(ρ∂n²/∂ρ)²·(6 + 6δ)/(6 − 7δ)      (paper Eq. 2; code line 60)
//   b     = (8π/3)·β(90)·(2 + δ)/(1 + δ)                          (code line 66)
//   β(ψ)  = β(90)·[1 + cos²ψ·(1 − δ)/(1 + δ)]                     (code line 68)
// with the model's OWN absolute index n = Quan & Fry 1994 (S = 0 terms) × Ciddor 1996 air — not the renderer's Daimon n
// (they differ by 1.5–3.6e-5, ≤ 0.028 % in b; OPT-2a spec §2.2) — ρ∂n²/∂ρ from the PMH model, β_T = 1e-5/K_w Pa⁻¹ with K_w
// Millero 1980's secant bulk modulus of pure water, and δ = 0.039 (Farinato & Rowell 1976, the code's default; Zhang et al.
// 2019 measured 0.039 ± 0.001). "For backscattering coefficients, divide total scattering by 2" (code header): exact, the
// shape is symmetric about 90°. Valid 0–30 °C (paper p. 5706). Reference: b(550 nm, 20 °C) = 1.314992e-3 m⁻¹.

export const KB = 1.3806503e-23   // Boltzmann constant, J/K (code line 21)
export const KELVIN = 273.15      // code line 22
/** The renderer's evaluation point: 20 °C, δ = 0.039, fresh water (S = 0: the concentration-fluctuation term is omitted,
 *  not evaluated). Every default below reads it; the bench's optics() readout reports it (OPT-2a-c asserts it by value). */
export const ZHANG_SHIPPED = { tempC: 20, delta: 0.039, salinity: 0 } as const

/** Quan & Fry 1994 (S = 0) × Ciddor 1996 air: the absolute refractive index of pure water (code lines 74–81). */
export function zhangWaterIndex(lambdaNm: number, tempC: number = ZHANG_SHIPPED.tempC): number {
  const s2 = 1 / (lambdaNm / 1e3) ** 2
  const nAir = 1 + (5792105.0 / (238.0185 - s2) + 167917.0 / (57.362 - s2)) / 1e8
  const n0 = 1.31405, n4 = -2.02e-6, n5 = 15.868, n7 = -0.00423, n8 = -4382, n9 = 1.1455e6
  return (n0 + n4 * tempC * tempC + (n5 + n7 * tempC) / lambdaNm + n8 / lambdaNm ** 2 + n9 / lambdaNm ** 3) * nAir
}

/** Isothermal compressibility of pure water, 1/Pa: 1e-5/K_w, K_w the Millero 1980 secant bulk modulus in bar (code lines 86, 99). */
export function waterCompressibility(tempC: number = ZHANG_SHIPPED.tempC): number {
  const t = tempC
  const kw = 19652.21 + 148.4206 * t - 2.327105 * t ** 2 + 1.360477e-2 * t ** 3 - 5.155288e-5 * t ** 4
  return 1e-5 / kw
}

/** ρ∂n²/∂ρ from the PMH model (code lines 130–132). */
export function pmh(n: number): number {
  const n2 = n * n
  return (n2 - 1) * (1 + (2 / 3) * (n2 + 2) * (n / 3 - 1 / 3 / n) ** 2)
}

/** Pure fresh water at `tempC`: the absolute index, β(90) in 1/(m·sr) and the total scattering coefficient b in 1/m. */
export function zhangPureWater(lambdaNm: number, tempC: number = ZHANG_SHIPPED.tempC, delta: number = ZHANG_SHIPPED.delta): { nAbs: number; beta90PerMSr: number; bPerM: number } {
  const nAbs = zhangWaterIndex(lambdaNm, tempC)
  const dfri = pmh(nAbs)
  const beta90PerMSr = (Math.PI * Math.PI / 2) * (lambdaNm * 1e-9) ** -4 * KB * (tempC + KELVIN) * waterCompressibility(tempC) * dfri * dfri * (6 + 6 * delta) / (6 - 7 * delta)
  const bPerM = (8 * Math.PI / 3) * beta90PerMSr * (2 + delta) / (1 + delta)
  return { nAbs, beta90PerMSr, bPerM }
}

/** The phase function β(ψ)/b in 1/sr: (1 + C·cos²ψ)/(4π·(1 + C/3)), C = (1 − δ)/(1 + δ) — integrates to 1 over the sphere. */
export function vsfOverB(cosPsi: number, delta: number = ZHANG_SHIPPED.delta): number {
  const C = (1 - delta) / (1 + delta)
  return (1 + C * cosPsi * cosPsi) / (4 * Math.PI * (1 + C / 3))
}
