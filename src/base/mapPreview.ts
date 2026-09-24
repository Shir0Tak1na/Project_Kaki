/**
 * Base 视图的地图预览：把地图数据和笔记坐标合成一个简单的 SVG 预览。
 *
 * 这是 Phase 3 的下一步：在 Base 表格中不只是列数据，还能直接看到地图的大致轮廓与标记位置。
 * 设计上保持轻量：不依赖 Obsidian，不做复杂交互；重点是生成一个稳定、可验证、可嵌入 DOM 的预览。
 */

import { hexCorners, parseCellKey } from '../core/hex.ts'
import type { BBox } from '../core/viewport.ts'
import type { MapDocument, MapPath, MapRegion } from '../data/mapDocument.ts'
import { resolveTerrainStyle, type CustomTerrain } from '../render/terrainCatalog.ts'
import type { MapRow } from './mapRows.ts'

export interface MapPreviewOptions {
  width: number
  height: number
  padding?: number
  /**
   * 用户自定义地形。缺省即只有内置 9 种 —— 于是"设置里新增/改色"会立刻反映到
   * Base 缩略图与导出的 SVG 上，不需要重建 Base 或重新导出（导出是命令触发的，本来就现读）。
   */
  customTerrains?: readonly CustomTerrain[]
  /**
   * 显式指定世界包围盒（导出范围）。
   *
   * 缺省时按"全部内容"自动计算（缩略图与老行为）。给了就用它：
   * 范围**只改变世界 → 画布的映射**，内容仍然全部绘制，**超出范围的部分由 SVG 的 viewport
   * 自然裁掉** —— 刻意不写"先裁剪内容"的逻辑，那要复制一套几何判断，而每处判断都是新的出错点。
   */
  bounds?: BBox
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function pointToSvgPoint(x: number, y: number, bounds: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number, padding: number): string {
  const innerW = Math.max(1, width - padding * 2)
  const innerH = Math.max(1, height - padding * 2)
  const spanX = bounds.maxX - bounds.minX || 1
  const spanY = bounds.maxY - bounds.minY || 1
  // X/Y 使用同一个比例，避免世界地图被缩略图的长宽比拉伸。
  const scale = Math.min(innerW / spanX, innerH / spanY)
  const contentW = spanX * scale
  const contentH = spanY * scale
  const offsetX = padding + (innerW - contentW) / 2
  const offsetY = padding + (innerH - contentH) / 2
  const px = offsetX + (x - bounds.minX) * scale
  const py = offsetY + (y - bounds.minY) * scale
  return `${px.toFixed(2)},${py.toFixed(2)}`
}

/**
 * 「全部内容」的包围盒：地形格取**六边形顶点**（而不是格心，否则边缘会顶到画布边上），
 * 标记/文字/路径/区域取它们自己的坐标，笔记行取它们的点。
 *
 * 导出范围功能要用它（`all` 范围、以及"没有内容"时的兜底），所以从这里导出而不是各写一份：
 * 两处各算一次，迟早会出现"缩略图和导出的范围不一样"。
 */
export function contentBounds(rows: readonly MapRow[], document: MapDocument | null): BBox {
  const points: Array<[number, number]> = []

  if (document) {
    for (const key of Object.keys(document.terrain)) {
      const cell = parseCellKey(key)
      if (cell) points.push(...hexCorners(document.grid, cell.q, cell.r).map((point): [number, number] => [point.x, point.y]))
    }
    for (const marker of document.markers) points.push([marker.p[0], marker.p[1]])
    for (const label of document.labels) points.push([label.p[0], label.p[1]])
    for (const path of document.paths) points.push(...path.pts)
    for (const region of document.regions) points.push(...region.pts)
  }

  for (const row of rows) {
    if (row.point) points.push([row.point.x, row.point.y])
  }

  if (points.length === 0) {
    return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  }

  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

/**
 * 地形底色**必须**取自与画布**同一份**解析结果（`resolveTerrainStyle`）。
 *
 * 这里曾经自己抄了一份调色板，结果 9 种颜色与画布上的**全部**不同 ——
 * 表现就是"Base 缩略图和导出 SVG 的颜色跟画布上不一样"，而且改一处不会同步另一处。
 * 现在连自定义地形与未知 ID 的回退色也走同一条路：唯一真相来源比"看起来差不多"重要。
 *
 * 注意：SVG 里**不嵌图片**（自定义地形配了图片时这里只画底色）。
 * 原因是导出文件要能脱离库单独打开，而库内图片的资源地址（`app://…`）换个环境就失效；
 * 想把图片一起带走需要把图片读成 base64 内联，那是 Phase 4「PNG 导出」要一起做的事。
 */
function terrainFill(type: string, customTerrains: readonly CustomTerrain[]): string {
  return resolveTerrainStyle(type, customTerrains).base
}

/** 标记 / 笔记点的填充色（与区域、路径的专属图形区分开） */
const MARKER_FILL = '#f2d38d'
const NOTE_FILL = '#8bc6ff'

function pathPointsToSvg(path: MapPath, bounds: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number, padding: number): string {
  return path.pts.map(([x, y]) => pointToSvgPoint(x, y, bounds, width, height, padding)).join(' ')
}

function regionPointsToSvg(region: MapRegion, bounds: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number, padding: number): string {
  return region.pts.map(([x, y]) => pointToSvgPoint(x, y, bounds, width, height, padding)).join(' ')
}

export function buildMapPreviewSvg(document: MapDocument | null, rows: readonly MapRow[], options: MapPreviewOptions): string {
  const widthValue = typeof options.width === 'number' && Number.isFinite(options.width) ? options.width : 200
  const heightValue = typeof options.height === 'number' && Number.isFinite(options.height) ? options.height : 120
  const paddingValue = typeof options.padding === 'number' && Number.isFinite(options.padding) ? options.padding : 12
  const width = clamp(widthValue, 64, 2000)
  const height = clamp(heightValue, 48, 2000)
  const padding = clamp(paddingValue, 0, 40)
  const customTerrains = options.customTerrains ?? []
  // 显式范围优先：导出"某个区域/当前视口"时，那个范围就是这次输出的全部视野
  const bounds = options.bounds ?? contentBounds(rows, document)
  const content: string[] = []
  content.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Map preview">`)

  if (document) {
    for (const [key, cell] of Object.entries(document.terrain)) {
      const axial = parseCellKey(key)
      if (!axial) continue
      const points = hexCorners(document.grid, axial.q, axial.r)
        .map((point) => pointToSvgPoint(point.x, point.y, bounds, width, height, padding))
        .join(' ')
      content.push(`<polygon points="${points}" fill="${terrainFill(cell.t, customTerrains)}" stroke="rgba(17,24,39,0.28)" stroke-width="0.6" />`)
    }

    for (const region of document.regions) {
      const points = regionPointsToSvg(region, bounds, width, height, padding)
      const fill = region.color ?? '#7ab77b'
      content.push(`<polygon data-row-id="map:region:${region.id}" points="${points}" fill="${fill}" fill-opacity="0.28" stroke="${fill}" stroke-width="1.2" style="cursor:pointer" />`)
    }

    for (const path of document.paths) {
      const points = pathPointsToSvg(path, bounds, width, height, padding)
      content.push(`<polyline data-row-id="map:path:${path.id}" points="${points}" fill="none" stroke="${path.color ?? '#4e9bd6'}" stroke-width="${Math.max(1.2, path.width / 14)}" stroke-linecap="round" stroke-linejoin="round" style="cursor:pointer" />`)
    }

    for (const label of document.labels) {
      const point = pointToSvgPoint(label.p[0], label.p[1], bounds, width, height, padding)
      const [x, y] = point.split(',')
      const escaped = label.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      // fill 必须显式给出：SVG 的 fill 默认是黑色，在深色主题的 Base 里等于看不见。
      // 用 currentColor，让内联预览跟随主题（导出成独立文件时 currentColor 退化为黑色，也可读）。
      content.push(
        `<text data-row-id="map:label:${label.id}" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="currentColor" class="fc-preview-label" style="cursor:pointer">${escaped}</text>`,
      )
    }

    for (const marker of document.markers) {
      const point = pointToSvgPoint(marker.p[0], marker.p[1], bounds, width, height, padding)
      const [x, y] = point.split(',')
      content.push(
        `<circle data-row-id="map:marker:${marker.id}" cx="${x}" cy="${y}" r="3" fill="${MARKER_FILL}" stroke="#111827" stroke-width="1" style="cursor:pointer" />`,
      )
    }
  }

  // 只有**笔记**行才补一个通用圆点：地图自己的标记/文字/路径/区域上面已经有专属图形了，
  // 再画一遍会盖掉标记原本的颜色，还会产生重复的 data-row-id（点击命中的是哪一个就说不清了）。
  for (const row of rows) {
    if (!row.point || row.source !== 'note') continue
    const point = pointToSvgPoint(row.point.x, row.point.y, bounds, width, height, padding)
    const [x, y] = point.split(',')
    content.push(
      `<circle data-row-id="${row.id}" cx="${x}" cy="${y}" r="3" fill="${NOTE_FILL}" stroke="#111827" stroke-width="1" style="cursor:pointer" />`,
    )
  }

  content.push('</svg>')
  return content.join('')
}

/**
 * 生成地图导出 SVG。导出与缩略图共用同一套世界坐标和等比例投影，避免两套渲染产生偏差。
 *
 * `customTerrains` 由调用方从插件设置里现读：导出必须是"当前设置 + 当前地图"的合成结果，
 * 否则刚改完颜色导出出来的还是旧色。
 *
 * `bounds` 是**导出范围**（见 `exportBounds.ts`）：不传就导全部内容（老行为）。
 * 参数保持位置式而不是换成 options 对象，是为了让既有调用点与断言一行都不用改。
 */
export function buildMapExportSvg(
  document: MapDocument,
  width = 1600,
  height = 1000,
  customTerrains: readonly CustomTerrain[] = [],
  bounds?: BBox,
): string {
  return buildMapPreviewSvg(document, [], { width, height, padding: 32, customTerrains, ...(bounds ? { bounds } : {}) })
}
