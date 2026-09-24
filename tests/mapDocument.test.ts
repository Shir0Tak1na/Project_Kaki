/**
 * 地图文档模型与文件文本层的单元测试。
 * 覆盖策略：结构性错误必须拒绝；单条目错误必须只跳过该条目并告警；未知字段必须保留。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAP_DOCUMENT_VERSION,
  createEmptyMapDocument,
  parseMapDocument,
  serializeMapDocument,
  summarizeMapDocument,
  type MapDocument,
} from '../src/data/mapDocument.ts'
import {
  MAP_FILE_TYPE,
  defaultMapNameFromPath,
  extractFrontmatterBlock,
  extractJsonBlock,
  isMapFileContent,
  parseFrontmatter,
  readMapDocumentFromFileContent,
  serializeMapFile,
} from '../src/data/mapFile.ts'

function validRaw(): Record<string, unknown> {
  return {
    version: MAP_DOCUMENT_VERSION,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: { '0_0': { t: 'mountain' }, '1_-1': { t: 'forest', f: 1, c: '#123456' } },
    paths: [{ id: 'p1', type: 'river', pts: [[0, 0], [10, 20]], width: 4, color: '#53dfdd', taper: true }],
    regions: [{ id: 'r1', label: '北境', pts: [[0, 0], [10, 0], [10, 10]], color: '#44cf6e', opacity: 0.5 }],
    markers: [{ id: 'm1', label: '龙脊山脉', p: [5, 6], icon: 'mountain-peak', link: 'Locations/龙脊.md' }],
    labels: [{ id: 'l1', text: '此处有龙', p: [1, 2], size: 24, bold: true }],
  }
}

// ---------------------------------------------------------------- 解析

test('合法文档可完整解析', () => {
  const result = parseMapDocument(validRaw())
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
  const doc = result.document!
  assert.equal(doc.grid.orientation, 'pointy')
  assert.equal(Object.keys(doc.terrain).length, 2)
  assert.equal(doc.terrain['1_-1']!.f, 1)
  assert.equal(doc.markers[0]!.icon, 'mountain-peak')
  assert.equal(doc.markers[0]!.link, 'Locations/龙脊.md')
  assert.equal(doc.paths[0]!.taper, true)
})

test('坐标同时接受 [x, y] 与 {x, y} 两种写法', () => {
  const raw = validRaw()
  raw.markers = [
    { id: 'm1', label: 'A', p: [1, 2], icon: 'city' },
    { id: 'm2', label: 'B', p: { x: 3, y: 4 }, icon: 'city' },
  ]
  const doc = parseMapDocument(raw).document!
  assert.deepEqual(doc.markers.map((m) => m.p), [[1, 2], [3, 4]])
})

test('结构性错误必须拒绝加载', () => {
  const cases: Array<[string, unknown]> = [
    ['不是对象', 42],
    ['缺少 version', { grid: { kind: 'hex', orientation: 'pointy', size: 40 } }],
    ['version 非整数', { version: 1.5, grid: { kind: 'hex', orientation: 'pointy', size: 40 } }],
    ['grid 缺失', { version: 1 }],
    ['grid.kind 不支持', { version: 1, grid: { kind: 'square', orientation: 'pointy', size: 40 } }],
    ['grid.size 非法', { version: 1, grid: { kind: 'hex', orientation: 'pointy', size: 0 } }],
    ['orientation 非法', { version: 1, grid: { kind: 'hex', orientation: 'diagonal', size: 40 } }],
  ]
  for (const [label, input] of cases) {
    const result = parseMapDocument(input)
    assert.equal(result.ok, false, label)
    assert.equal(result.document, null, label)
    assert.ok(result.issues.some((issue) => issue.level === 'error'), label)
  }
})

test('版本高于当前支持时必须拒绝（只读打开，绝不写回）', () => {
  const result = parseMapDocument({ ...validRaw(), version: MAP_DOCUMENT_VERSION + 1 })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.message.includes('高于本插件支持')))
})

test('单条目错误只跳过该条目并告警，其余数据保持可用', () => {
  const raw = validRaw()
  raw.terrain = {
    '0_0': { t: 'mountain' },
    badKey: { t: 'forest' },
    // 未知地形：**保留**（只告警）。丢掉它 = 用户一保存就永久删数据，见下一个测试
    '1_1': { t: 'nonexistent-terrain' },
    // 完全不可能当 ID 的值（不是字符串、空串、带空白）才跳过
    '3_3': { t: 42 },
    '4_4': { t: '' },
    '5_5': { t: 'has space' },
    '2_2': { t: 'water' },
  }
  raw.markers = [
    { id: 'm1', label: '好标记', p: [0, 0], icon: 'city' },
    { id: 'm2', p: [1, 1], icon: 'city' },
    { id: 'm1', label: '重复 id', p: [2, 2], icon: 'city' },
    { id: 'm3', label: '未知图标', p: [3, 3], icon: 'spaceship' },
  ]
  raw.regions = [
    { id: 'r1', pts: [[0, 0], [1, 1]], color: '#fff' },
    { id: 'r2', pts: [[0, 0], [1, 0], [1, 1]], color: '#fff' },
  ]

  const result = parseMapDocument(raw)
  assert.equal(result.ok, true)
  const doc = result.document!

  assert.deepEqual(Object.keys(doc.terrain).sort(), ['0_0', '1_1', '2_2'])
  assert.deepEqual(doc.markers.map((m) => m.id), ['m1', 'm3'])
  assert.equal(doc.markers[1]!.icon, 'spaceship', '未知图标必须原样保留（改写成 town = 下次保存就永久改了数据）')
  assert.deepEqual(doc.regions.map((r) => r.id), ['r2'], '顶点不足 3 个的区域应被跳过')

  const warnings = result.issues.filter((issue) => issue.level === 'warning')
  assert.ok(warnings.length >= 5, `应有多条告警，实际 ${warnings.length}`)
  assert.ok(warnings.every((issue) => issue.path.length > 0), '告警必须带字段路径')
})

test('未知地形必须被保留并告警（丢弃会在下次保存时永久删掉用户的数据）', () => {
  const raw = validRaw()
  raw.terrain = {
    '0_0': { t: 'custom:dragon' }, // 本机设置里可能没有，但数据要活着
    '1_0': { t: 'forest' },
    '2_0': { t: '别人的地形' }, // 既不是内置也不是 custom: 命名空间 → 额外告警
  }

  const result = parseMapDocument(raw)
  assert.equal(result.ok, true, '未知地形不能让整份文档加载失败')
  const doc = result.document!

  assert.deepEqual(
    Object.keys(doc.terrain).sort(),
    ['0_0', '1_0', '2_0'],
    '三种都要在：内置、custom: 命名空间、完全外来的 ID',
  )

  // 往返：序列化再解析一次，ID 原样不动
  const text = serializeMapDocument(doc, 2)
  const again = parseMapDocument(JSON.parse(text) as unknown)
  assert.equal(again.ok, true)
  assert.equal(again.document!.terrain['0_0']!.t, 'custom:dragon')
  assert.equal(again.document!.terrain['2_0']!.t, '别人的地形')

  // 告警：`custom:` 命名空间的 ID 由绘制层负责判断"设置里有没有"（解析层读不到设置），
  // 所以这里只有"完全外来"的那一个告警
  const warnings = result.issues.filter((issue) => issue.level === 'warning' && issue.path.endsWith('.t'))
  assert.equal(warnings.length, 1, `只应有一条地形告警，实际 ${JSON.stringify(warnings.map((w) => w.message))}`)
  assert.ok(warnings[0]!.message.includes('已保留'), warnings[0]!.message)
})

test('未知标记图标必须被保留并告警（与未知地形同一条承诺）', () => {
  const raw = validRaw()
  raw.markers = [
    { id: 'm1', label: '内置', p: [0, 0], icon: 'city' },
    { id: 'm2', label: '自定义命名空间', p: [1, 0], icon: 'custom:lighthouse' },
    { id: 'm3', label: '外来的', p: [2, 0], icon: 'spaceship' },
    // 不是合法字符串（空串 / 带空白 / 非字符串）才是真的用不了 → 回退 town
    { id: 'm4', label: '空图标', p: [3, 0], icon: '' },
    { id: 'm5', label: '数字图标', p: [4, 0], icon: 42 },
  ]

  const result = parseMapDocument(raw)
  assert.equal(result.ok, true, '未知图标不能让整份文档加载失败')
  const doc = result.document!

  assert.deepEqual(
    doc.markers.map((marker) => marker.icon),
    ['city', 'custom:lighthouse', 'spaceship', 'town', 'town'],
  )

  // 往返：序列化再解析一次，外来 ID 一个字节都不能变 —— 这条就是"下次保存会不会删数据"的答案
  const text = serializeMapDocument(doc, 2)
  assert.ok(text.includes('"spaceship"'), '序列化结果里必须还有原来的图标名')
  const again = parseMapDocument(JSON.parse(text) as unknown)
  assert.equal(again.ok, true)
  assert.equal(again.document!.markers[2]!.icon, 'spaceship')

  // 告警只有"完全外来"的那一条：`custom:` 是否已定义由绘制层判断（解析层读不到设置），
  // 而"空串/非字符串"是另一类原因（不是合法标识），不该被算成"未知图标"
  const warnings = result.issues.filter((issue) => issue.level === 'warning' && issue.path.endsWith('.icon'))
  const unknownWarnings = warnings.filter((issue) => issue.message.includes('未知图标'))
  assert.equal(
    unknownWarnings.length,
    1,
    `只应有一条"未知图标"告警，实际 ${JSON.stringify(warnings.map((w) => w.message))}`,
  )
  assert.ok(unknownWarnings[0]!.message.includes('已保留'), unknownWarnings[0]!.message)
  assert.ok(unknownWarnings[0]!.message.includes('spaceship'), '告警要指明是哪个值，否则用户无从排查')

  // 非字符串那一类走"回退为 town"，且原因与"未知图标"区分开
  const fallbackWarnings = warnings.filter((issue) => issue.message.includes('已回退为 town'))
  assert.equal(fallbackWarnings.length, 2, JSON.stringify(warnings.map((w) => w.message)))
})

test('opacity 会被收敛到 0..1', () => {
  const raw = validRaw()
  raw.regions = [
    { id: 'r1', pts: [[0, 0], [1, 0], [1, 1]], color: '#fff', opacity: 5 },
    { id: 'r2', pts: [[0, 0], [1, 0], [1, 1]], color: '#fff', opacity: -3 },
  ]
  const doc = parseMapDocument(raw).document!
  assert.equal(doc.regions[0]!.opacity, 1)
  assert.equal(doc.regions[1]!.opacity, 0)
})

test('未知顶层字段必须原样保留（前向兼容）', () => {
  const raw = { ...validRaw(), futureFeature: { a: 1, b: ['x'] }, another: 7 }
  const result = parseMapDocument(raw)
  assert.equal(result.ok, true)
  assert.deepEqual(result.document!.extra, { futureFeature: { a: 1, b: ['x'] }, another: 7 })

  // 序列化后必须仍在，且再次解析仍然一致
  const text = serializeMapDocument(result.document!)
  const again = parseMapDocument(JSON.parse(text)).document!
  assert.deepEqual(again.extra, result.document!.extra)

  // 未知字段不得覆盖已知字段
  const sneaky = parseMapDocument({ ...validRaw(), version: 1, futureFeature: 1 })
  assert.equal(sneaky.document!.version, 1)
})

// ---------------------------------------------------------------- 序列化

test('地形按键排序后序列化，保证 Git diff 稳定', () => {
  const doc = createEmptyMapDocument({})
  doc.terrain = {
    '5_0': { t: 'water' },
    '0_1': { t: 'forest' },
    '-2_1': { t: 'hills' },
    '3_-1': { t: 'desert' },
  }
  const text = serializeMapDocument(doc)
  const keys = [...text.matchAll(/^\s*"(-?\d+_-?\d+)":/gm)].map((m) => m[1])
  assert.deepEqual(keys, ['3_-1', '5_0', '-2_1', '0_1'])
  // 每格一行：便于 Git diff 与手工修改
  assert.equal(text.split('\n').filter((line) => /^\s*"-?\d+_-?\d+":/.test(line)).length, 4)
})

test('序列化 → 解析 往返保持等价', () => {
  const original = parseMapDocument(validRaw()).document!
  const roundTripped = parseMapDocument(JSON.parse(serializeMapDocument(original))).document!
  assert.deepEqual(roundTripped, original)
})

test('空地图的默认值与统计', () => {
  const doc = createEmptyMapDocument({ size: 25, orientation: 'flat' })
  assert.equal(doc.version, MAP_DOCUMENT_VERSION)
  assert.equal(doc.grid.size, 25)
  assert.equal(doc.grid.orientation, 'flat')
  assert.equal(Object.keys(doc.terrain).length, 0)

  doc.terrain = { '0_0': { t: 'forest' }, '1_0': { t: 'forest' }, '2_0': { t: 'water' } }
  const summary = summarizeMapDocument(doc)
  assert.equal(summary.cells, 3)
  assert.deepEqual(summary.terrainBreakdown[0], { type: 'forest', count: 2 })
  assert.deepEqual(summary.terrainBreakdown[1], { type: 'water', count: 1 })
})

// ---------------------------------------------------------------- 文件文本层

test('可提取并解析 frontmatter', () => {
  const content = [
    '---',
    'type: fictional-cartographer-map',
    'fc-version: 1',
    'name: "艾尔登大陆"',
    'cssclasses: [wide, map]',
    'canvases:',
    '  - "Maps/World.canvas"',
    '  - "Maps/Alt.canvas"',
    'tags:',
    '  - worldbuilding',
    '---',
    '',
    '# 标题',
  ].join('\n')

  const block = extractFrontmatterBlock(content)
  assert.ok(block !== null)
  const frontmatter = parseFrontmatter(block!)
  assert.equal(frontmatter.type, MAP_FILE_TYPE)
  assert.equal(frontmatter.fcVersion, 1)
  assert.equal(frontmatter.name, '艾尔登大陆')
  assert.deepEqual(frontmatter.canvases, ['Maps/World.canvas', 'Maps/Alt.canvas'])
  assert.deepEqual(frontmatter.rest.cssclasses, ['wide', 'map'])
  assert.deepEqual(frontmatter.rest.tags, ['worldbuilding'])
  assert.equal(isMapFileContent(content), true)
})

test('含逗号的路径在 inline 列表里不会被切错', () => {
  const block = 'canvases: ["Maps/a,b.canvas", "Maps/c.canvas"]'
  assert.deepEqual(parseFrontmatter(block).canvases, ['Maps/a,b.canvas', 'Maps/c.canvas'])
})

test('可提取 JSON 代码块（含 CRLF 与缩进）', () => {
  const content = ['---', 'type: x', '---', '', '```json', '{ "a": 1 }', '```', ''].join('\r\n')
  const block = extractJsonBlock(content)
  assert.ok(block !== null)
  assert.equal(JSON.parse(block!.text).a, 1)
})

test('没有 JSON 代码块时返回 null', () => {
  assert.equal(extractJsonBlock('no fence here'), null)
  assert.equal(readMapDocumentFromFileContent('# 只有正文').text, null)
})

test('serializeMapFile 的输出可被自己解析回来', () => {
  const doc = parseMapDocument(validRaw()).document!
  const text = serializeMapFile({
    name: '艾尔登大陆',
    document: doc,
    canvases: ['Maps/World.canvas'],
    extraFrontmatter: { cssclasses: ['wide'], tags: ['worldbuilding'] },
  })

  assert.equal(isMapFileContent(text), true)
  const block = extractFrontmatterBlock(text)!
  const frontmatter = parseFrontmatter(block)
  assert.equal(frontmatter.name, '艾尔登大陆')
  assert.deepEqual(frontmatter.canvases, ['Maps/World.canvas'])
  assert.deepEqual(frontmatter.rest.cssclasses, ['wide'])

  const json = extractJsonBlock(text)!
  const parsed = parseMapDocument(JSON.parse(json.text))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.document, doc)
})

test('未绑定时序列化为空列表', () => {
  const doc = createEmptyMapDocument({})
  const text = serializeMapFile({ name: '空图', document: doc, canvases: [] })
  assert.ok(text.includes('canvases: []'))
  assert.deepEqual(parseFrontmatter(extractFrontmatterBlock(text)!).canvases, [])
})

test('由路径推断默认地图名', () => {
  assert.equal(defaultMapNameFromPath('Maps/World.map.md'), 'World')
  assert.equal(defaultMapNameFromPath('Maps/World.md'), 'World')
  assert.equal(defaultMapNameFromPath('World.map.md'), 'World')
})

test('地图文档类型标记不会被普通笔记误判', () => {
  const notMine = ['---', 'type: note', '---', '```json', '{}', '```'].join('\n')
  assert.equal(isMapFileContent(notMine), false)
  assert.equal(isMapFileContent('# 无 frontmatter'), false)
})

// ---------------------------------------------------------------- 综合

test('带完整内容的文档序列化体积在预期量级', () => {
  const doc: MapDocument = createEmptyMapDocument({ size: 40 })
  for (let r = -40; r < 40; r++) {
    for (let q = -40; q < 40; q++) {
      doc.terrain[`${q}_${r}`] = { t: 'forest' }
    }
  }
  const text = serializeMapDocument(doc)
  const perCell = Buffer.byteLength(text) / 6400
  // 实测：每格约 28 字节（JSON.stringify(x,null,2) 的写法是 42.6 字节，故改用自定义地形序列化）。
  // 据此 1 万格约 280 KB，落在设计文档 §6 的预估量级内。
  assert.ok(perCell > 20 && perCell < 32, `每格 ${perCell.toFixed(1)} 字节`)
  assert.equal(Object.keys(parseMapDocument(JSON.parse(text)).document!.terrain).length, 6400)
})
