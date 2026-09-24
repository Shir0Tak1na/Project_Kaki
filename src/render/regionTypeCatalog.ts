/**
 * 区域类型目录 —— 纯函数模块，**每种区域类型的参数的唯一来源**。
 *
 * 为什么需要它：升级前"区域类型"只是 6 个**只有名字和颜色**的预设
 * （`shapeStyle.REGION_PRESETS`），不透明度、边框宽度是全局常量，边框色与虚线根本没有，
 * 而且**不可扩展**。用户的原话是"区域路径不够自定义，也应该像自定义一样新增"，
 * 于是这里把 6 个预设升级成**内置区域类型**，与路径类型目录完全同构：
 *
 * - 每个类型带全部参数：填充色 / 不透明度 / 边框色 / 边框宽度 / 边框虚线；
 * - 用户可以新增自定义类型（`custom:xxx`，上限 32 条）；
 * - 三级回退（内置 → 自定义 → 未知）都在 `resolveRegionType()` 里一次性决定，
 *   工具条、设置页、图例、Base 行都读同一份结果；
 * - 旧字段 `regionColors`（只有颜色的一代）只在加载时**迁移**一次，之后目录是唯一来源。
 *
 * 三条与数据保全直接相关的硬约束：
 * 1. `MapRegion.type` 是**可选**字段。旧区域没有它，读取时保持"没有"、写回时也不补，
 *    于是老地图文件逐字节不变，图例也仍按颜色反查预设名（`regionLabelForColor`）。
 * 2. 认不出的 ID **原样保留**（解析层只告警），回退视觉由 `resolveRegionType` 给 —— 它**永不返回空**。
 * 3. 设置里的类型参数只决定**以后新画**的区域。已经画好的区域把参数存在地图文件里
 *    （`region.color` / `opacity` / `borderColor` / `borderWidth` / `borderDash`），改设置不会动它们。
 */

import {
  BUILTIN_REGION_TYPES,
  type BuiltinRegionType,
  type RegionType,
} from '../data/mapDocument.ts'
import {
  DEFAULT_REGION_BORDER_WIDTH,
  DEFAULT_REGION_OPACITY,
  DEFAULT_REGION_TYPE_ID,
  REGION_TYPE_STYLES,
} from './shapeStyle.ts'
import { canonicalColor, normalizeColor } from './stylePalette.ts'
import { describePathDashProblem, normalizePathDash } from './pathStyleSettings.ts'

/**
 * 自定义区域类型 ID 的前缀（与自定义地形/标记/路径类型同一套命名空间规则）。
 *
 * 内置类型是纯小写单词（`realm` / `empire` …），冒号让"这是用户命名空间"一眼可辨，
 * 而且内置类型永远不含冒号 —— 冲突在结构上就不可能发生。
 */
export const CUSTOM_REGION_TYPE_PREFIX = 'custom:'

/** 用户可填的 ID 主体（不含前缀）；与"文件里能存什么"是两回事，见 `mapDocument.ts` */
const REGION_TYPE_SLUG = /^[a-z][a-z0-9_-]{1,31}$/

/**
 * 自定义区域类型数量上限。
 *
 * 与路径类型取同一个数（32）的理由也一样：这是**界面**约束而不是存储约束 ——
 * 工具条下拉要能滚动看完，设置页要能翻到底。
 */
export const MAX_CUSTOM_REGION_TYPES = 32

/** 显示名长度上限（下拉与设置页一行放得下） */
const MAX_LABEL_LENGTH = 24

/** 边框宽度上限（世界单位）：与路径线宽同一量级，0 = 不画边框 */
const MAX_BORDER_WIDTH = 40

/** 新建自定义类型时的出厂色：中性灰蓝，与内置 6 色都不撞 */
export const DEFAULT_CUSTOM_REGION_COLOR = '#8fa3b0'

export interface RegionTypeParams {
  /** 填充色 */
  color: string
  /** 填充不透明度（0–1） */
  opacity: number
  /**
   * 边框色。
   *
   * `null` = **跟随填充色** —— 这正是升级前的行为（`drawRegion` 里 `borderColor ?? color`），
   * 所以内置类型的出厂值就是 `null`，而不是把当时的颜色抄一份进来：
   * 抄进来的话，用户改填充色时边框会固执地留在旧颜色上。
   */
  borderColor: string | null
  /** 边框宽度（世界单位）；0 = 不画边框 */
  borderWidth: number
  /**
   * 边框虚线：`[]` = 实线。
   *
   * 语义**直接复用** `pathStyleSettings.normalizePathDash` 的三态（缺失 → 用回退值 /
   * `[]` → 实线 / 非空偶数数组 → 虚线），不重新发明一套。
   */
  borderDash: number[]
}

/** 一条区域类型定义（内置或自定义） */
export interface RegionTypeEntry {
  /** 写进地图文件 `regions[].type` 的值：内置 `realm`… 或 `custom:xxx` */
  id: string
  /** 显示名（工具条/图例/设置页）；内置的不可改，自定义的可以随便改 */
  label: string
  params: RegionTypeParams
}

/** 绘制层真正消费的形状：内置、自定义、未知三种情况被抹平 */
export interface ResolvedRegionType extends RegionTypeEntry {
  builtin: boolean
  /** 设置里找不到这个 ID（旧文件、别人的文件、或用户刚把定义删了） */
  unknown: boolean
}

/* ------------------------------------------------------------------ ID */

/** 内置类型判断（`RegionType` 是字符串，这里做一次收窄） */
export function isBuiltinRegionType(value: unknown): value is BuiltinRegionType {
  return typeof value === 'string' && (BUILTIN_REGION_TYPES as readonly string[]).includes(value)
}

/**
 * 把**用户输入**收敛成合法的自定义区域类型 ID；不合法返回 `null`。
 *
 * 规则与自定义地形/标记/路径类型逐字一致：trim、统一小写、去掉多余的 `custom:` 前缀、
 * 主体匹配 `^[a-z][a-z0-9_-]{1,31}$`，最后统一补上前缀。
 */
export function normalizeRegionTypeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim().toLowerCase()
  if (text.length === 0) return null
  while (text.startsWith(CUSTOM_REGION_TYPE_PREFIX)) text = text.slice(CUSTOM_REGION_TYPE_PREFIX.length)
  if (!REGION_TYPE_SLUG.test(text)) return null
  return `${CUSTOM_REGION_TYPE_PREFIX}${text}`
}

/** 给设置界面用的**可读原因**；`null` 表示合法 */
export function regionTypeIdProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'ID 不能为空'
  if (normalizeRegionTypeId(raw) !== null) return null
  let text = raw.trim().toLowerCase()
  while (text.startsWith(CUSTOM_REGION_TYPE_PREFIX)) text = text.slice(CUSTOM_REGION_TYPE_PREFIX.length)
  if (!/^[a-z]/.test(text)) return 'ID 必须以小写字母开头（例如 march）'
  if (text.length < 2) return 'ID 至少 2 个字符'
  if (text.length > 32) return `ID 太长（${text.length} 字符，最多 32）`
  return 'ID 只能用小写字母、数字、下划线和连字符'
}

/** 显示名：去空白、限长；留空时退化为 ID 主体 */
export function normalizeRegionTypeLabel(raw: unknown, id: string): string {
  const fallback = id.startsWith(CUSTOM_REGION_TYPE_PREFIX) ? id.slice(CUSTOM_REGION_TYPE_PREFIX.length) : id
  if (typeof raw !== 'string') return fallback
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length === 0) return fallback
  return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH) : text
}

/* --------------------------------------------------------------- 参数 */

/**
 * 收敛不透明度：非法值回退，合法值夹在 0–1。
 *
 * ⚠️ 必须接受**数字字符串**：设置页的文本框交出来的就是字符串（`'0.6'`）。
 * 只认 `number` 的话，用户在设置里填的 0.6 会被静默换成出厂 0.22 ——
 * 这正是"改了没反应、也没有报错"那一类缺陷（本次冒烟场景 37 抓到过一次）。
 */
export function normalizeRegionOpacity(raw: unknown, fallback: number): number {
  const numeric =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(1, Math.max(0, numeric))
}

/**
 * 收敛边框宽度。
 *
 * 与路径线宽不同：**0 是合法值**（= 不要边框），所以不能复用 `normalizePathWidth`
 * （它的下限是 1，会把"不画边框"静默变成一条 1 单位的线）。
 */
export function normalizeRegionBorderWidth(raw: unknown, fallback: number): number {
  const numeric =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(MAX_BORDER_WIDTH, Math.max(0, numeric))
}

/** 边框色：非空字符串且是安全颜色才用；`''` / `null` = 跟随填充色 */
export function normalizeRegionBorderColor(raw: unknown, fallback: string | null): string | null {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') return fallback
  const text = raw.trim()
  if (text.length === 0) return null
  return normalizeColor(text, fallback ?? '')
}

/** 新建自定义类型时的出厂参数（字段缺失时写死这些值，**不做任何隐式推断**） */
export function customRegionTypeParams(): RegionTypeParams {
  return {
    color: DEFAULT_CUSTOM_REGION_COLOR,
    opacity: DEFAULT_REGION_OPACITY,
    // 跟随填充色：与升级前的行为一致，也省得用户新建时先配两个颜色
    borderColor: null,
    borderWidth: DEFAULT_REGION_BORDER_WIDTH,
    // 实线：新建的类型不预设虚线
    borderDash: [],
  }
}

/**
 * 内置类型的工厂参数 —— **颜色与显示名直接取 `REGION_TYPE_STYLES`（其数据源是 `REGION_PRESETS`）**，
 * 不在这里再抄一份数值。
 *
 * 不透明度 0.22 与边框宽 3 就是升级前的全局常量（`DEFAULT_REGION_OPACITY` /
 * `DEFAULT_REGION_BORDER_WIDTH`），边框色 `null` = 跟随填充色 —— 也就是说：
 * **没改过设置的用户，升级后画出来的区域与升级前一模一样。**
 */
export function factoryRegionTypeParams(id: BuiltinRegionType): RegionTypeParams {
  const style = REGION_TYPE_STYLES[id]
  return {
    color: style.color,
    opacity: DEFAULT_REGION_OPACITY,
    borderColor: null,
    borderWidth: DEFAULT_REGION_BORDER_WIDTH,
    borderDash: [],
  }
}

/**
 * 收敛一份参数。
 *
 * 三条刻意的选择（与路径参数逐条对应）：
 * 1. `borderDash` 缺失 → 回退值（不是"实线"）：不能因为少一个字段就让虚线变实线；
 * 2. 非法值一律回退到工厂值，**不是**"保持上一个 canvas 状态"；
 * 3. 不抛异常 —— `data.json` 可能被手工改坏。
 */
export function normalizeRegionTypeParams(raw: unknown, fallback: RegionTypeParams): RegionTypeParams {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const dash =
    source.borderDash === undefined
      ? [...fallback.borderDash]
      : (normalizePathDash(source.borderDash) ?? [...fallback.borderDash])
  return {
    color: normalizeColor(source.color, fallback.color),
    opacity: normalizeRegionOpacity(source.opacity, fallback.opacity),
    borderColor:
      source.borderColor === undefined ? fallback.borderColor : normalizeRegionBorderColor(source.borderColor, fallback.borderColor),
    borderWidth: normalizeRegionBorderWidth(source.borderWidth, fallback.borderWidth),
    borderDash: dash,
  }
}

export function sameRegionTypeParams(a: RegionTypeParams, b: RegionTypeParams): boolean {
  return (
    canonicalColor(a.color) === canonicalColor(b.color) &&
    a.opacity === b.opacity &&
    a.borderColor === b.borderColor &&
    a.borderWidth === b.borderWidth &&
    a.borderDash.join(',') === b.borderDash.join(',')
  )
}

/* --------------------------------------------------- 目录（设置 → 唯一来源） */

export interface RegionTypeLegacySource {
  /** 旧字段：6 个预设色（`stylePalette.regionColors` 那一代），下标与内置类型一一对应 */
  regionColors?: unknown
}

/** 出厂目录：内置 6 种，没有自定义项 */
export function defaultRegionTypeEntries(): RegionTypeEntry[] {
  return BUILTIN_REGION_TYPES.map((id) => ({
    id,
    label: REGION_TYPE_STYLES[id].label,
    params: factoryRegionTypeParams(id),
  }))
}

/**
 * 迁移内置类型的颜色。
 *
 * 这是"旧字段只读兼容"的**唯一**入口：老用户改过的 `regionColors[i]` 在这里被读进目录，
 * 之后目录就是唯一来源。没给旧字段时结果等于工厂参数 —— 于是"用户没改过的设置，
 * 迁移后视觉完全一致"。
 */
function migratedBuiltinParams(id: BuiltinRegionType, legacy: RegionTypeLegacySource | undefined): RegionTypeParams {
  const fallback = factoryRegionTypeParams(id)
  const colors = legacy?.regionColors
  if (!Array.isArray(colors)) return fallback
  const index = (BUILTIN_REGION_TYPES as readonly string[]).indexOf(id)
  const raw = colors[index]
  if (typeof raw !== 'string') return fallback
  return { ...fallback, color: normalizeColor(raw, fallback.color) }
}

/** 存储里的 ID → 规范 ID：内置原样，其余按用户输入规则补前缀 */
function canonicalStoredId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (isBuiltinRegionType(text)) return text
  return normalizeRegionTypeId(text)
}

/**
 * 条目的参数从哪读：`params` 存在就一律用它（坏值走回退，不去读同级的扁平字段），
 * 否则读条目自身的扁平字段。这与 `pathTypeCatalog` 的显式区分保持一致 ——
 * 不靠"有没有某个字段"去猜行为（§5.20）。
 */
function paramsSourceOf(record: Record<string, unknown>): unknown {
  return record.params !== undefined ? record.params : record
}

/**
 * 把任意输入（可能是被手工改坏的 `data.json`、也可能是上一代的 `regionColors`）收敛成一份可用目录。
 *
 * - 内置 6 种**永远存在**且顺序固定（顺序即工具条下拉与图例的顺序）；
 * - 自定义项按设置里的顺序排在后面，按 ID 去重（先出现的胜出）；
 * - 自定义项截断到 `MAX_CUSTOM_REGION_TYPES`；
 * - **幂等**：收敛结果再收敛一次完全相同（测试钉死）。
 */
export function normalizeRegionTypeEntries(raw: unknown, legacy?: RegionTypeLegacySource): RegionTypeEntry[] {
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

  const out: RegionTypeEntry[] = []
  for (const id of BUILTIN_REGION_TYPES) {
    const fallback = migratedBuiltinParams(id, legacy)
    const record = explicit.get(id)
    out.push({
      id,
      // 内置显示名不可改：它是出厂定义的一部分（改画法可以，改名字会与图例/文档对不上）
      label: REGION_TYPE_STYLES[id].label,
      params: normalizeRegionTypeParams(record === undefined ? undefined : paramsSourceOf(record), fallback),
    })
  }

  let customCount = 0
  for (const [id, record] of explicit) {
    if (isBuiltinRegionType(id)) continue
    if (customCount >= MAX_CUSTOM_REGION_TYPES) break
    customCount += 1
    out.push({
      id,
      label: normalizeRegionTypeLabel(record.label, id),
      params: normalizeRegionTypeParams(paramsSourceOf(record), customRegionTypeParams()),
    })
  }
  return out
}

/** 自定义条目（按设置顺序），供设置页与上限提示使用 */
export function customRegionTypeEntries(entries: readonly RegionTypeEntry[]): RegionTypeEntry[] {
  return entries.filter((entry) => !isBuiltinRegionType(entry.id))
}

export function findRegionTypeEntry(id: string, entries: readonly RegionTypeEntry[]): RegionTypeEntry | null {
  for (const entry of entries) if (entry.id === id) return entry
  return null
}

/* --------------------------------------------------------------- 解析 */

/**
 * 未知类型的回退参数。
 *
 * 刻意**不是**隐形也不是随便挑一个内置色：它要让人看出"这里有东西，但本机没有对应定义"，
 * 同时不能与任何一种定义混淆。不透明度/边框与内置同量级，所以形状仍然看得清。
 */
export const FALLBACK_REGION_TYPE_PARAMS: RegionTypeParams = {
  color: '#9aa4ad',
  opacity: DEFAULT_REGION_OPACITY,
  borderColor: null,
  borderWidth: DEFAULT_REGION_BORDER_WIDTH,
  borderDash: [12, 8],
}

/**
 * 三级回退：内置 → 自定义 → 未知。**永不返回 null**。
 *
 * 绘制层每帧都会问它，任何"这里没有样式"的分支都会变成"某个区域突然画不出来"；
 * 而解析层读到未知 ID 是**必然**会发生的（别的库、别的版本、用户删掉定义）。
 */
export function resolveRegionType(id: RegionType, entries: readonly RegionTypeEntry[] = []): ResolvedRegionType {
  if (isBuiltinRegionType(id)) {
    const entry = findRegionTypeEntry(id, entries)
    return {
      id,
      label: REGION_TYPE_STYLES[id].label,
      params: entry ? entry.params : factoryRegionTypeParams(id),
      builtin: true,
      unknown: false,
    }
  }
  const entry = findRegionTypeEntry(id, entries)
  if (entry !== null) return { ...entry, builtin: false, unknown: false }
  return {
    id,
    label: `未知（${id}）`,
    params: FALLBACK_REGION_TYPE_PARAMS,
    builtin: false,
    unknown: true,
  }
}

/** ID → 显示名（工具条、图例、Base 行、状态报告都用它） */
export function regionTypeLabelOf(id: string, entries: readonly RegionTypeEntry[] = []): string {
  return resolveRegionType(id, entries).label
}

/**
 * 颜色 → 显示名（**只有旧区域用得上**）。
 *
 * 升级前的区域没有 `type`，颜色就是它的身份：能对上某个类型当前的颜色就报它的名字，
 * 否则给一个通用名「区域」。语义与升级前的 `resolveRegionPresets` 完全一致
 * （比的是**当前设置里的颜色**），因此老地图的图例标签一字不变。
 */
export function regionLabelForColor(color: string, entries: readonly RegionTypeEntry[] = []): string {
  const target = canonicalColor(color)
  for (const entry of entries) {
    if (canonicalColor(entry.params.color) === target) return entry.label
  }
  // 目录为空（没有设置上下文，例如纯函数单测或旧调用方）时退回**出厂**颜色：
  // 那是"当前设置"在那种情况下唯一合理的替身。
  //
  // ⚠️ 目录非空时**不**做这一层回退：用户把某个类型的颜色改掉之后，老区域那个旧颜色
  // 就不再对应任何类型了 —— 升级前这时显示的是通用名「区域」，而"悄悄拿出厂色兜底"
  // 会让标签与用户当前的设置不符（他改掉了绿色，图例却还说那是「王国」）。
  if (entries.length === 0) {
    for (const id of BUILTIN_REGION_TYPES) {
      if (canonicalColor(REGION_TYPE_STYLES[id].color) === target) return REGION_TYPE_STYLES[id].label
    }
  }
  return '区域'
}

/** 绘制层用的区域样式（边框色已经把"跟随填充色"解析掉） */
export interface ResolvedRegionStyle {
  type: string
  label: string
  color: string
  opacity: number
  borderColor: string
  borderWidth: number
  borderDash: number[]
}

/**
 * 解析成绘制层用的样式。
 *
 * 这是**唯一**的区域样式解析入口：填充色、不透明度、边框色、边框宽、边框虚线都在这里定下来，
 * 之后没有任何地方再读设置里的第二份值。
 */
export function resolvedRegionStyle(id: RegionType, entries: readonly RegionTypeEntry[] = []): ResolvedRegionStyle {
  const resolved = resolveRegionType(id, entries)
  const { params } = resolved
  return {
    type: resolved.id,
    label: resolved.label,
    color: params.color,
    opacity: params.opacity,
    // 升级前的行为就是"没写边框色 = 用填充色"，这里把它定格成同一个结果
    borderColor: params.borderColor ?? params.color,
    borderWidth: params.borderWidth,
    borderDash: [...params.borderDash],
  }
}

/** 新画区域时的默认类型（缺省即内置第一个「王国」） */
export function defaultRegionTypeId(): string {
  return DEFAULT_REGION_TYPE_ID
}

/**
 * 参数的可读描述（工具条提示、设置页小字）。
 *
 * 与路径那边的 `describePathTypeParams` 同构：用户在一个下拉里要能一眼比较
 * 两种类型"画法上的差别"。
 */
export function describeRegionTypeParams(params: RegionTypeParams): string {
  const parts = [`不透明度 ${params.opacity}`, params.borderWidth > 0 ? `边框 ${params.borderWidth}` : '无边框']
  if (params.borderWidth > 0) {
    parts.push(params.borderDash.length > 0 ? `虚线 ${params.borderDash.join('-')}` : '实线')
    if (params.borderColor !== null) parts.push(`边框色 ${params.borderColor}`)
  }
  return parts.join(' · ')
}

/**
 * 目录**列表**签名：决定工具条下拉要不要重建 DOM。
 *
 * 与 `pathTypeCatalogSignature` 同理：只含"选项有哪些、叫什么"，**不含参数** ——
 * 那些改了只需原地刷新色块与提示，重建 DOM 会把展开状态与焦点一起丢掉。
 */
export function regionTypeCatalogSignature(entries: readonly RegionTypeEntry[]): string {
  return entries.map((entry) => `${entry.id}|${entry.label}`).join(';')
}

/* --------------------------------------------------------------- 编辑 */

export interface RegionTypePatch {
  label?: unknown
  color?: unknown
  opacity?: unknown
  borderColor?: unknown
  borderWidth?: unknown
  borderDash?: unknown
}

/**
 * 对一条已存在的类型应用"补丁"。
 *
 * 只接受补丁而不是整条替换：`id` 不在补丁里 —— 改 ID 等于把地图文件里已有的区域
 * 指向另一个类型，那不是编辑而是数据迁移。内置类型的显示名同样不可改。
 */
export function applyRegionTypePatch(
  entry: RegionTypeEntry,
  patch: RegionTypePatch,
): { ok: true; entry: RegionTypeEntry } | { ok: false; problem: string } {
  if (patch.borderDash !== undefined) {
    const problem = describePathDashProblem(patch.borderDash)
    if (problem !== null) return { ok: false, problem }
  }
  const fallback = isBuiltinRegionType(entry.id) ? factoryRegionTypeParams(entry.id) : customRegionTypeParams()
  const merged: Record<string, unknown> = { ...entry.params }
  for (const key of ['color', 'opacity', 'borderColor', 'borderWidth', 'borderDash'] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key]
  }
  return {
    ok: true,
    entry: {
      ...entry,
      label: isBuiltinRegionType(entry.id) ? entry.label : normalizeRegionTypeLabel(patch.label ?? entry.label, entry.id),
      params: normalizeRegionTypeParams(merged, fallback),
    },
  }
}

/** 新建一条自定义类型前的自检（设置页保存前用它决定"能不能收"） */
export function validateCustomRegionTypeInput(input: {
  id: unknown
  label?: unknown
  color?: unknown
  opacity?: unknown
  borderColor?: unknown
  borderWidth?: unknown
  borderDash?: unknown
}): { ok: true; entry: RegionTypeEntry } | { ok: false; problem: string } {
  const id = normalizeRegionTypeId(input.id)
  if (id === null) return { ok: false, problem: regionTypeIdProblem(input.id) ?? 'ID 不合法' }
  if (input.borderDash !== undefined) {
    const problem = describePathDashProblem(input.borderDash)
    if (problem !== null) return { ok: false, problem }
  }
  const params = normalizeRegionTypeParams(
    {
      color: input.color,
      opacity: input.opacity,
      borderColor: input.borderColor,
      borderWidth: input.borderWidth,
      borderDash: input.borderDash,
    },
    customRegionTypeParams(),
  )
  return { ok: true, entry: { id, label: normalizeRegionTypeLabel(input.label, id), params } }
}

/* --------------------------------------------------------- 恢复 / 判读 */

/**
 * 「恢复出厂样式」：把**内置**类型的参数恢复成工厂值，**不动自定义类型**。
 *
 * 自定义类型是用户建的数据（像自定义地形一样），不是"样式偏好" ——
 * 顺手删掉是不可逆的。
 */
export function resetRegionTypeStyles(entries: readonly RegionTypeEntry[]): RegionTypeEntry[] {
  return entries.map((entry) =>
    isBuiltinRegionType(entry.id) ? { ...entry, params: factoryRegionTypeParams(entry.id) } : entry,
  )
}

/** 内置类型的参数是否全部等于工厂值（设置页据此显示"已改动"） */
export function isDefaultRegionTypeStyles(entries: readonly RegionTypeEntry[]): boolean {
  return BUILTIN_REGION_TYPES.every((id) => {
    const entry = findRegionTypeEntry(id, entries)
    if (entry === null) return false
    return sameRegionTypeParams(entry.params, factoryRegionTypeParams(id))
  })
}

/**
 * 旧字段 `regionColors` 的镜像值（长度固定 = 内置类型数，下标一一对应）。
 *
 * 它**不再是渲染依据**（渲染一律走目录），保留它只是为了两件事：
 * 1. 写回 `data.json` 时不让"同一份颜色"在两处自相矛盾；
 * 2. 用户回退到旧版插件时仍然看到自己改过的颜色。
 */
export function regionColorsFromEntries(entries: readonly RegionTypeEntry[]): string[] {
  return BUILTIN_REGION_TYPES.map((id) => {
    const entry = findRegionTypeEntry(id, entries)
    return entry ? entry.params.color : REGION_TYPE_STYLES[id].color
  })
}
