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
  resolveMarkerStyle,
  validateCustomMarkerInput,
  type CustomMarker,
} from '../src/render/markerCatalog.ts'
import { MARKER_ICONS } from '../src/data/mapDocument.ts'

const SAMPLE: CustomMarker[] = [
  { id: 'custom:lighthouse', label: '灯塔', icon: 'tower', imagePath: '' },
  { id: 'custom:reef', label: '暗礁', icon: '', imagePath: 'Assets/reef.png' },
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

test('签名：内容变了才变（用于决定要不要重建工具条按钮）', () => {
  const before = markerCatalogSignature(SAMPLE)
  assert.equal(markerCatalogSignature(SAMPLE), before)
  assert.notEqual(markerCatalogSignature([{ ...SAMPLE[0]!, label: '别的名字' }]), before)
  assert.notEqual(markerCatalogSignature([{ ...SAMPLE[0]!, imagePath: 'Assets/x.png' }]), before)
  assert.equal(markerCatalogSignature([]), '')
})

test('设置页校验入口：合法返回归一化结果，非法给可读原因', () => {
  const ok = validateCustomMarkerInput({ id: 'LightHouse', label: '灯塔', icon: 'tower', imagePath: ' Assets\\x.png ' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.marker.id, `${CUSTOM_MARKER_PREFIX}lighthouse`)
    assert.equal(ok.marker.imagePath, 'Assets/x.png')
    assert.equal(ok.marker.icon, 'tower')
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
