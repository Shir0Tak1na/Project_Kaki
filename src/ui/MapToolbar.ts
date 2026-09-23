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
import { MARKER_ICONS, PATH_TYPES, type MarkerIcon, type PathType } from '../data/mapDocument.ts'
import type { EditorStatus, EditorTool, MapEditor } from '../editor/MapEditor.ts'
import type { GeometryMode } from '../core/hexEdges.ts'
import { listResolvedTerrainStyles, terrainCatalogSignature, type CustomTerrain } from '../render/terrainCatalog.ts'
import { lucideIconFor } from '../render/markerPlacement.ts'
import { REGION_PRESETS } from '../render/shapeStyle.ts'
import { defaultPathColors, defaultRegionColors, resolvePathStyle, type PathColorMap } from '../render/stylePalette.ts'
import { ICON_LABELS } from './PlaceMarkerModal.ts'

/** 路径类型按固定顺序展示（与 PATH_TYPES 一致）；颜色来自当前调色板 */
function listPathStyles(colors: PathColorMap): Array<{ type: PathType; label: string; color: string }> {
  return PATH_TYPES.map((type) => {
    const style = resolvePathStyle(type, colors)
    return { type, label: style.label, color: style.color }
  })
}

export interface MapToolbarOptions {
  editor: MapEditor
  /** 进入/退出绘制模式时同步指针策略 */
  onModeChanged: (mode: 'select' | 'paint') => void
  onUndo: () => void
  onRedo: () => void
  onToggleLayer?: () => void
  /**
   * 当前样式调色板（来自插件设置）。
   *
   * 工具条**不缓存**颜色：点亮色块时按下标去调色板里现取，
   * `refresh()` 时也重新读一遍色块颜色 —— 于是设置里改完颜色，工具条立刻跟上，
   * 又不需要重建 DOM（侧边栏那次"每帧重建"的教训）。
   */
  getPalette?: () => { pathColors: PathColorMap; regionColors: string[] }
  /**
   * 用户自定义地形（来自插件设置）。
   *
   * 与颜色不同，**按钮数量**会随设置变化，所以这里不能只"原地改样式"：
   * 目录签名变了就得重建地形按钮那一组（见 `refresh()`）。重建的代价是一次 DOM 操作，
   * 而它在用户改设置时才会发生，不会进入每帧路径。
   */
  getCustomTerrains?: () => readonly CustomTerrain[]
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
  private readonly layerButton: HTMLButtonElement
  private readonly toolButtons = new Map<EditorTool, HTMLButtonElement>()
  /** 地形按钮按**地形 ID**索引（内置 + 自定义共用一套） */
  private readonly terrainButtons = new Map<string, HTMLButtonElement>()
  /** 上一次构建地形按钮时的目录签名：变了才重建 DOM */
  private terrainSignature = ''
  private readonly iconButtons = new Map<MarkerIcon, HTMLButtonElement>()
  private readonly pathButtons = new Map<PathType, HTMLButtonElement>()
  private readonly regionButtons = new Map<number, HTMLButtonElement>()
  /** 色块元素：设置里改了颜色后，刷新时原地改背景色（不重建 DOM） */
  private readonly pathSwatches = new Map<PathType, HTMLElement>()
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

    this.layerButton = doc.createElement('button')
    this.layerButton.className = 'fc-toolbar-button fc-toolbar-layer'
    this.layerButton.textContent = '地图层'
    this.layerButton.title = '停用当前地图层'
    this.layerButton.addEventListener('click', () => options.onToggleLayer?.())
    this.root.appendChild(this.layerButton)

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

    // 标记图标选择（仅标记工具下显示）
    this.iconGroup = doc.createElement('div')
    this.iconGroup.className = 'fc-toolbar-group fc-toolbar-icon-group'
    for (const icon of MARKER_ICONS) {
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-icon'
      button.title = ICON_LABELS[icon]
      const iconEl = doc.createElement('span')
      iconEl.className = 'fc-toolbar-icon-glyph'
      setIcon(iconEl, lucideIconFor(icon))
      button.appendChild(iconEl)
      button.addEventListener('click', () => {
        options.editor.setMarkerIcon(icon)
        this.refresh()
      })
      this.iconButtons.set(icon, button)
      this.iconGroup.appendChild(button)
    }
    this.root.appendChild(this.iconGroup)

    // 路径类型（仅路径工具下显示）
    this.pathGroup = doc.createElement('div')
    this.pathGroup.className = 'fc-toolbar-group fc-toolbar-path-group'
    for (const style of listPathStyles(this.palette().pathColors)) {
      const button = doc.createElement('button')
      button.className = 'fc-toolbar-button fc-toolbar-path'
      button.title = style.label
      const swatch = doc.createElement('span')
      swatch.className = 'fc-toolbar-swatch'
      swatch.style.backgroundColor = style.color
      button.appendChild(swatch)
      const label = doc.createElement('span')
      label.textContent = style.label
      button.appendChild(label)
      button.addEventListener('click', () => {
        options.editor.setPathType(style.type)
        this.refresh()
      })
      this.pathButtons.set(style.type, button)
      this.pathSwatches.set(style.type, swatch)
      this.pathGroup.appendChild(button)
    }
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
    this.nameButton.title = '显示/隐藏路径与区域名称'
    this.nameButton.addEventListener('click', () => {
      options.editor.setShowShapeLabels(!options.editor.showShapeLabels)
      this.refresh()
    })
    viewGroup.appendChild(this.nameButton)
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
  private palette(): { pathColors: PathColorMap; regionColors: string[] } {
    return this.options.getPalette?.() ?? { pathColors: defaultPathColors(), regionColors: defaultRegionColors() }
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

  /** 按编辑器当前状态刷新按钮文案与可用性 */
  refresh(): void {
    // 地形目录变了（用户增删自定义地形）→ 按钮数量本身变了，只能重建这一组
    if (terrainCatalogSignature(this.options.getCustomTerrains?.() ?? []) !== this.terrainSignature) {
      this.rebuildTerrainButtons()
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
    this.pathGroup.style.display = painting && status.tool === 'path' ? '' : 'none'
    this.regionGroup.style.display = painting && status.tool === 'region' ? '' : 'none'
    // 几何模式只对"多点绘制"的两个工具显示
    const isShapeTool = status.tool === 'path' || status.tool === 'region'
    this.geometryGroup.style.display = painting && isShapeTool ? '' : 'none'
    for (const [mode, button] of this.geometryButtons) button.classList.toggle('is-active', mode === status.geometryMode)

    for (const [type, button] of this.pathButtons) button.classList.toggle('is-active', type === status.pathType)
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
    for (const [type, swatch] of this.pathSwatches) {
      const color = palette.pathColors[type]
      if (typeof color === 'string' && color.length > 0 && swatch.style.backgroundColor !== color) {
        swatch.style.backgroundColor = color
      }
    }

    this.brushLabel.textContent = `${status.brushRadius}`
    this.nameButton.classList.toggle('is-active', status.showShapeLabels)
    this.nameButton.textContent = status.showShapeLabels ? '名称 ✓' : '名称'
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
    this.root.remove()
  }
}
