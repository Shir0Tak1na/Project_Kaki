/**
 * 样式调色板的单元测试。
 *
 * 这些断言针对的都是"写错了不报错、只是悄悄变形"的地方：
 * 非法颜色被 canvas 静默忽略、`ctx.font` 里的 `var()` 让整条字体声明失效。
 * 所以重点不是"函数能不能跑"，而是**非法输入必须被挡在绘制层之外**。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  canonicalColor,
  defaultPathColors,
  defaultRegionColors,
  isDefaultPathColors,
  isDefaultRegionColors,
  isSafeColor,
  normalizeColor,
  normalizeFontFamily,
  normalizePathColors,
  normalizeRegionColors,
  resolveDefaultRegionColor,
  resolvePathStyle,
  resolveRegionPresets,
} from '../src/render/stylePalette.ts'
import { PATH_STYLES, REGION_PRESETS } from '../src/render/shapeStyle.ts'
import { PATH_TYPES } from '../src/data/mapDocument.ts'

test('出厂默认颜色取自 PATH_STYLES / REGION_PRESETS，不是抄一份', () => {
  const paths = defaultPathColors()
  for (const type of PATH_TYPES) assert.equal(paths[type], PATH_STYLES[type].color, type)
  assert.deepEqual(defaultRegionColors(), REGION_PRESETS.map((preset) => preset.color))
  assert.equal(new Set(defaultRegionColors()).size, REGION_PRESETS.length, '预设色不应重复')
})

test('颜色合法性：接受 hex/函数式/常见具名，拒绝会静默失效或需要拼接的写法', () => {
  for (const good of ['#fff', '#4a9fd8', '#4a9fd8ff', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)', 'hsl(200 50% 40%)', 'teal']) {
    assert.equal(isSafeColor(good), true, good)
  }
  for (const bad of [
    '',
    'var(--text-normal)',
    'url(#gradient)',
    'rgb(1,2,3); background: red',
    '#12345',
    'expression(alert(1))',
    'not-a-color',
    `#${'a'.repeat(80)}`,
    'x'.repeat(80),
  ]) {
    assert.equal(isSafeColor(bad), false, bad)
  }
  assert.equal(isSafeColor(42), false)
  assert.equal(isSafeColor(null), false)
})

test('非法颜色一律回退到默认值，绝不透传（canvas 会静默忽略非法色）', () => {
  assert.equal(normalizeColor('var(--x)', '#123456'), '#123456')
  assert.equal(normalizeColor('  #ABC  ', '#123456'), '#ABC', '去掉首尾空白但保留原写法')
  assert.equal(normalizeColor(undefined, '#123456'), '#123456')
  assert.equal(canonicalColor('#ABC'), '#abc', '十六进制统一小写（写盘稳定）')
  assert.equal(canonicalColor('teal'), 'teal', '非十六进制原样保留')
})

test('字体族清洗：var()/斜杠/括号/分号一律拒绝（它们会让 ctx.font 整条失效）', () => {
  for (const bad of [
    'var(--font-interface)',
    'Noto Sans / serif',
    '600 24px sans-serif',
    'a;b',
    'x'.repeat(300),
    '',
    '   ',
  ]) {
    assert.equal(normalizeFontFamily(bad), '', bad)
  }
  for (const good of ['Noto Serif SC, serif', "Georgia, 'Times New Roman', serif", '霞鹜文楷', 'monospace']) {
    assert.equal(normalizeFontFamily(good), good, good)
  }
  assert.equal(normalizeFontFamily('  Noto   Sans  '), 'Noto Sans', '压缩多余空白')
  assert.equal(normalizeFontFamily(undefined), '')
})

test('解析路径样式：只换颜色，宽度/虚线/平滑等结构不受设置影响', () => {
  const colors = { ...defaultPathColors(), river: '#ff0000' }
  const river = resolvePathStyle('river', colors)
  assert.equal(river.color, '#ff0000')
  assert.equal(river.width, PATH_STYLES.river.width)
  assert.equal(river.taper, true)
  assert.equal(river.smooth, true)

  const road = resolvePathStyle('road', colors)
  assert.equal(road.color, PATH_STYLES.road.color, '没被改的类型保持出厂色')
  assert.deepEqual(road.dash, PATH_STYLES.road.dash)

  // 未改动时必须复用同一个对象（避免每帧新建对象污染热路径）
  const untouched = resolvePathStyle('river', defaultPathColors())
  assert.equal(untouched, PATH_STYLES.river)
})

test('解析区域预设：标签与顺序不变，只换颜色；非法值回退', () => {
  const presets = resolveRegionPresets(['#111111', 'nonsense', ...defaultRegionColors().slice(2)])
  assert.equal(presets.length, REGION_PRESETS.length)
  assert.equal(presets[0]!.color, '#111111')
  assert.equal(presets[1]!.color, REGION_PRESETS[1]!.color, '非法颜色回退到出厂色')
  assert.equal(presets[2]!.label, REGION_PRESETS[2]!.label)
  assert.deepEqual(
    presets.map((preset) => preset.label),
    REGION_PRESETS.map((preset) => preset.label),
  )
  assert.equal(resolveDefaultRegionColor(['#abcdef']), '#abcdef')
  assert.equal(resolveDefaultRegionColor([]), REGION_PRESETS[0]!.color)
})

test('整表归一化：缺项补齐、多余项忽略、坏输入不抛异常', () => {
  const paths = normalizePathColors({ river: '#ff0000', road: 'var(--x)', extra: '#000' })
  assert.equal(paths.river, '#ff0000')
  assert.equal(paths.road, PATH_STYLES.road.color)
  assert.equal(paths.border, PATH_STYLES.border.color)
  assert.equal('extra' in paths, false, '不认识的键不应进入设置')

  for (const bad of [null, undefined, 42, 'nope', [], { river: 12 }]) {
    const out = normalizePathColors(bad)
    assert.deepEqual(out, defaultPathColors(), String(bad))
  }

  const regions = normalizeRegionColors(['#111111'])
  assert.equal(regions.length, REGION_PRESETS.length)
  assert.equal(regions[0], '#111111')
  assert.equal(regions[1], REGION_PRESETS[1]!.color)
  assert.deepEqual(normalizeRegionColors('nope'), defaultRegionColors())
  assert.deepEqual(normalizeRegionColors([null, 5, {}]), defaultRegionColors())
})

test('“是否等于出厂默认”判断：用于设置页显示已改动状态', () => {
  assert.equal(isDefaultPathColors(defaultPathColors()), true)
  assert.equal(isDefaultPathColors({ ...defaultPathColors(), river: '#000000' }), false)
  assert.equal(isDefaultPathColors({ ...defaultPathColors(), river: PATH_STYLES.river.color.toUpperCase() }), true, '大小写差异不算改动')
  assert.equal(isDefaultRegionColors(defaultRegionColors()), true)
  assert.equal(isDefaultRegionColors([...defaultRegionColors().slice(1), '#000000']), false)
  assert.equal(isDefaultRegionColors([]), false)
})
