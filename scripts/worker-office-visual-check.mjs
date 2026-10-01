// Visual check of the WORKER OFFICE tab (plan §6.1). Run: node scripts/worker-office-visual-check.mjs
//
// - Vite is started through its API on 127.0.0.1:5180 (strict port; never 5173, the owner's page) with its
//   dependency cache in a temp folder (WO_VITE_CACHE, default <os tmp>/universe-wo-vite-cache), so it never writes
//   node_modules/.vite — which may be another checkout's, through a junction. Server and browser stop in `finally`.
// - Chrome opens HEADED only on a second display (scripts/lib/window.mjs windowArgs()); with no second display it
//   runs HEADLESS. It never opens a window over the owner's primary screen.
// - Refuses to start below 1.5 GB of free RAM (owner's rule: one heavy process at a time on a 16 GB laptop).
// Checks, at 1440×900 DPR 1 and at 1707×1067 DPR 1.5 (the owner's screen):
//   zoom × DPR is an integer, and zoom = 2.0 at 1440×900 (plan §6.1); the backing store is the device-pixel size;
//   every texel of a test region is an exact block of identical pixels equal to the pre-rendered texel;
//   the floor finish lies under object tiles (two-layer pre-render); room labels come from the zones;
//   the tab is WORKER OFFICE, shows "No live feed — live only on the owner's computer" and never "npm run office";
//   the map is pre-rendered once and the engine survives tab switches (no rebuild, same camera).
// PNGs go to scripts/out/ (git-ignored). Exits 1 on any failed check.
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowArgs } from './lib/window.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'scripts', 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 5180
const BANNER = "No live feed — live only on the owner's computer"
const EXPECTED_LABELS = ['LIBRARY', 'RECORDS', 'WORK ROOM', 'MEETING', 'BREAK ROOM', 'RECEPTION', 'SERVERS', 'MAIL / PRINT CORNER', 'CORRIDOR', 'SIDEWALK']
/** The app shell still tries the old office socket; nothing listens there and nothing is started. */
const EXPECTED_NOISE = /ws:\/\/localhost:4571|WebSocket connection to 'ws:\/\/localhost:4571/

/** Free RAM in GB, read the way the owner's rule reads it (CIM FreePhysicalMemory); os.freemem() elsewhere. */
function freeRamGb() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB'], { encoding: 'utf8', timeout: 15_000 }).trim()
      const v = parseFloat(out)
      if (Number.isFinite(v)) return v
    } catch { /* fall back below */ }
  }
  return os.freemem() / 2 ** 30
}
const freeGb = freeRamGb()
if (freeGb < 1.5) { console.error(`free RAM ${freeGb.toFixed(2)} GB < 1.5 GB — not starting a dev server and a browser`); process.exit(2) }

let failures = 0
const check = (ok, what) => { if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}`) } }

mkdirSync(OUT, { recursive: true })
const server = await createServer({
  root: ROOT,
  // 'native': Node imports vite.config.ts itself; the default 'bundle' loader writes node_modules/.vite-temp/
  configLoader: 'native',
  cacheDir: process.env.WO_VITE_CACHE ?? path.join(os.tmpdir(), 'universe-wo-vite-cache'),
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
  clearScreen: false,
})
let browser = null
try {
  await server.listen()
  const placement = windowArgs()
  const headless = placement.length === 0
  console.log(`vite on http://127.0.0.1:${PORT}; Chrome ${headless ? 'HEADLESS (no second display found)' : `on the second display ${placement.join(' ')}`}; free RAM ${freeGb.toFixed(2)} GB`)
  browser = await chromium.launch({ executablePath: CHROME, headless, args: placement })

  for (const vp of [{ w: 1440, h: 900, dpr: 1 }, { w: 1707, h: 1067, dpr: 1.5 }]) {
    const name = `${vp.w}x${vp.h}-dpr${vp.dpr}`
    console.log(`viewport ${name}`)
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push(m.text().slice(0, 300)) })
    await page.goto(`http://127.0.0.1:${PORT}/?tab=agents`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window.__workerOffice?.draws ?? 0) > 0, null, { timeout: 120_000 })
    await page.evaluate(async () => { await document.fonts.ready; return true })
    await page.waitForTimeout(400)
    const state = () => page.evaluate(() => { const { floorTexel: _f, mapTexel: _m, ...d } = window.__workerOffice; return d })
    const d = await state()
    console.log(`  state ${JSON.stringify(d)}`)

    check(Number.isInteger(d.deviceScale) && Math.abs(d.zoom * d.dpr - Math.round(d.zoom * d.dpr)) < 1e-9, `zoom × DPR = ${d.zoom} × ${d.dpr} = ${d.zoom * d.dpr} is an integer`)
    if (vp.w === 1440 && vp.h === 900) check(d.zoom === 2, `zoom at 1440×900 is 2.0 (plan §6.1), got ${d.zoom}`)
    check(Math.abs(d.backing[0] - d.css[0] * d.dpr) <= 1 && Math.abs(d.backing[1] - d.css[1] * d.dpr) <= 1, `backing store ${d.backing} = CSS ${d.css} × DPR ${d.dpr}`)
    check(Number.isInteger(d.offset[0]) && Number.isInteger(d.offset[1]), `camera offset ${d.offset} is whole device pixels`)
    check(d.prerenders === 1 && d.engines === 1, `pre-rendered once, one engine (prerenders ${d.prerenders}, engines ${d.engines})`)
    check(d.workers === 0, 'zero workers')
    check(JSON.stringify(d.labels) === JSON.stringify(EXPECTED_LABELS), `room labels from the zones: ${d.labels.join(', ')}`)

    // texels are exact blocks: corridor tiles x 12..20, y 11..12 (no label, no state layer there)
    const blocks = await page.evaluate(({ tx0, tx1, ty0, ty1 }) => {
      const dbg = window.__workerOffice
      const c = document.querySelector('canvas[title^="Drag to pan"]')
      const g = c.getContext('2d')
      const s = dbg.deviceScale, [ox, oy] = dbg.offset
      const x0 = ox + tx0 * 16 * s, y0 = oy + ty0 * 16 * s, w = (tx1 - tx0 + 1) * 16 * s, h = (ty1 - ty0 + 1) * 16 * s
      const img = g.getImageData(x0, y0, w, h).data
      let bad = 0, texels = 0, wrong = 0
      for (let ty = 0; ty < h / s; ty++) for (let tx = 0; tx < w / s; tx++) {
        texels++
        const i0 = ((ty * s) * w + tx * s) * 4
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
          const i = ((ty * s + dy) * w + tx * s + dx) * 4
          if (img[i] !== img[i0] || img[i + 1] !== img[i0 + 1] || img[i + 2] !== img[i0 + 2]) bad++
        }
        const want = dbg.mapTexel(tx0 * 16 + tx, ty0 * 16 + ty)
        const got = `rgba(${img[i0]},${img[i0 + 1]},${img[i0 + 2]},1)`
        if (want !== got) wrong++
      }
      return { texels, bad, wrong, s }
    }, { tx0: 12, tx1: 20, ty0: 11, ty1: 12 })
    check(blocks.bad === 0 && blocks.wrong === 0, `${blocks.texels} texels drawn as exact ${blocks.s}×${blocks.s} blocks equal to the pre-render (non-uniform pixels ${blocks.bad}, wrong texels ${blocks.wrong})`)

    // two-layer pre-render: the finish under an object tile equals the same finish on a plain tile of the same
    // position variant; the composite there shows the object
    const layers = await page.evaluate(() => {
      const dbg = window.__workerOffice
      const at = (t) => [t[0] * 16 + 8, t[1] * 16 + 8]
      return [[[12, 7], [16, 3], 'historyShelf on RECORDS vinyl'], [[27, 4], [31, 4], 'benchTerminal on WORK ROOM oak'], [[8, 18], [12, 14], 'sofa on BREAK ROOM checker']]
        .map(([obj, plain, what]) => ({ what, under: dbg.floorTexel(...at(obj)), plain: dbg.floorTexel(...at(plain)), composite: dbg.mapTexel(...at(obj)) }))
    })
    for (const l of layers) check(l.under === l.plain && l.composite !== l.under, `floor under ${l.what}: ${l.under} (plain tile ${l.plain}; object on top ${l.composite})`)

    const text = await page.evaluate(() => document.body.innerText)
    check(text.includes(BANNER), `banner "${BANNER}" shown`)
    check(!text.includes('npm run office'), 'no "npm run office" on the page')
    const tabs = await page.$$eval('button', bs => bs.map(b => b.textContent.trim()))
    check(tabs.includes('WORKER OFFICE') && !tabs.includes('AGENT OFFICE'), `tab label WORKER OFFICE (tabs: ${tabs.filter(t => /^[A-Z ]+$/.test(t)).join(' | ')})`)

    const shot = path.join(OUT, `worker-office-step1-${name}.png`)
    await page.screenshot({ path: shot })
    console.log(`  saved ${shot}`)
    // close-up of reception, door and sidewalk at the page's own scale
    const clip = await page.evaluate(() => {
      const dbg = window.__workerOffice
      const r = document.querySelector('canvas[title^="Drag to pan"]').getBoundingClientRect()
      const css = (dev) => dev / dbg.dpr
      const s = dbg.deviceScale, [ox, oy] = dbg.offset
      return { x: r.left + css(ox + 12 * 16 * s), y: r.top + css(oy + 12 * 16 * s), width: css(22 * 16 * s), height: css(11 * 16 * s) }
    })
    const crop = path.join(OUT, `worker-office-step1-${name}-reception.png`)
    await page.screenshot({ path: crop, clip })
    console.log(`  saved ${crop}`)

    // tab switch: away and back — no rebuild, same engine, same camera; hidden while away
    await page.getByRole('button', { name: 'REPORTS' }).click()
    await page.waitForTimeout(300)
    const away = await state()
    check(away.active === false, 'drawing pauses while another tab is shown')
    await page.getByRole('button', { name: 'WORKER OFFICE' }).click()
    await page.waitForFunction((n) => window.__workerOffice.draws > n, away.draws, { timeout: 10_000 })
    const back = await state()
    check(back.prerenders === 1 && back.engines === 1 && back.active, `after a tab switch: prerenders ${back.prerenders}, engines ${back.engines}, active ${back.active}`)
    check(back.deviceScale === d.deviceScale && back.offset[0] === d.offset[0] && back.offset[1] === d.offset[1], `camera kept across the switch (scale ${back.deviceScale}, offset ${back.offset})`)

    check(errors.length === 0, `no page errors (${errors.length ? errors.join(' | ') : 'none besides the old office socket on :4571'})`)
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  await server.close()
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('visual check: ALL PASS')
