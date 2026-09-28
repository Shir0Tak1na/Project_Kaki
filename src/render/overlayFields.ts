/**
 * 数据层（覆盖层）的**字段描述表** —— 温度是第一份模板，深度与生物群系后面按同一形状加。
 *
 * 为什么要有这张表：温度、深度、湿度……在代码里的差别只有三件事 ——
 * **从格上读哪个键**、**叫什么名字（含单位）**、**出厂色带长什么样**。
 * 把这三件事写成一行配置，渲染 / 设置页 / 图例就都能遍历它；
 * 否则每加一个字段都要在三四处分头加分支（工单 B 之前的图层开关就是这么烂掉的）。
 *
 * 三条边界（都写在这里，避免以后被"顺手"破坏）：
 *
 * 1. **纯数据 + 纯函数，不 import obsidian**：于是"哪个键算温度""坏值算不算数据"都能单测；
 * 2. **值属于地图文件，样式属于插件设置**：这张表只说"去哪儿读值"，
 *    色带 / 透明度 / 是否画数值都在 `OverlayStyle` 里（由设置持有，见 `settingsModel.ts`）；
 * 3. **可见性不在这里**：看不看由图层描述表（`LAYER_TABLE` 里 `layerId` 那一行）说了算 ——
 *    本节只描述"这一层画的是什么值"。同一件事存两份必然出现互相矛盾的状态（§5.12）。
 */

import type { TerrainCell } from '../data/mapDocument.ts'
import { defaultDepthRamp, defaultTemperatureRamp, normalizeRampSpec, type RampSpec } from './colorRamp.ts'
import { formatDepthReading, type DepthDisplayUnit, type ElevationCalibration } from './elevationUnits.ts'
import type { LayerKey } from './layerVisibility.ts'

/** 数据字段的 ID：它同时是设置键、图例 kind（`temperature` 对应图层 id 也是它） */
export type FieldId = 'temperature' | 'depth'

/** 数据层的渲染参数（插件设置，**不是**地图文件里的东西） */
export interface OverlayStyle {
  /**
   * 色块的不透明度（0–1）。
   *
   * 默认 0.5 而不是 1：叠加层的意义是"在地形之上加一层信息"，
   * 全不透明会把地形整个盖掉，用户就没法边看地形边看温度了。
   */
  opacity: number
  /**
   * 在**每个**格心画出数值。默认关：密铺时数字比颜色吵，需要读数时再打开。
   *
   * ⚠️ 它管不了**越界格**：越界格**总是**写数值（即使这一项是关的）——
   * 颜色只能表达"比上限还高"，表达不了"高多少"，而越界恰恰最需要读数（见 `overlayDraw.ts`）。
   */
  showValues: boolean
  /** 值 → 颜色的分段色带（含越界两端的纯色） */
  ramp: RampSpec
  /**
   * **展示单位**（只有声明了 `units` 的字段才有意义，例如深度的 m / km / 相对值）。
   *
   * 它是"我怎么读这个值"，所以住在插件设置里、与色带并列，**不写进地图文件**
   * （地图文件只存一个权威值 + 地图级标定段，见 `elevationUnits.ts` 与设计草案 §2.2）。
   * 温度这类不需要换算的字段永远没有这一项。
   */
  unit?: DepthDisplayUnit
  /**
   * **显示方式**：`cell` = 逐格上色（局限在六边形格内）；`field` = 连续场（格心值插值成连续面 + 等值线）。
   *
   * 出厂是 `cell`：老设置里没有这一项时按 `cell` 收敛，于是升级后**画面一字不变**。
   * 连续场的几何由 `fieldPlan.ts` 的图元 IR 产出（画布与导出共用同一份）。
   */
  mode: OverlayMode
  /**
   * 连续场：**等值线间距**（与字段同单位）；`null` = 不按间距取，直接用色带锚点
   * （"5 个体感温度分类"那 5 条线就是现成的，见 `fieldPlan.contourLevels`）。
   *
   * 逐格模式下这一项无意义（界面上也不显示），但仍然存着 —— 切回来时用户上次填的值还在。
   */
  contourInterval: number | null
}

/** 数据层的两种显示方式（下拉选项的顺序就是这里的顺序） */
export type OverlayMode = 'cell' | 'field'

export const OVERLAY_MODES: readonly { value: OverlayMode; label: string }[] = [
  { value: 'cell', label: '逐格上色' },
  { value: 'field', label: '连续场（等值线）' },
]

export const DEFAULT_OVERLAY_MODE: OverlayMode = 'cell'

/**
 * 数值文字的**字体栈**（画布与导出共用一条）。
 *
 * 用户实机提的两条之一："用编程字体的数字" —— 数字等宽才好在密铺的格上对齐；
 * 顺带一个好处：等宽字体的数字宽度一致，导出与画布的换行/裁切行为不会差一像素。
 */
export const OVERLAY_LABEL_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace'

/**
 * 数值文字的**字号比例**（相对"格半径"或"等值线标注半径"）。
 *
 * 0.5 是用户实机反馈的第二条（"希望能小一点"）：原来按 0.7 画，六边形里挤得慌；
 * 换成 0.5 之后两位数的读数在格心仍清楚，长数字（例如 `-1200`）也不至于顶出格子。
 * 两个后端各在自己的坐标空间里乘这个比例（画布是位图像素、SVG 是 SVG 单位），
 * 于是"画布上的相对大小"与"导出里的相对大小"是同一条式子。
 */
export const OVERLAY_LABEL_SCALE = 0.5

/**
 * 垂直居中的**基线偏移比例**。
 *
 * 为什么不用 `textBaseline = 'middle'` / `dominant-baseline="middle"`：
 * 那两个都是"按 em 盒居中"，而数字只占 em 盒的上半截，视觉上会偏上（用户实机说"不在正中间"）。
 * 数字的下沿落在基线上、高度约 0.7em，所以**把基线放在中心下 0.35em** 才是看着正中。
 * 画布用 `textBaseline='alphabetic'` + `y + size * 0.35`，SVG 用 `dy="0.35em"` —— 同一条口径。
 */
export const OVERLAY_LABEL_BASELINE_RATIO = 0.35

/** 带单位字段的"值怎么读"：可选单位 + 出厂值 + 两种后缀写法（都收在这一处，避免散落） */
export interface OverlayFieldUnits {
  /** 可选展示单位（设置页下拉的选项顺序） */
  options: readonly DepthDisplayUnit[]
  /** 出厂展示单位 */
  defaultUnit: DepthDisplayUnit
  /** 图例标题里的写法（`深度 / 海拔（km）`） */
  titleOf: (unit: DepthDisplayUnit) => string
  /** 数值 / 图例刻度后面的后缀（相对值无量纲 → 空串；米 / 千米带一个前导空格） */
  suffixOf: (unit: DepthDisplayUnit) => string
}

export interface OverlayFieldSpec {
  /** 字段 ID（设置键 / 图例用） */
  id: FieldId
  /** 对应的**图层 id**（`LAYER_TABLE` 里那一行；可见性只由它决定） */
  layerId: LayerKey
  /** 一格上挂这个值的键名（写进地图文件的那一个） */
  cellKey: 'temp' | 'depth'
  /** 给人看的名字（设置页、图例） */
  label: string
  /** 单位后缀（图例与数值文字用；空串表示无量纲） */
  unit: string
  /** 这个字段有没有"展示单位"（深度有；温度没有）。有则 `OverlayStyle.unit` 生效 */
  units?: OverlayFieldUnits
  /** 从一格读出这个字段的值；**没有数据时返回 `undefined`**（绝不返回 0 冒充） */
  read: (cell: TerrainCell | undefined) => number | undefined
  /**
   * 值（权威单位）→ **短读数**（画布上的数值文字 / 图例刻度）。
   *
   * 缺省 = 通用的一位小数格式（温度就是这种）。有展示单位的字段在这里做换算，
   * 标定从**地图文件**的 `elevation` 段现取 —— 于是"换成千米"只是换个读法，文件不动。
   */
  format?: (value: number, style: OverlayStyle, calibration: ElevationCalibration) => string
  /** 这一层的出厂样式（每次调用返回新对象） */
  defaultStyle: () => OverlayStyle
}

/**
 * 只有"有限数"才算数据。
 *
 * `null` / 字符串 / NaN / Infinity 一律当作**没有这个值**：
 * 解析层已经把非法值原样收进 `extra` 并告警（§5.40），渲染层看到的就是"没有数据"。
 * 这里返回 `undefined` 而不是 0 或色带端点 —— 缺数据被画成"极低温"是彻底的说谎。
 */
function readFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 深度 / 海拔的展示单位。选项顺序 = 设置页下拉的顺序；相对值需要地图已标定（日志见 §2.2） */
export const DEPTH_UNITS: OverlayFieldUnits = {
  options: ['m', 'km', 'rel'],
  defaultUnit: 'm',
  titleOf: (unit) => (unit === 'rel' ? '相对值 0–1' : unit),
  suffixOf: (unit) => (unit === 'rel' ? '' : ` ${unit}`),
}

/** 数值文字：最多一位小数，整数不带 `.0`（密铺时越短越不吵） */
export function formatOverlayValue(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

const TEMPERATURE_FIELD: OverlayFieldSpec = {
  id: 'temperature',
  layerId: 'temperature',
  cellKey: 'temp',
  label: '温度',
  unit: '℃',
  read: (cell) => readFinite(cell?.temp),
  defaultStyle: () => ({ opacity: 0.5, showValues: false, ramp: defaultTemperatureRamp(), mode: 'cell', contourInterval: null }),
}

/**
 * 深度 / 海拔：与温度同源的第二个字段，**多一件事 —— 它有展示单位**。
 *
 * 文件里的值永远是米（0 = 海平面、正 = 向下），m / km / 相对值只是**读法**：
 * 米与千米不需要标定，相对值需要地图的 `elevation` 段（未标定时读数显示"未标定"，
 * 而不是拿一个编造的尺度凑数）。
 */
const DEPTH_FIELD: OverlayFieldSpec = {
  id: 'depth',
  layerId: 'depth',
  cellKey: 'depth',
  label: '深度 / 海拔',
  unit: 'm',
  units: DEPTH_UNITS,
  read: (cell) => readFinite(cell?.depth),
  // 归一化保证 `style.unit` 一定是三个合法值之一，所以这里的兜底只是类型上的需要
  format: (value, style, calibration) => formatDepthReading(value, style.unit ?? 'm', calibration),
  defaultStyle: () => ({ opacity: 0.5, showValues: false, ramp: defaultDepthRamp(), unit: 'm', mode: 'cell', contourInterval: null }),
}

/**
 * 字段登记表。**加一个字段 = 加一行**（外加 `LAYER_TABLE` 里对应的一行图层）。
 *
 * 温度是第一份模板：它的形状就是后面深度 / 生物群系要照抄的形状。
 * 深度是第二份 —— 多出来的只有 `units` 与 `format`（"值怎么读"），渲染 / 图例 / 设置页都不用改。
 */
export const OVERLAY_FIELDS: readonly OverlayFieldSpec[] = [TEMPERATURE_FIELD, DEPTH_FIELD]

/** 这一层当前的展示单位（没有 `units` 的字段是 `undefined`） */
export function overlayUnitOf(spec: OverlayFieldSpec, style: OverlayStyle): DepthDisplayUnit | undefined {
  if (!spec.units) return undefined
  const unit = style.unit
  return unit !== undefined && spec.units.options.includes(unit) ? unit : spec.units.defaultUnit
}

/** 图例标题里的单位写法（温度是 `℃`，深度随展示单位变） */
export function overlayUnitTitle(spec: OverlayFieldSpec, style: OverlayStyle): string {
  const unit = overlayUnitOf(spec, style)
  return unit === undefined ? spec.unit : spec.units!.titleOf(unit)
}

/** 数值 / 图例刻度后面的后缀（温度是紧跟的 `℃`；深度是 ` m` / ` km`；相对值为空串） */
export function overlayUnitSuffix(spec: OverlayFieldSpec, style: OverlayStyle): string {
  const unit = overlayUnitOf(spec, style)
  return unit === undefined ? spec.unit : spec.units!.suffixOf(unit)
}

/**
 * 值 → 短读数（画布文字 / 图例刻度 / 越界文案）。缺省用通用的一位小数格式。
 *
 * 这是**唯一**的"值怎么显示成字"入口：画布与图例都走它，于是"换成千米"在两边同时生效
 * （两处各写一遍必然分叉，本项目已经因为"两处各写一份"出过多次真事故）。
 */
export function formatFieldReading(
  spec: OverlayFieldSpec,
  value: number,
  style: OverlayStyle,
  calibration: ElevationCalibration,
): string {
  if (spec.format) return spec.format(value, style, calibration)
  return formatOverlayValue(value)
}

export type OverlayStyles = Record<FieldId, OverlayStyle>

const FIELD_BY_ID = new Map<string, OverlayFieldSpec>(OVERLAY_FIELDS.map((spec) => [spec.id, spec]))

/** 按 ID 取字段描述。ID 来自同一张表的联合类型，取不到只可能是代码写错，所以直接抛 */
export function overlayField(id: FieldId): OverlayFieldSpec {
  const spec = FIELD_BY_ID.get(id)
  if (!spec) throw new Error(`未知的数据层字段：${id}`)
  return spec
}

/** 出厂样式（每次返回新对象：设置对象会被整体替换，不能共用同一份引用） */
export function defaultOverlayStyles(): OverlayStyles {
  const out = {} as OverlayStyles
  for (const spec of OVERLAY_FIELDS) out[spec.id] = spec.defaultStyle()
  return out
}

export const DEFAULT_OVERLAY_STYLES: OverlayStyles = defaultOverlayStyles()

/* ------------------------------------------------------------------ 规范化 */

export const OVERLAY_OPACITY_MIN = 0
export const OVERLAY_OPACITY_MAX = 1
export const OVERLAY_OPACITY_STEP = 0.05

function normalizeOpacity(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(OVERLAY_OPACITY_MAX, Math.max(OVERLAY_OPACITY_MIN, value))
}

/**
 * 把任意输入收敛成完整的覆盖层样式表。
 *
 * 缺项 / 坏值按**出厂值**补齐（同图层开关的口径）：用户手工改坏 `data.json` 时，
 * 结果是"看到的东西是出厂观感"，而不是"某一层消失且不知道为什么"。
 */
export function normalizeOverlayStyles(raw: unknown): OverlayStyles {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as OverlayStyles
  for (const spec of OVERLAY_FIELDS) {
    const fallback = spec.defaultStyle()
    const entry = source[spec.id]
    const record = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const style: OverlayStyle = {
      opacity: normalizeOpacity(record.opacity, fallback.opacity),
      showValues: typeof record.showValues === 'boolean' ? record.showValues : fallback.showValues,
      // 色带交给 colorRamp 自己的规范化：它知道"少于两条锚点就整体回退"这类规则
      ramp: normalizeRampSpec(record.ramp, fallback.ramp),
      // 显示方式：**只认登记表里那两个值**，其余（含老设置里的缺失）一律回退到出厂（逐格）
      mode: record.mode === 'field' || record.mode === 'cell' ? record.mode : fallback.mode,
      // 等值线间距：正的有限数才算；0 / 负数 / 非数字一律当"用色带锚点"（null），
      // 而不是悄悄取一个间隔 —— "0 间距"会让 levels 直接算成一个无限循环的意图
      contourInterval:
        typeof record.contourInterval === 'number' && Number.isFinite(record.contourInterval) && record.contourInterval > 0
          ? record.contourInterval
          : fallback.contourInterval,
    }
    // 展示单位只对有 `units` 的字段生效；别的字段**不写这一项**（写了就是无意义的第二份状态）
    if (spec.units) {
      const unit = record.unit
      style.unit = spec.units.options.includes(unit as DepthDisplayUnit)
        ? (unit as DepthDisplayUnit)
        : spec.units.defaultUnit
    }
    out[spec.id] = style
  }
  return out
}