/**
 * 路径样式设置的单元测试。
 *
 * 重点在"写坏了不会报错、只会静默变形"的地方：
 * 线宽被写成 0.1 或 500、虚线数组变成奇数长度或全 0（线整条消失）、
 * 以及旧字段（只有颜色）与新字段（完整样式表）打架。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  PATH_DASH_MAX_SEGMENTS,
  PATH_WIDTH_MAX,
  PATH_WIDTH_MIN,
  defaultPathStyleOverrides,
  describePathDash,
  describePathDashProblem,
  fromLegacyPathColors,
  isDefaultPathStyleOverrides,
  normalizePathDash,
  normalizePathStyleOverrides,
  normalizePathWidth,
  resolvePathStyleFull,
} from '../src/render/pathStyleSettings.ts'
import { PATH_STYLES } from '../src/render/shapeStyle.ts'
import { PATH_TYPES } from '../src/data/mapDocument.ts'

test('出厂样式取自 PATH_STYLES，不是在这里再抄一份数值', () => {
  const defaults = defaultPathStyleOverrides()
  for (const type of PATH_TYPES) {
    const base = PATH_STYLES[type]
    assert.equal(defaults[type].color, base.color, type)
    assert.equal(defaults[type].width, base.width, type)
    assert.deepEqual(defaults[type].dash, base.dash ? [...base.dash] : [], type)
    assert.equal(defaults[type].taper, base.taper === true, type)
    assert.equal(defaults[type].smooth, base.smooth === true, type)
  }
  assert.equal(isDefaultPathStyleOverrides(defaults), true)
})

test('线宽：夹取到 1–40，保留一位小数，非法值回退', () => {
  assert.equal(normalizePathWidth(0.1, 8), PATH_WIDTH_MIN)
  assert.equal(normalizePathWidth(500, 8), PATH_WIDTH_MAX)
  assert.equal(normalizePathWidth(6.24, 8), 6.2)
  assert.equal(normalizePathWidth('6.26', 8), 6.3)
  assert.equal(normalizePathWidth(Number.NaN, 8), 8)
  assert.equal(normalizePathWidth(undefined, 8), 8)
  assert.equal(normalizePathWidth('粗一点', 8), 8)
})

test('虚线：空数组=实线、缺失=没有可用值（回退出厂虚线）；偶数长度、有限非负、不超上限才接受', () => {
  assert.deepEqual(normalizePathDash([]), [], '显式空数组 = 实线')
  assert.equal(normalizePathDash(undefined), null, '缺失 ≠ 实线：要回退到出厂虚线，否则道路/边界的虚线会静默消失')
  assert.equal(normalizePathDash(null), null)
  assert.deepEqual(normalizePathDash([12, 8]), [12, 8])
  assert.deepEqual(normalizePathDash([100, 0.04]), [64, 0], '单段夹取到上限并保留一位小数')

  assert.equal(normalizePathDash([12]), null, '奇数长度会让线看起来是断的，必须拒绝')
  assert.equal(normalizePathDash([12, 8, 4]), null)
  assert.equal(normalizePathDash([0, 0]), null, '全 0 会让线整条消失')
  assert.equal(normalizePathDash([-1, 8]), null)
  assert.equal(normalizePathDash([Number.NaN, 8]), null)
  assert.equal(normalizePathDash('dashed'), null)
  assert.equal(normalizePathDash(Array.from({ length: PATH_DASH_MAX_SEGMENTS + 2 }, () => 4)), null)
})

test('虚线的可读原因：设置页要能告诉用户"为什么不行"', () => {
  assert.equal(describePathDashProblem([12, 8]), null)
  assert.match(describePathDashProblem([12]) ?? '', /偶数/)
  assert.match(describePathDashProblem([0, 0]) ?? '', /全.*0/)
  assert.match(describePathDashProblem([-1, 2]) ?? '', /非负/)
  assert.match(describePathDashProblem('x') ?? '', /数组/)
  assert.match(describePathDashProblem([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) ?? '', /最多/)
  assert.equal(describePathDash([]), '实线')
  assert.equal(describePathDash([12, 8]), '虚线 12-8')
})

test('整表归一化：坏输入给完整出厂表，未知键丢弃，缺项补齐', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    assert.deepEqual(normalizePathStyleOverrides(bad), defaultPathStyleOverrides(), String(bad))
  }
  const out = normalizePathStyleOverrides({
    river: { color: '#ff0000', width: 999, dash: [8], taper: 'yes' },
    unknown: { color: '#123456' },
  })
  assert.equal(out.river.color, '#ff0000')
  assert.equal(out.river.width, PATH_WIDTH_MAX, '越界线宽被夹取而不是原样接受')
  assert.deepEqual(out.river.dash, PATH_STYLES.river.dash ? [...PATH_STYLES.river.dash] : [], '非法虚线回退到出厂值')
  assert.equal(out.river.taper, true, '非布尔值回退到出厂值（河流出厂就是变细）')
  assert.equal('unknown' in out, false, '不认识的键不该进入设置')
  assert.equal(out.road.width, PATH_STYLES.road.width, '缺项按出厂值补齐')
})

test('旧字段迁移：只有颜色时也能得到完整的样式表', () => {
  const migrated = fromLegacyPathColors({ river: '#ff0000', road: '#00ff00' })
  assert.equal(migrated.river.color, '#ff0000')
  assert.equal(migrated.road.color, '#00ff00')
  assert.equal(migrated.river.width, PATH_STYLES.river.width, '结构字段仍取出厂值')
  assert.equal(migrated.border.color, PATH_STYLES.border.color)
  assert.equal(isDefaultPathStyleOverrides(migrated), false, '颜色被改过就不算默认')

  // 新字段存在时，旧字段**不能**再覆盖它（否则用户改过的颜色会被悄悄改回去）
  const both = normalizePathStyleOverrides({ river: { color: '#111111', width: 5, dash: [], taper: false, smooth: false } }, { river: '#222222' })
  assert.equal(both.river.color, '#111111')
})

test('解析：出厂结构 + 用户覆盖，斜体字段按需带上', () => {
  const overrides = defaultPathStyleOverrides()
  overrides.river = { ...overrides.river, color: '#ff0000', width: 12, dash: [6, 4], taper: false, smooth: false }
  const style = resolvePathStyleFull('river', overrides)
  assert.equal(style.type, 'river')
  assert.equal(style.label, PATH_STYLES.river.label, '标签仍取出厂值（用户改的是画法，不是名字）')
  assert.equal(style.color, '#ff0000')
  assert.equal(style.width, 12)
  assert.deepEqual(style.dash, [6, 4])
  assert.equal(style.taper, undefined, '关掉变细就不该带 taper 字段')
  assert.equal(style.smooth, undefined)

  const road = resolvePathStyleFull('road', overrides)
  assert.deepEqual(road.dash, PATH_STYLES.road.dash, '没改过的类型保持出厂虚线')
})

test('幂等：归一化两次与一次结果相同', () => {
  const once = normalizePathStyleOverrides({ river: { color: '#ff0000', width: 999, dash: [8, 2] }, road: { dash: [1] } })
  const twice = normalizePathStyleOverrides(once)
  assert.deepEqual(twice, once)
})

test('解析对缺项/坏表安全：不会因为传入不完整对象而抛异常', () => {
  const style = resolvePathStyleFull('river', {} as never)
  assert.equal(style.color, PATH_STYLES.river.color, '取不到覆盖时回退到出厂样式')
  assert.equal(style.width, PATH_STYLES.river.width)
})
