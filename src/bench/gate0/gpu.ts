/// <reference types="@webgpu/types" />
// Gate 0 device + GPU timer. The page creates ITS OWN device (not three.js's) so the requested
// features/limits are known exactly: 'timestamp-query' when the adapter has it, and the storage /
// workgroup-memory limits raised to what the adapter reports (FINAL-PLAN §5.9).

export interface AdapterReport {
  vendor: string
  architecture: string
  device: string
  description: string
  isFallbackAdapter: boolean | null
  features: string[]
  deviceFeatures: string[]
  timestampQuery: boolean
  limits: Record<string, number>
  userAgent: string
  battery: { charging: boolean; level: number } | null
  devicePixelRatio: number
  screen: { width: number; height: number }
}

export interface Gate0Device {
  adapter: GPUAdapter
  device: GPUDevice
  report: AdapterReport
  lost: string | null
}

export async function createGate0Device(): Promise<Gate0Device> {
  if (!navigator.gpu) throw new Error('navigator.gpu unavailable (WebGPU disabled?)')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('requestAdapter returned null')
  const hasTs = adapter.features.has('timestamp-query')
  // Every feature the adapter offers, as three.js's WebGPUBackend requests them (WebGPUBackend.js
  // ~193-208). The production device therefore has e.g. 'float32-filterable', which SSFRPipeline's
  // r32float sampling relies on; G0-f/G0-g must run on an equivalent device.
  const requiredFeatures = [...adapter.features] as GPUFeatureName[]
  const al = adapter.limits
  const requiredLimits: Record<string, number> = {
    maxStorageBuffersPerShaderStage: al.maxStorageBuffersPerShaderStage,
    maxComputeWorkgroupStorageSize: al.maxComputeWorkgroupStorageSize,
    maxStorageBufferBindingSize: al.maxStorageBufferBindingSize,
    maxBufferSize: al.maxBufferSize,
  }
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits, label: 'gate0' })
  const g: Gate0Device = { adapter, device, lost: null, report: null as unknown as AdapterReport }
  device.lost.then(info => { g.lost = `${info.reason}: ${info.message}` })
  device.addEventListener('uncapturederror', ev => console.error('[gate0 GPU error]', (ev as GPUUncapturedErrorEvent).error.message))
  const info = adapter.info
  let battery: AdapterReport['battery'] = null
  try {
    const b = await (navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; level: number }> }).getBattery?.()
    if (b) battery = { charging: b.charging, level: b.level }
  } catch { /* not available */ }
  const limits: Record<string, number> = {}
  for (const k of ['maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize', 'maxStorageBufferBindingSize',
    'maxBufferSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'minUniformBufferOffsetAlignment'] as const) {
    limits[k] = device.limits[k]
  }
  g.report = {
    vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    isFallbackAdapter: (info as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? null,
    features: [...adapter.features].sort(), deviceFeatures: [...device.features].sort(), timestampQuery: hasTs,
    limits, userAgent: navigator.userAgent, battery, devicePixelRatio: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
  }
  return g
}

/**
 * Timestamp pairs from pass `timestampWrites` (the only portable way in WebGPU). Pair i uses query
 * indices 2i (begin) and 2i+1 (end). Values are nanoseconds. Chrome quantizes to 100 µs unless it
 * runs with --enable-webgpu-developer-features; `quantized` detects that.
 */
export class GpuTimer {
  readonly querySet: GPUQuerySet
  private resolveBuf: GPUBuffer
  readonly capacity: number
  private device: GPUDevice

  constructor(device: GPUDevice, pairs: number) {
    if (!device.features.has('timestamp-query')) throw new Error('timestamp-query not enabled on this device')
    this.device = device
    this.capacity = pairs
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 * pairs })
    this.resolveBuf = device.createBuffer({ size: 16 * pairs, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
  }

  /** begin+end on one pass */
  whole(i: number): GPUComputePassTimestampWrites {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 }
  }
  begin(i: number): GPUComputePassTimestampWrites { return { querySet: this.querySet, beginningOfPassWriteIndex: 2 * i } }
  end(i: number): GPUComputePassTimestampWrites { return { querySet: this.querySet, endOfPassWriteIndex: 2 * i + 1 } }

  /** Empty compute pass that only writes a timestamp (brackets code we cannot edit). */
  mark(encoder: GPUCommandEncoder, tw: GPUComputePassTimestampWrites) {
    encoder.beginComputePass({ label: 'ts-marker', timestampWrites: tw }).end()
  }

  resolve(encoder: GPUCommandEncoder, pairs: number) {
    encoder.resolveQuerySet(this.querySet, 0, 2 * pairs, this.resolveBuf, 0)
  }

  /** Durations (ns) of pairs 0..pairs-1; resolve() must have been encoded in a submitted buffer. */
  async read(pairs: number): Promise<number[]> {
    const staging = this.device.createBuffer({ size: 16 * pairs, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const enc = this.device.createCommandEncoder()
    enc.copyBufferToBuffer(this.resolveBuf, 0, staging, 0, 16 * pairs)
    this.device.queue.submit([enc.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const t = new BigUint64Array(staging.getMappedRange().slice(0))
    staging.unmap()
    staging.destroy()
    const out: number[] = []
    for (let i = 0; i < pairs; i++) out.push(Number(t[2 * i + 1] - t[2 * i]))
    return out
  }

  destroy() { this.querySet.destroy(); this.resolveBuf.destroy() }
}

// ── small stats helpers ────────────────────────────────────────────────────────────────────
export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
export const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] }
export const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length

/** least squares y = a + b x */
export function linfit(xs: number[], ys: number[]): { intercept: number; slope: number; r2: number } {
  const n = xs.length, mx = mean(xs), my = mean(ys)
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2 }
  const slope = sxy / sxx
  return { intercept: my - slope * mx, slope, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1 }
}

/**
 * Durations (ns) of intervals that ENCLOSE WORK are invalid when
 *   - every nonzero value is a multiple of 100 µs (Chrome's quantization without
 *     --enable-webgpu-developer-features), or
 *   - any value is zero or negative (a disabled/unsupported timestamp, or a quantized clock
 *     rounding real work down to 0).
 * Returns a reason string, or null when the timings are usable.
 */
export function timingInvalid(ns: number[]): string | null {
  if (ns.length === 0) return 'no timestamps'
  const bad = ns.filter(v => !(v > 0)).length
  if (bad > 0) return `${bad}/${ns.length} durations are zero or negative`
  if (ns.length >= 3 && ns.every(v => v % 100_000 === 0)) return 'all durations are multiples of 100 µs (quantized)'
  return null
}

export async function gpuIdle(device: GPUDevice) { await device.queue.onSubmittedWorkDone() }
