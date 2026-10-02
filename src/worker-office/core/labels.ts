// The worker office's fixed label set (plan §4.10): every bubble, hover and banner text is one of these phrases.
// No text is ever built from tool input; the only parameters are a whole number {n} (minutes, a capacity) and {st},
// a station name from STATION_NAME below. Both come from closed sets, so a label can never carry a file name, a path,
// a command or a prompt.
//
// Activity labels are keyed by the classifier's activity ids (office/observer/classify.mjs ACTIVITY_ID: the spool's
// `a` field); scripts/worker-office-core-replay.ts checks that every id the classifier can write has a label.
import type { StationKind } from '../map/places.ts'

export const LABELS = {
  // ── the tool categories (one per classify.mjs activity id) ──
  'act:none': 'doing a small step (no category)',
  'act:read': 'reading a file',
  'act:search': 'searching file contents',
  'act:list': 'listing file names',
  'act:refile': 'refiling (moving or making folders)',
  'act:write': 'writing a file',
  'act:run': 'running a program',
  'act:wait': 'waiting on a run',
  'act:stop': 'stopping a job',
  'act:fetch': 'reading an outside document',
  'act:send': 'sending something outside',
  'act:receive': 'receiving from outside',
  'act:copy': 'copying or packing files',
  'act:delete': 'deleting files',
  'act:check': 'checking the machine',
  'act:diff': 'comparing versions',
  'act:hist-read': 'reading the history',
  'act:hist-search': 'searching the history',
  'act:hist-write': 'writing to the history',
  'act:restore': 'restoring files',
  'act:stash': 'setting work aside (stash)',
  'act:glance': 'glancing at the history',
  'act:websearch': 'searching the web',
  'act:procedure': 'following a procedure',
  'act:toolsearch': 'looking up a tool',
  'act:tasks': 'planning or tracking tasks',
  'act:mail-send': 'sending internal mail',
  'act:mail-collect': 'collecting mail',
  'act:watch': 'watching a background job',
  'act:roster': 'looking at the roster',
  'act:report': 'handing in its report (being checked)',
  'act:form': 'handing in a result form',
  'act:ask': 'asking the owner a question',
  'act:helper-bg': 'launching a background helper',
  'act:helper-fg': 'waiting for its helper',
  // ── arrival ──
  arriving: 'arriving',
  arrivalHold: 'reading the job ticket',
  slotWait: 'arrived: waiting outside (display limit)',
  back: 'coming back in',
  // ── between calls (§4.5) ──
  between: 'thinking or writing its next step (no event says which)',
  // ── display limits (§4.7) ──
  waitPool: 'waiting: all {n} {st} in use (display limit)',
  waitQueued: 'waiting: all {st} in use (display limit)',
  finishQueue: 'finishing: waiting for the front desk (display limit)',
  // ── finishing (§4.6) ──
  carryReport: 'carrying its report to the front desk',
  carryForm: 'carrying its result form to the front desk',
  handIn: 'handing in and signing the book',
  handedIn: 'handed in; waiting for sign-off',
  signOut: 'signing out at the front desk',
  // ── pauses and background waits (§4.2, §4.6) ──
  pausedUnknown: 'paused (reason unknown)',
  pausedNoHandback: 'waiting or finished (no hand-back signal in this mode)',
  waitShell: 'waiting for its background job (shell)',
  waitMonitor: 'waiting for its background job (monitor)',
  waitHelper: 'waiting for its background job (helper)',
  // ── quiet and long calls (§4.6 "Killed or silent") ──
  quiet: 'no events for {n} min',
  suspect: 'may have stopped? (no events for {n} min)',
  running: 'running {n} min',
  stuck: 'may be stuck? (running {n} min)',
  // ── call results (§4.5) ──
  callFail: 'the call failed',
  callOk: 'no failure recorded',
  // ── exits ──
  leaving: 'leaving',
  finishedInferred: 'finished (inferred from the task list)',
  evicted: 'left: no events for 30 min (inferred)',
  signOffCap: 'left: no sign-off within 90 s (inferred)',
  waitCap: 'left: waited 2 h 10 min (inferred)',
  sessionEnded: 'left: the session ended',
  // ── banners ──
  sessionQuiet: 'No events from this session for {n} min (paused, rate-limited or the computer slept)',
  officeCleared: 'office cleared: no events for 2 h (inferred)',
} as const satisfies Record<string, string>

export type LabelId = keyof typeof LABELS
export const LABEL_IDS = Object.keys(LABELS) as LabelId[]
const LABEL_SET: ReadonlySet<string> = new Set(LABEL_IDS)
export const isLabelId = (s: string): s is LabelId => LABEL_SET.has(s)

/** The station names a label may name ({st}), plural. */
export const STATION_NAME: Readonly<Record<StationKind, string>> = {
  fileCabinet: 'file cabinets', historyShelf: 'history shelves', lectern: 'lecterns', bookshelf: 'bookshelves',
  cardCatalog: 'card catalogs', manualsShelf: 'manuals shelves', pcDesk: 'PC desks', benchTerminal: 'bench terminals',
  kanbanBoard: 'kanban boards', meetingTable: 'meeting seats', pigeonholes: 'pigeonholes', postShelf: 'post shelves',
  copier: 'copiers', printer: 'printers', shredder: 'shredders', frontDesk: 'front-desk spots', lounge: 'lounge seats',
}

/** The label of a spool activity id; an id outside the classifier's set reads as the no-category label. */
export function activityLabel(activity: string): LabelId {
  const id = `act:${activity}`
  return isLabelId(id) ? id : 'act:none'
}

export interface LabelParams { readonly n?: number | null; readonly st?: StationKind | null }

/** The text of a label. Throws for a template whose parameter is missing (never a half-filled phrase). */
export function labelText(id: LabelId, p: LabelParams = {}): string {
  return LABELS[id].replace(/\{(n|st)\}/g, (_, k: string) => {
    if (k === 'n') {
      if (p.n == null || !Number.isInteger(p.n) || p.n < 0) throw new Error(`label ${id}: {n} needs a whole number`)
      return String(p.n)
    }
    if (p.st == null) throw new Error(`label ${id}: {st} needs a station`)
    return STATION_NAME[p.st]
  })
}
