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
 * 2. **越界不是错误，而且不止一档**：超出色带两端的是合法数据（-60 ℃ 就是一个温度），
 *    刚出界用 `under` / `over` 的端色画，走得越远越接近"极色"
 *    （需求原话："远远低于最低限度：从蓝色渐变到白底黑字，低于最低限度蓝底白字"）。
 *    文字色在近端 / 远端两个候选之间按对比度挑，行程 = **一个色带跨度**。
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

/**
 * 越界区间（`under` / `over`）的画法：端色 + 文字色，外加"再往外会渐变成什么"。
 *
 * 为什么不是"整段一个纯色"：需求原话是"**远远**低于最低限度：从蓝色渐变到白底黑字，
 * 低于最低限度蓝底白字"—— 越界这一段自己还分远近：刚出界是端色，越远越像极色。
 * 行程定死为**一个色带跨度**：`min - span` 处到达 `farColor`，再远就是纯 `farColor`。
 * 远端的文字色 `farTextColor` 与近端 `textColor` 之间**按对比度**挑一个，
 * 于是"蓝底白字 → 白底黑字"的过渡里不会出现白字压白底的那一段。
 *
 * `farColor` 等于 `color` 时就是纯色（不渐变）：深度那种"两端本身就是极色"的字段用它。
 */
export interface RangeStyle {
  color: string
  textColor: string
  /** 远远低于 / 高于色带两端时渐变成的颜色 */
  farColor: string
  /** `farColor` 上的文字色（与 `textColor` 按对比度二选一） */
  farTextColor: string
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
/** 低于下端：纯蓝底白字（需求原话）。**回退值不渐变**（far = 本色） */
export const DEFAULT_UNDER: RangeStyle = {
  color: '#0000ff',
  textColor: '#ffffff',
  farColor: '#0000ff',
  farTextColor: '#ffffff',
}
/** 高于上端：纯红底白字（需求原话）。回退值不渐变 */
export const DEFAULT_OVER: RangeStyle = {
  color: '#ff0000',
  textColor: '#ffffff',
  farColor: '#ff0000',
  farTextColor: '#ffffff',
}
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
    // 越界不是"另一个纯色"而是**渐变**（需求原话）：刚过下端仍是蓝底白字，
    // 再往低走一个色带跨度（75 ℃）之外就渐成白底黑字 —— 越冷越白，方向一眼可辨。
    under: { color: '#0000ff', textColor: '#ffffff', farColor: '#ffffff', farTextColor: DARK_TEXT },
    // 高温端镜像：刚过上限红底白字，远远更热渐成黑底白字。
    over: { color: '#ff0000', textColor: '#ffffff', farColor: '#000000', farTextColor: '#ffffff' },
    interpolate: DEFAULT_INTERPOLATE,
  }
}

/**
 * 深度 / 海拔色带的出厂值：**低 → 高 = 黑 → 白**（用户 2026-09-29 定的口径）。
 *
 * 数值轴与 `depth` 同口径（0 = 海平面，正 = 向下），所以锚点仍是**升序的值**：
 * `-4000`（高海拔）在左、`4000`（深海）在右，颜色从黑走到白。
 * 越界两端就是这条轴自己的两个极色，所以**不再另做渐变**（far = 本色）：
 * 比最高峰更高的一侧纯黑、比最深海沟更深的一侧纯白。
 */
export function defaultDepthRamp(): RampSpec {
  return {
    stops: [
      { value: -4000, color: '#000000' },
      { value: 0, color: '#808080' },
      { value: 4000, color: '#ffffff' },
    ],
    under: { color: '#000000', textColor: '#ffffff', farColor: '#000000', farTextColor: '#ffffff' },
    over: { color: '#ffffff', textColor: DARK_TEXT, farColor: '#ffffff', farTextColor: DARK_TEXT },
    interpolate: DEFAULT_INTERPOLATE,
  }
}

/* ------------------------------------------------------------------ 轴上的位置 */

/** 色带的读数范围（`stops` 已升序、至少两条；`span` 恒 > 0） */
export interface RampBounds {
  min: number
  max: number
  span: number
}

/** 取两端的值与跨度 —— 轴上的所有位置换算都从它出发（图例与轴共用同一套公式） */
export function rampBounds(stops: readonly ColorStop[]): RampBounds {
  const first = stops[0]
  const last = stops[stops.length - 1]
  const min = first ? first.value : 0
  const max = last ? last.value : 0
  return { min, max, span: max - min }
}

/**
 * 值 → 轴上位置（0 = 最低端，1 = 最高端）。
 *
 * **不夹取**：越界的位置由调用方决定怎么画（轴上要画成两端的"端帽"，
 * 而"锚点间距 = 渐变率"这条只有在位置真的按值算时才对）。
 */
export function positionForValue(value: number, bounds: RampBounds): number {
  return bounds.span === 0 ? 0 : (value - bounds.min) / bounds.span
}

/** 轴上位置 → 值（`positionForValue` 的逆；点轴上任意一处新建锚点时用它） */
export function valueForPosition(position: number, bounds: RampBounds): number {
  return bounds.min + position * bounds.span
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

/**
 * 与 `textColorOf(color)` **相反**的那个对比色（白 ↔ 近黑）。
 *
 * 用途是"**描边必须与字色相反**"这条口径（等值线数字压在彩色场上，
 * 白字配白边等于没描边 —— 用户实测报过"一坨黑"）。收在这里而不是在渲染层各写一次：
 * 白 / 近黑这一对只在 `textColorOf` 里定义，谁都不该自己拼第二个色值。
 */
export function oppositeTextColor(color: string): string {
  return textColorOf(color) === LIGHT_TEXT ? DARK_TEXT : LIGHT_TEXT
}

/* ------------------------------------------------------------------ 规范化 */

function normalizeRangeStyle(raw: unknown, fallback: RangeStyle): RangeStyle {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const read = (key: 'color' | 'textColor' | 'farColor' | 'farTextColor'): string => {
    const hex = parseHexColor(source[key])
    return hex === null ? fallback[key] : rgbToHex(hex)
  }
  // 越界区的文字色**默认就跟着 fallback（出厂是白字）**，不按对比度自动挑：
  // 需求原话是"超过两端的值用纯蓝底白字 / 纯红底白字"，而纯红底按对比度算出来会选深色 ——
  // 这里以用户明确说过的行为为准。用户当然可以自己指定别的文字色。
  // 远端同理：老设置里**没有** farColor / farTextColor 这两个键，缺失时回退成"不渐变"。
  return {
    color: read('color'),
    textColor: read('textColor'),
    farColor: read('farColor'),
    farTextColor: read('farTextColor'),
  }
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

  // 越界不是"贴一个纯色"：端色 → 极色按"越出去多远"渐变（见 outOfRangeValue）
  if (value < first.value) return outOfRangeValue(ramp, 'under', first.value - value)
  if (value > last.value) return outOfRangeValue(ramp, 'over', value - last.value)
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
 * 越界值 → 颜色：端色 → 极色按"越出去多远"渐变（行程 = 一个色带跨度，再远就饱和）。
 *
 * 两端**原样返回、不经过插值**：Oklab 往返会把 `#0000ff` 变成 `#0001ff` 之类的近邻色，
 * 而"刚越界就是端色"这句话必须逐字为真（端帽与格子的颜色都要对得上）。
 * 中间那一段的文字色在近端 / 远端两个候选之间**按对比度**挑。
 */
function outOfRangeValue(ramp: RampSpec, side: 'under' | 'over', distance: number): ValueColor {
  const style = side === 'under' ? ramp.under : ramp.over
  // 远端极色和端色一样 ⇒ 这一侧根本不该渐变：直接给端色，
  // 既保住"纯红底白字"这条明确要求，也避免 Oklab 往返把 #0000ff 变成 #0001ff
  if (style.farColor === style.color) return { color: style.color, textColor: style.textColor, outOfRange: side }
  const bounds = rampBounds(ramp.stops)
  const t = bounds.span <= 0 ? 1 : Math.min(1, Math.max(0, distance / bounds.span))
  if (t <= 0) return { color: style.color, textColor: style.textColor, outOfRange: side }
  if (t >= 1) return { color: style.farColor, textColor: style.farTextColor, outOfRange: side }
  const from = parseHexColor(style.color) ?? [0, 0, 0]
  const to = parseHexColor(style.farColor) ?? from
  const color = rgbToHex(mixColors(from, to, t, ramp.interpolate))
  return { color, textColor: pickReadableTextColor(color, style.textColor, style.farTextColor), outOfRange: side }
}

/**
 * 在两种文字色里挑与底色对比度更高的那一个。
 *
 * 为什么不直接用 `textColorOf`：越界区的字色是"用户指定的近端 / 远端两个候选"，
 * 自动挑会违背"纯红底白字"那条明确要求；但过渡段的底色既不是红也不是黑，
 * 死守任一侧都会出现读不清的一段 —— 所以**只在两个候选之间**挑。
 * 两个候选都不是合法 hex 时给深色。
 */
function pickReadableTextColor(background: string, a: string, b: string): string {
  const bg = parseHexColor(background)
  if (bg === null) return DARK_TEXT
  const luminance = relativeLuminance(bg)
  const contrastOf = (candidate: string): number => {
    const rgb = parseHexColor(candidate)
    if (rgb === null) return -1
    const other = relativeLuminance(rgb)
    const lighter = Math.max(luminance, other)
    const darker = Math.min(luminance, other)
    return (lighter + 0.05) / (darker + 0.05)
  }
  const contrastA = contrastOf(a)
  const contrastB = contrastOf(b)
  if (contrastA < 0 && contrastB < 0) return DARK_TEXT
  return contrastB > contrastA ? b : a
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