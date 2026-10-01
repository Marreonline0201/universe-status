// RECORDS room furniture (plan §2 rows 3-5): file cabinets, git-history shelves, lecterns.
//
// Every function draws ONE 16×16 tile at the origin on a transparent background (the pre-render paints the room's
// floor finish underneath) and depends on nothing but its own constants: base art never depends on position
// (assets.ts:8-10; scripts/worker-office-art-check.ts compares every placed instance).
// Objects face south: the top surface is at the top of the tile, the front below it. Light comes from the upper
// left, so left and top edges catch light and right edges fall into shade.
// Geometry the state layer must line up with (drawer rows, shelf slots) is exported from here.
import { type Ctx, px } from './paint.ts'
import {
  CAB_TOP, CAB_FACE, CAB_SEAM, CAB_SHADE, CAB_PLINTH, LABEL_CARD, MONITOR_FRAME, TABLE_WOOD, TABLE_EDGE, LEDGER, GOLD,
  KRAFT, PAPER, BRASS, BANKER_GREEN, LECTERN_WOOD, SHELF_BACK, LEDGER_COLOURS, shade,
} from './palette.ts'

// ── file cabinet (step-2 catalogue: 14 px steel body cols 1-14, top rows 0-2, 4 drawers × 3 rows, plinth row 15) ─
/** Top row of drawer k (0 = top): its face row; the label and pull sit one row lower, the seam two rows lower. */
export const CABINET_DRAWER_ROW = (k: number) => 3 + 3 * k
export const CABINET_LABEL_X = 4
export const CABINET_PULL_X = 7

export function cabinetDrawerFront(g: Ctx, faceRow: number) {
  px(g, 1, faceRow, 14, 3, CAB_FACE)
  px(g, 1, faceRow, 1, 3, shade.cabFaceHi)
  px(g, 14, faceRow, 1, 3, CAB_SHADE)
  px(g, CABINET_LABEL_X, faceRow + 1, 2, 1, LABEL_CARD)
  px(g, CABINET_PULL_X, faceRow + 1, 4, 1, MONITOR_FRAME)
  px(g, 1, faceRow + 2, 14, 1, CAB_SEAM)
}

function fileCabinet(g: Ctx) {
  px(g, 1, 0, 14, 3, CAB_TOP)
  px(g, 1, 0, 14, 1, shade.cabTopHi)
  px(g, 14, 0, 1, 3, CAB_SHADE)
  for (let k = 0; k < 4; k++) cabinetDrawerFront(g, CABINET_DRAWER_ROW(k))
  px(g, 1, 15, 14, 1, CAB_PLINTH)
}

// ── history shelf (catalogue: walnut uprights, boards rows 5 / 10 / 15, ledgers rows 1-4 and 6-9, boxes 11-14) ────
/** The ledger spines, left to right on each of the two ledger shelves: [x, top row, colour]. Every ledger is 2 px
 *  wide and reaches down to its shelf board. The state layer cuts gaps at these slots; the ledger prop takes the
 *  slot's colour. */
export interface Slot { readonly x: number; readonly top: number; readonly bottom: number; readonly w: number; readonly colour: string }
const ledgerRow = (top: number, bottom: number, order: readonly number[], lows: readonly number[]): Slot[] =>
  order.map((c, i) => ({ x: 2 + 2 * i, top: lows.includes(i) ? top + 1 : top, bottom, w: 2, colour: LEDGER_COLOURS[c] }))
export const LEDGER_TOP_SHELF: readonly Slot[] = ledgerRow(1, 4, [0, 2, 1, 3, 0, 1], [2, 5])
export const LEDGER_MID_SHELF: readonly Slot[] = ledgerRow(6, 9, [1, 3, 0, 2, 1, 0], [1, 4])
/** The gilt date band's row on each shelf. */
const BAND_ROW = { top: 3, mid: 8 }

function ledgerSpine(g: Ctx, s: Slot, band: number) {
  px(g, s.x, s.top, 1, s.bottom - s.top + 1, s.colour)
  px(g, s.x + 1, s.top, 1, s.bottom - s.top + 1, shade.ledgerSpine)
  px(g, s.x, band, 2, 1, GOLD)
}

function historyShelf(g: Ctx) {
  px(g, 0, 0, 16, 16, TABLE_WOOD)
  px(g, 2, 1, 12, 4, SHELF_BACK)
  px(g, 2, 6, 12, 4, SHELF_BACK)
  px(g, 2, 11, 12, 4, SHELF_BACK)
  px(g, 0, 0, 16, 1, TABLE_EDGE)
  px(g, 0, 0, 1, 16, TABLE_EDGE)
  px(g, 15, 0, 1, 16, shade.tableLo)
  px(g, 2, 5, 12, 1, TABLE_EDGE)
  px(g, 2, 10, 12, 1, TABLE_EDGE)
  px(g, 0, 15, 16, 1, shade.tableLeg)
  for (const s of LEDGER_TOP_SHELF) ledgerSpine(g, s, BAND_ROW.top)
  for (const s of LEDGER_MID_SHELF) ledgerSpine(g, s, BAND_ROW.mid)
  // two archive boxes on the bottom shelf (kraft, white label, a darker lid edge)
  for (const x of [2, 8]) archiveBox(g, x, 11)
}

/** A 6×4 kraft archive box with its lid edge, shaded side and white label; (x, y) is its top-left corner. */
export function archiveBox(g: Ctx, x: number, y: number) {
  px(g, x, y, 6, 4, KRAFT)
  px(g, x, y, 6, 1, shade.kraftHi)
  px(g, x + 5, y + 1, 1, 3, shade.kraftLo)
  px(g, x + 2, y + 2, 2, 1, PAPER)
}

// ── lectern (catalogue: slanted top rows 2-8, post, foot row 15, reading lamp top right) ─────────────────────────
export const LECTERN_SLOPE = { x: 1, y: 2, w: 14, h: 6 } as const

function lectern(g: Ctx) {
  const s = LECTERN_SLOPE
  px(g, s.x, s.y, s.w, s.h, LECTERN_WOOD)
  px(g, s.x, s.y, s.w, 1, shade.lecternHi)
  px(g, s.x, s.y + s.h, s.w, 1, shade.lecternLo)               // the book-rest lip, row 8
  px(g, s.x + 1, s.y + s.h + 1, s.w - 2, 1, shade.lecternFoot) // the slope's underside, row 9
  px(g, 6, 10, 4, 5, shade.lecternPost)
  px(g, 9, 10, 1, 5, shade.lecternPostLo)
  px(g, 3, 15, 10, 1, shade.lecternFoot)
  // one closed ledger resting on the slope (idle)
  px(g, 5, 3, 6, 4, LEDGER)
  px(g, 5, 3, 6, 1, shade.ledgerC)
  px(g, 10, 3, 1, 4, shade.ledgerSpine)
  px(g, 5, 5, 5, 1, GOLD)
  // reading lamp: brass arm from the top-right corner, green banker's shade
  px(g, 14, 1, 1, 2, BRASS)
  px(g, 11, 0, 4, 2, BANKER_GREEN)
  px(g, 11, 0, 4, 1, shade.bankerHi)
}

export const RECORDS_TILES = { fileCabinet, historyShelf, lectern } as const
