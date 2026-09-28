/**
 * 海拔 / 深度的单位与标定 —— **纯函数模块，不 import obsidian**。
 *
 * 背景（用户 2026-09-27 定的）：**深度就是海拔的表示形式**，所以全项目只有一个量：
 *
 * - `depth`：**0 = 海平面，正 = 向下（深度），负 = 向上（海拔）**；
 * - 文件里只存**一个权威值**，单位由地图级标定里的 `unit` 声明（缺省米）——
 *   "换显示单位"只是换**读法**，一个字节都不写盘；
 * - **最高高度 / 最深深度由用户填**，它们决定"相对值 0–1"锚在哪；
 *   **没填就是未标定**，这时拒绝用相对值读写，而不是拿编造的尺度凑数。
 *
 * 为什么相对值要"算"而不是"存两份"：同时存 `depth` 与 `rel` 会互相矛盾（手改了一个、
 * 迁移只改了一个），而"谁赢"没有天然答案。算出来的好处是**定义以后可以改，文件不用动**。
 *
 * 设计草案：`.trae/documents/温度带与深度分层-设计草案.md` §2.2。
 */

/** 文件里权威值的单位。要支持更多单位（英尺…）就在这里加 */
export type ElevationStorageUnit = 'm' | 'km'
/** 界面上的展示单位。`rel` 需要标定才能算 */
export type DepthDisplayUnit = 'm' | 'km' | 'rel'

export interface ElevationCalibration {
  /** 权威值（以及下面两个标定值）的单位；缺省 `'m'` */
  unit: ElevationStorageUnit
  /** 最深深度（**正数**，与 `unit` 同单位）；`null` = 未填 */
  maxDepth: number | null
  /** 最高高度（**正数**，与 `unit` 同单位）；`null` = 未填 */
  maxHeight: number | null
}

export const DEFAULT_ELEVATION_CALIBRATION: ElevationCalibration = {
  unit: 'm',
  maxDepth: null,
  maxHeight: null,
}

/** 相对值保留几位小数（展示用；不参与存储） */
export const RELATIVE_DECIMALS = 2

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 把任意输入收敛成标定。
 *
 * - 单位只认 `'m'` / `'km'`，其它一律回落成米；
 * - `maxDepth` / `maxHeight` 必须是**有限且非负**的数，否则记 `null`（= 未填）
 *   —— 负的"最深深度"没有意义，静默取绝对值只会让用户看不懂自己填的是什么；
 * - 0 是合法值（"这个世界没有水下"），与 `null`（没填）是两件不同的事。
 */
export function normalizeElevationCalibration(raw: unknown): ElevationCalibration {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    unit: source.unit === 'km' ? 'km' : 'm',
    maxDepth: finiteOrNull(source.maxDepth),
    maxHeight: finiteOrNull(source.maxHeight),
  }
}

/**
 * 两份标定是否等价（`null` = 没有这一段）。
 *
 * 用途与 `cellsEqual` / `sameObjectFieldValue` 同一口径：**判断"这次改动算不算一次变化"**。
 * 等价时不该产生历史条目 —— 否则用户点两次"保存"就会在撤销栈里多出一条空条目。
 */
export function sameCalibration(
  a: ElevationCalibration | null,
  b: ElevationCalibration | null,
): boolean {
  if (a === null || b === null) return a === b
  return a.unit === b.unit && a.maxDepth === b.maxDepth && a.maxHeight === b.maxHeight
}

/**
 * 是否标定到"能算相对值"的程度。
 *
 * 要求两端之和大于 0：两个都是 0 等于没有量程，相对值无定义（会除零）。
 * 只填一端也可以（例如只填最深、最高记 0）—— 那是"这个世界只有水下"。
 */
export function isCalibrated(calibration: ElevationCalibration): boolean {
  const depth = calibration.maxDepth
  const height = calibration.maxHeight
  if (depth === null || height === null) return false
  return depth + height > 0
}

/** 文件里的值 → 米（标定的三个字段都用同一种单位，所以换算率一致） */
export function toMeters(value: number, calibration: ElevationCalibration): number {
  return calibration.unit === 'km' ? value * 1000 : value
}

/** 米 → 文件里的值（写盘前统一走这里，保证"落盘的永远是权威值"） */
export function fromMeters(meters: number, calibration: ElevationCalibration): number {
  return calibration.unit === 'km' ? meters / 1000 : meters
}

function calibrationInMeters(calibration: ElevationCalibration): { maxDepth: number; maxHeight: number } | null {
  if (!isCalibrated(calibration)) return null
  return {
    maxDepth: toMeters(calibration.maxDepth!, calibration),
    maxHeight: toMeters(calibration.maxHeight!, calibration),
  }
}

/**
 * 米 → 相对值 0–1：**0 = 最深点、1 = 最高点**。
 *
 * `rel = (maxDepth − depth) / (maxDepth + maxHeight)`，于是海平面落在
 * `maxDepth / (maxDepth + maxHeight)`。**不强行把海平面对称到 0.5**：
 * 海平面在哪本来就是这张地图的事实（一片大海的地图，海平面本来就该偏一侧）。
 *
 * 未标定时返回 `null` —— 调用方应当显示"需要先设置海拔标定"，而不是给一个假数字。
 */
export function relativeOf(meters: number, calibration: ElevationCalibration): number | null {
  const range = calibrationInMeters(calibration)
  if (range === null) return null
  const span = range.maxDepth + range.maxHeight
  const relative = (range.maxDepth - meters) / span
  return Math.max(0, Math.min(1, relative))
}

/** 相对值 0–1 → 米（`relativeOf` 的逆；未标定返回 `null`） */
export function metersFromRelative(relative: number, calibration: ElevationCalibration): number | null {
  const range = calibrationInMeters(calibration)
  if (!Number.isFinite(relative)) return null
  if (range === null) return null
  return range.maxDepth - relative * (range.maxDepth + range.maxHeight)
}

/** 米 → 展示单位下的读数（`rel` 未标定返回 `null`） */
export function toDisplay(
  meters: number,
  unit: DepthDisplayUnit,
  calibration: ElevationCalibration,
): number | null {
  if (!Number.isFinite(meters)) return null
  if (unit === 'rel') return relativeOf(meters, calibration)
  return unit === 'km' ? meters / 1000 : meters
}

/**
 * 展示单位下的读数 → 米。
 *
 * 输入侧也走这里：用户在面板上可以用任何单位输入，**落盘前统一换算成米**。
 * `rel` 未标定返回 `null`（调用方应当拒绝写入并说明原因，而不是编一个尺度）。
 */
export function fromDisplay(
  value: number,
  unit: DepthDisplayUnit,
  calibration: ElevationCalibration,
): number | null {
  if (!Number.isFinite(value)) return null
  if (unit === 'rel') return metersFromRelative(value, calibration)
  return unit === 'km' ? value * 1000 : value
}

/** 展示成一位不拖尾巴的数字：`3000`、`3.5`、`0.72`（整数位上的 0 绝不能被吃掉） */
function trimNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals)
  if (!fixed.includes('.')) return fixed
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 给人看的读数：**措辞按符号走**（文件里始终只有一个字段）。
 *
 * - 负值 → `海拔 1200 m`；正值 → `深度 3000 m`；0 → `海平面`；
 * - 未标定又选了相对值 → `未标定`（调用方另外用 `describeUnitProblem` 给可操作的提示）。
 */
export function formatElevation(
  meters: number,
  unit: DepthDisplayUnit,
  calibration: ElevationCalibration,
): string {
  if (!Number.isFinite(meters)) return '—'
  if (unit === 'rel') {
    const relative = relativeOf(meters, calibration)
    return relative === null ? '未标定' : trimNumber(relative, RELATIVE_DECIMALS)
  }
  const unitLabel = unit === 'km' ? 'km' : 'm'
  const reading = unit === 'km' ? meters / 1000 : meters
  const decimals = unit === 'km' ? 2 : 0
  const text = `${trimNumber(Math.abs(reading), decimals)} ${unitLabel}`
  if (Math.abs(reading) < (unit === 'km' ? 0.0005 : 0.5)) return `海平面（${text}）`
  return reading < 0 ? `海拔 ${text}` : `深度 ${text}`
}

/**
 * 短读数（**不带单位后缀、不带"海拔/深度"措辞**）：给密铺在格上的数值文字与图例刻度用。
 *
 * 与 `formatElevation` 的分工是刻意的：那一句是"给人读的完整描述"（`海拔 1200 m`），
 * 用在一格一个字的画布上会糊成一片；这里只给数字，单位由**图例标题**统一说明。
 *
 * - `m` → `3000` / `-1200`；`km` → `3` / `-1.2`；`rel` → `0.33`；
 * - `rel` 未标定 → `未标定`（调用方应当另外说明原因，见 `describeUnitProblem`）。
 */
export function formatDepthReading(
  meters: number,
  unit: DepthDisplayUnit,
  calibration: ElevationCalibration,
): string {
  if (!Number.isFinite(meters)) return '—'
  if (unit === 'rel') {
    const relative = relativeOf(meters, calibration)
    return relative === null ? '未标定' : trimNumber(relative, RELATIVE_DECIMALS)
  }
  const reading = unit === 'km' ? meters / 1000 : meters
  // 权威值按"米取整"的约定量化（见设计草案 §2.1），所以米这一档不显示小数
  return trimNumber(reading, unit === 'km' ? 2 : 0)
}

/**
 * 这个展示单位现在能不能用；不能用就给出**可操作**的原因（而不是一个空数字）。
 *
 * 只在 `rel` 未标定时返回一句提示，其余情况返回 `null`。
 */
export function describeUnitProblem(unit: DepthDisplayUnit, calibration: ElevationCalibration): string | null {
  if (unit !== 'rel') return null
  if (isCalibrated(calibration)) return null
  return '相对值需要先设置海拔标定（最高高度 / 最深深度）'
}

/** 标定的一句话描述（报告面板与提示用） */
export function formatCalibration(calibration: ElevationCalibration): string {
  const unitLabel = calibration.unit === 'km' ? 'km' : 'm'
  if (!isCalibrated(calibration)) {
    const missing = calibration.maxDepth === null ? '最深深度' : '最高高度'
    return `未标定（还差${missing}）`
  }
  return `最深 ${trimNumber(calibration.maxDepth!, 2)} ${unitLabel} · 最高 ${trimNumber(
    calibration.maxHeight!,
    2,
  )} ${unitLabel}`
}

/* ------------------------------------------------------------------ 输入解析 / 预览 */

/** 输入框里的一格读数：留空 = 未填；负数 / 非数字 = 非法 */
export type ParsedCalibrationInput = { ok: true; value: number | null } | { ok: false; problem: string }

/**
 * 解析标定弹窗里的一个数字输入。
 *
 * 三条口径与设置页其它数字输入一致：
 * - **留空 = 不填**（不是 0 —— "最深就是海平面"与"不知道"是两件事）；
 * - 非数字**拒绝并说明原因**，不悄悄当成 0；
 * - 负数拒绝：`maxDepth` / `maxHeight` 是"有多深 / 有多高"，负号只会让用户看不懂自己填了什么。
 */
export function parseCalibrationInput(raw: string, label: string): ParsedCalibrationInput {
  const text = raw.trim()
  if (text.length === 0) return { ok: true, value: null }
  const value = Number(text)
  if (!Number.isFinite(value)) return { ok: false, problem: `${label}必须是一个数字（留空 = 不填）` }
  if (value < 0) return { ok: false, problem: `${label}要填正数（它表示"有多深 / 有多高"）` }
  return { ok: true, value }
}

/**
 * 换算预览表：三个锚点（最深点 / 海平面 / 最高点）在三种展示单位下分别读作什么。
 *
 * 用 `formatDepthReading` 而不是自己拼字符串：那就是画布与图例用的**同一个**格式化函数，
 * 于是"预览里看到 0.73、画布上却是别的数字"这种两处口径的问题不会出现。
 */
export function previewCalibrationTable(calibration: ElevationCalibration): string {
  if (!isCalibrated(calibration)) {
    return '还差一端：最深深度与最高高度都填上（且不全为 0），相对值才有定义。\n米 / 千米的读数不受影响。'
  }
  const rows: Array<[string, number]> = [
    ['最深点', calibration.maxDepth!],
    ['海平面', 0],
    ['最高点', -calibration.maxHeight!],
  ]
  const header = padColumn('', 8) + padColumn('米', 12) + padColumn('千米', 12) + '相对值'
  const lines = rows.map(([label, meters]) => {
    const m = formatDepthReading(meters, 'm', calibration)
    const km = formatDepthReading(meters, 'km', calibration)
    const rel = formatDepthReading(meters, 'rel', calibration)
    return padColumn(label, 8) + padColumn(m, 12) + padColumn(km, 12) + rel
  })
  return [header, ...lines].join('\n')
}

/** 按显示宽度补空格（全角字符算两列，避免表格错位） */
function padColumn(text: string, width: number): string {
  let display = 0
  for (const char of text) display += char.charCodeAt(0) > 0x2e80 ? 2 : 1
  return text + ' '.repeat(Math.max(0, width - display))
}