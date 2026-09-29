#!/usr/bin/env node
// Gate 0 driver (FINAL-PLAN §7 S0.5): runs gpu-bench.html in HEADED Chrome on the NVIDIA adapter
// and writes bench-results/gate0/<stamp>[-label]/{results.json, report.md}.
//
//   npm run dev                                           (vite on :5173 serves gpu-bench.html)
//   python bench/offline/poisson_ref.py --n 64 --check-port   (numpy port check; once)
//   python bench/offline/poisson_ref.py --n 64            (G0-b fixtures + numpy counts; once)
//   python bench/offline/poisson_ref.py --n 48
//   node scripts/gpu-bench.mjs [--tests=g0a,g0b,g0s,g0f,g0g] [--n=64,48] [--quick] [--label=dev] [--url=...]
//
// Honesty guards:
//   - Chrome flags --enable-webgpu-developer-features (unquantized timestamps) and
//     --force-high-performance-gpu; the run FAILS unless the adapter vendor is NVIDIA, the device has
//     'timestamp-query', the page is visible before every test, and timestamps are neither
//     100 µs-quantized nor zero;
//   - Vite's HMR client is replaced by a no-op stub (page.route), so an edit to any source file
//     while the run is in progress cannot reload the page; the run asserts no HMR websocket opened.
//     All test modules load at page start: the code measured is the code hashed at start. The files
//     are hashed again at the end and any change is reported;
//   - a page reload / destroyed execution context is reported as its own failure;
//   - every number in report.md is labelled MEASURED (this run) or EST (a model built on measured
//     parts); a dev run on a busy machine is not the official Gate 0 result: re-run on an idle GPU,
//     AC power.
import { windowArgs } from './lib/window.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code) }

let tests = ['g0a', 'g0b', 'g0s', 'g0f', 'g0g']
let reportOnly = null
let quick = false
let label = ''
let url = 'http://localhost:5173/gpu-bench.html'
let sizesN = [64, 48]
for (const a of process.argv.slice(2)) {
  let m
  if ((m = /^--tests=([\w,]+)$/.exec(a))) tests = m[1].split(',')
  else if (a === '--quick') quick = true
  else if ((m = /^--label=([\w.-]+)$/.exec(a))) label = m[1]
  else if ((m = /^--url=(.+)$/.exec(a))) url = m[1]
  else if ((m = /^--n=([\d,]+)$/.exec(a))) sizesN = m[1].split(',').map(Number)
  else if ((m = /^--report=(.+)$/.exec(a))) reportOnly = m[1]
  else die(`unknown arg "${a}"`)
}
// --report=<run dir>: rebuild report.md from that run's results.json (no measurement), so a
// changed evaluation rule is applied to the SAME hashed measurements instead of a new run
if (reportOnly) {
  const dir = path.resolve(reportOnly)
  const R = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'))
  R.reportRebuiltAt = new Date().toISOString()
  R.reportRebuiltBy = { 'scripts/gpu-bench.mjs': crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16) }
  fs.writeFileSync(path.join(dir, 'report.md'), buildReport(R))
  console.log(`rebuilt ${path.join(dir, 'report.md')}`)
  process.exit(0)
}
if (tests.includes('g0s') && !tests.includes('g0b')) die('g0s takes its caps and worst cases from g0b of the same run: add g0b to --tests')
if (tests.includes('g0b') || tests.includes('g0s')) {
  for (const n of sizesN) {
    const mf = path.join(repoRoot, 'bench-results', 'gate0', 'fixtures', `n${n}`, 'manifest.json')
    if (!fs.existsSync(mf)) die(`missing ${path.relative(repoRoot, mf)} — run: python bench/offline/poisson_ref.py --n ${n}`)
  }
}
const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p))
if (!chromePath) die('Chrome not found')
const FLAGS = ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--force-high-performance-gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
const HMR_STUB = `// gpu-bench.mjs: HMR disabled for the benchmark run
export function createHotContext() { return { accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, on() {}, off() {}, send() {}, decline() {}, data: {} } }
export function updateStyle() {}
export function removeStyle() {}
export function injectQuery(u) { return u }
export class ErrorOverlay {}
`

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = path.join(repoRoot, 'bench-results', 'gate0', label ? `${stamp}-${label}` : stamp)
// sha256 of the code measured (the tree is usually dirty: HEAD alone does not identify it)
const hashFiles = () => {
  const out = {}
  const add = rel => { const p = path.join(repoRoot, rel); if (fs.existsSync(p) && fs.statSync(p).isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) }
  const addDir = rel => { const d = path.join(repoRoot, rel); if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) add(`${rel}/${f}`) }
  for (const f of ['gpu-bench.html', 'src/gpu-sim/MpmGpuSimulator.ts', 'src/fluid-render/SSFRPipeline.ts', 'src/fluid-engine/FluidEngine.ts', 'src/composition/CompositionTable.ts', 'scripts/gpu-bench.mjs', 'bench/offline/poisson_ref.py']) add(f)
  for (const d of ['src/gpu-sim/shaders', 'src/fluid-render/shaders', 'src/gpu-sim/flip/poisson', 'src/bench/gate0']) addDir(d)
  for (const n of sizesN) add(`bench-results/gate0/fixtures/n${n}/manifest.json`)
  return out
}
let gitSha = null
let gitDirtyCount = null
try {
  gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim()
  gitDirtyCount = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString().split(/\r?\n/).filter(Boolean).length
} catch { /* not a repo */ }

const plan = []
if (tests.includes('g0a')) plan.push(['g0a', { grids: [64, 48, 4], Ks: [10, 100, 1000], reps: quick ? 5 : 9 }])
if (tests.includes('g0b')) for (const n of sizesN) plan.push(['g0b', { n, reps: quick ? 3 : 7 }])
if (tests.includes('g0s')) for (const n of sizesN) plan.push(['g0s', { n }])     // params completed from g0b
if (tests.includes('g0f')) for (const particles of [30000, 100000]) plan.push(['g0f', { particles, frames: quick ? 120 : 240, settleFrames: quick ? 300 : 600 }])
if (tests.includes('g0g')) {
  const fr = quick ? 120 : 180
  for (const particles of [30000, 100000, 250000]) for (const [width, height] of [[1280, 800], [2560, 1600]]) plan.push(['g0g', { particles, width, height, view: 'engine', layout: 'floor', frames: fr }])
  for (const particles of [100000, 250000]) for (const [width, height] of [[1280, 800], [2560, 1600]]) {
    plan.push(['g0g', { particles, width, height, view: 'top', layout: 'floor', frames: fr }])
    plan.push(['g0g', { particles, width, height, view: 'engine', layout: 'column', frames: fr }])
  }
}

// Best-effort GPU load snapshot (another process using the GPU inflates every timestamp interval,
// which measures wall time on the GPU). Non-fatal; recorded at start and end.
const gpuSnapshot = () => {
  try {
    const q = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,clocks.gr,clocks.max.gr,temperature.gpu,power.draw,pstate', '--format=csv,noheader'], { timeout: 10_000 }).toString().trim()
    const apps = execFileSync('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader'], { timeout: 10_000 }).toString().trim().split(/\r?\n/).filter(Boolean)
    return { at: new Date().toISOString(), gpu: q, computeApps: apps.length }
  } catch (e) { return { at: new Date().toISOString(), error: String(e?.message ?? e).slice(0, 200) } }
}

let browser = null
const watchdog = setTimeout(() => { console.error('✗ watchdog: 45 min exceeded'); try { browser?.process()?.kill() } catch { /* */ } process.exit(3) }, 45 * 60_000)
const hashesAtStart = hashFiles()
const results = { stamp, label, gitSha, gitDirty: gitDirtyCount, gpuAtStart: gpuSnapshot(), gpuAtEnd: null, fileSha256: hashesAtStart, filesChangedDuringRun: null, url, chromeFlags: FLAGS, hmr: 'stubbed', websocketsOpened: [], quick, devRun: true, adapter: null, browserVersion: null, tests: [], consoleErrors: [] }
let reloads = 0
try {
  browser = await chromium.launch({ executablePath: chromePath, headless: false, args: [...windowArgs({ timing: true }), ...FLAGS] })
  results.browserVersion = browser.version()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', m => { if (m.type() === 'error') results.consoleErrors.push(m.text().slice(0, 400)) })
  page.on('pageerror', e => results.consoleErrors.push(String(e).slice(0, 400)))
  page.on('websocket', ws => results.websocketsOpened.push(ws.url()))
  let loads = 0
  page.on('load', () => { loads++; if (loads > 1) reloads++ })
  await page.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR_STUB }))
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.bringToFront()
  await page.waitForFunction(() => window.__gate0 && (window.__gate0.ready || window.__gate0.error), null, { timeout: 120_000 })
  const init = await page.evaluate(() => ({ ready: window.__gate0.ready, error: window.__gate0.error }))
  if (!init.ready) throw new Error(`page init failed: ${init.error}`)
  if (results.websocketsOpened.length) throw new Error(`HMR stub failed: websocket(s) opened ${results.websocketsOpened.join(', ')}`)
  const info = await page.evaluate(() => window.__gate0.info())
  results.adapter = info
  console.log(`adapter: vendor=${info.vendor} arch=${info.architecture} desc="${info.description}" ts=${info.timestampQuery} battery=${JSON.stringify(info.battery)}`)
  if (!/nvidia/i.test(`${info.vendor} ${info.description}`)) throw new Error(`adapter is not NVIDIA (vendor "${info.vendor}", "${info.description}") — Chrome picked the wrong GPU`)
  if (!info.timestampQuery) throw new Error('adapter has no timestamp-query')
  for (const [test, params0] of plan) {
    const params = { ...params0 }
    if (test === 'g0s') {
      const b = results.tests.find(t => t.test === 'g0b' && t.result?.n === params.n)?.result
      if (!b) { results.tests.push({ test, params, error: `no g0b result for n=${params.n}` }); continue }
      const cold = cls => b.cases.filter(c => c.method === 'mgpcg' && c.solve === cls && !c.warm && !c.fcoef && c.gpu.iters !== null)
        .sort((x, y) => y.gpu.iters - x.gpu.iters || y.binf - x.binf)[0]
      const pc = cold('p'), qc = cold('psi')
      Object.assign(params, {
        capP: b.caps.mgpcg.p, capPsi: b.caps.mgpcg.psi, pCase: pc.name, psiCase: qc.name, particles: 100000,
        frames: quick ? 30 : 60, batches: quick ? 2 : 3,
        renders: params.n === 64 ? [2, 3].flatMap(nsub => ['low', 'high'].map(variant => ({ width: 2560, height: 1600, view: 'engine', nsub, variant }))) : [],
      })
    }
    const vis = await page.evaluate(() => document.visibilityState)
    if (vis !== 'visible') throw new Error(`page not visible (${vis}) before ${test}`)
    process.stdout.write(`▶ ${test} ${JSON.stringify(params).slice(0, 160)} … `)
    const t0 = Date.now()
    const reloadsBefore = reloads
    let r
    try {
      r = await page.evaluate(([t, p]) => window.__gate0.run(t, p), [test, params])
    } catch (e) {
      const msg = String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 400)
      const destroyed = /context was destroyed|Target closed|navigation/i.test(msg) || reloads > reloadsBefore
      console.log(`FAILED${destroyed ? ' (PAGE RELOADED / CONTEXT DESTROYED)' : ''}: ${msg}`)
      results.tests.push({ test, params, error: msg, pageReloaded: destroyed })
      if (destroyed) throw new Error(`page reloaded during ${test}; the run is invalid (HMR stub bypassed?)`)
      continue
    }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`)
    const bad = r.invalidTimestamps ?? r.timing?.invalidTimestamps
    if (bad) throw new Error(`${test}: invalid timestamps (${bad}) — developer-features flag not active or timer broken`)
    if (typeof r.previewPng === 'string') {   // G0-g render proof image: file, not JSON
      const fn = `g0g-${r.particles}-${r.layout}-${r.view}-${r.width}x${r.height}.png`
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, fn), Buffer.from(r.previewPng.split(',')[1], 'base64'))
      r.previewPng = fn
    }
    results.tests.push({ test, params, result: r })
  }
  await page.evaluate(() => window.__gate0.run('cleanup'))
  if (reloads) throw new Error(`page reloaded ${reloads} time(s) during the run`)
} catch (e) {
  results.fatal = e?.message ?? String(e)
  console.error(`✗ ${results.fatal}`)
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
}
results.gpuAtEnd = gpuSnapshot()
const hashesAtEnd = hashFiles()
results.filesChangedDuringRun = Object.keys({ ...hashesAtStart, ...hashesAtEnd }).filter(k => hashesAtStart[k] !== hashesAtEnd[k])
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1))
fs.writeFileSync(path.join(outDir, 'report.md'), buildReport(results))
console.log(`→ ${path.relative(repoRoot, outDir)}/{results.json,report.md}`)
if (results.filesChangedDuringRun.length) console.log(`! files changed during the run (the page ran the start version): ${results.filesChangedDuringRun.join(', ')}`)
const anyFail = results.tests.some(t => t.error || (t.test === 'g0b' && !(t.result.unitPass && t.result.casePass && t.result.trueResidualPass && t.result.scaledPass)) || (t.test === 'g0s' && !t.result.iterCheckPass))
process.exit(results.fatal ? 2 : anyFail ? 1 : 0)

// ─────────────────────────────────────────────────────────────────────────────────────────────
function buildReport(R) {
  const f3 = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(3)
  const f2 = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(2)
  const e2 = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toExponential(2)
  const L = []
  L.push(`# Gate 0 microbenchmarks — ${R.stamp}${R.label ? ` (${R.label})` : ''}`)
  L.push('')
  L.push('**DEV RUN** on the shared development machine (other processes, dev server and IDE running). Every MEASURED number below must be re-measured by the lead on an idle GPU, on AC power, before it decides anything. FINAL-PLAN §7 S0.5.')
  L.push('')
  const a = R.adapter ?? {}
  L.push(`- git HEAD \`${R.gitSha}\` with ${R.gitDirty} uncommitted paths: HEAD does NOT identify the measured code; see fileSha256 in results.json (hashed at page load).`)
  if (R.reportRebuiltAt) L.push(`- report.md REBUILT ${R.reportRebuiltAt} from this run's results.json by gpu-bench.mjs ${JSON.stringify(R.reportRebuiltBy)} (evaluation rules changed; measurements unchanged)`)
  L.push(`- HMR: ${R.hmr}; websockets opened: ${R.websocketsOpened?.length ?? 0}; files changed during the run: ${R.filesChangedDuringRun?.length ? R.filesChangedDuringRun.join(', ') + ' (the page ran the start version)' : 'none'}`)
  L.push(`- browser: Chrome ${R.browserVersion}; flags: \`${(R.chromeFlags ?? []).join(' ')}\``)
  L.push(`- adapter: vendor **${a.vendor}**, architecture ${a.architecture}, description "${a.description}", timestamp-query ${a.timestampQuery}`)
  L.push(`- battery: ${JSON.stringify(a.battery)}; DPR ${a.devicePixelRatio}; screen ${a.screen?.width}×${a.screen?.height}`)
  L.push(`- device limits: ${JSON.stringify(a.limits)}`)
  L.push(`- nvidia-smi (utilization, clock, max clock, temperature, power, P-state) at start: ${R.gpuAtStart?.gpu ?? R.gpuAtStart?.error}; at end: ${R.gpuAtEnd?.gpu ?? R.gpuAtEnd?.error}`)
  // contention check: the same render measured twice in this run (G0-g standalone and the G0-s
  // render-only row) must agree; a large gap means another GPU workload overlapped one of them
  {
    const gs = R.tests.filter(t => t.test === 'g0s' && t.result).map(t => t.result).flatMap(s => (s.joint ?? []).filter(j => j.scenario === 'empty'))
    const gg = R.tests.find(t => t.test === 'g0g' && t.result?.particles === 100000 && t.result.width === 2560 && t.result.layout === 'floor' && t.result.view === 'engine')?.result
    if (gs.length && gg) {
      const ref = Math.min(...gs.map(j => j.gpuMs))
      const ratio = gg.gpuMedianMs / ref
      L.push(`- contention check: SSFR 100k floor 2560×1600 engine measured ${gg.gpuMedianMs.toFixed(3)} ms in G0-g and ${gs.map(j => j.gpuMs.toFixed(3)).join('/')} ms inside G0-s → ratio ${ratio.toFixed(2)} ${Math.abs(ratio - 1) > 0.2 ? '**INCONSISTENT: another GPU workload likely overlapped part of this run; do not use the affected numbers**' : '(consistent within 20%)'}`)
    }
  }
  if (R.fatal) L.push(`\n**FATAL: ${R.fatal}**`)
  if (R.consoleErrors?.length) L.push(`\nConsole errors (${R.consoleErrors.length}): ${R.consoleErrors.slice(0, 5).map(s => '`' + s.replace(/`/g, "'") + '`').join('; ')}`)
  const get = (t) => R.tests.filter(x => x.test === t && x.result).map(x => x.result)
  const failed = R.tests.filter(x => x.error)
  if (failed.length) {
    L.push('\n**Tests that FAILED (no numbers reported for them):**')
    for (const f of failed) L.push(`- ${f.test} ${JSON.stringify(f.params).slice(0, 200)}: ${f.error}`)
  }
  const passFail = []
  for (const b of get('g0b')) passFail.push(`G0-b ${b.n}³ unit ${b.unitPass ? 'PASS' : 'FAIL'}, counts ${b.casePass ? 'PASS' : 'FAIL'}, true-residual gate ${b.trueResidualPass ? 'PASS' : 'FAIL'}, scaled/discrete-hydrostatic/relabel/b=0/faults ${b.scaledPass ? 'PASS' : 'FAIL'}`)
  for (const s of get('g0s')) passFail.push(`G0-s ${s.n}³ iteration check ${s.iterCheckPass ? 'PASS' : 'FAIL'}`)
  if (passFail.length) L.push(`\nVerdicts: ${passFail.join('; ')}`)

  // ── G0-a
  const g0a = get('g0a')[0]
  const fit = (n, mode) => g0a?.fits.find(f => f.n === n && f.mode === mode)
  if (g0a) {
    L.push('\n## G0-a — per-dispatch floor (MEASURED)')
    L.push('GPU time = first-pass begin → last-pass end timestamp, median of reps; slope over K ∈ {10, 100, 1000} dependent 7-point passes. Wall = submit → onSubmittedWorkDone (one command buffer at a time).\n')
    L.push('| grid | mode | slope µs/dispatch (GPU) | intercept µs | r² | wall slope µs/dispatch | JS encode µs/dispatch |')
    L.push('|---|---|---|---|---|---|---|')
    for (const f of g0a.fits) L.push(`| ${f.n}³ | ${f.mode} | ${f3(f.slopeUsPerDispatch)} | ${f2(f.interceptUs)} | ${f3(f.r2)} | ${f3(f.wallSlopeUsPerDispatch)} | ${f3(f.encodeUsPerDispatch)} |`)
    const fl = fit(4, 'one-direct'), ind = fit(4, 'one-indirect'), ind0 = fit(64, 'one-indirect0'), fs_ = fit(64, 'one-flagset'), d64 = fit(64, 'one-direct'), d48 = fit(48, 'one-direct'), s4 = fit(4, 'sep-direct'), m4 = fit(4, 'one-multi')
    L.push('\nDerived (MEASURED slopes):')
    L.push(`- per-dispatch GPU floor f (4³, one pass, direct, one pipeline): **${f3(fl?.slopeUsPerDispatch)} µs**; separate passes (4³): ${f3(s4?.slopeUsPerDispatch)} µs`)
    L.push(`- indirect at 4³: ${f3(ind?.slopeUsPerDispatch)} µs → extra per indirect dispatch (validation pair v ≈ indirect − direct): **${f3((ind?.slopeUsPerDispatch ?? NaN) - (fl?.slopeUsPerDispatch ?? NaN))} µs**; zero-workgroup indirect (64³): ${f3(ind0?.slopeUsPerDispatch)} µs`)
    L.push(`- dependent 7-point pass: 64³ ${f3(d64?.slopeUsPerDispatch)} µs, 48³ ${f3(d48?.slopeUsPerDispatch)} µs (MEASURED directly, no scaling); encoded-but-skipped (flag set, 64³): **${f3(fs_?.slopeUsPerDispatch)} µs**`)
    L.push(`- pipeline + bind-group switch on every dispatch (4³, 3 pipelines / 3 layouts): GPU ${f3(m4?.slopeUsPerDispatch)} µs, **wall ${f3(m4?.wallSlopeUsPerDispatch)} µs** per dispatch vs ${f3(fl?.wallSlopeUsPerDispatch)} µs with one pipeline. G0-s below measures the solver's own CPU-side cost directly.`)
    L.push('- GPU-process CPU time from a Chrome trace (FINAL-PLAN G0-a) was NOT measured: G0-s frame throughput is the indirect measure used instead.')
  }

  // ── G0-b
  const g0b = get('g0b')
  for (const b of g0b) {
    L.push(`\n## G0-b — ${b.n}³ solver correctness vs numpy (MEASURED)`)
    L.push(`Solver: ${b.solverInfo.map(s => `${s.method}: levels ${s.levels.join('→')}${s.method === 'mgpcg' ? `, one-workgroup tail from level ${s.tailFromLevel}` : ''}, dispatches: solve = ${s.dispatches.init} + ${s.dispatches.perIteration}/iteration + ${s.dispatches.finalize}, prepare ${s.dispatches.prepare}`).join('; ')}. numpy ${b.manifestNumpy}.`)
    L.push(`\nUnit fixtures (pass rule fixed before the run: rel err ≤ 4·max(numpy f32-vs-f64 rel err, 2⁻²³)) — **${b.unitPass ? 'PASS' : 'FAIL'}**:`)
    for (const [k, u] of Object.entries(b.unit)) L.push(`- ${k}: GPU rel err ${e2(u.relErr)} (limit ${e2(u.limit)}; numpy f32 ${e2(u.numpyF32RelErr)}) ${u.pass ? 'PASS' : 'FAIL'}`)
    L.push(`\nIteration counts, ±2 of numpy f64 AND f32 (FINAL-PLAN G0-b) — **${b.casePass ? 'ALL PASS' : 'FAIL'}**. True residual recomputed in f64 from the GPU's x; gate (fixed before the run): production cases (p, ψ), MGPCG, true ‖r‖∞ ≤ tol — **${b.trueResidualPass ? 'PASS' : 'FAIL'}**. JPCG and parity rows are reported next to numpy f32's own true residual, not gated.\n`)
    L.push('| case | class | method | crit/tol | ‖b‖∞ | GPU | np f64 | np f32 | ±2 | true residual (GPU x) | np f32 true | ≤ tol | max |log₁₀ hist/np32| |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const c of b.cases) L.push(`| ${c.name}${c.warm ? ' (warm x0)' : ''} | ${c.solve} | ${c.method} | ${c.criterion} ${c.tol} | ${Number(c.binf).toPrecision(4)} | ${c.gpu.iters ?? 'none'}${c.gpu.breakdown ? ' BREAKDOWN' : ''} | ${c.numpy.f64} | ${c.numpy.f32} | ${c.pass ? '✓' : '✗'} | ${e2(c.trueResidual.value)} | ${e2(c.trueResidual.numpyF32)} | ${c.trueResidual.withinTol ? 'yes' : (c.trueResidual.gated ? '**NO (gated)**' : 'no (not gated)')} | ${f3(c.historyVsNumpyF32.maxAbsLog10)} |`)
    L.push(`\nScaled operator a_f = Δt/(ρ dx²) (Δt = 1/120 s, ρ = 998.207 kg/m³, NIST WebBook 20 °C), label change, zero RHS, fault counters — **${b.scaledPass ? 'PASS' : 'FAIL'}**:`)
    for (const s of b.scaled) {
      if (s.check === 'scale-invariance') L.push(`- ${s.method} scale invariance on ${s.name}: ${s.iters} iterations vs ${s.unitIters} unit-coefficient (≤ ±1) ${s.pass ? 'PASS' : 'FAIL'}; true ‖r‖∞ ${e2(s.trueInf)} s⁻¹`)
      else L.push(`- ${s.method} discrete hydrostatic SOLVER check (tank_half, one gravity step from rest; exact solution of the voxel system p = ρ g dx (N − y), free surface at the first AIR cell centre — a solver check, not a physics validation of ρ g depth): p_bottom ${f2(s.pBottomPa)} Pa vs ${f2(s.pBottomExactPa)} Pa; max |p/p_exact − 1| ${e2(s.maxRelErr)} (≤ 1e-3) ${s.pass ? 'PASS' : 'FAIL'}`)
    }
    for (const r of b.relabel ?? []) L.push(`- ${r.method} warm start from the GPU's own x across a label change (${r.from} → ${r.to}): ${r.iters} iterations (cold ${r.coldIters}); recursive ‖r‖∞ ${e2(r.recursiveInf)}, TRUE ‖r‖∞ ${e2(r.trueInf)} ≤ ${r.tol} ${r.pass ? 'PASS' : 'FAIL'}`)
    for (const z of b.zeroRhs ?? []) L.push(`- ${z.method} ${z.check}: ${z.iters} iterations, converged ${z.converged}${z.trueInf !== undefined ? `, true ‖Ax‖∞ ${e2(z.trueInf)}` : ''} ${z.pass ? 'PASS' : 'FAIL'}`)
    for (const [m, f] of Object.entries(b.faults ?? {})) L.push(`- ${m} sticky fault counters after the run: solves ${f.solves}, cap hits ${f.capHits}, breakdowns ${f.breakdowns}, max iterations ${f.maxIterations} (expected ≥ 1 cap hit from the b = 0 rel2 check, 0 breakdowns) ${f.pass ? 'PASS' : 'FAIL'}`)
    L.push(`\nProduction caps from this run (p95 + 2 of GPU counts, all cold and warm production cases): ${Object.entries(b.caps).map(([m, c]) => `${m}: p ${c.p}, ψ ${c.psi}`).join('; ')}. MGPCG counts behind them: p ${JSON.stringify(b.capBasis?.mgpcg?.p)}, ψ ${JSON.stringify(b.capBasis?.mgpcg?.psi)}.`)
    if (b.timing) {
      L.push('\nTiming (MEASURED, median of reps, GPU timestamps):\n')
      L.push('| method | domain | prepare ms | t_iter ms (slope) | init ms | r² | V-cycle ms | tail kernel ms | tail levels | dispatches/iter | tol<0 run executed N? |')
      L.push('|---|---|---|---|---|---|---|---|---|---|---|')
      for (const d of b.timing.perDomain) L.push(`| ${d.method} | ${d.domain} | ${f3(d.prepareMs)} | ${f3(d.tIterMs)} | ${f3(d.initMs)} | ${f3(d.r2)} | ${f3(d.vcycleMs)} | ${f3(d.tailKernelMs)} | ${(d.tailLevels ?? []).join(',')} | ${d.dispatchesPerIter} | ${d.tIterValid ? 'yes' : `NO (${d.lastRunIters})`} |`)
      L.push('\n| case (MGPCG) | iters | GPU ms at cap=iters | cap | GPU ms at cap | GPU ms per skipped iteration | dispatches at cap | JS encode ms at cap |')
      L.push('|---|---|---|---|---|---|---|---|')
      for (const c of b.timing.perCase) L.push(`| ${c.name}${c.warm ? ' (warm)' : ''} | ${c.iters} | ${f3(c.T_exact_ms)} | ${c.cap ?? '—'} | ${f3(c.T_cap_ms)} | ${f3(c.skippedIterMs)} | ${c.dispatchesAtCap ?? '—'} | ${f3(c.encodeCapMs)} |`)
      L.push('\nThese are GPU times only. The CPU-side cost of the dispatches is measured in G0-s.')
    }
  }

  // ── G0-s
  const g0s = get('g0s')
  for (const s of g0s) {
    L.push(`\n## G0-s — ${s.n}³ whole-substep chain: GPU time AND frame throughput (MEASURED)`)
    L.push(`One substep = ψ prepare + ψ solve (cold, cap ${s.capPsi}, case ${s.psiCase}) + p prepare + p solve (cold, cap ${s.capP}, case ${s.pCase}) + G grid passes (7-point, 3 pipelines / 3 layouts) + MpmGpuSimulator.step(enc, k) at ${s.particles} particles. low: G ${s.gridPasses.low}, k ${s.mpmSubstepsPerSubstep.low}; high: G ${s.gridPasses.high}, k ${s.mpmSubstepsPerSubstep.high}; solverOnly: the solves and prepares only. The grid passes and MPM step are EST proxies for S3's non-solver work; the solver part is the real solver.`)
    L.push('Scenarios: fixture = executed iterations = the case\'s measured count, rest early-exits; exec = every iteration to the cap executes; skip = every iteration early-exits; empty = markers only. period = frames encoded + submitted back-to-back, one wait, total/frames (a per-rAF encoder\'s frame period); period(pre-encoded) excludes main-thread JS.\n')
    L.push('| scenario | variant | substeps | dispatches/frame | GPU ms | JS encode ms | latency ms | **period ms** | period pre-encoded ms | bound | iterations p/ψ |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of s.rows) L.push(`| ${r.scenario} | ${r.variant} | ${r.nsub} | ${r.dispatches} | ${f3(r.gpuMs)} | ${f3(r.encodeMs)} | ${f3(r.latencyMs)} | **${f3(r.periodMs)}** | ${f3(r.periodPreMs)} | ${r.periodMs > 1.15 * r.gpuMs ? 'CPU side' : 'GPU'} | ${r.lastSolve ? `${r.lastSolve.p.iters}/${r.lastSolve.psi.iters}` : '—'} |`)
    if (s.cpu?.length) {
      L.push('\nPer-dispatch CPU-side cost c from the dispatch-floor chain (solverOnly, skip): c = (period − empty period) / dispatches.\n')
      L.push('| substeps | dispatches | GPU ms | period ms | c µs/dispatch pipelined (with JS encode) | c pipelined, pre-encoded | c serial = (latency − empty latency − GPU)/dispatches | JS encode µs/dispatch |')
      L.push('|---|---|---|---|---|---|---|---|')
      for (const c of s.cpu) L.push(`| ${c.nsub} | ${c.dispatches} | ${f3(c.gpuMs)} | ${f3(c.periodMs)} | ${f3(c.cUsPerDispatch)} | ${f3(c.cPreUsPerDispatch)} | ${f3(c.cSerialUsPerDispatch)} | ${f3(c.encodeUsPerDispatch)} |`)
      L.push("\nPipelined c is what bounds the frame period (the GPU process records frame k+1 while the GPU runs frame k); serial c is the extra latency of one frame. Both depend on machine load: the reviewer's probe measured ≈ 4.4 µs/dispatch on a busier machine; re-measure idle.")
    }
    if (s.joint?.length) {
      L.push('\nJoint frames (chain, fixture scenario, + SSFR render of the 100k MPM state in the same command buffer; "empty" rows = the render alone):\n')
      L.push('| content | variant | substeps | render | GPU ms | JS encode ms | **period ms** | fits 16.7 − 2 ms? |')
      L.push('|---|---|---|---|---|---|---|---|')
      for (const r of s.joint) L.push(`| ${r.scenario === 'empty' ? 'render only' : 'chain + render'} | ${r.scenario === 'empty' ? '—' : r.variant} | ${r.nsub || '—'} | ${r.render} ${r.view} | ${f3(r.gpuMs)} | ${f3(r.encodeMs)} | **${f3(r.periodMs)}** | ${r.periodMs <= 14.7 ? 'yes' : 'no'} |`)
    }
    L.push(`\nIteration check (fixture converged, exec ran to cap, skip ran 0): ${s.iterCheckPass ? 'PASS' : 'FAIL'}`)
  }

  // ── G0-f
  const g0f = get('g0f')
  if (g0f.length) {
    L.push('\n## G0-f — current MLS-MPM substep (MEASURED)')
    L.push('`MpmGpuSimulator.step(enc, k)` bracketed by timestamp marker passes; per-substep = interval / k, with the pass count asserted (5 per substep). Water block at 4 particles/cell on the floor, seeded uniform random.\n')
    L.push('| particles | window | substeps per call | frames | per-substep median ms | per-substep mean ms | call p95 ms | submit→done ms |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const r of g0f) for (const [w, s] of [['t=0 (fresh spawn)', r.t0], [`settled (${r.settleFrames} frames)`, r.settled], [`settled (${r.settleFrames} frames)`, r.settled2]]) L.push(`| ${r.particles} | ${w} | ${s.substepsPerCall} | ${s.frames} | ${f3(s.perSubstepMedianMs)} | ${f3(s.perSubstepMeanMs)} | ${f3(s.callP95Ms)} | ${f3(s.wallSubmitToDoneMedianMs)} |`)
    L.push('\nNot measured here: the plan\'s "sustained 60 s after mixing", the battery-vs-AC split, the Chrome/native factor k and S2 capacity (dev run: short windows).')
  }

  // ── G0-g
  const g0g = get('g0g')
  if (g0g.length) {
    L.push('\n## G0-g — SSFR render (MEASURED)')
    L.push('`SSFRPipeline.render()` into an offscreen texture of the canvas format at the stated pixel size, FluidEngine\'s SSFR config. engine = FluidEngine\'s camera; top = the same lens looking straight down so the water fills the view (the blur skips background pixels, so coverage drives cost). floor = settled layer; column = dam-break column right after spawn.\n')
    L.push('| particles | layout | view | pixels | GPU median ms | mean | p95 | submit→done ms | fluid pixel fraction | preview |')
    L.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const r of g0g) L.push(`| ${r.particles} | ${r.layout} | ${r.view} | ${r.width}×${r.height} | ${f3(r.gpuMedianMs)} | ${f3(r.gpuMeanMs)} | ${f3(r.gpuP95Ms)} | ${f3(r.wallSubmitToDoneMedianMs)} | ${f3(r.fluidPixelFraction)} | ${r.previewPng} |`)
  }

  // ── Branch rule
  L.push('\n## Branch rule (FINAL-PLAN §7 S0.5) — evaluated with this dev run')
  const rend = (w, layout, view) => g0g.find(r => r.particles === 100000 && r.width === w && r.layout === layout && r.view === view)
  if (!g0s.length || !g0g.length) {
    L.push('Not evaluable: a required measurement is missing (need G0-s and G0-g 100k).')
    return L.join('\n') + '\n'
  }
  L.push('T_sim(n) is the MEASURED frame period of the G0-s chain (fixture scenario) with n substeps per frame: both constraints at once — the GPU time AND the CPU-side cost of encoding, validating and submitting every dispatch (the period is max-like of the two, whichever binds). The solver part is the real solver at this run\'s caps; the grid passes and particle transfers are EST proxies (low: 9 grid passes + 1× the MPM substep; high: 27 + 2×).')
  const top25 = rend(2560, 'floor', 'top'), top12 = rend(1280, 'floor', 'top')
  if (top25 || top12) L.push(`\n**Render headline (MEASURED): every verdict below holds only for FluidEngine's camera, where the water covers ≈ 4–8 % of the pixels.** With the water filling the view (top camera, 100k, ≈ 79 % coverage) SSFR alone costs ${f3(top25?.gpuMedianMs)} ms at 2560×1600 — over the whole 16.7 ms frame — and ${f3(top12?.gpuMedianMs)} ms at 1280×800, leaving ${f3(16.7 - 2 - (top12?.gpuMedianMs ?? NaN))} ms for the sim. The render resolution / cost decision (owner D12, render track R0) must be made against coverage, not only pixel count.`)
  L.push('\nB_sim = 16.7 − T_render − 2 ms, FluidEngine camera, 100k. n = 2 rows use the settled-floor render (calm scene); n = 3 rows use max(floor, dam-column right after spawn): mid-collapse the water spreads over the floor, so the spawn frame (the cheaper one) is not representative. Verdict: **yes** = T_sim(high) ≤ B_sim and the joint high frame fits 14.7 ms (where measured); **borderline** = only the low EST fits (additively, or in the joint frame measured in one command buffer); **no** = neither fits. Dev-run margins under ≈ 0.5 ms are not meaningful.')
  L.push('CPU-side sensitivity: the frame period of the dispatch-floor chain is ≈ dispatches × c. c measured in this run is given per grid; c = 4.4 µs is the highest value observed (reviewer probe, busier machine). "CPU floor at 4.4 µs" = dispatches/frame × 4.4 µs; where it exceeds B_sim the CPU side alone would decide the row on a machine that loaded.\n')
  L.push('| grid | n | render (px, layout) | T_render ms | B_sim ms | T_sim low ms (GPU ms) | T_sim high ms (GPU ms) | exec high ms | joint chain+render low / high ms (≤ 14.7?) | dispatches/frame low | CPU floor at this run\'s c / at 4.4 µs, ms | verdict |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const s of g0s) {
    for (const w of [2560, 1280]) {
      for (const nsub of [2, 3]) {
        const cands = (nsub === 3 ? ['floor', 'column'] : ['floor']).map(l => rend(w, l, 'engine')).filter(Boolean)
        if (!cands.length) continue
        const r = cands.reduce((a, b) => (b.gpuMedianMs > a.gpuMedianMs ? b : a))
        const row = (sc, v) => s.rows.find(x => x.scenario === sc && x.variant === v && x.nsub === nsub)
        const lo = row('fixture', 'low'), hi = row('fixture', 'high'), ex = row('exec', 'high')
        if (!lo || !hi) continue
        const B = 16.7 - r.gpuMedianMs - 2
        const jt = variant => (s.joint ?? []).find(j => j.scenario === 'fixture' && j.variant === variant && j.nsub === nsub && j.render === `${w}x${w === 2560 ? 1600 : 800}`)
        const jl = jt('low'), jh = jt('high')
        const hiFits = hi.periodMs <= B && (!jh || jh.periodMs <= 14.7)
        const loFits = lo.periodMs <= B || (jl && jl.periodMs <= 14.7)
        const v = hiFits ? 'yes' : loFits ? 'borderline' : 'no'
        const cRun = s.cpu?.find(c => c.nsub === nsub)?.cUsPerDispatch
        const cpuRun = cRun !== undefined ? lo.dispatches * cRun / 1000 : NaN
        const cpu44 = lo.dispatches * 4.4 / 1000
        const joint = jl || jh ? `${f3(jl?.periodMs)} (${jl && jl.periodMs <= 14.7 ? 'fits' : 'no'}) / ${f3(jh?.periodMs)} (${jh && jh.periodMs <= 14.7 ? 'fits' : 'no'})` : '—'
        L.push(`| ${s.n}³ | ${nsub} | ${r.width}×${r.height} (${r.layout}) | ${f3(r.gpuMedianMs)} | ${f3(B)} | ${f3(lo.periodMs)} (${f3(lo.gpuMs)}) | ${f3(hi.periodMs)} (${f3(hi.gpuMs)}) | ${f3(ex?.periodMs)} | ${joint} | ${lo.dispatches} | ${f3(cpuRun)} / ${f3(cpu44)}${cpu44 > B ? ' (> B_sim)' : ''} | **${v}** |`)
      }
    }
  }
  const c64 = g0s.find(s => s.n === 64)?.cpu?.find(c => c.nsub === 3)
  if (c64) L.push(`\nThe CPU-side cost per dispatch c = ${f3(c64.cUsPerDispatch)} µs (64³, n = 3, every iteration early-exiting) is what makes cap-sized encoding expensive: dispatches/iteration = ${g0s[0].solverDispatches.perIteration}, so every encoded MGPCG iteration costs ≈ ${f3(c64.cUsPerDispatch * g0s[0].solverDispatches.perIteration / 1000)} ms of CPU-side time per solve even when it early-exits on the GPU. 48³ has the same MG depth (5 levels) and the same ${g0s.find(s => s.n === 48)?.solverDispatches.perIteration ?? '?'} dispatches/iteration, so it relieves a CPU-bound frame only through smaller caps, not fewer dispatches per iteration.`)
  L.push('\nLevers, ranked by dispatches removed (none measured here): (1) kernel fusion inside the MGPCG iteration (alpha/check/beta reductions folded into the neighbouring passes, residual folded into restriction, prolongation into the first post-smoothing sweep); (2) density (ψ) projection once per macro-step instead of per substep (must still pass G2); (3) a lagged adaptive cap (encode cap = last frame\'s count + margin, like v_lag), with the sticky cap-hit counter as the safety net; (4) fewer coarse sweeps (GPU-only saving; changes numpy parity, needs its own count check).')
  L.push('\nAll numbers are dev-run: the verdicts are provisional until the lead re-measures on an idle GPU on AC power.')
  return L.join('\n') + '\n'
}
