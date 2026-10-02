// Which folder the live feed keeps, from the one the owner picked (feed/useWorkerFeed.ts "Connect log folder";
// security review L2). Pure over a small directory interface, so the node check (scripts/worker-office-feed-check.ts)
// drives the same code.
//
//   kept      the picked folder, when it is named `spool` (the hook's folder, even before its first day file) or
//             already holds day files (events-YYYY-MM-DD.jsonl);
//   kept      its `spool` child, when it has one (the owner picked .universe-office itself), even an empty one;
//   refused   any other folder, with a reason the tab shows: nothing is stored and nothing is read.
const DAY_FILE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/

/** What chooseSpoolFolder reads of a FileSystemDirectoryHandle. */
export interface DirLike {
  readonly name: string
  keys(): AsyncIterable<string>
  getDirectoryHandle(name: string): Promise<DirLike>
}

export type FolderChoice<D extends DirLike> = { readonly ok: true; readonly dir: D } | { readonly ok: false; readonly reason: string }

export const NOT_THE_SPOOL = 'That folder is not the log folder, so nothing was connected or stored. Pick the folder named spool inside .universe-office in your home folder.'

async function hasDayFiles(h: DirLike): Promise<boolean> {
  for await (const name of h.keys()) if (DAY_FILE.test(name)) return true
  return false
}

export async function chooseSpoolFolder<D extends DirLike>(picked: D): Promise<FolderChoice<D>> {
  if (picked.name === 'spool') return { ok: true, dir: picked }
  if (await hasDayFiles(picked).catch(() => false)) return { ok: true, dir: picked }
  try {
    return { ok: true, dir: await picked.getDirectoryHandle('spool') as D }
  } catch {
    return { ok: false, reason: NOT_THE_SPOOL }
  }
}
