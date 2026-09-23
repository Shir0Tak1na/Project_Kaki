/**
 * 编辑历史与笔迹采样的单元测试。
 * 这两块决定了"撤销能不能真的退回原状"与"快速拖动会不会断线"，都属于必须钉死的行为。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { History, applyOp, buildSetOps, invertOp, type MapOp, type SetTerrainOp } from '../src/editor/history.ts'
import { SAMPLE_SPACING_RATIO, cellsAlongSegment, cellsAtPoint } from '../src/editor/brushPath.ts'
import { createEmptyMapDocument, type MapDocument, type TerrainCell } from '../src/data/mapDocument.ts'
import { axialToWorld, cellKey, parseCellKey, type GridSpec } from '../src/core/hex.ts'
import { brushCellsAt } from '../src/render/hexGrid.ts'

const pointy: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const flat: GridSpec = { kind: 'hex', orientation: 'flat', size: 27.5, origin: [-120, 340] }
const grids = [pointy, flat]

function forest(): TerrainCell {
  return { t: 'forest' }
}

function snapshot(document: MapDocument): string {
  return JSON.stringify(Object.entries(document.terrain).sort())
}

/** MapOp 现在是联合类型：测试里断言并收窄到地形操作 */
function asTerrainOp(op: MapOp): SetTerrainOp {
  assert.equal(op.kind, 'setTerrain', `期望地形操作，实际 ${op.kind}`)
  return op as SetTerrainOp
}

// ---------------------------------------------------------------- 操作与逆操作

test('删除类 op 的逆操作能把格子恢复成 null 而不是空对象', () => {
  const document = createEmptyMapDocument({})
  document.terrain['0_0'] = forest()

  const ops = buildSetOps(document, [{ q: 0, r: 0 }], null)
  assert.equal(ops.length, 1)
  const op = asTerrainOp(ops[0]!)
  assert.deepEqual(op.previous, { t: 'forest' }, 'previous 应当是原来的格')
  assert.equal(op.next, null, 'next 应当是 null')

  applyOp(document, op)
  assert.equal(document.terrain['0_0'], undefined)

  applyOp(document, invertOp(op))
  assert.deepEqual(document.terrain['0_0'], { t: 'forest' })
})

test('在原本没有地形的格上作画，撤销必须回到「没有这个键」而不是空对象', () => {
  // 这是一个真实的坑：`{ ...null }` 在 JS 里得到 `{}`，
  // 若直接展开赋值，撤销后地图里会留下 {"t":undefined} 这种脏数据。
  const document = createEmptyMapDocument({})
  const ops = buildSetOps(document, [{ q: 3, r: -2 }], forest())
  const op = asTerrainOp(ops[0]!)
  assert.equal(op.previous, null, 'previous 必须是 null')
  applyOp(document, op)
  assert.deepEqual(document.terrain[cellKey(3, -2)], { t: 'forest' })
  applyOp(document, invertOp(op))
  assert.equal(cellKey(3, -2) in document.terrain, false, '撤销后不应残留该键')
})

test('无变化的格不产生 op', () => {
  const document = createEmptyMapDocument({})
  document.terrain['0_0'] = forest()
  assert.equal(buildSetOps(document, [{ q: 0, r: 0 }], forest()).length, 0, '涂同一种地形不应产生历史')
  assert.equal(buildSetOps(document, [{ q: 5, r: 5 }], null).length, 0, '在空白处擦除不应产生历史')
  // 但颜色不同就是变化
  assert.equal(buildSetOps(document, [{ q: 0, r: 0 }], { t: 'forest', c: '#fff' }).length, 1)
})

test('同一笔画内重复经过同一格只记一条 op，且 previous 取最初状态', () => {
  const document = createEmptyMapDocument({})
  document.terrain['0_0'] = { t: 'water' }
  const ops = buildSetOps(document, [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 0 }], forest())
  assert.equal(ops.length, 2, '重复格不应产生第二条 op')
  const first = asTerrainOp(ops.find((op) => op.kind === 'setTerrain' && op.q === 0 && op.r === 0)!)
  assert.deepEqual(first.previous, { t: 'water' }, 'previous 必须是笔画开始前的状态')
})

// ---------------------------------------------------------------- 历史栈

test('一次笔画 = 一条历史：撤销一次即完全回到笔画前', () => {
  const document = createEmptyMapDocument({})
  document.terrain['9_9'] = { t: 'desert' }
  const before = snapshot(document)

  const history = new History(100)
  const cells = brushCellsAt(pointy, { x: 0, y: 0 }, 2)
  assert.equal(cells.length, 19)
  const ops = buildSetOps(document, cells, forest())
  for (const op of ops) applyOp(document, op)
  history.push({ label: '绘制森林', ops })
  assert.equal(Object.keys(document.terrain).length, 20)

  assert.equal(history.canUndo(), true)
  const undone = history.undo(document)
  assert.ok(undone !== null)
  assert.equal(snapshot(document), before, '撤销后必须与笔画前完全一致')
  assert.equal(history.canUndo(), false)
  assert.equal(history.canRedo(), true)
})

test('重做能完整还原，且重做后再撤销仍然一致', () => {
  const document = createEmptyMapDocument({})
  const history = new History(10)
  const ops = buildSetOps(document, brushCellsAt(pointy, { x: 120, y: -60 }, 1), { t: 'hills' })
  for (const op of ops) applyOp(document, op)
  history.push({ label: '绘制丘陵', ops })
  const painted = snapshot(document)

  history.undo(document)
  assert.equal(Object.keys(document.terrain).length, 0)
  history.redo(document)
  assert.equal(snapshot(document), painted)

  history.undo(document)
  assert.equal(Object.keys(document.terrain).length, 0)
})

test('新笔画会清空重做栈', () => {
  const document = createEmptyMapDocument({})
  const history = new History(10)
  const first = buildSetOps(document, [{ q: 0, r: 0 }], forest())
  for (const op of first) applyOp(document, op)
  history.push({ label: 'A', ops: first })

  history.undo(document)
  assert.equal(history.canRedo(), true)

  const second = buildSetOps(document, [{ q: 4, r: 4 }], { t: 'water' })
  for (const op of second) applyOp(document, op)
  history.push({ label: 'B', ops: second })
  assert.equal(history.canRedo(), false, '新操作后不应还能重做旧分支')
})

test('历史上限生效：超出后丢弃最旧的', () => {
  const document = createEmptyMapDocument({})
  const history = new History(3)
  for (let index = 0; index < 5; index += 1) {
    const ops = buildSetOps(document, [{ q: index, r: 0 }], forest())
    for (const op of ops) applyOp(document, op)
    history.push({ label: `#${index}`, ops })
  }
  assert.equal(history.size().undo, 3)
  // 连撤三次后应当只剩最早的两次操作留下的格子
  history.undo(document)
  history.undo(document)
  history.undo(document)
  assert.equal(history.canUndo(), false)
  assert.equal(Object.keys(document.terrain).length, 2)
})

test('空历史上的撤销/重做是安全的空操作', () => {
  const document = createEmptyMapDocument({})
  const history = new History()
  assert.equal(history.undo(document), null)
  assert.equal(history.redo(document), null)
  assert.equal(history.canUndo(), false)
  assert.equal(history.size().undo, 0)
})

test('空 op 列表不会污染历史', () => {
  const history = new History()
  history.push({ label: '空', ops: [] })
  assert.equal(history.canUndo(), false)
  assert.equal(history.peekLabel(), null)
})

test('路径链接操作可撤销、重做并清除', () => {
  const document = createEmptyMapDocument({})
  document.paths.push({ id: 'p1', type: 'river', pts: [[0, 0], [100, 0]], width: 8, color: '#4a9fd8', link: 'Routes/River.md' })
  const history = new History()
  const op: MapOp = { kind: 'setPathLink', id: 'p1', from: 'Routes/River.md', to: 'Routes/NewRiver.md' }
  applyOp(document, op)
  history.push({ label: '设置路径链接', ops: [op] })
  assert.equal(document.paths[0]?.link, 'Routes/NewRiver.md')
  history.undo(document)
  assert.equal(document.paths[0]?.link, 'Routes/River.md')
  history.redo(document)
  assert.equal(document.paths[0]?.link, 'Routes/NewRiver.md')

  const clear: MapOp = { kind: 'setPathLink', id: 'p1', from: 'Routes/NewRiver.md', to: '' }
  applyOp(document, clear)
  assert.equal(document.paths[0]?.link, undefined)
  applyOp(document, invertOp(clear))
  assert.equal(document.paths[0]?.link, 'Routes/NewRiver.md')
})

// ---------------------------------------------------------------- 笔迹采样

test('快速划动不漏格：线段附近应被刷到的格全部在结果里', () => {
  const spacing = pointy.size * SAMPLE_SPACING_RATIO
  for (const grid of grids) {
    const from = axialToWorld(grid, -6, 2)
    const to = axialToWorld(grid, 6, -2)
    const radius = 0
    const { cells, sampling } = cellsAlongSegment(grid, from, to, radius)
    assert.ok(sampling.spacing <= grid.size * 0.5, '采样间距必须小于半格')
    assert.ok(sampling.samples > 5, `采样点太少：${sampling.samples}`)

    const painted = new Set(cells.map((cell) => cellKey(cell.q, cell.r)))

    // 暴力校验：凡是格心到线段的距离小于 0.6×格半径 的格，都必须在结果里
    const threshold = grid.size * 0.6
    const bounds = { minQ: -12, maxQ: 12, minR: -12, maxR: 12 }
    for (let q = bounds.minQ; q <= bounds.maxQ; q += 1) {
      for (let r = bounds.minR; r <= bounds.maxR; r += 1) {
        const center = axialToWorld(grid, q, r)
        if (distanceToSegment(center, from, to) <= threshold) {
          assert.ok(painted.has(cellKey(q, r)), `${grid.orientation} 格 (${q},${r}) 应当被刷到却漏了`)
        }
      }
    }
    void spacing
  }
})

test('笔迹不会过度外扩：所有结果格都在线段附近的合理范围内', () => {
  for (const grid of grids) {
    const from = axialToWorld(grid, 0, 0)
    const to = axialToWorld(grid, 4, 0)
    const { cells } = cellsAlongSegment(grid, from, to, 0)
    for (const cell of cells) {
      const center = axialToWorld(grid, cell.q, cell.r)
      const distance = distanceToSegment(center, from, to)
      assert.ok(
        distance <= grid.size * 1.8,
        `${grid.orientation} 格 (${cell.q},${cell.r}) 距线段 ${distance.toFixed(1)}，超出合理范围`,
      )
    }
  }
})

test('笔迹结果去重且包含起止格', () => {
  const from = axialToWorld(pointy, -3, -3)
  const to = axialToWorld(pointy, 3, 3)
  const { cells } = cellsAlongSegment(pointy, from, to, 1)
  const keys = cells.map((cell) => cellKey(cell.q, cell.r))
  assert.equal(new Set(keys).size, keys.length, '不应有重复格')
  for (const [q, r] of [
    [-3, -3],
    [3, 3],
  ] as const) {
    assert.ok(keys.includes(cellKey(q, r)), `缺少端点格 (${q},${r})`)
  }
})

test('起点为 null 时只取单点落笔', () => {
  const point = axialToWorld(pointy, 5, -4)
  const single = cellsAlongSegment(pointy, null, point, 2)
  assert.equal(single.sampling.samples, 1)
  assert.equal(single.cells.length, 19)
  assert.deepEqual(
    single.cells.map((cell) => cellKey(cell.q, cell.r)).sort(),
    cellsAtPoint(pointy, point, 2)
      .map((cell) => cellKey(cell.q, cell.r))
      .sort(),
  )
})

test('原地不动（零长度线段）不会产生空结果或异常', () => {
  const point = axialToWorld(pointy, 2, 2)
  const { cells, sampling } = cellsAlongSegment(pointy, point, point, 0)
  assert.equal(sampling.samples, 2, '零长度也要有首尾两次采样')
  assert.deepEqual(cells, [{ q: 2, r: 2 }])
})

test('笔迹采样的格坐标都是合法格键', () => {
  const { cells } = cellsAlongSegment(pointy, { x: -500, y: -500 }, { x: 500, y: 500 }, 1)
  for (const cell of cells) {
    assert.ok(Number.isInteger(cell.q) && Number.isInteger(cell.r))
    assert.notEqual(parseCellKey(cellKey(cell.q, cell.r)), null)
  }
})

/** 点到线段的最短距离 */
function distanceToSegment(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < 1e-12) return Math.hypot(point.x - from.x, point.y - from.y)
  const t = Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t))
}
