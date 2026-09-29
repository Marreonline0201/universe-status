// Shared helpers for fluid gate scripts: open a fluid page in headed Chrome on the real GPU,
// assert it is honestly rendering, drive window.__fluidBench, decode particle samples, and
// stamp every result with the exact commit it measured.
//
// Default server: the CLEAN gate tree (`node scripts/gate-server.mjs [ref]`, port 5175) — results
// are attributable to one commit. FLUID_BASE=http://localhost:5174 measures the live checkout
// (development only; results are marked NON-ATTRIBUTABLE).
import { windowArgs } from './window.mjs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
export const BASE = process.env.FLUID_BASE ?? 'http://localhost:5175'
export const FLUID_TEST_URL = `${BASE}/?tab=fluid&bench=1`
/** The same page on the legacy MLS-MPM (owner decision D8: kept behind ?solver=mpm). Gates that verify MPM-only
 *  mechanics — the separating wall band, the 4-ppc rest packing, the MPM viscosity refusals — run here. */
export const FLUID_TEST_URL_MPM = `${BASE}/?tab=fluid&bench=1&solver=mpm`
export const BENCH_URL = `${BASE}/bench.html`
/** The app shell tries the office websocket; the office is deliberately never started. */
export const EXPECTED_NOISE = /ws:\/\/localhost:4571/
/** Chrome reports WebGPU validation problems as console WARNINGS, not errors. */
const GPU_WARNING = /WebGPU|GPUValidationError|Invalid (Buffer|BindGroup|CommandBuffer|ComputePipeline|RenderPipeline|Texture)|validation/i

// Tank geometry of the MPM path (src/fluid-engine/units.ts).
export const DOMAIN_L_M = 3.63          // grid edge length
export const GRID = 64
export const WALL_BAND = 3              // cells between grid edge and tank wall
export const TANK_INNER_M = (GRID - 2 * WALL_BAND) * DOMAIN_L_M / GRID   // 3.290 m wall to wall
export const TAU_S = 1 / 24
export const G_STANDARD = 9.80665
export const unitToTankM = u => (u - WALL_BAND / GRID) * DOMAIN_L_M
export const unitVelToMs = v => v * DOMAIN_L_M / TAU_S

/** Which commit is being measured: the gate tree's stamp, or NON-ATTRIBUTABLE for a live checkout. */
export async function provenance() {
  try {
    const r = await fetch(`${BASE}/gate-sha.txt`)
    if (r.ok) {
      const [sha, state] = (await r.text()).trim().split(/\s+/)
      if (/^[0-9a-f]{40}$/.test(sha)) return { sha, state, attributable: state === 'clean', base: BASE }
    }
  } catch { /* fall through */ }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  let head = null, dirty = null
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts'], { cwd: repo, encoding: 'utf8' }).trim().length > 0
  } catch { /* no git */ }
  return { sha: head, state: dirty ? 'LIVE-DIRTY' : 'LIVE', attributable: false, base: BASE }
}

/** timing: a frame-pacing/FPS gate — its window stays on the primary display (lib/window.mjs). */
export async function openFluidPage(url = FLUID_TEST_URL, { width = 1280, height = 800, deviceScaleFactor = 1, timing = false } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: [...windowArgs({ timing }), '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  const errors = []
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => {
    const t = m.text()
    if (EXPECTED_NOISE.test(t)) return
    if (m.type() === 'error' || (m.type() === 'warning' && GPU_WARNING.test(t))) errors.push(`[${m.type()}] ${t.slice(0, 300)}`)
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => window.__fluidBench !== undefined, null, { timeout: 90_000 })   // cold Vite pre-bundling
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

/** Wait until the sim has advanced `frames` frames (with setStepLimit(frames) it then freezes). */
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

export async function sample(page, opts = {}) {
  const s = await page.evaluate(o => window.__fluidBench.sample(o), opts)
  if (!s) throw new Error('sample returned null')
  return { frame: s.frame, n: s.n, pos: f32(s.pos), vel: f32(s.vel), comp: u32(s.comp), aff: s.aff ? f32(s.aff) : null, materials: s.materials }
}

/** Freeze, then load a scenario (seeded). */
export async function loadScenario(page, scenario, seed = 1) {
  await page.evaluate(() => window.__fluidBench.setStepLimit(0))
  return page.evaluate(([t, s]) => window.__fluidBench.load(t, s), [JSON.stringify(scenario), seed])
}

export async function sampleAtFrame(page, frame, opts = {}) {
  await page.evaluate(f => window.__fluidBench.setStepLimit(f), frame)
  await waitStepped(page, frame)
  return sample(page, opts)
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
    /** Every gate ends here: no uncaptured WebGPU errors on the engine's device, no console errors
     *  or WebGPU validation warnings (Chrome reports those as warnings). */
    async hygiene(page, errors) {
      const st = await status(page)
      this.check(st.gpuErrors === 0, `GPU: ${st.gpuErrors} uncaptured WebGPU errors on the engine device`)
      this.check(errors.length === 0, `console: ${errors.length} errors/WebGPU warnings${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
    },
    finish() {
      const failed = results.filter(r => !r.ok)
      console.log(failed.length ? `${name}: FAIL (${failed.length}/${results.length})` : `${name}: PASS (${results.length}/${results.length})`)
      return failed.length === 0
    },
  }
}

/** Write a gate report with provenance; prints NON-ATTRIBUTABLE loudly for live-checkout runs. */
export async function writeReport(repoRoot, gateName, pass, report, checks) {
  const fs = await import('node:fs')
  const prov = await provenance()
  if (!prov.attributable) console.log(`⚠ NON-ATTRIBUTABLE run (${prov.state} at ${prov.base}) — gate results count only from the clean gate tree`)
  else console.log(`provenance: ${prov.sha.slice(0, 10)} (clean gate tree)`)
  const out = path.join(repoRoot, 'bench-results', 'gates', `${gateName}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ pass, provenance: prov, ...report, checks }, null, 2))
  console.log(`→ ${path.relative(repoRoot, out)}`)
}
