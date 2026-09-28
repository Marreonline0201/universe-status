#!/usr/bin/env node
// Unit gate for src/fluid-engine/clock.ts (PresentationClock) against synthetic vsync streams —
// the refresh rates we cannot test on the owner's 240 Hz panel.
//
//   node scripts/fluid-gates/clock-unit.mjs
//
// For each panel rate (60, 75, 90, 120, 144, 165, 240 Hz, plus 239.76 Hz drift) with realistic
// timestamp noise (±0.05 ms jitter, 0.1 ms quantisation) over 60 s:
//  C1 presentation rate = refresh / k within 1%, k the integer nearest refresh/60 (either side of an
//     exact tie such as 90 Hz), constant for the whole run (e.g. 144 Hz → 72 fps, not 48)
//  C2 no judder: ≥ 99.5% of presented frames advance within 1% of the nominal interval k·vsync.
//     (The first draft bucketed advances at 0.01 ms and counted a 0.06% wobble of the vsync
//     estimate as "non-uniform"; the property that matters is no 0-step / 2-step frames.)
//  C3 real time: total sim time / wall time = 1 ± 0.2% (no drift, no dilation when not overloaded)
// Plus scenario tests on 240 Hz:
//  C4 a single 50 ms stall → that frame advances ≤ 2 targets, dilation recorded, then back to uniform
//  C5 sustained overload (every presented frame takes 2.5 targets) → advance capped at 1/60 s of
//     sim per presented frame (no work doubling), dilation reported
//  C6 a no-stall control window records zero dilation
import { PresentationClock } from '../../src/fluid-engine/clock.ts'

const fails = []
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg) }
let seed = 12345
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const quant = t => Math.floor(t * 10) / 10          // 0.1 ms timestamp quantisation

function run(hz, seconds, { stallAtS = null, stallMs = 0, overload = false } = {}) {
  const c = new PresentationClock()
  const vs = 1000 / hz
  let t = 1000, sim = 0, dropped = 0, presents = 0
  const advances = []
  let wallStart = null, lastPresentWall = null
  let stallDone = false
  while (t < 1000 + seconds * 1000) {
    const d = c.tick(quant(t + (rnd() - 0.5) * 0.1))
    if (d.present) {
      if (wallStart === null) wallStart = t
      presents++
      sim += d.advanceS
      dropped += d.droppedS
      if (d.advanceS > 0) advances.push(Math.round(d.advanceS * 1e5) / 1e5)
      lastPresentWall = t
      if (overload && presents > 30) t += 1.5 * c.targetMs   // the frame's work pushes the next vsync late
    }
    t += vs
    if (stallAtS !== null && !stallDone && t > 1000 + stallAtS * 1000) { t += stallMs; stallDone = true }
  }
  const wall = (lastPresentWall - wallStart) / 1000
  const counts = new Map(); for (const a of advances) counts.set(a, (counts.get(a) ?? 0) + 1)
  const [modal] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const nominal = c.targetMs / 1000
  const uniform = advances.filter(a => Math.abs(a - nominal) <= 0.01 * nominal).length / advances.length
  return { c, presents, fps: presents / seconds, sim, dropped, wall, modal, uniform, advances }
}

for (const hz of [60, 75, 90, 120, 144, 165, 240, 239.76]) {
  const r = run(hz, 60)
  const k = r.c.presentEvery
  const expectFps = hz / k
  check(Math.abs(k - hz / 60) <= 0.5 + 1e-9 && Math.abs(r.fps - expectFps) / expectFps < 0.01, `C1 ${hz} Hz: presents ${r.fps.toFixed(2)} fps (every ${k} vsync → expected ${expectFps.toFixed(2)})`)
  check(r.uniform >= 0.995, `C2 ${hz} Hz: ${(r.uniform * 100).toFixed(2)}% of frames advance within 1% of ${r.c.targetMs.toFixed(3)} ms`)
  check(Math.abs(r.sim / r.wall - 1) < 0.002 && r.dropped === 0, `C3 ${hz} Hz: sim/wall ${(r.sim / r.wall).toFixed(5)}, dilation ${r.dropped.toFixed(4)} s`)
}

const s = run(240, 20, { stallAtS: 10, stallMs: 50 })
const maxAdv = Math.max(...s.advances)
check(maxAdv <= 2 * s.c.targetMs / 1000 * 1.001 && s.dropped > 0.015, `C4 50 ms stall: max advance ${(maxAdv * 1000).toFixed(2)} ms (≤ ${(2 * s.c.targetMs).toFixed(2)}), dilation ${(s.dropped * 1000).toFixed(1)} ms`)
check(s.uniform >= 0.99, `C4 uniform motion around the stall: ${(s.uniform * 100).toFixed(2)}%`)

const o = run(240, 20, { overload: true })
const late = o.advances.slice(-100)
check(Math.max(...late) <= (1000 / 60) / 1000 * 1.001 && o.dropped > 1, `C5 sustained overload: advance capped at ${(Math.max(...late) * 1000).toFixed(2)} ms/frame (1/60 s = 16.67), dilation ${o.dropped.toFixed(2)} s over 20 s`)

const ctl = run(240, 20)
check(ctl.dropped === 0, `C6 control (no stall): dilation ${ctl.dropped} s`)

console.log(fails.length ? `CLOCK UNIT: FAIL (${fails.length})` : 'CLOCK UNIT: PASS')
process.exit(fails.length ? 1 : 0)
