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

import { cellKey, worldToAxial, type GridSpec, type Point } from '../core/hex.ts'
import type { MapDocument } from '../data/mapDocument.ts'

export type SelectionKind = 'marker' | 'label' | 'path' | 'region' | 'cell'

/** 检查器能提供的动作（实现分别在 main.ts / MapEditor，且都走既有撤销与落盘路径） */
export type SelectionActionId = 'rename' | 'link' | 'delete'

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
        // 地块没有名字：检查器那一栏显示地形种类，且不可编辑（改地形种类属于后续增量）
        name: labels.terrain(cell.t),
        link: '',
        detail: `格 ${id} · 地形 ${labels.terrain(cell.t)}`,
      }
    },
    // 地块没有名字也没有链接：动作表里就只有删除
    actions: ['delete'],
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
}

/**
 * 把一份文档 + 一个选中项，变成检查器要显示的那一条。
 *
 * 三个 `canXxx` 是从 `actions` **派生**的（不是第二份状态）：面板渲染动作、单测断言能力，
 * 读的都是同一张表里那一行。
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
  const actions = spec.actions
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
  }
}

/** 检查器顶部那条引导（用户反馈"功能引导不清晰"的最小修复） */
export const SELECTION_EMPTY_HINT = '点一下地图上的对象来选中它（标记 / 名称 / 路径 / 区域 / 地块），选中后这里会显示它的信息。'
