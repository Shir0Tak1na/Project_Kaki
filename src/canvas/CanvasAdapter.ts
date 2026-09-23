/**
 * CanvasAdapter —— **唯一**允许触碰 Obsidian 内部 Canvas 对象的模块。
 *
 * 上层代码（渲染、交互、工具）不得出现 canvas.tZoom / canvas.markViewportChanged
 * 之类的字样；一切私有访问都经过这里，并且每次取用前都做形状守卫。
 * 这些字段全部来自社区逆向类型包，非契约（见设计文档 §1.1 与 §11 待验证清单）。
 *
 * 设计原则：探测失败一律返回 null / 空数组并让调用方降级，绝不抛异常。
 *
 * 坐标转换见 core/projection.ts：**不推导原点**，用「权威锚点 + 缩放」表达投影。
 * Phase 0 实测（Obsidian 1.13.7）证明推导原点会引入恒定平移误差。
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian'
import {
  calibrateOrigin,
  clientToWorld,
  estimateQuantum,
  isProjection,
  projectionFrom,
  worldToClient,
  type ClientProjection,
  type OriginCalibration,
  type Point,
  type QuantumEstimate,
} from '../core/projection.ts'
import { isViewport, type Viewport } from '../core/viewport.ts'
import { around, type Uninstaller } from '../util/patch.ts'

/** Obsidian 内部 Canvas 对象的最小形状描述：全部可选，取用前必须守卫 */
export interface CanvasLike {
  // 变换
  tx?: unknown
  ty?: unknown
  tZoom?: unknown
  /** ⚠️ 实测（1.13.7）该字段是 tZoom 的别名，不是线性比例 */
  zoom?: unknown
  /** 线性缩放比例（世界单位 → CSS 像素） */
  scale?: unknown
  // DOM
  wrapperEl?: unknown
  canvasEl?: unknown
  moverEl?: unknown
  canvasRect?: unknown
  backgroundPatternEl?: unknown
  edgeContainerEl?: unknown
  // 数据
  data?: unknown
  nodes?: unknown
  edges?: unknown
  // 方法与生命周期
  markViewportChanged?: unknown
  requestFrame?: unknown
  requestSave?: unknown
  markDirty?: unknown
  getViewportBBox?: unknown
  getViewportNodes?: unknown
  posFromEvt?: unknown
  posFromClient?: unknown
  setViewport?: unknown
  zoomToBbox?: unknown
  zoomToFit?: unknown
  deselectAll?: unknown
}

export interface CanvasViewLike {
  getViewType?(): string
  canvas?: CanvasLike
  file?: TFile | null
  containerEl?: unknown
}

export interface CanvasHandle {
  leaf: WorkspaceLeaf
  view: CanvasViewLike
  canvas: CanvasLike
  file: TFile | null
  isActive: boolean
}

export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/** CSS transform 的二维仿射矩阵（matrix 或 matrix3d 归一到此） */
export interface Matrix2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

// ---------------------------------------------------------------- 基础守卫

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asElement(value: unknown): HTMLElement | null {
  const rec = asRecord(value)
  if (!rec) return null
  // 不用 instanceof：弹出窗口（popout）里的元素来自另一个 document
  return typeof rec.getBoundingClientRect === 'function' ? (value as HTMLElement) : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asFn(value: unknown): ((...args: never[]) => unknown) | null {
  return typeof value === 'function' ? (value as (...args: never[]) => unknown) : null
}

function classNameOf(el: Element): string {
  return typeof el.className === 'string' ? el.className : ''
}

/** 一次性读出私有数值字段，用于诊断（不参与正常渲染路径） */
export function probeFields(canvas: CanvasLike): Array<{ name: string; kind: string; scalar: string }> {
  const rec = asRecord(canvas)
  if (!rec) return []
  const names = [
    'tx', 'ty', 'tZoom', 'zoom', 'scale',
    'wrapperEl', 'canvasEl', 'moverEl', 'canvasRect', 'backgroundPatternEl', 'edgeContainerEl',
    'data', 'nodes', 'edges',
    'markViewportChanged', 'requestFrame', 'requestSave', 'markDirty',
    'getViewportBBox', 'getViewportNodes',
    'posFromEvt', 'posFromClient', 'setViewport', 'zoomToBbox', 'zoomToFit', 'deselectAll',
  ]
  return names.map((name) => {
    const value: unknown = rec[name]
    const kind = typeof value
    let scalar = ''
    if (typeof value === 'number') {
      scalar = String(value)
    } else if (typeof value === 'function') {
      scalar = `arity=${value.length}`
    } else if (value === null) {
      scalar = 'null'
    } else if (typeof value === 'object') {
      // 只报集合规模或构造器名，绝不序列化活对象
      const obj = value as Record<string, unknown>
      if (typeof obj.size === 'number') scalar = `size=${obj.size}`
      else if (Array.isArray(value)) scalar = `length=${value.length}`
      else if (typeof obj.getBoundingClientRect === 'function') scalar = 'HTMLElement'
      else scalar = `ctor=${(value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}`
    }
    return { name, kind, scalar }
  })
}

// ---------------------------------------------------------------- 视图发现

function isDeferredLeaf(leaf: WorkspaceLeaf): boolean {
  // leaf.isDeferred 自 1.7.2 起存在；旧版本没有该字段，此时不能当作 deferred
  const rec = asRecord(leaf)
  return rec?.isDeferred === true
}

function leafContainerContainsFocus(leaf: WorkspaceLeaf): boolean {
  const el = asElement(asRecord(leaf.view)?.containerEl)
  if (!el) return false
  const active = el.doc?.activeElement ?? document.activeElement
  return active !== null && active !== undefined && el.contains(active)
}

export function findCanvasHandles(app: App): {
  handles: CanvasHandle[]
  deferredLeaves: WorkspaceLeaf[]
  totalLeaves: number
} {
  const leaves = app.workspace.getLeavesOfType('canvas')
  const handles: CanvasHandle[] = []
  const deferredLeaves: WorkspaceLeaf[] = []

  const workspace = app.workspace as unknown as Record<string, unknown>
  let activeView: unknown = null
  if (typeof workspace.getMostRecentLeaf === 'function') {
    const mostRecent = (workspace.getMostRecentLeaf as () => { view?: unknown } | null).call(app.workspace)
    activeView = mostRecent?.view ?? null
  }
  if (activeView === null) {
    // 退路：activeLeaf 已标记 deprecated，但在 Canvas 缺少公开视图类型时仍是最直接的信号
    const activeLeaf = asRecord(workspace.activeLeaf)
    activeView = activeLeaf?.view ?? null
  }

  for (const leaf of leaves) {
    if (isDeferredLeaf(leaf)) {
      deferredLeaves.push(leaf)
      continue
    }
    const view = leaf.view as unknown as CanvasViewLike
    const canvas = view?.canvas
    if (!asRecord(canvas)) {
      // 未加载完成或不是预期的 Canvas 视图：不计入可用句柄
      deferredLeaves.push(leaf)
      continue
    }
    handles.push({
      leaf,
      view,
      canvas: canvas as CanvasLike,
      file: view.file ?? null,
      isActive: activeView === (leaf.view as unknown) || leafContainerContainsFocus(leaf),
    })
  }

  return { handles, deferredLeaves, totalLeaves: leaves.length }
}

/** 取「当前要操作」的 Canvas：优先活动叶子，其次第一个已加载的 */
export function activeCanvasHandle(app: App): CanvasHandle | null {
  const { handles } = findCanvasHandles(app)
  if (handles.length === 0) return null
  return handles.find((h) => h.isActive) ?? handles[0] ?? null
}

// ---------------------------------------------------------------- 变换矩阵

/** 解析 computed transform 字符串；支持 matrix(...) 与 matrix3d(...) */
export function parseTransformMatrix(transform: string): Matrix2D | null {
  if (typeof transform !== 'string' || transform === 'none' || transform === '') return null
  const values = transform.match(/-?[\d.eE+]+/g)
  if (!values) return null
  const nums = values.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null

  if (transform.startsWith('matrix3d') && nums.length >= 16) {
    return { a: nums[0]!, b: nums[1]!, c: nums[4]!, d: nums[5]!, e: nums[12]!, f: nums[13]! }
  }
  if (transform.startsWith('matrix') && nums.length >= 6) {
    return { a: nums[0]!, b: nums[1]!, c: nums[2]!, d: nums[3]!, e: nums[4]!, f: nums[5]! }
  }
  return null
}

function computedTransform(el: Element): string {
  const view = el.ownerDocument?.defaultView ?? window
  try {
    return view.getComputedStyle(el).transform || 'none'
  } catch {
    return 'unreadable'
  }
}

// ---------------------------------------------------------------- 挂载点探测（P1）

export interface TransformCandidate {
  depth: number
  tag: string
  cls: string
  raw: string
  matrix: Matrix2D | null
  /** 元素本体：判定出的世界层就是覆盖层的挂载点 */
  el: Element | null
  /** 矩阵的缩放分量是否与当前视图缩放一致 —— 识别「世界层」的关键判据 */
  matchesScale: boolean
  /** 是否包含 .canvas-node 后代 —— 与缩放无关的结构判据 */
  containsNodes: boolean
  isWorldHost: boolean
  score: number
}

function containsCanvasNode(el: Element, maxDepth = 3): boolean {
  const walk = (node: Element, depth: number): boolean => {
    if (classNameOf(node).split(/\s+/).includes('canvas-node')) return true
    if (depth >= maxDepth) return false
    return Array.from(node.children).some((child) => walk(child, depth + 1))
  }
  return walk(el, 0)
}

/**
 * 探测 wrapper 子树里所有带 transform 的元素，并判定哪一个才是「世界层」。
 *
 * Phase 0 实测：wrapper 下同时存在 canvas-card-menu（平移矩阵，a=1）、
 * 各个 canvas-node（平移矩阵，a=1）和真正的世界层 div.canvas（a=当前 scale）。
 * 只看「有没有 transform」会误判，必须看**矩阵缩放分量是否等于当前 scale**。
 */
export function probeTransformCandidates(canvas: CanvasLike, scaleHint: number | null, maxDepth = 3): TransformCandidate[] {
  const root = asElement(canvas.wrapperEl) ?? asElement(canvas.canvasEl)
  if (!root) return []

  const out: TransformCandidate[] = []
  const walk = (el: Element, depth: number): void => {
    const raw = computedTransform(el)
    const matrix = parseTransformMatrix(raw)
    const cls = classNameOf(el)
    const tokens = cls.split(/\s+/).filter(Boolean)

    const matchesScale =
      matrix !== null &&
      scaleHint !== null &&
      Math.abs(matrix.a - scaleHint) <= Math.max(1e-3, Math.abs(scaleHint) * 1e-3) &&
      Math.abs(matrix.d - scaleHint) <= Math.max(1e-3, Math.abs(scaleHint) * 1e-3)

    const containsNodes = matrix !== null ? containsCanvasNode(el) : false

    // 打分：结构证据优先，其次是缩放匹配，最后才看类名
    let score = 0
    if (containsNodes) score += 8
    if (matchesScale) score += 4
    if (tokens.includes('canvas')) score += 2
    if (tokens.some((t) => t.startsWith('canvas-node') || t.startsWith('canvas-card-menu') || t.startsWith('canvas-control'))) {
      score -= 6
    }

    out.push({
      depth,
      tag: el.tagName.toLowerCase(),
      cls,
      raw,
      matrix,
      el,
      matchesScale,
      containsNodes,
      isWorldHost: false,
      score,
    })

    if (depth >= maxDepth) return
    for (const child of Array.from(el.children)) walk(child, depth + 1)
  }

  walk(root, 0)

  const best = out.reduce<TransformCandidate | null>((acc, cur) => {
    if (cur.matrix === null) return acc
    if (acc === null) return cur
    if (cur.score > acc.score) return cur
    if (cur.score === acc.score && cur.depth < acc.depth) return cur
    return acc
  }, null)

  if (best) best.isWorldHost = true
  return out
}

export function pickWorldHost(candidates: TransformCandidate[]): TransformCandidate | null {
  return candidates.find((c) => c.isWorldHost) ?? null
}

// ---------------------------------------------------------------- 视口读取

/** 视口矩形：优先未变换的 wrapper（其 transform 为 none，rect 可信） */
export function readViewportRect(canvas: CanvasLike): ScreenRect | null {
  const el = asElement(canvas.wrapperEl) ?? asElement(canvas.moverEl) ?? asElement(canvas.canvasEl)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export function readCanvasSize(canvas: CanvasLike): { width: number; height: number } | null {
  // canvasRect 是 Obsidian 自己维护的视口尺寸（未变换），实测与叶子内容尺寸一致
  const rect = asRecord(canvas.canvasRect)
  if (rect) {
    const width = asNumber(rect.width)
    const height = asNumber(rect.height)
    if (width !== null && height !== null && width > 0 && height > 0) return { width, height }
  }
  const el = asElement(canvas.moverEl) ?? asElement(canvas.canvasEl) ?? asElement(canvas.wrapperEl)
  if (el && el.clientWidth > 0 && el.clientHeight > 0) {
    return { width: el.clientWidth, height: el.clientHeight }
  }
  return null
}

/** 读取 tx/ty/tZoom 与视口尺寸；仅用于诊断展示与 bbox 计算，不用于坐标转换 */
export function readViewport(canvas: CanvasLike): Viewport | null {
  const tx = asNumber(canvas.tx)
  const ty = asNumber(canvas.ty)
  const tZoom = asNumber(canvas.tZoom)
  const size = readCanvasSize(canvas)
  if (tx === null || ty === null || tZoom === null || size === null) return null
  const viewport: Viewport = { tx, ty, tZoom, width: size.width, height: size.height }
  return isViewport(viewport) ? viewport : null
}

/** 线性缩放：优先 canvas.scale 字段，其次 2^tZoom。⚠️ 不要用 canvas.zoom（它是 tZoom 的别名） */
export function readScale(canvas: CanvasLike): { scale: number | null; source: string } {
  const direct = asNumber(canvas.scale)
  if (direct !== null && direct > 0) return { scale: direct, source: 'scale 字段' }
  const tZoom = asNumber(canvas.tZoom)
  if (tZoom !== null) return { scale: 2 ** tZoom, source: '2^tZoom' }
  return { scale: null, source: '不可用' }
}

// ---------------------------------------------------------------- 投影构建

export interface ProjectionResult {
  projection: ClientProjection | null
  /** 锚点来源：标定校准 / 单点 posFromEvt / 闭式推导（可带偏差修正） */
  anchorSource: 'closed-form' | 'posFromEvt' | 'posFromClient' | 'none'
  scale: number | null
  scaleSource: string
  viewportRect: ScreenRect | null
  host: TransformCandidate | null
  /** posFromClient 与 posFromEvt 的差异（px），用于验证两者语义是否一致 */
  crossCheckDelta: number | null
  /** 闭式推导出的原点（wrapperRect.topLeft + 矩阵平移），未含偏差修正 */
  derivedOrigin: Point | null
  /** 闭式原点（含偏差修正）与投影自身原点的差异（px） */
  derivedOriginDelta: number | null
  /** 多点标定结果；仅在 calibrate 模式下存在 */
  calibration: OriginCalibration | null
  /** 用**未参与标定**的留出样本验证出的最大残差（世界单位） */
  heldOutResidualWorld: number | null
  /** 量化探测结果；仅在 calibrate 模式下存在 */
  quantization: { x: QuantumEstimate; y: QuantumEstimate } | null
  notes: string[]
}

export interface ProjectionOptions {
  /**
   * 是否做完整标定（25 点网格 + 量化探测，约 450 次 posFromEvt 调用）。
   * 默认 false：运行时走廉价的闭式路径 + 偏差修正；诊断命令走完整标定。
   */
  calibrate?: boolean
}

/**
 * 最近一次标定测出的「闭式原点 − 真实原点」偏差（px），按 canvas 对象缓存。
 *
 * ⚠️ 仅供**报告与排查**使用，**不参与运行时换算**。
 * 实测：该偏差 0.63 px，落在量化噪声上界 0.707 px 之内，不构成"闭式关系有偏"的证据 ——
 * 把它当成修正量施加，等于往平滑的闭式路径里注入噪声。
 * 只有当多次运行都显示同向且显著超出噪声上界的偏差时，才应考虑应用修正。
 */
const measuredBiasCache = new WeakMap<object, Point>()

export function getMeasuredBias(canvas: CanvasLike): Point | null {
  return measuredBiasCache.get(canvas as object) ?? null
}

function sampleWorldAt(canvas: CanvasLike, client: Point): Point | null {
  const evt = syntheticMouseEvent(client)
  const posFromEvt = asFn(canvas.posFromEvt)
  if (!evt || !posFromEvt) return null
  try {
    const raw = (posFromEvt as unknown as (e: MouseEvent) => unknown).call(canvas, evt)
    const rec = asRecord(raw)
    const x = rec ? asNumber(rec.x) : null
    const y = rec ? asNumber(rec.y) : null
    return x !== null && y !== null ? { x, y } : null
  } catch {
    return null
  }
}

/**
 * 量化探测：沿水平与垂直方向以远小于量子的步长（0.25 px）密集采样。
 * 若输出被量化到设备像素，相邻样本的世界坐标差只会取离散值，且会出现重复。
 */
function probeQuantization(
  canvas: CanvasLike,
  viewportRect: ScreenRect,
  scale: number,
): { x: QuantumEstimate; y: QuantumEstimate } | null {
  const step = 0.25
  const count = 200
  const startX = viewportRect.left + Math.min(60, viewportRect.width * 0.1)
  const midY = viewportRect.top + viewportRect.height / 2
  const startY = viewportRect.top + Math.min(60, viewportRect.height * 0.1)
  const midX = viewportRect.left + viewportRect.width / 2

  const horizontal: Array<{ client: number; world: number }> = []
  const vertical: Array<{ client: number; world: number }> = []

  for (let i = 0; i < count; i++) {
    const x = startX + i * step
    const y = midY
    const world = sampleWorldAt(canvas, { x, y })
    if (!world) return null
    horizontal.push({ client: x, world: world.x })

    const y2 = startY + i * step
    const world2 = sampleWorldAt(canvas, { x: midX, y: y2 })
    if (!world2) return null
    vertical.push({ client: y2, world: world2.y })
  }

  return { x: estimateQuantum(horizontal, scale), y: estimateQuantum(vertical, scale) }
}

/**
 * 多点标定：在视口内取 5×5 网格做校准，另取若干留出样本验证。
 * 返回校准结果与留出残差；同时把测出的偏差写入缓存供运行时使用。
 */
function calibrateFromCanvas(
  canvas: CanvasLike,
  viewportRect: ScreenRect,
  scale: number,
  derivedOrigin: Point | null,
): { calibration: OriginCalibration | null; heldOutResidualWorld: number | null; quantization: { x: QuantumEstimate; y: QuantumEstimate } | null } {
  const insetX = viewportRect.width * 0.06
  const insetY = viewportRect.height * 0.06
  const usableW = viewportRect.width - insetX * 2
  const usableH = viewportRect.height - insetY * 2

  const calibrationSamples: Array<{ client: Point; world: Point }> = []
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const client = { x: viewportRect.left + insetX + (usableW * i) / 4, y: viewportRect.top + insetY + (usableH * j) / 4 }
      const world = sampleWorldAt(canvas, client)
      if (world) calibrationSamples.push({ client, world })
    }
  }

  const calibration = calibrateOrigin(calibrationSamples, scale, derivedOrigin ?? undefined)
  if (!calibration) {
    return { calibration: null, heldOutResidualWorld: null, quantization: null }
  }

  // 偏差修正：闭式原点与标定原点的差（供报告使用）
  if (derivedOrigin) {
    measuredBiasCache.set(canvas as object, {
      x: calibration.origin.x - derivedOrigin.x,
      y: calibration.origin.y - derivedOrigin.y,
    })
  }

  // 留出验证：用不参与标定的点检验校准后的投影
  const verifyPoints: Point[] = [
    { x: viewportRect.left + insetX + usableW * 0.17, y: viewportRect.top + insetY + usableH * 0.63 },
    { x: viewportRect.left + insetX + usableW * 0.39, y: viewportRect.top + insetY + usableH * 0.21 },
    { x: viewportRect.left + insetX + usableW * 0.58, y: viewportRect.top + insetY + usableH * 0.88 },
    { x: viewportRect.left + insetX + usableW * 0.83, y: viewportRect.top + insetY + usableH * 0.44 },
    { x: viewportRect.left + insetX + usableW * 0.71, y: viewportRect.top + insetY + usableH * 0.07 },
  ]

  // 以标定原点 + 视口中心为锚点构建投影
  const anchorClient = { x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + viewportRect.height / 2 }
  const anchorWorld = {
    x: (anchorClient.x - calibration.origin.x) / scale,
    y: (anchorClient.y - calibration.origin.y) / scale,
  }
  const projection = projectionFrom(anchorClient, anchorWorld, scale)

  let heldOutResidualWorld = 0
  let measured = 0
  for (const client of verifyPoints) {
    const world = sampleWorldAt(canvas, client)
    if (!world) continue
    const predicted = clientToWorld(projection, client)
    heldOutResidualWorld = Math.max(heldOutResidualWorld, Math.hypot(predicted.x - world.x, predicted.y - world.y))
    measured += 1
  }

  return {
    calibration,
    heldOutResidualWorld: measured > 0 ? heldOutResidualWorld : null,
    quantization: probeQuantization(canvas, viewportRect, scale),
  }
}

function syntheticMouseEvent(client: Point): MouseEvent | null {
  if (typeof MouseEvent !== 'function') return null
  return new MouseEvent('mousemove', { clientX: client.x, clientY: client.y, bubbles: false })
}

/**
 * 构建客户端 ↔ 世界投影。
 *
 * 锚点取视口中心，世界坐标由 Obsidian 自己的 posFromEvt 给出（语义已由 Phase 0 实测确认：
 * 接受 clientX/clientY）。缩放取变换矩阵的 a 分量，退化到 scale 字段或 2^tZoom。
 */
export function buildProjection(canvas: CanvasLike, options: ProjectionOptions = {}): ProjectionResult {
  const notes: string[] = []
  const { scale: scaleHint } = readScale(canvas)
  const candidates = probeTransformCandidates(canvas, scaleHint)
  const host = pickWorldHost(candidates)

  let scale: number | null = null
  let scaleSource = '不可用'
  if (host?.matrix) {
    scale = host.matrix.a
    scaleSource = '变换矩阵 a 分量'
  } else {
    const fallback = readScale(canvas)
    scale = fallback.scale
    scaleSource = fallback.source === '不可用' ? '不可用' : `${fallback.source}（无矩阵，退化）`
  }

  const viewportRect = readViewportRect(canvas)
  if (!viewportRect) notes.push('无法读取视口矩形（wrapperEl 不可用）')

  // 闭式兜底：Phase 0 实测发现 client(world 0,0) = wrapperRect.topLeft + matrix(e, f)。
  // 这只是单次实测归纳出的经验关系，因此**只作为兜底**，并持续用权威来源校验它。
  const derivedOrigin: Point | null =
    host?.matrix && viewportRect
      ? { x: viewportRect.left + host.matrix.e, y: viewportRect.top + host.matrix.f }
      : null

  const fail = (extra: Partial<ProjectionResult> = {}): ProjectionResult => ({
    projection: null,
    anchorSource: 'none',
    scale,
    scaleSource,
    viewportRect,
    host,
    crossCheckDelta: null,
    derivedOrigin,
    derivedOriginDelta: null,
    calibration: null,
    heldOutResidualWorld: null,
    quantization: null,
    notes,
    ...extra,
  })

  if (scale === null || scale <= 0) {
    notes.push('无法确定缩放比例')
    return fail()
  }

  if (scaleHint !== null && Math.abs(scale - scaleHint) > Math.max(1e-3, scaleHint * 1e-3)) {
    notes.push(`矩阵缩放 ${scale} 与 tZoom 推算 ${scaleHint} 不一致`)
  }

  if (!viewportRect) return fail()

  const anchorClient: Point = {
    x: viewportRect.left + viewportRect.width / 2,
    y: viewportRect.top + viewportRect.height / 2,
  }

  let anchorSource: ProjectionResult['anchorSource'] = 'none'

  let derivedOriginDelta: number | null = null
  let calibration: OriginCalibration | null = null
  let heldOutResidualWorld: number | null = null
  let quantization: { x: QuantumEstimate; y: QuantumEstimate } | null = null

  // 运行时原点：**纯闭式**（来自精确 CSS 值，无量化抖动）。
  // 不施加标定测出的偏差 —— 实测该偏差落在量化噪声上界之内，修正只会注入噪声。
  const origin: Point | null = derivedOrigin
  if (origin) anchorSource = 'closed-form'

  if (options.calibrate && viewportRect) {
    const result = calibrateFromCanvas(canvas, viewportRect, scale, derivedOrigin)
    calibration = result.calibration
    heldOutResidualWorld = result.heldOutResidualWorld
    quantization = result.quantization
  }

  // 退化路径：没有闭式原点时，用单点 posFromEvt / posFromClient 当锚点
  if (origin === null) {
    let fallbackWorld: Point | null = null
    let fallbackSource: ProjectionResult['anchorSource'] = 'none'

    const evt = syntheticMouseEvent(anchorClient)
    const posFromEvt = asFn(canvas.posFromEvt)
    if (evt && posFromEvt) {
      try {
        const raw = (posFromEvt as unknown as (e: MouseEvent) => unknown).call(canvas, evt)
        const rec = asRecord(raw)
        const x = rec ? asNumber(rec.x) : null
        const y = rec ? asNumber(rec.y) : null
        if (x !== null && y !== null) {
          fallbackWorld = { x, y }
          fallbackSource = 'posFromEvt'
        }
      } catch (err) {
        notes.push(`posFromEvt 抛错：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (fallbackWorld === null) {
      const posFromClient = asFn(canvas.posFromClient)
      if (posFromClient) {
        try {
          const raw = (posFromClient as unknown as (p: Point) => unknown).call(canvas, anchorClient)
          const rec = asRecord(raw)
          const x = rec ? asNumber(rec.x) : null
          const y = rec ? asNumber(rec.y) : null
          if (x !== null && y !== null) {
            fallbackWorld = { x, y }
            fallbackSource = 'posFromClient'
          }
        } catch (err) {
          notes.push(`posFromClient 抛错：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    if (fallbackWorld === null) {
      notes.push('无法确定原点（闭式推导、posFromEvt、posFromClient 均不可用）')
      return fail()
    }

    const projection = projectionFrom(anchorClient, fallbackWorld, scale)
    if (!isProjection(projection)) {
      notes.push('构建出的投影未通过形状校验')
      return fail()
    }
    return {
      projection,
      anchorSource: fallbackSource,
      scale,
      scaleSource,
      viewportRect,
      host,
      crossCheckDelta: null,
      derivedOrigin,
      derivedOriginDelta: null,
      calibration,
      heldOutResidualWorld,
      quantization,
      notes,
    }
  }

  // 用视口中心做锚点：数值条件更好，且与原点表示等价
  const anchorWorld = { x: (anchorClient.x - origin.x) / scale, y: (anchorClient.y - origin.y) / scale }
  const projection = projectionFrom(anchorClient, anchorWorld, scale)
  if (!isProjection(projection)) {
    notes.push('构建出的投影未通过形状校验')
    return fail()
  }

  // 交叉验证：把闭式原点经投影换算回客户端，应回到它自身
  if (derivedOrigin) {
    const closedForm = worldToClient(projection, { x: 0, y: 0 })
    derivedOriginDelta = Math.hypot(closedForm.x - derivedOrigin.x, closedForm.y - derivedOrigin.y)
  }

  // posFromClient 与 posFromEvt 的语义对照（单点）
  let crossCheckDelta: number | null = null
  const posFromClient = asFn(canvas.posFromClient)
  if (posFromClient) {
    try {
      const raw = (posFromClient as unknown as (p: Point) => unknown).call(canvas, anchorClient)
      const rec = asRecord(raw)
      const x = rec ? asNumber(rec.x) : null
      const y = rec ? asNumber(rec.y) : null
      if (x !== null && y !== null) {
        const roundTrip = worldToClient(projection, { x, y })
        crossCheckDelta = Math.hypot(roundTrip.x - anchorClient.x, roundTrip.y - anchorClient.y)
      }
    } catch (err) {
      notes.push(`posFromClient 抛错：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    projection,
    anchorSource,
    scale,
    scaleSource,
    viewportRect,
    host,
    crossCheckDelta,
    derivedOrigin,
    derivedOriginDelta,
    calibration,
    heldOutResidualWorld,
    quantization,
    notes,
  }
}

// ---------------------------------------------------------------- 坐标转换

/** 指针事件 → 世界坐标。posFromEvt 是权威来源；投影作为兜底。 */
export function pointerToWorld(
  canvas: CanvasLike,
  evt: MouseEvent,
): { point: Point; source: 'posFromEvt' | 'projection' } | null {
  const fn = asFn(canvas.posFromEvt)
  if (fn) {
    try {
      const result = (fn as unknown as (e: MouseEvent) => unknown).call(canvas, evt)
      const rec = asRecord(result)
      const x = rec ? asNumber(rec.x) : null
      const y = rec ? asNumber(rec.y) : null
      if (x !== null && y !== null) return { point: { x, y }, source: 'posFromEvt' }
    } catch {
      // 落到投影兜底
    }
  }
  const { projection } = buildProjection(canvas)
  if (!projection) return null
  return { point: clientToWorld(projection, { x: evt.clientX, y: evt.clientY }), source: 'projection' }
}

// ---------------------------------------------------------------- 视口变化监听

/**
 * 用 around() 包装 markViewportChanged 感知平移/缩放。
 * Phase 0 实测（1.13.7）：3 次平移 + 3 次缩放触发 168 次回调（动画期间逐帧），
 * 因此调用方**必须**做去重与逐帧合并，不能每个事件重绘一次。
 */
export function watchViewportChanges(canvas: CanvasLike, onChange: () => void): Uninstaller | null {
  if (asFn(canvas.markViewportChanged) === null) return null
  try {
    return around(canvas as CanvasLike & object, 'markViewportChanged', (next) => {
      return (...args: unknown[]) => {
        const result = next(...args)
        try {
          onChange()
        } catch (err) {
          console.error('[project-kaki] 视口回调抛错', err)
        }
        return result
      }
    })
  } catch (err) {
    console.warn('[project-kaki] 无法补丁 markViewportChanged', err)
    return null
  }
}

/** 私有对象上「哪些方法真的存在」的汇总，供诊断报告直接下结论 */
export function adapterCapabilities(canvas: CanvasLike): Record<string, boolean> {
  const projection = buildProjection(canvas)
  return {
    canReadViewport: readViewport(canvas) !== null,
    canReadScale: readScale(canvas).scale !== null,
    canBuildProjection: projection.projection !== null,
    canConvertPointer: asFn(canvas.posFromEvt) !== null,
    canConvertClient: asFn(canvas.posFromClient) !== null,
    canSetViewport: asFn(canvas.setViewport) !== null,
    canPatchViewport: asFn(canvas.markViewportChanged) !== null,
    canRequestSave: asFn(canvas.requestSave) !== null,
    canReadData: asRecord(canvas.data) !== null,
    hasOverlayHosts: asElement(canvas.wrapperEl) !== null,
  }
}
