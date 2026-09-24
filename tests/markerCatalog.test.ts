/**
 * 自定义标记图标目录的单元测试。
 *
 * 重点与地形那份一致：**认不出 ≠ 丢弃**（图标名是写进地图文件的数据），
 * 以及"三级回退永不返回 null"（任何"没有图标"的分支都会变成"某个标记消失"）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  CUSTOM_MARKER_PREFIX,
  DEFAULT_CUSTOM_MARKER_MODE,
  FALLBACK_MARKER_ICON_NAME,
  MAX_CUSTOM_MARKERS,
  isBuiltinMarkerIcon,
  listResolvedMarkerStyles,
  markerCatalogSignature,
  markerIdProblem,
  markerLabelOf,
  normalizeCustomMarkers,
  normalizeMarkerId,
  normalizeMarkerLabel,
  normalizeMarkerMode,
  resolveMarkerStyle,
  validateCustomMarkerInput,
  type CustomMarker,
} from '../src/render/markerCatalog.ts'
import { MARKER_ICONS } from '../src/data/mapDocument.ts'

const SAMPLE: CustomMarker[] = [
  { id: 'custom:lighthouse', label: '灯塔', icon: 'tower', imagePath: '', mode: 'glyph' },
  { id: 'custom:reef', label: '暗礁', icon: '', imagePath: 'Assets/reef.png', mode: 'image' },
]

test('ID 归一化：小写、自动补前缀、去掉重复前缀；非法一律拒绝并给原因', () => {
  assert.equal(normalizeMarkerId('lighthouse'), 'custom:lighthouse')
  assert.equal(normalizeMarkerId('  LightHouse  '), 'custom:lighthouse')
  assert.equal(normalizeMarkerId('custom:lighthouse'), 'custom:lighthouse')
  assert.equal(normalizeMarkerId('custom:custom:lighthouse'), 'custom:lighthouse', '重复前缀也要收敛掉')
  assert.equal(normalizeMarkerId('灯塔'), null)
  assert.equal(normalizeMarkerId('1st'), null)
  assert.equal(normalizeMarkerId('a'), null, '至少 2 个字符')
  assert.equal(normalizeMarkerId('x'.repeat(33)), null)
  assert.equal(normalizeMarkerId(null), null)

  assert.match(markerIdProblem('灯塔') ?? '', /小写字母/)
  assert.match(markerIdProblem('') ?? '', /不能为空/)
  assert.match(markerIdProblem('x'.repeat(33)) ?? '', /太长/)
  assert.equal(markerIdProblem('lighthouse'), null)
})

test('显示名：留空退化为 ID 主体、压缩空白、限长', () => {
  assert.equal(normalizeMarkerLabel('', 'custom:lighthouse'), 'lighthouse')
  assert.equal(normalizeMarkerLabel(undefined, 'custom:lighthouse'), 'lighthouse')
  assert.equal(normalizeMarkerLabel('  白色  灯塔 ', 'custom:lighthouse'), '白色 灯塔')
  assert.equal(normalizeMarkerLabel('长'.repeat(40), 'custom:lighthouse').length, 24)
})

test('内置判定与登记表一致（不要在这里再抄一份清单）', () => {
  for (const icon of MARKER_ICONS) assert.equal(isBuiltinMarkerIcon(icon), true, icon)
  assert.equal(isBuiltinMarkerIcon('custom:lighthouse'), false)
  assert.equal(isBuiltinMarkerIcon('nope'), false)
  assert.equal(isBuiltinMarkerIcon(42), false)
})

test('解析：内置走既有的 Lucide 映射，自定义用借来的字形或回退图钉', () => {
  const city = resolveMarkerStyle('city', SAMPLE)
  assert.equal(city.builtin, true)
  assert.equal(city.unknown, false)
  assert.ok(city.iconName.length > 0)
  assert.equal(city.imagePath, '')

  const lighthouse = resolveMarkerStyle('custom:lighthouse', SAMPLE)
  assert.equal(lighthouse.builtin, false)
  assert.equal(lighthouse.label, '灯塔')
  // 定义里写的是借 tower 的字形 → 必须与 tower 自己的字形完全一致（这条会失败，如果映射被绕开）
  assert.equal(lighthouse.iconName, resolveMarkerStyle('tower', []).iconName)
  assert.notEqual(lighthouse.iconName, '', '必须有可用的图标名')

  const reef = resolveMarkerStyle('custom:reef', SAMPLE)
  assert.equal(reef.imagePath, 'Assets/reef.png')
  assert.equal(reef.iconName, FALLBACK_MARKER_ICON_NAME, '没借字形时用回退图钉')
})

test('未知 ID：**不丢弃**，回退成看得见的占位并标记 unknown（这条是数据保全的关键）', () => {
  const style = resolveMarkerStyle('custom:gone', SAMPLE)
  assert.equal(style.unknown, true)
  assert.equal(style.builtin, false)
  assert.equal(style.iconName, FALLBACK_MARKER_ICON_NAME)
  assert.match(style.label, /未知/)
  assert.ok(style.label.includes('custom:gone'), '标签里要能看到是哪个 ID，便于排查')

  // 永不返回 null：绘制层每帧都问它，null 会让标记直接消失
  assert.notEqual(resolveMarkerStyle('', []), null)
  assert.equal(resolveMarkerStyle('', []).unknown, true)
})

test('模式：配了图片的旧数据迁移成图片模式；显式模式优先；非法值走同一条推断', () => {
  // 旧 data.json 里没有 mode 字段，只有 imagePath —— 迁移后必须与升级前**完全一致**
  assert.equal(normalizeMarkerMode(undefined, 'Assets/reef.png'), 'image')
  assert.equal(normalizeMarkerMode(undefined, ''), 'glyph')
  assert.equal(normalizeMarkerMode(null, 'Assets/reef.png'), 'image')
  // 显式值说了算：字形模式下也可以留着图片路径（用户切回来时图还在）
  assert.equal(normalizeMarkerMode('glyph', 'Assets/reef.png'), 'glyph')
  assert.equal(normalizeMarkerMode('image', ''), 'image', '图片模式即使暂时没有图，也不该被改写成字形模式')
  // 非法值按"有没有配图"推断，而不是一律落到默认值：
  // 否则"配了图但 mode 写坏了"会表现成"图明明配着却不显示"，而界面一切正常
  assert.equal(normalizeMarkerMode('坏值', 'Assets/reef.png'), 'image')
  assert.equal(normalizeMarkerMode('坏值', ''), 'glyph')
  assert.equal(DEFAULT_CUSTOM_MARKER_MODE, 'glyph', '新建默认是字形：不依赖任何外部资源')
})

test('字形模式不把图片路径交给绘制层 —— 于是"模式"只在解析处判断一次', () => {
  // 两个都配了：字形 + 图片路径都在，模式说用字形
  const both: CustomMarker[] = [
    { id: 'custom:both', label: '两者都配', icon: 'tower', imagePath: 'Assets/both.png', mode: 'glyph' },
  ]
  const glyphMode = resolveMarkerStyle('custom:both', both)
  assert.equal(glyphMode.imagePath, '', '字形模式下绘制层拿不到图片路径，就不可能去画图片')
  assert.equal(glyphMode.iconName, resolveMarkerStyle('tower', []).iconName, '画的是借来的字形，不是回退图钉')

  // 同一份定义改成图片模式：图片交出去，字形仍然可用（图片加载失败时的回退）
  const imageMode = resolveMarkerStyle('custom:both', [{ ...both[0]!, mode: 'image' }])
  assert.equal(imageMode.imagePath, 'Assets/both.png')
  assert.equal(imageMode.iconName, resolveMarkerStyle('tower', []).iconName)

  // 反过来：图片模式没有图 → 交给绘制层的是空路径，绘制层自然走字形
  const emptyImage: CustomMarker[] = [
    { id: 'custom:empty', label: '没图', icon: '', imagePath: '', mode: 'image' },
  ]
  assert.equal(resolveMarkerStyle('custom:empty', emptyImage).imagePath, '')
  assert.equal(resolveMarkerStyle('custom:empty', emptyImage).iconName, FALLBACK_MARKER_ICON_NAME)
})

test('切换模式不会清空另一个字段：配好的图与字形都留在记录里', () => {
  // 这条是用户明确要求的行为：来回切模式不该让人重配一遍
  const stored = normalizeCustomMarkers([
    { id: 'both', label: '两套都配', icon: 'tower', imagePath: 'Assets/both.png', mode: 'glyph' },
  ])[0]!
  assert.equal(stored.mode, 'glyph')
  assert.equal(stored.imagePath, 'Assets/both.png', '切到字形模式后图片路径必须还在')
  assert.equal(stored.icon, 'tower', '反过来切到图片模式时字形也必须还在')

  const switched = normalizeCustomMarkers([{ ...stored, mode: 'image' }])[0]!
  assert.equal(switched.imagePath, 'Assets/both.png')
  assert.equal(switched.icon, 'tower')
})

test('集合归一化里的模式推断与迁移（旧 data.json 只有 imagePath）', () => {
  const markers = normalizeCustomMarkers([
    { id: 'legacy', imagePath: 'Assets/old.png' },
    { id: 'plain', icon: 'port' },
  ])
  assert.equal(markers[0]!.mode, 'image', '旧数据里配了图 ⇒ 迁移成图片模式（与升级前画面一致）')
  assert.equal(markers[1]!.mode, 'glyph')
})

test('图片路径校验与地形共用同一个函数：非法扩展名在此就被拒绝并给原因', () => {
  const bad = validateCustomMarkerInput({ id: 'lighthouse', imagePath: 'Assets/notes.txt' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.problem, /png|jpg|jpeg|webp|gif|svg|avif/i)
  // 归一化里同样收敛掉（坏值当作"没有图片"，而不是留一条画不出来的路径）
  assert.equal(normalizeCustomMarkers([{ id: 'x1', imagePath: 'Assets/notes.txt' }])[0]!.imagePath, '')
  assert.equal(normalizeCustomMarkers([{ id: 'x1', imagePath: 'Assets/notes.txt' }])[0]!.mode, 'glyph')
})

test('集合归一化：逐条独立、按 ID 去重（先到先得）、坏条目只丢自己', () => {
  const markers = normalizeCustomMarkers([
    { id: 'lighthouse', label: '灯塔' },
    { id: 'custom:lighthouse', label: '重复的灯塔' },
    { id: '!!!' },
    null,
    { id: 'reef', icon: 'port', imagePath: 'Assets\\reef.png' },
    { id: 'unknown-icon', icon: 'not-a-real-icon' },
  ])
  assert.deepEqual(
    markers.map((marker) => marker.id),
    ['custom:lighthouse', 'custom:reef', 'custom:unknown-icon'],
  )
  assert.equal(markers[0]!.label, '灯塔', '重复 ID 保留先出现的那条')
  assert.equal(markers[1]!.imagePath, 'Assets/reef.png', '反斜杠统一成正斜杠（Windows 上很容易粘反）')
  assert.equal(markers[2]!.icon, '', '不存在的字形退化为通用图钉，而不是让整条定义失效')
  assert.deepEqual(normalizeCustomMarkers('nope'), [])
})

test('上限：超过就截断（设置页与工具条都要能看）', () => {
  const many = Array.from({ length: MAX_CUSTOM_MARKERS + 5 }, (_value, index) => ({ id: `m${index}` }))
  assert.equal(normalizeCustomMarkers(many).length, MAX_CUSTOM_MARKERS)
})

test('目录顺序：内置在前且顺序不变，自定义按设置顺序排在后面', () => {
  const list = listResolvedMarkerStyles(SAMPLE)
  assert.deepEqual(list.slice(0, MARKER_ICONS.length).map((item) => item.id), [...MARKER_ICONS])
  assert.deepEqual(list.slice(MARKER_ICONS.length).map((item) => item.id), SAMPLE.map((marker) => marker.id))
})

test('签名：任一字段变化都要变（用于决定要不要重建工具条按钮）', () => {
  // ⚠️ 必须**单条对单条**地比：早先这里拿"单条"去比"两条的签名"，
  // 于是"元素个数不同"本身就让它通过 —— 把 mode 从签名里删掉，那条断言照样绿。
  // 每条断言都要只差一个字段，否则它测的是别的东西。
  const signature = (marker: CustomMarker): string => markerCatalogSignature([marker])
  const one = SAMPLE[0]!
  const before = signature(one)
  assert.equal(signature({ ...one }), before, '同样内容必须给同样的签名（否则每次刷新都重建 DOM）')
  assert.notEqual(signature({ ...one, id: 'custom:harbor' }), before)
  assert.notEqual(signature({ ...one, label: '别的名字' }), before)
  assert.notEqual(signature({ ...one, icon: 'city' }), before)
  assert.notEqual(signature({ ...one, imagePath: 'Assets/x.png' }), before)
  // 只切模式也必须变：否则按钮上"字形 / 缩略图"不会跟着更新
  assert.notEqual(signature({ ...one, mode: 'image' }), before)
  assert.equal(markerCatalogSignature([]), '')
  // 顺序也是内容的一部分（工具条按钮顺序跟着设置走）
  assert.notEqual(markerCatalogSignature(SAMPLE), markerCatalogSignature([...SAMPLE].reverse()))
})

test('设置页校验入口：合法返回归一化结果，非法给可读原因', () => {
  const ok = validateCustomMarkerInput({ id: 'LightHouse', label: '灯塔', icon: 'tower', imagePath: ' Assets\\x.png ' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.marker.id, `${CUSTOM_MARKER_PREFIX}lighthouse`)
    assert.equal(ok.marker.imagePath, 'Assets/x.png')
    assert.equal(ok.marker.icon, 'tower')
    assert.equal(ok.marker.mode, 'image', '配了图又没写模式 ⇒ 按旧数据规则迁移成图片模式')
  }
  // 显式模式说了算，且不会顺手清空另一个字段
  const glyph = validateCustomMarkerInput({ id: 'lighthouse', icon: 'tower', imagePath: 'Assets/x.png', mode: 'glyph' })
  assert.equal(glyph.ok, true)
  if (glyph.ok) {
    assert.equal(glyph.marker.mode, 'glyph')
    assert.equal(glyph.marker.imagePath, 'Assets/x.png')
  }
  const bad = validateCustomMarkerInput({ id: '!!!' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.problem, /小写字母/)
})

test('显示名查询：内置给 ID 本身，自定义给显示名，未知给带 ID 的说明', () => {
  assert.equal(markerLabelOf('city', SAMPLE), 'city')
  assert.equal(markerLabelOf('custom:lighthouse', SAMPLE), '灯塔')
  assert.match(markerLabelOf('custom:gone', SAMPLE), /未知/)
})
