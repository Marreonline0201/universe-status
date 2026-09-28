/// <reference types="@webgpu/types" />
// G0-f — per-substep GPU time of the CURRENT MLS-MPM (src/gpu-sim/MpmGpuSimulator.ts, imported
//        read-only) at 30k / 100k particles.
// G0-g — SSFR render cost (src/fluid-render/SSFRPipeline.ts, imported read-only) at 1280x800 and
//        2560x1600, 30k / 100k / 250k particles, for two layouts (a settled floor layer, and a
//        dam-break COLUMN right after spawn) and two cameras (FluidEngine's camera, and a top-down
//        camera whose view the water fills: the blur skips background pixels, so the engine view
//        of a thin layer is a LOWER bound of the render cost).
// Neither class can be edited here, so both are bracketed by EMPTY compute passes that only carry
// timestampWrites (begin marker before, end marker after, same command encoder). The interval
// therefore includes any inter-pass gaps; whether it is exactly the enclosed work is [UNVERIFIED].
import { PerspectiveCamera, Vector3 } from 'three'
import { MpmGpuSimulator, type GpuParticle } from '../../gpu-sim/MpmGpuSimulator'
import { SSFRPipeline } from '../../fluid-render/SSFRPipeline'
import { opticsRenderData } from '../../fluid-render/optics/materials'
import { CompositionTable } from '../../composition/CompositionTable'
import { GpuTimer, timingInvalid, mean, median, quantile, type Gate0Device } from './gpu'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** compute passes MpmGpuSimulator.step(enc, k) opens: 5 per substep (clearGrid, p2g, p2g2,
 *  gridForces, g2p), as read on 2026-09-28; contact detection is off by default */
const PASSES_PER_SUBSTEP = 5

export type Layout = 'floor' | 'column'
export interface SimEntry { sim: MpmGpuSimulator; table: CompositionTable; count: number; layout: Layout; framesStepped: number; block: Record<string, number> }
const sims = new Map<string, SimEntry>()

/**
 * Water at the legacy rest packing (REST_DENSITY = 4 particles per cell, p2g2.wgsl), seeded
 * uniform random, inside the 2-cell wall band [3/64, 61/64]:
 *   floor  — full x/z extent, height set by the count (settled by stepping before timing)
 *   column — a dam-break column x in [3/64, 27/64] (24 cells), full z, height set by the count
 *            (capped at the top band), rendered right after spawn
 */
export async function getSim(g: Gate0Device, count: number, settleFrames: number, layout: Layout = 'floor'): Promise<SimEntry> {
  const key = `${count}|${layout}`
  let e = sims.get(key)
  if (e) return e
  const sim = new MpmGpuSimulator()
  if (!(await sim.init(g.device))) throw new Error('MpmGpuSimulator.init failed')
  const table = new CompositionTable()
  table.addDefaults()
  sim.updateCompositionProps(table.getGpuData())
  const lo = 3 / 64, hi = 61 / 64
  const xHi = layout === 'floor' ? hi : 27 / 64
  const cells = count / 4
  const heightCells = cells / (((xHi - lo) * 64) * ((hi - lo) * 64))
  const yTop = Math.min(hi, lo + heightCells / 64)
  const rnd = mulberry32(1)
  const particles: GpuParticle[] = []
  for (let i = 0; i < count; i++) {
    particles.push({
      pos: [lo + rnd() * (xHi - lo), lo + rnd() * (yTop - lo), lo + rnd() * (hi - lo)],
      vel: [0, 0, 0], composition_id: 0, temperature: 20, phase: 1,
    })
  }
  sim.spawnParticles(particles)
  const particlesPerCell = count / (((xHi - lo) * 64) * ((yTop - lo) * 64) * ((hi - lo) * 64))   // 4 unless the height was capped
  e = { sim, table, count, layout, framesStepped: 0, block: { xMin: lo, xMax: xHi, yMin: lo, yMax: yTop, heightCells: (yTop - lo) * 64, particlesPerCell } }
  sims.set(key, e)
  for (let f = 0; f < settleFrames; f++) {
    const enc = g.device.createCommandEncoder()
    sim.step(enc)
    g.device.queue.submit([enc.finish()])
    e.framesStepped++
    if (f % 4 === 3) await g.device.queue.onSubmittedWorkDone()
  }
  await g.device.queue.onSubmittedWorkDone()
  return e
}

/** wraps an encoder to count the compute passes `fn` opens */
export function countPasses(enc: GPUCommandEncoder, fn: (e: GPUCommandEncoder) => void): number {
  let passes = 0
  const counted = new Proxy(enc, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t)
      if (typeof v !== 'function') return v
      if (prop === 'beginComputePass') return (...a: unknown[]) => { passes++; return (v as (...x: unknown[]) => unknown).apply(t, a) }
      return (v as (...x: unknown[]) => unknown).bind(t)
    },
  })
  fn(counted)
  return passes
}

/** MpmGpuSimulator.step(enc, substeps) with the pass-structure assertion */
export function stepChecked(e: SimEntry, enc: GPUCommandEncoder, substeps: number) {
  const passes = countPasses(enc, c => e.sim.step(c, substeps))
  if (passes !== PASSES_PER_SUBSTEP * substeps) throw new Error(`MpmGpuSimulator.step(enc, ${substeps}) opened ${passes} compute passes, expected ${PASSES_PER_SUBSTEP * substeps}: the per-substep structure changed - update g0fg.ts`)
  e.framesStepped++
}

export interface G0fParams { particles?: number; settleFrames?: number; frames?: number; t0Frames?: number }

export async function runG0f(g: Gate0Device, p: G0fParams = {}) {
  const count = p.particles ?? 30000
  const frames = Math.max(120, p.frames ?? 240)
  const t0Frames = p.t0Frames ?? 120
  const settle = p.settleFrames ?? 600
  const device = g.device
  const timer = new GpuTimer(device, frames)
  /** `substeps` per step() call; per-substep time = interval / substeps */
  const measure = async (e: SimEntry, nFrames: number, substeps: number) => {
    const ns: number[] = []
    const wall: number[] = []
    for (let f0 = 0; f0 < nFrames; f0 += timer.capacity) {
      const batch = Math.min(timer.capacity, nFrames - f0)
      for (let f = 0; f < batch; f++) {
        const enc = device.createCommandEncoder()
        timer.mark(enc, timer.begin(f))
        stepChecked(e, enc, substeps)
        timer.mark(enc, timer.end(f))
        if (f === batch - 1) timer.resolve(enc, batch)
        const t = performance.now()
        device.queue.submit([enc.finish()])
        await device.queue.onSubmittedWorkDone()
        wall.push(performance.now() - t)
      }
      ns.push(...(await timer.read(batch)))
    }
    return { ns, wall, substeps }
  }
  // t = 0 window: a fresh spawn (no settling) — the plan's "t = 0" row
  const key = `${count}|floor`
  sims.get(key)?.sim.destroy()
  sims.delete(key)
  const fresh = await getSim(g, count, 0)
  const at0 = await measure(fresh, t0Frames, 1)
  fresh.sim.destroy()
  sims.delete(key)
  // settled window: one substep per call (the S3 transfer proxy) and two per call (legacy app)
  const e = await getSim(g, count, settle)
  const settled1 = await measure(e, frames, 1)
  const settled2 = await measure(e, frames, 2)
  timer.destroy()
  const summarize = (m: { ns: number[]; wall: number[]; substeps: number }) => ({
    frames: m.ns.length, substepsPerCall: m.substeps,
    callMedianMs: median(m.ns) / 1e6, callP95Ms: quantile(m.ns, 0.95) / 1e6,
    perSubstepMedianMs: median(m.ns) / (1e6 * m.substeps), perSubstepMeanMs: mean(m.ns) / (1e6 * m.substeps),
    wallSubmitToDoneMedianMs: median(m.wall),
  })
  return {
    test: 'g0f', particles: count, computePassesPerSubstepChecked: PASSES_PER_SUBSTEP,
    method: 'MpmGpuSimulator.step(enc, k) bracketed by timestamp marker passes; per-substep = interval / k (pass count asserted = 5k)',
    block: e.block, settleFrames: settle, material: e.table.getAll()[0]?.name ?? '?',
    t0: summarize(at0), settled: summarize(settled1), settled2: summarize(settled2),
    invalidTimestamps: timingInvalid([...at0.ns, ...settled1.ns, ...settled2.ns]),
  }
}

export type View = 'engine' | 'top'
/** 'engine': FluidEngine's PerspectiveCamera(50, aspect, 0.1, 50) at (2, 1.5, 2) looking at (0.5, 0.5, 0.5).
 *  'top': same lens straight down from (0.5, 0.9, 0.5) at the tank floor centre: the water covers the frame. */
function cameraMatrices(aspect: number, view: View) {
  const cam = new PerspectiveCamera(50, aspect, 0.1, 50)
  if (view === 'engine') {
    cam.position.set(2.0, 1.5, 2.0)
    cam.lookAt(new Vector3(0.5, 0.5, 0.5))
  } else {
    cam.up.set(0, 0, -1)
    cam.position.set(0.5, 0.9, 0.5)
    cam.lookAt(new Vector3(0.5, 0.0, 0.5))
  }
  cam.updateMatrixWorld()
  cam.updateProjectionMatrix()
  return {
    view: new Float32Array(cam.matrixWorldInverse.elements),
    proj: new Float32Array(cam.projectionMatrix.elements),
    projInv: new Float32Array(cam.projectionMatrixInverse.elements),
    world: new Float32Array(cam.matrixWorld.elements),
  }
}

export interface SsfrRig {
  W: number; H: number; format: GPUTextureFormat
  encode(enc: GPUCommandEncoder, count?: number): void
  /** fraction of pixels that change between `count` particles and one particle (render proof) */
  coverage(): Promise<{ coverage: number; previewPng: string }>
  destroy(): void
}

/** SSFR exactly as FluidEngine.init() configures it, rendering `e`'s particles into an offscreen
 *  texture of the canvas format at W x H. */
export async function createSsfrRig(g: Gate0Device, e: SimEntry, W: number, H: number, view: View): Promise<SsfrRig> {
  const device = g.device
  // (render track 2026-09-28: the config is FluidEngine's; maxRenderPixels = W·H keeps this bench measuring W×H
  //  itself — the page caps at 1280×800-equivalent, ED-2)
  const ssfr = new SSFRPipeline({ particleVolume: 1 / (64 ** 3 * 4), metresPerUnit: 3.63, blurRadius: 10, blurDepthFalloff: 40.0, maxRenderPixels: W * H })
  await ssfr.init(device, W, H)
  ssfr.updateMaterialProps(opticsRenderData(e.table.getAll()))
  const format = navigator.gpu.getPreferredCanvasFormat()
  const target = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC })
  const tview = target.createView()
  const m = cameraMatrices(W / H, view)
  const encode = (enc: GPUCommandEncoder, count = e.count) => ssfr.render(enc, e.sim.particleBuffer, count, m.view, m.proj, m.projInv, m.world, tview)
  const grab = async (n: number) => {
    const enc = device.createCommandEncoder()
    encode(enc, n)
    const buf = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: W * 4 }, [W, H])
    device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const px = new Uint8Array(buf.getMappedRange().slice(0))
    buf.unmap(); buf.destroy()
    return px
  }
  return {
    W, H, format, encode,
    async coverage() {
      const full = await grab(e.count)
      const one = await grab(1)
      let changed = 0
      for (let i = 0; i < W * H; i++) {
        const d = Math.abs(full[4 * i] - one[4 * i]) + Math.abs(full[4 * i + 1] - one[4 * i + 1]) + Math.abs(full[4 * i + 2] - one[4 * i + 2])
        if (d > 6) changed++
      }
      // 640-px-wide preview of the real render (BGRA/RGBA handled) so a human can see it is water
      const pw = 640, ph = Math.round(640 * H / W)
      const full8 = new Uint8ClampedArray(W * H * 4)
      const bgra = format === 'bgra8unorm'
      for (let i = 0; i < W * H; i++) {
        full8[4 * i] = full[4 * i + (bgra ? 2 : 0)]; full8[4 * i + 1] = full[4 * i + 1]
        full8[4 * i + 2] = full[4 * i + (bgra ? 0 : 2)]; full8[4 * i + 3] = 255
      }
      const src = new OffscreenCanvas(W, H)
      src.getContext('2d')!.putImageData(new ImageData(full8, W, H), 0, 0)
      const dst = document.createElement('canvas')
      dst.width = pw; dst.height = ph
      dst.getContext('2d')!.drawImage(src, 0, 0, pw, ph)
      return { coverage: changed / (W * H), previewPng: dst.toDataURL('image/png') }
    },
    destroy() { target.destroy(); ssfr.destroy() },
  }
}

export interface G0gParams { particles?: number; width?: number; height?: number; frames?: number; settleFrames?: number; view?: View; layout?: Layout }

export async function runG0g(g: Gate0Device, p: G0gParams = {}) {
  const count = p.particles ?? 30000
  const W = p.width ?? 1280
  const H = p.height ?? 800
  const view: View = p.view ?? 'engine'
  const layout: Layout = p.layout ?? 'floor'
  const frames = Math.max(120, p.frames ?? 180)
  const device = g.device
  // floor: settled layer; column: rendered right after spawn (the dam-break t = 0 frame)
  const e = await getSim(g, count, layout === 'floor' ? (p.settleFrames ?? 600) : 0, layout)
  const rig = await createSsfrRig(g, e, W, H, view)
  const timer = new GpuTimer(device, frames)
  device.pushErrorScope('validation')
  for (let f = 0; f < 10; f++) {
    const enc = device.createCommandEncoder()
    rig.encode(enc)
    device.queue.submit([enc.finish()])
  }
  await device.queue.onSubmittedWorkDone()
  const wall: number[] = []
  for (let f = 0; f < frames; f++) {
    const enc = device.createCommandEncoder()
    timer.mark(enc, timer.begin(f))
    rig.encode(enc)
    timer.mark(enc, timer.end(f))
    if (f === frames - 1) timer.resolve(enc, frames)
    const t = performance.now()
    device.queue.submit([enc.finish()])
    await device.queue.onSubmittedWorkDone()
    wall.push(performance.now() - t)
  }
  const ns = await timer.read(frames)
  const err = await device.popErrorScope()
  timer.destroy()
  if (err) {
    rig.destroy()
    throw new Error(`G0-g: SSFR validation error (timings invalid): ${err.message.split(/\r?\n/)[0]}`)
  }
  const { coverage, previewPng } = await rig.coverage()
  rig.destroy()
  if (layout === 'column') { e.sim.destroy(); sims.delete(`${count}|column`) }   // a t = 0 state: respawned per use
  if (coverage < 0.01) throw new Error(`G0-g: render proof failed, fluid changes only ${(coverage * 100).toFixed(2)}% of pixels`)
  return {
    test: 'g0g', fluidPixelFraction: coverage, previewPng, particles: count, width: W, height: H, view, layout, format: rig.format, frames,
    block: e.block,
    method: 'SSFRPipeline.render() into an offscreen texture of the canvas format, bracketed by timestamp marker passes; the sim is NOT stepped during timing',
    gpuMedianMs: median(ns) / 1e6, gpuMeanMs: mean(ns) / 1e6, gpuP95Ms: quantile(ns, 0.95) / 1e6,
    wallSubmitToDoneMedianMs: median(wall), validationError: null, invalidTimestamps: timingInvalid(ns),
  }
}

export function destroySims() {
  for (const e of sims.values()) e.sim.destroy()
  sims.clear()
}
