// STEP-1 PLACEHOLDERS for the furniture (plan §6.1: "objects may be simple placeholders; step 2 draws them").
// Each is a block in the object's legend colour, drawn on a TRANSPARENT layer so the room's floor finish shows
// around it (the two-layer pre-render). Step 2 replaces this file with tiles-*.ts.
import type { OfficeObject } from '../map/loadMap'
import { type Ctx, px, lighten, darken } from './paint'
import { TILE } from './floors'

const SEATS: ReadonlySet<string> = new Set(['taskChairN', 'woodChairN', 'armchairN', 'sofaN', 'receptionChair', 'visitorChair'])

/** Draw tile i (row-major) of object o at the origin. color: the object's legend colour. */
export function drawPlaceholder(g: Ctx, o: OfficeObject, i: number, color: string) {
  const col = i % o.w
  const first = col === 0, last = col === o.w - 1
  if (o.wallMounted) {
    // a panel on the wall face (the wall itself is on the floor layer underneath)
    const l = first ? 1 : 0, r = last ? TILE - 1 : TILE
    px(g, l, 5, r - l, 9, darken(color, 0.4))
    px(g, first ? l + 1 : l, 6, (r - l) - (first ? 1 : 0) - (last ? 1 : 0), 7, color)
    return
  }
  if (SEATS.has(o.kind)) {
    const l = first ? 3 : 0, r = last ? 13 : TILE
    const cushion = lighten(color, 0.14), base = darken(color, 0.45)
    if (o.facing === 'N') {          // backrest toward the camera (rows 8–15, plan §2 drawing rules)
      px(g, l, 4, r - l, 6, cushion)
      px(g, l, 9, r - l, 5, color)
    } else {
      px(g, l, 3, r - l, 4, color)
      px(g, l, 6, r - l, 6, cushion)
    }
    px(g, l, 13, r - l, 1, base)
    return
  }
  switch (o.kind) {
    case 'plant':
      px(g, 5, 10, 6, 5, '#c9b8a4'); px(g, 5, 10, 6, 1, '#d8cbb8')
      px(g, 3, 3, 10, 8, color); px(g, 6, 1, 4, 3, lighten(color, 0.15)); px(g, 4, 6, 8, 4, darken(color, 0.2))
      return
    case 'coatStand':
      px(g, 7, 3, 2, 11, darken(color, 0.25)); px(g, 4, 3, 8, 5, color); px(g, 5, 13, 6, 2, darken(color, 0.45))
      return
    case 'floorLamp':
      px(g, 7, 6, 2, 8, '#3a3128'); px(g, 5, 14, 6, 1, '#3a3128')
      px(g, 4, 1, 8, 5, color); px(g, 3, 5, 10, 1, color); px(g, 5, 2, 2, 2, lighten(color, 0.35))
      return
    default: {
      const l = first ? 1 : 0, r = last ? TILE - 1 : TILE
      px(g, l, 2, r - l, 12, color)
      px(g, l, 2, r - l, 4, lighten(color, 0.18))
      px(g, l, 6, r - l, 1, darken(color, 0.25))
      px(g, l, 13, r - l, 1, darken(color, 0.45))
    }
  }
}
