// Natural-water constituent slots (OPT-2a spec §2.6, §3.7). The forward-model FORMS are sourced; the MAGNITUDES are data
// gaps, so the humic and turbid presets ship empty and resolve to pure water (ED-32: "pure-water colour; real lakes are
// greener or browner").
//   a(λ) = a_w(λ) + a_g(443)·e^{−S_g(λ − 443)} + a_p(λ)   (roadmap §5.2 "a_total = a_w + a_CDOM + a_particles"; the exponential
//     form QAA_v6 step 10 / IOCCG Report 5 p. 58 Eq. 8.4 — which QAA applies to CDOM and detritus SUMMED; a forward
//     renderer keeps them apart: dissolved CDOM only absorbs, detritus is particulate and also scatters)
//   b_b(λ) = b_bw(λ) + b_bp(λ0)·(λ0/λ)^η                   (QAA_v5 Eq. 3; QAA_v6 step 5)
// S outside 0.008–0.023 nm⁻¹ is FLAGGED, not rejected: "S ranging between 0.008 to 0.023 nm-1 (e.g., Roesler et al., 1989)"
// (IOCCG Report 5 p. 58) is a typical measured range for CDOM + detritus combined, not a physical bound. QAA's S and η
// regressions (on the colour ratio r_rs(443)/r_rs(55x) the renderer itself computes) are never used to fill a preset.

export interface WaterConstituents {
  /** a_g(443), 1/m: dissolved CDOM, absorbs only */
  ag443PerM: number | null
  /** S_g, 1/nm */
  sgPerNm: number | null
  /** detrital absorption at 443 nm, 1/m: particulate — belongs with b_bp and a particle VSF */
  ad443PerM: number | null
  /** S_d, 1/nm */
  sdPerNm: number | null
  /** b_bp(λ0), 1/m */
  bbpRefPerM: number | null
  /** λ0, nm */
  bbpRefNm: number | null
  eta: number | null
  /** citation of the measured values; required whenever any field is set */
  source: string | null
}

const EMPTY: WaterConstituents = { ag443PerM: null, sgPerNm: null, ad443PerM: null, sdPerNm: null, bbpRefPerM: null, bbpRefNm: null, eta: null, source: null }

export const NATURAL_WATER_PRESETS: Record<'pure' | 'humic' | 'turbid', WaterConstituents> = {
  pure: { ag443PerM: 0, sgPerNm: null, ad443PerM: 0, sdPerNm: null, bbpRefPerM: 0, bbpRefNm: null, eta: null, source: 'pure water: Pope & Fry 1997; Zhang, Hu & He 2009' },
  humic: { ...EMPTY },
  turbid: { ...EMPTY },
}

const S_RANGE_NM: [number, number] = [0.008, 0.023]
const FIELDS: (keyof Omit<WaterConstituents, 'source'>)[] = ['ag443PerM', 'sgPerNm', 'ad443PerM', 'sdPerNm', 'bbpRefPerM', 'bbpRefNm', 'eta']

/** Validate a constituent set: a set value with no `source` is rejected (thrown); S_g or S_d outside 0.008–0.023 nm⁻¹ is
 *  flagged in the returned `unverified` list. Returns `usable` = false for a set that cannot render yet (a particle
 *  term needs a particle VSF, a data gap), and whether it resolves to pure water. */
export function validateConstituents(c: WaterConstituents): { unverified: string[]; resolvesToPure: boolean; usable: boolean } {
  const set = FIELDS.filter(k => c[k] !== null && c[k] !== 0)
  if (set.length && !(c.source && c.source.trim())) throw new Error(`water constituents: ${set.join(', ')} set with no source (every measured value needs its citation)`)
  const unverified: string[] = []
  for (const [k, label] of [['sgPerNm', 'S_g'], ['sdPerNm', 'S_d']] as const) {
    const s = c[k]
    if (s !== null && (s < S_RANGE_NM[0] || s > S_RANGE_NM[1])) unverified.push(`${label} = ${s} nm⁻¹ outside the IOCCG Report 5 p. 58 range for CDOM + detritus (0.008–0.023); the citation must cover it`)
  }
  const unfilled = FIELDS.every(k => c[k] === null)
  if (unfilled) unverified.push('constituents not sourced (ED-32): pure-water optics')
  const particles = [c.ad443PerM, c.bbpRefPerM].some(v => v !== null && v !== 0)
  return { unverified, resolvesToPure: unfilled || set.length === 0, usable: !particles }
}
