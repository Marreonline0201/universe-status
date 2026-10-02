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
//   figures drawn, the object states drawn) and the banner text; then stops the example and checks the note comes back.
// - Then the LIVE path, end to end except the owner's folder grant: a stand-in spool folder in this throwaway profile's
//   origin-private file system (OPFS) holds a day file of SYNTHETIC lines (the example's records on the wall clock); the
//   page's folder picker is stubbed to return it, and the real "Connect log folder" button is clicked: the hook keeps the
//   handle, its Web Worker reads the folder through File System Access, the office snaps to the backlog and follows
//   lines appended later. Not run: the real picker and Chrome's permission prompt (they need a person), and the read of
//   the kept handle on a later visit (headless Chrome 153 under Playwright crashes when it reads an OPFS handle back
//   from IndexedDB, even on a bare page). The stand-in is removed at the end. Console errors are reported. PNGs go to
//   scripts/out/ (git-ignored). Exit 1 on a failed check.
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
const LIVE = 'LIVE — read from your log folder on this computer; nothing is sent anywhere'
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
  const live = document.querySelector('[data-wo="live-state"]')?.textContent ?? ''
  return {
    workers: d.workers, feed: d.feed, seconds: d.feedSeconds, figures: d.figuresDrawn, scale: d.deviceScale, banner, live,
    objects: [...d.objectStates], liveReady: d.liveReady, liveSnaps: [...d.liveSnaps], liveLines: d.liveLines,
  }
})
/** The object states as `kind|state` counts (the tile positions are in the full list). */
const kinds = list => Object.entries(list.reduce((m, n) => { const k = n.split('@')[0]; m[k] = (m[k] ?? 0) + 1; return m }, {})).map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join(', ') || 'none'

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
    console.log(`       object states: ${kinds(st.objects)}`)
    console.log(`       at tiles (#worker): ${st.objects.join(' ') || '-'}`)
  }
  await page.click('[data-wo="example"]')
  await page.waitForTimeout(800)
  const after = await state(page)
  check(after.banner === NO_FEED && after.workers === 0 && after.feed === 'none' && after.live === 'not connected',
    `Stop example: the note "${after.banner}" again, ${after.workers} workers; the live feed: "${after.live}"`)

  // ── LIVE, through the page's own reader, with a stand-in folder (OPFS) ──
  const { exampleRecords } = await import('../src/worker-office/live/example.ts')
  const base = Date.now() - 45_000
  const recs = exampleRecords().map(r => ({ at: r.at, line: JSON.stringify({ v: 1, ts: base + r.at, ...r.rec }) }))
  const backlog = recs.filter(r => r.at <= 30_000).map(r => r.line)
  const later = recs.filter(r => r.at > 30_000 && r.at <= 44_000).map(r => r.line)
  await page.evaluate(async lines => {
    const d = new Date()
    const day = `events-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('wo-spool-standin', { create: true })
    const w = await (await dir.getFileHandle(day, { create: true })).createWritable()
    await w.write(lines.join('\n') + '\n')
    await w.close()
    // the picker returns the stand-in (the owner picks the real spool folder here)
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('wo-spool-standin')
  }, backlog)
  const live0 = await page.evaluate(() => document.querySelector('[data-wo="live-state"]')?.textContent ?? '')
  check(live0 === 'not connected', `before connecting: the live feed says "${live0}"`)
  await page.click('[data-wo="live-connect"]')
  await page.waitForFunction(() => window.__workerOffice?.feed === 'live' && window.__workerOffice.liveReady && window.__workerOffice.workers > 0, null, { timeout: 30_000 })
  await page.waitForTimeout(2500)
  const l1 = await state(page)
  const f1 = path.join(OUT, 'worker-office-live-1-connected.png')
  await page.screenshot({ path: f1 })
  check(l1.feed === 'live' && l1.banner === LIVE && l1.live === 'connected · live' && l1.liveSnaps[0] === 'connect' && l1.liveLines === backlog.length && l1.workers > 0,
    `live (stand-in folder): "${l1.live}", the note "${l1.banner}", the connect snap applied the ${l1.liveLines} backlog lines, ${l1.workers} workers on screen -> ${path.relative(ROOT, f1)}`)
  console.log(`       object states: ${kinds(l1.objects)}`)
  await page.evaluate(async lines => {
    const d = new Date()
    const day = `events-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`
    const root = await navigator.storage.getDirectory()
    const fh = await (await root.getDirectoryHandle('wo-spool-standin')).getFileHandle(day)
    const size = (await fh.getFile()).size
    const w = await fh.createWritable({ keepExistingData: true })
    await w.seek(size)
    await w.write(lines.join('\n') + '\n')
    await w.close()
  }, later)
  const t0 = Date.now()
  await page.waitForFunction(n => (window.__workerOffice?.liveLines ?? 0) >= n, backlog.length + later.length, { timeout: 10_000 })
  const followMs = Date.now() - t0
  await page.waitForTimeout(3000)
  const l2 = await state(page)
  const f2 = path.join(OUT, 'worker-office-live-2-following.png')
  await page.screenshot({ path: f2 })
  check(l2.feed === 'live' && l2.liveLines === backlog.length + later.length && followMs < 2500 && l2.liveSnaps.length === 1,
    `live: ${later.length} lines appended to the file came in ${followMs} ms (the 500 ms poll), ${l2.liveLines} lines in all, no other snap, ${l2.workers} workers -> ${path.relative(ROOT, f2)}`)
  console.log(`       object states: ${kinds(l2.objects)}`)
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry('wo-spool-standin', { recursive: true })
    await new Promise(res => { const r = indexedDB.deleteDatabase('universe-worker-office'); r.onsuccess = r.onerror = r.onblocked = () => res(true) })
  })
  check(errors.length === 0, `no page errors or console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  if (browser) await browser.close()
  await server.close()
}
if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ALL PASS')
