// Office layout generator: builds the tile grid, team zones, and desk assignments
// from the live roster — no hardcoded per-agent coordinates anywhere.
// Layout: 4 team zones on top, 3 on the bottom, a central corridor, and a commons
// room (meeting table + coffee + the director's desk) bottom-right.
import type { OfficeAgent, OfficeTeam } from '../hooks/useOfficeSocket'
import type { TileKind } from './assets'
import type { Point } from './pathfind'

export const MAP_W = 66
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

  // Zone slots: 4 top (interior y 1..12), 3 bottom (interior y 18..30, x 1..47).
  const slots = [
    ...[0, 1, 2, 3].map(i => ({ x: 1 + i * 16, y: 1, h: 12, top: true })),
    ...[0, 1, 2].map(i => ({ x: 1 + i * 16, y: 18, h: 13, top: false })),
  ]

  const byTeam = new Map<string, OfficeAgent[]>()
  for (const a of agents) {
    if (!byTeam.has(a.team)) byTeam.set(a.team, [])
    byTeam.get(a.team)!.push(a)
  }

  teams.slice(0, 7).forEach((team, ti) => {
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

    // whiteboard on the outer wall behind the lead desk
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

  // Commons room: x 49..64, y 18..30 — meeting table, coffee, director's desk.
  for (let y = 18; y <= 30; y++) for (let x = 49; x < MAP_W - 1; x++) set(x, y, 'floor')
  for (let x = 48; x < MAP_W - 1; x++) { if (x !== 55 && x !== 56) set(x, 17, 'wall', true) }
  for (let y = 17; y <= 30; y++) set(48, y, 'wall', true)

  const meetingSeats: Point[] = []
  for (let x = 51; x <= 56; x++) {
    set(x, 22, 'meetTable', true)
    set(x, 23, 'meetTable', true)
    meetingSeats.push({ x, y: 21 }, { x, y: 24 })
  }
  const coffee: Point = { x: 63, y: 19 }
  set(coffee.x, coffee.y, 'coffee', true)
  set(49, 30, 'plant', true)
  set(63, 30, 'plant', true)

  // director's desk in the commons
  const directorSpot: DeskSpot = { desk: { x: 60, y: 27 }, chair: { x: 60, y: 28 } }
  set(directorSpot.desk.x, directorSpot.desk.y, 'desk', true)
  set(directorSpot.chair.x, directorSpot.chair.y, 'chair')
  for (const a of agents) if (a.team === 'company') desks.set(a.id, directorSpot)

  const lobby: Point = { x: 55, y: 15 }

  const walkable = (x: number, y: number) =>
    x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1 && !solid.has(`${x},${y}`)

  const zoneColorAt = (x: number, y: number) => {
    for (const z of zones) {
      if (x >= z.rect.x && x < z.rect.x + z.rect.w && y >= z.rect.y && y < z.rect.y + z.rect.h) return z.color
    }
    return undefined
  }

  return { width: MAP_W, height: MAP_H, tiles, walkable, zones, desks, meetingSeats, coffee, lobby, zoneColorAt }
}
