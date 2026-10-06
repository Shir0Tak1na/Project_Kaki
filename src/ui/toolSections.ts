/**
 * 侧栏里的「工具 / 笔刷 / 选择方式」三组控件（施工文件 §F.2「侧栏其余段」）。
 *
 * ## 为什么这三组控件从画布浮窗搬到了这里
 *
 * 用户实测报的两条缺陷是同一个根因：
 * - **ISSUE-002「找不到生物群系笔刷」**：引擎与控件都做了，但控件长在画布左上角的浮窗里，
 *   用户画着画着不会去那里找一个"刷什么"的下拉；
 * - **ISSUE-004「筛选和绘制在同一个框里，反直觉」**：同一个浮框按模式换内容却**不换身份**，
 *   工具切换、绘制参数、选择按钮、撤销/重做全挤在一处。
 *
 * §F.2 定的分工是：**浮窗降级为「状态 + 撤销/重做」**（见 `MapToolbar`），
 * **工具与参数进侧栏**（本文）。于是侧栏变成"要改什么就在这里改"（与图层开关、
 * 数值图层参数同一处），浮窗只回答"我现在是什么状态"。
 *
 * ## 一条纪律：每个控件只出现一次
 *
 * §F.2 原稿把「地形选择 · 笔刷大小」同时列进了「工具」那一行，而「笔刷」那一行又写了「半径」——
 * 照抄会让同一个开关挂两处（`ENGINEERING-NOTES.md` §5.12）。这里按"它属于谁"归位：
 * - 地形选择与半径属于**笔刷**（它们就是"刷什么 / 刷多大"），只在「笔刷」一节出现；
 * - 路径/区域类型、图标、绘制模式属于**工具**，只在「工具」一节出现；
 * - 选择方式（框选 / 笔迹 / 筛选 / 连通扩展）属于**选择方式**，只在那一节出现。
 *
 * ## 与浮窗的差别（有意为之）
 *
 * 浮窗是"当前工具的参数"，用显隐来表达"现在用不上"；侧栏是一张常驻的控制面板，
 * 一节整个消失会让人以为"功能没了"。所以这里一律**保留控件、置灰、并写清原因**
 * （`hintLine`），而不是隐藏。
 */

import { setIcon } from 'obsidian'
import type { MarkerIcon, MarkerId, PathType, RegionType, TerrainId } from '../data/mapDocument.ts'
import type { BrushOp, EditorStatus, EditorTool, SelectionMode } from '../editor/MapEditor.ts'
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
  defaultRegionTypeEntries,
  describeRegionTypeParams,
  regionTypeCatalogSignature,
  resolveRegionType,
  type RegionTypeEntry,
} from '../render/regionTypeCatalog.ts'
import { biomeCatalogSignature, listResolvedBiomeStyles, type CustomBiome } from '../render/biomeCatalog.ts'
import { OVERLAY_FIELDS, type FieldId } from '../render/overlayFields.ts'
import { ICON_LABELS } from './PlaceMarkerModal.ts'
import {
  DRAW_MODE_HINTS,
  DRAW_MODE_LABELS,
  PANEL_EMPTY_HINTS,
  PANEL_SECTION_TITLES,
  selectionModeLabel,
  unknownTypeLabel,
} from './strings.ts'

/**
 * 这三节控件要的读写入口（**面板版**注入的那一份）。
 *
 * 与 `MapPanelDeps` 的其余部分同一思路：控件只负责画和把用户的输入交回去，
 * 认识编辑器 / 设置 / 目录的活儿全在外面（面板不认识插件实例）。
 * 唯一多出来的是 `requestRerender`：控件改完状态后要请宿主重绘自己
 * （浮窗版写的是 `refresh()`，面板版写的是"这一帧重绘面板"）。
 */
export interface ToolControlsHost {
  /** 当前活跃地图层的编辑器状态；`null` = 没有启用的地图层（也可能压根没有当前地图） */
  getStatus: () => EditorStatus | null
  /**
   * 现在有没有"要操作的画布"（有活动画布 ⇒ `true`）。
   *
   * 为什么需要它：`getStatus()` 为 `null` 有**两种完全不同的原因** ——
   * ①用户切到了一篇普通笔记（**没有当前地图**，ISSUE-007）；②画布开着但没启用地图层。
   * 三节的空态文案靠这个布尔二选一（见 `PANEL_EMPTY_HINTS`）。
   */
  hasActiveCanvas: () => boolean
  setTool: (tool: EditorTool) => void
  setTerrainType: (id: TerrainId) => void
  setMarkerIcon: (id: MarkerId) => void
  setPathType: (id: PathType) => void
  setRegionType: (id: RegionType) => void
  setGeometryMode: (mode: GeometryMode) => void
  setBrushField: (field: FieldId | null) => void
  setBrushOp: (op: BrushOp) => void
  setBrushValue: (value: number | null) => void
  setBrushBiome: (id: string) => void
  adjustBrushRadius: (delta: number) => void
  setSelectionMode: (mode: SelectionMode) => void
  expandSelectionByTerrain: () => void
  getCustomTerrains: () => readonly CustomTerrain[]
  getCustomMarkers: () => readonly CustomMarker[]
  getPathTypes: () => readonly PathTypeEntry[]
  getRegionTypes: () => readonly RegionTypeEntry[]
  getCustomBiomes: () => readonly CustomBiome[]
  /** 库内图片路径 → `<img src>`（图片模式的自定义标记）；缺省时退回借来的字形 */
  resolveImageSrc?: (path: string) => string
  /** 打开「按规则筛选选择…」对话框；缺省时**不渲染**那两个按钮（而不是渲染一个点了没反应的） */
  onOpenSelectionFilter?: () => void
  /**
   * 建一个可折叠的一节（`<details>`）。缺省时退回"永远展开的 div"（搬运时的老样子）。
   *
   * 为什么由宿主建：面板是**整块重建**式重绘，开合状态必须跨重建活下来
   * （`MapPanel` 那套"重建前从 DOM 读、重建时再传回去"），而 `toolSections.ts`
   * 不认识面板状态。所以这里只提要求（标题、身份、默认开合），状态归宿主。
   */
  createSection?: (parent: HTMLElement, options: ToolSectionOptions) => HTMLElement
  /** 改完状态后请宿主重绘 */
  requestRerender: () => void
}

/** `ToolControlsHost.createSection` 的参数 */
export interface ToolSectionOptions {
  /** 显示在 summary 上的标题 */
  title: string
  /** 宿主用它记住这一节的开合状态 */
  role: string
  /** 额外的样式类（`fc-panel-tools` / `fc-panel-brush` / `fc-panel-selection-mode`） */
  cls: string
  /** `dataset` 上的钩子键（既有断言按它取元素） */
  dataKey: string
  /** 用户**没有**手动开合过时的默认状态 */
  defaultOpen: boolean
}

/** 工具的中文名与提示（浮窗的标题行也用它，所以是 export —— 两处不能各写一份） */
export const TOOL_LABELS: Record<EditorTool, { label: string; hint: string }> = {
  brush: { label: '地形', hint: '地形笔刷（B）' },
  marker: { label: '标记', hint: '放置标记（M）' },
  label: { label: '文字', hint: '添加文字标注（T）' },
  path: { label: '路径', hint: '绘制河流/道路（P）：逐点点击，双击或回车结束' },
  region: { label: '区域', hint: '绘制国家/领地（R）：逐点点击，双击或回车结束' },
}

/** 工具在界面上的顺序（画笔在前 = 最常用） */
const TOOL_ORDER: readonly EditorTool[] = ['brush', 'marker', 'label', 'path', 'region']

/** 笔刷那一节的"层"选项：地形 + 每个数值图层字段（**从字段表派生**，加字段自动多一项） */
export const BRUSH_FIELD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '地形' },
  ...OVERLAY_FIELDS.map((spec) => ({ value: spec.id, label: spec.label })),
]

/** 数值字段的算法按钮（顺序就是界面上的顺序） */
export const BRUSH_OPS: ReadonlyArray<{ value: BrushOp; label: string; hint: string }> = [
  { value: 'set', label: '＝', hint: '这一笔把这些格直接设成这个数（分类字段只有这一种）' },
  { value: '+', label: '＋', hint: '在原来的数上加：没有值的格从「每格默认值」起算（没有就 0）——会把默认值固化进这些格' },
  { value: '-', label: '−', hint: '在原来的数上减：没有值的格从「每格默认值」起算（没有就 0）——会把默认值固化进这些格' },
  { value: '×', label: '×', hint: '乘一个系数：没有值的格跳过（拿"没量过"去乘没有意义）' },
  { value: '÷', label: '÷', hint: '除以一个系数：没有值的格跳过；除以 0 不生效' },
]

/**
 * 路径/区域的绘制模式（仅这两个工具下显示）。
 *
 * 界面顺序 = `GEOMETRY_OPTIONS` 的顺序（**沿网格走 · 沿格心走 · 逐格前进 · 锚点折线 · 自由绘制**）
 * —— 两个「走」的排在一起，用户找"怎么走"时不必在五个按钮里跳。
 * 名称与提示都从 `strings.ts` 取 —— 冒烟也从那里读常量，改文案只需要改一处。
 */
export const GEOMETRY_OPTIONS: ReadonlyArray<{ mode: GeometryMode; label: string; hint: string }> = [
  { mode: 'edge', label: DRAW_MODE_LABELS.edge, hint: DRAW_MODE_HINTS.edge },
  { mode: 'center', label: DRAW_MODE_LABELS.center, hint: DRAW_MODE_HINTS.center },
  { mode: 'edge-step', label: DRAW_MODE_LABELS.step, hint: DRAW_MODE_HINTS.step },
  { mode: 'interior', label: DRAW_MODE_LABELS.interior, hint: DRAW_MODE_HINTS.interior },
  { mode: 'free', label: DRAW_MODE_LABELS.free, hint: DRAW_MODE_HINTS.free },
]

/**
 * 三节控件的"渲染签名"：面板把它并进自己的状态签名，决定要不要重建 DOM。
 *
 * ⚠️ 少放一样就会静默不更新（`ENGINEERING-NOTES.md` §5.9）：控件的**值**就是编辑器状态，
 * 漏一个就会出现"面板里还高亮着上一个工具 / 半径还是旧数字"。
 * 目录签名也要进（用户增删自定义地形/标记/类型/群系后，选项数量本身会变）。
 */
export function toolControlsSignature(host: ToolControlsHost): string {
  const status = host.getStatus()
  if (status === null) return 'tools:none'
  const catalogs = [
    terrainCatalogSignature(host.getCustomTerrains()),
    markerCatalogSignature(host.getCustomMarkers()),
    pathTypeCatalogSignature(host.getPathTypes()),
    regionTypeCatalogSignature(host.getRegionTypes()),
    biomeCatalogSignature(host.getCustomBiomes()),
  ].join(';')
  return [
    status.mode,
    status.tool,
    status.terrainType,
    status.markerIcon,
    status.pathType,
    status.regionType,
    status.geometryMode,
    String(status.brushRadius),
    status.brushField ?? '',
    status.brushOp,
    status.brushValue === null ? 'null' : String(status.brushValue),
    status.brushValueConfirmed ? 1 : 0,
    status.brushBiome,
    status.brushReady.ok ? 'ok' : `no:${status.brushReady.reason}`,
    status.selectionMode,
    // 「连通扩展」的可用性看"有没有选择"，所以格数也要进签名 ——
    // 漏了它就会出现"框选了一片，侧栏那个按钮还是灰的"（§5.9 那类静默不更新）
    String(status.cellSelection.length),
    catalogs,
  ].join('|')
}

/**
 * 一节的外壳（标题 + `data` 钩子，供冒烟按节取元素）。
 *
 * 从浮窗搬进侧栏之后，真实库的反馈是"侧边栏里 UI 一大坨"：三节永远整块展开，
 * 一屏里既有工具按钮又有调色板/数值框，还得再滚过一屏命令按钮才够到动作。
 * 所以外壳改成**可折叠** —— 但开合状态归宿主保管（面板整块重建，状态放这里每次都会被重置成默认），
 * 这一层只回答"用户没动过时该不该展开"。
 */
function sectionShell(parent: HTMLElement, host: ToolControlsHost, options: ToolSectionOptions): HTMLElement {
  // 宿主没接这个能力时退回老样子（永远展开的 div），而不是少画一节
  if (typeof host.createSection !== 'function') {
    const group = parent.createEl('div', { cls: `fc-panel-group ${options.cls}` })
    group.dataset[options.dataKey] = 'group'
    group.createEl('div', { cls: 'fc-panel-group-title', text: options.title })
    return group
  }
  return host.createSection(parent, options)
}

/** 一行说明（"为什么现在是灰的"）—— 三节共用同一套排版 */
function hintLine(parent: HTMLElement, text: string): HTMLElement {
  return parent.createEl('div', { cls: 'fc-panel-hint', text })
}

/**
 * 三节空态该说哪一句。
 *
 * 两句必须分开（ISSUE-007）：**没有活动画布**（用户在看别的文档）时 `getStatus()` 也是 `null`，
 * 但与"画布开着、只是没启用地图层"完全是两回事。不说清是哪一种，用户在笔记里就会看到
 * "当前没有启用的地图层"这句**假话**（地图层其实还开着，只是不在前台）。
 */
function emptyHint(host: ToolControlsHost): string {
  return host.hasActiveCanvas() ? PANEL_EMPTY_HINTS.noLayer : PANEL_EMPTY_HINTS.noActiveMap
}

/** 一个按钮（统一样式类 `fc-ctl-button`；`is-active` 与 `disabled` 由调用方设） */
function button(parent: HTMLElement, cls: string, text: string, title = ''): HTMLButtonElement {
  const element = parent.createEl('button', { cls: `fc-ctl-button ${cls}`.trim(), text })
  element.title = title
  return element
}

/** 当前状态用不了的统一说法（不是"坏了"，是"现在轮不到它"） */
function unusableReason(status: EditorStatus): string {
  if (status.mode !== 'paint') return '按 D 进入绘制模式后才会生效（选择模式下左键归框选手势）。'
  return `当前工具是「${TOOL_LABELS[status.tool].label}」，只有「${TOOL_LABELS.brush.label}」工具下才生效。`
}

// ------------------------------------------------------------------ 工具

/**
 * 「工具」一节：工具切换 + 当前工具的参数（路径/区域类型、图标、绘制模式）。
 *
 * 地形选择**不在这里**：它属于笔刷（见文件头那条"每个控件只出现一次"）。
 */
export function renderToolSection(parent: HTMLElement, host: ToolControlsHost): void {
  const status = host.getStatus()
  // 「工具」是首屏一定要看的那一节（我现在是什么工具 + 它的参数），默认展开
  const group = sectionShell(parent, host, {
    title: PANEL_SECTION_TITLES.tools,
    role: 'panel-tools',
    cls: 'fc-panel-tools',
    dataKey: 'fcTools',
    defaultOpen: true,
  })
  if (status === null) {
    hintLine(group, emptyHint(host))
    return
  }
  const painting = status.mode === 'paint'

  const toolRow = group.createEl('div', { cls: 'fc-panel-tool-row' })
  for (const tool of TOOL_ORDER) {
    const element = button(toolRow, 'fc-panel-tool', TOOL_LABELS[tool].label, TOOL_LABELS[tool].hint)
    element.dataset.fcTool = tool
    element.disabled = !painting
    element.classList.toggle('is-active', painting && status.tool === tool)
    element.addEventListener('click', () => {
      host.setTool(tool)
      host.requestRerender()
    })
  }
  if (!painting) {
    hintLine(group, '按 D 进入绘制模式后才能切换工具（选择模式下的左键是框选手势）。')
    return
  }

  if (status.tool === 'marker') renderMarkerIcons(group, host, status)
  if (status.tool === 'path') renderPathType(group, host, status)
  if (status.tool === 'region') renderRegionType(group, host, status)
  if (status.tool === 'path' || status.tool === 'region') renderGeometry(group, host, status)
}

/**
 * 标记图标的候选按钮（内置 9 种 + 自定义）。
 *
 * 三条与浮窗时期逐字相同的口径：
 * - 图片模式的自定义标记**直接显示用户那张图**（字形只是占位，认不出自己挑的图标）；
 * - 自定义标记额外显示显示名（字形可能是通用的圆点，只有名字能区分）；
 * - **未知图标不占按钮位** —— 地图里已有的未知图标照常绘制，数据也不会丢。
 */
function renderMarkerIcons(group: HTMLElement, host: ToolControlsHost, status: EditorStatus): void {
  const custom = host.getCustomMarkers()
  const styles = listResolvedMarkerStyles(custom)
  group.createEl('div', { cls: 'fc-panel-hint', text: '放置标记用的图标（快捷键 M）：' })
  const row = group.createEl('div', { cls: 'fc-panel-icon-grid' })
  for (const style of styles) {
    const element = button(row, style.builtin ? 'fc-panel-icon' : 'fc-panel-icon is-custom', '')
    element.dataset.fcIcon = style.id
    element.title = style.builtin
      ? (ICON_LABELS[style.id as MarkerIcon] ?? style.label)
      : `${style.label}（自定义标记 ${style.id}${style.imagePath.length > 0 ? ` · 图片 ${style.imagePath}` : ''}）`
    const glyph = element.createEl('span', { cls: 'fc-panel-icon-glyph' })
    const src = style.imagePath.length > 0 ? (host.resolveImageSrc?.(style.imagePath) ?? '') : ''
    if (src.length > 0) {
      const img = glyph.createEl('img', { cls: 'fc-panel-icon-image' })
      img.alt = ''
      // 同标记层：不设 draggable=false 会把"点按钮"变成浏览器原生拖图
      img.draggable = false
      img.src = src
    } else {
      setIcon(glyph, style.iconName)
    }
    if (!style.builtin) element.createEl('span', { cls: 'fc-panel-icon-label', text: style.label })
    element.classList.toggle('is-active', style.id === status.markerIcon)
    element.addEventListener('click', () => {
      host.setMarkerIcon(style.id)
      host.requestRerender()
    })
  }
}

/** 路径类型：一个下拉 + 一行"当前类型的画法参数" */
function renderPathType(group: HTMLElement, host: ToolControlsHost, status: EditorStatus): void {
  const entries = host.getPathTypes()
  // 当前类型的解析**先算**：色块要画在选中框旁边（下拉里塞不下色块，
  // 而"我选的是哪一种"以前是靠工具条上那个色块回答的，这个信息不能丢）
  const resolved = resolvePathType(status.pathType, entries)
  const row = group.createEl('div', { cls: 'fc-panel-field-row' })
  row.createEl('span', { cls: 'fc-panel-field-label', text: '路径类型' })
  const swatch = row.createEl('span', { cls: 'fc-ctl-swatch fc-panel-type-swatch' })
  swatch.dataset.fcPathSwatch = '1'
  swatch.style.backgroundColor = resolved.params.color
  const select = row.createEl('select', { cls: 'dropdown fc-panel-type-select' })
  select.dataset.fcPathType = '1'
  const known = listPathTypeEntries(entries).map((entry) => entry.id)
  // 当前值不在目录里（别的库写的 / 定义刚被删）：补一条「未知（ID）」并**保留原值** ——
  // 否则下拉会显示成第一项，用户以为类型被改掉了（§5.11）
  if (!known.includes(status.pathType)) {
    select.createEl('option', { text: `${unknownTypeLabel(status.pathType)}` }).value = status.pathType
  }
  for (const entry of listPathTypeEntries(entries)) {
    select.createEl('option', { text: entry.label }).value = entry.id
  }
  select.value = status.pathType
  select.addEventListener('change', () => {
    host.setPathType(select.value)
    host.requestRerender()
  })
  hintLine(group, `${resolved.label}：${describePathTypeParams(resolved.params)}`)
}

/** 区域类型：与路径同一个做法（下拉 + 当前类型的画法参数） */
function renderRegionType(group: HTMLElement, host: ToolControlsHost, status: EditorStatus): void {
  const entries = host.getRegionTypes()
  const resolved = resolveRegionType(status.regionType, entries)
  const row = group.createEl('div', { cls: 'fc-panel-field-row' })
  row.createEl('span', { cls: 'fc-panel-field-label', text: '区域类型' })
  const swatch = row.createEl('span', { cls: 'fc-ctl-swatch fc-panel-type-swatch' })
  swatch.dataset.fcRegionSwatch = '1'
  swatch.style.backgroundColor = resolved.params.color
  const select = row.createEl('select', { cls: 'dropdown fc-panel-type-select' })
  select.dataset.fcRegionType = '1'
  const known = entries.map((entry) => entry.id)
  if (!known.includes(status.regionType)) {
    select.createEl('option', { text: `${unknownTypeLabel(status.regionType)}` }).value = status.regionType
  }
  for (const entry of entries) {
    select.createEl('option', { text: entry.label }).value = entry.id
  }
  select.value = status.regionType
  select.addEventListener('change', () => {
    host.setRegionType(select.value)
    host.requestRerender()
  })
  hintLine(group, `${resolved.label}：${describeRegionTypeParams(resolved.params)}`)
}

/** 绘制模式（只对路径/区域这两个"多点绘制"的工具显示） */
function renderGeometry(group: HTMLElement, host: ToolControlsHost, status: EditorStatus): void {
  const row = group.createEl('div', { cls: 'fc-panel-tool-row' })
  for (const option of GEOMETRY_OPTIONS) {
    const element = button(row, 'fc-panel-geometry', option.label, option.hint)
    element.dataset.fcGeometry = option.mode
    element.classList.toggle('is-active', status.geometryMode === option.mode)
    element.addEventListener('click', () => {
      host.setGeometryMode(option.mode)
      host.requestRerender()
    })
  }
}

// ------------------------------------------------------------------ 笔刷

/**
 * 「笔刷」一节：层（地形 / 数值图层字段）+ 该层的参数 + 半径。
 *
 * §E 的三条硬口径原样保留（它们只跟状态有关，与控件长在哪里无关）：
 * **数值框初始为空**（不预填）、**没确认时笔刷不生效**（这里把原因写在旁边，
 * 浮窗的状态行也照旧写一份）、**换层或换算法不静默沿用**（数字留着但标"未确认"）。
 */
export function renderBrushSection(parent: HTMLElement, host: ToolControlsHost): void {
  const status = host.getStatus()
  // 默认只在使用笔刷时展开：这一节最长（层 / 算法 / 数值 / 群系 / 半径 / 调色板），
  // 用标记或路径时它整块是灰的，展开只是把真正要用的东西挤出屏幕（用户报的"一大坨"）。
  // 没有地图层时展开，否则空态那句（`PANEL_EMPTY_HINTS`）被收在折叠里
  // = 用户看不到"为什么这里是空的"。
  const group = sectionShell(parent, host, {
    title: PANEL_SECTION_TITLES.brush,
    role: 'panel-brush',
    cls: 'fc-panel-brush',
    dataKey: 'fcBrush',
    defaultOpen: status === null || (status.mode === 'paint' && status.tool === 'brush'),
  })
  if (status === null) {
    hintLine(group, emptyHint(host))
    return
  }
  const usable = status.mode === 'paint' && status.tool === 'brush'

  // ---- 刷什么（层）----
  const layerRow = group.createEl('div', { cls: 'fc-panel-field-row' })
  layerRow.createEl('span', { cls: 'fc-panel-field-label', text: '刷什么' })
  const fieldSelect = layerRow.createEl('select', { cls: 'dropdown fc-panel-brush-field' })
  fieldSelect.dataset.fcBrushField = '1'
  for (const option of BRUSH_FIELD_OPTIONS) {
    fieldSelect.createEl('option', { text: option.label }).value = option.value
  }
  fieldSelect.value = status.brushField ?? ''
  fieldSelect.disabled = !usable
  fieldSelect.addEventListener('change', () => {
    const value = fieldSelect.value
    host.setBrushField(value === '' ? null : (value as FieldId))
    host.requestRerender()
  })

  const spec = status.brushField === null ? undefined : OVERLAY_FIELDS.find((item) => item.id === status.brushField)
  const numeric = spec !== undefined && spec.numeric
  const category = spec !== undefined && !spec.numeric

  // ---- 地形层：地形调色板 ----
  if (status.brushField === null) {
    renderTerrainPalette(group, host, status, usable)
  }

  // ---- 数值层：算法 + 数值（需确认）----
  if (numeric) {
    const opRow = group.createEl('div', { cls: 'fc-panel-tool-row' })
    for (const op of BRUSH_OPS) {
      const element = button(opRow, 'fc-panel-brush-op', op.label, op.hint)
      element.dataset.fcBrushOp = op.value
      element.disabled = !usable
      element.classList.toggle('is-active', status.brushOp === op.value)
      element.addEventListener('click', () => {
        host.setBrushOp(op.value)
        host.requestRerender()
      })
    }

    const valueRow = group.createEl('div', { cls: 'fc-panel-field-row' })
    valueRow.createEl('span', { cls: 'fc-panel-field-label', text: '数值' })
    const input = valueRow.createEl('input', { cls: 'fc-panel-brush-value' })
    input.type = 'number'
    input.dataset.fcBrushValue = '1'
    // 面板是**整块重建**式重绘：键入会写编辑器状态（"打回未确认"），那一步会触发重绘，
    // 输入框被换成新的 —— 用户打到一半的字与焦点都会没。这个键就是重建后把它放回去的依据
    // （见 `MapPanel.captureFocusedInput`）。
    input.dataset.fcFocusKey = 'brush-value'
    input.disabled = !usable
    input.value = status.brushValue === null ? '' : String(status.brushValue)
    input.placeholder = status.brushValue === null ? '数值（空着不生效）' : '回车确认'
    input.classList.toggle('is-unconfirmed', status.brushValue !== null && !status.brushValueConfirmed)
    input.title = '填一个数并按回车（或点开别处）确认 —— 没确认时笔刷不生效'
    /**
     * 只认 `change`（回车 / 失焦）：`input` 每次击键都提交就等于"边打边刷"。
     * 键入时**把笔刷打回未确认**（值不同就清掉），否则笔上还带着上一次的旧值，
     * 而输入框里显示的是新数字。
     *
     * ⚠️ 这里**不请求重绘**：面板是"重建 DOM"式的重绘，一边打字一边重建会把焦点冲掉
     * （浮窗时期靠"有焦点就不改它的字"绕开，面板没有这个余地）。未确认的视觉标记
     * 就地改 class，等回车/失焦提交时再重绘一次。
     */
    input.addEventListener('input', () => {
      const text = input.value.trim()
      const parsed = text.length === 0 ? null : Number(text)
      const value = parsed !== null && Number.isFinite(parsed) ? parsed : null
      const changed = value !== status.brushValue
      if (changed) host.setBrushValue(null)
      input.classList.toggle('is-unconfirmed', changed || !status.brushValueConfirmed)
    })
    const commit = (): void => {
      const text = input.value.trim()
      const parsed = text.length === 0 ? null : Number(text)
      host.setBrushValue(parsed !== null && Number.isFinite(parsed) ? parsed : null)
      host.requestRerender()
    }
    input.addEventListener('change', commit)
    input.addEventListener('blur', commit)
  }

  // ---- 分类层（生物群系）：设为某个群系 ----
  if (category) {
    const biomeRow = group.createEl('div', { cls: 'fc-panel-field-row' })
    biomeRow.createEl('span', { cls: 'fc-panel-field-label', text: '设为' })
    const select = biomeRow.createEl('select', { cls: 'dropdown fc-panel-brush-biome' })
    select.dataset.fcBrushBiome = '1'
    select.createEl('option', { text: '选择生物群系…' }).value = ''
    for (const entry of listResolvedBiomeStyles(host.getCustomBiomes())) {
      select.createEl('option', { text: entry.label }).value = entry.id
    }
    select.value = status.brushBiome
    select.disabled = !usable
    select.addEventListener('change', () => {
      host.setBrushBiome(select.value)
      host.requestRerender()
    })
  }

  // ---- 半径：**不看着色层走**（笔迹框选也用同一个半径），所以只要在绘制模式就可用 ----
  const radiusRow = group.createEl('div', { cls: 'fc-panel-field-row' })
  radiusRow.createEl('span', { cls: 'fc-panel-field-label', text: '半径' })
  const smaller = button(radiusRow, 'fc-panel-brush-radius', '−', '减小笔刷（[）')
  smaller.dataset.fcBrushRadius = '-1'
  const radiusValue = radiusRow.createEl('span', { cls: 'fc-panel-brush-radius-value', text: String(status.brushRadius) })
  radiusValue.dataset.fcBrushRadiusValue = '1'
  const larger = button(radiusRow, 'fc-panel-brush-radius', '+', '增大笔刷（]）')
  larger.dataset.fcBrushRadius = '1'
  const step = (delta: number): void => {
    host.adjustBrushRadius(delta)
    host.requestRerender()
  }
  smaller.addEventListener('click', () => step(-1))
  larger.addEventListener('click', () => step(1))

  // ---- 为什么现在刷不动 ----
  if (!usable) hintLine(group, unusableReason(status))
  else if (status.brushField !== null && !status.brushReady.ok) {
    // §E 第 2 条：用户不该靠猜"为什么刷不动" —— 原因写在控件的正下方
    // （浮窗的状态行也照旧写一份，两处说的是同一件事，不是两份状态）
    hintLine(group, `笔刷尚未生效：${status.brushReady.reason}`)
  }
}

/** 地形调色板（内置 9 种在前 = 数字键 1–9，自定义排在后面） */
function renderTerrainPalette(group: HTMLElement, host: ToolControlsHost, status: EditorStatus, usable: boolean): void {
  const styles = listResolvedTerrainStyles(host.getCustomTerrains())
  const row = group.createEl('div', { cls: 'fc-panel-terrain-grid' })
  styles.forEach((style, index) => {
    const element = button(row, style.builtin ? 'fc-panel-terrain' : 'fc-panel-terrain is-custom', '')
    element.dataset.fcTerrain = style.id
    element.disabled = !usable
    element.title = style.builtin
      ? `${style.label}（快捷键 ${index + 1}）`
      : `${style.label}（自定义地形 ${style.id}${style.imagePath.length > 0 ? ` · 图片 ${style.imagePath}` : ''}）`
    const swatch = element.createEl('span', { cls: 'fc-ctl-swatch' })
    swatch.style.backgroundColor = style.base
    element.createEl('span', { cls: 'fc-panel-terrain-label', text: style.label })
    element.classList.toggle('is-active', style.id === status.terrainType)
    element.addEventListener('click', () => {
      host.setTerrainType(style.id)
      host.requestRerender()
    })
  })
}

// ------------------------------------------------------------------ 选择方式

/**
 * 「选择方式」一节（§C.1 / §C.2 / §C.3）：框选 / 笔迹框选 / 筛选… / 连通扩展。
 *
 * 浮窗时期的做法是"绘制模式下整组隐藏"；侧栏这边改成**置灰 + 写清原因**：
 * 一节忽隐忽现会让人以为功能被删了，而置灰能同时回答"有这个东西"和"现在用不上"。
 */
export function renderSelectionModeSection(parent: HTMLElement, host: ToolControlsHost): void {
  const status = host.getStatus()
  // 默认只在"选择"这一档展开：这节的按钮在绘制模式下全是灰的，展开没有意义
  const group = sectionShell(parent, host, {
    title: PANEL_SECTION_TITLES.selectionMode,
    role: 'panel-selection-mode',
    cls: 'fc-panel-selection-mode',
    dataKey: 'fcSelectionMode',
    defaultOpen: status === null || status.mode !== 'paint',
  })
  if (status === null) {
    hintLine(group, emptyHint(host))
    return
  }
  const selectable = status.mode !== 'paint'

  const row = group.createEl('div', { cls: 'fc-panel-tool-row' })
  const modes: ReadonlyArray<{ mode: SelectionMode; label: string; hint: string }> = [
    {
      mode: 'rect',
      // 名字与工具条状态行里的那一份同源（`选择 · 矩形框选 · 14 格`）—— 两处说得不一样用户会以为换了工具
      label: selectionModeLabel('rect'),
      hint: '按住左键拉出一个矩形：选中框里的格（Shift 加选、Alt 取消）',
    },
    {
      mode: 'brush',
      label: selectionModeLabel('brush'),
      hint: '按住左键划过去：笔迹扫过的格被选中（范围跟"笔刷大小"同一个半径）',
    },
  ]
  for (const item of modes) {
    const element = button(row, 'fc-panel-selection-mode-button', item.label, item.hint)
    element.dataset.fcSelectionMode = item.mode
    element.disabled = !selectable
    element.classList.toggle('is-active', status.selectionMode === item.mode)
    element.addEventListener('click', () => {
      host.setSelectionMode(item.mode)
      host.requestRerender()
    })
  }

  // 「筛选…」与「连通扩展」只在插件层接上了回调时才创建（缺省 = 不渲染，而不是点了没反应）
  if (host.onOpenSelectionFilter) {
    const filter = button(row, 'fc-panel-selection-filter', '筛选…', '按规则筛选选择（地形 / 温度 / 深度…，子句可叠加）')
    filter.dataset.fcSelectionAction = 'filter'
    filter.disabled = !selectable
    filter.addEventListener('click', () => host.onOpenSelectionFilter?.())

    const expand = button(row, 'fc-panel-selection-expand', '连通扩展', '以当前选择为种子，按同一种地形扩到整片连通区')
    expand.dataset.fcSelectionAction = 'expand'
    expand.disabled = !selectable || status.cellSelection.length === 0
    expand.addEventListener('click', () => {
      host.expandSelectionByTerrain()
      host.requestRerender()
    })
  }

  if (!selectable) hintLine(group, '绘制模式下左键归绘制手势；按 Esc（或点浮窗上的「● 绘制中」）退回选择模式。')
}
