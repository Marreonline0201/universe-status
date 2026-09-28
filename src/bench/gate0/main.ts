/// <reference types="@webgpu/types" />
// gpu-bench.html entry — FINAL-PLAN §7 S0.5 Gate 0 microbenchmarks.
// Driven by scripts/gpu-bench.mjs (headed Chrome, NVIDIA adapter asserted), usable by hand:
//   await __gate0.info()
//   await __gate0.run('g0a', { grids: [64, 48, 4], Ks: [10, 100, 1000] })
//   await __gate0.run('g0b', { n: 64 })            // needs bench/offline/poisson_ref.py fixtures
//   await __gate0.run('g0s', { n: 64, capP: 17, capPsi: 13, ... })   // substep-chain throughput
//   await __gate0.run('g0f', { particles: 100000 })
//   await __gate0.run('g0g', { particles: 100000, width: 2560, height: 1600, view: 'engine' })
// Test modules are imported DYNAMICALLY, all at page start: the MPM / SSFR / three.js graph is then
// loaded once, and the driver additionally stubs Vite's HMR client so that edits made to those
// files while a run is in progress cannot reload the page mid-run (the code measured is the code
// hashed at page load; the driver re-hashes at the end and flags any change).
import { createGate0Device, type Gate0Device } from './gpu'

const log = document.getElementById('log') as HTMLPreElement
const say = (s: string) => { log.textContent += s + '\n'; console.log('[gate0]', s) }

interface Gate0Api {
  ready: boolean
  error: string | null
  info: () => unknown
  run: (test: string, params?: Record<string, unknown>) => Promise<unknown>
}

declare global { interface Window { __gate0: Gate0Api } }

const api: Gate0Api = {
  ready: false,
  error: null,
  info: () => null,
  run: async () => { throw new Error('not ready') },
}
window.__gate0 = api

try {
  const [dev, g0a, g0b, g0s, g0fg] = await Promise.all([
    createGate0Device(), import('./g0a'), import('./g0b'), import('./g0s'), import('./g0fg'),
  ])
  const d: Gate0Device = dev
  api.info = () => ({ ...d.report, lost: d.lost, visibility: document.visibilityState })
  api.run = async (test, params = {}) => {
    if (d.lost) throw new Error(`device lost: ${d.lost}`)
    if (document.visibilityState !== 'visible') throw new Error(`page not visible (${document.visibilityState}): timings would be throttled`)
    const t0 = performance.now()
    say(`run ${test} ${JSON.stringify(params)}`)
    let out: unknown
    if (test === 'g0a') out = await g0a.runG0a(d, params)
    else if (test === 'g0b') out = await g0b.runG0b(d, params)
    else if (test === 'g0s') out = await g0s.runG0s(d, params as unknown as Parameters<typeof g0s.runG0s>[1])
    else if (test === 'g0f') out = await g0fg.runG0f(d, params)
    else if (test === 'g0g') out = await g0fg.runG0g(d, params)
    else if (test === 'cleanup') { g0fg.destroySims(); out = { ok: true } }
    else throw new Error(`unknown test ${test}`)
    if (d.lost) throw new Error(`device lost during ${test}: ${d.lost}`)
    say(`done ${test} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    return { ...(out as object), wallSeconds: (performance.now() - t0) / 1000, visibilityAtEnd: document.visibilityState }
  }
  api.ready = true
  say(`adapter: ${d.report.vendor} / ${d.report.architecture} / ${d.report.description} | timestamp-query: ${d.report.timestampQuery}`)
} catch (e) {
  api.error = String(e)
  say(`INIT FAILED: ${api.error}`)
}
