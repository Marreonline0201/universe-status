#!/usr/bin/env node
// Fluid bench driver — office-free, quantitative fluid tests in real Chrome/WebGPU.
//
//   npm run dev                      (vite, serves /bench.html)
//   node scripts/fluid-bench.mjs <scenario.json | lab-experiment-name> [options]
//
// Options:
//   --frames=0,30,60,120   sim frames at which to sample the particle state (default below)
//   --seed=N               spawn PRNG seed (default 1) — same seed ⇒ identical initial particles
//   --url=URL              bench page (default http://localhost:5174/bench.html)
//   --label=TEXT           tag written into the results (e.g. "baseline", "si-units")
//   --shots                also save a canvas screenshot at every sample
//
// Writes bench-results/<scenario>/<stamp>-<label>/{metrics.json,summary.md[,frame-*.jpg]}.
//
// Honesty guards (each exists because a past measurement silently lied):
//   - the page must be visible and rAF must advance, or the run FAILS (background tabs are
//     throttled to ~0 fps and "pass" by never rendering a frame that could fail);
//   - each sample records the sim frame it was taken at, not a wall-clock guess;
//   - non-finite and out-of-box particles are counted, never filtered away.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code) }

// ── args ─────────────────────────────────────────────────────────────────────
const [scenarioArg, ...rest] = process.argv.slice(2)
if (!scenarioArg) die('usage: node scripts/fluid-bench.mjs <scenario.json | lab-experiment> [--frames=..] [--seed=N] [--label=..] [--shots]')
let frames = [0, 15, 30, 60, 90, 120, 180, 240, 360, 480]
let seed = 1
let url = 'http://localhost:5174/bench.html'
let label = 'run'
let shots = false
for (const a of rest) {
  let m
  if ((m = /^--frames=([\d,]+)$/.exec(a))) frames = m[1].split(',').map(Number).sort((x, y) => x - y)
  else if ((m = /^--seed=(\d+)$/.exec(a))) seed = Number(m[1])
  else if ((m = /^--url=(.+)$/.exec(a))) url = m[1]
  else if ((m = /^--label=([\w.-]+)$/.exec(a))) label = m[1]
  else if (a === '--shots') shots = true
  else die(`unknown arg "${a}"`)
}

const scenarioPath = fs.existsSync(scenarioArg)
  ? path.resolve(scenarioArg)
  : path.join(repoRoot, 'company', 'lab', scenarioArg, 'scenario.json')
if (!fs.existsSync(scenarioPath)) die(`scenario not found: ${scenarioArg}`)
const scenarioText = fs.readFileSync(scenarioPath, 'utf8')
const scenario = JSON.parse(scenarioText)
const scenarioName = scenario.name ?? path.basename(path.dirname(scenarioPath))

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = path.join(repoRoot, 'bench-results', scenarioName, `${stamp}-${label}`)

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p))
if (!chromePath) die('no Chrome/Edge found')

// ── metrics (computed here so they can evolve without rebuilding the page) ──────
const decodeF32 = b64 => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) }
const decodeU32 = b64 => { const b = Buffer.from(b64, 'base64'); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4) }
const r4 = v => Math.round(v * 1e4) / 1e4
const pct = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN

export function computeMetrics(sample, grid = 64, cols = 16) {
  const pos = decodeF32(sample.pos), vel = decodeF32(sample.vel), comp = decodeU32(sample.comp)
  const n = sample.n
  const nameOf = new Map(sample.materials.map(m => [m.id, m.name]))
  let nonFinite = 0, outOfBox = 0, sumSpeed = 0, maxSpeed = 0, sumKE = 0
  const byMat = new Map()
  const xs = []
  const cellCount = new Map()
  const colTop = new Float32Array(cols * cols).fill(-1), colN = new Uint32Array(cols * cols)
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]
    const vx = vel[3 * i], vy = vel[3 * i + 1], vz = vel[3 * i + 2]
    if (![x, y, z, vx, vy, vz].every(Number.isFinite)) { nonFinite++; continue }
    if (x < 0 || x > 1 || y < 0 || y > 1 || z < 0 || z > 1) outOfBox++
    const v2 = vx * vx + vy * vy + vz * vz, sp = Math.sqrt(v2)
    sumSpeed += sp; sumKE += 0.5 * v2; if (sp > maxSpeed) maxSpeed = sp
    xs.push(x)
    const id = comp[i]
    let g = byMat.get(id)
    if (!g) { g = { name: nameOf.get(id) ?? `comp-${id}`, count: 0, sy: 0, sx: 0, sz: 0, minY: 1, maxY: 0, maxX: 0, ys: [] }; byMat.set(id, g) }
    g.count++; g.sy += y; g.sx += x; g.sz += z
    if (y < g.minY) g.minY = y; if (y > g.maxY) g.maxY = y; if (x > g.maxX) g.maxX = x
    g.ys.push(y)
    const cx = Math.min(grid - 1, Math.max(0, Math.floor(x * grid)))
    const cy = Math.min(grid - 1, Math.max(0, Math.floor(y * grid)))
    const cz = Math.min(grid - 1, Math.max(0, Math.floor(z * grid)))
    const key = (cx * grid + cy) * grid + cz
    cellCount.set(key, (cellCount.get(key) ?? 0) + 1)
    const c = Math.min(cols - 1, Math.floor(x * cols)) * cols + Math.min(cols - 1, Math.floor(z * cols))
    colN[c]++; if (y > colTop[c]) colTop[c] = y
  }
  const good = n - nonFinite
  xs.sort((a, b) => a - b)
  // Bulk density in particles/cell: cells whose 6 face-neighbours are all occupied are
  // interior (no free-surface under-fill), so their mean count is the fluid's packing.
  let interiorSum = 0, interiorCells = 0, occupiedSum = 0
  for (const [key, cnt] of cellCount) {
    occupiedSum += cnt
    const cz = key % grid, cy = Math.floor(key / grid) % grid, cx = Math.floor(key / (grid * grid))
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    if (nb.every(([dx, dy, dz]) => cellCount.has(((cx + dx) * grid + (cy + dy)) * grid + (cz + dz)))) { interiorSum += cnt; interiorCells++ }
  }
  // Surface flatness over columns that hold a real amount of fluid.
  const tops = []
  const minColN = Math.max(20, 0.25 * good / (cols * cols))
  for (let c = 0; c < cols * cols; c++) if (colN[c] >= minColN) tops.push(colTop[c])
  const meanTop = tops.reduce((a, b) => a + b, 0) / (tops.length || 1)
  const topStd = Math.sqrt(tops.reduce((a, b) => a + (b - meanTop) ** 2, 0) / (tops.length || 1))
  return {
    frame: sample.frame, n, nonFinite, outOfBox,
    meanSpeed: r4(sumSpeed / (good || 1)), maxSpeed: r4(maxSpeed), keMean: r4(sumKE / (good || 1)),
    frontX: r4(xs[xs.length - 1] ?? NaN), frontX_p995: r4(pct(xs, 0.995)), backX_p005: r4(pct(xs, 0.005)),
    occupiedCells: cellCount.size, meanPerOccupiedCell: r4(occupiedSum / (cellCount.size || 1)),
    interiorCells, bulkParticlesPerCell: r4(interiorSum / (interiorCells || 1)),
    surface: { columns: tops.length, meanTop: r4(meanTop), topStd: r4(topStd), topRange: tops.length ? r4(Math.max(...tops) - Math.min(...tops)) : null },
    materials: [...byMat.entries()].map(([id, g]) => {
      g.ys.sort((a, b) => a - b)
      return { id, name: g.name, count: g.count, meanY: r4(g.sy / g.count), medianY: r4(pct(g.ys, 0.5)), minY: r4(g.minY), maxY: r4(g.maxY), maxX: r4(g.maxX), comX: r4(g.sx / g.count), comZ: r4(g.sz / g.count) }
    }),
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let browser = null
  const consoleErrors = []
  const watchdog = setTimeout(() => { console.error('✗ watchdog: 240s exceeded'); try { browser?.process()?.kill() } catch { /* */ } process.exit(3) }, 240_000)
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: false, args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
    page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 300)))
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.bringToFront()
    await page.waitForFunction(() => window.__fluidBench !== undefined, null, { timeout: 30_000 })
    const init = await page.evaluate(() => ({ ok: window.__fluidBench.ok, err: window.__fluidBench.initError }))
    if (!init.ok) throw new Error(`bench init failed: ${init.err} | console: ${consoleErrors.slice(-3).join(' | ')}`)

    // Lockstep clock: "frame N" = exactly N × 1/60 s of sim time, independent of display rate.
    await page.evaluate(() => { try { window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60 }) } catch { /* pre-S1.1 page */ } })
    await page.evaluate(() => window.__fluidBench.setStepLimit?.(Infinity))
    const loadRes = await page.evaluate(([t, s]) => window.__fluidBench.load(t, s), [scenarioText, seed])
    if (loadRes.warning) console.log(`scenario warning: ${loadRes.warning}`)
    fs.mkdirSync(outDir, { recursive: true })

    const samples = []
    const fpsSeen = []
    for (const target of frames) {
      const t0 = Date.now()
      let st = await page.evaluate(() => window.__fluidBench.status())
      const raf0 = st.rafFrames
      while (st.framesStepped < target) {
        if (st.visibility !== 'visible') throw new Error(`page not visible (${st.visibility}) — measurement would be throttled`)
        if (Date.now() - t0 > 60_000) throw new Error(`sim stalled: framesStepped ${st.framesStepped} < ${target} after 60s (rAF ${raf0}→${st.rafFrames})`)
        await page.waitForTimeout(8)
        st = await page.evaluate(() => window.__fluidBench.status())
      }
      if (st.fps) fpsSeen.push(st.fps)
      const raw = await page.evaluate(() => window.__fluidBench.sample())
      if (!raw) throw new Error(`sample at frame ${target} returned null`)
      const m = computeMetrics(raw)
      m.targetFrame = target; m.fps = st.fps
      samples.push(m)
      if (shots) await page.locator('canvas').first().screenshot({ path: path.join(outDir, `frame-${String(m.frame).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 70 })
      const mats = m.materials.map(x => `${x.name}:y̅${x.meanY}`).join(' ')
      console.log(`f${m.frame} n=${m.n} speed̅=${m.meanSpeed} front=${m.frontX_p995} bulk=${m.bulkParticlesPerCell}/cell top±${m.surface.topStd} ${mats}${m.nonFinite ? ` NONFINITE=${m.nonFinite}` : ''}`)
    }
    const final = await page.evaluate(() => window.__fluidBench.status())
    if (final.rafFrames < frames[frames.length - 1]) throw new Error(`rAF advanced only ${final.rafFrames} frames — the page was not really rendering`)
    const sortedFps = [...fpsSeen].sort((a, b) => a - b)
    const result = { scenario: scenarioName, scenarioPath: path.relative(repoRoot, scenarioPath), label, seed, stamp, medianFps: sortedFps[Math.floor(sortedFps.length / 2)] ?? null, consoleErrors, samples }
    fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(result, null, 2))
    console.log(`RESULT: ${scenarioName} [${label}] ${samples.length} samples, median ${result.medianFps} FPS, ${consoleErrors.length} console errors → ${path.relative(repoRoot, outDir)}`)
  } catch (e) {
    clearTimeout(watchdog)
    if (browser) await browser.close().catch(() => {})
    die(e?.message ?? String(e), 2)
  }
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
}
