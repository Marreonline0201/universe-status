// The reader loop of the live feed (plan §5.1 option B): poll the spool folder every POLL_MS and post what was read.
// It runs in a Web Worker (fsaReader.worker.ts) so the page never waits on the disk; the node check drives the same
// loop over a temp folder (scripts/worker-office-feed-check.ts).
//
// Messages to the page (ReaderMsg):
//   lines     complete spool lines, in file order (at most LINES_PER_MSG in one message: the backlog comes in parts)
//   caughtUp  once, after the first poll: the backlog (yesterday's and today's files so far) has been posted
//   status    after each poll: today's file, whether it exists yet, bytes read, lines so far
//   error     reading failed; 'permission' (the grant was taken back: the page asks again) stops the loop
// Nothing here writes, deletes or sends anything anywhere: the folder is only read, and the lines go to the page.
import { POLL_MS, SpoolTail, type SpoolDir } from './spoolTail.ts'

export const LINES_PER_MSG = 5000

export type ReaderMsg =
  | { readonly type: 'lines'; readonly lines: readonly string[] }
  | { readonly type: 'caughtUp'; readonly lines: number }
  | { readonly type: 'status'; readonly file: string | null; readonly exists: boolean; readonly bytes: number; readonly lines: number }
  | { readonly type: 'error'; readonly kind: 'permission' | 'other'; readonly message: string }

export interface ReaderOptions {
  readonly pollMs?: number
  readonly now?: () => number
}

const errName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '')

/** Start polling; stop() ends it (no message is posted after stop()). */
export function runReader(dir: SpoolDir, post: (m: ReaderMsg) => void, opts: ReaderOptions = {}): { stop(): void } {
  const tail = new SpoolTail(dir, opts.now ?? Date.now)
  const pollMs = opts.pollMs ?? POLL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let caught = false
  const loop = async () => {
    timer = null
    if (stopped) return
    try {
      const lines = await tail.poll()
      if (stopped) return
      for (let i = 0; i < lines.length; i += LINES_PER_MSG) post({ type: 'lines', lines: lines.slice(i, i + LINES_PER_MSG) })
      if (!caught) { caught = true; post({ type: 'caughtUp', lines: tail.stats.lines }) }
      const t = tail.today
      post({ type: 'status', file: t.name, exists: t.bytes > 0, bytes: t.bytes, lines: tail.stats.lines })
    } catch (e) {
      if (stopped) return
      const name = errName(e)
      const permission = name === 'NotAllowedError' || name === 'SecurityError'
      post({ type: 'error', kind: permission ? 'permission' : 'other', message: `${name || 'Error'}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) })
      if (permission) { stopped = true; return }
    }
    if (!stopped) timer = setTimeout(() => { void loop() }, pollMs)
  }
  void loop()
  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
