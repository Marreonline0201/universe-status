// Fluid bench: an office-free harness page for quantitative fluid tests.
// Served by `npm run dev` at /bench.html and driven by scripts/fluid-bench.mjs, which loads a
// scenario, samples the GPU particle state at chosen sim frames, and scores it against
// analytic/experimental references. No UI, no React, no office API. The hook API is shared
// with FLUID TEST (src/bench/benchHook.ts) so both pages are measured the same way.
import { FluidEngine } from '../fluid-engine/FluidEngine'
import { parseScenario } from '../lab/scenario'
import { installBenchHook } from './benchHook'

const container = document.getElementById('bench') as HTMLDivElement
const engine = new FluidEngine(container, () => {})
let initError: string | null = null
const ok = await engine.init().catch(e => { initError = String(e); return false })
if (!ok && !initError) initError = navigator.gpu ? 'engine init failed' : 'WebGPU unavailable'

const { hook } = installBenchHook(engine.benchTarget({
  loadScenario: (json: string) => {
    const parsed = parseScenario(json, { packing: engine.tankPacking ?? undefined })   // the live tank's walls, as FLUID TEST does (it used MPM's)
    if (!parsed.ok) throw new Error(parsed.error)
    const r = engine.loadScenario(parsed.scenario)
    if (!r.ok) throw new Error(`scenario refused: ${r.reason}`)
    return { warning: [parsed.warning, ...r.warnings].filter(Boolean).join('; ') || null }
  },
  action: (name: string) => {
    if (name === 'dropBall') return engine.dropBall()
    if (name === 'removeBall') return engine.removeBall()
    if (name === 'reset') return engine.reset()
    if (name === 'defaultScene') return engine.loadDefaultScene()
    if (name === 'batch10k') return engine.spawnBatch(10000)
    throw new Error(`unknown action ${name}`)
  },
}), { page: 'bench' })
hook.ok = ok
hook.initError = initError
