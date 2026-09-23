/**
 * 地图覆盖层。
 *
 * 挂载策略（Phase 0 实测确定）：插到 `div.canvas` 内部、且作为**第一个子元素**，
 * 这样它既是「策略 A」（坐标随 CSS 变换免费同步），又位于原生节点之下（地形在地图卡片下方）。
 *
 * 坐标：`div.canvas` 局部坐标 = 世界坐标（实测：各 canvas-node 的 translate 正是它在
 * .canvas 文件里的 x/y），所以覆盖层用世界坐标定位即可严格对齐。
 *
 * 重绘：`markViewportChanged` 逐帧触发（实测每帧一次），因此
 * 1) 用 rAF 合并同一帧内的多次请求；
 * 2) 每帧的重绘必须廉价 —— 视口裁剪 + 精灵图集，一次 drawImage 画一格。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import {
  buildProjection,
  pickWorldHost,
  probeTransformCandidates,
  readScale,
  readViewportRect,
  watchViewportChanges,
  type CanvasHandle,
} from '../canvas/CanvasAdapter.ts'
import { axialToWorld, hexCorners } from '../core/hex.ts'
import { brushCellsAt, visibleCellBounds } from './hexGrid.ts'
import { buildRenderPlan, worldToRaster, type MapRenderPlan } from './renderPlan.ts'
import { MarkerLayer } from './MarkerLayer.ts'
import { buildPlacements, type MarkerPlacement } from './markerPlacement.ts'
import { drawDraft, drawPath, drawRegion, labelCssPx } from './shapeDraw.ts'
import { buildTerrainAtlas, drawTerrainCell, type TerrainAtlas } from './spriteAtlas.ts'
import type { ClientProjection } from '../core/projection.ts'
import type { MapDraft } from '../editor/MapEditor.ts'

/** 超过这个可见格数就不画网格线（缩小到很远时逐格描边会拖垮帧率） */
const MAX_GRID_CELLS = 4000

export interface OverlayStats {
  attached: boolean
  hostClass: string | null
  redraws: number
  lastCellCount: number
  lastCulledCells: number
  lastGridCells: number
  lastPathCount: number
  lastRegionCount: number
  lastMarkerCount: number
  markerLayerAttached: boolean
  lastRaster: { width: number; height: number } | null
  /** 实测的"位图像素 / 屏幕 CSS 像素"（名称字号的换算依据，诊断用） */
  rasterPxPerCssPx: number
  /** 当前实际使用的名称字号（屏幕 CSS px） */
  labelCssPx: { path: number; region: number } | null
  lastDurationMs: number
  lastError: string | null
}

export interface MapOverlayOptions {
  handle: CanvasHandle
  getDocument: () => MapDocument | null
  showGrid?: boolean
  /** 注入画布工厂（测试用；默认用宿主 document 创建） */
  canvasFactory?: (width: number, height: number) => HTMLCanvasElement
  /** 标记层宿主（未变换的 wrapperEl）；不提供则不渲染标记 */
  getMarkerHost?: () => HTMLElement | null
  /** 每帧计算可见的标记与文字标注（由渲染层负责调度，保证与地形同帧） */
  getPlacements?: (
    document_: MapDocument,
    projection: ClientProjection,
    viewportRect: { left: number; top: number; width: number; height: number },
  ) => MarkerPlacement[]
  /** 点击带链接的标记 */
  onOpenLink?: (link: string) => void
  /** 右键删除标记/标注 */
  onDeleteMarker?: (placement: MarkerPlacement) => void
  /** 拖动移动的四个阶段（客户端坐标；世界坐标换算由上层负责） */
  onEntityDragStart?: (placement: MarkerPlacement, client: { x: number; y: number }) => void
  onEntityDragMove?: (client: { x: number; y: number }) => void
  onEntityDragEnd?: (client: { x: number; y: number }) => void
  onEntityDragCancel?: () => void
  /** 注入图标可用性校验（测试用；默认用 obsidian 的 getIcon） */
  hasIcon?: (name: string) => boolean
  /** 进行中的路径/区域草稿（预览用；由编辑器提供） */
  getDraft?: () => MapDraft | null
  /** 是否显示路径/区域的名称标签 */
  getShowShapeLabels?: () => boolean
  /** 名称字号倍率（用户设置；1 = 默认） */
  getLabelScale?: () => number
  /**
   * 名称字体族（用户设置）。
   *
   * 返回 `''` 表示"跟随主题"（这时才去读 getComputedStyle）。
   * 设置层已经保证这里不会出现 `var()`：那种串会让整条 `ctx.font` 失效、字号静默退回默认值。
   */
  getLabelFontFamily?: () => string
}

function asElement(value: unknown): HTMLElement | null {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record !== 'object') return null
  return typeof record.appendChild === 'function' ? (value as HTMLElement) : null
}

function hostWindow(container: HTMLElement | null): (Window & typeof globalThis) | undefined {
  const fromContainer = container?.ownerDocument?.defaultView
  if (fromContainer) return fromContainer as Window & typeof globalThis
  return typeof window !== 'undefined' ? window : undefined
}

export class MapOverlay {
  private readonly options: MapOverlayOptions
  private readonly handle: CanvasHandle
  private readonly getDocument: () => MapDocument | null
  private readonly canvasFactory: ((width: number, height: number) => HTMLCanvasElement) | null

  private container: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private atlas: TerrainAtlas | null = null
  private markerLayer: MarkerLayer | null = null
  private uninstallPatch: (() => void) | null = null

  private frameHandle: number | null = null
  private pendingRedraw = false
  private markerInteractive = false
  private disposed = false
  /** 上一次实测的"位图像素 / 屏幕 CSS 像素"（作为下一帧的初值） */
  private rasterPxPerCssPx: number | null = null

  showGrid: boolean
  /** 悬停预览：绘制模式下高亮笔刷落点 */
  private hover: { x: number; y: number; radius: number } | null = null
  private stats: OverlayStats = {
    attached: false,
    hostClass: null,
    redraws: 0,
    lastCellCount: 0,
    lastCulledCells: 0,
    lastGridCells: 0,
    lastPathCount: 0,
    lastRegionCount: 0,
    lastMarkerCount: 0,
    markerLayerAttached: false,
    lastRaster: null,
    rasterPxPerCssPx: 1,
    labelCssPx: null,
    lastDurationMs: 0,
    lastError: null,
  }

  constructor(options: MapOverlayOptions) {
    this.options = options
    this.handle = options.handle
    this.getDocument = options.getDocument
    this.showGrid = options.showGrid ?? true
    this.canvasFactory = options.canvasFactory ?? null
  }

  getStats(): OverlayStats {
    return { ...this.stats }
  }

  isAttached(): boolean {
    return this.stats.attached
  }

  /** 覆盖层容器：交互层把指针监听挂在这里 */
  getContainer(): HTMLElement | null {
    return this.container
  }

  setShowGrid(showGrid: boolean): void {
    if (this.showGrid === showGrid) return
    this.showGrid = showGrid
    this.requestRedraw()
  }

  /** 设置悬停预览（笔刷落点高亮）；传 null 清除 */
  setHover(hover: { x: number; y: number; radius: number } | null): void {
    // 状态没变就不要重绘：模式同步等路径会反复传 null，
    // 每次都排一帧会白白增加每帧开销（实测 markViewportChanged 本身已逐帧触发）。
    const current = this.hover
    const same =
      (current === null && hover === null) ||
      (current !== null &&
        hover !== null &&
        current.x === hover.x &&
        current.y === hover.y &&
        current.radius === hover.radius)
    if (same) return
    this.hover = hover
    this.requestRedraw()
  }

  /** 挂载覆盖层。返回失败原因而不是抛异常 —— 调用方处于视图生命周期中。 */
  attach(): { ok: boolean; reason?: string } {
    if (this.stats.attached) return { ok: true }
    try {
      const { scale } = readScale(this.handle.canvas)
      const hostCandidate = pickWorldHost(probeTransformCandidates(this.handle.canvas, scale))
      const host = asElement(hostCandidate?.el)
      if (!host) return { ok: false, reason: '未找到世界层挂载点（div.canvas）' }

      const win = hostWindow(host)
      const doc = host.ownerDocument ?? win?.document
      if (!doc) return { ok: false, reason: '无法获得 document' }

      const container = doc.createElement('div')
      container.className = 'fc-overlay'

      const canvas = this.canvasFactory
        ? this.canvasFactory(1, 1)
        : (() => {
            const created = doc.createElement('canvas')
            created.width = 1
            created.height = 1
            return created
          })()
      canvas.className = 'fc-terrain-layer'

      container.appendChild(canvas)
      // 插到最前面：地形位于原生节点之下
      host.insertBefore(container, host.firstChild)

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        container.remove()
        return { ok: false, reason: '无法获取 2D 绘图上下文' }
      }

      this.container = container
      this.canvas = canvas
      this.ctx = ctx
      this.stats.attached = true
      this.stats.hostClass = hostCandidate?.cls ?? null

      this.uninstallPatch = watchViewportChanges(this.handle.canvas, () => this.requestRedraw())
      // 立即画一帧：地图应当在启用瞬间就出现，而不是等下一帧；
      // 这也让调用方（启用命令）能拿到真实的绘制统计，而不是一串 0。
      this.redrawNow()
      return { ok: true }
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: this.stats.lastError }
    }
  }

  detach(): void {
    this.disposed = true
    this.cancelFrame()
    if (this.uninstallPatch) {
      try {
        this.uninstallPatch()
      } catch (error) {
        console.error('[project-kaki] 还原视口补丁失败', error)
      }
      this.uninstallPatch = null
    }
    this.container?.remove()
    this.container = null
    this.canvas = null
    this.ctx = null
    this.atlas = null
    this.markerLayer?.destroy()
    this.markerLayer = null
    this.stats.markerLayerAttached = false
    this.stats.attached = false
  }

  /** 请求一次重绘（同一帧内的多次请求会被合并） */
  requestRedraw(): void {
    if (this.disposed || !this.stats.attached) return
    if (this.pendingRedraw) return
    this.pendingRedraw = true
    const win = hostWindow(this.container)
    if (win && typeof win.requestAnimationFrame === 'function') {
      this.frameHandle = win.requestAnimationFrame(() => {
        this.frameHandle = null
        this.redrawNow()
      })
      return
    }
    // 没有 rAF（测试环境）时同步绘制
    this.redrawNow()
  }

  /** 立即重绘（同步） */
  redrawNow(): void {
    this.pendingRedraw = false
    if (this.disposed || !this.ctx || !this.canvas || !this.container) return

    const win = hostWindow(this.container)
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      const document_ = this.getDocument()
      const viewportRect = readViewportRect(this.handle.canvas)
      const { projection } = buildProjection(this.handle.canvas)

      if (!document_ || !viewportRect || !projection) {
        this.container.style.display = 'none'
        return
      }

      const dpr = win?.devicePixelRatio
      const devicePixelRatio = typeof dpr === 'number' && dpr > 0 ? dpr : 1
      const labelScale = this.options.getLabelScale?.() ?? 1
      const fontFamily = this.resolveFontFamily()
      let rasterPxPerCssPx = this.rasterPxPerCssPx ?? devicePixelRatio
      let plan = buildRenderPlan({
        document: document_,
        projection,
        viewportRect,
        devicePixelRatio,
        rasterPxPerCssPx,
        labelScale,
        fontFamily,
      })
      if (!plan) {
        this.container.style.display = 'none'
        return
      }

      // 先把尺寸写进 DOM，**再实测**"位图像素 / 屏幕 CSS 像素"。
      // 实测值变了才重建计划：它决定名称字号，错一次就要等下一帧才对。
      this.applyLayout(plan)
      const measured = this.measureRasterScale(rasterPxPerCssPx)
      if (Math.abs(measured - rasterPxPerCssPx) > 0.001) {
        let rebuilt: MapRenderPlan | null = null
        try {
          rebuilt = buildRenderPlan({
            document: document_,
            projection,
            viewportRect,
            devicePixelRatio,
            rasterPxPerCssPx: measured,
            labelScale,
            fontFamily,
          })
        } catch {
          rebuilt = null
        }
        if (rebuilt) {
          plan = rebuilt
          // 位图尺寸没变（同一个视口与 dpr），因此这里不会重置画布
          this.applyLayout(plan)
        }
      }
      this.rasterPxPerCssPx = plan.layer.rasterPxPerCssPx

      this.drawPlan(plan, document_)
      this.syncMarkers(document_, projection, viewportRect)

      this.stats.redraws += 1
      this.stats.lastCellCount = plan.cells.length
      this.stats.lastCulledCells = plan.culledCells
      this.stats.lastRaster = { width: plan.layer.rasterWidth, height: plan.layer.rasterHeight }
      this.stats.rasterPxPerCssPx = plan.layer.rasterPxPerCssPx
      this.stats.labelCssPx = {
        path: labelCssPx(plan.layer, 'path'),
        region: labelCssPx(plan.layer, 'region'),
      }
      this.stats.lastError = null
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error)
      console.error('[project-kaki] 重绘失败', error)
    } finally {
      this.stats.lastDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started
    }
  }

  /**
   * 实测"位图像素 / 屏幕 CSS 像素"。
   *
   * 位图尺寸是我们设的（视口 × dpr），但它在屏幕上占多少 CSS 像素由浏览器决定
   * （元素 CSS 尺寸 × 所在容器的 transform）。这里直接量，不去假设：
   * 名称字号承诺的是"N 个 CSS 像素"，那就必须以实测为准。
   */
  private measureRasterScale(fallback: number): number {
    const canvas = this.canvas
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function' || !(canvas.width > 0)) return fallback
    try {
      const rect = canvas.getBoundingClientRect()
      if (rect && rect.width > 0) {
        const factor = canvas.width / rect.width
        if (Number.isFinite(factor) && factor > 0) return factor
      }
    } catch {
      // 读布局失败时退回给定值：宁可字号略偏，也不能让整帧渲染抛异常
    }
    return fallback
  }

  /**
   * 解析**真实的**字体族（给 `ctx.font` 用）。
   *
   * 不能写 `var(--font-interface)`：canvas 的 `font` 是 CSS font 简写，
   * 没有元素上下文可供变量替换，整条声明会非法 → 赋值被静默忽略 → 字号退回默认 10 px。
   * 主题字体只能这样取：算好具体的字体列表，再交给画布。
   */
  private resolveFontFamily(): string {
    // 用户在设置里指定了字体族就用它（已经在设置层清洗过：含 var()/斜杠等一律被收敛成空串）。
    // 注意这里**不能**回头去读 getComputedStyle：设置的字体可能并未加载，
    // 读回来的是"解析后的列表"，看起来更"安全"，但会让用户设置的字体悄悄失效。
    const configured = this.options.getLabelFontFamily?.() ?? ''
    if (configured.trim().length > 0 && !configured.includes('var(')) return configured

    const target = this.container ?? this.canvas
    if (!target) return 'sans-serif'
    try {
      const win = hostWindow(target)
      const style = win?.getComputedStyle?.(target)
      const family = style?.fontFamily
      if (typeof family === 'string' && family.trim().length > 0 && !family.includes('var(')) return family
    } catch {
      // 读不到就用兜底字体：宁可字体族不跟随主题，也不能让字号退回默认值
    }
    return 'sans-serif'
  }

  private applyLayout(plan: MapRenderPlan): void {    const container = this.container
    const canvas = this.canvas
    if (!container || !canvas) return

    const { layer } = plan
    container.style.display = ''
    container.style.position = 'absolute'
    container.style.left = `${layer.left}px`
    container.style.top = `${layer.top}px`
    container.style.width = `${layer.widthWorld}px`
    container.style.height = `${layer.heightWorld}px`
    container.style.pointerEvents = 'none'

    canvas.style.width = '100%'
    canvas.style.height = '100%'
    // 改 width/height 会清空画布，因此只在尺寸变化时赋值
    if (canvas.width !== layer.rasterWidth || canvas.height !== layer.rasterHeight) {
      canvas.width = layer.rasterWidth
      canvas.height = layer.rasterHeight
    }
  }

  /**
   * 同步标记与文字标注层（与地形同一帧、同一个 rAF，保证两者不脱节）。
   * 标记层挂在未变换的 wrapperEl 上，因此这里用的是屏幕坐标。
   */
  private syncMarkers(
    document_: MapDocument,
    projection: ClientProjection,
    viewportRect: { left: number; top: number; width: number; height: number },
  ): void {
    if (!this.options.getPlacements || !this.options.getMarkerHost) return

    if (!this.markerLayer) {
      const host = this.options.getMarkerHost()
      if (!host) return
      this.markerLayer = new MarkerLayer({
        host,
        onOpenLink: (link) => this.options.onOpenLink?.(link),
        onDelete: (placement) => this.options.onDeleteMarker?.(placement),
        ...(this.options.onEntityDragStart ? { onDragStart: this.options.onEntityDragStart } : {}),
        ...(this.options.onEntityDragMove ? { onDragMove: this.options.onEntityDragMove } : {}),
        ...(this.options.onEntityDragEnd ? { onDragEnd: this.options.onEntityDragEnd } : {}),
        ...(this.options.onEntityDragCancel ? { onDragCancel: this.options.onEntityDragCancel } : {}),
        ...(this.options.hasIcon ? { hasIcon: this.options.hasIcon } : {}),
      })
      this.stats.markerLayerAttached = true
    }

    const placements = this.options.getPlacements(document_, projection, viewportRect)
    this.markerLayer.sync(placements)
    this.markerLayer.setInteractive(this.markerInteractive)
    this.stats.lastMarkerCount = placements.length
  }

  /** 选择模式下标记可点（打开链接 / 右键删除）；绘制模式下让位给放置手势 */
  setMarkerInteractive(interactive: boolean): void {
    this.markerInteractive = interactive
    this.markerLayer?.setInteractive(interactive)
  }

  getMarkerLayer(): MarkerLayer | null {
    return this.markerLayer
  }

  private atlasFor(document_: MapDocument): TerrainAtlas | null {    if (this.atlas && this.atlas.orientation === document_.grid.orientation) return this.atlas
    this.atlas = buildTerrainAtlas(
      this.canvasFactory
        ? { orientation: document_.grid.orientation, factory: this.canvasFactory }
        : { orientation: document_.grid.orientation },
    )
    return this.atlas
  }

  private drawPlan(plan: MapRenderPlan, document_: MapDocument): void {
    const ctx = this.ctx
    if (!ctx) return

    const { layer } = plan
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, layer.rasterWidth, layer.rasterHeight)

    const targetRadius = document_.grid.size * layer.deviceScale

    const atlas = this.atlasFor(document_)

    // 层次（自下而上）：地形 → 网格线 → 区域 → 路径 → 草稿 → 悬停高亮
    if (atlas) {
      for (const cell of plan.cells) {
        const center = worldToRaster(layer, cell.x, cell.y)
        const drawn = drawTerrainCell(ctx, atlas, cell.type, center.x, center.y, targetRadius)
        if (drawn && cell.color) {
          // 覆盖色：叠一层半透明填充，保留字形可见
          const corners = hexCorners(
            { kind: 'hex', orientation: document_.grid.orientation, size: targetRadius, origin: [center.x, center.y] },
            0,
            0,
          )
          ctx.beginPath()
          corners.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y)
            else ctx.lineTo(point.x, point.y)
          })
          ctx.closePath()
          ctx.globalAlpha = 0.45
          ctx.fillStyle = cell.color
          ctx.fill()
          ctx.globalAlpha = 1
        }
      }
    }

    this.stats.lastGridCells = this.showGrid ? this.drawGrid(ctx, plan, document_, targetRadius) : 0

    const showShapeLabels = this.options.getShowShapeLabels?.() ?? true
    for (const region of plan.regions) drawRegion(ctx, layer, region, showShapeLabels)
    for (const path of plan.paths) drawPath(ctx, layer, path, showShapeLabels)
    this.stats.lastRegionCount = plan.regions.length
    this.stats.lastPathCount = plan.paths.length

    const draft = this.options.getDraft?.() ?? null
    if (draft) drawDraft(ctx, layer, draft)

    if (this.hover) this.drawHover(ctx, plan, document_, targetRadius)
  }

  /** 悬停预览：高亮笔刷将覆盖的格（绘制模式下用户据此判断落点） */
  private drawHover(
    ctx: CanvasRenderingContext2D,
    plan: MapRenderPlan,
    document_: MapDocument,
    targetRadius: number,
  ): void {
    const hover = this.hover
    if (!hover) return

    const cells = brushCellsAt(document_.grid, { x: hover.x, y: hover.y }, hover.radius)
    for (const cell of cells) {
      const world = axialToWorld(document_.grid, cell.q, cell.r)
      const center = worldToRaster(plan.layer, world.x, world.y)
      const corners = hexCorners(
        { kind: 'hex', orientation: document_.grid.orientation, size: targetRadius, origin: [center.x, center.y] },
        0,
        0,
      )
      ctx.beginPath()
      corners.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.closePath()
      ctx.globalAlpha = 0.35
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgba(40, 40, 40, 0.85)'
      ctx.lineWidth = Math.max(1.5, targetRadius * 0.06)
      ctx.stroke()
    }
  }

  /** 画可见区的六边形网格线（对齐校验与绘制时的视觉参考） */
  private drawGrid(
    ctx: CanvasRenderingContext2D,
    plan: MapRenderPlan,
    document_: MapDocument,
    targetRadius: number,
  ): number {
    const bounds = visibleCellBounds(document_.grid, plan.visibleWorld, 1)
    const count = (bounds.maxQ - bounds.minQ + 1) * (bounds.maxR - bounds.minR + 1)
    if (count > MAX_GRID_CELLS) return 0

    ctx.strokeStyle = 'rgba(120, 120, 120, 0.35)'
    ctx.lineWidth = Math.max(1, targetRadius * 0.03)
    let drawn = 0

    // ⚡ 整帧只建**一条**路径、只 stroke 一次：
    // 逐格 beginPath+stroke 在缩小状态下会变成上千次描边调用（实测可见格 1200+），
    // 而相邻六边形的边是重合的，合并成一条路径既更快，视觉上也更干净。
    ctx.beginPath()
    for (let r = bounds.minR; r <= bounds.maxR; r++) {
      for (let q = bounds.minQ; q <= bounds.maxQ; q++) {
        const world = axialToWorld(document_.grid, q, r)
        const center = worldToRaster(plan.layer, world.x, world.y)
        const corners = hexCorners(
          { kind: 'hex', orientation: document_.grid.orientation, size: targetRadius, origin: [center.x, center.y] },
          0,
          0,
        )
        corners.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x, point.y)
          else ctx.lineTo(point.x, point.y)
        })
        ctx.closePath()
        drawn += 1
      }
    }
    if (drawn > 0) ctx.stroke()
    return drawn
  }

  private cancelFrame(): void {
    if (this.frameHandle === null) return
    const win = hostWindow(this.container)
    try {
      win?.cancelAnimationFrame?.(this.frameHandle)
    } catch {
      // 窗口已销毁时忽略
    }
    this.frameHandle = null
  }
}
