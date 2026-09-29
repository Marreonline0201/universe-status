// ══════════════════════════════════════════════════════════════════════════════
// FluidScene — Renders MLS-MPM particles in the Three.js scene
//
// Particles render as THREE.Points sharing the scene's depth buffer with
// all other objects (ball, box, terrain). Depth ordering is correct.
//
// Current state: particles are visible dots. Smooth surface rendering (SSFR)
// requires proper Three.js TSL documentation and testing — deferred until
// the TSL API can be verified reliably.
//
// Architecture: structure.md §3.2 "SSFR Integration Architecture"
// ══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three'

const MAX_PARTICLES = 1_000_000
const FLOATS_PER_PARTICLE = 20
/** Staging buffers in flight: while one maps, the next frame's copy goes to another (s1-render R2: with ONE buffer,
 *  every frame that found it still mapping skipped its readback — 37–42 of ~100 frames completed). */
const STAGING_RING = 2
/** Packs each particle's position (the first 3 of its 20 floats) into a vec4 — 16 B per particle instead of 80. */
const PACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> count: vec4<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= count.x) { return; }
  let b = g.x * ${FLOATS_PER_PARTICLE}u;
  dst[g.x] = vec4<f32>(src[b], src[b + 1u], src[b + 2u], 1.0);
}`

export class FluidScene {
  private points: THREE.Points | null = null
  private positionAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null
  private scene: THREE.Scene
  private device: GPUDevice | null = null
  private packPipeline: GPUComputePipeline | null = null
  private packedBuffer: GPUBuffer | null = null
  private countBuffer: GPUBuffer | null = null
  private packGroups = new WeakMap<GPUBuffer, GPUBindGroup>()
  private staging: { buf: GPUBuffer; pending: boolean }[] = []
  /** The staging slot scheduleReadback filled for the next startReadback (−1: none), and its particle count. */
  private scheduled = -1
  private scheduledN = 0
  /** Readbacks are applied in order: a map that resolves after a newer one has been applied is dropped. */
  private seqIssued = 0
  private seqApplied = 0
  /** Readbacks whose positions actually reached the Points geometry (for the bench). */
  completedReadbacks = 0

  // Public — checked by FluidTest.tsx render loop
  renderPipeline: any = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  init(device: GPUDevice) {
    this.device = device

    this.packPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: PACK_WGSL }), entryPoint: 'main' } })
    this.packedBuffer = device.createBuffer({ size: MAX_PARTICLES * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    this.countBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.staging = Array.from({ length: STAGING_RING }, () => ({
      buf: device.createBuffer({ size: MAX_PARTICLES * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      pending: false,
    }))

    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(MAX_PARTICLES * 3)
    const colors = new Float32Array(MAX_PARTICLES * 3)

    this.positionAttr = new THREE.BufferAttribute(positions, 3)
    this.positionAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.positionAttr)

    this.colorAttr = new THREE.BufferAttribute(colors, 3)
    this.colorAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('color', this.colorAttr)

    geo.setDrawRange(0, 0)

    const mat = new THREE.PointsMaterial({
      size: 0.03,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: true,
      depthTest: true,
    })

    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  // No-op — SSFR pipeline deferred
  async initPostProcessing(_renderer: any, _camera: THREE.PerspectiveCamera) {}

  /** Pack the positions and copy them to a free staging buffer (none free: this frame is skipped). The caller submits
   *  `encoder`, then calls startReadback. */
  scheduleReadback(encoder: GPUCommandEncoder, particleBuffer: GPUBuffer, count: number) {
    this.scheduled = -1
    if (!this.device || !this.packPipeline || !this.packedBuffer || !this.countBuffer) return
    const slot = this.staging.findIndex(s => !s.pending)
    if (slot < 0) return
    const n = Math.min(count, MAX_PARTICLES)
    if (n === 0) return
    let group = this.packGroups.get(particleBuffer)
    if (!group) {
      group = this.device.createBindGroup({ layout: this.packPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: particleBuffer } }, { binding: 1, resource: { buffer: this.packedBuffer } },
        { binding: 2, resource: { buffer: this.countBuffer } }] })
      this.packGroups.set(particleBuffer, group)
    }
    this.device.queue.writeBuffer(this.countBuffer, 0, new Uint32Array([n, 0, 0, 0]))
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.packPipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(n / 256))
    pass.end()
    encoder.copyBufferToBuffer(this.packedBuffer, 0, this.staging[slot].buf, 0, n * 16)
    this.scheduled = slot
    this.scheduledN = n
  }

  startReadback(_count: number) {
    if (!this.points || !this.positionAttr || !this.colorAttr) return
    const slot = this.scheduled
    if (slot < 0) return
    this.scheduled = -1
    const st = this.staging[slot], n = this.scheduledN, seq = ++this.seqIssued
    st.pending = true
    const posAttr = this.positionAttr, colAttr = this.colorAttr, geo = this.points.geometry

    st.buf.mapAsync(GPUMapMode.READ, 0, n * 16).then(() => {
      if (seq > this.seqApplied) {
        this.seqApplied = seq
        const data = new Float32Array(st.buf.getMappedRange(0, n * 16))
        const positions = posAttr.array as Float32Array
        const colors = colAttr.array as Float32Array
        for (let i = 0; i < n; i++) {
          positions[3 * i] = data[4 * i]
          positions[3 * i + 1] = data[4 * i + 1]
          positions[3 * i + 2] = data[4 * i + 2]
          // Light blue-white (transparent water)
          colors[3 * i] = 0.7
          colors[3 * i + 1] = 0.8
          colors[3 * i + 2] = 0.95
        }
        posAttr.needsUpdate = true
        colAttr.needsUpdate = true
        geo.setDrawRange(0, n)
        this.completedReadbacks++
      }
      st.buf.unmap()
      st.pending = false
    }).catch(() => {
      st.pending = false
    })
  }

  /** Draw nothing (the scene holds no particles): avoids stale "ghost" points from the last readback. */
  clear() {
    this.points?.geometry.setDrawRange(0, 0)
  }

  dispose() {
    if (this.points) {
      this.scene.remove(this.points)
      this.points.geometry.dispose()
      ;(this.points.material as THREE.Material).dispose()
      this.points = null
    }
    for (const st of this.staging) st.buf.destroy()
    this.staging = []
    this.packedBuffer?.destroy()
    this.packedBuffer = null
    this.countBuffer?.destroy()
    this.countBuffer = null
    this.positionAttr = null
    this.colorAttr = null
  }
}
