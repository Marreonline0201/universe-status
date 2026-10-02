// The live feed's Web Worker (plan §5.1 option B, §6.4 "Feed adapter"): it reads the spool folder the owner granted
// (a FileSystemDirectoryHandle sent by useWorkerFeed.ts) every 500 ms and posts the new lines to the page. The page
// runs the observer core; this worker only reads (feed/reader.ts, feed/spoolTail.ts, feed/fsaDir.ts). It never writes,
// never fetches, and never sends anything anywhere but to the page that started it.
//
// From the page: { type: 'start', dir } (once), { type: 'stop' }. To the page: reader.ts ReaderMsg.
import { fsaDir } from './fsaDir.ts'
import { runReader, type ReaderMsg } from './reader.ts'

interface WorkerScope {
  onmessage: ((e: MessageEvent<{ readonly type: 'start'; readonly dir: FileSystemDirectoryHandle } | { readonly type: 'stop' }>) => void) | null
  postMessage(m: ReaderMsg): void
  close(): void
}
const scope = self as unknown as WorkerScope
let reader: { stop(): void } | null = null

scope.onmessage = e => {
  const m = e.data
  if (m.type === 'start' && reader === null) reader = runReader(fsaDir(m.dir), msg => scope.postMessage(msg))
  else if (m.type === 'stop') { reader?.stop(); reader = null; scope.close() }
}
