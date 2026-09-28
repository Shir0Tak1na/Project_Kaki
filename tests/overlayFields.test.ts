/**
 * 数据层的字段描述表与样式规范化（温度是第一份模板）。
 *
 * 这一组断言盯的是三件事：
 * 1. **字段表与图层表对得上**（`layerId` 那一行的 `overlay` 必须指回同一个字段）；
 * 2. **"没有数据"与"值就是 0"是两回事**（坏值一律当没有数据，绝不返回 0 冒充）；
 * 3. **坏设置回退出厂值**而不是让某一层静默消失（同图层开关的口径）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OVERLAY_STYLES,
  OVERLAY_FIELDS,
  defaultOverlayStyles,
  formatFieldReading,
  normalizeOverlayStyles,
  overlayField,
  overlayUnitSuffix,
  overlayUnitTitle,
} from '../src/render/overlayFields.ts'
import { formatOverlayValue } from '../src/render/overlayDraw.ts'
import type { ElevationCalibration } from '../src/render/elevationUnits.ts'
import { LAYER_TABLE, type LayerSpec } from '../src/render/layerVisibility.ts'
import { SELECTION_KINDS } from '../src/editor/selection.ts'

test('字段表与图层表双向对得上：每行数据层都指向一个真实存在的图层', () => {
  const ids = OVERLAY_FIELDS.map((spec) => spec.id)
  assert.equal(new Set(ids).size, ids.length, `字段 id 有重复：${ids.join(',')}`)
  for (const spec of OVERLAY_FIELDS) {
    // 显式标成 `LayerSpec`：表是 `as const` 的，只有数据层那一行才有 `overlay` 字段
    const layer: LayerSpec | undefined = LAYER_TABLE.find((row) => row.id === spec.layerId)
    assert.ok(layer, `字段 ${spec.id} 指向的图层 ${spec.layerId} 不在 LAYER_TABLE 里`)
    assert.equal(layer.overlay, spec.id, `图层 ${spec.layerId} 的 overlay 必须指回字段 ${spec.id}`)
    assert.equal(layer.isDataLayer, true, '数据层的图层必须标 isDataLayer（它决定"是否数据层"这类判断）')
    assert.ok(spec.label.trim().length > 0 && spec.unit.trim().length > 0, `${spec.id} 缺名字或单位`)
  }
})

test('读值：只有有限数才算数据，0 是合法值（缺数据不许用 0 冒充）', () => {
  const spec = overlayField('temperature')
  assert.equal(spec.read({ t: 'forest', temp: 0 }), 0, '0 ℃ 是真实数据')
  assert.equal(spec.read({ t: 'forest', temp: -12.5 }), -12.5)
  assert.equal(spec.read({ t: 'forest' }), undefined, '没有这个字段')
  assert.equal(spec.read({}), undefined, '只有值没有地形的格也要能读（`t` 可选）')
  assert.equal(spec.read(undefined), undefined, '空格')
  // 坏值：解析层已经把非法值挪进 `extra` 并告警，这里只当"没有数据"
  assert.equal(spec.read({ temp: Number.NaN }), undefined)
  assert.equal(spec.read({ temp: Number.POSITIVE_INFINITY }), undefined)
  assert.equal(spec.read({ temp: '12' as unknown as number }), undefined, '字符串不是数字')
})

test('温度的出厂样式：5 个体感锚点 + 纯蓝/纯红越界 + Oklab 插值 + 不透明度 0.5', () => {
  const style = overlayField('temperature').defaultStyle()
  assert.deepEqual(
    style.ramp.stops.map((stop) => stop.value),
    [-30, 0, 15, 30, 45],
  )
  assert.equal(style.ramp.interpolate, 'oklab')
  assert.equal(style.ramp.under.color, '#0000ff')
  assert.equal(style.ramp.over.color, '#ff0000')
  assert.equal(style.opacity, 0.5)
  assert.equal(style.showValues, false, '数值文字默认关：密铺时数字比颜色吵')
})

test('出厂样式表每次都是新对象（改一份不会污染另一份）', () => {
  const first = defaultOverlayStyles()
  const second = defaultOverlayStyles()
  assert.notEqual(first, second)
  assert.notEqual(first.temperature, second.temperature)
  assert.notEqual(first.temperature.ramp.stops, second.temperature.ramp.stops)
  assert.deepEqual(first, DEFAULT_OVERLAY_STYLES)
})

test('规范化：坏输入一律回退出厂值，而不是让某一层静默消失', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    assert.deepEqual(normalizeOverlayStyles(bad), DEFAULT_OVERLAY_STYLES, String(bad))
  }
  const partial = normalizeOverlayStyles({ temperature: { opacity: 0.2 } })
  assert.equal(partial.temperature.opacity, 0.2, '显式给了就保留')
  assert.deepEqual(partial.temperature.ramp.stops, DEFAULT_OVERLAY_STYLES.temperature.ramp.stops, '缺的色带按出厂补')
  assert.equal(partial.temperature.showValues, false)
})

test('规范化：不透明度夹在 0–1、只认布尔开关、少于两条锚点的色带整体回退', () => {
  assert.equal(normalizeOverlayStyles({ temperature: { opacity: 5 } }).temperature.opacity, 1)
  assert.equal(normalizeOverlayStyles({ temperature: { opacity: -3 } }).temperature.opacity, 0)
  assert.equal(normalizeOverlayStyles({ temperature: { opacity: 'yes' } }).temperature.opacity, 0.5)
  assert.equal(normalizeOverlayStyles({ temperature: { showValues: 'yes' } }).temperature.showValues, false)
  assert.equal(normalizeOverlayStyles({ temperature: { showValues: true } }).temperature.showValues, true)
  const single = normalizeOverlayStyles({ temperature: { ramp: { stops: [{ value: 1, color: '#ff0000' }] } } })
  assert.deepEqual(single.temperature.ramp.stops, DEFAULT_OVERLAY_STYLES.temperature.ramp.stops, '一条锚点不是色带')
  const custom = normalizeOverlayStyles({
    temperature: { ramp: { stops: [{ value: 10, color: '#111111' }, { value: 0, color: '#eeeeee' }] } },
  })
  assert.deepEqual(custom.temperature.ramp.stops, [
    { value: 0, color: '#eeeeee' },
    { value: 10, color: '#111111' },
  ], '锚点按值升序排（用户填的顺序不参与语义）')
  assert.equal(
    Object.keys(normalizeOverlayStyles({ temperature: {}, somethingElse: {} })).join(','),
    'temperature,depth',
    '只认登记表里的字段，不认识的键不许进设置',
  )
  assert.throws(() => overlayField('nope' as never), /未知的数据层字段/)
})

test('数据层的字段不许声明取值区间（色带两端不是数据的边界）', () => {
  // 2026-09-28 用户实机纠正：温度 / 深度曾经挂过 -100~100 / -12000~12000，
  // 于是检查器会**拒绝**超出的值 —— 那是设计上不存在的限制。
  // 这里钉住契约：数据层字段没有 min/max（越界只体现在颜色上）。
  for (const spec of OVERLAY_FIELDS) {
    const field = SELECTION_KINDS.cell.fields.find((item) => item.field === spec.cellKey)
    assert.ok(field, `地块的检查器字段表里没有 ${spec.cellKey}`)
    assert.equal(field.min, undefined, `${spec.cellKey} 不该有下限（任何有限数都是合法数据）`)
    assert.equal(field.max, undefined, `${spec.cellKey} 不该有上限`)
    assert.equal(field.group, 'data', `${spec.cellKey} 属于「数据层」一组，不是「外观」`)
  }
})

test('深度的出厂样式：高处浅米 → 海平面浅蓝 → 深海深蓝，越界是纯白 / 近黑蓝（不是温度那对蓝红）', () => {
  const style = overlayField('depth').defaultStyle()
  assert.deepEqual(
    style.ramp.stops.map((stop) => stop.value),
    [-4000, 0, 4000],
    '0 = 海平面，正 = 向下（负值是高海拔那一端）',
  )
  assert.equal(style.ramp.stops[1]!.color, '#7dd3fc', '海平面用浅蓝标出来')
  assert.equal(style.ramp.under.color, '#ffffff', '高于最高峰：纯白底（温度那套纯蓝 / 纯红是体感语言，不通用）')
  assert.equal(style.ramp.over.color, '#0b1f4b', '深于最深：近黑蓝')
  assert.equal(style.ramp.interpolate, 'oklab')
  assert.equal(style.opacity, 0.5)
  assert.equal(style.unit, 'm', '出厂展示单位是米')
})

test('深度的读值：与温度同一口径（只有有限数才算数据，0 = 海平面是合法值）', () => {
  const spec = overlayField('depth')
  assert.equal(spec.read({ depth: 0 }), 0, '0 = 海平面，是真实数据')
  assert.equal(spec.read({ depth: -1200 }), -1200, '负值 = 海拔')
  assert.equal(spec.read({ t: 'water', depth: 3000 }), 3000)
  assert.equal(spec.read({ t: 'water' }), undefined, '没有这个字段')
  assert.equal(spec.read({ depth: Number.NaN }), undefined)
  assert.equal(spec.read({ depth: '3000' as unknown as number }), undefined)
})

test('展示单位：归一化只认登记表里那几个，坏值回退出厂值；温度没有这一项', () => {
  assert.equal(normalizeOverlayStyles({ depth: { unit: 'km' } }).depth.unit, 'km')
  assert.equal(normalizeOverlayStyles({ depth: { unit: 'rel' } }).depth.unit, 'rel')
  assert.equal(normalizeOverlayStyles({ depth: { unit: 'fathom' } }).depth.unit, 'm', '不认识的一律回退出厂值')
  assert.equal(normalizeOverlayStyles({ depth: {} }).depth.unit, 'm', '缺项按出厂补')
  assert.equal(
    'unit' in normalizeOverlayStyles({ temperature: { unit: 'km' } }).temperature,
    false,
    '温度不需要展示单位，就不该有这一项（同一件事不留两份状态）',
  )
})

test('读数格式化：米 / 千米 / 相对值；未标定时说"未标定"，不编一个数字', () => {
  const spec = overlayField('depth')
  const calibration: ElevationCalibration = { unit: 'm', maxDepth: 8000, maxHeight: 3000 }
  const reading = (value: number, unit: 'm' | 'km' | 'rel', cal: ElevationCalibration = calibration) =>
    formatFieldReading(spec, value, { ...spec.defaultStyle(), unit }, cal)

  assert.equal(reading(3000, 'm'), '3000')
  assert.equal(reading(-1200, 'm'), '-1200', '负值是海拔，读数带符号')
  assert.equal(reading(3200, 'km'), '3.2')
  assert.equal(reading(-1200, 'km'), '-1.2')
  // 海平面落在 maxDepth / (maxDepth + maxHeight) = 8000/11000 ≈ 0.73 —— 不强行对称到 0.5
  assert.equal(reading(0, 'rel'), '0.73')
  assert.equal(reading(3000, 'rel'), '0.45')
  assert.equal(
    reading(3000, 'rel', { unit: 'm', maxDepth: null, maxHeight: null }),
    '未标定',
    '没有标定就说未标定，而不是拿一个编造的尺度凑数',
  )

  // 温度没有换算：走通用的一位小数格式
  const temperature = overlayField('temperature')
  assert.equal(formatFieldReading(temperature, 23.456, temperature.defaultStyle(), calibration), '23.5')
})

test('单位后缀：温度紧跟（℃），深度带前导空格（" m"），相对值无量纲（空串）', () => {
  const depth = overlayField('depth')
  const suffix = (unit: 'm' | 'km' | 'rel') => overlayUnitSuffix(depth, { ...depth.defaultStyle(), unit })
  assert.equal(suffix('m'), ' m')
  assert.equal(suffix('km'), ' km')
  assert.equal(suffix('rel'), '', '相对值没有单位后缀')
  const temperature = overlayField('temperature')
  assert.equal(overlayUnitSuffix(temperature, temperature.defaultStyle()), '℃')
  assert.equal(overlayUnitTitle(depth, { ...depth.defaultStyle(), unit: 'rel' }), '相对值 0–1')
})

test('数值文字：最多一位小数，整数不带 .0（-0 也要写成 0）', () => {
  assert.equal(formatOverlayValue(26), '26')
  assert.equal(formatOverlayValue(23.5), '23.5')
  assert.equal(formatOverlayValue(23.456), '23.5')
  assert.equal(formatOverlayValue(-0.04), '0', '不许出现 "-0"')
  assert.equal(formatOverlayValue(-30), '-30')
})