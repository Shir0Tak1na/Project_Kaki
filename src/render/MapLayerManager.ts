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
import { MapOverlay, type OverlayStats } from './MapOverlay.ts'
import { buildPlacements, type MarkerPlacement } from './markerPlacement.ts'

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
  showGrid?: boolean
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
  getShowGrid?: () => boolean
  onToggleLayer?: (canvasPath: string) => void
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

  /** 当前覆盖层持有的地图文档（诊断与测试用） */
  getDocument(canvasPath: string): MapDocument | null {
    return this.entries.get(canvasPath)?.document ?? null
  }

  getActiveEditor(): MapEditor | null {
    const canvasPath = activeCanvasHandle(this.deps.app)?.file?.path
    return canvasPath ? this.getEditor(canvasPath) : null
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

    const overlay = new MapOverlay({
      handle,
      getDocument: () => this.entries.get(canvasPath)?.document ?? null,
      showGrid: this.deps.getShowGrid?.() ?? this.deps.showGrid ?? true,
      ...(this.deps.canvasFactory ? { canvasFactory: this.deps.canvasFactory } : {}),
      // 标记层挂在未变换的 wrapperEl 上：屏幕坐标、字号恒定、可 hover/点击
      getMarkerHost: () => asElement((handle.canvas as { wrapperEl?: unknown }).wrapperEl),
      getPlacements: (document_, projection, viewportRect) =>
        buildPlacements({ document: document_, projection, viewportRect }),
      // 进行中的路径/区域草稿：与地形同帧绘制（橡皮筋要每帧跟随光标）
      getDraft: () => this.entries.get(canvasPath)?.editor.getDraft() ?? null,
      // 名称显示开关：只影响绘制，不改数据
      getShowShapeLabels: () => this.entries.get(canvasPath)?.editor.showShapeLabels ?? true,
      // 名称字号倍率：来自插件设置
      getLabelScale: () => this.deps.getLabelScale?.() ?? 1,
      onOpenLink: (link) => this.openNote(link, mapPath),
      onDeleteMarker: (placement) => this.deletePlacement(canvasPath, placement),
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
      onStateChanged: () => {
        // 单一收口点：任何模式/工具变化都会经过这里，
        // 因此标记层的交互开关放在这里最稳（不依赖调用方是否走了交互层）
        overlay.setMarkerInteractive(editor.mode === 'select')
        this.entries.get(canvasPath)?.toolbar?.refresh()
      },
    })

    // 工具条先声明：交互层的模式回调要刷新它（闭包在初始化之后才会被调用）
    let toolbar: MapToolbar | null = null

    const interaction = new MapInteraction({
      app: this.deps.app,
      handle,
      editor,
      // 捕获阶段监听宿主：越靠上越能保证先于 Obsidian 的处理。
      // 视图容器包含 wrapperEl 与 canvas 元素，是最合适的一层。
      getHost: () =>
        asElement((handle.view as { containerEl?: unknown }).containerEl) ??
        asElement((handle.canvas as { wrapperEl?: unknown }).wrapperEl),
      // 工具条也在同一个视图容器里：必须排除，否则它的点击会被捕获阶段吃掉
      getUiExclusions: () => [toolbar?.getElement() ?? null],
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
          onModeChanged: (mode) => interaction.notifyModeChanged(mode),
          onToggleLayer: () => this.disable(canvasPath),
          onUndo: () => {
            editor.undo()
          },
          onRedo: () => {
            editor.redo()
          },
        })
      } catch (error) {
        console.warn('[project-kaki] 工具条创建失败，地图层继续但不带工具条', error)
        toolbar = null
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
    }
    // 先登记再挂载：getDocument 依赖 entries 里已有本条目
    this.entries.set(canvasPath, entry)

    const result = overlay.attach()
    if (!result.ok) {
      toolbar?.destroy()
      this.entries.delete(canvasPath)
      return { canvasPath, mapPath, attached: false, reason: result.reason }
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

  setShowGrid(showGrid: boolean): void {
    for (const entry of this.entries.values()) entry.overlay.setShowGrid(showGrid)
  }

  disableAll(): void {
    for (const canvasPath of [...this.enabled]) this.disable(canvasPath)
  }

  private detachEntry(canvasPath: string): void {
    const entry = this.entries.get(canvasPath)
    if (!entry) return
    entry.interaction.detach()
    entry.toolbar?.destroy()
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
