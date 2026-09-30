/**
 * 数值图层（覆盖层）的**字段描述表** —— 温度是第一份模板，深度与生物群系后面按同一形状加。
 *
 * 为什么要有这张表：温度、深度、湿度……在代码里的差别只有三件事 ——
 * **从格上读哪个键**、**叫什么名字（含单位）**、**出厂配色长什么样**。
 * 把这三件事写成一行配置，渲染 / 设置页 / 图例就都能遍历它；
 * 否则每加一个字段都要在三四处分头加分支（工单 B 之前的图层开关就是这么烂掉的）。
 *
 * 三条边界（都写在这里，避免以后被"顺手"破坏）：
 *
 * 1. **纯数据 + 纯函数，不 import obsidian**：于是"哪个键算温度""坏值算不算数据"都能单测；
 * 2. **值属于地图文件，样式属于插件设置**：这张表只说"去哪儿读值"，
 *    配色 / 透明度 / 是否画数值都在 `OverlayStyle` 里（由设置持有，见 `settingsModel.ts`）；
 * 3. **可见性不在这里**：看不看由图层描述表（`LAYER_TABLE` 里 `layerId` 那一行）说了算 ——
 *    本节只描述"这一层画的是什么值"。同一件事存两份必然出现互相矛盾的状态（§5.12）。
 */

import type { TerrainCell } from '../data/mapDocument.ts'
import { DEFAULT_CONTOUR_LABEL_SPACING_FACTOR } from './fieldPlan.ts'
import { defaultDepthRamp, defaultTemperatureRamp, normalizeRampSpec, type RampSpec } from './colorRamp.ts'
import { formatDepthReading, type DepthDisplayUnit, type ElevationCalibration } from './elevationUnits.ts'
import { BIOME_UNKNOWN_COLOR, builtinBiomeColor } from './biomeCatalog.ts'
import type { LayerKey } from './layerVisibility.ts'

/** 数据字段的 ID：它同时是设置键、图例 kind（`temperature` 对应图层 id 也是它） */
export type FieldId = 'temperature' | 'depth' | 'biome'

/** 数值图层的渲染参数（插件设置，**不是**地图文件里的东西） */
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
  /** 值 → 颜色的分段配色（含越界两端的纯色） */
  ramp: RampSpec
  /**
   * **展示单位**（只有声明了 `units` 的字段才有意义，例如深度的 m / km / 相对值）。
   *
   * 它是"我怎么读这个值"，所以住在插件设置里、与配色并列，**不写进地图文件**
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
   * 连续场：**等值线间距**（与字段同单位）；`null` = 不按间距取，直接用配色锚点
   * （"5 个体感温度分类"那 5 条线就是现成的，见 `fieldPlan.contourLevels`）。
   *
   * 逐格模式下这一项无意义（界面上也不显示），但仍然存着 —— 切回来时用户上次填的值还在。
   */
  contourInterval: number | null
  /**
   * 连续场：等值线上数字的**重复间隔**（单位：**格半径的倍数**）。
   *
   * 用户追加要求："还要考虑每隔多少距离重复一次数字。" 等高线图的常规画法是"读数随处可读"，
   * 所以沿每条线每隔一段就重复标一次。它是**世界距离**（= 这个数 × 格半径），
   * 于是"调小"在任何缩放下都是同样的地图距离，不会"放大以后才变密"。
   *
   * 数字之间还有一条"至少 6 倍字宽"的下限（防挤），所以调得再小也不会糊成一团。
   * 逐格模式下这一项无意义（界面上也不显示），但仍然存着 —— 切回来时用户上次填的值还在。
   */
  contourLabelSpacing: number
  /**
   * **分类字段**（生物群系）的逐条配色覆盖：分类 ID → 颜色。
   *
   * 三条口径（`BIOMES.md` §3 决定三）：
   * - 颜色**属于目录条目**（每条自带），这里只存**用户逐条改过**的那些；
   * - 没改过的走目录里的颜色 —— 于是"换一份分类表 = 换一批颜色"，不必改代码；
   * - 与 `unit` 一样：**只有分类字段写这一项**，数值字段写了就是无意义的第二份状态
   *   （`normalizeOverlayStyles` 会按 `numeric` 决定收不收）。
   */
  categoryColors?: Record<string, string>
}

/** 数值图层的两种显示方式（下拉选项的顺序就是这里的顺序） */
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

export interface OverlayFieldSpecBase {
  /** 字段 ID（设置键 / 图例用） */
  id: FieldId
  /** 对应的**图层 id**（`LAYER_TABLE` 里那一行；可见性只由它决定） */
  layerId: LayerKey
  /** 一格上挂这个值的键名（写进地图文件的那一个） */
  cellKey: string
  /**
   * 这个字段的值是不是**一个数**。
   *
   * 为什么要有这一位（而不是"默认都是数"）："每格默认值"（§B）与"加减乘除笔刷"（§E）
   * 只对数值字段成立 —— 生物群系（§D）的值是一个**分类 ID**，没有"平均值"也没有"乘 2"。
   * 于是弹窗与笔刷遍历字段表时按这一位筛行，**不必在各处各写一份"哪几个字段是数值"的清单**。
   * 刻意写成**必填**（没有缺省）：加字段的人必须正面回答"它是数值还是分类"，漏写会被 tsc 拦住。
   *
   * ⚠️ 它同时是**判别属性**：`isNumericField` / `isCategoryField` 两个守卫据此把
   * `OverlayFieldSpec` 收窄成下面两个接口之一 —— 于是"分类字段没有 `read`"这件事
   * **在类型上就成立**，不必靠 `spec.read?.(cell)` 那种"到处记得加问号"的写法。
   */
  numeric: boolean
  /** 给人看的名字（设置页、图例） */
  label: string
  /** 单位后缀（图例与数值文字用；空串表示无量纲） */
  unit: string
  /** 这个字段有没有"展示单位"（深度有；温度没有）。有则 `OverlayStyle.unit` 生效 */
  units?: OverlayFieldUnits
  /** 这一层的出厂样式（每次调用返回新对象） */
  defaultStyle: () => OverlayStyle
}

/** 数值字段（温度 / 深度…）：值是一个有限数，能插值、能算等值线、能做加减乘除 */
export interface NumericOverlayFieldSpec extends OverlayFieldSpecBase {
  numeric: true
  /** 从一格读出这个字段的值；**没有数据时返回 `undefined`**（绝不返回 0 冒充） */
  read: (cell: TerrainCell | undefined) => number | undefined
  /**
   * 值（权威单位）→ **短读数**（画布上的数值文字 / 图例刻度）。
   *
   * 缺省 = 通用的一位小数格式（温度就是这种）。有展示单位的字段在这里做换算，
   * 标定从**地图文件**的 `elevation` 段现取 —— 于是"换成千米"只是换个读法，文件不动。
   */
  format?: (value: number, style: OverlayStyle, calibration: ElevationCalibration) => string
}

/**
 * **分类字段**（生物群系…）：值是一个分类 ID，没有数值语义。
 *
 * 渲染上它走**完全不同的那条路**（逐格纯色，没有渐变、没有等值线、没有数值文字）——
 * 见 `overlayPlan` 里的分类分支。这一点的意义不只是"少画点东西"：
 * 对一个分类 ID 做插值是**没有意义的**，所以这里根本不提供 `read`。
 */
export interface CategoryOverlayFieldSpec extends OverlayFieldSpecBase {
  numeric: false
  /** 从一格读出分类 ID；**没有值时返回 `undefined`**（"未填"与"填了一个认不出的 ID"是两件事） */
  readCategory: (cell: TerrainCell | undefined) => string | undefined
  /**
   * **值 → 颜色**的解析：`undefined` = 这一格没有填。
   *
   * 认不出的 ID（别的库写的）必须返回一个**可见的**回退色，而不是抛错或空白（§5.11）。
   * 自定义条目的颜色来自插件设置，所以绘制层会把现读的那份目录**覆盖**进来
   * （见 `OverlayPlanInput.categoryColors`）；缺省实现只认内置目录。
   */
  resolveColor: (id: string | undefined, style: OverlayStyle) => string
}

export type OverlayFieldSpec = NumericOverlayFieldSpec | CategoryOverlayFieldSpec

/** 这个字段是不是数值字段（**唯一**的收窄入口：需要 `read` 的地方都先过它） */
export function isNumericField(spec: OverlayFieldSpec): spec is NumericOverlayFieldSpec {
  return spec.numeric === true && typeof (spec as NumericOverlayFieldSpec).read === 'function'
}

/** 这个字段是不是分类字段（需要 `readCategory` 的地方都先过它） */
export function isCategoryField(spec: OverlayFieldSpec): spec is CategoryOverlayFieldSpec {
  return spec.numeric === false && typeof (spec as CategoryOverlayFieldSpec).readCategory === 'function'
}

/**
 * 只有"有限数"才算数据。
 *
 * `null` / 字符串 / NaN / Infinity 一律当作**没有这个值**：
 * 解析层已经把非法值原样收进 `extra` 并告警（§5.40），渲染层看到的就是"没有数据"。
 * 这里返回 `undefined` 而不是 0 或配色端点 —— 缺数据被画成"极低温"是彻底的说谎。
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

const TEMPERATURE_FIELD: NumericOverlayFieldSpec = {
  id: 'temperature',
  layerId: 'temperature',
  cellKey: 'temp',
  numeric: true,
  label: '温度',
  unit: '℃',
  read: (cell) => readFinite(cell?.temp),
  defaultStyle: () => ({
    opacity: 0.5,
    showValues: false,
    ramp: defaultTemperatureRamp(),
    mode: 'cell',
    contourInterval: null,
    contourLabelSpacing: DEFAULT_CONTOUR_LABEL_SPACING_FACTOR,
  }),
}

/**
 * 深度 / 海拔：与温度同源的第二个字段，**多一件事 —— 它有展示单位**。
 *
 * 文件里的值永远是米（0 = 海平面、正 = 向下），m / km / 相对值只是**读法**：
 * 米与千米不需要标定，相对值需要地图的 `elevation` 段（未标定时读数显示"未标定"，
 * 而不是拿一个编造的尺度凑数）。
 */
const DEPTH_FIELD: NumericOverlayFieldSpec = {
  id: 'depth',
  layerId: 'depth',
  cellKey: 'depth',
  numeric: true,
  label: '深度 / 海拔',
  unit: 'm',
  units: DEPTH_UNITS,
  read: (cell) => readFinite(cell?.depth),
  // 归一化保证 `style.unit` 一定是三个合法值之一，所以这里的兜底只是类型上的需要
  format: (value, style, calibration) => formatDepthReading(value, style.unit ?? 'm', calibration),
  defaultStyle: () => ({
    opacity: 0.5,
    showValues: false,
    ramp: defaultDepthRamp(),
    unit: 'm',
    mode: 'cell',
    contourInterval: null,
    contourLabelSpacing: DEFAULT_CONTOUR_LABEL_SPACING_FACTOR,
  }),
}

/**
 * **生物群系**：数值图层的第三个字段，也是**字段表的第一次真正扩展** —— 它是一个**分类字段**。
 *
 * 与温度 / 深度的差别不是"少一个单位"，而是**整个渲染路径不同**：
 * 分类值之间没有"高低"，所以既不插值、也不画等值线、也不写数值文字 ——
 * 每一格直接取分类目录里那条自己的颜色，**逐格纯色**（见 `overlayPlan` 的分类分支）。
 *
 * 配色三条（`BIOMES.md` §3 决定三）：颜色属于**目录条目**（每条自带），
 * `style.categoryColors` 只存用户**逐条改过**的那些；认不出的 ID 用中性灰（可见的"未知"）。
 *
 * `cellKey` 是 `biome`：它已经在 `mapDocument.ts` 的 `KNOWN_CELL_KEYS` 与写盘固定顺序里
 * （§D 数据那一行），所以这里的值和文件里的值**同一个键**，没有第二份映射。
 */
const BIOME_FIELD: CategoryOverlayFieldSpec = {
  id: 'biome',
  layerId: 'biome',
  cellKey: 'biome',
  numeric: false,
  label: '生物群系',
  unit: '',
  readCategory: (cell) => {
    const value = cell?.biome
    return typeof value === 'string' && value.length > 0 ? value : undefined
  },
  resolveColor: (id, style) => {
    // 认不出的 ID（别的库写的、或用户刚把定义删了）→ **中性灰**：
    // "未知"必须看得见（§5.11），而不是变成透明或空白。
    // ⚠️ `undefined`（这一格**没填**）根本走不到这里 —— 计划层会直接跳过它（与数值字段同一条口径：
    // "没有数据"不画，而不是画成某个颜色）。
    if (id === undefined) return BIOME_UNKNOWN_COLOR
    // 用户逐条改过的优先（`categoryColors` 只装改过的那些）
    const override = style.categoryColors?.[id]
    if (typeof override === 'string' && override.length > 0) return override
    return builtinBiomeColor(id)
  },
  defaultStyle: () => ({
    opacity: 0.5,
    showValues: false,
    // 分类字段不用配色；这一项只为让 `OverlayStyle` 的形状统一，界面上**不显示**它的控件
    // （设置页按 `isNumericField` 筛掉配色 / 越界色 / 单位 / 显示方式那几个控件）。
    ramp: defaultTemperatureRamp(),
    mode: 'cell',
    contourInterval: null,
    contourLabelSpacing: DEFAULT_CONTOUR_LABEL_SPACING_FACTOR,
    categoryColors: {},
  }),
}

/**
 * 字段登记表。**加一个字段 = 加一行**（外加 `LAYER_TABLE` 里对应的一行图层）。
 *
 * 温度是第一份模板：它的形状就是后面深度 / 生物群系要照抄的形状。
 * 深度是第二份 —— 多出来的只有 `units` 与 `format`（"值怎么读"）。
 * 生物群系是第三份，也是**形状上真正多出一条路的那一份**：它是分类字段，
 * 于是"数值字段"与"分类字段"在类型上就是两个接口（见 `isNumericField` / `isCategoryField`）。
 */
export const OVERLAY_FIELDS: readonly OverlayFieldSpec[] = [TEMPERATURE_FIELD, DEPTH_FIELD, BIOME_FIELD]

/** 只要数值字段（"每格默认值"、加减乘除笔刷、数值筛选规则都用它 —— **唯一**的筛法） */
export const NUMERIC_OVERLAY_FIELDS: readonly NumericOverlayFieldSpec[] = OVERLAY_FIELDS.filter(isNumericField)

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
  // 分类字段没有"读数"（它的值不是数）—— 这一支只可能是调用方搞错了；给一个空串而不是抛异常
  if (!isNumericField(spec)) return ''
  if (spec.format) return spec.format(value, style, calibration)
  return formatOverlayValue(value)
}

export type OverlayStyles = Record<FieldId, OverlayStyle>

/** 「每格默认值」弹窗里的一行（**从字段表派生**，见 `numericDefaultRows`） */
export interface NumericDefaultRow {
  /** 字段的 `cellKey`（写进 `dataDefaults` 的那个键） */
  key: string
  /** 行标题：显示名 + **权威单位**（`深度 / 海拔（m）`）——不做展示单位换算，见弹窗顶部注释 */
  title: string
  /** 这一行的说明 */
  desc: string
}

/**
 * 「每格默认值」弹窗要渲染的行：**只取数值字段**，按字段表顺序。
 *
 * 为什么放在这里（而不是写在弹窗里）：行是"字段表的投影"，而字段表的家是这里 ——
 * 于是加一个数值字段时弹窗自动多一行、一行都不用改（纪律 §4.7）。
 * 分类字段（`numeric: false`，例如 §D 的生物群系）**没有数值默认值**，会被这一句筛掉。
 */
export function numericDefaultRows(): NumericDefaultRow[] {
  const rows: NumericDefaultRow[] = []
  for (const spec of OVERLAY_FIELDS) {
    if (!spec.numeric) continue
    rows.push({
      key: spec.cellKey,
      title: `${spec.label}（${spec.unit}）`,
      desc: `没量过这个值的格用它上色；留空 = 这一层不兜底（0 是合法值，与"不设"不同）`,
    })
  }
  return rows
}

const FIELD_BY_ID = new Map<string, OverlayFieldSpec>(OVERLAY_FIELDS.map((spec) => [spec.id, spec]))

/** 按 ID 取字段描述。ID 来自同一张表的联合类型，取不到只可能是代码写错，所以直接抛 */
export function overlayField(id: FieldId): OverlayFieldSpec {
  const spec = FIELD_BY_ID.get(id)
  if (!spec) throw new Error(`未知的数值图层字段：${id}`)
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
      // 配色交给 colorRamp 自己的规范化：它知道"少于两条锚点就整体回退"这类规则
      ramp: normalizeRampSpec(record.ramp, fallback.ramp),
      // 显示方式：**只认登记表里那两个值**，其余（含老设置里的缺失）一律回退到出厂（逐格）
      mode: record.mode === 'field' || record.mode === 'cell' ? record.mode : fallback.mode,
      // 等值线间距：正的有限数才算；0 / 负数 / 非数字一律当"用配色锚点"（null），
      // 而不是悄悄取一个间隔 —— "0 间距"会让 levels 直接算成一个无限循环的意图
      contourInterval:
        typeof record.contourInterval === 'number' && Number.isFinite(record.contourInterval) && record.contourInterval > 0
          ? record.contourInterval
          : fallback.contourInterval,
      // 数字重复间隔：正的有限数才算（0 / 负数 / 非数字一律回出厂 6）——
      // 与等值线间距同一条口径：拒绝，而不是悄悄夹到某个"看起来合理"的值
      contourLabelSpacing:
        typeof record.contourLabelSpacing === 'number' &&
        Number.isFinite(record.contourLabelSpacing) &&
        record.contourLabelSpacing > 0
          ? record.contourLabelSpacing
          : fallback.contourLabelSpacing,
    }
    // 展示单位只对有 `units` 的字段生效；别的字段**不写这一项**（写了就是无意义的第二份状态）
    if (spec.units) {
      const unit = record.unit
      style.unit = spec.units.options.includes(unit as DepthDisplayUnit)
        ? (unit as DepthDisplayUnit)
        : spec.units.defaultUnit
    }
    // 逐条配色覆盖只对**分类字段**生效（数值字段写了就是第二份状态，直接不收）
    if (isCategoryField(spec)) {
      style.categoryColors = normalizeCategoryColors(record.categoryColors)
    }
    out[spec.id] = style
  }
  return out
}

/**
 * 逐条配色覆盖的规范化：只收"非空字符串键 + 颜色写法正确"的那些。
 *
 * 坏项**跳过**（而不是整体回退出厂）：用户手改 `data.json` 改坏了一条颜色，
 * 不该让**整层**的配色都回到出厂 —— 少一条覆盖的后果只是那一格用目录色。
 * 空对象**不留键**（与"清空默认值要删键"同一条口径：空表与"没有这一段"是同一件事）。
 */
function normalizeCategoryColors(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0) continue
    if (typeof value !== 'string') continue
    const color = value.trim()
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) continue
    out[key] = color
  }
  return out
}