// One worker on the canvas (plan §4.4, §4.8, §6.4 "Beats, poses, props, bubbles"): which approved frame it shows, where,
// how faded, with which prop at which hand, the pager at the belt, its status dot, and its bubble.
//
// spriteView() is pure (no DOM): the traffic check reads the same view the engine draws (lead ruling 4: the seat beat
// never moves the body). drawWorker() / drawBubbles() paint it.
//
// FRAMES. Walking: the facing's 4-phase cycle (stride, pass, stride, pass) advanced by DISTANCE, 4 phases per tile walked,
// from the worker's own phase offset (plan §4.8: no foot glide in profile, no churn while waiting); waiting a step:
// the facing's standing frame. At a place: the core's steady pose; during the per-call unit's minimum the pose of that
// call; a same-kind call's 0.4 s "next item" gesture; a pose ending in 0 with a 1 sibling (type0/type1, useU0/useU1)
// loops at the worker's own rate (3.4-4.6 fps) from its own phase. Entry: at a seat the sit frame (the planner walked
// the step onto it: the body stays on the seat tile); at a stand point the side frame for 0.15 s when the last move
// came from the side, then the place's pose. Exit: the sit frame (standing up) or the back view.
// POSITION. The frame's top-left is the body's position snapped to whole texels, 6 texels above its tile (figures.ts),
// so every texel lands on the engine's integer scale as an exact block. Props are not clipped to the frame.
// FADES. In over 0.8 s from the moment the body appears; out over 0.8 s on the exit lane (the planner's fade) or in place
// (an office-cleared fade).
import type { WorkerState } from '../live/world.ts'
import { BEAT } from '../live/world.ts'
import { FIGURE, FIGURE_LIFT, DOTS, SHADOW_X0, SHADOW_Y0, shadowImage, type FigureSet } from './figures.ts'
import { HAND, PROP_ART, PROP_DEFAULT_COLOUR, propAnchor, propImage, drawsContactShadow, type PoseName, type PropId, type PropView } from './props.ts'
import { TILE } from './floors.ts'
import { STATUS_WORKING, STATUS_IDLE, STATUS_OFFLINE, BUBBLE_BG } from './palette.ts'
import { ACTIVITY_ICON, LIFECYCLE_ICON, ICON_SIZE, iconImage, type IconId } from './icons.ts'
import { labelText, type LabelId } from '../core/labels.ts'
import type { Facing } from '../move/planner.ts'

type Ctx = CanvasRenderingContext2D

const WALK: Readonly<Record<Facing, readonly PoseName[]>> = {
  N: ['walkU0', 'passU', 'walkU1', 'passU'], S: ['walkD0', 'passD', 'walkD1', 'passD'],
  E: ['walkR0', 'passR', 'walkR1', 'passR'], W: ['walkL0', 'passL', 'walkL1', 'passL'],
}
const IDLE: Readonly<Record<Facing, PoseName>> = { N: 'standU', S: 'stand', E: 'standR', W: 'standL' }
/** A loop's second frame (the pose ending in 0 has a sibling ending in 1). */
const LOOP: Readonly<Partial<Record<PoseName, PoseName>>> = { type0: 'type1', useU0: 'useU1' }
/** The 0.4 s "next item" gesture of a same-kind call (plan §4.2 STAY). */
const GESTURE: Readonly<Partial<Record<PoseName, PoseName>>> = {
  standU: 'useU1', useU0: 'useU1', readU: 'useU1', watchU: 'useU1', reachU: 'useU1', type0: 'type1', sit: 'type0', sitBack: 'type0',
}
/** Nominal loop rate (plan §4.8: × the worker's rate 0.85-1.15 = 3.4-4.6 fps). */
const LOOP_FPS = 4
/** The status dot's glow (frames.json "dot": the glow at r + 1). */
const DOT_GLOW_ALPHA = 0.3

export type DotState = 'working' | 'idle' | 'offline'
const DOT_COLOUR: Readonly<Record<DotState, string>> = { working: STATUS_WORKING, idle: STATUS_IDLE, offline: STATUS_OFFLINE }
const QUIET_LABELS: ReadonlySet<LabelId> = new Set<LabelId>(['quiet', 'suspect', 'stuck'])
/** Items that are taken at the place the worker walks to, so its hand is empty on the way: a fetch-then-read pull
 *  (reachU with a volume, the card catalog's useU0 with a call slip), and a file cabinet's folder, which is lifted from
 *  the drawer and never leaves the cabinet (plan §4.4). What a worker does carry on a walk: a pulled volume or slip to
 *  its reading place, the printout and the result form to the front desk. */
const takenThere = (pose: PoseName, prop: PropId | null) =>
  prop === 'folder' || (pose === 'reachU' && (prop === 'ledger' || prop === 'book')) || (pose === 'useU0' && prop === 'callSlip')

/** The prop a worker's hands show at `now` (null: none): the call's own during the per-call unit's minimum, the one it
 *  held when its exit beat began, nothing on the way to a place where the item is taken, else the core's prop. The
 *  object states (live/objects.ts) read the same answer, so a shelf's gap and the volume in the hand never disagree. */
export function heldProp(w: WorkerState, now: number): PropId | null {
  if (w.phase === 'settled' && now < w.unitUntil && w.unitPose !== null) return w.unitProp
  if (w.phase === 'exit' && w.exitPose !== null) return w.exitProp
  if ((w.phase === 'walking' || w.phase === 'appearing') && takenThere(w.pose, w.prop)) return null
  return w.prop
}

/** What one worker shows this frame (world texels; filled in place, no allocation per frame). */
export interface SpriteView {
  visible: boolean
  pose: PoseName
  /** The frame's top-left, whole world texels. */
  x: number
  y: number
  /** The body's tile position (fractional while walking): the painter's order. */
  depth: number
  alpha: number
  shadow: boolean
  prop: PropId | null
  propView: PropView | null
  /** The binding of a carried ledger or book: the colour of the shelf slot it was pulled from (live/objects.ts), so
   *  the volume in the hand matches the gap it left; null: the prop's default colour. Set by the engine. */
  propColour: string | null
  propX: number
  propY: number
  propBehind: boolean
  belt: boolean
  beltX: number
  beltY: number
  dot: DotState
  dotX: number
  dotY: number
  dotR: number
  /** How far its bubble is raised (texels): a worker using an object stands south of it, and the object's state art
   *  (rows 0-9 of the object tile, plan §2) lies exactly where a bubble over its head would go, so the engine raises
   *  that worker's bubble one tile, over the wall or floor beyond the object. 0: over the head. */
  bubbleLift: number
}

export const newView = (): SpriteView => ({
  visible: false, pose: 'stand', x: 0, y: 0, depth: 0, alpha: 1, shadow: false, prop: null, propView: null, propColour: null, propX: 0, propY: 0,
  propBehind: false, belt: false, beltX: 0, beltY: 0, dot: 'idle', dotX: 0, dotY: 0, dotR: 1.5, bubbleLift: 0,
})

/** The frame a worker shows at `now`. */
export function poseOf(w: WorkerState, now: number): PoseName {
  const f = w.pos.facing
  switch (w.phase) {
    case 'appearing': case 'walking': case 'leaving':
      return w.pos.moving ? WALK[f][Math.floor((w.pos.walked + w.walkOff) * 4) % 4] : IDLE[f]
    case 'entry':
      if (w.seat) return 'sit'
      if (now - w.arrivedAt < BEAT.sideFace && (w.arriveFacing === 'E' || w.arriveFacing === 'W')) return IDLE[w.arriveFacing]
      return w.pose
    case 'exit':
      return w.seat ? 'sit' : w.exitPose ?? w.pose
    case 'settled': {
      if (w.goal?.kind === 'slot') return IDLE[f]
      let p = now < w.unitUntil && w.unitPose !== null ? w.unitPose : w.pose
      if (now < w.gestureUntil) return GESTURE[p] ?? p
      const sib = LOOP[p]
      if (sib !== undefined && Math.floor((now / 1000) * LOOP_FPS * w.rate + w.loopOff * 2) % 2 === 1) p = sib
      return p
    }
    default:
      return w.pose
  }
}

/** Fill `v` with what the worker shows at `now` (invisible when its body is not on the grid). */
export function spriteView(w: WorkerState, now: number, v: SpriteView): SpriteView {
  v.visible = w.onGrid
  if (!w.onGrid) return v
  const pose = poseOf(w, now)
  const x = Math.round(w.pos.x * TILE), y = Math.round(w.pos.y * TILE) - FIGURE_LIFT
  v.pose = pose
  v.x = x
  v.y = y
  v.depth = w.pos.y
  let a = w.appearedAt === null ? 1 : Math.min(1, (now - w.appearedAt) / BEAT.fade)
  if (w.fadeAt !== null) a = Math.min(a, Math.max(0, 1 - (now - w.fadeAt) / BEAT.fade))
  v.alpha = a
  v.shadow = drawsContactShadow(pose)
  const prop = heldProp(w, now)
  const hands = HAND[pose]
  v.prop = null
  v.propView = null
  v.propColour = null
  if (prop !== null && hands.hand !== null) {
    const art = PROP_ART[prop][hands.hand.view]
    if (art !== undefined) {
      const anc = propAnchor(hands.hand, art.w)
      v.prop = prop
      v.propView = hands.hand.view
      v.propX = x + anc.x - art.gripX
      v.propY = y + anc.y - art.gripY
      v.propBehind = hands.hand.layer === 'behind'
    }
  }
  v.belt = w.belt && hands.belt !== null && prop !== 'pager'
  if (v.belt && hands.belt !== null) {
    const b = PROP_ART.pager.belt!
    v.beltX = x + hands.belt.x - b.gripX
    v.beltY = y + hands.belt.y - b.gripY
  }
  v.dot = QUIET_LABELS.has(w.label) ? 'offline' : w.inCall || w.label === 'running' ? 'working' : 'idle'
  const d = DOTS[pose]
  v.dotX = x + d.x
  v.dotY = y + d.y
  v.dotR = d.r
  return v
}

/** Paint one worker (world texels; the caller has set the world transform: integer scale, whole-pixel offset). */
export function drawWorker(g: Ctx, v: SpriteView, set: FigureSet) {
  if (!v.visible || v.alpha <= 0) return
  g.globalAlpha = v.alpha
  if (v.shadow) g.drawImage(shadowImage(), v.x + SHADOW_X0, v.y + SHADOW_Y0)
  if (v.prop !== null && v.propView !== null && v.propBehind) g.drawImage(propImage(v.prop, v.propView, v.propColour ?? PROP_DEFAULT_COLOUR[v.prop]), v.propX, v.propY)
  g.drawImage(set.image(v.pose), v.x, v.y)
  if (v.prop !== null && v.propView !== null && !v.propBehind) g.drawImage(propImage(v.prop, v.propView, v.propColour ?? PROP_DEFAULT_COLOUR[v.prop]), v.propX, v.propY)
  if (v.belt) g.drawImage(propImage('pager', 'belt'), v.beltX, v.beltY)
  // the status dot: a soft glow at r + 1 and the core at r, beside the head (never over it: art check G)
  g.fillStyle = DOT_COLOUR[v.dot]
  g.globalAlpha = v.alpha * DOT_GLOW_ALPHA
  g.beginPath(); g.arc(v.dotX, v.dotY, v.dotR + 1, 0, Math.PI * 2); g.fill()
  g.globalAlpha = v.alpha
  g.beginPath(); g.arc(v.dotX, v.dotY, v.dotR, 0, Math.PI * 2); g.fill()
  g.globalAlpha = 1
}

// ── bubbles (plan §4.8, §4.10: fixed labels only; at most 4 text bubbles office-wide, icons for the rest) ──────────
/** At most this many workers show their label as text at once; the others show an icon. */
export const MAX_TEXT_BUBBLES = 4
/** Labels that never show as text: the between-calls label is most of a worker's time (plan §4.5), so its bubble is
 *  the thinking icon; the room key lists the full phrase. */
export const ICON_ONLY: ReadonlySet<LabelId> = new Set<LabelId>(['between'])
/** A label shows as text for this long after it changes (plan §4.8 "≥ 2 s; for the call + 2.5 s"). */
export const TEXT_BUBBLE_MS = 3000

/** The icon a worker's bubble shows, or null (no bubble). */
export function iconOf(w: WorkerState): IconId | null {
  if (w.label === 'quiet' || w.label === 'suspect') return LIFECYCLE_ICON.quiet
  if (w.callEnd !== null && w.callEnd.result === 'fail' && !w.inCall) return LIFECYCLE_ICON.failed
  if (w.inCall) return ACTIVITY_ICON[w.activity] ?? null
  if (w.label === 'between') return LIFECYCLE_ICON.thinking
  if (w.label === 'waitShell' || w.label === 'waitMonitor' || w.label === 'waitHelper') return LIFECYCLE_ICON.waitingForJob
  return null
}

/** The text of a worker's label (a fixed phrase; {n} and {st} from closed sets). */
export const bubbleText = (w: WorkerState): string => labelText(w.label, { n: w.labelN, st: w.labelSt })

/** Where a worker's icon bubble goes (world texels): a 9×9 box centred above the frame, raised by bubbleLift. */
export function iconBubbleBox(v: SpriteView): { readonly x: number; readonly y: number; readonly size: number } {
  return { x: v.x + Math.floor((FIGURE - ICON_SIZE - 2) / 2), y: v.y - v.bubbleLift - ICON_SIZE - 3, size: ICON_SIZE + 2 }
}

/** Icon bubbles over the heads (world texels: a 9×9 dark box with the 7×7 icon, centred above the frame). */
export function drawIconBubble(g: Ctx, v: SpriteView, icon: IconId) {
  const { x: bx, y: by } = iconBubbleBox(v)
  g.globalAlpha = v.alpha
  g.fillStyle = BUBBLE_BG
  g.fillRect(bx, by, ICON_SIZE + 2, ICON_SIZE + 2)
  g.drawImage(iconImage(icon), bx + 1, by + 1)
  g.globalAlpha = 1
}
