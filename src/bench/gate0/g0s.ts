/// <reference types="@webgpu/types" />
// G0-s — whole-substep CHAIN throughput: GPU time AND the CPU-side cost of encoding, validating and
// submitting thousands of direct dispatches per frame (review finding: the per-dispatch GPU floor
// alone hides a ~4 µs/dispatch CPU cost). FINAL-PLAN §5.1 ("encoded dispatches x per-dispatch
// floor"), §7 S0.5 branch rule. This is an INDIRECT measure of the GPU-process cost (frame period
// under back-to-back submission), not a Chrome trace.
//
// One S3 substep is proxied by, in encode order (all direct dispatches, one command buffer/frame):
//   psi solver:  encodePrepare + encodeSolve(cold, cap = capPsi, inf 1e-3)          [PoissonSolver]
//   p   solver:  encodePrepare + encodeSolve(cold, cap = capP,   inf 1e-2)          [PoissonSolver]
//   grid passes: G dependent 7-point passes on n^3 cycling 3 pipelines / 3 bind-group layouts
//                (4, 6, 8 bindings)                          [EST proxy for S3's non-solver grid kernels]
//   particles:   MpmGpuSimulator.step(enc, k) at `particles`       [EST proxy for S3's transfers]
// Variants:  low  = G 9,  k = 1   (9 grid kernels, transfers = 1x the current MPM substep)
//            high = G 27, k = 2   (MAC: 3 face grids per grid kernel, transfers = 2x the MPM substep)
//            solverOnly = the two solves + prepares only (for the per-dispatch CPU cost c)
// Scenarios: fixture = RHS from the named G0-b fixtures, both solves COLD, so the executed iterations
//                      are the measured G0-b counts and the rest of the cap early-exits
//            exec    = tol < 0: every iteration up to the cap executes (GPU upper bound)
//            skip    = tol = 1e30: converged at init, every iteration early-exits (dispatch floor)
//            empty   = timestamp markers only (baseline)
// Per configuration (nsub substeps per frame):
//   gpuMs       timestamp interval begin marker -> end marker, median of tsFrames single-frame submits
//   encodeMs    main-thread JS time to encode one frame (median)
//   latencyMs   submit -> onSubmittedWorkDone of one frame (median)
//   periodMs    frames encoded AND submitted back-to-back with no wait, then one wait; total / frames
//               (the frame period an app that encodes + submits every rAF would see); median of batches
//   periodPreMs same with all frames pre-encoded (excludes main-thread encode: GPU process + GPU)
import { PoissonSolver, type SolveConfig } from '../../gpu-sim/flip/poisson/PoissonSolver'
import { GpuTimer, timingInvalid, median, type Gate0Device } from './gpu'
import { getSim, stepChecked, createSsfrRig, type SsfrRig, type View } from './g0fg'

export type ChainVariant = 'low' | 'high' | 'solverOnly'
export type ChainScenario = 'fixture' | 'exec' | 'skip' | 'empty'

export interface G0sParams {
  n?: number
  particles?: number
  capP: number
  capPsi: number
  pCase: string
  psiCase: string
  nsubs?: number[]
  variants?: ChainVariant[]
  scenarios?: ChainScenario[]
  frames?: number
  batches?: number
  tsFrames?: number
  /** joint frames: chain (fixture scenario) + SSFR render in the same command buffer */
  renders?: { width: number; height: number; view: View; nsub: number; variant: ChainVariant }[]
  fixturesUrl?: string
}

const GRID_WGSL = /* wgsl */ `
struct Prm { n: u32, n3: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> ex0: array<f32>;
@group(0) @binding(4) var<storage, read> ex1: array<f32>;
@group(0) @binding(5) var<storage, read> ex2: array<f32>;
@group(0) @binding(6) var<storage, read> ex3: array<f32>;
@group(0) @binding(7) var<storage, read> ex4: array<f32>;
fn stencil(g: u32) -> f32 {
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
  return 0.4 * src[g] + 0.1 * (src[xm] + src[xp] + src[ym] + src[yp] + src[zm] + src[zp]);
}
@compute @workgroup_size(256) fn g4(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= prm.n3) { return; }
  dst[gid.x] = stencil(gid.x);
}
@compute @workgroup_size(256) fn g6(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= prm.n3) { return; }
  dst[gid.x] = stencil(gid.x) + ex0[gid.x & 15u] + ex1[gid.x & 15u];
}
@compute @workgroup_size(256) fn g8(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= prm.n3) { return; }
  dst[gid.x] = stencil(gid.x) + ex0[gid.x & 15u] + ex1[gid.x & 15u] + ex2[gid.x & 15u] + ex3[gid.x & 15u] + ex4[gid.x & 15u];
}
`

interface GridRig { pipes: GPUComputePipeline[]; bgs: GPUBindGroup[][]; nwg: number; destroy(): void }

async function makeGridRig(device: GPUDevice, n: number): Promise<GridRig> {
  const module = device.createShaderModule({ code: GRID_WGSL, label: 'g0s-grid' })
  const eps = ['g4', 'g6', 'g8']     // 3, 5 and 8 bindings
  const n3 = n * n * n
  const bufs = [0, 1].map(() => device.createBuffer({ size: n3 * 4, usage: GPUBufferUsage.STORAGE }))
  const extra = [0, 1, 2, 3, 4].map(() => device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE }))
  const prm = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(prm, 0, new Uint32Array([n, n3, 0, 0]))
  const pipes: GPUComputePipeline[] = []
  const bgs: GPUBindGroup[][] = []
  for (let m = 0; m < 3; m++) {
    const nb = m === 0 ? 3 : m === 1 ? 5 : 8
    const bgl = device.createBindGroupLayout({
      entries: Array.from({ length: nb }, (_, b) => ({
        binding: b, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: b === 0 ? 'uniform' as const : b === 2 ? 'storage' as const : 'read-only-storage' as const },
      })),
    })
    pipes.push(await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module, entryPoint: eps[m] } }))
    const bg = (s: GPUBuffer, d: GPUBuffer) => device.createBindGroup({
      layout: bgl,
      entries: Array.from({ length: nb }, (_, b) => ({ binding: b, resource: { buffer: b === 0 ? prm : b === 1 ? s : b === 2 ? d : extra[b - 3] } })),
    })
    bgs.push([bg(bufs[0], bufs[1]), bg(bufs[1], bufs[0])])
  }
  return { pipes, bgs, nwg: Math.ceil(n3 / 256), destroy: () => { for (const b of [...bufs, ...extra, prm]) b.destroy() } }
}

export async function runG0s(g: Gate0Device, p: G0sParams) {
  const device = g.device
  const n = p.n ?? 64
  const particles = p.particles ?? 100000
  const nsubs = p.nsubs ?? [1, 2, 3]
  const variants = p.variants ?? ['low', 'high', 'solverOnly']
  const scenarios = p.scenarios ?? ['fixture', 'exec', 'skip', 'empty']
  const frames = p.frames ?? 60
  const batches = p.batches ?? 3
  const tsFrames = p.tsFrames ?? 7
  const base = p.fixturesUrl ?? `/bench-results/gate0/fixtures/n${n}/`
  const manifest = await (await fetch(base + 'manifest.json')).json() as {
    n: number; domains: Record<string, { file: string }>
    cases: { name: string; domain: string; rhs: string; x0?: string; fcoef?: string; tol: number; criterion: string; solve: string }[]
  }
  if (manifest.n !== n) throw new Error(`manifest n ${manifest.n} != ${n}`)
  const bin = async (f: string) => { const r = await fetch(base + f); if (!r.ok) throw new Error(`fetch ${f}: ${r.status}`); return r.arrayBuffer() }
  const caseOf = (name: string) => {
    const c = manifest.cases.find(q => q.name === name)
    if (!c) throw new Error(`G0-s: no fixture case ${name}`)
    if (c.x0 || c.fcoef) throw new Error(`G0-s: ${name} is warm or variable-coefficient; the chain uses cold unit-coefficient cases`)
    return c
  }
  const cp = caseOf(p.pCase), cq = caseOf(p.psiCase)

  // two solver instances (one per system), as production will use them
  const sp = await PoissonSolver.create(device, { nx: n, ny: n, nz: n, method: 'mgpcg', label: 'g0s-p' })
  const sq = await PoissonSolver.create(device, { nx: n, ny: n, nz: n, method: 'mgpcg', label: 'g0s-psi' })
  sp.setProblem({ labels: new Uint8Array(await bin(manifest.domains[cp.domain].file)), rhs: new Float32Array(await bin(cp.rhs)) })
  sq.setProblem({ labels: new Uint8Array(await bin(manifest.domains[cq.domain].file)), rhs: new Float32Array(await bin(cq.rhs)) })
  const cfg: Record<'fixture' | 'exec' | 'skip', { p: SolveConfig; q: SolveConfig }> = {
    fixture: { p: sp.createSolveConfig({ criterion: 'inf', tol: cp.tol, cap: p.capP }), q: sq.createSolveConfig({ criterion: 'inf', tol: cq.tol, cap: p.capPsi }) },
    exec: { p: sp.createSolveConfig({ criterion: 'inf', tol: -1, cap: p.capP }), q: sq.createSolveConfig({ criterion: 'inf', tol: -1, cap: p.capPsi }) },
    skip: { p: sp.createSolveConfig({ criterion: 'inf', tol: 1e30, cap: p.capP }), q: sq.createSolveConfig({ criterion: 'inf', tol: 1e30, cap: p.capPsi }) },
  }
  const grid = await makeGridRig(device, n)
  const sim = await getSim(g, particles, 600)
  const timer = new GpuTimer(device, 1)
  const allNs: number[] = []

  const G = { low: 9, high: 27, solverOnly: 0 } as const
  const K = { low: 1, high: 2, solverOnly: 0 } as const
  /** encode one frame; returns direct dispatches encoded */
  const encodeFrame = (enc: GPUCommandEncoder, sc: ChainScenario, v: ChainVariant, nsub: number, rig?: SsfrRig): number => {
    let d = 0
    if (sc !== 'empty') {
      const c = cfg[sc]
      for (let s = 0; s < nsub; s++) {
        d += sq.encodePrepare(enc)
        d += sq.encodeSolve(enc, c.q, { warmStart: false })
        d += sp.encodePrepare(enc)
        d += sp.encodeSolve(enc, c.p, { warmStart: false })
        if (G[v] > 0) {
          const pass = enc.beginComputePass({ label: 'g0s-grid' })
          for (let k = 0; k < G[v]; k++) {
            const m = k % 3
            pass.setPipeline(grid.pipes[m])
            pass.setBindGroup(0, grid.bgs[m][k & 1])
            pass.dispatchWorkgroups(grid.nwg)
          }
          pass.end()
          d += G[v]
        }
        if (K[v] > 0) { stepChecked(sim, enc, K[v]); d += 5 * K[v] }
      }
    }
    if (rig) rig.encode(enc)
    return d
  }

  const measure = async (sc: ChainScenario, v: ChainVariant, nsub: number, rig?: SsfrRig) => {
    // warm-up
    for (let i = 0; i < 3; i++) { const e = device.createCommandEncoder(); encodeFrame(e, sc, v, nsub, rig); device.queue.submit([e.finish()]) }
    await device.queue.onSubmittedWorkDone()
    // GPU time + latency + encode, single frames
    const gpu: number[] = [], lat: number[] = [], encT: number[] = []
    let dispatches = 0
    for (let f = 0; f < tsFrames; f++) {
      const t0 = performance.now()
      const enc = device.createCommandEncoder()
      timer.mark(enc, timer.begin(0))
      dispatches = encodeFrame(enc, sc, v, nsub, rig)
      timer.mark(enc, timer.end(0))
      timer.resolve(enc, 1)
      const cb = enc.finish()
      const t1 = performance.now()
      device.queue.submit([cb])
      await device.queue.onSubmittedWorkDone()
      lat.push(performance.now() - t1)
      encT.push(t1 - t0)
      const [ns] = await timer.read(1)
      gpu.push(ns)
    }
    if (sc !== 'empty' || rig) allNs.push(...gpu)
    // throughput with encode in the loop (what a per-rAF encoder sees), and pre-encoded
    const period: number[] = [], periodPre: number[] = []
    for (let b = 0; b < batches; b++) {
      await device.queue.onSubmittedWorkDone()
      let t0 = performance.now()
      for (let f = 0; f < frames; f++) {
        const e = device.createCommandEncoder()
        encodeFrame(e, sc, v, nsub, rig)
        device.queue.submit([e.finish()])
      }
      await device.queue.onSubmittedWorkDone()
      period.push((performance.now() - t0) / frames)
      const cbs: GPUCommandBuffer[] = []
      for (let f = 0; f < frames; f++) { const e = device.createCommandEncoder(); encodeFrame(e, sc, v, nsub, rig); cbs.push(e.finish()) }
      await device.queue.onSubmittedWorkDone()
      t0 = performance.now()
      for (const cb of cbs) device.queue.submit([cb])
      await device.queue.onSubmittedWorkDone()
      periodPre.push((performance.now() - t0) / frames)
    }
    const stP = sc === 'empty' ? null : await sp.readStats(false)
    const stQ = sc === 'empty' ? null : await sq.readStats(false)
    return {
      scenario: sc, variant: v, nsub, render: rig ? `${rig.W}x${rig.H}` : null, dispatches,
      gpuMs: median(gpu) / 1e6, encodeMs: median(encT), latencyMs: median(lat), periodMs: median(period), periodPreMs: median(periodPre),
      periodAll: period.map(x => +x.toFixed(3)), periodPreAll: periodPre.map(x => +x.toFixed(3)),
      lastSolve: stP && stQ ? { p: { iters: stP.iterations, converged: stP.converged, breakdown: stP.breakdown }, psi: { iters: stQ.iterations, converged: stQ.converged, breakdown: stQ.breakdown } } : null,
    }
  }

  const rows: Awaited<ReturnType<typeof measure>>[] = []
  try {
    device.pushErrorScope('validation')
    for (const nsub of nsubs) {
      for (const sc of scenarios) {
        if (sc === 'empty') { if (nsub === nsubs[0]) rows.push(await measure('empty', 'solverOnly', 0)); continue }
        for (const v of variants) {
          if (v === 'solverOnly' && sc !== 'skip' && sc !== 'exec') continue
          rows.push(await measure(sc, v, nsub))
        }
      }
    }
    const joint: Awaited<ReturnType<typeof measure>>[] = []
    for (const r of p.renders ?? []) {
      const rig = await createSsfrRig(g, sim, r.width, r.height, r.view)
      try {
        joint.push({ ...(await measure('fixture', r.variant, r.nsub, rig)), view: r.view } as Awaited<ReturnType<typeof measure>>)
        joint.push({ ...(await measure('empty', 'solverOnly', 0, rig)), view: r.view } as Awaited<ReturnType<typeof measure>>)
      } finally { rig.destroy() }
    }
    const err = await device.popErrorScope()
    if (err) throw new Error(`G0-s validation error: ${err.message.split(/\r?\n/)[0]}`)
    // per-dispatch CPU-side cost from the dispatch-floor chain (no MPM, no grid passes, every
    // iteration early-exits): c = (period - empty period) / dispatches, per nsub. This is an upper
    // bound on the pipelined CPU cost only while the chain is CPU-bound (period > GPU time).
    const empty = rows.find(r => r.scenario === 'empty')
    const cpu = rows.filter(r => r.scenario === 'skip' && r.variant === 'solverOnly').map(r => ({
      nsub: r.nsub, dispatches: r.dispatches, gpuMs: r.gpuMs, periodMs: r.periodMs, periodPreMs: r.periodPreMs,
      cUsPerDispatch: empty ? 1000 * (r.periodMs - empty.periodMs) / r.dispatches : null,
      cPreUsPerDispatch: empty ? 1000 * (r.periodPreMs - empty.periodPreMs) / r.dispatches : null,
      // serial (unpipelined) view: single-frame latency minus the empty-frame round trip minus GPU time
      cSerialUsPerDispatch: empty ? 1000 * (r.latencyMs - empty.latencyMs - r.gpuMs) / r.dispatches : null,
      encodeUsPerDispatch: 1000 * r.encodeMs / r.dispatches,
    }))
    // did the fixture scenario execute the expected iteration counts? (exec: = cap, skip: 0)
    const iterCheck = rows.filter(r => r.lastSolve).map(r => {
      const ls = r.lastSolve!
      const ok = r.scenario === 'exec' ? ls.p.iters === p.capP && ls.psi.iters === p.capPsi && !ls.p.converged && !ls.psi.converged
        : r.scenario === 'skip' ? ls.p.iters === 0 && ls.psi.iters === 0
          : ls.p.converged && ls.psi.converged
      return { scenario: r.scenario, variant: r.variant, nsub: r.nsub, ...ls, ok }
    })
    return {
      test: 'g0s', n, particles, capP: p.capP, capPsi: p.capPsi, pCase: p.pCase, psiCase: p.psiCase, pDomain: cp.domain, psiDomain: cq.domain,
      solverDispatches: sp.dispatches, gridPasses: G, mpmSubstepsPerSubstep: K, frames, batches, tsFrames,
      rows, joint, cpu, iterCheck, iterCheckPass: iterCheck.every(r => r.ok),
      invalidTimestamps: timingInvalid(allNs),
    }
  } finally {
    timer.destroy(); grid.destroy(); sp.destroy(); sq.destroy()
  }
}
