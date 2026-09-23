/**
 * 客户端坐标 ↔ 世界坐标的投影 —— 纯函数模块。
 *
 * 为什么不是「中心 + 缩放」公式：Obsidian 的 `.canvas` 是视口大小的盒子，
 * 其内容被 `transform: translate(...) scale(...)` 变换，而 transform-origin、
 * 元素未变换盒模型的位置都属于内部实现。实测（Phase 0，Obsidian 1.13.7）表明：
 * 用 `canvasEl.getBoundingClientRect()` 作为基线会引入一个恒定的平移误差
 * （等于矩阵平移分量），形态正确但原点错位。
 *
 * 因此这里改用**锚点 + 缩放**表达投影：
 *
 *   client = anchorClient + (world - anchorWorld) * scale
 *   world  = anchorWorld + (client - anchorClient) / scale
 *
 * 锚点由 Obsidian 自己的 posFromClient/posFromEvt 给出（权威），缩放由变换矩阵
 * 的 a 分量给出。不需要推导原点，因此对 transform-origin 等内部细节免疫。
 */

export interface Point {
  x: number
  y: number
}

export interface ClientProjection {
  /** 已知的客户端坐标锚点 */
  anchorClient: Point
  /** 该锚点对应的世界坐标 */
  anchorWorld: Point
  /** 线性缩放（世界单位 → CSS 像素） */
  scale: number
}

export function projectionFrom(anchorClient: Point, anchorWorld: Point, scale: number): ClientProjection {
  return { anchorClient: { ...anchorClient }, anchorWorld: { ...anchorWorld }, scale }
}

export function isProjection(value: unknown): value is ClientProjection {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const client = v.anchorClient as Record<string, unknown> | undefined
  const world = v.anchorWorld as Record<string, unknown> | undefined
  const scale = v.scale
  return (
    typeof scale === 'number' &&
    Number.isFinite(scale) &&
    scale > 0 &&
    client !== undefined &&
    world !== undefined &&
    typeof client.x === 'number' &&
    typeof client.y === 'number' &&
    typeof world.x === 'number' &&
    typeof world.y === 'number' &&
    Number.isFinite(client.x) &&
    Number.isFinite(client.y) &&
    Number.isFinite(world.x) &&
    Number.isFinite(world.y)
  )
}

/** 世界坐标 → 客户端坐标 */
export function worldToClient(projection: ClientProjection, world: Point): Point {
  const s = projection.scale
  return {
    x: projection.anchorClient.x + (world.x - projection.anchorWorld.x) * s,
    y: projection.anchorClient.y + (world.y - projection.anchorWorld.y) * s,
  }
}

/** 客户端坐标 → 世界坐标 */
export function clientToWorld(projection: ClientProjection, client: Point): Point {
  const s = projection.scale
  return {
    x: projection.anchorWorld.x + (client.x - projection.anchorClient.x) / s,
    y: projection.anchorWorld.y + (client.y - projection.anchorClient.y) / s,
  }
}

/**
 * 由两个已知对应点反解投影（用于诊断与自检）：
 * 两个点都必须给出 client 与 world 坐标，且两点不重合。
 */
export function projectionFromPair(
  a: { client: Point; world: Point },
  b: { client: Point; world: Point },
): ClientProjection | null {
  const dWorldX = b.world.x - a.world.x
  const dWorldY = b.world.y - a.world.y
  const dClientX = b.client.x - a.client.x
  const dClientY = b.client.y - a.client.y

  // 优先用水平方向反解缩放（对垂直抖动更稳健），退化时用垂直方向
  let scale = 0
  if (Math.abs(dWorldX) > 1e-9) scale = dClientX / dWorldX
  else if (Math.abs(dWorldY) > 1e-9) scale = dClientY / dWorldY
  else return null

  if (!Number.isFinite(scale) || scale <= 0) return null

  // 用两个方向的一致性做一次校验；差异过大说明不是纯相似变换（有旋转/斜切）
  if (Math.abs(dWorldX) > 1e-9 && Math.abs(dWorldY) > 1e-9) {
    const scaleFromY = dClientY / dWorldY
    if (Math.abs(scaleFromY - scale) > Math.max(1e-3, Math.abs(scale) * 1e-3)) return null
  }

  return projectionFrom(a.client, a.world, scale)
}

/** 视口的可见世界范围；视口矩形由未变换的容器元素给出 */
export function projectionWorldBBox(
  projection: ClientProjection,
  viewportRect: { left: number; top: number; width: number; height: number },
): { minX: number; minY: number; maxX: number; maxY: number } {
  const topLeft = clientToWorld(projection, { x: viewportRect.left, y: viewportRect.top })
  const bottomRight = clientToWorld(projection, {
    x: viewportRect.left + viewportRect.width,
    y: viewportRect.top + viewportRect.height,
  })
  return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y }
}

/** 投影是否等价（用于视口去重：锚点变化但世界坐标没变时应视为同一视口） */
export function projectionEquals(a: ClientProjection, b: ClientProjection, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.scale - b.scale) < epsilon &&
    Math.abs(a.anchorClient.x - b.anchorClient.x) < epsilon &&
    Math.abs(a.anchorClient.y - b.anchorClient.y) < epsilon &&
    Math.abs(a.anchorWorld.x - b.anchorWorld.x) < epsilon &&
    Math.abs(a.anchorWorld.y - b.anchorWorld.y) < epsilon
  )
}

// ---------------------------------------------------------------- 原点校准

export interface OriginCalibration {
  /** 稳健估计出的原点（客户端坐标，对应世界原点） */
  origin: Point
  /** 各样本隐含原点到中位数的最大距离（px），反映量化噪声量级 */
  spread: number
  sampleCount: number
  /** 与另一个独立来源（如闭式推导）的原点差异（px），可选 */
  agreementDelta: number | null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return Number.NaN
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * 由多组 (client, world) 采样校准原点。
 *
 * 为什么必须多采样：Phase 0 实测发现 `posFromEvt` 的输出被量化到设备像素
 * （见 docs/PHASE-0-RESULTS.md §2.5），单点锚点会带上最多半个量子的误差。
 * 取**中位数**而非均值，是为了对个别异常样本保持稳健。
 *
 * 缩放必须由调用方传入精确值（变换矩阵的 a 分量或 `scale` 字段），
 * 不要从采样点反解 —— 量化噪声会让反解出的缩放产生 ±1.5% 的散布。
 */
export function calibrateOrigin(
  samples: Array<{ client: Point; world: Point }>,
  scale: number,
  reference?: Point,
): OriginCalibration | null {
  if (!(scale > 0) || samples.length === 0) return null

  const origins = samples.map((s) => ({
    x: s.client.x - s.world.x * scale,
    y: s.client.y - s.world.y * scale,
  }))

  const origin = { x: median(origins.map((o) => o.x)), y: median(origins.map((o) => o.y)) }
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null

  const spread = origins.reduce((acc, o) => Math.max(acc, Math.hypot(o.x - origin.x, o.y - origin.y)), 0)
  const agreementDelta = reference ? Math.hypot(reference.x - origin.x, reference.y - origin.y) : null

  return { origin, spread, sampleCount: samples.length, agreementDelta }
}

export interface QuantumEstimate {
  /** 世界单位的最小可分辨步长 */
  quantumWorld: number | null
  /** 换算成客户端像素的步长 */
  quantumClientPx: number | null
  /** 出现过的不同步长个数 */
  distinctStepCount: number
  sampleCount: number
  /** 完全重复的相邻样本数（步长为 0） */
  duplicateCount: number
  /**
   * 是否真的解析出了量子。
   * ⚠️ 只有当**采样步长小于量子**时，相邻样本的世界坐标差才等于量子。
   * 否则观察到的最小步长只是量子的整数倍（会高估），此时 resolved 为 false。
   * 判据：一个量子内至少要有多个采样点，因此必须出现重复值。
   */
  resolved: boolean
  note: string
}

/**
 * 估计坐标输出的量化步长。
 *
 * 做法：沿一条直线密集采样，观察相邻样本的世界坐标差。
 * 若输出被量化，差值只会是量子（或其整数倍），最小正差值即量子。
 * 这是判断「矩阵精确、posFromEvt 有噪声」还是「两者都精确」的关键证据。
 *
 * ⚠️ 调用方必须让采样步长**小于**量子，否则结果只是量子的整数倍（resolved=false）。
 */
export function estimateQuantum(samples: Array<{ client: number; world: number }>, scale: number): QuantumEstimate {
  const base: QuantumEstimate = {
    quantumWorld: null,
    quantumClientPx: null,
    distinctStepCount: 0,
    sampleCount: samples.length,
    duplicateCount: 0,
    resolved: false,
    note: '样本不足',
  }
  if (samples.length < 2) return base

  const ordered = [...samples].sort((a, b) => a.client - b.client)
  const steps: number[] = []
  let duplicateCount = 0

  for (let i = 1; i < ordered.length; i++) {
    const delta = Math.abs(ordered[i]!.world - ordered[i - 1]!.world)
    if (delta < 1e-9) duplicateCount += 1
    else steps.push(delta)
  }

  if (steps.length === 0) {
    return { ...base, duplicateCount, note: '所有样本的世界坐标完全相同（视口未变化？）' }
  }

  const sortedSteps = [...steps].sort((a, b) => a - b)
  const quantumWorld = sortedSteps[0]!
  const distinct = new Set(sortedSteps.map((s) => Math.round(s / quantumWorld)))
  const resolved = duplicateCount > 0

  return {
    quantumWorld,
    quantumClientPx: quantumWorld * scale,
    distinctStepCount: distinct.size,
    sampleCount: samples.length,
    duplicateCount,
    resolved,
    note: resolved
      ? '采样步长小于量子，已解析出真实量子'
      : '⚠️ 采样步长粗于量子：观察到的最小步长是量子的整数倍，结果只能作为上界',
  }
}

/**
 * 量化噪声在二维上的上界。
 *
 * 每个轴最多差半个量子，二维合成为 `quantum * √2 / 2 ≈ 0.707 * quantum`。
 * 任何"两个来源是否一致"的判定都必须与这个上界比较，而不是与固定常量比较 ——
 * 实测中曾把 0.8 px 的差异误判为"关系不成立"，而它与量化噪声同量级。
 */
export function quantumNoiseBound(quantumWorld: number): number {
  return (quantumWorld * Math.SQRT2) / 2
}
