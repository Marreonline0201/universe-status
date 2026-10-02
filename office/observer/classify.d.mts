// Types for the parts of classify.mjs that TypeScript code imports (the page's observer core, src/worker-office/core,
// and the scripts/worker-office-*.ts checks). classify.mjs stays the ONE source of the classifier: this file only
// declares its exports, it implements nothing. The hook installer copies classify.mjs and spool-hook.mjs only
// (install-hook.mjs FILES), so this file never reaches the installed hook.

/** [activity text, object kind or null = no move]. */
export type Category = readonly [activity: string, kind: string | null]

/** The object kinds by precedence, highest first (plan §4.3 P1; lead ruling F11: inOutBoard last). */
export const PRECEDENCE: readonly string[]
/** A kind's precedence rank (lower = higher precedence); a kind not in PRECEDENCE ranks below all, no kind lowest. */
export function rank(kind: string | null | undefined): number
/** Every object kind the classifier emits (= PRECEDENCE). */
export const KINDS: ReadonlySet<string>
/** The library station kinds (the ToolSearch rule). */
export const LIBRARY_KINDS: ReadonlySet<string>
/** Activity text -> the spool's activity id (`a`). */
export const ACTIVITY_ID: ReadonlyMap<string, string>
/** The spool's activity id (`a`) -> activity text. */
export const ACTIVITY_BY_ID: ReadonlyMap<string, string>
/** OBSERVER side: a record's category at the worker's current station (the library rule for ToolSearch). */
export function resolveAtStation(activity: string, kind: string | null, tsr: boolean | undefined, station: string | null): Category
