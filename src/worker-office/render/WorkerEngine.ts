// Canvas host of the worker office (plan §6.1). Step 1 draws the building with ZERO workers; step 4 adds them.
//
// Pixel rules:
//   - the backing store is the canvas's device-pixel content box (ResizeObserver 'device-pixel-content-box'),
//     so canvas pixels are screen pixels;
//   - the scale is an INTEGER number of device pixels per texel and the camera offset is a whole number of device
//     pixels, so zoom × devicePixelRatio is always an integer and every texel is an exact block of pixels (the old
//     engine's fractional fit zoom of ~2.01 blurred and unevened the pixel art, OfficeEngine.ts:211-224).
// Lifecycle: built once per page; while its tab is hidden it stops drawing and ignores the 0×0 resize, so coming
// back neither rebuilds nor re-fits anything. Nothing animates yet, so it draws only when something changes.
import { TILE, doorLeaves } from './floors'
import { type OfficeScene, LABEL_FONT, prerenderBuilds, texel } from './prerender'

const VOID = '#05070f'          // the app chrome around the building
const FIT_MARGIN = 0.96         // as the old engine's fit (OfficeEngine.ts:215)
const MAX_SCALE = 12

/** Read-only state for automated checks: window.__workerOffice. */
export interface WorkerOfficeDebug {
  engines: number
  prerenders: number
  active: boolean
  dpr: number
  /** device pixels per texel (an integer) */
  deviceScale: number
  /** CSS pixels per texel = deviceScale / dpr */
  zoom: number
  backing: [number, number]
  css: [number, number]
  offset: [number, number]
  world: [number, number]
  draws: number
  labels: string[]
  workers: number
  floorTexel: (x: number, y: number) => string
  mapTexel: (x: number, y: number) => string
}

let engines = 0

export class WorkerEngine {
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
  private scale = 1
  private offX = 0
  private offY = 0
  private active = false
  private raf = 0
  private draws = 0
  private fontScale = 1
  private drag: { id: number; x: number; y: number; offX: number; offY: number } | null = null

  constructor(canvas: HTMLCanvasElement, scene: OfficeScene) {
    engines++
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    this.scene = scene
    this.worldW = scene.map.width * TILE
    this.worldH = scene.map.height * TILE
    this.ro = new ResizeObserver(entries => { const e = entries[entries.length - 1]; if (e) this.onResize(e) })
    try { this.ro.observe(canvas, { box: 'device-pixel-content-box' }) } catch { this.ro.observe(canvas) }
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('dblclick', this.onDblClick)
    void document.fonts?.ready.then(() => this.requestDraw())
    this.publish()
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.ro.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDblClick)
  }

  /** The tab is showing (draw) or hidden (draw nothing; keep the world as it is). */
  setActive(active: boolean) {
    this.active = active
    if (active) this.requestDraw()
    else { cancelAnimationFrame(this.raf); this.raf = 0 }
    this.publish()
  }

  /** Global UI text scale (SettingsContext) for the room labels. */
  setFontScale(s: number) {
    this.fontScale = s
    this.requestDraw()
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
    this.canvas.width = bw
    this.canvas.height = bh
    this.fit()
  }

  /** Largest integer device scale that fits the building (with the old engine's margin), centred. */
  private fit() {
    if (this.bw < 1 || this.bh < 1) return
    this.scale = Math.max(1, Math.floor(Math.min(this.bw / this.worldW, this.bh / this.worldH) * FIT_MARGIN))
    this.offX = Math.round((this.bw - this.worldW * this.scale) / 2)
    this.offY = Math.round((this.bh - this.worldH * this.scale) / 2)
    this.requestDraw()
  }

  /** Keep at least a strip of the building on screen. */
  private clampOffset() {
    const keep = 48
    this.offX = Math.round(Math.min(this.bw - keep, Math.max(keep - this.worldW * this.scale, this.offX)))
    this.offY = Math.round(Math.min(this.bh - keep, Math.max(keep - this.worldH * this.scale, this.offY)))
  }

  private devicePerCss() { return this.cssW > 0 ? this.bw / this.cssW : this.dpr }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    this.canvas.setPointerCapture(e.pointerId)
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, offX: this.offX, offY: this.offY }
  }
  private onPointerMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return
    const k = this.devicePerCss()
    this.offX = this.drag.offX + (e.clientX - this.drag.x) * k
    this.offY = this.drag.offY + (e.clientY - this.drag.y) * k
    this.clampOffset()
    this.requestDraw()
  }
  private onPointerUp = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) this.drag = null
  }
  /** Zoom in whole device pixels per texel, around the cursor. */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const next = Math.min(MAX_SCALE, Math.max(1, this.scale + (e.deltaY < 0 ? 1 : -1)))
    if (next === this.scale) return
    const rect = this.canvas.getBoundingClientRect()
    const k = this.devicePerCss()
    const mx = (e.clientX - rect.left) * k, my = (e.clientY - rect.top) * k
    const wx = (mx - this.offX) / this.scale, wy = (my - this.offY) / this.scale
    this.scale = next
    this.offX = mx - wx * next
    this.offY = my - wy * next
    this.clampOffset()
    this.requestDraw()
  }
  private onDblClick = () => this.fit()

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────
  private requestDraw() {
    if (!this.active || this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.active) this.draw() })
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

    // room labels (placed from the zones by the pre-render); crisp text at the integer scale
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.shadowColor = 'rgba(0,0,0,0.65)'
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = Math.max(1, Math.round(s / 2))
    ctx.shadowBlur = 0
    ctx.fillStyle = 'rgba(244,238,226,0.82)'
    for (const l of scene.labels) {
      ctx.font = `bold ${l.size * this.fontScale}px ${LABEL_FONT}`
      ctx.fillText(l.text, l.x, l.y)
    }
    ctx.shadowColor = 'transparent'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.draws++
    this.publish()
  }

  private publish() {
    const scene = this.scene
    const dbg: WorkerOfficeDebug = {
      engines, prerenders: prerenderBuilds(), active: this.active, dpr: this.dpr, deviceScale: this.scale,
      zoom: this.scale / this.dpr, backing: [this.bw, this.bh], css: [this.cssW, this.cssH],
      offset: [this.offX, this.offY], world: [this.worldW, this.worldH], draws: this.draws,
      labels: scene.labels.map(l => l.text), workers: 0,
      floorTexel: (x, y) => texel(scene.floorLayer, x, y),
      mapTexel: (x, y) => texel(scene.layer, x, y),
    }
    ;(window as unknown as { __workerOffice?: WorkerOfficeDebug }).__workerOffice = dbg
  }
}
