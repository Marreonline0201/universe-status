// Visual check of the WORKER OFFICE tab (plan §6.1). Run: node scripts/worker-office-visual-check.mjs
//
// - Vite is started through its API on 127.0.0.1:5180 (strict port; never 5173, the owner's page) with its
//   dependency cache in a temp folder (WO_VITE_CACHE, default <os tmp>/universe-wo-vite-cache), so it never writes
//   node_modules/.vite — which may be another checkout's, through a junction. Server and browser stop in `finally`.
// - Chrome opens HEADED only on a second display (scripts/lib/window.mjs windowArgs()); with no second display it
//   runs HEADLESS. It never opens a window over the owner's primary screen.
// - Refuses to start below 1.5 GB of free RAM (owner's rule: one heavy process at a time on a 16 GB laptop).
// Checks, in a real browser, at 1440×900 DPR 1 (default sidebar, and the sidebar dragged to 340 px), 1707×1067
// DPR 1.5 (the owner's screen) and 400×800 DPR 2 (a phone):
//   zoom × DPR is an integer; zoom = 2.0 at 1440×900 with the sidebar at 300 or 340 px (plan §6.1, D5); the backing
//   store is the device-pixel size; every texel of a test region is an exact block of identical pixels equal to the
//   pre-rendered texel; the floor finish lies under object tiles (two-layer pre-render); room labels come from the
//   zones; the building's top edge lies below the overlay whenever the canvas has room; the note "No live feed —
//   live only on the owner's computer" is fully visible inside the map column (on the phone: wrapped, not clipped)
//   and "npm run office" never appears; the phone gets the map full width with the room key under it; the tab is
//   WORKER OFFICE; the canvas is a named, focusable image that zooms and fits from the keyboard; every text in the
//   tab meets 4.5:1 on its real background; opening the tab opens no new socket (the app shell's own sockets are
//   App.tsx's, plan §5.3); the map is pre-rendered once and the engine survives tab switches.
//   And with a broken floorplan (the ?raw module answered with "{}"), the tab shows the note and the loader's error
//   while the header and the other tabs keep working.
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
const SIDEBAR_W_KEY = 'universe-worker-office-sidebar-w'
const VIEWPORTS = [
  { name: '1440x900-dpr1', w: 1440, h: 900, dpr: 1, zoom: 2 },
  { name: '1440x900-dpr1-sidebar340', w: 1440, h: 900, dpr: 1, zoom: 2, sidebar: 340 },
  { name: '1707x1067-dpr1.5', w: 1707, h: 1067, dpr: 1.5, zoom: 2 },
  { name: '400x800-dpr2', w: 400, h: 800, dpr: 2, narrow: true },
]

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
/** Switch tabs with a DOM click: at phone width the header's tab buttons run past the screen edge (pre-existing,
 *  App.tsx), which is not what this check is about. */
const openTab = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === l)
  if (!b) throw new Error(`no ${l} tab`)
  b.click()
}, label)

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

  for (const vp of VIEWPORTS) {
    console.log(`viewport ${vp.name}`)
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr, hasTouch: !!vp.narrow })
    if (vp.sidebar) await context.addInitScript(([k, w]) => { try { localStorage.setItem(k, String(w)) } catch { /* storage off */ } }, [SIDEBAR_W_KEY, vp.sidebar])
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push(m.text().slice(0, 300)) })
    // sockets: start on another tab, note what the app shell opens, then open the WORKER OFFICE
    let phase = 'shell'
    const sockets = []
    page.on('websocket', ws => sockets.push({ url: ws.url(), phase }))
    await page.goto(`http://127.0.0.1:${PORT}/?tab=reports`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelectorAll('button').length > 3, null, { timeout: 120_000 })
    for (let i = 0; i < 30 && sockets.length === 0; i++) await page.waitForTimeout(100)
    await page.waitForTimeout(1_000)
    phase = 'office'
    await openTab(page, 'WORKER OFFICE')
    await page.waitForFunction(() => (window.__workerOffice?.draws ?? 0) > 0, null, { timeout: 120_000 })
    await page.evaluate(async () => { await document.fonts.ready; return true })
    await page.waitForTimeout(1_500)
    const shellUrls = new Set(sockets.filter(s => s.phase === 'shell').map(s => s.url))
    const newUrls = [...new Set(sockets.filter(s => s.phase === 'office').map(s => s.url))].filter(u => !shellUrls.has(u))
    check(newUrls.length === 0, `opening the tab opens no new socket (app shell: ${[...shellUrls].join(', ') || 'none'}; new: ${newUrls.join(', ') || 'none'})`)

    const state = () => page.evaluate(() => { const { floorTexel: _f, mapTexel: _m, ...d } = window.__workerOffice; return d })
    const d = await state()
    console.log(`  state ${JSON.stringify(d)}`)
    check(Number.isInteger(d.deviceScale) && Math.abs(d.zoom * d.dpr - Math.round(d.zoom * d.dpr)) < 1e-9, `zoom × DPR = ${d.zoom} × ${d.dpr} = ${d.zoom * d.dpr} is an integer`)
    if (vp.zoom) check(d.zoom === vp.zoom, `zoom ${d.zoom} (want ${vp.zoom}; plan §6.1 / D5)`)
    check(Math.abs(d.backing[0] - d.css[0] * d.dpr) <= 1 && Math.abs(d.backing[1] - d.css[1] * d.dpr) <= 1, `backing store ${d.backing} = CSS ${d.css} × DPR ${d.dpr}`)
    check(Number.isInteger(d.offset[0]) && Number.isInteger(d.offset[1]), `camera offset ${d.offset} is whole device pixels`)
    check(d.prerenders === 1 && d.engines === 1, `pre-rendered once, one engine (prerenders ${d.prerenders}, engines ${d.engines})`)
    check(d.workers === 0, 'zero workers')
    check(JSON.stringify(d.labels) === JSON.stringify(EXPECTED_LABELS), `room labels from the zones: ${d.labels.join(', ')}`)

    // layout: the overlay, the note, the map column and the room key
    const box = await page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } }
      const banner = document.querySelector('[data-wo="banner"]')
      return {
        map: r('[data-wo="map"]'), key: r('[data-wo="key"]'), overlay: r('[data-wo="overlay"]'), banner: r('[data-wo="banner"]'), canvas: r('canvas[role="img"]'),
        bannerText: banner?.innerText ?? '', bannerClipped: banner ? banner.scrollWidth > banner.clientWidth + 1 || banner.scrollHeight > banner.clientHeight + 1 : true,
      }
    })
    const buildingTopCss = box.canvas.top + d.offset[1] / d.dpr
    const roomForBand = d.css[1] - (d.world[1] * d.deviceScale) / d.dpr >= box.overlay.bottom - box.canvas.top
    if (roomForBand) check(buildingTopCss >= box.overlay.bottom - 0.5, `the building starts below the overlay (top ${buildingTopCss.toFixed(1)} px, overlay bottom ${box.overlay.bottom.toFixed(1)} px)`)
    check(box.bannerText.replace(/\s+/g, ' ').trim() === BANNER && !box.bannerClipped
      && box.banner.left >= box.map.left - 0.5 && box.banner.right <= box.map.right + 0.5 && box.banner.bottom <= box.map.bottom + 0.5,
    `the note is whole and inside the map column (${box.banner.width.toFixed(0)}×${box.banner.height.toFixed(0)} px in ${box.map.width.toFixed(0)} px; clipped: ${box.bannerClipped})`)
    if (vp.narrow) {
      check(box.map.width >= vp.w - 1 && box.key.top >= box.map.bottom - 1, `phone: the map is full width (${box.map.width.toFixed(0)} px) and the room key sits under it`)
    }
    const text = await page.evaluate(() => document.body.innerText)
    check(text.includes(BANNER), `note "${BANNER}" shown`)
    check(!text.includes('npm run office'), 'no "npm run office" on the page')
    const tabs = await page.$$eval('button', bs => bs.map(b => b.textContent.trim()))
    check(tabs.includes('WORKER OFFICE') && !tabs.includes('AGENT OFFICE'), `tab label WORKER OFFICE (tabs: ${tabs.filter(t => /^[A-Z ]+$/.test(t)).join(' | ')})`)

    // texels are exact blocks: corridor tiles x 12..20, y 11..12 (no label, no state layer there)
    const blocks = await page.evaluate(({ tx0, tx1, ty0, ty1 }) => {
      const dbg = window.__workerOffice
      const c = document.querySelector('canvas[role="img"]')
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

    // contrast: every visible text in the tab against its composited background (ancestors' backgrounds over the page)
    const contrast = await page.evaluate(() => {
      const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const v = m[1].split(',').map(s => parseFloat(s)); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1] }
      const over = (c, u) => [0, 1, 2].map(i => c[i] * c[3] + u[i] * (1 - c[3]))
      const lum = (rgb) => { const l = rgb.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] }
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
      const root = document.querySelector('[data-wo="map"]').parentElement
      const out = []
      for (const el of root.querySelectorAll('*')) {
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
        const b = el.getBoundingClientRect()
        if (b.width < 2 || b.height < 2) continue          // the visually hidden help text
        const chain = []
        for (let e = el; e; e = e.parentElement) chain.unshift(e)
        let bg = parse(getComputedStyle(document.documentElement).backgroundColor).slice(0, 3)
        for (const e of chain) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) bg = over(c, bg) }
        const fg = parse(getComputedStyle(el).color)
        out.push({ text: el.textContent.trim().slice(0, 28), ratio: +ratio(over(fg, bg), bg).toFixed(2) })
      }
      return out
    })
    const low = contrast.filter(c => c.ratio < 4.5)
    check(contrast.length > 10 && low.length === 0, `text contrast: ${contrast.length} text elements, lowest ${Math.min(...contrast.map(c => c.ratio))}:1${low.length ? ` — below 4.5: ${low.map(c => `"${c.text}" ${c.ratio}`).join(', ')}` : ''}`)

    const shot = path.join(OUT, `worker-office-step1-${vp.name}.png`)
    await page.screenshot({ path: shot })
    console.log(`  saved ${shot}`)
    // close-up of reception, door and sidewalk at the page's own scale
    const clip = await page.evaluate(() => {
      const dbg = window.__workerOffice
      const r = document.querySelector('canvas[role="img"]').getBoundingClientRect()
      const css = (dev) => dev / dbg.dpr
      const s = dbg.deviceScale, [ox, oy] = dbg.offset
      const x = Math.max(r.left, r.left + css(ox + 12 * 16 * s)), y = Math.max(r.top, r.top + css(oy + 12 * 16 * s))
      return { x, y, width: Math.min(css(22 * 16 * s), r.right - x), height: Math.min(css(11 * 16 * s), r.bottom - y) }
    })
    const crop = path.join(OUT, `worker-office-step1-${vp.name}-reception.png`)
    await page.screenshot({ path: crop, clip })
    console.log(`  saved ${crop}`)

    // tab switch: away and back — no rebuild, same engine, same camera; hidden while away
    await openTab(page, 'REPORTS')
    await page.waitForTimeout(300)
    const away = await state()
    check(away.active === false, 'drawing pauses while another tab is shown')
    await openTab(page, 'WORKER OFFICE')
    await page.waitForFunction((n) => window.__workerOffice.draws > n, away.draws, { timeout: 10_000 })
    const back = await state()
    check(back.prerenders === 1 && back.engines === 1 && back.active, `after a tab switch: prerenders ${back.prerenders}, engines ${back.engines}, active ${back.active}`)
    check(back.deviceScale === d.deviceScale && back.offset[0] === d.offset[0] && back.offset[1] === d.offset[1], `camera kept across the switch (scale ${back.deviceScale}, offset ${back.offset})`)

    // the canvas as an accessible, keyboard-operable image
    const a11y = await page.evaluate(() => {
      const c = document.querySelector('canvas[role="img"]')
      const described = (c?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '')
      return { label: c?.getAttribute('aria-label') ?? '', tabIndex: c?.tabIndex, described }
    })
    check(/floor plan/i.test(a11y.label) && a11y.tabIndex === 0 && a11y.described.length === 2 && a11y.described.every(t => t.length > 10),
      `canvas: role img, label "${a11y.label}", focusable, described by the key and the controls (${a11y.described.map(t => t.length).join(' + ')} chars)`)
    await page.focus('canvas[role="img"]')
    await page.keyboard.press('+')
    await page.waitForFunction((n) => window.__workerOffice.deviceScale === n, d.deviceScale + 1, { timeout: 5_000 }).catch(() => {})
    const zoomed = await state()
    await page.keyboard.press('0')
    await page.waitForTimeout(200)
    const refit = await state()
    check(zoomed.deviceScale === d.deviceScale + 1 && refit.deviceScale === d.deviceScale && refit.offset.join() === d.offset.join(),
      `keyboard: '+' zooms in (${d.deviceScale} -> ${zoomed.deviceScale}), '0' fits again (${refit.deviceScale}, ${refit.offset})`)

    check(errors.length === 0, `no page errors (${errors.length ? errors.join(' | ') : 'none besides the old office socket on :4571'})`)
    await context.close()
  }

  // a broken floorplan: the tab shows the note and the loader's error; the rest of the site keeps working
  {
    console.log('broken floorplan')
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const logged = []
    page.on('console', m => { if (m.type() === 'error') logged.push(m.text()) })
    let intercepted = 0
    await page.route(/floorplan\.json\?.*raw/, route => { intercepted++; return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default "{}"' }) })
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?tab=agents`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-wo="error"]', { timeout: 60_000 })
      const errText = await page.locator('[data-wo="error"]').innerText()
      check(intercepted > 0 && errText.includes('The office map failed to load.') && errText.replace(/\s+/g, ' ').includes(BANNER) && errText.includes('floorplan.json invalid'),
        `the tab shows the note and the loader's error (${errText.split('\n').filter(Boolean).slice(0, 3).join(' / ')})`)
      const tabs = await page.$$eval('button', bs => bs.map(b => b.textContent.trim()))
      check(tabs.includes('GAME GUIDE') && tabs.includes('REPORTS') && tabs.includes('WORKER OFFICE'), 'the header and its tabs are still there')
      await page.screenshot({ path: path.join(OUT, 'worker-office-step1-broken-floorplan.png') })
      await openTab(page, 'REPORTS')
      await page.waitForTimeout(800)
      const other = await page.evaluate(() => document.body.innerText.length)
      check(other > 200 && !(await page.locator('[data-wo="error"]').isVisible()), `another tab still opens and renders (${other} characters of text)`)
      check(logged.some(t => t.includes('[WORKER OFFICE] the office map failed to load')), 'the error is logged with the loader\'s problem list')
    } catch (e) {
      check(false, `broken floorplan run: ${String(e).slice(0, 300)} (intercepted ${intercepted})`)
    }
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  await server.close()
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('visual check: ALL PASS')
