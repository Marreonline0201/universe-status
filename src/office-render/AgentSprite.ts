// Per-agent visual state machine: sitting, typing, walking (BFS paths), talking.
// Protocol statuses drive *goals*; this class turns them into movement + animation.
import { characterSheet, STATUS_COLORS, type CharacterSheet, type CharFrame } from './assets'
import { findPath, naturalizePath, type Point } from './pathfind'
import type { AgentVisualStatus } from '../hooks/useOfficeSocket'
import type { OfficeMapData } from './officeMap'

const WALK_SPEED = 3.2 // tiles per second
const BUBBLE_MS = 4200
// Idle "coffee stroll" pacing. Rare on purpose — with 50 agents, a short interval means
// someone is always walking and the office looks like a swarm. min + up-to-jitter seconds
// between an idle agent's strolls; raise these two to make the floor calmer still.
const WANDER_MIN_S = 120
const WANDER_JITTER_S = 150

export interface Bubble { text: string; until: number; kind: string }

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export class AgentSprite {
  x: number // tile coords, float while moving
  y: number
  status: AgentVisualStatus = 'offline'
  bubble: Bubble | null = null
  sheet: CharacterSheet
  private path: Point[] = []
  private dir: 'D' | 'U' | 'L' | 'R' = 'D'
  private animT = 0
  private wanderT: number
  private returnHome = false
  private speed: number // per-agent pace (tiles/s) — small spread so nobody marches in lockstep
  /** where this agent belongs when not doing anything special */
  home: Point

  id: string
  name: string
  team: string
  role: string
  private map: OfficeMapData

  constructor(id: string, name: string, team: string, role: string, teamColor: string, map: OfficeMapData) {
    this.id = id
    this.name = name
    this.team = team
    this.role = role
    this.map = map
    this.sheet = characterSheet(hashCode(id), teamColor)
    const spot = map.desks.get(id)
    this.home = spot ? spot.chair : map.lobby
    this.x = this.home.x
    this.y = this.home.y
    // First stroll is pushed well out (and spread per-agent) so the office doesn't swarm on load.
    this.wanderT = 45 + (hashCode(id) % 90)
    this.speed = WALK_SPEED * (0.82 + (hashCode(id + 'spd') % 37) / 100) // ~0.82×–1.18× base
  }

  get tile(): Point { return { x: Math.round(this.x), y: Math.round(this.y) } }
  get moving(): boolean { return this.path.length > 0 }
  get atHome(): boolean { return !this.moving && this.tile.x === this.home.x && this.tile.y === this.home.y }

  setStatus(status: AgentVisualStatus) {
    this.status = status
    // Any live work pulls the agent back to their desk.
    if (status !== 'idle' && status !== 'offline' && status !== 'talking' && !this.atHome) {
      this.goTo(this.home)
      this.returnHome = false
    }
  }

  say(text: string, kind: string) {
    this.bubble = { text: text.length > 44 ? text.slice(0, 43) + '…' : text, until: performance.now() + BUBBLE_MS, kind }
  }

  /** Live-work thought cloud ("reads structure.md", a said sentence…).
      Never steals the stage from a fresh mail bubble. */
  think(text: string) {
    const now = performance.now()
    if (this.bubble && this.bubble.kind !== 'activity' && now < this.bubble.until) return
    this.bubble = { text: text.length > 44 ? text.slice(0, 43) + '…' : text, until: now + 3200, kind: 'activity' }
  }

  /** Walk to another agent (stand next to their tile), then wander home. */
  visit(target: AgentSprite) {
    const t = target.tile
    const stand = [
      { x: t.x, y: t.y + 1 }, { x: t.x, y: t.y - 1 },
      { x: t.x - 1, y: t.y }, { x: t.x + 1, y: t.y },
    ].find(pt => this.map.walkable(pt.x, pt.y))
    if (stand) {
      this.goTo(stand)
      this.returnHome = true
    }
  }

  goTo(dest: Point) {
    const from = this.tile
    this.x = from.x; this.y = from.y
    const raw = findPath(this.map.walkable, this.map.width, this.map.height, from, dest)
    this.path = naturalizePath(this.map.walkable, from, raw)
  }

  update(dt: number, now: number) {
    this.animT += dt
    if (this.bubble && now > this.bubble.until) this.bubble = null

    if (this.path.length > 0) {
      const next = this.path[0]
      const dx = next.x - this.x, dy = next.y - this.y
      const dist = Math.hypot(dx, dy)
      const step = this.speed * dt
      this.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U')
      if (dist <= step) {
        this.x = next.x; this.y = next.y
        this.path.shift()
        if (this.path.length === 0 && this.returnHome) {
          // pause a moment at the visit target, then head home
          this.returnHome = false
          setTimeout(() => { if (!this.moving) this.goTo(this.home) }, 1600 + (hashCode(this.id) % 1000))
        }
      } else {
        this.x += (dx / dist) * step
        this.y += (dy / dist) * step
      }
      return
    }

    // Idle flavor: rarely stroll to the coffee machine and back.
    if (this.status === 'idle' && this.atHome) {
      this.wanderT -= dt
      if (this.wanderT <= 0) {
        this.wanderT = WANDER_MIN_S + (hashCode(this.id + String(now | 0)) % WANDER_JITTER_S)
        const c = this.map.coffee
        const stand = { x: c.x, y: c.y + 1 }
        if (this.map.walkable(stand.x, stand.y)) {
          this.goTo(stand)
          this.returnHome = true
        }
      }
    }
  }

  frame(): CharFrame {
    if (this.moving) {
      const f = Math.floor(this.animT * 6) % 2
      return `walk${this.dir}${f}` as CharFrame
    }
    const seated = this.atHome && this.map.desks.get(this.id)
    switch (this.status) {
      case 'typing':
      case 'working':
      case 'reviewing':
        return seated ? (Math.floor(this.animT * 4) % 2 === 0 ? 'type0' : 'type1') : 'stand'
      case 'reading':
        return seated ? 'sit' : 'stand'
      case 'idle':
      case 'offline':
        return seated ? 'sit' : 'stand'
      default:
        return seated ? 'sit' : 'stand'
    }
  }

  dotColor(): string {
    return STATUS_COLORS[this.status] ?? STATUS_COLORS.idle
  }
}
