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
