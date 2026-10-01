// The worker office STATE LAYER (plan §2, §4.4, §6.2): what changes on an object while a real worker uses it.
//
// Two kinds of art:
//   CACHED STATE IMAGES. Each is a 16×16 overlay drawn over ONE tile of the object, at that tile's origin, and
//     rendered once. A state's frames are its variants × its phases: frame = variant * phases + phase.
//     A VARIANT is a fixed choice of what the state shows. For a POINT state (presence, in-call, call-end, event:
//     plan §4.4 "State keys", keyed by (point, worker)) the worker's id hash picks it, variant = hash mod variants,
//     for every state of the visit, so a state and its base with the same variant count pair up (the card-catalog
//     drawer and the cards flipped in it). For a CARRIED state (ledgerOut, bookOut: keyed by (shelf slot, worker))
//     the variant is the slot the worker really pulled, so one shelf shows a gap per carrier, several at once.
//     A PHASE is a step of an animation. Its rate `fps` is NOMINAL: each worker plays it at its own loop rate from
//     its own phase offset (plan §4.8; statePhase()), so the six desks and eight benches never animate in lockstep.
//     A loop the worker's hands drive (typing, leafing, writing, turning, flipping) is nominally 4 fps: times the
//     worker's rate factor, 0.85-1.15, that is plan §4.8's "use/type loops 3.4-4.6 fps per worker".
//     The renderer resolves a state ONCE, when a worker's state changes (stateFrames(tile, state), baseChain(art)),
//     then indexes the frames on every draw: no key string is built per frame. The `tile|state|frame` keys
//     (stateKey, stateImage) are for the checks and the sheets.
//   LAYERS DRAWN FROM DATA (plan §2 art workload: "magnets, rack LEDs, OUT stack, kanban, clock hands, door"): the
//     in/out board's magnets, the front desk's OUT stack and IN tray, and the front door's leaves. They are drawn every
//     frame from the observer's data, allocate nothing, and each has a `sample` that draws its fullest case for the
//     sheets (the art check sweeps every input).
//
// STACKING. A point shows one point state at a time, drawn over its BASE CHAIN, base first: in-call and call-end art
// sits on the presence state that stays on through the visit (plan §4.4: the lectern's pages turn over the two open
// ledgers, under the lit lamp; the desk's result line shows on the lit screen). Reading at a shelf (the history
// shelf's leafing and writing, at its ledge) has the reader's own carried gap as its base: it pulled the ledger first.
// Carried gaps are drawn for every carrier, under any point state. A state without a base replaces what the object
// showed: the bench's output fills its screen in place of the ready cursor. composeState() draws a state with its
// chain (the sheets use it).
//
// Drawing rules (plan §2), held by scripts/worker-office-art-check.ts pixel by pixel:
//   - state art lives in rows 0-9 of the object tile, clear of columns 10-15 in rows 7-9: a worker standing on the
//     use spot south of the object covers rows 10-15, and its status dot sits at column 13, row 10
//     (OfficeEngine.ts:446, 460-465);
//   - nothing is drawn outside the object's own tiles;
//   - the front door is walked through, not used from the south, so the covered zone does not apply to it; its
//     leaves stay inside the door's two tiles.
// Where the step-2 catalogue's pixel notes, or plan §4.4's wording, break a rule or contradict the plan elsewhere,
// the rule wins:
//   - only the TOP drawer of a file cabinet opens (a lower drawer pulled out would land in the covered zone), so
//     the id hash picks which folders show instead of which drawer opens;
//   - the Glob / list glint runs ACROSS the folder tops in that open drawer, not "down the labels" (§4.4): only the
//     top two drawers' labels lie outside the covered zone, and with the drawer open the names being listed are
//     the folders';
//   - a Read lifts the folder into the worker's hand (§4.4 "lift a manila folder, readU"), so folderOut shows the
//     gap it left in the drawer: the catalogue's folder lying open on the cabinet top would make two folders;
//   - the open-book and drawer art sit higher and further left than the catalogue drew them.
import type { ObjectKind, ObjectTileKind } from '../map/loadMap.ts'
import { type Ctx, makeCanvas, px } from './paint.ts'
import { TILE } from './floors.ts'
import {
  CAB_FACE, CAB_SEAM, CAB_SHADE, LABEL_CARD, MONITOR_FRAME, MANILA, MANILA_DARK, PAPER, INK_GREY, DRAWER_WELL, TAB_ORANGE,
  TAB_BLUE, TAB_GREEN, SHELF_BACK, LEDGER, TABLE_EDGE, INK, LAMP_GLOW, LIGHT_POOL, DIFF_RED, DIFF_GREEN, BRASS,
  TERM_TEXT, LAMP_GREEN_ON, LAMP_AMBER_ON, LAMP_RED_ON, SLIP_YELLOW, STATUS_IDLE, STATUS_OFFLINE, SPECULAR,
  STACK_LAMP_ON, STACK_LAMP_HI, DOOR_GLASS, DOOR_HANDLE, GLASS_GLINT, shade,
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
  /** NOMINAL phases per second (0: a still): a worker plays the state at its own rate and phase (statePhase). */
  readonly fps: number
  readonly driver: Driver
  /** The state of the same tile this one is drawn over (see STACKING above), or null: drawn on the furniture. */
  readonly base: string | null
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
  /** Draws the layer's fullest case at the origin (sheets). */
  readonly sample: (g: Ctx) => void
}

const art = (kind: ObjectKind, state: string, tile: ObjectTileKind, driver: Driver, draw: StateArt['draw'],
  opts: { variants?: number; phases?: number; fps?: number; base?: string } = {}): StateArt =>
  ({ kind, state, tile, driver, draw, variants: opts.variants ?? 1, phases: opts.phases ?? 1, fps: opts.fps ?? 0, base: opts.base ?? null })

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
/** Where a lifted folder leaves its 2 px gap among the folder tops (the id hash picks one). */
const FOLDER_GAPS = [4, 7, 10] as const

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
function lampOn(g: Ctx, lamp: Lamp) {
  const l = STACK_LAMPS[lamp]
  px(g, 1, l.y, 2, l.h, STACK_LAMP_ON[lamp])
  px(g, 1, l.y, 1, 1, STACK_LAMP_HI[lamp])
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
/** The handset's coiled cord, stretched from the phone base down over the desk front toward the worker standing
 *  south of it (whose head hides the rest, rows 10+): a zig-zag of 1 px coils, left of the status dot's columns. */
const PHONE_CORD: readonly (readonly [number, number])[] = [[3, 6], [4, 7], [3, 8], [4, 9]]
/** AskUserQuestion (plan §4.4 "lift the handset until the next event"): the handset is at the worker's ear, so the
 *  cradle stands empty — the desk shows between its two prongs where the handset lay, the hook switch is up — and
 *  the cord runs to the worker. */
function phoneLifted(g: Ctx) {
  const p = DESK_PHONE
  px(g, p.x + 1, p.y, p.w - 2, 1, shade.stoneHi)          // the desk top the handset hid
  px(g, p.x, p.y, 1, 2, shade.phone)                       // the cradle's two prongs
  px(g, p.x + p.w - 1, p.y, 1, 2, shade.phone)
  px(g, p.x + 1, p.y + 1, p.w - 2, 1, shade.handset)       // the empty rest between them
  px(g, p.x + 2, p.y + 1, 1, 1, INK_GREY)                  // the hook switch, up
  for (const [x, y] of PHONE_CORD) px(g, x, y, 1, 1, shade.handset)
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────────
export const STATE_ART: readonly StateArt[] = [
  // file cabinet (plan §2 row 3, §4.4): drawerOpen = presence; folderOut / leafing / scanning = in-call, in the open
  // drawer (the header says why only the top drawer opens, why the glint runs across, and why folderOut is a gap)
  art('fileCabinet', 'drawerOpen', 'fileCabinet', 'presence', (g, v) => cabinetOpen(g, v), { variants: 2 }),
  art('fileCabinet', 'folderOut', 'fileCabinet', 'in-call', (g, v) => px(g, FOLDER_GAPS[v], CABINET_DRAWER_ROW(0), 2, 2, DRAWER_WELL),
    { variants: FOLDER_GAPS.length, base: 'drawerOpen' }),
  art('fileCabinet', 'leafing', 'fileCabinet', 'in-call', (g, _v, p) => {
    folderTops(g, p)
    px(g, p ? 9 : 6, CABINET_DRAWER_ROW(0) - 1, 1, 2, MANILA)
  }, { phases: 2, fps: 4, base: 'drawerOpen' }),
  art('fileCabinet', 'scanning', 'fileCabinet', 'in-call', (g, _v, p) => px(g, 3 + 3 * p, CABINET_DRAWER_ROW(0), 1, 1, SPECULAR),
    { phases: 4, fps: 6, base: 'drawerOpen' }),

  // history shelf (row 4, §4.4): ledgerOut = carried; leafing / writing = in-call, at the shelf's ledge with the
  // pulled ledger's gap showing; box = stash
  art('historyShelf', 'ledgerOut', 'historyShelf', 'carried', (g, v) => gap(g, LEDGER_SLOTS[v]), { variants: LEDGER_SLOTS.length }),
  art('historyShelf', 'leafing', 'historyShelf', 'in-call', (g, _v, p) => {
    ledgeLedger(g)
    if (p === 0) px(g, 2, 6, 3, 1, shade.pageLit)
    else { px(g, 6, 6, 3, 2, shade.pageShade); px(g, 5, 4, 1, 3, PAPER) }
  }, { phases: 2, fps: 4, base: 'ledgerOut' }),
  art('historyShelf', 'writing', 'historyShelf', 'in-call', (g, _v, p) => {
    ledgeLedger(g)
    px(g, 6, 7, p + 1, 1, INK)
    px(g, 7 + p, 6, 1, 1, shade.pen)
  }, { phases: 3, fps: 4, base: 'ledgerOut' }),
  art('historyShelf', 'box', 'historyShelf', 'event', g => archiveBox(g, 8, 1)),

  // lectern (row 5): lampOn, compare = presence (the ledgers close at stage 2, the lamp stays on); turning = in-call
  art('lectern', 'lampOn', 'lectern', 'presence', g => {
    px(g, 11, 1, 4, 1, LAMP_GLOW)
    px(g, 7, 2, 8, 4, LIGHT_POOL)
    px(g, 9, 2, 6, 2, LIGHT_POOL)
  }),
  art('lectern', 'compare', 'lectern', 'presence', g => {
    openLedgerOnSlope(g, 1, DIFF_RED, 4)
    openLedgerOnSlope(g, 8, DIFF_GREEN, 5)
  }, { base: 'lampOn' }),
  art('lectern', 'turning', 'lectern', 'in-call', (g, _v, p) => px(g, p ? 11 : 4, LECTERN_SLOPE.y, 1, 4, SPECULAR),
    { phases: 2, fps: 4, base: 'compare' }),

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

  // card catalog (row 8): drawerOut = presence; flipping = in-call, in that drawer (the call slip is a prop)
  ...(['cardCatalogW', 'cardCatalogE'] as const).flatMap(tile => [
    art('cardCatalog', 'drawerOut', tile, 'presence', (g, v) => catalogDrawerOut(g, v), { variants: CATALOG_DRAWERS.length }),
    art('cardCatalog', 'flipping', tile, 'in-call', (g, v, p) => {
      const [x, row] = CATALOG_DRAWERS[v]
      catalogCards(g, x, row, p === 1)
    }, { variants: CATALOG_DRAWERS.length, phases: 2, fps: 4, base: 'drawerOut' }),
  ]),

  // reading table (row 10): lampOn, openBook = presence, on the table tile north of the occupied chair (the book
  // closes at stage 2, the lamp stays on)
  ...(['readingTableW', 'readingTableC', 'readingTableE'] as const).flatMap(tile => [
    art('readingTable', 'lampOn', tile, 'presence', tableLampOn),
    art('readingTable', 'openBook', tile, 'presence', tableOpenBook, { base: 'lampOn' }),
  ]),

  // PC desk (row 11, §4.5): on = presence; typing = in-call; error = PostToolUseFailure; ok = the green line of the
  // call-end decision (§4.5 "bench and desk call results"); all three on the lit screen
  art('pcDesk', 'on', 'pcDesk', 'presence', g => {
    deskScreen(g, 3)
    px(g, DESK_LED.x, DESK_LED.y, 1, 1, LAMP_GREEN_ON)
  }),
  art('pcDesk', 'typing', 'pcDesk', 'in-call', (g, _v, p) => {
    deskScreen(g, p + 1)
    px(g, DESK_SCREEN.x + 2 + DESK_LINES[p], DESK_SCREEN.y + 1 + p, 1, 1, shade.caret)
  }, { phases: 3, fps: 4, base: 'on' }),   // a line per keystroke beat: the worker's type loop (the header)
  art('pcDesk', 'error', 'pcDesk', 'call-end', g => deskLastLine(g, DIFF_RED), { base: 'on' }),
  art('pcDesk', 'ok', 'pcDesk', 'call-end', g => deskLastLine(g, DIFF_GREEN), { base: 'on' }),

  // bench terminal (row 12, §4.4, §4.5): ready = presence; running = in-call; ok / fail = call-end (running, ok and
  // fail fill the screen: they replace ready); stopped (TaskStop / kill: red flashes) and watching (Monitor: blue
  // blinks) light a lamp over ready
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
  art('benchTerminal', 'stopped', 'benchTerminal', 'event', (g, _v, p) => { if (p === 0) lampOn(g, 'red') }, { phases: 2, fps: 4, base: 'ready' }),
  art('benchTerminal', 'watching', 'benchTerminal', 'event', (g, _v, p) => { if (p === 0) lampOn(g, 'blue') }, { phases: 2, fps: 4, base: 'ready' }),

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
  art('frontDesk', 'onPhone', 'frontDeskW', 'event', phoneLifted),
]

// ── layers drawn from data ───────────────────────────────────────────────────────────────────────────────────────
/** A magnet on the in/out board: a worker inside, coloured by its state (assets.ts STATUS_COLORS, the working cyan
 *  darkened to read on the white board: palette.ts shade.magnetWorking), or the two phases of the arrival-hold flip
 *  gesture (plan §4.6): turned edge-on (no ink: the socket shows), then its steel back. */
export type MagnetState = 'working' | 'waiting' | 'stale' | 'flip0' | 'flip1'
export const MAGNET_STATES: readonly MagnetState[] = ['working', 'waiting', 'stale', 'flip0', 'flip1']
const MAGNET_COLOUR: Readonly<Record<MagnetState, string | null>> = {
  working: shade.magnetWorking, waiting: STATUS_IDLE, stale: STATUS_OFFLINE, flip0: null, flip1: shade.magnetBack,
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
/** How far a leaf slides, in whole texels, from closed (0) to open (DOOR_SLIDE_MAX). */
export const DOOR_SLIDE_MAX = 14

/** The front door's two sliding glass leaves, in texels, with the world origin at the door's top-left tile.
 *  open = 0 (closed) .. 1 (fully open, each leaf slid into its side pocket). The door opens only for a real
 *  arriving or leaving worker within 2 tiles (plan §1.2). Called every frame: allocates nothing. */
export function doorLeaves(g: Ctx, x0: number, y0: number, open: number) {
  const slide = Math.round(Math.max(0, Math.min(1, open)) * DOOR_SLIDE_MAX)
  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? -1 : 1
    const lx = x0 + i * TILE + (i === 0 ? 1 : 0) + dir * slide
    const w = 15
    const clipL = x0 + (i === 0 ? 1 : TILE), clipR = x0 + (i === 0 ? TILE : 2 * TILE - 1)
    const a = Math.max(lx, clipL), b = Math.min(lx + w, clipR)
    if (b <= a) continue
    px(g, a, y0 + 5, b - a, 9, DOOR_GLASS)
    px(g, a, y0 + 5, b - a, 1, shade.alu)
    px(g, a, y0 + 13, b - a, 1, shade.alu)
    if (lx >= clipL) px(g, lx, y0 + 5, 1, 9, shade.alu)
    if (lx + w <= clipR) px(g, lx + w - 1, y0 + 5, 1, 9, shade.alu)
    const hx = i === 0 ? lx + w - 3 : lx + 2
    if (hx >= a && hx < b) px(g, hx, y0 + 8, 1, 3, DOOR_HANDLE)
    for (let j = 0; j < LEAF_GLINT_X.length; j++) {
      const sx = lx + LEAF_GLINT_X[j]
      if (sx >= a && sx < b) px(g, sx, y0 + LEAF_GLINT_Y[j], 1, 1, GLASS_GLINT)
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

// ── lookup, frames and the cache ─────────────────────────────────────────────────────────────────────────────────
const byTile = new Map<ObjectTileKind, Map<string, StateArt>>()
for (const a of STATE_ART) {
  let m = byTile.get(a.tile)
  if (!m) byTile.set(a.tile, (m = new Map()))
  m.set(a.state, a)
}
/** The state of a tile kind, or undefined. Builds no string. */
export const stateArt = (tile: ObjectTileKind, state: string): StateArt | undefined => byTile.get(tile)?.get(state)

/** Per state, its rendered frames by index (filled lazily). */
const frames = new Map<StateArt, HTMLCanvasElement[]>()
let renders = 0
/** How many state images have been rendered (each frame of each state at most once). */
export const stateRenders = () => renders

function frameOf(a: StateArt, f: number): HTMLCanvasElement {
  let list = frames.get(a)
  if (!list) frames.set(a, (list = []))
  const hit = list[f]
  if (hit) return hit
  const [c, g] = makeCanvas(TILE, TILE)
  a.draw(g, Math.floor(f / a.phases), f % a.phases)
  renders++
  list[f] = c
  return c
}

/** Every frame of a state, indexed frame = variant * phases + phase. Resolve it ONCE (when a worker's state changes)
 *  and index it on each draw, so nothing is allocated per frame. The same array comes back every time. Throws for an
 *  unknown state. */
export function stateFrames(tile: ObjectTileKind, state: string): readonly HTMLCanvasElement[] {
  const a = stateArt(tile, state)
  if (!a) throw new Error(`unknown state ${tile}|${state}`)
  for (let f = 0; f < a.variants * a.phases; f++) frameOf(a, f)
  return frames.get(a)!
}

/** The states drawn under `a`, deepest first (empty when it has no base). Throws on a base that is not a state of
 *  the same tile, or on bases that loop back to a state already in the chain (by name, `a` included). Resolve it
 *  once per state, like stateFrames. */
export function baseChain(a: StateArt): StateArt[] {
  const out: StateArt[] = []
  const seen = new Set<string>([a.state])
  for (let name = a.base; name !== null;) {
    if (seen.has(name)) throw new Error(`${a.tile}|${a.state}: its bases loop at ${name}`)
    seen.add(name)
    const b = stateArt(a.tile, name)
    if (!b) throw new Error(`${a.tile}|${a.state}: base ${name} is not a state of ${a.tile}`)
    out.unshift(b)
    name = b.base
  }
  return out
}

/** Draw frame `frame` of `a` at (x, y) over its base chain, each base as a worker would show it under that frame:
 *  the same variant when the counts match (one id hash picks both), else variant 0; phase 0. For the sheets. */
export function composeState(g: Ctx, a: StateArt, frame: number, x = 0, y = 0) {
  const v = Math.floor(frame / a.phases)
  for (const b of baseChain(a)) g.drawImage(frameOf(b, (b.variants === a.variants ? v : 0) * b.phases), x, y)
  g.drawImage(frameOf(a, frame), x, y)
}

/** The phase a worker's copy of `a` shows at time t (seconds). `fps` is nominal: the worker plays the state at
 *  `rate` × fps, rate being its own loop-rate factor (0.85-1.15: plan §4.8 "use/type loops 3.4-4.6 fps per worker"
 *  for the nominal 4 fps of a hand loop), from its own phase `offset` (a fraction of one cycle, 0-1), both from its
 *  id hash, so identical objects never animate in lockstep. (Plan §4.4's tempo τ MULTIPLIES beat durations; a worker
 *  whose loops should match its beats passes rate = 1 / τ.) Allocates nothing. */
export function statePhase(a: StateArt, t: number, rate: number, offset: number): number {
  if (a.phases <= 1 || a.fps <= 0) return 0
  const k = Math.floor(t * a.fps * rate + offset * a.phases) % a.phases
  return k < 0 ? k + a.phases : k
}

/** The key of one cached image, `tile|state|frame` (checks and sheets; the renderer indexes stateFrames). */
export const stateKey = (tile: ObjectTileKind, state: string, frame: number) => `${tile}|${state}|${frame}`

/** Every cached state image's key, in registry order. */
export function stateKeys(): string[] {
  return STATE_ART.flatMap(a => Array.from({ length: a.variants * a.phases }, (_, f) => stateKey(a.tile, a.state, f)))
}

/** The cached 16×16 overlay for a key `tile|state|frame` (the same canvas stateFrames holds). Throws on an unknown key. */
export function stateImage(key: string): HTMLCanvasElement {
  const m = /^([^|]+)\|([^|]+)\|(\d+)$/.exec(key)
  const a = m ? stateArt(m[1] as ObjectTileKind, m[2]) : undefined
  const frame = m ? Number(m[3]) : -1
  if (!a || frame >= a.variants * a.phases) throw new Error(`unknown state image ${key}`)
  return frameOf(a, frame)
}
