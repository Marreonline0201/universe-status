#!/usr/bin/env node
// b1c-driftform.mjs — the same-commit control for the face counter-flux (decisions.md 2026-09-30 01:32: "the legacy kernel
// behind a bench switch as the same-commit control"). S3.1c at `2dc02d21` (face form, the default) measured the B1c
// displacement budget at D_dp(never-exposed) +0.012 / exposed −0.099 and B1c-T Λ 0.99–1.04, against +0.39 / −0.55 and
// Λ 0.69–0.79 with the cell form at `0370b2f5`. Between those commits more than the form changed, so the attribution needs
// both forms at ONE commit, one seed, one page session.
//
//   node scripts/studies/b1c-driftform.mjs      (default server: the clean gate tree; AC only — a GPU run)
//
// Method (pre-registered 2026-09-30 02:18 at `2dc02d21`, before the first run): the B1 scene of s31c-page (seed 2), the
// dense window of lib/b1cSuccessors.mjs (1/240 s frames, the validity floor ≥ 100 of 120 single-substep frames; a VOID
// run is repeated, up to 5 attempts per arm), arms interleaved cell, face, cell, face, … until each has 3 valid runs;
// configure({ immDriftForm }) before each run (the backend re-applies it on every load). Reported per arm and run: the
// budget per stratum (D_dp, D_a, Λ_native, U) and B1c-T by stratum.
// Reading, fixed now (the thresholds are NOT derived: they split the two measured regimes, +0.39 and +0.012):
//   ATTRIBUTED      mean D_dp(never) ≥ +0.25 in the cell arm AND ≤ +0.10 in the face arm → the per-cell counter-flux
//                   caused the never-exposed anomaly, and the face form removes it at the same commit.
//   NOT REPRODUCED  the cell arm's mean D_dp(never) < +0.25 → the old anomaly does not reproduce here; the face result
//                   is not attributable to the form (something else changed between 0370b2f5 and 2dc02d21).
//   PARTIAL         anything else.
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openFluidPage, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { b1cDense } from '../fluid-gates/lib/b1cSuccessors.mjs'
import { powerState, describePower } from '../lib/power.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const scene = { name: 's31c-buoyancy', materials: [], gravity_mps2: G_STANDARD, spawns: [
  { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } },
  { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } },
  { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] }
const STRATA = ['all', 'never', 'exposed', 'row0', 'row1']
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v))
const mean = v => v.reduce((a, b) => a + b, 0) / v.length
const onAC = () => { const p = powerState(); return { ok: p.ac === true, text: describePower(p) } }

const p0 = onAC()
console.log(`power: ${p0.text}`)
if (!p0.ok) { console.error('refusing: a GPU run waits for AC (the owner\'s power rule)'); process.exit(3) }
const prov = await provenance()
const out = { prov, arms: { cell: { valid: [], attempts: [] }, face: { valid: [], attempts: [] } } }
const { browser, page, errors, adapter } = await openFluidPage()
out.adapter = adapter
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  const order = ['cell', 'face']
  let turn = 0
  while (order.some(f => out.arms[f].valid.length < 3 && out.arms[f].attempts.length < 5)) {
    const form = order[turn++ % 2], arm = out.arms[form]
    if (arm.valid.length >= 3 || arm.attempts.length >= 5) continue
    if (!onAC().ok) { console.error('STOP: not on AC'); out.stopped = 'power'; break }
    await page.evaluate(f => window.__fluidBench.configure({ immDriftForm: f }), form)
    const d = await b1cDense(page, scene, 2)
    const form2 = (await page.evaluate(() => window.__fluidBench.status())).immiscible?.form ?? null
    arm.attempts.push({ usable: d.usable, frames: d.frames, valid: d.valid, formReported: form2 })
    const line = STRATA.map(st => { const b = d.budget?.[st]; return b ? `${st} D_dp ${f3(b.Ddp)} D_a ${f3(b.Da)} Λ ${f3(b.lambdaNative)} U ${f3(b.U)}` : `${st} —` }).join('; ')
    console.log(`${form} attempt ${arm.attempts.length}: ${d.valid ? 'VALID' : 'VOID'} (${d.usable}/${d.frames} single-substep; status form ${form2}) — ${line}; B1c-T Λ ${f3(d.T?.lambda)}`)
    if (d.valid) arm.valid.push({ budget: d.budget, strata: d.strata, T: d.T, set: d.set })
  }
} finally { await browser.close() }
out.errors = errors
const summary = {}
for (const form of ['cell', 'face']) {
  const v = out.arms[form].valid
  summary[form] = Object.fromEntries(STRATA.map(st => [st, v.length ? { Ddp: mean(v.map(r => r.budget[st].Ddp)), lambda: mean(v.map(r => r.budget[st].lambdaNative)) } : null]))
  console.log(`\n${form} arm: ${v.length} valid of ${out.arms[form].attempts.length} attempts — ${STRATA.map(st => summary[form][st] ? `${st} D_dp ${f3(summary[form][st].Ddp)} Λ ${f3(summary[form][st].lambda)}` : `${st} —`).join('; ')}`)
}
const cellNever = summary.cell.never?.Ddp, faceNever = summary.face.never?.Ddp
const enough = out.arms.cell.valid.length === 3 && out.arms.face.valid.length === 3
out.reading = !enough ? 'INCOMPLETE (fewer than 3 valid runs per arm)' : cellNever >= 0.25 && faceNever <= 0.10 ? 'ATTRIBUTED' : cellNever < 0.25 ? 'NOT REPRODUCED' : 'PARTIAL'
console.log(`\nreading: ${out.reading} (cell mean D_dp(never) ${f3(cellNever)}, face ${f3(faceNever)}; pre-registered: ATTRIBUTED iff cell ≥ +0.25 and face ≤ +0.10); console errors ${errors.length}; provenance ${prov.sha?.slice(0, 8)} ${prov.state}`)
const dir = path.join(repoRoot, 'bench-results', 'studies'); mkdirSync(dir, { recursive: true })
const file = path.join(dir, `b1c-driftform-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
writeFileSync(file, JSON.stringify(out, null, 1))
console.log(`→ ${path.relative(repoRoot, file)}`)
exitGate(enough && errors.length === 0 ? 0 : 1)
