/**
 * 选择信息卡的内容模型单元测试（施工文件 §C.4）。
 *
 * 这一层值得钉死的两条：
 * 1. **单选时没有的字段写"未填"，绝不猜 0**（0 ℃ 是一个合法读数，猜出来的 0 是假数据）；
 * 2. **多选时必须说清"有几格没有数据、有几格用的是默认值"** —— 否则"有颜色 = 有数据"
 *    这个直觉会被兜底机制打破（§B.3），而卡片是用户唯一能核对这件事的地方。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { cellKey } from '../src/core/hex.ts'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import { DEFAULT_OVERLAY_STYLES } from '../src/render/overlayFields.ts'
import { buildSelectionCard, type SelectionCardInput } from '../src/render/selectionCard.ts'
import { normalizeSelection, summarizeSelection } from '../src/render/selectionSet.ts'

const TERRAIN_LABELS: Record<string, string> = { forest: '森林', water: '水' }
const BIOME_LABELS: Record<string, string> = { forest: '温带森林', tundra: '苔原' }

function input(document: MapDocument, keys: string[]): SelectionCardInput {
  const selection = normalizeSelection(keys)
  return {
    cellSelection: selection,
    summary: summarizeSelection(document, selection),
    document,
    styles: DEFAULT_OVERLAY_STYLES,
    terrainLabel: (id) => TERRAIN_LABELS[id] ?? id,
    biomeLabel: (id) => BIOME_LABELS[id] ?? id,
  }
}

function rowsOf(model: ReturnType<typeof buildSelectionCard>): Array<[string, string]> {
  return model.kind === 'empty' ? [] : model.rows.map((row) => [row.label, row.value])
}

test('没有选择时卡片是 empty（整张卡片不显示）', () => {
  const document = createEmptyMapDocument({})
  assert.equal(buildSelectionCard(input(document, [])).kind, 'empty')
})

test('单选：坐标写进标题、地形与生物群系翻成显示名、没有的字段写"未填"（不猜 0）', () => {
  const document = createEmptyMapDocument({})
  document.terrain[cellKey(0, 0)] = { t: 'forest', temp: 12, biome: 'forest' }
  const model = buildSelectionCard(input(document, [cellKey(0, 0)]))
  assert.equal(model.kind, 'cell')
  if (model.kind !== 'cell') return
  assert.equal(model.title, '格 (0, 0)')
  const rows = new Map(rowsOf(model))
  assert.equal(rows.get('地形'), '森林', '地形要翻成显示名（不能把 forest 给用户看）')
  assert.equal(rows.get('生物群系'), '温带森林')
  assert.match(rows.get('温度') ?? '', /^12/)
  // 深度这一格没填 → "未填"，而不是 0（0 是海平面，是一个合法读数）
  assert.equal(rows.get('深度 / 海拔'), '未填')
})

test('多选：众数与平均数分开给，且缺数据 / 兜底格都单独说明', () => {
  const document = createEmptyMapDocument({})
  // 三格：两格有温度（众数 = 20），一格没有 —— 而地图给了默认值，所以那一格算"兜底"
  document.terrain[cellKey(0, 0)] = { t: 'forest', temp: 20, biome: 'forest' }
  document.terrain[cellKey(1, 0)] = { t: 'forest', temp: 20, biome: 'tundra' }
  document.terrain[cellKey(2, 0)] = { t: 'water' }
  document.dataDefaults = { temp: -5 }

  const model = buildSelectionCard(input(document, [cellKey(0, 0), cellKey(1, 0), cellKey(2, 0)]))
  assert.equal(model.kind, 'multi')
  if (model.kind !== 'multi') return
  assert.equal(model.title, '已选 3 格')
  const rows = new Map(rowsOf(model))
  assert.match(rows.get('温度 众数') ?? '', /^20/)
  assert.match(rows.get('温度 平均') ?? '', /^20/)
  const missing = rows.get('温度 缺数据') ?? ''
  assert.match(missing, /1 格/, missing)
  assert.match(missing, /其中 1 格用的是默认值/, '兜底格必须单独说明，否则"有颜色 = 有数据"是错的')
  assert.match(rows.get('地形种类') ?? '', /森林 2/)
  assert.match(rows.get('地形种类') ?? '', /水 1/)
  assert.equal(rows.get('生物群系'), '温带森林 · 苔原', '生物群系要的是清单，不是个数')
  assert.equal(rows.get('坐标范围'), 'q 0–2 · r 0–0')
  assert.equal(rows.has('已不存在'), false, '没有不存在的格时不该出现这一行')
})

test('多选：选择里混进"地图里已经没有的格"时单独报出来（生命周期那条）', () => {
  const document = createEmptyMapDocument({})
  document.terrain[cellKey(0, 0)] = { t: 'forest' }
  // 撤销 / 重载之后可能出现"选择里还留着一个已经不存在的格键"
  const model = buildSelectionCard(input(document, [cellKey(0, 0), cellKey(9, 9)]))
  assert.equal(model.kind, 'multi')
  if (model.kind !== 'multi') return
  const rows = new Map(rowsOf(model))
  assert.equal(model.title, '已选 2 格')
  assert.equal(rows.get('已不存在'), '1 格')
})