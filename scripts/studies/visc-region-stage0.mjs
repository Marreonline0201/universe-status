#!/usr/bin/env node
// visc-region-stage0.mjs — S3.6r viscous region, STAGE 0 (vault spec: the viscous-region design workflow wf_7c333551-8a5,
// "Spec S3.6r" §2.8 and §2.10, decision rule fixed there before any number): measure, with NO region code, whether a
// region restricted to the liquids with ν ≥ VISCOUS_RUN_NU (1.06e-5 m²/s, liquidGate.ts) could pay on B1.
//
//   node scripts/studies/visc-region-stage0.mjs        (default server: the clean gate tree; AC only — a timing run)
//
// Method. The B1 scene (the S3.1c page's: a 17 cm water pool, the olive-oil block, the mercury block; lockstep 1/60 s,
// seed 2) at t = 0.5, 1.5, …, 7.5 s:
//   M4 (region fractions, rule P, m = 1): C₀ = the cells (floor of the world position × 64) holding a particle whose
//      composition has ν = μ/ρ ≥ VISCOUS_RUN_NU; d(c) = the Chebyshev (26-neighbour) cell distance to C₀; f₃ and f₂ = the
//      fractions of particles in cells with d ≤ 3 and d ≤ 2; c₂ and c₁ = the fractions of occupied cells with d ≤ 2 and
//      d ≤ 1.
//   Pass times: the bench's profileStep over the next 3 frames (median µs per pass label): visc.lattice (bandCells,
//      bandDilate, latScatter), visc.volumes, visc.mu (muMinScatter, muScatter, weights); the two pressure solves are
//      reported together (flip.pressure:solve).
// The spec's predicted saving is U = mean over the 8 times of (1 − f₃)·T_latScatter + (1 − f₂)·(T_muMin + T_mu)
// + (1 − c₂)·T_volumes + (1 − c₁)·T_weights, an upper bound under its linear model. Without the per-kernel split (M3) this
// study uses the WHOLE pass times: the visc.lattice pass contains latScatter, and the visc.mu pass contains muMinScatter,
// muScatter and weights, so with m = min(f₂, c₁) (both 1 − f₂ and 1 − c₁ are ≤ 1 − m)
//   U_ub = mean of (1 − f₃)·T_visc.lattice + (1 − m)·T_visc.mu + (1 − c₂)·T_visc.volumes ≥ U.
// Decision (the spec's §2.10, fixed before any number): U < 3.0 ms per frame → STOP: the region is not built, the full
// solve stays, and Tier A and P2 go ahead on their own gates. Here: U_ub < 3.0 → STOP (a conservative upper bound);
// U_ub ≥ 3.0 → INCONCLUSIVE with the upper bound: measure M3 (encode(stopAfter)) before deciding.
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, provenance, G_STANDARD } from '../lib/fluid-page.mjs'
import { powerState, describePower, timingValid, watchPower } from '../lib/power.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NU_RUN = 0.01 * 1.06e-3   // VISCOUS_RUN_NU (src/composition/liquidGate.ts:231–235)
const N = 64, TIMES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5], FRAMES = 3, LINE_MS = 3.0
const scene = { name: 's31c-buoyancy', materials: [], gravity_mps2: G_STANDARD, spawns: [
  { material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.17, 3.63] } },
  { material: 'Olive Oil', box: { min: [1.0, 0.6, 1.0], max: [2.29, 0.9, 2.29] } },
  { material: 'Mercury', box: { min: [1.3, 1.2, 1.3], max: [1.99, 1.5, 1.99] } }] }
const med = v => { const q = [...v].sort((a, b) => a - b); return q.length ? q[Math.floor(q.length / 2)] : NaN }

function fractions(s) {
  const nu = new Map(s.materials.map(m => [m.id, m.mu / m.rho]))
  const cellOf = i => {
    const c = [0, 1, 2].map(a => Math.min(N - 1, Math.max(0, Math.floor(s.pos[3 * i + a] * N))))
    return c[0] + N * (c[1] + N * c[2])
  }
  const d = new Int8Array(N ** 3).fill(127), occ = new Int32Array(N ** 3), cells = new Int32Array(s.n)
  let seeds = 0
  for (let i = 0; i < s.n; i++) {
    const c = cellOf(i); cells[i] = c; occ[c]++
    if ((nu.get(s.comp[i]) ?? 0) >= NU_RUN) { if (d[c] !== 0) seeds++; d[c] = 0 }
  }
  for (let k = 1; k <= 3; k++) {   // L∞ dilation, one ring per pass
    const next = []
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const c = x + N * (y + N * z)
      if (d[c] !== k - 1) continue
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue
        const n = X + N * (Y + N * Z)
        if (d[n] > k) next.push(n)
      }
    }
    for (const n of next) if (d[n] > k) d[n] = k
  }
  let p3 = 0, p2 = 0, occN = 0, o2 = 0, o1 = 0
  for (let i = 0; i < s.n; i++) { if (d[cells[i]] <= 3) p3++; if (d[cells[i]] <= 2) p2++ }
  for (let c = 0; c < N ** 3; c++) if (occ[c] > 0) { occN++; if (d[c] <= 2) o2++; if (d[c] <= 1) o1++ }
  return { seedCells: seeds, f3: p3 / s.n, f2: p2 / s.n, c2: o2 / occN, c1: o1 / occN, particles: s.n, occupiedCells: occN }
}

const power = powerState()
console.log(`power: ${describePower(power)}`)
if (!timingValid(power)) { console.error('refusing: a timing study runs on AC, outside a power-limited scheme'); process.exit(3) }
const powerWatch = watchPower()
const prov = await provenance()
const out = { prov, power: { start: power }, nuRun: NU_RUN, line: LINE_MS, times: [] }
const { browser, page, errors, adapter } = await openFluidPage(undefined, { timing: true, gpuTimestamps: true })
out.adapter = adapter
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  await loadScenario(page, scene, 2)
  for (const t of TIMES) {
    const frame = Math.round(60 * t)
    const s = await sampleAtFrame(page, frame)
    const fr = fractions(s)
    const profs = []
    for (let k = 0; k < FRAMES; k++) {
      const pr = page.evaluate(() => window.__fluidBench.profileStep())
      await page.evaluate(n => window.__fluidBench.setStepLimit(n), frame + k + 1)
      profs.push(await pr)
    }
    const passUs = label => med(profs.map(p => p.byLabel.filter(r => r.pass === label).reduce((q, r) => q + r.us, 0)))
    const T = { lattice: passUs('visc.lattice') / 1000, volumes: passUs('visc.volumes') / 1000, mu: passUs('visc.mu') / 1000, pressure: passUs('flip.pressure:solve') / 1000, gpuSum: med(profs.map(p => p.gpuSumUs)) / 1000, substeps: med(profs.map(p => p.substeps)) }
    const Uub = (1 - fr.f3) * T.lattice + (1 - Math.min(fr.f2, fr.c1)) * T.mu + (1 - fr.c2) * T.volumes
    out.times.push({ t, frame, ...fr, T, Uub })
    console.log(`t ${t.toFixed(1)} s: seed cells ${fr.seedCells}, f3 ${fr.f3.toFixed(3)} f2 ${fr.f2.toFixed(3)} c2 ${fr.c2.toFixed(3)} c1 ${fr.c1.toFixed(3)}; visc lattice ${T.lattice.toFixed(2)} volumes ${T.volumes.toFixed(2)} mu ${T.mu.toFixed(2)} ms/frame (pressure ${T.pressure.toFixed(2)}, GPU Σ ${T.gpuSum.toFixed(2)}, ${T.substeps} substeps) → U_ub ${Uub.toFixed(2)} ms/frame`)
  }
} finally { await browser.close() }
out.power.end = powerState()
out.power.watch = await powerWatch.stop()
out.power.valid = timingValid(out.power.end) && out.power.watch.allValid
out.errors = errors
const U = out.times.reduce((q, r) => q + r.Uub, 0) / out.times.length
out.U_ub = U
out.decision = U < LINE_MS ? 'STOP' : 'INCONCLUSIVE'
console.log(`\nU_ub (mean over ${out.times.length} times) = ${U.toFixed(2)} ms/frame against the ${LINE_MS} ms line → ${out.decision === 'STOP' ? 'STOP: the region is not built (§2.10); the full solve stays; Tier A and P2 go ahead on their own gates' : 'INCONCLUSIVE with the whole-pass upper bound: measure M3 (encode(stopAfter)) before deciding'}`)
console.log(`power: start ${describePower(out.power.start)}; end ${describePower(out.power.end)}; ${out.power.watch.samples} samples${out.power.valid ? ', all valid' : ' — INVALID: not a baseline'}; console errors ${errors.length}; provenance ${prov.sha?.slice(0, 8)} ${prov.state}`)
const dir = path.join(repoRoot, 'bench-results', 'studies'); mkdirSync(dir, { recursive: true })
const file = path.join(dir, `visc-region-stage0-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
writeFileSync(file, JSON.stringify(out, null, 1))
console.log(`→ ${path.relative(repoRoot, file)}`)
exitGate(out.power.valid && errors.length === 0 ? 0 : 1)
