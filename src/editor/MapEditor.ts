/**
 * 地图编辑器：模式、当前地形、笔刷大小、笔画生命周期与撤销栈。
 *
 * 笔画的关键设计：**边拖边画**（用户要立刻看到），但历史只记一条。
 * 因此每条笔画维护一份「格 → 笔画开始前的状态」映射，
 * 抬手时据此生成 op 列表 —— 这样既保证实时反馈，又保证撤销一次回到笔画前。
 */

import type { Axial, GridSpec, Point } from '../core/hex.ts'
import { cellKey, parseCellKey, worldToAxial } from '../core/hex.ts'
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
  MarkerId,
  PathCapStyle,
  PathJoinStyle,
  PathType,
  RegionType,
  TerrainCell,
  TerrainId,
} from '../data/mapDocument.ts'
import { MAP_DOCUMENT_VERSION } from '../data/mapDocument.ts'
import type { MapDefinitions } from '../data/mapDocument.ts'
import { cellsAlongSegment } from './brushPath.ts'
import { History, applyOp, opsFromPrevious, opsFromPreviousOf, type MapOp } from './history.ts'
import type { ElevationCalibration } from '../render/elevationUnits.ts'
import { sameCalibration } from '../render/elevationUnits.ts'
import { sameDataDefaults, type DataDefaults } from '../render/dataDefaults.ts'
import {
  describeSelection,
  hitTestSelection,
  isCollectionKind,
  objectRecordOf,
  probeHover,
  readObjectFieldValue,
  sameObjectFieldValue,
  selectionSupports,
  SELECTION_KINDS,
  type MapSelection,
  type HoverReadout,
  type ObjectBatchInfo,
  type SelectionFieldValue,
  type SelectionInfo,
  type SelectionLabelResolvers,
} from './selection.ts'
import {
  applyRuleToSelection,
  applySelectionOperation,
  cellsInRect,
  expandSelectionByTerrain as expandByTerrain,
  intersectSelection,
  normalizeSelection,
  sameCellSelection,
  summarizeSelection,
  type CellSelection,
  type RuleApplyMode,
  type SelectionOperation,
  type SelectionSummary,
} from '../render/selectionSet.ts'
import { matchesGroup, type RuleGroup, type SelectionRuleContext } from '../render/selectionRules.ts'
import { isNumericField, OVERLAY_FIELDS, type FieldId } from '../render/overlayFields.ts'
import { nextLabelId, nextMarkerId, snapToCellCenter } from '../render/markerPlacement.ts'
import { hitTestPolygon, hitTestPolyline, shapeBounds, visiblePolyline } from '../render/shapeGeometry.ts'
import {
  DEFAULT_PATH_CAP,
  DEFAULT_PATH_JOIN,
  type PathStyle,
} from '../render/shapeStyle.ts'
import { defaultRegionColors, normalizeColor, type StylePalette } from '../render/stylePalette.ts'
import { resolveMarkerStyle, type CustomMarker } from '../render/markerCatalog.ts'
import { resolveTerrainStyle, type CustomTerrain } from '../render/terrainCatalog.ts'
import {
  defaultPathTypeEntries,
  pathColorsFromEntries,
  pathTypeLabelOf,
  resolvedPathStyle,
  type PathTypeEntry,
} from '../render/pathTypeCatalog.ts'
import {
  defaultRegionTypeEntries,
  defaultRegionTypeId,
  isBuiltinRegionType,
  regionTypeLabelOf,
  resolvedRegionStyle,
  type RegionTypeEntry,
  type ResolvedRegionStyle,
} from '../render/regionTypeCatalog.ts'

/**
 * 数值图层笔刷的**逐格算法**（施工文件 §E 那张表的唯一实现）。
 *
 * 返回 `undefined` = **这一格不动**。三种"不动"：
 * - `× / ÷` 遇到没有值的格（拿"没量过"去乘没有意义）；
 * - 结果不是有限数（`÷ 0` 已在 `brushReadiness` 整笔拦下，这里是最后一道保险）；
 * - 上游已经有"值相同就不动"的判断。
 *
 * `+ / −` 的**无值格从 `fallback`（每格默认值）起算，没有就 0**：
 * 这是刻意行为（§E 写明"会把默认值固化进这一格"），所以 UI 上必须说明 —— 见 `MapPanel`/工具条。
 */
function applyBrushOp(
  op: BrushOp,
  previous: number | undefined,
  value: number,
  fallback: number | undefined,
): number | undefined {
  if (op === 'set') return Number.isFinite(value) ? value : undefined
  if (op === '×' || op === '÷') {
    if (previous === undefined) return undefined
    const next = op === '×' ? previous * value : previous / value
    return Number.isFinite(next) ? next : undefined
  }
  const base = previous ?? fallback ?? 0
  const next = op === '+' ? base + value : base - value
  return Number.isFinite(next) ? next : undefined
}

/** 地图级"每格默认值"里这个字段的兜底值（没有 / 不是有限数 → `undefined`） */
function defaultValueOf(defaults: DataDefaults | null, key: string): number | undefined {
  const value = defaults?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 选中项比较：同 kind 同 id 才算没变（`null` 与 `null` 相等） */
function sameSelection(a: MapSelection | null, b: MapSelection | null): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.id === b.id
}

/**
 * 把任意一串选中项收敛成**合法**的对象选择（§2.6 的两条边界）。
 *
 * - **去重**（同一个对象不可能被选两次）；
 * - **只留第一项那一类**：异类混选的字段体系不同源（标记没有线宽、路径没有图标），
 *   交集的字段常为空 ⇒ 一屏用不了的控件。用户 m01902 授权的也只是"**同类**多对象选择"。
 *
 * 归一化放在这一层而不是"靠调用方自觉"：下游（侧栏、批量动作、高亮）全都按
 * "这些选中项同类"来写，一旦有一条混合的漏进来，那些地方就会各自出怪相。
 */
function normalizeObjectSelection(list: readonly MapSelection[]): MapSelection[] {
  const out: MapSelection[] = []
  let kind: MapSelection['kind'] | null = null
  for (const item of list) {
    if (kind === null) kind = item.kind
    else if (item.kind !== kind) continue
    if (out.some((existing) => sameSelection(existing, item))) continue
    out.push(item)
  }
  return out
}

/** 两个对象选择是否相同（有序比较：顺序决定"第一个 = 检查器正在看的那一个"） */
function sameObjectSelection(a: readonly MapSelection[], b: readonly MapSelection[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => sameSelection(item, b[index] ?? null))
}

/** 当前链接（`null` = 找不到该对象） */
function currentLinkOf(document_: MapDocument, selection: MapSelection): string | null {
  switch (selection.kind) {
    case 'marker':
      return document_.markers.find((item) => item.id === selection.id)?.link ?? null
    case 'label':
      return document_.labels.find((item) => item.id === selection.id)?.link ?? null
    case 'path':
      return document_.paths.find((item) => item.id === selection.id)?.link ?? null
    case 'region':
      return document_.regions.find((item) => item.id === selection.id)?.link ?? null
    case 'cell':
      return null
  }
}

/**
 * 多个对象在某个键上的**共同值**（读原始记录，所以"没有这个键"与"空串"分得开）。
 *
 * 各不相同 → `null`：面板据此留空并写明"各不相同"，**不猜一个共同值**
 * （猜了以后一提交就把一半对象改成错的 —— 与 §C.5 那条同一个理由）。
 */
function commonFieldValue(
  document_: MapDocument,
  items: readonly MapSelection[],
  field: string | null,
): string | null {
  if (field === null || items.length === 0) return null
  let value: string | null = null
  for (const item of items) {
    const record = objectRecordOf(document_, item.kind, item.id)
    if (record === null) return null
    const raw = record[field]
    const text = typeof raw === 'string' ? raw : ''
    if (value === null) value = text
    else if (value !== text) return null
  }
  return value
}

/** 当前名称（地块没有名字 → `null`） */
function currentNameOf(document_: MapDocument, selection: MapSelection): string | null {
  switch (selection.kind) {
    case 'marker':
      return document_.markers.find((item) => item.id === selection.id)?.label ?? null
    case 'label':
      return document_.labels.find((item) => item.id === selection.id)?.text ?? null
    case 'path':
      return document_.paths.find((item) => item.id === selection.id)?.label ?? ''
    case 'region':
      return document_.regions.find((item) => item.id === selection.id)?.label ?? null
    case 'cell':
      return null
  }
}

/** 路径/区域 id：与标记共用"避开已用 id"的策略 */
function nextShapeId(document_: MapDocument, prefix: string): string {  const used = new Set<string>([
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

/**
 * 选择模式下"左键拖动"的两种含义（施工文件 §C.1 / §C.3 第 2、3 条）。
 *
 * - `rect`：拉出一个矩形，收"格心落在矩形里"的格；
 * - `brush`：沿笔迹圈选（复用笔刷的采样口径 `cellsAlongSegment`，笔迹扫过哪些格就选哪些格）。
 *
 * 两者都是"左键拖动"，所以必须有一个可选的状态来区分 —— 而不是靠修饰键
 * （修饰键已经被"加选 / 取消"占用，§C.1 那张表里写死了）。
 */
export type SelectionMode = 'rect' | 'brush'

/**
 * 数值图层笔刷的算法（施工文件 §E）。
 *
 * `set` 是给**分类字段**（生物群系）与"我想直接写这个数"用的；`+ - × ÷` 只对数值字段成立
 * （对分类 ID 做乘法是没有意义的）。
 */
export type BrushOp = 'set' | '+' | '-' | '×' | '÷'

/** 这条算法要不要一个"当前值"（`set` 也要 —— 它就是"设成这个数 / 这个 ID"） */
export const BRUSH_OPS_FOR_NUMERIC: readonly BrushOp[] = ['set', '+', '-', '×', '÷']

/** 笔刷能不能作画的结果：不能时**必须给一句人话**（状态条要显示它，§E 第 2 条） */
export type BrushReadiness = { ok: true } | { ok: false; reason: string }

/** 进行中的多点多边形/折线（还没提交到文档） */
export interface MapDraft {
  kind: 'path' | 'region'
  /**
   * 已确定的顶点（世界坐标）。
   *
   * ⚠️ 沿网格线模式下，这里存的是**走出来的整条边路**（含中间顶点），不是点击数：
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
  /**
   * 端点 / 连接样式（预览用）。
   *
   * 同 `smooth` / `taper`：预览必须与提交后的渲染一致 ——
   * 选的类型是"平头端点"却在预览里画成圆头，松手一变又是一次"所见非所得"。
   */
  cap: PathCapStyle
  join: PathJoinStyle
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
  /**
   * 当前生效的**路径类型目录**（来自插件设置）—— 路径样式的唯一来源。
   *
   * 与 `getPalette` 分开是因为它同时管内置与自定义类型（颜色 + 线宽 + 虚线 + 端点 + 连接），
   * 而 `getPalette` 只剩下区域颜色与字体还在用。缺省 = 出厂目录。
   */
  getPathTypes?: () => readonly PathTypeEntry[]
  /**
   * 当前生效的**区域类型目录**（来自插件设置）—— 区域样式的唯一来源。
   *
   * 与 `getPathTypes` 完全同构：内置 6 种 + 自定义类型，参数（填充色/不透明度/边框…）
   * 都从目录取。缺省 = 出厂目录。
   */
  getRegionTypes?: () => readonly RegionTypeEntry[]
  /**
   * 自定义地形 / 自定义标记目录（只为检查器显示人话名称用）。
   *
   * 与上面几个同理：现读。缺省 = 空（检查器会退回显示裸 ID，但不会崩）。
   */
  getCustomTerrains?: () => readonly CustomTerrain[]
  getCustomMarkers?: () => readonly CustomMarker[]
  /** 选中项变化（侧栏检查器据此重绘；覆盖层据此重画高亮） */
  onSelectionChanged?: () => void
  historyLimit?: number
}

export interface EditorStatus {
  mode: EditorMode
  tool: EditorTool
  /** 当前地形 ID（内置 9 种之一，或用户自定义的 `custom:xxx`） */
  terrainType: TerrainId
  /** 当前标记图标（内置 9 种之一，或用户自定义的 `custom:xxx`） */
  markerIcon: MarkerId
  pathType: PathType
  /** 当前区域类型 ID（内置 `realm`… 或自定义 `custom:xxx`）—— 新画的区域用它 */
  regionType: RegionType
  /**
   * 当前区域类型的填充色（保留给旧调用方）。
   *
   * 它是 `regionType` 的**派生值**，不是第二份状态：改设置里的颜色后新区域立刻用新色，
   * 而已经画好的区域仍用文件里存的值。
   */
  regionColor: string
  brushRadius: number
  undo: number
  redo: number
  painting: boolean
  /** 当前笔画已覆盖的格数（工具栏可显示） */
  strokeCells: number
  /** 进行中的草稿顶点数（0 = 没有草稿） */
  draftPoints: number
  /** 路径/区域的绘制模式（工具栏据此高亮） */
  geometryMode: GeometryMode
  /** 当前选中的对象（`null` = 没选中）—— 侧栏检查器与高亮都读它 */
  selection: MapSelection | null
  /**
   * 当前选中的**全部对象**（同类多选，§2.6）。
   *
   * 与 `selection` 的关系：`selection` 是它的第一项（"检查器正在编辑的那一个"），
   * 保留它是为了下游与既有断言不必都学会"一群对象"这件事。
   * 高亮与侧栏多选形态都读这一项；长度 ≤ 1 时两者含义完全一样。
   */
  objectSelection: MapSelection[]
  /**
   * 当前**格选择**（有序去重的格键）。
   *
   * 与 `selection` 并存：`selection` 是"侧栏检查器在编辑哪一个对象"（单选），
   * 它是"我正在看哪些格"（可多格）。两者在恰好一格时重合（见 `setCellSelection`）。
   */
  cellSelection: CellSelection
  /** 选择模式下左键拖动是矩形框选还是笔迹框选 */
  selectionMode: SelectionMode
  /** 笔刷作用的**字段**：`null` = 地形（既有行为），否则是数值图层字段（§E） */
  brushField: FieldId | null
  /** 数值字段的算法（对分类字段恒为 `set`） */
  brushOp: BrushOp
  /** 数值字段的当前值（`null` = 还没填 → 笔刷不生效，状态条写明原因） */
  brushValue: number | null
  /**
   * 这个值**确认过**没有（§E 第 3 条："不静默沿用"）。
   *
   * 换字段 / 换算法 / 换地形时回到 `false`：数字**保留**（不用重打），但笔刷要等一次"确认"
   * （回车或失焦）才生效 —— 于是"换到温度层，笔上还带着上一次深度用的 +200"这种事故不会发生。
   */
  brushValueConfirmed: boolean
  /** 生物群系笔刷要设的 ID（只有 `brushField === 'biome'` 时用） */
  brushBiome: string
  /** 这个笔刷现在能不能作画（不能时给原因，见 §E 第 2 条） */
  brushReady: BrushReadiness
}

export class MapEditor {
  private readonly options: MapEditorOptions
  private readonly history: History

  mode: EditorMode = 'select'
  tool: EditorTool = 'brush'
  terrainType: TerrainId = 'forest'
  markerIcon: MarkerId = 'town'
  pathType: PathType = 'river'
  /**
   * 区域类型（工具条下拉里选的那一个）。
   *
   * 存**类型 ID** 而不是颜色/不透明度等数值：设置里改了某个类型的参数之后，
   * **新画的区域会自动用新参数**，不会留着一组已经过期的旧值。
   * 已画好的区域仍然用文件里存的参数（见 `buildRegionFrom`）。
   */
  regionType: RegionType = defaultRegionTypeId()
  brushRadius = 0
  /**
   * 路径与区域的绘制模式（用户要的"两种模式"）：
   * - `interior`：直接通过六边形内部（默认，自由折线 / 平滑曲线）；
   * - `edge`：勾勒六边形边框 —— 落点吸附到网格顶点，且顶点之间沿网格线连接。
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
  /**
   * 数值图层笔刷的状态（§E）。**字段为 `null` 时走既有的地形笔刷**（一行都不改）。
   */
  brushField: FieldId | null = null
  brushOp: BrushOp = 'set'
  brushValue: number | null = null
  brushValueConfirmed = false
  brushBiome = ''
  /**
   * 当前选中的**对象选择**（可多个同类）。
   *
   * 刻意**不**进历史栈：选中是"看哪里"，不是对文档的修改 ——
   * 撤销一次却把选中也换掉，用户会觉得 Ctrl+Z"撤歪了"。
   *
   * 这是对象选择的**唯一真相**；`getSelection()` 返回的是它的第一项（派生值，
   * 供"只认识一个对象"的下游与既有断言使用）。
   */
  private objectSelection: MapSelection[] = []
  /**
   * 格选择（多格）。**同样不进撤销栈**（施工文件 §C.3：撤销/重做、切画布、重载地图后
   * **按 key 保留**选择）——所以它只活在这里，不产生 op，也不碰 history。
   */
  private cellSelection: CellSelection = []
  /** 选择模式下左键拖动是矩形框选还是笔迹框选（默认矩形） */
  selectionMode: SelectionMode = 'rect'
  /** 进行中的框选手势（矩形起点 / 笔迹上一点 / 按下时的原选择 / 修饰键决定的集合运算） */
  private cellDrag: {
    mode: SelectionMode
    operation: SelectionOperation
    start: Point
    last: Point
    base: CellSelection
    /** 笔迹模式已扫过的格（累积，抬手才算完） */
    brushKeys: string[]
    moved: boolean
  } | null = null
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
      regionType: this.regionType,
      regionColor: this.regionColor,
      brushRadius: this.brushRadius,
      undo: size.undo,
      redo: size.redo,
      painting: this.strokePrevious !== null,
      strokeCells: this.strokeCells.length,
      draftPoints: this.draft?.clickCount ?? 0,
      geometryMode: this.geometryMode,
      selection: this.getSelection(),
      objectSelection: this.objectSelection,
      cellSelection: this.cellSelection,
      selectionMode: this.selectionMode,
      brushField: this.brushField,
      brushOp: this.brushOp,
      brushValue: this.brushValue,
      brushValueConfirmed: this.brushValueConfirmed,
      brushBiome: this.brushBiome,
      brushReady: this.brushReadiness(),
    }
  }

  // ------------------------------------------------- 数值图层笔刷（§E）

  /**
   * 换笔刷作用的字段。`null` = 回地形笔刷。
   *
   * ⚠️ 换字段时把"确认过没有"**打回未确认**（§E 第 3 条）：值保留（不用重打），
   * 但笔刷要等一次回车 / 失焦才生效 —— 否则"换到温度层，笔上还带着上一次给深度填的 +200"。
   */
  setBrushField(field: FieldId | null): void {
    if (this.brushField === field) return
    this.cancelStroke()
    this.brushField = field
    // 分类字段只有 `set`（对分类 ID 做加减乘除没有意义）
    if (field !== null && !this.brushFieldIsNumeric()) this.brushOp = 'set'
    this.brushValueConfirmed = false
    this.options.onStateChanged?.()
  }

  /** 换算法（＋ − × ÷ / 设为）：同样打回未确认 */
  setBrushOp(op: BrushOp): void {
    if (this.brushOp === op) return
    this.cancelStroke()
    this.brushOp = op
    this.brushValueConfirmed = false
    this.options.onStateChanged?.()
  }

  /**
   * 填笔刷的数值。
   *
   * `null` = 留空（笔刷**不生效**，状态条会说"请先填一个数值"）。
   * 传一个有限数 = **确认**（§E：回车或失焦即确认）；非有限数一律当作"没填"。
   */
  setBrushValue(value: number | null): void {
    const next = value !== null && Number.isFinite(value) ? value : null
    if (this.brushValue === next && next !== null) {
      // 同一个数再确认一次（用户回车）也要把"未确认"变成"已确认"
      if (!this.brushValueConfirmed) {
        this.brushValueConfirmed = true
        this.options.onStateChanged?.()
      }
      return
    }
    this.cancelStroke()
    this.brushValue = next
    this.brushValueConfirmed = next !== null
    this.options.onStateChanged?.()
  }

  /** 生物群系笔刷要设的 ID（空串 = 还没选，笔刷不生效） */
  setBrushBiome(id: string): void {
    if (this.brushBiome === id) return
    this.cancelStroke()
    this.brushBiome = id
    this.brushValueConfirmed = id.length > 0
    this.options.onStateChanged?.()
  }

  /** 非地形的笔刷就是"数值图层笔刷"（§E 的那一套） */
  isFieldBrush(): boolean {
    return this.brushField !== null
  }

  private brushFieldIsNumeric(): boolean {
    const field = this.brushField
    if (field === null) return false
    const spec = OVERLAY_FIELDS.find((candidate) => candidate.id === field)
    return spec !== undefined && isNumericField(spec)
  }

  /**
   * 这个笔刷现在能不能作画（§E 第 2 条）。
   *
   * 三种"不能"各有各的话：没填数值 / 没选群系 / 除以 0。
   * 状态条直接把 `reason` 显示出来 —— 用户不该靠猜"为什么刷不动"。
   */
  brushReadiness(): BrushReadiness {
    const field = this.brushField
    if (field === null) return { ok: true }
    if (!this.brushFieldIsNumeric()) {
      return this.brushBiome.length > 0 ? { ok: true } : { ok: false, reason: '请先选一个生物群系' }
    }
    if (this.brushValue === null) return { ok: false, reason: '请先填一个数值' }
    if (!this.brushValueConfirmed) return { ok: false, reason: '按回车确认这个数值后笔刷才生效' }
    if (this.brushOp === '÷' && this.brushValue === 0) return { ok: false, reason: '不能除以 0' }
    return { ok: true }
  }

  // ---------------------------------------------------------------- 选中

  getSelection(): MapSelection | null {
    return this.objectSelection[0] ?? null
  }

  /** 当前选中的**全部**对象（同类多选；见 `setObjectSelection` 的归一化规则） */
  getObjectSelection(): MapSelection[] {
    return this.objectSelection
  }

  /**
   * 选中某个对象；传入 `null` = 清空。这是**单选语义**（等价于"只选它"）。
   *
   * 返回是否真的变了：调用方（交互层）据此决定要不要重绘 —— 每次点击都重绘会让
   * 平移画布时白白多画一帧。
   */
  setSelection(selection: MapSelection | null): boolean {
    return this.setObjectSelection(selection === null ? [] : [selection])
  }

  /**
   * 设置**对象选择**（可多个同类）。对象选择的唯一写入口。
   *
   * 三条硬边界（§2.6「批量编辑三形态」· 用户 m01902 授权"同类多对象选择"之后就定死了）：
   * - **只允许同类**：异类混选的字段体系不同源 ⇒ 这里按第一项归一化（`normalizeObjectSelection`）；
   * - **对象与格永不同时非空**：选了对象就清空格选择（选 ≥2 格时反过来清对象，见 `setCellSelection`）；
   * - **顺序有意义**：第一项就是"检查器正在编辑的那一个"（`getSelection()` 取它）。
   */
  setObjectSelection(list: readonly MapSelection[]): boolean {
    const normalized = normalizeObjectSelection(list)
    if (sameObjectSelection(this.objectSelection, normalized)) return false
    this.objectSelection = normalized
    // 对象与格**不同时非空**（§2.6）。注意"对象"得排除地块本身：选一格时对象选中与格选择
    // 本来就重合（见 `setCellSelection`），在这里清掉会让单格选择当场消失、信息卡变空。
    if (normalized.length > 0 && normalized[0]!.kind !== 'cell') this.cellSelection = []
    this.notifySelectionChanged()
    return true
  }

  /** 选中变了：侧栏检查器与覆盖层高亮都靠它重画（对象选中与格选择共用这一条通知） */
  private notifySelectionChanged(): void {
    if (this.options.onSelectionChanged) this.options.onSelectionChanged()
    else this.options.onChanged()
    this.options.onStateChanged?.()
  }

  clearSelection(): boolean {
    return this.setSelection(null)
  }

  /**
   * 按命中顺序选中"这一点下面的对象"：标记 → 名称 → 路径/区域 → 有地形的地块。
   *
   * 形状的几何命中复用 `hitTestShape`（与右键删除、双击改名**同一套**判定），
   * 绝不在这里再写一份 —— 两套命中会立刻分叉成"右键能删、左键选不中"。
   */
  selectAt(world: Point, toleranceWorld: number): boolean {
    const document_ = this.options.getDocument()
    const grid = this.grid()
    if (!document_ || !grid) return false
    const hit = hitTestSelection({
      document: document_,
      grid,
      world,
      toleranceWorld,
      hitShape: (point, tolerance) => this.hitTestShape(point, tolerance),
    })
    return this.setSelection(hit)
  }

  /**
   * 悬停时"指针下面是什么"（§2.6：**命中对象报对象名**，否则报格读数）。
   *
   * 与 `selectAt` 共用同一套命中（`hitTestSelection` + 注入的形状命中），
   * 所以"悬停看到什么"与"点下去选中什么"永远一致。
   * 读数**不进任何状态**：它只活在这一帧的返回值里，谁要显示谁拿着（面板 / 信息卡都不该存它）。
   */
  probeHoverAt(world: Point, toleranceWorld: number): HoverReadout {
    const document_ = this.options.getDocument()
    const grid = this.grid()
    if (!document_ || !grid) return { kind: 'none' }
    return probeHover(
      {
        document: document_,
        grid,
        world,
        toleranceWorld,
        hitShape: (point, tolerance) => this.hitTestShape(point, tolerance),
      },
      this.labelResolvers(),
    )
  }

  /**
   * Shift / Alt 的**单击形态**（对象版）：把"这一点下面的对象"并入 / 移出**对象选择**。
   *
   * 返回 `false` 表示**这一击不该由对象接管**（命中是地块或空处）—— 调用方据此回退到
   * 既有的"格"语义（Shift 加选一格 / Alt 取消一格，§C.1 早就定好的手感，不能因为这一轮丢掉）。
   *
   * 三条口径：
   * - **只并同类**：`base` 只在"已有同类选中"时才作为底（不同类 = 从头开始选这一类，
   *   与 `normalizeObjectSelection` 同一条边界）；
   * - **已经在里面就不再"加"**：Shift 点第二次不会把顺序打乱（顺序有意义：第一项是检查器在读的那个）；
   * - **Alt 移出**：从选择里删掉它（选择不进撤销栈，所以这不是"删除对象"）。
   */
  toggleObjectAt(world: Point, toleranceWorld: number, operation: SelectionOperation): boolean {
    const document_ = this.options.getDocument()
    const grid = this.grid()
    if (!document_ || !grid) return false
    const hit = hitTestSelection({
      document: document_,
      grid,
      world,
      toleranceWorld,
      hitShape: (point, tolerance) => this.hitTestShape(point, tolerance),
    })
    if (hit === null || hit.kind === 'cell') return false
    if (operation === 'replace') return this.setSelection(hit)
    if (operation === 'remove') {
      return this.setObjectSelection(this.objectSelection.filter((item) => !sameSelection(item, hit)))
    }
    const sameKind = this.objectSelection.some((item) => item.kind === hit.kind)
    const base = sameKind ? this.objectSelection : []
    if (base.some((item) => sameSelection(item, hit))) return false
    return this.setObjectSelection([...base, hit])
  }

  // ------------------------------------------------- 格选择（多格；施工文件 §C）

  getCellSelection(): CellSelection {
    return this.cellSelection
  }

  /** 有没有任何选择（对象或格）—— Esc 的第一步与"清空"按钮据此判断 */
  hasSelection(): boolean {
    return this.objectSelection.length > 0 || this.cellSelection.length > 0
  }

  /**
   * 直接替换格选择，**不同步对象选中**（同步的规则见 `setCellSelection`）。
   *
   * 返回是否真的变了：框选拖动时每帧都会调用它，没变就不该重绘。
   */
  private assignCellSelection(next: CellSelection): boolean {
    if (sameCellSelection(this.cellSelection, next)) return false
    this.cellSelection = next
    this.notifySelectionChanged()
    return true
  }

  /**
   * 设置格选择（侧栏 / 规则筛选 / 连通扩展都走它）。
   *
   * 顺带把**对象选中**对齐到格选择，让侧栏检查器有确定的含义：
   * - 恰好 1 格 → 选中该格（检查器显示它的字段）；
   * - 多格 → 清掉对象选中（侧栏改显「整批编辑」，见 §C.5）；
   * - 0 格 → **不动**对象选中（用户可能刚点中一个标记；清空走 `clearAllSelection`）。
   */
  setCellSelection(keys: readonly string[]): boolean {
    const next = normalizeSelection(keys)
    const changed = this.assignCellSelection(next)
    if (next.length === 1) {
      const only = next[0]!
      // 只有"这一格真的在地图里"才同步对象选中，否则检查器会指向一个不存在的对象
      const exists = this.options.getDocument()?.terrain[only] !== undefined
      return this.setSelection(exists ? { kind: 'cell', id: only } : null) || changed
    }
    if (next.length > 1) return this.setSelection(null) || changed
    return changed
  }

  clearCellSelection(): boolean {
    return this.assignCellSelection([])
  }

  /** 一键清空（对象 + 格）：Esc 的第一步、卡片/面板上的"清空选择" */
  clearAllSelection(): boolean {
    const cells = this.assignCellSelection([])
    const object = this.setSelection(null)
    return cells || object
  }

  /** 切换到矩形框选 / 笔迹框选（§C.3 第 2、3 条） */
  setSelectionMode(mode: SelectionMode): void {
    if (this.selectionMode === mode) return
    this.cancelCellDrag()
    this.selectionMode = mode
    this.options.onStateChanged?.()
  }

  /** 这一点属于哪一格（只做坐标换算，不看文档里有没有这一格） */
  cellKeyAt(world: Point): string | null {
    const grid = this.grid()
    if (!grid) return null
    const axial = worldToAxial(grid, world)
    return cellKey(axial.q, axial.r)
  }

  /**
   * 选择模式下"点一下"的完整语义：先按命中顺序选中**对象**（既有行为：标记 → 名称 → 形状 → 地块），
   * 命中地块时把它设为**唯一的**格选择；命中别的对象或空处则清空格选择。
   */
  selectAtPoint(world: Point, toleranceWorld: number): boolean {
    const changedObject = this.selectAt(world, toleranceWorld)
    const hit = this.getSelection()
    const changedCells = this.assignCellSelection(hit !== null && hit.kind === 'cell' ? [hit.id] : [])
    return changedObject || changedCells
  }

  /** Shift / Alt 的**单击**形态：把"这一格"并入选择 / 移出选择（不是拖动） */
  toggleCellAt(world: Point, operation: SelectionOperation): boolean {
    const key = this.cellKeyAt(world)
    if (key === null) return false
    if (this.options.getDocument()?.terrain[key] === undefined) return false
    return this.setCellSelection(applySelectionOperation(this.cellSelection, [key], operation))
  }

  // ---- 拖动框选（矩形 / 笔迹）：手势状态住在编辑器里，交互层只转发生命周期 ----

  /**
   * 按下开始框选。`operation` 由修饰键决定（`Shift` 加选 / `Alt` 取消 / 默认替换）。
   *
   * 为什么手势状态不放在交互层：笔迹框选要复用 `cellsAlongSegment`（笔刷那一套采样口径），
   * 而它住在编辑器里；放到交互层就得把采样几何再写一遍 —— 那是两份一定会漂移的几何。
   */
  beginCellDrag(world: Point, operation: SelectionOperation): void {
    this.cellDrag = {
      mode: this.selectionMode,
      operation,
      start: { x: world.x, y: world.y },
      last: { x: world.x, y: world.y },
      // 按下时的原选择：加选 / 移出都以它为底（拖动中反复重算，避免把自己越叠越多）
      base: this.cellSelection,
      brushKeys: [],
      moved: false,
    }
  }

  isCellDragging(): boolean {
    return this.cellDrag !== null
  }

  /**
   * 拖动中：重算框选范围内的格并更新选择。返回是否真的变了。
   *
   * ⚠️ **"算不算拖动"由交互层按屏幕像素判定**（客户端坐标，4 px 阈值）：世界坐标里
   * 一个格宽是 40 世界单位，阈值换算会随缩放漂移 —— 那是"手感"的事，只该由屏幕像素说话。
   */
  updateCellDrag(world: Point): boolean {
    const drag = this.cellDrag
    const document_ = this.options.getDocument()
    if (!drag || !document_) return false
    const grid = document_.grid
    drag.moved = true

    let keys: readonly string[]
    if (drag.mode === 'brush') {
      const { cells } = cellsAlongSegment(grid, drag.last, world, this.clampedRadius())
      for (const cell of cells) {
        const key = cellKey(cell.q, cell.r)
        if (document_.terrain[key] === undefined) continue
        if (!drag.brushKeys.includes(key)) drag.brushKeys.push(key)
      }
      keys = drag.brushKeys
    } else {
      keys = cellsInRect(document_, grid, drag.start, world)
    }
    drag.last = { x: world.x, y: world.y }
    return this.assignCellSelection(applySelectionOperation(drag.base, keys, drag.operation))
  }

  /** 抬手：结束框选。返回这次手势**是否拖动过**（没拖动 = 点击，交互层改走单击语义） */
  endCellDrag(): boolean {
    const drag = this.cellDrag
    this.cellDrag = null
    /**
     * ⚠️ 必须通知一次状态变化：**卡片的"只做进行中的事"判据就是 `isCellDragging()`**
     * （抬手之后那份统计归侧栏）。而拖动中最后一次 `updateCellDrag` 很可能**没有改变选择**
     * （格数没变 ⇒ `assignCellSelection` 返回 false ⇒ 不通知），这时如果这里也不通知，
     * 侧栏就不会重绘 —— 表现是"框选完抬手，统计既不在卡片上、也不在侧栏里"（用户实测报的）。
     */
    this.options.onStateChanged?.()
    return drag?.moved === true
  }

  cancelCellDrag(): void {
    this.cellDrag = null
  }

  // ---- 规则筛选与连通扩展（§C.2 / §C.3 第 5–9 条）：逻辑全在纯函数里，这里只做接线 ----

  /** 把一组规则应用到选择（替换 / 并入 / 移出）。返回应用后的格数 */
  applySelectionRule(group: RuleGroup, mode: RuleApplyMode, context?: SelectionRuleContext): number {
    const document_ = this.options.getDocument()
    if (!document_) return 0
    this.setCellSelection(applyRuleToSelection(this.cellSelection, document_, group, mode, context))
    return this.cellSelection.length
  }

  /**
   * 在**当前选择内**再筛（§C.2 末尾那条）。
   *
   * "当前选择内"依赖选择本身，所以它不是逐格谓词、不能当规则 —— 这里做成动作（intersect）。
   * 返回筛选后的格数（**0 是正常结果**，卡片会显示"选择已空"，不是错误）。
   */
  filterSelectionInPlace(group: RuleGroup, context?: SelectionRuleContext): number {
    const document_ = this.options.getDocument()
    if (!document_) return 0
    const next = intersectSelection(document_, this.cellSelection, (_key, cell) => matchesGroup(cell, group, context))
    this.setCellSelection(next)
    return this.cellSelection.length
  }

  /** 以当前选择为种子，按**同地形连通**扩展（§C.3 第 9 条） */
  expandSelectionByTerrain(): number {
    const document_ = this.options.getDocument()
    if (!document_) return 0
    this.setCellSelection(expandByTerrain(document_, this.cellSelection))
    return this.cellSelection.length
  }

  /** 选择信息卡的数据源（单选 = 单格详情由 `describeCellDetails` 给，多选 = 这里的统计） */
  selectionSummary(): SelectionSummary | null {
    const document_ = this.options.getDocument()
    if (!document_ || this.cellSelection.length === 0) return null
    return summarizeSelection(document_, this.cellSelection)
  }

  // ------------------------------------------------- 整批编辑（§C.5）

  /**
   * **整批编辑**：给当前选择里的每一格写同一个字段。返回真的改了几格。
   *
   * 三条口径（§C.5 写死）：
   * 1. **一次提交 = 一条历史** —— 所有格压成一个 op 列表，Ctrl+Z 一次全部回退
   *    （逐格提交会让"撤销"变成点 N 次，那不是用户要的）；
   * 2. **只改表里声明过的字段** —— 与检查器同一个闸（见 `setSelectionField`），
   *    面板传错键名直接拒绝，而不是悄悄往用户文件里塞一个没人认识的键；
   * 3. **值相同就不产生 op** —— "整批改成 20" 里本来已经是 20 的那几格不该进历史，
   *    否则撤销栈里会出现"改了 12 格"但其实只变了 3 格的假账。
   *
   * `value === null` = **清除该字段**（删掉那个键），不是写一个 `null` 进去。
   * 生命周期上有一处要注意：选择里可能留着**地图里已经不存在**的格键（撤销 / 重载之后），
   * 那些格直接跳过 —— 数量由返回值得出，卡片上另有"N 格已不存在"那一行。
   */
  setSelectionCellsField(field: string, value: SelectionFieldValue): number {
    const document_ = this.options.getDocument()
    if (!document_ || this.cellSelection.length === 0) return 0
    const fieldSpec = SELECTION_KINDS.cell.fields.find((item) => item.field === field)
    if (fieldSpec === undefined) return 0
    if (fieldSpec.control === 'number' && typeof value === 'number' && !Number.isFinite(value)) return 0

    const ops: MapOp[] = []
    for (const key of this.cellSelection) {
      const record = objectRecordOf(document_, 'cell', key)
      if (record === null) continue
      const current = readObjectFieldValue(record, field)
      if (sameObjectFieldValue(current, value)) continue
      ops.push({ kind: 'setCellField', key, field, from: current, to: value })
    }
    if (ops.length === 0) return 0
    this.commit(ops, value === null ? `清除 ${ops.length} 格的${fieldSpec.label}` : `整批设置 ${ops.length} 格的${fieldSpec.label}`)
    return ops.length
  }

  /** 检查器要显示的那一条（找不到对象时返回 null，见 `describeSelection`） */
  selectionInfo(): SelectionInfo | null {
    const document_ = this.options.getDocument()
    if (!document_) return null
    return describeSelection(document_, this.getSelection(), this.labelResolvers())
  }

  /**
   * 「数据显示」的**多对象形态**那一段（§2.6「多个同类对象」）：`null` = 当前不是多选对象。
   *
   * 为什么在编辑器这一层算：它握着文档、目录解析（`labelResolvers`）与那张表，
   * 而面板不认识这三样（它只画）。判据与 `batchEditInfo` 一致：**只按"够不够多"**。
   */
  objectsEditInfo(): ObjectBatchInfo | null {
    const items = this.objectSelection
    if (items.length < 2) return null
    const document_ = this.options.getDocument()
    if (!document_) return null
    const spec = SELECTION_KINDS[items[0]!.kind]
    const labels = this.labelResolvers()
    const rows: Array<{ id: string; label: string; detail: string }> = []
    for (const item of items) {
      const data = spec.data(document_, item.id, labels)
      // 对象已经不在了（撤销 / 换了文档）：不列它，也不把它算进 count
      if (data === null) continue
      rows.push({ id: item.id, label: data.name.length > 0 ? data.name : spec.label, detail: data.detail })
    }
    if (rows.length < 2) return null
    return {
      count: rows.length,
      kindLabel: spec.label,
      items: rows,
      typeField: spec.typeField ?? null,
      typeSource: spec.typeSource ?? null,
      typeValue: commonFieldValue(document_, items, spec.typeField ?? null),
      link: commonFieldValue(document_, items, 'link'),
      canLink: spec.actions.includes('link'),
      canDelete: spec.actions.includes('delete'),
    }
  }

  /** 改**当前选中的全部同类对象**的类型（图标 / 路径类型 / 区域类型）：一次提交 = 一条历史 */
  setObjectsType(id: string): number {
    const kind = this.objectSelection[0]?.kind
    if (kind === undefined) return 0
    const field = SELECTION_KINDS[kind].typeField
    if (field === undefined) return 0
    return this.setObjectsField(field, id)
  }

  private labelResolvers(): SelectionLabelResolvers {
    const terrains = this.options.getCustomTerrains?.() ?? []
    const markers = this.options.getCustomMarkers?.() ?? []
    return {
      terrain: (id) => resolveTerrainStyle(id, terrains).label,
      marker: (id) => resolveMarkerStyle(id, markers).label,
      path: (id) => pathTypeLabelOf(id, this.getPathTypes()),
      region: (id) => regionTypeLabelOf(id, this.getRegionTypes()),
    }
  }

  /**
   * 给**当前选中项**改链接（检查器里那一栏）。`link` 为空串 = 清除链接。
   *
   * 走既有的历史栈（`setLink` op）：于是这次修改可撤销，且与快捷键路径共用同一套撤销机制。
   * 地块没有链接（`canLink: false`），这里直接拒绝而不是悄悄改到别处。
   */
  setSelectionLink(link: string): boolean {
    const selection = this.getSelection()
    // 能力判断**读表**：地块的动作表里没有 link，于是这里自然拒绝 —— 不写 `kind === 'cell'`
    if (selection === null || !selectionSupports(selection.kind, 'link')) return false
    // 存储形状也读表（地块在 `terrain` 映射里，不适用"按 id 找对象"的 op）
    if (!isCollectionKind(selection.kind)) return false
    const document_ = this.options.getDocument()
    if (!document_) return false
    const current = currentLinkOf(document_, selection)
    if (current === null || current === link) return false
    this.commit([{ kind: 'setLink', target: selection.kind, id: selection.id, from: current, to: link }], '设置链接')
    return true
  }

  /** 给当前选中项改名（文字标注改的是它的文字）；地块没有名字，返回 false */
  setSelectionName(name: string): boolean {
    const selection = this.getSelection()
    if (selection === null || !selectionSupports(selection.kind, 'rename')) return false
    if (!isCollectionKind(selection.kind)) return false
    const document_ = this.options.getDocument()
    if (!document_) return false
    const current = currentNameOf(document_, selection)
    if (current === null || current === name) return false
    this.commit([{ kind: 'renameObject', target: selection.kind, id: selection.id, from: current, to: name }], '重命名')
    return true
  }

  /**
   * 删除当前选中项。**复用既有的删除实现**（标记/名称/路径/区域各有自己的 remove*），
   * 不另写一套 —— 否则撤销、通知、选择清理会出现两套行为。
   */
  removeSelection(): boolean {
    const selection = this.getSelection()
    if (selection === null) return false
    const removed = ((): boolean => {
      switch (selection.kind) {
        case 'marker':
          return this.removeMarker(selection.id)
        case 'label':
          return this.removeLabel(selection.id)
        case 'path':
          return this.removePath(selection.id)
        case 'region':
          return this.removeRegion(selection.id)
        case 'cell': {
          const document_ = this.options.getDocument()
          const axial = parseCellKey(selection.id)
          if (!document_ || axial === null) return false
          const previous = document_.terrain[selection.id] ?? null
          if (previous === null) return false
          const ops = opsFromPrevious([axial], null, () => previous)
          if (ops.length === 0) return false
          this.commit(ops, '删除地块')
          return true
        }
      }
    })()
    // 删掉之后选中项指向一个不存在的对象：检查器会显示成"没有选中"，
    // 但**状态本身**也该清掉 —— 否则下一次撤销把它变回来时，选中会莫名其妙地复活
    if (removed) this.clearSelection()
    return removed
  }

  // ------------------------------------------------- 侧栏就地编辑（类型 / 位置 / 外观）

  /**
   * 改**当前选中项的类型**（标记图标 / 地形种类 / 路径类型 / 区域类型）。
   *
   * 「类型写在文件里的哪个键」不是这里写死的，而是读 `SELECTION_KINDS[kind].typeField`：
   * 以后加一种新对象（例如温度带）时，这一段不用改。
   *
   * **只改这一个字段**：颜色 / 线宽 / 虚线是对象自己的参数，改类型不许连带改它们
   * （与"改设置里的默认值只影响新对象"是同一条语义）。
   */
  setSelectionType(id: string): boolean {
    const selection = this.getSelection()
    if (selection === null) return false
    const field = SELECTION_KINDS[selection.kind].typeField
    if (field === undefined) return false
    return this.setSelectionField(field, id)
  }

  /**
   * 改当前选中项**自己的一个字段**（外观与坐标都走这里）。
   *
   * 两道闸，都是为了"别把垃圾写进用户文件"：
   * - 只允许改**表里声明过**的字段（类型字段 / 位置字段 `p` / `fields` 里列出的外观字段），
   *   面板传错键名就直接拒绝，而不是悄悄新增一个没人认识的键；
   * - 数字字段必须在**声明的**范围内（只有声明了 `min` / `max` 的类型才有范围 ——
   *   温度 / 深度这类数据字段刻意没有，见 `selection.ts` 里那段注释）；
   *   **刻意不做"悄悄夹到边界"**：夹了以后用户看到的输入
   *   与文件里的值会不一致，那是更难查的问题（历史上"输入被静默改写"已经出过一次，§5.33）。
   *
   * `value === null` = 删掉该字段（例如"清除单格叠加色"），而不是写一个 null 进去 ——
   * 文件里少一个键与多一个 `null` 是两种东西。
   */
  setSelectionField(field: string, value: SelectionFieldValue): boolean {
    const selection = this.getSelection()
    if (selection === null) return false
    const op = this.fieldOpFor(selection, field, value)
    if (op === null) return false
    const fieldSpec = SELECTION_KINDS[selection.kind].fields.find((item) => item.field === field)
    this.commit([op], `修改${fieldSpec?.label ?? '属性'}`)
    return true
  }

  /**
   * 给**当前选中的全部同类对象**写同一个字段（多选时的「图标」这类公共字段）。
   * 返回真的改了几个对象。
   *
   * 三条口径与 `setSelectionCellsField` 完全一致（那是格的版本，这是对象的版本）：
   * **一次提交 = 一条历史**、**只改表里声明过的字段**、**值相同就不产生 op**。
   *
   * 校验与 op 构造**复用 `fieldOpFor`** —— 单对象与多对象两条路走同一套闸，
   * 否则"多选能写进去一个单选拒绝的值"这种分叉迟早出现（§5.12）。
   */
  setObjectsField(field: string, value: SelectionFieldValue): number {
    const items = this.objectSelection
    if (items.length === 0) return 0
    const ops: MapOp[] = []
    for (const item of items) {
      const op = this.fieldOpFor(item, field, value)
      if (op !== null) ops.push(op)
    }
    if (ops.length === 0) return 0
    const fieldSpec = SELECTION_KINDS[items[0]!.kind].fields.find((entry) => entry.field === field)
    this.commit(ops, `整批设置 ${ops.length} 个对象的${fieldSpec?.label ?? '属性'}`)
    return ops.length
  }

  /** 给**当前选中的全部同类对象**设同一个链接（空串 = 清除）。一次提交 = 一条历史 */
  setObjectsLink(link: string): number {
    const document_ = this.options.getDocument()
    if (!document_ || this.objectSelection.length === 0) return 0
    const ops: MapOp[] = []
    for (const item of this.objectSelection) {
      if (!selectionSupports(item.kind, 'link') || !isCollectionKind(item.kind)) continue
      // ⚠️ 这里直接读记录上的 `link`，**不用** `currentLinkOf`：那一个用 `?? null` 把
      // "没有链接"与"找不到这个对象"混成了一种值，于是"给一个还没有链接的对象设链接"
      // 会被当成"对象不存在"而拒掉。多选场景（一半有链接一半没有是最常见的情形）必须分得开。
      const raw = objectRecordOf(document_, item.kind, item.id)?.link
      const from = typeof raw === 'string' ? raw : ''
      if (from === link) continue
      ops.push({ kind: 'setLink', target: item.kind, id: item.id, from, to: link })
    }
    if (ops.length === 0) return 0
    this.commit(ops, link.length === 0 ? `清除 ${ops.length} 个对象的链接` : `设置 ${ops.length} 个对象的链接`)
    return ops.length
  }

  /**
   * 删除**当前选中的全部同类对象**：一次提交 = **一条历史**（§1 第 7 条）。
   *
   * 复用既有的删除 op 形状，只是把 N 个压进同一次 `commit`：逐个调 `removeMarker` 这类
   * 会变成 N 条历史，"撤销"要点 N 次 —— 那不是用户要的（同 `setSelectionCellsField`）。
   * 这里必须按 kind 分派：**四种对象存在四个不同的数组里，op 也各有一个名字**，
   * 这是存储差异，不是能力差异（同 `moveSelectionTo` 里那段注释）。
   */
  removeObjects(): number {
    const items = this.objectSelection
    if (items.length === 0) return 0
    if (items.length === 1) return this.removeSelection() ? 1 : 0
    const document_ = this.options.getDocument()
    if (!document_) return 0
    const ops: MapOp[] = []
    for (const item of items) {
      if (item.kind === 'marker') {
        const found = document_.markers.find((entry) => entry.id === item.id)
        if (found) ops.push({ kind: 'removeMarker', marker: { ...found } })
      } else if (item.kind === 'label') {
        const found = document_.labels.find((entry) => entry.id === item.id)
        if (found) ops.push({ kind: 'removeLabel', label: { ...found } })
      } else if (item.kind === 'path') {
        const found = document_.paths.find((entry) => entry.id === item.id)
        if (found) ops.push({ kind: 'removePath', path: { ...found } })
      } else if (item.kind === 'region') {
        const found = document_.regions.find((entry) => entry.id === item.id)
        if (found) ops.push({ kind: 'removeRegion', region: { ...found } })
      }
    }
    if (ops.length === 0) return 0
    this.commit(ops, `删除 ${ops.length} 个对象`)
    // 删完选中项都指向不存在的对象：像 `removeSelection` 那样把状态也清掉
    this.setObjectSelection([])
    return ops.length
  }

  /**
   * 一个对象某个字段的写入 op（**校验 + 构造**都在这里，单对象 / 多对象共用）。
   *
   * 返回 `null` = 这次不该写（字段没声明 / 值非法 / 值没变）。
   * 单对象那条路据此**整体拒绝**；多对象那条路据此**跳过这一个对象** ——
   * 值相同的那几个本来就不该进历史（见 `setObjectsField` 的第 3 条口径）。
   */
  private fieldOpFor(selection: MapSelection, field: string, value: SelectionFieldValue): MapOp | null {
    const document_ = this.options.getDocument()
    if (!document_) return null
    const spec = SELECTION_KINDS[selection.kind]
    const positionField = spec.position === 'point' ? 'p' : null
    const fieldSpec = spec.fields.find((item) => item.field === field)
    const declared = field === spec.typeField || field === positionField || fieldSpec !== undefined
    if (!declared) return null
    if (fieldSpec !== undefined && fieldSpec.control === 'number' && typeof value === 'number') {
      // 唯一的硬约束是"**必须是有限数**"：NaN / Infinity 不是数据（它们没法被画出来，
      // 写进去只会变成别的库认不出的怪值）。
      // ⚠️ 这里**刻意不**用 `TEMP_RANGE` 那类"物理合理范围"去拦（2026-09-28 用户实机纠正）：
      // 温度 / 深度没有取值上限，"超出范围"只发生在颜色这一层（配色的 under/over 纯色 + 数值文字）。
      // 范围判定只对**声明了 min/max 的字段**生效（例如区域不透明度 0–1）——那种是真正的定义域。
      if (!Number.isFinite(value)) return null
      if (fieldSpec.min !== undefined && value < fieldSpec.min) return null
      if (fieldSpec.max !== undefined && value > fieldSpec.max) return null
    }
    const record = objectRecordOf(document_, selection.kind, selection.id)
    if (record === null) return null
    const current = readObjectFieldValue(record, field)
    if (sameObjectFieldValue(current, value)) return null
    // 存储形状决定用哪个 op（数组里的对象 vs `terrain` 映射里的一格）——依据同样来自表
    return isCollectionKind(selection.kind)
      ? { kind: 'setObjectField', target: selection.kind, id: selection.id, field, from: current, to: value }
      : { kind: 'setCellField', key: selection.id, field, from: current, to: value }
  }

  /**
   * 写回地图级的**海拔标定**（`document.elevation` 那一段）。
   *
   * `null` = 清空这一段（回到"未标定"，也就是老地图的形状）。一次提交 = **一条**历史，
   * 于是 Ctrl+Z 一次就回到原来的标定。
   *
   * 为什么不走检查器的 `setSelectionField`：标定不是"某个带 id 对象的一个字段"，
   * 而是与 `grid` 同级的顶层段（见 `mapDocument.ts`）。
   */
  setElevationCalibration(calibration: ElevationCalibration | null): boolean {
    const document_ = this.options.getDocument()
    if (!document_) return false
    const from = document_.elevation ?? null
    const to = calibration === null ? null : { ...calibration }
    if (sameCalibration(from, to)) return false
    this.commit([{ kind: 'setElevation', from, to }], to === null ? '清除海拔标定' : '设置海拔标定')
    return true
  }

  /**
   * 写回地图级的**每格默认值**（`document.dataDefaults` 那一段）。
   *
   * 与 `setElevationCalibration` 同一个形状、同一个理由：它不是"某个带 id 对象的字段"，
   * 而是与 `grid` 同级的顶层段。`null` = 清空这一段（回到"不兜底"，老地图的形状）。
   * 一次提交 = **一条**历史，Ctrl+Z 一次回到改之前。
   *
   * ⚠️ 语义上它**只影响渲染**：文件里的格一个字节都不改（真值优先，见 `dataDefaults.ts`）。
   */
  setDataDefaults(defaults: DataDefaults | null): boolean {
    const document_ = this.options.getDocument()
    if (!document_) return false
    const from = document_.dataDefaults ?? null
    const to = defaults === null ? null : { ...defaults }
    if (sameDataDefaults(from, to)) return false
    this.commit([{ kind: 'setDataDefaults', from, to }], to === null ? '清除数值图层默认值' : '设置数值图层默认值')
    return true
  }

  /**
   * 写回这张地图的**定义集**（`document.definitions` 那一段，v2 方案 B）。
   *
   * 与 `setElevationCalibration` / `setDataDefaults` 同一个形状、同一个理由：
   * 它不是"某个带 id 对象的字段"，而是与 `grid` 同级的顶层段。
   * 一次提交 = **一条**历史 ⇒ Ctrl+Z 一次就回到改之前那套定义。
   *
   * 两处与那两个不同：
   * - `block` 是**已归一化**的定义集序列化结果（由 `data/mapDefinitions.ts` 产出），
   *   编辑器**不解释**它的内容 —— 解释是 `main.ts` 那一层的事；
   * - 老图（v1）第一次改定义要**升到 v2**，所以 op 里连版本号一起记（见 `SetDefinitionsOp`）。
   */
  setDefinitions(block: MapDefinitions | null): boolean {
    const document_ = this.options.getDocument()
    if (!document_) return false
    const from = document_.definitions ?? null
    if (from === block) return false
    if (from !== null && block !== null && JSON.stringify(from) === JSON.stringify(block)) return false
    this.commit(
      [
        {
          kind: 'setDefinitions',
          from,
          fromVersion: document_.version,
          to: block,
          toVersion: block === null ? document_.version : MAP_DOCUMENT_VERSION,
        },
      ],
      '修改地图定义',
    )
    return true
  }

  /**
   * 给点对象（标记 / 名称）设坐标。
   *
   * 面板只在**回车或失焦**时调它 —— 于是"输入框里敲一串数字"是**一条**历史，
   * 而不是每敲一个字符写一次盘（一次提交 = 一条历史，见 history.ts 顶部设计）。
   */
  setSelectionPosition(x: number, y: number): boolean {
    const selection = this.getSelection()
    if (selection === null) return false
    if (SELECTION_KINDS[selection.kind].position !== 'point') return false
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    return this.setSelectionField('p', [x, y])
  }

  /**
   * 把当前选中项整体移到某个世界坐标（侧栏的「移到视口中心」用）。
   *
   * - 点对象：直接设坐标；
   * - 路径 / 区域：按**包围盒中心**平移，顶点相对位置不变，记的是位移量（撤销即取反）；
   * - 地块：不支持 —— 搬地形会牵涉单格叠加色、相邻连通与"整片铺图"的分组，
   *   那是另一件事，不该混在"调位置"里悄悄做。
   *
   * `center` 由调用方给（`main.ts` 从当前视口算），编辑器不认识视口 —— 保持这一层可单测。
   */
  moveSelectionTo(center: Point): boolean {
    const selection = this.getSelection()
    if (selection === null) return false
    const spec = SELECTION_KINDS[selection.kind]
    if (spec.position === 'point') return this.setSelectionPosition(center.x, center.y)
    if (spec.position !== 'shape') return false
    // 这一处必须按 kind 分派：路径与区域存在**两个不同的数组**里，这是存储差异不是能力差异
    if (selection.kind !== 'path' && selection.kind !== 'region') return false
    const document_ = this.options.getDocument()
    if (!document_) return false
    const shape =
      selection.kind === 'path'
        ? document_.paths.find((item) => item.id === selection.id)
        : document_.regions.find((item) => item.id === selection.id)
    if (shape === undefined || shape.pts.length === 0) return false
    const box = shapeBounds(shape.pts.map(([x, y]) => ({ x, y })))
    const dx = center.x - (box.minX + box.maxX) / 2
    const dy = center.y - (box.minY + box.maxY) / 2
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
    // 已经在中心：不产生空历史
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return false
    this.commit([{ kind: 'translateObject', target: selection.kind, id: selection.id, dx, dy }], '移到视口中心')
    return true
  }

  getPathLink(id: string): string {    return this.options.getDocument()?.paths.find((path) => path.id === id)?.link ?? ''
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
    return this.options.getPalette?.() ?? { pathColors: pathColorsFromEntries(defaultPathTypeEntries()), regionColors: defaultRegionColors(), fontFamily: '' }
  }

  /** 当前路径类型目录（缺省即出厂目录，见 `MapEditorOptions.getPathTypes`） */
  getPathTypes(): readonly PathTypeEntry[] {
    return this.options.getPathTypes?.() ?? defaultPathTypeEntries()
  }

  /** 当前路径类型的完整样式（颜色/线宽/虚线/变细/平滑/端点/连接）—— 新画的路径用它 */
  currentPathStyle(): PathStyle {
    return resolvedPathStyle(this.pathType, this.getPathTypes())
  }

  /** 当前区域类型目录（缺省即出厂目录，见 `MapEditorOptions.getRegionTypes`） */
  getRegionTypes(): readonly RegionTypeEntry[] {
    return this.options.getRegionTypes?.() ?? defaultRegionTypeEntries()
  }

  /** 当前区域类型的完整样式（填充色/不透明度/边框色/边框宽/边框虚线）—— 新画的区域用它 */
  currentRegionStyle(): ResolvedRegionStyle {
    return resolvedRegionStyle(this.regionType, this.getRegionTypes())
  }

  /** 当前区域填充色（`currentRegionStyle()` 的派生值，保留给旧调用方与状态显示） */
  get regionColor(): string {
    return this.currentRegionStyle().color
  }

  /**
   * 切换当前区域类型（内置或自定义都走这里 —— 编辑器只认 ID，不关心它是不是内置的）。
   *
   * 刻意**不校验** ID 是否存在：与 `setTerrainType` 同理，用户删掉自定义定义之后，
   * 正在用的那个 ID 只是"画上去会显示回退样式"，不需要让编辑器偷偷改掉他的选择。
   */
  setRegionType(id: RegionType): void {
    if (this.regionType === id) return
    this.regionType = id
    this.options.onStateChanged?.()
  }

  /**
   * 按颜色选区域类型 —— **旧接口**（工具条曾是"一排色块"）。
   *
   * 语义与升级前一致：在目录里找颜色相同的类型，找不到就退回第一个内置类型
   * （而不是把任意颜色塞进状态，那会让工具条高亮和实际画出来的东西对不上）。
   */
  setRegionColor(color: string): void {
    const entries = this.getRegionTypes()
    const target = normalizeColor(color, '')
    const found = entries.find((entry) => normalizeColor(entry.params.color, '') === target)
    if (found === undefined) {
      this.setRegionType(defaultRegionTypeId())
      return
    }
    this.setRegionType(found.id)
  }

  /**
   * 按**内置类型下标**选区域类型 —— 旧接口（工具栏曾经按预设下标建按钮）。
   *
   * 保留下标语义是为了不破坏既有调用方：下标与 `BUILTIN_REGION_TYPES` 一一对应，
   * 越界夹取到合法范围。
   */
  setRegionPresetIndex(index: number): void {
    const builtin = this.getRegionTypes().filter((entry) => isBuiltinRegionType(entry.id))
    if (builtin.length === 0) return
    const clamped = Math.min(Math.max(0, Math.trunc(index)), builtin.length - 1)
    this.setRegionType(builtin[clamped]!.id)
  }

  setMarkerIcon(icon: MarkerId): void {
    if (this.markerIcon === icon) return
    this.markerIcon = icon
    this.options.onStateChanged?.()
  }

  setMode(mode: EditorMode): void {
    if (this.mode === mode) return
    if (mode === 'select') {
      this.cancelStroke()
      this.cancelDraft()
    } else {
      // 进入绘制模式时清掉选中：高亮框留在画布上会与"即将画的东西"抢注意力，
      // 而且绘制模式下点画布不再有"选中"的含义（点击被绘制手势占用）。
      // **格选择一起清**：多格描边环同理，绘画时留着它只会遮住刚落笔的颜色。
      this.cancelCellDrag()
      this.cellSelection = []
      this.objectSelection = []
      if (this.options.onSelectionChanged) this.options.onSelectionChanged()
    }
    this.mode = mode
    this.options.onStateChanged?.()
  }

  /**
   * 切换路径/区域的绘制模式。
   *
   * 换模式时取消进行中的草稿：那一半已经按旧模式吸附过了，
   * 继续画会出现"前几个顶点沿网格线、后面沿格心连接"的混合形状。
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

  /**
   * 这一格画完之后应该是什么样。
   *
   * **以该格原有内容为底**，只改地形类型：格上除了 `t` 还可能有位标志、单格叠加色，
   * 以及**这一版不认识的键**（未来的温度 / 深度就挂在这些键上，见 `TerrainCell.extra`）。
   * 以前这里返回一个新建的 `{ t }`，等于整格替换 —— 未知字段会被顺手抹掉，
   * 而且"用同一种地形重刷一遍"连撤销点都不产生（完整因果见 `opsFromPreviousOf` 的注释）。
   *
   * `f` / `c` 的既有行为（重刷即重置）**刻意保持不变**：本次只修数据丢失，
   * 不顺手改用户看得见的行为。
   */
  private nextCellFor(existing: TerrainCell | null): TerrainCell {
    const next: TerrainCell = { t: this.terrainType }
    if (existing === null) return next
    /**
     * **只重置地形笔刷"拥有"的三个键**（`t` / `f` / `c` —— 重刷即重置是既有行为），
     * 其余键一律跟着走：这一版不认识的（`extra`）与后来加上的（温度 / 深度…）都算。
     *
     * 为什么用"排除法"而不是"逐个列出要保留的键"：列出法每加一个字段都要回来改一次，
     * 而漏改的后果是**静默丢数据** —— 用户重刷一遍地形，那一格的温度就没了，还留不下撤销点。
     */
    for (const [key, value] of Object.entries(existing)) {
      if (key === 't' || key === 'f' || key === 'c') continue
      if (key === 'extra') {
        next.extra = { ...(value as Record<string, unknown>) }
        continue
      }
      ;(next as Record<string, unknown>)[key] = value
    }
    return next
  }

  /** 按下：开始一条笔画 */
  beginStroke(world: Point): void {
    const grid = this.grid()
    const document_ = this.options.getDocument()
    if (!grid || !document_ || this.mode !== 'paint') return
    // 数值图层笔刷：值没填好 / 除以 0 时**不生效**（状态条会说明原因，§E 第 2 条）
    if (this.isFieldBrush() && !this.brushReadiness().ok) return

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

    // 逐格算新状态（而不是所有格共用一个新建的 `{ t }`）：格上的其它键要跟着走
    const previousOf = (q: number, r: number): TerrainCell | null => previous.get(cellKey(q, r)) ?? null
    const ops: MapOp[] = opsFromPreviousOf(cells, (q, r) => this.nextCellOnStroke(previousOf(q, r)), previousOf)
    if (ops.length > 0) {
      this.history.push({ label: this.strokeLabel(ops.length), ops })
      this.options.onSaveRequested?.()
    }
    this.options.onStateChanged?.()
  }

  /** 这一笔的历史名（数值图层笔刷要说清"刷的是哪一层、怎么刷的"） */
  private strokeLabel(count: number): string {
    const field = this.brushField
    if (field === null) return `绘制 ${count} 格`
    const spec = OVERLAY_FIELDS.find((candidate) => candidate.id === field)
    const label = spec?.label ?? field
    if (!this.brushFieldIsNumeric()) return `刷${label} ${count} 格`
    const op = this.brushOp === 'set' ? '=' : this.brushOp
    return `${label} ${op}${this.brushValue ?? 0} · ${count} 格`
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
    for (const cell of cells) {
      const key = cellKey(cell.q, cell.r)
      const previous = this.strokePrevious!
      if (!previous.has(key)) {
        // 第一次碰到这一格：记下笔画开始前的状态
        const before = document_.terrain[key]
        previous.set(key, before === undefined ? null : { ...before })
        // 以这一格原有内容为底（保留未知键），不是整格替换
        const next = this.nextCellOnStroke(before ?? null)
        // `null` = 这一格笔刷不碰它（例如 ×/÷ 遇到没有值的格）：**不进历史、也不算"划过"**
        if (next === null) continue
        this.strokeCells.push(cell)
        document_.terrain[key] = next
        changed = true
      }
    }
    if (changed) this.options.onChanged()
  }

  /**
   * 这一格被笔刷点中之后应该是什么样（施工文件 §E 的那张表）。
   *
   * - 地形笔刷（`brushField === null`）：**既有行为一字不改**（重刷即重置 `t/f/c`）；
   * - 分类字段（生物群系）：设成当前 ID；
   * - 数值字段：
   *   - `set` → 写这个数；
   *   - `+ / -` → `prev ± n`，**没有值时从"每格默认值"起算（也没有就从 0）** ——
   *     这一步会把默认值**固化进这一格**（从此不再跟随默认值），UI 上写明了这一点；
   *   - `× / ÷` → **跳过没有值的格**（`return null`）：拿"没量过"去乘没有任何意义；
   *     除以 0 在 `brushReadiness` 就拦下了（整笔不生效，而不是逐格产生 Infinity）。
   *
   * 返回 `null` = 这一格**不变**（`opsFromPreviousOf` 会把它算成"没有变化"，于是不进历史）。
   */
  private nextCellOnStroke(existing: TerrainCell | null): TerrainCell | null {
    const field = this.brushField
    if (field === null) return this.nextCellFor(existing)
    const base = existing === null ? {} : { ...existing }
    if (!this.brushFieldIsNumeric()) {
      return { ...base, biome: this.brushBiome }
    }
    const spec = OVERLAY_FIELDS.find((candidate) => candidate.id === field)
    if (spec === undefined || !isNumericField(spec)) return null
    const value = this.brushValue
    if (value === null) return null
    const previous = spec.read(existing ?? undefined)
    const fallback = defaultValueOf(this.options.getDocument()?.dataDefaults ?? null, spec.cellKey)
    const next = applyBrushOp(this.brushOp, previous, value, fallback)
    if (next === undefined) return null
    // 值相同就**不动这一格**（否则"重刷一遍温度"会产生一堆没有变化的历史）
    if (previous !== undefined && previous === next) return null
    return { ...base, [spec.cellKey]: next }
  }

  // ------------------------------------------------------------ 标记与文字标注

  /**
   * 放置一个标记。
   *
   * 位置**吸附到格心**：六边形地图上标记落在格心比落在任意像素位置更符合直觉，
   * 而且顺手吸收了 `posFromEvt` 的 1 CSS px 量化误差。
   */
  addMarkerAt(world: Point, data: { label: string; icon: MarkerId; link?: string; desc?: string; color?: string }): string | null {
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
    const style = this.currentPathStyle()
    const region = kind === 'region' ? this.currentRegionStyle() : null
    // 沿网格线模式下，落点先吸附到最近的网格顶点
    const start = this.snapDraftPoint(world)
    this.draft = {
      kind,
      points: [start],
      clickCount: 1,
      cursor: null,
      color: kind === 'path' ? style.color : (region?.color ?? '#44cf6e'),
      width: kind === 'path' ? style.width : (region?.borderWidth ?? 3),
      // 预览与最终渲染保持一致（河流：平滑 + 末端变细）。
      // 沿网格线模式**不做平滑**：平滑会把格边抹成曲线，正好毁掉"整洁"的目的。
      smooth: kind === 'path' && style.smooth === true && this.geometryMode === 'interior',
      taper: kind === 'path' && style.taper === true,
      // 端点/连接也照抄当前类型：否则"平头端点"的类型在预览里会画成圆头
      cap: style.cap ?? DEFAULT_PATH_CAP,
      join: style.join ?? DEFAULT_PATH_JOIN,
    }
    this.options.onChanged()
    this.options.onStateChanged?.()
  }

  addDraftPoint(world: Point): void {
    if (!this.draft) return
    const grid = this.options.getDocument()?.grid
    const target = this.snapDraftPoint(world)
    if (grid && this.geometryMode === 'edge-step') {
      // 格步进模式：只前进一条边，方向由点击位置决定
      const last = this.draft.points[this.draft.points.length - 1]!
      const previous = this.draft.points.length >= 2 ? subtract(last, this.draft.points[this.draft.points.length - 2]!) : null
      this.draft.points.push(stepAlongEdges(grid, last, world, previous).point)
    } else if (grid && this.geometryMode === 'edge') {
      // 沿网格线：把"上一个顶点 → 新顶点"的整条边路都记进草稿。
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
   * 沿网格线模式下，光标那一端要从最后一个顶点**沿网格线走**过去（而不是一条斜线），
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
      // 格步进模式：预览也只显示**接下来那一条边**（点哪个方向就往哪走）
      const previous = draft.points.length >= 2 ? subtract(last, draft.points[draft.points.length - 2]!) : null
      const next = stepAlongEdges(grid, last, draft.cursor, previous).point
      return { points: [...draft.points, next], cursor: null }
    }
    const tail = walkTailToCursor(grid, last, draft.cursor)
    return { points: [...draft.points, ...tail], cursor: null }
  }

  /** 沿网格线模式：吸附到最近顶点；否则原样返回 */
  private snapDraftPoint(world: Point): Point {
    const grid = this.options.getDocument()?.grid
    if (this.geometryMode === 'interior' || !grid) return { x: world.x, y: world.y }
    return snapToHexVertex(grid, world).point
  }

  /**
   * 提交前的几何转换。
   *
   * 沿网格线模式下，已确定的顶点之间也要**沿网格线**连接（不只是把点吸附到顶点上）——
   * 否则远距离的两个顶点之间仍是一条斜穿格子的直线。
   * 格步进模式记录的本来就是相邻顶点，这里的行走是恒等操作（不会改变形状）。
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
    const style = this.currentPathStyle()
    // 沿网格线模式：顶点之间也要沿网格线走（否则远处两点之间仍是一条斜穿格子的直线）
    const geometry = this.commitGeometry(points, false)
    const path: MapPath = {
      id: nextShapeId(document_, 'p'),
      type: this.pathType,
      pts: geometry.map((point) => [point.x, point.y] as [number, number]),
      width: style.width,
      color: style.color,
      cap: style.cap ?? DEFAULT_PATH_CAP,
      join: style.join ?? DEFAULT_PATH_JOIN,
      mode: this.geometryMode,
    }
    if (style.dash) path.dash = [...style.dash]
    if (style.taper === true) path.taper = true
    // 沿网格线模式不做平滑：平滑会把格边抹成曲线，正好毁掉"整洁"的目的
    if (style.smooth === true && this.geometryMode === 'interior') path.smooth = true
    return { kind: 'addPath', path }
  }

  private buildRegionFrom(points: Point[]): MapOp {
    const document_ = this.options.getDocument()!
    const geometry = this.commitGeometry(points, true)
    const style = this.currentRegionStyle()
    const region: MapRegion = {
      id: nextShapeId(document_, 'r'),
      label: '',
      pts: geometry.map((point) => [point.x, point.y] as [number, number]),
      // 参数**来自目录**，并全部写进文件：于是改设置不会动已画好的区域，
      // 而换个版本打开这张地图时它仍然长这样（不依赖当时的设置）。
      color: style.color,
      opacity: style.opacity,
      borderWidth: style.borderWidth,
      // `type` 是新增字段：新画的区域带上它，图例/Base 行就能显示类型名
      type: style.type,
      mode: this.geometryMode,
    }
    // 边框色只在"不等于填充色"时写：跟随填充色是升级前的默认行为，
    // 写一个与填充色相同的值只是冗余（而且用户之后改填充色时它会留在旧值上）。
    if (style.borderColor !== style.color) region.borderColor = style.borderColor
    if (style.borderDash.length > 0) region.borderDash = [...style.borderDash]
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
