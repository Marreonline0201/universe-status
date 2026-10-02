// Worker office movement core, Path A (plan §4.7; §6.4 "Movement core (Path A)"; owner decisions D2 = grid walking,
// D4 = 3.2 tiles/s): prioritized planning on the grid with space-time reservations (Silver 2005, "Cooperative
// Pathfinding"; Čáp, Vokřínek & Kleiner, ICAPS 2015, arXiv:1501.07704). The structure is critic 1's coop_sim.py
// Planner, the Python port whose 0 stuck trips the plan quotes, plus the plan's own rules listed below.
//
// Pure TypeScript: no DOM, no timers, no randomness. Time comes in as numbers (ms on the renderer's one sim clock).
//
//   const p = new PathPlanner(layout)
//   p.plan(w, slot, slot, now)     spawn: a new worker appears standing on its sidewalk slot (`from` = where it appears)
//   p.plan(w, null, tile, now)     walkTo: walk to a booked place's own tile (a seat's own tile too, entered from sitFrom)
//   p.plan(w, null, EXIT, now)     leave: out by the OUT leaf, west along the exit lane, fade, gone
//   p.tick(now)                    every frame: appearances, retries, the end of exit fades, compaction
//   p.positionAt(w, t, out?)       where to draw it, interpolated along grid edges; null = not on the grid
//   p.cancel(w) / p.dispose()      drop one worker / everything; nothing is booked and nothing moves after dispose()
//   p.isClear(tile, now)           nobody stands on the tile or will cross it from now on (the page's slot-left signal)
// The renderer draws a worker only where positionAt says: an arrival appears on exactly the slot its spawn command
// names, and is not drawn before it appears. Its fade-in is drawn on that tile; a pre-roll from tiles further east
// would not be covered by the bookings.
//
// THE MODEL (§4.7 "The page owns bodies: Path A"):
//   - Time is cut into steps of one tile at the one walking speed: STEP_MS = 312.5 ms (3.2 tiles/s, every worker).
//     A move takes one step, to a 4-neighbour (layout.moves: a seat is entered and left only through its own sitFrom
//     tile), or the worker waits a step. Moves start on step boundaries; positions are linear between them.
//   - Bookings are (tile, step) pairs. A walking worker books every step of its trajectory; a worker standing still
//     owns its tile from its arrival on, until it plans its next move (a "rest").
//   - Booking rules: nobody enters a tile booked by someone else at that step; two workers never swap tiles; a
//     trajectory ends only where its worker can then stand: its goal carries no other booking from the arrival step
//     on (an exit-lane tile: for the length of the fade).
//   - Endpoints (the 120 places of §3.3: 88 points, 28 wait / queue tiles, 4 hold tiles) are never walked THROUGH,
//     only started from or arrived at. This is the valid-infrastructure condition under which prioritized planning
//     provably finds a trajectory for every trip between endpoints (§3.3; 0 of 14,280 pairs fail).
//   - Priority: first come, first planned. Each plan goes around every booking that already exists.
//   - Keep-old-path (mandatory, §4.7): a re-plan that finds nothing restores the worker's old bookings; it keeps
//     walking its old path (or keeps standing) and the request is retried on later ticks, first come first.
//   - One speed and these rules keep any two workers at least √0.5 ≈ 0.707 tiles apart at every instant (the worst
//     case is a worker stepping into a tile that another leaves at a right angle); the traffic check asserts 0.69.
//
// WHAT THE PROOF DOES NOT COVER (§3.3) and how this file handles it:
//   - arrivals start on sidewalk slots, which are not endpoints. A new worker appears on the slot its spawn names only
//     once nobody else will stand on or pass that tile again; until then it waits off the grid (the observer keeps a
//     slot claimed until the page reports, through isClear, that its body has left it and no body will cross it:
//     lead ruling 3, decisions.md 2026-10-01 23:13, so the slot named is the real tile). Arrival trips leave the
//     sidewalk at least 0.4 s apart (§4.6 step 4, critic 1's release cadence); a slot worker boxed in by the slot
//     workers in front of it fails to plan and retries until they have gone ("front to back", §4.6 step 3);
//   - departures end on the exit lane (not endpoints): the goal is the westmost lane tile free for the whole fade;
//   - mid-walk retargets start from the tile the worker is on at the next step boundary, with keep-old-path.
//   For these the evidence is measured, not proven: scripts/worker-office-traffic-sim.ts.
//
// Soft costs (SOFT, in steps; never traded against a hard rule): an arrival through the OUT leaf or a departure
// through the IN leaf (keep right); the last step into a stand point not from the south (§4.4 approach); waiting on
// the corridor, an opening, a door leaf or the doormat; the exit tile's distance east of the lane's west end (> 1 per
// tile, so leavers walk west along the lane before they fade, §4.6 "Leaving").
//
// The search allocates nothing per node: typed arrays built once (CSR adjacency from layout.moves, transit and soft
// cost masks, heuristic fields cached per goal tile), a binary heap on typed arrays, and Map lookups keyed by small
// integers (steps are counted from the planner's first time value, so keys stay small).
import type { Tile } from '../map/loadMap.ts'
import type { PlaceLayout } from '../map/places.ts'

/** The one walking speed (D4), the same for every worker. */
export const WALK_TILES_PER_S = 3.2
/** One step = one tile at the walking speed. */
export const STEP_MS = 1000 / WALK_TILES_PER_S
/** The spacing the traffic check asserts (§4.7; the grid model's floor is √0.5 ≈ 0.707). */
export const MIN_SPACING = 0.69
/** A departure's goal: the exit lane; the planner picks the tile. */
export const EXIT = 'exit'
export type Goal = Tile | typeof EXIT
export type Facing = 'N' | 'E' | 'S' | 'W'
const FACINGS: readonly Facing[] = ['N', 'E', 'S', 'W']
const FACE_W = 3

/** Soft costs, in steps. */
export const SOFT = {
  /** An arrival through the OUT leaf, a departure through the IN leaf (keep right, §4.7). */
  wrongLeaf: 3,
  /** The last step into a stand point not from the tile south of it (§4.4: head-on from the south). */
  sideApproach: 2,
  /** Per step waited on the corridor, an opening, a door leaf or the doormat (never loiter in a doorway). */
  loiter: 0.25,
  /** Per tile east of the exit lane's west end (over 1: leavers walk west along the lane, then fade, §4.6). */
  exitWest: 1.25,
  /** Per row south of the lane's first row (a tie-break: the row the doormat opens onto). */
  exitRow: 0.1,
} as const

export interface PlannerOptions {
  /** How far ahead a search looks, in steps (192 = 60 s, the trip bound the traffic check asserts). */
  readonly horizonSteps?: number
  /** Arrival trips leave the sidewalk at least this far apart (§4.6 step 4: single file, ≥ 0.4 s apart). */
  readonly releaseGapMs?: number
  /** A leaver stands on its exit-lane tile for this long while it fades, then is gone. */
  readonly exitFadeMs?: number
}
export const PLANNER_DEFAULTS = { horizonSteps: 192, releaseGapMs: 400, exitFadeMs: 800 } as const

/** walking: a trajectory is booked; here: it already stands on the goal; pending: no trajectory found yet (the old
 *  one is kept, the request is retried on tick); appearing: it is not on the grid yet (its slot is still in use);
 *  refused: after dispose(), or an unknown worker with nowhere to appear. */
export type PlanStatus = 'walking' | 'here' | 'pending' | 'appearing' | 'refused'
export interface PlanResult {
  readonly status: PlanStatus
  /** When it will stand on its goal (ms), for walking / here. */
  readonly arriveAt: number | null
  /** The goal tile (for EXIT: the lane tile chosen), for walking / here. */
  readonly goal: Tile | null
}

/** What the renderer draws. Pass an object to fill (no allocation per frame). */
export interface BodyPose {
  x: number
  y: number
  /** Crossing an edge now (walk frames advance with distance, §4.8). */
  moving: boolean
  /** The direction of the current move, else of the last one (direction-keeping idle frames). */
  facing: Facing
  /** Tiles walked since it appeared (drives the 4-phase walk cycle, §4.8). */
  walked: number
}

/** For checks and the renderer's bookkeeping. */
export interface BodyState {
  readonly appeared: boolean
  /** Its newest request has no booked trajectory yet; the old one is kept (keep-old-path). */
  readonly pending: boolean
  /** The newest request's goal. */
  readonly request: Goal | null
  /** Where the booked trajectory ends (an exit trip: the lane tile). */
  readonly goal: Tile | null
  /** When the booked trajectory first stands on its goal (ms). */
  readonly arriveAt: number | null
  /** The booked trajectory is an exit trip: the worker is removed once its fade is over. */
  readonly leaving: boolean
}

export interface PlannerStats {
  /** plan() calls that set a new goal. */
  plans: number
  /** Of those, for a worker that was walking (a mid-walk retarget). */
  midWalk: number
  /** Searches run, and the most states one search expanded. */
  searches: number
  expandedMax: number
  /** Attempts that found no trajectory (the keep-old-path rule applied). */
  failed: number
  /** Arrivals that could not appear at once (their tile was still in use, or about to be crossed). */
  appearDelayed: number
  /** Calls refused after dispose(), or for an unknown worker without `from`. */
  refused: number
  /** Bookings that collided with another worker's (never, if the rules hold; the traffic check asserts 0). */
  conflicts: number
}

interface Request { readonly goal: Goal; readonly at: number }

interface Body {
  readonly key: string
  readonly id: number
  appeared: boolean
  /** Where it appears (the requested tile; a sidewalk slot may be swapped for the first free one). */
  appearTile: number
  appearStep: number
  /** path[k] is its tile at step s0 + k. After the last step it rests on the last tile, or (an exit trip) is gone. */
  path: number[]
  s0: number
  /** Moves made up to each path index; the facing at each index. */
  cum: Int32Array
  face: Uint8Array
  walkedBase: number
  /** The tile it rests on from the end of its path; -1 for an exit trip. */
  rest: number
  leaving: boolean
  /** The step the booked trajectory first stands on its goal. */
  arriveStep: number
  req: Request | null
  pending: boolean
  queueSeq: number
  triedVersion: number
  triedStep: number
}

const REFUSED: PlanResult = Object.freeze({ status: 'refused', arriveAt: null, goal: null })
const APPEARING: PlanResult = Object.freeze({ status: 'appearing', arriveAt: null, goal: null })
const PENDING: PlanResult = Object.freeze({ status: 'pending', arriveAt: null, goal: null })
const sameGoal = (a: Goal, b: Goal) => (a === EXIT || b === EXIT ? a === b : a.x === b.x && a.y === b.y)

export class PathPlanner {
  readonly layout: PlaceLayout
  readonly horizonSteps: number
  readonly releaseGapMs: number
  readonly exitFadeMs: number
  readonly stats: PlannerStats = { plans: 0, midWalk: 0, searches: 0, expandedMax: 0, failed: 0, appearDelayed: 0, refused: 0, conflicts: 0 }

  // the grid, built once
  readonly #W: number
  readonly #N: number
  readonly #walk: Uint8Array
  readonly #seat: Uint8Array
  /** Walkable and not an endpoint: a trajectory may pass through it. */
  readonly #transit: Uint8Array
  readonly #outside: Uint8Array
  readonly #loiter: Uint8Array
  readonly #standPoint: Uint8Array
  readonly #adjStart: Int32Array
  readonly #adj: Int32Array
  readonly #inLeaf: number
  readonly #outLeaf: number
  readonly #exitMask: Uint8Array
  readonly #exitTerm: Float32Array
  readonly #exitField: Float32Array
  readonly #fadeSteps: number
  readonly #fields = new Map<number, Float32Array>()

  // the reservation table: (step * N + tile) -> body id; rests per tile
  readonly #res = new Map<number, number>()
  readonly #restOwner: Int32Array
  readonly #restFrom: Float64Array
  #maxStep = -Infinity
  #base: number | null = null

  // the workers
  readonly #bodies = new Map<string, Body>()
  #nextId = 0
  /** Ids of workers the planner dropped, so bookingCount() still sees a booking such a worker leaked. */
  readonly #forgotten = new Map<string, number>()
  #pending: Body[] = []
  #appearing: Body[] = []
  #queueSeq = 0
  #version = 0
  #lastRelease = -Infinity
  #disposed = false

  // the search's buffers, allocated once: states are (layer, tile) = layer * N + tile, layer = step - s0
  readonly #stamp: Uint32Array
  readonly #closed: Uint32Array
  readonly #gpen: Float32Array
  readonly #parent: Int32Array
  #heapKey = new Float64Array(1 << 14)
  #heapVal = new Int32Array(1 << 14)
  #heapN = 0
  #searchId = 0

  constructor(layout: PlaceLayout, opts: PlannerOptions = {}) {
    this.layout = layout
    this.horizonSteps = opts.horizonSteps ?? PLANNER_DEFAULTS.horizonSteps
    this.releaseGapMs = opts.releaseGapMs ?? PLANNER_DEFAULTS.releaseGapMs
    this.exitFadeMs = opts.exitFadeMs ?? PLANNER_DEFAULTS.exitFadeMs
    const map = layout.map
    const W = map.width, N = W * map.height
    this.#W = W
    this.#N = N
    const problems: string[] = []
    this.#walk = new Uint8Array(N)
    this.#seat = new Uint8Array(N)
    this.#outside = new Uint8Array(N)
    this.#loiter = new Uint8Array(N)
    this.#standPoint = new Uint8Array(N)
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        this.#walk[i] = map.walkable(x, y) ? 1 : 0
        this.#seat[i] = layout.seatAt(x, y) !== null ? 1 : 0
        this.#outside[i] = y > map.facadeRow ? 1 : 0
        this.#loiter[i] = map.zoneAt(x, y)?.name === 'CORRIDOR' || map.tiles[y][x] === 'opening' ? 1 : 0
      }
    }
    const endpoint = new Uint8Array(N)
    for (const e of layout.endpoints) endpoint[e.y * W + e.x] = 1
    for (const p of layout.points) if (p.how === 'stand') this.#standPoint[p.y * W + p.x] = 1
    this.#transit = new Uint8Array(N)
    for (let i = 0; i < N; i++) this.#transit[i] = this.#walk[i] === 1 && endpoint[i] === 0 ? 1 : 0
    const d = map.door
    this.#inLeaf = d.inLeaf.y * W + d.inLeaf.x
    this.#outLeaf = d.outLeaf.y * W + d.outLeaf.x
    for (const t of [d.inLeaf, d.outLeaf, ...d.doormat]) this.#loiter[t.y * W + t.x] = 1
    // CSR adjacency from layout.moves (the seat rule lives there), in its BFS order
    this.#adjStart = new Int32Array(N + 1)
    const adj: number[] = []
    for (let i = 0; i < N; i++) {
      this.#adjStart[i] = adj.length
      for (const m of layout.moves({ x: i % W, y: (i / W) | 0 })) adj.push(m.y * W + m.x)
    }
    this.#adjStart[N] = adj.length
    this.#adj = Int32Array.from(adj)
    // a seat is reached through its sitFrom tile, which must be a transit tile; slots and the exit lane are transit
    for (const p of layout.points) {
      if (p.how === 'sit' && (p.sitFrom === null || this.#transit[p.sitFrom.y * W + p.sitFrom.x] !== 1)) problems.push(`seat ${p.id}: its sitFrom tile is not a transit tile`)
    }
    for (const t of [...map.arrivalSlots, ...map.arrivalSlotsOverflow, ...map.exitLane]) {
      if (this.#transit[t.y * W + t.x] !== 1) problems.push(`sidewalk tile (${t.x},${t.y}) is not a transit tile`)
    }
    if (map.exitLane.length === 0) problems.push('the map has no exit lane')
    if (problems.length > 0) throw new Error(`PathPlanner: the layout breaks Path A's rules:\n- ${problems.join('\n- ')}`)
    // the exit lane: a goal set with a terminal cost that prefers its west end
    this.#exitMask = new Uint8Array(N)
    this.#exitTerm = new Float32Array(N)
    const x0 = Math.min(...map.exitLane.map(t => t.x)), y0 = Math.min(...map.exitLane.map(t => t.y))
    for (const t of map.exitLane) {
      const i = t.y * W + t.x
      this.#exitMask[i] = 1
      this.#exitTerm[i] = SOFT.exitWest * (t.x - x0) + SOFT.exitRow * (t.y - y0)
    }
    this.#exitField = new Float32Array(N).fill(Infinity)
    for (const t of map.exitLane) {
      const i = t.y * W + t.x, f = this.#field(i), c = this.#exitTerm[i]
      for (let j = 0; j < N; j++) if (f[j] + c < this.#exitField[j]) this.#exitField[j] = f[j] + c
    }
    this.#fadeSteps = Math.max(0, Math.ceil(this.exitFadeMs / STEP_MS))
    this.#restOwner = new Int32Array(N).fill(-1)
    this.#restFrom = new Float64Array(N)
    const states = (this.horizonSteps + 1) * N
    this.#stamp = new Uint32Array(states)
    this.#closed = new Uint32Array(states)
    this.#gpen = new Float32Array(states)
    this.#parent = new Int32Array(states)
  }

  get disposed(): boolean { return this.#disposed }

  // ── the API ──────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Send a worker to `to` (a tile, or EXIT), the newest request winning. `from`: where a worker the planner does not
   *  know yet appears (its sidewalk slot; a snap after cancel); null for a worker it knows (it continues from where it
   *  is). A worker that cannot appear yet (its tile is still in use), or for which no trajectory exists yet, is
   *  retried by tick(); until then it keeps its old path or stands. */
  plan(worker: string, from: Tile | null, to: Goal, now: number): PlanResult {
    if (this.#disposed) { this.stats.refused++; return REFUSED }
    if (to !== EXIT) this.#checkTile(to, 'its goal')
    let b = this.#bodies.get(worker)
    if (b === undefined) {
      if (from === null) { this.stats.refused++; return REFUSED }
      const a = this.#checkTile(from, 'where it appears')
      if (this.#walk[a] !== 1) throw new Error(`PathPlanner.plan: ${worker} cannot appear on (${from.x},${from.y}), a seat`)
      b = {
        key: worker, id: this.#nextId++, appeared: false, appearTile: a, appearStep: 0, path: [a], s0: 0, cum: Int32Array.of(0),
        face: Uint8Array.of(FACE_W), walkedBase: 0, rest: -1, leaving: false, arriveStep: 0, req: { goal: to, at: now },
        pending: false, queueSeq: 0, triedVersion: -1, triedStep: -Infinity,
      }
      this.#bodies.set(worker, b)
      this.stats.plans++
      if (!this.#tryAppear(b, now)) {
        this.stats.appearDelayed++
        this.#appearing.push(b)
        return APPEARING
      }
      return this.#afterAppear(b, now)
    }
    if (from !== null) {
      const here = b.appeared ? this.#tileAt(b, this.#ceilStep(now)) : b.appearTile
      if (here !== this.#checkTile(from, 'where it is')) {
        throw new Error(`PathPlanner.plan: ${worker} is on the grid at (${here % this.#W},${(here / this.#W) | 0}); pass from = null (or cancel it first)`)
      }
    }
    if (b.req !== null && sameGoal(b.req.goal, to)) {
      if (!b.appeared) return APPEARING
      return b.pending ? PENDING : this.#booked(b, now)
    }
    b.req = { goal: to, at: now }
    this.stats.plans++
    if (!b.appeared) return APPEARING
    if (this.#rel(now) < b.s0 + b.path.length - 1) this.stats.midWalk++
    return this.#attempt(b, now)
  }

  /** Every frame: finished exit fades leave the grid, finished walks are compacted, waiting arrivals appear, and
   *  pending requests are retried (first come, first planned) when the bookings changed or a step went by. */
  tick(now: number): void {
    if (this.#disposed) return
    const step = this.#floorStep(now)
    for (const b of this.#bodies.values()) {
      if (!b.appeared) continue
      const end = b.s0 + b.path.length - 1
      if (b.leaving && step > end) this.#drop(b)
      else if (!b.leaving && step > end + 1 && b.path.length > 1) this.#compact(b, end)
    }
    if (this.#appearing.length > 0) {
      for (const b of this.#appearing) {
        if (b.appeared || !this.#tryAppear(b, now)) continue
        this.#afterAppear(b, now)
      }
      this.#appearing = this.#appearing.filter(b => !b.appeared && this.#bodies.get(b.key) === b)
    }
    for (let pass = 0; pass < 4 && this.#pending.length > 0; pass++) {
      let progress = false
      for (const b of this.#pending) {
        if (!b.pending || (b.triedVersion === this.#version && b.triedStep === step)) continue
        if (this.#attempt(b, now).status !== 'pending') progress = true
      }
      this.#pending = this.#pending.filter(b => b.pending)
      if (!progress) break
    }
  }

  /** Where a worker is at time t (ms): interpolated along the grid edge it is crossing. Null when it is not on the
   *  grid: unknown, not appeared yet, gone after its exit fade, or the planner is disposed. */
  positionAt(worker: string, t: number, out?: BodyPose): BodyPose | null {
    if (this.#disposed) return null
    const b = this.#bodies.get(worker)
    if (b === undefined || !b.appeared) return null
    const u = this.#rel(t)
    if (u < b.appearStep - 1e-9) return null
    const L = b.path.length
    let k = u - b.s0
    if (b.leaving && k > L - 1 + 1e-9) return null
    const o: BodyPose = out ?? { x: 0, y: 0, moving: false, facing: 'W', walked: 0 }
    const W = this.#W
    if (k <= 0 || k >= L - 1) {
      const i = k <= 0 ? 0 : L - 1, tile = b.path[i]
      o.x = tile % W; o.y = (tile / W) | 0; o.moving = false; o.facing = FACINGS[b.face[i]]; o.walked = b.walkedBase + b.cum[i]
      return o
    }
    const i = Math.floor(k)
    k -= i
    const a = b.path[i], c = b.path[i + 1]
    const ax = a % W, ay = (a / W) | 0
    if (a === c) {
      o.x = ax; o.y = ay; o.moving = false; o.facing = FACINGS[b.face[i]]; o.walked = b.walkedBase + b.cum[i]
      return o
    }
    o.x = ax + ((c % W) - ax) * k; o.y = ay + (((c / W) | 0) - ay) * k
    o.moving = true; o.facing = FACINGS[this.#dir(a, c)]; o.walked = b.walkedBase + b.cum[i] + k
    return o
  }

  /** Drop a worker: every booking it holds goes, it leaves the grid at once (a fade without walking, a snap's first
   *  half, a re-entry while its old body is still fading). */
  cancel(worker: string): void {
    if (this.#disposed) return
    const b = this.#bodies.get(worker)
    if (b === undefined) return
    this.#unbookAll(b)   // cancel: the table forgets every booking of this worker
    this.#forget(b)
  }

  /** Drop everything; every later call books nothing and positionAt returns null. */
  dispose(): void {
    if (this.#disposed) return
    this.#res.clear()
    this.#restOwner.fill(-1)
    this.#bodies.clear()
    this.#pending = []
    this.#appearing = []
    this.#disposed = true
  }

  // ── read-only views (checks and the renderer's bookkeeping) ─────────────────────────────────────────────────────
  /** The workers the planner knows (appearing, on the grid, or fading out). */
  workers(): string[] { return [...this.#bodies.keys()] }

  state(worker: string): BodyState | null {
    const b = this.#bodies.get(worker)
    if (this.#disposed || b === undefined) return null
    const W = this.#W
    const end = b.path[b.path.length - 1]
    return {
      appeared: b.appeared, pending: b.pending, request: b.req?.goal ?? null,
      goal: b.appeared ? { x: end % W, y: (end / W) | 0 } : null,
      arriveAt: b.appeared ? this.#msOf(b.arriveStep) : null, leaving: b.leaving,
    }
  }

  /** Nobody stands on the tile and nobody will cross it, from the step `now` falls in on (no rest, no booking). The
   *  page's signal that a sidewalk slot's body has left it (lead ruling 3). False after dispose(). */
  isClear(tile: Tile, now: number): boolean {
    if (this.#disposed) return false
    const i = this.#checkTile(tile, 'the tile')
    return this.#goalFree(i, this.#floorStep(now), Infinity, -1)
  }

  /** Bookings in the table: (tile, step) pairs plus rests, of one worker or of everyone. */
  bookingCount(worker?: string): number {
    let id = -2
    if (worker !== undefined) {
      const b = this.#bodies.get(worker)
      // a forgotten worker's id can still own stale bookings (a cancel that leaks them): count those too
      id = b?.id ?? this.#forgotten.get(worker) ?? -3
    }
    let n = 0
    for (const v of this.#res.values()) if (id === -2 || v === id) n++
    for (let i = 0; i < this.#N; i++) { const r = this.#restOwner[i]; if (r >= 0 && (id === -2 || r === id)) n++ }
    return n
  }

  // ── planning ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Plan the newest request of an appeared worker from where it is at the next step boundary. On failure the old
   *  bookings are restored and the request waits for a retry. */
  #attempt(b: Body, now: number): PlanResult {
    const req = b.req!
    const s0 = this.#ceilStep(now)
    const start = this.#tileAt(b, s0)
    const goal = req.goal
    const exit = goal === EXIT
    const gi = exit ? -1 : goal.y * this.#W + goal.x
    if (this.#hStart(start, exit ? this.#exitField : this.#field(gi), gi, exit) === Infinity) {
      throw new Error(`PathPlanner: ${b.key} cannot reach ${exit ? 'the exit lane' : `(${goal.x},${goal.y})`} from (${start % this.#W},${(start / this.#W) | 0}) through transit tiles`)
    }
    this.#unbookFrom(b, s0)
    const arrival = this.#outside[start] === 1 && !exit && this.#outside[gi] === 0
    let release = s0, releaseAt = -Infinity
    if (arrival) {
      releaseAt = Math.max(now, this.#lastRelease + this.releaseGapMs)
      release = Math.max(s0, this.#ceilStep(releaseAt))
    }
    const path = this.#search(b.id, start, s0, goal, gi, release)
    if (path === null) {
      this.#rebookFrom(b, s0)   // keep-old-path (§4.7): the old bookings stand and the old path is walked
      this.stats.failed++
      if (!b.pending) { b.pending = true; b.queueSeq = ++this.#queueSeq; this.#pending.push(b) }
      b.triedVersion = this.#version
      b.triedStep = this.#floorStep(now)
      return PENDING
    }
    if (arrival) this.#lastRelease = releaseAt
    this.#install(b, s0, path, exit)
    b.pending = false
    return this.#booked(b, now)
  }

  #booked(b: Body, now: number): PlanResult {
    const end = b.path[b.path.length - 1]
    return {
      status: this.#rel(now) >= b.arriveStep - 1e-9 ? 'here' : 'walking', arriveAt: this.#msOf(b.arriveStep),
      goal: { x: end % this.#W, y: (end / this.#W) | 0 },
    }
  }

  /** Space-time A* from (start, s0) to the goal: one step per layer, at most horizonSteps layers. Returns the tiles
   *  from s0 to the arrival (an exit trip: plus the fade's steps on its lane tile), or null. */
  #search(me: number, start: number, s0: number, goal: Goal, gi: number, release: number): number[] | null {
    this.stats.searches++
    const N = this.#N, W = this.#W, Hz = this.horizonSteps
    const exit = goal === EXIT
    // a goal another worker will stand on for good can never be reached: no search
    if (!exit) { const r = this.#restOwner[gi]; if (r >= 0 && r !== me) return null }
    const field = exit ? this.#exitField : this.#field(gi)
    const hold = exit ? this.#fadeSteps : Infinity
    const south = !exit && this.#standPoint[gi] === 1 ? gi + W : -1
    const startOut = this.#outside[start] === 1, goalOut = exit || this.#outside[gi] === 1
    const wrong = startOut && !goalOut ? this.#outLeaf : !startOut && goalOut ? this.#inLeaf : -1
    const hs = this.#hStart(start, field, gi, exit)
    if (++this.#searchId >= 0xffffffff) { this.#stamp.fill(0); this.#closed.fill(0); this.#searchId = 1 }
    const id = this.#searchId
    const stamp = this.#stamp, closed = this.#closed, gpen = this.#gpen, parent = this.#parent
    const transit = this.#transit, exitMask = this.#exitMask, adjStart = this.#adjStart, adj = this.#adj
    this.#heapN = 0
    stamp[start] = id; gpen[start] = 0; parent[start] = -1
    this.#push(hs, start)
    let expanded = 0
    let found = -1
    while (this.#heapN > 0) {
      const s = this.#pop()
      if (s < 0) { found = -s - 1; break }
      if (closed[s] === id) continue
      closed[s] = id
      expanded++
      const layer = (s / N) | 0, i = s - layer * N, t = s0 + layer, pen = gpen[s]
      if ((exit ? exitMask[i] === 1 : i === gi) && this.#goalFree(i, t, hold, me)) {
        if (!exit) { found = s; break }
        this.#push(layer + pen + this.#exitTerm[i] - 1e-6 * layer, -s - 1)   // the cost of stopping here
      }
      if (layer >= Hz) continue
      const t1 = t + 1, next = s + N
      // wait a step
      if (this.#free(i, t1, me)) this.#relax(next, s, pen + (this.#loiter[i] === 1 ? SOFT.loiter : 0), i === start ? hs : field[i], layer + 1, id)
      // move (a trip from the sidewalk leaves its tile only from its release step on)
      if (i === start && t < release) continue
      for (let k = adjStart[i], e = adjStart[i + 1]; k < e; k++) {
        const j = adj[k]
        if (transit[j] === 0 && !(exit ? exitMask[j] === 1 : j === gi)) continue
        if (!this.#free(j, t1, me)) continue
        const o = this.#res.get(t * N + j)                       // no swaps: whoever is on j now is not on i next
        if (o !== undefined && o !== me && this.#res.get(t1 * N + i) === o) continue
        let np = pen
        if (j === wrong) np += SOFT.wrongLeaf
        if (j === gi && south >= 0 && i !== south) np += SOFT.sideApproach
        this.#relax(next + j - i, s, np, field[j], layer + 1, id)
      }
    }
    if (expanded > this.stats.expandedMax) this.stats.expandedMax = expanded
    if (found < 0) return null
    const tiles: number[] = []
    for (let s = found; s >= 0; s = parent[s]) tiles.push(s % N)
    tiles.reverse()
    for (let k = 0; k < (exit ? hold : 0); k++) tiles.push(tiles[tiles.length - 1])
    return tiles
  }

  #relax(ns: number, from: number, np: number, h: number, layer: number, id: number) {
    if (h === Infinity) return
    if (this.#stamp[ns] === id && this.#gpen[ns] <= np) return
    this.#stamp[ns] = id
    this.#gpen[ns] = np
    this.#parent[ns] = from
    this.#push(layer + np + h - 1e-6 * layer, ns)
  }

  /** Nobody else is on tile j at step t (a booked step, or a rest that has begun). */
  #free(j: number, t: number, me: number): boolean {
    const o = this.#res.get(t * this.#N + j)
    if (o !== undefined && o !== me) return false
    const r = this.#restOwner[j]
    return r < 0 || r === me || t < this.#restFrom[j]
  }

  /** The goal can be stood on from step t: for good (hold = Infinity), or for `hold` more steps (an exit fade). */
  #goalFree(i: number, t: number, hold: number, me: number): boolean {
    const r = this.#restOwner[i]
    if (r >= 0 && r !== me && (hold === Infinity || this.#restFrom[i] <= t + hold)) return false
    const end = Math.min(this.#maxStep, t + hold)
    for (let s = t; s <= end; s++) {
      const o = this.#res.get(s * this.#N + i)
      if (o !== undefined && o !== me) return false
    }
    return true
  }

  /** The heuristic at the start, which may be an endpoint (not in the transit field): one step to a neighbour. */
  #hStart(start: number, field: Float32Array, gi: number, exit: boolean): number {
    if (this.#transit[start] === 1 || start === gi || (exit && this.#exitMask[start] === 1)) return field[start]
    let h = Infinity
    for (let k = this.#adjStart[start], e = this.#adjStart[start + 1]; k < e; k++) {
      const j = this.#adj[k]
      if (this.#transit[j] === 1 || j === gi) h = Math.min(h, 1 + field[j])
    }
    return h
  }

  /** Walked steps to a goal tile through transit tiles only (the goal itself is the source); cached per goal. */
  #field(g: number): Float32Array {
    const cached = this.#fields.get(g)
    if (cached !== undefined) return cached
    const N = this.#N
    const f = new Float32Array(N).fill(Infinity)
    const q = new Int32Array(N)
    let head = 0, tail = 0
    f[g] = 0
    q[tail++] = g
    while (head < tail) {
      const c = q[head++]
      for (let k = this.#adjStart[c], e = this.#adjStart[c + 1]; k < e; k++) {
        const j = this.#adj[k]
        if (f[j] !== Infinity || this.#transit[j] === 0) continue
        f[j] = f[c] + 1
        q[tail++] = j
      }
    }
    this.#fields.set(g, f)
    return f
  }

  // ── the heap (typed arrays; ties go to the entry pushed first) ──────────────────────────────────────────────────
  #push(key: number, val: number) {
    if (this.#heapN === this.#heapKey.length) {
      const k = new Float64Array(this.#heapKey.length * 2); k.set(this.#heapKey); this.#heapKey = k
      const v = new Int32Array(this.#heapVal.length * 2); v.set(this.#heapVal); this.#heapVal = v
    }
    const keys = this.#heapKey, vals = this.#heapVal
    let i = this.#heapN++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      keys[i] = keys[p]; vals[i] = vals[p]; i = p
    }
    keys[i] = key; vals[i] = val
  }

  #pop(): number {
    const keys = this.#heapKey, vals = this.#heapVal
    const top = vals[0]
    const n = --this.#heapN
    if (n > 0) {
      const key = keys[n], val = vals[n]
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && keys[c + 1] < keys[c]) c++
        if (keys[c] >= key) break
        keys[i] = keys[c]; vals[i] = vals[c]; i = c
      }
      keys[i] = key; vals[i] = val
    }
    return top
  }

  // ── bookings ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Put a found trajectory in place: the step before s0 is kept (the edge being drawn), the old past is dropped, the
   *  new steps and the rest (or the exit fade) are booked. */
  #install(b: Body, s0: number, path: number[], exit: boolean) {
    const from = Math.max(b.s0, s0 - 1)
    this.#unbookRange(b, b.s0, from - 1)
    const keep = from < s0 ? [this.#tileAt(b, from)] : []
    const walkedBase = b.walkedBase + b.cum[Math.min(Math.max(from - b.s0, 0), b.path.length - 1)]
    const face0 = b.face[Math.min(Math.max(from - b.s0, 0), b.path.length - 1)]
    const p = keep.concat(path)
    b.path = p
    b.s0 = from
    b.walkedBase = walkedBase
    b.cum = new Int32Array(p.length)
    b.face = new Uint8Array(p.length)
    b.face[0] = face0
    for (let k = 1; k < p.length; k++) {
      const moved = p[k] !== p[k - 1]
      b.cum[k] = b.cum[k - 1] + (moved ? 1 : 0)
      b.face[k] = moved ? this.#dir(p[k - 1], p[k]) : b.face[k - 1]
    }
    for (let k = 0; k < p.length; k++) this.#bookStep(b.id, from + k, p[k])
    b.leaving = exit
    b.arriveStep = s0 + path.length - 1 - (exit ? this.#fadeSteps : 0)
    if (exit) b.rest = -1
    else this.#setRest(b, p[p.length - 1], from + p.length - 1)
    this.#version++
  }

  #bookStep(id: number, step: number, tile: number) {
    const key = step * this.#N + tile
    const o = this.#res.get(key)
    if (o !== undefined && o !== id) { this.stats.conflicts++; return }
    this.#res.set(key, id)
    if (step > this.#maxStep) this.#maxStep = step
  }

  #setRest(b: Body, tile: number, from: number) {
    const r = this.#restOwner[tile]
    if (r >= 0 && r !== b.id) this.stats.conflicts++
    this.#restOwner[tile] = b.id
    this.#restFrom[tile] = from
    b.rest = tile
  }

  #clearRest(b: Body) {
    if (b.rest >= 0 && this.#restOwner[b.rest] === b.id) this.#restOwner[b.rest] = -1
  }

  /** Lift the bookings after step s0 (the trajectory's future and its rest), for a re-plan. */
  #unbookFrom(b: Body, s0: number) {
    for (let k = Math.max(0, s0 + 1 - b.s0); k < b.path.length; k++) {
      const key = (b.s0 + k) * this.#N + b.path[k]
      if (this.#res.get(key) === b.id) this.#res.delete(key)
    }
    this.#clearRest(b)
  }

  /** Put back what unbookFrom lifted (the keep-old-path rule). */
  #rebookFrom(b: Body, s0: number) {
    for (let k = Math.max(0, s0 + 1 - b.s0); k < b.path.length; k++) this.#bookStep(b.id, b.s0 + k, b.path[k])
    if (b.rest >= 0) this.#setRest(b, b.rest, b.s0 + b.path.length - 1)
  }

  #unbookRange(b: Body, from: number, to: number) {
    for (let s = Math.max(from, b.s0); s <= to && s - b.s0 < b.path.length; s++) {
      const key = s * this.#N + b.path[s - b.s0]
      if (this.#res.get(key) === b.id) this.#res.delete(key)
    }
  }

  #unbookAll(b: Body) {
    this.#unbookRange(b, b.s0, b.s0 + b.path.length - 1)
    this.#clearRest(b)
  }

  /** A walk that ended: its past steps leave the table; the rest keeps the tile. */
  #compact(b: Body, end: number) {
    this.#unbookRange(b, b.s0, end - 1)
    const last = b.path.length - 1
    b.walkedBase += b.cum[last]
    const face = b.face[last]
    b.path = [b.path[last]]
    b.s0 = end
    b.cum = Int32Array.of(0)
    b.face = Uint8Array.of(face)
  }

  /** An exit trip whose fade is over: the worker leaves the grid. */
  #drop(gone: Body) {
    this.#unbookAll(gone)
    this.#forget(gone)
  }

  #forget(b: Body) {
    this.#bodies.delete(b.key)
    this.#forgotten.set(b.key, b.id)
    if (b.pending) { b.pending = false; this.#pending = this.#pending.filter(x => x !== b) }
    this.#appearing = this.#appearing.filter(x => x !== b)
    this.#version++
  }

  /** Appear on its tile at the next step boundary if nobody else will stand on it or pass it from then on; otherwise
   *  stay off the grid and let tick() retry. Never another tile: the spawn names the real slot (lead ruling 3). */
  #tryAppear(b: Body, now: number): boolean {
    const s = this.#ceilStep(now)
    if (!this.#goalFree(b.appearTile, s, Infinity, b.id)) return false
    b.appeared = true
    b.appearStep = s
    b.path = [b.appearTile]
    b.s0 = s
    b.arriveStep = s
    this.#bookStep(b.id, s, b.appearTile)
    this.#setRest(b, b.appearTile, s)
    this.#version++
    return true
  }

  #afterAppear(b: Body, now: number): PlanResult {
    const g = b.req!.goal
    if (g !== EXIT && g.y * this.#W + g.x === b.appearTile) return this.#booked(b, now)
    return this.#attempt(b, now)
  }

  // ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────
  #checkTile(t: Tile, what: string): number {
    const map = this.layout.map
    if (!Number.isInteger(t.x) || !Number.isInteger(t.y) || !map.inBounds(t.x, t.y)) throw new Error(`PathPlanner.plan: ${what} (${t.x},${t.y}) is not a tile`)
    const i = t.y * this.#W + t.x
    if (this.#walk[i] !== 1 && this.#seat[i] !== 1) throw new Error(`PathPlanner.plan: ${what} (${t.x},${t.y}) is neither walkable nor a seat`)
    return i
  }

  #tileAt(b: Body, step: number): number {
    const k = step - b.s0
    return b.path[k <= 0 ? 0 : k >= b.path.length ? b.path.length - 1 : k]
  }

  #dir(a: number, c: number): number {
    const d = c - a
    return d === 1 ? 1 : d === -1 ? 3 : d > 0 ? 2 : 0
  }

  /** Steps since the planner's first time value (so table keys stay small integers). */
  #rel(t: number): number {
    if (this.#base === null) this.#base = Math.floor(t / STEP_MS)
    return t / STEP_MS - this.#base
  }
  #ceilStep(t: number): number { return Math.ceil(this.#rel(t) - 1e-9) }
  #floorStep(t: number): number { return Math.floor(this.#rel(t) + 1e-9) }
  #msOf(step: number): number { return (step + (this.#base ?? 0)) * STEP_MS }
}
