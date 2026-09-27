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