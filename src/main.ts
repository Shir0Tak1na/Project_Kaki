/**
 * Project Kaki —— 插件入口。
 *
 * 当前阶段：Phase 0（探针）已完成；Phase 1 进行中，已具备
 * 地图文档格式与读写层、网格空间索引、以及创建/绑定/查看地图的命令。
 * 渲染层与绘图工具在后续步骤加入。
 */

import { Notice, Plugin, TFile, type App } from 'obsidian'
import { activeCanvasHandle, findCanvasHandles } from './canvas/CanvasAdapter.ts'
import { MapBasesView } from './base/MapBasesView.ts'
import { buildStarterBaseFile } from './base/starterBase.ts'
import {
  BASES_VIEW_TYPE,
  DEFAULT_COORD_PROPERTY,
  DEFAULT_REGION_PROPERTY,
  DEFAULT_TYPE_PROPERTY,
  OPTION_KEYS,
  SORT_OPTIONS,
  isMapDocumentLike,
} from './base/viewContract.ts'
import { MapDocumentStore } from './data/MapDocumentStore.ts'
import { summarizeMapDocument } from './data/mapDocument.ts'
import { buildDiagnosticReport } from './dev/diagnostics.ts'
import { disposeViewportWatch, getWatchStatus, startViewportWatch, stopViewportWatch } from './dev/viewport-watch.ts'
import { MapEditor } from './editor/MapEditor.ts'
import { MapLayerManager } from './render/MapLayerManager.ts'
import { buildMapExportSvg } from './base/mapPreview.ts'
import { PlaceMarkerModal, type PlaceModalFactory } from './ui/PlaceMarkerModal.ts'
import { MapPanelView, MAP_PANEL_VIEW_TYPE, type PluginAction } from './ui/MapPanel.ts'
import {
  CartographerSettingTab,
  normalizeLabelScale,
  normalizeSettings,
  paletteOf,
  type CartographerSettings,
} from './ui/SettingsTab.ts'
import {
  defaultPathColors,
  defaultRegionColors,
  normalizeFontFamily,
  normalizePathColors,
  normalizeRegionColors,
  type StylePalette,
} from './render/stylePalette.ts'
import type { PathType } from './data/mapDocument.ts'
import { TextPromptModal, type TextPromptOptions } from './ui/TextPromptModal.ts'

/** 命名对话框工厂（可替换，用于自动化测试） */
export type PromptModalFactory = (
  app: App,
  options: TextPromptOptions,
  onSubmit: (value: string | null) => void,
) => { open(): void }

const DIAGNOSTIC_FALLBACK_PATH = 'FC-diagnostics.md'
const DEFAULT_MAP_FOLDER = 'Maps'

export default class ProjectKakiPlugin extends Plugin {
  private store: MapDocumentStore | null = null
  private layers: MapLayerManager | null = null
  /** 放置对话框的工厂：默认用真实对话框，可被替换（自动化测试 / 将来的批量导入） */
  private placeModalFactory: PlaceModalFactory = (app, options) => new PlaceMarkerModal(app, options)
  /** 命名对话框的工厂：默认用真实对话框，可被替换（自动化测试） */
  private promptModalFactory: PromptModalFactory = (app, options, onSubmit) =>
    new TextPromptModal(app, options, onSubmit)
  /** 不能用 `settings` 这个名字：Obsidian 的 Plugin 基类已经有同名成员 */
  private pluginSettings: CartographerSettings = normalizeSettings(null)
  /** Base 自定义视图是否可用（需要 Obsidian 1.10.0+） */
  private basesAvailable = false
  /** 动作注册表：命令面板与地图面板共用（见 buildActions） */
  private actions: PluginAction[] = []

  override async onload(): Promise<void> {
    await this.loadSettings()

    this.store = new MapDocumentStore(this.app)
    this.store.start()

    this.layers = new MapLayerManager({
      app: this.app,
      store: this.store,
      // 网格线默认打开：绘图与对齐校验都依赖它
      showGrid: true,
      placeModalFactory: (app, options) => this.placeModalFactory(app, options),
      promptModalFactory: (app, options, onSubmit) => this.promptModalFactory(app, options, onSubmit),
      // 名称字号倍率：设置界面改完立即生效
      getLabelScale: () => this.pluginSettings.labelScale,
      getShowGrid: () => this.pluginSettings.showGrid,
      // 样式（路径/区域颜色、名称字体族）：地图层每帧现读，改完设置立刻生效
      getStylePalette: () => this.getStylePalette(),
    })

    this.addSettingTab(new CartographerSettingTab(this.app, this))

    // 地图面板：右侧边栏视图 + 侧边栏图标（省掉每次都按 Ctrl+P）
    this.registerPanel()

    // Base 视图按版本门禁：旧版本没有 registerBasesView，此时只是"没有这个视图"，
    // Canvas 侧的所有功能不受影响（不抬高 minAppVersion，运行时降级）
    this.registerBases()
    this.registerBaseCommand()

    // 切换视图时落盘，并重新挂载地图层（视图可能已被重建）
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        void this.store?.flush()
        this.layers?.syncAttachments()
        // 按键作用域随焦点走：canvas 在前台时接管按键，否则让给编辑器
        this.layers?.syncKeyScope()
        // 面板显示的是"当前 Canvas"的状态，换视图后必须跟着变
        this.refreshPanel()
      }),
    )
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.layers?.syncAttachments()
        this.refreshPanel()
      }),
    )

    // 地图文件被改写时刷新已挂载的覆盖层；
    // 自写与外部改动由 layers 内部区分（自写不得重载，否则会清空撤销历史）
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return
        this.layers?.handleFileModified(file)
      }),
    )

    this.registerActions()

    console.log('[project-kaki] 已加载')
  }

  // ------------------------------------------------------------ 动作注册表

  /**
   * 所有"可以被触发一次"的动作（命令面板与地图面板**共用同一份定义**）。
   *
   * 为什么要有这层：命令面板（Ctrl+P）和侧边栏面板如果各写一套，
   * 迟早会出现"面板里有、命令面板里没有"或两边行为不一致。
   * 这里只描述一次，两边都从它生成 —— 面板点按钮就等于执行命令。
   */
  private buildActions(): PluginAction[] {
    const activeEditor = (): MapEditor | null => this.layers?.getActiveEditor() ?? null
    const hasLayer = (): boolean => activeEditor() !== null

    return [
      {
        id: 'open-map-panel',
        name: '打开地图面板',
        icon: 'sidebar-right',
        group: 'panel',
        run: () => this.activatePanel(),
      },
      {
        id: 'toggle-map-layer',
        name: '启用/停用当前 Canvas 的地图层',
        icon: 'layers',
        group: 'map',
        describe: () => {
          const status = this.layers?.listStatus().find((item) => item.attached)
          if (!status) return '当前 Canvas 未启用'
          return `已启用：${status.mapPath ?? '未绑定地图'}`
        },
        run: () => this.toggleMapLayer(),
      },
      {
        id: 'toggle-edit-mode',
        name: '切换绘制/选择模式（快捷键 D）',
        icon: 'pencil',
        group: 'edit',
        available: hasLayer,
        describe: () => {
          const editor = activeEditor()
          if (!editor) return '需要先启用地图层'
          return editor.mode === 'paint' ? '当前：绘制中（Esc 退出）' : '当前：选择模式'
        },
        run: () => {
          const result = this.layers?.toggleEditMode()
          if (!result?.ok) {
            new Notice(`无法切换绘图模式：${result?.reason ?? '未知原因'}`, 8000)
            return
          }
          new Notice(result.mode === 'paint' ? '已进入绘制模式：左键绘制，Esc 退出' : '已回到选择模式', 6000)
        },
      },
      {
        id: 'undo-map-edit',
        name: '撤销地图编辑',
        icon: 'undo-2',
        group: 'edit',
        available: () => (activeEditor()?.getStatus().undo ?? 0) > 0,
        describe: () => {
          const status = activeEditor()?.getStatus()
          if (!status) return '需要先启用地图层'
          return status.undo > 0 ? `可撤销 ${status.undo} 步` : '没有可撤销的操作'
        },
        run: () => {
          const editor = activeEditor()
          if (!editor) {
            new Notice('当前 Canvas 未启用地图层。', 6000)
            return
          }
          new Notice(editor.undo() ? '已撤销一步地图编辑' : '没有可撤销的地图编辑', 4000)
        },
      },
      {
        id: 'redo-map-edit',
        name: '重做地图编辑',
        icon: 'redo-2',
        group: 'edit',
        available: () => (activeEditor()?.getStatus().redo ?? 0) > 0,
        describe: () => {
          const status = activeEditor()?.getStatus()
          if (!status) return '需要先启用地图层'
          return status.redo > 0 ? `可重做 ${status.redo} 步` : '没有可重做的操作'
        },
        run: () => {
          const editor = activeEditor()
          if (!editor) {
            new Notice('当前 Canvas 未启用地图层。', 6000)
            return
          }
          new Notice(editor.redo() ? '已重做一步地图编辑' : '没有可重做的地图编辑', 4000)
        },
      },
      {
        id: 'create-map',
        name: '创建地图并绑定到当前 Canvas',
        icon: 'file-plus',
        group: 'file',
        run: () => this.promptCreateMap(),
      },
      {
        id: 'map-status',
        name: '查看当前 Canvas 绑定的地图',
        icon: 'info',
        group: 'file',
        run: () => this.showMapStatus(),
      },
      {
        id: 'create-map-base',
        name: '创建地图 Base 文件（表格视图）',
        icon: 'table',
        group: 'file',
        run: () => this.createMapBase(),
      },
      {
        id: 'export-map-svg',
        name: '导出当前地图为 SVG',
        icon: 'image-down',
        group: 'file',
        available: hasLayer,
        describe: () => (hasLayer() ? '导出到地图文件同目录' : '需要先启用地图层'),
        run: () => this.exportActiveMapSvg(),
      },
      {
        id: 'diagnose-canvas',
        name: '诊断当前 Canvas（开发用探针）',
        icon: 'stethoscope',
        group: 'dev',
        devOnly: true,
        run: () => this.runDiagnostics(),
      },
      {
        id: 'toggle-viewport-watch',
        name: '监视视口变化（开发用探针）',
        icon: 'activity',
        group: 'dev',
        devOnly: true,
        run: () => {
          this.toggleViewportWatch()
        },
      },
    ]
  }

  /**
   * 注册命令。
   *
   * **开发用命令只在"开发者模式"下可见**：`checkCallback` 返回 false 时
   * Obsidian 会把它从命令面板里隐藏 —— 这正是"避免误触"要做的事（不是灰掉，而是不出现）。
   */
  private registerActions(): void {
    this.actions = this.buildActions()
    for (const action of this.actions) {
      this.addCommand({
        id: action.id,
        name: action.name,
        ...(action.icon ? { icon: action.icon as never } : {}),
        checkCallback: (checking: boolean) => {
          if (action.devOnly === true && !this.pluginSettings.developerMode) return false
          if (!checking) void action.run()
          return true
        },
      })
    }
  }

  /** 面板用的动作清单（按当前开发者模式过滤） */
  getPanelActions(): PluginAction[] {
    return this.actions.filter((action) => action.devOnly !== true || this.pluginSettings.developerMode)
  }

  // ------------------------------------------------------------ 地图面板

  private registerPanel(): void {
    this.registerView(MAP_PANEL_VIEW_TYPE, (leaf) => new MapPanelView(leaf, {
      getActions: () => this.getPanelActions(),
      getSummary: () => this.describePanelSummary(),
    }))

    this.addRibbonIcon('map', 'Project Kaki：打开地图面板', () => {
      void this.activatePanel()
    })
  }

  /** 打开（或聚焦）右侧边栏里的地图面板 */
  async activatePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(MAP_PANEL_VIEW_TYPE)
    const first = existing[0]
    if (first) {
      await this.app.workspace.revealLeaf(first)
      this.refreshPanel()
      return
    }
    const leaf = this.app.workspace.getRightLeaf(false)
    if (!leaf) {
      new Notice('无法打开右侧边栏（可能被折叠了）。', 6000)
      return
    }
    await leaf.setViewState({ type: MAP_PANEL_VIEW_TYPE, active: true })
    await this.app.workspace.revealLeaf(leaf)
  }

  /** 让已打开的面板重绘（状态变化后调用；面板内部会合并同一帧的重复请求） */
  refreshPanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MAP_PANEL_VIEW_TYPE)) {
      const view = leaf.view
      if (view instanceof MapPanelView) view.requestRender()
    }
  }

  /**
   * 面板顶部的一行状态：当前地图与地图层。
   *
   * ⚠️ 这里**不能**放"每帧都在变"的实时数值（例如本帧绘制了多少格地形）：
   * 面板用这段文字当作"要不要重绘"的签名的一部分，而平移/缩放画布会让那个数字每帧变 ——
   * 结果就是面板跟着每一帧重建 DOM，侧边栏看起来就"卡"。
   * 需要的实时数字放在命令/状态报告里看。
   */
  private describePanelSummary(): string {
    const status = this.layers?.listStatus().find((item) => item.attached)
    if (!status) {
      const canvasPath = this.activeCanvasPath()
      if (canvasPath === null) return '当前没有打开 Canvas'
      const mapPath = this.store?.mapFilePathForCanvas(canvasPath) ?? null
      return mapPath === null ? '当前 Canvas 尚未绑定地图' : `已绑定：${mapPath} · 地图层未启用`
    }
    return `${status.mapPath ?? '未绑定地图'} · 地图层已启用`
  }


  // ------------------------------------------------------------ Base 视图

  /**
   * 注册 Base 自定义视图。
   *
   * ⚠️ `registerBasesView` 只在 1.10.0+ 存在：旧版本上是 `undefined`，
   * 直接调用会抛错并让整个 `onload` 失败（连 Canvas 功能也一起没了）。
   * 因此这里既做能力检测，也把结果记下来供命令提示。
   */
  private registerBases(): void {
    const register = (this as unknown as { registerBasesView?: unknown }).registerBasesView
    if (typeof register !== 'function') {
      this.basesAvailable = false
      console.warn('[project-kaki] 当前 Obsidian 不支持 Base 自定义视图（需要 1.10.0+），仅 Canvas 功能可用')
      return
    }
    this.basesAvailable = this.registerBasesView(BASES_VIEW_TYPE, {
      name: '地图',
      icon: 'map',
      factory: (controller, containerEl) =>
        new MapBasesView(controller, containerEl, { app: this.app, store: this.store! }),
      options: () => [
        // 几何数据留在 .map.md 里，靠文件选项指过去 —— 不进 YAML
        {
          type: 'file',
          key: OPTION_KEYS.mapFile,
          displayName: '地图文档',
          placeholder: 'Maps/World.map.md',
          filter: isMapDocumentLike,
        },
        { type: 'property', key: OPTION_KEYS.coordProperty, displayName: '坐标属性', default: DEFAULT_COORD_PROPERTY },
        { type: 'property', key: OPTION_KEYS.typeProperty, displayName: '图标属性', default: DEFAULT_TYPE_PROPERTY },
        { type: 'property', key: OPTION_KEYS.regionProperty, displayName: '地区属性', default: DEFAULT_REGION_PROPERTY },
        {
          type: 'dropdown',
          key: OPTION_KEYS.sortBy,
          displayName: '排序',
          default: 'name',
          options: { ...SORT_OPTIONS },
        },
      ],
    })
    console.log(`[project-kaki] Base 视图注册${this.basesAvailable ? '成功' : '失败'}：${BASES_VIEW_TYPE}`)
  }

  getBasesAvailable(): boolean {
    return this.basesAvailable
  }

  /** 把 Base 视图的注册结果与用法暴露给诊断（视图内部状态只有真实渲染时才有） */
  describeBaseStatus(): string {
    if (!this.basesAvailable) return 'Base 视图：不可用（需要 Obsidian 1.10.0+）'
    return `Base 视图：已注册（视图类型 ${BASES_VIEW_TYPE}）`
  }

  /** 生成一份可直接打开的 Base 文件，省掉手写 YAML */
  private registerBaseCommand(): void {
    this.addCommand({
      id: 'create-map-base',
      name: '创建地图 Base 文件（表格视图）',
      callback: () => {
        void this.createMapBase()
      },
    })
  }

  private async createMapBase(): Promise<void> {
    if (!this.basesAvailable) {
      new Notice('当前 Obsidian 不支持 Base 自定义视图（需要 1.10.0+）。', 8000)
      return
    }
    const maps = this.store?.listMapFiles() ?? []
    if (maps.length === 0) {
      new Notice('库里还没有地图文档：先用「创建地图并绑定到当前 Canvas」建一张。', 8000)
      return
    }
    const mapPath = maps[0]!.path
    const basePath = `${mapPath.replace(/\.map\.md$/i, '')}.base`
    if (this.app.vault.getAbstractFileByPath(basePath)) {
      new Notice(`已存在同名 Base 文件，未覆盖：${basePath}`, 8000)
      return
    }
    try {
      const created = await this.app.vault.create(basePath, buildStarterBaseFile(mapPath))
      new Notice(`已创建 ${created.path}\n打开它，把视图类型切到「地图」。`, 10000)
    } catch (error) {
      console.error('[project-kaki] 创建 Base 文件失败', error)
      new Notice(`创建 Base 文件失败：${error instanceof Error ? error.message : String(error)}`, 8000)
    }
  }

  private async exportActiveMapSvg(): Promise<void> {
    const handle = activeCanvasHandle(this.app)
    const canvasPath = handle?.file?.path
    if (!canvasPath || !this.layers) {
      new Notice('请先打开一个已启用地图层的 Canvas。', 8000)
      return
    }
    const mapPath = this.store?.mapFilePathForCanvas(canvasPath)
    const document = this.layers.getDocument(canvasPath)
    if (!mapPath || !document) {
      new Notice('当前 Canvas 没有可导出的地图。请先启用地图层。', 8000)
      return
    }

    const basePath = mapPath.replace(/\.map\.md$/i, '')
    let exportPath = `${basePath}.svg`
    let suffix = 2
    while (this.app.vault.getAbstractFileByPath(exportPath)) {
      exportPath = `${basePath}-${suffix}.svg`
      suffix += 1
    }

    try {
      const created = await this.app.vault.create(exportPath, buildMapExportSvg(document))
      new Notice(`已导出地图 SVG：${created.path}`, 8000)
      void this.app.workspace.openLinkText(created.path, '', false)
    } catch (error) {
      console.error('[project-kaki] 导出 SVG 失败', error)
      new Notice(`导出 SVG 失败：${error instanceof Error ? error.message : String(error)}`, 8000)
    }
  }

  override onunload(): void {
    // 先摘掉地图层：它挂着 markViewportChanged 的补丁与 DOM 元素
    this.layers?.disableAll()
    this.layers = null
    // 确保不把 markViewportChanged 的补丁留在运行中的 Canvas 上
    disposeViewportWatch()
    // 尽力落盘（onunload 不能 await，这里只保证已排队的写不会再等防抖）
    void this.store?.flush()
    this.store?.dispose()
    this.store = null
  }

  /**
   * 地图文档存储层。对外暴露是刻意的：诊断命令、将来的 Base 视图、
   * 以及自动化测试都需要在不经过 UI 的情况下读写地图文档。
   */
  getStore(): MapDocumentStore | null {
    return this.store
  }

  /** 地图层管理器（同上，供诊断与测试使用） */
  getLayerManager(): MapLayerManager | null {
    return this.layers
  }

  getSettings(): CartographerSettings {
    return this.pluginSettings
  }

  /** 当前样式调色板（地图层每帧现读它，见 `MapLayerManagerDeps.getStylePalette`） */
  getStylePalette(): StylePalette {
    return paletteOf(this.pluginSettings)
  }

  private async loadSettings(): Promise<void> {
    // 一切入口都走 normalizeSettings：data.json 被手工改坏时只在这里收敛一次
    this.pluginSettings = normalizeSettings(await this.loadData())
  }

  /** 修改名称字号倍率并立即重绘已打开的地图（设置界面用） */
  async setLabelScale(value: number): Promise<void> {
    const next = normalizeLabelScale(value)
    if (next === this.pluginSettings.labelScale) return
    this.pluginSettings = { ...this.pluginSettings, labelScale: next }
    await this.saveData(this.pluginSettings)
    this.layers?.redrawAll()
  }

  /** 改一种路径类型的默认颜色（只影响之后新画的路径） */
  async setPathColor(type: PathType, color: string): Promise<void> {
    const next = normalizePathColors({ ...this.pluginSettings.pathColors, [type]: color })
    if (next[type] === this.pluginSettings.pathColors[type]) return
    this.pluginSettings = { ...this.pluginSettings, pathColors: next }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /** 改第 index 个区域预设色（工具条上按顺序对应的色块） */
  async setRegionColor(index: number, color: string): Promise<void> {
    const list = [...this.pluginSettings.regionColors]
    if (index < 0 || index >= list.length) return
    const next = normalizeRegionColors(list.map((item, i) => (i === index ? color : item)))
    if (next[index] === list[index]) return
    this.pluginSettings = { ...this.pluginSettings, regionColors: next }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /** 改名称字体族（空串 = 跟随主题）；非法串会被收敛成空串而不是透传给 canvas */
  async setLabelFontFamily(value: string): Promise<void> {
    const next = normalizeFontFamily(value)
    if (next === this.pluginSettings.labelFontFamily) return
    this.pluginSettings = { ...this.pluginSettings, labelFontFamily: next }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /** 样式恢复出厂（设置页的「恢复默认」） */
  async resetStylePalette(): Promise<void> {
    this.pluginSettings = {
      ...this.pluginSettings,
      pathColors: defaultPathColors(),
      regionColors: defaultRegionColors(),
      labelFontFamily: '',
    }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /**
   * 开发者模式开关：控制开发用探针命令是否可见（命令面板与地图面板同时生效）。
   *
   * 关掉之后探针命令会从命令面板**消失**（`checkCallback` 返回 false 即隐藏），
   * 而不是灰掉 —— 目标是"不会被误触"。
   */
  async setDeveloperMode(enabled: boolean): Promise<void> {
    if (this.pluginSettings.developerMode === enabled) return
    this.pluginSettings = { ...this.pluginSettings, developerMode: enabled }
    await this.saveData(this.pluginSettings)
    this.refreshPanel()
  }

  async setShowGrid(value: boolean): Promise<void> {
    const next = value === true
    if (next === this.pluginSettings.showGrid) return
    this.pluginSettings = { ...this.pluginSettings, showGrid: next }
    await this.saveData(this.pluginSettings)
    this.layers?.setShowGrid(next)
  }

  /** 替换放置对话框（自动化测试用；不改动则为真实的输入对话框） */
  setPlaceModalFactory(factory: PlaceModalFactory): void {
    this.placeModalFactory = factory
  }

  /** 替换命名对话框（自动化测试用；不改动则为真实的输入对话框） */
  setPromptModalFactory(factory: PromptModalFactory): void {
    this.promptModalFactory = factory
  }

  // ------------------------------------------------------------ 地图层

  private async toggleMapLayer(): Promise<void> {
    const layers = this.layers
    if (!layers) return

    const handle = activeCanvasHandle(this.app)
    const canvasPath = handle?.file?.path
    if (!handle || !canvasPath) {
      new Notice('请先打开一个 .canvas 文件。', 8000)
      return
    }

    if (layers.isEnabled(canvasPath)) {
      layers.disable(canvasPath)
      new Notice(`已停用 ${canvasPath} 的地图层。`, 6000)
      return
    }

    const status = await layers.enable(handle)
    if (!status.attached) {
      new Notice(`未能启用地图层：${status.reason ?? '未知原因'}`, 10000)
      return
    }

    const stats = status.stats
    new Notice(
      [
        `已启用地图层：${canvasPath}`,
        `地图：${status.mapPath}`,
        `挂载点：${stats?.hostClass ?? '未知'}`,
        `本帧绘制：地形 ${stats?.lastCellCount ?? 0} 格 · 裁剪 ${stats?.lastCulledCells ?? 0} 格 · 网格 ${stats?.lastGridCells ?? 0} 格`,
        this.describeLabelSize(),
      ].join('\n'),
      12000,
    )
  }

  /**
   * 报出名称的实际字号与实测标定。
   *
   * 名称大小是"看出来的"参数：与其让用户描述"太小了"，不如把数字直接给出来 ——
   * 有了实测标定，任何换算偏差都能一眼看出，不必再靠猜。
   */
  private describeLabelSize(): string {
    const attached = this.layers?.listStatus().find((item) => item.attached && item.stats)
    const stats = attached?.stats
    if (!stats?.labelCssPx) return '名称字号：本帧未绘制（先打开 Canvas 并启用地图层）'
    return (
      `名称字号：路径 ${stats.labelCssPx.path} px · 区域 ${stats.labelCssPx.region} px` +
      `（倍率 ×${this.pluginSettings.labelScale}）` +
      ` · 标定 1 CSS px = ${stats.rasterPxPerCssPx.toFixed(2)} 位图像素`
    )
  }

  // ------------------------------------------------------------ 地图文档

  private activeCanvasPath(): string | null {
    const handle = activeCanvasHandle(this.app)
    return handle?.file?.path ?? null
  }

  private promptCreateMap(): void {
    const canvasPath = this.activeCanvasPath()
    if (canvasPath === null) {
      new Notice('请先打开一个 .canvas 文件，再运行「创建地图并绑定到当前 Canvas」。', 8000)
      return
    }

    new TextPromptModal(
      this.app,
      {
        title: '创建地图',
        description: `将创建 Maps/<名称>.map.md，并绑定到当前的 ${canvasPath}。`,
        placeholder: '例如：艾尔登大陆',
        cta: '创建',
      },
      (name) => {
        if (name === null) return
        void this.createMap(name, canvasPath)
      },
    ).open()
  }

  private async createMap(name: string, canvasPath: string): Promise<void> {
    const store = this.store
    if (!store) return
    try {
      const file = await store.createMap({ name, folder: DEFAULT_MAP_FOLDER, canvasPath })
      new Notice(`已创建地图：${file.path}（已绑定 ${canvasPath}）`, 8000)
      await this.app.workspace.getLeaf(true).openFile(file)
    } catch (error) {
      console.error('[project-kaki] 创建地图失败', error)
      new Notice(`创建地图失败：${error instanceof Error ? error.message : String(error)}`, 10000)
    }
  }

  private async showMapStatus(): Promise<void> {
    const store = this.store
    if (!store) return

    const canvasPath = this.activeCanvasPath()
    if (canvasPath === null) {
      const { handles, totalLeaves } = findCanvasHandles(this.app)
      new Notice(
        totalLeaves === 0
          ? '当前没有 .canvas 视图。请打开一个 canvas 后重试。'
          : `检测到 ${totalLeaves} 个 canvas 叶子但只有 ${handles.length} 个已加载，请点击目标 canvas 后重试。`,
        8000,
      )
      return
    }

    const mapPath = store.mapFilePathForCanvas(canvasPath)
    if (mapPath === null) {
      const count = store.listMapFiles().length
      new Notice(
        `${canvasPath} 尚未绑定地图文档。\n运行「创建地图并绑定到当前 Canvas」新建一张（库内现有 ${count} 张地图）。`,
        10000,
      )
      return
    }

    const abstract = this.app.vault.getAbstractFileByPath(mapPath)
    if (!(abstract instanceof TFile)) {
      new Notice(`地图文档不存在或不是文件：${mapPath}`, 8000)
      return
    }

    const loaded = await store.load(abstract)
    if (loaded.document === null) {
      const firstError = loaded.issues.find((issue) => issue.level === 'error')
      new Notice(`地图加载失败：${firstError?.message ?? '未知原因'}\n详见开发者控制台。`, 12000)
      console.log('[project-kaki] 地图加载问题：', loaded.issues)
      return
    }

    const summary = summarizeMapDocument(loaded.document)
    const warnings = loaded.issues.filter((issue) => issue.level === 'warning')
    const sizeKiB = (new TextEncoder().encode(loaded.rawText).length / 1024).toFixed(1)
    const breakdown = summary.terrainBreakdown.map((item) => `${item.type}×${item.count}`).join(' ') || '无'

    new Notice(
      [
        `地图：${mapPath}`,
        `版本 v${loaded.document.version}${loaded.readOnly ? '（只读：版本高于本插件）' : ''}`,
        `网格：${loaded.document.grid.orientation} · 边长 ${loaded.document.grid.size}`,
        `地形 ${summary.cells} 格（${breakdown}）`,
        `标记 ${summary.markers} · 路径 ${summary.paths} · 区域 ${summary.regions} · 文字 ${summary.labels}`,
        `文件 ${sizeKiB} KiB · 告警 ${warnings.length} 条`,
        this.describeLabelSize(),
        warnings.length > 0 ? '告警详情见控制台。' : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      15000,
    )
    if (loaded.issues.length > 0) console.log('[project-kaki] 地图问题：', loaded.issues)
  }

  // ------------------------------------------------------------ Phase 0 探针

  private async runDiagnostics(): Promise<void> {
    const { handles } = findCanvasHandles(this.app)
    if (handles.length === 0) {
      new Notice('没有已打开的 Canvas 文件：请先打开一个 .canvas，再运行诊断。', 8000)
      return
    }

    const report = buildDiagnosticReport(this.app)
    console.log(report)

    try {
      await navigator.clipboard.writeText(report)
      new Notice(`诊断报告已复制到剪贴板（${report.length} 字符）。请整段贴回对话。`, 10000)
      return
    } catch {
      // 剪贴板可能因权限不可用，回落到写入 vault 文件
    }

    try {
      const existing = this.app.vault.getAbstractFileByPath(DIAGNOSTIC_FALLBACK_PATH)
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, report)
      } else {
        await this.app.vault.create(DIAGNOSTIC_FALLBACK_PATH, report)
      }
      new Notice(`剪贴板不可用，报告已写入 ${DIAGNOSTIC_FALLBACK_PATH}`, 10000)
    } catch (err) {
      console.error('[project-kaki] 写入诊断报告失败', err)
      new Notice('无法复制或写入报告：请按 Ctrl/Cmd+Shift+I 打开开发者控制台，从日志中复制。', 12000)
    }
  }

  private toggleViewportWatch(): void {
    const current = getWatchStatus()

    if (current.active) {
      const finalStatus = stopViewportWatch()
      if (finalStatus.samples.length > 0) console.log('[project-kaki] 视口采样：', finalStatus.samples.join(' | '))
      const duplicateRatio =
        finalStatus.totalCount > 0 ? Math.round((1 - finalStatus.effectiveCount / finalStatus.totalCount) * 100) : 0
      new Notice(
        `已停止监视：\n事件 ${finalStatus.totalCount} 次，有效视口变化 ${finalStatus.effectiveCount} 次（重复 ${duplicateRatio}%）。\n` +
          (finalStatus.totalCount > 0
            ? '判定：markViewportChanged 可用于事件驱动重绘 ✅'
            : '判定：一次都没触发，需检查是否真的平移/缩放过 ❌'),
        12000,
      )
      return
    }

    const status = startViewportWatch(this.app)
    if (!status.patched) {
      new Notice(`监视启动失败：${status.message}`, 10000)
      return
    }
    new Notice(`开始在 ${status.canvasPath} 上监视视口变化。\n现在去平移/缩放画布，然后再次运行本命令查看计数。`, 10000)
  }
}
