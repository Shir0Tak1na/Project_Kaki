/**
 * 自定义定义"改 ID 并迁移引用"的单元测试。
 *
 * 这一层的赌注很大：它是**唯一会改动用户已有地图文件**的功能，
 * 所以三条必须钉死：只改该改的、别把别的字段顺手改了、别就地改入参。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import { definitionSetFromLibrary } from '../src/data/mapDefinitions.ts'
import {
  DEFINITION_KIND_FIELDS,
  countReferences,
  countReferencesById,
  describeDeletionPlan,
  describeRenamePlan,
  renameDefinitionEntry,
  renameReferences,
} from '../src/render/definitionRename.ts'

function sample(): MapDocument {
  const document = createEmptyMapDocument({})
  document.terrain = {
    // 群系住在格子上：这里故意让地形 ID 与群系 ID 字面相同（`custom:a`），
    // 于是"改群系 ID 不许碰到地形字段"这件事是被钉住的，而不是靠"两者恰好不同"。
    '0,0': { t: 'custom:a', biome: 'custom:a', temp: 12 },
    '1,0': { t: 'custom:a', biome: 'custom:a', depth: -3 },
    '2,0': { t: 'custom:b', biome: 'swamp' },
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

test('countReferences：五类都数得对，不存在的 ID 一律 0', () => {
  const document = sample()
  assert.equal(countReferences(document, 'terrain', 'custom:a'), 2)
  assert.equal(countReferences(document, 'marker', 'custom:a'), 1)
  assert.equal(countReferences(document, 'path', 'custom:a'), 1)
  assert.equal(countReferences(document, 'region', 'custom:a'), 1)
  // 群系数的是"格"：同名的地形 ID 不算（那是两件事）
  assert.equal(countReferences(document, 'biome', 'custom:a'), 2)
  assert.equal(countReferences(document, 'biome', 'swamp'), 1, '内置群系同样数得出来')
  for (const kind of ['terrain', 'marker', 'path', 'region', 'biome'] as const) {
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
  // 群系：按格数的，内置 ID 也会出现在这里
  const biomes = countReferencesById(sample(), 'biome')
  assert.equal(biomes.get('custom:a'), 2)
  assert.equal(biomes.get('swamp'), 1)
  assert.equal(biomes.size, 2, '没填群系的格不产生键')
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

test('renameReferences（biome）：只改 biome 字段，地形/温度/深度/别的群系一处不动', () => {
  // 这份夹具刻意让"地形 ID"与"群系 ID"**不同**，而且有一格的地形 ID 恰好等于旧群系 ID
  // （`'2,0'` 的 `t` 是 custom:a）—— 于是"按错字段判断"（写成 `cell.t === fromId`）会当场露馅：
  // 那样改出来的格数是 1，而不是正确的 2。
  const document = createEmptyMapDocument({})
  document.terrain = {
    '0,0': { t: 'custom:forest2', biome: 'custom:a', temp: 12 },
    '1,0': { t: 'water', biome: 'custom:a', depth: -3 },
    '2,0': { t: 'custom:a', biome: 'swamp' },
  }
  const { document: after, changed } = renameReferences(document, 'biome', 'custom:a', 'custom:lake')
  assert.equal(changed, 2, '只数真的改了群系的那两格')
  assert.equal(after.terrain['0,0']!.biome, 'custom:lake')
  assert.equal(after.terrain['1,0']!.biome, 'custom:lake')
  assert.equal(after.terrain['2,0']!.biome, 'swamp', '地形 ID 撞名不算群系引用，不许被改')
  // 同一格上的其它字段原样保留 —— 群系与地形是两件事，改一个不许动另一个
  assert.equal(after.terrain['0,0']!.t, 'custom:forest2')
  assert.equal(after.terrain['0,0']!.temp, 12)
  assert.equal(after.terrain['1,0']!.t, 'water')
  assert.equal(after.terrain['1,0']!.depth, -3)
  assert.equal(after.terrain['2,0']!.t, 'custom:a', '地形引用不许被群系改名碰到')
})

test('renameReferences（biome）：格子上的未知字段原样保留（§5.11）', () => {
  const document = createEmptyMapDocument({})
  // 模拟"别的版本写的字段"：解析层会把它收进 extra 之类的地方，这里直接塞一个不认识的键
  document.terrain['0,0'] = { t: 'forest', biome: 'custom:a', weird: 'keep-me' } as never
  const { document: after } = renameReferences(document, 'biome', 'custom:a', 'custom:lake')
  assert.equal(after.terrain['0,0']!.biome, 'custom:lake')
  assert.equal((after.terrain['0,0'] as Record<string, unknown>).weird, 'keep-me', '不认识的字段必须原样留住')
})

test('renameReferences（biome）：新旧相同 / 没有格用它 ⇒ 原样返回同一个文档', () => {
  const document = sample()
  const same = renameReferences(document, 'biome', 'custom:a', 'custom:a')
  assert.equal(same.changed, 0)
  assert.equal(same.document, document, '同一个对象直接返回，调用方据此可跳过写盘')

  const none = renameReferences(document, 'biome', 'custom:nope', 'custom:x')
  assert.equal(none.changed, 0)
  assert.equal(none.document, document)
})

test('renameReferences（biome）：不就地修改入参', () => {
  const before = sample()
  renameReferences(before, 'biome', 'custom:a', 'custom:lake')
  assert.equal(before.terrain['0,0']!.biome, 'custom:a', '入参被就地改会让撤销栈与预览拿到被污染的旧文档')
  assert.equal(before.terrain['1,0']!.biome, 'custom:a')
})

test('renameDefinitionEntry（biome）：只改定义集里那一条，不动任何格子', () => {
  const set = definitionSetFromLibrary({ customBiomes: [{ id: 'custom:a', label: '咸水湖', color: '#2277aa' }] })
  const next = renameDefinitionEntry(set, 'biome', 'custom:a', 'custom:lake')
  assert.equal(next.biomes.length, 1)
  assert.equal(next.biomes[0]!.id, 'custom:lake')
  assert.equal(next.biomes[0]!.label, '咸水湖', '改 ID 不动显示名')
  assert.equal(next.biomes[0]!.color, '#2277aa', '改 ID 不动颜色')
  assert.notEqual(next, set, '返回新集合（调用方据此判断要不要写盘）')
  assert.equal(set.biomes[0]!.id, 'custom:a', '入参不许被就地改')
  // 没这条定义时原样返回同一个对象
  const missing = renameDefinitionEntry(set, 'biome', 'custom:nope', 'custom:x')
  assert.equal(missing, set)
})

test('describeRenamePlan：群系的单位是"格"，不是"处引用"', () => {
  const plan = describeRenamePlan({
    kind: 'biome',
    fromId: 'custom:lake',
    toId: 'custom:lake2',
    files: [{ path: 'Maps/World.map.md', changed: 3 }],
    totalChanged: 3,
  })
  // 说"3 处引用"会让人以为是三个对象；群系的真实含义是"三格数据"
  assert.match(plan, /1 张地图里共 3 格从 custom:lake 改成 custom:lake2/)
  assert.match(plan, /Maps\/World\.map\.md：3 格/)
  assert.match(plan, /生物群系/)
  assert.doesNotMatch(plan, /处引用/)
  // 零影响面读作"没有任何格填了它"（而不是"没有地图引用"）
  const empty = describeRenamePlan({ kind: 'biome', fromId: 'custom:lake', toId: 'custom:lake2', files: [], totalChanged: 0 })
  assert.match(empty, /没有任何格把生物群系填成 custom:lake/)
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

test('describeDeletionPlan：没有引用时说"可以安全删除"，一个字都不提"回退样式"', () => {
  const text = describeDeletionPlan({ kind: 'marker', id: 'custom:lighthouse', files: [], total: 0 })
  assert.match(text, /没有地图引用它，可以安全删除/)
  assert.match(text, /标记/)
  assert.match(text, /custom:lighthouse/)
  // 没有引用就没有影响面：这段额外的解释只会变成噪音
  assert.doesNotMatch(text, /回退样式/)
  assert.doesNotMatch(text, /张地图/)
})

test('describeDeletionPlan：有引用时给数字、逐文件明细，并说清"对象不会被删除"', () => {
  const text = describeDeletionPlan({
    kind: 'terrain',
    id: 'custom:swamp2',
    files: [
      { path: 'Maps/World.map.md', count: 12 },
      { path: 'Maps/Other.map.md', count: 3 },
    ],
    total: 15,
  })
  // 三件必须说清的事：多少、在哪、以及"数据没丢"
  assert.match(text, /2 张地图里共 15 处引用 custom:swamp2/)
  assert.match(text, /Maps\/World\.map\.md：12 处/)
  assert.match(text, /Maps\/Other\.map\.md：3 处/)
  assert.match(text, /这些对象不会被删除，仍留在文件里，只是画成回退样式（未知）。/)
  assert.match(text, /可随时重新建回/)
  assert.match(text, /地形/)
})

test('describeDeletionPlan：逐字比对全文（文案是承诺，不能随手改口径）', () => {
  assert.equal(
    describeDeletionPlan({
      kind: 'path',
      id: 'custom:highway',
      files: [{ path: 'Maps/A.map.md', count: 2 }],
      total: 2,
    }),
    [
      '1 张地图里共 2 处引用 custom:highway：',
      '  · Maps/A.map.md：2 处',
      '这些对象不会被删除，仍留在文件里，只是画成回退样式（未知）。',
      '删除的只是这条路径类型定义（custom:highway），可随时重新建回。',
    ].join('\n'),
  )
})

test('字段名表与五类定义一一对应（报告文案要说清改的是哪个字段）', () => {
  assert.deepEqual(DEFINITION_KIND_FIELDS, {
    terrain: 'cells[].t',
    marker: 'markers[].icon',
    path: 'paths[].type',
    region: 'regions[].type',
    biome: 'cells[].biome',
  })
})
