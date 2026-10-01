// Palette tokens of the worker office furniture (plan §6.2 "the palette tokens").
//
// Three sources, nothing invented without a name:
//   1. the existing office art (src/office-render/assets.ts:15-58), copied by value so the new building keeps the
//      old one's materials;
//   2. the step-2 object catalogue's proposed tokens (office-objects/catalog-s2: mock.py and the catalogue notes);
//   3. the legend colours of floorplan.json, which are each kind's representative colour (the step-1 placeholders
//      were drawn in them); the art uses them as the kind's main material.
// Shades are derived once, here, with mix / lighten / darken (paint.ts), never per draw.
import { mix, lighten, darken } from './paint.ts'

// ── 1. existing office tokens (assets.ts) ────────────────────────────────────────────────────────────────────────
export const DESK_TOP = '#8a6a4a'        // light-oak desk
export const DESK_EDGE = '#9c7c58'
export const MONITOR = '#10141f'
export const MONITOR_GLOW = '#bfe3ff'
export const MONITOR_FRAME = '#c8ccd4'   // silver bezel
export const CHAIR_BODY = '#33413a'      // forest ergonomic chair
export const CHAIR_BACK = '#42544a'
export const TABLE_WOOD = '#5c4230'      // walnut
export const TABLE_EDGE = '#6e5240'
export const SOFA_BODY = '#3f6a52'       // green velvet
export const SOFA_SEAT = '#4d7d61'
export const SOFA_DARK = '#2f4f3d'
export const LAMP_SHADE = '#e8c87a'
export const COUNTER_TOP = '#d8d2c6'     // quartz
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

/** Dim (off) colours of the bench terminal's stack light. */
export const LAMP_RED_OFF = '#5a2a2a'
export const LAMP_AMBER_OFF = '#5a4a1a'
export const LAMP_GREEN_OFF = '#2a4a2a'
export const LAMP_BLUE_OFF = '#2a3a5a'

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
  cabFront: COUNTER_CAB,
  cabFrontLo: darken(COUNTER_CAB, 0.3),
  printerTop: lighten(PRINTER_BODY, 0.4),
  printerFace: darken(PRINTER_BODY, 0.06),
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
  trayWire: STEEL,
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
  printerPanel: '#74c0fc',
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
} as const
