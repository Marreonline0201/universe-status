// Exclusive cell ownership: at any instant a tile cell is held by at most one
// sprite, so agents can never visually stack — not at desks, not at the coffee
// machine, not mid-walk. Sprites claim the cell they are entering BEFORE moving
// into it and keep their trailing cell until their body has cleared it.
import type { Point } from './pathfind'

export class Occupancy {
  private cells = new Map<string, string>() // "x,y" → sprite id

  private key(x: number, y: number) { return `${x},${y}` }

  holder(x: number, y: number): string | undefined {
    return this.cells.get(this.key(x, y))
  }

  /** Free, or already held by `id`. */
  isFree(x: number, y: number, id: string): boolean {
    const h = this.cells.get(this.key(x, y))
    return h === undefined || h === id
  }

  /** Atomically take the cell. True if it was free or already ours. */
  claim(x: number, y: number, id: string): boolean {
    const k = this.key(x, y)
    const h = this.cells.get(k)
    if (h !== undefined && h !== id) return false
    this.cells.set(k, id)
    return true
  }

  release(x: number, y: number, id: string) {
    const k = this.key(x, y)
    if (this.cells.get(k) === id) this.cells.delete(k)
  }

  clear() { this.cells.clear() }
}

/** Nearest free walkable cell to `start` (spiral search) — spawn fallback so
    two agents without desks never materialize on the same lobby tile. */
export function nearestFreeCell(
  walkable: (x: number, y: number) => boolean,
  occ: Occupancy,
  start: Point,
  id: string,
): Point {
  if (walkable(start.x, start.y) && occ.isFree(start.x, start.y, id)) return start
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = start.x + dx, y = start.y + dy
        if (walkable(x, y) && occ.isFree(x, y, id)) return { x, y }
      }
    }
  }
  return start // give up; better co-located than lost
}
