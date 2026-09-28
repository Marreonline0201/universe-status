/// <reference types="@webgpu/types" />
// G0-a — the per-dispatch floor f in Chrome (FINAL-PLAN §7 S0.5, §5.1).
// K in {10, 100, 1000} DEPENDENT 7-point passes (ping-pong A->B->A...) on n^3:
//   sep-direct      K compute passes, one direct dispatch each
//   one-direct      one compute pass, K direct dispatches
//   one-indirect    one pass, K dispatchWorkgroupsIndirect with the full workgroup count
//   one-indirect0   one pass, K indirect dispatches with ZERO workgroups (pure indirect overhead;
//                   Dawn inserts a validation dispatch before each indirect dispatch)
//   one-flagset     one pass, K direct dispatches of a kernel that reads a 'converged' flag via
//                   workgroupUniformLoad and returns (flag = 1): the cost of an encoded-but-skipped
//                   solver iteration
//   one-flagclear   same kernel, flag = 0: the cost of the flag check when it does not fire
//   one-multi       one pass, K direct dispatches cycling through 3 pipelines with 3 different
//                   bind-group layouts (4, 6 and 8 bindings), like the solver, which switches
//                   pipeline and bind group on every dispatch: its wall slope is the CPU-side
//                   (renderer + GPU process) cost per dispatch that the one-pipeline modes hide
// GPU time from pass timestamps (first pass begin -> last pass end); f = slope over K.
// Wall clock: encode (CPU) and submit -> onSubmittedWorkDone, from performance.now().
import { GpuTimer, linfit, timingInvalid, median, type Gate0Device } from './gpu'

const WGSL = /* wgsl */ `
struct Prm { n: u32, n3: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> flag: array<u32>;
@group(0) @binding(4) var<storage, read> ex0: array<f32>;
@group(0) @binding(5) var<storage, read> ex1: array<f32>;
@group(0) @binding(6) var<storage, read> ex2: array<f32>;
@group(0) @binding(7) var<storage, read> ex3: array<f32>;
var<workgroup> wf: u32;

fn stencil(g: u32) {
  if (g >= prm.n3) { return; }
  let n = prm.n;
  let i = g % n;
  let j = (g / n) % n;
  let k = g / (n * n);
  let xm = select(g - 1u, g, i == 0u);
  let xp = select(g + 1u, g, i == n - 1u);
  let ym = select(g - n, g, j == 0u);
  let yp = select(g + n, g, j == n - 1u);
  let zm = select(g - n * n, g, k == 0u);
  let zp = select(g + n * n, g, k == n - 1u);
  dst[g] = 0.4 * src[g] + 0.1 * (src[xm] + src[xp] + src[ym] + src[yp] + src[zm] + src[zp]);
}

@compute @workgroup_size(256)
fn plain(@builtin(global_invocation_id) gid: vec3<u32>) { stencil(gid.x); }

// same stencil plus reads of the extra (zero) bindings, so each layout's bindings are used
@compute @workgroup_size(256)
fn plain6(@builtin(global_invocation_id) gid: vec3<u32>) {
  stencil(gid.x);
  if (gid.x < prm.n3) { dst[gid.x] = dst[gid.x] + ex0[gid.x & 15u] + ex1[gid.x & 15u]; }
}

@compute @workgroup_size(256)
fn plain8(@builtin(global_invocation_id) gid: vec3<u32>) {
  stencil(gid.x);
  if (gid.x < prm.n3) { dst[gid.x] = dst[gid.x] + ex0[gid.x & 15u] + ex1[gid.x & 15u] + ex2[gid.x & 15u] + ex3[gid.x & 15u]; }
}

@compute @workgroup_size(256)
fn flagged(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (lid == 0u) { wf = flag[0]; }
  if (workgroupUniformLoad(&wf) != 0u) { return; }
  stencil(gid.x);
}
`

export type G0aMode = 'sep-direct' | 'one-direct' | 'one-indirect' | 'one-indirect0' | 'one-flagset' | 'one-flagclear' | 'one-multi'

export interface G0aParams {
  grids?: number[]            // default [64, 48, 4]
  Ks?: number[]               // default [10, 100, 1000]
  modes?: G0aMode[]
  reps?: number               // measured repetitions per point (median), default 9
  warmup?: number             // default 3
}

interface Multi { pipes: GPUComputePipeline[]; bgls: GPUBindGroupLayout[] }

interface Rig {
  n: number
  plain: GPUComputePipeline
  flagged: GPUComputePipeline
  multi: Multi
  bgs: GPUBindGroup[]          // [A->B, B->A] with flag=0 buffer; [2,3] with flag=1
  multiBgs: GPUBindGroup[][]   // per multi pipeline: [A->B, B->A]
  argsFull: GPUBuffer
  argsZero: GPUBuffer
  nwg: number
  destroy: () => void
}

function makeRig(device: GPUDevice, n: number, bgl: GPUBindGroupLayout, plain: GPUComputePipeline, flagged: GPUComputePipeline, multi: Multi): Rig {
  const n3 = n * n * n
  const bufs = [0, 1].map(() => device.createBuffer({ size: Math.max(16, n3 * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }))
  const init = new Float32Array(n3)
  for (let i = 0; i < n3; i++) init[i] = (i % 97) / 97
  device.queue.writeBuffer(bufs[0], 0, init)
  const prm = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(prm, 0, new Uint32Array([n, n3, 0, 0]))
  const flag0 = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const flag1 = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(flag1, 0, new Uint32Array([1, 0, 0, 0]))
  const nwg = Math.ceil(n3 / 256)
  const argsFull = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(argsFull, 0, new Uint32Array([nwg, 1, 1]))
  const argsZero = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(argsZero, 0, new Uint32Array([0, 1, 1]))
  const extra = [0, 1, 2, 3].map(() => device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE }))
  const bg = (s: GPUBuffer, d: GPUBuffer, f: GPUBuffer, layout = bgl, nb = 4) => device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: prm } }, { binding: 1, resource: { buffer: s } }, { binding: 2, resource: { buffer: d } }, { binding: 3, resource: { buffer: f } },
      ...extra.slice(0, nb - 4).map((b, i) => ({ binding: 4 + i, resource: { buffer: b } }))],
  })
  return {
    n, plain, flagged, multi, nwg, argsFull, argsZero,
    bgs: [bg(bufs[0], bufs[1], flag0), bg(bufs[1], bufs[0], flag0), bg(bufs[0], bufs[1], flag1), bg(bufs[1], bufs[0], flag1)],
    multiBgs: multi.bgls.map((l, i) => [bg(bufs[0], bufs[1], flag0, l, 4 + 2 * i), bg(bufs[1], bufs[0], flag0, l, 4 + 2 * i)]),
    destroy: () => { for (const b of [...bufs, ...extra, prm, flag0, flag1, argsFull, argsZero]) b.destroy() },
  }
}

function encode(device: GPUDevice, rig: Rig, mode: G0aMode, K: number, timer: GpuTimer): GPUCommandBuffer {
  const enc = device.createCommandEncoder()
  const flagOffset = mode === 'one-flagset' ? 2 : 0
  const pipe = mode === 'one-flagset' || mode === 'one-flagclear' ? rig.flagged : rig.plain
  if (mode === 'sep-direct') {
    for (let k = 0; k < K; k++) {
      const tw: GPUComputePassTimestampWrites | undefined = K === 1 ? timer.whole(0)
        : k === 0 ? timer.begin(0) : k === K - 1 ? timer.end(0) : undefined
      const pass = enc.beginComputePass({ timestampWrites: tw })
      pass.setPipeline(pipe)
      pass.setBindGroup(0, rig.bgs[k & 1])
      pass.dispatchWorkgroups(rig.nwg)
      pass.end()
    }
  } else {
    const pass = enc.beginComputePass({ timestampWrites: timer.whole(0) })
    if (mode === 'one-multi') {
      for (let k = 0; k < K; k++) {
        const m = k % 3
        pass.setPipeline(rig.multi.pipes[m])
        pass.setBindGroup(0, rig.multiBgs[m][k & 1])
        pass.dispatchWorkgroups(rig.nwg)
      }
      pass.end()
      timer.resolve(enc, 1)
      return enc.finish()
    }
    pass.setPipeline(pipe)
    for (let k = 0; k < K; k++) {
      pass.setBindGroup(0, rig.bgs[flagOffset + (k & 1)])
      if (mode === 'one-indirect') pass.dispatchWorkgroupsIndirect(rig.argsFull, 0)
      else if (mode === 'one-indirect0') pass.dispatchWorkgroupsIndirect(rig.argsZero, 0)
      else pass.dispatchWorkgroups(rig.nwg)
    }
    pass.end()
  }
  timer.resolve(enc, 1)
  return enc.finish()
}

export interface G0aPoint { n: number; mode: G0aMode; K: number; gpuNs: number[]; gpuMedUs: number; encodeMedMs: number; wallMedMs: number }
export interface G0aFit { n: number; mode: G0aMode; slopeUsPerDispatch: number; interceptUs: number; r2: number; wallSlopeUsPerDispatch: number; encodeUsPerDispatch: number }

export async function runG0a(g: Gate0Device, p: G0aParams = {}) {
  const device = g.device
  const grids = p.grids ?? [64, 48, 4]
  const Ks = p.Ks ?? [10, 100, 1000]
  const modes = p.modes ?? ['sep-direct', 'one-direct', 'one-indirect', 'one-indirect0', 'one-flagset', 'one-flagclear', 'one-multi']
  const reps = p.reps ?? 9
  const warmup = p.warmup ?? 3
  const module = device.createShaderModule({ code: WGSL, label: 'g0a' })
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  })
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] })
  const plain = await device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'plain' } })
  const flagged = await device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'flagged' } })
  const mkBgl = (nb: number) => device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ...Array.from({ length: nb - 3 }, (_, i) => ({ binding: 3 + i, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
    ],
  })
  const multiBgls = [4, 6, 8].map(mkBgl)
  const multi: Multi = {
    bgls: multiBgls,
    pipes: await Promise.all(['plain', 'plain6', 'plain8'].map((ep, i) => device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [multiBgls[i]] }), compute: { module, entryPoint: ep },
    }))),
  }
  const timer = new GpuTimer(device, 1)
  const points: G0aPoint[] = []
  const fits: G0aFit[] = []
  const allNs: number[] = []
  try {
    for (const n of grids) {
      const rig = makeRig(device, n, bgl, plain, flagged, multi)
      // clock warm-up: ~0.3 s of dependent passes before this grid's measurements
      for (let i = 0; i < 3; i++) { device.queue.submit([encode(device, rig, 'one-direct', 1000, timer)]); await device.queue.onSubmittedWorkDone() }
      for (const mode of modes) {
        for (const K of Ks) {
          const gpu: number[] = [], encs: number[] = [], walls: number[] = []
          for (let r = 0; r < warmup + reps; r++) {
            const t0 = performance.now()
            const cb = encode(device, rig, mode, K, timer)
            const t1 = performance.now()
            device.queue.submit([cb])
            await device.queue.onSubmittedWorkDone()
            const t2 = performance.now()
            const [ns] = await timer.read(1)
            if (r >= warmup) { gpu.push(ns); encs.push(t1 - t0); walls.push(t2 - t1) }
          }
          allNs.push(...gpu)
          points.push({ n, mode, K, gpuNs: gpu, gpuMedUs: median(gpu) / 1e3, encodeMedMs: median(encs), wallMedMs: median(walls) })
        }
        const pts = points.filter(q => q.n === n && q.mode === mode)
        const f = linfit(pts.map(q => q.K), pts.map(q => q.gpuMedUs))
        const fw = linfit(pts.map(q => q.K), pts.map(q => q.wallMedMs * 1e3))
        const fe = linfit(pts.map(q => q.K), pts.map(q => q.encodeMedMs * 1e3))
        fits.push({ n, mode, slopeUsPerDispatch: f.slope, interceptUs: f.intercept, r2: f.r2, wallSlopeUsPerDispatch: fw.slope, encodeUsPerDispatch: fe.slope })
      }
      rig.destroy()
    }
  } finally {
    timer.destroy()
  }
  const invalidTimestamps = timingInvalid(allNs)
  // derived: indirect validation cost v = f(indirect0) - f(4^3 direct) ... reported as raw fits; the
  // driver/report does the subtraction with both numbers visible.
  return { test: 'g0a', params: { grids, Ks, modes, reps, warmup }, invalidTimestamps, points: points.map(({ gpuNs, ...rest }) => ({ ...rest, gpuMinUs: Math.min(...gpuNs) / 1e3, gpuMaxUs: Math.max(...gpuNs) / 1e3 })), fits }
}
