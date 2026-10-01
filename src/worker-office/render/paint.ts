// Pixel-art drawing primitives shared by the worker office renderers. Everything is drawn with rects at
// 1 texel = 1 canvas pixel; the engine scales the result by an integer factor with smoothing off.

export type Ctx = CanvasRenderingContext2D

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas unavailable')
  g.imageSmoothingEnabled = false
  return [c, g]
}

export function px(g: Ctx, x: number, y: number, w: number, h: number, color: string) {
  g.fillStyle = color
  g.fillRect(x, y, w, h)
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')

/** Linear mix of two #rrggbb colours: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b)
  return `#${hex2(ar + (br - ar) * t)}${hex2(ag + (bg - ag) * t)}${hex2(ab + (bb - ab) * t)}`
}

export const lighten = (c: string, t: number) => mix(c, '#ffffff', t)
export const darken = (c: string, t: number) => mix(c, '#000000', t)

/** #rrggbb + alpha -> rgba() */
export function alpha(c: string, a: number): string {
  const [r, g, b] = rgb(c)
  return `rgba(${r},${g},${b},${a})`
}
