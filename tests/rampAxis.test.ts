/**
 * 轴的编辑操作（W2）单测：位置换算 / 拖动夹取 / 增删锚点 / 条带与端帽渐变。
 *
 * 为什么单独一个文件：这些函数是**轴的行为契约** —— 冒烟只能验"点了之后 DOM 变了"，
 * 验不了"拖到邻居身上会被挡住""删到剩两条就删不动"这类边界。边界在这里盯死。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_STOP_GAP_RATIO,
  RAMP_MAX_STOPS,
  canAddStop,
  canRemoveStop,
  clampStopValue,
  colorForValue,
  defaultDepthRamp,
  defaultTemperatureRamp,
  rampBounds,
  rampStripGradientCss,
  rangeCapGradientCss,
  stopGaps,
  stopPositions,
  widestGapValue,
  withStopColor,
  withStopInserted,
  withStopRemoved,
  withStopValue,
  type ColorStop,
} from '../src/render/colorRamp.ts'

const temp = defaultTemperatureRamp()

test('stopPositions：位置按值成比例（温度出厂 5 条锚点）', () => {
  assert.deepEqual(stopPositions(temp.stops), [0, 0.4, 0.6, 0.8, 1])
})

test('stopGaps：相邻间隔就是那一段的渐变率分母', () => {
  assert.deepEqual(stopGaps(temp.stops), [30, 15, 15, 15])
})

test('clampStopValue：中间锚点不许越过邻居（两侧都挡）', () => {
  const stops = temp.stops
  const gap = rampBounds(stops).span * MIN_STOP_GAP_RATIO
  // 第 3 条锚点（15 ℃）往左拖到 -100 ⇒ 挡在 0 ℃ + 一个最小间隔上
  assert.equal(clampStopValue(stops, 2, -100), 0 + gap)
  // 往右拖到 100 ⇒ 挡在 30 ℃ - 一个最小间隔上
  assert.equal(clampStopValue(stops, 2, 100), 30 - gap)
  // 合法范围内原样通过
  assert.equal(clampStopValue(stops, 2, 20), 20)
})

test('clampStopValue：两端只挡内侧，往外侧自由（拖动端点 = 改这张图的限度）', () => {
  const stops = temp.stops
  assert.equal(clampStopValue(stops, 0, -999), -999)
  assert.equal(clampStopValue(stops, stops.length - 1, 999), 999)
  const gap = rampBounds(stops).span * MIN_STOP_GAP_RATIO
  // 内侧被第二条锚点（0 ℃）挡住：最多到 0 ℃ - 一个最小间隔
  assert.equal(clampStopValue(stops, 0, 100), 0 - gap)
})

test('withStopValue：没有变化时返回原数组引用（调用方据此跳过落盘）', () => {
  const stops = temp.stops
  assert.equal(withStopValue(stops, 2, 15), stops)
  assert.equal(withStopValue(stops, 99, 15), stops)
  const next = withStopValue(stops, 2, 20)
  assert.notEqual(next, stops)
  assert.deepEqual(next.map((stop) => stop.value), [-30, 0, 20, 30, 45])
  assert.equal(stops[2]!.value, 15) // 原数组没被改（不可变）
})

test('withStopColor：只改指定那一条，其它原样', () => {
  const next = withStopColor(temp.stops, 1, '#123456')
  assert.equal(next[1]!.color, '#123456')
  assert.equal(next[0]!.color, temp.stops[0]!.color)
  assert.equal(withStopColor(temp.stops, 1, temp.stops[1]!.color), temp.stops)
})

test('withStopInserted：按值插入并保持升序；新锚点取原渐变上的颜色', () => {
  const value = widestGapValue(temp.stops)
  assert.equal(value, -15)
  const color = colorForValue(value!, temp)!.color
  const next = withStopInserted(temp.stops, value!, color)
  assert.equal(next.length, temp.stops.length + 1)
  assert.deepEqual(next.map((stop) => stop.value), [-30, -15, 0, 15, 30, 45])
  assert.equal(next[1]!.color, color)
  // 与已有锚点重合 ⇒ 不插（原数组引用）
  assert.equal(withStopInserted(temp.stops, 15, color), temp.stops)
})

test('withStopInserted：到 RAMP_MAX_STOPS 就不再加', () => {
  const many: ColorStop[] = []
  for (let index = 0; index < RAMP_MAX_STOPS; index += 1) many.push({ value: index, color: '#000000' })
  assert.equal(canAddStop(many), false)
  assert.equal(withStopInserted(many, 0.5, '#ffffff'), many)
})

test('withStopRemoved：删到 RAMP_MIN_STOPS 就删不动（界面据此禁用入口）', () => {
  const two = [temp.stops[0]!, temp.stops[4]!]
  assert.equal(canRemoveStop(two), false)
  assert.equal(withStopRemoved(two, 0), two)
  assert.equal(canRemoveStop(temp.stops), true)
  assert.deepEqual(withStopRemoved(temp.stops, 2).map((stop) => stop.value), [-30, 0, 30, 45])
  assert.equal(withStopRemoved(temp.stops, 99), temp.stops)
})

test('rampStripGradientCss：按值采样 ⇒ 锚点色与位置都在，越界极色不在条带里', () => {
  const css = rampStripGradientCss(temp)
  assert.ok(css.startsWith('linear-gradient(90deg, '))
  assert.ok(css.includes('#0000ff 0.00%'))
  assert.ok(css.includes('#ff0000 100.00%'))
  assert.ok(!css.includes('#ffffff')) // 极色属于端帽
  assert.ok(/linear-gradient\(90deg, (#[0-9a-f]{6} \d+\.\d\d%, ){5}/.test(css))
})

test('rampStripGradientCss：锚点不足时退化成两端纯色，不抛异常', () => {
  const broken = { ...temp, stops: [temp.stops[0]!] }
  assert.ok(rampStripGradientCss(broken).startsWith('linear-gradient(90deg, '))
})

test('rangeCapGradientCss：靠轴的一侧是端色、外侧是极色（两端方向相反）', () => {
  assert.equal(rangeCapGradientCss(temp.under, 'under'), 'linear-gradient(90deg, #ffffff 0%, #0000ff 100%)')
  assert.equal(rangeCapGradientCss(temp.over, 'over'), 'linear-gradient(90deg, #ff0000 0%, #000000 100%)')
  const depth = defaultDepthRamp()
  // 极色 = 端色 ⇒ 纯色（深度那种"两端本身是极色"的字段）
  assert.equal(rangeCapGradientCss(depth.under, 'under'), 'linear-gradient(90deg, #000000 0%, #000000 100%)')
})
