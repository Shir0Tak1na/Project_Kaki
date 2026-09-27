/**
 * 自定义定义"改 ID 并迁移引用"的单元测试。
 *
 * 这一层的赌注很大：它是**唯一会改动用户已有地图文件**的功能，
 * 所以三条必须钉死：只改该改的、别把别的字段顺手改了、别就地改入参。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import {
  DEFINITION_KIND_FIELDS,
  countReferences,
  countReferencesById,
  describeRenamePlan,
  renameReferences,
} from '../src/render/definitionRename.ts'

function sample(): MapDocument {
  const document = createEmptyMapDocument({})
  document.terrain = {
    '0,0': { t: 'custom:a' },
    '1,0': { t: 'custom:a' },
    '2,0': { t: 'custom:b' },
  }
  document.markers = [
    { id: 'm1', label: '灯塔', p: [0, 0], icon: 'custom:a' },
    { id: 'm2', label: '镇子', p: [1, 1], icon: 'town' },
  ]
  document.paths = [{ id: 'p1', type: 'custom:a', pts: [[0, 0], [1, 1]], width: 4, color: '#8ab4f8' }]
  document.regions = [
    { id: 'r1', label: '王国', pts: [[0, 0], [1, 0], [0, 1]], color: '#44cf6e', opacity: 0.22, type: 'custom:a' },
    { id: 'r2', label: '旧区域', pts: [[0, 0], [1, 0], [0, 1]], color: '#c94f4f', opacity: 0.22 },
  ]
  return document
}

test('countReferences：四类都数得对，不存在的 ID 一律 0', () => {
  const document = sample()
  assert.equal(countReferences(document, 'terrain', 'custom:a'), 2)
  assert.equal(countReferences(document, 'marker', 'custom:a'), 1)
  assert.equal(countReferences(document, 'path', 'custom:a'), 1)
  assert.equal(countReferences(document, 'region', 'custom:a'), 1)
  for (const kind of ['terrain', 'marker', 'path', 'region'] as const) {
    assert.equal(countReferences(document, kind, 'custom:nope'), 0)
  }
  // 旧区域没有 type 字段：不能被算进任何 ID 里
  assert.equal(countReferences(document, 'region', 'undefined'), 0)
})

test('countReferencesById：给出这份文档里每个 ID 的引用数', () => {
  const terrain = countReferencesById(sample(), 'terrain')
  assert.equal(terrain.get('custom:a'), 2)
  assert.equal(terrain.get('custom:b'), 1)
  assert.equal(terrain.size, 2)
  const regions = countReferencesById(sample(), 'region')
  assert.equal(regions.get('custom:a'), 1)
  assert.equal(regions.has('undefined'), false)
})

test('renameReferences：只改该改的，别的类型与别的 ID 一处不动', () => {
  const before = sample()
  const { document, changed } = renameReferences(before, 'terrain', 'custom:a', 'custom:A')
  assert.equal(changed, 2)
  assert.equal(document.terrain['0,0']!.t, 'custom:A')
  assert.equal(document.terrain['1,0']!.t, 'custom:A')
  assert.equal(document.terrain['2,0']!.t, 'custom:b', '别的 ID 不许被改')
  assert.equal(document.markers[0]!.icon, 'custom:a', '标记引用不许被地形改写碰到')
  assert.equal(document.paths[0]!.type, 'custom:a')
  assert.equal(document.regions[0]!.type, 'custom:a')
})

test('renameReferences：对象自己的参数原样保留', () => {
  const { document: afterMarker } = renameReferences(sample(), 'marker', 'custom:a', 'custom:beacon')
  assert.equal(afterMarker.markers[0]!.icon, 'custom:beacon')
  assert.equal(afterMarker.markers[0]!.label, '灯塔')
  assert.deepEqual(afterMarker.markers[0]!.p, [0, 0])

  const { document: afterPath } = renameReferences(sample(), 'path', 'custom:a', 'custom:lane')
  assert.equal(afterPath.paths[0]!.type, 'custom:lane')
  assert.equal(afterPath.paths[0]!.width, 4)
  assert.equal(afterPath.paths[0]!.color, '#8ab4f8')
  assert.deepEqual(afterPath.paths[0]!.pts, [[0, 0], [1, 1]])

  const { document: afterRegion } = renameReferences(sample(), 'region', 'custom:a', 'custom:realm2')
  assert.equal(afterRegion.regions[0]!.type, 'custom:realm2')
  assert.equal(afterRegion.regions[0]!.opacity, 0.22)
  assert.equal(afterRegion.regions[0]!.color, '#44cf6e')
  // 没有 type 的旧区域仍然没有 type（不许顺手补一个）
  assert.equal(afterRegion.regions[1]!.type, undefined)
})

test('renameReferences：新旧相同 = 什么都没发生（不是"改了 0 处"的假成功）', () => {
  const document = sample()
  const result = renameReferences(document, 'terrain', 'custom:a', 'custom:a')
  assert.equal(result.changed, 0)
  assert.equal(result.document, document, '同一个对象直接返回，调用方据此可跳过写盘')
})

test('renameReferences：没有引用时返回同一个对象，changed 为 0', () => {
  const document = sample()
  const result = renameReferences(document, 'marker', 'custom:nope', 'custom:x')
  assert.equal(result.changed, 0)
  assert.equal(result.document, document)
})

test('renameReferences：不就地修改入参（原地改会让撤销栈与预览都拿到被污染的旧文档）', () => {
  const before = sample()
  renameReferences(before, 'terrain', 'custom:a', 'custom:A')
  assert.equal(before.terrain['0,0']!.t, 'custom:a')
  assert.equal(before.markers[0]!.icon, 'custom:a')
  const beforeMarker = sample()
  renameReferences(beforeMarker, 'marker', 'custom:a', 'custom:beacon')
  assert.equal(beforeMarker.markers[0]!.icon, 'custom:a')
})

test('describeRenamePlan：没引用时说"只改定义"，有引用时逐文件列清楚', () => {
  const empty = describeRenamePlan({
    kind: 'terrain',
    fromId: 'custom:a',
    toId: 'custom:A',
    files: [],
    totalChanged: 0,
  })
  assert.match(empty, /没有地图引用/)

  const plan = describeRenamePlan({
    kind: 'marker',
    fromId: 'custom:a',
    toId: 'custom:beacon',
    files: [
      { path: 'Maps/World.map.md', changed: 2 },
      { path: 'Maps/Other.map.md', changed: 1 },
    ],
    totalChanged: 3,
  })
  assert.match(plan, /2 张地图/)
  assert.match(plan, /共 3 处/)
  assert.match(plan, /Maps\/World\.map\.md：2 处/)
  assert.match(plan, /Maps\/Other\.map\.md：1 处/)
  assert.match(plan, /标记/)
})

test('字段名表与四类定义一一对应（报告文案要说清改的是哪个字段）', () => {
  assert.deepEqual(DEFINITION_KIND_FIELDS, {
    terrain: 'cells[].t',
    marker: 'markers[].icon',
    path: 'paths[].type',
    region: 'regions[].type',
  })
})
