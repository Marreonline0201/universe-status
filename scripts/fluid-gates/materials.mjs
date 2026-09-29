#!/usr/bin/env node
// scripts/fluid-gates/materials.mjs — S1.5 material-data gate (FINAL-PLAN.md §7 S1.5). CPU only, no browser, no GPU.
//
// Run from the universe-status root:   node scripts/fluid-gates/materials.mjs        (exit 0 = every check passed)
//                                      node scripts/fluid-gates/materials.mjs --json (machine-readable result on stdout)
// Mutation coverage of this gate:      node scripts/fluid-gates/materials-mutations.mjs
//
// It imports the REAL src/composition/*.ts modules (bundled on the fly by rolldown into the OS temp dir, see
// lib/loadTs.mjs) and compares them with independent reference values in data/*.json that were copied from (or, for
// GRD, produced by) the cited documents. Tolerances are the source's stated uncertainty, the plan's stated band, the
// printed precision of the reference value, or float round-off for exact copies — never widened to make a check pass.
// INFO lines report numbers without a pass/fail claim.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTsModules, REPO } from './lib/loadTs.mjs'
import { step, energy, particle, rng, maxAbsC, axisWeights } from './lib/mpmReplica.mjs'

const JSON_OUT = process.argv.includes('--json')
const results = []
const record = (status, id, what, measured) => {
  results.push({ status, id, what, measured })
  if (!JSON_OUT) console.log(`${status.padEnd(4)} ${id.padEnd(4)} ${what}${measured !== undefined ? `  →  ${measured}` : ''}`)
}
const check = (id, what, ok, measured) => record(ok ? 'PASS' : 'FAIL', id, what, measured)
const info = (id, what, measured) => record('INFO', id, what, measured)
/** |x − printed| ≤ half a unit in the last printed decimal. */
const roundsTo = (x, printed, decimals) => Math.abs(x - printed) <= 0.5 * 10 ** -decimals + 1e-12 * Math.abs(printed)
/** Exact copy up to float round-off. */
const same = (x, y) => Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y))
const pct = (x) => `${(x * 100).toFixed(4)} %`

const readJson = async (f) => JSON.parse(await readFile(join(REPO, 'scripts/fluid-gates/data', f), 'utf8'))
const ref = await readJson('materials-reference.json')
const nist = await readJson('nist-water-isobar-0p5C.json')
const nist1 = await readJson('nist-water-isobar-1C.json')
const grdOracle = await readJson('grd08-oracle.json')

// FLUID_GATE_SRC lets a mutation run point the gate at a modified copy of src/composition (default: the real one). The
// copy must keep the src/ layout: liquidGate imports ../fluid-engine/units and ../fluid-engine/spawn.
const SRC = process.env.FLUID_GATE_SRC ?? 'src/composition'
const { md, lg, ct, pc } = await loadTsModules({
  md: `${SRC}/materialData.ts`,
  lg: `${SRC}/liquidGate.ts`,
  ct: `${SRC}/CompositionTable.ts`,
  pc: `${SRC}/PropertyCalculator.ts`,
})

const table = new ct.CompositionTable()
table.addDefaults()
const idOf = (name, t = table) => { const id = t.findByName(name); if (id === null) throw new Error(`default ${name} missing`); return id }
const fresh = () => { const t = new ct.CompositionTable(); t.addDefaults(); return t }
const PB = ref.phase_bounds
const K = (k) => k - 273.15

// ── A. Water ─────────────────────────────────────────────────────────────────────────────────────
{
  let bad = []
  for (const [t, rho, mu] of nist1.rows) {
    if (!same(md.waterDensity(t), rho) || !same(md.waterViscosity(t), mu)) bad.push(t)
  }
  check('A0', `water table nodes equal an independent NIST fetch (${nist1.rows.length} rows: 0.01, 1…99, 99.9743 °C) to float round-off`, bad.length === 0, bad.length ? `mismatch at ${bad.slice(0, 5).join(', ')} °C` : 'all equal')
  let maxRho = 0, atRho = 0, maxMu = 0, atMu = 0, maxSh = 0, atSh = 0, n = 0
  for (const [t, rho, mu] of nist.rows) {
    const dr = md.waterDensity(t) / rho - 1
    const dm = md.waterViscosity(t) / mu - 1
    const ds = md.waterViscositySharqawy2010(t) / mu - 1
    if (Math.abs(dr) > Math.abs(maxRho)) { maxRho = dr; atRho = t }
    if (Math.abs(dm) > Math.abs(maxMu)) { maxMu = dm; atMu = t }
    if (Math.abs(ds) > Math.abs(maxSh)) { maxSh = ds; atSh = t }
    n++
  }
  check('A1', `water ρ(T) between nodes vs NIST 0.5 °C isobar (${n} rows, off the 1 °C nodes), plan band ±0.12 %`, Math.abs(maxRho) <= 0.0012, `max ${pct(maxRho)} at ${atRho} °C`)
  check('A2', `water μ(T) between nodes vs NIST 0.5 °C isobar (${n} rows), plan band ±0.12 %`, Math.abs(maxMu) <= 0.0012, `max ${pct(maxMu)} at ${atMu} °C`)
  info('A3', 'Sharqawy 2010 Eq. 23 cross-check vs NIST (NOT the solver path; stated ±0.05 %)', `max ${pct(maxSh)} at ${atSh} °C`)
  let sigOk = true, sigWorst = 0
  for (const [t, s] of ref.iapws_r1_76_table1_calculated_mN_per_m.rows) {
    const v = md.waterSurfaceTension(t) * 1e3
    sigWorst = Math.max(sigWorst, Math.abs(v - s))
    if (!roundsTo(v, s, 2)) sigOk = false
  }
  check('A4', 'water σ(T) reproduces IAPWS R1-76 Table 1 col. 4 (21 values, 0.01–100 °C) to the printed 0.01 mN/m', sigOk, `worst |Δ| ${sigWorst.toFixed(4)} mN/m`)
  const w = table.getSolverProps(idOf('Water'))
  const row20 = nist1.rows.find(r => r[0] === 20)
  check('A5', 'default Water at 20 °C equals the independently fetched NIST 20 °C row (ρ 998.2072, μ 1.001596e-3)', same(w.rhoKgM3, row20[1]) && same(w.muPaS, row20[2]), `ρ ${w.rhoKgM3}, μ ${w.muPaS.toExponential(6)}`)
  const ph = table.getPhaseProps(idOf('Water'))
  const [f0, b0] = PB.water_liquid_C_at_0p101325MPa.value
  const okEnds = lg.validateSpawn(ph, 0.01).ok && lg.validateSpawn(ph, 99.9743).ok
  const badEnds = !lg.validateSpawn(ph, -1).ok && !lg.validateSpawn(ph, 100.5).ok
  check('A6', 'water phase bounds = NIST (0.01, 99.9743 °C) exactly; liquid at both ends, refused at −1 and 100.5 °C', ph.freezeC === f0 && ph.boilC === b0 && okEnds && badEnds, `${ph.freezeC}, ${ph.boilC}`)
  const r5 = lg.validateSpawn(ph, 0.005)
  check('A7', 'refusal text never rounds across a bound: water at 0.005 °C is refused and the reason says 0.005 °C', !r5.ok && /0\.005 °C/.test(r5.reason), r5.ok ? 'accepted!' : r5.reason)
}

// ── B. Mercury ───────────────────────────────────────────────────────────────────────────────────
{
  let ok = true, worst = 0
  for (const [TK, v] of ref.assael2012_table3_mercury_viscosity_mPa_s.rows_K) {
    const mine = md.mercuryViscosity(TK - 273.15) * 1e3
    worst = Math.max(worst, Math.abs(mine / v - 1))
    if (!roundsTo(mine, v, 3)) ok = false
  }
  check('B1', 'Hg μ(T) reproduces Assael 2012 Table 3 (8 values, 250–600 K) to the printed 0.001 mPa·s', ok, `worst rel. dev ${pct(worst)} (source uncertainty ±2.1 %)`)
  const hg = table.getSolverProps(idOf('Mercury'))
  const dev = hg.muPaS / ref.owner_decisions_2026_09_28.mercury_mu_20C_Pa_s - 1
  check('B2', 'default Mercury μ(20 °C) = 1.567e-3 Pa·s (D6, Assael 2012; overrides 0.00117) within the source ±2.1 % and at printed precision',
    Math.abs(dev) <= 0.021 && roundsTo(hg.muPaS * 1e3, 1.567, 3), `μ ${hg.muPaS.toExponential(5)} Pa·s (${pct(dev)})`)
  check('B3', 'default Mercury ρ(20 °C) = Bettin & Fehlauer 2004 reference 13545.859 kg/m³',
    Math.abs(hg.rhoKgM3 - ref.bettin_fehlauer_2004_mercury_density_20C.value) < 1e-9, `ρ ${hg.rhoKgM3}`)
  const ph = table.getPhaseProps(idOf('Mercury'))
  const [fK, bK] = PB.mercury_K.value
  check('B4', 'Hg phase bounds = NIST T_fus 234.31 K, T_boil 629.81 K exactly; 20 °C ok, −40 °C refused (solid), 400 °C refused',
    same(ph.freezeC, K(fK)) && same(ph.boilC, K(bK)) && lg.validateSpawn(ph, 20).ok && !lg.validateSpawn(ph, -40).ok && !lg.validateSpawn(ph, 400).ok,
    `${ph.freezeC.toFixed(2)} / ${ph.boilC.toFixed(2)} °C`)
}

// ── C. Glycerol (exact formula) ──────────────────────────────────────────────────────────────────
{
  // Evaluate the source's own expressions (checked-in reference data, not user input). Guard: only digits, T,
  // arithmetic, parentheses and Math.exp may appear, so the reference file cannot smuggle in other code.
  const src = ref.reading_glycerol_calculator_source_lines
  const SAFE = /^(?:[0-9.+\-*/() T]|Math\.exp)+$/
  for (const e of [src.viscosity_glycerol_Pa_s, src.density_glycerol_kg_m3]) {
    if (!SAFE.test(e)) throw new Error(`reference expression rejected by the whitelist: ${e}`)
  }
  const muSrc = new Function('T', `return ${src.viscosity_glycerol_Pa_s}`)
  const rhoSrc = new Function('T', `return ${src.density_glycerol_kg_m3}`)
  let worstMu = 0, worstRho = 0
  for (let t = 0; t <= 100; t += 5) {
    worstMu = Math.max(worstMu, Math.abs(md.glycerolViscosity(t) / muSrc(t) - 1))
    worstRho = Math.max(worstRho, Math.abs(md.glycerolDensity(t) / rhoSrc(t) - 1))
  }
  check('C1', 'glycerol μ(T), ρ(T) equal the Reading calculator source expressions (Cheng 2008 / Volk & Kähler 2018), 0–100 °C', worstMu < 1e-12 && worstRho < 1e-12, `max rel. diff μ ${worstMu.toExponential(2)}, ρ ${worstRho.toExponential(2)}`)
  const g = table.getSolverProps(idOf('Glycerol'))
  const [m, dm] = ref.r4_derived_printed.glycerol_mu_20C_Pa_s
  const [r, dr] = ref.r4_derived_printed.glycerol_rho_20C
  check('C2', `consistency (not independent): default Glycerol at 20 °C matches the plan §4.2 printed μ = ${m} Pa·s, ρ = ${r} kg/m³`, roundsTo(g.muPaS, m, dm) && roundsTo(g.rhoKgM3, r, dr), `μ ${g.muPaS.toFixed(5)}, ρ ${g.rhoKgM3}`)
  const ph = table.getPhaseProps(idOf('Glycerol'))
  check('C3', 'glycerol boiling bound = NIST 550 K exactly (freezing bound null: supercooled liquid, 0–100 °C data range governs)',
    same(ph.boilC, K(PB.glycerol_boil_K.value)) && ph.freezeC === null && ph.dataRangeC[0] === 0 && ph.dataRangeC[1] === 100, `${ph.boilC}`)
}

// ── D. Ethanol ───────────────────────────────────────────────────────────────────────────────────
{
  // Eq. 13 (stated 2.3 %) vs the paper's full correlation (stated 4.2 %): two estimates of one quantity, independent
  // 95 % uncertainties → their difference is consistent within √(2.3² + 4.2²) = 4.79 %. The ancillary density is
  // compared with the EOS values of Table 7 within its stated max 0.737 %.
  const T7 = ref.sotiriadou2023_table7_0p1MPa.rows_K_rho_kg_m3_mu_uPa_s
  const U = Math.hypot(0.023, 0.042)
  const eRange = table.getPhaseProps(idOf('Ethanol')).dataRangeC
  let wMuIn = 0, wRho = 0, rangeOk = true
  const rows = []
  for (const [TK, rho, mu] of T7) {
    const dMu = Math.abs(md.ethanolViscosity(K(TK)) * 1e6 / mu - 1)
    const inside = K(TK) >= eRange[0] && K(TK) <= eRange[1]
    if (inside) wMuIn = Math.max(wMuIn, dMu)
    else if (dMu <= U) rangeOk = false // a consistent row must not be excluded from the validated range without reason
    wRho = Math.max(wRho, Math.abs(md.ethanolDensity(K(TK)) / rho - 1))
    rows.push(`${TK} K ${(dMu * 100).toFixed(2)} %${inside ? '' : ' (outside range)'}`)
  }
  check('D0', `independent: ethanol Eq. 13 μ agrees with Sotiriadou 2023 Table 7 (0.1 MPa, full correlation) within the combined 95 % uncertainty ${pct(U)} at every Table 7 temperature inside the validated spawn range, and only inconsistent rows are outside it; ancillary ρ within its stated 0.737 % of the EOS values (180–340 K)`,
    wMuIn <= U && rangeOk && wRho <= 0.00737, `${rows.join(', ')}; worst ρ ${pct(wRho)}`)
  const e = table.getSolverProps(idOf('Ethanol'))
  const [m, dm] = ref.r4_derived_printed.ethanol_mu_20C_mPa_s
  const [r, dr] = ref.r4_derived_printed.ethanol_rho_20C
  check('D1', `consistency (not independent): default Ethanol at 20 °C matches the plan's printed μ = ${m} mPa·s, ρ = ${r} kg/m³`, roundsTo(e.muPaS * 1e3, m, dm) && roundsTo(e.rhoKgM3, r, dr), `μ ${(e.muPaS * 1e3).toFixed(4)} mPa·s, ρ ${e.rhoKgM3.toFixed(3)}`)
  const ph = table.getPhaseProps(idOf('Ethanol'))
  const [tK, bK] = PB.ethanol_K.value
  check('D2', 'ethanol phase bounds = 159 K / 351.57 K exactly (Eq. 13 validity); validated spawn range starts at 200 K; 78 °C ok, 80 °C and −80 °C refused',
    same(ph.freezeC, K(tK)) && same(ph.boilC, K(bK)) && same(ph.dataRangeC[0], K(200)) && lg.validateSpawn(ph, 78).ok && !lg.validateSpawn(ph, 80).ok && !lg.validateSpawn(ph, -80).ok,
    `${ph.freezeC.toFixed(2)} / ${ph.boilC.toFixed(2)} °C, data from ${ph.dataRangeC[0].toFixed(2)} °C`)
}

// ── E/F. Secondary data: olive oil, honey presets ────────────────────────────────────────────────
{
  const o = table.getSolverProps(idOf('Olive Oil'))
  const S = ref.secondary_S
  check('E1', 'Olive Oil: ρ 911, μ 0.084 Pa·s at 20 °C, flagged secondary-data', o.rhoKgM3 === S.olive_oil.rho && o.muPaS === S.olive_oil.mu_Pa_s && o.flags.includes('secondary-data'), o.flags.join(','))
  check('E2', 'Olive Oil at 25 °C refused (no sourced temperature law)', !table.validateSpawnById(idOf('Olive Oil'), 25).ok, table.validateSpawnById(idOf('Olive Oil'), 25).reason)
  const h14 = table.getSolverProps(idOf('Honey (14% water)')), h20 = table.getSolverProps(idOf('Honey (20% water)'))
  const flagsOk = (f, m) => f.includes('secondary-data') && f.includes(`moisture-preset:${m}`) && f.includes('estimate:density')
  check('F1', 'Honey presets: 40 Pa·s (14 % water) and 2 Pa·s (20 % water) at 25 °C, flagged secondary / moisture preset / density estimate',
    h14.muPaS === S.honey_14pct.mu_Pa_s && h20.muPaS === S.honey_20pct.mu_Pa_s && flagsOk(h14.flags, '14pct') && flagsOk(h20.flags, '20pct'))
  check('F2', 'Honey at 20 °C refused (data only at 25 °C)', !table.validateSpawnById(idOf('Honey (14% water)'), 20).ok)
  const [lo, hi] = S.honey_density_range_20C_kg_m3.value
  check('F3', `Honey ρ = ESTIMATE midpoint of the sourced ${lo}–${hi} kg/m³ range (both presets)`, h14.rhoKgM3 === (lo + hi) / 2 && h20.rhoKgM3 === (lo + hi) / 2, `${h14.rhoKgM3}, ${h20.rhoKgM3}`)
}

// ── G. Lava ──────────────────────────────────────────────────────────────────────────────────────
{
  const ex = ref.grd2008_table2_example
  const x = md.grdMolePct(ex.oxides_wt)
  const molOk = ex.mol_pct_printed.every((p, i) => roundsTo(x[i], p, 2))
  check('G1', "GRD 2008 port: wt% → mol% step reproduces the paper's Table 2 mol% column (11 oxides) to the printed 0.01",
    molOk, x.slice(0, 11).map(v => v.toFixed(2)).join(' '))
  const v = md.grdVft(ex.oxides_wt)
  const logEta = v.A + v.B / (1273 - v.C)
  // Not a pass/fail: the paper's worked example is internally inconsistent at this level (its printed B-terms sum to
  // 7720.2; recomputing from its own printed mol% gives B 7718.6; its 3.67 follows from its rounded B = 7720, C = 334).
  // G8 is the hard check of B and C (against the authors' own code).
  info('G1b', `GRD port B, C, log η(1273 K) vs Table 2 printed ${ex.B}, ${ex.C}, ${ex.log_eta_1273K}`,
    `B ${v.B.toFixed(2)} (Δ ${(v.B - ex.B).toFixed(2)}), C ${v.C.toFixed(2)}, log η ${logEta.toFixed(4)} (Δ ${(logEta - ex.log_eta_1273K).toFixed(4)}; GRD RMSE ${ex.stated_rmse_log_units})`)
  let worstO = 0, nVol = 0
  for (const c of grdOracle.cases) {
    const q = md.grdVft(c.wt), m = md.grdMolePct(c.wt)
    const rel = (a, b) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b))
    worstO = Math.max(worstO, rel(q.B, c.B), rel(q.C, c.C), rel(q.TgK, c.TgK), ...m.map((y, i) => Math.abs(y - c.molPct[i]) / 100))
    if (c.wt[10] > 0 || c.wt[11] > 0) nVol++
  }
  check('G8', `GRD port = the authors' grd08.js (molePct, grdmodel) on ${grdOracle.cases.length} compositions (${nVol} with H2O and/or F): mol %, B, C, Tg to 1e-9 relative`,
    worstO <= 1e-9, `worst rel. diff ${worstO.toExponential(2)} (oracle sha256 ${grdOracle.grd08_js_sha256.slice(0, 12)}…)`)

  // Preset coefficients vs the port on the Fissure 8 glass: the owner-approved 5963 / 600.7 must lie inside the spread
  // produced by the ±0.005 wt% rounding of the published 2-decimal composition (seeded Monte-Carlo on the real port).
  const od = ref.owner_decisions_2026_09_28
  const f8 = md.grdVft(od.fissure8_oxides_wt)
  const R = rng(12345)
  let bMin = Infinity, bMax = -Infinity, cMin = Infinity, cMax = -Infinity
  for (let k = 0; k < 20000; k++) {
    const comp = od.fissure8_oxides_wt.map((y, i) => (i < 10 ? y + (R() * 2 - 1) * od.fissure8_composition_rounding_wt : y))
    const q = md.grdVft(comp)
    bMin = Math.min(bMin, q.B); bMax = Math.max(bMax, q.B); cMin = Math.min(cMin, q.C); cMax = Math.max(cMax, q.C)
  }
  const P = md.LAVA_GRD_PRESET
  check('G2', 'lava GRD preset (A −4.55, B 5963, C 600.7; owner D13) is the GRD port on Kīlauea 2018 Fissure 8 glass within composition rounding',
    P.A === od.lava_grd_preset.A && P.B === od.lava_grd_preset.B && P.C === od.lava_grd_preset.C && P.B >= bMin && P.B <= bMax && P.C >= cMin && P.C <= cMax,
    `port B ${f8.B.toFixed(2)} (rounding band ${bMin.toFixed(1)}–${bMax.toFixed(1)}), C ${f8.C.toFixed(2)} (${cMin.toFixed(2)}–${cMax.toFixed(2)})`)
  const lava = table.getSolverProps(idOf('Lava'))
  check('G3', 'default Lava = preset "degassed basaltic melt (GRD)" at 1200 °C: ρ 2600, μ = 10^(−4.55 + 5963/(T − 600.7))',
    lava.rhoKgM3 === od.lava_grd_preset.rho && Math.abs(lava.muPaS / 10 ** (-4.55 + 5963 / (1200 + 273.15 - 600.7)) - 1) < 1e-12, `μ ${lava.muPaS.toFixed(2)} Pa·s`)
  const cited = ref.r4_derived_printed.lava_grd_eta_Pa_s_by_C.map(([t, c]) => `${t} °C ${md.vftViscosity(P, t).toFixed(1)} (cited ${c})`).join('; ')
  info('G4', 'preset η vs r4/plan printed values (r4 truncated/rounded mixed; GRD stated RMSE 0.40 log units)', cited)
  const k = table.getSolverProps(idOf('Lava (Kīlauea 2018 bulk)'))
  const H = ref.halverson_whittington_2024
  const [phi0, phi1] = H.vesicularity_1150C_run_start_end
  const br = md.LAVA_KILAUEA_BULK_RHO_BRACKET
  check('G5', 'Kīlauea 2018 bulk preset: μ 116 Pa·s at 1150 °C; ρ = DRE 2600 × (1 − 0.361) (start of the 1150 °C run, Table 1), bracket to (1 − 0.192) at its end, flagged unverified pairing',
    k.muPaS === H.mu_1150C_Pa_s && k.flags.includes('unverified:density-pairing') && same(k.rhoKgM3, H.dre_density_kg_m3 * (1 - phi0))
      && same(br[0], H.dre_density_kg_m3 * (1 - phi0)) && same(br[1], H.dre_density_kg_m3 * (1 - phi1)),
    `ρ ${k.rhoKgM3.toFixed(1)} (bracket ${br.map(y => y.toFixed(1)).join('–')})`)
  // First °C at which the GRD preset passes the (derived) MPM limit, over its sourced range.
  let cross = null
  for (let t = 1100; t <= 1250; t++) {
    if (lg.mpmViscosityCode(md.vftViscosity(P, t), 2600) <= lg.MPM_MU_CODE_LIMIT) { cross = t; break }
  }
  info('G6', `GRD preset: first integer °C in 1100–1250 °C accepted by the legacy-MPM limit ${lg.MPM_MU_CODE_LIMIT}`, cross === null ? `none (μ_code ${lg.mpmViscosityCode(md.vftViscosity(P, 1250), 2600).toFixed(2)} at 1250 °C)` : `${cross} °C`)
  // PropertyCalculator bug (r4 §C.1-1): the legacy lava ELEMENTS used to hit the silica-glass branch → 1e8 Pa·s.
  const elems = { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }
  const tot = Object.values(elems).reduce((a, b) => a + b, 0)
  const norm = Object.fromEntries(Object.entries(elems).map(([e, f]) => [e, f / tot]))
  const pp = pc.computeProperties({ elements: norm }, 1200)
  const vft = md.grdVft(pc.silicateOxidesWt(norm))
  check('G7', 'PropertyCalculator: basalt element mix at 1200 °C goes through the GRD branch (no silica-glass match, no 1e8 clamp); Tg is not a melting point',
    pp.flags.includes('model:GRD2008-melt') && Math.abs(pp.viscosity / md.vftViscosity(vft, 1200) - 1) < 1e-12 && pp.viscosity < 1e8 && Number.isNaN(pp.meltingPoint) && pp.flags.includes('unsourced:liquidus'),
    `μ ${pp.viscosity.toFixed(1)} Pa·s (was 1e8); meltingPoint ${pp.meltingPoint}`)
  const span = md.GRD_CALIBRATION_T_C.anhydrous
  const TgC = vft.TgK - 273.15
  const nanOut = [span[0] - 1, span[1] + 1, 2500, 5000].every(t => Number.isNaN(pc.computeProperties({ elements: norm }, t).viscosity))
  const nanGlass = Number.isNaN(pc.computeProperties({ elements: norm }, Math.max(span[0], TgC - 1)).viscosity) || TgC <= span[0]
  check('G9', `no extrapolation: GRD element-model μ is NaN outside GRD's anhydrous calibration span ${span[0]}–${span[1]} °C (e.g. 2500, 5000 °C) and below Tg (${TgC.toFixed(0)} °C)`,
    nanOut && nanGlass && Number.isFinite(pc.computeProperties({ elements: norm }, 1500).viscosity))
}

// ── H. Phase + pairwise thermal gates, menu visibility ────────────────────────────────────────────
{
  const fe = table.getSolverProps(idOf('Iron')), na = table.getSolverProps(idOf('Salt'))
  const feP = table.getPhaseProps(idOf('Iron')), naP = table.getPhaseProps(idOf('Salt'))
  check('H1', 'Iron and Salt at 20 °C: phaseAtSpawn solid, flagged refused:phase:solid, not spawnable, menu "refused"',
    fe.phaseAtSpawn === 'solid' && na.phaseAtSpawn === 'solid' && fe.flags.includes('refused:phase:solid') && na.flags.includes('refused:phase:solid')
      && !table.isSpawnable(idOf('Iron')).ok && !table.isSpawnable(idOf('Salt')).ok
      && table.menuVisibility(idOf('Iron')).visibility === 'refused' && table.menuVisibility(idOf('Salt')).visibility === 'refused',
    `${table.isSpawnable(idOf('Iron')).reason}`)
  check('H1b', 'melting bounds = JANAF phase boundaries exactly: iron 1809 K, NaCl 1074 K',
    same(feP.freezeC, K(PB.iron_melt_K.value)) && same(naP.freezeC, K(PB.salt_melt_K.value)), `${feP.freezeC}, ${naP.freezeC}`)
  const cu = table.menuVisibility(idOf('Copper'))
  const cu1200 = table.menuVisibility(idOf('Copper'), 'incompressible', 1200)
  check('H2', 'Copper hidden from the liquid menu (liquid density unsourced, D7) at 1100 and 1200 °C; freezing point = ITS-90 1357.77 K',
    cu.visibility === 'hidden' && cu1200.visibility === 'hidden' && !table.isSpawnable(idOf('Copper')).ok && same(table.getPhaseProps(idOf('Copper')).freezeC, K(PB.copper_freeze_K.value)), cu.reason)
  const lw = lg.validateScene([table.sceneMaterial(idOf('Lava (Kīlauea 2018 bulk)')), table.sceneMaterial(idOf('Water'))])
  // Plan §4.2: the GRD "degassed melt" is the preset every lava gate uses → default Lava (id 6) at 1150 and 1200 °C.
  const g1150 = lg.validateScene([table.sceneMaterial(idOf('Lava'), 1150), table.sceneMaterial(idOf('Water'), 20)])
  const g1200 = lg.validateScene([table.sceneMaterial(idOf('Lava'), 1200), table.sceneMaterial(idOf('Water'), 20)])
  check('H3', 'scene default Lava (GRD degassed melt) at 1150 °C and at 1200 °C + water 20 °C refused (above water T_boil; no heat transfer)',
    !g1150.ok && !g1200.ok && g1150.refusals.some(r => /boiling point of Water/.test(r)) && g1200.refusals.some(r => /boiling point of Water/.test(r)), g1150.refusals[0])
  check('H3b', 'scene Kīlauea 2018 bulk lava 1150 °C + water 20 °C refused', !lw.ok && lw.refusals.some(r => /boiling point of Water/.test(r)))
  const wh = lg.validateScene([table.sceneMaterial(idOf('Water')), table.sceneMaterial(idOf('Mercury'))])
  const ww = lg.validateScene([table.sceneMaterial(idOf('Water'), 80), table.sceneMaterial(idOf('Water'), 20)])
  check('H4', 'scene water 20 °C + mercury 20 °C ok with no refusals; water 80 °C + water 20 °C ok but warned (no heat transfer)',
    wh.ok && wh.refusals.length === 0 && ww.ok && ww.warnings.length > 0, ww.warnings[0])
  const t2 = new ct.CompositionTable()
  const kId = t2.add('water', 'H2O', { H: 0.111, O: 0.889 }, 293) // lab scenarios write K as °C
  const kv = t2.isSpawnable(kId)
  check('H5', 'element-detected water at "293" (°C) refused as a gas — surfaces the K-vs-°C scenario bug', !kv.ok && t2.getSolverProps(kId).phaseAtSpawn === 'gas', kv.ok ? '' : kv.reason)
  // Incompressible (S3) menu: no explicit-viscosity limit; until the implicit viscous solve (S3.6) a liquid whose
  // ν ≥ the scheme's measured numerical viscosity ν_num (1.04e-3 m²/s, gate D2) is refused (liquidGate
  // .incompressibleViscosityVerdict), one with 0.01·ν_num ≤ ν < ν_num is spawnable but warned; phase / hidden /
  // unsourced still refuse.
  const t3 = fresh()
  const sil = t3.add('thick-silicate', 'SiO2FeCa', { Si: 0.35, O: 0.42, Fe: 0.15, Ca: 0.08 }, 20) // lab scenario material
  const vis = Object.fromEntries(t3.getMenuEntries('incompressible').map(e => [e.name, e.visibility]))
  const silV = t3.isSpawnable(sil, 'incompressible')
  check('H6', "menu('incompressible'): water, mercury, ethanol, olive oil show; glycerol, both honeys and both lavas refused (ν ≥ ν_num until S3.6); Iron/Salt refused; Copper hidden; element-model silicate refused (unsourced)",
    ['Water', 'Mercury', 'Ethanol', 'Olive Oil'].every(n => vis[n] === 'show')
      && ['Glycerol', 'Honey (14% water)', 'Honey (20% water)', 'Lava', 'Lava (Kīlauea 2018 bulk)'].every(n => vis[n] === 'refused')
      && vis['Iron'] === 'refused' && vis['Salt'] === 'refused' && vis['Copper'] === 'hidden' && !silV.ok && t3.getSolverProps(sil).flags.includes('refused:unsourced'),
    Object.entries(vis).map(([n, v]) => `${n}:${v}`).join(' '))
  // the S3.6-pending rule itself: its constant, the refusal reason, and the olive-oil warning through checkSpawn/checkScene
  const nuOf = n => { const p = t3.getSolverProps(idOf(n, t3)); return p.muPaS / p.rhoKgM3 }
  const gly = t3.isSpawnable(idOf('Glycerol', t3), 'incompressible')
  const oilChk = t3.checkSpawn(idOf('Olive Oil', t3), { method: 'incompressible' })
  const oilMpm = t3.checkSpawn(idOf('Olive Oil', t3), { method: 'mpm' })
  const wScene = t3.checkScene([{ id: idOf('Water', t3) }, { id: idOf('Olive Oil', t3) }], 'incompressible')
  check('H6b', 'S3.6-pending rule: ν_num = 1.04e-3 m²/s; glycerol (ν ≥ ν_num) refused naming S3.6; olive oil (0.01·ν_num ≤ ν < ν_num) spawnable with a viscosity warning on incompressible, no such warning on mpm; water (ν < 0.01·ν_num) unwarned',
    lg.INCOMPRESSIBLE_NU_NUM === 1.04e-3 && nuOf('Glycerol') >= lg.INCOMPRESSIBLE_NU_NUM && !gly.ok && /S3\.6/.test(gly.reason)
      && nuOf('Olive Oil') >= 0.01 * lg.INCOMPRESSIBLE_NU_NUM && nuOf('Olive Oil') < lg.INCOMPRESSIBLE_NU_NUM
      && oilChk.ok && oilChk.warnings.some(w => /S3\.6/.test(w)) && !oilMpm.warnings.some(w => /S3\.6/.test(w))
      && wScene.ok && wScene.warnings.filter(w => /S3\.6/.test(w)).length === 1 && nuOf('Water') < 0.01 * lg.INCOMPRESSIBLE_NU_NUM,
    `ν glycerol ${nuOf('Glycerol').toExponential(2)}, olive oil ${nuOf('Olive Oil').toExponential(2)}, water ${nuOf('Water').toExponential(2)}; ${gly.ok ? 'glycerol accepted!' : gly.reason.slice(0, 90)}`)
  // Pairwise FREEZE refusal (the boil branch is H3): mercury at −30 °C is liquid (T_fus −38.84 °C) but below water's freezing point.
  const t4 = fresh()
  const hgCold = t4.spawnIdAt(idOf('Mercury', t4), -30)
  const sv = hgCold.ok ? t4.validateSceneIds([{ id: hgCold.id }, { id: idOf('Water', t4) }]) : { ok: true, refusals: [] }
  check('H7', 'pairwise freeze: Mercury at −30 °C (liquid) + Water 20 °C refused ("below the freezing point of Water")',
    hgCold.ok && !sv.ok && sv.refusals.some(r => /below the freezing point of Water/.test(r)), hgCold.ok ? sv.refusals[0] : hgCold.reason)
  // checkSpawn / checkScene (the one-call gates the UI and loadScenario must use)
  const ethCold = t4.spawnIdAt(idOf('Ethanol', t4), -50)
  const cs1 = ethCold.ok ? t4.checkSpawn(ethCold.id, { scene: [{ id: idOf('Water', t4) }] }) : { ok: true }
  const cs2 = t4.checkSpawn(idOf('Water', t4), { scene: [{ id: idOf('Mercury', t4) }] })
  const cs3 = t4.checkScene([{ id: idOf('Lava', t4) }, { id: idOf('Water', t4) }], 'incompressible')
  const cs4 = t4.checkScene([{ id: idOf('Water', t4) }, { id: idOf('Olive Oil', t4) }], 'mpm')
  check('H8', 'checkSpawn: ethanol −50 °C into a water scene refused (would freeze water); water into a mercury scene ok. checkScene: lava 1200 °C + water refused on incompressible; water + olive oil 20 °C ok on mpm',
    ethCold.ok && !cs1.ok && cs2.ok && !cs3.ok && cs4.ok, cs1.ok ? 'accepted!' : cs1.reason.slice(0, 110))
}

// ── N. Unsourced liquids and extrapolation are refused (review findings 3, 4) ─────────────────────
{
  const t = fresh()
  const n0 = t.count
  const fe1600 = t.spawnIdAt(idOf('Iron', t), 1600, 'incompressible')
  const na900 = t.spawnIdAt(idOf('Salt', t), 900, 'incompressible')
  const feEval = t.evaluateAt(idOf('Iron', t), 1600, 'incompressible')
  // The phase gate itself (liquidGate.validateSpawn on getPhaseProps) must refuse, not only the NaN-density fallback.
  const pgFe = lg.validateSpawn(t.getPhaseProps(idOf('Iron', t)), 1600), pgNa = lg.validateSpawn(t.getPhaseProps(idOf('Salt', t)), 900)
  check('N1', 'Iron at 1600 °C and Salt at 900 °C (above their melting points) refused by the phase gate itself and on every method — liquid data unsourced; the solid density is NOT carried into the liquid (ρ NaN); nothing registered',
    !pgFe.ok && !pgNa.ok && /would be liquid at 1600 °C, but liquid Fe/.test(pgFe.reason) && /would be liquid at 900 °C, but molten NaCl/.test(pgNa.reason)
      && !fe1600.ok && !na900.ok && Number.isNaN(feEval.solver.rhoKgM3) && t.count === n0,
    pgFe.ok ? 'phase gate accepted iron!' : pgFe.reason)
  const basalt = { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }
  const refused = []
  for (const T of [700, 900, 1150, 1500, 2500, 5000]) {
    const r = t.addChecked(`AI basalt ${T}`, 'b', basalt, T)
    refused.push(!r.verdict.ok && !t.isSpawnable(r.id, 'incompressible').ok && /liquidus/.test(r.verdict.reason))
  }
  const mu2500 = t.getSolverProps(t.findByName('AI basalt 2500')).muPaS, mu5000 = t.getSolverProps(t.findByName('AI basalt 5000')).muPaS
  check('N2', 'AI basalt (element model → GRD) at 700/900/1150/1500/2500/5000 °C refused on MPM and incompressible (liquidus unsourced); μ NaN at 2500 and 5000 °C (outside GRD calibration)',
    refused.every(Boolean) && Number.isNaN(mu2500) && Number.isNaN(mu5000), refused.map(String).join(','))
  const ai = [
    ['AI oil 20', { C: 0.85, H: 0.15 }, 20], ['AI oil 299', { C: 0.85, H: 0.15 }, 299], ['AI bronze', { Cu: 0.88, Sn: 0.12 }, 1100],
    ['AI molten iron', { Fe: 1 }, 1600], ['AI sodium', { Na: 1 }, 150], ['AI salt melt', { Na: 0.393, Cl: 0.607 }, 900],
  ].map(([n, el, T]) => { const r = t.addChecked(n, n, el, T); return [n, r.verdict, t.isSpawnable(r.id, 'incompressible')] })
  check('N3', 'AI organic oil (20, 299 °C), liquid bronze, molten Fe, Na, molten NaCl (element model, [U] parameters) refused on MPM and incompressible, each with a reason',
    ai.every(([, a, b]) => !a.ok && !b.ok && a.reason.length > 20), ai.map(([n, a]) => `${n}: ${a.ok ? 'OK!' : 'refused'}`).join('; '))
  info('N3b', 'reason shown for an AI oil at 20 °C', ai[0][1].reason)
  const w2 = t.add('water', 'H2O', { H: 0.111, O: 0.889 }, 20, 1000, undefined, { viscosity: 0.5 })
  const ws = t.getSolverProps(w2)
  check('N4', 'cited law wins over caller overrides: element water with densityOverride 1000 and μ override 0.5 keeps NIST ρ, μ (flagged override-ignored)',
    ws.rhoKgM3 === md.waterDensity(20) && ws.muPaS === md.waterViscosity(20) && ws.flags.some(f => f.startsWith('override-ignored:density')) && ws.flags.some(f => f.startsWith('override-ignored:viscosity')),
    ws.flags.join(','))
}

// ── I. MPM viscosity: conversion, derived limit, no injection ─────────────────────────────────────
{
  const v = lg.validateMpmViscosity(1000, 1000, undefined, undefined, undefined, 'synthetic')
  check('I1', 'validateMpmViscosity refuses a synthetic 1000 Pa·s, 1000 kg/m³ material (no clamp) with a reason', !v.ok && v.muCode > lg.MPM_MU_CODE_LIMIT && typeof v.reason === 'string', `μ_code ${v.muCode.toFixed(2)}; ${v.ok ? '' : v.reason.slice(0, 80)}…`)
  const t = fresh()
  // (a) the exact call FluidTest's AI handler / FluidEngine.addComposition make, with an explicit high-μ override
  const a = t.add('Synthetic goo', 'X', { C: 0.77, H: 0.12, O: 0.11 }, 20, undefined, undefined, { viscosity: 1000 })
  // (b) an AI-style silicate at 1150 °C (element model → GRD), no override
  const b = t.add('AI basalt', 'basalt', { Si: 0.25, O: 0.44, Fe: 0.08, Al: 0.08, Ca: 0.07, Mg: 0.04, Na: 0.02, K: 0.02 }, 1150)
  const gpu = t.getGpuData()
  const rowA = gpu[a * 4 + 1], rowB = gpu[b * 4 + 1]
  check('I2', 'CompositionTable.add(high-μ synthetic via fluidOverride) → GPU viscosity slot 0 (not raw, not clamped), flagged refused:mpm-viscosity, not spawnable',
    rowA === 0 && t.getSolverProps(a).flags.includes('refused:mpm-viscosity') && !t.isSpawnable(a).ok, `slot ${rowA}; μ_code would be ${t.get(a).mpm.muCode.toFixed(1)}`)
  check('I3', 'AI-style silicate at 1150 °C → slot 0, refused on MPM', rowB === 0 && !t.isSpawnable(b).ok, `μ ${t.getSolverProps(b).muPaS.toFixed(1)} Pa·s, μ_code ${t.get(b).mpm.muCode.toFixed(2)}`)
  let maxY = 0, allFinite = true
  for (let i = 0; i < t.count; i++) {
    for (let k = 0; k < 4; k++) if (!Number.isFinite(gpu[i * 4 + k])) allFinite = false
    maxY = Math.max(maxY, gpu[i * 4 + 1])
  }
  check('I4', `sweep: every uploaded viscosity slot ≤ MPM_MU_CODE_LIMIT and every gpuData value finite (${t.count} compositions)`, allFinite && maxY <= lg.MPM_MU_CODE_LIMIT, `max slot ${maxY.toExponential(3)}`)
  check('I5', 'MPM_MU_CODE_LIMIT = derived lone-particle bound ρ_min/(4·Δt_max) = 0.125/(4 × 0.2) with Δt_max = units.MPM_SUBSTEP_S/TAU_S (not the superseded plan estimate 3.3)',
    same(lg.MPM_DT_CODE, 0.2) && same(lg.MPM_MU_CODE_LIMIT, 0.125 / (4 * lg.MPM_DT_CODE)) && lg.MPM_MU_CODE_LIMIT !== ref.plan_estimates_superseded.mpm_mu_code_limit_ftcs,
    `${lg.MPM_MU_CODE_LIMIT} (Δt ${lg.MPM_DT_CODE}; plan estimate ${lg.MPM_MU_CODE_LIMIT_PLAN_ESTIMATE})`)
  const E = ref.r4_derived_printed.mu_code_examples_2sig
  const sig2 = (x, y) => Number(x.toPrecision(2)) === y
  const wC = lg.mpmViscosityCode(table.getSolverProps(idOf('Water')).muPaS, table.getSolverProps(idOf('Water')).rhoKgM3)
  const oC = lg.mpmViscosityCode(0.084, 911)
  const gC = lg.mpmViscosityCode(table.getSolverProps(idOf('Glycerol')).muPaS, table.getSolverProps(idOf('Glycerol')).rhoKgM3)
  const lC = lg.mpmViscosityCode(193, 2600)
  check('I7', 'mpmViscosityCode = 4μτ/(ρdx²) reproduces r4 §B.4 examples at 2 s.f. (water 5.2e-5, olive oil 4.8e-3, glycerol 5.8e-2, lava 193 Pa·s 3.8)',
    sig2(wC, E.water_20C) && sig2(oC, E.olive_oil) && sig2(gC, E.glycerol_20C) && sig2(lC, E.lava_193Pa_s_2600),
    `${wC.toExponential(3)}, ${oC.toExponential(3)}, ${gC.toExponential(3)}, ${lC.toFixed(3)}`)
  // Every spawnable default uploads exactly the converted coefficient (f32), every refused/hidden one uploads 0.
  const g = table.getGpuData()
  let slotOk = true
  const bad = []
  for (const e of table.getMenuEntries()) {
    const s = table.getSolverProps(e.id)
    const want = e.visibility === 'show' ? Math.fround(lg.mpmViscosityCode(s.muPaS, s.rhoKgM3)) : 0
    if (g[e.id * 4 + 1] !== want) { slotOk = false; bad.push(`${e.id}:${g[e.id * 4 + 1]}≠${want}`) }
  }
  check('I8', 'GPU viscosity slot of each default = f32(mpmViscosityCode(μ, ρ)) when spawnable, 0 when refused/hidden (never raw Pa·s)', slotOk, bad.join(' ') || 'all 12 rows')
  // Invariant: isSpawnable(id,'mpm',t).ok ⇒ t is the registration temperature AND the uploaded row is the accepted μ_code.
  const t4 = fresh()
  const temps = [-50, 0, 15, 20, 25, 80, 100, 400, 1100, 1150, 1200, 1210, 1300]
  let viol = 0, okCount = 0
  for (let id = 0; id < t4.count; id++) {
    const c = t4.get(id)
    for (const tt of [...temps, c.temperature]) {
      if (!t4.isSpawnable(id, 'mpm', tt).ok) continue
      okCount++
      const slot = t4.getGpuData()[id * 4 + 1]
      if (tt !== c.temperature || !(c.spawn.ok && c.mpm.ok) || slot !== Math.fround(c.mpm.muCode) || !(slot > 0)) viol++
    }
  }
  const w30 = t4.spawnIdAt(idOf('Water', t4), 30)
  const lava1210 = t4.spawnIdAt(idOf('Lava', t4), 1210)
  check('I9', "invariant sweep (12 ids × 14 temps): isSpawnable('mpm', t) ok ⇒ t = registration T and the uploaded slot is that row's accepted μ_code; spawnIdAt(Water, 30) accepted with its own row; spawnIdAt(Lava, 1210) refused on MPM",
    viol === 0 && w30.ok && t4.getGpuData()[w30.id * 4 + 1] === Math.fround(t4.get(w30.id).mpm.muCode) && !lava1210.ok,
    `${okCount} ok verdicts, ${viol} violations; Water @ 30 °C slot ${w30.ok ? t4.getGpuData()[w30.id * 4 + 1].toExponential(3) : '-'}`)
}

// ── M. The MPM limit on a float64 CPU replica of the kernels (MEASURED; GPU not yet confirmed) ─────
{
  // M1: minimum own-mass code density over all positions, by scanning cell_diff.
  let minS = Infinity, atD = 0
  for (let k = 0; k <= 4000; k++) {
    const x = 30 + k / 4000 // positions spanning one cell: cell_diff from −0.5 to +0.5
    const s = axisWeights(x).w.reduce((a, w) => a + w * w, 0)
    if (s < minS) { minS = s; atD = x - (Math.floor(x) + 0.5) }
  }
  check('M1', 'ρ_min = min over positions of (Σ_a w_a²)³ = 0.125, at cell_diff = ±½ (scan of 4001 positions) = liquidGate.MPM_MIN_PARTICLE_CODE_DENSITY',
    same(minS ** 3, 0.125) && Math.abs(Math.abs(atD) - 0.5) < 1e-12 && lg.MPM_MIN_PARTICLE_CODE_DENSITY === 0.125, `min Σw² ${minS} at d = ${atD}`)
  const dt = lg.MPM_DT_CODE, L = lg.MPM_MU_CODE_LIMIT
  const sym = [[0.01, 0.002, -0.003], [0.002, -0.004, 0.001], [-0.003, 0.001, 0.02]]
  // M2: lone particle anywhere: sym(C) is multiplied by exactly 1 − 8Δtμ/ρ_p per substep.
  const R = rng(99)
  let worstF = 0
  for (let k = 0; k < 50; k++) {
    const p = [particle([30 + R(), 31 + R(), 29 + R()], [0.01, -0.02, 0.005], sym)]
    const mu = 3 * L * R()
    const C0 = p[0].C[0][0]
    const rho = step(p, { mu, dt })[0]
    worstF = Math.max(worstF, Math.abs(p[0].C[0][0] / C0 - (1 - 8 * dt * mu / rho)))
  }
  check('M2', 'replica, lone particle at random positions and μ: sym(C) factor per substep = 1 − 8Δtμ/ρ_p (the derivation\'s step 3)', worstF < 1e-12, `worst |Δfactor| ${worstF.toExponential(2)}`)
  // M3: the bound is sharp: lone particle at cell_diff = ±½ decays at 0.99 L, grows at 1.01 L.
  const grow = (f) => { const P = [particle([30, 30, 30], [0, 0, 0], sym)]; const c0 = maxAbsC(P); for (let n = 0; n < 100; n++) step(P, { mu: f * L, dt }); return maxAbsC(P) / c0 }
  const g099 = grow(0.99), g101 = grow(1.01)
  check('M3', 'sharpness: lone particle at the worst position, 100 substeps: |C| decays at 0.99 × limit and grows at 1.01 × limit (|1 − 2f|^100)',
    g099 < 1 && Math.abs(g099 / 0.98 ** 100 - 1) < 1e-9 && g101 > 7 && Math.abs(g101 / 1.02 ** 100 - 1) < 1e-9, `0.99×: ${g099.toFixed(4)}, 1.01×: ${g101.toFixed(3)}`)
  // M4: sufficiency on random clusters (1/2/4/8 particles within 2 cells), with advection: the norm Σ(|v|² + ¼|C|²)
  //     never increases at μ = limit (derivation steps 1–2; round-off tolerance 1e-12 per step).
  let worstRatio = 0, runs = 0
  for (const N of [1, 2, 4, 8]) {
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed * 7919 + N)
      const P = []
      for (let n = 0; n < N; n++) P.push(particle([30 + 2 * r(), 30 + 2 * r(), 30 + 2 * r()], [0.1 * (r() - 0.5), 0.1 * (r() - 0.5), 0.1 * (r() - 0.5)], [0, 1, 2].map(() => [0, 1, 2].map(() => 0.2 * (r() - 0.5)))))
      let e = energy(P)
      for (let n = 0; n < 150; n++) { step(P, { mu: L, dt }); const e2 = energy(P); worstRatio = Math.max(worstRatio, e2 / e); e = e2 }
      runs++
    }
  }
  check('M4', `sufficiency: ${runs} random 1/2/4/8-particle clusters × 150 substeps at μ_code = limit (viscous part, advection on): Σ(|v|²+¼|C|²) never increases`,
    worstRatio <= 1 + 1e-12, `worst per-substep ratio ${worstRatio}`)
  // M5: a 6³ block at rest packing (4 ppc, jittered) plus two lone particles at the worst position ("splash").
  const s = 1 / Math.cbrt(lg.MPM_PPC)
  const r5 = rng(5)
  const blk = []
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let k = 0; k < 6; k++) blk.push(particle([30 + (i + 0.5) * s + 0.1 * (r5() - 0.5), 30 + (j + 0.5) * s + 0.1 * (r5() - 0.5), 30 + (k + 0.5) * s + 0.1 * (r5() - 0.5)], [0, 0, 0], [0, 1, 2].map(() => [0, 1, 2].map(() => 0.01 * (r5() - 0.5)))))
  blk.push(particle([40, 40, 40], [0, 0, 0], sym), particle([20, 45, 25], [0, 0, 0], sym))
  let eb = energy(blk), wb = 0
  for (let n = 0; n < 150; n++) { step(blk, { mu: L, dt }); const e2 = energy(blk); wb = Math.max(wb, e2 / eb); eb = e2 }
  check('M5', 'sufficiency: 216-particle block at 4 ppc + 2 lone splash particles, 150 substeps at the limit: norm never increases', wb <= 1 + 1e-12, `worst per-substep ratio ${wb}`)
  // M6 (INFO): with the EOS pressure on (outside the proof), the same block at the limit stays bounded.
  const r6 = rng(6)
  const bp = []
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let k = 0; k < 6; k++) bp.push(particle([30 + (i + 0.5) * s + 0.1 * (r6() - 0.5), 30 + (j + 0.5) * s + 0.1 * (r6() - 0.5), 30 + (k + 0.5) * s + 0.1 * (r6() - 0.5)], [0, 0, 0], [0, 1, 2].map(() => [0, 1, 2].map(() => 0.01 * (r6() - 0.5)))))
  let mc = 0
  for (let n = 0; n < 300; n++) { step(bp, { mu: L, dt, pressure: true }); mc = Math.max(mc, maxAbsC(bp)) }
  info('M6', 'with EOS pressure on (outside the proof): 216-particle block at the limit, 300 substeps, max |C|', mc.toExponential(3))
  // M7 (INFO): consequences of the derived limit for the cited materials.
  const gl = []
  for (let T = 0; T <= 30; T += 0.5) if (lg.mpmViscosityCode(md.glycerolViscosity(T), md.glycerolDensity(T)) <= L) { gl.push(T); break }
  const h14 = table.get(idOf('Honey (14% water)')).mpm.muCode, h20 = table.get(idOf('Honey (20% water)')).mpm.muCode
  info('M7', 'consequences on MPM: honey 14 % / 20 % μ_code; first 0.5 °C step where glycerol is accepted; Kīlauea bulk μ_code', `${h14.toFixed(3)} / ${h20.toFixed(4)}; glycerol from ${gl[0]} °C; Kīlauea ${table.get(idOf('Lava (Kīlauea 2018 bulk)')).mpm.muCode.toFixed(2)}`)
}

// ── Q. Capacity and registration discipline (review finding 2) ────────────────────────────────────
{
  const t = fresh()
  const n0 = t.count
  for (let T = -50; T <= 2000; T += 10) {
    for (let id = 0; id < n0; id++) { t.evaluateAt(id, T, 'mpm'); t.getSolverPropsAt(id, T) }
    t.getMenuEntries('mpm', T)
  }
  check('Q1', 'slider sweep −50…2000 °C step 10 × 12 materials through evaluateAt / getSolverPropsAt / getMenuEntries(method, T) registers nothing', t.count === n0, `count ${t.count}`)
  const a1 = t.spawnIdAt(idOf('Water', t), 30), a2 = t.spawnIdAt(idOf('Water', t), 30), r = t.spawnIdAt(idOf('Water', t), 150)
  check('Q2', 'spawnIdAt registers an accepted temperature once and reuses it; a refused temperature (water 150 °C) registers nothing',
    a1.ok && a2.ok && a1.id === a2.id && !r.ok && t.count === n0 + 1, `count ${t.count}`)
  while (t.count < ct.MAX_COMPOSITIONS) t.add(`filler ${t.count}`, 'x', { C: 0.77, H: 0.12, O: 0.11 }, 20)
  const over = t.add('257th', 'H2O', { H: 0.111, O: 0.889 }, 20) // would be spawnable water but for capacity
  const ov = t.isSpawnable(over)
  const sp = t.spawnIdAt(idOf('Water', t), 40)
  check('Q3', `capacity ${ct.MAX_COMPOSITIONS}: the 257th composition is refused ('capacity'), no row written (gpuData ${t.getGpuData().length} floats, renderData ${t.getRenderData().length}); spawnIdAt at capacity refuses`,
    !ov.ok && /full/.test(ov.reason) && t.getGpuData().length === ct.MAX_COMPOSITIONS * 4 && t.getRenderData().length === ct.MAX_COMPOSITIONS * 8 && !sp.ok && t.get(over).solver.flags.includes('refused:capacity'),
    ov.ok ? 'accepted!' : ov.reason)
}

// ── R. Menu agrees with the slider (review finding 7) ─────────────────────────────────────────────
{
  const t = fresh()
  const m20 = Object.fromEntries(t.getMenuEntries('mpm', 20).map(e => [e.name, e]))
  const want = {
    Water: 'show', Mercury: 'show', 'Olive Oil': 'show', Glycerol: 'show', Ethanol: 'show',
    Salt: 'refused', Iron: 'refused', Lava: 'refused', 'Honey (14% water)': 'refused', 'Honey (20% water)': 'refused', 'Lava (Kīlauea 2018 bulk)': 'refused', Copper: 'hidden',
  }
  const got = Object.entries(want).map(([n, v]) => [n, m20[n]?.visibility, v])
  check('R1', "getMenuEntries('mpm', 20 °C): Water, Mercury, Olive Oil, Glycerol, Ethanol show; Salt, Iron, both lavas, both honeys refused; Copper hidden; honey reports its fixed 25 °C point",
    got.every(([, g, w]) => g === w) && m20['Honey (20% water)'].dataRangeC?.[0] === 25 && m20['Honey (20% water)'].dataRangeC?.[1] === 25,
    got.filter(([, g, w]) => g !== w).map(([n, g]) => `${n}=${g}`).join(', ') || `honey: ${m20['Honey (20% water)'].reason}`)
  const own = Object.fromEntries(t.getMenuEntries('mpm').map(e => [e.name, e.visibility]))
  check('R2', "getMenuEntries('mpm') at each material's own temperature: Honey 20 % shows (25 °C); Honey 14 % refused (μ_code 1.46 > limit)",
    own['Honey (20% water)'] === 'show' && own['Honey (14% water)'] === 'refused')
  t.spawnIdAt(idOf('Water', t), 30)
  check('R3', 'rows created by spawnIdAt are not listed as separate menu entries', t.getMenuEntries('mpm').length === 12, `${t.getMenuEntries('mpm').length} entries`)
  info('R4', "MPM menu at 20 °C (visibility, μ_code)", Object.values(m20).map(e => `${e.name}:${e.visibility}${Number.isFinite(e.muCode) ? `(${e.muCode.toPrecision(2)})` : ''}`).join(' '))
}

// ── L. Lab scenario sweep (INFO for the lead: what checkScene says for each scenario, mirroring loadScenario) ──
{
  const { readdir } = await import('node:fs/promises')
  const labDir = join(REPO, 'company/lab')
  let dirs = []
  try { dirs = (await readdir(labDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort() } catch { /* no lab dir */ }
  let n = 0, nRefused = 0
  for (const d of dirs) {
    let s
    try { s = JSON.parse(await readFile(join(labDir, d, 'scenario.json'), 'utf8')) } catch { continue }
    const t = fresh()
    const idByName = new Map()
    for (const m of s.materials ?? []) {
      idByName.set(m.name, t.add(m.name, m.formula ?? m.name, m.elements, m.temperature ?? s.temperature ?? 20, m.densityOverride, m.renderOverride))
    }
    // Lookup = scenario materials, then findByName over the defaults — the same order FluidEngine.loadScenario uses
    // (a name found in neither refuses the scenario; it no longer falls back to Water).
    const entries = (s.spawns ?? []).map(sp => ({ id: idByName.get(sp.material) ?? t.findByName(sp.material) ?? -1, name: sp.material, byName: !idByName.has(sp.material) }))
    const missing = entries.filter(e => e.id < 0).map(e => e.name)
    const v = missing.length ? { ok: false, reason: `material(s) not found: ${missing.join(', ')}` } : t.checkScene(entries.map(e => ({ id: e.id })), 'mpm')
    n++
    if (!v.ok) nRefused++
    const viaName = entries.some(e => e.byName && e.id >= 0) ? ' [built-in resolved by name]' : ''
    info('L', `scenario ${d}`, (v.ok ? `OK (${entries.map(e => t.get(e.id).name).join(', ')})` : `REFUSED: ${v.reason.slice(0, 150)}`) + viaName)
  }
  info('L*', 'lab scenarios refused by checkScene on MPM', `${nRefused} of ${n}`)
}

// ── J. PropertyCalculator bug flags ───────────────────────────────────────────────────────────────
{
  const bug = pc.debyeFunctionLegacyBuggy(2.79)
  const fe = pc.computeProperties({ elements: { Fe: 1 } }, 20)
  check('J1', 'Debye bug documented (legacy f(2.79) ≈ 1.97, true Debye C_v/3R < 1) and NOT applied: pure Fe c_p = measured table value 449',
    bug > 1.9 && fe.specificHeat === 449, `legacy f(2.79) = ${bug.toFixed(3)}; Fe c_p ${fe.specificHeat}`)
  const w = pc.computeProperties({ elements: { H: 0.111, O: 0.889 } }, 20)
  check('J2', 'PropertyCalculator water branch uses NIST ρ/μ and IAPWS σ at 20 °C', w.density === md.waterDensity(20) && w.viscosity === md.waterViscosity(20) && w.surfaceTension === md.waterSurfaceTension(20) && w.unsourcedReason === null,
    `ρ ${w.density}, μ ${w.viscosity}, σ ${w.surfaceTension.toFixed(5)}`)
  check('J3', 'no placeholder viscosities: solid iron → NaN + solid:no-viscosity (was 1e6 Pa·s)', Number.isNaN(fe.viscosity) && fe.flags.includes('solid:no-viscosity'))
  const sHot = pc.eötvösSurfaceTension(55.845, 7000, 1000, 1500, 0, 0)
  const sLin = pc.eötvösSurfaceTension(55.845, 7000, 2861, 10000, 1.93, 1538)
  check('J4', 'no display clamps: Eötvös / linear σ laws return NaN (not a 0.001 N/m floor) outside their range', Number.isNaN(sHot) && Number.isNaN(sLin), `${sHot}, ${sLin}`)
}

// ── K. Backward compatibility of the existing CompositionTable API ─────────────────────────────────
{
  const all = table.getAll()
  const legacyOrder = ['Water', 'Salt', 'Iron', 'Copper', 'Mercury', 'Olive Oil', 'Lava']
  check('K1', 'add/addDefaults/get/getAll/getGpuData/getRenderData intact; default ids 0–6 keep their order',
    table.getGpuData().length === 1024 && table.getRenderData().length === 2048 && all.length === 12
      && legacyOrder.every((n, i) => table.get(i)?.name === n) && table.find({ H: 0.111, O: 0.889 }) === 0,
    all.map(c => `${c.id}:${c.name}`).join(' '))
}

const fails = results.filter(r => r.status === 'FAIL').length
const passes = results.filter(r => r.status === 'PASS').length
if (JSON_OUT) console.log(JSON.stringify({ gate: 'materials', passes, fails, results }, null, 1))
else console.log(`\nmaterials gate: ${passes} PASS, ${fails} FAIL, ${results.length - passes - fails} INFO`)
process.exit(fails === 0 ? 0 : 1)
