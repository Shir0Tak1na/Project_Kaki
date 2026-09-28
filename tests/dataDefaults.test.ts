/**
 * 数据层「每格默认值」（`dataDefaults`）的**纯函数**单测。
 *
 * 这一组盯四件事：
 * 1. **空表 = 没有这一段**（`null`，不是 `{}`）—— §B.5 那条"清空时移除该键"的落地点；
 * 2. **坏值丢掉、不认识的键保留**（§5.11：未知值属于用户的数据）；
 * 3. 等价判断不看键的顺序（否则连点两次保存会多出一条空历史）；
 * 4. 输入解析：**留空 = 不设**（不是 0），且**负数合法**（-20 ℃ 的冰原）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultFor,
  describeDataDefaults,
  normalizeDataDefaults,
  parseDefaultInput,
  sameDataDefaults,
  unknownDefaultKeys,
} from '../src/render/dataDefaults.ts'

test('normalizeDataDefaults：只留有限数，坏值丢掉；空表 → null（不是空对象）', () => {
  assert.equal(normalizeDataDefaults(null), null)
  assert.equal(normalizeDataDefaults(undefined), null)
  assert.equal(normalizeDataDefaults('15'), null, '不是对象 → 没有这一段')
  assert.equal(normalizeDataDefaults([1, 2]), null, '数组不是表')
  assert.equal(normalizeDataDefaults({}), null, '空对象 = 没有这一段（文件里不该留 `{}`）')
  assert.equal(
    normalizeDataDefaults({ temp: Number.NaN, depth: Number.POSITIVE_INFINITY }),
    null,
    '全是坏值 → 没有这一段',
  )
  assert.deepEqual(normalizeDataDefaults({ temp: 15, depth: 0, bad: 'x' }), { temp: 15, depth: 0 }, '坏值丢掉')
  assert.deepEqual(normalizeDataDefaults({ temp: -20 }), { temp: -20 }, '负数合法（温度可以是负的）')
  assert.deepEqual(
    normalizeDataDefaults({ temp: 15, future: 7 }),
    { temp: 15, future: 7 },
    '不认识的键原样保留（未来字段 / 用户手写）',
  )
})

test('sameDataDefaults：等价判断与键的顺序无关，`null` 与"全空"是同一件事', () => {
  assert.equal(sameDataDefaults(null, null), true)
  assert.equal(sameDataDefaults(null, { temp: 0 }), false, '没设过 与 设了 0 不是一回事')
  assert.equal(sameDataDefaults({ temp: 0 }, null), false)
  assert.equal(sameDataDefaults({ temp: 15, depth: 0 }, { depth: 0, temp: 15 }), true, '顺序无关')
  assert.equal(sameDataDefaults({ temp: 15 }, { temp: 15, depth: 0 }), false, '键数不同')
  assert.equal(sameDataDefaults({ temp: 15 }, { temp: 16 }), false)
})

test('defaultFor：取值只认有限数；没有这个字段时返回 undefined（与"缺数据"同一个空）', () => {
  const defaults = { temp: 15, depth: 0 }
  assert.equal(defaultFor(defaults, 'temp'), 15)
  assert.equal(defaultFor(defaults, 'depth'), 0, '0 是合法值，不能当"没有"')
  assert.equal(defaultFor(defaults, 'missing'), undefined)
  assert.equal(defaultFor(null, 'temp'), undefined)
  assert.equal(defaultFor(undefined, 'temp'), undefined)
})

test('describeDataDefaults：只列设了值的字段；一个都没设时说"不兜底"', () => {
  const rows = [
    { key: 'temp', label: '温度', unit: '℃' },
    { key: 'depth', label: '深度 / 海拔', unit: 'm' },
  ]
  assert.equal(describeDataDefaults(null, rows), '未设置（不兜底）')
  assert.equal(describeDataDefaults({}, rows), '未设置（不兜底）')
  assert.equal(describeDataDefaults({ temp: 15 }, rows), '温度 15℃')
  assert.equal(describeDataDefaults({ depth: 0 }, rows), '深度 / 海拔 0m', '0 要显示成 0，不是"没设"')
  assert.equal(describeDataDefaults({ temp: -20.5, depth: 1500 }, rows), '温度 -20.5℃ · 深度 / 海拔 1500m')
  assert.equal(describeDataDefaults({ temp: 15 }, rows), describeDataDefaults({ temp: 15, other: 1 }, rows), '不提不认识的键')
})

test('unknownDefaultKeys：列出字段表不认的键（弹窗要说明"已原样保留"）', () => {
  assert.deepEqual(unknownDefaultKeys(null, ['temp', 'depth']), [])
  assert.deepEqual(unknownDefaultKeys({ temp: 1, depth: 2 }, ['temp', 'depth']), [])
  assert.deepEqual(unknownDefaultKeys({ zzz: 1, temp: 2, aaa: 3 }, ['temp']), ['aaa', 'zzz'], '排序稳定')
})

test('parseDefaultInput：留空 = 不设（不是 0）；非数字拒绝；负数合法', () => {
  assert.deepEqual(parseDefaultInput('', '温度'), { ok: true, value: null })
  assert.deepEqual(parseDefaultInput('   ', '温度'), { ok: true, value: null })
  assert.deepEqual(parseDefaultInput('0', '温度'), { ok: true, value: 0 }, '0 是合法值')
  assert.deepEqual(parseDefaultInput('-20.5', '温度'), { ok: true, value: -20.5 })
  const bad = parseDefaultInput('abc', '温度')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.problem, /温度必须是一个数字/, '原因里要带上是哪一行')
})