/**
 * 自定义生物群系的「引用数」：删除前的影响面必须数得准。
 *
 * 群系不是独立对象，而是**格子上的一个字段**（`TerrainCell.biome`）—— 所以它走不了
 * `countReferences(kind, id)` 那条路（`DefinitionKind` 只描述能被画在地图上的对象）。
 * 这个数字直接进删除确认框，数错了就等于骗用户「没人用它」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyMapDocument } from '../src/data/mapDocument.ts'
import { countBiomeReferences } from '../src/render/definitionRename.ts'

test('没有格用它：返回 0（删除时不该白挡一下）', () => {
  const document = createEmptyMapDocument({})
  document.terrain['0_0'] = { t: 'forest' }
  assert.equal(countBiomeReferences(document, 'custom:lake'), 0)
})

test('数出把 biome 设成这个 ID 的格（含自定义 ID）', () => {
  const document = createEmptyMapDocument({})
  document.terrain['0_0'] = { t: 'forest', biome: 'custom:lake' }
  document.terrain['1_0'] = { t: 'water', biome: 'custom:lake' }
  document.terrain['2_0'] = { t: 'water', biome: 'swamp' }
  assert.equal(countBiomeReferences(document, 'custom:lake'), 2)
  assert.equal(countBiomeReferences(document, 'swamp'), 1, '内置群系同样数得出来')
})

test('不数错字段：温度/深度/地形类型都不算群系引用', () => {
  const document = createEmptyMapDocument({})
  document.terrain['0_0'] = { t: 'custom:lake', depth: 12 }
  assert.equal(countBiomeReferences(document, 'custom:lake'), 0, '地形 ID 撞名也不算群系引用')
})
