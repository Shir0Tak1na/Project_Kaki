/**
 * 沿六边形**边**的几何 —— 纯函数模块。
 *
 * 用途：路径与区域需要两种画法（用户的原话）：
 * - 「直接通过六边形内部」：几何自由走（现状），线条可以斜穿格子；
 * - 「勾勒六边形边框」：几何吸附到网格顶点，并且**沿格边走** —— 画面因此整齐。
 *
 * 难点在于"任意两个顶点之间要沿格边走"：这不是一次直线连接，而是在**三角格点图**上
 * 找一条最短边路（每个六边形顶点都有 6 个邻居）。这里用有界 BFS，并按"离目标更近优先"
 * 排序邻居，使找出来的路尽量直、且结果确定可复现。
 */

import { hexCorners, axialToWorld, worldToAxial, type GridSpec, type Point } from './hex.ts'

/**
 * 几何模式：
 * - `interior`：穿过格子内部（自由折线）
 * - `edge`：沿格边 —— 落点吸附到顶点，顶点之间**自动**沿格边走
 * - `edge-step`：逐边 —— 每次点击只沿格边**前进一条边**（手动描边，方向由点击位置决定）
 */
export type GeometryMode = 'interior' | 'edge' | 'edge-step'

export interface HexVertex {
  /** 顶点身份键（同一顶点由 3 个六边形共享，必须归一到同一个键） */
  key: string
  point: Point
}

/** 六边形格子尺寸的安全量化：相邻顶点最小间距 = 边长 = size，取 size/8 既有余量又不受浮点误差影响 */
function quantumOf(grid: GridSpec): number {
  return Math.max(1e-9, grid.size / 8)
}

/**
 * 顶点身份键。
 *
 * 同一个顶点会被 3 个六边形各算一次（浮点值略有差异），因此必须量化后才能比较；
 * 不同顶点之间的距离至少是一个边长，所以 `size/8` 的量化**不会**把两个顶点并成一个。
 */
export function vertexKey(grid: GridSpec, point: Point): string {
  const quantum = quantumOf(grid)
  return `${Math.round(point.x / quantum)}:${Math.round(point.y / quantum)}`
}

/** 某格的 6 个邻居（轴向） */
const AXIAL_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]

/**
 * 世界坐标 → 最近的六边形**顶点**。
 *
 * 只需扫描"所在格 + 周围 6 格"的顶点：更远的顶点一定比这 7 个格子的某个角更远。
 */
export function snapToHexVertex(grid: GridSpec, point: Point): HexVertex {
  const cell = worldToAxial(grid, point)
  let best: Point | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  const consider = (q: number, r: number): void => {
    for (const corner of hexCorners(grid, q, r)) {
      const distance = Math.hypot(corner.x - point.x, corner.y - point.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = corner
      }
    }
  }

  consider(cell.q, cell.r)
  for (const [dq, dr] of AXIAL_NEIGHBORS) consider(cell.q + dq, cell.r + dr)

  const point_ = best ?? axialToWorld(grid, cell.q, cell.r)
  return { key: vertexKey(grid, point_), point: point_ }
}

/**
 * 一个顶点的邻居顶点（沿格边走一步）。
 *
 * ⚠️ 这里有两个反直觉之处，第一版都写错了，都是被单元测试当场抓住的：
 *
 * 1. **邻居只有 3 个**。六边形顶点与边构成的图是"蜂窝图"，每个顶点度数为 3，
 *    不是直觉上的 6。（距离等于边长的 6 个方向里，有 3 个指向的是相邻六边形的**中心** ——
 *    正六边形的顶点到中心距离恰好等于边长。）
 * 2. **方向不固定**。蜂窝图是二分图，相邻顶点分属两个子格，
 *    两组顶点的边方向相差 60°（pointy 下是 {90,210,330} 与 {30,150,270}）。
 *    所以"按固定角度算邻居"对一半顶点是错的，会指到格心上去。
 *
 * 因此这里不写死角度，而是**自验证**：把 6 个候选方向都算出来，
 * 只保留"吸附回自身"的那些（格点吸附后仍在原地；格心会偏出半个边长）。
 * 代价是每次查询多几次吸附计算，换来的是对任意方向、任意子格都成立。
 */
export function vertexNeighbors(grid: GridSpec, vertex: Point): HexVertex[] {
  const baseDeg = grid.orientation === 'pointy' ? 90 : 0
  const tolerance = grid.size * 0.25
  const out: HexVertex[] = []
  const seen = new Set<string>([vertexKey(grid, vertex)])

  for (let i = 0; i < 6; i += 1) {
    const rad = ((baseDeg + 60 * i) * Math.PI) / 180
    const candidate: Point = {
      x: vertex.x + grid.size * Math.cos(rad),
      y: vertex.y + grid.size * Math.sin(rad),
    }
    const snapped = snapToHexVertex(grid, candidate).point
    // 候选点必须**本身就是格点**：格心吸附后会跑出半个边长，正好被这一步筛掉
    if (Math.hypot(snapped.x - candidate.x, snapped.y - candidate.y) > tolerance) continue
    const key = vertexKey(grid, candidate)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, point: candidate })
  }

  return out
}

/**
 * 沿格边从 `from` 走到 `to`，返回途经顶点（含首尾）。
 *
 * 有界 BFS：只搜索首尾包围盒外扩两格的范围，并限制访问量，避免病态输入把一帧拖死。
 * 万一找不到（理论上不该发生），退化为两个顶点直连 —— 保证不丢几何、不抛异常。
 */
export function walkAlongEdges(grid: GridSpec, from: Point, to: Point): Point[] {
  const start = snapToHexVertex(grid, from)
  const goal = snapToHexVertex(grid, to)
  if (start.key === goal.key) return [start.point]

  const margin = grid.size * 2
  const minX = Math.min(start.point.x, goal.point.x) - margin
  const maxX = Math.max(start.point.x, goal.point.x) + margin
  const minY = Math.min(start.point.y, goal.point.y) - margin
  const maxY = Math.max(start.point.y, goal.point.y) + margin
  const within = (p: Point): boolean => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

  const points = new Map<string, Point>([[start.key, start.point]])
  const cameFrom = new Map<string, string>()
  const visited = new Set<string>([start.key])
  const queue: string[] = [start.key]
  const MAX_VISITS = 20_000
  let head = 0

  while (head < queue.length && visited.size <= MAX_VISITS) {
    const currentKey = queue[head]!
    head += 1
    if (currentKey === goal.key) break

    const currentPoint = points.get(currentKey)!
    const neighbors = vertexNeighbors(grid, currentPoint)
      .filter((neighbor) => within(neighbor.point))
      // 先探索"离目标更近"的邻居：这样找到的最短路边路也最直
      .sort(
        (a, b) =>
          Math.hypot(a.point.x - goal.point.x, a.point.y - goal.point.y) -
          Math.hypot(b.point.x - goal.point.x, b.point.y - goal.point.y),
      )

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.key)) continue
      visited.add(neighbor.key)
      points.set(neighbor.key, neighbor.point)
      cameFrom.set(neighbor.key, currentKey)
      queue.push(neighbor.key)
    }
  }

  if (!visited.has(goal.key)) return [start.point, goal.point]

  const path: Point[] = []
  let cursor: string | undefined = goal.key
  while (cursor) {
    path.push(points.get(cursor)!)
    cursor = cameFrom.get(cursor)
  }
  path.reverse()
  return path
}

/** 去掉连续重复的点（顶点的浮点值可能略有差异，用键判断） */
export function dedupeConsecutive(grid: GridSpec, points: readonly Point[]): Point[] {
  const out: Point[] = []
  let lastKey: string | null = null
  for (const point of points) {
    const key = vertexKey(grid, point)
    if (key === lastKey) continue
    out.push(point)
    lastKey = key
  }
  return out
}

/**
 * 把一串自由点转成**沿格边**的折线。
 *
 * `closed` 为真时（区域）首尾之间也沿边走。注意**不保留**与起点重合的末尾点：
 * 多边形由渲染层隐式闭合（`closePath`），而那条隐式闭合边本身就是走出来的最后一条格边，
 * 因此数据里不需要重复存一个起点。
 */
export function toEdgePath(grid: GridSpec, points: readonly Point[], closed = false): Point[] {
  if (points.length === 0) return []
  const first = snapToHexVertex(grid, points[0]!)
  const chain: Point[] = [first.point]

  const append = (target: Point): void => {
    const walk = walkAlongEdges(grid, chain[chain.length - 1]!, target)
    for (let i = 1; i < walk.length; i += 1) chain.push(walk[i]!)
  }

  for (let i = 1; i < points.length; i += 1) append(points[i]!)
  if (closed && points.length >= 3) append(first.point)

  const deduped = dedupeConsecutive(grid, chain)
  // 去掉"回到起点"的那个重复点（闭合交给渲染层）
  if (closed && deduped.length > 1) {
    const last = deduped[deduped.length - 1]!
    if (vertexKey(grid, last) === vertexKey(grid, first.point)) deduped.pop()
  }
  return deduped
}

/**
 * 草稿预览用：从最后一个已确定顶点沿格边走到当前光标。
 *
 * 逐帧只走最后这一段 —— 之前那些段已经定下来了，不必每帧重算。
 */
export function walkTailToCursor(grid: GridSpec, fromVertex: Point, cursor: Point): Point[] {
  const walk = walkAlongEdges(grid, fromVertex, cursor)
  return walk.length > 1 ? walk.slice(1) : []
}

/**
 * 逐边模式：从当前端点**只前进一条边**，方向由点击/光标位置决定。
 *
 * 规则是"点哪个方向就往哪走"：在端点的 3 条格边里挑与目标方向最接近的那条。
 * 这样每次点击都必定前进一条边（不会出现"点了没反应"的死点击），
 * 又保留了逐条描边的精确控制 —— 想拐弯就往那个方向点。
 *
 * 目标正好落在端点上（方向退化）时，沿上一步的方向继续走（没走过就取键序最小的那条），
 * 保证结果确定、可复现。
 */
export function stepAlongEdges(
  grid: GridSpec,
  from: Point,
  target: Point,
  previousStep?: Point | null,
): HexVertex {
  const start = snapToHexVertex(grid, from)
  const candidates = vertexNeighbors(grid, start.point).sort((a, b) => a.key.localeCompare(b.key))
  if (candidates.length === 0) return start

  const targetDistance = Math.hypot(target.x - start.point.x, target.y - start.point.y)
  // 方向退化（点在端点上）：按上一步方向继续，或者取第一个候选（键序最小，确定）
  if (targetDistance < grid.size * 0.25) {
    if (previousStep) {
      const directionLength = Math.hypot(previousStep.x, previousStep.y)
      if (directionLength > 0) {
        return bestByDirection(candidates, previousStep)
      }
    }
    return candidates[0]!
  }

  const scored = candidates.map((candidate) => ({
    candidate,
    distance: Math.hypot(candidate.point.x - target.x, candidate.point.y - target.y),
  }))
  scored.sort((a, b) => a.distance - b.distance)
  const best = scored[0]!
  // 两个方向几乎一样近时，沿用上一步方向（走直线比来回拐更符合直觉）
  const second = scored[1]
  if (previousStep && second && Math.abs(best.distance - second.distance) < grid.size * 0.05) {
    return bestByDirection([best.candidate, second.candidate], previousStep)
  }
  return best.candidate
}

/** 在若干候选里挑与给定方向夹角最小的（方向朝同一侧即算） */
function bestByDirection(candidates: readonly HexVertex[], direction: Point): HexVertex {
  const directionLength = Math.hypot(direction.x, direction.y) || 1
  const unit = { x: direction.x / directionLength, y: direction.y / directionLength }
  let best = candidates[0]!
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    const length = Math.hypot(candidate.point.x, candidate.point.y)
    if (length <= 0) continue
    const score = (candidate.point.x / length) * unit.x + (candidate.point.y / length) * unit.y
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}
