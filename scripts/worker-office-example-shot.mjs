// Screenshots of the WORKER OFFICE tab while the EXAMPLE feed plays (plan §6.4; the visual check's pattern).
// Run: node scripts/worker-office-example-shot.mjs
//
// - Refuses to start on battery (exit 4) or below 1.5 GB of free RAM (exit 2): the owner's rules for browser work.
// - Vite through its API on 127.0.0.1:5180 (strict port; never the owner's dev server), its dependency cache in a temp
//   folder (WO_VITE_CACHE, default <os tmp>/universe-wo-vite-cache). Chrome is ALWAYS headless here. Both stop in
//   `finally`.
// - One viewport: 1440×900 at DPR 1 (the DPR 1.5 / 2 viewports have the known harness defect F12).
// - Opens the tab, shoots it before the example (the no-live-feed note), clicks "Play example", and shoots it at a few
//   moments of the example, reading the engine's debug state each time (workers on screen, the example's clock, the
//   figures drawn) and the banner text; then stops the example and checks the note comes back. Console errors are
//   reported. PNGs go to scripts/out/ (git-ignored). Exit 1 on a failed check.
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'scripts', 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 5180
const NO_FEED = "No live feed — live only on the owner's computer"
const EXAMPLE = 'EXAMPLE — synthetic events, not live data'
const EXPECTED_NOISE = /ws:\/\/localhost:4571|WebSocket connection to 'ws:\/\/localhost:4571/
/** Moments of the example to shoot (s of its own clock) and what should be on screen by then. */
const SHOTS = [
  { at: 12, name: 'early', min: 2 },
  { at: 30, name: 'working', min: 3 },
  { at: 47, name: 'pair-arrives', min: 4 },
  { at: 66, name: 'front-desk', min: 2 },
  { at: 112, name: 'lounge', min: 1 },
]

function ps(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 15_000 }).trim()
}
const onAc = () => { try { return ps('(Get-CimInstance -ClassName BatteryStatus -Namespace root/wmi -ErrorAction SilentlyContinue | Select-Object -First 1).PowerOnline') !== 'False' } catch { return true } }
const freeGb = () => { try { return parseFloat(ps('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB')) } catch { return os.freemem() / 2 ** 30 } }

if (process.platform === 'win32' && !onAc()) { console.error('on battery: not starting a dev server and a browser'); process.exit(4) }
const gb = freeGb()
if (gb < 1.5) { console.error(`free RAM ${gb.toFixed(2)} GB < 1.5 GB: not starting a dev server and a browser`); process.exit(2) }
const { createServer } = await import('vite')
const { chromium } = await import('playwright-core')

let failures = 0
const check = (ok, what) => { if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}`) } }
const state = page => page.evaluate(() => {
  const d = window.__workerOffice
  const banner = document.querySelector('[data-wo="banner"]')?.textContent ?? ''
  return { workers: d.workers, feed: d.feed, seconds: d.feedSeconds, figures: d.figuresDrawn, scale: d.deviceScale, banner }
})

mkdirSync(OUT, { recursive: true })
const server = await createServer({
  root: ROOT,
  configLoader: 'native',
  cacheDir: process.env.WO_VITE_CACHE ?? path.join(os.tmpdir(), 'universe-wo-vite-cache'),
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
  clearScreen: false,
})
let browser = null
try {
  await server.listen()
  console.log(`vite on http://127.0.0.1:${PORT}; Chrome HEADLESS; free RAM ${gb.toFixed(2)} GB; 1440×900 DPR 1`)
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push(m.text().slice(0, 300)) })
  await page.goto(`http://127.0.0.1:${PORT}/?tab=agents`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window.__workerOffice?.draws ?? 0) > 0, null, { timeout: 120_000 })
  await page.evaluate(async () => { await document.fonts.ready; return true })
  await page.waitForTimeout(800)
  const before = await state(page)
  check(before.banner === NO_FEED && before.workers === 0 && before.feed === 'none', `before the example: the note "${before.banner}", ${before.workers} workers`)
  await page.screenshot({ path: path.join(OUT, 'worker-office-example-0-before.png') })

  await page.click('[data-wo="example"]')
  for (const s of SHOTS) {
    await page.waitForFunction(at => (window.__workerOffice?.feedSeconds ?? 0) >= at, s.at, { timeout: (s.at + 30) * 1000 })
    const st = await state(page)
    const file = path.join(OUT, `worker-office-example-${s.at}s-${s.name}.png`)
    await page.screenshot({ path: file })
    check(st.feed === 'example' && st.banner === EXAMPLE && st.workers >= s.min && st.figures >= s.min,
      `${s.at} s (${s.name}): the note "${st.banner}", ${st.workers} workers on screen, ${st.figures} figures drawn, scale ${st.scale} -> ${path.relative(ROOT, file)}`)
  }
  await page.click('[data-wo="example"]')
  await page.waitForTimeout(800)
  const after = await state(page)
  check(after.banner === NO_FEED && after.workers === 0 && after.feed === 'none', `Stop example: the note "${after.banner}" again, ${after.workers} workers`)
  check(errors.length === 0, `no page errors or console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  if (browser) await browser.close()
  await server.close()
}
if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS')
