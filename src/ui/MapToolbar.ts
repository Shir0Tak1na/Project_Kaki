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
import type { EditorStatus, EditorTool, MapEditor } from '../editor/MapEditor.ts'
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
import { REGION_PRESETS } from '../render/shapeStyle.ts'
import { defaultRegionColors } from '../render/stylePalette.ts'
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
   * 工具条**不缓存**颜色：点亮色块时按下标去调色板里现取，
   * `refresh()` 时也重新读一遍色块颜色 —— 于是设置里改完颜色，工具条立刻跟上，
   * 又不需要重建 DOM（侧边栏那次"每帧重建"的教训）。
   */
  getPalette?: () => { regionColors: string[] }
  /**
   * 路径类型目录（来自插件设置）—— 工具条下拉的**唯一**内容来源：内置 4 种 + 用户自定义。
   *
   * 与自定义地形/标记同理：选项数量会随设置变化，所以目录签名变了要重建下拉。
   */
  getPathTypes?: () => readonly PathTypeEntry[]
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
}

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
   * 路径类型下拉。
   *
   * 以前是"每种类型一个按钮 + 一个色块"，类型变多就换行、把别的控件挤走；
   * 现在只有一个按钮（显示当前类型的色块 + 名字）和一个选项列表。
   * 选项按 `dataset.pathType` 索引，**未知类型不给选项**（工具条只列"当前设置里存在的选择"），
   * 但地图里已有的未知类型仍然正常绘制，数据也不会丢。
   */
  private readonly pathTrigger: HTMLButtonElement
  private readonly pathSwatch: HTMLElement
  private readonly pathLabel: HTMLElement
  private readonly pathCaret: HTMLElement
  private readonly pathMenu: HTMLElement
  private readonly pathOptions = new Map<PathType, HTMLButtonElement>()
  /** 每个选项自己的色块（改颜色时原地刷新，不重建 DOM） */
  private readonly pathOptionSwatches = new Map<PathType, HTMLElement>()
  /** 上一次构建下拉时的目录签名：变了才重建 DOM */
  private pathSignature = ''
  /** 下拉是否展开（纯界面状态，不进设置） */
  private pathMenuOpen = false
  /**
   * 展开时挂在 document 上的「点外面就收起」监听。
   *
   * 为什么必须有：菜单是个浮层，用户点地图的直觉是"把它关掉"——
   * 而点击会落到画布上，于是下一个动作变成在地图上画了一个点。
   * 监听器**跟着展开状态注册/注销**（收起、销毁时都摘掉），不留全局残留。
   */
  private pathOutsideListener: ((event: Event) => void) | null = null
  private readonly regionButtons = new Map<number, HTMLButtonElement>()
  private readonly regionSwatches = new Map<number, HTMLElement>()
  private readonly geometryButtons = new Map<GeometryMode, HTMLButtonElement>()
  private readonly terrainGroup: HTMLElement
  private readonly iconGroup: HTMLElement
  private readonly pathGroup: HTMLElement
  private readonly regionGroup: HTMLElement
  private readonly geometryGroup: HTMLElement
  private readonly brushGroup: HTMLElement
  private readonly brushLabel: HTMLElement
  private readonly undoButton: HTMLButtonElement
  private readonly redoButton: HTMLButtonElement
  private readonly nameButton: HTMLButtonElement
  private readonly legendButton: HTMLButtonElement
  private readonly hintEl: HTMLElement

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
    this.pathGroup = doc.createElement('div')
    this.pathGroup.className = 'fc-toolbar-group fc-toolbar-path-group'
    this.pathTrigger = doc.createElement('button')
    this.pathTrigger.className = 'fc-toolbar-button fc-toolbar-path-trigger'
    this.pathTrigger.dataset.fcPathTrigger = '1'
    this.pathSwatch = doc.createElement('span')
    this.pathSwatch.className = 'fc-toolbar-swatch'
    this.pathSwatch.dataset.fcPathSwatch = '1'
    this.pathLabel = doc.createElement('span')
    this.pathLabel.className = 'fc-toolbar-path-label'
    this.pathCaret = doc.createElement('span')
    this.pathCaret.className = 'fc-toolbar-path-caret'
    this.pathCaret.textContent = '▾'
    this.pathTrigger.append(this.pathSwatch, this.pathLabel, this.pathCaret)
    this.pathTrigger.addEventListener('click', () => {
      this.setPathMenuOpen(!this.pathMenuOpen)
    })
    this.pathMenu = doc.createElement('div')
    this.pathMenu.className = 'fc-toolbar-path-menu'
    this.pathMenu.dataset.fcPathMenu = '1'
    this.pathMenu.style.display = 'none'
    this.pathGroup.append(this.pathTrigger, this.pathMenu)
    this.rebuildPathMenu()
    this.root.appendChild(this.pathGroup)

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

    // 区域颜色（仅区域工具下显示）：按下标建按钮，颜色在点击/刷新时现取
    this.regionGroup = doc.createElement('div')
    this.regionGroup.className = 'fc-toolbar-group fc-toolbar-region-group'
    REGION_PRESETS.forEach((preset, index) => {
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-region'
      button.title = preset.label
      const swatch = doc.createElement('span')
      swatch.className = 'fc-toolbar-swatch'
      swatch.style.backgroundColor = preset.color
      button.appendChild(swatch)
      button.addEventListener('click', () => {
        options.editor.setRegionPresetIndex(index)
        this.refresh()
      })
      this.regionButtons.set(index, button)
      this.regionSwatches.set(index, swatch)
      this.regionGroup.appendChild(button)
    })
    this.root.appendChild(this.regionGroup)

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

    container.appendChild(this.root)
    this.refresh()
  }

  getElement(): HTMLElement {
    return this.root
  }

  /** 当前调色板（缺省即出厂默认） */
  private palette(): { regionColors: string[] } {
    return this.options.getPalette?.() ?? { regionColors: defaultRegionColors() }
  }

  /** 当前路径类型目录（缺省即出厂目录） */
  private pathTypes(): readonly PathTypeEntry[] {
    return this.options.getPathTypes?.() ?? defaultPathTypeEntries()
  }

  /**
   * 重建路径类型下拉的选项。
   *
   * 与地形/标记按钮同一套做法：目录签名变了才重建（不要每帧重建 DOM）。
   * 每一项都带**自己的颜色小色块**，于是用户不必展开就能分清"哪个是自己建的那条路"。
   */
  private rebuildPathMenu(): void {
    const doc = this.root.ownerDocument ?? globalThis.document
    const entries = listPathTypeEntries(this.pathTypes())
    this.pathSignature = pathTypeCatalogSignature(this.pathTypes())
    this.pathMenu.empty()
    this.pathOptions.clear()
    this.pathOptionSwatches.clear()

    for (const entry of entries) {
      const resolved = resolvePathType(entry.id, this.pathTypes())
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-path-option'
      // 选项按 ID 索引：断言与"当前选中项"都靠它，而不是靠显示名（显示名可以改）
      button.dataset.pathType = entry.id
      button.title = `${entry.label}（ID ${entry.id} · ${describePathTypeParams(resolved.params)}）`
      const swatch = doc.createElement('span')
      swatch.className = 'fc-toolbar-swatch'
      swatch.style.backgroundColor = resolved.params.color
      const label = doc.createElement('span')
      label.textContent = entry.label
      button.append(swatch, label)
      button.addEventListener('click', () => {
        this.options.editor.setPathType(entry.id)
        // 选完就收起：下拉常开会挡住画布
        this.setPathMenuOpen(false)
        this.refresh()
      })
      this.pathOptions.set(entry.id, button)
      this.pathOptionSwatches.set(entry.id, swatch)
      this.pathMenu.appendChild(button)
    }
  }

  /** 展开/收起路径类型下拉（纯界面状态：不进设置，也不影响画布） */
  private setPathMenuOpen(open: boolean): void {
    this.pathMenuOpen = open
    this.pathMenu.style.display = open ? '' : 'none'
    this.pathTrigger.classList.toggle('is-open', open)
    const doc = this.root.ownerDocument ?? globalThis.document
    if (open) {
      if (this.pathOutsideListener === null) {
        this.pathOutsideListener = (event: Event) => {
          const target = event.target
          // 点在下拉组内部（触发按钮或某个选项）时由它们各自的 handler 处理，别抢
          if (target !== null && this.pathGroup.contains(target as Node)) return
          this.setPathMenuOpen(false)
        }
        doc.addEventListener('pointerdown', this.pathOutsideListener, true)
      }
    } else if (this.pathOutsideListener !== null) {
      doc.removeEventListener('pointerdown', this.pathOutsideListener, true)
      this.pathOutsideListener = null
    }
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
    // 路径类型目录同理：用户增删自定义类型、或改了名字/颜色，下拉的选项就要跟上
    if (pathTypeCatalogSignature(this.pathTypes()) !== this.pathSignature) {
      this.rebuildPathMenu()
    }
    const status: EditorStatus = this.options.editor.getStatus()
    const painting = status.mode === 'paint'

    this.modeButton.textContent = painting ? '● 绘制中' : '选择'
    this.modeButton.classList.toggle('is-active', painting)
    this.modeButton.title = painting ? '退出绘制模式（Esc）' : '进入绘制模式（D）'

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
    this.terrainGroup.style.display = painting && status.tool === 'brush' ? '' : 'none'
    this.brushGroup.style.display = painting && status.tool === 'brush' ? '' : 'none'
    this.iconGroup.style.display = painting && status.tool === 'marker' ? '' : 'none'
    const showPathGroup = painting && status.tool === 'path'
    this.pathGroup.style.display = showPathGroup ? '' : 'none'
    // 离开路径工具就收起下拉：留着展开状态会让它下次出现时莫名其妙是开的
    if (!showPathGroup && this.pathMenuOpen) this.setPathMenuOpen(false)
    this.regionGroup.style.display = painting && status.tool === 'region' ? '' : 'none'
    // 几何模式只对"多点绘制"的两个工具显示
    const isShapeTool = status.tool === 'path' || status.tool === 'region'
    this.geometryGroup.style.display = painting && isShapeTool ? '' : 'none'
    for (const [mode, button] of this.geometryButtons) button.classList.toggle('is-active', mode === status.geometryMode)

    // 路径类型下拉：触发按钮上的色块与名字 = **当前类型**（每次刷新现读目录，改完设置立刻跟上）
    const currentPath = resolvePathType(status.pathType, this.pathTypes())
    if (this.pathSwatch.style.backgroundColor !== currentPath.params.color) {
      this.pathSwatch.style.backgroundColor = currentPath.params.color
    }
    this.pathLabel.textContent = currentPath.label
    this.pathTrigger.title = `路径类型：${currentPath.label}（${describePathTypeParams(currentPath.params)}）`
    for (const [type, button] of this.pathOptions) {
      button.classList.toggle('is-active', type === status.pathType)
      // 色块与提示**原地刷新**：改了颜色/线宽不需要重建选项（签名里没有参数，见 pathTypeCatalogSignature）
      const resolved = resolvePathType(type, this.pathTypes())
      const swatch = this.pathOptionSwatches.get(type)
      if (swatch && swatch.style.backgroundColor !== resolved.params.color) {
        swatch.style.backgroundColor = resolved.params.color
      }
      const title = `${resolved.label}（ID ${type} · ${describePathTypeParams(resolved.params)}）`
      if (button.title !== title) button.title = title
    }
    // 区域色块：按下标比对（设置里换了颜色也能正确高亮），并顺带把色块更新到最新设置
    const palette = this.palette()
    for (const [index, button] of this.regionButtons) {
      const color = palette.regionColors[index]
      const swatch = this.regionSwatches.get(index)
      if (swatch && typeof color === 'string' && color.length > 0 && swatch.style.backgroundColor !== color) {
        swatch.style.backgroundColor = color
      }
      button.classList.toggle('is-active', typeof color === 'string' && color === status.regionColor)
    }

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

    if (!painting) this.hintEl.textContent = '按 D 进入绘制模式 · 双击已有路径/区域可重命名'
    else if (status.tool === 'brush') this.hintEl.textContent = '左键描绘地形 · 1-9 换地形 · [ ] 调笔刷 · Esc 退出'
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
    // 先摘掉全局监听：地图层被停用时工具条会整个销毁，留着监听就是一处泄漏
    if (this.pathOutsideListener !== null) {
      const doc = this.root.ownerDocument ?? globalThis.document
      doc.removeEventListener('pointerdown', this.pathOutsideListener, true)
      this.pathOutsideListener = null
    }
    this.root.remove()
  }
}
