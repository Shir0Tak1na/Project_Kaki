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
import { summarizeMapDocument, type MapDocument } from './data/mapDocument.ts'
import { buildDiagnosticReport } from './dev/diagnostics.ts'
import { disposeViewportWatch, getWatchStatus, startViewportWatch, stopViewportWatch } from './dev/viewport-watch.ts'
import { MapEditor } from './editor/MapEditor.ts'
import { MapLayerManager } from './render/MapLayerManager.ts'
import { buildMapExportSvg } from './base/mapPreview.ts'
import {
  EXPORT_RANGE_OPTIONS,
  exportFileNameFor,
  listExportRegions,
  resolveExportBounds,
  type ExportRange,
} from './base/exportBounds.ts'
import { exportBasePathFor, rasterizeSvgToPng, uniqueExportPath, type PngRasterDeps } from './base/pngExport.ts'
import { ExportModal, type ExportFormat, type ExportModalFactory } from './ui/ExportModal.ts'
import type { BBox } from './core/viewport.ts'
import { PlaceMarkerModal, type PlaceModalFactory } from './ui/PlaceMarkerModal.ts'
import { ReportModal, type ReportModalFactory, type ReportModalOptions } from './ui/ReportModal.ts'
import { AssetSuggestModal, type AssetPickerOptions, type ImagePickerFactory } from './ui/AssetSuggestModal.ts'
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
import {
  allLayersHidden,
  hiddenLayerLabels,
  withLayerVisibility,
  type LayerKey,
} from './render/layerVisibility.ts'
import { legendLines } from './render/legend.ts'
import { emptyImageListHint, listImagePaths } from './base/assetFiles.ts'
import {
  MAX_CUSTOM_TERRAINS,
  isBuiltinTerrain,
  resolveTerrainStyle,
  validateCustomTerrainInput,
  type CustomTerrain,
} from './render/terrainCatalog.ts'
import type { PathType } from './data/mapDocument.ts'
import { MAX_CUSTOM_MARKERS, validateCustomMarkerInput, type CustomMarker } from './render/markerCatalog.ts'
import { TextPromptModal, type TextPromptOptions } from './ui/TextPromptModal.ts'

/** 命名对话框工厂（可替换，用于自动化测试） */
export type PromptModalFactory = (
  app: App,
  options: TextPromptOptions,
  onSubmit: (value: string | null) => void,
) => { open(): void }

const DIAGNOSTIC_FALLBACK_PATH = 'FC-diagnostics.md'
const DEFAULT_MAP_FOLDER = 'Maps'
/**
 * 提示（`Notice`）的时长约定：**不超过 6000ms**。
 *
 * 用户的真实反馈："初次启动弹窗遮挡侧边栏的按钮，过一会才消失，等待时间过久。"
 * 于是提示按**内容**分流，而不是按重要性：
 *
 * - **短提示 ≤6000ms**：成功、状态、可重试的失败 —— 剩下的都是 1–3 行，6 秒够读完；
 * - **多行报告不进 Notice**：改用报告面板（`openReport`）—— 可看、可选中复制、可导出，
 *   而且不会盖住右上角的侧边栏按钮。状态报告与诊断报告都走这条路。
 *
 * 冒烟里有一条**全局断言**盯着这个上界（任何场景结束后都不允许存在 >6000ms 的提示）：
 * 下次谁再写一个 15 秒的弹窗，测试会直接红，而不是等用户来抱怨。
 */
const NOTICE_MAX_MS = 6000
/**
 * 导出尺寸：SVG 与 PNG **共用同一组数字**。
 *
 * 为什么强调共用：PNG 是先导出 SVG 再光栅化的（见 `pngExport.ts`），
 * 两处各写一份尺寸的话，迟早出现"导出的 SVG 是 1600×1000、PNG 却是别的比例"，
 * 而那种偏差在缩略图上看起来只是"有点不一样"，很难被发现。
 */
const EXPORT_WIDTH = 1600
const EXPORT_HEIGHT = 1000

export default class ProjectKakiPlugin extends Plugin {
  private store: MapDocumentStore | null = null
  private layers: MapLayerManager | null = null
  /** 放置对话框的工厂：默认用真实对话框，可被替换（自动化测试 / 将来的批量导入） */
  private placeModalFactory: PlaceModalFactory = (app, options) => new PlaceMarkerModal(app, options)
  /** 命名对话框的工厂：默认用真实对话框，可被替换（自动化测试） */
  private promptModalFactory: PromptModalFactory = (app, options, onSubmit) =>
    new TextPromptModal(app, options, onSubmit)
  /**
   * 报告面板的工厂：默认用真实对话框，可被替换（自动化测试）。
   *
   * 报告（地图状态 / 诊断）从长 `Notice` 改成面板，是为了解决用户说的三件事：
   * 弹窗盖住侧边栏按钮、等十几秒才消失、里面的文字复制不出来。
   * 测试里替换成"只记下 options"的替身，就能直接断言报告正文，而不必去读界面。
   */
  private reportModalFactory: ReportModalFactory = (app, options) => new ReportModal(app, options)
  /**
   * 图片选择器的工厂：默认用真实的 `AssetSuggestModal`，可被替换（自动化测试）。
   *
   * 为什么必须是**惰性**的（箭头函数里才 `new`）：假 obsidian 里没有 `FuzzySuggestModal`
   * 这个基类，而"类定义"在模块加载时就会求值 —— 直接 `new` 出去或者提前构造，
   * 冒烟会在加载阶段就炸，且报错位置与真实原因（缺基类）毫不相干。
   */
  private imagePickerFactory: ImagePickerFactory = (app, options) => new AssetSuggestModal(app, options)
  /**
   * PNG 光栅化的环境依赖（仅自动化测试注入；`null` = 用真实实现）。
   *
   * 为什么需要这个口子：真实光栅化要 `Image` 与 `canvas.toBlob`，这套东西在没有浏览器的
   * 测试环境里跑不出来；而"导出成功时写进去的到底是什么字节""失败时给的是不是人话"这两件事
   * 恰恰是最该测的。注入依赖之后，成功路径与降级路径都能端到端断言。
   */
  private pngRasterDeps: PngRasterDeps | null = null
  /**
   * 导出对话框工厂（仅自动化测试注入；默认就是真实对话框）。
   *
   * 默认工厂写成惰性闭包：真实对话框只在"真的被打开"时构造，因此注入替身
   * 可以完全绕开假 DOM，直接断言"用户选了哪个范围、哪种格式"之后发生了什么。
   */
  private exportModalFactory: ExportModalFactory = (app, options) => new ExportModal(app, options)
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
      placeModalFactory: (app, options) => this.placeModalFactory(app, options),
      promptModalFactory: (app, options, onSubmit) => this.promptModalFactory(app, options, onSubmit),
      // 名称字号倍率：设置界面改完立即生效
      getLabelScale: () => this.pluginSettings.labelScale,
      // 样式（路径/区域颜色、名称字体族）：地图层每帧现读，改完设置立刻生效
      getStylePalette: () => this.getStylePalette(),
      getCustomTerrains: () => this.getCustomTerrains(),
      getCustomMarkers: () => this.getCustomMarkers(),
      // 图层与图例：同样每帧现读。**网格也在 layers 里**（不再有第二个 showGrid 通道）。
      // 工具条上的按钮通过下面两个 setter 写回设置。
      getLayers: () => this.pluginSettings.layers,
      getShowLegend: () => this.pluginSettings.showLegend,
      setLayerVisible: (key, value) => {
        void this.setLayerVisible(key, value)
      },
      setShowLegend: (value) => {
        void this.setShowLegend(value)
      },
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
            new Notice(`无法切换绘图模式：${result?.reason ?? '未知原因'}`, NOTICE_MAX_MS)
            return
          }
          new Notice(result.mode === 'paint' ? '已进入绘制模式：左键绘制，Esc 退出' : '已回到选择模式', NOTICE_MAX_MS)
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
            new Notice('当前 Canvas 未启用地图层。', NOTICE_MAX_MS)
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
            new Notice('当前 Canvas 未启用地图层。', NOTICE_MAX_MS)
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
        // 「一条命令 + 一个对话框」：范围与格式都在对话框里选。
        // 否则"两条命令 × 三种范围"会铺成 6 条命令，命令面板越铺越难找。
        id: 'export-map',
        name: '导出地图…（可选范围与格式）',
        icon: 'image-down',
        group: 'file',
        available: hasLayer,
        describe: () => (hasLayer() ? '选范围（全部内容 / 当前视口 / 某个区域）与格式' : '需要先启用地图层'),
        run: () => this.openExportModal(),
      },
      {
        id: 'export-map-svg',
        name: '导出当前地图为 SVG',
        icon: 'image-down',
        group: 'file',
        available: hasLayer,
        describe: () => (hasLayer() ? '导出到地图文件同目录（等于「导出地图…」选全部内容 + SVG）' : '需要先启用地图层'),
        run: () => this.exportActiveMapSvg(),
      },
      {
        id: 'export-map-png',
        name: '导出当前地图为 PNG',
        icon: 'image',
        group: 'file',
        available: hasLayer,
        // PNG 与 SVG 是"同一张图的两种格式"：先导出 SVG（共用同一份几何与配色）再光栅化，
        // 所以这里的描述要把这层关系讲清楚，否则用户会以为两条命令各画各的。
        describe: () => (hasLayer() ? '与 SVG 同源，转成位图（等于「导出地图…」选全部内容 + PNG）' : '需要先启用地图层'),
        run: () => this.exportActiveMapPng(),
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
      // 图层开关：状态与写入口都从插件这边注入（面板不认识插件实例）
      getLayerVisibility: () => this.pluginSettings.layers,
      onToggleLayer: (key, value) => {
        void this.setLayerVisible(key, value)
      },
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
      new Notice('无法打开右侧边栏（可能被折叠了）。', NOTICE_MAX_MS)
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
        new MapBasesView(controller, containerEl, {
          app: this.app,
          store: this.store!,
          getCustomTerrains: () => this.getCustomTerrains(),
        }),
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
      new Notice('当前 Obsidian 不支持 Base 自定义视图（需要 1.10.0+）。', NOTICE_MAX_MS)
      return
    }
    const maps = this.store?.listMapFiles() ?? []
    if (maps.length === 0) {
      new Notice('库里还没有地图文档：先用「创建地图并绑定到当前 Canvas」建一张。', NOTICE_MAX_MS)
      return
    }
    const mapPath = maps[0]!.path
    const basePath = `${mapPath.replace(/\.map\.md$/i, '')}.base`
    if (this.app.vault.getAbstractFileByPath(basePath)) {
      new Notice(`已存在同名 Base 文件，未覆盖：${basePath}`, NOTICE_MAX_MS)
      return
    }
    try {
      const created = await this.app.vault.create(basePath, buildStarterBaseFile(mapPath))
      new Notice(`已创建 ${created.path}\n打开它，把视图类型切到「地图」。`, NOTICE_MAX_MS)
    } catch (error) {
      console.error('[project-kaki] 创建 Base 文件失败', error)
      new Notice(`创建 Base 文件失败：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
    }
  }

  /**
   * 导出前的统一前置检查：拿到"当前画布 → 地图文档"这条链上的所有东西。
   *
   * 抽出来是因为现在有**三条**导出入口（对话框 / SVG 快捷命令 / PNG 快捷命令），
   * 三处各写一遍前置检查，迟早会出现"其中一条忘了校验"这种最烦人的不一致。
   */
  private resolveExportContext(): { canvasPath: string; mapPath: string; document: MapDocument } | null {
    const handle = activeCanvasHandle(this.app)
    const canvasPath = handle?.file?.path
    if (!canvasPath || !this.layers) {
      new Notice('请先打开一个已启用地图层的 Canvas。', NOTICE_MAX_MS)
      return null
    }
    const mapPath = this.store?.mapFilePathForCanvas(canvasPath)
    const document = this.layers.getDocument(canvasPath)
    if (!mapPath || !document) {
      new Notice('当前 Canvas 没有可导出的地图。请先启用地图层。', NOTICE_MAX_MS)
      return null
    }
    return { canvasPath, mapPath, document }
  }

  /** 当前可见的世界矩形（范围＝「当前视口」时用）；没有可见帧时返回 null 交给范围解析报原因 */
  private currentViewportWorld(canvasPath: string): BBox | null {
    const status = this.layers?.listStatus().find((item) => item.canvasPath === canvasPath)
    return status?.stats?.lastVisibleWorld ?? null
  }

  /**
   * 按指定范围与格式导出当前地图 —— 三条入口共用这一份实现。
   *
   * 范围解析失败（没有区域、没有可见视口……）时**只给一句人话、不产出文件**：
   * 半个空图比没有文件更糟（用户会以为导出成功了）。
   *
   * 返回值是"**文件真的写出来了吗**"：对话框靠它决定要不要留在原地
   * （失败时留着，用户就能换个格式再试；成功或"已经报过原因"时才关窗）。
   * 提示只在这里发一次，所以对话框拿到 `false` 时不需要再说一遍。
   */
  private async exportMapWithRange(range: ExportRange, format: ExportFormat): Promise<boolean> {
    const context = this.resolveExportContext()
    if (!context) return false
    const { canvasPath, mapPath, document } = context

    const resolved = resolveExportBounds(range, {
      document,
      viewportWorld: this.currentViewportWorld(canvasPath),
    })
    if (!resolved.ok) {
      new Notice(`无法导出：${resolved.reason}`, NOTICE_MAX_MS)
      return false
    }

    const basePath = exportFileNameFor(exportBasePathFor(mapPath), range, document)
    const extension = format === 'png' ? '.png' : '.svg'
    const exportPath = uniqueExportPath(basePath, extension, (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null)
    // 现读一次设置：导出必须是"当前地图 + 当前自定义地形"的合成结果
    const svg = buildMapExportSvg(document, EXPORT_WIDTH, EXPORT_HEIGHT, this.getCustomTerrains(), resolved.bounds)

    if (format === 'svg') {
      try {
        const created = await this.app.vault.create(exportPath, svg)
        new Notice(`已导出地图 SVG：${created.path}\n（${resolved.description}）`, NOTICE_MAX_MS)
        void this.app.workspace.openLinkText(created.path, '', false)
        return true
      } catch (error) {
        console.error('[project-kaki] 导出 SVG 失败', error)
        new Notice(`导出 SVG 失败：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
        return false
      }
    }

    try {
      const result = await rasterizeSvgToPng(svg, { width: EXPORT_WIDTH, height: EXPORT_HEIGHT }, this.pngRasterDeps ?? {})
      if (!result.ok) {
        new Notice(`导出 PNG 失败：${result.reason}`, NOTICE_MAX_MS)
        return false
      }
      const created = await this.app.vault.createBinary(exportPath, await result.blob.arrayBuffer())
      new Notice(`已导出地图 PNG：${created.path}\n（${resolved.description}）`, NOTICE_MAX_MS)
      void this.app.workspace.openLinkText(created.path, '', false)
      return true
    } catch (error) {
      console.error('[project-kaki] 导出 PNG 失败', error)
      new Notice(`导出 PNG 失败：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
      return false
    }
  }

  /** 打开「导出地图…」对话框：范围（全部内容 / 当前视口 / 某个区域）+ 格式（SVG / PNG） */
  private openExportModal(): void {
    const context = this.resolveExportContext()
    if (!context) return
    const { canvasPath, document } = context
    const canvasPathForViewport = canvasPath

    this.exportModalFactory(this.app, {
      ranges: EXPORT_RANGE_OPTIONS,
      regions: listExportRegions(document),
      initialRange: { kind: 'all' },
      initialFormat: 'svg',
      describe: (range, format) => {
        const resolved = resolveExportBounds(range, {
          document,
          viewportWorld: this.currentViewportWorld(canvasPathForViewport),
        })
        if (!resolved.ok) return { ok: false, reason: resolved.reason }
        // 摘要里带上将要写入的文件名：用户点"导出"之前就能知道会多出哪个文件
        const name = `${exportFileNameFor(exportBasePathFor(context.mapPath), range, document)}${format === 'png' ? '.png' : '.svg'}`
        return { ok: true, text: `${resolved.description}\n输出文件：${name}（重名时自动加 -2、-3）` }
      },
      onExport: async (range, format) => {
        const done = await this.exportMapWithRange(range, format)
        // 失败时不留 `reason`：具体原因（"这个环境不支持 toBlob"之类）已经由导出那边
        // 发过一条提示了，这里再说一遍只会让用户看到两句意思相同的话。
        return done ? { ok: true as const } : { ok: false as const }
      },
    }).open()
  }

  private async exportActiveMapSvg(): Promise<void> {
    await this.exportMapWithRange({ kind: 'all' }, 'svg')
  }

  /**
   * 导出当前地图为 PNG（快捷入口，相当于对话框里选"全部内容 + PNG"）。
   *
   * 与 SVG 导出**共用同一份几何与配色**：先由 `buildMapExportSvg` 生成 SVG（Base 缩略图也用同一份），
   * 再把它光栅化成位图。这样"导出的图与画布一致"这条承诺只需要维护一处 ——
   * 如果这里另写一套坐标换算，迟早会出现"PNG 与 SVG 长得不一样"。
   */
  private async exportActiveMapPng(): Promise<void> {
    await this.exportMapWithRange({ kind: 'all' }, 'png')
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

  /** 当前自定义地形（地图层、工具条、Base 缩略图、导出都现读它） */
  getCustomTerrains(): readonly CustomTerrain[] {
    return this.pluginSettings.customTerrains
  }

  /**
   * 新增一个自定义地形。
   *
   * 全部校验在 `validateCustomTerrainInput` 里（纯函数），这里只负责落盘与通知渲染层。
   * 重名（同一个 ID）会被拒绝并给出可读原因：**同一个 ID 两条定义**会让"画上去是哪个颜色"
   * 变成一个说不清的问题（解析层按先出现的胜出，但用户看不出顺序）。
   */
  async addCustomTerrain(input: {
    id: unknown
    label?: unknown
    color?: unknown
    glyph?: unknown
    imagePath?: unknown
    mode?: unknown
    imageLayout?: unknown
  }): Promise<{ ok: true } | { ok: false; problem: string }> {
    const result = validateCustomTerrainInput(input)
    if (!result.ok) return result
    if (this.pluginSettings.customTerrains.some((terrain) => terrain.id === result.terrain.id)) {
      return { ok: false, problem: `已经有一个地形用了 ID ${result.terrain.id}` }
    }
    if (this.pluginSettings.customTerrains.length >= MAX_CUSTOM_TERRAINS) {
      return { ok: false, problem: `最多 ${MAX_CUSTOM_TERRAINS} 个自定义地形` }
    }
    this.pluginSettings = {
      ...this.pluginSettings,
      customTerrains: [...this.pluginSettings.customTerrains, result.terrain],
    }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
    return { ok: true }
  }

  /**
   * 改一个自定义地形（按下标定位，因为 ID 不可改）。
   *
   * 只接受"补丁"：显示名、颜色、字形、图片路径。ID 不在补丁里 ——
   * 改 ID 等于把地图文件里已有的格子指向另一个地形，那不是编辑而是数据迁移，
   * 必须显式做成一个功能，不能顺手提供。
   */
  async updateCustomTerrain(
    index: number,
    patch: {
      label?: unknown
      color?: unknown
      glyph?: unknown
      imagePath?: unknown
      mode?: unknown
      imageLayout?: unknown
    },
  ): Promise<void> {
    const current = this.pluginSettings.customTerrains[index]
    if (!current) return
    const next = validateCustomTerrainInput({
      id: current.id,
      label: patch.label !== undefined ? patch.label : current.label,
      color: patch.color !== undefined ? patch.color : current.color,
      glyph: patch.glyph !== undefined ? patch.glyph : current.glyph,
      imagePath: patch.imagePath !== undefined ? patch.imagePath : current.imagePath,
      // 只切模式时其余字段原样带着走 —— 于是"切回去"不会丢配置（用户来回切不会白配一遍）
      mode: patch.mode !== undefined ? patch.mode : current.mode,
      imageLayout: patch.imageLayout !== undefined ? patch.imageLayout : current.imageLayout,
    })
    if (!next.ok) {
      console.warn(`[project-kaki] 自定义地形 ${current.id} 的修改被拒绝：${next.problem}`)
      return
    }
    const list = [...this.pluginSettings.customTerrains]
    list[index] = next.terrain
    this.pluginSettings = { ...this.pluginSettings, customTerrains: list }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /**
   * 删除一个自定义地形。
   *
   * **不动地图数据**：已经画了这个地形的格子仍然留在文件里，只是画成回退样式。
   * 反过来做（顺手把格子删掉）是不可逆的，而且用户只是想改个颜色而已。
   */
  async removeCustomTerrain(index: number): Promise<void> {
    const current = this.pluginSettings.customTerrains[index]
    if (!current) return
    this.pluginSettings = {
      ...this.pluginSettings,
      customTerrains: this.pluginSettings.customTerrains.filter((_terrain, i) => i !== index),
    }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /** 当前自定义标记（地图层、工具条、放置对话框都现读它） */
  getCustomMarkers(): readonly CustomMarker[] {
    return this.pluginSettings.customMarkers
  }

  /**
   * 新增一个自定义标记。
   *
   * 与 `addCustomTerrain` 逐字同构：校验全在 `validateCustomMarkerInput` 里（纯函数），
   * 这里只落盘 + 通知渲染层。重名会被拒绝并给出可读原因 ——
   * **同一个 ID 两条定义**会让"画上去是哪个图标"变成说不清的问题。
   */
  async addCustomMarker(input: {
    id: unknown
    label?: unknown
    icon?: unknown
    imagePath?: unknown
    mode?: unknown
  }): Promise<{ ok: true } | { ok: false; problem: string }> {
    const result = validateCustomMarkerInput(input)
    if (!result.ok) return result
    if (this.pluginSettings.customMarkers.some((marker) => marker.id === result.marker.id)) {
      return { ok: false, problem: `已经有一个标记用了 ID ${result.marker.id}` }
    }
    if (this.pluginSettings.customMarkers.length >= MAX_CUSTOM_MARKERS) {
      return { ok: false, problem: `最多 ${MAX_CUSTOM_MARKERS} 个自定义标记` }
    }
    this.pluginSettings = {
      ...this.pluginSettings,
      customMarkers: [...this.pluginSettings.customMarkers, result.marker],
    }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
    return { ok: true }
  }

  /**
   * 改一个自定义标记（按下标定位，因为 ID 不可改）。
   *
   * 只接受"补丁"，且**只切模式时其余字段原样带着走** ——
   * 于是"字形 ↔ 图片"来回切不会丢配置（切回去时之前选的图还在）。
   */
  async updateCustomMarker(
    index: number,
    patch: { label?: unknown; icon?: unknown; imagePath?: unknown; mode?: unknown },
  ): Promise<void> {
    const current = this.pluginSettings.customMarkers[index]
    if (!current) return
    const next = validateCustomMarkerInput({
      id: current.id,
      label: patch.label !== undefined ? patch.label : current.label,
      icon: patch.icon !== undefined ? patch.icon : current.icon,
      imagePath: patch.imagePath !== undefined ? patch.imagePath : current.imagePath,
      mode: patch.mode !== undefined ? patch.mode : current.mode,
    })
    if (!next.ok) {
      console.warn(`[project-kaki] 自定义标记 ${current.id} 的修改被拒绝：${next.problem}`)
      return
    }
    const list = [...this.pluginSettings.customMarkers]
    list[index] = next.marker
    this.pluginSettings = { ...this.pluginSettings, customMarkers: list }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
  }

  /**
   * 删除一个自定义标记。
   *
   * **不动地图数据**：地图上已经用了这个图标的标记仍然留在文件里，只是画成回退视觉。
   * 与删除自定义地形同一条承诺（见各文档里的"认不出 ≠ 丢弃"）。
   */
  async removeCustomMarker(index: number): Promise<void> {
    const current = this.pluginSettings.customMarkers[index]
    if (!current) return
    this.pluginSettings = {
      ...this.pluginSettings,
      customMarkers: this.pluginSettings.customMarkers.filter((_marker, i) => i !== index),
    }
    await this.saveData(this.pluginSettings)
    this.layers?.setStylePalette()
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

  /** 样式恢复出厂（设置页的「恢复默认」）—— **不动自定义地形**：那是数据，不是样式偏好 */
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

  /**
   * 切换某个图层的显示。
   *
   * 顺序是刻意的：**改内存 → 立刻广播 → 再落盘**。
   * 广播不能等 `await saveData(...)`：工具条上的「名称」按钮是同步点下去的，
   * 等落盘再广播意味着"点了之后下一帧仍然画着名称"（而且测试里同步断言也拿不到新值）。
   * 落盘是后台的事，它慢一点不影响画面。
   *
   * 这里**是网格、名称等开关的唯一入口**：老代码里那个独立的 `setShowGrid`
   * 只是它的薄包装，现在已经删掉 —— 留着会让"网格状态"有两个写入口。
   */
  async setLayerVisible(key: LayerKey, value: boolean): Promise<void> {
    const next = value === true
    const layers = withLayerVisibility(this.pluginSettings.layers, key, next)
    if (layers === this.pluginSettings.layers) return
    this.pluginSettings = { ...this.pluginSettings, layers }
    this.layers?.setLayers()
    // 面板自己也显示这六个开关：工具条按钮、设置页、命令都能改图层，
    // 所以刷新要在这里做（而不是只让"点面板的那一次"自己刷新），否则会出现
    // "从别处改了图层，面板上的开关还亮着旧状态"。requestRender 会把同帧的重复请求合并掉。
    this.refreshPanel()
    await this.saveData(this.pluginSettings)
  }

  async setShowLegend(value: boolean): Promise<void> {
    const next = value === true
    if (next === this.pluginSettings.showLegend) return
    this.pluginSettings = { ...this.pluginSettings, showLegend: next }
    this.layers?.setLayers()
    await this.saveData(this.pluginSettings)
  }

  /** 替换放置对话框（自动化测试用；不改动则为真实的输入对话框） */
  setPlaceModalFactory(factory: PlaceModalFactory): void {
    this.placeModalFactory = factory
  }

  /** 替换命名对话框（自动化测试用；不改动则为真实的输入对话框） */
  setPromptModalFactory(factory: PromptModalFactory): void {
    this.promptModalFactory = factory
  }

  /**
   * 替换报告面板（自动化测试用；不改动则为真实的报告对话框）。
   *
   * 替换后仍可通过读回 `reportModalFactory` 拿到**默认实现**再自行实例化 ——
   * 冒烟就是这么做"真实面板按钮"那几条断言的（注入替身拿正文，默认工厂拿真面板验按钮）。
   */
  setReportModalFactory(factory: ReportModalFactory): void {
    this.reportModalFactory = factory
  }

  /**
   * 替换图片选择器（自动化测试用；不改动则为真实的库内文件选择弹窗）。
   *
   * 同 `setReportModalFactory`：替换后仍可读回 `imagePickerFactory` 拿到默认实现，
   * 于是冒烟既能精确控制"用户选了哪一项"，又能顺手验证真实弹窗自己的清单与标签。
   */
  setImagePickerFactory(factory: ImagePickerFactory): void {
    this.imagePickerFactory = factory
  }

  /**
   * 让用户从库里挑一张图片；选中后交给 `onChoose`（**路径校验由调用方或本方法兜底**）。
   *
   * 三条退化路径都给了明确反馈，而不是静默什么都不做：
   * - 库里没有可用图片 → 一条可读提示（告诉他支持哪些格式、先把图放进库），**不弹空列表**；
   * - 弹窗构造失败（例如基类缺失）→ 控制台留错 + 一条提示；
   * - 用户取消 → 什么都不做（这是正常操作，不该报错）。
   */
  pickImageFile(options: { title?: string; onChoose: (path: string) => void }): void {
    const paths = this.app.vault.getFiles().map((file) => file.path)
    const images = listImagePaths(paths)
    if (images.length === 0) {
      new Notice(emptyImageListHint(), NOTICE_MAX_MS)
      return
    }
    const pickerOptions: AssetPickerOptions = {
      files: images,
      ...(options.title !== undefined ? { title: options.title } : {}),
      onChoose: options.onChoose,
    }
    try {
      this.imagePickerFactory(this.app, pickerOptions).open()
    } catch (error) {
      console.error('[project-kaki] 打开图片选择器失败', error)
      new Notice(
        `打开图片选择器失败：${error instanceof Error ? error.message : String(error)}\n可以直接把库内路径填进输入框。`,
        NOTICE_MAX_MS,
      )
    }
  }

  // ------------------------------------------------------------ 报告面板

  /**
   * 打开报告面板（地图状态报告与诊断报告共用）。
   *
   * 为什么不用 `Notice`：见 `ReportModal` 顶部注释 —— 多行文本在 Notice 里盖住右上角、
   * 十几秒才消失、而且**选不中复制不了**。这里把"看/复制/导出"三件事一次给全，
   * 只留一条 ≤4 秒的结果提示。
   */
  private openReport(options: ReportModalOptions): void {
    const wired: ReportModalOptions =
      options.fileName !== undefined
        ? { ...options, onExport: (fileName, text) => this.exportReportFile(fileName, text) }
        : options
    try {
      this.reportModalFactory(this.app, wired).open()
    } catch (error) {
      // 面板打不开时不能让报告消失：否则这次排查就白做了（把正文与控制台都留下）
      console.error('[project-kaki] 打开报告面板失败', error)
      console.log(options.text)
      new Notice('无法打开报告面板，报告已打印到开发者控制台（Ctrl/Cmd+Shift+I）。', NOTICE_MAX_MS)
    }
  }

  /**
   * 把报告写到库内文件。
   *
   * 重名规则与 SVG / PNG 导出**共用同一份实现**（`uniqueExportPath`）：
   * 三处各写一遍 `-2/-3` 的循环，迟早会分叉成三种行为。
   * 这里用 `create` 而不是"存在就覆盖"：报告是越攒越多的东西，覆盖等于悄悄丢掉上一份。
   */
  private async exportReportFile(fileName: string, text: string): Promise<string> {
    // 这里**不能**用 `exportBasePathFor`：它只认地图文档的 `.map.md`
    // （`Maps/World.map.md` → `Maps/World`），而报告名本来就是 `xxx.md`，
    // 传进去会得到 `xxx.md.md`。去扩展名这件事各按各的规则做，重名规则再共用。
    const basePath = fileName.replace(/\.md$/i, '')
    const path = uniqueExportPath(basePath, '.md', (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null)
    await this.app.vault.create(path, text)
    return path
  }

  /**
   * 注入 PNG 光栅化的环境依赖（自动化测试用；传 `null` 恢复真实实现）。
   *
   * 真实实现要 `Image` + `canvas.toBlob`，测试环境里跑不出来；而"成功时写入的字节对不对"
   * 与"失败时给的是不是人话"是最该测的两件事，所以留这个口子。
   */
  setPngRasterizer(deps: PngRasterDeps | null): void {
    this.pngRasterDeps = deps
  }

  /**
   * 替换导出对话框工厂（自动化测试用；传 `null` 恢复真实对话框）。
   *
   * 与图片选择器、报告面板同一套路：测试要断言的是"选了范围与格式之后产出对不对"，
   * 而不是去模拟对话框里的点击 —— 所以换掉工厂、直接驱动那几个选项。
   */
  setExportModalFactory(factory: ExportModalFactory | null): void {
    this.exportModalFactory = factory ?? ((app, options) => new ExportModal(app, options))
  }

  // ------------------------------------------------------------ 地图层

  private async toggleMapLayer(): Promise<void> {
    const layers = this.layers
    if (!layers) return

    const handle = activeCanvasHandle(this.app)
    const canvasPath = handle?.file?.path
    if (!handle || !canvasPath) {
      new Notice('请先打开一个 .canvas 文件。', NOTICE_MAX_MS)
      return
    }

    if (layers.isEnabled(canvasPath)) {
      layers.disable(canvasPath)
      new Notice(`已停用 ${canvasPath} 的地图层。`, NOTICE_MAX_MS)
      return
    }

    const status = await layers.enable(handle)
    if (!status.attached) {
      new Notice(`未能启用地图层：${status.reason ?? '未知原因'}`, NOTICE_MAX_MS)
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
      NOTICE_MAX_MS,
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
      new Notice('请先打开一个 .canvas 文件，再运行「创建地图并绑定到当前 Canvas」。', NOTICE_MAX_MS)
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
      new Notice(`已创建地图：${file.path}（已绑定 ${canvasPath}）`, NOTICE_MAX_MS)
      await this.app.workspace.getLeaf(true).openFile(file)
    } catch (error) {
      console.error('[project-kaki] 创建地图失败', error)
      new Notice(`创建地图失败：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
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
        NOTICE_MAX_MS,
      )
      return
    }

    const mapPath = store.mapFilePathForCanvas(canvasPath)
    if (mapPath === null) {
      const count = store.listMapFiles().length
      new Notice(
        `${canvasPath} 尚未绑定地图文档。\n运行「创建地图并绑定到当前 Canvas」新建一张（库内现有 ${count} 张地图）。`,
        NOTICE_MAX_MS,
      )
      return
    }

    const abstract = this.app.vault.getAbstractFileByPath(mapPath)
    if (!(abstract instanceof TFile)) {
      new Notice(`地图文档不存在或不是文件：${mapPath}`, NOTICE_MAX_MS)
      return
    }

    const loaded = await store.load(abstract)
    if (loaded.document === null) {
      const firstError = loaded.issues.find((issue) => issue.level === 'error')
      new Notice(`地图加载失败：${firstError?.message ?? '未知原因'}\n详见开发者控制台。`, NOTICE_MAX_MS)
      console.log('[project-kaki] 地图加载问题：', loaded.issues)
      return
    }

    const summary = summarizeMapDocument(loaded.document)
    const warnings = loaded.issues.filter((issue) => issue.level === 'warning')
    const sizeKiB = (new TextEncoder().encode(loaded.rawText).length / 1024).toFixed(1)
    // 地形分类：内置保持原来的 `forest×2` 形式（既有报告格式不变 —— 用户不该为了新功能
    // 重新适应一份报告）；自定义地形补上显示名与原始 ID，未知 ID 直接报出它是未知的。
    const custom = this.getCustomTerrains()
    const breakdown =
      summary.terrainBreakdown
        .map((item) => {
          if (isBuiltinTerrain(item.type)) return `${item.type}×${item.count}`
          const style = resolveTerrainStyle(item.type, custom)
          const name = style.unknown ? style.label : `${style.label}(${item.type})`
          return `${name}×${item.count}`
        })
        .join(' ') || '无'

    // 报告进面板，不再用 15 秒的 Notice：那份文本是要**看**与**复制**的，
    // 而 Notice 会盖住右上角的侧边栏按钮、等很久才消失、文字还选不中（用户的原始反馈）。
    this.openReport({
      title: '地图状态报告',
      text: [
        `地图：${mapPath}`,
        `版本 v${loaded.document.version}${loaded.readOnly ? '（只读：版本高于本插件）' : ''}`,
        `网格：${loaded.document.grid.orientation} · 边长 ${loaded.document.grid.size}`,
        `地形 ${summary.cells} 格（${breakdown}）`,
        `标记 ${summary.markers} · 路径 ${summary.paths} · 区域 ${summary.regions} · 文字 ${summary.labels}`,
        `文件 ${sizeKiB} KiB · 告警 ${warnings.length} 条`,
        this.describeLabelSize(),
        // 图层与图例：让"地图怎么少了东西"有一个可查的答案
        this.describeLayers(),
        ...this.describeLegend(canvasPath),
        warnings.length > 0 ? '告警详情见控制台。' : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      // 导出文件名基于地图基础名：`Maps/Los.map.md` → `Maps/Los-状态报告.md`
      fileName: `${exportBasePathFor(mapPath)}-状态报告.md`,
    })
    if (loaded.issues.length > 0) console.log('[project-kaki] 地图问题：', loaded.issues)
  }

  /**
   * 当前隐藏了哪些图层（状态命令用）。
   *
   * 为什么值得单独报一行：用户看不到某个东西时的第一反应是"我的数据是不是没了"，
   * 而真相往往只是某个图层被关掉了。让它可查，比让人去猜便宜得多。
   */
  private describeLayers(): string {
    const hidden = hiddenLayerLabels(this.pluginSettings.layers)
    if (allLayersHidden(this.pluginSettings.layers)) {
      return '图层：全部隐藏（地图上看不到任何东西，这是设置导致的，数据仍在）'
    }
    return hidden.length === 0 ? '图层：全部显示' : `图层：已隐藏 ${hidden.join(' / ')}`
  }

  /** 图例条目（从地图实际内容生成；受图层开关约束） */
  private describeLegend(canvasPath: string): string[] {
    const entries = this.layers?.buildLegendFor(canvasPath) ?? []
    if (entries.length === 0) return ['图例：（地图还是空的，或相关图层被隐藏）']
    return ['图例：', ...legendLines(entries).map((line) => `  ${line}`)]
  }

  // ------------------------------------------------------------ Phase 0 探针
  /**
   * 诊断当前 Canvas。
   *
   * 报告与状态报告走**同一个面板**（`openReport`）：这里不再自动复制剪贴板、也不再自动写文件 ——
   * 那两件事现在是面板上的两个按钮，由用户决定要不要做、做到哪里。
   * 理由：自动复制对"只想看一眼"的人是噪音，而自动写文件会在库里留下没人清理的 `FC-diagnostics.md`。
   * 控制台那份日志保留：排查时它是最快的入口（`Ctrl/Cmd+Shift+I`）。
   */
  private async runDiagnostics(): Promise<void> {
    const { handles } = findCanvasHandles(this.app)
    if (handles.length === 0) {
      new Notice('没有已打开的 Canvas 文件：请先打开一个 .canvas，再运行诊断。', NOTICE_MAX_MS)
      return
    }

    const report = buildDiagnosticReport(this.app)
    console.log(report)
    this.openReport({
      title: '诊断报告（Phase 0 探针）',
      text: report,
      // 沿用原来的固定文件名：老用户会去库里找这个名字
      fileName: DIAGNOSTIC_FALLBACK_PATH,
    })
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
        NOTICE_MAX_MS,
      )
      return
    }

    const status = startViewportWatch(this.app)
    if (!status.patched) {
      new Notice(`监视启动失败：${status.message}`, NOTICE_MAX_MS)
      return
    }
    new Notice(`开始在 ${status.canvasPath} 上监视视口变化。\n现在去平移/缩放画布，然后再次运行本命令查看计数。`, NOTICE_MAX_MS)
  }
}
