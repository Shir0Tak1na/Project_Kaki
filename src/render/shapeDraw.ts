/**
 * 路径与区域的 canvas 绘制 —— 薄封装层。
 *
 * 几何计算（平滑、变宽、包围盒、命中测试、展平、弧长取点）都在 `shapeGeometry.ts` 里且可单元测试；
 * 这里只负责把结果翻译成 canvas 调用，因此逻辑刻意保持最少。
 *
 * 坐标：世界坐标 → 位图坐标一律经 `worldToRaster()`（与地形同一套变换），
 * 这样矢量图形与地形、与原生节点都严格对齐。
 */

import type { Point } from '../core/hex.ts'
import type { MapDraft } from '../editor/MapEditor.ts'
import { DEFAULT_PATH_CAP, DEFAULT_PATH_JOIN } from './shapeStyle.ts'
import type { RenderPlanLayer, RenderPlanPath, RenderPlanRegion } from './renderPlan.ts'
import { worldToRaster } from './renderPlan.ts'
import {
  buildLinearCommands,
  buildSmoothCommands,
  pointAtArcLength,
  polygonAnchor,
  polylineLength,
  polylineMidpoint,
  taperedWidths,
  visiblePolyline,
  type PathCommand,
} from './shapeGeometry.ts'

/** 已换算到位图坐标的绘制命令 */
type RasterCommand =
  | { kind: 'moveTo' | 'lineTo'; x: number; y: number }
  | { kind: 'bezierTo'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }

function mapCommands(commands: PathCommand[], layer: RenderPlanLayer): RasterCommand[] {
  return commands.map((command) => {
    if (command.kind === 'moveTo' || command.kind === 'lineTo') {
      const point = worldToRaster(layer, command.x, command.y)
      return { kind: command.kind, x: point.x, y: point.y }
    }
    const c1 = worldToRaster(layer, command.c1x, command.c1y)
    const c2 = worldToRaster(layer, command.c2x, command.c2y)
    const end = worldToRaster(layer, command.x, command.y)
    return { kind: 'bezierTo', c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x: end.x, y: end.y }
  })
}

function traceCommands(ctx: CanvasRenderingContext2D, commands: RasterCommand[]): void {
  ctx.beginPath()
  for (const command of commands) {
    if (command.kind === 'bezierTo') ctx.bezierCurveTo(command.c1x, command.c1y, command.c2x, command.c2y, command.x, command.y)
    else if (command.kind === 'moveTo') ctx.moveTo(command.x, command.y)
    else ctx.lineTo(command.x, command.y)
  }
}

function traceWorldPolyline(ctx: CanvasRenderingContext2D, layer: RenderPlanLayer, points: readonly Point[]): void {
  ctx.beginPath()
  points.forEach((point, index) => {
    const raster = worldToRaster(layer, point.x, point.y)
    if (index === 0) ctx.moveTo(raster.x, raster.y)
    else ctx.lineTo(raster.x, raster.y)
  })
}

/**
 * 曲线路径的稠密折线（世界坐标）。
 *
 * 变宽描边必须逐段画，而"逐段"只能用折线上的点 —— 因此河流在描边前先展平。
 * 名称排版也用同一条折线，保证文字贴着**画出来的**曲线，而不是贴着控制点。
 */
function denseWorldPolyline(points: Point[], smooth: boolean): Point[] {
  return visiblePolyline(points, smooth)
}

/**
 * 沿稠密折线逐段描边，实现"末端变细"。
 *
 * canvas 的 `lineWidth` 是整条路径统一的，所以只能一段一次 `stroke()`；
 * 段间靠圆头连接保持视觉连续。展平后的段数由 `flattenSteps()` 限死。
 */
function strokeTapered(ctx: CanvasRenderingContext2D, layer: RenderPlanLayer, dense: Point[], baseWidth: number): void {
  const widths = taperedWidths(baseWidth, dense.length - 1)
  for (let index = 0; index < dense.length - 1; index += 1) {
    const from = worldToRaster(layer, dense[index]!.x, dense[index]!.y)
    const to = worldToRaster(layer, dense[index + 1]!.x, dense[index + 1]!.y)
    ctx.lineWidth = Math.max(1, (widths[index] ?? baseWidth) * layer.deviceScale)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }
}

// ---------------------------------------------------------------- 名称排版

/**
 * 名称字号策略（单位：**屏幕 CSS 像素**）。
 *
 * 名称是标注：它随缩放变大，但绝不缩到看不见。常见缩放（约 45%）下
 * `base × scale` 会落到下限，所以**下限就是用户实际看到的字号** ——
 * 这个数偏小会被立刻察觉（初版 11 px、第二版 15 px 都被判为过小），因此给得比较大方。
 */
export const PATH_LABEL = { base: 28, min: 20, max: 46 }
export const REGION_LABEL = { base: 34, min: 24, max: 52 }

/**
 * 位图像素 / 屏幕 CSS 像素。
 *
 * 不用 `devicePixelRatio` 硬算，而是用**实测值**（覆盖层画布的位图宽度 ÷ 它的屏幕宽度，
 * 见 `MapOverlay.measureRasterScale()`）：任何"我把位图和 CSS 尺寸想错了"的偏差都会
 * 被这一步吸收掉 —— 我们承诺的是"N 个 CSS 像素"，那就必须是 N 个 CSS 像素。
 */
function rasterScale(layer: RenderPlanLayer): number {
  const measured = layer.rasterPxPerCssPx
  if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) return measured
  return layer.devicePixelRatio > 0 ? layer.devicePixelRatio : 1
}

function zoomOf(layer: RenderPlanLayer): number {
  const dpr = layer.devicePixelRatio > 0 ? layer.devicePixelRatio : 1
  return layer.deviceScale / dpr
}

/** 名称在屏幕上的字号（CSS px）—— 诊断命令与设置界面都读它 */
export function labelCssPx(layer: RenderPlanLayer, kind: 'path' | 'region'): number {
  const policy = kind === 'path' ? PATH_LABEL : REGION_LABEL
  const scale = typeof layer.labelScale === 'number' && layer.labelScale > 0 ? layer.labelScale : 1
  const raw = Math.max(policy.min, Math.min(policy.max, policy.base * zoomOf(layer))) * scale
  return Math.round(raw)
}

/** 名称的位图字号 */
function labelFontPx(layer: RenderPlanLayer, policy: { base: number; min: number; max: number }): number {
  const kind = policy === REGION_LABEL ? 'region' : 'path'
  return labelCssPx(layer, kind) * rasterScale(layer)
}

/** 兜底字体族：任何情况下都必须是一个**不带 var() 的合法字体列表** */
const FALLBACK_FONT_FAMILY = 'sans-serif'

/**
 * 设置画布字体。
 *
 * ⚠️ 这里有一个非常隐蔽、且已经真实坑过一次的陷阱：
 * **`ctx.font` 是 CSS `font` 简写，里面不能出现 `var()`**（画布没有元素上下文可供替换）。
 * 一旦写上 `var(--font-interface, sans-serif)`，整条声明就是**非法**的，
 * 而非法赋值的后果是**静默忽略**（画布继续用上一个字体，初值是默认的 `10px sans-serif`）。
 *
 * 症状极具迷惑性：字号常量改了完全没反应，只有线宽（普通数值属性）会变 ——
 * 用户看到的正是"只有阴影在变化"。
 *
 * 因此这里做两件事：
 * 1. 字体族由调用方**解析好**再传进来（`layer.fontFamily`，来自 getComputedStyle）；
 * 2. 赋值后**读回校验**字号，不合格就退到最朴素的 `sans-serif` ——
 *    宁可字体族不跟随主题，也不能让字号悄悄退回 10 px。
 */
function applyLabelFont(ctx: CanvasRenderingContext2D, fontPx: number, layer: RenderPlanLayer): void {
  const family = typeof layer.fontFamily === 'string' && layer.fontFamily.trim().length > 0 ? layer.fontFamily : FALLBACK_FONT_FAMILY
  ctx.font = `600 ${fontPx}px ${family}`
  if (!fontSizeApplied(ctx, fontPx)) {
    ctx.font = `600 ${fontPx}px ${FALLBACK_FONT_FAMILY}`
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
}

/** 读回 `ctx.font` 校验字号是否真的生效（非法字体串会被浏览器整条忽略） */
function fontSizeApplied(ctx: CanvasRenderingContext2D, fontPx: number): boolean {
  const applied = /(\d+(?:\.\d+)?)px/.exec(String(ctx.font ?? ''))
  if (!applied) return false
  return Math.abs(Number(applied[1]) - fontPx) < 0.5
}

/** 带描边光晕的一段文字（已经由调用方完成旋转/平移） */
function paintRun(ctx: CanvasRenderingContext2D, text: string, color: string, fontPx: number, halo: string): void {
  // 光晕宽度取字号的 1/8：字号大时不会糊成一团黑边，字号小时仍有最低 2 px 保底
  ctx.lineWidth = Math.max(2, fontPx / 8)
  ctx.strokeStyle = halo
  ctx.strokeText(text, 0, 0)
  ctx.fillStyle = color
  ctx.fillText(text, 0, 0)
}

/**
 * 带描边光晕的**水平**文字：地图背景颜色不可控（地形可能是深绿也可能是沙黄），
 * 单靠填充色很难保证可读，因此在文字底下描一圈深色/浅色边。
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  layer: RenderPlanLayer,
  x: number,
  y: number,
  text: string,
  color: string,
  fontPx: number,
  halo: string,
): void {
  applyLabelFont(ctx, fontPx, layer)
  ctx.save()
  ctx.translate(x, y)
  paintRun(ctx, text, color, fontPx, halo)
  ctx.restore()
}

interface GlyphPlacement {
  char: string
  x: number
  y: number
  angle: number
}

/**
 * 让文字**顺着线条走**：逐字沿弧长摆放，每个字按所在处的切线旋转。
 *
 * 三个必须处理的细节：
 * 1. **阅读方向**：路径可能是从右往左画的。此时若还按弧长顺序摆放，字的左右顺序会反过来，
 *    因此先用首尾弦判定方向，必要时把折线整体反转。
 * 2. **不让字倒着**：切线朝左时把角度翻 180°（`cos < 0`），保证每个字都是正的可读朝向。
 * 3. **文字比线条长**：放不下就返回 null，由调用方退化为"单个旋转文字"，
 *    总比挤成一团或溢出到线外好。
 */
function layoutAlongPath(
  ctx: CanvasRenderingContext2D,
  layer: RenderPlanLayer,
  dense: Point[],
  text: string,
  fontPx: number,
  offsetPx: number,
): GlyphPlacement[] | null {
  const chars = Array.from(text)
  if (chars.length === 0) return null

  const first = dense[0]!
  const last = dense[dense.length - 1]!
  // 首尾弦指向左（或纯向上）时反转，让弧长顺序 == 阅读顺序
  const reversed = last.x < first.x || (last.x === first.x && last.y < first.y)
  const line = reversed ? [...dense].reverse() : dense
  const total = polylineLength(line)
  if (total <= 0) return null

  applyLabelFont(ctx, fontPx, layer)
  const spacing = fontPx * 0.06
  const widths = chars.map((char) => ctx.measureText(char).width)
  const textWidth = widths.reduce((sum, width) => sum + width, 0) + spacing * (chars.length - 1)
  if (textWidth > total) return null

  const out: GlyphPlacement[] = []
  let travelled = total / 2 - textWidth / 2
  for (let index = 0; index < chars.length; index += 1) {
    const width = widths[index]!
    const anchor = pointAtArcLength(line, travelled + width / 2)
    if (anchor) {
      let angle = Math.atan2(anchor.tangent.y, anchor.tangent.x)
      if (Math.cos(angle) < 0) angle += Math.PI
      // 法线朝上（屏幕 y 向下），把字抬到线条上方
      let normalX = -Math.sin(angle)
      let normalY = Math.cos(angle)
      if (normalY > 0) {
        normalX = -normalX
        normalY = -normalY
      }
      const center = worldToRaster(layer, anchor.point.x, anchor.point.y)
      out.push({
        char: chars[index]!,
        x: center.x + normalX * offsetPx,
        y: center.y + normalY * offsetPx,
        angle,
      })
    }
    travelled += width + spacing
  }
  return out
}

/** 退化情形：整段文字作为一个整体，按中点切线旋转一次 */
function drawRotatedRun(
  ctx: CanvasRenderingContext2D,
  layer: RenderPlanLayer,
  dense: Point[],
  text: string,
  color: string,
  fontPx: number,
  halo: string,
  offsetPx: number,
): void {
  const anchor = polylineMidpoint(dense)
  if (!anchor) return
  let angle = Math.atan2(anchor.tangent.y, anchor.tangent.x)
  if (Math.cos(angle) < 0) angle += Math.PI
  let normalX = -Math.sin(angle)
  let normalY = Math.cos(angle)
  if (normalY > 0) {
    normalX = -normalX
    normalY = -normalY
  }
  const center = worldToRaster(layer, anchor.point.x, anchor.point.y)
  applyLabelFont(ctx, fontPx, layer)
  ctx.save()
  ctx.translate(center.x + normalX * offsetPx, center.y + normalY * offsetPx)
  ctx.rotate(angle)
  paintRun(ctx, text, color, fontPx, halo)
  ctx.restore()
}

/** 路径名称：贴着曲线逐字摆放；放不下时退化为整体旋转 */
function drawPathLabel(
  ctx: CanvasRenderingContext2D,
  layer: RenderPlanLayer,
  dense: Point[],
  path: RenderPlanPath,
): void {
  const text = path.label ?? ''
  if (text.length === 0) return
  const fontPx = labelFontPx(layer, PATH_LABEL)
  // 抬到线条上方：半个线宽 + 一点余量（余量用 CSS px，不随缩放变化）
  const offsetPx = (path.width / 2) * layer.deviceScale + 7 * rasterScale(layer)
  const glyphs = layoutAlongPath(ctx, layer, dense, text, fontPx, offsetPx)

  if (glyphs === null) {
    drawRotatedRun(ctx, layer, dense, text, '#ffffff', fontPx, 'rgba(0, 0, 0, 0.65)', offsetPx)
    return
  }

  applyLabelFont(ctx, fontPx, layer)
  ctx.lineWidth = Math.max(2, fontPx / 8)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)'
  ctx.fillStyle = '#ffffff'
  for (const glyph of glyphs) {
    ctx.save()
    ctx.translate(glyph.x, glyph.y)
    ctx.rotate(glyph.angle)
    ctx.strokeText(glyph.char, 0, 0)
    ctx.fillText(glyph.char, 0, 0)
    ctx.restore()
  }
}

// ---------------------------------------------------------------- 区域 / 路径

/** 区域：半透明填充 + 边界 + 名称（名称画在多边形重心附近） */
export function drawRegion(
  ctx: CanvasRenderingContext2D,
  layer: RenderPlanLayer,
  region: RenderPlanRegion,
  showLabel = true,
): void {
  if (region.pts.length < 3) return
  const worldPoints = region.pts.map(([x, y]) => ({ x, y }))
  const commands = mapCommands(buildLinearCommands(worldPoints), layer)

  traceCommands(ctx, commands)
  ctx.closePath()
  ctx.globalAlpha = Math.max(0, Math.min(1, region.opacity))
  ctx.fillStyle = region.color
  ctx.fill()
  ctx.globalAlpha = 1

  const borderWidth = region.borderWidth ?? 0
  if (borderWidth > 0) {
    ctx.strokeStyle = region.borderColor ?? region.color
    ctx.lineWidth = Math.max(1, borderWidth * layer.deviceScale)
    ctx.lineJoin = 'round'
    traceCommands(ctx, commands)
    ctx.closePath()
    ctx.stroke()
  }

  if (showLabel && region.label.length > 0) {
    const anchor = polygonAnchor(worldPoints)
    if (anchor) {
      const point = worldToRaster(layer, anchor.x, anchor.y)
      drawLabel(ctx, layer, point.x, point.y, region.label, '#ffffff', labelFontPx(layer, REGION_LABEL), 'rgba(0, 0, 0, 0.65)')
    }
  }
}

/**
 * 路径：河流（平滑 + 末端变细）/ 道路与边界（虚线）。
 *
 * 平滑路径有两条绘制分支，但**几何是同一条**：
 * - 变宽（河流）必须逐段描边，因此先把曲线展平成稠密折线；
 * - 不变宽时直接交给 `bezierCurveTo`。
 * 两者都由 `buildSmoothCommands()` 生成，因此形状完全一致 ——
 * 曾经这里的分支直接连原始顶点，导致河流在提交后从曲线变成折线。
 */
export function drawPath(
  ctx: CanvasRenderingContext2D,
  layer: RenderPlanLayer,
  path: RenderPlanPath,
  showLabel = true,
): void {
  const points: Point[] = path.pts.map(([x, y]) => ({ x, y }))
  if (points.length < 2) return

  const smooth = path.smooth === true
  const commands = mapCommands(smooth ? buildSmoothCommands(points) : buildLinearCommands(points), layer)
  const label = path.label ?? ''
  const hasLabel = showLabel && label.length > 0
  const needsDense = path.taper === true || hasLabel
  const dense = needsDense ? denseWorldPolyline(points, smooth) : null

  // 端点/连接：**这条路径自己存的**样式（画的时候从设置抄进文件），缺字段的旧路径取默认值 ——
  // 也就是升级前硬编码的 round/round，于是老地图的观感一点没变。
  ctx.lineCap = path.cap ?? DEFAULT_PATH_CAP
  ctx.lineJoin = path.join ?? DEFAULT_PATH_JOIN
  ctx.strokeStyle = path.color
  if (path.dash && path.dash.length > 0) {
    ctx.setLineDash(path.dash.map((value) => value * layer.deviceScale))
  } else {
    ctx.setLineDash([])
  }

  if (path.taper === true && dense) {
    strokeTapered(ctx, layer, dense, path.width)
  } else {
    ctx.lineWidth = Math.max(1, path.width * layer.deviceScale)
    traceCommands(ctx, commands)
    ctx.stroke()
  }
  ctx.setLineDash([])

  if (hasLabel) drawPathLabel(ctx, layer, dense ?? points, path)
}

/**
 * 草稿预览：已确定的顶点 + 顶点手柄 + 到光标的橡皮筋。
 * 区域还会画半透明填充，让用户提前看到形状。
 *
 * 预览的几何必须与提交后的渲染一致（WYSIWYG），否则"松手的一瞬间形状会变"：
 * - 路径：与 `drawPath` 走同一套平滑/变宽逻辑。变宽预览**不加虚线**，
 *   因为逐段描边会让虚线每段重新开始，看起来像噪点；此时形状本身就是最准确的提示。
 * - 区域：折线 + 半透明填充。
 */
export function drawDraft(ctx: CanvasRenderingContext2D, layer: RenderPlanLayer, draft: MapDraft): void {
  const points = draft.points
  if (points.length === 0) return

  const raster = points.map((point) => worldToRaster(layer, point.x, point.y))
  const cursor = draft.cursor ? worldToRaster(layer, draft.cursor.x, draft.cursor.y) : null

  const all = cursor ? [...raster, cursor] : raster

  if (draft.kind === 'region' && all.length >= 3) {
    traceWorldPolyline(ctx, layer, draft.cursor ? [...points, draft.cursor] : points)
    ctx.closePath()
    ctx.globalAlpha = 0.18
    ctx.fillStyle = draft.color
    ctx.fill()
    ctx.globalAlpha = 1
  }

  ctx.strokeStyle = draft.color
  ctx.lineWidth = Math.max(1.5, draft.width * layer.deviceScale)
  // 预览也照抄当前类型的端点/连接（见 MapDraft.cap / join）
  ctx.lineCap = draft.cap
  ctx.lineJoin = draft.join

  if (draft.kind === 'path') {
    const worldPoints = draft.cursor ? [...points, draft.cursor] : points
    const smooth = draft.smooth === true && worldPoints.length >= 3
    const dense = denseWorldPolyline(worldPoints, smooth)
    if (draft.taper === true && dense.length >= 2) {
      ctx.setLineDash([])
      strokeTapered(ctx, layer, dense, draft.width)
    } else {
      ctx.setLineDash([10 * layer.deviceScale, 6 * layer.deviceScale])
      traceWorldPolyline(ctx, layer, dense)
      ctx.stroke()
    }
  } else {
    ctx.setLineDash([10 * layer.deviceScale, 6 * layer.deviceScale])
    traceWorldPolyline(ctx, layer, draft.cursor ? [...points, draft.cursor] : points)
    if (all.length >= 3) ctx.closePath()
    ctx.stroke()
  }
  ctx.setLineDash([])

  // 顶点手柄：让"点了几个点"一目了然
  const handleRadius = Math.max(3, 5 * Math.min(layer.deviceScale, 2))
  for (const point of raster) {
    ctx.beginPath()
    ctx.arc(point.x, point.y, handleRadius, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = draft.color
    ctx.lineWidth = Math.max(1, handleRadius * 0.5)
    ctx.stroke()
  }
}
