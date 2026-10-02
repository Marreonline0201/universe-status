// Spool ingestion for the observer core: one spool line -> a typed record, and the reorder buffer (plan §4.1
// "Ordering", probe 7, lead ruling decisions.md 2026-10-01 21:14 #2).
//
// parseRecord is tolerant: a torn or non-JSON line, a record without a numeric ts or a string ev, or a version other
// than 1 is skipped (and counted by the caller); unknown fields (the legacy run / dur / cpu / rss of the first hook
// version, anything a later version adds) are ignored; a field with the wrong type reads as absent. Every agent id is
// joined WITHOUT any leading "agent-" (probe 3, ruling 6): aid, ch and the task-list ids.
//
// Reorder: async hooks run as separate processes, so lines can land out of timestamp order (worst seen: 383 ms; the
// measured start-to-write is p90 251 ms, max 700 ms). A record is held until a record with a ts at least
// WATERMARK_MS later has been read (the timestamp watermark, probe 7: it would have ordered every record seen), or
// until QUIET_FLUSH_MS of wall-clock time has passed with no new line (the flush for quiet periods). Released records
// come out sorted by (ts, read order). Pure: time comes in as numbers.

/** One background task of a Stop / SubagentStop record (the parent session's task list). */
export interface BtEntry { readonly id: string | null; readonly type: string | null }

export interface SpoolRecord {
  /** Read order of the line (the stable tie-break for equal ts). */
  readonly seq: number
  readonly ts: number
  readonly ev: string
  readonly sid: string | null
  readonly aid: string | null
  /** agent_type: null = absent, '' = empty (internal agents). Never displayed. */
  readonly at: string | null
  readonly k: string | null
  readonly a: string | null
  readonly tsr: boolean
  readonly tu: string | null
  readonly bg: boolean
  /** Shell timeout in s. */
  readonly to: number | null
  readonly st: string | null
  readonly ch: string | null
  readonly tid: string | null
  readonly intr: boolean
  readonly n: number | null
  /** null = no task list in the record (absent: the registry was not reachable). */
  readonly bt: readonly BtEntry[] | null
  readonly r: string | null
}

export type ParseResult = { readonly ok: true; readonly rec: SpoolRecord } | { readonly ok: false; readonly why: 'torn' | 'shape' | 'version' }

export const WATERMARK_MS = 500
export const QUIET_FLUSH_MS = 1000

const str = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null)
const num = (o: Record<string, unknown>, k: string): number | null => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null)
/** An agent id as joined: every leading "agent-" stripped (the hook strips it since stage 0; older lines may not). */
export const stripAgent = (id: string | null): string | null => (id === null ? null : id.replace(/^(?:agent-)+/, '') || null)

export function parseRecord(line: string, seq: number): ParseResult {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return { ok: false, why: 'torn' } }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'shape' }
  const o = raw as Record<string, unknown>
  const ts = num(o, 'ts'), ev = str(o, 'ev')
  if (ts === null || ev === null) return { ok: false, why: 'shape' }
  if (o.v !== 1) return { ok: false, why: 'version' }
  let bt: BtEntry[] | null = null
  if (Array.isArray(o.bt)) {
    bt = []
    for (const e of o.bt) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) continue
      const eo = e as Record<string, unknown>
      bt.push({ id: stripAgent(str(eo, 'id')), type: str(eo, 'type') })
    }
  }
  return {
    ok: true,
    rec: {
      seq, ts, ev, sid: str(o, 'sid'), aid: stripAgent(str(o, 'aid')), at: str(o, 'at'), k: str(o, 'k'), a: str(o, 'a'),
      tsr: o.tsr === true, tu: str(o, 'tu'), bg: o.bg === true, to: num(o, 'to'), st: str(o, 'st'), ch: stripAgent(str(o, 'ch')),
      tid: str(o, 'tid'), intr: o.intr === true, n: num(o, 'n'), bt, r: str(o, 'r'),
    },
  }
}

const before = (a: SpoolRecord, b: SpoolRecord) => a.ts < b.ts || (a.ts === b.ts && a.seq < b.seq)

/** The reorder buffer. add() returns what the watermark releases; flush() what the quiet flush releases. */
export class Reorder {
  readonly watermarkMs: number
  readonly quietFlushMs: number
  #buf: SpoolRecord[] = []
  #maxTs = -Infinity
  #lastWall = -Infinity

  constructor(opts: { watermarkMs?: number; quietFlushMs?: number } = {}) {
    this.watermarkMs = opts.watermarkMs ?? WATERMARK_MS
    this.quietFlushMs = opts.quietFlushMs ?? QUIET_FLUSH_MS
  }

  get size(): number { return this.#buf.length }
  /** The ts of the oldest held record, or null. */
  oldest(): number | null { return this.#buf.length > 0 ? this.#buf[0].ts : null }

  /** Hold a record read at wall time `wall`; release every record the watermark now passes, in order. */
  add(rec: SpoolRecord, wall: number): SpoolRecord[] {
    this.#lastWall = Math.max(this.#lastWall, wall)
    let i = this.#buf.length
    while (i > 0 && before(rec, this.#buf[i - 1])) i--
    this.#buf.splice(i, 0, rec)
    if (rec.ts > this.#maxTs) this.#maxTs = rec.ts
    let n = 0
    while (n < this.#buf.length && this.#buf[n].ts <= this.#maxTs - this.watermarkMs) n++
    return this.#buf.splice(0, n)
  }

  /** At wall time `wall`: after QUIET_FLUSH_MS with no new line, release everything held. */
  flush(wall: number): SpoolRecord[] {
    if (this.#buf.length === 0 || wall - this.#lastWall < this.quietFlushMs) return []
    return this.#buf.splice(0, this.#buf.length)
  }

  /** Release everything (end of a replay). */
  drain(): SpoolRecord[] { return this.#buf.splice(0, this.#buf.length) }
}
