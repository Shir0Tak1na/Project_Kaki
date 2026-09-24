/**
 * 导出范围解析的单元测试。
 *
 * 这个功能的存在理由只有一条：**一个离主体很远的孤立格会把整张图缩小**。
 * 所以这里最关键的断言不是"三种范围都能算出包围盒"，而是
 * **"按某个区域导出时，远处那一格确实落在视野之外"** —— 那条才是用户要的可判伪结论。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  EXPORT_RANGE_OPTIONS,
  EXPORT_WORLD_PADDING,
  MIN_EXPORT_SPAN,
  boundsSize,
  exportFileNameFor,
  listExportRegions,
  padBounds,
  resolveExportBounds,
  sanitizeFileSegment,
} from '../src/base/exportBounds.ts'
import { buildMapExportSvg } from '../src/base/mapPreview.ts'
import { axialToWorld } from '../src/core/hex.ts'
import type { BBox } from '../src/core/viewport.ts'
import type { MapDocument } from '../src/data/mapDocument.ts'

function makeDocument(): MapDocument {
  return {
    version: 1,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: { '0_0': { t: 'forest' } },
    paths: [],
    regions: [
      { id: 'r1', label: '北境领', pts: [[0, 0], [200, 0], [200, 100], [0, 100]], color: '#44cf6e', opacity: 0.22 },
      { id: 'r2', label: '', pts: [[-50, -50], [-10, -50], [-10, -10]], color: '#c94f4f', opacity: 0.22 },
    ],
    markers: [],
    labels: [],
  }
}

/** 远处那一格的**世界坐标**（用真实几何算，别用"看起来很大"的猜测值当期望） */
function farPoint(document: MapDocument): [number, number] {
  const point = axialToWorld(document.grid, 300, 300)
  return [point.x, point.y]
}

function resolveAllBounds(document: MapDocument): BBox {
  const result = resolveExportBounds({ kind: 'all' }, { document })
  if (!result.ok) throw new Error(result.reason)
  return result.bounds
}

/** 从导出的 SVG 里读出某个标记的像素坐标 */
function readCircle(svg: string, rowId: string): { x: number; y: number } {
  const match = new RegExp(`data-row-id="${rowId}" cx="([-\\d.]+)" cy="([-\\d.]+)"`).exec(svg)
  assert.ok(match, `SVG 里找不到 ${rowId}`)
  return { x: Number(match?.[1]), y: Number(match?.[2]) }
}

test('三种范围都在选项表里，且「全部内容」是第一项（默认值）', () => {
  assert.deepEqual(
    EXPORT_RANGE_OPTIONS.map((option) => option.kind),
    ['all', 'viewport', 'region'],
  )
  for (const option of EXPORT_RANGE_OPTIONS) {
    assert.ok(option.label.length > 0 && option.hint.length > 0, option.kind)
  }
})

test('全部内容：取内容包围盒并加留白，描述里带上尺寸', () => {
  const document = makeDocument()
  const result = resolveExportBounds({ kind: 'all' }, { document })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // 内容含地形格（半径 40 的六边形，约 ±40 世界单位）与区域 r2（到 -50）
  assert.ok(result.bounds.minX <= -50 - EXPORT_WORLD_PADDING + 1e-9, JSON.stringify(result.bounds))
  assert.ok(result.bounds.maxX >= 200 + EXPORT_WORLD_PADDING - 1e-9, JSON.stringify(result.bounds))
  assert.match(result.description, /全部内容/)
  assert.match(result.description, /世界单位/)
})

test('空文档也能导出（不报错、不产出 0 尺寸范围）', () => {
  const empty: MapDocument = { ...makeDocument(), terrain: {}, regions: [], markers: [], labels: [] }
  const result = resolveExportBounds({ kind: 'all' }, { document: empty })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const size = boundsSize(result.bounds)
  assert.ok(size.width > 0 && size.height > 0, JSON.stringify(size))

  // 连文档都没有（理论上不该发生，但范围解析不该因此炸）
  const noDocument = resolveExportBounds({ kind: 'all' }, { document: null })
  assert.equal(noDocument.ok, true)
})

test('当前视口：直接用可见世界矩形；没有可见帧时给可读原因', () => {
  const viewport = { minX: 100, minY: 200, maxX: 500, maxY: 400 }
  const result = resolveExportBounds({ kind: 'viewport' }, { document: makeDocument(), viewportWorld: viewport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.bounds, padBounds(viewport))
  assert.match(result.description, /当前视口/)

  const missing = resolveExportBounds({ kind: 'viewport' }, { document: makeDocument(), viewportWorld: null })
  assert.equal(missing.ok, false)
  if (missing.ok) return
  assert.match(missing.reason, /可见视口/)
})

test('某个区域：范围恰是该区域的包围盒（+留白），**远处的内容落在范围之外**', () => {
  const document = makeDocument()
  // 远处一格（用户问的正是这种情况）：它会把"全部内容"撑得很大
  document.terrain['300_300'] = { t: 'water' }
  document.markers.push({ id: 'far', label: '孤岛', p: farPoint(document), icon: 'tower' })

  const all = resolveExportBounds({ kind: 'all' }, { document })
  const region = resolveExportBounds({ kind: 'region', regionId: 'r1' }, { document })
  assert.equal(all.ok, true)
  assert.equal(region.ok, true)
  if (!all.ok || !region.ok) return

  // 区域范围 = 区域自己的包围盒 + 留白（与远处那一格无关）
  assert.deepEqual(region.bounds, padBounds({ minX: 0, minY: 0, maxX: 200, maxY: 100 }))
  assert.equal(boundsSize(region.bounds).width, 200 + EXPORT_WORLD_PADDING * 2)

  // 这条是**功能存在的理由**：远处那一格不在区域范围里
  const far = farPoint(document)
  assert.ok(far[0] > region.bounds.maxX, JSON.stringify({ far, bounds: region.bounds }))
  assert.ok(far[1] > region.bounds.maxY, JSON.stringify({ far, bounds: region.bounds }))
  // 而"全部内容"必须把它包含进去（对照：证明两条路径真的不同，而不是两条都算同一个盒子）
  assert.ok(all.bounds.maxX >= far[0] && all.bounds.maxY >= far[1], JSON.stringify({ all: all.bounds, far }))
  assert.match(region.description, /北境领/)
})

test('像素级后果：按区域导出时远处内容被 SVG 视口裁掉，按全部内容导出时它还在画面里', () => {
  const document = makeDocument()
  document.terrain['300_300'] = { t: 'water' }
  const far = farPoint(document)
  const near: [number, number] = [100, 50]
  document.markers.push({ id: 'near', label: '近', p: near, icon: 'city' })
  document.markers.push({ id: 'far', label: '远', p: far, icon: 'tower' })

  const region = resolveExportBounds({ kind: 'region', regionId: 'r1' }, { document })
  assert.equal(region.ok, true)
  if (!region.ok) return

  const W = 1600
  const H = 1000
  const inside = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H

  const regionSvg = buildMapExportSvg(document, W, H, [], region.bounds)
  const allSvg = buildMapExportSvg(document, W, H, [], resolveAllBounds(document))

  // 同一份内容、同一个画布尺寸：差别只来自范围
  const nearInRegion = readCircle(regionSvg, 'map:marker:near')
  const farInRegion = readCircle(regionSvg, 'map:marker:far')
  const farInAll = readCircle(allSvg, 'map:marker:far')

  assert.ok(inside(nearInRegion), `区域内的标记本该在画面里：${JSON.stringify(nearInRegion)}`)
  assert.ok(!inside(farInRegion), `远处的标记本该被视口裁掉，却落在画面内：${JSON.stringify(farInRegion)}`)
  assert.ok(inside(farInAll), `按全部内容导出时远处标记本该在画面里：${JSON.stringify(farInAll)}`)
  // 裁掉 ≠ 没画：内容仍然全部绘制，只是落在 viewBox 之外（本项目不替用户丢数据）
  assert.ok(/data-row-id="map:marker:far"/.test(regionSvg), '远处标记仍应被绘制，只是超出 viewport')
  // 远处那一格：区域范围下缩得极小，全部内容下才"参与构图"——这正是用户抱怨的"整张图变小"
  assert.ok(farInRegion.x > farInAll.x * 1.5, JSON.stringify({ farInRegion, farInAll }))
})

test('某个区域：没有区域 / 区域没了，各给一句可读原因', () => {
  const noRegions: MapDocument = { ...makeDocument(), regions: [] }
  const empty = resolveExportBounds({ kind: 'region', regionId: 'r1' }, { document: noRegions })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.reason, /还没有区域/)

  const missing = resolveExportBounds({ kind: 'region', regionId: 'gone' }, { document: makeDocument() })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.match(missing.reason, /找不到/)
    assert.ok(!/undefined|NaN/.test(missing.reason), missing.reason)
  }

  // 传了 kind 却没传 id：同样给原因，而不是崩
  const noId = resolveExportBounds({ kind: 'region' }, { document: makeDocument() })
  assert.equal(noId.ok, false)
})

test('退化输入：单点区域的范围被撑到最小跨度（0 尺寸绝不流到导出层）', () => {
  const degenerate: MapDocument = {
    ...makeDocument(),
    regions: [{ id: 'r1', label: '点', pts: [[10, 20]], color: '#000', opacity: 0.2 }],
  }
  const result = resolveExportBounds({ kind: 'region', regionId: 'r1' }, { document: degenerate })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const size = boundsSize(result.bounds)
  // 单点 + 留白仍然有 64 世界单位宽（留白大于最小跨度），关键是不为 0
  assert.ok(size.width >= MIN_EXPORT_SPAN && size.height >= MIN_EXPORT_SPAN, JSON.stringify(size))

  // 零留白 + 单点：靠最小跨度兜住
  const tight = padBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 0)
  assert.equal(tight.maxX - tight.minX, MIN_EXPORT_SPAN)
  assert.equal(tight.maxY - tight.minY, MIN_EXPORT_SPAN)
  assert.equal((tight.minX + tight.maxX) / 2, 5, '撑开要以原点为中心，不能把内容挪走')
})

test('结果确定：同样的输入两次得到完全相同的包围盒（否则导出会随机变）', () => {
  const document = makeDocument()
  const first = resolveExportBounds({ kind: 'all' }, { document })
  const second = resolveExportBounds({ kind: 'all' }, { document })
  assert.deepEqual(first, second)
})

test('区域列表：未命名的区域也要能选（用序号兜底，否则下拉里一片空白）', () => {
  const regions = listExportRegions(makeDocument())
  assert.deepEqual(regions, [
    { id: 'r1', label: '北境领' },
    { id: 'r2', label: '未命名区域 2' },
  ])
  assert.deepEqual(listExportRegions(null), [])
})

test('文件名：全部内容不加后缀（既有文件名不变），视口/区域带上范围', () => {
  const document = makeDocument()
  assert.equal(exportFileNameFor('Maps/Los', { kind: 'all' }, document), 'Maps/Los')
  assert.equal(exportFileNameFor('Maps/Los', { kind: 'viewport' }, document), 'Maps/Los-视口')
  assert.equal(exportFileNameFor('Maps/Los', { kind: 'region', regionId: 'r1' }, document), 'Maps/Los-北境领')
  // 未命名区域退回一个通用词，而不是拼出以 `-` 结尾的名字
  assert.equal(exportFileNameFor('Maps/Los', { kind: 'region', regionId: 'r2' }, document), 'Maps/Los-未命名区域 2')
  assert.equal(exportFileNameFor('Maps/Los', { kind: 'region', regionId: 'gone' }, document), 'Maps/Los-区域')
})

test('文件名清洗：路径分隔符与非法字符不会造出子目录或非法名', () => {
  assert.equal(sanitizeFileSegment('北境领'), '北境领')
  assert.equal(sanitizeFileSegment('a/b'), 'a-b')
  assert.equal(sanitizeFileSegment('a:b?c*d'), 'a-b-c-d')
  assert.equal(sanitizeFileSegment('  空白   多处  '), '空白 多处')
  assert.equal(sanitizeFileSegment('///'), '', '全是非法字符时返回空串，由调用方退回通用名')
  assert.equal(sanitizeFileSegment('x'.repeat(80)).length, 32, '截断，别造出超长文件名')
  assert.ok(!/[\\/:*?"<>|]/.test(sanitizeFileSegment('a\\b/c:d*e?f"g<h>i|j')))
})
