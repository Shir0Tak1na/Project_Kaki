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
import { resolveMarkerStyle, type CustomMarker } from '../render/markerCatalog.ts'
import { MARKER_ICON_SIZE } from '../render/markerPlacement.ts'
import { DEFAULT_PATH_CAP, DEFAULT_PATH_JOIN } from '../render/shapeStyle.ts'
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
  /**
   * 当前自定义标记（与 `customTerrains` 同理：导出必须是"当前设置 + 当前地图"的合成结果）。
   *
   * 它只用来**解析字形名**（`resolveMarkerStyle` 抹平内置 / 自定义 / 未知三种情况），
   * 真正的形状由 `iconSvgFor` 注入 —— 纯模块里拿不到 Obsidian 的图标集。
   */
  customMarkers?: readonly CustomMarker[]
  /**
   * 把一个 **Lucide 图标名** 变成一段 SVG 片段（`<path …/>` 之类），取不到就返回 `null`。
   *
   * 为什么注入而不是直接 import：本模块是纯模块（不 import obsidian），而图标形状只能由
   * Obsidian 的 `getIcon()` 拿到。注入方（`main.ts` / Base 视图）负责"取不到就返回 null"，
   * 于是回退链（**字形 → 兜底圆点**）留在这里、对两条链路都一样。
   *
   * ⚠️ 自定义标记的**图片模式不内联 base64**：导出文件要能脱离库单独打开，
   * 内联图片会让文件巨大。所以图片模式在这里回退成它的字形（与画布"图片挂了回退字形"同一条链）。
   */
  iconSvgFor?: (iconName: string) => string | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 世界 → SVG 的等比投影（缩略图与导出共用同一份，绝不各算一次） */
interface SvgProjection {
  scale: number
  offsetX: number
  offsetY: number
}

function svgProjection(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  padding: number,
): SvgProjection {
  const innerW = Math.max(1, width - padding * 2)
  const innerH = Math.max(1, height - padding * 2)
  const spanX = bounds.maxX - bounds.minX || 1
  const spanY = bounds.maxY - bounds.minY || 1
  // X/Y 使用同一个比例，避免世界地图被缩略图的长宽比拉伸。
  const scale = Math.min(innerW / spanX, innerH / spanY)
  const contentW = spanX * scale
  const contentH = spanY * scale
  return {
    scale,
    offsetX: padding + (innerW - contentW) / 2,
    offsetY: padding + (innerH - contentH) / 2,
  }
}

function pointToSvgPoint(x: number, y: number, bounds: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number, padding: number): string {
  const projection = svgProjection(bounds, width, height, padding)
  const px = projection.offsetX + (x - bounds.minX) * projection.scale
  const py = projection.offsetY + (y - bounds.minY) * projection.scale
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
/**
 * 标记字形的描边色（`marker.c` 没设时用）。
 *
 * 画布上默认是 `var(--fc-marker-color, var(--text-normal))` —— 跟随**主题**文字色；
 * 而导出文件要能脱离 Obsidian 单独打开，`currentColor` / 主题变量在那里无从解析，
 * 所以这里取一个固定深色（与旧兜底圆点的描边同色）：浅色地形上可读，且与主题无关。
 */
const MARKER_STROKE = '#111827'
/** Lucide 图标的坐标盒（`getIcon()` 给的就是 24×24，注入方不必换算） */
const LUCIDE_VIEWBOX = 24

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
  const customMarkers = options.customMarkers ?? []
  const iconSvgFor = options.iconSvgFor
  // 显式范围优先：导出"某个区域/当前视口"时，那个范围就是这次输出的全部视野
  const bounds = options.bounds ?? contentBounds(rows, document)
  // 世界 → SVG 的投影**算一次**：区域的边框宽度与虚线要按它换算（点坐标仍走 pointToSvgPoint）
  const projection = svgProjection(bounds, width, height, padding)
  const content: string[] = []
  content.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Map preview">`)

  if (document) {
    for (const [key, cell] of Object.entries(document.terrain)) {
      // 没有地形的格（只挂着温度 / 深度这类值）在导出里**不画地形**：它本来就没有地形
      if (typeof cell.t !== 'string') continue
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
      // 外观**全部取这一条区域自己存的值** —— 与画布 `drawRegion` 同一条口径，
      // 不在这里另写一套解析（本项目已经因为"抄一份调色板"出过一次真事故）：
      // - 不透明度直接就是 `fill-opacity`；0 是合法值（完全透明），缺省才回退；
      // - 边框宽度 0 / 缺省 = **不画边框**（旧区域本来就没有边框字段，画布也没给它画）；
      // - 边框色缺省**跟随填充色**；虚线用 `borderDash`（世界单位，乘同一个比例换算成 SVG 单位）。
      const opacity = Number.isFinite(region.opacity) ? clamp(region.opacity, 0, 1) : 0.28
      const borderWidth = region.borderWidth ?? 0
      const dash =
        borderWidth > 0 && region.borderDash !== undefined && region.borderDash.length > 0
          ? ` stroke-dasharray="${region.borderDash.map((value) => (value * projection.scale).toFixed(2)).join(' ')}"`
          : ''
      // 与画布同源的下限：画布是 `max(1, borderWidth * deviceScale)`（防亚像素线在光栅化后消失），
      // 这里只是把 `deviceScale` 换成导出的 `scale` —— 同一个式子，同一种观感。
      const stroke =
        borderWidth > 0
          ? ` stroke="${region.borderColor ?? fill}" stroke-width="${Math.max(1, borderWidth * projection.scale).toFixed(2)}"${dash}`
          : ' stroke="none"'
      content.push(
        `<polygon data-row-id="map:region:${region.id}" points="${points}" fill="${fill}" fill-opacity="${opacity}"${stroke} style="cursor:pointer" />`,
      )
    }

    for (const path of document.paths) {
      const points = pathPointsToSvg(path, bounds, width, height, padding)
      // 端点/连接用**这条路径自己存的**值；缺字段的旧路径取 round —— 与画布同一套默认值，
      // 否则"画布上平头、导出里圆头"这种不一致只有用户自己会发现
      const cap = path.cap ?? DEFAULT_PATH_CAP
      const join = path.join ?? DEFAULT_PATH_JOIN
      content.push(`<polyline data-row-id="map:path:${path.id}" points="${points}" fill="none" stroke="${path.color ?? '#4e9bd6'}" stroke-width="${Math.max(1.2, path.width / 14)}" stroke-linecap="${cap}" stroke-linejoin="${join}" style="cursor:pointer" />`)
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
      // 形状走**与画布同一份解析**（`resolveMarkerStyle` 把内置 / 自定义 / 未知抹平成同一个字形名），
      // 再由注入的 `iconSvgFor` 换成 SVG 片段；拿不到就退回旧的小圆点 —— 对象**绝不消失**。
      const glyphName = resolveMarkerStyle(marker.icon, customMarkers).iconName
      const fragment = iconSvgFor === undefined ? null : iconSvgFor(glyphName)
      if (fragment !== null && fragment.length > 0) {
        // 与画布同尺寸（`MARKER_ICON_SIZE`），并把 Lucide 的 24×24 坐标盒缩到那个尺寸
        const scale = MARKER_ICON_SIZE / LUCIDE_VIEWBOX
        const half = LUCIDE_VIEWBOX / 2
        content.push(
          `<g data-row-id="map:marker:${marker.id}" transform="translate(${x},${y}) scale(${scale.toFixed(4)}) translate(${-half},${-half})"` +
            ` fill="none" stroke="${marker.c ?? MARKER_STROKE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` +
            ` style="cursor:pointer">${fragment}</g>`,
        )
        continue
      }
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
  /**
   * 另外两样"来自设置 / 来自 Obsidian"的东西，**打包成一个参数**传进来。
   *
   * 为什么不再摊平成第 6、第 7 个位置参数：位置参数一多，调用点就开始出现
   * "把 bounds 传成了 customMarkers"这类只看类型看不出来的错。前面几个保持不变
   * （既有调用点与断言一行都不用改），新增的东西一律进这个对象。
   */
  extras: {
    customMarkers?: readonly CustomMarker[]
    iconSvgFor?: (iconName: string) => string | null
  } = {},
): string {
  return buildMapPreviewSvg(document, [], {
    width,
    height,
    padding: 32,
    customTerrains,
    ...(bounds ? { bounds } : {}),
    ...(extras.customMarkers ? { customMarkers: extras.customMarkers } : {}),
    ...(extras.iconSvgFor ? { iconSvgFor: extras.iconSvgFor } : {}),
  })
}
