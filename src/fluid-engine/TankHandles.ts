// TankHandles — drag the tank's faces, edges and corners in the 3D view (owner request 2026-09-29; spec vault
// fluid/realism-2026-09/TANK-RESIZE-spec.md, step 4). World units: the grid edge is 1 wu (3.63 m), the tank spans
// [0, cells/64] per axis; the floor (−y) never moves.
//   face   — drags along its axis: the point on the axis line nearest the pointer ray;
//   edge   — drags in the plane of its two faces (the ray meets the plane through the edge);
//   corner — drags on the plane through the corner facing the camera.
// While dragging, a ghost outline shows the new size snapped to 8-cell steps (the multigrid's rule); on release the tank
// is rebuilt (FluidEngine.resizeTank). Moving a −x / −z face grows or shrinks the tank on that side: the grid still starts
// at 0, so the liquid is shifted by the change.
// The handles are a DOM / SVG overlay above the canvas, placed every frame from the camera (update()). Two reasons: the
// SSFR composite owns the canvas (the three.js scene is only drawn when SSFR fails, so meshes there are neither drawn nor
// pickable), and an overlay element gets its own pointer events, so a handle drag never reaches OrbitControls (on the
// canvas) or the page's click-to-spawn (a React handler on the container: the pointerdown stops at the handle).
import * as THREE from 'three'

type Side = { axis: 0 | 1 | 2; sign: 1 | -1 }
type Handle = { el: HTMLDivElement; sides: Side[]; kind: 'face' | 'edge' | 'corner'; pos: THREE.Vector3; shown: string }
export type Cells = [number, number, number]

const CELL = 1 / 64          // one grid cell, world units
const STEP = 8               // cells per step (TANK-RESIZE: the multigrid halves every axis)
const MIN_CELLS = 16, MAX_CELLS = 88
const COLORS = { face: '#00d0ff', edge: '#2f8fff', corner: '#ffffff', hover: '#ffaa00' } as const
const PX = { face: 12, edge: 9, corner: 11 } as const
const SVG_NS = 'http://www.w3.org/2000/svg'
/** The 12 edges of a box as corner-index pairs (corner k: x = k & 1, y = (k >> 1) & 1, z = (k >> 2) & 1). */
const BOX_EDGES: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]

export class TankHandles {
  private readonly handles: Handle[] = []
  private readonly overlay: HTMLDivElement
  private readonly ghostLines: SVGLineElement[] = []
  private readonly raycaster = new THREE.Raycaster()
  private cells: Cells = [64, 64, 64]
  private ghost: { lo: number[]; hi: number[] } | null = null
  private drag: { h: Handle; p0: THREE.Vector3; delta: Cells; pointerId: number } | null = null
  private busy = false

  private readonly camera: THREE.PerspectiveCamera
  private readonly container: HTMLElement
  private readonly controls: { enabled: boolean }
  private readonly commit: (cells: Cells, shiftM: Cells) => Promise<unknown>

  constructor(camera: THREE.PerspectiveCamera, container: HTMLElement, controls: { enabled: boolean }, commit: (cells: Cells, shiftM: Cells) => Promise<unknown>) {
    this.camera = camera; this.container = container; this.controls = controls; this.commit = commit
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    this.overlay = document.createElement('div')
    Object.assign(this.overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '5' })
    this.overlay.dataset.tankHandles = ''
    const svg = document.createElementNS(SVG_NS, 'svg')
    Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' })
    for (let k = 0; k < 12; k++) {
      const l = document.createElementNS(SVG_NS, 'line')
      l.setAttribute('stroke', COLORS.hover); l.setAttribute('stroke-width', '2'); l.setAttribute('stroke-dasharray', '6 4')
      l.style.display = 'none'
      svg.appendChild(l); this.ghostLines.push(l)
    }
    this.overlay.appendChild(svg)
    container.appendChild(this.overlay)

    const add = (kind: Handle['kind'], sides: Side[]) => {
      const el = document.createElement('div')
      Object.assign(el.style, {
        position: 'absolute', left: '0', top: '0', width: `${PX[kind]}px`, height: `${PX[kind]}px`,
        background: COLORS[kind], border: '1px solid rgba(0,0,0,0.6)', borderRadius: kind === 'corner' ? '50%' : '2px',
        pointerEvents: 'auto', cursor: 'grab', opacity: '0.9', touchAction: 'none', visibility: 'hidden',
      })
      const name = `${kind}:${sides.map(s => `${'xyz'[s.axis]}${s.sign > 0 ? '+' : '-'}`).join(',')}`
      el.dataset.tankHandle = name
      el.title = `drag to resize the tank (${name})`
      this.overlay.appendChild(el)
      const h: Handle = { el, sides, kind, pos: new THREE.Vector3(), shown: '' }
      el.addEventListener('pointerdown', e => this.onDown(e, h))
      el.addEventListener('click', e => e.stopPropagation())
      el.addEventListener('pointerenter', () => { if (!this.drag) el.style.background = COLORS.hover })
      el.addEventListener('pointerleave', () => { if (this.drag?.h !== h) el.style.background = COLORS[kind] })
      this.handles.push(h)
    }
    const axes = [0, 1, 2] as const
    // faces: every face but the floor
    for (const axis of axes) for (const sign of [1, -1] as const) if (!(axis === 1 && sign === -1)) add('face', [{ axis, sign }])
    // edges: the 12 edges, each where two faces meet (a floor side does not move)
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) for (const sa of [1, -1] as const) for (const sb of [1, -1] as const) {
      add('edge', [{ axis: a as 0 | 1 | 2, sign: sa }, { axis: b as 0 | 1 | 2, sign: sb }])
    }
    // corners
    for (const sx of [1, -1] as const) for (const sy of [1, -1] as const) for (const sz of [1, -1] as const) {
      add('corner', [{ axis: 0, sign: sx }, { axis: 1, sign: sy }, { axis: 2, sign: sz }])
    }
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('pointercancel', this.onCancel)
    this.setCells([64, 64, 64])
  }

  /** Movable sides of a handle: the floor (−y) never moves. */
  private movable(h: Handle): Side[] { return h.sides.filter(s => !(s.axis === 1 && s.sign === -1)) }

  /** Place the handles on a tank of `cells`. */
  setCells(cells: Cells) {
    this.cells = [...cells] as Cells
    const e = cells.map(c => c * CELL)
    for (const h of this.handles) {
      const p = e.map(v => v / 2)
      for (const s of h.sides) p[s.axis] = s.sign > 0 ? e[s.axis] : 0
      h.pos.set(p[0], p[1], p[2])
    }
  }

  /** A world point in container pixels; `visible` false behind the camera. */
  private toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().applyMatrix4(this.camera.matrixWorldInverse)
    const q = v.clone().applyMatrix4(this.camera.projectionMatrix)
    return { x: (q.x + 1) / 2 * this.container.clientWidth, y: (1 - q.y) / 2 * this.container.clientHeight, visible: v.z < -1e-3 }
  }

  /** Every frame, after the camera moved: the handles and the ghost outline on screen. Nearer handles stack above
   *  farther ones (z-index by view depth), so the handle under the cursor is the visible one. */
  update() {
    this.camera.updateMatrixWorld()
    const byDepth = this.handles.map(h => ({ h, z: -h.pos.clone().applyMatrix4(this.camera.matrixWorldInverse).z })).sort((a, b) => b.z - a.z)
    byDepth.forEach(({ h }, k) => { const zi = String(10 + k); if (h.el.style.zIndex !== zi) h.el.style.zIndex = zi })
    for (const h of this.handles) {
      const s = this.toScreen(h.pos)
      const px = PX[h.kind] / 2
      const shown = s.visible && !this.busy
        ? `translate(${(s.x - px).toFixed(1)}px, ${(s.y - px).toFixed(1)}px)${h.kind === 'edge' ? ' rotate(45deg)' : ''}`
        : 'hidden'
      if (shown === h.shown) continue
      h.shown = shown
      if (shown === 'hidden') h.el.style.visibility = 'hidden'
      else { h.el.style.visibility = 'visible'; h.el.style.transform = shown }
    }
    const g = this.ghost
    for (let k = 0; k < 12; k++) {
      const l = this.ghostLines[k]
      if (!g) { l.style.display = 'none'; continue }
      const corner = (i: number) => new THREE.Vector3(i & 1 ? g.hi[0] : g.lo[0], (i >> 1) & 1 ? g.hi[1] : g.lo[1], (i >> 2) & 1 ? g.hi[2] : g.lo[2])
      const pa = this.toScreen(corner(BOX_EDGES[k][0])), pb = this.toScreen(corner(BOX_EDGES[k][1]))
      l.style.display = pa.visible && pb.visible ? '' : 'none'
      l.setAttribute('x1', pa.x.toFixed(1)); l.setAttribute('y1', pa.y.toFixed(1)); l.setAttribute('x2', pb.x.toFixed(1)); l.setAttribute('y2', pb.y.toFixed(1))
    }
  }

  /** The new cells and the liquid's shift (metres, x/z) for a drag of `delta` cells per movable side. */
  private result(h: Handle, delta: Cells): { cells: Cells; shiftM: Cells } {
    const cells = [...this.cells] as Cells, shift: Cells = [0, 0, 0]
    for (const s of this.movable(h)) {
      const next = Math.min(MAX_CELLS, Math.max(MIN_CELLS, this.cells[s.axis] + delta[s.axis]))
      if (s.sign < 0) shift[s.axis] = (next - this.cells[s.axis]) * CELL * 3.63
      cells[s.axis] = next
    }
    return { cells, shiftM: shift }
  }

  private ray(e: PointerEvent) {
    const r = this.container.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.camera.updateMatrixWorld()
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster.ray
  }

  private onDown(e: PointerEvent, h: Handle) {
    if (e.button !== 0 || this.busy || this.drag) return
    e.stopPropagation(); e.preventDefault()
    // capture: the release arrives even outside the window
    try { h.el.setPointerCapture(e.pointerId) } catch { /* the pointer may already be gone */ }
    this.controls.enabled = false
    this.drag = { h, p0: h.pos.clone(), delta: [0, 0, 0], pointerId: e.pointerId }
    h.el.style.background = COLORS.hover
    h.el.style.cursor = 'grabbing'
  }

  /** End a drag without resizing (a cancelled pointer, or a move with no button held — a lost release). */
  private abort() {
    const d = this.drag
    if (!d) return
    this.drag = null
    this.ghost = null
    this.controls.enabled = true
    d.h.el.style.background = COLORS[d.h.kind]
    d.h.el.style.cursor = 'grab'
    this.update()
  }
  private onCancel = (e: PointerEvent) => { if (this.drag && e.pointerId === this.drag.pointerId) this.abort() }

  private onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return
    if ((e.buttons & 1) === 0) { this.abort(); return }
    const { h, p0 } = this.drag
    const ray = this.ray(e)
    const sides = this.movable(h)
    const d = ray.direction, o = ray.origin
    const move = new THREE.Vector3()
    if (sides.length === 1) {
      // the point on the axis line through p0 nearest the ray
      const u = new THREE.Vector3(); u.setComponent(sides[0].axis, 1)
      const w = p0.clone().sub(o), du = d.dot(u), den = 1 - du * du
      if (den < 1e-6) return
      move.copy(u).multiplyScalar((d.dot(w) * du - w.dot(u)) / den)
    } else {
      // an edge: the plane of its two faces; a corner: the plane facing the camera
      const n = new THREE.Vector3()
      if (sides.length === 2) n.setComponent(3 - sides[0].axis - sides[1].axis, 1)
      else this.camera.getWorldDirection(n)
      const dn = d.dot(n)
      if (Math.abs(dn) < 1e-6) return
      const s = p0.clone().sub(o).dot(n) / dn
      if (!(s > 0)) return
      move.copy(o).addScaledVector(d, s).sub(p0)
    }
    const delta: Cells = [0, 0, 0]
    for (const sd of sides) delta[sd.axis] = Math.round(sd.sign * move.getComponent(sd.axis) / CELL / STEP) * STEP
    this.drag.delta = delta
    // the ghost: the new tank in the current frame (a −face grows toward −axis)
    const { cells } = this.result(h, delta)
    const lo = [0, 0, 0], hi = this.cells.map(c => c * CELL)
    for (const sd of sides) {
      if (sd.sign > 0) hi[sd.axis] = cells[sd.axis] * CELL
      else lo[sd.axis] = -(cells[sd.axis] - this.cells[sd.axis]) * CELL
    }
    this.ghost = cells.some((c, a) => c !== this.cells[a]) ? { lo, hi } : null
    this.update()
  }

  private onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return
    const { h, delta } = this.drag
    this.drag = null
    this.ghost = null
    this.controls.enabled = true
    h.el.style.background = COLORS[h.kind]
    h.el.style.cursor = 'grab'
    const { cells, shiftM } = this.result(h, delta)
    if (cells.every((c, a) => c === this.cells[a])) { this.update(); return }
    this.busy = true
    this.update()
    void this.commit(cells, shiftM).finally(() => { this.busy = false })
  }

  /** Test hook: the screen position (client px) of a handle picked by kind and sides, e.g. ('face', [[0, 1]]). */
  screenOf(kind: Handle['kind'], sides: [number, number][]): { x: number; y: number } | null {
    const h = this.handles.find(k => k.kind === kind && k.sides.length === sides.length && sides.every(([a, s]) => k.sides.some(q => q.axis === a && q.sign === s)))
    if (!h) return null
    this.camera.updateMatrixWorld()
    const s = this.toScreen(h.pos), r = this.container.getBoundingClientRect()
    return { x: r.left + s.x, y: r.top + s.y }
  }

  dispose() {
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onCancel)
    this.overlay.remove()
  }
}
