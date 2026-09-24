/**
 * 「整片一张图」的纯逻辑单测。
 *
 * 重点在三条**用户明确要求**的性质上：
 * 1. "**连通**的同类型格共用一张图" —— 隔着别的格就不算一块（所以按邻接，不按包围盒）；
 * 2. "**不改变图片比例**" —— contain 适配的比例必须与图片一致（拉伸会让圆形湖泊变椭圆）；
 * 3. "**超出区域的不渲染**" —— 这一条靠渲染层的 `clip()` 实现，但包围盒必须是**顶点**范围，
 *    否则裁剪路径与图片对不上（这条在这里钉住）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  boundsOf,
  findTerrainRegions,
  fitContain,
  hashTerrainCells,
} from '../src/render/terrainRegions.ts'
import { hexCorners, hexDistance, type GridSpec } from '../src/core/hex.ts'

const GRID: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }

test('邻接方向自验证：6 个方向的距离都必须是 1（写错方向会当场失败）', () => {
  // 直接引用模块内部方向的等价写法：本测试用"相邻格应该同块、非相邻格应该不同块"来间接验证，
  // 同时显式确认六个方向的 hexDistance 都是 1。
  const directions: Array<[number, number]> = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ]
  for (const [dq, dr] of directions) {
    assert.equal(hexDistance({ q: 0, r: 0 }, { q: dq, r: dr }), 1, `方向 (${dq},${dr}) 距离应为 1`)
  }
  assert.equal(new Set(directions.map(([dq, dr]) => `${dq},${dr}`)).size, 6, '六个方向必须互不相同')
})

test('连通块：相邻同类聚成一块，隔着别的格不算一块', () => {
  // (0,0) 与 (1,0) 相邻；(10,10) 孤立
  const regions = findTerrainRegions(
    [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 10, r: 10 },
    ],
    GRID,
  )
  assert.equal(regions.length, 2, JSON.stringify(regions.map((region) => region.cells)))
  assert.deepEqual(regions[0]!.cells, [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
  ])
  assert.deepEqual(regions[1]!.cells, [{ q: 10, r: 10 }])
})

test('连通块：单格是一块；空输入返回空数组（不抛异常）', () => {
  assert.equal(findTerrainRegions([], GRID).length, 0)
  const single = findTerrainRegions([{ q: -3, r: 7 }], GRID)
  assert.equal(single.length, 1)
  assert.deepEqual(single[0]!.cells, [{ q: -3, r: 7 }])
})

test('连通块：链式相邻算一块，对角（不相邻）算两块', () => {
  // 轴向坐标里 (0,0) → (1,0) → (2,0) 是链；(0,0) 与 (1,1) **不**相邻
  const chain = findTerrainRegions([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }], GRID)
  assert.equal(chain.length, 1)
  assert.equal(chain[0]!.cells.length, 3)

  const diagonal = findTerrainRegions([{ q: 0, r: 0 }, { q: 1, r: 1 }], GRID)
  assert.equal(diagonal.length, 2, '对角方向不是六边形邻接')
})

test('连通块：结果顺序确定（同一批格无论输入顺序如何，结果都一样）', () => {
  const cells = [
    { q: 5, r: -2 },
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: -4, r: 9 },
  ]
  const a = findTerrainRegions(cells, GRID)
  const b = findTerrainRegions([...cells].reverse(), GRID)
  assert.deepEqual(a, b, '顺序必须确定，否则图片会在两块之间跳动')
  // 块内也按格键排序。
  // ⚠️ 不要去假定"第一块就是 (0,0) 那一块"：块顺序按格键字典序，`-4_9` 排在 `0_0` 前面。
  // （第一版就是这么写错的：期望值凭直觉写，实现是对的 —— 见 ENGINEERING-NOTES §5.15。）
  const pair = a.find((region) => region.cells.some((cell) => cell.q === 0 && cell.r === 0))
  assert.deepEqual(pair?.cells, [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
  ])
  assert.deepEqual(
    a.map((region) => region.cells.length),
    [1, 2, 1],
    `三块的大小应当是 1/2/1，实际 ${JSON.stringify(a.map((region) => region.cells.length))}`,
  )
})

test('包围盒取的是**顶点**范围（否则裁剪路径与图片对不上）', () => {
  const one = boundsOf([{ q: 0, r: 0 }], GRID)
  const corners = hexCorners({ ...GRID, origin: [0, 0] }, 0, 0)
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  assert.equal(one.minX, Math.min(...xs))
  assert.equal(one.maxX, Math.max(...xs))
  assert.equal(one.minY, Math.min(...ys))
  assert.equal(one.maxY, Math.max(...ys))
  assert.ok(one.maxX - one.minX > 0 && one.maxY - one.minY > 0)

  const two = boundsOf([{ q: 0, r: 0 }, { q: 1, r: 0 }], GRID)
  assert.ok(two.maxX > one.maxX, '两格连起来的包围盒必须更宽')
  assert.ok(two.maxX - two.minX > one.maxX - one.minX)
})

test('contain 适配：比例不变、装得下、居中', () => {
  const bounds = { minX: 100, minY: 200, maxX: 300, maxY: 300 } // 200 × 100
  // 图片是 4:3（比目标矩形"高"）→ 应当以高度为准，宽度留白
  const fit = fitContain(bounds, 400, 300)
  assert.ok(Math.abs(fit.width / fit.height - 400 / 300) < 1e-9, `比例必须保持：${fit.width}/${fit.height}`)
  assert.equal(fit.height, 100, '高度方向顶满')
  assert.ok(fit.width <= 200 + 1e-9 && fit.height <= 100 + 1e-9, '必须装得下')
  assert.ok(Math.abs((fit.x - bounds.minX) - (bounds.maxX - (fit.x + fit.width))) < 1e-9, '水平方向要居中')
  assert.equal(fit.y, bounds.minY, '高度顶满时垂直方向不留白')

  // 正方形图片放进宽矩形 → 以高度为准，左右留白相等
  const square = fitContain(bounds, 100, 100)
  assert.equal(square.width, square.height)
  assert.equal(square.height, 100)
  assert.equal(square.x, 100 + (200 - 100) / 2)
})

test('contain 适配：图片尺寸非法或目标为空时退化，但不产生 0 尺寸之外的怪值', () => {
  const bounds = { minX: 10, minY: 20, maxX: 30, maxY: 40 }
  for (const [w, h] of [
    [0, 100],
    [100, 0],
    [Number.NaN, 100],
    [100, Number.NaN],
  ] as Array<[number, number]>) {
    const fit = fitContain(bounds, w, h)
    assert.deepEqual(fit, { x: 10, y: 20, width: 20, height: 20 }, `图片尺寸 ${w}×${h} 应退化为铺满`)
  }
  const empty = fitContain({ minX: 5, minY: 5, maxX: 5, maxY: 9 }, 100, 100)
  assert.equal(empty.width, 0, '空目标宽度只能是 0（渲染层会跳过）')
})

test('格子哈希：与顺序无关、能区分不同的格集合', () => {
  const a = [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 2, r: 0 },
  ]
  assert.equal(hashTerrainCells(a), hashTerrainCells([...a].reverse()), '顺序无关')
  assert.notEqual(
    hashTerrainCells(a),
    hashTerrainCells([
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 3, r: 0 },
    ]),
    '格子变了哈希要变（否则缓存不会失效）',
  )
  assert.equal(hashTerrainCells([]), 0)
})
