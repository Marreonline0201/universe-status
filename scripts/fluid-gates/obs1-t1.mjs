#!/usr/bin/env node
// OBS-1 T1-report — the Taylor–Green bulk-damping table of the PRODUCTION GPU solver (vault fluid/realism-2026-09/
// EXTENDED-ROADMAP.md §5.3 1a; research/x3-turbulence-damping.md §6). Instruments only, no physics change.
//
//   node scripts/fluid-gates/obs1-t1.mjs [--record]      (default server: the clean gate tree)
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
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { windowArgs } from '../lib/window.mjs'
import { CHROME, BASE, provenance, writeReport, makeGate } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RECORD = process.argv.includes('--record')
const BASELINE = path.join(repoRoot, 'scripts', 'fluid-gates', 'baselines', 'obs1-t1.json')
const gate = makeGate('OBS-1 T1-report (Taylor–Green bulk damping of the production solver)')
const report = { prov: await provenance(), rows: [] }
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
  for (const lambdaCells of LAMBDAS) for (const U of US) for (const hz of DTS) {
    const r = await run('taylorGreen', { lambdaCells, U, dt: 1 / hz })
    const x3 = X3E[`${U}|${hz}|${lambdaCells}`]
    const row = { lambdaCells, U, hz, nuNum: r.nuNum, nuEnd: r.nuEnd, aEnd: r.As.at(-1) / r.As[0], capHits: r.capHits, psiCapHits: r.psiCapHits, breakdowns: r.breakdowns, x3: x3 ?? null, particles: r.particles }
    report.rows.push(row)
    console.log(`  λ ${String(lambdaCells).padStart(2)} cells  U ${String(U).padEnd(3)} m/s  Δt 1/${hz}: ν_num ${r.nuNum.toExponential(2)} m²/s (end-point ${r.nuEnd.toExponential(2)}; ≈ ${Math.round(r.nuNum / NU_WATER)} × water); A(2 s)/A0 ${row.aEnd.toFixed(4)}; p caps ${r.capHits}, ψ caps ${r.psiCapHits}, breakdowns ${r.breakdowns}${x3 ? `; X3 2-D proxy ${x3.toExponential(1)} (× ${(r.nuNum / x3).toFixed(2)}${r.nuNum / x3 > 2 || r.nuNum / x3 < 0.5 ? ' — OUTSIDE 2×: find out why' : ''})` : ''}`)
  }
  const rows = report.rows
  gate.check(rows.every(r => r.breakdowns === 0), `T1-clean: 0 solver breakdowns in all ${rows.length} runs (cap hits: p ${rows.reduce((s, r) => s + r.capHits, 0)}, ψ ${rows.reduce((s, r) => s + r.psiCapHits, 0)})`)
  const grow = rows.filter(r => !(r.nuNum > 0 && r.aEnd < 1))
  gate.check(grow.length === 0, `T1-decay: every mode decays (ν_num > 0, A(end) < A0)${grow.length ? ` — ${grow.length} do not: ${grow.map(r => `λ${r.lambdaCells}/U${r.U}/1/${r.hz}`).join(', ')}` : ''}`)
  const key = r => `${r.lambdaCells}|${r.U}|${r.hz}`
  if (RECORD) {
    mkdirSync(path.dirname(BASELINE), { recursive: true })
    writeFileSync(BASELINE, JSON.stringify({ recorded: new Date().toISOString(), prov: report.prov, rows: rows.map(r => ({ key: key(r), nuNum: r.nuNum })) }, null, 1))
    console.log(`  recorded the baseline → ${path.relative(repoRoot, BASELINE)}`)
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
  const info = await page.evaluate(() => window.__flipTest.info())
  gate.check(info.gpuErrors.length === 0, `GPU: ${info.gpuErrors.length} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'obs1-t1', pass, report, gate.results)
process.exit(pass ? 0 : 1)
