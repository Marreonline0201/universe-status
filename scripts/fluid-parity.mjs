#!/usr/bin/env node
// FLUID TEST parity capture/compare — proves a refactor did not change the simulation.
//
//   node scripts/fluid-parity.mjs capture <label> [--url=http://localhost:5173/?tab=fluid&bench=1]
//   node scripts/fluid-parity.mjs compare <labelA> <labelB>
//
// capture drives the owner's real page through its user actions (RESET, +10K, DROP BALL) with
// seeded randomness, freezes the sim at exactly FRAMES stepped frames, and stores the raw
// particle buffers. compare reports bit-identity per sequence, else the max position delta.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = path.join(repoRoot, 'bench-results', 'parity')
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code) }
const FRAMES = 240
const SEQUENCES = [
  { name: 'reset', steps: [['reset', 11]] },
  { name: 'reset+batch10k', steps: [['reset', 12], ['batch10k', 13]] },
  { name: 'reset+dropBall', steps: [['reset', 14], ['dropBall', 15]] },
]

const [mode, a, b, ...rest] = process.argv.slice(2)
let url = 'http://localhost:5173/?tab=fluid&bench=1'
for (const arg of [b, ...rest].filter(Boolean)) {
  const m = /^--url=(.+)$/.exec(arg)
  if (m) url = m[1]
}

if (mode === 'compare') {
  if (!a || !b) die('usage: compare <labelA> <labelB>')
  const A = JSON.parse(fs.readFileSync(path.join(outRoot, `${a}.json`), 'utf8'))
  const B = JSON.parse(fs.readFileSync(path.join(outRoot, `${b}.json`), 'utf8'))
  let allIdentical = true
  for (const sa of A.sequences) {
    const sb = B.sequences.find(s => s.name === sa.name)
    if (!sb) { console.log(`${sa.name}: missing in ${b}`); allIdentical = false; continue }
    const identical = sa.sha256 === sb.sha256
    let maxDx = 0
    if (!identical) {
      const pa = Buffer.from(sa.pos, 'base64'), pb = Buffer.from(sb.pos, 'base64')
      const fa = new Float32Array(pa.buffer, pa.byteOffset, pa.byteLength / 4)
      const fb = new Float32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4)
      if (fa.length !== fb.length) maxDx = Infinity
      else for (let i = 0; i < fa.length; i++) maxDx = Math.max(maxDx, Math.abs(fa[i] - fb[i]))
      allIdentical = false
    }
    console.log(`${sa.name}: n ${sa.n}/${sb.n} frame ${sa.frame}/${sb.frame} → ${identical ? 'BIT-IDENTICAL' : `DIFFERENT (max |Δx| = ${maxDx})`}`)
  }
  console.log(allIdentical ? 'PARITY: PASS (all sequences bit-identical)' : 'PARITY: see per-sequence results')
  process.exit(allIdentical ? 0 : 1)
}

if (mode !== 'capture' || !a) die('usage: capture <label> | compare <labelA> <labelB>')

const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await chromium.launch({ executablePath: chromePath, headless: false, args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__fluidBench?.page === 'fluid-test', null, { timeout: 30_000 })
  const adapter = await page.evaluate(async () => { const ad = await navigator.gpu.requestAdapter(); return ad ? { vendor: ad.info.vendor, arch: ad.info.architecture } : null })
  const sequences = []
  for (const seq of SEQUENCES) {
    await page.evaluate(() => { window.__fluidBench.setStepLimit(0); window.__fluidBench.action('removeBall') })
    for (const [name, seed] of seq.steps) await page.evaluate(([n, s]) => window.__fluidBench.action(n, s), [name, seed])
    await page.evaluate(f => window.__fluidBench.setStepLimit(f), FRAMES)
    const t0 = Date.now()
    for (;;) {
      const st = await page.evaluate(() => window.__fluidBench.status())
      if (st.visibility !== 'visible') throw new Error('page not visible')
      if (st.framesStepped >= FRAMES) break
      if (Date.now() - t0 > 60_000) throw new Error(`stalled at ${st.framesStepped} frames`)
      await page.waitForTimeout(20)
    }
    const s = await page.evaluate(() => window.__fluidBench.sample())
    const buf = Buffer.concat([Buffer.from(s.pos, 'base64'), Buffer.from(s.vel, 'base64'), Buffer.from(s.comp, 'base64')])
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    sequences.push({ name: seq.name, frame: s.frame, n: s.n, sha256, pos: s.pos })
    console.log(`${seq.name}: frame ${s.frame}, n ${s.n}, sha256 ${sha256.slice(0, 16)}…`)
  }
  fs.mkdirSync(outRoot, { recursive: true })
  fs.writeFileSync(path.join(outRoot, `${a}.json`), JSON.stringify({ label: a, url, adapter, errors, sequences }))
  console.log(`captured → bench-results/parity/${a}.json (adapter ${adapter?.vendor}/${adapter?.arch}, ${errors.length} console errors)`)
} finally {
  await browser.close()
}
