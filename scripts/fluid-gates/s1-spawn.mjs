#!/usr/bin/env node
// Gate S1.3 — volume spawner at rest packing, on the owner's FLUID TEST page.
//
//   node scripts/fluid-gates/s1-spawn.mjs
//
// Thresholds were fixed before the first run:
// P1 default scene at spawn: interior packing 4.00 ± 2% particles/cell (cells whose 6 face
//    neighbours are occupied — the free-surface shell is under-filled by construction);
//    0 particles outside the fluid region [3/64, 61/64]; kinetic energy exactly 0.
// P2 legacy scenario (survey-01-dam-break: count 40000) converts to a rest-packed block of
//    the same particle count (±2%, lattice rounding) with interior packing 4.00 ± 2%.
// P3 +10K into existing fluid (settled pool, and a tank column filled to the top): no new
//    particle lands in a cell that held fluid at spawn time.
// P4 calm spawn: gravity 0, default block, after 10 macro-steps max speed ≤ 0.05 m/s.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, sample, makeGate, DOMAIN_L_M, TAU_S } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GRID = 64, PPC = 4, TMIN = 3 / 64, TMAX = 1 - 3 / 64
const toMs = v => v * DOMAIN_L_M / TAU_S

const cell = (x, y, z) => { const c = v => Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID))); return (c(x) * GRID + c(y)) * GRID + c(z) }
function packing(s) {
  const counts = new Map()
  for (let i = 0; i < s.n; i++) { const k = cell(s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2]); counts.set(k, (counts.get(k) ?? 0) + 1) }
  let sum = 0, cells = 0
  for (const [k, c] of counts) {
    const z = k % GRID, y = Math.floor(k / GRID) % GRID, x = Math.floor(k / (GRID * GRID))
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    if (nb.every(([a, b, d]) => counts.has(((x + a) * GRID + (y + b)) * GRID + (z + d)))) { sum += c; cells++ }
  }
  return { interior: sum / (cells || 1), interiorCells: cells }
}
function speeds(s) {
  let max = 0, outside = 0
  for (let i = 0; i < s.n; i++) {
    const v = Math.hypot(s.vel[3 * i], s.vel[3 * i + 1], s.vel[3 * i + 2])
    if (!(v <= max)) max = Math.max(max, v)
    const p = [s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2]]
    if (p.some(c => !(c >= TMIN && c <= TMAX))) outside++
  }
  return { maxMs: toMs(max), outside }
}
const water = { name: 'water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }

const gate = makeGate('GATE S1.3 (volume spawner)')
const report = {}
const { browser, page, errors, adapter } = await openFluidPage()
report.adapter = adapter
const bench = (fn, arg) => page.evaluate(fn, arg)
try {
  await bench(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665 }))

  // P1
  await bench(() => { window.__fluidBench.setStepLimit(0) })
  await bench(() => window.__fluidBench.action('reset', 21))
  const s0 = await sampleAtFrame(page, 0)
  const p0 = packing(s0), v0 = speeds(s0)
  report.p1 = { n: s0.n, ...p0, ...v0 }
  gate.check(Math.abs(p0.interior - PPC) / PPC <= 0.02, `P1 default block interior packing ${p0.interior.toFixed(4)}/cell over ${p0.interiorCells} cells (4.00 ± 2%); n = ${s0.n}`)
  gate.check(v0.outside === 0, `P1 particles outside the fluid region: ${v0.outside}`)
  gate.check(v0.maxMs === 0, `P1 kinetic energy at spawn: max speed ${v0.maxMs} m/s (must be exactly 0)`)

  // P2
  const legacy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'company/lab/survey-01-dam-break/scenario.json'), 'utf8'))
  await loadScenario(page, legacy, 22)
  const s2 = await sampleAtFrame(page, 0)
  const p2 = packing(s2)
  report.p2 = { n: s2.n, ...p2 }
  gate.check(Math.abs(s2.n - 40000) / 40000 <= 0.02 && Math.abs(p2.interior - PPC) / PPC <= 0.02, `P2 legacy dam-break → ${s2.n} particles (40000 ± 2%), interior packing ${p2.interior.toFixed(4)}/cell`)

  // P3a: settled pool, then +10K
  await bench(() => window.__fluidBench.setStepLimit(0))
  await bench(() => window.__fluidBench.action('reset', 23))
  await sampleAtFrame(page, 240)
  const pre = await sample(page)
  const occ = new Set(); for (let i = 0; i < pre.n; i++) occ.add(cell(pre.pos[3 * i], pre.pos[3 * i + 1], pre.pos[3 * i + 2]))
  await bench(() => window.__fluidBench.action('batch10k', 24))
  const post = await sample(page)
  let inOcc = 0; for (let i = pre.n; i < post.n; i++) if (occ.has(cell(post.pos[3 * i], post.pos[3 * i + 1], post.pos[3 * i + 2]))) inOcc++
  report.p3a = { pre: pre.n, added: post.n - pre.n, inOcc }
  gate.check(inOcc === 0 && post.n - pre.n >= 9000, `P3 +10K onto a settled pool: added ${post.n - pre.n}, ${inOcc} landed in occupied cells`)

  // P3b: a column of water up to the top of the tank where +10K pours
  const column = { name: 'gate-full-column', materials: [water], spawns: [{ material: 'water', box: { min: [0.35 * DOMAIN_L_M, TMIN * DOMAIN_L_M, 0.35 * DOMAIN_L_M], max: [0.65 * DOMAIN_L_M, TMAX * DOMAIN_L_M, 0.65 * DOMAIN_L_M] } }], gravity_mps2: 0 }
  await loadScenario(page, column, 25)
  const preB = await sampleAtFrame(page, 0)
  const occB = new Set(); for (let i = 0; i < preB.n; i++) occB.add(cell(preB.pos[3 * i], preB.pos[3 * i + 1], preB.pos[3 * i + 2]))
  await bench(() => window.__fluidBench.action('batch10k', 26))
  const postB = await sample(page)
  let inOccB = 0; for (let i = preB.n; i < postB.n; i++) if (occB.has(cell(postB.pos[3 * i], postB.pos[3 * i + 1], postB.pos[3 * i + 2]))) inOccB++
  report.p3b = { pre: preB.n, added: postB.n - preB.n, inOcc: inOccB }
  gate.check(inOccB === 0, `P3 +10K into a full column: added ${postB.n - preB.n} (only into empty cells), ${inOccB} landed in occupied cells`)

  // P4 — a block in free space (not touching any wall), loaded explicitly: 'reset' after a
  // scenario reloads THAT scenario, which is how the first version of this check ended up
  // measuring the full-height column against the (then still present) wall spring.
  const L = DOMAIN_L_M
  await loadScenario(page, { name: 'gate-calm', materials: [water], spawns: [{ material: 'water', box: { min: [0.4 * L, 0.4 * L, 0.4 * L], max: [0.6 * L, 0.6 * L, 0.6 * L] } }], gravity_mps2: 0 }, 27)
  const s4 = await sampleAtFrame(page, 10)
  const v4 = speeds(s4)
  report.p4 = v4
  gate.check(v4.maxMs <= 0.05, `P4 calm spawn (g = 0): max speed after 10 steps ${v4.maxMs.toFixed(5)} m/s (≤ 0.05)`)

  gate.check(errors.length === 0, `no unexpected console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
} finally {
  await browser.close()
}
const pass = gate.finish()
const out = path.join(repoRoot, 'bench-results', 'gates', `s1-spawn-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ pass, ...report, checks: gate.results }, null, 2))
console.log(`→ ${path.relative(repoRoot, out)}`)
process.exit(pass ? 0 : 1)
