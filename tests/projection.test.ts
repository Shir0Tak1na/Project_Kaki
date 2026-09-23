/**
 * 投影模块的单元测试。
 * 回归依据：Phase 0 在 Obsidian 1.13.7 上实测得到的一组真实对应点（见 docs/PHASE-0-RESULTS.md）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calibrateOrigin,
  clientToWorld,
  estimateQuantum,
  isProjection,
  projectionEquals,
  projectionFrom,
  projectionFromPair,
  projectionWorldBBox,
  quantumNoiseBound,
  worldToClient,
  type ClientProjection,
  type Point,
} from '../src/core/projection.ts'

/** 由实测数据反推出来的真实投影：原点 (644.0, 366.9)，scale = 0.44669732651951655 */
const REAL_SCALE = 0.44669732651951655
const REAL_ANCHOR_CLIENT = { x: 719.5, y: 446.9 }
const REAL_ANCHOR_WORLD = { x: 169.31, y: 179.05 }

const real: ClientProjection = projectionFrom(REAL_ANCHOR_CLIENT, REAL_ANCHOR_WORLD, REAL_SCALE)

/** Phase 0 报告里 posFromEvt 的实测输出 */
const MEASURED: Array<{ client: { x: number; y: number }; world: { x: number; y: number } }> = [
  { client: { x: 719.5, y: 446.9 }, world: { x: 169.31, y: 179.05 } },
  { client: { x: 795.6, y: 527.8 }, world: { x: 339.45, y: 360.38 } },
  { client: { x: 871.7, y: 446.9 }, world: { x: 509.58, y: 179.05 } },
  { client: { x: 719.5, y: 608.7 }, world: { x: 169.31, y: 541.71 } },
  { client: { x: 886.9, y: 624.9 }, world: { x: 543.16, y: 577.53 } },
]

/**
 * 容差说明：这里用的 MEASURED 是从报告中手工抄下来的值，而报告当时只保留
 * 1 位小数的客户端坐标与 2 位小数的世界坐标；用这些值反推隐含原点，样本间散布达 0.4 px，
 * 换算到世界尺度最大残差 0.45。这是**测试输入的精度限制**，不是模型误差 ——
 * 插件内部用全精度计算残差，真实残差由诊断报告的「锚点投影最大偏差」给出（应为 0.0000）。
 * 0.45 世界单位对 40 单位见方的六边形格无任何可见影响。
 */
const TOLERANCE = 1.0

test('锚点投影能复现实测的 posFromEvt 结果', () => {
  for (const sample of MEASURED) {
    const world = clientToWorld(real, sample.client)
    assert.ok(
      Math.abs(world.x - sample.world.x) < TOLERANCE && Math.abs(world.y - sample.world.y) < TOLERANCE,
      `client (${sample.client.x},${sample.client.y}) → (${world.x.toFixed(2)},${world.y.toFixed(2)})，实测 (${sample.world.x},${sample.world.y})`,
    )
  }
})

test('五个实测点反推出的客户端原点恒定 —— 这证明变换是纯相似变换（Phase 0 的核心发现）', () => {
  // 若模型只是「平移 + 等比缩放」，那么每一点的 origin = client - world * scale 必须相同。
  // 首轮报告因此暴露出旧实现的问题：它用的基线（变换后包围盒）恰好偏离真实原点整整一段矩阵平移。
  const origins = MEASURED.map((sample) => ({
    x: sample.client.x - sample.world.x * REAL_SCALE,
    y: sample.client.y - sample.world.y * REAL_SCALE,
  }))
  const xs = origins.map((o) => o.x)
  const ys = origins.map((o) => o.y)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  assert.ok(spreadX < 0.5, `x 方向原点散布 ${spreadX.toFixed(3)} px`)
  assert.ok(spreadY < 0.5, `y 方向原点散布 ${spreadY.toFixed(3)} px`)
  // 报告中的数值与 Phase 0 实测原点 (644.0, 366.9) 一致
  assert.ok(Math.abs(xs[0]! - 644.0) < 1, `原点 x = ${xs[0]!.toFixed(3)}`)
  assert.ok(Math.abs(ys[0]! - 366.9) < 1, `原点 y = ${ys[0]!.toFixed(3)}`)
})

test('反解投影在精确输入下完全正确', () => {
  // 用精确值（而非报告中 1 位小数的坐标）验证反解算法本身
  const a = { client: { x: 100, y: 200 }, world: { x: 10, y: 20 } }
  const b = { client: { x: 100 + 300 * REAL_SCALE, y: 200 + 500 * REAL_SCALE }, world: { x: 310, y: 520 } }
  const derived = projectionFromPair(a, b)
  assert.ok(derived !== null)
  assert.ok(Math.abs(derived.scale - REAL_SCALE) < 1e-9, `scale=${derived.scale}`)
  const back = clientToWorld(derived, b.client)
  assert.ok(Math.abs(back.x - b.world.x) < 1e-6 && Math.abs(back.y - b.world.y) < 1e-6)
})

test('两个实测点与相似变换假设相容（受报告精度限制，误差在 1% 内）', () => {
  const derived = projectionFromPair(MEASURED[0]!, MEASURED[3]!)
  assert.ok(derived !== null)
  const relativeError = Math.abs(derived.scale - REAL_SCALE) / REAL_SCALE
  assert.ok(relativeError < 0.01, `反解缩放相对误差 ${(relativeError * 100).toFixed(3)}%`)
})

test('旧的中心公式在同一组数据上会给出恒定平移误差（回归证据）', () => {
  // 复现原实现的错误基线：用「变换后」包围盒的左上角当视口原点。
  // 实测中该基线比真实原点偏了整段矩阵平移分量 (299.375, 287.988)，
  // 因此误差在像素尺度恒为 ~(298.9, 287.1)，换算到世界尺度约 669/643。
  const wrongOrigin = { x: 943.87, y: 654.02 }
  const viewportCenter = { x: 340.5, y: 362 }
  const errors = MEASURED.map((sample) => {
    const worldWrong = {
      x: (sample.client.x - wrongOrigin.x) / REAL_SCALE + (viewportCenter.x - viewportCenter.x),
      y: (sample.client.y - wrongOrigin.y) / REAL_SCALE,
    }
    return { dx: sample.world.x - worldWrong.x, dy: sample.world.y - worldWrong.y }
  })
  const first = errors[0]!
  for (const error of errors) {
    assert.ok(Math.abs(error.dx - first.dx) < 1, '误差应当是恒定的平移')
    assert.ok(Math.abs(error.dy - first.dy) < 1, '误差应当是恒定的平移')
  }
  assert.ok(Math.abs(first.dx) > 600, `水平平移误差应约 669，实测 ${first.dx.toFixed(1)}`)
  assert.ok(Math.abs(first.dy) > 600, `垂直平移误差应约 643，实测 ${first.dy.toFixed(1)}`)
})

test('两种转换互为逆运算', () => {
  const points = [
    { x: 0, y: 0 },
    { x: -1234.5, y: 987.6 },
    { x: 92.0655868911183, y: 165.68669641861686 },
  ]
  for (const p of points) {
    const back = clientToWorld(real, worldToClient(real, p))
    assert.ok(Math.abs(back.x - p.x) < 1e-6 && Math.abs(back.y - p.y) < 1e-6)
  }
})

test('锚点自身映射为自身', () => {
  const client = worldToClient(real, real.anchorWorld)
  assert.ok(Math.abs(client.x - real.anchorClient.x) < 1e-9)
  assert.ok(Math.abs(client.y - real.anchorClient.y) < 1e-9)
})

test('缩放比例直接决定像素与世界单位的换算', () => {
  const a = worldToClient(real, { x: 0, y: 0 })
  const b = worldToClient(real, { x: 100, y: 0 })
  assert.ok(Math.abs(b.x - a.x - 100 * REAL_SCALE) < 1e-9)
})

test('可视世界范围与视口矩形尺寸成反比', () => {
  const rect = { left: 344.6, top: 78.9, width: 681, height: 724 }
  const bbox = projectionWorldBBox(real, rect)
  assert.ok(Math.abs(bbox.maxX - bbox.minX - rect.width / REAL_SCALE) < 1e-6)
  assert.ok(Math.abs(bbox.maxY - bbox.minY - rect.height / REAL_SCALE) < 1e-6)
})

test('视口去重比较只看锚点与缩放', () => {
  const same = projectionFrom(REAL_ANCHOR_CLIENT, REAL_ANCHOR_WORLD, REAL_SCALE)
  assert.equal(projectionEquals(real, same), true)
  assert.equal(projectionEquals(real, projectionFrom(REAL_ANCHOR_CLIENT, REAL_ANCHOR_WORLD, REAL_SCALE * 2)), false)
  assert.equal(
    projectionEquals(real, projectionFrom({ x: 0, y: 0 }, REAL_ANCHOR_WORLD, REAL_SCALE)),
    false,
  )
})

test('反解投影在两点重合或非相似变换时返回 null', () => {
  const p = { client: { x: 10, y: 10 }, world: { x: 0, y: 0 } }
  assert.equal(projectionFromPair(p, { client: { x: 10, y: 10 }, world: { x: 0, y: 0 } }), null)
  // 水平与垂直方向反解出的缩放差异过大 → 有旋转或斜切，不接受
  assert.equal(
    projectionFromPair(p, { client: { x: 20, y: 40 }, world: { x: 10, y: 10 } }),
    null,
  )
})

test('形状守卫拒绝不可用的投影', () => {
  assert.equal(isProjection(real), true)
  assert.equal(isProjection({ ...real, scale: 0 }), false)
  assert.equal(isProjection({ ...real, scale: Number.NaN }), false)
  assert.equal(isProjection({ anchorClient: { x: 0, y: 0 }, anchorWorld: { x: 0, y: 0 } }), false)
  assert.equal(isProjection(null), false)
})

// ---------------------------------------------------------------- 量化与校准
// 依据：Phase 0 第二轮实测（见 docs/PHASE-0-RESULTS.md §2.5）发现 posFromEvt 的输出
// 被量化到设备像素，散布达 0.34–0.75 px；而变换矩阵与 scale 字段是精确值。

/** 模拟 posFromEvt：精确仿射 + 量化到 quantumPx（客户端像素） */
function quantizedProbe(origin: Point, scale: number, quantumPx: number) {
  return (client: Point): Point => {
    const world = { x: (client.x - origin.x) / scale, y: (client.y - origin.y) / scale }
    // 量化发生在客户端像素上：把世界坐标吸附回设备像素网格
    const quantumWorld = quantumPx / scale
    return {
      x: Math.round(world.x / quantumWorld) * quantumWorld,
      y: Math.round(world.y / quantumWorld) * quantumWorld,
    }
  }
}

test('单点锚点会带上量化误差，多点校准误差有界且方差更小', () => {
  const origin = { x: 647.5, y: 369.4 }
  const quantumPx = 0.6667 // devicePixelRatio = 1.5
  const probe = quantizedProbe(origin, REAL_SCALE, quantumPx)

  // 用确定性伪随机序列生成采样点：固定网格的量化误差可能系统性偏向一侧，
  // 那样测出来的"平均误差"不具代表性（见下方第二个断言）。
  let seed = 20260923
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const randomGrid = (n: number) =>
    Array.from({ length: n }, () => {
      const client = { x: 360 + rand() * 600, y: 90 + rand() * 640 }
      return { client, world: probe(client) }
    })

  // 断言 1（确定性保证）：任意多点校准的误差上界都是半个量子
  const fixed: Array<{ client: { x: number; y: number }; world: { x: number; y: number } }> = []
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const client = { x: 360 + i * 150, y: 100 + j * 140 }
      fixed.push({ client, world: probe(client) })
    }
  }
  const fixedCalibration = calibrateOrigin(fixed, REAL_SCALE)
  assert.ok(fixedCalibration !== null)
  const fixedError = Math.hypot(fixedCalibration.origin.x - origin.x, fixedCalibration.origin.y - origin.y)
  assert.ok(fixedError <= quantumPx / 2 + 1e-6, `校准误差 ${fixedError.toFixed(4)} 应不超过半个量子`)
  assert.ok(fixedCalibration.spread < quantumPx, `散布应在一个量子内，实测 ${fixedCalibration.spread.toFixed(4)}`)

  // 断言 2（统计性质）：多次随机试验下，采样点越多误差越小
  const trials = 120
  let errorOne = 0
  let errorMany = 0
  for (let t = 0; t < trials; t++) {
    const single = calibrateOrigin(randomGrid(1), REAL_SCALE)
    const many = calibrateOrigin(randomGrid(25), REAL_SCALE)
    assert.ok(single !== null && many !== null)
    errorOne += Math.hypot(single.origin.x - origin.x, single.origin.y - origin.y)
    errorMany += Math.hypot(many.origin.x - origin.x, many.origin.y - origin.y)
  }
  const avgOne = errorOne / trials
  const avgMany = errorMany / trials
  assert.ok(
    avgMany < avgOne / 2,
    `25 点校准的平均误差 ${avgMany.toFixed(4)} 应显著优于单点 ${avgOne.toFixed(4)}（至少好一倍）`,
  )
})

test('校准结果应报告与独立来源的差异', () => {
  const origin = { x: 100, y: 200 }
  const probe = quantizedProbe(origin, REAL_SCALE, 0.5)
  const samples = [
    { client: { x: 300, y: 400 }, world: probe({ x: 300, y: 400 }) },
    { client: { x: 700, y: 800 }, world: probe({ x: 700, y: 800 }) },
    { client: { x: 500, y: 600 }, world: probe({ x: 500, y: 600 }) },
  ]
  const calibration = calibrateOrigin(samples, REAL_SCALE, { x: 100.4, y: 199.7 })
  assert.ok(calibration !== null)
  assert.ok(calibration.agreementDelta !== null)
  assert.ok(Math.abs(calibration.agreementDelta - Math.hypot(0.4, 0.3)) < 0.05, `agreementDelta=${calibration.agreementDelta}`)
})

test('校准拒绝非法输入', () => {
  assert.equal(calibrateOrigin([], REAL_SCALE), null)
  assert.equal(calibrateOrigin([{ client: { x: 0, y: 0 }, world: { x: 0, y: 0 } }], 0), null)
  assert.equal(calibrateOrigin([{ client: { x: 0, y: 0 }, world: { x: 0, y: 0 } }], -1), null)
})

test('采样步长细于量子时可解析出真实量子', () => {
  const origin = { x: 647.5, y: 369.4 }
  const quantumPx = 0.6667
  const probe = quantizedProbe(origin, REAL_SCALE, quantumPx)

  // 步长 0.25 px < 量子 0.6667 px —— 一个量子内会有多个采样点，因此必然出现重复值
  const samples: Array<{ client: number; world: number }> = []
  for (let i = 0; i < 240; i++) {
    const clientX = 360 + i * 0.25
    samples.push({ client: clientX, world: probe({ x: clientX, y: 400 }).x })
  }

  const estimate = estimateQuantum(samples, REAL_SCALE)
  assert.equal(estimate.resolved, true, estimate.note)
  assert.ok(estimate.quantumClientPx !== null)
  assert.ok(
    Math.abs(estimate.quantumClientPx - quantumPx) < 0.01,
    `估计量子 ${estimate.quantumClientPx?.toFixed(4)} px，实际 ${quantumPx}`,
  )
  assert.ok(estimate.duplicateCount > 0, '细采样应出现重复值')
})

test('采样步长粗于量子时必须自报未解析（否则会高估量子）', () => {
  const origin = { x: 647.5, y: 369.4 }
  const probe = quantizedProbe(origin, REAL_SCALE, 0.6667)

  const samples: Array<{ client: number; world: number }> = []
  for (let i = 0; i < 60; i++) {
    const clientX = 360 + i * 3 // 3 px >> 0.6667 px
    samples.push({ client: clientX, world: probe({ x: clientX, y: 400 }).x })
  }

  const estimate = estimateQuantum(samples, REAL_SCALE)
  assert.equal(estimate.resolved, false)
  assert.equal(estimate.duplicateCount, 0)
  assert.ok(estimate.note.includes('采样步长粗于量子'))
  // 未解析时给出的值只是上界，绝不能当成真实量子使用
  assert.ok(estimate.quantumClientPx !== null && estimate.quantumClientPx > 0.6667)
})

test('无量化时量子估计退化为采样步长且不出现重复', () => {
  const samples: Array<{ client: number; world: number }> = []
  for (let i = 0; i < 20; i++) {
    const clientX = 100 + i * 0.25
    samples.push({ client: clientX, world: (clientX - 647.5) / REAL_SCALE })
  }
  const estimate = estimateQuantum(samples, REAL_SCALE)
  assert.equal(estimate.duplicateCount, 0)
  assert.equal(estimate.resolved, false)
  assert.ok(estimate.quantumClientPx !== null && Math.abs(estimate.quantumClientPx - 0.25) < 1e-6)
})

test('量子估计拒绝样本不足的输入', () => {
  const estimate = estimateQuantum([{ client: 0, world: 0 }], REAL_SCALE)
  assert.equal(estimate.quantumWorld, null)
  assert.equal(estimate.quantumClientPx, null)
})

test('量化噪声上界为每轴半个量子的二维合成', () => {
  // 实测：量子 = 1 CSS px。每轴最多差半个量子，二维合成 = q·√2/2
  assert.ok(Math.abs(quantumNoiseBound(1) - Math.SQRT2 / 2) < 1e-12)
  assert.ok(Math.abs(quantumNoiseBound(3.165932) - 3.165932 * Math.SQRT2 / 2) < 1e-12)
  assert.equal(quantumNoiseBound(0), 0)
  // 该量用于判定"两个来源是否一致"：0.63 px 的差异在 1 px 量子下不应被判为异常
  const boundPx = quantumNoiseBound(1)
  assert.ok(0.634 < boundPx, '0.634 px 应落在上界之内（实测中确实如此）')
})
