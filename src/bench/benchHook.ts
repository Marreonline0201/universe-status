// Shared test hook for fluid pages. Installs window.__fluidBench on any page that owns a fluid
// engine (the standalone bench.html, and FLUID TEST in dev or with ?bench=1), so the same
// driver scripts measure the page the owner actually uses (feedback: test the real input path).
//
// Determinism: every spawn a script triggers runs with Math.random swapped for a seeded
// generator, and setStepLimit(n) freezes the simulation after exactly n stepped frames
// (rendering continues), so a sample is taken at a known frame and two runs are comparable.

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Run fn with Math.random replaced by a seeded generator, restoring it afterwards. */
export function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random
  Math.random = mulberry32(seed)
  try {
    return fn()
  } finally {
    Math.random = original
  }
}

export function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export interface ParticleSample {
  positions: Float32Array
  velocities: Float32Array
  compIds: Uint32Array
}

/** What a page must provide for the hook. Optional members enable the matching hook calls. */
export interface BenchTarget {
  framesStepped(): number
  setStepLimit(frames: number): void
  readParticleSample(): Promise<ParticleSample | null>
  compositions(): { id: number; name: string }[]
  fps(): number
  count(): number
  /** Load a lab scenario (JSON text, company/lab/<exp>/scenario.json format). */
  loadScenario?(json: string): { warning: string | null }
  /** Page-level user actions (e.g. 'reset', 'batch10k', 'dropBall', 'removeBall'). */
  action?(name: string): void | Promise<unknown>
  /** Clock/physics configuration for tests (lockstep clock, frame interval, gravity in m/s²). */
  configure?(opts: { clock?: 'realtime' | 'lockstep'; frameDt?: number; gravityMs2?: number; resetClockStats?: boolean }): void
  /** Extra status fields (sim time, real-time factor, …) merged into status(). */
  extraStatus?(): Record<string, unknown>
}

export function installBenchHook(target: BenchTarget, meta: { page: string }) {
  let rafFrames = 0
  const countFrames = () => { rafFrames++; requestAnimationFrame(countFrames) }
  requestAnimationFrame(countFrames)

  const hook = {
    ok: true,
    initError: null as string | null,
    page: meta.page,

    load(json: string, seed = 1) {
      if (!target.loadScenario) throw new Error(`${meta.page} cannot load scenarios`)
      return withSeededRandom(seed, () => target.loadScenario!(json))
    },

    action(name: string, seed = 1) {
      if (!target.action) throw new Error(`${meta.page} has no scripted actions`)
      // Returned promise (async spawns) is awaited by page.evaluate; the seeded RNG is captured
      // synchronously by the engine, so it stays in effect across the action's awaits.
      return withSeededRandom(seed, () => target.action!(name))
    },

    /** Freeze the sim after this many stepped frames (Infinity = run freely). */
    setStepLimit(frames: number) { target.setStepLimit(frames) },

    configure(opts: Parameters<NonNullable<BenchTarget['configure']>>[0]) {
      if (!target.configure) throw new Error(`${meta.page} cannot be configured`)
      target.configure(opts)
    },

    status() {
      return {
        page: meta.page,
        fps: target.fps(),
        count: target.count(),
        rafFrames,
        framesStepped: target.framesStepped(),
        visibility: document.visibilityState,
        ...(target.extraStatus?.() ?? {}),
      }
    },

    /** Full particle readback, base64-encoded (Float32 pos/vel xyz, Uint32 composition id). */
    async sample() {
      const frame = target.framesStepped()
      const s = await target.readParticleSample()
      if (!s) return null
      return {
        frame,
        n: s.compIds.length,
        pos: toBase64(s.positions),
        vel: toBase64(s.velocities),
        comp: toBase64(s.compIds),
        materials: target.compositions(),
      }
    },
  }
  ;(window as unknown as { __fluidBench: typeof hook }).__fluidBench = hook
  return hook
}

/** FLUID TEST installs the hook in dev builds, or in any build with ?bench=1. */
export function benchHookEnabled(): boolean {
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has('bench')
}
