/**
 * 沿格边几何的单元测试。
 *
 * 这里的性质"看起来显然、错了却很难在画面外发现"：
 * 顶点身份是否归一（同一顶点由 3 个六边形各算一次）、
 * 邻居方向的角度推导是否正确（这是纯推导，必须用性质验证）、
 * 边走出来的每一段是否真的等于一条格边。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dedupeConsecutive,
  snapToHexVertex,
  stepAlongEdges,
  toEdgePath,
  vertexKey,
  vertexNeighbors,
  walkAlongEdges,
  walkTailToCursor,
} from '../src/core/hexEdges.ts'
import { hexCorners, type GridSpec } from '../src/core/hex.ts'
import { polylineLength } from '../src/render/shapeGeometry.ts'

const pointy: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }
const flat: GridSpec = { kind: 'hex', orientation: 'flat', size: 40, origin: [120, -60] }

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

test('顶点身份归一：同一个顶点从不同六边形算出来必须是同一个键', () => {
  for (const grid of [pointy, flat]) {
    for (let q = -2; q <= 2; q += 1) {
      for (let r = -2; r <= 2; r += 1) {
        for (const corner of hexCorners(grid, q, r)) {
          const a = vertexKey(grid, corner)
          // 同一个顶点用"吸附"再算一次（会落到另一个等价表示上）必须得到同一个键
          const b = vertexKey(grid, snapToHexVertex(grid, corner).point)
          assert.equal(a, b, `顶点键不稳定：${JSON.stringify(corner)}`)
        }
      }
    }
  }
})

test('顶点身份唯一：不同顶点不能撞键', () => {
  const keys = new Map<string, { x: number; y: number }>()
  for (let q = -3; q <= 3; q += 1) {
    for (let r = -3; r <= 3; r += 1) {
      for (const corner of hexCorners(pointy, q, r)) {
        const key = vertexKey(pointy, corner)
        const existing = keys.get(key)
        if (existing) {
          assert.ok(distance(existing, corner) < 1e-6, `两个不同顶点撞到了同一个键：${JSON.stringify([existing, corner])}`)
        } else {
          keys.set(key, corner)
        }
      }
    }
  }
  assert.ok(keys.size > 50, `顶点数量看起来不对：${keys.size}`)
})

test('邻居方向推导正确：**每个**顶点都有 3 个邻居，距离等于边长、且都能吸附回自身', () => {
  // 关键：要覆盖两个子格（相邻顶点的边方向相差 60°）。
  // 只测一个顶点会漏掉"固定角度"的写法 —— 第一版就是这么错的。
  let checked = 0
  for (const grid of [pointy, flat]) {
    for (let q = -2; q <= 2; q += 1) {
      for (let r = -2; r <= 2; r += 1) {
        for (const vertex of hexCorners(grid, q, r)) {
          const neighbors = vertexNeighbors(grid, vertex)
          assert.equal(neighbors.length, 3, `顶点 ${JSON.stringify(vertex)} 应有 3 个邻居，实际 ${neighbors.length}`)
          const keys = new Set(neighbors.map((neighbor) => neighbor.key))
          assert.equal(keys.size, 3, '3 个邻居必须互不相同')
          for (const neighbor of neighbors) {
            assert.ok(
              Math.abs(distance(vertex, neighbor.point) - grid.size) < 1e-6,
              `${grid.orientation} 的邻居距离应等于边长，实际 ${distance(vertex, neighbor.point)}`,
            )
            // 邻居必须本身就是格点：吸附回自身。
            // 这里比的是**顶点键**而不是浮点值 —— 三角函数算出来的邻居与 hexCorners 算出来的
            // 同一个顶点会差 ~1e-14，直接 deepEqual 会误报（代码真正依赖的不变量是键相等）。
            assert.equal(
              vertexKey(grid, neighbor.point),
              vertexKey(grid, snapToHexVertex(grid, neighbor.point).point),
              `邻居不是格点（很可能是把格心当成了顶点）：${JSON.stringify(neighbor.point)}`,
            )
          }
          checked += 1
        }
      }
    }
  }
  assert.ok(checked > 100, `覆盖的顶点太少：${checked}`)
})

test('顶点吸附：落在格心时吸到最近的角，落在外围也不会乱跳', () => {
  const center = { x: 0, y: 0 }
  const snapped = snapToHexVertex(pointy, center)
  assert.ok(Math.abs(distance(center, snapped.point) - pointy.size) < 1e-6, '格心到最近的角就是外接圆半径')

  const corner = hexCorners(pointy, 0, 0)[2]!
  assert.deepEqual(snapToHexVertex(pointy, corner).point, corner)

  // 略微偏移仍然吸附到同一个顶点
  const nudged = { x: corner.x + 3, y: corner.y - 2 }
  assert.equal(vertexKey(pointy, snapToHexVertex(pointy, nudged).point), vertexKey(pointy, corner))
})

test('沿格边行走：每一段都恰好是一条格边', () => {
  const from = hexCorners(pointy, 0, 0)[0]!
  const to = hexCorners(pointy, 4, -1)[3]!
  const walk = walkAlongEdges(pointy, from, to)
  assert.ok(walk.length >= 2, `至少应有两端：${walk.length}`)

  for (let i = 0; i < walk.length - 1; i += 1) {
    const step = distance(walk[i]!, walk[i + 1]!)
    assert.ok(Math.abs(step - pointy.size) < 1e-6, `第 ${i} 步不是一条格边：${step}`)
  }
  assert.ok(distance(walk[0]!, from) < 1e-6, '起点必须精确')
  assert.ok(distance(walk[walk.length - 1]!, to) < 1e-6, '终点必须精确')

  // 步数的下界要按**格点度量**算，不是欧氏距离：三条格边方向相隔 120°，
  // 目标落在两个方向之间时要靠"多走再抵消"，最坏约 2 倍（这里 174 单位直线距离需要 7 步 = 280 单位）。
  const direct = distance(from, to)
  assert.ok(
    walk.length - 1 <= Math.ceil(2 * (direct / pointy.size)) + 2,
    `绕路了：${walk.length - 1} 步，直线距离 ${direct.toFixed(1)}`,
  )
})

test('沿格边行走取到的是**最短**路径（用可手算的例子钉死）', () => {
  const v0 = hexCorners(pointy, 0, 0)[0]!
  const v1 = hexCorners(pointy, 0, 0)[1]!  // 同一个六边形的相邻角 = 一条边
  assert.equal(walkAlongEdges(pointy, v0, v1).length - 1, 1, '相邻顶点应当只要 1 步')

  // 隔一个顶点：0 号角 → 2 号角（沿六边形边缘走两跳，或绕另一侧两跳）
  const v2 = hexCorners(pointy, 0, 0)[2]!
  assert.equal(walkAlongEdges(pointy, v0, v2).length - 1, 2, '相邻两跳应当只要 2 步')

  // 跨格：两个格子的同一角点，轴向距离 1 → 沿格边走 2 步（走"上—右"或"右—上"）
  const far = hexCorners(pointy, 1, 0)[0]!
  const steps = walkAlongEdges(pointy, v0, far).length - 1
  assert.ok(steps === 2 || steps === 3, `跨一格应当 2–3 步，实际 ${steps}`)
})

test('沿格边行走：起点等于终点时只返回一个点，且不抛异常', () => {
  const from = hexCorners(pointy, 2, 2)[1]!
  const walk = walkAlongEdges(pointy, from, { x: from.x + 0.5, y: from.y + 0.5 })
  assert.equal(walk.length, 1)
  assert.deepEqual(walkAlongEdges(pointy, from, from), [snapToHexVertex(pointy, from).point])
})

test('转为沿边折线：区域闭合边也沿格边走，且不重复存起点', () => {
  // 一个"斜穿格子"的三角形：自由模式下三条边都是斜线
  const free = [
    { x: 0, y: 0 },
    { x: 300, y: 40 },
    { x: 120, y: 260 },
  ]
  const open = toEdgePath(pointy, free, false)
  const closed = toEdgePath(pointy, free, true)

  assert.ok(closed.length > open.length, '闭合时应当多出一段沿边回程')
  for (let i = 0; i < open.length - 1; i += 1) {
    assert.ok(Math.abs(distance(open[i]!, open[i + 1]!) - pointy.size) < 1e-6, '每一段都应是格边')
  }
  // 闭合边不重复存起点：末点 ≠ 起点，但**隐式闭合的那条边**同样是格边
  const last = closed[closed.length - 1]!
  assert.notEqual(vertexKey(pointy, last), vertexKey(pointy, closed[0]!), '不应保留与起点重合的末尾点')
  assert.ok(
    Math.abs(distance(last, closed[0]!) - pointy.size) < 1e-6,
    `隐式闭合边也必须是格边，实际 ${distance(last, closed[0]!)}`,
  )
  // 折线总长比"自由直线"更长 —— 这正是"沿格边"的代价与观感
  assert.ok(polylineLength(closed) > polylineLength([...free, free[0]!]))
})

test('转为沿边折线：顶点不会被重复输出', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 300, y: 40 },
  ]
  const chain = toEdgePath(pointy, points, false)
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.notEqual(vertexKey(pointy, chain[i]!), vertexKey(pointy, chain[i + 1]!), `第 ${i} 与 ${i + 1} 个点重复了`)
  }
  assert.equal(dedupeConsecutive(pointy, chain).length, chain.length)
})

test('草稿尾巴：从已有顶点走到光标，只返回新增的那一段', () => {
  const start = hexCorners(pointy, 0, 0)[0]!
  const cursor = { x: 500, y: 300 }
  const tail = walkTailToCursor(pointy, start, cursor)
  assert.ok(tail.length >= 1)
  const full = walkAlongEdges(pointy, start, cursor)
  assert.deepEqual(tail, full.slice(1), '尾巴必须等于完整行走去掉起点')
  // 尾巴的最后一段终点应当是光标吸附到的顶点
  assert.equal(vertexKey(pointy, tail[tail.length - 1]!), vertexKey(pointy, snapToHexVertex(pointy, cursor).point))
})

test('逐边：每次只前进一条边，方向由目标位置决定', () => {
  const start = hexCorners(pointy, 0, 0)[0]!
  const options = vertexNeighbors(pointy, start)
  assert.equal(options.length, 3)

  // 朝着某个候选方向点 → 就走到那个候选
  for (const option of options) {
    const beyond = { x: option.point.x * 2 - start.x, y: option.point.y * 2 - start.y }
    const step = stepAlongEdges(pointy, start, beyond)
    assert.equal(step.key, option.key, `朝 ${JSON.stringify(option.point)} 点，却走到了别处`)
    assert.ok(Math.abs(distance(start, step.point) - pointy.size) < 1e-6, '每次必须正好走一条边')
  }

  // 远处目标也只走一条边（不会一次跨过去）
  const far = { x: 2000, y: 1500 }
  const oneStep = stepAlongEdges(pointy, start, far)
  assert.ok(Math.abs(distance(start, oneStep.point) - pointy.size) < 1e-6, '远处目标仍只前进一条边')

  // 连续走：每次都从新端点再走一条边，且不会原地打转
  let current = start
  const visited = new Set([vertexKey(pointy, start)])
  for (let i = 0; i < 5; i += 1) {
    current = stepAlongEdges(pointy, current, far).point
    visited.add(vertexKey(pointy, current))
  }
  assert.ok(visited.size >= 5, `连续逐边应当持续前进，实际只经过 ${visited.size} 个顶点`)
})

test('逐边：点在端点上（方向退化）时结果确定，并优先沿上一步方向继续', () => {
  const start = hexCorners(pointy, 0, 0)[0]!
  const first = stepAlongEdges(pointy, start, { x: start.x, y: start.y })
  const again = stepAlongEdges(pointy, start, { x: start.x + 0.4, y: start.y - 0.4 })
  assert.equal(first.key, again.key, '退化输入必须给出确定的结果（可复现）')
  assert.ok(Math.abs(distance(start, first.point) - pointy.size) < 1e-6)

  // 给了上一步方向：应当继续朝那个方向走，而不是随便挑一个
  const previous = { x: first.point.x - start.x, y: first.point.y - start.y }
  const continued = stepAlongEdges(pointy, first.point, { x: first.point.x, y: first.point.y }, previous)
  const continuedDirection = { x: continued.point.x - first.point.x, y: continued.point.y - first.point.y }
  const dot =
    (previous.x * continuedDirection.x + previous.y * continuedDirection.y) /
    (Math.hypot(previous.x, previous.y) * Math.hypot(continuedDirection.x, continuedDirection.y))
  assert.ok(dot > 0, `应当继续往前走（点积 ${dot.toFixed(3)}），而不是掉头`)
})

test('退化输入不抛异常', () => {
  assert.deepEqual(toEdgePath(pointy, [], false), [])
  const single = toEdgePath(pointy, [{ x: 10, y: 10 }], true)
  assert.equal(single.length, 1)
  assert.deepEqual(walkTailToCursor(pointy, hexCorners(pointy, 0, 0)[0]!, hexCorners(pointy, 1, 0)[0]!), walkAlongEdges(pointy, hexCorners(pointy, 0, 0)[0]!, hexCorners(pointy, 1, 0)[0]!).slice(1))
})
