/**
 * 六边形网格的空间索引 —— 纯函数模块。
 *
 * 职责：把「当前可见的世界矩形」翻译成「需要绘制的格范围 + 需要重绘的分块」。
 * 这是渲染性能方案的基础（设计文档 §4.3 与 §4.4）：
 * 实测 `markViewportChanged` 逐帧触发，因此每帧的重绘必须廉价 ——
 * 靠分块缓存 + 视口裁剪，而不是靠合并事件。
 */

import { axialToWorld, hexDistance, normalizeZero, type Axial, type GridSpec, type Point } from '../core/hex.ts'
import type { BBox } from '../core/viewport.ts'

/** 每块的格数（边长）。16×16 格在 40 世界单位/格下约 640×640 世界单位 */
export const DEFAULT_CHUNK_SIZE = 16

export interface CellBounds {
  minQ: number
  maxQ: number
  minR: number
  maxR: number
}

export interface ChunkBounds {
  minCx: number
  maxCx: number
  minCy: number
  maxCy: number
}

export interface AxialPoint extends Axial {
  x: number
  y: number
}

function axialFromWorldInverse(grid: GridSpec, p: Point): { q: number; r: number } {
  // 与 core/hex.ts 的 worldToAxial 同构，但返回**未取整**的分数坐标，
  // 用于精确计算可见范围（取整会丢边界的格）。
  const s = grid.size
  const x = (p.x - grid.origin[0]) / s
  const y = (p.y - grid.origin[1]) / s
  if (grid.orientation === 'pointy') {
    return { q: (Math.sqrt(3) / 3) * x - (1 / 3) * y, r: (2 / 3) * y }
  }
  return { q: (2 / 3) * x, r: -(1 / 3) * x + (Math.sqrt(3) / 3) * y }
}

/**
 * 可见格的边界矩形（在 q/r 空间上）。
 *
 * 做法：把可见矩形的四个角转成**分数**轴向坐标，取外包矩形再外扩 margin 格。
 * 六边形在 q/r 空间里是斜的，所以这是**过近似**：返回的矩形一定覆盖所有与可见区
 * 相交的格，但可能多带一行/一列的格。多画的格由后续逐格 bbox 判定剔除，
 * 而「不漏」是硬要求（漏了就会看到空白）。
 */
export function visibleCellBounds(grid: GridSpec, bbox: BBox, margin = 1): CellBounds {
  const corners: Point[] = [
    { x: bbox.minX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.maxY },
    { x: bbox.minX, y: bbox.maxY },
  ]
  let minQ = Number.POSITIVE_INFINITY
  let maxQ = Number.NEGATIVE_INFINITY
  let minR = Number.POSITIVE_INFINITY
  let maxR = Number.NEGATIVE_INFINITY

  for (const corner of corners) {
    const frac = axialFromWorldInverse(grid, corner)
    minQ = Math.min(minQ, frac.q)
    maxQ = Math.max(maxQ, frac.q)
    minR = Math.min(minR, frac.r)
    maxR = Math.max(maxR, frac.r)
  }

  return {
    minQ: Math.floor(minQ) - margin,
    maxQ: Math.ceil(maxQ) + margin,
    minR: Math.floor(minR) - margin,
    maxR: Math.ceil(maxR) + margin,
  }
}

/** 视口可见的格坐标（直接换算世界坐标，供绘制时用，避免每格再算一次） */
export function* iterateCells(grid: GridSpec, bounds: CellBounds): Generator<AxialPoint> {
  for (let r = bounds.minR; r <= bounds.maxR; r++) {
    for (let q = bounds.minQ; q <= bounds.maxQ; q++) {
      const world = axialToWorld(grid, q, r)
      yield { q, r, x: world.x, y: world.y }
    }
  }
}

/** 按四舍五入取整的分块坐标 */
export function chunkCoordForCell(q: number, r: number, chunkSize = DEFAULT_CHUNK_SIZE): { cx: number; cy: number } {
  return { cx: Math.floor(q / chunkSize), cy: Math.floor(r / chunkSize) }
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx}_${cy}`
}

export function chunkKeyForCell(q: number, r: number, chunkSize = DEFAULT_CHUNK_SIZE): string {
  const { cx, cy } = chunkCoordForCell(q, r, chunkSize)
  return chunkKey(cx, cy)
}

/** 可见范围覆盖的分块范围 */
export function visibleChunkBounds(bounds: CellBounds, chunkSize = DEFAULT_CHUNK_SIZE): ChunkBounds {
  const topLeft = chunkCoordForCell(bounds.minQ, bounds.minR, chunkSize)
  const bottomRight = chunkCoordForCell(bounds.maxQ, bounds.maxR, chunkSize)
  return { minCx: topLeft.cx, maxCx: bottomRight.cx, minCy: topLeft.cy, maxCy: bottomRight.cy }
}

export function* iterateChunks(bounds: ChunkBounds): Generator<{ cx: number; cy: number; key: string }> {
  for (let cy = bounds.minCy; cy <= bounds.maxCy; cy++) {
    for (let cx = bounds.minCx; cx <= bounds.maxCx; cx++) {
      yield { cx, cy, key: chunkKey(cx, cy) }
    }
  }
}

/** 该格的世界包围盒是否与可见矩形相交（用于剔除过近似带进来的格） */
export function cellIntersectsBBox(grid: GridSpec, q: number, r: number, bbox: BBox, margin = 0): boolean {
  const center = axialToWorld(grid, q, r)
  const reach = grid.size + margin
  return (
    center.x + reach >= bbox.minX &&
    center.x - reach <= bbox.maxX &&
    center.y + reach >= bbox.minY &&
    center.y - reach <= bbox.maxY
  )
}

/**
 * 笔刷落点：以某个世界坐标为中心、半径 radius 格内的全部格。
 * 半径 0 即单格；吸附由轴向坐标取整天然完成，因此 posFromEvt 的 1 CSS px 量化
 * 在这一步被完全吸收（格宽 40 世界单位 ≫ 量化误差）。
 */
export function brushCellsAt(grid: GridSpec, world: Point, radius: number): Axial[] {
  const frac = axialFromWorldInverse(grid, world)
  // 归一化 -0：否则同一个格会出现两种表示，比较与日志都会出现"看起来相同的两个值"
  const center = { q: normalizeZero(Math.round(frac.q)), r: normalizeZero(Math.round(frac.r)) }
  if (radius <= 0) return [center]
  const out: Axial[] = []
  const reach = Math.floor(radius)
  for (let dq = -reach; dq <= reach; dq++) {
    for (let dr = -reach; dr <= reach; dr++) {
      const cell = { q: center.q + dq, r: center.r + dr }
      if (hexDistance(cell, center) <= radius) out.push(cell)
    }
  }
  return out
}

/** 地图内容的 q/r 范围（用于「缩放到地图」），空地图返回 null */
export function terrainBounds(keys: Iterable<string>): CellBounds | null {
  let minQ = Number.POSITIVE_INFINITY
  let maxQ = Number.NEGATIVE_INFINITY
  let minR = Number.POSITIVE_INFINITY
  let maxR = Number.NEGATIVE_INFINITY
  let any = false
  for (const key of keys) {
    const at = key.indexOf('_')
    if (at <= 0) continue
    const q = Number(key.slice(0, at))
    const r = Number(key.slice(at + 1))
    if (!Number.isInteger(q) || !Number.isInteger(r)) continue
    any = true
    minQ = Math.min(minQ, q)
    maxQ = Math.max(maxQ, q)
    minR = Math.min(minR, r)
    maxR = Math.max(maxR, r)
  }
  return any ? { minQ, maxQ, minR, maxR } : null
}
