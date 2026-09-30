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
import {
  DEFAULT_LAYER_VISIBILITY,
  isLayerVisible,
  type LayerVisibility,
} from '../render/layerVisibility.ts'
import {
  DEFAULT_OVERLAY_STYLES,
  OVERLAY_FIELDS,
  OVERLAY_LABEL_BASELINE_RATIO,
  OVERLAY_LABEL_FONT,
  OVERLAY_LABEL_SCALE,
  type OverlayStyles,
} from '../render/overlayFields.ts'
import { buildOverlayPlan } from '../render/overlayPlan.ts'
import type { FieldPrimitive } from '../render/fieldPlan.ts'
import { encodeRgbaPngBase64, pngBase64Length } from '../render/pngEncode.ts'
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
  /**
   * 数值图层（温度 / 深度）的样式表（配色 / 不透明度 / 显示方式）。缺省 = 出厂样式。
   *
   * 与 `customTerrains` 同一口径：导出必须是"当前设置 + 当前地图"的合成结果。
   */
  overlayStyles?: OverlayStyles
  /**
   * **内联栅格的体积上限**（内联 data URL 的字符数）。缺省 `OVERLAY_RASTER_MAX_CHARS`（128 KiB）。
   *
   * 连续场的颜色面在导出里是一张内联 PNG；超过这个上限就**整层退回逐格多边形**（纯矢量）。
   * 做成可传的参数而不是写死常量，是为了让那条兜底分支**能被测到**（它按当前分辨率上限
   * 其实够不着，见 `OVERLAY_RASTER_MAX_CHARS` 的注释）；将来若把它做成设置项，接口也是现成的。
   */
  overlayRasterMaxChars?: number
  /**
   * 图层可见性。缺省 = 出厂值（**数值图层默认隐藏**）。
   *
   * 于是"关掉温度层"在导出里同样生效（工单 D 的验收之一）——
   * 与画布共用同一份开关，不存在"画布上关掉了、导出里还有"。
   */
  layers?: LayerVisibility
  /**
   * 叠加层是否画出**每格的数值文字**。缺省 `false` —— 导出要能看清地形，密铺的数字会把图糊住。
   *
   * 刻意**不给界面开关**（工单 D 的范围）：这一项存在是为了让"导出不写数值"这条口径
   * **只有一个执法点**（这里），而不是让渲染器偷偷丢掉 text 图元 ——
   * 后者会让那条断言变成空转（改了 `labels` 也不红），鉴别力实测时真的抓到过。
   */
  overlayLabels?: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 文本进 SVG 前的转义（`&` 必须最先换，否则会把后面生成的实体再转一次）。
 *
 * 收在一处：数值图层的数值文字与地图的名称文字走同一个函数 ——
 * 两处各写一遍，迟早出现"名称转义了、数值没转义"这种只在特殊字符上才发作的缺陷。
 */
function escapeSvgText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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

/**
 * 连续场颜色面的**内联体积上限**：内联 data URL 超过它，这一层就退回逐格多边形（纯矢量）。
 *
 * 为什么是 128 KiB：`MAX_FIELD_DIMENSION = 256` 允许的最大栅格（256×256）编成
 * （未压缩的）PNG 约 341 KiB base64 —— 那是"地图一大、导出的 SVG 变成十几 MB"的入口，
 * 所以给一条硬上限，超了就用矢量兜底（`DATA-LAYER-PLAN-v5.md` §0 D1 a3）。
 *
 * ⚠️ **实测：这条兜底按当前参数够不着**（如实记，别当成没写）。`DEFAULT_MAX_FIELD_CELLS = 16384`
 * 把采样点数压到 ≈128×128（≈86 KiB base64），而 128 KiB 对应 ≈24000 点 —— 也就是说
 * 分辨率上限已经比体积上限更早生效，兜底分支只在"有人调大采样上限"时才会走到。
 * 保留它的理由：① 体积上限是**导出策略**，不该依赖另一个模块的常数恰好够小；
 * ② 它的接口（`overlayRasterMaxChars`）正好是将来"采样上限做成设置"时要用的口子。
 */
export const OVERLAY_RASTER_MAX_CHARS = 128 * 1024

/** 数值图层颜色面在这一次导出里走了哪条路（"导出报告"要用，也是断言的对象） */
export type OverlayExportPath = 'raster' | 'vector' | 'cell'

export interface OverlayExportNote {
  /** 字段的**显示名**（`温度` / `深度 / 海拔`）—— 这一条要进给用户看的导出提示，所以用名字而不是 id */
  label: string
  /**
   * - `raster`：连续场，颜色面内联成 PNG（正常路径）；
   * - `vector`：连续场，但内联会超上限 → **整层退回逐格多边形**；
   * - `cell`：这一层本来就是逐格上色（没有颜色面，"哪条路"无从谈起）。
   */
  path: OverlayExportPath
  /** 内联 data URL 的字符数（只有 `raster` 非 0） */
  inlineChars: number
}

export interface MapPreviewBuild {
  svg: string
  /** 每个可见数值图层走了哪条路（按 `OVERLAY_FIELDS` 的顺序） */
  overlays: OverlayExportNote[]
}

/**
 * 导出报告里的那一句人话（"用了哪条路"）。
 *
 * 只提**做过选择的**层（连续场），逐格上色的层没有选择可说 —— 报告越长越没人看。
 * 没有任何连续场时返回空串，调用方据此决定要不要附加这一段。
 */
export function describeOverlayExport(notes: readonly OverlayExportNote[]): string {
  const parts: string[] = []
  for (const note of notes) {
    if (note.path === 'raster') parts.push(`${note.label}：内联栅格（${Math.ceil(note.inlineChars / 1024)} KiB）`)
    else if (note.path === 'vector') {
      parts.push(`${note.label}：退回矢量（内联会超过 ${Math.round(OVERLAY_RASTER_MAX_CHARS / 1024)} KiB 上限）`)
    }
  }
  return parts.length === 0 ? '' : `数值图层导出：${parts.join('；')}`
}

export function buildMapPreviewSvg(document: MapDocument | null, rows: readonly MapRow[], options: MapPreviewOptions): string {
  return buildMapPreviewSvgWithReport(document, rows, options).svg
}

export function buildMapPreviewSvgWithReport(
  document: MapDocument | null,
  rows: readonly MapRow[],
  options: MapPreviewOptions,
): MapPreviewBuild {
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
  /** 每个可见数值图层走了哪条路（导出报告用；也是"退回矢量"这条分支能被测到的唯一出口） */
  const overlays: OverlayExportNote[] = []
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

    // ---- 数值图层（温度 / 深度）：紧跟地形、在矢量对象之下（与画布的叠加次序同一条）----
    //
    // ⚠️ 几何**只能**来自 `buildOverlayPlan` → `fieldPlan`（画布那边也一样）。
    // 在这里重写一份逐格循环或插值，就会立刻出现"导出的图与画布不一样"，而且是长期缺陷。
    // 导出侧刻意**不写数值**（工单 D：导出要能看清地形），所以 `labels: false`。
    const overlayStyles = options.overlayStyles ?? DEFAULT_OVERLAY_STYLES
    const layers = options.layers ?? DEFAULT_LAYER_VISIBILITY
    const rasterBudget =
      typeof options.overlayRasterMaxChars === 'number' && Number.isFinite(options.overlayRasterMaxChars) && options.overlayRasterMaxChars > 0
        ? options.overlayRasterMaxChars
        : OVERLAY_RASTER_MAX_CHARS
    const overlayLabels = options.overlayLabels === true
    for (const spec of OVERLAY_FIELDS) {
      if (!isLayerVisible(layers, spec.layerId)) continue
      const style = overlayStyles[spec.id]
      const built = buildOverlayPlan({ document, spec, style, labels: overlayLabels })
      if (built.plan.primitives.length === 0) continue

      // ---- D1 a3：颜色面的**体积上限**（超了整层退回逐格多边形，纯矢量）----
      //
      // 判断在**编码之前**做（`pngBase64Length` 是 `pngEncode` 里与编码器同一条算式的纯函数），
      // 否则会白编一张几十万字节的图再丢掉。退回时**没有第二份几何实现** ——
      // 换一种显示方式重新问一次 `buildOverlayPlan`（同一份样本、同一个字段规格、同一套配色）。
      const raster = built.plan.primitives.find(
        (primitive): primitive is Extract<FieldPrimitive, { kind: 'raster' }> => primitive.kind === 'raster',
      )
      let primitives = built.plan.primitives
      let path: OverlayExportPath = raster === undefined ? 'cell' : 'raster'
      let inlineChars = 0
      if (raster !== undefined) {
        inlineChars = pngBase64Length(raster.cols, raster.rows)
        if (inlineChars > rasterBudget) {
          primitives = buildOverlayPlan({ document, spec, style: { ...style, mode: 'cell' }, labels: overlayLabels }).plan.primitives
          path = 'vector'
          inlineChars = 0
        }
      }
      overlays.push({ label: spec.label, path, inlineChars })
      if (primitives.length === 0) continue

      content.push(`<g data-fc-overlay="${spec.id}" fill="none">`)
      for (const primitive of primitives) {
        if (primitive.kind === 'polygon') {
          const points = primitive.points
            .map(([x, y]) => pointToSvgPoint(x, y, bounds, width, height, padding))
            .join(' ')
          content.push(
            `<polygon data-fc-primitive="polygon" points="${points}" fill="${primitive.color}" fill-opacity="${primitive.opacity}" />`,
          )
          continue
        }
        if (primitive.kind === 'polyline') {
          const points = primitive.points
            .map(([x, y]) => pointToSvgPoint(x, y, bounds, width, height, padding))
            .join(' ')
          // 线宽与虚线都是**世界单位**：乘上同一个比例（与区域边框那条换算同源）
          const dash =
            primitive.dash !== undefined && primitive.dash.length > 0
              ? ` stroke-dasharray="${primitive.dash.map((value) => (value * projection.scale).toFixed(2)).join(' ')}"`
              : ''
          content.push(
            `<polyline data-fc-primitive="polyline" points="${points}" stroke="${primitive.color}"` +
              ` stroke-width="${Math.max(0.5, primitive.width * projection.scale).toFixed(2)}"` +
              ` stroke-opacity="${primitive.opacity ?? 1}"${dash} stroke-linecap="round" stroke-linejoin="round" />`,
          )
          continue
        }
        // **连续场的颜色面**：SVG 里唯一能"原样铺一张连续渐变"的手段就是内联位图。
        // 编成 PNG 的 base64（`pngEncode.ts`，纯函数）再交给 `<image>` ——
        // 像素与画布侧是**同一份**（都由 `overlayPlan` 产出），所以两边长得一样。
        if (primitive.kind === 'raster') {
          const topLeft = pointToSvgPoint(primitive.x, primitive.y, bounds, width, height, padding)
          const bottomRight = pointToSvgPoint(
            primitive.x + primitive.width,
            primitive.y + primitive.height,
            bounds,
            width,
            height,
            padding,
          )
          const [x0, y0] = topLeft.split(',')
          const [x1, y1] = bottomRight.split(',')
          const data = encodeRgbaPngBase64(primitive.pixels, primitive.cols, primitive.rows)
          content.push(
            `<image data-fc-primitive="raster" x="${x0}" y="${y0}" width="${(Number(x1) - Number(x0)).toFixed(2)}"` +
              ` height="${(Number(y1) - Number(y0)).toFixed(2)}" preserveAspectRatio="none" opacity="${primitive.opacity}"` +
              ` href="data:image/png;base64,${data}" />`,
          )
          continue
        }
        // 数值文字（逐格模式默认不产出，连续场的**等值线标注**会产出）：
        // 必须真的画出来而不是静默跳过 —— "关掉逐格数值"只能由那一个 `labels` 开关决定
        // （鉴别力实测时正是靠着这一点才发现原来那条断言是空转的，见 §5.53）。
        const point = pointToSvgPoint(primitive.x, primitive.y, bounds, width, height, padding)
        const [textX, textY] = point.split(',')
        // 字号与居中口径与画布**同一条式子**（`OVERLAY_LABEL_*`），
        // 用等宽字体、`dy=0.35em` 把数字真正放到格心 / 线中（用户实机提的"不在正中间"）。
        // 等值线标签的字号**来自图元自己**（比格心读数小一档）——两边各算一次必然分叉（缝比字窄）。
        const labelScale = primitive.size !== undefined && primitive.size > 0 ? primitive.size : document.grid.size * OVERLAY_LABEL_SCALE
        const fontSize = Math.max(4, labelScale * projection.scale).toFixed(2)
        const labelStyle =
          ` font-family="${OVERLAY_LABEL_FONT}" font-size="${fontSize}" text-anchor="middle"` +
          ` dy="${OVERLAY_LABEL_BASELINE_RATIO}em"`
        // 等值线的数字**沿着线走**（工程图画法）：绕落点旋转。角度由 `fieldPlan.cutPolylineAt`
        // 按切线算好（已收进 ±90°，数字不会倒着看），两个后端只是各自照着画 —— 几何只有一份。
        const rotation =
          typeof primitive.rotation === 'number' && primitive.rotation !== 0
            ? ` transform="rotate(${((primitive.rotation * 180) / Math.PI).toFixed(3)} ${textX} ${textY})"`
            : ''
        // 描边**与字色相反**（白字配深边 / 深字配浅边）：写死白色会让浅色场上的深色数字糊成一坨
        // （用户实测报过"还是黑色的"，§A.4 口径已改）。
        const halo =
          primitive.haloColor !== undefined
            ? ` stroke="${primitive.haloColor}" stroke-width="${(Number(fontSize) * 0.3).toFixed(2)}" stroke-opacity="0.9" paint-order="stroke"`
            : ''
        content.push(
          `<text data-fc-primitive="text" x="${textX}" y="${textY}"${rotation}${labelStyle}${halo} fill="${primitive.color}">${escapeSvgText(primitive.text)}</text>`,
        )
      }
      content.push('</g>')
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
      const escaped = escapeSvgText(label.text)
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
  return { svg: content.join(''), overlays }
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
    /** 数值图层样式（配色 / 不透明度 / 显示方式）；缺省 = 出厂 */
    overlayStyles?: OverlayStyles
    /** 图层可见性；缺省 = 出厂（数值图层默认隐藏 → 导出里不出现叠加层） */
    layers?: LayerVisibility
    /**
     * 拿到"每个数值图层走了哪条路"（内联栅格 / 退回矢量）。
     *
     * 做成**回调**而不是改返回值：本函数的位置参数与返回类型是既有调用点与断言依赖的，
     * 而"导出报告"只有 `main.ts` 一处要用 —— 为一个消费者改签名，代价与风险都不对等。
     */
    onOverlayExport?: (notes: readonly OverlayExportNote[]) => void
  } = {},
): string {
  const built = buildMapPreviewSvgWithReport(document, [], {
    width,
    height,
    padding: 32,
    customTerrains,
    ...(bounds ? { bounds } : {}),
    ...(extras.customMarkers ? { customMarkers: extras.customMarkers } : {}),
    ...(extras.iconSvgFor ? { iconSvgFor: extras.iconSvgFor } : {}),
    ...(extras.overlayStyles ? { overlayStyles: extras.overlayStyles } : {}),
    ...(extras.layers ? { layers: extras.layers } : {}),
  })
  extras.onOverlayExport?.(built.overlays)
  return built.svg
}
