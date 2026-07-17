// Body-separation invariant test. Run: npx tsx scripts/office-overlap-sim.ts
// Drives REAL AgentSprite movement (same code the canvas runs) through
// adversarial scenarios and asserts that no two bodies ever come closer than
// BODY_GAP (0.7 tiles) minus float slack. Cell claims alone provably fail this:
// two head-on walkers stop at their shared cell boundary ~0.02 tiles apart.
//
// Scenarios:
//   1. head-on corridor pass  — the pre-fix worst case
//   2. coffee rush            — 10 agents converge on adjacent stand spots
//   3. full-floor fuzz        — all 57 agents re-targeted randomly, 180 sim-seconds
//
// assets.ts touches the DOM to bake sprite art; sim never renders, so stub it.
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctxStub = () => new Proxy({ canvas: {} }, {
  get: (t: any, prop) => (prop in t ? t[prop] : () => ctxStub()),
  set: () => true,
}) as any
;(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: ctxStub }),
}
;(globalThis as any).window = globalThis

import { buildOfficeMap } from '../src/office-render/officeMap'
import { AgentSprite } from '../src/office-render/AgentSprite'
import { Occupancy } from '../src/office-render/occupancy'
import type { Point } from '../src/office-render/pathfind'

const ROLES = ['Team Lead', 'Senior Researcher', 'Senior Researcher', 'Senior Researcher', 'Reviewer / Editor', 'Research Engineer', 'Liaison / Scribe']
const teamIds = ['physics', 'chemistry', 'bio', 'fluid', 'game', 'ml', 'rendering', 'engine']
const teams = teamIds.map(id => ({ id, name: id, color: '#ffffff' }))
const roster: { id: string; name: string; team: string; role: string }[] = [
  { id: 'director', name: 'Director', team: 'company', role: 'Company Director' },
]
for (const t of teamIds) {
  ROLES.forEach((role, i) => roster.push({ id: `${t}-${i}`, name: `${t}-${i}`, team: t, role }))
}

const MIN_ALLOWED = 0.69 // BODY_GAP minus float slack
let failures = 0

interface Sim {
  sprites: Map<string, AgentSprite>
  step: (simSeconds: number, onFrame?: () => void) => void
  minSeen: () => number
}

function makeSim(ids: string[]): Sim {
  const map = buildOfficeMap(teams as never, roster as never)
  const occ = new Occupancy()
  const sprites = new Map<string, AgentSprite>()
  for (const a of roster) {
    if (!ids.includes(a.id)) continue
    sprites.set(a.id, new AgentSprite(a.id, a.name, a.team, a.role, '#fff', map, occ, sprites))
  }
  let now = 0
  let minSeen = Infinity
  let firstViolation: string | null = null
  const step = (simSeconds: number, onFrame?: () => void) => {
    const dt = 1 / 60
    for (let f = 0; f < simSeconds * 60; f++) {
      now += dt * 1000
      for (const s of sprites.values()) s.update(dt, now)
      const list = [...sprites.values()]
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y)
          if (d < minSeen) {
            minSeen = d
            if (d < MIN_ALLOWED && !firstViolation) {
              firstViolation = `${list[i].id}@(${list[i].x.toFixed(2)},${list[i].y.toFixed(2)}) vs ${list[j].id}@(${list[j].x.toFixed(2)},${list[j].y.toFixed(2)}) d=${d.toFixed(3)} at t=${(now / 1000).toFixed(1)}s`
            }
          }
        }
      }
      onFrame?.()
    }
    if (firstViolation) { failures++; console.error(`FAIL: ${firstViolation}`); firstViolation = null }
  }
  return { sprites, step, minSeen: () => minSeen }
}

// goTo is private-ish through status flows; drive it via the public visit-style
// path by reaching into the instance (same-module access the engine also has).
const send = (s: AgentSprite, dest: Point) => (s as unknown as { goTo(p: Point): void }).goTo(dest)

// ── 1. head-on corridor pass ────────────────────────────────────────────────
{
  const sim = makeSim(['physics-0', 'chemistry-0'])
  const [a, b] = [...sim.sprites.values()]
  // teleport both onto the corridor row facing each other (claims via goTo snap)
  send(a, { x: 20, y: 15 }); send(b, { x: 40, y: 15 })
  sim.step(30)
  send(a, { x: 40, y: 15 }); send(b, { x: 20, y: 15 }) // swap → head-on
  sim.step(40)
  console.log(`head-on corridor: min pairwise distance = ${sim.minSeen().toFixed(3)} tiles`)
}

// ── 2. coffee rush ──────────────────────────────────────────────────────────
{
  const ids = teamIds.map(t => `${t}-0`).concat(['physics-1', 'chemistry-1'])
  const sim = makeSim(ids)
  const stands: Point[] = [
    { x: 77, y: 19 }, { x: 76, y: 19 }, { x: 78, y: 19 }, { x: 75, y: 19 }, { x: 79, y: 19 },
    { x: 77, y: 20 }, { x: 76, y: 20 }, { x: 78, y: 20 }, { x: 75, y: 20 }, { x: 79, y: 20 },
  ]
  const list = [...sim.sprites.values()]
  list.forEach((s, i) => send(s, stands[i % stands.length]))
  sim.step(60)
  console.log(`coffee rush:      min pairwise distance = ${sim.minSeen().toFixed(3)} tiles`)
}

// ── 3. full-floor fuzz ──────────────────────────────────────────────────────
{
  const sim = makeSim(roster.map(a => a.id))
  const map = buildOfficeMap(teams as never, roster as never)
  const open: Point[] = []
  for (let y = 1; y < 31; y++) for (let x = 1; x < 81; x++) if (map.walkable(x, y)) open.push({ x, y })
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const list = [...sim.sprites.values()]
  let frame = 0
  sim.step(180, () => {
    // every 3 sim-seconds, send a random third of the floor somewhere new
    if (frame++ % 180 === 0) {
      for (const s of list) if (rnd() < 0.33) send(s, open[Math.floor(rnd() * open.length)])
    }
  })
  console.log(`full-floor fuzz:  min pairwise distance = ${sim.minSeen().toFixed(3)} tiles (57 agents, 180s)`)
}

if (failures > 0) { console.error(`${failures} scenario(s) violated the ${MIN_ALLOWED} separation floor`); process.exit(1) }
console.log(`OK — no two bodies ever closer than ${MIN_ALLOWED} tiles.`)
