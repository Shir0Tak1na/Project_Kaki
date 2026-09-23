/**
 * 渲染计划与地形样式的单元测试。
 * 渲染层每一帧都会调用这两个模块，因此它们的边界行为必须被钉死。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import { buildRenderPlan, worldToRaster } from '../src/render/renderPlan.ts'
import { projectionFrom } from '../src/core/projection.ts'
import { axialToWorld } from '../src/core/hex.ts'
import { TERRAIN_STYLES, getTerrainStyle, listTerrainStyles, terrainLabel } from '../src/render/terrainStyle.ts'
import { TERRAIN_TYPES } from '../src/data/mapDocument.ts'
import type { GlyphShape } from '../src/render/terrainStyle.ts'

/** 与 Phase 0 实测一致的量级：scale≈0.4467，视口 681×724，dpr 1.65 */
const SCALE = 0.44669732651951655
const DPR = 1.6500000953674316
const VIEWPORT = { left: 344.6, top: 78.9, width: 681, height: 724 }
const projection = projectionFrom({ x: 685, y: 441 }, { x: 100, y: 50 }, SCALE)

function makeDocumentWithCells(inside: Array<[number, number]>, outside: Array<[number, number]>): MapDocument {
  const doc = createEmptyMapDocument({ size: 40, orientation: 'pointy' })
  for (const [q, r] of [...inside, ...outside]) doc.terrain[`${q}_${r}`] = { t: 'forest' }
  return doc
}

test('渲染计划把可见世界范围换算成覆盖层的位置与尺寸', () => {
  const doc = makeDocumentWithCells([[0, 0]], [])
  const plan = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: DPR })
  assert.ok(plan !== null)
  const { layer } = plan!

  // CSS 尺寸用世界单位（父元素会按 scale 缩放它）
  assert.ok(Math.abs(layer.widthWorld - VIEWPORT.width / SCALE) < 1e-6)
  assert.ok(Math.abs(layer.heightWorld - VIEWPORT.height / SCALE) < 1e-6)
  // 位图分辨率 = 视口 CSS 尺寸 × dpr
  assert.equal(layer.rasterWidth, Math.round(VIEWPORT.width * DPR))
  assert.equal(layer.rasterHeight, Math.round(VIEWPORT.height * DPR))
  // 位图坐标 → 世界坐标的换算系数 = scale × dpr
  assert.ok(Math.abs(layer.deviceScale - SCALE * DPR) < 1e-6)
})

test('覆盖层左上角正对可见世界范围的左上角', () => {
  const doc = makeDocumentWithCells([[0, 0]], [])
  const plan = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: DPR })!
  const origin = worldToRaster(plan.layer, plan.visibleWorld.minX, plan.visibleWorld.minY)
  assert.ok(Math.abs(origin.x) < 1e-6)
  assert.ok(Math.abs(origin.y) < 1e-6)

  // 右下角应落在位图右下角附近（允许 1 px 取整误差）
  const corner = worldToRaster(plan.layer, plan.visibleWorld.maxX, plan.visibleWorld.maxY)
  assert.ok(Math.abs(corner.x - plan.layer.rasterWidth) < 1.5, `${corner.x} vs ${plan.layer.rasterWidth}`)
  assert.ok(Math.abs(corner.y - plan.layer.rasterHeight) < 1.5, `${corner.y} vs ${plan.layer.rasterHeight}`)
})

test('视口裁剪：视口外的格被裁掉且计数正确', () => {
  // 视口中心附近 3 格放在里面；远处 5 格必须被裁掉
  const doc = makeDocumentWithCells(
    [
      [0, 0],
      [1, 0],
      [-1, 1],
    ],
    [
      [80, 80],
      [-90, 40],
      [60, -70],
      [120, 0],
      [0, 200],
    ],
  )
  const plan = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: DPR })!
  assert.equal(plan.cells.length, 3, `可见格数 ${plan.cells.length}`)
  assert.equal(plan.culledCells, 5)
})

test('格的世界坐标与几何模块一致（覆盖层与原生节点靠同一套坐标对齐）', () => {
  const doc = makeDocumentWithCells(
    [
      [2, -3],
      [5, 1],
    ],
    [],
  )
  const plan = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: DPR })!
  for (const cell of plan.cells) {
    const expected = axialToWorld(doc.grid, cell.q, cell.r)
    assert.equal(cell.x, expected.x)
    assert.equal(cell.y, expected.y)
  }
})

test('非法输入返回 null 而不是抛异常（每帧都会调用）', () => {
  const doc = makeDocumentWithCells([[0, 0]], [])
  assert.equal(buildRenderPlan({ document: doc, projection, viewportRect: { ...VIEWPORT, width: 0 }, devicePixelRatio: DPR }), null)
  assert.equal(buildRenderPlan({ document: doc, projection, viewportRect: { ...VIEWPORT, height: -5 }, devicePixelRatio: DPR }), null)
  assert.equal(
    buildRenderPlan({ document: doc, projection: { ...projection, scale: 0 }, viewportRect: VIEWPORT, devicePixelRatio: DPR }),
    null,
  )
})

test('devicePixelRatio 非法时退化为 1', () => {
  const doc = makeDocumentWithCells([[0, 0]], [])
  const plan = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: Number.NaN })!
  assert.equal(plan.layer.rasterWidth, Math.round(VIEWPORT.width))
  const negative = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: -2 })!
  assert.equal(negative.layer.rasterWidth, Math.round(VIEWPORT.width))
})

test('超出 maxCells 时宁可少画也不卡死，并计入裁剪数', () => {
  const doc = createEmptyMapDocument({ size: 40 })
  for (let r = -10; r <= 10; r++) {
    for (let q = -10; q <= 10; q++) doc.terrain[`${q}_${r}`] = { t: 'plains' }
  }
  const plan = buildRenderPlan({ document: doc, projection, viewportRect: VIEWPORT, devicePixelRatio: DPR, maxCells: 5 })!
  assert.equal(plan.cells.length, 5)
  assert.ok(plan.culledCells >= 400)
})

test('每种地形都必须有完整样式，且字形坐标在 -1..1 内', () => {
  assert.deepEqual(
    listTerrainStyles().map((style) => style.type),
    [...TERRAIN_TYPES],
  )
  for (const type of TERRAIN_TYPES) {
    const style = getTerrainStyle(type)
    assert.equal(style.type, type)
    assert.ok(style.label.length > 0, `${type} 缺少中文名`)
    assert.ok(/^(#[0-9a-fA-F]{3,8}|rgba?\()/.test(style.base), `${type} 底色不合法：${style.base}`)
    assert.ok(/^(#[0-9a-fA-F]{3,8}|rgba?\()/.test(style.outline), `${type} 描边不合法：${style.outline}`)
    assert.ok(style.glyph.length > 0, `${type} 缺少字形`)

    const points: Array<[number, number]> = []
    for (const shape of style.glyph) {
      if (shape.kind === 'polygon') points.push(...shape.points)
      else if (shape.kind === 'circle') points.push([shape.center[0] + shape.radius, shape.center[1] + shape.radius])
      else if (shape.kind === 'line') points.push(shape.from, shape.to)
      else points.push([shape.center[0] + shape.radius, shape.center[1] + shape.radius])
    }
    for (const [x, y] of points) {
      assert.ok(Math.abs(x) <= 1.05 && Math.abs(y) <= 1.05, `${type} 字形坐标越界：(${x}, ${y})`)
    }
  }
})

test('地形中文名可直接使用', () => {
  assert.equal(terrainLabel('mountain'), '山脉')
  assert.equal(terrainLabel('water'), '水域')
  assert.equal(TERRAIN_STYLES.volcanic.label, '火山')
})

test('字形图元类型覆盖绘制器支持的全部种类', () => {
  const kinds = new Set<GlyphShape['kind']>()
  for (const style of listTerrainStyles()) {
    for (const shape of style.glyph) kinds.add(shape.kind)
  }
  // 至少用到 polygon 与 arc，保证绘制器的主要分支都有真实用例
  assert.ok(kinds.has('polygon'))
  assert.ok(kinds.has('arc'))
  for (const kind of kinds) {
    assert.ok(['polygon', 'circle', 'line', 'arc'].includes(kind), `未知图元：${kind}`)
  }
})
