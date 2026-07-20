// Deep-zoom check on a desk column: are those stacked figures two sprites or
// one seated sprite composited over chair/desk art?
// Run: node scripts/office-desk-zoom.cjs   (office server must be up on :4571)
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, '..', 'playtest_screenshots')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT)
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] })
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then(c => c.newPage())
  await page.goto('http://localhost:4571/?tab=agents', { waitUntil: 'networkidle' })
  await sleep(4500)

  // rendering zone desk column sits at ~5% width, ~62% height of the canvas
  const canvas = await page.$('canvas')
  const box = await canvas.boundingBox()
  const cx = box.x + box.width * 0.055, cy = box.y + box.height * 0.62
  await page.mouse.move(cx, cy)
  for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, -240); await sleep(120) }
  await sleep(600)
  await page.screenshot({ path: path.join(OUT, 'office_desk_zoom.png') })
  console.log('saved office_desk_zoom.png')
  await browser.close()
})().catch(e => { console.error(e); process.exit(1) })
