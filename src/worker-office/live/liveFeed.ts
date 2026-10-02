// The LIVE feed's clock (plan §4.6, §4.7, §5.1 option B): spool lines read from the owner's log folder go to the world on
// one sim clock that follows the wall clock, and the world snaps when that clock cannot follow.
// Pure TypeScript: the wall clock is passed in (the engine passes Date.now; the checks pass their own).
//
//   const feed = new LiveFeed(world, () => Date.now())
//   feed.push(lines)        lines the reader read (queued until the next frame)
//   feed.caughtUp()         the reader has read the log to its end once: the backlog is complete
//   feed.requestSnap(why)   the tab is shown again ('return'), or the feed (re)connected ('connect')
//   feed.frame()            one animation frame: run, or snap
//
// THE CLOCK. Live records carry the hook's wall-clock time, and the observer core holds them on the wall clock, so the
// live sim clock IS the wall clock, advanced at most MAX_FRAME_MS per frame (plan §4.7: "the frame step is capped at
// 0.05 s"), so a walk never jumps. It never runs backward (a wall clock that steps back waits until it is caught up).
// THE SNAP (live/world.ts snap): the clock jumps to the wall, the queued lines are applied as the backlog, every body is
// re-placed. It happens
//   - on the first frame after the reader caught up (a connect or a reconnect: the backlog is the log so far);
//   - on the first frame after the tab is shown again (§4.7 "Hidden tab -> snap on return");
//   - when the capped clock trails the wall by more than SNAP_LAG_MS (jank: frames too slow for the 50 ms cap, or a
//     freeze the page never saw as hidden). SNAP_LAG_MS is the world's "behind" bound (BEAT.behind, 3 s): a worker that
//     far behind its target already plays fast beats, so beyond it the office stops pretending to catch up.
// Until the reader has caught up nothing runs (the office would replay the backlog's walks otherwise).
import { BEAT, type WorkerWorld } from './world.ts'

/** The most the live sim clock advances in one frame (plan §4.7). */
export const MAX_FRAME_MS = 50
/** Beyond this lag behind the wall clock, the world snaps (see THE SNAP above). */
export const SNAP_LAG_MS = BEAT.behind

export type SnapWhy = 'connect' | 'return' | 'behind'
export interface SnapRecord { readonly at: number; readonly lines: number; readonly why: SnapWhy; readonly lag: number }

export class LiveFeed {
  readonly world: WorkerWorld
  readonly wall: () => number
  /** Every snap so far (checks; the tab shows the last one). */
  readonly snaps: SnapRecord[] = []
  #sim: number
  #queue: string[] = []
  #ready = false
  #snapWhy: SnapWhy | null = 'connect'
  #lines = 0

  constructor(world: WorkerWorld, wall: () => number) {
    this.world = world
    this.wall = wall
    this.#sim = wall()
  }

  /** The sim clock (ms since the epoch). */
  get sim(): number { return this.#sim }
  /** The reader has caught up with the log at least once (the office runs). */
  get ready(): boolean { return this.#ready }
  /** Lines given to the world so far (checks). */
  get lines(): number { return this.#lines }
  /** Lines waiting for the next frame. */
  get queued(): number { return this.#queue.length }

  push(lines: readonly string[]) {
    for (const l of lines) this.#queue.push(l)
  }

  caughtUp() {
    this.#ready = true
  }

  requestSnap(why: SnapWhy) {
    if (this.#snapWhy !== 'connect') this.#snapWhy = why
  }

  /** One animation frame: the sim advance in ms (0 on a snap or while waiting for the backlog). */
  frame(): number {
    if (!this.#ready || this.world.disposed) return 0
    const wall = this.wall()
    const lag = wall - this.#sim
    if (this.#snapWhy !== null || lag > SNAP_LAG_MS) {
      const why: SnapWhy = this.#snapWhy ?? 'behind'
      this.#sim = Math.max(this.#sim, wall)
      const backlog = this.#queue
      this.#queue = []
      this.#lines += backlog.length
      this.world.snap(this.#sim, backlog)
      this.snaps.push({ at: this.#sim, lines: backlog.length, why, lag })
      this.#snapWhy = null
      return 0
    }
    const prev = this.#sim
    this.#sim = Math.max(this.#sim, Math.min(wall, this.#sim + MAX_FRAME_MS))
    const sim = this.#sim
    if (this.#queue.length > 0) {
      const q = this.#queue
      this.#queue = []
      this.#lines += q.length
      for (const l of q) this.world.ingest(l, sim)
    }
    this.world.step(sim)
    return sim - prev
  }
}
