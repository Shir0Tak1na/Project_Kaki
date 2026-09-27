/**
 * 选中高亮的**绘制表**：一个 kind 一个绘制函数。
 *
 * 为什么单独一张表、而不是在 `MapOverlay.drawPlan` 里 `switch` 出二十行：
 * 用户已明确这个项目要长期加新对象种类（"更多层信息"、温度带、深度分层…）。
 * 绘制是**最容易被新种类撑爆**的地方 —— 每加一种就往一个大 switch 里塞十几行，
 * 那个函数会变成谁都不敢动的东西。这里换成"加一行"的形状。
 *
 * 与 `src/editor/selection.ts` 的 `SELECTION_KINDS` 是**同构的两张表**：
 * 一张说"这种对象是什么、怎么命中、显示什么"，一张说"选中它时长什么样"。
 * 分开是因为前者必须纯净（可在无 canvas 环境里单测），后者离不开 2D 上下文。
 *
 * ### 加一个新 kind 时
 * 在本文件的 `SELECTION_HIGHLIGHTS` 里加一行绘制函数即可（见 `selection.ts` 文件头的清单）。
 */

import { hexCorners, parseCellKey, axialToWorld } from '../core/hex.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import type { SelectionKind } from '../editor/selection.ts'
import { worldToRaster, type MapRenderPlan } from './renderPlan.ts'

/**
 * 强调色：**刻意不用对象自身的颜色**。
 *
 * 地图上很可能就有一条同色的路径/区域，那样"选中"看起来跟没选一样。
 * 也刻意不用主题色变量：覆盖层要在任何主题下都看得清。
 */
export const SELECTION_ACCENT = '#ff8a3d'
export const SELECTION_ACCENT_SOFT = 'rgba(255, 138, 61, 0.85)'

export interface SelectionHighlightInput {
  ctx: CanvasRenderingContext2D
  plan: MapRenderPlan
  document: MapDocument
  /** 选中项的 id（地块是格键） */
  id: string
  /** 当前六边形的栅格半径（线宽与虚线都按它缩放，缩放画布时观感一致） */
  targetRadius: number
  /** 对象自身的线宽（路径/区域用它撑开高亮，避免细线上高亮看不见） */
  objectWidth: number
}

/** 绘制函数返回 `true` 表示**真的画了**（对象不存在时返回 false，覆盖层据此统计） */
export type SelectionHighlight = (input: SelectionHighlightInput) => boolean

/** 画一条世界坐标折线（路径/区域共用） */
function strokeWorldPoints(
  ctx: CanvasRenderingContext2D,
  plan: MapRenderPlan,
  points: ReadonlyArray<[number, number]>,
  close: boolean,
): void {
  ctx.beginPath()
  points.forEach(([x, y], index) => {
    const point = worldToRaster(plan.layer, x, y)
    if (index === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  if (close) ctx.closePath()
  ctx.stroke()
}

/** 绘制表：**加新对象种类时在这里加一行** */
export const SELECTION_HIGHLIGHTS: Record<SelectionKind, SelectionHighlight> = {
  marker: drawPointHighlight,
  label: drawPointHighlight,

  path: ({ ctx, plan, document, id, targetRadius, objectWidth }) => {
    const path = plan.paths.find((item) => item.id === id)
    if (!path) return false
    // 虚线 + 比对象略粗：细线上也要看得见
    ctx.setLineDash([targetRadius * 0.45, targetRadius * 0.3])
    ctx.lineWidth = Math.max(2, objectWidth + targetRadius * 0.12)
    ctx.strokeStyle = SELECTION_ACCENT
    strokeWorldPoints(ctx, plan, path.pts, false)
    return true
  },

  region: ({ ctx, plan, document, id, targetRadius, objectWidth }) => {
    const region = plan.regions.find((item) => item.id === id)
    if (!region) return false
    ctx.setLineDash([targetRadius * 0.45, targetRadius * 0.3])
    ctx.lineWidth = Math.max(2, objectWidth + targetRadius * 0.12)
    ctx.strokeStyle = SELECTION_ACCENT
    strokeWorldPoints(ctx, plan, region.pts, true)
    return true
  },

  cell: ({ ctx, plan, document, id, targetRadius }) => {
    const axial = parseCellKey(id)
    if (axial === null || document.terrain[id] === undefined) return false
    const world = axialToWorld(document.grid, axial.q, axial.r)
    const center = worldToRaster(plan.layer, world.x, world.y)
    const corners = hexCorners(
      { kind: 'hex', orientation: document.grid.orientation, size: targetRadius, origin: [center.x, center.y] },
      0,
      0,
    )
    ctx.setLineDash([])
    ctx.lineWidth = Math.max(2, targetRadius * 0.09)
    ctx.beginPath()
    corners.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.closePath()
    // 地块用"淡填充 + 实线描边"：格子里还有地形图元，纯描边在深色地形上看不清
    ctx.globalAlpha = 0.25
    ctx.fillStyle = SELECTION_ACCENT_SOFT
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = SELECTION_ACCENT
    ctx.stroke()
    return true
  },
}

/** 标记与名称的高亮都是"围着它画一个圈"（两者的锚点语义不同，但高亮形状一致） */
function drawPointHighlight({ ctx, plan, document, id, targetRadius }: SelectionHighlightInput): boolean {
  const point =
    document.markers.find((item) => item.id === id) ?? document.labels.find((item) => item.id === id) ?? null
  if (point === null) return false
  const center = worldToRaster(plan.layer, point.p[0], point.p[1])
  ctx.setLineDash([])
  ctx.lineWidth = Math.max(2, targetRadius * 0.09)
  ctx.strokeStyle = SELECTION_ACCENT
  ctx.beginPath()
  ctx.arc(center.x, center.y, Math.max(8, targetRadius * 0.85), 0, Math.PI * 2)
  ctx.stroke()
  return true
}
