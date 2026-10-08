/**
 * 地形标签（`tagCatalog.ts` + `terrainCatalog.ts` 的 `TERRAIN_TAGS` / `BUILTIN_TERRAIN_TAGS`
 * + `selectionRules.ts` 的 `terrainTag` 规则）的契约测试。
 *
 * 盯的是四件容易悄悄坏掉的事：
 * 1. **两边共用同一批标签 ID**（用户口径）—— 地形与群系说同一个词，`aquatic` 在两边都指水域；
 * 2. **内置 9 种地形一个都不漏**（漏一个的表现是"某类地形筛不到"）；
 * 3. **一对多**（沼泽既是水域又是湿地）—— 这正是用标签而不是单值枚举的理由；
 * 4. **没有目录上下文时筛不中**（宁可少选，也不能多选错的东西）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { BIOME_TAGS } from '../src/render/biomeCatalog.ts'
import { TERRAIN_TYPES } from '../src/data/mapDocument.ts'
import {
  BUILTIN_TERRAIN_TAGS,
  TERRAIN_TAGS,
  resolveTerrainStyle,
  terrainCatalogSignature,
  terrainTagsOf,
  terrainTagLabel,
  validateCustomTerrainInput,
} from '../src/render/terrainCatalog.ts'
import { TAG_DEFS, isKnownTagFor, normalizeTagsFor, tagDefOf, tagLabelOf } from '../src/render/tagCatalog.ts'
import { describeClause, matchesGroup, selectionRule, type RuleGroup, type SelectionRuleContext } from '../src/render/selectionRules.ts'

/* ------------------------------------------------------------------ 词表 */

test('词表：前 23 条就是群系那批（顺序不变），地形标签全部取自同一批 ID', () => {
  // 前 23 条的顺序是**群系下拉的显示顺序**，动了界面顺序就会无理由地变
  assert.deepEqual(
    TAG_DEFS.slice(0, 23).map((tag) => tag.id),
    BIOME_TAGS.map((tag) => tag.id),
    '群系那一批必须仍是词表的前 23 条、顺序不变',
  )
  assert.equal(TAG_DEFS.length, 24, '这次只多了地形专有的 volcanic 一条')
  assert.equal(tagDefOf('volcanic')?.kinds.includes('biome'), false, 'volcanic 只给地形用（群系分类表已定稿）')
  // 地形那批每一条都必须能在同一份词表里找到 —— 这就是"共用同一批 ID"
  for (const tag of TERRAIN_TAGS) {
    assert.equal(tagDefOf(tag.id)?.id, tag.id, `地形标签 ${tag.id} 必须来自共用词表`)
  }
  // 层位标签（地表 / 地下 / 高空）对一格地形没有意义，不该出现在地形的下拉里
  for (const id of ['surface', 'underground', 'sky']) {
    assert.equal(isKnownTagFor('terrain', id), false, `${id} 不该给地形用`)
    assert.equal(isKnownTagFor('biome', id), true, `${id} 仍是群系的标签`)
  }
})

test('词表：水域这个词两边是同一个（aquatic）', () => {
  const terrainWater = TERRAIN_TAGS.find((tag) => tag.label === '水域')
  const biomeWater = BIOME_TAGS.find((tag) => tag.label === '水域')
  assert.equal(terrainWater?.id, 'aquatic')
  assert.equal(biomeWater?.id, 'aquatic', '共用同一批 ID：不能一边叫 aquatic、另一边叫 water')
})

test('标签显示名：认得的取词表，认不出的原样显示（不变成空白）', () => {
  assert.equal(tagLabelOf('aquatic'), '水域')
  assert.equal(terrainTagLabel('volcanic'), '火山')
  assert.equal(terrainTagLabel('custom-tag-from-elsewhere'), 'custom-tag-from-elsewhere')
})

/* ------------------------------------------------------------------ 内置分配 */

test('内置 9 种地形**每一种都有标签**，且标签都在词表里（没有笔误）', () => {
  for (const type of TERRAIN_TYPES) {
    const tags = BUILTIN_TERRAIN_TAGS[type]
    assert.ok(tags.length > 0, `${type} 至少要有一个标签，否则它永远筛不出来`)
    for (const tag of tags) {
      assert.equal(isKnownTagFor('terrain', tag), true, `${type} 上有个不认识的标签 ${tag}`)
    }
  }
})

test('一对多：沼泽既是水域又是湿地（这正是标签存在的理由）', () => {
  const swamp = BUILTIN_TERRAIN_TAGS.swamp
  assert.ok(swamp.includes('aquatic'))
  assert.ok(swamp.includes('wetland'))
})

test('「所有水域」= aquatic 命中的内置地形恰好是 水域 + 沼泽', () => {
  const hit = TERRAIN_TYPES.filter((type) => BUILTIN_TERRAIN_TAGS[type].includes('aquatic'))
  assert.deepEqual(hit, ['water', 'swamp'], JSON.stringify(hit))
})

/* ------------------------------------------------------------------ 解析 */

test('resolveTerrainStyle 暴露标签：内置查表、自定义读定义、认不出的给空集', () => {
  assert.deepEqual(resolveTerrainStyle('swamp').tags, BUILTIN_TERRAIN_TAGS.swamp)
  const custom = validateCustomTerrainInput({ id: 'reef', label: '暗礁', tags: ['aquatic'] })
  assert.equal(custom.ok, true)
  const terrains = custom.ok ? [custom.terrain] : []
  assert.deepEqual(resolveTerrainStyle('custom:reef', terrains).tags, ['aquatic'])
  assert.deepEqual(resolveTerrainStyle('custom:unknown').tags, [], '认不出的地形不"猜"标签')
  assert.deepEqual(terrainTagsOf('water'), ['aquatic'])
  assert.deepEqual(terrainTagsOf('custom:reef', terrains), ['aquatic'])
})

test('标签进目录签名：改了标签，界面（工具条 / 面板）才会重建', () => {
  const a = validateCustomTerrainInput({ id: 'reef', tags: [] })
  const b = validateCustomTerrainInput({ id: 'reef', tags: ['aquatic'] })
  assert.equal(a.ok && b.ok, true)
  const signature = (terrain: readonly { id: string }[]) => terrainCatalogSignature(terrain as never)
  assert.notEqual(
    signature(a.ok ? [a.terrain] : []),
    signature(b.ok ? [b.terrain] : []),
    '标签必须进签名，否则加完标签侧栏不会重建',
  )
})

/* ------------------------------------------------------------------ 标签收敛 */

test('normalizeTagsFor：去重、保序、未知丢掉、非数组给空', () => {
  assert.deepEqual(normalizeTagsFor('terrain', ['aquatic', 'aquatic', 'wetland']), ['aquatic', 'wetland'])
  assert.deepEqual(normalizeTagsFor('terrain', ['surface', 'aquatic']), ['aquatic'], '层位标签对地形无意义 → 丢掉')
  assert.deepEqual(normalizeTagsFor('terrain', ['nope', 'aquatic']), ['aquatic'], '不认识的丢掉')
  assert.deepEqual(normalizeTagsFor('terrain', 'aquatic'), [])
  assert.deepEqual(normalizeTagsFor('terrain', undefined), [])
  assert.deepEqual(normalizeTagsFor('biome', ['aquatic', 'volcanic']), ['aquatic'], 'volcanic 不是群系的标签')
})

test('显式写入：一个不认识的标签**不会**让整条自定义地形作废（只丢掉那个词）', () => {
  const result = validateCustomTerrainInput({ id: 'reef', label: '暗礁', color: '#2f6f8f', tags: ['aquatic', 'nope'] })
  assert.equal(result.ok, true, '标签是辅助信息，不该连累颜色 / 图片路径这些用户资产')
  assert.deepEqual(result.ok && result.terrain.tags, ['aquatic'])
  assert.equal(result.ok && result.terrain.color, '#2f6f8f')
  assert.equal(result.ok && result.terrain.label, '暗礁')
})

/* ------------------------------------------------------------------ 筛选规则 */

const context: SelectionRuleContext = {
  terrains: [
    { value: 'water', label: '水域', tags: ['aquatic'] },
    { value: 'swamp', label: '沼泽', tags: ['aquatic', 'wetland'] },
    { value: 'forest', label: '森林', tags: ['forest'] },
    { value: 'custom:reef', label: '暗礁', tags: ['aquatic'] },
  ],
  terrainTags: [
    { value: 'aquatic', label: '特殊·水域' },
    { value: 'wetland', label: '植被·湿地' },
  ],
}

const group = (value: string[]): RuleGroup => ({
  join: 'and',
  negate: false,
  clauses: [{ key: 'terrainTag', op: 'in', value }],
})

test('登记表里有 terrainTag，且只提供 in / =（标签本来就是"一组"的语义）', () => {
  const spec = selectionRule('terrainTag')
  assert.equal(spec?.label, '地形标签')
  assert.deepEqual(spec?.ops, ['in', '='])
  assert.equal(spec?.valueKind, 'enum')
  assert.equal(spec?.options?.(context).length, 2, '下拉里列的是 context 给的那批标签')
})

test('terrainTag in [aquatic]：命中水域 / 沼泽 / 自定义暗礁，不命中森林', () => {
  const hits = (t: string) => matchesGroup({ t }, group(['aquatic']), context)
  assert.equal(hits('water'), true)
  assert.equal(hits('swamp'), true)
  assert.equal(hits('custom:reef'), true, '自定义地形按标签进来才是"一次命中一组"的意义')
  assert.equal(hits('forest'), false)
  assert.equal(matchesGroup(undefined, group(['aquatic']), context), false, '空格子不命中')
})

test('没有目录上下文时**筛不中**（宁可少选，也不能多选错的东西）', () => {
  assert.equal(matchesGroup({ t: 'water' }, group(['aquatic'])), false)
})

test('人话回显：把标签 ID 翻成显示名（与 `biomeTag` 同形：带分组前缀）', () => {
  // 分组前缀（`特殊·`）是**有意留着**的：同一个显示名可能出现在两个组里（水域在"特殊"、
  // 湿地在"植被"），去掉前缀就分不清是哪一个。群系那一条规则一直就是这么显示的。
  assert.equal(
    describeClause({ key: 'terrainTag', op: 'in', value: ['aquatic'] }, context),
    '特殊·水域 类的地形',
    '回显里绝不能出现 aquatic 这个 slug',
  )
  assert.equal(describeClause({ key: 'terrainTag', op: 'in', value: [] }, context), '地形标签还没选')
})