// BFS pathfinding on the office tile grid. Grid is small (~66×32) so BFS is plenty.
export interface Point { x: number; y: number }

export function findPath(
  walkable: (x: number, y: number) => boolean,
  width: number,
  height: number,
  from: Point,
  to: Point,
): Point[] {
  if (from.x === to.x && from.y === to.y) return []
  const key = (x: number, y: number) => y * width + x
  const prev = new Int32Array(width * height).fill(-1)
  const seen = new Uint8Array(width * height)
  const queue: number[] = [key(from.x, from.y)]
  seen[queue[0]] = 1
  const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]]
  let found = false

  while (queue.length && !found) {
    const cur = queue.shift()!
    const cx = cur % width, cy = Math.floor(cur / width)
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const nk = key(nx, ny)
      if (seen[nk]) continue
      // The destination tile itself may be non-walkable furniture (e.g. a desk):
      // we allow stopping on it only if it IS the destination and it's adjacent floor-reachable.
      const isDest = nx === to.x && ny === to.y
      if (!walkable(nx, ny) && !isDest) continue
      seen[nk] = 1
      prev[nk] = cur
      if (isDest) { found = true; break }
      queue.push(nk)
    }
  }
  if (!found) return []

  const path: Point[] = []
  let cur = key(to.x, to.y)
  while (cur !== key(from.x, from.y) && cur !== -1) {
    path.push({ x: cur % width, y: Math.floor(cur / width) })
    cur = prev[cur]
  }
  return path.reverse()
}

// ── Natural movement ────────────────────────────────────────────────────────
// Turn the orthogonal BFS staircase into diagonal, corner-rounded routes so agents
// cross open space the way people do, not by marching along the grid. Every shortcut is
// gated by a conservative line-of-sight test, so a naturalized path is never less safe
// than the staircase it replaces — worst case it degrades back to the same orthogonal steps.

/** True if the straight segment a→b stays on walkable tiles with ~half-tile clearance — the
    standard "no corner cutting" test. A diagonal squeezing between two walls is rejected
    because every sample's surrounding 2×2 tile block includes a wall. For an axis-aligned
    segment floor==ceil on the still axis, so it reduces to a thin on-the-line check and can
    never reject a step BFS already validated. */
function lineClear(walkable: (x: number, y: number) => boolean, a: Point, b: Point): boolean {
  const dx = b.x - a.x, dy = b.y - a.y
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4)) // ~4 samples per tile
  for (let i = 0; i <= n; i++) {
    const px = a.x + (dx * i) / n, py = a.y + (dy * i) / n
    const fx = Math.floor(px), cx = Math.ceil(px), fy = Math.floor(py), cy = Math.ceil(py)
    if (!walkable(fx, fy) || !walkable(cx, fy) || !walkable(fx, cy) || !walkable(cx, cy)) return false
  }
  return true
}

/** Point `f` of the way from b toward a. */
const towards = (b: Point, a: Point, f: number): Point => ({ x: b.x + (a.x - b.x) * f, y: b.y + (a.y - b.y) * f })

/** Greedy string-pull: drop every waypoint reachable from the current anchor in a clear
    straight line. Long staircases collapse into a few diagonal segments. Consecutive kept
    points always have clear line of sight. */
function stringPull(walkable: (x: number, y: number) => boolean, pts: Point[]): Point[] {
  if (pts.length <= 2) return pts.slice()
  const out: Point[] = [pts[0]]
  let anchor = 0
  for (let i = 2; i < pts.length; i++) {
    if (!lineClear(walkable, pts[anchor], pts[i])) {
      out.push(pts[i - 1])
      anchor = i - 1
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Bevel each interior corner by cutting 25% off the two adjacent segments — but only where
    the shortcut stays clear. Open-room turns round off; a tight doorway keeps its sharp
    (but safe) corner because the cut would clip the jamb. */
function smoothCorners(walkable: (x: number, y: number) => boolean, pts: Point[]): Point[] {
  if (pts.length < 3) return pts.slice()
  const out: Point[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1]
    const q = towards(b, a, 0.25), r = towards(b, c, 0.25)
    if (lineClear(walkable, q, r)) { out.push(q, r) } else out.push(b)
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Straighten + round a raw BFS path (which excludes `from`) into a natural route. Returns
    the waypoint list to walk, still excluding the start tile the sprite already stands on. */
export function naturalizePath(
  walkable: (x: number, y: number) => boolean,
  from: Point,
  path: Point[],
): Point[] {
  if (path.length === 0) return path
  const pulled = stringPull(walkable, [from, ...path])
  const smoothed = smoothCorners(walkable, pulled)
  smoothed.shift() // drop `from` — the sprite is already standing there
  return smoothed
}
