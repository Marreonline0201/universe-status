// Walkability smoke test for the office floor plan. Run: npx tsx scripts/office-walk-smoke.ts
// Builds the map with a full synthetic roster (8 teams × 7 agents + director) and asserts:
//  1. every assigned desk chair is walkable and reachable from the lobby,
//  2. every meeting seat and the coffee stand tile are reachable,
//  3. flood-fill from the lobby covers EVERY walkable tile (no orphan pockets
//     created by furniture/glass walls).
// Exits non-zero on any failure — safe to wire into CI later.
import { buildOfficeMap, MAP_W, MAP_H } from '../src/office-render/officeMap'
import { findPath } from '../src/office-render/pathfind'

const ROLES = ['Team Lead', 'Senior Researcher', 'Senior Researcher', 'Senior Researcher', 'Reviewer / Editor', 'Research Engineer', 'Liaison / Scribe']
const teamIds = ['physics', 'chemistry', 'bio', 'fluid', 'game', 'ml', 'rendering', 'engine']
const teams = teamIds.map(id => ({ id, name: id, color: '#ffffff' }))
const agents: { id: string; name: string; team: string; role: string }[] = [
  { id: 'director', name: 'Director', team: 'company', role: 'Company Director' },
]
for (const t of teamIds) {
  ROLES.forEach((role, i) => agents.push({ id: `${t}-${i}`, name: `${t}-${i}`, team: t, role }))
}

const map = buildOfficeMap(teams as never, agents as never)

let failures = 0
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`) }

// 1+2: reachability of every point of interest from the lobby
const targets: { label: string; p: { x: number; y: number } }[] = []
for (const [id, spot] of map.desks) targets.push({ label: `chair of ${id}`, p: spot.chair })
map.meetingSeats.forEach((p, i) => targets.push({ label: `meeting seat ${i}`, p }))
targets.push({ label: 'coffee stand tile', p: { x: map.coffee.x, y: map.coffee.y + 1 } })

for (const t of targets) {
  if (!map.walkable(t.p.x, t.p.y)) { fail(`${t.label} at (${t.p.x},${t.p.y}) is not walkable`); continue }
  const path = findPath(map.walkable, MAP_W, MAP_H, map.lobby, t.p)
  if (path.length === 0 && !(t.p.x === map.lobby.x && t.p.y === map.lobby.y)) {
    fail(`${t.label} at (${t.p.x},${t.p.y}) unreachable from lobby`)
  }
}

// 3: flood fill from lobby must cover every walkable tile (no orphan pockets)
const seen = new Set<string>()
const stack = [map.lobby]
seen.add(`${map.lobby.x},${map.lobby.y}`)
while (stack.length) {
  const { x, y } = stack.pop()!
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const nx = x + dx, ny = y + dy
    const k = `${nx},${ny}`
    if (!seen.has(k) && map.walkable(nx, ny)) { seen.add(k); stack.push({ x: nx, y: ny }) }
  }
}
let walkableCount = 0
const orphans: string[] = []
for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    if (map.walkable(x, y)) {
      walkableCount++
      if (!seen.has(`${x},${y}`)) orphans.push(`(${x},${y})[${map.tiles[y][x]}]`)
    }
  }
}
if (orphans.length > 0) fail(`${orphans.length} orphan walkable tiles unreachable from lobby: ${orphans.slice(0, 12).join(' ')}${orphans.length > 12 ? ' …' : ''}`)

console.log(`desks assigned: ${map.desks.size} (expect 57)`)
console.log(`zones: ${map.zones.length} (expect 8)`)
console.log(`walkable tiles: ${walkableCount}, flood-fill reached: ${seen.size}`)
if (map.desks.size !== 57) fail(`expected 57 assigned desks, got ${map.desks.size}`)
if (map.zones.length !== 8) fail(`expected 8 zones, got ${map.zones.length}`)

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('OK — every desk, seat, and amenity reachable; no orphan pockets.')
