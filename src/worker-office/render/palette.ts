// Palette tokens of the worker office furniture (plan §6.2 "the palette tokens").
//
// Three sources, nothing invented without a name:
//   1. the existing office art (src/office-render/assets.ts:15-58), copied by value so the new building keeps the
//      old one's materials;
//   2. the step-2 object catalogue's proposed tokens (office-objects/catalog-s2: mock.py and the catalogue notes);
//   3. the legend colours of floorplan.json, which are each kind's representative colour (the step-1 placeholders
//      were drawn in them); the art uses them as the kind's main material.
// Shades are derived once, here, with mix / lighten / darken (paint.ts), never per draw. The art files (tiles-*.ts,
// stateLayer.ts, props.ts, icons.ts, furniture.ts) hold no colour literal and derive no shade, and every token here
// is used (by the art, or by another token): scripts/worker-office-art-check.ts scans for all three.
// Not copied: assets.ts MONITOR_GLOW (#bfe3ff), the old desk's baked glow patch. The lit screen here is
// shade.screenLit, paler, because it carries 1 px lines of text and the red / green result line (plan §4.5): WCAG
// contrast of line / red / green 2.9 / 3.7 / 2.0 : 1 on screenLit against 2.6 / 3.4 / 1.8 : 1 on MONITOR_GLOW.
// Nor COUNTER_TOP: the kitchen counter is pass 2.
import { mix, lighten, darken } from './paint.ts'

// ── 1. existing office tokens (assets.ts) ────────────────────────────────────────────────────────────────────────
export const DESK_TOP = '#8a6a4a'        // light-oak desk
export const DESK_EDGE = '#9c7c58'
export const MONITOR = '#10141f'
export const MONITOR_FRAME = '#c8ccd4'   // silver bezel
export const CHAIR_BODY = '#33413a'      // forest ergonomic chair
export const CHAIR_BACK = '#42544a'
export const TABLE_WOOD = '#5c4230'      // walnut
export const TABLE_EDGE = '#6e5240'
export const SOFA_BODY = '#3f6a52'       // green velvet
export const SOFA_SEAT = '#4d7d61'
export const SOFA_DARK = '#2f4f3d'
export const LAMP_SHADE = '#e8c87a'      // warm lamp gold (here: the pen icon's nib)
export const COUNTER_CAB = '#4a3a2c'     // walnut cabinets
export const STEEL = '#9aa4ac'
export const POT_CERAMIC = '#c9b8a4'
export const BOARD_BG = '#eef1f4'        // glassboard
export const BOARD_FRAME = '#8fa1ab'     // brushed aluminium
export const WALL_BASE = '#1f1a15'
/** Worker status colours (assets.ts STATUS_COLORS): the in/out board's magnets use them. */
export const STATUS_WORKING = '#00d4ff'
export const STATUS_IDLE = '#5c6a8a'
export const STATUS_OFFLINE = '#3a4157'

// ── 2. step-2 catalogue tokens ───────────────────────────────────────────────────────────────────────────────────
export const CAB_TOP = '#a39d92'         // file cabinet steel, enamelled
export const CAB_FACE = '#8a847a'
export const CAB_SEAM = '#5f5a52'
export const CAB_SHADE = '#77716a'
export const CAB_PLINTH = '#3a3630'
export const LABEL_CARD = '#e8e2d6'
export const MANILA = '#d9b97a'
export const MANILA_DARK = '#c4a466'
export const PAPER = '#f1efe8'
export const INK_GREY = '#9aa0a6'
export const TERM_TEXT = '#8ce99a'       // terminal text
export const LAMP_GREEN_ON = '#40c057'   // stack light, lit
export const LAMP_AMBER_ON = '#fab005'
export const LAMP_RED_ON = '#e03131'
export const BENCH_TOP = '#4a4f57'
export const KRAFT = '#b08a5a'           // archive boxes, parcels
export const LEDGER = '#2f5a3e'          // bottle-green ledgers (= the historyShelf legend colour)
export const GOLD = '#c9a25c'            // gilt date bands
export const BRASS = '#b8913f'
export const BANKER_GREEN = '#2e7d4f'    // banker's-lamp glass

// ── 3. legend colours used as each kind's main material ──────────────────────────────────────────────────────────
export const BOOKCASE = '#6b3f2a'        // bookshelf
export const CATALOG_WOOD = '#7d5a3a'    // cardCatalog
export const LECTERN_WOOD = '#9c7c58'    // lectern (= DESK_EDGE)
export const FRONT_DESK_STONE = '#b9ad97' // frontDesk
export const PRINTER_BODY = '#e8ecef'    // printer
export const INOUT_GREEN = '#b8e0c2'     // inOutBoard
export const CHAIR_WOOD = '#6e5240'      // woodChairN (= TABLE_EDGE)

// ── new named colours (no source above has them) ────────────────────────────────────────────────────────────────
export const SHELF_BACK = '#24190f'      // the dark back of a shelf opening
export const DRAWER_WELL = '#2a2622'     // inside of an open steel drawer
export const INK = '#1c2a5a'             // fountain-pen ink on the sign-out book
export const TAB_ORANGE = '#e8590c'      // folder tabs (assets.ts whiteboard marker colours)
export const TAB_BLUE = '#1971c2'
export const TAB_GREEN = '#2f9e44'
export const LAMP_BLUE_ON = '#4dabf7'    // stack light: blue = "watching" (Monitor)
export const LAMP_GLOW = '#f5d97a'       // a lit lamp shade's rim
export const LIGHT_POOL = 'rgba(255,214,140,0.20)'   // warm pool under a lit lamp (stacked twice for the core)
export const SLIP_YELLOW = '#ffd43b'     // job tickets, call slips (assets.ts sticky-note yellow)
export const DIFF_RED = '#e03131'        // a removed line in a comparison
export const DIFF_GREEN = '#40c057'      // an added line
export const SPECULAR = '#ffffff'        // pure white: a glint of light, a page caught mid-turn
export const SKY = '#74c0fc'             // light blue: the printer's status screen, the light-blue icon ink
/** The front door's sliding glass leaves (moved with doorLeaves from floors.ts, values unchanged). */
export const DOOR_GLASS = 'rgba(170,214,222,0.42)'
export const DOOR_HANDLE = '#dfe4e8'
export const GLASS_GLINT = 'rgba(255,255,255,0.35)'
/** The speech bubble the icons sit in (OfficeEngine.ts drawBubble). */
export const BUBBLE_BG = 'rgba(8,12,24,0.92)'

/** Muted cloth bindings of the library's books (the book prop takes its slot's binding). */
export const BOOK_COLOURS = {
  red: '#8a3a32', navy: '#2e3f6e', forest: '#3d6b45', mustard: '#a8862e', plum: '#5e3a5e', teal: '#2e6a6a',
  tan: '#9a7a52', grey: '#5c5c66',
} as const

/** Dim (off) colours of the bench terminal's stack light. */
export const LAMP_RED_OFF = '#5a2a2a'
export const LAMP_AMBER_OFF = '#5a4a1a'
export const LAMP_GREEN_OFF = '#2a4a2a'
export const LAMP_BLUE_OFF = '#2a3a5a'
/** Lit colours of the stack light, by lamp, and the 1 px highlight on each lit lamp (derived once). */
export const STACK_LAMP_ON = { blue: LAMP_BLUE_ON, red: LAMP_RED_ON, amber: LAMP_AMBER_ON, green: LAMP_GREEN_ON } as const
export const STACK_LAMP_HI: Readonly<Record<keyof typeof STACK_LAMP_ON, string>> = {
  blue: lighten(LAMP_BLUE_ON, 0.45), red: lighten(LAMP_RED_ON, 0.45), amber: lighten(LAMP_AMBER_ON, 0.45), green: lighten(LAMP_GREEN_ON, 0.45),
}

/** Bubble-icon inks (icons.ts): light colours for the dark bubble. Values the furniture already names are taken from
 *  there (MANILA, PAPER, KRAFT, GOLD, TAB_GREEN, STEEL, TERM_TEXT, LAMP_SHADE, SLIP_YELLOW, SKY, shade.caret). */
export const ICON_INK = {
  light: '#e8ecf2',
  blueDark: '#1e4a6e',
  ledger: '#4f8a5c',          // ledger green, lifted for the dark bubble
  ledgerSpine: '#3a6b47',
  gilt: '#e0b862',
  eraser: '#f783ac',
  red: '#ff6b6b',
  green: '#51cf66',
  pageGrey: '#b8b2a4',
  cover: '#c0583f',
  stopRed: '#f03e3e',
  phoneRed: '#ff8787',
  ticketStub: '#c9a227',
  pagerGrey: '#868e96',
} as const

// ── derived shades (computed once) ───────────────────────────────────────────────────────────────────────────────
export const shade = {
  cabTopHi: lighten(CAB_TOP, 0.25),
  cabFaceHi: lighten(CAB_FACE, 0.1),
  ledgerA: LEDGER,
  ledgerB: darken(LEDGER, 0.14),
  ledgerC: lighten(LEDGER, 0.12),
  ledgerD: mix(LEDGER, '#1e3d4a', 0.35),
  ledgerSpine: darken(LEDGER, 0.32),
  tableHi: lighten(TABLE_WOOD, 0.1),
  tableLo: darken(TABLE_WOOD, 0.22),
  tableLeg: darken(TABLE_WOOD, 0.4),
  caseHi: lighten(BOOKCASE, 0.14),
  caseLo: darken(BOOKCASE, 0.3),
  lecternHi: lighten(LECTERN_WOOD, 0.18),
  lecternLo: darken(LECTERN_WOOD, 0.2),
  lecternPost: darken(LECTERN_WOOD, 0.15),
  lecternPostLo: darken(LECTERN_WOOD, 0.32),
  lecternFoot: darken(LECTERN_WOOD, 0.4),
  bankerHi: lighten(BANKER_GREEN, 0.22),
  brassLo: darken(BRASS, 0.25),
  catTop: lighten(CATALOG_WOOD, 0.1),
  catTopHi: lighten(CATALOG_WOOD, 0.22),
  catFace: lighten(CATALOG_WOOD, 0.16),
  catSeam: darken(CATALOG_WOOD, 0.38),
  catSide: darken(CATALOG_WOOD, 0.14),
  catPlinth: darken(CATALOG_WOOD, 0.3),
  catWell: darken(CATALOG_WOOD, 0.55),
  cardEdge: '#d6cfc0',
  deskApron: darken(DESK_TOP, 0.25),
  deskApronLo: darken(DESK_TOP, 0.4),
  ledgeLip: darken(DESK_TOP, 0.18),
  ledgeFront: darken(DESK_TOP, 0.3),
  benchLo: darken(BENCH_TOP, 0.25),
  benchLeg: '#3a3f47',
  keyboard: '#3a3f4a',
  keyCap: '#5c6370',
  screenLit: '#dcecf8',
  screenLine: '#7a8ba0',
  stoneHi: lighten(FRONT_DESK_STONE, 0.2),
  stoneLo: darken(FRONT_DESK_STONE, 0.18),
  cabFrontLo: darken(COUNTER_CAB, 0.3),
  printerTop: lighten(PRINTER_BODY, 0.4),
  printerBed: darken(PRINTER_BODY, 0.18),
  printerSlot: '#3a3f47',
  sofaBodyHi: lighten(SOFA_BODY, 0.12),
  sofaBodyLo: darken(SOFA_BODY, 0.18),
  sofaSeatHi: lighten(SOFA_SEAT, 0.12),
  sofaSeatLo: darken(SOFA_SEAT, 0.14),
  sofaDarkHi: lighten(SOFA_DARK, 0.14),
  sofaLeg: '#2a2017',
  chairWoodHi: lighten(CHAIR_WOOD, 0.18),
  chairWoodLo: darken(CHAIR_WOOD, 0.22),
  chairBackHi: '#56695e',                 // catalogue mock.py chair_back highlight
  chairBase: WALL_BASE,
  phone: '#2b2f36',
  phoneHi: '#454b55',
  trayBed: '#6f757e',
  boardSocket: '#d4dae0',
  kraftHi: lighten(KRAFT, 0.18),
  journalTop: 'rgba(255,255,255,0.18)',
  newsprint: '#e4ddcf',
  newsFold: '#cfc6b4',
  tablePlank: mix(TABLE_WOOD, '#000000', 0.15),
  kraftLo: darken(KRAFT, 0.25),
  inoutDark: darken(INOUT_GREEN, 0.45),
  inoutLine: darken(INOUT_GREEN, 0.2),
  boardRule: darken(BOARD_BG, 0.1),
  boardFrameHi: lighten(BOARD_FRAME, 0.25),
  bezelLo: darken(MONITOR_FRAME, 0.2),
  ledStandby: '#c98a10',                  // a dim amber standby LED (catalogue: "1 px amber standby LED at (11,6)")
  coffee: '#5a3a22',
  chairBodyHi: lighten(CHAIR_BODY, 0.12),
  chairBackLo: darken(CHAIR_BACK, 0.2),
  keyboardDark: '#2b2b2b',
  bookCover: '#3a2a1e',
  gutter: '#d8d2c6',
  handset: '#1f2228',
  cabTopEdge: lighten(COUNTER_CAB, 0.18),
  printerSide: darken(PRINTER_BODY, 0.16),
  printerPanel: SKY,
  folderShadow: darken(MANILA_DARK, 0.45),
  ribbon: '#c92a2a',                       // a ledger's red ribbon marker
  pageLit: '#fffdf6',
  pageShade: '#e0dccf',
  pen: '#2b2b2b',
  pageEdge: '#d8d2c6',
  photo: '#7a9ab8',                         // a photo block in an open journal
  caret: '#1c2a3a',
  slipPale: '#ffe8a3',
  ticketStub: darken(SLIP_YELLOW, 0.2),
  alu: BOARD_FRAME,                         // the door's aluminium frames (floors.ts ALU)
  headline: '#55555c',                      // a folded newspaper's headline
  journalHi: '#40528a',                     // the closed navy journal's lit top edge
  /** In/out board magnets (plan §2 row 2). A magnet is 1 px, so its colour is the only cue: each ink is held to
   *  3:1 or more against the white board AND the empty socket it fills (the art check measures the drawn pixels).
   *  The bright status cyan (1.6 : 1 on the board) is darkened in its own hue; a waiting or stale magnet keeps
   *  the status colour (4.8 and 8.9 : 1); the steel back shown mid-flip is a darker steel than STEEL (2.2 : 1). */
  magnetWorking: darken(STATUS_WORKING, 0.5),
  magnetBack: darken(STEEL, 0.4),
} as const

/** The four ledger bindings on the history shelves (the ledger prop takes its slot's binding). */
export const LEDGER_COLOURS = [shade.ledgerA, shade.ledgerB, shade.ledgerC, shade.ledgerD] as const

/** The shaded side of a binding, by binding colour, as the shelves draw it (the right half of a 2 px spine): a book
 *  darkens 30%, every ledger shares the history shelf's spine shade. A pulled book or ledger (props.ts) uses the
 *  same, so it looks like the volume that left the gap. Derived once. */
export const BINDING_SHADE: ReadonlyMap<string, string> = new Map<string, string>([
  ...Object.values(BOOK_COLOURS).map(c => [c, darken(c, 0.3)] as [string, string]),
  ...LEDGER_COLOURS.map(c => [c, shade.ledgerSpine] as [string, string]),
])
