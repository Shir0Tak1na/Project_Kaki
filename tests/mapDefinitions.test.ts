/**
 * 定义集（地图文件 v2 的 `definitions` 块）的单元测试。
 *
 * 这一层最值钱的几条承诺，也就是本文件的重点：
 * 1. **老图一个字节都不动** —— 没有 `definitions` 的文档序列化回去时不能多出这个键；
 * 2. **文件是权威** —— 有 `definitions` 就以它为准（缺的那一类沿用快照只是给手写块留的安全网）；
 * 3. **五类都写** —— 空的写成 `[]`，否则"删掉最后一个自定义项"会被库级快照顶回来；
 * 4. **不认识的分类原样带走** —— 改一个颜色不该删掉别的版本写下的段。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  definitionSetFromBlock,
  definitionSetFromDocument,
  definitionSetFromLibrary,
  definitionsBlockOf,
  isEmptyDefinitionSet,
  isFactoryDefinitionSet,
} from '../src/data/mapDefinitions.ts'
import { createEmptyMapDocument, parseMapDocument, serializeMapDocument } from '../src/data/mapDocument.ts'

/** 库级设置那一份目录里"有自定义地形 + 一条自定义路径类型"的最小样本 */
const LIBRARY = {
  customTerrains: [{ id: 'custom:reef', label: '礁石', color: '#123456' }],
  customMarkers: [],
  customBiomes: [],
  pathTypes: [],
  regionTypes: [],
}

test('库级快照：自定义整表带走，路径 / 区域类型补上内置项', () => {
  const set = definitionSetFromLibrary(LIBRARY)
  assert.equal(set.terrains.length, 1)
  assert.equal(set.terrains[0]?.id, 'custom:reef')
  // 内置 4 种 + 内置 6 种：文件里带着它们（参数可改），"这张图用的是哪套线宽"才是完整的
  assert.equal(set.pathTypes.length, 4)
  assert.equal(set.regionTypes.length, 6)
  assert.equal(set.markers.length, 0)
})

test('库级快照：坏输入不抛异常，退回"内置 + 空"', () => {
  const set = definitionSetFromLibrary({})
  assert.deepEqual(set.terrains, [])
  assert.deepEqual(set.markers, [])
  assert.equal(set.pathTypes.length, 4)
  assert.equal(isEmptyDefinitionSet(set), false, '路径 / 区域内置项让它永远不为空')
})

test('出厂判据：内置项都在但参数没改过 = 出厂；改过哪怕一条就不是', () => {
  // 这条判据是 W4-3 导出的守门。为什么要换判据：定义随图之后定义集里**总是**带着内置的
  // 路径 / 区域类型（整套目录），于是"四类都空"这条老判据永远为假 ——
  // 真正该拦的是"这份定义集跟出厂一模一样，搬过去等于什么都没搬"（写个空文件更糟）。
  const factory = definitionSetFromLibrary({})
  assert.equal(isFactoryDefinitionSet(factory), true)
  assert.equal(isEmptyDefinitionSet(factory), false, '所以老判据拦不住出厂集 —— 这就是要换判据的原因')

  // 一条自定义地形 → 不是出厂
  assert.equal(isFactoryDefinitionSet(definitionSetFromLibrary(LIBRARY)), false)

  // 只改内置路径类型里的一条线宽 → 也不是出厂（"搬我调好的线宽"正是这个功能最要紧的用法）
  const tweaked = {
    ...factory,
    pathTypes: factory.pathTypes.map((entry, index) =>
      index === 0 ? { ...entry, params: { ...entry.params, width: 16 } } : entry,
    ),
  }
  assert.equal(isFactoryDefinitionSet(tweaked), false)

  // 只改内置区域类型里的一条填充色 → 同样不是出厂
  const tinted = {
    ...factory,
    regionTypes: factory.regionTypes.map((entry, index) =>
      index === 0 ? { ...entry, params: { ...entry.params, color: '#ff0000' } } : entry,
    ),
  }
  assert.equal(isFactoryDefinitionSet(tinted), false)
})

test('v1 老图：没有 definitions 就用快照（读时不回写，靠这条保证"一个字节都不动"）', () => {
  const fallback = definitionSetFromLibrary(LIBRARY)
  const fromOld = definitionSetFromDocument({ definitions: undefined }, fallback)
  assert.equal(fromOld, fallback, '必须原样返回快照那一份（不是再规范化一遍）')
  assert.equal(definitionSetFromDocument(null, fallback), fallback)
})

test('v2 地图：以文件为准；块里缺的分类沿用快照，不悄悄退回内置', () => {
  const fallback = definitionSetFromLibrary(LIBRARY)
  // 块里只有地形（用户只改过地形这一类）
  const set = definitionSetFromDocument(
    { definitions: { terrains: [{ id: 'custom:swamp2', label: '沼泽地', color: '#00ff00' }] } },
    fallback,
  )
  assert.equal(set.terrains.length, 1)
  assert.equal(set.terrains[0]?.id, 'custom:swamp2')
  // 缺的那几类仍是快照里的内容 —— 否则老图一升级就丢掉了库级设置里的自定义定义
  assert.equal(set.markers.length, fallback.markers.length)
  assert.equal(set.pathTypes.length, fallback.pathTypes.length)
})

test('v2 地图：块里明确写了空数组 = 这张图就是没有那一类', () => {
  const fallback = definitionSetFromLibrary(LIBRARY)
  const set = definitionSetFromBlock({ terrains: [], markers: [], biomes: [], pathTypes: [], regionTypes: [] }, fallback)
  assert.deepEqual(set.terrains, [], '写了空数组就该是空的，不能回退到快照')
  // 路径类型是特例：内置 4 种写在代码里，所以"空数组"= 这张图没有自定义路径类型（= 只剩内置 4 种），
  // 而不是"沿用快照那一份" —— 后者只有**键整个缺失**时才会发生。
  assert.equal(set.pathTypes.length, 4)
  assert.equal(set.pathTypes.length === fallback.pathTypes.length, true)
})

test('写回：五类**都写**（空的写成 []）—— 否则"删掉最后一个自定义项"会被库级快照顶回来', () => {
  const block = definitionsBlockOf({
    terrains: [],
    markers: [],
    biomes: [],
    pathTypes: [],
    regionTypes: [],
  })
  // 五个键都在（空数组也是明确的一句"这一类没有"）
  assert.deepEqual(Object.keys(block).sort(), ['biomes', 'markers', 'pathTypes', 'regionTypes', 'terrains'])
  assert.deepEqual(block.terrains, [])
  assert.equal(isEmptyDefinitionSet({ terrains: [], markers: [], biomes: [], pathTypes: [], regionTypes: [] }), true)
})

test('写回：路径 / 区域类型的内置项跟着走（"这张图用的是哪套线宽"才是完整的）', () => {
  const set = definitionSetFromLibrary(LIBRARY)
  const block = definitionsBlockOf(set)
  assert.equal((block.terrains ?? []).length, 1)
  assert.deepEqual(block.markers, [], '空的也写出来，不是"不留键"')
  assert.equal((block.pathTypes ?? []).length, 4)
  assert.equal((block.regionTypes ?? []).length, 6)
})

test('写回：本插件不认识的分类（extra）原样带走 —— 改一个颜色不该删掉别的版本写下的段', () => {
  const set = definitionSetFromLibrary(LIBRARY)
  const block = definitionsBlockOf(set, { extra: { weathers: [{ id: 'custom:rain' }] } })
  assert.deepEqual(block.extra, { weathers: [{ id: 'custom:rain' }] })
  // 往返之后那段仍在文件里
  const document = createEmptyMapDocument({ definitions: block })
  const parsed = parseMapDocument(JSON.parse(serializeMapDocument(document)))
  assert.deepEqual(parsed.document?.definitions?.extra, { weathers: [{ id: 'custom:rain' }] })
})

test('删掉最后一个自定义地形之后，读回来仍然是空的（不被库级快照顶回来）', () => {
  const fallback = definitionSetFromLibrary(LIBRARY)
  // 写下来的块：五类都在，地形是空表
  const block = definitionsBlockOf({ ...fallback, terrains: [] })
  const set = definitionSetFromDocument({ definitions: block }, fallback)
  assert.deepEqual(set.terrains, [], '空表就是空表 —— 库级快照里那条 custom:reef 不该复活')
})

test('往返：serialize ⇄ parse 保真（定义不许在保存一次之后变形）', () => {
  const set = definitionSetFromLibrary(LIBRARY)
  const document = createEmptyMapDocument({ definitions: definitionsBlockOf(set) })
  const text = serializeMapDocument(document)
  const parsed = parseMapDocument(JSON.parse(text))
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues))
  const block = parsed.document?.definitions
  assert.equal((block?.terrains ?? []).length, 1)
  assert.equal((block?.terrains?.[0] as { id?: string } | undefined)?.id, 'custom:reef')
  assert.equal(parsed.document?.version, 2)
})

test('老图不被升版：v1 文档序列化后**没有** definitions 这个键', () => {
  const legacy = {
    version: 1,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: {},
    paths: [],
    regions: [],
    markers: [],
    labels: [],
  }
  const parsed = parseMapDocument(legacy)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.document?.definitions, undefined, 'v1 文件里没有这一段 ⇒ 内存里也不该有')
  const text = serializeMapDocument(parsed.document!)
  assert.equal(text.includes('"definitions"'), false, '序列化回去不该凭空多出这一段')
  assert.equal(text.includes('"version": 1'), true, '版本保持原样（只有用户真的改定义才升版）')
})

test('前向保护没被破坏：版本高于支持值的文件仍然拒绝加载', () => {
  const parsed = parseMapDocument({
    version: 99,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
  })
  assert.equal(parsed.ok, false)
  assert.match(parsed.issues[0]?.message ?? '', /高于本插件支持的/)
})

test('坏形状的 definitions：给 warning 并按"没有这一节"处理，不猜一份定义', () => {
  const parsed = parseMapDocument({
    version: 2,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    definitions: 'nope',
    terrain: {},
    paths: [],
    regions: [],
    markers: [],
    labels: [],
  })
  assert.equal(parsed.ok, true, '整份文件仍然可读')
  assert.equal(parsed.document?.definitions, undefined)
  assert.ok(parsed.issues.some((issue) => issue.path === 'definitions' && issue.level === 'warning'))
})

test('definitions 里的未知分类原样保留（给未来的数据类型留窗口）', () => {
  const parsed = parseMapDocument({
    version: 2,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    definitions: { terrains: [{ id: 'custom:reef', label: '礁石' }], weathers: [{ id: 'custom:rain' }] },
  })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.document?.definitions?.extra, { weathers: [{ id: 'custom:rain' }] }, JSON.stringify(parsed.document?.definitions))
  const text = serializeMapDocument(parsed.document!)
  assert.ok(text.includes('"weathers"'), text)
})