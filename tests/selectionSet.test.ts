/**
 * 格选择集合与统计的单测（`src/render/selectionSet.ts`）。
 *
 * 这一组盯五件事：
 * 1. **集合运算**（替换 / 并入 / 移出 / 交集）与规范形式（去重 + 排序，断言才稳定）；
 * 2. **规则筛选**只遍历文件里真实存在的格（空白区不在其中），三种动作各对一次；
 * 3. **同地形连通扩展**：只走同地形、跨过异地形就断、没有地形的种子不扩；
 * 4. **统计口径**（施工文件 §C.4 写死）：众数并列取值较小者、平均数只算有值的格、
 *    兜底格单独计数、找不到的格只计 `missing` 不进统计；
 * 5. 邻域表**自检**：每个方向的距离必须是 1（表写错时当场抓住）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { MapDocument } from '../src/data/mapDocument.ts'
import { hexDistance } from '../src/core/hex.ts'
import { AXIAL_NEIGHBORS } from '../src/core/hexEdges.ts'
import { DEFAULT_OVERLAY_STYLES } from '../src/render/overlayFields.ts'
import {
  addToSelection,
  applyRuleToSelection,
  compareCellKeys,
  describeCellDetails,
  expandSelectionByTerrain,
  intersectSelection,
  normalizeSelection,
  removeFromSelection,
  replaceSelection,
  summarizeSelection,
} from '../src/render/selectionSet.ts'
import { emptyRuleGroup, type RuleGroup } from '../src/render/selectionRules.ts'

function makeDocument(): MapDocument {
  return {
    version: 1,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: {
      '0_0': { t: 'forest', temp: 20, depth: 0 },
      '1_0': { t: 'forest', temp: 20, depth: 100 },
      '2_0': { t: 'forest', temp: 30 },
      '3_0': { t: 'water', temp: 10, depth: 200 },
      '4_0': { t: 'water' },
      '5_0': { temp: 5 },
    },
    paths: [],
    regions: [],
    markers: [],
    labels: [],
  }
}

test('邻域表自检：六个方向的距离必须都是 1（表写错时当场抓住，而不是等连通扩展出怪结果）', () => {
  assert.equal(AXIAL_NEIGHBORS.length, 6)
  for (const [dq, dr] of AXIAL_NEIGHBORS) {
    assert.equal(hexDistance({ q: 0, r: 0 }, { q: dq, r: dr }), 1, `方向 (${dq},${dr}) 应当相邻`)
  }
})

test('规范形式与集合运算：去重、排序（先 r 后 q）、坏键丢弃；移出**不是取补**', () => {
  assert.deepEqual(normalizeSelection(['1_0', '0_0', '1_0']), ['0_0', '1_0'])
  assert.deepEqual(normalizeSelection(['1_1', '0_0']), ['0_0', '1_1'], '先 r 后 q')
  assert.deepEqual(normalizeSelection(['0_0', 'not-a-key', '0_0']), ['0_0'], '坏键丢掉')
  assert.equal(compareCellKeys('0_1', '1_0'), 1, 'r 小的在前')
  assert.deepEqual(replaceSelection(['0_0', '1_0']), ['0_0', '1_0'])
  assert.deepEqual(addToSelection(['0_0'], ['1_0', '0_0']), ['0_0', '1_0'])
  assert.deepEqual(removeFromSelection(['0_0', '1_0', '2_0'], ['1_0']), ['0_0', '2_0'])
  // 移出只影响名单里的格 —— "取消单格"绝不该变成"选中其余全部"
  assert.deepEqual(removeFromSelection(['0_0', '1_0'], ['9_9']), ['0_0', '1_0'])
  const document = makeDocument()
  assert.deepEqual(
    intersectSelection(document, ['0_0', '3_0'], (_key, cell) => cell?.t === 'forest'),
    ['0_0'],
    '在当前选择内再筛 = 交集',
  )
})

test('规则筛选：三种动作 + 只遍历文件里存在的格', () => {
  const document = makeDocument()
  const forest: RuleGroup = { join: 'and', negate: false, clauses: [{ key: 'terrain', op: '=', value: 'forest' }] }
  assert.deepEqual(applyRuleToSelection([], document, forest, 'replace'), ['0_0', '1_0', '2_0'])
  assert.deepEqual(applyRuleToSelection(['5_0'], document, forest, 'add'), ['0_0', '1_0', '2_0', '5_0'])
  assert.deepEqual(applyRuleToSelection(['0_0', '3_0'], document, forest, 'remove'), ['3_0'])
  // 规则不匹配任何格时：replace 清空、add/remove 原样
  assert.deepEqual(applyRuleToSelection(['0_0'], document, emptyRuleGroup(), 'replace'), [])
  assert.deepEqual(applyRuleToSelection(['0_0'], document, emptyRuleGroup(), 'add'), ['0_0'])
  // 只遍历文件里存在的格：地图上没画的格不会因为规则被"选出来"
  assert.deepEqual(
    applyRuleToSelection([], document, { join: 'and', negate: false, clauses: [{ key: 'temp', op: 'exists', value: true }] }, 'replace'),
    ['0_0', '1_0', '2_0', '3_0', '5_0'],
  )
})

test('同地形连通扩展：只走同地形、跨过异地形就断、没有地形的种子不扩', () => {
  const document = makeDocument()
  // 0_0 / 1_0 / 2_0 是 forest；3_0 / 4_0 是 water；5_0 没地形
  assert.deepEqual(expandSelectionByTerrain(document, ['2_0']), ['0_0', '1_0', '2_0'], '整片 forest 都扩进来')
  assert.deepEqual(expandSelectionByTerrain(document, ['3_0']), ['3_0', '4_0'], 'water 那两格')
  assert.deepEqual(expandSelectionByTerrain(document, ['5_0']), ['5_0'], '没有地形的格不参与连通')
  // 隔离：把中间一格改成别的类型，连通就断开
  const split = makeDocument()
  split.terrain['1_0'] = { t: 'mountain' }
  assert.deepEqual(expandSelectionByTerrain(split, ['0_0']), ['0_0'], '被 mountain 隔开')
  // 已有选择并入结果（不替换）
  assert.deepEqual(expandSelectionByTerrain(document, ['3_0', '0_0']), ['0_0', '1_0', '2_0', '3_0', '4_0'])
  // 空选择 → 空
  assert.deepEqual(expandSelectionByTerrain(document, []), [])
})

test('统计：格数 / 坐标范围 / 地形种类 / 众数与平均数 / 兜底格 / 生物群系清单 / 已不存在的格', () => {
  const document = makeDocument()
  document.terrain['0_0'] = { t: 'forest', temp: 20, depth: 0, biome: 'temperate_forest' }
  document.terrain['1_0'] = { t: 'forest', temp: 20, depth: 100, biome: 'temperate_forest' }
  document.terrain['3_0'] = { t: 'water', temp: 10, depth: 200, biome: 'deep_ocean' }
  const summary = summarizeSelection(document, ['0_0', '1_0', '3_0', '9_9', '4_0'])

  assert.equal(summary.count, 5, '含"已不存在"的格')
  assert.equal(summary.missing, 1, '9_9 不在文件里')
  assert.deepEqual(summary.range, { minQ: 0, maxQ: 4, minR: 0, maxR: 0 })
  assert.deepEqual(summary.terrains, [
    { id: 'forest', count: 2 },
    { id: 'water', count: 2 },
  ], '4_0 只有地形也算进地形种类')
  assert.deepEqual(summary.biomes, ['deep_ocean', 'temperate_forest'], '生物群系列**清单**（各有哪些），排序稳定')

  const temp = summary.fields.find((entry) => entry.key === 'temp')!
  assert.equal(temp.mode, 20, '20 出现两次 → 众数（并列取小值的那条单测见下）')
  assert.equal(temp.average, (20 + 20 + 10) / 3)
  assert.equal(temp.missing, 1, '4_0 没有温度')
  const depth = summary.fields.find((entry) => entry.key === 'depth')!
  assert.equal(depth.missing, 1, '4_0 没有深度（9_9 不存在，不进统计）')
  assert.equal(depth.fallback, 0, '这张图没有设默认值 → 兜底格 0')

  // 众数并列取**值较小**者（可预测）
  const tie = makeDocument()
  tie.terrain = { '0_0': { temp: 30 }, '1_0': { temp: 10 }, '2_0': { temp: 30 }, '3_0': { temp: 10 } }
  assert.equal(summarizeSelection(tie, ['0_0', '1_0', '2_0', '3_0']).fields[0]!.mode, 10)

  // 兜底格单独计数（§B：颜色 = 有数据 的直觉会被兜底打破，卡片必须说明）
  const withDefaults = makeDocument()
  withDefaults.dataDefaults = { temp: 15 }
  const fallback = summarizeSelection(withDefaults, ['4_0', '5_0'])
  const tempStat = fallback.fields.find((entry) => entry.key === 'temp')!
  assert.equal(tempStat.missing, 1, '4_0 没有温度')
  assert.equal(tempStat.fallback, 1, '而它**用了默认值兜底** → 单独计数')
  assert.equal(tempStat.mode, 5, '5_0 的真值照旧参与统计')

  // 空选择
  const empty = summarizeSelection(makeDocument(), [])
  assert.equal(empty.count, 0)
  assert.equal(empty.range, null)
  assert.deepEqual(empty.terrains, [])
  assert.deepEqual(empty.biomes, [])
})

test('单格详情：没有的字段写"未填"（不猜 0），读数与图例同源（跟随展示单位）', () => {
  const document = makeDocument()
  const rows = describeCellDetails(document, '0_0', DEFAULT_OVERLAY_STYLES)
  const byLabel = new Map(rows.map((row) => [row.label, row.value]))
  assert.equal(byLabel.get('坐标'), '(0, 0)')
  assert.equal(byLabel.get('地形'), 'forest')
  assert.equal(byLabel.get('温度'), '20℃')
  assert.equal(byLabel.get('深度 / 海拔'), '0 m', '后缀与图例同源（带单位的写法有一个前导空格）')
  assert.equal(byLabel.get('生物群系'), '未填', '没有生物群系 → 未填，而不是空串或 0')

  // 换成千米后读数跟着变（读数只有一个来源：`formatFieldReading`）
  const km = describeCellDetails(
    { ...document, terrain: { '0_0': { t: 'forest', depth: 5000 } } },
    '0_0',
    { ...DEFAULT_OVERLAY_STYLES, depth: { ...DEFAULT_OVERLAY_STYLES.depth, unit: 'km' } },
  )
  assert.equal(new Map(km.map((row) => [row.label, row.value])).get('深度 / 海拔'), '5 km')
  // 没有温度 → 未填
  assert.equal(new Map(km.map((row) => [row.label, row.value])).get('温度'), '未填')
})