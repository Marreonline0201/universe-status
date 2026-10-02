// The observer core's side of placement: how a booked place reads as a figure (plan §4.4) and how long the page will
// take to get there (§4.8). The reservation policy itself is map/places.ts (PlaceBook); this file never books.
//
//   floorPose / placePose   the floorplan's place poses as figure frames: the floorplan writes 'useU' (the useU0/useU1
//                           loop) and 'standD' (the front-facing 'stand'); every other value is already a frame name.
//                           An unknown value throws (the replay checks every endpoint of the layout).
//   walkMs                  the page's walk to a place at the one shared speed (D4: 3.2 tiles/s), from the place the
//                           worker held (the door's IN leaf when it held none). A deterministic ESTIMATE, used only to
//                           time the observer's own display steps (the end of a pull, the hand-in, the sign-out): it
//                           leaves out Path A's blocking (p50 0.1 s, door rush p90 4.5 s, §4.7) and the entry beats.
//   stance                  the steady pose and carried prop at a station, per call phase (§4.4's table): the per-call
//                           unit, the long-call pose (after 4 s in one call), stage 1 and stage 2 of a gap (§4.5).
import type { Tile } from '../map/loadMap.ts'
import type { PlaceId, PlaceLayout, Role, StationKind } from '../map/places.ts'
import type { PoseName, PropId } from '../render/props.ts'

/** One tile of walking at 3.2 tiles/s (D4). */
export const TILE_MS = 1000 / 3.2
/** Fetch-then-read: the pull at a shelf (§4.8 = the minimum beat). */
export const PULL_MS = 1200
/** Front desk: slide the paper into OUT, then sign the book (§4.8 hand-in / sign). */
export const HAND_IN_MS = 500
export const SIGN_MS = 1500

const FLOOR_POSE: Readonly<Record<string, PoseName>> = {
  useU: 'useU0', standD: 'stand', standU: 'standU', standL: 'standL', standR: 'standR', reachU: 'reachU', readU: 'readU',
  readD: 'readD', sit: 'sit',
}

/** A floorplan place pose as a figure frame; throws for a value the table does not know. */
export function floorPose(p: string): PoseName {
  const q = Object.hasOwn(FLOOR_POSE, p) ? FLOOR_POSE[p] : undefined
  if (q === undefined) throw new Error(`core/places: the floorplan pose ${p} has no figure frame`)
  return q
}

export const placePose = (layout: PlaceLayout, id: PlaceId): PoseName => floorPose(layout.place(id).pose)

export function isSeat(layout: PlaceLayout, id: PlaceId): boolean {
  const p = layout.place(id)
  return p.type === 'point' && p.how === 'sit'
}

/** Where a worker stands for the reservation policy: its place's tile (a seat is a valid origin), else the IN leaf. */
export function originOf(layout: PlaceLayout, id: PlaceId | null): Tile {
  if (id === null) return layout.map.door.inLeaf
  const p = layout.place(id)
  return { x: p.x, y: p.y }
}

/** The estimated walk from the place a worker held (null: the IN leaf) to a place, in ms. */
export function walkMs(layout: PlaceLayout, from: PlaceId | null, to: PlaceId): number {
  const d = layout.distance(originOf(layout, from), to)
  return Number.isFinite(d) ? d * TILE_MS : 0
}

/** The phase of a call at a station: in the call (unit, then long after 4 s), or a gap's stage 1 / stage 2. */
export type Sub = 'unit' | 'long' | 'stage1' | 'stage2'
export interface Stance { readonly pose: PoseName; readonly prop: PropId | null }
export type FrontPose = 'ponderD' | 'armsD'

/** The carried item of a fetch-then-read shelf (§4.4: the ledger, the book or binder, the call slip). */
const FETCH_PROP: Readonly<Partial<Record<StationKind, PropId>>> = {
  historyShelf: 'ledger', bookshelf: 'book', manualsShelf: 'book', cardCatalog: 'callSlip',
}

export interface StanceInput {
  /** The station whose object the worker uses (a sibling's own kind; for a reading place, the shelf it pulled from). */
  readonly kind: StationKind
  /** The spool activity id of the call. */
  readonly activity: string
  readonly sub: Sub
  readonly role: Role
  /** The place's own pose (placePose). */
  readonly placePose: PoseName
  readonly seat: boolean
  /** Stage 2's front pose, from the id hash (§4.5). */
  readonly front: FrontPose
  /** The call is a background shell launch (bg: type, then clip a pager to the belt, §4.4 bench row). */
  readonly bg: boolean
}

/** The steady pose and prop at a station (§4.4). Pool tiles and parked places are the caller's (they show the
 *  place's own pose). */
export function stance(s: StanceInput): Stance {
  const { kind, activity, sub, role, seat, front } = s
  const stage2: Stance = { pose: seat ? 'sitBackLean' : front, prop: null }
  const fetched = FETCH_PROP[kind]
  if (fetched !== undefined && (role === 'pull' || role === 'read' || role === 'readAtShelf')) {
    if (role === 'pull') return { pose: kind === 'cardCatalog' ? 'useU0' : 'reachU', prop: fetched }
    if (sub === 'stage2') return { pose: seat ? 'sitBack' : kind === 'historyShelf' ? 'armsD' : front, prop: fetched }
    if (role === 'readAtShelf') return { pose: 'readU', prop: fetched }
    return { pose: s.placePose, prop: fetched }   // a reading place: tile readD, ledge readU, table seat sit
  }
  const inCall = sub === 'unit' || sub === 'long'
  switch (kind) {
    case 'pcDesk':
      return { pose: sub === 'unit' ? 'type0' : sub === 'stage2' ? 'sitBackLean' : 'sitBack', prop: null }
    case 'meetingTable':
      return { pose: sub === 'stage1' ? 'sitBack' : 'sitBackNotepad', prop: null }
    case 'fileCabinet':
      if (sub === 'stage2') return { pose: front, prop: 'folder' }
      if (sub === 'unit' && activity === 'search') return { pose: 'useU0', prop: null }
      if (sub === 'unit' && activity === 'list') return { pose: 'standU', prop: null }
      if (sub === 'unit' && activity === 'refile') return { pose: 'useU0', prop: 'folder' }
      return { pose: 'readU', prop: 'folder' }                       // read; after 4 s in one call; stage 1
    case 'historyShelf':                                              // no pull: glance, stash
      if (inCall) return { pose: activity === 'stash' ? 'useU0' : 'standU', prop: null }
      return sub === 'stage1' ? { pose: 'standU', prop: null } : stage2
    case 'lectern':
      return sub === 'unit' ? { pose: 'useU0', prop: null } : sub === 'stage2' ? stage2 : { pose: 'readU', prop: null }
    case 'benchTerminal':
      if (inCall) {
        if (s.bg) return { pose: 'useU0', prop: 'pager' }
        return { pose: activity === 'watch' || activity === 'stop' ? 'useU0' : 'watchU', prop: null }
      }
      return sub === 'stage1' ? { pose: 'standU', prop: null } : stage2
    case 'kanbanBoard':
      return inCall ? { pose: 'reachU', prop: null } : sub === 'stage1' ? { pose: 'standU', prop: null } : stage2
    case 'printer':
      return { pose: 'standU', prop: null }
    case 'frontDesk':
      if (inCall) {
        if (activity === 'ask') return { pose: 'standU', prop: null }   // the handset frame is F8 (pass 2)
        return { pose: 'useU0', prop: activity === 'helper-bg' ? 'ticket' : null }
      }
      return sub === 'stage1' ? { pose: 'standU', prop: null } : stage2
    case 'lounge':
      return { pose: seat ? 'sitBack' : 'readD', prop: 'pager' }
    default:                                                         // pigeonholes, post shelf, copier, shredder
      return inCall ? { pose: 'useU0', prop: null } : sub === 'stage1' ? { pose: 'standU', prop: null } : stage2
  }
}
