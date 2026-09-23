/**
 * 笔迹采样 —— 纯函数模块。
 *
 * 问题：鼠标拖动时事件间隔几十毫秒，快速划动会在两次事件之间跨越好几个格。
 * 如果只处理事件落点，笔画就会**断线**（中间留洞）。
 *
 * 做法：沿上一采样点到当前点的线段按「小于格半径」的间距插值采样，
 * 把每个采样点的笔刷落点并起来。间距取 0.4×格半径：
 * 相邻采样点的格心距离不超过半个格宽，因此不会漏格。
 */

import { axialToWorld, cellKey, type Axial, type GridSpec, type Point } from '../core/hex.ts'
import { brushCellsAt } from '../render/hexGrid.ts'

/** 采样间距与格半径的比值（小于 0.5 才能保证不漏格） */
export const SAMPLE_SPACING_RATIO = 0.4

export interface SegmentSampling {
  /** 采样点数量（含首尾） */
  samples: number
  spacing: number
}

/**
 * 沿线段采样并返回笔刷覆盖的全部格（去重）。
 *
 * `from === null` 时表示笔画起点，只取该点的笔刷落点。
 */
export function cellsAlongSegment(
  grid: GridSpec,
  from: Point | null,
  to: Point,
  radius: number,
): { cells: Axial[]; sampling: SegmentSampling } {
  const spacing = Math.max(1e-6, grid.size * SAMPLE_SPACING_RATIO)

  if (from === null) {
    return { cells: dedupe(brushCellsAt(grid, to, radius)), sampling: { samples: 1, spacing } }
  }

  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(distance / spacing))

  const seen = new Set<string>()
  const cells: Axial[] = []
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps
    const point = { x: from.x + dx * t, y: from.y + dy * t }
    for (const cell of brushCellsAt(grid, point, radius)) {
      const key = cellKey(cell.q, cell.r)
      if (seen.has(key)) continue
      seen.add(key)
      cells.push(cell)
    }
  }

  return { cells, sampling: { samples: steps + 1, spacing } }
}

function dedupe(cells: Axial[]): Axial[] {
  const seen = new Set<string>()
  const out: Axial[] = []
  for (const cell of cells) {
    const key = cellKey(cell.q, cell.r)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cell)
  }
  return out
}

/** 单点落笔（用于测试与工具栏预览） */
export function cellsAtPoint(grid: GridSpec, point: Point, radius: number): Axial[] {
  return dedupe(brushCellsAt(grid, point, radius))
}

/** 把格坐标换算成世界坐标（绘制高亮框用） */
export function axialWorld(grid: GridSpec, cells: Iterable<Axial>): Point[] {
  const out: Point[] = []
  for (const cell of cells) out.push(axialToWorld(grid, cell.q, cell.r))
  return out
}
