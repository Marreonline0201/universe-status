#!/usr/bin/env node
// Gate TANK — the resizable tank on the FLUID TEST page (vault fluid/realism-2026-09/TANK-RESIZE-spec.md, step 5).
//
//   node scripts/fluid-gates/tank-page.mjs     (default server: the clean gate tree; FLUID_BASE to override)
//
// Criteria (fixed in the spec before the first run). dx = 3.63/64 m fixed; a tank is n_x × n_y × n_z cells, multiples of
// 8 in [16, 88] (the multigrid halves every axis; the spec's "± 1 cell" is the pointer's travel before that snapping).
// (a) NUMBERS: typing 2.72 / 2.27 / 4.08 m in the TANK fields and pressing APPLY → status.tank = 48 × 40 × 72 cells,
//     size = cells·dx, the panel shows the cells; the +x face handle sits where the camera projects the new face centre
//     (± 1 px, projected by this script from the raw camera matrices).
// (b) THE REAL POINTER PATH: from the 64³ tank (the panel's DEFAULT button), page.mouse drags the +x face, the top-front
//     edge (+y, +z), the (+x, +y, +z) corner and the −x face. Expected cells: this script builds the release pixel's ray
//     from the raw camera matrices and intersects it the spec's way — a face: the nearest point on its axis line; an edge:
//     the plane of its two faces; a corner: the camera-facing plane through it — the travel in cells ± 1 cell, snapped to
//     8. Also: the camera did not move during the drag (the drag never orbits), the dashed outline shows mid-drag while the
//     tank is unchanged (the rebuild is on release), every other axis unchanged.
// (c) P1/P2 IN A NON-CUBIC TANK: a water pool over the whole floor of the 48 × 40 × 72 tank; after 6 s the RMS speed
//     ≤ 1 % √(gH) and the mean particle height = H/2 ± ¼·dx, H = N·V_p/A (s31c P1/P2).
// (d) KEPT ON A SHRINK: with the pool settled, shrinks (+x face in; −z face in, the liquid shifted) → the kept count = the
//     count this script finds inside the new walls (the solver's wall band, 1e-4·dx) in a sample taken just before.
// (d0) KEPT ON A GROW (added after the first run; guards the wall-particle deletion the mouse test found): a water block
//     dropped 0.8 m in the 32 × 40 × 56 tank, 4 s later (the impact pins particles to the floor and walls, wallEps
//     inside), the −x face moved out 32 → 48 (the liquid shifted +16 dx) → removed 0, the page count unchanged; and at
//     least 100 particles sat within 1 µm of a wall before the grow (else the check has no teeth: a pool that starts at
//     rest is never pinned — the first version of this check passed with the bug put back).
// (e) FPS recorded (not gated) at 64³ and 88³: a 17 cm pool over the whole floor on the real-time clock for 10 s, in a
//     window on the PRIMARY display (owner 2026-09-29: timing runs stay there); 0 GPU / console errors over the gate.
// Revision after the code review (2026-09-29 night, before its run; no tolerance moved):
//   (a) the size is read from the engine-derived info line ([data-tank-info]), not the panel's typed draft (a refused
//       resize would have left the draft showing the typed size).
//   (b) an expected range may not touch the 16/88 clamp at all (an overshoot clamped to 88 passed as "88 expected"), so
//       the −x drag is 45 px (expected ≈ 72–80) instead of 60 px (80–88); and every GROWING drag also checks where the
//       liquid went: each particle moved by exactly the shift (−x face: the growth; other faces: 0), ≤ 1e-5 m (f32).
//   (e) the FPS window opens after the gate page is closed (its SSFR frames were running on the same GPU).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sample, sampleAtFrame, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE TANK (the resizable tank on the FLUID TEST page)')
const report = { prov: await provenance() }
const L = 3.63, DX = L / 64, VP = DX ** 3 / 8, TAU = 1 / 24, CELL = 1 / 64, STEP = 8

// ---- camera math, written here from the raw matrices (column-major, three.js layout) ----
const mul4 = (m, v) => {
  const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13]
  const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14], w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15]
  return [x / w, y / w, z / w]
}
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l) }
/** The world ray through a client pixel. */
function rayAt(view, px, py) {
  const r = view.rect, ndc = [((px - r.left) / r.width) * 2 - 1, -(((py - r.top) / r.height) * 2 - 1)]
  const o = [view.matrixWorld[12], view.matrixWorld[13], view.matrixWorld[14]]
  const p = mul4(view.matrixWorld, mul4(view.projectionMatrixInverse, [ndc[0], ndc[1], 0.5]))
  return { o, d: norm(sub(p, o)) }
}
/** A world point → client px: the inverse of rayAt (world → camera → clip). */
function project(view, p) {
  const inv = invert4(view.matrixWorld), proj = invert4(view.projectionMatrixInverse)
  const c = mul4(proj, mul4(inv, p)), r = view.rect
  return { x: r.left + (c[0] + 1) / 2 * r.width, y: r.top + (1 - c[1]) / 2 * r.height }
}
function invert4(m) {   // general 4×4 inverse (cofactors), column-major in and out
  const a = m, o = new Array(16)
  o[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10]
  o[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10]
  o[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9]
  o[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9]
  o[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10]
  o[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10]
  o[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9]
  o[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9]
  o[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6]
  o[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6]
  o[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5]
  o[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5]
  o[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6]
  o[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6]
  o[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5]
  o[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5]
  const det = a[0] * o[0] + a[1] * o[4] + a[2] * o[8] + a[3] * o[12]
  return o.map(v => v / det)
}
/** A handle's world position on a tank of `cells` (a side +1: that face, −1: the face at 0, absent: the middle). */
const handlePos = (cells, sides) => [0, 1, 2].map(a => { const s = sides.find(q => q[0] === a); return s ? (s[1] > 0 ? cells[a] * CELL : 0) : cells[a] * CELL / 2 })
const snap = c => Math.round(c / STEP) * STEP
/** The spec's expected travel (cells, per movable axis, signed outward) for a release at pixel (px, py). */
function travel(view, cells, kind, sides, px, py) {
  const { o, d } = rayAt(view, px, py), p0 = handlePos(cells, sides)
  const mov = sides.filter(([a, s]) => !(a === 1 && s < 0))
  const out = {}
  if (kind === 'face') {
    const [a, s] = mov[0], u = [0, 0, 0]; u[a] = 1
    const w0 = sub(p0, o), b = dot(u, d)   // nearest points of the lines p0 + t·u and o + r·d (|u| = |d| = 1)
    const t = (b * dot(d, w0) - dot(u, w0)) / (1 - b * b)
    out[a] = s * t / CELL
  } else {
    let n
    if (kind === 'edge') { n = [0, 0, 0]; n[3 - mov[0][0] - mov[1][0]] = 1 }
    else n = norm([-view.matrixWorld[8], -view.matrixWorld[9], -view.matrixWorld[10]])   // camera forward
    const r = dot(sub(p0, o), n) / dot(d, n)
    const hit = o.map((v, i) => v + r * d[i])
    for (const [a, s] of mov) out[a] = s * (hit[a] - p0[a]) / CELL
  }
  return out
}

const tankOf = async page => (await status(page)).tank
const waitCells = async (page, want, ms = 15_000) => {
  const t0 = Date.now()
  for (;;) {
    const t = await tankOf(page)
    if (t.cells.join() === want.join()) return t
    if (Date.now() - t0 > ms) return t
    await page.waitForTimeout(150)
  }
}
const waitChange = async (page, prev, ms = 15_000) => {
  const t0 = Date.now()
  for (;;) {
    const t = await tankOf(page)
    if (t.cells.join() !== prev.join() || Date.now() - t0 > ms) return t
    await page.waitForTimeout(150)
  }
}
const ghostLines = page => page.evaluate(() => [...document.querySelectorAll('[data-tank-handles] line')].filter(l => l.style.display !== 'none').length)
const H = (page, kind, sides) => page.evaluate(([k, s]) => window.__fluidBench.tankHandle(k, s), [kind, sides])
const view = page => page.evaluate(() => window.__fluidBench.view())
const poolOver = cells => ({ name: `tank-pool-${cells.join('x')}`, materials: [], gravity_mps2: G_STANDARD, spawns: [{ material: 'Water', box: { min: [0, 0, 0], max: [cells[0] * DX, 0.17, cells[2] * DX] } }] })
const clickDefault = async page => {
  const t = await tankOf(page)
  if (t.cells.join() === '64,64,64') return t
  await page.locator('button', { hasText: /^DEFAULT$/ }).click()
  return waitCells(page, [64, 64, 64])
}

const { browser, page, errors, adapter } = await openFluidPage()
let browserClosed = false
report.adapter = adapter
try {
  const st0 = await status(page)
  gate.check(st0.solver === 'flip' && st0.tank?.resizable === true, `R the FLUID TEST page runs the resizable incompressible solver (solver ${st0.solver}, tank ${JSON.stringify(st0.tank?.cells)}, resizable ${st0.tank?.resizable})`)
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)

  // (a) numbers
  await page.fill('[data-tank-axis="0"]', '2.72')
  await page.fill('[data-tank-axis="1"]', '2.27')
  await page.fill('[data-tank-axis="2"]', '4.08')
  await page.click('[data-tank-apply]')
  const ta = await waitCells(page, [48, 40, 72])
  await page.waitForTimeout(300)
  const info = await page.evaluate(() => document.querySelector('[data-tank-info]')?.textContent ?? '')
  const shown = ta.sizeM.map(v => v.toFixed(2)).join(' × ')
  const va = await view(page), hA = await H(page, 'face', [[0, 1]]), pA = project(va, handlePos(ta.cells, [[0, 1]]))
  const sizeOk = ta.sizeM.every((m, a) => Math.abs(m - ta.cells[a] * DX) < 1e-9)
  report.a = { tank: ta, handle: hA, projected: pA, info }
  gate.check(ta.cells.join() === '48,40,72' && sizeOk && info.includes(shown) && Math.hypot(hA.x - pA.x, hA.y - pA.y) <= 1,
    `(a) numbers 2.72 / 2.27 / 4.08 m + APPLY → status ${ta.cells.join(' × ')} cells = ${ta.sizeM.map(v => v.toFixed(3)).join(' × ')} m (cells·dx ${sizeOk ? 'ok' : 'WRONG'}); the page's engine-derived tank line shows ${shown} m: ${info.includes(shown)}; +x face handle at (${hA.x.toFixed(1)}, ${hA.y.toFixed(1)}) vs the projected face centre (${pA.x.toFixed(1)}, ${pA.y.toFixed(1)})`)

  // (c) P1/P2 in the 48 × 40 × 72 tank
  await loadScenario(page, poolOver(ta.cells), 1)
  const s = await sampleAtFrame(page, 360)
  const A = ta.sizeM[0] * ta.sizeM[2], n = s.n, Hh = n * VP / A
  let v2 = 0, ySum = 0, bad = 0
  for (let i = 0; i < n; i++) {
    const vx = s.vel[3 * i] * L / TAU, vy = s.vel[3 * i + 1] * L / TAU, vz = s.vel[3 * i + 2] * L / TAU, y = s.pos[3 * i + 1] * L
    if (!Number.isFinite(vx + vy + vz + y)) { bad++; continue }
    v2 += vx * vx + vy * vy + vz * vz; ySum += y
  }
  const rms = Math.sqrt(v2 / (n - bad)), meanY = ySum / (n - bad), lim = 0.01 * Math.sqrt(G_STANDARD * Hh)
  report.c = { n, H: Hh, rms, meanY, bad }
  gate.check(rms <= lim && bad === 0, `(c) P1 stillness in 48 × 40 × 72 after 6 s (${n} particles, H = N·V_p/A = ${(100 * Hh).toFixed(2)} cm): RMS ${rms.toExponential(2)} m/s (≤ ${lim.toExponential(2)} = 1 % √(gH)); non-finite ${bad}`)
  gate.check(Math.abs(meanY - Hh / 2) <= 0.25 * DX, `(c) P2 level: mean particle height ${(100 * meanY).toFixed(2)} cm vs H/2 ${(100 * Hh / 2).toFixed(2)} cm (±¼·dx = ${(25 * DX).toFixed(2)} cm)`)

  // (d) kept on a shrink (the pool settled and frozen)
  report.d = []
  for (const [cells, shift, what] of [[[32, 40, 72], [0, 0, 0], '+x face in 48 → 32'], [[32, 40, 56], [0, 0, -16 * DX], '−z face in 72 → 56 (liquid shifted −16 dx)']]) {
    const sm = await sample(page), tol = 1e-4 * DX, ext = cells.map(c => c * DX)
    let inside = 0
    for (let i = 0; i < sm.n; i++) if ([0, 1, 2].every(a => { const v = sm.pos[3 * i + a] * L + shift[a]; return v >= -tol && v <= ext[a] + tol })) inside++
    const r = await page.evaluate(([c, sh]) => window.__fluidBench.resizeTank(c, sh), [cells, shift])
    const after = (await status(page)).count
    report.d.push({ cells, shift, before: sm.n, inside, r, after })
    gate.check(r.ok && r.kept === inside && after === inside && inside < sm.n,
      `(d) shrink ${what}: ${sm.n} particles, ${inside} inside the new walls (this script) → kept ${r.kept}, removed ${r.removed}, page count ${after}`)
  }

  // (d0) kept on a grow, from a state with wall-pinned particles (a dropped block, 4 s after the impact)
  const t32 = await tankOf(page)
  await loadScenario(page, { name: 'tank-drop', materials: [], gravity_mps2: G_STANDARD, spawns: [{ material: 'Water', box: { min: [0.4, 0.8, 0.8], max: [1.4, 1.6, 2.2] } }] }, 3)
  const sd = await sampleAtFrame(page, 240), extD = t32.sizeM
  let atRisk = 0
  for (let i = 0; i < sd.n; i++) if ([0, 1, 2].some(a => { const v = sd.pos[3 * i + a] * L; return v <= 1e-6 || v >= extD[a] - 1e-6 })) atRisk++
  const g = await page.evaluate(([c, sh]) => window.__fluidBench.resizeTank(c, sh), [[48, 40, 56], [16 * DX, 0, 0]])
  const gAfter = (await status(page)).count
  report.d0 = { tank: t32.cells, before: sd.n, atRisk, r: g, after: gAfter }
  gate.check(t32.cells.join() === '32,40,56' && atRisk >= 100 && g.ok && g.kept === sd.n && g.removed === 0 && gAfter === sd.n,
    `(d0) grow −x face out 32 → 48 (liquid shifted +16 dx), a dropped block 4 s after impact: ${sd.n} particles, ${atRisk} within 1 µm of a wall (≥ 100 for teeth) → kept ${g.kept}, removed ${g.removed}, page count ${gAfter}`)

  // (b) the real pointer path, each drag from the 64³ tank
  // drag directions from the handles' own screen positions (outward = from the opposite handle to this one)
  const scr = async (kind, sides, other) => { const a = await H(page, kind, sides), b = await H(page, kind, other); return { a, u: norm([a.x - b.x, a.y - b.y, 0]) } }
  const along = (p, parts) => ({ x: p.x + parts.reduce((s, [u, k]) => s + k * u[0], 0), y: p.y + parts.reduce((s, [u, k]) => s + k * u[1], 0) })
  const drags = [
    { name: '+x face, 70 px outward', kind: 'face', sides: [[0, 1]], move: async () => { const x = await scr('face', [[0, 1]], [[0, -1]]); return { from: x.a, to: along(x.a, [[x.u, 70]]) } } },
    { name: 'top-front edge (+y, +z), 45 px up + 45 px out', kind: 'edge', sides: [[1, 1], [2, 1]], move: async () => {
      const y = await scr('edge', [[1, 1], [2, 1]], [[1, -1], [2, 1]]), z = await scr('edge', [[1, 1], [2, 1]], [[1, 1], [2, -1]])
      return { from: y.a, to: along(y.a, [[y.u, 45], [z.u, 45]]) } } },
    { name: 'corner (+x, +y, +z), 40 px in along x + 40 px up', kind: 'corner', sides: [[0, 1], [1, 1], [2, 1]], move: async () => {
      const c = [[0, 1], [1, 1], [2, 1]], x = await scr('corner', c, [[0, -1], [1, 1], [2, 1]]), y = await scr('corner', c, [[0, 1], [1, -1], [2, 1]])
      return { from: x.a, to: along(x.a, [[x.u, -40], [y.u, 40]]) } } },
    { name: '−x face, 45 px outward', kind: 'face', sides: [[0, -1]], move: async () => { const x = await scr('face', [[0, -1]], [[0, 1]]); return { from: x.a, to: along(x.a, [[x.u, 45]]) } } },
  ]
  report.b = []
  for (const dg of drags) {
    const t0 = await clickDefault(page)
    await page.waitForTimeout(400)
    const before = await sample(page)   // the sim is frozen here (the step limit of d0), so only the resize moves particles
    const { from, to } = await dg.move()
    const v0 = await view(page)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    let ghostMid = 0, tankMid = null
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12)
      if (i === 12) { ghostMid = await ghostLines(page); tankMid = (await tankOf(page)).cells }
    }
    const v1 = await view(page)
    await page.mouse.up()
    const t1 = await waitChange(page, t0.cells)
    const still = v0.matrixWorld.every((x, k) => x === v1.matrixWorld[k])
    const tr = travel(v0, t0.cells, dg.kind, dg.sides, to.x, to.y)
    const lines = [], ok = []
    for (let a = 0; a < 3; a++) {
      if (!(a in tr)) { ok.push(t1.cells[a] === t0.cells[a]); lines.push(`${'xyz'[a]} ${t1.cells[a]} (unchanged: ${t1.cells[a] === t0.cells[a]})`); continue }
      const lo = t0.cells[a] + snap(tr[a] - 1), hi = t0.cells[a] + snap(tr[a] + 1)
      // the expected range must not reach a clamp bound: an overshoot clamped there would pass as "expected"
      const inRange = lo > 16 && hi < 88
      ok.push(inRange && t1.cells[a] >= lo && t1.cells[a] <= hi)
      lines.push(`${'xyz'[a]} ${t0.cells[a]} → ${t1.cells[a]} (travel ${tr[a].toFixed(2)} cells → expected ${lo === hi ? lo : `${lo}–${hi}`}${inRange ? '' : ', REACHES A CLAMP: drag mis-designed'})`)
    }
    // where the liquid went: on a growing drag every particle stays, moved by exactly the shift (a −x face grows the
    // tank on its low side, so the grid's origin moves and the liquid with it by the growth; any other face: 0)
    const grew = t1.cells.every((c, a) => c >= t0.cells[a])
    let liquid = 'n/a (a shrink removes particles)', liquidOk = true
    if (grew) {
      const aft = await sample(page)
      const shiftX = dg.sides.some(([ax, sg]) => ax === 0 && sg < 0) ? (t1.cells[0] - t0.cells[0]) * DX : 0
      let worst = 0
      if (aft.n !== before.n) worst = Infinity
      else for (let i = 0; i < aft.n; i++) for (let ax = 0; ax < 3; ax++) worst = Math.max(worst, Math.abs((aft.pos[3 * i + ax] - before.pos[3 * i + ax]) * L - (ax === 0 ? shiftX : 0)))
      liquidOk = worst <= 1e-5
      liquid = `${aft.n}/${before.n} particles, each moved by the expected (${(100 * shiftX).toFixed(2)} cm, 0, 0) within ${Number.isFinite(worst) ? worst.toExponential(1) : '∞'} m (≤ 1e-5)`
    }
    report.b.push({ drag: dg.name, from, to, before: t0.cells, after: t1.cells, travel: tr, still, ghostMid, tankMid, liquid })
    const changed = t1.cells.join() !== t0.cells.join()
    gate.check(ok.every(Boolean) && changed && still && ghostMid === 12 && tankMid.join() === t0.cells.join() && liquidOk,
      `(b) drag ${dg.name} (${Math.hypot(to.x - from.x, to.y - from.y).toFixed(0)} px): ${lines.join('; ')}; camera still during the drag: ${still}; mid-drag outline ${ghostMid}/12 lines, tank unchanged until release: ${tankMid.join() === t0.cells.join()}; liquid: ${liquid}`)
  }
  await clickDefault(page)
  gate.check((await status(page)).gpuErrors === 0, `R GPU: ${(await status(page)).gpuErrors} uncaptured WebGPU errors on the gate page`)
  await browser.close()   // (e) must not share the GPU with the gate page's own SSFR frames
  browserClosed = true

  // (e) FPS at 64³ and 88³ (recorded), primary display
  const fp = await openFluidPage(undefined, { timing: true })
  report.e = []
  try {
    await fp.page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    for (const cells of [[64, 64, 64], [88, 88, 88]]) {
      await fp.page.evaluate(() => window.__fluidBench.setStepLimit(0))
      const r = await fp.page.evaluate(c => window.__fluidBench.resizeTank(c), cells)
      if (!r.ok) throw new Error(`resize ${cells.join('×')} refused: ${r.reason}`)
      await loadScenario(fp.page, poolOver(cells), 1)
      await sampleAtFrame(fp.page, 120)
      await fp.page.evaluate(() => window.__fluidBench.configure({ clock: 'realtime', resetClockStats: true, resetDiagnostics: true }))
      await fp.page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
      await fp.page.waitForTimeout(10_000)
      const f = await status(fp.page), d = await fp.page.evaluate(() => window.__fluidBench.diagnostics())
      report.e.push({ cells, count: f.count, fps: f.fps, rtFactor: f.rtFactor, p50: f.presentIntervalP50, p95: f.presentIntervalP95, gpuErrors: f.gpuErrors, diagnostics: d })
      console.log(`  [recorded] FPS ${cells.join('×')}: ${f.count} particles (17 cm pool) on the real-time clock for 10 s: ${f.fps} fps, present p50 ${f.presentIntervalP50?.toFixed(1)} ms / p95 ${f.presentIntervalP95?.toFixed(1)} ms, real-time factor ${f.rtFactor.toFixed(3)}; substeps ${d.substeps}, p caps ${d.pressureCapHits}/${d.pressureSolves}`)
      await fp.page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
    }
    errors.push(...fp.errors)
  } finally {
    await fp.browser.close()
  }
  const gpuE = report.e.reduce((s, x) => s + x.gpuErrors, 0)
  gate.check(gpuE === 0, `R GPU: ${gpuE} uncaptured WebGPU errors in the FPS window`)
  gate.check(errors.length === 0, `R console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  if (!browserClosed) await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'tank-page', pass, report, gate.results)
process.exit(pass ? 0 : 1)
