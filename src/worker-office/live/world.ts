// The worker office's page side (plan §4.9 "Page", §6.4 "Worker lifecycle"): the observer core's commands drive the
// Path A planner's bodies, and the bodies drive the beats. Pure TypeScript: no DOM, no timers; time comes in as one
// simulation clock (ms). The engine (render/WorkerEngine.ts) draws what this holds; the traffic check
// (scripts/worker-office-traffic-sim.ts) drives this same module headless.
//
//   const world = new WorkerWorld(layout, core, planner)   core: new ObserverCore(layout, { bodySignals: true })
//   world.ingest(line, now)    a spool line read at sim time `now`
//   world.step(now)            the core's timers, its commands, the beats, the planner, the body signals
//   world.workers              per worker: what the core wants, where its body is, which beat it is in
//   world.dispose()            the core, the planner and every worker go
// The core and the planner are passed in (the checks pass patched copies); this module imports neither class.
//
// THE MAPPING (the traffic check's route, now the page's): spawn{slot} -> plan(slot tile, slot tile) (a worker held off
// screen, slot -1, waits for its 'slotted'); walkTo{place} -> plan(the place's own tile; a seat is entered from its
// sitFrom by the planner); leave -> plan(EXIT); fade -> fade in place, then cancel. A re-entry while the old body is still
// on the grid cancels the old body first.
//
// BEATS (plan §4.4, §4.8, §4.9 "Page"). A new target never cuts a beat short except as the plan says:
//   - walking or appearing: re-plan at once (the planner keeps the old path if the new one fails);
//   - entry (0.6 s standing; at a seat 1.4 s minus the step onto it, which the planner walks — lead ruling 4: the beat
//     never animates that step again): finish it, at most 0.6 s more, then a fast exit (0.25 s);
//   - settled in a call: the per-call unit shows for at least 1.2 s, then the exit beat (0.5 s; 0.6 s from a seat);
//   - settled between calls, at a hold, at a seat: the exit beat at once.
// Every beat is × the worker's tempo τ (0.85-1.15, from its seed) × a ±20 % jitter per occurrence (seed + count). A
// worker 3 s or more behind its target gets the fast beats (0.3 s entry, 0.25 s exit). Leaving is final.
//
// BODY SIGNALS back to the core (lead rulings 3, 5, 6, decisions.md 2026-10-01 23:13):
//   - slotLeft: a slot's claimant body has left the tile (or never will stand on it) and the planner says nobody
//     stands on it or will cross it (isClear);
//   - arrived: the body stands on the place it was sent to (the planner's arriveAt), also for a walk of zero steps;
//   - blocked: a walk pending (no trajectory: keep-old-path) for PENDING_LIMIT_MS is reported, with the tile the body
//     is on; the core re-books it elsewhere (PlaceBook.relocate) and the walkTo follows. Re-armed after each report.
import type { Tile } from '../map/loadMap.ts'
import type { PlaceId, PlaceLayout, StationKind } from '../map/places.ts'
import type { CallResult, Cmd, ExitReason, WorkerKey } from '../core/messages.ts'
import type { LabelId } from '../core/labels.ts'
import type { ObserverCore } from '../core/reducer.ts'
import type { PoseName, PropId } from '../render/props.ts'
import { EXIT, STEP_MS, type BodyPose, type Facing, type PathPlanner } from '../move/planner.ts'

/** Beat lengths at τ = 1 (plan §4.8), ms. */
export const BEAT = {
  entryStand: 600, entrySeat: 1400, entryFast: 300, entrySeatMin: 150,
  unitMin: 1200, gesture: 400, sideFace: 150,
  exitStand: 500, exitSeat: 600, exitFast: 250, entryCut: 600,
  behind: 3000, fade: 800,
} as const
/** The watchdog's limit (ruling 6): normal waits for a place's last body are an exit beat and a unit minimum away
 *  (at most ≈ 2.5 s with τ and jitter); a mutual block never ends. */
export const PENDING_LIMIT_MS = 5000

export type BodyPhase = 'offscreen' | 'appearing' | 'walking' | 'entry' | 'settled' | 'exit' | 'leaving' | 'fading'
export type Goal = { readonly kind: 'slot'; readonly slot: number } | { readonly kind: 'place'; readonly place: PlaceId } | { readonly kind: 'exit' }

/** One worker as the page holds it. */
export interface WorkerState {
  readonly key: WorkerKey
  readonly n: number
  readonly seed: number
  /** Tempo τ (beats × τ), the loop rate factor (use / type loops), and the loop and walk phase offsets (0-1). */
  readonly tau: number
  readonly rate: number
  readonly loopOff: number
  readonly walkOff: number
  /** What the core wants: the place it was last sent to (null: none yet, or leaving), leaving and why. */
  place: PlaceId | null
  targetAt: number
  leaving: 'out' | 'direct' | null
  exitReason: ExitReason | null
  /** The steady pose at the place (the core's latest 'pose'), and the label. */
  pose: PoseName
  prop: PropId | null
  belt: boolean
  filler: boolean
  label: LabelId
  labelN: number | null
  labelSt: StationKind | null
  labelAt: number
  /** The latest call: in a call, its station kind and activity, when it started, the result of the last one. */
  inCall: boolean
  kind: StationKind | null
  activity: string
  actAt: number
  callEnd: { readonly result: CallResult; readonly at: number } | null
  /** The body: its phase, the goal the planner was last given, the end of a timed beat. */
  phase: BodyPhase
  goal: Goal | null
  beatUntil: number
  /** The per-call unit: its pose is shown until unitUntil (at least 1.2 s × τ); a same-kind call's gesture. */
  unitPose: PoseName | null
  unitProp: PropId | null
  unitUntil: number
  gestureUntil: number
  /** A new target is waiting for the current beat to end. */
  moveWanted: boolean
  /** The exit beat shows the pose and prop the worker had when it began (the next place's come with the walkTo). */
  exitPose: PoseName | null
  exitProp: PropId | null
  /** The entry beat: at a seat, and the facing of the last move into the place (a side approach shows a side frame). */
  seat: boolean
  arriveFacing: Facing
  arrivedAt: number
  /** When the body first stood on the grid (the fade-in), when its walk went pending (the watchdog), and the fade. */
  appearedAt: number | null
  pendingSince: number | null
  fadeAt: number | null
  /** Where the body is now (filled every step; valid while onGrid). */
  readonly pos: BodyPose
  onGrid: boolean
  /** How many beats it has had (seeds each beat's jitter). */
  beats: number
}

/** Hooks for the checks (never needed to run). */
export interface WorldTrace {
  plan?(key: WorkerKey, goal: Goal, now: number): void
  cancel?(key: WorkerKey, now: number): void
  arrived?(key: WorkerKey, place: PlaceId, now: number): void
  /** An entry beat: until when, and the beat it was drawn from (a seat: the whole seat beat, the step included). */
  entry?(key: WorkerKey, place: PlaceId, seat: boolean, until: number, now: number, beat: number): void
  blocked?(key: WorkerKey, place: PlaceId, now: number): void
  slotLeft?(key: WorkerKey, slot: number, now: number): void
  command?(c: Cmd, now: number): void
}

export interface WorldOptions {
  readonly pendingLimitMs?: number
  readonly trace?: WorldTrace
}

export interface WorldObjects { rackLeds: number; magnets: readonly number[]; outStack: number; inTray: number }
export interface WorldBanner { readonly scope: 'session' | 'office'; readonly session: string | null; readonly label: LabelId; readonly since: number }

/** A 32-bit integer finaliser (murmur3 fmix32). */
function fmix(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}
const unit = (seed: number, salt: number) => fmix((seed ^ salt) >>> 0) / 4294967296

export class WorkerWorld {
  readonly layout: PlaceLayout
  readonly core: ObserverCore
  readonly planner: PathPlanner
  readonly pendingLimitMs: number
  readonly trace: WorldTrace
  readonly workers = new Map<WorkerKey, WorkerState>()
  readonly objects: WorldObjects = { rackLeds: 0, magnets: [], outStack: 0, inTray: 0 }
  readonly banners = new Map<string, WorldBanner>()
  /** Sidewalk slot claims the core holds for a body (slot index -> worker key), until slotLeft. */
  readonly #claims = new Map<number, WorkerKey>()
  readonly #slotTiles: readonly Tile[]
  #now = -Infinity
  #disposed = false
  readonly #scratch: BodyPose = { x: 0, y: 0, moving: false, facing: 'W', walked: 0 }

  constructor(layout: PlaceLayout, core: ObserverCore, planner: PathPlanner, opts: WorldOptions = {}) {
    if (core.options.bodySignals !== true) throw new Error('WorkerWorld: the core must run with bodySignals (the page reports its bodies)')
    this.layout = layout
    this.core = core
    this.planner = planner
    this.pendingLimitMs = opts.pendingLimitMs ?? PENDING_LIMIT_MS
    this.trace = opts.trace ?? {}
    this.#slotTiles = [...layout.map.arrivalSlots, ...layout.map.arrivalSlotsOverflow]
  }

  get now(): number { return this.#now }
  get disposed(): boolean { return this.#disposed }
  /** Workers whose body is on the grid or on its way (not the ones held off screen). */
  get onScreen(): number { let n = 0; for (const w of this.workers.values()) if (w.onGrid) n++; return n }

  /** One spool line, read at sim time `now`. */
  ingest(line: string, now: number) {
    if (this.#disposed) return
    this.#advanceTo(now)
    this.#route(this.core.ingest(line, now))
  }

  /** Advance to `now`: the core's timers, the beats, the planner, the body signals. */
  step(now: number) {
    if (this.#disposed) return
    this.#advanceTo(now)
    this.#route(this.core.tick(now))
    for (const w of this.workers.values()) this.#beat(w)
    this.planner.tick(this.#now)
    for (const w of [...this.workers.values()]) this.#watch(w)
    this.#releaseSlots()
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.core.dispose()
    this.planner.dispose()
    this.workers.clear()
    this.#claims.clear()
    this.banners.clear()
  }

  #advanceTo(now: number) {
    if (now < this.#now) throw new Error(`WorkerWorld: time went back (${now} < ${this.#now})`)
    this.#now = now
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────────
  #route(cmds: readonly Cmd[]) {
    for (const c of cmds) {
      this.trace.command?.(c, this.#now)
      switch (c.op) {
        case 'spawn': this.#spawn(c.key, c.n, c.seed, c.slot); break
        case 'slotted': {
          const w = this.workers.get(c.key)
          this.#claims.set(c.slot, c.key)
          if (w !== undefined && w.phase === 'offscreen') this.#appear(w, c.slot)
          break
        }
        case 'walkTo': {
          const w = this.workers.get(c.key)
          if (w === undefined || w.leaving !== null) break
          w.place = c.place
          w.targetAt = this.#now
          this.#want(w)
          break
        }
        case 'leave': {
          const w = this.workers.get(c.key)
          if (w === undefined) break
          w.leaving = c.via
          w.exitReason = c.reason
          w.place = null
          w.targetAt = this.#now
          if (w.phase === 'offscreen' || (w.phase === 'appearing' && !w.onGrid)) this.#drop(w)
          else this.#want(w)
          break
        }
        case 'fade': {
          const w = this.workers.get(c.key)
          if (w === undefined) break
          w.exitReason = c.reason
          w.leaving = 'direct'
          if (!w.onGrid) { this.#drop(w); break }
          w.phase = 'fading'
          w.fadeAt = this.#now
          break
        }
        case 'pose': {
          const w = this.workers.get(c.key)
          if (w === undefined) break
          w.pose = c.pose; w.prop = c.prop; w.belt = c.belt; w.filler = c.filler
          break
        }
        case 'bubble': {
          const w = this.workers.get(c.key)
          if (w === undefined) break
          w.label = c.label; w.labelN = c.n; w.labelSt = c.st; w.labelAt = this.#now
          break
        }
        case 'act': {
          const w = this.workers.get(c.key)
          if (w === undefined) break
          if (c.inCall) {
            const same = w.inCall || w.kind === c.kind
            w.inCall = true
            w.kind = c.kind
            w.activity = c.activity
            w.actAt = this.#now
            w.unitPose = w.pose
            w.unitProp = w.prop
            w.unitUntil = this.#now + this.#beatMs(w, BEAT.unitMin)
            if (same && w.phase === 'settled') w.gestureUntil = this.#now + BEAT.gesture
          } else w.inCall = false
          break
        }
        case 'callEnd': {
          const w = this.workers.get(c.key)
          if (w !== undefined) w.callEnd = { result: c.result, at: this.#now }
          break
        }
        case 'objects':
          this.objects.rackLeds = c.rackLeds; this.objects.magnets = c.magnets; this.objects.outStack = c.outStack; this.objects.inTray = c.inTray
          break
        case 'banner': {
          const id = c.scope === 'office' ? 'office' : `s:${c.session}`
          if (c.label === null) this.banners.delete(id)
          else this.banners.set(id, { scope: c.scope, session: c.session, label: c.label, since: c.since ?? this.#now })
          break
        }
      }
    }
  }

  #spawn(key: WorkerKey, n: number, seed: number, slot: number) {
    const old = this.workers.get(key)
    if (old !== undefined) this.#drop(old)                           // a re-entry while the old body is still here
    const w: WorkerState = {
      key, n, seed,
      tau: 0.85 + 0.3 * unit(seed, 0x2545f491), rate: 0.85 + 0.3 * unit(seed, 0x68e31da4),
      loopOff: unit(seed, 0xb5297a4d), walkOff: unit(seed, 0x1b56c4e9),
      place: null, targetAt: this.#now, leaving: null, exitReason: null,
      pose: 'standU', prop: null, belt: false, filler: false, label: 'arriving', labelN: null, labelSt: null, labelAt: this.#now,
      inCall: false, kind: null, activity: 'none', actAt: -Infinity, callEnd: null,
      phase: 'offscreen', goal: null, beatUntil: -Infinity, unitPose: null, unitProp: null, unitUntil: -Infinity, gestureUntil: -Infinity,
      exitPose: null, exitProp: null,
      moveWanted: false, seat: false, arriveFacing: 'N', arrivedAt: -Infinity, appearedAt: null, pendingSince: null, fadeAt: null,
      pos: { x: 0, y: 0, moving: false, facing: 'W', walked: 0 }, onGrid: false, beats: 0,
    }
    this.workers.set(key, w)
    if (slot >= 0) {
      this.#claims.set(slot, key)
      this.#appear(w, slot)
    }
  }

  /** Put a body on its sidewalk slot (it appears once the tile is clear; the core named a clear one). */
  #appear(w: WorkerState, slot: number) {
    const t = this.#slotTiles[slot]
    w.phase = 'appearing'
    this.#plan(w, { kind: 'slot', slot }, t)
    if (w.place !== null || w.leaving !== null) this.#want(w)
  }

  /** A new target (place or exit) came in: act on it now or when the current beat allows (BEATS above). */
  #want(w: WorkerState) {
    switch (w.phase) {
      case 'offscreen': case 'fading': case 'leaving': return
      case 'appearing': case 'walking': this.#go(w); return
      case 'entry':
        w.moveWanted = true
        w.beatUntil = Math.min(w.beatUntil, this.#now + BEAT.entryCut)
        return
      case 'settled':
        if (w.goal?.kind === 'slot') { this.#go(w); return }        // standing on its slot: no beat to finish
        w.moveWanted = true
        this.#startExit(w)
        return
      case 'exit':
        w.moveWanted = true
        return
    }
  }

  /** Plan the newest target from where the body is. */
  #go(w: WorkerState) {
    w.moveWanted = false
    if (w.leaving !== null) {
      w.phase = 'leaving'
      this.#plan(w, { kind: 'exit' }, null)
      return
    }
    if (w.place === null) return
    const p = this.layout.place(w.place)
    if (w.phase !== 'appearing') w.phase = 'walking'
    this.#plan(w, { kind: 'place', place: w.place }, { x: p.x, y: p.y })
  }

  #plan(w: WorkerState, goal: Goal, tile: Tile | null) {
    w.goal = goal
    w.pendingSince = null
    this.trace.plan?.(w.key, goal, this.#now)
    const known = this.planner.state(w.key) !== null
    if (goal.kind === 'slot') this.planner.plan(w.key, known ? null : tile, tile!, this.#now)
    else this.planner.plan(w.key, null, goal.kind === 'exit' ? EXIT : tile!, this.#now)
  }

  /** The exit beat at the place (after the unit's minimum when in a call): then the walk. */
  #startExit(w: WorkerState) {
    const behind = this.#now - w.targetAt >= BEAT.behind
    const start = Math.max(this.#now, w.inCall ? w.unitUntil : this.#now)
    const len = behind ? BEAT.exitFast : this.#beatMs(w, w.seat ? BEAT.exitSeat : BEAT.exitStand)
    w.exitPose = this.#now < w.unitUntil && w.unitPose !== null ? w.unitPose : w.pose
    w.exitProp = this.#now < w.unitUntil && w.unitPose !== null ? w.unitProp : w.prop
    w.phase = 'exit'
    w.beatUntil = start + len
  }

  /** A beat's length × τ × its own ±20 % jitter. */
  #beatMs(w: WorkerState, ms: number): number {
    w.beats++
    return ms * w.tau * (0.8 + 0.4 * unit(w.seed, Math.imul(w.beats, 0x9e3779b1)))
  }

  // ── beats ────────────────────────────────────────────────────────────────────────────────────────────────────────
  #beat(w: WorkerState) {
    const now = this.#now
    if (w.phase === 'entry' && now >= w.beatUntil) {
      if (w.moveWanted) {
        w.exitPose = w.seat ? 'sit' : 'standU'
        w.exitProp = null
        w.phase = 'exit'
        w.beatUntil = now + BEAT.exitFast
      } else w.phase = 'settled'
    }
    if (w.phase === 'exit' && now >= w.beatUntil) this.#go(w)
    if (w.phase === 'fading' && w.fadeAt !== null && now >= w.fadeAt + BEAT.fade) this.#drop(w)
  }

  /** After the planner's tick: where each body is, arrivals, the exit fade's end, the watchdog. */
  #watch(w: WorkerState) {
    const P = this.planner
    const at = P.positionAt(w.key, this.#now, w.pos)
    const st = P.state(w.key)
    if (at !== null && !w.onGrid) { w.onGrid = true; w.appearedAt ??= this.#now }
    if (w.phase === 'leaving' && st === null) { this.#drop(w); return }
    if (w.phase === 'leaving' && st !== null && st.leaving && st.arriveAt !== null && this.#now >= st.arriveAt) w.fadeAt ??= st.arriveAt   // on the exit lane: the fade
    if (w.phase === 'fading' || w.phase === 'offscreen') return
    if (st === null) return
    if (w.phase === 'appearing' && st.appeared) {
      w.phase = 'walking'
      if (w.goal?.kind === 'slot') { w.phase = 'settled'; return }   // stands on its slot: no place yet
    }
    if ((w.phase === 'walking' || w.phase === 'appearing') && w.goal?.kind === 'place') {
      if (st.pending) {
        w.pendingSince ??= this.#now
        if (this.#now - w.pendingSince >= this.pendingLimitMs) this.#blocked(w)
        return
      }
      w.pendingSince = null
      if (!st.appeared || st.arriveAt === null || this.#now < st.arriveAt) return
      const p = this.layout.place(w.goal.place)
      if (st.goal === null || st.goal.x !== p.x || st.goal.y !== p.y) return
      this.#arrive(w, w.goal.place, p.type === 'point' && p.how === 'sit')
    }
  }

  #arrive(w: WorkerState, place: PlaceId, seat: boolean) {
    const now = this.#now
    const behind = now - w.targetAt >= BEAT.behind
    // ruling 4: at a seat the planner has already walked the step onto it, so the entry beat is the 1.4 s seat beat
    // without that step (sit, hands to the keys), and it never moves the body again
    const beat = behind ? BEAT.entryFast : this.#beatMs(w, seat ? BEAT.entrySeat : BEAT.entryStand)
    const len = seat ? Math.max(BEAT.entrySeatMin, beat - STEP_MS) : beat
    w.phase = 'entry'
    w.seat = seat
    w.arriveFacing = w.pos.facing
    w.arrivedAt = now
    w.beatUntil = now + len
    this.trace.arrived?.(w.key, place, now)
    this.trace.entry?.(w.key, place, seat, w.beatUntil, now, beat)
    this.#route(this.core.arrived(w.key, place, now))
  }

  /** Ruling 6: the walk has been pending too long: the core re-books the worker elsewhere (or keeps it: asked again). */
  #blocked(w: WorkerState) {
    const place = w.goal?.kind === 'place' ? w.goal.place : null
    if (place === null) return
    this.trace.blocked?.(w.key, place, this.#now)
    w.pendingSince = this.#now
    const tile = { x: Math.round(w.pos.x), y: Math.round(w.pos.y) }
    this.#route(this.core.blocked(w.key, tile))
  }

  /** The body leaves the grid for good (after its exit fade, a fade, a re-entry, an exit before it ever appeared). */
  #drop(w: WorkerState) {
    if (this.planner.state(w.key) !== null) { this.planner.cancel(w.key); this.trace.cancel?.(w.key, this.#now) }
    if (this.workers.get(w.key) === w) this.workers.delete(w.key)
    w.onGrid = false
  }

  /** Ruling 3: a claimed slot whose body has gone (or appeared and walked off) and that nobody will cross is free. */
  #releaseSlots() {
    if (this.#claims.size === 0) return
    for (const [slot, key] of [...this.#claims]) {
      const t = this.#slotTiles[slot]
      const st = this.planner.state(key)
      if (st !== null && !st.appeared) continue                         // its body has not stood on the slot yet
      if (st !== null) {
        const p = this.planner.positionAt(key, this.#now, this.#scratch)
        if (p !== null && Math.round(p.x) === t.x && Math.round(p.y) === t.y) continue
      }
      if (!this.planner.isClear(t, this.#now)) continue
      this.#claims.delete(slot)
      this.trace.slotLeft?.(key, slot, this.#now)
      this.#route(this.core.slotLeft(key, slot))
    }
  }
}
