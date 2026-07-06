// Procedural pixel art: tiles and character sprites drawn with rects onto
// offscreen canvases at 1px = 1 texel, rendered with imageSmoothing off so the
// office stays crisp at any zoom. No external asset files, no licensing risk.

export const TILE = 16

// ── palette ─────────────────────────────────────────────────────────────────
const FLOOR_A = '#181c2c'
const FLOOR_B = '#1c2134'
const CORRIDOR_A = '#20263c'
const CORRIDOR_B = '#242a44'
const WALL = '#0a0d1a'
const WALL_TOP = '#2e3a5c'
const DESK_WOOD = '#4a3628'
const DESK_EDGE = '#5c4432'
const MONITOR = '#0b0f1e'
const MONITOR_GLOW = '#39c6ff'
const CHAIR = '#2a3150'
const TABLE = '#38445c'
const PLANT_POT = '#6b4a2f'
const PLANT_GREEN = '#2f9e44'
const BOARD_BG = '#dfe7ef'
const BOARD_FRAME = '#3a4a6b'
const COFFEE_BODY = '#3d2f2f'

const SKINS = ['#f2c6a0', '#d9a066', '#a5673f', '#7a4a2b']
const HAIRS = ['#2b2b2b', '#5a3825', '#c9a227', '#8a8a8a', '#b23a48', '#3a5a8a']

export type TileKind =
  | 'void' | 'floor' | 'corridor' | 'wall' | 'desk' | 'chair' | 'meetTable'
  | 'plant' | 'whiteboard' | 'coffee' | 'zoneFloor'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  return [c, ctx]
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
}

// ── tiles ───────────────────────────────────────────────────────────────────
export function makeTile(kind: TileKind, opts: { checker?: boolean; teamColor?: string } = {}): HTMLCanvasElement {
  const [c, g] = canvas(TILE, TILE)
  const base = (a: string, b: string) => {
    px(g, 0, 0, TILE, TILE, opts.checker ? b : a)
    // subtle texel noise
    px(g, 3, 5, 1, 1, opts.checker ? a : b)
    px(g, 11, 12, 1, 1, opts.checker ? a : b)
    px(g, 7, 2, 1, 1, opts.checker ? a : b)
  }
  switch (kind) {
    case 'floor': base(FLOOR_A, FLOOR_B); break
    case 'zoneFloor': {
      base(FLOOR_A, FLOOR_B)
      if (opts.teamColor) { g.globalAlpha = 0.05; px(g, 0, 0, TILE, TILE, opts.teamColor); g.globalAlpha = 1 }
      break
    }
    case 'corridor': base(CORRIDOR_A, CORRIDOR_B); break
    case 'wall':
      px(g, 0, 0, TILE, TILE, WALL)
      px(g, 0, 0, TILE, 4, WALL_TOP)
      px(g, 0, 4, TILE, 1, '#11172b')
      break
    case 'desk':
      base(FLOOR_A, FLOOR_B)
      px(g, 0, 6, TILE, 9, DESK_WOOD)
      px(g, 0, 6, TILE, 2, DESK_EDGE)
      px(g, 4, 0, 8, 7, MONITOR)
      px(g, 5, 1, 6, 4, MONITOR_GLOW)
      px(g, 7, 7, 2, 1, '#222') // stand
      break
    case 'chair':
      base(FLOOR_A, FLOOR_B)
      px(g, 4, 5, 8, 8, CHAIR)
      px(g, 3, 4, 10, 2, '#333c63')
      px(g, 7, 13, 2, 2, '#1a2038')
      break
    case 'meetTable':
      px(g, 0, 0, TILE, TILE, FLOOR_A)
      px(g, 0, 2, TILE, 12, TABLE)
      px(g, 0, 2, TILE, 2, '#465577')
      break
    case 'plant':
      base(FLOOR_A, FLOOR_B)
      px(g, 5, 10, 6, 5, PLANT_POT)
      px(g, 4, 4, 3, 4, PLANT_GREEN)
      px(g, 8, 3, 3, 5, '#37b24d')
      px(g, 6, 6, 4, 4, '#2b8a3e')
      break
    case 'whiteboard':
      px(g, 0, 0, TILE, TILE, WALL)
      px(g, 0, 0, TILE, 4, WALL_TOP)
      px(g, 1, 5, 14, 9, BOARD_FRAME)
      px(g, 2, 6, 12, 7, BOARD_BG)
      px(g, 3, 8, 6, 1, '#e8590c')
      px(g, 3, 10, 8, 1, '#1971c2')
      break
    case 'coffee':
      base(FLOOR_A, FLOOR_B)
      px(g, 3, 4, 10, 11, COFFEE_BODY)
      px(g, 4, 5, 8, 3, '#222')
      px(g, 6, 9, 4, 3, '#c92a2a')
      px(g, 5, 13, 6, 1, '#666')
      break
    case 'void':
      px(g, 0, 0, TILE, TILE, '#05070f')
      break
  }
  return c
}

// ── characters ──────────────────────────────────────────────────────────────
// 12×16 body drawn in a 16×16 cell. Frames: walk (4 dirs × 2), sit, type ×2, stand.
export type CharFrame =
  | 'stand' | 'walkD0' | 'walkD1' | 'walkU0' | 'walkU1' | 'walkL0' | 'walkL1' | 'walkR0' | 'walkR1'
  | 'sit' | 'type0' | 'type1'

export interface CharacterSheet { frames: Record<CharFrame, HTMLCanvasElement> }

const sheetCache = new Map<string, CharacterSheet>()

export function characterSheet(seed: number, shirt: string): CharacterSheet {
  const skin = SKINS[seed % SKINS.length]
  const hair = HAIRS[Math.floor(seed / SKINS.length) % HAIRS.length]
  const key = `${skin}|${hair}|${shirt}`
  const hit = sheetCache.get(key)
  if (hit) return hit

  const pants = '#26314f'
  const shoes = '#11162a'

  function frame(draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    const [c, g] = canvas(TILE, TILE)
    g.translate(2, 0) // center the 12-wide body
    draw(g)
    return c
  }

  // helpers — all coordinates in the 12×16 body space
  const headFront = (g: CanvasRenderingContext2D) => {
    px(g, 3, 0, 6, 2, hair)
    px(g, 2, 1, 8, 2, hair)
    px(g, 3, 3, 6, 3, skin)
    px(g, 4, 4, 1, 1, '#141414'); px(g, 7, 4, 1, 1, '#141414') // eyes
  }
  const headBack = (g: CanvasRenderingContext2D) => {
    px(g, 3, 0, 6, 2, hair)
    px(g, 2, 1, 8, 4, hair)
    px(g, 3, 5, 6, 1, skin)
  }
  const headSide = (g: CanvasRenderingContext2D) => {
    px(g, 3, 0, 6, 2, hair)
    px(g, 2, 1, 7, 3, hair)
    px(g, 4, 3, 5, 3, skin)
    px(g, 7, 4, 1, 1, '#141414') // one eye
  }
  const torso = (g: CanvasRenderingContext2D, armL = 0, armR = 0) => {
    px(g, 3, 6, 6, 5, shirt)
    px(g, 2, 6, 1, 4 + armL, shirt); px(g, 2, 10 + armL, 1, 1, skin)
    px(g, 9, 6, 1, 4 + armR, shirt); px(g, 9, 10 + armR, 1, 1, skin)
  }
  const legs = (g: CanvasRenderingContext2D, offL: number, offR: number) => {
    px(g, 4, 11, 2, 3 + offL, pants); px(g, 4, 14 + offL, 2, 1, shoes)
    px(g, 6, 11, 2, 3 + offR, pants); px(g, 6, 14 + offR, 2, 1, shoes)
  }

  const frames: Record<CharFrame, HTMLCanvasElement> = {
    stand: frame(g => { headFront(g); torso(g); legs(g, 0, 0) }),
    walkD0: frame(g => { headFront(g); torso(g, 0, -1); legs(g, 0, -1) }),
    walkD1: frame(g => { headFront(g); torso(g, -1, 0); legs(g, -1, 0) }),
    walkU0: frame(g => { headBack(g); torso(g, 0, -1); legs(g, 0, -1) }),
    walkU1: frame(g => { headBack(g); torso(g, -1, 0); legs(g, -1, 0) }),
    walkL0: frame(g => { g.save(); g.translate(12, 0); g.scale(-1, 1); headSide(g); torso(g, 0, -1); legs(g, 0, -1); g.restore() }),
    walkL1: frame(g => { g.save(); g.translate(12, 0); g.scale(-1, 1); headSide(g); torso(g, -1, 0); legs(g, -1, 0); g.restore() }),
    walkR0: frame(g => { headSide(g); torso(g, 0, -1); legs(g, 0, -1) }),
    walkR1: frame(g => { headSide(g); torso(g, -1, 0); legs(g, -1, 0) }),
    // seated: body lower, legs hidden behind the desk/chair
    sit: frame(g => { g.translate(0, 2); headBack(g); px(g, 3, 6, 6, 6, shirt) }),
    type0: frame(g => { g.translate(0, 2); headBack(g); px(g, 3, 6, 6, 6, shirt); px(g, 2, 8, 1, 2, skin) }),
    type1: frame(g => { g.translate(0, 2); headBack(g); px(g, 3, 6, 6, 6, shirt); px(g, 9, 8, 1, 2, skin) }),
  }

  const sheet = { frames }
  sheetCache.set(key, sheet)
  return sheet
}

export const STATUS_COLORS: Record<string, string> = {
  offline: '#3a4157',
  idle: '#5c6a8a',
  working: '#00d4ff',
  reading: '#4d9fff',
  typing: '#ff6b35',
  talking: '#00ff88',
  reviewing: '#ffd700',
  blocked: '#ff4444',
}
