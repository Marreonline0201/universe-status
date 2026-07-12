// Background brightness for the fluid scenes (LAB + FLUID TEST). The hue is fixed —
// the owner-chosen olive #b1b366 — and the slider scales ONLY its brightness. One
// persisted knob shared by both pages; 1.0 reproduces the base olive exactly.
export const BG_BASE = { r: 0.694, g: 0.702, b: 0.400 } // #b1b366 — the one source of truth

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
