// Worker office movement core and the page's worker lifecycle: the traffic check (plan §6.4 "Movement core (Path A)",
// "Worker lifecycle"; lean scope per the owner's budget, decisions.md 2026-10-01 18:18).
// Run: node scripts/worker-office-traffic-sim.ts [--tuning-only] [--no-mutants]
//   --tuning-only  skip the 4 held-out seeds (they are run only once the planner is final)
//   --no-mutants   skip the mutant runs
//
// The REAL observer core (src/worker-office/core/reducer.ts, with the page's body signals) is fed synthetic spool lines
// (delivered 300 ms after their timestamp, as the page reads them) through the REAL page lifecycle
// (src/worker-office/live/world.ts): its commands drive the planner, the bodies drive the beats, and the bodies report
// back to the core (slotLeft, arrived, blocked: lead rulings 3, 5, 6). The world's own mapping:
//   spawn{slot}   -> plan(w, slotTile, slotTile, now)     (a re-entry while the old body is still here: cancel first)
//   slotted{slot} -> the same, for a worker held off screen
//   walkTo{place} -> plan(w, null, the place's own tile, now), after the beat the plan allows (§4.9 "Page")
//   leave         -> plan(w, null, EXIT, now), after the exit beat
//   fade          -> a fade in place, then cancel(w)
// Two scenarios (R, C) send planner requests from a script instead, to pin the keep-old-path and cancel paths.
// Frames are STEP_MS / 8 = 39.0625 ms apart, on the planner's step grid: every eighth of a step is sampled.
//
// Asserted on every run:
//   A1 every trip ends on its reserved tile within 60 s of its request (a trip = one plan() call with a new goal; a
//      newer call supersedes it). At the arrival the drawn position is exactly the goal tile (an exit trip: an exit-lane
//      tile), and for a place the observer's book still holds that place for the worker. Trips still open at the end of
//      the run count if they are older than 60 s;
//   A2 spacing >= 0.69 tiles between any two drawn workers at every sampled instant;
//   A3 no swaps (two workers exchanging tiles across one step); every move is one legal grid step (layout.canStep:
//      4-neighbour, a seat entered and left only through its sitFrom tile) and a drawn worker stands on a whole
//      walkable tile or seat at every step boundary; no booking conflict inside the
//      planner (stats.conflicts = 0); a cancelled worker holds no booking;
//   A4 after dispose(): no booking, positionAt null for every worker, plan() refused and books nothing, tick() moves
//      nothing; the world holds no worker and the core no booking;
//   A5 the same input gives the same run (every run twice: positions, trips and stats digested).
// And the four integration rulings (decisions.md 2026-10-01 23:13), on every spool-fed run:
//   W1 (ruling 3) every body appears exactly on the slot its spawn (or 'slotted') named, and the core never names a
//      slot while another body still claims it (the page releases a claim only when its body has left the tile and
//      nobody will cross it);
//   W2 (ruling 4) at a seat the entry beat never moves the body again: from its arrival to the end of the beat the
//      drawn frame stands on the seat tile, seated; and the step onto the seat plus the beat stay within the 1.4 s seat
//      beat × the worker's τ × the largest jitter (1.2);
//   W3 (ruling 5) every finisher's body stood on its front-desk spot for at least the 1.5 s sign (the hand-in's 0.5 s
//      comes on top) before the core sent it out, and every fetch-then-read walk to a reading place starts at least
//      the 1.2 s pull after the body stood on the shelf point;
//   W4 (ruling 6) the mutual-block scenario M resolves through the watchdog (A1 covers it: without the watchdog both
//      trips stay open for good).
// Mutants (each a one-line patch of planner.ts, reducer.ts, world.ts or WorkerSprite.ts, loaded from a temp copy) must
// each make some check fail; the rulings' four are the failing-first evidence (each restores the behaviour the ruling
// replaced).
// Printed per scenario: trips, mid-walk retargets, failed plan attempts, max wait (standing still during a trip),
// delay p50 / p90 / max against straight walking (the shortest walk on the bare grid, nobody else there), stuck trips.
// Exit 0 when everything passes, 1 otherwise.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadMap, type Tile } from '../src/worker-office/map/loadMap.ts'
import { buildPlaceLayout, type PlaceId } from '../src/worker-office/map/places.ts'
import * as realCore from '../src/worker-office/core/reducer.ts'
import type { Cmd } from '../src/worker-office/core/messages.ts'
import * as realPlanner from '../src/worker-office/move/planner.ts'
import { EXIT, MIN_SPACING, STEP_MS, type BodyPose, type Goal } from '../src/worker-office/move/planner.ts'
import * as realWorld from '../src/worker-office/live/world.ts'
import * as realSprite from '../src/worker-office/render/WorkerSprite.ts'
import * as realObjects from '../src/worker-office/live/objects.ts'
import * as realFeed from '../src/worker-office/live/liveFeed.ts'
import { HAND } from '../src/worker-office/render/props.ts'
import { ExamplePlayer } from '../src/worker-office/live/example.ts'

type PlannerMod = typeof realPlanner
type Planner = InstanceType<PlannerMod['PathPlanner']>
type CoreMod = typeof realCore
type WorldMod = typeof realWorld
type SpriteMod = typeof realSprite
type ObjectsMod = typeof realObjects
type World = InstanceType<WorldMod['WorkerWorld']>
/** The modules a run uses: the real ones, or one of them patched (a mutant). */
interface Mods { readonly planner: PlannerMod; readonly core: CoreMod; readonly world: WorldMod; readonly sprite: SpriteMod; readonly objects: ObjectsMod; readonly feed: typeof realFeed }
const REAL: Mods = { planner: realPlanner, core: realCore, world: realWorld, sprite: realSprite, objects: realObjects, feed: realFeed }

const args = process.argv.slice(2)
const TUNING_ONLY = args.includes('--tuning-only')
const NO_MUTANTS = args.includes('--no-mutants')
/** --objects-only: only the object-state section (plan §4.4) and its mutants; --snap-only: only the snap section. */
const SNAP_ONLY = args.includes('--snap-only')
const OBJECTS_ONLY = args.includes('--objects-only') || SNAP_ONLY
/** --trace <prefix>: print every trip of the scenarios whose name starts with it (for debugging). */
const TRACE = args.includes('--trace') ? args[args.indexOf('--trace') + 1] : null

const MAP = loadMap(JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8')))
const LAYOUT = buildPlaceLayout(MAP)
const W = MAP.width
const FRAME = STEP_MS / 8
const TRIP_LIMIT_MS = 60_000
const SLOT_TILES: readonly Tile[] = [...MAP.arrivalSlots, ...MAP.arrivalSlotsOverflow]
const EXIT_SET: ReadonlySet<number> = new Set(MAP.exitLane.map(t => t.y * W + t.x))
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

/** The fetch-then-read shelves: a walk from one of their points to a reading place ends a pull (ruling 5). */
const FETCH_SHELVES: ReadonlySet<string> = new Set(['historyShelf', 'bookshelf', 'cardCatalog', 'manualsShelf'])
const PULL_MS = 1200, SIGN_MS = 1500

class Sim {
  readonly mods: Mods
  readonly planner: Planner
  readonly world: World | null
  readonly trips: Trip[] = []
  readonly open = new Map<string, Trip>()
  readonly bad: string[] = []
  readonly names = new Map<string, number>()
  minGap = Infinity
  frames = 0
  endAt = 0
  /** W1: slot claims as the page holds them, the slot tile each new body was named, appearance waits (ms). */
  readonly #claims = new Map<number, string>()
  readonly #named = new Map<string, { tile: Tile; at: number }>()
  readonly appearWaits: number[] = []
  /** W2: seat entries in progress (until the beat ends or the worker moves on), and how many were checked. */
  readonly #seats = new Map<string, { tile: Tile; until: number }>()
  seatEntries = 0
  /** W3: per worker, its last arrival report at a front-desk spot and at a shelf point, and its last target. */
  readonly #desk = new Map<string, number>()
  readonly #shelf = new Map<string, { place: PlaceId; at: number }>()
  readonly #lastTarget = new Map<string, PlaceId>()
  deskLeaves = 0
  pullWalks = 0
  blockedReports = 0
  #digest = 0x811c9dc5
  #prevTiles = new Map<string, number>()
  #pose: BodyPose = { x: 0, y: 0, moving: false, facing: 'W', walked: 0 }
  #view: ReturnType<SpriteMod['newView']>
  #xs: number[] = []
  #ys: number[] = []
  #ks: string[] = []
  #moving = new Set<string>()
  /** Trips requested before their worker was on the grid: their start is where it appears. */
  #unplaced: Trip[] = []

  constructor(mods: Mods, withCore: boolean, worldOpts: { pendingLimitMs?: number } = {}) {
    this.mods = mods
    this.#view = mods.sprite.newView()
    this.planner = new mods.planner.PathPlanner(LAYOUT)
    this.world = withCore
      ? new mods.world.WorkerWorld(LAYOUT, new mods.core.ObserverCore(LAYOUT, { bodySignals: true }), this.planner, { ...worldOpts, trace: this.#trace() })
      : null
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
  get core() { return this.world?.core ?? null }

  /** The page's trace: trips from its plan calls, and the W1-W3 checks from its commands and body signals. */
  #trace(): realWorld.WorldTrace {
    return {
      plan: (key, goal, now) => {
        if (goal.kind === 'exit') this.#request(key, null, EXIT, null, 'exit', now)
        else if (goal.kind === 'slot') { const t = SLOT_TILES[goal.slot]; this.#request(key, this.planner.state(key) === null ? t : null, t, null, 'appear', now) }
        else { const p = LAYOUT.place(goal.place); this.#request(key, null, { x: p.x, y: p.y }, goal.place, 'walk', now) }
      },
      cancel: (key, now) => this.#cancelled(key, now),
      command: (c, now) => this.#command(c, now),
      slotLeft: (key, slot) => { if (this.#claims.get(slot) === key) this.#claims.delete(slot) },
      arrived: (key, place, now) => {
        const station = LAYOUT.stationOf(place)
        if (station === 'frontDesk') this.#desk.set(key, now)
        if (station !== null && FETCH_SHELVES.has(station)) this.#shelf.set(key, { place, at: now })
      },
      entry: (key, place, seat, until, now, beat) => {
        if (!seat) return
        const p = LAYOUT.place(place), w = this.world!.workers.get(key)!
        this.seatEntries++
        this.#seats.set(key, { tile: { x: p.x, y: p.y }, until })
        // the seat beat (1.4 s × τ × a jitter of 0.8-1.2, or the fast 0.3 s) includes the planner's step onto the seat:
        // after the arrival only the rest of it is left (at least 0.15 s of sitting down)
        const B = realWorld.BEAT
        const inRange = beat === B.entryFast || (beat >= B.entrySeat * w.tau * 0.8 - 1 && beat <= B.entrySeat * w.tau * 1.2 + 1)
        if (!inRange || Math.abs(until - now - Math.max(B.entrySeatMin, beat - STEP_MS)) > 0.01) {
          this.v('W2', `${this.who(key)}'s seat entry at ${place}: beat ${beat.toFixed(0)} ms (τ ${w.tau.toFixed(2)}), ${(until - now).toFixed(0)} ms after the arrival: the step onto the seat (${STEP_MS} ms) must be part of the beat`)
        }
      },
      blocked: () => { this.blockedReports++ },
    }
  }

  #command(c: Cmd, now: number) {
    switch (c.op) {
      case 'spawn': case 'slotted': {
        if (c.op === 'spawn') { this.names.set(c.key, c.n); this.#desk.delete(c.key); this.#shelf.delete(c.key); this.#lastTarget.delete(c.key) }
        if (c.slot < 0) break
        const holder = this.#claims.get(c.slot)
        if (holder !== undefined && holder !== c.key) this.v('W1', `slot ${c.slot} named for ${this.who(c.key)} while ${this.who(holder)}'s body still claims it`)
        this.#claims.set(c.slot, c.key)
        this.#named.set(c.key, { tile: SLOT_TILES[c.slot], at: now })
        break
      }
      case 'walkTo': {
        const prev = this.#lastTarget.get(c.key)
        this.#lastTarget.set(c.key, c.place)
        if (prev === undefined || LAYOUT.readingRoomOf(c.place) === null) break
        const st = LAYOUT.stationOf(prev)
        if (st === null || !FETCH_SHELVES.has(st)) break
        // a pull's end: the book now has the worker reading what it pulled from that shelf point (a reading place is
        // also an overflow wait tile for other stations)
        const h = this.core?.book.holding(c.key)
        if (h === undefined || h === null || h.role !== 'read' || h.pulledFrom !== prev) break
        this.pullWalks++
        const s = this.#shelf.get(c.key)
        if (s === undefined || s.place !== prev || now - s.at < PULL_MS - 1) {
          this.v('W3', `${this.who(c.key)} sent from ${prev} to the reading place ${c.place} ${s === undefined || s.place !== prev ? 'before its body ever stood on the shelf point' : `${(now - s.at).toFixed(0)} ms after its body reached the shelf (the pull is ${PULL_MS} ms)`}`)
        }
        break
      }
      case 'leave': {
        this.#named.delete(c.key)
        if (c.reason !== 'finished') break
        this.deskLeaves++
        const d = this.#desk.get(c.key)
        if (d === undefined || now - d < SIGN_MS - 1) {
          this.v('W3', `${this.who(c.key)} sent out finished ${d === undefined ? 'before its body ever stood on a front-desk spot' : `${(now - d).toFixed(0)} ms after its body reached the desk (the sign alone is ${SIGN_MS} ms)`}`)
        }
        break
      }
      case 'fade': this.#named.delete(c.key); break
      default: break
    }
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
      if (this.world !== null) {
        while (li < lines.length && lines[li].ts + 300 <= now) { this.world.ingest(lines[li].line, now); li++ }
        this.world.step(now)
      } else {
        while (ci < cmds.length && T0 + cmds[ci].t * 1000 <= now) { this.#route([cmds[ci].cmd], now); ci++ }
        this.planner.tick(now)
      }
      this.#sample(now, f % 8 === 0)
    }
    this.#finish(endAt)
    return this
  }

  /** The scripted scenarios' commands, straight to the planner (no page beats). */
  #route(cmds: readonly Cmd[], now: number) {
    for (const c of cmds) {
      switch (c.op) {
        case 'spawn': {
          this.names.set(c.key, c.n)
          if (this.planner.state(c.key) !== null) { this.planner.cancel(c.key); this.#cancelled(c.key, now) }
          const s = SLOT_TILES[c.slot]
          this.#request(c.key, s, s, null, 'appear', now)
          this.planner.plan(c.key, s, s, now)
          break
        }
        case 'walkTo': {
          const p = LAYOUT.place(c.place)
          this.#request(c.key, null, { x: p.x, y: p.y }, c.place, 'walk', now)
          this.planner.plan(c.key, null, { x: p.x, y: p.y }, now)
          break
        }
        case 'fade': this.planner.cancel(c.key); this.#cancelled(c.key, now); break
        default: break
      }
    }
  }

  /** A trip starts: the newest request of a worker supersedes its open trip. */
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
    if (before !== undefined && before.closed === null) { before.closed = 'superseded'; this.open.delete(key) }
    const trip: Trip = { key, kind, goal, place, at: now, from: start, done: null, closed: null, still: 0 }
    if (start < 0) this.#unplaced.push(trip)
    this.trips.push(trip)
    this.open.set(key, trip)
  }

  #cancelled(key: string, now: number) {
    const t = this.open.get(key)
    if (t !== undefined) { t.closed = 'cancelled'; t.done = now; this.open.delete(key) }
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
      // W1: the first sight of a new body is on the slot its spawn named
      const named = this.#named.get(key)
      if (named !== undefined) {
        this.#named.delete(key)
        this.appearWaits.push(now - named.at)
        if (Math.round(p.x) !== named.tile.x || Math.round(p.y) !== named.tile.y) this.v('W1', `${this.who(key)} appeared at (${p.x.toFixed(2)},${p.y.toFixed(2)}), not on its named slot (${named.tile.x},${named.tile.y})`)
      }
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
    // W2: a seat entry in progress shows the seated frame on the seat tile, never a step
    for (const [key, e] of this.#seats) {
      const w = this.world?.workers.get(key)
      if (w === undefined || w.phase !== 'entry' || now > e.until) { this.#seats.delete(key); continue }
      const v = this.mods.sprite.spriteView(w, now, this.#view)
      if (!v.visible || v.x !== e.tile.x * 16 || v.y !== e.tile.y * 16 - 6 || !HAND[v.pose].seated) {
        this.v('W2', `${this.who(key)}'s seat entry at (${e.tile.x},${e.tile.y}) draws ${v.pose} at texel (${v.x},${v.y}), ${((now - T0) / 1000).toFixed(3)} s: the frame must stay seated on the seat tile (${e.tile.x * 16},${e.tile.y * 16 - 6})`)
        this.#seats.delete(key)
      }
    }
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
      const ok = trip.goal === EXIT ? EXIT_SET.has(tile) : tile === trip.goal.y * W + trip.goal.x
      if (!ok) this.v(trip.kind === 'appear' ? 'W1' : 'A1', `${this.who(key)} ${trip.kind === 'appear' ? 'appeared' : 'arrived'} at ${at === null ? 'nothing' : `(${at.x},${at.y})`}, not on its ${trip.kind === 'appear' ? 'named slot' : 'goal'}`)
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
    // A4 dispose: the world (its core, its planner, its workers) or the planner alone
    const keys = this.planner.workers()
    if (this.world !== null) {
      const core = this.world.core
      this.world.dispose()
      if (this.world.workers.size !== 0 || core.book.holdings().length !== 0 || core.book.waiters().length !== 0) this.v('A4', 'the world keeps workers, or the core bookings, after dispose()')
    }
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
    const stuck = this.trips.filter(t => (t.closed === 'done' && t.done! - t.at > TRIP_LIMIT_MS) || (t.closed === null && this.endAt - t.at > TRIP_LIMIT_MS)).length
    return {
      trips: moves.length, done: done.length, superseded: moves.filter(t => t.closed === 'superseded').length,
      p50: pct(0.5), p90: pct(0.9), max: delays.length ? delays[delays.length - 1] : 0,
      maxWait: Math.max(0, ...moves.map(t => t.still / 1000)),
      maxAppear: Math.max(0, ...this.appearWaits) / 1000,
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
        bad: sent === 6 && exits === 6 && desk === 6 ? [] : [`W3 S6 sent to a desk spot ${sent}/6, stood on it ${desk}/6, left ${exits}/6`],
        line: `sent to a desk spot ${sent}/6, stood on it ${desk}/6 (ruling 5: the hand-in starts when the body is there), left ${exits}/6, the last one on the exit lane ${lastExit.toFixed(1)} s after the rush`,
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

/** M mutual block (ruling 6): A settles at the copier (its only point), B at the shredder (its only point). Then, within
 *  one beat, A is sent to read (the copier frees), B to the copier (the shredder frees) and A to the shredder: each
 *  body now stands on the place the other was sent to, so both plans stay pending (keep-old-path) for good. The
 *  watchdog reports them; the core re-books B on the copier's sibling, the printer, and both get where they are sent.
 *  Nothing else gives them a new target until 100 s, so without the watchdog A1 fails (trips open over 60 s). */
function scenarioM(): Scenario {
  const out: Line[] = []
  const A = aidOf('m', 1), B = aidOf('m', 2)
  out.push(L(0, 'SubagentStart', SA, { aid: A, at: 'workflow-subagent' }), L(0.2, 'SubagentStart', SA, { aid: B, at: 'workflow-subagent' }))
  out.push(L(2, 'PreToolUse', SA, { aid: A, k: 'copier', a: 'copy', tu: 'm1' }), L(2.5, 'PostToolBatch', SA, { aid: A, n: 1 }))
  out.push(L(2.2, 'PreToolUse', SA, { aid: B, k: 'shredder', a: 'delete', tu: 'm2' }), L(2.7, 'PostToolBatch', SA, { aid: B, n: 1 }))
  out.push(L(20, 'PreToolUse', SA, { aid: A, k: 'fileCabinet', a: 'read', tu: 'm3' }), L(20.05, 'PostToolBatch', SA, { aid: A, n: 1 }))
  out.push(L(20.1, 'PreToolUse', SA, { aid: B, k: 'copier', a: 'copy', tu: 'm4' }))
  out.push(L(20.2, 'PreToolUse', SA, { aid: A, k: 'shredder', a: 'delete', tu: 'm5' }))
  out.push(L(100, 'PostToolBatch', SA, { aid: A, n: 1 }), L(100.2, 'PostToolBatch', SA, { aid: B, n: 1 }))
  out.push(L(101, 'SubagentStop', SA, { aid: A, at: 'workflow-subagent', bt: [] }), L(101.5, 'SubagentStop', SA, { aid: B, at: 'workflow-subagent', bt: [] }))
  return {
    name: 'M mutual block (each body on the other\'s place)', lines: out, until: 102, drain: 40,
    expect: sim => {
      const st = sim.core?.stats
      const relocated = st?.relocated ?? 0
      return {
        bad: relocated >= 1 && sim.blockedReports >= 1 ? [] : [`W4 the watchdog re-booked ${relocated} (reports ${sim.blockedReports})`],
        line: `watchdog reports ${sim.blockedReports}, re-bookings ${relocated}, no other place free ${st?.blockedStay ?? 0}`,
      }
    },
  }
}

// ── running ──────────────────────────────────────────────────────────────────────────────────────────────────────
function runOnce(mods: Mods, sc: Scenario): { sim: Sim; bad: string[]; line: string | null } {
  let sim: Sim
  try { sim = new Sim(mods, sc.lines !== undefined) } catch (e) { return { sim: null as unknown as Sim, bad: [`crash ${String(e).split('\n')[0]}`], line: null } }
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
    `largest search ${s.expandedMax} states`)
  if (sim.world !== null) {
    const st = sim.world.core.stats
    console.log(`    page: appearances on their named slot ${sim.appearWaits.length}, slots released ${st.slotsLeft}, held off screen ${st.slotted}; ` +
      `arrival reports ${st.arrivals}; seat entries ${sim.seatEntries}; finished exits checked ${sim.deskLeaves}, pull walks checked ${sim.pullWalks}; ` +
      `watchdog reports ${sim.blockedReports} (re-booked ${st.relocated})`)
  }
}

const scenarios: Scenario[] = [s1(), s3(), s6(), scenarioM(), scenarioR(), scenarioC()]
const tuningDays = TUNING_SEEDS.map(day)
const heldOutDays = TUNING_ONLY ? [] : HELD_OUT_SEEDS.map(day)

console.log(`worker office traffic check: planner STEP ${STEP_MS} ms, frames every ${FRAME} ms, trip limit ${TRIP_LIMIT_MS / 1000} s, spacing >= ${MIN_SPACING}; the page's world with body signals, watchdog ${realWorld.PENDING_LIMIT_MS / 1000} s`)
for (const [label, list] of (OBJECTS_ONLY ? [] : [['scenarios', scenarios], ['days (tuning seeds)', tuningDays], ['days (held-out seeds)', heldOutDays]] as const)) {
  if (list.length === 0) { console.log(`${label}: skipped (--tuning-only)`); continue }
  console.log(`${label}:`)
  for (const sc of list) {
    const a = runOnce(REAL, sc)
    if (a.sim) report(sc, a.sim)
    if (a.line !== null) console.log(`    ${a.line}`)
    if (TRACE !== null && sc.name.startsWith(TRACE) && a.sim) {
      for (const t of a.sim.trips) {
        const g = t.goal === EXIT ? 'EXIT' : `(${t.goal.x},${t.goal.y})`
        console.log(`      ${a.sim.who(t.key)} ${t.kind} ${t.place ?? g} at +${((t.at - T0) / 1000).toFixed(2)} ${t.closed ?? 'open'}${t.done !== null ? ` +${((t.done - T0) / 1000).toFixed(2)}` : ''} still ${(t.still / 1000).toFixed(2)}`)
      }
    }
    for (const b of a.bad) fail(`${sc.name}: ${b}`)
    const b2 = runOnce(REAL, sc)
    if (a.sim && b2.sim && a.sim.digest !== b2.sim.digest) fail(`${sc.name}: A5 two runs of the same input differ (${a.sim.digest} vs ${b2.sim.digest})`)
  }
}

// ── object states (plan §4.4 "Per-object action scripts", "State keys"; live/objects.ts) ────────────────────────────
// One helper (two or three for the reading places) goes through the REAL core and world; every frame the object states
// are derived as the engine derives them. The expectations below are written from §4.4's TEXT, not from the module:
// for each action, what its object shows at entry, in the call, between calls (stage 1, stage 2), and that it is back
// at rest once the worker has walked off (a far call takes it away; then it stops and leaves). The windows are read from
// the subject's own state: at the point (its body on the place it was sent to), in the call, and so on. Each check
// must see its window at least once, and every check is shown able to fail by a mutant below (OBJECT_MUTANTS).
//   O0  no point state without its holder's body on that point; no carried gap unless its carrier's hands show the
//       volume it pulled (also over the whole EXAMPLE);
//   O20 everything back at rest at the end: no layer, and no carried slot still remembered;
//   O1-O21 the actions (the table in objectCases).
type ObjectsInst = InstanceType<ObjectsMod['ObjectStates']>
type Win = 'entry' | 'unit' | 'stage1' | 'stage2' | 'exit' | 'gone' | 'post' | 'read' | 'readStage2' | 'pullAt' | 'board' | 'boardAfter' | 'desk'
interface Expect { readonly allow?: readonly (string | null)[]; readonly need?: readonly (string | null)[] }
interface ObjCase {
  readonly id: string
  readonly what: string
  readonly lines: readonly Line[]
  /** The worker observed (its ordinal); default #1. */
  readonly subject?: number
  /** The object kind whose point the subject uses. */
  readonly kind: string
  /** Which tile is read: the point's own tile (a carried case: the shelf's), or the front desk's fixed W / E tile. */
  readonly tile?: 'use' | 'W' | 'E'
  /** How a frame's window is read: point (entry, unit, stage1, stage2, exit, gone), carried (pullAt, read, readStage2,
   *  gone), desk (desk, gone), printer (unit, post, gone). Default point. */
  readonly mode?: 'point' | 'carried' | 'desk' | 'printer'
  /** Windows count only from this many seconds after T0 (the call under test), and before `before` s. */
  readonly after?: number
  readonly before?: number
  readonly expect: Partial<Record<Win, Expect>>
  /** Extra per-frame checks (the pose of the phone call, the magnet flip). */
  readonly extra?: (o: ObjObs) => { readonly win: string; readonly value: string | null } | null
  readonly extraExpect?: Readonly<Record<string, Expect>>
}
interface ObjObs {
  readonly t: number
  readonly w: realWorld.WorkerState
  readonly at: realObjects.ObjLayer['place'] | null
  readonly pose: string
  readonly flip: string | null
}

const OBJ_FAR_BENCH = (aid: string, t: number, n: number): Line[] => [
  L(t, 'PreToolUse', SA, { aid, k: 'benchTerminal', a: 'run', tu: `${aid}.far${n}` }), L(t + 1, 'PostToolBatch', SA, { aid, n: 1 }),
]
const OBJ_FAR_CABINET = (aid: string, t: number, n: number): Line[] => [
  L(t, 'PreToolUse', SA, { aid, k: 'fileCabinet', a: 'read', tu: `${aid}.far${n}` }), L(t + 1, 'PostToolBatch', SA, { aid, n: 1 }),
]
/** One helper: Start at `start` s, its calls [activity, kind, Pre s, length s, extra], a far call, a stop. */
function objHelper(aid: string, calls: readonly (readonly [string, string, number, number, Record<string, unknown>?])[], far: number, farTo: 'bench' | 'cabinet', end: number, start = 0.2): Line[] {
  const out: Line[] = [L(start, 'SubagentStart', SA, { aid, at: 'workflow-subagent' })]
  calls.forEach(([a, k, t, len, x], i) => {
    const tu = `${aid}.${i}`
    out.push(L(t, 'PreToolUse', SA, { aid, k, a, tu, ...(x ?? {}) }))
    if (x?.fail === true) out.push(L(t + len - 0.05, 'PostToolUseFailure', SA, { aid, tu, intr: false }))
    out.push(L(t + len, 'PostToolBatch', SA, { aid, n: 1 }))
  })
  out.push(...(farTo === 'bench' ? OBJ_FAR_BENCH(aid, far, 0) : OBJ_FAR_CABINET(aid, far, 0)))
  out.push(L(end, 'SubagentStop', SA, { aid, at: 'workflow-subagent', bt: [] }))
  return out
}

function objectCases(): ObjCase[] {
  const A = aidOf('o', 1), B = aidOf('o', 2), C = aidOf('o', 3)
  const point = (kind: string, act: string, len: number, farTo: 'bench' | 'cabinet' = 'bench') => objHelper(A, [[act, kind, 1, len]], 1 + len + 16, farTo, 1 + len + 30)
  const again = (kind: string, act: string, len: number, x: Record<string, unknown> = {}, farTo: 'bench' | 'cabinet' = 'cabinet') =>
    objHelper(A, [[act === 'watch' || act === 'stop' ? 'run' : act, kind, 1, 1.5], [act, kind, 14, len, x]], 14 + len + 16, farTo, 14 + len + 30)
  const fetch3 = (): Line[] => [
    ...objHelper(A, [['fetch', 'bookshelf', 1, 30]], 50, 'cabinet', 64, 0.2),
    ...objHelper(B, [['fetch', 'bookshelf', 3, 30]], 50, 'cabinet', 64, 0.4),
    ...objHelper(C, [['fetch', 'bookshelf', 5, 26]], 50, 'cabinet', 64, 0.6),
  ]
  const deskEnd = (end: 'form' | 'report' | 'stop'): Line[] => {
    const out: Line[] = [L(0.2, 'SubagentStart', SA, { aid: A, at: 'workflow-subagent' })]
    out.push(L(1, 'PreToolUse', SA, { aid: A, k: 'fileCabinet', a: 'read', tu: 'd0' }), L(3, 'PostToolBatch', SA, { aid: A, n: 1 }))
    if (end === 'form') out.push(L(5, 'PreToolUse', SA, { aid: A, k: 'frontDesk', a: 'form', tu: 'd1' }), L(5.5, 'PostToolBatch', SA, { aid: A, n: 1 }), L(30, 'SubagentStop', SA, { aid: A, at: 'workflow-subagent', bt: [] }))
    if (end === 'report') out.push(L(5, 'PreToolUse', SA, { aid: A, k: 'printer', a: 'report', tu: 'd1' }), L(25, 'PostToolUse', SA, { aid: A, k: 'printer', a: 'report', tu: 'd1' }), L(25.2, 'PostToolBatch', SA, { aid: A, n: 1 }), L(45, 'SubagentStop', SA, { aid: A, at: 'workflow-subagent', bt: [] }))
    if (end === 'stop') out.push(L(8, 'SubagentStop', SA, { aid: A, at: 'workflow-subagent', bt: [] }))
    return out
  }
  const ticket = (): Line[] => [
    L(0.2, 'SubagentStart', SA, { aid: A, at: 'workflow-subagent' }),
    L(1, 'PreToolUse', SA, { aid: A, k: 'frontDesk', a: 'helper-bg', tu: 't1' }),
    L(1.3, 'PostToolUse', SA, { aid: A, k: 'frontDesk', a: 'helper-bg', tu: 't1', st: 'async_launched', ch: aidOf('o', 9) }),
    L(1.4, 'PostToolBatch', SA, { aid: A, n: 1 }),
    ...OBJ_FAR_BENCH(A, 30, 0), L(44, 'SubagentStop', SA, { aid: A, at: 'workflow-subagent', bt: [] }),
  ]
  const hold = (): Line[] => [L(0.2, 'SubagentStart', SA, { aid: A, at: 'workflow-subagent' }), ...OBJ_FAR_BENCH(A, 20, 0), L(34, 'SubagentStop', SA, { aid: A, at: 'workflow-subagent', bt: [] })]
  const none: Expect = { allow: [null], need: [null] }
  return [
    // the file cabinet: §4.4 "the TOP drawer opens"; Read "lift a manila folder"; Grep "flick the tabs"; Glob/list "a glint
    // runs across the folder tops"; stage 1 "readU, holding the folder"; stage 2 "drawer shut"
    { id: 'O1', what: 'file cabinet, read: the drawer opens, the folder is lifted (its gap), held at stage 1, the drawer shut at stage 2', kind: 'fileCabinet', lines: point('fileCabinet', 'read', 12),
      expect: { entry: { allow: ['drawerOpen'] }, unit: { allow: ['folderOut'], need: ['folderOut'] }, stage1: { allow: ['folderOut'], need: ['folderOut'] }, stage2: none, gone: none } },
    { id: 'O2', what: 'file cabinet, search: the tabs flick (leafing)', kind: 'fileCabinet', lines: point('fileCabinet', 'search', 12),
      expect: { unit: { allow: ['leafing'], need: ['leafing'] }, stage1: { allow: ['folderOut'], need: ['folderOut'] }, stage2: none, gone: none } },
    { id: 'O3', what: 'file cabinet, list: a glint across the folder tops (scanning)', kind: 'fileCabinet', lines: point('fileCabinet', 'list', 12),
      expect: { unit: { allow: ['scanning'], need: ['scanning'] }, stage2: none, gone: none } },
    // the lectern: "two ledgers open, lamp on"; "pages turning"; stage 2 "the two ledgers close; the lamp stays on"
    { id: 'O4', what: 'lectern, diff: ledgers open under the lamp, pages turn in the call, closed at stage 2 with the lamp still on', kind: 'lectern', lines: point('lectern', 'diff', 12),
      expect: { entry: { allow: ['compare'] }, unit: { allow: ['turning'], need: ['turning'] }, stage1: { allow: ['compare'], need: ['compare'] }, stage2: { allow: ['lampOn'], need: ['lampOn'] }, gone: none } },
    // the PC desk: "type0/1 ... After 4 s in one call: sitBack watching"; "the monitor stays on (presence)"; §4.5 results
    { id: 'O5', what: 'PC desk, write: the screen on, typing while the hands are on the keys (not after 4 s in one call), the green result line for 2 s, on at stage 2', kind: 'pcDesk', after: 14.3, lines: again('pcDesk', 'write', 10),
      expect: { unit: { allow: ['typing', 'on'], need: ['typing', 'on'] }, stage1: { allow: ['ok', 'on'], need: ['ok', 'on'] }, stage2: { allow: ['on'], need: ['on'] }, gone: none } },
    // the bench: "wake the screen"; "amber lamp blinks while in flight"; §4.5 "green, 2 s" / "red, 2 s"; stage 1 "reading
    // the output"; stage 2 "screen back to ready"; Monitor "blue lamp blinks twice"; TaskStop "red flashes"
    { id: 'O6', what: 'bench, run: running in the call, the green lamp for 2 s, the output kept at stage 1, ready at stage 2', kind: 'benchTerminal', after: 14.3, lines: again('benchTerminal', 'run', 8),
      expect: { unit: { allow: ['running'], need: ['running'] }, stage1: { allow: ['ok', 'output'], need: ['ok', 'output'] }, stage2: { allow: ['ready'], need: ['ready'] }, gone: none } },
    { id: 'O7', what: 'bench, a failed run: the red lamp for 2 s, then the output', kind: 'benchTerminal', after: 14.3, lines: again('benchTerminal', 'run', 8, { fail: true }),
      expect: { unit: { allow: ['running'], need: ['running'] }, stage1: { allow: ['fail', 'output'], need: ['fail', 'output'] }, gone: none } },
    { id: 'O8', what: 'bench, Monitor: the blue lamp blinks (about two blinks), then ready', kind: 'benchTerminal', after: 14.3, lines: again('benchTerminal', 'watch', 6),
      expect: { unit: { allow: ['watching', 'ready'], need: ['watching', 'ready'] }, gone: none } },
    { id: 'O9', what: 'bench, TaskStop: the red lamp flashes, then ready', kind: 'benchTerminal', after: 14.3, lines: again('benchTerminal', 'stop', 6),
      expect: { unit: { allow: ['stopped', 'ready'], need: ['stopped', 'ready'] }, gone: none } },
    // fetch-then-read: "reachU, pull a ledger (1.2 s), then walk to the nearest free records reading place"; carried
    // states "are released only when the carrier's prop is released. So walking to a reading place does not close the gap"
    { id: 'O10', what: 'history shelf, read: the pulled ledger leaves a gap that stays while it is read at a reading place (stage 1 and 2 too) and refills when the worker moves on', kind: 'historyShelf', mode: 'carried', lines: point('historyShelf', 'hist-read', 16),
      expect: { pullAt: { allow: ['ledgerOut'], need: ['ledgerOut'] }, read: { allow: ['ledgerOut'], need: ['ledgerOut'] }, readStage2: { allow: ['ledgerOut'], need: ['ledgerOut'] }, gone: none } },
    { id: 'O11', what: 'bookshelf, fetch: the book\'s gap stays while it is read; the reading ledge shows the papers spread', kind: 'readingLedge', lines: fetch3(),
      expect: { unit: { allow: ['spread'], need: ['spread'] }, stage2: { allow: ['spread'], need: ['spread'] }, gone: none } },
    { id: 'O12', what: 'reading table (the third reader): the lamp on and the book open; at stage 2 the book closed, the lamp on', kind: 'readingTable', subject: 3, lines: fetch3(),
      expect: { unit: { allow: ['openBook'], need: ['openBook'] }, stage2: { allow: ['lampOn'], need: ['lampOn'] }, gone: none } },
    { id: 'O13', what: 'bookshelf gap: kept from the pull through the reading, back when the reader leaves', kind: 'bookshelf', mode: 'carried', lines: fetch3(),
      expect: { pullAt: { allow: ['bookOut'], need: ['bookOut'] }, read: { allow: ['bookOut'], need: ['bookOut'] }, gone: none } },
    // the card catalog: "useU, pull a small drawer"; "flick cards (1.2 s), jot a call slip"; "push the drawer before leaving"
    { id: 'O14', what: 'card catalog, websearch: a drawer out, the cards flip in the call, the drawer pushed in as the worker leaves', kind: 'cardCatalog', lines: point('cardCatalog', 'websearch', 12, 'cabinet'),
      expect: { entry: { allow: ['drawerOut'] }, unit: { allow: ['flipping'], need: ['flipping'] }, exit: { allow: ['drawerOut'], need: ['drawerOut'] }, gone: none } },
    // the printer: "sheets rise from Pre to Post"; "collect and square the pages (0.8 s), carry them"
    { id: 'O15', what: 'printer, hand-back: the sheets rise from the Pre to the Post, then the pages wait in the tray until the worker walks off with them', kind: 'printer', mode: 'printer', lines: deskEnd('report'),
      expect: { unit: { allow: ['printing'], need: ['printing'] }, post: { allow: ['done'], need: ['done'] }, gone: none } },
    // the front desk: "slide the paper into OUT (0.5 s) and sign the book (1.5 s)"; sign-out; "Ticket: drop a slip into IN
    // (0.5 s)"; "AskUserQuestion: lift the handset until the next event"
    { id: 'O16', what: 'front desk, result form: the paper slides into OUT (the E half)', kind: 'frontDesk', tile: 'E', mode: 'desk', lines: deskEnd('form'),
      expect: { desk: { allow: ['handIn', null], need: ['handIn'] }, gone: none } },
    { id: 'O16b', what: 'front desk, result form: then the book is signed (the W half)', kind: 'frontDesk', tile: 'W', mode: 'desk', lines: deskEnd('form'),
      expect: { desk: { allow: ['signing', null], need: ['signing'] }, gone: none } },
    { id: 'O17', what: 'front desk, sign-out (a stop without a hand-in): the book is signed (the W half)', kind: 'frontDesk', tile: 'W', mode: 'desk', lines: deskEnd('stop'),
      expect: { desk: { allow: ['signing', null], need: ['signing'] } } },
    { id: 'O18', what: 'front desk, a background helper\'s ticket: the slip drops into IN (E half) for 0.5 s when the launcher gets there', kind: 'frontDesk', tile: 'E', mode: 'desk', lines: ticket(),
      expect: { desk: { allow: ['ticket', null], need: ['ticket', null] }, gone: none } },
    { id: 'O19', what: 'front desk, AskUserQuestion: the handset frame (phoneU) and the empty cradle (W tile) in the call; the handset back and the cradle full after it', kind: 'frontDesk', tile: 'W', before: 45, lines: objHelper(A, [['ask', 'frontDesk', 1, 16]], 33, 'bench', 47),
      expect: { unit: { allow: ['onPhone'], need: ['onPhone'] }, stage1: none, gone: none },
      extra: o => (o.at === null || o.w.phase !== 'settled' ? null : { win: o.w.inCall ? 'callPose' : o.t >= o.w.unitUntil ? 'afterPose' : 'between', value: o.pose }),
      extraExpect: { callPose: { allow: ['phoneU'], need: ['phoneU'] }, afterPose: { allow: ['standU', 'ponderD', 'armsD'], need: ['standU'] } } },
    // the in/out board: "flip its own magnet (0.5 s), then stand 'reading the job ticket'"
    { id: 'O21', what: 'in/out board, arrival hold: the worker\'s own magnet flips (edge-on, then its back) for 0.5 s, then shows its colour', kind: 'inOutBoard', lines: hold(),
      expect: {}, extra: o => (o.at === null ? null : { win: o.t - o.w.arrivedAt < 500 ? 'board' : 'boardAfter', value: o.flip }),
      extraExpect: { board: { allow: ['flip0', 'flip1'], need: ['flip0', 'flip1'] }, boardAfter: { allow: [null], need: [null] } } },
  ]
}

/** The window of one frame for a case, or null. */
function objWindow(c: ObjCase, o: ObjObs, left: number | null, book: { role: string } | null): Win | null {
  const w = o.w
  if (c.after !== undefined && o.t < T0 + c.after * 1000) return null
  if (c.before !== undefined && o.t >= T0 + c.before * 1000) return null
  const gone = left !== null && o.t - left > 1500
  switch (c.mode ?? 'point') {
    case 'carried':
      if (o.at !== null) return w.phase === 'settled' || w.phase === 'entry' ? 'pullAt' : null
      if (book !== null && book.role === 'read' && w.phase === 'settled') return w.filler ? 'readStage2' : w.inCall ? 'read' : null
      return gone && w.phase === 'settled' && book !== null && book.role === 'use' ? 'gone' : null
    case 'desk':
      if (o.at === null) return gone ? 'gone' : null
      return w.phase === 'settled' ? 'desk' : null
    case 'printer':
      if (o.at === null) return gone ? 'gone' : null
      return w.prop === 'printout' ? 'post' : w.phase === 'settled' && w.inCall ? 'unit' : null
    default:
      break
  }
  if (o.at === null) return gone ? 'gone' : null
  if (w.phase === 'entry') return 'entry'
  if (w.phase === 'exit') return 'exit'
  if (w.phase !== 'settled') return null
  if (w.inCall) return 'unit'
  if (o.t < w.unitUntil) return null
  return w.filler ? 'stage2' : 'stage1'
}

/** Run one case (or the EXAMPLE, c = null) with the given modules: the failed checks, keyed by check id. */
function runObjectCase(mods: Mods, c: ObjCase | null): Map<string, string[]> {
  const bad = new Map<string, string[]>()
  const fail = (id: string, msg: string) => { const l = bad.get(id) ?? []; if (l.length < 3) l.push(msg); bad.set(id, l) }
  const world = new mods.world.WorkerWorld(LAYOUT, new mods.core.ObserverCore(LAYOUT, { bodySignals: true }), new mods.planner.PathPlanner(LAYOUT))
  const objs: ObjectsInst = new mods.objects.ObjectStates(LAYOUT)
  const book = (k: string) => world.core.book.holding(k)
  const lines = c === null ? [] : [...c.lines].sort((a, b) => a.ts - b.ts)
  const player = c === null ? new ExamplePlayer(T0) : null
  const end = c === null ? T0 + (player!.length + 60_000) : lines[lines.length - 1].ts + 30_000
  const seen = new Map<string, Set<string | null>>()
  const note = (win: string, v: string | null, e: Expect | undefined) => {
    if (e === undefined) return
    let s = seen.get(win)
    if (!s) seen.set(win, (s = new Set()))
    s.add(v)
    if (e.allow !== undefined && !e.allow.includes(v)) fail(c!.id, `${win}: shows ${v ?? 'nothing'} at ${((now - T0) / 1000).toFixed(2)} s (allowed: ${e.allow.map(x => x ?? 'nothing').join(', ')})`)
  }
  let usedAt: realObjects.ObjLayer['place'] | null = null
  let tileX = -1, tileY = -1, left: number | null = null
  let li = 0, now = T0
  for (; now <= end; now += 50) {
    if (player !== null) player.deliver(now, l => world.ingest(l, now))
    while (li < lines.length && lines[li].ts + 300 <= now) { world.ingest(lines[li].line, now); li++ }
    world.step(now)
    objs.update(world.workers.values(), now, book)
    // O0: every layer has its holder where it says
    for (let i = 0; i < objs.count; i++) {
      const l = objs.layers[i]
      const w = world.workers.get(l.key)
      if (w === undefined) { fail('O0', `${l.art.tile}|${l.art.state} for a worker the world no longer has`); continue }
      if (l.carried) {
        const vol = l.art.state === 'ledgerOut' ? 'ledger' : 'book'
        if (mods.sprite.heldProp(w, now) !== vol || w.leaving !== null) fail('O0', `#${w.n}'s gap ${l.art.state} shows while its hands hold ${mods.sprite.heldProp(w, now) ?? 'nothing'}${w.leaving ? ' (leaving)' : ''}`)
      } else if (!w.onGrid || w.goal === null || w.goal.kind !== 'place' || w.goal.place !== l.place || !['entry', 'settled', 'exit'].includes(w.phase)) {
        fail('O0', `${l.art.tile}|${l.art.state} at ${l.place} while #${w.n} is ${w.phase}${w.goal?.kind === 'place' ? ` for ${w.goal.place}` : ''} at +${((now - T0) / 1000).toFixed(2)} s`)
      }
    }
    if (c === null) continue
    // the subject
    let w: realWorld.WorkerState | undefined
    for (const x of world.workers.values()) if (x.n === (c.subject ?? 1)) w = x
    if (w === undefined) continue
    let at: realObjects.ObjLayer['place'] | null = null
    if (w.onGrid && w.goal?.kind === 'place' && ['entry', 'settled', 'exit'].includes(w.phase)) {
      const p = LAYOUT.place(w.goal.place)
      if (p.type === 'point' && p.kind === c.kind) {
        at = p.id
        if (usedAt === null) {
          usedAt = p.id
          const inst = LAYOUT.instances.find(i => i.id === p.objectId)!
          const t = c.tile === 'W' || c.tile === 'E' ? inst.tiles.find(t => MAP.tiles[t.y][t.x] === `frontDesk${c.tile}`)! : p.useTile
          tileX = t.x; tileY = t.y
        }
      }
    }
    if (usedAt !== null && at === null && left === null) left = now
    if (at !== null) left = null
    if (usedAt === null) continue
    let top: string | null = null
    for (let i = 0; i < objs.count; i++) {
      const l = objs.layers[i]
      if (l.x === tileX && l.y === tileY && l.carried === (c.mode === 'carried')) top = l.art.state
    }
    const o: ObjObs = { t: now, w, at, pose: mods.sprite.poseOf(w, now), flip: objs.flipOf(w, now) }
    const win = objWindow(c, o, left, book(w.key))
    if (win !== null) note(win, top, c.expect[win])
    const ex = (c.after === undefined || now >= T0 + c.after * 1000) && (c.before === undefined || now < T0 + c.before * 1000) ? c.extra?.(o) : null
    if (ex) note(ex.win, ex.value, c.extraExpect?.[ex.win])
  }
  if (c !== null) {
    if (tileX < 0) fail(c.id, `the subject never stood on a ${c.kind} point`)
    for (const [win, e] of [...Object.entries(c.expect), ...Object.entries(c.extraExpect ?? {})] as [string, Expect][]) {
      const s = seen.get(win)
      if (s === undefined) { fail(c.id, `the window ${win} never came`); continue }
      for (const v of e.need ?? []) if (!s.has(v)) fail(c.id, `${win}: never shows ${v ?? 'nothing'} (seen: ${[...s].map(x => x ?? 'nothing').join(', ')})`)
    }
  }
  // O20: at the end everyone has left and nothing is left showing, nor remembered
  if (world.workers.size === 0) {
    objs.update(world.workers.values(), now, book)
    if (objs.count !== 0 || objs.carriedSlots !== 0) fail('O20', `${objs.count} object layers and ${objs.carriedSlots} carried slots left after everyone left${c ? ` (${c.id})` : ' (example)'}`)
  } else fail(c?.id ?? 'O20', `${world.workers.size} workers still inside at the end${c ? ` (${c.id})` : ' (example)'}`)
  world.dispose()
  return bad
}

function runObjectChecks(mods: Mods): Map<string, string[]> {
  const all = new Map<string, string[]>()
  for (const c of [...objectCases(), null]) {
    let bad: Map<string, string[]>
    try { bad = runObjectCase(mods, c) } catch (e) { bad = new Map([['crash', [String(e).split('\n')[0]]]]) }
    for (const [k, v] of bad) all.set(k, [...(all.get(k) ?? []), ...v])
  }
  return all
}

/** Each check of the object section, and a planted change that must make it fail. */
const OBJECT_MUTANTS: readonly Mutant[] = [
  { id: 'OM1 a read leaves no folder gap (the drawer only)', file: 'objects', from: "        else if (settled && held === 'folder') s = 'folderOut'\n", to: '' },
  { id: 'OM2 a search scans instead of leafing', file: 'objects', from: "        if (inUnit && act === 'search') s = 'leafing'\n", to: "        if (inUnit && act === 'search') s = 'scanning'\n" },
  { id: 'OM3 a list shows no glint', file: 'objects', from: "        else if (inUnit && act === 'list') s = 'scanning'\n", to: '' },
  { id: 'OM4 the drawer stays open at stage 2', file: 'objects', from: "        if (stage2) return\n        let s = 'drawerOpen'\n", to: "        let s = 'drawerOpen'\n" },
  { id: 'OM5 the lectern\'s ledgers stay open at stage 2', file: 'objects', from: "inUnit ? 'turning' : (entry || settled) && !stage2 ? 'compare' : 'lampOn'", to: "inUnit ? 'turning' : (entry || settled) ? 'compare' : 'lampOn'" },
  { id: 'OM6 the lectern\'s pages never turn', file: 'objects', from: "inUnit ? 'turning' : (entry || settled) && !stage2 ? 'compare'", to: "false ? 'turning' : (entry || settled) && !stage2 ? 'compare'" },
  { id: 'OM7 the desk types for the whole call, not only while the hands are on the keys', file: 'objects', from: "settled && (pose === 'type0' || pose === 'type1') ? 'typing'", to: "inUnit ? 'typing'" },
  { id: 'OM8 a call result never goes off (no 2 s limit)', file: 'objects', from: '&& now - w.callEnd.at < RESULT_MS ?', to: '?' },
  { id: 'OM9 the bench forgets the output at stage 1', file: 'objects', from: "w.callEnd.place === p.id) s = 'output'", to: "w.callEnd.place === p.id) s = 'ready'" },
  { id: 'OM10 the bench shows no result lamp', file: 'objects', from: '        } else if (settled && result !== null) s = result\n', to: '        }\n' },
  { id: 'OM11 the Monitor lamp blinks for the whole call', file: 'objects', from: "now - w.actAt < BLINKS_MS ? 'watching' : 'ready'", to: "'watching'" },
  { id: 'OM12 the stop lamp flashes for the whole call', file: 'objects', from: "now - w.actAt < BLINKS_MS ? 'stopped' : 'ready'", to: "'stopped'" },
  { id: 'OM13 the gap closes on the walk to the reading place', file: 'objects', from: "    if (h.role === 'read' || h.role === 'readAtShelf') return h.pulledFrom\n", to: '' },
  { id: 'OM14 a carried gap is never given back', file: 'objects', from: '      if (w === null || this.#shelfOf(w, book) !== c.place || heldProp(w, now) !== c.prop) this.#carry.delete(key)\n', to: '' },
  { id: 'OM15 no papers on the reading ledge', file: 'objects', from: "        this.#show(w, p, tile, 'spread', now)\n", to: '' },
  { id: 'OM16 the reading table\'s book stays open at stage 2', file: 'objects', from: "(entry || settled) && !stage2 ? 'openBook' : 'lampOn'", to: "(entry || settled) ? 'openBook' : 'lampOn'" },
  { id: 'OM17 the catalog\'s cards never flip', file: 'objects', from: "inUnit && act === 'websearch' ? 'flipping'", to: "false ? 'flipping'" },
  { id: 'OM18 no pages wait in the printer tray', file: 'objects', from: "        if (w.prop === 'printout') this.#show(w, p, tile, 'done', now)\n        else ", to: '        ' },
  { id: 'OM19 no sheets rise while printing', file: 'objects', from: "        else if (inUnit && act === 'report') this.#show(w, p, tile, 'printing', now)\n", to: '' },
  { id: 'OM20 the hand-in drawn on the wrong half (no OUT tray there)', file: 'objects', from: "this.#show(w, p, 'frontDeskE', 'handIn'", to: "this.#show(w, p, 'frontDeskW', 'handIn'" },
  { id: 'OM20b a hand-in is never signed for', file: 'objects', from: "          else if (t < HAND_IN_MS + SIGN_MS) this.#show(w, p, 'frontDeskW', 'signing', now, t0 + HAND_IN_MS)\n", to: '' },
  { id: 'OM21 a sign-out signs nothing', file: 'objects', from: "          if (now - ready < SIGN_MS) this.#show(w, p, 'frontDeskW', 'signing', now, ready)\n", to: '' },
  { id: 'OM22 no ticket drops into IN', file: 'objects', from: '          if (now - t0 < TICKET_MS)', to: '          if (now - t0 < 0)' },
  { id: 'OM23 the cradle stays full while the worker is on the phone', file: 'objects', from: "        if (pose === 'phoneU') { this.#show(w, p, 'frontDeskW', 'onPhone', now); return }\n", to: '' },
  { id: 'OM24 the old stance: AskUserQuestion stands with its back turned (standU), no handset', file: 'core', from: '    return stance({ kind, activity: w.activity, sub, role: w.role,', to: "    if (w.activity === 'ask') return { pose: 'standU', prop: null }\n    return stance({ kind, activity: w.activity, sub, role: w.role," },
  { id: 'OM25 no magnet flip at the arrival hold', file: 'objects', from: '    return t < 0 || t >= FLIP_MS ? null :', to: '    return true ? null :' },
  { id: 'OM26 point states for a body still walking to the point', file: 'objects', from: '    if (!w.onGrid || w.leaving !== null || !AT.has(w.phase) || w.goal === null', to: '    if (!w.onGrid || w.leaving !== null || w.goal === null' },
]

// ── the §4.6 snap (live/world.ts snap, live/liveFeed.ts) ─────────────────────────────────────────────────────────
// The live feed on a fake wall clock: a reader pushes each line 300 ms after its timestamp, also while the page is
// hidden (no frames run then); the page's frames run every 1000/60 ms of wall time, or slower (jank).
//   S1  on return the sim clock IS the wall clock (the first frame back);
//   S1b under jank (frames every 120 ms: the 50 ms cap falls behind) the lag never passes SNAP_LAG_MS + one frame:
//       the feed snaps ('behind') and the clock is the wall again;
//   S2  the backlog (every line read while hidden) is applied at the snap: the core read exactly those lines, a helper
//       that arrived while hidden is inside, one that came and went while hidden is not;
//   S2b no walk of the backlog is replayed: the snap plans exactly one trip per body it re-places;
//   S3  right after the snap every body stands where the core's book has it (a seat: on its sitFrom, then exactly
//       one step onto the seat);
//   S4  the arrivals are reported again: a worker that was walking to a shelf when the tab hid gets its pull (then a
//       reading place); a finisher that was walking to the front desk hands in and leaves;
//   S5a a worker with no place yet stands on its own sidewalk slot after the snap;
//   S5b at the end of the snap frame every slot claim belongs to a body standing on that slot;
//   S5c the workers held off screen get a slot and appear;
//   S6  a (re)connect: nothing runs until the reader has caught up, then one snap carries the whole backlog.
type FeedMod = typeof realFeed
type FeedInst = InstanceType<FeedMod['LiveFeed']>

function snapLines(): Line[] {
  const A = aidOf('n', 1), B = aidOf('n', 2), C = aidOf('n', 3), D = aidOf('n', 4), E = aidOf('n', 5), F = aidOf('n', 6)
  const st = (s: number, aid: string) => L(s, 'SubagentStart', SA, { aid, at: 'workflow-subagent' })
  const pre = (s: number, aid: string, k: string, a: string, tu: string) => L(s, 'PreToolUse', SA, { aid, k, a, tu })
  const batch = (s: number, aid: string) => L(s, 'PostToolBatch', SA, { aid, n: 1 })
  const stop = (s: number, aid: string) => L(s, 'SubagentStop', SA, { aid, at: 'workflow-subagent', bt: [] })
  return [
    // A: a pull at the history shelf, still walking there when the tab hides (3 s)
    st(0.2, A), pre(1, A, 'historyShelf', 'hist-read', 'a1'), batch(40, A),
    // B: a result form; walking to the front desk when the tab hides; its stop comes while hidden
    st(0.3, B), pre(0.5, B, 'frontDesk', 'form', 'b1'), batch(1, B), stop(8, B),
    // C: a write at a desk seat (re-placed through its sitFrom)
    st(0.4, C), pre(1, C, 'pcDesk', 'write', 'c1'), batch(80, C),
    // F: at a file cabinet before the hide; sent to the bench while hidden (a walk the backlog must not replay)
    st(0.5, F), pre(0.6, F, 'fileCabinet', 'read', 'f1'), batch(1.5, F), pre(20, F, 'benchTerminal', 'run', 'f2'), batch(70, F),
    // D arrives while hidden and stays; E comes and goes while hidden
    st(20, D), pre(21, D, 'fileCabinet', 'read', 'd1'), batch(90, D),
    st(10, E), pre(11, E, 'fileCabinet', 'read', 'e1'), batch(12, E), stop(13, E),
  ]
}

/** 32 arrivals at once and no tool call: 30 slots (2 held off screen), 10 arrival holds, 20 waiting on their slots. */
function slotLines(): Line[] {
  const out: Line[] = []
  for (let k = 0; k < 32; k++) out.push(L(1 + k * 0.001, 'SubagentStart', SA, { aid: aidOf('q', k), at: 'workflow-subagent' }))
  for (let k = 0; k < 32; k++) out.push(L(40 + k * 0.05, 'PreToolUse', SA, { aid: aidOf('q', k), k: 'fileCabinet', a: 'read', tu: `q${k}` }))
  return out
}

function runSnap(mods: Mods): Map<string, string[]> {
  const bad = new Map<string, string[]>()
  const fail = (id: string, msg: string) => { const l = bad.get(id) ?? []; if (l.length < 3) l.push(msg); bad.set(id, l) }
  const tileOf = (w: realWorld.WorkerState, planner: Planner, t: number) => planner.positionAt(w.key, t)
  const mk = () => {
    const planner = new mods.planner.PathPlanner(LAYOUT)
    let plans = 0
    const world = new mods.world.WorkerWorld(LAYOUT, new mods.core.ObserverCore(LAYOUT, { bodySignals: true }), planner, { trace: { plan: () => { plans++ } } })
    let wall = T0
    const feed: FeedInst = new mods.feed.LiveFeed(world, () => wall)
    return { planner, world, feed, setWall: (t: number) => { wall = t }, plans: () => plans }
  }
  const nByAid = (world: World, aid: string) => {
    for (const w of world.workers.values()) if (w.key === `w${realCore.hash32(aid).toString(16).padStart(8, '0')}`) return w
    return undefined
  }

  // ── SN1: hidden from 3 s to 63 s ──
  try {
    const { planner, world, feed, setWall, plans } = mk()
    const lines = [...snapLines()].sort((a, b) => a.ts - b.ts)
    let li = 0, wall = T0
    const read = () => { const out: string[] = []; while (li < lines.length && lines[li].ts + 300 <= wall) out.push(lines[li++].line); if (out.length) feed.push(out) }
    feed.caughtUp()
    const tick = (to: number, frameMs: number, frames: boolean) => {
      for (; wall + frameMs <= to + 1e-9;) { wall += frameMs; setWall(wall); read(); if (frames) feed.frame() }
      wall = to; setWall(wall); read()
    }
    tick(T0 + 3000, 1000 / 60, true)
    const A = aidOf('n', 1), B = aidOf('n', 2), D = aidOf('n', 4), E = aidOf('n', 5), F = aidOf('n', 6)
    const wA0 = nByAid(world, A), wB0 = nByAid(world, B), wF0 = nByAid(world, F)
    if (!wA0 || wA0.phase !== 'walking' || !wB0 || wB0.phase !== 'walking' || !wF0) fail('S4', `setup: at the hide A is ${wA0?.phase}, B ${wB0?.phase} (both must still be walking)`)
    tick(T0 + 63_000, 1000 / 60, false)                       // hidden: the reader reads on, no frame runs
    const linesBefore = world.core.stats.lines, queued = feed.queued
    feed.requestSnap('return')
    const plansBefore = plans()
    wall += 1000 / 60; setWall(wall); read(); feed.frame()     // the first frame back
    const now = wall
    // S1
    if (feed.sim !== now) fail('S1', `the first frame back: sim ${feed.sim - T0} ms, wall ${now - T0} ms`)
    // S2
    if (world.core.stats.lines - linesBefore !== queued || queued === 0) fail('S2', `the core read ${world.core.stats.lines - linesBefore} lines at the snap; ${queued} were read while hidden`)
    if (nByAid(world, D) === undefined) fail('S2', 'D, which arrived while hidden, is not inside after the snap')
    if (nByAid(world, E) !== undefined) fail('S2', 'E, which came and went while hidden, is inside after the snap')
    // S2b
    const replaced = [...world.workers.values()].filter(w => w.phase !== 'offscreen').length
    if (plans() - plansBefore !== replaced) fail('S2b', `the snap planned ${plans() - plansBefore} trips for ${replaced} re-placed bodies (a backlog walk was replayed)`)
    // S3: where the book has them (a seat: on its sitFrom now, on the seat one step later)
    const seatWalk = new Map<string, number>()
    for (const w of world.workers.values()) {
      const h = world.core.book.holding(w.key)
      if (h === null) continue
      const p = LAYOUT.place(h.place)
      const seat = p.type === 'point' && p.how === 'sit'
      const want = seat && p.type === 'point' ? p.sitFrom! : { x: p.x, y: p.y }
      if (w.pos.x !== want.x || w.pos.y !== want.y || w.pos.moving) fail('S3', `#${w.n} is drawn at (${w.pos.x},${w.pos.y}) after the snap, its booked ${h.place} is at (${want.x},${want.y})${seat ? ' (sitFrom)' : ''}`)
      if (seat) seatWalk.set(w.key, w.pos.walked)
    }
    if (seatWalk.size === 0) fail('S3', 'setup: nobody sits after the snap (C must)')
    tick(now + 1500, 1000 / 60, true)
    for (const w of world.workers.values()) {
      const h = world.core.book.holding(w.key)
      if (h === null) continue
      const p = LAYOUT.place(h.place)
      const at = tileOf(w, planner, wall)
      if (at === null || at.x !== p.x || at.y !== p.y || at.moving) fail('S3', `#${w.n} is not on its booked ${h.place} 1.5 s after the snap (at ${at ? `(${at.x.toFixed(2)},${at.y.toFixed(2)})` : 'nothing'})`)
      const steps = seatWalk.has(w.key) ? 1 : 0
      if (at !== null && at.walked !== steps) fail('S3', `#${w.n} walked ${at.walked} steps since the snap (${steps === 1 ? 'one, from its sitFrom onto its seat' : 'none'})`)
    }
    // S4: A's pull ends (a reading place), B hands in and leaves
    tick(now + 6000, 1000 / 60, true)
    const wA = nByAid(world, A), hA = wA ? world.core.book.holding(wA.key) : null
    if (hA === null || (hA.role !== 'read' && hA.role !== 'readAtShelf')) fail('S4', `A is ${hA?.role ?? 'nowhere'} 6 s after the snap: its pull never ended (its arrival at the shelf was not reported)`)
    const wB = nByAid(world, B)
    if (wB !== undefined && wB.leaving === null) fail('S4', `B, which was walking to the front desk at the hide, has not handed in and been sent out 6 s after the snap (${wB.label})`)
  } catch (e) { fail('S1', `crash ${String(e).split('\n')[0]}`) }

  // ── SN2: jank: frames every 120 ms of wall time ──
  try {
    const { feed, setWall } = mk()
    const lines = [...snapLines()].sort((a, b) => a.ts - b.ts)
    let li = 0, wall = T0, maxLag = 0
    feed.caughtUp()
    for (let f = 0; f < 200; f++) {
      wall += 120; setWall(wall)
      const out: string[] = []
      while (li < lines.length && lines[li].ts + 300 <= wall) out.push(lines[li++].line)
      if (out.length) feed.push(out)
      feed.frame()
      maxLag = Math.max(maxLag, wall - feed.sim)
    }
    const behind = feed.snaps.filter(s => s.why === 'behind')
    if (behind.length === 0 || maxLag > realFeed.SNAP_LAG_MS + 120) fail('S1b', `jank (120 ms frames): ${behind.length} 'behind' snaps, the largest lag ${maxLag.toFixed(0)} ms (limit ${realFeed.SNAP_LAG_MS} + one frame)`)
    if (behind.some(s => s.lag <= realFeed.SNAP_LAG_MS)) fail('S1b', 'a behind snap without a lag over the limit')
  } catch (e) { fail('S1b', `crash ${String(e).split('\n')[0]}`) }

  // ── SN3: connect: the backlog first, then one snap ──
  try {
    const { world, feed, setWall } = mk()
    const lines = [...snapLines()].sort((a, b) => a.ts - b.ts)
    let wall = T0 + 60_000
    setWall(wall)
    const early = lines.filter(l => l.ts + 300 <= wall).map(l => l.line)
    feed.push(early.slice(0, 5))
    for (let f = 0; f < 30; f++) { wall += 1000 / 60; setWall(wall); feed.frame() }   // reading: nothing may run yet
    const ranEarly = world.core.stats.lines
    feed.push(early.slice(5))
    feed.caughtUp()
    wall += 1000 / 60; setWall(wall); feed.frame()
    const s0 = feed.snaps[0]
    if (ranEarly !== 0 || s0 === undefined || s0.why !== 'connect' || s0.lines !== early.length || world.core.stats.lines !== early.length) {
      fail('S6', `before catching up the core read ${ranEarly} lines; the first snap ${s0 ? `('${s0.why}') carried ${s0.lines} of ${early.length}` : 'never came'}`)
    }
    const torn = world.core.stats.torn + world.core.stats.shape
    const inside = [aidOf('n', 1), aidOf('n', 3), aidOf('n', 4), aidOf('n', 6)].filter(a => nByAid(world, a) !== undefined).length
    if (torn !== 0 || inside !== 4 || nByAid(world, aidOf('n', 5)) !== undefined) fail('S6', `after the connect snap: ${torn} unreadable lines, ${inside} of the 4 helpers still working at 60 s inside (E, gone by then, ${nByAid(world, aidOf('n', 5)) ? 'inside' : 'not inside'})`)
  } catch (e) { fail('S6', `crash ${String(e).split('\n')[0]}`) }

  // ── SN4: slots: 32 arrivals, hidden from 2 s to 30 s ──
  try {
    const { planner, world, feed, setWall } = mk()
    const lines = [...slotLines()].sort((a, b) => a.ts - b.ts)
    let li = 0, wall = T0
    feed.caughtUp()
    const step = (to: number, frames: boolean) => {
      for (; wall + 1000 / 60 <= to + 1e-9;) {
        wall += 1000 / 60; setWall(wall)
        const out: string[] = []
        while (li < lines.length && lines[li].ts + 300 <= wall) out.push(lines[li++].line)
        if (out.length) feed.push(out)
        if (frames) feed.frame()
      }
    }
    step(T0 + 2800, true)
    const held0 = [...world.workers.values()].filter(w => w.phase === 'offscreen').map(w => w.key)
    if (held0.length !== 2) fail('S5c', `setup: ${held0.length} workers held off screen before the hide (2 expected)`)
    step(T0 + 30_000, false)
    feed.requestSnap('return')
    wall += 1000 / 60; setWall(wall); feed.frame()
    const now = wall
    // S5b: claims right after the snap frame (the world's claims are private: read them through the core's slot view)
    let waiting = 0
    for (const w of world.workers.values()) {
      if (w.place !== null || w.phase === 'offscreen') continue
      waiting++
      const g = w.goal
      if (g === null || g.kind !== 'slot') { fail('S5a', `#${w.n} has no place and is not put back on a slot (goal ${g?.kind ?? 'none'}, ${w.phase})`); continue }
      const t = SLOT_TILES[g.slot]
      if (w.pos.x !== t.x || w.pos.y !== t.y) fail('S5a', `#${w.n} is drawn at (${w.pos.x},${w.pos.y}), not on its slot (${t.x},${t.y})`)
    }
    if (waiting === 0) fail('S5a', 'setup: nobody without a place after the snap')
    const slotsOk = (when: string) => {
      for (const w of world.workers.values()) {
        const s = world.slotClaimOf(w.key)
        if (s === null) continue
        const t = SLOT_TILES[s], at = planner.positionAt(w.key, wall)
        const standing = (at !== null && at.x === t.x && at.y === t.y) || (at === null && w.pos.x === t.x && w.pos.y === t.y && w.goal?.kind === 'slot')
        if (!standing) fail('S5b', `${when}: #${w.n} still claims slot ${s} but stands at ${at ? `(${at.x},${at.y})` : `(${w.pos.x},${w.pos.y}) (not yet on the grid)`}`)
      }
    }
    slotsOk('the snap frame')
    step(now + 3000, true)
    for (const k of held0) {
      const w = world.workers.get(k)
      if (w === undefined || !w.onGrid || w.phase === 'offscreen') fail('S5c', `#${w?.n ?? '?'}, held off screen before the hide, has not appeared 3 s after the snap (${w?.phase ?? 'gone'})`)
    }
    step(T0 + 75_000, true)
    const notIn = [...world.workers.values()].filter(w => world.core.book.holding(w.key)?.forKind !== 'fileCabinet' && world.core.book.waiterOf(w.key) === null)
    if (notIn.length > 0) fail('S5c', `${notIn.length} workers are neither at nor waiting for a file cabinet 35 s after their call`)
  } catch (e) { fail('S5a', `crash ${String(e).split('\n')[0]}`) }
  return bad
}

const SNAP_MUTANTS: readonly Mutant[] = [
  { id: 'SM1 the snap leaves the clock behind the wall', file: 'feed', from: '      this.#sim = Math.max(this.#sim, wall)\n      const backlog', to: '      const backlog' },
  { id: 'SM2 the backlog is dropped at the snap', file: 'feed', from: '      this.world.snap(this.#sim, backlog)\n', to: '      this.world.snap(this.#sim, [])\n' },
  { id: 'SM3 the backlog\'s walks are replayed', file: 'world', from: '          if (this.#snapping) { this.#teleport(w, c.place); break }\n', to: '          if (this.#snapping) this.#teleport(w, c.place)\n' },
  { id: 'SM4 no re-placing: the bodies keep their old walks', file: 'world', from: '    this.#replace()\n    this.step(now)\n', to: '    this.step(now)\n' },
  { id: 'SM5 a seat re-placed on its own tile, not through its sitFrom', file: 'world', from: '        const from = seat && p.type === \'point\' ? p.sitFrom! : { x: p.x, y: p.y }\n', to: '        const from = { x: p.x, y: p.y }\n' },
  { id: 'SM6 a re-placed body counts as settled: its arrival is not reported again', file: 'world', from: "        w.phase = 'appearing'\n        this.#plan(w, { kind: 'place', place: w.place }, { x: p.x, y: p.y }, from)\n", to: "        w.phase = 'settled'\n        this.#plan(w, { kind: 'place', place: w.place }, { x: p.x, y: p.y }, from)\n" },
  { id: 'SM7 a worker without a place is not put back on its slot', file: 'world', from: '      } else if (slot !== null) {\n', to: '      } else if (slot === -2) {\n' },
  { id: 'SM8 the claims of re-placed bodies are kept until their next step', file: 'world', from: '        this.#putBody(w, from, now)\n        this.#leaveSlots(w.key)\n', to: '        this.#putBody(w, from, now)\n' },
  { id: 'SM9 no snap when the clock trails the wall', file: 'feed', from: '    if (this.#snapWhy !== null || lag > SNAP_LAG_MS) {\n', to: '    if (this.#snapWhy !== null) {\n' },
  { id: 'SM10 the office runs before the reader has caught up', file: 'feed', from: '    if (!this.#ready || this.world.disposed) return 0\n', to: '    if (this.world.disposed) return 0\n' },
]

// ── mutants ──────────────────────────────────────────────────────────────────────────────────────────────────────
type MutantFile = 'planner' | 'core' | 'world' | 'sprite' | 'objects' | 'feed'
interface Mutant { readonly id: string; readonly file: MutantFile; readonly from: string; readonly to: string }
const FILES: Readonly<Record<MutantFile, string>> = {
  planner: '../src/worker-office/move/planner.ts', core: '../src/worker-office/core/reducer.ts',
  world: '../src/worker-office/live/world.ts', sprite: '../src/worker-office/render/WorkerSprite.ts',
  objects: '../src/worker-office/live/objects.ts', feed: '../src/worker-office/live/liveFeed.ts',
}
const MUTANTS: readonly Mutant[] = [
  // the movement core
  { id: 'M1 keep-old-path removed', file: 'planner', from: '      this.#rebookFrom(b, s0)   // keep-old-path (§4.7): the old bookings stand and the old path is walked\n', to: '' },
  { id: 'M2 a swap allowed', file: 'planner', from: '        if (o !== undefined && o !== me && this.#res.get(t1 * N + i) === o) continue\n', to: '' },
  { id: 'M3 the spacing check one step off', file: 'planner', from: '        if (!this.#free(j, t1, me)) continue\n', to: '        if (!this.#free(j, t, me)) continue\n' },
  { id: 'M4 cancel leaves the bookings', file: 'planner', from: '    this.#unbookAll(b)   // cancel: the table forgets every booking of this worker\n', to: '' },
  // the integration rulings (decisions.md 2026-10-01 23:13): each restores what the ruling replaced
  { id: 'M5 ruling 3: the core frees a slot when its worker books a place, before the body has left it', file: 'core',
    from: '      if (c.to !== null && !signals) this.#freeSlot(o)\n', to: '      if (c.to !== null) this.#freeSlot(o)\n' },
  { id: 'M6 ruling 4: the seat entry animates the step onto the seat again', file: 'sprite',
    from: '  const x = Math.round(w.pos.x * TILE), y = Math.round(w.pos.y * TILE) - FIGURE_LIFT\n',
    to: "  const x = Math.round(w.pos.x * TILE), y = Math.round(w.pos.y * TILE) - FIGURE_LIFT + (w.phase === 'entry' && w.seat ? Math.round(Math.max(0, 1 - (now - w.arrivedAt) / 400) * TILE) : 0)\n" },
  { id: 'M7 ruling 4: the whole 1.4 s seat beat after the planner\'s step', file: 'world',
    from: '    const len = seat ? Math.max(BEAT.entrySeatMin, beat - STEP_MS) : beat\n',
    to: '    const len = seat ? Math.max(BEAT.entrySeatMin, beat) : beat\n' },
  { id: 'M8 ruling 5: the hand-in on the observer\'s walk estimate', file: 'core',
    from: 'o.finArrive = signals ? (o.bodyAt === c.to ? this.#clock : Infinity) : this.#clock + walkMs(this.layout, c.from, c.to)',
    to: 'o.finArrive = this.#clock + walkMs(this.layout, c.from, c.to)' },
  { id: 'M9 ruling 5: the pull ends on the observer\'s walk estimate', file: 'core',
    from: 'const at = signals ? (o.bodyAt === c.to ? this.#clock + PULL_MS : Infinity) : this.#clock + walkMs(this.layout, c.from, c.to) + PULL_MS',
    to: 'const at = this.#clock + walkMs(this.layout, c.from, c.to) + PULL_MS' },
  { id: 'M10 ruling 6: no watchdog', file: 'world', from: '    this.pendingLimitMs = opts.pendingLimitMs ?? PENDING_LIMIT_MS\n', to: '    this.pendingLimitMs = Infinity\n' },
]

/** A patched copy of one module (the patch asserted to apply once) whose relative imports point at the real files. */
async function loadPatched(m: Mutant, dir: string, i: number): Promise<Mods> {
  const path = fileURLToPath(new URL(FILES[m.file], import.meta.url))
  let src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const n = src.split(m.from).length - 1
  if (n !== 1) throw new Error(`${m.id}: the patch applies ${n} times`)
  src = src.replace(m.from, () => m.to)
  src = src.replace(/(from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g, (_, pre: string, spec: string) => `${pre}'${pathToFileURL(resolve(dirname(path), spec)).href}'`)
  const file = join(dir, `${m.file}-mutant-${i}.ts`)
  writeFileSync(file, src)
  const mod: unknown = await import(pathToFileURL(file).href)
  return { ...REAL, [m.file]: mod } as Mods
}

if (NO_MUTANTS || OBJECTS_ONLY) console.log(`movement mutants: skipped (${NO_MUTANTS ? '--no-mutants' : '--objects-only'})`)
else {
  console.log('mutants (each must make a check fail; run on the scenarios and the tuning days):')
  const dir = mkdtempSync(join(tmpdir(), 'wo-traffic-mutant-'))
  let caught = 0
  for (const [i, m] of MUTANTS.entries()) {
    let mods: Mods
    try { mods = await loadPatched(m, dir, i) } catch (e) { fail(String(e).split('\n')[0]); continue }
    const hits = new Map<string, number>()
    for (const sc of [...scenarios, ...tuningDays]) {
      for (const b of runOnce(mods, sc).bad) {
        if (b.startsWith('...')) continue
        const tag = b.startsWith('crash') ? 'crash' : b.split(' ')[0]
        const where = `${tag}@${sc.name.split(' ')[0] === 'day' ? sc.name.replace('day seed ', 'd') : sc.name.split(' ')[0]}`
        hits.set(where, (hits.get(where) ?? 0) + 1)
      }
    }
    const real = [...hits.keys()].filter(k => !k.startsWith('crash@'))
    if (real.length > 0) caught++
    else fail(`mutant survived: ${m.id}`)
    console.log(`  ${real.length > 0 ? 'caught  ' : 'SURVIVED'} ${m.id}: ${[...hits].map(([k, v]) => `${k} x${v}`).join(', ') || 'no failed check'}`)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(`mutants caught: ${caught} of ${MUTANTS.length}`)
}

// ── object states: the run, then each check shown able to fail ─────────────────────────────────────────────────
if (!SNAP_ONLY) {
  const cases = objectCases()
  const checks = [...cases.map(c => c.id), 'O0', 'O20']
  console.log(`object states (plan §4.4; live/objects.ts): ${cases.length} action cases and the EXAMPLE through the real core and world, every 50 ms`)
  const real = runObjectChecks(REAL)
  for (const c of cases) {
    const b = real.get(c.id)
    console.log(`  ${b ? 'FAIL' : 'ok  '} ${c.id} ${c.what}`)
    for (const m of b ?? []) fail(`${c.id}: ${m}`)
  }
  for (const id of ['O0', 'O20', 'crash']) {
    const b = real.get(id)
    if (id !== 'crash') console.log(`  ${b ? 'FAIL' : 'ok  '} ${id} ${id === 'O0' ? 'no point state without its holder on the point, no gap without its carrier (all cases and the EXAMPLE)' : 'everything back at rest at the end: no layer, no carried slot remembered'}`)
    for (const m of b ?? []) fail(`${id}: ${m}`)
  }
  if (NO_MUTANTS) console.log('object mutants: skipped (--no-mutants)')
  else {
    console.log('object mutants (each must make a check fail; each check must be failed by one):')
    const dir = mkdtempSync(join(tmpdir(), 'wo-objects-mutant-'))
    const trippedBy = new Map<string, string[]>()
    let caught = 0
    for (const [i, m] of OBJECT_MUTANTS.entries()) {
      let mods: Mods
      try { mods = await loadPatched(m, dir, 100 + i) } catch (e) { fail(String(e).split('\n')[0]); continue }
      const bad = runObjectChecks(mods)
      const hit = [...bad.keys()].filter(k => k !== 'crash')
      for (const k of hit) trippedBy.set(k, [...(trippedBy.get(k) ?? []), m.id.split(' ')[0]])
      if (hit.length > 0) caught++
      else fail(`object mutant survived: ${m.id}${bad.has('crash') ? ` (crashed: ${bad.get('crash')![0]})` : ''}`)
      console.log(`  ${hit.length > 0 ? 'caught  ' : 'SURVIVED'} ${m.id}: ${hit.join(', ') || 'no check failed'}`)
    }
    rmSync(dir, { recursive: true, force: true })
    console.log(`object mutants caught: ${caught} of ${OBJECT_MUTANTS.length}; each check and the mutants that fail it:`)
    for (const id of checks) {
      const by = trippedBy.get(id) ?? []
      console.log(`  ${by.length > 0 ? 'shown able to fail' : 'NEVER FAILED     '} ${id} <- ${by.join(', ') || '-'}`)
      if (by.length === 0) fail(`no object mutant fails the check ${id}`)
    }
  }
}

// ── the snap: the run, then each check shown able to fail ─────────────────────────────────────────────────────
{
  const checks = ['S1', 'S1b', 'S2', 'S2b', 'S3', 'S4', 'S5a', 'S5b', 'S5c', 'S6']
  console.log(`the §4.6 snap (live/world.ts snap, live/liveFeed.ts): hidden 60 s, jank, a reconnect, 32 arrivals; the live clock follows a fake wall clock (cap ${realFeed.MAX_FRAME_MS} ms a frame, snap beyond ${realFeed.SNAP_LAG_MS} ms behind)`)
  const real = runSnap(REAL)
  for (const id of checks) {
    const b = real.get(id)
    console.log(`  ${b ? 'FAIL' : 'ok  '} ${id}`)
    for (const m of b ?? []) fail(`${id}: ${m}`)
  }
  if (NO_MUTANTS) console.log('snap mutants: skipped (--no-mutants)')
  else {
    console.log('snap mutants (each must make a check fail; each check must be failed by one):')
    const dir = mkdtempSync(join(tmpdir(), 'wo-snap-mutant-'))
    const trippedBy = new Map<string, string[]>()
    let caught = 0
    for (const [i, m] of SNAP_MUTANTS.entries()) {
      let mods: Mods
      try { mods = await loadPatched(m, dir, 200 + i) } catch (e) { fail(String(e).split('\n')[0]); continue }
      const bad = runSnap(mods)
      const hit = [...bad.keys()]
      for (const k of hit) trippedBy.set(k, [...(trippedBy.get(k) ?? []), m.id.split(' ')[0]])
      if (hit.length > 0) caught++
      else fail(`snap mutant survived: ${m.id}`)
      console.log(`  ${hit.length > 0 ? 'caught  ' : 'SURVIVED'} ${m.id}: ${hit.map(k => `${k}${(bad.get(k)?.[0] ?? '').startsWith('crash') ? ' (crash)' : ''}`).join(', ') || 'no check failed'}`)
    }
    rmSync(dir, { recursive: true, force: true })
    console.log(`snap mutants caught: ${caught} of ${SNAP_MUTANTS.length}; each check and the mutants that fail it:`)
    for (const id of checks) {
      const by = trippedBy.get(id) ?? []
      console.log(`  ${by.length > 0 ? 'shown able to fail' : 'NEVER FAILED     '} ${id} <- ${by.join(', ') || '-'}`)
      if (by.length === 0) fail(`no snap mutant fails the check ${id}`)
    }
  }
}

console.log(failures === 0 ? 'ALL PASS' : `FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
