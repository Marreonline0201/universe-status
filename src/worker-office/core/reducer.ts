// The observer core (plan §4, §5.3; §6.4 "Observer core"): spool lines -> the worker world -> renderer commands.
// Pure TypeScript: no DOM, no timers, no sockets, no randomness. Time comes in as numbers (ms since the epoch).
//
//   const core = new ObserverCore(layout)
//   core.ingest(line, wallNow)   one spool line (torn lines and unknown fields are tolerated)
//   core.tick(wallNow)           the quiet flush and the timers (call it every ~250-500 ms while live)
//   core.drain()                 release every held record (the end of a replay)
//   core.snapshot()              WORKERS_SNAPSHOT, for a page that (re)connects: snap, never replay walks
//   core.dispose()               release everything; every later call is a no-op
// Each call returns the commands it caused, in order (messages.ts Cmd).
//
// CLOCK. Records are released by the reorder buffer (reorder.ts: a 500 ms timestamp watermark plus a 1.0 s
// wall-clock quiet flush). The core's clock is the release frontier: before a record is applied, every deadline up to
// its ts fires, in deadline order, stamped with its due time; a tick advances the clock to wallNow - 1.0 s (never past
// a held record). So live and replay order timers and records the same way. A record older than the clock (late
// beyond the window) is applied at the clock and counted.
//
// WHO IS A WORKER (§4.1, A.C2.7, probe answers, decisions.md 2026-10-01 rulings):
//   - created only by SubagentStart or by a PreToolUse with an agent id; never by a stop. Not created: a Start or
//     Pre whose agent_type is '' (internal agents), and an unknown id whose first record is a hand-back Pre (the
//     hand-back-first guard, probe 11);
//   - records without an agent id are the main session's: they keep the session's clock, task list, launches and
//     SessionEnd, but draw no figure (§4.1; D6 is undecided and its recommended default is decor);
//   - a SubagentStop counts only for a known worker inside with a non-empty agent_type, and only with nothing in
//     flight (§4.2: 6 real stops came mid-call);
//   - any event of a worker that has left (GONE) except a stop walks it back in, same ordinal and look (§4.6).
// Ids are joined without any leading "agent-" (reorder.ts). Keys are hashes: commands never carry an agent id.
//
// WHAT A WORKER DOES (§4.2 / §4.4 / §4.9):
//   - a Pre sends it to its station through PlaceBook (map/places.ts): own point, sibling, pool tile, or queued.
//     Inside one step (calls in flight) a Pre moves it only if its kind ranks higher in classify.mjs PRECEDENCE than
//     the step's winner so far; the same kind is the "next item" gesture; a lower one changes nothing (§4.3 P1:
//     "a parallel batch is resolved by the same precedence; the newest batch wins"). A Pre with no kind is a STAY:
//     only the label changes;
//   - a Batch drops its in-flight count to 0 (probe 2: never subtract n) and starts the gap: stage 1, then stage 2 at
//     10 s (labelled filler, §4.5). Bench and desk calls get a result 1.0 s after the Batch (§4.5);
//   - the hand-back (Pre SubagentHandback -> printer; its Post -> carry the printout to the front desk), the result
//     form (Pre StructuredOutput -> front desk) and the sign-out (a finished worker that never handed in) end at the
//     desk; after the hand-in a worker without its stop waits on a departure hold (hold tiles, then the mail corner)
//     for at most 90 s (§4.6);
//   - a background helper's stop with nothing in flight PAUSES it; if it launched background work since it last
//     resumed (a bg shell, a Monitor = a 'watch', or a background helper), it goes to the lounge with a pager after
//     15 s (WAITING) — the lounge gate (ruling: 'watch' counts as well as bg); otherwise "paused (reason unknown)" in
//     place. A stop after a hand-back is always a finish, whatever the helper type (§4.6 Finishing wins);
//   - the task list (bt) only confirms an end: helpers already seen listed (workflow agents never are, probe 5) end
//     on 1 absent snapshot when the end is expected (paused, handed in), on 2 in a row otherwise, never while
//     WAITING; a list of 50 entries may have been cut by the hook and counts no absence;
//   - quiet (session-active clock: time counts while the session had any event in the last 120 s): "no events for
//     N min" from 120 s, "may have stopped?" from 15 min, evicted at 30 min (straight out); with a call in flight
//     "running N min" from 60 s and "may be stuck?" at the shell timeout + 60 s; WAITING: no quiet label, a 2 h 10 min
//     cap; a session silent for 5 min gets its banner (it carries the time of the session's last record, so the page
//     counts the minutes); 2 h without any spool event clears the office (fade, banner);
//   - SessionEnd clear / resume removes nobody; every other reason (an absent one included) makes that session's
//     workers leave.
import { ACTIVITY_BY_ID, ACTIVITY_ID, rank, resolveAtStation } from '../../../office/observer/classify.mjs'
import { PlaceBook, SHELF_ROOM, stationForKind, type Change, type PlaceId, type PlaceLayout, type Role, type StationKind } from '../map/places.ts'
import type { PoseName, PropId } from '../render/props.ts'
import { activityLabel, type LabelId } from './labels.ts'
import type { BannerView, CallResult, Cmd, ExitReason, FeedMessage, ObjectsView, SessionKey, WorkerKey, WorkerView } from './messages.ts'
import { HAND_IN_MS, PULL_MS, SIGN_MS, isSeat, originOf, placePose, stance, walkMs, type FrontPose, type Stance, type Sub } from './places.ts'
import { Reorder, parseRecord, type BtEntry, type SpoolRecord } from './reorder.ts'

// This module is the core's entry point: the §5.3 feed helpers come with it.
export { fromFeedMessages, toFeedMessages } from './messages.ts'

/** The timing constants of plan §4.8 the observer owns (ms). */
export const TIMING = {
  stage2: 10_000, result: 1_000, fgCheck: 5_000, longCall: 4_000, grace: 15_000, holdOutCap: 90_000,
  activeWindow: 120_000, quiet: 120_000, suspect: 15 * 60_000, evict: 30 * 60_000, waitCap: 130 * 60_000,
  running: 60_000, shellTimeoutDefault: 120_000, stuckExtra: 60_000,
  sessionQuiet: 5 * 60_000, officeClear: 2 * 3_600_000,
} as const
/** The hook keeps at most 50 task-list entries (spool-hook.mjs MAX_BT): a full list may have been cut. */
export const MAX_BT = 50

export interface CoreOptions {
  /** PostToolUseFailure is hooked (matcher '*'): a bench / desk call with no Failure reads green, "no failure
   *  recorded" (§4.5, probe 10). Off: neutral. */
  readonly failureHookInstalled: boolean
  /** Helpers hand back with SubagentHandback (auto mode). Off: a background helper's stop reads "waiting or finished
   *  (no hand-back signal in this mode)" (§4.6). */
  readonly handbackMode: boolean
  readonly watermarkMs?: number
  readonly quietFlushMs?: number
}

const DEFAULTS: CoreOptions = { failureHookInstalled: true, handbackMode: true }

/** FNV-1a with a murmur3 finaliser: a pure-TS 32-bit hash (no node:crypto in the page). */
export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
const hex8 = (h: number) => h.toString(16).padStart(8, '0')
const SEED_SALT = 0x9747b28c

type Phase = 'arriving' | 'hold' | 'station' | 'paused' | 'waiting' | 'finishing' | 'handedIn' | 'gone'
type Fin = 'report' | 'form' | 'signout'
type Job = 'shell' | 'monitor' | 'helper'
const JOB_LABEL: Readonly<Record<Job, LabelId>> = { shell: 'waitShell', monitor: 'waitMonitor', helper: 'waitHelper' }

interface Call {
  readonly tu: string | null
  a: string
  readonly kind: StationKind | null
  readonly to: number | null
  fail: boolean
  intr: boolean
  launched: boolean
}

interface Session {
  readonly key: SessionKey
  /** Event clock of its last record, and the session-active time accumulated up to then. */
  L: number
  S: number
  inside: number
  /** Whether its quiet banner shows. */
  banner: boolean
  /** Workflow task ids (Post(Workflow).tid; probe 5: runs join on tid, never runId). */
  readonly runs: Set<string>
  /** The workflow task ids its latest task list shows running. */
  runsListed: number
}

interface Sent {
  readonly place: PlaceId | null
  readonly pose: PoseName
  readonly prop: PropId | null
  readonly belt: boolean
  readonly filler: boolean
  readonly label: LabelId
  readonly n: number | null
  readonly st: StationKind | null
}

interface Worker {
  readonly key: WorkerKey
  readonly aid: string
  readonly n: number
  readonly seed: number
  readonly front: FrontPose
  sess: Session
  lives: number
  at: string | null
  helper: 'workflow' | 'background' | null
  phase: Phase
  phaseSince: number
  disp: string
  dispSince: number
  // the booking, as the core learnt it from the book's change records
  place: PlaceId | null
  role: Role | null
  forKind: StationKind | null
  station: StationKind | null
  // calls
  activity: string
  sub: Sub
  hadCall: boolean
  calls: Map<string, Call>
  inFlight: number
  batchKind: StationKind | null
  unitBg: boolean
  callStart: number
  gapStart: number | null
  actSeq: number
  result: { at: number; seq: number; place: PlaceId | null; fail: boolean; intr: boolean; tus: Set<string> } | null
  fgCheck: { at: number; call: string } | null
  pull: { id: number; at: number } | null
  // finishing
  fin: Fin | null
  finStep: 'printing' | 'carry' | 'handIn' | null
  /** The estimated arrival at the desk spot (walkMs); the hand-in starts then. */
  finArrive: number | null
  finAt: number | null
  stopSeen: boolean
  handedIn: boolean
  holdOutCapAt: number | null
  // pauses
  bgJob: Job | null
  gated: boolean
  graceAt: number | null
  holdFailed: boolean
  // quiet
  sLast: number
  ovQ: number
  // the task list
  listed: boolean
  absent: number
  slot: number | null
  sent: Sent | null
  queued: Cmd[]
}

export interface CoreStats {
  lines: number
  torn: number
  shape: number
  version: number
  late: number
  parseErrors: number
  noSession: number
  otherEvents: number
  otherPosts: number
  created: number
  reentries: number
  phantom: number
  handbackFirst: number
  internalStart: number
  internalPre: number
  startInside: number
  stopUnknown: number
  stopUngated: number
  stopInFlight: number
  batchNoOpen: number
  failureUnmatched: number
  snapshots: number
  sessionEndKept: number
  sessionEndRemoved: number
  afterDispose: number
  maxInside: number
  exits: Record<ExitReason, number>
  phaseEntries: Record<string, number>
  /** Worker-time per display state: inCall, between1, between2 (§4.5 stages), and the other phases. */
  dispMs: Record<string, number>
}

const newStats = (): CoreStats => ({
  lines: 0, torn: 0, shape: 0, version: 0, late: 0, parseErrors: 0, noSession: 0, otherEvents: 0, otherPosts: 0,
  created: 0, reentries: 0, phantom: 0, handbackFirst: 0, internalStart: 0, internalPre: 0, startInside: 0,
  stopUnknown: 0, stopUngated: 0, stopInFlight: 0, batchNoOpen: 0, failureUnmatched: 0, snapshots: 0,
  sessionEndKept: 0, sessionEndRemoved: 0, afterDispose: 0, maxInside: 0,
  exits: { finished: 0, finishedInferred: 0, evicted: 0, signOffCap: 0, waitCap: 0, sessionEnded: 0, officeCleared: 0 },
  phaseEntries: {}, dispMs: {},
})

export class ObserverCore {
  readonly layout: PlaceLayout
  readonly options: CoreOptions
  readonly stats: CoreStats = newStats()
  #book: PlaceBook
  #reorder: Reorder
  #clock = -Infinity
  #lastAny = -Infinity
  #seq = 0
  #disposed = false
  #out: Cmd[] = []
  #byAid = new Map<string, Worker>()
  #byKey = new Map<WorkerKey, Worker>()
  #sessions = new Map<string, Session>()
  #nextN = 1
  #slots: (WorkerKey | null)[]
  /** Children seen as background (an async launch, a task-list entry) before they were workers. */
  #bgIds = new Set<string>()
  #outStack = 0
  #inTray = 0
  #sentObjects = ''
  #officeBanner = false
  #inside = 0

  constructor(layout: PlaceLayout, opts: Partial<CoreOptions> = {}) {
    this.layout = layout
    this.options = { ...DEFAULTS, ...opts }
    this.#book = new PlaceBook(layout)
    this.#reorder = new Reorder({ watermarkMs: this.options.watermarkMs, quietFlushMs: this.options.quietFlushMs })
    this.#slots = new Array<WorkerKey | null>(layout.map.arrivalSlots.length + layout.map.arrivalSlotsOverflow.length).fill(null)
  }

  /** The reservation book, for checks only: read it, never book through it. */
  get book(): PlaceBook { return this.#book }
  get clock(): number { return this.#clock }
  get disposed(): boolean { return this.#disposed }
  /** Workers inside now. */
  get inside(): number { return this.#inside }

  // ── input ──────────────────────────────────────────────────────────────────────────────────────────────────────
  /** One spool line read at wall time `wall`. */
  ingest(line: string, wall: number): Cmd[] {
    if (this.#disposed) { this.stats.afterDispose++; return [] }
    this.stats.lines++
    const p = parseRecord(line, this.#seq++)
    if (!p.ok) { this.stats[p.why]++; return [] }
    for (const r of this.#reorder.add(p.rec, wall)) this.#release(r)
    return this.#take()
  }

  /** Wall time passes: the quiet flush, then every deadline up to the release frontier. */
  tick(wall: number): Cmd[] {
    if (this.#disposed) { this.stats.afterDispose++; return [] }
    for (const r of this.#reorder.flush(wall)) this.#release(r)
    let frontier = wall - this.#reorder.quietFlushMs
    const held = this.#reorder.oldest()
    if (held !== null) frontier = Math.min(frontier, held)
    this.#advance(frontier)
    return this.#take()
  }

  /** Release every held record (the end of a replay). */
  drain(): Cmd[] {
    if (this.#disposed) { this.stats.afterDispose++; return [] }
    for (const r of this.#reorder.drain()) this.#release(r)
    return this.#take()
  }

  /** Release every booking; every later call does nothing (no booking after dispose). */
  dispose(): Cmd[] {
    if (this.#disposed) return []
    this.#disposed = true
    this.#book.dispose()
    for (const w of this.#byKey.values()) if (w.phase !== 'gone') this.#gone(w)
    this.#out = []
    return []
  }

  /** WORKERS_SNAPSHOT (§5.3): what a page snaps to on (re)connect. */
  snapshot(): FeedMessage {
    const workers: WorkerView[] = []
    for (const w of this.#byKey.values()) {
      if (w.phase === 'gone') continue
      const v = this.#view(w)
      workers.push({
        key: w.key, n: w.n, seed: w.seed, session: w.sess.key, phase: w.phase, station: w.station, place: v.place, pose: v.pose,
        prop: v.prop, belt: v.belt, filler: v.filler, label: v.label, labelN: v.n, labelSt: v.st, activity: w.activity, inCall: w.inFlight > 0,
      })
    }
    const banners: BannerView[] = []
    for (const s of this.#sessions.values()) if (s.banner) banners.push({ scope: 'session', session: s.key, label: 'sessionQuiet', since: s.L })
    if (this.#officeBanner) banners.push({ scope: 'office', session: null, label: 'officeCleared', since: this.#lastAny })
    return { type: 'WORKERS_SNAPSHOT', t: this.#clock, workers, objects: this.#objectsView(), banners }
  }

  // ── the clock ──────────────────────────────────────────────────────────────────────────────────────────────────
  #release(r: SpoolRecord) {
    this.#advance(r.ts)
    if (r.ts < this.#clock) this.stats.late++
    this.#clock = Math.max(this.#clock, r.ts)
    this.#apply(r)
    this.#flush()
  }

  #take(): Cmd[] { const o = this.#out; this.#out = []; return o }

  /** Fire every deadline up to `target`, earliest first, each stamped with its due time. */
  #advance(target: number) {
    for (let guard = 0; ; guard++) {
      if (guard > 1_000_000) throw new Error('observer core: the timers do not settle')
      let best = Infinity
      let fire: (() => void) | null = null
      for (const w of this.#byKey.values()) {
        if (w.phase === 'gone') continue
        const [d, f] = this.#nextTimer(w)
        if (d < best) { best = d; fire = f }
      }
      for (const s of this.#sessions.values()) {
        const d = this.#bannerDue(s)
        if (d < best) { best = d; fire = () => this.#bannerFire(s) }
      }
      const oc = this.#inside > 0 && Number.isFinite(this.#lastAny) ? this.#lastAny + TIMING.officeClear : Infinity
      if (oc < best) { best = oc; fire = () => this.#officeClear() }
      if (fire === null || best > target) break
      this.#clock = Math.max(this.#clock, best)
      fire()
      this.#flush()
    }
    if (target > this.#clock) this.#clock = target
  }

  #nextTimer(w: Worker): [number, (() => void) | null] {
    let d = Infinity
    let f: (() => void) | null = null
    const take = (at: number | null, fn: () => void) => { if (at !== null && at < d) { d = at; f = fn } }
    if (w.result) take(w.result.at, () => this.#resultFire(w))
    if (w.fgCheck) take(w.fgCheck.at, () => this.#fgFire(w))
    if (w.pull) take(w.pull.at, () => this.#pullFire(w))
    take(w.finArrive, () => this.#arriveFire(w))
    take(w.finAt, () => this.#finFire(w))
    take(w.graceAt, () => this.#graceFire(w))
    take(w.holdOutCapAt, () => { w.holdOutCapAt = null; this.#leave(w, 'signOffCap', 'out') })
    if (w.phase === 'station' && w.sub === 'stage1' && w.gapStart !== null) take(w.gapStart + TIMING.stage2, () => { w.sub = 'stage2' })
    if (w.phase === 'station' && w.sub === 'unit' && w.inFlight > 0 && this.#longDiffers(w)) take(w.callStart + TIMING.longCall, () => { w.sub = 'long' })
    take(this.#overlayDue(w), () => this.#overlayFire(w))
    return [d, f]
  }

  /** Session-active time of a worker's quiet at the clock. */
  #quiet(w: Worker): number {
    const s = w.sess
    return s.S + Math.min(this.#clock - s.L, TIMING.activeWindow) - w.sLast
  }

  /** The next quiet boundary (session-active ms) after the one last shown, or Infinity. */
  #nextBoundary(w: Worker): number {
    const q = w.ovQ
    if (w.phase === 'waiting') return q < TIMING.waitCap ? TIMING.waitCap : Infinity
    if (w.phase === 'handedIn' || w.phase === 'gone') return Infinity
    const first = w.inFlight > 0 ? TIMING.running : TIMING.quiet
    let b = q < first ? first : (Math.floor(q / 60_000) + 1) * 60_000
    if (w.inFlight > 0) { const s = this.#stuckAt(w); if (s !== null && s > q && s < b) b = s }
    b = Math.min(b, TIMING.evict)
    return b > q ? b : Infinity
  }

  /** When the worker's quiet reaches its next boundary, if the session stays as it is (else Infinity). */
  #overlayDue(w: Worker): number | null {
    const b = this.#nextBoundary(w)
    if (b === Infinity) return null
    const s = w.sess
    const need = b - (s.S - w.sLast)
    if (need <= 0) return s.L
    return need > TIMING.activeWindow ? null : s.L + need
  }

  #overlayFire(w: Worker) {
    const b = this.#nextBoundary(w)
    w.ovQ = Math.max(this.#quiet(w), b)
    if (w.phase === 'waiting') { if (w.ovQ >= TIMING.waitCap) this.#leave(w, 'waitCap', 'direct'); return }
    if (w.ovQ >= TIMING.evict) this.#leave(w, 'evicted', 'direct')
  }

  /** The "may be stuck?" threshold of the calls in flight (shell timeout + 60 s, 120 s default), or null for a call
   *  that may legitimately wait long (a foreground helper, a question to the owner). */
  #stuckAt(w: Worker): number | null {
    let to = 0
    for (const c of w.calls.values()) {
      if (c.a === 'helper-fg' || c.a === 'helper-bg' || c.a === 'ask') return null
      to = Math.max(to, c.to !== null ? c.to * 1000 : TIMING.shellTimeoutDefault)
    }
    return to + TIMING.stuckExtra
  }

  /** The session's quiet banner: 5 min after its last record, while it has a worker inside. */
  #bannerDue(s: Session): number {
    return s.inside === 0 || s.banner ? Infinity : s.L + TIMING.sessionQuiet
  }

  #bannerFire(s: Session) {
    s.banner = true
    this.#emit({ op: 'banner', t: this.#clock, scope: 'session', session: s.key, label: 'sessionQuiet', since: s.L })
  }

  #bannerClear(s: Session) {
    if (!s.banner) return
    s.banner = false
    this.#emit({ op: 'banner', t: this.#clock, scope: 'session', session: s.key, label: null, since: null })
  }

  #officeClear() {
    for (const w of this.#byKey.values()) if (w.phase !== 'gone') this.#fade(w, 'officeCleared')
    this.#officeBanner = true
    this.#emit({ op: 'banner', t: this.#clock, scope: 'office', session: null, label: 'officeCleared', since: this.#lastAny })
  }

  // ── records ────────────────────────────────────────────────────────────────────────────────────────────────────
  #apply(r: SpoolRecord) {
    this.#lastAny = this.#clock
    if (this.#officeBanner) {
      this.#officeBanner = false
      this.#emit({ op: 'banner', t: this.#clock, scope: 'office', session: null, label: null, since: null })
    }
    if (r.ev === 'parse_error') { this.stats.parseErrors++; return }
    if (r.sid === null) { this.stats.noSession++; return }
    const s = this.#session(r.sid)
    s.S += Math.min(this.#clock - s.L, TIMING.activeWindow)
    s.L = this.#clock
    this.#bannerClear(s)
    switch (r.ev) {
      case 'SubagentStart': this.#onStart(r, s); break
      case 'PreToolUse': if (r.aid !== null) this.#onPre(r, r.aid, s); break
      case 'PostToolBatch': if (r.aid !== null) this.#onBatch(r.aid, s); break
      case 'PostToolUseFailure': if (r.aid !== null) this.#onFailure(r, r.aid, s); break
      case 'PostToolUse': this.#onPost(r, s); break
      case 'SubagentStop': this.#snapshotTasks(s, r.bt); this.#onStop(r, s); break
      case 'Stop': this.#snapshotTasks(s, r.bt); break
      case 'SessionEnd': this.#onSessionEnd(r, s); break
      default: this.stats.otherEvents++
    }
  }

  #session(sid: string): Session {
    let s = this.#sessions.get(sid)
    if (!s) {
      s = { key: `s${hex8(hash32(sid))}`, L: this.#clock, S: 0, inside: 0, banner: false, runs: new Set(), runsListed: 0 }
      this.#sessions.set(sid, s)
    }
    return s
  }

  #touch(w: Worker, s: Session) {
    if (w.sess !== s) { w.sess.inside--; s.inside++; w.sess = s }
    w.sLast = s.S
    w.ovQ = 0
  }

  #learnType(w: Worker, at: string | null) {
    if (at === null || at === '') return
    w.at = at
    if (at === 'workflow-subagent') w.helper = 'workflow'
  }

  /** An inside worker for an agent id: a GONE one walks back in (to an arrival hold); null for an unknown id. */
  #known(aid: string, s: Session): Worker | null {
    const w = this.#byAid.get(aid)
    if (w === undefined) { this.stats.phantom++; return null }
    if (w.phase === 'gone') { this.#enter(aid, s); this.#touch(w, s); this.#arrivalHold(w) }
    return w
  }

  /** Create (or walk back in) the worker of an agent id. */
  #enter(aid: string, s: Session): Worker {
    let w = this.#byAid.get(aid)
    if (w === undefined) {
      const seed = hash32(aid, SEED_SALT)
      w = {
        key: this.#uniqueKey(aid), aid, n: this.#nextN++, seed, front: (seed >>> 8) & 1 ? 'armsD' : 'ponderD', sess: s, lives: 0,
        at: null, helper: this.#bgIds.has(aid) ? 'background' : null, phase: 'gone', phaseSince: this.#clock, disp: 'gone', dispSince: this.#clock,
        place: null, role: null, forKind: null, station: null, activity: 'none', sub: 'unit', hadCall: false, calls: new Map(), inFlight: 0,
        batchKind: null, unitBg: false, callStart: this.#clock, gapStart: null, actSeq: 0, result: null, fgCheck: null, pull: null, fin: null,
        finStep: null, finArrive: null, finAt: null, stopSeen: false, handedIn: false, holdOutCapAt: null, bgJob: null, gated: false, graceAt: null,
        holdFailed: false, sLast: s.S, ovQ: 0, listed: false, absent: 0, slot: null, sent: null, queued: [],
      }
      this.#byAid.set(aid, w)
      this.#byKey.set(w.key, w)
      this.stats.created++
    } else if (w.phase !== 'gone') return w
    else this.stats.reentries++
    const back = w.lives > 0
    w.lives++
    if (this.#bgIds.has(aid) && w.helper !== 'workflow') w.helper = 'background'
    w.sess = s
    s.inside++
    this.#inside++
    this.stats.maxInside = Math.max(this.stats.maxInside, this.#inside)
    this.#setPhase(w, 'arriving')
    w.slot = this.#claimSlot(w.key)
    this.#emit({ op: 'spawn', t: this.#clock, key: w.key, n: w.n, seed: w.seed, slot: w.slot ?? -1, back })
    return w
  }

  #uniqueKey(aid: string): WorkerKey {
    const base = `w${hex8(hash32(aid))}`
    let k = base
    for (let i = 2; this.#byKey.has(k); i++) k = `${base}-${i}`
    return k
  }

  #claimSlot(key: WorkerKey): number | null {
    const i = this.#slots.indexOf(null)
    if (i < 0) return null
    this.#slots[i] = key
    return i
  }

  #freeSlot(w: Worker) {
    if (w.slot !== null) { this.#slots[w.slot] = null; w.slot = null }
  }

  #arrivalHold(w: Worker) {
    const res = this.#book.hold(w.key, 'arrival', originOf(this.layout, w.place))
    this.#applyChanges(res.changes)
    if (res.place === null) w.holdFailed = true
    else this.#setPhase(w, 'hold')
  }

  #onStart(r: SpoolRecord, s: Session) {
    if (r.aid === null) { this.stats.phantom++; return }
    if (r.at === '') { this.stats.internalStart++; return }
    const known = this.#byAid.get(r.aid)
    if (known !== undefined && known.phase !== 'gone') {         // §4.2: a Start for a worker inside does nothing
      this.#touch(known, s)
      this.#learnType(known, r.at)
      this.stats.startInside++
      return
    }
    const w = this.#enter(r.aid, s)
    this.#learnType(w, r.at)
    this.#touch(w, s)
    this.#arrivalHold(w)
  }

  /** A record's category at the worker's current station (classify.mjs resolveAtStation: the library rule). */
  #resolve(r: SpoolRecord, w: Worker): { activity: string; station: StationKind | null } {
    const a = r.a
    const text = a !== null ? ACTIVITY_BY_ID.get(a) : undefined
    if (a === null || text === undefined) return { activity: 'none', station: stationForKind(r.k) }
    const [act, kind] = resolveAtStation(text, r.k, r.tsr, w.station)
    const station = stationForKind(kind)
    // a call that moves nobody keeps its own label: ToolSearch away from the library reads "looking up a tool", a
    // roster look "looking at the roster" (the classifier's 'no move' is about the station, not the activity)
    return { activity: station === null ? a : ACTIVITY_ID.get(act) ?? 'none', station }
  }

  #onPre(r: SpoolRecord, aid: string, s: Session) {
    if (!this.#byAid.has(aid)) {
      if (r.at === '') { this.stats.internalPre++; return }
      if (r.a === 'report') { this.stats.handbackFirst++; return }   // the hand-back-first guard (probe 11, ruling 7)
    }
    const w = this.#enter(aid, s)
    this.#learnType(w, r.at)
    this.#touch(w, s)
    if (w.phase === 'paused' || w.phase === 'waiting') {           // §4.2: any Pre cancels the pause / the wait
      w.bgJob = null; w.gated = false; w.graceAt = null; w.absent = 0
      this.#setPhase(w, 'station')
    }
    if (w.inFlight === 0) w.batchKind = null
    w.inFlight++
    w.hadCall = true
    const res = this.#resolve(r, w)
    const callKey = r.tu ?? `#${r.seq}`
    w.calls.set(callKey, { tu: r.tu, a: res.activity, kind: res.station, to: r.to, fail: false, intr: false, launched: false })
    if (r.bg) w.bgJob = 'shell'
    if (res.activity === 'watch') w.bgJob = 'monitor'
    w.gapStart = null
    if (r.a === 'report') { this.#finReport(w); return }
    if (r.a === 'form') { this.#finForm(w); return }
    const st = res.station
    if (st === null) {                                             // §4.2: no kind -> STAY, the label only
      if (w.batchKind === null) w.activity = res.activity
      return
    }
    if (w.batchKind !== null && rank(st) > rank(w.batchKind)) return   // §4.3 P1: the step's winner stays
    if (w.fin !== null || w.phase === 'handedIn') this.#cancelFin(w)    // §4.9: FIN_* before the stop, Pre(K') -> AT
    if (w.phase !== 'station') this.#setPhase(w, 'station')
    w.batchKind = st
    w.activity = res.activity
    w.unitBg = r.bg
    w.sub = 'unit'
    w.callStart = this.#clock
    this.#assign(w, st, res.activity)
    if (res.activity === 'helper-bg') w.fgCheck = { at: this.#clock + TIMING.fgCheck, call: callKey }
    this.#act(w, true)
  }

  /** Book a station (PlaceBook.assign: STAY, own point, sibling, pool tile or queued). */
  #assign(w: Worker, st: StationKind, activity: string): 'own' | 'sibling' | 'pool' | 'queued' | 'stay' {
    const fetch = SHELF_ROOM[st] !== undefined && activity !== 'glance' && activity !== 'stash'
    const res = this.#book.assign(w.key, st, originOf(this.layout, w.place), { fetch })
    this.#applyChanges(res.changes)
    w.station = st
    return res.how
  }

  /** Learn every booking change (the acting worker's and the cascades': served, moved up, stepped aside, pulls). */
  #applyChanges(changes: readonly Change[]) {
    for (const c of changes) {
      const o = this.#byKey.get(c.owner)
      if (o === undefined) continue
      o.place = c.to
      o.role = c.role
      o.forKind = c.forKind
      if (c.to !== null) this.#freeSlot(o)
      if (c.role === 'pull' && c.to !== null) o.pull = { id: c.seq, at: this.#clock + walkMs(this.layout, c.from, c.to) + PULL_MS }
      else if (o.pull !== null) o.pull = null
      if (o.fin !== null && o.finStep === 'carry' && o.finArrive === null && c.to !== null && c.role === 'use' && c.forKind === 'frontDesk') {
        o.finArrive = this.#clock + walkMs(this.layout, c.from, c.to)
      }
    }
  }

  /** A finisher already standing at its desk spot (assign was a STAY): the hand-in starts now. */
  #finAtDesk(w: Worker) {
    if (w.finStep !== 'carry' || w.finArrive !== null) return
    const h = this.#book.holding(w.key)
    if (h !== null && h.role === 'use' && h.forKind === 'frontDesk') this.#arriveFire(w)
  }

  /** At the desk spot: hand in and sign (0.5 + 1.5 s), or sign out (1.5 s). */
  #arriveFire(w: Worker) {
    w.finArrive = null
    w.finStep = 'handIn'
    w.finAt = this.#clock + (w.fin === 'signout' ? SIGN_MS : HAND_IN_MS + SIGN_MS)
  }

  #act(w: Worker, inCall: boolean) {
    if (inCall) w.actSeq++
    w.queued.push({ op: 'act', t: this.#clock, key: w.key, seq: w.actSeq, kind: w.station, activity: w.activity, inCall })
  }

  #finReport(w: Worker) {
    this.#cancelFin(w)
    w.fin = 'report'
    w.finStep = 'printing'
    this.#setPhase(w, 'finishing')
    w.batchKind = 'printer'
    w.activity = 'report'
    w.sub = 'unit'
    w.callStart = this.#clock
    this.#assign(w, 'printer', 'report')
    this.#act(w, true)
  }

  #finForm(w: Worker) {
    this.#cancelFin(w)
    w.fin = 'form'
    w.finStep = 'carry'
    this.#setPhase(w, 'finishing')
    w.batchKind = 'frontDesk'
    w.activity = 'form'
    w.sub = 'unit'
    w.callStart = this.#clock
    if (this.#assign(w, 'frontDesk', 'form') === 'stay') this.#finAtDesk(w)
    this.#act(w, true)
  }

  #cancelFin(w: Worker) {
    w.fin = null; w.finStep = null; w.finArrive = null; w.finAt = null; w.holdOutCapAt = null; w.stopSeen = false
  }

  #onBatch(aid: string, s: Session) {
    const w = this.#known(aid, s)
    if (w === null) return
    this.#touch(w, s)
    if (w.inFlight === 0) { this.stats.batchNoOpen++; return }   // calls without a Pre are never drawn (probe 2)
    const closed = [...w.calls.values()]
    w.calls.clear()
    w.inFlight = 0
    w.batchKind = null
    w.fgCheck = null
    if (w.phase === 'station') {
      const st = w.station
      if ((st === 'benchTerminal' || st === 'pcDesk') && closed.some(c => c.kind === st)) {
        if (w.result) this.#resultFire(w)
        w.result = {
          at: this.#clock + TIMING.result, seq: w.actSeq, place: w.place, fail: closed.some(c => c.fail), intr: closed.some(c => c.intr),
          tus: new Set(closed.flatMap(c => (c.tu === null ? [] : [c.tu]))),
        }
      }
      w.sub = 'stage1'
      w.gapStart = this.#clock
    }
    this.#act(w, false)
  }

  #onFailure(r: SpoolRecord, aid: string, s: Session) {
    const w = this.#known(aid, s)
    if (w === null) return
    this.#touch(w, s)
    const mark = (o: { fail: boolean; intr: boolean }) => { if (r.intr) o.intr = true; else o.fail = true }
    const call = r.tu !== null ? w.calls.get(r.tu) : undefined
    if (call !== undefined) { mark(call); return }
    if (w.result !== null && r.tu !== null && w.result.tus.has(r.tu)) { mark(w.result); return }   // after its Batch
    this.stats.failureUnmatched++
  }

  #resultFire(w: Worker) {
    const res = w.result
    if (res === null) return
    w.result = null
    const result: CallResult = res.fail ? 'fail' : res.intr || !this.options.failureHookInstalled ? 'neutral' : 'ok'
    w.queued.push({ op: 'callEnd', t: this.#clock, key: w.key, seq: res.seq, place: res.place, result })
  }

  #fgFire(w: Worker) {
    const fg = w.fgCheck
    w.fgCheck = null
    if (fg === null) return
    const call = w.calls.get(fg.call)
    if (call === undefined || call.launched) return
    // §4.2: still in flight 5 s after the Pre with no async_launched: a foreground call -> the meeting table
    call.a = 'helper-fg'
    w.batchKind = 'meetingTable'
    w.activity = 'helper-fg'
    w.sub = 'unit'
    w.callStart = this.#clock
    this.#assign(w, 'meetingTable', 'helper-fg')
    this.#act(w, true)
  }

  #pullFire(w: Worker) {
    const p = w.pull
    w.pull = null
    if (p !== null) this.#applyChanges(this.#book.endPull(w.key, p.id))
  }

  #onPost(r: SpoolRecord, s: Session) {
    if (r.a === 'report') {                                        // Post SubagentHandback: collect, carry to the desk
      if (r.aid === null) return
      const w = this.#known(r.aid, s)
      if (w === null) return
      this.#touch(w, s)
      if (w.fin === 'report' && w.finStep === 'printing') {
        w.finStep = 'carry'
        if (this.#assign(w, 'frontDesk', 'report') === 'stay') this.#finAtDesk(w)
      }
      return
    }
    if (r.a === 'helper-bg' || r.a === 'helper-fg') {              // Post Agent
      const launcher = r.aid !== null ? this.#known(r.aid, s) : null
      const launched = r.st === 'async_launched' || r.st === 'remote_launched'
      if (launcher !== null) {
        this.#touch(launcher, s)
        const call = r.tu !== null ? launcher.calls.get(r.tu) : undefined
        if (call !== undefined && launched) call.launched = true
        if (launched) {                                            // §4.2: the helper drops a ticket in the IN tray
          this.#inTray++
          launcher.bgJob = 'helper'
          launcher.fgCheck = null
        }
      }
      if (r.ch !== null) {
        const child = this.#byAid.get(r.ch)
        if (launched) {
          if (child === undefined) this.#bgIds.add(r.ch)
          else if (child.helper !== 'workflow') child.helper = 'background'
        } else if (r.st === 'completed' && child !== undefined && child.phase !== 'gone') this.#finished(child)
      }
      return
    }
    if (r.tid !== null) { s.runs.add(r.tid); return }              // Post Workflow: runs join on tid (probe 5)
    this.stats.otherPosts++
  }

  #onStop(r: SpoolRecord, s: Session) {
    if (r.aid === null) { this.stats.stopUnknown++; return }
    const w = this.#byAid.get(r.aid)
    if (w === undefined || w.phase === 'gone') { this.stats.stopUnknown++; return }   // never creates, never re-enters
    if (r.at === null || r.at === '') { this.stats.stopUngated++; return }          // ruling 4: a non-empty type
    this.#touch(w, s)
    this.#learnType(w, r.at)
    if (w.inFlight > 0) { this.stats.stopInFlight++; return }                       // §4.2: ignored
    if (w.fin === 'report' && w.finStep === 'printing') this.#cancelFin(w)          // a hand-back with no Post
    if (w.handedIn || w.fin !== null) { this.#finished(w); return }                 // §4.6 Finishing wins
    if (w.helper === 'background') {
      this.#setPhase(w, 'paused')
      w.gated = w.bgJob !== null
      w.graceAt = w.gated ? this.#clock + TIMING.grace : null
      return
    }
    this.#finished(w)                                              // a workflow agent or a foreground helper
  }

  /** FINISHED (§4.2): leave if it handed in, finish the hand-in first, else sign out at the front desk. */
  #finished(w: Worker) {
    if (w.handedIn || w.phase === 'handedIn') { this.#leave(w, 'finished', 'out'); return }
    if (w.fin === 'report' || w.fin === 'form') { w.stopSeen = true; return }
    if (w.fin === 'signout') return
    w.fin = 'signout'
    w.finStep = 'carry'
    w.graceAt = null
    this.#setPhase(w, 'finishing')
    if (this.#assign(w, 'frontDesk', w.activity) === 'stay') this.#finAtDesk(w)
  }

  #finFire(w: Worker) {
    w.finAt = null
    if (w.fin === 'signout') { this.#leave(w, 'finished', 'out'); return }
    w.handedIn = true
    this.#outStack++
    const stopped = w.stopSeen
    w.fin = null
    w.finStep = null
    w.stopSeen = false
    if (stopped) { this.#leave(w, 'finished', 'out'); return }
    this.#setPhase(w, 'handedIn')
    this.#applyChanges(this.#book.hold(w.key, 'departure', originOf(this.layout, w.place)).changes)
    w.holdOutCapAt = this.#clock + TIMING.holdOutCap
  }

  #graceFire(w: Worker) {
    w.graceAt = null
    if (w.phase !== 'paused' || !w.gated) return
    this.#setPhase(w, 'waiting')
    this.#assign(w, 'lounge', 'none')
  }

  #snapshotTasks(s: Session, bt: readonly BtEntry[] | null) {
    if (bt === null) return
    this.stats.snapshots++
    const listed = new Set<string>()
    let runs = 0
    for (const e of bt) {
      if (e.id === null) continue
      if (e.type === 'subagent') listed.add(e.id)
      else if (e.type === 'workflow' && s.runs.has(e.id)) runs++
    }
    s.runsListed = runs
    for (const id of listed) {                                     // a listed helper is a background helper (probe 5)
      const w = this.#byAid.get(id)
      if (w === undefined) { this.#bgIds.add(id); continue }
      if (w.helper !== 'workflow') w.helper = 'background'
      if (w.phase !== 'gone') { w.listed = true; w.absent = 0 }
    }
    if (bt.length >= MAX_BT) return                                // maybe cut by the hook: no absence counted
    for (const w of [...this.#byKey.values()]) {
      if (w.phase === 'gone' || w.sess !== s || !w.listed || listed.has(w.aid)) continue
      w.absent++
      if (w.phase === 'waiting' || (w.phase === 'paused' && w.gated)) continue      // never a WAITING worker
      const expected = w.phase === 'paused' || w.phase === 'handedIn'
      if (expected || w.absent >= 2) this.#leave(w, 'finishedInferred', 'out')
    }
  }

  #onSessionEnd(r: SpoolRecord, s: Session) {
    if (r.r === 'clear' || r.r === 'resume') { this.stats.sessionEndKept++; return }   // §4.2: nobody is removed
    this.stats.sessionEndRemoved++
    for (const w of [...this.#byKey.values()]) if (w.phase !== 'gone' && w.sess === s) this.#leave(w, 'sessionEnded', 'out')
  }

  // ── leaving ────────────────────────────────────────────────────────────────────────────────────────────────────
  #leave(w: Worker, reason: ExitReason, via: 'out' | 'direct') {
    this.#applyChanges(this.#book.release(w.key))
    this.stats.exits[reason]++
    this.#emit({ op: 'leave', t: this.#clock, key: w.key, reason, via })
    this.#gone(w)
  }

  #fade(w: Worker, reason: ExitReason) {
    this.#applyChanges(this.#book.release(w.key))
    this.stats.exits[reason]++
    this.#emit({ op: 'fade', t: this.#clock, key: w.key, reason })
    this.#gone(w)
  }

  #gone(w: Worker) {
    this.#accountDisp(w, 'gone')
    this.#setPhase(w, 'gone')
    this.#freeSlot(w)
    w.sess.inside--
    this.#inside--
    if (w.sess.inside === 0) this.#bannerClear(w.sess)
    w.place = null; w.role = null; w.forKind = null; w.station = null
    w.activity = 'none'; w.sub = 'unit'; w.hadCall = false; w.calls.clear(); w.inFlight = 0; w.batchKind = null; w.unitBg = false
    w.gapStart = null; w.result = null; w.fgCheck = null; w.pull = null
    w.fin = null; w.finStep = null; w.finArrive = null; w.finAt = null; w.stopSeen = false; w.handedIn = false; w.holdOutCapAt = null
    w.bgJob = null; w.gated = false; w.graceAt = null; w.holdFailed = false; w.ovQ = 0; w.listed = false; w.absent = 0
    w.sent = null
    w.queued = []
  }

  #setPhase(w: Worker, p: Phase) {
    if (w.phase === p) return
    w.phase = p
    w.phaseSince = this.#clock
    this.stats.phaseEntries[p] = (this.stats.phaseEntries[p] ?? 0) + 1
  }

  #accountDisp(w: Worker, d: string) {
    if (w.disp === d) return
    if (w.disp !== 'gone') this.stats.dispMs[w.disp] = (this.stats.dispMs[w.disp] ?? 0) + (this.#clock - w.dispSince)
    w.disp = d
    w.dispSince = this.#clock
  }

  // ── output ─────────────────────────────────────────────────────────────────────────────────────────────────────
  #emit(c: Cmd) { this.#out.push(c) }

  /** Emit what changed for every worker inside (walkTo, pose, bubble, then its queued act / callEnd), then the
   *  office objects. */
  #flush() {
    for (const w of this.#byKey.values()) {
      if (w.phase === 'gone') continue
      const v = this.#view(w)
      const p = w.sent
      const t = this.#clock
      if (v.place !== null && (p === null || p.place !== v.place)) this.#emit({ op: 'walkTo', t, key: w.key, place: v.place })
      if (p === null || p.pose !== v.pose || p.prop !== v.prop || p.belt !== v.belt || p.filler !== v.filler) this.#emit({ op: 'pose', t, key: w.key, pose: v.pose, prop: v.prop, belt: v.belt, filler: v.filler })
      if (p === null || p.label !== v.label || p.n !== v.n || p.st !== v.st) this.#emit({ op: 'bubble', t, key: w.key, label: v.label, n: v.n, st: v.st })
      w.sent = v
      for (const c of w.queued) this.#emit(c)
      w.queued = []
      this.#accountDisp(w, w.phase === 'station' ? (w.inFlight > 0 ? 'inCall' : w.sub === 'stage2' ? 'between2' : 'between1') : w.phase)
    }
    const o = this.#objectsView()
    const sig = `${o.rackLeds}|${o.magnets.join(',')}|${o.outStack}|${o.inTray}`
    if (sig !== this.#sentObjects) {
      this.#sentObjects = sig
      this.#emit({ op: 'objects', t: this.#clock, ...o })
    }
  }

  #objectsView(): ObjectsView {
    let rackLeds = 0
    const magnets: number[] = []
    for (const w of this.#byKey.values()) {
      if (w.phase === 'gone') continue
      if (w.inFlight > 0) rackLeds++
      magnets.push(w.n)
    }
    return { rackLeds, magnets, outStack: this.#outStack, inTray: this.#inTray }
  }

  #longDiffers(w: Worker): boolean {
    const a = this.#stanceAt(w, 'unit'), b = this.#stanceAt(w, 'long')
    return a !== null && b !== null && (a.pose !== b.pose || a.prop !== b.prop)
  }

  /** The station stance at the worker's place, or null where the place shows its own pose (pool tile, parked, none). */
  #stanceAt(w: Worker, sub: Sub): Stance | null {
    const place = w.place
    if (place === null || w.role === null || w.role === 'wait' || w.role === 'parked' || w.role === 'hold' || w.role === 'reserved') return null
    const kind = (w.role === 'sibling' ? this.layout.stationOf(place) : null) ?? w.forKind ?? w.station
    if (kind === null) return null
    return stance({ kind, activity: w.activity, sub, role: w.role, placePose: placePose(this.layout, place), seat: isSeat(this.layout, place), front: w.front, bg: w.unitBg })
  }

  /** What the worker shows: its place, pose, prop, filler flag and label (§4.4, §4.5, §4.6, §4.10). */
  #view(w: Worker): Sent {
    const place = w.place
    const seat = place !== null && isSeat(this.layout, place)
    const own = (): PoseName => (place === null ? 'standU' : w.role === 'parked' ? (seat ? 'sitBack' : 'standU') : placePose(this.layout, place))
    const waitingFor = this.#book.waiterOf(w.key)?.kind ?? null
    let pose: PoseName = own()
    let prop: PropId | null = null
    let filler = false
    let label: LabelId
    let n: number | null = null
    let st: StationKind | null = null
    switch (w.phase) {
      case 'arriving':
        pose = 'standU'
        label = w.lives > 1 ? 'back' : w.holdFailed ? 'slotWait' : 'arriving'
        break
      case 'hold':
        label = w.inFlight > 0 ? activityLabel(w.activity) : w.hadCall ? 'between' : 'arrivalHold'
        break
      case 'station': {
        const s = this.#stanceAt(w, w.sub)
        if (s !== null) { pose = s.pose; prop = s.prop; filler = w.sub === 'stage2' }
        if (waitingFor !== null) {
          st = waitingFor
          if (w.role === 'wait') { label = 'waitPool'; n = this.layout.stations.get(waitingFor)!.points.length } else label = 'waitQueued'
        } else label = w.inFlight > 0 ? activityLabel(w.activity) : 'between'
        break
      }
      case 'finishing':
        if (w.role !== 'wait' && w.role !== 'parked' && place !== null) pose = w.finStep === 'printing' ? 'standU' : 'useU0'
        prop = w.fin === 'form' ? 'form' : w.fin === 'report' && w.finStep !== 'printing' ? 'printout' : null
        if (waitingFor !== null) label = 'finishQueue'
        else if (w.finStep === 'printing') label = 'act:report'
        else if (w.fin === 'signout') label = 'signOut'
        else if (w.finStep === 'handIn') label = 'handIn'                   // at the desk spot (after the walk ETA)
        else label = w.fin === 'form' ? 'carryForm' : 'carryReport'
        break
      case 'handedIn':
        label = 'handedIn'
        break
      case 'paused': {
        const s = this.#stanceAt(w, 'stage2')
        if (s !== null) { pose = s.pose; prop = s.prop }
        label = w.gated && w.bgJob !== null ? JOB_LABEL[w.bgJob] : this.options.handbackMode ? 'pausedUnknown' : 'pausedNoHandback'
        break
      }
      case 'waiting':
        prop = 'pager'
        if (w.role !== 'parked' && place !== null) pose = seat ? 'sitBack' : 'readD'
        label = w.bgJob !== null ? JOB_LABEL[w.bgJob] : 'waitHelper'
        break
      default:
        label = 'leaving'
    }
    if (w.phase !== 'waiting' && w.phase !== 'handedIn') {         // quiet overlays (§4.6 "Killed or silent")
      const q = w.ovQ
      const mins = Math.floor(q / 60_000)
      if (w.inFlight > 0) {
        const stuck = this.#stuckAt(w)
        if (stuck !== null && q >= stuck) { label = 'stuck'; n = mins; st = null }
        else if (q >= TIMING.running) { label = 'running'; n = mins; st = null }
      } else if (q >= TIMING.suspect) { label = 'suspect'; n = mins; st = null }
      else if (q >= TIMING.quiet) { label = 'quiet'; n = mins; st = null }
    }
    // §4.4 bench row: a background launch clips a pager to the belt; it stays there while the launch is the worker's
    // outstanding background work (until a Pre resumes it from a pause or a wait); WAITING holds it in the hand.
    const belt = w.bgJob !== null && w.phase !== 'waiting' && prop !== 'pager'
    return { place, pose, prop, belt, filler, label, n, st }
  }
}
