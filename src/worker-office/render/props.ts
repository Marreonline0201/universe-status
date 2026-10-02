// Hand-held props of the vertical slice (plan §2 "Props", §4.4) and the hand-position table of the worker figures.
//
// The hand table (HAND) is re-derived from the approved figure frame set (D14 (a), frames.json round 3; the frames
// themselves are figures.ts): per frame, where a held prop's grip point goes in the 16×16 figure cell, which view of
// the prop that frame shows, whether the prop is drawn in front of the body or behind it, the hand texels that hold
// it (carry: scripts/worker-office-art-check.ts section G proves every view a frame can show touches one of them
// without covering it), where a clipped pager goes, and whether the frame is seated. Props are NOT clipped to the
// cell: reachU's raised hand holds the pulled volume above the frame's top row.
// readD has a second, narrow anchor (round 3): a view at most narrow.maxW texels wide (the pager, the call slip, the
// ticket, the form) goes there, against the right hand; at the main anchor it would float between the hands
// (propAnchor). armsD pins the carried item under the arm, behind the figure (heldBy 'arm').
// The volume held view (the ledger and the book, read in readD) is the art director's round-3 variant A: a closed
// volume held up, cover to the camera, the binding shade down the left column with one gilt texel, the paper
// fore-edge down the right column (no centre line, no paper along the top: those read as a collar and a tie).
//
// The slice's props (plan §2; pass 2 adds ring binder, envelope, parcel, marker): manila folder (file cabinet),
// ledger (history shelf), book (bookshelf), call slip (card catalog), printout (printer -> front desk), form (front
// desk), ticket (front desk IN tray) and pager (a worker really waiting for its own background job).
import { type Ctx, makeCanvas, px } from './paint.ts'
import {
  MANILA, MANILA_DARK, PAPER, INK_GREY, LEDGER, GOLD, SLIP_YELLOW, STEEL, LAMP_GREEN_ON, TAB_ORANGE, TERM_TEXT, BOOK_COLOURS,
  BINDING_SHADE, shade,
} from './palette.ts'

export type PropId = 'folder' | 'ledger' | 'book' | 'callSlip' | 'printout' | 'form' | 'ticket' | 'pager'
export const PROP_IDS: readonly PropId[] = ['folder', 'ledger', 'book', 'callSlip', 'printout', 'form', 'ticket', 'pager']

/** side: hanging from one hand by the body's side; held: held up at chest or face height, cover to the camera;
 *  tucked: flat under the arm; belt: clipped to the belt (the pager). */
export type PropView = 'side' | 'held' | 'tucked' | 'belt'

export interface PropArt {
  readonly w: number
  readonly h: number
  /** The grip point inside the prop's own box: it lands on the hand anchor. */
  readonly gripX: number
  readonly gripY: number
  /** colour: the binding of a book or ledger (the slot it was pulled from: stateLayer.ts BOOK_SLOTS / LEDGER_SLOTS);
   *  its shaded side comes from palette.ts BINDING_SHADE, so the volume in hand matches the gap it left. */
  readonly draw: (g: Ctx, colour: string) => void
}

const PAGER_BODY = shade.phone            // the same dark plastic as the desk phone
const PAGER_SCREEN = TERM_TEXT            // a green LCD

/** The shaded side of a binding (palette.ts BINDING_SHADE). Throws for a colour that binds no book or ledger. */
function bindingShade(c: string): string {
  const s = BINDING_SHADE.get(c)
  if (s === undefined) throw new Error(`no binding shade for ${c} (palette.ts BOOK_COLOURS / LEDGER_COLOURS)`)
  return s
}

/** A bound volume (ledger or book) in a given binding: its three views. The held view is the round-3 variant A
 *  (5×4, grip (2, 3): at readD's anchor it fills the folder's box, the left hand meeting the spine, the right hand the
 *  fore-edge). The ledger and the book differ only by binding colour. */
const VOLUME: Partial<Record<PropView, PropArt>> = {
  side: { w: 2, h: 5, gripX: 0, gripY: 2, draw: (g, c) => {
    px(g, 0, 0, 1, 5, c); px(g, 1, 0, 1, 5, bindingShade(c)); px(g, 0, 1, 2, 1, GOLD)
  } },
  held: { w: 5, h: 4, gripX: 2, gripY: 3, draw: (g, c) => {
    px(g, 0, 0, 5, 4, c)                 // the cover, held up to the camera
    px(g, 0, 0, 1, 4, bindingShade(c))   // the spine down the left column
    px(g, 0, 1, 1, 1, GOLD)              // the gilt band: one texel, on the spine
    px(g, 4, 0, 1, 4, PAPER)             // the fore-edge of the pages down the right column
  } },
  tucked: { w: 6, h: 2, gripX: 3, gripY: 1, draw: (g, c) => {
    px(g, 0, 0, 6, 2, c); px(g, 0, 1, 6, 1, bindingShade(c)); px(g, 4, 0, 1, 2, GOLD)
  } },
}

export const PROP_ART: Readonly<Record<PropId, Partial<Record<PropView, PropArt>>>> = {
  folder: {
    side: { w: 2, h: 5, gripX: 0, gripY: 2, draw: g => { px(g, 0, 0, 2, 5, MANILA); px(g, 1, 0, 1, 5, MANILA_DARK); px(g, 0, 0, 1, 1, TAB_ORANGE) } },
    held: { w: 5, h: 4, gripX: 2, gripY: 3, draw: g => {
      px(g, 0, 1, 5, 3, MANILA); px(g, 0, 0, 2, 1, MANILA); px(g, 0, 0, 1, 1, TAB_ORANGE); px(g, 4, 1, 1, 3, PAPER); px(g, 0, 3, 5, 1, MANILA_DARK)
    } },
    tucked: { w: 5, h: 2, gripX: 2, gripY: 1, draw: g => { px(g, 0, 0, 5, 2, MANILA); px(g, 0, 1, 5, 1, MANILA_DARK) } },
  },
  ledger: VOLUME,
  book: VOLUME,
  callSlip: {
    held: { w: 3, h: 2, gripX: 1, gripY: 1, draw: g => { px(g, 0, 0, 3, 2, PAPER); px(g, 0, 1, 2, 1, INK_GREY) } },
    side: { w: 2, h: 3, gripX: 0, gripY: 1, draw: g => { px(g, 0, 0, 2, 3, PAPER); px(g, 1, 1, 1, 1, INK_GREY) } },
  },
  printout: {
    held: { w: 5, h: 4, gripX: 2, gripY: 3, draw: g => {
      px(g, 0, 0, 5, 4, PAPER); px(g, 1, 1, 3, 1, INK_GREY); px(g, 1, 2, 2, 1, INK_GREY); px(g, 0, 3, 5, 1, shade.pageEdge)
    } },
    side: { w: 2, h: 5, gripX: 0, gripY: 2, draw: g => { px(g, 0, 0, 2, 5, PAPER); px(g, 1, 0, 1, 5, shade.pageEdge) } },
  },
  form: {
    held: { w: 4, h: 5, gripX: 2, gripY: 4, draw: g => {
      px(g, 0, 0, 4, 5, PAPER); px(g, 1, 0, 2, 1, STEEL); px(g, 0, 2, 1, 1, LAMP_GREEN_ON); px(g, 2, 2, 2, 1, INK_GREY)
      px(g, 0, 3, 1, 1, LAMP_GREEN_ON); px(g, 2, 3, 2, 1, INK_GREY)
    } },
    side: { w: 2, h: 5, gripX: 0, gripY: 2, draw: g => { px(g, 0, 0, 2, 5, PAPER); px(g, 0, 0, 2, 1, STEEL) } },
  },
  ticket: {
    held: { w: 3, h: 2, gripX: 1, gripY: 1, draw: g => { px(g, 0, 0, 3, 2, SLIP_YELLOW); px(g, 0, 0, 1, 2, shade.ticketStub) } },
  },
  pager: {
    belt: { w: 2, h: 2, gripX: 0, gripY: 0, draw: g => { px(g, 0, 0, 2, 2, PAGER_BODY); px(g, 1, 0, 1, 1, PAGER_SCREEN) } },
    held: { w: 2, h: 3, gripX: 0, gripY: 2, draw: g => { px(g, 0, 0, 2, 3, PAGER_BODY); px(g, 0, 0, 2, 1, PAGER_SCREEN) } },
  },
}

/** Default binding when no slot colour is known. */
export const PROP_DEFAULT_COLOUR: Readonly<Record<PropId, string>> = {
  folder: MANILA, ledger: LEDGER, book: BOOK_COLOURS.red, callSlip: PAPER, printout: PAPER, form: PAPER, ticket: SLIP_YELLOW, pager: PAGER_BODY,
}

/** prop -> view -> binding colour -> image. Nested maps, so a hit builds no key string: asking every frame
 *  allocates nothing (still, a sprite should keep the canvas from pickup to release). */
const cache = new Map<PropId, Map<PropView, Map<string, HTMLCanvasElement>>>()
let renders = 0
/** How many prop images have been rendered (each prop, view and binding at most once). */
export const propRenders = () => renders

/** The cached image of a prop in a view (and binding colour, for the ledger and the book). Throws if the prop has no
 *  such view. */
export function propImage(id: PropId, view: PropView, colour = PROP_DEFAULT_COLOUR[id]): HTMLCanvasElement {
  let byView = cache.get(id)
  if (!byView) cache.set(id, (byView = new Map()))
  let byColour = byView.get(view)
  if (!byColour) byView.set(view, (byColour = new Map()))
  const hit = byColour.get(colour)
  if (hit) return hit
  const a = PROP_ART[id][view]
  if (!a) throw new Error(`prop ${id} has no ${view} view`)
  const [c, g] = makeCanvas(a.w, a.h)
  a.draw(g, colour)
  renders++
  byColour.set(colour, c)
  return c
}

// ── the hand-position table (frames.json round 3, see the header) ──────────────────────────────────────────────────
/** The figure frames (figures.ts FRAMES): the 12 of assets.ts CharFrame, plan §2's new frames ("sitBack-lean" and
 *  "sitBack-notepad" written sitBackLean, sitBackNotepad) and the handset frame phoneU (F8). */
export const POSES = [
  'stand', 'walkD0', 'walkD1', 'walkU0', 'walkU1', 'walkL0', 'walkL1', 'walkR0', 'walkR1', 'sit', 'type0', 'type1',
  'standU', 'useU0', 'useU1', 'reachU', 'readU', 'watchU', 'sitBack',
  'readD', 'ponderD', 'armsD',
  'standL', 'standR',
  'passD', 'passU', 'passL', 'passR',
  'sitBackLean', 'sitBackNotepad',
  'phoneU',
] as const
export type PoseName = (typeof POSES)[number]

/** A figure-cell texel [x, y]. */
export type Texel = readonly [number, number]

export interface HandAnchor {
  /** Figure-cell texel the prop's grip point goes to. */
  readonly x: number
  readonly y: number
  readonly view: PropView
  readonly layer: 'front' | 'behind'
  /** readD: a view at most maxW wide goes to (x, y) here instead, held by the `carry` texels (round 3). */
  readonly narrow?: { readonly x: number; readonly y: number; readonly maxW: number; readonly carry: readonly Texel[] }
  /** armsD: the item is pinned under the arm (drawn behind the figure), not held in a hand. */
  readonly heldBy?: 'arm'
}
export interface PoseHands {
  /** The worker is seated: no contact shadow is drawn under it (plan §6.2: it would smudge the north-facing
   *  backrest, critic 1 §1), and no pager shows at the belt. */
  readonly seated: boolean
  /** Where a carried prop shows in this pose; null: no carried prop is visible (both hands busy or hidden). */
  readonly hand: HandAnchor | null
  /** Where a clipped pager shows (plan §4.4: a background launch clips a pager to the belt); null: hidden. */
  readonly belt: { readonly x: number; readonly y: number } | null
  /** The hand texels that hold an item placed at `hand` (frames.json carryTexels). */
  readonly carry: readonly Texel[]
}

export const HAND: Readonly<Record<PoseName, PoseHands>> = {
  stand: { seated: false, hand: { x: 13, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 10], [12, 11]] },
  walkD0: { seated: false, hand: { x: 13, y: 12, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 11], [12, 12]] },
  walkD1: { seated: false, hand: { x: 13, y: 10, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 9], [12, 10]] },
  walkU0: { seated: false, hand: { x: 13, y: 10, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 9], [12, 10]] },
  walkU1: { seated: false, hand: { x: 13, y: 12, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 11], [12, 12]] },
  walkL0: { seated: false, hand: { x: 12, y: 9, view: 'side', layer: 'front' }, belt: { x: 6, y: 9 }, carry: [[11, 8]] },
  walkL1: { seated: false, hand: { x: 3, y: 9, view: 'side', layer: 'front' }, belt: { x: 6, y: 9 }, carry: [[5, 8], [6, 8]] },
  walkR0: { seated: false, hand: { x: 3, y: 9, view: 'side', layer: 'front' }, belt: { x: 9, y: 9 }, carry: [[5, 8]] },
  walkR1: { seated: false, hand: { x: 12, y: 9, view: 'side', layer: 'front' }, belt: { x: 9, y: 9 }, carry: [[10, 8], [11, 8]] },
  sit: { seated: true, hand: null, belt: null, carry: [] },
  type0: { seated: true, hand: null, belt: null, carry: [] },
  type1: { seated: true, hand: null, belt: null, carry: [] },
  standU: { seated: false, hand: { x: 13, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 10], [12, 11]] },
  useU0: { seated: false, hand: null, belt: { x: 9, y: 10 }, carry: [] },
  useU1: { seated: false, hand: null, belt: { x: 9, y: 10 }, carry: [] },
  reachU: { seated: false, hand: { x: 12, y: 0, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[11, 0], [12, 0]] },
  readU: { seated: false, hand: null, belt: { x: 9, y: 10 }, carry: [] },
  watchU: { seated: false, hand: { x: 2, y: 11, view: 'side', layer: 'front' }, belt: { x: 7, y: 10 }, carry: [[4, 10], [4, 11]] },
  sitBack: { seated: true, hand: { x: 13, y: 12, view: 'held', layer: 'front' }, belt: null, carry: [[12, 12], [12, 13]] },
  readD: { seated: false, hand: { x: 8, y: 9, view: 'held', layer: 'front', narrow: { x: 9, y: 9, maxW: 4, carry: [[11, 8], [11, 9]] } }, belt: { x: 9, y: 10 }, carry: [[5, 8], [5, 9], [11, 8], [11, 9]] },
  ponderD: { seated: false, hand: { x: 13, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 10], [12, 11]] },
  armsD: { seated: false, hand: { x: 13, y: 8, view: 'side', layer: 'behind', heldBy: 'arm' }, belt: { x: 9, y: 10 }, carry: [] },
  standL: { seated: false, hand: { x: 10, y: 11, view: 'side', layer: 'front' }, belt: { x: 6, y: 9 }, carry: [[9, 10]] },
  standR: { seated: false, hand: { x: 5, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 9 }, carry: [[7, 10]] },
  passD: { seated: false, hand: { x: 13, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 10], [12, 11]] },
  passU: { seated: false, hand: { x: 13, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 10], [12, 11]] },
  passL: { seated: false, hand: { x: 10, y: 11, view: 'side', layer: 'front' }, belt: { x: 6, y: 9 }, carry: [[9, 10]] },
  passR: { seated: false, hand: { x: 5, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 9 }, carry: [[7, 10]] },
  sitBackLean: { seated: true, hand: null, belt: null, carry: [] },
  sitBackNotepad: { seated: true, hand: null, belt: null, carry: [] },
  phoneU: { seated: false, hand: { x: 13, y: 11, view: 'side', layer: 'front' }, belt: { x: 9, y: 10 }, carry: [[12, 10], [12, 11]] },
}

/** Where a prop view of width `w` puts its grip point in this hand: the narrow anchor for a narrow view (readD), else
 *  the hand anchor (frames.json "hand": const a = h.narrow && art.w <= h.narrow.maxW ? h.narrow : h). */
export function propAnchor(h: HandAnchor, w: number): { readonly x: number; readonly y: number } {
  return h.narrow !== undefined && w <= h.narrow.maxW ? h.narrow : h
}

/** Plan §6.2: no contact shadow under a seated worker. */
export const drawsContactShadow = (pose: PoseName): boolean => !HAND[pose].seated
