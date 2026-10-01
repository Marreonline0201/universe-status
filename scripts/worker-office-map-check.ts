// Worker office map check (plan §6.1 tests). Run: npx tsx scripts/worker-office-map-check.ts
//
// A TypeScript port of the planning-phase Python checks, run on src/worker-office/data/floorplan.json ONLY:
//   - place_s3.py check_placement (C1 reachability, C2 no blocking + the busy office, C3 no overlaps) and its
//     reports (path corridors, 1-wide runs, wait-tile detours, seat side entries), as run by place_final.py;
//   - place_s3.py's C4 capacity RULE (not its replay) on the measured stats below — only so that mutation 7
//     ("history shelves capped at 7") has the check that catches it;
//   - infra_check.py: Cap, Vokrinek & Kleiner's "valid infrastructure" condition (ICAPS 2015, arXiv:1501.07704);
//   - validate_floorplan.py: flood from the doorstep with the legend + border rule.
// Every number is compared with the Python output (place_final.py same409 -> place_synth_final.json,
// infra_check.py, validate_floorplan.py, run 2026-10-01); 7 + 1 + 1 layout mutations must each FAIL with the
// failure Python reported. The port mirrors Python's iteration and BFS neighbour order
// ((0,1),(0,-1),(1,0),(-1,0)), so tie-broken paths (arrival/departure lanes, side entries) match exactly.
// Finally loadMap() — the code the page runs — must agree with the port tile for tile.
// Exits 1 on any difference.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadMap, OBJECT_TILE_KINDS, STRUCTURE_KIND_BY_CHAR } from '../src/worker-office/map/loadMap'

const JSON_PATH = fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url))
// vault worker-office/floorplan.json with its line endings normalised to LF (the vault file is CRLF, raw sha256
// f107112a21554ddc…; git stores LF, so a checkout may hold either — the content is what is pinned)
const FILE_SHA256_LF = 'c30bbe4ad3c3a83ca9c07cfce950a6eec5e47a5a7e3f6a51f703d5ca1bca1baf'
const GRID_SHA256 = 'e9548001a0d8f15b7846f82d8c563fda6f2bf6d4d69c4c6ac51cca0413545fdb'

let failures = 0
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`) }
const expectEq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) console.log(`  ok   ${what}: ${g.length > 110 ? g.slice(0, 107) + '...' : g}`)
  else fail(`${what}: got ${g} want ${w}`)
}

// ── 0. provenance ──────────────────────────────────────────────────────────────────────────────────────────────
const bytes = readFileSync(JSON_PATH)
const raw = JSON.parse(bytes.toString('utf8'))
console.log('provenance')
const lfText = bytes.toString('utf8').split('\r\n').join('\n')
expectEq('floorplan.json sha256, LF-normalised (= the vault copy)', createHash('sha256').update(lfText, 'utf8').digest('hex'), FILE_SHA256_LF)
const ROWS: string[] = raw.rows
expectEq('grid sha256 of rows', createHash('sha256').update(ROWS.join('\n') + '\n', 'utf8').digest('hex'), GRID_SHA256)
expectEq('gridSha256 field', raw.gridSha256, GRID_SHA256)

// ── 1. the layout, read from the JSON exactly as place_s3.py / infra_check.py hold it ──────────────────────────
type P = readonly [number, number]
const W: number = raw.width, H: number = raw.height
const k = (p: P) => `${p[0]},${p[1]}`
const fmt = (p: P) => `(${p[0]}, ${p[1]})`                       // Python's tuple repr
const fmtList = (ps: readonly P[]) => `[${ps.map(fmt).join(', ')}]`
const legend: Record<string, { walkable: boolean; name: string }> = raw.legend
const WALK_CH = new Set(Object.keys(legend).filter(c => legend[c].walkable))
expectEq('legend-walkable characters = place_s3.py WALK_CH', [...WALK_CH].sort().join(''), [...'+:.,qumD*'].sort().join(''))

interface Pt { id: string; kind: string; tile: P; how: 'stand' | 'sit'; sitFrom: P | null }
const POINTS: Pt[] = []
for (const o of raw.objects) {
  for (const i of o.interaction) {
    POINTS.push({ id: o.id, kind: o.kind, tile: [i.x, i.y], how: i.how, sitFrom: i.how === 'sit' ? [i.sitFrom.x, i.sitFrom.y] : null })
  }
}
const placesByPool = new Map<string, P[]>()
for (const p of raw.places) { if (!placesByPool.has(p.pool)) placesByPool.set(p.pool, []); placesByPool.get(p.pool)!.push([p.x, p.y]) }
const pool = (name: string) => placesByPool.get(name) ?? []
const WAIT_TILES: P[] = raw.places.map((p: { x: number; y: number }) => [p.x, p.y] as P)    // 28 step-3 wait/queue + 4 hold
const QUEUE = pool('front-desk queue')
const HOLD = pool('hold')
const OPENINGS: [string, P[]][] = Object.entries(raw.openings as Record<string, { x: number; y: number }[]>).map(([n, ts]) => [n, ts.map(t => [t.x, t.y] as P)])
const zone = (name: string) => {
  const z = raw.zones.find((q: { name: string }) => q.name === name)
  if (!z) throw new Error(`zone ${name} missing`)
  return z as { x: number; y: number; w: number; h: number }
}
const CORRIDOR = zone('CORRIDOR')
const IN_LEAF: P = [raw.door.inLeaf.x, raw.door.inLeaf.y]
const OUT_LEAF: P = [raw.door.outLeaf.x, raw.door.outLeaf.y]
const DOORSTEP: P[] = raw.door.doormat.map((t: { x: number; y: number }) => [t.x, t.y] as P)
const FACADE_ROW: number = raw.door.y
const SLOTS: P[] = raw.arrivalSlots.map((t: { x: number; y: number }) => [t.x, t.y] as P)
const EXIT_LANE: P[] = raw.exitLane.map((t: { x: number; y: number }) => [t.x, t.y] as P)
// place_s3.py hard-codes these; here they are derived from the data and pinned to Python's values
const recCorr = OPENINGS.find(([n]) => n === 'reception|corridor')![1]
const ARRIVAL_TARGET = recCorr.find(t => t[0] === IN_LEAF[0])!               // place_s3.py: (17, 13)
const frontDesk = raw.objects.find((o: { kind: string }) => o.kind === 'frontDesk')
const DESK_SPOTS: P[] = frontDesk.interaction.map((i: { x: number; y: number }) => [i.x, i.y] as P)  // (14,17), (15,17)
expectEq('arrival-lane target (place_s3.py (17, 13))', ARRIVAL_TARGET, [17, 13])
expectEq('front-desk spots (place_s3.py (15,17), (14,17))', [...DESK_SPOTS].sort((a, b) => a[0] - b[0]), [[14, 17], [15, 17]])
expectEq('doorstep (place_s3.py DOORSTEP)', DOORSTEP, [[16, 20], [17, 20]])

const DIRS: P[] = [[0, 1], [0, -1], [1, 0], [-1, 0]]
type Walk = (x: number, y: number) => boolean
/** place_s3.py make_walk: solid = every character that is not in WALK_CH; the border is never walkable. */
function makeWalk(rows: readonly string[], blocked: ReadonlySet<string> = new Set()): Walk {
  return (x, y) => 0 < x && x < W - 1 && 0 < y && y < H - 1 && WALK_CH.has(rows[y][x]) && !blocked.has(`${x},${y}`)
}
/** place_s3.py find_path (pathfind.ts:4-47): BFS, DIRS order, a solid destination allowed, stop when found. */
function findPath(walk: Walk, frm: P, to: P): P[] {
  if (frm[0] === to[0] && frm[1] === to[1]) return []
  const prev = new Map<string, P | null>([[k(frm), null]])
  const q: P[] = [frm]
  let head = 0, found = false
  while (head < q.length && !found) {
    const c = q[head++]
    for (const [dx, dy] of DIRS) {
      const n: P = [c[0] + dx, c[1] + dy]
      if (!(0 <= n[0] && n[0] < W && 0 <= n[1] && n[1] < H) || prev.has(k(n))) continue
      const isDest = n[0] === to[0] && n[1] === to[1]
      if (!walk(n[0], n[1]) && !isDest) continue
      prev.set(k(n), c)
      if (isDest) { found = true; break }
      q.push(n)
    }
  }
  if (!found) return []
  const path: P[] = []
  let c: P = to
  while (!(c[0] === frm[0] && c[1] === frm[1])) { path.push(c); c = prev.get(k(c))! }
  return path.reverse()
}
const flood = (walk: Walk, start: P) => {
  const seen = new Set([k(start)]); const st: P[] = [start]
  while (st.length) {
    const [x, y] = st.pop()!
    for (const [dx, dy] of DIRS) { const n: P = [x + dx, y + dy]; if (!seen.has(k(n)) && walk(n[0], n[1])) { seen.add(k(n)); st.push(n) } }
  }
  return seen
}

// ── 2. place_s3.py check_placement (C1-C3 + busy office) ───────────────────────────────────────────────────────
function apronCells(): Set<string> {
  const ap = new Set<string>()
  for (const [, cells] of OPENINGS) {
    const horiz = new Set(cells.map(c => c[1])).size === 1
    for (const [x, y] of cells) for (const q of horiz ? [[x, y - 1], [x, y + 1]] : [[x - 1, y], [x + 1, y]]) ap.add(k(q as unknown as P))
  }
  return ap
}
const unkey = (s: string): P => s.split(',').map(Number) as unknown as P

function checkPlacement(rows: readonly string[], points: readonly Pt[], waitTiles: readonly P[], queueTiles: readonly P[]) {
  const F: string[] = []
  const walk = makeWalk(rows)
  const solid = (c: string) => !WALK_CH.has(c)
  const standPts = points.filter(p => p.how === 'stand').map(p => p.tile)
  const seats = new Map(points.filter(p => p.how === 'sit').map(p => [k(p.tile), p.sitFrom!] as const))
  const ptTiles = points.map(p => p.tile)
  // C1 reachability
  const seen = flood(walk, DOORSTEP[0])
  const wt: P[] = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walk(x, y)) wt.push([x, y])
  const orphans = wt.filter(p => !seen.has(k(p)))
  if (orphans.length) F.push(`C1 orphan walkable tiles ${fmtList(orphans)}`)
  for (const p of [...standPts, ...seats.values(), ...waitTiles]) if (!seen.has(k(p))) F.push(`C1 ${fmt(p)} not reachable from the doorstep`)
  for (const [s, frm] of seats) { const sp = unkey(s); if (Math.abs(sp[0] - frm[0]) + Math.abs(sp[1] - frm[1]) !== 1) F.push(`C1 seat ${fmt(sp)}: sitFrom ${fmt(frm)} not adjacent`) }
  for (const p of SLOTS) if (!seen.has(k(p))) F.push(`C1 arrival slot ${fmt(p)} unreachable`)
  // C2 nothing on openings, aprons, the door, the corridor, the slots, the exit lane, the arrival/departure lanes
  const aprons = apronCells()
  const arrivalLane = new Set([...findPath(walk, IN_LEAF, ARRIVAL_TARGET).map(k), k(IN_LEAF)])
  const depart = new Set(DESK_SPOTS.flatMap(sp => findPath(walk, sp, OUT_LEAF).map(k)))
  const corridorCells = new Set<string>()
  for (let x = CORRIDOR.x; x < CORRIDOR.x + CORRIDOR.w; x++) for (let y = CORRIDOR.y; y < CORRIDOR.y + CORRIDOR.h; y++) corridorCells.add(`${x},${y}`)
  const keep: [string, Set<string>][] = [
    ['opening', new Set(OPENINGS.flatMap(([, c]) => c.map(k)))],
    ['opening apron', aprons],
    ['door/doormat/inside apron', new Set([IN_LEAF, OUT_LEAF, [OUT_LEAF[0], OUT_LEAF[1] - 1] as P, [IN_LEAF[0], IN_LEAF[1] - 1] as P, ...DOORSTEP].map(k))],
    ['corridor', corridorCells],
    ['arrival lane', arrivalLane],
    ['arrival slot', new Set(SLOTS.map(k))],
    ['exit lane', new Set(EXIT_LANE.map(k))],
    ['departure lane', depart],
  ]
  const pset = new Set(ptTiles.map(k))
  const queueSet = new Set(queueTiles.map(k))
  const wset = new Set(waitTiles.map(k).filter(s => !queueSet.has(s)))
  const sset = new Set([...seats.values()].map(k))
  for (const [what, cells] of keep) {
    for (const s of cells) {
      const p = unkey(s)
      const c = rows[p[1]][p[0]]
      if (solid(c) && !'#~%_'.includes(c)) F.push(`C2 object "${c}" on ${what} ${fmt(p)}`)
      if (pset.has(s) && what !== 'departure lane') F.push(`C2 interaction point on ${what} ${fmt(p)}`)
      if (wset.has(s)) F.push(`C2 wait tile on ${what} ${fmt(p)}`)
      if (sset.has(s)) F.push(`C2 sit-down tile on ${what} ${fmt(p)}`)
    }
  }
  for (const [n, cells] of OPENINGS) if (cells.length < 2 || !cells.every(c => walk(c[0], c[1]))) F.push(`C2 opening ${n} narrower than 2 or blocked`)
  for (let x = CORRIDOR.x; x < CORRIDOR.x + CORRIDOR.w; x++) {
    let n = 0
    for (let y = CORRIDOR.y; y < CORRIDOR.y + CORRIDOR.h; y++) if (walk(x, y)) n++
    if (n < 2) F.push(`C2 corridor pinch at x=${x}`)
  }
  // busy office: every stand spot and every wait/queue/hold tile occupied (seats are solid anyway)
  const busy = new Set([...standPts, ...waitTiles].map(k))
  const fs = flood(makeWalk(rows, busy), DOORSTEP[0])
  const near = (p: P) => DIRS.some(([dx, dy]) => fs.has(`${p[0] + dx},${p[1] + dy}`))
  const boxed = [...standPts, ...waitTiles, ...seats.values()].filter(p => !fs.has(k(p)) && !near(p))
  if (boxed.length) F.push(`C2 busy office: boxed in ${fmtList(boxed)}`)
  for (const [n, cells] of OPENINGS) if (!cells.every(c => fs.has(k(c)))) F.push(`C2 busy office: opening ${n} cut off`)
  for (const leaf of [IN_LEAF, OUT_LEAF]) if (!fs.has(k(leaf))) F.push(`C2 busy office: door leaf ${fmt(leaf)} cut off`)
  const standSet = new Set(standPts.map(k)), waitSet = new Set(waitTiles.map(k))
  for (const p of standPts) {   // a wait tile must never be a spot's only exit
    const ex = ([[p[0] + 1, p[1]], [p[0] - 1, p[1]], [p[0], p[1] + 1], [p[0], p[1] - 1]] as P[]).filter(q => walk(q[0], q[1]) && !standSet.has(k(q)))
    if (ex.length && ex.every(q => waitSet.has(k(q)))) F.push(`C2 wait tile is the only exit of spot ${fmt(p)}`)
  }
  // C3 no overlaps
  if (new Set(ptTiles.map(k)).size !== ptTiles.length) F.push('C3 two points share a tile')
  const sd = [...seats.values()]
  if (new Set(sd.map(k)).size !== sd.length) F.push('C3 two seats share a sit-down tile')
  for (const s of sd) if (pset.has(k(s)) || waitSet.has(k(s))) F.push(`C3 sit-down tile ${fmt(s)} is also a point/wait tile`)
  if (waitTiles.some(w => pset.has(k(w)))) F.push('C3 a wait tile is on a point')
  if (waitSet.size !== waitTiles.length) F.push('C3 duplicate wait tile')
  for (const p of standPts) if (WALK_CH.has(rows[p[1] - 1][p[0]])) F.push(`C3 spot ${fmt(p)} has no object directly N`)
  return { F, fs }
}

// ── 3. the layout as delivered: ALL PASS, with Python's numbers ───────────────────────────────────────────────
console.log('C1-C3 (place_s3.py check_placement, as run by place_final.py)')
expectEq('interaction points / place tiles (88 / 32)', [POINTS.length, WAIT_TILES.length], [88, 32])
const base = checkPlacement(ROWS, POINTS, WAIT_TILES, QUEUE)
expectEq('failures on the delivered layout', base.F, [])
const walkable = makeWalk(ROWS)
let walkCount = 0
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walkable(x, y)) walkCount++
expectEq('walkable tiles (Python 458)', walkCount, 458)
expectEq('busy office: tiles still reachable (Python 355)', base.fs.size, 355)

// C1 path corridors: IN leaf -> each point's approach tile, as a sequence of regions
const SITFROM = new Map(POINTS.filter(p => p.how === 'sit').map(p => [k(p.tile), p.sitFrom!] as const))
const standTile = (p: P): P => SITFROM.get(k(p)) ?? p
const ROOMS = raw.zones.filter((z: { parent?: string; name: string; y: number }) => !z.parent && z.name !== 'CORRIDOR' && z.y < FACADE_ROW)
function region(p: P): string {
  for (const [n, cells] of OPENINGS) if (cells.some(c => c[0] === p[0] && c[1] === p[1])) return 'opening ' + n.replace('|', '/')
  if (k(p) === k(IN_LEAF) || k(p) === k(OUT_LEAF)) return 'FRONT DOOR'
  if (p[1] > FACADE_ROW) return 'SIDEWALK'
  if (CORRIDOR.x <= p[0] && p[0] < CORRIDOR.x + CORRIDOR.w && CORRIDOR.y <= p[1] && p[1] < CORRIDOR.y + CORRIDOR.h) return 'CORRIDOR'
  for (const z of ROOMS) if (z.x <= p[0] && p[0] < z.x + z.w && z.y <= p[1] && p[1] < z.y + z.h) return z.name
  return '?'
}
const corridors = new Map<string, number>()
for (const pt of POINTS) {
  const seq = [IN_LEAF, ...findPath(walkable, IN_LEAF, standTile(pt.tile))].map(region)
  const comp = seq.filter((s, i) => i === 0 || s !== seq[i - 1]).join(' > ')
  corridors.set(comp, (corridors.get(comp) ?? 0) + 1)
}
const PY_CORRIDORS: Record<string, number> = {
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening records/corridor > RECORDS': 30,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening records/corridor > RECORDS > opening library/records > LIBRARY': 12,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening library/corridor > LIBRARY': 4,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening records/corridor > RECORDS > opening records/work > WORK ROOM': 10,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening meeting/corridor > MEETING': 6,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening work/corridor > WORK ROOM': 4,
  'FRONT DOOR > RECEPTION': 11,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening servers/corridor > SERVERS': 2,
  'FRONT DOOR > RECEPTION > opening reception/corridor > CORRIDOR > opening break/corridor > BREAK ROOM': 9,
}
const sortObj = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
expectEq('C1 path corridors IN leaf -> point (9 routes, Python counts)', sortObj(Object.fromEntries(corridors)), sortObj(PY_CORRIDORS))

// C2 reports: 1-wide runs in the busy office, wait-tile detours, a direct departure path
const bw = makeWalk(ROWS, new Set([...POINTS.filter(p => p.how === 'stand').map(p => p.tile), ...WAIT_TILES].map(k)))
const runs: [number, string][] = []
for (let y = 0; y < H; y++) {
  let x = 0
  while (x < W) {
    if (bw(x, y) && !bw(x, y - 1) && !bw(x, y + 1)) {
      const x0 = x
      while (x < W && bw(x, y) && !bw(x, y - 1) && !bw(x, y + 1)) x++
      if (x - x0 >= 3) runs.push([x - x0, `row y=${y} x=${x0}-${x - 1}`])
    } else x++
  }
}
runs.sort((a, b) => b[0] - a[0] || (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
expectEq('C2 busy office 1-wide runs >= 3 (Python list; longest 4)', runs, [
  [4, 'row y=9 x=3-6'], [4, 'row y=9 x=27-30'], [4, 'row y=6 x=3-6'], [4, 'row y=6 x=27-30'], [4, 'row y=6 x=18-21'],
  [4, 'row y=6 x=12-15'], [4, 'row y=3 x=3-6'], [4, 'row y=3 x=27-30'], [4, 'row y=3 x=18-21'], [4, 'row y=3 x=12-15'],
  [3, 'row y=9 x=19-21'], [3, 'row y=9 x=12-14'], [3, 'row y=18 x=1-3'], [3, 'row y=15 x=1-3']])
const APPR = [...new Set(POINTS.map(p => k(standTile(p.tile))))].map(unkey).sort((a, b) => a[0] - b[0] || a[1] - b[1])
const APPR_SET = new Set(APPR.map(k))
function bfsAll(src: P, blocked: ReadonlySet<string>) {
  const d = new Map([[k(src), 0]]); const q: P[] = [src]; let head = 0
  while (head < q.length) {
    const c = q[head++]
    for (const [dx, dy] of DIRS) {
      const n: P = [c[0] + dx, c[1] + dy]
      if (d.has(k(n)) || !walkable(n[0], n[1]) || (blocked.has(k(n)) && !APPR_SET.has(k(n)))) continue
      d.set(k(n), d.get(k(c))! + 1); q.push(n)
    }
  }
  return d
}
const WS = new Set(WAIT_TILES.map(k).filter(s => !new Set(QUEUE.map(k)).has(s)))
const added: number[] = []
for (const a of APPR) {
  const d0 = bfsAll(a, new Set()), d1 = bfsAll(a, WS)
  for (const b of APPR) if (k(b) !== k(a)) added.push((d1.get(k(b)) ?? 1e6) - d0.get(k(b))!)
}
const longer = added.filter(x => x > 0).length
expectEq('C2 wait-tile detours: pairs / unreachable / share longer / max added (Python 7656, 0, 0.0123, 2)',
  [added.length, added.filter(x => x >= 1e6).length, Math.round(longer / added.length * 1e4) / 1e4, Math.max(...added.filter(x => x < 1e6))],
  [7656, 0, 0.0123, 2])
expectEq('C2 direct departure path (17,13) -> OUT leaf (Python, tie-break check)', findPath(walkable, ARRIVAL_TARGET, OUT_LEAF),
  [[17, 14], [17, 15], [17, 16], [17, 17], [17, 18], [17, 19], [16, 19]])

// C3 report: plain BFS to a seat itself steps in from the side for 3 seats -> "sit only from sitFrom"
const sideEntry: [P, P, P][] = []
for (const [s, frm] of SITFROM) {
  const seat = unkey(s), path = findPath(walkable, IN_LEAF, seat)
  const via = path.length >= 2 ? path[path.length - 2] : IN_LEAF
  if (k(via) !== k(frm)) sideEntry.push([seat, via, frm])
}
expectEq('C3 seat side entries (Python: (6,8) from (7,8), (26,2) from (25,2), (3,17) from (4,17))', sideEntry,
  [[[6, 8], [7, 8], [6, 9]], [[26, 2], [25, 2], [26, 3]], [[3, 17], [4, 17], [3, 18]]])

// ── 4. C4 capacity rule (place_s3.py 456-513) — needed for mutation 7 ─────────────────────────────────────────
// Measured concurrency per object kind (max / p95 / p99 of simultaneous helpers), from measure_final_same409.json
// (sha256 19c78068443acddcb53577c6a5c04e2e3edfaa8da319b51806d38a20816f3878): 409 helpers, 37.0 busy h, ONE
// session, final classifier (plan §3.4). Category counts only.
const STATS: Record<string, { max: number; p95: number; p99: number }> = {
  ARRIVING: { max: 14, p95: 0, p99: 1 }, benchTerminal: { max: 9, p95: 4, p99: 6 }, bookshelf: { max: 7, p95: 1, p99: 2 },
  cardCatalog: { max: 4, p95: 0, p99: 1 }, copier: { max: 1, p95: 0, p99: 0 }, fileCabinet: { max: 14, p95: 7, p99: 11 },
  frontDesk: { max: 4, p95: 0, p99: 0 }, historyShelf: { max: 15, p95: 2, p99: 8 }, lectern: { max: 5, p95: 2, p99: 2 },
  lounge: { max: 2, p95: 1, p99: 1 }, manualsShelf: { max: 1, p95: 0, p99: 0 }, pcDesk: { max: 4, p95: 1, p99: 2 },
  pigeonholes: { max: 1, p95: 0, p99: 0 }, postShelf: { max: 1, p95: 0, p99: 0 }, printer: { max: 1, p95: 0, p99: 0 },
  shredder: { max: 2, p95: 0, p99: 0 },
}
// overflow chains, verbatim from place_s3.py:467-473 (step 3 moves them into src/worker-office/map/places.ts)
const CHAIN: Record<string, string[]> = {
  fileCabinet: ['records'], historyShelf: ['lectern', 'records'], lectern: ['historyShelf', 'records'],
  bookshelf: ['readingLedge', 'readingTable', 'library'], cardCatalog: ['readingLedge', 'readingTable', 'library'],
  manualsShelf: ['readingTable', 'library'], pcDesk: ['benchTerminal', 'desks'],
  benchTerminal: ['pcDesk', 'bench'], serverRack: ['servers', 'benchTerminal'],
  meetingTable: ['kanbanBoard', 'meeting'], kanbanBoard: ['meeting'], pigeonholes: ['postShelf', 'mail'],
  postShelf: ['pigeonholes', 'mail'], copier: ['printer', 'mail'], printer: ['copier', 'mail'],
  shredder: ['mail'], frontDesk: ['frontq'], lounge: ['kitchen-standing'], inOutBoard: ['skip'],
}
function c4(points: readonly Pt[]) {
  const CAP = new Map<string, number>()
  for (const p of points) CAP.set(p.kind, (CAP.get(p.kind) ?? 0) + 1)
  const kitchen = ['fridge', 'sink', 'espressoMachine', 'waterCooler'].filter(x => CAP.get(x))
  const lounge = (CAP.get('sofaN') ?? 0) + (CAP.get('armchairN') ?? 0)
  const kitchenSpots = kitchen.reduce((s, x) => s + CAP.get(x)!, 0)
  for (const x of kitchen) CAP.delete(x)
  const waitPool: Record<string, number> = {
    records: pool('records-west').length + pool('records-east').length, library: pool('library').length,
    desks: pool('work-desks').length, bench: pool('work-bench').length, servers: pool('servers').length,
    meeting: pool('meeting').length, mail: pool('mail-corner').length, frontq: QUEUE.length,
    'kitchen-standing': kitchenSpots, skip: 1e6,
  }
  const CAPX = new Map(CAP); CAPX.set('lounge', lounge)
  const capOf = (c: string) => CAPX.get(c) ?? waitPool[c] ?? 0
  const rowFor = (kind: string, places: number) => {
    const s = STATS[kind] ?? { max: 0, p95: 0, p99: 0 }
    const chain = CHAIN[kind] ?? []
    const chainCap = places + chain.filter(c => c !== 'skip').reduce((t, c) => t + capOf(c), 0)
    return { kind, places, max: s.max, p95: s.p95, p99: s.p99, chain, chain_capacity: chainCap,
      pass: places >= s.p99 && (chainCap >= s.max || chain.includes('skip')) }
  }
  const kinds = [...new Set([...CAPX.keys(), ...Object.keys(STATS).filter(x => x !== 'ARRIVING')])]
    .sort((a, b) => (STATS[b]?.max ?? 0) - (STATS[a]?.max ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
  const rows = kinds.filter(x => x !== 'sofaN' && x !== 'armchairN').map(x => rowFor(x, CAPX.get(x) ?? 0))
  return { rows, CAPX, rowFor }
}
console.log('C4 capacity rule (place_s3.py; measured stats of one session)')
const cap = c4(POINTS)
const PY_C4 = [
  ['historyShelf', 8, 15, 2, 8, ['lectern', 'records'], 18], ['fileCabinet', 20, 14, 7, 11, ['records'], 28],
  ['benchTerminal', 8, 9, 4, 6, ['pcDesk', 'bench'], 18], ['bookshelf', 6, 7, 1, 2, ['readingLedge', 'readingTable', 'library'], 16],
  ['lectern', 2, 5, 2, 2, ['historyShelf', 'records'], 18], ['cardCatalog', 2, 4, 0, 1, ['readingLedge', 'readingTable', 'library'], 12],
  ['frontDesk', 2, 4, 0, 0, ['frontq'], 4], ['pcDesk', 6, 4, 1, 2, ['benchTerminal', 'desks'], 16],
  ['lounge', 5, 2, 1, 1, ['kitchen-standing'], 9], ['shredder', 1, 2, 0, 0, ['mail'], 5], ['copier', 1, 1, 0, 0, ['printer', 'mail'], 6],
  ['manualsShelf', 2, 1, 0, 0, ['readingTable', 'library'], 10], ['pigeonholes', 3, 1, 0, 0, ['postShelf', 'mail'], 8],
  ['postShelf', 1, 1, 0, 0, ['pigeonholes', 'mail'], 8], ['printer', 1, 1, 0, 0, ['copier', 'mail'], 6],
  ['inOutBoard', 2, 0, 0, 0, ['skip'], 2], ['kanbanBoard', 3, 0, 0, 0, ['meeting'], 5],
  ['meetingTable', 3, 0, 0, 0, ['kanbanBoard', 'meeting'], 8], ['readingLedge', 2, 0, 0, 0, [], 2],
  ['readingTable', 4, 0, 0, 0, [], 4], ['serverRack', 2, 0, 0, 0, ['servers', 'benchTerminal'], 12],
].map(([kind, places, max, p95, p99, chain, chain_capacity]) => ({ kind, places, max, p95, p99, chain, chain_capacity, pass: true }))
expectEq('C4 rows = Python (21 kinds, all PASS)', cap.rows, PY_C4)

// ── 5. mutations (each MUST fail, with exactly the failures Python reports) ──────────────────────────────────
// Expected lists: Python's FULL sorted failure list per mutation (place_s3.py check_placement on the final grid
// + hold tiles, exec'd read-only up to its QUEUE line as infra_check.py does; place_s3.py itself keeps only F[:2]).
function mutate(rows: readonly string[], x: number, y: number, ch: string) {
  return rows.map((r, yy) => (yy === y ? r.slice(0, x) + ch + r.slice(x + 1) : r))
}
const MUTS: [string, string[], P[], string[]][] = [
  ['solid object on the records/corridor apron (16,9)', mutate(ROWS, 16, 9, 'p'), WAIT_TILES,
    ['C2 object "p" on opening apron (16, 9)']],
  ['wait tile on (13,6), the only exit of spot (13,5)', mutate(ROWS, 13, 6, '*'), [...WAIT_TILES, [13, 6]],
    ['C2 busy office: boxed in [(13, 5)]', 'C2 wait tile is the only exit of spot (13, 5)']],
  ['wait tiles on (11,8) and (12,9), both exits of spot (12,8)', mutate(mutate(ROWS, 12, 9, '*'), 11, 8, '*'), [...WAIT_TILES, [12, 9], [11, 8]],
    ['C2 busy office: boxed in [(12, 8), (10, 8), (11, 9)]', 'C2 wait tile is the only exit of spot (12, 8)']],
  ['plant on the sit-down tile (27,3) of desk-2', mutate(ROWS, 27, 3, 'p'), WAIT_TILES,
    ['C1 (27, 3) not reachable from the doorstep']],
  ['object in the corridor at (20,11)+(20,12)', mutate(mutate(ROWS, 20, 11, 'p'), 20, 12, 'p'), WAIT_TILES,
    ['C2 corridor pinch at x=20', 'C2 object "p" on corridor (20, 11)', 'C2 object "p" on corridor (20, 12)']],
  ['wait tile on the arrival lane (17,16)', mutate(ROWS, 17, 16, '*'), [...WAIT_TILES, [17, 16]],
    ['C2 wait tile on arrival lane (17, 16)']],
]
console.log('mutations (each must FAIL)')
let caught = 0
for (const [name, rows, wt, py] of MUTS) {
  const { F } = checkPlacement(rows, POINTS, wt, QUEUE)
  const same = JSON.stringify([...F].sort()) === JSON.stringify([...py].sort())
  if (F.length > 0 && same) { caught++; console.log(`  caught: ${name} -> ${JSON.stringify([...F].sort())}`) }
  else fail(`mutation "${name}": got ${JSON.stringify(F)}, Python reported ${JSON.stringify(py)}`)
}
{ // 7: C4 history shelves capped at 7 instead of 8 (place_s3.py 508-514)
  const r = cap.rowFor('historyShelf', cap.CAPX.get('historyShelf')! - 1)
  const msg = `C4 historyShelf: places ${r.places} vs p99 ${r.p99}`
  if (!r.pass && msg === 'C4 historyShelf: places 7 vs p99 8') { caught++; console.log(`  caught: C4: history shelves capped at 7 instead of 8 -> ["${msg}"]`) }
  else fail(`mutation C4 history shelves capped at 7: pass=${r.pass}, ${msg}`)
}
expectEq('place_s3.py mutations caught', caught, 7)

// ── 6. infra_check.py: valid infrastructure (0 of 14,280 ordered pairs fail) ─────────────────────────────────
console.log('valid infrastructure (infra_check.py)')
const SEATS = new Map(POINTS.filter(p => p.how === 'sit').map(p => [k(p.tile), p.sitFrom!] as const))
const STAND = POINTS.filter(p => p.how === 'stand').map(p => p.tile)
const STEP3_WAIT = WAIT_TILES.filter(t => !HOLD.some(h => k(h) === k(t)))
function infra(endpoints: readonly P[]) {
  const E = new Set(endpoints.map(k))
  const fails: [string, string][] = []
  for (const s of endpoints) {
    const sk = k(s)
    const reached = new Set<string>()
    const seatFrom = SEATS.get(sk)
    if (seatFrom && E.has(k(seatFrom))) continue
    const start: P = seatFrom ?? s
    const seen = new Set([k(start)]); const q: P[] = [start]; let head = 0
    while (head < q.length) {
      const c = q[head++]
      for (const [dx, dy] of DIRS) {
        const n: P = [c[0] + dx, c[1] + dy], nk = k(n)
        if (seen.has(nk)) continue
        const nf = SEATS.get(nk)
        if (nf) { if (k(nf) === k(c) && E.has(nk)) { reached.add(nk); seen.add(nk) } continue }  // a seat: only from its sitFrom
        if (!walkable(n[0], n[1])) continue
        seen.add(nk)
        if (E.has(nk) && nk !== sk) { reached.add(nk); continue }                                // endpoints are never passed
        q.push(n)
      }
    }
    for (const g of E) if (!reached.has(g) && g !== sk) fails.push([sk, g])
  }
  return fails
}
const endpoints: P[] = [...STAND, ...[...SEATS.keys()].map(unkey), ...STEP3_WAIT, ...HOLD]
expectEq('endpoints: points / wait+queue / hold / total (Python 88, 28, 4, 120)',
  [STAND.length + SEATS.size, STEP3_WAIT.length, HOLD.length, new Set(endpoints.map(k)).size], [88, 28, 4, 120])
const inf = infra(endpoints)
expectEq('ordered pairs / pairs without an endpoint-free path (Python 14280 / 0)', [endpoints.length * (endpoints.length - 1), inf.length], [14280, 0])
const infMut = infra([...endpoints, [2, 18]])
if (infMut.length === 355) { caught++; console.log(`  caught: MUTATION endpoint on (2,18) -> ${infMut.length} failing pairs (Python 355)`) }
else fail(`infra mutation endpoint on (2,18): ${infMut.length} failing pairs, Python 355`)
// sensitivity of the seat rule (a seat is entered ONLY from its sitFrom): an endpoint on a sitFrom tile cuts its seat
// off; Python's check() gives 119 failing pairs for each (a "from any side" rule would give fewer)
expectEq('seat rule: endpoint on sitFrom (6,9) / (26,3) -> failing pairs (Python 119 / 119)',
  [infra([...endpoints, [6, 9]]).length, infra([...endpoints, [26, 3]]).length], [119, 119])

// ── 7. validate_floorplan.py: flood from the doorstep with legend.walkable + the border rule ───────────────────
console.log('floorplan.json reachability (validate_floorplan.py)')
function reach(rows: readonly string[]) {
  const walk: Walk = (x, y) => 0 < x && x < W - 1 && 0 < y && y < H - 1 && legend[rows[y][x]].walkable
  const seen = flood(walk, DOORSTEP[0])
  const need: P[] = [
    ...POINTS.map(p => (p.how === 'stand' ? p.tile : p.sitFrom!)),
    ...raw.places.map((p: { x: number; y: number }) => [p.x, p.y] as P),
    ...SLOTS,
  ]
  return { miss: need.filter(p => !seen.has(k(p))), n: seen.size }
}
const r0 = reach(ROWS)
expectEq('walkable tiles reached from the doorstep / unreachable required (Python 458 / [])', [r0.n, r0.miss], [458, []])
let walledRows = ROWS
for (const x of [15, 16, 17, 18]) walledRows = mutate(walledRows, x, 13, '#')
const r1 = reach(walledRows)
if (r1.miss.length === 99) { caught++; console.log(`  caught: MUTATION reception/corridor opening walled -> ${r1.miss.length} required tiles cut off (Python 99)`) }
else fail(`floorplan mutation (opening walled): ${r1.miss.length} cut off, Python 99`)

// ── 8. the page's own loader agrees with this port ────────────────────────────────────────────────────────────
console.log('loadMap() (the code the page runs) vs this port')
const map = loadMap(raw)
let diff = 0
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (map.walkable(x, y) !== walkable(x, y)) diff++
expectEq('tiles where loadMap.walkable differs from place_s3.py make_walk', diff, 0)
expectEq('points / stand / seats / places / slots / overflow / exit lane',
  [map.points.length, map.points.filter(p => p.how === 'stand').length, map.points.filter(p => p.how === 'sit').length,
    map.places.length, map.arrivalSlots.length, map.arrivalSlotsOverflow.length, map.exitLane.length], [88, 70, 18, 32, 20, 10, 14])
expectEq('loadMap points = JSON points (tile, how, sitFrom)',
  map.points.map(p => [p.x, p.y, p.how, p.sitFrom ? [p.sitFrom.x, p.sitFrom.y] : null]),
  POINTS.map(p => [p.tile[0], p.tile[1], p.how, p.sitFrom]))
const legendKinds = new Set<string>()
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) legendKinds.add(`${ROWS[y][x]}=${map.tiles[y][x]}`)
const unmapped = Object.keys(legend).filter(c => ![...legendKinds].some(e => e.startsWith(`${c}=`)))
expectEq('legend characters without a TileKind', unmapped, [])
const kindsUsed = new Set(map.tiles.flat())
expectEq('object tile kinds placed (plan §2: 58)', OBJECT_TILE_KINDS.filter(t => kindsUsed.has(t)).length, 58)
expectEq('structure kinds placed', Object.values(STRUCTURE_KIND_BY_CHAR).filter(t => kindsUsed.has(t)).length, 9)
expectEq('wall-mounted objects', map.objects.filter(o => o.wallMounted).map(o => o.id), ['kanban', 'inout-board', 'wallClock', 'noticeBoard'])
expectEq('zone of the mail-corner tile (21,16) / reception tile (20,16)', [map.zoneAt(21, 16)?.name, map.zoneAt(20, 16)?.name], ['MAIL / PRINT CORNER', 'RECEPTION'])

// the border is never walkable, whatever its character (officeMap.ts:212-213): open a corridor tile in the west wall
const borderRaw = JSON.parse(JSON.stringify(raw))
borderRaw.rows[11] = ':' + borderRaw.rows[11].slice(1)
const borderMap = loadMap(borderRaw), borderWalk = makeWalk(borderRaw.rows)
expectEq('border rule: (0,11) as corridor -> walkable? loadMap / port (false / false); (1,11) (true / true)',
  [borderMap.walkable(0, 11), borderWalk(0, 11), borderMap.walkable(1, 11), borderWalk(1, 11)], [false, false, true, true])

// loadMap must also reject a broken file (prove the validation can fail)
const broken = JSON.parse(JSON.stringify(raw))
broken.rows[5] = broken.rows[5].slice(0, 9) + '#' + broken.rows[5].slice(10)   // wall up an opening tile of library|records
let threw = ''
try { loadMap(broken) } catch (e) { threw = String(e) }
if (threw.includes("opening library|records: (9,5) is not a '+' tile")) console.log(`  ok   loadMap rejects a walled-up opening: ${threw.split('\n')[1]}`)
else fail(`loadMap accepted an opening tile turned to wall (${threw || 'no error'})`)

console.log(`mutations caught: ${caught} of 9 (place_s3.py 7 + infra_check.py 1 + validate_floorplan.py 1)`)
if (caught !== 9) fail(`only ${caught} of 9 mutations caught`)
if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS — the TS port reproduces the Python results on floorplan.json')
