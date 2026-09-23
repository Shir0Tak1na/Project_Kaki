/**
 * 视口变换的单元测试。
 * 注意：这些公式在设计文档 §3 中标为「推导」，本测试只保证其**自洽**
 * （往返一致、中心对齐、缩放比例正确）；与 Obsidian 真实行为的一致性由 P4 探针负责。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TZOOM,
  MIN_TZOOM,
  bboxIntersects,
  clampTZoom,
  isViewport,
  scaleOf,
  screenToWorld,
  viewportWorldBBox,
  worldToScreen,
  type Viewport,
} from '../src/core/viewport.ts'

const viewport: Viewport = { tx: 120, ty: -340, tZoom: 0.5, width: 1000, height: 600 }

test('缩放比例等于 2^tZoom', () => {
  assert.equal(scaleOf({ ...viewport, tZoom: 0 }), 1)
  assert.equal(scaleOf({ ...viewport, tZoom: 1 }), 2)
  assert.equal(scaleOf({ ...viewport, tZoom: -1 }), 0.5)
})

test('视口中心对应世界坐标 (tx, ty)', () => {
  const screen = worldToScreen(viewport, { x: viewport.tx, y: viewport.ty })
  assert.ok(Math.abs(screen.x - viewport.width / 2) < 1e-9)
  assert.ok(Math.abs(screen.y - viewport.height / 2) < 1e-9)

  const world = screenToWorld(viewport, { x: viewport.width / 2, y: viewport.height / 2 })
  assert.ok(Math.abs(world.x - viewport.tx) < 1e-9)
  assert.ok(Math.abs(world.y - viewport.ty) < 1e-9)
})

test('两种转换互为逆运算', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 1000, y: 600 },
    { x: -253.7, y: 812.4 },
  ]
  for (const p of points) {
    const back = screenToWorld(viewport, worldToScreen(viewport, p))
    assert.ok(Math.abs(back.x - p.x) < 1e-6 && Math.abs(back.y - p.y) < 1e-6)
  }
})

test('可见世界范围的尺寸与缩放成反比', () => {
  const bbox = viewportWorldBBox(viewport)
  const scale = scaleOf(viewport)
  assert.ok(Math.abs(bbox.maxX - bbox.minX - viewport.width / scale) < 1e-9)
  assert.ok(Math.abs(bbox.maxY - bbox.minY - viewport.height / scale) < 1e-9)
  assert.ok(Math.abs((bbox.minX + bbox.maxX) / 2 - viewport.tx) < 1e-9)
  assert.ok(Math.abs((bbox.minY + bbox.maxY) / 2 - viewport.ty) < 1e-9)
})

test('矩形相交判定', () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
  assert.equal(bboxIntersects(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 }), true)
  assert.equal(bboxIntersects(a, { minX: 20, minY: 0, maxX: 30, maxY: 10 }), false)
  assert.equal(bboxIntersects(a, { minX: 10.0001, minY: 0, maxX: 20, maxY: 10 }), false)
})

test('tZoom 被 clamp 在 Obsidian 的区间内', () => {
  assert.equal(clampTZoom(99), MAX_TZOOM)
  assert.equal(clampTZoom(-99), MIN_TZOOM)
  assert.equal(clampTZoom(0.25), 0.25)
})

test('形状守卫拒绝不可用的视口数据', () => {
  assert.equal(isViewport(viewport), true)
  assert.equal(isViewport({ ...viewport, tx: Number.NaN }), false)
  assert.equal(isViewport({ ...viewport, width: 0 }), false)
  assert.equal(isViewport({ ...viewport, tZoom: '0' }), false)
  assert.equal(isViewport(null), false)
  assert.equal(isViewport({ tx: 0, ty: 0 }), false)
})
