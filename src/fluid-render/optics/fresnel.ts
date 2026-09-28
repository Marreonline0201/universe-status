// Exact Fresnel reflectance for unpolarised light (no Schlick approximation, no exponent knob).
//
// Dielectric: pbr-book 3rd ed. §8.2, https://pbr-book.org/3ed-2018/Reflection_Models/Specular_Reflection_and_Transmission
//   r∥ = (ηt cosθi − ηi cosθt)/(ηt cosθi + ηi cosθt),  r⊥ = (ηi cosθi − ηt cosθt)/(ηi cosθi + ηt cosθt),
//   F = ½(r∥² + r⊥²), cosθt from Snell's law, F = 1 on total internal reflection.
// Conductor (complex index η + ik, pbr-book §8.2 "conductors have a complex-valued index of refraction"): the
//   closed real-arithmetic form of |r⊥|² and |r∥|² for incidence from a non-absorbing medium,
//     t0 = η² − k² − sin²θ,  a² + b² = √(t0² + 4η²k²),  a = √(½(a² + b² + t0)),
//     R⊥ = (a² + b² + cos²θ − 2a cosθ)/(a² + b² + cos²θ + 2a cosθ),
//     R∥ = R⊥ · (cos²θ(a² + b²) + sin⁴θ − 2a cosθ sin²θ)/(cos²θ(a² + b²) + sin⁴θ + 2a cosθ sin²θ),
//   F = ½(R⊥ + R∥). At normal incidence this is ((η−1)² + k²)/((η+1)² + k²). The gate r0-render.mjs checks this
//   form against an independent complex-arithmetic evaluation of the same Fresnel equations.

/** Dielectric Fresnel reflectance, light arriving in medium η_i onto medium η_t at cosθ_i. */
export function fresnelDielectric(cosThetaI: number, etaI: number, etaT: number): number {
  const ci = Math.min(1, Math.max(0, cosThetaI))
  const sinT2 = (etaI / etaT) ** 2 * Math.max(0, 1 - ci * ci)
  if (sinT2 >= 1) return 1
  const ct = Math.sqrt(1 - sinT2)
  const rPar = (etaT * ci - etaI * ct) / (etaT * ci + etaI * ct)
  const rPerp = (etaI * ci - etaT * ct) / (etaI * ci + etaT * ct)
  return 0.5 * (rPar * rPar + rPerp * rPerp)
}

/** Conductor Fresnel reflectance from vacuum/air (η_i = 1) onto a metal of complex index η + ik. */
export function fresnelConductor(cosThetaI: number, eta: number, k: number): number {
  const c = Math.min(1, Math.max(0, cosThetaI))
  const c2 = c * c
  const s2 = 1 - c2
  const t0 = eta * eta - k * k - s2
  const a2b2 = Math.sqrt(t0 * t0 + 4 * eta * eta * k * k)
  const a = Math.sqrt(Math.max(0, 0.5 * (a2b2 + t0)))
  const t1 = a2b2 + c2
  const t2 = 2 * c * a
  const rs = (t1 - t2) / (t1 + t2)
  const t3 = c2 * a2b2 + s2 * s2
  const t4 = t2 * s2
  const rp = rs * (t3 - t4) / (t3 + t4)
  return 0.5 * (rp + rs)
}
