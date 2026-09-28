#!/usr/bin/env node
// FLUID TEST UI smoke test — clicks the real buttons the owner uses and checks the page stays
// alive: +10K adds particles, DROP BALL/REMOVE BALL toggle, RESET restores the default scene,
// a canvas click spawns a cluster, frames keep advancing, the fluid region of the screenshot
// changes while the sim runs, and no console errors appear (other than the expected office
// websocket refusal — the office is deliberately never started).
//
//   node scripts/fluid-smoke.mjs [--url=http://localhost:5173/?tab=fluid&bench=1] [--shot=path.jpg]
import crypto from 'node:crypto'
import { chromium } from 'playwright-core'

let url = 'http://localhost:5173/?tab=fluid&bench=1'
let shot = null
for (const a of process.argv.slice(2)) {
  let m
  if ((m = /^--url=(.+)$/.exec(a))) url = m[1]
  else if ((m = /^--shot=(.+)$/.exec(a))) shot = m[1]
}
const EXPECTED_NOISE = /ws:\/\/localhost:4571/
const fails = []
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg) }

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__fluidBench?.page === 'fluid-test', null, { timeout: 30_000 })
  const st = () => page.evaluate(() => window.__fluidBench.status())
  const btn = name => page.getByRole('button', { name, exact: true })

  const s0 = await st()
  check(s0.count === 10000, `default scene has 10000 particles (got ${s0.count})`)
  await page.waitForTimeout(500)
  const s1 = await st()
  check(s1.framesStepped > s0.framesStepped && s1.rafFrames > s0.rafFrames, `frames advance (${s0.framesStepped}→${s1.framesStepped} stepped)`)

  const canvas = page.locator('canvas').first()
  const hash = async () => crypto.createHash('sha1').update(await canvas.screenshot({ type: 'png' })).digest('hex')
  const h1 = await hash(); await page.waitForTimeout(400); const h2 = await hash()
  check(h1 !== h2, 'canvas pixels change while the sim runs (not a frozen frame)')

  await btn('+10K').click(); await page.waitForTimeout(200)
  check((await st()).count === 20000, `+10K → 20000 particles (got ${(await st()).count})`)

  await btn('DROP BALL').click(); await page.waitForTimeout(200)
  check(await btn('REMOVE BALL').count() === 1, 'DROP BALL toggles to REMOVE BALL')
  await btn('REMOVE BALL').click(); await page.waitForTimeout(200)
  check(await btn('DROP BALL').count() === 1, 'REMOVE BALL toggles back')

  const box = await canvas.boundingBox()
  const before = (await st()).count
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.waitForTimeout(200)
  const after = (await st()).count
  check(after > before, `canvas click spawns a cluster (${before}→${after})`)

  await btn('RESET').click(); await page.waitForTimeout(300)
  const sr = await st()
  check(sr.count === 10000, `RESET restores 10000 particles (got ${sr.count})`)

  if (shot) await canvas.screenshot({ path: shot, type: 'jpeg', quality: 75 })
  check(errors.length === 0, `no unexpected console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(fails.length === 0 ? 'SMOKE: PASS' : `SMOKE: FAIL (${fails.length})`)
process.exit(fails.length === 0 ? 0 : 1)
