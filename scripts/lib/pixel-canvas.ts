// A small SOFTWARE canvas for the worker-office checks: real pixels in Node, no browser.
//
// It implements the part of CanvasRenderingContext2D that the worker-office renderers use — fillRect, clearRect,
// drawImage (2, 4 and 8 arguments), getImageData, save/restore, translate, scale, setTransform (axis-aligned only),
// globalAlpha, fillStyle as a CSS colour or a gradient, and rect/arc paths for fill() and clip() — with straight
// (non-premultiplied) RGBA and source-over blending. A pixel is painted when its centre lies inside the shape, which
// is exactly what a browser does for whole-pixel rects; for anything else it is an approximation (gradients and arcs
// may differ from Chrome by a level or a pixel at the edge), so checks that need exact browser pixels belong in the
// browser visual check.
//
// STRICT mode (pixelCanvas(w, h, { strict: true }), or setStrict(true) for every canvas made afterwards) is the
// pixel-art discipline: it throws on anything that is not a whole-texel rect in a solid colour — a fractional
// coordinate, a gradient, a path, a clip, text, a scale other than ±1. The furniture, state, prop and icon art must
// draw under it.
//
// writePng() saves a canvas (optionally scaled up by an integer factor) for a human to look at.
import { deflateSync, crc32 } from 'node:zlib'
import { writeFileSync } from 'node:fs'

type RGBA = [number, number, number, number]   // 0..255 each, alpha too
interface Stop { at: number; c: RGBA }
interface Gradient {
  readonly kind: 'linear' | 'radial'
  readonly args: readonly number[]
  readonly stops: Stop[]
  addColorStop(at: number, color: string): void
}
interface Shape { kind: 'rect' | 'arc'; x: number; y: number; w: number; h: number; r: number }

const NAMED: Record<string, RGBA> = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 255], white: [255, 255, 255, 255] }

export function parseColor(s: string): RGBA {
  const t = s.trim().toLowerCase()
  if (NAMED[t]) return [...NAMED[t]] as RGBA
  let m = /^#([0-9a-f]{6})$/.exec(t)
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255] }
  m = /^#([0-9a-f]{3})$/.exec(t)
  if (m) { const [r, g, b] = m[1].split('').map(c => parseInt(c + c, 16)); return [r, g, b, 255] }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t)
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 255 : Math.round(+m[4] * 255)]
  throw new Error(`pixel-canvas: unsupported colour ${JSON.stringify(s)}`)
}

let strictDefault = false
/** Make every canvas created from now on strict (or not). */
export function setStrict(on: boolean) { strictDefault = on }

export class PixelCanvas {
  private w = 0
  private h = 0
  data: Uint8ClampedArray = new Uint8ClampedArray(0)
  readonly strict: boolean
  private ctx: PixelCtx | null = null
  constructor(w = 300, h = 150, strict = strictDefault) {
    this.strict = strict
    this.width = w
    this.height = h
  }
  get width() { return this.w }
  set width(v: number) { this.w = Math.max(0, Math.floor(v)); this.data = new Uint8ClampedArray(this.w * this.h * 4) }
  get height() { return this.h }
  set height(v: number) { this.h = Math.max(0, Math.floor(v)); this.data = new Uint8ClampedArray(this.w * this.h * 4) }
  getContext(type: string): PixelCtx {
    if (type !== '2d') throw new Error(`pixel-canvas: no ${type} context`)
    this.ctx ??= new PixelCtx(this)
    return this.ctx
  }
  /** RGBA of one pixel. */
  at(x: number, y: number): RGBA {
    const i = (y * this.w + x) * 4
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]]
  }
}

interface State { m: number[]; fill: string | Gradient; alpha: number; clip: Uint8Array | null }

export class PixelCtx {
  readonly canvas: PixelCanvas
  fillStyle: string | Gradient = '#000000'
  strokeStyle = '#000000'
  globalAlpha = 1
  imageSmoothingEnabled = true
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'
  lineWidth = 1
  shadowColor = 'transparent'
  shadowOffsetX = 0
  shadowOffsetY = 0
  shadowBlur = 0
  private m = [1, 0, 0, 1, 0, 0]              // a b c d e f; b = c = 0 always
  private clipMask: Uint8Array | null = null  // 1 = paintable
  private path: Shape[] = []
  private stack: State[] = []
  constructor(canvas: PixelCanvas) { this.canvas = canvas }

  private strictFail(what: string): never { throw new Error(`pixel-canvas STRICT: ${what}`) }

  // ── state and transform ───────────────────────────────────────────────────────────────────────────────────────
  save() { this.stack.push({ m: [...this.m], fill: this.fillStyle, alpha: this.globalAlpha, clip: this.clipMask }) }
  restore() {
    const s = this.stack.pop()
    if (!s) return
    this.m = s.m; this.fillStyle = s.fill; this.globalAlpha = s.alpha; this.clipMask = s.clip
  }
  translate(x: number, y: number) {
    if (this.canvas.strict && (!Number.isInteger(x) || !Number.isInteger(y))) this.strictFail(`translate(${x}, ${y})`)
    this.m[4] += x * this.m[0]; this.m[5] += y * this.m[3]
  }
  scale(sx: number, sy: number) {
    if (this.canvas.strict && (Math.abs(sx) !== 1 || Math.abs(sy) !== 1)) this.strictFail(`scale(${sx}, ${sy})`)
    this.m[0] *= sx; this.m[3] *= sy
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    if (b !== 0 || c !== 0) throw new Error('pixel-canvas: rotation/skew is not supported')
    if (this.canvas.strict && (Math.abs(a) !== 1 || Math.abs(d) !== 1 || !Number.isInteger(e) || !Number.isInteger(f))) this.strictFail('setTransform')
    this.m = [a, 0, 0, d, e, f]
  }
  getTransform() { const [a, b, c, d, e, f] = this.m; return { a, b, c, d, e, f } }
  resetTransform() { this.m = [1, 0, 0, 1, 0, 0] }

  /** user rect -> device rect (normalised for negative scale) */
  private dev(x: number, y: number, w: number, h: number) {
    const [a, , , d, e, f] = this.m
    let x0 = e + x * a, x1 = e + (x + w) * a, y0 = f + y * d, y1 = f + (y + h) * d
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (y1 < y0) [y0, y1] = [y1, y0]
    return { x0, y0, x1, y1 }
  }

  // ── colour ─────────────────────────────────────────────────────────────────────────────────────────────────────
  private paintAt(i: number, c: RGBA) {
    const D = this.canvas.data
    const sa = (c[3] / 255) * this.globalAlpha
    if (sa <= 0) return
    const da = D[i + 3] / 255
    const oa = sa + da * (1 - sa)
    for (let k = 0; k < 3; k++) D[i + k] = Math.round((c[k] * sa + D[i + k] * da * (1 - sa)) / oa)
    D[i + 3] = Math.round(oa * 255)
  }
  private colourAt(style: string | Gradient, px: number, py: number): RGBA {
    if (typeof style === 'string') return parseColor(style)
    const g = style
    let t: number
    if (g.kind === 'linear') {
      const [x0, y0, x1, y1] = g.args
      const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy
      t = L === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / L
    } else {
      const [x0, y0, r0, , , r1] = g.args
      t = r1 === r0 ? 0 : (Math.hypot(px - x0, py - y0) - r0) / (r1 - r0)
    }
    t = Math.max(0, Math.min(1, t))
    const s = [...g.stops].sort((p, q) => p.at - q.at)
    if (s.length === 0) return [0, 0, 0, 0]
    if (t <= s[0].at) return s[0].c
    for (let k = 1; k < s.length; k++) {
      if (t <= s[k].at) {
        const u = (t - s[k - 1].at) / (s[k].at - s[k - 1].at || 1)
        return s[k - 1].c.map((v, j) => v + (s[k].c[j] - v) * u) as RGBA
      }
    }
    return s[s.length - 1].c
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient {
    if (this.canvas.strict) this.strictFail('gradient')
    return this.gradient('linear', [x0, y0, x1, y1])
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient {
    if (this.canvas.strict) this.strictFail('gradient')
    return this.gradient('radial', [x0, y0, r0, x1, y1, r1])
  }
  private gradient(kind: Gradient['kind'], args: number[]): Gradient {
    const stops: Stop[] = []
    return { kind, args, stops, addColorStop(at: number, color: string) { stops.push({ at, c: parseColor(color) }) } }
  }

  // ── rects ──────────────────────────────────────────────────────────────────────────────────────────────────────
  fillRect(x: number, y: number, w: number, h: number) {
    if (this.canvas.strict) {
      if (typeof this.fillStyle !== 'string') this.strictFail('gradient fill')
      const r = this.dev(x, y, w, h)
      if (![r.x0, r.y0, r.x1, r.y1].every(Number.isInteger)) this.strictFail(`fillRect(${x}, ${y}, ${w}, ${h}) is not whole texels`)
    }
    if (!(w > 0 && h > 0)) return
    const { x0, y0, x1, y1 } = this.dev(x, y, w, h)
    const W = this.canvas.width, H = this.canvas.height
    const style = this.fillStyle
    const solid = typeof style === 'string' ? parseColor(style) : null
    for (let py = Math.max(0, Math.ceil(y0 - 0.5)); py < Math.min(H, Math.ceil(y1 - 0.5)); py++) {
      for (let px = Math.max(0, Math.ceil(x0 - 0.5)); px < Math.min(W, Math.ceil(x1 - 0.5)); px++) {
        if (this.clipMask && !this.clipMask[py * W + px]) continue
        this.paintAt((py * W + px) * 4, solid ?? this.colourAt(style, px + 0.5, py + 0.5))
      }
    }
  }
  clearRect(x: number, y: number, w: number, h: number) {
    const { x0, y0, x1, y1 } = this.dev(x, y, w, h)
    const W = this.canvas.width, H = this.canvas.height, D = this.canvas.data
    for (let py = Math.max(0, Math.ceil(y0 - 0.5)); py < Math.min(H, Math.ceil(y1 - 0.5)); py++) {
      for (let px = Math.max(0, Math.ceil(x0 - 0.5)); px < Math.min(W, Math.ceil(x1 - 0.5)); px++) {
        if (this.clipMask && !this.clipMask[py * W + px]) continue
        D.fill(0, (py * W + px) * 4, (py * W + px) * 4 + 4)
      }
    }
  }

  // ── images ─────────────────────────────────────────────────────────────────────────────────────────────────────
  drawImage(src: PixelCanvas, ...a: number[]) {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, src.width, src.height, a[0], a[1], src.width, src.height]
      : a.length === 4 ? [0, 0, src.width, src.height, a[0], a[1], a[2], a[3]] : a
    if (!(src instanceof PixelCanvas)) throw new Error('pixel-canvas: drawImage source is not a PixelCanvas')
    const r = this.dev(dx, dy, dw, dh)
    if (this.canvas.strict && ![r.x0, r.y0, r.x1, r.y1, sx, sy, sw, sh].every(Number.isInteger)) this.strictFail('drawImage at a fractional position')
    const W = this.canvas.width, H = this.canvas.height
    const flipX = this.m[0] < 0, flipY = this.m[3] < 0
    for (let py = Math.max(0, Math.ceil(r.y0 - 0.5)); py < Math.min(H, Math.ceil(r.y1 - 0.5)); py++) {
      for (let px = Math.max(0, Math.ceil(r.x0 - 0.5)); px < Math.min(W, Math.ceil(r.x1 - 0.5)); px++) {
        if (this.clipMask && !this.clipMask[py * W + px]) continue
        let u = (px + 0.5 - r.x0) / (r.x1 - r.x0), v = (py + 0.5 - r.y0) / (r.y1 - r.y0)
        if (flipX) u = 1 - u
        if (flipY) v = 1 - v
        const qx = Math.floor(sx + u * sw), qy = Math.floor(sy + v * sh)
        if (qx < 0 || qy < 0 || qx >= src.width || qy >= src.height) continue
        const c = src.at(qx, qy)
        if (c[3] > 0) this.paintAt((py * W + px) * 4, c)
      }
    }
  }
  getImageData(x: number, y: number, w: number, h: number) {
    const out = new Uint8ClampedArray(w * h * 4)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const X = x + i, Y = y + j
      if (X < 0 || Y < 0 || X >= this.canvas.width || Y >= this.canvas.height) continue
      out.set(this.canvas.at(X, Y), (j * w + i) * 4)
    }
    return { width: w, height: h, data: out }
  }

  // ── paths (light pools in the pre-render; never in strict art) ─────────────────────────────────────────────────
  beginPath() { if (this.canvas.strict) this.strictFail('path'); this.path = [] }
  rect(x: number, y: number, w: number, h: number) {
    const r = this.dev(x, y, w, h)
    this.path.push({ kind: 'rect', x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0, r: 0 })
  }
  arc(cx: number, cy: number, r: number) {
    const c = this.dev(cx, cy, 0, 0)
    this.path.push({ kind: 'arc', x: c.x0, y: c.y0, w: 0, h: 0, r: r * Math.abs(this.m[0]) })
  }
  private inPath(px: number, py: number) {
    return this.path.some(s => s.kind === 'rect'
      ? px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h
      : (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r * s.r)
  }
  fill() {
    if (this.canvas.strict) this.strictFail('path fill')
    const W = this.canvas.width, H = this.canvas.height
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      if (this.clipMask && !this.clipMask[py * W + px]) continue
      if (this.inPath(px + 0.5, py + 0.5)) this.paintAt((py * W + px) * 4, this.colourAt(this.fillStyle, px + 0.5, py + 0.5))
    }
  }
  clip() {
    if (this.canvas.strict) this.strictFail('clip')
    const W = this.canvas.width, H = this.canvas.height
    const mask = new Uint8Array(W * H)
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const prev = this.clipMask ? this.clipMask[py * W + px] : 1
      mask[py * W + px] = prev && this.inPath(px + 0.5, py + 0.5) ? 1 : 0
    }
    this.clipMask = mask
  }

  // ── text (measured by the label placement; never drawn by the pre-render) ──────────────────────────────────────
  measureText(t: string) {
    if (this.canvas.strict) this.strictFail('text')
    const size = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] ?? '10')
    return { width: 0.6 * size * t.length }   // a 0.6 em monospace, as IBM Plex Mono (same as the render check's stub)
  }
  fillText() { if (this.canvas.strict) this.strictFail('text') }
}

export function pixelCanvas(w: number, h: number, opts: { strict?: boolean } = {}): [PixelCanvas, PixelCtx] {
  const c = new PixelCanvas(w, h, opts.strict ?? strictDefault)
  return [c, c.getContext('2d')]
}

/** Install a `document` whose createElement('canvas') makes PixelCanvases (the renderers call it via makeCanvas). */
export function installPixelDom(): PixelCanvas[] {
  const made: PixelCanvas[] = []
  const G = globalThis as unknown as Record<string, unknown>
  G.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`pixel-canvas: document.createElement(${tag})`)
      const c = new PixelCanvas(300, 150)
      made.push(c)
      return c
    },
    fonts: { ready: Promise.resolve() },
  }
  return made
}

/** Save a canvas as a PNG, each pixel scaled up to a k×k block. */
export function writePng(file: string, c: PixelCanvas, k = 1) {
  const w = c.width * k, h = c.height * k
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const p = c.at(Math.floor(x / k), Math.floor(y / k))
      raw.set(p, y * (w * 4 + 1) + 1 + x * 4)
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}
