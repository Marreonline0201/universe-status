// The QAA_v5 forward relations for optically deep, nadir-viewed water (Lee, Lubac, Werdell & Arnone, "An update of the
// quasi-analytical algorithm (QAA_v5)", IOCCG, https://www.ioccg.org/groups/Software_OCA/QAA_v5.pdf):
//   u = b_b/(a + b_b);  r_rs = g0·u + g1·u²  (Table 1: g0 = 0.089, g1 = 0.125 — pinned; the authors' own documents give
//   four sets that move R_rs(450) by up to 0.46 %, OPT-2a spec §2.3);
//   R_rs = t·r_rs/(1 − γ·r_rs)  — the algebraic inverse of Eq. 2, r_rs = R_rs/(0.52 + 1.7·R_rs): "0.52 and 1.7 are empirical
//   values derived from data simulated by Hydrolight (Lee et al., 1999)" (IOCCG Report 5, p. 74).
// The model's scope: "optically deep waters" (IOCCG Report 5, p. 73), "nadir-viewing" (QAA_v5 p. 3). It omits Raman
// scattering, which for pure water is first order (OPT-2a spec §2.3) — QAA vs a radiative-transfer table is an owner
// decision. Reference: pure fresh water at 450 nm, u = 0.141922 → R_rs = 8.0856e-3 sr⁻¹.

export interface QaaCoefficients { g0: number; g1: number; t: number; gamma: number }
export const QAA_V5: QaaCoefficients = { g0: 0.089, g1: 0.125, t: 0.52, gamma: 1.7 }

/** Remote-sensing reflectance R_rs (1/sr) of optically deep water with absorption a and backscattering b_b (1/m). */
export function qaaRrs(aPerM: number, bbPerM: number, c: QaaCoefficients = QAA_V5): number {
  const u = bbPerM / (aPerM + bbPerM)
  const r = c.g0 * u + c.g1 * u * u
  return c.t * r / (1 - c.gamma * r)
}
