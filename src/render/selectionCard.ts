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
import type { HoverReadout } from '../editor/selection.ts'
import {
  formatFieldReading,
  OVERLAY_FIELDS,
  overlayUnitSuffix,
  type OverlayStyles,
} from './overlayFields.ts'
import { describeCellDetails, type CellDetailRow, type CellSelection, type SelectionSummary } from './selectionSet.ts'
import { SELECTION_TEXT } from '../ui/strings.ts'

/** 卡片的一行（`label` 是左侧的粗体小标题，`value` 是右侧的读数） */
export type SelectionCardRow = CellDetailRow

export type SelectionCardModel =
  /** 没有选择：卡片**整个不显示**（§F.3：无选择 = 不显示） */
  | { kind: 'empty' }
  /** 单选一格：坐标 / 地形 / 各字段读数 / 生物群系 */
  | { kind: 'cell'; title: string; rows: SelectionCardRow[] }
  /** 多选：统计与清单 */
  | { kind: 'multi'; title: string; rows: SelectionCardRow[] }
  /** 悬停压在一个对象上（§2.6：卡片只做进行中的事） */
  | { kind: 'object'; title: string; rows: SelectionCardRow[] }

export interface SelectionCardInput {
  /**
   * 当前**进行中**的格选择（有序去重的格键）。
   *
   * ⚠️ 调用方只在"框选拖动中"传它（§2.6：**选择一旦确定就收起**）——
   * 已确定的选择归侧栏「数据显示」，卡片再显示一份就是两处各说一遍。
   */
  cellSelection: CellSelection
  /**
   * 悬停读数（§2.6：命中对象报对象名、否则报格读数）。`none` = 指针不在有意义的东西上。
   *
   * 与 `cellSelection` 的分工：**拖动中看统计、不拖动时看悬停**（拖动时悬停读数会让数字乱跳）。
   */
  hover: HoverReadout
  /** 多选时的统计（`summarizeSelection` 的结果；单选时也给，用于"已不存在"那一行） */
  summary: SelectionSummary | null
  /** 文档（单选详情要读真值；`null` = 还没加载出来，这时卡片只报格数） */
  document: MapDocument | null
  /** 数值图层样式（决定读数用米还是千米 —— 与图例、画布**同一个**格式化函数） */
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
    const mode = stat.mode === null ? SELECTION_TEXT.unfilled : readingOf(stat.key, stat.mode, styles, calibration)
    const average = stat.average === null ? SELECTION_TEXT.unfilled : readingOf(stat.key, stat.average, styles, calibration)
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
 * 多选那一份**统计行**（§C.4），**侧栏「整批编辑」与画布卡片共用同一份**。
 *
 * 为什么抽出来：W2-3 把卡片降级成"只做进行中的事"（抬手就收起）之后，这份统计必须
 * **搬进侧栏** —— 否则框选完抬手，那些数字就无处可看了（用户验收时当场指出：
 * "并没有收进侧栏里"）。两处各算一遍必然分叉，所以只留这一个出口。
 *
 * 刻意**不含**两项（侧栏那一节自己已经写了，重复就是噪音）：
 * - **格数**（整批编辑的标题就是「整批编辑（N 格）」）；
 * - **地形种类**（侧栏头部那一行摘要已经写了"水域 2 · 森林 1"）。
 */
export function selectionStatRows(
  summary: SelectionSummary,
  styles: OverlayStyles,
  calibration: ElevationCalibration | null,
  biomeLabel: (id: string) => string,
): SelectionCardRow[] {
  const rows: SelectionCardRow[] = []
  if (summary.range !== null) {
    const { minQ, maxQ, minR, maxR } = summary.range
    rows.push({ label: SELECTION_TEXT.rangeLabel, value: `q ${minQ}–${maxQ} · r ${minR}–${maxR}` })
  }
  rows.push(...statRows(summary, styles, calibration))
  // 生物群系要的是**清单**（"各有哪些"），不是个数 —— 用户明确要求
  if (summary.biomes.length > 0) {
    rows.push({ label: '生物群系', value: summary.biomes.map((id) => biomeLabel(id)).join(' · ') })
  }
  if (summary.missing > 0) {
    rows.push({ label: '已不存在', value: `${summary.missing} 格` })
  }
  return rows
}

/** 单格那一段（选择一格与"悬停压在某格上"共用同一个造型与同一份读数） */
function singleCellModel(input: SelectionCardInput, key: string): SelectionCardModel {
  const axial = /^(-?\d+)_(-?\d+)$/.exec(key)
  const title = axial === null ? `格 ${key}` : `格 (${axial[1]}, ${axial[2]})`
  if (input.document === null) return { kind: 'cell', title, rows: [{ label: '格', value: key }] }
  const rows = describeCellDetails(input.document, key, input.styles).map((row) =>
    // 详情里用的是**原始 ID**（纯函数不认识目录）；显示名在这里翻一次
    row.label === '地形' && row.value !== SELECTION_TEXT.unfilled ? { ...row, value: input.terrainLabel(row.value) } : row,
  )
  const biome = rows.find((row) => row.label === '生物群系')
  if (biome !== undefined && biome.value !== SELECTION_TEXT.unfilled) biome.value = input.biomeLabel(biome.value)
  return { kind: 'cell', title, rows }
}

/**
 * 把"当前选择"变成卡片内容。
 *
 * **卡片只做进行中的事**（§2.6）：框选拖动中给统计，不拖动时给**悬停读数**，
 * 两样都没有就整张收起 —— 已确定的选择由侧栏「数据显示」负责（那是"选择"的唯一家）。
 */
export function buildSelectionCard(input: SelectionCardInput): SelectionCardModel {
  const count = input.cellSelection.length
  if (count === 0) {
    // 悬停读数：压在对象上就报对象（§2.6 那条"命中对象优先"），压在某格上报这一格的读数
    if (input.hover.kind === 'object') {
      return {
        kind: 'object',
        title: SELECTION_TEXT.objectTitle(input.hover.kindLabel, input.hover.label),
        rows: [{ label: '信息', value: input.hover.detail }],
      }
    }
    if (input.hover.kind === 'cell') return singleCellModel(input, input.hover.key)
    return { kind: 'empty' }
  }

  if (count === 1) return singleCellModel(input, input.cellSelection[0]!)

  // ---- 多选 ----
  const summary = input.summary
  const rows: SelectionCardRow[] = [{ label: '格数', value: `${count} 格` }]
  if (summary === null) return { kind: 'multi', title: SELECTION_TEXT.multiTitle(count), rows }

  if (summary.terrains.length > 0) {
    rows.push({
      label: '地形种类',
      value: summary.terrains.map((item) => `${input.terrainLabel(item.id)} ${item.count}`).join(' · '),
    })
  }
  // 其余统计（坐标范围 / 众数 / 平均 / 缺数据 / 群系清单 / 已不存在）与**侧栏「整批编辑」共用**
  // 同一个 `selectionStatRows` —— 卡片只多做"格数 + 地形种类"两行
  rows.push(
    ...selectionStatRows(
      summary,
      input.styles,
      input.document?.elevation ?? null,
      input.biomeLabel,
    ),
  )
  return { kind: 'multi', title: SELECTION_TEXT.multiTitle(count), rows }
}