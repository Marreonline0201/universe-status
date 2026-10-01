// Worker office ART check (plan §6.2 tests, step 2 pass 1: the vertical slice). Run: node scripts/worker-office-art-check.ts
// (Node's built-in TypeScript support, as the other worker-office checks). Node strips the types without checking
// them; the worker-office checks are typechecked with node node_modules/typescript/bin/tsc -p tsconfig.scripts.json.
//
// Real pixels, no browser: the art is drawn on scripts/lib/pixel-canvas.ts, a software canvas. Everything the plan
// asks for is checked against lists written HERE from the plan (not read from the modules under test), and every
// check is shown able to fail by a planted mutant run through the same code path:
//   A. legend: every legend character maps to TileKinds with art — ground (walls, finishes, door base, mat, planter,
//      street), real furniture (pass 1, the slice) or a step-1 placeholder; the placeholder kinds are EXACTLY plan
//      §6's pass-2 list, and no slice kind falls back to one;                                   mutant: drop one tile's art
//   B. states: every slice state named in plan §2 (and §4.4 / §4.5 / §5.3 where they name more) has an image key —
//      a cached `tile|state|frame` image or a layer drawn from data — on a tile of its own kind;
//      mutants: drop a cached state, drop a data layer
//      bases: each state is drawn over the base this file expects (plan §4.4: in-call art on the presence state that
//      stays on), and every base chain resolves;                        mutants: an unknown base, a two-state loop
//      VISIBLE: composited over its furniture tile and its base chain, every cached state changes at least one texel
//      in at least one phase, for every variant pairing a worker can show (variant = id hash mod the state's count;
//      blink-off phases may be empty); every data-layer input changes the picture (one more sheet, ticket or magnet,
//      every door slide step), except a flip0 magnet, which is edge-on by design (the empty socket shows);
//      mutants: a state that draws nothing, one that repaints the tile in its own colours, a whole kind blanked
//   C. the drawing rule (plan §2): every state image is exactly 16×16, drawing it into a margin spills nothing outside
//      the tile, and no pixel lies in the covered zone (rows 10-15; rows 7-9 in columns 10-15); data layers are held
//      to the same rule per tile, the walk-through front door only to its own two tiles, over EVERY input (counts
//      0..cap+1, every magnet state at every count, every whole-texel door slide), not just the sheet's sample;
//      mutants: a pixel at (3,12) and at (12,8) must fail; near misses (9,8) and (12,6) must pass; a spill must fail;
//      an IN tray that strays into the covered zone only when it holds 2 tickets must fail
//   D. base art never depends on position: the REAL pre-render (prerenderOffice under the software canvas) is
//      compared block by block over every instance of every furniture tile kind, each block equals the kind's cached
//      tile, and each kind drawn at two other offsets is identical;          mutant: art keyed off the tile's x parity
//   E. north-facing backrests are drawn in rows 8-15, and seat + backrest is the whole seat tile;
//      mutant: a backrest pixel on row 7
//   F. no contact shadow under seats: no seat casts one in the pre-render (the floor south of every chair is the bare
//      finish, while south of a lectern it is not), and every seated pose draws none (props.ts HAND);
//   G. props: the slice's 8 props, every view drawn; every pose of the hand table (plan §2 frames + assets.ts) holds
//      every prop view inside the 16×16 figure cell. PROVISIONAL: the anchors are measured on today's assets.ts
//      figure, whose look the owner has not settled; they and this section are re-derived with the new figure;
//   H. icons: every activity the real classifier (office/observer/classify.mjs) sends to a slice object has an icon;
//      every icon is a valid 7×7 map, distinct, and readable on the dark bubble (contrast measured);
//   I. pixel-art discipline: all furniture, state, prop and icon art is drawn on STRICT canvases (whole texels, solid
//      colours: a gradient, a path, text or a fractional rect throws); every image is rendered once (caches);
//   J. the renderer's access (plan §4.8): stateFrames(tile, state) is the same array of the cached canvases every
//      time (indexed per frame, no key string), props come back cached; statePhase keeps every animated state in
//      range at its nominal rate, and six workers with their own rate and phase offset are never in lockstep; the
//      loops a worker's hands drive run at the nominal 4 fps of plan §4.8's 3.4-4.6;  mutant: a phase clock that
//      ignores the worker
//   K. in/out board magnets (plan §2 row 2): a magnet is 1 px, so every inked magnet state is measured on the
//      composited board at 3:1 or more against its empty socket and the board beside it;
//      mutants: the old status cyan and the old steel back
//   L. the front desk's onPhone: where the handset lay, the picture changes at 3:1 or more (the cradle shows empty);
//   M. palette discipline (palette.ts header): the art files hold no colour literal outside comments and derive no
//      shade; every palette token is used;        mutants: a planted literal, a planted derivation, an unused token;
//      a literal inside a comment passes
// A human-readable sheet and the pre-rendered map go to scripts/out/ (git-ignored): worker-office-art-sheet.png (each
// state over its floor, its furniture tile and its base chain, as a worker shows it: stateLayer.ts composeState),
// worker-office-art-map.png; and worker-office-art-pixels.json, every furniture tile, state image, prop and icon as
// RGBA, which the browser visual check compares with what Chrome draws. Exits 1 on any failure.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPixelDom, setStrict, pixelCanvas, writePng, parseColor, PixelCanvas, type PixelCtx } from './lib/pixel-canvas.ts'

const made = installPixelDom()
setStrict(true)   // every art cache below is filled on strict canvases (section I)
const L = await import('../src/worker-office/map/loadMap.ts')
const F = await import('../src/worker-office/render/furniture.ts')
const S = await import('../src/worker-office/render/stateLayer.ts')
const P = await import('../src/worker-office/render/props.ts')
const I = await import('../src/worker-office/render/icons.ts')
const pre = await import('../src/worker-office/render/prerender.ts')
const floors = await import('../src/worker-office/render/floors.ts')
const C = await import('../office/observer/classify.mjs') as unknown as {
  classify(name: string, inp: unknown, curKind?: string | null): [string, string | null]
  ACTIVITY_ID: Map<string, string>
}

type Canvas = PixelCanvas
type Ctx = CanvasRenderingContext2D
const asCanvas = (c: unknown) => c as Canvas
const asCtx = (g: PixelCtx) => g as unknown as Ctx

let failures = 0
const ok = (cond: boolean, what: string) => { if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}`) } }
const T = 16
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const raw = JSON.parse(readFileSync(`${ROOT}src/worker-office/data/floorplan.json`, 'utf8'))
const map = L.loadMap(raw)
type JObj = { id: string; kind: string; char: string; x: number; y: number; w: number; h: number; facing: string; tileKinds: string[] }
const objects = raw.objects as JObj[]
const tilesOf = (kind: string) => new Set(objects.filter(o => o.kind === kind).flatMap(o => o.tileKinds))

// ── the plan, written here ───────────────────────────────────────────────────────────────────────────────────────
/** Plan §6 "Slice objects" (and the task): shell, door, front desk, printer, in/out board, cabinets, history shelves,
 *  lecterns, benches, desks (+ task chairs), bookshelf, card catalog, reading places (ledge, table + its chairs),
 *  lounge (sofa, armchairs). */
const SLICE = ['frontDoor', 'frontDesk', 'printer', 'inOutBoard', 'fileCabinet', 'historyShelf', 'lectern', 'benchTerminal',
  'pcDesk', 'taskChairN', 'bookshelf', 'cardCatalog', 'readingLedge', 'readingTable', 'woodChairN', 'sofaN', 'armchairN']
/** Plan §6 pass 2: kanban, meeting, pigeonholes, post shelf, copier, shredder, manuals, kitchen (§2 rows 24-27),
 *  decor (§2 rows 21, 30-40: racks are "decor with live LEDs"), clock, notice board. */
const PASS_2 = ['kanbanBoard', 'meetingTable', 'pigeonholes', 'postShelf', 'copier', 'shredder', 'manualsShelf',
  'fridge', 'sink', 'espressoMachine', 'waterCooler', 'serverRack', 'receptionChair', 'ups', 'plant', 'coatStand',
  'floorLamp', 'visitorChair', 'wallClock', 'noticeBoard']
/** Ground objects (map border and entrance), drawn by floors.ts, never furniture. */
const GROUND_OBJECTS = ['frontDoor', 'doormat', 'planter', 'street']
/** Plan §2's slice states, with where the plan names them. */
const REQUIRED: readonly (readonly [string, string, string])[] = [
  ['frontDoor', 'closed', '§2 row 1'], ['frontDoor', 'open', '§2 row 1 "open/closing = walker presence"'], ['frontDoor', 'closing', '§2 row 1'],
  ['inOutBoard', 'magnets', '§2 row 2'], ['inOutBoard', 'flip', '§2 row 2'],
  ['fileCabinet', 'drawerOpen', '§2 row 3'], ['fileCabinet', 'folderOut', '§2 row 3'], ['fileCabinet', 'leafing', '§2 row 3'], ['fileCabinet', 'scanning', '§2 row 3'],
  ['historyShelf', 'ledgerOut', '§2 row 4'], ['historyShelf', 'leafing', '§2 row 4'], ['historyShelf', 'writing', '§2 row 4'], ['historyShelf', 'box', '§2 row 4 "stash = box", §4.4'],
  ['lectern', 'lampOn', '§2 row 5'], ['lectern', 'compare', '§2 row 5'], ['lectern', 'turning', '§2 row 5'],
  ['bookshelf', 'bookOut', '§2 row 6'],
  ['readingLedge', 'spread', '§2 row 7'],
  ['cardCatalog', 'drawerOut', '§2 row 8'], ['cardCatalog', 'flipping', '§2 row 8'],
  ['readingTable', 'lampOn', '§2 row 10'], ['readingTable', 'openBook', '§2 row 10'],
  ['pcDesk', 'on', '§2 row 11'], ['pcDesk', 'typing', '§2 row 11'], ['pcDesk', 'error', '§2 row 11'], ['pcDesk', 'ok', '§4.5 "bench and desk call results"'],
  ['benchTerminal', 'ready', '§2 row 12'], ['benchTerminal', 'running', '§2 row 12'], ['benchTerminal', 'ok', '§2 row 12'],
  ['benchTerminal', 'fail', '§2 row 12'], ['benchTerminal', 'stopped', '§2 row 12'], ['benchTerminal', 'watching', '§2 row 12'],
  ['printer', 'printing', '§2 row 18'], ['printer', 'done', '§2 row 18'],
  ['frontDesk', 'handIn', '§2 row 20'], ['frontDesk', 'signing', '§2 row 20'], ['frontDesk', 'ticket', '§2 row 20'],
  ['frontDesk', 'onPhone', '§2 row 20'], ['frontDesk', 'outStack', '§2 row 20'], ['frontDesk', 'inTray', '§5.3 OBJECTS{… inTray}'],
]
/** Plan §2 rows 22-23 ("none: the worker holds a pager") and 28-29 ("no state"). */
const STATELESS = ['sofaN', 'armchairN', 'taskChairN', 'woodChairN']
/** Plan §2 "Props" for the slice. */
const SLICE_PROPS = ['folder', 'ledger', 'book', 'callSlip', 'printout', 'form', 'ticket', 'pager']
/** Plan §2 "New figure frames" + today's frames (assets.ts CharFrame); seated ones per their names. */
const PLAN_POSES = ['stand', 'walkD0', 'walkD1', 'walkU0', 'walkU1', 'walkL0', 'walkL1', 'walkR0', 'walkR1', 'sit', 'type0', 'type1',
  'standU', 'useU0', 'useU1', 'reachU', 'readU', 'watchU', 'sitBack', 'readD', 'ponderD', 'armsD', 'standL', 'standR',
  'passD', 'passU', 'passL', 'passR', 'sitBackLean', 'sitBackNotepad']
const SEATED_POSES = ['sit', 'type0', 'type1', 'sitBack', 'sitBackLean', 'sitBackNotepad']

// ── pixel helpers ────────────────────────────────────────────────────────────────────────────────────────────────
/** Plan §2: a standing worker covers rows 10-15 of the object tile; its status dot sits at column 13, row 10. */
const covered = (x: number, y: number) => y >= 10 || (y >= 7 && x >= 10)
function zoneHits(c: Canvas, ox: number, oy: number): string[] {
  const out: string[] = []
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (c.at(ox + x, oy + y)[3] > 0 && covered(x, y)) out.push(`(${x},${y})`)
  return out
}
function spill(c: Canvas, box: { x: number; y: number; w: number; h: number }): number {
  let n = 0
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (c.at(x, y)[3] > 0 && (x < box.x || y < box.y || x >= box.x + box.w || y >= box.y + box.h)) n++
  }
  return n
}
const M = 16   // margin around an image drawn for the spill test
function withMargin(w: number, h: number, draw: (g: Ctx) => void): Canvas {
  const [c, g] = pixelCanvas(w + 2 * M, h + 2 * M, { strict: true })
  g.translate(M, M)
  draw(asCtx(g))
  return c
}
function block(c: Canvas, ox: number, oy: number, w = T, h = T): string {
  const parts: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) parts.push(...c.at(ox + x, oy + y))
  return Buffer.from(parts).toString('base64')
}
const opaqueCount = (c: Canvas) => { let n = 0; for (let i = 3; i < c.data.length; i += 4) if (c.data[i] > 0) n++; return n }
const copyOf = (c: Canvas) => { const [d] = pixelCanvas(c.width, c.height); d.data.set(c.data); return d }
const setPx = (c: Canvas, x: number, y: number) => c.data.set([255, 0, 255, 255], (y * c.width + x) * 4)
const sameData = (a: Canvas, b: Canvas) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i])
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b
/** WCAG 2 relative luminance of an sRGB colour (0..255 channels), and the contrast ratio of two. */
const luminance = (rgb: readonly number[]) => {
  const l = rgb.slice(0, 3).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
const contrast = (a: readonly number[], b: readonly number[]) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
/** A canvas `tiles` tiles wide with each layer stacked at the origin: a canvas, or a draw call. Not strict: it only
 *  stacks images the strict caches drew (and the step-1 door base). */
function stack(tiles: number, layers: readonly (Canvas | ((g: Ctx) => void))[]): Canvas {
  const [c, g] = pixelCanvas(tiles * T, T, { strict: false })
  for (const l of layers) { if (typeof l === 'function') l(asCtx(g)); else g.drawImage(l, 0, 0) }
  return c
}

// ── I. build every art cache on strict canvases ──────────────────────────────────────────────────────────────────
console.log('I. pixel-art discipline (strict canvases) and caches')
const strictErrors: string[] = []
const tryDraw = (what: string, f: () => void) => { try { f() } catch (e) { strictErrors.push(`${what}: ${String(e).slice(0, 160)}`) } }
const artKinds = Object.keys(F.FURNITURE_ART) as (keyof typeof F.FURNITURE_ART)[]
for (const k of artKinds) tryDraw(`tile ${k}`, () => F.furnitureTile(k))
const keys = S.stateKeys()
for (const k of keys) tryDraw(`state ${k}`, () => S.stateImage(k))
let propImages = 0
for (const id of P.PROP_IDS) for (const v of ['side', 'held', 'tucked', 'belt'] as const) {
  if (P.PROP_ART[id][v]) tryDraw(`prop ${id}|${v}`, () => { P.propImage(id, v); propImages++ })
}
for (const id of I.ICON_IDS) tryDraw(`icon ${id}`, () => I.iconImage(id))
for (const d of S.DATA_LAYERS) tryDraw(`layer ${d.kind}|${d.state}`, () => withMargin(d.tiles.length * T, T, d.sample))
ok(strictErrors.length === 0, `${artKinds.length} furniture tiles, ${keys.length} state images, ${propImages} prop images, ${I.ICON_IDS.length} icons and ${S.DATA_LAYERS.length} data layers drawn with whole-texel rects in solid colours${strictErrors.length ? ` — ${strictErrors.slice(0, 3).join(' | ')}` : ''}`)
{
  let threw = false
  try { const [, g] = pixelCanvas(16, 16, { strict: true }); g.fillRect(0.5, 0, 1, 1) } catch { threw = true }
  ok(threw, 'the strict canvas rejects a fractional rect (the discipline check can fail)')
}
ok(F.furnitureRenders() === artKinds.length && S.stateRenders() === keys.length, `rendered once each: ${F.furnitureRenders()} furniture tiles, ${S.stateRenders()} state images`)
ok(F.furnitureTile(artKinds[0]) === F.furnitureTile(artKinds[0]) && S.stateImage(keys[0]) === S.stateImage(keys[0]) && S.stateRenders() === keys.length,
  'asking again returns the cached canvas (no re-render)')
ok(new Set(keys).size === keys.length, `${keys.length} state keys, all distinct`)

// ── A. legend coverage ───────────────────────────────────────────────────────────────────────────────────────────
console.log('A. every legend character maps to TileKinds with art')
function coverage(art: ReadonlySet<string>) {
  const placeholder = new Set<string>(), sliceGaps: string[] = [], unmapped: string[] = []
  const byKind: Record<string, 'ground' | 'furniture' | 'placeholder'> = {}
  for (const ch of Object.keys(raw.legend)) {
    if (Object.hasOwn(L.STRUCTURE_KIND_BY_CHAR, ch)) continue
    const objs = objects.filter(o => o.char === ch)
    if (objs.length === 0 || objs.some(o => o.tileKinds.length === 0)) unmapped.push(ch)
    for (const o of objs) for (const t of o.tileKinds) {
      if (!(L.OBJECT_TILE_KINDS as readonly string[]).includes(t)) unmapped.push(`${ch}:${t}`)
      if (GROUND_OBJECTS.includes(o.kind)) { byKind[t] = 'ground'; continue }
      if (art.has(t)) byKind[t] = 'furniture'
      else { byKind[t] = 'placeholder'; placeholder.add(o.kind) }
    }
  }
  for (const k of SLICE) for (const t of tilesOf(k)) if (!GROUND_OBJECTS.includes(k) && !art.has(t)) sliceGaps.push(`${k}:${t}`)
  return { placeholder, sliceGaps, unmapped, byKind }
}
const realArt = new Set(artKinds as string[])
const cov = coverage(realArt)
const structureChars = Object.keys(raw.legend).filter(ch => Object.hasOwn(L.STRUCTURE_KIND_BY_CHAR, ch))
ok(structureChars.length === 9 && structureChars.every(ch => typeof (L.STRUCTURE_KIND_BY_CHAR as Record<string, string>)[ch] === 'string'),
  `${structureChars.length} shell characters map to ground TileKinds (${structureChars.map(ch => `${ch}=${(L.STRUCTURE_KIND_BY_CHAR as Record<string, string>)[ch]}`).join(' ')}): the render check proves them tile by tile`)
const counts = { ground: 0, furniture: 0, placeholder: 0 }
for (const v of Object.values(cov.byKind)) counts[v]++
ok(cov.unmapped.length === 0 && Object.keys(raw.legend).length - structureChars.length === new Set(objects.map(o => o.char)).size,
  `${Object.keys(raw.legend).length - structureChars.length} object characters map to ${Object.keys(cov.byKind).length} TileKinds: ${counts.furniture} real furniture, ${counts.ground} ground, ${counts.placeholder} pass-2 placeholders${cov.unmapped.length ? ` — unmapped ${cov.unmapped.join(' ')}` : ''}`)
const placeholderKinds = [...cov.placeholder].sort()
ok(JSON.stringify(placeholderKinds) === JSON.stringify([...PASS_2].sort()),
  `the kinds still on placeholders are exactly plan §6's pass 2 (${placeholderKinds.length}: ${placeholderKinds.join(', ')})`)
ok(cov.sliceGaps.length === 0, `every slice kind has real art on all its tiles (${SLICE.filter(k => !GROUND_OBJECTS.includes(k)).length} kinds)${cov.sliceGaps.length ? ` — missing ${cov.sliceGaps.join(', ')}` : ''}`)
ok(JSON.stringify([...F.PASS_1_KINDS].sort()) === JSON.stringify([...SLICE].sort()) && JSON.stringify([...F.PASS_2_KINDS].sort()) === JSON.stringify([...PASS_2].sort()),
  'furniture.ts PASS_1_KINDS / PASS_2_KINDS = the plan lists above')
ok(artKinds.every(k => (L.OBJECT_TILE_KINDS as readonly string[]).includes(k)) && artKinds.every(k => cov.byKind[k] === 'furniture'),
  `every art key is a placed TileKind (${artKinds.length})`)
ok(artKinds.every(k => opaqueCount(asCanvas(F.furnitureTile(k))) >= 24), 'every furniture tile paints at least 24 texels (nothing blank)')
{
  const mut = new Set(realArt); mut.delete('lectern')
  const m = coverage(mut)
  ok(m.sliceGaps.includes('lectern:lectern') && m.placeholder.has('lectern'), 'MUTANT lectern art removed: caught (the slice check fails, lectern falls to a placeholder)')
}

// ── B. required states ───────────────────────────────────────────────────────────────────────────────────────────
console.log('B. every slice state of plan §2 has an image key')
function missingStates(art: readonly { kind: string; state: string; tile: string; variants: number; phases: number }[], layers: readonly { kind: string; state: string }[]) {
  const have = new Set<string>()
  for (const a of art) if (tilesOf(a.kind).has(a.tile) && a.variants * a.phases >= 1) have.add(`${a.kind}|${a.state}`)
  for (const d of layers) have.add(`${d.kind}|${d.state}`)
  return REQUIRED.filter(([k, s]) => !have.has(`${k}|${s}`)).map(([k, s, w]) => `${k}|${s} (${w})`)
}
const miss = missingStates(S.STATE_ART, S.DATA_LAYERS)
const cachedReq = REQUIRED.filter(([k, s]) => S.STATE_ART.some(a => a.kind === k && a.state === s))
ok(miss.length === 0, `${REQUIRED.length} required states present: ${cachedReq.length} as cached images, ${REQUIRED.length - cachedReq.length} as layers drawn from data${miss.length ? ` — missing ${miss.join(', ')}` : ''}`)
const keyless = cachedReq.filter(([k, s]) => !S.STATE_ART.filter(a => a.kind === k && a.state === s).every(a => keys.includes(S.stateKey(a.tile, a.state, 0))))
ok(keyless.length === 0, 'each cached state has its keys `tile|state|frame` (frame 0 at least) in stateKeys()')
const misplaced = S.STATE_ART.filter(a => !tilesOf(a.kind).has(a.tile))
ok(misplaced.length === 0, `every state is drawn on a tile of its own kind${misplaced.length ? ` — ${misplaced.map(a => `${a.kind}|${a.state} on ${a.tile}`).join(', ')}` : ''}`)
const stray = [...S.STATE_ART, ...S.DATA_LAYERS].filter(a => STATELESS.includes(a.kind))
ok(stray.length === 0, `no state art on the seats plan §2 gives none (${STATELESS.join(', ')})`)
{
  const m1 = missingStates(S.STATE_ART.filter(a => !(a.kind === 'lectern' && a.state === 'turning')), S.DATA_LAYERS)
  const m2 = missingStates(S.STATE_ART, S.DATA_LAYERS.filter(d => d.state !== 'magnets'))
  ok(m1.length === 1 && m1[0].startsWith('lectern|turning') && m2.length === 1 && m2[0].startsWith('inOutBoard|magnets'),
    `MUTANTS a dropped cached state (${m1.join('')}) and a dropped data layer (${m2.join('')}): both caught`)
}

// bases: what each state is drawn over (stateLayer.ts STACKING)
type Art = (typeof S.STATE_ART)[number]
/** A state as the visibility test sees it (a real registry entry, or a mutant). */
interface ArtLike { readonly tile: string; readonly state: string; readonly variants: number; readonly phases: number; readonly draw: Art['draw'] }
/** Plan §4.4 (and the step-2 review): in-call and call-end art sits on the presence state that stays on through the
 *  visit, reading at a shelf on the reader's gap. Every state not listed has no base. Keyed kind|state. */
const EXPECTED_BASE: Readonly<Record<string, string>> = {
  'pcDesk|typing': 'on', 'pcDesk|error': 'on', 'pcDesk|ok': 'on',               // §4.4: "the monitor stays on (presence)"
  'fileCabinet|folderOut': 'drawerOpen', 'fileCabinet|leafing': 'drawerOpen', 'fileCabinet|scanning': 'drawerOpen',
  'cardCatalog|flipping': 'drawerOut',
  'lectern|compare': 'lampOn', 'lectern|turning': 'compare',                     // §4.4: "two ledgers open, lamp on"
  'readingTable|openBook': 'lampOn',                                              // stage 2: the book closes, the lamp stays
  'historyShelf|leafing': 'ledgerOut', 'historyShelf|writing': 'ledgerOut',      // read at the shelf after the pull
  'benchTerminal|stopped': 'ready', 'benchTerminal|watching': 'ready',           // a lamp lights over the idle screen
}
const baseOf = (a: Art): string | null => (a as { base?: string | null }).base ?? null
const wrongBase = S.STATE_ART.filter(a => baseOf(a) !== (EXPECTED_BASE[`${a.kind}|${a.state}`] ?? null))
ok(wrongBase.length === 0, `every state sits on the base plan §4.4 gives it (${Object.keys(EXPECTED_BASE).length} with a base, the rest none)${wrongBase.length ? ` — wrong: ${wrongBase.slice(0, 6).map(a => `${a.tile}|${a.state} on ${baseOf(a)}`).join(', ')}` : ''}`)
const hasChains = typeof S.baseChain === 'function'
/** The base chain of a registry state (deepest first), or [] where the module has none. */
const chainOf = (a: Art): Art[] => (hasChains ? S.baseChain(a) : [])
{
  const broken: string[] = []
  if (hasChains) for (const a of S.STATE_ART) { try { S.baseChain(a) } catch (e) { broken.push(String(e).slice(0, 120)) } }
  const throws = (a: Art) => { try { S.baseChain(a); return false } catch { return true } }
  const turning = S.stateArt('lectern', 'turning'), lampOn = S.stateArt('lectern', 'lampOn')
  ok(hasChains && broken.length === 0 && !!turning && !!lampOn && throws({ ...turning, base: 'nope' } as Art) && throws({ ...lampOn, base: 'compare' } as Art),
    `every base chain resolves (stateLayer.ts baseChain)${hasChains ? '' : ' — baseChain missing'}${broken.length ? ` — ${broken.join('; ')}` : ''}; MUTANTS an unknown base and a two-state loop (lampOn over compare over lampOn): both throw`)
}

// VISIBLE: each cached state changes the picture of its tile + base chain
const cached = (x: ArtLike, f: number) => asCanvas(S.stateImage(S.stateKey(x.tile as never, x.state, f)))
/** A mutant's frame, drawn fresh on a strict canvas. */
const drawn = (x: ArtLike, f: number) => { const [c, g] = pixelCanvas(T, T, { strict: true }); x.draw(asCtx(g), Math.floor(f / x.phases), f % x.phases); return c }
/** The pairings under which no phase of `a` changes its tile + base chain. A worker shows variant hash mod count of
 *  every state (stateLayer.ts header), so the pairings are the hashes 0 .. lcm(counts) - 1; the bases' own phases
 *  run under the overlay's, so every base phase is tried. Blink-off phases may be empty: one changing phase is enough. */
function invisible(a: ArtLike, chain: readonly ArtLike[], img: (x: ArtLike, f: number) => Canvas): string[] {
  const tile = asCanvas(F.furnitureTile(a.tile as never))
  const L = chain.reduce((m, b) => lcm(m, b.variants), a.variants)
  let combos: number[][] = [[]]
  for (const b of chain) combos = combos.flatMap(c => range(b.phases).map(p => [...c, p]))
  const bad: string[] = []
  for (let h = 0; h < L; h++) for (const phases of combos) {
    const under = stack(1, [tile, ...chain.map((b, i) => img(b, (h % b.variants) * b.phases + phases[i]))])
    const v = h % a.variants
    if (!range(a.phases).some(p => !sameData(stack(1, [under, img(a, v * a.phases + p)]), under))) {
      bad.push(`${a.tile}|${a.state} variant ${v}${chain.length ? ` over ${chain.map((b, i) => `${b.state}|${(h % b.variants) * b.phases + phases[i]}`).join(' + ')}` : ''}`)
    }
  }
  return bad
}
{
  const bad = S.STATE_ART.flatMap(a => invisible(a, chainOf(a), cached))
  const pairings = S.STATE_ART.reduce((s, a) => s + chainOf(a).reduce((m, b) => lcm(m, b.variants), a.variants), 0)
  ok(bad.length === 0, `VISIBLE: every one of the ${S.STATE_ART.length} cached states changes its tile + base chain in at least one phase, under all ${pairings} variant pairings a worker can show${bad.length ? ` — no change: ${bad.slice(0, 4).join('; ')}` : ''}`)
  // mutants through the same function: a state that draws nothing (lectern turning), one that repaints the tile in
  // its own colours (the lectern's lamp: lampOn copies the lamp shade from the tile), the whole file cabinet blanked
  const lecternTurning = S.stateArt('lectern', 'turning')!
  const blank: ArtLike = { tile: 'lectern', state: 'turning', variants: 1, phases: 2, draw: () => {} }
  const repaint: ArtLike = { tile: 'lectern', state: 'lampOn', variants: 1, phases: 1, draw: g => g.drawImage(F.furnitureTile('lectern'), 8, 0, 8, 4, 8, 0, 8, 4) }
  const cabinetOpen: ArtLike = { tile: 'fileCabinet', state: 'drawerOpen', variants: 2, phases: 1, draw: () => {} }
  const cabinet: ArtLike[] = [cabinetOpen,
    ...(['folderOut', 'leafing', 'scanning'] as const).map(s => { const r = S.stateArt('fileCabinet', s)!; return { tile: r.tile, state: s, variants: r.variants, phases: r.phases, draw: () => {} } })]
  const mixed = (x: ArtLike, f: number) => (x === blank || x === repaint || cabinet.includes(x) ? drawn(x, f) : cached(x, f))
  const g1 = invisible(blank, chainOf(lecternTurning), mixed).length
  const g2 = invisible(repaint, [], mixed).length
  const g4 = cabinet.filter((x, i) => invisible(x, i === 0 ? [] : [cabinetOpen], mixed).length > 0).length
  ok(g1 > 0 && g2 > 0 && g4 === 4, `MUTANTS a lectern turning that draws nothing, a lampOn that repaints the lamp in the tile's own colours, all four file-cabinet states blanked: caught (${g1 > 0}, ${g2 > 0}, ${g4} of 4)`)
}

// every input of the layers drawn from data (VISIBLE here, the covered zone and spill in C)
const MAGNET_STATES = ['working', 'waiting', 'stale', 'flip0', 'flip1'] as const   // stateLayer.ts MagnetState
const { MAGNET_SLOTS, deskHandset } = await import('../src/worker-office/render/tiles-reception.ts')
const SLIDE_MAX = typeof S.DOOR_SLIDE_MAX === 'number' ? S.DOOR_SLIDE_MAX : 14
const deskUnder = (g: Ctx) => { g.drawImage(F.furnitureTile('frontDeskW'), 0, 0); g.drawImage(F.furnitureTile('frontDeskE'), T, 0) }
const boardUnder = (g: Ctx) => { g.drawImage(F.furnitureTile('inOutBoardW'), 0, 0); g.drawImage(F.furnitureTile('inOutBoardE'), T, 0) }
const doorUnder = (g: Ctx) => { floors.doorBase(g, 'W'); g.save(); g.translate(T, 0); floors.doorBase(g, 'E'); g.restore() }
interface LayerInput { readonly layer: string; readonly n: number; readonly cap: number; readonly under: (g: Ctx) => void; readonly draw: (g: Ctx) => void; readonly walkThrough: boolean }
const counted = (layer: string, cap: number, under: (g: Ctx) => void, draw: (g: Ctx, n: number) => void): LayerInput[] =>
  range(cap + 2).map(n => ({ layer, n, cap, under, draw: (g: Ctx) => draw(g, n), walkThrough: false }))
const LAYER_INPUTS: readonly LayerInput[] = [
  ...counted('frontDesk|outStack', S.OUT_STACK_MAX, deskUnder, (g, n) => S.drawOutStack(g, T, 0, n)),
  ...counted('frontDesk|inTray', S.IN_TRAY_MAX, deskUnder, (g, n) => S.drawInTray(g, T, 0, n)),
  ...MAGNET_STATES.flatMap(s => counted(`inOutBoard|magnets ${s}`, MAGNET_SLOTS.length, boardUnder, (g, n) => S.drawMagnets(g, 0, 0, Array<typeof s>(n).fill(s)))),
  ...range(SLIDE_MAX + 1).map(k => ({ layer: 'frontDoor|leaves', n: k, cap: SLIDE_MAX, under: doorUnder, draw: (g: Ctx) => S.doorLeaves(g, 0, 0, k / SLIDE_MAX), walkThrough: true })),
]
/** Inputs that do not change the picture: a counted layer must change with each item up to its cap and hold still
 *  past it; every door slide step must differ from the bare door base and from the step before. flip0 is exempt
 *  (edge-on: the empty socket shows, stateLayer.ts MagnetState). */
function unseen(inputs: readonly LayerInput[]): string[] {
  const bad: string[] = []
  const pic = (i: LayerInput) => stack(2, [i.under, i.draw])
  for (const i of inputs) {
    if (i.layer.endsWith(' flip0')) continue
    const prev = inputs.find(j => j.layer === i.layer && j.n === i.n - 1)
    const now = pic(i)
    if (i.walkThrough) {
      if (sameData(now, stack(2, [i.under]))) bad.push(`${i.layer} step ${i.n} shows nothing`)
      if (prev && sameData(now, pic(prev))) bad.push(`${i.layer} step ${i.n} = step ${prev.n}`)
    } else if (prev) {
      const same = sameData(now, pic(prev))
      if (i.n <= i.cap && same) bad.push(`${i.layer} n=${i.n} looks like n=${prev.n}`)
      if (i.n > i.cap && !same) bad.push(`${i.layer} n=${i.n} draws past the cap ${i.cap}`)
    }
  }
  return bad
}
{
  const bad = unseen(LAYER_INPUTS)
  ok(bad.length === 0, `VISIBLE: every data-layer input shows — each OUT sheet and IN ticket up to ${S.OUT_STACK_MAX} / ${S.IN_TRAY_MAX}, each magnet of every inked state up to ${MAGNET_SLOTS.length}, each of the door's ${SLIDE_MAX + 1} slide steps — and nothing more is drawn past a cap (flip0 exempt: edge-on)${bad.length ? ` — ${bad.slice(0, 4).join('; ')}` : ''}`)
  const board = stack(2, [boardUnder])
  const socket = (g: Ctx, n: number) => {
    for (const s of MAGNET_SLOTS.slice(0, n)) {
      const x = (s.part === 'E' ? T : 0) + s.x, [r, gr, b, a] = board.at(x, s.y)
      g.fillStyle = `rgba(${r},${gr},${b},${a / 255})`; g.fillRect(x, s.y, 1, 1)
    }
  }
  ok(unseen(counted('inOutBoard|magnets ghost', MAGNET_SLOTS.length, boardUnder, socket)).length > 0, 'MUTANT a magnet painted in its empty socket\'s own colour: caught')
}

// ── C. the covered zone, image size and spill ────────────────────────────────────────────────────────────────────
console.log('C. state art in rows 0-9, clear of columns 10-15 in rows 7-9, inside its tiles')
const sizeBad: string[] = [], spillBad: string[] = [], zoneBad: string[] = [], driftBad: string[] = []
let zoneChecked = 0
for (const a of S.STATE_ART) {
  for (let f = 0; f < a.variants * a.phases; f++) {
    const key = S.stateKey(a.tile, a.state, f)
    const img = asCanvas(S.stateImage(key))
    if (img.width !== T || img.height !== T) sizeBad.push(`${key} ${img.width}×${img.height}`)
    const big = withMargin(T, T, g => a.draw(g, Math.floor(f / a.phases), f % a.phases))
    const n = spill(big, { x: M, y: M, w: T, h: T })
    if (n) spillBad.push(`${key} (${n} px)`)
    if (block(big, M, M) !== block(img, 0, 0)) driftBad.push(key)
    const hits = zoneHits(img, 0, 0)
    if (hits.length) zoneBad.push(`${key} at ${hits.slice(0, 3).join(' ')}`)
    zoneChecked++
  }
}
ok(sizeBad.length === 0, `all ${zoneChecked} cached state images are 16×16 (one tile)${sizeBad.length ? ` — ${sizeBad.slice(0, 3).join(', ')}` : ''}`)
ok(spillBad.length === 0, `drawn into a 16 px margin, none spills outside its tile${spillBad.length ? ` — ${spillBad.slice(0, 3).join(', ')}` : ''}`)
ok(driftBad.length === 0, 'each cached image equals a fresh drawing of its key')
ok(zoneBad.length === 0, `no state pixel in the covered zone (${zoneChecked} images)${zoneBad.length ? ` — ${zoneBad.slice(0, 4).join('; ')}` : ''}`)
let layerTiles = 0
for (const d of S.DATA_LAYERS) {
  const w = d.tiles.length * T
  const big = withMargin(w, T, d.sample)
  const n = spill(big, { x: M, y: M, w, h: T })
  const hits = d.walkThrough ? [] : d.tiles.flatMap((t, i) => zoneHits(big, M + i * T, M).map(h => `${t} ${h}`))
  layerTiles += d.tiles.length
  ok(n === 0 && hits.length === 0 && opaqueCount(big) > 0,
    `data layer ${d.kind}|${d.state}: fullest case (${opaqueCount(big)} px) stays inside its ${d.tiles.length} tiles${d.walkThrough ? ' (walked through: the covered zone does not apply, plan §2 objects are used from the south)' : ', none in the covered zone'}${n ? ` — spills ${n} px` : ''}${hits.length ? ` — ${hits.slice(0, 3).join(' ')}` : ''}`)
}
ok(S.DATA_LAYERS.filter(d => d.walkThrough).every(d => d.kind === 'frontDoor') && S.DATA_LAYERS.some(d => d.walkThrough),
  'only the front door is exempt from the covered zone (by name)')
/** Every input drawn alone into a margin: what spills outside the object's two tiles, and (not for the walked-through
 *  door) what lands in a tile's covered zone. */
function strays(inputs: readonly LayerInput[]): string[] {
  const bad: string[] = []
  for (const i of inputs) {
    const big = withMargin(2 * T, T, i.draw)
    const n = spill(big, { x: M, y: M, w: 2 * T, h: T })
    const hits = i.walkThrough ? [] : [0, 1].flatMap(k => zoneHits(big, M + k * T, M).map(h => `tile ${k} ${h}`))
    if (n || hits.length) bad.push(`${i.layer} n=${i.n}: spills ${n}, covered ${hits.slice(0, 2).join(' ') || 0}`)
  }
  return bad
}
{
  const bad = strays(LAYER_INPUTS)
  const groups = new Set(LAYER_INPUTS.map(i => i.layer.split(' ')[0])).size
  ok(bad.length === 0, `every input of the ${groups} data layers (${LAYER_INPUTS.length}: OUT stack and IN tray 0..cap+1, magnets 0..${MAGNET_SLOTS.length + 1} in each of ${MAGNET_STATES.length} states, door slide 0..${SLIDE_MAX}) stays inside its two tiles, none in the covered zone (the door: walked through)${bad.length ? ` — ${bad.slice(0, 3).join('; ')}` : ''}`)
  // MUTANT (the step-2 review's G3): an IN tray that strays into the covered zone only when it holds 2 tickets — the
  // fullest-case sample (5 tickets) cannot see it, the sweep must
  const g3 = counted('frontDesk|inTray G3', S.IN_TRAY_MAX, deskUnder, (g, n) => { S.drawInTray(g, T, 0, n); if (n === 2) { g.fillStyle = '#ff00ff'; g.fillRect(T + 3, 12, 1, 1) } })
  const sample = withMargin(2 * T, T, g => g3[S.IN_TRAY_MAX].draw(g))
  ok(strays(g3).length === 1 && zoneHits(sample, M + T, M).length === 0, 'MUTANT an IN tray in the covered zone only at 2 tickets: the sweep catches it, the fullest-case sample alone would not')
}
{
  // mutants through the same code path, on copies of a real image
  const base = asCanvas(S.stateImage(S.stateKey('lectern', 'compare', 0)))
  const plant = (x: number, y: number) => { const c = copyOf(base); setPx(c, x, y); return zoneHits(c, 0, 0).length }
  ok(zoneHits(base, 0, 0).length === 0 && plant(3, 12) > 0 && plant(12, 8) > 0, 'MUTANTS a state pixel at (3,12) and at (12,8): both caught')
  ok(plant(9, 8) === 0 && plant(12, 6) === 0, 'near misses (9,8) and (12,6) pass: the zone is exact, not over-broad')
  const spilled = withMargin(T, T, g => { g.fillStyle = '#ff00ff'; g.fillRect(3, 3, 1, 1); g.fillRect(T, 3, 1, 1) })
  ok(spill(spilled, { x: M, y: M, w: T, h: T }) === 1, 'MUTANT a pixel one texel right of the tile: caught as a spill')
}
// the magnet sockets hold at least the measured peak of workers inside (step-2 catalogue: 24)
ok(MAGNET_SLOTS.length >= 24 && new Set(MAGNET_SLOTS.map(s => `${s.part}${s.x},${s.y}`)).size === MAGNET_SLOTS.length,
  `in/out board: ${MAGNET_SLOTS.length} distinct magnet sockets >= the measured peak of 24 workers inside`)

// ── D. base art never depends on position (the real pre-render path) ─────────────────────────────────────────────
console.log('D. base art is identical wherever a kind stands')
setStrict(false)   // the pre-render's light pools are gradients
const madeBefore = made.length
const scene = pre.prerenderOffice(map)
const fresh = made.slice(madeBefore)
const W = map.width, H = map.height
const layer = asCanvas(scene.layer), floorLayer = asCanvas(scene.floorLayer)
const objectLayer = fresh.find(c => c.width === W * T && c.height === H * T && c !== layer && c !== floorLayer)!
ok(!!objectLayer, 'found the pre-render\'s object layer (layer 2)')
const instances = new Map<string, [number, number][]>()
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const k = map.tiles[y][x]
  if (!realArt.has(k)) continue
  if (!instances.has(k)) instances.set(k, [])
  instances.get(k)!.push([x, y])
}
function differingKinds(lay: Canvas): string[] {
  const out: string[] = []
  for (const [k, list] of instances) {
    const first = block(lay, list[0][0] * T, list[0][1] * T)
    if (list.some(([x, y]) => block(lay, x * T, y * T) !== first)) out.push(k)
  }
  return out
}
const multi = [...instances.entries()].filter(([, l]) => l.length > 1)
const diff = differingKinds(objectLayer)
ok(diff.length === 0, `${multi.length} kinds stand in more than one place (${multi.reduce((s, [, l]) => s + l.length, 0)} tiles): every instance identical on the object layer${diff.length ? ` — differ: ${diff.join(', ')}` : ''}`)
const notBlit = [...instances.entries()].filter(([k, list]) => list.some(([x, y]) => block(objectLayer, x * T, y * T) !== block(asCanvas(F.furnitureTile(k as never)), 0, 0)))
ok(notBlit.length === 0, `all ${[...instances.values()].reduce((s, l) => s + l.length, 0)} slice furniture tiles on the object layer are exact copies of their kind's cached tile${notBlit.length ? ` — ${notBlit.map(([k]) => k).join(', ')}` : ''}`)
{
  const drift: string[] = []
  for (const k of artKinds) {
    const [c, g] = pixelCanvas(T * 4, T * 3, { strict: true })
    for (const [ox, oy] of [[0, 0], [37, 23]]) { g.save(); g.translate(ox, oy); F.FURNITURE_ART[k]!(asCtx(g)); g.restore() }
    if (block(c, 0, 0) !== block(c, 37, 23)) drift.push(k)
  }
  ok(drift.length === 0, `every one of the ${artKinds.length} furniture kinds draws the same at (0,0) and (37,23)${drift.length ? ` — ${drift.join(', ')}` : ''}`)
}
{
  // MUTANT: file-cabinet art that keys off the tile's x parity, drawn per instance without the cache
  const [mut, mg] = pixelCanvas(W * T, H * T)
  mut.data.set(objectLayer.data)
  for (const [x, y] of instances.get('fileCabinet')!) {
    mg.clearRect(x * T, y * T, T, T)
    mg.save(); mg.translate(x * T, y * T)
    F.FURNITURE_ART.fileCabinet!(asCtx(mg))
    if ((mg.getTransform().e / T) % 2 === 1) { mg.fillStyle = '#ff00ff'; mg.fillRect(8, 1, 1, 1) }
    mg.restore()
  }
  ok(differingKinds(mut).includes('fileCabinet'), 'MUTANT cabinet art keyed off x parity: caught')
}

// ── E. north-facing backrests ────────────────────────────────────────────────────────────────────────────────────
console.log('E. north-facing backrests in rows 8-15')
const northSeats = objects.filter(o => o.facing === 'N' && ['taskChairN', 'woodChairN', 'sofaN', 'armchairN'].includes(o.kind))
const seatTiles = [...new Set(northSeats.flatMap(o => o.tileKinds))].sort()
ok(seatTiles.length > 0 && seatTiles.every(t => F.SEAT_PARTS[t as never]), `every north-facing seat tile is drawn as seat + backrest (${seatTiles.join(', ')})`)
function backrestRows(draw: (g: Ctx) => void) {
  const [c, g] = pixelCanvas(T, T, { strict: true }); draw(asCtx(g))
  let above = 0, n = 0, top = T
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (c.at(x, y)[3] > 0) { n++; top = Math.min(top, y); if (y < 8) above++ }
  return { above, n, top }
}
for (const t of seatTiles) {
  const parts = F.SEAT_PARTS[t as keyof typeof F.SEAT_PARTS]!
  const r = backrestRows(parts.backrest)
  const [c, g] = pixelCanvas(T, T, { strict: true }); parts.seat(asCtx(g)); parts.backrest(asCtx(g))
  ok(r.above === 0 && r.n >= 30 && r.top <= 9 && block(c, 0, 0) === block(asCanvas(F.furnitureTile(t as never)), 0, 0),
    `${t}: backrest ${r.n} px, top row ${r.top}, none above row 8; seat + backrest = the tile`)
}
{
  const p = F.SEAT_PARTS.taskChairN!
  const r = backrestRows(g => { p.backrest(g); g.fillStyle = '#ff00ff'; g.fillRect(6, 7, 1, 1) })
  ok(r.above === 1, 'MUTANT a backrest pixel on row 7: caught')
}

// ── F. no contact shadow under seats ─────────────────────────────────────────────────────────────────────────────
console.log('F. no contact shadow under seats')
function bareFinish(x: number, y: number): Canvas {
  const z = map.zoneAt(x, y)!
  const [c, g] = pixelCanvas(T, T)
  floors.drawFinish(asCtx(g), floors.finishOf(z.finish), z.floor, floors.variantOf(x, y))
  return c
}
/** rows 0-2, columns 3-15 of the floor tile south of (x, y) (columns 0-2 can carry a wall's east shadow) */
const southStrip = (lay: Canvas, x: number, y: number) => block(lay, (x) * T + 3, (y + 1) * T, T - 3, 3)
const seatObjs = objects.filter(o => F.NO_CONTACT_SHADOW.has(o.kind as never))
const shaded = seatObjs.filter(o => southStrip(floorLayer, o.x, o.y) !== block(bareFinish(o.x, o.y + 1), 3, 0, T - 3, 3))
ok(seatObjs.length === 13 && shaded.length === 0, `the floor south of all ${seatObjs.length} chairs (6 task, 7 wooden) is the bare finish: no seat casts a contact shadow${shaded.length ? ` — shaded under ${shaded.map(o => o.id).join(', ')}` : ''}`)
const lecterns = objects.filter(o => o.kind === 'lectern')
ok(lecterns.length === 2 && lecterns.every(o => southStrip(floorLayer, o.x, o.y) !== block(bareFinish(o.x, o.y + 1), 3, 0, T - 3, 3)),
  'control: south of both lecterns (low furniture) the floor IS shaded — the probe can see a contact shadow')
const seatedBad = (P.POSES as readonly string[]).filter(p => P.drawsContactShadow(p as never) === SEATED_POSES.includes(p))
ok(seatedBad.length === 0, `plan §6.2: the ${SEATED_POSES.length} seated poses draw no contact shadow, the other ${P.POSES.length - SEATED_POSES.length} do${seatedBad.length ? ` — wrong: ${seatedBad.join(', ')}` : ''}`)

// ── G. props and the hand table ──────────────────────────────────────────────────────────────────────────────────
console.log('G. props, and the hand anchors — PROVISIONAL: measured on today\'s assets.ts figure, whose look the owner has not settled (re-derive with the new figure); no figure is drawn in this pass')
ok(JSON.stringify([...P.PROP_IDS].sort()) === JSON.stringify([...SLICE_PROPS].sort()), `the slice's ${SLICE_PROPS.length} props: ${P.PROP_IDS.join(', ')}`)
ok(JSON.stringify([...P.POSES].sort()) === JSON.stringify([...PLAN_POSES].sort()) && PLAN_POSES.every(p => P.HAND[p as never]), `the hand table covers all ${PLAN_POSES.length} figure frames (plan §2 + assets.ts)`)
const outOfCell: string[] = []
let placements = 0
for (const pose of P.POSES) {
  const h = P.HAND[pose]
  for (const id of P.PROP_IDS) {
    if (h.hand) {
      const a = P.PROP_ART[id][h.hand.view]
      if (a) {
        placements++
        const x0 = h.hand.x - a.gripX, y0 = h.hand.y - a.gripY
        if (x0 < 0 || y0 < 0 || x0 + a.w > T || y0 + a.h > T) outOfCell.push(`${pose}/${id}/${h.hand.view}`)
      }
    }
  }
  if (h.belt) {
    const a = P.PROP_ART.pager.belt!
    placements++
    if (h.belt.x - a.gripX < 0 || h.belt.y - a.gripY < 0 || h.belt.x - a.gripX + a.w > T || h.belt.y - a.gripY + a.h > T) outOfCell.push(`${pose}/pager/belt`)
  }
}
ok(placements > 100 && outOfCell.length === 0, `${placements} prop placements (pose × prop view) all inside the 16×16 figure cell (provisional anchors, today's figure geometry)${outOfCell.length ? ` — out: ${outOfCell.slice(0, 4).join(', ')}` : ''}`)
const viewsUsed = new Set(P.POSES.flatMap(p => (P.HAND[p].hand ? [P.HAND[p].hand!.view] : [])))
ok(['folder', 'ledger', 'book'].every(id => [...viewsUsed].every(v => P.PROP_ART[id as never][v])) && !!P.PROP_ART.pager.belt,
  `the carried volumes (folder, ledger, book) have every view the hand table uses (${[...viewsUsed].join(', ')}); the pager clips to the belt`)

// ── H. icons ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('H. bubble icons for every slice activity')
// one real tool call per activity, classified by the real classifier
const PROBES: [string, Record<string, unknown>, string | null][] = [
  ['Read', {}, null], ['Grep', {}, null], ['Glob', {}, null], ['Bash', { command: 'mv a b' }, null], ['Edit', {}, null],
  ['Bash', { command: 'npm test' }, null], ['Bash', { command: 'sleep 5' }, null], ['Bash', { command: 'kill 123' }, null],
  ['WebFetch', {}, null], ['Bash', { command: 'vercel deploy' }, null], ['Bash', { command: 'git pull' }, null],
  ['Bash', { command: 'cp a b' }, null], ['Bash', { command: 'rm a' }, null], ['Bash', { command: 'tasklist' }, null],
  ['Bash', { command: 'git diff' }, null], ['Bash', { command: 'git log' }, null], ['Bash', { command: 'git grep x' }, null],
  ['Bash', { command: 'git commit -m x' }, null], ['Bash', { command: 'git checkout x' }, null], ['Bash', { command: 'git stash' }, null],
  ['Bash', { command: 'git status' }, null], ['WebSearch', {}, null], ['Skill', {}, null], ['ToolSearch', {}, 'bookshelf'],
  ['TaskCreate', {}, null], ['SendMessage', {}, null], ['mcp__claude_ai_Gmail__get_message', {}, null], ['Monitor', {}, null],
  ['ListAgents', {}, null], ['SubagentHandback', {}, null], ['StructuredOutput', {}, null], ['AskUserQuestion', {}, null],
  ['Agent', { run_in_background: true }, null], ['Agent', { run_in_background: false }, null], ['Bash', { command: 'cd x' }, null],
]
const kindOf = new Map<string, string | null>()
for (const [name, inp, cur] of PROBES) {
  const [act, kind] = C.classify(name, inp, cur)
  kindOf.set(C.ACTIVITY_ID.get(act) ?? `?${act}`, kind)
}
const allIds = [...C.ACTIVITY_ID.values()]
ok(allIds.every(id => kindOf.has(id)) && kindOf.size === allIds.length, `the probes reach all ${allIds.length} activity ids of classify.mjs`)
const sliceActs = [...kindOf.entries()].filter(([, k]) => k !== null && SLICE.includes(k)).map(([id]) => id)
const noIcon = sliceActs.filter(id => !I.ICON_IDS.includes(I.ACTIVITY_ICON[id]))
ok(sliceActs.length >= 20 && noIcon.length === 0, `${sliceActs.length} activities land on slice objects; each has an icon${noIcon.length ? ` — missing ${noIcon.join(', ')}` : ''}`)
ok(Object.keys(I.ACTIVITY_ICON).every(id => allIds.includes(id)), 'ACTIVITY_ICON is keyed by real activity ids only')
ok(Object.values(I.LIFECYCLE_ICON).every(id => I.ICON_IDS.includes(id)), `lifecycle icons: ${Object.entries(I.LIFECYCLE_ICON).map(([k, v]) => `${k}=${v}`).join(', ')}`)
{
  const bubble = parseColor(I.ICON_BACKGROUND)
  const bg = [0, 1, 2].map(i => bubble[i] * (bubble[3] / 255))           // the bubble over black (the darkest floor)
  const weak: string[] = [], badMap: string[] = []
  const sigs = new Map<string, string>()
  for (const id of I.ICON_IDS) {
    const m = I.iconMap(id)
    if (m.rows.length !== 7 || m.rows.some(r => r.length !== 7 || [...r].some(ch => ch !== '.' && !m.ink[ch]))) badMap.push(id)
    const c = asCanvas(I.iconImage(id))
    let n = 0, strong = 0
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const p = c.at(x, y)
      if (p[3] === 0) continue
      n++
      if (contrast(p, bg) >= 3) strong++
    }
    if (c.width !== I.ICON_SIZE || c.height !== I.ICON_SIZE || n < 8 || strong / n < 0.6) weak.push(`${id} (${strong}/${n} px >= 3:1)`)
    sigs.set(block(c, 0, 0, I.ICON_SIZE, I.ICON_SIZE), id)
  }
  ok(badMap.length === 0, `every icon is a 7×7 map whose every ink is defined (${I.ICON_IDS.length})${badMap.length ? ` — ${badMap.join(', ')}` : ''}`)
  ok(weak.length === 0, `every icon has 8+ px and at least 60% of them at 3:1 or more against the dark bubble${weak.length ? ` — weak: ${weak.join(', ')}` : ''}`)
  ok(sigs.size === I.ICON_IDS.length, 'no two icons are the same picture')
}

// ── J. the renderer's access: frames by index, cached props, each worker's own phase ─────────────────────────────
console.log('J. renderer access: frames by index, cached props, each worker\'s own phase (plan §4.8)')
if (typeof S.stateFrames !== 'function') ok(false, 'stateLayer.ts stateFrames(tile, state), the frames of a state by index: missing')
else {
  const before = S.stateRenders()
  const bad: string[] = []
  for (const a of S.STATE_ART) {
    const fr = S.stateFrames(a.tile, a.state)
    if (fr !== S.stateFrames(a.tile, a.state)) bad.push(`${a.tile}|${a.state}: a new array per call`)
    if (fr.length !== a.variants * a.phases) bad.push(`${a.tile}|${a.state}: ${fr.length} frames`)
    fr.forEach((c, f) => { if (c !== S.stateImage(S.stateKey(a.tile, a.state, f))) bad.push(`${a.tile}|${a.state}|${f}: not the cached image`) })
  }
  ok(bad.length === 0 && S.stateRenders() === before, `stateFrames(tile, state), all ${S.STATE_ART.length} states: the same array every call, holding the cached images (=== stateImage(key)); nothing re-rendered (${S.stateRenders() - before})${bad.length ? ` — ${bad.slice(0, 3).join('; ')}` : ''}`)
}
{
  // props: a repeat returns the same canvas and renders nothing; every slot's binding (the ledger and book take the
  // colour of the slot they were pulled from) renders once
  const views = ['side', 'held', 'tucked', 'belt'] as const
  const counts = typeof P.propRenders === 'function'
  const n = () => (counts ? P.propRenders() : -1)
  let same = true
  const thrown: string[] = []
  const n0 = n()
  for (const id of P.PROP_IDS) for (const v of views) if (P.PROP_ART[id][v]) same &&= P.propImage(id, v) === P.propImage(id, v)
  const n1 = n()
  const bindings: (readonly ['ledger' | 'book', string])[] = [...S.LEDGER_SLOTS.map(s => ['ledger', s.colour] as const), ...S.BOOK_SLOTS.map(s => ['book', s.colour] as const)]
  for (const [id, c] of bindings) for (const v of views) if (P.PROP_ART[id][v]) { try { P.propImage(id, v, c) } catch (e) { thrown.push(`${id}|${v}|${c}: ${String(e).slice(0, 80)}`) } }
  const n2 = n()
  for (const [id, c] of bindings) for (const v of views) if (P.PROP_ART[id][v] && !thrown.length) same &&= P.propImage(id, v, c) === P.propImage(id, v, c)
  ok(counts && same && thrown.length === 0 && n1 === n0 && n() === n2,
    `propImage: a repeat returns the same canvas and renders nothing (props.ts propRenders${counts ? '' : ' missing'}); the ${bindings.length} slot bindings render once each${thrown.length ? ` — ${thrown.slice(0, 2).join('; ')}` : ''}`)
}
{
  /** Plan §4.8 "use/type loops 3.4-4.6 fps per worker": the loops a worker's hands drive. */
  const HAND_LOOPS = ['pcDesk|typing', 'fileCabinet|leafing', 'historyShelf|leafing', 'historyShelf|writing', 'lectern|turning', 'cardCatalog|flipping']
  const loops = S.STATE_ART.filter(a => HAND_LOOPS.includes(`${a.kind}|${a.state}`))
  const off = loops.filter(a => a.fps !== 4)
  ok(HAND_LOOPS.every(k => loops.some(a => `${a.kind}|${a.state}` === k)) && off.length === 0,
    `the ${HAND_LOOPS.length} hand loops (${HAND_LOOPS.join(', ')}) run at a nominal 4 fps: × the worker's rate 0.85-1.15 that is plan §4.8's 3.4-4.6${off.length ? ` — off: ${off.map(a => `${a.tile}|${a.state} ${a.fps} fps`).join(', ')}` : ''}`)
  type PhaseFn = (a: Art, t: number, rate: number, offset: number) => number
  /** Six workers: their own loop-rate factor and phase offset (as an id hash gives them). */
  const WORKERS: readonly (readonly [number, number])[] = [[0.85, 0], [0.93, 0.17], [1, 0.33], [1.07, 0.5], [1.15, 0.67], [0.9, 0.83]]
  /** Over 4 s at 50 samples/s: a still never moves; every phase is a whole number in range; at rate 1 the phase
   *  steps at the nominal fps; the six workers show one and the same phase less than half the time. */
  function phaseFaults(fn: PhaseFn): string[] {
    const bad: string[] = []
    for (const a of S.STATE_ART) {
      if (a.phases <= 1 || a.fps <= 0) { if (WORKERS.some(([r, o]) => fn(a, 1.234, r, o) !== 0)) bad.push(`${a.tile}|${a.state}: a still moves`); continue }
      let together = 0, samples = 0, steps = 0, last = fn(a, 0, 1, 0)
      for (let k = 0; k < 200; k++) {
        const t = k / 50
        const ph = WORKERS.map(([r, o]) => fn(a, t, r, o))
        if (ph.some(p => !Number.isInteger(p) || p < 0 || p >= a.phases)) { bad.push(`${a.tile}|${a.state}: phase out of range at t=${t}`); break }
        samples++
        if (ph.every(p => p === ph[0])) together++
        const nominal = fn(a, t, 1, 0)
        if (nominal !== last) { steps++; last = nominal }
      }
      if (Math.abs(steps - 4 * a.fps) > 1) bad.push(`${a.tile}|${a.state}: ${steps} steps in 4 s at rate 1 (nominal ${4 * a.fps})`)
      if (samples && together / samples >= 0.5) bad.push(`${a.tile}|${a.state}: six workers in lockstep ${Math.round((100 * together) / samples)}% of the time`)
    }
    return bad
  }
  if (typeof S.statePhase !== 'function') ok(false, 'stateLayer.ts statePhase(art, t, rate, offset), each worker\'s own phase: missing')
  else {
    const bad = phaseFaults(S.statePhase)
    const animated = S.STATE_ART.filter(a => a.phases > 1 && a.fps > 0).length
    ok(bad.length === 0, `statePhase: ${animated} animated states in range at their nominal rate, ${S.STATE_ART.length - animated} stills still; six workers with their own rate and offset never in lockstep${bad.length ? ` — ${bad.slice(0, 3).join('; ')}` : ''}`)
    const lockstep: PhaseFn = (a, t) => (a.phases <= 1 || a.fps <= 0 ? 0 : Math.floor(t * a.fps) % a.phases)
    ok(phaseFaults(lockstep).some(b => b.includes('lockstep')), 'MUTANT a phase clock that ignores the worker (every copy from t = 0, today\'s animT = 0): caught as lockstep')
  }
}

// ── K. the in/out board's magnets ────────────────────────────────────────────────────────────────────────────────
console.log('K. in/out board magnets at 3:1 or more (plan §2 row 2: a magnet is 1 px, its colour is the only cue)')
{
  const empty = stack(2, [boardUnder])
  const slotX = (s: (typeof MAGNET_SLOTS)[number]) => (s.part === 'E' ? T : 0) + s.x
  /** Per socket with ink: the lower of its contrast with the empty socket and with the board face beside it (every
   *  socket's right-hand neighbour is board face; the W tile's left column is frame, not board). */
  const ratios = (full: Canvas) => MAGNET_SLOTS.flatMap(s => {
    const x = slotX(s), ink = full.at(x, s.y), sock = empty.at(x, s.y)
    return ink.every((v, i) => v === sock[i]) ? [] : [Math.min(contrast(ink, sock), contrast(ink, empty.at(x + 1, s.y)))]
  })
  const rows = MAGNET_STATES.map(st => ({ st, r: ratios(stack(2, [boardUnder, g => S.drawMagnets(g, 0, 0, Array<typeof st>(MAGNET_SLOTS.length).fill(st))])) }))
  const inked = rows.filter(x => x.r.length > 0)
  const weak = inked.filter(x => Math.min(...x.r) < 3)
  ok(inked.length === 4 && inked.every(x => x.r.length === MAGNET_SLOTS.length) && weak.length === 0,
    `every inked magnet on all ${MAGNET_SLOTS.length} sockets: ${inked.map(x => `${x.st} ${Math.min(...x.r).toFixed(2)}:1`).join(', ')} (lowest, against its socket and the board face); ${rows.filter(x => x.r.length === 0).map(x => x.st).join(', ')}: no ink, the empty socket shows${weak.length ? ` — under 3:1: ${weak.map(x => x.st).join(', ')}` : ''}`)
  // MUTANTS: the colours step 2 pass 1 shipped, the status cyan for a working magnet and STEEL for the flip's back
  const old = copyOf(stack(2, [boardUnder, g => S.drawMagnets(g, 0, 0, ['working', 'flip1'])]))
  old.data.set([0x00, 0xd4, 0xff, 255], (MAGNET_SLOTS[0].y * old.width + slotX(MAGNET_SLOTS[0])) * 4)
  old.data.set([0x9a, 0xa4, 0xac, 255], (MAGNET_SLOTS[1].y * old.width + slotX(MAGNET_SLOTS[1])) * 4)
  ok(ratios(old).filter(r => r < 3).length === 2, `MUTANTS the old cyan (${ratios(old)[0]?.toFixed(2)}:1) and the old steel back (${ratios(old)[1]?.toFixed(2)}:1): caught`)
}

// ── L. the front desk's phone ────────────────────────────────────────────────────────────────────────────────────
console.log('L. onPhone: the handset is lifted, the cradle shows empty (plan §4.4 "lift the handset until the next event")')
{
  const base = asCanvas(F.furnitureTile('frontDeskW'))
  const handset = stack(1, [g => deskHandset(g)])      // the handset on its cradle, drawn alone: where it lies
  /** Of the handset's texels, how many change at 3:1 or more against the desk with the handset on the hook. */
  const lifted = (pic: Canvas) => {
    let n = 0, of = 0
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (handset.at(x, y)[3] > 0) { of++; if (contrast(pic.at(x, y), base.at(x, y)) >= 3) n++ }
    return { n, of }
  }
  const onPhone = S.stateArt('frontDeskW', 'onPhone')
  const r = onPhone ? lifted(stack(1, [base, ...chainOf(onPhone).map(b => cached(b, 0)), cached(onPhone, 0)])) : { n: 0, of: 0 }
  ok(r.n >= 3, `onPhone: ${r.n} of the handset's ${r.of} texels change at 3:1 or more where it lay (at least 3: the cradle shows empty)`)
  // MUTANT: step 2 pass 1's onPhone, the cradle repainted in the phone base's own colour (1.2:1 against the handset)
  const repaint = stack(1, [base, g => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (handset.at(x, y)[3] > 0) { g.fillStyle = '#2b2f36'; g.fillRect(x, y, 1, 1) } }])
  ok(lifted(repaint).n < 3, 'MUTANT the cradle repainted in the phone base\'s colour (the old onPhone): caught')
}

// ── M. palette discipline ────────────────────────────────────────────────────────────────────────────────────────
console.log('M. palette discipline: no colour literal and no derived shade in the art files, every token used')
/** Source with its comments removed (strings, templates and regular expressions kept as they are). */
function codeOnly(src: string): string {
  let out = '', i = 0, mode: 'code' | "'" | '"' | '`' | '/' = 'code', last = ''
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue }
      if (c === "'" || c === '"' || c === '`') mode = c
      else if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) mode = '/'
      out += c
      if (!/\s/.test(c)) last = c
      i++
      continue
    }
    out += c
    if (c === '\\') { out += d ?? ''; i += 2; continue }
    if (c === mode) { mode = 'code'; last = c }
    i++
  }
  return out
}
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(|(['"`])(?:white|black|transparent)\1/g
const DERIVED = /\b(?:mix|lighten|darken|alpha)\s*\(/g
const literals = (src: string) => [...codeOnly(src).matchAll(LITERAL)].map(m => m[0])
const derived = (src: string) => [...codeOnly(src).matchAll(DERIVED)].map(m => m[0])
const RENDER_DIR = `${ROOT}src/worker-office/render`
const PALETTE_FILE = resolve(RENDER_DIR, 'palette.ts')
/** The art files the palette header names: tiles-*.ts, stateLayer.ts, props.ts, icons.ts, furniture.ts. */
const ART_FILES = readdirSync(RENDER_DIR).filter(f => /^tiles-.+\.ts$/.test(f) || ['stateLayer.ts', 'props.ts', 'icons.ts', 'furniture.ts'].includes(f)).sort()
{
  const lit: string[] = [], der: string[] = []
  for (const f of ART_FILES) {
    const src = readFileSync(`${RENDER_DIR}/${f}`, 'utf8')
    lit.push(...literals(src).map(h => `${f} ${h}`))
    der.push(...derived(src).map(h => `${f} ${h}`))
  }
  ok(ART_FILES.length === 9 && lit.length === 0 && der.length === 0,
    `${ART_FILES.length} art files (${ART_FILES.join(', ')}) hold no colour literal outside comments and derive no shade${lit.length ? ` — literals: ${lit.slice(0, 4).join(', ')}${lit.length > 4 ? ` (+${lit.length - 4})` : ''}` : ''}${der.length ? ` — derived: ${der.slice(0, 4).join(', ')}` : ''}`)
  const sl = readFileSync(`${RENDER_DIR}/stateLayer.ts`, 'utf8')
  const base = literals(sl).length, baseD = derived(sl).length
  ok(literals(`${sl}\npx(g, 0, 0, 1, 1, '#ff00ff')\n`).length === base + 1 && derived(`${sl}\nconst x = lighten(PAPER, 0.1)\n`).length === baseD + 1
    && literals(`${sl}\n// px(g, 0, 0, 1, 1, '#ff00ff')\n/* rgba(1,2,3,0.5) */\n`).length === base,
  'MUTANTS a planted literal and a planted derivation: caught; the same literal inside a comment: passes')
}
{
  /** Every .ts / .tsx / .mjs file under src/ that imports the worker-office palette, as code. */
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : []))
  const importers = walk(`${ROOT}src`).filter(f => resolve(f) !== PALETTE_FILE).map(f => ({ f, code: codeOnly(readFileSync(f, 'utf8')) }))
    .filter(({ f, code }) => [...code.matchAll(/from\s+['"]([^'"]+palette\.ts)['"]/g)].some(m => resolve(dirname(f), m[1]) === PALETTE_FILE))
  /** Tokens nothing uses: a top-level export named once only (its definition), a shade or icon ink never read. */
  function unusedTokens(palette: string, users: readonly string[]): string[] {
    const code = codeOnly(palette)
    const all = [code, ...users].join('\n')
    const out: string[] = []
    for (const [, name] of code.matchAll(/^export const (\w+)/gm)) if ((all.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length < 2) out.push(name)
    for (const obj of ['shade', 'ICON_INK']) {
      const start = code.indexOf(`export const ${obj} =`)
      if (start < 0) continue
      const body = code.slice(start, code.indexOf('} as const', start))
      const rest = all.replace(body, '')
      for (const [, key] of body.matchAll(/^\s+(\w+):/gm)) if (!new RegExp(`\\b${obj}\\.${key}\\b`).test(rest)) out.push(`${obj}.${key}`)
    }
    return out
  }
  const palette = readFileSync(PALETTE_FILE, 'utf8')
  const users = importers.map(i => i.code)
  const unused = unusedTokens(palette, users)
  ok(importers.length >= 8 && unused.length === 0, `every palette token is used by the ${importers.length} files that import palette.ts, or by another token${unused.length ? ` — unused: ${unused.join(', ')}` : ''}`)
  const probe = unusedTokens(`${palette.replace('export const shade = {', "export const shade = {\n  probeShade: '#123456',")}\nexport const UNUSED_PROBE = '#123456'\n`, users)
  ok(probe.includes('UNUSED_PROBE') && probe.includes('shade.probeShade') && probe.length === unused.length + 2, 'MUTANTS an unused token and an unused shade: caught')
}

// ── sheets for a human (not checks) ──────────────────────────────────────────────────────────────────────────────
{
  const OUT = `${ROOT}scripts/out`
  mkdirSync(OUT, { recursive: true })
  writePng(`${OUT}/worker-office-art-map.png`, layer, 2)
  const cell = 18, cols = 16
  const rows = Math.ceil(keys.length / cols)
  const [sheet, g] = pixelCanvas(cols * cell + 2, (rows + 6) * cell)
  g.fillStyle = '#1b1f2a'; g.fillRect(0, 0, sheet.width, sheet.height)
  /** the real floor (and wall face, for the board) under the first instance of a tile kind */
  const paintFloor = (tile: string, x: number, y: number) => {
    const at = instances.get(tile)?.[0]
    if (at) g.drawImage(floorLayer, at[0] * T, at[1] * T, T, T, x, y, T, T); else { g.fillStyle = '#6f6b64'; g.fillRect(x, y, T, T) }
  }
  keys.forEach((k, i) => {
    const x = 1 + (i % cols) * cell, y = 1 + Math.floor(i / cols) * cell
    const [tile, state, frame] = k.split('|')
    paintFloor(tile, x, y)
    if (realArt.has(tile)) g.drawImage(asCanvas(F.furnitureTile(tile as never)), x, y)
    // each state as a worker shows it: over its base chain (stateLayer.ts composeState)
    const a = S.stateArt(tile as never, state)
    if (a && typeof S.composeState === 'function') S.composeState(asCtx(g), a, Number(frame), x, y)
    else g.drawImage(asCanvas(S.stateImage(k)), x, y)
  })
  let y = 1 + rows * cell + 3, x = 1
  for (const d of S.DATA_LAYERS) {
    const w = d.tiles.length * T
    if (x + w > sheet.width) { x = 1; y += cell }
    d.tiles.forEach((t, i) => { paintFloor(t, x + i * T, y); if (realArt.has(t)) g.drawImage(asCanvas(F.furnitureTile(t as never)), x + i * T, y) })
    if (d.kind === 'frontDoor') { g.drawImage(floorLayer, 16 * T, 19 * T, 2 * T, T, x, y, 2 * T, T) }
    g.save(); g.translate(x, y); d.sample(asCtx(g)); g.restore()
    x += w + 2
  }
  y += cell + 2; x = 1
  for (const id of P.PROP_IDS) for (const v of ['side', 'held', 'tucked', 'belt'] as const) {
    if (!P.PROP_ART[id][v]) continue
    g.fillStyle = '#8c8478'; g.fillRect(x, y, 9, 9)
    g.drawImage(asCanvas(P.propImage(id, v)), x + 1, y + 1)
    x += 10
  }
  y += 12; x = 1
  for (const id of I.ICON_IDS) {
    g.fillStyle = '#080c18'; g.fillRect(x, y, 9, 9)
    g.drawImage(asCanvas(I.iconImage(id)), x + 1, y + 1)
    x += 10
  }
  writePng(`${OUT}/worker-office-art-sheet.png`, sheet, 4)
  // every image's RGBA, for the browser visual check to compare with Chrome's own canvases
  const rgba = (c: Canvas) => ({ w: c.width, h: c.height, b64: Buffer.from(c.data).toString('base64') })
  const pixels = {
    tiles: Object.fromEntries(artKinds.map(k => [k, rgba(asCanvas(F.furnitureTile(k)))])),
    states: Object.fromEntries(keys.map(k => [k, rgba(asCanvas(S.stateImage(k)))])),
    props: Object.fromEntries(P.PROP_IDS.flatMap(id => (['side', 'held', 'tucked', 'belt'] as const).filter(v => P.PROP_ART[id][v]).map(v => [`${id}|${v}`, rgba(asCanvas(P.propImage(id, v)))]))),
    icons: Object.fromEntries(I.ICON_IDS.map(id => [id, rgba(asCanvas(I.iconImage(id)))])),
  }
  writeFileSync(`${OUT}/worker-office-art-pixels.json`, JSON.stringify(pixels))
  console.log(`sheets (software canvas): scripts/out/worker-office-art-sheet.png, scripts/out/worker-office-art-map.png; pixels: scripts/out/worker-office-art-pixels.json`)
}

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS (software canvas; the browser visual check looks at the same art in Chrome)')
