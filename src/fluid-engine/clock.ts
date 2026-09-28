// PresentationClock — decides, for each requestAnimationFrame callback, whether to present a frame
// and how much SIM TIME that frame advances. Pure logic (no DOM, no GPU), unit-tested in
// scripts/fluid-gates/clock-unit.mjs against synthetic 60/75/90/120/144/165/240 Hz vsync streams.
//
// Design ("semi-fixed timestep", after Gaffer On Games, "Fix Your Timestep!"):
//  - Use the rAF callback TIMESTAMP (vsync-aligned), never performance.now() inside the callback
//    (100 µs-coarsened in non-isolated pages, plus scheduling jitter).
//  - Measure the display's vsync interval (median of recent callback deltas) and present every
//    k-th vsync with k = round(refresh / 60): 240 Hz → every 4th, 144 Hz → every 2nd (72 fps),
//    60 Hz → every one. A millisecond threshold would instead present every 3rd vsync at 144 Hz
//    (48 fps) — the defect the 2026-09-28 review found in the first version.
//  - Each presented frame advances the sim by exactly its own interval, SNAPPED to a whole number
//    of vsyncs. Every frame at a steady rate advances the identical amount → uniform motion, no
//    0-step/2-step judder (the first version's fixed 1/60 s accumulator judders whenever timestamp
//    error straddles the step boundary). The fluid solver splits the advance into substeps no
//    longer than its verified Δt, so physics stays correct at any interval.
//  - Hitches and overload: a single long frame advances at most 2 target intervals (catch-up);
//    under SUSTAINED overload (median presented interval > 1.5 × target) at most 1 — doubling the
//    GPU work of an already-late frame only makes the next one later. Time not simulated is
//    counted as dilation and shown to the player; the physics per unit of sim time never changes.

const VSYNC_WINDOW = 480         // callback deltas kept for the vsync estimate (~2 s at 240 Hz)
const PRESENT_WINDOW = 60        // presented intervals kept for the overload test
const MAX_SANE_VSYNC_MS = 100    // deltas above this are pauses, not refresh intervals
const NOMINAL_PRESENT_MS = 1000 / 60   // design presentation interval (60 Hz)

export interface ClockDecision {
  /** Render this callback? */
  present: boolean
  /** Sim seconds to advance on this callback (0 when not presenting). */
  advanceS: number
  /** Wall seconds not simulated on this callback (time dilation). */
  droppedS: number
}

export class PresentationClock {
  private deltas: number[] = []
  private presented: number[] = []
  private lastTs = -1
  private lastPresentTs = -1
  private k = 0                   // current present-every-k-vsyncs (0 = not yet decided)

  /** Vsync interval in ms (60 Hz until measured): the MEAN of the fastest cluster of callback
   *  deltas (≤ 1.25 × the 10th percentile). Mean, because timestamps are quantised (0.1 ms) and
   *  a median of quantised values is biased (4.167 ms reads as 4.2 → sim 0.8% fast); fastest
   *  cluster, because late callbacks under GPU overload are multiples of vsync, not vsyncs. */
  get vsyncMs(): number {
    if (this.deltas.length < 8) return NOMINAL_PRESENT_MS
    const s = [...this.deltas].sort((a, b) => a - b)
    const p10 = s[Math.floor(0.1 * (s.length - 1))]
    let sum = 0, n = 0
    for (const d of s) { if (d > 1.25 * p10) break; sum += d; n++ }
    return sum / n
  }

  /** Present every k-th vsync so the presentation rate is as close to 60 Hz as the panel allows.
   *  Hysteresis: k only changes when the ideal ratio is more than 0.6 away from it, so a panel
   *  sitting on a tie (90 Hz: 60/90 = 1.5) keeps one choice instead of flip-flopping each frame. */
  get presentEvery(): number {
    const ideal = NOMINAL_PRESENT_MS / this.vsyncMs
    if (this.k === 0 || Math.abs(ideal - this.k) > 0.6) this.k = Math.max(1, Math.round(ideal))
    return this.k
  }

  /** Nominal presented-frame interval in ms. */
  get targetMs(): number { return this.presentEvery * this.vsyncMs }

  /** Sustained overload: the median presented interval is well above the DESIGN interval
   *  (1/60 s). Measured against the fixed design value, not the vsync estimate, because when
   *  every callback is late the callback stream no longer reveals the display's refresh. */
  get overloaded(): boolean {
    if (this.presented.length < 20) return false
    const s = [...this.presented].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)] > 1.5 * NOMINAL_PRESENT_MS
  }

  /** Feed one rAF timestamp (ms); returns what this callback should do. */
  tick(ts: number): ClockDecision {
    if (this.lastTs >= 0) {
      const d = ts - this.lastTs
      if (d > 0 && d < MAX_SANE_VSYNC_MS) {
        this.deltas.push(d)
        if (this.deltas.length > VSYNC_WINDOW) this.deltas.shift()
      }
    }
    this.lastTs = ts
    if (this.lastPresentTs < 0) {           // first callback: present, but there is no interval yet
      this.lastPresentTs = ts
      return { present: true, advanceS: 0, droppedS: 0 }
    }
    const vs = this.vsyncMs
    const elapsed = ts - this.lastPresentTs
    if (elapsed < this.targetMs - vs / 2) return { present: false, advanceS: 0, droppedS: 0 }

    this.lastPresentTs = ts
    this.presented.push(elapsed)
    if (this.presented.length > PRESENT_WINDOW) this.presented.shift()
    const snapped = Math.max(1, Math.round(elapsed / vs)) * vs
    // Catch-up for a transient hitch: up to 2 frames' worth. Sustained overload: 1/60 s of sim
    // per presented frame, so GPU work per frame stays bounded and the rest is shown as dilation.
    const cap = this.overloaded ? NOMINAL_PRESENT_MS : 2 * this.targetMs
    const advance = Math.min(snapped, cap)
    // Dilation is only what the cap removed; sub-vsync rounding of `elapsed` is timestamp noise.
    return { present: true, advanceS: advance / 1000, droppedS: (snapped - advance) / 1000 }
  }
}
