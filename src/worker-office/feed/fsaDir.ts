// The spool folder through Chrome's File System Access (plan §5.1 option B): the SpoolDir that spoolTail.ts reads.
// Read-only by construction: it asks for files by name (never create: true), takes a File snapshot of each, and reads
// a byte range of it (Blob.slice: only those bytes are read). Nothing here writes, deletes or sends anything.
//
// A File from getFile() is a SNAPSHOT: Chrome refuses to read it once the file on disk has changed after it was taken
// (NotReadableError). The hook appends while the page reads, so that happens; it surfaces as SpoolChanged and the tail
// reads the same range again at its next poll. A file that is not there (NotFoundError) is null: no event today yet.
// Any other error is the folder's own (NotAllowedError: the permission was taken back) and goes to the reader.
import { SpoolChanged, type SpoolDir, type SpoolFile } from './spoolTail.ts'

/** What fsaDir uses of a FileSystemDirectoryHandle (the checks pass a stand-in built on node's file snapshots). */
export interface DirHandleLike {
  getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>
}

const errName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '')

export function fsaDir(dir: DirHandleLike): SpoolDir {
  return {
    async open(name: string): Promise<SpoolFile | null> {
      let file: Blob
      try {
        file = await (await dir.getFileHandle(name)).getFile()
      } catch (e) {
        if (errName(e) === 'NotFoundError') return null
        throw e
      }
      return {
        size: file.size,
        async read(start: number, end: number): Promise<Uint8Array> {
          try {
            return new Uint8Array(await file.slice(start, end).arrayBuffer())
          } catch (e) {
            if (errName(e) === 'NotReadableError') throw new SpoolChanged(name)
            throw e
          }
        },
      }
    },
  }
}
