#!/usr/bin/env node
// drift-form-cost.mjs — the GPU cost of the face counter-flux against the cell form, PAIRED in one page session (the
// clean perf-profile at 94f49fec could not price it: the lava scene, which has no drift and no code change since
// 0370b2f5, read 21.5 → 26.0 ms, so machine state moved between the two runs; decisions 2026-09-30).
//
//   node scripts/studies/drift-form-cost.mjs      (default server: the clean gate tree; AC, a timing run)
//
// Method: the B1 scene of perf-profile (seed 1, lockstep 1/60 s) loaded fresh for each arm; at frame 120 (2 s) five
// consecutive frames profiled (bench profileStep: GPU timestamps per pass label); arms alternate cell, face, cell, face,
// cell, face (3 each) so a drift of the machine's state hits both. Reported per arm: the median over its frames of the
// imm.drift pass per substep, the whole drift stage (imm.faceAccel + imm.extrapolateAccel + imm.drift) per substep, and
// the frame's GPU Σ; the face − cell difference of the drift stage is the face form's cost. Every frame's dispatch counts
// are also checked against the L0 budget (the form confirmed by its +2 dispatches per substep).
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { powerState, describePower, timingValid, watchPower } from '../lib/power.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const scene = { name: 'perf-b1', materials: [], gravity_mps2: G_STANDARD, spawns: [
  { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } },
  { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } },
  { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] }
const AT = 120, FRAMES = 5, ORDER = ['cell', 'face', 'cell', 'face', 'cell', 'face']
const med = v => { const q = [...v].sort((a, b) => a - b); return q.length ? q[Math.floor(q.length / 2)] : NaN }
const us = (p, label) => p.byLabel.filter(r => r.pass === label).reduce((q, r) => q + r.us, 0)

const power = powerState()
console.log(`power: ${describePower(power)}`)
if (!timingValid(power)) { console.error('refusing: a timing study runs on AC, outside a power-limited scheme'); process.exit(3) }
const watch = watchPower()
const prov = await provenance()
const out = { prov, power: { start: power }, arms: { cell: [], face: [] } }
const { browser, page, errors, adapter } = await openFluidPage(undefined, { timing: true, gpuTimestamps: true })
out.adapter = adapter
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  for (const form of ORDER) {
    await page.evaluate(f => window.__fluidBench.configure({ immDriftForm: f }), form)
    await loadScenario(page, scene, 1)
    await sampleAtFrame(page, AT)
    const st = await page.evaluate(() => window.__fluidBench.status())
    for (let k = 0; k < FRAMES; k++) {
      const pr = page.evaluate(() => window.__fluidBench.profileStep())
      await page.evaluate(n => window.__fluidBench.setStepLimit(n), AT + k + 1)
      const p = await pr
      const n = p.substeps
      out.arms[form].push({ n, formReported: st.immiscible?.form ?? null, driftUsPerSub: us(p, 'imm.drift') / n,
        stageUsPerSub: (us(p, 'imm.drift') + us(p, 'imm.faceAccel') + us(p, 'imm.extrapolateAccel')) / n, gpuSumMs: p.gpuSumUs / 1000,
        dispatches: p.dispatches, budgetOk: !!p.budget && p.budget.mismatches.length === 0 && p.untimedPasses === 0, budgetForm: p.budget?.state?.driftForm ?? null })
    }
  }
} finally { await browser.close() }
out.power.end = powerState(); out.power.watch = await watch.stop()
out.power.valid = timingValid(out.power.end) && out.power.watch.allValid
out.errors = errors
const sum = f => { const a = out.arms[f]; return { frames: a.length, drift: med(a.map(r => r.driftUsPerSub)), stage: med(a.map(r => r.stageUsPerSub)), gpu: med(a.map(r => r.gpuSumMs)), budgetOk: a.every(r => r.budgetOk && r.budgetForm === f && r.formReported === f) } }
out.summary = { cell: sum('cell'), face: sum('face') }
const c = out.summary.cell, f = out.summary.face
console.log(`cell form: ${c.frames} frames — imm.drift ${c.drift.toFixed(0)} µs/substep, drift stage ${c.stage.toFixed(0)} µs/substep, GPU Σ ${c.gpu.toFixed(2)} ms/frame; budget and form confirmed: ${c.budgetOk}`)
console.log(`face form: ${f.frames} frames — imm.drift ${f.drift.toFixed(0)} µs/substep, drift stage ${f.stage.toFixed(0)} µs/substep, GPU Σ ${f.gpu.toFixed(2)} ms/frame; budget and form confirmed: ${f.budgetOk}`)
console.log(`face − cell: drift stage ${(f.stage - c.stage).toFixed(0)} µs/substep; GPU Σ ${(f.gpu - c.gpu).toFixed(2)} ms/frame (medians; the frame Σ also carries the forms' different dynamics)`)
console.log(`power: ${out.power.valid ? 'valid' : 'INVALID'}; console errors ${errors.length}; provenance ${prov.sha?.slice(0, 8)} ${prov.state}`)
const dir = path.join(repoRoot, 'bench-results', 'studies'); mkdirSync(dir, { recursive: true })
const file = path.join(dir, `drift-form-cost-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
writeFileSync(file, JSON.stringify(out, null, 1))
console.log(`→ ${path.relative(repoRoot, file)}`)
exitGate(out.power.valid && errors.length === 0 && c.budgetOk && f.budgetOk ? 0 : 1)
