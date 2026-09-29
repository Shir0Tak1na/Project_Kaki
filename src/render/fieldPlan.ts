/**
 * 覆盖层的绘制计划：把"格子上的数值"变成**与渲染后端无关的图元清单** ——
 * 纯函数模块，不 import obsidian。
 *
 * 为什么要有这一层（而不是直接在画布上画）：
 * 1. **画布与导出共用同一份几何**：`MapOverlay`（canvas）与 `mapPreview`（SVG）都消费
 *    同一份图元清单，两边不可能画出不同的形状；
 * 2. **假 DOM 断言不了 canvas，但能断言这份清单** —— 这是本项目一贯的做法
 *    （能算的都做成纯函数，见 `docs/ENGINEERING-NOTES.md` 架构铁律 2）。
 *
 * 两种渲染模式（用户要求）：
 * - `hex`：**局限在六边形格内** —— 每格一个多边形 + 可选数值文字；
 * - `field`：**不局限于六边形格** —— 把格心值插值成连续场（`sampleField`），
 *   再在场上提取等值线（`contourPolylines`，marching squares）。
 *
 * 坐标系：图元一律用**世界坐标**，由渲染后端换算成位图/屏幕坐标。
 *
 * 设计草案：`.trae/documents/温度带与深度分层-设计草案.md` §4.3。
 */

import { axialToWorld, hexCorners, type GridSpec } from '../core/hex.ts'
import { colorForValue, oppositeTextColor, parseHexColor, textColorOf, type RampSpec } from './colorRamp.ts'

/* ------------------------------------------------------------------ 图元 IR */

export type FieldPrimitive =
  | { kind: 'polygon'; points: Array<[number, number]>; color: string; opacity: number }
  | {
      kind: 'polyline'
      points: Array<[number, number]>
      color: string
      /** 线宽（**世界单位**；由渲染后端乘上自己的比例换算成像素） */
      width: number
      dash?: number[]
      /** 不透明度（缺省 1）。与多边形同一口径：**这一层的不透明度作用于这一层的所有图元** */
      opacity?: number
    }
  | {
      kind: 'text'
      x: number
      y: number
      text: string
      color: string
      /**
       * **描边色**（缺省 = 不描边）。
       *
       * 为什么是颜色而不是 `halo: boolean`：描边**必须与字色相反**（白字配深边 / 深字配浅边），
       * 否则"黑字 + 白边"压在浅色场上等于看不见（用户实测报的"还是黑色的"）。
       * 画布 `strokeText` 打底、SVG 用 `paint-order="stroke"`，两边都照着这个颜色描。
       */
      haloColor?: string
      /**
       * 旋转角（**弧度**，绕 `(x, y)`；缺省 0 = 水平）。
       *
       * 等值线的数值按工程图的惯例**沿着线走**（见 `cutPolylineAt`）——
       * 于是断线位置、角度、文字宽度三件事必须一起算，也就只能在这里算。
       */
      rotation?: number
      /**
       * 字号（**世界单位**；缺省 = 由后端按图层默认比例算）。
       *
       * 为什么字号要进 IR：它同时决定"沿线挖多长一段"（几何）与"画多大"（渲染）——
       * 两边各算一次必然分叉（挖的缝比字窄，数字就压到线上）。等值线标签用它取
       * `CONTOUR_LABEL_SCALE`（比格心读数小一档），格心读数不写这一项、走老口径。
       */
      size?: number
    }
  | {
      /**
       * **栅格图元**：连续场的颜色面（行优先 RGBA）。
       *
       * 为什么不是"每格一个小方块"（第一版就是这么做的，用户实机一眼看出"呈方格状分布"）：
       * 方块之间是**离散跳变**，放粗放细都只是绷带，永远不是连续渐变。
       * 真正连续只有一条路 —— 按像素上色，再由后端把它铺开：
       * 画布侧 `putImageData` + `drawImage` 缩放平滑，SVG 侧内联成 PNG（`<image>`）。
       * 两个后端消费的是**同一份像素**，所以"画布连续、导出还是方格"这种分叉不会发生。
       */
      kind: 'raster'
      /** 行优先 RGBA；`values[j * cols + i]` 对应 `(j * cols + i) * 4`；**没有数据的点是全透明** */
      pixels: Uint8ClampedArray
      cols: number
      rows: number
      /** 世界坐标下的覆盖范围（含半个采样步长的外扩，与旧方块拼出来的面积一致） */
      x: number
      y: number
      width: number
      height: number
      opacity: number
    }

/**
 * 连续场的**采样网格**（存的是值，不是颜色）。
 *
 * 为什么不在这里就把颜色算好：颜色映射是 `colorRamp` 的事，而且位图光栅化时
 * 逐点查一次色带比"先造几万个颜色对象、再画"省得多。值留在这里，谁画谁上色。
 */
export interface FieldGrid {
  originX: number
  originY: number
  /** 采样间距（世界单位） */
  step: number
  cols: number
  rows: number
  /** 行优先（`values[j * cols + i]`）；`null` = 该点没有数据 */
  values: Array<number | null>
}

export interface FieldSample {
  q: number
  r: number
  /** 该格的值。**调用方只传有值的格**；NaN / Infinity 会被当作没有数据跳过 */
  value: number
  /**
   * 这个值是**兜底来的**（格上没有真值，用的是地图级的每格默认值，见 `dataDefaults.ts`）。
   *
   * 为什么样本要带这个标志：逐格模式下**兜底格照画但不写数值**（§B.3）——
   * 满屏都是"15"会让人以为"这格真的量过 15"，而它只是这张图的基线。
   * 连续场模式下这个标志不改变任何东西（兜底值就是插值的输入之一），所以不必分两套路径。
   */
  fallback?: boolean
}

export interface FieldPlanInput {
  samples: readonly FieldSample[]
  grid: GridSpec
  ramp: RampSpec
  mode: 'hex' | 'field'
  /** 图层透明度（0–1） */
  opacity: number
  /** `hex` 模式：在格心画出数值 */
  showValues?: boolean
  /**
   * `hex` 模式：**越界格**总是画出数值（即使 `showValues` 关着）。
   *
   * 这是数据层的口径（颜色只能表达"比上限还高"，表达不了"高多少"），
   * 但"谁该写数值"属于**显示策略**，所以由调用方传进来，而不是在这里写死。
   */
  labelOutOfRange?: boolean
  /** 数值 → 显示文本（每种字段自己决定精度，例如温度一位小数） */
  formatValue?: (value: number) => string
  /**
   * 数值标注的**字号（世界单位）**。
   *
   * 它决定"要在线条上挖多长一段"（文字宽度 ≈ 字数 × 字号 × 0.6，等宽字体可算），
   * 所以必须由调用方给 —— 渲染层用的是 `格半径 × OVERLAY_LABEL_SCALE`，
   * 两边各算一次必然分叉（挖的缝比字窄，数字就会压到线上）。缺省取 `格半径 × 0.5`（同值，给直接调用的测试用）。
   */
  labelSize?: number
  /**
   * 数字之间的**重复间隔**（世界单位；缺省 = 格半径 × `DEFAULT_CONTOUR_LABEL_SPACING_FACTOR`）。
   *
   * 用户追加要求："还要考虑每隔多少距离重复一次数字。" —— 它是**世界距离**，
   * 于是"把间隔调小"在任何缩放下都是同样的地图距离，不会"放大以后才变密"。
   * 实际间距还会被"文字宽度 × 6"抬起来（见 `contourLabelPositions`）：间隔给得再小也不会挤成一团。
   */
  labelSpacing?: number
  /** `field` 模式：采样间距（世界单位）；缺省取六边形外接圆半径 */
  sampleStep?: number
  /** `field` 模式：插值影响半径（世界单位）；缺省 `step × 3` */
  sampleRadius?: number
  /** `field` 模式：等值线间距；缺省用色带锚点的数值 */
  contourInterval?: number | null
  /** `field` 模式：等值线最多画几条（防呆） */
  maxContours?: number
  /**
   * `field` 模式：**填色片**最多多少个（防呆）。
   *
   * 逐格模式天然被视口裁着（只画看得见的格），而连续场的填色片是"整张有数据的范围"
   * ——没有一个上限，一张大图会产出几万个多边形。超过上限时**自动放粗采样间距**
   * （宁可粗一点，也不能让每帧画几万次 `fill`）。
   */
  maxFieldCells?: number
  /**
   * 已经算好的采样网格（**缓存用**）。
   *
   * 给了它就不重新采样（IDW 是连续场里唯一贵的那一步，见 `overlayPlan.ts` 的缓存）。
   * 图元仍然每次现算 —— 改色带只该换颜色，不该触发重新插值。
   */
  precomputedField?: FieldGrid
}

export interface FieldPlan {
  primitives: FieldPrimitive[]
  /** `field` 模式下的采样网格；`hex` 模式或没有数据时为 `null` */
  field: FieldGrid | null
}

/** 采样网格的单边上限（防呆：一个坏设置不该让每帧算几十万个点） */
export const MAX_FIELD_DIMENSION = 256
/**
 * 连续场**填色片**的出厂上限（点数 = `cols × rows`）。
 *
 * 128×128 ≈ 16384：比"每格一个多边形"时代的 2048 高一档是完全付得起的 ——
 * 栅格只花一次"逐点上色"，之后每帧只是一次 `drawImage`（或导出时一次 PNG 编码），
 * 所以分辨率可以直接拉到"看着是连续渐变"的程度。
 */
export const DEFAULT_MAX_FIELD_CELLS = 16384
/** 等值线条数上限的出厂值 */
export const DEFAULT_MAX_CONTOURS = 12
/** 等值线线宽（世界单位） */
const CONTOUR_WIDTH = 1.5
/**
 * 等值线数字的**字号比例**（相对格半径，世界单位）。
 *
 * 用户实测："很大" —— 旧口径沿用格心读数的 0.5 倍格半径，压在线上太抢眼。
 * 0.35 是"读得清、又不比格心读数大"的一档（施工文件 §A.4 / ISSUES-001 的建议值）。
 * 它同时是**挖缝宽度**的来源，所以只能有一个来源：`overlayPlan` 从这里取、传进几何。
 */
export const CONTOUR_LABEL_SCALE = 0.35
/**
 * **每一层**最多标几个数字（防糊）。
 *
 * 旧口径是 3（每层只标最长的三条、各一个），用户追加要求"每隔多少距离重复一次"之后
 * 3 显然不够（一条长线自己就要好几个）；12 是"层内够用、又不至于铺满"的一档。
 * 超限时**沿线均匀抽样**（见 `sampleEvenly`），不是"只留最长的几条"。
 */
export const MAX_CONTOUR_LABELS_PER_LEVEL = 12
/** **全局**（所有层合计）最多标几个数字 —— 巨大地图上不让数字总量爆炸 */
export const MAX_CONTOUR_LABELS_TOTAL = 200
/**
 * 数字之间的**最小间距**（= 文字宽度 × 这个系数）：保证数字永远不挤在一起。
 * 用户可调的"重复间隔"只在这个下限之上起作用（见 `contourLabelPositions`）。
 */
const CONTOUR_LABEL_MIN_SPACING_FACTOR = 6
/**
 * 一条等值线**两端各留的边**（= 文字宽度 × 这个系数）：数字不贴端头。
 *
 * 于是"整条线短于 文字宽度 × 4"（= 两端留边之和）时一个数字都放不下 ——
 * 这与"挖掉文字宽度之后还剩得下实线"是同一条门槛（施工文件 §A.5 的验收式）。
 */
const CONTOUR_LABEL_MARGIN_FACTOR = 2
/**
 * 出厂**重复间隔**（= 格半径 × 这个系数，世界单位）。
 *
 * 取 6：一个数字占 6 个格半径的距离 ≈ 等距反复读到读数，又不会密到糊。
 * 设置项以"格"为单位（用户看到的就是 6），改小立刻变密。
 */
export const DEFAULT_CONTOUR_LABEL_SPACING_FACTOR = 6
/** 判定两个插值端点是否同一个点时的容差（浮点安全网；同一格边算出来的点本来就是同一个） */
const JOIN_EPSILON = 1e-6

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(0, Math.min(1, value))
}

function defaultFormatValue(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return String(rounded)
}

/* ------------------------------------------------------------------ 连续场采样 */

export interface SampleFieldOptions {
  step?: number
  radius?: number
  power?: number
  /** 在样本包围盒外再扩多少（世界单位），让边缘不至于"断在格中心" */
  margin?: number
  /**
   * 整张网格的**点数上限**（`cols × rows`）。超过时自动放粗 `step`。
   *
   * 为什么需要它：填色片的数量就是网格点数，一张大图按格子大小采样会得到几万个点 ——
   * "宁可粗一点"是这里唯一正确的取舍（放粗只是看不那么细腻，不画才是功能没了）。
   */
  maxCells?: number
}

/**
 * 把散落在格心上的值插成规则网格（反距离加权，IDW）。
 *
 * 为什么是 IDW：它只需要"距离"这一个概念，没有三角剖分的退化情况（共线、重合点），
 * 对六边形格这种各向同性的采样点集也够平滑。**这是一个可替换的接缝**：
 * 以后想换成六边形重心插值或自然邻域，只要产出同样形状的 `FieldGrid`，上层不用改。
 *
 * 实现是"样本往网格上打点"（O(样本 × 半径内点数)）而不是"每个网格点遍历所有样本"，
 * 否则大图上每帧都要跑 O(N×M)。
 */
export function sampleField(
  samples: readonly FieldSample[],
  grid: GridSpec,
  options: SampleFieldOptions = {},
): FieldGrid | null {
  const points: Array<{ x: number; y: number; value: number }> = []
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue
    const world = axialToWorld(grid, sample.q, sample.r)
    points.push({ x: world.x, y: world.y, value: sample.value })
  }
  if (points.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  let step = Number.isFinite(options.step) && (options.step ?? 0) > 0 ? options.step! : grid.size
  const margin = Number.isFinite(options.margin) ? options.margin! : step
  // 点数上限：先把间距放到"整块面积 / 上限"的平方根。只放大不缩小 ——
  // 调用方明确要一个更细的间距时，那是它的选择（上限只负责防呆）。
  const maxCells = Number.isFinite(options.maxCells) && (options.maxCells ?? 0) > 0 ? options.maxCells! : 0
  if (maxCells > 0) {
    const spanX = maxX - minX + margin * 2
    const spanY = maxY - minY + margin * 2
    const minStep = Math.sqrt(Math.max(spanX * spanY, 0) / maxCells)
    if (Number.isFinite(minStep) && minStep > step) step = minStep
  }
  const radius = Number.isFinite(options.radius) && (options.radius ?? 0) > 0 ? options.radius! : step * 3
  const power = Number.isFinite(options.power) && (options.power ?? 0) > 0 ? options.power! : 2

  const originX = minX - margin
  const originY = minY - margin
  const cols = Math.min(MAX_FIELD_DIMENSION, Math.max(2, Math.ceil((maxX + margin - originX) / step) + 1))
  const rows = Math.min(MAX_FIELD_DIMENSION, Math.max(2, Math.ceil((maxY + margin - originY) / step) + 1))

  const weightSum = new Float64Array(cols * rows)
  const weightedValue = new Float64Array(cols * rows)
  const radiusSquared = radius * radius

  for (const point of points) {
    const i0 = Math.max(0, Math.floor((point.x - radius - originX) / step))
    const i1 = Math.min(cols - 1, Math.ceil((point.x + radius - originX) / step))
    const j0 = Math.max(0, Math.floor((point.y - radius - originY) / step))
    const j1 = Math.min(rows - 1, Math.ceil((point.y + radius - originY) / step))
    for (let j = j0; j <= j1; j += 1) {
      const y = originY + j * step
      for (let i = i0; i <= i1; i += 1) {
        const x = originX + i * step
        const dx = x - point.x
        const dy = y - point.y
        const distanceSquared = dx * dx + dy * dy
        if (distanceSquared > radiusSquared) continue
        // 正好落在样本上（或近到会除出 Infinity）时用一个小下限，权重上限自然出现
        const safe = Math.max(distanceSquared, 1e-12)
        const weight = 1 / safe ** (power / 2)
        const index = j * cols + i
        weightSum[index] = weightSum[index]! + weight
        weightedValue[index] = weightedValue[index]! + weight * point.value
      }
    }
  }

  const values: Array<number | null> = new Array(cols * rows)
  for (let index = 0; index < values.length; index += 1) {
    const total = weightSum[index]!
    values[index] = total > 0 ? weightedValue[index]! / total : null
  }
  return { originX, originY, step, cols, rows, values }
}

/* ------------------------------------------------------------------ 等值线 */

function gridPoint(field: FieldGrid, i: number, j: number): [number, number] {
  return [field.originX + i * field.step, field.originY + j * field.step]
}

function fieldValue(field: FieldGrid, i: number, j: number): number | null {
  return field.values[j * field.cols + i] ?? null
}

/** 在 a、b 之间按 level 线性插值（返回 0–1 的比例） */
function ratio(a: number, b: number, level: number): number {
  const span = b - a
  if (span === 0) return 0.5
  return (level - a) / span
}

function mixPoint(from: [number, number], to: [number, number], t: number): [number, number] {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
}

function pointKey(point: readonly [number, number]): string {
  return `${Math.round(point[0] / JOIN_EPSILON)}:${Math.round(point[1] / JOIN_EPSILON)}`
}

type Segment = [[number, number], [number, number]]

/**
 * 在采样网格上提取等值线（marching squares），并把首尾相接的线段**接成折线**。
 *
 * 三个实现要点：
 * 1. **任一角点没有数据就跳过这一格** —— 不允许"猜"一个值过来，否则缺数据的地方
 *    会长出根本不存在的等值线；
 * 2. 两种歧义情形（同一格里两组对角各自高于 level）**固定取一种连法**
 *    （把孤立的高点各自连到它的两条边上），否则同一份数据会画出两种结果、不可断言；
 * 3. 接线段是必需的而不是优化：一个 100×100 的场会切出几百段，不接的话既难画
 *    （每段一次路径）又会在折点处露缝。相邻格共用的那条边算出的点**逐位相同**
 *    （同一表达式），所以按坐标键直接接即可。
 */
export function contourPolylines(field: FieldGrid, level: number): Array<Array<[number, number]>> {
  if (!Number.isFinite(level)) return []
  const segments: Segment[] = []

  for (let j = 0; j < field.rows - 1; j += 1) {
    for (let i = 0; i < field.cols - 1; i += 1) {
      const a = fieldValue(field, i, j)
      const b = fieldValue(field, i + 1, j)
      const c = fieldValue(field, i + 1, j + 1)
      const d = fieldValue(field, i, j + 1)
      if (a === null || b === null || c === null || d === null) continue

      const bottomLeft = gridPoint(field, i, j)
      const bottomRight = gridPoint(field, i + 1, j)
      const topRight = gridPoint(field, i + 1, j + 1)
      const topLeft = gridPoint(field, i, j + 1)

      const bottom = (): Segment[number] => mixPoint(bottomLeft, bottomRight, ratio(a, b, level))
      const right = (): Segment[number] => mixPoint(bottomRight, topRight, ratio(b, c, level))
      const top = (): Segment[number] => mixPoint(topLeft, topRight, ratio(d, c, level))
      const left = (): Segment[number] => mixPoint(bottomLeft, topLeft, ratio(a, d, level))

      const index = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0)
      switch (index) {
        case 0:
        case 15:
          break
        case 1:
        case 14:
          segments.push([left(), bottom()])
          break
        case 2:
        case 13:
          segments.push([bottom(), right()])
          break
        case 3:
        case 12:
          segments.push([left(), right()])
          break
        case 4:
        case 11:
          segments.push([right(), top()])
          break
        case 6:
        case 9:
          segments.push([top(), bottom()])
          break
        case 7:
        case 8:
          segments.push([left(), top()])
          break
        case 5:
        case 10:
          // 歧义格：把"孤立的高点"各自连到它相邻的两条边上（固定选择，见函数注释）
          segments.push([bottom(), right()], [left(), top()])
          break
        default:
          break
      }
    }
  }

  return joinSegments(segments)
}

/** 把首尾相接的线段接成折线（按坐标键找邻居） */
function joinSegments(segments: readonly Segment[]): Array<Array<[number, number]>> {
  if (segments.length === 0) return []
  const adjacency = new Map<string, number[]>()
  const remember = (key: string, index: number): void => {
    const list = adjacency.get(key)
    if (list === undefined) adjacency.set(key, [index])
    else list.push(index)
  }
  segments.forEach((segment, index) => {
    remember(pointKey(segment[0]), index)
    remember(pointKey(segment[1]), index)
  })

  const used = new Array<boolean>(segments.length).fill(false)
  const lines: Array<Array<[number, number]>> = []

  const nextSegment = (key: string): { index: number; fromEnd: 0 | 1 } | null => {
    for (const index of adjacency.get(key) ?? []) {
      if (used[index]) continue
      const segment = segments[index]!
      return { index, fromEnd: pointKey(segment[0]) === key ? 0 : 1 }
    }
    return null
  }

  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue
    used[start] = true
    const line: Array<[number, number]> = [segments[start]![0], segments[start]![1]]

    // 先往尾部接
    for (;;) {
      const found = nextSegment(pointKey(line[line.length - 1]!))
      if (found === null) break
      used[found.index] = true
      const segment = segments[found.index]!
      line.push(found.fromEnd === 0 ? segment[1] : segment[0])
    }
    // 再往头部接
    for (;;) {
      const found = nextSegment(pointKey(line[0]!))
      if (found === null) break
      used[found.index] = true
      const segment = segments[found.index]!
      line.unshift(found.fromEnd === 0 ? segment[1] : segment[0])
    }
    lines.push(line)
  }
  return lines
}

/* ------------------------------------------------------------------ 样本指纹 */

/**
 * 样本集合的**顺序无关指纹**（缓存键用）。
 *
 * 为什么值必须进哈希（而不是只数格数 / 只哈希格子集合）：连续场的缓存键里
 * 若只看"有哪些格"，用户改了一格的值就**不会**触发重算 —— 表现是"改了温度画面不变"，
 * 正是 `ENGINEERING-NOTES.md` §5.9 那条老毛病（每帧都在变的值不许进"要不要重算"的判断，
 * 反过来"变了却不重算"同样致命）。
 *
 * 用 FNV-1a + `Math.imul`（**加法**合并，于是与格的顺序无关）：常数级、无分配，
 * 一张几十万格的图也就几毫秒一次（每帧一次）。碰撞的代价只是"这一帧仍用上一帧的场"，
 * 下一帧自我纠正 —— 与 `hashTerrainCells` 同一取舍。
 */
export function hashFieldSamples(samples: readonly FieldSample[]): string {
  let hash = 0
  for (const sample of samples) {
    // 先算这一格的指纹（FNV-1a），再用**加法**合并 —— 加法满足交换律，于是"格的先后顺序"
    // 不影响结果（`Object.entries` 的顺序在不同写入路径下会变，不该因此白重算一次）
    let local = 2166136261
    local = Math.imul(local ^ (Math.round(sample.q) | 0), 16777619)
    local = Math.imul(local ^ (Math.round(sample.r) | 0), 16777619)
    // 值按"千分之一"取整再哈希：浮点尾巴不该让缓存每帧失效，而 0.001 的差异肉眼看不出来
    local = Math.imul(local ^ (Math.round(sample.value * 1000) | 0), 16777619)
    hash = (hash + (local >>> 0)) | 0
  }
  return `${samples.length}:${(hash >>> 0).toString(16)}`
}

/* ------------------------------------------------------------------ 等值线取哪些层 */

/**
 * 决定画哪些等值线。
 *
 * - 给了正的 `interval` → 在色带量程内按"间隔的整数倍"取值（0、±10、±20…），
 *   这与用户对"等高线/等温线"的直觉一致（等值线本来就落在整齐的数值上）；
 * - 没给 → 直接用色带的锚点（"5 个体感温度分类"那 5 条线就是现成的）；
 * - 超过上限时**按等距抽稀**（保留两端），而不是一刀切掉后半段。
 */
export function contourLevels(
  ramp: RampSpec,
  interval: number | null | undefined,
  maxContours: number = DEFAULT_MAX_CONTOURS,
): number[] {
  const min = ramp.stops[0]!.value
  const max = ramp.stops[ramp.stops.length - 1]!.value
  let levels: number[]
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    levels = []
    const firstIndex = Math.ceil(min / interval - 1e-9)
    const lastIndex = Math.floor(max / interval + 1e-9)
    for (let index = firstIndex; index <= lastIndex; index += 1) levels.push(index * interval)
  } else {
    levels = ramp.stops.map((stop) => stop.value)
  }
  const limit = Number.isFinite(maxContours) && maxContours > 0 ? Math.floor(maxContours) : DEFAULT_MAX_CONTOURS
  if (levels.length <= limit) return levels
  const picked: number[] = []
  for (let slot = 0; slot < limit; slot += 1) {
    picked.push(levels[Math.round((slot * (levels.length - 1)) / (limit - 1))]!)
  }
  return [...new Set(picked)]
}

/**
 * 连续场的**颜色面**：逐点上色成一张 RGBA 栅格（行优先）。
 *
 * 三条口径：
 * 1. **没有数据的点全透明**（alpha 0）—— "缺数据"与"极低温"是两件事（与逐格模式同一条）；
 * 2. 越界点自动走 `under` / `over` 的纯色（`colorForValue` 那一处口径）——
 *    这就是"连续场里 under / over 的交代"；
 * 3. 不透明度**不写进像素**（像素只带颜色，alpha 全 255），由后端用图层不透明度统一铺 ——
 *    于是"调不透明度"不必重新上色（那是一次几万点的重算）。
 */
export function fieldRaster(field: FieldGrid, ramp: RampSpec, opacity: number): FieldPrimitive {
  const pixels = new Uint8ClampedArray(field.cols * field.rows * 4)
  for (let index = 0; index < field.values.length; index += 1) {
    const value = field.values[index]
    // `undefined` 也要挡：越界的下标在"没有数据"这一点上与 `null` 同义（数组边界不该被当成极低温）
    if (value === null || value === undefined) continue
    const style = colorForValue(value, ramp)
    if (style === null) continue
    const rgb = parseHexColor(style.color)
    if (rgb === null) continue
    const offset = index * 4
    pixels[offset] = rgb[0]
    pixels[offset + 1] = rgb[1]
    pixels[offset + 2] = rgb[2]
    pixels[offset + 3] = 255
  }
  // 覆盖范围含半个采样步长的外扩：网格点是"点"，而这一片颜色要盖到相邻两点之间
  const half = field.step / 2
  return {
    kind: 'raster',
    pixels,
    cols: field.cols,
    rows: field.rows,
    x: field.originX - half,
    y: field.originY - half,
    width: field.cols * field.step,
    height: field.rows * field.step,
    opacity,
  }
}

/** 折线的总长度（世界单位）—— 用来挑"最长的几条"放数值标注 */
function polylineLength(points: readonly [number, number][]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index]![0] - points[index - 1]![0]
    const dy = points[index]![1] - points[index - 1]![1]
    total += Math.hypot(dx, dy)
  }
  return total
}

export interface ContourCandidate {
  points: Array<[number, number]>
  index: number
  length: number
}

/**
 * 挑"哪几条线标数字"的排序：**最长优先**，长度并列时按**起点坐标字典序**。
 *
 * 为什么并列必须给一条明确的次序（而不是"接着 `sort` 的稳定性"）：`Array.prototype.sort`
 * 的稳定性是语言层面的约定，但**并列元素之间的相对次序取决于输入顺序**，而输入顺序
 * 来自 marching squares 的遍历次序 —— 一旦上游改动（换个采样步长、加一层预处理），
 * 选择结果就会跟着漂：表现是"同一份数据、同一份设置，两帧之间数字换了位置"，
 * 缓存与导出也跟着对不上。给一条与输入顺序无关的次序，这类漂移就不可能发生。
 *
 * （设计草案 §A.5 写的是"最长 → 层级由小到大 → 起点坐标字典序"。层级这一项在**同层内**
 * 是常量 —— 候选是逐层挑的 —— 所以这里体现不出来；跨层不会有竞争。）
 *
 * 导出这一条是为了**能直接断言**并列次序：走 `buildFieldPlan` 的话，只有当"自然产生的线序"
 * 恰好与字典序相反时才会露馅，而那样的场构造不出来 —— 与其写一条永远不红的断言，不如把它单测掉。
 */
export function compareContourCandidates(a: ContourCandidate, b: ContourCandidate): number {
  if (b.length !== a.length) return b.length - a.length
  const [ax, ay] = a.points[0]!
  const [bx, by] = b.points[0]!
  return ax !== bx ? ax - bx : ay - by
}

/** 把角度收进 [-90°, +90°]：工程图的数字不许倒着看 */
function keepUpright(angle: number): number {
  const half = Math.PI / 2
  let value = angle
  while (value > half) value -= Math.PI
  while (value < -half) value += Math.PI
  return value
}

export interface ContourCut {
  /** 数字要落的位置 */
  position: [number, number]
  /** 该处的切线角（已收进 ±90°） */
  angle: number
}

export interface PolylineCutResult {
  /** 挖完缝之后的**各段**折线（N 个数字 ⇒ N+1 段；每段都是真的线段） */
  segments: Array<Array<[number, number]>>
  /** 每个数字的位置与角度（与传入的 `positions` 一一对应） */
  cuts: ContourCut[]
}

/** 折线的弧长表：每段的方向、长度与起点弧长（挖缝与取切线角共用这一份） */
interface ArcTable {
  segments: Array<{ from: [number, number]; to: [number, number]; length: number; start: number }>
  total: number
}

function arcTable(points: readonly [number, number][]): ArcTable {
  const segments: ArcTable['segments'] = []
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!
    const to = points[index]!
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    segments.push({ from, to, length, start: total })
    total += length
  }
  return { segments, total }
}

/** 弧长 → 点（超出末端时取末点） */
function pointAt(table: ArcTable, distance: number, last: [number, number]): [number, number] {
  for (const segment of table.segments) {
    if (distance <= segment.start + segment.length + JOIN_EPSILON || segment === table.segments[table.segments.length - 1]) {
      const ratio = segment.length === 0 ? 0 : (distance - segment.start) / segment.length
      const clamped = Math.max(0, Math.min(1, ratio))
      return [
        segment.from[0] + (segment.to[0] - segment.from[0]) * clamped,
        segment.from[1] + (segment.to[1] - segment.from[1]) * clamped,
      ]
    }
  }
  return last
}

/** 弧长 → 该处的切线角（已收进 ±90°；工程图的数字不许倒着看） */
function angleAt(table: ArcTable, distance: number): number {
  for (const segment of table.segments) {
    if (distance >= segment.start && distance <= segment.start + segment.length) {
      return keepUpright(Math.atan2(segment.to[1] - segment.from[1], segment.to[0] - segment.from[0]))
    }
  }
  const last = table.segments[table.segments.length - 1]
  return last === undefined ? 0 : keepUpright(Math.atan2(last.to[1] - last.from[1], last.to[0] - last.from[0]))
}

/**
 * 取折线上 `[from, to]` 这一段弧长对应的**子折线**（端点是插值出来的，中间顶点原样保留）。
 *
 * 判据是"**这个顶点自己的弧长位置**落在区间里"，而不是"上一个顶点在区间外就收下" ——
 * 后者在顶点间距大于区间长度时会把区间外的顶点也收进来，线段于是折回去、把数字压在线上
 * （这条真缺陷在 §A 轮写测试时撞到过）。
 */
function subPolyline(
  points: readonly [number, number][],
  table: ArcTable,
  from: number,
  to: number,
): Array<[number, number]> {
  const last = points[points.length - 1]!
  const out: Array<[number, number]> = [pointAt(table, from, last)]
  let walked = 0
  for (let index = 1; index < points.length; index += 1) {
    walked += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1])
    if (walked > from + JOIN_EPSILON && walked < to - JOIN_EPSILON) out.push(points[index]!)
  }
  out.push(pointAt(table, to, last))
  return out
}

/**
 * 在折线上**沿弧长挖掉若干段**（每段宽 `gap`，中心在 `positions` 里），给数字让位（工程图的画法）。
 *
 * 为什么几何必须在这里算（而不是让渲染层"先画线再拿文字盖住"）：
 * 用背景色盖是**假断线** —— 数字底下压着的还是那条线，换个背景色/导出成 SVG 就露馅；
 * 而且文字宽度只有这里知道（字号是外部给的），断点位置与文字位置必须一起算。
 *
 * **一次算完所有切点**（用户追加要求"每隔多少距离重复一次数字"）：
 * 一条线上 N 个数字要切成 N+1 段，如果只支持单切点就得反复切、段段拼接，
 * 每接一次都可能接错（本项目已经因为"两处各算一遍几何"吃过多轮亏）。
 *
 * `positions` 必须**升序且互不重叠**（调用方按弧长排好），返回的 `cuts` 与它一一对应。
 * 折线太短 / 没有可切的点 / 有切点会让某一段退化成零长度时返回 `null`，调用方**不标**。
 */
export function cutPolylineAt(
  points: readonly [number, number][],
  positions: readonly number[],
  gap: number,
): PolylineCutResult | null {
  if (points.length < 2 || positions.length === 0) return null
  const table = arcTable(points)
  if (!(table.total > 0)) return null
  const last = points[points.length - 1]!
  const half = Math.max(0, gap) / 2

  // 缝区间（按弧长；夹在 [0, total] 内），相邻两缝之间就是"要留下的段"
  const windows = positions
    .map((position) => ({ start: Math.max(0, position - half), end: Math.min(table.total, position + half) }))
    .sort((a, b) => a.start - b.start)
  const keep: Array<[number, number]> = []
  let cursor = 0
  for (const window of windows) {
    if (window.start > cursor + JOIN_EPSILON) keep.push([cursor, window.start])
    cursor = Math.max(cursor, window.end)
  }
  if (table.total > cursor + JOIN_EPSILON) keep.push([cursor, table.total])
  if (keep.length !== positions.length + 1) return null

  const segments = keep.map(([from, to]) => subPolyline(points, table, from, to))
  // 每一段都必须是真的线段：退化成零长度时整条线不标（半截线比不标更难看）
  if (segments.some((segment) => polylineLength(segment) <= JOIN_EPSILON)) return null

  return {
    segments,
    cuts: positions.map((position) => ({ position: pointAt(table, position, last), angle: angleAt(table, position) })),
  }
}

/**
 * 一条等值线上要放几个数字、分别放在哪（弧长）。
 *
 * 口径（施工文件 §A.5 / 用户追加要求）：
 * - 两端各留 `文字宽度 × 2`（数字不贴端头）；
 * - 间距 = `max(重复间隔, 文字宽度 × 6)` —— 前者是**世界距离**（地图事实，不随缩放变），
 *   后者保证数字不会挤在一起；
 * - 整条线短于 `文字宽度 × 4`（= 两端留边之和）时**一个都不标**。
 *
 * 于是"长度 L 的线上数字个数 = floor((L − 4w) / 间距) + 1"，与施工文件里的验收式一致
 * （间距减半 ⇒ 个数约翻倍）。
 */
export function contourLabelPositions(length: number, labelWidth: number, spacing: number): number[] {
  if (!Number.isFinite(length) || length <= 0) return []
  const margin = labelWidth * CONTOUR_LABEL_MARGIN_FACTOR
  const usable = length - margin * 2
  if (usable < 0) return []
  const step = Math.max(spacing, labelWidth * CONTOUR_LABEL_MIN_SPACING_FACTOR)
  if (!(step > 0)) return []
  const count = Math.floor(usable / step + 1e-9) + 1
  const out: number[] = []
  for (let index = 0; index < count; index += 1) out.push(margin + index * step)
  return out
}

/**
 * 均匀抽样：把一个候选列表压到 `limit` 个，**沿列表均匀取**（保留首尾）。
 *
 * 为什么不"只留最长的几条"（旧口径）：那会让长线密集、短线全无 ——
 * 用户要的是"沿等值线每隔一段就有读数"，而不是"只有最长的三条有"。均匀抽样与输入顺序无关，
 * 所以同一份数据永远得到同一批数字（逐帧不抖、缓存不失效）。
 */
function sampleEvenly<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return []
  if (items.length <= limit) return [...items]
  if (limit === 1) return [items[0]!]
  const out: T[] = []
  for (let index = 0; index < limit; index += 1) {
    out.push(items[Math.round((index * (items.length - 1)) / (limit - 1))]!)
  }
  return out
}

/** 文字在世界坐标下的宽度：等宽字体下 = 字数 × 字号 × 0.6（`0.6` 是等宽字形的典型宽高比） */
function labelWorldWidth(text: string, labelSize: number): number {
  return [...text].length * labelSize * 0.6
}

/**
 * 数字的**字色与描边色**：按**数字底下那一块场**的颜色来定，而不是按线色。
 *
 * 为什么不能用线色（§A 轮的旧口径，用户实测否掉了）：线的颜色与它**旁边**的场色是两回事 ——
 * 浅色场上的浅色线（绿 / 橙 / 青）按线色判出"深字"，而描边当时写死白色 ⇒
 * **深字 + 白边**压在浅色场上，看起来就是"一坨黑"（用户原话："还是黑色的"）。
 *
 * 两条新口径（施工文件 §A.4 已同步）：
 * 1. **字色**与"字底下的场色"对比（取不到场值时退回按线色判，保证边缘不空）；
 * 2. **描边色与字色相反**（白字配深边 / 深字配浅边）—— 描边的作用是"把字从背景里抠出来"，
 *    跟字色同色等于没描边。
 */
function labelColorsUnder(
  field: FieldGrid,
  ramp: RampSpec,
  position: readonly [number, number],
  lineColor: string,
): { color: string; haloColor: string } {
  const index = Math.round((position[0] - field.originX) / field.step)
  const row = Math.round((position[1] - field.originY) / field.step)
  const inside = index >= 0 && index < field.cols && row >= 0 && row < field.rows
  const value = inside ? fieldValue(field, index, row) : null
  const under = value === null ? null : colorForValue(value, ramp)
  const base = under === null ? lineColor : under.color
  return { color: textColorOf(base), haloColor: oppositeTextColor(base) }
}

/* ------------------------------------------------------------------ 主入口 */

/**
 * 生成绘制计划。
 *
 * `hex` 模式：每格一个多边形（颜色来自色带，越界格用纯色）+ 数值文字
 * （`showValues` 时所有格都写；`labelOutOfRange` 时越界格**总是**写）。
 * `field` 模式：连续填色片（`fieldFillCells`）+ 每个等值层级一条折线；颜色取该数值在色带里的颜色。
 * 没有数据的格 / 采样点**不产出任何图元** —— "缺数据"与"极低温"是两件事。
 */
export function buildFieldPlan(input: FieldPlanInput): FieldPlan {
  const opacity = clamp01(input.opacity)
  const formatValue = input.formatValue ?? defaultFormatValue

  if (input.mode === 'field') {
    const field =
      input.precomputedField ??
      sampleField(input.samples, input.grid, {
        ...(input.sampleStep !== undefined ? { step: input.sampleStep } : {}),
        ...(input.sampleRadius !== undefined ? { radius: input.sampleRadius } : {}),
        ...(input.maxFieldCells !== undefined ? { maxCells: input.maxFieldCells } : {}),
      })
    if (field === null) return { primitives: [], field: null }
    const primitives: FieldPrimitive[] = [fieldRaster(field, input.ramp, opacity)]
    const labelSize =
      Number.isFinite(input.labelSize) && (input.labelSize ?? 0) > 0
        ? input.labelSize!
        : input.grid.size * CONTOUR_LABEL_SCALE
    const labelSpacing =
      Number.isFinite(input.labelSpacing) && (input.labelSpacing ?? 0) > 0
        ? input.labelSpacing!
        : input.grid.size * DEFAULT_CONTOUR_LABEL_SPACING_FACTOR

    // ① 先把每一层的"线 + 每条线上的切点"算出来（**先不算图元**）。
    //    为什么要分两趟：全局上限要按"所有层合计"抽稀，得先知道总量。
    interface PlannedLine {
      points: Array<[number, number]>
      /** 这条线上数字的弧长位置（空 = 这条线不标） */
      positions: number[]
      color: string
      text: string
      gap: number
    }
    const levels: Array<{ level: number; lines: PlannedLine[] }> = []
    for (const level of contourLevels(input.ramp, input.contourInterval ?? null, input.maxContours)) {
      const style = colorForValue(level, input.ramp)
      if (style === null) continue
      const text = formatValue(level)
      const gap = labelWorldWidth(text, labelSize)
      // 线序**先定死**（长度降序 → 起点坐标字典序，见 `compareContourCandidates`）：
      // 抽稀与"先画谁"都跟着它走，于是同一份数据永远得到同一批数字（逐帧不抖、缓存不失效）
      const lines = contourPolylines(field, level)
        .filter((points) => points.length >= 2)
        .map((points, index): ContourCandidate & { points: Array<[number, number]> } => ({
          points,
          index,
          length: polylineLength(points),
        }))
        .sort(compareContourCandidates)
        .map((candidate) => ({
          points: candidate.points,
          positions: contourLabelPositions(candidate.length, gap, labelSpacing),
          color: style.color,
          text,
          gap,
        }))
      levels.push({ level, lines })
    }

    // ② 每层最多 12 个数字：把"线 × 切点"摊平后**沿线均匀抽样**（不是只留最长的几条）
    interface PlannedLabel {
      level: number
      lineIndex: number
      line: PlannedLine
      position: number
    }
    const perLevel: PlannedLabel[][] = levels.map((entry) =>
      sampleEvenly(
        entry.lines.flatMap((line, lineIndex) =>
          line.positions.map((position) => ({ level: entry.level, lineIndex, line, position })),
        ),
        MAX_CONTOUR_LABELS_PER_LEVEL,
      ),
    )
    // ③ 全局上限：所有层合计不超过 200（巨大地图上不让数字总量爆炸）
    const all = perLevel.flat()
    const kept = sampleEvenly(all, MAX_CONTOUR_LABELS_TOTAL)
    const keptByLine = new Map<string, PlannedLabel[]>()
    for (const label of kept) {
      const key = `${label.level}:${label.lineIndex}`
      const list = keptByLine.get(key)
      if (list === undefined) keptByLine.set(key, [label])
      else list.push(label)
    }

    // ④ 按层的顺序把图元画出来（线在数字处**真的断开**，不是"拿背景色盖住"）
    for (const entry of levels) {
      entry.lines.forEach((line, lineIndex) => {
        const labels = (keptByLine.get(`${entry.level}:${lineIndex}`) ?? []).sort((a, b) => a.position - b.position)
        if (labels.length === 0) {
          primitives.push({ kind: 'polyline', points: line.points, color: line.color, width: CONTOUR_WIDTH, opacity })
          return
        }
        const cut = cutPolylineAt(
          line.points,
          labels.map((label) => label.position),
          line.gap,
        )
        if (cut === null) {
          // 切不动（线太短 / 缝会吃掉某一段）→ 整条线照画不标，半个数字都不写
          primitives.push({ kind: 'polyline', points: line.points, color: line.color, width: CONTOUR_WIDTH, opacity })
          return
        }
        for (const segment of cut.segments) {
          primitives.push({ kind: 'polyline', points: segment, color: line.color, width: CONTOUR_WIDTH, opacity })
        }
        for (const piece of cut.cuts) {
          // 字色按**字底下的场色**取、描边与字色相反（见 `labelColorsUnder`）
          const colors = labelColorsUnder(field, input.ramp, piece.position, line.color)
          primitives.push({
            kind: 'text',
            x: piece.position[0],
            y: piece.position[1],
            text: line.text,
            color: colors.color,
            haloColor: colors.haloColor,
            rotation: piece.angle,
            size: labelSize,
          })
        }
      })
    }
    return { primitives, field }
  }

  const primitives: FieldPrimitive[] = []
  for (const sample of input.samples) {
    const style = colorForValue(sample.value, input.ramp)
    if (style === null) continue
    const corners = hexCorners(input.grid, sample.q, sample.r)
    primitives.push({
      kind: 'polygon',
      points: corners.map((point) => [point.x, point.y] as [number, number]),
      color: style.color,
      opacity,
    })
    // 越界格**总是**写数值：颜色只能表达"比上限还高"，表达不了"高多少"（数据层的口径）。
    // 兜底格例外：它是"这张图的基线"，不是量出来的数据，所以即使越界也不写字（满屏 15 会误导，§B.3）。
    const shouldLabel =
      sample.fallback !== true &&
      (input.showValues === true || (input.labelOutOfRange === true && style.outOfRange !== null))
    if (shouldLabel) {
      const center = axialToWorld(input.grid, sample.q, sample.r)
      primitives.push({
        kind: 'text',
        x: center.x,
        y: center.y,
        text: formatValue(sample.value),
        color: style.textColor,
      })
    }
  }
  return { primitives, field: null }
}