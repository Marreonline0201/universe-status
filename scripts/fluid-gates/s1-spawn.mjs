#!/usr/bin/env node
// Gate S1.3 — volume spawner at rest packing, on the owner's FLUID TEST page (clean gate tree).
//
//   node scripts/fluid-gates/s1-spawn.mjs
//
// Thresholds fixed before the first run:
// P1 default scene at spawn (loaded explicitly): interior packing 4.00 ± 2% particles/cell (cells
//    whose 6 face neighbours are occupied); 0 particles outside the fluid region; kinetic energy 0.
// P2 legacy scenario (survey-01-dam-break: count 40000) → a rest-packed block of the same count
//    (± 2%, lattice rounding), interior packing 4.00 ± 2%.
// P5 BOX path (metres from the tank's inner wall corner), wall-touching box [0,0,0]–[1.0,0.5,1.0] m:
//    count EXACTLY Π floor(size/spacing) (the lattice's own rule), 0 particles outside the requested
//    box, interior packing 4.00 ± 2%.
// P3 never inside existing fluid: (a) the click-spawn path aimed at the MIDDLE of a settled pool;
//    (b) +10K into a tank column filled to the top; (c) two +10K spawns fired at the same time
//    (serialised) — in every case 0 new particles land in cells that held fluid when that spawn ran.
// P4 calm spawn: gravity 0, a block in free space, after 10 steps max speed ≤ 0.05 m/s.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, sampleAtFrame, sample, makeGate, writeReport, unitToTankM, unitVelToMs, TANK_INNER_M, DOMAIN_L_M, FLUID_TEST_URL_MPM } from '../lib/fluid-page.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GRID = 64, PPC = 4, TMIN = 3 / 64, TMAX = 1 - 3 / 64
const SPACING_M = DOMAIN_L_M / (GRID * Math.cbrt(PPC))

const cell = (x, y, z) => { const c = v => Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID))); return (c(x) * GRID + c(y)) * GRID + c(z) }
const cellsOf = (s, from = 0, to = s.n) => { const o = new Set(); for (let i = from; i < to; i++) o.add(cell(s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2])); return o }
const hits = (s, from, to, occ) => { let h = 0; for (let i = from; i < to; i++) if (occ.has(cell(s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2]))) h++; return h }
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
    if ([s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2]].some(c => !(c >= TMIN && c <= TMAX))) outside++
  }
  return { maxMs: unitVelToMs(max), outside }
}
const water = { name: 'water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }

const gate = makeGate('GATE S1.3 (volume spawner)')
const report = {}
// MPM-only mechanics (band walls / 4-ppc packing / MPM viscosity refusals): the legacy solver, kept behind ?solver=mpm (D8)
const { browser, page, errors, adapter } = await openFluidPage(FLUID_TEST_URL_MPM)
report.adapter = adapter
const bench = (fn, arg) => page.evaluate(fn, arg)
const action = (name, seed) => bench(([n, s]) => window.__fluidBench.action(n, s), [name, seed])
try {
  await bench(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: 9.80665 }))

  // P1
  await bench(() => window.__fluidBench.setStepLimit(0))
  await action('defaultScene', 21)
  const s0 = await sampleAtFrame(page, 0)
  const p0 = packing(s0), v0 = speeds(s0)
  report.p1 = { n: s0.n, ...p0, ...v0 }
  gate.check(Math.abs(p0.interior - PPC) / PPC <= 0.02, `P1 default block interior packing ${p0.interior.toFixed(4)}/cell over ${p0.interiorCells} cells (4.00 ± 2%); n = ${s0.n}`)
  gate.check(v0.outside === 0, `P1 particles outside the fluid region: ${v0.outside}`)
  gate.check(v0.maxMs === 0, `P1 kinetic energy at spawn: max speed ${v0.maxMs} m/s (must be exactly 0)`)

  // P2
  // a verbatim copy of the office lab scenario (company/ is untracked, so the clean gate tree does not have it)
  const legacy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/fluid-gates/data/scenarios/survey-01-dam-break.json'), 'utf8'))
  await loadScenario(page, legacy, 22)
  const s2 = await sampleAtFrame(page, 0)
  const p2 = packing(s2)
  report.p2 = { n: s2.n, ...p2 }
  gate.check(Math.abs(s2.n - 40000) / 40000 <= 0.02 && Math.abs(p2.interior - PPC) / PPC <= 0.02, `P2 legacy dam-break → ${s2.n} particles (40000 ± 2%), interior packing ${p2.interior.toFixed(4)}/cell`)

  // P5 — box path in tank metres, touching three walls
  const box = { min: [0, 0, 0], max: [1.0, 0.5, 1.0] }
  const expect = box.max.reduce((a, v, i) => a * Math.max(1, Math.floor((v - box.min[i]) / SPACING_M + 1e-9)), 1)
  const load5 = await loadScenario(page, { name: 'gate-box', materials: [water], spawns: [{ material: 'water', box }], gravity_mps2: 0 }, 23)
  const s5 = await sampleAtFrame(page, 0)
  let outBox = 0
  for (let i = 0; i < s5.n; i++) {
    const m = [0, 1, 2].map(a => unitToTankM(s5.pos[3 * i + a]))
    if (m.some((v, a) => v < box.min[a] || v > box.max[a])) outBox++
  }
  const p5 = packing(s5)
  report.p5 = { n: s5.n, expect, outBox, ...p5, warning: load5?.warning ?? null, tankInnerM: TANK_INNER_M }
  gate.check(s5.n === expect && outBox === 0, `P5 box [0,0,0]–[1,0.5,1] m: ${s5.n} particles (lattice rule ${expect}), ${outBox} outside the requested box`)
  gate.check(Math.abs(p5.interior - PPC) / PPC <= 0.02, `P5 box interior packing ${p5.interior.toFixed(4)}/cell`)

  // P3a — click-spawn path aimed into the middle of a settled pool. Gravity set EXPLICITLY: the
  // previous check's scenario (P5, g = 0) would otherwise leave the "pool" floating as a block.
  await bench(() => window.__fluidBench.setStepLimit(0))
  await bench(() => window.__fluidBench.configure({ gravityMs2: 9.80665 }))
  await action('defaultScene', 24)
  await sampleAtFrame(page, 240)
  const pre = await sample(page)
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < pre.n; i++) { cx += pre.pos[3 * i]; cy += pre.pos[3 * i + 1]; cz += pre.pos[3 * i + 2] }
  const c = [cx / pre.n, cy / pre.n, cz / pre.n]
  const addedA = await action(`spawnAt:${c.map(v => v.toFixed(5)).join(',')}`, 25)
  const postA = await sample(page)
  const hA = hits(postA, pre.n, postA.n, cellsOf(pre))
  report.p3a = { pre: pre.n, target: c, poolTopM: null, added: postA.n - pre.n, returned: addedA, inOcc: hA }
  gate.check(c[1] < 0.2, `P3a setup: the pool settled (centre of mass at ${(unitToTankM(c[1])).toFixed(3)} m above the floor)`)
  gate.check(hA === 0 && postA.n - pre.n === addedA && addedA > 0, `P3a click-spawn aimed into the pool's centre: added ${postA.n - pre.n} (> 0, only in empty cells above the water), ${hA} in occupied cells`)

  // P3b — +10K into a column filled to the top
  const column = { name: 'gate-full-column', materials: [water], spawns: [{ material: 'water', box: { min: [0.3 * TANK_INNER_M, 0, 0.3 * TANK_INNER_M], max: [0.7 * TANK_INNER_M, TANK_INNER_M, 0.7 * TANK_INNER_M] } }], gravity_mps2: 0 }
  await loadScenario(page, column, 26)
  const preB = await sampleAtFrame(page, 0)
  await action('batch10k', 27)
  const postB = await sample(page)
  const hB = hits(postB, preB.n, postB.n, cellsOf(preB))
  report.p3b = { pre: preB.n, added: postB.n - preB.n, inOcc: hB }
  gate.check(hB === 0, `P3b +10K into a full column: added ${postB.n - preB.n} (only in empty cells), ${hB} in occupied cells`)

  // P3c — two +10K spawns fired together (spawns are serialised; the second must see the first)
  await bench(() => window.__fluidBench.setStepLimit(0))
  await bench(() => window.__fluidBench.configure({ gravityMs2: 9.80665 }))
  await action('defaultScene', 28)
  const preC = await sampleAtFrame(page, 120)
  const [n1, n2] = await bench(() => Promise.all([window.__fluidBench.action('batch10k', 29), window.__fluidBench.action('batch10k', 30)]))
  const postC = await sample(page)
  const occAfterFirst = cellsOf(postC, 0, preC.n + n1)
  const hC1 = hits(postC, preC.n, preC.n + n1, cellsOf(preC))
  const hC2 = hits(postC, preC.n + n1, postC.n, occAfterFirst)
  report.p3c = { pre: preC.n, first: n1, second: n2, total: postC.n, hitsFirst: hC1, hitsSecond: hC2 }
  gate.check(postC.n === preC.n + n1 + n2 && hC1 === 0 && hC2 === 0, `P3c two simultaneous +10K: first ${n1}, second ${n2} particles; ${hC1 + hC2} landed in occupied cells`)

  // P4 — a block in free space, zero gravity
  const L = TANK_INNER_M
  await loadScenario(page, { name: 'gate-calm', materials: [water], spawns: [{ material: 'water', box: { min: [0.4 * L, 0.4 * L, 0.4 * L], max: [0.6 * L, 0.6 * L, 0.6 * L] } }], gravity_mps2: 0 }, 31)
  const v4 = speeds(await sampleAtFrame(page, 10))
  report.p4 = v4
  gate.check(v4.maxMs <= 0.05, `P4 calm spawn (g = 0): max speed after 10 steps ${v4.maxMs.toFixed(5)} m/s (≤ 0.05)`)

  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's1-spawn', pass, report, gate.results)
exitGate(pass ? 0 : 1)
