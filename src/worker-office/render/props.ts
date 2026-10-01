// Hand-held props of the vertical slice (plan §2 "Props", §4.4) and the hand-position table.
//
// PROPS ONLY: nothing here draws a body. The worker figure's look is an open question for the owner, so the hand
// table is PROVISIONAL. Its anchors are measured on the current figure geometry (assets.ts characterSheet: a 12-wide
// body drawn 2 px into the 16×16 cell, arms at cell columns 4 and 11, hands at row 10, seated frames 2 rows lower,
// the cell drawn 6 rows above its tile, OfficeEngine.ts:446) and must be re-derived once the figure is settled.
// An anchor says where a held prop's grip point goes in the figure cell, which view of the prop that pose shows,
// and whether the prop is drawn in front of the body or behind it (behind: only what sticks out around the body
// shows, e.g. the corners of a ledger read at face height with the back to the camera).
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

/** A bound volume (ledger or book) in a given binding: its three views. */
function volume(defaultBand: boolean): Partial<Record<PropView, PropArt>> {
  return {
    side: { w: 2, h: 5, gripX: 0, gripY: 2, draw: (g, c) => {
      px(g, 0, 0, 1, 5, c); px(g, 1, 0, 1, 5, bindingShade(c)); px(g, 0, 1, 2, 1, GOLD)
    } },
    held: { w: 5, h: 5, gripX: 2, gripY: 4, draw: (g, c) => {
      px(g, 0, 0, 5, 5, c); px(g, 0, 0, 1, 5, bindingShade(c))
      px(g, 1, 1, 4, 1, GOLD)
      if (defaultBand) px(g, 1, 3, 4, 1, GOLD); else px(g, 2, 2, 2, 1, PAPER)
    } },
    tucked: { w: 6, h: 2, gripX: 3, gripY: 1, draw: (g, c) => {
      px(g, 0, 0, 6, 2, c); px(g, 0, 1, 6, 1, bindingShade(c)); px(g, 4, 0, 1, 2, GOLD)
    } },
  }
}

export const PROP_ART: Readonly<Record<PropId, Partial<Record<PropView, PropArt>>>> = {
  folder: {
    side: { w: 2, h: 5, gripX: 0, gripY: 2, draw: g => { px(g, 0, 0, 2, 5, MANILA); px(g, 1, 0, 1, 5, MANILA_DARK); px(g, 0, 0, 1, 1, TAB_ORANGE) } },
    held: { w: 5, h: 4, gripX: 2, gripY: 3, draw: g => {
      px(g, 0, 1, 5, 3, MANILA); px(g, 0, 0, 2, 1, MANILA); px(g, 0, 0, 1, 1, TAB_ORANGE); px(g, 4, 1, 1, 3, PAPER); px(g, 0, 3, 5, 1, MANILA_DARK)
    } },
    tucked: { w: 5, h: 2, gripX: 2, gripY: 1, draw: g => { px(g, 0, 0, 5, 2, MANILA); px(g, 0, 1, 5, 1, MANILA_DARK) } },
  },
  ledger: volume(true),
  book: volume(false),
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

// ── the hand-position table (PROVISIONAL, see the header) ─────────────────────────────────────────────────────────
/** The figure frames: assets.ts CharFrame (today's 12) and plan §2's new frames ("sitBack-lean" and
 *  "sitBack-notepad" written sitBackLean, sitBackNotepad). */
export const POSES = [
  'stand', 'walkD0', 'walkD1', 'walkU0', 'walkU1', 'walkL0', 'walkL1', 'walkR0', 'walkR1', 'sit', 'type0', 'type1',
  'standU', 'useU0', 'useU1', 'reachU', 'readU', 'watchU', 'sitBack',
  'readD', 'ponderD', 'armsD',
  'standL', 'standR',
  'passD', 'passU', 'passL', 'passR',
  'sitBackLean', 'sitBackNotepad',
] as const
export type PoseName = (typeof POSES)[number]

export interface HandAnchor {
  /** Figure-cell texel the prop's grip point goes to. */
  readonly x: number
  readonly y: number
  readonly view: PropView
  readonly layer: 'front' | 'behind'
}
export interface PoseHands {
  /** The worker is seated: no contact shadow is drawn under it (plan §6.2: it would smudge the north-facing
   *  backrest, critic 1 §1). */
  readonly seated: boolean
  /** Where a carried prop shows in this pose; null: no carried prop is visible (both hands busy or hidden). */
  readonly hand: HandAnchor | null
  /** Where a clipped pager shows (plan §4.4: a background launch clips a pager to the belt); null: hidden. */
  readonly belt: { readonly x: number; readonly y: number } | null
}

const side = (x: number, y: number): HandAnchor => ({ x, y, view: 'side', layer: 'front' })
const stand = (hand: HandAnchor | null, beltX = 9): PoseHands => ({ seated: false, hand, belt: { x: beltX, y: 10 } })
const seated = (hand: HandAnchor | null): PoseHands => ({ seated: true, hand, belt: null })

export const HAND: Readonly<Record<PoseName, PoseHands>> = {
  stand: stand(side(12, 10)),
  walkD0: stand(side(12, 9)),
  walkD1: stand(side(12, 10)),
  walkU0: stand(side(12, 9)),
  walkU1: stand(side(12, 10)),
  walkL0: stand(side(7, 9), 6),
  walkL1: stand(side(7, 10), 6),
  walkR0: stand(side(8, 9), 9),
  walkR1: stand(side(8, 10), 9),
  sit: seated(null),                                                   // hands on the desk
  type0: seated(null),
  type1: seated(null),
  standU: stand(side(12, 10)),
  useU0: stand(null),                                                  // both hands on the object
  useU1: stand(null),
  reachU: stand({ x: 11, y: 3, view: 'side', layer: 'front' }),       // the pulled ledger or book, in the raised hand
  readU: stand({ x: 8, y: 5, view: 'held', layer: 'behind' }),        // read at face height, back to the camera
  watchU: stand(side(12, 10)),
  sitBack: seated({ x: 12, y: 12, view: 'held', layer: 'front' }),   // e.g. the pager, held at the side
  readD: stand({ x: 8, y: 9, view: 'held', layer: 'front' }),         // reading a carried item, facing the camera
  ponderD: stand(side(12, 10)),                                        // one hand to the chin, the item in the other
  armsD: stand({ x: 7, y: 8, view: 'tucked', layer: 'front' }),       // arms folded, the item under the arm
  standL: stand(side(7, 10), 6),
  standR: stand(side(8, 10), 9),
  passD: stand(side(12, 10)),
  passU: stand(side(12, 10)),
  passL: stand(side(7, 10), 6),
  passR: stand(side(8, 10), 9),
  sitBackLean: seated({ x: 12, y: 12, view: 'held', layer: 'front' }),
  sitBackNotepad: seated(null),                                        // the notepad is the meeting table's state (pass 2)
}

/** Plan §6.2: no contact shadow under a seated worker. */
export const drawsContactShadow = (pose: PoseName): boolean => !HAND[pose].seated
