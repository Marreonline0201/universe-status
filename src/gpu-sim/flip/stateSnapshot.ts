/// <reference types="@webgpu/types" />
// stateSnapshot.ts — bench only: the same-state fork of a running FlipGpuSimulator (the B1c forked drift-form study,
// spec rev 3 §2 and §9, sha256 a3290c54…). take() copies every carried state (FlipGpuSimulator.namedBuffers: the
// particles, the drift memory, the pressure warm start) into bench-owned GPU buffers with copyBufferToBuffer — one
// command buffer, one submit; restore() copies them back into the very buffers they came from, in place, the same way.
// Never through FlipBackend.resize or setParticles: a resize rebuilds the solver (the viscous PCG cap back to its
// maximum), re-derives ρ from f32 masses, re-pins wall-contact positions and recomputes v_lag; setParticles clears the
// drift memory. The two host values lagged readbacks set (v_lag, the viscous cap) are FlipBackend's (benchSnapshotState /
// benchRestoreState, each after a drain). `omit` (§9 G-R2's must-fail controls): an omitted item is not copied — at
// take() it is not saved, at restore() it keeps its live value. Nothing here runs unless a bench calls it: no frame
// encodes, allocates or reads anything for it.
import type { FlipGpuSimulator, FlipStateName } from './FlipGpuSimulator'

/** The simulator surface a snapshot uses (a FlipGpuSimulator; a stand-in in CPU tests). */
export type SnapshotSource = Pick<FlipGpuSimulator, 'device' | 'particleCount' | 'namedBuffers'>
/** One saved state and the bytes that hold it. */
export interface SnapshotItem { name: FlipStateName; bytes: number }
/** Every name `omit` may list. The literal is checked against FlipStateName at compile time (each name, and only those);
 *  any other name throws — a misspelt omit must not silently copy everything. */
export const SNAPSHOT_ITEM_NAMES: readonly FlipStateName[] = Object.keys({
  pos: 1, vel: 1, aff: 1, aux: 1, slipState: 1, pressureX: 1,
} satisfies Record<FlipStateName, 1>) as FlipStateName[]

type Saved = { name: FlipStateName; live: GPUBuffer; copy: GPUBuffer; bytes: number }

function omitted(omit: readonly string[] | undefined, what: string): Set<FlipStateName> {
  const bad = (omit ?? []).filter(k => !(SNAPSHOT_ITEM_NAMES as readonly string[]).includes(k))
  if (bad.length) throw new Error(`${what}: omit ${bad.join(', ')} is not a carried state (${SNAPSHOT_ITEM_NAMES.join(', ')})`)
  return new Set((omit ?? []) as readonly FlipStateName[])
}

/** `record` inside out-of-memory and validation error scopes: anything it threw or the device raised throws here, after
 *  `cleanup` (the scopes are popped either way, so the device's scope stack stays balanced). */
async function scoped(device: GPUDevice, what: string, record: () => void, cleanup: () => void = () => {}): Promise<void> {
  device.pushErrorScope('out-of-memory')
  device.pushErrorScope('validation')
  let thrown: unknown = null
  try { record() } catch (e) { thrown = e ?? new Error(`${what}: threw ${String(e)}`) }
  const validation = device.popErrorScope(), oom = device.popErrorScope()
  const errs = [await validation, await oom].filter((e): e is GPUError => e !== null)
  if (thrown !== null || errs.length) {
    cleanup()
    throw thrown ?? new Error(`${what}: ${errs.map(e => e.message).join(' | ')}`)
  }
}

export class FlipStateSnapshot {
  /** The simulator the state came from: restore() writes into no other. */
  readonly sim: SnapshotSource
  /** Its particle count at take(): restore() refuses another (the index order would no longer be the snapshot's). */
  readonly count: number
  /** What was saved, each with its bytes (an item omitted at take() is absent). */
  readonly items: readonly SnapshotItem[]
  private readonly saved: Saved[]
  private disposed = false

  private constructor(sim: SnapshotSource, count: number, saved: Saved[]) {
    this.sim = sim
    this.count = count
    this.saved = saved
    this.items = saved.map(s => ({ name: s.name, bytes: s.bytes }))
  }

  /** Copy every carried state of `sim` (less `omit`) into new bench-owned buffers: one command buffer, one submit, queued
   *  after every frame already submitted. Refused for an empty tank (no state to fork). */
  static async take(sim: SnapshotSource, opts: { omit?: readonly string[] } = {}): Promise<FlipStateSnapshot> {
    const skip = omitted(opts.omit, 'snapshot')
    const count = sim.particleCount
    if (!(count > 0)) throw new Error('snapshot: the tank holds no particles — no state to fork')
    const d = sim.device, saved: Saved[] = []
    const live = sim.namedBuffers().filter(b => !skip.has(b.name))
    await scoped(d, 'snapshot', () => {
      for (const b of live) {
        const copy = d.createBuffer({ label: `bench.snapshot.${b.name}`, size: b.bytes, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
        saved.push({ name: b.name, live: b.buffer, copy, bytes: b.bytes })
      }
      const e = d.createCommandEncoder({ label: 'bench.snapshot' })
      for (const s of saved) e.copyBufferToBuffer(s.live, 0, s.copy, 0, s.bytes)
      d.queue.submit([e.finish()])
    }, () => { for (const s of saved) s.copy.destroy() })
    return new FlipStateSnapshot(sim, count, saved)
  }

  /** Copy the saved state back into the buffers it came from, in place (less `omit`: that item keeps its live value):
   *  one command buffer, one submit. Refused after dispose(), for another particle count, and when a carried buffer is no
   *  longer the one the snapshot came from (a rebuilt simulator). `kept`: the items left at their live value. */
  async restore(opts: { omit?: readonly string[] } = {}): Promise<{ restored: SnapshotItem[]; kept: FlipStateName[] }> {
    if (this.disposed) throw new Error('restore: the snapshot was disposed')
    const skip = omitted(opts.omit, 'restore')
    const sim = this.sim, d = sim.device
    if (sim.particleCount !== this.count) throw new Error(`restore: the tank holds ${sim.particleCount} particles, the snapshot ${this.count} — the index order is not the snapshot's`)
    const live = new Map(sim.namedBuffers().map(b => [b.name, b]))
    for (const s of this.saved) {
      const b = live.get(s.name)
      if (!b || b.buffer !== s.live || b.bytes !== s.bytes) throw new Error(`restore: ${s.name} is not the buffer the snapshot came from (a rebuilt simulator?)`)
    }
    const todo = this.saved.filter(s => !skip.has(s.name))
    await scoped(d, 'restore', () => {
      const e = d.createCommandEncoder({ label: 'bench.restore' })
      for (const s of todo) e.copyBufferToBuffer(s.copy, 0, s.live, 0, s.bytes)
      d.queue.submit([e.finish()])
    })
    return { restored: todo.map(s => ({ name: s.name, bytes: s.bytes })), kept: this.saved.filter(s => skip.has(s.name)).map(s => s.name) }
  }

  /** Free the bench-owned buffers (restore() refuses afterwards). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const s of this.saved) s.copy.destroy()
  }
}
