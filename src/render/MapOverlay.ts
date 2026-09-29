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
import type { MapSelection, SelectionKind } from '../editor/selection.ts'
import {
  buildProjection,
  pickWorldHost,
  probeTransformCandidates,
  readScale,
  readViewportRect,
  watchViewportChanges,
  type CanvasHandle,
} from '../canvas/CanvasAdapter.ts'
import { axialToWorld, cellKey, hexCorners, parseCellKey } from '../core/hex.ts'
import type { BBox } from '../core/viewport.ts'
import { brushCellsAt, visibleCellBounds } from './hexGrid.ts'
import { buildRenderPlan, worldToRaster, type MapRenderPlan } from './renderPlan.ts'
import { SELECTION_ACCENT, SELECTION_HIGHLIGHTS } from './selectionHighlight.ts'
import type { CellSelection } from './selectionSet.ts'
import { MarkerLayer } from './MarkerLayer.ts'
import { buildPlacements, type MarkerPlacement } from './markerPlacement.ts'
import { drawDraft, drawPath, drawRegion, labelCssPx } from './shapeDraw.ts'
import { findTerrainRegions, fitContain, hashTerrainCells, type TerrainRegion } from './terrainRegions.ts'
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
import {
  DEFAULT_LAYER_VISIBILITY,
  isLayerVisible,
  LAYERS_BY_DRAW_ORDER,
  type LayerKey,
  type LayerVisibility,
} from './layerVisibility.ts'
import { DEFAULT_OVERLAY_STYLES, overlayField, type FieldId, type OverlayStyles } from './overlayFields.ts'
import { createOverlayFieldCache, type OverlayFieldCache } from './overlayPlan.ts'
import type { MapDraft } from '../editor/MapEditor.ts'

/** 超过这个可见格数就不画网格线（缩小到很远时逐格描边会拖垮帧率） */
const MAX_GRID_CELLS = 4000

/**
 * 一帧最多描多少个"格选择"环。
 *
 * 手一抖框选整张图是完全可能的；宁可少画一部分（统计字段会如实报出画了多少），
 * 也不能让平移/缩放变卡 —— 选择只是"看着方便"，不值得押上帧率。
 */
const MAX_HIGHLIGHT_CELLS = 2000

/** 某个世界坐标附近的格是否落在本帧的栅格里（视野外的格描了也看不见，白花时间） */
function cellVisibleInPlan(plan: MapRenderPlan, x: number, y: number, radius: number): boolean {
  const point = worldToRaster(plan.layer, x, y)
  return (
    point.x + radius >= 0 &&
    point.y + radius >= 0 &&
    point.x - radius <= plan.layer.rasterWidth &&
    point.y - radius <= plan.layer.rasterHeight
  )
}

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
  /**
   * 本帧按"整片一张图"画出来的连通块数量。
   *
   * 为什么要单独统计：这个模式下**正确的表现是"图比格子少"**（一片 N 格只画一张），
   * 而"每格一张"与"整片一张"在屏幕上可能只差一点点。有一个可读的数字，
   * 用户报"看起来没生效"时就能一眼判断是渲染没走通还是观感问题。
   */
  lastImageRegionCount: number
  /**
   * 本帧**在画布上按次序真的画了哪些层**（自下而上）。
   *
   * 为什么要有这个可读字段：绘制次序以前只存在于 `drawPlan` 里几行调用的先后，
   * 改一行没人看得出来（"地形盖住路径"这类回归在截图里也可能看漏）。
   * 现在次序由 `LAYER_TABLE.order` 决定、遍历 `LAYERS_BY_DRAW_ORDER`，这个字段就是
   * "真实渲染确实按表走"的证据：关掉某层，它就不该出现在这一串里。
   */
  lastDrawOrder: LayerKey[]
  /**
   * 本帧数据层（温度 / 深度…）一共画出了多少格，以及其中多少格走了"越界纯色"。
   *
   * 与 `lastGridCells` 同一个理由：**"叠加层没画出来"必须有一个可读的数字**，
   * 否则用户报"我开了温度层但什么都没变"时，只能靠肉眼看截图猜。
   */
  lastOverlayDrawn: number
  lastOverlayOutOfRange: number
  /**
   * 本帧数据层的**显示方式**（`null` = 这一帧没有画数据层）。
   *
   * 为什么要有它：逐格与连续场在屏幕上"都像有颜色"，出问题时不能只靠肉眼判断用了哪一套；
   * 多个数据层同时可见时取**绘制次序靠后**的那一个（确定的取值，不是随机）。
   */
  lastOverlayMode: 'cell' | 'field' | null
  /** 本帧数据层写出的数值文字个数 */
  lastOverlayLabels: number
  /** 本帧数据层画出的等值线折线条数（逐格模式恒为 0） */
  lastOverlayContours: number
  /**
   * 连续场采样缓存的累计计数（按字段求和）。
   *
   * `builds` 只增不减：断言"平移前后各一帧，第二帧没有重新采样"就靠它
   * （第二帧 `builds` 不变、`hits` 增加 —— 见冒烟场景 44）。
   */
  lastOverlayFieldBuilds: number
  lastOverlayFieldHits: number
  /**
   * 最近一帧"可见的世界矩形"（导出范围＝「当前视口」时用它）。
   *
   * 为什么放在统计里而不是让导出侧自己算：视口 → 世界坐标的换算只有覆盖层手里有
   * （锚点投影 + 实测标定），在别处再推一次就又是一份会漂移的实现。
   * 还没画过任何一帧时是 `null`，范围解析会据此给出一句可读原因（而不是导出一张空图）。
   */
  lastVisibleWorld: BBox | null
  markerLayerAttached: boolean
  lastRaster: { width: number; height: number } | null
  /** 实测的"位图像素 / 屏幕 CSS 像素"（名称字号的换算依据，诊断用） */
  rasterPxPerCssPx: number
  /** 当前实际使用的名称字号（屏幕 CSS px） */
  labelCssPx: { path: number; region: number } | null
  lastDurationMs: number
  lastError: string | null
  /**
   * 本帧画出的**选中高亮**是什么（`null` = 没画）。
   *
   * 为什么要一个可读的字段：高亮画没画、画的是哪一类，在截图里都可能看漏
   * （高亮很细、颜色也可能与地图撞色）。有了它就有一条能变红的断言，
   * 而不是"看起来好像有框"。
   */
  lastHighlight: { kind: SelectionKind; id: string } | null
  /**
   * 本帧画出的**格选择**描边环个数（0 = 没画）。
   *
   * 为什么要一个可读的数字：格选择与"对象选中"两个高亮是两套东西，
   * "框选了一片但画面上没看出区别"必须能一眼判定是渲染没画还是观感问题。
   * 超过上限时**只画前 N 格**，这个数字就是"实际画了多少"，不是"选了多少"。
   */
  lastCellHighlight: number
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
  /** 按下标记/文字时先选中它（用户要的「先选中，再决定操作」） */
  onSelect?: (hit: { kind: 'marker' | 'label'; id: string }) => void
  /** 拖动移动的四个阶段（客户端坐标；世界坐标换算由上层负责） */
  onEntityDragStart?: (placement: MarkerPlacement, client: { x: number; y: number }) => void
  onEntityDragMove?: (client: { x: number; y: number }) => void
  onEntityDragEnd?: (client: { x: number; y: number }) => void
  onEntityDragCancel?: () => void
  /** 注入图标可用性校验（测试用；默认用 obsidian 的 getIcon） */
  hasIcon?: (name: string) => boolean
  /**
   * 当前选中项（每帧现读）—— 覆盖层据此画高亮。
   *
   * 高亮画在**覆盖层**上（它常驻 `pointer-events: none`），所以任何高亮都**不会**
   * 影响原生画布的命中测试。这是硬约束：一旦为了让高亮"可点"而打开它的 pointer-events，
   * 整个画布的框选/平移就会失灵。
   */
  getSelection?: () => MapSelection | null
  /**
   * 当前**格选择**（多格；每帧现读）。
   *
   * 与 `getSelection` 分开：那是"侧栏检查器在编辑哪一个对象"（单选，走 `SELECTION_HIGHLIGHTS` 那张表），
   * 这是"我正在看哪些格"（可多格，见施工文件 §C）。**恰好一格时两者重合**，
   * 所以这里刻意跳过那一个，避免同一格被画两遍（描边会叠成一条更粗的线，看起来像"选中程度不同"）。
   */
  getCellSelection?: () => CellSelection
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
   * 库内图片路径 → `<img src>` 地址（自定义标记的图片模式用）。
   *
   * 与 `loadTerrainImage` 同一条铁律的另一半：渲染层不认识 vault，地址从这里注入。
   * 区别是它必须**同步**（DOM 赋值当场要地址），所以取不到时返回 `''`，
   * 由标记层回退成图标字形。缺省时图片模式不生效 —— 只画字形。
   */
  resolveImageSrc?: (path: string) => string
  /**
   * 图层可见性（用户设置；缺省 = 全部显示）。
   *
   * **六个层都只从这一个口子读**（`grid` 与 `labels` 也一样）：
   * 绘制层不再自己存 `showGrid` / `showShapeLabels` 之类的副本 ——
   * 同一件事存两份，就必然出现"设置里打开、按钮显示关闭"这种没法解释的状态。
   */
  getLayers?: () => LayerVisibility
  /**
   * 数据层（温度 / 深度…）的渲染参数（色带 / 不透明度 / 是否画数值）。
   *
   * 与 `getLayers` 同一条口径：**每帧现读**，所以"设置里改了色带"下一帧就是新颜色，
   * 不需要任何广播或失效通知（少一个"忘了通知"的失效点）。
   */
  getOverlayStyles?: () => OverlayStyles
  /**
   * **分类字段**的"分类 ID → 颜色"（每帧现读；只有分类字段用得上）。
   *
   * 与 `getOverlayStyles` 同一条口径：自定义生物群系的颜色住在插件设置里，
   * 所以现读 —— 用户在设置里改一条颜色，下一帧就是新颜色，不需要任何广播。
   * 缺省 = 只用内置目录（绘制层照常画得出东西，只是不含自定义那几条）。
   */
  getCategoryColors?: (fieldId: FieldId) => ReadonlyMap<string, string> | undefined
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

/**
 * 取图片的原始像素尺寸（用于"保持比例"的换算）。
 *
 * 用鸭子类型而不是 `instanceof HTMLImageElement`：图片可能是 `HTMLImageElement`、
 * `HTMLCanvasElement` 或 `ImageBitmap`，三者的尺寸字段名不同；而断言某个具体类会让
 * "换一种图片来源就静默失去比例"（尺寸读成 0 时 `fitContain` 会退化成拉伸铺满）。
 */
export function imagePixelSize(image: unknown): { width: number; height: number } {
  const source = image as { naturalWidth?: unknown; naturalHeight?: unknown; width?: unknown; height?: unknown } | null
  if (source === null || typeof source !== 'object') return { width: 0, height: 0 }
  const width = typeof source.naturalWidth === 'number' ? source.naturalWidth : Number(source.width ?? 0)
  const height = typeof source.naturalHeight === 'number' ? source.naturalHeight : Number(source.height ?? 0)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
  }
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
  /**
   * 「整片一张图」的连通块缓存。
   *
   * 为什么要缓存：连通块要在**每帧**用来绘制，而"每帧重新分组、重建一堆对象"是性能灾难。
   * 缓存键 = 该类型的**可见格数 + 顺序无关的格子哈希**（`hashTerrainCells`）：
   * 便宜、能可靠发现"格子变了"，而哈希碰撞的代价只是"这一帧仍用上一帧的分块"，下一帧自我纠正。
   */
  private terrainRegionCache = new Map<string, { key: string; regions: TerrainRegion[] }>()
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
    lastImageRegionCount: 0,
    lastDrawOrder: [],
    lastOverlayDrawn: 0,
    lastOverlayOutOfRange: 0,
    lastOverlayMode: null,
    lastOverlayLabels: 0,
    lastOverlayContours: 0,
    lastOverlayFieldBuilds: 0,
    lastOverlayFieldHits: 0,
    lastVisibleWorld: null,
    markerLayerAttached: false,
    lastRaster: null,
    rasterPxPerCssPx: 1,
    labelCssPx: null,
    lastDurationMs: 0,
    lastError: null,
    lastHighlight: null,
    lastCellHighlight: 0,
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
    // 采样缓存跟着这一份覆盖层一起结束（重挂载时重新采样一次，比"用着旧图的数据"安全）
    this.overlayFieldCaches.clear()
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
      // 记下这一帧的可见世界矩形：导出范围＝「当前视口」时要用（见 OverlayStats 的说明）
      this.stats.lastVisibleWorld = plan.visibleWorld
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
        ...(this.options.onSelect ? { onSelect: this.options.onSelect } : {}),
        ...(this.options.onEntityDragStart ? { onDragStart: this.options.onEntityDragStart } : {}),
        ...(this.options.onEntityDragMove ? { onDragMove: this.options.onEntityDragMove } : {}),
        ...(this.options.onEntityDragEnd ? { onDragEnd: this.options.onEntityDragEnd } : {}),
        ...(this.options.onEntityDragCancel ? { onDragCancel: this.options.onEntityDragCancel } : {}),
        ...(this.options.hasIcon ? { hasIcon: this.options.hasIcon } : {}),
        ...(this.options.resolveImageSrc ? { resolveImageSrc: this.options.resolveImageSrc } : {}),
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

  /** 当前数据层样式（色带 / 不透明度），与 `layers()` 同一条口径：每帧现读 */
  private overlayStyles(): OverlayStyles {
    return this.options.getOverlayStyles?.() ?? DEFAULT_OVERLAY_STYLES
  }

  /**
   * 连续场采样缓存（**每个数据字段一份**，随本覆盖层实例存活）。
   *
   * 为什么放在这里：缓存必须活得比一帧长，而"哪张画布的哪一层"只有覆盖层知道；
   * 放在 `overlayDraw` 的模块级变量里会让两张画布互相踩（同一字段的数据不同）。
   */
  private readonly overlayFieldCaches = new Map<FieldId, OverlayFieldCache>()

  private fieldCacheFor(field: FieldId): OverlayFieldCache {
    const found = this.overlayFieldCaches.get(field)
    if (found !== undefined) return found
    const created = createOverlayFieldCache()
    this.overlayFieldCaches.set(field, created)
    return created
  }

  /** 所有字段的缓存计数之和（进统计；断言"第二帧没重采样"用它） */
  private fieldCacheCounts(): { builds: number; hits: number } {
    let builds = 0
    let hits = 0
    for (const cache of this.overlayFieldCaches.values()) {
      builds += cache.builds
      hits += cache.hits
    }
    return { builds, hits }
  }

  /**
   * 造一张**离屏画布**（连续场的颜色面用）。
   *
   * 与地形图集同一条路：先问注入的 `canvasFactory`（测试与特殊宿主用），
   * 否则用当前挂载点的 `document` 造一张；两样都拿不到就返回 `null`（连续场退回不画）。
   */
  private createOffscreenCanvas(width: number, height: number): HTMLCanvasElement | null {
    if (this.canvasFactory !== null) return this.canvasFactory(width, height)
    const doc = this.container?.ownerDocument ?? null
    if (doc === null) return null
    const canvas = doc.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
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
      // 没有地形的格（只挂着温度 / 深度这类值）不参与地形图集：它本来就不画地形
      if (typeof cell.t !== 'string') continue
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
    // 整片铺图那边也要重画：刚才这张图之前是不可用的，这一帧起才能画
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
      // 没有地形的格不是"未知地形"：它是"这一格没有地形"，不告警也不回退绘制
      if (typeof cell.t !== 'string') continue
      if (isBuiltinTerrain(cell.t) || findCustomTerrain(cell.t, custom) !== null) continue
      if (this.warnedTerrainIds.has(cell.t)) continue
      this.warnedTerrainIds.add(cell.t)
      console.warn(
        `[project-kaki] 地图里有未知地形「${cell.t}」：设置里没有这个定义，已按回退样式绘制。` +
          '数据仍保留在文件里；如果你想看到原样，请在设置里补一条同 ID 的自定义地形。',
      )
    }
  }

  /**
   * 「整片一张图」：把每种选了 `region` 布局的地形，按**连通块**各画一张图片。
   *
   * 三条实现要点（都是需求里的原话，逐条落实）：
   *
   * 1. **不改变图片比例** —— 用 `fitContain`（等比缩放 + 居中），而不是拉伸铺满包围盒。
   * 2. **超出区域的不渲染** —— 用该连通块**所有六边形的并集**做 `ctx.clip()`，
   *    而不是只按包围盒裁。按包围盒裁的话，一块 L 形的领地会把"拐角外"的图也画出来，
   *    那部分其实是属于别人的地形。
   * 3. **不进图集** —— 图集是"每种地形一格位图"，天生只能逐格贴；整片铺图必须在每帧按块直接画。
   *    代价是一次 `save/clip/drawImage/restore`，而连通块数量远小于格子数。
   *
   * 图片还没加载好（或加载失败）时**什么都不画**：逐格那一遍已经画过颜色 + 字形，
   * 于是"图没就绪"的表现是回退视觉，而不是一片空白。
   */
  private drawRegionImages(
    ctx: CanvasRenderingContext2D,
    plan: MapRenderPlan,
    document_: MapDocument,
    targetRadius: number,
  ): number {
    const custom = this.customTerrains()
    /**
     * 本帧每种 region 布局地形的**全部**格（不是只算可见的）。
     *
     * ⚠️ 这里必须用整个文档的格子：`plan.cells` 是**视口裁剪后**的结果，
     * 拿它做连通块的话，一片跨出视口的区域会被当成"更小的一片"，包围盒跟着视口变 ——
     * 表现就是**平移时整片图片跟着缩放/抖动**。
     * 代价与 `buildRenderPlan` 每帧遍历一次 `document.terrain` 同量级（它本来就要遍历）。
     */
    const cellsByType = new Map<string, Array<{ q: number; r: number }>>()
    for (const [key, cell] of Object.entries(document_.terrain)) {
      // 没有地形的格不参与"整片一张图"的连通块（它没有地形图片要铺）
      if (typeof cell.t !== 'string') continue
      const style = resolveTerrainStyle(cell.t, custom)
      if (style.imageLayout !== 'region' || style.imagePath.length === 0) continue
      const axial = parseCellKey(key)
      if (axial === null) continue
      const list = cellsByType.get(style.id)
      if (list === undefined) cellsByType.set(style.id, [{ q: axial.q, r: axial.r }])
      else list.push({ q: axial.q, r: axial.r })
    }
    if (cellsByType.size === 0) return 0

    // 可见格集合：**裁剪路径**只需要覆盖可见的那部分（视口外的画了也看不见），
    // 但"图片放多大"必须来自整块，见上面的说明。
    const visibleKeys = new Set<string>()
    for (const cell of plan.cells) visibleKeys.add(cellKey(cell.q, cell.r))

    let drawnRegions = 0
    for (const [type, cells] of cellsByType) {
      const style = resolveTerrainStyle(type, custom)
      const image = this.terrainImages.get(style.imagePath)
      if (image === undefined) continue

      // 缓存：格数 + 顺序无关的哈希。碰撞只会让这一帧沿用上一帧的分块，下一帧自我纠正。
      const cacheKey = `${cells.length}|${hashTerrainCells(cells)}`
      const cached = this.terrainRegionCache.get(type)
      const regions =
        cached !== undefined && cached.key === cacheKey
          ? cached.regions
          : findTerrainRegions(cells, document_.grid)
      if (cached === undefined || cached.key !== cacheKey) {
        this.terrainRegionCache.set(type, { key: cacheKey, regions })
      }

      const size = imagePixelSize(image)
      for (const region of regions) {
        if (region.cells.length === 0) continue
        // 只画在视口里有可见格的块（省掉画布外那些块的 clip + drawImage）
        const visibleCells = region.cells.filter((cell) => visibleKeys.has(cellKey(cell.q, cell.r)))
        if (visibleCells.length === 0) continue
        // 世界坐标的包围盒 → 位图坐标（变换是相似变换，所以直接换算两个角即可）
        const topLeft = worldToRaster(plan.layer, region.bounds.minX, region.bounds.minY)
        const bottomRight = worldToRaster(plan.layer, region.bounds.maxX, region.bounds.maxY)
        const target = {
          minX: topLeft.x,
          minY: topLeft.y,
          maxX: bottomRight.x,
          maxY: bottomRight.y,
        }
        const fit = fitContain(target, size.width, size.height)
        if (!(fit.width > 0) || !(fit.height > 0)) continue

        ctx.save()
        ctx.beginPath()
        for (const member of visibleCells) {
          const center = axialToWorld(document_.grid, member.q, member.r)
          const rasterCenter = worldToRaster(plan.layer, center.x, center.y)
          const corners = hexCorners(
            {
              kind: 'hex',
              orientation: document_.grid.orientation,
              size: targetRadius,
              origin: [rasterCenter.x, rasterCenter.y],
            },
            0,
            0,
          )
          corners.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y)
            else ctx.lineTo(point.x, point.y)
          })
          ctx.closePath()
        }
        ctx.clip()
        ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height)
        ctx.restore()
        drawnRegions += 1
      }
    }
    return drawnRegions
  }

  private drawPlan(plan: MapRenderPlan, document_: MapDocument): void {
    const ctx = this.ctx
    if (!ctx) return

    const { layer } = plan
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, layer.rasterWidth, layer.rasterHeight)

    const targetRadius = document_.grid.size * layer.deviceScale

    const atlas = this.atlasFor(document_)
    const layers = this.layers()
    // 名称是**区域的 / 路径的**一遍里的一个标志，不是单独一遍（见 `LAYER_TABLE` 里 labels 那一行）
    const showShapeLabels = isLayerVisible(layers, 'labels')

    /**
     * 四层内置的画布绘制（自下而上）：地形 → 网格线 → 区域 → 路径。
     *
     * 为什么它们不写成 `LAYER_TABLE.draw`：每层的**取数形状**不同（格 / 线 / 多边形），
     * 而这张表是纯数据模块（不 import 绘制实现），把绘制代码塞进去立刻变成环状依赖。
     * 表管"叫什么、默认看不看、谁在谁上面"，这里管"这一层怎么画" —— 次序仍由表决定。
     */
    const builtinPasses: Partial<Record<LayerKey, () => void>> = {
      terrain: () => {
        if (!atlas) return
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
      },
      grid: () => {
        this.stats.lastGridCells = this.drawGrid(ctx, plan, document_, targetRadius)
      },
      regions: () => {
        for (const region of plan.regions) drawRegion(ctx, layer, region, showShapeLabels)
      },
      paths: () => {
        for (const path of plan.paths) drawPath(ctx, layer, path, showShapeLabels)
      },
    }

    // 「整片一张图」的图片画在**逐格地形之上、网格线之下**：
    // 它属于地形这一层（网格线压在它上面才正常，不然整片图会盖住网格）。
    // ⚠️ 它**不随地形开关消失**（既有行为，本次一字未改）：地形隐藏时 `plan.cells` 是空的，
    // 但整片图片仍按自己的连通块绘制。要改这条得先想清楚"关掉地形要不要连整片图一起关"，
    // 那是产品决定，不该在重构绘制次序时顺手改掉。
    this.stats.lastImageRegionCount = this.drawRegionImages(ctx, plan, document_, targetRadius)

    // 图层开关在这一处生效；次序取自表（不在这里另写一遍调用先后）
    // 数量统计**照旧无条件按计划里的条数写**：计划已经按图层过滤过（隐藏的层产出空数组），
    // 所以"关掉区域后 lastRegionCount 是 0"这条既有语义不变，不随重绘次序的重构漂移。
    this.stats.lastRegionCount = plan.regions.length
    this.stats.lastPathCount = plan.paths.length
    const overlayStyles = this.overlayStyles()
    let overlayDrawn = 0
    let overlayOutOfRange = 0
    let overlayLabels = 0
    let overlayContours = 0
    let overlayMode: 'cell' | 'field' | null = null
    const drawn: LayerKey[] = []
    for (const spec of LAYERS_BY_DRAW_ORDER) {
      if (!isLayerVisible(layers, spec.id)) {
        // 隐藏的层不能留下上一帧的统计（否则诊断报告里"网格 12 格"与"网格已关"自相矛盾）
        if (spec.id === 'grid') this.stats.lastGridCells = 0
        continue
      }
      drawn.push(spec.id)
      builtinPasses[spec.id]?.()
      // 数据层：把"画哪个字段 + 用哪套样式"递进钩子（样式每帧现读，改设置下一帧就生效）
      const outcome = spec.draw?.({
        ctx,
        toRaster: (x, y) => worldToRaster(layer, x, y),
        plan,
        document: document_,
        layers,
        ...(spec.overlay
          ? {
              overlay: { spec: overlayField(spec.overlay), style: overlayStyles[spec.overlay] },
              // 连续场的采样缓存按字段各一份（活得比一帧长，所以挂在覆盖层实例上）
              fieldCache: this.fieldCacheFor(spec.overlay),
              // 颜色面要落在自己的一张离屏画布上（绘制层提供造画布的能力，钩子不碰 DOM）
              createCanvas: (width: number, height: number) => this.createOffscreenCanvas(width, height),
              // **分类字段**的"值 → 颜色"要现读目录（自定义生物群系的颜色住在插件设置里）
              categoryColors: this.options.getCategoryColors?.(spec.overlay),
            }
          : {}),
      })
      if (outcome) {
        overlayDrawn += outcome.drawn
        overlayOutOfRange += outcome.outOfRange ?? 0
        overlayLabels += outcome.labels ?? 0
        overlayContours += outcome.contours ?? 0
        if (outcome.mode !== undefined) overlayMode = outcome.mode
      }
    }
    this.stats.lastDrawOrder = drawn
    this.stats.lastOverlayDrawn = overlayDrawn
    this.stats.lastOverlayOutOfRange = overlayOutOfRange
    this.stats.lastOverlayMode = overlayMode
    this.stats.lastOverlayLabels = overlayLabels
    this.stats.lastOverlayContours = overlayContours
    const cacheCounts = this.fieldCacheCounts()
    this.stats.lastOverlayFieldBuilds = cacheCounts.builds
    this.stats.lastOverlayFieldHits = cacheCounts.hits

    const draft = this.options.getDraft?.() ?? null
    if (draft) drawDraft(ctx, layer, draft)

    // 选中高亮画在**最上层**（连草稿预览之上）：用户点了某个对象之后，第一眼要看到"选中了谁"。
    // 统计字段只在真的画了的时候才有值 —— 于是"高亮没画"能被断言抓到，而不是靠肉眼看截图。
    this.stats.lastHighlight = this.drawSelection(ctx, plan, document_, targetRadius)
    // 格选择（多格）画在对象选中之上：框选一片时"哪些格在里面"是当前的主信息
    this.stats.lastCellHighlight = this.drawCellSelection(ctx, plan, document_, targetRadius)

    if (this.hover) this.drawHover(ctx, plan, document_, targetRadius)
  }

  /**
   * 选中高亮：标记画圈、路径/区域画彩色描边、地块描六边形边。
   *
   * 为什么不复用对象自己的颜色：地图上很可能就有一条**同色**的路径，
   * 那样"选中"看起来跟没选一样。这里固定用一组高对比的强调色 + 虚线，
   * 与对象自身样式区分开（也刻意不用主题色变量：覆盖层要在任何主题下都看得清）。
   */
  /**
   * 选中高亮：**按表分派**（一个 kind 一个绘制函数，见 `selectionHighlight.ts`）。
   *
   * 为什么不在这个方法里 `switch`：用户已明确这个项目要长期加新对象种类
   * （"更多层信息"、温度带、深度分层…），绘制是最容易被新种类撑爆的地方。
   * 现在加一种对象只需要在 `SELECTION_HIGHLIGHTS` 里加一行。
   *
   * 返回值仍是"本帧到底画了什么"——`stats.lastHighlight` 据此可被断言（见 OverlayStats）。
   */
  private drawSelection(
    ctx: CanvasRenderingContext2D,
    plan: MapRenderPlan,
    document_: MapDocument,
    targetRadius: number,
  ): { kind: SelectionKind; id: string } | null {
    const selection = this.options.getSelection?.() ?? null
    if (selection === null) return null

    // 对象自身的线宽：路径/区域的高亮要比它略粗，否则细线上的高亮看不见
    const objectWidth =
      selection.kind === 'path'
        ? (plan.paths.find((item) => item.id === selection.id)?.width ?? 0)
        : selection.kind === 'region'
          ? (plan.regions.find((item) => item.id === selection.id)?.borderWidth ?? 0)
          : 0

    ctx.save()
    const drawn = SELECTION_HIGHLIGHTS[selection.kind]({
      ctx,
      plan,
      document: document_,
      id: selection.id,
      targetRadius,
      objectWidth,
    })
    ctx.restore()
    return drawn ? { kind: selection.kind, id: selection.id } : null
  }

  /**
   * 格选择（多格）的描边环：**加法**——每格画一圈，不描外轮廓。
   *
   * 为什么不用"整片外轮廓"：求并集轮廓要一份额外的几何（而且选中不连通时会有多段），
   * 而逐格描边与"单选一格"的观感一致（同一套 `SELECTION_ACCENT`），用户一眼能对上。
   *
   * `MAX_HIGHLIGHT_CELLS` 是防"一帧几万次描边把帧率拖垮"的硬上限：
   * 手一抖框选整张图是完全可能的，宁可少画几十格也不能让平移变卡。
   * 返回值 = **实际画了多少格**（不是选了多少），见 `OverlayStats.lastCellHighlight`。
   */
  private drawCellSelection(
    ctx: CanvasRenderingContext2D,
    plan: MapRenderPlan,
    document_: MapDocument,
    targetRadius: number,
  ): number {
    const selection = this.options.getCellSelection?.() ?? []
    if (selection.length === 0) return 0
    // 恰好一格时它同时是"对象选中"，那一圈已经由 `drawSelection` 画了 —— 跳过，别画两遍
    const skip = this.options.getSelection?.() ?? null
    const skipId = skip !== null && skip.kind === 'cell' ? skip.id : null

    ctx.save()
    ctx.setLineDash([])
    ctx.lineWidth = Math.max(2, targetRadius * 0.09)
    ctx.strokeStyle = SELECTION_ACCENT
    ctx.globalAlpha = 0.9
    let drawn = 0
    for (const key of selection) {
      if (drawn >= MAX_HIGHLIGHT_CELLS) break
      if (key === skipId) continue
      const axial = parseCellKey(key)
      const world = axial === null ? null : axialToWorld(document_.grid, axial.q, axial.r)
      // 不在视野内的格直接跳过：`plan.layer` 外的东西画了也看不见，白描一次
      if (world === null || !cellVisibleInPlan(plan, world.x, world.y, targetRadius)) continue
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
      ctx.stroke()
      drawn += 1
    }
    ctx.restore()
    return drawn
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
