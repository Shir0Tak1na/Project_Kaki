/**
 * 地图编辑器：模式、当前地形、笔刷大小、笔画生命周期与撤销栈。
 *
 * 笔画的关键设计：**边拖边画**（用户要立刻看到），但历史只记一条。
 * 因此每条笔画维护一份「格 → 笔画开始前的状态」映射，
 * 抬手时据此生成 op 列表 —— 这样既保证实时反馈，又保证撤销一次回到笔画前。
 */

import type { Axial, GridSpec, Point } from '../core/hex.ts'
import { cellKey, worldToAxial } from '../core/hex.ts'
import { snapToHexVertex, stepAlongEdges, toEdgePath, walkTailToCursor, type GeometryMode } from '../core/hexEdges.ts'

/** 两点之差（用于"上一步方向"） */
function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}
import type {
  MapDocument,
  MapLabel,
  MapMarker,
  MapPath,
  MapRegion,
  MarkerIcon,
  PathType,
  TerrainCell,
  TerrainId,
} from '../data/mapDocument.ts'
import { cellsAlongSegment } from './brushPath.ts'
import { History, applyOp, opsFromPrevious, type MapOp } from './history.ts'
import { nextLabelId, nextMarkerId, snapToCellCenter } from '../render/markerPlacement.ts'
import { hitTestPolygon, hitTestPolyline, visiblePolyline } from '../render/shapeGeometry.ts'
import {
  DEFAULT_REGION_BORDER_WIDTH,
  DEFAULT_REGION_OPACITY,
} from '../render/shapeStyle.ts'
import {
  defaultPathColors,
  defaultRegionColors,
  normalizeColor,
  resolveDefaultRegionColor,
  resolvePathStyle,
  type StylePalette,
} from '../render/stylePalette.ts'

/** 路径/区域 id：与标记共用"避开已用 id"的策略 */
function nextShapeId(document_: MapDocument, prefix: string): string {
  const used = new Set<string>([
    ...document_.markers.map((item) => item.id),
    ...document_.labels.map((item) => item.id),
    ...document_.paths.map((item) => item.id),
    ...document_.regions.map((item) => item.id),
  ])
  for (let index = 1; index < 100000; index += 1) {
    const candidate = `${prefix}${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${prefix}${Date.now()}`
}

export type EditorMode = 'select' | 'paint'

/**
 * 绘制模式下的工具。四者共用"进入绘制模式"这一个开关，
 * 区别只在于按下时做什么：铺地形 / 放标记 / 放文字 / 画路径与区域。
 */
export type EditorTool = 'brush' | 'marker' | 'label' | 'path' | 'region'

/** 进行中的多点多边形/折线（还没提交到文档） */
export interface MapDraft {
  kind: 'path' | 'region'
  /**
   * 已确定的顶点（世界坐标）。
   *
   * ⚠️ 沿格边模式下，这里存的是**走出来的整条边路**（含中间顶点），不是点击数：
   * 否则预览里两段之间还是直线、而提交后会变成格边 —— 又是一次"所见非所得"。
   */
  points: Point[]
  /** 用户点击数（工具栏显示"已定 N 个顶点"用它，而不是 points.length） */
  clickCount: number
  /** 橡皮筋另一端（光标位置），用于预览 */
  cursor: Point | null
  /** 预览用的样式 */
  color: string
  width: number
  /**
   * 预览是否用平滑曲线 / 末端变细。
   *
   * ⚠️ 必须与提交后的渲染一致，否则"松手的一瞬间形状会变"——
   * 预览画折线、结果画曲线，用户会觉得工具不听话。
   */
  smooth: boolean
  taper: boolean
}

export interface MapEditorOptions {
  getDocument: () => MapDocument | null
  /** 文档发生变化（请求重绘） */
  onChanged: () => void
  /** 需要落盘（防抖交给存储层） */
  onSaveRequested?: () => void
  /** 模式/地形/历史等状态变化（刷新工具栏） */
  onStateChanged?: () => void
  /**
   * 当前生效的样式调色板（来自插件设置）。
   *
   * 语义边界：调色板只决定**新画的对象**的颜色；已经画好的对象把颜色存在地图文件里，
   * 渲染时用文件里的值 —— 所以改设置不会悄悄改掉用户已有的地图。
   * 缺省时退回出厂样式（单元测试/无设置上下文时也能构造编辑器）。
   */
  getPalette?: () => StylePalette
  historyLimit?: number
}

export interface EditorStatus {
  mode: EditorMode
  tool: EditorTool
  /** 当前地形 ID（内置 9 种之一，或用户自定义的 `custom:xxx`） */
  terrainType: TerrainId
  markerIcon: MarkerIcon
  pathType: PathType
  regionColor: string
  brushRadius: number
  undo: number
  redo: number
  painting: boolean
  /** 当前笔画已覆盖的格数（工具栏可显示） */
  strokeCells: number
  /** 进行中的草稿顶点数（0 = 没有草稿） */
  draftPoints: number
  /** 路径/区域的几何模式（工具栏据此高亮） */
  geometryMode: GeometryMode
}

export class MapEditor {
  private readonly options: MapEditorOptions
  private readonly history: History

  mode: EditorMode = 'select'
  tool: EditorTool = 'brush'
  terrainType: TerrainId = 'forest'
  markerIcon: MarkerIcon = 'town'
  pathType: PathType = 'river'
  /**
   * 区域预设色下标（工具栏上点第几个色块）。
   *
   * 存下标而不是颜色：设置里改了调色板之后，**新画的区域会自动用新颜色**，
   * 不会留着一个已经过期的旧色值。已画好的区域仍然用文件里存的颜色。
   */
  regionPresetIndex = 0
  brushRadius = 0
  /**
   * 路径与区域的几何模式（用户要的"两种模式"）：
   * - `interior`：直接通过六边形内部（默认，自由折线 / 平滑曲线）；
   * - `edge`：勾勒六边形边框 —— 落点吸附到网格顶点，且顶点之间沿格边连接。
   */
  geometryMode: GeometryMode = 'interior'
  // 说明：这里**刻意没有** `showShapeLabels`。
  // "要不要显示路径/区域名称"是插件设置里的 `layers.labels`（见 layerVisibility.ts），
  // 绘制层直接读它。编辑器里再存一份，就会出现"设置里打开、按钮显示关闭"这类
  // 互相矛盾的状态 —— 同一件事只能有一个真相。

  /** 当前笔画：格键 → 笔画开始前的状态 */
  private strokePrevious: Map<string, TerrainCell | null> | null = null
  private strokeCells: Axial[] = []
  private strokeLastPoint: Point | null = null
  /** 进行中的拖动移动（标记 / 文字标注） */
  private moveState: { kind: 'marker' | 'label'; id: string; from: [number, number] } | null = null
  /** 进行中的多点草稿（路径 / 区域） */
  private draft: MapDraft | null = null

  constructor(options: MapEditorOptions) {
    this.options = options
    this.history = new History(options.historyLimit ?? 100)
  }

  getStatus(): EditorStatus {
    const size = this.history.size()
    return {
      mode: this.mode,
      tool: this.tool,
      terrainType: this.terrainType,
      markerIcon: this.markerIcon,
      pathType: this.pathType,
      regionColor: this.regionColor,
      brushRadius: this.brushRadius,
      undo: size.undo,
      redo: size.redo,
      painting: this.strokePrevious !== null,
      strokeCells: this.strokeCells.length,
      draftPoints: this.draft?.clickCount ?? 0,
      geometryMode: this.geometryMode,
    }
  }

  getPathLink(id: string): string {
    return this.options.getDocument()?.paths.find((path) => path.id === id)?.link ?? ''
  }

  setPathLink(id: string, link: string): boolean {
    const document_ = this.options.getDocument()
    const path = document_?.paths.find((item) => item.id === id)
    if (!document_ || !path || path.link === link || (path.link ?? '') === link) return false
    this.commit([{ kind: 'setPathLink', id, from: path.link ?? '', to: link }], '设置路径链接')
    return true
  }

  setTool(tool: EditorTool): void {
    if (this.tool === tool) return
    // 换工具时收尾进行中的笔画与草稿，避免"半条笔画/半个多边形"悬着
    this.cancelStroke()
    this.cancelDraft()
    this.tool = tool
    this.options.onStateChanged?.()
  }

  setPathType(type: PathType): void {    if (this.pathType === type) return
    this.pathType = type
    this.options.onStateChanged?.()
  }

  /** 当前调色板（缺省即出厂默认，见 `MapEditorOptions.getPalette`） */
  getPalette(): StylePalette {
    return this.options.getPalette?.() ?? { pathColors: defaultPathColors(), regionColors: defaultRegionColors(), fontFamily: '' }
  }

  /** 当前区域颜色：由预设下标 → 调色板解析出来（所以改设置后新区域立刻用新色） */
  get regionColor(): string {
    const list = this.getPalette().regionColors
    return normalizeColor(list[this.regionPresetIndex], resolveDefaultRegionColor(list))
  }

  setRegionColor(color: string): void {
    const palette = this.getPalette()
    const index = palette.regionColors.findIndex((item) => normalizeColor(item, '') === normalizeColor(color, ''))
    // 认不出来（例如颜色来自旧设置）就退回第一个预设，而不是把任意颜色塞进状态
    const next = index >= 0 ? index : 0
    if (this.regionPresetIndex === next) return
    this.regionPresetIndex = next
    this.options.onStateChanged?.()
  }

  /** 直接按下标选区域色（工具栏用；下标会被夹取到合法范围） */
  setRegionPresetIndex(index: number): void {
    const palette = this.getPalette()
    const clamped = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, palette.regionColors.length - 1))
    if (this.regionPresetIndex === clamped) return
    this.regionPresetIndex = clamped
    this.options.onStateChanged?.()
  }

  setMarkerIcon(icon: MarkerIcon): void {
    if (this.markerIcon === icon) return
    this.markerIcon = icon
    this.options.onStateChanged?.()
  }

  setMode(mode: EditorMode): void {
    if (this.mode === mode) return
    if (mode === 'select') {
      this.cancelStroke()
      this.cancelDraft()
    }
    this.mode = mode
    this.options.onStateChanged?.()
  }

  /**
   * 切换路径/区域的几何模式。
   *
   * 换模式时取消进行中的草稿：那一半已经按旧模式吸附过了，
   * 继续画会出现"前几个顶点沿格边、后面穿内部"的混合形状。
   */
  setGeometryMode(mode: GeometryMode): void {
    if (this.geometryMode === mode) return
    this.cancelDraft()
    this.geometryMode = mode
    this.options.onStateChanged?.()
  }

  toggleMode(): EditorMode {
    this.setMode(this.mode === 'paint' ? 'select' : 'paint')
    return this.mode
  }

  /**
   * 切换当前地形（内置或自定义都走这里 —— 编辑器只认 ID，不关心它是不是内置的）。
   *
   * 刻意**不校验** ID 是否在设置里存在：编辑器与设置层解耦，
   * 而且用户删掉一个自定义地形之后，正在用的那个 ID 也只是"画上去会显示回退样式"，
   * 不需要让编辑器在这里偷偷改掉他的选择。
   */
  setTerrainType(type: TerrainId): void {
    if (this.terrainType === type) return
    this.terrainType = type
    this.options.onStateChanged?.()
  }

  setBrushRadius(radius: number): void {
    const clamped = Math.max(0, Math.min(5, Math.floor(radius)))
    if (this.clampedRadius() === clamped) return
    this.brushRadius = clamped
    this.options.onStateChanged?.()
  }

  adjustBrushRadius(delta: number): void {
    this.setBrushRadius(this.clampedRadius() + delta)
  }

  getBrushRadius(): number {
    return this.clampedRadius()
  }

  private clampedRadius(): number {
    return Math.max(0, Math.min(5, Math.floor(this.brushRadius)))
  }

  private grid(): GridSpec | null {
    return this.options.getDocument()?.grid ?? null
  }

  // ------------------------------------------------------------ 笔画

  /** 按下：开始一条笔画 */
  beginStroke(world: Point): void {
    const grid = this.grid()
    const document_ = this.options.getDocument()
    if (!grid || !document_ || this.mode !== 'paint') return

    this.strokePrevious = new Map()
    this.strokeCells = []
    this.strokeLastPoint = null
    this.paintTo(grid, document_, world)
    this.options.onStateChanged?.()
  }

  /** 拖动：从上一点插值采样到当前点，避免快速划动断线 */
  extendStroke(world: Point): void {
    const grid = this.grid()
    const document_ = this.options.getDocument()
    if (!grid || !document_ || this.strokePrevious === null) return
    this.paintTo(grid, document_, world)
  }

  /** 抬手：把整条笔画压成一条历史并请求落盘 */
  endStroke(): void {
    const document_ = this.options.getDocument()
    const previous = this.strokePrevious
    const cells = this.strokeCells
    this.strokePrevious = null
    this.strokeCells = []
    this.strokeLastPoint = null
    if (!document_ || previous === null) {
      this.options.onStateChanged?.()
      return
    }

    const next: TerrainCell = { t: this.terrainType }
    const ops: MapOp[] = opsFromPrevious(cells, next, (q, r) => previous.get(cellKey(q, r)) ?? null)
    if (ops.length > 0) {
      this.history.push({ label: `绘制 ${ops.length} 格`, ops })
      this.options.onSaveRequested?.()
    }
    this.options.onStateChanged?.()
  }

  /** 中断笔画（切换模式、失焦）：把已画的部分作为一条历史保留 */
  cancelStroke(): void {
    if (this.strokePrevious === null) return
    this.endStroke()
  }

  private paintTo(grid: GridSpec, document_: MapDocument, world: Point): void {
    const { cells } = cellsAlongSegment(grid, this.strokeLastPoint, world, this.clampedRadius())
    this.strokeLastPoint = world

    let changed = false
    const next: TerrainCell = { t: this.terrainType }
    for (const cell of cells) {
      const key = cellKey(cell.q, cell.r)
      const previous = this.strokePrevious!
      if (!previous.has(key)) {
        // 第一次碰到这一格：记下笔画开始前的状态
        previous.set(key, document_.terrain[key] === undefined ? null : { ...document_.terrain[key]! })
        this.strokeCells.push(cell)
        document_.terrain[key] = { ...next }
        changed = true
      }
    }
    if (changed) this.options.onChanged()
  }

  // ------------------------------------------------------------ 标记与文字标注

  /**
   * 放置一个标记。
   *
   * 位置**吸附到格心**：六边形地图上标记落在格心比落在任意像素位置更符合直觉，
   * 而且顺手吸收了 `posFromEvt` 的 1 CSS px 量化误差。
   */
  addMarkerAt(world: Point, data: { label: string; icon: MarkerIcon; link?: string; desc?: string; color?: string }): string | null {
    const document_ = this.options.getDocument()
    if (!document_) return null

    // 吸附到格心：六边形地图上标记落在格心更符合直觉，也顺手吸收了 posFromEvt 的 1 CSS px 量化
    const axial = worldToAxial(document_.grid, world)
    const snapped = snapToCellCenter(document_.grid, axial.q, axial.r)

    const marker: MapMarker = {
      id: nextMarkerId(document_),
      label: data.label,
      p: [snapped.x, snapped.y],
      icon: data.icon,
    }
    if (data.link !== undefined && data.link.length > 0) marker.link = data.link
    if (data.desc !== undefined && data.desc.length > 0) marker.desc = data.desc
    if (data.color !== undefined && data.color.length > 0) marker.c = data.color

    this.commit([{ kind: 'addMarker', marker }], `添加标记「${marker.label}」`)
    return marker.id
  }

  removeMarker(id: string): boolean {
    const document_ = this.options.getDocument()
    const marker = document_?.markers.find((item) => item.id === id)
    if (!document_ || !marker) return false
    this.commit([{ kind: 'removeMarker', marker: { ...marker } }], `删除标记「${marker.label}」`)
    return true
  }

  /** 放置一个文字标注 */
  addLabelAt(world: Point, data: { text: string; size?: number; color?: string; bold?: boolean; italic?: boolean }): string | null {
    const document_ = this.options.getDocument()
    if (!document_) return null

    const label: MapLabel = { id: nextLabelId(document_), text: data.text, p: [world.x, world.y] }
    if (data.size !== undefined) label.size = data.size
    if (data.color !== undefined && data.color.length > 0) label.color = data.color
    if (data.bold === true) label.bold = true
    if (data.italic === true) label.italic = true

    this.commit([{ kind: 'addLabel', label }], `添加文字「${label.text}」`)
    return label.id
  }

  removeLabel(id: string): boolean {
    const document_ = this.options.getDocument()
    const label = document_?.labels.find((item) => item.id === id)
    if (!document_ || !label) return false
    this.commit([{ kind: 'removeLabel', label: { ...label } }], `删除文字「${label.text}」`)
    return true
  }

  // ------------------------------------------------------------ 路径与区域（多点手势）

  /**
   * 多点绘制：第一次点击定起点，之后每次点击追加顶点，
   * 双击 / 回车 / 右键结束，Esc 取消。
   *
   * 草稿只存在于编辑器内存里，**不进文档**——直到 finishDraft() 才生成一条完整的 op。
   * 这样撤销一次就能整条撤掉，也不会在绘制途中反复触发保存。
   */
  beginDraft(kind: 'path' | 'region', world: Point): void {
    if (this.mode !== 'paint') return
    const style = resolvePathStyle(this.pathType, this.getPalette().pathColors)
    // 沿格边模式下，落点先吸附到最近的网格顶点
    const start = this.snapDraftPoint(world)
    this.draft = {
      kind,
      points: [start],
      clickCount: 1,
      cursor: null,
      color: kind === 'path' ? style.color : this.regionColor,
      width: kind === 'path' ? style.width : DEFAULT_REGION_BORDER_WIDTH,
      // 预览与最终渲染保持一致（河流：平滑 + 末端变细）。
      // 沿格边模式**不做平滑**：平滑会把格边抹成曲线，正好毁掉"整洁"的目的。
      smooth: kind === 'path' && style.smooth === true && this.geometryMode === 'interior',
      taper: kind === 'path' && style.taper === true,
    }
    this.options.onChanged()
    this.options.onStateChanged?.()
  }

  addDraftPoint(world: Point): void {
    if (!this.draft) return
    const grid = this.options.getDocument()?.grid
    const target = this.snapDraftPoint(world)
    if (grid && this.geometryMode === 'edge-step') {
      // 逐边模式：只前进一条边，方向由点击位置决定
      const last = this.draft.points[this.draft.points.length - 1]!
      const previous = this.draft.points.length >= 2 ? subtract(last, this.draft.points[this.draft.points.length - 2]!) : null
      this.draft.points.push(stepAlongEdges(grid, last, world, previous).point)
    } else if (grid && this.geometryMode === 'edge') {
      // 沿格边：把"上一个顶点 → 新顶点"的整条边路都记进草稿。
      // 只记终点的话，预览里这一段仍是直线，提交后才变成格边 —— 所见非所得。
      const tail = walkTailToCursor(grid, this.draft.points[this.draft.points.length - 1]!, target)
      for (const point of tail) this.draft.points.push(point)
    } else {
      this.draft.points.push(target)
    }
    this.draft.clickCount += 1
    this.draft.cursor = null
    this.options.onChanged()
    this.options.onStateChanged?.()
  }

  updateDraftCursor(world: Point): void {
    if (!this.draft) return
    this.draft.cursor = { x: world.x, y: world.y }
    // 橡皮筋跟随：每帧都要重绘
    this.options.onChanged()
  }

  /**
   * 草稿显示用的点序列。
   *
   * 沿格边模式下，光标那一端要从最后一个顶点**沿格边走**过去（而不是一条斜线），
   * 否则预览与实际结果不一致 —— 这是本项目反复强调的"所见即所得"。
   * 显示上把走出来的那一串直接并进 points，因此 `drawDraft` 不需要任何改动。
   */
  private draftDisplayPoints(draft: MapDraft): { points: Point[]; cursor: Point | null } {
    const grid = this.options.getDocument()?.grid
    if (!grid || !draft.cursor || draft.points.length === 0 || this.geometryMode === 'interior') {
      return { points: draft.points, cursor: draft.cursor }
    }
    const last = draft.points[draft.points.length - 1]!
    if (this.geometryMode === 'edge-step') {
      // 逐边模式：预览也只显示**接下来那一条边**（点哪个方向就往哪走）
      const previous = draft.points.length >= 2 ? subtract(last, draft.points[draft.points.length - 2]!) : null
      const next = stepAlongEdges(grid, last, draft.cursor, previous).point
      return { points: [...draft.points, next], cursor: null }
    }
    const tail = walkTailToCursor(grid, last, draft.cursor)
    return { points: [...draft.points, ...tail], cursor: null }
  }

  /** 沿格边模式：吸附到最近顶点；否则原样返回 */
  private snapDraftPoint(world: Point): Point {
    const grid = this.options.getDocument()?.grid
    if (this.geometryMode === 'interior' || !grid) return { x: world.x, y: world.y }
    return snapToHexVertex(grid, world).point
  }

  /**
   * 提交前的几何转换。
   *
   * 沿格边模式下，已确定的顶点之间也要**沿格边**连接（不只是把点吸附到顶点上）——
   * 否则远距离的两个顶点之间仍是一条斜穿格子的直线。
   * 逐边模式记录的本来就是相邻顶点，这里的行走是恒等操作（不会改变形状）。
   */
  private commitGeometry(points: Point[], closed: boolean): Point[] {
    const grid = this.options.getDocument()?.grid
    if (this.geometryMode === 'interior' || !grid) return points
    return toEdgePath(grid, points, closed)
  }

  getDraft(): MapDraft | null {
    if (!this.draft) return null
    const display = this.draftDisplayPoints(this.draft)
    return { ...this.draft, points: display.points, cursor: display.cursor }
  }

  isDrafting(): boolean {
    return this.draft !== null
  }

  /** 结束当前草稿并提交为一条历史。顶点不足时放弃（不产生历史） */
  finishDraft(): { kind: 'path' | 'region'; id: string } | null {
    const draft = this.draft
    this.draft = null
    if (!draft) {
      this.options.onStateChanged?.()
      return null
    }

    const points = draft.points
    const minPoints = draft.kind === 'path' ? 2 : 3
    if (points.length < minPoints) {
      this.options.onChanged()
      this.options.onStateChanged?.()
      return null
    }

    const op = draft.kind === 'path' ? this.buildPathFrom(points) : this.buildRegionFrom(points)
    this.commit([op], draft.kind === 'path' ? '绘制路径' : '绘制区域')

    const id = op.kind === 'addPath' ? op.path.id : op.kind === 'addRegion' ? op.region.id : ''
    return id.length > 0 ? { kind: draft.kind, id } : null
  }

  /** 取消草稿（Esc / 切换工具 / 切换模式） */
  cancelDraft(): void {
    if (!this.draft) return
    this.draft = null
    this.options.onChanged()
    this.options.onStateChanged?.()
  }

  private buildPathFrom(points: Point[]): MapOp {
    const document_ = this.options.getDocument()!
    const style = resolvePathStyle(this.pathType, this.getPalette().pathColors)
    // 沿格边模式：顶点之间也要沿格边走（否则远处两点之间仍是一条斜穿格子的直线）
    const geometry = this.commitGeometry(points, false)
    const path: MapPath = {
      id: nextShapeId(document_, 'p'),
      type: this.pathType,
      pts: geometry.map((point) => [point.x, point.y] as [number, number]),
      width: style.width,
      color: style.color,
      mode: this.geometryMode,
    }
    if (style.dash) path.dash = [...style.dash]
    if (style.taper === true) path.taper = true
    // 沿格边模式不做平滑：平滑会把格边抹成曲线，正好毁掉"整洁"的目的
    if (style.smooth === true && this.geometryMode === 'interior') path.smooth = true
    return { kind: 'addPath', path }
  }

  private buildRegionFrom(points: Point[]): MapOp {
    const document_ = this.options.getDocument()!
    const geometry = this.commitGeometry(points, true)
    const region: MapRegion = {
      id: nextShapeId(document_, 'r'),
      label: '',
      pts: geometry.map((point) => [point.x, point.y] as [number, number]),
      color: this.regionColor,
      opacity: DEFAULT_REGION_OPACITY,
      borderWidth: DEFAULT_REGION_BORDER_WIDTH,
      mode: this.geometryMode,
    }
    return { kind: 'addRegion', region }
  }

  removePath(id: string): boolean {
    const document_ = this.options.getDocument()
    const path = document_?.paths.find((item) => item.id === id)
    if (!document_ || !path) return false
    this.commit([{ kind: 'removePath', path: { ...path } }], '删除路径')
    return true
  }

  /**
   * 重命名路径 / 区域。
   * 空字符串表示"不要名称"（路径会删掉 label 字段，区域置空）。
   */
  renamePath(id: string, label: string): boolean {
    const document_ = this.options.getDocument()
    const path = document_?.paths.find((item) => item.id === id)
    if (!document_ || !path) return false
    const from = path.label ?? ''
    if (from === label) return false
    this.commit([{ kind: 'renamePath', id, from, to: label }], `重命名路径「${label || from}」`)
    return true
  }

  renameRegion(id: string, label: string): boolean {
    const document_ = this.options.getDocument()
    const region = document_?.regions.find((item) => item.id === id)
    if (!document_ || !region) return false
    const from = region.label ?? ''
    if (from === label) return false
    this.commit([{ kind: 'renameRegion', id, from, to: label }], `重命名区域「${label || from}」`)
    return true
  }

  /** 读取某个形状当前的名称（弹命名框时预填） */
  getShapeLabel(hit: { kind: 'path' | 'region'; id: string }): string {
    const document_ = this.options.getDocument()
    if (!document_) return ''
    if (hit.kind === 'path') return document_.paths.find((item) => item.id === hit.id)?.label ?? ''
    return document_.regions.find((item) => item.id === hit.id)?.label ?? ''
  }

  removeRegion(id: string): boolean {
    const document_ = this.options.getDocument()
    const region = document_?.regions.find((item) => item.id === id)
    if (!document_ || !region) return false
    this.commit([{ kind: 'removeRegion', region: { ...region } }], '删除区域')
    return true
  }

  /**
   * 命中测试：找出世界坐标下最上层的路径或区域。
   *
   * 路径与区域画在同一个 canvas 上（不在 DOM 里），因此右键删除无法靠事件目标判断，
   * 只能自己做几何命中测试。绘制顺序是"区域在下、路径在上"，所以先测路径。
   *
   * 注意：路径用的是 `visiblePolyline()` —— **看得见的几何**，不是原始控制顶点。
   * 河流会被平滑成曲线，在急转弯处与折线相差几十个世界单位，
   * 用控制点做命中测试会出现"点在线上了却删不掉"。
   */
  hitTestShape(world: Point, toleranceWorld: number): { kind: 'path' | 'region'; id: string } | null {
    const document_ = this.options.getDocument()
    if (!document_) return null

    for (const path of [...document_.paths].reverse()) {
      const points = visiblePolyline(
        path.pts.map(([x, y]) => ({ x, y })),
        path.smooth === true,
      )
      if (hitTestPolyline(world, points, { width: path.width, tolerance: toleranceWorld })) {
        return { kind: 'path', id: path.id }
      }
    }
    for (const region of [...document_.regions].reverse()) {
      const points = region.pts.map(([x, y]) => ({ x, y }))
      if (hitTestPolygon(world, points)) return { kind: 'region', id: region.id }
    }
    return null
  }

  /** 把一批操作应用、入历史并请求保存（笔画之外的单步操作走这里） */
  private commit(ops: MapOp[], label: string): void {
    const document_ = this.options.getDocument()
    if (!document_) return
    for (const op of ops) applyOp(document_, op)
    this.history.push({ label, ops })
    this.options.onChanged()
    this.options.onSaveRequested?.()
    this.options.onStateChanged?.()
  }

  // ------------------------------------------------------------ 拖动移动

  /**
   * 拖动移动标记 / 文字标注。
   *
   * 与笔画同样的思路：**边拖边改文档**（实时反馈），抬手时才压成**一条**历史。
   * 因此开始时记下原位，结束时用「原位 → 最终位」生成 move op。
   */
  beginMove(kind: 'marker' | 'label', id: string): boolean {
    const document_ = this.options.getDocument()
    if (!document_) return false
    const entity =
      kind === 'marker'
        ? document_.markers.find((item) => item.id === id)
        : document_.labels.find((item) => item.id === id)
    if (!entity) return false
    this.moveState = { kind, id, from: [entity.p[0], entity.p[1]] }
    return true
  }

  /** 拖动中：实时改坐标 */
  updateMove(world: Point): void {
    const state = this.moveState
    const document_ = this.options.getDocument()
    if (!state || !document_) return
    if (state.kind === 'marker') {
      const marker = document_.markers.find((item) => item.id === state.id)
      if (marker) marker.p = [world.x, world.y]
    } else {
      const label = document_.labels.find((item) => item.id === state.id)
      if (label) label.p = [world.x, world.y]
    }
    this.options.onChanged()
  }

  /** 抬手：标记吸附回格心，并把整次拖动压成一条可撤销的历史 */
  endMove(): boolean {
    const state = this.moveState
    this.moveState = null
    const document_ = this.options.getDocument()
    if (!state || !document_) return false

    if (state.kind === 'marker') {
      const marker = document_.markers.find((item) => item.id === state.id)
      if (!marker) return false
      // 与放置保持一致：标记最终吸附到格心
      const axial = worldToAxial(document_.grid, { x: marker.p[0], y: marker.p[1] })
      const snapped = snapToCellCenter(document_.grid, axial.q, axial.r)
      marker.p = [snapped.x, snapped.y]
      return this.commitMove(state, [snapped.x, snapped.y], marker.label)
    }

    const label = document_.labels.find((item) => item.id === state.id)
    if (!label) return false
    return this.commitMove(state, [label.p[0], label.p[1]], label.text)
  }

  private commitMove(
    state: { kind: 'marker' | 'label'; id: string; from: [number, number] },
    to: [number, number],
    name: string,
  ): boolean {
    const moved = Math.hypot(to[0] - state.from[0], to[1] - state.from[1]) > 1e-6
    if (!moved) {
      // 没真的移动：不入历史（避免"点一下就多一条撤销"）
      this.options.onChanged()
      return false
    }
    const op: MapOp =
      state.kind === 'marker'
        ? { kind: 'moveMarker', id: state.id, label: name, from: state.from, to }
        : { kind: 'moveLabel', id: state.id, text: name, from: state.from, to }
    // 文档已在拖动过程中改过，这里只入历史（不再 applyOp）
    this.history.push({ label: state.kind === 'marker' ? `移动标记「${name}」` : `移动文字「${name}」`, ops: [op] })
    this.options.onChanged()
    this.options.onSaveRequested?.()
    this.options.onStateChanged?.()
    return true
  }

  /** 中断拖动：恢复到原位 */
  cancelMove(): void {
    const state = this.moveState
    this.moveState = null
    const document_ = this.options.getDocument()
    if (!state || !document_) return
    if (state.kind === 'marker') {
      const marker = document_.markers.find((item) => item.id === state.id)
      if (marker) marker.p = [state.from[0], state.from[1]]
    } else {
      const label = document_.labels.find((item) => item.id === state.id)
      if (label) label.p = [state.from[0], state.from[1]]
    }
    this.options.onChanged()
  }

  isMoving(): boolean {
    return this.moveState !== null
  }

  // ------------------------------------------------------------ 撤销 / 重做

  undo(): boolean {
    const document_ = this.options.getDocument()
    if (!document_) return false
    const entry = this.history.undo(document_)
    if (!entry) return false
    this.options.onChanged()
    this.options.onSaveRequested?.()
    this.options.onStateChanged?.()
    return true
  }

  redo(): boolean {
    const document_ = this.options.getDocument()
    if (!document_) return false
    const entry = this.history.redo(document_)
    if (!entry) return false
    this.options.onChanged()
    this.options.onSaveRequested?.()
    this.options.onStateChanged?.()
    return true
  }

  clearHistory(): void {
    this.history.clear()
    this.options.onStateChanged?.()
  }
}
