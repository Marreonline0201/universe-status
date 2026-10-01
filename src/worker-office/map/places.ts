// Worker office placement (plan §6.3 = §3): every stopping place of the map, its pool, the overflow chains, and the
// reservation book the observer uses to decide who stands where (plan §4.4–§4.9, §6.4).
//
// Pure TypeScript: no DOM, no rendering, no timers. Built once from the OfficeMap (map/loadMap.ts).
//
//   buildPlaceLayout(map) -> PlaceLayout   immutable: object instances, the 88 interaction points (70 stand + 18 seats,
//                                         all facing N, one-to-one with 88 object tiles), each seat's sitFrom tile, the
//                                         32 place tiles in their §3.2 pools with their poses, the arrival / departure
//                                         hold orders, the overflow chains, the 120 endpoints, and the grid rules the
//                                         Path A planner needs (canStep / moves / walked distance), on numeric tables
//                                         built once, so a planner can call them per node without allocating.
//   new PlaceBook(layout)                 mutable: who holds which place. Every booking goes through it; a place never
//                                         has two owners and an owner never holds two places. Every call returns the
//                                         booking changes it caused, cascades included, in order.
//
// The policy (plan §4.7, "the observer owns places"; the numbers of §3.4 come from replay_fetch_read.py):
//   assign(owner, kind, from)
//     0. STAY (§4.2 "Pre, kind K = the current station"): an owner already booked for this station (its point, a
//        sibling's point, a reading place after the pull, a pool tile) or already waiting for it: nothing changes.
//     1. the station's own points: the nearest free one by walked distance (Path A grid steps; a seat = its sitFrom +
//        one scripted step), plus CROWD_COST tiles per occupied 4-adjacent point of the same kind (never on the place
//        the owner already holds: staying adds no crowding); ties go to the declaration order of floorplan.json.
//        Shelves (fetch-then-read) take their point as a PULL.
//     2. else the overflow chain: siblings (their own points only, never their chains), then one pool, whose tile the
//        worker waits on — it shows its real activity plus "waiting: all N … in use (display limit)".
//     3. else the worker joins the FIFO wait list of that kind and keeps the place it holds ("waits at its own station
//        and keeps its reservation", §4.6), PARKED: re-booked for the kind it now waits for, so its label names that
//        kind, no line or pool cascade moves it, and a pull it was making ends without a reading place.
//     The result is read from the book AFTER the call's cascades: a queue join can be served at once (step-aside).
//   endPull(owner, pull)    fetch-then-read (§4.4): at the end of the pull the worker moves to the nearest free reading
//                           place of the shelf's room (library: the reading ledge, then the table seats, then the aisle
//                           tiles), else it reads at the shelf point (a "fallback reader"). The pull is named by its id
//                           (Holding.pull = the seq of the change that granted it); a stale id is a no-op.
//   step-aside              event-driven, never on a timer: whenever a puller waits for a shelf kind while one of that
//                           kind's fallback readers holds a shelf point and a reading place of the room is free, the
//                           earliest fallback reader moves to that reading place and the puller takes its shelf point.
//                           It is checked when a reading place frees and when a puller joins the wait list.
//   serving (every free)    a freed own point goes to the earliest waiter of that kind (FIFO; a waiter on a pool tile
//                           is promoted from it), else to the earliest waiter whose chain lists that station as a
//                           sibling; a freed pool place goes to the earliest waiter whose chain holds that pool and who
//                           has no tile in it yet. The front-desk queue is a LINE: it fills front first ((16,17), then
//                           (16,16)) and its waiters move up when the front frees (a parked worker does not).
//   hold(owner, which)      arrival hold: in/out-board spots, then the hold tiles, then the mail corner (§4.6, D10);
//                           departure hold: the hold tiles. Null when none is free (the worker stays where it is).
//   reserve / transfer      raw bookings of one named place (snapshot re-sync): role 'reserved', off every wait list
//                           (the observer re-queues with assign); refused, with nothing changed, if another owner holds it.
//   release / dispose       release frees an owner and serves the waiters; dispose releases everyone and refuses every
//                           later booking.
// assign and hold refuse an origin that is neither walkable nor a seat before they change anything.
import type { ObjectKind, OfficeMap, Tile } from './loadMap.ts'

/** A place id: `${objectId}.${n}` for a point, `${pool slug}-${n}` for a place tile. Branded: only the layout makes
 *  one (layout.placeId() checks a string), so an owner id can never be passed where a place goes. */
export type PlaceId = string & { readonly __brand: 'PlaceId' }
/** An owner id: the observer's own key for a worker (its agent id). Any string; every parameter that takes a place
 *  takes the branded PlaceId, so the two cannot be swapped. */
export type OwnerId = string

// ── the policy tables ────────────────────────────────────────────────────────────────────────────────────────────

/** Stations a worker is sent to: the classifier's object kinds (plan §2, §4.3) plus the lounge (sofa + armchairs,
 *  the gated "waiting for its background job" state of §4.6). The in/out board is an arrival hold, not a station; the
 *  server racks are decor whose points are reserved (D8). */
export const STATION_KINDS = [
  'fileCabinet', 'historyShelf', 'lectern', 'bookshelf', 'cardCatalog', 'manualsShelf', 'pcDesk', 'benchTerminal',
  'kanbanBoard', 'meetingTable', 'pigeonholes', 'postShelf', 'copier', 'printer', 'shredder', 'frontDesk', 'lounge',
] as const
export type StationKind = (typeof STATION_KINDS)[number]

/** Every object kind the hook's classifier emits (office/observer/classify.mjs KINDS = its PRECEDENCE list) -> the
 *  station a Pre of that kind sends the worker to, or null: STAY (plan §4.2 "Pre, no kind -> STAY, bubble only").
 *  The in/out board maps to null: plan §4.4 uses it "only as an arrival hold" (per-call unit: none), so a roster look
 *  (ListAgents) is a STAY. §2 row 2 and §4.3 list ListAgents / inOutBoard as if it were a station; that conflict in
 *  the plan is the lead's to settle — this table is the one place to change. */
export const STATION_FOR_KIND: Readonly<Record<string, StationKind | null>> = {
  printer: 'printer', frontDesk: 'frontDesk', meetingTable: 'meetingTable', benchTerminal: 'benchTerminal', pcDesk: 'pcDesk',
  postShelf: 'postShelf', shredder: 'shredder', copier: 'copier', bookshelf: 'bookshelf', cardCatalog: 'cardCatalog',
  pigeonholes: 'pigeonholes', kanbanBoard: 'kanbanBoard', manualsShelf: 'manualsShelf', inOutBoard: null,
  lectern: 'lectern', historyShelf: 'historyShelf', fileCabinet: 'fileCabinet',
}

/** The station for a classifier kind; null = STAY (no kind, the in/out board, or a kind the table does not list —
 *  never a throw from a real event). */
export function stationForKind(kind: string | null | undefined): StationKind | null {
  return kind != null && Object.hasOwn(STATION_FOR_KIND, kind) ? STATION_FOR_KIND[kind] : null
}

export type Room = 'records' | 'library'

/** The fetch-then-read shelves and the room whose reading places they use (replay_fetch_read.py SHELF_ROOM). */
export const SHELF_ROOM: Readonly<Partial<Record<StationKind, Room>>> = {
  historyShelf: 'records', bookshelf: 'library', cardCatalog: 'library', manualsShelf: 'library',
}

/** The reading-place pool of each room. */
export const READING_POOL: Readonly<Record<Room, PoolName>> = { records: '@records', library: '@library' }

/** A station's own points, in tiers (the lounge: the sofa first, then the armchairs, §4.6). */
export const STATION_POINTS: Readonly<Record<StationKind, readonly (readonly ObjectKind[])[]>> = {
  fileCabinet: [['fileCabinet']], historyShelf: [['historyShelf']], lectern: [['lectern']], bookshelf: [['bookshelf']],
  cardCatalog: [['cardCatalog']], manualsShelf: [['manualsShelf']], pcDesk: [['pcDesk']], benchTerminal: [['benchTerminal']],
  kanbanBoard: [['kanbanBoard']], meetingTable: [['meetingTable']], pigeonholes: [['pigeonholes']], postShelf: [['postShelf']],
  copier: [['copier']], printer: [['printer']], shredder: [['shredder']], frontDesk: [['frontDesk']],
  lounge: [['sofaN'], ['armchairN']],
}

/** Overflow chains = replay_fetch_read.py CHAIN, which is place_s3.py:467-473 for every non-shelf kind. A link is a
 *  sibling station (its own points only, never its chain: chains are flat, so resolving one always terminates) or a
 *  pool, which comes last. The shelves have no chain: fetch-then-read queues a puller (§3.4); their step-3 chains
 *  (reading ledge > reading table > library) became the reading-place order of endPull. A link that names no station
 *  and no pool is a type error. */
export const CHAINS: Readonly<Record<StationKind, readonly ChainLinkName[]>> = {
  fileCabinet: ['@records'],
  historyShelf: [], bookshelf: [], cardCatalog: [], manualsShelf: [],
  lectern: ['historyShelf', '@records'],
  pcDesk: ['benchTerminal', '@desks'],
  benchTerminal: ['pcDesk', '@bench'],
  kanbanBoard: ['@meeting'],
  meetingTable: ['kanbanBoard', '@meeting'],
  pigeonholes: ['postShelf', '@mail'],
  postShelf: ['pigeonholes', '@mail'],
  copier: ['printer', '@mail'],
  printer: ['copier', '@mail'],
  shredder: ['@mail'],
  frontDesk: ['@frontq'],
  lounge: ['@kitchen'],
}

/** What a pool tier is made of: the interaction points of an object kind, or the place tiles of a floorplan pool. */
export type PoolMember = { readonly points: ObjectKind } | { readonly tiles: string }
/** A hold-order tier may also take every place of a pool. */
export type HoldMember = PoolMember | { readonly pool: PoolName }

export interface PoolDef {
  /** Tiers in order of preference; within a tier the nearest free member wins (a LINE: the first free one). */
  readonly tiers: readonly (readonly PoolMember[])[]
  /** A FIFO line: filled front first, moving up when the front frees (the front-desk queue, §3.2 / §4.6). */
  readonly line: boolean
  readonly use: string
}

/** The pools of plan §3.2 under replay_fetch_read.py's names. Every point and place tile has exactly one home: a
 *  station's own points, one of these pools, the in/out-board tier of the arrival hold, or the reserved rack points. */
const POOL_TABLE = {
  '@records': { tiers: [[{ tiles: 'records-west' }, { tiles: 'records-east' }]], line: false,
    use: 'records reading places (fetch-then-read) + fileCabinet / lectern overflow wait' },
  '@library': { tiers: [[{ points: 'readingLedge' }], [{ points: 'readingTable' }], [{ tiles: 'library' }]], line: false,
    use: 'library reading places: the reading ledge, then the reading-table seats, then the aisle tiles' },
  '@desks': { tiers: [[{ tiles: 'work-desks' }]], line: false, use: 'pcDesk overflow wait' },
  '@bench': { tiers: [[{ tiles: 'work-bench' }]], line: false, use: 'benchTerminal overflow wait' },
  '@meeting': { tiers: [[{ tiles: 'meeting' }]], line: false, use: 'meetingTable / kanbanBoard overflow wait' },
  '@mail': { tiers: [[{ tiles: 'mail-corner' }]], line: false, use: 'mail-bank overflow wait + arrival hold (third choice)' },
  '@frontq': { tiers: [[{ tiles: 'front-desk queue' }]], line: true, use: 'front-desk queue (FIFO line)' },
  '@hold': { tiers: [[{ tiles: 'hold' }]], line: false, use: 'arrival hold (second choice) + departure hold after the hand-in' },
  '@kitchen': { tiers: [[{ points: 'fridge' }, { points: 'sink' }, { points: 'espressoMachine' }, { points: 'waterCooler' }]], line: false,
    use: 'lounge overflow: standing WAITING (pager), never touching the appliance' },
  '@servers': { tiers: [[{ tiles: 'servers' }]], line: false,
    use: 'rack overflow wait: unused (no tool maps to the racks in the final tool map, D8)' },
} as const satisfies Readonly<Record<`@${string}`, PoolDef>>
/** The pools' names: the only pools a chain, a hold order or a room's reading places can name. */
export type PoolName = keyof typeof POOL_TABLE
export const POOL_DEFS: Readonly<Record<PoolName, PoolDef>> = POOL_TABLE
/** A chain link: a sibling station or a pool. */
export type ChainLinkName = StationKind | PoolName
const isPoolName = (link: ChainLinkName): link is PoolName => link.startsWith('@')

/** Arrival hold (§4.6 step 6, D10 = 10 places): the in/out-board spots (flip the magnet), then the hold tiles
 *  (19..22,17), then the mail corner. */
export const ARRIVAL_HOLD: readonly (readonly HoldMember[])[] = [[{ points: 'inOutBoard' }], [{ pool: '@hold' }], [{ pool: '@mail' }]]
/** Departure hold after the hand-in (§4.6 "Finishing"): the hold tiles only. OPEN (a plan gap, for the owner / lead):
 *  the arrival hold's second tier is the same 4 tiles, so in an arrival burst hold() returns null for a finisher, who
 *  then keeps its desk spot until its Stop (p50 10.7 s, cap 90 s) while the mail corner may be free. The plan does
 *  not say; the decision (e.g. fall back to the mail corner, or arrivals never take the last hold tile) goes here. */
export const DEPARTURE_HOLD: readonly (readonly HoldMember[])[] = [[{ pool: '@hold' }]]
/** Points no policy ever assigns (plan §2 row 21: rack points reserved; D8). */
export const RESERVED_POINT_KINDS: readonly ObjectKind[] = ['serverRack']
/** Virtual cost, in tiles, per occupied 4-adjacent point of the same kind (plan §4.7 [E]). */
export const CROWD_COST = 1.5

// ── the layout ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlacePoint {
  /** `${objectId}.${n}`, n = 1-based position in the object's interaction list. */
  readonly id: PlaceId
  readonly type: 'point'
  readonly x: number
  readonly y: number
  readonly objectId: string
  readonly kind: ObjectKind
  readonly how: 'stand' | 'sit'
  /** A seat is entered ONLY from this tile: route to it, then one scripted step (§3.3 C3). Null for a stand point. */
  readonly sitFrom: Tile | null
  /** Where the walk ends: sitFrom for a seat, the point itself otherwise. */
  readonly approach: Tile
  /** The one object tile this point serves (the tile N of a stand point or of a chair; the sofa / armchair seat itself). */
  readonly useTile: Tile
  /** For a seat: the object the worker sits on (task chair, wooden chair, sofa, armchair). */
  readonly seatObjectId: string | null
  readonly facing: string
  readonly pose: string
  /** Never assigned (rack points). */
  readonly reserved: boolean
  /** Declaration order in floorplan.json (the stable tie-break). */
  readonly order: number
}

export interface PlaceTile {
  /** `${pool slug}-${n}`, n = 1-based position in the pool's declaration order. */
  readonly id: PlaceId
  readonly type: 'tile'
  readonly x: number
  readonly y: number
  /** The floorplan pool name (records-west, front-desk queue, hold, ...). */
  readonly pool: string
  readonly role: string
  readonly facing: string
  readonly pose: string
  readonly order: number
}

/** An endpoint (plan §3.3): any place a worker stops at — an interaction point or a place tile. (OfficeMap.places are
 *  only the 32 floorplan place tiles; PlaceLayout.endpoints are all 120.) */
export type Endpoint = PlacePoint | PlaceTile

export interface Instance {
  readonly id: string
  readonly kind: ObjectKind
  readonly cls: string
  readonly functional: boolean
  readonly tiles: readonly Tile[]
  /** Its interaction points. */
  readonly points: readonly PlaceId[]
  /** For a chair: the point that sits on it (desk / table seat), else null. */
  readonly seatOfPoint: PlaceId | null
}

export interface Pool {
  readonly name: PoolName
  readonly tiers: readonly (readonly PlaceId[])[]
  readonly line: boolean
  readonly use: string
  /** All members, tier by tier. */
  readonly members: readonly PlaceId[]
}

export interface Station {
  readonly kind: StationKind
  readonly tiers: readonly (readonly PlaceId[])[]
  readonly points: readonly PlaceId[]
  readonly chain: readonly ChainLink[]
  readonly shelfRoom: Room | null
}

export type ChainLink = { readonly type: 'sibling'; readonly kind: StationKind } | { readonly type: 'pool'; readonly pool: PoolName }

export interface PlaceLayout {
  readonly map: OfficeMap
  readonly instances: readonly Instance[]
  readonly points: readonly PlacePoint[]
  readonly tiles: readonly PlaceTile[]
  /** The 120 endpoints of plan §3.3 (88 points + 28 wait / queue tiles + 4 hold tiles): every place a worker stops. */
  readonly endpoints: readonly Endpoint[]
  readonly pools: ReadonlyMap<PoolName, Pool>
  readonly stations: ReadonlyMap<StationKind, Station>
  readonly arrivalHold: readonly (readonly PlaceId[])[]
  readonly departureHold: readonly (readonly PlaceId[])[]
  readonly crowdNeighbours: ReadonlyMap<PlaceId, readonly PlaceId[]>
  /** A string as a place id (a snapshot, a test); throws if no endpoint has that id. */
  placeId(id: string): PlaceId
  place(id: PlaceId): Endpoint
  placeAt(x: number, y: number): Endpoint | null
  seatAt(x: number, y: number): PlacePoint | null
  /** The station whose own points include this place, else null. */
  stationOf(id: PlaceId): StationKind | null
  /** The pool this place belongs to, else null. */
  poolOf(id: PlaceId): Pool | null
  /** The room whose reading pool holds this place, else null. */
  readingRoomOf(id: PlaceId): Room | null
  /** One grid move (Path A): 4-adjacent; a seat is entered and left ONLY through its own sitFrom tile. */
  canStep(from: Tile, to: Tile): boolean
  /** The legal moves from a tile, in BFS order (0,1),(0,-1),(1,0),(-1,0): one frozen list per tile, built once. */
  moves(from: Tile): readonly Tile[]
  /** Walked grid steps from a tile (a seat: its scripted step to sitFrom first) to a place (a seat: its sitFrom, then
   *  one step); Infinity if unreachable. */
  distance(from: Tile, to: PlaceId): number
  /** A station's overflow order: own points, each sibling's own points, the pool. Finite and repetition-free. */
  expandChain(kind: StationKind): readonly { readonly level: 'own' | 'sibling' | 'pool'; readonly via: string; readonly places: readonly PlaceId[] }[]
}

const tkey = (x: number, y: number) => `${x},${y}`
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

/** Build the layout. Throws one Error listing every inconsistency between the policy tables and the map. */
export function buildPlaceLayout(map: OfficeMap): PlaceLayout {
  const problems: string[] = []
  const need = (cond: boolean, msg: string) => { if (!cond) problems.push(msg) }

  // points: one per interaction entry, in object order
  const points: PlacePoint[] = []
  const instances: Instance[] = []
  let order = 0
  for (const o of map.objects) {
    const ids: PlaceId[] = []
    o.points.forEach((p, i) => {
      const inObj = (x: number, y: number) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h
      const useTile = inObj(p.x, p.y) ? { x: p.x, y: p.y } : inObj(p.x, p.y - 1) ? { x: p.x, y: p.y - 1 } : null
      need(useTile !== null, `${o.id} point (${p.x},${p.y}) serves no tile of its object`)
      const seat = p.how === 'sit' ? map.objectAt(p.x, p.y) : null
      need(p.how === 'stand' || seat !== null, `${o.id} seat (${p.x},${p.y}) is on no object`)
      const id = `${o.id}.${i + 1}` as PlaceId
      ids.push(id)
      points.push({
        id, type: 'point', x: p.x, y: p.y, objectId: o.id, kind: o.kind, how: p.how, sitFrom: p.sitFrom,
        approach: p.sitFrom ?? { x: p.x, y: p.y }, useTile: useTile ?? { x: p.x, y: p.y }, seatObjectId: seat?.id ?? null,
        facing: p.facing, pose: p.pose, reserved: p.reserved || RESERVED_POINT_KINDS.includes(o.kind), order: order++,
      })
    })
    const tiles: Tile[] = []
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) tiles.push({ x, y })
    instances.push({ id: o.id, kind: o.kind, cls: o.cls, functional: o.functional, tiles, points: ids, seatOfPoint: null })
  }
  const seatOf = new Map(points.filter(p => p.seatObjectId !== null && p.seatObjectId !== p.objectId).map(p => [p.seatObjectId!, p.id]))
  const inst = instances.map(i => ({ ...i, seatOfPoint: seatOf.get(i.id) ?? null }))
  const useTiles = new Set(points.map(p => tkey(p.useTile.x, p.useTile.y)))
  need(useTiles.size === points.length, 'two interaction points serve the same object tile')

  // place tiles, in declaration order; ids by pool
  const perPool = new Map<string, number>()
  const tiles: PlaceTile[] = map.places.map(p => {
    const n = (perPool.get(p.pool) ?? 0) + 1
    perPool.set(p.pool, n)
    return { id: `${slug(p.pool)}-${n}` as PlaceId, type: 'tile', x: p.x, y: p.y, pool: p.pool, role: p.role, facing: p.facing, pose: p.pose, order: order++ }
  })
  const endpoints: Endpoint[] = [...points, ...tiles]
  const byId = new Map<string, Endpoint>()
  const byTile = new Map<string, Endpoint>()
  for (const p of endpoints) {
    need(!byId.has(p.id), `place id ${p.id} is not unique`)
    need(!byTile.has(tkey(p.x, p.y)), `two places share the tile (${p.x},${p.y})`)
    byId.set(p.id, p); byTile.set(tkey(p.x, p.y), p)
  }

  // members -> place ids
  const pointsOfKind = (k: ObjectKind) => points.filter(p => p.kind === k).map(p => p.id)
  const tilesOfPool = (n: string) => tiles.filter(t => t.pool === n).map(t => t.id)
  const pools = new Map<PoolName, Pool>()
  const resolve = (m: HoldMember, where: string): PlaceId[] => {
    let ids: PlaceId[]
    if ('points' in m) ids = pointsOfKind(m.points)
    else if ('tiles' in m) ids = tilesOfPool(m.tiles)
    else ids = pools.get(m.pool)?.members.slice() ?? []
    need(ids.length > 0, `${where}: ${JSON.stringify(m)} matches no place`)
    return ids
  }
  for (const [name, def] of Object.entries(POOL_DEFS) as [PoolName, PoolDef][]) {
    need(name.startsWith('@'), `pool ${name} must start with @`)
    for (const tier of def.tiers) for (const m of tier) need(!('pool' in m), `pool ${name} is built from another pool`)
    const tiers = def.tiers.map(t => t.flatMap(m => resolve(m, `pool ${name}`)))
    const members = tiers.flat()
    need(new Set(members).size === members.length, `pool ${name} lists a place twice`)
    pools.set(name, { name, tiers, line: def.line, use: def.use, members })
  }
  const holdOrder = (tiers: readonly (readonly HoldMember[])[], what: string) => {
    const t = tiers.map(tier => tier.flatMap(m => resolve(m, what)))
    need(new Set(t.flat()).size === t.flat().length, `${what} lists a place twice`)
    return t
  }
  const arrivalHold = holdOrder(ARRIVAL_HOLD, 'arrival hold')
  const departureHold = holdOrder(DEPARTURE_HOLD, 'departure hold')

  // stations and their chains
  const stations = new Map<StationKind, Station>()
  for (const kind of STATION_KINDS) {
    const tiers = STATION_POINTS[kind].map(t => t.flatMap(k => resolve({ points: k }, `station ${kind}`)))
    const chain: ChainLink[] = []
    const seen = new Set<string>([kind])
    CHAINS[kind].forEach((link, i) => {
      need(!seen.has(link), `chain ${kind}: link ${link} repeats (a cycle)`)
      seen.add(link)
      if (isPoolName(link)) {
        need(pools.has(link), `chain ${kind}: unknown pool ${link}`)
        need(i === CHAINS[kind].length - 1, `chain ${kind}: pool ${link} is not the last link`)
        chain.push({ type: 'pool', pool: link })
      } else {
        need((STATION_KINDS as readonly string[]).includes(link), `chain ${kind}: unknown station ${link}`)
        chain.push({ type: 'sibling', kind: link })
      }
    })
    const room = SHELF_ROOM[kind] ?? null
    need(room === null || chain.length === 0, `chain ${kind}: a fetch-then-read shelf has no chain`)
    stations.set(kind, { kind, tiers, points: tiers.flat(), chain, shelfRoom: room })
  }
  for (const room of Object.values(READING_POOL)) need(pools.has(room), `reading pool ${room} is missing`)

  // every place has exactly one home
  const home = new Map<PlaceId, string>()
  const setHome = (id: PlaceId, h: string) => { need(!home.has(id), `${id} has two homes (${home.get(id)}, ${h})`); home.set(id, h) }
  for (const s of stations.values()) for (const id of s.points) setHome(id, `station ${s.kind}`)
  for (const p of pools.values()) for (const id of p.members) setHome(id, `pool ${p.name}`)
  for (const id of arrivalHold[0]) if (!home.has(id)) setHome(id, 'arrival hold (in/out board)')
  for (const p of points) if (p.reserved) setHome(p.id, 'reserved')
  for (const p of endpoints) need(home.has(p.id), `${p.id} at (${p.x},${p.y}) has no home (no station, pool or hold uses it)`)
  for (const t of new Set(map.places.map(p => p.pool))) {
    need([...pools.values()].some(p => POOL_DEFS[p.name].tiers.some(tier => tier.some(m => 'tiles' in m && m.tiles === t))), `floorplan pool ${t} is in no pool`)
  }

  const placeOf = (id: PlaceId) => {
    const p = byId.get(id)
    if (!p) throw new Error(`places: unknown place ${id}`)
    return p
  }
  const stationByPlace = new Map<PlaceId, StationKind>()
  for (const s of stations.values()) for (const id of s.points) stationByPlace.set(id, s.kind)
  const poolByPlace = new Map<PlaceId, Pool>()
  for (const p of pools.values()) for (const id of p.members) poolByPlace.set(id, p)
  const roomByPlace = new Map<PlaceId, Room>()
  for (const [room, pool] of Object.entries(READING_POOL) as [Room, PoolName][]) for (const id of pools.get(pool)?.members ?? []) roomByPlace.set(id, room)

  // crowding neighbours: points of the same object kind on a 4-adjacent tile
  const crowdNeighbours = new Map<PlaceId, PlaceId[]>()
  for (const p of points) {
    crowdNeighbours.set(p.id, points.filter(q => q !== p && q.kind === p.kind && Math.abs(q.x - p.x) + Math.abs(q.y - p.y) === 1).map(q => q.id))
  }

  // grid rules (Path A): walkable tiles + seats, a seat only through its own sitFrom. Numeric tables built once: a tile
  // is the index y * W + x; -1 = off the grid or not an integer tile (never walkable, never a seat, no move).
  const W = map.width, H = map.height, N = W * H
  const indexOf = (x: number, y: number) => (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1)
  const walk = new Uint8Array(N)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) walk[y * W + x] = map.walkable(x, y) ? 1 : 0
  const seatList = points.filter(p => p.how === 'sit')
  const seatIdx = new Int16Array(N).fill(-1)
  const sitFromIdx = new Int32Array(seatList.length).fill(-1)
  seatList.forEach((s, k) => {
    need(s.sitFrom !== null && Math.abs(s.sitFrom.x - s.x) + Math.abs(s.sitFrom.y - s.y) === 1 && map.walkable(s.sitFrom.x, s.sitFrom.y),
      `seat ${s.id}: sitFrom is not an adjacent walkable tile`)
    need(!map.walkable(s.x, s.y), `seat ${s.id} is walkable (seats are solid)`)
    const i = indexOf(s.x, s.y)
    if (i >= 0) seatIdx[i] = k
    if (s.sitFrom) sitFromIdx[k] = indexOf(s.sitFrom.x, s.sitFrom.y)
  })
  const seatAt = (x: number, y: number) => { const i = indexOf(x, y); return i < 0 || seatIdx[i] < 0 ? null : seatList[seatIdx[i]] }
  /** One step between two 4-adjacent tile indices. */
  const stepI = (ia: number, ib: number) => {
    const sa = seatIdx[ia], sb = seatIdx[ib]
    if (sa >= 0 && sb >= 0) return false
    if (sb >= 0) return sitFromIdx[sb] === ia && walk[ia] === 1
    if (sa >= 0) return sitFromIdx[sa] === ib && walk[ib] === 1
    return walk[ia] === 1 && walk[ib] === 1
  }
  const canStep = (a: Tile, b: Tile) => {
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return false
    const ia = indexOf(a.x, a.y), ib = indexOf(b.x, b.y)
    return ia >= 0 && ib >= 0 && stepI(ia, ib)
  }
  const NO_MOVES: readonly Tile[] = Object.freeze([])
  const moveList: (readonly Tile[])[] = new Array<readonly Tile[]>(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const out: Tile[] = []
      for (const [dx, dy] of DIRS) {
        const j = indexOf(x + dx, y + dy)
        if (j >= 0 && stepI(y * W + x, j)) out.push(Object.freeze({ x: x + dx, y: y + dy }))
      }
      moveList[y * W + x] = out.length > 0 ? Object.freeze(out) : NO_MOVES
    }
  }
  const moves = (a: Tile) => { const i = indexOf(a.x, a.y); return i < 0 ? NO_MOVES : moveList[i] }
  // BFS fields over walkable tiles, one per approach tile, keyed by its index (seats are never passed through; moves
  // are symmetric). A walkable tile is never on the border, so its 4 neighbours are on the grid.
  const STEPS = Int32Array.of(W, -W, 1, -1)
  const fields: (Int32Array | undefined)[] = new Array<Int32Array | undefined>(N)
  const field = (ai: number) => {
    let f = fields[ai]
    if (f) return f
    f = new Int32Array(N).fill(-1)
    if (walk[ai] === 1) {
      f[ai] = 0
      const q = new Int32Array(N)
      let head = 0, tail = 0
      q[tail++] = ai
      while (head < tail) {
        const c = q[head++]
        for (let s = 0; s < 4; s++) {
          const n = c + STEPS[s]
          if (walk[n] !== 1 || f[n] >= 0) continue
          f[n] = f[c] + 1
          q[tail++] = n
        }
      }
    }
    fields[ai] = f
    return f
  }
  const approachIdx = new Map<PlaceId, number>()
  for (const p of endpoints) { const a = p.type === 'point' ? p.approach : p; approachIdx.set(p.id, indexOf(a.x, a.y)) }
  const distance = (from: Tile, to: PlaceId) => {
    const p = placeOf(to)
    if (from.x === p.x && from.y === p.y) return 0
    const fi = indexOf(from.x, from.y)
    const fs = fi < 0 ? -1 : seatIdx[fi]
    if (fs < 0 && (fi < 0 || walk[fi] !== 1)) throw new Error(`places: distance from a solid tile (${from.x},${from.y})`)
    const start = fs >= 0 ? sitFromIdx[fs] : fi
    const d = field(approachIdx.get(to)!)[start]
    if (d < 0) return Infinity
    return d + (fs >= 0 ? 1 : 0) + (p.type === 'point' && p.how === 'sit' ? 1 : 0)
  }
  const placeByIdx: (Endpoint | undefined)[] = new Array<Endpoint | undefined>(N)
  for (const p of endpoints) { const i = indexOf(p.x, p.y); if (i >= 0) placeByIdx[i] = p }

  const expandChain = (kind: StationKind) => {
    const st = stations.get(kind)
    if (!st) throw new Error(`places: unknown station ${kind}`)
    const out: { level: 'own' | 'sibling' | 'pool'; via: string; places: PlaceId[] }[] = [{ level: 'own', via: kind, places: [...st.points] }]
    const seen = new Set<string>([kind])
    for (const link of st.chain) {
      const via = link.type === 'pool' ? link.pool : link.kind
      if (seen.has(via)) throw new Error(`places: chain ${kind} repeats ${via}`)
      seen.add(via)
      out.push(link.type === 'pool'
        ? { level: 'pool', via, places: [...pools.get(link.pool)!.members] }
        : { level: 'sibling', via, places: [...stations.get(link.kind)!.points] })
    }
    return out
  }
  for (const kind of STATION_KINDS) {
    if (!stations.has(kind)) continue
    try {
      const all = expandChain(kind).flatMap(l => l.places)
      need(new Set(all).size === all.length, `chain ${kind} reaches a place twice`)
    } catch (e) { problems.push(String(e)) }
  }

  if (problems.length > 0) throw new Error(`places: inconsistent layout (${problems.length}):\n- ${problems.join('\n- ')}`)

  return {
    map, instances: inst, points, tiles, endpoints, pools, stations, arrivalHold, departureHold, crowdNeighbours,
    placeId: id => placeOf(id as PlaceId).id,
    place: placeOf,
    placeAt: (x, y) => { const i = indexOf(x, y); return i < 0 ? null : placeByIdx[i] ?? null },
    seatAt,
    stationOf: id => stationByPlace.get(id) ?? null,
    poolOf: id => poolByPlace.get(id) ?? null,
    readingRoomOf: id => roomByPlace.get(id) ?? null,
    canStep, moves, distance, expandChain,
  }
}

// ── the reservation book ─────────────────────────────────────────────────────────────────────────────────────────

/** use: own point; pull: shelf point during the pull; read: reading place after a pull; readAtShelf: reading at the
 *  shelf point (no reading place was free); sibling: a sibling's point; wait: a pool tile (still waiting, FIFO);
 *  parked: the place it held when it joined a wait list (kept, re-booked for the kind it waits for; nothing moves it
 *  until it is served); hold: arrival / departure hold; reserved: a raw reserve() / transfer() booking. */
export type Role = 'use' | 'pull' | 'read' | 'readAtShelf' | 'sibling' | 'wait' | 'parked' | 'hold' | 'reserved'
export type Cause = 'assign' | 'pullDone' | 'stepAside' | 'served' | 'moveUp' | 'hold' | 'reserve' | 'transfer' | 'release' | 'dispose'

/** The roles of a booking for its station (forKind): a Pre of that same kind is a STAY (plan §4.2). */
const STAY_ROLES: ReadonlySet<Role> = new Set<Role>(['use', 'pull', 'read', 'readAtShelf', 'sibling', 'wait', 'parked'])

export interface Holding {
  readonly owner: OwnerId
  readonly place: PlaceId
  readonly role: Role
  /** The station the owner was sent to (parked: the station it waits for; transfer keeps it); null for holds and
   *  reserve(). */
  readonly forKind: StationKind | null
  /** Fetch-then-read: the shelf point the item came from (the carried state's key, §4.4). */
  readonly pulledFrom: PlaceId | null
  /** The pull in progress (role 'pull'): its id = the seq of the change that granted it, which endPull names; else
   *  null. */
  readonly pull: number | null
}

export interface Change {
  /** Book-wide order of changes. A change that grants a pull is that pull's id. */
  readonly seq: number
  readonly owner: OwnerId
  /** The place held before (null: none). Equal to `to` for a booking changed in place (readAtShelf, parked). */
  readonly from: PlaceId | null
  /** The place held after (null: none). */
  readonly to: PlaceId | null
  readonly role: Role | null
  readonly forKind: StationKind | null
  readonly cause: Cause
}

export interface Waiter {
  readonly owner: OwnerId
  readonly kind: StationKind
  /** Join order (FIFO). */
  readonly seq: number
  /** Shelves: whether the point is taken as a pull (fetch-then-read) or as a plain use (a glance, a stash). */
  readonly fetch: boolean
}

export interface AssignResult {
  /** Where the owner stands for this station once the call's cascades are done. own: the station's point; sibling: a
   *  sibling's point; pool: a pool place, still waiting (FIFO); queued: on the wait list (keeping its place, parked);
   *  stay: it was already booked for this station or waiting for it (plan §4.2 STAY), nothing changed. */
  readonly how: 'own' | 'sibling' | 'pool' | 'queued' | 'stay'
  /** own / sibling / pool: that place; stay: the place it holds (null if none); queued: null. */
  readonly place: PlaceId | null
  /** The sibling station or the pool, else null. */
  readonly via: StationKind | PoolName | null
  readonly changes: readonly Change[]
}

export interface HoldResult {
  readonly place: PlaceId | null
  readonly changes: readonly Change[]
}

interface Reader { readonly owner: OwnerId; readonly kind: StationKind; readonly seq: number }

export class PlaceBook {
  readonly layout: PlaceLayout
  readonly crowdCost: number
  #holder = new Map<PlaceId, OwnerId>()
  #holding = new Map<OwnerId, Holding>()
  #waiters: Waiter[] = []
  #readers: Reader[] = []
  #seq = 0
  #changeSeq = 0
  #disposed = false
  #out: Change[] = []

  constructor(layout: PlaceLayout, opts: { crowdCost?: number } = {}) {
    this.layout = layout
    this.crowdCost = opts.crowdCost ?? CROWD_COST
  }

  get disposed(): boolean { return this.#disposed }

  // ── queries ──
  holding(owner: OwnerId): Holding | null { return this.#holding.get(owner) ?? null }
  holdings(): readonly Holding[] { return [...this.#holding.values()] }
  ownerOf(place: PlaceId): OwnerId | null { this.layout.place(place); return this.#holder.get(place) ?? null }
  isFree(place: PlaceId): boolean { return this.ownerOf(place) === null }
  heldCount(places: Iterable<PlaceId>): number { let n = 0; for (const p of places) if (this.#holder.has(p)) n++; return n }
  /** Waiters in FIFO order (all kinds, or one). */
  waiters(kind?: StationKind): readonly Waiter[] { return this.#waiters.filter(w => kind === undefined || w.kind === kind) }
  waiterOf(owner: OwnerId): Waiter | null { return this.#waiters.find(w => w.owner === owner) ?? null }
  /** Owners reading at a shelf point because no reading place was free, earliest first. */
  fallbackReaders(kind?: StationKind): readonly OwnerId[] {
    return this.#readers.filter(r => kind === undefined || r.kind === kind).map(r => r.owner)
  }

  // ── policy ──
  /** Send an owner to a station (plan §4.7; the steps are in the file header). A STAY when it is already booked for
   *  this station or waits for it; otherwise it leaves any wait list it was on first. */
  assign(owner: OwnerId, kind: StationKind, from: Tile, opts: { fetch?: boolean } = {}): AssignResult {
    this.#begin('assign')
    const st = this.layout.stations.get(kind)
    if (!st) throw new Error(`PlaceBook.assign: ${kind} is not a station`)
    this.#checkOrigin(from, 'assign')
    const fetch = opts.fetch ?? true
    const held = this.#holding.get(owner) ?? null
    const waiting = this.waiterOf(owner)
    if (waiting?.kind === kind || (waiting === null && held !== null && held.forKind === kind && STAY_ROLES.has(held.role))) {
      return { how: 'stay', place: held?.place ?? null, via: null, changes: this.#end() }
    }
    this.#unwait(owner)
    const target = this.#choose(st, owner, from, fetch)
    if (target !== null) {
      if (target.role === 'wait') this.#wait(owner, kind, fetch)
      this.#grant(owner, target.place, target.role, kind, 'assign')
    } else {
      this.#wait(owner, kind, fetch)
      if (held !== null) this.#move(owner, held.place, 'parked', kind, null, 'assign')     // in place: frees nothing
      if (st.shelfRoom !== null) this.#stepAsideAll(st.shelfRoom)
    }
    return { ...this.#outcome(owner, kind), changes: this.#end() }
  }

  /** Fetch-then-read, at the end of the pull named by `pull` (Holding.pull): the nearest free reading place of the
   *  shelf's room, else read at the shelf point. A no-op unless that pull is still in progress (the owner may have
   *  been sent elsewhere, or started another pull, since). */
  endPull(owner: OwnerId, pull: number): readonly Change[] {
    this.#begin('endPull')
    const h = this.#holding.get(owner)
    if (!h || h.role !== 'pull' || h.pull !== pull || h.forKind === null) return this.#end()
    const room = SHELF_ROOM[h.forKind]!
    const shelf = this.layout.place(h.place)
    const target = this.#pickInPool(this.layout.pools.get(READING_POOL[room])!, shelf, owner)
    if (target !== null) {
      const freed = this.#move(owner, target, 'read', h.forKind, h.place, 'pullDone')
      this.#settle(freed)
    } else {
      this.#move(owner, h.place, 'readAtShelf', h.forKind, h.place, 'pullDone')
      this.#readers.push({ owner, kind: h.forKind, seq: this.#seq++ })
    }
    return this.#end()
  }

  /** Arrival hold (in/out-board spots, hold tiles, mail corner) or departure hold (hold tiles). On success the owner
   *  leaves any wait list. Null place when none is free: nothing changes (the owner keeps what it holds and stays on
   *  any wait list). */
  hold(owner: OwnerId, which: 'arrival' | 'departure', from: Tile): HoldResult {
    this.#begin('hold')
    this.#checkOrigin(from, 'hold')
    for (const tier of which === 'arrival' ? this.layout.arrivalHold : this.layout.departureHold) {
      const p = this.#nearestFree(tier, from, owner)
      if (p !== null) {
        this.#unwait(owner)
        this.#grant(owner, p, 'hold', null, 'hold')
        return { place: p, changes: this.#end() }
      }
    }
    return { place: null, changes: this.#end() }
  }

  /** Run the step-aside for a room until nothing is left to do (it also runs on its own on every free and every
   *  shelf queue join; calling it is never needed for correctness). */
  stepAside(room: Room): readonly Change[] {
    this.#begin('stepAside')
    this.#stepAsideAll(room)
    return this.#end()
  }

  // ── primitives ──
  /** Book one named free place for an owner that holds nothing (role 'reserved'; a raw booking: the owner leaves any
   *  wait list). Refused (throws, nothing changed) if another owner holds it. */
  reserve(owner: OwnerId, place: PlaceId): readonly Change[] {
    this.#begin('reserve')
    if (this.#holding.has(owner)) throw new Error(`PlaceBook.reserve: ${owner} already holds ${this.#holding.get(owner)!.place}; use transfer`)
    this.#refuseTaken(owner, place, 'reserve')
    this.#unwait(owner)
    this.#grant(owner, place, 'reserved', null, 'reserve')
    return this.#end()
  }

  /** Move an owner's booking to one named free place (role 'reserved', its station kept for the label; a raw booking:
   *  the owner leaves any wait list and is never served away from it — re-queue with assign). Refused (throws,
   *  nothing changed) if another owner holds it. */
  transfer(owner: OwnerId, place: PlaceId): readonly Change[] {
    this.#begin('transfer')
    const h = this.#holding.get(owner)
    if (!h) throw new Error(`PlaceBook.transfer: ${owner} holds nothing; use reserve`)
    this.#refuseTaken(owner, place, 'transfer')
    this.#unwait(owner)
    this.#grant(owner, place, 'reserved', h.forKind, 'transfer')
    return this.#end()
  }

  /** Free everything the owner holds, take it off every list, serve the waiters. */
  release(owner: OwnerId): readonly Change[] {
    if (this.#disposed) return []
    this.#begin('release')
    this.#unwait(owner)
    if (this.#holding.has(owner)) this.#settle(this.#move(owner, null, null, null, null, 'release'))
    return this.#end()
  }

  /** Release everyone; every later booking is refused. */
  dispose(): readonly Change[] {
    if (this.#disposed) return []
    this.#out = []
    for (const h of [...this.#holding.values()]) this.#move(h.owner, null, null, null, null, 'dispose')
    this.#waiters = []
    this.#readers = []
    this.#disposed = true
    return this.#end()
  }

  // ── internals ──
  #begin(op: string) {
    if (this.#disposed) throw new Error(`PlaceBook.${op}: the book is disposed; no booking after dispose()`)
    this.#out = []
  }

  #end(): readonly Change[] { const out = this.#out; this.#out = []; return out }

  /** A policy origin must be a tile a worker can stand on: a whole tile, walkable or a seat. Checked before anything
   *  changes. */
  #checkOrigin(from: Tile, op: string) {
    const ok = Number.isInteger(from.x) && Number.isInteger(from.y) &&
      (this.layout.map.walkable(from.x, from.y) || this.layout.seatAt(from.x, from.y) !== null)
    if (!ok) throw new Error(`PlaceBook.${op}: the origin (${from.x},${from.y}) is neither a walkable tile nor a seat`)
  }

  /** A raw booking's refusal, before anything changes: an unknown place, or one another owner holds. */
  #refuseTaken(owner: OwnerId, place: PlaceId, op: string) {
    this.layout.place(place)
    const other = this.#holder.get(place)
    if (other !== undefined && other !== owner) throw new Error(`PlaceBook.${op}: ${place} is held by ${other}; ${owner} cannot book it`)
  }

  /** The place assign() books: own points by tier, then the chain (siblings, then the pool's tile to wait on). */
  #choose(st: Station, owner: OwnerId, from: Tile, fetch: boolean): { place: PlaceId; role: Role } | null {
    const ownRole: Role = st.shelfRoom !== null && fetch ? 'pull' : 'use'
    for (const tier of st.tiers) {
      const p = this.#nearestFree(tier, from, owner)
      if (p !== null) return { place: p, role: ownRole }
    }
    for (const link of st.chain) {
      if (link.type === 'sibling') {
        for (const tier of this.layout.stations.get(link.kind)!.tiers) {
          const p = this.#nearestFree(tier, from, owner)
          if (p !== null) return { place: p, role: 'sibling' }
        }
      } else {
        const p = this.#pickInPool(this.layout.pools.get(link.pool)!, from, owner)
        if (p !== null) return { place: p, role: 'wait' }
      }
    }
    return null
  }

  /** What assign() reports, read from the book after the call's cascades. */
  #outcome(owner: OwnerId, kind: StationKind): Omit<AssignResult, 'changes'> {
    const h = this.#holding.get(owner) ?? null
    if (this.waiterOf(owner)?.kind === kind) {
      return h !== null && h.role === 'wait' ? { how: 'pool', place: h.place, via: this.layout.poolOf(h.place)?.name ?? null } : { how: 'queued', place: null, via: null }
    }
    if (h !== null && h.role === 'sibling') return { how: 'sibling', place: h.place, via: this.layout.stationOf(h.place) }
    return { how: 'own', place: h?.place ?? null, via: null }
  }

  /** Book a place and serve whatever that frees. */
  #grant(owner: OwnerId, place: PlaceId, role: Role, forKind: StationKind | null, cause: Cause) {
    this.#settle(this.#move(owner, place, role, forKind, null, cause))
  }

  /** The one place where bookings change. Returns the place it freed, if any. */
  #move(owner: OwnerId, to: PlaceId | null, role: Role | null, forKind: StationKind | null, pulledFrom: PlaceId | null, cause: Cause): PlaceId | null {
    if (to !== null) {
      this.layout.place(to)
      const other = this.#holder.get(to)
      if (other !== undefined && other !== owner) throw new Error(`PlaceBook: ${to} is held by ${other}; ${owner} cannot book it`)
    }
    const old = this.#holding.get(owner) ?? null
    let freed: PlaceId | null = null
    if (old && old.place !== to) { this.#holder.delete(old.place); freed = old.place }
    if (role !== 'readAtShelf') this.#readers = this.#readers.filter(r => r.owner !== owner)
    const seq = this.#changeSeq++
    if (to !== null && role !== null) {
      this.#holder.set(to, owner)
      this.#holding.set(owner, { owner, place: to, role, forKind, pulledFrom, pull: role === 'pull' ? seq : null })
    } else this.#holding.delete(owner)
    this.#out.push({ seq, owner, from: old?.place ?? null, to, role, forKind, cause })
    return freed
  }

  /** Join the wait list (FIFO by seq). */
  #wait(owner: OwnerId, kind: StationKind, fetch: boolean) {
    this.#unwait(owner)
    this.#waiters.push({ owner, kind, seq: this.#seq++, fetch })
  }

  #unwait(owner: OwnerId) { this.#waiters = this.#waiters.filter(w => w.owner !== owner) }

  #isFreeFor(place: PlaceId, owner: OwnerId) { const h = this.#holder.get(place); return h === undefined || h === owner }

  /** Nearest free member by walked distance + crowding; ties to the declaration order (members are in it). The place
   *  the owner already holds is never charged crowding: staying on it adds none. */
  #nearestFree(members: readonly PlaceId[], from: Tile, owner: OwnerId): PlaceId | null {
    const mine = this.#holding.get(owner)?.place ?? null
    let best: PlaceId | null = null, bestCost = Infinity
    for (const id of members) {
      if (!this.#isFreeFor(id, owner)) continue
      const p = this.layout.place(id)
      if (p.type === 'point' && p.reserved) continue
      let cost = this.layout.distance(from, id)
      if (p.type === 'point' && id !== mine) {
        for (const n of this.layout.crowdNeighbours.get(id) ?? []) {
          const h = this.#holder.get(n)
          if (h !== undefined && h !== owner) cost += this.crowdCost
        }
      }
      if (cost < bestCost) { best = id; bestCost = cost }
    }
    return best
  }

  /** A pool's tiers in order; a line takes its first free position. */
  #pickInPool(pool: Pool, from: Tile, owner: OwnerId): PlaceId | null {
    if (pool.line) return pool.members.find(id => this.#isFreeFor(id, owner)) ?? null
    for (const tier of pool.tiers) {
      const p = this.#nearestFree(tier, from, owner)
      if (p !== null) return p
    }
    return null
  }

  /** Offer every freed place, one after the other, until no booking changes. */
  #settle(first: PlaceId | null) {
    const queue: PlaceId[] = first === null ? [] : [first]
    while (queue.length > 0) {
      const p = queue.shift()!
      if (this.#holder.has(p)) continue
      const freed = this.#offer(p)
      if (freed !== null) queue.push(freed)
    }
  }

  /** Whether a station's chain lists another station as a sibling. */
  #siblingOf(kind: StationKind, station: StationKind) {
    return this.layout.stations.get(kind)!.chain.some(l => l.type === 'sibling' && l.kind === station)
  }

  /** One free place: step-aside (a reading place), else the earliest waiter of the point's own station (promotion),
   *  else the earliest waiter whose chain lists that station as a sibling, else a line moving up, else the earliest
   *  waiter whose chain holds the pool. Returns the next freed place. */
  #offer(p: PlaceId): PlaceId | null {
    const room = this.layout.readingRoomOf(p)
    if (room !== null) {
      const done = this.#stepAsideOnce(room, p)
      if (done.happened) return done.freed
    }
    const station = this.layout.stationOf(p)
    if (station !== null) {
      const own = this.#waiters.find(x => x.kind === station)
      if (own) {
        this.#unwait(own.owner)
        const st = this.layout.stations.get(station)!
        return this.#move(own.owner, p, st.shelfRoom !== null && own.fetch ? 'pull' : 'use', station, null, 'served')
      }
      const chained = this.#waiters.find(x => this.#siblingOf(x.kind, station))
      if (chained) {
        this.#unwait(chained.owner)
        return this.#move(chained.owner, p, 'sibling', chained.kind, null, 'served')
      }
    }
    const pool = this.layout.poolOf(p)
    if (pool !== null) {
      if (pool.line) {
        const i = pool.members.indexOf(p)
        for (const behind of pool.members.slice(i + 1)) {
          const o = this.#holder.get(behind)
          const h = o === undefined ? null : this.#holding.get(o)!
          if (h && h.role === 'wait' && this.waiterOf(h.owner)?.kind === h.forKind) return this.#move(h.owner, p, 'wait', h.forKind, null, 'moveUp')
        }
      }
      const w = this.#waiters.find(x => {
        if (!CHAINS[x.kind].includes(pool.name)) return false
        const h = this.#holding.get(x.owner)
        return !h || this.layout.poolOf(h.place) !== pool
      })
      if (w) return this.#move(w.owner, p, 'wait', w.kind, null, 'served')
    }
    return null
  }

  #stepAsideAll(room: Room) {
    for (;;) {
      const done = this.#stepAsideOnce(room, null)
      if (!done.happened) return
      this.#settle(done.freed)
    }
  }

  /** One step-aside in a room, if a shelf kind of it has both a waiting puller and a fallback reader and a reading
   *  place is free (`prefer`, else the nearest to the reader). The vacated shelf point goes straight to the earliest
   *  waiting puller of that kind. */
  #stepAsideOnce(room: Room, prefer: PlaceId | null): { happened: boolean; freed: PlaceId | null } {
    let kind: StationKind | null = null, first = Infinity
    for (const w of this.#waiters) {
      if (SHELF_ROOM[w.kind] !== room || w.seq >= first) continue
      if (this.#readers.some(r => r.kind === w.kind)) { kind = w.kind; first = w.seq }
    }
    if (kind === null) return { happened: false, freed: null }
    const reader = this.#readers.find(r => r.kind === kind)!
    const rh = this.#holding.get(reader.owner)!
    const shelf = this.layout.place(rh.place)
    const target = prefer !== null && this.#holder.get(prefer) === undefined ? prefer
      : this.#pickInPool(this.layout.pools.get(READING_POOL[room])!, shelf, reader.owner)
    if (target === null || target === rh.place) return { happened: false, freed: null }
    this.#move(reader.owner, target, 'read', rh.forKind, rh.place, 'stepAside')
    const w = this.#waiters.find(x => x.kind === kind)!
    this.#unwait(w.owner)
    const freed = this.#move(w.owner, shelf.id, w.fetch ? 'pull' : 'use', kind, null, 'served')
    return { happened: true, freed }
  }
}
