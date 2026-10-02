// The live feed's reader in a temp-dir harness (plan §6.4 "Feed adapter", option B: "polling of a growing file in a
// temp-dir harness"). Run: node scripts/worker-office-feed-check.ts [--no-mutants]
//
// The page reads the owner's spool folder through File System Access in a Web Worker; the reading itself is
// src/worker-office/feed/{spoolTail,fsaDir,reader}.ts, written against an abstract folder so this check drives the SAME
// code over a temporary folder with node's file API. Synthetic lines only (never the owner's spool).
//   F1  day file names use the LOCAL date, as the hook names them (spool-hook.mjs dayStamp), also around midnight and
//       across a DST change (dayBefore);
//   F2  a growing file: each poll returns exactly the lines appended since the last, and reads only the new bytes (every
//       read starts where the last one ended);
//   F3  partial lines: a line written in two parts waits for its newline and comes out whole, once; several lines in one
//       chunk all come out, in order;
//   F4  day rollover: after midnight the new day's file is read, AND a line a late hook appends to the old day's file
//       still comes out (the grace), never glued to the new file's bytes; after the grace the old file is let go;
//   F5  a missing file is no error (no event today yet); once it appears its lines come; a file that shrank (replaced)
//       is read again from its start;
//   F6  the backlog: the first poll reads yesterday's file and today's from their first byte, then caughtUp;
//   F7  the File System Access adapter (fsaDir) over a stand-in directory handle whose files are node's file SNAPSHOTS
//       (fs.openAsBlob: like Chrome's File, reading one after the file changed throws NotReadableError): a growing file
//       is read through it; a file that changes between open and read is read again next poll, nothing lost or doubled;
//   F8  the reader loop (reader.ts) on real timers at POLL_MS = 500: posts the backlog, then caughtUp once, then new lines
//       within about a poll of their write, a status per poll; after stop() it posts nothing;
//   F9  privacy: the feed's files only read: no network API, no write or delete of a file, no create: true.
// Mutants of spoolTail.ts (a temp copy) must each make a check fail. Exit 1 on any failure.
import { appendFileSync, mkdtempSync, openAsBlob, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as realTail from '../src/worker-office/feed/spoolTail.ts'
import { fsaDir, type DirHandleLike } from '../src/worker-office/feed/fsaDir.ts'
import { runReader, type ReaderMsg } from '../src/worker-office/feed/reader.ts'

type TailMod = typeof realTail
const NO_MUTANTS = process.argv.includes('--no-mutants')
let failures = 0
const ok = (cond: boolean, what: string) => { if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}`) } }

// ── the harness ──────────────────────────────────────────────────────────────────────────────────────────────────
const line = (i: number, extra = '') => JSON.stringify({ v: 1, ts: 1_790_000_000_000 + i, sid: 's', ev: 'PreToolUse', aid: `a${i}`, k: 'fileCabinet', a: 'read', tu: `t${i}${extra}` })
const lines = (from: number, n: number) => Array.from({ length: n }, (_, k) => line(from + k))
interface Harness { root: string; reads: [string, number, number][]; dir: realTail.SpoolDir; done(): void }
/** A temp folder read through node's file API; every read is logged [file, start, end). */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'wo-feed-'))
  const reads: [string, number, number][] = []
  const dir: realTail.SpoolDir = {
    async open(name) {
      const p = join(root, name)
      let size: number
      try { size = (await stat(p)).size } catch (e) { if ((e as { code?: string }).code === 'ENOENT') return null; throw e }
      return {
        size,
        async read(start, end) {
          reads.push([name, start, end])
          const fh = await openFile(p, 'r')
          try {
            const buf = Buffer.alloc(end - start)
            const { bytesRead } = await fh.read(buf, 0, end - start, start)
            return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
          } finally { await fh.close() }
        },
      }
    },
  }
  return { root, reads, dir, done: () => rmSync(root, { recursive: true, force: true }) }
}
/** A local time (the hook's calendar). */
const at = (y: number, m: number, d: number, h = 12, mi = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms).getTime()

/** The checks over a tail module (the real one or a mutant): the failed check ids. */
async function checks(mod: TailMod, print: boolean): Promise<Set<string>> {
  const bad = new Set<string>()
  const check = (id: string, cond: boolean, what: string) => { if (!cond) bad.add(id); if (print) ok(cond, `${id} ${what}`) }

  // F1 local day names
  {
    const local = (ms: number) => { const d = new Date(ms); return `events-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl` }
    const times = [at(2026, 10, 1, 23, 59, 59, 999), at(2026, 10, 2, 0, 0, 0, 0), at(2026, 10, 2, 0, 30), at(2026, 12, 31, 23, 30), at(2027, 1, 1, 0, 30)]
    const offs = new Set(times.map(t => new Date(t).getTimezoneOffset()))
    const same = times.every(t => mod.dayFile(t) === local(t))
    const before = mod.dayBefore(at(2026, 3, 9, 0, 30)) === 'events-2026-03-08.jsonl' && mod.dayBefore(at(2026, 11, 2, 0, 30)) === 'events-2026-11-01.jsonl'
      && mod.dayBefore(at(2027, 1, 1, 0, 30)) === 'events-2026-12-31.jsonl'
    check('F1', same && before && mod.POLL_MS === 500, `day files by the LOCAL date (the hook's dayStamp) at ${times.length} times around midnight (UTC offset${offs.size > 1 ? 's' : ''} ${[...offs].map(o => -o / 60).join(', ')} h), the day before across both DST changes, polling every ${mod.POLL_MS} ms`)
  }

  // F2 a growing file, F3 partial lines
  {
    const h = harness()
    const now = at(2026, 10, 2, 12)
    const today = mod.dayFile(now)
    const tail = new mod.SpoolTail(h.dir, () => now)
    const f = join(h.root, today)
    writeFileSync(f, lines(0, 3).join('\n') + '\n')
    const p1 = await tail.poll()
    appendFileSync(f, lines(3, 2).join('\n') + '\n')
    const p2 = await tail.poll()
    const p3 = await tail.poll()
    const mine = h.reads.filter(r => r[0] === today)
    const contiguous = mine.every((r, i) => i === 0 ? r[1] === 0 : r[1] === mine[i - 1][2])
    check('F2', p1.join('|') === lines(0, 3).join('|') && p2.join('|') === lines(3, 2).join('|') && p3.length === 0 && contiguous && mine.length === 2,
      `a growing file: 3 lines, then exactly the 2 appended, then none; ${mine.length} reads of it, each from where the last ended (${mine.map(r => `[${r[1]},${r[2]})`).join(' ')})`)
    // a line in two parts, then two more lines in one chunk
    const half = line(5)
    appendFileSync(f, half.slice(0, 40))
    const p4 = await tail.poll()
    appendFileSync(f, half.slice(40) + '\n' + line(6) + '\n' + line(7) + '\n')
    const p5 = await tail.poll()
    const p6 = await tail.poll()
    check('F3', p4.length === 0 && p5.join('|') === [half, line(6), line(7)].join('|') && p6.length === 0,
      `a torn last line waits (${p4.length} lines while it is half written) and comes out whole once, followed by the 2 lines of the same chunk in order`)
    h.done()
  }

  // F4 rollover with a late write to the old file
  {
    const h = harness()
    let now = at(2026, 10, 1, 23, 59, 59, 500)
    const tail = new mod.SpoolTail(h.dir, () => now)
    const oldF = join(h.root, mod.dayFile(now)), newName = mod.dayFile(at(2026, 10, 2, 0, 0, 1))
    writeFileSync(oldF, lines(0, 2).join('\n') + '\n' + line(2).slice(0, 30))     // its last line is still being written
    const a = await tail.poll()
    now = at(2026, 10, 2, 0, 0, 0, 200)                                             // past midnight: the new day's file
    writeFileSync(join(h.root, newName), lines(10, 2).join('\n') + '\n')
    const b = await tail.poll()
    appendFileSync(oldF, line(2).slice(30) + '\n' + line(3) + '\n')                 // a late hook (started before midnight) finishes
    now = at(2026, 10, 2, 0, 0, 0, 700)
    const c = await tail.poll()
    const glued = [...b, ...c].some(l => l.includes(line(2).slice(0, 30)) && l !== line(2))
    now += mod.ROLLOVER_GRACE_MS + 1000                                              // after the grace
    appendFileSync(oldF, line(4) + '\n')
    appendFileSync(join(h.root, newName), line(12) + '\n')
    const d = await tail.poll()
    check('F4', a.join('|') === lines(0, 2).join('|') && b.join('|') === lines(10, 2).join('|') && c.join('|') === [line(2), line(3)].join('|') && !glued
      && d.join('|') === line(12) && tail.files.length === 1 && tail.files[0] === newName,
      `day rollover: the new day's file is read from midnight; the old day's unfinished line and a line a late hook writes there after midnight still come out (${c.length}), whole, never glued to the new file; after the ${mod.ROLLOVER_GRACE_MS / 1000} s grace the old file is let go (a line written there later is not read) and only ${newName} is read`)
    h.done()
  }

  // F5 a missing file, a replaced file
  {
    const h = harness()
    const now = at(2026, 10, 2, 9)
    const tail = new mod.SpoolTail(h.dir, () => now)
    const f = join(h.root, mod.dayFile(now))
    const a = await tail.poll()
    writeFileSync(f, lines(0, 2).join('\n') + '\n')
    const b = await tail.poll()
    truncateSync(f, 0)
    writeFileSync(f, line(9) + '\n')
    const c = await tail.poll()
    check('F5', a.length === 0 && b.length === 2 && c.join('|') === line(9) && tail.stats.restarts === 1,
      `no file yet: no lines and no error; then its 2 lines; a replaced (shorter) file is read from its start (${tail.stats.restarts} restart)`)
    h.done()
  }

  // F6 the backlog: yesterday's and today's files on the first poll
  {
    const h = harness()
    const now = at(2026, 10, 2, 15)
    writeFileSync(join(h.root, mod.dayBefore(now)), lines(0, 3).join('\n') + '\n')
    writeFileSync(join(h.root, mod.dayFile(now)), lines(3, 2).join('\n') + '\n')
    writeFileSync(join(h.root, 'events-2026-09-29.jsonl'), lines(90, 4).join('\n') + '\n')   // older: not read
    const tail = new mod.SpoolTail(h.dir, () => now)
    const before = tail.caughtUp
    const a = await tail.poll()
    check('F6', !before && tail.caughtUp && a.join('|') === lines(0, 5).join('|'),
      `the first poll reads yesterday's file then today's from their first byte (${a.length} lines; older days are not read), then caughtUp`)
    h.done()
  }

  // F7 the File System Access adapter over node's file snapshots
  {
    const h = harness()
    const now = at(2026, 10, 2, 10)
    const name = mod.dayFile(now), f = join(h.root, name)
    let changeOnOpen: string | null = null
    const handle: DirHandleLike = {
      async getFileHandle(n: string) {
        const p = join(h.root, n)
        try { statSync(p) } catch { throw new DOMException(`${n} not found`, 'NotFoundError') }
        return {
          async getFile() {
            const blob = await openAsBlob(p)
            if (changeOnOpen !== null && n === name) { appendFileSync(p, changeOnOpen); changeOnOpen = null }   // the hook writes right after the snapshot
            return blob
          },
        }
      },
    }
    const fsaMod = mod === realTail ? fsaDir : (await import(pathToFileURL(patchedFsa).href) as typeof import('../src/worker-office/feed/fsaDir.ts')).fsaDir
    const tail = new mod.SpoolTail(fsaMod(handle), () => now)
    writeFileSync(f, lines(0, 2).join('\n') + '\n')
    const a = await tail.poll()
    appendFileSync(f, line(2) + '\n')
    changeOnOpen = line(3) + '\n'
    const b = await tail.poll()                    // the snapshot changed under the read: nothing yet, read again next poll
    const c = await tail.poll()
    const all = [...a, ...b, ...c]
    check('F7', a.length === 2 && b.length === 0 && c.join('|') === [line(2), line(3)].join('|') && tail.stats.retries === 1 && new Set(all).size === all.length && all.length === 4,
      `through fsaDir and file snapshots: 2 lines; a file changed between open and read is read again at the next poll (${tail.stats.retries} retry): ${all.length} lines in all, none lost or doubled`)
    h.done()
  }
  return bad
}

// the FSA adapter's copy for a mutant run imports the mutant tail module
let patchedFsa = ''

// ── the real modules ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('the live feed reader (feed/spoolTail.ts, fsaDir.ts, reader.ts) over a temp folder')
await checks(realTail, true)

// F8 the reader loop on real timers
{
  const h = harness()
  const name = realTail.dayFile(Date.now())
  const f = join(h.root, name)
  writeFileSync(f, lines(0, 3).join('\n') + '\n')
  const got: { m: ReaderMsg; t: number }[] = []
  const t0 = Date.now()
  const r = runReader(h.dir, m => got.push({ m, t: Date.now() - t0 }))
  await new Promise(res => setTimeout(res, 700))
  const wroteAt = Date.now() - t0
  appendFileSync(f, lines(3, 2).join('\n') + '\n')
  await new Promise(res => setTimeout(res, 1200))
  r.stop()
  const n = got.length
  appendFileSync(f, line(5) + '\n')
  await new Promise(res => setTimeout(res, 1200))
  const linesMsgs = got.filter(g => g.m.type === 'lines')
  const first = linesMsgs[0]?.m.type === 'lines' ? linesMsgs[0].m.lines : []
  const later = linesMsgs.slice(1).flatMap(g => (g.m.type === 'lines' ? g.m.lines : []))
  const laterAt = linesMsgs[1]?.t ?? Infinity
  const caught = got.filter(g => g.m.type === 'caughtUp')
  const statuses = got.filter(g => g.m.type === 'status').length
  const caughtAfterBacklog = got.findIndex(g => g.m.type === 'caughtUp') > got.findIndex(g => g.m.type === 'lines')
  ok(first.join('|') === lines(0, 3).join('|') && caught.length === 1 && caughtAfterBacklog && later.join('|') === lines(3, 2).join('|')
    && laterAt - wroteAt <= realTail.POLL_MS + 250 && statuses >= 3 && got.length === n,
    `F8 the reader loop at ${realTail.POLL_MS} ms: the backlog (3 lines), caughtUp once after it, the 2 appended lines ${(laterAt - wroteAt).toFixed(0)} ms after their write, ${statuses} status messages; after stop() nothing more (${got.length - n} messages)`)
  h.done()
}

// F9 privacy: only reading
{
  const files = ['spoolTail.ts', 'fsaDir.ts', 'reader.ts', 'fsaReader.worker.ts', 'useWorkerFeed.ts']
  const src = files.map(n => [n, readFileSync(fileURLToPath(new URL(`../src/worker-office/feed/${n}`, import.meta.url)), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')] as const)
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\s*\(/, /createWritable/, /removeEntry/, /create\s*:\s*true/, /\bmove\s*\(/, /navigator\./, /localStorage/]
  const hits = src.flatMap(([n, s]) => banned.filter(b => b.test(s)).map(b => `${n}: ${b}`))
  ok(hits.length === 0, `F9 the feed only reads: no network API, no file write, delete or create in ${files.join(', ')}${hits.length ? ` — found ${hits.join('; ')}` : ''}`)
}

if (!NO_MUTANTS) {
  console.log('mutants of spoolTail.ts (each must make a check fail):')
  const MUTANTS: readonly { id: string; from: string; to: string }[] = [
    { id: 'FM1 an unfinished last line is dropped instead of kept', from: '    t.carry = start >= data.length ? EMPTY : data.slice(start)\n', to: '    t.carry = EMPTY\n' },
    { id: 'FM2 every poll reads the file from its start', from: '      bytes = await f.read(t.read, f.size)\n', to: '      bytes = await f.read(0, f.size)\n' },
    { id: 'FM3 no grace: the old day\'s file is let go at midnight', from: '      for (const t of this.#tails) if (t.until === Infinity) t.until = now + ROLLOVER_GRACE_MS\n', to: '      for (const t of this.#tails) if (t.until === Infinity) t.until = now - 1\n' },
    { id: 'FM4 a file changed under the read counts as read', from: '      if (e instanceof SpoolChanged) { this.stats.retries++; return }\n', to: '      if (e instanceof SpoolChanged) { this.stats.retries++; t.read = f.size; return }\n' },
    { id: 'FM5 day files by the UTC date', from: '  return `events-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`\n', to: '  return `events-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}.jsonl`\n' },
    { id: 'FM6 a shrunk file is read on from the old offset', from: '    if (f.size < t.read) { t.read = 0; t.carry = EMPTY; this.stats.restarts++ }\n', to: '' },
    { id: 'FM7 no backlog: yesterday\'s file is not read', from: '      this.#tails.push({ name: dayBefore(now), read: 0, carry: EMPTY, until: Math.max(now, midnight + ROLLOVER_GRACE_MS) })\n', to: '      void midnight\n' },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'wo-feed-mutant-'))
  const tailPath = fileURLToPath(new URL('../src/worker-office/feed/spoolTail.ts', import.meta.url))
  const fsaPath = fileURLToPath(new URL('../src/worker-office/feed/fsaDir.ts', import.meta.url))
  const relink = (src: string, from: string) => src.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_, pre: string, spec: string) => `${pre}'${pathToFileURL(resolve(dirname(from), spec)).href}'`)
  let caught = 0
  for (const [i, m] of MUTANTS.entries()) {
    let src = readFileSync(tailPath, 'utf8').replace(/\r\n/g, '\n')
    const n = src.split(m.from).length - 1
    if (n !== 1) { ok(false, `${m.id}: the patch applies ${n} times`); continue }
    src = relink(src.replace(m.from, () => m.to), tailPath)
    const file = join(dir, `spoolTail-mutant-${i}.ts`)
    writeFileSync(file, src)
    patchedFsa = join(dir, `fsaDir-mutant-${i}.ts`)
    writeFileSync(patchedFsa, relink(readFileSync(fsaPath, 'utf8'), fsaPath).replace(/'[^']*spoolTail\.ts'/, `'${pathToFileURL(file).href}'`))
    const mod = await import(pathToFileURL(file).href) as TailMod
    let bad: Set<string>
    try { bad = await checks(mod, false) } catch (e) { bad = new Set([`crash ${String(e).split('\n')[0]}`]) }
    if (bad.size > 0) caught++
    ok(bad.size > 0, `${m.id}: ${[...bad].join(', ') || 'no check failed'}`)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(`mutants caught: ${caught} of ${MUTANTS.length}`)
}

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS')
