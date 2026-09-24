/**
 * 路径样式的**旧字段兼容层** + 数值收敛的公共工具。
 *
 * ⚠️ 从 ⑤-1 起，"每种路径类型的参数"的唯一来源是 `pathTypeCatalog.ts` 里的目录
 * （内置 4 种 + 用户自定义，颜色/线宽/虚线/变细/平滑/端点/连接都在 `PathTypeEntry.params`）。
 * 本模块的职责**只剩两件**：
 * 1. 把旧一代的字段（只有颜色的 `stylePalette.pathColors`、以及 `pathStyleOverrides`）
 *    读一次并交给目录迁移，之后旧字段只读兼容、**不再是渲染依据**；
 * 2. 提供 `normalizePathWidth` / `normalizePathDash` 这两个被目录复用的收敛函数
 *    —— 它们的语义（尤其虚线的三态）已经付过代价，不重新发明。
 *
 * 因此：**不要**在渲染或设置界面里直接调用本模块的 `resolvePathStyleFull` /
 * `normalizePathStyleOverrides`；那只在迁移路径上出现（见 `pathTypeCatalog.migratedBuiltinParams`）。
 *
 * 三条原样保留的校验原则（都是"静默变形"的高发区）：
 * 1. **线宽夹取而不是接受任意值**：0.1 px 的线看不见、500 px 的线糊满屏幕；
 * 2. **虚线数组要整体校验**：长度必须是偶数（实-空成对）、全为有限非负数、且**不能全为 0**；
 * 3. **未知键丢弃、缺项补齐**：与设置里其它部分同一口径（`data.json` 可能被手工改坏）。
 */

import { PATH_TYPES, type BuiltinPathType } from '../data/mapDocument.ts'
import { PATH_STYLES, type PathStyle } from './shapeStyle.ts'
import { normalizeColor } from './stylePalette.ts'

/** 线宽下限/上限（世界单位）：与出厂值（4–8）同一个量级 */
export const PATH_WIDTH_MIN = 1
export const PATH_WIDTH_MAX = 40

/** 虚线：最多 8 段（再多就看不出节奏了），单段最长 64 世界单位 */
export const PATH_DASH_MAX_SEGMENTS = 8
const PATH_DASH_SEGMENT_MAX = 64

export interface PathStyleOverride {
  /** 线颜色（与 `stylePalette.pathColors` 是同一件事，迁移后只留目录里那一处） */
  color: string
  /** 线宽（世界单位） */
  width: number
  /** 虚线：空数组 = 实线；长度必须是偶数 */
  dash: number[]
  /** 河流末端变细 */
  taper: boolean
  /** 用平滑曲线而不是折线 */
  smooth: boolean
}

/**
 * 旧字段的形状：按**内置类型**索引的一张表。
 *
 * 键类型刻意是 `BuiltinPathType`（不是放宽后的 `PathType`）：这张表只描述出厂 4 种，
 * 自定义与未知类型从来不属于它。运行时仍可能被手工改坏（缺项），
 * 所以下面读它的地方一律带兜底。
 */
export type PathStyleOverrides = Record<BuiltinPathType, PathStyleOverride>

/** 出厂样式：直接取 `PATH_STYLES`，不在这里再抄一份数值 */
export function defaultPathStyleOverrides(): PathStyleOverrides {
  const out = {} as PathStyleOverrides
  for (const type of PATH_TYPES) {
    const base = PATH_STYLES[type]
    out[type] = {
      color: base.color,
      width: base.width,
      dash: base.dash ? [...base.dash] : [],
      taper: base.taper === true,
      smooth: base.smooth === true,
    }
  }
  return out
}

/** 把任意输入收敛成合法线宽；不合法回退到出厂值 */
export function normalizePathWidth(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  // 保留一位小数：足够表达"细一点/粗一点"，又不会产生 7.000000000000001 这种噪声
  return Math.min(PATH_WIDTH_MAX, Math.max(PATH_WIDTH_MIN, Math.round(numeric * 10) / 10))
}

/**
 * 收敛虚线数组。
 *
 * ⚠️ 三种返回值语义**必须分清**（第一版把它们混在一起，测试当场抓到）：
 * - `null` = "没有可用值"（缺失 / 类型不对 / 不合法）→ 调用方回退到**出厂虚线**；
 * - `[]` = 用户显式要**实线**；
 * - 非空偶数数组 = 用户要的虚线。
 *
 * 把"缺失"当成"实线"的后果很隐蔽：道路与边界出厂就是虚线，缺字段就会**静默变成实线**。
 */
export function normalizePathDash(value: unknown): number[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return null
  if (value.length === 0) return []
  if (value.length > PATH_DASH_MAX_SEGMENTS) return null
  if (value.length % 2 !== 0) return null
  const out: number[] = []
  for (const segment of value) {
    const numeric = typeof segment === 'number' ? segment : Number(segment)
    if (!Number.isFinite(numeric) || numeric < 0) return null
    out.push(Math.min(PATH_DASH_SEGMENT_MAX, Math.round(numeric * 10) / 10))
  }
  if (out.every((segment) => segment === 0)) return null
  return out
}

/** 虚线是否可读（用于设置页提示；纯判断，不改值） */
export function describePathDashProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return '虚线要写成数字数组，例如 [12, 8]'
  if (value.length === 0) return null
  if (value.length % 2 !== 0) return `虚线段数必须是偶数（实-空成对），现在是 ${value.length} 段`
  if (value.length > PATH_DASH_MAX_SEGMENTS) return `虚线段数最多 ${PATH_DASH_MAX_SEGMENTS} 段，现在是 ${value.length} 段`
  if (value.some((segment) => !Number.isFinite(Number(segment)) || Number(segment) < 0)) return '虚线每段都必须是非负数'
  if (value.every((segment) => Number(segment) === 0)) return '虚线不能全是 0（那会让线整条消失）'
  return null
}

function normalizeOne(type: BuiltinPathType, raw: unknown, fallback: PathStyleOverride): PathStyleOverride {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // 缺失 → 出厂虚线；显式 [] → 实线；其余不合法 → 出厂虚线（见 normalizePathDash 的说明）
  const dash = source.dash === undefined ? [...fallback.dash] : (normalizePathDash(source.dash) ?? [...fallback.dash])
  return {
    color: normalizeColor(source.color, fallback.color),
    width: normalizePathWidth(source.width, fallback.width),
    dash,
    taper: typeof source.taper === 'boolean' ? source.taper : fallback.taper,
    smooth: typeof source.smooth === 'boolean' ? source.smooth : fallback.smooth,
  }
}

/**
 * 收敛整张样式表。
 *
 * `legacyPathColors` 是旧字段（`stylePalette.pathColors`）：**只在没有完整样式表时**作为迁移输入读一次，
 * 已有 `pathStyles` 时以它为准 —— 否则会出现"改过的颜色被旧字段悄悄覆盖回去"。
 */
export function normalizePathStyleOverrides(
  raw: unknown,
  legacyPathColors?: Record<string, unknown> | undefined,
): PathStyleOverrides {
  const fallback = defaultPathStyleOverrides()
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as PathStyleOverrides
  for (const type of PATH_TYPES) {
    const base = fallback[type] ?? factoryOverrideOf(type)
    const migrated =
      source[type] === undefined && legacyPathColors !== undefined
        ? { ...base, color: normalizeColor(legacyPathColors[type], base.color) }
        : base
    out[type] = normalizeOne(type, source[type], migrated)
  }
  return out
}


/** 从旧的"只有颜色"设置迁移出一整张样式表（供 settings 归一化调用） */
export function fromLegacyPathColors(legacyPathColors: unknown): PathStyleOverrides {
  const source = legacyPathColors !== null && typeof legacyPathColors === 'object' ? (legacyPathColors as Record<string, unknown>) : {}
  return normalizePathStyleOverrides(undefined, source)
}

/**
 * 解析成绘制层用的 `PathStyle`（出厂结构 + 旧字段覆盖）。
 *
 * ⚠️ **只用于旧字段迁移**（`pathTypeCatalog.migratedBuiltinParams`）：它只认内置 4 种
 * （基准样式取自 `PATH_STYLES`）。渲染与设置界面一律走
 * `pathTypeCatalog.resolvedPathStyle()` —— 那里才认识自定义与未知类型。
 */
export function resolvePathStyleFull(type: BuiltinPathType, overrides: PathStyleOverrides): PathStyle {
  const base = PATH_STYLES[type]
  // 取不到覆盖（表是空的 / 被手工改坏）时用出厂值：**绝不**让"没有覆盖"变成"没有样式"
  const override = overrides?.[type] ?? defaultPathStyleOverrides()[type] ?? factoryOverrideOf(type)
  const style: PathStyle = {
    type: base.type,
    label: base.label,
    color: normalizeColor(override.color, base.color),
    width: normalizePathWidth(override.width, base.width),
  }
  if (override.dash.length > 0) style.dash = [...override.dash]
  if (override.taper) style.taper = true
  if (override.smooth) style.smooth = true
  return style
}

/** 出厂样式 → 一份覆盖表（只在表查询落空时兜底，见 `resolvePathStyleFull` / `normalizePathStyleOverrides`） */
function factoryOverrideOf(type: BuiltinPathType): PathStyleOverride {
  const base = PATH_STYLES[type]
  return {
    color: base.color,
    width: base.width,
    dash: base.dash ? [...base.dash] : [],
    taper: base.taper === true,
    smooth: base.smooth === true,
  }
}

/** 是否全部等于出厂样式（设置页据此显示"已改动/恢复默认"） */
export function isDefaultPathStyleOverrides(overrides: PathStyleOverrides): boolean {
  const fallback = defaultPathStyleOverrides()
  return PATH_TYPES.every((type) => {
    const a = overrides[type]
    const b = fallback[type]
    if (a === undefined || b === undefined) return a === b
    return (
      a.color === b.color &&
      a.width === b.width &&
      a.dash.join(',') === b.dash.join(',') &&
      a.taper === b.taper &&
      a.smooth === b.smooth
    )
  })
}

/** 虚线的可读描述（设置页显示"实线/虚线 12-8"之类） */
export function describePathDash(dash: readonly number[]): string {
  return dash.length === 0 ? '实线' : `虚线 ${dash.join('-')}`
}
