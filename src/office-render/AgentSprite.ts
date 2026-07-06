// Per-agent visual state machine: sitting, typing, walking (BFS paths), talking.
// Protocol statuses drive *goals*; this class turns them into movement + animation.
import { characterSheet, STATUS_COLORS, type CharacterSheet, type CharFrame } from './assets'
import { findPath, type Point } from './pathfind'
import type { AgentVisualStatus } from '../hooks/useOfficeSocket'
import type { OfficeMapData } from './officeMap'

const WALK_SPEED = 3.2 // tiles per second
const BUBBLE_MS = 4200

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
    this.wanderT = 8 + (hashCode(id) % 20)
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
    this.bubble = { text: text.length > 48 ? text.slice(0, 47) + '…' : text, until: performance.now() + BUBBLE_MS, kind }
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
    this.path = findPath(this.map.walkable, this.map.width, this.map.height, from, dest)
  }

  update(dt: number, now: number) {
    this.animT += dt
    if (this.bubble && now > this.bubble.until) this.bubble = null

    if (this.path.length > 0) {
      const next = this.path[0]
      const dx = next.x - this.x, dy = next.y - this.y
      const dist = Math.hypot(dx, dy)
      const step = WALK_SPEED * dt
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

    // Idle flavor: occasionally stroll to the coffee machine and back.
    if (this.status === 'idle' && this.atHome) {
      this.wanderT -= dt
      if (this.wanderT <= 0) {
        this.wanderT = 25 + (hashCode(this.id + String(now | 0)) % 40)
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
