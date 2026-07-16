// Per-agent visual state machine: sitting, typing, walking (BFS paths), talking.
// Protocol statuses drive *goals*; this class turns them into movement + animation.
//
// No-overlap invariant: every sprite exclusively owns the cell it occupies (and,
// mid-step, the cell it is entering) via the shared Occupancy map. A walker that
// can't claim its next cell WAITS in place; if the blockage persists it re-paths
// around currently occupied cells. Stand spots (visits, coffee) are chosen from
// unoccupied candidates up front, so queues form instead of pile-ups.
import { characterSheet, STATUS_COLORS, type CharacterSheet, type CharFrame } from './assets'
import { findPath, naturalizePath, type Point } from './pathfind'
import { Occupancy, nearestFreeCell } from './occupancy'
import type { AgentVisualStatus } from '../hooks/useOfficeSocket'
import type { OfficeMapData } from './officeMap'

const WALK_SPEED = 3.2 // tiles per second
const BUBBLE_MS = 4200
// Idle "coffee stroll" pacing. Rare on purpose — with 50 agents, a short interval means
// someone is always walking and the office looks like a swarm. min + up-to-jitter seconds
// between an idle agent's strolls; raise these two to make the floor calmer still.
const WANDER_MIN_S = 120
const WANDER_JITTER_S = 150
// How long a blocked walker waits before re-pathing around the obstruction.
// Staggered per agent so two head-on walkers don't re-path in the same frame.
const BLOCK_REPATH_S = 1.2

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
  private dest: Point | null = null
  private dir: 'D' | 'U' | 'L' | 'R' = 'D'
  private animT = 0
  private wanderT: number
  private returnHome = false
  private speed: number // per-agent pace (tiles/s) — small spread so nobody marches in lockstep
  private occ: Occupancy
  private heldPrev: Point | null = null // trailing cell kept until the body clears it
  private blockedT = 0
  private repathAfter: number
  /** true while movement is stalled behind another agent (draw a standing frame) */
  waiting = false
  /** where this agent belongs when not doing anything special */
  home: Point

  id: string
  name: string
  team: string
  role: string
  private map: OfficeMapData

  constructor(id: string, name: string, team: string, role: string, teamColor: string, map: OfficeMapData, occ: Occupancy) {
    this.id = id
    this.name = name
    this.team = team
    this.role = role
    this.map = map
    this.occ = occ
    this.sheet = characterSheet(hashCode(id), teamColor)
    const spot = map.desks.get(id)
    this.home = spot ? spot.chair : map.lobby
    // Claim the spawn cell; if someone already holds it (shared lobby), shift
    // to the nearest free cell so nobody materializes inside a colleague.
    const spawn = nearestFreeCell(map.walkable, occ, this.home, id)
    this.occ.claim(spawn.x, spawn.y, id)
    this.x = spawn.x
    this.y = spawn.y
    // First stroll is pushed well out (and spread per-agent) so the office doesn't swarm on load.
    this.wanderT = 45 + (hashCode(id) % 90)
    this.speed = WALK_SPEED * (0.82 + (hashCode(id + 'spd') % 37) / 100) // ~0.82×–1.18× base
    this.repathAfter = BLOCK_REPATH_S + (hashCode(id + 'blk') % 100) / 100 // 1.2–2.2 s stagger
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

  /** Walk to another agent (stand next to their tile), then wander home.
      Picks an UNOCCUPIED adjacent cell so two visitors queue instead of stacking. */
  visit(target: AgentSprite) {
    const t = target.tile
    const stand = [
      { x: t.x, y: t.y + 1 }, { x: t.x, y: t.y - 1 },
      { x: t.x - 1, y: t.y }, { x: t.x + 1, y: t.y },
      { x: t.x - 1, y: t.y + 1 }, { x: t.x + 1, y: t.y + 1 },
    ].find(pt => this.map.walkable(pt.x, pt.y) && this.occ.isFree(pt.x, pt.y, this.id))
    if (stand) {
      this.goTo(stand)
      this.returnHome = true
    }
  }

  goTo(dest: Point) {
    const from = this.tile
    this.x = from.x; this.y = from.y
    if (this.heldPrev) { // a mid-walk redirect snaps us into the current cell
      this.occ.release(this.heldPrev.x, this.heldPrev.y, this.id)
      this.heldPrev = null
    }
    this.dest = dest
    const raw = findPath(this.map.walkable, this.map.width, this.map.height, from, dest)
    this.path = naturalizePath(this.map.walkable, from, raw)
    this.blockedT = 0
    this.waiting = false
  }

  /** Re-plan to the same destination treating currently held cells (except ours
      and the destination itself) as solid — walks around a stopped colleague. */
  private rePathAroundOccupied() {
    const dest = this.dest
    if (!dest) { this.path = []; return }
    const from = this.tile
    // Destination itself taken and we're already beside it → this is as close
    // as anyone can get. Treat it as arrived (prevents a wait/re-path loop).
    if (!this.occ.isFree(dest.x, dest.y, this.id)
      && Math.max(Math.abs(from.x - dest.x), Math.abs(from.y - dest.y)) <= 1) {
      this.path = []
      this.waiting = false
      if (this.returnHome) {
        this.returnHome = false
        setTimeout(() => { if (!this.moving) this.goTo(this.home) }, 1600 + (hashCode(this.id) % 1000))
      }
      return
    }
    const clear = (x: number, y: number) =>
      this.map.walkable(x, y) &&
      (this.occ.isFree(x, y, this.id) || (x === dest.x && y === dest.y))
    const raw = findPath(clear, this.map.width, this.map.height, from, dest)
    if (raw.length > 0) {
      this.x = from.x; this.y = from.y
      this.path = naturalizePath(clear, from, raw)
      return
    }
    // No route around (destination boxed in). Give up gracefully.
    this.path = []
    this.waiting = false
    if (this.returnHome && (dest.x !== this.home.x || dest.y !== this.home.y)) {
      this.returnHome = false
      this.goTo(this.home)
    }
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

      // Tentative position for this frame.
      const nx = dist <= step ? next.x : this.x + (dx / dist) * step
      const ny = dist <= step ? next.y : this.y + (dy / dist) * step
      const curCell = this.tile
      const newCell = { x: Math.round(nx), y: Math.round(ny) }

      if (newCell.x !== curCell.x || newCell.y !== curCell.y) {
        // Entering a new cell — it must be exclusively ours first.
        if (!this.occ.claim(newCell.x, newCell.y, this.id)) {
          this.waiting = true
          this.blockedT += dt
          if (this.blockedT >= this.repathAfter) {
            this.blockedT = 0
            this.rePathAroundOccupied()
          }
          return // hold position this frame; trailing cell keeps its claim
        }
        // Claimed. Hand over the trailing cell bookkeeping.
        if (this.heldPrev) this.occ.release(this.heldPrev.x, this.heldPrev.y, this.id)
        this.heldPrev = curCell
      }
      this.waiting = false
      this.blockedT = 0
      this.x = nx
      this.y = ny
      if (dist <= step) {
        this.path.shift()
        if (this.path.length === 0 && this.returnHome) {
          // pause a moment at the visit target, then head home
          this.returnHome = false
          setTimeout(() => { if (!this.moving) this.goTo(this.home) }, 1600 + (hashCode(this.id) % 1000))
        }
      }
      // Release the trailing cell once the body has fully cleared it.
      if (this.heldPrev && Math.hypot(this.x - this.heldPrev.x, this.y - this.heldPrev.y) > 0.8) {
        this.occ.release(this.heldPrev.x, this.heldPrev.y, this.id)
        this.heldPrev = null
      }
      return
    }

    // Not moving: make sure the trailing claim is gone and our seat is ours.
    if (this.heldPrev) {
      this.occ.release(this.heldPrev.x, this.heldPrev.y, this.id)
      this.heldPrev = null
    }

    // Idle flavor: rarely stroll to the coffee machine and back.
    if (this.status === 'idle' && this.atHome) {
      this.wanderT -= dt
      if (this.wanderT <= 0) {
        this.wanderT = WANDER_MIN_S + (hashCode(this.id + String(now | 0)) % WANDER_JITTER_S)
        const c = this.map.coffee
        // Queue-friendly: pick the first free stand spot along the counter.
        const stand = [
          { x: c.x, y: c.y + 1 }, { x: c.x - 1, y: c.y + 1 }, { x: c.x + 1, y: c.y + 1 },
          { x: c.x - 2, y: c.y + 1 }, { x: c.x + 2, y: c.y + 1 },
        ].find(pt => this.map.walkable(pt.x, pt.y) && this.occ.isFree(pt.x, pt.y, this.id))
        if (stand) {
          this.goTo(stand)
          this.returnHome = true
        }
      }
    }
  }

  frame(): CharFrame {
    if (this.moving && !this.waiting) {
      const f = Math.floor(this.animT * 6) % 2
      return `walk${this.dir}${f}` as CharFrame
    }
    if (this.moving && this.waiting) return 'stand' // queuing behind someone
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
