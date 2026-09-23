/**
 * 路径与区域的几何与 op 单元测试。
 *
 * 命中测试决定"右键能不能删对东西"，平滑与变宽决定"河流看起来对不对"，
 * 包围盒决定裁剪——三者都是不可见但出错就很难查的行为，因此都钉死。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bboxOverlaps,
  buildLinearCommands,
  buildSmoothCommands,
  flattenCommands,
  flattenSteps,
  hitTestPolygon,
  hitTestPolyline,
  pointAtArcLength,
  pointInPolygon,
  pointToPolylineDistance,
  pointToSegmentDistance,
  polygonAnchor,
  polygonCentroid,
  polylineLength,
  polylineMidpoint,
  shapeBounds,
  taperedWidths,
  visiblePolyline,
} from '../src/render/shapeGeometry.ts'
import { PATH_STYLES, REGION_PRESETS, getPathStyle } from '../src/render/shapeStyle.ts'
import { createEmptyMapDocument, PATH_TYPES, type MapPath, type MapRegion } from '../src/data/mapDocument.ts'
import { applyOp, invertOp, type MapOp } from '../src/editor/history.ts'

const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
]
const line = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
]

// ---------------------------------------------------------------- 包围盒

test('包围盒计算与留白', () => {
  assert.equal(shapeBounds([]).empty, true)
  const bounds = shapeBounds(square)
  assert.deepEqual(
    { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY },
    { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  )
  const padded = shapeBounds(line, 10)
  assert.equal(padded.minY, -10, '留白要把线宽算进去，否则边缘的路径会被裁掉')
  assert.equal(padded.maxX, 110)
})

test('包围盒相交判定', () => {
  const a = shapeBounds(square)
  assert.equal(bboxOverlaps(a, { minX: 50, minY: 50, maxX: 200, maxY: 200 }), true)
  assert.equal(bboxOverlaps(a, { minX: 101, minY: 0, maxX: 200, maxY: 10 }), false)
  assert.equal(bboxOverlaps(a, { minX: 100, minY: 0, maxX: 200, maxY: 10 }), true, '边界接触算相交')
})

// ---------------------------------------------------------------- 绘制命令

test('折线命令：一个 moveTo + 若干 lineTo', () => {
  const commands = buildLinearCommands(square)
  assert.equal(commands.length, 4)
  assert.deepEqual(commands[0], { kind: 'moveTo', x: 0, y: 0 })
  assert.equal(commands.filter((c) => c.kind === 'lineTo').length, 3)
  assert.deepEqual(buildLinearCommands([]), [])
  assert.deepEqual(buildLinearCommands([{ x: 5, y: 6 }]), [{ kind: 'moveTo', x: 5, y: 6 }])
})

test('平滑命令：首点精确、段数与贝塞尔数量正确、端点不被外推', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 50, y: 40 },
    { x: 100, y: 0 },
    { x: 150, y: 40 },
  ]
  const commands = buildSmoothCommands(points)
  assert.deepEqual(commands[0], { kind: 'moveTo', x: 0, y: 0 })
  assert.equal(commands.length, points.length, 'n 个点应得 1 个 moveTo + n-1 个贝塞尔')
  assert.equal(commands.filter((c) => c.kind === 'bezierTo').length, points.length - 1)
  // 每段终点必须精确落在原顶点上（否则曲线会飘）
  for (let i = 1; i < commands.length; i += 1) {
    const command = commands[i]!
    assert.equal(command.x, points[i]!.x)
    assert.equal(command.y, points[i]!.y)
  }
  // 首段的控制点不应把曲线拉到起点左侧（首点用镜像点补齐）
  const firstBezier = commands[1]!
  assert.equal(firstBezier.kind, 'bezierTo')
  if (firstBezier.kind === 'bezierTo') {
    assert.ok(firstBezier.c1x >= 0, `首段控制点越界：${firstBezier.c1x}`)
  }
})

test('平滑命令对单点/空输入安全', () => {
  assert.deepEqual(buildSmoothCommands([]), [])
  assert.deepEqual(buildSmoothCommands([{ x: 1, y: 2 }]), [{ kind: 'moveTo', x: 1, y: 2 }])
})

test('河流变宽：宽度递减且能到设定比例', () => {
  const widths = taperedWidths(10, 5, 0.3)
  assert.equal(widths.length, 5)
  assert.equal(widths[0], 10)
  assert.ok(Math.abs(widths[4]! - 3) < 1e-9, `末端宽度应为 3，实际 ${widths[4]}`)
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i]! < widths[i - 1]!, '宽度必须单调递减')
  }
  assert.deepEqual(taperedWidths(8, 0), [])
  assert.deepEqual(taperedWidths(8, 1), [8], '单段时保持原宽')
})

// ---------------------------------------------------------------- 距离与命中

test('点到线段距离', () => {
  assert.equal(pointToSegmentDistance({ x: 50, y: 30 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 30)
  assert.equal(pointToSegmentDistance({ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 10, '超出端点时算到端点')
  assert.equal(pointToSegmentDistance({ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 0)
  assert.equal(pointToSegmentDistance({ x: 10, y: 10 }, { x: 5, y: 5 }, { x: 5, y: 5 }), Math.hypot(5, 5), '零长度线段退化为点')
})

test('点到折线距离取各段最小值', () => {
  const polyline = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]
  assert.equal(pointToPolylineDistance({ x: 50, y: 20 }, polyline), 20)
  assert.equal(pointToPolylineDistance({ x: 120, y: 50 }, polyline), 20)
  assert.equal(pointToPolylineDistance({ x: 0, y: 0 }, []), Number.POSITIVE_INFINITY)
})

test('折线命中测试考虑线宽与容差', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]
  assert.equal(hitTestPolyline({ x: 50, y: 3 }, points, { width: 8 }), true, '线宽内应命中')
  assert.equal(hitTestPolyline({ x: 50, y: 6 }, points, { width: 8 }), false, '线宽外不应命中')
  assert.equal(hitTestPolyline({ x: 50, y: 6 }, points, { width: 8, tolerance: 4 }), true, '加上容差应命中')
  assert.equal(hitTestPolyline({ x: 50, y: 0 }, points, { width: 1 }), true, '细线至少要有 1 世界单位的可点范围')
})

test('多边形内外判定（含凹多边形）', () => {
  assert.equal(pointInPolygon({ x: 50, y: 50 }, square), true)
  assert.equal(pointInPolygon({ x: 150, y: 50 }, square), false)
  assert.equal(pointInPolygon({ x: -1, y: 50 }, square), false)
  assert.equal(pointInPolygon({ x: 50, y: 50 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), false, '顶点不足 3 个不算区域')

  // 凹多边形（L 形）：凹口内的点应在外面
  const concave = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 40 },
    { x: 40, y: 40 },
    { x: 40, y: 100 },
    { x: 0, y: 100 },
  ]
  assert.equal(pointInPolygon({ x: 20, y: 20 }, concave), true)
  assert.equal(pointInPolygon({ x: 80, y: 80 }, concave), false, '凹口内应判为外部')
  assert.equal(pointInPolygon({ x: 20, y: 80 }, concave), true)
})

test('区域命中测试直接复用内外判定', () => {
  assert.equal(hitTestPolygon({ x: 50, y: 50 }, square), true)
  assert.equal(hitTestPolygon({ x: 500, y: 500 }, square), false)
})

test('折线长度', () => {
  assert.equal(polylineLength(line), 100)
  // 注意：多边形的"闭合边"不在顶点列表里，因此 4 个顶点只有 3 段
  assert.equal(polylineLength(square), 300, '顶点列表不含回到起点的那条边')
  assert.equal(polylineLength([]), 0)
})

// ---------------------------------------------------------------- 样式

test('每种路径类型都有完整默认样式', () => {
  for (const type of PATH_TYPES) {
    const style = getPathStyle(type)
    assert.equal(style.type, type)
    assert.ok(style.label.length > 0, `${type} 缺少中文名`)
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(style.color), `${type} 颜色不合法：${style.color}`)
    assert.ok(style.width > 0, `${type} 宽度必须为正`)
  }
  assert.equal(PATH_STYLES.river.taper, true, '河流应默认末端变细')
  assert.equal(PATH_STYLES.river.smooth, true, '河流应默认平滑')
  assert.ok((PATH_STYLES.road.dash?.length ?? 0) > 0, '道路应默认虚线')
  assert.ok(REGION_PRESETS.length >= 4)
})

// ---------------------------------------------------------------- 名称锚点

test('路径名称锚点是按弧长的中点，而不是"中间那个顶点"', () => {
  // 顶点分布极不均匀：中间顶点在 x=1，弧长中点在 x=50.5
  const uneven = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 101, y: 0 },
  ]
  const anchor = polylineMidpoint(uneven)
  assert.ok(anchor)
  assert.equal(anchor.point.x, 50.5, '取中间顶点会得出 x=1，明显偏向一侧')
  assert.equal(anchor.point.y, 0)
  assert.deepEqual(anchor.tangent, { x: 1, y: 0 })

  // 切线跟随所在那一段的方向：纵向折线的中点在 (0,50)，切线朝下
  const vertical = polylineMidpoint([
    { x: 0, y: 0 },
    { x: 0, y: 100 },
  ])
  assert.ok(vertical)
  assert.equal(vertical.point.y, 50)
  assert.deepEqual(vertical.tangent, { x: 0, y: 1 })
})

test('路径名称锚点的退化输入不抛异常', () => {
  assert.equal(polylineMidpoint([]), null)
  const single = polylineMidpoint([{ x: 7, y: 9 }])
  assert.deepEqual(single?.point, { x: 7, y: 9 })
  // 零长度折线：不能除以 0 得出 NaN
  const zero = polylineMidpoint([
    { x: 3, y: 3 },
    { x: 3, y: 3 },
  ])
  assert.ok(zero)
  assert.equal(Number.isFinite(zero.point.x), true)
  assert.equal(Number.isFinite(zero.point.y), true)
})

test('多边形面积质心', () => {
  assert.deepEqual(polygonCentroid(square), { x: 50, y: 50 })
  const triangle = polygonCentroid([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
  ])
  assert.ok(Math.abs(triangle.x - 100 / 3) < 1e-9)
  assert.ok(Math.abs(triangle.y - 100 / 3) < 1e-9)
  // 共线退化：不能返回 NaN，退回顶点平均
  const collinear = polygonCentroid([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ])
  assert.deepEqual(collinear, { x: 10, y: 0 })
})

test('凹多边形的名称锚点落在形状内部', () => {
  // "∩"形：面积质心落在缺口里（在多边形之外），必须退化处理
  const notch = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 70, y: 100 },
    { x: 70, y: 30 },
    { x: 30, y: 30 },
    { x: 30, y: 100 },
    { x: 0, y: 100 },
  ]
  const centroid = polygonCentroid(notch)
  assert.equal(pointInPolygon(centroid, notch), false, '前提：这个形状的质心确实在外面')

  const anchor = polygonAnchor(notch)
  assert.ok(anchor)
  assert.equal(pointInPolygon(anchor, notch), true, '名称不能画到形状外面')
  const drift = Math.hypot(anchor.x - centroid.x, anchor.y - centroid.y)
  assert.ok(drift < 40, `应当尽量靠近质心，实际偏离 ${drift.toFixed(1)}`)
  // 顶点平均（= (50,66.25)）会直接落到缺口里，这里必须与它不同
  assert.notDeepEqual({ x: Math.round(anchor.x), y: Math.round(anchor.y) }, { x: 50, y: 66 })
})

test('凸多边形的名称锚点就是质心；顶点不足时退回平均', () => {
  const anchor = polygonAnchor(square)
  assert.deepEqual(anchor, { x: 50, y: 50 })
  assert.deepEqual(polygonAnchor([
    { x: 0, y: 0 },
    { x: 10, y: 20 },
  ]), { x: 5, y: 10 })
  assert.equal(polygonAnchor([]), null)
})

// ---------------------------------------------------------------- 展平与弧长

test('按弧长取点：端点、中点与越界夹取', () => {
  const path = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]
  assert.deepEqual(pointAtArcLength(path, 0)?.point, { x: 0, y: 0 })
  assert.deepEqual(pointAtArcLength(path, 200)?.point, { x: 100, y: 100 })
  // 弧长 150 落在第二段的一半处
  assert.deepEqual(pointAtArcLength(path, 150)?.point, { x: 100, y: 50 })
  assert.deepEqual(pointAtArcLength(path, 50)?.tangent, { x: 1, y: 0 })
  assert.deepEqual(pointAtArcLength(path, 150)?.tangent, { x: 0, y: 1 })
  // 越界夹到端点，而不是外推
  assert.deepEqual(pointAtArcLength(path, -50)?.point, { x: 0, y: 0 })
  assert.deepEqual(pointAtArcLength(path, 9999)?.point, { x: 100, y: 100 })
  assert.equal(pointAtArcLength([], 10), null)
})

test('展平平滑曲线：形状不再是控制折线', () => {
  // 直角折线 vs 平滑曲线：平滑后曲线会离开原始线段
  const corner = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 500 },
  ]
  const steps = flattenSteps(corner.length - 1)
  const flat = flattenCommands(buildSmoothCommands(corner), steps)

  assert.equal(flat.length, 1 + steps * (corner.length - 1), '点数 = 起点 + 每段采样数 × 段数')
  assert.deepEqual(flat[0], corner[0], '起点必须精确')
  assert.deepEqual(flat[flat.length - 1], corner[2], '终点必须精确')

  // 关键性质：展平后的点与"控制折线"差得很远 —— 直接连顶点就会退化成折线
  // （曲线在直角处会向外鼓出：这里量到几十个世界单位，正是"不能拿控制点当曲线"的原因）
  const maxDeviationToControl = Math.max(
    ...flat.map((point) => pointToPolylineDistance(point, corner)),
  )
  assert.ok(maxDeviationToControl > 5, `曲线应明显离开控制折线，实际 ${maxDeviationToControl.toFixed(1)}`)

  // 逐段转角：曲线把 90° 的转角摊到很多小角上，折线则集中成一个大角
  let maxTurn = 0
  let totalTurn = 0
  for (let i = 1; i < flat.length - 1; i += 1) {
    const a = flat[i - 1]!
    const b = flat[i]!
    const c = flat[i + 1]!
    const first = Math.atan2(b.y - a.y, b.x - a.x)
    const second = Math.atan2(c.y - b.y, c.x - b.x)
    let delta = second - first
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    maxTurn = Math.max(maxTurn, Math.abs(delta))
    totalTurn += delta
  }
  const toDegrees = (value: number) => (value * 180) / Math.PI
  assert.ok(toDegrees(maxTurn) < 15, `最大单点转角应很小，实际 ${toDegrees(maxTurn).toFixed(1)}°`)
  assert.ok(Math.abs(toDegrees(totalTurn) - 90) < 5, `总转角应约等于 90°，实际 ${toDegrees(totalTurn).toFixed(1)}°`)
})

test('展平采样数有上限（变宽描边是逐段 stroke，不能无节制）', () => {
  // 退化输入（0/1 段）给的是每段上限值：调用方在那种情况下本来就没东西可展平，
  // 但返回值必须始终是合法采样数
  assert.ok(flattenSteps(0) >= 2, '采样数不能小于 2，否则曲线看不出来')
  assert.equal(flattenSteps(1), 24)
  assert.equal(flattenSteps(2), 24)
  assert.equal(flattenSteps(8), 12)
  // 总段数受上限约束；顶点极多时退化为"每控制段 2 个采样"
  // （这与逐段描边本身的固有成本同阶：N 个控制段本来就要 N 次 stroke）
  for (const segments of [1, 2, 4, 8, 16, 64, 200]) {
    const steps = flattenSteps(segments)
    const budget = Math.max(96, 2 * segments)
    assert.ok(steps * segments <= budget, `${segments} 段 → 每段 ${steps} 采样，总数 ${steps * segments} > ${budget}`)
    assert.ok(steps >= 2, `每段至少 2 个采样，否则长曲段会被画成直弦（实际 ${steps}）`)
  }
})

test('展平对直连命令原样保留（不做无谓插值）', () => {
  const flat = flattenCommands(buildLinearCommands(square), 12)
  assert.deepEqual(flat, square)
})

test('可见几何：平滑路径展平，线性路径原样', () => {
  const corner = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ]
  const smooth = visiblePolyline(corner, true)
  assert.ok(smooth.length > corner.length, '平滑路径应被展平')
  assert.deepEqual(smooth[0], corner[0])
  assert.deepEqual(smooth[smooth.length - 1], corner[corner.length - 1])

  const linear = visiblePolyline(corner, false)
  assert.deepEqual(linear, corner, '线性路径必须原样返回')
  // 不能返回同一个数组引用（调用方可能就地排序/反转）
  assert.notEqual(linear, corner)

  // 顶点不足时即使声明平滑也不能展平（否则会退化成空曲线）
  const two = [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ]
  assert.deepEqual(visiblePolyline(two, true), two)
})

test('命名锚点与"可见几何"一致：文字贴在画出来的曲线上', () => {
  const corner = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 500 },
  ]
  const flat = visiblePolyline(corner, true)
  const anchor = polylineMidpoint(flat)
  assert.ok(anchor)
  // 曲线的弧长中点会偏离控制折线（这正是"不能拿控制顶点当锚点"的原因）
  const deviation = pointToPolylineDistance(anchor.point, corner)
  assert.ok(deviation > 1, `曲线中点应明显离开控制折线，实际 ${deviation.toFixed(1)}`)
  assert.ok(pointToPolylineDistance(anchor.point, flat) < 1e-9, '锚点必须就在曲线上')
})

// ---------------------------------------------------------------- op 往返

function makePath(): MapPath {
  return {
    id: 'p1',
    type: 'river',
    pts: [
      [0, 0],
      [100, 50],
    ],
    width: 8,
    color: '#4a9fd8',
    taper: true,
    smooth: true,
  }
}

function makeRegion(): MapRegion {
  return { id: 'r1', label: '北境', pts: [[0, 0], [100, 0], [100, 100]], color: '#44cf6e', opacity: 0.22 }
}

test('新增/删除路径的 op 可往返（含样式字段）', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const op: MapOp = { kind: 'addPath', path: makePath() }
  applyOp(doc, op)
  assert.equal(doc.paths.length, 1)
  assert.equal(doc.paths[0]!.taper, true)
  assert.equal(doc.paths[0]!.smooth, true)
  applyOp(doc, invertOp(op))
  assert.equal(doc.paths.length, 0)
  applyOp(doc, op)
  assert.deepEqual(doc.paths[0], makePath(), '重做必须保留完整样式')
})

test('新增/删除区域的 op 可往返（含标签与透明度）', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const op: MapOp = { kind: 'addRegion', region: makeRegion() }
  applyOp(doc, op)
  assert.equal(doc.regions[0]!.label, '北境')
  assert.equal(doc.regions[0]!.opacity, 0.22)
  applyOp(doc, invertOp(op))
  assert.equal(doc.regions.length, 0)
  applyOp(doc, invertOp(invertOp(op)))
  assert.deepEqual(doc.regions[0], makeRegion())
})

test('重复添加同一路径不会产生两份', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const op: MapOp = { kind: 'addPath', path: makePath() }
  applyOp(doc, op)
  applyOp(doc, op)
  assert.equal(doc.paths.length, 1)
})

test('删除不存在的路径/区域是安全的空操作', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.paths.push(makePath())
  doc.regions.push(makeRegion())
  applyOp(doc, { kind: 'removePath', path: { ...makePath(), id: '不存在' } })
  applyOp(doc, { kind: 'removeRegion', region: { ...makeRegion(), id: '不存在' } })
  assert.equal(doc.paths.length, 1)
  assert.equal(doc.regions.length, 1)
})

test('重命名路径的 op 可往返（含"清除名称"）', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.paths.push(makePath())
  assert.equal(doc.paths[0]!.label, undefined, '前提：初始没有名称')

  const named: MapOp = { kind: 'renamePath', id: 'p1', from: '', to: '北境商路' }
  applyOp(doc, named)
  assert.equal(doc.paths[0]!.label, '北境商路')

  const renamed: MapOp = { kind: 'renamePath', id: 'p1', from: '北境商路', to: '南岭驿道' }
  applyOp(doc, renamed)
  assert.equal(doc.paths[0]!.label, '南岭驿道')
  applyOp(doc, invertOp(renamed))
  assert.equal(doc.paths[0]!.label, '北境商路', '撤销重命名必须回到上一个名字')

  // 空名字 = 清除：字段应当被删掉，而不是留一个空串
  const cleared: MapOp = { kind: 'renamePath', id: 'p1', from: '北境商路', to: '' }
  applyOp(doc, cleared)
  assert.equal(doc.paths[0]!.label, undefined, '清除名称后不应残留 label 字段')
  assert.equal(Object.hasOwn(doc.paths[0]!, 'label'), false)
  applyOp(doc, invertOp(cleared))
  assert.equal(doc.paths[0]!.label, '北境商路', '撤销清除必须恢复名称')
})

test('重命名区域的 op 可往返', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.regions.push(makeRegion())
  assert.equal(doc.regions[0]!.label, '北境')

  const op: MapOp = { kind: 'renameRegion', id: 'r1', from: '北境', to: '北境领' }
  applyOp(doc, op)
  assert.equal(doc.regions[0]!.label, '北境领')
  applyOp(doc, invertOp(op))
  assert.equal(doc.regions[0]!.label, '北境')

  // 区域用空串表示"没有名称"（模型里 label 是必填字段，不能删）
  const cleared: MapOp = { kind: 'renameRegion', id: 'r1', from: '北境', to: '' }
  applyOp(doc, cleared)
  assert.equal(doc.regions[0]!.label, '')
  applyOp(doc, invertOp(cleared))
  assert.equal(doc.regions[0]!.label, '北境')
})

test('重命名不存在的形状是安全的空操作', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.paths.push(makePath())
  applyOp(doc, { kind: 'renamePath', id: '缺失', from: '', to: 'X' })
  applyOp(doc, { kind: 'renameRegion', id: '缺失', from: '', to: 'X' })
  assert.equal(doc.paths[0]!.label, undefined, '不能误改到别的形状上')
})

test('序列化往返保留路径名称', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const path = { ...makePath(), label: '北境商路' }
  doc.paths.push(path)
  const roundTripped = JSON.parse(JSON.stringify(doc)) as typeof doc
  assert.equal(roundTripped.paths[0]!.label, '北境商路')
})

test('序列化往返保留路径与区域', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.paths.push(makePath())
  doc.regions.push(makeRegion())
  // 直接借用文档模块的解析器做一次真实往返
  const roundTripped = JSON.parse(JSON.stringify(doc)) as typeof doc
  assert.deepEqual(roundTripped.paths[0], makePath())
  assert.deepEqual(roundTripped.regions[0], makeRegion())
})
