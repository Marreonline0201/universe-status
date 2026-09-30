/// <reference types="@webgpu/types" />
import type { BudgetState } from '../gpu-sim/flip/dispatchBudget'
// PERF-1's baseline (vault fluid/realism-2026-09/EXTENDED-ROADMAP.md §5.34; S3N-23 "a per-kernel dispatch budget"):
// profile ONE frame's simulation step on the real page. The command encoder handed to the simulator is wrapped — as
// bench/flipSelftest/perf.ts profileStep does for the self-test scene — so that every compute pass carries begin/end
// timestamp writes and every dispatch, buffer copy and queue upload is counted per pass label; the CPU time spent
// encoding is timed too. Nothing else changes: the same kernels, dispatches and buffers run — but the CPU encode of the
// profiled frame runs through the Proxy (about 10^4 trapped calls in B1), so it is an upper bound; the page's own encode
// time is measured on the plain frames around it (encodeMsPlain; review 2026-09-29). Timestamps need the
// device's 'timestamp-query' feature (three.js's WebGPU backend requests every feature the adapter has); with
// --enable-webgpu-developer-features they are unquantized.

export interface StepProfile {
  /** substeps in the profiled frame */
  substeps: number
  /** compute passes, dispatches (direct + indirect), indirect dispatches, encoder copies/clears, queue.writeBuffer calls */
  passes: number
  dispatches: number
  indirect: number
  copies: number
  uploads: number
  /** CPU ms inside the simulator's encode in the PROFILED frame — through the Proxy, so an upper bound */
  encodeMs: number
  /** the page's own encode: the median CPU ms of the recent plain (unprofiled) frames with the same substep count, and
   *  how many there were (NaN / 0 when none) */
  encodeMsPlain: number
  encodeMsPlainFrames: number
  /** Σ of the passes' GPU durations, and the first pass's start → the last pass's end (µs) */
  gpuSumUs: number
  gpuSpanUs: number
  /** per pass label, by GPU time: µs, pass count, dispatch count */
  byLabel: { pass: string; us: number; passes: number; dispatches: number }[]
  /** passes beyond the query set's capacity (untimed, still counted) */
  untimedPasses: number
  /** PERF-1 L0: the frame's dispatches per label against dispatchBudget.frameDispatches(state) — `mismatches` empty and
   *  no untimed pass (those carry no label) is the per-frame count gate (perf-profile.mjs); set by the page's backend */
  budget?: { total: number; mismatches: { label: string; counted: number; budget: number }[]; state: BudgetState }
}

type AnyFn = (...a: unknown[]) => unknown

export class StepProfiler {
  /** passes timed per frame (2 queries each; a WebGPU query set holds at most 4096) */
  static readonly MAX = 2048
  private readonly qs: GPUQuerySet
  private readonly resolveBuf: GPUBuffer
  private readonly readBuf: GPUBuffer
  private labels: string[] = []
  private disp: number[] = []
  private untimedDisp = 0
  private untimed = 0
  private indirect = 0
  private copies = 0
  private uploads = 0
  private readonly device: GPUDevice

  constructor(device: GPUDevice) {
    if (!device.features.has('timestamp-query')) throw new Error('StepProfiler: the device has no timestamp-query feature')
    this.device = device
    this.qs = device.createQuerySet({ type: 'timestamp', count: 2 * StepProfiler.MAX })
    this.resolveBuf = device.createBuffer({ size: 16 * StepProfiler.MAX, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    this.readBuf = device.createBuffer({ size: 16 * StepProfiler.MAX, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  }

  /** Runs `encode` with a wrapped encoder (and the queue's writeBuffer counted); returns the CPU ms it took. */
  record(encoder: GPUCommandEncoder, encode: (e: GPUCommandEncoder) => void): number {
    const q = this.device.queue, write = q.writeBuffer
    q.writeBuffer = ((...a: Parameters<GPUQueue['writeBuffer']>) => { this.uploads++; return write.apply(q, a) }) as GPUQueue['writeBuffer']
    const t0 = performance.now()
    try { encode(this.wrap(encoder)) } finally { q.writeBuffer = write }
    return performance.now() - t0
  }

  private wrap(e: GPUCommandEncoder): GPUCommandEncoder {
    const self = this
    const counted = new Set(['copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer'])
    return new Proxy(e, {
      get(t, p) {
        if (p === 'beginComputePass') return (d: GPUComputePassDescriptor = {}) => {
          const i = self.labels.length
          if (i >= StepProfiler.MAX || d.timestampWrites) { self.untimed++; return self.countPass(t.beginComputePass(d), -1) }
          self.labels.push(d.label ?? '?'); self.disp.push(0)
          return self.countPass(t.beginComputePass({ ...d, timestampWrites: { querySet: self.qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } }), i)
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[p]
        if (typeof v !== 'function') return v
        if (typeof p === 'string' && counted.has(p)) return (...a: unknown[]) => { self.copies++; return (v as AnyFn).apply(t, a) }
        return (v as AnyFn).bind(t)
      },
    })
  }

  private countPass(pass: GPUComputePassEncoder, i: number): GPUComputePassEncoder {
    const self = this
    return new Proxy(pass, {
      get(t, p) {
        const v = (t as unknown as Record<string | symbol, unknown>)[p]
        if (typeof v !== 'function') return v
        if (p === 'dispatchWorkgroups' || p === 'dispatchWorkgroupsIndirect') return (...a: unknown[]) => {
          if (p === 'dispatchWorkgroupsIndirect') self.indirect++
          if (i >= 0) self.disp[i]++; else self.untimedDisp++
          return (v as AnyFn).apply(t, a)
        }
        return (v as AnyFn).bind(t)
      },
    })
  }

  /** After the frame's submit: resolves the timestamps and reads them back (queue order puts this after the frame). */
  async finish(substeps: number, encodeMs: number, plain: { ms: number; n: number }[] = []): Promise<StepProfile> {
    const same = plain.filter(f => f.n === substeps).map(f => f.ms).sort((a, b) => a - b)
    const encodeMsPlain = same.length ? same[Math.floor(same.length / 2)] : NaN
    const n = this.labels.length
    try {
      if (n > 0) {
        const e = this.device.createCommandEncoder()
        e.resolveQuerySet(this.qs, 0, 2 * n, this.resolveBuf, 0)
        e.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, 16 * n)
        this.device.queue.submit([e.finish()])
        await this.readBuf.mapAsync(GPUMapMode.READ, 0, 16 * n)
      }
      const t = n > 0 ? new BigUint64Array(this.readBuf.getMappedRange(0, 16 * n).slice(0)) : new BigUint64Array(0)
      if (n > 0) this.readBuf.unmap()
      const by = new Map<string, { us: number; passes: number; dispatches: number }>()
      let sum = 0
      for (let i = 0; i < n; i++) {
        const us = Number(t[2 * i + 1] - t[2 * i]) / 1000
        const r = by.get(this.labels[i]) ?? { us: 0, passes: 0, dispatches: 0 }
        r.us += us; r.passes++; r.dispatches += this.disp[i]; sum += us
        by.set(this.labels[i], r)
      }
      const dispatches = this.disp.reduce((q, v) => q + v, 0) + this.untimedDisp
      return {
        substeps, passes: n + this.untimed, dispatches, indirect: this.indirect, copies: this.copies, uploads: this.uploads, encodeMs, encodeMsPlain, encodeMsPlainFrames: same.length,
        gpuSumUs: sum, gpuSpanUs: n > 0 ? Number(t[2 * n - 1] - t[0]) / 1000 : 0,
        byLabel: [...by.entries()].map(([pass, r]) => ({ pass, ...r })).sort((a, b) => b.us - a.us),
        untimedPasses: this.untimed,
      }
    } finally {
      this.qs.destroy(); this.resolveBuf.destroy(); this.readBuf.destroy()
    }
  }
}
