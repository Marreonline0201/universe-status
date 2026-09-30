// Background colour and brightness for the fluid scenes (LAB + FLUID TEST). The colour is one of BG_PRESETS (the
// owner-chosen olive #b1b366 by default); the slider scales its brightness. Both are persisted and shared by both
// pages; olive at 1.0 reproduces the original backdrop exactly.
export const BG_BASE = { r: 0.694, g: 0.702, b: 0.400 } // #b1b366 — the one source of truth

/** Background colour presets (owner, 2026-09-30: "make the background color able to change — you choose the colors that
 *  will make the liquid visible"), chosen from the renderer's own optics: per liquid, the CIEDE2000 difference between
 *  the liquid over the backdrop and the bare backdrop, and the floor grid's contrast — refraction of the grid, the tank
 *  edges and sun sparkles are what show a clear liquid (vault fluid/realism-2026-09/research/bg-palette-2026-09-30.md).
 *  sRGB-encoded like BG_BASE; `grid` is the floor's grid-line colour; each is scaled by the brightness slider up to the
 *  preset's cap (bgBrightnessMaxFor). Olive, the owner's original, is the default and BG_BASE exactly, so a page that
 *  never picks another renders as before. ΔE00 vs the bare backdrop: water at 10 / 35 cm, mercury, sun sparkle, grid. */
export interface BgPreset { id: string; name: string; base: { r: number; g: number; b: number }; grid: readonly [number, number, number] }
export const BG_PRESETS: readonly BgPreset[] = [
  // #b1b366 / grid #80823d: the default — water 0.61 / 2.08, mercury 5.6, sparkle 28.6, grid 15.8
  { id: 'olive', name: 'Olive', base: { r: 0.694, g: 0.702, b: 0.4 }, grid: [0.5, 0.51, 0.24] },
  // #f2f2f2 / #b0b0b0: water's tint shows most (water removes red; a neutral backdrop keeps T × L exact); sparkles vanish
  // — water 1.30 / 4.14, mercury 5.5, sparkle 2.6, grid 15.8
  { id: 'white', name: 'White', base: { r: 0.949, g: 0.949, b: 0.949 }, grid: [0.69, 0.69, 0.69] },
  // #d0d0d0 / #979797: nearly White's water with the sparkles kept — water 1.16 / 3.75, mercury 5.5, sparkle 10.2, grid 15.7
  { id: 'lightgrey', name: 'Light grey', base: { r: 0.816, g: 0.816, b: 0.816 }, grid: [0.592, 0.592, 0.592] },
  // #888888 / #606060: all-round — water 0.87 / 2.84, mercury 5.6, sparkle 30.5, grid 15.9
  { id: 'midgrey', name: 'Mid grey', base: { r: 0.533, g: 0.533, b: 0.533 }, grid: [0.376, 0.376, 0.376] },
  // #333333 / #626262 (lighter lines): sparkles and the blue tank edges stand out; water's tint does not show at 10 cm —
  // water 0.45 / 1.49, mercury 2.05, sparkle 68.7, grid 16.0
  { id: 'charcoal', name: 'Charcoal', base: { r: 0.2, g: 0.2, b: 0.2 }, grid: [0.384, 0.384, 0.384] },
]
export const DEFAULT_BG_PRESET = 'olive'
export const BG_PRESET_KEY = 'universe-fluid-bg-preset'
/** The preset with this id; the olive default for an unknown id. */
export const bgPreset = (id: string): BgPreset => BG_PRESETS.find(p => p.id === id) ?? BG_PRESETS[0]
/** Stored preset id; the olive default when unset or unknown. */
export function readBgPreset(): string {
  try { return bgPreset(localStorage.getItem(BG_PRESET_KEY) ?? '').id } catch { return DEFAULT_BG_PRESET }
}
export function writeBgPreset(id: string): void {
  try { localStorage.setItem(BG_PRESET_KEY, bgPreset(id).id) } catch { /* storage off */ }
}
/** The brightest the slider may make a preset: above 1/(its largest encoded channel) the backdrop clips to white, and
 *  water's tint and mercury's contrast vanish with it (bg-palette note §4.3: White clips above ×1.05, Light grey
 *  above ×1.23). Olive keeps the slider's original range — the owner's default is unchanged (it clips in green above
 *  ×1.42). */
export function bgBrightnessMaxFor(id: string): number {
  const p = bgPreset(id)
  return p.id === DEFAULT_BG_PRESET ? BG_BRIGHTNESS_MAX : Math.min(BG_BRIGHTNESS_MAX, 1 / Math.max(p.base.r, p.base.g, p.base.b))
}
/** clampBrightness, then no brighter than the preset's own cap. */
export const clampBrightnessFor = (id: string, v: number): number => Math.min(bgBrightnessMaxFor(id), clampBrightness(v))

export const BG_BRIGHTNESS_KEY = 'universe-fluid-bg-brightness'
export const BG_BRIGHTNESS_MIN = 0.2
export const BG_BRIGHTNESS_MAX = 1.5

export const clampBrightness = (v: number): number =>
  Math.min(BG_BRIGHTNESS_MAX, Math.max(BG_BRIGHTNESS_MIN, v))

/** Stored preference, clamped; 1.0 (the unmodified olive) when unset/invalid. */
export function readBgBrightness(): number {
  try {
    const v = parseFloat(localStorage.getItem(BG_BRIGHTNESS_KEY) ?? '')
    return Number.isFinite(v) ? clampBrightness(v) : 1
  } catch { return 1 }
}

export function writeBgBrightness(v: number): void {
  try { localStorage.setItem(BG_BRIGHTNESS_KEY, String(clampBrightness(v))) } catch { /* storage off */ }
}
