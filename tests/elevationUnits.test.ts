/**
 * 海拔 / 深度单位与标定的单测。
 *
 * 重点盯三件事：
 * 1. **相对值的两个端点**（最深 = 0、最高 = 1）与海平面落点 —— 这三个数是用户填标定时
 *    唯一能对得上的"事实"，写错了没人看得出来；
 * 2. **未标定必须拒绝**（返回 null + 一句可操作的话），而不是拿编造的尺度凑数；
 * 3. **借位不能吃掉整数位上的 0**（`3000 m` 不许显示成 `3 m`）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_ELEVATION_CALIBRATION,
  describeUnitProblem,
  formatCalibration,
  formatDepthReading,
  formatElevation,
  fromDisplay,
  fromMeters,
  isCalibrated,
  metersFromRelative,
  normalizeElevationCalibration,
  parseCalibrationInput,
  previewCalibrationTable,
  relativeOf,
  sameCalibration,
  toDisplay,
  toMeters,
  type ElevationCalibration,
} from '../src/render/elevationUnits.ts'

const WORLD: ElevationCalibration = { unit: 'm', maxDepth: 8000, maxHeight: 3000 }

test('normalizeElevationCalibration：单位只认 m/km，非法量程记 null，0 是合法值', () => {
  assert.deepEqual(normalizeElevationCalibration(undefined), DEFAULT_ELEVATION_CALIBRATION)
  assert.deepEqual(normalizeElevationCalibration('nonsense'), DEFAULT_ELEVATION_CALIBRATION)
  assert.deepEqual(normalizeElevationCalibration({ unit: 'ft', maxDepth: 100 }), {
    unit: 'm',
    maxDepth: 100,
    maxHeight: null,
  })
  assert.deepEqual(normalizeElevationCalibration({ unit: 'km', maxDepth: 8, maxHeight: 3 }), {
    unit: 'km',
    maxDepth: 8,
    maxHeight: 3,
  })
  // 负的"最深深度"没有意义 → 记成未填（不静默取绝对值，那会让用户看不懂自己填的是什么）
  assert.equal(normalizeElevationCalibration({ maxDepth: -5 }).maxDepth, null)
  assert.equal(normalizeElevationCalibration({ maxHeight: Number.NaN }).maxHeight, null)
  // 0 与 null 是两件不同的事
  assert.equal(normalizeElevationCalibration({ maxDepth: 5000, maxHeight: 0 }).maxHeight, 0)
})

test('isCalibrated：两端都填且量程大于 0 才算标定（两个 0 等于没有量程）', () => {
  assert.equal(isCalibrated(DEFAULT_ELEVATION_CALIBRATION), false)
  assert.equal(isCalibrated({ unit: 'm', maxDepth: 8000, maxHeight: null }), false)
  assert.equal(isCalibrated({ unit: 'm', maxDepth: 0, maxHeight: 0 }), false)
  assert.equal(isCalibrated(WORLD), true)
  assert.equal(isCalibrated({ unit: 'm', maxDepth: 8000, maxHeight: 0 }), true, '只有水下也算标定过')
})

test('toMeters / fromMeters：单位换算是可逆的，且 km 标定与格值用同一种单位', () => {
  assert.equal(toMeters(1200, WORLD), 1200)
  assert.equal(toMeters(8, { unit: 'km', maxDepth: 8, maxHeight: 3 }), 8000, 'km 标定下 8 就是 8000 米')
  assert.equal(fromMeters(8000, { unit: 'km', maxDepth: 8, maxHeight: 3 }), 8)
  assert.equal(fromMeters(toMeters(1234, WORLD), WORLD), 1234)
})

test('relativeOf：最深 = 0、最高 = 1、海平面落在 maxDepth/(maxDepth+maxHeight)', () => {
  assert.equal(relativeOf(8000, WORLD), 0)
  assert.equal(relativeOf(-3000, WORLD), 1)
  assert.equal((relativeOf(0, WORLD) ?? -1).toFixed(4), (8000 / 11000).toFixed(4))
  // 超出量程是用户把标定填小了，不是坏数据：夹到端点，读数仍然可用
  assert.equal(relativeOf(12000, WORLD), 0)
  assert.equal(relativeOf(-9000, WORLD), 1)
})

test('metersFromRelative 是 relativeOf 的逆（量程内往返稳定）', () => {
  for (const meters of [8000, 3000, 0, -1500, -3000]) {
    const back = metersFromRelative(relativeOf(meters, WORLD)!, WORLD)
    assert.ok(back !== null && Math.abs(back - meters) < 1e-9, `${meters} → ${back}`)
  }
  assert.equal(metersFromRelative(0, WORLD), 8000)
  assert.equal(metersFromRelative(1, WORLD), -3000)
})

test('未标定时相对值一律拒绝（null），并给出一句可操作的提示', () => {
  const empty = DEFAULT_ELEVATION_CALIBRATION
  assert.equal(relativeOf(0, empty), null)
  assert.equal(metersFromRelative(0.5, empty), null)
  assert.equal(toDisplay(0, 'rel', empty), null)
  assert.equal(fromDisplay(0.5, 'rel', empty), null)
  assert.match(describeUnitProblem('rel', empty) ?? '', /需要先设置海拔标定/)
  assert.equal(describeUnitProblem('rel', WORLD), null)
  assert.equal(describeUnitProblem('m', empty), null, '米 / 千米不需要标定')
})

test('toDisplay / fromDisplay：三种单位都能往返，米与千米不需要标定', () => {
  assert.equal(toDisplay(3000, 'm', DEFAULT_ELEVATION_CALIBRATION), 3000)
  assert.equal(toDisplay(3000, 'km', DEFAULT_ELEVATION_CALIBRATION), 3)
  assert.equal(fromDisplay(3, 'km', DEFAULT_ELEVATION_CALIBRATION), 3000)
  const relative = toDisplay(-3000, 'rel', WORLD)!
  assert.equal(fromDisplay(relative, 'rel', WORLD), -3000)
})

test('formatElevation：措辞按符号走，且不许吃掉整数位上的 0', () => {
  assert.equal(formatElevation(3000, 'm', WORLD), '深度 3000 m')
  assert.equal(formatElevation(-1200, 'm', WORLD), '海拔 1200 m')
  assert.equal(formatElevation(0, 'm', WORLD), '海平面（0 m）')
  assert.equal(formatElevation(3000, 'km', WORLD), '深度 3 km')
  assert.equal(formatElevation(-1500, 'km', WORLD), '海拔 1.5 km')
  // 相对值读的是"在量程里的位置"：3000 m 深在这张图里是 (8000−3000)/11000 ≈ 0.45
  assert.equal(formatElevation(3000, 'rel', WORLD), '0.45')
  assert.equal(formatElevation(0, 'rel', WORLD), '0.73', '海平面落在 8000/11000')
  assert.equal(formatElevation(3000, 'rel', DEFAULT_ELEVATION_CALIBRATION), '未标定')
  assert.equal(formatElevation(Number.NaN, 'm', WORLD), '—')
})

test('formatCalibration：说得清"还差哪个"', () => {
  assert.equal(formatCalibration(DEFAULT_ELEVATION_CALIBRATION), '未标定（还差最深深度）')
  assert.equal(formatCalibration({ unit: 'm', maxDepth: 8000, maxHeight: null }), '未标定（还差最高高度）')
  assert.equal(formatCalibration(WORLD), '最深 8000 m · 最高 3000 m')
})

test('formatDepthReading：短读数（画布格上 / 图例刻度用），带符号、不带措辞', () => {
  assert.equal(formatDepthReading(3000, 'm', WORLD), '3000')
  assert.equal(formatDepthReading(-1200, 'm', WORLD), '-1200', '负值是海拔，读数是带符号的数（措辞归 formatElevation）')
  assert.equal(formatDepthReading(3200, 'km', WORLD), '3.2')
  assert.equal(formatDepthReading(0, 'km', WORLD), '0')
  assert.equal(formatDepthReading(3000, 'rel', WORLD), '0.45')
  assert.equal(formatDepthReading(3000, 'rel', DEFAULT_ELEVATION_CALIBRATION), '未标定')
  assert.equal(formatDepthReading(Number.NaN, 'm', WORLD), '—')
})

test('sameCalibration：null 与"全未填"不是一回事，但它只管"有没有变化"', () => {
  assert.equal(sameCalibration(null, null), true)
  assert.equal(sameCalibration(null, DEFAULT_ELEVATION_CALIBRATION), false, 'null = 文件里没有这一段')
  assert.equal(
    sameCalibration(DEFAULT_ELEVATION_CALIBRATION, { unit: 'm', maxDepth: null, maxHeight: null }),
    true,
    '字段等价即等价（写回时是否落盘由调用方决定，见 MapEditor.setElevationCalibration）',
  )
  assert.equal(sameCalibration(WORLD, { ...WORLD }), true)
  assert.equal(sameCalibration(WORLD, { unit: 'm', maxDepth: 8000, maxHeight: 3001 }), false)
  assert.equal(sameCalibration(WORLD, { unit: 'km', maxDepth: 8000, maxHeight: 3000 }), false, '单位也是内容')
})

test('parseCalibrationInput：留空 = 不填；非数字 / 负数拒绝并说明原因（不悄悄当 0）', () => {
  assert.deepEqual(parseCalibrationInput('', '最深深度'), { ok: true, value: null })
  assert.deepEqual(parseCalibrationInput('  8000 ', '最深深度'), { ok: true, value: 8000 })
  assert.deepEqual(parseCalibrationInput('0', '最深深度'), { ok: true, value: 0 }, '0 是合法值（只有水下）')
  const notNumber = parseCalibrationInput('很深', '最深深度')
  assert.equal(notNumber.ok, false)
  assert.match(notNumber.ok ? '' : notNumber.problem, /最深深度/)
  const negative = parseCalibrationInput('-100', '最高高度')
  assert.equal(negative.ok, false)
  assert.match(negative.ok ? '' : negative.problem, /正数/)
})

test('previewCalibrationTable：三行锚点、三列单位；未标定时给一句可操作的话', () => {
  const table = previewCalibrationTable(WORLD)
  const lines = table.split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0]!, /米/)
  assert.match(lines[0]!, /千米/)
  assert.match(lines[0]!, /相对值/)
  // 最深点那一行：8000 m / 8 km / 0.00；最高点那一行：-3000 m / -3 km / 1
  assert.match(lines[1]!, /^最深点/)
  assert.match(lines[1]!, /8000/)
  assert.match(lines[1]!, /相对值[\s\S]*0$|0$/)
  assert.match(lines[3]!, /^最高点/)
  assert.match(lines[3]!, /-3000/)
  assert.match(lines[3]!, /1$/)
  // 海平面落在 8000/11000 ≈ 0.73（不强行对称到 0.5）
  assert.match(lines[2]!, /0\.73/)
  assert.notEqual(table, previewCalibrationTable(DEFAULT_ELEVATION_CALIBRATION))
  assert.match(previewCalibrationTable(DEFAULT_ELEVATION_CALIBRATION), /还差一端/)
})