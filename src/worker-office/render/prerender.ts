// The worker office pre-render (plan §6.1), built ONCE per page load:
//   layer 1  the ground: each tile's room finish (from zones[] — also under every object tile), the shell (walls,
//            windows, openings, the door base) and the ground surfaces (sidewalk, street, planters, doormat);
//            then the wall and furniture shadows, using the new kind sets below;
//   layer 2  the objects, on a transparent canvas, so the finish shows around them: each furniture tile is ONE blit of
//            its kind's cached art (furniture.ts; pass 1, the vertical slice), and the kinds pass 2 will draw keep
//            their step-1 placeholders;
//   light    daylight pools from every run of windows — the north windows AND the facade row — and the floor lamp
//            glow, each clipped to its own room (light does not pass through walls).
// Room labels are placed from the zone data (not hard-coded coordinates) and drawn by the engine as crisp text; the
// engine re-places them for the UI text scale (placeLabels), so a bigger font never pushes one across a wall.
// The door leaves are state, drawn per frame by the engine (stateLayer.ts doorLeaves).
// The page keeps its one scene in map/office.ts (getOfficeScene); this module stays importable from Node.
import { SURFACE_KINDS, type OfficeMap, type OfficeObject, type Opening, type TileKind, type Zone } from '../map/loadMap.ts'
import { type Ctx, makeCanvas, px, alpha, lighten } from './paint.ts'
import { TILE, drawFinish, finishOf, variantOf, planter, doormat, doorBase } from './floors.ts'
import { wallFace, wallTop, windowInterior, windowExterior, jamb } from './walls.ts'
import { drawPlaceholder } from './placeholders.ts'
import { NO_CONTACT_SHADOW, furnitureTile, hasFurnitureArt } from './furniture.ts'

export interface LabelPlacement {
  readonly text: string
  /** texel coordinates of the text's left edge and vertical middle */
  readonly x: number
  readonly y: number
  /** font size in texels */
  readonly size: number
}

export interface OfficeScene {
  readonly map: OfficeMap
  /** The finished map, 1 texel per pixel: layer 1 + layer 2 + light. */
  readonly layer: HTMLCanvasElement
  /** Layer 1 alone (ground, shell and shadows, no objects), kept for checks and debugging. */
  readonly floorLayer: HTMLCanvasElement
  readonly labels: readonly LabelPlacement[]
}

export const LABEL_FONT = '"IBM Plex Mono", monospace'

let builds = 0
/** How many times the office has been pre-rendered on this page (the visual check expects exactly 1). */
export const prerenderBuilds = () => builds

/** Kind sets for the shadow passes. Wall-like: walls, windows and objects mounted in a wall run. */
function kindSets(map: OfficeMap) {
  const at = (x: number, y: number): TileKind | null => (map.inBounds(x, y) ? map.tiles[y][x] : null)
  const wallLike = (x: number, y: number) => {
    const k = at(x, y)
    return k === 'wall' || k === 'window' || map.objectAt(x, y)?.wallMounted === true
  }
  /** Tiles whose ground can take a shadow: everything except the wall runs and the door (glass, in the facade). */
  const receives = (x: number, y: number) => map.inBounds(x, y) && !wallLike(x, y) && map.objectAt(x, y)?.kind !== 'frontDoor'
  /** Free-standing furniture casts a contact shadow onto the tile south of it; seats that lie flat like the floor
   *  (furniture.ts NO_CONTACT_SHADOW) cast none. */
  const castsContact = (o: OfficeObject | null) => o !== null && !o.wallMounted && !SURFACE_KINDS.has(o.kind) && !NO_CONTACT_SHADOW.has(o.kind)
  return { wallLike, receives, castsContact }
}

export function prerenderOffice(map: OfficeMap): OfficeScene {
  builds++
  const W = map.width, H = map.height
  const [floorLayer, g] = makeCanvas(W * TILE, H * TILE)
  const { wallLike, receives, castsContact } = kindSets(map)

  // cached finish tiles: finish | base colour | position variant
  const finishCache = new Map<string, HTMLCanvasElement>()
  const finishTile = (finish: string, base: string, x: number, y: number) => {
    const id = finishOf(finish), v = variantOf(x, y)
    const k = `${id}|${base}|${v}`
    let c = finishCache.get(k)
    if (!c) {
      const [tc, tg] = makeCanvas(TILE, TILE)
      drawFinish(tg, id, base, v)
      finishCache.set(k, tc)
      c = tc
    }
    return c
  }
  const zoneFinishAt = (x: number, y: number) => {
    const z = map.zoneAt(x, y)
    if (!z) throw new Error(`tile (${x},${y}) needs a floor finish but lies in no zone`)
    return finishTile(z.finish, z.floor, x, y)
  }
  const openingAt = new Map<string, Opening>()
  for (const o of map.openings) for (const t of o.tiles) openingAt.set(`${t.x},${t.y}`, o)
  const isGap = (x: number, y: number) => map.inBounds(x, y) && (map.tiles[y][x] === 'opening' || map.objectAt(x, y)?.kind === 'frontDoor')

  // ── layer 1: ground and shell ────────────────────────────────────────────────────────────────────────────────
  const draw = (x: number, y: number, fn: (t: Ctx) => void) => {
    g.save(); g.translate(x * TILE, y * TILE); fn(g); g.restore()
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = map.tiles[y][x]
      const o = map.objectAt(x, y)
      if (k === 'wall' || o?.wallMounted) {
        const face = !wallLike(x, y + 1)
        draw(x, y, t => {
          if (face) wallFace(t); else wallTop(t, (x + y) % 2 === 0)
          if (isGap(x - 1, y)) jamb(t, 'W', face)
          if (isGap(x + 1, y)) jamb(t, 'E', face)
        })
      } else if (k === 'window') {
        draw(x, y, y === map.facadeRow ? windowExterior : windowInterior)
      } else if (o?.kind === 'frontDoor') {
        draw(x, y, t => doorBase(t, x === o.x ? 'W' : 'E'))
      } else if (o?.kind === 'planter') {
        draw(x, y, t => planter(t, map.legend[o.char].color))
      } else if (k === 'opening') {
        // a doorway: each half carries the finish of the room on that side, with a threshold strip between
        const op = openingAt.get(`${x},${y}`)!
        const [a, b] = op.sides
        const ta = finishTile(a.finish, a.floor, x, y), tb = finishTile(b.finish, b.floor, x, y)
        const strip = map.legend['+'].color
        if (op.wall === 'horizontal') {
          g.drawImage(ta, 0, 0, TILE, 8, x * TILE, y * TILE, TILE, 8)
          g.drawImage(tb, 0, 8, TILE, 8, x * TILE, y * TILE + 8, TILE, 8)
          px(g, x * TILE, y * TILE + 7, TILE, 2, strip)
          px(g, x * TILE, y * TILE + 7, TILE, 1, lighten(strip, 0.25))
        } else {
          g.drawImage(ta, 0, 0, 8, TILE, x * TILE, y * TILE, 8, TILE)
          g.drawImage(tb, 8, 0, 8, TILE, x * TILE + 8, y * TILE, 8, TILE)
          px(g, x * TILE + 7, y * TILE, 2, TILE, strip)
          px(g, x * TILE + 7, y * TILE, 1, TILE, lighten(strip, 0.25))
        }
      } else {
        // the room's finish — under every object tile too (two-layer pre-render, critic 1 §1)
        g.drawImage(zoneFinishAt(x, y), x * TILE, y * TILE)
        if (o?.kind === 'doormat') {
          const col = x - o.x
          draw(x, y, t => doormat(t, map.legend[o.char].color, col === 0 ? 'W' : col === o.w - 1 ? 'E' : 'C'))
        }
      }
    }
  }

  // ── shadows (on the ground, under the objects); light comes from the upper left ──────────────────────────────
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      if (!receives(x, y + 1)) continue
      if (wallLike(x, y)) {
        px(g, x * TILE, (y + 1) * TILE, TILE, 4, 'rgba(20,12,4,0.30)')
        px(g, x * TILE, (y + 1) * TILE + 4, TILE, 2, 'rgba(20,12,4,0.14)')
      } else if (castsContact(map.objectAt(x, y))) {
        px(g, x * TILE, (y + 1) * TILE, TILE, 3, 'rgba(20,12,4,0.18)')
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (wallLike(x, y) && receives(x + 1, y)) px(g, (x + 1) * TILE, y * TILE, 3, TILE, 'rgba(20,12,4,0.16)')
    }
  }

  // ── layer 2: objects on a transparent canvas ───────────────────────────────────────────────────────────────────
  const [objectLayer, og] = makeCanvas(W * TILE, H * TILE)
  for (const o of map.objects) {
    if (SURFACE_KINDS.has(o.kind)) continue
    const color = map.legend[o.char].color
    for (let i = 0; i < o.w * o.h; i++) {
      const tx = (o.x + (i % o.w)) * TILE, ty = (o.y + Math.floor(i / o.w)) * TILE
      const kind = o.tileKinds[i]
      if (hasFurnitureArt(kind)) {
        og.drawImage(furnitureTile(kind), tx, ty)
      } else {
        og.save()
        og.translate(tx, ty)
        drawPlaceholder(og, o, i, color)
        og.restore()
      }
    }
  }

  // ── composite + light ──────────────────────────────────────────────────────────────────────────────────────────
  // Light never passes through a wall: every pool is clipped to the room it falls into (roomOf: the top-level
  // zone, so the mail / print corner shares reception's light). Daylight is ONE pool per run of windows, so
  // neighbouring windows do not stack into bright seams under the mullions.
  const [layer, lg] = makeCanvas(W * TILE, H * TILE)
  lg.drawImage(floorLayer, 0, 0)
  lg.drawImage(objectLayer, 0, 0)
  const inside = (x: number, y: number) => map.inBounds(x, y) && y < map.facadeRow && !wallLike(x, y) && roomOf(map, x, y) !== null
  const lit = (room: Zone, paint: () => void) => {
    lg.save()
    lg.beginPath()
    lg.rect(room.x * TILE, room.y * TILE, room.w * TILE, room.h * TILE)
    lg.clip()
    paint()
    lg.restore()
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W;) {
      // daylight falls away from the wall, onto whichever side is the inside of the building
      const dir = map.tiles[y][x] !== 'window' ? 0 : inside(x, y + 1) ? 1 : inside(x, y - 1) ? -1 : 0
      if (dir === 0) { x++; continue }
      const room = roomOf(map, x, y + dir)!
      const x0 = x
      while (x < W && map.tiles[y][x] === 'window' && inside(x, y + dir) && roomOf(map, x, y + dir) === room) x++
      const edge = dir > 0 ? (y + 1) * TILE : y * TILE
      const a = y === map.facadeRow ? 0.09 : 0.11
      lit(room, () => {
        const grad = lg.createLinearGradient(0, edge, 0, edge + dir * DAYLIGHT_DEPTH)
        grad.addColorStop(0, `rgba(255,238,200,${a})`)
        grad.addColorStop(1, 'rgba(255,238,200,0)')
        lg.fillStyle = grad
        lg.fillRect(x0 * TILE - 3, dir > 0 ? edge : edge - DAYLIGHT_DEPTH, (x - x0) * TILE + 6, DAYLIGHT_DEPTH)
      })
    }
  }
  for (const o of map.objects) {
    if (o.kind !== 'floorLamp') continue
    const room = roomOf(map, o.x, o.y)
    if (!room) continue
    const cx = o.x * TILE + 8, cy = o.y * TILE + 4
    lit(room, () => {
      const grad = lg.createRadialGradient(cx, cy, 2, cx, cy, LAMP_RADIUS)
      grad.addColorStop(0, 'rgba(255,205,120,0.26)')
      grad.addColorStop(1, 'rgba(255,205,120,0)')
      lg.fillStyle = grad
      lg.beginPath(); lg.arc(cx, cy, LAMP_RADIUS, 0, Math.PI * 2); lg.fill()
    })
  }

  return { map, layer, floorLayer, labels: placeLabels(map, lg, 1) }
}

/** How far daylight reaches into a room from its windows, and the floor lamp's glow radius (texels). */
const DAYLIGHT_DEPTH = 40
const LAMP_RADIUS = 40

/** The room a tile belongs to: its top-level zone (a sub-area such as the mail / print corner is part of its
 *  parent's room), or null outside every zone. */
export function roomOf(map: OfficeMap, x: number, y: number): Zone | null {
  const z = map.zoneAt(x, y)
  if (!z || z.parent === null) return z
  return map.zones.find(p => p.name === z.parent) ?? z
}

/** Plain floor a label may sit on: not a use spot, an opening, the door, the mat or furniture. */
export const LABEL_GROUND: ReadonlySet<TileKind> = new Set<TileKind>(['floor', 'corridor', 'placeTile', 'sidewalk', 'arrivalSlot'])
/** Space kept clear between a label and the ends of its run of floor (texels). */
export const LABEL_PAD = 3
/** Canvas font of a room label of `size` texels. */
export const labelFont = (size: number) => `bold ${size}px ${LABEL_FONT}`

/** One label per zone, for a UI text scale (SettingsContext; the engine re-places on every change and once the
 *  web font has loaded, because the metrics change): the zone's name, at its base size (rooms 5 texels, sub-areas 4)
 *  × the scale, on the first row (top down) with a run of plain floor of the zone's own (most specific) area long
 *  enough for the text, at the run's left end. If no run is long enough, the label goes on the zone's longest run
 *  (the first one, top down) at the largest size that fits it. So a label never crosses a wall, a doorway or
 *  furniture at any text scale, and it is never smaller than at scale 1 when the scale is above 1. A zone with no
 *  plain floor at all (the street) gets no label. */
export function placeLabels(map: OfficeMap, measureCtx: Ctx, fontScale: number): LabelPlacement[] {
  const out: LabelPlacement[] = []
  const width = (text: string, size: number) => { measureCtx.font = labelFont(size); return measureCtx.measureText(text).width }
  for (const z of map.zones) {
    const want = (z.parent ? 4 : 5) * fontScale
    const textW = width(z.name, want)
    let found: LabelPlacement | null = null
    let best: { x0: number; y: number; len: number } | null = null
    for (let y = z.y; y < z.y + z.h && !found; y++) {
      let run = 0
      for (let x = z.x; x < z.x + z.w; x++) {
        const ok = map.zoneAt(x, y) === z && LABEL_GROUND.has(map.tiles[y][x])
        run = ok ? run + 1 : 0
        if (!ok) continue
        const x0 = x - run + 1
        if (!best || run > best.len) best = { x0, y, len: run }
        if (run * TILE >= textW + 2 * LABEL_PAD) { found = { text: z.name, x: x0 * TILE + LABEL_PAD, y: y * TILE + 8, size: want }; break }
      }
    }
    if (!found && best) {
      // shrink to the longest run; text width is (close to) linear in the font size, so start there and step down
      const room = best.len * TILE - 2 * LABEL_PAD
      let size = Math.floor((want * room) / textW * 4) / 4
      while (size > 0 && width(z.name, size) > room) size -= 0.25
      if (size > 0) found = { text: z.name, x: best.x0 * TILE + LABEL_PAD, y: best.y * TILE + 8, size }
    }
    if (found) out.push(found)
  }
  return out
}

/** For debugging: the colour of a texel on a layer (the visual check reads the floor layer under objects). */
export function texel(layer: HTMLCanvasElement, x: number, y: number): string {
  const d = layer.getContext('2d')!.getImageData(x, y, 1, 1).data
  return alpha(`#${[d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`, +(d[3] / 255).toFixed(3))
}
