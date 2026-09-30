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
import { summarizeMapDocument, MAP_DOCUMENT_VERSION, type MapDefinitions, type MapDocument } from './data/mapDocument.ts'
import {
  definitionSetFromBlock,
  definitionSetFromLibrary,
  definitionsBlockOf,
  isFactoryDefinitionSet,
  type MapDefinitionSet,
} from './data/mapDefinitions.ts'
import { buildDiagnosticReport, type DiagnosticRuntime } from './dev/diagnostics.ts'
import { disposeViewportWatch, getWatchStatus, startViewportWatch, stopViewportWatch } from './dev/viewport-watch.ts'
import { MapEditor } from './editor/MapEditor.ts'
import { MapLayerManager } from './render/MapLayerManager.ts'
import { buildMapExportSvg, describeOverlayExport, type OverlayExportNote } from './base/mapPreview.ts'
import { lucideIconFragment } from './render/lucideFragment.ts'
import {
  EXPORT_RANGE_OPTIONS,
  exportFileNameFor,
  exportTargetProblem,
  joinExportTarget,
  listExportRegions,
  resolveExportBounds,
  stripExportExtension,
  type ExportRange,
} from './base/exportBounds.ts'
import { exportBasePathFor, rasterizeSvgToPng, uniqueExportPath, type PngRasterDeps } from './base/pngExport.ts'
import {
  ExportModal,
  type ExportFormat,
  type ExportModalFactory,
  type ExportTarget,
} from './ui/ExportModal.ts'
import type { BBox } from './core/viewport.ts'
import type { Point } from './core/hex.ts'
import { PlaceMarkerModal, type PlaceModalFactory } from './ui/PlaceMarkerModal.ts'
import { ReportModal, type ReportModalFactory, type ReportModalOptions } from './ui/ReportModal.ts'
import { AssetSuggestModal, type AssetPickerKind, type AssetPickerOptions, type ImagePickerFactory } from './ui/AssetSuggestModal.ts'
import { MapPanelView, MAP_PANEL_VIEW_TYPE, type BatchEditInfo, type PluginAction } from './ui/MapPanel.ts'
import type { ToolControlsHost } from './ui/toolSections.ts'
import { resolveVaultResourceUrl } from './base/vaultResource.ts'
import { COMMAND_NAMES, DIALOG_LABELS, NOTICES, SELECTION_TEXT, STATUS_SECTIONS } from './ui/strings.ts'
import type { SelectionFieldValue } from './editor/selection.ts'
import { SELECTION_KINDS } from './editor/selection.ts'
import {
  CartographerSettingTab,
  normalizeExportFolder,
  normalizeLabelScale,
  normalizeSettings,
  paletteOf,
  type CartographerSettings,
  type MapViewSettings,
} from './ui/SettingsTab.ts'
import { normalizeFontFamily, normalizeColor, type StylePalette } from './render/stylePalette.ts'
import {
  MAX_CUSTOM_PATH_TYPES,
  applyPathTypePatch,
  customPathTypeEntries,
  normalizePathTypeEntries,
  pathColorsFromEntries,
  resetPathTypeStyles,
  validateCustomPathTypeInput,
  type PathTypeEntry,
  type PathTypePatch,
} from './render/pathTypeCatalog.ts'
import {
  MAX_CUSTOM_REGION_TYPES,
  applyRegionTypePatch,
  customRegionTypeEntries,
  isBuiltinRegionType,
  normalizeRegionTypeEntries,
  regionColorsFromEntries,
  resetRegionTypeStyles,
  validateCustomRegionTypeInput,
  type RegionTypeEntry,
  type RegionTypePatch,
} from './render/regionTypeCatalog.ts'
import {
  allLayersHidden,
  hiddenLayerLabels,
  withLayerVisibility,
  type LayerKey,
  type LayerVisibility,
} from './render/layerVisibility.ts'
import { legendLines } from './render/legend.ts'
import {
  normalizeOverlayStyles,
  numericDefaultRows,
  overlayField,
  OVERLAY_FIELDS,
  type CategoryOverlayFieldSpec,
  type FieldId,
  type OverlayStyle,
  type OverlayStyles,
} from './render/overlayFields.ts'
import { describeDataDefaults, unknownDefaultKeys } from './render/dataDefaults.ts'
import {
  assetFolderOf,
  assetNameOf,
  emptyBundleListHint,
  emptyImageListHint,
  emptyNoteListHint,
  listBundlePaths,
  listFolderPaths,
  listImagePaths,
  listNotePaths,
} from './base/assetFiles.ts'
import {
  MAX_CUSTOM_TERRAINS,
  isBuiltinTerrain,
  resolveTerrainStyle,
  validateCustomTerrainInput,
  type CustomTerrain,
} from './render/terrainCatalog.ts'
import { isBlankCustomId, suggestCustomId } from './render/customDefinitionId.ts'
import {
  DEFINITION_KIND_LABELS,
  countReferences,
  definitionIdNormalize,
  definitionIdProblem,
  definitionKindFieldHint,
  describeDeletionPlan,
  describeRenamePlan,
  renameDefinitionEntry,
  renameReferences,
  type DefinitionKind,
  type DeletionFilePlan,
  type RenameFilePlan,
} from './render/definitionRename.ts'
import {
  RenameDefinitionModal,
  type RenameModalFactory,
  type RenameOutcome,
  type RenamePreview,
} from './ui/RenameDefinitionModal.ts'
import { DefinitionManagerModal, type DefinitionModalFactory } from './ui/DefinitionManagerModal.ts'
import {
  ConfirmDefinitionDeleteModal,
  type ConfirmDeleteModalFactory,
} from './ui/ConfirmDefinitionDeleteModal.ts'
import { CUSTOM_MARKER_PREFIX } from './render/markerCatalog.ts'
import { listResolvedMarkerStyles } from './render/markerCatalog.ts'
import { listResolvedTerrainStyles } from './render/terrainCatalog.ts'
import { parsePathDashInput } from './render/pathTypeCatalog.ts'
import { CUSTOM_PATH_TYPE_PREFIX } from './render/pathTypeCatalog.ts'
import { CUSTOM_REGION_TYPE_PREFIX } from './render/regionTypeCatalog.ts'
import { CUSTOM_TERRAIN_PREFIX } from './render/terrainCatalog.ts'
import { defaultMapNameFromPath } from './data/mapFile.ts'
import { MAX_CUSTOM_MARKERS, validateCustomMarkerInput, type CustomMarker } from './render/markerCatalog.ts'
import { formatCalibration } from './render/elevationUnits.ts'

import {
  buildResourceBundle,
  bundleFileName,
  describeImportPlan,
  describeImportResult,
  parseResourceBundle,
  planBundleImport,
  serializeResourceBundle,
  type BundleImportPlan,
} from './render/resourceBundle.ts'
import {
  ImportBundleModal,
  type ImportBundleModalFactory,
  type ImportBundleOutcome,
} from './ui/ImportBundleModal.ts'
import { TextPromptModal, type TextPromptOptions } from './ui/TextPromptModal.ts'
import {
  ElevationCalibrationModal,
  type ElevationModalFactory,
} from './ui/ElevationCalibrationModal.ts'
import { DataDefaultsModal, type DataDefaultsModalFactory } from './ui/DataDefaultsModal.ts'
import { SelectionFilterModal, type SelectionFilterModalFactory } from './ui/SelectionFilterModal.ts'
import {
  BIOME_TAGS,
  CUSTOM_BIOME_PREFIX,
  listResolvedBiomeStyles,
  resolveBiomeStyle,
  type CustomBiome,
} from './render/biomeCatalog.ts'
import { clauseIsUsable, type SelectionRuleContext } from './render/selectionRules.ts'
import { applyRuleToSelection, describeCellReadings, ruleHits, summarizeSelection, type SelectionSummary } from './render/selectionSet.ts'
import { selectionStatRows } from './render/selectionCard.ts'

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

/**
 * 定义编辑 / 搬运的**目标**（"当前地图"）：画布路径 + 它绑定的地图文件 + 那张画布的地图层编辑器。
 *
 * 抽成具名的类型是因为它有了**第二个用途**（W4-3）：导入对话框先告诉用户"导入到哪张图"，
 * 提交时必须写同一张 —— 于是这个形状要能从 `definitionTarget()` 一路传到 `mutateDefinitions`。
 */
interface DefinitionTarget {
  canvasPath: string
  mapPath: string
  /** `null` = 这张画布没启用地图层（那就直接读改写盘） */
  editor: MapEditor | null
}

export default class ProjectKakiPlugin extends Plugin {
  private store: MapDocumentStore | null = null
  /** 「改 ID…」对话框：默认用真实实现，测试里可注入替身 */
  private renameModalFactory: RenameModalFactory = (app, options) => new RenameDefinitionModal(app, options)
  /**
   * 「地图定义」弹窗（A3：四类定义的增删改从设置页搬到这里）。
   *
   * 默认工厂写成惰性闭包：真实弹窗只在"真的被打开"时构造，冒烟可以注入替身绕开假 DOM，
   * 也可以读回这个默认工厂再自行实例化（与 `reportModalFactory` 同一手法）。
   */
  private definitionModalFactory: DefinitionModalFactory = (app, plugin) =>
    new DefinitionManagerModal(app, plugin)
  /**
   * 「删除定义」确认框（**只在有地图引用它时**才弹，见 `requestRemoveCustomDefinition`）。
   *
   * 同样是惰性默认工厂：没有引用的删除走的是"直接删"这条快路，根本不碰这个工厂。
   */
  private deleteModalFactory: ConfirmDeleteModalFactory = (app, options) =>
    new ConfirmDefinitionDeleteModal(app, options)
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
  /**
   * 导入定义文件对话框工厂（仅自动化测试注入；默认就是真实对话框）。
   *
   * 与导出对话框同一套路（惰性默认工厂）：冒烟要断言的是"这份文件导入之后设置变成了什么"，
   * 而不是去模拟对话框里的点击，所以换掉工厂就能直接驱动它拿到的计划正文。
   */
  private importModalFactory: ImportBundleModalFactory = (app, options) => new ImportBundleModal(app, options)
  /**
   * 海拔标定对话框工厂（仅自动化测试注入；默认就是真实对话框）。
   *
   * 与导出 / 导入对话框同一套路（惰性默认工厂）：冒烟要断言的是"标定写进地图文件之后
   * 读数与撤销是什么样"，而不是去模拟对话框里的敲键。
   */
  private elevationModalFactory: ElevationModalFactory = (app, options) =>
    new ElevationCalibrationModal(app, options)
  /** 每格默认值对话框工厂（同上：仅自动化测试注入，默认是真实对话框） */
  private dataDefaultsModalFactory: DataDefaultsModalFactory = (app, options) =>
    new DataDefaultsModal(app, options)
  private selectionFilterModalFactory: SelectionFilterModalFactory = (app, options) =>
    new SelectionFilterModal(app, options)
  /**
   * 设置页实例：导入之后要让已经打开的设置页也跟着刷新（否则用户会看到一份过时的列表）。
   *
   * 保留引用是必须的：`addSettingTab` 不返回实例，而 Obsidian 只在用户打开设置时才调 `display()`。
   */
  private settingTab: CartographerSettingTab | null = null
  /** 不能用 `settings` 这个名字：Obsidian 的 Plugin 基类已经有同名成员 */
  private pluginSettings: CartographerSettings = normalizeSettings(null)
  /** `libraryDefinitionSet()` 的备忘（键 = `pluginSettings` 的对象身份，见该方法） */
  private librarySetCache: { source: CartographerSettings; set: MapDefinitionSet } | null = null
  /**
   * `definitionsOf()` 的备忘（键 = 那份文档里 `definitions` 块的对象身份）。
   *
   * 用 `WeakMap`：块是短命对象（每次写入都换一个新的），弱引用让它自然回收，
   * 不需要任何失效逻辑 —— 这正是"缓存键必须是被缓存内容的身份"这条纪律的落法。
   */
  private readonly documentSetCache = new WeakMap<object, MapDefinitionSet>()
  /**
   * 为「地图定义」弹窗读盘得到的文档（键 = 地图路径）。
   *
   * 用途只有一个：让弹窗的**首帧**在"画布绑了地图、但没开地图层"时也能一次画对
   * （同步读不到盘，见 `syncCurrentDefinitionSet`）。不是文档缓存 —— 权威始终是文件。
   */
  private readonly definitionDocCache = new Map<string, MapDocument>()
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
      // 样式（名称字体族）：地图层每帧现读，改完设置立刻生效。
      // ⚠️ 区域颜色**不在这里**了：它住在区域类型目录里（`getRegionTypes`）
      getStylePalette: () => this.getStylePalette(),
      // 五类定义目录：**按地图解析**（v2 的 `definitions` 段）—— 多画布同开时
      // A 图的定义不许污染 B 图，所以参数是"要哪张地图的定义"（见 `definitionsOf`）
      getPathTypes: (document) => this.definitionsOf(document).pathTypes,
      getRegionTypes: (document) => this.definitionsOf(document).regionTypes,
      getCustomTerrains: (document) => this.definitionsOf(document).terrains,
      getCustomMarkers: (document) => this.definitionsOf(document).markers,
      // 自定义生物群系：只影响**颜色解析**（分类字段上色与图例）—— 值本身在地图文件里
      getCustomBiomes: (document) => this.definitionsOf(document).biomes,
      // 画布工具条上的「筛选…」按钮 → 插件层的对话框（地图层不认识插件，只能从这里往上要）
      onOpenSelectionFilter: () => this.openSelectionFilterModal(),
      // 选中项变了：侧栏检查器要立刻跟着变（面板在另一棵树里，只能由插件层转发）
      onSelectionChanged: () => this.refreshPanel(),
      // 编辑器状态变了（模式 / 工具 / 笔刷层 / 半径 / 框选方式）：侧栏那三节控件画的就是它
      onEditorStateChanged: () => this.refreshPanel(),
      // 图层与图例：同样每帧现读。**网格也在 layers 里**（不再有第二个 showGrid 通道）。
      // W4-2：三者都**按画布自己那张地图**解析（多画布同开时不许看"谁是活动画布"）。
      // 图层 / 图例的**写入口**不在这里：画布上的按钮已经删掉，改开关走侧栏面板与命令
      // （`MapPanelDeps.onToggleLayer` / `onToggleLegend`）—— 于是"一个开关只有一个家"。
      getLayers: (canvasPath) => this.layersFor(this.mapPathForCanvas(canvasPath)),
      // 数值图层样式（配色 / 不透明度）：同样每帧现读 —— 改配色下一帧就是新颜色
      getOverlayStyles: (canvasPath) => this.overlaysFor(this.mapPathForCanvas(canvasPath)),
      getShowLegend: (canvasPath) => this.showLegendFor(this.mapPathForCanvas(canvasPath)),
    })

    this.settingTab = new CartographerSettingTab(this.app, this)
    this.addSettingTab(this.settingTab)

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
        // 「地图定义」弹窗那份"为读盘留的一份"在这里失效：它在别的编辑器改过这张图之后就是旧的。
        // 影响面很小（弹窗首帧，随后会被异步读到的那一份纠正），但缓存该失效就得失效 ——
        // 缓存键既然绑在路径上，路径上发生的事就应该让它作废。
        this.definitionDocCache.delete(file.path)
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
        name: COMMAND_NAMES.openPanel,
        icon: 'sidebar-right',
        group: 'panel',
        /**
         * **不进侧栏面板**（`panelHidden`，与导入 / 导出定义文件同一套做法）：
         * 这个动作是"把面板打开"，而面板里点它时面板本来就开着 ——
         * `activatePanel()` 的两条路（`revealLeaf` 已可见的 leaf + `refreshPanel()`）
         * 都不会产生任何可见变化 ⇒ 面板里长出一个**天然无意义**的按钮。
         * 命令面板与左侧 ribbon 图标照旧保留（那两处点了才有意义）。
         */
        panelHidden: true,
        run: () => this.activatePanel(),
      },
      {
        id: 'toggle-map-layer',
        name: COMMAND_NAMES.toggleLayer,
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
        // 地图级元数据（当前地图最深多深、最高多高）—— 深度的"相对值"读数靠它锚定。
        // 归 `map` 组：它作用在**当前地图**上（不是插件设置），与"启用/停用地图层"同类。
        id: 'set-elevation-calibration',
        name: '设置海拔标定…',
        icon: 'mountain',
        group: 'map',
        available: hasLayer,
        describe: () => {
          const calibration = this.layers?.getActiveDocument()?.elevation ?? null
          return calibration === null ? '当前地图未标定（相对值读数不可用）' : formatCalibration(calibration)
        },
        run: () => this.openElevationCalibrationModal(),
      },
      {
        // 每格默认值：也是"地图级的事实"（没量过值的格用哪个数兜底）→ 归 `map` 组、写进地图文件。
        // 它**只影响渲染**：文件里的格一个字节都不改，所以改完立刻全图生效（§B）。
        id: 'set-data-defaults',
        name: '设置数值图层默认值…',
        icon: 'thermometer',
        group: 'map',
        available: hasLayer,
        describe: () => {
          const document_ = this.layers?.getActiveDocument() ?? null
          if (!document_) return '需要先启用地图层'
          return describeDataDefaults(document_.dataDefaults ?? null, this.defaultRowEntries())
        },
        run: () => this.openDataDefaultsModal(),
      },
      {
        // 选择系统的**筛选器**（施工文件 §C.2）：UI 子句构建器 + 替换/并入/移出/在当前选择内筛/连通扩展。
        // 归 `edit` 组（UI 整理 W1④ · 用户 m01803 第 3 条原话："筛选错误的放进了地图层里面，
        // 这个应该是**编辑工具**"）：它改的是"我选中了哪些"，是编辑这一类；
        // 它只改"选择"，不改地图数据（选择不进撤销栈）。
        id: 'filter-selection',
        name: '按规则筛选选择…',
        icon: 'filter',
        group: 'edit',
        available: hasLayer,
        describe: () => {
          const editor = activeEditor()
          if (!editor) return '需要先启用地图层'
          const count = editor.getCellSelection().length
          return count === 0 ? '当前没有选中格（可以先框选一片，再在这里筛）' : `当前选中 ${count} 格`
        },
        run: () => this.openSelectionFilterModal(),
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
        name: COMMAND_NAMES.exportSvg,
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
        id: 'export-resource-bundle',
        // 名字里点明"包含哪些东西"：用户在命令面板里搜的是"我那些自定义地形怎么带走"
        // （区域类型同样必须写出来 —— 它是用户自己建的数据，不写会让人以为导出不带它）
        name: '导出定义文件…（自定义地形/标记/路径类型/区域类型）',
        icon: 'file-down',
        group: 'file',
        // 不进侧栏面板：日常不在画布上做，搬到设置页「定义文件（导入 / 导出）」（§F.2）
        panelHidden: true,
        // 刻意**不给** `available`：这两件事只依赖插件设置，不需要地图层、也不需要打开 Canvas
        // （其余 file 组动作都带 `available: hasLayer`，因为那些真的要有地图才能做）
        describe: () => '把设置里的自定义地形、标记、路径类型与区域类型打包成一份 JSON 写进库根目录',
        run: () => this.exportResourceBundle(),
      },
      {
        id: 'import-resource-bundle',
        name: '导入定义文件…',
        icon: 'file-up',
        group: 'file',
        // 同上：只在命令面板与设置页出现（与导出成对）
        panelHidden: true,
        describe: () => '从库里选一份定义文件；只做补充 —— 同 ID 保留你现有的定义，且不删除任何东西',
        run: () => this.importResourceBundle(),
      },
      {
        // 定义管理从设置页搬出来之后的新家：侧栏面板「地图定义」组 + 命令面板都能到。
        // 刻意**不给** `available`（也不需要地图层）：四类定义是插件设置里的数据，
        // 没有打开任何 Canvas 时同样该能管理（与 export-resource-bundle 同一理由）。
        id: 'manage-definitions',
        name: '管理地图定义…',
        icon: 'shapes',
        group: 'def',
        describe: () => '新增 / 删除 / 改 ID 自定义地形、标记、路径类型、区域类型',
        run: () => this.openDefinitionManagerModal(),
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
    return this.actions.filter(
      (action) =>
        // `panelHidden` 的动作（导入 / 导出定义文件）归设置页：面板不画，命令面板与设置页照旧能用
        action.panelHidden !== true && (action.devOnly !== true || this.pluginSettings.developerMode),
    )
  }

  // ------------------------------------------------------------ 地图面板

  private registerPanel(): void {
    this.registerView(MAP_PANEL_VIEW_TYPE, (leaf) => new MapPanelView(leaf, {
      getActions: () => this.getPanelActions(),
      getSummary: () => this.describePanelSummary(),
      // ---- 选中的对象（检查器）----
      // 面板只显示信息；改文档、撤销、落盘都在编辑器/历史那一层
      getSelection: () => this.layers?.getInspectorEditor()?.selectionInfo() ?? null,
      onRenameSelection: (name) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        if (editor.setSelectionName(name)) this.refreshPanel()
      },
      onSetSelectionLink: (link) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        if (editor.setSelectionLink(link)) this.refreshPanel()
      },
      onPickSelectionNote: () => this.pickNoteForSelection(),
      onDeleteSelection: () => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        if (editor.removeSelection()) this.refreshPanel()
      },
      // ---- 就地编辑：类型 / 位置 / 外观（A2）----
      // 候选清单按**当前选中项声明的来源**去查对应目录（面板只知道"来源名"）
      getSelectionTypeOptions: () => this.selectionTypeOptions(),
      onSetSelectionType: (value) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        if (editor.setSelectionType(value)) this.refreshPanel()
      },
      onSetSelectionField: (field, rawValue) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        const parsed = this.parseSelectionFieldInput(field, rawValue)
        if (parsed === undefined) return
        if (editor.setSelectionField(field, parsed)) this.refreshPanel()
      },
      onSetSelectionPosition: (x, y) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        if (editor.setSelectionPosition(x, y)) this.refreshPanel()
      },
      onMoveSelectionToViewportCenter: () => {
        const editor = this.layers?.getInspectorEditor()
        const center = this.selectionViewportCenter()
        if (!editor || center === null) {
          new Notice('当前没有可见的地图视图，无法居中。', NOTICE_MAX_MS)
          return
        }
        if (editor.moveSelectionTo(center)) this.refreshPanel()
      },
      // 图层开关：状态与写入口都从插件这边注入（面板不认识插件实例）
      // W4-2：面板跟着**活动画布**走 ⇒ 三者都按活动画布那张地图解析
      getLayerVisibility: () => this.layersFor(this.activeViewMapPath()),
      onToggleLayer: (key, value) => {
        void this.setLayerVisible(key, value)
      },
      // 「快速上手」清单：面板这份与设置页那份各存各的开关（两份文案不同源，见 quickStart.ts）
      getQuickStartVisible: () => !this.pluginSettings.hideQuickStartPanel,
      onHideQuickStart: () => {
        void this.setQuickStartHidden('panel', true)
      },
      onShowQuickStart: () => {
        void this.setQuickStartHidden('panel', false)
      },
      // ---- 整批编辑（§C.5）----
      getBatchEdit: () => this.batchEditInfo(),
      // ---- 数据显示面板里的只读读数（§2.6 形态 3：单选一格 ⇒ 地块信息 + 温度/深度/群系读数）----
      getSelectionReadings: () => this.selectionReadings(),
      // ---- 多个同类对象（§2.6 形态：多个同类对象 ⇒ 逐项一行 + 公共字段）----
      getObjectBatch: () => this.layers?.getInspectorEditor()?.objectsEditInfo() ?? null,
      onRemoveObjectItem: (id) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        // **只是移出这次选择**，不删对象（选择不进撤销栈，§C.3）
        editor.setObjectSelection(editor.getObjectSelection().filter((item) => item.id !== id))
        this.refreshPanel()
      },
      onSetObjectsType: (value) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        const count = editor.setObjectsType(value)
        if (count > 0) new Notice(`已给 ${count} 个对象设置类型（Ctrl/Cmd+Z 可撤销）`, 4000)
        this.refreshPanel()
      },
      onSetObjectsLink: (link) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        const count = editor.setObjectsLink(link)
        if (count > 0) {
          new Notice(link.length === 0 ? `已清除 ${count} 个对象的链接` : `已给 ${count} 个对象设置链接`, 4000)
        }
        this.refreshPanel()
      },
      onRemoveObjects: () => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        const count = editor.removeObjects()
        if (count > 0) new Notice(`已删除 ${count} 个对象（Ctrl/Cmd+Z 可撤销）`, 4000)
        this.refreshPanel()
      },
      onSetCellsField: (field, rawValue) => {
        const editor = this.layers?.getInspectorEditor()
        if (!editor) return
        const parsed = this.parseCellsFieldInput(field, rawValue)
        if (parsed === undefined) return
        const changed = editor.setSelectionCellsField(field, parsed)
        if (changed > 0) new Notice(`已整批设置 ${changed} 格（Ctrl/Cmd+Z 可撤销）`, 4000)
        else new Notice('这些格本来就是这个值，没有产生改动。', 4000)
        this.refreshPanel()
      },
      // 选择不进撤销栈（§C.3），所以这个动作也没有"撤销"可言 —— 它就是"取消在看这些格"
      onClearSelection: () => {
        this.layers?.getInspectorEditor()?.clearAllSelection()
        this.refreshPanel()
      },
      // ---- 「显示」三组（§F.1）：图例开关 + 数值图层参数（与设置页共用同一份控件渲染）----
      getShowLegend: () => this.showLegendFor(this.activeViewMapPath()),
      onToggleLegend: () => {
        void this.setShowLegend(!this.showLegendFor(this.activeViewMapPath()))
      },
      getOverlayStyles: () => this.overlaysFor(this.activeViewMapPath()),
      onSetOverlayStyle: (field, patch) => {
        void this.setOverlayStyle(field, patch)
      },
      onResetOverlayRamp: (field) => {
        void this.resetOverlayRamp(field)
      },
      onSetOverlayCategoryColor: (field, categoryId, color) => {
        void this.setOverlayCategoryColor(field, categoryId, color)
      },
      getCategoryUsage: (spec) => this.categoryUsageOf(spec),
      // ---- 工具 / 笔刷 / 选择方式（§F.2：这三节从画布浮窗搬进了侧栏）----
      getToolControls: () => this.toolControlsHost(),
    }))

    this.addRibbonIcon('map', 'Project Kaki：打开地图面板', () => {
      void this.activatePanel()
    })
  }

  /**
   * 侧栏「工具 / 笔刷 / 选择方式」三节控件要的读写入口（施工文件 §F.2）。
   *
   * 三节控件是**从画布浮窗搬进侧栏**的（ISSUE-002「找不到生物群系笔刷」、
   * ISSUE-004「筛选和绘制在同一个框里」）；控件本体的渲染在 `ui/toolSections.ts`，
   * 这里只做两件事：**找出当前活跃的那个编辑器**、**每次写入之后请面板重绘**。
   *
   * 与 `getSelection` / `onToggleLayer` 同一条边界：面板不认识编辑器，
   * 也不该认识 —— 否则"状态存在哪里"会在两处各有一份答案。
   */
  private toolControlsHost(): ToolControlsHost {
    /** 当前活跃地图层的编辑器；没有启用的地图层时为 `null`（三节会显示同一句提示） */
    const active = (): MapEditor | null => this.layers?.getInspectorEditor() ?? null
    /**
     * 写入 + 重绘。
     *
     * 编辑器自己也会通过 `onEditorStateChanged` 通知面板（快捷键、画布手势都会走那条路）；
     * 这里的 `refreshPanel()` 管的是"用户点了控件"这一路：界面必须立刻落到新值上。
     * 重复请求由面板的签名比对 + `requestAnimationFrame` 合并吸收。
     */
    const apply = (run: (editor: MapEditor) => void): void => {
      const editor = active()
      if (!editor) return
      run(editor)
      this.refreshPanel()
    }
    return {
      getStatus: () => active()?.getStatus() ?? null,
      setTool: (tool) => apply((editor) => editor.setTool(tool)),
      setTerrainType: (id) => apply((editor) => editor.setTerrainType(id)),
      setMarkerIcon: (id) => apply((editor) => editor.setMarkerIcon(id)),
      setPathType: (id) => apply((editor) => editor.setPathType(id)),
      setRegionType: (id) => apply((editor) => editor.setRegionType(id)),
      setGeometryMode: (mode) => apply((editor) => editor.setGeometryMode(mode)),
      setBrushField: (field) => apply((editor) => editor.setBrushField(field)),
      setBrushOp: (op) => apply((editor) => editor.setBrushOp(op)),
      setBrushValue: (value) => apply((editor) => editor.setBrushValue(value)),
      setBrushBiome: (id) => apply((editor) => editor.setBrushBiome(id)),
      adjustBrushRadius: (delta) => apply((editor) => editor.adjustBrushRadius(delta)),
      setSelectionMode: (mode) => apply((editor) => editor.setSelectionMode(mode)),
      expandSelectionByTerrain: () =>
        apply((editor) => {
          editor.expandSelectionByTerrain()
        }),
      getCustomTerrains: () => this.activeDefinitions().terrains,
      getCustomMarkers: () => this.activeDefinitions().markers,
      getPathTypes: () => this.activeDefinitions().pathTypes,
      getRegionTypes: () => this.activeDefinitions().regionTypes,
      getCustomBiomes: () => this.activeDefinitions().biomes,
      // 与标记层、设置页预览**同一个函数**：三处各写一遍迟早分叉（见 vaultResource.ts 的注释）
      resolveImageSrc: (path) => resolveVaultResourceUrl(this.app, path),
      onOpenSelectionFilter: () => this.openSelectionFilterModal(),
      requestRerender: () => this.refreshPanel(),
    }
  }

  /**
   * **整批编辑**要显示的那一份数据（§C.5）；`null` = 当前不是多选。
   *
   * 为什么在插件层算、而不是让面板自己算：面板不认识编辑器与文档（这是它一贯的边界）。
   * 这里只做一件事：把"当前选择 + 文档"翻成面板要显示的 `BatchEditInfo`。
   *
   * "mixed" 的判据（选中 ≥ 2 格时总有意义）：这批格里**既有有值的、也有没有值的** ——
   * 只有这时才必须提示"不猜共同值"；全都没值的情况用户本来就没有可猜的东西。
   */
  private batchEditInfo(): BatchEditInfo | null {
    const editor = this.layers?.getInspectorEditor()
    const document_ = this.layers?.getActiveDocument() ?? null
    if (!editor || !document_) return null
    const keys = editor.getCellSelection()
    if (keys.length < 2) return null
    const summary = editor.selectionSummary()
    return {
      count: keys.length,
      missing: summary?.missing ?? 0,
      summary: this.batchSummaryLine(document_, keys, summary),
      // §C.4 那份统计（原来在画布卡片上）与卡片**共用** `selectionStatRows`：
      // 卡片降级成"只做进行中的事"之后，它就是侧栏这一节的正文
      details:
        summary === null
          ? []
          : selectionStatRows(
              summary,
              // W4-2：配色按**活动画布那张地图**解析（与画布、图例同一份）
              this.overlaysFor(this.activeViewMapPath()),
              document_.elevation ?? null,
              (id) => resolveBiomeStyle(id, this.definitionsOf(document_).biomes).label,
            ),
      // 字段清单**从选择统计派生**（`summarizeSelection` 已经按字段表逐个算过缺数据格数）——
      // 以后加一个数值字段，这里一行都不用改
      fields: (summary?.fields ?? []).map((stat) => ({
        key: stat.key,
        label: stat.label,
        unit: stat.unit,
        mixed: stat.average !== null && stat.missing > 0,
        missing: stat.missing,
      })),
    }
  }

  /**
   * 整批编辑头部那**一行摘要**（§2.6：多格 ⇒ 整批编辑 + **摘要 1 行进侧栏头部**）。
   *
   * 用户追加口径（m01930）：「多选模式，侧栏里稍微加一行显示，**不要裸着**」——
   * 形态照施工文件给的例子 `苔原 30 · 雪原 12 · 3 格无数据`：
   * - **地形构成**：按格数降序，最多列 3 种（更多就写"等 N 种地形"）；名字走目录的显示名；
   * - **无数据格数**：这一格**温度 / 深度 / 生物群系一个都没有**的格数（逐字段各自缺多少，
   *   下面每个字段自己还有一行，所以这里只说"整格空着"的那种，不与下面重复）；
   * - 一段都没有（例如全是同名地形且都填了值）时退回 `N 格`，**不留空行**。
   */
  private batchSummaryLine(
    document_: MapDocument,
    keys: readonly string[],
    summary: SelectionSummary | null,
  ): string {
    const parts: string[] = []
    const terrains = [...(summary?.terrains ?? [])].sort((left, right) => right.count - left.count)
    const custom = this.definitionsOf(document_).terrains
    for (const item of terrains.slice(0, 3)) {
      parts.push(`${resolveTerrainStyle(item.id, custom).label} ${item.count}`)
    }
    if (terrains.length > 3) parts.push(`等 ${terrains.length} 种地形`)
    const empty = keys.filter((key) => {
      const cell = document_.terrain[key]
      if (cell === undefined) return false
      return OVERLAY_FIELDS.every((spec) =>
        spec.numeric ? spec.read(cell) === undefined : spec.readCategory(cell) === undefined,
      )
    }).length
    if (empty > 0) parts.push(`${empty} 格没有数据`)
    if (parts.length === 0) parts.push(`${keys.length} 格`)
    return parts.join(' · ')
  }

  /**
   * 「数据显示」面板里那几行**只读读数**（§2.6 形态 3）：
   * 单选一格时，除了可编辑的字段，还要**一眼看得见**这一格的温度 / 深度 / 生物群系。
   *
   * 三条口径：
   * - **只在恰好选中一格时给**（多格走整批编辑、对象没有这些读数）；
   * - 读数与**画布信息卡同源**（都调 `describeCellReadings`）—— 两处各算一遍必然分叉（§5.65）；
   * - 生物群系在这里翻成**显示名**（与卡片、图例一致；认不出的 ID 由目录解析回退成中性说法）。
   */
  private selectionReadings(): ReadonlyArray<{ label: string; value: string }> | null {
    const editor = this.layers?.getInspectorEditor()
    const document_ = this.layers?.getActiveDocument() ?? null
    if (!editor || !document_) return null
    const selection = editor.getSelection()
    if (selection === null || selection.kind !== 'cell') return null
    if (editor.getCellSelection().length > 1) return null
    const custom = this.definitionsOf(document_).biomes
    return describeCellReadings(document_, selection.id, this.overlaysFor(this.activeViewMapPath())).map((row) =>
      row.label === '生物群系' && row.value !== SELECTION_TEXT.unfilled
        ? { ...row, value: resolveBiomeStyle(row.value, custom).label }
        : row,
    )
  }

  /**
   * 整批编辑的原始文本 → 字段值（`null` = 清除该字段，`undefined` = 解析失败、不写）。
   *
   * 与 `parseSelectionFieldInput` 同一条纪律：**解析只在插件层做一处**。
   * 与那里不同的是：它不依赖"当前选中项"，所以不必先去问检查器要字段规格 ——
   * 地块的字段表就是权威（`SELECTION_KINDS.cell.fields`）。
   */
  private parseCellsFieldInput(field: string, raw: string): SelectionFieldValue | undefined {
    const spec = SELECTION_KINDS.cell.fields.find((item) => item.field === field)
    if (spec === undefined) return undefined
    const text = raw.trim()
    if (text.length === 0) return null
    if (spec.control === 'color') return normalizeColor(text, '') === '' ? undefined : normalizeColor(text, '')
    // 文本字段（生物群系 ID）：原样收下（认不出的 ID 必须能保留，§5.11）
    if (spec.control === 'text') return text
    const value = Number(text)
    // 唯一的硬约束是"必须是有限数"：温度 / 深度**没有取值范围**（见 selection.ts 里那段注释）
    return Number.isFinite(value) ? value : undefined
  }

  /**
   * 「类型」下拉的候选：按当前选中项声明的 `typeSource` 去查对应目录（内置 + 自定义）。
   *
   * 为什么不在这里按 kind 分派：来源是**选中项自己声明的**（`SelectionInfo.typeSource`），
   * 面板把它给过来，这里只负责"按名字查目录"。以后加"温度带"这类新对象，
   * 只要在新目录里补一个来源名，这里一行都不用改。
   */
  private selectionTypeOptions(): Array<{ value: string; label: string }> {
    const source = this.layers?.getInspectorEditor()?.selectionInfo()?.typeSource ?? null
    switch (source) {
      case 'terrain':
        return listResolvedTerrainStyles(this.pluginSettings.customTerrains).map((style) => ({
          value: style.id,
          label: style.label,
        }))
      case 'marker':
        return listResolvedMarkerStyles(this.pluginSettings.customMarkers).map((style) => ({
          value: style.id,
          label: style.label,
        }))
      case 'path':
        // 设置里这两类本来就是"内置 + 自定义"的完整条目列表，直接映射即可（不必另查目录）
        return this.pluginSettings.pathTypes.map((entry) => ({ value: entry.id, label: entry.label }))
      case 'region':
        return this.pluginSettings.regionTypes.map((entry) => ({ value: entry.id, label: entry.label }))
      default:
        return []
    }
  }

  /**
   * 把面板传来的**原始文本**解析成字段值（`null` = 清除该字段，`undefined` = 解析失败、不写）。
   *
   * 解析放在这里而不是面板里：面板不该知道"虚线怎么写"这类规则，
   * 而"合法值的规则"必须与设置页共用同一份（复用各目录的纯函数）。
   */
  private parseSelectionFieldInput(field: string, raw: string): SelectionFieldValue | undefined {
    const info = this.layers?.getInspectorEditor()?.selectionInfo() ?? null
    if (info === null) return undefined
    const spec = info.fields.find((item) => item.field === field)
    // 类型字段不经过这里（它走 onSetSelectionType，值是下拉给出的合法 ID）
    if (spec === undefined) return undefined
    const text = raw.trim()
    if (text.length === 0) return null
    if (spec.control === 'color') return normalizeColor(text, '') === '' ? undefined : normalizeColor(text, '')
    // 文本字段（生物群系 ID）：**原样收下**，不校验它认不认识 ——
    // 别的库写的 ID 必须能保留（§5.11），能不能画出来是绘制层的事
    if (spec.control === 'text') return text
    if (spec.control === 'number') {
      // 只接受纯数字：`Number('12px')` 是 NaN，但 `Number('')` 是 0 —— 所以先判空（上面已判）
      const value = Number(text)
      return Number.isFinite(value) ? value : undefined
    }
    // 虚线：复用路径类型目录里那套三态解析（缺失 / 实线 / 虚线），不重新发明
    const parsed = parsePathDashInput(text)
    return parsed.ok ? parsed.dash : undefined
  }

  /**
   * 当前视口的**世界中心**（侧栏「移到视口中心」用）；没有可见帧时返回 null。
   *
   * 与导出范围里的"当前视口"取的是同一份数据（`layers.listStatus().stats.lastVisibleWorld`）：
   * 两处若各算一套，用户会遇到"导出按视口是对的、居中却偏了"这种诡异现象。
   */
  private selectionViewportCenter(): Point | null {
    const editor = this.layers?.getInspectorEditor()
    const canvasPath = this.layers?.canvasPathOfEditor(editor ?? null) ?? null
    if (canvasPath === null) return null
    const world = this.currentViewportWorld(canvasPath)
    if (world === null) return null
    return { x: (world.minX + world.maxX) / 2, y: (world.minY + world.maxY) / 2 }
  }

  /** 打开（或聚焦）右侧边栏里的地图面板 */  async activatePanel(): Promise<void> {
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
   * 落盘插件设置，并让侧栏面板跟着重绘。
   *
   * 为什么这两件事要绑在一起（而不是各写各的）：§F.2 之后侧栏里出现了**从设置派生**的控件 ——
   * 地形调色板、标记图标、路径/区域类型下拉、生物群系下拉（`ui/toolSections.ts`）。
   * 改这些设置（新增/删除自定义定义、改颜色与画法参数）过去只需要画布下一帧现读即可生效，
   * 现在还必须让面板重建一次，否则用户会看到"设置里删掉了，侧栏里那个按钮还在"。
   *
   * 重绘是**签名门控 + 同帧合并**的，所以这里无脑调用不会带来逐帧重建（§5.9 那条教训的反面）。
   */
  private async persistSettings(): Promise<void> {
    await this.saveData(this.pluginSettings)
    this.refreshPanel()
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
          getCustomTerrains: (document) => this.definitionsOf(document).terrains,
          // Base 行的路径类型显示名也要跟着目录走（否则自定义类型在表里显示成 custom:xxx）
          getPathTypes: (document) => this.definitionsOf(document).pathTypes,
          // 区域同理：表里、画布上、图例里对同一个区域类型必须说同一个名字
          getRegionTypes: (document) => this.definitionsOf(document).regionTypes,
          // 数值图层与图层开关：缩略图里也要与画布一致（关掉的层不出现、配色改了就跟着变）。
          // W4-2：按**这份视图自己那张地图**解析（Base 视图没有画布，标识就是它加载的地图路径）
          getOverlayStyles: (mapPath) => this.overlaysFor(mapPath),
          getLayers: (mapPath) => this.layersFor(mapPath),
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
      new Notice(`${NOTICES.baseExists}，未覆盖：${basePath}`, NOTICE_MAX_MS)
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
      new Notice(NOTICES.noExportableMap, NOTICE_MAX_MS)
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
   * 按指定范围、格式与落点导出当前地图 —— 三条入口共用这一份实现。
   *
   * 范围解析失败（没有区域、没有可见视口……）时**只给一句人话、不产出文件**：
   * 半个空图比没有文件更糟（用户会以为导出成功了）。
   * 落点不合法（空文件名 / 含非法字符）时同样不产出文件 —— 这条守门必须在
   * 这里做一次，因为命令面板与两条快捷命令都绕过对话框直接走到这里。
   *
   * 返回值是"**文件真的写出来了吗**"：对话框靠它决定要不要留在原地
   * （失败时留着，用户就能换个格式再试；成功或"已经报过原因"时才关窗）。
   * 提示只在这里发一次，所以对话框拿到 `false` 时不需要再说一遍。
   */
  private async exportMapWithRange(range: ExportRange, format: ExportFormat, target: ExportTarget): Promise<boolean> {
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

    if (exportTargetProblem(target.folder, target.fileName) !== null) {
      // 真正的守门：对话框可以被绕过（命令面板与两条快捷命令都直接到这里）
      new Notice('无法导出：保存位置或文件名不可用（空文件名或含非法字符）。', NOTICE_MAX_MS)
      return false
    }
    const extension = format === 'png' ? '.png' : '.svg'
    // 落点由调用方给（对话框里用户填的那个，或两条快捷命令推导出来的默认值）；
    // 文件名末尾若带了 `.svg` / `.png` 就去掉 —— 扩展名跟着格式走，不然会写出 `World.svg.png`
    const basePath = joinExportTarget(target.folder, stripExportExtension(target.fileName))
    try {
      // 用户可能填了一个还不存在的目录名（对话框上承诺了会自动建）
      await this.ensureExportFolder(target.folder)
    } catch (error) {
      console.error('[project-kaki] 创建导出目录失败', error)
      new Notice(`无法导出：创建目录「${target.folder}」失败。`, NOTICE_MAX_MS)
      return false
    }
    const exportPath = uniqueExportPath(basePath, extension, (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null)
    // 现读一次设置：导出必须是"当前地图 + **当前地图那份定义**"的合成结果。
    // 图标形状只能由 Obsidian 的 `getIcon` 拿到，所以**注入**给纯模块（见 `lucideFragment.ts`）。
    // 数值图层颜色面走了哪条路（内联栅格 / 超上限退回矢量）由 `onOverlayExport` 带回来，
    // 附在导出提示里 —— 否则"报错的是矢量兜底"这件事用户永远看不见（DATA-LAYER-PLAN §0 D1 a3）。
    let overlayNotes: readonly OverlayExportNote[] = []
    // 定义**按被导出的那份文档**解析（v2 方案 B）：导出别人的图时，颜色/线宽跟的是文件里那一套
    const definitions = this.definitionsOf(document)
    const svg = buildMapExportSvg(document, EXPORT_WIDTH, EXPORT_HEIGHT, definitions.terrains, resolved.bounds, {
      customMarkers: definitions.markers,
      iconSvgFor: lucideIconFragment,
      // 数值图层（温度 / 深度）与图层开关**按被导出的那张地图解析**：与画布同一条口径
      // （关掉温度层，导出里就不该有它；配色 / 显示方式也要跟画布一致）。
      // W4-2：导出"别人给的图"时不该把**本机对当前那张图**的配色套上去
      overlayStyles: this.overlaysFor(mapPath),
      layers: this.layersFor(mapPath),
      onOverlayExport: (notes) => {
        overlayNotes = notes
      },
    })
    const overlayReport = describeOverlayExport(overlayNotes)
    const overlaySuffix = overlayReport === '' ? '' : `\n${overlayReport}`

    if (format === 'svg') {
      try {
        const created = await this.app.vault.create(exportPath, svg)
        new Notice(`${NOTICES.svgExportedPrefix}：${created.path}\n（${resolved.description}）${overlaySuffix}`, NOTICE_MAX_MS)
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
        new Notice(`${NOTICES.pngFailedPrefix}：${result.reason}`, NOTICE_MAX_MS)
        return false
      }
      const created = await this.app.vault.createBinary(exportPath, await result.blob.arrayBuffer())
      new Notice(`已导出地图 PNG：${created.path}\n（${resolved.description}）${overlaySuffix}`, NOTICE_MAX_MS)
      void this.app.workspace.openLinkText(created.path, '', false)
      return true
    } catch (error) {
      console.error('[project-kaki] 导出 PNG 失败', error)
      new Notice(`${NOTICES.pngFailedPrefix}：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
      return false
    }
  }

  /**
   * 当前地图的**默认导出落点**：文件夹取"上次用过的（`settings.exportFolder`），
   * 没记录过就取地图文件所在目录"；文件名由范围推出来（`World` / `World-视口` / `World-北境领`）。
   *
   * 三条入口共用它 —— 于是"快捷命令等于对话框里选全部内容"这句描述始终成立
   * （两条快捷命令与对话框的默认值来自同一处，改了不会只改一边）。
   */
  private defaultExportTarget(mapPath: string, range: ExportRange, document: MapDocument | null): ExportTarget {
    const remembered = this.pluginSettings.exportFolder
    const folder = remembered.length > 0 ? remembered : assetFolderOf(exportBasePathFor(mapPath))
    return { folder, fileName: exportFileNameFor(assetNameOf(exportBasePathFor(mapPath)), range, document) }
  }

  /** 打开「导出地图…」对话框：范围 + 格式 + 落点（保存位置 / 文件名） */
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
      initialFolder: this.defaultExportTarget(context.mapPath, { kind: 'all' }, document).folder,
      defaultFileName: (range) => exportFileNameFor(assetNameOf(exportBasePathFor(context.mapPath)), range, document),
      pickFolder: (onChoose) => {
        this.pickFolder({ title: '选择导出位置', onChoose })
      },
      describe: (range, format, target) => {
        const resolved = resolveExportBounds(range, {
          document,
          viewportWorld: this.currentViewportWorld(canvasPathForViewport),
        })
        if (!resolved.ok) return { ok: false, reason: resolved.reason }
        const problem = exportTargetProblem(target.folder, target.fileName)
        if (problem !== null) return { ok: false, reason: problem }
        // 摘要里带上将要写入的完整路径：用户点"导出"之前就能知道会多出哪个文件
        const extension = format === 'png' ? '.png' : '.svg'
        const path = `${joinExportTarget(target.folder, stripExportExtension(target.fileName))}${extension}`
        return { ok: true, text: `${resolved.description}\n输出文件：${path}（重名时自动加 -2、-3）` }
      },
      onExport: async (range, format, target) => {
        const done = await this.exportMapWithRange(range, format, target)
        // 只有真的写出文件才记住这个目录：失败时用户可能只是打错了一个字，
        // 把打错的目录记下来会让"上次目录"变成一个坑。
        if (done) void this.rememberExportFolder(target.folder)
        // 失败时不留 `reason`：具体原因（"这个环境不支持 toBlob"之类）已经由导出那边
        // 发过一条提示了，这里再说一遍只会让用户看到两句意思相同的话。
        return done ? { ok: true as const } : { ok: false as const }
      },
    }).open()
  }

  /**
   * 记住导出落点（写进插件设置，下一次打开对话框与两条快捷命令都用它）。
   *
   * 落在**插件设置**而不是地图文件：它不是"这个世界的事实"，
   * 写进地图文件会让"把图分享给别人"连带改掉对方的导出位置（判据见 `UI-REORG-PLAN.md` §5）。
   * 落盘是后台的事：导出已经成功，写设置慢一点不该再弹一条提示打扰用户。
   */
  private async rememberExportFolder(folder: string): Promise<void> {
    const next = normalizeExportFolder(folder)
    if (next === this.pluginSettings.exportFolder) return
    this.pluginSettings = { ...this.pluginSettings, exportFolder: next }
    try {
      await this.saveData(this.pluginSettings)
    } catch (error) {
      console.warn('[project-kaki] 保存导出位置失败（不影响已导出的文件）', error)
    }
  }

  /**
   * 确保导出目录存在 —— 对话框上写着「可以手动填一个新的目录名（导出时会自动建）」，
   * 承诺了就得自己做：不能指望 `vault.create` 顺带把父目录建出来（各版本行为不保证）。
   *
   * 与 `MapDocumentStore.ensureFolder` 同一口径：已经存在就直接返回；
   * 并发创建撞车（别人刚建好）时再确认一次，不当成失败。
   */
  private async ensureExportFolder(folder: string): Promise<void> {
    const normalized = normalizeExportFolder(folder)
    if (normalized.length === 0) return
    if (this.app.vault.getAbstractFileByPath(normalized) !== null) return
    try {
      await this.app.vault.createFolder(normalized)
    } catch (error) {
      if (this.app.vault.getAbstractFileByPath(normalized) === null) throw error
    }
  }

  private async exportActiveMapSvg(): Promise<void> {
    const context = this.resolveExportContext()
    if (!context) return
    await this.exportMapWithRange({ kind: 'all' }, 'svg', this.defaultExportTarget(context.mapPath, { kind: 'all' }, context.document))
  }

  /**
   * 导出当前地图为 PNG（快捷入口，相当于对话框里选"全部内容 + PNG"）。
   *
   * 与 SVG 导出**共用同一份几何与配色**：先由 `buildMapExportSvg` 生成 SVG（Base 缩略图也用同一份），
   * 再把它光栅化成位图。这样"导出的图与画布一致"这条承诺只需要维护一处 ——
   * 如果这里另写一套坐标换算，迟早会出现"PNG 与 SVG 长得不一样"。
   */
  private async exportActiveMapPng(): Promise<void> {
    const context = this.resolveExportContext()
    if (!context) return
    await this.exportMapWithRange({ kind: 'all' }, 'png', this.defaultExportTarget(context.mapPath, { kind: 'all' }, context.document))
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

  /**
   * **库级设置那一份**定义集（"新建地图的模板" + "v1 老图的迁移快照"）。
   *
   * 定义随图（方案 B）之后，权威在**地图文件**里；库里的这一份只剩两个用途：
   * ① 新建地图时作为出厂快照写进新文件；② v1 老图（没有 `definitions`）读进来时的初值。
   * 它同时也跟着每次定义编辑一起更新（见 `mutateDefinitions`），于是"新建的下一张图"
   * 会沿用你上一次调好的那一套 —— 一条写入口，两处同步，不会分叉。
   *
   * 按 `pluginSettings` 的对象身份做一层备忘：五类目录在渲染层是**每帧现读**的，
   * 每次重新规范化五份目录纯属白烧 CPU（设置对象每次改动都会换新引用，所以这层备忘不会过期）。
   */
  libraryDefinitionSet(): MapDefinitionSet {
    const cached = this.librarySetCache
    if (cached !== null && cached.source === this.pluginSettings) return cached.set
    const set = definitionSetFromLibrary(this.pluginSettings)
    this.librarySetCache = { source: this.pluginSettings, set }
    return set
  }

  /**
   * **某一份地图文档**当前生效的定义集（定义随图：v2 的 `definitions` 段）。
   *
   * - 文档里有 `definitions` ⇒ 以文件为准（缺哪一类就沿用库级快照 —— 那是给手写块留的安全网）；
   * - 文档里没有（v1 老图）或压根没有文档 ⇒ 库级那一份。
   *
   * ⚠️ **必须按文档解析**，不许有插件级单例：多画布同开是硬约束，
   * 单例会让 A 图的定义污染 B 图（见 `UI-REORG-PLAN.md` §5.1）。
   *
   * 按 `definitions` 的**对象身份**做备忘：访问器每帧现读，而那份块每次写入都会换成新对象
   * （`definitionsBlockOf` 是纯函数），所以备忘既便宜又不会过期。
   */
  definitionsOf(document: MapDocument | null): MapDefinitionSet {
    const block = document?.definitions
    if (block === undefined) return this.libraryDefinitionSet()
    const cached = this.documentSetCache.get(block)
    if (cached !== undefined) return cached
    const set = definitionSetFromBlock(block, this.libraryDefinitionSet())
    this.documentSetCache.set(block, set)
    return set
  }

  /**
   * **活动地图**当前生效的定义集（侧栏、筛选器、命令这些"跟着当前画布走"的地方用它）。
   *
   * 与 `definitionsOf` 的差别只有"哪一份文档"：这里取活动画布持有的那一份。
   * 没有活动地图时它就是库级那一份（渲染层与侧栏都不会因此报错）。
   */
  activeDefinitions(): MapDefinitionSet {
    return this.definitionsOf(this.layers?.getActiveDocument() ?? null)
  }

  /**
   * 库级设置那一份定义集，序列化成地图文件里的 `definitions` 块（v2）。
   *
   * 用途是**新建地图**：新文件本来就要从头写一遍，把定义一起装进去才是方案 B
   * （"分享即完整"）。**老图不走这里** —— 它们读到的是内存快照，只有用户真的改了定义才回写升版。
   */
  libraryDefinitionsBlock(): MapDefinitions {
    return definitionsBlockOf(this.libraryDefinitionSet())
  }

  // ------------------------------------------------ 视图偏好（W4-2：按地图分键）

  /**
   * **当前活动画布**绑定的地图路径（`null` = 没有地图 ⇒ 视图偏好落在库级那一份"模板"上）。
   *
   * 与 `definitionTarget` 里那一句同一条口径（活动画布 → 它绑定的地图文件），
   * 只是这里**不要求启用地图层**：图层开关、配色、图例是"我现在想看到什么"，
   * 只要有一张地图在眼前就该记住它。标识用**库内相对路径**（同一张图可被多个 canvas 引用，
   * 按 canvas 分份会给同一张图两份设置）。
   */
  activeViewMapPath(): string | null {
    const canvasPath = this.activeCanvasPath()
    if (canvasPath === null) return null
    return this.store?.mapFilePathForCanvas(canvasPath) ?? null
  }

  /**
   * **任意画布**绑定的地图路径（`null` = 这张画布没绑地图）。
   *
   * 与 `activeViewMapPath` 只差"哪一张画布"：多画布同开时，画布上的东西（工具条开关、
   * 图例、叠加层）必须按**它自己那张图**解析，不能看"谁是活动画布" —— 否则在 B 画布上
   * 点 B 的图层开关，改的却是 A 那张图（B 的按钮还不会翻）。
   */
  mapPathForCanvas(canvasPath: string): string | null {
    return this.store?.mapFilePathForCanvas(canvasPath) ?? null
  }

  /** 某张地图自己的视图偏好（没有记录 / 没有地图 ⇒ 空对象，调用方各自回落） */
  private mapViewsOf(mapPath: string | null): MapViewSettings {
    if (mapPath === null) return {}
    return this.pluginSettings.mapViews[mapPath] ?? {}
  }

  /**
   * 配色 / 不透明度那一份**按地图解析**（缺 = 用库级模板）。
   *
   * 必须便宜：绘制层是**每帧现读**它（`MapOverlay` / `MapLayerManager` 的 deps），
   * 所以这里只查一次表、不做规范化 —— 规范化在 `normalizeSettings` 与写入侧各做一次。
   */
  overlaysFor(mapPath: string | null): OverlayStyles {
    return this.mapViewsOf(mapPath).overlays ?? this.pluginSettings.overlays
  }

  /** 图层开关**按地图解析**（缺 = 用库级模板）—— 与 `overlaysFor` 逐字同理 */
  layersFor(mapPath: string | null): LayerVisibility {
    return this.mapViewsOf(mapPath).layers ?? this.pluginSettings.layers
  }

  /** 图例显隐**按地图解析**（缺 = 用库级模板）—— 与 `overlaysFor` 逐字同理 */
  showLegendFor(mapPath: string | null): boolean {
    return this.mapViewsOf(mapPath).showLegend ?? this.pluginSettings.showLegend
  }

  /**
   * 视图偏好的**唯一写入口**：写进某张地图那一份，同时**镜像**回库级那一份。
   *
   * 为什么镜像（与"定义随图"里那条一字不差）：库级那一份是**"新建地图的模板"**，
   * 不跟上就会出现"刚调好的配色，新建一张图又打回出厂"。
   * 没有地图（`null`）时改的就是模板本身 —— 那种情况下模板是唯一存在的家。
   *
   * 只改内存、不落盘、不广播：调用方各自决定广播什么（图层要广播，配色靠"每帧现读"）。
   * 这样也保住了既有口径 —— **改内存是同步的**，于是侧栏里同步点一下开关，
   * 下一帧就看到结果（不必等落盘）。
   */
  private commitViewSettings(mapPath: string | null, patch: MapViewSettings): void {
    const settings = this.pluginSettings
    const mirrored = {
      ...(patch.overlays !== undefined ? { overlays: patch.overlays } : {}),
      ...(patch.layers !== undefined ? { layers: patch.layers } : {}),
      ...(patch.showLegend !== undefined ? { showLegend: patch.showLegend } : {}),
    }
    if (mapPath === null) {
      this.pluginSettings = { ...settings, ...mirrored }
      return
    }
    const existing = settings.mapViews[mapPath] ?? {}
    this.pluginSettings = {
      ...settings,
      mapViews: { ...settings.mapViews, [mapPath]: { ...existing, ...patch } },
      ...mirrored,
    }
  }

  // ------------------------------------------------ 定义写入口（W4-1b：定义随图）

  /**
   * 定义编辑的**目标**：当前要改哪张地图。
   *
   * 解析顺序（决定"定义随图"到底落在哪个文件上）：
   * 1. 活动画布绑定了一张地图 ⇒ 就是它（有地图层时顺便拿到编辑器，改动走撤销栈）；
   * 2. 没有活动画布 / 活动画布没绑地图 ⇒ `null`（调用方给一句人话，见 `mutateDefinitions`）。
   *
   * 为什么按**活动画布**而不是"最近编辑过的地图"：定义弹窗、侧栏、命令三者都跟着当前画布走，
   * 而多画布同开时"当前"唯一由活动叶子定义（与 `activeCanvasPath` 同一条口径）。
   */
  private definitionTarget(): DefinitionTarget | null {
    const canvasPath = this.activeCanvasPath()
    if (canvasPath === null) return null
    const mapPath = this.store?.mapFilePathForCanvas(canvasPath) ?? null
    if (mapPath === null) return null
    return { canvasPath, mapPath, editor: this.layers?.getEditor(canvasPath) ?? null }
  }

  /**
   * 「地图定义」弹窗要渲染的那份文档（`null` = 现在没有可编辑的地图）。
   *
   * 与 `definitionTarget` 同一套解析，只是把"拿文档"这件事做完：
   * 有地图层时直接用内存里那份（不重读盘，避免和未落盘的编辑打架）；
   * 只有绑定、没开地图层时读一次盘（并把结果记进 `definitionDocCache`，下次开弹窗首帧就是对的）。
   */
  async currentDefinitionDocument(): Promise<{ document: MapDocument; mapPath: string } | null> {
    const target = this.definitionTarget()
    if (target === null) return null
    if (target.editor !== null) {
      const document_ = this.layers?.getDocument(target.canvasPath) ?? null
      return document_ === null ? null : { document: document_, mapPath: target.mapPath }
    }
    const loaded = await this.loadMapAt(target.mapPath)
    if (loaded === null) return null
    this.definitionDocCache.set(target.mapPath, loaded.document)
    return { document: loaded.document, mapPath: target.mapPath }
  }

  /** 定义编辑的**目标地图路径**（弹窗顶部那句话要它）—— 没有可编辑的地图时为 `null` */
  definitionTargetPath(): string | null {
    return this.definitionTarget()?.mapPath ?? null
  }

  /**
   * 弹窗**首帧**用的定义集（同步拿得到的）。
   *
   * 三种情况：有地图层 ⇒ 它内存里那份（权威、且与画布所见一致）；
   * 只绑定没开层 ⇒ 最近一次为弹窗读盘读到的那份（`definitionDocCache`）；
   * 都没有 ⇒ 库级模板。弹窗随后会用 `currentDefinitionDocument()` 把真正那一份补上。
   */
  syncCurrentDefinitionSet(): MapDefinitionSet {
    const target = this.definitionTarget()
    if (target === null) return this.libraryDefinitionSet()
    if (target.editor !== null) return this.definitionsOf(this.layers?.getDocument(target.canvasPath) ?? null)
    const cached = this.definitionDocCache.get(target.mapPath)
    return cached === undefined ? this.libraryDefinitionSet() : this.definitionsOf(cached)
  }

  /** 读一份地图文件（`null` = 读不到 / 结构性问题 / 只读打开） */
  private async loadMapAt(
    mapPath: string,
  ): Promise<{ file: TFile; document: MapDocument; name: string; canvases: string[]; rest: Record<string, string | string[]> } | null> {
    const abstract = this.app.vault.getAbstractFileByPath(mapPath)
    if (abstract === null || this.store === null) return null
    const loaded = await this.store.load(abstract as TFile)
    if (loaded.document === null || loaded.readOnly) return null
    return {
      file: abstract as TFile,
      document: loaded.document,
      name: loaded.frontmatter.name ?? defaultMapNameFromPath(mapPath),
      canvases: loaded.frontmatter.canvases,
      rest: loaded.frontmatter.rest,
    }
  }

  /**
   * **定义写入口的唯一收口**：把"当前地图的定义集"换成 `mutate` 之后的结果并落盘。
   *
   * 三条必须守住的边界：
   * 1. **权威在地图文件**：改动写进那张地图的 `definitions` 段（有地图层时走编辑器的
   *    `setDefinitions` —— 于是 Ctrl+Z 一次就回到改之前那套定义；没有地图层时直接读改写盘）；
   * 2. **库级那一份同步跟上**：它是"新建地图的模板"，不跟上就会出现"新建的图还是旧定义"；
   * 3. **没有可编辑的地图**（没有 Canvas / Canvas 没绑地图）⇒ 改动**只写模板**，
   *    并由弹窗顶部那句话说明白 —— 那种情况下模板就是唯一存在的家，不是"静默丢弃"。
   *
   * `mutate` 只在"已经决定要写"时被调用：校验、重名、上限这些判断都在调用方做完。
   */
  private async mutateDefinitions(
    mutate: (set: MapDefinitionSet) => MapDefinitionSet,
    label: string,
    /**
     * 指定写哪张地图（缺省 = 提交这一刻现解析）。
     *
     * 为什么允许覆盖：**对话框已经告诉用户"导入到哪张图"了**（W4-3 的那一行小字）——
     * 如果提交时重新解析出一个不同的目标，那句话就成了假话。导入这类"先说后做"的动作
     * 必须让说的与做的指同一张图。
     */
    target: DefinitionTarget | null | undefined = undefined,
  ): Promise<{ ok: true } | { ok: false; problem: string }> {
    const resolved = target === undefined ? this.definitionTarget() : target
    if (resolved === null) {
      // 没有地图：家只有"新建地图的模板"（弹窗会明说这件事，见 `DefinitionManagerModal`）
      const next = mutate(this.libraryDefinitionSet())
      this.mirrorLibraryDefinitions(next)
      await this.persistSettings()
      this.layers?.setStylePalette()
      this.refreshPanel()
      console.info(`[project-kaki] ${label}：当前没有地图，已写进「新建地图的模板」`)
      return { ok: true }
    }
    const loaded = resolved.editor === null ? await this.loadMapAt(resolved.mapPath) : null
    if (resolved.editor === null && loaded === null) {
      return { ok: false, problem: `读不到地图文档：${resolved.mapPath}` }
    }
    const document_ =
      resolved.editor === null ? loaded!.document : this.layers?.getDocument(resolved.canvasPath) ?? null
    if (document_ === null) return { ok: false, problem: `读不到地图文档：${resolved.mapPath}` }

    const current = this.definitionsOf(document_)
    const next = mutate(current)
    // 五类都写 + 把本插件不认识的分类（`extra`）原样带走（见 `definitionsBlockOf`）
    const block = definitionsBlockOf(next, document_.definitions)

    if (resolved.editor !== null) {
      // 走编辑器：一次提交 = 一条历史，落盘由地图层的防抖保存负责
      resolved.editor.setDefinitions(block)
    } else {
      document_.definitions = block
      // 老图（v1）从这一刻起就是 v2 了
      document_.version = Math.max(document_.version, MAP_DOCUMENT_VERSION)
      await this.store!.writeNow(loaded!.file, document_, loaded!.name, loaded!.canvases, loaded!.rest)
      // 顺手更新弹窗那份"读盘留底"（vault modify 事件会把它删掉，所以它只是首帧的一个提示，
      // 不是权威 —— 权威永远是文件本身，见 `definitionDocCache`）
      this.definitionDocCache.set(resolved.mapPath, document_)
      // 同一张图可能被别的画布也开着：从盘上重读，免得它内存里还是旧定义
      await this.layers?.reloadMap(resolved.mapPath)
    }

    this.mirrorLibraryDefinitions(next)
    await this.persistSettings()
    // 工具条下拉、图例、画布配色、侧栏那几节控件都跟着换一份目录
    this.layers?.setStylePalette()
    this.refreshPanel()
    console.info(`[project-kaki] ${label}：已写入 ${resolved.mapPath} 的定义段`)
    return { ok: true }
  }

  /**
   * 把定义集镜像回库级设置（`pluginSettings`）。
   *
   * 为什么两处都写：库级那一份现在是"**新建地图的模板**"（见 `libraryDefinitionSet`），
   * 不跟着改就会出现"刚调好的线宽，新建一张图又打回出厂"。两处由这一条写入口同时更新，
   * 于是不会分叉（"一个设置两个来源"那条纪律说的是**两个写入口**，不是两份用途不同的副本）。
   */
  private mirrorLibraryDefinitions(set: MapDefinitionSet): void {
    this.pluginSettings = {
      ...this.pluginSettings,
      customTerrains: set.terrains,
      customMarkers: set.markers,
      customBiomes: set.biomes,
      pathTypes: set.pathTypes,
      regionTypes: set.regionTypes,
      // 旧字段跟着目录走（它不是渲染依据，但两处自相矛盾会让人看不懂 data.json）
      pathColors: pathColorsFromEntries(set.pathTypes),
      regionColors: regionColorsFromEntries(set.regionTypes),
    }
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
    // ID 留空 = 自动生成：手打 ID 是没必要的负担，显示名才是人看的（用户实测反馈）
    const existing = this.activeDefinitions().terrains
    const result = validateCustomTerrainInput({
      ...input,
      id: isBlankCustomId(input.id)
        ? suggestCustomId(
            typeof input.label === 'string' ? input.label : '',
            existing.map((item) => item.id),
            CUSTOM_TERRAIN_PREFIX,
            'terrain',
          )
        : input.id,
    })
    if (!result.ok) return result
    if (existing.some((terrain) => terrain.id === result.terrain.id)) {
      return { ok: false, problem: `已经有一个地形用了 ID ${result.terrain.id}` }
    }
    if (existing.length >= MAX_CUSTOM_TERRAINS) {
      return { ok: false, problem: `最多 ${MAX_CUSTOM_TERRAINS} 个自定义地形` }
    }
    return this.mutateDefinitions(
      (set) => ({ ...set, terrains: [...set.terrains, result.terrain] }),
      `新增自定义地形 ${result.terrain.id}`,
    )
  }

  /**
   * 改一个自定义地形（按 **ID** 定位 —— ID 不可改，所以它是这条定义的稳定身份）。
   *
   * 为什么不是下标：弹窗渲染出来的那份定义集与"点下去那一刻的活动地图"未必是同一份
   * （用户可能在弹窗开着时切了画布）。按下标改会**改错条目**，按 ID 改最坏只是"这条不在
   * 当前地图里 → 什么也不做"，而且弹窗随后的重绘会把真实情况显示出来。
   *
   * 只接受"补丁"：显示名、颜色、字形、图片路径。ID 不在补丁里 ——
   * 改 ID 等于把地图文件里已有的格子指向另一个地形，那不是编辑而是数据迁移，
   * 必须显式做成一个功能，不能顺手提供。
   */
  async updateCustomTerrain(
    id: string,
    patch: {
      label?: unknown
      color?: unknown
      glyph?: unknown
      imagePath?: unknown
      mode?: unknown
      imageLayout?: unknown
    },
  ): Promise<void> {
    await this.mutateDefinitions((set) => {
      const current = set.terrains.find((terrain) => terrain.id === id)
      if (!current) return set
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
        return set
      }
      return {
        ...set,
        terrains: set.terrains.map((terrain) => (terrain.id === id ? next.terrain : terrain)),
      }
    }, `修改自定义地形 ${id}`)
  }

  /**
   * 删除一个自定义地形。
   *
   * **不动地图数据**：已经画了这个地形的格子仍然留在文件里，只是画成回退样式。
   * 反过来做（顺手把格子删掉）是不可逆的，而且用户只是想改个颜色而已。
   */
  async removeCustomTerrain(id: string): Promise<void> {
    await this.mutateDefinitions((set) => {
      if (!set.terrains.some((terrain) => terrain.id === id)) return set
      return { ...set, terrains: set.terrains.filter((terrain) => terrain.id !== id) }
    }, `删除自定义地形 ${id}`)
  }

  /**
   * 改一种路径类型的参数（颜色 / 线宽 / 虚线 / 变细 / 平滑 / 端点 / 连接）。
   *
   * 全部校验在 `applyPathTypePatch` 里（纯函数）：非法虚线**整条拒绝**并返回可读原因，
   * 而不是"悄悄回退到出厂值"——后者会让用户以为自己填的生效了。
   *
   * ⚠️ 改的是**这张地图**的那一套参数（定义随图）：内置 4 种与自定义类型一视同仁。
   * 只影响**之后新画**的路径：已经画好的路径把参数存在地图文件里。
   */
  async updatePathType(
    id: string,
    patch: PathTypePatch,
  ): Promise<{ ok: true } | { ok: false; problem: string }> {
    const current = this.activeDefinitions().pathTypes.find((entry) => entry.id === id)
    if (current === undefined) return { ok: false, problem: `没有这个路径类型：${id}` }
    const next = applyPathTypePatch(current, patch)
    if (!next.ok) return next
    return this.mutateDefinitions(
      (set) => ({ ...set, pathTypes: set.pathTypes.map((entry) => (entry.id === id ? next.entry : entry)) }),
      `修改路径类型 ${id}`,
    )
  }

  /**
   * 新增一个自定义路径类型。
   *
   * 与 `addCustomTerrain` / `addCustomMarker` 逐字同构：校验全在
   * `validateCustomPathTypeInput` 里（纯函数），这里只负责落盘与通知渲染层。
   * 重名会被拒绝：同一个 ID 两条定义会让"画出来是哪一条"变成说不清的问题。
   */
  async addCustomPathType(input: {
    id: unknown
    label?: unknown
    color?: unknown
    width?: unknown
    dash?: unknown
    cap?: unknown
    join?: unknown
  }): Promise<{ ok: true } | { ok: false; problem: string }> {
    // ID 留空 = 自动生成（同 addCustomTerrain）
    const entries = this.activeDefinitions().pathTypes
    const result = validateCustomPathTypeInput({
      ...input,
      id: isBlankCustomId(input.id)
        ? suggestCustomId(
            typeof input.label === 'string' ? input.label : '',
            customPathTypeEntries(entries).map((item) => item.id),
            CUSTOM_PATH_TYPE_PREFIX,
            'path',
          )
        : input.id,
    })
    if (!result.ok) return result
    if (entries.some((entry) => entry.id === result.entry.id)) {
      return { ok: false, problem: `已经有一个路径类型用了 ID ${result.entry.id}` }
    }
    if (customPathTypeEntries(entries).length >= MAX_CUSTOM_PATH_TYPES) {
      return { ok: false, problem: `最多 ${MAX_CUSTOM_PATH_TYPES} 个自定义路径类型` }
    }
    return this.mutateDefinitions(
      (set) => ({ ...set, pathTypes: [...set.pathTypes, result.entry] }),
      `新增路径类型 ${result.entry.id}`,
    )
  }

  /**
   * 删除一个自定义路径类型。
   *
   * **不动地图数据**：已经用了这个类型的路径仍然留在文件里，只是画成回退样式。
   * 反过来做（顺手把路径删掉）是不可逆的，而用户通常只是想清理一下列表。
   */
  async removeCustomPathType(id: string): Promise<void> {
    await this.mutateDefinitions((set) => {
      const list = set.pathTypes.filter((entry) => entry.id !== id)
      if (list.length === set.pathTypes.length) return set
      return { ...set, pathTypes: list }
    }, `删除路径类型 ${id}`)
  }

  /**
   * 当前活动地图的文档。
   *
   * 界面层（设置页的分类用量、信息卡读数）拿不到地图层管理器，由插件层替它取一次。
   * 没有活动地图时返回 `null`（调用方照常渲染，只是那一段空着）。
   */
  getActiveDocument(): MapDocument | null {
    return this.layers?.getActiveDocument() ?? null
  }

  /**
   * 当前地图上**真的用到**的某个分类字段的值（按显示名排序）—— 设置页与侧栏面板共用。
   *
   * 为什么只列用到的：内置 34 条全列出来会把设置页撑成一面墙（用户抱怨过太挤，§5.31），
   * 而"还没用到的分类"改了颜色也看不见效果。**认不出的 ID 也照列** ——
   * 那正是用户最需要知道"这一格到底是什么"的情况（§5.11）。
   *
   * 放在插件层而不是界面层：它要读活动文档 + 自定义目录，界面层两样都拿不到
   * （设置页与面板都不认识地图层管理器）。
   */
  categoryUsageOf(
    spec: CategoryOverlayFieldSpec,
  ): Array<{ id: string; label: string; color: string; count: number; known: boolean }> {
    const document_ = this.getActiveDocument()
    if (document_ === null) return []
    const custom = this.definitionsOf(document_).biomes
    const counts = new Map<string, number>()
    for (const cell of Object.values(document_.terrain)) {
      const id = spec.readCategory(cell)
      if (id === undefined) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([id, count]) => {
        const resolved = resolveBiomeStyle(id, custom)
        return {
          id,
          label: resolved.label,
          color: resolved.color,
          count,
          known: resolved.builtin || id.startsWith(CUSTOM_BIOME_PREFIX),
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
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
    // ID 留空 = 自动生成（同 addCustomTerrain）
    const existing = this.activeDefinitions().markers
    const result = validateCustomMarkerInput({
      ...input,
      id: isBlankCustomId(input.id)
        ? suggestCustomId(
            typeof input.label === 'string' ? input.label : '',
            existing.map((item) => item.id),
            CUSTOM_MARKER_PREFIX,
            'marker',
          )
        : input.id,
    })
    if (!result.ok) return result
    if (existing.some((marker) => marker.id === result.marker.id)) {
      return { ok: false, problem: `已经有一个标记用了 ID ${result.marker.id}` }
    }
    if (existing.length >= MAX_CUSTOM_MARKERS) {
      return { ok: false, problem: `最多 ${MAX_CUSTOM_MARKERS} 个自定义标记` }
    }
    return this.mutateDefinitions(
      (set) => ({ ...set, markers: [...set.markers, result.marker] }),
      `新增自定义标记 ${result.marker.id}`,
    )
  }

  /**
   * 改一个自定义标记（按 **ID** 定位 —— 与 `updateCustomTerrain` 逐字同理：
   * 弹窗显示的那份与"点下去那一刻的活动地图"未必同一份，按下标会改错条目）。
   *
   * 只接受"补丁"，且**只切模式时其余字段原样带着走** ——
   * 于是"字形 ↔ 图片"来回切不会丢配置（切回去时之前选的图还在）。
   */
  async updateCustomMarker(
    id: string,
    patch: { label?: unknown; icon?: unknown; imagePath?: unknown; mode?: unknown },
  ): Promise<void> {
    await this.mutateDefinitions((set) => {
      const current = set.markers.find((marker) => marker.id === id)
      if (!current) return set
      const next = validateCustomMarkerInput({
        id: current.id,
        label: patch.label !== undefined ? patch.label : current.label,
        icon: patch.icon !== undefined ? patch.icon : current.icon,
        imagePath: patch.imagePath !== undefined ? patch.imagePath : current.imagePath,
        mode: patch.mode !== undefined ? patch.mode : current.mode,
      })
      if (!next.ok) {
        console.warn(`[project-kaki] 自定义标记 ${current.id} 的修改被拒绝：${next.problem}`)
        return set
      }
      return { ...set, markers: set.markers.map((marker) => (marker.id === id ? next.marker : marker)) }
    }, `修改自定义标记 ${id}`)
  }

  /**
   * 删除一个自定义标记。
   *
   * **不动地图数据**：地图上已经用了这个图标的标记仍然留在文件里，只是画成回退视觉。
   * 与删除自定义地形同一条承诺（见各文档里的"认不出 ≠ 丢弃"）。
   */
  async removeCustomMarker(id: string): Promise<void> {
    await this.mutateDefinitions((set) => {
      if (!set.markers.some((marker) => marker.id === id)) return set
      return { ...set, markers: set.markers.filter((marker) => marker.id !== id) }
    }, `删除自定义标记 ${id}`)
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
    await this.persistSettings()
    this.layers?.redrawAll()
  }

  /**
   * 改第 index 个**内置**区域类型的颜色。
   *
   * 旧接口（工具条曾经是"一排预设色块"，设置页也按下标排），语义保持不变：
   * 下标与内置 6 种一一对应；现在它写的是区域类型目录里那一条的颜色，
   * 旧字段 `regionColors` 只是目录的镜像（不再是渲染依据）。
   */
  async setRegionColor(index: number, color: string): Promise<void> {
    const builtin = this.activeDefinitions().regionTypes.filter((entry) => isBuiltinRegionType(entry.id))
    const target = builtin[index]
    if (target === undefined) return
    await this.updateRegionType(target.id, { color })
  }

  /**
   * 改一种区域类型的参数（填充色 / 不透明度 / 边框色 / 边框宽 / 边框虚线）。
   *
   * 全部校验在 `applyRegionTypePatch` 里（纯函数）：非法虚线**整条拒绝**并返回可读原因，
   * 而不是"悄悄回退到出厂值"——后者会让用户以为自己填的生效了。
   *
   * ⚠️ 改的是**这张地图**的那一套参数（定义随图）：内置 6 种与自定义类型一视同仁。
   * 只影响**之后新画**的区域：已经画好的区域把参数存在地图文件里。
   */
  async updateRegionType(
    id: string,
    patch: RegionTypePatch,
  ): Promise<{ ok: true } | { ok: false; problem: string }> {
    const current = this.activeDefinitions().regionTypes.find((entry) => entry.id === id)
    if (current === undefined) return { ok: false, problem: `没有这个区域类型：${id}` }
    const next = applyRegionTypePatch(current, patch)
    if (!next.ok) return next
    return this.mutateDefinitions(
      (set) => ({ ...set, regionTypes: set.regionTypes.map((entry) => (entry.id === id ? next.entry : entry)) }),
      `修改区域类型 ${id}`,
    )
  }

  /**
   * 新增一个自定义区域类型。
   *
   * 与 `addCustomPathType` 逐字同构：校验全在 `validateCustomRegionTypeInput` 里（纯函数），
   * 这里只负责落盘与通知渲染层。重名会被拒绝：同一个 ID 两条定义会让"画出来是哪一条"
   * 变成说不清的问题。
   */
  async addCustomRegionType(input: {
    id: unknown
    label?: unknown
    color?: unknown
    opacity?: unknown
    borderColor?: unknown
    borderWidth?: unknown
    borderDash?: unknown
  }): Promise<{ ok: true } | { ok: false; problem: string }> {
    // ID 留空 = 自动生成（同 addCustomTerrain）
    const entries = this.activeDefinitions().regionTypes
    const result = validateCustomRegionTypeInput({
      ...input,
      id: isBlankCustomId(input.id)
        ? suggestCustomId(
            typeof input.label === 'string' ? input.label : '',
            customRegionTypeEntries(entries).map((item) => item.id),
            CUSTOM_REGION_TYPE_PREFIX,
            'region',
          )
        : input.id,
    })
    if (!result.ok) return result
    if (entries.some((entry) => entry.id === result.entry.id)) {
      return { ok: false, problem: `已经有一个区域类型用了 ID ${result.entry.id}` }
    }
    if (customRegionTypeEntries(entries).length >= MAX_CUSTOM_REGION_TYPES) {
      return { ok: false, problem: `最多 ${MAX_CUSTOM_REGION_TYPES} 个自定义区域类型` }
    }
    return this.mutateDefinitions(
      (set) => ({ ...set, regionTypes: [...set.regionTypes, result.entry] }),
      `新增区域类型 ${result.entry.id}`,
    )
  }

  /**
   * 删除一个自定义区域类型。
   *
   * **不动地图数据**：已经用了这个类型的区域仍然留在文件里，只是画成回退样式。
   * 反过来做（顺手把区域删掉）是不可逆的，而用户通常只是想清理一下列表。
   */
  async removeCustomRegionType(id: string): Promise<void> {
    await this.mutateDefinitions((set) => {
      const list = set.regionTypes.filter((entry) => entry.id !== id)
      if (list.length === set.regionTypes.length) return set
      return { ...set, regionTypes: list }
    }, `删除区域类型 ${id}`)
  }

  // -------------------------------------------------- 改 ID 并迁移地图里的引用

  /**
   * 想改 ID 时先做校验与归一化（与"新增"共用同一套规则）。
   *
   * 为什么复用各目录的纯函数：如果改名走一套独立规则，就会出现"建得出来的 ID 改不过去"
   * 或者"改完的字面量下次解析被判非法"这种自相矛盾的状态。
   */
  private validateRenameTarget(
    kind: DefinitionKind,
    fromId: string,
    rawNewId: string,
  ): { ok: true; toId: string } | { ok: false; problem: string } {
    const trimmed = rawNewId.trim()
    if (trimmed.length === 0) return { ok: false, problem: '请输入新的 ID（留空不会改动任何东西）' }
    const problem = definitionIdProblem(kind, trimmed)
    if (problem !== null) return { ok: false, problem }
    const toId = definitionIdNormalize(kind, trimmed)
    if (toId === null) return { ok: false, problem: `这个 ID 不能用（${definitionKindFieldHint(kind)}），换个写法试试` }
    if (toId === fromId) return { ok: false, problem: `新 ID 与当前 ID 相同（都是 ${fromId}），不需要改` }
    const taken = this.definitionIds(kind).filter((id) => id !== fromId)
    if (taken.includes(toId)) {
      return { ok: false, problem: `已经有一个${DEFINITION_KIND_LABELS[kind]}用了 ID ${toId}` }
    }
    return { ok: true, toId }
  }

  /** 某一类**当前地图定义集**里所有定义 ID（含内置：改名时不许撞上内置 ID，否则语义会串） */
  private definitionIds(kind: DefinitionKind): string[] {
    const set = this.activeDefinitions()
    switch (kind) {
      case 'terrain':
        return set.terrains.map((item) => item.id)
      case 'marker':
        return set.markers.map((item) => item.id)
      case 'path':
        return set.pathTypes.map((item) => item.id)
      case 'region':
        return set.regionTypes.map((item) => item.id)
    }
  }

  /**
   * 扫一遍库里所有地图文档，算出"改这个 ID 会动哪些文件、各几处"。
   *
   * **只读不写**：预览与执行共用它，于是"对话框里说的"与"实际做的"不可能不一致
   * （与定义文件导入同一套路）。只读打开（版本过高）的文档一律跳过 —— 那些文件我们无权改写。
   *
   * ⚠️ 定义随图（方案 B）之后，**当前地图**必须一起产出写盘计划，哪怕它一处引用都没有：
   * 定义本体就住在它的 `definitions` 段里，不写它就等于"引用的 ID 改了、定义还是旧的"。
   * 其余地图只改引用（它们各有自己那份定义，不受影响）。
   */
  private async collectRename(
    kind: DefinitionKind,
    fromId: string,
    toId: string,
  ): Promise<{
    files: RenameFilePlan[]
    writes: Array<{ file: TFile; document: MapDocument; name: string; canvases: string[]; rest: Record<string, string | string[]> }>
    /** 当前地图改名后那份定义集（用来同步库级模板）；没有可编辑的地图时为 `null` */
    librarySet: MapDefinitionSet | null
  }> {
    const store = this.store
    if (store === null) return { files: [], writes: [], librarySet: null }
    /** 定义本体所在的那张图（就是"当前地图"，见 `definitionTarget`） */
    const targetPath = this.definitionTarget()?.mapPath ?? null
    const files: RenameFilePlan[] = []
    const writes: Array<{
      file: TFile
      document: MapDocument
      name: string
      canvases: string[]
      rest: Record<string, string | string[]>
    }> = []
    let librarySet: MapDefinitionSet | null = null
    for (const file of store.listMapFiles()) {
      const loaded = await store.load(file)
      if (loaded.document === null || loaded.readOnly) continue
      const renamed = renameReferences(loaded.document, kind, fromId, toId)
      let document_ = renamed.document
      /** 这份文件里"定义本体"的那一条是否被改到（只有当前地图才可能为 true） */
      let definitionChanged = false
      if (file.path === targetPath) {
        const next = renameDefinitionEntry(this.definitionsOf(document_), kind, fromId, toId)
        if (next !== this.definitionsOf(document_)) {
          librarySet = next
          definitionChanged = true
          document_ = {
            ...document_,
            definitions: definitionsBlockOf(next, document_.definitions),
            version: Math.max(document_.version, MAP_DOCUMENT_VERSION),
          }
        }
      }
      // `changed` 只数**引用**（报告的措辞说的是"几处引用"）；定义本体那一条由 `definitionChanged` 表达
      if (renamed.changed === 0 && !definitionChanged) continue
      files.push({ path: file.path, changed: renamed.changed })
      writes.push({
        file,
        document: document_,
        name: loaded.frontmatter.name ?? defaultMapNameFromPath(file.path),
        canvases: loaded.frontmatter.canvases,
        rest: loaded.frontmatter.rest,
      })
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files, writes, librarySet }
  }

  /** 只算影响面，不写任何东西（对话框里实时显示） */
  async previewDefinitionRename(kind: DefinitionKind, fromId: string, rawNewId: string): Promise<RenamePreview> {
    const target = this.validateRenameTarget(kind, fromId, rawNewId)
    if (!target.ok) return { ok: false, problem: target.problem }
    // 先把已经提交、还在防抖窗口里的改动落盘：预览与执行必须扫**同一份**，
    // 否则会出现"预览说 1 处、执行改了 2 处"（它只是把已提交的东西持久化，不改内容）
    await this.store?.flush()
    const collected = await this.collectRename(kind, fromId, target.toId)
    const text = describeRenamePlan({
      kind,
      fromId,
      toId: target.toId,
      files: collected.files,
      totalChanged: collected.files.reduce((sum, item) => sum + item.changed, 0),
    })
    return { ok: true, text: `${text}\n（现在只是预览；点「改 ID」才会真正写盘）` }
  }

  /**
   * 真正执行：地图文件里的引用 + **当前地图定义段里那条定义**一起改。
   *
   * 为什么不再有"改设置里的定义 ID"这一步：定义随图之后它不在设置里了 ——
   * 它在那张地图的 `definitions` 段里，而 `collectRename` 已经把这件事折进**同一次写盘**，
   * 于是不会出现"引用改了、定义没改"的中间态。
   *
   * 顺序照旧：**先改文件、再同步库级模板**。反过来的话，中途失败会留下"模板里是新 ID、
   * 地图里还是旧 ID"的状态。按现在的顺序，最坏情况是"文件已改、模板没改"，
   * 此时旧 ID 仍被地图引用，重新跑一次改名即可收敛（幂等）。
   */
  async renameCustomDefinition(kind: DefinitionKind, fromId: string, rawNewId: string): Promise<RenameOutcome> {
    const target = this.validateRenameTarget(kind, fromId, rawNewId)
    if (!target.ok) return { ok: false, problem: target.problem }
    // 先把地图层的防抖写入落盘：定义随图之后，**定义本体就在这几张文件里**，
    // 而改名是按"盘上那份"扫的 —— 不 flush 就会漏掉还只在内存里的那一段
    // （表现是"引用改了、定义没改"，用户看到满地"未知（旧 ID）"）。
    await this.store?.flush()
    const collected = await this.collectRename(kind, fromId, target.toId)
    for (const write of collected.writes) {
      await this.store?.writeNow(write.file, write.document, write.name, write.canvases, write.rest)
    }
    if (collected.librarySet !== null) {
      this.mirrorLibraryDefinitions(collected.librarySet)
      await this.persistSettings()
      this.refreshPanel()
    }
    // 已打开的画布要重新读盘，否则它内存里还是旧 ID（界面会显示"未知（旧 ID）"）
    for (const item of collected.files) await this.layers?.reloadMap(item.path)
    const totalChanged = collected.files.reduce((sum, item) => sum + item.changed, 0)
    const report = describeRenamePlan({ kind, fromId, toId: target.toId, files: collected.files, totalChanged })
    // 多行文本走报告面板（与地图状态报告同一套路），不塞进 Notice
    this.openReport({ title: '改 ID 完成', text: report })
    return { ok: true, report }
  }

  // -------------------------------------------------- 选中对象：链接笔记

  /**
   * 给当前选中项挑一篇笔记（侧栏检查器里的「选择笔记…」）。
   *
   * 复用图片/定义文件那一套 `openAssetPicker`：**同一份**"没得选时说清原因 /
   * 打不开时给退路 / 取消时什么都不做"的实现，只是把候选换成 `.md`。
   * 这正是用户报的那个缺陷（"无法重新给对象链接笔记"）缺少的最后一块 ——
   * 以前标记只在创建时能填链接，之后再也没有入口。
   */
  pickNoteForSelection(): void {
    const editor = this.layers?.getInspectorEditor()
    if (!editor) {
      new Notice('先启用地图层并选中一个对象。', NOTICE_MAX_MS)
      return
    }
    const info = editor.selectionInfo()
    if (info === null) {
      new Notice('先在画布上点一下要链接的对象。', NOTICE_MAX_MS)
      return
    }
    if (!info.canLink) {
      new Notice(`${info.kindLabel}不能链接笔记。`, NOTICE_MAX_MS)
      return
    }
    this.openAssetPicker({
      title: `链接到笔记 · ${info.kindLabel}`,
      files: listNotePaths(this.app.vault.getFiles().map((file) => file.path)),
      kind: 'note',
      emptyHint: emptyNoteListHint(),
      onChoose: (path) => {
        const current = this.layers?.getInspectorEditor()
        if (!current) return
        // 落进文档 + 撤销栈：撤销一次即可回到原来的链接（或"没有链接"）
        if (current.setSelectionLink(path)) this.refreshPanel()
      },
    })
  }

  /** 打开「改 ID…」对话框（设置页每一行自定义定义都有入口） */
  openRenameDefinitionModal(kind: DefinitionKind, id: string, displayName: string): void {
    const options = {
      kindLabel: DEFINITION_KIND_LABELS[kind],
      currentId: id,
      displayName: displayName.length > 0 ? displayName : id,
      onPreview: (rawNewId: string) => this.previewDefinitionRename(kind, id, rawNewId),
      onConfirm: (rawNewId: string) => this.renameCustomDefinition(kind, id, rawNewId),
    }
    this.renameModalFactory(this.app, options).open()
  }

  /** 供测试注入替身（与 `setReportModalFactory` 同一套路） */
  setRenameModalFactory(factory: RenameModalFactory): void {
    this.renameModalFactory = factory
  }

  // -------------------------------------------------- 「地图定义」弹窗与删除定义

  /** 打开「地图定义」弹窗（侧栏面板「地图定义」组与命令面板的共同入口） */
  openDefinitionManagerModal(): void {
    this.definitionModalFactory(this.app, this).open()
  }

  /** 供测试注入替身（与 `setReportModalFactory` 同一套路） */
  setDefinitionModalFactory(factory: DefinitionModalFactory): void {
    this.definitionModalFactory = factory
  }

  /**
   * 打开「设置海拔标定…」对话框，把结果写进**地图文件**的 `elevation` 段（可撤销）。
   *
   * 三条边界：
   * - 标定属于**地图**（这个世界的事实），所以走编辑器的 `setElevationCalibration` →
   *   一次提交 = 一条历史 → Ctrl+Z 一次回到原标定；
   * - 对话框是异步的，回调里**重新取一次编辑器**（期间视图可能已关闭，与命名对话框同一防线）；
   * - 文档里没有这一段时传 `null` 进去（回显"未标定"），而不是编一个 0 出来。
   */
  openElevationCalibrationModal(): void {
    const editor = this.layers?.getActiveEditor() ?? null
    const document_ = this.layers?.getActiveDocument() ?? null
    if (!editor || !document_) {
      new Notice('需要先启用一张 Canvas 的地图层，才能设置它的海拔标定。', NOTICE_MAX_MS)
      return
    }
    this.elevationModalFactory(this.app, {
      current: document_.elevation ?? null,
      onSubmit: (calibration) => {
        // 对话框是异步的：期间视图可能已关闭（编辑器被移除），必须重新取一次
        const target = this.layers?.getActiveEditor() ?? null
        if (!target) return
        if (target.setElevationCalibration(calibration)) {
          new Notice(
            calibration === null ? '已清除海拔标定（相对值读数不再可用）' : '已设置海拔标定（Ctrl/Cmd+Z 可撤销）',
            4000,
          )
        }
      },
    }).open()
  }

  /* --------------------------------------------------------- 每格默认值（§B） */

  /**
   * 「设置数值图层默认值…」对话框里要渲染的行 / 命令面板描述里要用的条目 —— **从字段表派生**。
   *
   * 派生而不是写死"温度 + 深度"：以后加一个数值字段，弹窗与描述都自动多一项（纪律 §4.7）。
   * 分类字段（例如 §D 的生物群系）会被 `numericDefaultRows()` 里的 `numeric` 筛掉。
   */
  private defaultRowEntries(): Array<{ key: string; label: string; unit: string }> {
    return numericDefaultRows().map((row) => {
      const spec = OVERLAY_FIELDS.find((candidate) => candidate.cellKey === row.key)
      return { key: row.key, label: spec?.label ?? row.key, unit: spec?.unit ?? '' }
    })
  }

  /**
   * 打开「设置数值图层默认值…」对话框，把结果写进**地图文件**的 `dataDefaults` 段（可撤销）。
   *
   * 与「设置海拔标定…」同一套路（三条边界也一样）：走编辑器的 `setDataDefaults` →
   * 一次提交 = 一条历史；回调里**重新取一次编辑器**（对话框是异步的）；
   * 文档里没有这一段时传 `null` 进去（回显"不兜底"），而不是编一个 0 出来。
   */
  openDataDefaultsModal(): void {
    const editor = this.layers?.getActiveEditor() ?? null
    const document_ = this.layers?.getActiveDocument() ?? null
    if (!editor || !document_) {
      new Notice('需要先启用一张 Canvas 的地图层，才能设置它的数值图层默认值。', NOTICE_MAX_MS)
      return
    }
    const current = document_.dataDefaults ?? null
    this.dataDefaultsModalFactory(this.app, {
      current,
      rows: numericDefaultRows(),
      // 文件里有、而字段表里没有的键：**原样保留**（保存不会把它抹掉），但要让用户看见
      unknownKeys: unknownDefaultKeys(current, OVERLAY_FIELDS.map((spec) => spec.cellKey)),
      onSubmit: (defaults) => {
        // 对话框是异步的：期间视图可能已关闭（编辑器被移除），必须重新取一次
        const target = this.layers?.getActiveEditor() ?? null
        if (!target) return
        if (target.setDataDefaults(defaults)) {
          new Notice(
            defaults === null ? '已清除数值图层默认值（没量过值的格回到空白）' : '已设置数值图层默认值（Ctrl/Cmd+Z 可撤销）',
            4000,
          )
        }
      },
    }).open()
  }

  /* --------------------------------------------------------- 选择筛选器（§C.2） */

  /**
   * 打开「按规则筛选选择…」对话框。
   *
   * 与另外两个地图级对话框同一套路，但有一处**刻意的不同**：它**不改地图数据**，
   * 因此不进撤销栈、也不提示"可撤销"—— 改的只是"我正在看哪些格"（§C.3）。
   *
   * 对话框**不自动关闭**：用户通常要连着按几次（先"替换"、再"并入"、再"连通扩展"），
   * 每按一次就刷新一次"当前选择 N 格"，效果当场可见。
   */
  openSelectionFilterModal(): void {
    const editor = this.layers?.getActiveEditor() ?? null
    if (!editor) {
      new Notice('需要先启用一张 Canvas 的地图层，才能筛选选择。', NOTICE_MAX_MS)
      return
    }
    // 规则下拉里的候选项**现取**：目录会随设置变化（自定义地形 / 自定义生物群系），
    // 常量化就等于"改了要重启"
    const context = this.selectionRuleContext()
    this.selectionFilterModalFactory(this.app, {
      context,
      /**
       * 顶部那行大字（"按这些条件会选中 37 格，其中 5 格没有温度"）与按钮上的格数**全部靠试算**。
       *
       * 关键：命中判定走的就是应用时同一个 `ruleHits`（ISSUE-003 验收第 2 条要的"数字与实际
       * 应用结果一致"于是是**结构上成立**的 —— 不是两处实现碰巧一样）。
       * `current` 每次现取：弹窗开着时用户还能在画布上继续点格。
       */
      preview: (group) => {
        const document_ = this.layers?.getActiveDocument() ?? null
        const current = (this.layers?.getActiveEditor() ?? editor).getCellSelection()
        if (document_ === null) {
          return { hits: 0, current: current.length, missing: [], after: { replace: 0, add: 0, remove: 0, inside: 0 } }
        }
        const hits = ruleHits(document_, group, context)
        const hitSet = new Set(hits)
        // "其中 5 格没有温度"只提**这条规则真的用到的**字段：一张有温度的图不该顺带报"3 格没有深度"
        const referenced = new Set(group.clauses.filter(clauseIsUsable).map((clause) => clause.key))
        const missing = summarizeSelection(document_, hits)
          .fields.filter((field) => field.missing > 0 && referenced.has(field.key))
          .map((field) => ({ label: field.label, count: field.missing }))
        return {
          hits: hits.length,
          current: current.length,
          missing,
          // 四个动作做完会剩几格：全部是纯计算（`applyRuleToSelection` / `intersectSelection` 都不改状态）
          after: {
            replace: hits.length,
            add: applyRuleToSelection(current, document_, group, 'add', context).length,
            remove: applyRuleToSelection(current, document_, group, 'remove', context).length,
            inside: current.filter((key) => hitSet.has(key)).length,
          },
        }
      },
      // 三个集合动作与两个"动作"都走**编辑器**（它持有当前选择），
      // 而对话框是异步的 → 每次调用都重新取一次编辑器（期间视图可能已关闭）。
      // 上下文也一起传：`biomeTag` 那条规则要知道"某个群系带哪些标签"。
      apply: (group, mode) => (this.layers?.getActiveEditor() ?? editor).applySelectionRule(group, mode, context),
      filterInside: (group) => (this.layers?.getActiveEditor() ?? editor).filterSelectionInPlace(group, context),
      expand: () => (this.layers?.getActiveEditor() ?? editor).expandSelectionByTerrain(),
    }).open()
  }

  /**
   * 选择筛选器的**规则上下文**：把"现在有哪些地形 / 生物群系（含各自的标签）"整理好。
   *
   * 为什么在这里（而不是规则表里）：目录来自插件设置与内置表两处，
   * 而规则表是模块级常量 —— 常量化它就等于"改了自定义定义要重启插件"。
   * 生物群系的**标签跟着选项一起进去**：`biomeTag` 规则要在纯函数里判断
   * "这一格的群系带不带这个标签"，而 `match` 拿不到目录（见 `selectionRules.ts`）。
   */
  private selectionRuleContext(): SelectionRuleContext {
    // 目录**按活动地图**解析（与检查器、画布同一份定义）：筛选器列出的是"这张图上真有意义的地形/群系"
    const definitions = this.activeDefinitions()
    return {
      terrains: listResolvedTerrainStyles(definitions.terrains).map((style) => ({
        value: style.id,
        label: style.label,
      })),
      biomes: listResolvedBiomeStyles(definitions.biomes).map((entry) => ({
        value: entry.id,
        label: entry.label,
        tags: entry.tags,
      })),
      biomeTags: BIOME_TAGS.map((tag) => ({ value: tag.id, label: `${tag.group}·${tag.label}` })),
    }
  }

  /** 同上：替换「删除定义」确认框（测试里用替身直接驱动"有引用才弹"这条分流） */
  setDeleteModalFactory(factory: ConfirmDeleteModalFactory): void {
    this.deleteModalFactory = factory
  }

  /** 取一条定义当前的显示名（找不到就用 ID）—— 只用于对话框标题，帮用户确认删的是哪一条 */
  private definitionDisplayName(kind: DefinitionKind, id: string): string {
    const set = this.activeDefinitions()
    const found = ((): { label: string } | undefined => {
      switch (kind) {
        case 'terrain':
          return set.terrains.find((item) => item.id === id)
        case 'marker':
          return set.markers.find((item) => item.id === id)
        case 'path':
          return set.pathTypes.find((entry) => entry.id === id)
        case 'region':
          return set.regionTypes.find((entry) => entry.id === id)
      }
    })()
    return found?.label ?? id
  }

  /**
   * 扫一遍库里所有地图文档，数出"这条定义被谁引用了多少次"。
   *
   * **只读不写**：预览与"要不要拦一下"的判断共用它，于是"对话框里说的"与"实际做的"
   * 不可能不一致（与 `collectRename` / 定义文件导入同一套路）。只读打开的文档一律跳过 ——
   * 那些文件我们无权改写，也不该把它们算进影响面。
   */
  private async collectReferences(
    kind: DefinitionKind,
    id: string,
  ): Promise<{ files: DeletionFilePlan[]; total: number }> {
    const store = this.store
    if (store === null) return { files: [], total: 0 }
    const files: DeletionFilePlan[] = []
    for (const file of store.listMapFiles()) {
      const loaded = await store.load(file)
      if (loaded.document === null || loaded.readOnly) continue
      const count = countReferences(loaded.document, kind, id)
      if (count === 0) continue
      files.push({ path: file.path, count })
    }
    // 按路径排序：报告里顺序稳定才可比对（与 collectRename 一致）
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files, total: files.reduce((sum, item) => sum + item.count, 0) }
  }

  /**
   * 把定义从**当前地图的定义集**里移除。
   *
   * 四类都**按 ID** 定位：ID 是这条定义的稳定身份，而"当前地图"在弹窗开着时可能已经换过 ——
   * 按 ID 删最坏只是"这条不在这一份里 → 什么也不做"（见 `updateCustomTerrain` 的说明）。
   *
   * 定义随图之后，"从设置里移除"这句话本身就不再准确 —— 移除的是**这张地图**的那一条
   * （其它地图各有自己那份定义，不会被牵连）。
   */
  private async performRemoveCustomDefinition(kind: DefinitionKind, id: string): Promise<void> {
    switch (kind) {
      case 'terrain':
        await this.removeCustomTerrain(id)
        return
      case 'marker':
        await this.removeCustomMarker(id)
        return
      case 'path':
        await this.removeCustomPathType(id)
        return
      case 'region':
        await this.removeCustomRegionType(id)
        return
    }
  }

  /**
   * 删除一条自定义定义（「地图定义」弹窗里每一行的「删除」）。
   *
   * ## 只在**有引用**时才拦一下
   *
   * - **没有人用它** → 直接删，只给一条 Notice。那种情况下没有任何影响面可说，
   *   弹框只会白挡一下（用户明确要求"无引用就别打扰"）；
   * - **有人用它** → 先弹确认框把影响面说清楚（几张地图、共几处、**对象不会被删**），
   *   用户在看清之后才决定。
   *
   * 两种情况下真正执行的删除**完全一样**，也都不碰地图文件 —— 差别只在"要不要先让人看一眼"。
   */
  async requestRemoveCustomDefinition(kind: DefinitionKind, id: string): Promise<void> {
    const displayName = this.definitionDisplayName(kind, id)
    const collected = await this.collectReferences(kind, id)
    if (collected.total === 0) {
      await this.performRemoveCustomDefinition(kind, id)
      new Notice(`已删除${DEFINITION_KIND_LABELS[kind]}定义 ${displayName}（没有地图在用它）`, NOTICE_MAX_MS)
      return
    }
    this.deleteModalFactory(this.app, {
      kindLabel: DEFINITION_KIND_LABELS[kind],
      id,
      displayName,
      // 预览与判断共用同一次只读扫描的产物；真要重算也不写任何东西
      onPreview: async () => ({
        ok: true,
        text: describeDeletionPlan({ kind, id, files: collected.files, total: collected.total }),
      }),
      onConfirm: async () => {
        try {
          await this.performRemoveCustomDefinition(kind, id)
          return { ok: true }
        } catch (error) {
          return { ok: false, problem: error instanceof Error ? error.message : String(error) }
        }
      },
    }).open()
  }

  /** 改名称字体族（空串 = 跟随主题）；非法串会被收敛成空串而不是透传给 canvas */
  async setLabelFontFamily(value: string): Promise<void> {
    const next = normalizeFontFamily(value)
    if (next === this.pluginSettings.labelFontFamily) return
    this.pluginSettings = { ...this.pluginSettings, labelFontFamily: next }
    await this.persistSettings()
    this.layers?.setStylePalette()
  }

  /**
   * 路径 / 区域类型的参数恢复出厂（「地图定义」弹窗里那一行「恢复出厂参数」）。
   *
   * **只改参数、不动定义**：内置类型恢复成工厂值；自定义类型是用户建的定义，留着不动
   * （见 `resetPathTypeStyles` / `resetRegionTypeStyles` 的注释）。
   *
   * ⚠️ 定义随图之后改的是**这张地图**的那一套参数 —— 别的图不受影响。
   */
  async resetDefinitionTypeStyles(): Promise<{ ok: true } | { ok: false; problem: string }> {
    return this.mutateDefinitions(
      (set) => ({
        ...set,
        pathTypes: resetPathTypeStyles(set.pathTypes),
        regionTypes: resetRegionTypeStyles(set.regionTypes),
      }),
      '恢复路径/区域类型出厂参数',
    )
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
    await this.persistSettings()
    this.refreshPanel()
  }

  /**
   * 切换某个图层的显示。
   *
   * 顺序是刻意的：**改内存 → 立刻广播 → 再落盘**。
   * 广播不能等 `await saveData(...)`：侧栏里的图层开关是同步点下去的，
   * 等落盘再广播意味着"点了之后下一帧仍然画着名称"（而且测试里同步断言也拿不到新值）。
   * 落盘是后台的事，它慢一点不影响画面。
   *
   * 这里**是网格、名称等开关的唯一入口**：老代码里那个独立的 `setShowGrid`
   * 只是它的薄包装，现在已经删掉 —— 留着会让"网格状态"有两个写入口。
   */
  async setLayerVisible(key: LayerKey, value: boolean): Promise<void> {
    await this.setLayerVisibleFor(this.activeViewMapPath(), key, value)
  }

  /**
   * 同上，但**指定是哪张地图**（画布上的工具条走这一条）。
   *
   * 为什么值得多一个方法：多画布同开时，"在 B 画布上点 B 的图层开关"必须改 B 那一张图 ——
   * 按"活动画布"解析会让 B 的按钮点了不翻、A 的图反倒变了（同一份代码在两个画布上的两种表现，
   * 正是这个项目最怕的那类静默不一致）。
   */
  async setLayerVisibleFor(mapPath: string | null, key: LayerKey, value: boolean): Promise<void> {
    // W4-2：图层开关按**地图**记（"这张图我想看什么"），同时镜像回库级模板
    const next = value === true
    const current = this.layersFor(mapPath)
    const layers = withLayerVisibility(current, key, next)
    if (layers === current) return
    this.commitViewSettings(mapPath, { layers })
    this.layers?.setLayers()
    // 面板自己也显示这六个开关：工具条按钮、设置页、命令都能改图层，
    // 所以刷新要在这里做（而不是只让"点面板的那一次"自己刷新），否则会出现
    // "从别处改了图层，面板上的开关还亮着旧状态"。requestRender 会把同帧的重复请求合并掉。
    this.refreshPanel()
    await this.persistSettings()
  }

  /**
   * 写回数值图层（温度 / 深度…）的渲染参数：配色 / 越界色 / 不透明度 / 是否画数值。
   *
   * 与 `setLayerVisible` 同一套路：**先改内存 → 再落盘**，刷新画布靠"每帧现读"，
   * 所以这里**不需要**广播（`getOverlayStyles` 下一帧就会拿到新值）。
   * 面板/设置页自己负责重绘（它们各自知道要保住滚动位置）。
   */
  async setOverlayStyle(field: FieldId, patch: Partial<OverlayStyle>): Promise<void> {
    // W4-2：配色 / 越界色 / 不透明度 / 显示方式按**地图**记，同时镜像回库级模板。
    // 规范化（只存改过的那些 / 空表不留键）仍由 `normalizeOverlayStyles` 一处保证
    const mapPath = this.activeViewMapPath()
    const current = this.overlaysFor(mapPath)
    const next = normalizeOverlayStyles({
      ...current,
      [field]: { ...current[field], ...patch },
    })
    this.commitViewSettings(mapPath, { overlays: next })
    // 配色变了 → 图例里的渐变条与越界计数也要跟着变（图例只在"设置变了"时刷新，不跟每帧走）
    this.layers?.setLayers()
    await this.persistSettings()
  }

  /** 把某一层的配色恢复出厂（只动配色，不动透明度与"画数值"开关） */
  async resetOverlayRamp(field: FieldId): Promise<void> {
    const fallback = overlayField(field).defaultStyle()
    await this.setOverlayStyle(field, { ramp: fallback.ramp })
  }

  /**
   * 给**分类字段**的某一条改颜色（空串 = 删掉这条覆盖，回到分类表里的颜色）。
   *
   * 与 `setOverlayStyle` 同一条路（`normalizeOverlayStyles` 会按字段类型决定收不收这一项）：
   * 于是"只存改过的那些"与"空表不留键"这两条口径由规范化一处保证，这里不重复实现。
   */
  async setOverlayCategoryColor(field: FieldId, categoryId: string, color: string): Promise<void> {
    const current = { ...(this.overlaysFor(this.activeViewMapPath())[field].categoryColors ?? {}) }
    if (color.length === 0) delete current[categoryId]
    else current[categoryId] = color
    await this.setOverlayStyle(field, { categoryColors: current })
  }

  async setShowLegend(value: boolean): Promise<void> {
    await this.setShowLegendFor(this.activeViewMapPath(), value)
  }

  /** 同上，但**指定是哪张地图**（画布上的工具条走这一条）—— 理由见 `setLayerVisibleFor` */
  async setShowLegendFor(mapPath: string | null, value: boolean): Promise<void> {
    // W4-2：图例显隐也按**地图**记（"这张图我要不要看图例"）
    const next = value === true
    if (next === this.showLegendFor(mapPath)) return
    this.commitViewSettings(mapPath, { showLegend: next })
    this.layers?.setLayers()
    await this.persistSettings()
  }

  /**
   * 隐藏 / 重新显示「快速上手」清单。
   *
   * **两份各有各的开关**（设置页一份、侧栏面板一份）：它们是两份不同的文案
   * （各自讲各自的入口），也出现在两个不同的地方 —— 用户可能只想关掉其中一份。
   *
   * 顺序与 `setShowLegend` 同套路：**先改内存 → 通知面板 → 再落盘**。
   * 设置页那边由调用方自己重绘（它就在设置页里，知道要保住滚动位置）。
   *
   * ⚠️ 这个开关必须是**可逆**的：隐藏之后设置页要留一行「重新显示」，
   * 否则用户一旦点错就再也找不到引导（引导本身正是"找不到入口"的解法）。
   */
  async setQuickStartHidden(where: 'settings' | 'panel', hidden: boolean): Promise<void> {
    const next = hidden === true
    if (where === 'settings') {
      if (next === this.pluginSettings.hideQuickStartSettings) return
      this.pluginSettings = { ...this.pluginSettings, hideQuickStartSettings: next }
    } else {
      if (next === this.pluginSettings.hideQuickStartPanel) return
      this.pluginSettings = { ...this.pluginSettings, hideQuickStartPanel: next }
    }
    this.refreshPanel()
    await this.persistSettings()
  }

  /** 替换放置对话框（自动化测试用；不改动则为真实的输入对话框） */
  setPlaceModalFactory(factory: PlaceModalFactory): void {
    this.placeModalFactory = factory
  }

  /** 替换命名对话框（自动化测试用；不改动则为真实的输入对话框） */
  setPromptModalFactory(factory: PromptModalFactory): void {
    this.promptModalFactory = factory
  }

  /** 替换海拔标定对话框（自动化测试用；不改动则为真实对话框） */
  setElevationModalFactory(factory: ElevationModalFactory): void {
    this.elevationModalFactory = factory
  }

  /** 替换每格默认值对话框（同上） */
  setDataDefaultsModalFactory(factory: DataDefaultsModalFactory): void {
    this.dataDefaultsModalFactory = factory
  }

  /** 替换选择筛选器对话框（同上） */
  setSelectionFilterModalFactory(factory: SelectionFilterModalFactory): void {
    this.selectionFilterModalFactory = factory
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
    this.openAssetPicker({
      ...(options.title !== undefined ? { title: options.title } : {}),
      files: listImagePaths(this.app.vault.getFiles().map((file) => file.path)),
      kind: 'image',
      emptyHint: emptyImageListHint(),
      onChoose: options.onChoose,
    })
  }

  /**
   * 让用户从**库内文件夹**里挑一个（导出落点用）。
   *
   * 与 `pickImageFile` 走同一个 `openAssetPicker`，只是候选换成文件夹：
   * 候选**从库内文件路径推出来**（`listFolderPaths`），所以库根永远在列，
   * 永远不会有"没得选"的情况 —— `emptyHint` 只是接口要求，实际到不了。
   */
  pickFolder(options: { title?: string; onChoose: (folder: string) => void }): void {
    this.openAssetPicker({
      ...(options.title !== undefined ? { title: options.title } : {}),
      files: listFolderPaths(this.app.vault.getFiles().map((file) => file.path)),
      kind: 'folder',
      emptyHint: '库里没有任何文件夹可选（这不该发生：库根目录总在清单里）。',
      onChoose: options.onChoose,
    })
  }

  /**
   * 打开"从库里选一个文件"的弹窗 —— **选文件这件事的唯一实现**。
   *
   * 图片选择器与定义文件导入都走这里，于是三条退化路径（库里没有候选、弹窗构造失败、
   * 用户取消）的文案与行为只写了一遍。候选清单由调用方给（它才知道该列什么），
   * 本方法只负责"没得选时说清原因、打不开时给退路、取消时什么都不做"。
   *
   * ⚠️ `kind` 必须由调用方给出并原样传下去：弹窗会按它做二次筛选，
   * 而图片与定义文件的扩展名白名单不同 —— 传错（或漏传成缺省的 `image`）
   * 会让清单被筛空，选择器看起来"不工作"（见 `AssetSuggestModal` 里那段教训）。
   */
  private openAssetPicker(options: {
    title?: string
    files: string[]
    kind: AssetPickerKind
    emptyHint: string
    onChoose: (path: string) => void
  }): void {
    if (options.files.length === 0) {
      new Notice(options.emptyHint, NOTICE_MAX_MS)
      return
    }
    const pickerOptions: AssetPickerOptions = {
      files: options.files,
      kind: options.kind,
      ...(options.title !== undefined ? { title: options.title } : {}),
      onChoose: options.onChoose,
    }
    try {
      this.imagePickerFactory(this.app, pickerOptions).open()
    } catch (error) {
      console.error('[project-kaki] 打开文件选择器失败', error)
      new Notice(
        `打开文件选择器失败：${error instanceof Error ? error.message : String(error)}`,
        NOTICE_MAX_MS,
      )
    }
  }

  // ------------------------------------------------- 定义文件（导入 / 导出）

  /**
   * 导出定义文件：把设置里的自定义地形 / 标记 / 路径类型 / 区域类型打包成一份 JSON 写进库里。
   *
   * 三条刻意的选择：
   * 1. **写到库根目录**：这是插件级资源（与某一张地图无关），而且这两个动作用不着先打开地图 ——
   *    放到"地图文件旁边"就会变成"没开地图就没法导出"。文件名与最终路径都进提示，
   *    用户不必去猜它落在哪。
   * 2. **重名绝不覆盖**：与 SVG/PNG/报告共用 `uniqueExportPath`（`-2`、`-3`……），
   *    覆盖等于悄悄丢掉上一份备份。
   * 3. **没有可导出的东西时干脆不写文件**：写出一份空文件只会让用户以为"导出成功了"，
   *    然后拿着一个什么都没有的文件去导入。
   */
  async exportResourceBundle(): Promise<void> {
    /*
     * W4-3：资源包是**搬运工具** —— 导的是**当前地图的定义集**（不是库级模板）。
     *
     * 为什么这么改：定义随图（W4-1）之后，"我调好的线宽 / 填充"是**每张地图各自一份**，
     * 而用户想搬的正是它。没有打开地图时就导模板那一份 —— 并在提示里**说清楚**，
     * 否则用户会以为导的是"刚才那张图"（与"地图定义"弹窗里那句话同一条纪律：别让人猜）。
     */
    const target = this.definitionTarget()
    const definitions = target === null ? this.libraryDefinitionSet() : this.activeDefinitions()
    if (isFactoryDefinitionSet(definitions)) {
      new Notice(
        target === null
          ? '「新建地图的模板」里全是出厂定义（没有自定义地形 / 标记，路径与区域类型的参数也没改过），没有可导出的东西。'
          : `这张地图（${target.mapPath}）里全是出厂定义，没有可导出的东西。`,
        NOTICE_MAX_MS,
      )
      return
    }
    const bundle = buildResourceBundle(
      {
        terrains: definitions.terrains,
        markers: definitions.markers,
        pathTypes: definitions.pathTypes,
        regionTypes: definitions.regionTypes,
      },
      { generator: `project-kaki ${this.manifest.version}` },
    )
    const counts = `地形 ${bundle.terrains.length} · 标记 ${bundle.markers.length} · 路径类型 ${bundle.pathTypes.length}（含内置）· 区域类型 ${bundle.regionTypes.length}（含内置）`
    const scope =
      target === null
        ? '\n（当前没有打开地图：导出的是「新建地图的模板」那一份）'
        : `\n（来自当前地图：${target.mapPath}）`

    const basePath = bundleFileName().replace(/\.json$/i, '')
    const path = uniqueExportPath(
      basePath,
      '.json',
      (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
    )
    try {
      const created = await this.app.vault.create(path, serializeResourceBundle(bundle))
      new Notice(`已导出定义文件：${created.path}\n（${counts}）${scope}`, NOTICE_MAX_MS)
    } catch (error) {
      console.error('[project-kaki] 导出定义文件失败', error)
      new Notice(`导出定义文件失败：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
    }
  }

  /**
   * 导入定义文件的入口：先选文件（只列 `.json`），再走"解析 → 计划 → 确认对话框"。
   *
   * 选择器复用图片那套（`AssetSuggestModal` + 可注入工厂）：**选文件这件事只有一份实现**，
   * 于是"库里一个候选都没有"这类退化路径的文案与行为也是同一份。
   */
  importResourceBundle(): void {
    const files = this.app.vault.getFiles()
    const candidates = listBundlePaths(files.map((file) => file.path))
    this.openAssetPicker({
      title: DIALOG_LABELS.importDefinitions,
      files: candidates,
      kind: 'bundle',
      emptyHint: emptyBundleListHint(),
      onChoose: (path) => {
        void this.applyBundleFromPath(path)
      },
    })
  }

  /** 读一份定义文件并打开确认对话框（**这一步不改任何设置**） */
  private async applyBundleFromPath(path: string): Promise<void> {
    const file = this.app.vault.getFiles().find((candidate) => candidate.path === path)
    if (!file) {
      new Notice(`找不到文件：${path}`, NOTICE_MAX_MS)
      return
    }
    let text = ''
    try {
      text = await this.app.vault.read(file)
    } catch (error) {
      console.error('[project-kaki] 读取定义文件失败', error)
      new Notice(`读取失败：${error instanceof Error ? error.message : String(error)}`, NOTICE_MAX_MS)
      return
    }

    const parsed = parseResourceBundle(text)
    if (!parsed.ok) {
      // 单行、可读、说明"为什么"：不能只说"导入失败"（用户无从下手）
      new Notice(`无法导入：${parsed.reason}`, NOTICE_MAX_MS)
      return
    }

    /*
     * W4-3：导入的**目标**在这里定下来（就是"当前地图"），而且**一路带到提交**：
     * 对话框会把它写给用户看（"导入到：X"），提交时 `mutateDefinitions` 收的就是这一次解析出的目标。
     * 计划也按**这张图**现有的定义算 —— 于是"同名冲突"算的是这张图的事，不是库级模板的事。
     */
    const target = this.definitionTarget()
    const current = target === null ? this.libraryDefinitionSet() : this.definitionsOf(this.currentDocumentFor(target))
    const planCurrent = {
      terrains: current.terrains,
      markers: current.markers,
      pathTypes: current.pathTypes,
      regionTypes: current.regionTypes,
    }
    const planFor = (overwrite: readonly string[]) =>
      planBundleImport(planCurrent, parsed.bundle, { notes: parsed.notes, overwrite })
    const plan = planFor([])
    try {
      this.importModalFactory(this.app, {
        source: path,
        target:
          target === null
            ? '「新建地图的模板」（当前没有打开地图）'
            : target.mapPath,
        planText: describeImportPlan(plan),
        // 没有可新增 / 可覆盖的条目时按钮是灰的：正文已经解释了"为什么一条都进不来"
        //（同 ID 冲突、全部不合法……），点不动比点了报错好
        canImport: plan.addedCount > 0 || plan.replacedCount > 0,
        conflicts: plan.conflicts,
        // 勾选变了就**重算**：正文、按钮状态、最终落盘三处永远来自同一份计划
        replan: (overwrite) => {
          const next = planFor(overwrite)
          return { planText: describeImportPlan(next), canImport: next.addedCount > 0 || next.replacedCount > 0 }
        },
        onConfirm: (overwrite) => this.commitBundleImport(planFor(overwrite), target),
      }).open()
    } catch (error) {
      console.error('[project-kaki] 打开导入对话框失败', error)
      new Notice('无法打开导入确认对话框，本次没有改动任何设置。', NOTICE_MAX_MS)
    }
  }

  /** 某个目标当前那份定义文档（计划要用它算冲突；读不到就退回库级模板） */
  private currentDocumentFor(target: DefinitionTarget): MapDocument | null {
    if (target.editor !== null) return this.layers?.getDocument(target.canvasPath) ?? null
    return this.definitionDocCache.get(target.mapPath) ?? null
  }

  /**
   * 真正写入。
   *
   * W4-3 起走的是**定义写入口**（`mutateDefinitions`）：有地图层就落在那张图的 `definitions` 段
   * （可撤销），没有就直接读改写盘；没有地图时写进"新建地图的模板"（与 W4-1b 同一条路）。
   *
   * 写的是**计划算出来的那一份最终目录**（`plan.result`）—— 计划本身已经是"现有 + 新增 + 覆盖"
   * 的完整结果，所以这里不再自己拼一遍（"对话框说的"与"实际做的"必须逐字一致）。
   */
  private async commitBundleImport(
    plan: BundleImportPlan,
    target: DefinitionTarget | null,
  ): Promise<ImportBundleOutcome> {
    const written = await this.mutateDefinitions(
      (set) => ({
        ...set,
        terrains: plan.result.terrains,
        markers: plan.result.markers,
        pathTypes: plan.result.pathTypes,
        regionTypes: plan.result.regionTypes,
      }),
      DIALOG_LABELS.importDefinitions,
      target,
    )
    if (!written.ok) return { ok: false, reason: written.problem }
    new Notice(describeImportResult(plan), NOTICE_MAX_MS)
    return { ok: true }
  }

  /**
   * 刷新已经打开的设置页。
   *
   * 尽力而为：`display()` 在设置页没打开时也不该出错（它只是重建容器内容），
   * 但真实环境里容器状态我们无法假设，所以包一层 try/catch —— 失败也不该让导入本身失败
   *（关掉设置页再打开就能看到新定义，数据已经写进去了）。
   */
  private refreshSettingsTab(): void {
    const tab = this.settingTab
    if (!tab) return
    try {
      tab.display()
    } catch (error) {
      console.warn('[project-kaki] 刷新设置页失败（关闭设置页再打开即可看到新定义）', error)
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

  /**
   * 替换导入对话框工厂（自动化测试用；传 `null` 恢复真实对话框）。
   *
   * 与导出对话框同一套路：测试要断言的是"这份文件导入之后设置变成了什么、跳过的是哪几条"，
   * 而**不是**对话框里的像素，所以换掉工厂、直接驱动它拿到的计划正文即可。
   */
  setImportModalFactory(factory: ImportBundleModalFactory | null): void {
    this.importModalFactory = factory ?? ((app, options) => new ImportBundleModal(app, options))
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
        `${NOTICES.layerEnabled}：${canvasPath}`,
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
      const file = await store.createMap({
        name,
        folder: DEFAULT_MAP_FOLDER,
        canvasPath,
        // 定义随图（方案 B）：新建的图把"当时库级设置那一份定义"写进自己的文件。
        // 老图不在此列 —— 它们读到的是内存快照，只有用户真的改了定义才回写升版（见 §5.1）。
        definitions: this.libraryDefinitionsBlock(),
      })
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
    // 目录**按被报告的那份文档**解析：报的是"这张图里的地形叫什么"
    const custom = this.definitionsOf(loaded.document).terrains
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
      title: COMMAND_NAMES.statusReport,
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
    // 状态报告说的是"当前这张图" ⇒ 图层开关也按活动画布那张地图解析（W4-2）
    const visibility = this.layersFor(this.activeViewMapPath())
    const hidden = hiddenLayerLabels(visibility)
    if (allLayersHidden(visibility)) {
      return `${STATUS_SECTIONS.layerPrefix}全部隐藏（地图上看不到任何东西，这是设置导致的，数据仍在）`
    }
    return hidden.length === 0 ? STATUS_SECTIONS.layersAllVisible : `${STATUS_SECTIONS.layerPrefix}已隐藏 ${hidden.join(' / ')}`
  }

  /** 图例条目（从地图实际内容生成；受图层开关约束） */
  private describeLegend(canvasPath: string): string[] {
    const entries = this.layers?.buildLegendFor(canvasPath) ?? []
    if (entries.length === 0) return [`${STATUS_SECTIONS.legendPrefix}（地图还是空的，或相关图层被隐藏）`]
    return [STATUS_SECTIONS.legendPrefix, ...legendLines(entries).map((line) => `  ${line}`)]
  }

  // ------------------------------------------------------------ 运行时探针
  /**
   * 诊断当前 Canvas（运行时诊断）。
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

    const report = buildDiagnosticReport(this.app, await this.diagnosticRuntime())
    console.log(report)
    this.openReport({
      title: '运行时诊断',
      text: report,
      // 沿用原来的固定文件名：老用户会去库里找这个名字
      fileName: DIAGNOSTIC_FALLBACK_PATH,
    })
  }

  /**
   * 组装报告需要的“当下运行时状态”。
   *
   * `buildDiagnosticReport` 只认识 `app`，而地图文档 / 版本 / definitions / 图层解析来源 /
   * 当前选中都住在插件这一层 —— 所以在这里查一次、拍成一份**纯标量 + 文档对象**的快照。
   * 文档对象只用来算规模与 placement，报告本身绝不序列化它。
   */
  private async diagnosticRuntime(): Promise<DiagnosticRuntime> {
    const mapPath = this.activeViewMapPath()
    const views = mapPath !== null ? this.pluginSettings.mapViews[mapPath] : undefined
    let document_ = this.layers?.getActiveDocument() ?? null
    let mapVersion: number | null = null
    let mapReadOnly = false
    let definitionsInFile: boolean | null = null

    if (mapPath !== null && this.store) {
      const abstract = this.app.vault.getAbstractFileByPath(mapPath)
      if (abstract instanceof TFile) {
        const loaded = await this.store.load(abstract)
        if (loaded.document !== null) {
          mapVersion = loaded.document.version
          mapReadOnly = loaded.readOnly
          definitionsInFile = loaded.document.definitions !== undefined
          if (document_ === null) document_ = loaded.document
        }
      }
    }

    return {
      mapPath,
      mapVersion,
      mapReadOnly,
      definitionsInFile,
      layers: this.layersFor(mapPath),
      layersSource: mapPath === null ? 'none' : views?.layers !== undefined ? 'map' : 'library',
      overlaysSource: mapPath === null ? 'none' : views?.overlays !== undefined ? 'map' : 'library',
      showLegendSource: mapPath === null ? 'none' : views?.showLegend !== undefined ? 'map' : 'library',
      showLegend: this.showLegendFor(mapPath),
      selection: this.describeSelectionLine(),
      document: document_,
      customMarkers: this.definitionsOf(document_).markers,
    }
  }

  /** 当前选中（一行标量；没有选中时 null） */
  private describeSelectionLine(): string | null {
    const status = this.layers?.getInspectorEditor()?.getStatus() ?? null
    if (status === null || status.selection === null) return null
    const primary = `${status.selection.kind} \`${status.selection.id}\``
    return status.objectSelection.length > 1 ? `${primary}（共 ${status.objectSelection.length} 项）` : primary
  }

  private toggleViewportWatch(): void {
    const current = getWatchStatus()

    if (current.active) {
      const finalStatus = stopViewportWatch()
      if (finalStatus.samples.length > 0) console.log('[project-kaki] 投影采样：', finalStatus.samples.join(' | '))
      const lastSample = finalStatus.samples.at(-1) ?? ''
      new Notice(
        `已停止监视：\n有效投影变化 ${finalStatus.changedCount} 次，来源切换 ${finalStatus.switchedCount} 次。\n` +
          (lastSample.length > 0 ? `最近一次：${lastSample}\n` : '') +
          (finalStatus.changedCount > 0
            ? '判定：每帧投影都能重判，来源切换可查 ✅'
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
    new Notice(`开始在 ${status.canvasPath} 上监视投影。\n现在去平移/缩放画布，然后再次运行本命令查看 scale / origin / source。`, NOTICE_MAX_MS)
  }
}
