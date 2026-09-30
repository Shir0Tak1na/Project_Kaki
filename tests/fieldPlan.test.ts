/**
 * 覆盖层绘制计划（`hex` 与 `field` 两种模式）的单测。
 *
 * 重点盯四件事：
 * 1. **缺数据不画**（`null` 角点不许长出等值线、NaN 样本不许变成一个色块）；
 * 2. **插值真的在按距离加权**（不是最近邻，也不是平均值）；
 * 3. **等值线要接成折线**（否则一个场会切出几百条两点的短线）；
 * 4. **越界值照样上色**（-60 ℃ 从端色往外渐变，不是被夹到色带端点、也不是透明）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { GridSpec } from '../src/core/hex.ts'
import { DEFAULT_OVER, DEFAULT_UNDER, colorForValue, defaultTemperatureRamp, textColorOf } from '../src/render/colorRamp.ts'
import { OVERLAY_LABEL_SCALE } from '../src/render/overlayFields.ts'
import {
  CONTOUR_LABEL_SCALE,
  MAX_CONTOUR_LABELS_PER_LEVEL,
  MAX_FIELD_DIMENSION,
  buildFieldPlan,
  compareContourCandidates,
  contourLabelPositions,
  contourLevels,
  contourPolylines,
  cutPolylineAt,
  hashFieldSamples,
  sampleField,
  type FieldGrid,
} from '../src/render/fieldPlan.ts'

const GRID: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const RAMP = defaultTemperatureRamp()
/** 与 `colorRamp` 内部那两个对比色同值（测试里用来断言"描边与字色相反"） */
const DARK_TEXT = '#111827'
const LIGHT_TEXT = '#ffffff'

/** 折线长度（断言"每一段都是真线段"用） */
function polylineLengthOf(points: readonly [number, number][]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1])
  }
  return total
}

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

test('buildFieldPlan（hex）：越界值走越界渐变、透明度被夹取、每格是 6 个顶点的多边形', () => {
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
    // -100 ℃ 越出下端 70 ℃（跨度 75 ℃）⇒ 已经从端蓝走向"极白"；关键是**没被夹到端点色**
    assert.notEqual(cold.color, DEFAULT_UNDER.color, '越界值不该被夹到色带端点')
    assert.equal(colorForValue(-100, RAMP)?.outOfRange, 'under', '越界方向要标出来')
    assert.notEqual(hot.color, DEFAULT_OVER.color)
    assert.equal(colorForValue(100, RAMP)?.outOfRange, 'over')
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
      // 等值线数字的描边**与字色相反**（白字配深边 / 深字配浅边）：写死白边会让浅色场上的深字糊成一坨
      assert.equal(typeof primitive.haloColor, 'string', '压在彩色场与线上的数字必须有描边，否则浅色区域里看不见')
      assert.notEqual(primitive.haloColor, primitive.color, '描边颜色不能与字色相同')
      assert.match(primitive.text, /^-?\d+(\.\d+)?$/, `标注是数值：${primitive.text}`)
    }
  }
})

test('cutPolylineAt：一次挖多个缝 —— N 个数字切出 N+1 段、每个缝居中且角度取该处切线', () => {
  // 一条 300 长的水平线，3 个数字（弧长 50 / 150 / 250），缝宽 30
  const cut = cutPolylineAt(
    [
      [0, 0],
      [300, 0],
    ],
    [50, 150, 250],
    30,
  )
  assert.ok(cut !== null)
  assert.equal(cut.cuts.length, 3)
  assert.equal(cut.segments.length, 4, 'N 个数字 ⇒ N+1 段（这是"沿线重复"的几何前提）')
  // 数字落点与角度
  assert.deepEqual(
    cut.cuts.map((piece) => piece.position),
    [
      [50, 0],
      [150, 0],
      [250, 0],
    ],
  )
  assert.deepEqual(
    cut.cuts.map((piece) => piece.angle),
    [0, 0, 0],
    '水平线的切线角是 0',
  )
  // 每一段的端点：缝宽恰好 30，段与段之间没有重叠、也没有折回去
  const spans = cut.segments.map((segment) => [segment[0]![0], segment[segment.length - 1]![0]])
  assert.deepEqual(spans, [
    [0, 35],
    [65, 135],
    [165, 235],
    [265, 300],
  ])
  for (const segment of cut.segments) {
    assert.ok(polylineLengthOf(segment) > 0, '每一段都必须是真线段（不是零长度的点）')
  }

  // 竖直线上三个数字：每个都立起来（+90°）
  const vertical = cutPolylineAt(
    [
      [0, 0],
      [0, 300],
    ],
    [50, 150, 250],
    30,
  )!
  assert.ok(
    vertical.cuts.every((piece) => Math.abs(piece.angle - Math.PI / 2) < 1e-9),
    `竖线的每个数字都应立起来：${vertical.cuts.map((piece) => piece.angle).join(',')}`,
  )

  // 倒着看的线要翻正：从左下往右上（切线 -135°）→ +45°
  const flipped = cutPolylineAt(
    [
      [0, 0],
      [-300, -300],
    ],
    [150],
    30,
  )!
  assert.ok(Math.abs(flipped.cuts[0]!.angle - Math.PI / 4) < 1e-9, `倒着看的线要翻正，实际 ${flipped.cuts[0]!.angle}`)

  // 顶点间距大于缝宽时，缝**另一侧**的顶点不许被收进前段（否则线段从缝上折回去、把数字压住）
  const straddling = cutPolylineAt(
    [
      [0, 0],
      [30, 0],
      [70, 0],
      [100, 0],
    ],
    [50],
    36,
  )!
  const first = straddling.segments[0]!
  const second = straddling.segments[1]!
  assert.equal(first[first.length - 1]![0], 32, `前段应止于断口起点：${JSON.stringify(first)}`)
  assert.equal(second[0]![0], 68, `后段应从断口终点开始：${JSON.stringify(second)}`)

  // 退化情形：缝把整条线吃掉 / 没有切点 / 不足两个点 → null（调用方退回整条线，不标）
  assert.equal(
    cutPolylineAt(
      [
        [0, 0],
        [40, 0],
      ],
      [20],
      1000,
    ),
    null,
    '缝比线还长时整条线不标',
  )
  assert.equal(cutPolylineAt([[0, 0], [100, 0]], [], 10), null, '没有切点就没有断线可言')
  assert.equal(cutPolylineAt([[0, 0]], [10], 10), null, '不足两个点的折线不挖缝')
})

test('contourLabelPositions：两端留边、按间距重复；间距减半 ⇒ 数量约翻倍（ISSUES-001 §5.5）', () => {
  const width = 10 // 文字宽度
  // 长度 = 4×文字宽度：刚好只放得下一个（两端各留 2×文字宽度）
  assert.deepEqual(contourLabelPositions(40, width, 1000), [20])
  // 验收式：个数 = floor((L − 4w) / 间距) + 1
  const length = 500
  for (const spacing of [60, 120, 240]) {
    const positions = contourLabelPositions(length, width, spacing)
    assert.equal(positions.length, Math.floor((length - 40) / spacing) + 1, `间距 ${spacing} 的个数`)
    assert.ok(positions[0]! >= 20 - 1e-9, '第一个数字不贴端头')
    assert.ok(positions[positions.length - 1]! <= length - 20 + 1e-9, '最后一个数字不贴端头')
    // 单调升序（切点必须升序，否则 `cutPolylineAt` 的窗口会重叠）
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index]! > positions[index - 1]!, '切点必须严格升序')
    }
  }
  // 间距减半 ⇒ 数量约翻倍（单调性：用户把"重复间隔"调小，数字就该变密）
  const dense = contourLabelPositions(length, width, 60).length
  const sparse = contourLabelPositions(length, width, 120).length
  assert.ok(dense > sparse * 1.5, `间距减半应明显变密：${dense} vs ${sparse}`)
  // 间距给得再小也不会挤：实际间距有"文字宽度 × 6"的下限
  assert.deepEqual(contourLabelPositions(500, width, 1), contourLabelPositions(500, width, width * 6))
  // 短于 4×文字宽度：一个都不标
  assert.deepEqual(contourLabelPositions(39, width, 60), [])
  assert.deepEqual(contourLabelPositions(0, width, 60), [])
})

test('buildFieldPlan（field）：等值线标注 —— 沿线旋转、数字处真断开、字色按字底场色且描边相反', () => {
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

  // 描边色必须与字色**相反**（白字配深边 / 深字配浅边）——
  // 旧口径写死白边，于是"深字 + 白边"压在浅色场上等于看不见（用户实测报的"还是黑色的"）
  for (const text of texts) {
    assert.equal(typeof text.haloColor, 'string', '等值线数字必须有描边（否则浅色场上糊成一坨）')
    assert.notEqual(text.haloColor, text.color, `描边必须与字色相反：${text.color} / ${text.haloColor}`)
    assert.equal(
      text.haloColor,
      text.color === DARK_TEXT ? LIGHT_TEXT : DARK_TEXT,
      '描边只能是白 / 近黑里的另一个',
    )
  }

  // 字号进 IR（比格心读数小一档）：它同时决定挖缝宽度，两个后端不能各算一次。
  // ⚠️ 这里断言的是**两个比例之间的关系**（0.7 = 0.35 / 0.5），不是"等于常量自己" ——
  // 后者是自指的：把常量改成 0.5（回到旧口径）它也照样绿
  for (const text of texts) {
    assert.equal(
      text.size,
      GRID.size * CONTOUR_LABEL_SCALE,
      '等值线数字字号 = 格半径 × CONTOUR_LABEL_SCALE',
    )
    assert.equal(
      text.size! / (GRID.size * OVERLAY_LABEL_SCALE),
      0.7,
      '等值线数字要比格心读数小一档（0.35 / 0.5）',
    )
  }

  // 每层最多 12 个（超了沿线均匀抽样，不是"只留最长的几条"）
  for (const level of contourLevels(RAMP, 20)) {
    const label = String(Math.round(level * 10) / 10)
    const count = texts.filter((text) => text.kind === 'text' && text.text === label).length
    assert.ok(count <= MAX_CONTOUR_LABELS_PER_LEVEL, `每一层最多标 12 个：${label} 标了 ${count} 个`)
  }
})

test('buildFieldPlan（field）：压在**深色场**上的数字是白字 + 深边（旧口径写死白边 ⇒ 白配白看不见）', () => {
  // 列值 -60 / -30 / 0：level -30 正好落在色带最低锚点上（纯蓝 #0000ff，很暗）——
  // 那里的字色必须是白的，而描边必须是**深色**。旧口径写死白边时，这一帧就是"白字 + 白边"（用户报的"一坨黑"）
  const cold: FieldGrid = {
    originX: 0,
    originY: 0,
    step: 10,
    cols: 3,
    rows: 31,
    values: new Array(3 * 31).fill(0).map((_, index) => [-60, -30, 0][index % 3]!),
  }
  const plan = buildFieldPlan({
    samples: [],
    grid: GRID,
    ramp: RAMP,
    mode: 'field',
    opacity: 1,
    precomputedField: cold,
    contourInterval: 10,
  })
  const texts = plan.primitives.filter((primitive) => primitive.kind === 'text')
  const onDark = texts.filter((text) => text.kind === 'text' && text.color === LIGHT_TEXT)
  assert.ok(onDark.length > 0, '前提：这一帧里确实有压在深色场上的数字（否则这条断言测不到东西）')
  for (const text of onDark) {
    assert.equal(
      text.kind === 'text' ? text.haloColor : null,
      DARK_TEXT,
      '白字必须配深边 —— 写死白边就是"白配白"，等于没描边',
    )
  }
})

test('buildFieldPlan（field）：重复间隔进几何 —— 调小 ⇒ 数字变多；同一输入两次结果逐项相同', () => {
  // 手造一张"值只随 x 变"的直场（step=10，rows=61 ⇒ 等值线是 600 长的竖线），
  // 用它把"沿线重复"的计数钉死（IDW 出来的场太短，数字根本放不下）。
  // 列值取 0 / 10 / 20 且**间距取 15**：整段里只有 level 15 穿过去一次 ⇒ 恰好一条线，
  // 于是"数字数 vs 折线数"的关系是干净的 N / N+1
  const straight: FieldGrid = {
    originX: 0,
    originY: 0,
    step: 10,
    cols: 3,
    rows: 61,
    values: new Array(3 * 61).fill(0).map((_, index) => (index % 3) * 10),
  }
  const options = {
    samples: [],
    grid: GRID,
    ramp: RAMP,
    mode: 'field' as const,
    opacity: 1,
    precomputedField: straight,
    contourInterval: 15,
  }
  const sparse = buildFieldPlan({ ...options, labelSpacing: 240 })
  const dense = buildFieldPlan({ ...options, labelSpacing: 120 })
  const countOf = (plan: ReturnType<typeof buildFieldPlan>) =>
    plan.primitives.filter((primitive) => primitive.kind === 'text').length
  assert.ok(countOf(sparse) > 0, '前提：这条长线确实会被标')
  assert.ok(countOf(dense) > countOf(sparse), `间隔减半应更密：${countOf(dense)} vs ${countOf(sparse)}`)

  // 确定性：同一输入连算两次，切点坐标逐项相等（否则逐帧抖动、缓存失效）
  const again = buildFieldPlan({ ...options, labelSpacing: 120 })
  const positionsOf = (plan: ReturnType<typeof buildFieldPlan>) =>
    plan.primitives.filter((primitive) => primitive.kind === 'text').map((primitive) => [primitive.x, primitive.y, primitive.text])
  assert.deepEqual(positionsOf(again), positionsOf(dense))

  // 一条线上 N 个数字 ⇒ N+1 段折线（多切点的几何后果）
  const segments = dense.primitives.filter((primitive) => primitive.kind === 'polyline').length
  assert.equal(segments, countOf(dense) + 1, `N 个数字要切出 N+1 段：${segments} / ${countOf(dense)}`)
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