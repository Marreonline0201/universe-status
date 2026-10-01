// The shell of the worker office: wall faces, wall tops, windows (north windows seen from inside, facade windows
// seen from the street) and the jambs beside openings. The wall and window art is the existing office art
// (assets.ts:22-25, 101-109, 143-166) so the new building matches the old one's materials.
import { type Ctx, px, lighten } from './paint'
import { TILE } from './floors'

const WALL_FACE = '#2e2620'
const WALL_CAP = '#a08b6a'
const WALL_CAP_EDGE = '#6e5c44'
const WALL_BASE = '#1f1a15'
const GLASS_FRAME = '#8fa1ab'
const GLASS_SHINE = 'rgba(255,255,255,0.30)'
const SKY_TOP = '#9ec7d8'
const SKY_MID = '#b4d4d4'
const SKY_BOT = '#c8dfd0'

/** South face of a wall run: limestone cap, espresso face, baseboard. */
export function wallFace(g: Ctx) {
  px(g, 0, 0, TILE, TILE, WALL_FACE)
  px(g, 0, 0, TILE, 4, WALL_CAP)
  px(g, 0, 4, TILE, 1, WALL_CAP_EDGE)
  px(g, 0, 14, TILE, 2, WALL_BASE)
  px(g, 5, 5, 1, 9, 'rgba(0,0,0,0.25)')
  px(g, 10, 5, 1, 9, 'rgba(0,0,0,0.25)')
}

/** Top of a wall run that continues south (vertical runs, junctions): only the cap shows from this angle. */
export function wallTop(g: Ctx, checker: boolean) {
  px(g, 0, 0, TILE, TILE, WALL_CAP)
  px(g, 0, 0, 1, TILE, WALL_CAP_EDGE)
  px(g, 15, 0, 1, TILE, WALL_CAP_EDGE)
  px(g, 1, 0, 1, TILE, 'rgba(0,0,0,0.12)')
  px(g, 14, 0, 1, TILE, 'rgba(0,0,0,0.12)')
  if (checker) {
    px(g, 6, 4, 2, 1, '#b09b78'); px(g, 9, 12, 1, 1, '#8f7c5e')
  } else {
    px(g, 8, 7, 2, 1, '#b09b78'); px(g, 5, 2, 1, 1, '#8f7c5e')
  }
}

/** A window in an outer wall seen from inside: sky through the glass. */
export function windowInterior(g: Ctx) {
  wallFace(g)
  px(g, 1, 5, 14, 9, GLASS_FRAME)
  px(g, 2, 6, 12, 3, SKY_TOP)
  px(g, 2, 9, 12, 2, SKY_MID)
  px(g, 2, 11, 12, 2, SKY_BOT)
  px(g, 8, 5, 1, 9, GLASS_FRAME)
  px(g, 3, 7, 1, 1, GLASS_SHINE); px(g, 4, 8, 1, 1, GLASS_SHINE)
}

/** A window in the facade seen from the street: dim interior behind the glass, sky reflections, a stone sill. */
export function windowExterior(g: Ctx) {
  wallFace(g)
  px(g, 1, 5, 14, 9, GLASS_FRAME)
  px(g, 2, 6, 12, 7, '#2b3842')
  px(g, 2, 6, 12, 2, '#3a4c58')
  for (const [x, y] of [[3, 11], [4, 10], [5, 9], [6, 8], [7, 7], [10, 12], [11, 11], [12, 10], [13, 9]]) {
    px(g, x, y, 1, 1, 'rgba(200,226,236,0.45)')
  }
  px(g, 8, 5, 1, 9, GLASS_FRAME)
  px(g, 1, 13, 14, 1, '#c9c2b4')
}

/** The cut end of a wall beside an opening or the door, on side W or E of the tile. */
export function jamb(g: Ctx, side: 'W' | 'E', face: boolean) {
  const x = side === 'W' ? 0 : TILE - 1
  px(g, x, 0, 1, 4, lighten(WALL_CAP, 0.18))
  if (face) px(g, x, 4, 1, 12, '#1a1511')
}
