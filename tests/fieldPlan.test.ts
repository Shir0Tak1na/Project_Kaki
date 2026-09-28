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
import { DEFAULT_OVER, DEFAULT_UNDER, defaultTemperatureRamp, textColorOf } from '../src/render/colorRamp.ts'
import {
  MAX_FIELD_DIMENSION,
  buildFieldPlan,
  contourLevels,
  contourPolylines,
  compareContourCandidates,
  cutPolyline,
  hashFieldSamples,
  sampleField,
  type FieldGrid,
} from '../src/render/fieldPlan.ts'

const GRID: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const RAMP = defaultTemperatureRamp()

/** 一个"值只随 x 变"的 3×3 采样网格：x = 0/10/20，值 = 0/10/20 */
function linearField(): FieldGrid {
  return { originX: 0, originY: 0, step: 10, cols: 3, rows: 3, values: [0, 10, 20, 0, 10, 20, 0, 10, 20] }
}

/** 点是否落在线段上（容差 1e-6）：用来断言"等值线在数字处**真的**断开" */
function pointOnSegment(from: [number, number], to: [number, number], x: number, y: number): boolean {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(x - from[0], y - from[1]) < 1e-6
  const t = ((x - from[0]) * dx + (y - from[1]) * dy) / lengthSquared
  if (t < 0 || t > 1) return false
  return Math.hypot(x - (from[0] + dx * t), y - (from[1] + dy * t)) < 1e-6
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

test('buildFieldPlan（field）：产出采样网格 + **一张连续的栅格** + 每个层级一条折线 + 线上有数值', () => {
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
  const rasters = plan.primitives.filter((primitive) => primitive.kind === 'raster')
  const lines = plan.primitives.filter((primitive) => primitive.kind === 'polyline')
  const texts = plan.primitives.filter((primitive) => primitive.kind === 'text')
  assert.equal(rasters.length, 1, '颜色面只有一张栅格（不是每格一个方块 —— 那正是用户看到的"方格状"）')
  assert.ok(lines.length > 0, '连续场要有等值线')
  assert.equal(texts.length > 0, true, '等值线上要有数值标注（用户实机要求）')
  if (rasters[0]?.kind === 'raster') {
    const raster = rasters[0]
    assert.equal(raster.cols, plan.field.cols)
    assert.equal(raster.rows, plan.field.rows)
    assert.equal(raster.pixels.length, raster.cols * raster.rows * 4, 'RGBA')
    assert.equal(raster.opacity, 0.6, '不透明度由后端统一铺，不写进像素')
    assert.ok(raster.width > 0 && raster.height > 0, '要有世界坐标下的覆盖范围')
    // 有值的点是实色、没值的点全透明（"缺数据"与"极低温"是两件事）
    const alphas = new Set<number>()
    for (let index = 3; index < raster.pixels.length; index += 4) alphas.add(raster.pixels[index]!)
    assert.equal(alphas.has(255), true, '有值的点必须有颜色')
    assert.equal([...alphas].every((alpha) => alpha === 0 || alpha === 255), true, '透明或实色，没有半透明像素')
  }
  for (const primitive of lines) {
    if (primitive.kind === 'polyline') {
      assert.ok(primitive.points.length >= 2)
      assert.equal(primitive.width > 0, true)
      assert.equal(primitive.opacity, 0.6, '等值线也受这一层的不透明度控制')
    }
  }
  for (const primitive of texts) {
    if (primitive.kind === 'text') {
      assert.equal(primitive.halo, true, '压在彩色场与线上的数字必须有白边，否则浅色区域里看不见')
      assert.match(primitive.text, /^-?\d+(\.\d+)?$/, `标注是数值：${primitive.text}`)
    }
  }
})

test('cutPolyline：沿弧长挖掉"文字宽度"那一段 —— 断口居中、角度取切线、倒着看的线被翻正', () => {
  // 一条水平线：(0,0)→(100,0)，挖 36 宽 → 断口 32–68，数字落在 (50,0)、角度 0
  const horizontal = cutPolyline(
    [
      [0, 0],
      [100, 0],
    ],
    36,
  )
  assert.ok(horizontal !== null)
  assert.equal(horizontal.angle, 0)
  assert.deepEqual(horizontal.position, [50, 0])
  const gapStart = horizontal.before[horizontal.before.length - 1]!
  const gapEnd = horizontal.after[0]!
  assert.ok(Math.abs(gapEnd[0] - gapStart[0] - 36) < 1e-9, `断口宽度应等于文字宽度：${gapEnd[0] - gapStart[0]}`)
  assert.equal(horizontal.before.length, 2, '前段：起点 → 断口')
  assert.equal(horizontal.after.length, 2, '后段：断口 → 终点')

  // 竖线：切线角 ≈ +90°（数字跟着立起来）
  const vertical = cutPolyline(
    [
      [0, 0],
      [0, 100],
    ],
    36,
  )!
  assert.ok(Math.abs(vertical.angle - Math.PI / 2) < 1e-9, `竖直线的切线角应为 +90°，实际 ${vertical.angle}`)

  // 从左下往右上的线：切线 -135° → 翻正成 +45°（工程图的数字不许倒着看）
  const flipped = cutPolyline(
    [
      [0, 0],
      [-100, -100],
    ],
    36,
  )!
  assert.ok(Math.abs(flipped.angle - Math.PI / 4) < 1e-9, `倒着看的线要翻正成 45°，实际 ${flipped.angle}`)

  // 顶点间距大于缝宽时，缝**另一侧**的顶点不许被收进前段（否则线段从缝上折回去、把数字压住）
  const straddling = cutPolyline(
    [
      [0, 0],
      [30, 0],
      [70, 0],
      [100, 0],
    ],
    36,
  )!
  const beforeMax = Math.max(...straddling.before.map(([x]) => x))
  const afterMin = Math.min(...straddling.after.map(([x]) => x))
  assert.equal(beforeMax, 32, `前段应止于断口起点：${JSON.stringify(straddling.before)}`)
  assert.equal(afterMin, 68, `后段应从断口终点开始：${JSON.stringify(straddling.after)}`)

  // 缝把整条线吃掉（\(40\) 的点退化不成线段）时返回 null：调用方退回整条线，而不是画一个点
  assert.equal(
    cutPolyline(
      [
        [0, 0],
        [40, 0],
      ],
      1000,
    ),
    null,
    '缝比线还长时不挖（两截都退化成零长度的点）',
  )
  assert.equal(cutPolyline([[0, 0]], 10), null, '不足两个点的折线不挖缝')
})

test('buildFieldPlan（field）：等值线标注按工程图样式 —— 沿线旋转、数字处**真的断开**、用线的对比色', () => {
  const plan = buildFieldPlan({
    // ⚠️ 样本要**相邻**：IDW 的影响半径是"采样步长 × 3"，隔 4 格以上会留空洞（那里本来就没有等值线）
    samples: [
      { q: 0, r: 0, value: -40 },
      { q: 1, r: 0, value: 0 },
      { q: 2, r: 0, value: 40 },
    ],
    grid: GRID,
    ramp: RAMP,
    mode: 'field',
    opacity: 1,
    contourInterval: 20,
  })
  const lines = plan.primitives.filter((primitive) => primitive.kind === 'polyline')
  const texts = plan.primitives.filter((primitive) => primitive.kind === 'text')
  assert.ok(lines.length > 0)
  assert.equal(texts.length > 0, true, '等值线上要有数值标注（用户实机要求）')
  assert.equal(texts.length <= lines.length, true, '标注数不该超过折线条数')

  // 值只随 x 变 → 等值线是竖线 → "数字沿着线排列"意味着绕 ±90° 转（不是横排）
  for (const text of texts) {
    assert.equal(typeof text.rotation, 'number', '标注要带旋转角（沿线排列）')
    assert.ok(
      Math.abs(Math.abs(text.rotation ?? 0) - Math.PI / 2) < 0.35,
      `竖线的数字应当立起来：${text.rotation}`,
    )
  }

  // 数字处**真的断开**：没有任何一条折线跨过标注点。
  // （"拿背景色盖住"的假断线会在这里露馅 —— 那种做法换背景/导出成 SVG 就穿帮。）
  for (const text of texts) {
    const crossed = lines.some(
      (line) =>
        line.kind === 'polyline' &&
        line.points.some((_, index) => {
          if (index === 0) return false
          return pointOnSegment(line.points[index - 1]!, line.points[index]!, text.x, text.y)
        }),
    )
    assert.equal(crossed, false, `数字处必须断开，但有线穿过了 (${text.x}, ${text.y})`)
  }

  // 对比色：标注色 = 某条线色的对比色（不是线自己的颜色 —— 那样数字会与线糊在一起）
  for (const text of texts) {
    const matched = lines.some((line) => line.kind === 'polyline' && textColorOf(line.color) === text.color)
    assert.equal(matched, true, `标注要用线色的对比色，实际 ${text.color}`)
  }

  // 每层最多 3 个（每层十几条线全标会糊成一片）
  for (const level of contourLevels(RAMP, 20)) {
    const label = String(Math.round(level * 10) / 10)
    const count = texts.filter((text) => text.kind === 'text' && text.text === label).length
    assert.ok(count <= 3, `每一层最多标 3 个：${label} 标了 ${count} 个`)
  }
})

test('compareContourCandidates：最长优先；并列时按起点坐标字典序（不许依赖输入顺序）', () => {
  const candidate = (x: number, y: number, length: number, index: number) => ({
    points: [
      [x, y],
      [x, y + length],
    ] as Array<[number, number]>,
    index,
    length,
  })
  const short = candidate(0, 0, 10, 0)
  const long = candidate(0, 0, 20, 1)
  assert.ok(compareContourCandidates(long, short) < 0, '长的排前面')
  // 并列：起点 x 小的排前面
  const left = candidate(3, 100, 10, 2)
  const right = candidate(5, 0, 10, 3)
  assert.ok(compareContourCandidates(left, right) < 0, '长度并列时按起点 x')
  assert.ok(compareContourCandidates(right, left) > 0, '反对称')
  // 起点 x 也相同：再比 y
  const low = candidate(3, 0, 10, 4)
  const high = candidate(3, 100, 10, 5)
  assert.ok(compareContourCandidates(low, high) < 0, 'x 并列时按起点 y')
  // 与输入顺序无关：反过来排出来的前 2 名必须是**同样两条、同样的次序**
  const pool = [right, short, high, left, long, low]
  const firstTwo = [...pool].sort(compareContourCandidates).slice(0, 2).map((entry) => entry.index)
  const reversedFirstTwo = [...pool].reverse().sort(compareContourCandidates).slice(0, 2).map((entry) => entry.index)
  assert.deepEqual(firstTwo, [1, 0], '最长的 long(1)，再是并列里 x 最小的 short(0)')
  assert.deepEqual(reversedFirstTwo, firstTwo, '输入顺序反过来，选中的还是同两条线（连次序都一样）')
})

test('buildFieldPlan（hex）：labelOutOfRange 让越界格总是写数值（不再受 showValues 控制）', () => {
  const input = {
    samples: [
      { q: 0, r: 0, value: -100 },
      { q: 1, r: 0, value: 20 },
    ],
    grid: GRID,
    ramp: RAMP,
    mode: 'hex' as const,
    opacity: 0.5,
  }
  const off = buildFieldPlan(input)
  assert.equal(off.primitives.filter((primitive) => primitive.kind === 'text').length, 0, '默认谁都不写')
  const on = buildFieldPlan({ ...input, labelOutOfRange: true })
  const texts = on.primitives.filter((primitive) => primitive.kind === 'text')
  assert.equal(texts.length, 1, '只有越界的那一格写（带内的 20 不写）')
  if (texts[0]?.kind === 'text') assert.equal(texts[0].text, '-100', '写的是实际值，不是被夹到端点')
  const both = buildFieldPlan({ ...input, showValues: true, labelOutOfRange: true })
  assert.equal(both.primitives.filter((primitive) => primitive.kind === 'text').length, 2, 'showValues 时全都写')
})

test('hashFieldSamples：值进了指纹（只哈希格子会导致"改了一格的值画面不变"）', () => {
  const base = [
    { q: 0, r: 0, value: 10 },
    { q: 1, r: 0, value: 20 },
  ]
  const same = [
    { q: 1, r: 0, value: 20 },
    { q: 0, r: 0, value: 10 },
  ]
  assert.equal(hashFieldSamples(base), hashFieldSamples(same), '顺序无关')
  assert.notEqual(hashFieldSamples(base), hashFieldSamples([{ q: 0, r: 0, value: 11 }, { q: 1, r: 0, value: 20 }]))
  assert.notEqual(hashFieldSamples(base), hashFieldSamples([{ q: 0, r: 0, value: 10 }]), '格数变了也要变')
})

test('sampleField：maxCells 只放大间距（放粗），不改变"有值/没值"的判定口径', () => {
  const samples = [
    { q: 0, r: 0, value: 10 },
    { q: 40, r: 0, value: 30 },
  ]
  const fine = sampleField(samples, GRID)
  const coarse = sampleField(samples, GRID, { maxCells: 16 })
  assert.ok(fine !== null && coarse !== null)
  assert.ok(coarse.cols * coarse.rows <= 64, `应受上限约束：${coarse.cols}×${coarse.rows}`)
  assert.ok(coarse.step > fine.step, '放粗 = 间距变大')
  assert.ok(coarse.values.some((value) => value !== null), '放粗不等于不画')
})

test('buildFieldPlan：没有任何数据时两种模式都返回空计划（不抛异常）', () => {
  for (const mode of ['hex', 'field'] as const) {
    assert.deepEqual(buildFieldPlan({ samples: [], grid: GRID, ramp: RAMP, mode, opacity: 1 }), {
      primitives: [],
      field: null,
    })
  }
})