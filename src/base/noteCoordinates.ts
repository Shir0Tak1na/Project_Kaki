/**
 * 笔记属性 → 地图标记的映射（**纯函数**，不依赖 Obsidian）。
 *
 * Base 视图的一侧数据来源是"查询结果里的每个笔记"：笔记在前置元数据里写了自己在地图上的位置，
 * 视图就把它们当作标记画出来。约定（见技术方案 §7.2）：
 *
 * ```yaml
 * ---
 * coordinates: [320, -140]   # 世界坐标；也接受 {x, y} 或 "320,-140"
 * map-type: city             # 决定图标；缺省用 town
 * region: 北境王国            # 可选；用于分组/着色
 * ---
 * ```
 *
 * 三种写法都接受，是因为手写 YAML 的习惯差异很大（列表最自然，但"320,-140"更省事，
 * 而对象写法在模板里常见）。宁可多认几种，也不要让用户因为写法不对而"标记不显示"。
 */

import type { Point } from '../core/hex.ts'
import { MARKER_ICONS, type MarkerId } from '../data/mapDocument.ts'
import { CUSTOM_MARKER_PREFIX } from '../render/markerCatalog.ts'

export interface NoteMapProps {
  /** 世界坐标；解析失败或未提供时为 null */
  point: Point | null
  /** 标记图标（缺失时为 null，由调用方决定默认值） */
  icon: MarkerId | null
  /** 分组/着色用的地区名 */
  region: string | null
  /** 原始的坐标文本/结构（诊断与提示用） */
  rawCoordinates: unknown
  /** 坐标存在但解析失败（用来给出"你的写法不对"的提示，而不是静默忽略） */
  invalid: boolean
}

const DEFAULT_ICON: MarkerId = 'town'

/** 把任意值转成字符串（兼容 Bases 的 Value：它们都实现了 toString） */
function toText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = String(value)
    // 纯对象（如 [object Object]）没有有用的文本表示，交给上层按结构处理
    return text === '[object Object]' ? '' : text
  }
  return ''
}

/** 单个数值：数字、数字字符串、或带 toString 的 Value（如 NumberValue） */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = toText(value).trim()
  if (text.length === 0) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Bases 的 `ListValue` 形态：有 `length()` 与 `get(i)`。
 *
 * 这里刻意**用鸭子类型而不是 `instanceof ListValue`**：`instanceof` 需要导入该类，
 * 而在不支持 Bases 的旧版本 Obsidian 上这个导入会是 `undefined`，
 * `x instanceof undefined` 会直接抛 TypeError —— 那会让"版本门禁 + 降级"变成空谈。
 */
function asListLike(value: unknown): { length(): number; get(index: number): unknown } | null {
  const record = value as { length?: unknown; get?: unknown } | null
  if (!record || typeof record !== 'object') return null
  if (typeof record.length !== 'function' || typeof record.get !== 'function') return null
  return record as { length(): number; get(index: number): unknown }
}

/**
 * 解析坐标。支持：
 * - `[320, -140]`（数组或基斯的 ListValue）
 * - `{ x: 320, y: -140 }`
 * - `"320,-140"` / `"320 -140"` / `"320, -140"`
 * - 单个字符串里带括号的形式：`"(320, -140)"`
 */
export function parseCoordinateValue(value: unknown): Point | null {
  if (value === null || value === undefined) return null

  // 数组 / ListValue
  const list = asListLike(value) ?? (Array.isArray(value) ? value : null)
  if (list) {
    const count = typeof (list as { length?: unknown }).length === 'function' ? (list as { length(): number }).length() : (list as unknown[]).length
    if (count < 2) return null
    const first = (list as { get(i: number): unknown }).get ? (list as { get(i: number): unknown }).get(0) : (list as unknown[])[0]
    const second = (list as { get(i: number): unknown }).get ? (list as { get(i: number): unknown }).get(1) : (list as unknown[])[1]
    const x = toNumber(first)
    const y = toNumber(second)
    return x === null || y === null ? null : { x, y }
  }

  // { x, y }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const x = toNumber(record.x ?? record.X)
    const y = toNumber(record.y ?? record.Y)
    return x === null || y === null ? null : { x, y }
  }

  // 字符串
  const text = toText(value).trim().replace(/^[[(]+|[)\]]+$/g, '')
  if (text.length === 0) return null
  const parts = text.split(/[\s,;]+/).filter((part) => part.length > 0)
  if (parts.length < 2) return null
  const x = toNumber(parts[0])
  const y = toNumber(parts[1])
  return x === null || y === null ? null : { x, y }
}

/**
 * 把图标名收敛成受支持的图标（未知名字退化为默认图标，而不是拒绝整条记录）。
 *
 * 除了内置 9 种，还接受 `custom:` 命名空间下的自定义标记：笔记里写
 * `map-type: custom:lighthouse` 与地图文件里写同样的值是一个意思。
 *
 * 为什么这里**不像地图文档那样保留任意未知值**：地图文件是我们要写回去的，
 * 改写它等于不可逆地删用户的数据；而笔记的 frontmatter 本插件只读不写，
 * 所以没有丢数据的风险，反倒是"一个拼错的 map-type 悄悄变成一个神秘图标"更难查。
 */
export function normalizeMarkerIcon(value: unknown): MarkerId | null {
  const text = toText(value).trim().toLowerCase()
  if (text.length === 0) return null
  const found = MARKER_ICONS.find((icon) => icon === text)
  if (found !== undefined) return found
  // 自定义标记：只认前缀形状，不检查"设置里有没有定义"（那是绘制层与设置的事，
  // 定义暂时缺失时绘制层会画回退视觉，而这里拒收只会让用户的笔记突然少一个标记）
  return text.startsWith(CUSTOM_MARKER_PREFIX) && text.length > CUSTOM_MARKER_PREFIX.length ? text : null
}

export function parseNoteMapProps(values: {
  coordinates?: unknown
  mapType?: unknown
  region?: unknown
}): NoteMapProps {
  const rawCoordinates = values.coordinates
  const hasCoordinates = rawCoordinates !== null && rawCoordinates !== undefined && toText(rawCoordinates).trim().length > 0
  const point = parseCoordinateValue(rawCoordinates)
  const region = toText(values.region).trim()
  return {
    point,
    icon: normalizeMarkerIcon(values.mapType),
    region: region.length > 0 ? region : null,
    rawCoordinates: rawCoordinates ?? null,
    // 有值但解析不出来 = 写法有问题，调用方应当提示用户（静默忽略最难查）
    invalid: hasCoordinates && point === null,
  }
}

/** 笔记缺 `map-type` 时的默认图标 */
export function iconOrDefault(props: NoteMapProps): MarkerId {
  return props.icon ?? DEFAULT_ICON
}
