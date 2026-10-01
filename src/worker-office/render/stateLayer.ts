// The worker office STATE LAYER (plan §2, §4.4, §6.2): what changes on an object while a real worker uses it.
//
// Two kinds of art:
//   CACHED STATE IMAGES, keyed `tileKind|state|frame` (stateKey). Each is a 16×16 overlay drawn over ONE tile of the
//     object, at that tile's origin, and rendered once (stateImage). A state's frames are its variants × its phases:
//     frame = variant * phases + phase. A VARIANT is a fixed choice made from the worker's id hash (which drawer,
//     which slot); a PHASE is a step of an animation played at `fps`.
//   LAYERS DRAWN FROM DATA (plan §2 art workload: "magnets, rack LEDs, OUT stack, kanban, clock hands, door"): the
//     in/out board's magnets, the front desk's OUT stack and IN tray, and the front door's leaves. They are drawn every
//     frame from the observer's data, allocate nothing, and each has a `sample` that draws its fullest case for the
//     checks and the sheets.
//
// Drawing rules (plan §2), held by scripts/worker-office-art-check.ts pixel by pixel:
//   - state art lives in rows 0-9 of the object tile, clear of columns 10-15 in rows 7-9: a worker standing on the
//     use spot south of the object covers rows 10-15, and its status dot sits at column 13, row 10
//     (OfficeEngine.ts:446, 460-465);
//   - nothing is drawn outside the object's own tiles;
//   - the front door is walked through, not used from the south, so the covered zone does not apply to it; its
//     leaves stay inside the door's two tiles.
// Where the step-2 catalogue's pixel notes break a rule, the rule wins: the open-book and drawer art sit higher and
// further left than the catalogue drew them, and only the TOP drawer of a file cabinet opens (a lower drawer pulled
// out would land in the covered zone), so the id hash picks which folders show instead.
import type { ObjectKind, ObjectTileKind } from '../map/loadMap.ts'
import { type Ctx, makeCanvas, px, lighten } from './paint.ts'
import { TILE } from './floors.ts'
import {
  CAB_FACE, CAB_SEAM, CAB_SHADE, LABEL_CARD, MONITOR_FRAME, MANILA, MANILA_DARK, PAPER, INK_GREY, DRAWER_WELL, TAB_ORANGE,
  TAB_BLUE, TAB_GREEN, SHELF_BACK, LEDGER, TABLE_EDGE, INK, LAMP_GLOW, LIGHT_POOL, DIFF_RED, DIFF_GREEN, BRASS,
  TERM_TEXT, LAMP_GREEN_ON, LAMP_AMBER_ON, LAMP_RED_ON, LAMP_BLUE_ON, SLIP_YELLOW, STEEL, STATUS_WORKING, STATUS_IDLE,
  STATUS_OFFLINE, shade,
} from './palette.ts'
import { CABINET_DRAWER_ROW, CABINET_LABEL_X, CABINET_PULL_X, LEDGER_TOP_SHELF, LEDGER_MID_SHELF, LECTERN_SLOPE, archiveBox, type Slot } from './tiles-records.ts'
import { BOOKS, CATALOG_FACES_X, CATALOG_FACE_ROWS, TABLE_LAMP } from './tiles-library.ts'
import { DESK_SCREEN, DESK_LED, BENCH_SCREEN, STACK_LAMPS } from './tiles-work.ts'
import { DESK_PHONE, SIGN_BOOK, IN_TRAY, OUT_TRAY, PRINT_TRAY, PRINTER_LED, MAGNET_SLOTS } from './tiles-reception.ts'

/** What drives a state (plan §2 "States, each with its driver"; documentary — the observer decides). */
export type Driver = 'presence' | 'carried' | 'in-call' | 'call-end' | 'event' | 'aggregate' | 'walker'

export interface StateArt {
  readonly kind: ObjectKind
  readonly state: string
  /** The tile it is drawn over. */
  readonly tile: ObjectTileKind
  readonly variants: number
  readonly phases: number
  /** Phases per second while playing (0: a still). */
  readonly fps: number
  readonly driver: Driver
  readonly draw: (g: Ctx, variant: number, phase: number) => void
}

export interface DataLayerArt {
  readonly kind: ObjectKind
  readonly state: string
  /** The object's tiles, left to right; the layer is drawn with the first one's origin. */
  readonly tiles: readonly ObjectTileKind[]
  readonly driver: Driver
  /** The front door: walked through, so plan §2's covered zone does not apply (it stays inside its tiles). */
  readonly walkThrough: boolean
  /** Draws the layer's fullest case at the origin (checks, sheets). */
  readonly sample: (g: Ctx) => void
}

const art = (kind: ObjectKind, state: string, tile: ObjectTileKind, driver: Driver, draw: StateArt['draw'],
  opts: { variants?: number; phases?: number; fps?: number } = {}): StateArt =>
  ({ kind, state, tile, driver, draw, variants: opts.variants ?? 1, phases: opts.phases ?? 1, fps: opts.fps ?? 0 })

// ── file cabinet ─────────────────────────────────────────────────────────────────────────────────────────────────
const FOLDER_TABS = [[4, 7, 10], [5, 8, 11]] as const
/** The folders standing in the open top drawer: tops (row 3) in two manila tones with three coloured tabs, bodies in
 *  the drawer's shadow (row 4). arrangement 0 or 1. */
function folderTops(g: Ctx, arrangement: number) {
  const r = CABINET_DRAWER_ROW(0)
  for (let x = 3; x <= 12; x++) {
    px(g, x, r, 1, 1, (x + arrangement) % 2 ? MANILA : MANILA_DARK)
    px(g, x, r + 1, 1, 1, shade.folderShadow)
  }
  FOLDER_TABS[arrangement].forEach((x, i) => px(g, x, r, 1, 1, [TAB_ORANGE, TAB_BLUE, TAB_GREEN][i]))
}
/** The top drawer pulled two rows toward the viewer: the folders show where its front was (rows 3-4), the front
 *  itself now sits on rows 5-6. */
function cabinetOpen(g: Ctx, arrangement: number) {
  const r = CABINET_DRAWER_ROW(0)
  px(g, 2, r, 12, 2, DRAWER_WELL)
  px(g, 1, r, 1, 2, shade.cabFaceHi)
  px(g, 14, r, 1, 2, CAB_SHADE)
  px(g, 2, r, 1, 2, CAB_FACE)
  px(g, 13, r, 1, 2, CAB_SHADE)
  folderTops(g, arrangement)
  px(g, 1, r + 2, 14, 1, CAB_FACE)
  px(g, 1, r + 2, 1, 1, shade.cabFaceHi)
  px(g, 14, r + 2, 1, 1, CAB_SHADE)
  px(g, CABINET_LABEL_X, r + 2, 2, 1, LABEL_CARD)
  px(g, CABINET_PULL_X, r + 2, 4, 1, MONITOR_FRAME)
  px(g, 1, r + 3, 14, 1, CAB_SEAM)
}

// ── history shelf ────────────────────────────────────────────────────────────────────────────────────────────────
/** Ledger slots a worker may pull from (the id hash picks one): the whole top shelf, and the middle shelf's slots
 *  left of column 10 (its right end lies in the covered zone). */
export const LEDGER_SLOTS: readonly Slot[] = [...LEDGER_TOP_SHELF, ...LEDGER_MID_SHELF.filter(s => s.x + s.w <= 10)]
const shelfOpeningTop = (s: Slot) => (s.bottom <= 4 ? 1 : 6)
function gap(g: Ctx, s: Slot) {
  const top = shelfOpeningTop(s)
  px(g, s.x, top, s.w, s.bottom - top + 1, SHELF_BACK)
}
/** The pull-out consultation ledge under the middle shelf with a ledger open on it (rows 6-9, columns 1-9), for a
 *  worker who reads at the shelf because every reading place is taken (plan §4.4). */
function ledgeLedger(g: Ctx) {
  px(g, 1, 6, 9, 3, LEDGER)
  px(g, 2, 6, 3, 2, PAPER)
  px(g, 6, 6, 3, 2, PAPER)
  px(g, 5, 6, 1, 3, shade.ledgerSpine)
  px(g, 2, 7, 2, 1, INK_GREY)
  px(g, 1, 9, 9, 1, TABLE_EDGE)
  px(g, 5, 8, 1, 1, shade.ribbon)
}

// ── lectern ──────────────────────────────────────────────────────────────────────────────────────────────────────
function openLedgerOnSlope(g: Ctx, x: number, marker: string, markerRow: number) {
  const y = LECTERN_SLOPE.y + 1
  px(g, x, y, 7, 4, LEDGER)
  px(g, x + 1, y, 2, 3, PAPER)
  px(g, x + 4, y, 2, 3, PAPER)
  px(g, x + 3, y, 1, 4, shade.ledgerSpine)
  px(g, x + 1, y + 1, 2, 1, INK_GREY)
  px(g, x + 4, markerRow, 2, 1, marker)
}

// ── bookshelf ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Book slots a worker may pull from (the id hash picks one; the book prop takes the slot's colour): every 2 px book
 *  on the top shelf and the middle shelf's left of column 10. */
export const BOOK_SLOTS: readonly Slot[] = [
  ...BOOKS[0].filter(b => b.w === 2),
  ...BOOKS[1].filter(b => b.w === 2 && b.x + b.w <= 10),
]

// ── card catalog ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Drawers a worker may pull (x, face row), per tile: the top row's three, and the second row's two left of column
 *  10. Pulled two rows out, a second-row drawer's face lands on rows 7-8. */
export const CATALOG_DRAWERS: readonly (readonly [number, number])[] = [
  ...CATALOG_FACES_X.map(x => [x, CATALOG_FACE_ROWS[0]] as const),
  ...CATALOG_FACES_X.filter(x => x + 3 <= 10).map(x => [x, CATALOG_FACE_ROWS[1]] as const),
]
function catalogCards(g: Ctx, x: number, row: number, raised: boolean) {
  px(g, x, row, 3, 1, PAPER)
  px(g, x + 1, row, 1, 1, shade.cardEdge)
  px(g, x, row + 1, 3, 1, shade.cardEdge)
  if (raised) px(g, x + 1, row - 1, 1, 2, PAPER)
}
function catalogDrawerOut(g: Ctx, v: number) {
  const [x, row] = CATALOG_DRAWERS[v]
  px(g, x, row, 3, 2, shade.catWell)
  catalogCards(g, x, row, false)
  px(g, x, row + 2, 3, 2, shade.catFace)
  px(g, x + 1, row + 2, 1, 1, LABEL_CARD)
  px(g, x + 1, row + 3, 1, 1, BRASS)
}

// ── reading table ────────────────────────────────────────────────────────────────────────────────────────────────
function tableLampOn(g: Ctx) {
  px(g, TABLE_LAMP.shadeX, TABLE_LAMP.shadeY + 1, TABLE_LAMP.shadeW, 1, LAMP_GLOW)
  px(g, 3, 3, 10, 3, LIGHT_POOL)
  px(g, 5, 3, 6, 2, LIGHT_POOL)
}
/** An open book in front of the sitter, left of the status dot's columns. */
function tableOpenBook(g: Ctx) {
  px(g, 2, 5, 8, 4, PAPER)
  px(g, 5, 5, 2, 4, shade.gutter)
  px(g, 2, 6, 2, 1, INK_GREY); px(g, 7, 6, 3, 1, INK_GREY)
  px(g, 2, 7, 3, 1, INK_GREY); px(g, 7, 7, 2, 1, INK_GREY)
  px(g, 2, 9, 8, 1, shade.pageEdge)
}

// ── PC desk ──────────────────────────────────────────────────────────────────────────────────────────────────────
const DESK_LINES = [5, 3, 4] as const
function deskScreen(g: Ctx, lines: number) {
  const s = DESK_SCREEN
  px(g, s.x, s.y, s.w, s.h, shade.screenLit)
  for (let i = 0; i < lines; i++) px(g, s.x + 1, s.y + 1 + i, DESK_LINES[i], 1, shade.screenLine)
}
const deskLastLine = (g: Ctx, colour: string) => px(g, DESK_SCREEN.x + 1, DESK_SCREEN.y + 3, DESK_LINES[2], 1, colour)

// ── bench terminal ───────────────────────────────────────────────────────────────────────────────────────────────
const RUN_LINES = [5, 3, 4, 2, 5, 3] as const
type Lamp = keyof typeof STACK_LAMPS
const LAMP_ON: Readonly<Record<Lamp, string>> = { blue: LAMP_BLUE_ON, red: LAMP_RED_ON, amber: LAMP_AMBER_ON, green: LAMP_GREEN_ON }
function lampOn(g: Ctx, lamp: Lamp) {
  const l = STACK_LAMPS[lamp]
  px(g, 1, l.y, 2, l.h, LAMP_ON[lamp])
  px(g, 1, l.y, 1, 1, lighten(LAMP_ON[lamp], 0.45))
}
function termLines(g: Ctx, offset: number, rows: number) {
  const s = BENCH_SCREEN
  for (let i = 0; i < rows; i++) px(g, s.x, s.y + i, RUN_LINES[(offset + i) % RUN_LINES.length], 1, TERM_TEXT)
}
const statusBar = (g: Ctx, colour: string) => px(g, BENCH_SCREEN.x, BENCH_SCREEN.y + BENCH_SCREEN.h - 1, BENCH_SCREEN.w, 1, colour)

// ── printer ──────────────────────────────────────────────────────────────────────────────────────────────────────
function printSheet(g: Ctx, phase: number) {
  const t = PRINT_TRAY
  if (phase === 0) px(g, t.x + 1, t.y, t.w - 2, 1, PAPER)
  else if (phase === 1) px(g, t.x + 1, t.y, t.w - 2, 2, PAPER)
  else {
    px(g, t.x + 1, t.y - 1, t.w - 2, 3, PAPER)
    px(g, t.x + 2, t.y, 3, 1, INK_GREY)
  }
  if (phase !== 1) px(g, PRINTER_LED.x, PRINTER_LED.y, 1, 1, LAMP_AMBER_ON)
}

// ── front desk ───────────────────────────────────────────────────────────────────────────────────────────────────
export const OUT_STACK_MAX = 5
export const IN_TRAY_MAX = 5

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────────
export const STATE_ART: readonly StateArt[] = [
  // file cabinet (plan §2 row 3, §4.4): drawerOpen = presence; folderOut / leafing / scanning = in-call
  art('fileCabinet', 'drawerOpen', 'fileCabinet', 'presence', (g, v) => cabinetOpen(g, v), { variants: 2 }),
  art('fileCabinet', 'folderOut', 'fileCabinet', 'in-call', g => {
    px(g, 3, 0, 10, 3, MANILA)
    px(g, 4, 0, 3, 2, PAPER); px(g, 9, 0, 3, 2, PAPER)
    px(g, 7, 0, 2, 3, MANILA_DARK)
    px(g, 4, 1, 2, 1, INK_GREY); px(g, 9, 1, 3, 1, INK_GREY)
  }),
  art('fileCabinet', 'leafing', 'fileCabinet', 'in-call', (g, _v, p) => {
    folderTops(g, p)
    px(g, p ? 9 : 6, CABINET_DRAWER_ROW(0) - 1, 1, 2, MANILA)
  }, { phases: 2, fps: 4 }),
  art('fileCabinet', 'scanning', 'fileCabinet', 'in-call', (g, _v, p) => px(g, 3 + 3 * p, CABINET_DRAWER_ROW(0), 1, 1, '#ffffff'),
    { phases: 4, fps: 6 }),

  // history shelf (row 4, §4.4): ledgerOut = carried; leafing / writing = in-call (at the shelf); box = stash
  art('historyShelf', 'ledgerOut', 'historyShelf', 'carried', (g, v) => gap(g, LEDGER_SLOTS[v]), { variants: LEDGER_SLOTS.length }),
  art('historyShelf', 'leafing', 'historyShelf', 'in-call', (g, _v, p) => {
    ledgeLedger(g)
    if (p === 0) px(g, 2, 6, 3, 1, shade.pageLit)
    else { px(g, 6, 6, 3, 2, shade.pageShade); px(g, 5, 4, 1, 3, PAPER) }
  }, { phases: 2, fps: 4 }),
  art('historyShelf', 'writing', 'historyShelf', 'in-call', (g, _v, p) => {
    ledgeLedger(g)
    px(g, 6, 7, p + 1, 1, INK)
    px(g, 7 + p, 6, 1, 1, shade.pen)
  }, { phases: 3, fps: 3 }),
  art('historyShelf', 'box', 'historyShelf', 'event', g => archiveBox(g, 8, 1)),

  // lectern (row 5): lampOn, compare = presence; turning = in-call
  art('lectern', 'lampOn', 'lectern', 'presence', g => {
    px(g, 11, 1, 4, 1, LAMP_GLOW)
    px(g, 7, 2, 8, 4, LIGHT_POOL)
    px(g, 9, 2, 6, 2, LIGHT_POOL)
  }),
  art('lectern', 'compare', 'lectern', 'presence', g => {
    openLedgerOnSlope(g, 1, DIFF_RED, 4)
    openLedgerOnSlope(g, 8, DIFF_GREEN, 5)
  }),
  art('lectern', 'turning', 'lectern', 'in-call', (g, _v, p) => px(g, p ? 11 : 4, LECTERN_SLOPE.y, 1, 4, '#ffffff'), { phases: 2, fps: 4 }),

  // bookshelf (row 6): bookOut = carried
  art('bookshelf', 'bookOut', 'bookshelf', 'carried', (g, v) => gap(g, BOOK_SLOTS[v]), { variants: BOOK_SLOTS.length }),

  // reading ledge (row 7): spread = presence, on the tile of the worker's stand point
  ...(['readingLedgeW', 'readingLedgeE'] as const).map(tile => art('readingLedge', 'spread', tile, 'presence', g => {
    px(g, 2, 3, 12, 4, PAPER)
    px(g, 7, 3, 2, 4, shade.gutter)
    px(g, 3, 4, 3, 1, INK_GREY); px(g, 3, 5, 2, 1, INK_GREY)
    px(g, 10, 3, 3, 2, shade.photo)
    px(g, 9, 5, 4, 1, INK_GREY)
    px(g, 2, 6, 12, 1, shade.pageEdge)
  })),

  // card catalog (row 8): drawerOut = presence; flipping = in-call (the call slip is a prop)
  ...(['cardCatalogW', 'cardCatalogE'] as const).flatMap(tile => [
    art('cardCatalog', 'drawerOut', tile, 'presence', (g, v) => catalogDrawerOut(g, v), { variants: CATALOG_DRAWERS.length }),
    art('cardCatalog', 'flipping', tile, 'in-call', (g, v, p) => {
      const [x, row] = CATALOG_DRAWERS[v]
      catalogCards(g, x, row, p === 1)
    }, { variants: CATALOG_DRAWERS.length, phases: 2, fps: 4 }),
  ]),

  // reading table (row 10): lampOn, openBook = presence, on the table tile north of the occupied chair
  ...(['readingTableW', 'readingTableC', 'readingTableE'] as const).flatMap(tile => [
    art('readingTable', 'lampOn', tile, 'presence', tableLampOn),
    art('readingTable', 'openBook', tile, 'presence', tableOpenBook),
  ]),

  // PC desk (row 11, §4.5): on = presence; typing = in-call; error = PostToolUseFailure; ok = the green line of the
  // call-end decision (§4.5 "bench and desk call results")
  art('pcDesk', 'on', 'pcDesk', 'presence', g => {
    deskScreen(g, 3)
    px(g, DESK_LED.x, DESK_LED.y, 1, 1, LAMP_GREEN_ON)
  }),
  art('pcDesk', 'typing', 'pcDesk', 'in-call', (g, _v, p) => {
    deskScreen(g, p + 1)
    px(g, DESK_SCREEN.x + 2 + DESK_LINES[p], DESK_SCREEN.y + 1 + p, 1, 1, shade.caret)
  }, { phases: 3, fps: 6 }),
  art('pcDesk', 'error', 'pcDesk', 'call-end', g => deskLastLine(g, DIFF_RED)),
  art('pcDesk', 'ok', 'pcDesk', 'call-end', g => deskLastLine(g, DIFF_GREEN)),

  // bench terminal (row 12, §4.4, §4.5): ready = presence; running = in-call; ok / fail = call-end; stopped; watching
  art('benchTerminal', 'ready', 'benchTerminal', 'presence', (g, _v, p) => {
    px(g, BENCH_SCREEN.x + 1, BENCH_SCREEN.y + 1, 1, 1, TERM_TEXT)
    if (p === 0) px(g, BENCH_SCREEN.x + 3, BENCH_SCREEN.y + 1, 1, 1, TERM_TEXT)
  }, { phases: 2, fps: 2 }),
  art('benchTerminal', 'running', 'benchTerminal', 'in-call', (g, _v, p) => {
    termLines(g, p, 4)
    if (p < 3) lampOn(g, 'amber')
  }, { phases: 6, fps: 6 }),
  art('benchTerminal', 'ok', 'benchTerminal', 'call-end', g => { termLines(g, 0, 4); statusBar(g, LAMP_GREEN_ON); lampOn(g, 'green') }),
  art('benchTerminal', 'fail', 'benchTerminal', 'call-end', g => { termLines(g, 0, 4); statusBar(g, LAMP_RED_ON); lampOn(g, 'red') }),
  art('benchTerminal', 'stopped', 'benchTerminal', 'event', (g, _v, p) => { if (p === 0) lampOn(g, 'red') }, { phases: 2, fps: 4 }),
  art('benchTerminal', 'watching', 'benchTerminal', 'event', (g, _v, p) => { if (p === 0) lampOn(g, 'blue') }, { phases: 2, fps: 4 }),

  // printer (row 18): printing = Pre -> Post (sheets rise from the slot); done = Post (pages wait in the tray)
  art('printer', 'printing', 'printer', 'in-call', (g, _v, p) => printSheet(g, p), { phases: 3, fps: 2 }),
  art('printer', 'done', 'printer', 'event', g => {
    const t = PRINT_TRAY
    px(g, t.x, t.y - 1, t.w, 3, PAPER)
    px(g, t.x, t.y + 1, t.w, 1, shade.pageEdge)
    px(g, t.x + 1, t.y - 1, 4, 1, INK_GREY); px(g, t.x + 1, t.y, 5, 1, INK_GREY)
  }),

  // front desk (row 20, §4.4): handIn / signing / ticket / onPhone (outStack and the IN tray are data layers)
  art('frontDesk', 'handIn', 'frontDeskE', 'event', (g, _v, p) => px(g, OUT_TRAY.x, OUT_TRAY.y + 2 - p, OUT_TRAY.w, 2, PAPER),
    { phases: 3, fps: 6 }),
  art('frontDesk', 'signing', 'frontDeskW', 'event', (g, _v, p) => {
    px(g, SIGN_BOOK.x, SIGN_BOOK.y + 2, p + 1, 1, INK)
    px(g, SIGN_BOOK.x + p + 1, SIGN_BOOK.y, 1, 2, shade.pen)
  }, { phases: 3, fps: 2 }),
  art('frontDesk', 'ticket', 'frontDeskE', 'event', (g, _v, p) => px(g, IN_TRAY.x + 1, [0, 1, 3][p], 3, 2, SLIP_YELLOW),
    { phases: 3, fps: 6 }),
  art('frontDesk', 'onPhone', 'frontDeskW', 'event', g => {
    const p = DESK_PHONE
    px(g, p.x, p.y, p.w, 2, shade.phone)
    px(g, p.x, p.y, 1, 1, shade.phoneHi)
    px(g, p.x + p.w - 1, p.y, 1, 1, shade.phoneHi)
    px(g, p.x - 1, p.y + 1, 1, 2, shade.handset)
  }),
]

// ── layers drawn from data ───────────────────────────────────────────────────────────────────────────────────────
/** A magnet on the in/out board: a worker inside, coloured by its state (assets.ts STATUS_COLORS), or the two
 *  phases of the arrival-hold flip gesture (plan §4.6): turned edge-on (the socket shows), then its steel back. */
export type MagnetState = 'working' | 'waiting' | 'stale' | 'flip0' | 'flip1'
const MAGNET_COLOUR: Readonly<Record<MagnetState, string | null>> = {
  working: STATUS_WORKING, waiting: STATUS_IDLE, stale: STATUS_OFFLINE, flip0: null, flip1: STEEL,
}
/** One magnet per worker inside, in arrival order (plan §4.6: the magnet appears on the real arrival event).
 *  (x0, y0): the texel origin of the board's W tile. More workers than sockets (25) is a display limit: the
 *  observer labels it; the board shows the first 25. Allocates nothing. */
export function drawMagnets(g: Ctx, x0: number, y0: number, magnets: readonly MagnetState[]) {
  const n = Math.min(magnets.length, MAGNET_SLOTS.length)
  for (let i = 0; i < n; i++) {
    const c = MAGNET_COLOUR[magnets[i]]
    if (c === null) continue
    const s = MAGNET_SLOTS[i]
    px(g, x0 + (s.part === 'E' ? TILE : 0) + s.x, y0 + s.y, 1, 1, c)
  }
}

/** The OUT tray's stack: hand-ins this session, 1 px each, capped at OUT_STACK_MAX (step-2 catalogue).
 *  (x0, y0): the texel origin of the front desk's E tile. */
export function drawOutStack(g: Ctx, x0: number, y0: number, n: number) {
  const k = Math.max(0, Math.min(OUT_STACK_MAX, Math.floor(n)))
  for (let i = 0; i < k; i++) px(g, x0 + OUT_TRAY.x, y0 + OUT_TRAY.y + 2 - i, OUT_TRAY.w, 1, i === k - 1 ? PAPER : shade.pageEdge)
}

/** The IN tray: tickets dropped by workers launching a background helper (plan §4.2), capped at IN_TRAY_MAX.
 *  (x0, y0): the texel origin of the front desk's E tile. */
export function drawInTray(g: Ctx, x0: number, y0: number, n: number) {
  const k = Math.max(0, Math.min(IN_TRAY_MAX, Math.floor(n)))
  for (let i = 0; i < k; i++) px(g, x0 + IN_TRAY.x + (i % 2), y0 + IN_TRAY.y + 2 - i, 3, 1, i % 2 ? shade.slipPale : SLIP_YELLOW)
}

/** Glass glints on a leaf, relative to its left edge (texels). Module constants: the leaves are drawn every frame. */
const LEAF_GLINT_X: readonly number[] = [3, 4, 5, 9, 10]
const LEAF_GLINT_Y: readonly number[] = [6, 7, 8, 6, 7]

/** The front door's two sliding glass leaves, in texels, with the world origin at the door's top-left tile.
 *  open = 0 (closed) .. 1 (fully open, each leaf slid into its side pocket). The door opens only for a real
 *  arriving or leaving worker within 2 tiles (plan §1.2). Called every frame: allocates nothing. */
export function doorLeaves(g: Ctx, x0: number, y0: number, open: number) {
  const slide = Math.round(Math.max(0, Math.min(1, open)) * 14)
  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? -1 : 1
    const lx = x0 + i * TILE + (i === 0 ? 1 : 0) + dir * slide
    const w = 15
    const clipL = x0 + (i === 0 ? 1 : TILE), clipR = x0 + (i === 0 ? TILE : 2 * TILE - 1)
    const a = Math.max(lx, clipL), b = Math.min(lx + w, clipR)
    if (b <= a) continue
    px(g, a, y0 + 5, b - a, 9, 'rgba(170,214,222,0.42)')
    px(g, a, y0 + 5, b - a, 1, shade.alu)
    px(g, a, y0 + 13, b - a, 1, shade.alu)
    if (lx >= clipL) px(g, lx, y0 + 5, 1, 9, shade.alu)
    if (lx + w <= clipR) px(g, lx + w - 1, y0 + 5, 1, 9, shade.alu)
    const hx = i === 0 ? lx + w - 3 : lx + 2
    if (hx >= a && hx < b) px(g, hx, y0 + 8, 1, 3, '#dfe4e8')
    for (let j = 0; j < LEAF_GLINT_X.length; j++) {
      const sx = lx + LEAF_GLINT_X[j]
      if (sx >= a && sx < b) px(g, sx, y0 + LEAF_GLINT_Y[j], 1, 1, 'rgba(255,255,255,0.35)')
    }
  }
}

const FULL_BOARD: readonly MagnetState[] = MAGNET_SLOTS.map((_, i) => (['working', 'waiting', 'stale', 'flip1'] as const)[i % 4])
const DOOR = ['doorOutLeaf', 'doorInLeaf'] as const
export const DATA_LAYERS: readonly DataLayerArt[] = [
  { kind: 'inOutBoard', state: 'magnets', tiles: ['inOutBoardW', 'inOutBoardE'], driver: 'aggregate', walkThrough: false, sample: g => drawMagnets(g, 0, 0, FULL_BOARD) },
  { kind: 'inOutBoard', state: 'flip', tiles: ['inOutBoardW', 'inOutBoardE'], driver: 'event', walkThrough: false,
    sample: g => drawMagnets(g, 0, 0, MAGNET_SLOTS.map((_, i): MagnetState => (i % 2 ? 'flip1' : 'flip0'))) },
  { kind: 'frontDesk', state: 'outStack', tiles: ['frontDeskW', 'frontDeskE'], driver: 'aggregate', walkThrough: false, sample: g => drawOutStack(g, TILE, 0, OUT_STACK_MAX) },
  { kind: 'frontDesk', state: 'inTray', tiles: ['frontDeskW', 'frontDeskE'], driver: 'aggregate', walkThrough: false, sample: g => drawInTray(g, TILE, 0, IN_TRAY_MAX) },
  { kind: 'frontDoor', state: 'closed', tiles: DOOR, driver: 'walker', walkThrough: true, sample: g => doorLeaves(g, 0, 0, 0) },
  { kind: 'frontDoor', state: 'opening', tiles: DOOR, driver: 'walker', walkThrough: true, sample: g => doorLeaves(g, 0, 0, 0.5) },
  { kind: 'frontDoor', state: 'open', tiles: DOOR, driver: 'walker', walkThrough: true, sample: g => doorLeaves(g, 0, 0, 1) },
  { kind: 'frontDoor', state: 'closing', tiles: DOOR, driver: 'walker', walkThrough: true, sample: g => doorLeaves(g, 0, 0, 0.75) },
]

// ── keys and the cache ───────────────────────────────────────────────────────────────────────────────────────────
export const stateKey = (tile: ObjectTileKind, state: string, frame: number) => `${tile}|${state}|${frame}`
const byTileState = new Map(STATE_ART.map(a => [`${a.tile}|${a.state}`, a]))

/** Every cached state image's key, in registry order. */
export function stateKeys(): string[] {
  return STATE_ART.flatMap(a => Array.from({ length: a.variants * a.phases }, (_, f) => stateKey(a.tile, a.state, f)))
}

/** The state of a tile kind, or undefined. */
export const stateArt = (tile: ObjectTileKind, state: string): StateArt | undefined => byTileState.get(`${tile}|${state}`)

const cache = new Map<string, HTMLCanvasElement>()
let renders = 0
/** How many state images have been rendered (each key at most once). */
export const stateRenders = () => renders

/** The cached 16×16 overlay for a key `tile|state|frame`. Throws on an unknown key. */
export function stateImage(key: string): HTMLCanvasElement {
  const hit = cache.get(key)
  if (hit) return hit
  const m = /^([^|]+)\|([^|]+)\|(\d+)$/.exec(key)
  const a = m ? byTileState.get(`${m[1]}|${m[2]}`) : undefined
  const frame = m ? Number(m[3]) : -1
  if (!a || frame >= a.variants * a.phases) throw new Error(`unknown state image ${key}`)
  const [c, g] = makeCanvas(TILE, TILE)
  a.draw(g, Math.floor(frame / a.phases), frame % a.phases)
  renders++
  cache.set(key, c)
  return c
}
