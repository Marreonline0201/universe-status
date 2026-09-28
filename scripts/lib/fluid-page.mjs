// Shared helpers for fluid gate scripts: open a fluid page in headed Chrome on the real GPU,
// assert it is honestly rendering, drive window.__fluidBench, and decode particle samples.
import { chromium } from 'playwright-core'

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
export const FLUID_TEST_URL = 'http://localhost:5173/?tab=fluid&bench=1'
export const BENCH_URL = 'http://localhost:5173/bench.html'
/** The app shell tries the office websocket; the office is deliberately never started. */
export const EXPECTED_NOISE = /ws:\/\/localhost:4571/

// Tank geometry of the MPM path (src/fluid-engine/units.ts): positions are [0,1]³ of an L-metre tank.
export const DOMAIN_L_M = 3.63
export const TAU_S = 1 / 24
export const G_STANDARD = 9.80665

export async function openFluidPage(url = FLUID_TEST_URL, { width = 1280, height = 800 } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  const errors = []
  const page = await browser.newPage({ viewport: { width, height } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__fluidBench !== undefined, null, { timeout: 30_000 })
  const ok = await page.evaluate(() => ({ ok: window.__fluidBench.ok, err: window.__fluidBench.initError }))
  if (!ok.ok) throw new Error(`fluid page init failed: ${ok.err}`)
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter()
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null
  })
  if (adapter?.vendor !== 'nvidia') throw new Error(`WebGPU adapter is ${adapter?.vendor ?? 'none'}, not the NVIDIA dGPU — measurements would be meaningless`)
  return { browser, page, errors, adapter }
}

export const status = page => page.evaluate(() => window.__fluidBench.status())

/** Wait until the sim has stepped `frames` macro-steps (with setStepLimit(frames) it then freezes). */
export async function waitStepped(page, frames, timeoutMs = 90_000) {
  const t0 = Date.now()
  for (;;) {
    const st = await status(page)
    if (st.visibility !== 'visible') throw new Error('page not visible — rAF would be throttled')
    if (st.framesStepped >= frames) return st
    if (Date.now() - t0 > timeoutMs) throw new Error(`sim stalled at ${st.framesStepped}/${frames} frames`)
    await page.waitForTimeout(10)
  }
}

const f32 = b64 => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) }
const u32 = b64 => { const b = Buffer.from(b64, 'base64'); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4) }

export async function sample(page) {
  const s = await page.evaluate(() => window.__fluidBench.sample())
  if (!s) throw new Error('sample returned null')
  return { frame: s.frame, n: s.n, pos: f32(s.pos), vel: f32(s.vel), comp: u32(s.comp), materials: s.materials }
}

/** Freeze, load a scenario, then step to `frame` in lockstep and sample. */
export async function loadScenario(page, scenario, seed = 1) {
  await page.evaluate(() => window.__fluidBench.setStepLimit(0))
  await page.evaluate(([t, s]) => window.__fluidBench.load(t, s), [JSON.stringify(scenario), seed])
}

export async function sampleAtFrame(page, frame) {
  await page.evaluate(f => window.__fluidBench.setStepLimit(f), frame)
  await waitStepped(page, frame)
  return sample(page)
}

export function centreOfMass(s) {
  let x = 0, y = 0, z = 0, n = 0, bad = 0
  for (let i = 0; i < s.n; i++) {
    const px = s.pos[3 * i], py = s.pos[3 * i + 1], pz = s.pos[3 * i + 2]
    if (!Number.isFinite(px + py + pz)) { bad++; continue }
    x += px; y += py; z += pz; n++
  }
  return { x: x / n, y: y / n, z: z / n, bad }
}

/** Least-squares fit y = a + b·t + c·t² (normal equations, f64). */
export function fitQuadratic(ts, ys) {
  const S = k => ts.reduce((s, t) => s + t ** k, 0)
  const T = k => ts.reduce((s, t, i) => s + ys[i] * t ** k, 0)
  const M = [[S(0), S(1), S(2)], [S(1), S(2), S(3)], [S(2), S(3), S(4)]]
  const r = [T(0), T(1), T(2)]
  // Solve 3×3 by Cramer's rule.
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const D = det(M)
  const col = (j) => M.map((row, i) => row.map((v, k) => (k === j ? r[i] : v)))
  const [a, b, c] = [0, 1, 2].map(j => det(col(j)) / D)
  const resid = Math.sqrt(ts.reduce((s, t, i) => s + (ys[i] - (a + b * t + c * t * t)) ** 2, 0) / ts.length)
  return { a, b, c, resid }
}

export function makeGate(name) {
  const results = []
  return {
    check(ok, msg, data = {}) { results.push({ ok: !!ok, msg, ...data }); console.log(`${ok ? '✓' : '✗'} ${msg}`) },
    results,
    finish() {
      const failed = results.filter(r => !r.ok)
      console.log(failed.length ? `${name}: FAIL (${failed.length}/${results.length})` : `${name}: PASS (${results.length}/${results.length})`)
      return failed.length === 0
    },
  }
}
