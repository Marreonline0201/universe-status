// WORK ROOM furniture (plan §2 rows 11, 12, 28): the PC desks, their task chairs and the standing bench terminals.
// Same rules as tiles-records.ts. The desk is the old office desk (assets.ts:186-195) reworked: no baked oak floor,
// no baked screen glow (the screen is state: off by default, lit by the state layer while someone sits there), the
// mug moved to the left so the worker's status dot (columns 11-15) never covers it (step-2 catalogue).
import { type Ctx, px } from './paint.ts'
import {
  DESK_TOP, DESK_EDGE, MONITOR, MONITOR_FRAME, POT_CERAMIC, CHAIR_BODY, CHAIR_BACK, BENCH_TOP, STEEL,
  LAMP_RED_OFF, LAMP_AMBER_OFF, LAMP_GREEN_OFF, LAMP_BLUE_OFF, shade,
} from './palette.ts'

// ── PC desk ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The screen inside the bezel: the state layer paints here. */
export const DESK_SCREEN = { x: 4, y: 1, w: 8, h: 5 } as const
/** The standby LED on the bezel (amber when off; the state layer turns it green). */
export const DESK_LED = { x: 11, y: 6 } as const

function pcDesk(g: Ctx) {
  px(g, 0, 6, 16, 7, DESK_TOP)
  px(g, 0, 6, 16, 1, DESK_EDGE)
  px(g, 0, 13, 16, 1, shade.deskApron)
  px(g, 0, 14, 16, 1, shade.deskApronLo)
  // monitor: silver bezel, dark screen, stand and foot
  px(g, 3, 0, 10, 7, MONITOR_FRAME)
  px(g, DESK_SCREEN.x, DESK_SCREEN.y, DESK_SCREEN.w, DESK_SCREEN.h, MONITOR)
  px(g, 12, 0, 1, 7, shade.bezelLo)
  px(g, 7, 7, 2, 1, shade.keyboard)
  px(g, 6, 8, 4, 1, shade.bezelLo)
  px(g, DESK_LED.x, DESK_LED.y, 1, 1, shade.ledStandby)
  // keyboard with a few keycaps, the mug on the left
  px(g, 5, 9, 6, 2, shade.keyboard)
  px(g, 6, 9, 1, 1, shade.keyCap); px(g, 8, 9, 1, 1, shade.keyCap); px(g, 7, 10, 2, 1, shade.keyCap)
  px(g, 1, 9, 2, 2, POT_CERAMIC)
  px(g, 1, 9, 2, 1, shade.coffee)
}

// ── task chair, north-facing (catalogue mock.py chair_back): seat and armrests above, backrest in rows 8-15 ─────
function taskChairSeat(g: Ctx) {
  px(g, 4, 3, 8, 5, CHAIR_BODY)
  px(g, 4, 3, 8, 1, shade.chairBodyHi)
  px(g, 3, 4, 1, 4, CHAIR_BACK)
  px(g, 12, 4, 1, 4, CHAIR_BACK)
}
function taskChairBackrest(g: Ctx) {
  px(g, 3, 8, 10, 5, CHAIR_BACK)
  px(g, 3, 8, 10, 1, shade.chairBackHi)
  px(g, 12, 9, 1, 4, shade.chairBackLo)
  px(g, 7, 13, 2, 2, shade.chairBase)
  px(g, 4, 15, 8, 1, shade.chairBase)
}

// ── bench terminal (catalogue: steel-grey worktop rows 7-10, legs, monitor, keyboard, stack light on the LEFT) ────
/** Terminal screen inside the bezel. */
export const BENCH_SCREEN = { x: 6, y: 1, w: 6, h: 5 } as const
/** Stack-light lamps at x 1-2, top to bottom: blue (1 row), red, amber, green (2 rows each). Kept on the LEFT edge,
 *  away from the worker's status dot (columns 11-15). */
export const STACK_LAMPS = {
  blue: { y: 0, h: 1 }, red: { y: 1, h: 2 }, amber: { y: 3, h: 2 }, green: { y: 5, h: 2 },
} as const

function benchTerminal(g: Ctx) {
  px(g, 0, 7, 16, 4, BENCH_TOP)
  px(g, 0, 7, 16, 1, STEEL)
  px(g, 0, 10, 16, 1, shade.benchLo)
  px(g, 1, 11, 1, 5, shade.benchLeg)
  px(g, 14, 11, 1, 5, shade.benchLeg)
  px(g, 2, 13, 12, 1, shade.benchLeg)        // the lower rail between the legs
  // monitor on the worktop
  px(g, 5, 0, 8, 7, MONITOR_FRAME)
  px(g, BENCH_SCREEN.x, BENCH_SCREEN.y, BENCH_SCREEN.w, BENCH_SCREEN.h, MONITOR)
  px(g, 12, 0, 1, 7, shade.bezelLo)
  px(g, 8, 7, 2, 1, shade.keyboard)
  px(g, 6, 8, 6, 1, shade.keyboardDark)
  // stack light, all lamps dim
  px(g, 1, STACK_LAMPS.blue.y, 2, STACK_LAMPS.blue.h, LAMP_BLUE_OFF)
  px(g, 1, STACK_LAMPS.red.y, 2, STACK_LAMPS.red.h, LAMP_RED_OFF)
  px(g, 1, STACK_LAMPS.amber.y, 2, STACK_LAMPS.amber.h, LAMP_AMBER_OFF)
  px(g, 1, STACK_LAMPS.green.y, 2, STACK_LAMPS.green.h, LAMP_GREEN_OFF)
}

export const WORK_SEATS = { taskChairN: { seat: taskChairSeat, backrest: taskChairBackrest } } as const

export const WORK_TILES = {
  pcDesk,
  taskChairN: (g: Ctx) => { taskChairSeat(g); taskChairBackrest(g) },
  benchTerminal,
} as const
