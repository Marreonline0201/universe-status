// The EXAMPLE feed of the WORKER OFFICE tab: a synthetic spool, generated here, played through the same observer core
// as live data would be. It is never the owner's real spool and the tab labels it as an example while it plays.
//
// Six helpers with made-up ids (agent ids 'a0e8a' + hex, one made-up session) over about two and a half minutes, using
// the classifier's real activity ids and object kinds (office/observer/classify.mjs) in the spool's record format
// (plan §5.2: v, ts, sid, ev, aid, at, k, a, tu, bg, st, ch, n), so every path the slice draws shows up once:
//   #1 reads at a file cabinet (the same-kind gesture), searches, writes at a PC desk, runs a test at a bench (it
//      fails, then passes after a fix), thinks long enough for stage 2, hands back its report (printer -> front desk);
//   #2 reads the history (fetch-then-read: pull a ledger, read at a records reading place), compares versions at a
//      lectern, reads a book in the library, looks something up in the card catalog, writes, hands in a result form;
//   #3 reads, asks the owner a question (the front desk's handset: the phoneU frame, the cradle empty until the answer),
//      runs a long program (the watching pose), types a long edit (the long-call pose), then stops without a hand-in:
//      it signs out at the front desk;
//   #4 and #5 arrive together and work side by side;
//   #6 is a background helper: it starts a background shell (a pager on its belt), stops while it runs (paused, then
//      waiting on the lounge sofa with its pager), resumes, and hands back.
// Each line is read 300 ms after its hook time, as the page reads the spool.
const SID = '0e8a0e8a-0000-4000-8000-0000000e8a00'
const aid = (n: number) => `a0e8a${n.toString(16).padStart(12, '0')}`
/** The classifier's object kind of each activity used here. */
const KIND: Readonly<Record<string, string>> = {
  read: 'fileCabinet', search: 'fileCabinet', write: 'pcDesk', run: 'benchTerminal', 'hist-read': 'historyShelf', diff: 'lectern',
  fetch: 'bookshelf', websearch: 'cardCatalog', report: 'printer', form: 'frontDesk', 'helper-bg': 'frontDesk', ask: 'frontDesk',
}

/** A hand-back is "being checked" from its Pre to its Post (plan §4.2): long enough here for the walk to the printer,
 *  so the sheets are seen rising (a Post that comes first sends the worker straight on to the front desk). */
const HANDBACK_S = 12
/** One record: its hook time (ms after the example starts) and its fields (without v and ts). */
export interface ExampleRecord { readonly at: number; readonly rec: Readonly<Record<string, unknown>> }

/** A call: [activity, call length s, gap before the call s, extra fields]; fail: a PostToolUseFailure for it. */
type Step = readonly [string, number, number, { readonly bg?: boolean; readonly fail?: boolean }?]
type End = 'report' | 'form' | 'stop'

function helper(out: ExampleRecord[], n: number, t0: number, steps: readonly Step[], end: End, opts: { type?: string; hold?: number } = {}): number {
  const a = aid(n), type = opts.type ?? 'workflow-subagent'
  const put = (s: number, rec: Record<string, unknown>) => out.push({ at: Math.round(s * 1000), rec: { sid: SID, ...rec } })
  put(t0, { ev: 'SubagentStart', aid: a, at: type })
  let t = t0, k = 0
  for (const [act, len, gap, x] of steps) {
    t += gap
    const tu = `${a.slice(-4)}c${k++}`
    put(t, { ev: 'PreToolUse', aid: a, k: KIND[act], a: act, tu, ...(x?.bg ? { bg: true } : {}) })
    if (x?.fail) put(t + len - 0.02, { ev: 'PostToolUseFailure', aid: a, tu, intr: false })
    t += len
    put(t, { ev: 'PostToolBatch', aid: a, n: 1 })
  }
  t += 3
  if (end === 'report') {
    const tu = `${a.slice(-4)}r`
    put(t, { ev: 'PreToolUse', aid: a, k: 'printer', a: 'report', tu })
    put(t + HANDBACK_S, { ev: 'PostToolUse', aid: a, k: 'printer', a: 'report', tu })
    put(t + HANDBACK_S + 0.2, { ev: 'PostToolBatch', aid: a, n: 1 })
    t += HANDBACK_S + 0.2
  } else if (end === 'form') {
    put(t, { ev: 'PreToolUse', aid: a, k: 'frontDesk', a: 'form', tu: `${a.slice(-4)}f` })
    put(t + 0.5, { ev: 'PostToolBatch', aid: a, n: 1 })
    t += 0.5
  }
  t += opts.hold ?? 6
  put(t, { ev: 'SubagentStop', aid: a, at: type, bt: [] })
  return t
}

/** The example's records, in hook-time order. */
export function exampleRecords(): ExampleRecord[] {
  const out: ExampleRecord[] = []
  helper(out, 1, 0.5, [
    ['read', 2.5, 2], ['read', 1.5, 1.5], ['search', 2, 2], ['write', 5, 3], ['run', 3, 2, { fail: true }], ['write', 3, 5],
    ['run', 4, 2], ['read', 1, 13],
  ], 'report')
  helper(out, 2, 6, [
    ['hist-read', 6, 2.5], ['diff', 4, 3], ['fetch', 6, 3], ['websearch', 3, 2.5], ['write', 4, 4],
  ], 'form', { hold: 3 })
  helper(out, 3, 14, [['read', 3, 2], ['ask', 12, 2], ['run', 7, 2], ['read', 2, 2], ['write', 9, 3], ['read', 1, 14]], 'stop', { hold: 2 })
  helper(out, 4, 40, [['read', 2, 2], ['hist-read', 5, 2], ['run', 3, 3], ['read', 1.5, 2]], 'report')
  helper(out, 5, 40.05, [['read', 2, 2.2], ['read', 2, 1.5], ['write', 4, 3], ['run', 2.5, 3]], 'form', { hold: 3 })
  // #6, a background helper launched by the main session (whose records draw nobody): a background shell, a stop
  // while it runs (paused, then waiting with its pager in the lounge), a resume, a hand-back
  const main = (s: number, rec: Record<string, unknown>) => out.push({ at: Math.round(s * 1000), rec: { sid: SID, ...rec } })
  const b = aid(6)
  main(69.8, { ev: 'PreToolUse', k: 'frontDesk', a: 'helper-bg', tu: 'mainl1' })
  main(70.1, { ev: 'PostToolUse', k: 'frontDesk', a: 'helper-bg', tu: 'mainl1', st: 'async_launched', ch: b })
  main(70.2, { ev: 'PostToolBatch', n: 1 })
  const put6 = (s: number, rec: Record<string, unknown>) => out.push({ at: Math.round(s * 1000), rec: { sid: SID, aid: b, ...rec } })
  put6(70, { ev: 'SubagentStart', at: 'general-purpose' })
  put6(72, { ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: 'b6c0' }); put6(74, { ev: 'PostToolBatch', n: 1 })
  put6(76, { ev: 'PreToolUse', k: 'benchTerminal', a: 'run', tu: 'b6c1', bg: true }); put6(77, { ev: 'PostToolBatch', n: 1 })
  put6(80, { ev: 'SubagentStop', at: 'general-purpose' })
  put6(118, { ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: 'b6c2' }); put6(120, { ev: 'PostToolBatch', n: 1 })
  put6(123, { ev: 'PreToolUse', k: 'printer', a: 'report', tu: 'b6r' })
  put6(123 + HANDBACK_S, { ev: 'PostToolUse', k: 'printer', a: 'report', tu: 'b6r' }); put6(123.2 + HANDBACK_S, { ev: 'PostToolBatch', n: 1 })
  put6(129 + HANDBACK_S, { ev: 'SubagentStop', at: 'general-purpose' })
  return out.sort((x, y) => x.at - y.at)
}

/** The page reads a line this long after its hook time. */
export const READ_DELAY_MS = 300

/** Plays the example from `base` (sim ms): each record becomes a spool line with ts = base + its time. */
export class ExamplePlayer {
  readonly base: number
  readonly records: readonly ExampleRecord[]
  #next = 0

  constructor(base: number, records: readonly ExampleRecord[] = exampleRecords()) {
    this.base = base
    this.records = records
  }

  /** Every line due by `now`, in order. */
  deliver(now: number, sink: (line: string) => void) {
    while (this.#next < this.records.length) {
      const r = this.records[this.#next]
      if (this.base + r.at + READ_DELAY_MS > now) return
      sink(JSON.stringify({ v: 1, ts: this.base + r.at, ...r.rec }))
      this.#next++
    }
  }

  get done(): boolean { return this.#next >= this.records.length }
  /** The time of the last record (ms after the start). */
  get length(): number { return this.records.length > 0 ? this.records[this.records.length - 1].at : 0 }
}
