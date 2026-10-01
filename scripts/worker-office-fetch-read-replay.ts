// Parity replay of the planning-phase capacity model (replay_fetch_read.py, plan §3.4 "fetch-then-read replay"),
// driven through the SHIPPED reservation book (src/worker-office/map/places.ts). Run:
//   node scripts/worker-office-fetch-read-replay.ts <measure_final_same409.json> [<replay_fetch_read_final_out.json>]
// The measurement file comes from the owner's own work sessions and is never committed: without it this prints
// "not run: data absent" and exits 3. The reference output defaults to replay_fetch_read_final_out.json next to it.
//
// Python's event loop, kept exactly: one owner per interval [hid, kind, a, b] (kind != ARRIVING, b > a); events in
// heap order (t, type, i) with end = 0 < start = 1 < pull end = 2; a pull lasts PULL_S = 1.2 s from the change that
// granted it, and its timer ends that pull by its id. Every decision — which point, sibling, pool, the wait list, the
// fetch-then-read reading place, the step-aside, who is served when a place frees — is the book's (assign / endPull /
// release); this script only feeds it the events and counts. A start counts as queued when the book's result says so
// (read after the call's cascades). Points are chosen from the helper's last place (the IN leaf for its first), which
// moves workers but never changes a count.
// The statistics are measured where Python measures them: points in use when an own point is granted (take_point),
// reading places in use when a pull ends on one (try_take_reading), the wait list when someone joins it, and the busy
// time / full reading pools on the state before each event. Counts are read from a shadow ledger rebuilt from the
// book's change records, which must equal the book's own state after every call.
// Exit: 0 = every number matches, 2 = a number differs (the table says which), 3 = data absent, 1 = a crash.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMap } from '../src/worker-office/map/loadMap.ts'
import { buildPlaceLayout, PlaceBook, READING_POOL, STATION_KINDS, type Change, type Room, type StationKind } from '../src/worker-office/map/places.ts'

const dataPath = process.argv[2]
if (!dataPath || !existsSync(dataPath)) { console.log('not run: data absent'); process.exit(3) }
const refPath = process.argv[3] ?? join(dirname(dataPath), 'replay_fetch_read_final_out.json')
const PULL_S = 1.2

const map = loadMap(JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8')))
const layout = buildPlaceLayout(map)
const book = new PlaceBook(layout)
const t0 = performance.now()

type Interval = [string, string, number, number]
const MEAS = JSON.parse(readFileSync(dataPath, 'utf8')) as { intervals: Interval[] }
const ivs = MEAS.intervals.filter(([, k, a, b]) => k !== 'ARRIVING' && b > a)
for (const [, k] of ivs) if (!(STATION_KINDS as readonly string[]).includes(k)) throw new Error(`interval kind ${k} is not a station`)

// heap of [t, type, i] — Python heapq on (t, type, i, what)
type Ev = [number, number, number]
const less = (a: Ev, b: Ev) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
const heap: Ev[] = []
const push = (e: Ev) => {
  heap.push(e)
  for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p }
}
const pop = (): Ev => {
  const top = heap[0], last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1
      let m = i
      if (l < heap.length && less(heap[l], heap[m])) m = l
      if (r < heap.length && less(heap[r], heap[m])) m = r
      if (m === i) break
      ;[heap[i], heap[m]] = [heap[m], heap[i]]; i = m
    }
  }
  return top
}
ivs.forEach(([, , a, b], i) => { push([a, 1, i]); push([b, 0, i]) })

const owner = (i: number) => String(i)
const IN_LEAF = map.door.inLeaf
const lastTile = new Map<string, { x: number; y: number }>()     // helper id -> its last place
const shadow = new Map<string, string>()                          // place -> owner, from the change records only
const readingMembers: Record<Room, readonly string[]> = {
  records: layout.pools.get(READING_POOL.records)!.members, library: layout.pools.get(READING_POOL.library)!.members,
}
const shadowCount = (ids: readonly string[]) => ids.reduce((n, id) => n + (shadow.has(id) ? 1 : 0), 0)

const pullOf = new Map<number, number>()                          // interval -> the id of the pull it was granted
const episodes = new Map<string, number>()
const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by)
const waits: [string, number][] = []
const waitStart = new Map<number, number>()
const neverServed = new Map<string, number>()
const maxRead = new Map<string, number>()
const maxObj = new Map<string, number>()
const pulls = new Map<string, number>()
const fallback = new Map<string, number>()
const full = new Map<Room, number>([['records', 0], ['library', 0]])
let maxQueued = 0, busy = 0, lastT: number | null = null
const causes = new Map<string, number>()

function apply(changes: readonly Change[], t: number) {
  for (const c of changes) {
    bump(causes, `${c.cause}${c.role ? ':' + c.role : ''}`)
    if (c.from !== null && shadow.get(c.from) === c.owner) shadow.delete(c.from)
    if (c.to !== null) {
      const other = shadow.get(c.to)
      if (other !== undefined && other !== c.owner) throw new Error(`change ${c.seq}: ${c.to} given to ${c.owner} while ${other} holds it`)
      shadow.set(c.to, c.owner)
    }
    const i = Number(c.owner)
    const kind = ivs[i][1]
    if (c.to !== null) {
      lastTile.set(ivs[i][0], layout.place(c.to))
      const ws = waitStart.get(i)
      if (ws !== undefined) { waits.push([kind, t - ws]); waitStart.delete(i) }     // a queued owner got a place
      if (c.role === 'pull') { push([t + PULL_S, 2, i]); pullOf.set(i, c.seq) }   // every pull change starts a pull; its seq is the pull id
      if ((c.role === 'use' || c.role === 'pull') && c.forKind !== null) {         // take_point: an own point granted
        const n = shadowCount(layout.stations.get(c.forKind)!.points)
        if (n > (maxObj.get(c.forKind) ?? 0)) maxObj.set(c.forKind, n)
      }
      if (c.cause === 'pullDone' && c.role === 'read') {                             // try_take_reading
        const room = layout.readingRoomOf(c.to)!
        const n = shadowCount(readingMembers[room])
        if (n > (maxRead.get(room) ?? 0)) maxRead.set(room, n)
      }
    }
  }
  // the shadow must be the book's own state
  const holdings = book.holdings()
  if (holdings.length !== shadow.size || holdings.some(h => shadow.get(h.place) !== h.owner)) {
    throw new Error(`the change records do not rebuild the book's state at t=${t}`)
  }
}

while (heap.length > 0) {
  const [t, type, i] = pop()
  if (lastT !== null && t > lastT && shadow.size > 0) {
    busy += t - lastT
    for (const room of ['records', 'library'] as const) if (shadowCount(readingMembers[room]) >= readingMembers[room].length) full.set(room, full.get(room)! + (t - lastT))
  }
  lastT = t
  const [hid, k] = ivs[i]
  const kind = k as StationKind
  if (type === 1) {
    const r = book.assign(owner(i), kind, lastTile.get(hid) ?? IN_LEAF)
    if (r.how === 'sibling') bump(episodes, `${k} -> sibling ${r.via}`)
    else if (r.how === 'pool') bump(episodes, `${k} -> waited on ${r.via}`)
    else if (r.how === 'queued') {
      bump(episodes, `${k} -> queued`)
      waitStart.set(i, t)
      maxQueued = Math.max(maxQueued, book.waiters().filter(w => book.holding(w.owner)?.role !== 'wait').length)   // queued = waiting on no pool tile
    }
    apply(r.changes, t)
  } else if (type === 2) {
    const h = book.holding(owner(i))
    if (h?.role !== 'pull' || h.pull !== pullOf.get(i)) continue
    bump(pulls, k)
    apply(book.endPull(owner(i), h.pull), t)
    if (book.holding(owner(i))?.role === 'readAtShelf') bump(fallback, k)
  } else {
    if (waitStart.has(i)) { bump(neverServed, k); waitStart.delete(i) }
    apply(book.release(owner(i)), t)
  }
}

// Python's round(x, n): the exact binary value rounded half to even
function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, Math.abs(x))
  const hi = dv.getUint32(0), lo = dv.getUint32(4), eb = (hi >>> 20) & 0x7ff
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  let exp = -1074
  if (eb !== 0) { mant |= 1n << 52n; exp = eb - 1075 }
  const scale = 10n ** BigInt(nd)
  let n: bigint
  if (exp >= 0) n = mant * scale * (1n << BigInt(exp))
  else {
    const num = mant * scale, den = 1n << BigInt(-exp)
    n = num / den
    const twice = 2n * (num - n * den)
    if (twice > den || (twice === den && (n & 1n) === 1n)) n += 1n
  }
  const r = Number(`${n}e-${nd}`)
  return x < 0 ? -r : r
}
const q = (v: number[], p: number) => {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  return pyRound(s[Math.min(s.length - 1, Math.floor(p * s.length))], 1)
}
const wv = waits.map(([, w]) => w)
const obj = (m: Map<string, number>) => Object.fromEntries(m)
const out = {
  model: `fetch-then-read at historyShelf/bookshelf/cardCatalog/manualsShelf; PULL_S=${PULL_S.toFixed(1)} s`,
  n_intervals: ivs.length,
  episodes: obj(episodes),
  queue_waits: {
    n: wv.length, p50_s: q(wv, 0.5), p90_s: q(wv, 0.9), max_s: wv.length ? pyRound(Math.max(...wv), 1) : null,
    by_kind: obj(waits.reduce((m, [kk]) => bump(m, kk), new Map<string, number>())),
  },
  never_served_whole_interval: obj(neverServed),
  max_simultaneous_queued: maxQueued,
  max_reading_places_in_use: obj(maxRead),
  max_points_in_use: obj(maxObj),
  pulls: obj(pulls),
  read_at_the_shelf_point_because_no_reading_place_free: obj(fallback),
  share_of_busy_time_reading_pool_full: { records: pyRound(full.get('records')! / busy, 5), library: pyRound(full.get('library')! / busy, 5) },
}
const ms = performance.now() - t0

// ── parity table ──
const ref = existsSync(refPath) ? JSON.parse(readFileSync(refPath, 'utf8')) as Record<string, unknown> : null
const rows: [string, unknown, unknown][] = []
const walk = (path: string, a: unknown, b: unknown) => {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (isObj(a) || isObj(b)) {
    const ka = isObj(a) ? Object.keys(a) : [], kb = isObj(b) ? Object.keys(b) : []
    if (ka.length === 0 && kb.length === 0) { rows.push([path, a, b]); return }      // {} on both sides is a number too
    for (const k of [...new Set([...ka, ...kb])].sort()) walk(path ? `${path}.${k}` : k, isObj(a) ? a[k] : undefined, isObj(b) ? b[k] : undefined)
  } else rows.push([path, a, b])
}
if (ref) { const { input: _input, ...refRest } = ref; void _input; walk('', refRest, out) }
console.log(`fetch-then-read replay through places.ts: ${ivs.length} intervals in ${ms.toFixed(0)} ms`)
console.log(`booking changes by cause:role: ${JSON.stringify(Object.fromEntries([...causes].sort()))}`)
if (!ref) { console.log(JSON.stringify(out, null, 1)); console.log(`no reference at ${refPath}: nothing compared`); process.exit(2) }
let differ = 0
const show = (v: unknown) => v === undefined ? '(absent)' : JSON.stringify(v)
console.log(`${'number'.padEnd(72)} ${'Python'.padStart(10)} ${'TS'.padStart(10)}`)
for (const [path, a, b] of rows) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  if (!same) differ++
  console.log(`${path.padEnd(72)} ${show(a).padStart(10)} ${show(b).padStart(10)}  ${same ? 'match' : 'DIFFERS'}`)
}
console.log(`${rows.length - differ} of ${rows.length} numbers match exactly${differ ? `; ${differ} differ` : ''}`)
process.exit(differ ? 2 : 0)
