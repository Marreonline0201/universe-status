// window.mjs — where automated Chrome windows open. Owner 2026-09-29: "put the chrome popups on another display from now
// on" — test and bench runs open on a display other than the primary one when there is one, so they never cover the
// owner's working screen. Exception (owner, same day): timing tests ({ timing: true } — the clock/frame-pacing gate and
// the FPS benchmark) stay on the primary display, where their criteria were set: the second display (the 240 Hz laptop
// panel) presents differently (s1-clock G3: 90.6 / 96.3 % of frames within 1 % there vs 99.3 / 99.8 % on the primary).
// FLUID_WINDOW=primary keeps the default placement for every run; FLUID_WINDOW=x,y places the window there.
import { execFileSync } from 'node:child_process'

const cache = new Map()

/** Chrome launch arguments that place the window (empty: the primary display — timing runs, or no second display). */
export function windowArgs({ timing = false } = {}) {
  const key = timing ? 'timing' : 'default'
  if (cache.has(key)) return cache.get(key)
  const env = process.env.FLUID_WINDOW
  let pos = null
  if (env && /^-?\d+,-?\d+$/.test(env)) pos = env
  else if (!timing && env !== 'primary' && process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | '
        + 'Select-Object -First 1 | ForEach-Object { "$($_.WorkingArea.X),$($_.WorkingArea.Y)" }'], { encoding: 'utf8', timeout: 15_000 }).trim()
      if (/^-?\d+,-?\d+$/.test(out)) { const [x, y] = out.split(',').map(Number); pos = `${x + 20},${y + 20}` }
    } catch { /* no second display found: default placement */ }
  }
  const args = pos ? [`--window-position=${pos}`] : []
  cache.set(key, args)
  return args
}
