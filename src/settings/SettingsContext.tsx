// Global UI settings — currently a single font-size scale that all sections share.
// The scale is published to the document root as the CSS variable `--font-scale`;
// every inline `fontSize` in the app is written as `calc(<px> * var(--font-scale, 1))`,
// so one value scales all DOM text at once WITHOUT a root transform (which would blur
// and mis-hit-test the WebGPU/2D canvases in Lab / Fluid Test / Agent Office).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const SCALE_KEY = 'universe-font-scale'
const MIN_KEY = 'universe-font-min'
const MAX_KEY = 'universe-font-max'

export const DEFAULT_SCALE = 1.0
export const DEFAULT_MIN = 0.8
export const DEFAULT_MAX = 2.0
// Hard rails so the user's own min/max can't push the UI into an unusable range.
export const HARD_MIN = 0.5
export const HARD_MAX = 3.0

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function readNum(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '')
    return Number.isFinite(v) ? v : fallback
  } catch { return fallback }
}

export interface Settings {
  scale: number
  min: number
  max: number
  setScale: (s: number) => void
  setMin: (m: number) => void
  setMax: (m: number) => void
  reset: () => void
}

const SettingsCtx = createContext<Settings | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [min, setMinState] = useState(() => clamp(readNum(MIN_KEY, DEFAULT_MIN), HARD_MIN, HARD_MAX))
  const [max, setMaxState] = useState(() => clamp(readNum(MAX_KEY, DEFAULT_MAX), HARD_MIN, HARD_MAX))
  const [scale, setScaleState] = useState(() => readNum(SCALE_KEY, DEFAULT_SCALE))

  // Publish the effective (clamped) scale to the root + persist, on any change.
  useEffect(() => {
    const lo = Math.min(min, max), hi = Math.max(min, max)
    document.documentElement.style.setProperty('--font-scale', String(clamp(scale, lo, hi)))
    try {
      localStorage.setItem(SCALE_KEY, String(scale))
      localStorage.setItem(MIN_KEY, String(min))
      localStorage.setItem(MAX_KEY, String(max))
    } catch { /* private mode / storage disabled — settings just won't persist */ }
  }, [scale, min, max])

  const setScale = (s: number) => setScaleState(clamp(s, Math.min(min, max), Math.max(min, max)))
  const setMin = (m: number) => {
    const mn = clamp(m, HARD_MIN, HARD_MAX)
    setMinState(mn)
    setScaleState(s => clamp(s, Math.min(mn, max), Math.max(mn, max)))
  }
  const setMax = (m: number) => {
    const mx = clamp(m, HARD_MIN, HARD_MAX)
    setMaxState(mx)
    setScaleState(s => clamp(s, Math.min(min, mx), Math.max(min, mx)))
  }
  const reset = () => { setMinState(DEFAULT_MIN); setMaxState(DEFAULT_MAX); setScaleState(DEFAULT_SCALE) }

  return (
    <SettingsCtx.Provider value={{ scale, min, max, setScale, setMin, setMax, reset }}>
      {children}
    </SettingsCtx.Provider>
  )
}

export function useSettings(): Settings {
  const ctx = useContext(SettingsCtx)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}
