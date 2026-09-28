// Fluid bench: an office-free harness page for quantitative fluid tests.
// Served by `npm run dev` at /bench.html and driven by scripts/fluid-bench.mjs, which
// loads a scenario, samples the GPU particle state at chosen sim frames, and scores it
// against analytic/experimental references. No UI, no React, no office API.
//
// Spawning goes through LabFluidEngine.loadScenario exactly as the LABORATORY page does;
// the only difference is that Math.random is swapped for a seeded generator during the
// load, so two runs (e.g. before/after a physics change) start from identical particles.
import { LabFluidEngine } from '../lab/LabFluidEngine'
import { parseScenario } from '../lab/scenario'

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

const container = document.getElementById('bench') as HTMLDivElement
let fps = 0
let count = 0
let rafFrames = 0
const countFrames = () => { rafFrames++; requestAnimationFrame(countFrames) }
requestAnimationFrame(countFrames)

const engine = new LabFluidEngine(container, s => { fps = s.fps; count = s.count })
let initError: string | null = null
const ok = await engine.init().catch(e => { initError = String(e); return false })
if (!ok && !initError) initError = navigator.gpu ? 'engine init failed' : 'WebGPU unavailable'

;(window as unknown as { __fluidBench: unknown }).__fluidBench = {
  ok,
  initError,

  /** Load a scenario (JSON text, same format as company/lab/<exp>/scenario.json). */
  load(json: string, seed = 1) {
    const parsed = parseScenario(json)
    if (!parsed.ok) throw new Error(parsed.error)
    const original = Math.random
    Math.random = mulberry32(seed)
    try {
      engine.loadScenario(parsed.scenario)
    } finally {
      Math.random = original
    }
    return { warning: parsed.warning }
  },

  status() {
    return {
      fps, count, rafFrames,
      framesStepped: engine.framesStepped,
      visibility: document.visibilityState,
    }
  },

  /** Full particle readback, base64-encoded (Float32 pos/vel xyz, Uint32 composition id). */
  async sample() {
    const frame = engine.framesStepped
    const s = await engine.readParticleSample()
    if (!s) return null
    return {
      frame,
      n: s.compIds.length,
      pos: toBase64(s.positions),
      vel: toBase64(s.velocities),
      comp: toBase64(s.compIds),
      materials: engine.getCompositions().map(c => ({ id: c.id, name: c.name })),
    }
  },
}
