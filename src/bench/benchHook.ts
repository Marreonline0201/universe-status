// Shared test hook for fluid pages. Installs window.__fluidBench on any page that owns a fluid
// engine (the standalone bench.html, and FLUID TEST in dev or with ?bench=1), so the same
// driver scripts measure the page the owner actually uses (feedback: test the real input path).
//
// Determinism: every spawn a script triggers runs with Math.random swapped for a seeded
// generator, and setStepLimit(n) freezes the simulation after exactly n stepped frames
// (rendering continues), so a sample is taken at a known frame and two runs are comparable.
import type { ProbeOptions, ProbeResultWithCamera } from '../fluid-render/SSFRPipeline'
import { OPTICAL_MODELS, LUT_LMAX_M, LUT_N, waterAbsorptionPerM, haleQuerryAbsorptionPerM, waterScatteringPerM, scatterRowRgb,
  deepRrsRgb, lutRowIndex, opticsRecordFor, type OpticalModel } from '../fluid-render/optics/materials'
import { zhangPureWater, KB, KELVIN, ZHANG_SHIPPED } from '../fluid-render/optics/waterScattering'
import { QAA_V5, qaaRrs } from '../fluid-render/optics/qaa'

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
  /** APIC affine matrix C per particle (9 floats, row-major), when the engine provides it. */
  affine?: Float32Array
  /** Immiscible drift per particle (slip xyz m/s, drop diameter m), when the drift is active. */
  drift?: Float32Array
  /** The slip's inputs per particle, 8 floats: a = g − Du/Dt xyz, α_d, ρ_m, μ_m, Re, 0 (zero when not dispersed). */
  slipInputs?: Float32Array
  /** The drift velocity each particle is advected with, u_V = (dispersed ? s : 0) − J (xyz m/s, 4 floats per particle). */
  uV?: Float32Array
  /** With configure({ snapshotDensity: true }): the solver's positions right after the last substep's density
   *  correction, and at the sample (vec4 per particle, metres — the solver's units, not the world units of positions). */
  posDp?: Float32Array
  posRaw?: Float32Array
}

/** Inputs of the optics() readout (OPT-2a spec §3.6). Every field absent = the page's shipped precompute; a set field is a
 *  deliberate deviation (the OPT-2a-c positive controls call the renderer's own functions with wrong inputs). */
export interface OpticsOptions {
  /** wavelength of the scalar R_rs readout, nm (default 450: a tabulated Pope & Fry row, no interpolation) */
  lambdaNm?: number
  /** a(λ): the shipped splice (Pope & Fry 1997, Hale & Querry 1973 outside 380–727.5 nm), Hale & Querry alone, or flat, 1/m */
  absorption?: 'water' | 'hale-querry' | { flatPerM: number }
  /** the pure-water scattering's depolarisation ratio δ and temperature, °C (default: ZHANG_SHIPPED) */
  delta?: number
  tempC?: number
  /** QAA g-set [g0, g1] (default QAA_v5 Table 1) */
  g?: [number, number]
  /** x (metres) at which to sample the scatter row S_rgb(x) (default: 0 … LUT_LMAX_M, the tank's paths among them) */
  scatterX?: number[]
}

/** configure()'s options: clock / physics configuration and bench toggles for tests (FluidEngine.benchTarget applies
 *  them). Every key is optional; a key outside this set throws (BENCH_CONFIGURE_KEYS). */
export interface BenchConfigureOptions {
  clock?: 'realtime' | 'lockstep'; frameDt?: number; gravityMs2?: number; resetClockStats?: boolean; resetDiagnostics?: boolean
  forceSsfrFailure?: boolean; disableImmiscible?: boolean; immExcludeLiquids?: string[]; immDriftForm?: 'face' | 'cell'
  snapshotDensity?: boolean; splatShape?: 'sphere' | 'aniso'
  /** FRICTION bench toggle (review 2026-09-30 INT-5): the floor's wall shear with the page's law, or off — held by the
   *  solver across a tank resize; a solver without the stage (MPM) throws. */
  wallShear?: 'keulegan1938' | false
}
/** Every key configure() takes. The literal is checked against BenchConfigureOptions at compile time (it must name each
 *  key, and only those), so the list and the type cannot drift. configure() throws on any other key before it applies
 *  one (review 2026-09-30 INT-5: a misspelt option must not silently configure nothing; the census of every configure
 *  call in scripts/ and src/ found only these keys). */
export const BENCH_CONFIGURE_KEYS: readonly string[] = Object.keys({
  clock: 1, frameDt: 1, gravityMs2: 1, resetClockStats: 1, resetDiagnostics: 1, forceSsfrFailure: 1, disableImmiscible: 1,
  immExcludeLiquids: 1, immDriftForm: 1, snapshotDensity: 1, splatShape: 1, wallShear: 1,
} satisfies Record<keyof BenchConfigureOptions, 1>)

/** What a page must provide for the hook. Optional members enable the matching hook calls. */
export interface BenchTarget {
  framesStepped(): number
  setStepLimit(frames: number): void
  readParticleSample(): Promise<ParticleSample | null>
  /** Offscreen SSFR frame with a test camera/overrides, read back (render acceptance gates, r0-render.mjs). */
  probe?(opts: ProbeOptions): Promise<ProbeResultWithCamera | null>
  compositions(): { id: number; name: string; rho?: number; mu?: number }[]
  fps(): number
  count(): number
  /** Load a lab scenario (JSON text, company/lab/<exp>/scenario.json format). */
  loadScenario?(json: string): { warning: string | null }
  /** Page-level user actions (e.g. 'reset', 'batch10k', 'dropBall', 'removeBall'). */
  action?(name: string): void | Promise<unknown>
  /** Clock/physics configuration for tests (lockstep clock, frame interval, gravity in m/s², bench toggles). */
  configure?(opts: BenchConfigureOptions): void
  /** GPU diagnostics counters (e.g. wall safety-clamp hits) + the particle-substeps denominator. */
  diagnostics?(): Promise<Record<string, unknown>>
  /** Extra status fields (sim time, real-time factor, …) merged into status(). */
  extraStatus?(): Record<string, unknown>
  /** The incompressible viscous solve's μ over full cells at its last run (s36-page; null on a solver without it). */
  viscosity?(): Promise<unknown>
  /** Tank resize (TANK-RESIZE spec): grid cells per axis, shift in metres. */
  resizeTank?(cells: [number, number, number], shiftM?: [number, number, number]): Promise<unknown>
  /** Screen position (client px) of a tank drag handle: kind and its sides [[axis, ±1], …] (tests drive the real pointer). */
  tankHandle?(kind: 'face' | 'edge' | 'corner', sides: [number, number][]): { x: number; y: number } | null
  /** The camera as raw matrices (column-major) and the view's client rect: a test builds pointer rays with its own code. */
  view?(): { matrixWorld: number[]; projectionMatrixInverse: number[]; rect: { left: number; top: number; width: number; height: number } } | null
  /** GPU time of whole offscreen SSFR frames with a test camera (timestamp-bracketed) and the liquid's pixel fraction
   *  (OPT-1-cov coverage sweep). */
  renderTiming?(opts: ProbeOptions & { frames?: number; warmup?: number }): Promise<unknown>
  /** PERF-1 baseline: profile the next frame's simulation step (per-pass GPU µs, dispatch counts, encode ms). */
  profileStep?(): Promise<unknown>
}

export function installBenchHook(target: BenchTarget, meta: { page: string }) {
  let rafFrames = 0
  let rafId = 0
  const countFrames = () => { rafFrames++; rafId = requestAnimationFrame(countFrames) }
  rafId = requestAnimationFrame(countFrames)

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

    configure(opts: BenchConfigureOptions) {
      if (!target.configure) throw new Error(`${meta.page} cannot be configured`)
      // an unknown key throws before any key is applied (nothing half-configured)
      const unknown = Object.keys(opts ?? {}).filter(k => !BENCH_CONFIGURE_KEYS.includes(k))
      if (unknown.length) throw new Error(`configure: unknown option ${unknown.join(', ')} (known: ${BENCH_CONFIGURE_KEYS.join(', ')})`)
      target.configure(opts)
    },

    tankHandle(kind: 'face' | 'edge' | 'corner', sides: [number, number][]) {
      if (!target.tankHandle) throw new Error(`${meta.page} has no tank handles`)
      return target.tankHandle(kind, sides)
    },

    view() {
      if (!target.view) throw new Error(`${meta.page} has no 3D view`)
      return target.view()
    },

    resizeTank(cells: [number, number, number], shiftM?: [number, number, number]) {
      if (!target.resizeTank) throw new Error(`${meta.page} cannot resize the tank`)
      return target.resizeTank(cells, shiftM)
    },

    diagnostics() {
      if (!target.diagnostics) throw new Error(`${meta.page} has no diagnostics`)
      return target.diagnostics()
    },

    viscosity() {
      if (!target.viscosity) throw new Error(`${meta.page} has no viscosity probe`)
      return target.viscosity()
    },

    /** GPU time of whole offscreen SSFR frames + the liquid's pixel fraction (OPT-1-cov). */
    renderTiming(opts: ProbeOptions & { frames?: number; warmup?: number }) {
      if (!target.renderTiming) throw new Error(`${meta.page} has no render timing`)
      return target.renderTiming(opts)
    },

    profileStep() {
      if (!target.profileStep) throw new Error(`${meta.page} has no step profiler`)
      return target.profileStep()
    },

    /** Offscreen render probe; every requested target comes back base64-encoded (see SSFRPipeline ProbeResult). */
    async probe(opts: ProbeOptions) {
      if (!target.probe) throw new Error(`${meta.page} has no render probe`)
      const r = await target.probe(opts)
      if (!r) return null
      const data: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.data)) if (v) data[k] = toBase64(new Uint8Array(v))
      return { ...r, data }
    },

    /** OPT-2a (spec §3.6): the renderer's OWN optics precompute — optics/materials.ts, waterScattering.ts and qaa.ts, the
     *  modules the pipeline ships — for the OPT-2a-c CPU half and the render gates' material overrides (a gate cannot
     *  import materials.ts in Node: it loads its data with Vite ?raw). With no options every value is the page's: rrsRgb
     *  is the water record's cached R_rs, the one written to the GPU. Options are deliberate deviations (controls). */
    optics(opts: OpticsOptions = {}) {
      const lambdaNm = opts.lambdaNm ?? 450
      const tempC = opts.tempC ?? ZHANG_SHIPPED.tempC, delta = opts.delta ?? ZHANG_SHIPPED.delta
      const ab = opts.absorption ?? 'water'
      const absorptionPerM = ab === 'water' ? waterAbsorptionPerM : ab === 'hale-querry' ? haleQuerryAbsorptionPerM : ((flat: number) => () => flat)(ab.flatPerM)
      const shippedScatter = opts.tempC === undefined && opts.delta === undefined
      const scatteringPerM = shippedScatter ? waterScatteringPerM : (l: number) => zhangPureWater(l, tempC, delta).bPerM
      const coeffs = opts.g ? { ...QAA_V5, g0: opts.g[0], g1: opts.g[1] } : QAA_V5
      const shipped = ab === 'water' && shippedScatter && !opts.g
      const model: OpticalModel = shipped ? OPTICAL_MODELS.water
        : { ...OPTICAL_MODELS.water, absorptionPerM, scatteringPerM, backscatterPerM: (l: number) => scatteringPerM(l) / 2 }
      const a = model.absorptionPerM!(lambdaNm), b = model.scatteringPerM!(lambdaNm), bb = model.backscatterPerM!(lambdaNm)
      const xs = opts.scatterX ?? [0, 1e-3, 0.35, 1.0, 3.63, 13.92, 25, LUT_LMAX_M]
      return {
        shipped, lambdaNm, a, b, bb, u: bb / (a + bb),
        rrs: qaaRrs(a, bb, coeffs),
        rrsRgb: shipped ? opticsRecordFor('water', NaN).rrs : deepRrsRgb(model, coeffs),
        scatterRow: { x: xs, rgb: xs.map(x => scatterRowRgb(model, x)) },
        scatterRowIndex: lutRowIndex('water', 'scatter'),
        bRgb: scatterRowRgb(model, 0),
        lut: { n: LUT_N, lmaxM: LUT_LMAX_M },
        constants: { g0: coeffs.g0, g1: coeffs.g1, t: coeffs.t, gamma: coeffs.gamma, delta, tempC, salinity: ZHANG_SHIPPED.salinity, kB: KB, kelvinOffset: KELVIN },
      }
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
    async sample(opts: { affine?: boolean } = {}) {
      const frame = target.framesStepped()
      const s = await target.readParticleSample()
      if (!s) return null
      return {
        frame,
        n: s.compIds.length,
        pos: toBase64(s.positions),
        vel: toBase64(s.velocities),
        comp: toBase64(s.compIds),
        ...(opts.affine && s.affine ? { aff: toBase64(s.affine) } : {}),
        ...(s.drift ? { drift: toBase64(s.drift) } : {}),
        ...(s.slipInputs ? { slipIn: toBase64(s.slipInputs) } : {}),
        ...(s.uV ? { uV: toBase64(s.uV) } : {}),
        ...(s.posDp ? { posDp: toBase64(s.posDp) } : {}),
        ...(s.posRaw ? { posRaw: toBase64(s.posRaw) } : {}),
        materials: target.compositions(),
      }
    },
  }
  const w = window as unknown as { __fluidBench?: typeof hook }
  w.__fluidBench = hook
  return {
    hook,
    /** Stop the frame counter and drop window.__fluidBench (if it is still this hook), so a
     *  remounted page never leaks the old engine or stacks rAF loops. */
    uninstall() {
      cancelAnimationFrame(rafId)
      if (w.__fluidBench === hook) delete w.__fluidBench
    },
  }
}

/** FLUID TEST installs the hook only when a script asks for it (?bench=1) — the owner's
 *  everyday page never carries it, in dev or production. */
export function benchHookEnabled(): boolean {
  return new URLSearchParams(window.location.search).has('bench')
}
