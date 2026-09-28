/// <reference types="@webgpu/types" />
// PoissonSolver.ts — GPU solver for the 7-point variable-coefficient pressure Poisson system
// on an nx*ny*nz cell grid with cell labels (FLUID unknown / AIR Dirichlet p = 0 / SOLID
// Neumann), face coefficients a_f and right-hand side b. FINAL-PLAN §5.1, §5.3.
//
//   method 'jpcg'  : Jacobi-preconditioned CG (the correctness baseline)
//   method 'mgpcg' : CG preconditioned by one McAdams-Sifakis-Teran 2010 V-cycle
//                    (damped Jacobi w = 2/3, 2 pre + 2 post, R = B(x)B(x)B with B = [1,3,3,1]/8,
//                     P = 8 R^T, coarse cell Dirichlet if any child is, coarse operators by
//                     McAdams §3.2 rediscretisation from the coarse labels, coarsest level solved
//                     by a FIXED number of sweeps in one workgroup so M is linear SPD).
//                    McAdams' extra boundary Gauss-Seidel sweeps are not used (FINAL-PLAN §5.3).
//
// All arithmetic is f32. Dot products and the residual norms come from workgroup-reduced
// partial sums; the convergence test (inf-norm, or relative 2-norm for numpy parity) runs
// EVERY iteration. A solve is encoded with DIRECT dispatches only, at a fixed iteration cap;
// once converged, every remaining kernel returns at entry via a flag read with
// workgroupUniformLoad, so the unneeded iterations cost only the per-dispatch floor.
//
// ─── Data layout ────────────────────────────────────────────────────────────────────────
// Level-0 arrays are PADDED with one ghost layer (FINAL-PLAN §5.2), x fastest:
//   index(i, j, k) = (i+1) + (nx+2)*((j+1) + (ny+2)*(k+1)),  0 <= i < nx etc.
// Ghost cells must stay SOLID with zero coefficients and zero values (the solver never writes
// them). Labels: LABEL_AIR = 0, LABEL_FLUID = 1, LABEL_SOLID = 2 (u32 per cell).
// Face coefficients: vec4 per cell = (a on the cell's -x face, a on -y, a on -z, extraDiag).
//   The +x face of cell i is the -x face of cell i+1. CONTRACT: a_f must be finite and > 0 on
//   EVERY interior face, including faces that touch SOLID. Level 0 drops faces touching SOLID,
//   but the coarse levels are rediscretised (McAdams §3.2): a coarse face is open whenever both
//   COARSE cells are non-SOLID and its coefficient is 1/4 x the mean of the 4 fine NOMINAL values,
//   so a nominal value next to a solid is used there. Supply the value the face would have if it
//   were open (e.g. the adjacent fluid's a_f). With a uniform a_f this is McAdams exactly
//   (writeUnitCoefficients / setProblem without faceCoef do that). The arithmetic mean for
//   varying a_f is [PROPOSED] (FINAL-PLAN G0-c).
//   For the pressure solve a_f = dt / (rho_f dx^2); extraDiag carries the ghost-fluid term
//   a_f (1 - theta)/theta of liquid-air faces (Bridson eq. 4.37), 0 otherwise (level 0 only).
// Every connected FLUID region must touch AIR (or have extraDiag > 0), otherwise the system is
// singular (pure Neumann) and CG may break down; `breakdown` is reported, never hidden.
//
// ─── Use ────────────────────────────────────────────────────────────────────────────────
//   const s = await PoissonSolver.create(device, { nx: 64, ny: 64, nz: 64, method: 'mgpcg' })
//   const cfg = s.createSolveConfig({ criterion: 'inf', tol: 1e-2, cap: 20 })   // static uniform
//   // GPU producers write s.buffers.labels (level-0 region), s.buffers.faceCoef, s.buffers.rhs;
//   // tests use writeLabels / writeFaceCoefficients / writeRhs instead.
//   s.encodePrepare(encoder)                         // operator + MG hierarchy from labels/coeffs
//   s.encodeSolve(encoder, cfg, { warmStart: true }) // x in s.buffers.x (p: warm; psi: COLD, §5.3)
//   ... submit ...; await s.readStats()
// Failure is never silent: every solve ends with a one-thread kernel that bumps STICKY counters in
// s.buffers.faults (u32 [solves, capHits, breakdowns, maxIterations]) that later kernels of the
// same frame may bind; readFaults() / encodeClearFaults() for the CPU side.
// queue.writeBuffer lands before the whole command buffer runs, so everything that varies per
// solve inside one submit (rhs, labels) must be GPU-written; per-solve constants live in
// SolveConfig uniforms created once.

import commonWGSL from './common.wgsl?raw'
import prepareWGSL from './prepare.wgsl?raw'
import cgWGSL from './cg.wgsl?raw'
import mgWGSL from './mg.wgsl?raw'

export const LABEL_AIR = 0
export const LABEL_FLUID = 1
export const LABEL_SOLID = 2

export type SolverMethod = 'jpcg' | 'mgpcg'
export type StopCriterion = 'inf' | 'rel2'

export interface PoissonSolverDesc {
  nx: number
  ny: number
  nz: number
  method: SolverMethod
  /** damped-Jacobi sweeps on the coarsest MG level (default 60 = r1 / numpy reference) */
  coarseSweeps?: number
  /** levels (below level 0) with at most this many interior cells run in the one-workgroup tail (default 512) */
  tailMaxCells?: number
  /** entries of the per-iteration residual history (default 1024) */
  historyCap?: number
  label?: string
}

export interface LevelInfo {
  nx: number; ny: number; nz: number
  /** interior cells */ n: number
  /** padded strides */ sy: number; sz: number
  /** offset of this level in the all-level arrays (cells) */ base: number
  /** workgroups for one thread per interior cell */ nwg: number
  /** padded cell count */ padded: number
}

export interface SolveConfigDesc {
  criterion: StopCriterion
  /** inf: absolute ||r||_inf bound (units of b). rel2: ||r||_2/||b||_2 bound. Negative = never converge (timing). */
  tol: number
  /** encoded iteration cap K */
  cap: number
}

export interface SolveConfig extends SolveConfigDesc {
  readonly bindGroup: GPUBindGroup
  readonly buffer: GPUBuffer
}

export interface SolveStats {
  iterations: number
  converged: boolean
  breakdown: boolean
  /** ||r||_inf of the recursive residual at exit, and at iteration 0 */
  rInf: number
  rInf0: number
  /** ||r||_2 / ||b||_2 at exit */
  rel2: number
  bNorm2: number
  /** (rel2, inf) for iterations 0..iterations (if requested) */
  history?: { rel2: number[]; inf: number[] }
}

type BindName = 'P' | 'st' | 'part' | 'coef' | 'lab' | 'fcoef' | 'vx' | 'vd' | 'vq' | 'vb' | 'mb' | 'mua' | 'mub' | 'mres' | 'hist' | 'nom' | 'flt'

const BIND: Record<BindName, { binding: number; type: GPUBufferBindingType }> = {
  P: { binding: 0, type: 'uniform' },
  st: { binding: 1, type: 'storage' },
  part: { binding: 2, type: 'storage' },
  coef: { binding: 3, type: 'storage' },
  lab: { binding: 4, type: 'storage' },
  fcoef: { binding: 5, type: 'read-only-storage' },
  vx: { binding: 6, type: 'storage' },
  vd: { binding: 7, type: 'storage' },
  vq: { binding: 8, type: 'storage' },
  vb: { binding: 9, type: 'read-only-storage' },
  mb: { binding: 10, type: 'storage' },
  mua: { binding: 11, type: 'storage' },
  mub: { binding: 12, type: 'storage' },
  mres: { binding: 13, type: 'storage' },
  hist: { binding: 14, type: 'storage' },
  nom: { binding: 15, type: 'storage' },
  flt: { binding: 16, type: 'storage' },
}

// Per-kernel binding table = the static use of each entry point (≤ 8 storage buffers each, so
// the spec-default limit suffices; asserted at creation).
const KERNELS: Record<string, { uses: BindName[]; solveParams?: boolean }> = {
  prep_fine: { uses: ['P', 'lab', 'fcoef', 'coef', 'nom'] },
  prep_labels: { uses: ['P', 'lab'] },
  prep_coef: { uses: ['P', 'lab', 'coef', 'nom'] },
  cg_init_mg: { uses: ['P', 'part', 'coef', 'vx', 'vb', 'mb', 'mub'] },
  cg_init_jacobi: { uses: ['P', 'part', 'coef', 'vx', 'vb', 'mb', 'mub'] },
  cg_init_reduce: { uses: ['P', 'st', 'part', 'hist'], solveParams: true },
  cg_rz_init: { uses: ['P', 'st', 'part'] },
  cg_dupdate: { uses: ['P', 'st', 'vd', 'mub'] },
  cg_matvec: { uses: ['P', 'st', 'part', 'coef', 'vd', 'vq'] },
  cg_alpha: { uses: ['P', 'st', 'part'] },
  cg_update_jacobi: { uses: ['P', 'st', 'part', 'coef', 'vx', 'vd', 'vq', 'mb', 'mub'] },
  cg_update_mg: { uses: ['P', 'st', 'part', 'coef', 'vx', 'vd', 'vq', 'mb', 'mub'] },
  cg_check_jacobi: { uses: ['P', 'st', 'part', 'hist'], solveParams: true },
  cg_check_mg: { uses: ['P', 'st', 'part', 'hist'], solveParams: true },
  cg_beta: { uses: ['P', 'st', 'part'] },
  cg_finalize: { uses: ['st', 'flt'] },
  mg_presmooth: { uses: ['P', 'st', 'coef', 'mb', 'mua'] },
  mg_residual: { uses: ['P', 'st', 'coef', 'mb', 'mua', 'mres'] },
  mg_restrict: { uses: ['P', 'st', 'coef', 'mb', 'mres'] },
  mg_prolong: { uses: ['P', 'st', 'coef', 'mua', 'mub'] },
  mg_post_ba: { uses: ['P', 'st', 'coef', 'mb', 'mua', 'mub'] },
  mg_post_ab: { uses: ['P', 'st', 'part', 'coef', 'mb', 'mua', 'mub'] },
  mg_tail: { uses: ['P', 'st', 'coef', 'mb', 'mua', 'mub', 'mres'] },
}

const WG = 256
const PARAM_STRIDE = 256          // one Params record per level (minUniformBufferOffsetAlignment)
const MAX_LEVELS = 7              // Params.lv array length in common.wgsl
const STATE_BYTES = 48

export interface SolveFaults {
  /** solves encoded since the last clear */ solves: number
  /** solves that reached their cap without converging */ capHits: number
  /** solves stopped by a CG breakdown (d.Ad <= 0 or NaN) */ breakdowns: number
  /** largest iteration count of any solve */ maxIterations: number
}

export const POISSON_WGSL = [commonWGSL, prepareWGSL, cgWGSL, mgWGSL].join('\n')

export function buildLevels(nx: number, ny: number, nz: number, method: SolverMethod): LevelInfo[] {
  const levels: LevelInfo[] = []
  let base = 0
  for (;;) {
    const n = nx * ny * nz
    const padded = (nx + 2) * (ny + 2) * (nz + 2)
    levels.push({ nx, ny, nz, n, sy: nx + 2, sz: (nx + 2) * (ny + 2), base, nwg: Math.ceil(n / WG), padded })
    base += padded
    if (method === 'jpcg') break
    // coarsen while the grid is larger than 4 and halvable (r1: 64 -> 4, 48 -> 3; 5 levels each)
    if (Math.max(nx, ny, nz) > 4 && nx % 2 === 0 && ny % 2 === 0 && nz % 2 === 0) { nx /= 2; ny /= 2; nz /= 2 } else break
  }
  if (levels.length > MAX_LEVELS) throw new Error(`PoissonSolver: ${levels.length} levels > ${MAX_LEVELS}`)
  return levels
}

export class PoissonSolver {
  readonly device: GPUDevice
  readonly desc: Required<PoissonSolverDesc>
  readonly levels: LevelInfo[]
  readonly tail: number
  readonly method: SolverMethod
  readonly buffers: {
    params: GPUBuffer; state: GPUBuffer; partials: GPUBuffer; coef: GPUBuffer; labels: GPUBuffer
    faceCoef: GPUBuffer; x: GPUBuffer; d: GPUBuffer; q: GPUBuffer; rhs: GPUBuffer
    mgB: GPUBuffer; mgUA: GPUBuffer; mgUB: GPUBuffer; mgRes: GPUBuffer; history: GPUBuffer
    nominal: GPUBuffer; faults: GPUBuffer
  }
  /** dispatches encoded: prepare pass; a solve = init + cap * perIteration + finalize */
  readonly dispatches: { prepare: number; init: number; perIteration: number; finalize: number; vcycle: number }

  private pipelines = new Map<string, GPUComputePipeline>()
  private layouts = new Map<string, GPUBindGroupLayout>()
  private bgCache = new Map<string, GPUBindGroup>()
  private solveBGL: GPUBindGroupLayout

  private constructor(device: GPUDevice, desc: Required<PoissonSolverDesc>, solveBGL: GPUBindGroupLayout) {
    this.device = device
    this.desc = desc
    this.method = desc.method
    this.levels = buildLevels(desc.nx, desc.ny, desc.nz, desc.method)
    this.solveBGL = solveBGL
    const nl = this.levels.length
    if (this.method === 'mgpcg' && nl < 2) throw new Error('PoissonSolver: MGPCG needs a grid that coarsens at least once')
    let tail = nl - 1
    for (let l = 1; l < nl; l++) if (this.levels[l].n <= desc.tailMaxCells) { tail = l; break }
    this.tail = this.method === 'mgpcg' ? tail : 0

    const total = this.levels.reduce((s, L) => s + L.padded, 0)
    const p0 = this.levels[0].padded
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST
    const mk = (label: string, size: number, usage: number) => device.createBuffer({ label: `${desc.label}:${label}`, size: Math.max(16, size), usage })
    this.buffers = {
      params: mk('params', nl * PARAM_STRIDE, GPUBufferUsage.UNIFORM | CD),
      state: mk('state', 64, S | CS | CD),
      partials: mk('partials', this.levels[0].nwg * 16, S | CS),
      coef: mk('coef', total * 16, S | CS),
      labels: mk('labels', total * 4, S | CS | CD),
      faceCoef: mk('faceCoef', p0 * 16, S | CD),
      x: mk('x', p0 * 4, S | CS | CD),
      d: mk('d', p0 * 4, S | CS | CD),
      q: mk('q', p0 * 4, S | CS),
      rhs: mk('rhs', p0 * 4, S | CS | CD),   // COPY_SRC: kernel-parity tests read the GPU-written rhs
      mgB: mk('mgB', total * 4, S | CS | CD),
      mgUA: mk('mgUA', total * 4, S | CS),
      mgUB: mk('mgUB', total * 4, S | CS),
      mgRes: mk('mgRes', total * 4, S | CS),
      history: mk('history', desc.historyCap * 8, S | CS),
      nominal: mk('nominal', total * 16, S | CS),
      faults: mk('faults', 16, S | CS | CD),
    }

    // static per-level parameter records
    const rec = new ArrayBuffer(nl * PARAM_STRIDE)
    for (let cur = 0; cur < nl; cur++) {
      const u = new Uint32Array(rec, cur * PARAM_STRIDE, PARAM_STRIDE / 4)
      this.levels.forEach((L, i) => u.set([L.nx, L.ny, L.nz, L.n, L.sy, L.sz, L.base, L.nwg], i * 8))
      u.set([cur, nl, this.tail, desc.coarseSweeps, desc.historyCap, 0, 0, 0], MAX_LEVELS * 8)
    }
    device.queue.writeBuffer(this.buffers.params, 0, rec)
    // all labels SOLID (ghosts and coarse ghosts stay SOLID forever), unit face coefficients
    device.queue.writeBuffer(this.buffers.labels, 0, new Uint32Array(total).fill(LABEL_SOLID))
    this.writeUnitCoefficients()

    const vc = this.method === 'mgpcg' ? 6 * this.tail + 1 : 0
    this.dispatches = this.method === 'mgpcg'
      ? { prepare: 1 + 2 * (nl - 1), init: 2 + vc + 2, perIteration: 4 + vc + 2, finalize: 1, vcycle: vc }
      : { prepare: 1, init: 3, perIteration: 5, finalize: 1, vcycle: 0 }
  }

  static async create(device: GPUDevice, d: PoissonSolverDesc): Promise<PoissonSolver> {
    const desc: Required<PoissonSolverDesc> = {
      coarseSweeps: 60, tailMaxCells: 512, historyCap: 1024, label: `poisson-${d.method}-${d.nx}x${d.ny}x${d.nz}`, ...d,
    }
    if (desc.coarseSweeps < 1) throw new Error('coarseSweeps must be >= 1')
    const solveBGL = device.createBindGroupLayout({
      label: 'poisson:solveParams',
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    })
    const s = new PoissonSolver(device, desc, solveBGL)
    await s.buildPipelines()
    return s
  }

  private async buildPipelines() {
    const device = this.device
    const maxSB = device.limits.maxStorageBuffersPerShaderStage
    device.pushErrorScope('validation')
    const module = device.createShaderModule({ label: 'poisson.wgsl', code: POISSON_WGSL })
    const info = await module.getCompilationInfo()
    const errs = info.messages.filter(m => m.type === 'error')
    if (errs.length) throw new Error(`poisson.wgsl: ${errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')}`)
    await Promise.all(Object.entries(KERNELS).map(async ([name, k]) => {
      const nStorage = k.uses.filter(u => BIND[u].type !== 'uniform').length
      if (nStorage > maxSB) throw new Error(`kernel ${name} binds ${nStorage} storage buffers > device limit ${maxSB}`)
      const bgl = device.createBindGroupLayout({
        label: `poisson:${name}`,
        entries: k.uses.map(u => ({ binding: BIND[u].binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: BIND[u].type } })),
      })
      this.layouts.set(name, bgl)
      const layout = device.createPipelineLayout({ bindGroupLayouts: k.solveParams ? [bgl, this.solveBGL] : [bgl] })
      this.pipelines.set(name, await device.createComputePipelineAsync({ label: `poisson:${name}`, layout, compute: { module, entryPoint: name } }))
    }))
    const err = await device.popErrorScope()
    if (err) throw new Error(`PoissonSolver pipeline creation: ${err.message}`)
  }

  private bufferFor(u: BindName): GPUBuffer {
    const b = this.buffers
    switch (u) {
      case 'P': return b.params
      case 'st': return b.state
      case 'part': return b.partials
      case 'coef': return b.coef
      case 'lab': return b.labels
      case 'fcoef': return b.faceCoef
      case 'vx': return b.x
      case 'vd': return b.d
      case 'vq': return b.q
      case 'vb': return b.rhs
      case 'mb': return b.mgB
      case 'mua': return b.mgUA
      case 'mub': return b.mgUB
      case 'mres': return b.mgRes
      case 'hist': return b.history
      case 'nom': return b.nominal
      case 'flt': return b.faults
    }
  }

  private bindGroup(kernel: string, level: number): GPUBindGroup {
    const key = `${kernel}@${level}`
    let bg = this.bgCache.get(key)
    if (!bg) {
      bg = this.device.createBindGroup({
        label: `poisson:${key}`,
        layout: this.layouts.get(kernel)!,
        entries: KERNELS[kernel].uses.map(u => ({
          binding: BIND[u].binding,
          resource: u === 'P'
            ? { buffer: this.buffers.params, offset: level * PARAM_STRIDE, size: PARAM_STRIDE }
            : { buffer: this.bufferFor(u) },
        })),
      })
      this.bgCache.set(key, bg)
    }
    return bg
  }

  private dispatch(pass: GPUComputePassEncoder, kernel: string, level: number, groups: number, cfg?: SolveConfig) {
    pass.setPipeline(this.pipelines.get(kernel)!)
    pass.setBindGroup(0, this.bindGroup(kernel, level))
    if (KERNELS[kernel].solveParams) {
      if (!cfg) throw new Error(`kernel ${kernel} needs a SolveConfig`)
      pass.setBindGroup(1, cfg.bindGroup)
    }
    pass.dispatchWorkgroups(groups)
  }

  /** A static per-solve uniform (criterion, tolerance) + its bind group. Create once, reuse. */
  createSolveConfig(c: SolveConfigDesc): SolveConfig {
    const buffer = this.device.createBuffer({ label: `${this.desc.label}:solveParams`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const ab = new ArrayBuffer(16)
    new Float32Array(ab, 0, 1)[0] = c.tol
    new Uint32Array(ab, 4, 1)[0] = c.criterion === 'inf' ? 0 : 1
    this.device.queue.writeBuffer(buffer, 0, ab)
    const bindGroup = this.device.createBindGroup({ layout: this.solveBGL, entries: [{ binding: 0, resource: { buffer } }] })
    return { ...c, buffer, bindGroup }
  }

  // ── Convenience API (task spec names) ────────────────────────────────────────────────────────
  private cfgCache = new Map<string, SolveConfig>()

  /** CPU upload of a whole problem (padded level-0 arrays). faceCoef omitted = unit Laplacian. */
  setProblem(p: { labels: Uint8Array<ArrayBuffer> | Uint32Array<ArrayBuffer>; faceCoef?: Float32Array<ArrayBuffer>; rhs: Float32Array<ArrayBuffer> }) {
    this.writeLabels(p.labels)
    if (p.faceCoef) this.writeFaceCoefficients(p.faceCoef); else this.writeUnitCoefficients(1)
    this.writeRhs(p.rhs)
  }

  /**
   * Production-style solve: ||r||_inf <= tolInf at a fixed cap. `warmStart` has NO default: the
   * pressure solve warm-starts, the psi (density) solve must start cold (FINAL-PLAN §5.3).
   * The SolveConfig uniform is created once per (tol, cap) and cached, so repeated calls never
   * issue a queue.writeBuffer that would land before the whole submit.
   * Call encodePrepare() first whenever labels or coefficients changed.
   */
  solve(encoder: GPUCommandEncoder, o: { tolInf: number; cap: number; warmStart: boolean; timestampWrites?: GPUComputePassTimestampWrites }): number {
    if (typeof o.warmStart !== 'boolean') throw new Error('PoissonSolver.solve: warmStart must be given explicitly')
    const key = `inf|${o.tolInf}|${o.cap}`
    let cfg = this.cfgCache.get(key)
    if (!cfg) { cfg = this.createSolveConfig({ criterion: 'inf', tol: o.tolInf, cap: o.cap }); this.cfgCache.set(key, cfg) }
    return this.encodeSolve(encoder, cfg, { warmStart: o.warmStart, timestampWrites: o.timestampWrites })
  }

  // ── CPU uploads (tests / benches). Arrays are padded level-0 arrays (see header). ──────────
  get paddedCount(): number { return this.levels[0].padded }

  writeLabels(padded: Uint8Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) {
    if (padded.length !== this.paddedCount) throw new Error(`labels: ${padded.length} != ${this.paddedCount}`)
    const u = padded instanceof Uint32Array ? padded : Uint32Array.from(padded)
    this.device.queue.writeBuffer(this.buffers.labels, 0, u)
  }
  /** (a-x, a-y, a-z, extraDiag) per padded cell */
  writeFaceCoefficients(padded: Float32Array<ArrayBuffer>) {
    if (padded.length !== 4 * this.paddedCount) throw new Error('faceCoef length')
    this.device.queue.writeBuffer(this.buffers.faceCoef, 0, padded)
  }
  /** a_f = value on every face, no extra diagonal (unit Laplacian when value = 1) */
  writeUnitCoefficients(value = 1) {
    const f = new Float32Array(4 * this.paddedCount)
    for (let i = 0; i < this.paddedCount; i++) { f[4 * i] = value; f[4 * i + 1] = value; f[4 * i + 2] = value }
    this.device.queue.writeBuffer(this.buffers.faceCoef, 0, f)
  }
  writeRhs(padded: Float32Array<ArrayBuffer>) { this.writeVec(this.buffers.rhs, padded) }
  writeSolution(padded: Float32Array<ArrayBuffer>) { this.writeVec(this.buffers.x, padded) }
  /** unit tests: d (input of applyA) and r (input of applyPreconditioner) */
  writeD(padded: Float32Array<ArrayBuffer>) { this.writeVec(this.buffers.d, padded) }
  writeR(padded: Float32Array<ArrayBuffer>) { this.writeVec(this.buffers.mgB, padded) }
  private writeVec(buf: GPUBuffer, padded: Float32Array<ArrayBuffer>) {
    if (padded.length !== this.paddedCount) throw new Error(`vector: ${padded.length} != ${this.paddedCount}`)
    this.device.queue.writeBuffer(buf, 0, padded)
  }

  // ── Encoding ──────────────────────────────────────────────────────────────────────────────
  /** Level-0 operator and (MGPCG) the coarse labels/operators. One compute pass. */
  encodePrepare(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): number {
    const pass = encoder.beginComputePass({ label: `${this.desc.label}:prepare`, timestampWrites })
    const L = this.levels
    this.dispatch(pass, 'prep_fine', 0, L[0].nwg)
    let n = 1
    for (let l = 0; l + 1 < L.length; l++) {
      this.dispatch(pass, 'prep_labels', l, L[l + 1].nwg)
      this.dispatch(pass, 'prep_coef', l, L[l + 1].nwg)
      n += 2
    }
    pass.end()
    return n
  }

  private encodeVcycle(pass: GPUComputePassEncoder): number {
    const L = this.levels
    let n = 0
    for (let l = 0; l < this.tail; l++) {
      this.dispatch(pass, 'mg_presmooth', l, L[l].nwg)
      this.dispatch(pass, 'mg_residual', l, L[l].nwg)
      this.dispatch(pass, 'mg_restrict', l, L[l + 1].nwg)
      n += 3
    }
    this.dispatch(pass, 'mg_tail', 0, 1)
    n += 1
    for (let l = this.tail - 1; l >= 0; l--) {
      this.dispatch(pass, 'mg_prolong', l, L[l].nwg)
      this.dispatch(pass, 'mg_post_ba', l, L[l].nwg)
      this.dispatch(pass, 'mg_post_ab', l, L[l].nwg)
      n += 3
    }
    return n
  }

  /**
   * Encode one solve A x = b at the config's fixed cap: clears the state (and x unless warmStart),
   * then one compute pass of direct dispatches ending with the fault-counter kernel. Returns the
   * number of dispatches encoded.
   */
  encodeSolve(encoder: GPUCommandEncoder, cfg: SolveConfig, opts: { warmStart: boolean; timestampWrites?: GPUComputePassTimestampWrites }): number {
    encoder.clearBuffer(this.buffers.state)
    if (!opts.warmStart) encoder.clearBuffer(this.buffers.x)
    const pass = encoder.beginComputePass({ label: `${this.desc.label}:solve`, timestampWrites: opts.timestampWrites })
    const nwg = this.levels[0].nwg
    let n = 0
    if (this.method === 'jpcg') {
      this.dispatch(pass, 'cg_init_jacobi', 0, nwg)
      this.dispatch(pass, 'cg_init_reduce', 0, 1, cfg)
      this.dispatch(pass, 'cg_dupdate', 0, nwg)
      n += 3
      for (let k = 0; k < cfg.cap; k++) {
        this.dispatch(pass, 'cg_matvec', 0, nwg)
        this.dispatch(pass, 'cg_alpha', 0, 1)
        this.dispatch(pass, 'cg_update_jacobi', 0, nwg)
        this.dispatch(pass, 'cg_check_jacobi', 0, 1, cfg)
        this.dispatch(pass, 'cg_dupdate', 0, nwg)
        n += 5
      }
    } else {
      this.dispatch(pass, 'cg_init_mg', 0, nwg)
      this.dispatch(pass, 'cg_init_reduce', 0, 1, cfg)
      n += 2 + this.encodeVcycle(pass)
      this.dispatch(pass, 'cg_rz_init', 0, 1)
      this.dispatch(pass, 'cg_dupdate', 0, nwg)
      n += 2
      for (let k = 0; k < cfg.cap; k++) {
        this.dispatch(pass, 'cg_matvec', 0, nwg)
        this.dispatch(pass, 'cg_alpha', 0, 1)
        this.dispatch(pass, 'cg_update_mg', 0, nwg)
        this.dispatch(pass, 'cg_check_mg', 0, 1, cfg)
        n += 4 + this.encodeVcycle(pass)
        this.dispatch(pass, 'cg_beta', 0, 1)
        this.dispatch(pass, 'cg_dupdate', 0, nwg)
        n += 2
      }
    }
    this.dispatch(pass, 'cg_finalize', 0, 1)
    n += 1
    pass.end()
    return n
  }

  /** Zero the sticky fault counters (e.g. once per frame, after the frame's validity pass). */
  encodeClearFaults(encoder: GPUCommandEncoder) { encoder.clearBuffer(this.buffers.faults) }

  async readFaults(): Promise<SolveFaults> {
    const u = new Uint32Array(await this.readBuffer(this.buffers.faults, 0, 16))
    return { solves: u[0], capHits: u[1], breakdowns: u[2], maxIterations: u[3] }
  }

  /** Unit test: q = A d (d from writeD). Result via readVector('q'). */
  encodeApplyA(encoder: GPUCommandEncoder) {
    encoder.clearBuffer(this.buffers.state)
    const pass = encoder.beginComputePass({ label: `${this.desc.label}:applyA` })
    this.dispatch(pass, 'cg_matvec', 0, this.levels[0].nwg)
    pass.end()
  }

  /** Unit test: z = M r (r from writeR), one V-cycle. Result via readVector('z'). */
  encodeApplyPreconditioner(encoder: GPUCommandEncoder) {
    if (this.method !== 'mgpcg') throw new Error('applyPreconditioner: MGPCG only')
    encoder.clearBuffer(this.buffers.state)
    const pass = encoder.beginComputePass({ label: `${this.desc.label}:applyM` })
    this.encodeVcycle(pass)
    pass.end()
  }

  /** Timing: the single-workgroup tail kernel `reps` times in one pass (needs a prepared operator). */
  encodeTailOnly(encoder: GPUCommandEncoder, reps: number, timestampWrites?: GPUComputePassTimestampWrites) {
    encoder.clearBuffer(this.buffers.state)
    const pass = encoder.beginComputePass({ label: `${this.desc.label}:tail`, timestampWrites })
    for (let i = 0; i < reps; i++) this.dispatch(pass, 'mg_tail', 0, 1)
    pass.end()
  }

  /** Timing: one V-cycle `reps` times in one pass. */
  encodeVcycleOnly(encoder: GPUCommandEncoder, reps: number, timestampWrites?: GPUComputePassTimestampWrites) {
    encoder.clearBuffer(this.buffers.state)
    const pass = encoder.beginComputePass({ label: `${this.desc.label}:vcycle`, timestampWrites })
    for (let i = 0; i < reps; i++) this.encodeVcycle(pass)
    pass.end()
  }

  // ── Readback ──────────────────────────────────────────────────────────────────────────────
  private async readBuffer(src: GPUBuffer, offset: number, size: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const enc = this.device.createCommandEncoder()
    enc.copyBufferToBuffer(src, offset, staging, 0, size)
    this.device.queue.submit([enc.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = staging.getMappedRange().slice(0)
    staging.unmap()
    staging.destroy()
    return out
  }

  async readStats(withHistory = false): Promise<SolveStats> {
    const ab = await this.readBuffer(this.buffers.state, 0, STATE_BYTES)
    const f = new Float32Array(ab)
    const u = new Uint32Array(ab)
    const iterations = u[8]
    const b2 = f[6]
    const stats: SolveStats = {
      iterations, converged: u[9] === 1, breakdown: u[10] === 1,
      rInf: f[4], rInf0: f[7], rel2: b2 > 0 ? Math.sqrt(f[5]) / Math.sqrt(b2) : (f[5] === 0 ? 0 : Infinity), bNorm2: Math.sqrt(b2),
    }
    if (withHistory) {
      const n = Math.min(iterations + 1, this.desc.historyCap)
      const h = new Float32Array(await this.readBuffer(this.buffers.history, 0, Math.ceil(n * 8 / 4) * 4))
      stats.history = { rel2: [], inf: [] }
      for (let k = 0; k < n; k++) { stats.history.rel2.push(h[2 * k]); stats.history.inf.push(h[2 * k + 1]) }
    }
    return stats
  }

  /** Level-0 padded vector: x (solution), r (residual), z (M r), q (A d), d, coefDiag */
  async readVector(which: 'x' | 'r' | 'z' | 'q' | 'd' | 'diag'): Promise<Float32Array> {
    const p0 = this.paddedCount
    if (which === 'diag') {
      const c = new Float32Array(await this.readBuffer(this.buffers.coef, 0, p0 * 16))
      const out = new Float32Array(p0)
      for (let i = 0; i < p0; i++) out[i] = c[4 * i + 3]
      return out
    }
    const buf = which === 'x' ? this.buffers.x : which === 'r' ? this.buffers.mgB : which === 'z' ? this.buffers.mgUB
      : which === 'q' ? this.buffers.q : this.buffers.d
    return new Float32Array(await this.readBuffer(buf, 0, p0 * 4))
  }

  /** Labels of any level (padded, for tests of the coarsening). */
  async readLabels(level: number): Promise<Uint32Array> {
    const L = this.levels[level]
    return new Uint32Array(await this.readBuffer(this.buffers.labels, L.base * 4, L.padded * 4))
  }

  destroy() {
    for (const b of Object.values(this.buffers)) b.destroy()
    for (const c of this.cfgCache.values()) c.buffer.destroy()
    this.cfgCache.clear()
    this.bgCache.clear()
  }
}
