/**
 * 格选择（**多格集合**）的纯函数：集合运算、规则筛选、连通扩展、统计。
 * **不 import obsidian**，于是"选出来的对不对"能被单测钉住。
 *
 * 为什么单独一个模块（而不是塞进 `MapEditor`）：施工文件 §C.2 把三件事分开写死了 ——
 * **规则只做逐格谓词**、**动作负责集合运算**、**连通扩展是动作**。
 * 本模块就是"动作"那一层：它是纯函数，界面 / 手势 / 侧栏都只是调用方。
 *
 * 选择**不进撤销栈**（§C.3）：它是"我正在看哪些格"，不是对地图的修改。
 * 于是这里的函数既不产生 op，也不碰 history。
 */

import { cellKey, parseCellKey, type GridSpec, type Point } from '../core/hex.ts'
import { AXIAL_NEIGHBORS } from '../core/hexEdges.ts'
import type { MapDocument, TerrainCell } from '../data/mapDocument.ts'
import { matchesGroup, type RuleGroup, type SelectionRuleContext } from './selectionRules.ts'
import { iterateCells, visibleCellBounds } from './hexGrid.ts'
import { DEFAULT_ELEVATION_CALIBRATION } from './elevationUnits.ts'
import { formatFieldReading, OVERLAY_FIELDS, overlayUnitSuffix, type OverlayStyles } from './overlayFields.ts'
import { SELECTION_TEXT } from '../ui/strings.ts'

/** 一份格选择：**有序去重的格键**（`"q_r"`）。排序后存放 → 断言与缓存都稳定 */
export type CellSelection = readonly string[]

/** 把任意格键列表收敛成规范形式（去重 + 按 r 再 q 排序） */
export function normalizeSelection(keys: readonly string[]): CellSelection {
  const unique = new Set<string>()
  for (const key of keys) {
    if (parseCellKey(key) !== null) unique.add(key)
  }
  return [...unique].sort(compareCellKeys)
}

/** 格键排序：先 r 后 q（与地形序列化同一条，Git diff 也稳） */
export function compareCellKeys(a: string, b: string): number {
  const left = parseCellKey(a)
  const right = parseCellKey(b)
  if (left === null || right === null) return a.localeCompare(b)
  return left.r !== right.r ? left.r - right.r : left.q - right.q
}

/** 替换选择（框选 / 单选 / 规则"替换"都走它） */
export function replaceSelection(keys: readonly string[]): CellSelection {
  return normalizeSelection(keys)
}

/** 并入选择（Shift 加选 / 规则"并入"） */
export function addToSelection(current: CellSelection, keys: readonly string[]): CellSelection {
  return normalizeSelection([...current, ...keys])
}

/** 移出选择（Alt 取消单格 / 局部取消一片 / 规则"移出"）——**不是集合取补** */
export function removeFromSelection(current: CellSelection, keys: readonly string[]): CellSelection {
  const drop = new Set(keys)
  return current.filter((key) => !drop.has(key))
}

/** 两份选择是不是同一份（同长度 + 逐项相同；两份都已规范化，因此不必再做集合比较） */
export function sameCellSelection(a: CellSelection, b: CellSelection): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

/** 手势与筛选器共用的三种集合运算（§C.1 的 `Shift` 加选 / `Alt` 取消 / 默认替换） */
export type SelectionOperation = 'replace' | 'add' | 'remove'

/** 按三种集合运算之一，把 `keys` 合进 `base`（纯函数，手势与侧栏共用同一份语义） */
export function applySelectionOperation(
  base: CellSelection,
  keys: readonly string[],
  operation: SelectionOperation,
): CellSelection {
  if (operation === 'add') return addToSelection(base, keys)
  if (operation === 'remove') return removeFromSelection(base, keys)
  return replaceSelection(keys)
}

/**
 * **矩形框选**：只收「格心落在矩形里、且这一格在地图文件里存在」的格。
 *
 * 两条口径写死：
 * 1. **判据是格心**（不是"与矩形相交"）—— 与缩放无关、可预测；用相交判定会让"框到了但看起来没框到"。
 * 2. **只收地图里已有的格**：空区域里的格没有数据，收进选择只会让"整批编辑"作用于不存在的东西，
 *    也会让信息卡上那行"N 格已不存在"（生命周期用的）被误读成"框了 10000 格"。
 *    给空区域加数据是**笔刷**的职责（§E），不是框选。
 */
export function cellsInRect(document: MapDocument, grid: GridSpec, a: Point, b: Point): CellSelection {
  const bbox = {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  }
  const keys: string[] = []
  // `visibleCellBounds` 给的是**过近似**（六边形在 q/r 空间里是斜的），所以下面还要按格心逐格判一次
  for (const cell of iterateCells(grid, visibleCellBounds(grid, bbox, 0))) {
    if (cell.x < bbox.minX || cell.x > bbox.maxX || cell.y < bbox.minY || cell.y > bbox.maxY) continue
    const key = cellKey(cell.q, cell.r)
    if (document.terrain[key] === undefined) continue
    keys.push(key)
  }
  return normalizeSelection(keys)
}

/**
 * 在**当前选择内**再筛（规则"在当前选择内"那条）——交集。
 *
 * 施工文件 §C.2 末尾特意指出："当前选择内"不是逐格谓词（它依赖当前选择），
 * 所以它是**动作**而不是规则；这里就是那个动作的落点。
 */
export function intersectSelection(
  document: MapDocument,
  current: CellSelection,
  accept: (key: string, cell: TerrainCell | undefined) => boolean,
): CellSelection {
  return current.filter((key) => accept(key, document.terrain[key]))
}

/** 规则作用的三种集合运算（界面上的三个按钮） */
export type RuleApplyMode = 'replace' | 'add' | 'remove'

/**
 * 把一组规则**应用到地图上所有格**（只遍历文件里真实存在的格 —— 空白区不在其中）。
 *
 * 三种动作（§C.2 的分工：规则只判断，动作做集合运算）：
 * - `replace`：命中的格成为新选择；
 * - `add`：并入选中的格；
 * - `remove`：把命中的格移出选择（"按规则取消"）。
 */
export function applyRuleToSelection(
  current: CellSelection,
  document: MapDocument,
  group: RuleGroup,
  mode: RuleApplyMode,
  context?: SelectionRuleContext,
): CellSelection {
  const hits = ruleHits(document, group, context)
  if (mode === 'add') return addToSelection(current, hits)
  if (mode === 'remove') return removeFromSelection(current, hits)
  return replaceSelection(hits)
}

/**
 * 规则**命中了哪些格**（不改任何状态）。
 *
 * 为什么单独抽出来：对话框顶部那行"按这些条件会选中 N 格"必须与"真的应用一次"给出同一个数，
 * 而最稳的做法就是**两者走同一个函数**（INSUE-003 的验收第 2 条：数字与实际应用结果一致）。
 * 应用（`applyRuleToSelection`）改的是集合运算，命中判定只有这一处 —— 复制一份循环迟早分叉。
 *
 * 只遍历文件里**真实存在**的格（空白区不在其中），并且跳过损坏的键（与绘制层同一条纪律）。
 */
export function ruleHits(document: MapDocument, group: RuleGroup, context?: SelectionRuleContext): CellSelection {
  const hits: string[] = []
  for (const [key, cell] of Object.entries(document.terrain)) {
    if (parseCellKey(key) === null) continue
    if (matchesGroup(cell, group, context)) hits.push(key)
  }
  return normalizeSelection(hits)
}

/**
 * **同地形连通扩展**（"以选择为种子，按同地形连通扩展"）—— 施工文件 §C.3 第 9 条。
 *
 * 语义写死：从每个种子出发做六邻域 flood fill，**只走"与种子同一种地形"的格**
 * （地形相同才算连通；没有地形的格不参与 —— 它们没有"同地形"可言）。
 * 已有的选择**并入**结果（不替换）：用户的直觉是"在这个选择基础上再扩到整片连通区"。
 *
 * 为什么它是动作而不是规则：规则是逐格谓词，而它要**邻域遍历**（§C.2 的分工）。
 */
export function expandSelectionByTerrain(document: MapDocument, seeds: CellSelection): CellSelection {
  const result = new Set<string>(seeds)

  for (const seed of seeds) {
    const startCell = document.terrain[seed]
    const terrain = typeof startCell?.t === 'string' ? startCell.t : undefined
    if (terrain === undefined) continue
    // ⚠️ `visited` 必须**每个种子一份**：跨种子共用时，前一个种子探测过的异地形格会被标成"已访问"，
    // 后一个种子于是走不进自己的那片连通区（写单测时抓到过：forest 与 water 两个种子各扩一半）
    const visited = new Set<string>([seed])
    const queue: string[] = [seed]
    while (queue.length > 0) {
      const key = queue.pop()!
      const axial = parseCellKey(key)
      if (axial === null) continue
      result.add(key)
      for (const [dq, dr] of AXIAL_NEIGHBORS) {
        const nextKey = cellKey(axial.q + dq, axial.r + dr)
        if (visited.has(nextKey)) continue
        visited.add(nextKey)
        const nextCell = document.terrain[nextKey]
        if (nextCell?.t !== terrain) continue
        queue.push(nextKey)
      }
    }
  }
  return normalizeSelection([...result])
}

/* ------------------------------------------------------------------ 统计（选择信息卡） */

/** 选择信息卡要显示的一切（结构化的，界面只负责排版） */
export interface SelectionSummary {
  /** 选择里的格数（含"已不存在"的那些） */
  count: number
  /** 其中**地图文件里已经找不到**的格数（重载 / 撤销之后可能出现，§C.3 生命周期） */
  missing: number
  /** 坐标范围（q / r 的最小与最大）；没有格时为 `null` */
  range: { minQ: number; maxQ: number; minR: number; maxR: number } | null
  /** 包含的地形种类（去重、按出现顺序） */
  terrains: Array<{ id: string; count: number }>
  /** 每个数值字段：众数 / 平均数 / 有几格没有数据 / 有几格是**默认值兜底** */
  fields: SelectionFieldStat[]
  /** 生物群系类型清单（"各有哪些"，不是个数 —— 用户明确要求） */
  biomes: string[]
}

export interface SelectionFieldStat {
  /** 字段键（`temp` / `depth`） */
  key: string
  label: string
  unit: string
  /** **众数**（出现最多的值）；并列取**值较小**者（可预测，§C.4 写死） */
  mode: number | null
  /** **平均数**（只统计有该字段值的格） */
  average: number | null
  /** 有几格**没有**这个字段的值 */
  missing: number
  /** 其中"没有值、但用了地图默认值"的格数（§B：兜底格要单独说明） */
  fallback: number
}

function modeOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: number | null = null
  let bestCount = -1
  for (const [value, count] of counts) {
    // 并列取**值较小**者：可预测（否则结果的先后取决于 Map 的插入顺序）
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

function averageOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

/**
 * 统计一份选择（选择信息卡的数据源）。
 *
 * 三条口径（施工文件 §C.4 写死）：
 * 1. **众数 / 平均数只统计有该字段值的格**，并另报"有几格没有数据"；
 * 2. **兜底格单独计数**（"其中 M 格用的是默认值"）—— 否则"颜色 = 有数据"的直觉会被打破（§B.3）；
 * 3. 不在文件里的格（`missing`）不计入任何统计，只在卡片上说明"其中 N 格已不存在"。
 */
export function summarizeSelection(document: MapDocument, selection: CellSelection): SelectionSummary {
  const defaults = document.dataDefaults
  const terrainCounts = new Map<string, number>()
  const biomeSet = new Set<string>()
  const valuesByField = new Map<string, number[]>()
  const missingByField = new Map<string, number>()
  const fallbackByField = new Map<string, number>()
  let missingCells = 0
  let minQ = Number.POSITIVE_INFINITY
  let maxQ = Number.NEGATIVE_INFINITY
  let minR = Number.POSITIVE_INFINITY
  let maxR = Number.NEGATIVE_INFINITY

  for (const key of selection) {
    const axial = parseCellKey(key)
    if (axial === null) continue
    const cell = document.terrain[key]
    if (cell === undefined) {
      missingCells += 1
      continue
    }
    minQ = Math.min(minQ, axial.q)
    maxQ = Math.max(maxQ, axial.q)
    minR = Math.min(minR, axial.r)
    maxR = Math.max(maxR, axial.r)
    if (typeof cell.t === 'string') terrainCounts.set(cell.t, (terrainCounts.get(cell.t) ?? 0) + 1)
    if (typeof cell.biome === 'string' && cell.biome.length > 0) biomeSet.add(cell.biome)
    for (const spec of OVERLAY_FIELDS) {
      if (!spec.numeric) continue
      const value = spec.read(cell)
      if (value !== undefined) {
        const list = valuesByField.get(spec.cellKey)
        if (list === undefined) valuesByField.set(spec.cellKey, [value])
        else list.push(value)
        continue
      }
      missingByField.set(spec.cellKey, (missingByField.get(spec.cellKey) ?? 0) + 1)
      if (defaultValueFor(defaults, spec.cellKey) !== undefined) {
        fallbackByField.set(spec.cellKey, (fallbackByField.get(spec.cellKey) ?? 0) + 1)
      }
    }
  }

  const fields: SelectionFieldStat[] = OVERLAY_FIELDS.filter((spec) => spec.numeric).map((spec) => {
    const values = valuesByField.get(spec.cellKey) ?? []
    return {
      key: spec.cellKey,
      label: spec.label,
      unit: spec.unit,
      mode: modeOf(values),
      average: averageOf(values),
      missing: missingByField.get(spec.cellKey) ?? 0,
      fallback: fallbackByField.get(spec.cellKey) ?? 0,
    }
  })

  return {
    count: selection.length,
    missing: missingCells,
    range:
      selection.length === 0 || !Number.isFinite(minQ)
        ? null
        : { minQ, maxQ, minR, maxR },
    terrains: [...terrainCounts.entries()].map(([id, count]) => ({ id, count })),
    fields,
    biomes: [...biomeSet].sort(),
  }
}

/** 兜底值（与 `dataDefaults.defaultFor` 同源，这里为避免多一层 import 直接读） */
function defaultValueFor(defaults: MapDocument['dataDefaults'], key: string): number | undefined {
  const value = defaults?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 单格详情的一行（信息卡排版用） */
export interface CellDetailRow {
  label: string
  value: string
}

/**
 * 单格的**数据读数**（温度 / 深度 / 生物群系）—— 侧栏「数据显示」与画布信息卡共用这一份。
 *
 * 为什么要单独一个函数（§2.6 定的分工落点）：侧栏是"选择"的家、卡片只做**进行中**的事，
 * 于是同一行读数会在两处出现。两处各算一遍必然分叉 —— 这项目已经在"读数"上踩过一次
 * （配色 / 展示单位改了口径而某一处没跟上，§5.65）。所以读数只在这里算，两边都调它。
 *
 * 没有的字段写「未填」，**不猜 0**（0 ℃ / 海平面都是合法读数，猜出来的 0 与"没量过"是两回事）。
 */
export function describeCellReadings(
  document: MapDocument,
  key: string,
  styles: OverlayStyles,
): CellDetailRow[] {
  const cell = document.terrain[key]
  const calibration = document.elevation ?? DEFAULT_ELEVATION_CALIBRATION
  const rows: CellDetailRow[] = []
  for (const spec of OVERLAY_FIELDS) {
    if (!spec.numeric) continue
    const value = spec.read(cell)
    const style = styles[spec.id]
    // 后缀走 `overlayUnitSuffix`（与图例刻度同一条）：换成千米之后卡片上也是 `5 km`，
    // 而不是把字段的权威单位（米）硬拼上去 —— 那会和图例对不上
    rows.push({
      label: spec.label,
      value: value === undefined ? SELECTION_TEXT.unfilled : `${formatFieldReading(spec, value, style, calibration)}${overlayUnitSuffix(spec, style)}`,
    })
  }
  rows.push({ label: '生物群系', value: cell?.biome ?? SELECTION_TEXT.unfilled })
  return rows
}

/**
 * 单格详情（信息卡的"单选"形态）：没有的字段写"未填"，**不猜 0**。
 *
 * 读数走 `formatFieldReading`（与画布 / 图例**同一个**格式化函数），所以"换成千米"之后
 * 卡片上的数字跟着变 —— 两处各写一遍必然分叉（本项目老毛病）。
 */
export function describeCellDetails(
  document: MapDocument,
  key: string,
  styles: OverlayStyles,
): CellDetailRow[] {
  const axial = parseCellKey(key)
  if (axial === null) return [{ label: '格', value: key }]
  const cell = document.terrain[key]
  return [
    { label: '坐标', value: `(${axial.q}, ${axial.r})` },
    { label: '地形', value: cell?.t ?? SELECTION_TEXT.unfilled },
    ...describeCellReadings(document, key, styles),
  ]
}