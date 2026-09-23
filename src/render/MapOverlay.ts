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
import {
  buildTerrainAtlas,
  drawTerrainCell,
  DEFAULT_SPRITE_RADIUS,
  type BuildAtlasOptions,
  type TerrainAtlas,
} from './spriteAtlas.ts'
import {
  findCustomTerrain,
  isBuiltinTerrain,
  listResolvedTerrainStyles,
  resolveTerrainStyle,
  terrainCatalogSignature,
  type CustomTerrain,
  type ResolvedTerrainStyle,
} from './terrainCatalog.ts'
import type { ClientProjection } from '../core/projection.ts'
import { DEFAULT_LAYER_VISIBILITY, isLayerVisible, type LayerVisibility } from './layerVisibility.ts'
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
  /** 名称字号倍率（用户设置；1 = 默认） */
  getLabelScale?: () => number
  /**
   * 名称字体族（用户设置）。
   *
   * 返回 `''` 表示"跟随主题"（这时才去读 getComputedStyle）。
   * 设置层已经保证这里不会出现 `var()`：那种串会让整条 `ctx.font` 失效、字号静默退回默认值。
   */
  getLabelFontFamily?: () => string
  /** 用户自定义地形（来自插件设置）；缺省即只有内置 9 种 */
  getCustomTerrains?: () => readonly CustomTerrain[]
  /**
   * 加载一格地形图片。
   *
   * **渲染层不允许自己碰 vault**（这条铁律让整个渲染层能在没有 Obsidian 的环境里测），
   * 所以图片加载从这个口子注入，由 `MapLayerManager` 用 `app.vault` + 资源路径实现。
   *
   * 返回 `null` 表示"这张图用不了"（文件不存在 / 解码失败 / 没有可用的资源地址），
   * 调用方会回退到颜色 + 字形，并把原因记在控制台。
   */
  loadTerrainImage?: (path: string) => Promise<CanvasImageSource | null>
  /**
   * 图层可见性（用户设置；缺省 = 全部显示）。
   *
   * **六个层都只从这一个口子读**（`grid` 与 `labels` 也一样）：
   * 绘制层不再自己存 `showGrid` / `showShapeLabels` 之类的副本 ——
   * 同一件事存两份，就必然出现"设置里打开、按钮显示关闭"这种没法解释的状态。
   */
  getLayers?: () => LayerVisibility
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
  /** 地形图集对应的"签名"（朝向 + 地形目录 + 已就绪的图片），变了才重建 */
  private atlasSignature = ''
  /** 已加载成功的图片（键 = **图片路径**，不是地形 ID） */
  private readonly terrainImages = new Map<string, CanvasImageSource>()
  /** 加载失败或正在加载的图片路径（避免每帧重复发起） */
  private readonly terrainImageState = new Map<string, 'pending' | 'failed'>()
  /** 已经为哪些未知地形 ID 告警过（每帧都会遇到，不能刷屏） */
  private readonly warnedTerrainIds = new Set<string>()
  /** 图集构建失败只告警一次（失败是持续状态，每帧都报会刷屏） */
  private warnedAtlasFailure = false
  private markerLayer: MarkerLayer | null = null
  private uninstallPatch: (() => void) | null = null

  private frameHandle: number | null = null
  private pendingRedraw = false
  private markerInteractive = false
  private disposed = false
  /** 上一次实测的"位图像素 / 屏幕 CSS 像素"（作为下一帧的初值） */
  private rasterPxPerCssPx: number | null = null

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
        layers: this.layers(),
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
            layers: this.layers(),
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

    // 标记层被图层开关关掉时：连放置计算都不做（省一次遍历），但**保留已建的 DOM** ——
    // 用 display 隐藏而不是 sync([])（后者会把每个标记真的销毁，再打开又要重建）。
    const showMarkers = this.layers().markers !== false
    if (!showMarkers && !this.markerLayer) return

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

    this.markerLayer.setVisible(showMarkers)
    if (!showMarkers) {
      this.stats.lastMarkerCount = 0
      return
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

  /** 当前生效的自定义地形（每帧现读设置，改完设置不必重开画布） */
  private customTerrains(): readonly CustomTerrain[] {
    return this.options.getCustomTerrains?.() ?? []
  }

  /**
   * 当前图层可见性（每帧现读设置）。
   *
   * 与 `customTerrains` / `getLabelScale` 同一套做法：地图层活得比设置页久，
   * 取值必须"每次现读"，否则用户关掉一个图层要重开画布才生效。
   */
  private layers(): LayerVisibility {
    return this.options.getLayers?.() ?? DEFAULT_LAYER_VISIBILITY
  }


  /**
   * 取（必要时重建）地形图集。
   *
   * 三件事必须在**同一个签名**下判断，否则会出现"设置改了但画布没变"或
   * "图片加载好了却一直画回退色"这类只在特定时序下复现的问题：
   * 1. 网格朝向（图集是按朝向光栅化的）；
   * 2. 地形目录内容（用户增删改自定义地形）；
   * 3. 哪些图片已经就绪（异步加载完成时要重建一次，把图贴进去）。
   */
  private atlasFor(document_: MapDocument): TerrainAtlas | null {
    const custom = this.customTerrains()
    this.warnUnknownTerrains(document_, custom)

    // 图集必须覆盖**文档里出现的每一个 ID**，而不只是设置里定义的那些：
    // 未知 ID（别人的库、被删掉的定义）也有回退视觉，漏掉它们的结果是
    // `drawTerrainCell` 找不到精灵、那一格**直接不画** —— 用户看到的是"地图上有个洞"，
    // 而不是"这一格颜色不对"。这正是"未知 t 必须接受并保留"这条承诺的另一半。
    const byId = new Map<string, ResolvedTerrainStyle>()
    for (const style of listResolvedTerrainStyles(custom)) byId.set(style.id, style)
    for (const cell of Object.values(document_.terrain)) {
      if (byId.has(cell.t)) continue
      byId.set(cell.t, resolveTerrainStyle(cell.t, custom))
    }
    const styles = [...byId.values()]

    // 先把"用到图片但这份文件还没加载过"的地形挑出来，异步加载；这一帧仍按颜色 + 字形画。
    //
    // 缓存键是**图片路径**而不是地形 ID：用户把 `custom:reef` 的图片从 A 换成 B 之后，
    // 按 ID 缓存的写法会认为"它已经有图了"，于是永远画着旧的那张（要重开画布才更新）；
    // 按路径缓存则天然正确，而且两个地形共用同一张图时只会加载一次。
    for (const style of styles) {
      if (style.imagePath.length === 0) continue
      // ⚠️ 两个缓存的键必须分清：`terrainImages` 按**路径**存已加载的图（同一张图被两个地形
      // 共用时只加载一次，换图后也能立刻生效），`terrainImageState` 按**路径**记"正在加载/加载失败"。
      // 之前这里一处写成 `style.id`，结果是"图片明明加载好了，图集却永远拿不到它"——
      // 画布上一直显示回退色，而日志里只有一句"图片不可用"。键写错的表现就是这种"静默不生效"。
      if (this.terrainImages.has(style.imagePath)) continue
      if (this.terrainImageState.has(style.imagePath)) continue
      this.terrainImageState.set(style.imagePath, 'pending')
      void this.loadTerrainImage(style.id, style.imagePath)
    }

    // 只把"这份路径已经就绪"的图片交给图集；其余那一格走颜色 + 字形回退。
    // 交给图集时按 **style.id**（`spriteAtlas` 是按地形 ID 取图的），取源图时按 **path**。
    const readyImages = new Map<string, CanvasImageSource>()
    const readyIds: string[] = []
    for (const style of styles) {
      const image = style.imagePath.length > 0 ? this.terrainImages.get(style.imagePath) : undefined
      if (image === undefined) continue
      readyImages.set(style.id, image)
      readyIds.push(style.id)
    }
    const signature = [
      document_.grid.orientation,
      `sprite:${DEFAULT_SPRITE_RADIUS}`,
      terrainCatalogSignature(custom),
      // 文档里出现过的 ID 也要进签名：否则"地图里新出现一个未知地形"时图集不会重建
      `doc:${[...byId.keys()].sort().join(',')}`,
      `images:${readyIds.join(',')}`,
    ].join('|')
    if (this.atlas !== null && this.atlasSignature === signature) return this.atlas

    const options: BuildAtlasOptions = {
      orientation: document_.grid.orientation,
      spriteRadius: DEFAULT_SPRITE_RADIUS,
      styles,
      images: readyImages,
      ...(this.canvasFactory ? { factory: this.canvasFactory } : {}),
    }
    this.atlas = buildTerrainAtlas(options)
    this.atlasSignature = signature
    if (this.atlas === null && !this.warnedAtlasFailure) {
      // 图集建不出来（画布被拒、尺寸超限、没有 2d 上下文）时的表现是"地形全都不见了"，
      // 而屏幕上不会有任何提示。这种静默失败必须留下痕迹，哪怕只有一次。
      this.warnedAtlasFailure = true
      console.warn(
        `[project-kaki] 地形图集创建失败（${styles.length} 种地形）：当前环境可能不允许这么大的画布。` +
          '地形将不会显示；可以试试减少自定义地形数量。',
      )
    }
    return this.atlas
  }

  /**
   * 异步加载一张地形图片，成功后重建图集并请求重绘。
   *
   * 这里**只做调度**，具体怎么从库里取图由注入的加载器决定（渲染层不认识 vault）。
   * 失败一律记在控制台：这个功能最容易坏的方式就是"图没了但界面不说话"。
   */
  private async loadTerrainImage(id: string, path: string): Promise<void> {
    const loader = this.options.loadTerrainImage
    if (!loader) {
      this.terrainImageState.set(path, 'failed')
      console.warn(`[project-kaki] 自定义地形「${id}」配置了图片 ${path}，但当前没有可用的图片加载器，按颜色 + 字形绘制`)
      return
    }
    let image: CanvasImageSource | null = null
    try {
      image = await loader(path)
    } catch (error) {
      console.warn(`[project-kaki] 自定义地形「${id}」的图片加载出错：${path}`, error)
    }
    if (this.disposed) return
    if (image === null || image === undefined) {
      this.terrainImageState.set(path, 'failed')
      console.warn(`[project-kaki] 自定义地形「${id}」的图片不可用：${path} —— 已回退到颜色 + 字形（地图数据不受影响）`)
      return
    }
    this.terrainImageState.set(path, 'pending') // 保持占位，避免同一条路径被重复加载
    this.terrainImages.set(path, image)
    // 图集里这一格还画的是回退色：签名变了（多了一张就绪的图）→ 下一帧重建
    this.atlasSignature = ''
    this.requestRedraw()
  }

  /**
   * 未知地形 ID 的一次性告警。
   *
   * 为什么必须告警而不是静默回退：用户的感受是"我地图上有一部分格子变灰了"，
   * 不告诉他原因，他只会以为插件坏了（或以为自己的颜色设置没生效）。
   * 为什么只报一次：绘制每帧都会遍历所有格，逐格告警会把控制台刷爆。
   */
  private warnUnknownTerrains(document_: MapDocument, custom: readonly CustomTerrain[]): void {
    for (const cell of Object.values(document_.terrain)) {
      if (isBuiltinTerrain(cell.t) || findCustomTerrain(cell.t, custom) !== null) continue
      if (this.warnedTerrainIds.has(cell.t)) continue
      this.warnedTerrainIds.add(cell.t)
      console.warn(
        `[project-kaki] 地图里有未知地形「${cell.t}」：设置里没有这个定义，已按回退样式绘制。` +
          '数据仍保留在文件里；如果你想看到原样，请在设置里补一条同 ID 的自定义地形。',
      )
    }
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

    // 网格与名称都从图层设置读（不再有覆盖层内部的副本）
    this.stats.lastGridCells = isLayerVisible(this.layers(), 'grid') ? this.drawGrid(ctx, plan, document_, targetRadius) : 0

    const showShapeLabels = isLayerVisible(this.layers(), 'labels')
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
