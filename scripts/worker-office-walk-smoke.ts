// Walkability smoke test for the WORKER OFFICE map (office-walk-smoke.ts style). Run: npx tsx scripts/worker-office-walk-smoke.ts
// Builds the map with loadMap() — the code the page runs — and, starting from the DOORSTEP outside the front door
// (not the old map.lobby), asserts:
//  1. every interaction point is reachable: a stand point on its own tile, a seat through its sitFrom tile (the
//     seat itself is solid and is entered only from there);
//  2. every place tile, arrival slot, overflow slot and exit-lane tile is walkable and reachable;
//  3. both door leaves are reachable, and a flood fill from the doorstep covers EVERY walkable tile (no orphan
//     pockets);
//  4. the check can fail: the same walk with the reception/corridor opening blocked must report unreachable tiles.
// Exits non-zero on any failure.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadMap, type OfficeMap, type Tile } from '../src/worker-office/map/loadMap'

const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8'))
const map = loadMap(raw)

type Walk = (x: number, y: number) => boolean
const key = (t: Tile) => `${t.x},${t.y}`
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const

/** Shortest walk from a to b over walkable tiles (BFS), or null. */
function path(walk: Walk, a: Tile, b: Tile): Tile[] | null {
  if (a.x === b.x && a.y === b.y) return [a]
  const prev = new Map<string, Tile | null>([[key(a), null]])
  const q: Tile[] = [a]
  for (let head = 0; head < q.length; head++) {
    const c = q[head]
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy }
      if (prev.has(key(n)) || !walk(n.x, n.y)) continue
      prev.set(key(n), c)
      if (n.x === b.x && n.y === b.y) {
        const out: Tile[] = [n]
        for (let p = prev.get(key(n)); p; p = prev.get(key(p))) out.push(p)
        return out.reverse()
      }
      q.push(n)
    }
  }
  return null
}

function smoke(m: OfficeMap, walk: Walk) {
  const problems: string[] = []
  const start = m.door.doormat[0]
  if (!walk(start.x, start.y)) problems.push(`doorstep (${start.x},${start.y}) is not walkable`)
  const targets: { label: string; t: Tile }[] = []
  for (const p of m.points) {
    if (p.how === 'stand') targets.push({ label: `${p.objectId} stand point`, t: p })
    else {
      if (walk(p.x, p.y)) problems.push(`${p.objectId} seat (${p.x},${p.y}) is walkable; seats must be solid`)
      targets.push({ label: `${p.objectId} seat (${p.x},${p.y}) via sitFrom`, t: p.sitFrom! })
    }
  }
  for (const p of m.places) targets.push({ label: `place ${p.pool}`, t: p })
  for (const s of m.arrivalSlots) targets.push({ label: `arrival slot ${s.order}`, t: s })
  for (const s of m.arrivalSlotsOverflow) targets.push({ label: 'overflow slot', t: s })
  for (const s of m.exitLane) targets.push({ label: 'exit lane', t: s })
  targets.push({ label: 'door IN leaf', t: m.door.inLeaf }, { label: 'door OUT leaf', t: m.door.outLeaf })
  let reached = 0
  for (const { label, t } of targets) {
    if (!walk(t.x, t.y)) { problems.push(`${label} at (${t.x},${t.y}) is not walkable`); continue }
    if (!path(walk, start, t)) problems.push(`${label} at (${t.x},${t.y}) unreachable from the doorstep`)
    else reached++
  }
  // flood fill from the doorstep must cover every walkable tile
  const seen = new Set([key(start)])
  const stack: Tile[] = [start]
  while (stack.length) {
    const c = stack.pop()!
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy }
      if (!seen.has(key(n)) && walk(n.x, n.y)) { seen.add(key(n)); stack.push(n) }
    }
  }
  let walkable = 0
  const orphans: string[] = []
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (!walk(x, y)) continue
    walkable++
    if (!seen.has(`${x},${y}`)) orphans.push(`(${x},${y})[${m.tiles[y][x]}]`)
  }
  if (orphans.length) problems.push(`${orphans.length} orphan walkable tiles: ${orphans.slice(0, 12).join(' ')}${orphans.length > 12 ? ' …' : ''}`)
  return { problems, targets: targets.length, reached, walkable, flooded: seen.size }
}

let failures = 0
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`) }

const r = smoke(map, map.walkable)
for (const p of r.problems) fail(p)
const stand = map.points.filter(p => p.how === 'stand').length, seats = map.points.length - stand
console.log(`start: doorstep (${map.door.doormat[0].x},${map.door.doormat[0].y}) outside the front door`)
console.log(`interaction points: ${map.points.length} (${stand} stand + ${seats} seats via sitFrom) (expect 88 = 70 + 18)`)
console.log(`place tiles ${map.places.length} (expect 32), arrival slots ${map.arrivalSlots.length} (expect 20), overflow ${map.arrivalSlotsOverflow.length}, exit lane ${map.exitLane.length}`)
console.log(`targets reached: ${r.reached} of ${r.targets}`)
console.log(`walkable tiles: ${r.walkable}, flood-fill reached: ${r.flooded} (expect 458 / 458)`)
if (map.points.length !== 88 || stand !== 70) fail(`expected 88 points (70 stand), got ${map.points.length} (${stand})`)
if (map.places.length !== 32) fail(`expected 32 place tiles, got ${map.places.length}`)
if (map.arrivalSlots.length !== 20) fail(`expected 20 arrival slots, got ${map.arrivalSlots.length}`)
if (r.walkable !== 458 || r.flooded !== 458) fail(`expected 458 walkable tiles all reached, got ${r.walkable} / ${r.flooded}`)
if (r.reached !== r.targets) fail(`${r.targets - r.reached} targets unreachable`)

// 4: the smoke must be able to fail — block the reception/corridor opening and expect cut-off targets
const opening = map.openings.find(o => o.name === 'reception|corridor')!
const blocked = new Set(opening.tiles.map(key))
const rb = smoke(map, (x, y) => map.walkable(x, y) && !blocked.has(`${x},${y}`))
if (rb.problems.length === 0) fail('blocking the reception/corridor opening was NOT detected')
else console.log(`self-test: opening reception|corridor blocked -> ${rb.targets - rb.reached} targets unreachable, ${rb.walkable - rb.flooded} tiles cut off (detected)`)

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('OK — from the doorstep every point, seat, place tile, slot and lane tile is reachable; no orphan pockets.')
