// Floor finishes and ground surfaces of the worker office (plan §1.2, §6.1): the 9 interior finishes, the
// sidewalk, the street, the planters, the doormat and the door base, plus the door leaves for the state layer.
//
// Every function draws ONE 16×16 tile at the origin and depends only on its arguments, so a tile canvas can be
// cached by (finish, base colour, variant). The variant carries the tile's position modulo 4 —
// v = (x & 3) | ((y & 3) << 2) — for patterns that repeat over 2–4 tiles (checker parity, slab joints, terrazzo
// divider strips); nothing else about the position reaches the art. Base colours come from floorplan.json
// zones[].floor; shades are derived from them.
import { type Ctx, px, mix, lighten, darken } from './paint'

export const TILE = 16

export type FinishId =
  | 'oak' | 'travertine' | 'vinyl' | 'carpet' | 'checker' | 'terrazzo' | 'carpetTiles' | 'raisedFloor'
  | 'concrete' | 'asphalt'

/** floorplan.json zones[].finish -> art. An unknown finish name is an error, not a silent default. */
const FINISH_BY_NAME: Readonly<Record<string, FinishId>> = {
  'oak (existing art)': 'oak',
  travertine: 'travertine',
  'grey vinyl': 'vinyl',
  'green carpet': 'carpet',
  'blue carpet': 'carpet',
  'checker tile': 'checker',
  terrazzo: 'terrazzo',
  'grey carpet tiles': 'carpetTiles',
  'raised floor': 'raisedFloor',
  concrete: 'concrete',
  asphalt: 'asphalt',
}

export function finishOf(name: string): FinishId {
  const f = FINISH_BY_NAME[name]
  if (!f) throw new Error(`unknown floor finish "${name}" (known: ${Object.keys(FINISH_BY_NAME).join(', ')})`)
  return f
}

/** Position variant of a tile (see the file header). */
export const variantOf = (x: number, y: number) => (x & 3) | ((y & 3) << 2)
const xOdd = (v: number) => (v & 1) === 1
const yOdd = (v: number) => ((v >> 2) & 1) === 1
/** The engine's long-standing parity: true on (x + y) even (assets.ts woodBase `checker`). */
const evenParity = (v: number) => xOdd(v) === yOdd(v)

/** Deterministic scatter for speckled finishes: n points (x, y, pick) from a seed. */
function scatter(seed: number, n: number): [number, number, number][] {
  let s = (seed * 2654435761) >>> 0
  const out: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    const r = s >>> 8
    out.push([r & 15, (r >> 4) & 15, (r >> 8) & 255])
  }
  return out
}

// ── the existing oak and travertine art (assets.ts:15-21, 89-100, 135-141), kept pixel for pixel ─────────────
const WOOD_B = '#75573a'
const WOOD_SEAM = '#57402a'
const WOOD_SHINE = '#8a6a48'
const STONE_B = '#635c53'
const STONE_SEAM = '#4a453e'

function oak(g: Ctx, base: string, v: number) {
  const checker = evenParity(v)
  px(g, 0, 0, TILE, TILE, checker ? WOOD_B : base)
  px(g, 0, 5, TILE, 1, WOOD_SEAM)
  px(g, 0, 11, TILE, 1, WOOD_SEAM)
  if (checker) {
    px(g, 4, 0, 1, 5, WOOD_SEAM); px(g, 10, 6, 1, 5, WOOD_SEAM); px(g, 6, 12, 1, 4, WOOD_SEAM)
    px(g, 2, 8, 1, 1, WOOD_SHINE); px(g, 9, 14, 1, 1, WOOD_SHINE)
  } else {
    px(g, 11, 0, 1, 5, WOOD_SEAM); px(g, 5, 6, 1, 5, WOOD_SEAM); px(g, 12, 12, 1, 4, WOOD_SEAM)
    px(g, 7, 3, 1, 1, WOOD_SHINE); px(g, 13, 9, 1, 1, WOOD_SHINE)
  }
}

function travertine(g: Ctx, base: string, v: number) {
  const checker = evenParity(v)
  px(g, 0, 0, TILE, TILE, checker ? STONE_B : base)
  px(g, 0, 7, TILE, 1, STONE_SEAM)
  if (checker) px(g, 7, 0, 1, 7, STONE_SEAM)
  px(g, 4, 3, 1, 1, checker ? base : STONE_B)
  px(g, 12, 11, 1, 1, checker ? base : STONE_B)
}

// ── step-2 mock finishes (office-objects/catalog-s2/mock.py vinyl, carpet) ─────────────────────────────────────
function vinyl(g: Ctx, base: string, v: number) {
  const checker = evenParity(v)
  px(g, 0, 0, TILE, TILE, checker ? lighten(base, 0.05) : base)
  px(g, 0, 15, TILE, 1, darken(base, 0.15))
  px(g, 15, 0, 1, TILE, darken(base, 0.15))
  px(g, checker ? 3 : 9, checker ? 5 : 11, 1, 1, lighten(base, 0.15))
}

function carpet(g: Ctx, base: string, v: number) {
  const checker = evenParity(v)
  px(g, 0, 0, TILE, TILE, base)
  const pat = lighten(base, 0.08), deep = darken(base, 0.14)
  for (const [dx, dy] of checker ? [[2, 3], [10, 7], [6, 12]] : [[5, 2], [13, 10], [1, 9]]) px(g, dx, dy, 1, 1, pat)
  for (const [dx, dy] of checker ? [[12, 1], [4, 8], [14, 14]] : [[9, 5], [3, 13], [11, 15]]) px(g, dx, dy, 1, 1, deep)
}

// ── new finishes ───────────────────────────────────────────────────────────────────────────────────────────────
/** Break room: two-tone vinyl checks, 0.3 m squares (2×2 per 0.6 m tile), continuous across tiles. */
function checkerTile(g: Ctx, base: string) {
  const light = lighten(base, 0.3), dark = darken(base, 0.2)
  px(g, 0, 0, 8, 8, light); px(g, 8, 8, 8, 8, light)
  px(g, 8, 0, 8, 8, dark); px(g, 0, 8, 8, 8, dark)
  const sheen = lighten(light, 0.3)
  px(g, 1, 1, 2, 1, sheen); px(g, 9, 9, 2, 1, sheen)
}

/** Reception: terrazzo — stone chips in a poured base, brass divider strips every 2 tiles (1.2 m). */
function terrazzo(g: Ctx, base: string, v: number) {
  px(g, 0, 0, TILE, TILE, base)
  const chips = [lighten(base, 0.38), darken(base, 0.32), mix(base, '#c08a5a', 0.45), mix(base, '#7f97a8', 0.45), lighten(base, 0.18)]
  for (const [x, y, k] of scatter(v + 101, 16)) px(g, x, y, 1, 1, chips[k % chips.length])
  for (const [x, y, k] of scatter(v + 307, 3)) px(g, Math.min(x, 14), y, 2, 1, chips[k % chips.length])
  const brass = mix(base, '#c9a25c', 0.65)
  if (!yOdd(v)) px(g, 0, 0, TILE, 1, brass)
  if (!xOdd(v)) px(g, 0, 0, 1, TILE, brass)
}

/** Mail / print corner: carpet tiles laid quarter-turned, so the pile runs across on one tile and down on the next. */
function carpetTiles(g: Ctx, base: string, v: number) {
  px(g, 0, 0, TILE, TILE, base)
  const pile = lighten(base, 0.07)
  if (evenParity(v)) for (let y = 1; y < 15; y += 3) px(g, 1, y, 14, 1, pile)
  else for (let x = 1; x < 15; x += 3) px(g, x, 1, 1, 14, pile)
  const seam = darken(base, 0.12)
  px(g, 0, 15, TILE, 1, seam)
  px(g, 15, 0, 1, TILE, seam)
}

/** Server room: 600 mm raised-floor panels (one per tile), bevelled; every fourth panel perforated. */
function raisedFloor(g: Ctx, base: string, v: number) {
  px(g, 0, 0, TILE, TILE, base)
  const hi = lighten(base, 0.2), lo = darken(base, 0.3), dot = darken(base, 0.35)
  px(g, 0, 0, TILE, 1, hi); px(g, 0, 0, 1, TILE, hi)
  px(g, 0, 15, TILE, 1, lo); px(g, 15, 0, 1, TILE, lo)
  if (xOdd(v) && yOdd(v)) {
    for (let y = 3; y <= 12; y += 3) for (let x = 3; x <= 12; x += 3) px(g, x, y, 1, 1, dot)
  } else {
    for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) px(g, x, y, 1, 1, dot)
  }
}

/** Sidewalk: concrete slabs of 2×2 tiles (1.2 m) with aggregate specks. */
function concrete(g: Ctx, base: string, v: number) {
  px(g, 0, 0, TILE, TILE, base)
  const light = lighten(base, 0.12), dark = darken(base, 0.12)
  for (const [x, y, k] of scatter(v + 11, 12)) px(g, x, y, 1, 1, k & 1 ? light : dark)
  const joint = darken(base, 0.24)
  if (!xOdd(v)) px(g, 0, 0, 1, TILE, joint)
  if (!yOdd(v)) px(g, 0, 0, TILE, 1, joint)
}

/** Street: asphalt with a kerb stone along the sidewalk and a dashed centre line. */
function asphalt(g: Ctx, base: string, v: number) {
  px(g, 0, 0, TILE, TILE, base)
  const light = lighten(base, 0.18), dark = darken(base, 0.25)
  for (const [x, y, k] of scatter(v + 53, 14)) px(g, x, 3 + (y % 13), 1, 1, k & 1 ? light : dark)
  px(g, 0, 0, TILE, 2, '#a7a39a')          // kerb
  px(g, 0, 2, TILE, 1, darken(base, 0.4))  // gutter shadow
  if ((v & 3) === 0) px(g, 2, 10, 12, 1, '#d9d2b8')
}

export function drawFinish(g: Ctx, id: FinishId, base: string, v: number) {
  switch (id) {
    case 'oak': oak(g, base, v); break
    case 'travertine': travertine(g, base, v); break
    case 'vinyl': vinyl(g, base, v); break
    case 'carpet': carpet(g, base, v); break
    case 'checker': checkerTile(g, base); break
    case 'terrazzo': terrazzo(g, base, v); break
    case 'carpetTiles': carpetTiles(g, base, v); break
    case 'raisedFloor': raisedFloor(g, base, v); break
    case 'concrete': concrete(g, base, v); break
    case 'asphalt': asphalt(g, base, v); break
  }
}

// ── surfaces that are objects in floorplan.json but belong to the ground ──────────────────────────────────────
/** Planter box at the map border (legend colour = foliage). Drawn as a full tile. */
export function planter(g: Ctx, foliage: string) {
  px(g, 0, 0, TILE, TILE, '#77736b')              // concrete box
  px(g, 0, 0, TILE, 2, '#a39e94')                 // rim
  px(g, 0, 15, TILE, 1, '#4f4c47')                // footing shadow
  px(g, 2, 3, 12, 10, '#3a2c20')                  // soil
  px(g, 2, 2, 6, 6, foliage); px(g, 7, 1, 7, 7, lighten(foliage, 0.18))
  px(g, 3, 6, 9, 6, darken(foliage, 0.22)); px(g, 9, 7, 4, 4, foliage)
  px(g, 5, 3, 1, 1, lighten(foliage, 0.4)); px(g, 11, 4, 1, 1, lighten(foliage, 0.4))
}

/** Coir doormat lying on the sidewalk (draw the sidewalk first). part: which end of the mat this tile is. */
export function doormat(g: Ctx, base: string, part: 'W' | 'E' | 'C') {
  const border = darken(base, 0.38), fibre = lighten(base, 0.12)
  const x0 = part === 'W' ? 1 : 0, x1 = part === 'E' ? 15 : 16
  px(g, x0, 3, x1 - x0, 11, base)
  for (let y = 5; y < 12; y += 2) px(g, x0 + 1, y, x1 - x0 - 2, 1, fibre)
  px(g, x0, 3, x1 - x0, 1, border); px(g, x0, 13, x1 - x0, 1, border)
  if (part === 'W') px(g, x0, 3, 1, 11, border)
  if (part === 'E') px(g, x1 - 1, 3, 1, 11, border)
}

// ── the front door ─────────────────────────────────────────────────────────────────────────────────────────────
const WALL_CAP = '#a08b6a'
const WALL_CAP_EDGE = '#6e5c44'
const ALU = '#8fa1ab'

/** The doorway in the facade, seen from the street: the wall header, the dim hall behind, an aluminium
 *  threshold. side: which jamb this leaf tile carries. The leaves themselves are drawn by doorLeaves(). */
export function doorBase(g: Ctx, side: 'W' | 'E') {
  px(g, 0, 0, TILE, 4, WALL_CAP)
  px(g, 0, 4, TILE, 1, WALL_CAP_EDGE)
  px(g, 0, 5, TILE, 9, '#2c2925')
  px(g, 0, 12, TILE, 2, '#3a3631')
  px(g, 0, 14, TILE, 2, '#b8bfc6')
  px(g, 0, 15, TILE, 1, '#8a9096')
  px(g, side === 'W' ? 0 : 15, 4, 1, 12, ALU)
}

/** State layer: the two sliding glass leaves, in texels, with the world origin at the door's top-left tile.
 *  open = 0 (closed) .. 1 (fully open, each leaf slid into its side pocket). */
export function doorLeaves(g: Ctx, x0: number, y0: number, open: number) {
  const slide = Math.round(Math.max(0, Math.min(1, open)) * 14)
  for (const [i, dir] of [[0, -1], [1, 1]] as const) {
    const lx = x0 + i * TILE + (i === 0 ? 1 : 0) + dir * slide
    const w = 15
    const clipL = x0 + (i === 0 ? 1 : TILE), clipR = x0 + (i === 0 ? TILE : 2 * TILE - 1)
    const a = Math.max(lx, clipL), b = Math.min(lx + w, clipR)
    if (b <= a) continue
    px(g, a, y0 + 5, b - a, 9, 'rgba(170,214,222,0.42)')
    px(g, a, y0 + 5, b - a, 1, ALU)
    px(g, a, y0 + 13, b - a, 1, ALU)
    if (lx >= clipL) px(g, lx, y0 + 5, 1, 9, ALU)
    if (lx + w <= clipR) px(g, lx + w - 1, y0 + 5, 1, 9, ALU)
    const hx = i === 0 ? lx + w - 3 : lx + 2
    if (hx >= a && hx < b) px(g, hx, y0 + 8, 1, 3, '#dfe4e8')
    for (const [dx, dy] of [[3, 6], [4, 7], [5, 8], [9, 6], [10, 7]]) {
      const sx = lx + dx
      if (sx >= a && sx < b) px(g, sx, y0 + dy, 1, 1, 'rgba(255,255,255,0.35)')
    }
  }
}
