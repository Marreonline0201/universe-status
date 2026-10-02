// Worker office render logic under a RECORDING CANVAS STUB (no browser, no pixels). Run: node scripts/worker-office-render-check.ts
// This is not a visual check — scripts/worker-office-visual-check.mjs looks at real pixels. On the real floorplan it
// proves that the pre-render and the engine do what plan §6.1 and the step-1 reviews ask:
//   pre-render, TILE BY TILE: every ground tile is drawn as floorplan.json + plan §1.2 say — the floor finish of the
//     most specific zone (the plan's finish names are mapped to the art HERE, not through floors.ts's table), in that
//     zone's base colour and the tile's position variant; each doorway half from the zone on its own side; wall faces
//     and tops, inside and facade windows, the door base, planters, the doormat. No texel is left uncovered; on a
//     transparent object layer every slice furniture tile is ONE blit of its kind's cached tile (one canvas per kind)
//     and every pass-2 tile its placeholder, and nothing else is painted there; shadows fall exactly where the kind
//     sets say (the chairs cast none); daylight comes from every RUN of windows (north and facade) and the lamp
//     glows, each pool clipped to its own room, no two pools overlapping; room labels come from the zones;
//   engine: the fit is the largest whole number of device px per texel that fits (sidebar 220–560 px swept at
//     1440×900 and on the owner's 1707×1067 @150 %; the viewport-height boundary; DPR 1, 1.25, 1.5, 2), placed below
//     the overlay band without ever lowering the scale; whole-pixel offsets; a resize repaints inside the
//     ResizeObserver callback; a hidden tab draws nothing; the wheel zooms in whole steps (none on a horizontal
//     swipe, no runaway on touchpad deltas); two-finger pinch; keyboard pan, zoom and fit; labels re-placed for every
//     UI text scale up to FONT_MAX without crossing a wall, a doorway or furniture; the debug object is built once
//     and exposed only in dev builds or with ?woDebug; destroy(); with the EXAMPLE feed: one sim clock (50 ms cap per
//     frame), figures blitted as exact texel blocks, a hidden tab stands still and goes on when shown, the feed ends by
//     itself, stopFeed() empties the building;
//   the tab's DOM colours: every text colour meets WCAG AA (4.5:1) on its background in the worst case, and
//     WorkerOffice.tsx takes all its colours from workerOfficeTheme.ts.
// Every assertion prints its own line, so running this against older code lists what is missing instead of
// crashing. Exits 1 on any failure.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadMap, SURFACE_KINDS } from '../src/worker-office/map/loadMap.ts'
import * as pre from '../src/worker-office/render/prerender.ts'
import { drawFinish, variantOf, type FinishId } from '../src/worker-office/render/floors.ts'
import { hasFurnitureArt } from '../src/worker-office/render/furniture.ts'
import { WorkerEngine, type WorkerOfficeDebug } from '../src/worker-office/render/WorkerEngine.ts'
import { buildPlaceLayout } from '../src/worker-office/map/places.ts'
import { STATE_ART, stateFrames } from '../src/worker-office/render/stateLayer.ts'
import type { ObjectTileKind } from '../src/worker-office/map/loadMap.ts'

const file = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

// ── the recording stub ─────────────────────────────────────────────────────────────────────────────────────────
interface Rect { x: number; y: number; w: number; h: number }
interface Grad { kind: 'linear' | 'radial'; args: number[]; stops: [number, string][] }
interface Fill extends Rect { style: string; grad: Grad | null; clip: Rect | null; seq: number }
interface Draw extends Rect { src: StubCanvas; sx: number; sy: number; sw: number; sh: number; seq: number }
interface Text { text: string; x: number; y: number; font: string; seq: number }
let seq = 0                                  // one clock over every canvas: paints, size resets
const canvases: StubCanvas[] = []
const isGrad = (v: unknown): v is Grad => typeof v === 'object' && v !== null && 'stops' in v
const intersect = (a: Rect, b: Rect | null): Rect => {
  if (!b) return a
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}
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
  texts: Text[] = []
  private m = [1, 0, 0, 1, 0, 0]            // a, b, c, d, e, f (no rotation is ever used)
  private clipRect: Rect | null = null
  private path: Rect | null = null
  private stack: { m: number[]; clip: Rect | null }[] = []
  readonly canvas: StubCanvas
  constructor(canvas: StubCanvas) { this.canvas = canvas }
  private map(x: number, y: number, w: number, h: number): Rect {
    const [a, , , d, e, f] = this.m
    return { x: e + x * a, y: f + y * d, w: w * a, h: h * d }
  }
  save() { this.stack.push({ m: [...this.m], clip: this.clipRect }) }
  restore() { const s = this.stack.pop()!; this.m = s.m; this.clipRect = s.clip }
  translate(x: number, y: number) { this.m[4] += x * this.m[0]; this.m[5] += y * this.m[3]; this.translates.push([this.m[4], this.m[5]]) }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.m = [a, b, c, d, e, f] }
  fillRect(x: number, y: number, w: number, h: number) {
    this.fills.push({ ...this.map(x, y, w, h), style: String(this.fillStyle), grad: isGrad(this.fillStyle) ? this.fillStyle : null, clip: this.clipRect, seq: ++seq })
  }
  drawImage(src: StubCanvas, ...a: number[]) {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, src.width, src.height, a[0], a[1], src.width, src.height]
      : a.length === 4 ? [0, 0, src.width, src.height, ...a] : a
    this.draws.push({ ...this.map(dx, dy, dw, dh), src, sx, sy, sw, sh, seq: ++seq })
  }
  createLinearGradient(...args: number[]) { return this.grad('linear', args) }
  createRadialGradient(...args: number[]) { return this.grad('radial', args) }
  private grad(kind: Grad['kind'], args: number[]) {
    const g: Grad & { addColorStop(o: number, c: string): void } = { kind, args, stops: [], addColorStop(o, c) { this.stops.push([o, c]) } }
    this.grads.push(g)
    return g
  }
  beginPath() { this.path = null }
  rect(x: number, y: number, w: number, h: number) { this.path = this.map(x, y, w, h) }
  arc(cx: number, cy: number, r: number) { this.path = this.map(cx - r, cy - r, 2 * r, 2 * r) }   // its bounding box
  clip() { this.clipRect = intersect(this.path ?? { x: 0, y: 0, w: 0, h: 0 }, this.clipRect) }
  fill() {
    const p = this.path ?? { x: NaN, y: NaN, w: 0, h: 0 }
    this.fills.push({ ...p, style: 'path', grad: isGrad(this.fillStyle) ? this.fillStyle : null, clip: this.clipRect, seq: ++seq })
  }
  measureText(t: string) { return { width: 0.6 * parseFloat(/([\d.]+)px/.exec(this.font)![1]) * t.length } }   // a 0.6 em monospace, as IBM Plex Mono
  fillText(text: string, x: number, y: number) { this.texts.push({ text, x, y, font: this.font, seq: ++seq }) }
  getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, 255]) } }
}
class StubCanvas {
  private w = 0
  private h = 0
  /** setting width or height resets (clears) a canvas's bitmap */
  resets = 0
  lastReset = 0
  get width() { return this.w }
  set width(v: number) { this.w = v; this.resets++; this.lastReset = ++seq }
  get height() { return this.h }
  set height(v: number) { this.h = v; this.resets++; this.lastReset = ++seq }
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
const roByCanvas = new Map<unknown, (entries: unknown[]) => void>()
let rafNext = 1
let rafQueue = new Map<number, () => void>()
const G = globalThis as unknown as Record<string, unknown>
G.document = { createElement: () => new StubCanvas(), fonts: { ready: Promise.resolve() } }
G.window = globalThis
G.devicePixelRatio = 1
G.ResizeObserver = class {
  private readonly cb: (e: unknown[]) => void
  private targets: unknown[] = []
  constructor(cb: (e: unknown[]) => void) { this.cb = cb }
  observe(t: unknown) { this.targets.push(t); roByCanvas.set(t, this.cb) }
  disconnect() { for (const t of this.targets) roByCanvas.delete(t); this.targets = [] }
}
G.requestAnimationFrame = (cb: () => void) => { const id = rafNext++; rafQueue.set(id, cb); return id }
G.cancelAnimationFrame = (id: number) => { rafQueue.delete(id) }
const flush = () => { const q = rafQueue; rafQueue = new Map(); for (const cb of q.values()) cb() }

let failures = 0
const ok = (cond: boolean, what: string) => { if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}`) } }
const within = (a: Rect, b: Rect) => a.w <= 0 || a.h <= 0 || (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h)
const overlap = (a: Rect, b: Rect) => { const r = intersect(a, b); return r.w > 0 && r.h > 0 }

// ── pre-render ──────────────────────────────────────────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(file('../src/worker-office/data/floorplan.json'), 'utf8'))
const ROWS: string[] = raw.rows
const map = loadMap(raw)
const W = map.width, H = map.height, T = map.tileSize
const scene = pre.prerenderOffice(map)
const asStub = (c: unknown) => c as StubCanvas
const floor = asStub(scene.floorLayer), layer = asStub(scene.layer)
const big = canvases.filter(c => c.width === W * T && c.height === H * T)
const objectLayer = big.find(c => c !== floor && c !== layer)!
console.log('pre-render')
ok(big.length === 3 && pre.prerenderBuilds() === 1, `three ${W * T}×${H * T} layers (ground, objects, composite), built once`)

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

// ── the ground layer, TILE BY TILE, against floorplan.json and plan §1.2 ────────────────────────────────────────
// plan §1.2 "Floor finish" per zone, and finish name -> art, both written here from the plan (not floors.ts's table)
const PLAN_ZONE_FINISH: Record<string, string> = {
  LIBRARY: 'green carpet', RECORDS: 'grey vinyl', 'WORK ROOM': 'oak (existing art)', CORRIDOR: 'travertine', MEETING: 'blue carpet',
  'BREAK ROOM': 'checker tile', RECEPTION: 'terrazzo', 'MAIL / PRINT CORNER': 'grey carpet tiles', SERVERS: 'raised floor',
  SIDEWALK: 'concrete', STREET: 'asphalt',
}
const PLAN_ART: Record<string, FinishId> = {
  'green carpet': 'carpet', 'grey vinyl': 'vinyl', 'oak (existing art)': 'oak', travertine: 'travertine', 'blue carpet': 'carpet',
  'checker tile': 'checker', terrazzo: 'terrazzo', 'grey carpet tiles': 'carpetTiles', 'raised floor': 'raisedFloor', concrete: 'concrete', asphalt: 'asphalt',
}
type JZ = { name: string; x: number; y: number; w: number; h: number; floor: string; finish: string; parent?: string }
const jzones = raw.zones as JZ[]
ok(jzones.length === 11 && jzones.every(z => PLAN_ZONE_FINISH[z.name] === z.finish)
  && new Set(jzones.filter(z => z.name !== 'SIDEWALK' && z.name !== 'STREET').map(z => z.finish)).size === 9,
  'zone finishes in floorplan.json = plan §1.2 (11 zones, 9 interior finishes)')
/** most specific zone of a tile, from the JSON alone (a child zone over its parent) */
const jsonZoneAt = (x: number, y: number) => {
  const zs = jzones.filter(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h)
  return zs.find(z => z.parent) ?? zs[0] ?? null
}
const sig = (c: StubCanvas) => JSON.stringify(c.ctx.fills.map(f => [f.style, f.x, f.y, f.w, f.h]))
const expectedSig = new Map<string, string>()
const finishSig = (z: JZ, x: number, y: number) => {
  const v = variantOf(x, y), key = `${z.name}|${v}`
  if (!expectedSig.has(key)) {
    const s = new StubCanvas(); s.width = T; s.height = T
    drawFinish(s.ctx as unknown as CanvasRenderingContext2D, PLAN_ART[z.finish], z.floor, v)
    expectedSig.set(key, sig(s))
  }
  return expectedSig.get(key)!
}
const WALL_MOUNTED_KINDS = new Set(['kanbanBoard', 'inOutBoard', 'wallClock', 'noticeBoard'])   // plan §1.2 engine notes
const wmChars = new Set((raw.objects as { kind: string; char: string }[]).filter(o => WALL_MOUNTED_KINDS.has(o.kind)).map(o => o.char))
const wallLikeCh = (c: string | undefined) => c === '#' || c === '~' || (c !== undefined && wmChars.has(c))
const openingWall = new Map<string, 'h' | 'v'>()
for (const cells of Object.values(raw.openings as Record<string, { x: number; y: number }[]>)) {
  const horiz = new Set(cells.map(t => t.y)).size === 1
  for (const t of cells) openingWall.set(`${t.x},${t.y}`, horiz ? 'h' : 'v')
}
const isDraw = (r: Fill | Draw): r is Draw => 'src' in r
const byTile = new Map<string, (Fill | Draw)[]>()
for (const r of [...floor.ctx.fills.filter(f => !f.style.startsWith('rgba(20,12,4')), ...floor.ctx.draws].sort((a, b) => a.seq - b.seq)) {
  const k = `${Math.floor(r.x / T)},${Math.floor(r.y / T)}`
  if (!byTile.has(k)) byTile.set(k, [])
  byTile.get(k)!.push(r)
}
const groundBad: string[] = []
const tally = new Map<string, number>()
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const c = ROWS[y][x], rs = byTile.get(`${x},${y}`) ?? [], first = rs[0]
  const style = (r: Fill | Draw | undefined) => (r && !isDraw(r) ? r.style : '')
  let good = false, what = ''
  if (c === '#' || wmChars.has(c)) {
    const face = !wallLikeCh(ROWS[y + 1]?.[x])
    what = face ? 'wall face' : 'wall top'
    good = !!first && !isDraw(first) && first.x === x * T && first.y === y * T && first.w === T && first.h === T && first.style === (face ? '#2e2620' : '#a08b6a')
  } else if (c === '~') {
    const facade = y === raw.door.y
    what = facade ? 'facade window' : 'north window'
    good = style(first) === '#2e2620' && rs.some(r => style(r) === '#8fa1ab' && r.w === 14 && r.h === 9) && rs.some(r => style(r) === (facade ? '#2b3842' : '#9ec7d8'))
  } else if (c === 'D') {
    what = 'door base'
    good = style(first) === '#a08b6a' && first!.w === T && first!.h === 4 && rs.some(r => style(r) === '#2c2925')
  } else if (c === '%') {
    what = 'planter'
    good = style(first) === '#77736b' && first!.w === T && first!.h === T
  } else if (c === '+') {
    const wall = openingWall.get(`${x},${y}`)
    const [za, zb] = wall === 'h' ? [jsonZoneAt(x, y - 1), jsonZoneAt(x, y + 1)] : [jsonZoneAt(x - 1, y), jsonZoneAt(x + 1, y)]
    what = `doorway ${wall === 'h' ? 'N|S' : 'W|E'}`
    const ds = rs.filter(isDraw)
    good = ds.length === 2 && !!za && !!zb && sig(ds[0].src) === finishSig(za, x, y) && sig(ds[1].src) === finishSig(zb, x, y)
      && (wall === 'h'
        ? ds[0].sy === 0 && ds[0].sh === 8 && ds[0].y === y * T && ds[1].sy === 8 && ds[1].sh === 8 && ds[1].y === y * T + 8
        : ds[0].sx === 0 && ds[0].sw === 8 && ds[0].x === x * T && ds[1].sx === 8 && ds[1].sw === 8 && ds[1].x === x * T + 8)
    if (!good) what += ` ${za?.name}|${zb?.name}`
  } else {
    const z = jsonZoneAt(x, y)
    what = `${z?.name ?? 'NO ZONE'} (${z?.finish})`
    const ds = rs.filter(isDraw)
    good = !!z && ds.length === 1 && ds[0].x === x * T && ds[0].y === y * T && ds[0].w === T && ds[0].h === T && sig(ds[0].src) === finishSig(z, x, y)
    if (c === 'm') good = good && rs.some(r => style(r) === raw.legend.m.color)
  }
  tally.set(what, (tally.get(what) ?? 0) + 1)
  if (!good) groundBad.push(`(${x},${y}) '${c}' should be ${what}`)
}
ok(groundBad.length === 0, `ground layer, tile by tile: ${W * H - groundBad.length} of ${W * H} tiles drawn as floorplan.json + plan §1.2 say${groundBad.length ? ` — wrong: ${groundBad.slice(0, 5).join('; ')}${groundBad.length > 5 ? ' …' : ''}` : ''}`)
console.log(`       by class: ${[...tally.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}`)
const cornerTiles = [...tally.entries()].filter(([k]) => k.startsWith('MAIL / PRINT CORNER')).reduce((s, [, n]) => s + n, 0)
ok(cornerTiles > 0 && !groundBad.some(b => b.includes('MAIL / PRINT CORNER')), `the ${cornerTiles} mail / print corner floor tiles carry grey carpet tiles (its own zone, not reception's terrazzo)`)

// layer 2: every furniture tile drawn exactly once on a transparent canvas — a slice tile (pass 1) as ONE blit of its
// kind's cached 16×16 tile, the same canvas wherever that kind stands (base art never depends on position); a pass-2
// tile as its step-1 placeholder in its legend colour — and paint nowhere else
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
const objTileList = objTiles.flatMap(o => o.tileKinds.map((k, i) => ({ o, k, x: o.x + (i % o.w), y: o.y + Math.floor(i / o.w) })))
const sliceTiles = objTileList.filter(t => hasFurnitureArt(t.k))
const placeholderTiles = objTileList.length - sliceTiles.length
ok(objectLayer.ctx.draws.length === sliceTiles.length && objectLayer.ctx.translates.length === placeholderTiles && sliceTiles.length > 0 && placeholderTiles > 0,
  `object layer: ${objectLayer.ctx.draws.length} blits of cached furniture tiles (pass 1) + ${objectLayer.ctx.translates.length} placeholder tiles (pass 2) = ${objTileCount} furniture tiles (door, doormat, planters, street are ground)`)
{
  // each blit: at its own tile, 16×16 from a 16×16 source, from ONE canvas per kind, never one of the floor's tiles
  const finishSrc = new Set(floor.ctx.draws.map(d => d.src))
  const srcOfKind = new Map<string, StubCanvas>()
  const blitBad: string[] = []
  for (const t of sliceTiles) {
    const d = objectLayer.ctx.draws.filter(dd => dd.x === t.x * T && dd.y === t.y * T)
    if (d.length !== 1 || d[0].w !== T || d[0].h !== T || d[0].sw !== T || d[0].sh !== T || finishSrc.has(d[0].src)) { blitBad.push(`(${t.x},${t.y}) ${t.k}`); continue }
    const prev = srcOfKind.get(t.k)
    if (prev && prev !== d[0].src) blitBad.push(`(${t.x},${t.y}) ${t.k}: a second canvas for the kind`)
    srcOfKind.set(t.k, d[0].src)
  }
  ok(blitBad.length === 0, `object layer: each of the ${sliceTiles.length} slice tiles is one 16×16 blit at its own tile, from ONE cached canvas per kind (${srcOfKind.size} kinds), never a floor tile${blitBad.length ? ` — wrong: ${blitBad.slice(0, 4).join(', ')}` : ''}`)
}
const objPaint = new Map<string, Fill[]>()
for (const f of objectLayer.ctx.fills) { const k = `${Math.floor(f.x / T)},${Math.floor(f.y / T)}`; if (!objPaint.has(k)) objPaint.set(k, []); objPaint.get(k)!.push(f) }
const objBad: string[] = []
for (const t of objTileList) {
  const key = `${t.x},${t.y}`
  if (hasFurnitureArt(t.k)) { if (objPaint.has(key)) objBad.push(`(${t.x},${t.y}) ${t.o.id}: a fill over its blit`); continue }
  if (!(objPaint.get(key) ?? []).some(f => f.style === map.legend[t.o.char].color)) objBad.push(`(${t.x},${t.y}) ${t.o.id}`)
  objPaint.delete(key)
}
ok(objBad.length === 0 && objPaint.size === 0, `object layer, tile by tile: every pass-2 tile carries its placeholder in its legend colour, no slice tile is painted over; stray paint on ${objPaint.size} other tiles${objBad.length ? ` — wrong on ${objBad.slice(0, 4).join(', ')}` : ''}`)

// shadows: recomputed here from the rows alone
const WALLISH_CHARS = new Set(['#', '~', ...wmChars])
const ch = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? ROWS[y][x] : '')
const receives = (x: number, y: number) => ch(x, y) !== '' && !WALLISH_CHARS.has(ch(x, y)) && ch(x, y) !== 'D'
const surfaceChars = new Set(map.objects.filter(o => SURFACE_KINDS.has(o.kind)).map(o => o.char))
/** Seats that lie flat for shadows (step-2 catalogue shadow set "FLOOR_LIKE seat tile"; plan §6.2 no contact shadow
 *  under seats): the task chairs and the wooden chairs, by their legend names. */
const FLAT_SEAT_CHARS = new Set(Object.entries(raw.legend as Record<string, { name: string }>).filter(([, e]) => e.name === 'taskChairN' || e.name === 'woodChairN').map(([c]) => c))
const furniture = (x: number, y: number) => { const c = ch(x, y); return c !== '' && !'#~+:.,qu*'.includes(c) && !WALLISH_CHARS.has(c) && !surfaceChars.has(c) && !FLAT_SEAT_CHARS.has(c) }
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
{
  const seats = ROWS.join('').split('').filter(c => FLAT_SEAT_CHARS.has(c)).length
  const underSeats = floor.ctx.fills.filter(f => f.style === 'rgba(20,12,4,0.18)' && FLAT_SEAT_CHARS.has(ch(Math.floor(f.x / T), Math.floor(f.y / T) - 1)))
  ok(FLAT_SEAT_CHARS.size === 2 && seats === 13 && underSeats.length === 0, `none of the ${seats} task and wooden chairs casts a contact shadow (${underSeats.length} found)`)
}
ok(count('rgba(20,12,4,0.16)') === expEast, `east wall shadows: ${count('rgba(20,12,4,0.16)')} (expected ${expEast})`)
ok(!floor.ctx.fills.some(f => f.style.startsWith('rgba(20,12,4') && f.y >= 19 * T && f.y < 20 * T && f.x >= 16 * T && f.x < 18 * T),
  'no shadow on the door leaves')

// ── light: one pool per run of windows plus the lamp, each clipped to its own room ─────────────────────────────
const facadeRow: number = raw.door.y
const windows: [number, number][] = []
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ch(x, y) === '~') windows.push([x, y])
const runs: { y: number; x0: number; x1: number }[] = []
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (ch(x, y) !== '~' || ch(x - 1, y) === '~') continue
  let x1 = x
  while (ch(x1 + 1, y) === '~') x1++
  runs.push({ y, x0: x, x1 })
}
const rooms = jzones.filter(z => !z.parent)
const roomRect = (z: JZ): Rect => ({ x: z.x * T, y: z.y * T, w: z.w * T, h: z.h * T })
const lights = layer.ctx.fills.filter(f => f.grad !== null).map(f => ({ f, area: intersect({ x: f.x, y: f.y, w: f.w, h: f.h }, f.clip) }))
const homeless = lights.filter(l => !rooms.some(z => within(l.area, roomRect(z))))
ok(lights.length > 0 && homeless.length === 0, `light stays in its room: ${lights.length - homeless.length} of ${lights.length} pools painted inside one room${homeless.length ? ` — through a wall: ${homeless.map(l => `${l.f.grad!.kind} at x ${l.area.x}..${l.area.x + l.area.w}, y ${l.area.y}..${l.area.y + l.area.h}`).slice(0, 3).join('; ')}` : ''}`)
const lin = layer.ctx.grads.filter(g => g.kind === 'linear')
const pools = lights.filter(l => l.f.grad!.kind === 'linear')
ok(runs.length === 7 && windows.length === 15 && lin.length === runs.length && pools.length === runs.length,
  `daylight: one pool per run of windows (${pools.length} pools, ${lin.length} gradients, for ${runs.length} runs of ${windows.length} windows)`)
const unmatched = runs.filter(r => {
  const north = r.y < facadeRow
  return pools.filter(p => p.f.x === r.x0 * T - 3 && p.f.w === (r.x1 - r.x0 + 1) * T + 6 && p.f.y === (north ? (r.y + 1) * T : r.y * T - 40) && p.f.h === 40
    && p.f.grad!.args[1] === (north ? (r.y + 1) * T : r.y * T) && p.f.grad!.args[3] === (north ? (r.y + 1) * T + 40 : r.y * T - 40)).length !== 1
})
ok(unmatched.length === 0, `each run's pool spans the run (3 texels past each end), falling SOUTH from the north windows and NORTH from the facade row y=${facadeRow}${unmatched.length ? ` — unmatched runs: ${unmatched.map(r => `y${r.y} x${r.x0}-${r.x1}`).join(', ')}` : ''}`)
const seams: string[] = []
for (let i = 0; i < pools.length; i++) for (let j = i + 1; j < pools.length; j++) if (overlap(pools[i].area, pools[j].area)) seams.push(`${pools[i].area.x}/${pools[j].area.x}`)
ok(seams.length === 0, `no two daylight pools overlap (no bright seams under the mullions)${seams.length ? ` — ${seams.length} overlaps` : ''}`)
const lamp = map.objects.find(o => o.kind === 'floorLamp')!
const radial = lights.filter(l => l.f.grad!.kind === 'radial')
const lampRoom = jsonZoneAt(lamp.x, lamp.y)!
ok(radial.length === 1 && radial[0].f.grad!.args[0] === lamp.x * T + 8 && radial[0].f.grad!.args[1] === lamp.y * T + 4 && within(radial[0].area, roomRect(lampRoom)),
  `floor lamp glow at (${lamp.x},${lamp.y}), inside the ${lampRoom.name} only (not through its east wall, the facade or onto the sidewalk)`)

// labels from the zones (scale 1)
const labels = scene.labels.map(l => `${l.text}@${(l.x - 3) / T},${(l.y - 8) / T}`)
ok(JSON.stringify(labels) === JSON.stringify(['LIBRARY@1,3', 'RECORDS@10,3', 'WORK ROOM@25,3', 'MEETING@4,14', 'BREAK ROOM@7,16',
  'RECEPTION@14,14', 'SERVERS@29,14', 'MAIL / PRINT CORNER@21,16', 'CORRIDOR@1,11', 'SIDEWALK@1,20']),
  `room labels (zone order, on plain floor, no STREET): ${labels.join(' ')}`)
const LABEL_GROUND = ['floor', 'corridor', 'placeTile', 'sidewalk', 'arrivalSlot']
for (const l of scene.labels) {
  const tx = (l.x - 3) / T, ty = (l.y - 8) / T
  const z = map.zones.find(q => q.name === l.text)!
  ok(map.zoneAt(tx, ty) === z && LABEL_GROUND.includes(map.tiles[ty][tx]), `label ${l.text} sits on its own zone's plain floor (${tx},${ty})`)
}

// ── engine ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('engine')
const canvas = new StubCanvas()
const engine = new WorkerEngine(canvas as unknown as HTMLCanvasElement, scene)
type EngineApi = { debug?: WorkerOfficeDebug; setTopInset?: (cssPx: number) => void }
const api = engine as unknown as EngineApi
const globalDebug = () => (globalThis as unknown as { __workerOffice?: WorkerOfficeDebug }).__workerOffice
const st = (): WorkerOfficeDebug => api.debug ?? globalDebug()!
/** a copy of the state now (engine.debug is a live view) */
const snap = (): WorkerOfficeDebug => ({ ...st() })
engine.setActive(true)
const sendResize = (c: StubCanvas, cssW: number, cssH: number, dpr: number) => {
  G.devicePixelRatio = dpr
  c.cssW = cssW; c.cssH = cssH
  roByCanvas.get(c)!([{ contentRect: { width: cssW, height: cssH }, devicePixelContentBoxSize: [{ inlineSize: Math.round(cssW * dpr), blockSize: Math.round(cssH * dpr) }] }])
}
const resize = (cssW: number, cssH: number, dpr: number) => { sendResize(canvas, cssW, cssH, dpr); flush() }
const WW = W * T, WH = H * T
const fitCases: [number, number, number, number, string][] = [
  // css w, css h, dpr, expected device px per texel
  [1134, 864, 1, 2, '1440×900 with the default 300 px sidebar (+6 px gutter): plan §6.1 "2.0"'],
  [1133, 864, 1, 2, 'sidebar 301 px (the old 0.96 margin gave 1)'],
  [1088, 864, 1, 2, 'sidebar 346 px: the widest at which 2× still fits at 1440 px'],
  [1087, 864, 1, 1, 'sidebar 347 px: 2× needs 1088 px'],
  [1134, 766, 1, 2, 'viewport height 802 (the old margin gave 1)'],
  [1134, 736, 1, 2, 'viewport height 772: an exact fit'],
  [1134, 735, 1, 1, 'viewport height 771: 2× needs 736 px'],
  [1440, 864, 1, 2, '1440×900 without the sidebar: 2.25 -> 2'],
  [1134, 864, 1.25, 2, 'a 125 % display: zoom 1.6 CSS px, 2 device px per texel'],
  [1401, 1031, 1.5, 3, "the owner's 1707×1067 CSS at 150 % with the default sidebar: zoom 2.0"],
  [1134, 864, 2, 4, '1440×900 at DPR 2'],
  [1133, 864, 2, 4, 'sidebar 301 px at DPR 2 (the old margin gave 3, zoom 1.5)'],
  [300, 200, 1, 1, 'tiny panel: never below 1 device pixel per texel'],
]
for (const [w, h, dpr, want, why] of fitCases) {
  resize(w, h, dpr)
  const d = st()
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr)
  ok(d.deviceScale === want && Number.isInteger(d.zoom * dpr) && Number.isInteger(d.offset[0]) && Number.isInteger(d.offset[1])
    && canvas.width === bw && canvas.height === bh
    && d.offset[0] === Math.round((bw - WW * want) / 2) && d.offset[1] === Math.round((bh - WH * want) / 2),
  `fit ${w}×${h} @ DPR ${dpr}: ${d.deviceScale} device px/texel (want ${want}), zoom ${d.zoom}, backing ${canvas.width}×${canvas.height}, offset ${d.offset} — ${why}`)
}
// the rule itself, and the sidebar range (220–560 px, persisted) at 1440×900 and on the owner's screen
const HEADER = 36, GUTTER = 6
const sweep = (vw: number, vh: number, dpr: number) => {
  const byZoom = new Map<number, number[]>()
  let ruleBroken = 0
  for (let sb = 220; sb <= 560; sb++) {
    resize(vw - sb - GUTTER, vh - HEADER, dpr)
    const d = st()
    const largest = Math.max(1, Math.floor(Math.min(d.backing[0] / WW, d.backing[1] / WH)))
    if (d.deviceScale !== largest) ruleBroken++
    const z = Math.round(d.zoom * 1e4) / 1e4
    if (!byZoom.has(z)) byZoom.set(z, [])
    byZoom.get(z)!.push(sb)
  }
  return { ruleBroken, desc: [...byZoom.entries()].map(([z, s]) => `zoom ${z} for sidebar ${s[0]}-${s[s.length - 1]} px`).join('; ') }
}
for (const [vw, vh, dpr, want] of [
  [1440, 900, 1, 'zoom 2 for sidebar 220-346 px; zoom 1 for sidebar 347-560 px'],
  [1707, 1067, 1.5, 'zoom 2.6667 for sidebar 220-250 px; zoom 2 for sidebar 251-560 px'],
  [1920, 1080, 1, 'zoom 2 for sidebar 220-560 px'],
  [1536, 864, 1.25, 'zoom 1.6 for sidebar 220-560 px'],
] as [number, number, number, string][]) {
  const s = sweep(vw, vh, dpr)
  ok(s.ruleBroken === 0 && s.desc === want, `sidebar sweep at ${vw}×${vh} @ DPR ${dpr}: ${s.desc} (the largest whole scale that fits: ${341 - s.ruleBroken} of 341 widths)`)
}

// the overlay band (WORKERS chip + "No live feed" banner) costs placement, never scale
ok(typeof api.setTopInset === 'function', 'engine.setTopInset(): the fit knows the overlay band over the canvas')
if (api.setTopInset) {
  resize(1134, 864, 1)
  api.setTopInset(66)                        // CSS px from the canvas top, as WorkerOffice.tsx measures it
  flush()
  let d = st()
  ok(d.deviceScale === 2 && d.offset[1] === 66 + Math.round((864 - WH * 2 - 66) / 2) && d.offset[0] === 23,
    `1440×900, overlay band 66 px: scale 2, the building centred below the band (top edge at ${d.offset[1]} px)`)
  resize(1134, 767, 1)
  d = st()
  ok(d.deviceScale === 2 && d.offset[1] === 767 - WH * 2, `height 803 (31 px of slack < 66 px band): scale stays 2, building bottom-aligned (top at ${d.offset[1]} px)`)
  resize(1134, 864, 2)
  d = st()
  ok(d.deviceScale === 4 && d.offset[1] === 132 + Math.round((1728 - WH * 4 - 132) / 2), `DPR 2: the band is 132 device px; building top at ${d.offset[1]}`)
  resize(1134, 864, 1)
  const fitted = st().offset.join()
  canvas.listeners.get('pointerdown')!({ button: 0, pointerId: 7, clientX: 300, clientY: 300 })
  canvas.listeners.get('pointermove')!({ pointerId: 7, clientX: 320, clientY: 310 }); flush()
  canvas.listeners.get('pointerup')!({ pointerId: 7 })
  const panned = st().offset.join()
  api.setTopInset(80); flush()
  ok(st().offset.join() === panned && panned !== fitted, `a band change does not undo the user's pan (offset ${panned})`)
  canvas.listeners.get('dblclick')!({}); flush()
  ok(st().offset[1] === 80 + Math.round((864 - WH * 2 - 80) / 2), `double-click fits below the new band (top at ${st().offset[1]} px)`)
  api.setTopInset(0); flush()
}
resize(1134, 864, 1)
const lastDraw = canvas.ctx.draws.at(-1)!
ok(lastDraw.src === layer && lastDraw.x === 23 && lastDraw.y === 64 && lastDraw.w === WW * 2 && lastDraw.h === WH * 2,
  `map drawn at integer scale: ${lastDraw.w}×${lastDraw.h} at (${lastDraw.x},${lastDraw.y})`)
const texts = canvas.ctx.texts.slice(-10)
ok(texts.length === 10 && texts.every(t => /^bold [45]px /.test(t.font)), `10 room labels drawn as text (${texts.map(t => t.text).join(', ')})`)
const doorFills = canvas.ctx.fills.filter(f => f.style === 'rgba(170,214,222,0.42)').slice(-2)
ok(doorFills.length === 2 && doorFills[0].w === 15 * 2 && doorFills[1].w === 15 * 2 && doorFills[0].x === 23 + (16 * T + 1) * 2 && doorFills[1].x === 23 + 17 * T * 2,
  'both door leaves drawn shut (zero workers near the door)')

// a resize repaints inside the ResizeObserver callback: the new backing store is blank, and the frame is painted
// right after the callback, before any animation frame could redraw it
{
  const d0 = st().draws, r0 = canvas.resets
  sendResize(canvas, 1133, 864, 1)           // the observer callback alone; no animation frame runs
  const lastPaint = Math.max(...canvas.ctx.fills.map(f => f.seq), ...canvas.ctx.draws.map(d => d.seq))
  ok(canvas.resets > r0 && st().draws === d0 + 1 && lastPaint > canvas.lastReset,
    `a resize repaints in the same callback (backing resets ${canvas.resets - r0}, draws ${st().draws - d0}, painted after the reset: ${lastPaint > canvas.lastReset})`)
  flush()
  resize(1134, 864, 1)
}

// hidden tab (display:none): drawing stops, the 0×0 resize is ignored, and coming back keeps the camera
const before = snap()
engine.setActive(false)
sendResize(canvas, 0, 0, 1)
engine.setFontScale(1.2)                    // anything that wants a redraw
ok(rafQueue.size === 0 && st().active === false && st().draws === before.draws, 'nothing is drawn or scheduled while the tab is hidden')
ok(canvas.width === 1134 && canvas.height === 864 && st().deviceScale === before.deviceScale && st().offset.join() === before.offset.join(),
  `the 0×0 resize of a hidden tab is ignored (backing still ${canvas.width}×${canvas.height}, camera unchanged)`)
engine.setActive(true); flush()
const shown = st()
ok(shown.draws > before.draws && shown.deviceScale === before.deviceScale && shown.offset.join() === before.offset.join(),
  `shown again: redrawn (draws ${before.draws} -> ${shown.draws}) with the same camera`)
engine.setFontScale(1); flush()

// wheel: whole steps; never on deltaY 0; touchpad deltas add up instead of stepping per event
const wheel = canvas.listeners.get('wheel')!
let clock = 10_000
const wh = (deltaY: number, deltaMode = 0, dt = 300, extra: Record<string, unknown> = {}) => {
  clock += dt
  let prevented = false
  wheel({ deltaY, deltaX: 0, deltaMode, timeStamp: clock, clientX: 400, clientY: 300, ctrlKey: false, preventDefault() { prevented = true }, ...extra })
  flush()
  return prevented
}
canvas.listeners.get('dblclick')!({}); flush()
const s0 = st().deviceScale
const hPrevented = wh(0, 0, 300, { deltaX: 40 })
ok(st().deviceScale === s0 && hPrevented, `a horizontal swipe (deltaY 0, deltaX 40) does not zoom (scale ${s0} -> ${st().deviceScale}); the page still does not scroll`)
wh(-100)
ok(st().deviceScale === s0 + 1, `one mouse notch (deltaY -100 px): one step in (${s0} -> ${st().deviceScale})`)
wh(-100, 0, 30)
ok(st().deviceScale === s0 + 1, `a second notch 30 ms later is dropped: steps are at least 90 ms apart (scale ${st().deviceScale})`)
wh(3, 1, 300)
ok(st().deviceScale === s0, `a line-mode notch (deltaMode 1, deltaY 3: Firefox): one step out (scale ${st().deviceScale})`)
for (let i = 0; i < 40; i++) wh(-3, 0, i === 0 ? 300 : 10)
ok(st().deviceScale === s0 + 1, `a touchpad scroll of 40 × 3 px: one step, not 40 (${s0} -> ${st().deviceScale})`)
wh(-20, 0, 300, { ctrlKey: true }); wh(-20, 0, 16, { ctrlKey: true }); wh(-20, 0, 16, { ctrlKey: true })
ok(st().deviceScale === s0 + 2, `a touchpad pinch (ctrl+wheel, 3 × 20 px): one step (${s0 + 1} -> ${st().deviceScale})`)
canvas.listeners.get('dblclick')!({}); flush()
ok(st().deviceScale === before.deviceScale && st().offset.join() === before.offset.join(), 'double-click fits again after a zoom')

// wheel zoom keeps the texel under the cursor
const pre0 = snap()
const cx = 400, cy = 300                     // CSS px = device px at DPR 1
const wx = (cx - pre0.offset[0]) / pre0.deviceScale, wy = (cy - pre0.offset[1]) / pre0.deviceScale
wh(-100)
const z = snap()
ok(z.deviceScale === pre0.deviceScale + 1 && Number.isInteger(z.offset[0]) && Number.isInteger(z.offset[1])
  && Math.abs(z.offset[0] + wx * z.deviceScale - cx) <= 0.5 && Math.abs(z.offset[1] + wy * z.deviceScale - cy) <= 0.5,
  `wheel: ${pre0.deviceScale} -> ${z.deviceScale} device px/texel, cursor texel kept, offset ${z.offset}`)
// pan
canvas.listeners.get('pointerdown')!({ button: 0, pointerId: 1, clientX: 100, clientY: 100 })
canvas.listeners.get('pointermove')!({ pointerId: 1, clientX: 137.3, clientY: 80.2 }); flush()
canvas.listeners.get('pointerup')!({ pointerId: 1 })
const p = snap()
ok(p.offset[0] === Math.round(z.offset[0] + 37.3) && p.offset[1] === Math.round(z.offset[1] - 19.8), `pan by (37.3, -19.8) CSS px -> whole-pixel offset ${p.offset}`)

// two-finger pinch: one whole step per 25 % change of the finger distance; lifting a finger carries on as a pan
{
  canvas.listeners.get('dblclick')!({}); flush()
  const down = canvas.listeners.get('pointerdown')!, move = canvas.listeners.get('pointermove')!, up = canvas.listeners.get('pointerup')!
  const s1 = st().deviceScale
  down({ button: 0, pointerId: 11, clientX: 400, clientY: 300 })
  down({ button: 0, pointerId: 12, clientX: 500, clientY: 300 })
  move({ pointerId: 12, clientX: 530, clientY: 300 }); flush()        // spread 100 -> 130
  const out1 = st().deviceScale
  move({ pointerId: 12, clientX: 520, clientY: 300 }); flush()        // 120: within 25 % of 130
  const hold = st().deviceScale
  move({ pointerId: 12, clientX: 500, clientY: 300 }); flush()        // 100 <= 130 / 1.25
  const in1 = st().deviceScale
  ok(out1 === s1 + 1 && hold === s1 + 1 && in1 === s1, `pinch: spread 100 -> 130 px zooms in one step (${s1} -> ${out1}), 120 holds (${hold}), back to 100 zooms out (${in1})`)
  up({ pointerId: 12 })
  const o1 = st().offset
  move({ pointerId: 11, clientX: 410, clientY: 300 }); flush()
  ok(st().offset[0] === o1[0] + 10 && st().offset[1] === o1[1], `after one finger lifts, the other pans on from where it is (offset ${o1} -> ${st().offset})`)
  up({ pointerId: 11 })
}

// keyboard (the canvas is focusable): arrows pan two tiles, + / - zoom about the centre, 0 fits
{
  const key = canvas.listeners.get('keydown')
  ok(typeof key === 'function', 'the canvas takes keyboard input (arrows pan, + and - zoom, 0 fits)')
  if (key) {
    canvas.listeners.get('dblclick')!({}); flush()
    const k0 = snap(), o0 = [...k0.offset]
    let prevented = false
    const press = (k: string, mods: Record<string, boolean> = {}) => {
      prevented = false
      key({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { prevented = true }, ...mods }); flush()
      return prevented
    }
    const pz = press('+')
    ok(pz && st().deviceScale === k0.deviceScale + 1, `'+' zooms in one step (${k0.deviceScale} -> ${st().deviceScale})`)
    press('-')
    ok(st().deviceScale === k0.deviceScale, `'-' zooms out one step (${st().deviceScale})`)
    press('0')
    const pr = press('ArrowRight')
    ok(pr && st().offset[0] === o0[0] - 2 * T * k0.deviceScale && st().offset[1] === o0[1], `ArrowRight pans two tiles (offset x ${o0[0]} -> ${st().offset[0]})`)
    press('ArrowDown')
    ok(st().offset[1] === o0[1] - 2 * T * k0.deviceScale, `ArrowDown pans two tiles (offset y ${o0[1]} -> ${st().offset[1]})`)
    const p0 = press('0')
    ok(p0 && st().offset.join() === o0.join() && st().deviceScale === k0.deviceScale, `'0' fits again (${st().offset})`)
    const pc = press('+', { ctrlKey: true }), pa = press('a')
    ok(!pc && !pa && st().deviceScale === k0.deviceScale, 'ctrl/cmd + key (browser zoom) and other keys are left to the browser')
  }
}

// labels for every UI text scale: placed again, never across a wall, a doorway, furniture or another zone
{
  const settings = readFileSync(file('../src/settings/SettingsContext.tsx'), 'utf8')
  const fmin = /export const FONT_MIN = ([\d.]+)/.exec(settings), fmax = /export const FONT_MAX = ([\d.]+)/.exec(settings)
  ok(!!fmin && !!fmax, `FONT_MIN / FONT_MAX read from SettingsContext.tsx (${fmin?.[1]} / ${fmax?.[1]})`)
  const FONT_MIN = fmin ? +fmin[1] : 0.7, FONT_MAX = fmax ? +fmax[1] : 2.5
  const zoneByName = new Map(map.zones.map(q => [q.name, q]))
  for (const fs of [FONT_MIN, 1, 1.25, 1.5, 2, FONT_MAX]) {
    engine.setFontScale(fs); flush()
    canvas.listeners.get('dblclick')!({}); flush()
    const frameStart = Math.max(...canvas.ctx.fills.filter(f => f.style === '#05070f').map(f => f.seq))
    const drawn = canvas.ctx.texts.filter(t => t.seq > frameStart)
    const bad: string[] = []
    for (const t of drawn) {
      const zz = zoneByName.get(t.text)
      const size = parseFloat(/([\d.]+)px/.exec(t.font)![1])
      const base = zz?.parent ? 4 : 5
      const wpx = 0.6 * size * t.text.length                   // the stub's (and IBM Plex Mono's) 0.6 em advance
      const ty = Math.floor(t.y / T)
      if (!zz) { bad.push(`${t.text}: no such zone`); continue }
      if (fs >= 1 ? size < base : Math.abs(size - base * fs) > 1e-9) bad.push(`${t.text}: size ${size} at scale ${fs}`)
      if (t.y - size / 2 < ty * T || t.y + size / 2 > (ty + 1) * T) bad.push(`${t.text}: ${size} texels tall leaves its row`)
      for (let tx = Math.floor(t.x / T); tx <= Math.floor((t.x + wpx - 1e-9) / T); tx++) {
        if (map.zoneAt(tx, ty) !== zz || !LABEL_GROUND.includes(map.tiles[ty]?.[tx])) { bad.push(`${t.text} (${size} texels) runs onto (${tx},${ty}) ${map.tiles[ty]?.[tx]}`); break }
      }
    }
    ok(drawn.length === 10 && bad.length === 0, `text scale ${fs}: ${drawn.length} labels, each on plain floor of its own zone${bad.length ? ` — ${bad.slice(0, 3).join('; ')}` : ''}`)
  }
  engine.setFontScale(1); flush()
}

// the debug object: built once, a live view; on window only in dev builds or with ?woDebug
{
  const d1 = api.debug
  ok(typeof d1 === 'object' && d1 !== null, 'engine.debug: the state the checks read, built once')
  const draws0 = st().draws
  for (let i = 0; i < 3; i++) { engine.setFontScale(i % 2 ? 1 : 1.1); flush() }
  ok(api.debug === d1 && st().draws > draws0 && globalDebug() === undefined,
    `after ${st().draws - draws0} more draws the debug object is the same one; window.__workerOffice is not set (no dev build, no ?woDebug): ${globalDebug() === undefined}`)
  G.location = { search: '?woDebug' }
  const c2 = new StubCanvas()
  const e2 = new WorkerEngine(c2 as unknown as HTMLCanvasElement, scene)
  const api2 = e2 as unknown as EngineApi
  e2.setActive(true); sendResize(c2, 800, 600, 1); flush()
  const g1 = globalDebug()
  e2.setFontScale(1.3); flush(); e2.setFontScale(1); flush()
  ok(!!api2.debug && g1 === api2.debug && globalDebug() === g1, '?woDebug: window.__workerOffice is that engine\'s debug object, and stays the same one across draws')
  e2.destroy()
  e2.setActive(true); e2.setFontScale(2)
  ok(globalDebug() === undefined && api2.debug?.active === false && rafQueue.size === 0, 'destroy(): window.__workerOffice removed, inactive, and nothing more is scheduled')
  delete G.location
}

// ── a feed: the EXAMPLE plays through the real core, planner and figures (live/world.ts, live/example.ts) ───────
{
  console.log('engine with a feed (the EXAMPLE: synthetic events)')
  const layout = buildPlaceLayout(map)
  type FeedApi = { playExample?: (l: unknown) => void; stopFeed?: () => void }
  const fapi = engine as unknown as FeedApi
  ok(typeof fapi.playExample === 'function' && typeof fapi.stopFeed === 'function', 'engine.playExample(layout) / stopFeed(): the tab\'s example control')
  if (fapi.playExample && fapi.stopFeed) {
    let t = 1000
    /** n animation frames, each `dt` ms after the last (the browser passes the frame's timestamp). */
    const frames = (n: number, dt = 50) => { for (let i = 0; i < n; i++) { const q = rafQueue; rafQueue = new Map(); t += dt; for (const cb of q.values()) (cb as (ts: number) => void)(t) } }
    engine.setActive(true); resize(1134, 864, 1)
    fapi.playExample(layout)
    const d0 = canvas.ctx.draws.length
    frames(401)                                        // the first frame starts the clock; then 20 s at 50 ms per frame
    const mid = snap()
    const figDraws = canvas.ctx.draws.slice(d0).filter(d => d.src.width === 16 && d.src.height === 16)
    const offGrid = figDraws.filter(d => !Number.isInteger(d.x) || !Number.isInteger(d.y) || d.w !== 16 * mid.deviceScale || d.h !== 16 * mid.deviceScale)
    ok(mid.feed === 'example' && mid.workers > 0 && mid.figuresDrawn > 0 && Math.abs(mid.feedSeconds - 20) < 1e-6,
      `the example plays on one sim clock: after 400 frames of 50 ms it is at ${mid.feedSeconds.toFixed(2)} s, ${mid.workers} workers on screen, ${mid.figuresDrawn} figures drawn in the last frame`)
    ok(figDraws.length > 100 && offGrid.length === 0,
      `${figDraws.length} figure frames blitted, each at whole device pixels and 16 texels × the integer scale ${mid.deviceScale}: exact texel blocks${offGrid.length ? ` — off the grid: ${offGrid.length}` : ''}`)
    frames(1, 3000)
    ok(Math.abs(snap().feedSeconds - mid.feedSeconds - 0.05) < 1e-6, `a 3 s frame advances the clock by the 50 ms cap only (${(snap().feedSeconds - mid.feedSeconds).toFixed(3)} s)`)
    // hidden: nothing runs and the clock stands still; shown again: it carries on where it was (no rebuild, no jump)
    const before = snap()
    engine.setActive(false); sendResize(canvas, 0, 0, 1)
    frames(100)
    const hidden = snap()
    ok(rafQueue.size === 0 && hidden.feedSeconds === before.feedSeconds && hidden.workers === before.workers && hidden.draws === before.draws,
      `hidden: no frame is scheduled, nothing is drawn, the sim clock stands still at ${hidden.feedSeconds.toFixed(2)} s with ${hidden.workers} workers`)
    engine.setActive(true); sendResize(canvas, 1134, 864, 1)   // shown (the observer repaints; no timestampless frame)
    frames(1, 60_000)
    frames(20)
    const shown = snap()
    ok(Math.abs(shown.feedSeconds - hidden.feedSeconds - 1) < 1e-6 && shown.prerenders === 1 && shown.engines === 2 && shown.feed === 'example',
      `shown again after a minute away: it goes on from ${hidden.feedSeconds.toFixed(2)} s to ${shown.feedSeconds.toFixed(2)} s in 20 frames (no catch-up jump, no rebuild)`)
    let seen = shown.workers
    // object states (plan §4.4; live/objects.ts): every state the engine derives is BLITTED, as one of that state's own
    // cached frames, exactly over its object tile (16 texels × the integer scale at the camera offset); no other state
    // frame is drawn; sampled over the example until it ends
    {
      const stateCanvases = new Map<unknown, string>()
      for (const a of STATE_ART) for (const c of stateFrames(a.tile, a.state)) stateCanvases.set(c, `${a.tile}|${a.state}`)
      const frameSet = (name: string) => {
        const [tile, state] = name.split('@')[0].split('|')
        return new Set<unknown>(stateFrames(tile as ObjectTileKind, state))
      }
      const kinds = new Set<string>()
      let sampled = 0, matched = 0
      const misses: string[] = []
      const stray: string[] = []
      for (let i = 0; i < 160 && snap().feed === 'example'; i++) {
        frames(9)
        const d0 = canvas.ctx.draws.length
        frames(1)
        const d = snap()
        seen = Math.max(seen, d.workers)
        const drawn = canvas.ctx.draws.slice(d0)
        const s = d.deviceScale, [ox, oy] = d.offset
        const used = new Set<number>()
        for (const name of d.objectStates) {
          sampled++
          kinds.add(name.split('@')[0])
          const set = frameSet(name)
          const [x, y] = name.split('@')[1].split(',').map(Number)
          const k = drawn.findIndex((r, j) => !used.has(j) && set.has(r.src) && r.x === ox + x * 16 * s && r.y === oy + y * 16 * s && r.w === 16 * s && r.h === 16 * s)
          if (k < 0) misses.push(`${name} at ${d.feedSeconds.toFixed(1)} s`)
          else { used.add(k); matched++ }
        }
        drawn.forEach((r, j) => { if (!used.has(j) && stateCanvases.has(r.src)) stray.push(`${stateCanvases.get(r.src)} at ${d.feedSeconds.toFixed(1)} s`) })
      }
      const want = ['fileCabinet|drawerOpen', 'fileCabinet|folderOut', 'historyShelf|ledgerOut', 'lectern|compare', 'pcDesk|on', 'pcDesk|typing',
        'benchTerminal|running', 'benchTerminal|output', 'frontDeskW|onPhone', 'printer|printing', 'frontDeskE|handIn', 'frontDeskW|signing']
      const absent = want.filter(k => !kinds.has(k))
      ok(sampled > 50 && misses.length === 0 && stray.length === 0 && absent.length === 0,
        `object states drawn: ${matched} of ${sampled} derived states blitted as their own frame over their tile in sampled frames of the example (${kinds.size} kinds, among them ${want.length} the example must show)` +
        `${misses.length ? ` — not drawn: ${misses.slice(0, 3).join('; ')}` : ''}${stray.length ? ` — drawn without being derived: ${stray.slice(0, 3).join('; ')}` : ''}${absent.length ? ` — never seen: ${absent.join(', ')}` : ''}`)
    }
    // to the end: everyone leaves and the feed ends by itself
    for (let i = 0; i < 80 && snap().feed === 'example'; i++) { frames(50); seen = Math.max(seen, snap().workers) }
    const end = snap()
    ok(end.feed === 'none' && end.workers === 0 && seen >= 4,
      `the example ends by itself (feed ${end.feed}, ${end.workers} workers, up to ${seen} on screen at once): every worker left`)
    // stop mid-way, and destroy while playing: everything goes
    fapi.playExample(layout)
    frames(301)
    const playing = snap().workers
    fapi.stopFeed()
    flush()
    ok(playing > 0 && snap().workers === 0 && snap().feed === 'none', `stopFeed(): the ${playing} workers are gone at once, no feed`)
  }
}

ok(st().engines === 2 && st().prerenders === 1 && st().workers === 0, `two engines in this check, pre-rendered once, zero workers (engines ${st().engines}, prerenders ${st().prerenders})`)
engine.destroy()
ok(canvas.listeners.size === 0 && !roByCanvas.has(canvas), 'destroy() removes every listener and the observer')

// ── the tab's DOM colours: WCAG AA in the worst case ───────────────────────────────────────────────────────────
console.log('WORKER OFFICE tab colours')
{
  const theme = await import('../src/components/office/workerOfficeTheme.ts').catch(() => null) as
    { WO_TEXT_ON?: readonly (readonly [string, string, string])[] } | null
  ok(!!theme?.WO_TEXT_ON?.length, 'workerOfficeTheme.ts lists every text colour of the tab with its background')
  const parse = (c: string): [number, number, number, number] => {
    const h = /^#([0-9a-f]{6})$/i.exec(c)
    if (h) { const n = parseInt(h[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1] }
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c)
    if (!m) throw new Error(`colour ${c}`)
    return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]
  }
  const over = (c: [number, number, number, number], under: number[]) => [0, 1, 2].map(i => c[i] * c[3] + under[i] * (1 - c[3]))
  const lum = (rgb: number[]) => {
    const l = rgb.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
  }
  const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  for (const [what, text, bg] of theme?.WO_TEXT_ON ?? []) {
    // translucent backgrounds: the worst case is what lies under them; check over white AND over the app's near-black
    const worst = Math.min(...[[255, 255, 255], [6, 8, 16]].map(under => ratio(over(parse(text), over(parse(bg), under)), over(parse(bg), under))))
    ok(worst >= 4.5, `${what}: ${text} on ${bg} — ${worst.toFixed(2)}:1 in the worst case (AA needs 4.5)`)
  }
  const tsx = readFileSync(file('../src/components/office/WorkerOffice.tsx'), 'utf8').replace(/\/\/.*$/gm, '')
  const literals = tsx.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []
  ok(literals.length === 0, `WorkerOffice.tsx takes every colour from workerOfficeTheme.ts (colour literals in it: ${literals.length ? literals.join(' ') : 'none'})`)
}

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS (recording canvas stub; the pixels themselves are checked by the visual check)')
