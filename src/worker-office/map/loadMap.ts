// Worker office map: floorplan.json (plan §1–§3, grid sha256 e9548001…) -> a typed, validated map.
//
// Pure TypeScript: no DOM and no import of the data file. The page parses the bundled JSON
// (map/office.ts); the Node checks (scripts/worker-office-*.ts) read the same file from disk and call
// the same function, so both paths run identical code.
//
// What it builds (plan §6.1):
//   - the TileKind grid: structure kinds from the legend characters, object tile kinds from objects[].tileKinds;
//   - the walkable rule: legend[char].walkable AND 0 < x < width-1 AND 0 < y < height-1 (the border is never
//     walkable; officeMap.ts:212-213). Seats are solid: a worker enters one only from its sitFrom tile;
//   - rooms (zones, a child zone overrides its parent), openings, the door, arrival slots, the exit lane,
//     place tiles, interaction points.
// Every cross-reference is validated; a bad file throws one Error that lists every problem found.

export interface Tile { readonly x: number; readonly y: number }

/** Legend characters that are part of the shell, not objects. */
export const STRUCTURE_KIND_BY_CHAR = {
  '#': 'wall',
  '~': 'window',
  '+': 'opening',
  ':': 'corridor',
  '.': 'floor',
  ',': 'sidewalk',
  q: 'arrivalSlot',
  u: 'useSpot',
  '*': 'placeTile',
} as const
export type StructureKind = (typeof STRUCTURE_KIND_BY_CHAR)[keyof typeof STRUCTURE_KIND_BY_CHAR]

/** The 40 object kinds of plan §2. */
export const OBJECT_KINDS = [
  'armchairN', 'benchTerminal', 'bookshelf', 'cardCatalog', 'coatStand', 'copier', 'doormat', 'espressoMachine',
  'fileCabinet', 'floorLamp', 'fridge', 'frontDesk', 'frontDoor', 'historyShelf', 'inOutBoard', 'kanbanBoard',
  'lectern', 'manualsShelf', 'meetingTable', 'noticeBoard', 'pcDesk', 'pigeonholes', 'plant', 'planter', 'postShelf',
  'printer', 'readingLedge', 'readingTable', 'receptionChair', 'serverRack', 'shredder', 'sink', 'sofaN', 'street',
  'taskChairN', 'ups', 'visitorChair', 'wallClock', 'waterCooler', 'woodChairN',
] as const
export type ObjectKind = (typeof OBJECT_KINDS)[number]

/** The 58 placed tile kinds of plan §2 (multi-tile objects have W/C/E parts). */
export const OBJECT_TILE_KINDS = [
  'armchairN', 'benchTerminal', 'bookshelf', 'cardCatalogE', 'cardCatalogW', 'coatStand', 'copier', 'doorInLeaf',
  'doorOutLeaf', 'doormatE', 'doormatW', 'espressoMachine', 'fileCabinet', 'floorLamp', 'fridge', 'frontDeskE',
  'frontDeskW', 'historyShelf', 'inOutBoardE', 'inOutBoardW', 'kanbanBoardC', 'kanbanBoardE', 'kanbanBoardW',
  'lectern', 'manualsShelfE', 'manualsShelfW', 'meetingTableC', 'meetingTableE', 'meetingTableW', 'noticeBoardE',
  'noticeBoardW', 'pcDesk', 'pigeonholesC', 'pigeonholesE', 'pigeonholesW', 'plant', 'planter', 'postShelf',
  'printer', 'readingLedgeE', 'readingLedgeW', 'readingTableC', 'readingTableE', 'readingTableW', 'receptionChair',
  'serverRack', 'shredder', 'sink', 'sofaNorthC', 'sofaNorthE', 'sofaNorthW', 'street', 'taskChairN', 'ups',
  'visitorChair', 'wallClock', 'waterCooler', 'woodChairN',
] as const
export type ObjectTileKind = (typeof OBJECT_TILE_KINDS)[number]

export type TileKind = StructureKind | ObjectTileKind

/** Objects mounted IN a wall run (they replace wall tiles and face into the room below). These join the wall
 *  set ("WALLISH", officeMap.ts:203; plan §1.2 engine notes). Planters are not wall-mounted. */
export const WALL_MOUNTED_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['kanbanBoard', 'inOutBoard', 'wallClock', 'noticeBoard'])

/** Objects that are part of the shell or the ground, drawn by render/floors.ts (the door leaves by the state layer),
 *  never as furniture. */
export const SURFACE_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['frontDoor', 'doormat', 'planter', 'street'])

export interface LegendEntry { readonly name: string; readonly color: string; readonly walkable: boolean }

export interface Zone {
  readonly name: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Base colour of the floor finish. */
  readonly floor: string
  /** Finish name, e.g. "grey vinyl" (render/floors.ts maps it to the art). */
  readonly finish: string
  /** Name of the enclosing zone for a sub-area (the mail / print corner), else null. */
  readonly parent: string | null
}

export interface InteractionPoint extends Tile {
  readonly objectId: string
  readonly kind: ObjectKind
  readonly facing: string
  readonly pose: string
  /** stand: the worker stands on (x, y). sit: (x, y) is the (solid) seat, entered only from sitFrom. */
  readonly how: 'stand' | 'sit'
  readonly sitFrom: Tile | null
  readonly reserved: boolean
}

export interface OfficeObject {
  readonly id: string
  readonly kind: ObjectKind
  readonly char: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly facing: string
  readonly functional: boolean
  readonly cls: string
  /** Row-major, one per covered tile. */
  readonly tileKinds: readonly ObjectTileKind[]
  readonly points: readonly InteractionPoint[]
  readonly wallMounted: boolean
}

export interface Place extends Tile {
  readonly pool: string
  readonly role: string
  readonly facing: string
  readonly pose: string
}

export interface Opening {
  readonly name: string
  readonly tiles: readonly Tile[]
  /** 'horizontal': the opening is in a horizontal wall run (passage north-south); 'vertical': passage east-west. */
  readonly wall: 'horizontal' | 'vertical'
  /** [north, south] for a horizontal wall, [west, east] for a vertical one. */
  readonly sides: readonly [Zone, Zone]
}

export interface ArrivalSlot extends Tile { readonly order: number }

export interface Door {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly outLeaf: Tile
  readonly inLeaf: Tile
  /** The doorstep outside the door; doormat[0] is where the reachability checks start. */
  readonly doormat: readonly Tile[]
  readonly senseTiles: number
}

export interface OfficeMap {
  readonly tileSize: number
  readonly width: number
  readonly height: number
  readonly rows: readonly string[]
  readonly legend: Readonly<Record<string, LegendEntry>>
  /** [y][x] */
  readonly tiles: readonly (readonly TileKind[])[]
  readonly objects: readonly OfficeObject[]
  readonly zones: readonly Zone[]
  readonly openings: readonly Opening[]
  readonly door: Door
  /** The wall row that holds the front door; everything south of it is outside. */
  readonly facadeRow: number
  readonly arrivalSlots: readonly ArrivalSlot[]
  readonly arrivalSlotsOverflow: readonly Tile[]
  readonly exitLane: readonly Tile[]
  readonly places: readonly Place[]
  /** All interaction points, in object order (88 in plan §3.1). */
  readonly points: readonly InteractionPoint[]
  readonly gridSha256: string
  walkable(x: number, y: number): boolean
  inBounds(x: number, y: number): boolean
  objectAt(x: number, y: number): OfficeObject | null
  /** The most specific zone containing the tile (a child zone wins over its parent), or null. */
  zoneAt(x: number, y: number): Zone | null
  /** For a seat tile: the tile it is entered from; otherwise null. */
  sitFromOf(x: number, y: number): Tile | null
}

// ── small parsing helpers (the input is untrusted JSON) ────────────────────────
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

class Problems {
  readonly list: string[] = []
  need(cond: boolean, msg: string): boolean { if (!cond) this.list.push(msg); return cond }
  num(o: Obj, k: string, where: string): number {
    const v = o[k]
    if (typeof v === 'number' && Number.isInteger(v)) return v
    this.list.push(`${where}.${k} is not an integer`); return 0
  }
  str(o: Obj, k: string, where: string): string {
    const v = o[k]
    if (typeof v === 'string') return v
    this.list.push(`${where}.${k} is not a string`); return ''
  }
  bool(o: Obj, k: string, where: string): boolean {
    const v = o[k]
    if (typeof v === 'boolean') return v
    this.list.push(`${where}.${k} is not a boolean`); return false
  }
  arr(o: Obj, k: string, where: string): unknown[] {
    const v = o[k]
    if (Array.isArray(v)) return v
    this.list.push(`${where}.${k} is not an array`); return []
  }
  obj(o: Obj, k: string, where: string): Obj {
    const v = o[k]
    if (isObj(v)) return v
    this.list.push(`${where}.${k} is not an object`); return {}
  }
  tile(v: unknown, where: string): Tile {
    if (!isObj(v)) { this.list.push(`${where} is not a tile`); return { x: -1, y: -1 } }
    return { x: this.num(v, 'x', where), y: this.num(v, 'y', where) }
  }
}

const key = (x: number, y: number) => `${x},${y}`
const isStructureChar = (c: string): c is keyof typeof STRUCTURE_KIND_BY_CHAR => Object.hasOwn(STRUCTURE_KIND_BY_CHAR, c)
const OBJECT_KIND_SET: ReadonlySet<string> = new Set(OBJECT_KINDS)
const OBJECT_TILE_KIND_SET: ReadonlySet<string> = new Set(OBJECT_TILE_KINDS)

/** Build the map from the parsed floorplan.json. Throws if the file is inconsistent. */
export function loadMap(raw: unknown): OfficeMap {
  const P = new Problems()
  if (!isObj(raw)) throw new Error('floorplan.json: top level is not an object')

  const tileSize = P.num(raw, 'tile', 'floorplan')
  const W = P.num(raw, 'width', 'floorplan')
  const H = P.num(raw, 'height', 'floorplan')
  const rows = P.arr(raw, 'rows', 'floorplan').map((r, i) => (typeof r === 'string' ? r : (P.need(false, `rows[${i}] is not a string`), '')))
  if (!P.need(rows.length === H && H > 2 && W > 2 && rows.every(r => r.length === W), `rows must be ${H} strings of ${W} characters`)) {
    throw new Error(`floorplan.json invalid:\n- ${P.list.join('\n- ')}`)
  }
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H
  const charAt = (x: number, y: number) => rows[y][x]

  // legend
  const legendRaw = P.obj(raw, 'legend', 'floorplan')
  const legend: Record<string, LegendEntry> = {}
  for (const [ch, v] of Object.entries(legendRaw)) {
    if (!P.need(isObj(v) && ch.length === 1, `legend[${JSON.stringify(ch)}] is malformed`)) continue
    const e = v as Obj
    legend[ch] = { name: P.str(e, 'name', `legend[${ch}]`), color: P.str(e, 'color', `legend[${ch}]`), walkable: P.bool(e, 'walkable', `legend[${ch}]`) }
  }
  for (const ch of new Set(rows.join(''))) P.need(Object.hasOwn(legend, ch), `character ${JSON.stringify(ch)} in rows has no legend entry`)
  for (const ch of Object.keys(STRUCTURE_KIND_BY_CHAR)) P.need(Object.hasOwn(legend, ch), `structure character ${JSON.stringify(ch)} has no legend entry`)

  const walkable = (x: number, y: number) =>
    x > 0 && y > 0 && x < W - 1 && y < H - 1 && legend[charAt(x, y)]?.walkable === true

  // zones (rooms); a child zone (parent set) overrides its parent inside the parent's rectangle
  const zones: Zone[] = P.arr(raw, 'zones', 'floorplan').map((v, i) => {
    const where = `zones[${i}]`
    if (!isObj(v)) { P.need(false, `${where} is not an object`); return { name: '', x: 0, y: 0, w: 0, h: 0, floor: '', finish: '', parent: null } }
    const parent = v.parent === undefined ? null : (typeof v.parent === 'string' ? v.parent : (P.need(false, `${where}.parent is not a string`), null))
    return {
      name: P.str(v, 'name', where), x: P.num(v, 'x', where), y: P.num(v, 'y', where), w: P.num(v, 'w', where),
      h: P.num(v, 'h', where), floor: P.str(v, 'floor', where), finish: P.str(v, 'finish', where), parent,
    }
  })
  const zoneByName = new Map(zones.map(z => [z.name, z]))
  P.need(zoneByName.size === zones.length, 'zone names are not unique')
  const zoneGrid: (Zone | null)[][] = Array.from({ length: H }, () => Array<Zone | null>(W).fill(null))
  for (const pass of ['top', 'child'] as const) {
    for (const z of zones) {
      if ((pass === 'top') !== (z.parent === null)) continue
      P.need(z.w > 0 && z.h > 0 && inBounds(z.x, z.y) && inBounds(z.x + z.w - 1, z.y + z.h - 1), `zone ${z.name} is out of bounds`)
      P.need(/^#[0-9a-fA-F]{6}$/.test(z.floor), `zone ${z.name} floor colour ${z.floor} is not #rrggbb`)
      const parent = z.parent === null ? null : zoneByName.get(z.parent) ?? null
      if (z.parent !== null) {
        P.need(parent !== null && parent.parent === null, `zone ${z.name}: parent ${z.parent} is missing or nested`)
      }
      for (let y = z.y; y < z.y + z.h; y++) {
        for (let x = z.x; x < z.x + z.w; x++) {
          if (!inBounds(x, y)) continue
          const cur = zoneGrid[y][x]
          if (pass === 'top') P.need(cur === null, `zones ${cur?.name} and ${z.name} overlap at (${x},${y})`)
          else P.need(cur === parent, `child zone ${z.name} leaves its parent at (${x},${y})`)
          zoneGrid[y][x] = z
        }
      }
    }
  }
  const zoneAt = (x: number, y: number) => (inBounds(x, y) ? zoneGrid[y][x] : null)

  // objects and their interaction points
  const objects: OfficeObject[] = []
  const objectGrid: (OfficeObject | null)[][] = Array.from({ length: H }, () => Array<OfficeObject | null>(W).fill(null))
  const ids = new Set<string>()
  P.arr(raw, 'objects', 'floorplan').forEach((v, i) => {
    const where = `objects[${i}]`
    if (!P.need(isObj(v), `${where} is not an object`)) return
    const o = v as Obj
    const id = P.str(o, 'id', where)
    P.need(!ids.has(id), `object id ${id} is not unique`); ids.add(id)
    const kind = P.str(o, 'kind', where)
    P.need(OBJECT_KIND_SET.has(kind), `${id}: unknown kind ${kind}`)
    P.need(P.str(o, 'name', where) === kind, `${id}: name and kind differ`)
    const char = P.str(o, 'char', where)
    const x = P.num(o, 'x', where), y = P.num(o, 'y', where), w = P.num(o, 'w', where), h = P.num(o, 'h', where)
    const tileKinds = P.arr(o, 'tileKinds', where).map(t => String(t))
    P.need(w > 0 && h > 0 && tileKinds.length === w * h, `${id}: tileKinds must list ${w * h} tiles`)
    for (const t of tileKinds) P.need(OBJECT_TILE_KIND_SET.has(t), `${id}: unknown tile kind ${t}`)
    P.need(char.length === 1 && !isStructureChar(char), `${id}: char ${JSON.stringify(char)} is a structure character`)
    // validate_floorplan.py's rule: the legend name of every covered tile starts with the kind (the door excepted)
    P.need(kind === 'frontDoor' || (legend[char]?.name ?? '').startsWith(kind), `${id}: legend[${char}] is not a ${kind}`)
    const wallMounted = WALL_MOUNTED_KINDS.has(kind as ObjectKind)
    const points: InteractionPoint[] = P.arr(o, 'interaction', where).map((pv, j) => {
      const pw = `${id}.interaction[${j}]`
      if (!isObj(pv)) { P.need(false, `${pw} is not an object`); return null }
      const how = P.str(pv, 'how', pw)
      P.need(how === 'stand' || how === 'sit', `${pw}: how must be stand or sit`)
      const sitFrom = how === 'sit' ? P.tile(pv.sitFrom, `${pw}.sitFrom`) : null
      P.need(how === 'sit' || pv.sitFrom === undefined || pv.sitFrom === null, `${pw}: a stand point has a sitFrom`)
      return {
        objectId: id, kind: kind as ObjectKind, x: P.num(pv, 'x', pw), y: P.num(pv, 'y', pw), facing: P.str(pv, 'facing', pw),
        pose: P.str(pv, 'pose', pw), how: how === 'sit' ? 'sit' : 'stand', sitFrom, reserved: pv.reserved === true,
      } satisfies InteractionPoint
    }).filter((p): p is InteractionPoint => p !== null)
    const obj: OfficeObject = {
      id, kind: kind as ObjectKind, char, x, y, w, h, facing: P.str(o, 'facing', where), functional: P.bool(o, 'functional', where),
      cls: P.str(o, 'class', where), tileKinds: tileKinds as ObjectTileKind[], points, wallMounted,
    }
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (!P.need(inBounds(tx, ty), `${id}: tile (${tx},${ty}) is out of bounds`)) continue
        P.need(charAt(tx, ty) === char, `${id}: tile (${tx},${ty}) is ${JSON.stringify(charAt(tx, ty))}, not ${JSON.stringify(char)}`)
        P.need(objectGrid[ty][tx] === null, `${id} overlaps ${objectGrid[ty][tx]?.id} at (${tx},${ty})`)
        objectGrid[ty][tx] = obj
      }
    }
    objects.push(obj)
  })
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = charAt(x, y)
      P.need(isStructureChar(c) || objectGrid[y][x] !== null, `tile (${x},${y}) ${JSON.stringify(c)} belongs to no object`)
    }
  }
  const objectAt = (x: number, y: number) => (inBounds(x, y) ? objectGrid[y][x] : null)

  // wall-mounted objects must sit inside a horizontal wall run (wall, window, opening or another wall-mounted object
  // on both ends); nothing else may be wall-mounted
  const wallRunAt = (x: number, y: number) => {
    if (!inBounds(x, y)) return false
    const c = charAt(x, y)
    return c === '#' || c === '~' || c === '+' || objectAt(x, y)?.wallMounted === true
  }
  for (const o of objects) {
    if (!o.wallMounted) continue
    P.need(o.h === 1 && wallRunAt(o.x - 1, o.y) && wallRunAt(o.x + o.w, o.y), `${o.id}: wall-mounted but not inside a horizontal wall run`)
    P.need(walkable(o.x, o.y + 1) || objectAt(o.x, o.y + 1) !== null, `${o.id}: wall-mounted but faces no room`)
  }

  // interaction points: a stand point is a 'u' tile directly south of its object; a seat is solid and is entered
  // from an adjacent walkable sitFrom tile
  const points = objects.flatMap(o => o.points)
  const seatFrom = new Map<string, Tile>()
  const standTiles = new Set<string>()
  for (const p of points) {
    const where = `${p.objectId} point (${p.x},${p.y})`
    if (!P.need(inBounds(p.x, p.y), `${where} is out of bounds`)) continue
    if (p.how === 'stand') {
      P.need(charAt(p.x, p.y) === 'u' && walkable(p.x, p.y), `${where}: a stand point must be a walkable 'u' tile`)
      P.need(objectAt(p.x, p.y - 1)?.id === p.objectId, `${where}: its object is not directly north`)
      P.need(!standTiles.has(key(p.x, p.y)), `${where}: two stand points share the tile`)
      standTiles.add(key(p.x, p.y))
    } else if (p.sitFrom) {
      P.need(!walkable(p.x, p.y) && objectAt(p.x, p.y) !== null, `${where}: a seat must be a solid object tile`)
      P.need(Math.abs(p.x - p.sitFrom.x) + Math.abs(p.y - p.sitFrom.y) === 1 && walkable(p.sitFrom.x, p.sitFrom.y),
        `${where}: sitFrom (${p.sitFrom.x},${p.sitFrom.y}) must be an adjacent walkable tile`)
      P.need(!seatFrom.has(key(p.x, p.y)), `${where}: two seats share the tile`)
      seatFrom.set(key(p.x, p.y), p.sitFrom)
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (charAt(x, y) === 'u') P.need(standTiles.has(key(x, y)), `'u' tile (${x},${y}) is no object's stand point`)
  }

  // place tiles ('*')
  const places: Place[] = P.arr(raw, 'places', 'floorplan').map((v, i) => {
    const where = `places[${i}]`
    if (!isObj(v)) { P.need(false, `${where} is not an object`); return { x: -1, y: -1, pool: '', role: '', facing: '', pose: '' } }
    const t = P.tile(v, where)
    return { ...t, pool: P.str(v, 'pool', where), role: P.str(v, 'role', where), facing: P.str(v, 'facing', where), pose: P.str(v, 'pose', where) }
  })
  const placeTiles = new Set(places.map(p => key(p.x, p.y)))
  P.need(placeTiles.size === places.length, 'two place tiles share a tile')
  for (const p of places) P.need(inBounds(p.x, p.y) && charAt(p.x, p.y) === '*', `place (${p.x},${p.y}) is not a '*' tile`)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (charAt(x, y) === '*') P.need(placeTiles.has(key(x, y)), `'*' tile (${x},${y}) is not in places[]`)
  }

  // openings ('+'): each lies in one wall run and joins exactly two zones
  const openingTiles = new Set<string>()
  const openings: Opening[] = Object.entries(P.obj(raw, 'openings', 'floorplan')).map(([name, v]) => {
    const tiles = (Array.isArray(v) ? v : (P.need(false, `openings.${name} is not an array`), [])).map((t, j) => P.tile(t, `openings.${name}[${j}]`))
    const horiz = tiles.length > 0 && tiles.every(t => t.y === tiles[0].y)
    const vert = tiles.length > 0 && tiles.every(t => t.x === tiles[0].x)
    P.need(tiles.length >= 2 && (horiz || vert), `opening ${name} must be 2+ tiles in one row or column`)
    let sides: [Zone, Zone] | null = null
    for (const t of tiles) {
      P.need(inBounds(t.x, t.y) && charAt(t.x, t.y) === '+', `opening ${name}: (${t.x},${t.y}) is not a '+' tile`)
      P.need(!openingTiles.has(key(t.x, t.y)), `opening ${name}: (${t.x},${t.y}) is in two openings`)
      openingTiles.add(key(t.x, t.y))
      const a = horiz ? zoneAt(t.x, t.y - 1) : zoneAt(t.x - 1, t.y)
      const b = horiz ? zoneAt(t.x, t.y + 1) : zoneAt(t.x + 1, t.y)
      if (!P.need(a !== null && b !== null && a !== b, `opening ${name}: (${t.x},${t.y}) does not join two zones`)) continue
      if (sides === null) sides = [a!, b!]
      else P.need(sides[0] === a && sides[1] === b, `opening ${name}: its tiles join different zones`)
    }
    const dummy: Zone = { name: '', x: 0, y: 0, w: 0, h: 0, floor: '#000000', finish: '', parent: null }
    return { name, tiles, wall: horiz ? 'horizontal' : 'vertical', sides: sides ?? [dummy, dummy] } satisfies Opening
  })
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (charAt(x, y) === '+') P.need(openingTiles.has(key(x, y)), `'+' tile (${x},${y}) is in no opening`)
  }

  // the door: two leaves in the facade row, a doormat outside
  const d = P.obj(raw, 'door', 'floorplan')
  const door: Door = {
    x: P.num(d, 'x', 'door'), y: P.num(d, 'y', 'door'), w: P.num(d, 'w', 'door'), h: P.num(d, 'h', 'door'),
    outLeaf: P.tile(d.outLeaf, 'door.outLeaf'), inLeaf: P.tile(d.inLeaf, 'door.inLeaf'),
    doormat: P.arr(d, 'doormat', 'door').map((t, j) => P.tile(t, `door.doormat[${j}]`)), senseTiles: P.num(d, 'senseTiles', 'door'),
  }
  const doorObj = objects.find(o => o.kind === 'frontDoor')
  P.need(doorObj !== undefined && doorObj.x === door.x && doorObj.y === door.y && doorObj.w === door.w && doorObj.h === door.h,
    'door rectangle differs from the frontDoor object')
  for (const leaf of [door.outLeaf, door.inLeaf]) {
    P.need(inBounds(leaf.x, leaf.y) && objectAt(leaf.x, leaf.y)?.kind === 'frontDoor' && walkable(leaf.x, leaf.y), `door leaf (${leaf.x},${leaf.y}) is not a walkable door tile`)
  }
  P.need(door.doormat.length > 0, 'the door has no doormat')
  for (const t of door.doormat) {
    P.need(inBounds(t.x, t.y) && objectAt(t.x, t.y)?.kind === 'doormat' && walkable(t.x, t.y) && t.y === door.y + 1, `doormat tile (${t.x},${t.y}) is not a walkable mat outside the door`)
  }
  const facadeRow = door.y

  // sidewalk: arrival slots ('q', released front to back), overflow and exit lane
  const arrivalSlots: ArrivalSlot[] = P.arr(raw, 'arrivalSlots', 'floorplan').map((v, i) => {
    const t = P.tile(v, `arrivalSlots[${i}]`)
    return { ...t, order: isObj(v) ? P.num(v, 'order', `arrivalSlots[${i}]`) : 0 }
  }).sort((a, b) => a.order - b.order)
  arrivalSlots.forEach((s, i) => {
    P.need(s.order === i + 1, `arrival slot orders must be 1..${arrivalSlots.length}`)
    P.need(inBounds(s.x, s.y) && charAt(s.x, s.y) === 'q' && s.y > facadeRow, `arrival slot (${s.x},${s.y}) is not a 'q' tile outside`)
  })
  const qCount = rows.join('').split('').filter(c => c === 'q').length
  P.need(qCount === arrivalSlots.length, `${qCount} 'q' tiles but ${arrivalSlots.length} arrival slots`)
  const sidewalkTiles = (k: string) => P.arr(raw, k, 'floorplan').map((v, i) => {
    const t = P.tile(v, `${k}[${i}]`)
    P.need(walkable(t.x, t.y) && t.y > facadeRow, `${k} tile (${t.x},${t.y}) is not walkable sidewalk`)
    return t
  })
  const arrivalSlotsOverflow = sidewalkTiles('arrivalSlotsOverflow')
  const exitLane = sidewalkTiles('exitLane')

  // the TileKind grid
  const tiles: TileKind[][] = []
  for (let y = 0; y < H; y++) {
    const row: TileKind[] = []
    for (let x = 0; x < W; x++) {
      const c = charAt(x, y)
      const o = objectGrid[y][x]
      if (isStructureChar(c)) row.push(STRUCTURE_KIND_BY_CHAR[c])
      else if (o) row.push(o.tileKinds[(y - o.y) * o.w + (x - o.x)])
      else row.push('wall') // unreachable: reported above as a problem
    }
    tiles.push(row)
  }

  const gridSha256 = P.str(raw, 'gridSha256', 'floorplan')
  if (P.list.length > 0) throw new Error(`floorplan.json invalid (${P.list.length} problems):\n- ${P.list.join('\n- ')}`)

  return {
    tileSize, width: W, height: H, rows, legend, tiles, objects, zones, openings, door, facadeRow, arrivalSlots,
    arrivalSlotsOverflow, exitLane, places, points, gridSha256,
    walkable, inBounds, objectAt, zoneAt,
    sitFromOf: (x: number, y: number) => seatFrom.get(key(x, y)) ?? null,
  }
}
