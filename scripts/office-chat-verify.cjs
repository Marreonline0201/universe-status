// Deterministic chatter check: read the __casualChats counter after a 100s dwell,
// and screenshot the moment a new exchange fires so the bubble is visible.
const { chromium } = require('playwright')
const path = require('path')
;(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] })
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then(c => c.newPage())
  await page.goto('http://localhost:4571/?tab=agents', { waitUntil: 'networkidle' })
  await new Promise(r => setTimeout(r, 5000))
  const out = path.join(__dirname, '..', 'playtest_screenshots')
  let last = 0, shots = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 100_000) {
    await new Promise(r => setTimeout(r, 1000))
    const n = await page.evaluate(() => window.__casualChats ?? 0)
    if (n > last) {
      last = n
      shots++
      await new Promise(r => setTimeout(r, 1800)) // let the reply bubble appear too
      await page.screenshot({ path: path.join(out, `casual_catch_${shots}.png`) })
      console.log(`exchange #${n} caught → casual_catch_${shots}.png`)
      if (shots >= 2) break
    }
  }
  console.log('total exchanges observed:', last)
  await browser.close()
})().catch(e => { console.error(e); process.exit(1) })
