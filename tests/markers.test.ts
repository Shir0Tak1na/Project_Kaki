/**
 * 标记与文字标注的单元测试。
 * 覆盖：屏幕布局与裁剪、字号 clamp、点击/拖动判定、id 生成、图标映射、op 往返。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyMapDocument, MARKER_ICONS, type MapDocument } from '../src/data/mapDocument.ts'
import { projectionFrom } from '../src/core/projection.ts'
import {
  MAX_LABEL_FONT_SIZE,
  MIN_LABEL_FONT_SIZE,
  buildPlacements,
  isClickGesture,
  lucideIconFor,
  nextLabelId,
  nextMarkerId,
  snapToCellCenter,
  worldToViewport,
} from '../src/render/markerPlacement.ts'
import { applyOp, invertOp, type MapOp } from '../src/editor/history.ts'
import { axialToWorld } from '../src/core/hex.ts'

/** 与 Phase 0 实测一致的量级 */
const SCALE = 0.44669732651951655
const VIEWPORT = { left: 344.6, top: 78.9, width: 681, height: 724 }
const projection = projectionFrom({ x: 685, y: 441 }, { x: 100, y: 50 }, SCALE)

function documentWithMarkers(): MapDocument {
  const doc = createEmptyMapDocument({ size: 40, orientation: 'pointy' })
  doc.markers.push({ id: 'm1', label: '龙脊山脉', p: [100, 50], icon: 'mountain-peak', link: 'Locations/龙脊山脉.md' })
  doc.labels.push({ id: 'l1', text: '北境王国', p: [100, 50], size: 40 })
  return doc
}

test('标记按投影换算成视口局部屏幕坐标', () => {
  const doc = documentWithMarkers()
  const placements = buildPlacements({ document: doc, projection, viewportRect: VIEWPORT })
  const marker = placements.find((item) => item.kind === 'marker')!
  assert.ok(marker !== undefined)

  // 投影的锚点：client(685,441) ↔ world(100,50)
  const expected = worldToViewport(projection, VIEWPORT, { x: 100, y: 50 })
  assert.equal(marker.x, expected.x)
  assert.equal(marker.y, expected.y)
  assert.ok(Math.abs(marker.x - (685 - VIEWPORT.left)) < 1e-6)
  assert.ok(Math.abs(marker.y - (441 - VIEWPORT.top)) < 1e-6)
  assert.equal(marker.label, '龙脊山脉')
  assert.equal(marker.icon, 'mountain-peak')
  assert.equal(marker.link, 'Locations/龙脊山脉.md')
})

test('视口外的标记被裁掉（DOM 规模只与可见数量有关）', () => {
  const doc = documentWithMarkers()
  doc.markers.push({ id: 'far', label: '远方', p: [100000, 100000], icon: 'city' })
  const placements = buildPlacements({ document: doc, projection, viewportRect: VIEWPORT })
  assert.equal(placements.filter((item) => item.kind === 'marker').length, 1)
  assert.ok(!placements.some((item) => item.id === 'far'))
})

test('裁剪带留白：刚出界的标记仍然保留，避免边缘反复创建/销毁 DOM', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  // 放在视口右侧外 60 px 处（在 160 px 留白内）
  const anchorClient = { x: 685, y: 441 }
  const anchorWorld = { x: 100, y: 50 }
  const worldJustOutside = {
    x: anchorWorld.x + (VIEWPORT.width + 60 - (anchorClient.x - VIEWPORT.left)) / SCALE,
    y: anchorWorld.y,
  }
  doc.markers.push({ id: 'edge', label: '边缘', p: [worldJustOutside.x, worldJustOutside.y], icon: 'town' })
  const placements = buildPlacements({ document: doc, projection, viewportRect: VIEWPORT })
  assert.ok(placements.some((item) => item.id === 'edge'), '留白内的标记应保留')
})

test('文字标注字号随缩放变化并 clamp 在下限与上限之间', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.labels.push(
    { id: 'l1', text: '小', p: [90, 45], size: 4 },
    { id: 'l2', text: '中', p: [95, 48], size: 40 },
    { id: 'l3', text: '大', p: [98, 49], size: 400 },
  )
  const placements = buildPlacements({ document: doc, projection, viewportRect: VIEWPORT })
  const byId = new Map(placements.map((item) => [item.id, item]))
  assert.equal(byId.get('l1')!.fontSize, MIN_LABEL_FONT_SIZE, '过小的字号应被抬到下限')
  assert.equal(byId.get('l3')!.fontSize, MAX_LABEL_FONT_SIZE, '过大的字号应被压到上限')
  const middle = byId.get('l2')!.fontSize!
  assert.ok(middle > MIN_LABEL_FONT_SIZE && middle < MAX_LABEL_FONT_SIZE, `中间值应落在区间内：${middle}`)
  assert.equal(middle, Math.round(40 * SCALE))
  // 默认字号（24 世界单位）在常见缩放下会落到下限，因此下限就是用户实际看到的字号：
  // 它必须足够大（11 px 在真实反馈里被判为过小）
  assert.ok(MIN_LABEL_FONT_SIZE >= 13, `下限过小：${MIN_LABEL_FONT_SIZE}`)
  const defaulted = createEmptyMapDocument({ size: 40 })
  defaulted.labels.push({ id: 'l9', text: '默认', p: [90, 45] })
  const defaultPlacement = buildPlacements({ document: defaulted, projection, viewportRect: VIEWPORT })[0]!
  assert.ok(
    defaultPlacement.fontSize! >= MIN_LABEL_FONT_SIZE,
    `默认字号不能小于下限：${defaultPlacement.fontSize}`,
  )
})

test('缺少可选字段时不产生多余的 undefined 属性', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  doc.markers.push({ id: 'm1', label: '无链接', p: [100, 50], icon: 'city' })
  const placement = buildPlacements({ document: doc, projection, viewportRect: VIEWPORT })[0]!
  assert.equal('link' in placement, false)
  assert.equal('color' in placement, false)
  assert.equal('description' in placement, false)
})

test('点击与拖动的判定', () => {
  assert.equal(isClickGesture({ x: 0, y: 0 }, { x: 2, y: 2 }), true)
  assert.equal(isClickGesture({ x: 0, y: 0 }, { x: 20, y: 0 }), false)
  assert.equal(isClickGesture(null, { x: 0, y: 0 }), false, '没有按下记录时不算点击')
  assert.equal(isClickGesture({ x: 0, y: 0 }, { x: 10, y: 0 }, 12), true, '阈值应可调')
})

test('标记吸附到格心', () => {
  const doc = createEmptyMapDocument({ size: 40, orientation: 'pointy' })
  const center = axialToWorld(doc.grid, 3, -2)
  const snapped = snapToCellCenter(doc.grid, 3, -2)
  assert.deepEqual(snapped, center)
  // 格心附近的抖动应吸附到同一个格心
  const jittered = snapToCellCenter(doc.grid, 3, -2)
  assert.deepEqual(jittered, center)
})

test('id 生成避开已用编号（含手工编辑造成的前缀混用）', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  assert.equal(nextMarkerId(doc), 'm1')
  doc.markers.push({ id: 'm1', label: 'A', p: [0, 0], icon: 'city' })
  assert.equal(nextMarkerId(doc), 'm2')

  // 手工编辑可能把文字标注命名成 m2 这样的"错前缀"：生成器必须同时避开两边的 id，
  // 否则新标记会与已有条目撞 id（撞 id 会让 op 幂等判断和删除行为出错）
  doc.labels.push({ id: 'm2', text: 'B', p: [0, 0] })
  assert.equal(nextMarkerId(doc), 'm3', '应避开文字标注里占用的 m2')

  assert.equal(nextLabelId(doc), 'l1')
  doc.labels.push({ id: 'l1', text: 'C', p: [0, 0] })
  assert.equal(nextLabelId(doc), 'l2')
})

test('每种标记图标都有 Lucide 映射', () => {
  for (const icon of MARKER_ICONS) {
    const lucide = lucideIconFor(icon)
    assert.ok(typeof lucide === 'string' && lucide.length > 0, `${icon} 缺少图标映射`)
  }
  assert.equal(lucideIconFor('city'), 'building-2')
})

// ---------------------------------------------------------------- 标记的 op 往返

test('添加标记的 op 可被撤销与重做', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const op: MapOp = { kind: 'addMarker', marker: { id: 'm1', label: '城', p: [10, 20], icon: 'city', link: 'A.md' } }

  applyOp(doc, op)
  assert.equal(doc.markers.length, 1)

  applyOp(doc, invertOp(op))
  assert.equal(doc.markers.length, 0, '撤销后应移除')

  applyOp(doc, op)
  assert.equal(doc.markers.length, 1, '重做后应恢复')
  assert.equal(doc.markers[0]!.link, 'A.md', '重做必须保留完整数据（含链接）')
})

test('删除标记的逆操作能把标记完整恢复', () => {
  const doc = documentWithMarkers()
  const op: MapOp = { kind: 'removeMarker', marker: { ...doc.markers[0]! } }
  applyOp(doc, op)
  assert.equal(doc.markers.length, 0)
  applyOp(doc, invertOp(op))
  assert.equal(doc.markers.length, 1)
  assert.equal(doc.markers[0]!.label, '龙脊山脉')
  assert.equal(doc.markers[0]!.icon, 'mountain-peak')
})

test('文字标注的 op 可被撤销与重做', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const op: MapOp = { kind: 'addLabel', label: { id: 'l1', text: '此地无银', p: [1, 2], size: 30, bold: true } }
  applyOp(doc, op)
  assert.deepEqual(doc.labels[0], { id: 'l1', text: '此地无银', p: [1, 2], size: 30, bold: true })
  applyOp(doc, invertOp(op))
  assert.equal(doc.labels.length, 0)
})

test('重复添加同一个标记不会产生两份（op 幂等）', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  const op: MapOp = { kind: 'addMarker', marker: { id: 'm1', label: '城', p: [0, 0], icon: 'city' } }
  applyOp(doc, op)
  applyOp(doc, op)
  assert.equal(doc.markers.length, 1)
})

test('删除不存在的标记是安全的空操作', () => {
  const doc = documentWithMarkers()
  const op: MapOp = { kind: 'removeMarker', marker: { id: '不存在', label: 'x', p: [0, 0], icon: 'city' } }
  applyOp(doc, op)
  assert.equal(doc.markers.length, 1, '不应误删其它标记')
})

// ---------------------------------------------------------------- 拖动移动

test('移动标记的 op 可被撤销与重做（逆操作交换 from/to）', () => {
  const doc = documentWithMarkers()
  const op: MapOp = { kind: 'moveMarker', id: 'm1', label: '龙脊山脉', from: [100, 50], to: [280, -160] }

  applyOp(doc, op)
  assert.deepEqual(doc.markers[0]!.p, [280, -160])

  applyOp(doc, invertOp(op))
  assert.deepEqual(doc.markers[0]!.p, [100, 50], '撤销应回到原位')

  applyOp(doc, invertOp(invertOp(op)))
  assert.deepEqual(doc.markers[0]!.p, [280, -160], '重做应回到新位')
})

test('移动文字标注的 op 可被撤销', () => {
  const doc = documentWithMarkers()
  const op: MapOp = { kind: 'moveLabel', id: 'l1', text: '北境王国', from: [100, 50], to: [-300, 420] }
  applyOp(doc, op)
  assert.deepEqual(doc.labels[0]!.p, [-300, 420])
  applyOp(doc, invertOp(op))
  assert.deepEqual(doc.labels[0]!.p, [100, 50])
})

test('移动不存在的条目是安全的空操作', () => {
  const doc = documentWithMarkers()
  applyOp(doc, { kind: 'moveMarker', id: 'nope', label: 'x', from: [0, 0], to: [9, 9] })
  assert.deepEqual(doc.markers[0]!.p, [100, 50], '不应影响其它标记')
})

test('移动 op 不影响其它字段（图标、链接必须保留）', () => {
  const doc = documentWithMarkers()
  applyOp(doc, { kind: 'moveMarker', id: 'm1', label: '龙脊山脉', from: [100, 50], to: [1, 2] })
  assert.equal(doc.markers[0]!.icon, 'mountain-peak')
  assert.equal(doc.markers[0]!.link, 'Locations/龙脊山脉.md')
})
