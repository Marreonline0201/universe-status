// Office layout generator: builds the tile grid, team zones, and desk assignments
// from the live roster — no hardcoded per-agent coordinates anywhere.
// Layout: 5 team zones on top, 3 on the bottom, a central corridor, and a luxury
// commons bottom-right (glass meeting room, micro-kitchen, lounge, director's nook).
import type { OfficeAgent, OfficeTeam } from '../hooks/useOfficeSocket'
import type { TileKind } from './assets'
import type { Point } from './pathfind'

export const MAP_W = 82
export const MAP_H = 32

export interface DeskSpot {
  desk: Point
  chair: Point
}

export interface Zone {
  teamId: string
  name: string
  color: string
  rect: { x: number; y: number; w: number; h: number }
}

export interface OfficeMapData {
  width: number
  height: number
  tiles: TileKind[][]           // [y][x]
  walkable: (x: number, y: number) => boolean
  zones: Zone[]
  desks: Map<string, DeskSpot>  // agentId → spot
  meetingSeats: Point[]
  coffee: Point
  lobby: Point                  // where agents without a desk appear
  zoneColorAt: (x: number, y: number) => string | undefined
  // Position data consumed by the baked decor passes in prerenderMap
  // (lamp glows, rug border, glass-room ambiance).
  decor: {
    lamps: Point[]
    glassRoom: { x: number; y: number; w: number; h: number }
    rug: { x: number; y: number; w: number; h: number }
  }
}

const ROLE_ORDER = ['Team Lead', 'Senior Researcher', 'Reviewer / Editor', 'Research Engineer', 'Liaison / Scribe']

export function buildOfficeMap(teams: OfficeTeam[], agents: OfficeAgent[]): OfficeMapData {
  const tiles: TileKind[][] = Array.from({ length: MAP_H }, () => Array<TileKind>(MAP_W).fill('floor'))
  const solid = new Set<string>() // non-walkable "x,y"
  const S = (x: number, y: number) => solid.add(`${x},${y}`)

  const set = (x: number, y: number, k: TileKind, isSolid = false) => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return
    tiles[y][x] = k
    if (isSolid) S(x, y)
  }

  // border walls
  for (let x = 0; x < MAP_W; x++) { set(x, 0, 'wall', true); set(x, MAP_H - 1, 'wall', true) }
  for (let y = 0; y < MAP_H; y++) { set(0, y, 'wall', true); set(MAP_W - 1, y, 'wall', true) }

  // corridor band
  for (let y = 14; y <= 16; y++) for (let x = 1; x < MAP_W - 1; x++) set(x, y, 'corridor')

  const zones: Zone[] = []
  const desks = new Map<string, DeskSpot>()

  // Zone slots: 5 top (interior y 1..12), 3 bottom (interior y 18..30, x 1..47).
  const slots = [
    ...[0, 1, 2, 3, 4].map(i => ({ x: 1 + i * 16, y: 1, h: 12, top: true })),
    ...[0, 1, 2].map(i => ({ x: 1 + i * 16, y: 18, h: 13, top: false })),
  ]

  const byTeam = new Map<string, OfficeAgent[]>()
  for (const a of agents) {
    if (!byTeam.has(a.team)) byTeam.set(a.team, [])
    byTeam.get(a.team)!.push(a)
  }

  teams.slice(0, 8).forEach((team, ti) => {
    const slot = slots[ti]
    const { x: zx, y: zy } = slot
    const w = 15
    zones.push({ teamId: team.id, name: team.name, color: team.color, rect: { x: zx, y: zy, w, h: slot.h } })

    // zone floor tint
    for (let y = zy; y < zy + slot.h; y++) for (let x = zx; x < zx + w; x++) set(x, y, 'zoneFloor')

    // wall between zone and corridor, with a 2-tile door at the center
    const wallY = slot.top ? zy + slot.h : zy - 1
    for (let x = zx - 1; x <= zx + w; x++) {
      if (x === zx + 7 || x === zx + 8) continue // door
      set(x, wallY, 'wall', true)
    }
    // vertical wall on the zone's right edge (skip for rightmost top zone → border)
    for (let y = Math.min(zy - 1, wallY); y <= Math.max(zy + slot.h, wallY); y++) {
      if (zx + w < MAP_W - 1) set(zx + w, Math.max(1, Math.min(MAP_H - 2, y)), 'wall', true)
    }

    // glassboard on the outer wall behind the lead desk
    const boardY = slot.top ? 0 : MAP_H - 1
    set(zx + 6, boardY, 'whiteboard', true)
    set(zx + 7, boardY, 'whiteboard', true)
    set(zx + 8, boardY, 'whiteboard', true)

    // desk spots in role order: lead top-center, 3 fables left column, others right column
    const dy = slot.top ? 0 : 1 // bottom zones: shift desks down a touch
    const spots: DeskSpot[] = [
      { desk: { x: zx + 7, y: zy + 1 + dy }, chair: { x: zx + 7, y: zy + 2 + dy } },
      { desk: { x: zx + 2, y: zy + 3 + dy }, chair: { x: zx + 2, y: zy + 4 + dy } },
      { desk: { x: zx + 2, y: zy + 6 + dy }, chair: { x: zx + 2, y: zy + 7 + dy } },
      { desk: { x: zx + 2, y: zy + 9 + dy }, chair: { x: zx + 2, y: zy + 10 + dy } },
      { desk: { x: zx + 11, y: zy + 3 + dy }, chair: { x: zx + 11, y: zy + 4 + dy } },
      { desk: { x: zx + 11, y: zy + 6 + dy }, chair: { x: zx + 11, y: zy + 7 + dy } },
      { desk: { x: zx + 11, y: zy + 9 + dy }, chair: { x: zx + 11, y: zy + 10 + dy } },
    ]
    for (const s of spots) set(s.desk.x, s.desk.y, 'desk', true)
    for (const s of spots) set(s.chair.x, s.chair.y, 'chair')
    set(zx + 13, zy + slot.h - 1, 'plant', true)

    const members = (byTeam.get(team.id) ?? []).slice().sort((a, b) => {
      const ra = ROLE_ORDER.indexOf(a.role), rb = ROLE_ORDER.indexOf(b.role)
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.id.localeCompare(b.id)
    })
    members.forEach((m, i) => { if (spots[i]) desks.set(m.id, spots[i]) })
  })

  // Windows: convert stretches of plain border wall to windowWall AFTER the
  // zone loop so the glassboards (set inside the loop) survive. Guard on the
  // current tile still being 'wall'.
  const windowize = (x: number, y: number) => {
    if (tiles[y][x] === 'wall') { tiles[y][x] = 'windowWall' } // stays solid
  }
  for (const slot of slots.filter(s => s.top)) {
    for (const dx of [2, 3, 11, 12]) windowize(slot.x + dx, 0)
  }
  for (const slot of slots.filter(s => !s.top)) {
    for (const dx of [2, 3, 11, 12]) windowize(slot.x + dx, MAP_H - 1)
  }
  for (const x of [60, 61, 66, 67, 74, 75]) windowize(x, MAP_H - 1) // commons stretch

  // ── Luxury commons: x 49..80, y 18..30 ─────────────────────────────────────
  for (let y = 18; y <= 30; y++) for (let x = 49; x < MAP_W - 1; x++) set(x, y, 'floor')
  // north wall with two doors: main (55,56) aligned with the lobby, kitchen (71,72)
  for (let x = 48; x < MAP_W - 1; x++) {
    if (x === 55 || x === 56 || x === 71 || x === 72) continue
    set(x, 17, 'wall', true)
  }
  for (let y = 17; y <= 30; y++) set(48, y, 'wall', true)

  // Glass meeting room ("the aquarium"), NW quadrant — perimeter x 50..60 / y 19..26
  // with a door gap at (55,19)(56,19) lined up with the commons door and lobby.
  for (let x = 50; x <= 60; x++) {
    if (x !== 55 && x !== 56) set(x, 19, 'glass', true)
    set(x, 26, 'glass', true)
  }
  for (let y = 20; y <= 25; y++) { set(50, y, 'glass', true); set(60, y, 'glass', true) }

  const meetingSeats: Point[] = []
  for (let x = 52; x <= 57; x++) {
    set(x, 22, 'meetTable', true)
    set(x, 23, 'meetTable', true)
    meetingSeats.push({ x, y: 21 }, { x, y: 24 })
  }

  // Micro-kitchen along the top wall of the commons' east side.
  set(73, 18, 'kitchenCounter', true)
  set(74, 18, 'kitchenCounter', true)
  set(75, 18, 'sink', true)
  set(76, 18, 'kitchenCounter', true)
  const coffee: Point = { x: 77, y: 18 } // espresso machine; agents stand at (77,19)
  set(coffee.x, coffee.y, 'coffee', true)
  set(78, 18, 'kitchenCounter', true)
  set(79, 18, 'kitchenCounter', true)
  set(80, 18, 'fridge', true)

  // Lounge, SE quadrant: rug + two sofas + low table + armchair + floor lamps.
  const rug = { x: 66, y: 24, w: 8, h: 6 }
  for (let y = rug.y; y < rug.y + rug.h; y++) for (let x = rug.x; x < rug.x + rug.w; x++) set(x, y, 'rug')
  set(67, 25, 'sofaW', true); set(68, 25, 'sofaC', true); set(69, 25, 'sofaE', true)
  set(67, 28, 'sofaW', true); set(68, 28, 'sofaC', true); set(69, 28, 'sofaE', true)
  set(68, 26, 'loungeTable', true); set(68, 27, 'loungeTable', true)
  set(71, 26, 'armchair', true)
  const lamps: Point[] = [{ x: 66, y: 24 }, { x: 73, y: 29 }]
  for (const p of lamps) set(p.x, p.y, 'lamp', true)

  // plants
  set(49, 30, 'plant', true)
  set(80, 30, 'plant', true)
  set(65, 18, 'plant', true)

  // director's nook, SW under the glass room, backed by a living green wall
  const directorSpot: DeskSpot = { desk: { x: 53, y: 28 }, chair: { x: 53, y: 29 } }
  set(directorSpot.desk.x, directorSpot.desk.y, 'desk', true)
  set(directorSpot.chair.x, directorSpot.chair.y, 'chair')
  for (let x = 51; x <= 56; x++) set(x, MAP_H - 1, 'greenWall', true)
  for (const a of agents) if (a.team === 'company') desks.set(a.id, directorSpot)

  // Wall orientation pass (after ALL wall placement): a wall tile with another
  // wall-like tile directly below it is part of a vertical run or junction, so
  // only its top surface is visible from this angle — repeating the south-facing
  // cap+face art up a column reads as a striped ladder. Tiles with open space
  // below keep the face; the bottom border row (nothing below) stays a face band.
  const WALLISH = new Set<TileKind>(['wall', 'wallTop', 'windowWall', 'whiteboard', 'greenWall'])
  for (let y = 0; y < MAP_H - 1; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y][x] === 'wall' && WALLISH.has(tiles[y + 1][x])) tiles[y][x] = 'wallTop'
    }
  }

  const lobby: Point = { x: 55, y: 15 }

  const walkable = (x: number, y: number) =>
    x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1 && !solid.has(`${x},${y}`)

  const zoneColorAt = (x: number, y: number) => {
    for (const z of zones) {
      if (x >= z.rect.x && x < z.rect.x + z.rect.w && y >= z.rect.y && y < z.rect.y + z.rect.h) return z.color
    }
    return undefined
  }

  return {
    width: MAP_W, height: MAP_H, tiles, walkable, zones, desks, meetingSeats, coffee, lobby, zoneColorAt,
    decor: { lamps, glassRoom: { x: 50, y: 19, w: 11, h: 8 }, rug },
  }
}
