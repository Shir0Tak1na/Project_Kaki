/**
 * 样式调色板：把「用户设置里的颜色与字体」解析成绘制层能直接用的样式。
 *
 * 为什么单独一个模块：
 * 1. **纯函数** —— 颜色合法性、字体串清洗都能在没有 Obsidian 的情况下单测，
 *    而这两个恰好都是"写错了不会报错、只会静默变形"的地方：
 *    - 非法颜色字符串到了 canvas 上是**静默忽略**（该次 fill 沿用上一个颜色）；
 *    - `ctx.font` 里只要出现 `var()` 或斜杠等简写语法，整条声明**静默失效**、字号退回 10px。
 *    所以这里一律"先校验、不合法就回退到默认值"，绝不把用户输入原样透传。
 * 2. **默认值的唯一来源** —— `PATH_STYLES` / `REGION_PRESETS` 是出厂默认，
 *    用户设置只覆盖颜色，宽度/虚线/平滑这些结构性的东西不受影响。
 *
 * 注意语义边界：设置里的颜色只决定**新画的对象**用什么颜色；
 * 已经画好的对象把颜色存在地图文件里（`path.color` / `region.color`），
 * 渲染时直接用它 —— 换句话说，改设置**不会**悄悄改掉你已有的地图。
 */

import type { PathType } from '../data/mapDocument.ts'
import { PATH_TYPES } from '../data/mapDocument.ts'
import { PATH_STYLES, REGION_PRESETS, type PathStyle, type RegionPreset } from './shapeStyle.ts'

/** 每种路径类型的颜色 */
export type PathColorMap = Record<PathType, string>

/** 出厂默认：路径颜色直接取 `PATH_STYLES` 里的颜色，保证两处永远一致 */
export function defaultPathColors(): PathColorMap {
  const out = {} as PathColorMap
  for (const type of PATH_TYPES) out[type] = PATH_STYLES[type].color
  return out
}

/** 出厂默认：区域预设色（顺序与 `REGION_PRESETS` 一致） */
export function defaultRegionColors(): string[] {
  return REGION_PRESETS.map((preset) => preset.color)
}

/* ------------------------------------------------------------------ 颜色 */

/** CSS 具名颜色只认这一小撮常见值：其余一律要求写成 #rgb(a) / #rrggbb(aa) / rgb() / hsl() */
const NAMED_COLORS = new Set([
  'transparent',
  'currentcolor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'gray',
  'grey',
  'brown',
  'pink',
  'cyan',
  'magenta',
  'teal',
  'navy',
  'olive',
  'maroon',
  'silver',
  'gold',
])

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[-.\d%]+(?:\s*[, ]\s*[-.\d%]+)*\s*\)$/i

/**
 * 是否是可安全交给 canvas 的颜色字符串。
 *
 * 刻意**不接受** `url(...)`、`var(...)`、带分号的拼接等：它们要么无效（静默忽略），
 * 要么意味着调用方在拼接样式串 —— 那种地方一旦有了用户输入就该拒绝。
 */
export function isSafeColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0 || text.length > 64) return false
  if (/[;{}]/.test(text)) return false
  if (/var\(|url\(|expression\(/i.test(text)) return false
  if (HEX_COLOR.test(text)) return true
  if (FUNCTIONAL_COLOR.test(text)) return true
  return NAMED_COLORS.has(text.toLowerCase())
}

/** 收敛成合法颜色；不合法就用回退值（**绝不**把非法串透传给 canvas） */
export function normalizeColor(value: unknown, fallback: string): string {
  return isSafeColor(value) ? value.trim() : fallback
}

/** 十六进制颜色统一成小写，便于比较与写盘稳定 */
export function canonicalColor(value: string): string {
  const text = value.trim()
  return HEX_COLOR.test(text) ? text.toLowerCase() : text
}

/* ------------------------------------------------------------------ 字体 */

const FONT_FAMILY_ALLOWED = /^[\w\s,'"\-\u4e00-\u9fff\u3040-\u30ff]+$/u

/**
 * 清洗字体族。
 *
 * 返回 `''` 表示"跟随主题"（由调用方去读 `getComputedStyle().fontFamily`）。
 * 出现 `var(`、斜杠、分号、括号、换行等会破坏 CSS font 简写的内容时一律返回 `''` ——
 * 因为 `ctx.font = ...` 对这种串是**静默忽略**，画布会留着上一个字体，
 * 表现是"字号怎么调都不变"（这个坑本项目已经付过一次代价）。
 */
export function normalizeFontFamily(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim().replace(/\s+/g, ' ')
  if (text.length === 0 || text.length > 200) return ''
  if (/var\(|url\(|\)|\(|;|\/|\\|!|\{|\}|@/i.test(text)) return ''
  // 带尺寸单位的写法说明用户粘进来的是一整条 CSS font 简写（"600 24px sans-serif"）：
  // 直接当字体族用会拼出 `600 24px 600 24px ...` —— 又一次静默失效。字体名里的数字（"Source Sans 3"）仍允许。
  if (/\d+(?:\.\d+)?(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%)/i.test(text)) return ''
  if (!FONT_FAMILY_ALLOWED.test(text)) return ''
  return text
}

/* ------------------------------------------------- 解析成绘制层用的样式 */

/** 路径样式 = 出厂结构 + 用户颜色（宽度/虚线/平滑等不开放给设置） */
export function resolvePathStyle(type: PathType, colors: PathColorMap): PathStyle {
  const base = PATH_STYLES[type]
  const color = normalizeColor(colors?.[type], base.color)
  return color === base.color ? base : { ...base, color }
}

/** 区域预设 = 出厂标签 + 用户颜色 */
export function resolveRegionPresets(colors: readonly string[]): RegionPreset[] {
  return REGION_PRESETS.map((preset, index) => {
    const color = normalizeColor(colors?.[index], preset.color)
    return color === preset.color ? preset : { ...preset, color }
  })
}

/** 新建区域时的默认颜色（第一个预设） */
export function resolveDefaultRegionColor(colors: readonly string[]): string {
  return resolveRegionPresets(colors)[0]?.color ?? REGION_PRESETS[0]!.color
}

/** 把任意输入收敛成完整的路径颜色表（缺项用出厂默认补齐） */
export function normalizePathColors(raw: unknown): PathColorMap {
  const fallback = defaultPathColors()
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as PathColorMap
  for (const type of PATH_TYPES) out[type] = normalizeColor(source[type], fallback[type])
  return out
}

/** 把任意输入收敛成区域颜色数组（长度固定，与预设一一对应） */
export function normalizeRegionColors(raw: unknown): string[] {
  const fallback = defaultRegionColors()
  const source = Array.isArray(raw) ? raw : []
  return fallback.map((color, index) => normalizeColor(source[index], color))
}

/** 判断颜色表是否已经等于出厂默认（设置页据此显示"已改动"） */
export function isDefaultPathColors(colors: PathColorMap): boolean {
  const fallback = defaultPathColors()
  return PATH_TYPES.every((type) => canonicalColor(colors[type]) === canonicalColor(fallback[type]))
}

export function isDefaultRegionColors(colors: readonly string[]): boolean {
  const fallback = defaultRegionColors()
  return fallback.every((color, index) => canonicalColor(colors[index] ?? '') === canonicalColor(color))
}

/* --------------------------------------------------------------- 调色板 */

/**
 * 绘制层与工具栏真正消费的东西：三种设置合成一份。
 *
 * 它同时是"设置 → 渲染"这条链路上唯一的形状，`main.ts` 只提供它、
 * 其它模块只读它，避免每个模块各自去拼设置字段。
 */
export interface StylePalette {
  pathColors: PathColorMap
  /** 区域预设色，长度与 `REGION_PRESETS` 一致 */
  regionColors: string[]
  /** 名称字体族；`''` 表示跟随主题（由绘制层读 getComputedStyle） */
  fontFamily: string
}

export function defaultStylePalette(): StylePalette {
  return { pathColors: defaultPathColors(), regionColors: defaultRegionColors(), fontFamily: '' }
}

/** 把任意输入（可能来自被手工改坏的 data.json）收敛成一份可用调色板 */
export function normalizeStylePalette(raw: unknown): StylePalette {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    pathColors: normalizePathColors(source.pathColors),
    regionColors: normalizeRegionColors(source.regionColors),
    fontFamily: normalizeFontFamily(source.fontFamily),
  }
}
