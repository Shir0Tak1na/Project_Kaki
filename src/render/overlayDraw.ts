/**
 * 数据层的画布绘制（hex 模式）：把「一格一个数值」画成半透明色块。
 *
 * 与 `shapeDraw.ts` 同一层：**碰 canvas，但不 import obsidian**（于是它测不了像素，
 * 但它的输入输出全是纯数据 —— 颜色、格数、越界计数都能被假 ctx 断言）。
 *
 * 一条关键事实（决定了这里的遍历方式）：**`plan.cells` 不是数据层的取数来源**。
 * 那份计划只含"有地形"的格（没有 `t` 的格被地形计划跳过了），而"只有温度没有地形"的格
 * 恰恰是数据层最该画的东西（§5.40 的 F2 就是为了让它合法存在）。
 * 所以这里自己遍历 `document.terrain`，并用与地形计划**同一个纯函数**（`cellIntersectsBBox`）
 * 做视口裁剪 —— 裁剪口径与地形一致，不会出现"地形裁了、叠加层没裁"。
 */

import { axialToWorld, hexCorners, parseCellKey } from '../core/hex.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import { colorForValue } from './colorRamp.ts'
import { DEFAULT_ELEVATION_CALIBRATION } from './elevationUnits.ts'
import { cellIntersectsBBox } from './hexGrid.ts'
import { formatFieldReading, type OverlayFieldSpec, type OverlayStyle } from './overlayFields.ts'
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
  /** 这一层的字段与样式；**不是数据层时为 undefined**，此时钩子什么都不做 */
  overlay?: { spec: OverlayFieldSpec; style: OverlayStyle }
}

export interface OverlayDrawResult {
  /** 真的画出来的格数（有值 且 与视口相交 且 色带可用） */
  drawn: number
  /** 其中落在色带外、走了 `under` / `over` 纯色的格数 */
  outOfRange: number
  /** 画出的数值文字个数（`showValues` 关掉时是 0） */
  labels: number
}

/**
 * 数值文字用的默认格式（一位小数）—— 定义搬到了 `overlayFields.ts`（那里是字段表的家），
 * 这里**转出去**是为了不打断既有引用（`tests/overlayFields.test.ts` 从本模块取它）。
 */
export { formatOverlayValue } from './overlayFields.ts'

/**
 * 数据层的绘制钩子 —— `LAYER_TABLE` 里每一行数据层都挂它，`overlay` 决定画哪个字段。
 *
 * 返回值是**本帧的统计**（画了几格 / 几格越界 / 几个数值文字）：
 * 有了它，"叠加层没画出来"能被断言抓到，而不是靠肉眼看截图（同 §5.9 的口径）。
 */
export function drawOverlayLayer(context: OverlayDrawContext): OverlayDrawResult {
  const result: OverlayDrawResult = { drawn: 0, outOfRange: 0, labels: 0 }
  const overlay = context.overlay
  if (!overlay) return result

  const { ctx, document } = context
  const { spec, style } = overlay
  const grid = document.grid
  const visible = context.plan.visibleWorld
  // 展示单位的换算要用地图自己的标定（相对值没有标定就算不出来）——
  // 从这里**现读**，所以"在弹窗里改了标定"下一帧就生效，不需要任何广播。
  const calibration = document.elevation ?? DEFAULT_ELEVATION_CALIBRATION
  // 位图上的格半径：世界半径 × 位图/世界的比例（与地形层的 targetRadius 同一条式子）
  const rasterRadius = grid.size * context.plan.layer.deviceScale

  // 文字状态只在真的要画数值时改一次，循环结束后还原（canvas 状态是全局的，不许留给下一帧）
  // `showValues` = "**所有**格都写数值"；越界格**总是**写（关掉也一样）——
  // 颜色只能表达"比上限还高"，表达不了"高多少"，而越界恰恰是最需要读数的情况。
  const drawAllValues = style.showValues
  const previousFont = ctx.font
  const previousAlign = ctx.textAlign
  const previousBaseline = ctx.textBaseline
  ctx.font = `${Math.max(9, rasterRadius * 0.7).toFixed(1)}px ${context.plan.layer.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const [key, cell] of Object.entries(document.terrain)) {
    const value = spec.read(cell)
    if (value === undefined) continue
    const color = colorForValue(value, style.ramp)
    // 色带没有可用锚点时 colorForValue 返回 null：这一格**不画**
    // （拿越界纯色冒充会让"设置坏了"看起来像"数据是极值"）
    if (color === null) continue
    const axial = parseCellKey(key)
    if (axial === null) continue
    if (!cellIntersectsBBox(grid, axial.q, axial.r, visible)) continue

    const corners = hexCorners(grid, axial.q, axial.r).map((point) => context.toRaster(point.x, point.y))
    ctx.beginPath()
    corners.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.closePath()
    // 透明度**乘**在既有 alpha 上（而不是直接赋值）：将来若有别的层也调了 alpha，
    // 谁都不会把对方的设置吃掉。
    const previousAlpha = ctx.globalAlpha
    ctx.globalAlpha = previousAlpha * style.opacity
    ctx.fillStyle = color.color
    ctx.fill()
    ctx.globalAlpha = previousAlpha

    result.drawn += 1
    if (color.outOfRange !== null) result.outOfRange += 1

    if (drawAllValues || color.outOfRange !== null) {
      const world = axialToWorld(grid, axial.q, axial.r)
      const center = context.toRaster(world.x, world.y)
      // 越界用的是 `under` / `over` 的 textColor（出厂白字）——与"纯蓝底白字"的需求一致
      ctx.fillStyle = color.textColor
      // 读数的格式由**字段自己**决定（深度会按展示单位换算成 km / 相对值）
      ctx.fillText(formatFieldReading(spec, value, style, calibration), center.x, center.y)
      result.labels += 1
    }
  }

  ctx.font = previousFont
  ctx.textAlign = previousAlign
  ctx.textBaseline = previousBaseline
  return result
}