// What the observer core says (plan §5.3). Two layers, one stream:
//   Cmd          the renderer commands, in order: the ONLY thing the reducer emits. The page's worker engine (a later
//                stage) consumes them; scripts/worker-office-core-replay.ts asserts them exactly.
//   FeedMessage  plan §5.3's message names, a lossless grouping of the same stream for a feed (toFeedMessages /
//                fromFeedMessages are inverses; the replay checks the round trip on every scenario), plus the
//                WORKERS_SNAPSHOT a page needs on (re)connect ("snap everyone to place", §4.6).
// Every value is an id from a closed set or a number: worker and session keys are hashes (the page never needs a real
// agent or session id, §5.3), places are PlaceIds, poses are figure frames, labels are LabelIds (labels.ts).
import type { PlaceId, StationKind } from '../map/places.ts'
import type { PoseName, PropId } from '../render/props.ts'
import type { LabelId } from './labels.ts'

/** A hash of the agent id ('w' + 8 hex). */
export type WorkerKey = string
/** A hash of the session id ('s' + 8 hex). */
export type SessionKey = string

/** Why a worker left. finished: a real end (stop, hand-in, sign-out); the rest are labelled inferences or session
 *  events. */
export type ExitReason = 'finished' | 'finishedInferred' | 'evicted' | 'signOffCap' | 'waitCap' | 'sessionEnded' | 'officeCleared'
/** §4.5: fail = a PostToolUseFailure for the call; ok = none recorded (the Failure hook is installed); neutral = an
 *  interrupt, or no Failure hook. */
export type CallResult = 'ok' | 'fail' | 'neutral'

export type Cmd =
  /** WORKER_ENTER: fade in already walking near sidewalk slot `slot` (index into arrivalSlots then
   *  arrivalSlotsOverflow; -1 = held off screen, a labelled display delay). back = a re-entry with the same look. */
  | { readonly op: 'spawn'; readonly t: number; readonly key: WorkerKey; readonly n: number; readonly seed: number; readonly slot: number; readonly back: boolean }
  /** Walk (Path A) to a booked place: the observer's booking changed. */
  | { readonly op: 'walkTo'; readonly t: number; readonly key: WorkerKey; readonly place: PlaceId }
  /** The steady pose at the place (a pose ending in 0 with a 1 sibling, e.g. type0, is that 2-frame loop), the
   *  carried prop, the pager clipped to the belt (an outstanding background launch, §4.4 bench row; props.ts HAND
   *  belt anchor), and whether the pose is labelled filler (§4.11: stage 2's turn to the camera). */
  | { readonly op: 'pose'; readonly t: number; readonly key: WorkerKey; readonly pose: PoseName; readonly prop: PropId | null; readonly belt: boolean; readonly filler: boolean }
  /** The worker's label (§4.10). */
  | { readonly op: 'bubble'; readonly t: number; readonly key: WorkerKey; readonly label: LabelId; readonly n: number | null; readonly st: StationKind | null }
  /** A call starts (inCall, the per-call unit; the same station again = the 0.4 s "next item" gesture) or the step's
   *  calls have all resolved (inCall false). activity = the spool's activity id. */
  | { readonly op: 'act'; readonly t: number; readonly key: WorkerKey; readonly seq: number; readonly kind: StationKind | null; readonly activity: string; readonly inCall: boolean }
  /** A bench or desk call result (§4.5), decided after the 1.0 s result window; place = where the call ran. */
  | { readonly op: 'callEnd'; readonly t: number; readonly key: WorkerKey; readonly seq: number; readonly place: PlaceId | null; readonly result: CallResult }
  /** WORKER_EXIT by walking: via 'out' = the OUT leaf and the exit lane; 'direct' = straight out through x=15..16
   *  (evicted or stale, §4.6). Its bookings are already released. */
  | { readonly op: 'leave'; readonly t: number; readonly key: WorkerKey; readonly reason: ExitReason; readonly via: 'out' | 'direct' }
  /** WORKER_EXIT without walking (office cleared). */
  | { readonly op: 'fade'; readonly t: number; readonly key: WorkerKey; readonly reason: ExitReason }
  /** OBJECTS (aggregates, plan §2): rack LEDs = workers with a call in flight; magnets = the ordinals of the workers
   *  inside; the OUT stack = hand-ins; the IN tray = tickets (a helper's background launches). */
  | { readonly op: 'objects'; readonly t: number; readonly rackLeds: number; readonly magnets: readonly number[]; readonly outStack: number; readonly inTray: number }
  /** SESSION_STATE: a session's quiet banner, or the office-cleared banner (scope office); label null = cleared.
   *  since = the time of the last record (of that session; of any session for the office): the page shows the minutes
   *  since then ({n} of the label). */
  | { readonly op: 'banner'; readonly t: number; readonly scope: 'session' | 'office'; readonly session: SessionKey | null; readonly label: LabelId | null; readonly since: number | null }

export type CmdOp = Cmd['op']

/** A worker as the snapshot shows it. */
export interface WorkerView {
  readonly key: WorkerKey
  readonly n: number
  readonly seed: number
  readonly session: SessionKey
  readonly phase: string
  readonly station: StationKind | null
  readonly place: PlaceId | null
  readonly pose: PoseName
  readonly prop: PropId | null
  readonly belt: boolean
  readonly filler: boolean
  readonly label: LabelId
  readonly labelN: number | null
  readonly labelSt: StationKind | null
  readonly activity: string
  readonly inCall: boolean
}

export interface ObjectsView { readonly rackLeds: number; readonly magnets: readonly number[]; readonly outStack: number; readonly inTray: number }
export interface BannerView { readonly scope: 'session' | 'office'; readonly session: SessionKey | null; readonly label: LabelId; readonly since: number }

type Without<C, K extends string> = C extends unknown ? Omit<C, K> : never
type CmdOf<O extends CmdOp> = Extract<Cmd, { op: O }>
type IntentOp = 'walkTo' | 'pose' | 'bubble' | 'act'

/** Plan §5.3's messages. WORKER_INTENT groups one worker's consecutive walkTo / pose / bubble / act commands (each at
 *  most once, in emission order); the plan's sketch lists phase/kind/place/read?/activity/inCall/labels, which these
 *  carry as place, pose, the label and the act. */
export type FeedMessage =
  | { readonly type: 'WORKERS_SNAPSHOT'; readonly t: number; readonly workers: readonly WorkerView[]; readonly objects: ObjectsView; readonly banners: readonly BannerView[] }
  | ({ readonly type: 'WORKER_ENTER' } & Without<CmdOf<'spawn'>, 'op'>)
  | { readonly type: 'WORKER_INTENT'; readonly key: WorkerKey; readonly parts: readonly Without<CmdOf<IntentOp>, 'key'>[] }
  | ({ readonly type: 'WORKER_CALL_END' } & Without<CmdOf<'callEnd'>, 'op'>)
  | ({ readonly type: 'WORKER_EXIT' } & Without<CmdOf<'leave' | 'fade'>, never>)
  | ({ readonly type: 'OBJECTS' } & Without<CmdOf<'objects'>, 'op'>)
  | ({ readonly type: 'SESSION_STATE' } & Without<CmdOf<'banner'>, 'op'>)

const INTENT_OPS: ReadonlySet<CmdOp> = new Set<CmdOp>(['walkTo', 'pose', 'bubble', 'act'])
const isIntent = (c: Cmd): c is CmdOf<IntentOp> => INTENT_OPS.has(c.op)

/** Group a command stream into §5.3 messages (lossless: fromFeedMessages gives the same stream back). */
export function toFeedMessages(cmds: readonly Cmd[]): FeedMessage[] {
  const out: FeedMessage[] = []
  let intent: { key: WorkerKey; parts: Without<CmdOf<IntentOp>, 'key'>[]; ops: Set<CmdOp> } | null = null
  const close = () => { if (intent) out.push({ type: 'WORKER_INTENT', key: intent.key, parts: intent.parts }); intent = null }
  for (const c of cmds) {
    if (isIntent(c)) {
      if (intent === null || intent.key !== c.key || intent.ops.has(c.op)) { close(); intent = { key: c.key, parts: [], ops: new Set() } }
      const { key: _key, ...part } = c
      intent.parts.push(part)
      intent.ops.add(c.op)
      continue
    }
    close()
    switch (c.op) {
      case 'spawn': { const { op: _op, ...rest } = c; out.push({ type: 'WORKER_ENTER', ...rest }); break }
      case 'callEnd': { const { op: _op, ...rest } = c; out.push({ type: 'WORKER_CALL_END', ...rest }); break }
      case 'leave': case 'fade': out.push({ type: 'WORKER_EXIT', ...c }); break
      case 'objects': { const { op: _op, ...rest } = c; out.push({ type: 'OBJECTS', ...rest }); break }
      case 'banner': { const { op: _op, ...rest } = c; out.push({ type: 'SESSION_STATE', ...rest }); break }
    }
  }
  close()
  return out
}

/** The command stream of §5.3 messages (a snapshot carries no commands: the page snaps to it instead). */
export function fromFeedMessages(msgs: readonly FeedMessage[]): Cmd[] {
  const out: Cmd[] = []
  for (const m of msgs) {
    switch (m.type) {
      case 'WORKERS_SNAPSHOT': break
      case 'WORKER_ENTER': { const { type: _t, ...rest } = m; out.push({ op: 'spawn', ...rest }); break }
      case 'WORKER_INTENT': for (const p of m.parts) out.push({ ...p, key: m.key } as Cmd); break
      case 'WORKER_CALL_END': { const { type: _t, ...rest } = m; out.push({ op: 'callEnd', ...rest }); break }
      case 'WORKER_EXIT': { const { type: _t, ...rest } = m; out.push(rest); break }
      case 'OBJECTS': { const { type: _t, ...rest } = m; out.push({ op: 'objects', ...rest }); break }
      case 'SESSION_STATE': { const { type: _t, ...rest } = m; out.push({ op: 'banner', ...rest }); break }
    }
  }
  return out
}
