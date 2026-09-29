/**
 * 选择信息卡的**内容模型** —— 纯函数模块（不 import obsidian，可单测）。
 *
 * 施工文件 §C.4 写死了它该显示什么：
 *
 * | 情形 | 显示 |
 * |---|---|
 * | 单选 | 坐标 `(q,r)`、地形、温度、深度、生物群系（没有的字段写"未填"，**不猜 0**） |
 * | 多选 | 总格数 · 坐标范围 · 包含的地形种类 · **温度的众数** · **深度的平均数** · **生物群系清单** |
 *
 * 统计口径（§C.4）：众数 / 平均数**只统计有该字段值的格**，并标注"其中 N 格没有数据"；
 * **兜底格单独说明**（"其中 M 格用的是默认值"）—— 否则"颜色 = 有数据"的直觉会被打破（§B.3）。
 *
 * 为什么单独一个模块：卡片的**排版**是 DOM 的事，而"该显示哪几行、数字怎么念"是纯逻辑。
 * 分成两层之后，"多选时那一行到底写没写清兜底格"能被单测钉住，而不必去 DOM 里翻。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import { DEFAULT_ELEVATION_CALIBRATION, type ElevationCalibration } from './elevationUnits.ts'
import {
  formatFieldReading,
  OVERLAY_FIELDS,
  overlayUnitSuffix,
  type OverlayStyles,
} from './overlayFields.ts'
import { describeCellDetails, type CellDetailRow, type CellSelection, type SelectionSummary } from './selectionSet.ts'

/** 卡片的一行（`label` 是左侧的粗体小标题，`value` 是右侧的读数） */
export type SelectionCardRow = CellDetailRow

export type SelectionCardModel =
  /** 没有选择：卡片**整个不显示**（§F.3：无选择 = 不显示） */
  | { kind: 'empty' }
  /** 单选一格：坐标 / 地形 / 各字段读数 / 生物群系 */
  | { kind: 'cell'; title: string; rows: SelectionCardRow[] }
  /** 多选：统计与清单 */
  | { kind: 'multi'; title: string; rows: SelectionCardRow[] }

export interface SelectionCardInput {
  /** 当前格选择（有序去重的格键） */
  cellSelection: CellSelection
  /** 多选时的统计（`summarizeSelection` 的结果；单选时也给，用于"已不存在"那一行） */
  summary: SelectionSummary | null
  /** 文档（单选详情要读真值；`null` = 还没加载出来，这时卡片只报格数） */
  document: MapDocument | null
  /** 数据层样式（决定读数用米还是千米 —— 与图例、画布**同一个**格式化函数） */
  styles: OverlayStyles
  /** 地形 / 生物群系的显示名解析（由调用方注入，保持本模块纯净） */
  terrainLabel: (id: string) => string
  biomeLabel: (id: string) => string
}

/** 数字读数 + 当前展示单位（与画布 / 图例同一条口径，绝不在这里再拼一次单位） */
function readingOf(
  cellKey: string,
  value: number,
  styles: OverlayStyles,
  calibration: ElevationCalibration | null,
): string {
  const spec = OVERLAY_FIELDS.find((candidate) => candidate.cellKey === cellKey)
  if (spec === undefined) return String(value)
  const suffix = overlayUnitSuffix(spec, styles[spec.id])
  return `${formatFieldReading(spec, value, styles[spec.id], calibration ?? DEFAULT_ELEVATION_CALIBRATION)}${suffix}`
}

/** 众数 / 平均数那一行（含"其中 N 格没有数据 / 其中 M 格用的是默认值"） */
function statRows(summary: SelectionSummary, styles: OverlayStyles, calibration: ElevationCalibration | null): SelectionCardRow[] {
  const rows: SelectionCardRow[] = []
  for (const stat of summary.fields) {
    // 多选用的是**众数 / 平均数**：众数回答"这一片最常见是多少"，平均数回答"平均下来多深"
    const mode = stat.mode === null ? '未填' : readingOf(stat.key, stat.mode, styles, calibration)
    const average = stat.average === null ? '未填' : readingOf(stat.key, stat.average, styles, calibration)
    rows.push({ label: `${stat.label} 众数`, value: mode })
    rows.push({ label: `${stat.label} 平均`, value: average })
    if (stat.missing > 0) {
      // 兜底格要单独说明：否则用户会以为"有颜色 = 有数据"
      const fallback = stat.fallback > 0 ? `，其中 ${stat.fallback} 格用的是默认值` : ''
      rows.push({ label: `${stat.label} 缺数据`, value: `${stat.missing} 格${fallback}` })
    }
  }
  return rows
}

/**
 * 把"当前选择"变成卡片内容。
 *
 * 三种形态的分界就是**格数**（§C.4 只有"单选"与"多选"两栏，没有"选了两个"这种中间态）。
 */
export function buildSelectionCard(input: SelectionCardInput): SelectionCardModel {
  const count = input.cellSelection.length
  if (count === 0) return { kind: 'empty' }

  if (count === 1) {
    const key = input.cellSelection[0]!
    const axial = /^(-?\d+)_(-?\d+)$/.exec(key)
    const title = axial === null ? `格 ${key}` : `格 (${axial[1]}, ${axial[2]})`
    if (input.document === null) return { kind: 'cell', title, rows: [{ label: '格', value: key }] }
    const rows = describeCellDetails(input.document, key, input.styles).map((row) =>
      // 详情里用的是**原始 ID**（纯函数不认识目录）；显示名在这里翻一次
      row.label === '地形' && row.value !== '未填' ? { ...row, value: input.terrainLabel(row.value) } : row,
    )
    const biome = rows.find((row) => row.label === '生物群系')
    if (biome !== undefined && biome.value !== '未填') biome.value = input.biomeLabel(biome.value)
    return { kind: 'cell', title, rows }
  }

  // ---- 多选 ----
  const summary = input.summary
  const rows: SelectionCardRow[] = [{ label: '格数', value: `${count} 格` }]
  if (summary === null) return { kind: 'multi', title: `已选 ${count} 格`, rows }

  if (summary.range !== null) {
    const { minQ, maxQ, minR, maxR } = summary.range
    rows.push({ label: '坐标范围', value: `q ${minQ}–${maxQ} · r ${minR}–${maxR}` })
  }
  if (summary.terrains.length > 0) {
    rows.push({
      label: '地形种类',
      value: summary.terrains.map((item) => `${input.terrainLabel(item.id)} ${item.count}`).join(' · '),
    })
  }
  rows.push(
    ...statRows(summary, input.styles, input.document?.elevation ?? null),
  )
  // 生物群系要的是**清单**（"各有哪些"），不是个数 —— 用户明确要求
  if (summary.biomes.length > 0) {
    rows.push({ label: '生物群系', value: summary.biomes.map((id) => input.biomeLabel(id)).join(' · ') })
  }
  if (summary.missing > 0) {
    // 生命周期那条（§C.3）：撤销 / 重载之后可能出现"选择里有一格地图里已经没有了"
    rows.push({ label: '已不存在', value: `${summary.missing} 格` })
  }
  return { kind: 'multi', title: `已选 ${count} 格`, rows }
}