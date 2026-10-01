// The furniture registry (plan §6.2): tile kind -> its art, rendered ONCE per kind into a 16×16 canvas and blitted
// wherever that kind stands. Base art never depends on position (assets.ts:8-10), so the kind is the whole cache key.
//
// Pass 1 is the vertical slice (plan §6 "pass 1 is a vertical slice"): the kinds in PASS_1_KINDS get real art here.
// Every other kind keeps its step-1 placeholder (placeholders.ts) until pass 2; PASS_2_KINDS lists them, and
// scripts/worker-office-art-check.ts holds both lists to plan §6.
import type { ObjectKind, ObjectTileKind } from '../map/loadMap.ts'
import { type Ctx, makeCanvas } from './paint.ts'
import { TILE } from './floors.ts'
import { RECORDS_TILES } from './tiles-records.ts'
import { LIBRARY_TILES, LIBRARY_SEATS } from './tiles-library.ts'
import { WORK_TILES, WORK_SEATS } from './tiles-work.ts'
import { RECEPTION_TILES } from './tiles-reception.ts'
import { LOUNGE_TILES, LOUNGE_SEATS } from './tiles-lounge.ts'

export type TileArt = (g: Ctx) => void
export interface SeatParts { readonly seat: TileArt; readonly backrest: TileArt }

/** Every furniture tile kind with real art. */
export const FURNITURE_ART: Readonly<Partial<Record<ObjectTileKind, TileArt>>> = {
  ...RECORDS_TILES, ...LIBRARY_TILES, ...WORK_TILES, ...RECEPTION_TILES, ...LOUNGE_TILES,
}

/** North-facing seats, drawn as seat + backrest (the backrest in rows 8-15, plan §2). The tile is both, in order. */
export const SEAT_PARTS: Readonly<Partial<Record<ObjectTileKind, SeatParts>>> = { ...LIBRARY_SEATS, ...WORK_SEATS, ...LOUNGE_SEATS }

/** Plan §6 pass 1 (the slice): front door, front desk, printer, in/out board, file cabinets, history shelves,
 *  lecterns, bench terminals, PC desks and their task chairs, bookshelves, card catalog, reading ledge, reading table
 *  and its chairs, lounge sofa and armchairs. (The door is ground + state layer, not furniture: floors.ts and
 *  stateLayer.ts.) */
export const PASS_1_KINDS: readonly ObjectKind[] = [
  'frontDoor', 'frontDesk', 'printer', 'inOutBoard', 'fileCabinet', 'historyShelf', 'lectern', 'benchTerminal', 'pcDesk',
  'taskChairN', 'bookshelf', 'cardCatalog', 'readingLedge', 'readingTable', 'woodChairN', 'sofaN', 'armchairN',
]
/** Plan §6 pass 2 (the long tail), still on placeholders: kanban, meeting, pigeonholes, post shelf, copier, shredder,
 *  manuals, kitchen, decor, clock, notice board. */
export const PASS_2_KINDS: readonly ObjectKind[] = [
  'kanbanBoard', 'meetingTable', 'pigeonholes', 'postShelf', 'copier', 'shredder', 'manualsShelf',
  'fridge', 'sink', 'espressoMachine', 'waterCooler',
  'plant', 'coatStand', 'floorLamp', 'visitorChair', 'receptionChair', 'ups', 'serverRack',
  'wallClock', 'noticeBoard',
]

/** Seats that, for shadows, lie flat like the floor (step-2 catalogue shadow set "FLOOR_LIKE seat tile"): they cast
 *  no contact shadow. (A worker sitting on any seat gets none either: props.ts HAND[pose].seated, plan §6.2.) */
export const NO_CONTACT_SHADOW: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['taskChairN', 'woodChairN'])

export const hasFurnitureArt = (kind: ObjectTileKind): boolean => FURNITURE_ART[kind] !== undefined

const cache = new Map<ObjectTileKind, HTMLCanvasElement>()
let renders = 0
/** How many furniture tiles have been rendered (one per kind, ever). */
export const furnitureRenders = () => renders

/** The cached 16×16 canvas of a furniture tile kind. Throws for a kind without art (use the placeholder). */
export function furnitureTile(kind: ObjectTileKind): HTMLCanvasElement {
  const hit = cache.get(kind)
  if (hit) return hit
  const art = FURNITURE_ART[kind]
  if (!art) throw new Error(`no furniture art for tile kind ${kind}`)
  const [c, g] = makeCanvas(TILE, TILE)
  art(g)
  renders++
  cache.set(kind, c)
  return c
}
