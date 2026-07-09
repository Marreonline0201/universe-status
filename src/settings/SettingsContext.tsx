// Global UI settings — a single font-size scale that all sections share.
// The scale is published to the document root as the CSS variable `--font-scale`;
// every inline `fontSize` in the app is written as `calc(<px> * var(--font-scale, 1))`,
// so one value scales all DOM text at once WITHOUT a root transform (which would blur
// and mis-hit-test the WebGPU/2D canvases in Lab / Fluid Test / Agent Office).
// (Agent USAGE limits are a separate, office-side control — see SettingsPanel.)
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const SCALE_KEY = 'universe-font-scale'

export const DEFAULT_SCALE = 1.0
// Fixed, sensible bounds for the slider — small enough to stay readable, large enough
// to help, without letting a layout break.
export const FONT_MIN = 0.7
export const FONT_MAX = 2.5

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function readNum(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '')
    return Number.isFinite(v) ? v : fallback
  } catch { return fallback }
}

export interface Settings {
  scale: number
  setScale: (s: number) => void
  reset: () => void
}

const SettingsCtx = createContext<Settings | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState(() => clamp(readNum(SCALE_KEY, DEFAULT_SCALE), FONT_MIN, FONT_MAX))

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(scale))
    try { localStorage.setItem(SCALE_KEY, String(scale)) } catch { /* storage disabled — just won't persist */ }
  }, [scale])

  const setScale = (s: number) => setScaleState(clamp(s, FONT_MIN, FONT_MAX))
  const reset = () => setScaleState(DEFAULT_SCALE)

  return (
    <SettingsCtx.Provider value={{ scale, setScale, reset }}>
      {children}
    </SettingsCtx.Provider>
  )
}

export function useSettings(): Settings {
  const ctx = useContext(SettingsCtx)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}
