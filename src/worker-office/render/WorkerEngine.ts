// Canvas host of the worker office (plan §6.1, §6.4). It draws the building, and the workers of a feed: today only the
// EXAMPLE feed (live/example.ts, labelled as an example by the tab); the live feed comes later and plays through the same
// path (live/world.ts: the observer core -> the Path A planner -> the bodies and their beats).
//
// Pixel rules:
//   - the backing store is the canvas's device-pixel content box (ResizeObserver 'device-pixel-content-box'),
//     so canvas pixels are screen pixels;
//   - the scale is an INTEGER number of device pixels per texel and the camera offset is a whole number of device
//     pixels, so zoom × devicePixelRatio is always an integer and every texel is an exact block of pixels (the old
//     engine's fractional fit zoom of ~2.01 blurred and unevened the pixel art, OfficeEngine.ts:211-224);
//   - the fit is camera.ts fitCamera: the largest whole scale that fits, below the DOM overlay when there is room
//     for it (setTopInset).
// Drawing happens only when something changes, or every animation frame while a feed plays or workers are inside. A
// resize redraws at once: setting the canvas size clears it, and a ResizeObserver callback runs after the frame's
// animation callbacks and before its paint, so a redraw left to the next frame would show a blank map for every step of
// a sidebar drag or window resize. With no feed, draw() allocates nothing; with workers it sorts a few small arrays.
// WORKERS (plan §4.7 "one simulation clock"): one sim clock drives the feed, the observer core, the planner and the
// drawing; each frame advances it by the frame's time, at most 50 ms. While the tab is hidden nothing runs and the clock
// stands still, so the workers carry on where they were when it is shown again (the engine survives tab switches).
// Workers are drawn in texel space at the engine's integer scale (exact texel blocks), in the painter's order of their
// feet, over the room labels; then their bubbles: an icon each, the newest labels as text (at most 4, plan §4.8).
// Input: drag to pan; the wheel and a two-finger pinch zoom in whole steps; double-click fits. With keyboard focus
// on the canvas: arrow keys pan, + and - zoom, 0 fits.
// Lifecycle: built once per page; while its tab is hidden it stops drawing and ignores the 0×0 resize, so coming
// back neither rebuilds nor re-fits anything. destroy() disposes the feed's world (core, planner, workers).
// Checks read the engine's `debug` object (live getters, built once). It is also window.__workerOffice, but only in
// dev builds (the visual check runs on the dev server) or with ?woDebug in the address.
import { TILE } from './floors.ts'
import { DOOR_SLIDE_MAX, doorLeaves, drawInTray, drawMagnets, drawOutStack, type MagnetState } from './stateLayer.ts'
import { type LabelPlacement, type OfficeScene, labelFont, placeLabels, prerenderBuilds, texel } from './prerender.ts'
import { WheelZoom, fitCamera } from './camera.ts'
import { figureSet, lookOf, type FigureSet } from './figures.ts'
import { ICON_ONLY, MAX_TEXT_BUBBLES, TEXT_BUBBLE_MS, bubbleText, drawIconBubble, drawWorker, iconOf, newView, spriteView, type SpriteView } from './WorkerSprite.ts'
import type { PlaceLayout } from '../map/places.ts'
import { ObserverCore } from '../core/reducer.ts'
import { PathPlanner } from '../move/planner.ts'
import { WorkerWorld, type WorkerState } from '../live/world.ts'
import { ExamplePlayer } from '../live/example.ts'

const VOID = '#05070f'          // the app chrome around the building
const MAX_SCALE = 12
/** A two-finger pinch steps the zoom each time the finger distance has grown or shrunk by this factor. */
const PINCH_STEP = 1.25
/** The arrow keys pan by this many tiles. */
const KEY_PAN_TILES = 2
const LABEL_INK = 'rgba(244,238,226,0.82)'
const LABEL_SHADOW = 'rgba(0,0,0,0.65)'
/** The sim clock advances at most this much per frame (plan §4.7, OfficeEngine.ts:344). */
const MAX_FRAME_MS = 50
/** The front door (plan §4.8): opens in 0.4 s for a walker within its sense range, closes in 0.5 s, 1.5 s after the
 *  last one has gone. */
const DOOR_OPEN_MS = 400, DOOR_CLOSE_MS = 500, DOOR_HOLD_MS = 1500
/** Text bubbles: a fixed phrase (core/labels.ts) in the UI font at 16 CSS px × the text scale (the old engine's
 *  drawBubble: "16px base (owner's floor)"), wrapped at BUBBLE_WRAP characters. */
const BUBBLE_FONT_PX = 16
const BUBBLE_WRAP = 30
const BUBBLE_INK = '#e8ecf2'
const BUBBLE_EDGE = 'rgba(77,159,255,0.55)'

/** A text bubble placed over a worker's head, device pixels. */
interface TextBubble { readonly key: string; readonly alpha: number; readonly lines: readonly string[]; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly pad: number; readonly lh: number }

/** What the tab shows about the feed (WorkerOffice.tsx). */
export type FeedState = 'none' | 'example'
export interface WorkerLine { readonly n: number; readonly text: string }
export interface FeedSummary { readonly feed: FeedState; readonly workers: number; readonly lines: readonly WorkerLine[]; readonly seconds: number }

/** Read-only state for automated checks (engine.debug; window.__workerOffice where exposed). */
export interface WorkerOfficeDebug {
  readonly engines: number
  readonly prerenders: number
  readonly active: boolean
  readonly dpr: number
  /** device pixels per texel (an integer) */
  readonly deviceScale: number
  /** CSS pixels per texel = deviceScale / dpr */
  readonly zoom: number
  readonly backing: [number, number]
  readonly css: [number, number]
  readonly offset: [number, number]
  readonly world: [number, number]
  /** the overlay band the fit keeps the building below, device px */
  readonly insetTop: number
  /** true while the camera is still at the fit (no pan or zoom since) */
  readonly fitted: boolean
  readonly fontScale: number
  readonly draws: number
  readonly labels: readonly string[]
  readonly workers: number
  /** the feed playing ('none' or 'example'), its sim time in s, the figure frames drawn this frame */
  readonly feed: FeedState
  readonly feedSeconds: number
  readonly figuresDrawn: number
  readonly floorTexel: (x: number, y: number) => string
  readonly mapTexel: (x: number, y: number) => string
}
type DebugState = Omit<WorkerOfficeDebug, 'floorTexel' | 'mapTexel'>
type DebugWindow = { __workerOffice?: WorkerOfficeDebug }

let engines = 0

/** window.__workerOffice is installed in dev builds, or on any build with ?woDebug in the address. */
function exposeDebug(): boolean {
  if (import.meta.env?.DEV) return true
  try { return new URLSearchParams(globalThis.location?.search ?? '').has('woDebug') } catch { return false }
}

export class WorkerEngine {
  readonly debug: WorkerOfficeDebug
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly scene: OfficeScene
  private readonly ro: ResizeObserver
  private readonly worldW: number
  private readonly worldH: number
  private bw = 0
  private bh = 0
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private insetTopCss = 0
  private scale = 1
  private offX = 0
  private offY = 0
  private fitted = true
  private active = false
  private destroyed = false
  private raf = 0
  private draws = 0
  private fontScale = 1
  private labels: readonly LabelPlacement[] = []
  private labelFonts: readonly string[] = []
  private labelTexts: readonly string[] = []
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private drag: { id: number; x: number; y: number; offX: number; offY: number } | null = null
  private pinchDist = 0
  private readonly wheel = new WheelZoom()
  // the feed's workers (null: no feed)
  private world: WorkerWorld | null = null
  private player: ExamplePlayer | null = null
  private feed: FeedState = 'none'
  private sim = Date.now()
  private lastFrame: number | null = null
  private loop = 0
  private figuresDrawn = 0
  private readonly views = new Map<string, SpriteView>()
  private readonly sets = new Map<string, FigureSet>()
  private readonly order: { key: string; v: SpriteView; w: WorkerState }[] = []
  private readonly magnetStates: MagnetState[] = []
  private doorOpen = 0
  private doorClearAt = -Infinity
  private readonly boardOrigin: [number, number] | null
  private readonly deskOrigin: [number, number] | null

  constructor(canvas: HTMLCanvasElement, scene: OfficeScene) {
    engines++
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    this.scene = scene
    this.worldW = scene.map.width * TILE
    this.worldH = scene.map.height * TILE
    const board = scene.map.objects.find(o => o.kind === 'inOutBoard'), desk = scene.map.objects.find(o => o.kind === 'frontDesk')
    this.boardOrigin = board ? [board.x * TILE, board.y * TILE] : null
    this.deskOrigin = desk ? [(desk.x + 1) * TILE, desk.y * TILE] : null   // the E tile: the IN tray and the OUT stack
    this.relabel()
    this.ro = new ResizeObserver(entries => { const e = entries[entries.length - 1]; if (e) this.onResize(e) })
    try { this.ro.observe(canvas, { box: 'device-pixel-content-box' }) } catch { this.ro.observe(canvas) }
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('dblclick', this.onDblClick)
    canvas.addEventListener('keydown', this.onKeyDown)
    // the label metrics change once the web font has loaded: place them again
    void document.fonts?.ready.then(() => { if (this.destroyed) return; this.relabel(); this.requestDraw() })
    this.debug = this.makeDebug()
    if (exposeDebug()) (window as unknown as DebugWindow).__workerOffice = this.debug
  }

  destroy() {
    this.destroyed = true
    this.active = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
    cancelAnimationFrame(this.loop)
    this.loop = 0
    this.world?.dispose()
    this.world = null
    this.player = null
    this.views.clear()
    this.sets.clear()
    this.ro.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDblClick)
    this.canvas.removeEventListener('keydown', this.onKeyDown)
    this.pointers.clear()
    this.drag = null
    const w = window as unknown as DebugWindow
    if (w.__workerOffice === this.debug) delete w.__workerOffice
  }

  /** The tab is showing (draw) or hidden (draw nothing; keep the world as it is: its clock stands still). */
  setActive(active: boolean) {
    if (this.destroyed) return
    this.active = active
    if (active) { this.requestDraw(); this.startLoop() }
    else { cancelAnimationFrame(this.raf); this.raf = 0; cancelAnimationFrame(this.loop); this.loop = 0; this.lastFrame = null }
  }

  // ── the feed ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Play the EXAMPLE feed (synthetic events, never the owner's spool) through a new world: the observer core with the
   *  page's body signals, the Path A planner, the bodies. A feed already playing is disposed first. */
  playExample(layout: PlaceLayout) {
    if (this.destroyed) return
    this.stopFeed()
    this.world = new WorkerWorld(layout, new ObserverCore(layout, { bodySignals: true }), new PathPlanner(layout))
    this.player = new ExamplePlayer(this.sim)
    this.feed = 'example'
    this.startLoop()
  }

  /** Stop the feed: its world (core, planner, workers) is disposed and the building is empty again. */
  stopFeed() {
    this.world?.dispose()
    this.world = null
    this.player = null
    this.feed = 'none'
    this.views.clear()
    this.doorOpen = 0
    this.requestDraw()
  }

  /** The feed, the workers inside and their labels (fixed phrases), for the tab's room key. */
  summary(): FeedSummary {
    const lines: WorkerLine[] = []
    if (this.world) for (const w of this.world.workers.values()) lines.push({ n: w.n, text: w.onGrid ? bubbleText(w) : 'arrived: waiting outside (display limit)' })
    lines.sort((a, b) => a.n - b.n)
    return { feed: this.feed, workers: lines.length, lines, seconds: this.player ? Math.max(0, (this.sim - this.player.base) / 1000) : 0 }
  }

  private startLoop() {
    if (this.loop || !this.active || this.destroyed || this.world === null) return
    this.loop = requestAnimationFrame(this.frame)
  }

  /** One animation frame of a feed: advance the one sim clock, step the world, draw. Ends when the feed is over and the
   *  building is empty (the tab shows the no-feed note again). */
  private frame = (ts?: number) => {
    this.loop = 0
    if (!this.active || this.destroyed || this.world === null) return
    const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : performance.now()
    const dt = this.lastFrame === null ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, t - this.lastFrame))
    this.lastFrame = t
    this.sim += dt
    const world = this.world, sim = this.sim
    this.player?.deliver(sim, line => world.ingest(line, sim))
    world.step(sim)
    this.stepDoor(dt)
    this.drawNow()
    if (this.player !== null && this.player.done && world.workers.size === 0) { this.stopFeed(); return }
    this.loop = requestAnimationFrame(this.frame)
  }

  /** The door opens only for a real walker within its sense range (plan §1.2). */
  private stepDoor(dt: number) {
    const d = this.scene.map.door
    let near = false
    if (this.world) {
      for (const w of this.world.workers.values()) {
        if (!w.onGrid || (w.phase !== 'walking' && w.phase !== 'appearing' && w.phase !== 'leaving')) continue   // walkers only
        const dx = Math.max(0, d.x - w.pos.x, w.pos.x - (d.x + d.w - 1)), dy = Math.abs(w.pos.y - d.y)
        if (Math.max(dx, dy) <= d.senseTiles) { near = true; break }
      }
    }
    if (near) this.doorClearAt = this.sim
    const opening = near || this.sim - this.doorClearAt < DOOR_HOLD_MS
    this.doorOpen = Math.min(1, Math.max(0, this.doorOpen + (opening ? dt / DOOR_OPEN_MS : -dt / DOOR_CLOSE_MS)))
  }

  /** Global UI text scale (SettingsContext): the room labels are placed again for it. */
  setFontScale(s: number) {
    if (this.destroyed || s === this.fontScale) return
    this.fontScale = s
    this.relabel()
    this.requestDraw()
  }

  /** Bottom of the DOM overlay over the top of the canvas, CSS px from the canvas top. The fit keeps the building
   *  below it when there is room. Changing it re-fits only while the camera is still at the fit. */
  setTopInset(cssPx: number) {
    const v = Math.max(0, Math.round(cssPx * 100) / 100)
    if (this.destroyed || v === this.insetTopCss) return
    this.insetTopCss = v
    if (this.fitted) { this.fit(); this.requestDraw() }
  }

  // ── size and camera ──────────────────────────────────────────────────────────────────────────────────────────
  private onResize(e: ResizeObserverEntry) {
    const cssW = e.contentRect.width, cssH = e.contentRect.height
    if (cssW < 1 || cssH < 1) return // hidden (display: none): keep the camera
    const dpr = window.devicePixelRatio || 1
    const dp = e.devicePixelContentBoxSize?.[0]
    const bw = dp ? dp.inlineSize : Math.round(cssW * dpr)
    const bh = dp ? dp.blockSize : Math.round(cssH * dpr)
    this.cssW = cssW
    this.cssH = cssH
    if (bw === this.bw && bh === this.bh && dpr === this.dpr) return
    this.bw = bw
    this.bh = bh
    this.dpr = dpr
    this.canvas.width = bw   // clears the bitmap
    this.canvas.height = bh
    this.fit()
    // Repaint now, in this frame. The canvas is visible by definition here: a hidden tab reports 0×0 (above).
    this.drawNow()
  }

  /** The camera only (callers decide how to draw): fitCamera at the current size and overlay. */
  private fit() {
    if (this.bw < 1 || this.bh < 1) return
    const f = fitCamera(this.bw, this.bh, this.worldW, this.worldH, this.insetTopCss * this.devicePerCss())
    this.scale = f.scale
    this.offX = f.offX
    this.offY = f.offY
    this.fitted = true
  }

  /** Keep at least a strip of the building on screen; whole device pixels. */
  private clampOffset() {
    const keep = 48
    this.offX = Math.round(Math.min(this.bw - keep, Math.max(keep - this.worldW * this.scale, this.offX)))
    this.offY = Math.round(Math.min(this.bh - keep, Math.max(keep - this.worldH * this.scale, this.offY)))
  }

  private devicePerCss() { return this.cssW > 0 ? this.bw / this.cssW : this.dpr }

  private panBy(dx: number, dy: number) {
    this.offX += dx
    this.offY += dy
    this.fitted = false
    this.clampOffset()
    this.requestDraw()
  }

  /** Zoom to a whole scale around a canvas point (device px): the texel under it stays put. */
  private zoomAt(mx: number, my: number, next: number) {
    const s = Math.min(MAX_SCALE, Math.max(1, next))
    if (s === this.scale) return
    const wx = (mx - this.offX) / this.scale, wy = (my - this.offY) / this.scale
    this.scale = s
    this.offX = mx - wx * s
    this.offY = my - wy * s
    this.fitted = false
    this.clampOffset()
    this.requestDraw()
  }

  private zoomAtClient(clientX: number, clientY: number, next: number) {
    const rect = this.canvas.getBoundingClientRect()
    const k = this.devicePerCss()
    this.zoomAt((clientX - rect.left) * k, (clientY - rect.top) * k, next)
  }

  // ── input ────────────────────────────────────────────────────────────────────────────────────────────────────
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.regrip()
  }
  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (this.pointers.size >= 2) { this.pinchMove(); return }
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    const k = this.devicePerCss()
    this.offX = d.offX + (e.clientX - d.x) * k
    this.offY = d.offY + (e.clientY - d.y) * k
    this.fitted = false
    this.clampOffset()
    this.requestDraw()
  }
  private onPointerUp = (e: PointerEvent) => {
    if (this.pointers.delete(e.pointerId)) this.regrip()
  }
  /** (Re)start the gesture from the pointers that are down now: one pans, two pinch. Runs whenever a pointer goes
   *  down or up, so lifting one finger of a pinch carries on as a pan from where that finger is, without a jump. */
  private regrip() {
    const it = this.pointers.entries()
    const first = it.next()
    const second = it.next()
    this.drag = !first.done && second.done
      ? { id: first.value[0], x: first.value[1].x, y: first.value[1].y, offX: this.offX, offY: this.offY }
      : null
    this.pinchDist = !first.done && !second.done
      ? Math.hypot(first.value[1].x - second.value[1].x, first.value[1].y - second.value[1].y)
      : 0
  }
  /** Two fingers: one whole zoom step each time their distance changes by PINCH_STEP, around their midpoint. */
  private pinchMove() {
    const it = this.pointers.values()
    const a = it.next().value!, b = it.next().value!
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    if (this.pinchDist <= 0) { this.pinchDist = d; return }
    const dir = d >= this.pinchDist * PINCH_STEP ? 1 : d <= this.pinchDist / PINCH_STEP ? -1 : 0
    if (dir === 0) return
    this.pinchDist = d
    this.zoomAtClient((a.x + b.x) / 2, (a.y + b.y) / 2, this.scale + dir)
  }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault() // the canvas owns the wheel: no page scroll, no browser zoom on ctrl+wheel, no swipe navigation
    const dir = this.wheel.step(e.deltaY, e.deltaMode, e.timeStamp)
    if (dir !== 0) this.zoomAtClient(e.clientX, e.clientY, this.scale + dir)
  }
  private onDblClick = () => { this.fit(); this.requestDraw() }
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const pan = KEY_PAN_TILES * TILE * this.scale
    switch (e.key) {
      case 'ArrowLeft': this.panBy(pan, 0); break
      case 'ArrowRight': this.panBy(-pan, 0); break
      case 'ArrowUp': this.panBy(0, pan); break
      case 'ArrowDown': this.panBy(0, -pan); break
      case '+': case '=': this.zoomAt(this.bw / 2, this.bh / 2, this.scale + 1); break
      case '-': case '_': this.zoomAt(this.bw / 2, this.bh / 2, this.scale - 1); break
      case '0': this.fit(); this.requestDraw(); break
      default: return
    }
    e.preventDefault()
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────
  private requestDraw() {
    if (!this.active || this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.active) this.draw() })
  }

  private drawNow() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0 }
    this.draw()
  }

  /** Room labels for the current text scale, with their canvas fonts built once (not per frame). */
  private relabel() {
    this.labels = placeLabels(this.scene.map, this.ctx, this.fontScale)
    this.labelFonts = this.labels.map(l => labelFont(l.size))
    this.labelTexts = this.labels.map(l => l.text)
  }

  private draw() {
    const { ctx, scene } = this
    if (this.bw < 1 || this.bh < 1) return
    const s = this.scale
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = VOID
    ctx.fillRect(0, 0, this.bw, this.bh)
    ctx.drawImage(scene.layer, this.offX, this.offY, this.worldW * s, this.worldH * s)

    ctx.setTransform(s, 0, 0, s, this.offX, this.offY)
    // layers drawn from the observer's data: the in/out board's magnets, the front desk's OUT stack and IN tray
    if (this.world) this.drawObjects()
    // the front door opens only for a real walker within its sense range (plan §1.2); shut with nobody near
    const door = scene.map.door
    doorLeaves(ctx, door.x * TILE, door.y * TILE, Math.round(this.doorOpen * DOOR_SLIDE_MAX) / DOOR_SLIDE_MAX)

    // room labels (placed from the zones for this text scale); crisp text at the integer scale
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.shadowColor = LABEL_SHADOW
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = Math.max(1, Math.round(s / 2))
    ctx.shadowBlur = 0
    ctx.fillStyle = LABEL_INK
    const labels = this.labels, fonts = this.labelFonts
    for (let i = 0; i < labels.length; i++) {
      ctx.font = fonts[i]
      ctx.fillText(labels[i].text, labels[i].x, labels[i].y)
    }
    ctx.shadowColor = 'transparent'
    if (this.world) this.drawWorkers()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.draws++
  }

  private drawObjects() {
    const { ctx } = this
    const o = this.world!.objects
    if (this.boardOrigin) {
      const states = this.magnetStates
      states.length = 0
      for (const n of o.magnets) {
        let st: MagnetState = 'waiting'
        for (const w of this.world!.workers.values()) {
          if (w.n !== n) continue
          st = w.label === 'quiet' || w.label === 'suspect' || w.label === 'stuck' ? 'stale' : w.inCall ? 'working' : 'waiting'
          break
        }
        states.push(st)
      }
      drawMagnets(ctx, this.boardOrigin[0], this.boardOrigin[1], states)
    }
    if (this.deskOrigin) {
      drawOutStack(ctx, this.deskOrigin[0], this.deskOrigin[1], o.outStack)
      drawInTray(ctx, this.deskOrigin[0], this.deskOrigin[1], o.inTray)
    }
  }

  /** The workers, feet first to last (the painter's order), their icon bubbles, then the newest labels as text. */
  private drawWorkers() {
    const { ctx } = this
    const world = this.world!, now = this.sim
    const order = this.order
    order.length = 0
    for (const w of world.workers.values()) {
      let v = this.views.get(w.key)
      if (!v) { v = newView(); this.views.set(w.key, v) }
      spriteView(w, now, v)
      if (v.visible) order.push({ key: w.key, v, w })
    }
    if (this.views.size > world.workers.size) for (const k of [...this.views.keys()]) if (!world.workers.has(k)) { this.views.delete(k); this.sets.delete(k) }
    order.sort((a, b) => a.v.depth - b.v.depth || a.w.n - b.w.n)
    ctx.imageSmoothingEnabled = false
    for (const e of order) {
      let set = this.sets.get(e.key)
      if (!set) { set = figureSet(lookOf(e.w.seed)); this.sets.set(e.key, set) }
      drawWorker(ctx, e.v, set)
    }
    this.figuresDrawn = order.length
    // bubbles: the newest labels as text (at most 4, never two over each other), an icon for every other worker
    const texts = this.placeTextBubbles(order, now)
    for (const e of order) {
      if (texts.some(b => b.key === e.key)) continue
      const icon = iconOf(e.w)
      if (icon !== null) drawIconBubble(ctx, e.v, icon)
    }
    if (texts.length > 0) this.drawTextBubbles(texts)
  }

  /** The text bubbles to show: the newest label changes first (within TEXT_BUBBLE_MS; never ICON_ONLY labels), at most
   *  MAX_TEXT_BUBBLES, each placed over its worker's head in device pixels and skipped when it would overlap one
   *  already placed (that worker keeps its icon). */
  private placeTextBubbles(order: readonly { key: string; v: SpriteView; w: WorkerState }[], now: number): TextBubble[] {
    const { ctx } = this
    const s = this.scale, k = this.devicePerCss()
    const fpx = Math.round(BUBBLE_FONT_PX * this.fontScale * k)
    ctx.font = `${fpx}px ${LABEL_FONT_FAMILY}`
    const pad = Math.round(4 * k), lh = Math.round(fpx * 1.25), gap = Math.round(3 * k)
    const out: TextBubble[] = []
    const byNew = order.filter(e => now - e.w.labelAt <= TEXT_BUBBLE_MS && !ICON_ONLY.has(e.w.label)).sort((a, b) => b.w.labelAt - a.w.labelAt)
    for (const { key, v, w } of byNew) {
      if (out.length >= MAX_TEXT_BUBBLES) break
      const lines = wrap(`#${w.n} ${bubbleText(w)}`, BUBBLE_WRAP)
      let width = 0
      for (const l of lines) width = Math.max(width, ctx.measureText(l).width)
      const bw = Math.ceil(width) + 2 * pad, bh = lines.length * lh + 2 * pad
      const cx = this.offX + (v.x + 8) * s, top = this.offY + (v.y - 2) * s - bh
      const x = Math.round(Math.min(Math.max(cx - bw / 2, 0), this.bw - bw)), y = Math.round(Math.max(top, 0))
      if (out.some(b => x < b.x + b.w + gap && b.x < x + bw + gap && y < b.y + b.h + gap && b.y < y + bh + gap)) continue
      out.push({ key, alpha: v.alpha, lines, x, y, w: bw, h: bh, pad, lh })
    }
    return out
  }

  /** Text bubbles in device pixels (crisp at any scale). */
  private drawTextBubbles(list: readonly TextBubble[]) {
    const { ctx } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    for (const b of list) {
      ctx.globalAlpha = b.alpha
      ctx.fillStyle = BUBBLE_EDGE
      ctx.fillRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2)
      ctx.fillStyle = BUBBLE_BG_DOM
      ctx.fillRect(b.x, b.y, b.w, b.h)
      ctx.fillStyle = BUBBLE_INK
      b.lines.forEach((l, i) => ctx.fillText(l, b.x + b.pad, b.y + b.pad + i * b.lh))
    }
    ctx.globalAlpha = 1
  }

  /** The debug object: live getters over the engine, built once (reading it costs nothing per frame). */
  private makeDebug(): WorkerOfficeDebug {
    const read: { [K in keyof DebugState]: () => DebugState[K] } = {
      engines: () => engines,
      prerenders: () => prerenderBuilds(),
      active: () => this.active,
      dpr: () => this.dpr,
      deviceScale: () => this.scale,
      zoom: () => this.scale / this.dpr,
      backing: () => [this.bw, this.bh],
      css: () => [this.cssW, this.cssH],
      offset: () => [this.offX, this.offY],
      world: () => [this.worldW, this.worldH],
      insetTop: () => Math.max(0, Math.ceil(this.insetTopCss * this.devicePerCss())),
      fitted: () => this.fitted,
      fontScale: () => this.fontScale,
      draws: () => this.draws,
      labels: () => this.labelTexts,
      workers: () => this.world?.onScreen ?? 0,
      feed: () => this.feed,
      feedSeconds: () => (this.player ? Math.max(0, (this.sim - this.player.base) / 1000) : 0),
      figuresDrawn: () => this.figuresDrawn,
    }
    const dbg = {
      floorTexel: (x: number, y: number) => texel(this.scene.floorLayer, x, y),
      mapTexel: (x: number, y: number) => texel(this.scene.layer, x, y),
    } as WorkerOfficeDebug
    for (const k of Object.keys(read) as (keyof DebugState)[]) Object.defineProperty(dbg, k, { get: read[k], enumerable: true })
    return Object.freeze(dbg)
  }
}

const LABEL_FONT_FAMILY = '"IBM Plex Mono", monospace'
/** The bubble behind the text (the icons' bubble, OfficeEngine.ts drawBubble). */
const BUBBLE_BG_DOM = 'rgba(8,12,24,0.92)'

/** Wrap a phrase at word boundaries to lines of at most `max` characters (a longer word stands alone). */
function wrap(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length > 0 && line.length + 1 + word.length > max) { out.push(line); line = word }
    else line = line.length > 0 ? `${line} ${word}` : word
  }
  if (line.length > 0) out.push(line)
  return out
}
