// Worker office movement core: the traffic check (plan §6.4 "Movement core (Path A)"; lean scope per the owner's
// budget, decisions.md 2026-10-01 18:18). Run: node scripts/worker-office-traffic-sim.ts [--tuning-only] [--no-mutants]
//   --tuning-only  skip the 4 held-out seeds (they are run only once the planner is final)
//   --no-mutants   skip the mutant runs
//
// The REAL observer core (src/worker-office/core/reducer.ts) is fed synthetic spool lines (delivered 300 ms after
// their timestamp, as the page reads them) and its renderer commands drive the planner the way the page will:
//   spawn{slot}   -> plan(w, slotTile, slotTile, now)     (a re-entry while the old body still fades: cancel first)
//   walkTo{place} -> plan(w, null, the place's own tile, now)
//   leave         -> plan(w, null, EXIT, now)
//   fade          -> cancel(w)
// Two scenarios (R, C) send those commands from a script instead, to pin the keep-old-path and cancel paths.
// Frames are STEP_MS / 8 = 39.0625 ms apart, on the planner's step grid: every eighth of a step is sampled.
//
// Asserted on every run:
//   A1 every trip ends on its reserved tile within 60 s of its request (a trip = one plan() call with a new goal; a
//      newer call supersedes it). At the arrival the drawn position is exactly the goal tile (an exit trip: an exit-lane
//      tile), and for a place the observer's book still holds that place for the worker. A spawn's trip is the
//      appearance on its slot. Trips still open at the end of the run count if they are older than 60 s;
//   A2 spacing >= 0.69 tiles between any two drawn workers at every sampled instant;
//   A3 no swaps (two workers exchanging tiles across one step); every move is one legal grid step (layout.canStep:
//      4-neighbour, a seat entered and left only through its sitFrom tile) and a drawn worker stands on a whole
//      walkable tile or seat at every step boundary; no booking conflict inside the
//      planner (stats.conflicts = 0); a cancelled worker holds no booking;
//   A4 after dispose(): no booking, positionAt null for every worker, plan() refused and books nothing, tick() moves
//      nothing;
//   A5 the same input gives the same run (every run twice: positions, trips and stats digested).
// Mutants (each a one-line patch of planner.ts, loaded from a temp copy) must each make some check fail.
// Printed per scenario: trips, mid-walk retargets, failed plan attempts, max wait (standing still during a trip),
// delay p50 / p90 / max against straight walking (the shortest walk on the bare grid, nobody else there), stuck trips.
// Exit 0 when everything passes, 1 otherwise.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadMap, type Tile } from '../src/worker-office/map/loadMap.ts'
import { buildPlaceLayout, type PlaceId } from '../src/worker-office/map/places.ts'
import { ObserverCore } from '../src/worker-office/core/reducer.ts'
import type { Cmd } from '../src/worker-office/core/messages.ts'
import * as realPlanner from '../src/worker-office/move/planner.ts'
import { EXIT, MIN_SPACING, STEP_MS, type BodyPose, type Goal } from '../src/worker-office/move/planner.ts'

type PlannerMod = typeof realPlanner
type Planner = InstanceType<PlannerMod['PathPlanner']>

const args = process.argv.slice(2)
const TUNING_ONLY = args.includes('--tuning-only')
const NO_MUTANTS = args.includes('--no-mutants')
/** --trace <prefix>: print every trip of the scenarios whose name starts with it (for debugging). */
const TRACE = args.includes('--trace') ? args[args.indexOf('--trace') + 1] : null

const PLANNER_PATH = fileURLToPath(new URL('../src/worker-office/move/planner.ts', import.meta.url))
const MAP = loadMap(JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8')))
const LAYOUT = buildPlaceLayout(MAP)
const W = MAP.width
const FRAME = STEP_MS / 8
const TRIP_LIMIT_MS = 60_000
const SLOT_TILES: readonly Tile[] = [...MAP.arrivalSlots, ...MAP.arrivalSlotsOverflow]
const EXIT_SET: ReadonlySet<number> = new Set(MAP.exitLane.map(t => t.y * W + t.x))
const SLOT_SET: ReadonlySet<number> = new Set(SLOT_TILES.map(t => t.y * W + t.x))
const T0 = Date.UTC(2026, 9, 1, 16, 0, 0)            // a multiple of 5 s = 16 steps: frames sit on the step grid
const SA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', SB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Seeds of the 300 s days. The held-out ones were never run while the planner was being written or tuned. */
const TUNING_SEEDS = [11, 12, 13, 14]
const HELD_OUT_SEEDS = [101, 102, 103, 104]

let failures = 0
const fail = (msg: string) => { failures++; console.log(`FAIL ${msg}`) }

// ── the straight-walk baseline: shortest walk on the bare grid (layout.moves; a seat via its sitFrom) ─────────────
const straightFields = new Map<number, Int32Array>()
function straightSteps(from: number, to: number): number {
  let f = straightFields.get(to)
  if (f === undefined) {
    f = new Int32Array(W * MAP.height).fill(-1)
    f[to] = 0
    const q = [to]
    for (let h = 0; h < q.length; h++) {
      const c = q[h]
      for (const m of LAYOUT.moves({ x: c % W, y: (c / W) | 0 })) {
        const j = m.y * W + m.x
        if (f[j] >= 0) continue
        f[j] = f[c] + 1
        q.push(j)
      }
    }
    straightFields.set(to, f)
  }
  return f[from]
}

// ── spool lines ──────────────────────────────────────────────────────────────────────────────────────────────────
interface Line { readonly ts: number; readonly line: string }
const L = (s: number, ev: string, sid: string, f: Record<string, unknown>): Line => {
  const o = { v: 1, ts: T0 + Math.round(s * 1000), sid, ev, ...f }
  return { ts: o.ts, line: JSON.stringify(o) }
}
/** The classifier's kind of each activity id used here (office/observer/classify.mjs). */
const KIND: Readonly<Record<string, string>> = {
  read: 'fileCabinet', run: 'benchTerminal', 'hist-read': 'historyShelf', fetch: 'bookshelf', write: 'pcDesk', diff: 'lectern',
  websearch: 'cardCatalog', 'helper-fg': 'meetingTable', report: 'printer', form: 'frontDesk',
}
type End = 'report' | 'form' | 'stop'
/** One helper: started at t0; each step [activity, call length, gap before its Pre]; then its end (null: none). */
function helper(out: Line[], aid: string, sid: string, t0: number, steps: readonly (readonly [string, number, number])[], end: End | null, hold = 4) {
  out.push(L(t0, 'SubagentStart', sid, { aid, at: 'workflow-subagent' }))
  let t = t0, n = 0
  const call = (a: string, s: number) => L(s, 'PreToolUse', sid, { aid, k: KIND[a], a, tu: `${aid}.${n++}` })
  for (const [a, dur, gap] of steps) {
    t += gap
    out.push(call(a, t))
    t += dur
    out.push(L(t, 'PostToolBatch', sid, { aid, n: 1 }))
  }
  if (end === null) return
  t += 1
  if (end === 'report') {
    const tu = `${aid}.${n}`
    out.push(call('report', t), L(t + 1.5, 'PostToolUse', sid, { aid, k: 'printer', a: 'report', tu }), L(t + 1.7, 'PostToolBatch', sid, { aid, n: 1 }))
    t += 1.7
  } else if (end === 'form') {
    out.push(call('form', t), L(t + 0.5, 'PostToolBatch', sid, { aid, n: 1 }))
    t += 0.5
  }
  out.push(L(t + (end === 'stop' ? 0 : hold), 'SubagentStop', sid, { aid, at: 'workflow-subagent', bt: [] }))
}
const aidOf = (tag: string, k: number) => `a${tag}${String(k).padStart(15 - tag.length, '0')}`.slice(0, 17).padEnd(17, '0')

/** mulberry32: a small seeded generator (the days and S3 draw from it; fixed seeds, so every run is the same). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** The measured step mix (plan §3.4), by activity id; 'none' is a Pre with no kind (STAY). */
const MIX: readonly (readonly [string, number])[] = [
  ['read', 50.7], ['run', 17.2], ['hist-read', 12.3], ['fetch', 6.9], ['write', 4.9], ['diff', 3.4], ['websearch', 1.4],
  ['helper-fg', 1.0], ['none', 0.8],
]
const MIX_SUM = MIX.reduce((s, [, w]) => s + w, 0)
function drawActivity(r: () => number): string {
  let x = r() * MIX_SUM
  for (const [a, w] of MIX) { if ((x -= w) < 0) return a }
  return 'read'
}
/** A random helper life: 60% of steps stay at the same kind (plan §3.5); gaps are often short (mid-walk retargets). */
function randomSteps(r: () => number, count: number, firstGap: number): [string, number, number][] {
  const steps: [string, number, number][] = []
  let prev: string | null = null
  for (let k = 0; k < count; k++) {
    const a: string = prev !== null && r() < 0.6 ? prev : drawActivity(r)
    const dur = r() < 0.85 ? 0.2 + r() * 3.8 : 4 + r() * 8
    const u = r()
    const gap = k === 0 ? firstGap : u < 0.25 ? 0.3 + r() * 1.2 : u < 0.75 ? 1.5 + r() * 6.5 : 8 + r() * 17
    steps.push([a, dur, gap])
    prev = a
  }
  return steps
}
const randomEnd = (r: () => number): End => { const u = r(); return u < 0.45 ? 'report' : u < 0.7 ? 'form' : 'stop' }

// ── one run ──────────────────────────────────────────────────────────────────────────────────────────────────────
interface Scripted { readonly t: number; readonly cmd: Cmd }
interface Scenario {
  readonly name: string
  readonly lines?: readonly Line[]
  readonly cmds?: readonly Scripted[]
  /** Seconds after T0: events end at `until`; the run goes on for `drain` more seconds. */
  readonly until: number
  readonly drain: number
  /** Extra expectations: failed-check strings and a one-line summary. */
  readonly expect?: (sim: Sim) => { readonly bad: string[]; readonly line: string }
}

type TripKind = 'appear' | 'walk' | 'exit'
interface Trip {
  readonly key: string
  readonly kind: TripKind
  readonly goal: Goal
  readonly place: PlaceId | null
  readonly at: number
  readonly from: number
  done: number | null
  closed: 'done' | 'superseded' | 'cancelled' | null
  still: number
}

class Sim {
  readonly planner: Planner
  readonly core: ObserverCore | null
  readonly trips: Trip[] = []
  readonly open = new Map<string, Trip>()
  readonly bad: string[] = []
  readonly names = new Map<string, number>()
  minGap = Infinity
  frames = 0
  endAt = 0
  #digest = 0x811c9dc5
  #prevTiles = new Map<string, number>()
  #pose: BodyPose = { x: 0, y: 0, moving: false, facing: 'W', walked: 0 }
  #xs: number[] = []
  #ys: number[] = []
  #ks: string[] = []
  #moving = new Set<string>()
  /** Trips requested before their worker was on the grid: their start is where it appears. */
  #unplaced: Trip[] = []

  constructor(mod: PlannerMod, withCore: boolean) {
    this.planner = new mod.PathPlanner(LAYOUT)
    this.core = withCore ? new ObserverCore(LAYOUT) : null
  }

  v(tag: string, msg: string) {
    if (this.bad.length < 12) this.bad.push(`${tag} ${msg}`)
    else if (this.bad.length === 12) this.bad.push('... (more)')
  }
  who(key: string) { return `#${this.names.get(key) ?? key}` }
  #mix(n: number) { this.#digest = Math.imul(this.#digest ^ (n | 0), 0x01000193) >>> 0 }
  get digest(): string {
    let d = this.#digest
    for (const t of this.trips) { d = Math.imul(d ^ (t.done === null ? -1 : t.done - T0), 0x01000193) >>> 0 }
    const s = this.planner.stats
    return `${d.toString(16)}|${this.trips.length}|${s.searches}|${s.failed}|${s.expandedMax}`
  }

  run(sc: Scenario): this {
    const lines = [...(sc.lines ?? [])].sort((a, b) => a.ts - b.ts)
    const cmds = [...(sc.cmds ?? [])].sort((a, b) => a.t - b.t)
    const last = lines.length > 0 ? (lines[lines.length - 1].ts - T0) / 1000 : 0
    const endAt = T0 + (Math.max(sc.until, last) + sc.drain) * 1000
    this.endAt = endAt
    let li = 0, ci = 0
    for (let f = 0; ; f++) {
      const now = T0 + f * FRAME
      if (now > endAt) break
      this.frames++
      if (this.core !== null) {
        while (li < lines.length && lines[li].ts + 300 <= now) { this.#route(this.core.ingest(lines[li].line, now), now); li++ }
        this.#route(this.core.tick(now), now)
      }
      while (ci < cmds.length && T0 + cmds[ci].t * 1000 <= now) { this.#route([cmds[ci].cmd], now); ci++ }
      this.planner.tick(now)
      this.#sample(now, f % 8 === 0)
    }
    this.#finish(endAt)
    return this
  }

  #route(cmds: readonly Cmd[], now: number) {
    for (const c of cmds) {
      switch (c.op) {
        case 'spawn': {
          this.names.set(c.key, c.n)
          if (this.planner.state(c.key) !== null) this.#cancel(c.key, now)    // a re-entry while the old body fades
          if (c.slot < 0) { this.v('A1', `${this.who(c.key)} spawned with no free slot`); break }
          const s = SLOT_TILES[c.slot]
          this.#request(c.key, s, s, null, 'appear', now)
          break
        }
        case 'walkTo': {
          const p = LAYOUT.place(c.place)
          this.#request(c.key, null, { x: p.x, y: p.y }, c.place, 'walk', now)
          break
        }
        case 'leave': this.#request(c.key, null, EXIT, null, 'exit', now); break
        case 'fade': this.#cancel(c.key, now); break
        default: break
      }
    }
  }

  #request(key: string, from: Tile | null, goal: Goal, place: PlaceId | null, kind: TripKind, now: number) {
    const before = this.open.get(key)
    let start: number
    if (from !== null) start = from.y * W + from.x
    else {
      const st = this.planner.state(key)
      const boundary = T0 + Math.ceil((now - T0) / STEP_MS - 1e-9) * STEP_MS
      const p = st?.appeared ? this.planner.positionAt(key, boundary) : null
      start = p !== null ? p.y * W + p.x : -1
    }
    const res = this.planner.plan(key, from, goal, now)
    if (res.status === 'refused') { this.v('A1', `${this.who(key)}: plan refused`); return }
    if (before !== undefined && before.closed === null) { before.closed = 'superseded'; this.open.delete(key) }
    const trip: Trip = { key, kind, goal, place, at: now, from: start, done: null, closed: null, still: 0 }
    if (start < 0) this.#unplaced.push(trip)
    this.trips.push(trip)
    this.open.set(key, trip)
  }

  #cancel(key: string, now: number) {
    const t = this.open.get(key)
    if (t !== undefined) { t.closed = 'cancelled'; t.done = now; this.open.delete(key) }
    this.planner.cancel(key)
    const left = this.planner.bookingCount(key)
    if (left !== 0) this.v('A3', `${this.who(key)} was cancelled but still holds ${left} bookings`)
    if (this.planner.positionAt(key, now) !== null) this.v('A3', `${this.who(key)} was cancelled but is still drawn`)
  }

  #sample(now: number, boundary: boolean) {
    const P = this.planner
    const ks = this.#ks, xs = this.#xs, ys = this.#ys
    ks.length = 0; xs.length = 0; ys.length = 0
    for (const key of P.workers()) {
      const p = P.positionAt(key, now, this.#pose)
      if (p === null) continue
      ks.push(key); xs.push(p.x); ys.push(p.y)
      this.#mix(Math.round(p.x * 8)); this.#mix(Math.round(p.y * 8))
      if (p.moving) this.#moving.add(key)
    }
    for (const [key, trip] of this.open) if (!this.#moving.has(key)) trip.still += FRAME
    if (this.#unplaced.length > 0) {
      this.#unplaced = this.#unplaced.filter(t => {
        const p = P.positionAt(t.key, now)
        if (p === null) return t.closed === null
        ;(t as { from: number }).from = Math.round(p.y) * W + Math.round(p.x)
        return false
      })
    }
    this.#moving.clear()
    // A2 spacing
    for (let a = 0; a < ks.length; a++) {
      for (let b = a + 1; b < ks.length; b++) {
        const d = Math.hypot(xs[a] - xs[b], ys[a] - ys[b])
        if (d < this.minGap) this.minGap = d
        if (d < MIN_SPACING) this.v('A2', `${this.who(ks[a])} and ${this.who(ks[b])} ${d.toFixed(3)} apart at +${((now - T0) / 1000).toFixed(3)} s`)
      }
    }
    // A3 at step boundaries: whole tiles, no jumps, no swaps
    if (boundary) {
      const tiles = new Map<string, number>()
      for (let a = 0; a < ks.length; a++) {
        const x = xs[a], y = ys[a]
        if (!Number.isInteger(x) || !Number.isInteger(y) || !(MAP.walkable(x, y) || LAYOUT.seatAt(x, y) !== null)) {
          this.v('A3', `${this.who(ks[a])} at (${x},${y}) on a step boundary`)
          continue
        }
        const tile = y * W + x
        tiles.set(ks[a], tile)
        const prev = this.#prevTiles.get(ks[a])
        if (prev !== undefined && prev !== tile && !LAYOUT.canStep({ x: prev % W, y: (prev / W) | 0 }, { x, y })) {
          this.v('A3', `${this.who(ks[a])} moved (${prev % W},${(prev / W) | 0}) -> (${x},${y}), not one legal grid step (4-neighbour; a seat only from its sitFrom)`)
        }
      }
      for (const [ka, ta] of tiles) {
        const pa = this.#prevTiles.get(ka)
        if (pa === undefined || pa === ta) continue
        for (const [kb, tb] of tiles) {
          if (kb <= ka) continue
          if (this.#prevTiles.get(kb) === ta && tb === pa) this.v('A3', `${this.who(ka)} and ${this.who(kb)} swapped tiles at +${((now - T0) / 1000).toFixed(2)} s`)
        }
      }
      this.#prevTiles = tiles
    }
    // trips that arrived
    for (const [key, trip] of this.open) {
      const st = P.state(key)
      if (st === null || st.pending || st.request === null || st.arriveAt === null || now < st.arriveAt) continue
      if (trip.kind === 'appear' ? !st.appeared : !sameGoal(st.request, trip.goal)) continue
      const at = P.positionAt(key, st.arriveAt)
      const tile = at !== null && Number.isInteger(at.x) && Number.isInteger(at.y) ? at.y * W + at.x : -1
      const ok = trip.goal === EXIT ? EXIT_SET.has(tile) : trip.kind === 'appear' ? SLOT_SET.has(tile) : tile === trip.goal.y * W + trip.goal.x
      if (!ok) this.v('A1', `${this.who(key)} arrived at ${at === null ? 'nothing' : `(${at.x},${at.y})`}, not on its goal`)
      if (trip.place !== null && this.core !== null && this.core.book.holding(key)?.place !== trip.place) {
        this.v('A1', `${this.who(key)} arrived on ${trip.place}, which the book no longer holds for it`)
      }
      trip.done = Math.max(st.arriveAt, trip.at)
      trip.closed = 'done'
      ;(trip as { goal: Goal }).goal = trip.goal === EXIT || trip.kind === 'appear' ? { x: tile % W, y: (tile / W) | 0 } : trip.goal
      this.open.delete(key)
    }
  }

  #finish(endAt: number) {
    for (const t of this.trips) {
      if (t.closed === 'done' && t.done !== null && t.done - t.at > TRIP_LIMIT_MS) this.v('A1', `${this.who(t.key)}'s ${t.kind} trip took ${((t.done - t.at) / 1000).toFixed(1)} s`)
      if (t.closed === null && endAt - t.at > TRIP_LIMIT_MS) this.v('A1', `${this.who(t.key)}'s ${t.kind} trip never ended (requested at +${((t.at - T0) / 1000).toFixed(1)} s)`)
    }
    if (this.planner.stats.conflicts !== 0) this.v('A3', `${this.planner.stats.conflicts} booking conflicts inside the planner`)
    // A4 dispose
    const keys = this.planner.workers()
    this.planner.dispose()
    const after = endAt + 1000
    if (this.planner.bookingCount() !== 0) this.v('A4', `${this.planner.bookingCount()} bookings after dispose()`)
    for (const k of keys) if (this.planner.positionAt(k, after) !== null) this.v('A4', `${this.who(k)} still drawn after dispose()`)
    const s = SLOT_TILES[0]
    const r = this.planner.plan(keys[0] ?? 'late', keys.length > 0 ? null : s, s, after)
    const r2 = this.planner.plan('late-arrival', s, s, after)
    this.planner.tick(after + 1000)
    if (r.status !== 'refused' || r2.status !== 'refused' || this.planner.bookingCount() !== 0 || this.planner.workers().length !== 0) {
      this.v('A4', 'plan() after dispose() was not refused, or booked something')
    }
    if (this.planner.positionAt('late-arrival', after + 1000) !== null) this.v('A4', 'a worker moved after dispose()')
  }

  /** Completed walk / exit trips: delay against straight walking, and the time standing still. */
  metrics() {
    const moves = this.trips.filter(t => t.kind !== 'appear')
    const done = moves.filter(t => t.closed === 'done' && t.done !== null && t.from >= 0)
    const delays = done.map(t => (t.done! - t.at) / 1000 - Math.max(0, straightSteps(t.from, (t.goal as Tile).y * W + (t.goal as Tile).x)) * STEP_MS / 1000).sort((a, b) => a - b)
    const pct = (q: number) => (delays.length === 0 ? 0 : delays[Math.min(delays.length - 1, Math.floor(q * (delays.length - 1) + 1e-9))])
    const appears = this.trips.filter(t => t.kind === 'appear' && t.closed === 'done')
    const stuck = this.trips.filter(t => (t.closed === 'done' && t.done! - t.at > TRIP_LIMIT_MS) || (t.closed === null && this.endAt - t.at > TRIP_LIMIT_MS)).length
    return {
      trips: moves.length, done: done.length, superseded: moves.filter(t => t.closed === 'superseded').length,
      p50: pct(0.5), p90: pct(0.9), max: delays.length ? delays[delays.length - 1] : 0,
      maxWait: Math.max(0, ...moves.map(t => t.still / 1000)),
      maxAppear: Math.max(0, ...appears.map(t => (t.done! - t.at) / 1000)),
      stuck,
    }
  }
}
const sameGoal = (a: Goal, b: Goal) => (a === EXIT || b === EXIT ? a === b : a.x === b.x && a.y === b.y)

// ── the scenarios ────────────────────────────────────────────────────────────────────────────────────────────────
/** S1 door rush (critic 1's S1): 15 workers of one session settled at the records stations leave at once (its
 *  SessionEnd) while 15 new workers of another session arrive at once and go to the file cabinets. */
function s1(): Scenario {
  const out: Line[] = []
  for (let k = 0; k < 15; k++) helper(out, aidOf('b', k), SB, k * 1.2, [[k % 2 === 0 ? 'hist-read' : 'read', 0.5, 1.5]], null)
  out.push(L(60, 'SessionEnd', SB, { r: 'logout' }))
  for (let k = 0; k < 15; k++) helper(out, aidOf('a', k), SA, 60 + k * 0.001, [['read', 3, 0.8 + 0.15 * k]], null)
  return {
    name: 'S1 door rush (15 out, 15 in)', lines: out, until: 75, drain: 70,
    expect: sim => {
      const inDone = sim.trips.filter(t => t.kind === 'walk' && t.at >= T0 + 60_000 && t.closed === 'done' && t.place !== null && LAYOUT.stationOf(t.place) === 'fileCabinet').length
      const outDone = sim.trips.filter(t => t.kind === 'exit' && t.closed === 'done').length
      const bad: string[] = []
      if (inDone !== 15) bad.push(`S1 ${inDone} of 15 arrivals reached their file cabinet`)
      if (outDone !== 15) bad.push(`S1 ${outDone} of 15 leavers reached the exit lane`)
      return { bad, line: `arrivals at their cabinets ${inDone}/15, leavers on the exit lane ${outDone}/15` }
    },
  }
}

/** S3 bursts: 20 helpers start within 20 ms, later 14 more; each works a few steps and finishes. */
function s3(): Scenario {
  const r = rng(3)
  const out: Line[] = []
  const burst = (t: number, n: number, tag: string) => {
    for (let k = 0; k < n; k++) helper(out, aidOf(tag, k), SA, t + k * 0.001, randomSteps(r, 2 + Math.floor(r() * 4), 1 + r() * 5), randomEnd(r), 2 + r() * 8)
  }
  burst(1, 20, 'c')
  burst(70, 14, 'd')
  return {
    name: 'S3 bursts of 20 and 14', lines: out, until: 140, drain: 90,
    expect: sim => {
      const exits = sim.trips.filter(t => t.kind === 'exit' && t.closed === 'done').length
      return { bad: exits === 34 ? [] : [`S3 ${exits} of 34 helpers left by the exit lane`], line: `left by the exit lane ${exits}/34` }
    },
  }
}

/** S6 desk rush (critic 1's S6): 6 workers settled at the records stations hand in a result form at once (2 desk
 *  spots, 2 queue tiles, the rest wait at their own stations), wait for their stop, and leave. */
function s6(): Scenario {
  const out: Line[] = []
  for (let k = 0; k < 6; k++) {
    const aid = aidOf('e', k)
    helper(out, aid, SA, k * 1.0, [[k % 2 === 0 ? 'read' : 'hist-read', 0.5, 1.5]], null)
    out.push(L(40 + k * 0.001, 'PreToolUse', SA, { aid, k: 'frontDesk', a: 'form', tu: `${aid}.f` }), L(40.5 + k * 0.001, 'PostToolBatch', SA, { aid, n: 1 }))
    out.push(L(44 + k * 0.7, 'SubagentStop', SA, { aid, at: 'workflow-subagent', bt: [] }))
  }
  return {
    name: 'S6 desk rush (6 result forms at once)', lines: out, until: 60, drain: 80,
    expect: sim => {
      const deskTrips = sim.trips.filter(t => t.kind === 'walk' && t.place !== null && LAYOUT.stationOf(t.place) === 'frontDesk')
      const sent = new Set(deskTrips.map(t => t.key)).size
      const desk = new Set(deskTrips.filter(t => t.closed === 'done').map(t => t.key)).size
      const exits = sim.trips.filter(t => t.kind === 'exit' && t.closed === 'done').length
      const lastExit = Math.max(0, ...sim.trips.filter(t => t.kind === 'exit' && t.done !== null).map(t => (t.done! - T0) / 1000 - 40))
      return {
        bad: sent === 6 && exits === 6 ? [] : [`S6 sent to a desk spot ${sent}/6, left ${exits}/6`],
        line: `sent to a desk spot ${sent}/6, stood on it ${desk}/6 (the others were sent on by the observer's own hand-in timer first: an integration finding), left ${exits}/6, the last one on the exit lane ${lastExit.toFixed(1)} s after the rush`,
      }
    },
  }
}

const placeAt = (x: number, y: number): PlaceId => {
  const p = LAYOUT.placeAt(x, y)
  if (p === null) throw new Error(`no place at (${x},${y})`)
  return p.id
}
const spawnCmd = (t: number, key: string, n: number, slot: number): Scripted => ({ t, cmd: { op: 'spawn', t: T0 + t * 1000, key, n, seed: n, slot, back: false } })
const walkCmd = (t: number, key: string, place: PlaceId): Scripted => ({ t, cmd: { op: 'walkTo', t: T0 + t * 1000, key, place } })
const fadeCmd = (t: number, key: string): Scripted => ({ t, cmd: { op: 'fade', t: T0 + t * 1000, key, reason: 'officeCleared' } })

/** R keep-old-path (§4.7's mandatory rule): A, mid-walk to a file cabinet, is sent to a bench point D still stands
 *  on, so its re-plan fails and it must keep its old path and bookings; the cabinet it was heading for is at once
 *  given to C (the book freed it), whose plan must then wait for A. D leaves later; A and C get there. */
function scenarioR(): Scenario {
  const Q = LAYOUT.stations.get('benchTerminal')!.points[0], Q2 = LAYOUT.stations.get('benchTerminal')!.points[1]
  const G1 = placeAt(10, 2), H1 = placeAt(19, 17)
  return {
    name: 'R keep-old-path (retarget into an occupied place)', until: 30, drain: 70,
    cmds: [
      spawnCmd(0, 'D', 1, 0), walkCmd(0, 'D', Q),
      spawnCmd(1, 'C', 2, 1), walkCmd(1, 'C', H1),
      spawnCmd(12, 'A', 3, 2), walkCmd(12, 'A', G1),
      walkCmd(14.5, 'A', Q), walkCmd(14.5, 'C', G1),
      walkCmd(22, 'D', Q2),
    ],
    expect: sim => {
      const s = sim.planner.stats
      const staged = s.midWalk >= 1 && s.failed >= 2
      return { bad: staged ? [] : [`R the retarget did not fail as staged (mid-walk ${s.midWalk}, failed attempts ${s.failed})`], line: `staged: a mid-walk retarget that fails, then waits: ${staged ? 'yes' : 'NO'}` }
    },
  }
}

/** C cancel: A stands on a lectern point and is cancelled (a fade); B is then sent to the same point and must get
 *  there (the table forgot A). */
function scenarioC(): Scenario {
  const P = placeAt(12, 5)
  return {
    name: 'C cancel frees the table', until: 20, drain: 65,
    cmds: [spawnCmd(0, 'A', 1, 0), walkCmd(0, 'A', P), fadeCmd(10, 'A'), spawnCmd(11, 'B', 2, 1), walkCmd(11, 'B', P)],
  }
}

/** A seeded 300 s day (critic 1's fuzz days): 6 bursts of 1-8 helpers and one burst of 14, each working through
 *  the measured step mix with short and long gaps, then handing back, handing in a form, or signing out. */
function day(seed: number): Scenario {
  const r = rng(seed)
  const out: Line[] = []
  const bursts: [number, number][] = []
  for (let k = 0; k < 6; k++) bursts.push([r() * 240, 1 + Math.floor(r() * 8)])
  bursts.push([20 + r() * 200, 14])
  let n = 0
  for (const [t, size] of bursts) {
    for (let k = 0; k < size; k++) {
      const steps = randomSteps(r, 2 + Math.floor(r() * 14), 1 + r() * 5)
      let end: number = t + k * 0.001
      for (const [, dur, gap] of steps) end += dur + gap
      const fits = steps.filter((_, i) => t + k * 0.001 + steps.slice(0, i + 1).reduce((s, [, d, g]) => s + d + g, 0) < 300)
      helper(out, aidOf(`s${seed}x`, n++), SA, t + k * 0.001, fits, end < 295 ? randomEnd(r) : null, 2 + r() * 10)
    }
  }
  return { name: `day seed ${seed}`, lines: out, until: 300, drain: 90 }
}

// ── running ──────────────────────────────────────────────────────────────────────────────────────────────────────
function runOnce(mod: PlannerMod, sc: Scenario): { sim: Sim; bad: string[]; line: string | null } {
  const sim = new Sim(mod, sc.lines !== undefined)
  try {
    sim.run(sc)
  } catch (e) {
    return { sim, bad: [`crash ${String(e).split('\n')[0]}`], line: null }
  }
  const extra = sc.expect?.(sim)
  return { sim, bad: [...sim.bad, ...(extra?.bad ?? [])], line: extra?.line ?? null }
}

function report(sc: Scenario, sim: Sim) {
  const m = sim.metrics()
  const s = sim.planner.stats
  console.log(`  ${sc.name}`)
  console.log(`    trips ${m.done}/${m.trips} (${m.superseded} superseded), mid-walk retargets ${s.midWalk}, failed plan attempts ${s.failed}, ` +
    `max wait ${m.maxWait.toFixed(1)} s, delay vs straight walking p50 ${m.p50.toFixed(2)} / p90 ${m.p90.toFixed(2)} / max ${m.max.toFixed(1)} s, ` +
    `stuck ${m.stuck}; min spacing ${sim.minGap === Infinity ? '-' : sim.minGap.toFixed(3)}, slowest appearance ${m.maxAppear.toFixed(2)} s, ` +
    `slots swapped ${s.slotSwapped}, largest search ${s.expandedMax} states`)
}

const scenarios: Scenario[] = [s1(), s3(), s6(), scenarioR(), scenarioC()]
const tuningDays = TUNING_SEEDS.map(day)
const heldOutDays = TUNING_ONLY ? [] : HELD_OUT_SEEDS.map(day)

console.log(`worker office traffic check: planner STEP ${STEP_MS} ms, frames every ${FRAME} ms, trip limit ${TRIP_LIMIT_MS / 1000} s, spacing >= ${MIN_SPACING}`)
for (const [label, list] of [['scenarios', scenarios], ['days (tuning seeds)', tuningDays], ['days (held-out seeds)', heldOutDays]] as const) {
  if (list.length === 0) { console.log(`${label}: skipped (--tuning-only)`); continue }
  console.log(`${label}:`)
  for (const sc of list) {
    const a = runOnce(realPlanner, sc)
    report(sc, a.sim)
    if (a.line !== null) console.log(`    ${a.line}`)
    if (TRACE !== null && sc.name.startsWith(TRACE)) {
      for (const t of a.sim.trips) {
        const g = t.goal === EXIT ? 'EXIT' : `(${t.goal.x},${t.goal.y})`
        console.log(`      ${a.sim.who(t.key)} ${t.kind} ${t.place ?? g} at +${((t.at - T0) / 1000).toFixed(2)} ${t.closed ?? 'open'}${t.done !== null ? ` +${((t.done - T0) / 1000).toFixed(2)}` : ''} still ${(t.still / 1000).toFixed(2)}`)
      }
    }
    for (const b of a.bad) fail(`${sc.name}: ${b}`)
    const b2 = runOnce(realPlanner, sc)
    if (a.sim.digest !== b2.sim.digest) fail(`${sc.name}: A5 two runs of the same input differ (${a.sim.digest} vs ${b2.sim.digest})`)
  }
}

// ── mutants ──────────────────────────────────────────────────────────────────────────────────────────────────────
interface Mutant { readonly id: string; readonly from: string; readonly to: string }
const MUTANTS: readonly Mutant[] = [
  { id: 'M1 keep-old-path removed', from: '      this.#rebookFrom(b, s0)   // keep-old-path (§4.7): the old bookings stand and the old path is walked\n', to: '' },
  { id: 'M2 a swap allowed', from: '        if (o !== undefined && o !== me && this.#res.get(t1 * N + i) === o) continue\n', to: '' },
  { id: 'M3 the spacing check one step off', from: '        if (!this.#free(j, t1, me)) continue\n', to: '        if (!this.#free(j, t, me)) continue\n' },
  { id: 'M4 cancel leaves the bookings', from: '    this.#unbookAll(b)   // cancel: the table forgets every booking of this worker\n', to: '' },
]
if (NO_MUTANTS) console.log('mutants: skipped (--no-mutants)')
else {
  console.log('mutants (each must make a check fail; run on the scenarios and the tuning days):')
  const dir = mkdtempSync(join(tmpdir(), 'wo-planner-mutant-'))
  const src = readFileSync(PLANNER_PATH, 'utf8').replace(/\r\n/g, '\n')
  let caught = 0
  for (const [i, m] of MUTANTS.entries()) {
    const n = src.split(m.from).length - 1
    if (n !== 1) { fail(`${m.id}: the patch applies ${n} times`); continue }
    const file = join(dir, `planner-mutant-${i}.ts`)
    writeFileSync(file, src.replace(m.from, () => m.to))
    const mod = await import(pathToFileURL(file).href) as PlannerMod
    const hits = new Map<string, number>()
    for (const sc of [...scenarios, ...tuningDays]) {
      for (const b of runOnce(mod, sc).bad) {
        if (b.startsWith('...')) continue
        const tag = b.startsWith('crash') ? 'crash' : b.split(' ')[0]
        const where = `${tag}@${sc.name.split(' ')[0] === 'day' ? sc.name.replace('day seed ', 'd') : sc.name.split(' ')[0]}`
        hits.set(where, (hits.get(where) ?? 0) + 1)
      }
    }
    if (hits.size > 0) caught++
    else fail(`mutant survived: ${m.id}`)
    console.log(`  ${hits.size > 0 ? 'caught  ' : 'SURVIVED'} ${m.id}: ${[...hits].map(([k, v]) => `${k} x${v}`).join(', ') || 'no failed check'}`)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(`mutants caught: ${caught} of ${MUTANTS.length}`)
}

console.log(failures === 0 ? 'ALL PASS' : `FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
