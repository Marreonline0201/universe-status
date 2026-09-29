#!/usr/bin/env node
// OPT-1-cov — the SSFR render cost against screen coverage (vault fluid/realism-2026-09/EXTENDED-ROADMAP.md §1.4, §5
// G0b "OPT-1-cov"): after the splat resize (the anisotropic ellipsoids, `08248d1c`), re-run dev6's G0-g at 7 %, 30 %,
// 50 % and 80 % screen coverage, 100k and 250k particles, median and p95 — "this number decides whether first-person
// water is possible with SSFR at all".
//
//   node scripts/fluid-gates/opt1-cov.mjs      (default server: the clean gate tree; FLUID_BASE to override)
//
// Method (fixed before the first run). The FLUID TEST page's own SSFR path — window.__fluidBench.renderTiming renders
// whole offscreen frames (ellipsoid kernel, depth + thickness splats, blur, composite), each its own submit, bracketed
// by timestamp marker passes (the Gate-0 GpuTimer method) — at 1280 × 800 (the page's render cap, ED-2), in Chrome with
// --enable-webgpu-developer-features (unquantized timestamps), the window on the PRIMARY display (a timing run).
// Scenes: a still water pool over the whole floor, frozen while timing — ≈ 100k particles in the 64³ tank (3.63 m) and
// ≈ 250k in the 88³ tank (4.99 m, the resizable tank's maximum; the 64³ tank holds ≤ 200k).
// Cameras: a perspective lens (fov 50°, near 0.01 world units) looking at the pool's surface centre along the page
// camera's direction, at a sweep of distances (coverage from a few % to a full frame), plus a top view (dev6's "top")
// and an eye-level view (a person 1.2 m above the surface in a corner, looking across); both splat shapes — 'aniso'
// (the default) and 'sphere' (the pre-resize splat).
// Coverage = the fraction of the frame's pixels with thickness > 0 (the liquid's footprint).
// Reported, not gated: median / p95 GPU ms per frame against coverage, and interpolated (piecewise linear in coverage,
// only inside the measured range) at 7 / 30 / 50 / 80 %. dev6's G0-g reference: 1.71 ms at ≈ 7 % and 10.0 ms at 79 %
// (100k, 1280 × 800, the old MPM page's splats, the same timer method).
// Checks (validity of the measurement only): every timing's timestamps valid and unquantized; the liquid is drawn in
// every view (coverage > 0); coverage grows as the camera approaches (the sweep is doing what it claims); a repeat of
// the first configuration at the end within ±20 % of its first median (G0-g's contention check); 0 GPU / console errors.
// Protocol revision 2 (2026-09-29, after the first two clean-tree runs, before the third): run 1 failed the start/end
// check (× 1.32: another session resumed mid-run); run 2 passed it (× 1.016) while three mid-run 64³ configurations read
// 1.6–2.2 × their values in the other two runs — the owner is at the machine and timing runs use the primary display,
// so contention can come and go within a run. Now EVERY configuration is measured in two passes (the second in reverse
// order, so a drift or a burst does not hit the same configuration twice) and a third time if they differ by more than
// 15 %; a configuration counts only when two of its measurements agree within 15 %, and the lower of that pair is
// reported (contention can only add time). Check: no configuration left without an agreeing pair.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sampleAtFrame, makeGate, writeReport, provenance, G_STANDARD } from '../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('OPT-1-cov (SSFR render cost against screen coverage)')
const report = { prov: await provenance(), scenes: [] }
const L = 3.63, DX = L / 64, VP = DX ** 3 / 8, W = 1280, H = 800, FRAMES = 120
const TARGETS = [0.07, 0.30, 0.50, 0.80]
const DEV6 = { at7: 1.71, at79: 10.0 }

const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l) }
const DIR = norm([1.5, 1.0, 1.5])            // the page camera: (2, 1.5, 2) looking at (0.5, 0.5, 0.5)
const SWEEP = [3.0, 2.0, 1.4, 1.0, 0.7, 0.5, 0.35, 0.25, 0.18]   // camera distance ÷ the tank's width

/** Piecewise-linear interpolation of cost at coverage c over points sorted by coverage (null outside the range). */
function interp(points, c, key) {
  const p = [...points].sort((a, b) => a.coverage - b.coverage)
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1]
    if (c >= a.coverage && c <= b.coverage && b.coverage > a.coverage) return a[key] + (b[key] - a[key]) * (c - a.coverage) / (b.coverage - a.coverage)
  }
  return null
}

const { browser, page, errors, adapter } = await openFluidPage(undefined, { timing: true, gpuTimestamps: true })
report.adapter = adapter
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  let first = null
  for (const sc of [{ cells: [64, 64, 64], depth: 0.20 }, { cells: [88, 88, 88], depth: 0.24 }]) {
    await page.evaluate(() => window.__fluidBench.setStepLimit(0))
    const t = (await status(page)).tank
    if (t.cells.join() !== sc.cells.join()) {
      const r = await page.evaluate(c => window.__fluidBench.resizeTank(c), sc.cells)
      if (!r.ok) throw new Error(`resize to ${sc.cells.join('×')} refused: ${r.reason}`)
    }
    const ext = sc.cells.map(c => c * DX)
    await loadScenario(page, { name: `opt1cov-pool-${sc.cells[0]}`, materials: [], gravity_mps2: G_STANDARD, spawns: [{ material: 'Water', box: { min: [0, 0, 0], max: [ext[0], sc.depth, ext[2]] } }] }, 1)
    const s = await sampleAtFrame(page, 30)   // 0.5 s: the pool starts at rest; frozen from here on
    const n = s.n, Hm = n * VP / (ext[0] * ext[2]), e = sc.cells[0] / 64, Hw = Hm / L
    const tgt = [e / 2, Hw, e / 2]
    const cams = [
      ...SWEEP.map(k => ({ name: `sweep d=${k}·W`, camera: { kind: 'perspective', fovDeg: 50, near: 0.01, far: 50, eye: tgt.map((v, a) => v + DIR[a] * k * e), target: tgt } })),
      { name: 'top', camera: { kind: 'perspective', fovDeg: 50, near: 0.01, far: 50, up: [0, 0, -1], eye: [e / 2, Hw + 0.9 * e, e / 2], target: [e / 2, 0, e / 2] } },
      { name: 'eye level (1.2 m above the surface, corner)', camera: { kind: 'perspective', fovDeg: 50, near: 0.01, far: 50, eye: [0.08 * e, Hw + 1.2 / L, 0.08 * e], target: [0.9 * e, Hw, 0.9 * e] } },
      { name: 'page camera', camera: null },
    ]
    const scene = { cells: sc.cells, particles: n, depthM: Hm, rows: [] }
    const configs = ['aniso', 'sphere'].flatMap(shape => cams.map(c => ({ shape, view: c.name, opts: { width: W, height: H, splatShape: shape, frames: FRAMES, ...(c.camera ? { camera: c.camera } : {}) } })))
    const time = async cfg => {
      const r = await page.evaluate(o => window.__fluidBench.renderTiming(o), cfg.opts)
      return { coverage: r.coverage, gpuMedianMs: r.gpuMedianMs, gpuP95Ms: r.gpuP95Ms, gpuMeanMs: r.gpuMeanMs, wallMedianMs: r.wallMedianMs, invalid: r.invalidTimestamps, count: r.count }
    }
    const runs = new Map(configs.map(c => [c, []]))
    for (const c of configs) runs.get(c).push(await time(c))                  // pass A
    for (const c of [...configs].reverse()) runs.get(c).push(await time(c))   // pass B, reversed
    const agree = (a, b) => Math.abs(a.gpuMedianMs / b.gpuMedianMs - 1) <= 0.15
    for (const c of configs) {
      const m = runs.get(c)
      if (!agree(m[0], m[1])) m.push(await time(c))                          // a third measurement when A and B differ
      let best = null
      for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
        if (!agree(m[i], m[j])) continue
        const lo = m[i].gpuMedianMs <= m[j].gpuMedianMs ? m[i] : m[j]
        if (!best || lo.gpuMedianMs < best.gpuMedianMs) best = lo
      }
      const row = { shape: c.shape, view: c.view, ...(best ?? m[0]), agreed: !!best, medians: m.map(x => x.gpuMedianMs), invalid: m.map(x => x.invalid).find(Boolean) ?? null }
      scene.rows.push(row)
      if (!first) first = { opts: c.opts, row }
      console.log(`  ${sc.cells.join('×')} ${String(n).padStart(6)} p  ${c.shape.padEnd(6)} ${c.view.padEnd(44)} coverage ${(100 * row.coverage).toFixed(1).padStart(5)} %  GPU median ${row.gpuMedianMs.toFixed(3)} ms  p95 ${row.gpuP95Ms.toFixed(3)} ms  (passes ${row.medians.map(v => v.toFixed(2)).join(' / ')}${row.agreed ? '' : ' — NO AGREEING PAIR'})${row.invalid ? `  INVALID TIMESTAMPS (${row.invalid})` : ''}`)
    }
    for (const shape of ['aniso', 'sphere']) {
      const pts = scene.rows.filter(r => r.shape === shape)
      scene[shape] = Object.fromEntries(TARGETS.map(c => [`${Math.round(100 * c)}%`, { medianMs: interp(pts, c, 'gpuMedianMs'), p95Ms: interp(pts, c, 'gpuP95Ms') }]))
    }
    report.scenes.push(scene)
  }
  // contention check: the first configuration again (the 88³ scene is loaded now, so rebuild the 64³ pool first)
  await page.evaluate(() => window.__fluidBench.setStepLimit(0))
  await page.evaluate(() => window.__fluidBench.resizeTank([64, 64, 64]))
  await loadScenario(page, { name: 'opt1cov-pool-64', materials: [], gravity_mps2: G_STANDARD, spawns: [{ material: 'Water', box: { min: [0, 0, 0], max: [3.63, 0.20, 3.63] } }] }, 1)
  await sampleAtFrame(page, 30)
  const again = await page.evaluate(o => window.__fluidBench.renderTiming(o), first.opts)
  report.contention = { first: first.row.gpuMedianMs, again: again.gpuMedianMs, ratio: again.gpuMedianMs / first.row.gpuMedianMs }

  // ---- checks (validity of the measurement)
  const all = report.scenes.flatMap(sc => sc.rows)
  const bad = all.filter(r => r.invalid)
  gate.check(bad.length === 0, `timestamps valid and unquantized in all ${all.length} timings${bad.length ? ` — ${bad.length} invalid: ${bad.map(b => `${b.shape}/${b.view}`).join(', ')}` : ''}`)
  const dry = all.filter(r => !(r.coverage > 0))
  gate.check(dry.length === 0, `the liquid is drawn in every view (coverage > 0): ${dry.length ? dry.map(b => `${b.shape}/${b.view}`).join(', ') : 'all'}`)
  let mono = true
  for (const sc of report.scenes) for (const shape of ['aniso', 'sphere']) {
    const sw = sc.rows.filter(r => r.shape === shape && r.view.startsWith('sweep')).map(r => r.coverage)
    for (let i = 1; i < sw.length; i++) if (sw[i] + 1e-3 < sw[i - 1]) mono = false
  }
  gate.check(mono, 'coverage grows as the camera approaches, in every sweep (the sweep does what it claims)')
  gate.check(Math.abs(report.contention.ratio - 1) <= 0.2, `contention: the first configuration re-measured at the end ${report.contention.again.toFixed(3)} ms vs ${report.contention.first.toFixed(3)} ms (× ${report.contention.ratio.toFixed(3)}, ±20 %)`)
  const lone = all.filter(r => !r.agreed), thirds = all.filter(r => r.medians.length > 2).length
  gate.check(lone.length === 0, `every configuration has two measurements within 15 % (revision 2): ${lone.length ? `${lone.length} without — ${lone.map(b => `${b.shape}/${b.view} ${b.medians.map(v => v.toFixed(2)).join('/')}`).join(', ')}` : `all ${all.length}`}; ${thirds} needed a third measurement`)
  const gpuErr = (await status(page)).gpuErrors
  gate.check(gpuErr === 0, `GPU: ${gpuErr} uncaptured WebGPU errors`)
  gate.check(errors.length === 0, `console: ${errors.length} errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`)

  // ---- the answer
  for (const sc of report.scenes) {
    for (const shape of ['aniso', 'sphere']) {
      const at = sc[shape], f = v => (v == null ? 'not reached' : `${v.toFixed(2)} ms`)
      console.log(`[recorded] ${sc.cells.join('×')} (${sc.particles} particles, ${(100 * sc.depthM).toFixed(1)} cm pool) ${shape}: ` +
        TARGETS.map(c => { const k = `${Math.round(100 * c)}%`; return `${k} → median ${f(at[k].medianMs)} / p95 ${f(at[k].p95Ms)}` }).join('; '))
    }
  }
  console.log(`[reference] dev6 G0-g (old MPM splats, 100k, 1280 × 800): ${DEV6.at7} ms at ≈ 7 %, ${DEV6.at79} ms at 79 %`)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 'opt1-cov', pass, report, gate.results)
process.exit(pass ? 0 : 1)
