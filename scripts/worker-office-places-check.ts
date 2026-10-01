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
//      a BFS over moves() reaches every place, each seat from its sitFrom, at exactly layout.distance(); canStep = the
//      rule on every pair; moves() = one frozen list per tile (the planner's per-node query must not allocate);
//   C  the place-tile rules (place_s3.py's C2 sets) on the layout's own tiles and points, and the busy office;
//   D  reservation invariants under a seeded random sequence of assign / endPull / hold / reserve / transfer /
//      stepAside / release / dispose (3 profiles: mixed, a crowded records room, a crowded library), against a ledger
//      rebuilt ONLY from the change records: never two owners on a tile, never two tiles for an owner, every change
//      reported, free + held conserved per pool (held counted from the holdings); every call's postcondition (assign's
//      result = the book after its cascades, STAY exactly for a booking of the same kind, reserve / transfer end on the
//      named place off every wait list, hold, endPull with a live or a stale pull id, release); every waiter waits for
//      a reason (no free own point, sibling point or pool tile it could take; its booking parked or waiting for that
//      same kind; never a ghost of an older assign); every served owner gets its own kind, its pull, its role, in FIFO
//      order (places granted by assign included); the front-desk line; the step-aside invariant; refusals (a taken
//      place, a disposed book); determinism (the same seed gives the same run, another seed does not); and the runs
//      must exercise every path they claim to check (step-asides in both rooms, parks, sibling promotions, ...);
//   E  scenarios with exact expected changes: fetch-then-read (pull, nearest reading place, fallback at the shelf),
//      the step-aside on a freed place and on a queue join (records; the library with two shelf kinds waiting), pull
//      ids, the library tiers, the front-desk line (promotion, move-up, a parked worker, the 5th finisher keeping its
//      booking), the chains and sibling promotion, FIFO, STAY, the lounge order, the holds, dispose, refusals that
//      change nothing, crowding and the declaration-order tie-break;
//   F  the overflow chains terminate: flat, no link names its own kind or repeats, the pool is last, every expansion
//      is repetition-free;
//   G  every object kind the hook's classifier emits maps to a station or to STAY, and never makes assign() throw.
// Every check is then shown able to FAIL: each planted mutant of places.ts (patched from its source text, each
// patch asserted to apply exactly once, loaded from a temp copy) or of the layout must fail its check.
// Exits 1 on any failure.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadMap, type OfficeMap, type Tile } from '../src/worker-office/map/loadMap.ts'
import * as real from '../src/worker-office/map/places.ts'
import type { Change, PlaceBook, PlaceId, PlaceLayout, PlacePoint, PoolName, Room, StationKind, Waiter } from '../src/worker-office/map/places.ts'
import { KINDS as CLASSIFIER_KINDS } from '../office/observer/classify.mjs'

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
const threw = (f: () => unknown) => { try { f(); return false } catch { return true } }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

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
/** The roles of a booking for its station: a Pre of the same kind is a STAY (plan §4.2). */
const STAY_ROLES = new Set(['use', 'pull', 'read', 'readAtShelf', 'sibling', 'wait', 'parked'])

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
    [L.endpoints.length, L.points.length, L.tiles.filter(t => t.pool !== 'hold').length, L.tiles.filter(t => t.pool === 'hold').length], [120, 88, 28, 4])
  F.eq('endpoints on distinct tiles', new Set(L.endpoints.map(p => k(p))).size, 120)
  F.eq('place ids unique', new Set(L.endpoints.map(p => p.id)).size, 120)
  F.eq('placeAt finds every endpoint on its own tile', L.endpoints.filter(p => L.placeAt(p.x, p.y)?.id !== p.id).map(p => p.id), [])
  for (const [name, tiers] of Object.entries(CHAIN_POOLS)) {
    const pool = L.pools.get(name as PoolName)
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
  F.eq('places with no home', L.endpoints.filter(p => !homes.has(p.id)).map(p => p.id), [])
  F.eq('places with two homes', [...homes].filter(([, h]) => h.length > 1).map(([id, h]) => `${id}: ${h.join(' + ')}`), [])
  F.eq('instances = floorplan objects, in order', L.instances.map(i => i.id), RAW.objects.map((o: { id: string }) => o.id))
  F.eq('chairs and the point that sits on each', L.instances.filter(i => i.seatOfPoint !== null).map(i => [i.id, i.seatOfPoint]), CHAIRS)
  F.eq('every instance lists its points', L.instances.reduce((n, i) => n + i.points.length, 0), 88)
  return F.list
}

// ── B. C3 through the API: a seat only from its sitFrom; the planner's grid queries ───────────────────────────────
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
  F.eq('places unreached by moves() from the IN leaf', L.endpoints.filter(p => !dist.has(k(p))).map(p => p.id), [])
  F.eq('seats whose BFS predecessor is not their sitFrom', seats.filter(s => prev.get(k(s)) !== k(s.sitFrom!)).map(s => s.id), [])
  F.eq('places where layout.distance(IN leaf) != the moves() BFS', L.endpoints.filter(p => L.distance(IN, p.id) !== dist.get(k(p))).map(p => `${p.id} ${L.distance(IN, p.id)} vs ${dist.get(k(p))}`), [])
  const walkable = (() => { let n = 0; for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (map.walkable(x, y)) n++; return n })()
  F.eq('tiles reached by moves() = 458 walkable + 18 seats', dist.size, walkable + 18)
  // a seat as origin: one scripted step back to its sitFrom first; a solid origin is refused
  const d1 = seats[0], cab1 = L.placeId('cab-01.1')
  F.eq(`distance from seat ${d1.id} = 1 + distance from its sitFrom`, L.distance(d1, cab1), 1 + L.distance(d1.sitFrom!, cab1))
  F.eq('distance from a wall, off the grid, a half tile: refused', [threw(() => L.distance({ x: 0, y: 0 }, cab1)), threw(() => L.distance({ x: -1, y: 5 }, cab1)), threw(() => L.distance({ x: 16.5, y: 17 }, cab1))], [true, true, true])
  // the planner's grid queries (Path A expands nodes with them): canStep = the rule on every 4-adjacent pair, including
  // off-grid and half-tile probes; moves() = the steps canStep allows, in BFS order, ONE frozen list per tile
  const seatByKey = new Map(seats.map(s => [k(s), s]))
  const wk = (t: Tile) => Number.isInteger(t.x) && Number.isInteger(t.y) && map.walkable(t.x, t.y)    // loadMap's walkable wants whole tiles
  const rule = (a: Tile, b: Tile) => {
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return false
    const sa = seatByKey.get(k(a)), sb = seatByKey.get(k(b))
    if (sa && sb) return false
    if (sb) return k(sb.sitFrom!) === k(a) && wk(a)
    if (sa) return k(sa.sitFrom!) === k(b) && wk(b)
    return wk(a) && wk(b)
  }
  const probes: Tile[] = [{ x: -1, y: 5 }, { x: map.width, y: 3 }, { x: 16.5, y: 17 }, { x: 17, y: 18.5 }, { x: 3, y: -1 }]
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) probes.push({ x, y })
  const steps = (t: Tile) => DIRS.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy }))
  F.eq('canStep != the rule (walkable both ways, or a seat through its own sitFrom)', probes.flatMap(a => steps(a).filter(b => L.canStep(a, b) !== rule(a, b)).map(b => `${fmt(a)}->${fmt(b)}`)), [])
  F.eq('moves() != the steps canStep allows, in BFS order', probes.filter(t => !same(L.moves(t), steps(t).filter(n => L.canStep(t, n)))).map(fmt), [])
  F.eq('moves(): not ONE frozen list per tile (the planner calls it per node expanded: it must not build a new one)',
    probes.filter(t => { const a = L.moves(t), b = L.moves({ x: t.x, y: t.y }); return a !== b || !Object.isFrozen(a) || a.some(n => !Object.isFrozen(n)) }).map(fmt).slice(0, 5), [])
  F.eq('seatAt / placeAt off the grid or on a half tile', [L.seatAt(-1, 5), L.seatAt(8.5, 18), L.placeAt(map.width, 0), L.placeAt(16.5, 17)], [null, null, null, null])
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
// rest is dispose. 'mixed' covers every station; 'records' crowds the records room and 'library' the library (its three
// shelf kinds share 10 reading places), so that the reading places fill up, pullers fall back to reading at the shelf,
// queue behind them and get stepped aside to.
const PROFILES: Record<string, { cut: readonly number[]; kinds: readonly StationKind[] | null }> = {
  mixed: { cut: [0.36, 0.50, 0.70, 0.78, 0.86, 0.94, 0.997], kinds: null },
  records: { cut: [0.42, 0.70, 0.82, 0.85, 0.89, 0.93, 0.998], kinds: ['historyShelf', 'historyShelf', 'historyShelf', 'historyShelf', 'historyShelf', 'historyShelf', 'lectern', 'lectern', 'fileCabinet', 'bookshelf', 'cardCatalog'] },
  library: { cut: [0.42, 0.70, 0.82, 0.85, 0.89, 0.93, 0.998], kinds: ['bookshelf', 'bookshelf', 'bookshelf', 'cardCatalog', 'cardCatalog', 'cardCatalog', 'manualsShelf', 'manualsShelf', 'manualsShelf', 'fileCabinet', 'historyShelf'] },
}

function randomRun(M: Mod, map: OfficeMap, seed: number, nOps: number, profile: string): RunOut {
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
  const lastKind = new Map<string, StationKind>()   // owner -> the kind of its latest assign (no ghost waiters)
  const fromOf = (o: string): Tile => { const h = book.holding(o); return h ? L.place(h.place) : pick(origins) }
  const siblingsOf = (kind: StationKind) => L.stations.get(kind)!.chain.flatMap(l => (l.type === 'sibling' ? [l.kind] : []))
  const poolOfChain = (kind: StationKind) => L.stations.get(kind)!.chain.flatMap(l => (l.type === 'pool' ? [l.pool] : []))[0] ?? null
  const inPool = (o: string, pool: string) => { const h = book.holding(o); return h !== null && L.poolOf(h.place)?.name === pool }
  for (let n = 0; n < nOps; n++) {
    const before = new Map(book.waiters().map(w => [w.owner, w]))
    let changes: readonly Change[] = []
    let entry = ''
    let assigned: { owner: string; kind: StationKind; fetch: boolean } | null = null
    const r = rnd()
    try {
      if (r < cut[0]) {
        const o = pick(owners), kind = kinds ? pick(kinds) : rnd() < 0.6 ? pick(SMALL) : pick(STATIONS), fetch = rnd() < 0.9
        const h0 = book.holding(o), w0 = book.waiterOf(o)
        const res = book.assign(o, kind, fromOf(o), { fetch })
        assigned = { owner: o, kind, fetch }
        lastKind.set(o, kind)
        changes = res.changes; entry = `assign ${o} ${kind} ${fetch} -> ${res.how} ${res.place} ${res.via}`; tally(`assign:${res.how}`)
        // postconditions: the result is the book after the call's cascades; STAY exactly for a booking of this kind
        const h = book.holding(o), w = book.waiterOf(o)
        const bookedFor = w0?.kind === kind || (w0 === null && h0 !== null && h0.forKind === kind && STAY_ROLES.has(h0.role))
        F.ok((res.how === 'stay') === bookedFor, `[stay] op ${n} (${entry}): ${bookedFor ? 'no STAY' : 'a STAY'} for ${o} booked ${JSON.stringify(h0)}, waiting for ${w0?.kind}`)
        const why = `the result says ${res.how} ${res.place} ${res.via}; the book says ${JSON.stringify(h)}, waiting for ${w?.kind}`
        if (res.how === 'stay') F.ok(changes.length === 0 && same(h, h0) && same(w, w0) && res.place === (h0?.place ?? null), `[stay] op ${n} (${entry}): a STAY changed the booking: ${why}`)
        else if (res.how === 'own') {
          F.ok(h !== null && h.place === res.place && h.forKind === kind && L.stationOf(h.place) === kind && w === null &&
            h.role === (M.SHELF_ROOM[kind] !== undefined && fetch ? 'pull' : 'use'), `[result] op ${n} (${entry}): ${why}`)
        } else if (res.how === 'sibling') {
          F.ok(h !== null && h.place === res.place && h.role === 'sibling' && h.forKind === kind && L.stationOf(h.place) === res.via &&
            siblingsOf(kind).includes(res.via as StationKind) && w === null, `[result] op ${n} (${entry}): ${why}`)
        } else if (res.how === 'pool') {
          F.ok(h !== null && h.place === res.place && h.role === 'wait' && h.forKind === kind && L.poolOf(h.place)?.name === res.via &&
            res.via === poolOfChain(kind) && w?.kind === kind, `[result] op ${n} (${entry}): ${why}`)
        } else {
          F.ok(res.place === null && w?.kind === kind && (h0 === null ? h === null : h !== null && h.place === h0.place && h.role === 'parked' && h.forKind === kind),
            `[result] op ${n} (${entry}): queued must keep (park) what it held: ${why}`)
          if (h0 !== null) tally('assign:queued-keeps-a-place')
        }
        // FIFO for places granted by assign: a newcomer never takes a place an earlier waiter could have had (the place
        // it already stood on was never free, so keeping it overtakes nobody)
        if (res.place !== null && res.place === h0?.place) tally('assign:keeps-its-place')
        else if (res.how === 'own' || res.how === 'sibling') {
          const over = book.waiters().filter(x => x.owner !== o && before.get(x.owner)?.kind === x.kind && (x.kind === kind || x.kind === res.via))
          F.ok(over.length === 0, `[fifo] op ${n} (${entry}): ${o} got ${res.place} ahead of ${over.map(x => `${x.owner}:${x.kind}`).join(', ')}`)
        } else if (res.how === 'pool') {
          const mine = w?.seq ?? Infinity
          const over = book.waiters().filter(x => x.seq < mine && M.CHAINS[x.kind].includes(res.via!) && !inPool(x.owner, res.via!))
          F.ok(over.length === 0, `[fifo] op ${n} (${entry}): ${o} got ${res.place} ahead of ${over.map(x => x.owner).join(', ')}`)
        }
      } else if (r < cut[1]) {
        const pulling = book.holdings().filter(h => h.role === 'pull')
        const o = pulling.length > 0 && rnd() < 0.9 ? pick(pulling).owner : pick(owners)
        const h0 = book.holding(o)
        const id = h0 !== null && h0.pull !== null && rnd() < 0.85 ? h0.pull : (h0?.pull ?? 0) + 1 + Math.floor(rnd() * 3)
        const live = h0 !== null && h0.role === 'pull' && h0.pull === id
        changes = book.endPull(o, id); entry = `endPull ${o} ${id}${live ? '' : ' (stale)'}`; tally(live ? 'endPull:live' : 'endPull:stale')
        const h = book.holding(o)
        if (live) {
          F.ok(changes[0]?.owner === o && changes[0].cause === 'pullDone' && h !== null && (h.role === 'read' || h.role === 'readAtShelf') &&
            h.forKind === h0.forKind && h.pulledFrom === h0.place && (h.role === 'readAtShelf') === (h.place === h0.place),
          `[endPull] op ${n} (${entry}): the pull did not end in a reading: ${JSON.stringify(h)}`)
        } else F.ok(changes.length === 0 && same(h, h0), `[endPull] op ${n} (${entry}): an endPull that names no live pull changed the book`)
      } else if (r < cut[2]) {
        const o = pick(owners); changes = book.release(o); entry = `release ${o}`
        F.ok(book.holding(o) === null && book.waiterOf(o) === null && !book.fallbackReaders().includes(o), `[release] op ${n}: ${o} still booked or listed`)
      } else if (r < cut[3]) {
        const o = pick(owners), which = rnd() < 0.6 ? 'arrival' : 'departure'
        const h0 = book.holding(o), w0 = book.waiterOf(o)
        const res = book.hold(o, which, fromOf(o)); changes = res.changes; entry = `hold ${o} ${which} -> ${res.place}`; tally(`hold:${res.place ? 'place' : 'none'}`)
        const h = book.holding(o)
        if (res.place !== null) {
          const order = (which === 'arrival' ? L.arrivalHold : L.departureHold).flat()
          F.ok(h?.place === res.place && h.role === 'hold' && order.includes(res.place) && book.waiterOf(o) === null, `[hold] op ${n} (${entry}): ${JSON.stringify(h)}, waiting for ${book.waiterOf(o)?.kind}`)
        } else F.ok(changes.length === 0 && same(h, h0) && same(book.waiterOf(o), w0), `[hold] op ${n} (${entry}): no hold, yet the booking changed`)
      } else if (r < cut[4]) {
        const o = pick(owners), p = pick(L.endpoints).id
        const holds = book.holding(o) !== null, other = book.ownerOf(p), w0 = book.waiterOf(o)
        const expectRefusal = holds || other !== null
        entry = `reserve ${o} ${p}`
        try {
          changes = book.reserve(o, p)
          F.ok(!expectRefusal, `op ${n}: reserve(${o}, ${p}) not refused (${holds ? 'the owner holds a place' : `${other} holds it`})`)
          const h = book.holding(o)
          F.ok(h?.place === p && h.role === 'reserved' && h.forKind === null && book.waiterOf(o) === null, `[reserve] op ${n}: reserve(${o}, ${p}) ended with ${JSON.stringify(h)}, waiting for ${book.waiterOf(o)?.kind}`)
          if (w0 !== null) tally('reserve:waiter')
        } catch (e) {
          F.ok(expectRefusal, `op ${n}: reserve(${o}, ${p}) refused without cause: ${e}`); tally('reserve:refused')
          F.ok(same(book.waiterOf(o), w0) && book.ownerOf(p) === other, `[refused] op ${n}: a refused reserve changed the book`)
        }
      } else if (r < cut[5]) {
        const o = pick(owners), p = pick(L.endpoints).id
        const h0 = book.holding(o), other = book.ownerOf(p), w0 = book.waiterOf(o)
        const expectRefusal = h0 === null || (other !== null && other !== o)
        entry = `transfer ${o} ${p}`
        try {
          changes = book.transfer(o, p)
          F.ok(!expectRefusal, `op ${n}: transfer(${o}, ${p}) not refused (${h0 === null ? 'the owner holds nothing' : `${other} holds it`})`)
          const h = book.holding(o)
          F.ok(h?.place === p && h.role === 'reserved' && h.forKind === h0!.forKind && book.waiterOf(o) === null,
            `[transfer] op ${n}: transfer(${o}, ${p}) ended with ${o} at ${h?.place} (${h?.role}), waiting for ${book.waiterOf(o)?.kind}`)
          if (w0 !== null) tally('transfer:waiter')
        } catch (e) {
          F.ok(expectRefusal, `op ${n}: transfer(${o}, ${p}) refused without cause: ${e}`); tally('transfer:refused')
          F.ok(same(book.holding(o), h0) && same(book.waiterOf(o), w0), `[refused] op ${n}: a refused transfer changed the book`)
        }
      } else if (r < cut[6]) {
        const room = pick(ROOMS); changes = book.stepAside(room); entry = `stepAside ${room}`
      } else {
        const held = book.holdings().length
        changes = book.dispose(); entry = `dispose (${held} held)`; tally('dispose')
        F.eq(`op ${n}: dispose released every holding`, [changes.length, book.holdings().length, book.waiters().length, book.fallbackReaders().length], [held, 0, 0, 0])
        const o = pick(owners), p = pick(L.endpoints).id
        F.ok(threw(() => book.assign(o, 'fileCabinet', map.door.inLeaf)), `op ${n}: assign after dispose not refused`)
        F.ok(threw(() => book.reserve(o, p)), `op ${n}: reserve after dispose not refused`)
        F.ok(threw(() => book.hold(o, 'arrival', map.door.inLeaf)), `op ${n}: hold after dispose not refused`)
        F.ok(threw(() => book.endPull(o, 0)), `op ${n}: endPull after dispose not refused`)
        F.ok(threw(() => book.stepAside('records')), `op ${n}: stepAside after dispose not refused`)
        F.ok(threw(() => book.transfer(o, p)), `op ${n}: transfer after dispose not refused`)
        F.eq(`op ${n}: release after dispose`, book.release(o), [])
        F.eq(`op ${n}: nothing booked after the refused calls`, book.holdings().length, 0)
      }
    } catch (e) { F.list.push(`op ${n} (${entry}): threw ${e}`) }
    // 1. the ledger rebuilt from the change records
    for (const c of changes) {
      tally(`change:${c.cause}`)
      if (c.cause === 'stepAside' && c.to !== null) tally(`stepAside:${L.readingRoomOf(c.to)}`)
      if (c.role === 'parked') tally('park')
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
    // 2. the book itself: one owner per place; free + held conserved per pool and overall (held counted from the
    //    holdings, so a place the book thinks taken while no holding is on it is caught)
    F.ok(new Set(holdings.map(h => h.place)).size === holdings.length, `[book] op ${n}: a place with two owners`)
    for (const h of holdings) F.ok(book.ownerOf(h.place) === h.owner, `[book] op ${n}: ownerOf(${h.place}) is ${book.ownerOf(h.place)}, the holding says ${h.owner}`)
    const free = L.endpoints.filter(p => book.isFree(p.id)).length, heldAll = book.heldCount(L.endpoints.map(p => p.id))
    F.ok(free + holdings.length === L.endpoints.length && heldAll === holdings.length,
      `[book] op ${n}: free ${free} + ${holdings.length} holdings != ${L.endpoints.length} places (heldCount ${heldAll})`)
    for (const pool of L.pools.values()) {
      const f = pool.members.filter(id => book.isFree(id)).length, held = holdings.filter(h => pool.members.includes(h.place)).length
      F.ok(f + held === pool.members.length, `[book] op ${n}: pool ${pool.name}: free ${f} + held ${held} != ${pool.members.length}`)
    }
    // 3. every waiter waits for a reason: no own point, sibling point or pool tile it could take is free; its booking is
    //    parked or waiting for that same kind; it is no ghost of an older assign
    const after = book.waiters()
    F.ok(after.every((w, i) => i === 0 || after[i - 1].seq < w.seq), `[fifo] op ${n}: the wait list is not in join order`)
    F.ok(new Set(after.map(w => w.owner)).size === after.length, `[stale] op ${n}: an owner on the wait list twice`)
    for (const w of after) {
      const h = book.holding(w.owner)
      F.ok(h === null || ((h.role === 'wait' || h.role === 'parked') && h.forKind === w.kind),
        `[stale] op ${n} (${entry}): ${w.owner} waits for ${w.kind} but is booked ${h?.role} for ${h?.forKind} at ${h?.place}`)
      F.ok(lastKind.get(w.owner) === w.kind, `[ghost] op ${n} (${entry}): ${w.owner} waits for ${w.kind}, its latest assign was ${lastKind.get(w.owner)}`)
      const st = L.stations.get(w.kind)!
      const freeOwn = st.points.filter(id => book.isFree(id))
      F.ok(freeOwn.length === 0, `[waits] op ${n} (${entry}): ${w.owner} waits for ${w.kind} while ${freeOwn.join(',')} is free`)
      for (const link of st.chain) {
        if (link.type === 'sibling') {
          const freeSib = L.stations.get(link.kind)!.points.filter(id => book.isFree(id))
          F.ok(freeSib.length === 0, `[sibling] op ${n} (${entry}): ${w.owner} waits for ${w.kind} while the sibling point ${freeSib.join(',')} is free`)
        } else if (!inPool(w.owner, link.pool)) {
          const freeP = L.pools.get(link.pool)!.members.filter(id => book.isFree(id))
          F.ok(freeP.length === 0, `[waits] op ${n} (${entry}): ${w.owner} waits for ${w.kind} while ${link.pool} has ${freeP.join(',')} free`)
        }
      }
    }
    for (const h of holdings) {
      if (h.role === 'wait' || h.role === 'parked') F.ok(book.waiterOf(h.owner)?.kind === h.forKind, `[stale] op ${n} (${entry}): ${h.owner} is ${h.role} for ${h.forKind} at ${h.place} but waits for ${book.waiterOf(h.owner)?.kind}`)
      if (h.role === 'wait') F.ok(h.forKind !== null && (M.CHAINS[h.forKind] as readonly string[]).includes(L.poolOf(h.place)?.name ?? '-'), `[stale] op ${n} (${entry}): ${h.owner} waits for ${h.forKind} on ${h.place}, in no pool of its chain`)
      F.ok((h.pull !== null) === (h.role === 'pull'), `[pull] op ${n}: ${h.owner} is ${h.role} with pull id ${h.pull}`)
      if (h.role === 'readAtShelf') F.ok(book.fallbackReaders().includes(h.owner), `op ${n}: ${h.owner} reads at a shelf but is no fallback reader`)
    }
    for (const o of book.fallbackReaders()) F.ok(book.holding(o)?.role === 'readAtShelf', `op ${n}: fallback reader ${o} does not read at a shelf`)
    // 4. every owner served gets what it waited for: its own kind, its pull, its role, in FIFO order (own-kind waiters
    //    of a station come first, then the waiters whose chain lists it, each by join order)
    for (const c of changes) {
      if (c.cause === 'moveUp') {
        F.ok(c.role === 'wait' && c.forKind === 'frontDesk' && (before.get(c.owner)?.kind ?? assigned?.kind) === 'frontDesk', `[line] op ${n} (${entry}): ${c.owner} moved up the line as ${c.role} for ${c.forKind}`)
        continue
      }
      if (c.cause !== 'served' || c.to === null) continue
      const now = assigned !== null && assigned.owner === c.owner
      const w0: Waiter | undefined = before.get(c.owner)
      const wantKind = now ? assigned!.kind : w0?.kind, wantFetch = now ? assigned!.fetch : w0?.fetch
      const seq = now ? Infinity : w0?.seq ?? Infinity
      F.ok(wantKind === c.forKind, `[served] op ${n} (${entry}): ${c.owner} served a ${c.forKind} place (${c.to}) but it waited for ${wantKind}`)
      const at = L.stationOf(c.to), pool = L.poolOf(c.to)
      if (at !== null && at === c.forKind) {
        F.ok(c.role === (M.SHELF_ROOM[at] !== undefined && wantFetch ? 'pull' : 'use'), `[served] op ${n} (${entry}): ${c.owner} served at ${c.to} as ${c.role} (fetch ${wantFetch})`)
        const skipped = after.filter(x => x.kind === at && x.seq < seq)
        F.ok(skipped.length === 0, `[fifo] op ${n} (${entry}): ${c.owner} served ${c.to} ahead of ${skipped.map(x => x.owner).join(', ')}`)
        if (c.role === 'pull') tally('served:pull')
      } else if (at !== null) {
        F.ok(c.role === 'sibling' && c.forKind !== null && siblingsOf(c.forKind).includes(at), `[served] op ${n} (${entry}): ${c.owner} (${c.forKind}) served the ${at} point ${c.to} as ${c.role}`)
        const skipped = after.filter(x => x.kind === at || (siblingsOf(x.kind).includes(at) && x.seq < seq))
        F.ok(skipped.length === 0, `[fifo] op ${n} (${entry}): ${c.owner} took the sibling point ${c.to} ahead of ${skipped.map(x => `${x.owner}:${x.kind}`).join(', ')}`)
        tally('served:sibling')
      } else if (pool !== null) {
        F.ok(c.role === 'wait' && c.forKind !== null && M.CHAINS[c.forKind].includes(pool.name), `[served] op ${n} (${entry}): ${c.owner} (${c.forKind}) served the ${pool.name} tile ${c.to} as ${c.role}`)
        const skipped = after.filter(x => x.seq < seq && M.CHAINS[x.kind].includes(pool.name) && !inPool(x.owner, pool.name))
        F.ok(skipped.length === 0, `[fifo] op ${n} (${entry}): ${c.owner} took ${c.to} ahead of ${skipped.map(x => x.owner).join(', ')}`)
      } else F.list.push(`[served] op ${n} (${entry}): ${c.owner} served ${c.to}, a place of no station and no pool`)
    }
    // 5. the front-desk line (its 'wait' holders; a raw reserve() or a parked worker there is not in the line): no gap
    //    at its front, join order
    const lineIds = L.pools.get('@frontq')!.members
    const inLine = lineIds.map(id => { const o = book.ownerOf(id); const h = o === null ? null : book.holding(o); return h !== null && h.role === 'wait' ? book.waiterOf(h.owner) : null })
    F.ok(!(book.isFree(lineIds[0]) && inLine[1] !== null), `[line] op ${n}: the front-desk line has a gap at its front`)
    if (inLine[0] && inLine[1]) F.ok(inLine[0].seq < inLine[1].seq, `[line] op ${n}: the front-desk line is out of join order`)
    // 6. the step-aside invariant: never a free reading place while a puller waits behind a fallback reader of its shelf
    for (const room of ROOMS) {
      const anyFree = L.pools.get(M.READING_POOL[room])!.members.some(id => book.isFree(id))
      const stuck = after.filter(w => M.SHELF_ROOM[w.kind] === room && book.fallbackReaders(w.kind).length > 0)
      F.ok(!(anyFree && stuck.length > 0), `[stepAside] op ${n}: a ${room} reading place is free while ${stuck.map(w => w.owner).join(', ')} wait behind a fallback reader`)
    }
    if (book.disposed) { book = new M.PlaceBook(L); shadow = new Map(); shadowOwner = new Map(); lastKind.clear() }
    log.push(`${entry} ${JSON.stringify(changes)}`)
    if (F.list.length > 20) break
  }
  return { fails: F.list, log, stats }
}

const SEED = 20261001
const N_OPS = 4000
const lastRunStats: Record<string, Record<string, number>> = {}
function checkInvariants(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const seen: Record<string, number> = {}
  for (const profile of Object.keys(PROFILES)) {
    const a = randomRun(M, map, SEED, N_OPS, profile)
    const b = randomRun(M, map, SEED, N_OPS, profile)
    const c = randomRun(M, map, SEED + 1, N_OPS, profile)
    F.list.push(...a.fails.map(f => `${profile} seed ${SEED}: ${f}`), ...c.fails.map(f => `${profile} seed ${SEED + 1}: ${f}`))
    const sameRun = a.log.length === b.log.length && a.log.every((l, i) => l === b.log[i])
    F.ok(sameRun, `${profile}: determinism: the same seed gave different assignments (first difference at op ${a.log.findIndex((l, i) => l !== b.log[i])})`)
    F.ok(JSON.stringify(a.log) !== JSON.stringify(c.log), `${profile}: determinism probe: two different seeds gave the same run`)
    for (const run of [a, c]) for (const [s, v] of Object.entries(run.stats)) seen[s] = (seen[s] ?? 0) + v
    lastRunStats[profile] = a.stats
  }
  // the runs must actually exercise what they claim to check
  for (const need of ['assign:own', 'assign:sibling', 'assign:pool', 'assign:queued', 'assign:stay', 'assign:queued-keeps-a-place', 'park',
    'change:served', 'served:pull', 'served:sibling', 'change:moveUp', 'change:stepAside', 'stepAside:records', 'stepAside:library',
    'change:pullDone', 'endPull:live', 'endPull:stale', 'dispose', 'reserve:refused', 'reserve:waiter', 'transfer:refused',
    'transfer:waiter', 'hold:place', 'hold:none']) {
    F.ok((seen[need] ?? 0) > 0, `the random runs never exercised ${need}`)
  }
  return F.list
}

// ── E. scenarios with exact expected changes ──────────────────────────────────────────────────────────────────────
const at = (L: PlaceLayout, x: number, y: number) => L.placeAt(x, y)!.id
const brief = (cs: readonly Change[]) => cs.map(c => `${c.owner} ${c.from ?? '-'}>${c.to ?? '-'} ${c.role ?? '-'} ${c.cause}`)
/** End the owner's pull in progress (by its id), as the pull timer does. */
const endPullOf = (b: PlaceBook, o: string) => b.endPull(o, b.holding(o)?.pull ?? -1)

/** Independent nearest: own BFS over moves(), + crowding, ties by declaration order. */
function nearest(L: PlaceLayout, from: Tile, ids: readonly PlaceId[], held: ReadonlySet<string>, crowd = 0) {
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
    const hist51 = L.placeId('hist-5.1')
    F.eq('E1 the pull is named by the change that granted it', [b.holding('A')?.pull, r.changes.length], [r.changes[0]?.seq, 1])
    const c = endPullOf(b, 'A')
    const h = b.holding('A')!
    F.eq('E1 endPull: role / reading place = independent nearest / pulledFrom / shelf freed',
      [h.role, h.place, h.pulledFrom, b.isFree(hist51), h.pull], ['read', nearest(L, L.place(hist51), records, new Set()), 'hist-5.1', true, null])
    F.eq('E1 the nearest records reading place from hist-5.1 (18,8): (23,8), 5 steps along the use spots, tied with (22,9) and first in declaration order',
      [xy(L.place(h.place)), L.distance(L.place(hist51), at(L, 23, 8)), L.distance(L.place(hist51), at(L, 22, 9))], [[23, 8], 5, 5])
    F.eq('E1 changes', brief(c), [`A hist-5.1>${h.place} read pullDone`])
    F.eq('E1 a glance (fetch: false) holds the shelf as a plain use, with no pull; endPull is a no-op', (() => {
      const g = b.assign('G', 'historyShelf', from, { fetch: false })
      return [g.how, b.holding('G')?.role, b.holding('G')?.pull, endPullOf(b, 'G').length]
    })(), ['own', 'use', null, 0])
  }
  // E1 pull ids: the timer of an abandoned pull never ends the next one
  {
    const b = new M.PlaceBook(L)
    b.assign('W', 'historyShelf', IN)
    const first = b.holding('W')!.pull
    b.assign('W', 'bookshelf', L.place(b.holding('W')!.place))       // a Pre for the bookshelf during the first pull
    const second = b.holding('W')!.pull
    F.eq('E1 two pulls, two ids', [typeof first, typeof second, first !== second], ['number', 'number', true])
    F.eq('E1 the first pull\'s timer fires during the second pull: a no-op', [brief(b.endPull('W', first!)), b.holding('W')?.role], [[], 'pull'])
    const end = b.endPull('W', second!)
    F.eq('E1 the second pull\'s own timer ends it; once more is a no-op', [end.length, end[0]?.cause, b.holding('W')?.role, b.endPull('W', second!).length], [1, 'pullDone', 'read', 0])
  }
  // E2..E4 the records pool full: fallback readers, then the step-aside (on a freed place; on a queue join)
  const setup = () => {
    const b = new M.PlaceBook(L)
    records.forEach((id, i) => b.reserve(`R${i + 1}`, id))
    const shelfOf: string[] = []
    for (let i = 1; i <= 8; i++) { const r = b.assign(`S${i}`, 'historyShelf', IN); shelfOf.push(r.place!) }
    const ends = [1, 2, 3, 4, 5, 6, 7, 8].map(i => brief(endPullOf(b, `S${i}`)))
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
    F.eq('E4 a puller joins the queue while a reading place is free: the step-aside serves it at once, and the result says so (own, at that shelf point)',
      [p.how, p.place, brief(p.changes), b.waiters().length, b.holding('P')?.role],
      ['own', shelfOf[0], [`S1 ${shelfOf[0]}>${records[4]} read stepAside`, `P ->${shelfOf[0]} pull served`], 0, 'pull'])
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
      endPullOf(b, `B${i}`)
      const h = b.holding(`B${i}`)!
      got.push(h.role === 'readAtShelf' ? 'shelf' : tierOf(h.place))
    }
    F.eq('E5 library reading places by tier (book, book, book, book, manuals, book, book, catalog, book, book, book)', got,
      ['ledge', 'ledge', 'table', 'table', 'table', 'table', 'aisle', 'aisle', 'aisle', 'aisle', 'shelf'])
  }
  // E5 the library step-aside with two shelf kinds waiting: the vacated catalog point goes to the catalog puller, never
  // to the earlier manuals waiter
  {
    const b = new M.PlaceBook(L)
    L.pools.get('@library')!.members.forEach((id, i) => b.reserve(`R${i + 1}`, id))     // all 10 reading places taken
    b.assign('M1', 'manualsShelf', IN); b.assign('M2', 'manualsShelf', IN)                // both manuals points, still pulling
    b.assign('C1', 'cardCatalog', IN); b.assign('C2', 'cardCatalog', IN)
    endPullOf(b, 'C1'); endPullOf(b, 'C2')                                                // no reading place: both read at the catalog
    const c1 = b.holding('C1')!.place
    const m3 = b.assign('M3', 'manualsShelf', IN), c3 = b.assign('C3', 'cardCatalog', IN)
    F.eq('E5 library: M3 queues for the manuals, then C3 for the catalog; C1 and C2 read at the catalog',
      [m3.how, c3.how, b.waiters().map(w => `${w.owner}:${w.kind}`), b.fallbackReaders()], ['queued', 'queued', ['M3:manualsShelf', 'C3:cardCatalog'], ['C1', 'C2']])
    F.eq('E5 library: a reading place frees: the earliest CATALOG reader steps aside, the catalog puller takes its point',
      brief(b.release('R1')), ['R1 ledge.1>- - release', `C1 ${c1}>ledge.1 read stepAside`, `C3 ->${c1} pull served`])
    F.eq('E5 library: M3 still waits for the manuals shelf, holding nothing', [b.waiterOf('M3')?.kind, b.holding('M3'), b.holding('C3')?.role], ['manualsShelf', null, 'pull'])
  }
  return F.list
}

function checkQueues(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const IN = map.door.inLeaf
  const front = at(L, 16, 17), back = at(L, 16, 16)
  // E6 the front-desk line: two at the desk, two in the line, the fifth waits at its own station keeping its booking
  {
    const b = new M.PlaceBook(L)
    const d1 = b.assign('D1', 'frontDesk', IN), d2 = b.assign('D2', 'frontDesk', IN)
    const q1 = b.assign('Q1', 'frontDesk', IN), q2 = b.assign('Q2', 'frontDesk', IN)
    const cab = b.assign('V', 'fileCabinet', IN).place!
    const v = b.assign('V', 'frontDesk', IN)
    F.eq('E6 desk, desk, line front (16,17), line back (16,16), then queued',
      [d1.how, d2.how, [q1.how, q1.via, q1.place], [q2.how, q2.via, q2.place], [v.how, v.place, brief(v.changes)]],
      ['own', 'own', ['pool', '@frontq', front], ['pool', '@frontq', back], ['queued', null, [`V ${cab}>${cab} parked assign`]]])
    F.eq('E6 the fifth keeps its booking, parked for the front desk (plan §4.6 "waits at its own station and keeps its reservation")',
      [b.holding('V')?.place, b.holding('V')?.role, b.holding('V')?.forKind, b.waiters('frontDesk').map(w => w.owner)], [cab, 'parked', 'frontDesk', ['Q1', 'Q2', 'V']])
    const rel = b.release('D1')
    F.eq('E6 a desk spot frees: the line front is promoted, the line moves up, the fifth steps into the line',
      brief(rel), [`D1 ${d1.place}>- - release`, `Q1 ${front}>${d1.place} use served`, `Q2 ${back}>${front} wait moveUp`, `V ${cab}>${back} wait served`])
    F.eq('E6 after: wait list', b.waiters('frontDesk').map(w => w.owner), ['Q2', 'V'])
    const rel2 = b.release('D2')
    F.eq('E6 the next desk spot: FIFO again', brief(rel2), [`D2 ${d2.place}>- - release`, `Q2 ${front}>${d2.place} use served`, `V ${back}>${front} wait moveUp`])
  }
  // E6 a worker in the line sent elsewhere before its Stop (plan §4.9 "FIN_* before Stop: Pre(other kind)") while that
  // station is full: it is PARKED on its line tile for the new kind — never moved up the line, never passed off as a
  // front-desk waiter — and served by the new kind's own cascade
  {
    const b = new M.PlaceBook(L)
    for (const o of ['D1', 'D2', 'Q1', 'Q2']) b.assign(o, 'frontDesk', IN)
    for (let i = 0; i < 28; i++) b.assign(`C${i}`, 'fileCabinet', IN)       // the 20 cabinets, then the 8 @records tiles
    const r = b.assign('Q2', 'fileCabinet', L.place(back))
    F.eq('E6 Q2 in the line, sent to the full cabinets: queued, its line tile parked for the cabinets',
      [r.how, brief(r.changes), b.holding('Q2'), b.waiterOf('Q2')?.kind, b.waiters('frontDesk').map(w => w.owner)],
      ['queued', [`Q2 ${back}>${back} parked assign`], { owner: 'Q2', place: back, role: 'parked', forKind: 'fileCabinet', pulledFrom: null, pull: null }, 'fileCabinet', ['Q1']])
    F.eq('E6 the line front leaves: the parked worker does not move up', brief(b.release('Q1')), [`Q1 ${front}>- - release`])
    const v = b.assign('V', 'frontDesk', IN)
    F.eq('E6 a new finisher takes the free line front', [v.how, v.place], ['pool', front])
    const d1 = b.holding('D1')!.place
    F.eq('E6 a desk spot frees: the finisher at the line front is served; the parked worker stays', brief(b.release('D1')), [`D1 ${d1}>- - release`, `V ${front}>${d1} use served`])
    const c0 = b.holding('C0')!.place, c20 = b.holding('C20')!.place
    F.eq('E6 a cabinet frees: the earliest cabinet waiter (C20, on @records) is promoted, the parked Q2 takes its tile',
      brief(b.release('C0')), [`C0 ${c0}>- - release`, `C20 ${c20}>${c0} use served`, `Q2 ${back}>${c20} wait served`])
  }
  // E6 the same during a pull: the shelf point is parked; the pull is over (no reading place, no item); its timer is a no-op
  {
    const b = new M.PlaceBook(L)
    for (let i = 0; i < 28; i++) b.assign(`C${i}`, 'fileCabinet', IN)
    b.assign('W', 'historyShelf', IN)
    const pull = b.holding('W')!.pull!, shelf = b.holding('W')!.place
    const r = b.assign('W', 'fileCabinet', L.place(shelf))
    F.eq('E6 W pulling, sent to the full cabinets: queued, its shelf point parked for the cabinets, no pull, no item',
      [r.how, brief(r.changes), b.holding('W')?.role, b.holding('W')?.forKind, b.holding('W')?.pulledFrom, b.holding('W')?.pull],
      ['queued', [`W ${shelf}>${shelf} parked assign`], 'parked', 'fileCabinet', null, null])
    F.eq('E6 ...the old pull\'s timer: a no-op; W is no fallback reader', [brief(b.endPull('W', pull)), b.fallbackReaders()], [[], []])
  }
  // E7 chains: own, sibling, pool, queue; a sibling on a shelf point is not a pull; a freed sibling point is offered
  {
    const b = new M.PlaceBook(L)
    const how = (o: string, kind: StationKind) => { const r = b.assign(o, kind, IN); return `${r.how}${r.via ? ':' + r.via : ''}` }
    const desks = Array.from({ length: 17 }, (_, i) => how(`P${i + 1}`, 'pcDesk'))
    F.eq('E7 pcDesk: 6 own, 8 benches, 2 on @desks, then queued',
      desks, [...Array(6).fill('own'), ...Array(8).fill('sibling:benchTerminal'), 'pool:@desks', 'pool:@desks', 'queued'])
    const lect = Array.from({ length: 19 }, (_, i) => how(`L${i + 1}`, 'lectern'))
    F.eq('E7 lectern: 2 own, 8 history shelves, 8 on @records, then queued',
      lect, [...Array(2).fill('own'), ...Array(8).fill('sibling:historyShelf'), ...Array(8).fill('pool:@records'), 'queued'])
    F.eq('E7 a lectern worker on a history shelf holds it as a sibling (no pull; endPull no-op)', [b.holding('L3')?.role, b.holding('L3')?.pull, endPullOf(b, 'L3').length], ['sibling', null, 0])
    const l1 = b.holding('L1')!.place, l11 = b.holding('L11')!.place
    F.eq('E7 a lectern frees: the earliest waiter (on @records) is promoted, the queued one takes its tile',
      brief(b.release('L1')), [`L1 ${l1}>- - release`, `L11 ${l11}>${l1} use served`, `L19 ->${l11} wait served`])
    const l3 = b.holding('L3')!.place, l12 = b.holding('L12')!.place
    F.eq('E7 a sibling point frees with no waiter of its own kind: the earliest waiter whose chain lists it (L12, on @records) is promoted to it',
      brief(b.release('L3')), [`L3 ${l3}>- - release`, `L12 ${l12}>${l3} sibling served`])
  }
  // E7 FIFO when a sibling point frees: the waiters get it before any newcomer (printer / copier; pcDesk / bench)
  {
    const b = new M.PlaceBook(L)
    const res = Array.from({ length: 7 }, (_, i) => b.assign(`A${i + 1}`, 'printer', IN))
    F.eq('E7 printer x7: own, sibling copier, 4 on @mail, queued', res.map(r => r.how), ['own', 'sibling', 'pool', 'pool', 'pool', 'pool', 'queued'])
    const copier = res[1].place!, mail3 = res[2].place!
    F.eq('E7 the copier frees: the earliest printer waiter (A3, on @mail) is promoted to it, the queued A7 takes A3\'s tile',
      brief(b.release('A2')), [`A2 ${copier}>- - release`, `A3 ${mail3}>${copier} sibling served`, `A7 ->${mail3} wait served`])
    const a8 = b.assign('A8', 'printer', IN)
    F.eq('E7 a newcomer then waits behind them', [a8.how, b.waiters('printer').map(w => w.owner)], ['queued', ['A4', 'A5', 'A6', 'A7', 'A8']])
  }
  {
    const b = new M.PlaceBook(L)
    const res = Array.from({ length: 17 }, (_, i) => b.assign(`P${i + 1}`, 'pcDesk', IN))
    const bench = res[6].place!, desks1 = res[14].place!
    F.eq('E7 a bench held by a desk worker frees: the earliest desk waiter (P15, on @desks) is promoted, the queued P17 takes its tile',
      brief(b.release('P7')), [`P7 ${bench}>- - release`, `P15 ${desks1}>${bench} sibling served`, `P17 ->${desks1} wait served`])
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
    F.eq('E9 a queued owner sent to the same station again (a repeated Pre) is a STAY: it keeps its place in the line',
      [again.how, again.changes.length, b.waiters('printer').map(w => w.owner)], ['stay', 0, ['A4', 'A5', 'A6', 'A7', 'A8', 'A9']])
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
  // E12 the lounge (plan §4.6): the sofa's seats, then the armchairs, then standing at a kitchen spot
  {
    const b = new M.PlaceBook(L)
    const got = Array.from({ length: 6 }, (_, i) => b.assign(`U${i + 1}`, 'lounge', IN))
    const kindOf = (id: PlaceId | null) => { const p = id === null ? null : L.place(id); return p === null ? null : p.type === 'point' ? (p as PlacePoint).kind : 'tile' }
    F.eq('E12 the lounge from the IN leaf: three sofa seats, then the two armchairs, then a kitchen spot',
      got.map(r => [r.how, r.place, kindOf(r.place)]),
      [['own', 'sofa.3', 'sofaN'], ['own', 'sofa.1', 'sofaN'], ['own', 'sofa.2', 'sofaN'], ['own', 'armchair-E.1', 'armchairN'], ['own', 'armchair-W.1', 'armchairN'], ['pool', 'waterCooler.1', 'waterCooler']])
    const sofas = L.points.filter(p => p.kind === 'sofaN').map(p => p.id), arms = L.points.filter(p => p.kind === 'armchairN').map(p => p.id)
    F.eq('E12 the first of each tier = independent nearest', [got[0].place, got[3].place], [nearest(L, IN, sofas, new Set(), 1.5), nearest(L, IN, arms, new Set(sofas), 1.5)])
  }
  // E13 STAY (plan §4.2: a Pre of the station the worker is at keeps it there), and a worker's own place is never
  // charged crowding
  {
    const b = new M.PlaceBook(L)
    const mid = at(L, 16, 2)                          // cab-07.1, between cab-06.1 (15,2) and cab-08.1 (17,2)
    b.reserve('N1', at(L, 15, 2)); b.reserve('N2', at(L, 17, 2))
    b.assign('X', 'fileCabinet', { x: 16, y: 3 })
    b.transfer('X', mid)                               // X stands on the middle spot (a raw booking, re-sync)
    const r1 = b.assign('X', 'fileCabinet', L.place(mid))
    F.eq('E13 X sent to the cabinets from its own spot between two occupied ones: it stays (its own place costs no crowding)',
      [r1.how, r1.place, brief(r1.changes)], ['own', mid, [`X ${mid}>${mid} use assign`]])
    const r2 = b.assign('X', 'fileCabinet', L.place(mid))
    F.eq('E13 the same Pre again: STAY, nothing changes', [r2.how, r2.place, r2.changes.length], ['stay', mid, 0])
    b.assign('R', 'historyShelf', IN); endPullOf(b, 'R')
    const read = b.holding('R')!
    const r3 = b.assign('R', 'historyShelf', L.place(read.place))
    F.eq('E13 a reader at its reading place, Pre(historyShelf) again: STAY, still reading there', [r3.how, r3.place, r3.changes.length, b.holding('R')?.role], ['stay', read.place, 0, 'read'])
    const r4 = b.assign('R', 'lectern', L.place(read.place))
    F.eq('E13 ...a Pre of another kind is no STAY: it goes, freeing the reading place', [r4.how, r4.changes[0]?.from, b.isFree(read.place)], ['own', read.place, true])
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
    [b.holdings().length, b.waiters().length, b.fallbackReaders().length, L.endpoints.every(p => b.isFree(p.id)), b.disposed], [0, 0, 0, true, true])
  const refused: string[] = []
  const tryIt = (name: string, f: () => unknown) => { try { f(); refused.push(`${name}: accepted`) } catch { refused.push(`${name}: refused`) } }
  tryIt('assign', () => b.assign('N', 'fileCabinet', IN))
  tryIt('endPull', () => b.endPull('E', 0))
  tryIt('hold', () => b.hold('N', 'arrival', IN))
  tryIt('reserve', () => b.reserve('N', at(L, 1, 4)))
  tryIt('transfer', () => b.transfer('N', at(L, 1, 5)))
  tryIt('stepAside', () => b.stepAside('records'))
  F.eq('E10 every booking after dispose is refused', refused, ['assign', 'endPull', 'hold', 'reserve', 'transfer', 'stepAside'].map(n => `${n}: refused`))
  F.eq('E10 release / dispose after dispose: no-ops; still nothing held', [b.release('N').length, b.dispose().length, b.holdings().length], [0, 0, 0])
  // raw bookings refuse a taken place, and leave the book unchanged
  const b2 = new M.PlaceBook(L)
  b2.reserve('A', at(L, 19, 17))
  F.eq('E10 reserve of a taken place is refused; nothing changes', [threw(() => b2.reserve('B', at(L, 19, 17))), b2.ownerOf(at(L, 19, 17)), b2.holding('B')], [true, 'A', null])
  b2.reserve('B', at(L, 20, 17))
  F.eq('E10 transfer onto a taken place is refused; nothing changes', [threw(() => b2.transfer('B', at(L, 19, 17))), b2.holding('B')?.place, b2.ownerOf(at(L, 19, 17))], [true, at(L, 20, 17), 'A'])
  // raw bookings take the owner off its wait list (re-queued by assign), so a transfer ends on the named place
  {
    const b3 = new M.PlaceBook(L)
    const res = Array.from({ length: 7 }, (_, i) => b3.assign(`A${i + 1}`, 'printer', IN))      // A3..A6 on @mail, A7 queued
    const hold1 = at(L, 19, 17), mail3 = res[2].place!
    F.eq('E10 transfer of a pool waiter (re-sync): it ends on the named place, off the wait list; its tile goes to the first queued owner',
      [brief(b3.transfer('A3', hold1)), b3.holding('A3')?.place, b3.holding('A3')?.role, b3.waiterOf('A3')],
      [[`A3 ${mail3}>${hold1} reserved transfer`, `A7 ->${mail3} wait served`], hold1, 'reserved', null])
    b3.assign('Z', 'printer', IN)                                                                 // queued, holding nothing
    const s = JSON.stringify([b3.holdings(), b3.waiters()])
    F.eq('E10 a refused reserve / transfer changes nothing (the owner keeps its place in the line)',
      [threw(() => b3.reserve('Z', hold1)), threw(() => b3.transfer('A4', hold1)), JSON.stringify([b3.holdings(), b3.waiters()]) === s], [true, true, true])
    F.eq('E10 reserve of a queued owner: a raw booking, off the wait list', [brief(b3.reserve('Z', at(L, 20, 17))), b3.waiterOf('Z')], [[`Z ->${at(L, 20, 17)} reserved reserve`], null])
  }
  // a policy call from a tile no worker can stand on is refused BEFORE anything changes
  {
    const b4 = new M.PlaceBook(L)
    for (const o of ['D1', 'D2', 'Q1', 'Q2']) b4.assign(o, 'frontDesk', IN)
    const cab = b4.assign('V', 'fileCabinet', IN).place!
    b4.assign('V', 'frontDesk', IN)                                                               // queued, its cabinet parked
    const s = JSON.stringify([b4.holdings(), b4.waiters(), b4.fallbackReaders()])
    const bad: [string, () => unknown][] = [
      ['assign from a wall (0,0)', () => b4.assign('V', 'fileCabinet', { x: 0, y: 0 })],
      ['assign from the counter (14,16)', () => b4.assign('V', 'printer', { x: 14, y: 16 })],
      ['assign from off the grid (-1,5)', () => b4.assign('V', 'lectern', { x: -1, y: 5 })],
      ['assign from a half tile (16.5,17)', () => b4.assign('V', 'copier', { x: 16.5, y: 17 })],
      ['hold from a wall (0,0)', () => b4.hold('V', 'arrival', { x: 0, y: 0 })],
    ]
    F.eq('E10 a bad origin is refused, and nothing changes', [bad.map(([w, f]) => `${w}: ${threw(f) ? 'refused' : 'accepted'}`), JSON.stringify([b4.holdings(), b4.waiters(), b4.fallbackReaders()]) === s],
      [bad.map(([w]) => `${w}: refused`), true])
    F.eq('E10 ...so the refused worker keeps its place in the line', brief(b4.release('D1')).slice(-1), [`V ${cab}>${at(L, 16, 16)} wait served`])
  }
  return F.list
}

// ── F. the overflow chains terminate ────────────────────────────────────────────────────────────────────────────────
function checkChains(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  for (const [kind, links] of Object.entries(M.CHAINS)) {     // the exported table, analysed here
    F.ok(!(links as readonly string[]).includes(kind), `chain ${kind} names its own kind (a cycle)`)
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

// ── G. the classifier's kinds: a station or STAY, never a throw ──────────────────────────────────────────────────────
function checkClassifierKinds(M: Mod, map: OfficeMap): string[] {
  const F = new Fails()
  const L = M.buildPlaceLayout(map)
  const kinds = [...(CLASSIFIER_KINDS as Set<string>)].sort()
  F.eq('G the station table lists exactly the kinds the classifier emits (office/observer/classify.mjs KINDS)', Object.keys(M.STATION_FOR_KIND).sort(), kinds)
  F.eq('G a roster look (ListAgents -> inOutBoard) is a STAY: the board is an arrival hold only (plan §4.4)', M.stationForKind('inOutBoard'), null)
  F.eq('G every other classifier kind is the station of that name', kinds.filter(x => x !== 'inOutBoard' && M.stationForKind(x) !== x), [])
  F.eq('G no kind, a kind no table lists, a prototype key: STAY (null)', [null, undefined, 'serverRack', 'toString', '__proto__'].map(x => M.stationForKind(x) === null), [true, true, true, true, true])
  const b = new M.PlaceBook(L)
  const thrown: string[] = []
  for (const x of kinds) {
    const s = M.stationForKind(x)
    if (s === null) continue
    try { b.assign(`K-${x}`, s, map.door.inLeaf) } catch (e) { thrown.push(`${x}: ${e}`) }
  }
  F.eq('G assign() throws for a station a classifier kind maps to', thrown, [])
  return F.list
}

// ── type contracts, checked by tsc -p tsconfig.scripts.json: every line marked @ts-expect-error MUST be a type error
//    (an unused directive fails tsc). Never called.
function typeContracts(b: PlaceBook) {
  const place = b.layout.points[0].id, owner = 'w1'
  // @ts-expect-error swapped arguments: an owner id where a place id goes
  b.reserve(place, owner)
  // @ts-expect-error a plain string is no place id (place ids come from the layout)
  b.ownerOf('hist-5.1')
  // @ts-expect-error a chain link that names no station and no pool (a typo)
  const typo: typeof real.CHAINS = { ...real.CHAINS, lectern: ['historyShelf', '@recrods'] }
  // @ts-expect-error a reading pool that is no pool
  const room: typeof real.READING_POOL = { ...real.READING_POOL, records: '@record' }
  return [typo, room]
}
void typeContracts

// ── run on the real module ───────────────────────────────────────────────────────────────────────────────────────────
type Check = (M: Mod, map: OfficeMap) => string[]
const CHECKS: [string, string, Check][] = [
  ['A', 'counts and lists (plan §3.1 / §3.2, replay_fetch_read.py tables)', checkCounts],
  ['B', 'C3 through the API (a seat only from its sitFrom), the planner\'s grid queries', checkSeats],
  ['C', 'place-tile rules (C2 sets, busy office)', checkPlaceRules],
  ['D', 'reservation invariants, seeded random sequence (+ determinism)', checkInvariants],
  ['E1', 'fetch-then-read, pull ids and the step-aside', checkFetchRead],
  ['E2', 'queues: front-desk line, parked workers, chains, FIFO, crowding, lounge, STAY', checkQueues],
  ['E3', 'arrival / departure holds', checkHolds],
  ['E4', 'dispose, raw bookings and refusals', checkDispose],
  ['F', 'overflow chains terminate (no cycles)', checkChains],
  ['G', 'classifier kinds: a station or STAY', checkClassifierKinds],
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
// LF, whatever the checkout made of it (core.autocrlf): the patches below are LF text
const SRC = readFileSync(PLACES_PATH, 'utf8').replace(/\r\n/g, '\n')
const NEED_TWICE = "    need(new Set(members).size === members.length, `pool ${name} lists a place twice`)\n"
const NEED_HOMES = '  const setHome = (id: PlaceId, h: string) => { need(!home.has(id), `${id} has two homes (${home.get(id)}, ${h})`); home.set(id, h) }'
const NEED_NOHOME = '  for (const p of endpoints) need(home.has(p.id), `${p.id} at (${p.x},${p.y}) has no home (no station, pool or hold uses it)`)\n'
const NEED_REACH = '      need(new Set(all).size === all.length, `chain ${kind} reaches a place twice`)\n'
const DUP_RECORDS: [string, string] = ["'@records': { tiers: [[{ tiles: 'records-west' }, { tiles: 'records-east' }]], line: false,",
  "'@records': { tiers: [[{ tiles: 'records-west' }, { tiles: 'records-west' }]], line: false,"]
const CYCLE: [string, string] = ["  lectern: ['historyShelf', '@records'],", "  lectern: ['historyShelf', 'lectern', '@records'],"]
const OWN_SERVE = '      const own = this.#waiters.find(x => x.kind === station)'
const STEP_ASIDE_HEAD = '  #stepAsideOnce(room: Room, prefer: PlaceId | null): { happened: boolean; freed: PlaceId | null } {\n'
const NO_STEP_ASIDE: [string, string] = [STEP_ASIDE_HEAD, `${STEP_ASIDE_HEAD}    if (room) return { happened: false, freed: prefer && null }\n`]
const QUEUE_JOIN_STEP = '      if (st.shelfRoom !== null) this.#stepAsideAll(st.shelfRoom)\n'
const GRANT = '    this.#settle(this.#move(owner, place, role, forKind, null, cause))\n'
const STEP_ASIDE_SERVE = '    const w = this.#waiters.find(x => x.kind === kind)!'
const DISPOSED = '    if (this.#disposed) throw new Error(`PlaceBook.${op}: the book is disposed; no booking after dispose()`)\n'
const MUTANTS: { name: string; check: string; patches: [string, string][] }[] = [
  // the layout
  { name: 'a seat enterable from the side (canStep drops the sitFrom test)', check: 'B', patches: [
    ['    if (sb >= 0) return sitFromIdx[sb] === ia && walk[ia] === 1', '    if (sb >= 0) return walk[ia] === 1']] },
  { name: 'moves() builds a new list on every call (the planner\'s per-node query allocates)', check: 'B', patches: [
    ['  const moves = (a: Tile) => { const i = indexOf(a.x, a.y); return i < 0 ? NO_MOVES : moveList[i] }', '  const moves = (a: Tile) => { const i = indexOf(a.x, a.y); return i < 0 ? NO_MOVES : [...moveList[i]] }']] },
  { name: 'a duplicated pool tile (@records built from records-west twice)', check: 'A', patches: [DUP_RECORDS] },
  { name: 'the same duplicated pool tile with the layout\'s own guards removed', check: 'A', patches: [DUP_RECORDS,
    [NEED_TWICE, ''], [NEED_HOMES, '  const setHome = (id: PlaceId, h: string) => { home.set(id, h) }'], [NEED_NOHOME, ''], [NEED_REACH, ''],
    ["    need([...pools.values()].some(p => POOL_DEFS[p.name].tiers.some(tier => tier.some(m => 'tiles' in m && m.tiles === t))), `floorplan pool ${t} is in no pool`)\n", '']] },
  { name: 'a chain cycle (lectern lists itself)', check: 'F', patches: [CYCLE] },
  { name: 'the same chain cycle with the layout\'s own guards removed', check: 'F', patches: [CYCLE,
    ['      need(!seen.has(link), `chain ${kind}: link ${link} repeats (a cycle)`)\n', ''],
    ['      if (seen.has(via)) throw new Error(`places: chain ${kind} repeats ${via}`)\n', ''], [NEED_REACH, '']] },
  { name: 'library reading places with the table seats before the reading ledge', check: 'E1', patches: [
    ["  '@library': { tiers: [[{ points: 'readingLedge' }], [{ points: 'readingTable' }], [{ tiles: 'library' }]], line: false,",
      "  '@library': { tiers: [[{ points: 'readingTable' }], [{ points: 'readingLedge' }], [{ tiles: 'library' }]], line: false,"]] },
  { name: 'the departure hold falls back to the arrival order (board, hold, mail)', check: 'E3', patches: [
    ["    for (const tier of which === 'arrival' ? this.layout.arrivalHold : this.layout.departureHold) {\n", '    for (const tier of this.layout.arrivalHold) {\n']] },
  { name: 'the arrival hold with the mail corner before the hold tiles', check: 'E3', patches: [
    ["export const ARRIVAL_HOLD: readonly (readonly HoldMember[])[] = [[{ points: 'inOutBoard' }], [{ pool: '@hold' }], [{ pool: '@mail' }]]",
      "export const ARRIVAL_HOLD: readonly (readonly HoldMember[])[] = [[{ points: 'inOutBoard' }], [{ pool: '@mail' }], [{ pool: '@hold' }]]"]] },
  // the book: bookings, ledger, dispose
  { name: 'a double booking allowed (both taken-place refusals removed)', check: 'D', patches: [
    ['      if (other !== undefined && other !== owner) throw new Error(`PlaceBook: ${to} is held by ${other}; ${owner} cannot book it`)\n', ''],
    ['    if (other !== undefined && other !== owner) throw new Error(`PlaceBook.${op}: ${place} is held by ${other}; ${owner} cannot book it`)\n', '']] },
  { name: 'a freed place keeps a stale holder entry (the book thinks it taken)', check: 'D', patches: [
    ['    if (old && old.place !== to) { this.#holder.delete(old.place); freed = old.place }', '    if (old && old.place !== to) { if (to !== null) this.#holder.delete(old.place); freed = old.place }']] },
  { name: 'a change not reported (the release record dropped)', check: 'D', patches: [
    ["    if (this.#holding.has(owner)) this.#settle(this.#move(owner, null, null, null, null, 'release'))\n",
      "    if (this.#holding.has(owner)) { this.#settle(this.#move(owner, null, null, null, null, 'release')); this.#out = this.#out.filter(c => c.cause !== 'release') }\n"]] },
  { name: 'a random tie-break (non-deterministic choice)', check: 'D', patches: [
    ['      if (cost < bestCost) { best = id; bestCost = cost }', '      if (cost < bestCost || (cost === bestCost && Math.random() < 0.5)) { best = id; bestCost = cost }']] },
  { name: 'dispose() that does not refuse later bookings', check: 'E4', patches: [[DISPOSED, '    void op\n']] },
  { name: 'the same, against the random invariants', check: 'D', patches: [[DISPOSED, '    void op\n']] },
  // serving: who gets a freed place
  { name: 'a non-FIFO queue (the newest waiter served first)', check: 'D', patches: [[OWN_SERVE, '      const own = this.#waiters.findLast(x => x.kind === station)']] },
  { name: 'the same non-FIFO queue, against the scenarios', check: 'E2', patches: [[OWN_SERVE, '      const own = this.#waiters.findLast(x => x.kind === station)']] },
  { name: 'pool waiters never promoted (Python\'s counting model)', check: 'E2', patches: [[OWN_SERVE, "      const own = this.#waiters.find(x => x.kind === station && this.#holding.get(x.owner)?.role !== 'wait')"]] },
  { name: 'a place freed by assign / hold / reserve / transfer is never offered to the waiters', check: 'D', patches: [[GRANT, '    this.#move(owner, place, role, forKind, null, cause)\n']] },
  { name: 'a station point freed by a worker moving on is not offered to that station\'s waiters (pool tiles still are)', check: 'D', patches: [
    [GRANT, '    { const f = this.#move(owner, place, role, forKind, null, cause); if (f !== null && this.layout.stationOf(f) === null) this.#settle(f) }\n']] },
  { name: 'the shelf point freed at the end of a pull is not offered to a waiting puller', check: 'D', patches: [['      this.#settle(freed)\n    } else {', '      void freed\n    } else {']] },
  { name: 'a queued puller served at a shelf point gets no pull (its item and reading place lost)', check: 'D', patches: [
    ["        return this.#move(own.owner, p, st.shelfRoom !== null && own.fetch ? 'pull' : 'use', station, null, 'served')",
      "        return this.#move(own.owner, p, 'use', station, null, 'served')"]] },
  { name: 'a freed sibling point is offered to its own kind\'s waiters only (newcomers overtake the chain\'s waiters)', check: 'D', patches: [
    ['      const chained = this.#waiters.find(x => this.#siblingOf(x.kind, station))', '      const chained = undefined as Waiter | undefined']] },
  { name: 'the same, against the scenarios', check: 'E2', patches: [
    ['      const chained = this.#waiters.find(x => this.#siblingOf(x.kind, station))', '      const chained = undefined as Waiter | undefined']] },
  { name: 'the line moves a parked worker up as a front-desk waiter', check: 'E2', patches: [
    ["          if (h && h.role === 'wait' && this.waiterOf(h.owner)?.kind === h.forKind) return this.#move(h.owner, p, 'wait', h.forKind, null, 'moveUp')",
      "          if (h && (h.role === 'wait' || h.role === 'parked')) return this.#move(h.owner, p, 'wait', h.forKind, null, 'moveUp')"]] },
  // assign
  { name: 'assign ignores the station tiers (the lounge: an armchair before the sofa)', check: 'E2', patches: [
    ['    for (const tier of st.tiers) {\n      const p = this.#nearestFree(tier, from, owner)\n      if (p !== null) return { place: p, role: ownRole }',
      '    for (const tier of [st.points]) {\n      const p = this.#nearestFree(tier, from, owner)\n      if (p !== null) return { place: p, role: ownRole }']] },
  { name: 'no STAY: a repeated Pre re-runs the policy', check: 'E2', patches: [
    ["      return { how: 'stay', place: held?.place ?? null, via: null, changes: this.#end() }\n", '      void 0\n']] },
  { name: 'a repeated Pre sends a queued owner to the back of the line (STAY only for a booking)', check: 'E2', patches: [
    ['    if (waiting?.kind === kind || (waiting === null && held !== null && held.forKind === kind && STAY_ROLES.has(held.role))) {',
      '    if (waiting === null && held !== null && held.forKind === kind && STAY_ROLES.has(held.role)) {']] },
  { name: 'a worker\'s own place is charged crowding (it moves off its own spot)', check: 'E2', patches: [
    ["      if (p.type === 'point' && id !== mine) {", "      if (p.type === 'point') {"]] },
  { name: 'assign keeps the owner on its old wait list when it books a point (a ghost waiter)', check: 'D', patches: [
    ['    this.#unwait(owner)\n    const target = this.#choose(st, owner, from, fetch)', '    const target = this.#choose(st, owner, from, fetch)']] },
  { name: 'a queue join keeps the old booking unchanged (stale role and kind: no parking)', check: 'D', patches: [
    ["      if (held !== null) this.#move(owner, held.place, 'parked', kind, null, 'assign')     // in place: frees nothing\n", '']] },
  { name: 'the same, against the scenarios', check: 'E2', patches: [
    ["      if (held !== null) this.#move(owner, held.place, 'parked', kind, null, 'assign')     // in place: frees nothing\n", '']] },
  { name: 'assign reports queued before the queue-join step-aside serves the owner', check: 'E1', patches: [
    [QUEUE_JOIN_STEP, "      if (st.shelfRoom !== null) { const r = { how: 'queued' as const, place: null, via: null }; this.#stepAsideAll(st.shelfRoom); return { ...r, changes: this.#end() } }\n"]] },
  { name: 'the same, against the random invariants', check: 'D', patches: [
    [QUEUE_JOIN_STEP, "      if (st.shelfRoom !== null) { const r = { how: 'queued' as const, place: null, via: null }; this.#stepAsideAll(st.shelfRoom); return { ...r, changes: this.#end() } }\n"]] },
  { name: 'assign checks no origin: a bad one throws after the owner left its wait list', check: 'E4', patches: [["    this.#checkOrigin(from, 'assign')\n", '']] },
  // pulls and the step-aside
  { name: 'endPull ignores the pull id (an abandoned pull\'s timer ends the next pull)', check: 'E1', patches: [
    ["    if (!h || h.role !== 'pull' || h.pull !== pull || h.forKind === null) return this.#end()", "    if (!h || h.role !== 'pull' || h.forKind === null) return this.#end()"]] },
  { name: 'the same, against the random invariants', check: 'D', patches: [
    ["    if (!h || h.role !== 'pull' || h.pull !== pull || h.forKind === null) return this.#end()", "    if (!h || h.role !== 'pull' || h.forKind === null) return this.#end()"]] },
  { name: 'the step-aside disabled', check: 'E1', patches: [NO_STEP_ASIDE] },
  { name: 'the step-aside disabled, against the random invariants', check: 'D', patches: [NO_STEP_ASIDE] },
  { name: 'the step-aside only on a freed place, not on a queue join (Python\'s trigger)', check: 'E1', patches: [[QUEUE_JOIN_STEP, '']] },
  { name: 'the step-aside hands the vacated shelf point to the earliest waiter of ANY shelf kind of the room', check: 'E1', patches: [
    [STEP_ASIDE_SERVE, '    const w = this.#waiters.find(x => SHELF_ROOM[x.kind] === room)!']] },
  { name: 'the same, against the random invariants', check: 'D', patches: [[STEP_ASIDE_SERVE, '    const w = this.#waiters.find(x => SHELF_ROOM[x.kind] === room)!']] },
  // holds and raw bookings
  { name: 'hold keeps the owner on its wait list', check: 'D', patches: [
    ["        this.#unwait(owner)\n        this.#grant(owner, p, 'hold', null, 'hold')", "        this.#grant(owner, p, 'hold', null, 'hold')"]] },
  { name: 'transfer keeps the owner on its wait list (a pool waiter is served straight back)', check: 'D', patches: [
    ["    this.#refuseTaken(owner, place, 'transfer')\n    this.#unwait(owner)\n", "    this.#refuseTaken(owner, place, 'transfer')\n"]] },
  { name: 'reserve keeps the owner on its wait list', check: 'D', patches: [
    ["    this.#refuseTaken(owner, place, 'reserve')\n    this.#unwait(owner)\n", "    this.#refuseTaken(owner, place, 'reserve')\n"]] },
  // the classifier's kinds
  { name: 'a roster look (inOutBoard) sends the worker to a station', check: 'G', patches: [
    ["pigeonholes: 'pigeonholes', kanbanBoard: 'kanbanBoard', manualsShelf: 'manualsShelf', inOutBoard: null,",
      "pigeonholes: 'pigeonholes', kanbanBoard: 'kanbanBoard', manualsShelf: 'manualsShelf', inOutBoard: 'frontDesk',"]] },
  { name: 'stationForKind reads the table without an own-key test (a prototype key is a "station")', check: 'G', patches: [
    ['  return kind != null && Object.hasOwn(STATION_FOR_KIND, kind) ? STATION_FOR_KIND[kind] : null', '  return kind != null ? STATION_FOR_KIND[kind] ?? null : null']] },
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
console.log('ALL PASS — places.ts: counts, C3 + grid queries, place-tile rules, invariants, fetch-then-read, queues, holds, dispose, chains, classifier kinds')
