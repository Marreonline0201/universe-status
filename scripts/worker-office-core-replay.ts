// Worker office observer core: synthetic replays, invariants, mutants, then the real spool (plan §6.4 "Observer
// core"). Run: node scripts/worker-office-core-replay.ts [--no-real] [--print <dir>]
//   --no-real      skip the real-spool replay (the npm test script uses it: the spool exists only on the owner's
//                  computer)
//   --print <dir>  write each scenario's formatted command sequence to <dir> (for review; never into the repo)
//
// 1. Static checks: every classifier activity id has a label; every floorplan place pose maps to a figure frame;
//    every label renders with its parameters.
// 2. Scenarios (synthetic spools, §6.4's list plus a retry pair and a re-entry). Each feeds spool LINES to the core
//    the way the page will (in file order, delivered 300 ms after the hook started, a tick every 500 ms) and asserts
//    the EXACT command sequence (golden strings below, reviewed against the plan), and on every step:
//      I0  command times never go back;
//      I1  no two workers on one place (a ledger rebuilt ONLY from the emitted walkTo / leave / fade commands);
//      I2  the place a worker was last sent to is the place the reservation book holds for it, and the book holds
//          nothing for a worker that is not inside;
//      I3  every booking is released on leave (no holding, no wait-list entry for a worker that left);
//      I4  every pose is a figure frame (props.ts POSES), every label is in the label set and renders, every
//          activity is a classifier activity id;
//      I5  commands only for workers inside (spawn only for one outside);
//      I6  after dispose(): no output, no booking, no waiter, whatever comes in;
//      I7  determinism: the same input gives the same commands (each scenario runs twice);
//      I8  the §5.3 feed messages round-trip to the same commands; the snapshot's places = the ledger.
// 3. Mutants: each planted change of the core (patched from its source text, each patch asserted to apply exactly
//    once, loaded from a temp copy) must make at least one check fail; the table names which.
// 4. The REAL spool (C:/Users/ddogr/.universe-office/spool/events-2026-10-01.jsonl, category-only by construction):
//    read locally, never copied; replayed twice (determinism) with every invariant; prints COUNTS ONLY. Absent:
//    "not run: data absent", exit 3.
// Exit: 0 all pass; 1 a failure; 3 the real spool is absent (synthetic checks passed).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { loadMap } from '../src/worker-office/map/loadMap.ts'
import { buildPlaceLayout, type PlaceLayout } from '../src/worker-office/map/places.ts'
import { POSES, PROP_IDS } from '../src/worker-office/render/props.ts'
import * as realCore from '../src/worker-office/core/reducer.ts'
import { LABEL_IDS, LABELS, isLabelId, labelText } from '../src/worker-office/core/labels.ts'
import type { Cmd } from '../src/worker-office/core/messages.ts'
import { floorPose } from '../src/worker-office/core/places.ts'
import { ACTIVITY_BY_ID, ACTIVITY_ID } from '../office/observer/classify.mjs'

type CoreMod = typeof realCore
type Core = InstanceType<CoreMod['ObserverCore']>

const args = process.argv.slice(2)
const NO_REAL = args.includes('--no-real')
const PRINT_DIR = args.includes('--print') ? args[args.indexOf('--print') + 1] : null
const SPOOL = 'C:/Users/ddogr/.universe-office/spool/events-2026-10-01.jsonl'

const MAP = loadMap(JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8')))
const LAYOUT: PlaceLayout = buildPlaceLayout(MAP)
const POSE_SET: ReadonlySet<string> = new Set(POSES)
const PROP_SET: ReadonlySet<string> = new Set(PROP_IDS)

let failures = 0
const fail = (msg: string) => { failures++; console.log(`FAIL ${msg}`) }
const ok = (cond: boolean, msg: string) => { if (!cond) fail(msg) }

// ── spool lines ──────────────────────────────────────────────────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 9, 1, 16, 0, 0)
const SA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', SB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
interface Line { readonly ts: number; readonly line: string }
const at = (s: number) => T0 + Math.round(s * 1000)
const L = (s: number, ev: string, f: Record<string, unknown> = {}): Line => {
  const o: Record<string, unknown> = { v: 1, ts: at(s), sid: SA, ev, ...f }
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return { ts: o.ts as number, line: JSON.stringify(o) }
}
/** The classifier's kind for each activity id used here (classify.mjs). */
const KIND: Record<string, string | undefined> = {
  read: 'fileCabinet', search: 'fileCabinet', list: 'fileCabinet', write: 'pcDesk', run: 'benchTerminal', wait: 'benchTerminal',
  watch: 'benchTerminal', report: 'printer', form: 'frontDesk', 'helper-bg': 'frontDesk', 'helper-fg': 'meetingTable',
  'hist-read': 'historyShelf', fetch: 'bookshelf', tasks: 'kanbanBoard', ask: 'frontDesk', none: undefined, toolsearch: undefined,
}
const start = (s: number, aid: string, atype = 'workflow-subagent', f: Record<string, unknown> = {}) => L(s, 'SubagentStart', { aid, at: atype, ...f })
const pre = (s: number, aid: string | undefined, a: string, tu: string, f: Record<string, unknown> = {}) => L(s, 'PreToolUse', { aid, k: KIND[a], a, tu, ...f })
const batch = (s: number, aid: string | undefined, n = 1, f: Record<string, unknown> = {}) => L(s, 'PostToolBatch', { aid, n, ...f })
const failure = (s: number, aid: string, tu: string, intr = false) => L(s, 'PostToolUseFailure', { aid, tu, intr })
const postAgent = (s: number, aid: string | undefined, st: string, ch: string, tu: string) => L(s, 'PostToolUse', { aid, k: st === 'completed' ? 'meetingTable' : 'frontDesk', a: st === 'completed' ? 'helper-fg' : 'helper-bg', tu, st, ch })
const postReport = (s: number, aid: string, tu: string) => L(s, 'PostToolUse', { aid, k: 'printer', a: 'report', tu })
const sstop = (s: number, aid: string, atype: string | undefined, bt: object[] = [], f: Record<string, unknown> = {}) => L(s, 'SubagentStop', { aid, at: atype, bt, ...f })
const istop = (s: number, i: number, bt: object[] = []) => sstop(s, `z${String(i).padStart(16, '0')}`, '', bt)
const mstop = (s: number, bt: object[] = []) => L(s, 'Stop', { bt })
const sessEnd = (s: number, r: string | undefined, sid = SA) => L(s, 'SessionEnd', { r, sid })
const sub = (id: string) => ({ id, type: 'subagent', status: 'running' })
/** Internal stops every 32 s from `from` to `to` (keep the session active; each carries a task list). */
const storm = (from: number, to: number, bt: object[] = [], i0 = 0): Line[] => {
  const out: Line[] = []
  for (let s = from, i = i0; s <= to; s += 32, i++) out.push(istop(s, i, bt))
  return out
}
const byTs = (ls: Line[]) => [...ls].sort((a, b) => a.ts - b.ts)

// ── one run ──────────────────────────────────────────────────────────────────────────────────────────────────────
class Run {
  readonly core: Core
  readonly cmds: Cmd[] = []
  readonly violations: string[] = []
  readonly ledger = new Map<string, string>()
  readonly inside = new Set<string>()
  readonly everInside = new Set<string>()
  readonly names = new Map<string, number>()
  #lastT = -Infinity
  #disposed = false

  readonly mod: CoreMod
  constructor(mod: CoreMod, opts: Partial<realCore.CoreOptions> = {}) { this.mod = mod; this.core = new mod.ObserverCore(LAYOUT, opts) }

  v(msg: string) { if (this.violations.length < 20) this.violations.push(msg); else if (this.violations.length === 20) this.violations.push('...') }
  ingest(line: string, wall: number) { this.#take(this.core.ingest(line, wall)) }
  tick(wall: number) { this.#take(this.core.tick(wall)) }
  /** dispose() is a teardown (no commands): the renderer drops its workers with it, so the ledger does too. */
  dispose() {
    const out = this.core.dispose()
    this.#disposed = true
    this.inside.clear()
    this.ledger.clear()
    this.#take(out)
  }

  #take(out: Cmd[]) {
    if (this.#disposed && out.length > 0) this.v(`I6 ${out.length} commands after dispose`)
    for (const c of out) this.#one(c)
    this.cmds.push(...out)
    this.#checkState()
    if (this.#disposed) this.#checkDisposed()
  }

  #one(c: Cmd) {
    if (c.t < this.#lastT) this.v(`I0 time goes back: ${c.op} at ${c.t} after ${this.#lastT}`)
    this.#lastT = Math.max(this.#lastT, c.t)
    if (c.op === 'objects' || c.op === 'banner') {
      if (c.op === 'banner' && c.label !== null && !isLabelId(c.label)) this.v(`I4 banner label ${c.label}`)
      return
    }
    if (c.op === 'spawn') {
      if (this.inside.has(c.key)) this.v(`I5 spawn of ${c.key} already inside`)
      this.inside.add(c.key); this.everInside.add(c.key); this.names.set(c.key, c.n)
      return
    }
    if (!this.inside.has(c.key)) { this.v(`I5 ${c.op} for ${c.key} not inside`); return }
    switch (c.op) {
      case 'walkTo':
        try { LAYOUT.placeId(c.place) } catch { this.v(`I4 walkTo an unknown place ${c.place}`) }
        this.ledger.set(c.key, c.place)
        break
      case 'pose':
        if (!POSE_SET.has(c.pose)) this.v(`I4 pose ${c.pose} is not a figure frame`)
        if (c.prop !== null && !PROP_SET.has(c.prop)) this.v(`I4 prop ${c.prop}`)
        break
      case 'bubble':
        if (!isLabelId(c.label)) { this.v(`I4 label ${c.label} is not in the label set`); break }
        try { labelText(c.label, { n: c.n, st: c.st }) } catch (e) { this.v(`I4 ${String(e)}`) }
        break
      case 'act':
        if (!ACTIVITY_BY_ID.has(c.activity)) this.v(`I4 activity ${c.activity}`)
        break
      case 'leave': case 'fade':
        this.inside.delete(c.key); this.ledger.delete(c.key)
        break
    }
  }

  #checkState() {
    const book = this.core.book
    const seen = new Map<string, string>()
    for (const [k, p] of this.ledger) {
      const other = seen.get(p)
      if (other !== undefined) this.v(`I1 #${this.names.get(k)} and #${this.names.get(other)} both on ${p}`)
      seen.set(p, k)
    }
    for (const k of this.inside) {
      const held = book.holding(k)?.place ?? null
      const sent = this.ledger.get(k) ?? null
      if (held !== sent) this.v(`I2 #${this.names.get(k)} was sent to ${sent} but the book holds ${held}`)
    }
    for (const h of book.holdings()) if (!this.inside.has(h.owner)) this.v(`I2 the book holds ${h.place} for ${h.owner}, who is not inside`)
    for (const k of this.everInside) {
      if (this.inside.has(k)) continue
      if (book.holding(k) !== null || book.waiterOf(k) !== null) this.v(`I3 #${this.names.get(k)} left but keeps a booking or a wait`)
    }
  }

  #checkDisposed() {
    const book = this.core.book
    if (book.holdings().length > 0 || book.waiters().length > 0) this.v(`I6 ${book.holdings().length} bookings / ${book.waiters().length} waiters after dispose`)
  }

  /** I8: the feed round trip and the snapshot. */
  checkFeed() {
    if (!isDeepStrictEqual(this.mod.fromFeedMessages(this.mod.toFeedMessages(this.cmds)), this.cmds)) this.v('I8 the feed messages do not round-trip')
    if (this.#disposed) return
    const snap = this.core.snapshot()
    if (snap.type !== 'WORKERS_SNAPSHOT') { this.v('I8 snapshot type'); return }
    const fromSnap = new Map(snap.workers.flatMap(w => (w.place === null ? [] : [[w.key, w.place] as const])))
    if (!isDeepStrictEqual(fromSnap, this.ledger) || snap.workers.length !== this.inside.size) this.v('I8 the snapshot differs from the ledger')
  }
}

interface PlayOpts { readonly delayMs?: number; readonly tickMs?: number; readonly tailS?: number; readonly core?: Partial<realCore.CoreOptions>; readonly disposeThen?: Line[] }

/** Feed lines in FILE order: line i is read at wall = max(previous wall, ts + delay); a tick every tickMs between
 *  lines and for tailS after the last. A line that is not JSON is read right after the previous one. */
function play(mod: CoreMod, lines: readonly (Line | string)[], o: PlayOpts = {}): Run {
  const run = new Run(mod, o.core)
  const delay = o.delayMs ?? 300, every = o.tickMs ?? 500
  let wall = -Infinity
  for (const item of lines) {
    const ts = typeof item === 'string' ? wall : item.ts + delay
    const w = Math.max(wall, ts)
    if (Number.isFinite(wall)) for (let t = wall + every; t < w; t += every) run.tick(t)
    wall = w
    run.ingest(typeof item === 'string' ? item : item.line, wall)
  }
  const end = wall + (o.tailS ?? 5) * 1000
  for (let t = wall + every; t <= end; t += every) run.tick(t)
  run.checkFeed()
  if (o.disposeThen) {
    run.dispose()
    for (const l of o.disposeThen) { run.ingest(l.line, l.ts + delay); run.tick(l.ts + delay + 2000) }
  }
  return run
}

function fmt(run: Run, opts: { objects?: boolean } = {}): string[] {
  const out: string[] = []
  const nm = (k: string) => `#${run.names.get(k) ?? '?'}`
  for (const c of run.cmds) {
    const t = ((c.t - T0) / 1000).toFixed(3)
    switch (c.op) {
      case 'spawn': out.push(`${t} spawn #${c.n} slot${c.slot}${c.back ? ' back' : ''}`); break
      case 'walkTo': out.push(`${t} walkTo ${nm(c.key)} ${c.place}`); break
      case 'pose': out.push(`${t} pose ${nm(c.key)} ${c.pose}${c.prop ? `+${c.prop}` : ''}${c.belt ? '+belt' : ''}${c.filler ? ' filler' : ''}`); break
      case 'bubble': out.push(`${t} bubble ${nm(c.key)} ${c.label}${c.n !== null ? ` n=${c.n}` : ''}${c.st !== null ? ` st=${c.st}` : ''}`); break
      case 'act': out.push(`${t} act ${nm(c.key)} ${c.inCall ? 'in' : 'out'} ${c.kind ?? '-'} ${c.activity} seq${c.seq}`); break
      case 'callEnd': out.push(`${t} callEnd ${nm(c.key)} ${c.result} seq${c.seq} ${c.place ?? '-'}`); break
      case 'leave': out.push(`${t} leave ${nm(c.key)} ${c.reason} ${c.via}`); break
      case 'fade': out.push(`${t} fade ${nm(c.key)} ${c.reason}`); break
      case 'objects': if (opts.objects) out.push(`${t} objects leds=${c.rackLeds} magnets=${c.magnets.join(',')} out=${c.outStack} in=${c.inTray}`); break
      case 'banner': out.push(`${t} banner ${c.scope} ${c.label ?? 'clear'}${c.since !== null ? ` since=${((c.since - T0) / 1000).toFixed(3)}` : ''}`); break
    }
  }
  return out
}

// ── the scenarios ────────────────────────────────────────────────────────────────────────────────────────────────
const A = 'a00000000000000a1', B = 'a00000000000000b2', C = 'a00000000000000c3', D = 'a00000000000000d4'

interface Scenario {
  readonly name: string
  /** What it shows (plan sections). */
  readonly what: string
  readonly lines: () => (Line | string)[]
  readonly opts?: PlayOpts
  readonly objects?: boolean
  /** Extra assertions on the run (stats, an equal sequence from another feed order, ...). */
  readonly extra?: (run: Run, mod: CoreMod) => string[]
}

const S: Scenario[] = [
  {
    name: 'S1a-lifecycle-workflow',
    what: '§4.2/§4.4/§4.5/§4.6: Start -> arrival hold; read at a cabinet, the same-kind gesture, stage 1, stage 2 (filler) at 10 s; the desk (long-call pose at 4 s, green result 1 s after the Batch); the result form; the stop while handing in -> leaves after the hand-in. Objects asserted exactly.',
    objects: true,
    lines: () => [
      start(0, A), pre(2, A, 'read', 't1'), batch(3, A), pre(20, A, 'read', 't2'), pre(20.2, A, 'search', 't3'), batch(21, A, 2),
      pre(40, A, 'write', 't4'), batch(45, A), pre(50, A, 'form', 't5'), batch(50.5, A), sstop(51, A, 'workflow-subagent'),
    ],
    opts: { tailS: 20 },
  },
  {
    name: 'S1b-handback-background',
    what: '§4.2/§4.6: a background helper (main\'s async launch, ch) launches a bg shell (pager), hands back (printer -> carry -> desk -> departure hold) and leaves on its stop: Finishing wins over the background pause. The main thread draws nothing.',
    lines: () => [
      pre(40, undefined, 'helper-bg', 'm1'), start(40.1, B, 'general-purpose'), postAgent(40.2, undefined, 'async_launched', B, 'm1'),
      pre(41, B, 'run', 'u1', { bg: true }), batch(41.5, B), pre(45, B, 'report', 'u2'), postReport(46, B, 'u2'), batch(46.2, B),
      sstop(60, B, 'general-purpose', [sub(B)]),
    ],
    opts: { tailS: 5 },
  },
  {
    name: 'S1c-signout-and-cap',
    what: '§4.2/§4.6: a foreground helper\'s stop -> sign-out at the desk (1.5 s) -> leaves; a workflow agent that hands in a form and never stops -> departure hold -> the 90 s cap.',
    lines: () => [
      start(0, C, 'general-purpose'), pre(1, C, 'read', 'c1'), batch(2, C), sstop(5, C, 'general-purpose'),
      start(10, `agent-${D}`), pre(11, D, 'form', 'd1'), batch(11.5, D),
    ],
    opts: { tailS: 110 },
  },
  {
    name: 'S2-reorder',
    what: '§4.1 Ordering, probe 7, ruling 2: lines written out of ts order (a Post(Workflow) 383 ms late behind its run\'s Start, a Failure 25 ms late behind its Batch, a Pre 105 ms late), a torn line, a version-2 line, a parse_error record and legacy/unknown fields: the commands equal those of the same records in ts order.',
    lines: () => REORDER_FILE(),
    extra: (run, mod) => {
      const out: string[] = []
      const valid = REORDER_FILE().filter((x): x is Line => typeof x !== 'string' && JSON.parse(x.line).v === 1 && JSON.parse(x.line).ev !== 'parse_error')
      const sorted = play(mod, byTs(valid))
      if (!isDeepStrictEqual(sorted.cmds, run.cmds)) out.push('the file order and the ts order give different commands')
      const st = run.core.stats
      if (st.torn !== 1 || st.version !== 1 || st.parseErrors !== 1 || st.late !== 0) out.push(`stats torn=${st.torn} version=${st.version} parseErrors=${st.parseErrors} late=${st.late}`)
      return out
    },
  },
  {
    name: 'S3-results',
    what: '§4.5 call results: a Failure written after its Batch (earlier ts) -> red; a Failure with a ts 300 ms after the Batch -> red (the 1.0 s window); none -> green "no failure recorded"; an interrupt -> neutral; a desk call -> red line; a Failure after the window -> too late (green, counted). With no Failure hook: neutral instead of green.',
    lines: () => [
      start(0, A), pre(1, A, 'run', 'f1'), batch(2, A), failure(1.975, A, 'f1'),
      pre(10, A, 'run', 'f2'), batch(12, A), failure(12.3, A, 'f2'),
      pre(20, A, 'run', 'f3'), batch(22, A),
      pre(30, A, 'run', 'f4'), failure(31, A, 'f4', true), batch(31.1, A),
      pre(40, A, 'write', 'f5'), failure(41, A, 'f5'), batch(41.02, A),
      pre(50, A, 'run', 'f6'), batch(52, A), failure(53.5, A, 'f6'),
    ],
    extra: (run, mod) => {
      const out: string[] = []
      if (run.core.stats.failureUnmatched !== 1) out.push(`failureUnmatched ${run.core.stats.failureUnmatched}`)
      const noHook = play(mod, S.find(x => x.name === 'S3-results')!.lines(), { core: { failureHookInstalled: false } })
      const res = noHook.cmds.flatMap(c => (c.op === 'callEnd' ? [c.result] : []))
      if (res.join(',') !== 'fail,fail,neutral,neutral,fail,neutral') out.push(`without the Failure hook: ${res.join(',')}`)
      return out
    },
  },
  {
    name: 'S4-session-end',
    what: '§4.2 SessionEnd: clear and resume remove nobody; logout, an absent reason and other remove that session\'s workers only; prompt_input_exit ends the second session.',
    lines: () => byTs([
      start(0, A), pre(1, A, 'read', 's1'), batch(2, A),
      start(0.5, B, 'workflow-subagent', { sid: SB }), pre(1.5, B, 'read', 's2', { sid: SB }), batch(2.5, B, 1, { sid: SB }),
      sessEnd(10, 'clear'), sessEnd(11, 'resume'), sessEnd(20, 'logout'),
      start(30, C), pre(31, C, 'read', 's3'), batch(32, C), sessEnd(40, undefined),
      start(50, D), pre(51, D, 'write', 's4'), batch(52, D), sessEnd(60, 'other'),
      sessEnd(70, 'prompt_input_exit', SB),
    ]),
    extra: run => {
      const st = run.core.stats
      return st.sessionEndKept === 2 && st.sessionEndRemoved === 4 && st.exits.sessionEnded === 4 ? [] : [`sessionEnd kept ${st.sessionEndKept} removed ${st.sessionEndRemoved} exits ${st.exits.sessionEnded}`]
    },
  },
  {
    name: 'S5-phantoms',
    what: '§4.1 who creates a worker, probe 11, ruling 7: a Batch / Failure / hand-back Post / stop of an unknown id, a hand-back-first Pre (and its Batch), a Start and a Pre with an empty type create nobody; a Pre with an id and no Start creates one (a3f8).',
    lines: () => [
      batch(1, B), failure(2, B, 'p1'), postReport(3, B, 'p2'), sstop(4, B, 'general-purpose'),
      pre(5, C, 'report', 'p3'), batch(6, C),
      start(7, D, ''), pre(8, 'a00000000000000w1', 'read', 'p4', { at: '' }),
      pre(10, A, 'read', 'p5'), batch(11, A), sstop(12, 'a00000000000000x2', 'general-purpose'),
    ],
    extra: run => {
      const st = run.core.stats
      const got = `created=${st.created} phantom=${st.phantom} handbackFirst=${st.handbackFirst} internalStart=${st.internalStart} internalPre=${st.internalPre} stopUnknown=${st.stopUnknown}`
      return got === 'created=1 phantom=4 handbackFirst=1 internalStart=1 internalPre=1 stopUnknown=2' ? [] : [got]
    },
  },
  {
    name: 'S6a-killed-and-quiet',
    what: '§4.6 Killed or silent, probe 5, ruling: a background helper seen in the task list ends on absence only after 2 snapshots in a row (one gap, then listed again, is kept); a workflow agent (never listed) gets "no events for N min", then "may have stopped?", and is evicted at 30 min of SESSION-ACTIVE time (the session\'s 10 min of silence does not count; it gets the 5 min banner).',
    lines: () => {
      const K = 'a00000000000000f1', Q = 'a00000000000000f2'
      return byTs([
        start(0, K, 'general-purpose'), postAgent(0.1, undefined, 'async_launched', K, 'mk'), pre(1, K, 'read', 'k1'), batch(2, K),
        mstop(5, [sub(K)]), start(9, Q), pre(10, Q, 'read', 'l1'), batch(11, Q),
        istop(40, 1, [sub(K)]), istop(72, 2, [sub(K)]), istop(104, 3), istop(136, 4, [sub(K)]), istop(168, 5), istop(200, 6),
        ...storm(232, 600, [], 10), ...storm(1200, 2400, [], 100),
      ])
    },
    opts: { tailS: 2 },
  },
  {
    name: 'S6b-waiting-cap',
    what: '§4.2/§4.6, probe 5, ruling: a background helper with a bg shell stops -> waiting for its background job (shell) -> the lounge after 15 s, pager in hand; absent from every later task list, it is never ended by the list; it leaves at the WAITING cap (2 h 10 min of session-active time).',
    lines: () => {
      const M = 'a00000000000000f3'
      return byTs([
        start(0, M, 'general-purpose'), postAgent(0.1, undefined, 'async_launched', M, 'mm'), pre(1, M, 'run', 'm1', { bg: true }), batch(1.5, M),
        mstop(2, [sub(M)]), sstop(3, M, 'general-purpose', [sub(M)]), ...storm(40, 8000),
      ])
    },
    opts: { tailS: 2 },
  },
  {
    name: 'S7-stray-stop-storm',
    what: 'probe 4, ruling 4: 21 internal stops (fresh ids, empty type, every 32 s) and two stops on a known worker with an empty or absent type change nothing; the worker only gets its quiet labels.',
    lines: () => byTs([start(0, A), pre(1, A, 'read', 'q1'), batch(2, A), ...storm(10, 650), sstop(100, A, ''), sstop(150, A, undefined)]),
    extra: run => {
      const st = run.core.stats
      return st.stopUnknown === 21 && st.stopUngated === 2 && st.created === 1 ? [] : [`stopUnknown ${st.stopUnknown} stopUngated ${st.stopUngated} created ${st.created}`]
    },
  },
  {
    name: 'S8-office-clear',
    what: '§4.6 caps: 2 h without any spool event (wall clock) fades everyone and shows "office cleared"; the session banner shows at 5 min; the next event clears the banner and walks the worker back in (same look); a Batch walks a cleared worker back to an arrival hold.',
    lines: () => byTs([
      start(0, A), pre(1, A, 'read', 'h1'), batch(2, A), start(0.5, B), pre(3, B, 'wait', 'h2', { to: 600 }),
      pre(7800, A, 'run', 'h3'), batch(7900, B),
    ]),
    opts: { tailS: 5 },
    extra: run => (run.core.stats.batchNoOpen === 1 ? [] : [`batchNoOpen ${run.core.stats.batchNoOpen}`]),
  },
  {
    name: 'S9-retry-pair',
    what: 'probe 1: a workflow agent replaced by a retry gives no end event: both are on screen; the silent one is labelled, then evicted at 30 min (session-active, kept alive by the retry), the retry finishes normally.',
    lines: () => {
      const R1 = 'a00000000000000r1', R2 = 'a00000000000000r2'
      return byTs([
        start(0, R1), pre(1, R1, 'read', 'x1'), batch(2, R1),
        start(240, R2), pre(241, R2, 'read', 'x2'), batch(242, R2),
        ...[540, 840, 1140, 1440, 1740].flatMap((t, i) => [pre(t, R2, 'read', `x${i + 3}`), batch(t + 1, R2)]),
        pre(1900, R2, 'form', 'x9'), batch(1900.5, R2), sstop(1901, R2, 'workflow-subagent'), ...storm(10, 1990),
      ])
    },
    opts: { tailS: 5 },
  },
  {
    name: 'S10-re-entry',
    what: 'probe 14, §4.6: a worker that left walks back in on a new Start with the same ordinal and look; a worker evicted during a long call (running, may be stuck?, evicted) walks back in on its Batch, to an arrival hold, and signs out.',
    lines: () => {
      const H = 'a00000000000000h1', J = 'a00000000000000j1'
      return byTs([
        start(0, H), pre(1, H, 'read', 'y1'), batch(2, H), pre(3, H, 'form', 'y2'), batch(3.5, H), sstop(4, H, 'workflow-subagent'),
        start(5, J), pre(6, J, 'wait', 'y3', { to: 600 }),
        start(100, H), pre(101, H, 'run', 'y4'), batch(102, H), sstop(110, H, 'workflow-subagent'),
        ...storm(20, 1950), batch(1900, J), sstop(1910, J, 'workflow-subagent'),
      ])
    },
    opts: { tailS: 15 },
    extra: run => {
      const sp = run.cmds.flatMap(c => (c.op === 'spawn' ? [c] : []))
      const h = sp.filter(c => c.n === 1), j = sp.filter(c => c.n === 2)
      const good = h.length === 2 && j.length === 2 && h[0].seed === h[1].seed && j[0].seed === j[1].seed && h[1].back && j[1].back && !h[0].back && !j[0].back
      return good && run.core.stats.reentries === 2 ? [] : ['a re-entry keeps neither the ordinal nor the look']
    },
  },
  {
    name: 'S11-lounge',
    what: '§4.2/§4.6, ruling 3: a background helper with a bg shell, and one with a Monitor (a=watch), stop -> paused "waiting for its background job" -> the lounge after 15 s; a Pre resumes one; a background helper that launched nothing pauses in place ("reason unknown") and ends on its first absence from the task list (an expected end); a stop with a call in flight is ignored.',
    lines: () => {
      const G1 = 'a00000000000000g1', G2 = 'a00000000000000g2', G3 = 'a00000000000000g3', G4 = 'a00000000000000g4'
      return byTs([
        start(0, G1, 'general-purpose'), postAgent(0.1, undefined, 'async_launched', G1, 'n1'), pre(1, G1, 'run', 'g1', { bg: true }), batch(1.5, G1),
        sstop(3, G1, 'general-purpose', [sub(G1)]),
        start(0.5, G2, 'general-purpose'), postAgent(0.6, undefined, 'async_launched', G2, 'n2'), pre(2, G2, 'watch', 'g2'), batch(2.5, G2),
        sstop(4, G2, 'general-purpose', [sub(G1), sub(G2)]),
        start(5, G3, 'general-purpose'), postAgent(5.1, undefined, 'async_launched', G3, 'n3'), pre(6, G3, 'read', 'g3'), batch(7, G3),
        sstop(8, G3, 'general-purpose'), mstop(9, [sub(G1), sub(G2), sub(G3)]),
        start(10, G4, 'general-purpose'), postAgent(10.1, undefined, 'async_launched', G4, 'n4'), pre(11, G4, 'run', 'g4', { bg: true }),
        sstop(12, G4, 'general-purpose'), batch(13, G4),
        mstop(40, [sub(G1), sub(G2)]), mstop(72, [sub(G1)]), pre(100, G1, 'read', 'g9'), batch(101, G1),
      ])
    },
    opts: { tailS: 5 },
    extra: run => (run.core.stats.stopInFlight === 1 ? [] : [`stopInFlight ${run.core.stats.stopInFlight}`]),
  },
  {
    name: 'S12-batches-and-stations',
    what: '§4.3 P1 (a parallel batch by precedence; the newest batch wins), the same-kind gesture, probe 2 (n above the open count; a Batch with nothing open), fetch-then-read (history: pull, then a records reading place; bookshelf: pull, then the reading ledge), the 5 s foreground rule (-> meeting table), a Post(Agent completed) for an unknown child, a no-kind STAY, ToolSearch at a library station (-> manuals) and elsewhere (STAY), a background launch with its ticket.',
    lines: () => [
      start(0, A), pre(1, A, 'read', 'b1'), pre(1.01, A, 'run', 'b2'), pre(1.02, A, 'search', 'b3'), batch(3, A, 3),
      pre(10, A, 'read', 'b4'), pre(10.01, A, 'read', 'b5'), batch(11, A, 5), batch(12, A, 1),
      pre(20, A, 'hist-read', 'b6'), batch(25, A),
      pre(30, A, 'helper-bg', 'b7'), postAgent(50, A, 'completed', 'a00000000000000q1', 'b7'), batch(50.1, A),
      pre(60, A, 'none', 'b8'), batch(60.5, A),
      pre(70, A, 'fetch', 'b9'), batch(72, A), pre(80, A, 'toolsearch', 'b10'), batch(81, A),
      pre(90, A, 'run', 'b11'), batch(91, A), pre(100, A, 'toolsearch', 'b12'), batch(101, A),
      pre(110, A, 'helper-bg', 'b13'), postAgent(112, A, 'async_launched', 'a00000000000000q2', 'b13'), batch(112.1, A),
    ],
    opts: { tailS: 5 },
    extra: run => {
      const snap = run.core.snapshot()
      const tray = snap.type === 'WORKERS_SNAPSHOT' ? snap.objects.inTray : -1
      return run.core.stats.batchNoOpen === 1 && tray === 1 ? [] : [`batchNoOpen ${run.core.stats.batchNoOpen} inTray ${tray}`]
    },
  },
]

S.push(
  {
    name: 'S2b-late-beyond-window',
    what: 'probe 7: a record written 5 s after a later one (beyond the 500 ms watermark and the 1.0 s flush) is applied late, at the clock, and counted; time never goes back.',
    lines: () => [start(0, A), pre(1, A, 'read', 'v1'), batch(2, A), pre(10, A, 'write', 'v2'), start(5, B), batch(11, A)],
    extra: run => (run.core.stats.late === 1 ? [] : [`late ${run.core.stats.late}`]),
  },
  {
    name: 'S13-front-desk-rush',
    what: '§4.6 "a fifth simultaneous finisher": 5 result forms at once -> 2 desk spots, the 2 queue tiles (a FIFO line), the fifth waits at its own station keeping its booking ("finishing: waiting for the front desk"); each hand-in frees a spot, the line moves up, the waiting one is served; every finisher leaves after its hand-in (its stop came already).',
    lines: () => {
      const W = ['a0000000000000k01', 'a0000000000000k02', 'a0000000000000k03', 'a0000000000000k04', 'a0000000000000k05']
      return byTs([
        ...W.flatMap((w, i) => [start(i * 0.1, w), pre(1 + i * 0.1, w, 'read', `e${i}`), batch(2 + i * 0.1, w)]),
        ...W.flatMap((w, i) => [pre(10 + i * 0.01, w, 'form', `f${i}`), batch(10.5 + i * 0.01, w), sstop(11 + i * 0.01, w, 'workflow-subagent')]),
      ])
    },
    opts: { tailS: 30 },
    extra: run => (run.core.stats.exits.finished === 5 ? [] : [`finished ${run.core.stats.exits.finished}`]),
  },
)

/** S2's file order: the lines as the hooks wrote them. */
function REORDER_FILE(): (Line | string)[] {
  const W1 = A, W2 = B
  const v2: Line = { ts: at(4), line: JSON.stringify({ v: 2, ts: at(4), sid: SA, ev: 'PreToolUse', aid: W1, k: 'pcDesk', a: 'write', tu: 'zz' }) }
  const perr: Line = { ts: at(4.2), line: JSON.stringify({ v: 1, ts: at(4.2), ev: 'parse_error' }) }
  return [
    start(0, W1), pre(1, W1, 'run', 'r1'), start(1.883, W2),
    L(1.5, 'PostToolUse', { k: 'kanbanBoard', a: 'tasks', tu: 'm9', st: 'async_launched', tid: 'wfaaaa111' }),
    batch(3, W1, 1, { run: 'wf_x', dur: 12, cpu: 3, rss: 40, zz: 'unknown' }), failure(2.975, W1, 'r1'),
    pre(3.605, W1, 'write', 'r3'), pre(3.5, W2, 'read', 'r2'),
    '{"v":1,"ts":17', v2, perr, batch(5, W2), batch(6, W1),
  ]
}

// The goldens (reviewed against the plan; see each scenario's `what`).
const EXPECTED: Record<string, string> = {
  'S1a-lifecycle-workflow': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
0.000 objects leds=0 magnets=1 out=0 in=0
2.000 walkTo #1 cab-18.1
2.000 pose #1 readU+folder
2.000 bubble #1 act:read
2.000 act #1 in fileCabinet read seq1
2.000 objects leds=1 magnets=1 out=0 in=0
3.000 bubble #1 between
3.000 act #1 out fileCabinet read seq1
3.000 objects leds=0 magnets=1 out=0 in=0
13.000 pose #1 armsD+folder filler
20.000 pose #1 readU+folder
20.000 bubble #1 act:read
20.000 act #1 in fileCabinet read seq2
20.000 objects leds=1 magnets=1 out=0 in=0
20.200 pose #1 useU0
20.200 bubble #1 act:search
20.200 act #1 in fileCabinet search seq3
21.000 pose #1 readU+folder
21.000 bubble #1 between
21.000 act #1 out fileCabinet search seq3
21.000 objects leds=0 magnets=1 out=0 in=0
31.000 pose #1 armsD+folder filler
40.000 walkTo #1 desk-1.1
40.000 pose #1 type0
40.000 bubble #1 act:write
40.000 act #1 in pcDesk write seq4
40.000 objects leds=1 magnets=1 out=0 in=0
44.000 pose #1 sitBack
45.000 bubble #1 between
45.000 act #1 out pcDesk write seq4
45.000 objects leds=0 magnets=1 out=0 in=0
46.000 callEnd #1 ok seq4 desk-1.1
50.000 walkTo #1 front-desk.2
50.000 pose #1 useU0+form
50.000 bubble #1 carryForm
50.000 act #1 in frontDesk form seq5
50.000 objects leds=1 magnets=1 out=0 in=0
50.500 act #1 out frontDesk form seq5
50.500 objects leds=0 magnets=1 out=0 in=0
58.125 bubble #1 handIn
60.125 leave #1 finished out
60.125 objects leds=0 magnets= out=1 in=0`,
  'S1b-handback-background': `40.100 spawn #1 slot0
40.100 walkTo #1 inout-board.1
40.100 pose #1 standU
40.100 bubble #1 arrivalHold
41.000 walkTo #1 bench-5.1
41.000 pose #1 useU0+pager
41.000 bubble #1 act:run
41.000 act #1 in benchTerminal run seq1
41.500 pose #1 standU+belt
41.500 bubble #1 between
41.500 act #1 out benchTerminal run seq1
42.500 callEnd #1 ok seq1 bench-5.1
45.000 walkTo #1 printer.1
45.000 bubble #1 act:report
45.000 act #1 in printer report seq2
46.000 walkTo #1 front-desk.2
46.000 pose #1 useU0+printout+belt
46.000 bubble #1 carryReport
46.200 act #1 out frontDesk report seq2
48.500 bubble #1 handIn
50.500 walkTo #1 hold-1
50.500 pose #1 stand+belt
50.500 bubble #1 handedIn
60.000 leave #1 finished out`,
  'S1c-signout-and-cap': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
5.000 walkTo #1 front-desk.2
5.000 pose #1 useU0
5.000 bubble #1 signOut
10.000 spawn #2 slot0
10.000 walkTo #2 inout-board.1
10.000 pose #2 standU
10.000 bubble #2 arrivalHold
11.000 walkTo #2 front-desk.1
11.000 pose #2 useU0+form
11.000 bubble #2 carryForm
11.000 act #2 in frontDesk form seq1
11.188 leave #1 finished out
11.500 act #2 out frontDesk form seq1
13.500 bubble #2 handIn
15.500 walkTo #2 hold-1
15.500 pose #2 stand
15.500 bubble #2 handedIn
105.500 leave #2 signOffCap out`,
  'S2-reorder': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 bench-5.1
1.000 pose #1 watchU
1.000 bubble #1 act:run
1.000 act #1 in benchTerminal run seq1
1.883 spawn #2 slot0
1.883 walkTo #2 inout-board.1
1.883 pose #2 standU
1.883 bubble #2 arrivalHold
3.000 pose #1 standU
3.000 bubble #1 between
3.000 act #1 out benchTerminal run seq1
3.500 walkTo #2 cab-18.1
3.500 pose #2 readU+folder
3.500 bubble #2 act:read
3.500 act #2 in fileCabinet read seq1
3.605 walkTo #1 desk-1.1
3.605 pose #1 type0
3.605 bubble #1 act:write
3.605 act #1 in pcDesk write seq2
4.000 callEnd #1 fail seq1 bench-5.1
5.000 bubble #2 between
5.000 act #2 out fileCabinet read seq1
6.000 pose #1 sitBack
6.000 bubble #1 between
6.000 act #1 out pcDesk write seq2
7.000 callEnd #1 ok seq2 desk-1.1`,
  'S3-results': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 bench-5.1
1.000 pose #1 watchU
1.000 bubble #1 act:run
1.000 act #1 in benchTerminal run seq1
2.000 pose #1 standU
2.000 bubble #1 between
2.000 act #1 out benchTerminal run seq1
3.000 callEnd #1 fail seq1 bench-5.1
10.000 pose #1 watchU
10.000 bubble #1 act:run
10.000 act #1 in benchTerminal run seq2
12.000 pose #1 standU
12.000 bubble #1 between
12.000 act #1 out benchTerminal run seq2
13.000 callEnd #1 fail seq2 bench-5.1
20.000 pose #1 watchU
20.000 bubble #1 act:run
20.000 act #1 in benchTerminal run seq3
22.000 pose #1 standU
22.000 bubble #1 between
22.000 act #1 out benchTerminal run seq3
23.000 callEnd #1 ok seq3 bench-5.1
30.000 pose #1 watchU
30.000 bubble #1 act:run
30.000 act #1 in benchTerminal run seq4
31.100 pose #1 standU
31.100 bubble #1 between
31.100 act #1 out benchTerminal run seq4
32.100 callEnd #1 neutral seq4 bench-5.1
40.000 walkTo #1 desk-1.1
40.000 pose #1 type0
40.000 bubble #1 act:write
40.000 act #1 in pcDesk write seq5
41.020 pose #1 sitBack
41.020 bubble #1 between
41.020 act #1 out pcDesk write seq5
42.020 callEnd #1 fail seq5 desk-1.1
50.000 walkTo #1 bench-1.1
50.000 pose #1 watchU
50.000 bubble #1 act:run
50.000 act #1 in benchTerminal run seq6
52.000 pose #1 standU
52.000 bubble #1 between
52.000 act #1 out benchTerminal run seq6
53.000 callEnd #1 ok seq6 bench-1.1`,
  'S4-session-end': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
0.500 spawn #2 slot0
0.500 walkTo #2 inout-board.2
0.500 pose #2 standU
0.500 bubble #2 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
1.500 walkTo #2 cab-17.1
1.500 pose #2 readU+folder
1.500 bubble #2 act:read
1.500 act #2 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
2.500 bubble #2 between
2.500 act #2 out fileCabinet read seq1
12.000 pose #1 armsD+folder filler
12.500 pose #2 ponderD+folder filler
20.000 leave #1 sessionEnded out
30.000 spawn #3 slot0
30.000 walkTo #3 inout-board.1
30.000 pose #3 standU
30.000 bubble #3 arrivalHold
31.000 walkTo #3 cab-18.1
31.000 pose #3 readU+folder
31.000 bubble #3 act:read
31.000 act #3 in fileCabinet read seq1
32.000 bubble #3 between
32.000 act #3 out fileCabinet read seq1
40.000 leave #3 sessionEnded out
50.000 spawn #4 slot0
50.000 walkTo #4 inout-board.1
50.000 pose #4 standU
50.000 bubble #4 arrivalHold
51.000 walkTo #4 desk-1.1
51.000 pose #4 type0
51.000 bubble #4 act:write
51.000 act #4 in pcDesk write seq1
52.000 pose #4 sitBack
52.000 bubble #4 between
52.000 act #4 out pcDesk write seq1
53.000 callEnd #4 ok seq1 desk-1.1
60.000 leave #4 sessionEnded out
70.000 leave #2 sessionEnded out`,
  'S5-phantoms': `10.000 spawn #1 slot0
10.000 walkTo #1 cab-18.1
10.000 pose #1 readU+folder
10.000 bubble #1 act:read
10.000 act #1 in fileCabinet read seq1
11.000 bubble #1 between
11.000 act #1 out fileCabinet read seq1`,
  'S6a-killed-and-quiet': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
9.000 spawn #2 slot0
9.000 walkTo #2 inout-board.1
9.000 pose #2 standU
9.000 bubble #2 arrivalHold
10.000 walkTo #2 cab-17.1
10.000 pose #2 readU+folder
10.000 bubble #2 act:read
10.000 act #2 in fileCabinet read seq1
11.000 bubble #2 between
11.000 act #2 out fileCabinet read seq1
12.000 pose #1 ponderD+folder filler
21.000 pose #2 ponderD+folder filler
122.000 bubble #1 quiet n=2
131.000 bubble #2 quiet n=2
182.000 bubble #1 quiet n=3
191.000 bubble #2 quiet n=3
200.000 leave #1 finishedInferred out
251.000 bubble #2 quiet n=4
311.000 bubble #2 quiet n=5
371.000 bubble #2 quiet n=6
431.000 bubble #2 quiet n=7
491.000 bubble #2 quiet n=8
551.000 bubble #2 quiet n=9
611.000 bubble #2 quiet n=10
671.000 bubble #2 quiet n=11
884.000 banner session sessionQuiet since=584.000
1200.000 banner session clear
1227.000 bubble #2 quiet n=12
1287.000 bubble #2 quiet n=13
1347.000 bubble #2 quiet n=14
1407.000 bubble #2 suspect n=15
1467.000 bubble #2 suspect n=16
1527.000 bubble #2 suspect n=17
1587.000 bubble #2 suspect n=18
1647.000 bubble #2 suspect n=19
1707.000 bubble #2 suspect n=20
1767.000 bubble #2 suspect n=21
1827.000 bubble #2 suspect n=22
1887.000 bubble #2 suspect n=23
1947.000 bubble #2 suspect n=24
2007.000 bubble #2 suspect n=25
2067.000 bubble #2 suspect n=26
2127.000 bubble #2 suspect n=27
2187.000 bubble #2 suspect n=28
2247.000 bubble #2 suspect n=29
2307.000 leave #2 evicted direct`,
  'S6b-waiting-cap': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 bench-5.1
1.000 pose #1 useU0+pager
1.000 bubble #1 act:run
1.000 act #1 in benchTerminal run seq1
1.500 pose #1 standU+belt
1.500 bubble #1 between
1.500 act #1 out benchTerminal run seq1
2.500 callEnd #1 ok seq1 bench-5.1
3.000 pose #1 ponderD+belt
3.000 bubble #1 waitShell
18.000 walkTo #1 sofa.3
18.000 pose #1 sitBack+pager
7803.000 leave #1 waitCap direct`,
  'S7-stray-stop-storm': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
12.000 pose #1 armsD+folder filler
122.000 bubble #1 quiet n=2
182.000 bubble #1 quiet n=3
242.000 bubble #1 quiet n=4
302.000 bubble #1 quiet n=5
362.000 bubble #1 quiet n=6
422.000 bubble #1 quiet n=7
482.000 bubble #1 quiet n=8
542.000 bubble #1 quiet n=9
602.000 bubble #1 quiet n=10`,
  'S8-office-clear': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
0.500 spawn #2 slot0
0.500 walkTo #2 inout-board.2
0.500 pose #2 standU
0.500 bubble #2 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
3.000 walkTo #2 bench-5.1
3.000 pose #2 watchU
3.000 bubble #2 act:wait
3.000 act #2 in benchTerminal wait seq1
12.000 pose #1 armsD+folder filler
63.000 bubble #2 running n=1
122.000 bubble #1 quiet n=2
123.000 bubble #2 running n=2
303.000 banner session sessionQuiet since=3.000
7203.000 fade #1 officeCleared
7203.000 fade #2 officeCleared
7203.000 banner session clear
7203.000 banner office officeCleared since=3.000
7800.000 banner office clear
7800.000 spawn #1 slot0 back
7800.000 walkTo #1 bench-5.1
7800.000 pose #1 watchU
7800.000 bubble #1 act:run
7800.000 act #1 in benchTerminal run seq2
7860.000 bubble #1 running n=1
7900.000 spawn #2 slot0 back
7900.000 walkTo #2 inout-board.1
7900.000 pose #2 standU
7900.000 bubble #2 arrivalHold`,
  'S9-retry-pair': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
12.000 pose #1 ponderD+folder filler
122.000 bubble #1 quiet n=2
182.000 bubble #1 quiet n=3
240.000 spawn #2 slot0
240.000 walkTo #2 inout-board.1
240.000 pose #2 standU
240.000 bubble #2 arrivalHold
241.000 walkTo #2 cab-17.1
241.000 pose #2 readU+folder
241.000 bubble #2 act:read
241.000 act #2 in fileCabinet read seq1
242.000 bubble #1 quiet n=4
242.000 bubble #2 between
242.000 act #2 out fileCabinet read seq1
252.000 pose #2 armsD+folder filler
302.000 bubble #1 quiet n=5
362.000 bubble #1 quiet n=6
362.000 bubble #2 quiet n=2
422.000 bubble #1 quiet n=7
422.000 bubble #2 quiet n=3
482.000 bubble #1 quiet n=8
482.000 bubble #2 quiet n=4
540.000 pose #2 readU+folder
540.000 bubble #2 act:read
540.000 act #2 in fileCabinet read seq2
541.000 bubble #2 between
541.000 act #2 out fileCabinet read seq2
542.000 bubble #1 quiet n=9
551.000 pose #2 armsD+folder filler
602.000 bubble #1 quiet n=10
661.000 bubble #2 quiet n=2
662.000 bubble #1 quiet n=11
721.000 bubble #2 quiet n=3
722.000 bubble #1 quiet n=12
781.000 bubble #2 quiet n=4
782.000 bubble #1 quiet n=13
840.000 pose #2 readU+folder
840.000 bubble #2 act:read
840.000 act #2 in fileCabinet read seq3
841.000 bubble #2 between
841.000 act #2 out fileCabinet read seq3
842.000 bubble #1 quiet n=14
851.000 pose #2 armsD+folder filler
902.000 bubble #1 suspect n=15
961.000 bubble #2 quiet n=2
962.000 bubble #1 suspect n=16
1021.000 bubble #2 quiet n=3
1022.000 bubble #1 suspect n=17
1081.000 bubble #2 quiet n=4
1082.000 bubble #1 suspect n=18
1140.000 pose #2 readU+folder
1140.000 bubble #2 act:read
1140.000 act #2 in fileCabinet read seq4
1141.000 bubble #2 between
1141.000 act #2 out fileCabinet read seq4
1142.000 bubble #1 suspect n=19
1151.000 pose #2 armsD+folder filler
1202.000 bubble #1 suspect n=20
1261.000 bubble #2 quiet n=2
1262.000 bubble #1 suspect n=21
1321.000 bubble #2 quiet n=3
1322.000 bubble #1 suspect n=22
1381.000 bubble #2 quiet n=4
1382.000 bubble #1 suspect n=23
1440.000 pose #2 readU+folder
1440.000 bubble #2 act:read
1440.000 act #2 in fileCabinet read seq5
1441.000 bubble #2 between
1441.000 act #2 out fileCabinet read seq5
1442.000 bubble #1 suspect n=24
1451.000 pose #2 armsD+folder filler
1502.000 bubble #1 suspect n=25
1561.000 bubble #2 quiet n=2
1562.000 bubble #1 suspect n=26
1621.000 bubble #2 quiet n=3
1622.000 bubble #1 suspect n=27
1681.000 bubble #2 quiet n=4
1682.000 bubble #1 suspect n=28
1740.000 pose #2 readU+folder
1740.000 bubble #2 act:read
1740.000 act #2 in fileCabinet read seq6
1741.000 bubble #2 between
1741.000 act #2 out fileCabinet read seq6
1742.000 bubble #1 suspect n=29
1751.000 pose #2 armsD+folder filler
1802.000 leave #1 evicted direct
1861.000 bubble #2 quiet n=2
1900.000 walkTo #2 front-desk.2
1900.000 pose #2 useU0+form
1900.000 bubble #2 carryForm
1900.000 act #2 in frontDesk form seq7
1900.500 act #2 out frontDesk form seq7
1904.375 bubble #2 handIn
1906.375 leave #2 finished out`,
  'S10-re-entry': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
3.000 walkTo #1 front-desk.2
3.000 pose #1 useU0+form
3.000 bubble #1 carryForm
3.000 act #1 in frontDesk form seq2
3.500 act #1 out frontDesk form seq2
5.000 spawn #2 slot0
5.000 walkTo #2 inout-board.1
5.000 pose #2 standU
5.000 bubble #2 arrivalHold
6.000 walkTo #2 bench-5.1
6.000 pose #2 watchU
6.000 bubble #2 act:wait
6.000 act #2 in benchTerminal wait seq1
7.688 bubble #1 handIn
9.688 leave #1 finished out
66.000 bubble #2 running n=1
100.000 spawn #1 slot0 back
100.000 walkTo #1 inout-board.1
100.000 pose #1 standU
100.000 bubble #1 arrivalHold
101.000 walkTo #1 bench-7.1
101.000 pose #1 watchU
101.000 bubble #1 act:run
101.000 act #1 in benchTerminal run seq3
102.000 pose #1 standU
102.000 bubble #1 between
102.000 act #1 out benchTerminal run seq3
103.000 callEnd #1 ok seq3 bench-7.1
110.000 walkTo #1 front-desk.2
110.000 pose #1 useU0
110.000 bubble #1 signOut
118.688 leave #1 finished out
126.000 bubble #2 running n=2
186.000 bubble #2 running n=3
246.000 bubble #2 running n=4
306.000 bubble #2 running n=5
366.000 bubble #2 running n=6
426.000 bubble #2 running n=7
486.000 bubble #2 running n=8
546.000 bubble #2 running n=9
606.000 bubble #2 running n=10
666.000 bubble #2 stuck n=11
726.000 bubble #2 stuck n=12
786.000 bubble #2 stuck n=13
846.000 bubble #2 stuck n=14
906.000 bubble #2 stuck n=15
966.000 bubble #2 stuck n=16
1026.000 bubble #2 stuck n=17
1086.000 bubble #2 stuck n=18
1146.000 bubble #2 stuck n=19
1206.000 bubble #2 stuck n=20
1266.000 bubble #2 stuck n=21
1326.000 bubble #2 stuck n=22
1386.000 bubble #2 stuck n=23
1446.000 bubble #2 stuck n=24
1506.000 bubble #2 stuck n=25
1566.000 bubble #2 stuck n=26
1626.000 bubble #2 stuck n=27
1686.000 bubble #2 stuck n=28
1746.000 bubble #2 stuck n=29
1806.000 leave #2 evicted direct
1900.000 spawn #2 slot0 back
1900.000 walkTo #2 inout-board.1
1900.000 pose #2 standU
1900.000 bubble #2 arrivalHold
1910.000 walkTo #2 front-desk.2
1910.000 pose #2 useU0
1910.000 bubble #2 signOut
1913.688 leave #2 finished out`,
  'S11-lounge': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
0.500 spawn #2 slot0
0.500 walkTo #2 inout-board.2
0.500 pose #2 standU
0.500 bubble #2 arrivalHold
1.000 walkTo #1 bench-5.1
1.000 pose #1 useU0+pager
1.000 bubble #1 act:run
1.000 act #1 in benchTerminal run seq1
1.500 pose #1 standU+belt
1.500 bubble #1 between
1.500 act #1 out benchTerminal run seq1
2.000 walkTo #2 bench-7.1
2.000 pose #2 useU0+belt
2.000 bubble #2 act:watch
2.000 act #2 in benchTerminal watch seq1
2.500 callEnd #1 ok seq1 bench-5.1
2.500 pose #2 standU+belt
2.500 bubble #2 between
2.500 act #2 out benchTerminal watch seq1
3.000 pose #1 ponderD+belt
3.000 bubble #1 waitShell
3.500 callEnd #2 ok seq1 bench-7.1
4.000 pose #2 armsD+belt
4.000 bubble #2 waitMonitor
5.000 spawn #3 slot0
5.000 walkTo #3 inout-board.1
5.000 pose #3 standU
5.000 bubble #3 arrivalHold
6.000 walkTo #3 cab-18.1
6.000 pose #3 readU+folder
6.000 bubble #3 act:read
6.000 act #3 in fileCabinet read seq1
7.000 bubble #3 between
7.000 act #3 out fileCabinet read seq1
8.000 pose #3 ponderD+folder
8.000 bubble #3 pausedUnknown
10.000 spawn #4 slot0
10.000 walkTo #4 inout-board.1
10.000 pose #4 standU
10.000 bubble #4 arrivalHold
11.000 walkTo #4 bench-1.1
11.000 pose #4 useU0+pager
11.000 bubble #4 act:run
11.000 act #4 in benchTerminal run seq1
12.000 leave #3 finishedInferred out
13.000 pose #4 standU+belt
13.000 bubble #4 between
13.000 act #4 out benchTerminal run seq1
14.000 callEnd #4 ok seq1 bench-1.1
18.000 walkTo #1 sofa.3
18.000 pose #1 sitBack+pager
19.000 walkTo #2 sofa.1
19.000 pose #2 sitBack+pager
23.000 pose #4 armsD+belt filler
100.000 walkTo #1 cab-17.1
100.000 pose #1 readU+folder
100.000 bubble #1 act:read
100.000 act #1 in fileCabinet read seq2
101.000 bubble #1 between
101.000 act #1 out fileCabinet read seq2`,
  'S12-batches-and-stations': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
1.010 walkTo #1 bench-1.1
1.010 pose #1 watchU
1.010 bubble #1 act:run
1.010 act #1 in benchTerminal run seq2
3.000 pose #1 standU
3.000 bubble #1 between
3.000 act #1 out benchTerminal run seq2
4.000 callEnd #1 ok seq2 bench-1.1
10.000 walkTo #1 cab-14.1
10.000 pose #1 readU+folder
10.000 bubble #1 act:read
10.000 act #1 in fileCabinet read seq3
10.010 act #1 in fileCabinet read seq4
11.000 bubble #1 between
11.000 act #1 out fileCabinet read seq4
20.000 walkTo #1 hist-8.1
20.000 pose #1 reachU+ledger
20.000 bubble #1 act:hist-read
20.000 act #1 in historyShelf hist-read seq5
23.700 walkTo #1 records-east-3
23.700 pose #1 readD+ledger
25.000 bubble #1 between
25.000 act #1 out historyShelf hist-read seq5
30.000 walkTo #1 front-desk.2
30.000 pose #1 useU0+ticket
30.000 bubble #1 act:helper-bg
30.000 act #1 in frontDesk helper-bg seq6
35.000 walkTo #1 meeting-table.3
35.000 pose #1 sitBackNotepad
35.000 bubble #1 act:helper-fg
35.000 act #1 in meetingTable helper-fg seq7
50.100 pose #1 sitBack
50.100 bubble #1 between
50.100 act #1 out meetingTable helper-fg seq7
60.000 bubble #1 act:none
60.500 bubble #1 between
60.500 act #1 out meetingTable none seq7
70.000 walkTo #1 book-5.1
70.000 pose #1 reachU+book
70.000 bubble #1 act:fetch
70.000 act #1 in bookshelf fetch seq8
72.000 bubble #1 between
72.000 act #1 out bookshelf fetch seq8
77.763 walkTo #1 ledge.2
77.763 pose #1 readU+book
80.000 walkTo #1 manuals.2
80.000 pose #1 reachU+book
80.000 bubble #1 act:toolsearch
80.000 act #1 in manualsShelf toolsearch seq9
81.000 bubble #1 between
81.000 act #1 out manualsShelf toolsearch seq9
83.075 walkTo #1 ledge.2
83.075 pose #1 readU+book
90.000 walkTo #1 bench-1.1
90.000 pose #1 watchU
90.000 bubble #1 act:run
90.000 act #1 in benchTerminal run seq10
91.000 pose #1 standU
91.000 bubble #1 between
91.000 act #1 out benchTerminal run seq10
92.000 callEnd #1 ok seq10 bench-1.1
100.000 bubble #1 act:toolsearch
101.000 bubble #1 between
101.000 act #1 out benchTerminal toolsearch seq10
110.000 walkTo #1 front-desk.2
110.000 pose #1 useU0+ticket
110.000 bubble #1 act:helper-bg
110.000 act #1 in frontDesk helper-bg seq11
112.000 pose #1 useU0+ticket+belt
112.100 pose #1 standU+belt
112.100 bubble #1 between
112.100 act #1 out frontDesk helper-bg seq11`,
  'S2b-late-beyond-window': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
8.800 spawn #2 slot0
8.800 walkTo #2 inout-board.1
8.800 pose #2 standU
8.800 bubble #2 arrivalHold
10.000 walkTo #1 desk-1.1
10.000 pose #1 type0
10.000 bubble #1 act:write
10.000 act #1 in pcDesk write seq2
11.000 pose #1 sitBack
11.000 bubble #1 between
11.000 act #1 out pcDesk write seq2
12.000 callEnd #1 ok seq2 desk-1.1`,
  'S13-front-desk-rush': `0.000 spawn #1 slot0
0.000 walkTo #1 inout-board.1
0.000 pose #1 standU
0.000 bubble #1 arrivalHold
0.100 spawn #2 slot0
0.100 walkTo #2 inout-board.2
0.100 pose #2 standU
0.100 bubble #2 arrivalHold
0.200 spawn #3 slot0
0.200 walkTo #3 hold-1
0.200 pose #3 stand
0.200 bubble #3 arrivalHold
0.300 spawn #4 slot0
0.300 walkTo #4 hold-2
0.300 pose #4 stand
0.300 bubble #4 arrivalHold
0.400 spawn #5 slot0
0.400 walkTo #5 hold-3
0.400 pose #5 stand
0.400 bubble #5 arrivalHold
1.000 walkTo #1 cab-18.1
1.000 pose #1 readU+folder
1.000 bubble #1 act:read
1.000 act #1 in fileCabinet read seq1
1.100 walkTo #2 cab-17.1
1.100 pose #2 readU+folder
1.100 bubble #2 act:read
1.100 act #2 in fileCabinet read seq1
1.200 walkTo #3 cab-08.1
1.200 pose #3 readU+folder
1.200 bubble #3 act:read
1.200 act #3 in fileCabinet read seq1
1.300 walkTo #4 cab-20.1
1.300 pose #4 readU+folder
1.300 bubble #4 act:read
1.300 act #4 in fileCabinet read seq1
1.400 walkTo #5 cab-15.1
1.400 pose #5 readU+folder
1.400 bubble #5 act:read
1.400 act #5 in fileCabinet read seq1
2.000 bubble #1 between
2.000 act #1 out fileCabinet read seq1
2.100 bubble #2 between
2.100 act #2 out fileCabinet read seq1
2.200 bubble #3 between
2.200 act #3 out fileCabinet read seq1
2.300 bubble #4 between
2.300 act #4 out fileCabinet read seq1
2.400 bubble #5 between
2.400 act #5 out fileCabinet read seq1
10.000 walkTo #1 front-desk.2
10.000 pose #1 useU0+form
10.000 bubble #1 carryForm
10.000 act #1 in frontDesk form seq2
10.010 walkTo #2 front-desk.1
10.010 pose #2 useU0+form
10.010 bubble #2 carryForm
10.010 act #2 in frontDesk form seq2
10.020 walkTo #3 front-desk-queue-1
10.020 pose #3 standL+form
10.020 bubble #3 finishQueue
10.020 act #3 in frontDesk form seq2
10.030 walkTo #4 front-desk-queue-2
10.030 pose #4 standL+form
10.030 bubble #4 finishQueue
10.030 act #4 in frontDesk form seq2
10.040 pose #5 standU+form
10.040 bubble #5 finishQueue
10.040 act #5 in frontDesk form seq2
10.500 act #1 out frontDesk form seq2
10.510 act #2 out frontDesk form seq2
10.520 act #3 out frontDesk form seq2
10.530 act #4 out frontDesk form seq2
10.540 act #5 out frontDesk form seq2
14.688 bubble #1 handIn
14.697 bubble #2 handIn
16.688 leave #1 finished out
16.688 walkTo #3 front-desk.2
16.688 pose #3 useU0+form
16.688 bubble #3 carryForm
16.688 walkTo #4 front-desk-queue-1
16.688 walkTo #5 front-desk-queue-2
16.688 pose #5 standL+form
16.698 leave #2 finished out
16.698 walkTo #4 front-desk.1
16.698 pose #4 useU0+form
16.698 bubble #4 carryForm
16.698 walkTo #5 front-desk-queue-1
17.000 bubble #3 handIn
17.323 bubble #4 handIn
19.000 leave #3 finished out
19.000 walkTo #5 front-desk.2
19.000 pose #5 useU0+form
19.000 bubble #5 carryForm
19.313 bubble #5 handIn
19.323 leave #4 finished out
21.313 leave #5 finished out`,
}

// ── static checks ────────────────────────────────────────────────────────────────────────────────────────────────
function staticChecks() {
  for (const id of ACTIVITY_ID.values()) ok(isLabelId(`act:${id}`), `static: the activity id ${id} has no label`)
  for (const l of LABEL_IDS) if (l.startsWith('act:')) ok(ACTIVITY_BY_ID.has(l.slice(4)), `static: label ${l} names no activity id`)
  for (const l of LABEL_IDS) {
    try { labelText(l, { n: 3, st: 'pcDesk' }) } catch (e) { fail(`static: label ${l}: ${String(e)}`) }
    ok(!/[{}]/.test(labelText(l, { n: 3, st: 'pcDesk' })), `static: label ${l} leaves a parameter unfilled`)
  }
  ok(Object.keys(LABELS).length === LABEL_IDS.length, 'static: label ids')
  for (const p of LAYOUT.endpoints) {
    try { ok(POSE_SET.has(floorPose(p.pose)), `static: place ${p.id} pose ${p.pose} is not a frame`) } catch (e) { fail(`static: ${String(e)}`) }
  }
}

// ── running scenarios ────────────────────────────────────────────────────────────────────────────────────────────
/** Run every scenario on a core module; returns the failed checks (scenario: check). */
function runAll(mod: CoreMod, print: boolean): string[] {
  const bad: string[] = []
  for (const sc of S) {
    let r1: Run, r2: Run
    try {
      r1 = play(mod, sc.lines(), { ...sc.opts, disposeThen: sc.lines().slice(0, 3).filter((x): x is Line => typeof x !== 'string') })
      r2 = play(mod, sc.lines(), sc.opts)
    } catch (e) { bad.push(`${sc.name}: crash ${String(e).split('\n')[0]}`); continue }
    const got = fmt(r1, { objects: sc.objects })
    if (print && PRINT_DIR) writeFileSync(join(PRINT_DIR, `${sc.name}.txt`), `${got.join('\n')}\n`)
    for (const v of r1.violations) bad.push(`${sc.name}: ${v}`)
    for (const v of r2.violations) bad.push(`${sc.name} (run 2): ${v}`)
    if (!isDeepStrictEqual(r2.cmds, r1.cmds.slice(0, r2.cmds.length)) || r2.cmds.length > r1.cmds.length) bad.push(`${sc.name}: I7 two runs of the same input differ`)
    const want = EXPECTED[sc.name]
    if (want === undefined) bad.push(`${sc.name}: no golden`)
    else if (got.join('\n') !== want.trim()) {
      const w = want.trim().split('\n')
      let i = 0
      while (i < got.length && i < w.length && got[i] === w[i]) i++
      bad.push(`${sc.name}: sequence differs at line ${i + 1}: got "${got[i] ?? '(end)'}" want "${w[i] ?? '(end)'}"`)
    }
    if (sc.extra) for (const m of sc.extra(r1, mod)) bad.push(`${sc.name}: ${m}`)
  }
  return bad
}

// ── mutants ──────────────────────────────────────────────────────────────────────────────────────────────────────
interface Mutant { readonly id: string; readonly file: string; readonly from: string; readonly to: string; readonly why: string }
const MUTANTS: Mutant[] = [
  { id: 'M1 no release on leave', file: 'reducer.ts', why: 'I3 / I2',
    from: "    this.#applyChanges(this.#book.release(w.key))\n    this.stats.exits[reason]++\n    this.#emit({ op: 'leave'",
    to: "    this.stats.exits[reason]++\n    this.#emit({ op: 'leave'" },
  { id: 'M2 cascades skipped', file: 'reducer.ts', why: 'I1 / I2 (S13)', from: 'for (const c of changes) {', to: 'for (const c of changes.slice(0, 1)) {' },
  { id: 'M3 bookings after dispose', file: 'reducer.ts', why: 'I6', from: 'this.#disposed = true\n    this.#book.dispose()', to: 'this.#disposed = false' },
  { id: 'M4 a random seed', file: 'reducer.ts', why: 'I7', from: 'const seed = hash32(aid, SEED_SALT)', to: 'const seed = Math.floor(Math.random() * 2 ** 32)' },
  { id: 'M5 raw floorplan pose', file: 'places.ts', why: 'I4 pose', from: 'floorPose(layout.place(id).pose)', to: '(layout.place(id).pose as PoseName)' },
  { id: 'M6 a label outside the set', file: 'reducer.ts', why: 'I4 label',
    from: "} else label = w.inFlight > 0 ? activityLabel(w.activity) : 'between'", to: "} else label = w.inFlight > 0 ? activityLabel(w.activity) : ('thinking' as LabelId)" },
  { id: 'M7 a stop creates a worker', file: 'reducer.ts', why: 'S5 / S7',
    from: "if (w === undefined || w.phase === 'gone') { this.stats.stopUnknown++; return }",
    to: "if (w === undefined || w.phase === 'gone') { if (r.at) this.#enter(r.aid, s); this.stats.stopUnknown++; return }" },
  { id: 'M8 no hand-back-first guard', file: 'reducer.ts', why: 'S5', from: "if (r.a === 'report') { this.stats.handbackFirst++; return }", to: "if (r.a === 'report') { this.stats.handbackFirst++ }" },
  { id: 'M9 file order (no watermark)', file: 'reorder.ts', why: 'S2', from: 'this.watermarkMs = opts.watermarkMs ?? WATERMARK_MS', to: 'this.watermarkMs = 0' },
  { id: 'M10 the task list ends a WAITING worker', file: 'reducer.ts', why: 'S6b',
    from: "if (w.phase === 'waiting' || (w.phase === 'paused' && w.gated)) continue", to: "if (w.phase === 'paused' && w.gated) continue" },
  { id: 'M11 the task list ends never-listed workers', file: 'reducer.ts', why: 'S6a',
    from: "if (w.phase === 'gone' || w.sess !== s || !w.listed || listed.has(w.aid)) continue", to: "if (w.phase === 'gone' || w.sess !== s || listed.has(w.aid)) continue" },
  { id: 'M12 one absent snapshot ends a running helper', file: 'reducer.ts', why: 'S6a', from: 'if (expected || w.absent >= 2)', to: 'if (expected || w.absent >= 1)' },
  { id: 'M13 a stop with an empty type counts', file: 'reducer.ts', why: 'S7',
    from: "if (r.at === null || r.at === '') { this.stats.stopUngated++; return }", to: "if (r.at === null) { this.stats.stopUngated++; return }" },
  { id: 'M14 SessionEnd clear removes workers', file: 'reducer.ts', why: 'S4', from: "if (r.r === 'clear' || r.r === 'resume')", to: "if (r.r === 'resume')" },
  { id: 'M15 office clear at 3 h', file: 'reducer.ts', why: 'S8', from: 'officeClear: 2 * 3_600_000', to: 'officeClear: 3 * 3_600_000' },
  { id: 'M16 quiet on the wall clock', file: 'reducer.ts', why: 'S6a', from: 'activeWindow: 120_000', to: 'activeWindow: 1e15' },
  { id: 'M17 re-entry with a new ordinal', file: 'reducer.ts', why: 'S10',
    from: '    const back = w.lives > 0\n', to: '    const back = w.lives > 0\n    if (back) (w as { n: number }).n = this.#nextN++\n' },
  { id: 'M18 the last Pre of a batch wins', file: 'reducer.ts', why: 'S12',
    from: "    if (w.batchKind !== null && rank(st) > rank(w.batchKind)) return   // §4.3 P1: the step's winner stays\n", to: '' },
  { id: 'M19 the result decided at the Batch', file: 'reducer.ts', why: 'S3', from: 'result: 1_000,', to: 'result: 0,' },
  { id: 'M20 the lounge gate ignores a Monitor', file: 'reducer.ts', why: 'S11', from: "    if (res.activity === 'watch') w.bgJob = 'monitor'\n", to: '' },
  { id: 'M21 a Batch subtracts instead of zeroing', file: 'reducer.ts', why: 'S12', from: '    w.calls.clear()\n    w.inFlight = 0\n', to: '    w.calls.clear()\n    w.inFlight -= 1\n' },
  { id: "M22 no 'agent-' strip", file: 'reorder.ts', why: 'S1c', from: "(id === null ? null : id.replace(/^(?:agent-)+/, '') || null)", to: '(id === null ? null : id)' },
  { id: 'M23 a late record moves the clock back', file: 'reducer.ts', why: 'I0 (S2b)',
    from: '    this.#clock = Math.max(this.#clock, r.ts)\n    this.#apply(r)', to: '    this.#clock = r.ts\n    this.#apply(r)' },
  { id: 'M24 no 5 s foreground rule', file: 'reducer.ts', why: 'S12',
    from: "    if (res.activity === 'helper-bg') w.fgCheck = { at: this.#clock + TIMING.fgCheck, call: callKey }\n", to: '' },
  { id: 'M25 stage 2 not labelled filler', file: 'reducer.ts', why: 'S1a',
    from: "if (s !== null) { pose = s.pose; prop = s.prop; filler = w.sub === 'stage2' }", to: 'if (s !== null) { pose = s.pose; prop = s.prop; filler = false }' },
  { id: 'M26 a background stop after a hand-back pauses', file: 'reducer.ts', why: 'S1b',
    from: '    if (w.handedIn || w.fin !== null) { this.#finished(w); return }                 // §4.6 Finishing wins\n', to: '' },
  { id: 'M27 feed intents merged across workers', file: 'messages.ts', why: 'I8',
    from: 'if (intent === null || intent.key !== c.key || intent.ops.has(c.op))', to: 'if (intent === null || intent.ops.has(c.op))' },
  { id: 'M28 commands for workers that left', file: 'reducer.ts', why: 'I5',
    from: "      if (w.phase === 'gone') continue\n      const v = this.#view(w)\n      const p = w.sent", to: '      const v = this.#view(w)\n      const p = w.sent' },
]

const CORE_DIR = fileURLToPath(new URL('../src/worker-office/core/', import.meta.url))
const abs = (rel: string) => pathToFileURL(fileURLToPath(new URL(rel, import.meta.url))).href
const OUTSIDE: Record<string, string> = {
  '../../../office/observer/classify.mjs': abs('../office/observer/classify.mjs'),
  '../map/places.ts': abs('../src/worker-office/map/places.ts'),
  '../map/loadMap.ts': abs('../src/worker-office/map/loadMap.ts'),
  '../render/props.ts': abs('../src/worker-office/render/props.ts'),
}
const tempDirs: string[] = []

/** A copy of the core with one patch (asserted to apply exactly once); imports leaving core/ point at the real files. */
async function loadMutant(m: Mutant): Promise<CoreMod> {
  const dir = mkdtempSync(join(tmpdir(), 'wo-core-mutant-'))
  tempDirs.push(dir)
  let applied = 0
  for (const f of readdirSync(CORE_DIR)) {
    if (!f.endsWith('.ts')) continue
    let src = readFileSync(join(CORE_DIR, f), 'utf8').replace(/\r\n/g, '\n')   // a CRLF checkout (core.autocrlf)
    for (const [rel, url] of Object.entries(OUTSIDE)) src = src.split(`'${rel}'`).join(`'${url}'`)
    if (f === m.file) {
      applied = src.split(m.from).length - 1
      src = src.replace(m.from, () => m.to)
    }
    writeFileSync(join(dir, f), src)
  }
  if (applied !== 1) throw new Error(`${m.id}: the patch applies ${applied} times`)
  return await import(pathToFileURL(join(dir, 'reducer.ts')).href) as CoreMod
}

// ── the real spool ───────────────────────────────────────────────────────────────────────────────────────────────
/** Replay the real spool (read once, up to its last newline; it is live). Counts only. Returns false on a failure. */
function realReplay(): boolean | null {
  if (!existsSync(SPOOL)) return null
  const text = readFileSync(SPOOL, 'utf8')
  const end = text.lastIndexOf('\n')
  const lines = end < 0 ? [] : text.slice(0, end).split('\n')
  const once = (): Run => {
    const run = new Run(realCore)
    let wall = -Infinity
    for (const line of lines) {
      let ts = wall
      try { const o = JSON.parse(line) as { ts?: unknown }; if (typeof o.ts === 'number') ts = o.ts + 300 } catch { /* torn: read now */ }
      const w = Math.max(wall, ts)
      if (Number.isFinite(wall)) for (let t = wall + 500; t < w; t += 500) run.tick(t)
      wall = w
      run.ingest(line, wall)
    }
    for (let t = wall + 500; t <= wall + 2.5 * 3_600_000; t += 500) run.tick(t)   // past the 2 h office clear
    run.checkFeed()
    return run
  }
  const r1 = once(), r2 = once()
  const st = r1.core.stats
  const same = isDeepStrictEqual(r1.cmds, r2.cmds)
  const violations = r1.violations.length + r2.violations.length
  const holdings = r1.core.book.holdings().length + r1.core.book.waiters().length
  const hours = (ms: number) => (ms / 3_600_000).toFixed(2)
  const ops = new Map<string, number>()
  for (const c of r1.cmds) ops.set(c.op, (ops.get(c.op) ?? 0) + 1)
  console.log('real spool (counts only):')
  console.log(`  lines ${lines.length}; skipped torn ${st.torn} / shape ${st.shape} / version ${st.version}; parse_error records ${st.parseErrors}; late ${st.late}`)
  console.log(`  workers created ${st.created}; re-entries ${st.reentries}; max concurrent ${st.maxInside}; inside at the end ${r1.core.inside}; bookings at the end ${holdings}`)
  console.log(`  left: ${Object.entries(st.exits).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`  phase entries: ${Object.entries(st.phaseEntries).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`  worker-hours by state: ${Object.entries(st.dispMs).map(([k, v]) => `${k} ${hours(v)}`).join(', ')}`)
  console.log(`  not workers: phantom ${st.phantom}, hand-back-first ${st.handbackFirst}, empty-type start ${st.internalStart} / pre ${st.internalPre}; stops unknown ${st.stopUnknown}, empty type ${st.stopUngated}, mid-call ${st.stopInFlight}; Batch with nothing open ${st.batchNoOpen}; unmatched Failures ${st.failureUnmatched}; task lists ${st.snapshots}; SessionEnd kept ${st.sessionEndKept} / removed ${st.sessionEndRemoved}`)
  console.log(`  commands: ${[...ops].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`  invariant violations ${violations}; deterministic ${same ? 'yes' : 'NO'}`)
  for (const v of [...r1.violations, ...r2.violations].slice(0, 5)) console.log(`    ${v}`)
  return violations === 0 && same && holdings === 0 && r1.core.inside === 0
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────
staticChecks()
if (PRINT_DIR) mkdirSync(PRINT_DIR, { recursive: true })
const realBad = runAll(realCore, true)
for (const b of realBad) fail(b)
console.log(`scenarios: ${S.length} (each run twice, plus a dispose run); failed checks ${realBad.length}`)

let caught = 0
for (const m of MUTANTS) {
  let bad: string[]
  try { bad = runAll(await loadMutant(m), false) } catch (e) { fail(`${m.id}: ${String(e).split('\n')[0]}`); continue }
  if (bad.length > 0) caught++
  else fail(`mutant survived: ${m.id}`)
  console.log(`  ${bad.length > 0 ? 'caught  ' : 'SURVIVED'} ${m.id} (target ${m.why}): ${bad.length} checks, e.g. ${bad[0] ?? '-'}`)
}
console.log(`mutants: ${caught} / ${MUTANTS.length} caught`)
for (const d of tempDirs) rmSync(d, { recursive: true, force: true })

let exit = failures > 0 ? 1 : 0
if (NO_REAL) console.log('real spool: skipped (--no-real)')
else {
  const real = realReplay()
  if (real === null) { console.log('not run: data absent'); if (exit === 0) exit = 3 }
  else if (!real) fail('the real-spool replay')
}
if (failures > 0) exit = 1
console.log(exit === 0 ? 'ALL PASS' : exit === 3 ? 'synthetic checks pass; real spool not run' : `FAILED (${failures})`)
process.exit(exit)
