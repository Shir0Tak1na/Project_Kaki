/**
 * Base 视图数据层单元测试。
 *
 * 这里测的都是"看起来显然、写错了却很难查"的东西：
 * 坐标三种写法的解析、未知图标名的收敛、没有坐标的条目排序时的位置、
 * 以及两个来源合并后不能出现重复或丢失。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import {
  buildMapRows,
  noteRowsAsMarkers,
  rowsFromDocument,
  rowsFromNotes,
  sortRows,
  summarizeRows,
  type MapRow,
} from '../src/base/mapRows.ts'
import { buildMapExportSvg, buildMapPreviewSvg } from '../src/base/mapPreview.ts'
import { iconOrDefault, normalizeMarkerIcon, parseCoordinateValue, parseNoteMapProps } from '../src/base/noteCoordinates.ts'
import { buildStarterBaseFile } from '../src/base/starterBase.ts'
import { TERRAIN_STYLES } from '../src/render/terrainStyle.ts'
import { BASES_VIEW_TYPE, OPTION_KEYS } from '../src/base/viewContract.ts'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'

// ---------------------------------------------------------------- 坐标解析

test('坐标：数组、对象、字符串三种写法都能解析', () => {
  assert.deepEqual(parseCoordinateValue([320, -140]), { x: 320, y: -140 })
  assert.deepEqual(parseCoordinateValue(['320', '-140']), { x: 320, y: -140 })
  assert.deepEqual(parseCoordinateValue({ x: 320, y: -140 }), { x: 320, y: -140 })
  assert.deepEqual(parseCoordinateValue('320, -140'), { x: 320, y: -140 })
  assert.deepEqual(parseCoordinateValue('320 -140'), { x: 320, y: -140 })
  assert.deepEqual(parseCoordinateValue('(320, -140)'), { x: 320, y: -140 })
  assert.deepEqual(parseCoordinateValue('[320,-140]'), { x: 320, y: -140 })
  // 小数与负数
  assert.deepEqual(parseCoordinateValue('0.5,-0.25'), { x: 0.5, y: -0.25 })
})

test('坐标：基斯的 ListValue 形态（鸭子类型）也能解析', () => {
  // 复刻 ListValue：length() + get(i)，元素是带 toString 的 Value
  const makeValue = (n: number) => ({ toString: () => String(n) })
  const list = {
    length: () => 2,
    get: (index: number) => (index === 0 ? makeValue(320) : makeValue(-140)),
  }
  assert.deepEqual(parseCoordinateValue(list), { x: 320, y: -140 })

  // 长度不足 2 的列表必须被判为无效，而不是补 0
  const tooShort = { length: () => 1, get: () => makeValue(5) }
  assert.equal(parseCoordinateValue(tooShort), null)
})

test('坐标：解析失败一律返回 null，绝不返回 NaN 或 (0,0)', () => {
  assert.equal(parseCoordinateValue(null), null)
  assert.equal(parseCoordinateValue(undefined), null)
  assert.equal(parseCoordinateValue(''), null)
  assert.equal(parseCoordinateValue('这里没有坐标'), null)
  assert.equal(parseCoordinateValue('320'), null, '只有一个数不能当成 x')
  assert.equal(parseCoordinateValue([Number.NaN, 3]), null)
  assert.equal(parseCoordinateValue(['a', 'b']), null)
  assert.equal(parseCoordinateValue({ x: 1 }), null)
  // 关键：不能悄悄返回 (0,0) —— 那会在世界原点堆出一堆假标记
  assert.notDeepEqual(parseCoordinateValue('??'), { x: 0, y: 0 })
})

test('图标名收敛：未知名字退化为默认，而不是让整条记录失效', () => {
  assert.equal(normalizeMarkerIcon('city'), 'city')
  assert.equal(normalizeMarkerIcon('City'), 'city', '大小写不敏感')
  assert.equal(normalizeMarkerIcon('  port '), 'port')
  assert.equal(normalizeMarkerIcon('不存在的图标'), null)
  assert.equal(normalizeMarkerIcon(undefined), null)
  assert.equal(iconOrDefault(parseNoteMapProps({ coordinates: [1, 2], mapType: '不存在的图标' })), 'town')
  assert.equal(iconOrDefault(parseNoteMapProps({ coordinates: [1, 2], mapType: 'ruin' })), 'ruin')
})

test('笔记属性：有坐标但解析失败必须被标记为 invalid（不能静默忽略）', () => {
  const good = parseNoteMapProps({ coordinates: [1, 2], mapType: 'city', region: '北境' })
  assert.equal(good.invalid, false)
  assert.deepEqual(good.point, { x: 1, y: 2 })
  assert.equal(good.region, '北境')

  const malformed = parseNoteMapProps({ coordinates: '东边那座城' })
  assert.equal(malformed.invalid, true, '用户写错了要说出来，否则只会看到"标记不见了"')
  assert.equal(malformed.point, null)

  const missing = parseNoteMapProps({})
  assert.equal(missing.invalid, false, '完全没写坐标不算错误')
  assert.equal(missing.point, null)
})

// ---------------------------------------------------------------- 行模型

function makeDocument(): MapDocument {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.markers.push({ id: 'm1', label: '龙脊城', p: [100, 50], icon: 'city', link: 'Locations/龙脊城.md' })
  doc.labels.push({ id: 'l1', text: '迷雾海', p: [-200, -100], link: 'Locations/迷雾海.md' })
  doc.paths.push({
    id: 'p1',
    type: 'river',
    pts: [
      [0, 0],
      [100, 0],
      [100, 100],
    ],
    width: 8,
    color: '#4a9fd8',
    label: '北境商路',
    link: 'Routes/北境商路.md',
  })
  doc.regions.push({ id: 'r1', label: '北境领', pts: [[0, 0], [100, 0], [100, 100], [0, 100]], color: '#44cf6e', opacity: 0.22, link: 'Regions/北境领.md' })
  doc.regions.push({ id: 'r2', label: '', pts: [[500, 0], [600, 0], [600, 100]], color: '#44cf6e', opacity: 0.22 })
  return doc
}

test('地图文档 → 行：四类条目都在，路径与区域用代表性坐标', () => {
  const rows = rowsFromDocument(makeDocument(), 'Maps/World.map.md')
  assert.equal(rows.length, 5)
  const byId = new Map(rows.map((row) => [row.id, row]))

  assert.equal(byId.get('map:marker:m1')?.name, '龙脊城')
  assert.deepEqual(byId.get('map:marker:m1')?.point, { x: 100, y: 50 })
  assert.equal(byId.get('map:marker:m1')?.filePath, 'Locations/龙脊城.md')
  assert.equal(byId.get('map:label:l1')?.kind, 'label')
  assert.equal(byId.get('map:label:l1')?.filePath, 'Locations/迷雾海.md')
  assert.equal(byId.get('map:path:p1')?.name, '北境商路')
  assert.equal(byId.get('map:path:p1')?.detail, '河流 · 3 点')
  assert.equal(byId.get('map:path:p1')?.filePath, 'Routes/北境商路.md')
  assert.equal(byId.get('map:region:r1')?.name, '北境领')
  assert.equal(byId.get('map:region:r1')?.filePath, 'Regions/北境领.md')

  // 路径的代表点 = 弧长中点。这条折线两段各长 100，总长 200，
  // 弧长 100 恰好落在拐点 (100,0) 上 —— 不是"第二个顶点"也不是"两段各自的中点"。
  assert.deepEqual(byId.get('map:path:p1')?.point, { x: 100, y: 0 })
  // 区域 = 质心
  assert.deepEqual(byId.get('map:region:r1')?.point, { x: 50, y: 50 })

  // 未命名的条目要有可读的占位，而不是空字符串
  assert.equal(byId.get('map:region:r2')?.name, '（未命名区域）')
  assert.ok((byId.get('map:region:r2')?.name.length ?? 0) > 0)
})

test('笔记 → 行：缺坐标的笔记仍然入表（只是没有坐标）', () => {
  const rows = rowsFromNotes([
    { path: 'Locations/龙脊城.md', name: '龙脊城', props: parseNoteMapProps({ coordinates: [100, 50], mapType: 'city' }) },
    { path: 'Locations/无名.md', name: '无名', props: parseNoteMapProps({}) },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.detail, 'city · 100, 50')
  assert.equal(rows[1]?.detail, '缺少坐标')
  assert.equal(rows[1]?.point, null)
})

test('两个来源合并：行数正确且 id 不冲突', () => {
  const rows = buildMapRows({
    document: makeDocument(),
    mapPath: 'Maps/World.map.md',
    notes: [
      { path: 'Locations/龙脊城.md', name: '龙脊城', props: parseNoteMapProps({ coordinates: [100, 50], mapType: 'city' }) },
      { path: 'Locations/灰港.md', name: '灰港', props: parseNoteMapProps({ coordinates: '-40, 220' }) },
    ],
  })
  assert.equal(rows.length, 7)
  const ids = new Set(rows.map((row) => row.id))
  assert.equal(ids.size, rows.length, 'id 必须唯一（表格的 key 依赖它）')

  // 同名条目（笔记 + 地图标记都叫"龙脊城"）必须能区分来源
  const dragons = rows.filter((row) => row.name === '龙脊城')
  assert.equal(dragons.length, 2)
  assert.deepEqual(dragons.map((row) => row.source).sort(), ['map', 'note'])
})

test('没有地图文档时只显示笔记行（不抛异常）', () => {
  const rows = buildMapRows({
    document: null,
    mapPath: null,
    notes: [{ path: 'A.md', name: 'A', props: parseNoteMapProps({ coordinates: [0, 0] }) }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.source, 'note')
})

test('排序：坐标缺失的行排在最后，而不是被当成 0', () => {
  const rows: MapRow[] = [
    { id: 'a', source: 'map', kind: 'marker', name: '有坐标 100', point: { x: 100, y: 0 }, filePath: 'm', detail: '' },
    { id: 'b', source: 'map', kind: 'marker', name: '没坐标', point: null, filePath: 'm', detail: '' },
    { id: 'c', source: 'map', kind: 'marker', name: '有坐标 -5', point: { x: -5, y: 0 }, filePath: 'm', detail: '' },
  ]
  const ascending = sortRows(rows, 'x')
  assert.deepEqual(ascending.map((row) => row.id), ['c', 'a', 'b'])
  const descending = sortRows(rows, 'x', true)
  assert.deepEqual(descending.map((row) => row.id), ['a', 'c', 'b'], '倒序时缺坐标的仍在最后')
})

test('排序稳定且确定性：同值时按 id 兜底', () => {
  const rows: MapRow[] = [
    { id: 'z', source: 'map', kind: 'marker', name: '同名', point: { x: 1, y: 1 }, filePath: 'm', detail: '' },
    { id: 'a', source: 'map', kind: 'marker', name: '同名', point: { x: 1, y: 2 }, filePath: 'm', detail: '' },
  ]
  assert.deepEqual(sortRows(rows, 'name').map((row) => row.id), ['a', 'z'])
  assert.deepEqual(sortRows(rows, 'x').map((row) => row.id), ['a', 'z'])
})

test('统计：按来源/类型/是否有坐标/写法错误分别计数', () => {
  const rows = buildMapRows({
    document: makeDocument(),
    mapPath: 'Maps/World.map.md',
    notes: [
      { path: 'A.md', name: 'A', props: parseNoteMapProps({ coordinates: [0, 0] }) },
      { path: 'B.md', name: 'B', props: parseNoteMapProps({ coordinates: '乱写的' }) },
      { path: 'C.md', name: 'C', props: parseNoteMapProps({}) },
    ],
  })
  const summary = summarizeRows(rows)
  assert.equal(summary.total, 8)
  assert.equal(summary.notes, 3)
  assert.equal(summary.mapEntries, 5)
  assert.equal(summary.byKind.note, 3)
  assert.equal(summary.byKind.marker, 1)
  assert.equal(summary.invalidNotes, 1)
  assert.equal(summary.withCoordinates, 5 + 1, '地图 5 条 + 1 条有坐标的笔记')
})

test('笔记行 → 标记：只有带坐标的才转，且保留图标与链接', () => {
  const rows = buildMapRows({
    document: null,
    mapPath: null,
    notes: [
      { path: 'Locations/龙脊城.md', name: '龙脊城', props: parseNoteMapProps({ coordinates: [100, 50], mapType: 'city', region: '北境' }) },
      { path: 'Locations/没坐标.md', name: '没坐标', props: parseNoteMapProps({}) },
      { path: 'Locations/灰港.md', name: '灰港', props: parseNoteMapProps({ coordinates: '-40, 220' }) },
    ],
  })
  const markers = noteRowsAsMarkers(rows)
  assert.equal(markers.length, 2, '没坐标的笔记不产生标记')
  assert.deepEqual(markers[0], {
    id: 'note:Locations/龙脊城.md',
    label: '龙脊城',
    x: 100,
    y: 50,
    icon: 'city',
    link: 'Locations/龙脊城.md',
    region: '北境',
  })
  assert.equal(markers[1]?.icon, 'town', '缺 map-type 时用默认图标')
})

test('地图预览：可从地图文档和笔记标记生成稳定的 SVG 预览', () => {
  const rows = buildMapRows({
    document: makeDocument(),
    mapPath: 'Maps/World.map.md',
    notes: [{ path: 'Locations/龙脊城.md', name: '龙脊城', props: parseNoteMapProps({ coordinates: [100, 50], mapType: 'city' }) }],
  })
  const svg = buildMapPreviewSvg(makeDocument(), rows, { width: 220, height: 160 })
  assert.match(svg, /<svg[^>]*>/)
  assert.match(svg, /<polygon[^>]*points=/)
  assert.match(svg, /<polyline[^>]*points=/)
  assert.match(svg, /<circle[^>]*r="3"/)
  assert.match(svg, /data-row-id="map:region:r1"/)
  assert.match(svg, /data-row-id="map:path:p1"/)

  const polygon = svg.match(/<polygon data-row-id="map:region:r1" points="([^"]+)"/)
  assert.ok(polygon?.[1])
  // `map(Number)` 推断为 number[]，解构时每个分量是 `number | undefined`；
  // 显式标成二元组，Math.max/min 才收得下（这是 typecheck 会报错、而运行时无感的那类问题）
  const polygonPoints = polygon[1]
    .split(' ')
    .map((point) => point.split(',').map(Number) as [number, number])
  const xs = polygonPoints.map(([x]) => x)
  const ys = polygonPoints.map(([, y]) => y)
  assert.equal(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), '缩略图不能把等比例区域拉伸')
})

test('地图 SVG 导出：使用完整尺寸并保留地图几何', () => {
  const svg = buildMapExportSvg(makeDocument(), 1600, 1000)
  assert.match(svg, /<svg[^>]*width="1600"[^>]*height="1000"/)
  assert.match(svg, /<polygon[^>]*points=/)
  assert.match(svg, /<polyline[^>]*points=/)
  assert.match(svg, /data-row-id="map:marker:m1"/)
})

test('缩略图的地形配色与画布**同源**（不能自己抄一份调色板）', () => {
  // 这条断言是为了锁住一个真实缺陷：mapPreview 曾经自带一份 TERRAIN_COLORS，
  // 9 种颜色与 terrainStyle 里的**全部不同** → "Base 里看到的颜色和画布上不一样"。
  const doc = createEmptyMapDocument({ size: 40 })
  doc.terrain['0_0'] = { t: 'forest' }
  doc.terrain['1_0'] = { t: 'water' }
  const svg = buildMapPreviewSvg(doc, [], { width: 200, height: 120 })
  for (const type of ['forest', 'water'] as const) {
    assert.ok(
      svg.includes(`fill="${TERRAIN_STYLES[type].base}"`),
      `${type} 的底色应当来自 terrainStyle：${TERRAIN_STYLES[type].base}`,
    )
  }
  // 顺带确认：不是所有地形都用同一个颜色（防止"改成了常量"这种假修复）
  const plains = TERRAIN_STYLES.plains.base
  assert.notEqual(plains, TERRAIN_STYLES.forest.base)
})

test('缩略图里每个 data-row-id 只出现一次（地图元素不再被重复画一遍）', () => {
  const rows = buildMapRows({
    document: makeDocument(),
    mapPath: 'Maps/World.map.md',
    notes: [{ path: 'Locations/龙脊城.md', name: '龙脊城', props: parseNoteMapProps({ coordinates: [100, 50], mapType: 'city' }) }],
  })
  const svg = buildMapPreviewSvg(makeDocument(), rows, { width: 220, height: 160 })
  const ids = [...svg.matchAll(/data-row-id="([^"]+)"/g)].map((match) => match[1])
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(duplicates, [], `重复的 data-row-id：${duplicates.join(', ')}`)
  assert.ok(ids.includes('note:Locations/龙脊城.md'), '笔记点必须在缩略图里')
})

test('缩略图里文字标注显式给了 fill（否则深色主题下是黑字，等于看不见）', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.labels.push({ id: 'l1', text: '迷雾海', p: [10, 20], link: undefined as never })
  const svg = buildMapPreviewSvg(doc, [], { width: 200, height: 120 })
  const text = svg.match(/<text[^>]*>/)?.[0] ?? ''
  assert.ok(text.includes('fill="currentColor"'), text)
  assert.ok(text.includes('data-row-id="map:label:l1"'), text)
})

// ---------------------------------------------------------------- 起始 .base 文件

test('生成的 .base 是**合法 YAML**，且视图条目指向地图文档', () => {
  const text = buildStarterBaseFile('Maps/World.map.md')
  // 用真正的 YAML 解析器验证，而不是"看起来像"
  const parsed = parseYaml(text) as {
    views: Array<Record<string, unknown>>
  }
  assert.ok(Array.isArray(parsed.views), 'views 必须是数组')
  assert.equal(parsed.views.length, 1)
  const view = parsed.views[0]!
  assert.equal(view.type, 'fictional-map')
  assert.equal(view.name, '地图')
  assert.equal(view[OPTION_KEYS.mapFile], 'Maps/World.map.md')
  assert.equal(view[OPTION_KEYS.coordProperty], 'note.coordinates')
  assert.equal(view[OPTION_KEYS.sortBy], 'name')
  assert.deepEqual(view.order, ['file.name', 'note.map-type', 'note.region', 'note.coordinates'])
  // 不能有 tab：YAML 不允许多行里混用缩进风格，Obsidian 会直接解析失败
  assert.equal(text.includes('\t'), false, 'YAML 里不能出现制表符')
})

test('起始文件对"奇怪路径"也能生成合法 YAML', () => {
  const tricky = 'Maps/带空格 和 "引号" #井号/World.map.md'
  const parsed = parseYaml(buildStarterBaseFile(tricky)) as { views: Array<Record<string, unknown>> }
  assert.equal(parsed.views[0]![OPTION_KEYS.mapFile], tricky, '路径必须原样往返')
})
