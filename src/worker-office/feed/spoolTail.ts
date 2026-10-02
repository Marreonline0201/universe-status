// Tailing the owner's spool folder (plan §5.1 option B, §6.4 "Feed adapter"): the day files events-YYYY-MM-DD.jsonl
// that the hook appends one line at a time (office/observer/spool-hook.mjs). Pure TypeScript over an abstract folder
// (SpoolDir), so the page's File System Access reader (fsaDir.ts, in a Web Worker) and the node check
// (scripts/worker-office-feed-check.ts, a temp folder) run the same code.
//
//   const tail = new SpoolTail(dir)
//   const lines = await tail.poll()      every 500 ms: the complete lines appended since the last poll
//
// READS ONLY APPENDED BYTES. Each file keeps how many bytes it has read; a poll reads [read, size) and nothing else.
// The bytes after the last newline (a line the hook is still writing, or a torn read) are kept and wait for the next
// poll, never handed on and never glued to another file's bytes.
// DAYS. The hook names its file by the LOCAL date of its own start time (spool-hook.mjs dayStamp), so a hook that starts
// just before midnight writes into the old day's file a little after midnight (start-to-write measured at 0.7 s at
// most). At the day change the old file is read on for ROLLOVER_GRACE_MS, next to the new one; then it is let go.
// THE BACKLOG. The first poll reads yesterday's file and today's from their first byte: the office then knows who is
// inside now (the observer core replays them; the page snaps to the result). caughtUp is true from then on.
// A file that does not exist yet is not an error (no event today yet); a file that shrank was replaced (read from 0).
// A file that changed between the size and the read (Chrome refuses to read such a snapshot: NotReadableError) is
// read again at the next poll, from the same offset: nothing is lost or read twice.

/** Polling period of the reader (plan §5.1: "polled every 500 ms"). */
export const POLL_MS = 500
/** The old day's file is read on this long after the day changes (a late hook writes there for under a second). */
export const ROLLOVER_GRACE_MS = 60_000
/** Bytes without a newline kept at most (the hook writes lines of at most 4,096 bytes): more is dropped as torn. */
export const MAX_CARRY = 64 * 1024

/** One file of the folder as one poll sees it: its size now and a read of [start, end) of that same state. */
export interface SpoolFile {
  readonly size: number
  read(start: number, end: number): Promise<Uint8Array>
}
/** The spool folder: a file by name, or null when there is no such file (yet). A read whose file changed after open()
 *  throws SpoolChanged; any other error is the folder's (no permission, gone). */
export interface SpoolDir {
  open(name: string): Promise<SpoolFile | null>
}
/** The file changed between open() and read(): try again at the next poll. */
export class SpoolChanged extends Error {
  constructor(name: string) { super(`${name} changed while it was read`); this.name = 'SpoolChanged' }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** The day file of a time, by the LOCAL calendar date (spool-hook.mjs dayStamp). */
export function dayFile(ms: number): string {
  const d = new Date(ms)
  return `events-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`
}
/** The day file of the calendar day before (noon of it: a DST change never skips or repeats a day). */
export function dayBefore(ms: number): string {
  const d = new Date(ms)
  return dayFile(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime())
}

interface Tail {
  readonly name: string
  read: number
  carry: Uint8Array
  /** Read until then (Infinity: today's). */
  until: number
}

export interface TailStats {
  lines: number
  bytes: number
  /** Polls that found a file changed under the read (read again next time). */
  retries: number
  /** Files that shrank (replaced): read again from their start. */
  restarts: number
  /** Unfinished lines dropped: a day file let go while its last line was unfinished, or a carry over MAX_CARRY. */
  torn: number
  polls: number
}

const EMPTY = new Uint8Array(0)
const NL = 0x0a

export class SpoolTail {
  readonly dir: SpoolDir
  readonly now: () => number
  readonly stats: TailStats = { lines: 0, bytes: 0, retries: 0, restarts: 0, torn: 0, polls: 0 }
  #tails: Tail[] = []
  #today: string | null = null
  #caughtUp = false
  readonly #decoder = new TextDecoder('utf-8')

  constructor(dir: SpoolDir, now: () => number = Date.now) {
    this.dir = dir
    this.now = now
  }

  /** The first poll has read the backlog (yesterday's and today's files) to their ends. */
  get caughtUp(): boolean { return this.#caughtUp }
  /** The files being read, oldest first (the old day's during its grace, then today's). */
  get files(): readonly string[] { return this.#tails.map(t => t.name) }
  /** Today's file and how many bytes of it are read (the tab shows it). */
  get today(): { readonly name: string | null; readonly bytes: number } {
    const t = this.#tails.find(x => x.name === this.#today)
    return { name: this.#today, bytes: t?.read ?? 0 }
  }

  /** One poll: the complete new lines of every file being read, oldest file first, in file order. */
  async poll(): Promise<string[]> {
    const now = this.now()
    const today = dayFile(now)
    this.stats.polls++
    if (this.#today === null) {
      // yesterday's file is read once, whole (and on for the grace when the day changed only just now)
      const d = new Date(now)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      this.#tails.push({ name: dayBefore(now), read: 0, carry: EMPTY, until: Math.max(now, midnight + ROLLOVER_GRACE_MS) })
      this.#tails.push({ name: today, read: 0, carry: EMPTY, until: Infinity })
      this.#today = today
    } else if (today !== this.#today) {
      for (const t of this.#tails) if (t.until === Infinity) t.until = now + ROLLOVER_GRACE_MS
      this.#tails.push({ name: today, read: 0, carry: EMPTY, until: Infinity })
      this.#today = today
    }
    // let go of an old day's file once its grace is over (an unfinished last line there is torn for good)
    this.#tails = this.#tails.filter(t => {
      if (t.until >= now) return true
      if (t.carry.length > 0) this.stats.torn++
      return false
    })
    const out: string[] = []
    for (const t of this.#tails) await this.#readNew(t, out)
    this.#caughtUp = true
    this.stats.lines += out.length
    return out
  }

  async #readNew(t: Tail, out: string[]) {
    const f = await this.dir.open(t.name)
    if (f === null) return
    if (f.size < t.read) { t.read = 0; t.carry = EMPTY; this.stats.restarts++ }
    if (f.size === t.read) return
    let bytes: Uint8Array
    try {
      bytes = await f.read(t.read, f.size)
    } catch (e) {
      if (e instanceof SpoolChanged) { this.stats.retries++; return }
      throw e
    }
    t.read += bytes.length
    this.stats.bytes += bytes.length
    this.#split(t, bytes, out)
  }

  /** The complete lines of carry + bytes; what follows the last newline is the new carry. */
  #split(t: Tail, bytes: Uint8Array, out: string[]) {
    let data = bytes
    if (t.carry.length > 0) {
      data = new Uint8Array(t.carry.length + bytes.length)
      data.set(t.carry, 0)
      data.set(bytes, t.carry.length)
    }
    let start = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== NL) continue
      let end = i
      if (end > start && data[end - 1] === 0x0d) end--
      if (end > start) out.push(this.#decoder.decode(data.subarray(start, end)))
      start = i + 1
    }
    t.carry = start >= data.length ? EMPTY : data.slice(start)
    if (t.carry.length > MAX_CARRY) { t.carry = EMPTY; this.stats.torn++ }
  }
}
