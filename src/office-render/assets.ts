// Procedural pixel art: tiles and character sprites drawn with rects onto
// offscreen canvases at 1px = 1 texel, rendered with imageSmoothing off so the
// office stays crisp at any zoom. No external asset files, no licensing risk.
//
// Theme: warm luxury campus (Google-office style) — oak plank floors,
// travertine corridors, glass meeting walls, living green walls, velvet
// lounge, quartz kitchen. Every tile is position-independent; anything that
// depends on WHERE a tile sits (shadows, accent strips, lamp glow) is baked
// by the overlay passes in OfficeEngine.prerenderMap, never here — the
// `kind|checker|teamColor` cache key must stay valid.

export const TILE = 16

// ── palette (warm-luxe theme tokens) ────────────────────────────────────────
const WOOD_A = '#6b4f33'        // main oak plank
const WOOD_B = '#75573a'        // alternating plank
const WOOD_SEAM = '#57402a'     // plank gaps
const WOOD_SHINE = '#8a6a48'    // polish flecks
const STONE_A = '#5a544c'       // corridor travertine
const STONE_B = '#635c53'
const STONE_SEAM = '#4a453e'    // grout
const WALL_FACE = '#2e2620'     // espresso wall body
const WALL_CAP = '#a08b6a'      // limestone cap (top 4px)
const WALL_CAP_EDGE = '#6e5c44' // cap underside
const WALL_BASE = '#1f1a15'     // baseboard
const GLASS_PANE = 'rgba(170,214,222,0.38)'
const GLASS_FRAME = '#8fa1ab'   // brushed aluminum
const GLASS_SHINE = 'rgba(255,255,255,0.30)'
const GREEN_DK = '#2c5234'      // living-wall foliage
const GREEN_MD = '#3a6b42'
const GREEN_LT = '#4f8a52'
const DESK_TOP = '#8a6a4a'      // light-oak desk
const DESK_EDGE = '#9c7c58'
const MONITOR = '#10141f'
const MONITOR_GLOW = '#bfe3ff'
const MONITOR_FRAME = '#c8ccd4' // silver bezel
const CHAIR_BODY = '#33413a'    // forest ergonomic chair
const CHAIR_BACK = '#42544a'
const TABLE_WOOD = '#5c4230'    // walnut conference table
const TABLE_EDGE = '#6e5240'
const SOFA_BODY = '#3f6a52'     // green velvet sofa
const SOFA_SEAT = '#4d7d61'
const SOFA_DARK = '#2f4f3d'
const RUG_MAIN = '#44506e'      // indigo rug
const RUG_PAT = '#5a6a92'
const LAMP_POLE = '#3a3128'
const LAMP_SHADE = '#e8c87a'
const COUNTER_TOP = '#d8d2c6'   // quartz
const COUNTER_CAB = '#4a3a2c'   // walnut cabinets
const STEEL = '#9aa4ac'         // appliances
const POT_CERAMIC = '#c9b8a4'   // planters, mugs
const PLANT_GREEN = '#2f9e44'
const BOARD_BG = '#eef1f4'      // glassboard
const BOARD_FRAME = '#8fa1ab'
const SKY_TOP = '#9ec7d8'       // window view
const SKY_MID = '#b4d4d4'
const SKY_BOT = '#c8dfd0'
const VOID = '#05070f'          // matches the app chrome

const SKINS = ['#f2c6a0', '#d9a066', '#a5673f', '#7a4a2b']
const HAIRS = ['#2b2b2b', '#5a3825', '#c9a227', '#8a8a8a', '#b23a48', '#3a5a8a']

export type TileKind =
  | 'void' | 'floor' | 'corridor' | 'wall' | 'wallTop' | 'desk' | 'chair' | 'meetTable'
  | 'plant' | 'whiteboard' | 'coffee' | 'zoneFloor'
  | 'glass' | 'greenWall' | 'windowWall'
  | 'sofaW' | 'sofaC' | 'sofaE' | 'armchair' | 'loungeTable' | 'rug' | 'lamp'
  | 'kitchenCounter' | 'sink' | 'fridge'

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

  // Oak plank floor — the base under every in-room tile. Plank stagger flips
  // with the checker parity so seams don't tile into a visible grid.
  const woodBase = () => {
    px(g, 0, 0, TILE, TILE, opts.checker ? WOOD_B : WOOD_A)
    px(g, 0, 5, TILE, 1, WOOD_SEAM)
    px(g, 0, 11, TILE, 1, WOOD_SEAM)
    if (opts.checker) {
      px(g, 4, 0, 1, 5, WOOD_SEAM); px(g, 10, 6, 1, 5, WOOD_SEAM); px(g, 6, 12, 1, 4, WOOD_SEAM)
      px(g, 2, 8, 1, 1, WOOD_SHINE); px(g, 9, 14, 1, 1, WOOD_SHINE)
    } else {
      px(g, 11, 0, 1, 5, WOOD_SEAM); px(g, 5, 6, 1, 5, WOOD_SEAM); px(g, 12, 12, 1, 4, WOOD_SEAM)
      px(g, 7, 3, 1, 1, WOOD_SHINE); px(g, 13, 9, 1, 1, WOOD_SHINE)
    }
  }
  // Espresso wall with a limestone cap and baseboard.
  const wallBase = () => {
    px(g, 0, 0, TILE, TILE, WALL_FACE)
    px(g, 0, 0, TILE, 4, WALL_CAP)
    px(g, 0, 4, TILE, 1, WALL_CAP_EDGE)
    px(g, 0, 14, TILE, 2, WALL_BASE)
    px(g, 5, 5, 1, 9, 'rgba(0,0,0,0.25)')
    px(g, 10, 5, 1, 9, 'rgba(0,0,0,0.25)')
  }
  const counterBase = () => {
    px(g, 0, 0, TILE, 7, COUNTER_TOP)
    px(g, 0, 0, TILE, 1, '#e8e2d6')
    px(g, 0, 7, TILE, 8, COUNTER_CAB)
    px(g, 7, 10, 2, 1, STEEL)
    px(g, 0, 15, TILE, 1, WALL_BASE)
  }
  const rugBase = () => {
    px(g, 0, 0, TILE, TILE, RUG_MAIN)
    for (const [dx, dy] of [[8, 6], [7, 7], [9, 7], [6, 8], [10, 8], [7, 9], [9, 9], [8, 10]] as const) {
      px(g, dx, dy, 1, 1, RUG_PAT)
    }
    px(g, 3, 3, 1, 1, '#3c4763'); px(g, 12, 12, 1, 1, '#3c4763')
  }
  const sofaLegs = () => {
    px(g, 2, 13, 2, 1, '#2a2017'); px(g, 12, 13, 2, 1, '#2a2017')
  }

  switch (kind) {
    case 'floor': woodBase(); break
    case 'zoneFloor': {
      woodBase()
      if (opts.teamColor) { g.globalAlpha = 0.08; px(g, 0, 0, TILE, TILE, opts.teamColor); g.globalAlpha = 1 }
      break
    }
    case 'corridor':
      px(g, 0, 0, TILE, TILE, opts.checker ? STONE_B : STONE_A)
      px(g, 0, 7, TILE, 1, STONE_SEAM)
      if (opts.checker) px(g, 7, 0, 1, 7, STONE_SEAM)
      px(g, 4, 3, 1, 1, opts.checker ? STONE_A : STONE_B)
      px(g, 12, 11, 1, 1, opts.checker ? STONE_A : STONE_B)
      break
    case 'wall': wallBase(); break
    case 'wallTop':
      // Top surface of a wall run. Vertical segments (and junctions) show only
      // the limestone cap from this viewing angle — repeating the south-facing
      // cap+face art up a column reads as a striped ladder.
      px(g, 0, 0, TILE, TILE, WALL_CAP)
      px(g, 0, 0, 1, TILE, WALL_CAP_EDGE)
      px(g, 15, 0, 1, TILE, WALL_CAP_EDGE)
      px(g, 1, 0, 1, TILE, 'rgba(0,0,0,0.12)')
      px(g, 14, 0, 1, TILE, 'rgba(0,0,0,0.12)')
      if (opts.checker) {
        px(g, 6, 4, 2, 1, '#b09b78'); px(g, 9, 12, 1, 1, '#8f7c5e')
      } else {
        px(g, 8, 7, 2, 1, '#b09b78'); px(g, 5, 2, 1, 1, '#8f7c5e')
      }
      break
    case 'windowWall':
      wallBase()
      px(g, 1, 5, 14, 9, GLASS_FRAME)
      px(g, 2, 6, 12, 3, SKY_TOP)
      px(g, 2, 9, 12, 2, SKY_MID)
      px(g, 2, 11, 12, 2, SKY_BOT)
      px(g, 8, 5, 1, 9, GLASS_FRAME) // mullion
      px(g, 3, 7, 1, 1, GLASS_SHINE); px(g, 4, 8, 1, 1, GLASS_SHINE)
      break
    case 'greenWall':
      px(g, 0, 0, TILE, TILE, WALL_FACE)
      px(g, 0, 0, TILE, 4, WALL_CAP)
      px(g, 0, 4, TILE, 12, '#57402a') // planter frame
      px(g, 1, 5, 4, 3, GREEN_DK); px(g, 5, 4, 4, 4, GREEN_MD); px(g, 9, 5, 4, 3, GREEN_DK)
      px(g, 13, 4, 3, 4, GREEN_MD); px(g, 2, 8, 3, 3, GREEN_LT); px(g, 6, 8, 4, 3, GREEN_DK)
      px(g, 10, 8, 4, 4, GREEN_MD); px(g, 1, 11, 4, 4, GREEN_MD); px(g, 5, 11, 4, 4, GREEN_LT)
      px(g, 9, 12, 6, 3, GREEN_DK)
      break
    case 'glass':
      // Wood floor shows through the pane so the baked layer reads translucent.
      woodBase()
      px(g, 1, 0, 14, TILE, GLASS_PANE)
      px(g, 0, 0, 1, TILE, GLASS_FRAME); px(g, 15, 0, 1, TILE, GLASS_FRAME)
      px(g, 0, 0, TILE, 1, GLASS_FRAME); px(g, 0, 15, TILE, 1, GLASS_FRAME)
      for (const [dx, dy] of [[4, 2], [5, 3], [6, 4], [7, 5], [10, 8], [11, 9], [12, 10]] as const) {
        px(g, dx, dy, 1, 1, GLASS_SHINE)
      }
      break
    case 'desk':
      woodBase()
      px(g, 0, 6, TILE, 9, DESK_TOP)
      px(g, 0, 6, TILE, 2, DESK_EDGE)
      px(g, 3, 0, 10, 7, MONITOR_FRAME)
      px(g, 4, 1, 8, 5, MONITOR)
      px(g, 5, 2, 6, 3, MONITOR_GLOW)
      px(g, 7, 7, 2, 1, '#3a3f4a') // stand
      px(g, 13, 9, 2, 2, POT_CERAMIC) // mug
      break
    case 'chair':
      woodBase()
      px(g, 4, 5, 8, 8, CHAIR_BODY)
      px(g, 3, 4, 10, 2, CHAIR_BACK)
      px(g, 3, 6, 1, 4, CHAIR_BACK); px(g, 12, 6, 1, 4, CHAIR_BACK) // armrests
      px(g, 7, 13, 2, 2, '#1f1a15')
      break
    case 'meetTable':
      woodBase()
      px(g, 0, 2, TILE, 12, TABLE_WOOD)
      px(g, 0, 2, TILE, 2, TABLE_EDGE)
      px(g, 0, 7, TILE, 1, 'rgba(0,0,0,0.15)')
      px(g, 0, 10, TILE, 1, 'rgba(0,0,0,0.15)')
      px(g, 0, 2, TILE, 1, 'rgba(255,255,255,0.10)')
      break
    case 'plant':
      woodBase()
      px(g, 5, 10, 6, 5, POT_CERAMIC)
      px(g, 5, 10, 6, 1, '#d8cbb8') // rim
      px(g, 6, 11, 4, 1, '#3a2c20') // soil
      px(g, 3, 3, 4, 5, PLANT_GREEN)
      px(g, 8, 2, 4, 6, '#37b24d')
      px(g, 6, 5, 5, 5, '#2b8a3e')
      px(g, 2, 6, 3, 3, '#37b24d')
      break
    case 'whiteboard': // glassboard on the wall
      wallBase()
      px(g, 1, 5, 14, 9, BOARD_FRAME)
      px(g, 2, 6, 12, 7, BOARD_BG)
      px(g, 3, 8, 6, 1, '#e8590c')
      px(g, 3, 10, 8, 1, '#1971c2')
      px(g, 11, 7, 2, 2, '#ffd43b') // sticky note
      break
    case 'coffee': // chrome espresso machine
      woodBase()
      px(g, 3, 4, 10, 11, STEEL)
      px(g, 4, 2, 8, 3, '#2b2b2b') // bean hopper
      px(g, 4, 6, 8, 5, '#2e2e34') // front panel
      px(g, 5, 7, 1, 1, '#e03131') // status LED
      px(g, 7, 11, 2, 1, '#1f1f24') // portafilter
      px(g, 4, 13, 8, 1, '#6a7178') // drip tray
      px(g, 12, 6, 1, 4, MONITOR_FRAME) // steam wand
      break
    case 'kitchenCounter': counterBase(); break
    case 'sink':
      counterBase()
      px(g, 3, 1, 10, 5, STEEL)
      px(g, 4, 2, 8, 3, '#7e8890')
      px(g, 7, 0, 2, 1, MONITOR_FRAME) // faucet
      break
    case 'fridge':
      woodBase()
      px(g, 1, 0, 14, 15, STEEL)
      px(g, 1, 6, 14, 1, '#7e8890') // door split
      px(g, 12, 2, 1, 3, '#e8ecef'); px(g, 12, 8, 1, 5, '#e8ecef') // handles
      px(g, 1, 15, 14, 1, WALL_BASE)
      break
    case 'sofaC':
      woodBase()
      px(g, 0, 2, TILE, 5, SOFA_BODY)
      px(g, 0, 7, TILE, 6, SOFA_SEAT)
      px(g, 8, 7, 1, 6, 'rgba(0,0,0,0.2)') // cushion seam
      px(g, 0, 7, TILE, 1, 'rgba(255,255,255,0.08)')
      sofaLegs()
      break
    case 'sofaW':
      woodBase()
      px(g, 0, 2, 3, 10, SOFA_DARK) // arm
      px(g, 3, 2, 13, 5, SOFA_BODY)
      px(g, 3, 7, 13, 6, SOFA_SEAT)
      sofaLegs()
      break
    case 'sofaE':
      woodBase()
      px(g, 13, 2, 3, 10, SOFA_DARK) // arm
      px(g, 0, 2, 13, 5, SOFA_BODY)
      px(g, 0, 7, 13, 6, SOFA_SEAT)
      sofaLegs()
      break
    case 'armchair':
      woodBase()
      px(g, 1, 3, 3, 9, SOFA_DARK); px(g, 12, 3, 3, 9, SOFA_DARK) // arms
      px(g, 3, 2, 10, 4, SOFA_BODY)
      px(g, 4, 6, 8, 6, SOFA_SEAT)
      sofaLegs()
      break
    case 'loungeTable':
      woodBase()
      px(g, 2, 3, 12, 10, TABLE_WOOD)
      px(g, 2, 3, 12, 2, TABLE_EDGE)
      px(g, 5, 6, 4, 3, '#e8ecef') // magazine
      px(g, 5, 6, 4, 1, '#c92a2a')
      px(g, 2, 13, 12, 1, 'rgba(0,0,0,0.2)')
      break
    case 'rug': rugBase(); break
    case 'lamp':
      rugBase() // both lamps sit on the lounge rug
      px(g, 7, 6, 2, 8, LAMP_POLE)
      px(g, 5, 14, 6, 1, LAMP_POLE)
      px(g, 4, 1, 8, 5, LAMP_SHADE)
      px(g, 3, 5, 10, 1, LAMP_SHADE)
      px(g, 5, 2, 2, 2, '#f6dfa8') // inner glow
      break
    case 'void':
      px(g, 0, 0, TILE, TILE, VOID)
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

  const pants = '#33404f' // lifted chino tone — navy read muddy on warm wood
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
    px(g, 4, 0, 2, 1, 'rgba(255,255,255,0.18)') // hair shine
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
    px(g, 3, 10, 6, 1, 'rgba(0,0,0,0.20)') // shirt-hem shade
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
