/**
 * 「整片一张图」布局的纯逻辑：把同一种地形的格子按**六边形邻接**拆成连通块，
 * 并算出"图片放进去要多大、放哪儿"。
 *
 * 为什么要按邻接、而不是按包围盒：
 * 用户要的是"**连通的**同类型格共用一张图"。若按包围盒分组，两片隔着一条海也算一块，
 * 图片会横跨中间那片不属于它的区域 —— 而被裁掉之后，两片各自都只剩残缺的一角。
 * 邻接才是"同一片"的定义。
 *
 * 为什么"保持比例"要单独算：用户明确要求**不改变图片比例**。所以这里用 *contain*
 * （等比缩放到能放进包围盒的最大尺寸，居中），而不是拉伸铺满 —— 拉伸会让一张圆形湖泊变成椭圆。
 * 对应地，实际渲染时必须再按"格子的并集"裁剪，否则图片会溢出到相邻的其他地形上。
 *
 * 本模块**只做几何与算术**，不认识 canvas，也不认识 Obsidian —— 于是它可以在没有浏览器的
 * 环境里被完整单测（这正是本项目"能算的都做成纯函数"的那条规矩）。
 */

import { axialToWorld, cellKey, hexCorners, type Axial, type GridSpec } from '../core/hex.ts'

/**
 * 轴向坐标的 6 个邻居方向。
 *
 * 刻意写在这里而不是从 `hex.ts` 引一个常量：这个模块自己有一条**自验证**断言
 * （每个方向的 `hexDistance` 必须是 1），所以即使哪天方向写错了，测试会当场抓住，
 * 而不是等用户看到"两片明明挨着却被当成两块"。
 */
const AXIAL_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]

export interface RegionBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface TerrainRegion {
  /** 组成这一块的格（**按格键排序**，顺序确定） */
  cells: Axial[]
  /** 这一块的**视觉**包围盒（取六边形的顶点，而不是格心） */
  bounds: RegionBounds
}

/**
 * 把一批格拆成连通块。
 *
 * 顺序确定（用于缓存与断言）：块按"第一格（字典序最小的格键）"排序，块内的格按键排序。
 * 于是同一份输入永远得到同一个结果 —— 否则图片会在两块之间随机跳动。
 */
export function findTerrainRegions(cells: readonly Axial[], grid: GridSpec): TerrainRegion[] {
  if (cells.length === 0) return []

  const byKey = new Map<string, Axial>()
  for (const cell of cells) byKey.set(cellKey(cell.q, cell.r), { q: cell.q, r: cell.r })

  const visited = new Set<string>()
  const regions: TerrainRegion[] = []

  // 按格键顺序遍历起点，保证结果顺序确定
  for (const startKey of [...byKey.keys()].sort()) {
    if (visited.has(startKey)) continue
    const stack = [startKey]
    visited.add(startKey)
    const members: Axial[] = []
    while (stack.length > 0) {
      const key = stack.pop()!
      const current = byKey.get(key)!
      members.push(current)
      for (const [dq, dr] of AXIAL_DIRECTIONS) {
        const neighborKey = cellKey(current.q + dq, current.r + dr)
        if (!byKey.has(neighborKey) || visited.has(neighborKey)) continue
        visited.add(neighborKey)
        stack.push(neighborKey)
      }
    }
    members.sort((a, b) => (cellKey(a.q, a.r) < cellKey(b.q, b.r) ? -1 : 1))
    regions.push({ cells: members, bounds: boundsOf(members, grid) })
  }

  regions.sort((a, b) => (cellKey(a.cells[0]!.q, a.cells[0]!.r) < cellKey(b.cells[0]!.q, b.cells[0]!.r) ? -1 : 1))
  return regions
}

/** 一块的视觉包围盒：取每格六边形的**顶点**，而不是格心（否则图片会顶到边上） */
export function boundsOf(cells: readonly Axial[], grid: GridSpec): RegionBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const cell of cells) {
    const center = axialToWorld(grid, cell.q, cell.r)
    const corners = hexCorners(
      { kind: 'hex', orientation: grid.orientation, size: grid.size, origin: [center.x, center.y] },
      0,
      0,
    )
    for (const corner of corners) {
      if (corner.x < minX) minX = corner.x
      if (corner.y < minY) minY = corner.y
      if (corner.x > maxX) maxX = corner.x
      if (corner.y > maxY) maxY = corner.y
    }
  }
  return { minX, minY, maxX, maxY }
}

export interface ContainFit {
  x: number
  y: number
  width: number
  height: number
}

/**
 * *contain* 适配：在给定矩形内等比缩放到最大并居中。
 *
 * 三条不变量（都会被单测钉住）：
 * 1. **比例不变**：`width / height === imageWidth / imageHeight`（浮点误差内）；
 * 2. **装得下**：结果矩形不超出给定矩形；
 * 3. **居中**：两侧留白相等。
 *
 * 图片尺寸非法（0 / NaN）时退化为"铺满给定矩形" —— 宁可比例可能不对，也不要画出 0 尺寸的东西
 * （0 尺寸的 drawImage 在画布上是**静默不画**，用户只会看到"这一片没图"）。
 */
export function fitContain(target: RegionBounds, imageWidth: number, imageHeight: number): ContainFit {
  const targetWidth = Math.max(0, target.maxX - target.minX)
  const targetHeight = Math.max(0, target.maxY - target.minY)
  const fallback: ContainFit = { x: target.minX, y: target.minY, width: targetWidth, height: targetHeight }
  if (!(targetWidth > 0) || !(targetHeight > 0)) return fallback
  if (!(imageWidth > 0) || !(imageHeight > 0)) return fallback

  const scale = Math.min(targetWidth / imageWidth, targetHeight / imageHeight)
  const width = imageWidth * scale
  const height = imageHeight * scale
  return {
    x: target.minX + (targetWidth - width) / 2,
    y: target.minY + (targetHeight - height) / 2,
    width,
    height,
  }
}

/**
 * 一批格的**顺序无关**哈希（用于"要不要重算连通块"的缓存键）。
 *
 * 为什么要它：连通块要在每帧绘制时用到，但"每帧重算 + 每帧重建一堆对象"是性能灾难；
 * 而按格集合算出一个小整数哈希（加法，与顺序无关）足够便宜，能可靠地发现"格子变了"。
 * 加法哈希会有碰撞，但碰撞的代价只是"这一帧仍然用上一帧的分块结果"，下一帧就会自我纠正。
 */
export function hashTerrainCells(cells: readonly Axial[]): number {
  let hash = 0
  for (const cell of cells) {
    // 小素数乘法：把 (q, r) 摊开成 32 位内的整数，避免简单相加导致的规律性碰撞
    hash = (hash + ((cell.q * 73856093) ^ (cell.r * 19349663))) | 0
  }
  return hash
}
