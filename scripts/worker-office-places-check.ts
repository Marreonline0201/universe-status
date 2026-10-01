// Worker office places check (plan §6.3 tests). Run: node scripts/worker-office-places-check.ts
// (Node's built-in TypeScript support, as the other worker-office checks.)
//
// Checks src/worker-office/map/places.ts — the code the page and the observer will run — on floorplan.json:
//   A  counts and lists exactly as plan §3.1 / §3.2: 88 points = 70 stand + 18 seats, all facing N, one-to-one with
//      88 object tiles; the 18 seats with their sitFrom tiles and chairs; the 32 place tiles by pool, in order, with
//      their poses; 120 endpoints = 88 + 28 + 4; the chain pools; the arrival / departure hold orders; the station
//      capacities and chains = replay_fetch_read.py's CAP and CHAIN; every place has exactly one home;
//   B  C3 through the API: the three seats plain BFS enters from the side — (6,8) from (7,8), (26,2) from (25,2),
//      (3,17) from (4,17) — are refused by canStep; every seat is entered and left only through its own sitFrom;
//      a BFS over moves() reaches every place, each seat from its sitFrom, at exactly layout.distance();
//   C  the place-tile rules (place_s3.py's C2 sets) on the layout's own tiles and points, and the busy office;
//   D  reservation invariants under a seeded random sequence of assign / endPull / hold / reserve / transfer /
//      stepAside / release / dispose, against a ledger rebuilt ONLY from the change records: never two owners on a
//      tile, never two tiles for an owner, every change reported, free + held conserved per pool, FIFO service, a
//      FIFO line at the front desk, the step-aside invariant, refusals (a taken place, a disposed book), and
//      determinism (the same seed gives the same assignments, another seed does not);
//   E  scenarios with exact expected changes: fetch-then-read (pull, nearest reading place, fallback at the shelf),
//      the step-aside on a freed reading place and on a queue join, the library tiers, the front-desk line
//      (promotion, move-up, the 5th finisher keeping its reservation), the chains, FIFO, the holds, dispose,
//      crowding and the declaration-order tie-break;
//   F  the overflow chains terminate: flat, no link names its own kind or repeats, the pool is last, every expansion
//      is repetition-free.
// Every check is then shown able to FAIL: each planted mutant of places.ts (patched from its source text, each
// patch asserted to apply exactly once, loaded from a temp copy) or of the layout must fail its check.
// Exits 1 on any failure.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadMap, type OfficeMap, type Tile } from '../src/worker-office/map/loadMap.ts'
import * as real from '../src/worker-office/map/places.ts'
import type { Change, PlaceBook, PlaceLayout, Room, StationKind } from '../src/worker-office/map/places.ts'

type Mod = typeof real
const PLACES_PATH = fileURLToPath(new URL('../src/worker-office/map/places.ts', import.meta.url))
const LOADMAP_URL = new URL('../src/worker-office/map/loadMap.ts', import.meta.url).href
const RAW = JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8'))
const MAP = loadMap(RAW)

type XY = [number, number]
const xy = (t: Tile): XY => [t.x, t.y]
const k = (t: Tile) => `${t.x},${t.y}`
const fmt = (t: Tile) => `(${t.x},${t.y})`
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const
const sortObj = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

class Fails {
  readonly list: string[] = []
  ok(cond: boolean, msg: string) { if (!cond) this.list.push(msg) }
  eq(what: string, got: unknown, want: unknown) {
    const g = JSON.stringify(got) ?? 'undefined', w = JSON.stringify(want) ?? 'undefined'
    if (g !== w) this.list.push(`${what}: got ${g.length > 300 ? g.slice(0, 297) + '...' : g}, want ${w.length > 300 ? w.slice(0, 297) + '...' : w}`)
  }
}

// ── expected data: plan §3.1 / §3.2, replay_fetch_read.py, place_s3.py ─────────────────────────────────────────────
const POINTS_PER_KIND: Record<string, number> = {
  armchairN: 2, benchTerminal: 8, bookshelf: 6, cardCatalog: 2, copier: 1, espressoMachine: 1, fileCabinet: 20, fridge: 1,
  frontDesk: 2, historyShelf: 8, inOutBoard: 2, kanbanBoard: 3, lectern: 2, manualsShelf: 2, meetingTable: 3, pcDesk: 6,
  pigeonholes: 3, postShelf: 1, printer: 1, readingLedge: 2, readingTable: 4, serverRack: 2, shredder: 1, sink: 1, sofaN: 3,
  waterCooler: 1,
}
// [point id, seat, sitFrom, the object sat on]
const SEATS: [string, XY, XY, string][] = [
  ...[1, 2, 3, 4].map(i => [`reading-table.${i}`, [i + 2, 8], [i + 2, 9], `wood-chair-${i}`] as [string, XY, XY, string]),
  ...[1, 2, 3, 4, 5, 6].map(i => [`desk-${i}.1`, [i + 25, 2], [i + 25, 3], `task-chair-${i}`] as [string, XY, XY, string]),
  ...[1, 2, 3].map(i => [`meeting-table.${i}`, [i, 17], [i, 18], `wood-chair-${i + 4}`] as [string, XY, XY, string]),
  ...[1, 2, 3].map(i => [`sofa.${i}`, [i + 7, 18], [i + 7, 17], 'sofa'] as [string, XY, XY, string]),
  ['armchair-W.1', [7, 18], [7, 17], 'armchair-W'], ['armchair-E.1', [12, 18], [12, 17], 'armchair-E'],
]
const CHAIRS: [string, string][] = [
  ...[1, 2, 3, 4, 5, 6].map(i => [`task-chair-${i}`, `desk-${i}.1`] as [string, string]),
  ...[1, 2, 3, 4].map(i => [`wood-chair-${i}`, `reading-table.${i}`] as [string, string]),
  ...[1, 2, 3].map(i => [`wood-chair-${i + 4}`, `meeting-table.${i}`] as [string, string]),
]
// plan §3.2: [floorplan pool, tiles in declaration order, pose, facing]
const POOLS_3_2: [string, XY[], string, string][] = [
  ['records-west', [[10, 4], [10, 7], [10, 8], [11, 9]], 'readD', 'S'],
  ['records-east', [[23, 4], [23, 7], [23, 8], [22, 9]], 'readD', 'S'],
  ['work-desks', [[25, 2], [32, 2]], 'standD', 'S'],
  ['work-bench', [[32, 4], [32, 5], [32, 7], [32, 8]], 'standL', 'W'],
  ['library', [[1, 4], [1, 5], [1, 7], [1, 8]], 'readD', 'S'],
  ['meeting', [[5, 16], [5, 17]], 'standL', 'W'],
  ['mail-corner', [[23, 18], [24, 18], [25, 18], [26, 18]], 'standU', 'N'],
  ['servers', [[30, 17], [31, 17]], 'standU', 'N'],
  ['front-desk queue', [[16, 17], [16, 16]], 'standL', 'W'],
  ['hold', [[19, 17], [20, 17], [21, 17], [22, 17]], 'standD', 'S'],
]
const HOLD: XY[] = [[19, 17], [20, 17], [21, 17], [22, 17]]
const MAIL: XY[] = [[23, 18], [24, 18], [25, 18], [26, 18]]
// chain pools as tiers of tiles; '@frontq' is the only line
const CHAIN_POOLS: Record<string, XY[][]> = {
  '@records': [[[10, 4], [10, 7], [10, 8], [11, 9], [23, 4], [23, 7], [23, 8], [22, 9]]],
  '@library': [[[4, 2], [5, 2]], [[3, 8], [4, 8], [5, 8], [6, 8]], [[1, 4], [1, 5], [1, 7], [1, 8]]],
  '@desks': [[[25, 2], [32, 2]]], '@bench': [[[32, 4], [32, 5], [32, 7], [32, 8]]], '@meeting': [[[5, 16], [5, 17]]],
  '@mail': [MAIL], '@frontq': [[[16, 17], [16, 16]]], '@hold': [HOLD], '@kitchen': [[[7, 15], [8, 15], [9, 15], [10, 15]]],
  '@servers': [[[30, 17], [31, 17]]],
}
const ARRIVAL: XY[][] = [[[19, 14], [20, 14]], HOLD, MAIL]
const CAP: Record<string, number> = {     // replay_fetch_read.py CAP
  historyShelf: 8, lectern: 2, fileCabinet: 20, bookshelf: 6, cardCatalog: 2, manualsShelf: 2, pcDesk: 6, benchTerminal: 8,
  frontDesk: 2, printer: 1, copier: 1, shredder: 1, pigeonholes: 3, postShelf: 1, kanbanBoard: 3, meetingTable: 3, lounge: 5,
}
const CHAIN: Record<string, string[]> = { // replay_fetch_read.py CHAIN (= place_s3.py:467-473 for these kinds); shelves: none
  fileCabinet: ['@records'], lectern: ['historyShelf', '@records'], pcDesk: ['benchTerminal', '@desks'],
  benchTerminal: ['pcDesk', '@bench'], copier: ['printer', '@mail'], printer: ['copier', '@mail'], shredder: ['@mail'],
  pigeonholes: ['postShelf', '@mail'], postShelf: ['pigeonholes', '@mail'], frontDesk: ['@frontq'], kanbanBoard: ['@meeting'],
  meetingTable: ['kanbanBoard', '@meeting'], lounge: ['@kitchen'],
  historyShelf: [], bookshelf: [], cardCatalog: [], manualsShelf: [],
}
// own + siblings' own + pool = place_s3.py C4 chain_capacity (plan §3.4) for every non-shelf kind; shelves: own only
const CHAIN_CAP: Record<string, number> = {
  fileCabinet: 28, lectern: 18, pcDesk: 16, benchTerminal: 18, copier: 6, printer: 6, shredder: 5, pigeonholes: 8, postShelf: 8,
  frontDesk: 4, kanbanBoard: 5, meetingTable: 8, lounge: 9, historyShelf: 8, bookshelf: 6, cardCatalog: 2, manualsShelf: 2,
}

// ── A. counts and lists ────────────────────────────────────────────────────────────────────────────────────────────
function checkCounts(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const tilesOf = (ids: readonly string[]) => ids.map(id => xy(L.place(id)))
  F.eq('points / stand / seats', [L.points.length, L.points.filter(p => p.how === 'stand').length, L.points.filter(p => p.how === 'sit').length], [88, 70, 18])
  F.eq('points not facing N', L.points.filter(p => p.facing !== 'N').map(p => p.id), [])
  // one-to-one with object tiles, read from the map: a stand point and a desk / table seat serve the tile N of them, a
  // sofa / armchair seat serves its own tile; the 88 served tiles are distinct and each belongs to the point's object
  const served = (p: (typeof L.points)[number]): XY => (p.kind === 'sofaN' || p.kind === 'armchairN') ? [p.x, p.y] : [p.x, p.y - 1]
  F.eq('served object tile = the rule (N of it; the sofa / armchair seat itself)', L.points.filter(p => k(p.useTile) !== k({ x: served(p)[0], y: served(p)[1] })).map(p => p.id), [])
  F.eq('served tiles that are not the point\'s own object (map.objectAt)', L.points.filter(p => map.objectAt(p.useTile.x, p.useTile.y)?.id !== p.objectId).map(p => p.id), [])
  F.eq('distinct served object tiles', new Set(L.points.map(p => k(p.useTile))).size, 88)
  const perKind: Record<string, number> = {}
  for (const p of L.points) perKind[p.kind] = (perKind[p.kind] ?? 0) + 1
  F.eq('points per object kind (sum 88)', sortObj(perKind), sortObj(POINTS_PER_KIND))
  F.eq('seats: id, seat, sitFrom, object sat on', L.points.filter(p => p.how === 'sit').map(p => [p.id, xy(p), xy(p.sitFrom!), p.seatObjectId]).sort(), [...SEATS].sort())
  F.eq('stand points carry no sitFrom; approach = the point / the sitFrom',
    L.points.filter(p => (p.how === 'stand') !== (p.sitFrom === null) || k(p.approach) !== k(p.sitFrom ?? p)).map(p => p.id), [])
  F.eq('reserved points (rack points, plan §2 row 21)', L.points.filter(p => p.reserved).map(p => p.id), ['rack-1.1', 'rack-2.1'])
  F.eq('place tiles', L.tiles.length, 32)
  F.eq('floorplan pools in declaration order', [...new Set(L.tiles.map(t => t.pool))], POOLS_3_2.map(p => p[0]))
  for (const [pool, tiles, pose, facing] of POOLS_3_2) {
    const ts = L.tiles.filter(t => t.pool === pool)
    F.eq(`pool ${pool}: tiles in order`, ts.map(t => xy(t)), tiles)
    F.eq(`pool ${pool}: pose / facing (plan §3.2)`, [...new Set(ts.map(t => `${t.pose}/${t.facing}`))], [`${pose}/${facing}`])
  }
  F.eq('endpoints: total / points / wait + queue / hold (plan §3.3: 120 = 88 + 28 + 4)',
    [L.places.length, L.points.length, L.tiles.filter(t => t.pool !== 'hold').length, L.tiles.filter(t => t.pool === 'hold').length], [120, 88, 28, 4])
  F.eq('endpoints on distinct tiles', new Set(L.places.map(p => k(p))).size, 120)
  F.eq('place ids unique', new Set(L.places.map(p => p.id)).size, 120)
  for (const [name, tiers] of Object.entries(CHAIN_POOLS)) {
    const pool = L.pools.get(name)
    F.eq(`chain pool ${name}: tiers`, pool ? pool.tiers.map(tilesOf) : null, tiers)
    F.eq(`chain pool ${name}: a line?`, pool?.line, name === '@frontq')
  }
  F.eq('chain pools', [...L.pools.keys()].sort(), Object.keys(CHAIN_POOLS).sort())
  F.eq('arrival hold: board spots, hold tiles, mail corner (D10 = 10)', L.arrivalHold.map(tilesOf), ARRIVAL)
  F.eq('departure hold: the hold tiles', L.departureHold.map(tilesOf), [HOLD])
  F.eq('station capacities = replay_fetch_read.py CAP', sortObj(Object.fromEntries([...L.stations].map(([s, st]) => [s, st.points.length]))), sortObj(CAP))
  F.eq('lounge tiers: the sofa, then the armchairs', L.stations.get('lounge')?.tiers.map(tilesOf), [[[8, 18], [9, 18], [10, 18]], [[7, 18], [12, 18]]])
  F.eq('chains = replay_fetch_read.py CHAIN (shelves: none)', sortObj(Object.fromEntries([...L.stations].map(([s, st]) => [s, st.chain.map(l => (l.type === 'pool' ? l.pool : l.kind))]))), sortObj(CHAIN))
  F.eq('fetch-then-read shelves and their rooms', sortObj(Object.fromEntries([...L.stations].filter(([, st]) => st.shelfRoom).map(([s, st]) => [s, st.shelfRoom]))),
    { bookshelf: 'library', cardCatalog: 'library', historyShelf: 'records', manualsShelf: 'library' })
  F.eq('chain capacity = place_s3.py C4 chain_capacity (non-shelf); own points (shelves)',
    sortObj(Object.fromEntries([...L.stations].map(([s]) => [s, L.expandChain(s).reduce((n, l) => n + l.places.length, 0)]))), sortObj(CHAIN_CAP))
  // every place has exactly one home: a station's own points, one pool, the in/out-board tier of the arrival hold, or reserved
  const homes = new Map<string, string[]>()
  const add = (id: string, h: string) => homes.set(id, [...(homes.get(id) ?? []), h])
  for (const st of L.stations.values()) for (const id of st.points) add(id, `station ${st.kind}`)
  for (const p of L.pools.values()) for (const id of p.members) add(id, `pool ${p.name}`)
  for (const id of L.arrivalHold[0]) add(id, 'arrival hold (board)')
  for (const p of L.points) if (p.reserved) add(p.id, 'reserved')
  F.eq('places with no home', L.places.filter(p => !homes.has(p.id)).map(p => p.id), [])
  F.eq('places with two homes', [...homes].filter(([, h]) => h.length > 1).map(([id, h]) => `${id}: ${h.join(' + ')}`), [])
  F.eq('instances = floorplan objects, in order', L.instances.map(i => i.id), RAW.objects.map((o: { id: string }) => o.id))
  F.eq('chairs and the point that sits on each', L.instances.filter(i => i.seatOfPoint !== null).map(i => [i.id, i.seatOfPoint]), CHAIRS)
  F.eq('every instance lists its points', L.instances.reduce((n, i) => n + i.points.length, 0), 88)
  return F.list
}

// ── B. C3 through the API: a seat only from its sitFrom ────────────────────────────────────────────────────────────
/** place_s3.py find_path (the step-1 port): BFS in DIRS order over walkable tiles, a solid destination allowed. */
function plainPath(map: OfficeMap, frm: Tile, to: Tile): Tile[] {
  const prev = new Map<string, Tile | null>([[k(frm), null]])
  const q: Tile[] = [frm]
  for (let head = 0; head < q.length; head++) {
    const c = q[head]
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy }
      if (!map.inBounds(n.x, n.y) || prev.has(k(n))) continue
      const dest = n.x === to.x && n.y === to.y
      if (!map.walkable(n.x, n.y) && !dest) continue
      prev.set(k(n), c)
      if (dest) {
        const out: Tile[] = []
        for (let p: Tile | null = n; p && !(p.x === frm.x && p.y === frm.y); p = prev.get(k(p)) ?? null) out.push(p)
        return out.reverse()
      }
      q.push(n)
    }
  }
  return []
}

function checkSeats(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf
  const seats = L.points.filter(p => p.how === 'sit')
  // the plain BFS of step 1 steps onto exactly these three seats from the side ...
  const side = seats.map(s => { const p = plainPath(map, IN, s); return { s, via: p.length >= 2 ? p[p.length - 2] : IN } })
    .filter(({ s, via }) => k(via) !== k(s.sitFrom!)).map(({ s, via }) => [xy(s), xy(via)])
  F.eq('plain BFS side entries (place_s3.py C3: (6,8) from (7,8), (26,2) from (25,2), (3,17) from (4,17))', side,
    [[[6, 8], [7, 8]], [[26, 2], [25, 2]], [[3, 17], [4, 17]]])
  // ... and the shipped rule refuses each of those steps, both ways
  for (const [seat, via] of [[[6, 8], [7, 8]], [[26, 2], [25, 2]], [[3, 17], [4, 17]]] as [XY, XY][]) {
    const s = { x: seat[0], y: seat[1] }, v = { x: via[0], y: via[1] }
    F.ok(!L.canStep(v, s), `canStep allows the side entry ${fmt(v)} -> seat ${fmt(s)}`)
    F.ok(!L.canStep(s, v), `canStep allows leaving seat ${fmt(s)} sideways to ${fmt(v)}`)
  }
  for (const s of seats) {
    F.ok(L.canStep(s.sitFrom!, s), `seat ${s.id}: not enterable from its sitFrom ${fmt(s.sitFrom!)}`)
    F.ok(L.canStep(s, s.sitFrom!), `seat ${s.id}: cannot step back to its sitFrom`)
    for (const [dx, dy] of DIRS) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (k(n) === k(s.sitFrom!)) continue
      F.ok(!L.canStep(n, s) && !L.canStep(s, n), `seat ${s.id}: a step to / from ${fmt(n)} is allowed`)
    }
    F.ok(L.seatAt(s.x, s.y)?.id === s.id, `seatAt ${fmt(s)}`)
  }
  F.ok(!L.canStep({ x: 17, y: 19 }, { x: 18, y: 18 }) && !L.canStep({ x: 17, y: 19 }, { x: 17, y: 17 }), 'canStep allows a diagonal or a 2-tile move')
  F.ok(L.canStep({ x: 17, y: 13 }, { x: 18, y: 13 }), 'canStep refuses a plain move along an opening')
  F.ok(!L.canStep({ x: 14, y: 17 }, { x: 14, y: 16 }), 'canStep allows walking into the front desk')
  // a BFS over moves() alone reaches every place, enters each seat from its sitFrom, at layout.distance()
  const dist = new Map<string, number>([[k(IN), 0]]), prev = new Map<string, string>()
  const q: Tile[] = [IN]
  for (let head = 0; head < q.length; head++) {
    const c = q[head]
    for (const n of L.moves(c)) {
      if (dist.has(k(n))) continue
      dist.set(k(n), dist.get(k(c))! + 1); prev.set(k(n), k(c)); q.push(n)
    }
  }
  F.eq('places unreached by moves() from the IN leaf', L.places.filter(p => !dist.has(k(p))).map(p => p.id), [])
  F.eq('seats whose BFS predecessor is not their sitFrom', seats.filter(s => prev.get(k(s)) !== k(s.sitFrom!)).map(s => s.id), [])
  F.eq('places where layout.distance(IN leaf) != the moves() BFS', L.places.filter(p => L.distance(IN, p.id) !== dist.get(k(p))).map(p => `${p.id} ${L.distance(IN, p.id)} vs ${dist.get(k(p))}`), [])
  const walkable = (() => { let n = 0; for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (map.walkable(x, y)) n++; return n })()
  F.eq('tiles reached by moves() = 458 walkable + 18 seats', dist.size, walkable + 18)
  // a seat as origin: one scripted step back to its sitFrom first
  const d1 = seats[0]
  F.eq(`distance from seat ${d1.id} = 1 + distance from its sitFrom`, L.distance(d1, 'cab-01.1'), 1 + L.distance(d1.sitFrom!, 'cab-01.1'))
  return F.list
}

// ── C. the place-tile rules (place_s3.py check_placement's C2 sets + busy office), on the layout's own data ─────────
function checkPlaceRules(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf, OUT = map.door.outLeaf
  const corridor = map.zones.find(z => z.name === 'CORRIDOR')!
  const recCorr = map.openings.find(o => o.name === 'reception|corridor')!
  const arrivalTarget = recCorr.tiles.find(t => t.x === IN.x)!
  const deskSpots = L.points.filter(p => p.kind === 'frontDesk')
  const sets: [string, Set<string>][] = [
    ['opening', new Set(map.openings.flatMap(o => o.tiles.map(k)))],
    ['opening apron', new Set(map.openings.flatMap(o => o.tiles.flatMap(t => (o.wall === 'horizontal' ? [{ x: t.x, y: t.y - 1 }, { x: t.x, y: t.y + 1 }] : [{ x: t.x - 1, y: t.y }, { x: t.x + 1, y: t.y }]).map(k))))],
    ['door/doormat/inside apron', new Set([IN, OUT, { x: OUT.x, y: OUT.y - 1 }, { x: IN.x, y: IN.y - 1 }, ...map.door.doormat].map(k))],
    ['corridor', new Set(Array.from({ length: corridor.w * corridor.h }, (_, i) => k({ x: corridor.x + (i % corridor.w), y: corridor.y + Math.floor(i / corridor.w) })))],
    ['arrival lane', new Set([IN, ...plainPath(map, IN, arrivalTarget)].map(k))],
    ['arrival slot', new Set(map.arrivalSlots.map(k))],
    ['exit lane', new Set(map.exitLane.map(k))],
    ['departure lane', new Set(deskSpots.flatMap(d => plainPath(map, d, OUT).map(k)))],
  ]
  const line = new Set(L.pools.get('@frontq')!.members.map(id => k(L.place(id))))
  const tiles = L.tiles, stand = L.points.filter(p => p.how === 'stand'), sitFrom = L.points.filter(p => p.sitFrom).map(p => p.sitFrom!)
  for (const [what, cells] of sets) {
    for (const t of tiles) if (cells.has(k(t)) && !line.has(k(t))) F.list.push(`place tile ${t.id} on ${what} ${fmt(t)}`)
    for (const p of L.points) if (cells.has(k(p)) && what !== 'departure lane') F.list.push(`point ${p.id} on ${what} ${fmt(p)}`)
    for (const s of sitFrom) if (cells.has(k(s))) F.list.push(`sit-down tile ${fmt(s)} on ${what}`)
  }
  const pointTiles = new Set(L.points.map(k)), sitTiles = new Set(sitFrom.map(k)), tileSet = new Set(tiles.map(k))
  F.eq('place tiles on a point or a sit-down tile', tiles.filter(t => pointTiles.has(k(t)) || sitTiles.has(k(t))).map(t => t.id), [])
  F.eq('place tiles that are not walkable floor', tiles.filter(t => !map.walkable(t.x, t.y)).map(t => t.id), [])
  // busy office: every stand point and every place tile occupied
  const busy = new Set([...stand.map(k), ...tiles.map(k)])
  const seen = new Set([k(map.door.doormat[0])]), st: Tile[] = [map.door.doormat[0]]
  while (st.length) {
    const c = st.pop()!
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy }
      if (!seen.has(k(n)) && map.walkable(n.x, n.y) && !busy.has(k(n))) { seen.add(k(n)); st.push(n) }
    }
  }
  const near = (t: Tile) => DIRS.some(([dx, dy]) => seen.has(k({ x: t.x + dx, y: t.y + dy })))
  F.eq('busy office: boxed in (no free neighbour)', [...stand, ...tiles, ...sitFrom].filter(t => !seen.has(k(t)) && !near(t)).map(fmt), [])
  F.eq('busy office: openings cut off', map.openings.filter(o => !o.tiles.every(t => seen.has(k(t)))).map(o => o.name), [])
  F.eq('busy office: door leaves cut off', [IN, OUT].filter(t => !seen.has(k(t))).map(fmt), [])
  F.eq('busy office: tiles still reachable (place_s3.py 355)', seen.size, 355)
  const standSet = new Set(stand.map(k))
  F.eq('a place tile is a stand point\'s only exit', stand.filter(p => {
    const ex = DIRS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).filter(q => map.walkable(q.x, q.y) && !standSet.has(k(q)))
    return ex.length > 0 && ex.every(q => tileSet.has(k(q)))
  }).map(p => p.id), [])
  return F.list
}

// ── D. reservation invariants under a seeded random sequence ───────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface RunOut { fails: string[]; log: string[]; stats: Record<string, number> }

// op mix per profile: cumulative thresholds for assign / endPull / release / hold / reserve / transfer / stepAside, the
// rest is dispose. 'mixed' covers every station; 'records' crowds the records room so that the reading places fill up,
// pullers fall back to reading at the shelf, queue behind them and get stepped aside to.
const PROFILES = {
  mixed: { cut: [0.36, 0.50, 0.70, 0.78, 0.86, 0.94, 0.997], kinds: null as StationKind[] | null },
  records: { cut: [0.42, 0.70, 0.82, 0.85, 0.89, 0.93, 0.998], kinds: ['historyShelf', 'historyShelf', 'historyShelf', 'historyShelf', 'historyShelf', 'historyShelf', 'lectern', 'lectern', 'fileCabinet', 'bookshelf', 'cardCatalog'] as StationKind[] },
}
type Profile = keyof typeof PROFILES

function randomRun(M: Mod, map: OfficeMap, seed: number, nOps: number, profile: Profile): RunOut {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  let book: PlaceBook = new M.PlaceBook(L)
  const rnd = mulberry32(seed)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const owners = Array.from({ length: 40 }, (_, i) => `w${i}`)
  const SMALL: StationKind[] = ['printer', 'copier', 'shredder', 'postShelf', 'pigeonholes', 'frontDesk', 'lectern', 'cardCatalog',
    'manualsShelf', 'historyShelf', 'lounge', 'meetingTable', 'kanbanBoard']
  const STATIONS = [...M.STATION_KINDS]
  const { cut, kinds } = PROFILES[profile]
  const ROOMS: Room[] = ['records', 'library']
  const origins: Tile[] = [map.door.inLeaf, ...L.tiles]
  const log: string[] = []
  const stats: Record<string, number> = {}
  const tally = (s: string) => { stats[s] = (stats[s] ?? 0) + 1 }
  let shadow = new Map<string, string>()    // place -> owner, rebuilt from change records only
  let shadowOwner = new Map<string, string>() // owner -> place
  const fromOf = (o: string): Tile => { const h = book.holding(o); return h ? L.place(h.place) : pick(origins) }
  const refused = (f: () => unknown) => { try { f(); return false } catch { return true } }
  for (let n = 0; n < nOps; n++) {
    const before = new Map(book.waiters().map(w => [w.owner, w]))
    let changes: readonly Change[] = []
    let entry = ''
    const r = rnd()
    try {
      if (r < cut[0]) {
        const o = pick(owners), kind = kinds ? pick(kinds) : rnd() < 0.6 ? pick(SMALL) : pick(STATIONS), fetch = rnd() < 0.9
        const res = book.assign(o, kind, fromOf(o), { fetch })
        changes = res.changes; entry = `assign ${o} ${kind} ${fetch} -> ${res.how} ${res.place} ${res.via}`; tally(`assign:${res.how}`)
      } else if (r < cut[1]) {
        const pulling = book.holdings().filter(h => h.role === 'pull')
        const o = pulling.length > 0 && rnd() < 0.9 ? pick(pulling).owner : pick(owners)
        changes = book.endPull(o); entry = `endPull ${o}`
      } else if (r < cut[2]) {
        const o = pick(owners); changes = book.release(o); entry = `release ${o}`
      } else if (r < cut[3]) {
        const o = pick(owners), which = rnd() < 0.6 ? 'arrival' : 'departure'
        const res = book.hold(o, which, fromOf(o)); changes = res.changes; entry = `hold ${o} ${which} -> ${res.place}`; tally(`hold:${res.place ? 'place' : 'none'}`)
      } else if (r < cut[4]) {
        const o = pick(owners), p = pick(L.places).id
        const holds = book.holding(o) !== null, other = book.ownerOf(p)
        const expectRefusal = holds || other !== null
        entry = `reserve ${o} ${p}`
        try { changes = book.reserve(o, p); F.ok(!expectRefusal, `op ${n}: reserve(${o}, ${p}) not refused (${holds ? 'the owner holds a place' : `${other} holds it`})`) } catch (e) {
          F.ok(expectRefusal, `op ${n}: reserve(${o}, ${p}) refused without cause: ${e}`); tally('reserve:refused')
        }
      } else if (r < cut[5]) {
        const o = pick(owners), p = pick(L.places).id
        const holds = book.holding(o) !== null, other = book.ownerOf(p)
        const expectRefusal = !holds || (other !== null && other !== o)
        entry = `transfer ${o} ${p}`
        try { changes = book.transfer(o, p); F.ok(!expectRefusal, `op ${n}: transfer(${o}, ${p}) not refused (${!holds ? 'the owner holds nothing' : `${other} holds it`})`) } catch (e) {
          F.ok(expectRefusal, `op ${n}: transfer(${o}, ${p}) refused without cause: ${e}`); tally('transfer:refused')
        }
      } else if (r < cut[6]) {
        const room = pick(ROOMS); changes = book.stepAside(room); entry = `stepAside ${room}`
      } else {
        const held = book.holdings().length
        changes = book.dispose(); entry = `dispose (${held} held)`; tally('dispose')
        F.eq(`op ${n}: dispose released every holding`, [changes.length, book.holdings().length, book.waiters().length, book.fallbackReaders().length], [held, 0, 0, 0])
        const o = pick(owners), p = pick(L.places).id
        F.ok(refused(() => book.assign(o, 'fileCabinet', map.door.inLeaf)), `op ${n}: assign after dispose not refused`)
        F.ok(refused(() => book.reserve(o, p)), `op ${n}: reserve after dispose not refused`)
        F.ok(refused(() => book.hold(o, 'arrival', map.door.inLeaf)), `op ${n}: hold after dispose not refused`)
        F.ok(refused(() => book.endPull(o)), `op ${n}: endPull after dispose not refused`)
        F.ok(refused(() => book.stepAside('records')), `op ${n}: stepAside after dispose not refused`)
        F.ok(refused(() => book.transfer(o, p)), `op ${n}: transfer after dispose not refused`)
        F.eq(`op ${n}: release after dispose`, book.release(o), [])
        F.eq(`op ${n}: nothing booked after the refused calls`, book.holdings().length, 0)
      }
    } catch (e) { F.list.push(`op ${n} (${entry}): threw ${e}`) }
    // 1. the ledger rebuilt from the change records
    for (const c of changes) {
      tally(`change:${c.cause}`)
      if (c.from !== null) {
        if (shadow.get(c.from) !== c.owner) F.list.push(`op ${n} change ${c.seq}: frees ${c.from}, which ${c.owner} did not hold`)
        else { shadow.delete(c.from); shadowOwner.delete(c.owner) }
      }
      if (c.to !== null) {
        const other = shadow.get(c.to)
        if (other !== undefined && other !== c.owner) F.list.push(`op ${n} change ${c.seq}: DOUBLE BOOKING ${c.to} given to ${c.owner} while ${other} holds it`)
        const mine = shadowOwner.get(c.owner)
        if (mine !== undefined && mine !== c.to) F.list.push(`op ${n} change ${c.seq}: ${c.owner} holds ${mine} and ${c.to}`)
        shadow.set(c.to, c.owner); shadowOwner.set(c.owner, c.to)
      }
    }
    const holdings = book.holdings()
    if (holdings.length !== shadow.size || holdings.some(h => shadow.get(h.place) !== h.owner)) {
      F.list.push(`op ${n} (${entry}): the change records do not rebuild the book (${holdings.length} held, ledger ${shadow.size})`)
      shadow = new Map(holdings.map(h => [h.place, h.owner])); shadowOwner = new Map(holdings.map(h => [h.owner, h.place]))
    }
    // 2. the book itself: one owner per place, one place per owner, conservation per pool and overall
    F.ok(new Set(holdings.map(h => h.place)).size === holdings.length && new Set(holdings.map(h => h.owner)).size === holdings.length,
      `op ${n}: a place with two owners or an owner with two places`)
    for (const h of holdings) F.ok(book.ownerOf(h.place) === h.owner, `op ${n}: ownerOf(${h.place}) is ${book.ownerOf(h.place)}, the holding says ${h.owner}`)
    const free = L.places.filter(p => book.isFree(p.id)).length
    F.ok(free + book.heldCount(L.places.map(p => p.id)) === L.places.length && book.heldCount(L.places.map(p => p.id)) === holdings.length,
      `op ${n}: free ${free} + held ${holdings.length} != ${L.places.length}`)
    for (const pool of L.pools.values()) {
      const f = pool.members.filter(id => book.isFree(id)).length
      F.ok(f + book.heldCount(pool.members) === pool.members.length, `op ${n}: pool ${pool.name} not conserved`)
    }
    // 3. FIFO: the wait list in join order; a served waiter never overtakes an earlier one it competed with
    const after = book.waiters()
    F.ok(after.every((w, i) => i === 0 || after[i - 1].seq < w.seq), `op ${n}: the wait list is not in join order`)
    for (const c of changes) {
      if (c.cause !== 'served' || c.to === null) continue
      // its join seq for this kind; an owner that joined in this very op is the newest (Infinity)
      const w0 = before.get(c.owner)
      const seq = w0 !== undefined && w0.kind === c.forKind ? w0.seq : Infinity
      if (c.role === 'use' || c.role === 'pull') {
        const skipped = after.filter(w => w.kind === c.forKind && w.seq < seq)
        F.ok(skipped.length === 0, `op ${n}: FIFO: ${c.owner} served ${c.to} ahead of ${skipped.map(w => w.owner).join(', ')}`)
      } else if (c.role === 'wait') {
        const pool = L.poolOf(c.to)!
        const skipped = after.filter(w => w.seq < seq && M.CHAINS[w.kind].includes(pool.name) && L.poolOf(book.holding(w.owner)?.place ?? '') !== pool)
        F.ok(skipped.length === 0, `op ${n}: FIFO: ${c.owner} took ${c.to} ahead of ${skipped.map(w => w.owner).join(', ')}`)
      }
    }
    // the front-desk line (its 'wait' holders; a raw reserve() there is not in the line): no gap at the front, join order
    const lineIds = L.pools.get('@frontq')!.members
    const inLine = lineIds.map(id => { const o = book.ownerOf(id); const h = o === null ? null : book.holding(o); return h !== null && h.role === 'wait' ? book.waiterOf(h.owner) : null })
    F.ok(!(book.isFree(lineIds[0]) && inLine[1] !== null), `op ${n}: the front-desk line has a gap at its front`)
    if (inLine[0] && inLine[1]) F.ok(inLine[0].seq < inLine[1].seq, `op ${n}: the front-desk line is out of join order`)
    // 4. roles and lists agree
    for (const h of holdings) {
      if (h.role === 'wait') F.ok(book.waiterOf(h.owner) !== null, `op ${n}: ${h.owner} waits on ${h.place} but is on no wait list`)
      if (h.role === 'readAtShelf') F.ok(book.fallbackReaders().includes(h.owner), `op ${n}: ${h.owner} reads at a shelf but is no fallback reader`)
    }
    for (const o of book.fallbackReaders()) F.ok(book.holding(o)?.role === 'readAtShelf', `op ${n}: fallback reader ${o} does not read at a shelf`)
    // 5. the step-aside invariant: never a free reading place while a puller waits behind a fallback reader of its shelf
    for (const room of ROOMS) {
      const anyFree = L.pools.get(M.READING_POOL[room])!.members.some(id => book.isFree(id))
      const stuck = after.filter(w => M.SHELF_ROOM[w.kind] === room && book.fallbackReaders(w.kind).length > 0)
      F.ok(!(anyFree && stuck.length > 0), `op ${n}: a ${room} reading place is free while ${stuck.map(w => w.owner).join(', ')} wait behind a fallback reader`)
    }
    if (book.disposed) { book = new M.PlaceBook(L); shadow = new Map(); shadowOwner = new Map() }
    log.push(`${entry} ${JSON.stringify(changes)}`)
    if (F.list.length > 20) break
  }
  return { fails: F.list, log, stats }
}

const SEED = 20261001
const N_OPS = 4000
function checkInvariants(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const seen: Record<string, number> = {}
  for (const profile of ['mixed', 'records'] as const) {
    const a = randomRun(M, map, SEED, N_OPS, profile)
    const b = randomRun(M, map, SEED, N_OPS, profile)
    const c = randomRun(M, map, SEED + 1, N_OPS, profile)
    F.list.push(...a.fails.map(f => `${profile} seed ${SEED}: ${f}`), ...c.fails.map(f => `${profile} seed ${SEED + 1}: ${f}`))
    const same = a.log.length === b.log.length && a.log.every((l, i) => l === b.log[i])
    F.ok(same, `${profile}: determinism: the same seed gave different assignments (first difference at op ${a.log.findIndex((l, i) => l !== b.log[i])})`)
    F.ok(JSON.stringify(a.log) !== JSON.stringify(c.log), `${profile}: determinism probe: two different seeds gave the same run`)
    for (const [s, v] of Object.entries(a.stats)) seen[s] = (seen[s] ?? 0) + v
    lastRunStats[profile] = a.stats
  }
  // the runs must actually exercise what they claim to check
  for (const need of ['assign:own', 'assign:sibling', 'assign:pool', 'assign:queued', 'change:served', 'change:moveUp', 'change:stepAside',
    'change:pullDone', 'dispose', 'reserve:refused', 'transfer:refused', 'hold:place', 'hold:none']) {
    F.ok((seen[need] ?? 0) > 0, `the random runs never exercised ${need}`)
  }
  return F.list
}
const lastRunStats: Record<string, Record<string, number>> = {}

// ── E. scenarios with exact expected changes ──────────────────────────────────────────────────────────────────────
const at = (L: PlaceLayout, x: number, y: number) => L.placeAt(x, y)!.id
const brief = (cs: readonly Change[]) => cs.map(c => `${c.owner} ${c.from ?? '-'}>${c.to ?? '-'} ${c.role ?? '-'} ${c.cause}`)

/** Independent nearest: own BFS over moves(), + crowding, ties by declaration order. */
function nearest(L: PlaceLayout, from: Tile, ids: readonly string[], held: ReadonlySet<string>, crowd = 0) {
  const dist = new Map<string, number>([[k(from), 0]]), q: Tile[] = [from]
  for (let head = 0; head < q.length; head++) for (const n of L.moves(q[head])) if (!dist.has(k(n))) { dist.set(k(n), dist.get(k(q[head]))! + 1); q.push(n) }
  let best: string | null = null, cost = Infinity
  for (const id of ids) {
    if (held.has(id)) continue
    const p = L.place(id)
    const c = (dist.get(k(p)) ?? Infinity) + crowd * (L.crowdNeighbours.get(id) ?? []).filter(nb => held.has(nb)).length
    if (c < cost) { best = id; cost = c }
  }
  return best
}

function checkFetchRead(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf
  const records = L.pools.get('@records')!.members
  const shelves = L.stations.get('historyShelf')!.points
  // E1 pull at the nearest shelf point, then the nearest free records reading place
  {
    const b = new M.PlaceBook(L)
    const from = { x: 17, y: 9 }
    const r = b.assign('A', 'historyShelf', from)
    F.eq('E1 pull: how / role / place = independent nearest', [r.how, b.holding('A')?.role, r.place], ['own', 'pull', nearest(L, from, shelves, new Set())])
    F.eq('E1 the nearest shelf point from (17,9)', r.place, 'hist-5.1')
    const c = b.endPull('A')
    const h = b.holding('A')!
    F.eq('E1 endPull: role / reading place = independent nearest / pulledFrom / shelf freed',
      [h.role, h.place, h.pulledFrom, b.isFree('hist-5.1')], ['read', nearest(L, L.place('hist-5.1'), records, new Set()), 'hist-5.1', true])
    F.eq('E1 the nearest records reading place from hist-5.1 (18,8): (23,8), 5 steps along the use spots, tied with (22,9) and first in declaration order',
      [xy(L.place(h.place)), L.distance(L.place('hist-5.1'), at(L, 23, 8)), L.distance(L.place('hist-5.1'), at(L, 22, 9))], [[23, 8], 5, 5])
    F.eq('E1 changes', brief(c), [`A hist-5.1>${h.place} read pullDone`])
    F.eq('E1 a glance (fetch: false) holds the shelf as a plain use; endPull is a no-op', (() => {
      const g = b.assign('G', 'historyShelf', from, { fetch: false })
      return [g.how, b.holding('G')?.role, b.endPull('G').length]
    })(), ['own', 'use', 0])
  }
  // E2..E4 the records pool full: fallback readers, then the step-aside (on a freed place; on a queue join)
  const setup = () => {
    const b = new M.PlaceBook(L)
    records.forEach((id, i) => b.reserve(`R${i + 1}`, id))
    const shelfOf: string[] = []
    for (let i = 1; i <= 8; i++) { const r = b.assign(`S${i}`, 'historyShelf', IN); shelfOf.push(r.place!) }
    const ends = [1, 2, 3, 4, 5, 6, 7, 8].map(i => brief(b.endPull(`S${i}`)))
    return { b, shelfOf, ends }
  }
  {
    const { b, shelfOf, ends } = setup()
    F.eq('E2 eight shelves taken, each a distinct point', new Set(shelfOf).size, 8)
    F.eq('E2 no reading place free: each puller reads at its shelf', ends, shelfOf.map((s, i) => [`S${i + 1} ${s}>${s} readAtShelf pullDone`]))
    F.eq('E2 fallback readers in order', b.fallbackReaders('historyShelf'), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
    const p = b.assign('P', 'historyShelf', IN)
    F.eq('E3 a ninth puller queues (no chain for a shelf); nothing moves', [p.how, p.place, p.changes.length, b.waiters('historyShelf').map(w => w.owner)], ['queued', null, 0, ['P']])
    const rel = b.release('R3')
    F.eq('E3 a reading place frees: the EARLIEST fallback reader steps aside to it, the puller takes its shelf point',
      brief(rel), [`R3 ${records[2]}>- - release`, `S1 ${shelfOf[0]}>${records[2]} read stepAside`, `P ->${shelfOf[0]} pull served`])
    F.eq('E3 after: the reader keeps its item (pulledFrom), the queue is empty, S2..S8 still at their shelves',
      [b.holding('S1')?.pulledFrom, b.waiters().length, b.fallbackReaders('historyShelf')], [shelfOf[0], 0, ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']])
  }
  {
    const { b, shelfOf } = setup()
    const rel = b.release('R5')
    F.eq('E4 a reading place frees while nobody waits: no reader moves (event-driven only)', [brief(rel), b.fallbackReaders('historyShelf').length, b.isFree(records[4])],
      [[`R5 ${records[4]}>- - release`], 8, true])
    const p = b.assign('P', 'historyShelf', IN)
    F.eq('E4 a puller joins the queue while a reading place is free: the step-aside happens at once',
      [p.how, brief(p.changes), b.waiters().length], ['queued', [`S1 ${shelfOf[0]}>${records[4]} read stepAside`, `P ->${shelfOf[0]} pull served`], 0])
  }
  // E5 library: the reading ledge, then the table seats, then the aisle tiles; then at the shelf
  {
    const b = new M.PlaceBook(L)
    // classified by the plan's tiles (§4.4 / §3.2), not by the layout's own tiers
    const named = ['ledge', 'table', 'aisle'] as const
    const tierOf = (id: string) => named[CHAIN_POOLS['@library'].findIndex(t => t.some(([x, y]) => k(L.place(id)) === `${x},${y}`))] ?? 'other'
    const got: string[] = []
    for (let i = 1; i <= 11; i++) {
      const kind: StationKind = i === 5 ? 'manualsShelf' : i === 8 ? 'cardCatalog' : 'bookshelf'
      b.assign(`B${i}`, kind, IN)
      b.endPull(`B${i}`)
      const h = b.holding(`B${i}`)!
      got.push(h.role === 'readAtShelf' ? 'shelf' : tierOf(h.place))
    }
    F.eq('E5 library reading places by tier (book, book, book, book, manuals, book, book, catalog, book, book, book)', got,
      ['ledge', 'ledge', 'table', 'table', 'table', 'table', 'aisle', 'aisle', 'aisle', 'aisle', 'shelf'])
  }
  return F.list
}

function checkQueues(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf
  // E6 the front-desk line: two at the desk, two in the line, the fifth waits at its own station keeping its booking
  {
    const b = new M.PlaceBook(L)
    const d1 = b.assign('D1', 'frontDesk', IN), d2 = b.assign('D2', 'frontDesk', IN)
    const q1 = b.assign('Q1', 'frontDesk', IN), q2 = b.assign('Q2', 'frontDesk', IN)
    const cab = b.assign('V', 'fileCabinet', IN).place!
    const v = b.assign('V', 'frontDesk', IN)
    F.eq('E6 desk, desk, line front (16,17), line back (16,16), then queued',
      [d1.how, d2.how, [q1.how, q1.via, q1.place], [q2.how, q2.via, q2.place], [v.how, v.place, v.changes.length]],
      ['own', 'own', ['pool', '@frontq', at(L, 16, 17)], ['pool', '@frontq', at(L, 16, 16)], ['queued', null, 0]])
    F.eq('E6 the fifth keeps its own booking while it waits', [b.holding('V')?.place, b.holding('V')?.role, b.waiters('frontDesk').map(w => w.owner)], [cab, 'use', ['Q1', 'Q2', 'V']])
    const rel = b.release('D1')
    F.eq('E6 a desk spot frees: the line front is promoted, the line moves up, the fifth steps into the line',
      brief(rel), [`D1 ${d1.place}>- - release`, `Q1 ${at(L, 16, 17)}>${d1.place} use served`, `Q2 ${at(L, 16, 16)}>${at(L, 16, 17)} wait moveUp`, `V ${cab}>${at(L, 16, 16)} wait served`])
    F.eq('E6 after: wait list', b.waiters('frontDesk').map(w => w.owner), ['Q2', 'V'])
    const rel2 = b.release('D2')
    F.eq('E6 the next desk spot: FIFO again', brief(rel2), [`D2 ${d2.place}>- - release`, `Q2 ${at(L, 16, 17)}>${d2.place} use served`, `V ${at(L, 16, 16)}>${at(L, 16, 17)} wait moveUp`])
  }
  // E7 chains: own, sibling, pool, queue; a sibling on a shelf point is not a pull
  {
    const b = new M.PlaceBook(L)
    const how = (o: string, kind: StationKind) => { const r = b.assign(o, kind, IN); return `${r.how}${r.via ? ':' + r.via : ''}` }
    const desks = Array.from({ length: 17 }, (_, i) => how(`P${i + 1}`, 'pcDesk'))
    F.eq('E7 pcDesk: 6 own, 8 benches, 2 on @desks, then queued',
      desks, [...Array(6).fill('own'), ...Array(8).fill('sibling:benchTerminal'), 'pool:@desks', 'pool:@desks', 'queued'])
    const lect = Array.from({ length: 19 }, (_, i) => how(`L${i + 1}`, 'lectern'))
    F.eq('E7 lectern: 2 own, 8 history shelves, 8 on @records, then queued',
      lect, [...Array(2).fill('own'), ...Array(8).fill('sibling:historyShelf'), ...Array(8).fill('pool:@records'), 'queued'])
    F.eq('E7 a lectern worker on a history shelf holds it as a sibling (no pull; endPull no-op)', [b.holding('L3')?.role, b.endPull('L3').length], ['sibling', 0])
    const l1 = b.holding('L1')!.place, l11 = b.holding('L11')!.place
    F.eq('E7 a lectern frees: the earliest waiter (on @records) is promoted, the queued one takes its tile',
      brief(b.release('L1')), [`L1 ${l1}>- - release`, `L11 ${l11}>${l1} use served`, `L19 ->${l11} wait served`])
    const l3 = b.holding('L3')!.place
    F.eq('E7 a sibling point frees: offered to its own kind\'s waiters only (none here)', brief(b.release('L3')), [`L3 ${l3}>- - release`])
  }
  // E9 FIFO through a shared pool: printer (1) + copier (1) + @mail (4), then three queued
  {
    const b = new M.PlaceBook(L)
    const res = Array.from({ length: 9 }, (_, i) => b.assign(`A${i + 1}`, 'printer', IN))
    F.eq('E9 printer: own, sibling copier, 4 on @mail, 3 queued', res.map(r => r.how), ['own', 'sibling', 'pool', 'pool', 'pool', 'pool', 'queued', 'queued', 'queued'])
    const mail3 = res[2].place!
    F.eq('E9 the printer frees: A3 (first on @mail) is promoted, A7 (first queued) takes its tile',
      brief(b.release('A1')), [`A1 ${res[0].place}>- - release`, `A3 ${mail3}>${res[0].place} use served`, `A7 ->${mail3} wait served`])
    F.eq('E9 wait list in join order', b.waiters('printer').map(w => w.owner), ['A4', 'A5', 'A6', 'A7', 'A8', 'A9'])
    const again = b.assign('A8', 'printer', IN)
    F.eq('E9 a queued owner sent to the same station again (a repeated Pre) keeps its place in the line',
      [again.how, again.changes.length, b.waiters('printer').map(w => w.owner)], ['queued', 0, ['A4', 'A5', 'A6', 'A7', 'A8', 'A9']])
    const mail4 = res[3].place!
    F.eq('E9 again: A4 then A8', brief(b.release('A3')), [`A3 ${res[0].place}>- - release`, `A4 ${mail4}>${res[0].place} use served`, `A8 ->${mail4} wait served`])
    F.eq('E9 a queued owner (holding nothing) leaves: nothing moves, the order of the rest is kept',
      [b.release('A9').length, b.waiters('printer').map(w => w.owner)], [0, ['A5', 'A6', 'A7', 'A8']])
    const mail5 = res[4].place!
    b.assign('A10', 'printer', IN)
    F.eq('E9 a waiter on @mail leaves: its tile goes to the first queued owner (A10)',
      [brief(b.release('A5')), b.waiters('printer').map(w => w.owner)], [[`A5 ${mail5}>- - release`, `A10 ->${mail5} wait served`], ['A6', 'A7', 'A8', 'A10']])
  }
  // E11 crowding and the declaration-order tie-break
  {
    const from = { x: 17, y: 3 }
    const cabs = L.stations.get('fileCabinet')!.points
    const b = new M.PlaceBook(L)
    const c1 = b.assign('C1', 'fileCabinet', from).place!
    const c2 = b.assign('C2', 'fileCabinet', from).place!
    const b0 = new M.PlaceBook(L, { crowdCost: 0 })
    b0.assign('C1', 'fileCabinet', from)
    const c2z = b0.assign('C2', 'fileCabinet', from).place!
    F.eq('E11 from (17,3): first (17,2); second with crowding 1.5 (15,2) (tie with (19,2) and (18,5) at 3: declaration order); without crowding (16,2) (tie with (18,2))',
      [c1, c2, c2z], ['cab-08.1', 'cab-06.1', 'cab-07.1'])
    F.eq('E11 = independent nearest', [c2, c2z], [nearest(L, from, cabs, new Set([c1]), 1.5), nearest(L, from, cabs, new Set([c1]), 0)])
  }
  return F.list
}

function checkHolds(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf
  const b = new M.PlaceBook(L)
  const got = Array.from({ length: 11 }, (_, i) => b.hold(`H${i + 1}`, 'arrival', IN).place)
  // classified by the plan's tiles (§4.6), not by the layout's own tiers
  const tier = (id: string | null) => id === null ? 'none' : ['board', 'hold', 'mail'][ARRIVAL.findIndex(t => t.some(([x, y]) => k(L.place(id)) === `${x},${y}`))] ?? 'other'
  F.eq('E8 arrival hold: 2 board spots, 4 hold tiles, 4 mail-corner tiles, then none', got.map(tier),
    ['board', 'board', 'hold', 'hold', 'hold', 'hold', 'mail', 'mail', 'mail', 'mail', 'none'])
  F.eq('E8 arrival holds are distinct', new Set(got.filter(Boolean)).size, 10)
  const h3 = got[2]!
  b.release('H3')
  F.eq('E8 departure hold: a hold tile only', b.hold('X', 'departure', { x: 15, y: 17 }).place, h3)
  b.release('H1')
  F.eq('E8 departure hold never uses the board or the mail corner (none left)', b.hold('Y', 'departure', { x: 15, y: 17 }).place, null)
  F.eq('E8 the hold role', b.holding('X')?.role, 'hold')
  return F.list
}

function checkDispose(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf
  const b = new M.PlaceBook(L)
  for (let i = 0; i < 12; i++) b.assign(`D${i}`, 'printer', IN)
  b.assign('E', 'historyShelf', IN)
  b.hold('H', 'arrival', IN)
  b.reserve('R', at(L, 1, 4))
  const held = b.holdings().length
  const c = b.dispose()
  F.eq('E10 dispose: one change per holding, all to nothing, cause dispose', [c.length, c.every(x => x.to === null && x.cause === 'dispose')], [held, true])
  F.eq('E10 after dispose: nothing held, nobody waiting, every place free',
    [b.holdings().length, b.waiters().length, b.fallbackReaders().length, L.places.every(p => b.isFree(p.id)), b.disposed], [0, 0, 0, true, true])
  const refused: string[] = []
  const tryIt = (name: string, f: () => unknown) => { try { f(); refused.push(`${name}: accepted`) } catch { refused.push(`${name}: refused`) } }
  tryIt('assign', () => b.assign('N', 'fileCabinet', IN))
  tryIt('endPull', () => b.endPull('E'))
  tryIt('hold', () => b.hold('N', 'arrival', IN))
  tryIt('reserve', () => b.reserve('N', at(L, 1, 4)))
  tryIt('transfer', () => b.transfer('N', at(L, 1, 5)))
  tryIt('stepAside', () => b.stepAside('records'))
  F.eq('E10 every booking after dispose is refused', refused, ['assign', 'endPull', 'hold', 'reserve', 'transfer', 'stepAside'].map(n => `${n}: refused`))
  F.eq('E10 release / dispose after dispose: no-ops; still nothing held', [b.release('N').length, b.dispose().length, b.holdings().length], [0, 0, 0])
  // raw bookings refuse a taken place, and leave the book unchanged
  const b2 = new M.PlaceBook(L)
  b2.reserve('A', at(L, 19, 17))
  let threw = false
  try { b2.reserve('B', at(L, 19, 17)) } catch { threw = true }
  F.eq('E10 reserve of a taken place is refused; nothing changes', [threw, b2.ownerOf(at(L, 19, 17)), b2.holding('B')], [true, 'A', null])
  b2.reserve('B', at(L, 20, 17))
  threw = false
  try { b2.transfer('B', at(L, 19, 17)) } catch { threw = true }
  F.eq('E10 transfer onto a taken place is refused; nothing changes', [threw, b2.holding('B')?.place, b2.ownerOf(at(L, 19, 17))], [true, at(L, 20, 17), 'A'])
  return F.list
}

// ── F. the overflow chains terminate ────────────────────────────────────────────────────────────────────────────────
function checkChains(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  for (const [kind, links] of Object.entries(M.CHAINS)) {     // the exported table, analysed here
    F.ok(!links.includes(kind), `chain ${kind} names its own kind (a cycle)`)
    F.ok(new Set(links).size === links.length, `chain ${kind} repeats a link (a cycle)`)
    const pools = links.filter(l => l.startsWith('@'))
    F.ok(pools.length <= 1 && (pools.length === 0 || links[links.length - 1] === pools[0]), `chain ${kind}: the pool is not its single last link`)
    for (const l of links) F.ok(l.startsWith('@') ? l in M.POOL_DEFS : (M.STATION_KINDS as readonly string[]).includes(l), `chain ${kind}: unknown link ${l}`)
  }
  const L = M.buildPlaceLayout(map)
  for (const kind of M.STATION_KINDS) {
    const levels = L.expandChain(kind)
    const all = levels.flatMap(l => l.places)
    F.ok(levels[0]?.level === 'own' && levels[0].via === kind, `chain ${kind}: does not start with its own points`)
    F.ok(new Set(levels.map(l => l.via)).size === levels.length, `chain ${kind}: a level repeats`)
    F.ok(new Set(all).size === all.length, `chain ${kind}: reaches a place twice`)
    F.ok(levels.every((l, i) => l.level !== 'pool' || i === levels.length - 1), `chain ${kind}: the pool is not last`)
  }
  return F.list
}

// ── run on the real module ───────────────────────────────────────────────────────────────────────────────────────────
type Check = (M: Mod, map: OfficeMap) => string[]
const CHECKS: [string, string, Check][] = [
  ['A', 'counts and lists (plan §3.1 / §3.2, replay_fetch_read.py tables)', checkCounts],
  ['B', 'C3 through the API (a seat only from its sitFrom)', checkSeats],
  ['C', 'place-tile rules (C2 sets, busy office)', checkPlaceRules],
  ['D', 'reservation invariants, seeded random sequence (+ determinism)', checkInvariants],
  ['E1', 'fetch-then-read and the step-aside', checkFetchRead],
  ['E2', 'queues: front-desk line, chains, FIFO, crowding', checkQueues],
  ['E3', 'arrival / departure holds', checkHolds],
  ['E4', 'dispose and refusals', checkDispose],
  ['F', 'overflow chains terminate (no cycles)', checkChains],
]
const runCheck = (fn: Check, M: Mod, map: OfficeMap): string[] => { try { return fn(M, map) } catch (e) { return [`threw: ${String(e).split('\n').slice(0, 4).join(' | ')}`] } }

let failures = 0
const passed = new Set<string>()      // a mutant only counts as caught by a check the real module passes
console.log('places.ts on floorplan.json')
for (const [id, name, fn] of CHECKS) {
  const t = performance.now()
  const f = runCheck(fn, real, MAP)
  const ms = (performance.now() - t).toFixed(0)
  if (f.length === 0) { passed.add(id); console.log(`  ok   ${id.padEnd(3)} ${name} (${ms} ms)`) }
  else { failures++; console.error(`FAIL: ${id} ${name}:`); for (const x of f.slice(0, 12)) console.error(`       - ${x}`) }
}
for (const [profile, stats] of Object.entries(lastRunStats)) console.log(`  random run ${profile} (seed ${SEED}, ${N_OPS} ops): ${JSON.stringify(sortObj(stats))}`)

// ── mutants: each must FAIL its check ────────────────────────────────────────────────────────────────────────────────
const SRC = readFileSync(PLACES_PATH, 'utf8')
const NEED_TWICE = "    need(new Set(members).size === members.length, `pool ${name} lists a place twice`)\n"
const NEED_HOMES = '  const setHome = (id: PlaceId, h: string) => { need(!home.has(id), `${id} has two homes (${home.get(id)}, ${h})`); home.set(id, h) }'
const NEED_NOHOME = '  for (const p of places) need(home.has(p.id), `${p.id} at (${p.x},${p.y}) has no home (no station, pool or hold uses it)`)\n'
const NEED_REACH = '      need(new Set(all).size === all.length, `chain ${kind} reaches a place twice`)\n'
const DUP_RECORDS: [string, string] = ["'@records': { tiers: [[{ tiles: 'records-west' }, { tiles: 'records-east' }]], line: false,",
  "'@records': { tiers: [[{ tiles: 'records-west' }, { tiles: 'records-west' }]], line: false,"]
const CYCLE: [string, string] = ["  lectern: ['historyShelf', '@records'],", "  lectern: ['historyShelf', 'lectern', '@records'],"]
const MUTANTS: { name: string; check: string; patches: [string, string][] }[] = [
  { name: 'a seat enterable from the side (canStep drops the sitFrom test)', check: 'B', patches: [
    ['    if (sb) return sb.sitFrom !== null && sb.sitFrom.x === a.x && sb.sitFrom.y === a.y && map.walkable(a.x, a.y)', '    if (sb) return map.walkable(a.x, a.y)']] },
  { name: 'a duplicated pool tile (@records built from records-west twice)', check: 'A', patches: [DUP_RECORDS] },
  { name: 'the same duplicated pool tile with the layout\'s own guards removed', check: 'A', patches: [DUP_RECORDS,
    [NEED_TWICE, ''], [NEED_HOMES, '  const setHome = (id: PlaceId, h: string) => { home.set(id, h) }'], [NEED_NOHOME, ''], [NEED_REACH, ''],
    ["    need([...pools.values()].some(p => POOL_DEFS[p.name].tiers.some(tier => tier.some(m => 'tiles' in m && m.tiles === t))), `floorplan pool ${t} is in no pool`)\n", '']] },
  { name: 'a chain cycle (lectern lists itself)', check: 'F', patches: [CYCLE] },
  { name: 'the same chain cycle with the layout\'s own guards removed', check: 'F', patches: [CYCLE,
    ['      need(!seen.has(link), `chain ${kind}: link ${link} repeats (a cycle)`)\n', ''],
    ['      if (seen.has(via)) throw new Error(`places: chain ${kind} repeats ${via}`)\n', ''], [NEED_REACH, '']] },
  { name: 'a double booking allowed (the taken-place refusal removed)', check: 'D', patches: [
    ['      if (other !== undefined && other !== owner) throw new Error(`PlaceBook: ${to} is held by ${other}; ${owner} cannot book it`)\n', '']] },
  { name: 'a non-FIFO queue (the newest waiter served first)', check: 'D', patches: [
    ['      const w = this.#waiters.find(x => x.kind === station)', '      const w = this.#waiters.findLast(x => x.kind === station)']] },
  { name: 'the same non-FIFO queue, against the scenarios', check: 'E2', patches: [
    ['      const w = this.#waiters.find(x => x.kind === station)', '      const w = this.#waiters.findLast(x => x.kind === station)']] },
  { name: 'a repeated Pre sends a queued owner to the back of the line', check: 'E2', patches: [
    ['    const keepSeq = prev !== undefined && prev.kind === kind ? prev.seq : null\n', '    const keepSeq = prev === prev ? null : null\n']] },
  { name: 'pool waiters never promoted (Python\'s counting model)', check: 'E2', patches: [
    ['      const w = this.#waiters.find(x => x.kind === station)', "      const w = this.#waiters.find(x => x.kind === station && this.#holding.get(x.owner)?.role !== 'wait')"]] },
  { name: 'the step-aside disabled', check: 'E1', patches: [
    ['  #stepAsideOnce(room: Room, prefer: PlaceId | null): { happened: boolean; freed: PlaceId | null } {\n',
      '  #stepAsideOnce(room: Room, prefer: PlaceId | null): { happened: boolean; freed: PlaceId | null } {\n    if (room) return { happened: false, freed: prefer && null }\n']] },
  { name: 'library reading places with the table seats before the reading ledge', check: 'E1', patches: [
    ["  '@library': { tiers: [[{ points: 'readingLedge' }], [{ points: 'readingTable' }], [{ tiles: 'library' }]], line: false,",
      "  '@library': { tiers: [[{ points: 'readingTable' }], [{ points: 'readingLedge' }], [{ tiles: 'library' }]], line: false,"]] },
  { name: 'the step-aside only on a freed place, not on a queue join (Python\'s trigger)', check: 'E1', patches: [
    ['    if (st.shelfRoom !== null) this.#stepAsideAll(st.shelfRoom)\n', '']] },
  { name: 'the step-aside disabled, against the random invariants', check: 'D', patches: [
    ['  #stepAsideOnce(room: Room, prefer: PlaceId | null): { happened: boolean; freed: PlaceId | null } {\n',
      '  #stepAsideOnce(room: Room, prefer: PlaceId | null): { happened: boolean; freed: PlaceId | null } {\n    if (room) return { happened: false, freed: prefer && null }\n']] },
  { name: 'the departure hold falls back to the arrival order (board, hold, mail)', check: 'E3', patches: [
    ["    for (const tier of which === 'arrival' ? this.layout.arrivalHold : this.layout.departureHold) {\n", '    for (const tier of this.layout.arrivalHold) {\n']] },
  { name: 'the arrival hold with the mail corner before the hold tiles', check: 'E3', patches: [
    ["export const ARRIVAL_HOLD: readonly (readonly Member[])[] = [[{ points: 'inOutBoard' }], [{ pool: '@hold' }], [{ pool: '@mail' }]]",
      "export const ARRIVAL_HOLD: readonly (readonly Member[])[] = [[{ points: 'inOutBoard' }], [{ pool: '@mail' }], [{ pool: '@hold' }]]"]] },
  { name: 'dispose() that does not refuse later bookings', check: 'E4', patches: [
    ['    if (this.#disposed) throw new Error(`PlaceBook.${op}: the book is disposed; no booking after dispose()`)\n', '    void op\n']] },
  { name: 'the same, against the random invariants', check: 'D', patches: [
    ['    if (this.#disposed) throw new Error(`PlaceBook.${op}: the book is disposed; no booking after dispose()`)\n', '    void op\n']] },
  { name: 'a random tie-break (non-deterministic choice)', check: 'D', patches: [
    ['      if (cost < bestCost) { best = id; bestCost = cost }', '      if (cost < bestCost || (cost === bestCost && Math.random() < 0.5)) { best = id; bestCost = cost }']] },
  { name: 'a change not reported (the release record dropped)', check: 'D', patches: [
    ["    if (this.#holding.has(owner)) this.#settle(this.#move(owner, null, null, null, null, 'release'))\n",
      "    if (this.#holding.has(owner)) { this.#settle(this.#move(owner, null, null, null, null, 'release')); this.#out = this.#out.filter(c => c.cause !== 'release') }\n"]] },
]
const dir = mkdtempSync(join(tmpdir(), 'wo-places-mutants-'))
let caught = 0
console.log('mutants (each must FAIL its check)')
try {
  for (const [i, m] of MUTANTS.entries()) {
    let src = SRC
    for (const [from, to] of m.patches) {
      const n = src.split(from).length - 1
      if (n !== 1) throw new Error(`mutant "${m.name}": patch target found ${n} times: ${from.slice(0, 80)}`)
      src = src.replace(from, () => to)
    }
    src = src.replace("from './loadMap.ts'", () => `from '${LOADMAP_URL}'`)
    const file = join(dir, `places-mutant-${i}.ts`)
    writeFileSync(file, src)
    const M = await import(pathToFileURL(file).href) as Mod
    const fn = CHECKS.find(c => c[0] === m.check)![2]
    const f = runCheck(fn, M, MAP)
    if (!passed.has(m.check)) { failures++; console.error(`FAIL: mutant "${m.name}": its check ${m.check} fails on the real module too, so it proves nothing`) }
    else if (f.length > 0) { caught++; console.log(`  caught by ${m.check.padEnd(3)} ${m.name}: ${f[0].slice(0, 160)}`) }
    else { failures++; console.error(`FAIL: mutant NOT caught by ${m.check}: ${m.name}`) }
  }
} finally { rmSync(dir, { recursive: true, force: true }) }

// a layout mutant: one more hold tile, in the corridor — loadMap accepts it, the place-tile rules must not
{
  const raw = JSON.parse(JSON.stringify(RAW))
  raw.rows[12] = raw.rows[12].slice(0, 20) + '*' + raw.rows[12].slice(21)
  raw.places.push({ x: 20, y: 12, pool: 'hold', role: 'mutant', facing: 'S', pose: 'standD' })
  const f = runCheck(checkPlaceRules, real, loadMap(raw))
  if (!passed.has('C')) { failures++; console.error('FAIL: layout mutant: check C fails on the real layout too') }
  else if (f.length > 0) { caught++; console.log(`  caught by C   a hold tile in the corridor (20,12), layout mutant: ${f[0]}`) }
  else { failures++; console.error('FAIL: layout mutant (a hold tile in the corridor) NOT caught by C') }
}
console.log(`mutants caught: ${caught} of ${MUTANTS.length + 1}`)
if (caught !== MUTANTS.length + 1) failures++
if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS — places.ts: counts, C3, place-tile rules, invariants, fetch-then-read, queues, holds, dispose, chains')
