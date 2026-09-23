/**
 * 六边形网格的单元测试。
 * 运行：npm run test（Node 24 原生剥离 TypeScript 类型，不需要任何测试框架）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  axialRound,
  axialToWorld,
  cellKey,
  cellsInRadius,
  hexCorners,
  hexDistance,
  parseCellKey,
  worldToAxial,
  type GridSpec,
} from '../src/core/hex.ts'

const pointy: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const flat: GridSpec = { kind: 'hex', orientation: 'flat', size: 37.5, origin: [123, -456] }
const grids = [pointy, flat]

test('轴向坐标 → 世界坐标 → 轴向坐标：整数格严格往返', () => {
  for (const grid of grids) {
    for (let q = -8; q <= 8; q++) {
      for (let r = -8; r <= 8; r++) {
        const world = axialToWorld(grid, q, r)
        assert.deepEqual(worldToAxial(grid, world), { q, r }, `${grid.orientation} (${q},${r})`)
      }
    }
  }
})

test('任意世界坐标都会吸附到距离不超过外接圆半径的格心', () => {
  let seed = 42
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (const grid of grids) {
    for (let i = 0; i < 500; i++) {
      const x = (rand() - 0.5) * 5000
      const y = (rand() - 0.5) * 5000
      const cell = worldToAxial(grid, { x, y })
      const center = axialToWorld(grid, cell.q, cell.r)
      const dist = Math.hypot(center.x - x, center.y - y)
      assert.ok(dist <= grid.size + 1e-9, `点 (${x},${y}) 距格心 ${dist} > size ${grid.size}`)
    }
  }
})

test('格键的编码与解析可往返', () => {
  for (const [q, r] of [
    [0, 0],
    [-3, 7],
    [12, -9],
  ] as const) {
    assert.deepEqual(parseCellKey(cellKey(q, r)), { q, r })
  }
  assert.equal(parseCellKey('bad'), null)
  assert.equal(parseCellKey('1_2_3'), null)
  assert.equal(parseCellKey('_1'), null)
})

test('六边形顶点的数量与半径正确', () => {
  for (const grid of grids) {
    const center = axialToWorld(grid, 2, -1)
    const corners = hexCorners(grid, 2, -1)
    assert.equal(corners.length, 6)
    for (const corner of corners) {
      const radius = Math.hypot(corner.x - center.x, corner.y - center.y)
      assert.ok(Math.abs(radius - grid.size) < 1e-9, `顶点半径 ${radius} != ${grid.size}`)
    }
  }
})

test('pointy 与 flat 的首个顶点角度分别为 -30 度与 0 度', () => {
  // 注意：顶点坐标是世界坐标，比较角度前必须先减去格心（flat 网格的原点不在 (0,0)，
  // 忘了减会让这个断言在 pointy 上侥幸通过、在 flat 上误报）。
  const angleOf = (grid: GridSpec, corner: { x: number; y: number }): number => {
    const center = axialToWorld(grid, 0, 0)
    return (Math.atan2((corner.y - center.y) / grid.size, (corner.x - center.x) / grid.size) * 180) / Math.PI
  }
  assert.ok(Math.abs(angleOf(pointy, hexCorners(pointy, 0, 0)[0]!) + 30) < 1e-9)
  assert.ok(Math.abs(angleOf(flat, hexCorners(flat, 0, 0)[0]!)) < 1e-9)
})

test('六边形距离符合已知值', () => {
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 3, r: 0 }), 3)
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 0, r: 4 }), 4)
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 2, r: -3 }), 3)
  assert.equal(hexDistance({ q: -2, r: 5 }, { q: -2, r: 5 }), 0)
})

test('半径内的格数与笔刷落点数量一致', () => {
  assert.equal(cellsInRadius(0).length, 1)
  assert.equal(cellsInRadius(1).length, 7)
  assert.equal(cellsInRadius(2).length, 19)
  for (const cell of cellsInRadius(2)) {
    assert.ok(hexDistance(cell, { q: 0, r: 0 }) <= 2)
  }
})

test('立方取整返回整数格且分量满足 x+y+z=0', () => {
  for (const [fq, fr] of [
    [0.4, 0.4],
    [-1.6, 2.2],
    [3.49, -0.51],
    [0, 0],
  ] as const) {
    const cell = axialRound(fq, fr)
    assert.ok(Number.isInteger(cell.q) && Number.isInteger(cell.r))
    assert.equal(cell.q + cell.r + -(cell.q + cell.r), 0)
  }
})
