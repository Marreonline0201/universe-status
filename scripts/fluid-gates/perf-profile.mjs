#!/usr/bin/env node
// perf-profile.mjs — PERF-1's baseline (vault fluid/realism-2026-09/EXTENDED-ROADMAP.md §5.34; S3N-23 "a per-kernel
// dispatch budget"): what one frame of the FLUID TEST page's simulation costs, pass by pass. REPORT, not a gate.
//
//   node scripts/fluid-gates/perf-profile.mjs        (default server: the clean gate tree; FLUID_BASE to override)
//
// Method: the bench hook profileStep() (src/bench/stepProfiler.ts) wraps the command encoder of the NEXT frame's
// simulation step — every compute pass gets begin/end timestamp writes, every dispatch (direct/indirect), encoder copy
// and queue.writeBuffer is counted per pass label, the CPU encode is timed; the same kernels run. Five consecutive frames
// per scene after 1 s of settling (lockstep 1/60 s); medians reported. Scenes: the S3.1c water pool (3.63 × 0.17 m,
// 82k), the B1 scene (water + olive oil + mercury, the drift on, at 2 s), a 30 cm water pool with the ball, and a 30 cm
// lava pool (1100 °C) with the ball — the unified Stokes solve (s36e-page's scene). Chrome with unquantized timestamps
// (--enable-webgpu-developer-features), the window on the PRIMARY display (a timing run), on AC only.
// Reported per scene: substeps per frame; passes, dispatches, indirect dispatches, copies, uploads per frame; CPU encode
// ms; Σ pass GPU µs and the first-to-last span; the top passes by GPU time with their dispatch counts — the per-kernel
// dispatch budget table PERF-1's cuts are measured against (report "dispatches per frame ... before and after").
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { powerState, describePower } from '../lib/power.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const L = 3.63, R = 0.05 * L
const box = (m, h, extra = {}) => ({ material: m, box: { min: [0, 0, 0], max: [3.63, h, 3.63] }, ...extra })
const SCENES = [
  { name: 'water pool 17 cm', at: 60, scene: { name: 'perf-pool', materials: [], gravity_mps2: G_STANDARD, spawns: [box('Water', 0.17)] } },
  { name: 'B1 water + oil + mercury (drift)', at: 120, scene: { name: 'perf-b1', materials: [], gravity_mps2: G_STANDARD, spawns: [box('Water', 0.17),
    { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } }, { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] } },
  { name: 'water pool 30 cm + ball', at: 60, scene: { name: 'perf-ball-water', materials: [], gravity_mps2: G_STANDARD, spawns: [box('Water', 0.30)], ball: { center: [0.5, (0.30 + R + 0.02) / L, 0.5], radius: 0.05 } } },
  { name: 'lava pool 30 cm (1100 °C) + ball (Stokes)', at: 60, scene: { name: 'perf-ball-lava', materials: [], gravity_mps2: G_STANDARD, spawns: [box('Lava', 0.30, { temperature: 1100 })], ball: { center: [0.5, (0.30 + R + 0.02) / L, 0.5], radius: 0.05 } } },
]
const FRAMES = 5
const med = v => { const q = [...v].sort((a, b) => a - b); return q.length ? q[Math.floor(q.length / 2)] : NaN }

const power = powerState()
console.log(`power: ${describePower(power)}`)
if (power.ac !== true) { console.error('refusing: a timing report runs on AC only (owner rule 2026-09-29; OPT-1-cov revision 3)'); process.exit(3) }
const prov = await provenance()
const { browser, page, errors, adapter } = await openFluidPage(undefined, { timing: true, gpuTimestamps: true })
const out = { prov, adapter, power: { start: power }, scenes: [] }
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  for (const sc of SCENES) {
    await loadScenario(page, sc.scene, 1)
    await sampleAtFrame(page, sc.at)
    const profs = []
    for (let f = 0; f < FRAMES; f++) {
      const pr = page.evaluate(() => window.__fluidBench.profileStep())
      await page.evaluate(n => window.__fluidBench.setStepLimit(n), sc.at + f + 1)
      profs.push(await pr)
    }
    const st = await page.evaluate(() => window.__fluidBench.status())
    const m = k => med(profs.map(p => p[k]))
    const labels = new Map()
    for (const p of profs) for (const r of p.byLabel) { const e = labels.get(r.pass) ?? { us: [], passes: r.passes, dispatches: r.dispatches }; e.us.push(r.us); labels.set(r.pass, e) }
    const top = [...labels.entries()].map(([pass, e]) => ({ pass, us: med(e.us), passes: e.passes, dispatches: e.dispatches })).sort((a, b) => b.us - a.us)
    const row = { name: sc.name, particles: st.count ?? null, substeps: m('substeps'), passes: m('passes'), dispatches: m('dispatches'), indirect: m('indirect'), copies: m('copies'), uploads: m('uploads'), encodeMs: m('encodeMs'), gpuSumUs: m('gpuSumUs'), gpuSpanUs: m('gpuSpanUs'), untimed: m('untimedPasses'), top }
    out.scenes.push(row)
    console.log(`\n${sc.name}: ${row.particles ?? '?'} particles, ${row.substeps} substeps/frame — ${row.passes} passes, ${row.dispatches} dispatches (${row.indirect} indirect), ${row.copies} copies, ${row.uploads} uploads per frame; CPU encode ${row.encodeMs.toFixed(2)} ms; GPU Σ passes ${(row.gpuSumUs / 1000).toFixed(2)} ms, span ${(row.gpuSpanUs / 1000).toFixed(2)} ms${row.untimed ? `; ${row.untimed} passes untimed (query set full)` : ''}`)
    for (const t of top.slice(0, 15)) console.log(`   ${t.pass.padEnd(34)} ${(t.us / 1000).toFixed(3).padStart(7)} ms  ${String(t.passes).padStart(4)} passes  ${String(t.dispatches).padStart(5)} dispatches`)
  }
} finally { await browser.close() }
out.power.end = powerState()
out.errors = errors
console.log(`\npower: start ${describePower(out.power.start)}; end ${describePower(out.power.end)}; console errors ${errors.length}`)
const dir = path.join(repoRoot, 'bench-results', 'studies'); mkdirSync(dir, { recursive: true })
const file = path.join(dir, `perf-profile-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
writeFileSync(file, JSON.stringify(out, null, 1))
console.log(`→ ${path.relative(repoRoot, file)}`)
