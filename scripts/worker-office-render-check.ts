// Worker office render logic under a RECORDING CANVAS STUB (no browser, no pixels). Run: npx tsx scripts/worker-office-render-check.ts
// This is not a visual check — scripts/worker-office-visual-check.mjs looks at real pixels. It proves that the
// pre-render and the engine run on the real floorplan and do what the plan asks, on every tile:
//   pre-render: layer 1 leaves no texel uncovered (the room finish is under every object tile: two-layer); each
//     placeholder lands on its own transparent layer; wall / furniture / east shadows fall exactly where the kind
//     sets say; daylight comes from all 15 windows — down from the north windows, UP from the facade row y=19;
//     the floor lamp glows; room labels come from the zones (10, none for the street) on plain floor;
//   engine: integer device pixels per texel at DPR 1, 1.25, 1.5, 2 (zoom × DPR integer; 2.0 at 1440×900), whole-pixel
//     offsets, a hidden tab's 0×0 resize ignored, no drawing while hidden, wheel zoom in whole steps around the
//     cursor, pan, double-click fit, labels drawn, the door drawn shut, and the map pre-rendered once.
// Exits 1 on any failure.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadMap, SURFACE_KINDS } from '../src/worker-office/map/loadMap'
import { prerenderOffice, prerenderBuilds } from '../src/worker-office/render/prerender'
import { WorkerEngine, type WorkerOfficeDebug } from '../src/worker-office/render/WorkerEngine'

// ── the recording stub ─────────────────────────────────────────────────────────────────────────────────────────
interface Rect { x: number; y: number; w: number; h: number }
interface Fill extends Rect { style: string }
interface Draw extends Rect { src: StubCanvas }
interface Grad { kind: 'linear' | 'radial'; args: number[]; stops: [number, string][] }
const canvases: StubCanvas[] = []
class StubCtx {
  fillStyle: unknown = '#000000'
  font = '10px sans-serif'
  imageSmoothingEnabled = true
  textBaseline = 'alphabetic'
  textAlign = 'start'
  shadowColor = 'transparent'
  shadowOffsetX = 0
  shadowOffsetY = 0
  shadowBlur = 0
  fills: Fill[] = []
  draws: Draw[] = []
  translates: [number, number][] = []
  grads: Grad[] = []
  texts: { text: string; x: number; y: number; font: string }[] = []
  private m = [1, 0, 0, 1, 0, 0]            // a, b, c, d, e, f (no rotation is ever used)
  private stack: number[][] = []
  readonly canvas: StubCanvas
  constructor(canvas: StubCanvas) { this.canvas = canvas }
  private map(x: number, y: number, w: number, h: number): Rect {
    const [a, , , d, e, f] = this.m
    return { x: e + x * a, y: f + y * d, w: w * a, h: h * d }
  }
  save() { this.stack.push([...this.m]) }
  restore() { this.m = this.stack.pop()! }
  translate(x: number, y: number) { this.m[4] += x * this.m[0]; this.m[5] += y * this.m[3]; this.translates.push([this.m[4], this.m[5]]) }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.m = [a, b, c, d, e, f] }
  fillRect(x: number, y: number, w: number, h: number) { this.fills.push({ ...this.map(x, y, w, h), style: String(this.fillStyle) }) }
  drawImage(src: StubCanvas, ...a: number[]) {
    const [dx, dy, dw, dh] = a.length === 2 ? [a[0], a[1], src.width, src.height] : a.length === 4 ? a : a.slice(4)
    this.draws.push({ ...this.map(dx, dy, dw, dh), src })
  }
  createLinearGradient(...args: number[]) { return this.grad('linear', args) }
  createRadialGradient(...args: number[]) { return this.grad('radial', args) }
  private grad(kind: Grad['kind'], args: number[]) {
    const g: Grad & { addColorStop(o: number, c: string): void } = { kind, args, stops: [], addColorStop(o, c) { this.stops.push([o, c]) } }
    this.grads.push(g)
    return g
  }
  beginPath() { /* recorded through fill() */ }
  arc() { /* the lamp glow: its gradient is what is checked */ }
  fill() { this.fills.push({ x: NaN, y: NaN, w: 0, h: 0, style: 'path' }) }
  measureText(t: string) { return { width: 0.6 * parseFloat(/([\d.]+)px/.exec(this.font)![1]) * t.length } }
  fillText(text: string, x: number, y: number) { this.texts.push({ text, x, y, font: this.font }) }
  getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, 255]) } }
}
class StubCanvas {
  width = 0
  height = 0
  readonly ctx: StubCtx = new StubCtx(this)
  readonly listeners = new Map<string, (e: unknown) => void>()
  cssW = 0
  cssH = 0
  constructor() { canvases.push(this) }
  getContext() { return this.ctx }
  addEventListener(t: string, f: (e: unknown) => void) { this.listeners.set(t, f) }
  removeEventListener(t: string) { this.listeners.delete(t) }
  setPointerCapture() { /* no-op */ }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.cssW, height: this.cssH } }
}
let roCallback: ((entries: unknown[]) => void) | null = null
let rafQueue: (() => void)[] = []
const G = globalThis as unknown as Record<string, unknown>
G.document = { createElement: () => new StubCanvas(), fonts: { ready: Promise.resolve() } }
G.window = globalThis
G.devicePixelRatio = 1
G.ResizeObserver = class { constructor(cb: (e: unknown[]) => void) { roCallback = cb } observe() { /* the test feeds entries */ } disconnect() { roCallback = null } }
G.requestAnimationFrame = (cb: () => void) => { rafQueue.push(cb); return rafQueue.length }
G.cancelAnimationFrame = () => { rafQueue = [] }
const flush = () => { const q = rafQueue; rafQueue = []; for (const cb of q) cb() }

let failures = 0
const ok = (cond: boolean, what: string) => { if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}`) } }

// ── pre-render ──────────────────────────────────────────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../src/worker-office/data/floorplan.json', import.meta.url)), 'utf8'))
const map = loadMap(raw)
const W = map.width, H = map.height, T = map.tileSize
const scene = prerenderOffice(map)
const asStub = (c: unknown) => c as StubCanvas
const floor = asStub(scene.floorLayer), layer = asStub(scene.layer)
const big = canvases.filter(c => c.width === W * T && c.height === H * T)
const objectLayer = big.find(c => c !== floor && c !== layer)!
console.log('pre-render')
ok(big.length === 3 && prerenderBuilds() === 1, `three ${W * T}×${H * T} layers (ground, objects, composite), built once`)

// layer 1 covers every texel with opaque paint: solid #rrggbb fills or finish tiles that are themselves opaque
const solid = (s: string) => /^#[0-9a-f]{6}$/i.test(s)
/** A finish tile is opaque when its own solid fills cover all of its texels (checker paints four 8×8 squares). */
const tileOpaque = (c: StubCanvas) => {
  const own = new Uint8Array(T * T)
  for (const f of c.ctx.fills) {
    if (!solid(f.style)) continue
    for (let y = Math.max(0, f.y); y < Math.min(T, f.y + f.h); y++) for (let x = Math.max(0, f.x); x < Math.min(T, f.x + f.w); x++) own[y * T + x] = 1
  }
  return own.every(v => v === 1)
}
const cover = new Uint8Array(W * T * H * T)
const mark = (r: Rect) => {
  for (let y = Math.max(0, r.y); y < Math.min(H * T, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(W * T, r.x + r.w); x++) cover[y * W * T + x] = 1
}
for (const f of floor.ctx.fills) if (solid(f.style)) mark(f)
let opaqueTiles = 0, tileDraws = 0
for (const d of floor.ctx.draws) { tileDraws++; if (tileOpaque(d.src)) { opaqueTiles++; mark(d) } }
const holes = cover.length - cover.reduce((s, v) => s + v, 0)
ok(holes === 0, `ground layer: no uncovered texel (${cover.length} texels; ${tileDraws} finish-tile draws, all opaque: ${opaqueTiles === tileDraws})`)
const objTiles = map.objects.filter(o => !SURFACE_KINDS.has(o.kind))
const objTileCount = objTiles.reduce((s, o) => s + o.w * o.h, 0)
let underObjects = 0
for (const o of objTiles) for (let i = 0; i < o.w; i++) {
  const x = (o.x + i) * T, y = o.y * T
  let all = true
  for (let yy = y; yy < y + T && all; yy++) for (let xx = x; xx < x + T; xx++) if (!cover[yy * W * T + xx]) { all = false; break }
  if (all) underObjects++
}
ok(underObjects === objTileCount, `finish/wall painted under all ${objTileCount} furniture tiles on the ground layer (two-layer pre-render)`)
ok(objectLayer.ctx.translates.length === objTileCount, `object layer: ${objectLayer.ctx.translates.length} placeholder tiles = ${objTileCount} furniture tiles (door, doormat, planters, street are ground)`)
ok(objectLayer.ctx.draws.length === 0, 'object layer draws no floor (transparent around each placeholder)')

// shadows: recomputed here from the rows alone
const WALLISH_CHARS = new Set(['#', '~', ...map.objects.filter(o => o.wallMounted).map(o => o.char)])
const ch = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? raw.rows[y][x] as string : '')
const receives = (x: number, y: number) => ch(x, y) !== '' && !WALLISH_CHARS.has(ch(x, y)) && ch(x, y) !== 'D'
const surfaceChars = new Set(map.objects.filter(o => SURFACE_KINDS.has(o.kind)).map(o => o.char))
const furniture = (x: number, y: number) => { const c = ch(x, y); return c !== '' && !'#~+:.,qu*'.includes(c) && !WALLISH_CHARS.has(c) && !surfaceChars.has(c) }
let expWall = 0, expContact = 0, expEast = 0
for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) {
  if (!receives(x, y + 1)) continue
  if (WALLISH_CHARS.has(ch(x, y))) expWall++
  else if (furniture(x, y)) expContact++
}
for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) if (WALLISH_CHARS.has(ch(x, y)) && receives(x + 1, y)) expEast++
const count = (style: string) => floor.ctx.fills.filter(f => f.style === style).length
ok(count('rgba(20,12,4,0.30)') === expWall && count('rgba(20,12,4,0.14)') === expWall, `wall drop shadows: ${count('rgba(20,12,4,0.30)')} (expected ${expWall}, walls + windows + wall-mounted kinds)`)
ok(count('rgba(20,12,4,0.18)') === expContact, `furniture contact shadows: ${count('rgba(20,12,4,0.18)')} (expected ${expContact})`)
ok(count('rgba(20,12,4,0.16)') === expEast, `east wall shadows: ${count('rgba(20,12,4,0.16)')} (expected ${expEast})`)
ok(!floor.ctx.fills.some(f => f.style.startsWith('rgba(20,12,4') && f.y >= 19 * T && f.y < 20 * T && f.x >= 16 * T && f.x < 18 * T),
  'no shadow on the door leaves')

// daylight: every window, away from the wall, toward the inside
const windows: [number, number][] = []
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ch(x, y) === '~') windows.push([x, y])
const lin = layer.ctx.grads.filter(g => g.kind === 'linear')
const down = lin.filter(g => g.args[3] > g.args[1]), up = lin.filter(g => g.args[3] < g.args[1])
const northWin = windows.filter(w => w[1] < map.facadeRow), facadeWin = windows.filter(w => w[1] === map.facadeRow)
ok(windows.length === 15 && lin.length === 15, `daylight pools: ${lin.length} for ${windows.length} windows`)
ok(down.length === northWin.length && down.every(g => g.args[1] === T && g.args[3] === T + 40),
  `${down.length} north-window pools fall south into the rooms (y ${T} -> ${T + 40})`)
ok(up.length === facadeWin.length && up.length === 9 && up.every(g => g.args[1] === map.facadeRow * T && g.args[3] === map.facadeRow * T - 40),
  `${up.length} facade pools (row y=${map.facadeRow}) fall NORTH into the rooms (y ${map.facadeRow * T} -> ${map.facadeRow * T - 40})`)
const lamp = map.objects.find(o => o.kind === 'floorLamp')!
const radial = layer.ctx.grads.filter(g => g.kind === 'radial')
ok(radial.length === 1 && radial[0].args[0] === lamp.x * T + 8 && radial[0].args[1] === lamp.y * T + 4, `floor lamp glow at (${lamp.x},${lamp.y})`)

// labels from the zones
const labels = scene.labels.map(l => `${l.text}@${(l.x - 3) / T},${(l.y - 8) / T}`)
ok(JSON.stringify(labels) === JSON.stringify(['LIBRARY@1,3', 'RECORDS@10,3', 'WORK ROOM@25,3', 'MEETING@4,14', 'BREAK ROOM@7,16',
  'RECEPTION@14,14', 'SERVERS@29,14', 'MAIL / PRINT CORNER@21,16', 'CORRIDOR@1,11', 'SIDEWALK@1,20']),
  `room labels (zone order, on plain floor, no STREET): ${labels.join(' ')}`)
for (const l of scene.labels) {
  const tx = (l.x - 3) / T, ty = (l.y - 8) / T
  const z = map.zones.find(q => q.name === l.text)!
  ok(map.zoneAt(tx, ty) === z && ['floor', 'corridor', 'placeTile', 'sidewalk', 'arrivalSlot'].includes(map.tiles[ty][tx]), `label ${l.text} sits on its own zone's plain floor (${tx},${ty})`)
}

// ── engine ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('engine')
const dbg = () => (globalThis as unknown as { __workerOffice: WorkerOfficeDebug }).__workerOffice
const canvas = new StubCanvas()
const engine = new WorkerEngine(canvas as unknown as HTMLCanvasElement, scene)
engine.setActive(true)
const resize = (cssW: number, cssH: number, dpr: number) => {
  G.devicePixelRatio = dpr
  canvas.cssW = cssW; canvas.cssH = cssH
  roCallback!([{ contentRect: { width: cssW, height: cssH }, devicePixelContentBoxSize: [{ inlineSize: Math.round(cssW * dpr), blockSize: Math.round(cssH * dpr) }] }])
  flush()
}
const fitCases: [number, number, number, number][] = [
  // css w, css h, dpr, expected device px per texel
  [1134, 864, 1, 2],        // 1440×900 with the 300 px sidebar (+6 px gutter): plan §6.1's "2.01 -> 2.0"
  [1440, 864, 1, 2],        // 1440×900 without the sidebar: 2.25 -> 2
  [1134, 864, 1.25, 2],     // a 125 % Windows display: zoom 1.6 CSS px, 2 device px per texel
  [1401, 1031, 1.5, 3],     // the owner's 1707×1067 CSS at 150 % (with the sidebar): zoom 2.0
  [1134, 864, 2, 4],
  [300, 200, 1, 1],         // tiny panel: never below 1 device pixel per texel
]
for (const [w, h, dpr, want] of fitCases) {
  resize(w, h, dpr)
  const d = dbg()
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr)
  ok(d.deviceScale === want && Number.isInteger(d.zoom * dpr) && Number.isInteger(d.offset[0]) && Number.isInteger(d.offset[1])
    && canvas.width === bw && canvas.height === bh
    && d.offset[0] === Math.round((bw - W * T * want) / 2) && d.offset[1] === Math.round((bh - H * T * want) / 2),
  `fit ${w}×${h} @ DPR ${dpr}: ${d.deviceScale} device px/texel, zoom ${d.zoom}, zoom×DPR ${d.zoom * dpr}, backing ${canvas.width}×${canvas.height}, offset ${d.offset}`)
}
resize(1134, 864, 1)
const lastDraw = canvas.ctx.draws.at(-1)!
ok(lastDraw.src === layer && lastDraw.x === 23 && lastDraw.y === 64 && lastDraw.w === W * T * 2 && lastDraw.h === H * T * 2,
  `map drawn at integer scale: ${lastDraw.w}×${lastDraw.h} at (${lastDraw.x},${lastDraw.y})`)
const texts = canvas.ctx.texts.slice(-10)
ok(texts.length === 10 && texts.every(t => /^bold [45]px /.test(t.font)), `10 room labels drawn as text (${texts.map(t => t.text).join(', ')})`)
const doorFills = canvas.ctx.fills.filter(f => f.style === 'rgba(170,214,222,0.42)').slice(-2)
ok(doorFills.length === 2 && doorFills[0].w === 15 * 2 && doorFills[1].w === 15 * 2 && doorFills[0].x === 23 + (16 * T + 1) * 2 && doorFills[1].x === 23 + 17 * T * 2,
  'both door leaves drawn shut (zero workers near the door)')

// hidden tab (display:none): drawing stops, the 0×0 resize is ignored, and coming back keeps the camera
const before = dbg()
engine.setActive(false)
roCallback!([{ contentRect: { width: 0, height: 0 }, devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: 0 }] }])
engine.setFontScale(1.2)                    // anything that wants a redraw
ok(rafQueue.length === 0 && dbg().active === false, 'no frame is scheduled while the tab is hidden')
ok(canvas.width === 1134 && canvas.height === 864 && dbg().deviceScale === before.deviceScale && dbg().offset.join() === before.offset.join(),
  `the 0×0 resize of a hidden tab is ignored (backing still ${canvas.width}×${canvas.height}, camera unchanged)`)
engine.setActive(true); flush()
const shown = dbg()
ok(shown.draws > before.draws && shown.deviceScale === before.deviceScale && shown.offset.join() === before.offset.join(),
  `shown again: redrawn (draws ${before.draws} -> ${shown.draws}) with the same camera`)
engine.setFontScale(1); flush()
const wheel = canvas.listeners.get('wheel')!
wheel({ deltaY: -100, clientX: 400, clientY: 300, preventDefault() { /* stub */ } }); flush()
canvas.listeners.get('dblclick')!({}); flush()
ok(dbg().deviceScale === before.deviceScale && dbg().offset.join() === before.offset.join(), 'double-click fits again after a zoom')

// wheel zoom: whole steps, the texel under the cursor stays put
const pre = dbg()
const cx = 400, cy = 300                     // CSS px = device px at DPR 1
const wx = (cx - pre.offset[0]) / pre.deviceScale, wy = (cy - pre.offset[1]) / pre.deviceScale
wheel({ deltaY: -100, clientX: cx, clientY: cy, preventDefault() { /* stub */ } }); flush()
const z = dbg()
ok(z.deviceScale === pre.deviceScale + 1 && Number.isInteger(z.offset[0]) && Number.isInteger(z.offset[1])
  && Math.abs(z.offset[0] + wx * z.deviceScale - cx) <= 0.5 && Math.abs(z.offset[1] + wy * z.deviceScale - cy) <= 0.5,
  `wheel: ${pre.deviceScale} -> ${z.deviceScale} device px/texel, cursor texel kept, offset ${z.offset}`)
// pan
canvas.listeners.get('pointerdown')!({ button: 0, pointerId: 1, clientX: 100, clientY: 100 })
canvas.listeners.get('pointermove')!({ pointerId: 1, clientX: 137.3, clientY: 80.2 }); flush()
canvas.listeners.get('pointerup')!({ pointerId: 1 })
const p = dbg()
ok(p.offset[0] === Math.round(z.offset[0] + 37.3) && p.offset[1] === Math.round(z.offset[1] - 19.8), `pan by (37.3, -19.8) CSS px -> whole-pixel offset ${p.offset}`)
ok(p.engines === 1 && p.prerenders === 1 && p.workers === 0, `one engine, pre-rendered once, zero workers (engines ${p.engines}, prerenders ${p.prerenders})`)
engine.destroy()
ok(canvas.listeners.size === 0 && roCallback === null, 'destroy() removes every listener and the observer')

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS (recording canvas stub; the pixels themselves are checked by the visual check)')
