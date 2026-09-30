#!/usr/bin/env node
// OBS-1 T1-report — the Taylor–Green bulk-damping table of the PRODUCTION GPU solver (vault fluid/realism-2026-09/
// EXTENDED-ROADMAP.md §5.3 1a; research/x3-turbulence-damping.md §6). Instruments only, no physics change.
//
//   node scripts/fluid-gates/obs1-t1.mjs [--record] [--only=table|meter]      (default server: the clean gate tree)
//
// Setup (fixed before the first run): flip-selftest taylorGreen (src/bench/flipSelftest/obs1.ts) — a closed, fully
// liquid 64 × 64 × 8-cell water slab, g = 0, ZERO physical viscosity, the 2-D Taylor–Green mode with its APIC affine
// matrix; the page's solver settings (MGPCG, ghost surface, variable density, density projection, default tolerances and
// caps). ν_num = −slope(ln A)/(2k²) over 2 s (A: the particle velocities' projection on the mode, 12 samples).
// Sweep: λ = 16 / 32 / 64 cells × U = 0.1 / 0.5 / 2 m/s × Δt = 1/60, 1/120, 1/240 s — 27 runs.
// Checks:
//   T1-clean  every run solver-clean: 0 breakdowns (cap hits reported);
//   T1-decay  every run decays (ν_num > 0 and A(end) < A(0)) — a growing mode is a defect, not a number;
//   T1-store  against the committed baseline scripts/fluid-gates/baselines/obs1-t1.json: no ν_num above 1.10 × its stored
//             value (a later change may not raise the bulk damping by more than 10 %). --record (re)writes the baseline:
//             the first run, or a deliberate re-baseline that decisions.md records. Without a baseline the check is
//             "not yet recorded" and the gate fails (a table nobody stored guards nothing).
// Reported: the table (ν_num, the end-point value, cap hits); the cross-check against X3's 2-D proxy — Table E, APIC at
// the plan's operating step (U 0.1 / 0.5 / 2 m/s at 1/60 s, 16 and 32 cells/λ): the ratio, flagged OUTSIDE 2× → "find out
// why" (the roadmap's instruction: an investigation item, not a physics verdict — the proxy is a different 2-D code);
// the HUD number "effective viscosity ≈ N × water" (ν_water 1.0e-6 m²/s at 20 °C) per row.
// Revision 1 (2026-09-29 22:34 — its commit 83726b1d; after the first run, before its re-run): the closed, fully liquid box violates the GPU
// PoissonSolver's contract (every liquid region must touch AIR — PoissonSolver.ts header; the CPU reference pins the
// mean, the GPU solver does not). The density projection's ψ solve — its right-hand side, the density error, is not
// mean-free in a closed box — ran to its cap hundreds of times and its displacements wrecked the mode in some rows
// (collapse to A ≈ 0 in 0.08 s; a sign reversal at 1.3 s); with ψ off every such row decayed cleanly (scratch
// tg_series). The density projection moves positions to restore density — it is not a momentum operator — so T1 runs
// with it OFF and measures the bulk damping of the transfer, advection and pressure-projection chain (the pressure
// solve's right-hand side, a divergence, sums to zero in a closed box: consistent). T1-decay now also requires
// A(t) > 0 throughout (the first version missed the sign reversal), and --record refuses a table with failed rows.
// GPU closed-domain support (the mean of b removed, as the CPU reference does) is a separate solver item.
// Revision 2 (2026-09-29 22:48 — its commit 627d712b; before its first run): T1-meter — roadmap §5.3 1b, X3 §4.1(a): "with the viscous solve
// forced on at ν = 1e-3 (glycerol-like), recover ν within 5% at U = 0.1 m/s", with free-slip viscous walls (S3N-3's flag;
// in the lab ViscositySolver.walls = +1 on every axis — Taylor–Green is exact only with stress-free walls). Setup
// (flip-selftest viscTaylorGreen, the S3.6a scene): a closed, fully liquid L × L × 4-cell box, water's density,
// μ = ν·ρ, half a wavelength across the box (k = π/(L·Δx): L = 8 / 16 / 32 cells ↔ λ = 16 / 32 / 64 cells, the table's λ),
// U = 0.1 m/s, Δt = 1/120 s, the page's (production) solver tolerances, density projection off (a closed box: revision 1).
// Each L runs twice, the viscous solve on and off, for T = 0.1/(νk²) — the imposed viscosity alone lowers ln A by 0.2 over
// the run (2.1 / 8.3 / 33.4 s). "Recovered" is X3's additivity definition (x3 §2.4 caveat 5; the S3.6a form):
// ν_rec = ν_eff(on) − ν_num(off) at the same U, λ, Δt and T.
//   T1-meter-λ  |ν_rec/ν − 1| ≤ 5 %, and both runs solver-clean: 0 breakdowns (pressure, ψ, viscous), 0 viscous PCG cap
//               hits, pressure cap hits ≤ 1 % of solves (as S3.6a).
// Reported: ν_eff(on)/ν (the total an observer sees: physical + numerical); ν_num(off) beside the table's (λ, 0.1 m/s,
// 1/120 s) row (a different box — one half-wave, not the 64 × 64 × 8 slab — so reported, not compared); the discrete
// operator's expected bias sin²(kΔx/2)/(kΔx/2)² − 1 = −1.3 / −0.3 / −0.1 %; the viscous PCG iterations.
// Pre-stated readings: all three pass → the meter recovers an imposed viscosity at the lab's λ and Δt, and at low speed
// the table's ν_num adds to physical viscosity (the HUD line's reading holds). A failure that grows with L — the
// per-step viscous change 2νk²Δt = 8e-4 / 2e-4 / 5e-5 against the viscous PCG's ‖r‖ ≤ 1e-5·‖b‖ stop — is a
// viscous-tolerance item, diagnosed separately (the tolerance is not changed here). A failure at L = 8, where ν_num ≈ 0.9 ν,
// is an additivity failure (the transfer damping and the viscous solve interact), reported to X3.
// Revision 3 (2026-09-29 22:53, the commit that adds it; before its first run): OBS-1 item 3 — D2 interpreted against T1
// (roadmap §5.3 item 3: "comparing D2 with T1 at the same λ and U separates surface damping from bulk damping").
// Reported, not gated. D2 (S3.4, s34-gpu) measures ν_num = 1.12e-3 m²/s from the E_K envelope of the H/dx = 28 standing
// wave (L = 56 cells, Δt = 1/120 s). This section runs the T1 Taylor–Green slab at that wave's λ = 56 cells (a 56 × 56 × 8
// slab: λ must divide 2n), Δt = 1/120 s, 2 s, ψ off, at U = εHgk/(2ω) = 0.175 m/s — the wave's initial surface speed
// amplitude, its fastest point (the speed falls with depth as cosh, to 0.09× at the bed) — and at U = 0.1 m/s. ν_num rises
// with U in every column of the table at 1/120 s, so the 0.175 m/s value bounds the wave's bulk damping from above and
// 1 − ν_T1/ν_D2 bounds the non-bulk share (free surface, walls, a potential rather than a vortical flow) from below.
// The D2 value is read from the newest clean-tree s34-gpu report in bench-results/gates and printed with its provenance.
// --only=table|meter|d2 runs those sections (a diagnostic run; the report records it). --record needs the table.
import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { windowArgs } from '../lib/window.mjs'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RECORD = process.argv.includes('--record')
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',') ?? null
for (const s of ONLY ?? []) if (!['table', 'meter', 'd2'].includes(s)) throw new Error(`--only: unknown section "${s}" (table, meter, d2)`)
const want = s => !ONLY || ONLY.includes(s)
if (RECORD && !want('table')) throw new Error('--record needs the table section')
const BASELINE = path.join(repoRoot, 'scripts', 'fluid-gates', 'baselines', 'obs1-t1.json')
const gate = makeGate('OBS-1 T1-report (Taylor–Green bulk damping of the production solver)')
const report = { prov: await provenance(), only: ONLY, rows: [], meter: [], d2: null }
const NU_WATER = 1.0e-6
// X3 Table E (research/x3-turbulence-damping.md; 2-D proxy, APIC at the plan's operating step): key `${U}|${dt}|${λ}`
const X3E = { '0.1|60|16': 4.8e-4, '0.1|60|32': 1.7e-4, '0.5|60|16': 9.2e-4, '0.5|60|32': 6.5e-4, '2|60|16': 4.5e-3, '2|60|32': 6.4e-3 }
const LAMBDAS = [16, 32, 64], US = [0.1, 0.5, 2], DTS = [60, 120, 240]

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: [...windowArgs(), '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation/i.test(m.text()))) errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
  await page.goto(`${BASE}/flip-selftest.html`, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__flipTest && (window.__flipTest.ready || window.__flipTest.error), null, { timeout: 90_000 })
  const init = await page.evaluate(() => ({ err: window.__flipTest.error, info: window.__flipTest.info() }))
  if (init.err) throw new Error(`self-test page init failed: ${init.err}`)
  if (init.info.vendor !== 'nvidia') throw new Error(`adapter is ${init.info.vendor}, not the NVIDIA dGPU`)
  report.adapter = init.info
  const run = (t, p = {}) => page.evaluate(([t, p]) => window.__flipTest.run(t, p), [t, p])
  if (want('table')) {
    for (const lambdaCells of LAMBDAS) for (const U of US) for (const hz of DTS) {
      const r = await run('taylorGreen', { lambdaCells, U, dt: 1 / hz, densityProjection: false })   // revision 1 (header)
      const x3 = X3E[`${U}|${hz}|${lambdaCells}`]
      const row = { lambdaCells, U, hz, nuNum: r.nuNum, nuEnd: r.nuEnd, aEnd: r.As.at(-1) / r.As[0], aMin: Math.min(...r.As) / r.As[0], capHits: r.capHits, psiCapHits: r.psiCapHits, breakdowns: r.breakdowns, x3: x3 ?? null, particles: r.particles }
      report.rows.push(row)
      console.log(`  λ ${String(lambdaCells).padStart(2)} cells  U ${String(U).padEnd(3)} m/s  Δt 1/${hz}: ν_num ${r.nuNum.toExponential(2)} m²/s (end-point ${r.nuEnd.toExponential(2)}; ≈ ${Math.round(r.nuNum / NU_WATER)} × water); A(2 s)/A0 ${row.aEnd.toFixed(4)}; p caps ${r.capHits}, ψ caps ${r.psiCapHits}, breakdowns ${r.breakdowns}${x3 ? `; X3 2-D proxy ${x3.toExponential(1)} (× ${(r.nuNum / x3).toFixed(2)}${r.nuNum / x3 > 2 || r.nuNum / x3 < 0.5 ? ' — OUTSIDE 2×: find out why' : ''})` : ''}`)
    }
    const rows = report.rows
    gate.check(rows.every(r => r.breakdowns === 0), `T1-clean: 0 solver breakdowns in all ${rows.length} runs (cap hits: p ${rows.reduce((s, r) => s + r.capHits, 0)}, ψ ${rows.reduce((s, r) => s + r.psiCapHits, 0)})`)
    const grow = rows.filter(r => !(r.nuNum > 0 && r.aEnd < 1 && r.aMin > 0))
    gate.check(grow.length === 0, `T1-decay: every mode decays (ν_num > 0, A(end) < A0, A(t) > 0 throughout — no sign reversal)${grow.length ? ` — ${grow.length} do not: ${grow.map(r => `λ${r.lambdaCells}/U${r.U}/1/${r.hz}`).join(', ')}` : ''}`)
    const key = r => `${r.lambdaCells}|${r.U}|${r.hz}`
    if (RECORD) {
      // revision 1: a baseline is only written from a table whose every row passed T1-decay and T1-clean
      if (grow.length || !rows.every(r => r.breakdowns === 0)) console.log('  NOT recording: the table has rows that failed T1-decay or T1-clean — a baseline must be valid')
      else {
        mkdirSync(path.dirname(BASELINE), { recursive: true })
        writeFileSync(BASELINE, JSON.stringify({ recorded: new Date().toISOString(), prov: report.prov, rows: rows.map(r => ({ key: key(r), nuNum: r.nuNum })) }, null, 1))
        console.log(`  recorded the baseline → ${path.relative(repoRoot, BASELINE)}`)
      }
    }
    if (!existsSync(BASELINE)) gate.check(false, 'T1-store: no stored baseline (run once with --record, and commit it)')
    else {
      const base = new Map(JSON.parse(readFileSync(BASELINE, 'utf8')).rows.map(r => [r.key, r.nuNum]))
      const worse = rows.filter(r => base.has(key(r)) && r.nuNum > 1.10 * base.get(key(r)))
      const missing = rows.filter(r => !base.has(key(r)))
      gate.check(worse.length === 0 && missing.length === 0, `T1-store: no ν_num above 1.10 × the stored table (${rows.length} rows)${worse.length ? ` — raised: ${worse.map(r => `${key(r)} × ${(r.nuNum / base.get(key(r))).toFixed(2)}`).join(', ')}` : ''}${missing.length ? ` — ${missing.length} rows not in the baseline` : ''}`)
    }
    const cross = rows.filter(r => r.x3)
    console.log(`[reported] cross-check vs X3 Table E (2-D proxy): ${cross.map(r => `λ${r.lambdaCells}/U${r.U}: × ${(r.nuNum / r.x3).toFixed(2)}`).join('; ')}${cross.some(r => r.nuNum / r.x3 > 2 || r.nuNum / r.x3 < 0.5) ? ' — some OUTSIDE 2×: an investigation item (roadmap §5.3 1a)' : ' — all within 2×'}`)
  }
  if (want('meter')) {
    // revision 2 (header): T1-meter, X3 §4.1(a) / roadmap §5.3 1b
    const NU = 1e-3, UM = 0.1, DXB = 3.63 / 64
    const table = existsSync(BASELINE) ? new Map(JSON.parse(readFileSync(BASELINE, 'utf8')).rows.map(r => [r.key, r.nuNum])) : new Map()
    for (const cells of [8, 16, 32]) {
      const k = Math.PI / (cells * DXB), seconds = 0.1 / (NU * k * k), lam = 2 * cells
      const p = { cells, material: 'custom', nu: NU, U: UM, seconds, density: false }
      const on = await run('viscTaylorGreen', { ...p, on: true }), off = await run('viscTaylorGreen', { ...p, on: false })
      const rec = on.nuEff - off.nuEff, err = rec / on.nu - 1, bias = Math.sin(k * DXB / 2) ** 2 / (k * DXB / 2) ** 2 - 1
      const vf = on.viscFaults ?? { solves: 0, capHits: -1, breakdowns: -1, maxIterations: 0 }
      const brk = on.breakdowns + on.psiBreakdowns + off.breakdowns + off.psiBreakdowns + Math.max(0, vf.breakdowns)
      const clean = brk === 0 && vf.solves > 0 && vf.capHits === 0 && vf.breakdowns === 0 && on.capHits <= 0.01 * on.solves && off.capHits <= 0.01 * off.solves
      const t1 = table.get(`${lam}|0.1|120`)
      report.meter.push({ cells, lambdaCells: lam, seconds, steps: on.steps, nu: on.nu, nuOn: on.nuEff, nuOff: off.nuEff, rec, err, bias, viscFaults: vf, viscIterations: on.viscIterations, capOn: on.capHits, solvesOn: on.solves, capOff: off.capHits, solvesOff: off.solves, breakdowns: brk, t1Row: t1 ?? null, ysOn: on.ys, ysOff: off.ys })
      gate.check(Math.abs(err) <= 0.05 && clean, `T1-meter λ ${lam} cells (L = ${cells}, ${seconds.toFixed(1)} s, ${on.steps} steps): ν_eff(on) ${on.nuEff.toExponential(3)} − ν_num(off) ${off.nuEff.toExponential(3)} = ${rec.toExponential(3)} m²/s vs ν ${on.nu.toExponential(3)} → ${(100 * err).toFixed(2)} % (±5 %; the operator's expected ${(100 * bias).toFixed(2)} %); viscous PCG ${vf.solves} solves, ${vf.capHits} cap hits, ≤ ${vf.maxIterations} it; pressure caps ${on.capHits}/${on.solves} on, ${off.capHits}/${off.solves} off; breakdowns ${brk}`)
      console.log(`  [reported] λ ${lam}: total ν_eff(on)/ν ${(on.nuEff / on.nu).toFixed(3)}; ν_num(off) ${off.nuEff.toExponential(3)}${t1 ? ` (the table's λ ${lam} / 0.1 m/s / 1/120 s row: ${t1.toExponential(3)} — the 64 × 64 × 8 slab, a different box)` : ''}`)
    }
  }
  if (want('d2')) {
    // revision 3 (header): D2 against T1 at the wave's λ, U and Δt — reported
    const G = 9.80665, DXB = 3.63 / 64, H = 28 * DXB, kw = 2 * Math.PI / (56 * DXB), om = Math.sqrt(G * kw * Math.tanh(kw * H))
    const Us = 0.05 * H * G * kw / (2 * om)
    const dir = path.join(repoRoot, 'bench-results', 'gates')
    const s34 = existsSync(dir) ? readdirSync(dir).filter(f => /^s34-gpu-.*\.json$/.test(f)).sort().reverse()
      .map(f => ({ f, r: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) })).find(x => x.r.provenance?.attributable && x.r.d2?.nu28 > 0) : null
    const d2 = s34 ? s34.r.d2.nu28 : null
    report.d2 = { Us, d2, d2Report: s34?.f ?? null, d2Sha: s34?.r.provenance.sha ?? null, rows: [] }
    for (const U of [Us, 0.1]) {
      const r = await run('taylorGreen', { lambdaCells: 56, U, dt: 1 / 120, cells: [56, 56, 8], densityProjection: false })
      report.d2.rows.push({ U, nuNum: r.nuNum, nuEnd: r.nuEnd, aMin: Math.min(...r.As) / r.As[0], capHits: r.capHits, breakdowns: r.breakdowns })
      console.log(`  [reported] D2 vs T1: λ 56 cells, U ${U.toFixed(3)} m/s, Δt 1/120: ν_T1 ${r.nuNum.toExponential(3)} m²/s (end-point ${r.nuEnd.toExponential(3)}; min A/A0 ${(Math.min(...r.As) / r.As[0]).toFixed(3)}; p caps ${r.capHits}, breakdowns ${r.breakdowns})${d2 ? ` — D2 ${d2.toExponential(3)} (${s34.f}, ${s34.r.provenance.sha.slice(0, 8)}): bulk share ≤ ${(100 * r.nuNum / d2).toFixed(1)} %, non-bulk ≥ ${(100 * (1 - r.nuNum / d2)).toFixed(1)} %` : ' — no clean-tree s34-gpu report with D2 found'}`)
    }
  }
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'obs1-t1', pass, report, gate.results)
process.exit(pass ? 0 : 1)
