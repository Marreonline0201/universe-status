#!/usr/bin/env node
// Development helper (not a gate): open FLUID TEST, print every console message, the render path and a small probe.
//   node scripts/fluid-gates/tools/probe-dev.mjs
import { windowArgs } from '../../lib/window.mjs'
import { chromium } from 'playwright-core'
import { CHROME, FLUID_TEST_URL } from '../../lib/fluid-page.mjs'

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: [...windowArgs(), '--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', m => console.log(`[${m.type()}] ${m.text().slice(0, 400)}`))
  page.on('pageerror', e => console.log(`[pageerror] ${e}`))
  await page.goto(FLUID_TEST_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__fluidBench !== undefined, null, { timeout: 90_000 })
  await page.waitForTimeout(2000)
  console.log(JSON.stringify(await page.evaluate(() => window.__fluidBench.status())))
  const r = await page.evaluate(() => window.__fluidBench.probe({ width: 64, height: 40, targets: ['color', 'linear', 'thickness', 'depth'] }))
  console.log(JSON.stringify({ ...r, data: Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, v.length])) }))
} finally {
  await browser.close()
}
