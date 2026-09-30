/**
 * 数值图层的**绘制计划**：把"一格一个数值"变成**图元清单** —— 纯函数模块，不 import obsidian。
 *
 * 为什么这一层必须单独存在（工单 C / D 的共同要求）：**几何只能有一份**。
 * 画布（`overlayDraw.ts`）与导出 / Base 缩略图（`base/mapPreview.ts`）都调 `buildOverlayPlan()`
 * 拿同一批图元，各自只做"把图元落到自己的后端"（canvas vs SVG 字符串）。
 * 若两边各写一遍逐格循环或各写一遍插值，"导出的图与画布不一样"就会变成长期缺陷
 * （本项目已经因为"抄一份调色板"出过真事故，见 `ENGINEERING-NOTES.md` §5.30）。
 *
 * 它同时是**统计的唯一来源**：画了几格 / 几格越界 / 几条等值线 / 几个数值文字，
 * 都从同一份图元清单数出来 —— 于是"叠加层没画出来"能被断言抓到，而不是靠肉眼看截图。
 *
 * 依赖方向：本模块 → `fieldPlan`（图元 IR）→ `colorRamp`；**不反向**。
 */

import { hexCorners, parseCellKey } from '../core/hex.ts'
import type { BBox } from '../core/viewport.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import { colorForValue } from './colorRamp.ts'
import { defaultFor } from './dataDefaults.ts'
import { DEFAULT_ELEVATION_CALIBRATION } from './elevationUnits.ts'
import {
  buildFieldPlan,
  CONTOUR_LABEL_SCALE,
  DEFAULT_MAX_FIELD_CELLS,
  hashFieldSamples,
  sampleField,
  type FieldGrid,
  type FieldPlan,
  type FieldPrimitive,
  type FieldSample,
} from './fieldPlan.ts'
import { cellIntersectsBBox } from './hexGrid.ts'
import {
  formatFieldReading,
  isCategoryField,
  isNumericField,
  type CategoryOverlayFieldSpec,
  type NumericOverlayFieldSpec,
  type OverlayFieldSpec,
  type OverlayStyle,
} from './overlayFields.ts'

/** 一条数值图层这一帧到底画了什么（可断言的数字，而不是"看起来有颜色"） */
export interface OverlayPlanStats {
  mode: 'cell' | 'field'
  /** 图元总数（含数值文字与等值线） */
  primitives: number
  /** **色块**个数：逐格模式 = 画出的格数；连续场 = 填色片数 */
  drawn: number
  /** 其中走了 `under` / `over` 纯色的个数 */
  outOfRange: number
  /** 数值文字个数（导出侧恒为 0，见 `labels` 输入） */
  labels: number
  /** 等值线折线条数（逐格模式恒为 0） */
  contours: number
  /** 连续场采样网格的点数（逐格模式为 0） */
  sampled: number
}

export interface OverlayPlanInput {
  document: MapDocument
  spec: OverlayFieldSpec
  style: OverlayStyle
  /**
   * 视口剔除。**只作用于逐格模式** ——
   * 连续场要靠视口外的邻居插值，先裁样本会让边缘"断在格心"（那不是用户要的形状）。
   */
  bounds?: BBox
  /**
   * 是否产出数值文字。缺省 `true`（画布行为）。
   *
   * 导出侧传 `false`：导出的图要能看清地形，密铺的数字会把图糊住
   * （工单 D 明说"每格写数值在导出里默认关闭"）。
   */
  labels?: boolean
  /** 已经算好的采样网格（缓存用） */
  precomputedField?: FieldGrid
  /**
   * 连续场的**计划缓存**（由绘制层持有、每个字段一份）。
   *
   * 给了它，连续场整份计划（采样 + 逐点上色的栅格 + 等值线）都会按"数据指纹 + 显示参数"
   * 缓存 —— 每帧只剩"画"（一次 `drawImage` 加几条折线）。
   * 逐格模式不走缓存：它天然被视口裁着，而且没有逐点上色那种贵活儿。
   */
  cache?: OverlayFieldCache
  /**
   * **分类字段**的"值 → 颜色"覆盖（来自**现读**的分类目录：内置 + 自定义）。
   *
   * 为什么要从外面传：自定义生物群系的颜色住在插件设置里，而本模块是纯函数层。
   * 缺省时用字段自带的回退（只认内置目录）—— 于是导出侧、单测、没有设置上下文时
   * 也能画出一份**颜色正确**的图，只是不含用户自定义的那几条。
   */
  categoryColors?: ReadonlyMap<string, string>
}

export interface OverlayPlanResult {
  plan: FieldPlan
  stats: OverlayPlanStats
}

/**
 * 采集"这一层有值的格"。
 *
 * 只有 `spec.read` 给出的**有限数**才算数据（没有值 / 坏值都不进样本）——
 * 与"缺数据不许用 0 冒充"是同一条口径，且这里是**唯一的**采集点：
 * 画布与导出都从这里取，不会出现"画布算上了某格、导出没算"这类分歧。
 *
 * **兜底**（§B）：格上没有真值时，用地图文件 `dataDefaults` 里这个字段的默认值补一个样本，
 * 并打上 `fallback: true`（逐格模式下它不写数值，见 `fieldPlan`）。
 * 于是"画过地形的整片区域都会有颜色"，而**文件里的格一个字节都不改**。
 * 文件里没有的格（空白区）仍然不画 —— 地图是稀疏的，"铺满范围"是另一件事（本轮不做）。
 */
export function collectOverlaySamples(
  document: MapDocument,
  spec: NumericOverlayFieldSpec,
  bounds?: BBox,
): FieldSample[] {
  const samples: FieldSample[] = []
  const grid = document.grid
  for (const [key, cell] of Object.entries(document.terrain)) {
    const value = spec.read(cell)
    const fallback = value === undefined ? defaultFor(document.dataDefaults, spec.cellKey) : undefined
    if (value === undefined && fallback === undefined) continue
    const axial = parseCellKey(key)
    if (axial === null) continue
    // 视口裁剪只对逐格模式有用（连续场的样本是插值的输入，不能先裁）
    if (bounds !== undefined && !cellIntersectsBBox(grid, axial.q, axial.r, bounds)) continue
    samples.push(
      value !== undefined
        ? { q: axial.q, r: axial.r, value }
        : { q: axial.q, r: axial.r, value: fallback!, fallback: true },
    )
  }
  return samples
}

/** 全零统计（"这一层这一帧什么都没画"） */
function emptyStats(): OverlayPlanStats {
  return { mode: 'cell', primitives: 0, drawn: 0, outOfRange: 0, labels: 0, contours: 0, sampled: 0 }
}

/**
 * **分类字段**的计划：每一格一个**纯色六边形**。
 *
 * 三条口径（与数值字段不同的地方）：
 * 1. **不插值、不画等值线、不写数值文字** —— 分类值之间没有"高低"（`"森林" > "沙漠"` 是胡说）；
 * 2. **没填的格不画**（与数值字段同一条："没有数据"不是"某个颜色"）；
 * 3. **认不出的 ID 用中性灰** —— "未知"必须看得见（§5.11），而不是消失或变成透明。
 *
 * 几何仍然只有一份：六边形顶点来自 `core/hex.ts` 的 `hexCorners`，
 * 与 `fieldPlan` 的逐格分支**同一个函数**。
 */
function buildCategoryPlan(
  input: OverlayPlanInput & { spec: CategoryOverlayFieldSpec },
): OverlayPlanResult {
  const { document, spec, style, bounds, categoryColors } = input
  const primitives: FieldPrimitive[] = []
  const opacity = style.opacity
  for (const [key, cell] of Object.entries(document.terrain)) {
    const id = spec.readCategory(cell)
    if (id === undefined) continue
    const axial = parseCellKey(key)
    if (axial === null) continue
    if (bounds !== undefined && !cellIntersectsBBox(document.grid, axial.q, axial.r, bounds)) continue
    // 现读的自定义目录优先；没有就用字段自带的回退（内置目录 / 中性灰）
    const color = categoryColors?.get(id) ?? spec.resolveColor(id, style)
    if (typeof color !== 'string' || color.length === 0) continue
    const corners = hexCorners(document.grid, axial.q, axial.r)
    primitives.push({
      kind: 'polygon',
      points: corners.map((point) => [point.x, point.y] as [number, number]),
      color,
      opacity,
    })
  }
  return {
    plan: { primitives, field: null },
    stats: {
      mode: 'cell',
      primitives: primitives.length,
      drawn: primitives.length,
      // 分类字段没有"越界"这个概念（也就没有纯色兜底那一说）
      outOfRange: 0,
      labels: 0,
      contours: 0,
      sampled: 0,
    },
  }
}

/** 数一数这些值里有多少个落在配色之外（与画布同一个 `colorForValue`，绝不另写比较） */
function countOutOfRange(values: Iterable<number>, ramp: OverlayStyle['ramp']): number {
  let count = 0
  for (const value of values) {
    if (colorForValue(value, ramp)?.outOfRange != null) count += 1
  }
  return count
}

function fieldValues(field: FieldGrid): number[] {
  const values: number[] = []
  for (const value of field.values) {
    if (value !== null) values.push(value)
  }
  return values
}

/**
 * 生成一条数值图层这一帧的图元清单与统计。
 *
 * 各输入的作用：`bounds` 只裁逐格模式的格；`labels: false` 去掉**逐格数值**（导出用）；
 * `cache` 让连续场整份计划（采样 + 逐点上色 + 等值线）只算一次。
 */
export function buildOverlayPlan(input: OverlayPlanInput): OverlayPlanResult {
  const { document, spec, style } = input
  // **分类字段走完全不同的那条路**：分类值之间没有高低，插值 / 等值线 / 数值文字都没有意义。
  // 放在最前面而不是"在数值那条路里加分支"：后者的每一段都要多写一个"分类怎么办"，
  // 而答案永远是"不适用"——那种分支会一路烂进 `fieldPlan`。
  if (isCategoryField(spec)) return buildCategoryPlan({ ...input, spec })
  if (!isNumericField(spec)) {
    // 既不是数值也不是分类：只可能是字段表被改坏了。返回空计划（渲染层照常继续画别的层）
    return { plan: { primitives: [], field: null }, stats: emptyStats() }
  }

  const mode: 'cell' | 'field' = style.mode === 'field' ? 'field' : 'cell'
  const calibration = document.elevation ?? DEFAULT_ELEVATION_CALIBRATION
  const withLabels = input.labels !== false

  // 连续场：整份计划按"数据指纹 + 显示参数"缓存（逐点上色是几千到几万次，每帧重来太浪费）。
  // 键不含视口 → 平移不失效；键含配色与不透明度 → 改了颜色下一帧就是新颜色。
  if (mode === 'field' && input.cache !== undefined) {
    const samples = collectOverlaySamples(document, spec)
    const key = overlayFieldCacheKey(spec, document, samples, style)
    const plan = cachedOverlayPlan(input.cache, key, () =>
      buildFieldPlan({
        samples,
        grid: document.grid,
        ramp: style.ramp,
        mode: 'field',
        opacity: style.opacity,
        contourInterval: style.contourInterval,
        maxFieldCells: DEFAULT_MAX_FIELD_CELLS,
        formatValue: (value: number) => formatFieldReading(spec, value, style, calibration),
        // 标注字号与重复间隔都进几何：前者决定"在线上挖多长一段"，后者决定"每隔多远放一个"
        // （挖的缝比字窄、或间隔没进几何，数字就会压到线上 / 密到糊）
        labelSize: document.grid.size * CONTOUR_LABEL_SCALE,
        labelSpacing: document.grid.size * style.contourLabelSpacing,
      }),
    )
    return { plan, stats: statsOf(plan, mode, style.ramp, samples) }
  }

  const samples = collectOverlaySamples(document, spec, mode === 'cell' ? input.bounds : undefined)
  const plan = buildFieldPlan({
    samples,
    grid: document.grid,
    ramp: style.ramp,
    // `fieldPlan` 的 IR 用 `hex` 表示"逐格"（它的两种模式是几何意义上的）；设置里叫 `cell`（显示方式）
    mode: mode === 'field' ? 'field' : 'hex',
    opacity: style.opacity,
    ...(mode === 'cell'
      ? {
          showValues: withLabels && style.showValues,
          labelOutOfRange: withLabels,
          formatValue: (value: number) => formatFieldReading(spec, value, style, calibration),
        }
      : {
          contourInterval: style.contourInterval,
          maxFieldCells: DEFAULT_MAX_FIELD_CELLS,
          formatValue: (value: number) => formatFieldReading(spec, value, style, calibration),
          labelSize: document.grid.size * CONTOUR_LABEL_SCALE,
          labelSpacing: document.grid.size * style.contourLabelSpacing,
          ...(input.precomputedField !== undefined ? { precomputedField: input.precomputedField } : {}),
        }),
  })
  return { plan, stats: statsOf(plan, mode, style.ramp, samples) }
}

/**
 * 从**图元清单**数出这一帧的统计。
 *
 * 为什么按图元数而不是按样本数：用户看到的就是图元。
 * "有 5 格数据却只画出 3 格"这种事只有数图元才发现得了。
 */
function statsOf(
  plan: FieldPlan,
  mode: 'cell' | 'field',
  ramp: OverlayStyle['ramp'],
  samples: readonly FieldSample[],
): OverlayPlanStats {
  const primitives = plan.primitives
  let drawn = 0
  let labels = 0
  let contours = 0
  for (const primitive of primitives) {
    if (primitive.kind === 'text') labels += 1
    else if (primitive.kind === 'polyline') contours += 1
    else drawn += 1
  }
  // 越界数按**值**数（逐格模式数样本的值、连续场数采样网格的值）——
  // 不用"颜色等于 under/over"来反推：带内的颜色恰好等于那两色时会数错。
  const values = mode === 'field' && plan.field !== null ? fieldValues(plan.field) : samples.map((sample) => sample.value)
  return {
    mode,
    primitives: primitives.length,
    drawn,
    outOfRange: countOutOfRange(values, ramp),
    labels,
    contours,
    sampled: plan.field === null ? 0 : plan.field.cols * plan.field.rows,
  }
}

/* ------------------------------------------------------------------ 连续场的采样缓存 */

/**
 * 连续场的**计划缓存**（每个字段一份）。
 *
 * 缓存的是整份 `FieldPlan`（采样网格 + 逐点上色的栅格 + 等值线），不是一个"半成品"：
 * - 逐点上色是几千到几万次 `colorForValue`（带 Oklab 插值），每帧重来是纯浪费；
 * - 缓存里最贵的部分（IDW 采样 + 像素）与最便宜的部分（等值线）**没法拆开缓存**，
 *   而重新插值一次也就毫秒级 —— 拆开只会多一层状态，不值；
 * - 于是"改了配色颜色"会整体重算一次（用户手改设置，次数可忽略），下一帧就是新颜色。
 *
 * 键里的数据指纹见 `hashFieldSamples`（**值**参与哈希 —— 否则"改了一格的值画面不变"）。
 * 键**不含视口**：平移不会让缓存失效（比"按可见矩形缓存"更省）。
 */
export interface OverlayFieldCache {
  key: string | null
  plan: FieldPlan | null
  /** 累计重算次数（断言"第二帧没有重新采样"用它） */
  builds: number
  /** 累计命中次数 */
  hits: number
}

export function createOverlayFieldCache(): OverlayFieldCache {
  return { key: null, plan: null, builds: 0, hits: 0 }
}

/**
 * 连续场的缓存键：字段 + 数据指纹 + 采样参数 + **一切会改变图元的显示参数**。
 *
 * 显示参数（配色 / 不透明度 / 等值线间距 / 显示方式）必须进键：它们直接改图元，
 * 漏掉任何一个就会表现成"在设置里改了颜色，画布要等下一次数据变化才更新"
 * （比"改了不重算"更隐蔽 —— 因为它看起来像"偶尔慢半拍"）。
 */
export function overlayFieldCacheKey(
  spec: OverlayFieldSpec,
  document: MapDocument,
  samples: readonly FieldSample[],
  style: OverlayStyle,
): string {
  return [
    spec.id,
    hashFieldSamples(samples),
    document.grid.size,
    DEFAULT_MAX_FIELD_CELLS,
    style.mode,
    style.opacity,
    style.contourInterval ?? '',
    // 数字的重复间隔也进键：它是**几何**（决定沿线上有几个数字）——
    // 漏掉它就会表现成"在设置里把间隔调小了，画面要等下次数据变化才变密"（用户验收项之一）
    style.contourLabelSpacing,
    // 展示单位与地图标定也要进键：它们**不改变几何**，但改变等值线上的数字
    // （"5" 与 "5 km" 是同一层线）。漏掉这两项就会表现成"在设置里换了单位，
    // 线还在、数字要等下次数据变化才更新" —— 比"改了颜色不刷新"更隐蔽。
    style.unit ?? '',
    JSON.stringify(document.elevation ?? null),
    JSON.stringify(style.ramp),
  ].join('|')
}

/** 取（必要时重算）整份计划；`build` 只在未命中时调用 */
export function cachedOverlayPlan(cache: OverlayFieldCache, key: string, build: () => FieldPlan): FieldPlan {
  if (cache.key === key && cache.plan !== null) {
    cache.hits += 1
    return cache.plan
  }
  const plan = build()
  cache.key = key
  cache.plan = plan
  cache.builds += 1
  return plan
}