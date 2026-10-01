// LIBRARY furniture (plan §2 rows 6-8, 10, 29): bookshelves, the card catalog, the reading ledge under the window,
// the reading table with its banker's lamps, and the wooden chairs (the reading table's, also the meeting table's).
// Same rules as tiles-records.ts: one 16×16 tile at the origin, transparent around the object, no dependence on
// position. Multi-tile objects have one function per part (W / C / E).
import { type Ctx, px } from './paint.ts'
import {
  BOOKCASE, CATALOG_WOOD, LABEL_CARD, BRASS, DESK_TOP, DESK_EDGE, PAPER, INK_GREY, TABLE_WOOD, TABLE_EDGE, BANKER_GREEN,
  CHAIR_WOOD, WALL_BASE, GOLD, SHELF_BACK, BOOK_COLOURS, BINDING_SHADE, shade,
} from './palette.ts'
import type { Slot } from './tiles-records.ts'

// ── bookshelf (catalogue: case with 1 px sides, 3 shelves of spines rows 1-4, 6-9, 11-14, boards rows 5, 10, 15) ──
type BookColour = keyof typeof BOOK_COLOURS
const shelf = (bottom: number, books: readonly (readonly [number, number, BookColour, number])[]): Slot[] =>
  books.map(([x, w, c, top]) => ({ x, top, bottom, w, colour: BOOK_COLOURS[c] }))
/** Every book on the three shelves: x, width (1 or 2 px), binding, top row; each reaches down to its board. */
export const BOOKS: readonly (readonly Slot[])[] = [
  shelf(4, [[1, 2, 'red', 1], [3, 1, 'navy', 2], [4, 2, 'mustard', 1], [6, 2, 'forest', 2], [8, 1, 'plum', 1],
    [9, 2, 'teal', 1], [11, 2, 'tan', 2], [13, 2, 'grey', 1]]),
  shelf(9, [[1, 2, 'navy', 6], [3, 2, 'forest', 7], [5, 1, 'red', 6], [6, 2, 'grey', 6], [8, 2, 'mustard', 7],
    [10, 1, 'teal', 6], [11, 2, 'plum', 6], [13, 2, 'red', 7]]),
  shelf(14, [[1, 2, 'teal', 11], [3, 2, 'red', 12], [5, 2, 'navy', 11], [7, 1, 'mustard', 12], [8, 2, 'forest', 11],
    [10, 2, 'grey', 12], [12, 1, 'tan', 11], [13, 2, 'plum', 11]]),
]
/** The shaded right half of a 2 px spine (palette.ts BINDING_SHADE, shared with the pulled book prop). */
const darkSpine = (c: string) => BINDING_SHADE.get(c) ?? c

function bookshelf(g: Ctx) {
  px(g, 0, 0, 16, 16, BOOKCASE)
  px(g, 1, 1, 14, 4, SHELF_BACK)
  px(g, 1, 6, 14, 4, SHELF_BACK)
  px(g, 1, 11, 14, 4, SHELF_BACK)
  px(g, 0, 0, 16, 1, shade.caseHi)
  px(g, 0, 0, 1, 16, shade.caseHi)
  px(g, 15, 0, 1, 16, shade.caseLo)
  px(g, 0, 15, 16, 1, shade.caseLo)
  for (const row of BOOKS) {
    row.forEach((b, i) => {
      px(g, b.x, b.top, b.w, b.bottom - b.top + 1, b.colour)
      if (b.w === 2) {
        px(g, b.x + 1, b.top, 1, b.bottom - b.top + 1, darkSpine(b.colour))
        if (i % 2 === 0) px(g, b.x, b.top + 1, 2, 1, GOLD)   // a gilt title on every other volume, not all
      }
    })
  }
}

// ── card catalog (catalogue: walnut cabinet, 4 rows of small drawers with a card label and a brass pull) ──────────
// Across both tiles: sides 2 px, seven 3 px drawer faces with 1 px seams. Seen per tile, both parts have whole faces
// at x = 2, 6, 10; the face that straddles the joint is W 14-15 + E 0 (its label and pull at W 15).
export const CATALOG_FACES_X = [2, 6, 10] as const
/** Top row of each drawer row's 2 px face. */
export const CATALOG_FACE_ROWS = [2, 5, 8, 11] as const

function catalogFace(g: Ctx, x: number, w: number, row: number, mark: number | null) {
  px(g, x, row, w, 2, shade.catFace)
  if (mark !== null) {
    px(g, mark, row, 1, 1, LABEL_CARD)
    px(g, mark, row + 1, 1, 1, BRASS)
  }
}

function cardCatalog(g: Ctx, part: 'W' | 'E') {
  px(g, 0, 0, 16, 2, shade.catTop)
  px(g, 0, 0, 16, 1, shade.catTopHi)
  px(g, 0, 2, 16, 12, shade.catSeam)
  px(g, 0, 14, 16, 2, shade.catPlinth)
  px(g, 0, 15, 16, 1, shade.caseLo)
  for (const row of CATALOG_FACE_ROWS) {
    for (const x of CATALOG_FACES_X) catalogFace(g, x, 3, row, x + 1)
    if (part === 'W') catalogFace(g, 14, 2, row, 15)
    else catalogFace(g, 0, 1, row, null)
  }
  if (part === 'W') {
    px(g, 0, 0, 2, 16, CATALOG_WOOD)
    px(g, 0, 0, 1, 16, shade.catTopHi)
  } else {
    px(g, 14, 0, 2, 16, shade.catSide)
    px(g, 15, 0, 1, 16, shade.catPlinth)
  }
}

// ── reading ledge (catalogue: light-oak top, journal rack front, papers on top) ─────────────────────────────────
/** The ledge's top surface rows (the state layer spreads a journal on it). */
export const LEDGE_TOP = { y: 1, h: 8 } as const
const JOURNALS = {
  W: [BOOK_COLOURS.teal, BOOK_COLOURS.mustard, BOOK_COLOURS.red], E: [BOOK_COLOURS.plum, BOOK_COLOURS.navy, BOOK_COLOURS.forest],
} as const

function readingLedge(g: Ctx, part: 'W' | 'E') {
  px(g, 0, LEDGE_TOP.y, 16, LEDGE_TOP.h, DESK_TOP)
  px(g, 0, LEDGE_TOP.y, 16, 1, DESK_EDGE)
  px(g, 0, 9, 16, 1, shade.ledgeLip)
  px(g, 0, 10, 16, 5, shade.ledgeFront)
  // the journal rack on the front: three slanted covers, a rail across their feet
  JOURNALS[part].forEach((c, i) => {
    const x = 1 + 5 * i
    px(g, x, 10, 4, 4, c)
    px(g, x, 10, 4, 1, shade.journalTop)
  })
  px(g, 0, 14, 16, 1, shade.deskApronLo)
  if (part === 'W') {
    // a folded newspaper: headline, fold, two columns of text
    px(g, 3, 3, 8, 5, shade.newsprint)
    px(g, 4, 3, 5, 1, shade.headline)
    px(g, 3, 5, 8, 1, shade.newsFold)
    px(g, 4, 4, 2, 1, INK_GREY); px(g, 7, 4, 3, 1, INK_GREY)
    px(g, 4, 6, 3, 1, INK_GREY); px(g, 8, 6, 2, 1, INK_GREY)
    px(g, 0, 1, 1, 14, shade.ledgeFront)
  } else {
    // a closed journal with a white title strip
    px(g, 5, 3, 6, 5, BOOK_COLOURS.navy)
    px(g, 5, 3, 6, 1, shade.journalHi)
    px(g, 6, 5, 4, 1, PAPER)
    px(g, 15, 1, 1, 14, shade.ledgeFront)
  }
}

// ── reading table (catalogue: walnut top rows 2-13 = the old meetTable art without its floor; a banker's lamp on
//    every tile at the north edge) ───────────────────────────────────────────────────────────────────────────────
export const TABLE_LAMP = { shadeX: 5, shadeY: 0, shadeW: 6 } as const

function readingTable(g: Ctx, part: 'W' | 'C' | 'E') {
  px(g, 0, 2, 16, 11, TABLE_WOOD)
  px(g, 0, 2, 16, 1, TABLE_EDGE)
  px(g, 0, 3, 16, 1, shade.tableHi)
  px(g, 0, 7, 16, 1, shade.tablePlank)
  px(g, 0, 10, 16, 1, shade.tablePlank)
  px(g, 0, 12, 16, 2, shade.tableLo)
  if (part === 'W') {
    px(g, 0, 2, 1, 12, shade.tableHi)
    px(g, 1, 14, 1, 2, shade.tableLeg)
  } else if (part === 'E') {
    px(g, 15, 2, 1, 12, shade.tableLo)
    px(g, 14, 14, 1, 2, shade.tableLeg)
  }
  // banker's lamp: brass foot and stem, green glass shade above the far edge
  const L = TABLE_LAMP
  px(g, 6, 3, 4, 1, BRASS)
  px(g, 7, 2, 2, 1, shade.brassLo)
  px(g, L.shadeX, L.shadeY, L.shadeW, 2, BANKER_GREEN)
  px(g, L.shadeX, L.shadeY, L.shadeW, 1, shade.bankerHi)
}

// ── wooden chair, north-facing (plan §2 rule: the backrest toward the camera, in rows 8-15) ─────────────────────
// Split in two so the art check can prove the backrest stays in rows 8-15: a seated figure covers rows -4..7 of the
// seat tile (AgentSprite / OfficeEngine geometry), and the backrest shows below it.
function woodChairSeat(g: Ctx) {
  px(g, 3, 1, 10, 6, CHAIR_WOOD)
  px(g, 3, 1, 10, 1, shade.chairWoodHi)
  px(g, 12, 2, 1, 5, shade.chairWoodLo)
  px(g, 3, 7, 10, 1, shade.chairWoodLo)
}
function woodChairBackrest(g: Ctx) {
  px(g, 3, 8, 10, 2, CHAIR_WOOD)
  px(g, 3, 8, 10, 1, shade.chairWoodHi)
  px(g, 3, 10, 1, 5, CHAIR_WOOD)
  px(g, 12, 10, 1, 5, shade.chairWoodLo)
  px(g, 6, 10, 1, 3, CHAIR_WOOD)
  px(g, 9, 10, 1, 3, shade.chairWoodLo)
  px(g, 3, 13, 10, 1, shade.chairWoodLo)
  px(g, 3, 15, 1, 1, WALL_BASE)
  px(g, 12, 15, 1, 1, WALL_BASE)
}

export const LIBRARY_SEATS = { woodChairN: { seat: woodChairSeat, backrest: woodChairBackrest } } as const

export const LIBRARY_TILES = {
  bookshelf,
  cardCatalogW: (g: Ctx) => cardCatalog(g, 'W'),
  cardCatalogE: (g: Ctx) => cardCatalog(g, 'E'),
  readingLedgeW: (g: Ctx) => readingLedge(g, 'W'),
  readingLedgeE: (g: Ctx) => readingLedge(g, 'E'),
  readingTableW: (g: Ctx) => readingTable(g, 'W'),
  readingTableC: (g: Ctx) => readingTable(g, 'C'),
  readingTableE: (g: Ctx) => readingTable(g, 'E'),
  woodChairN: (g: Ctx) => { woodChairSeat(g); woodChairBackrest(g) },
} as const
