/**
 * 地图工具条。
 *
 * 挂在 `wrapperEl` 里（它的 transform 是 none，因此**不随画布缩放**），
 * 这样按钮尺寸恒定、位置固定。
 *
 * 只做最少的事：模式指示、地形选择（带色块与中文名）、笔刷大小、撤销/重做。
 * 所有状态都从编辑器读，`refresh()` 后被动画到最新。
 */

import { setIcon } from 'obsidian'
import type { MarkerIcon, MarkerId, PathType } from '../data/mapDocument.ts'
import type { BrushOp, EditorStatus, EditorTool, MapEditor } from '../editor/MapEditor.ts'
import type { GeometryMode } from '../core/hexEdges.ts'
import { listResolvedTerrainStyles, terrainCatalogSignature, type CustomTerrain } from '../render/terrainCatalog.ts'
import { listResolvedMarkerStyles, markerCatalogSignature, type CustomMarker } from '../render/markerCatalog.ts'
import {
  defaultPathTypeEntries,
  describePathTypeParams,
  listPathTypeEntries,
  pathTypeCatalogSignature,
  resolvePathType,
  type PathTypeEntry,
} from '../render/pathTypeCatalog.ts'
import {
  customRegionTypeEntries,
  defaultRegionTypeEntries,
  describeRegionTypeParams,
  regionTypeCatalogSignature,
  resolveRegionType,
  type RegionTypeEntry,
} from '../render/regionTypeCatalog.ts'
import { ToolbarDropdown, type ToolbarDropdownItem } from './ToolbarDropdown.ts'
import { OVERLAY_FIELDS, type FieldId } from '../render/overlayFields.ts'
import { biomeCatalogSignature, listResolvedBiomeStyles, resolveBiomeStyle, type CustomBiome } from '../render/biomeCatalog.ts'
import { ICON_LABELS } from './PlaceMarkerModal.ts'

export interface MapToolbarOptions {
  editor: MapEditor
  /** 进入/退出绘制模式时同步指针策略 */
  onModeChanged: (mode: 'select' | 'paint') => void
  onUndo: () => void
  onRedo: () => void
  /**
   * 当前样式调色板（来自插件设置）。
   *
   * ⚠️ 工具条**不再**从这里取区域颜色：区域颜色自 ⑤-2 起是区域类型目录里的一项
   * （见 `getRegionTypes`）。保留这个选项只为不破坏既有调用方；工具条不读它。
   */
  getPalette?: () => { regionColors: string[] }
  /**
   * 路径类型目录（来自插件设置）—— 工具条下拉的**唯一**内容来源：内置 4 种 + 用户自定义。
   *
   * 与自定义地形/标记同理：选项数量会随设置变化，所以目录签名变了要重建下拉。
   */
  getPathTypes?: () => readonly PathTypeEntry[]
  /**
   * 区域类型目录（来自插件设置）—— 区域下拉的**唯一**内容来源：内置 6 种 + 用户自定义。
   *
   * 与路径下拉逐字同理：选项数量会随设置变化，所以目录签名变了要重建下拉。
   */
  getRegionTypes?: () => readonly RegionTypeEntry[]
  /**
   * 用户自定义地形（来自插件设置）。
   *
   * 与颜色不同，**按钮数量**会随设置变化，所以这里不能只"原地改样式"：
   * 目录签名变了就得重建地形按钮那一组（见 `refresh()`）。重建的代价是一次 DOM 操作，
   * 而它在用户改设置时才会发生，不会进入每帧路径。
   */
  getCustomTerrains?: () => readonly CustomTerrain[]
  /**
   * 用户自定义标记图标（来自插件设置）。
   *
   * 与自定义地形逐字同理：按钮数量会随设置变化，所以目录签名变了要重建那一组。
   */
  getCustomMarkers?: () => readonly CustomMarker[]
  /**
   * 库内图片路径 → `<img src>` 地址（图片模式的自定义标记，按钮上直接显示用户那张图）。
   *
   * 缺省时不显示图片、退回借来的字形 —— 与绘制层同一套回退，绝不显示破图。
   */
  resolveImageSrc?: (path: string) => string
  /**
   * 切换"名称"图层（路径与区域的名称标注）。
   *
   * 为什么**必需**而不是可选：图层开关是持久化设置，工具条按钮只是它的一个入口。
   * 做成可选就会留下"某个调用方没接这个回调 → 按钮点了没反应"的可能，
   * 而这正是本项目最怕的一类缺陷（改了没反应）。必需即编译期保证按钮能写进设置。
   */
  onToggleLabels: () => void
  /** 名称图层当前是否显示（按钮高亮读它 —— 唯一真相是设置，不是工具条自己的状态） */
  getShowShapeLabels: () => boolean
  /** 图例当前是否显示（来自插件设置） */
  getShowLegend: () => boolean
  /** 切换图例显示（写设置） */
  onToggleLegend: () => void
  /**
   * 打开「按规则筛选选择…」对话框。
   *
   * 缺省时**不渲染**这个按钮（而不是渲染一个点了没反应的按钮）：工具条本身是可选组件，
   * 只有插件层接上了这个回调才有意义。
   */
  onOpenSelectionFilter?: () => void
  /**
   * 自定义生物群系目录（笔刷那一节的"设为哪个群系"下拉用）。
   *
   * 与 `getCustomTerrains` 同理：选项数量会随设置变化，所以签名变了要重建那一组。
   */
  getCustomBiomes?: () => readonly CustomBiome[]
}

/** 数据层笔刷那一节的"层"选项：地形 + 每个数据层字段（**从字段表派生**，加字段自动多一项） */
const BRUSH_FIELD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '地形' },
  ...OVERLAY_FIELDS.map((spec) => ({ value: spec.id, label: spec.label })),
]

/** 数值字段的算法按钮（顺序就是界面上的顺序） */
const BRUSH_OPS: ReadonlyArray<{ value: BrushOp; label: string; hint: string }> = [
  { value: 'set', label: '＝', hint: '这一笔把这些格直接设成这个数（分类字段只有这一种）' },
  { value: '+', label: '＋', hint: '在原来的数上加：**没有值的格从「每格默认值」起算**（没有就 0）——会把默认值固化进这些格' },
  { value: '-', label: '−', hint: '在原来的数上减：**没有值的格从「每格默认值」起算**（没有就 0）——会把默认值固化进这些格' },
  { value: '×', label: '×', hint: '乘一个系数：**没有值的格跳过**（拿"没量过"去乘没有意义）' },
  { value: '÷', label: '÷', hint: '除以一个系数：**没有值的格跳过**；除以 0 不生效' },
]

const TOOL_LABELS: Record<EditorTool, { label: string; hint: string }> = {
  brush: { label: '地形', hint: '地形笔刷（B）' },
  marker: { label: '标记', hint: '放置标记（M）' },
  label: { label: '文字', hint: '添加文字标注（T）' },
  path: { label: '路径', hint: '绘制河流/道路（P）：逐点点击，双击或回车结束' },
  region: { label: '区域', hint: '绘制国家/领地（R）：逐点点击，双击或回车结束' },
}

/** 路径/区域的几何模式（仅这两个工具下显示） */
const GEOMETRY_OPTIONS: ReadonlyArray<{ mode: GeometryMode; label: string; hint: string }> = [
  {
    mode: 'edge',
    label: '沿格边',
    hint: '勾勒六边形边框：落点吸附到网格顶点，顶点之间自动沿格边走（画面更整齐；线条会比直线略长）',
  },
  {
    mode: 'edge-step',
    label: '逐边',
    hint: '一次只画一条边：点哪个方向就沿格边往哪前进一条边（逐条描边，拐弯就往那个方向点）',
  },
  {
    mode: 'interior',
    label: '穿内部',
    hint: '直接通过六边形内部：自由折线（河流仍是平滑曲线），可以斜穿格子',
  },
]

export class MapToolbar {
  private readonly options: MapToolbarOptions
  private readonly root: HTMLElement
  private readonly modeButton: HTMLButtonElement
  /**
   * 这里**刻意没有**「地图层」按钮。
   *
   * 它原来文案是"地图层"、提示是"停用当前地图层"，点了会把整个地图层关掉
   * （地形消失、连工具条自己一起收起来）—— 用户的反馈是"不知道是干什么的"，
   * 而且它与侧栏面板里的「启用/停用当前 Canvas 的地图层」是**重复功能**。
   * 现在只保留面板里那一个入口；画布上的工具条不再有能把自己弄没的按钮。
   */
  private readonly toolButtons = new Map<EditorTool, HTMLButtonElement>()
  /** 地形按钮按**地形 ID**索引（内置 + 自定义共用一套） */
  private readonly terrainButtons = new Map<string, HTMLButtonElement>()
  /** 上一次构建地形按钮时的目录签名：变了才重建 DOM */
  private terrainSignature = ''
  /** 上一次构建图标按钮时的目录签名：变了才重建 DOM */
  private markerSignature = ''
  private readonly iconButtons = new Map<MarkerId, HTMLButtonElement>()
  /**
   * 路径类型下拉与区域类型下拉。
   *
   * 两者共用 `ToolbarDropdown`（同一个实现）：以前路径是"每种类型一个按钮"、
   * 区域是"每 个预设一个色块按钮"，类型一多就换行并把别的控件挤走。
   * 现在各只有一个按钮（当前类型的色块 + 名字），点开是选项列表。
   * 选项按 `dataset.pathType` / `dataset.regionType` 索引，**未知类型不给选项**
   * （下拉只列"当前设置里存在的选择"），但地图里已有的未知类型仍然正常绘制，数据也不会丢。
   */
  private readonly pathDropdown: ToolbarDropdown
  private readonly regionDropdown: ToolbarDropdown
  /** 上一次构建两个下拉时的目录签名：变了才重建 DOM */
  private pathSignature = ''
  private regionSignature = ''
  private readonly geometryButtons = new Map<GeometryMode, HTMLButtonElement>()
  private readonly terrainGroup: HTMLElement
  private readonly iconGroup: HTMLElement
  private readonly geometryGroup: HTMLElement
  private readonly brushGroup: HTMLElement
  private readonly brushLabel: HTMLElement
  private readonly undoButton: HTMLButtonElement
  private readonly redoButton: HTMLButtonElement
  private readonly nameButton: HTMLButtonElement
  private readonly legendButton: HTMLButtonElement
  /**
   * 选择模式那一组：矩形框选 / 笔迹框选 / 筛选… / 连通扩展。
   *
   * 只在**选择模式**下显示（绘制模式下左键归绘制手势）。框选/笔迹两个按钮切换
   * `editor.selectionMode` —— 两者都是"左键拖动"，只能靠一个可选状态区分（§C.1）。
   * 「筛选…」按钮只在插件层接上了回调时才创建（缺省 = 不渲染，而不是点了没反应）。
   */
  private readonly selectGroup: HTMLElement
  private readonly rectButton: HTMLButtonElement
  private readonly brushSelectButton: HTMLButtonElement
  private filterButton: HTMLButtonElement | null = null
  private expandButton: HTMLButtonElement | null = null
  /**
   * 状态条（施工文件 §F.3）：`空闲` / `编辑：地形笔刷 · 森林` / `选择：矩形框选 · 12 格`。
   *
   * 工具浮窗**降级成状态显示**之后，这一行是用户判断"我现在处在什么状态"的唯一入口 ——
   * 只读的详情（选中了哪些字段、统计）全在右上角的信息卡里，不在这里重复。
   */
  private readonly statusEl: HTMLElement
  private readonly hintEl: HTMLElement
  /**
   * 数据层笔刷那一组（施工文件 §E）：层（地形 / 温度 / 深度 / 生物群系）+ 算法 + 数值 / 群系。
   *
   * 三条硬口径都长在这里：**数值框初始为空**（不预填）、**没确认时笔刷不生效**（状态条说原因）、
   * 换层或换算法时**不静默沿用**（数字保留但标成"未确认"，回车才算数）。
   */
  private readonly brushFieldGroup: HTMLElement
  private readonly brushFieldSelect: HTMLSelectElement
  private readonly brushOpButtons = new Map<BrushOp, HTMLButtonElement>()
  private readonly brushOpGroup: HTMLElement
  private readonly brushValueInput: HTMLInputElement
  private readonly brushBiomeSelect: HTMLSelectElement
  /**
   * 上一次重建"群系下拉"时的目录签名：变了才重建选项。
   *
   * ⚠️ 初值是 `null`（而不是 `''`）：一个自定义群系都没有时签名正是空串 ——
   * 用 `''` 当初值会让**第一次**刷新判定为"没变"，于是下拉里一个选项都没有
   * （内置 34 条全在 `listResolvedBiomeStyles` 里，本该列出来的）。
   */
  private biomeSignature: string | null = null

  constructor(container: HTMLElement, options: MapToolbarOptions) {
    this.options = options
    const doc = container.ownerDocument ?? globalThis.document

    this.root = doc.createElement('div')
    this.root.className = 'fc-toolbar'

    // 模式按钮
    this.modeButton = doc.createElement('button')
    this.modeButton.className = 'fc-toolbar-button fc-toolbar-mode'
    this.modeButton.addEventListener('click', () => {
      const mode = options.editor.toggleMode()
      options.onModeChanged(mode)
      this.refresh()
    })
    this.root.appendChild(this.modeButton)

    // 工具切换
    const toolGroup = doc.createElement('div')
    toolGroup.className = 'fc-toolbar-group'
    for (const tool of ['brush', 'marker', 'label', 'path', 'region'] as EditorTool[]) {
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-tool'
      button.textContent = TOOL_LABELS[tool].label
      button.title = TOOL_LABELS[tool].hint
      button.addEventListener('click', () => {
        options.editor.setTool(tool)
        this.refresh()
      })
      this.toolButtons.set(tool, button)
      toolGroup.appendChild(button)
    }
    this.root.appendChild(toolGroup)

    // 选择模式那一组（施工文件 §C.3 第 2、3、9 条）：矩形框选 / 笔迹框选 / 筛选… / 连通扩展。
    // 只在选择模式下显示 —— 绘制模式下左键归绘制手势，摆着这些按钮只会误导。
    this.selectGroup = doc.createElement('div')
    this.selectGroup.className = 'fc-toolbar-group fc-toolbar-select-group'

    this.rectButton = doc.createElement('button')
    this.rectButton.className = 'fc-toolbar-button fc-toolbar-select-rect'
    this.rectButton.textContent = '矩形框选'
    this.rectButton.title = '按住左键拉出一个矩形：选中框里的格（Shift 加选、Alt 取消）'
    this.rectButton.addEventListener('click', () => {
      options.editor.setSelectionMode('rect')
      this.refresh()
    })
    this.selectGroup.appendChild(this.rectButton)

    this.brushSelectButton = doc.createElement('button')
    this.brushSelectButton.className = 'fc-toolbar-button fc-toolbar-select-brush'
    this.brushSelectButton.textContent = '笔迹框选'
    this.brushSelectButton.title = '按住左键划过去：笔迹扫过的格被选中（范围跟"笔刷大小"同一个半径）'
    this.brushSelectButton.addEventListener('click', () => {
      options.editor.setSelectionMode('brush')
      this.refresh()
    })
    this.selectGroup.appendChild(this.brushSelectButton)

    if (options.onOpenSelectionFilter) {
      this.filterButton = doc.createElement('button')
      this.filterButton.className = 'fc-toolbar-button fc-toolbar-select-filter'
      this.filterButton.textContent = '筛选…'
      this.filterButton.title = '按规则筛选选择（地形 / 温度 / 深度…，子句可叠加）'
      this.filterButton.addEventListener('click', () => options.onOpenSelectionFilter?.())
      this.selectGroup.appendChild(this.filterButton)

      this.expandButton = doc.createElement('button')
      this.expandButton.className = 'fc-toolbar-button fc-toolbar-select-expand'
      this.expandButton.textContent = '连通扩展'
      this.expandButton.title = '以当前选择为种子，按同一种地形扩到整片连通区'
      this.expandButton.addEventListener('click', () => {
        options.editor.expandSelectionByTerrain()
        this.refresh()
      })
      this.selectGroup.appendChild(this.expandButton)
    }

    this.root.appendChild(this.selectGroup)

    // 地形选择（仅笔刷工具下显示）：内置 9 种 + 用户自定义（排在后面）
    this.terrainGroup = doc.createElement('div')
    this.terrainGroup.className = 'fc-toolbar-group fc-toolbar-terrain-group'
    this.rebuildTerrainButtons()
    this.root.appendChild(this.terrainGroup)

    // 标记图标选择（仅标记工具下显示）：内置 9 种 + 用户自定义（排在后面）
    this.iconGroup = doc.createElement('div')
    this.iconGroup.className = 'fc-toolbar-group fc-toolbar-icon-group'
    this.rebuildMarkerButtons()
    this.root.appendChild(this.iconGroup)

    // 路径类型（仅路径工具下显示）：**收进一个下拉**（用户决定）。
    // 类型数量会随自定义类型增长（上限 32 + 内置 4），一排按钮会换行并挤掉其它控件。
    this.pathDropdown = new ToolbarDropdown(this.root, {
      skin: {
        groupClass: 'fc-toolbar-group fc-toolbar-path-group',
        triggerClass: 'fc-toolbar-button fc-toolbar-path-trigger',
        triggerKey: 'fcPathTrigger',
        swatchKey: 'fcPathSwatch',
        labelClass: 'fc-toolbar-path-label',
        caretClass: 'fc-toolbar-path-caret',
        menuClass: 'fc-toolbar-path-menu',
        menuKey: 'fcPathMenu',
        optionClass: 'fc-toolbar-button fc-toolbar-path-option',
        optionKey: 'pathType',
      },
      onSelect: (id) => {
        options.editor.setPathType(id)
        this.refresh()
      },
    })

    // 几何模式（路径 / 区域工具下显示）：勾勒六边形边框 vs 直接穿过格子内部
    this.geometryGroup = doc.createElement('div')
    this.geometryGroup.className = 'fc-toolbar-group fc-toolbar-geometry-group'
    for (const option of GEOMETRY_OPTIONS) {
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-geometry'
      button.textContent = option.label
      button.title = option.hint
      button.addEventListener('click', () => {
        options.editor.setGeometryMode(option.mode)
        this.refresh()
      })
      this.geometryButtons.set(option.mode, button)
      this.geometryGroup.appendChild(button)
    }
    this.root.appendChild(this.geometryGroup)

    // 区域类型（仅区域工具下显示）：与路径类型**同一个下拉实现**。
    // 以前是"每个预设一个色块按钮"，改成下拉之后自定义区域类型才排得下（上限 32 + 内置 6）。
    this.regionDropdown = new ToolbarDropdown(this.root, {
      skin: {
        groupClass: 'fc-toolbar-group fc-toolbar-region-group',
        triggerClass: 'fc-toolbar-button fc-toolbar-region-trigger',
        triggerKey: 'fcRegionTrigger',
        swatchKey: 'fcRegionSwatch',
        labelClass: 'fc-toolbar-region-label',
        caretClass: 'fc-toolbar-region-caret',
        menuClass: 'fc-toolbar-region-menu',
        menuKey: 'fcRegionMenu',
        optionClass: 'fc-toolbar-button fc-toolbar-region-option',
        optionKey: 'regionType',
      },
      onSelect: (id) => {
        options.editor.setRegionType(id)
        this.refresh()
      },
    })

    // 笔刷大小（仅笔刷工具下显示）
    this.brushGroup = doc.createElement('div')
    this.brushGroup.className = 'fc-toolbar-group fc-toolbar-brush-group'
    const smaller = doc.createElement('button')
    smaller.className = 'fc-toolbar-button'
    smaller.textContent = '−'
    smaller.title = '减小笔刷（[）'
    smaller.addEventListener('click', () => {
      options.editor.adjustBrushRadius(-1)
      this.refresh()
    })
    this.brushLabel = doc.createElement('span')
    this.brushLabel.className = 'fc-toolbar-brush'
    const larger = doc.createElement('button')
    larger.className = 'fc-toolbar-button'
    larger.textContent = '+'
    larger.title = '增大笔刷（]）'
    larger.addEventListener('click', () => {
      options.editor.adjustBrushRadius(1)
      this.refresh()
    })
    this.brushGroup.append(smaller, this.brushLabel, larger)
    this.root.appendChild(this.brushGroup)

    // 数据层笔刷（§E）：层 + 算法 + 数值 / 群系。
    // 与"笔刷大小"同一组条件（绘制模式 + 笔刷工具），因为半径对两者都生效。
    this.brushFieldGroup = doc.createElement('div')
    this.brushFieldGroup.className = 'fc-toolbar-group fc-toolbar-brushfield-group'

    const fieldLabel = doc.createElement('span')
    fieldLabel.className = 'fc-toolbar-mini-label'
    fieldLabel.textContent = '刷'
    this.brushFieldSelect = doc.createElement('select')
    this.brushFieldSelect.className = 'fc-toolbar-brushfield-select'
    this.brushFieldSelect.dataset.fcBrushField = '1'
    for (const option of BRUSH_FIELD_OPTIONS) {
      const item = doc.createElement('option')
      item.value = option.value
      item.textContent = option.label
      this.brushFieldSelect.appendChild(item)
    }
    this.brushFieldSelect.addEventListener('change', () => {
      const value = this.brushFieldSelect.value
      options.editor.setBrushField(value === '' ? null : (value as FieldId))
      this.refresh()
    })
    this.brushFieldGroup.append(fieldLabel, this.brushFieldSelect)

    this.brushOpGroup = doc.createElement('div')
    this.brushOpGroup.className = 'fc-toolbar-brushop-group'
    for (const op of BRUSH_OPS) {
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-brushop'
      button.textContent = op.label
      button.title = op.hint
      button.dataset.fcBrushOp = op.value
      button.addEventListener('click', () => {
        options.editor.setBrushOp(op.value)
        this.refresh()
      })
      this.brushOpButtons.set(op.value, button)
      this.brushOpGroup.appendChild(button)
    }
    this.brushFieldGroup.appendChild(this.brushOpGroup)

    this.brushValueInput = doc.createElement('input')
    this.brushValueInput.type = 'number'
    this.brushValueInput.className = 'fc-toolbar-brushvalue'
    this.brushValueInput.dataset.fcBrushValue = '1'
    this.brushValueInput.placeholder = '数值'
    this.brushValueInput.title = '填一个数并按回车（或点开别处）确认 —— 没确认时笔刷不生效'
    // 只认 `change`（回车 / 失焦）：`input` 每次击键都提交就等于"边打边刷"，
    // 与 §E 的"回车 = 确认"相反。键入时**把笔刷打回未确认**（值不同就清掉）——
    // 否则笔上还带着上一次的旧值，而输入框里显示的是新数字。
    this.brushValueInput.addEventListener('input', () => {
      const text = this.brushValueInput.value.trim()
      const parsed = text.length === 0 ? null : Number(text)
      const value = parsed !== null && Number.isFinite(parsed) ? parsed : null
      if (value !== options.editor.getStatus().brushValue) options.editor.setBrushValue(null)
    })
    const commitValue = (): void => {
      const text = this.brushValueInput.value.trim()
      const parsed = text.length === 0 ? null : Number(text)
      options.editor.setBrushValue(parsed !== null && Number.isFinite(parsed) ? parsed : null)
      this.refresh()
    }
    this.brushValueInput.addEventListener('change', commitValue)
    this.brushValueInput.addEventListener('blur', commitValue)
    this.brushFieldGroup.appendChild(this.brushValueInput)

    this.brushBiomeSelect = doc.createElement('select')
    this.brushBiomeSelect.className = 'fc-toolbar-brushbiome-select'
    this.brushBiomeSelect.dataset.fcBrushBiome = '1'
    this.brushBiomeSelect.addEventListener('change', () => {
      options.editor.setBrushBiome(this.brushBiomeSelect.value)
      this.refresh()
    })
    this.brushFieldGroup.appendChild(this.brushBiomeSelect)

    this.root.appendChild(this.brushFieldGroup)

    // 撤销 / 重做
    const historyGroup = doc.createElement('div')
    historyGroup.className = 'fc-toolbar-group'
    this.undoButton = doc.createElement('button')
    this.undoButton.className = 'fc-toolbar-button'
    this.undoButton.textContent = '撤销'
    this.undoButton.title = '撤销（Ctrl/Cmd+Z）'
    this.undoButton.addEventListener('click', () => {
      options.onUndo()
      this.refresh()
    })
    this.redoButton = doc.createElement('button')
    this.redoButton.className = 'fc-toolbar-button'
    this.redoButton.textContent = '重做'
    this.redoButton.title = '重做（Ctrl/Cmd+Shift+Z）'
    this.redoButton.addEventListener('click', () => {
      options.onRedo()
      this.refresh()
    })
    historyGroup.append(this.undoButton, this.redoButton)
    this.root.appendChild(historyGroup)

    // 名称显示开关：地图元素密集时用来降噪（只影响绘制，不改数据）
    const viewGroup = doc.createElement('div')
    viewGroup.className = 'fc-toolbar-group'
    this.nameButton = doc.createElement('button')
    this.nameButton.className = 'fc-toolbar-button fc-toolbar-names'
    this.nameButton.textContent = '名称'
    this.nameButton.title = '显示/隐藏路径与区域名称（图层设置，会记住）'
    this.nameButton.addEventListener('click', () => {
      // 只写设置：编辑器里**没有**第二份名称开关（见 MapEditor 的说明）
      options.onToggleLabels()
      this.refresh()
    })
    viewGroup.appendChild(this.nameButton)

    // 图例开关：图例是"要看的时候才看"的东西，所以默认关着，这里给它一个入口
    this.legendButton = doc.createElement('button')
    this.legendButton.className = 'fc-toolbar-button fc-toolbar-legend'
    this.legendButton.textContent = '图例'
    this.legendButton.title = '显示/隐藏图例（从地图上实际有的内容生成）'
    this.legendButton.addEventListener('click', () => {
      options.onToggleLegend()
      this.refresh()
    })
    viewGroup.appendChild(this.legendButton)
    this.root.appendChild(viewGroup)

    this.hintEl = doc.createElement('div')
    this.hintEl.className = 'fc-toolbar-hint'
    this.root.appendChild(this.hintEl)

    this.statusEl = doc.createElement('div')
    this.statusEl.className = 'fc-toolbar-status'
    this.statusEl.dataset.fcToolbarStatus = '1'
    this.root.appendChild(this.statusEl)

    container.appendChild(this.root)
    this.refresh()
  }

  getElement(): HTMLElement {
    return this.root
  }

  /** 当前区域类型目录（缺省即出厂目录） */
  private regionTypes(): readonly RegionTypeEntry[] {
    return this.options.getRegionTypes?.() ?? defaultRegionTypeEntries()
  }

  /** 当前路径类型目录（缺省即出厂目录） */
  private pathTypes(): readonly PathTypeEntry[] {
    return this.options.getPathTypes?.() ?? defaultPathTypeEntries()
  }

  /** 路径下拉的选项（内置 4 种 + 自定义；顺序 = 目录顺序） */
  private pathDropdownItems(): ToolbarDropdownItem[] {
    const entries = this.pathTypes()
    return listPathTypeEntries(entries).map((entry) => {
      const resolved = resolvePathType(entry.id, entries)
      return {
        id: entry.id,
        label: entry.label,
        color: resolved.params.color,
        title: `${entry.label}（ID ${entry.id} · ${describePathTypeParams(resolved.params)}）`,
      }
    })
  }

  /**
   * 区域下拉的选项（内置 6 种 + 自定义）。
   *
   * 每个选项都带**自己的色块**，于是用户不必展开就能分清"哪个是自己建的那个区域类型"；
   * 提示里给出 ID 与画法参数，让两个同色类型也能区分（否则界面上会出现两个看起来一样的选项）。
   */
  private regionDropdownItems(): ToolbarDropdownItem[] {
    const entries = this.regionTypes()
    return entries.map((entry) => {
      const resolved = resolveRegionType(entry.id, entries)
      return {
        id: entry.id,
        label: entry.label,
        color: resolved.params.color,
        title: `${entry.label}（ID ${entry.id} · ${describeRegionTypeParams(resolved.params)}）`,
      }
    })
  }

  /**
   * 当前区域类型的下拉项 —— 用**目录解析器**而不是在选项列表里找。
   *
   * 选项列表里只有"设置里存在的类型"；当前类型可能是未知 ID（别的库写的、或用户刚把定义删了），
   * 这时解析器给回退参数与「未知（ID）」，触发按钮于是显示得出来东西，而不是空着。
   */
  private currentRegionItem(id: string, items: readonly ToolbarDropdownItem[]): ToolbarDropdownItem {
    const known = items.find((item) => item.id === id)
    if (known) return { ...known, title: `区域类型：${known.title}` }
    const resolved = resolveRegionType(id, this.regionTypes())
    return {
      id,
      label: resolved.label,
      color: resolved.params.color,
      title: `区域类型：${resolved.label}（ID ${id} · ${describeRegionTypeParams(resolved.params)}）`,
    }
  }

  /** 当前路径类型的下拉项（同 `currentRegionItem`，未知类型也要看得见） */
  private currentPathItem(id: string, items: readonly ToolbarDropdownItem[]): ToolbarDropdownItem {
    const known = items.find((item) => item.id === id)
    if (known) return { ...known, title: `路径类型：${known.title}` }
    const resolved = resolvePathType(id, this.pathTypes())
    return {
      id,
      label: resolved.label,
      color: resolved.params.color,
      title: `路径类型：${resolved.label}（ID ${id} · ${describePathTypeParams(resolved.params)}）`,
    }
  }

  /**
   * 重建两个类型下拉的选项。
   *
   * 与地形/标记按钮同一套做法：目录签名变了才重建（不要每帧重建 DOM）；
   * 每个选项都带自己的颜色小色块。
   */
  private rebuildTypeDropdowns(): void {
    const pathEntries = this.pathTypes()
    const pathItems = this.pathDropdownItems()
    const status = this.options.editor.getStatus()
    this.pathDropdown.rebuild(
      pathItems,
      pathTypeCatalogSignature(pathEntries),
      this.currentPathItem(status.pathType, pathItems),
      this.pathSignature === '',
    )
    this.pathSignature = pathTypeCatalogSignature(pathEntries)
    const regionEntries = this.regionTypes()
    const regionItems = this.regionDropdownItems()
    this.regionDropdown.rebuild(
      regionItems,
      regionTypeCatalogSignature(regionEntries),
      this.currentRegionItem(status.regionType, regionItems),
      this.regionSignature === '',
    )
    this.regionSignature = regionTypeCatalogSignature(regionEntries)
  }

  /**
   * 重建地形按钮组：内置 9 种在前（顺序即数字键 1–9），自定义排在后面。
   *
   * 为什么自定义地形**不占用数字键**：`1`–`9` 已经被内置的 9 种占满，而自定义的数量不确定
   * （0 到 64 个），任何"再抢一个键位"的方案都会把已有的肌肉记忆搞乱；
   * 用组合键（Alt+数字）又可能与 Obsidian 或系统快捷键冲突。所以自定义地形只用鼠标点选，
   * 并在 title 里给出完整 ID，保证界面上不会有两个"看起来一样"的按钮分不清。
   */
  private rebuildTerrainButtons(): void {
    const doc = this.root.ownerDocument ?? globalThis.document
    const custom = this.options.getCustomTerrains?.() ?? []
    const styles = listResolvedTerrainStyles(custom)
    this.terrainSignature = terrainCatalogSignature(custom)
    this.terrainGroup.empty()
    this.terrainButtons.clear()

    styles.forEach((style, index) => {
      const button = doc.createElement('button')
      button.className = style.builtin ? 'fc-toolbar-button fc-toolbar-terrain' : 'fc-toolbar-button fc-toolbar-terrain is-custom'
      button.title = style.builtin
        ? `${style.label}（快捷键 ${index + 1}）`
        : `${style.label}（自定义地形 ${style.id}${style.imagePath.length > 0 ? ` · 图片 ${style.imagePath}` : ''}）`
      const swatch = doc.createElement('span')
      swatch.className = 'fc-toolbar-swatch'
      swatch.style.backgroundColor = style.base
      button.appendChild(swatch)
      const label = doc.createElement('span')
      label.textContent = style.label
      button.appendChild(label)
      button.addEventListener('click', () => {
        this.options.editor.setTerrainType(style.id)
        this.refresh()
      })
      this.terrainButtons.set(style.id, button)
      this.terrainGroup.appendChild(button)
    })
  }

  /**
   * 重建标记图标按钮：内置 9 种在前，自定义按设置顺序排在后面。
   *
   * 与地形按钮同一套做法（目录签名变了才重建）。两点差别：
   * - 图片模式的自定义标记在按钮上**直接显示用户那张图**，而不是借来的字形 ——
   *   否则用户在工具条上根本认不出自己挑的图标（字形只是个占位）；
   * - 自定义标记额外显示显示名：图标字形可能是通用的圆点，只有名字能把它们区分开。
   *
   * 与地形一致：**未知图标不占按钮位**（工具条只列"当前设置里存在的选择"）。
   * 地图里已有的未知图标仍然正常绘制（回退视觉），数据也不会丢 —— 这里只是不发按钮。
   */
  private rebuildMarkerButtons(): void {
    const doc = this.root.ownerDocument ?? globalThis.document
    const custom = this.options.getCustomMarkers?.() ?? []
    const styles = listResolvedMarkerStyles(custom)
    this.markerSignature = markerCatalogSignature(custom)
    this.iconGroup.empty()
    this.iconButtons.clear()

    for (const style of styles) {
      const button = doc.createElement('button')
      button.className = style.builtin
        ? 'fc-toolbar-button fc-toolbar-icon'
        : 'fc-toolbar-button fc-toolbar-icon is-custom'
      button.title = style.builtin
        ? (ICON_LABELS[style.id as MarkerIcon] ?? style.label)
        : `${style.label}（自定义标记 ${style.id}${style.imagePath.length > 0 ? ` · 图片 ${style.imagePath}` : ''}）`
      const iconEl = doc.createElement('span')
      iconEl.className = 'fc-toolbar-icon-glyph'
      const src = style.imagePath.length > 0 ? (this.options.resolveImageSrc?.(style.imagePath) ?? '') : ''
      if (src.length > 0) {
        const img = doc.createElement('img')
        img.className = 'fc-toolbar-icon-image'
        img.alt = ''
        // 同标记层：不设 draggable=false 会把"点按钮"变成浏览器原生拖图
        img.draggable = false
        img.src = src
        iconEl.appendChild(img)
      } else {
        setIcon(iconEl, style.iconName)
      }
      button.appendChild(iconEl)
      if (!style.builtin) {
        const label = doc.createElement('span')
        label.textContent = style.label
        button.appendChild(label)
      }
      button.addEventListener('click', () => {
        this.options.editor.setMarkerIcon(style.id)
        this.refresh()
      })
      this.iconButtons.set(style.id, button)
      this.iconGroup.appendChild(button)
    }
  }

  /**
   * 刷新"数据层笔刷"那一组（§E）。
   *
   * 三件事：**只显示当前字段用得上的控件**（分类字段没有算法与数值，数值字段没有群系下拉）、
   * **数值框的显示与实际生效的值一致**（未确认时标出来）、状态条在笔刷不可用时**说清原因**。
   */
  private refreshBrushField(status: EditorStatus, painting: boolean): void {
    const isBrush = status.tool === 'brush'
    this.brushFieldGroup.style.display = painting && isBrush ? '' : 'none'
    if (!painting || !isBrush) return

    this.brushFieldSelect.value = status.brushField ?? ''
    const isField = status.brushField !== null
    const spec = isField ? OVERLAY_FIELDS.find((item) => item.id === status.brushField) : undefined
    const numeric = spec !== undefined && spec.numeric
    const category = spec !== undefined && !spec.numeric

    // 数值框：只在数值字段下出现。**输入框有焦点时不去改它的文字** ——
    // 否则 refresh（选中变化 / 状态变化都会触发）会把用户正打的字冲掉。
    const doc = this.root.ownerDocument ?? globalThis.document
    this.brushValueInput.style.display = numeric ? '' : 'none'
    if (numeric) {
      const isFocused = doc.activeElement === this.brushValueInput
      if (!isFocused) {
        this.brushValueInput.value = status.brushValue === null ? '' : String(status.brushValue)
      }
      // 未确认（换层 / 换算法之后）灰掉：数字还留着，但要点一次回车才算数
      this.brushValueInput.classList.toggle('is-unconfirmed', status.brushValue !== null && !status.brushValueConfirmed)
      this.brushValueInput.placeholder = status.brushValue === null ? '数值（空着不生效）' : '回车确认'
    }

    // 算法：分类字段只有"设为"，所以整组藏起来（摆着点不动只会让人以为坏了）
    this.brushOpGroup.style.display = numeric ? '' : 'none'
    for (const [op, button] of this.brushOpButtons) {
      button.classList.toggle('is-active', status.brushOp === op)
      button.disabled = !numeric
    }

    // 群系下拉：只在生物群系字段下出现；选项由**现读的目录**决定（内置 34 条 + 自定义）
    this.brushBiomeSelect.style.display = category ? '' : 'none'
    if (category) {
      const custom = this.options.getCustomBiomes?.() ?? []
      const signature = biomeCatalogSignature(custom)
      if (signature !== this.biomeSignature) {
        this.biomeSignature = signature
        this.brushBiomeSelect.empty?.()
        this.brushBiomeSelect.textContent = ''
        const placeholder = doc.createElement('option')
        placeholder.value = ''
        placeholder.textContent = '选择生物群系…'
        this.brushBiomeSelect.appendChild(placeholder)
        for (const entry of listResolvedBiomeStyles(custom)) {
          const option = doc.createElement('option')
          option.value = entry.id
          option.textContent = entry.label
          this.brushBiomeSelect.appendChild(option)
        }
      }
      this.brushBiomeSelect.value = status.brushBiome
    }

    // 状态条：笔刷不可用时把**原因**写在状态里（§E 第 2 条：用户不该靠猜"为什么刷不动"）
    if (isField && !status.brushReady.ok) {
      this.statusEl.textContent = `编辑：数据层笔刷 · ${status.brushReady.reason}`
    }
  }

  /**
   * 状态条那一行（§F.3）。
   *
   * 三种状态各有明确的说法：
   * - 绘制模式 → `编辑：地形笔刷 · 森林`（把"正在用什么工具、什么值"说出来）；
   * - 选择模式且有选择 → `选择：矩形框选 · 12 格`；
   * - 选择模式且没有选择 → `空闲`。
   *
   * 地形显示名从**当前目录**现取（自定义地形也有名字），取不到就退回 ID —— 不显示空白。
   */
  private statusLine(status: EditorStatus, painting: boolean): string {
    if (painting) {
      // 数据层笔刷（§E）：把"刷哪一层、怎么刷"说出来（不可用时由 `refreshBrushField` 换成原因）
      if (status.tool === 'brush' && status.brushField !== null) {
        const spec = OVERLAY_FIELDS.find((item) => item.id === status.brushField)
        const label = spec?.label ?? status.brushField
        if (spec !== undefined && !spec.numeric) {
          const entry = status.brushBiome.length > 0 ? resolveBiomeStyle(status.brushBiome, []).label : '（未选）'
          return `编辑：${label}笔刷 · ${entry}`
        }
        const op = status.brushOp === 'set' ? '＝' : status.brushOp
        const value = status.brushValue === null ? '（未填）' : status.brushValue
        return `编辑：${label}笔刷 · ${op}${value}`
      }
      const tool = TOOL_LABELS[status.tool].label
      if (status.tool !== 'brush') return `编辑：${tool}`
      const terrain =
        listResolvedTerrainStyles(this.options.getCustomTerrains?.() ?? []).find(
          (style) => style.id === status.terrainType,
        )?.label ?? status.terrainType
      return `编辑：地形笔刷 · ${terrain}`
    }
    const count = status.cellSelection.length
    if (count === 0) return '空闲'
    return `选择：${status.selectionMode === 'rect' ? '矩形框选' : '笔迹框选'} · ${count} 格`
  }

  /** 按编辑器当前状态刷新按钮文案与可用性 */
  refresh(): void {
    // 地形目录变了（用户增删自定义地形）→ 按钮数量本身变了，只能重建这一组
    if (terrainCatalogSignature(this.options.getCustomTerrains?.() ?? []) !== this.terrainSignature) {
      this.rebuildTerrainButtons()
    }
    // 标记目录同理：改完显示名或换图之后按钮上的文字/缩略图也要跟上
    if (markerCatalogSignature(this.options.getCustomMarkers?.() ?? []) !== this.markerSignature) {
      this.rebuildMarkerButtons()
    }
    // 路径/区域类型目录同理：用户增删自定义类型、或改了名字，两个下拉的选项就要跟上
    if (
      pathTypeCatalogSignature(this.pathTypes()) !== this.pathSignature ||
      regionTypeCatalogSignature(this.regionTypes()) !== this.regionSignature
    ) {
      this.rebuildTypeDropdowns()
    }
    const status: EditorStatus = this.options.editor.getStatus()
    const painting = status.mode === 'paint'

    this.modeButton.textContent = painting ? '● 绘制中' : '选择'
    this.modeButton.classList.toggle('is-active', painting)
    this.modeButton.title = painting ? '退出绘制模式（Esc）' : '进入绘制模式（D）'

    // 状态条：一行说清"现在是什么状态"（§F.3）。详情不在这一层 —— 那在右上角的信息卡里
    this.statusEl.textContent = this.statusLine(status, painting)
    this.refreshBrushField(status, painting)

    for (const [tool, button] of this.toolButtons) {
      button.classList.toggle('is-active', painting && tool === status.tool)
      button.disabled = !painting
    }
    for (const [type, button] of this.terrainButtons) {
      button.classList.toggle('is-active', type === status.terrainType)
    }
    for (const [icon, button] of this.iconButtons) {
      button.classList.toggle('is-active', icon === status.markerIcon)
    }

    // 只有当前工具相关的那一组才显示，避免工具条过长
    this.selectGroup.style.display = painting ? 'none' : ''
    this.rectButton.classList.toggle('is-active', status.selectionMode === 'rect')
    this.brushSelectButton.classList.toggle('is-active', status.selectionMode === 'brush')
    this.terrainGroup.style.display = painting && status.tool === 'brush' ? '' : 'none'
    this.brushGroup.style.display = painting && status.tool === 'brush' ? '' : 'none'
    this.iconGroup.style.display = painting && status.tool === 'marker' ? '' : 'none'
    const showPathGroup = painting && status.tool === 'path'
    const showRegionGroup = painting && status.tool === 'region'
    this.pathDropdown.getElement().style.display = showPathGroup ? '' : 'none'
    // 离开某个工具就收起它的下拉：留着展开状态会让它下次出现时莫名其妙是开的
    if (!showPathGroup && this.pathDropdown.isOpen()) this.pathDropdown.setOpen(false)
    this.regionDropdown.getElement().style.display = showRegionGroup ? '' : 'none'
    if (!showRegionGroup && this.regionDropdown.isOpen()) this.regionDropdown.setOpen(false)
    // 几何模式只对"多点绘制"的两个工具显示
    const isShapeTool = status.tool === 'path' || status.tool === 'region'
    this.geometryGroup.style.display = painting && isShapeTool ? '' : 'none'
    for (const [mode, button] of this.geometryButtons) button.classList.toggle('is-active', mode === status.geometryMode)

    // 两个类型下拉：触发按钮上的色块与名字 = **当前类型**；选中项高亮、色块与提示原地刷新
    // （每次现读目录，于是设置里改完颜色/线宽/不透明度，工具条立刻跟上）
    // 两个类型下拉：触发按钮上的色块与名字 = **当前类型**；选中项高亮、色块与提示原地刷新
    // （每次现读目录，于是设置里改完颜色/线宽/不透明度，工具条立刻跟上）。
    // 当前类型解析器**永不返回空**：定义被删掉或遇到未知 ID 时显示回退视觉，
    // 而不是留着上一条类型的名字（那会让用户以为选中的还是它）。
    const pathItems = this.pathDropdownItems()
    this.pathDropdown.refreshSelection(pathItems, this.currentPathItem(status.pathType, pathItems))
    const regionItems = this.regionDropdownItems()
    this.regionDropdown.refreshSelection(regionItems, this.currentRegionItem(status.regionType, regionItems))

    this.brushLabel.textContent = `${status.brushRadius}`
    // 这两个高亮读的是**设置**（唯一真相），不是工具条或编辑器里的副本
    const showNames = this.options.getShowShapeLabels()
    this.nameButton.classList.toggle('is-active', showNames)
    this.nameButton.textContent = showNames ? '名称 ✓' : '名称'
    const showLegend = this.options.getShowLegend()
    this.legendButton.classList.toggle('is-active', showLegend)
    this.legendButton.textContent = showLegend ? '图例 ✓' : '图例'
    this.undoButton.disabled = status.undo === 0
    this.redoButton.disabled = status.redo === 0
    this.undoButton.textContent = `撤销${status.undo > 0 ? ` (${status.undo})` : ''}`
    this.redoButton.textContent = `重做${status.redo > 0 ? ` (${status.redo})` : ''}`

    if (!painting) {
      // 选择模式：把"当前选中多少格、拖动会做什么"直接说出来 ——
      // 这几种手势的差别只有修饰键，不写出来用户只能靠试
      const count = status.cellSelection.length
      this.hintEl.textContent =
        count > 0
          ? `已选 ${count} 格 · 左键拖动=${status.selectionMode === 'rect' ? '矩形框选' : '笔迹框选'} · Shift 加选 / Alt 取消 · Esc 清空`
          : '按 D 进入绘制模式 · 左键拖动框选一片格 · 双击已有路径/区域可重命名'
    } else if (status.tool === 'brush') this.hintEl.textContent = '左键描绘地形 · 1-9 换地形 · [ ] 调笔刷 · Esc 退出'
    else if (status.tool === 'marker') this.hintEl.textContent = '左键点击放置标记 · 选择模式下可点击打开笔记 / 拖动移动 / 右键删除'
    else if (status.tool === 'label') this.hintEl.textContent = '左键点击放置文字标注 · 选择模式下可拖动移动 / 右键删除'
    else {
      const shape = status.tool === 'path' ? '路径' : '区域'
      // 提示里带上当前几何模式与它的画法差异 —— 三种模式的点击含义不同，
      // 不写出来用户只能靠试。
      const modeLabel = status.geometryMode === 'edge' ? '沿格边' : status.geometryMode === 'edge-step' ? '逐边' : '穿内部'
      const modeHint =
        status.geometryMode === 'edge-step'
          ? '每次点击沿格边前进一条边（点哪个方向就往哪走）'
          : status.geometryMode === 'edge'
            ? '中间自动沿格边走'
            : '自由折线（河流平滑）'
      this.hintEl.textContent =
        status.draftPoints > 0
          ? `${shape}（${modeLabel}）：已定 ${status.draftPoints} 个顶点 · 双击/回车/右键结束 · Esc 取消`
          : `${shape}（${modeLabel}）：${modeHint} · 双击或回车结束 · 选择模式双击可重命名`
    }
  }

  destroy(): void {
    // 两个下拉各自摘掉自己的 document 监听（地图层被停用时工具条会整个销毁，留着监听就是一处泄漏）
    this.pathDropdown.destroy()
    this.regionDropdown.destroy()
    this.root.remove()
  }
}
