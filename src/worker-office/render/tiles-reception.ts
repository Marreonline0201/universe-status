// RECEPTION furniture (plan §2 rows 2, 18, 20): the front desk, the printer of the mail / print corner and the staff
// in/out board in the corridor wall. Same rules as tiles-records.ts.
// The in/out board is wall-mounted: the pre-render paints the wall face under it (cap rows 0-3, edge row 4), and
// this tile draws only the board on the face, rows 5-13.
import { type Ctx, px } from './paint.ts'
import {
  FRONT_DESK_STONE, COUNTER_CAB, BRASS, PAPER, LABEL_CARD, INK_GREY, PRINTER_BODY, LAMP_GREEN_ON, STEEL, BOARD_BG,
  BOARD_FRAME, INOUT_GREEN, shade,
} from './palette.ts'

// ── front desk (catalogue: stone top rows 2-7, walnut front with a brass strip; W: phone + sign-out book;
//    E: the IN and OUT trays) ──────────────────────────────────────────────────────────────────────────────────
export const DESK_PHONE = { x: 2, y: 2, w: 5, h: 4 } as const
export const SIGN_BOOK = { x: 9, y: 3, w: 6, h: 4 } as const
/** Wire trays on the E part: the interior (where paper lies) of each. */
export const IN_TRAY = { x: 3, y: 3, w: 4, h: 3 } as const
export const OUT_TRAY = { x: 9, y: 3, w: 4, h: 3 } as const

function wireTray(g: Ctx, inner: { x: number; y: number; w: number; h: number }) {
  px(g, inner.x - 1, inner.y - 1, inner.w + 2, inner.h + 2, STEEL)
  px(g, inner.x, inner.y, inner.w, inner.h, shade.trayBed)
  px(g, inner.x + 1, inner.y + inner.h, inner.w - 2, 1, LABEL_CARD)   // the label on the front lip
}

function frontDesk(g: Ctx, part: 'W' | 'E') {
  px(g, 0, 2, 16, 6, FRONT_DESK_STONE)
  px(g, 0, 2, 16, 1, shade.stoneHi)
  px(g, 0, 7, 16, 1, shade.stoneLo)
  px(g, 0, 8, 16, 7, COUNTER_CAB)
  px(g, 0, 9, 16, 1, BRASS)
  px(g, 0, 14, 16, 1, shade.cabFrontLo)
  if (part === 'W') {
    px(g, 0, 2, 1, 13, shade.stoneHi)
    // desk phone: dark base with keypad dots, the handset resting on top
    const p = DESK_PHONE
    px(g, p.x, p.y + 1, p.w, p.h - 1, shade.phone)
    px(g, p.x + 1, p.y + 2, 1, 1, shade.phoneHi); px(g, p.x + 3, p.y + 2, 1, 1, shade.phoneHi)
    px(g, p.x + 2, p.y + 3, 1, 1, shade.phoneHi)
    deskHandset(g)
    // sign-out book, open: two ruled pages
    const b = SIGN_BOOK
    px(g, b.x, b.y, b.w, b.h, shade.bookCover)
    px(g, b.x, b.y, b.w, b.h - 1, PAPER)
    px(g, b.x + 3, b.y, 1, b.h - 1, shade.gutter)
    px(g, b.x + 1, b.y + 1, 2, 1, INK_GREY); px(g, b.x + 4, b.y + 1, 2, 1, INK_GREY)
  } else {
    px(g, 15, 2, 1, 13, shade.stoneLo)
    wireTray(g, IN_TRAY)
    wireTray(g, OUT_TRAY)
  }
}
/** The handset on its cradle (the state layer lifts it: onPhone). */
export function deskHandset(g: Ctx) {
  const p = DESK_PHONE
  px(g, p.x, p.y, p.w, 2, shade.handset)
  px(g, p.x, p.y, 1, 2, shade.phoneHi)
  px(g, p.x + p.w - 1, p.y, 1, 2, shade.phoneHi)
}

// ── printer (catalogue: laser printer rows 1-7 on a walnut cabinet rows 8-15) ─────────────────────────────────────
/** The output tray on top of the printer, where pages land (the state layer fills it). */
export const PRINT_TRAY = { x: 4, y: 1, w: 8, h: 2 } as const
export const PRINTER_LED = { x: 12, y: 5 } as const

function printer(g: Ctx) {
  // cabinet
  px(g, 1, 8, 14, 7, COUNTER_CAB)
  px(g, 1, 8, 14, 1, shade.cabTopEdge)
  px(g, 1, 11, 14, 1, shade.cabFrontLo)
  px(g, 6, 12, 4, 1, STEEL)
  px(g, 1, 15, 14, 1, shade.cabFrontLo)
  // printer: light top with the output recess and its slot, the front face with the panel
  px(g, 2, 1, 12, 3, shade.printerTop)
  px(g, 2, 4, 12, 4, PRINTER_BODY)
  px(g, 13, 1, 1, 7, shade.printerSide)
  const t = PRINT_TRAY
  px(g, t.x, t.y, t.w, t.h, shade.printerBed)
  px(g, t.x, t.y, t.w, 1, shade.printerSlot)
  px(g, 3, 6, 10, 1, shade.printerBed)                 // paper cassette seam
  px(g, 10, 5, 2, 1, shade.printerPanel)              // little status screen
  px(g, PRINTER_LED.x, PRINTER_LED.y, 1, 1, LAMP_GREEN_ON)   // ready
}

// ── in/out board (catalogue: a staff board in the wall; one magnet per worker inside) ────────────────────────────
// The magnet sockets lie in rows 6 and 8: the plan §2 rule keeps state art (the magnets are drawn from data) in rows
// 0-9 and out of columns 10-15 in rows 7-9, where a standing worker and its status dot would cover it. 1 px magnets
// on a 2 px pitch give 25 sockets across the two tiles, at least the measured peak of 24 workers inside
// (step-2 catalogue).
export interface MagnetSlot { readonly part: 'W' | 'E'; readonly x: number; readonly y: number }
const slotsOf = (part: 'W' | 'E', row6: readonly number[], row8: readonly number[]): MagnetSlot[] =>
  [...row6.map(x => ({ part, x, y: 6 })), ...row8.map(x => ({ part, x, y: 8 }))]
/** In fill order: the top row across both tiles, then the second row. */
export const MAGNET_SLOTS: readonly MagnetSlot[] = (() => {
  const W = slotsOf('W', [1, 3, 5, 7, 9, 11, 13, 15], [1, 3, 5, 7, 9])
  const E = slotsOf('E', [1, 3, 5, 7, 9, 11, 13], [1, 3, 5, 7, 9])
  return [...W.filter(s => s.y === 6), ...E.filter(s => s.y === 6), ...W.filter(s => s.y === 8), ...E.filter(s => s.y === 8)]
})()

function inOutBoard(g: Ctx, part: 'W' | 'E') {
  px(g, 0, 5, 16, 9, BOARD_FRAME)
  const x0 = part === 'W' ? 1 : 0
  px(g, x0, 6, 15, 7, BOARD_BG)
  px(g, x0, 9, 15, 1, shade.boardRule)
  // footer band in the board's green: "IN" on the W part, a row of name lines on both
  px(g, x0, 10, 15, 3, INOUT_GREEN)
  if (part === 'W') {
    px(g, 2, 10, 1, 3, shade.inoutDark)                    // I
    px(g, 4, 10, 1, 3, shade.inoutDark); px(g, 5, 10, 1, 1, shade.inoutDark)   // N, 4 wide so it does not read as H
    px(g, 6, 11, 1, 1, shade.inoutDark); px(g, 7, 10, 1, 3, shade.inoutDark)
    px(g, 9, 11, 6, 1, shade.inoutLine)
  } else {
    px(g, 1, 11, 12, 1, shade.inoutLine)
  }
  for (const s of MAGNET_SLOTS) if (s.part === part) px(g, s.x, s.y, 1, 1, shade.boardSocket)
  px(g, 0, 5, 16, 1, shade.boardFrameHi)
}

export const RECEPTION_TILES = {
  frontDeskW: (g: Ctx) => frontDesk(g, 'W'),
  frontDeskE: (g: Ctx) => frontDesk(g, 'E'),
  printer,
  inOutBoardW: (g: Ctx) => inOutBoard(g, 'W'),
  inOutBoardE: (g: Ctx) => inOutBoard(g, 'E'),
} as const
