// What each worker's use does to the object it stands at (plan §4.4 "Per-object action scripts" and "State keys",
// §2 "States, each with its driver", §4.5 call results): the state images of render/stateLayer.ts, chosen for every
// worker from where its BODY is and what it is doing, then drawn by the engine over the building, under the workers.
// Pure TypeScript: no DOM, no timers. The traffic check (scripts/worker-office-traffic-sim.ts) runs this same module.
//
// DERIVED EVERY FRAME, NOT STORED. A point state exists only while its holder's body stands on that point (phase entry,
// settled or exit, its goal the point): so every exit path of the plan's "State keys" (exit beat, retarget, eviction,
// dispose, snap, session end) releases it by construction, and the self-heal pass is the derivation itself. A CARRIED
// state (keyed (shelf slot, worker)) shows while the worker's hands show the pulled volume (render/WorkerSprite.ts
// heldProp: the same answer the sprite draws), at the shelf point the observer's book says it came from (Holding:
// role 'pull' at the shelf once the body stands there, then 'read' / 'readAtShelf' with pulledFrom), so it survives the
// walk to a reading place ("walking to a reading place does not close the gap") and a snap; the only memory is the
// slot a carrier took, dropped as soon as its gap stops showing.
//
// THE SCRIPTS (§4.4; the first column is the moment, "at" = the body on the point):
//   file cabinet   entry: the top drawer opens. In a call: read and refile lift a folder (its gap shows in the open
//                  drawer), search flicks the tabs (leafing), list runs a glint across the folder tops (scanning).
//                  Between calls, stage 1: the folder in hand (its gap); stage 2: the drawer shut. Exit: it is pushed.
//   history shelf  the pull (reachU with the ledger) leaves a gap in the slot it came from, kept while the worker carries
//                  the ledger (also at a records reading place); reading AT the shelf (every reading place taken):
//                  search leafs and write writes on the shelf's ledge; stash puts a box on the shelf for the call.
//   lectern        the lamp is on while anyone stands there; the two ledgers lie open at entry, in a call and at stage
//                  1 (pages turning in the call); at stage 2 and in the exit beat they are closed.
//   bookshelf      the pull leaves a book's gap, kept while the book is carried (manuals: no art in pass 1).
//   reading ledge  papers spread while a reader stands there. Reading table: its lamp on while a reader sits, the book
//                  open except at stage 2 ("book closed") and while standing up.
//   card catalog   a drawer is out while the worker is there (pushed in during the exit beat); the cards flip in a call.
//   PC desk        the screen is on while a worker sits there; typing while its hands are on the keys (the type0/type1
//                  frames: after 4 s in one call it sits back watching, and the screen shows only on); the result line
//                  (§4.5: green ok / red error) for 2 s after the call's result, if it is still there.
//   bench          the screen wakes (ready) at entry; a run fills it (running, the amber lamp blinking); a Monitor
//                  blinks the blue lamp twice, a stop flashes the red one; then the result lamp for 2 s (ok / fail),
//                  then the output stays on the screen (stage 1, "reading the output"); stage 2 and the exit: ready.
//   printer        sheets rise from the Pre to the Post (printing); after the Post the pages wait in the tray (done)
//                  until the worker walks off with them.
//   front desk     a hand-in slides the paper into OUT (0.5 s) then signs the book (1.5 s); a sign-out signs (1.5 s);
//                  a background-helper ticket drops into IN (0.5 s); AskUserQuestion lifts the handset while the worker
//                  shows the handset frame (phoneU), until its next event. The desk's two halves hold fixed parts (the
//                  OUT and IN trays on the E tile, the book and the phone on the W tile), whichever spot the worker uses.
//   in/out board   arriving at the board for an arrival hold, the worker flips its own magnet (0.5 s: edge-on, then its
//                  steel back), then the magnet shows its state colour again (magnetOf).
// The door is the engine's (walkers within its sense range); the magnets' presence and colours, the OUT stack and the
// IN tray are the observer's aggregates (world.objects).
import type { ObjectTileKind, Tile } from '../map/loadMap.ts'
import type { PlaceId, PlaceLayout, PlacePoint } from '../map/places.ts'
import type { PropId } from '../render/props.ts'
import { BOOK_SLOTS, LEDGER_SLOTS, baseChain, stateArt, statePhase, type MagnetState, type StateArt } from '../render/stateLayer.ts'
import { heldProp, poseOf } from '../render/WorkerSprite.ts'
import { HAND_IN_MS, SIGN_MS } from '../core/places.ts'
import type { WorkerState } from './world.ts'

/** §4.5: a bench or desk call's result shows for 2 s. */
export const RESULT_MS = 2000
/** §4.4 in/out board: "flip its own magnet (0.5 s)"; each half of the flip is one magnet state. */
export const FLIP_MS = 500
/** §4.4 front desk: "drop a slip into IN (0.5 s)". */
export const TICKET_MS = HAND_IN_MS
/** §4.4 bench: a Monitor's blue lamp "blinks twice", a stop's red lamp flashes: two cycles of the 4 fps two-phase
 *  lamp at the nominal rate. */
export const BLINKS_MS = 1000

/** One image to draw: a state frame over one object tile. */
export interface ObjLayer {
  /** The object tile it covers (tile coordinates). */
  x: number
  y: number
  art: StateArt
  /** variant * phases + phase (stateLayer.ts stateFrame). */
  frame: number
  /** The worker whose use it shows. */
  key: string
  /** The point the worker stands on, or (a carried gap) the shelf point it pulled from. */
  place: PlaceId
  /** A carried gap (drawn first, for every carrier) or a point state / one of its bases. */
  carried: boolean
}

interface Carry {
  readonly place: PlaceId
  readonly x: number
  readonly y: number
  readonly art: StateArt
  readonly slot: number
  readonly prop: PropId
}

/** The phases a worker can be in while its body is on the point it was sent to. */
const AT = new Set(['entry', 'settled', 'exit'])
/** Stage 2's front poses (§4.5): an exit beat that starts from one began with the object already at rest. */
const STAGE2_POSES = new Set(['ponderD', 'armsD', 'sitBackLean'])
/** The slot colours, in the order of the carried states' variants (stateLayer.ts LEDGER_SLOTS / BOOK_SLOTS). */
const LEDGER_SLOT_COLOURS: readonly string[] = LEDGER_SLOTS.map(s => s.colour)
const BOOK_SLOT_COLOURS: readonly string[] = BOOK_SLOTS.map(s => s.colour)
/** The observer's booking of a worker, as far as a carried state needs it (map/places.ts Holding). */
export interface BookedPlace { readonly place: PlaceId; readonly role: string; readonly pulledFrom: PlaceId | null }
export type BookLookup = (key: string) => BookedPlace | null
/** The shelves whose pull leaves a carried gap with art (pass 1: no binder art for the manuals shelf). */
const CARRIED: Readonly<Partial<Record<string, { readonly state: string; readonly prop: PropId }>>> = {
  historyShelf: { state: 'ledgerOut', prop: 'ledger' },
  bookshelf: { state: 'bookOut', prop: 'book' },
}

export class ObjectStates {
  readonly layout: PlaceLayout
  /** This frame's images, in draw order: carried gaps, then each point's chain base first. Valid up to `count`. */
  readonly layers: ObjLayer[] = []
  count = 0
  readonly #carry = new Map<string, Carry>()
  readonly #list: WorkerState[] = []
  readonly #chains = new Map<StateArt, StateArt[]>()
  readonly #tiles = new Map<string, Tile>()

  constructor(layout: PlaceLayout) {
    this.layout = layout
  }

  /** The binding colour of the volume a worker carries (the slot it pulled), or null. */
  carriedColour(key: string): string | null {
    const c = this.#carry.get(key)
    if (c === undefined) return null
    return (c.art.state === 'ledgerOut' ? LEDGER_SLOT_COLOURS : BOOK_SLOT_COLOURS)[c.slot] ?? null
  }

  /** How many carried slots are remembered (checks: none once everyone has left). */
  get carriedSlots(): number { return this.#carry.size }

  /** The shelf slot a worker's carried volume came from (checks). */
  carried(key: string): { readonly place: PlaceId; readonly slot: number; readonly state: string } | null {
    const c = this.#carry.get(key)
    return c === undefined ? null : { place: c.place, slot: c.slot, state: c.art.state }
  }

  /** Recompute the images for `now` from the workers (world.workers.values()) and the observer's bookings. */
  update(workers: Iterable<WorkerState>, now: number, book: BookLookup): number {
    this.count = 0
    const list = this.#list
    list.length = 0
    for (const w of workers) list.push(w)
    list.sort((a, b) => a.n - b.n)
    for (const [key, c] of this.#carry) {
      const w = this.#find(list, key)
      if (w === null || this.#shelfOf(w, book) !== c.place || heldProp(w, now) !== c.prop) this.#carry.delete(key)
    }
    for (const w of list) this.#noteCarry(w, now, book)
    for (const w of list) {
      const c = this.#carry.get(w.key)
      if (c !== undefined) this.#push(c.x, c.y, c.art, c.slot * c.art.phases, w.key, c.place, true)
    }
    for (const w of list) this.#pointStates(w, now)
    return this.count
  }

  /** The magnet a worker's arrival-hold flip shows (§4.4 in/out board), or null when it is not flipping. */
  flipOf(w: WorkerState, now: number): MagnetState | null {
    const p = this.#atPoint(w)
    if (p === null || p.kind !== 'inOutBoard' || w.phase === 'exit') return null
    const t = now - w.arrivedAt
    return t < 0 || t >= FLIP_MS ? null : t < FLIP_MS / 2 ? 'flip0' : 'flip1'
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────
  #find(list: readonly WorkerState[], key: string): WorkerState | null {
    for (const w of list) if (w.key === key) return w
    return null
  }

  /** The point the worker's body stands on now (entry, settled or exit at its goal), else null. */
  #atPoint(w: WorkerState): PlacePoint | null {
    if (!w.onGrid || w.leaving !== null || !AT.has(w.phase) || w.goal === null || w.goal.kind !== 'place') return null
    const p = this.layout.place(w.goal.place)
    return p.type === 'point' ? p : null
  }

  /** The shelf point a worker's volume comes from, by the observer's book: the shelf it is pulling at (once its body
   *  stands there), or the one its reading place's pull came from. Null when it carries nothing from a shelf, or is on
   *  its way out. */
  #shelfOf(w: WorkerState, book: BookLookup): PlaceId | null {
    if (!w.onGrid || w.leaving !== null || w.phase === 'fading') return null
    const h = book(w.key)
    if (h === null) return null
    if (h.role === 'read' || h.role === 'readAtShelf') return h.pulledFrom
    if (h.role === 'pull' && w.goal !== null && w.goal.kind === 'place' && w.goal.place === h.place && AT.has(w.phase)) return h.place
    return null
  }

  /** A carried gap (§4.4 fetch-then-read) in a free slot of its shelf, while the hands show the pulled volume. */
  #noteCarry(w: WorkerState, now: number, book: BookLookup) {
    if (this.#carry.has(w.key)) return
    const from = this.#shelfOf(w, book)
    if (from === null) return
    const p = this.layout.place(from)
    if (p.type !== 'point') return
    const spec = CARRIED[p.kind]
    if (spec === undefined || heldProp(w, now) !== spec.prop) return
    const art = stateArt(this.#tileKind(p.useTile), spec.state)
    if (art === undefined) return
    const taken = new Set<number>()
    for (const [k, c] of this.#carry) if (k !== w.key && c.x === p.useTile.x && c.y === p.useTile.y) taken.add(c.slot)
    let slot = (w.seed >>> 0) % art.variants
    for (let i = 0; i < art.variants && taken.has(slot); i++) slot = (slot + 1) % art.variants
    this.#carry.set(w.key, { place: p.id, x: p.useTile.x, y: p.useTile.y, art, slot, prop: spec.prop })
  }

  #tileKind(t: Tile): ObjectTileKind {
    return this.layout.map.tiles[t.y][t.x] as ObjectTileKind
  }

  /** The tile of the point's object that carries `tile`'s art: the point's own use tile, else the instance's tile of
   *  that kind (the front desk's fixed parts). Cached. */
  #tileOf(p: PlacePoint, tile: ObjectTileKind): Tile | null {
    if (this.#tileKind(p.useTile) === tile) return p.useTile
    const k = `${p.id}|${tile}`
    const hit = this.#tiles.get(k)
    if (hit !== undefined) return hit
    const inst = this.layout.instances.find(i => i.id === p.objectId)
    const t = inst?.tiles.find(t => this.#tileKind(t) === tile) ?? null
    if (t !== null) this.#tiles.set(k, t)
    return t
  }

  #chain(a: StateArt): StateArt[] {
    let c = this.#chains.get(a)
    if (c === undefined) { c = baseChain(a); this.#chains.set(a, c) }
    return c
  }

  #push(x: number, y: number, art: StateArt, frame: number, key: string, place: PlaceId, carried: boolean) {
    let l = this.layers[this.count]
    if (l === undefined) { l = { x, y, art, frame, key, place, carried }; this.layers.push(l) }
    else { l.x = x; l.y = y; l.art = art; l.frame = frame; l.key = key; l.place = place; l.carried = carried }
    this.count++
  }

  /** A point state with its base chain (bases first; a carried base is the carrier's own gap, already drawn), the
   *  variant from the worker's id hash, looping phases at the worker's own rate from its own offset, or a one-shot
   *  phase from t0 (held on its last phase). */
  #show(w: WorkerState, p: PlacePoint, tile: ObjectTileKind, state: string, now: number, t0: number | null = null) {
    const a = stateArt(tile, state)
    if (a === undefined) return
    const at = this.#tileOf(p, tile)
    if (at === null) return
    const t = now / 1000
    for (const b of this.#chain(a)) {
      if (b.driver === 'carried') continue
      this.#push(at.x, at.y, b, ((w.seed >>> 0) % b.variants) * b.phases + statePhase(b, t, w.rate, w.loopOff), w.key, p.id, false)
    }
    const phase = t0 === null ? statePhase(a, t, w.rate, w.loopOff) : Math.min(a.phases - 1, Math.max(0, Math.floor(((now - t0) / 1000) * a.fps)))
    this.#push(at.x, at.y, a, ((w.seed >>> 0) % a.variants) * a.phases + phase, w.key, p.id, false)
  }

  #pointStates(w: WorkerState, now: number) {
    const p = this.#atPoint(w)
    if (p === null) return
    const tile = this.#tileKind(p.useTile)
    const settled = w.phase === 'settled', entry = w.phase === 'entry', exit = w.phase === 'exit'
    const stage2 = settled ? w.filler : exit && w.exitPose !== null && STAGE2_POSES.has(w.exitPose)
    const inUnit = settled && (w.inCall || now < w.unitUntil)
    const act = w.activity
    const held = heldProp(w, now)
    const pose = poseOf(w, now)
    const result = w.callEnd !== null && w.callEnd.place === p.id && w.callEnd.result !== 'neutral' && now - w.callEnd.at < RESULT_MS ? w.callEnd.result : null
    switch (p.kind) {
      case 'fileCabinet': {
        if (stage2) return
        let s = 'drawerOpen'
        if (inUnit && act === 'search') s = 'leafing'
        else if (inUnit && act === 'list') s = 'scanning'
        else if (settled && held === 'folder') s = 'folderOut'
        this.#show(w, p, tile, s, now)
        return
      }
      case 'historyShelf': {
        if (inUnit && act === 'stash') { this.#show(w, p, tile, 'box', now); return }
        if (settled && !stage2 && inUnit && pose === 'readU' && held === 'ledger') {
          if (act === 'hist-search') this.#show(w, p, tile, 'leafing', now)
          else if (act === 'hist-write') this.#show(w, p, tile, 'writing', now)
        }
        return
      }
      case 'lectern':
        this.#show(w, p, tile, inUnit ? 'turning' : (entry || settled) && !stage2 ? 'compare' : 'lampOn', now)
        return
      case 'readingLedge':
        this.#show(w, p, tile, 'spread', now)
        return
      case 'readingTable':
        this.#show(w, p, tile, (entry || settled) && !stage2 ? 'openBook' : 'lampOn', now)
        return
      case 'cardCatalog':
        this.#show(w, p, tile, inUnit && act === 'websearch' ? 'flipping' : 'drawerOut', now)
        return
      case 'pcDesk':
        this.#show(w, p, tile, settled && (pose === 'type0' || pose === 'type1') ? 'typing' : settled && result !== null ? (result === 'fail' ? 'error' : 'ok') : 'on', now)
        return
      case 'benchTerminal': {
        let s = 'ready'
        if (inUnit) {
          if (act === 'watch') s = now - w.actAt < BLINKS_MS ? 'watching' : 'ready'
          else if (act === 'stop') s = now - w.actAt < BLINKS_MS ? 'stopped' : 'ready'
          else s = 'running'
        } else if (settled && result !== null) s = result
        else if (settled && !stage2 && w.callEnd !== null && w.callEnd.place === p.id) s = 'output'
        this.#show(w, p, tile, s, now)
        return
      }
      case 'printer':
        if (w.prop === 'printout') this.#show(w, p, tile, 'done', now)
        else if (inUnit && act === 'report') this.#show(w, p, tile, 'printing', now)
        return
      case 'frontDesk': {
        if (!settled) return
        if (pose === 'phoneU') { this.#show(w, p, 'frontDeskW', 'onPhone', now); return }
        // the desk's one-shots start once the worker stands at the counter (its entry beat over)
        const ready = Math.max(w.arrivedAt, w.beatUntil)
        if (w.label === 'handIn') {
          const t0 = Math.max(w.labelAt, ready), t = now - t0
          if (t < HAND_IN_MS) this.#show(w, p, 'frontDeskE', 'handIn', now, t0)
          else if (t < HAND_IN_MS + SIGN_MS) this.#show(w, p, 'frontDeskW', 'signing', now, t0 + HAND_IN_MS)
          return
        }
        if (w.label === 'signOut') {
          if (now - ready < SIGN_MS) this.#show(w, p, 'frontDeskW', 'signing', now, ready)
          return
        }
        // the launch that sent it here: a background launch returns in about 0.3 s, long before the body reaches the
        // desk, so the slip is dropped when it gets there (or at the launch, for one made at the desk)
        if (act === 'helper-bg') {
          const t0 = Math.max(w.actAt, ready)
          if (now - t0 < TICKET_MS) this.#show(w, p, 'frontDeskE', 'ticket', now, t0)
        }
        return
      }
      default:
        return
    }
  }
}

