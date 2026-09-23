/**
 * 渲染计划 —— 纯函数模块。
 *
 * 把「地图文档 + 客户端↔世界投影 + 视口矩形」翻译成一份**可断言的绘制清单**：
 * 覆盖层在宿主（`div.canvas`）局部坐标系里的位置与尺寸、光栅尺寸、
 * 以及需要绘制的格（已按视口裁剪）。
 *
 * 关键坐标事实（Phase 0 实测确认）：`div.canvas` 局部的 (0,0) 就是世界原点 ——
 * 各 `canvas-node` 的 `matrix(1,0,0,1,-420,-260)` 正是它在 .canvas 文件里的 x/y。
 * 因此覆盖层只要用世界坐标定位，就能与原生节点严格对齐（策略 A）。
 *
 * 光栅尺寸的取法：覆盖层的 CSS 尺寸用**世界单位**（父元素会按 scale 缩放它），
 * 而位图分辨率取「视口 CSS 尺寸 × devicePixelRatio」，
 * 于是最终落在屏幕上的像素密度始终是 1:1，缩放时不会糊。
 */

import { axialToWorld, parseCellKey } from '../core/hex.ts'
import { projectionWorldBBox, type ClientProjection } from '../core/projection.ts'
import type { BBox } from '../core/viewport.ts'
import type { MapDocument, PathType, TerrainType } from '../data/mapDocument.ts'
import { cellIntersectsBBox } from './hexGrid.ts'
import { bboxOverlaps, shapeBounds } from './shapeGeometry.ts'

export interface RenderPlanCell {
  q: number
  r: number
  /** 格心的世界坐标 */
  x: number
  y: number
  type: TerrainType
  /** 位标志（旋转/镜像/变体） */
  flags: number
  /** 覆盖色（覆盖地形默认底色） */
  color?: string
}

export interface RenderPlanLayer {
  /** 在宿主局部坐标（= 世界坐标）中的位置与尺寸 */
  left: number
  top: number
  widthWorld: number
  heightWorld: number
  /** 位图像素尺寸（视口 CSS 尺寸 × dpr） */
  rasterWidth: number
  rasterHeight: number
  /** 位图坐标 → 世界坐标的换算：world = left + rasterX / deviceScale */
  deviceScale: number
  /** 设备像素比：把"屏幕 CSS 像素"换算成"位图像素"（文字大小要用它） */
  devicePixelRatio: number
  /**
   * 位图像素 / 屏幕 CSS 像素（**实测值**，见 `MapOverlay.measureRasterScale()`）。
   *
   * 名称字号这类"屏幕空间"的量必须用它，而不是假设它等于 `devicePixelRatio`：
   * 位图与 CSS 尺寸之间的真实比例是浏览器说了算的，实测能吸收掉任何模型偏差。
   */
  rasterPxPerCssPx: number
  /** 名称字号倍率（用户设置，1 = 默认） */
  labelScale: number
  /**
   * 画名称用的字体族（**必须是已解析的字体列表**）。
   *
   * canvas 的 `font` 是 CSS font 简写，里面不能出现 `var()` —— 写了就是整条无效、
   * 赋值被静默忽略，字号会退回画布默认的 10 px。因此主题字体要在这一层解析好再传进来。
   */
  fontFamily: string
}

export interface RenderPlanPath {
  id: string
  type: PathType
  pts: Array<[number, number]>
  width: number
  color: string
  label?: string
  dash?: number[]
  taper?: boolean
  smooth?: boolean
}

export interface RenderPlanRegion {
  id: string
  label: string
  pts: Array<[number, number]>
  color: string
  opacity: number
  borderColor?: string
  borderWidth?: number
}

export interface MapRenderPlan {
  layer: RenderPlanLayer
  cells: RenderPlanCell[]
  /** 有地形但与视口不相交、被裁掉的格数（用于验证裁剪生效） */
  culledCells: number
  /** 视口内的路径与区域（矢量图形，与地形同帧绘制在同一个画布上） */
  paths: RenderPlanPath[]
  regions: RenderPlanRegion[]
  culledPaths: number
  culledRegions: number
  visibleWorld: BBox
}

export interface BuildRenderPlanOptions {
  document: MapDocument
  projection: ClientProjection
  viewportRect: { left: number; top: number; width: number; height: number }
  devicePixelRatio: number
  /** 实测的"位图像素 / 屏幕 CSS 像素"；缺省时退化为 devicePixelRatio */
  rasterPxPerCssPx?: number
  /** 名称字号倍率（用户设置） */
  labelScale?: number
  /** 已解析的字体族（不可含 var()） */
  fontFamily?: string
  /** 视口参数异常时用于拒绝生成计划 */
  maxCells?: number
}

/**
 * 生成渲染计划。
 *
 * 返回 `null` 表示当前状态不适合绘制（视口尺寸非法）。**不抛异常**：
 * 渲染层每一帧都会调用它，任何异常都会变成刷屏的错误。
 */
export function buildRenderPlan(options: BuildRenderPlanOptions): MapRenderPlan | null {
  const { document, projection, viewportRect, devicePixelRatio } = options
  const maxCells = options.maxCells ?? 200_000

  if (!(viewportRect.width > 0) || !(viewportRect.height > 0)) return null
  if (!(projection.scale > 0)) return null

  const visibleWorld = projectionWorldBBox(projection, viewportRect)
  const widthWorld = visibleWorld.maxX - visibleWorld.minX
  const heightWorld = visibleWorld.maxY - visibleWorld.minY
  if (!(widthWorld > 0) || !(heightWorld > 0)) return null

  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const rasterWidth = Math.max(1, Math.round(viewportRect.width * dpr))
  const rasterHeight = Math.max(1, Math.round(viewportRect.height * dpr))
  // 用精确的 scale×dpr，而不是 rasterWidth/widthWorld：
  // 后者会被位图尺寸的整数取整污染（相对误差可达 0.03%），让几何映射不再可预测。
  // 代价是位图被 CSS 拉伸不到 1 px，肉眼不可见。
  const deviceScale = projection.scale * dpr

  const cells: RenderPlanCell[] = []
  let culledCells = 0

  for (const [key, cell] of Object.entries(document.terrain)) {
    const axial = parseCellKey(key)
    if (axial === null) continue
    if (!cellIntersectsBBox(document.grid, axial.q, axial.r, visibleWorld)) {
      culledCells += 1
      continue
    }
    if (cells.length >= maxCells) {
      culledCells += 1
      continue
    }
    const world = axialToWorld(document.grid, axial.q, axial.r)
    const planCell: RenderPlanCell = {
      q: axial.q,
      r: axial.r,
      x: world.x,
      y: world.y,
      type: cell.t,
      flags: cell.f ?? 0,
    }
    if (cell.c !== undefined) planCell.color = cell.c
    cells.push(planCell)
  }

  // 路径与区域：按包围盒裁剪（矢量图形，不与格索引挂钩）
  const paths: RenderPlanPath[] = []
  let culledPaths = 0
  for (const path of document.paths) {
    const points = path.pts.map(([x, y]) => ({ x, y }))
    const bounds = shapeBounds(points, path.width / 2)
    if (bounds.empty || !bboxOverlaps(bounds, visibleWorld)) {
      culledPaths += 1
      continue
    }
    paths.push(path)
  }

  const regions: RenderPlanRegion[] = []
  let culledRegions = 0
  for (const region of document.regions) {
    const points = region.pts.map(([x, y]) => ({ x, y }))
    const bounds = shapeBounds(points, region.borderWidth ?? 0)
    if (bounds.empty || !bboxOverlaps(bounds, visibleWorld)) {
      culledRegions += 1
      continue
    }
    regions.push(region)
  }

  const rawRasterScale = options.rasterPxPerCssPx
  const rasterPxPerCssPx =
    typeof rawRasterScale === 'number' && Number.isFinite(rawRasterScale) && rawRasterScale > 0 ? rawRasterScale : dpr
  const rawLabelScale = options.labelScale
  const labelScale = typeof rawLabelScale === 'number' && Number.isFinite(rawLabelScale) && rawLabelScale > 0 ? rawLabelScale : 1
  const rawFontFamily = typeof options.fontFamily === 'string' ? options.fontFamily.trim() : ''
  // 防御性过滤：var() 会让整条 ctx.font 非法（字号静默退回默认值），这里直接挡掉
  const fontFamily = rawFontFamily.length > 0 && !rawFontFamily.includes('var(') ? rawFontFamily : 'sans-serif'

  return {
    layer: {
      left: visibleWorld.minX,
      top: visibleWorld.minY,
      widthWorld,
      heightWorld,
      rasterWidth,
      rasterHeight,
      deviceScale,
      devicePixelRatio: dpr,
      rasterPxPerCssPx,
      labelScale,
      fontFamily,
    },
    cells,
    culledCells,
    paths,
    regions,
    culledPaths,
    culledRegions,
    visibleWorld,
  }
}

/** 世界坐标 → 覆盖层位图坐标 */
export function worldToRaster(layer: RenderPlanLayer, x: number, y: number): { x: number; y: number } {
  return { x: (x - layer.left) * layer.deviceScale, y: (y - layer.top) * layer.deviceScale }
}
