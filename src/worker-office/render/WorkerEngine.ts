// Canvas host of the worker office (plan §6.1). Step 1 draws the building with ZERO workers; step 4 adds them.
//
// Pixel rules:
//   - the backing store is the canvas's device-pixel content box (ResizeObserver 'device-pixel-content-box'),
//     so canvas pixels are screen pixels;
//   - the scale is an INTEGER number of device pixels per texel and the camera offset is a whole number of device
//     pixels, so zoom × devicePixelRatio is always an integer and every texel is an exact block of pixels (the old
//     engine's fractional fit zoom of ~2.01 blurred and unevened the pixel art, OfficeEngine.ts:211-224);
//   - the fit is camera.ts fitCamera: the largest whole scale that fits, below the DOM overlay when there is room
//     for it (setTopInset).
// Drawing happens only when something changes (nothing animates yet). A resize redraws at once: setting the canvas
// size clears it, and a ResizeObserver callback runs after the frame's animation callbacks and before its paint,
// so a redraw left to the next frame would show a blank map for every step of a sidebar drag or window resize.
// draw() allocates nothing.
// Input: drag to pan; the wheel and a two-finger pinch zoom in whole steps; double-click fits. With keyboard focus
// on the canvas: arrow keys pan, + and - zoom, 0 fits.
// Lifecycle: built once per page; while its tab is hidden it stops drawing and ignores the 0×0 resize, so coming
// back neither rebuilds nor re-fits anything.
// Checks read the engine's `debug` object (live getters, built once). It is also window.__workerOffice, but only in
// dev builds (the visual check runs on the dev server) or with ?woDebug in the address.
import { TILE } from './floors.ts'
import { doorLeaves } from './stateLayer.ts'
import { type LabelPlacement, type OfficeScene, labelFont, placeLabels, prerenderBuilds, texel } from './prerender.ts'
import { WheelZoom, fitCamera } from './camera.ts'

const VOID = '#05070f'          // the app chrome around the building
const MAX_SCALE = 12
/** A two-finger pinch steps the zoom each time the finger distance has grown or shrunk by this factor. */
const PINCH_STEP = 1.25
/** The arrow keys pan by this many tiles. */
const KEY_PAN_TILES = 2
const LABEL_INK = 'rgba(244,238,226,0.82)'
const LABEL_SHADOW = 'rgba(0,0,0,0.65)'

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

  constructor(canvas: HTMLCanvasElement, scene: OfficeScene) {
    engines++
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    this.scene = scene
    this.worldW = scene.map.width * TILE
    this.worldH = scene.map.height * TILE
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

  /** The tab is showing (draw) or hidden (draw nothing; keep the world as it is). */
  setActive(active: boolean) {
    if (this.destroyed) return
    this.active = active
    if (active) this.requestDraw()
    else { cancelAnimationFrame(this.raf); this.raf = 0 }
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
    // state layer: the front door stays shut — it opens only for a real worker within 2 tiles (plan §1.2),
    // and step 1 has none
    const door = scene.map.door
    doorLeaves(ctx, door.x * TILE, door.y * TILE, 0)

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
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.draws++
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
      workers: () => 0,
    }
    const dbg = {
      floorTexel: (x: number, y: number) => texel(this.scene.floorLayer, x, y),
      mapTexel: (x: number, y: number) => texel(this.scene.layer, x, y),
    } as WorkerOfficeDebug
    for (const k of Object.keys(read) as (keyof DebugState)[]) Object.defineProperty(dbg, k, { get: read[k], enumerable: true })
    return Object.freeze(dbg)
  }
}
