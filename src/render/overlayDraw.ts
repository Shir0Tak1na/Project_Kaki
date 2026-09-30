/**
 * 数值图层的画布绘制：把**图元清单**落到 canvas 上。
 *
 * 它现在**不含任何几何**（这是工单 C 的核心要求）：取数、插值、等值线、颜色、
 * 甚至"哪些格该写数值"都在 `overlayPlan.ts` → `fieldPlan.ts` 那条纯函数链上算好，
 * 本模块只做三件事 —— 世界坐标 → 位图坐标、剔除视口外的图元、把图元画出来。
 * 于是导出侧（SVG）能消费同一批图元，"导出的图与画布不一样"这个长期缺陷从结构上消失。
 *
 * 与 `shapeDraw.ts` 同一层：**碰 canvas，但不 import obsidian**（于是它测不了像素，
 * 但它的输入输出全是纯数据 —— 图元数、越界数、缓存命中都能被假 ctx 断言）。
 *
 * 一条关键事实（决定了取数方式）：**`plan.cells` 不是数值图层的取数来源**。
 * 那份计划只含"有地形"的格（没有 `t` 的格被地形计划跳过了），而"只有温度没有地形"的格
 * 恰恰是数值图层最该画的东西（§5.40 的 F2 就是为了让它合法存在）。
 * 所以样本来自 `overlayPlan.collectOverlaySamples(document, …)`（遍历 `document.terrain`）。
 */

import type { BBox } from '../core/viewport.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import type { FieldPrimitive } from './fieldPlan.ts'
import { buildOverlayPlan, type OverlayFieldCache } from './overlayPlan.ts'
import {
  OVERLAY_LABEL_BASELINE_RATIO,
  OVERLAY_LABEL_FONT,
  OVERLAY_LABEL_SCALE,
  type OverlayFieldSpec,
  type OverlayStyle,
} from './overlayFields.ts'
import type { MapRenderPlan } from './renderPlan.ts'

/**
 * 绘制钩子拿到的材料。
 *
 * 刻意写成**结构类型**而不是 import `layerVisibility.ts` 的 `LayerDrawContext`：
 * 那个模块要 value-import 本模块（图层表里的 `draw` 钩子指向这里），
 * 反过来再 import 它就成了环。结构类型让两边各自成立、由编译器保证兼容。
 */
export interface OverlayDrawContext {
  ctx: CanvasRenderingContext2D
  /** 世界坐标 → 位图坐标（与地形/网格同一份换算，由绘制层注入） */
  toRaster: (x: number, y: number) => { x: number; y: number }
  plan: MapRenderPlan
  document: MapDocument
  /** 这一层的字段与样式；**不是数值图层时为 undefined**，此时钩子什么都不做 */
  overlay?: { spec: OverlayFieldSpec; style: OverlayStyle }
  /**
   * 连续场的**采样缓存**（由绘制层持有、每个字段一份）。
   * 缺省即不缓存 —— 每帧重算 IDW，只适合测试与一次性调用（见 `overlayPlan`）。
   */
  fieldCache?: OverlayFieldCache
  /**
   * 造一张**离屏画布**（连续场的栅格要先落在自己的一张画布上，再缩放铺到主画布）。
   *
   * 注入而不是在这里 `document.createElement`：与地形图集（`TerrainAtlas`）同一条路 ——
   * 本模块不碰 DOM，造画布的能力由绘制层给。取不到（没有 document）时连续场**退回不画**，
   * 而不是抛异常把整帧带塌。
   */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement | null
  /**
   * **分类字段**的"分类 ID → 颜色"（现读目录：内置 + 自定义）。
   *
   * 这里只是**转交**给 `buildOverlayPlan`：颜色属于目录（`BIOMES.md` §3 决定三），
   * 而目录住在插件设置里 —— 本模块不碰设置，规矩与 `createCanvas` 完全相同。
   */
  categoryColors?: ReadonlyMap<string, string>
}

export interface OverlayDrawResult {
  /** 本帧用的是哪种显示方式 */
  mode: 'cell' | 'field'
  /** **色块**个数（逐格 = 格数；连续场 = 1 —— 一整张栅格） */
  drawn: number
  /** 其中走了 `under` / `over` 纯色的个数 */
  outOfRange: number
  /** 画出的数值文字个数（等值线的标注也算） */
  labels: number
  /** 画出的等值线折线条数（逐格模式恒为 0） */
  contours: number
  /** 图元总数 */
  primitives: number
}

/**
 * 数值文字用的默认格式（一位小数）—— 定义搬到了 `overlayFields.ts`（那里是字段表的家），
 * 这里**转出去**是为了不打断既有引用（`tests/overlayFields.test.ts` 从本模块取它）。
 */
export { formatOverlayValue } from './overlayFields.ts'

/** 图元的包围盒是否与视口相交（世界坐标；逐格与连续场共用同一条剔除口径） */
function primitiveIntersects(primitive: FieldPrimitive, bounds: BBox): boolean {
  if (primitive.kind === 'text') {
    return primitive.x >= bounds.minX && primitive.x <= bounds.maxX && primitive.y >= bounds.minY && primitive.y <= bounds.maxY
  }
  if (primitive.kind === 'raster') {
    return (
      primitive.x + primitive.width >= bounds.minX &&
      primitive.x <= bounds.maxX &&
      primitive.y + primitive.height >= bounds.minY &&
      primitive.y <= bounds.maxY
    )
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of primitive.points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return maxX >= bounds.minX && minX <= bounds.maxX && maxY >= bounds.minY && minY <= bounds.maxY
}

/**
 * 连续场栅格的**离屏画布**备忘（按"像素数组"这个对象本身索引）。
 *
 * 为什么可以用模块级 WeakMap：键是像素数组的**身份**，而像素数组由每个覆盖层实例自己的
 * 计划缓存产出 —— 两张画布的数据不同、数组也就不同，不会互相踩（§5.12 那条"别用模块级状态
 * 存跨实例的东西"在这里不适用，因为键已经把它们分开了）。WeakMap 也不留引用。
 *
 * 为什么不放在计划缓存里：那是纯模块（不能碰画布），而"像素"与"承载它的画布"是两件事，
 * 缓存只该管前者（否则每次重建像素都要连画布一起重造）。
 */
const rasterCanvases = new WeakMap<object, { canvas: HTMLCanvasElement; cols: number; rows: number }>()

/** 取（必要时建）这张栅格的离屏画布，并把像素写进去 */
function rasterCanvasFor(
  primitive: Extract<FieldPrimitive, { kind: 'raster' }>,
  createCanvas: ((width: number, height: number) => HTMLCanvasElement | null) | undefined,
): HTMLCanvasElement | null {
  const memo = rasterCanvases.get(primitive.pixels)
  if (memo !== undefined && memo.cols === primitive.cols && memo.rows === primitive.rows) return memo.canvas
  if (createCanvas === undefined) return null
  const canvas = createCanvas(primitive.cols, primitive.rows)
  if (canvas === null) return null
  const offscreen = canvas.getContext('2d')
  if (offscreen === null) return null
  const image = offscreen.createImageData(primitive.cols, primitive.rows)
  image.data.set(primitive.pixels)
  offscreen.putImageData(image, 0, 0)
  rasterCanvases.set(primitive.pixels, { canvas, cols: primitive.cols, rows: primitive.rows })
  return canvas
}

/**
 * 数值图层的绘制钩子 —— `LAYER_TABLE` 里每一行数值图层都挂它，`overlay` 决定画哪个字段。
 *
 * 分三步：**算计划**（纯函数，连续场的采样走缓存）→ **剔除视口外** → **画**。
 * 返回值是**本帧的统计**：有了它，"叠加层没画出来"能被断言抓到，而不是靠肉眼看截图（同 §5.9）。
 */
export function drawOverlayLayer(context: OverlayDrawContext): OverlayDrawResult {
  const empty: OverlayDrawResult = { mode: 'cell', drawn: 0, outOfRange: 0, labels: 0, contours: 0, primitives: 0 }
  const overlay = context.overlay
  if (!overlay) return empty

  const { ctx, document, plan } = context
  const { spec, style } = overlay
  const visible = plan.visibleWorld
  const layer = plan.layer

  // 连续场的采样与上色都在 `buildOverlayPlan` 里（走 `fieldCache`）——本模块只负责把图元画出来
  const { plan: fieldPlan, stats } = buildOverlayPlan({
    document,
    spec,
    style,
    bounds: visible,
    ...(context.fieldCache !== undefined ? { cache: context.fieldCache } : {}),
    ...(context.categoryColors !== undefined ? { categoryColors: context.categoryColors } : {}),
  })

  // 文字状态只在真的要画数值时改一次，循环结束后还原（canvas 状态是全局的，不许留给下一帧）
  const previousFont = ctx.font
  const previousAlign = ctx.textAlign
  const previousBaseline = ctx.textBaseline
  const previousAlpha = ctx.globalAlpha
  const previousDash = typeof ctx.getLineDash === 'function' ? ctx.getLineDash() : []
  // 位图上的格半径：世界半径 × 位图/世界的比例（与地形层的 targetRadius 同一条式子）
  const rasterRadius = document.grid.size * layer.deviceScale
  const labelSize = Math.max(8, rasterRadius * OVERLAY_LABEL_SCALE)
  if (stats.labels > 0) {
    // 数字用**等宽字体**、字号按格半径的比例（用户实机要求："小一点、用编程字体的数字"）
    ctx.font = `${labelSize.toFixed(1)}px ${OVERLAY_LABEL_FONT}`
    ctx.textAlign = 'center'
    // 见 `OVERLAY_LABEL_BASELINE_RATIO`：按"基线下移 0.35em"居中，而不是按 em 盒的 middle
    ctx.textBaseline = 'alphabetic'
  }

  let drawn = 0
  for (const primitive of fieldPlan.primitives) {
    if (!primitiveIntersects(primitive, visible)) continue
    if (primitive.kind === 'text') {
      const center = context.toRaster(primitive.x, primitive.y)
      // 字号优先取图元自己带的（等值线标签比格心读数小一档）；缺省 = 格心读数那条老口径。
      // 这一项必须来自 IR：它同时决定"沿线挖多长一段"，两边各算一次必然分叉（缝比字窄）。
      const size =
        primitive.size !== undefined && primitive.size > 0
          ? Math.max(8, primitive.size * layer.deviceScale)
          : labelSize
      const baseline = size * OVERLAY_LABEL_BASELINE_RATIO
      // 同一帧里两种字号并存（格心读数 / 等值线标签），而 `font` 是画布状态 —— 逐条设一次最省心
      // （值没变时重复赋值不花钱，比"记住上一次设的是哪种"少一个出错的地方）
      ctx.font = `${size.toFixed(1)}px ${OVERLAY_LABEL_FONT}`
      // 等值线的数字**沿着线走**（工程图画法）：绕落点旋转 `primitive.rotation`。
      // 角度是在 `fieldPlan.cutPolylineAt` 里按切线算好的（已收进 ±90°，所以数字不会倒着看）——
      // 这里只负责照着画，几何在那边只有一份。
      const rotation = primitive.rotation ?? 0
      if (rotation !== 0) {
        ctx.save()
        ctx.translate(center.x, center.y)
        ctx.rotate(rotation)
      }
      const drawX = rotation !== 0 ? 0 : center.x
      const drawY = rotation !== 0 ? baseline : center.y + baseline
      // 数字压在彩色场与线上：先描一圈**与字色相反**的边（haloColor）再写字。
      // 描边色不能写死白色：白字配白边等于没描边（用户实测报过"一坨黑"，§A.4 口径已改）。
      if (primitive.haloColor !== undefined) {
        ctx.lineWidth = Math.max(2, size * 0.3)
        ctx.strokeStyle = primitive.haloColor
        ctx.strokeText(primitive.text, drawX, drawY)
      }
      ctx.fillStyle = primitive.color
      ctx.fillText(primitive.text, drawX, drawY)
      if (rotation !== 0) ctx.restore()
      continue
    }
    if (primitive.kind === 'raster') {
      const offscreen = rasterCanvasFor(primitive, context.createCanvas)
      if (offscreen === null) continue
      // 世界包围盒 → 位图矩形：一次 `drawImage` 把整张颜色面铺开，
      // 由画布的**平滑缩放**把它插值成连续渐变（这正是"方格状"的解法）。
      const topLeft = context.toRaster(primitive.x, primitive.y)
      const bottomRight = context.toRaster(primitive.x + primitive.width, primitive.y + primitive.height)
      ctx.globalAlpha = previousAlpha * primitive.opacity
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(offscreen, topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
      ctx.globalAlpha = previousAlpha
      drawn += 1
      continue
    }
    if (primitive.kind === 'polygon') {
      ctx.beginPath()
      primitive.points.forEach(([x, y], index) => {
        const point = context.toRaster(x, y)
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.closePath()
      // 透明度**乘**在既有 alpha 上（而不是直接赋值）：将来若有别的层也调了 alpha，
      // 谁都不会把对方的设置吃掉。
      ctx.globalAlpha = previousAlpha * primitive.opacity
      ctx.fillStyle = primitive.color
      ctx.fill()
      ctx.globalAlpha = previousAlpha
      drawn += 1
      continue
    }
    // 等值线：线宽是世界单位，乘上位图比例换算成像素（与地形/网格同一条换算）
    ctx.globalAlpha = previousAlpha * (primitive.opacity ?? 1)
    ctx.strokeStyle = primitive.color
    ctx.lineWidth = Math.max(1, primitive.width * layer.deviceScale)
    if (typeof ctx.setLineDash === 'function') {
      ctx.setLineDash((primitive.dash ?? []).map((value) => value * layer.deviceScale))
    }
    ctx.beginPath()
    primitive.points.forEach(([x, y], index) => {
      const point = context.toRaster(x, y)
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.stroke()
    ctx.globalAlpha = previousAlpha
  }

  if (stats.labels > 0) {
    ctx.font = previousFont
    ctx.textAlign = previousAlign
    ctx.textBaseline = previousBaseline
  }
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash(previousDash)
  ctx.globalAlpha = previousAlpha

  return {
    mode: stats.mode,
    drawn,
    outOfRange: stats.outOfRange,
    labels: stats.labels,
    contours: stats.contours,
    primitives: stats.primitives,
  }
}