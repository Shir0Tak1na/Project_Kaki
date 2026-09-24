/**
 * 路径类型目录 —— 纯函数模块，**每种路径类型的参数的唯一来源**。
 *
 * 为什么需要它（而不是继续用"颜色一份、线宽虚线另一份"）：
 * 1. 参数原本散在 `stylePalette.pathColors`（只有颜色）与
 *    `pathStyleSettings.pathStyleOverrides`（线宽/虚线/变细/平滑）两处 —— 两处就迟早会分叉，
 *    而分叉的表现是"设置里改了线宽，画出来却是另一个宽度"，且没有任何报错。
 *    从本模块起，内置 4 种与用户自定义类型的**全部参数**都只住在 `PathTypeEntry.params` 里。
 * 2. 每个参数都是"写错了不报错、只会静默变形"的高发区：
 *    - 颜色非法时 canvas **静默忽略**该次 stroke（沿用上一个颜色）；
 *    - 线宽 0.1 px 看不见、500 px 糊满屏；
 *    - 虚线数组奇数长度或全 0，会让线看起来像噪点或干脆消失；
 *    - `lineCap` / `lineJoin` 写错值同样被静默忽略（沿用上一个值）。
 *    因此这里一律"先校验、不合法就回退到工厂值"，绝不把用户输入原样透传给 canvas。
 * 3. **ID 与显示名解耦**：`id` 是写进地图文件 `paths[].type` 的值，`label` 只是界面文案。
 *    改显示名绝不影响已存数据 —— 这是本功能里最难补救的一点。
 *
 * 与 `terrainCatalog.ts` / `markerCatalog.ts` 的分工完全同构：
 * 内置 → 用户自定义 → 未知，三级回退都在 `resolvePathType()` 里一次性决定，
 * 工具条、图例、设置页、Base 行都读同一份结果。
 *
 * 语义边界（与地形/标记一致）：设置里的类型参数只决定**以后新画**的路径长什么样。
 * 已经画好的路径把参数存在地图文件里（`path.color` / `path.width` / `path.dash` / `path.cap` / `path.join`），
 * 改设置**不会**悄悄改掉你已有的地图。
 */

import {
  PATH_TYPES,
  type BuiltinPathType,
  type PathCapStyle,
  type PathJoinStyle,
  type PathType,
} from '../data/mapDocument.ts'
import { DEFAULT_PATH_CAP, DEFAULT_PATH_JOIN, PATH_STYLES, type PathStyle } from './shapeStyle.ts'
import { normalizeColor, type PathColorMap } from './stylePalette.ts'
import {
  describePathDashProblem,
  fromLegacyPathColors,
  normalizePathDash,
  normalizePathStyleOverrides,
  normalizePathWidth,
  resolvePathStyleFull,
} from './pathStyleSettings.ts'

/**
 * 自定义路径类型 ID 的前缀（与自定义地形/标记同一套命名空间规则）。
 *
 * 内置类型是纯小写单词（`river` / `road` …），冒号让"这是用户命名空间"在文件里一眼可辨，
 * 而且内置类型永远不含冒号 —— 冲突在结构上就不可能发生。
 */
export const CUSTOM_PATH_TYPE_PREFIX = 'custom:'

/** 用户可填的 ID 主体（不含前缀）；与"文件里能存什么"是两回事，见 `mapDocument.ts` */
const PATH_TYPE_SLUG = /^[a-z][a-z0-9_-]{1,31}$/

/**
 * 自定义路径类型数量上限。
 *
 * 定 32 的理由是**界面**而不是存储：工具条下拉里要能滚动着看完（32 项 + 内置 4 项），
 * 设置页也要一屏能翻到底。用户已确认这个数。
 */
export const MAX_CUSTOM_PATH_TYPES = 32

/** 显示名长度上限（下拉与设置页一行放得下） */
const MAX_LABEL_LENGTH = 24

/** 新建自定义类型时的出厂色：中性灰蓝，与内置 4 色都不撞 */
export const DEFAULT_CUSTOM_PATH_COLOR = '#8fa3b0'

/** 新建自定义类型时的出厂线宽（世界单位）：与内置 4–8 同量级，取中间的整数 */
export const DEFAULT_CUSTOM_PATH_WIDTH = 4

/**
 * 类型所属的大类。
 *
 * 本轮（⑤-1）只接路径；**区域类型留到下一增量**，但维度现在就带上 ——
 * 否则下一增量要动的是数据形状（`PathTypeEntry` 的所有调用点），而不是加几条实现。
 */
export type PathTypeKind = 'path' | 'region'

export const DEFAULT_PATH_TYPE_KIND: PathTypeKind = 'path'

export interface PathTypeParams {
  color: string
  /** 线宽（世界单位） */
  width: number
  /**
   * 虚线：`[]` = 实线。
   *
   * 注意 `normalizePathDash` 的三态语义（缺失 → 用回退值 / `[]` → 实线 / 非空偶数数组 → 虚线）：
   * 这里**不重新发明**它，缺失一律取回退值（出厂虚线就是出厂虚线）。
   */
  dash: number[]
  /** 末端变细（河流） */
  taper: boolean
  /** 用平滑曲线而不是折线 */
  smooth: boolean
  /** 端点样式 */
  cap: PathCapStyle
  /** 连接样式 */
  join: PathJoinStyle
}

/** 一条路径类型定义（内置或自定义） */
export interface PathTypeEntry {
  /** 写进地图文件 `paths[].type` 的值：内置 `river`… 或 `custom:xxx` */
  id: string
  /** 显示名（工具条/图例/设置页）；内置的不可改，自定义的可以随便改 */
  label: string
  kind: PathTypeKind
  params: PathTypeParams
}

/** 绘制层真正消费的形状：内置、自定义、未知三种情况被抹平 */
export interface ResolvedPathType extends PathTypeEntry {
  /** 内置之一 */
  builtin: boolean
  /** 设置里找不到这个 ID（旧文件、别人的文件、或用户刚把定义删了） */
  unknown: boolean
}

/* ------------------------------------------------------------------ ID */

/** 内置类型判断（`PathType` 已放宽成字符串，这里做一次收窄） */
export function isBuiltinPathType(value: unknown): value is BuiltinPathType {
  return typeof value === 'string' && (PATH_TYPES as readonly string[]).includes(value)
}

/**
 * 把**用户输入**收敛成合法的自定义路径类型 ID；不合法返回 `null`。
 *
 * 规则与自定义地形/标记逐字一致：trim、统一小写、去掉多余的 `custom:` 前缀，
 * 主体必须匹配 `^[a-z][a-z0-9_-]{1,31}$`，最后统一补上前缀。
 *
 * 为什么用户输入**一律**加前缀、哪怕他写的是 `river`：内置名是留给内置的，
 * 用户想要的 `river` 会变成 `custom:river`（显示名可以照旧叫"河流"）。
 * 让前缀成为系统的一部分，冲突就由结构避免，而不是靠用户记住规矩。
 */
export function normalizePathTypeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim().toLowerCase()
  if (text.length === 0) return null
  while (text.startsWith(CUSTOM_PATH_TYPE_PREFIX)) text = text.slice(CUSTOM_PATH_TYPE_PREFIX.length)
  if (!PATH_TYPE_SLUG.test(text)) return null
  return `${CUSTOM_PATH_TYPE_PREFIX}${text}`
}

/** 给设置界面用的**可读原因**；`null` 表示合法 */
export function pathTypeIdProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'ID 不能为空'
  if (normalizePathTypeId(raw) !== null) return null
  let text = raw.trim().toLowerCase()
  while (text.startsWith(CUSTOM_PATH_TYPE_PREFIX)) text = text.slice(CUSTOM_PATH_TYPE_PREFIX.length)
  if (!/^[a-z]/.test(text)) return 'ID 必须以小写字母开头（例如 highway）'
  if (text.length < 2) return 'ID 至少 2 个字符'
  if (text.length > 32) return `ID 太长（${text.length} 字符，最多 32）`
  return 'ID 只能用小写字母、数字、下划线和连字符'
}

/** 显示名：去空白、限长；留空时退化为 ID 主体 */
export function normalizePathTypeLabel(raw: unknown, id: string): string {
  const fallback = id.startsWith(CUSTOM_PATH_TYPE_PREFIX) ? id.slice(CUSTOM_PATH_TYPE_PREFIX.length) : id
  if (typeof raw !== 'string') return fallback
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length === 0) return fallback
  return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH) : text
}

/** 收敛大类。未知值一律当 `path`（本轮只有路径被接线，宁可当成路径也不要凭空造区域） */
export function normalizePathTypeKind(raw: unknown): PathTypeKind {
  return raw === 'region' ? 'region' : 'path'
}

/* --------------------------------------------------------------- 参数 */

/** 端点样式的中文名（设置页与提示共用；**不在这里再抄一份词表**，键就是数据层的联合） */
export const PATH_CAP_LABELS: Record<PathCapStyle, string> = {
  butt: '平头',
  round: '圆头',
  square: '方头',
}

/** 连接样式的中文名 */
export const PATH_JOIN_LABELS: Record<PathJoinStyle, string> = {
  miter: '尖角',
  round: '圆角',
  bevel: '斜角',
}

export function normalizePathCap(raw: unknown): PathCapStyle {
  return raw === 'butt' || raw === 'square' ? raw : DEFAULT_PATH_CAP
}

export function normalizePathJoin(raw: unknown): PathJoinStyle {
  return raw === 'miter' || raw === 'bevel' ? raw : DEFAULT_PATH_JOIN
}

/** 自定义类型的出厂参数（字段缺失时写死这些值，**不做任何隐式推断**） */
export function customPathTypeParams(): PathTypeParams {
  return {
    color: DEFAULT_CUSTOM_PATH_COLOR,
    width: DEFAULT_CUSTOM_PATH_WIDTH,
    // 实线：新建的类型不预设虚线，用户想要虚线就自己填
    dash: [],
    taper: false,
    smooth: false,
    cap: DEFAULT_PATH_CAP,
    join: DEFAULT_PATH_JOIN,
  }
}

/**
 * 升级前 `drawPath()` 里写死的 `lineCap` / `lineJoin`。
 *
 * 这两个常量是"旧地图逐像素不变"的依据：内置类型的出厂值必须等于它们，
 * 而缺字段的旧路径（`path.cap === undefined`）在绘制层也回退到它们。
 */
export const BASE_LINE_CAP: PathCapStyle = DEFAULT_PATH_CAP
export const BASE_LINE_JOIN: PathJoinStyle = DEFAULT_PATH_JOIN

/**
 * 内置类型的工厂参数 —— **直接取 `PATH_STYLES`，不在这里再抄一份数值**。
 *
 * 旧地图的渲染结果必须逐像素不变，因此颜色/线宽/虚线/变细/平滑都照抄出厂定义；
 * `cap` / `join` 取 `round` —— 那正是升级前 `drawPath` 里硬编码的值。
 */
export function factoryPathTypeParams(id: BuiltinPathType): PathTypeParams {
  const base = PATH_STYLES[id]
  return {
    color: base.color,
    width: base.width,
    dash: base.dash ? [...base.dash] : [],
    taper: base.taper === true,
    smooth: base.smooth === true,
    cap: BASE_LINE_CAP,
    join: BASE_LINE_JOIN,
  }
}

/** 工厂参数 → 绘制层样式（保留 `PATH_STYLES` 的可选字段语义：solid 不写 dash） */
function paramsFromPathStyle(style: PathStyle, fallback: PathTypeParams): PathTypeParams {
  return {
    color: normalizeColor(style.color, fallback.color),
    width: normalizePathWidth(style.width, fallback.width),
    dash: style.dash ? [...style.dash] : [],
    taper: style.taper === true,
    smooth: style.smooth === true,
    cap: style.cap ?? fallback.cap,
    join: style.join ?? fallback.join,
  }
}

/**
 * 收敛一份参数。
 *
 * 三条刻意的选择：
 * 1. `dash` 缺失 → 回退值的虚线（不是实线）：道路出厂的 `[14,10]` 不能因为少一个字段就变实线；
 * 2. `cap` / `join` 非法 → 回退值，**不是**"保持上一个 canvas 状态"；
 * 3. 缺少/非法一律回退，不抛异常 —— 设置文件可能被手工改坏。
 */
export function normalizePathTypeParams(raw: unknown, fallback: PathTypeParams): PathTypeParams {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const dash =
    source.dash === undefined ? [...fallback.dash] : (normalizePathDash(source.dash) ?? [...fallback.dash])
  return {
    color: normalizeColor(source.color, fallback.color),
    width: normalizePathWidth(source.width, fallback.width),
    dash,
    taper: typeof source.taper === 'boolean' ? source.taper : fallback.taper,
    smooth: typeof source.smooth === 'boolean' ? source.smooth : fallback.smooth,
    cap: source.cap === undefined ? fallback.cap : normalizePathCap(source.cap),
    join: source.join === undefined ? fallback.join : normalizePathJoin(source.join),
  }
}

export function samePathTypeParams(a: PathTypeParams, b: PathTypeParams): boolean {
  return (
    a.color === b.color &&
    a.width === b.width &&
    a.dash.join(',') === b.dash.join(',') &&
    a.taper === b.taper &&
    a.smooth === b.smooth &&
    a.cap === b.cap &&
    a.join === b.join
  )
}

/* --------------------------------------------------- 目录（设置 → 唯一来源） */

export interface PathTypeLegacySource {
  /** 旧字段：只有颜色（`stylePalette.pathColors` 那一代） */
  pathColors?: Record<string, unknown> | undefined
  /** 旧字段：颜色 + 线宽/虚线/变细/平滑（`pathStyleSettings` 那一代） */
  pathStyleOverrides?: Record<string, unknown> | undefined
}

/** 出厂目录：内置 4 种，没有自定义项 */
export function defaultPathTypeEntries(): PathTypeEntry[] {
  return PATH_TYPES.map((type) => ({
    id: type,
    label: PATH_STYLES[type].label,
    kind: DEFAULT_PATH_TYPE_KIND,
    params: factoryPathTypeParams(type),
  }))
}

/**
 * 迁移内置类型的参数。
 *
 * 这是"旧字段只读兼容"的**唯一**入口：老用户改过的颜色（`pathColors`）与画法
 * （`pathStyleOverrides`）在这里被读进目录，之后目录就是唯一来源。
 * 两者都缺时结果等于出厂参数 —— 于是"用户没改过的设置，迁移后视觉完全一致"。
 */
function migratedBuiltinParams(id: BuiltinPathType, legacy: PathTypeLegacySource | undefined): PathTypeParams {
  const fallback = factoryPathTypeParams(id)
  if (legacy === undefined) return fallback
  // `normalizePathStyleOverrides` 的三态语义正是迁移需要的：
  // 显式写过的类型以它为准，没写过的类型才去读旧的颜色表。
  const overrides =
    legacy.pathStyleOverrides === undefined
      ? fromLegacyPathColors(legacy.pathColors)
      : normalizePathStyleOverrides(legacy.pathStyleOverrides, legacy.pathColors)
  // `resolvePathStyleFull` 只对内置 ID 有效（它按 PATH_STYLES 取基准），这里正好只用在内置 ID 上
  return paramsFromPathStyle(resolvePathStyleFull(id, overrides), fallback)
}

/** 存储里的 ID → 规范 ID：内置原样，其余按用户输入规则补前缀 */
function canonicalStoredId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (isBuiltinPathType(text)) return text
  return normalizePathTypeId(text)
}

/**
 * 条目的参数从哪读。
 *
 * 两种情况是**显式区分**的，不靠"有没有某个字段"去猜行为：
 * - `params` 存在 → 一律用它（哪怕它是个坏值，坏值走回退，不去读同级的扁平字段）；
 * - `params` 不存在 → 读条目自身的扁平字段（`{id, label, color, width, …}`）——
 *   这是本版本之前的写法与手工编辑时的自然写法。
 */
function paramsSourceOf(record: Record<string, unknown>): unknown {
  return record.params !== undefined ? record.params : record
}

/**
 * 把任意输入（可能是被手工改坏的 `data.json`、也可能是上一代的字段）收敛成一份可用目录。
 *
 * - 内置 4 种**永远存在**且顺序固定（顺序即工具条与图例的顺序）；
 * - 自定义项按设置里的顺序排在后面，按 ID 去重（先出现的胜出）；
 * - 自定义项截断到 `MAX_CUSTOM_PATH_TYPES`；
 * - **幂等**：收敛结果再收敛一次完全相同（测试钉死）。
 */
export function normalizePathTypeEntries(raw: unknown, legacy?: PathTypeLegacySource): PathTypeEntry[] {
  const explicit = new Map<string, Record<string, unknown>>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const id = canonicalStoredId(record.id)
      if (id === null || explicit.has(id)) continue
      explicit.set(id, record)
    }
  }

  const out: PathTypeEntry[] = []
  for (const type of PATH_TYPES) {
    const fallback = migratedBuiltinParams(type, legacy)
    const record = explicit.get(type)
    out.push({
      id: type,
      // 内置显示名不可改：它是出厂定义的一部分（改画法可以，改名字没有意义且会与图例/文档对不上）
      label: PATH_STYLES[type].label,
      kind: DEFAULT_PATH_TYPE_KIND,
      params: normalizePathTypeParams(record === undefined ? undefined : paramsSourceOf(record), fallback),
    })
  }

  let customCount = 0
  for (const [id, record] of explicit) {
    if (isBuiltinPathType(id)) continue
    if (customCount >= MAX_CUSTOM_PATH_TYPES) break
    customCount += 1
    out.push({
      id,
      label: normalizePathTypeLabel(record.label, id),
      kind: normalizePathTypeKind(record.kind),
      params: normalizePathTypeParams(paramsSourceOf(record), customPathTypeParams()),
    })
  }
  return out
}

/** 只保留某一大类的条目（本轮工具条与设置页都只取 `path`） */
export function listPathTypeEntries(entries: readonly PathTypeEntry[], kind: PathTypeKind = 'path'): PathTypeEntry[] {
  return entries.filter((entry) => entry.kind === kind)
}

/** 自定义条目（按设置顺序），供设置页与上限提示使用 */
export function customPathTypeEntries(entries: readonly PathTypeEntry[]): PathTypeEntry[] {
  return entries.filter((entry) => !isBuiltinPathType(entry.id))
}

export function findPathTypeEntry(id: string, entries: readonly PathTypeEntry[]): PathTypeEntry | null {
  for (const entry of entries) if (entry.id === id) return entry
  return null
}

/* --------------------------------------------------------------- 解析 */

/**
 * 未知类型的回退参数。
 *
 * 刻意**不是**隐形（不可见）也不是随便挑一个内置色：它要让人看出"这里有东西，
 * 但本机设置里没有对应定义"，同时不能与任何一种定义混淆。
 */
export const FALLBACK_PATH_TYPE_PARAMS: PathTypeParams = {
  color: '#9aa4ad',
  width: 4,
  dash: [12, 8],
  taper: false,
  smooth: false,
  cap: DEFAULT_PATH_CAP,
  join: DEFAULT_PATH_JOIN,
}

/**
 * 三级回退：内置 → 自定义 → 未知。**永不返回 null**。
 *
 * 绘制层每帧都会问它，任何"这里没有样式"的分支都会变成"某条路径突然画不出来"；
 * 而解析层读到未知 ID 是**必然**会发生的（别的库、别的版本、用户删掉定义），
 * 因此这里必须总有一份看得见的视觉。
 */
export function resolvePathType(id: PathType, entries: readonly PathTypeEntry[] = []): ResolvedPathType {
  if (isBuiltinPathType(id)) {
    const entry = findPathTypeEntry(id, entries)
    return {
      id,
      label: PATH_STYLES[id].label,
      kind: DEFAULT_PATH_TYPE_KIND,
      params: entry ? entry.params : factoryPathTypeParams(id),
      builtin: true,
      unknown: false,
    }
  }
  const entry = findPathTypeEntry(id, entries)
  if (entry !== null) return { ...entry, builtin: false, unknown: false }
  return {
    id,
    label: `未知（${id}）`,
    kind: DEFAULT_PATH_TYPE_KIND,
    params: FALLBACK_PATH_TYPE_PARAMS,
    builtin: false,
    unknown: true,
  }
}

/** ID → 显示名（工具条、图例、Base 行、状态报告都用它） */
export function pathTypeLabelOf(id: string, entries: readonly PathTypeEntry[] = []): string {
  return resolvePathType(id, entries).label
}

/**
 * 解析成绘制层用的 `PathStyle`。
 *
 * 这是**唯一**的路径样式解析入口：颜色、线宽、虚线、变细、平滑、端点、连接都在这里定下来，
 * 之后没有任何地方再读设置里的第二份值。
 */
export function resolvedPathStyle(id: PathType, entries: readonly PathTypeEntry[] = []): PathStyle {
  const resolved = resolvePathType(id, entries)
  const style: PathStyle = {
    type: resolved.id,
    label: resolved.label,
    color: resolved.params.color,
    width: resolved.params.width,
    cap: resolved.params.cap,
    join: resolved.params.join,
  }
  if (resolved.params.dash.length > 0) style.dash = [...resolved.params.dash]
  if (resolved.params.taper) style.taper = true
  if (resolved.params.smooth) style.smooth = true
  return style
}

/**
 * 参数的可读描述（工具条提示、设置页小字）。
 *
 * 与 `pathStyleSettings.describePathDash` 的分工：那边只说虚线，这里把线宽/虚实/变细/平滑/端点
 * 一起说清楚 —— 用户在一个下拉里要能一眼比较两种类型"画法上的差别"。
 */
export function describePathTypeParams(params: PathTypeParams): string {
  const parts = [`线宽 ${params.width}`, params.dash.length > 0 ? `虚线 ${params.dash.join('-')}` : '实线']
  if (params.taper) parts.push('末端变细')
  if (params.smooth) parts.push('平滑')
  if (params.cap !== DEFAULT_PATH_CAP) parts.push(`端点 ${PATH_CAP_LABELS[params.cap]}`)
  if (params.join !== DEFAULT_PATH_JOIN) parts.push(`连接 ${PATH_JOIN_LABELS[params.join]}`)
  return parts.join(' · ')
}

/**
 * 目录**列表**签名：决定工具条下拉要不要重建 DOM。
 *
 * 刻意只包含"选项有哪些、叫什么"（`id|label|kind`），**不含颜色/线宽/虚线等参数**：
 * 那些改了只需要原地刷新色块与提示（见 `MapToolbar.refresh`）。重建 DOM 会把展开状态
 * 与键盘焦点一并丢掉 —— 而"改个颜色就把整排按钮重建一遍"正是本项目在侧栏面板上
 * 已经吃过一次的亏。
 */
export function pathTypeCatalogSignature(entries: readonly PathTypeEntry[]): string {
  return entries.map((entry) => `${entry.id}|${entry.label}|${entry.kind}`).join(';')
}

/* --------------------------------------------------------------- 编辑 */

/**
 * 解析设置页里填的虚线文本。
 *
 * 语法刻意很窄：**空 = 实线**；否则是逗号/空格分隔的数字（`14,10` 或 `14 10`）。
 * 返回可读原因而不是"悄悄当作实线"—— 后者会让用户以为自己填的生效了，
 * 而用户看到的却是实线（这正是本项目最怕的一类缺陷）。
 */
export function parsePathDashInput(raw: unknown): { ok: true; dash: number[] } | { ok: false; problem: string } {
  if (typeof raw !== 'string') return { ok: false, problem: '虚线必须是文本' }
  const text = raw.trim()
  if (text.length === 0) return { ok: true, dash: [] }
  const parts = text.split(/[\s,，]+/).filter((part) => part.length > 0)
  const numbers: number[] = []
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value)) return { ok: false, problem: `「${part}」不是数字` }
    numbers.push(value)
  }
  const problem = describePathDashProblem(numbers)
  if (problem !== null) return { ok: false, problem }
  return { ok: true, dash: numbers }
}

export interface PathTypePatch {
  label?: unknown
  color?: unknown
  width?: unknown
  dash?: unknown
  taper?: unknown
  smooth?: unknown
  cap?: unknown
  join?: unknown
}

/**
 * 对一条已存在的类型应用"补丁"。
 *
 * 只接受补丁而不是整条替换：`id` 与 `kind` 不在补丁里 ——
 * 改 ID 等于把地图文件里已有的路径指向另一个类型，那不是编辑而是数据迁移，
 * 必须显式做成一个功能，不能顺手提供。内置类型的显示名同样不可改（见 `normalizePathTypeEntries`）。
 */
export function applyPathTypePatch(
  entry: PathTypeEntry,
  patch: PathTypePatch,
): { ok: true; entry: PathTypeEntry } | { ok: false; problem: string } {
  if (patch.dash !== undefined) {
    const problem = describePathDashProblem(patch.dash)
    if (problem !== null) return { ok: false, problem }
  }
  const fallback = isBuiltinPathType(entry.id) ? factoryPathTypeParams(entry.id) : customPathTypeParams()
  const merged: Record<string, unknown> = { ...entry.params }
  for (const key of ['color', 'width', 'dash', 'taper', 'smooth', 'cap', 'join'] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key]
  }
  return {
    ok: true,
    entry: {
      ...entry,
      // 内置显示名固定：补丁里带了也不采纳（界面上也不给这个入口）
      label: isBuiltinPathType(entry.id) ? entry.label : normalizePathTypeLabel(patch.label ?? entry.label, entry.id),
      params: normalizePathTypeParams(merged, fallback),
    },
  }
}

/** 新建一条自定义类型前的自检（设置页保存前用它决定"能不能收"） */
export function validateCustomPathTypeInput(input: {
  id: unknown
  label?: unknown
  color?: unknown
  width?: unknown
  dash?: unknown
  taper?: unknown
  smooth?: unknown
  cap?: unknown
  join?: unknown
}): { ok: true; entry: PathTypeEntry } | { ok: false; problem: string } {
  const id = normalizePathTypeId(input.id)
  if (id === null) return { ok: false, problem: pathTypeIdProblem(input.id) ?? 'ID 不合法' }
  if (input.dash !== undefined) {
    const problem = describePathDashProblem(input.dash)
    if (problem !== null) return { ok: false, problem }
  }
  const params = normalizePathTypeParams(
    {
      color: input.color,
      width: input.width,
      dash: input.dash,
      taper: input.taper,
      smooth: input.smooth,
      cap: input.cap,
      join: input.join,
    },
    customPathTypeParams(),
  )
  return {
    ok: true,
    entry: { id, label: normalizePathTypeLabel(input.label, id), kind: DEFAULT_PATH_TYPE_KIND, params },
  }
}

/* --------------------------------------------------------- 恢复 / 判读 */

/**
 * 「恢复出厂样式」：把**内置**类型的参数恢复成工厂值，**不动自定义类型**。
 *
 * 自定义类型是用户建的数据（像自定义地形一样），不是"样式偏好" ——
 * 顺手把它们删掉或改掉是不可逆的。
 */
export function resetPathTypeStyles(entries: readonly PathTypeEntry[]): PathTypeEntry[] {
  return entries.map((entry) =>
    isBuiltinPathType(entry.id) ? { ...entry, params: factoryPathTypeParams(entry.id) } : entry,
  )
}

/** 内置类型的参数是否全部等于工厂值（设置页据此显示"已改动"） */
export function isDefaultPathTypeStyles(entries: readonly PathTypeEntry[]): boolean {
  return PATH_TYPES.every((type) => {
    const entry = findPathTypeEntry(type, entries)
    if (entry === null) return false
    return samePathTypeParams(entry.params, factoryPathTypeParams(type))
  })
}

/**
 * 旧字段 `pathColors` 的镜像值。
 *
 * 它**不再是渲染依据**（渲染一律走目录），保留它只是为了两件事：
 * 1. 写回 `data.json` 时不让"同一份颜色"在两处自相矛盾；
 * 2. 用户回退到旧版插件时仍然看到自己改过的颜色。
 */
export function pathColorsFromEntries(entries: readonly PathTypeEntry[]): PathColorMap {
  const out = {} as PathColorMap
  for (const type of PATH_TYPES) {
    const entry = findPathTypeEntry(type, entries)
    out[type] = entry ? entry.params.color : PATH_STYLES[type].color
  }
  return out
}
