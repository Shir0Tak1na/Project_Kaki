/**
 * 覆盖层绘制计划（`hex` 与 `field` 两种模式）的单测。
 *
 * 重点盯四件事：
 * 1. **缺数据不画**（`null` 角点不许长出等值线、NaN 样本不许变成一个色块）；
 * 2. **插值真的在按距离加权**（不是最近邻，也不是平均值）；
 * 3. **等值线要接成折线**（否则一个场会切出几百条两点的短线）；
 * 4. **越界值走纯色**（-60 ℃ 用纯蓝底，不是被夹到色带端点）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { GridSpec } from '../src/core/hex.ts'
import { DEFAULT_OVER, DEFAULT_UNDER, defaultTemperatureRamp } from '../src/render/colorRamp.ts'
import {
  MAX_FIELD_DIMENSION,
  buildFieldPlan,
  contourLevels,
  contourPolylines,
  sampleField,
  type FieldGrid,
} from '../src/render/fieldPlan.ts'

const GRID: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const RAMP = defaultTemperatureRamp()

/** 一个"值只随 x 变"的 3×3 采样网格：x = 0/10/20，值 = 0/10/20 */
function linearField(): FieldGrid {
  return { originX: 0, originY: 0, step: 10, cols: 3, rows: 3, values: [0, 10, 20, 0, 10, 20, 0, 10, 20] }
}

test('sampleField：没有样本（或全是 NaN）时返回 null，而不是一张空网格', () => {
  assert.equal(sampleField([], GRID), null)
  assert.equal(sampleField([{ q: 0, r: 0, value: Number.NaN }], GRID), null)
})

test('sampleField：只有一个样本时，半径内处处等于该值', () => {
  const field = sampleField([{ q: 0, r: 0, value: 12 }], GRID, { step: 10, radius: 30 })!
  assert.ok(field !== null)
  assert.equal(
    field.values.every((value) => value === null || Math.abs(value - 12) < 1e-9),
    true,
    JSON.stringify(field.values.slice(0, 6)),
  )
  assert.equal(field.values.some((value) => value !== null), true, '至少要有被覆盖到的采样点')
})

test('sampleField：按距离加权（中点接近两值均值，且离谁近更像谁）', () => {
  // 世界坐标下 (0,0) 与 (2,0) 相距约 138.6（size=40 的尖顶六边形）
  const field = sampleField(
    [
      { q: 0, r: 0, value: 0 },
      { q: 2, r: 0, value: 20 },
    ],
    GRID,
    { step: 10, radius: 200 },
  )!
  const row = 1 // 两个样本都在 y = 0 这一行上
  const values = Array.from({ length: field.cols }, (_, i) => field.values[row * field.cols + i]!)
  assert.equal(
    values.every((value) => value !== null),
    true,
    `这一行应当被完全覆盖：${JSON.stringify(values)}`,
  )
  // 注意**不能**断言严格单调：IDW 在样本附近会鼓起来（靠右端那一点会比它左边略低）。
  // 该断言的是"整体从左到右由 0 升到 20，且中点接近均值"——最近邻或取平均都会违背其中一条。
  assert.ok(values[1]! < 0.01, `左端样本那一格应当≈0，实际 ${values[1]}`)
  assert.ok(values[15]! > 19.9, `右端样本附近应当≈20，实际 ${values[15]}`)
  const middle = values[Math.round((values.length - 1) / 2)]!
  assert.ok(Math.abs(middle - 10) < 2.5, `中点应接近 10，实际 ${middle}`)
  for (let i = 1; i < values.length; i += 1) {
    if (i === 8) continue
    const above = values[i]! > middle
    assert.equal(above, i > 8, `第 ${i} 点应落在中点的${i > 8 ? '右' : '左'}侧：${values[i]}`)
  }
})

test('sampleField：超出影响半径的采样点没有数据（不硬编一个外推值）', () => {
  const field = sampleField([{ q: 0, r: 0, value: 5 }], GRID, { step: 10, radius: 5 })!
  assert.equal(field.values.some((value) => value === null), true)
  assert.equal(field.values.some((value) => value !== null), true)
})

test('sampleField：单边点数有上限（防呆，坏设置不该让每帧算爆）', () => {
  const field = sampleField([{ q: 0, r: 0, value: 5 }, { q: 40, r: 0, value: 9 }], GRID, { step: 1, radius: 20 })!
  assert.ok(field.cols <= MAX_FIELD_DIMENSION && field.rows <= MAX_FIELD_DIMENSION, `${field.cols}×${field.rows}`)
})

test('contourPolylines：线性梯度在 level=5 处得到一条 x=5 的折线，并且已接成一条', () => {
  const lines = contourPolylines(linearField(), 5)
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.equal(lines[0]!.length, 3, '相邻两格的线段必须接成一条（否则会切成一堆两点短线）')
  for (const point of lines[0]!) assert.ok(Math.abs(point[0] - 5) < 1e-9, JSON.stringify(point))
  assert.deepEqual(
    lines[0]!.map((point) => point[1]),
    [20, 10, 0],
  )
})

test('contourPolylines：整场都在 level 之上（或之下）时没有等值线', () => {
  const above: FieldGrid = { ...linearField(), values: Array.from({ length: 9 }, () => 20) }
  assert.deepEqual(contourPolylines(above, 5), [])
  const below: FieldGrid = { ...linearField(), values: Array.from({ length: 9 }, () => 0) }
  assert.deepEqual(contourPolylines(below, 5), [])
})

test('contourPolylines：角点缺数据的那一格不产生线（不许猜一个值过来）', () => {
  // 先确认"没有洞"时是什么样：从 y=0 一路到 y=20 的一条折线（3 个点）
  assert.deepEqual(
    contourPolylines(linearField(), 5).map((line) => line.length),
    [3],
  )
  // 把 (1, 2) 这个角挖成"没有数据"：用到它的两格都必须整格跳过 → 上半段那条线消失
  const withHole: FieldGrid = { ...linearField(), values: [0, 10, 20, 0, 10, 20, 0, null, 20] }
  const lines = contourPolylines(withHole, 5)
  assert.deepEqual(lines.map((line) => line.length), [2], '缺数据的那半段不许画出来')
  assert.deepEqual(
    lines[0]!.map((point) => point[1]),
    [10, 0],
    '剩下的这段只到 y=10，不该延伸到缺数据的那一格',
  )
})

test('contourLevels：给了间距就落在整齐的数值上；没给就用色带锚点；超上限按等距抽稀', () => {
  assert.deepEqual(contourLevels(RAMP, 15), [-30, -15, 0, 15, 30, 45])
  assert.deepEqual(contourLevels(RAMP, null), [-30, 0, 15, 30, 45])
  assert.deepEqual(contourLevels(RAMP, null, 3), [-30, 15, 45], '抽稀要保留两端')
  assert.deepEqual(contourLevels(RAMP, 0), [-30, 0, 15, 30, 45], '间距 <= 0 视为没给')
})

test('buildFieldPlan（hex）：越界值走纯色、透明度被夹取、每格是 6 个顶点的多边形', () => {
  const plan = buildFieldPlan({
    samples: [
      { q: 0, r: 0, value: -100 },
      { q: 1, r: 0, value: 100 },
    ],
    grid: GRID,
    ramp: RAMP,
    mode: 'hex',
    opacity: 3,
  })
  assert.equal(plan.field, null)
  assert.equal(plan.primitives.length, 2)
  const cold = plan.primitives[0]!
  const hot = plan.primitives[1]!
  assert.equal(cold.kind, 'polygon')
  assert.equal(hot.kind, 'polygon')
  if (cold.kind === 'polygon' && hot.kind === 'polygon') {
    assert.equal(cold.color, DEFAULT_UNDER.color, '-100 ℃ 应走"低于下端"的纯蓝')
    assert.equal(hot.color, DEFAULT_OVER.color, '100 ℃ 应走"高于上端"的纯红')
    assert.equal(cold.opacity, 1, '透明度必须夹在 0–1')
    assert.equal(cold.points.length, 6, '六边形必须是 6 个顶点')
    assert.notDeepEqual(cold.points, hot.points, '不同格的多边形位置不该相同')
  }
})

test('buildFieldPlan（hex）：showValues 时在格心画数值，格式由调用方注入', () => {
  const plan = buildFieldPlan({
    samples: [{ q: 0, r: 0, value: 23.456 }],
    grid: GRID,
    ramp: RAMP,
    mode: 'hex',
    opacity: 0.5,
    showValues: true,
    formatValue: (value) => `${value.toFixed(1)} ℃`,
  })
  assert.equal(plan.primitives.length, 2)
  const text = plan.primitives.find((primitive) => primitive.kind === 'text')
  assert.ok(text !== undefined)
  if (text !== undefined && text.kind === 'text') {
    assert.equal(text.text, '23.5 ℃')
    assert.match(text.color, /^#[0-9a-f]{6}$/)
  }
})

test('buildFieldPlan（hex）：没有值的样本被跳过（缺数据 ≠ 极低温）', () => {
  const plan = buildFieldPlan({
    samples: [
      { q: 0, r: 0, value: Number.NaN },
      { q: 1, r: 0, value: 0 },
    ],
    grid: GRID,
    ramp: RAMP,
    mode: 'hex',
    opacity: 0.5,
  })
  assert.equal(plan.primitives.length, 1, '只有一个格有数据')
})

test('buildFieldPlan（field）：产出采样网格 + 每个层级一条折线，且不含多边形', () => {
  const plan = buildFieldPlan({
    samples: [
      { q: 0, r: 0, value: -20 },
      { q: 2, r: 0, value: 40 },
    ],
    grid: GRID,
    ramp: RAMP,
    mode: 'field',
    opacity: 0.6,
    contourInterval: 20,
  })
  assert.ok(plan.field !== null)
  assert.ok(plan.primitives.length > 0)
  for (const primitive of plan.primitives) {
    assert.equal(primitive.kind, 'polyline', JSON.stringify(primitive).slice(0, 80))
    if (primitive.kind === 'polyline') {
      assert.ok(primitive.points.length >= 2)
      assert.equal(primitive.width > 0, true)
    }
  }
})

test('buildFieldPlan：没有任何数据时两种模式都返回空计划（不抛异常）', () => {
  for (const mode of ['hex', 'field'] as const) {
    assert.deepEqual(buildFieldPlan({ samples: [], grid: GRID, ramp: RAMP, mode, opacity: 1 }), {
      primitives: [],
      field: null,
    })
  }
})