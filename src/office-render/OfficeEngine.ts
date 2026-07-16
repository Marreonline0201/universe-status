// Imperative canvas engine for the pixel office. Lives outside React: the page
// mounts it once, feeds it protocol messages via apply(), and reads clicks back
// through onAgentClick. rAF loop + camera pan/zoom + pre-rendered tilemap.
import { TILE, makeTile, STATUS_COLORS } from './assets'
import { buildOfficeMap, type OfficeMapData } from './officeMap'
import { AgentSprite } from './AgentSprite'
import type { OfficeAgent, OfficeTeam, OfficeServerMsg } from '../hooks/useOfficeSocket'

interface Camera { x: number; y: number; scale: number }

// How often a *casual* chat is delivered in person (a walk across the office) rather than
// just a bubble. Handoffs & reviews always walk; everything else rolls against this. Kept
// low so the floor doesn't read as a constant swarm of people marching in straight lines.
const CASUAL_VISIT_CHANCE = 0.12

/** Short human phrase for a live tool/text event — the agent's thought cloud. */
function activityLabel(kind: 'tool_use' | 'text' | 'thinking' | 'turn_end', tool?: string, detail?: string): string | null {
  if (kind === 'text') return detail ? `“${detail}”` : null
  // Model reasoning: headless streams mark WHEN thinking happens (text is empty by
  // design on Opus) — show a 💭 so the sprite doesn't look frozen mid-thought.
  if (kind === 'thinking') return detail ? `💭 ${detail.slice(0, 40)}` : '💭 thinking…'
  if (kind !== 'tool_use' || !tool) return null
  const base = detail ? (detail.split(/[\\/]/).pop() ?? detail) : ''
  switch (tool) {
    case 'Read': return base ? `reads ${base}` : 'reads a file'
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return base ? `writes ${base}` : 'writes a file'
    case 'Grep':
    case 'Glob': return detail ? `searches ${detail.slice(0, 36)}` : 'searches the repo'
    case 'WebSearch': return detail ? `web: ${detail.slice(0, 38)}` : 'searches the web'
    case 'WebFetch': return base ? `browses ${base.slice(0, 36)}` : 'browses the web'
    case 'Task':
    case 'Agent': return detail ? `delegates: ${detail.slice(0, 34)}` : 'delegates to a subagent'
    default: return `uses ${tool}`
  }
}

export class OfficeEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private map: OfficeMapData | null = null
  private mapLayer: HTMLCanvasElement | null = null
  private sprites = new Map<string, AgentSprite>()
  private cam: Camera = { x: 0, y: 0, scale: 2 }
  private raf = 0
  private lastT = 0
  private dragging = false
  private dragStart = { x: 0, y: 0, camX: 0, camY: 0 }
  private moved = false
  private selected: string | null = null
  private offline = true
  private fontScale = 1
  private activeIds = new Set<string>() // agent ids with a live session (pool.active) → their team's room is lit
  private selectedTeams = new Set<string>() // owner-focused teams → override the auto working-spotlight
  onAgentClick: (id: string | null) => void = () => {}

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    canvas.addEventListener('mousedown', this.onDown)
    canvas.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.raf = requestAnimationFrame(this.tick)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('mousedown', this.onDown)
    this.canvas.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
  }

  /** (Re)build the world from a snapshot roster. */
  setWorld(teams: OfficeTeam[], agents: OfficeAgent[]) {
    this.map = buildOfficeMap(teams, agents)
    this.prerenderMap()
    this.sprites.clear()
    for (const a of agents) {
      const color = teams.find(t => t.id === a.team)?.color ?? '#ffd700'
      const sprite = new AgentSprite(a.id, a.name, a.team, a.role, color, this.map)
      sprite.setStatus(a.status)
      this.sprites.set(a.id, sprite)
    }
    this.fitCamera()
  }

  apply(msg: OfficeServerMsg) {
    switch (msg.type) {
      case 'OFFICE_SNAPSHOT':
        this.offline = false
        this.setWorld(msg.teams, msg.agents)
        this.activeIds = new Set(msg.pool.active)
        break
      case 'AGENT_STATUS':
        this.sprites.get(msg.id)?.setStatus(msg.status)
        break
      case 'POOL_STATE':
        this.activeIds = new Set(msg.pool.active)
        break
      case 'CHAT': {
        const from = this.sprites.get(msg.msg.from)
        const to = msg.msg.to ? this.sprites.get(msg.msg.to) : null
        if (from) {
          from.say(msg.msg.subject, msg.msg.kind)
          // handoffs & reviews are delivered in person — the visible communication
          if (to && (msg.msg.kind === 'handoff' || msg.msg.kind === 'review-comment' || Math.random() < CASUAL_VISIT_CHANCE)) {
            from.visit(to)
          }
        }
        break
      }
      case 'AGENT_ACTIVITY': {
        const label = activityLabel(msg.kind, msg.tool, msg.detail)
        if (label) this.sprites.get(msg.id)?.think(label)
        break
      }
      case 'OFFICE_SHUTDOWN':
        this.offline = true
        for (const s of this.sprites.values()) s.setStatus('offline')
        break
      default:
        break
    }
  }

  setOffline(offline: boolean) {
    this.offline = offline
    if (offline) for (const s of this.sprites.values()) s.setStatus('offline')
  }

  select(id: string | null) { this.selected = id }

  // ── input ────────────────────────────────────────────────────────────────
  private onDown = (e: MouseEvent) => {
    this.dragging = true
    this.moved = false
    this.dragStart = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y }
  }
  private onMove = (e: MouseEvent) => {
    if (!this.dragging) return
    const dx = e.clientX - this.dragStart.x, dy = e.clientY - this.dragStart.y
    if (Math.abs(dx) + Math.abs(dy) > 4) this.moved = true
    this.cam.x = this.dragStart.camX - dx / this.cam.scale
    this.cam.y = this.dragStart.camY - dy / this.cam.scale
  }
  private onUp = (e: MouseEvent) => {
    if (!this.dragging) return
    this.dragging = false
    if (this.moved) return
    // click → agent select
    const rect = this.canvas.getBoundingClientRect()
    const wx = (e.clientX - rect.left) / this.cam.scale + this.cam.x
    const wy = (e.clientY - rect.top) / this.cam.scale + this.cam.y
    let hit: string | null = null
    let best = Infinity
    for (const s of this.sprites.values()) {
      const sx = s.x * TILE + TILE / 2, sy = s.y * TILE + TILE / 2
      const d = Math.hypot(wx - sx, wy - sy)
      if (d < TILE * 1.2 && d < best) { best = d; hit = s.id }
    }
    this.selected = hit
    this.onAgentClick(hit)
  }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const before = { x: mx / this.cam.scale + this.cam.x, y: my / this.cam.scale + this.cam.y }
    const factor = e.deltaY < 0 ? 1.25 : 0.8
    // 0.6 floor: the 82-tile (1312px) world must fit on panels narrower than ~984px.
    this.cam.scale = Math.min(6, Math.max(0.6, this.cam.scale * factor))
    this.cam.x = before.x - mx / this.cam.scale
    this.cam.y = before.y - my / this.cam.scale
  }

  private fitCamera() {
    if (!this.map) return
    const w = this.canvas.width, h = this.canvas.height
    const worldW = this.map.width * TILE, worldH = this.map.height * TILE
    this.cam.scale = Math.max(0.6, Math.min(w / worldW, h / worldH) * 0.96)
    this.cam.x = (worldW - w / this.cam.scale) / 2
    this.cam.y = (worldH - h / this.cam.scale) / 2
  }

  resize(w: number, h: number) {
    this.canvas.width = w
    this.canvas.height = h
    if (this.map) this.fitCamera()
  }

  /** Global UI text scale (from SettingsProvider) — scales canvas labels + bubbles. */
  setFontScale(s: number) { this.fontScale = s }

  // ── rendering ────────────────────────────────────────────────────────────
  private prerenderMap() {
    if (!this.map) return
    const layer = document.createElement('canvas')
    layer.width = this.map.width * TILE
    layer.height = this.map.height * TILE
    const g = layer.getContext('2d')!
    g.imageSmoothingEnabled = false
    const cache = new Map<string, HTMLCanvasElement>()
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const kind = this.map.tiles[y][x]
        const checker = (x + y) % 2 === 0
        const teamColor = kind === 'zoneFloor' ? this.map.zoneColorAt(x, y) : undefined
        const key = `${kind}|${checker}|${teamColor ?? ''}`
        let tile = cache.get(key)
        if (!tile) { tile = makeTile(kind, { checker, teamColor }); cache.set(key, tile) }
        g.drawImage(tile, x * TILE, y * TILE)
      }
    }

    // ── baked decor passes ──────────────────────────────────────────────────
    // All position-DEPENDENT art (shadows, team accents, lamp glow, window
    // light) is painted here, once per snapshot, so makeTile stays position-
    // independent and its `kind|checker|teamColor` cache key stays valid.
    const map = this.map
    const kindAt = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < map.width && y < map.height ? map.tiles[y][x] : 'void'
    const WALL_LIKE = new Set<string>(['wall', 'whiteboard', 'windowWall', 'greenWall', 'glass', 'fridge'])
    const FLOOR_LIKE = new Set<string>(['floor', 'zoneFloor', 'corridor', 'rug', 'chair'])
    const FURNITURE = new Set<string>([
      'desk', 'meetTable', 'kitchenCounter', 'sink', 'coffee',
      'sofaW', 'sofaC', 'sofaE', 'armchair', 'loungeTable', 'plant', 'lamp',
    ])

    // A + B: drop shadows from walls (2-step) and furniture (contact) onto floor below
    for (let y = 0; y < map.height - 1; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!FLOOR_LIKE.has(kindAt(x, y + 1))) continue
        const k = kindAt(x, y)
        if (WALL_LIKE.has(k)) {
          g.fillStyle = 'rgba(20,12,4,0.30)'; g.fillRect(x * TILE, (y + 1) * TILE, TILE, 4)
          g.fillStyle = 'rgba(20,12,4,0.14)'; g.fillRect(x * TILE, (y + 1) * TILE + 4, TILE, 2)
        } else if (FURNITURE.has(k)) {
          g.fillStyle = 'rgba(20,12,4,0.18)'; g.fillRect(x * TILE, (y + 1) * TILE, TILE, 3)
        }
      }
    }

    // C: team accent strip along each room's corridor-side wall (doors skipped) —
    // team identity stays readable even when the room is dimmed.
    for (const z of map.zones) {
      const wallY = z.rect.y < 14 ? z.rect.y + z.rect.h : z.rect.y - 1
      g.globalAlpha = 0.55
      g.fillStyle = z.color
      for (let x = z.rect.x; x < z.rect.x + z.rect.w; x++) {
        if (x === z.rect.x + 7 || x === z.rect.x + 8) continue
        if (kindAt(x, wallY) !== 'wall') continue
        g.fillRect(x * TILE, wallY * TILE, TILE, 3)
      }
      g.globalAlpha = 1
    }

    // F: gold border around the lounge rug
    const rug = map.decor.rug
    g.strokeStyle = 'rgba(201,185,138,0.9)'
    g.lineWidth = 2
    g.strokeRect(rug.x * TILE + 3, rug.y * TILE + 3, rug.w * TILE - 6, rug.h * TILE - 6)

    // D: warm radial glow around each floor lamp
    for (const p of map.decor.lamps) {
      const cx = p.x * TILE + 8, cy = p.y * TILE + 5
      const grad = g.createRadialGradient(cx, cy, 2, cx, cy, 56)
      grad.addColorStop(0, 'rgba(255,205,120,0.30)')
      grad.addColorStop(1, 'rgba(255,205,120,0)')
      g.fillStyle = grad
      g.beginPath(); g.arc(cx, cy, 56, 0, Math.PI * 2); g.fill()
    }

    // E: daylight pools under the windows
    for (let x = 0; x < map.width; x++) {
      if (kindAt(x, 0) === 'windowWall') {
        const grad = g.createLinearGradient(0, TILE, 0, TILE + 40)
        grad.addColorStop(0, 'rgba(255,238,200,0.10)')
        grad.addColorStop(1, 'rgba(255,238,200,0)')
        g.fillStyle = grad
        g.fillRect(x * TILE, TILE, TILE, 40)
      }
      const by = map.height - 1
      if (kindAt(x, by) === 'windowWall') {
        const grad = g.createLinearGradient(0, by * TILE, 0, by * TILE - 40)
        grad.addColorStop(0, 'rgba(255,238,200,0.08)')
        grad.addColorStop(1, 'rgba(255,238,200,0)')
        g.fillStyle = grad
        g.fillRect(x * TILE, by * TILE - 40, TILE, 40)
      }
    }

    // G: cool ambiance wash inside the glass meeting room
    const gr = map.decor.glassRoom
    g.fillStyle = 'rgba(190,225,235,0.06)'
    g.fillRect((gr.x + 1) * TILE, (gr.y + 1) * TILE, (gr.w - 2) * TILE, (gr.h - 2) * TILE)

    this.mapLayer = layer
  }

  private tick = (t: number) => {
    const dt = Math.min(0.05, (t - this.lastT) / 1000 || 0.016)
    this.lastT = t
    for (const s of this.sprites.values()) s.update(dt, t)
    this.draw(t)
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Owner-focused teams (from the legend). Non-empty → these rooms are lit and all
      others dim, overriding the automatic working-spotlight. Empty → auto behavior. */
  setSelectedTeams(ids: string[]) { this.selectedTeams = new Set(ids) }

  /** A team's room is "lit" if any of its agents has a live session or a non-idle status. */
  private teamWorking(teamId: string): boolean {
    for (const s of this.sprites.values()) {
      if (s.team === teamId && (this.activeIds.has(s.id) || (s.status !== 'idle' && s.status !== 'offline'))) return true
    }
    return false
  }

  private draw(t: number) {
    const { ctx, canvas, cam } = this
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#05070f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!this.map || !this.mapLayer) return

    ctx.save()
    ctx.scale(cam.scale, cam.scale)
    ctx.translate(-cam.x, -cam.y)

    ctx.drawImage(this.mapLayer, 0, 0)

    // Spotlight the lit teams: dim the floor of every other room. Owner-focused teams
    // (the legend selection) win when present; otherwise fall back to the auto working-
    // spotlight (rooms with an active agent). Only dim when SOMETHING is lit — an idle,
    // unfocused office stays normally lit. Sprites draw later → stay bright; the commons
    // is not a zone → always lit.
    const litTeams = this.selectedTeams.size > 0
      ? this.selectedTeams
      : new Set(this.map.zones.filter(z => this.teamWorking(z.teamId)).map(z => z.teamId))
    if (litTeams.size > 0) {
      for (const z of this.map.zones) {
        const rx = z.rect.x * TILE, ry = z.rect.y * TILE, rw = z.rect.w * TILE, rh = z.rect.h * TILE
        // lit room: a soft warm wash (reads right on wood floors); others: a dusk veil —
        // dark enough to make the spotlight obvious, light enough that the luxury
        // interiors stay visible in resting rooms.
        ctx.fillStyle = litTeams.has(z.teamId) ? 'rgba(255,214,150,0.10)' : 'rgba(4,6,12,0.52)'
        ctx.fillRect(rx, ry, rw, rh)
      }
    }

    // zone labels on the floor
    ctx.font = `bold ${10 * this.fontScale}px "IBM Plex Mono", monospace`
    ctx.textAlign = 'left'
    for (const z of this.map.zones) {
      ctx.fillStyle = z.color + '99'
      ctx.fillText(z.name.toUpperCase(), (z.rect.x + 0.5) * TILE, (z.rect.y + 0.9) * TILE)
    }
    ctx.fillStyle = '#8a97b899'
    ctx.fillText('COMMONS', 61.5 * TILE, 18.9 * TILE)
    ctx.font = `${8 * this.fontScale}px "IBM Plex Mono", monospace`
    ctx.fillText('MEETING', 51 * TILE, 20.9 * TILE)
    ctx.fillText('KITCHEN', 73 * TILE, 20.5 * TILE)
    ctx.fillText('LOUNGE', 66.5 * TILE, 23.6 * TILE)

    // sprites, painter's order by y
    const sorted = [...this.sprites.values()].sort((a, b) => a.y - b.y)
    for (const s of sorted) {
      const frame = s.sheet.frames[s.frame()]
      const px = s.x * TILE, py = s.y * TILE - 6 // feet near tile bottom
      if (s.status !== 'offline') {
        // soft contact shadow under the sprite
        ctx.fillStyle = 'rgba(10,6,2,0.30)'
        ctx.beginPath()
        ctx.ellipse(Math.round(px) + 8, Math.round(py) + 15, 5, 2, 0, 0, Math.PI * 2)
        ctx.fill()
      }
      if (s.status === 'offline') ctx.globalAlpha = 0.25
      ctx.drawImage(frame, Math.round(px), Math.round(py))
      ctx.globalAlpha = 1
      // status light above the head — a glowing dot colored by status
      const lx = Math.round(px) + 8, ly = Math.round(py) - 2
      ctx.fillStyle = s.dotColor()
      ctx.globalAlpha = 0.35
      ctx.beginPath(); ctx.arc(lx, ly, 5.5, 0, Math.PI * 2); ctx.fill() // soft glow
      ctx.globalAlpha = 1
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill()   // core
      // selection ring
      if (s.id === this.selected) {
        ctx.strokeStyle = '#00d4ff'
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(px) - 1, Math.round(py) - 5, TILE + 2, TILE + 10)
      }
    }
    ctx.restore()

    // screen-space overlays (readable at any zoom): name of selected, bubbles
    for (const s of this.sprites.values()) {
      const sx = (s.x * TILE + TILE / 2 - cam.x) * cam.scale
      const sy = (s.y * TILE - 8 - cam.y) * cam.scale
      if (s.id === this.selected) {
        ctx.font = `${10 * this.fontScale}px "IBM Plex Mono", monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = '#00d4ff'
        ctx.fillText(`${s.name} · ${s.id}`, sx, sy - 18)
      }
      if (s.bubble) {
        const age = s.bubble.until - t
        const alpha = Math.min(1, age / 600)
        this.drawBubble(sx, sy - 6, s.bubble.text, s.bubble.kind, Math.max(0, alpha))
      }
    }

    if (this.offline) {
      ctx.fillStyle = 'rgba(5,7,15,0.55)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.font = `bold ${16 * this.fontScale}px "IBM Plex Mono", monospace`
      ctx.textAlign = 'center'
      ctx.fillStyle = '#ff4444'
      ctx.fillText('OFFICE OFFLINE — run `npm run office` locally', canvas.width / 2, canvas.height / 2)
    }
  }

  private drawBubble(x: number, y: number, text: string, kind: string, alpha: number) {
    const { ctx } = this
    const fs = this.fontScale
    const fpx = 16 * fs            // balloon font: 16px base (owner's floor) × global scale
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font = `${fpx}px "IBM Plex Mono", monospace`
    const pad = 12 * fs
    const w = Math.min(340 * fs, ctx.measureText(text).width + pad)
    const h = Math.round(fpx + 8 * fs)
    const bx = x - w / 2, by = y - h - 8
    ctx.fillStyle = 'rgba(8,12,24,0.92)'
    ctx.strokeStyle = (STATUS_COLORS.talking ?? '#00ff88') + 'aa'
    if (kind === 'review-comment') ctx.strokeStyle = '#ffd700aa'
    if (kind === 'handoff') ctx.strokeStyle = '#ff6b35aa'
    if (kind === 'activity') ctx.strokeStyle = '#4d9fff77'
    ctx.beginPath()
    ctx.roundRect(bx, by, w, h, (kind === 'activity' ? 8 : 4) * fs)
    ctx.fill()
    ctx.stroke()
    if (kind === 'activity') {
      // thought-cloud tail: shrinking circles
      for (const [r, oy] of [[2.5, 3], [1.5, 8]] as const) {
        ctx.beginPath()
        ctx.arc(x, by + h + oy * fs, r * fs, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    } else {
      // speech tail
      ctx.beginPath()
      ctx.moveTo(x - 3 * fs, by + h); ctx.lineTo(x + 3 * fs, by + h); ctx.lineTo(x, by + h + 5 * fs)
      ctx.closePath(); ctx.fill()
    }
    ctx.fillStyle = kind === 'activity' ? '#a9c1e8' : '#cfe3ff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, by + h / 2, w - pad)
    ctx.restore()
  }
}
