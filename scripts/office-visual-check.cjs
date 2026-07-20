// Visual check for the office redesign: full view, commons zoom, team-focus dim state.
// Run: node scripts/office-visual-check.cjs   (office server must be up on :4571)
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, '..', 'playtest_screenshots')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT)
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] })
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then(c => c.newPage())
  const errors = []
  page.on('pageerror', e => errors.push(e.message))

  await page.goto('http://localhost:4571/?tab=agents', { waitUntil: 'networkidle' })
  await sleep(4500) // WS snapshot + map prerender + sprites settle

  await page.screenshot({ path: path.join(OUT, 'office_lux_01_full.png') })
  console.log('saved office_lux_01_full.png')

  // legend check: Engine Research chip present?
  const legend = await page.textContent('body')
  console.log('Engine Research in DOM:', legend.includes('Engine Research'))
  console.log('agent count hint (SESSIONS chip present):', legend.includes('SESSIONS'))

  // zoom into the commons (bottom-right of the canvas)
  const canvas = await page.$('canvas')
  const box = await canvas.boundingBox()
  const cx = box.x + box.width * 0.78, cy = box.y + box.height * 0.72
  await page.mouse.move(cx, cy)
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -240); await sleep(120) }
  await sleep(600)
  await page.screenshot({ path: path.join(OUT, 'office_lux_02_commons_zoom.png') })
  console.log('saved office_lux_02_commons_zoom.png')

  // reset zoom out, then focus one team chip to check dim + accent strips
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await sleep(100) }
  const chip = await page.$('text=Engine Research')
  if (chip) { await chip.click(); await sleep(800) }
  await page.screenshot({ path: path.join(OUT, 'office_lux_03_engine_focus.png') })
  console.log('saved office_lux_03_engine_focus.png')

  console.log('page errors:', errors.length ? errors : 'none')
  await browser.close()
})().catch(e => { console.error(e); process.exit(1) })
