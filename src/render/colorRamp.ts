/**
 * 色带：把"一格一个数值"变成颜色 —— **纯函数模块，不 import obsidian**。
 *
 * 服务的功能是温度 / 深度这类的覆盖层（见 `.trae/documents/温度带与深度分层-设计草案.md` §4.2）。
 * 现在先把地基做好：它不碰 DOM、不碰设置，所以能直接单测；接上界面是后面的事。
 *
 * 三条设计约定，都是被需求逼出来的：
 *
 * 1. **插值空间可选，默认 Oklab**。用户明确要求 Lab / Oklab：RGB 直接线性插值在
 *    蓝 → 绿 → 红这种长弧上会经过发灰的中间色，而 Oklab 是感知均匀空间。
 *    要再加 'hsl' 之类，只需在 `mixColors` 里多一个分支（转换 + 色相走短弧）。
 * 2. **越界不是错误**：超出色带两端的是合法数据（-60 ℃ 就是一个温度），
 *    用 `under` / `over` 里用户指定的纯色画出来，并按对比度给出可读的文字颜色
 *    —— 需求原话是"纯蓝底白字 / 纯红底白字"。
 * 3. **"填上下限"和"5 个体感分类"是同一份数据**：两者都只是 stops 数量不同
 *    （2 个 vs 5 个锚点），渐变率就是相邻锚点的斜率，不需要两套实现。
 */

import { canonicalColor, isSafeColor } from './stylePalette.ts'

export interface ColorStop {
  /** 数值轴上的位置（`normalizeRampSpec` 会按升序排好） */
  value: number
  /** 锚点颜色，必须是 hex（也接受 4/8 位写法，但 alpha 会被忽略 —— 透明度由图层统一控制） */
  color: string
}

/** 越界区间（`under` / `over`）的画法：底色 + 文字色 */
export interface RangeStyle {
  color: string
  textColor: string
}

/** 插值空间。要加新空间就在 `mixColors` 里加一个分支 */
export type InterpolationSpace = 'oklab' | 'rgb'

export interface RampSpec {
  /** 按 `value` 升序、至少 `RAMP_MIN_STOPS` 个 */
  stops: ColorStop[]
  under: RangeStyle
  over: RangeStyle
  interpolate: InterpolationSpace
}

/** 少于两条锚点就没有"渐变"可言 */
export const RAMP_MIN_STOPS = 2
/** 上限只是防呆（防止一个坏设置让渲染每帧循环很久），不是产品限制 */
export const RAMP_MAX_STOPS = 32

export const DEFAULT_INTERPOLATE: InterpolationSpace = 'oklab'
/** 低于下端：纯蓝底白字（需求原话） */
export const DEFAULT_UNDER: RangeStyle = { color: '#0000ff', textColor: '#ffffff' }
/** 高于上端：纯红底白字（需求原话） */
export const DEFAULT_OVER: RangeStyle = { color: '#ff0000', textColor: '#ffffff' }
/** 深色文字：与 `shapeDraw.ts` 里的描边同色系，避免纯黑在深色主题下发死 */
const DARK_TEXT = '#111827'
const LIGHT_TEXT = '#ffffff'

/**
 * 温度色带的出厂值：蓝（寒）→ 蓝绿 → 绿（温和）→ 橙 → 红（热）。
 *
 * 这五个锚点就是需求里"标定 5 个体感温度分类"那份数据 —— 用户可以把它们改名成
 * 极寒 / 寒冷 / 温和 / 炎热 / 酷热，数值与渐变率都是现成的。
 */
export function defaultTemperatureRamp(): RampSpec {
  return {
    stops: [
      { value: -30, color: '#0000ff' },
      { value: 0, color: '#00c8c8' },
      { value: 15, color: '#22c55e' },
      { value: 30, color: '#f59e0b' },
      { value: 45, color: '#ff0000' },
    ],
    under: { ...DEFAULT_UNDER },
    over: { ...DEFAULT_OVER },
    interpolate: DEFAULT_INTERPOLATE,
  }
}

/**
 * 深度 / 海拔色带的出厂值：**高处浅米 → 海平面浅蓝 → 深海深蓝**。
 *
 * 数值轴与 `depth` 同口径（0 = 海平面，正 = 向下），所以锚点是**降序的语义、升序的值**：
 * `-4000`（高海拔）在左、`4000`（深海）在右。
 *
 * 越界两端刻意**不用**温度那套纯蓝/纯红：那是温度的体感语言（冷 / 热）。
 * 这里的越界是"比最高峰还高"与"比最深海沟还深"，所以用纯白 / 近黑蓝 —— 方向一眼可辨。
 */
export function defaultDepthRamp(): RampSpec {
  return {
    stops: [
      { value: -4000, color: '#f2ead9' },
      { value: 0, color: '#7dd3fc' },
      { value: 4000, color: '#1e3a8a' },
    ],
    under: { color: '#ffffff', textColor: '#111827' },
    over: { color: '#0b1f4b', textColor: '#ffffff' },
    interpolate: DEFAULT_INTERPOLATE,
  }
}

/* ------------------------------------------------------------------ 颜色解析 */

/**
 * 解析 hex 颜色 → `[r, g, b]`（每个 0–255 的整数）。
 *
 * 只认 hex：色带是**算**出来的，接受 `rgb()` / `hsl()` / 颜色名只会让解析多一条分支
 * 而用户并不会因此得到什么（设置页的颜色选择器本来就给 hex）。
 * 4 位 / 8 位写法里的 alpha **被忽略**：透明度归图层管，不归单条色带管。
 */
export function parseHexColor(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!/^#[0-9a-f]{3,8}$/.test(text)) return null
  const body = text.slice(1)
  if (body.length !== 3 && body.length !== 4 && body.length !== 6 && body.length !== 8) return null
  if (!/^[0-9a-f]+$/.test(body)) return null
  const expanded =
    body.length <= 4
      ? body
          .slice(0, 3)
          .split('')
          .map((char) => char + char)
          .join('')
      : body.slice(0, 6)
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ]
}

/** `[r, g, b]` → `#rrggbb`（小写；取整并夹在 0–255，避免浮点尾巴） */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  const byte = (channel: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(channel)))
    return clamped.toString(16).padStart(2, '0')
  }
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`
}

/* ------------------------------------------------------------------ Oklab */

function toLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function toSrgbByte(linear: number): number {
  const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(value * 255)))
}

/** sRGB（0–255）→ Oklab。系数取自 Oklab 论文的参考实现 */
export function srgbToOklab(rgb: readonly [number, number, number]): [number, number, number] {
  const r = toLinear(rgb[0])
  const g = toLinear(rgb[1])
  const b = toLinear(rgb[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** Oklab → sRGB（0–255，已夹到合法区间：空间外推会得到超范围值） */
export function oklabToSrgb(lab: readonly [number, number, number]): [number, number, number] {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3
  return [
    toSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function mixChannel(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 两个颜色按比例混色（t = 0 → a，t = 1 → b）。`t` 由调用方夹到 0–1 */
export function mixColors(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
  space: InterpolationSpace,
): [number, number, number] {
  if (space === 'oklab') {
    const labA = srgbToOklab(from)
    const labB = srgbToOklab(to)
    return oklabToSrgb([
      mixChannel(labA[0], labB[0], t),
      mixChannel(labA[1], labB[1], t),
      mixChannel(labA[2], labB[2], t),
    ])
  }
  return [
    mixChannel(from[0], to[0], t),
    mixChannel(from[1], to[1], t),
    mixChannel(from[2], to[2], t),
  ]
}

/* ------------------------------------------------------------------ 文字色 */

/** WCAG 相对亮度（先线性化再加权 —— 直接用 0–255 加权是常见错误） */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2])
}

/**
 * 在这个底色上放哪种文字色更清楚（白 or 深色）。
 *
 * 用 WCAG 的对比度公式选更优的一边，而不是"亮度大于 0.5 就用黑"：
 * 那个阈值对中高亮度色（黄、青）会选错，白字糊在浅黄底上。
 */
export function textColorOf(color: string): string {
  const rgb = parseHexColor(color)
  if (rgb === null) return DARK_TEXT
  const luminance = relativeLuminance(rgb)
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  const contrastWithDark = (luminance + 0.05) / (relativeLuminance([17, 24, 39]) + 0.05)
  return contrastWithWhite >= contrastWithDark ? LIGHT_TEXT : DARK_TEXT
}

/* ------------------------------------------------------------------ 规范化 */

function normalizeRangeStyle(raw: unknown, fallback: RangeStyle): RangeStyle {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const hex = parseHexColor(source.color)
  const color = hex === null ? fallback.color : rgbToHex(hex)
  const textHex = parseHexColor(source.textColor)
  // 越界区的文字色**默认就跟着 fallback（出厂是白字）**，不按对比度自动挑：
  // 需求原话是"超过两端的值用纯蓝底白字 / 纯红底白字"，而纯红底按对比度算出来会选深色 ——
  // 这里以用户明确说过的行为为准。用户当然可以自己指定别的文字色。
  return { color, textColor: textHex === null ? fallback.textColor : rgbToHex(textHex) }
}

/**
 * 把任意输入收敛成可用的色带。
 *
 * 规则都写在这里，避免"设置里改坏了却渲染不出来"：
 * - 锚点按 `value` **升序**排（用户填的顺序不参与语义）；
 * - **数值重复只留第一条**（按输入顺序），否则同一处会有两个颜色、谁赢说不清；
 * - 颜色不是 hex 的锚点**丢掉**；剩下的少于 2 条就整体回退到 `fallback`；
 * - 非有限值（NaN / Infinity）的锚点丢掉；
 * - `under` / `over` 的颜色不是 hex 就用出厂值，文字色缺失就按对比度算。
 */
export function normalizeRampSpec(raw: unknown, fallback: RampSpec = defaultTemperatureRamp()): RampSpec {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const list = Array.isArray(source.stops) ? source.stops : []
  const parsed: ColorStop[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const value = entry.value
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const hex = parseHexColor(entry.color)
    if (hex === null) continue
    parsed.push({ value, color: rgbToHex(hex) })
  }
  // 稳定排序：数值相同时保持输入顺序，于是"留第一条"是可预期且可断言的
  parsed.sort((a, b) => a.value - b.value)
  const stops: ColorStop[] = []
  for (const stop of parsed) {
    if (stops.length > 0 && stops[stops.length - 1]!.value === stop.value) continue
    stops.push(stop)
    if (stops.length >= RAMP_MAX_STOPS) break
  }
  if (stops.length < RAMP_MIN_STOPS) return fallback

  const space = source.interpolate === 'rgb' || source.interpolate === 'oklab' ? source.interpolate : fallback.interpolate
  return {
    stops,
    // 越界两端的回退是**这一条色带自己的出厂值**（不是温度那对纯蓝/纯红）：
    // 深度色带坏掉时应当回到深度的白 / 近黑蓝，而不是变成"极低温"的观感
    under: normalizeRangeStyle(source.under, fallback.under),
    over: normalizeRangeStyle(source.over, fallback.over),
    interpolate: space,
  }
}

/* ------------------------------------------------------------------ 主入口 */

export interface ValueColor {
  color: string
  /** 该底色上可读的文字色（画数值用） */
  textColor: string
  /** 落在色带之外时是哪一端；在带内是 `null` */
  outOfRange: 'under' | 'over' | null
}

/**
 * 数值 → 颜色。
 *
 * 返回 `null` 表示**这不是一个可画的值**（NaN / Infinity）：调用方应当把它当成
 * "这一格没有数据"跳过，而不是拿 `under` 冒充 —— 那会让缺数据看起来像"极低温"。
 */
export function colorForValue(value: number, ramp: RampSpec): ValueColor | null {
  if (!Number.isFinite(value)) return null
  const stops = ramp.stops
  if (stops.length < RAMP_MIN_STOPS) return null
  const first = stops[0]!
  const last = stops[stops.length - 1]!

  if (value < first.value) return { ...ramp.under, outOfRange: 'under' }
  if (value > last.value) return { ...ramp.over, outOfRange: 'over' }
  if (value === first.value) return { color: first.color, textColor: textColorOf(first.color), outOfRange: null }
  if (value === last.value) return { color: last.color, textColor: textColorOf(last.color), outOfRange: null }

  for (let index = 1; index < stops.length; index += 1) {
    const upper = stops[index]!
    if (value > upper.value) continue
    const lower = stops[index - 1]!
    const span = upper.value - lower.value
    // span 为 0 的情况在规范化里已经被去重掉了；这里再挡一次，避免除零
    const t = span === 0 ? 0 : (value - lower.value) / span
    const from = parseHexColor(lower.color)!
    const to = parseHexColor(upper.color)!
    const color = rgbToHex(mixColors(from, to, t, ramp.interpolate))
    return { color, textColor: textColorOf(color), outOfRange: null }
  }

  // 理论上到不了这里（上面的区间已经覆盖了 first..last）
  return { color: last.color, textColor: textColorOf(last.color), outOfRange: null }
}

/**
 * 色带是否"看起来可用"：给设置页做一行提示用。
 *
 * 注意它**不**检查锚点顺序（那由 `normalizeRampSpec` 负责修好），只看颜色本身是否安全。
 */
export function describeRampProblem(ramp: RampSpec): string | null {
  for (const stop of ramp.stops) {
    if (!isSafeColor(canonicalColor(stop.color))) return `锚点 ${stop.value} 的颜色不是合法颜色`
  }
  if (!isSafeColor(ramp.under.color) || !isSafeColor(ramp.over.color)) return '越界颜色不是合法颜色'
  return null
}