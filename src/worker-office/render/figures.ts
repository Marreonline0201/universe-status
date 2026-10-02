// The worker figures (D14 (a): pixel art, drawn smooth and well-proportioned; approved 2026-10-01 after three judged
// rounds). The 31 frames of the approved set (scratch office/figs/frames.json, round 3: props.ts POSES) as 16×16
// symbol grids, with one change the art director asked for at the port: readD's left hand is lit, 5 -> 6 at (5, 8) and
// (5, 9), so every held volume reaches 3:1 on one hand for every skin ramp (art check G measures it).
//
// GEOMETRY (frames.json "format"): a frame is drawn FIGURE_LIFT = 6 texels above its worker's tile, so frame row r
// covers row 10 + r of the tile to the north for r < 6. A standing frame's soles are on y = SOLE_Y = 16 (the tile's row
// 10), where the contact shadow is centred; a seated frame uses rows 0-13 only (the chair's backrest shows below). No
// frame holds a shadow texel. No frame is an engine mirror: the west profiles were mirrored and re-lit by hand.
// SYMBOLS (frames.json "palette_symbols"): hair 1 outline, 2 shadow, 3 mid, 4 light, H corner; skin 5 shadow, 6 mid,
// 7 light, e eye / lid, S corner; shirt a outline, b shadow, c mid, d light, C corner; trousers p outline, q shadow, r mid,
// s light, R corner; shoes x dark, y light; the desk phone's handset k and its highlight K (phoneU); '.' transparent.
// A corner symbol is its ramp's shadow tone at alpha 120/255 (manual anti-aliasing that blends with any floor).
// LOOKS: every worker is a palette swap of the same grids (palette.ts FIGURE_*): skin × hair × shirt × trousers ×
// shoes, picked from the worker's seed (a hash of its agent id: the core's spawn command), never from a name.
// DRAWING: every frame is rendered once per look into a 16×16 canvas, one whole-texel rect per texel (the art check
// draws it on strict canvases); the engine blits it at a whole-texel origin, scaled by its integer scale with smoothing
// off, so every texel is an exact block of device pixels, like the furniture. The contact shadow is one cached image:
// the engine's old ellipse (radii 5 × 2 texels, OfficeEngine.ts:449-452) snapped to texels, each texel at the share of
// it the ellipse covers (fig_render.py shadow_layer). The status dot is not a texel sprite: DOTS holds its centre and
// core radius per frame (the glow is r + 1), placed so neither touches the figure (frames.json "dot").
import { type Ctx, makeCanvas, px } from './paint.ts'
import { FIGURE_SKIN, FIGURE_HAIR, FIGURE_SHIRT, FIGURE_TROUSERS, FIGURE_SHOES, FIGURE_CORNER, FIGURE_SHADOW, shade } from './palette.ts'
import { POSES, type PoseName } from './props.ts'

/** Texels per frame side. */
export const FIGURE = 16
/** The frame is drawn this many texels above its worker's tile. */
export const FIGURE_LIFT = 6
/** The sole line of a standing frame (frame y): the contact shadow is centred on it. */
export const SOLE_Y = 16
/** The contact shadow: an ellipse of radii SHADOW_RX × SHADOW_RY texels centred on (8, SOLE_Y). Texels it covers less
 *  than SHADOW_MIN_COVER of stay empty. */
export const SHADOW_RX = 5
export const SHADOW_RY = 2
const SHADOW_MIN_COVER = 0.1

/** The status dot: centre (x, y) in frame texels (continuous) and core radius r; the glow is drawn at r + 1. */
export interface Dot { readonly x: number; readonly y: number; readonly r: number }

/** The approved frames, one row string of 16 symbols per texel row (readD carries the port's left-hand fix). */
export const FRAMES: Readonly<Record<PoseName, readonly string[]>> = {
  stand: [
    '......H343H.....',
    '......34432.....',
    '......7e7e5.....',
    '......S665S.....',
    '......Cd6bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbdccbbab...',
    '....a.bccba.a...',
    '....6.pqqqp.5...',
    '....5.rrqrq.5...',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....xy..yx.....',
  ],
  walkD0: [
    '......H343H.....',
    '......34432.....',
    '......7e7e5.....',
    '......S665S.....',
    '......Cd6bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbdccbbab...',
    '....6.bccba.b...',
    '....5.pqqqp.a...',
    '......rrqrq.5...',
    '......rq.rq.5...',
    '......rq.qp.....',
    '......rq..x.....',
    '.....xy.........',
  ],
  walkD1: [
    '......H343H.....',
    '......34432.....',
    '......7e7e5.....',
    '......S665S.....',
    '......Cd6bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbdccbbab...',
    '....c.bccba.5...',
    '....a.pqqqp.5...',
    '....6.rrqrq.....',
    '....5.rq.rq.....',
    '......rp.rq.....',
    '......x..rq.....',
    '.........yx.....',
  ],
  walkU0: [
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbcccbbab...',
    '....c.bccba.5...',
    '....a.pqqqp.5...',
    '....6.rrqrq.....',
    '....5.rq.rq.....',
    '......rq.rq.....',
    '......yx.qp.....',
    '.........yx.....',
  ],
  walkU1: [
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbcccbbab...',
    '....6.bccba.b...',
    '....5.pqqqp.a...',
    '......rrqrq.5...',
    '......rq.rq.5...',
    '......rq.rq.....',
    '......rq.yx.....',
    '.....yx.........',
  ],
  walkL0: [
    '......H343H.....',
    '......74431.....',
    '.....7e6531.....',
    '......6652......',
    '......C65C......',
    '......cdcbb.....',
    '.....bcddbb.....',
    '.....5cdcbc.....',
    '......cdca.6....',
    '......pqqqp.....',
    '......qrrq......',
    '......rr.qq.....',
    '.....rr...q.....',
    '.....rr...qq....',
    '....rr.....q....',
    '...xxy.....xx...',
  ],
  walkL1: [
    '......H343H.....',
    '......74431.....',
    '.....7e6531.....',
    '......6652......',
    '......C65C......',
    '......cdcbb.....',
    '......cdcdb.....',
    '......dccbc.....',
    '.....67ccb.5....',
    '......pqqqp.....',
    '......qrrr......',
    '......qq.rr.....',
    '.....qq...r.....',
    '.....qq...rr....',
    '....qq.....r....',
    '...xxx.....xy...',
  ],
  walkR0: [
    '......H343H.....',
    '......14437.....',
    '......1356e6....',
    '.......2665.....',
    '.......C56C.....',
    '......cdcbb.....',
    '......cdbcbb....',
    '......dbccb5....',
    '.....6.bcca.....',
    '......pqqqp.....',
    '.......qrrq.....',
    '......qq.rr.....',
    '......q...rr....',
    '.....qq...rr....',
    '.....q.....rr...',
    '....xx.....yxx..',
  ],
  walkR1: [
    '......H343H.....',
    '......14437.....',
    '......1356e6....',
    '.......2665.....',
    '.......C56C.....',
    '......cdcbb.....',
    '......cdcdb.....',
    '......bccbd.....',
    '.....5.bcc76....',
    '......pqqqp.....',
    '.......rrrq.....',
    '......rr.qq.....',
    '......r...qq....',
    '.....rr...qq....',
    '.....r.....qq...',
    '....yx.....xxx..',
  ],
  sit: [
    '.....76..76.....',
    '................',
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '.....cdcccbaC...',
    '....Cddcccbb....',
    '....cbdcccbba...',
    '.....bdccbba....',
    '.....bcccbba....',
    '.....pqqqqqp....',
    '.....rrrqrqp....',
    '................',
    '................',
  ],
  type0: [
    '.....76...6.....',
    '................',
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '.....cdcccbaC...',
    '....Cddcccbb....',
    '....cbdcccbba...',
    '.....bdccbba....',
    '.....bcccbba....',
    '.....pqqqqqp....',
    '.....rrrqrqp....',
    '................',
    '................',
  ],
  type1: [
    '......6..76.....',
    '................',
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '.....cdcccbaC...',
    '....Cddcccbb....',
    '....cbdcccbba...',
    '.....bdccbba....',
    '.....bcccbba....',
    '.....pqqqqqp....',
    '.....rrrqrqp....',
    '................',
    '................',
  ],
  standU: [
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbcccbbab...',
    '....a.bccba.a...',
    '....6.pqqqp.5...',
    '....5.rrqrq.5...',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
  useU0: [
    '......H343H.....',
    '......34432.76..',
    '......23321.65..',
    '......H221H.cb..',
    '......Cc5b..ba..',
    '....Ccdcccbca...',
    '....cddcccba....',
    '....cbdccbba....',
    '....abcccba.....',
    '......bccba.....',
    '......pqqqp.....',
    '......rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
  useU1: [
    '......H343.76...',
    '......34432.65..',
    '......23321.65..',
    '......H221H.cb..',
    '......Cc5b..ba..',
    '....Ccdcccbca...',
    '....cddcccba....',
    '....cbdccbba....',
    '....abcccba.....',
    '......bccba.....',
    '......pqqqp.....',
    '......rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
  reachU: [
    '......H343.76...',
    '......34432.65..',
    '......23321.65..',
    '......H221H.cb..',
    '......Cc5b..ba..',
    '....Ccdcccbca...',
    '....cddcccba....',
    '....cbdccbba....',
    '....bbcccba.....',
    '....a.bccba.....',
    '....6.pqqqp.....',
    '....5.rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
  readU: [
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbcccbbab...',
    '....a.bccba.a...',
    '......pqqqp.....',
    '......rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
  watchU: [
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbbb...',
    '....cbdcccba.b..',
    '....bbcccbba.a..',
    '....a.bccba.5...',
    '....6.pqqqp5....',
    '....5.rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
  sitBack: [
    '................',
    '................',
    '................',
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....a.bccba.a...',
    '....6.pqqqp.5...',
    '....5rrrqrqp5...',
    '................',
    '................',
  ],
  readD: [
    '......H343H.....',
    '......34432.....',
    '......65756.....',
    '......S665S.....',
    '......Cd6bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbba...',
    '....b6dcccb5a...',
    '.....6bccba5....',
    '......pqqqp.....',
    '......rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....xy..yx.....',
  ],
  ponderD: [
    '......H343H.....',
    '......34432.....',
    '......77e7e.....',
    '......S665S.....',
    '......C76bC.....',
    '....Ccd5ccbaC...',
    '....cd65ccbba...',
    '....c65dcbbab...',
    '....a.bccbbab...',
    '......bccba.a...',
    '......pqqqp.5...',
    '......rrqrq.5...',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....xy..yx.....',
  ],
  armsD: [
    '......H343H.....',
    '......34432.....',
    '......7e7e5.....',
    '......S665S.....',
    '......Cd6bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....c566775ba...',
    '...cb677b565ba..',
    '....a.bccba.a...',
    '......pqqqp.....',
    '......rrqrq.....',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....xy..yx.....',
  ],
  standL: [
    '......H343H.....',
    '......74431.....',
    '.....7e6531.....',
    '......6652......',
    '......C65C......',
    '......cdcbb.....',
    '......ccdbb.....',
    '......ccdba.....',
    '......ccbab.....',
    '......pq65p.....',
    '......qrr6......',
    '......qrrq......',
    '.......rrq......',
    '.......rrq......',
    '.......rrq......',
    '......xxyx......',
  ],
  standR: [
    '......H343H.....',
    '......14437.....',
    '......1356e6....',
    '.......2665.....',
    '.......C56C.....',
    '......cdcbb.....',
    '......cdbcb.....',
    '......cdbca.....',
    '......cbacb.....',
    '......p65qp.....',
    '.......6rrq.....',
    '.......qrrq.....',
    '.......qrr......',
    '.......qrr......',
    '.......qrr......',
    '.......xyxx.....',
  ],
  passD: [
    '......H343H.....',
    '......34432.....',
    '......7e7e5.....',
    '......S665S.....',
    '......Cd6bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbdccbbab...',
    '....a.bccba.a...',
    '....6.pqqqp.5...',
    '....5.rrqrq.5...',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '......xy.yx.....',
  ],
  passU: [
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '......Cc5bC.....',
    '....CcdcccbaC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '....bbcccbbab...',
    '....a.bccba.a...',
    '....6.pqqqp.5...',
    '....5.rrqrq.5...',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '......yx.yx.....',
  ],
  passL: [
    '......H343H.....',
    '......74431.....',
    '.....7e6531.....',
    '......6652......',
    '......C65C......',
    '......cdcbb.....',
    '......ccdbb.....',
    '......ccdba.....',
    '......ccbab.....',
    '......pq65p.....',
    '......qrr6......',
    '.......rrq......',
    '.......rrq......',
    '.......rrq......',
    '.......rrx......',
    '......xxy.......',
  ],
  passR: [
    '......H343H.....',
    '......14437.....',
    '......1356e6....',
    '.......2665.....',
    '.......C56C.....',
    '......cdcbb.....',
    '......cdbcb.....',
    '......cdbca.....',
    '......cbacb.....',
    '......p65qp.....',
    '.......6rrq.....',
    '.......qrr......',
    '.......qrr......',
    '.......qrr......',
    '.......xrr......',
    '........yxx.....',
  ],
  sitBackLean: [
    '................',
    '................',
    '................',
    '................',
    '......H343H.....',
    '...cb.34432.ab..',
    '...b6523321566..',
    '....a.65556.a...',
    '....Ccbc5bbbC...',
    '....cddcccbba...',
    '....cbdcccbab...',
    '.....bbccbba....',
    '.....pqqqqqp....',
    '.....rrrqrqp....',
    '................',
    '................',
  ],
  sitBackNotepad: [
    '..........76....',
    '................',
    '................',
    '......H343H.....',
    '......34432.....',
    '......23321.....',
    '......H221H.....',
    '.....Ccc5bcaC...',
    '....cddcccbbb...',
    '....cbdcccbba...',
    '....a.bcccbba...',
    '....6.bcccbba...',
    '.....pqqqqqp....',
    '.....rrrqrqp....',
    '................',
    '................',
  ],
  phoneU: [
    '...k..H343H.....',
    '....kK34432.....',
    '...76k23321.....',
    '...65.H221H.....',
    '...cb.Cc5bC.....',
    '...bcCdcccbaC...',
    '....cddcccbba...',
    '.....bdcccbab...',
    '.....bcccbbab...',
    '......bccba.a...',
    '......pqqqp.5...',
    '......rrqrq.5...',
    '......rq.rq.....',
    '......rq.rq.....',
    '......rq.qp.....',
    '.....yx..yx.....',
  ],
}

/** The status dot per frame: (2.5, 2.5) for every standing frame; (14.5, 2.5) for phoneU, the west profiles and
 *  every seated frame (round 3). The glow reaches x 17 on the right: the engine must not clip it to the cell. */
export const DOTS: Readonly<Record<PoseName, Dot>> = {
  stand: { x: 2.5, y: 2.5, r: 1.5 },
  walkD0: { x: 2.5, y: 2.5, r: 1.5 },
  walkD1: { x: 2.5, y: 2.5, r: 1.5 },
  walkU0: { x: 2.5, y: 2.5, r: 1.5 },
  walkU1: { x: 2.5, y: 2.5, r: 1.5 },
  walkL0: { x: 14.5, y: 2.5, r: 1.5 },
  walkL1: { x: 14.5, y: 2.5, r: 1.5 },
  walkR0: { x: 2.5, y: 2.5, r: 1.5 },
  walkR1: { x: 2.5, y: 2.5, r: 1.5 },
  sit: { x: 14.5, y: 2.5, r: 1.5 },
  type0: { x: 14.5, y: 2.5, r: 1.5 },
  type1: { x: 14.5, y: 2.5, r: 1.5 },
  standU: { x: 2.5, y: 2.5, r: 1.5 },
  useU0: { x: 2.5, y: 2.5, r: 1.5 },
  useU1: { x: 2.5, y: 2.5, r: 1.5 },
  reachU: { x: 2.5, y: 2.5, r: 1.5 },
  readU: { x: 2.5, y: 2.5, r: 1.5 },
  watchU: { x: 2.5, y: 2.5, r: 1.5 },
  sitBack: { x: 14.5, y: 2.5, r: 1.5 },
  readD: { x: 2.5, y: 2.5, r: 1.5 },
  ponderD: { x: 2.5, y: 2.5, r: 1.5 },
  armsD: { x: 2.5, y: 2.5, r: 1.5 },
  standL: { x: 14.5, y: 2.5, r: 1.5 },
  standR: { x: 2.5, y: 2.5, r: 1.5 },
  passD: { x: 2.5, y: 2.5, r: 1.5 },
  passU: { x: 2.5, y: 2.5, r: 1.5 },
  passL: { x: 14.5, y: 2.5, r: 1.5 },
  passR: { x: 2.5, y: 2.5, r: 1.5 },
  sitBackLean: { x: 14.5, y: 2.5, r: 1.5 },
  sitBackNotepad: { x: 14.5, y: 2.5, r: 1.5 },
  phoneU: { x: 14.5, y: 2.5, r: 1.5 },
}

// ── looks ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type SkinId = keyof typeof FIGURE_SKIN
export type HairId = keyof typeof FIGURE_HAIR
export type ShirtId = keyof typeof FIGURE_SHIRT
export type TrousersId = keyof typeof FIGURE_TROUSERS
export type ShoesId = keyof typeof FIGURE_SHOES
export interface Look {
  readonly skin: SkinId
  readonly hair: HairId
  readonly shirt: ShirtId
  readonly trousers: TrousersId
  readonly shoes: ShoesId
}
const SKINS = Object.keys(FIGURE_SKIN) as SkinId[]
const HAIRS = Object.keys(FIGURE_HAIR) as HairId[]
const SHIRTS = Object.keys(FIGURE_SHIRT) as ShirtId[]
const TROUSERS = Object.keys(FIGURE_TROUSERS) as TrousersId[]
const SHOES = Object.keys(FIGURE_SHOES) as ShoesId[]
/** How many different looks there are. */
export const LOOK_COUNT = SKINS.length * HAIRS.length * SHIRTS.length * TROUSERS.length * SHOES.length

/** A 32-bit integer finaliser (murmur3 fmix32), so the look does not share bits with the seed's other uses. */
function fmix(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** The look of a worker, from its seed (the spawn command's hash of its agent id). The same seed always gives the
 *  same look, so a worker that walks back in looks the same (plan §4.6). */
export function lookOf(seed: number): Look {
  let h = fmix((seed ^ 0x5bd1e995) >>> 0)
  const pick = <T>(list: readonly T[]): T => { const v = list[h % list.length]; h = Math.floor(h / list.length); return v }
  return { skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(SHIRTS), trousers: pick(TROUSERS), shoes: pick(SHOES) }
}

export const lookKey = (l: Look) => `${l.skin}|${l.hair}|${l.shirt}|${l.trousers}|${l.shoes}`

/** Symbol -> colour for one look: the ramp builder. Every symbol of every frame is defined (the art check sweeps
 *  them); '.' is transparent and never drawn. */
export function figurePalette(l: Look): Readonly<Record<string, string>> {
  const skin = FIGURE_SKIN[l.skin], hair = FIGURE_HAIR[l.hair], shirt = FIGURE_SHIRT[l.shirt]
  const trousers = FIGURE_TROUSERS[l.trousers], shoes = FIGURE_SHOES[l.shoes]
  return {
    '1': hair['1'], '2': hair['2'], '3': hair['3'], '4': hair['4'], H: FIGURE_CORNER.hair[l.hair],
    '5': skin['5'], '6': skin['6'], '7': skin['7'], e: skin.e, S: FIGURE_CORNER.skin[l.skin],
    a: shirt.a, b: shirt.b, c: shirt.c, d: shirt.d, C: FIGURE_CORNER.shirt[l.shirt],
    p: trousers.p, q: trousers.q, r: trousers.r, s: trousers.s, R: FIGURE_CORNER.trousers[l.trousers],
    x: shoes.x, y: shoes.y,
    k: shade.handset, K: shade.phoneHi,
  }
}

/** Draw one frame of a look at (x0, y0), one whole-texel rect per texel. Throws on a symbol the palette lacks. */
export function drawFigure(g: Ctx, pose: PoseName, pal: Readonly<Record<string, string>>, x0 = 0, y0 = 0) {
  const rows = FRAMES[pose]
  for (let y = 0; y < FIGURE; y++) {
    const row = rows[y]
    for (let x = 0; x < FIGURE; x++) {
      const ch = row[x]
      if (ch === '.') continue
      const c = pal[ch]
      if (c === undefined) throw new Error(`figures: ${pose} (${x},${y}) has the unknown symbol ${ch}`)
      px(g, x0 + x, y0 + y, 1, 1, c)
    }
  }
}

/** A look's 31 frames, rendered on first use and kept (a worker holds its set from spawn to exit, so asking for a
 *  frame per draw builds nothing). */
export interface FigureSet {
  readonly look: Look
  image(pose: PoseName): HTMLCanvasElement
}

const sets = new Map<string, FigureSet>()
let renders = 0
/** How many figure frames have been rendered (each look and frame at most once). */
export const figureRenders = () => renders

export function figureSet(look: Look): FigureSet {
  const key = lookKey(look)
  const hit = sets.get(key)
  if (hit) return hit
  const pal = figurePalette(look)
  const images = new Map<PoseName, HTMLCanvasElement>()
  const set: FigureSet = {
    look,
    image(pose) {
      const c = images.get(pose)
      if (c) return c
      const [canvas, g] = makeCanvas(FIGURE, FIGURE)
      drawFigure(g, pose, pal)
      renders++
      images.set(pose, canvas)
      return canvas
    },
  }
  sets.set(key, set)
  return set
}

/** The share of texel (x, y) the shadow ellipse covers (32 × 32 samples, as fig_render.py). */
export function shadowCover(x: number, y: number): number {
  const N = 32
  let c = 0
  for (let j = 0; j < N; j++) {
    const py = y + (j + 0.5) / N
    for (let i = 0; i < N; i++) {
      const pxx = x + (i + 0.5) / N
      if (((pxx - 8) / SHADOW_RX) ** 2 + ((py - SOLE_Y) / SHADOW_RY) ** 2 <= 1) c++
    }
  }
  return c / (N * N)
}

/** The shadow's box in frame texels (its image is drawn at the frame origin + (SHADOW_X0, SHADOW_Y0)). */
export const SHADOW_X0 = 8 - SHADOW_RX - 1
export const SHADOW_Y0 = SOLE_Y - SHADOW_RY - 1
const SHADOW_W = 2 * SHADOW_RX + 2
const SHADOW_H = 2 * SHADOW_RY + 2
let shadow: HTMLCanvasElement | null = null
/** The contact shadow under a standing worker (never a seated one: props.ts drawsContactShadow), cached. */
export function shadowImage(): HTMLCanvasElement {
  if (shadow) return shadow
  const [c, g] = makeCanvas(SHADOW_W, SHADOW_H)
  g.fillStyle = FIGURE_SHADOW
  for (let y = 0; y < SHADOW_H; y++) {
    for (let x = 0; x < SHADOW_W; x++) {
      const cover = shadowCover(SHADOW_X0 + x, SHADOW_Y0 + y)
      if (cover < SHADOW_MIN_COVER) continue
      g.globalAlpha = cover
      g.fillRect(x, y, 1, 1)
    }
  }
  g.globalAlpha = 1
  shadow = c
  return c
}

// every frame name has a grid and a dot (the art check holds the rest)
for (const p of POSES) if (!FRAMES[p] || !DOTS[p]) throw new Error(`figures: no frame for ${p}`)
