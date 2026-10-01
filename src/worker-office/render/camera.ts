// Camera rules of the worker office canvas (plan §6.1), kept pure so the checks can sweep them without a browser.
//
// FIT. The building gets the LARGEST WHOLE number of device pixels per texel at which all of it fits the canvas,
// never less than 1. Nothing is multiplied in before rounding down: the old engine's 0.96 margin
// (OfficeEngine.ts:215) turned 1440×900's 2.0012 into a cliff, where one CSS pixel less canvas — a sidebar 1 px
// wider than its default — halved the building. Rounding down already leaves a margin.
// At 1440×900 (36 px tab bar, 6 px gutter) the 2× building (1088×736 CSS px) fits for every sidebar up to 346 px
// and every viewport height from 772 px; beyond that only 1× fits. That boundary is geometry, not a margin: the
// render check pins it.
// The DOM overlay over the top of the canvas (the WORKERS chip and the "No live feed" banner) costs placement,
// never scale: the building is centred in the area below the overlay when that area has room, and otherwise sits as
// low as the canvas allows (bottom-aligned), so the overlay covers as little of it as possible.
//
// WHEEL. Whole zoom steps from wheel input of any device: see WheelZoom.

export interface Fit {
  /** device pixels per texel (a whole number >= 1) */
  readonly scale: number
  /** whole device pixels */
  readonly offX: number
  readonly offY: number
}

/** All arguments in device pixels; insetTop is the height of the overlay band over the top of the canvas. */
export function fitCamera(bw: number, bh: number, worldW: number, worldH: number, insetTop: number): Fit {
  const scale = Math.max(1, Math.floor(Math.min(bw / worldW, bh / worldH)))
  const slackX = bw - worldW * scale
  const slackY = bh - worldH * scale
  const band = Math.max(0, Math.ceil(insetTop))
  const offX = Math.round(slackX / 2)
  const offY = slackY >= band ? band + Math.round((slackY - band) / 2)   // centred below the overlay
    : slackY >= 0 ? slackY                                                // as low as it fits: least overlap
      : Math.round(slackY / 2)                                            // bigger than the canvas even at 1×
  return { scale, offX, offY }
}

/** Wheel travel per zoom step, CSS px. A mouse notch is 100 px in Chrome at 100 % page zoom (50 px at 200 %),
 *  so one notch is one step; a touchpad's small deltas add up to one step per 50 px of travel. */
export const WHEEL_STEP_PX = 50
/** A pause longer than this between wheel events starts a new gesture: leftover travel is dropped. */
export const WHEEL_IDLE_MS = 250
/** At most one step per this many ms, so one touchpad fling cannot run the zoom from the fit to the maximum. */
export const WHEEL_MIN_STEP_MS = 90

/** Turns wheel events into whole zoom steps:
 *  - deltaY 0 (a horizontal touchpad swipe, shift+wheel) is never a zoom;
 *  - pixel deltas (deltaMode 0) accumulate, and a step needs WHEEL_STEP_PX of travel in one direction; line or page
 *    deltas (deltaMode 1, 2: wheels that click) are one step each;
 *  - one event makes at most one step, and steps are at least WHEEL_MIN_STEP_MS apart (events in between are
 *    dropped, not saved up);
 *  - ctrl+wheel (a touchpad pinch in Chromium) is handled the same way. */
export class WheelZoom {
  private acc = 0
  private lastEvent = -Infinity
  private lastStep = -Infinity

  /** +1 zoom in, -1 zoom out, 0 no step. timeStamp: the event's timeStamp (ms). */
  step(deltaY: number, deltaMode: number, timeStamp: number): -1 | 0 | 1 {
    if (deltaY === 0 || !Number.isFinite(deltaY)) return 0
    const idle = timeStamp - this.lastEvent > WHEEL_IDLE_MS
    this.lastEvent = timeStamp
    if (timeStamp - this.lastStep < WHEEL_MIN_STEP_MS) { this.acc = 0; return 0 }
    const travel = deltaMode === 0 ? deltaY : Math.sign(deltaY) * WHEEL_STEP_PX
    if (idle || Math.sign(travel) !== Math.sign(this.acc)) this.acc = 0
    this.acc += travel
    if (Math.abs(this.acc) < WHEEL_STEP_PX) return 0
    const dir = this.acc < 0 ? 1 : -1
    this.acc = 0
    this.lastStep = timeStamp
    return dir
  }
}
