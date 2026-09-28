/**
 * 数据层的**每格默认值**（地图文件里的 `dataDefaults` 段）—— **纯函数模块，不 import obsidian**。
 *
 * 用户的原话（2026-09-28）："如果有地方没有温度和深度的话就没有渲染，我认为每个格子初始应该自带一个值，
 * 这个定义值就放在定义里面。" —— 于是：**值住在定义里（地图文件），兜底只影响渲染**。
 *
 * 三条口径（施工文件 `DATA-LAYER-PLAN-v5.md` §B）：
 *
 * 1. **兜底覆盖"地图上存在的格"**：画过地形的整片区域都会有颜色；文件里没有的格（空白区）不画
 *    —— 地图是**稀疏**的，"铺满整个六边形范围"要另一套"地图范围"概念，本轮不做；
 * 2. **真值优先**：格上有 `temp` 就用它，没有才用默认值；**文件里的格一个字节都不改**
 *    （所以改默认值是"立刻全图生效"，它就是这张图的基线）；
 * 3. **缺省 = 不兜底**：没有这一段的老地图**逐字节不变**（与 `elevation` 同一条纪律）。
 *
 * 为什么不做成"插件设置"：默认值是**这个世界的事实**（这片大陆的平均气温 15 ℃），
 * 换台机器、换个人打开都该是同一个数；而"要不要显示温度层"才是偏好，住在插件设置里。
 * 同一条分界见 `elevationUnits.ts` 顶部。
 *
 * ⚠️ 键就是字段表里的 `cellKey`（`temp` / `depth`）。本模块**刻意不认识字段表**：
 * 它只做"`Record<string, number>` 的规范化与查询"，于是数据层（`mapDocument`）不必反过来依赖渲染层，
 * 也**不会**因为以后加字段而改这里。"哪些键有效"由两个各自知道的地方把关：
 * 解析时按文档自己的 `KNOWN_CELL_KEYS` 报未知键，弹窗里按字段表列出可编辑的行。
 */

/** 键 = 字段的 `cellKey`（`temp` / `depth`）；值是该字段的**权威单位**下的数（温度 ℃、深度 米） */
export type DataDefaults = Record<string, number>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把任意输入收敛成默认值表。
 *
 * - **只留有限数**：`null` / 字符串 / NaN / Infinity 一律丢掉（"默认值是 NaN"没有意义）；
 * - **不认识的键原样保留**（§5.11：未知值属于用户的数据）—— 它们不会被任何渲染读到，但写回时还在；
 * - **空表返回 `null`**，而不是 `{}`：这是"没有这一段"与"有一个空对象"的分界，
 *   也是 §B.5 那条"清空全部默认值时移除该键"的落地点（文件里不留 `"dataDefaults": {}`）。
 */
export function normalizeDataDefaults(raw: unknown): DataDefaults | null {
  if (!isRecord(raw)) return null
  const out: DataDefaults = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 两份默认值是否等价（`null` = 没有这一段）。
 *
 * 用途与 `sameCalibration` / `cellsEqual` 同一口径：**判断"这次改动算不算一次变化"** ——
 * 等价时不该产生历史条目（否则连点两次保存会在撤销栈里多出一条空条目）。
 * 逐键比较而**不看顺序**：`{"temp":15,"depth":0}` 与 `{"depth":0,"temp":15}` 是同一份。
 */
export function sameDataDefaults(a: DataDefaults | null, b: DataDefaults | null): boolean {
  if (a === null || b === null) return a === b
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => b[key] === a[key])
}

/** 这个字段的兜底值；没有（或坏值）时返回 `undefined` —— 与"缺数据"同一个 `undefined`，调用方不必分两种空 */
export function defaultFor(defaults: DataDefaults | null | undefined, cellKey: string): number | undefined {
  const value = defaults?.[cellKey]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 弹窗与命令面板要显示的一行：字段的键、显示名、权威单位 */
export interface DataDefaultEntry {
  key: string
  label: string
  unit: string
}

/**
 * 一句话描述（命令面板的 `describe` 与弹窗预览共用一条口径）。
 *
 * 只列**已经设了值的字段**；一个都没设时说"未设置（不兜底）"而不是给一行空白 ——
 * "没有这一段"与"设了 0"必须一眼能分清（0 是合法值：海平面、或摄氏 0 度）。
 */
export function describeDataDefaults(defaults: DataDefaults | null, entries: readonly DataDefaultEntry[]): string {
  if (defaults === null) return '未设置（不兜底）'
  const parts: string[] = []
  for (const entry of entries) {
    const value = defaultFor(defaults, entry.key)
    if (value === undefined) continue
    parts.push(`${entry.label} ${formatDefaultValue(value)}${entry.unit}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '未设置（不兜底）'
}

/** 读数：最多两位小数、不拖尾零（与 `formatOverlayValue` 同一口径，但不 import 它以免两处互相牵制） */
function formatDefaultValue(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 默认值里那些**不在字段表里**的键（弹窗用："这几个键本插件不认，已原样保留"） */
export function unknownDefaultKeys(defaults: DataDefaults | null, knownKeys: readonly string[]): string[] {
  if (defaults === null) return []
  const known = new Set(knownKeys)
  return Object.keys(defaults).filter((key) => !known.has(key)).sort()
}

/** 弹窗里的一个输入解析结果 */
export type ParsedDefaultInput = { ok: true; value: number | null } | { ok: false; problem: string }

/**
 * 解析默认值弹窗里的一个数字输入。
 *
 * 三条口径与 `parseCalibrationInput` 一致，只改一处：**负数合法**。
 * 温度可以是负的（-20 ℃ 的冰原），深度也可以是负的（高海拔）——
 * "这个数必须是自然数"那种校验在这里是错的。
 */
export function parseDefaultInput(raw: string, label: string): ParsedDefaultInput {
  const text = raw.trim()
  if (text.length === 0) return { ok: true, value: null }
  const value = Number(text)
  if (!Number.isFinite(value)) return { ok: false, problem: `${label}必须是一个数字（留空 = 不设默认值）` }
  return { ok: true, value }
}