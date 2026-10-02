// The WORKER OFFICE tab's live feed (plan §5.1 option B, §5.3 "useWorkerFeed", §6.6): the owner grants this page READ
// access to the spool folder once (C:\Users\<you>\.universe-office\spool), and a Web Worker (fsaReader.worker.ts) reads
// the day files every 500 ms; the lines go to the engine's live world (the sink). The page only reads that folder:
// nothing is written, nothing is sent anywhere. Chrome and Edge only (File System Access).
//
// THE STATES the tab shows:
//   unsupported  this browser has no folder access (not Chrome / Edge): the building stays empty
//   idle         not connected: "Connect log folder" opens the folder picker (it needs the click: a user gesture)
//   connecting   connected; reading the backlog (yesterday's and today's files so far)
//   live         connected · live: the office shows the workers now and follows new lines
//   reconnect    reconnect needed: a folder is remembered (IndexedDB) but this visit has no permission yet (Chrome asks
//                again on later visits unless the owner chose to allow on every visit); "Reconnect" asks with one click
//   paused       the example plays; live reading stops and starts again (a reconnect: backlog and snap) after it
// The folder handle is kept in IndexedDB (this origin only), never its contents.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReaderMsg } from './reader.ts'

export type LiveState = 'unsupported' | 'idle' | 'connecting' | 'live' | 'reconnect' | 'paused'

/** Where the lines go (the engine): a new live world, its lines, the end of the backlog, the end of live. */
export interface LiveSink {
  start(): void
  lines(lines: readonly string[]): void
  caughtUp(): void
  stop(): void
}

export interface WorkerFeed {
  readonly state: LiveState
  /** The granted folder's name (File System Access gives no path). */
  readonly folder: string | null
  /** One line about what the reader does now (the file it reads, or why it stopped). */
  readonly detail: string
  /** Pick the folder (call it from the click itself: the picker needs the user gesture). */
  connect(): void
  /** Ask again for the remembered folder (from the click itself). */
  reconnect(): void
  /** Stop reading while the example plays. */
  pause(): void
  /** Read again after the example (a reconnect: the backlog, then a snap). */
  resume(): void
}

// ── File System Access parts that TypeScript's DOM library does not declare ───────────────────────────────────────
type Perm = 'granted' | 'denied' | 'prompt'
interface PermissionHandle {
  queryPermission(d: { mode: 'read' }): Promise<Perm>
  requestPermission(d: { mode: 'read' }): Promise<Perm>
}
type DirectoryPicker = (o: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
const picker = (): DirectoryPicker | null => {
  const w = (typeof window === 'undefined' ? undefined : window) as unknown as { showDirectoryPicker?: DirectoryPicker } | undefined
  return typeof w?.showDirectoryPicker === 'function' ? w.showDirectoryPicker.bind(w) : null
}
const permission = (h: FileSystemDirectoryHandle) => h as unknown as PermissionHandle
const errName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '')

const DAY_FILE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/
async function hasDayFiles(h: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const name of (h as unknown as { keys(): AsyncIterable<string> }).keys()) if (DAY_FILE.test(name)) return true
  return false
}
/** The spool folder: the picked one, or its 'spool' child when the owner picked .universe-office itself. */
async function spoolFolder(h: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  if (await hasDayFiles(h).catch(() => false)) return h
  try {
    const s = await h.getDirectoryHandle('spool')
    if (await hasDayFiles(s)) return s
  } catch { /* no spool child: keep the picked folder (today's file may not exist yet) */ }
  return h
}

// ── the remembered folder (IndexedDB, this origin only) ───────────────────────────────────────────────────────────
const DB = 'universe-worker-office', STORE = 'handles', KEY = 'spool'
function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE) }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(STORE, mode)
      const req = op(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}
const loadHandle = () => idb<FileSystemDirectoryHandle | undefined>('readonly', s => s.get(KEY) as IDBRequest<FileSystemDirectoryHandle | undefined>)
const saveHandle = (h: FileSystemDirectoryHandle) => idb('readwrite', s => s.put(h, KEY))

export function useWorkerFeed(sink: LiveSink): WorkerFeed {
  const sinkRef = useRef(sink)
  useEffect(() => { sinkRef.current = sink })
  const [state, setState] = useState<LiveState>(() => (picker() ? 'idle' : 'unsupported'))
  const [folder, setFolder] = useState<string | null>(null)
  const [detail, setDetail] = useState('')
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null)
  const workerRef = useRef<Worker | null>(null)

  const stopWorker = useCallback(() => {
    const w = workerRef.current
    if (w === null) return
    workerRef.current = null
    w.postMessage({ type: 'stop' })
    w.terminate()
  }, [])

  const start = useCallback((h: FileSystemDirectoryHandle) => {
    stopWorker()
    sinkRef.current.start()
    const w = new Worker(new URL('./fsaReader.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<ReaderMsg>) => {
      if (workerRef.current !== w) return
      const m = e.data
      switch (m.type) {
        case 'lines': sinkRef.current.lines(m.lines); break
        case 'caughtUp': sinkRef.current.caughtUp(); setState('live'); break
        case 'status': setDetail(m.exists ? `reading ${m.file} · ${m.lines} lines so far` : `waiting for today's log file (${m.file})`); break
        case 'error':
          if (m.kind === 'permission') { stopWorker(); sinkRef.current.stop(); setState('reconnect'); setDetail('the folder permission was taken back') }
          else setDetail(`reading failed, retrying: ${m.message}`)
          break
      }
    }
    w.onerror = ev => { setDetail(`the reader stopped: ${ev.message}`) }
    handleRef.current = h
    setFolder(h.name)
    setDetail('reading the log so far…')
    setState('connecting')
    w.postMessage({ type: 'start', dir: h })
  }, [stopWorker])

  // a folder remembered from an earlier visit: read at once if the permission still holds, else offer "Reconnect"
  useEffect(() => {
    if (picker() === null) return
    let gone = false
    void (async () => {
      const h = await loadHandle().catch(() => undefined)
      if (gone || h === undefined) return
      handleRef.current = h
      setFolder(h.name)
      const p = await permission(h).queryPermission({ mode: 'read' }).catch((): Perm => 'prompt')
      if (gone) return
      if (p === 'granted') start(h)
      else { setState('reconnect'); setDetail('Chrome asks again on a new visit') }
    })()
    return () => { gone = true; stopWorker() }
  }, [start, stopWorker])

  const connect = useCallback(() => {
    const pick = picker()
    if (pick === null) return
    pick({ id: 'worker-office-spool', mode: 'read' }).then(async picked => {
      const h = await spoolFolder(picked)
      await saveHandle(h).catch(() => { /* not remembered: the next visit asks for the folder again */ })
      start(h)
    }, e => { if (errName(e) !== 'AbortError') setDetail(`the folder could not be opened: ${errName(e) || String(e)}`) })
  }, [start])

  const reconnect = useCallback(() => {
    const h = handleRef.current
    if (h === null) { connect(); return }
    permission(h).requestPermission({ mode: 'read' }).then(p => {
      if (p === 'granted') start(h)
      else setDetail('permission not given: press Reconnect, or Connect log folder to pick the folder again')
    }, e => setDetail(`the permission request failed: ${errName(e) || String(e)}`))
  }, [connect, start])

  const pause = useCallback(() => {
    if (workerRef.current === null) return
    stopWorker()
    setState('paused')
    setDetail('live reading stops while the example plays')
  }, [stopWorker])

  const resume = useCallback(() => {
    const h = handleRef.current
    if (h !== null) start(h)
  }, [start])

  return { state, folder, detail, connect, reconnect, pause, resume }
}
