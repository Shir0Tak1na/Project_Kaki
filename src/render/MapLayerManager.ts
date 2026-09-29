/**
 * 地图层管理器：把「哪个 canvas 启用了地图层」与「覆盖层 / 编辑器 / 交互 / 工具条」对应起来。
 *
 * 与存储层分离的原因：覆盖层绑定的是 **WorkspaceLeaf/视图生命周期**，
 * 而存储层关心的是文件。两者寿命不同，混在一起会让"视图关闭但文件还在改"变成悬空引用。
 */

import type { App, TFile } from 'obsidian'
import { Notice } from 'obsidian'
import { activeCanvasHandle, findCanvasHandles, pointerToWorld, type CanvasHandle } from '../canvas/CanvasAdapter.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import type { MapDocumentStore } from '../data/MapDocumentStore.ts'
import { MapEditor, type EditorStatus } from '../editor/MapEditor.ts'
import { MapInteraction } from '../editor/MapInteraction.ts'
import { PlaceMarkerModal, type PlaceMarkerOptions } from '../ui/PlaceMarkerModal.ts'
import { TextPromptModal, type TextPromptOptions } from '../ui/TextPromptModal.ts'
import { MapToolbar } from '../ui/MapToolbar.ts'
import { SelectionCard } from '../ui/SelectionCard.ts'
import { MapOverlay, type OverlayStats } from './MapOverlay.ts'
import { buildLegendEntries, type LegendDeps, type LegendEntry } from './legend.ts'
import {
  DEFAULT_LAYER_VISIBILITY,
  isLayerVisible,
  type LayerKey,
  type LayerVisibility,
} from './layerVisibility.ts'
import { DEFAULT_OVERLAY_STYLES, type OverlayStyles } from './overlayFields.ts'
import { buildPlacements, type MarkerPlacement } from './markerPlacement.ts'
import type { CustomMarker } from './markerCatalog.ts'
import { defaultStylePalette, type StylePalette } from './stylePalette.ts'
import { defaultPathTypeEntries, resolvePathType, type PathTypeEntry } from './pathTypeCatalog.ts'
import {
  defaultRegionTypeEntries,
  regionLabelForColor,
  regionTypeLabelOf,
  type RegionTypeEntry,
} from './regionTypeCatalog.ts'
import { resolveTerrainStyle, type CustomTerrain } from './terrainCatalog.ts'
import { biomeColorMap, resolveBiomeStyle, type CustomBiome } from './biomeCatalog.ts'
import { MapLegend } from '../ui/MapLegend.ts'
import { resolveVaultResourceUrl } from '../base/vaultResource.ts'

export interface LayerStatus {
  canvasPath: string
  mapPath: string | null
  attached: boolean
  reason?: string
  stats?: OverlayStats
  editor?: EditorStatus
}

export interface MapLayerManagerDeps {
  app: App
  store: MapDocumentStore
  canvasFactory?: (width: number, height: number) => HTMLCanvasElement
  /** 注入放置对话框（测试用；默认用真实的 PlaceMarkerModal） */
  placeModalFactory?: (app: App, options: PlaceMarkerOptions) => { open(): void }
  /** 注入命名对话框（测试用；默认用真实的 TextPromptModal） */
  promptModalFactory?: (
    app: App,
    options: TextPromptOptions,
    onSubmit: (value: string | null) => void,
  ) => { open(): void }
  /** 名称字号倍率（用户设置；1 = 默认） */
  getLabelScale?: () => number
  /**
   * 样式调色板（区域颜色 / 名称字体族），来自插件设置。
   *
   * 传函数而不是值：地图层的存活时间远长于设置页，取值必须"每次现读"，
   * 否则用户改完设置要重开画布才生效。
   *
   * ⚠️ 路径样式**不在**这里：它唯一来源是 `getPathTypes`（见下）。
   */
  getStylePalette?: () => StylePalette
  /**
   * 路径类型目录（内置 4 种 + 用户自定义，含全部画法参数），来自插件设置。
   *
   * 与 `getStylePalette` 同理传函数：用户改完线宽/颜色/端点后，画布与工具条要立刻跟上。
   */
  getPathTypes?: () => readonly PathTypeEntry[]
  /**
   * 区域类型目录（内置 6 种 + 用户自定义，含填充/不透明度/边框参数），来自插件设置。
   *
   * 与 `getPathTypes` 逐字同理：区域样式的唯一来源，用户改完设置后画布、工具条、
   * 图例要立刻跟上。
   */
  getRegionTypes?: () => readonly RegionTypeEntry[]
  /**
   * 用户自定义地形（来自插件设置）。
   *
   * 与 `getStylePalette` 同理传函数：地图层活得比设置页久，必须"每次现读"，
   * 否则用户新增一个地形后要重开画布才看得到。
   */
  getCustomTerrains?: () => readonly CustomTerrain[]
  /**
   * 用户自定义标记图标（来自插件设置）。
   *
   * 与 `getCustomTerrains` 逐字同理：地图层活得比设置页久，必须"每次现读"，
   * 否则用户新增一个标记图标后要重开画布才看得到。
   */
  getCustomMarkers?: () => readonly CustomMarker[]
  /**
   * 用户自定义**生物群系**（来自插件设置）。
   *
   * 与 `getCustomTerrains` 逐字同理：目录活得比设置页久，必须"每次现读"。
   * 它只影响**颜色解析**（分类字段的逐格上色与图例）—— 值本身永远在地图文件里。
   */
  getCustomBiomes?: () => readonly CustomBiome[]
  /**
   * 请求打开「按规则筛选选择…」对话框。
   *
   * 为什么从这里往外传：对话框住在插件层（`main.ts`），而按钮长在画布上的工具条里 ——
   * 地图层不认识插件，插件的对话框也不该认识工具条。缺省 = 按钮点了没反应，
   * 所以 `main.ts` **必须**接上（与 `onToggleLabels` 那条"必需而非可选"的理由不同：
   * 这里工具条本身是可选组件，缺省时不渲染那个按钮更合适 —— 见 `MapToolbar`）。
   */
  onOpenSelectionFilter?: () => void
  /**
   * 选中项发生变化（侧栏检查器据此重绘）。
   *
   * 由插件层提供（面板是 `ItemView`，这一层不认识它）—— 与 `getActions` 同一思路：
   * 地图层只负责"发生了什么"，"界面怎么改"归外层。
   */
  onSelectionChanged?: () => void
  /**
   * 图层可见性（来自插件设置）。
   *
   * 同样传函数：图层开关会被用户在设置页或工具条上随手改，必须"每次现读"，
   * 否则要让用户重开画布才生效。
   */
  getLayers?: () => LayerVisibility
  /**
   * 数据层（温度 / 深度…）的渲染参数（色带 / 不透明度）。
   *
   * 与 `getLayers` 同样是"每帧现读"的函数：色带是可随时调的旋钮，
   * 传值会让"改完设置画布不变"变成一类要靠重开画布才能绕过的怪现象。
   */
  getOverlayStyles?: () => OverlayStyles
  /** 图例是否显示（来自插件设置；默认关着，图例不该默认占画布） */
  getShowLegend?: () => boolean
  /**
   * 写回图层开关（由插件实现：同步改内存 + 落盘 + 广播）。
   *
   * 工具条上的「名称」按钮走这个口子 —— 图层是持久化设置，
   * 工具条只是它的一个入口，不能让按钮自己留一份状态。
   */
  setLayerVisible?: (key: LayerKey, value: boolean) => void
  /** 写回图例显示开关（同上） */
  setShowLegend?: (value: boolean) => void
}

interface LayerEntry {
  canvasPath: string
  mapPath: string
  /** 地图名（写回文件时用，取文件名去后缀） */
  name: string
  /** 该地图绑定的 canvas 列表：以文件 frontmatter 为准，避免写回时丢绑定 */
  canvases: string[]
  document: MapDocument
  overlay: MapOverlay
  editor: MapEditor
  interaction: MapInteraction
  toolbar: MapToolbar | null
  /** 画布上的图例面板（挂在同样的 wrapperEl 上）；创建失败为 null，不影响地图层 */
  legend: MapLegend | null
  /**
   * 画布上的**选择信息卡**（右上角，施工文件 §C.4）。
   *
   * 与工具条同一条挂载策略（挂在未变换的 `wrapperEl` 上），但**职责不同**：
   * 工具条只显示状态与工具，只读的详情一律在卡片里 —— 于是侧栏那一栏可以专心做编辑。
   */
  selectionCard: SelectionCard | null
}

function asElement(value: unknown): HTMLElement | null {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record !== 'object') return null
  return typeof record.appendChild === 'function' ? (value as HTMLElement) : null
}

/** 标记层给的是客户端坐标；`posFromEvt` 需要的是一个带 clientX/clientY 的事件 */
function clientToMouseEvent(client: { x: number; y: number }): MouseEvent {
  if (typeof MouseEvent === 'function') {
    return new MouseEvent('mousemove', { clientX: client.x, clientY: client.y, bubbles: false })
  }
  return { clientX: client.x, clientY: client.y } as unknown as MouseEvent
}

export class MapLayerManager {
  private readonly deps: MapLayerManagerDeps
  private readonly entries = new Map<string, LayerEntry>()
  private readonly enabled = new Set<string>()
  /**
   * 最近一次交互过的 canvas（检查器的兜底依据，见 `getInspectorEditor`）。
   *
   * 为什么需要它：点侧栏会把活动叶子换成面板，这时只有「上一次点过哪张画布」
   * 能告诉我们检查器该显示谁的选中项。
   */
  private lastInspectorPath: string | null = null
  constructor(deps: MapLayerManagerDeps) {
    this.deps = deps
  }

  isEnabled(canvasPath: string): boolean {
    return this.enabled.has(canvasPath)
  }

  listStatus(): LayerStatus[] {
    const out: LayerStatus[] = []
    for (const canvasPath of this.enabled) {
      const entry = this.entries.get(canvasPath)
      out.push({
        canvasPath,
        mapPath: entry?.mapPath ?? this.deps.store.mapFilePathForCanvas(canvasPath),
        attached: entry?.overlay.isAttached() ?? false,
        ...(entry ? { stats: entry.overlay.getStats(), editor: entry.editor.getStatus() } : {}),
      })
    }
    return out
  }

  getEditor(canvasPath: string): MapEditor | null {
    return this.entries.get(canvasPath)?.editor ?? null
  }

  /**
   * 某个编辑器属于哪张画布（`getInspectorEditor()` 的配套）。
   *
   * 侧栏的「移到视口中心」需要"这个选中项所在画布的可见世界矩形"，
   * 而那个矩形来自 `listStatus()`（按 canvasPath 索引）—— 所以必须先把编辑器映射回画布。
   * 不这么做的话，同时开两张画布时会把对象移到**另一张**画布的中心。
   */
  canvasPathOfEditor(editor: MapEditor | null): string | null {
    if (editor === null) return null
    for (const [canvasPath, entry] of this.entries) {
      if (entry.editor === editor) return canvasPath
    }
    return null
  }

  /** 当前覆盖层持有的地图文档（诊断与测试用） */
  getDocument(canvasPath: string): MapDocument | null {
    return this.entries.get(canvasPath)?.document ?? null
  }

  getActiveEditor(): MapEditor | null {
    const canvasPath = activeCanvasHandle(this.deps.app)?.file?.path
    return canvasPath ? this.getEditor(canvasPath) : null
  }

  /**
   * 活动画布当前持有的地图文档（`null` = 没启用 / 没绑定）。
   *
   * 「设置海拔标定…」这类**地图级元数据**的命令要读它来做回显（当前最深 / 最高是多少）。
   * 与 `getDocument(canvasPath)` 的差别只是"哪一张画布"：这里取活动的那一张。
   */
  getActiveDocument(): MapDocument | null {
    const canvasPath = activeCanvasHandle(this.deps.app)?.file?.path
    return canvasPath ? this.getDocument(canvasPath) : null
  }

  /**
   * 侧栏检查器该看哪个地图层的选中项。
   *
   * 与 `getActiveEditor()` 的差别只有一处：**优先挑「真的有选中项」的那一个**，再退回
   * 最近交互过的、最后才退回活动画布。
   *
   * 为什么需要这一点：`activeCanvasHandle()` 在没有任何 canvas 活动时会**退回 `handles[0]`**
   * —— 同时开着两张画布时，用户在第一张上点了对象、然后去点侧栏输入框，
   * `getActiveEditor()` 有可能给出另一张（没有选中）的编辑器，检查器就显示"没有选中"，
   * 而用户的选中其实还在。
   *
   * ⚠️ 诚实的边界：这一条**在冒烟里证不出来**（桩环境只有一张画布，两条实现结果相同；
   * 把它改回 `getActiveEditor()` 一条断言都不会红 —— 见工程笔记"没红也是一种结果"）。
   * 保留它是因为它在多画布下严格更合理，而不是因为某条断言钉住了它。
   */
  getInspectorEditor(): MapEditor | null {
    const activePath = activeCanvasHandle(this.deps.app)?.file?.path
    if (activePath !== undefined && activePath !== null) {
      const entry = this.entries.get(activePath)
      if (entry) return entry.editor
    }
    for (const path of this.enabled) {
      const entry = this.entries.get(path)
      if (entry && entry.editor.getSelection() !== null) return entry.editor
    }
    const last = this.lastInspectorPath === null ? undefined : this.entries.get(this.lastInspectorPath)
    return last?.editor ?? null
  }

  /** 切换当前活动 canvas 的绘制/选择模式 */
  toggleEditMode(): { ok: boolean; mode?: 'select' | 'paint'; reason?: string } {
    const canvasPath = activeCanvasHandle(this.deps.app)?.file?.path
    const entry = canvasPath ? this.entries.get(canvasPath) : undefined
    if (!entry) return { ok: false, reason: '当前 Canvas 未启用地图层' }
    const mode = entry.editor.toggleMode()
    entry.interaction.notifyModeChanged(mode)
    entry.toolbar?.refresh()
    return { ok: true, mode }
  }

  /** 打开标记指向的笔记（相对地图文件解析路径） */
  private openNote(link: string, mapPath: string): void {
    try {
      void this.deps.app.workspace.openLinkText(link, mapPath, false)
    } catch (error) {
      console.error('[project-kaki] 打开笔记失败', error)
      new Notice(`无法打开笔记：${link}`, 6000)
    }
  }

  /** 右键删除标记 / 文字标注（可 Ctrl+Z 撤销） */
  private deletePlacement(canvasPath: string, placement: MarkerPlacement): void {
    const entry = this.entries.get(canvasPath)
    if (!entry) return
    const removed =
      placement.kind === 'marker' ? entry.editor.removeMarker(placement.id) : entry.editor.removeLabel(placement.id)
    if (removed) new Notice(`已删除「${placement.label}」（Ctrl/Cmd+Z 可撤销）`, 5000)
  }

  /** 打开命名对话框（测试可注入工厂，避免弹真实 Modal） */
  private openNameModal(options: TextPromptOptions, onSubmit: (value: string | null) => void): void {
    const factory =
      this.deps.promptModalFactory ??
      ((app: App, opts: TextPromptOptions, callback: (value: string | null) => void) =>
        new TextPromptModal(app, opts, callback))
    factory(this.deps.app, options, onSubmit).open()
  }

  /**
   * 命名 / 重命名路径与区域。
   *
   * 两种入口共用一套逻辑，只有文案与"留空"的含义不同：
   * - 刚画完（create）：形状已经提交，弹框只是顺手命名。留空 = 暂时没有名字，**不删形状**。
   * - 双击（rename）：留空 = 清除名称。
   * 这两条都保持"撤销可以回退"——命名走的是 renamePath/renameRegion 操作。
   */
  private promptShapeName(
    canvasPath: string,
    hit: { kind: 'path' | 'region'; id: string },
    mode: 'create' | 'rename',
  ): void {
    const entry = this.entries.get(canvasPath)
    if (!entry) return
    const kindLabel = hit.kind === 'path' ? '路径' : '区域'
    const current = entry.editor.getShapeLabel(hit)
    this.openNameModal(
      {
        title: `${mode === 'create' ? '命名' : '重命名'}${kindLabel}`,
        description:
          mode === 'create'
            ? `${kindLabel}已创建，名称显示在${hit.kind === 'path' ? '线条中点' : '区域中心'}；留空则暂不命名（之后双击仍可命名）。`
            : '留空将清除名称。',
        placeholder: hit.kind === 'path' ? '例如：北境商路' : '例如：北境领',
        initialValue: current,
        cta: mode === 'create' ? '命名' : '保存',
        allowEmpty: true,
        fieldName: '名称',
      },
      (value) => {
        // 对话框是异步的：期间视图可能已关闭（条目被移除），必须重新取一次
        const target = this.entries.get(canvasPath)
        if (!target) return
        const label = value ?? ''
        // 重命名场景里"本来就空、提交还是空"不算一次编辑，避免产生空历史
        if (mode === 'rename' && label === current) return
        if (mode === 'create' && label.length === 0) {
          new Notice(`${kindLabel}已创建（未命名，双击可命名）`, 4000)
          if (hit.kind === 'path') this.promptPathLink(canvasPath, hit.id)
          return
        }
        const ok =
          hit.kind === 'path' ? target.editor.renamePath(hit.id, label) : target.editor.renameRegion(hit.id, label)
        if (!ok) return
        if (label.length > 0) new Notice(`已命名${kindLabel}「${label}」（Ctrl/Cmd+Z 可撤销）`, 4000)
        else new Notice(`已清除${kindLabel}名称`, 3000)
        if (hit.kind === 'path') this.promptPathLink(canvasPath, hit.id)
      },
    )
  }

  private promptPathLink(canvasPath: string, id: string): void {
    const entry = this.entries.get(canvasPath)
    if (!entry) return
    const current = entry.editor.getPathLink(id)
    this.openNameModal(
      {
        title: '关联路径笔记',
        description: '可选：填写笔记路径；留空则清除路径链接或跳过。',
        placeholder: '例如：Routes/北境商路.md',
        initialValue: current,
        cta: '保存链接',
        allowEmpty: true,
        fieldName: '笔记路径',
      },
      (value) => {
        const target = this.entries.get(canvasPath)
        if (!target) return
        const link = value ?? ''
        if (link === current) return
        if (target.editor.setPathLink(id, link)) {
          new Notice(link.length > 0 ? '已设置路径关联笔记' : '已清除路径关联笔记', 3000)
        }
      },
    )
  }

  /**
   * 让活跃 canvas 的按键作用域位于栈顶。
   *
   * Obsidian 的作用域栈是后进先出：只有位于栈顶时 `Mod+Z` 等才会先到我们手里。
   * canvas 成为活动视图时把它移到栈顶；反之弹出，把按键让给当前获得焦点的编辑器
   * （在编辑器里按 Ctrl+Z 撤销文本才是用户预期）。
   */
  syncKeyScope(): void {
    const activePath = activeCanvasHandle(this.deps.app)?.file?.path ?? null
    for (const [canvasPath, entry] of this.entries) {
      if (canvasPath === activePath) entry.interaction.bringScopeToFront()
      else entry.interaction.detachScope()
    }
  }

  // ------------------------------------------------------------ 启用 / 停用

  async enableForActiveCanvas(): Promise<LayerStatus> {
    const handle = activeCanvasHandle(this.deps.app)
    if (!handle?.file) {
      return { canvasPath: '', mapPath: null, attached: false, reason: '没有已加载的 Canvas 视图' }
    }
    return this.enable(handle)
  }

  async enable(handle: CanvasHandle): Promise<LayerStatus> {
    const canvasPath = handle.file?.path ?? ''
    if (canvasPath.length === 0) {
      return { canvasPath, mapPath: null, attached: false, reason: '当前 Canvas 没有文件路径' }
    }

    const mapPath = this.deps.store.mapFilePathForCanvas(canvasPath)
    if (mapPath === null) {
      return { canvasPath, mapPath: null, attached: false, reason: '当前 Canvas 尚未绑定地图文档' }
    }

    const loaded = await this.loadMap(mapPath)
    if (!loaded) {
      return { canvasPath, mapPath, attached: false, reason: `无法加载地图文档：${mapPath}` }
    }

    this.detachEntry(canvasPath)
    this.enabled.add(canvasPath)
    this.lastInspectorPath = canvasPath

    const overlay = new MapOverlay({
      handle,
      getDocument: () => this.entries.get(canvasPath)?.document ?? null,
      ...(this.deps.canvasFactory ? { canvasFactory: this.deps.canvasFactory } : {}),
      // 标记层挂在未变换的 wrapperEl 上：屏幕坐标、字号恒定、可 hover/点击
      getMarkerHost: () => asElement((handle.canvas as { wrapperEl?: unknown }).wrapperEl),
      getPlacements: (document_, projection, viewportRect) =>
        buildPlacements({
          document: document_,
          projection,
          viewportRect,
          // 自定义标记同样每帧现读：设置里删掉一个定义之后，画布下个重绘帧就会回退字形
          customMarkers: this.deps.getCustomMarkers?.() ?? [],
        }),
      // 进行中的路径/区域草稿：与地形同帧绘制（橡皮筋要每帧跟随光标）
      getDraft: () => this.entries.get(canvasPath)?.editor.getDraft() ?? null,
      // 名称字号倍率：来自插件设置
      getLabelScale: () => this.deps.getLabelScale?.() ?? 1,
      // 图层可见性（含 grid 与 labels）：六个层唯一的入口，每帧现读
      getLayers: () => this.layersVisibility(),
      // 数据层的色带 / 不透明度：同样每帧现读（改设置下一帧就是新颜色）
      getOverlayStyles: () => this.deps.getOverlayStyles?.() ?? DEFAULT_OVERLAY_STYLES,
      // **分类字段**的"值 → 颜色"：现读分类目录（内置 34 条 + 用户自定义）。
      // 与色带同一条口径：改一条颜色，下一帧就是新颜色（没有第二份缓存要失效）。
      getCategoryColors: (fieldId) =>
        fieldId === 'biome' ? biomeColorMap(this.deps.getCustomBiomes?.() ?? []) : undefined,
      // 名称字体族：来自插件设置（空串 = 跟随主题）
      getLabelFontFamily: () => this.deps.getStylePalette?.().fontFamily ?? '',
      // 自定义地形：目录与图片加载都从这里注入（渲染层不认识 vault）
      getCustomTerrains: () => this.deps.getCustomTerrains?.() ?? [],
      // 标记图片走 `<img src>`（不是 canvas），所以这里交出一个**同步**的地址解析器
      resolveImageSrc: (path) => this.resourceUrlFor(path),
      loadTerrainImage: (path) => this.loadTerrainImage(path),
      onOpenLink: (link) => this.openNote(link, mapPath),
      onDeleteMarker: (placement) => this.deletePlacement(canvasPath, placement),
      // 按下标记/文字就先选中它（用户要的"先选中，再决定操作"）
      onSelect: (hit) => {
        this.lastInspectorPath = canvasPath
        const entry = this.entries.get(canvasPath)
        entry?.editor.setSelection({ kind: hit.kind, id: hit.id })
        // 点了标记/名称 = 选中"那一个对象"，格选择随之清空（否则信息卡会同时显示两边）
        entry?.editor.clearCellSelection()
      },
      // 高亮每帧现读：选中变化时编辑器会请求重绘
      getSelection: () => this.entries.get(canvasPath)?.editor.getSelection() ?? null,
      // 格选择（多格）同样每帧现读：框选拖动中要跟着手指实时变
      getCellSelection: () => this.entries.get(canvasPath)?.editor.getCellSelection() ?? [],
      // 拖动移动：客户端坐标 → 世界坐标的换算只在这里做（标记层不认识画布内部坐标系）
      onEntityDragStart: (placement: MarkerPlacement) => {
        const editor = this.entries.get(canvasPath)?.editor
        editor?.beginMove(placement.kind, placement.id)
      },
      onEntityDragMove: (client) => {
        const entry = this.entries.get(canvasPath)
        if (!entry) return
        const world = pointerToWorld(handle.canvas, clientToMouseEvent(client))
        if (world) entry.editor.updateMove(world.point)
      },
      onEntityDragEnd: (client) => {
        const entry = this.entries.get(canvasPath)
        if (!entry) return
        const world = pointerToWorld(handle.canvas, clientToMouseEvent(client))
        if (world) entry.editor.updateMove(world.point)
        if (entry.editor.endMove()) new Notice('已移动（Ctrl/Cmd+Z 可撤销）', 3000)
      },
      onEntityDragCancel: () => {
        this.entries.get(canvasPath)?.editor.cancelMove()
      },
    })

    const editor = new MapEditor({
      getDocument: () => this.entries.get(canvasPath)?.document ?? null,
      onChanged: () => overlay.requestRedraw(),
      onSaveRequested: () => this.scheduleSave(canvasPath),
      // 新画的路径取当前路径类型目录里的画法参数、新画的区域取当前区域类型目录里的参数。
      // 两个都必须是"现读"：已画好的对象用文件里存的值，不受设置影响。
      getPalette: () => this.deps.getStylePalette?.() ?? defaultStylePalette(),
      getPathTypes: () => this.deps.getPathTypes?.() ?? defaultPathTypeEntries(),
      getRegionTypes: () => this.deps.getRegionTypes?.() ?? defaultRegionTypeEntries(),
      // 检查器要显示人话名称（"标记 · 港口"而不是 `custom:port`），所以目录也要进来
      getCustomTerrains: () => this.deps.getCustomTerrains?.() ?? [],
      getCustomMarkers: () => this.deps.getCustomMarkers?.() ?? [],
      onSelectionChanged: () => {
        this.lastInspectorPath = canvasPath
        overlay.requestRedraw()
        // 右上角的信息卡与侧栏检查器都要跟着变（两处读的是同一份选中状态）
        this.entries.get(canvasPath)?.selectionCard?.refresh()
        this.deps.onSelectionChanged?.()
      },
      onStateChanged: () => {
        // 单一收口点：任何模式/工具变化都会经过这里，
        // 因此标记层的交互开关放在这里最稳（不依赖调用方是否走了交互层）
        overlay.setMarkerInteractive(editor.mode === 'select')
        const entry = this.entries.get(canvasPath)
        entry?.toolbar?.refresh()
        entry?.selectionCard?.refresh()
      },
    })

    // 工具条先声明：交互层的模式回调要刷新它（闭包在初始化之后才会被调用）
    let toolbar: MapToolbar | null = null
    // 信息卡同理：交互层的 `getUiExclusions` 与模式回调都会用到它
    let selectionCard: SelectionCard | null = null

    const interaction = new MapInteraction({
      app: this.deps.app,
      handle,
      editor,
      // 捕获阶段监听宿主：越靠上越能保证先于 Obsidian 的处理。
      // 视图容器包含 wrapperEl 与 canvas 元素，是最合适的一层。
      getHost: () =>
        asElement((handle.view as { containerEl?: unknown }).containerEl) ??
        asElement((handle.canvas as { wrapperEl?: unknown }).wrapperEl),
      // 工具条也在同一个视图容器里：必须排除，否则它的点击会被捕获阶段吃掉。
      // 标记层容器同理：**标记 / 名称元素上的左键必须留给标记层自己**
      // （打开笔记、拖动移动），我们不能在捕获阶段把它吞掉 —— 那会让"点标记"彻底失灵。
      getUiExclusions: () => [
        toolbar?.getElement() ?? null,
        overlay.getMarkerLayer()?.getElement() ?? null,
        // 信息卡也在同一个视图容器里，而且**是可点的**（"清空选择"按钮）：
        // 不排除的话，捕获阶段的 stopImmediatePropagation 会把那一击吃掉
        selectionCard?.getElement() ?? null,
      ],
      onHover: (hover) => overlay.setHover(hover),
      onModeChanged: (mode) => {
        // 覆盖层始终 pointer-events: none（只负责画）；模式只影响交互层、标记层与工具条
        toolbar?.refresh()
        // 选择模式下标记可点（打开笔记）；绘制模式下让位给放置/绘制手势
        overlay.setMarkerInteractive(mode === 'select')
      },
      onPlaceRequest: (tool, world) => {
        const options: PlaceMarkerOptions = {
          kind: tool,
          initialIcon: editor.markerIcon,
          // 打开对话框时现读自定义标记：自动测试注入的替身对话框不关心它，
          // 而真实对话框要在下拉里列出用户自己定义的图标
          getCustomMarkers: () => this.deps.getCustomMarkers?.() ?? [],
          onSubmit: (input) => {
            if (tool === 'marker') {
              editor.setMarkerIcon(input.icon)
              const id = editor.addMarkerAt(world, {
                label: input.label,
                icon: input.icon,
                ...(input.link.length > 0 ? { link: input.link } : {}),
              })
              if (id) new Notice(`已放置标记「${input.label}」`, 4000)
            } else {
              const id = editor.addLabelAt(world, {
                text: input.label,
                ...(input.link.length > 0 ? { link: input.link } : {}),
              })
              if (id) new Notice(`已添加文字「${input.label}」`, 4000)
            }
          },
        }
        const factory = this.deps.placeModalFactory ?? ((app: App, opts: PlaceMarkerOptions) => new PlaceMarkerModal(app, opts))
        factory(this.deps.app, options).open()
      },
      onShapeDeleted: (hit) => {
        new Notice(`已删除${hit.kind === 'path' ? '路径' : '区域'}（Ctrl/Cmd+Z 可撤销）`, 4000)
      },
      onShapeCreated: (hit) => this.promptShapeName(canvasPath, hit, 'create'),
      onShapeRenameRequest: (hit) => this.promptShapeName(canvasPath, hit, 'rename'),
    })

    // 工具条挂在未变换的 wrapperEl 上：这样它不随画布缩放，按钮尺寸恒定。
    // 工具条是"锦上添花"的部件，创建失败不应连带地图层一起失败 —— 因此包一层。
    const toolbarHost = asElement((handle.canvas as { wrapperEl?: unknown }).wrapperEl)
    if (toolbarHost) {
      try {
        toolbar = new MapToolbar(toolbarHost, {
          editor,
          getPalette: () => {
            const palette = this.deps.getStylePalette?.() ?? defaultStylePalette()
            return { regionColors: palette.regionColors }
          },
          getPathTypes: () => this.deps.getPathTypes?.() ?? defaultPathTypeEntries(),
          getRegionTypes: () => this.deps.getRegionTypes?.() ?? defaultRegionTypeEntries(),
          getCustomTerrains: () => this.deps.getCustomTerrains?.() ?? [],
          getCustomMarkers: () => this.deps.getCustomMarkers?.() ?? [],
          // 笔刷那一节的"设为哪个群系"下拉要列全目录（内置 + 自定义），同样现读
          getCustomBiomes: () => this.deps.getCustomBiomes?.() ?? [],
          resolveImageSrc: (path) => this.resourceUrlFor(path),
          // 「名称」按钮写图层设置（同一个值）：编辑器里**没有**第二份名称开关，
          // 所以不存在"设置里打开、按钮显示关闭"这种状态
          getShowShapeLabels: () => isLayerVisible(this.layersVisibility(), 'labels'),
          onToggleLabels: () => {
            this.deps.setLayerVisible?.('labels', !isLayerVisible(this.layersVisibility(), 'labels'))
          },
          getShowLegend: () => this.deps.getShowLegend?.() ?? false,
          onToggleLegend: () => {
            this.deps.setShowLegend?.(!(this.deps.getShowLegend?.() ?? false))
          },
          onModeChanged: (mode) => interaction.notifyModeChanged(mode),
          // 工具条上那个「地图层」按钮已删掉（用户反馈"不知道是干什么的"，且与面板里的
          // 「启用/停用当前 Canvas 的地图层」重复）。停用地图层现在的入口是：侧栏地图面板
          // （常驻，关掉之后仍然在）与命令面板 —— 这一条很关键：**关掉地图层不能让自己失去入口**，
          // 而画布上的按钮会随地图层一起消失，所以它本来就不适合承担这个职责。
          onUndo: () => {
            editor.undo()
          },
          onRedo: () => {
            editor.redo()
          },
          // 只有插件层接上了才渲染那个按钮（缺省 = 这个按钮不出现，而不是"点了没反应"）
          onOpenSelectionFilter: this.deps.onOpenSelectionFilter,
        })
      } catch (error) {
        console.warn('[project-kaki] 工具条创建失败，地图层继续但不带工具条', error)
        toolbar = null
      }
    }

    // 选择信息卡：同一层（未变换的 wrapperEl），失败也不该连带整个地图层失败。
    // 它只读、不改数据；"清空选择"是唯一动作，而且与 Esc 的第一步走同一条路。
    if (toolbarHost) {
      try {
        selectionCard = new SelectionCard(toolbarHost, {
          editor,
          getDocument: () => this.entries.get(canvasPath)?.document ?? null,
          getOverlayStyles: () => this.deps.getOverlayStyles?.() ?? DEFAULT_OVERLAY_STYLES,
          terrainLabel: (id) => resolveTerrainStyle(id, this.deps.getCustomTerrains?.() ?? []).label,
          // 生物群系同样按**现读的目录**解析：认不出的 ID 回退成 ID 本身（§5.11），
          // 于是信息卡里"这格到底是什么"与画布上的颜色、图例里的那一行是同一份答案
          biomeLabel: (id) => resolveBiomeStyle(id, this.deps.getCustomBiomes?.() ?? []).label,
          onClear: () => {
            editor.clearAllSelection()
          },
        })
      } catch (error) {
        console.warn('[project-kaki] 选择信息卡创建失败，地图层继续但不带它', error)
        selectionCard = null
      }
    }

    const entry: LayerEntry = {
      canvasPath,
      mapPath,
      name: loaded.name,
      canvases: loaded.canvases,
      document: loaded.document,
      overlay,
      editor,
      interaction,
      toolbar,
      legend: null,
      selectionCard,
    }
    // 先登记再挂载：getDocument 依赖 entries 里已有本条目
    this.entries.set(canvasPath, entry)

    const result = overlay.attach()
    if (!result.ok) {
      toolbar?.destroy()
      selectionCard?.destroy()
      this.entries.delete(canvasPath)
      return { canvasPath, mapPath, attached: false, reason: result.reason }
    }

    // 图例挂在未变换的 wrapperEl 上（和工具条同一层）。
    // 同样包一层 try：图例是锦上添花，失败了不该连带整个地图层失败。
    if (toolbarHost) {
      try {
        entry.legend = new MapLegend(toolbarHost, { getVisible: () => this.deps.getShowLegend?.() ?? false })
        entry.legend.syncVisibility()
        this.refreshLegend(entry)
      } catch (error) {
        console.warn('[project-kaki] 图例创建失败，地图层继续但不带图例', error)
        entry.legend = null
      }
    }

    interaction.attach()
    interaction.notifyModeChanged(editor.mode)


    return {
      canvasPath,
      mapPath,
      attached: true,
      stats: overlay.getStats(),
      editor: editor.getStatus(),
    }
  }

  disable(canvasPath: string): void {
    this.detachEntry(canvasPath)
    this.enabled.delete(canvasPath)
  }

  /** 当前图层设置（每帧现读；缺省即全部显示） */
  private layersVisibility(): LayerVisibility {
    return this.deps.getLayers?.() ?? DEFAULT_LAYER_VISIBILITY
  }

  /**
   * 图层开关变化后的统一广播（设置页、工具条都走这里）。
   *
   * 为什么值不从这里传进去：图层由插件设置持有、绘制层每帧现读（`getLayers`），
   * 所以这里只需要"把每帧都会重新读的东西推一把"：
   * 工具条刷新（按钮高亮读设置）、图例同步显隐、重算条目、再请求一帧重绘。
   *
   * 刻意**没有**"把图层值写进编辑器/覆盖层"这一步 —— 那会造出第二份状态，
   * 而"同一件事存两份"必然出现互相矛盾的状态（本项目最怕的那类缺陷）。
   */
  setLayers(): void {
    for (const entry of this.entries.values()) {
      entry.toolbar?.refresh()
      entry.legend?.syncVisibility()
      this.refreshLegend(entry)
      entry.overlay.requestRedraw()
    }
  }

  /**
   * 地形图片加载器 —— **全项目唯一允许用 vault 取图片资源的地方**。
   *
   * 渲染层（`MapOverlay` / `spriteAtlas`）刻意不认识 vault，图片从这个口子注入，
   * 于是渲染层仍然能在没有 Obsidian 的环境里跑测试（这个项目的立身之本）。
   *
   * 三种失败都返回 `null` 并给出**可读原因**，让绘制层回退到颜色 + 字形：
   * 文件不在库里、拿不到资源地址（移动端/非文件系统适配器）、图片解码失败。
   * 不抛异常：它是在绘制过程中被调起的，抛出去会变成每帧刷屏的错误。
   */
  /**
   * 取"库内文件 → 资源地址"用的 vault 视图（两个可选 API 都比 obsidian 的类型声明宽）。
   *
   * `Vault.getResourcePath` 是官方 API；`adapter.getResourcePath` 是 1.5 之前的老写法，
   * 移动端与非文件系统适配器上两者都可能缺失 —— 所以全部标成可选，由调用方决定回退。
   */
  private resourceVault():
    | (typeof this.deps.app.vault & {
        getResourcePath?: (file: TFile) => string
        adapter?: { getResourcePath?: (path: string) => string }
      })
    | undefined {
    return this.deps.app?.vault as
      | (typeof this.deps.app.vault & {
          getResourcePath?: (file: TFile) => string
          adapter?: { getResourcePath?: (path: string) => string }
        })
      | undefined
  }

  /**
   * 库内图片路径 → 可直接放进 `<img src>` 的地址；取不到时返回 `''`。
   *
   * 真正的取值顺序在 `base/vaultResource.ts` 里（设置页的图标预览用的是同一个函数）——
   * 两处各写一遍迟早会分叉，表现是"设置页有预览、画布上是破图"。
   * 返回空串表示"这张图现在拿不到"，由标记层回退成图标字形。
   */
  private resourceUrlFor(path: string): string {
    return resolveVaultResourceUrl(this.deps.app, path)
  }

  private async loadTerrainImage(path: string): Promise<CanvasImageSource | null> {
    const vault = this.resourceVault()
    if (!vault) {
      console.warn(`[project-kaki] 自定义地形图片 ${path}：当前没有可用的 vault，已回退到颜色 + 字形`)
      return null
    }

    const file = vault.getAbstractFileByPath?.(path)
    if (!file) {
      console.warn(`[project-kaki] 自定义地形图片不存在：${path} —— 已回退到颜色 + 字形（检查设置里的路径）`)
      return null
    }

    // 优先用 Vault.getResourcePath（官方 API），退回 adapter.getResourcePath（1.5 之前的老写法）
    let url = ''
    try {
      if (typeof vault.getResourcePath === 'function') url = vault.getResourcePath(file as TFile)
      else if (typeof vault.adapter?.getResourcePath === 'function') url = vault.adapter.getResourcePath(path)
    } catch (error) {
      console.warn(`[project-kaki] 无法取得 ${path} 的资源地址，已回退到颜色 + 字形`, error)
      return null
    }
    if (typeof url !== 'string' || url.length === 0) {
      console.warn(`[project-kaki] 资源地址为空（${path}）：当前平台可能不支持把库内文件当图片加载，已回退到颜色 + 字形`)
      return null
    }

    // `Image` 在非浏览器环境不存在；这里不假设它一定可用
    const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image
    if (typeof ImageCtor !== 'function') {
      console.warn(`[project-kaki] 当前环境没有 Image 构造器，无法加载地形图片 ${path}，已回退到颜色 + 字形`)
      return null
    }
    return await new Promise<CanvasImageSource | null>((resolve) => {
      const image = new ImageCtor()
      image.onload = () => resolve(image)
      image.onerror = () => {
        console.warn(`[project-kaki] 图片解码失败：${path} —— 已回退到颜色 + 字形`)
        resolve(null)
      }
      image.src = url
    })
  }

  /**
   * 设置里改了样式（路径颜色/区域颜色/字体/自定义地形）之后调用：让所有已挂载的地图跟上。
   *
   * 颜色、字体、地形目录都是**每帧现读**的（见各处 `getStylePalette` / `getCustomTerrains`），
   * 所以这里不需要传值，只需要：① 让工具条刷新（色块、地形按钮、高亮）；
   * ② 请求重绘（字体变了名称要重排；地形目录变了图集要重建）。
   */
  setStylePalette(): void {
    for (const entry of this.entries.values()) {
      entry.toolbar?.refresh()
      // 颜色/名称/地形目录都会改变图例显示的文字与色块，所以顺带刷新一次
      this.refreshLegend(entry)
      entry.overlay.requestRedraw()
    }
  }

  /** 某个 canvas 当前的图例条目（状态命令与测试用；受图层开关约束） */
  buildLegendFor(canvasPath: string): LegendEntry[] {
    const entry = this.entries.get(canvasPath)
    if (!entry) return []
    return buildLegendEntries(entry.document, this.legendDeps(), this.layersVisibility())
  }

  /**
   * 刷新一块地图的图例。
   *
   * **只在"文档变了 / 设置变了 / 图层变了"时调用，绝不放进每帧重绘**：
   * 图例内容与视口无关（平移缩放不会改变地图上有什么），
   * 而 `buildLegendEntries` 要遍历地形格 —— 跟着每帧跑就是白烧 CPU
   * （侧边栏面板曾经每帧重建 DOM，表现就是发卡）。
   */
  private refreshLegend(entry: LayerEntry): void {
    if (!entry.legend) return
    try {
      entry.legend.refresh(buildLegendEntries(entry.document, this.legendDeps(), this.layersVisibility()))
    } catch (error) {
      console.warn('[project-kaki] 图例刷新失败', error)
    }
  }

  /**
   * 图例用的三个样式解析器。
   *
   * 全部从**当前设置**现取：内置地形、自定义地形、未知 ID 三种情况由 `resolveTerrainStyle`
   * 统一抹平，路径则由 `resolvePathType`（目录）统一抹平 —— 图例只负责显示，
   * 于是"图例与画布配色不一致"这种老问题不会因为新功能复活。
   */
  private legendDeps(): LegendDeps {
    const custom = this.deps.getCustomTerrains?.() ?? []
    const pathTypes = this.deps.getPathTypes?.() ?? defaultPathTypeEntries()
    const regionTypes = this.deps.getRegionTypes?.() ?? defaultRegionTypeEntries()
    return {
      resolveTerrain: (id) => {
        const style = resolveTerrainStyle(id, custom)
        return { label: style.label, color: style.base }
      },
      // 路径：颜色/虚线来自**目录**（自定义与未知类型都在里面），不是旧的颜色表
      resolvePath: (type) => {
        const resolved = resolvePathType(type, pathTypes)
        return {
          label: resolved.label,
          color: resolved.params.color,
          ...(resolved.params.dash.length > 0 ? { dash: [...resolved.params.dash] } : {}),
        }
      },
      // 区域：有类型就报类型名（自定义类型也是自己的名字），没有类型（升级前画的）
      // 就按颜色反查 —— 与升级前的 `resolveRegionPresets` 同语义，老地图图例一字不变
      resolveRegion: (color, type) => ({
        label: type.length > 0 ? regionTypeLabelOf(type, regionTypes) : regionLabelForColor(color, regionTypes),
      }),
      // 生物群系：按 ID 解析目录里那一条（显示名 + 它自己的颜色）。认不出的 ID 原样显示
      resolveBiome: (id) => {
        const style = resolveBiomeStyle(id, this.deps.getCustomBiomes?.() ?? [])
        return { label: style.label, color: style.color }
      },
      // 数据层的色带：与画布**同一个来源**（每帧现读那一个 getter），
      // 否则会出现"画布上是新色带、图例里还是旧的"这种两套配色的老毛病
      overlayStyles: this.deps.getOverlayStyles?.() ?? DEFAULT_OVERLAY_STYLES,
    }
  }

  disableAll(): void {
    for (const canvasPath of [...this.enabled]) this.disable(canvasPath)
  }

  private detachEntry(canvasPath: string): void {
    const entry = this.entries.get(canvasPath)
    if (!entry) return
    entry.interaction.detach()
    entry.toolbar?.destroy()
    entry.selectionCard?.destroy()
    entry.legend?.destroy()
    entry.overlay.detach()
    this.entries.delete(canvasPath)
  }

  // ------------------------------------------------------------ 文档读写

  private async loadMap(
    mapPath: string,
  ): Promise<{ document: MapDocument; name: string; canvases: string[] } | null> {
    const abstract = this.deps.app.vault.getAbstractFileByPath(mapPath)
    if (abstract === null) return null
    const loaded = await this.deps.store.load(abstract as TFile)
    if (!loaded.document) return null
    const name = loaded.frontmatter.name ?? mapPath.split('/').pop()?.replace(/\.map\.md$/i, '') ?? 'Map'
    const canvases = loaded.frontmatter.canvases.length > 0 ? loaded.frontmatter.canvases : []
    return { document: loaded.document, name, canvases }
  }

  private scheduleSave(canvasPath: string): void {
    const entry = this.entries.get(canvasPath)
    if (!entry) return
    // 编辑结束（一次笔画 / 一条 op 完成）才会走到这里 —— 正是"文档变了"的时刻，
    // 也是刷新图例的合适时机（图例跟着每帧跑是白烧 CPU，见 refreshLegend）
    this.refreshLegend(entry)
    const abstract = this.deps.app.vault.getAbstractFileByPath(entry.mapPath)
    if (abstract === null) return
    this.deps.store.scheduleSave(abstract as TFile, entry.document, entry.name, entry.canvases)
  }

  /**
   * 处理 vault 的 modify 事件。
   *
   * 两处必须小心：
   * 1. **自写要跳过**。我们的保存（防抖 400 ms 后落盘）同样会触发 modify；
   *    若不加判断就重载，会把内存里的文档整个换掉 —— 绘制中的笔画会写进被丢弃的对象。
   *    自写判定用 mtime（存储层实现），不用时间窗：时间窗会把紧随其后的**真实外部改动**吞掉。
   * 2. **绘制中不重载**，否则进行中的笔画会写进被替换掉的旧文档。
   *    外部改动会在下一次 modify 时被拾取。
   *
   * 注意：重载**不再清空撤销历史**。历史里的 op 记录的是"格 + 新旧状态"，
   * 对替换后的文档依然成立；清空历史正是"画完一秒后撤销自己变灰"的原因。
   */
  handleFileModified(file: TFile): void {
    const mapPath = file.path
    const affected = this.requestRedrawFor(mapPath)
    if (affected === 0) return
    if (this.deps.store.isOwnWrite(file)) return

    for (const entry of this.entries.values()) {
      if (entry.mapPath !== mapPath) continue
      if (entry.editor.getStatus().painting) return
    }
    void this.reloadMap(mapPath)
  }

  /** 从磁盘重新加载某张地图并刷新对应覆盖层（文件被外部改动时调用） */
  async reloadMap(mapPath: string): Promise<number> {
    const loaded = await this.loadMap(mapPath)
    if (!loaded) return 0
    let updated = 0
    for (const entry of this.entries.values()) {
      if (entry.mapPath !== mapPath) continue
      entry.document = loaded.document
      entry.name = loaded.name
      entry.canvases = loaded.canvases
      // 刻意**不**清空撤销历史：历史 op 记录的是"格 + 新旧状态"，
      // 对替换后的文档依然成立。清空它会让用户在保存后丢失撤销能力。
      entry.overlay.requestRedraw()
      // 外部改动换掉了文档，图例也必须跟着换（否则图例会停留在旧内容上）
      this.refreshLegend(entry)
      updated += 1
    }
    return updated
  }

  requestRedrawFor(mapPath: string): number {
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.mapPath !== mapPath) continue
      entry.overlay.requestRedraw()
      count += 1
    }
    return count
  }

  /** 让所有已挂载的地图重绘（设置变更后调用） */
  redrawAll(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      entry.overlay.requestRedraw()
      count += 1
    }
    return count
  }

  /**
   * 布局变化后的重挂载：已启用的 canvas 若换了叶子（视图被重建），
   * 覆盖层与工具条必须重新挂到新的 DOM 上，否则地图会"消失"。
   */
  syncAttachments(): number {
    const { handles } = findCanvasHandles(this.deps.app)
    const byPath = new Map<string, CanvasHandle>()
    for (const handle of handles) {
      const path = handle.file?.path
      if (path) byPath.set(path, handle)
    }

    let reattached = 0
    for (const canvasPath of [...this.enabled]) {
      const handle = byPath.get(canvasPath)
      if (!handle) {
        // 视图已关闭：保留启用状态，等它重新打开
        this.detachEntry(canvasPath)
        continue
      }
      const entry = this.entries.get(canvasPath)
      if (entry?.overlay.isAttached()) {
        entry.overlay.requestRedraw()
        continue
      }
      void this.enable(handle)
      reattached += 1
    }
    return reattached
  }
}
