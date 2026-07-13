#!/usr/bin/env node
// Lab runner: drives a real Chrome over the LABORATORY page (the office at :4571),
// runs one company/lab/<scenario> experiment in the WebGPU sim, and captures three
// screenshots (early / mid / settled) + a summary so office agents can gather
// empirical fluid data without a human running the sim by hand.
//
// Invoked through the office's owner-approved kind:run pipeline:
//   node scripts/run-lab.mjs <scenario-dir> [--wait=N]
// stdout is streamed to the live console, tailed onto the REQ, and mailed to the
// requesting agent — the LAST lines carry the verdict + frame paths.
//
// Safety: writes ONLY under company/lab/<scenario>/results/. A visible Chrome
// window is expected for ~30-60s (WebGPU needs the real GPU; headed is the proven
// configuration on this machine).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFICE_URL = 'http://localhost:4571'

// ── args ─────────────────────────────────────────────────────────────────────
const [scenarioArg, ...restArgs] = process.argv.slice(2)
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code) }

if (!scenarioArg) die('usage: node scripts/run-lab.mjs <scenario-dir> [--wait=N]')
// The runner's ARG_PATTERN allows '/', so lock the shape down here: one plain dir name.
if (!/^[a-z0-9-]+$/.test(scenarioArg)) die(`bad scenario name "${scenarioArg}" — expected a single lowercase dir name like survey-01-dam-break`)
const scenario = scenarioArg

let waitS = 12
let frameCount = 8
for (const a of restArgs) {
  let m
  if ((m = /^--wait=(\d{1,3})$/.exec(a))) waitS = Math.min(120, Math.max(5, Number(m[1])))
  else if ((m = /^--frames=(\d{1,2})$/.exec(a))) frameCount = Math.min(16, Math.max(4, Number(m[1])))
  else die(`unknown arg "${a}" — supported: --wait=N (5-120s), --frames=N (4-16)`)
}

const labDir = path.join(repoRoot, 'company', 'lab', scenario)
const scenarioJson = path.join(labDir, 'scenario.json')
if (!fs.existsSync(scenarioJson)) die(`company/lab/${scenario}/scenario.json not found — is the scenario dir name right?`)

// All writes land here and nowhere else.
const stamp = String(Math.floor(Date.now() / 1000))
const outDir = path.join(labDir, 'results', stamp)
const outRel = (f) => `company/lab/${scenario}/results/${stamp}/${f}`.replace(/\\/g, '/')

// ── preflight ────────────────────────────────────────────────────────────────
const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p))
if (!chromePath) die('no Chrome/Edge found in the standard install locations')

try {
  const res = await fetch(`${OFFICE_URL}/api/status`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (e) {
  die(`office not reachable at ${OFFICE_URL} (${e?.message ?? e}) — is \`npm run office\` running?`)
}

// ── run ──────────────────────────────────────────────────────────────────────
/** Failure inside the browser session: thrown (NOT process.exit) so the finally
    block still closes Chrome — an exit() there would orphan the window. */
class RunFail extends Error {
  constructor(msg, code) { super(msg); this.code = code }
}
const fail = (msg, code) => { throw new RunFail(msg, code) }

const consoleErrors = []
let browser = null

// Hard watchdog: a wedged CDP connection must not eat the office's serial run slot.
// Kills the Chrome process directly (close() may be the thing that's hung), then exits.
const watchdog = setTimeout(() => {
  console.error(`✗ watchdog: run exceeded ${waitS + 60}s — aborting`)
  try { browser?.process()?.kill() } catch { /* best effort */ }
  process.exit(3)
}, (waitS + 60) * 1000)

try {
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: false, // WebGPU on the real GPU — headed is the proven config on this machine
    args: ['--enable-unsafe-webgpu'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 200)))

  await page.goto(`${OFFICE_URL}/?tab=lab&exp=${scenario}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })

  // Deep-link assertion: distinguishes "stale dist" from "unknown experiment". The header
  // shows "select an experiment" until the experiments list arrives and the auto-select
  // fires, so POLL rather than sample once.
  const nameLoc = page.locator('[data-testid="lab-experiment-name"]')
  try {
    await nameLoc.waitFor({ timeout: 10_000 })
  } catch {
    fail('lab header not found — the served dist predates deep-link support (run `npm run build`)', 4)
  }
  let shownName = ''
  const tSel = Date.now()
  while (Date.now() - tSel < 15_000) {
    shownName = (await nameLoc.textContent())?.trim() ?? ''
    if (shownName && shownName !== 'select an experiment') break
    await page.waitForTimeout(250)
  }
  if (!shownName || shownName === 'select an experiment') {
    fail(`experiment "${scenario}" was not auto-selected within 15s — not in the lab list (or stale dist)`, 5)
  }
  console.log(`experiment: ${shownName}`)

  // Scenario-invalid overlay beats any amount of waiting.
  const invalid = page.getByText('✗ scenario invalid:')
  const readStat = async (testid, re) => {
    const t = (await page.locator(`[data-testid="${testid}"]`).textContent()) ?? ''
    const m = re.exec(t.replace(/,/g, ''))
    return m ? Number(m[1]) : 0
  }

  // Readiness: particles spawned AND the sim actually ticking (fps > 0).
  const t0 = Date.now()
  let particles = 0, fps = 0
  while (Date.now() - t0 < 30_000) {
    if (await invalid.count() > 0) {
      const txt = (await invalid.first().textContent())?.trim()
      fail(`scenario rejected by the lab: ${txt}`, 6)
    }
    particles = await readStat('lab-particles', /(\d+) particles/)
    fps = await readStat('lab-fps', /(\d+) FPS/)
    if (particles > 0 && fps > 0) break
    await page.waitForTimeout(250)
  }
  if (particles === 0 || fps === 0) {
    fail(`sim never became ready (particles=${particles}, fps=${fps} after 30s) — WebGPU init failure? console errors: ${consoleErrors.slice(-3).join(' | ') || 'none'}`, 7)
  }
  console.log(`sim ready: ${particles} particles`)

  // N frames evenly spaced from ~1s to the settled state, each paired with a motion-metrics
  // sample (GPU particle readback via the page hook) — the agent's flipbook + numbers.
  fs.mkdirSync(outDir, { recursive: true })
  const canvas = page.locator('canvas').first()
  const fpsSamples = []
  const frames = []
  const metricsSeries = []
  let metricsAvailable = true
  const capturePoints = Array.from({ length: frameCount }, (_, i) =>
    Math.round((1 + ((waitS - 1) * i) / (frameCount - 1)) * 10) / 10)
  for (let i = 0; i < capturePoints.length; i++) {
    const targetMs = capturePoints[i] * 1000
    const elapsed = Date.now() - t0
    if (targetMs > elapsed) await page.waitForTimeout(targetMs - elapsed)
    fpsSamples.push(await readStat('lab-fps', /(\d+) FPS/))
    const name = `frame-${String(i + 1).padStart(2, '0')}.jpg`
    const file = path.join(outDir, name)
    await canvas.screenshot({ path: file, type: 'jpeg', quality: 70 })
    const size = fs.statSync(file).size
    frames.push({ file, rel: outRel(name), size, atS: capturePoints[i] })
    const metrics = await page.evaluate(() =>
      typeof window.__labSampleMetrics === 'function' ? window.__labSampleMetrics() : 'no-hook',
    ).catch(() => null)
    if (metrics === 'no-hook') metricsAvailable = false
    metricsSeries.push(metrics && metrics !== 'no-hook' ? { t: capturePoints[i], ...metrics } : null)
    console.log(`frame ${i + 1}/${frameCount} @ ~${capturePoints[i]}s → ${outRel(name)} (${(size / 1024).toFixed(0)}KB)`)
  }

  // Filmstrip: one grid image with timestamps — the token-cheap way for an agent to see
  // the whole motion at once (a single image costs ~the same regardless of frames inside).
  // Composited in the browser we already have open: an HTML grid page, screenshotted.
  const cols = Math.min(4, frames.length)
  const stripHtml = `<!doctype html><style>
    body{margin:0;background:#111;font-family:monospace}
    .grid{display:grid;grid-template-columns:repeat(${cols},360px);gap:8px;padding:10px;width:fit-content}
    .cell img{width:360px;display:block}
    .cell div{color:#ddd;font-size:13px;padding:2px 0;text-align:center}
  </style><div class="grid">${frames.map(f =>
    `<div class="cell"><img src="data:image/jpeg;base64,${fs.readFileSync(f.file).toString('base64')}"><div>t≈${f.atS}s</div></div>`,
  ).join('')}</div>`
  const stripPage = await browser.newPage({ viewport: { width: cols * 368 + 20, height: 400 } })
  await stripPage.setContent(stripHtml, { waitUntil: 'load' })
  const stripFile = path.join(outDir, 'filmstrip.jpg')
  await stripPage.screenshot({ path: stripFile, fullPage: true, type: 'jpeg', quality: 75 })
  await stripPage.close()
  const stripRel = outRel('filmstrip.jpg')
  console.log(`filmstrip (${frames.length} frames) → ${stripRel} (${(fs.statSync(stripFile).size / 1024).toFixed(0)}KB)`)

  fs.writeFileSync(path.join(outDir, 'metrics.json'),
    JSON.stringify({ scenario, stamp, samples: metricsSeries }, null, 2))

  const suspect = frames.filter(f => f.size < 8 * 1024)
  if (suspect.length === frames.length) {
    fail('all frames are under 8KB — almost certainly solid/blank captures, not the sim', 8)
  }
  const sorted = [...fpsSamples].sort((a, b) => a - b)
  const medianFps = sorted[Math.floor(sorted.length / 2)]
  const finalParticles = await readStat('lab-particles', /(\d+) particles/)

  // Motion-metrics tables for summary.md. All positions are sim [0,1]³ coords.
  const got = metricsSeries.filter(Boolean)
  const first = got[0], last = got[got.length - 1]
  const settled = last ? last.meanSpeed < 0.005 : null
  const metricsLines = []
  if (got.length > 0) {
    metricsLines.push('', '## Motion metrics (GPU particle readback, sim [0,1] coords)', '',
      '| t (s) | mean speed | mean y | max y | spread x | spread z |',
      '|---|---|---|---|---|---|',
      ...got.map(s =>
        `| ${s.t} | ${s.meanSpeed} | ${s.meanY} | ${s.maxY} | ${s.spreadX[0]}–${s.spreadX[1]} | ${s.spreadZ[0]}–${s.spreadZ[1]} |`))
    metricsLines.push('',
      `- settled by end: **${settled ? 'yes' : 'no'}** (final mean speed ${last.meanSpeed}; threshold 0.005)`,
      `- full time series: \`${outRel('metrics.json')}\``)
    if (last.materials.length > 1) {
      metricsLines.push('', '### Per-material (final sample) — quantifies contrast even though the renderer draws all particles alike', '',
        '| material | count | mean speed | mean y | max y | center x/z |',
        '|---|---|---|---|---|---|',
        ...last.materials.map(m =>
          `| ${m.name} (id ${m.id}) | ${m.count} | ${m.meanSpeed} | ${m.meanY} | ${m.maxY} | ${m.comX}/${m.comZ} |`))
    }
  } else if (!metricsAvailable) {
    metricsLines.push('', '> Motion metrics unavailable — the served dist predates the metrics hook (rebuild + rerun).')
  }

  // summary.md — what an agent needs to reason about the run without seeing it.
  const summary = [
    `# Lab run — ${scenario}`,
    '',
    `- when: ${new Date().toISOString()} (stamp ${stamp})`,
    `- particles: ${finalParticles}`,
    `- median FPS: ${medianFps} (samples: ${fpsSamples.join(', ')})`,
    `- **filmstrip (read this first — whole run in one image):** \`${stripRel}\``,
    `- frames (JPEG q70, sim canvas only):`,
    ...frames.map(f => `  - \`${f.rel}\` — ~${f.atS}s after spawn, ${(f.size / 1024).toFixed(0)}KB${f.size < 8 * 1024 ? ' ⚠ suspiciously small' : ''}`),
    `- console errors during run: ${consoleErrors.length === 0 ? 'none' : ''}`,
    ...consoleErrors.slice(0, 10).map(e => `  - ${e}`),
    ...metricsLines,
    '',
    `> FPS caveat: measured on the shared RTX 5070 — only meaningful when nothing else`,
    `> (including another open LABORATORY tab) is using the GPU.`,
    '',
    `Embed the filmstrip in a decision REQ with: \`![filmstrip](${stripRel})\``,
  ].join('\n') + '\n'
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary)

  // The lines below are the resultTail the agent/owner read. The card shows only the LAST
  // 12 lines — so the per-frame list goes first and the load-bearing lines go last.
  console.log('---')
  for (const f of frames) console.log(`FRAME: ${f.rel}`)
  if (consoleErrors.length > 0) console.log(`WARN: ${consoleErrors.length} console error(s) — see summary.md`)
  if (!last && !metricsAvailable) console.log('WARN: motion metrics unavailable — served dist predates the metrics hook')
  console.log(`FILMSTRIP: ${stripRel}`)
  console.log(`SUMMARY: ${outRel('summary.md')}`)
  if (last) console.log(`METRICS: settled=${settled ? 'yes' : 'no'} meanSpeed ${first.meanSpeed}→${last.meanSpeed}, spreadX ${last.spreadX[0]}–${last.spreadX[1]}, maxY ${last.maxY} (${outRel('metrics.json')})`)
  console.log(`RESULT: ok — ${scenario} ran ${waitS}s, ${frames.length} frames, ${finalParticles} particles, median ${medianFps} FPS`)
} catch (e) {
  // Chrome is closed by the finally below — THEN we exit with the failure code.
  if (browser) await browser.close().catch(() => {})
  browser = null
  clearTimeout(watchdog)
  die(e instanceof RunFail ? e.message : `unexpected: ${e?.message ?? e}`, e instanceof RunFail ? e.code : 2)
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
}
