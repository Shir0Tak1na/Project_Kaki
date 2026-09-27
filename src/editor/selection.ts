/**
 * 选中状态与"检查器要显示什么" —— 纯函数模块（不 import obsidian，可单测）。
 *
 * ## 表驱动：这是为「以后加新对象种类」留的接缝
 *
 * 用户已经明确说了这个项目要**长期保持开放**：后面还要加"更多层信息"（温度带、深度分层）、
 * "更多种类地块"、"视图旋转"。所以这里**刻意不按 kind 逐条 if/else**，
 * 而是把每种对象的知识集中到一张表 `SELECTION_KINDS` 里：
 *
 * | 一份知识 | 放在表里的哪一列 |
 * |---|---|
 * | 界面上叫什么（人话） | `label` |
 * | 命中顺序 | `hitPriority`（**越小越先命中**，命中顺序由它排序得出） |
 * | 怎么命中它 | `hit(context) → id \| null` |
 * | 检查器显示什么 | `data(document, id, labels) → { name, link, detail }` |
 * | 支持哪些动作 | `actions: ('rename' \| 'link' \| 'delete')[]` |
 *
 * 高亮的画法在 `src/render/selectionHighlight.ts` 里是一张同构的表
 * （`SELECTION_HIGHLIGHTS`，一个 kind 一个绘制函数）。
 *
 * ### 加一个**新 kind**（例如"温度带对象"）要动哪几处
 *
 * 1. 本文件 `SelectionKind` 联合类型里加一个名字；
 * 2. 本文件 `SELECTION_KINDS` 里加**一行**（label / hitPriority / hit / data / actions）；
 * 3. `src/render/selectionHighlight.ts` 的 `SELECTION_HIGHLIGHTS` 里加**一行**绘制函数；
 * 4. （仅当它需要一种**全新的动作**时才要）在 `MapPanel` 的 `SELECTION_ACTION_RENDERERS`
 *    加一行，并在 `main.ts` / `MapEditor` 里给那个动作一个**复用既有落盘与撤销路径**的实现。
 *
 * 除此之外**不需要改任何分支**：命中测试、检查器信息、面板动作、高亮分派都从表里读
 * （`hitTestSelection` / `describeSelection` / `MapPanel.renderSelection` / `MapOverlay.drawSelection`）。
 *
 * ## 为什么命中顺序是"标记 → 名称 → 路径/区域 → 地块"
 *
 * 越"小"的对象越容易被大对象盖住：一个标记多半落在某块地形或某个区域里，
 * 如果先判地块/区域，用户就永远点不到标记了。反过来，点空地时**不该**选中一个
 * 没有内容的地块 —— 那会让"点空白处清除选中"变成不可能（六边形网格铺满平面，
 * 每个点都属于某个格）。
 *
 * 形状（路径/区域）的几何命中由调用方注入（`hitShape`）：那部分逻辑在
 * `shapeGeometry.ts` 里，且需要"路径的可见几何"等专业知识 —— 这里不重复实现一套，
 * 否则会出现"右键能删掉、左键选不中"这种两套命中互相打架的状态。
 */

import { cellKey, parseCellKey, worldToAxial, type GridSpec, type Point } from '../core/hex.ts'
import type { MapDocument } from '../data/mapDocument.ts'

export type SelectionKind = 'marker' | 'label' | 'path' | 'region' | 'cell'

/** 检查器能提供的动作（实现分别在 main.ts / MapEditor，且都走既有撤销与落盘路径） */
export type SelectionActionId = 'rename' | 'link' | 'delete'

/**
 * 「类型」下拉的候选从哪里来。面板不认识任何目录，它只知道**来源名**，
 * 真正的候选清单由 `main.ts` 按这个名字去查对应的目录（内置 + 自定义）。
 */
export type SelectionTypeSource = 'terrain' | 'marker' | 'path' | 'region'

/** 「位置」这一组怎么表达：点对象可编辑坐标，形状只能整体移动，地块只读 */
export type SelectionPosition = 'point' | 'cell' | 'shape' | 'none'

/** 位置当前值（面板据此渲染，不在面板里算几何） */
export type SelectionPositionValue =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'cell'; q: number; r: number }
  | { kind: 'shape'; points: number }
  | null

/** 一个可编辑的"外观"字段（对象自己的参数，存在地图文件里） */
export interface SelectionFieldSpec {
  /** 文件里的键名（`color` / `width` / `dash` / `opacity` / `borderColor` / `borderWidth` / `borderDash` / `c`） */
  field: string
  label: string
  control: 'color' | 'number' | 'dash'
  /** 数字控件的范围（世界单位或 0–1），仅 `control: 'number'` 有意义 */
  min?: number
  max?: number
}

/** 字段当前值（`null` = 文件里没有这个键） */
export type SelectionFieldValue = string | number | number[] | null

/** 选中的对象。`id` 就是地图文件里的标识（地块是 `cellKey` 生成的格键，形如 `"2_0"`） */
export interface MapSelection {
  kind: SelectionKind
  id: string
}

/** 检查器要显示的数据（由表里的 `data()` 给出） */
export interface SelectionData {
  /** 可编辑的名称（地块没有名字 → 显示地形种类，且不可改） */
  name: string
  /** 当前链接的笔记路径（空串 = 没链接） */
  link: string
  /** 一行补充信息：坐标 / 顶点数 / 地形种类 */
  detail: string
}

/** 命中测试的上下文：文档 + 网格 + 世界坐标 + 注入的形状命中器 */
export interface SelectionHitContext {
  document: MapDocument
  grid: GridSpec
  world: Point
  /** 形状（路径/区域）的命中容差（世界单位） */
  toleranceWorld: number
  hitShape: (world: Point, toleranceWorld: number) => { kind: 'path' | 'region'; id: string } | null
}

/** 解析各类 ID → 人话名称（由调用方注入，保持本模块纯净） */
export interface SelectionLabelResolvers {
  terrain: (id: string) => string
  marker: (id: string) => string
  path: (id: string) => string
  region: (id: string) => string
}

/** 一种对象种类的全部"知识" */
export interface SelectionKindSpec {
  /** 人话标签（界面上不能显示 `marker` / `cell` 这种内部名） */
  label: string
  /** 命中优先级：**越小越先命中**（命中顺序由这张表排序得出，不是写死的 if 链） */
  hitPriority: number
  /** 命中测试：返回该选中哪个 id，没命中返回 null */
  hit: (context: SelectionHitContext) => string | null
  /** 检查器要显示的数据；对象不存在时返回 null（不显示指向幽灵的数据） */
  data: (document: MapDocument, id: string, labels: SelectionLabelResolvers) => SelectionData | null
  /** 这种对象支持哪些动作（检查器据此渲染按钮） */
  actions: readonly SelectionActionId[]
  /**
   * 「类型」写在文件里的哪个键（`marker.icon` / `cell.t` / `path.type` / `region.type`）。
   * 没有这一列 = 这类对象没有类型可改（例如文字标注没有类型）。
   */
  typeField?: string
  /** 类型的候选来源（面板拿它向 `main.ts` 要候选清单） */
  typeSource?: SelectionTypeSource
  /** 「位置」这一组怎么表达 */
  position: SelectionPosition
  /**
   * 这类对象**存在哪里**：`collection` = 文档里某个对象数组（标记/名称/路径/区域）；
   * `grid` = `document.terrain` 这个以格键为键的映射（地块）。
   *
   * 为什么要显式写出来：读写路径不一样（数组靠 `find`，映射靠键），
   * 而"能不能改名称/链接"这类**能力**判断必须只来自 `actions` ——
   * 有了这一列，编辑器里就不需要 `kind === 'cell'` 这种散落的判断
   * （那种判断是"加新对象种类要改五处"的根源）。
   */
  storage: 'collection' | 'grid'
  /** 「外观」这一组有哪些可编辑字段（按顺序渲染） */
  fields: readonly SelectionFieldSpec[]
}

/**
 * 标记 / 名称的命中半径（单位：六边形边长）。
 *
 * 0.6 = "点到图标附近就算点中"，但不至于让相邻两格上的标记互相抢。
 * 用**格**而不是像素：地图缩放时命中范围随格一起缩放，用户手感才一致
 * （固定像素半径在放大后会变成"必须点得极准"）。
 */
const POINT_HIT_RADIUS_CELLS = 0.6

export function pointHitRadius(grid: GridSpec): number {
  return grid.size * POINT_HIT_RADIUS_CELLS
}

/** 在"点对象"类命中里挑最近的一个（标记与文字共用同一段实现） */
function nearestPointId(
  points: ReadonlyArray<{ id: string; p: [number, number] }>,
  world: Point,
  radius: number,
): string | null {
  const limit = radius * radius
  let best: { id: string; distance: number } | null = null
  for (const item of points) {
    const dx = item.p[0] - world.x
    const dy = item.p[1] - world.y
    const distance = dx * dx + dy * dy
    if (distance > limit) continue
    if (best === null || distance < best.distance) best = { id: item.id, distance }
  }
  return best?.id ?? null
}

/** 描述表：**加新对象种类就是在这里加一行**（见文件头"加一个新 kind 要动哪几处"） */
export const SELECTION_KINDS: Record<SelectionKind, SelectionKindSpec> = {
  marker: {
    label: '标记',
    hitPriority: 10,
    hit: ({ document, grid, world }) => nearestPointId(document.markers, world, pointHitRadius(grid)),
    data: (document, id, labels) => {
      const marker = document.markers.find((item) => item.id === id)
      if (!marker) return null
      return {
        name: marker.label,
        link: marker.link ?? '',
        detail: `位于 (${Math.round(marker.p[0])}, ${Math.round(marker.p[1])}) · 图标 ${labels.marker(marker.icon)}`,
      }
    },
    actions: ['rename', 'link', 'delete'],
    typeField: 'icon',
    typeSource: 'marker',
    position: 'point',
    storage: 'collection',
    fields: [{ field: 'c', label: '覆盖色', control: 'color' }],
  },
  label: {
    label: '名称',
    hitPriority: 20,
    hit: ({ document, grid, world }) => nearestPointId(document.labels, world, pointHitRadius(grid)),
    data: (document, id) => {
      const label = document.labels.find((item) => item.id === id)
      if (!label) return null
      return {
        name: label.text,
        link: label.link ?? '',
        detail: `位于 (${Math.round(label.p[0])}, ${Math.round(label.p[1])})`,
      }
    },
    actions: ['rename', 'link', 'delete'],
    // 文字标注没有类型（它显示的就是文字本身）；位置与标记同构（同为点对象），外观暂无字段
    position: 'point',
    storage: 'collection',
    fields: [],
  },
  path: {
    label: '路径',
    hitPriority: 30,
    // 形状命中复用注入的 `hitShape`（与右键删除、双击改名**同一套**判定），只认自己这一类
    hit: ({ hitShape, world, toleranceWorld }) => {
      const hit = hitShape(world, toleranceWorld)
      return hit !== null && hit.kind === 'path' ? hit.id : null
    },
    data: (document, id, labels) => {
      const path = document.paths.find((item) => item.id === id)
      if (!path) return null
      return {
        name: path.label ?? '',
        link: path.link ?? '',
        detail: `${path.pts.length} 个顶点 · 类型 ${labels.path(path.type)}`,
      }
    },
    actions: ['rename', 'link', 'delete'],
    typeField: 'type',
    typeSource: 'path',
    position: 'shape',
    storage: 'collection',
    fields: [
      { field: 'color', label: '颜色', control: 'color' },
      // 与 `pathTypeCatalog` 的线宽范围一致（1–40）：两处不一致会让"设置里能填、这里填不了"
      { field: 'width', label: '线宽', control: 'number', min: 1, max: 40 },
      { field: 'dash', label: '虚线', control: 'dash' },
    ],
  },
  region: {
    label: '区域',
    hitPriority: 40,
    hit: ({ hitShape, world, toleranceWorld }) => {
      const hit = hitShape(world, toleranceWorld)
      return hit !== null && hit.kind === 'region' ? hit.id : null
    },
    data: (document, id, labels) => {
      const region = document.regions.find((item) => item.id === id)
      if (!region) return null
      return {
        name: region.label,
        link: region.link ?? '',
        // 旧区域（升级前画的）**没有** type 字段：这时不能写成「类型 未知（）」，
        // 而要说清"它按颜色显示名字" —— 那是升级前唯一的身份来源（见 regionTypeCatalog.ts）
        detail:
          region.type === undefined
            ? `${region.pts.length} 个顶点 · 旧区域（没有类型，按颜色显示名字）`
            : `${region.pts.length} 个顶点 · 类型 ${labels.region(region.type)}`,
      }
    },
    actions: ['rename', 'link', 'delete'],
    typeField: 'type',
    typeSource: 'region',
    position: 'shape',
    storage: 'collection',
    fields: [
      { field: 'color', label: '填充色', control: 'color' },
      { field: 'opacity', label: '不透明度', control: 'number', min: 0, max: 1 },
      { field: 'borderColor', label: '边框色', control: 'color' },
      { field: 'borderWidth', label: '边框宽', control: 'number', min: 0, max: 40 },
      { field: 'borderDash', label: '边框虚线', control: 'dash' },
    ],
  },
  cell: {
    label: '地块',
    hitPriority: 50,
    // **只有该格真的有地形才算命中**：否则地图上处处都是"某个格"，选中永远清不掉
    hit: ({ document, grid, world }) => {
      const axial = worldToAxial(grid, world)
      const key = cellKey(axial.q, axial.r)
      return document.terrain[key] === undefined ? null : key
    },
    data: (document, id, labels) => {
      const cell = document.terrain[id]
      if (cell === undefined) return null
      return {
        // 地块没有名字：检查器那一栏显示地形种类，且不可编辑
        name: labels.terrain(cell.t),
        link: '',
        detail: `格 ${id} · 地形 ${labels.terrain(cell.t)}`,
      }
    },
    // 地块没有名字也没有链接：动作表里就只有删除
    actions: ['delete'],
    typeField: 't',
    typeSource: 'terrain',
    position: 'cell',
    storage: 'grid',
    fields: [{ field: 'c', label: '覆盖色', control: 'color' }],
  },
}

/**
 * 命中顺序：**由表里的 `hitPriority` 排序得出**（加新 kind 不用碰这段代码）。
 * 模块加载时算一次 —— 命中测试每次点击都要用。
 */
export const SELECTION_HIT_ORDER: readonly SelectionKind[] = (Object.keys(SELECTION_KINDS) as SelectionKind[]).sort(
  (a, b) => SELECTION_KINDS[a].hitPriority - SELECTION_KINDS[b].hitPriority,
)

/** 人话标签表：由描述表**派生**（单一来源，避免两处各写一份） */
export const SELECTION_KIND_LABELS: Record<SelectionKind, string> = (Object.keys(SELECTION_KINDS) as SelectionKind[]).reduce(
  (accumulator, kind) => {
    accumulator[kind] = SELECTION_KINDS[kind].label
    return accumulator
  },
  {} as Record<SelectionKind, string>,
)

/**
 * 命中测试：按表里的优先级依次问每种对象"这一点是不是你"，第一个给出 id 的胜出。
 *
 * 什么都没命中返回 `null`（调用方据此清空选中）。
 */
export function hitTestSelection(input: SelectionHitContext): MapSelection | null {
  for (const kind of SELECTION_HIT_ORDER) {
    const id = SELECTION_KINDS[kind].hit(input)
    if (id !== null) return { kind, id }
  }
  return null
}

/** 检查器要显示的一条选中信息 */
export interface SelectionInfo {
  kind: SelectionKind
  /** 人话的种类名（标记 / 名称 / 路径 / 区域 / 地块） */
  kindLabel: string
  id: string
  /** 可编辑的名称（地块没有名字 → 空串） */
  name: string
  /** 当前链接的笔记路径（空串 = 没链接） */
  link: string
  /** 一行补充信息：坐标 / 顶点数 / 地形种类 */
  detail: string
  /** 这种对象支持的动作（面板据此渲染按钮，不再逐 kind 判断） */
  actions: readonly SelectionActionId[]
  canRename: boolean
  canLink: boolean
  canDelete: boolean
  /** 类型：写得进文件里的键名（null = 这类对象没有类型） */
  typeField: string | null
  /** 类型候选从哪个目录来（null = 没有类型下拉） */
  typeSource: SelectionTypeSource | null
  /** 当前类型值（可能是本机没有定义的 ID —— 面板要显示成「未知（ID）」并允许改掉） */
  typeValue: string | null
  /** 位置这一组怎么表达 */
  position: SelectionPosition
  /** 位置当前值 */
  positionValue: SelectionPositionValue
  /** 外观这一组有哪些字段 */
  fields: readonly SelectionFieldSpec[]
  /** 外观字段的当前值（`null` = 文件里没有这个键） */
  fieldValues: Record<string, SelectionFieldValue>
}

/** 取某个对象的原始记录（**含这一版不认识的字段**），用来读写"对象自己的参数" */
export function objectRecordOf(
  document: MapDocument,
  kind: SelectionKind,
  id: string,
): Record<string, unknown> | null {
  switch (kind) {
    case 'marker':
      return (document.markers.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'label':
      return (document.labels.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'path':
      return (document.paths.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'region':
      return (document.regions.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'cell':
      return (document.terrain[id] as unknown as Record<string, unknown>) ?? null
  }
}

/** 把原始记录上的字段值取出来给面板用（只认三种形状：字符串 / 数字 / 数字数组） */
export function readObjectFieldValue(record: Record<string, unknown>, field: string): SelectionFieldValue {
  const raw = record[field]
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return raw as number[]
  }
  return null
}

/**
 * 两个字段值是否相同（决定"这次编辑算不算一次改动"）。
 *
 * 数组要按内容比：`[1,2] !== [1,2]` —— 用 `===` 会让"重新提交同样的虚线"每次都记一条历史。
 * 这条也保证面板重复提交同一个值不会污染撤销栈。
 */
export function sameObjectFieldValue(a: SelectionFieldValue, b: SelectionFieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    return a.length === b.length && a.every((item, index) => item === b[index])
  }
  return a === b
}

/** 位置当前值（几何计算留在这里，面板只负责画） */
function readPositionValue(
  kind: SelectionKind,
  position: SelectionPosition,
  record: Record<string, unknown>,
  id: string,
): SelectionPositionValue {
  if (position === 'point') {
    const p = record.p
    if (!Array.isArray(p) || p.length < 2) return null
    const [x, y] = p as unknown[]
    if (typeof x !== 'number' || typeof y !== 'number') return null
    return { kind: 'point', x, y }
  }
  if (position === 'cell') {
    const axial = parseCellKey(id)
    return axial === null ? null : { kind: 'cell', q: axial.q, r: axial.r }
  }
  if (position === 'shape') {
    const pts = record.pts
    return { kind: 'shape', points: Array.isArray(pts) ? pts.length : 0 }
  }
  void kind
  return null
}

/**
 * 把一份文档 + 一个选中项，变成检查器要显示的那一条。
 *
 * 三个 `canXxx` 是从 `actions` **派生**的（不是第二份状态）：面板渲染动作、单测断言能力，
 * 读的都是同一张表里那一行。类型 / 位置 / 外观三组同样全部从表里读 ——
 * **面板里不该出现任何 `kind === 'cell'` 这种判断**（那会让"加新对象种类"变成改五处）。
 */
export function describeSelection(
  document: MapDocument,
  selection: MapSelection | null,
  labels: SelectionLabelResolvers,
): SelectionInfo | null {
  if (selection === null) return null
  const spec = SELECTION_KINDS[selection.kind]
  const data = spec.data(document, selection.id, labels)
  if (data === null) return null
  const record = objectRecordOf(document, selection.kind, selection.id)
  if (record === null) return null
  const actions = spec.actions
  const typeField = spec.typeField ?? null
  const typeRaw = typeField === null ? null : record[typeField]
  const fieldValues: Record<string, SelectionFieldValue> = {}
  for (const field of spec.fields) fieldValues[field.field] = readObjectFieldValue(record, field.field)
  return {
    kind: selection.kind,
    kindLabel: spec.label,
    id: selection.id,
    name: data.name,
    link: data.link,
    detail: data.detail,
    actions,
    canRename: actions.includes('rename'),
    canLink: actions.includes('link'),
    canDelete: actions.includes('delete'),
    typeField,
    typeSource: spec.typeSource ?? null,
    typeValue: typeof typeRaw === 'string' ? typeRaw : null,
    position: spec.position,
    positionValue: readPositionValue(selection.kind, spec.position, record, selection.id),
    fields: spec.fields,
    fieldValues,
  }
}

/**
 * 存在「对象数组」里的那几类（地块存在 `terrain` 映射里，读写方式不同）。
 *
 * **由表里的 `storage` 列派生**，不是第二份真相：编辑器里需要把选中项窄化成
 * "能当作对象数组里的对象处理"时用它，于是就不必写 `kind === 'cell'` 这种散落判断。
 */
export const COLLECTION_KINDS: readonly SelectionKind[] = (Object.keys(SELECTION_KINDS) as SelectionKind[]).filter(
  (kind) => SELECTION_KINDS[kind].storage === 'collection',
)

/** 是不是"存在对象数组里"的那几类（类型窄化用；依据同上，来自表） */
export function isCollectionKind(kind: SelectionKind): kind is Exclude<SelectionKind, 'cell'> {
  return COLLECTION_KINDS.includes(kind)
}

/** 字段值 → 输入框里显示的文本（面板只负责显示；解析与范围检查在编辑器那一层做） */
export function formatSelectionFieldValue(field: SelectionFieldSpec, value: SelectionFieldValue): string {
  if (value === null) return ''
  if (Array.isArray(value)) return value.join(',')
  return String(value)
}

/** 某类对象支持某个动作吗（能力判断的**唯一来源**；需要的地方都读这里，不要自己写 kind 判断） */
export function selectionSupports(kind: SelectionKind, action: SelectionActionId): boolean {
  return SELECTION_KINDS[kind].actions.includes(action)
}

/** 检查器顶部那条引导（用户反馈"功能引导不清晰"的最小修复） */
export const SELECTION_EMPTY_HINT = '点一下地图上的对象来选中它（标记 / 名称 / 路径 / 区域 / 地块），选中后这里会显示它的信息。'
