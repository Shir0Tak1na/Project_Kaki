/**
 * 路径与区域的几何 —— 纯函数模块。
 *
 * 路径（河流/道路/贸易路线/边界）与区域（国家/领地多边形）都是**连续空间的矢量图形**，
 * 因此以世界坐标存储（与标记一致），不像地形那样量化到格。
 *
 * 本模块负责四件事，全部可单元测试：
 * 1. 包围盒（用于视口裁剪）；
 * 2. 平滑曲线：Catmull-Rom 转三次贝塞尔（河流用）；
 * 3. 变宽：河流末端变细（canvas 不支持变宽描边，按段给不同宽度）；
 * 4. 命中测试：右键删除需要它（节点不在 DOM 上，无法靠事件目标判断）。
 */

import type { Point } from '../core/hex.ts'
import type { BBox } from '../core/viewport.ts'

export type PathCommand =
  | { kind: 'moveTo'; x: number; y: number }
  | { kind: 'lineTo'; x: number; y: number }
  | { kind: 'bezierTo'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }

export interface PolylineBounds extends BBox {
  /** 是否退化（点数为 0） */
  empty: boolean
}

/** 折线/多边形的包围盒；`pad` 用于把线宽算进去 */
export function shapeBounds(points: readonly Point[], pad = 0): PolylineBounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, empty: true }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad, empty: false }
}

export function bboxOverlaps(a: BBox, b: BBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}

/**
 * Catmull-Rom 样条转三次贝塞尔。
 *
 * 首尾用"镜像点"补齐控制点，让端点处的切线自然；`tension` 1 = 标准 Catmull-Rom。
 * 河流用它，其他线性要素用折线（更符合道路/边界的观感）。
 */
export function buildSmoothCommands(points: readonly Point[], tension = 1): PathCommand[] {
  if (points.length === 0) return []
  const first = points[0]!
  if (points.length === 1) return [{ kind: 'moveTo', x: first.x, y: first.y }]

  const commands: PathCommand[] = [{ kind: 'moveTo', x: first.x, y: first.y }]
  const at = (index: number): Point => points[Math.max(0, Math.min(points.length - 1, index))]!

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1 = { x: p1.x + ((p2.x - p0.x) / 6) * tension, y: p1.y + ((p2.y - p0.y) / 6) * tension }
    const c2 = { x: p2.x - ((p3.x - p1.x) / 6) * tension, y: p2.y - ((p3.y - p1.y) / 6) * tension }
    commands.push({ kind: 'bezierTo', c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x: p2.x, y: p2.y })
  }
  return commands
}

export function buildLinearCommands(points: readonly Point[]): PathCommand[] {
  if (points.length === 0) return []
  const commands: PathCommand[] = [{ kind: 'moveTo', x: points[0]!.x, y: points[0]!.y }]
  for (let i = 1; i < points.length; i += 1) {
    commands.push({ kind: 'lineTo', x: points[i]!.x, y: points[i]!.y })
  }
  return commands
}

/** 河流末端变细：起点保持原宽，终点收缩到 `endRatio` */
export function taperedWidths(baseWidth: number, segmentCount: number, endRatio = 0.3): number[] {
  const count = Math.max(0, Math.floor(segmentCount))
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const t = count <= 1 ? 0 : i / (count - 1)
    out.push(baseWidth * (1 - (1 - endRatio) * t))
  }
  return out
}

/** 点到线段的最短距离 */
export function pointToSegmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < 1e-12) return Math.hypot(point.x - from.x, point.y - from.y)
  const t = Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t))
}

/** 点到折线的最短距离 */
export function pointToPolylineDistance(point: Point, points: readonly Point[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y)
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(best, pointToSegmentDistance(point, points[i]!, points[i + 1]!))
  }
  return best
}

/** 射线法判断点是否在多边形内（区域填充用） */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!
    const b = polygon[j]!
    const intersects = a.y > point.y !== b.y > point.y
    if (intersects) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < x) inside = !inside
    }
  }
  return inside
}

export interface PathHitOptions {
  /** 线宽（世界单位） */
  width: number
  /** 额外容差（世界单位）：小图形比线宽更好点 */
  tolerance?: number
}

/** 折线命中测试：点在线宽范围内（含容差）即命中 */
export function hitTestPolyline(point: Point, points: readonly Point[], options: PathHitOptions): boolean {
  const reach = Math.max(options.width / 2, 1) + (options.tolerance ?? 0)
  return pointToPolylineDistance(point, points) <= reach
}

/** 区域命中测试：在多边形内即命中（不要求靠近边界） */
export function hitTestPolygon(point: Point, polygon: readonly Point[]): boolean {
  return pointInPolygon(point, polygon)
}

/** 折线总长度（状态栏与调试用） */
export function polylineLength(points: readonly Point[]): number {
  let total = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    total += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y)
  }
  return total
}

export interface PolylineAnchor {
  point: Point
  /** 该点的切线方向（单位向量），用于把标签推离线条 */
  tangent: Point
}

/**
 * 折线上按**弧长**取点。
 *
 * 名称的逐字排版、以及"顺着线条走的文字"都依赖它：
 * 需要沿曲线均匀取点，而不是沿顶点序号取点（顶点分布不均时会明显偏向一侧）。
 */
export function pointAtArcLength(points: readonly Point[], distance: number): PolylineAnchor | null {
  if (points.length === 0) return null
  const first = points[0]!
  if (points.length === 1) return { point: { ...first }, tangent: { x: 1, y: 0 } }

  const total = polylineLength(points)
  if (total <= 0) return { point: { ...first }, tangent: { x: 1, y: 0 } }
  const target = Math.min(Math.max(distance, 0), total)

  let travelled = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!
    const to = points[i + 1]!
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (length <= 0) continue
    if (travelled + length >= target) {
      const t = (target - travelled) / length
      return {
        point: { x: from.x + dx * t, y: from.y + dy * t },
        tangent: { x: dx / length, y: dy / length },
      }
    }
    travelled += length
  }

  const last = points[points.length - 1]!
  return { point: { ...last }, tangent: { x: 1, y: 0 } }
}

/**
 * 折线的**按弧长中点**。
 *
 * 不用"中间那个顶点"：顶点分布不均时它会明显偏向折线的一侧。
 * 名称标签就放在这里，再沿法线推出半个线宽 + 一点余量，避免压在线条上。
 */
export function polylineMidpoint(points: readonly Point[]): PolylineAnchor | null {
  if (points.length === 0) return null
  return pointAtArcLength(points, polylineLength(points) / 2)
}

/** 三次贝塞尔在 t 处的点 */
export function cubicPoint(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  }
}

/**
 * 把绘制命令展平成稠密折线。
 *
 * 为什么需要它：canvas 的 `lineWidth` 是整条路径统一的，**变宽描边只能逐段画**；
 * 而"逐段画"必须拿到曲线上的实际点 —— 直接拿原始顶点去连线，
 * 河流就会在提交后从平滑曲线变成折线（这是真实报告过的缺陷）。
 */
export function flattenCommands(commands: readonly PathCommand[], stepsPerCurve = 12): Point[] {
  const steps = Math.max(2, Math.floor(stepsPerCurve))
  const out: Point[] = []
  let current: Point | null = null

  for (const command of commands) {
    if (command.kind === 'bezierTo' && current) {
      const from = current
      const c1 = { x: command.c1x, y: command.c1y }
      const c2 = { x: command.c2x, y: command.c2y }
      const to = { x: command.x, y: command.y }
      for (let i = 1; i <= steps; i += 1) out.push(cubicPoint(from, c1, c2, to, i / steps))
      current = to
      continue
    }
    current = { x: command.x, y: command.y }
    out.push({ ...current })
  }
  return out
}

/** 展平后的总段数上限：变宽描边是逐段 `stroke()`，不能无节制 */
export const FLATTEN_MAX_SEGMENTS = 96

/**
 * 按控制段数分配每段采样数。
 *
 * 约束是"总段数尽量不超上限"，但**每段至少 2 个采样**：少于 2 的话，一个长曲段会被
 * 画成一根直弦 —— 那正是"河流变折线"的成因。因此顶点很多时总段数会略超上限
 * （每控制段 2 个采样），这与逐段描边本身的固有成本（N 段本来就 N 次 stroke）同阶。
 */
export function flattenSteps(segmentCount: number, maxSegments = FLATTEN_MAX_SEGMENTS): number {
  const segments = Math.max(1, Math.floor(segmentCount))
  return Math.max(2, Math.min(24, Math.floor(maxSegments / segments)))
}

/**
 * 一条路径**看得见的几何**：平滑路径被展平成稠密折线，线性路径原样返回。
 *
 * 这是"看到什么就命中什么"的唯一来源：描边、名称排版、命中测试都用它。
 * 曾经命中测试用的是原始控制顶点，而渲染用的是平滑曲线 ——
 * 在急转弯处两者相差可达几十个世界单位，于是"点在看得见的线上却删不掉"。
 */
export function visiblePolyline(points: readonly Point[], smooth: boolean): Point[] {
  if (!smooth || points.length < 3) return [...points]
  return flattenCommands(buildSmoothCommands(points), flattenSteps(points.length - 1))
}

/**
 * 区域标签锚点：优先面积质心；质心落在多边形外（凹多边形常见）时，
 * 退化为"在多边形内部找一个尽量靠近质心的点"。
 *
 * 直接取顶点平均值在凹多边形上会把标签甩到外面去，所以不能图省事。
 */
export function polygonAnchor(points: readonly Point[]): Point | null {
  if (points.length === 0) return null
  if (points.length < 3) {
    // 退化情况（还在画的过程中）：用顶点平均
    return points.reduce(
      (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
      { x: 0, y: 0 },
    )
  }

  const centroid = polygonCentroid(points)
  if (pointInPolygon(centroid, points)) return centroid

  // 在包围盒内网格采样，取"在多边形内且离质心最近"的点
  const bounds = shapeBounds(points)
  let best: Point | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  const steps = 8
  for (let ix = 1; ix < steps; ix += 1) {
    for (let iy = 1; iy < steps; iy += 1) {
      const candidate = {
        x: bounds.minX + ((bounds.maxX - bounds.minX) * ix) / steps,
        y: bounds.minY + ((bounds.maxY - bounds.minY) * iy) / steps,
      }
      if (!pointInPolygon(candidate, points)) continue
      const distance = Math.hypot(candidate.x - centroid.x, candidate.y - centroid.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
  }
  return best ?? points[0]!
}

/** 多边形面积质心（叉积公式） */
export function polygonCentroid(points: readonly Point[]): Point {
  let area = 0
  let x = 0
  let y = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]!
    const b = points[j]!
    const cross = a.x * b.y - b.x * a.y
    area += cross
    x += (a.x + b.x) * cross
    y += (a.y + b.y) * cross
  }
  area /= 2
  if (Math.abs(area) < 1e-9) {
    // 退化（共线）：退回顶点平均
    return points.reduce(
      (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
      { x: 0, y: 0 },
    )
  }
  return { x: x / (6 * area), y: y / (6 * area) }
}
