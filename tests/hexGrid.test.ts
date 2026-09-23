/**
 * 六边形网格空间索引的单元测试。
 *
 * 最关键的一条是「不漏」：可见范围必须覆盖所有与视口相交的格。
 * 多画（过近似）只影响性能，漏画会直接表现为画面缺块，因此用性质测试守住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CHUNK_SIZE,
  brushCellsAt,
  cellIntersectsBBox,
  chunkCoordForCell,
  chunkKeyForCell,
  iterateCells,
  iterateChunks,
  terrainBounds,
  visibleCellBounds,
  visibleChunkBounds,
} from '../src/render/hexGrid.ts'
import type { BBox } from '../src/core/viewport.ts'
import { axialToWorld, type GridSpec } from '../src/core/hex.ts'

const pointy: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const flat: GridSpec = { kind: 'hex', orientation: 'flat', size: 27.5, origin: [-120, 340] }
const grids = [pointy, flat]

/** 确定性伪随机，保证测试可复现 */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

test('可见格范围必须覆盖所有与视口相交的格（不漏）', () => {
  const rand = makeRandom(7)
  for (const grid of grids) {
    for (let trial = 0; trial < 60; trial++) {
      const cx = (rand() - 0.5) * 4000
      const cy = (rand() - 0.5) * 4000
      const w = 100 + rand() * 1500
      const h = 100 + rand() * 1500
      const bbox: BBox = { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 }

      const bounds = visibleCellBounds(grid, bbox, 1)

      // 在更大的范围内扫描：凡是真的与视口相交的格，都必须在 bounds 之内
      for (let q = bounds.minQ - 6; q <= bounds.maxQ + 6; q++) {
        for (let r = bounds.minR - 6; r <= bounds.maxR + 6; r++) {
          if (!cellIntersectsBBox(grid, q, r, bbox)) continue
          const inside = q >= bounds.minQ && q <= bounds.maxQ && r >= bounds.minR && r <= bounds.maxR
          assert.ok(inside, `${grid.orientation} 格 (${q},${r}) 与视口相交却不在范围内`)
        }
      }
    }
  }
})

test('可见格范围是过近似而不是离谱的大范围', () => {
  const bbox: BBox = { minX: -200, maxX: 200, minY: -200, maxY: 200 }
  const bounds = visibleCellBounds(pointy, bbox, 1)
  const width = bounds.maxQ - bounds.minQ + 1
  const height = bounds.maxR - bounds.minR + 1
  // 200 世界单位 / 40 = 5 格，加上过近似与 margin，长宽不应超过 20
  assert.ok(width <= 20 && height <= 20, `范围 ${width}×${height} 过大`)
  assert.ok(width >= 5 && height >= 5, `范围 ${width}×${height} 过小`)
})

test('iterateCells 产出的世界坐标与格心一致', () => {
  const bounds = { minQ: -2, maxQ: 2, minR: -2, maxR: 2 }
  const cells = [...iterateCells(pointy, bounds)]
  assert.equal(cells.length, 25)
  const center = cells.find((c) => c.q === 0 && c.r === 0)!
  assert.equal(center.x, 0)
  assert.equal(center.y, 0)
  const one = cells.find((c) => c.q === 1 && c.r === 0)!
  assert.ok(Math.abs(one.x - Math.sqrt(3) * 40) < 1e-9)
})

test('分块索引：同块内的格得到同一个块键', () => {
  const cells = [...iterateCells(pointy, { minQ: 0, maxQ: DEFAULT_CHUNK_SIZE * 2 - 1, minR: 0, maxR: DEFAULT_CHUNK_SIZE * 2 - 1 })]
  const byChunk = new Map<string, number>()
  for (const cell of cells) {
    const key = chunkKeyForCell(cell.q, cell.r)
    byChunk.set(key, (byChunk.get(key) ?? 0) + 1)
  }
  assert.equal(byChunk.size, 4, '应恰好分成 4 块')
  for (const count of byChunk.values()) assert.equal(count, DEFAULT_CHUNK_SIZE * DEFAULT_CHUNK_SIZE)
})

test('分块坐标对负数格正确向下取整', () => {
  assert.deepEqual(chunkCoordForCell(-1, -1, 16), { cx: -1, cy: -1 })
  assert.deepEqual(chunkCoordForCell(-16, -16, 16), { cx: -1, cy: -1 })
  assert.deepEqual(chunkCoordForCell(-17, -17, 16), { cx: -2, cy: -2 })
  assert.deepEqual(chunkCoordForCell(15, 15, 16), { cx: 0, cy: 0 })
  assert.deepEqual(chunkCoordForCell(16, 16, 16), { cx: 1, cy: 1 })
})

test('可见块范围覆盖可见格范围', () => {
  const cellBounds = { minQ: -20, maxQ: 33, minR: -5, maxR: 4 }
  const chunkBounds = visibleChunkBounds(cellBounds, 16)
  const covered = new Set([...iterateChunks(chunkBounds)].map((c) => c.key))
  for (const cell of iterateCells(pointy, cellBounds)) {
    assert.ok(covered.has(chunkKeyForCell(cell.q, cell.r)), `格 (${cell.q},${cell.r}) 的块不在范围内`)
  }
})

test('笔刷落点数量与半径相符，且中心格一定包含', () => {
  for (const grid of grids) {
    // 必须用该网格自己的格心（flat 网格的原点不在世界原点）
    const center = axialToWorld(grid, 0, 0)
    assert.deepEqual(brushCellsAt(grid, center, 0), [{ q: 0, r: 0 }])
    assert.equal(brushCellsAt(grid, center, 1).length, 7)
    assert.equal(brushCellsAt(grid, center, 2).length, 19)

    const far = axialToWorld(grid, 12, -7)
    const farCenter = brushCellsAt(grid, far, 0)[0]!
    assert.deepEqual(farCenter, { q: 12, r: -7 }, `${grid.orientation} 远端格心应吸附回自身`)
    assert.ok(brushCellsAt(grid, far, 1).some((cell) => cell.q === 12 && cell.r === -7))
  }
})

test('笔刷吸附能吸收坐标量化误差（1 CSS px 量化 ≪ 格宽）', () => {
  // Phase 0 实测：posFromEvt 有 1 CSS px 量化，在当前缩放下约合 3.17 世界单位。
  // 格宽 40 世界单位，因此格心附近的抖动不应改变落点格。
  for (const grid of grids) {
    const center = axialToWorld(grid, 0, 0)
    const jitter = 3.17
    const base = brushCellsAt(grid, center, 0)[0]!
    for (const [dx, dy] of [
      [jitter, 0],
      [0, jitter],
      [-jitter, 0],
      [0, -jitter],
    ] as const) {
      const cell = brushCellsAt(grid, { x: center.x + dx, y: center.y + dy }, 0)[0]!
      assert.deepEqual(cell, base, `${grid.orientation} 抖动 (${dx},${dy}) 不应改变落点格`)
    }
  }
})

test('笔刷落点不以 -0 形式出现（同一格必须只有一种表示）', () => {
  // 格坐标的 -0 与 0 在字符串化后看起来一样，却会让 deepEqual / Object.is 比较不等，
  // 属于已在本项目出现过两次的坑（axialRound、brushCellsAt）。
  const cells = brushCellsAt(pointy, { x: 0, y: 0 }, 0)
  assert.equal(Object.is(cells[0]!.q, -0), false)
  assert.equal(Object.is(cells[0]!.r, -0), false)
  for (const cell of brushCellsAt(pointy, { x: -1e-9, y: 1e-9 }, 1)) {
    assert.equal(Object.is(cell.q, -0), false, `q 出现 -0：${cell.q}`)
    assert.equal(Object.is(cell.r, -0), false, `r 出现 -0：${cell.r}`)
  }
})

test('地形范围统计', () => {
  assert.equal(terrainBounds([]), null)
  assert.equal(terrainBounds(['bad', '1_2_3']), null)
  assert.deepEqual(terrainBounds(['0_0', '-3_5', '7_-2', '2_9']), { minQ: -3, maxQ: 7, minR: -2, maxR: 9 })
})

test('单个格与视口的相交判定', () => {
  const bbox: BBox = { minX: -10, maxX: 10, minY: -10, maxY: 10 }
  assert.equal(cellIntersectsBBox(pointy, 0, 0, bbox), true)
  assert.equal(cellIntersectsBBox(pointy, 50, 0, bbox), false)
  // 邻近格：格心在 x≈69，半径 40 → 左边缘到 29，仍不相交
  assert.equal(cellIntersectsBBox(pointy, 1, 0, bbox), false)
  assert.equal(cellIntersectsBBox(pointy, 1, 0, { minX: 40, maxX: 100, minY: -10, maxY: 10 }), true)
})
