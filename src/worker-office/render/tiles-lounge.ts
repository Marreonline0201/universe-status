// BREAK ROOM lounge seats (plan §2 rows 22-23): the north-facing sofa (W / C / E) and the two armchairs. Workers sit
// on them only while really waiting for their own background job (plan §4.6), facing north: so the camera sees the
// seats from behind. Same rules as tiles-records.ts; plus plan §2's rule for north-facing seats: the backrest is
// drawn in rows 8-15, below a seated figure (which covers rows -4..7 of the seat tile), and the art check proves it
// by drawing each backrest on its own. No contact shadow is drawn for anyone sitting here (plan §6.2).
import { type Ctx, px } from './paint.ts'
import { SOFA_BODY, SOFA_SEAT, SOFA_DARK, shade } from './palette.ts'

type Part = 'W' | 'C' | 'E'

function sofaSeat(g: Ctx, part: Part) {
  const c0 = part === 'W' ? 3 : 0, c1 = part === 'E' ? 13 : 16
  px(g, c0, 2, c1 - c0, 6, SOFA_SEAT)
  px(g, c0, 2, c1 - c0, 1, shade.sofaSeatHi)
  px(g, c1 - 1, 3, 1, 5, shade.sofaSeatLo)                 // the cushion's edge (one cushion per tile)
  if (part === 'W') arm(g, 0)
  if (part === 'E') arm(g, 13)
}
function arm(g: Ctx, x: number) {
  px(g, x, 2, 3, 6, SOFA_DARK)
  px(g, x, 2, 3, 1, shade.sofaDarkHi)
}
function sofaBackrest(g: Ctx, part: Part) {
  px(g, 0, 8, 16, 7, SOFA_BODY)
  px(g, 0, 8, 16, 1, shade.sofaBodyHi)
  px(g, 0, 14, 16, 1, shade.sofaBodyLo)
  px(g, 4, 11, 1, 1, shade.sofaBodyLo)                       // tufting buttons
  px(g, 11, 11, 1, 1, shade.sofaBodyLo)
  if (part === 'W') {
    px(g, 0, 8, 3, 6, SOFA_DARK); px(g, 0, 8, 3, 1, shade.sofaDarkHi)
    px(g, 1, 15, 2, 1, shade.sofaLeg)
  } else if (part === 'E') {
    px(g, 13, 8, 3, 6, SOFA_DARK); px(g, 13, 8, 3, 1, shade.sofaDarkHi)
    px(g, 13, 15, 2, 1, shade.sofaLeg)
  }
}

function armchairSeat(g: Ctx) {
  px(g, 3, 2, 10, 6, SOFA_SEAT)
  px(g, 3, 2, 10, 1, shade.sofaSeatHi)
  arm(g, 0)
  arm(g, 13)
}
function armchairBackrest(g: Ctx) {
  px(g, 0, 8, 16, 7, SOFA_DARK)
  px(g, 0, 8, 16, 1, shade.sofaDarkHi)
  px(g, 3, 9, 10, 5, SOFA_BODY)                              // the upholstered back panel between the arms
  px(g, 3, 13, 10, 1, shade.sofaBodyLo)
  px(g, 7, 11, 2, 1, shade.sofaBodyLo)
  px(g, 1, 15, 2, 1, shade.sofaLeg)
  px(g, 13, 15, 2, 1, shade.sofaLeg)
}

export const LOUNGE_SEATS = {
  sofaNorthW: { seat: (g: Ctx) => sofaSeat(g, 'W'), backrest: (g: Ctx) => sofaBackrest(g, 'W') },
  sofaNorthC: { seat: (g: Ctx) => sofaSeat(g, 'C'), backrest: (g: Ctx) => sofaBackrest(g, 'C') },
  sofaNorthE: { seat: (g: Ctx) => sofaSeat(g, 'E'), backrest: (g: Ctx) => sofaBackrest(g, 'E') },
  armchairN: { seat: armchairSeat, backrest: armchairBackrest },
} as const

export const LOUNGE_TILES = Object.fromEntries(
  Object.entries(LOUNGE_SEATS).map(([k, p]) => [k, (g: Ctx) => { p.seat(g); p.backrest(g) }]),
) as { readonly [K in keyof typeof LOUNGE_SEATS]: (g: Ctx) => void }
