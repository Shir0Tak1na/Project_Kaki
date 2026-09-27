/**
 * 图层描述表：地形 / 网格 / 区域 / 路径 / 标记 / 名称。
 *
 * 两条设计边界（都写在这里，避免以后被"顺手"破坏）：
 *
 * 1. **图层状态属于插件设置，绝不写进地图几何数据**。
 *    地图文件（`.map.md`）描述的是"世界上有什么"，图层开关描述的是"我现在想看到什么"。
 *    把后者写进前者，等于换个显示方式就改了用户的数据 —— 而且会污染 Git diff。
 * 2. **图层是纯数据 + 纯函数**，渲染层只读它。于是"隐藏某层到底该不该少画东西"
 *    可以脱离 Obsidian 单测，而不是靠肉眼看画布。
 *
 * 为什么是**一张表**：以前加一层要改五处（键列表 / 中文名 / 悬停提示 / 出厂默认，外加面板、
 * 设置页、图例、渲染计划里各自的分支），漏一处就表现为"设置里有、面板上没有"，
 * 或"开关是亮的但画布没反应"。现在加一层 = 加一行（`docs/EXTENSION-POINTS.md` §3.2）。
 *
 * 表的每一行：
 * - `id`：持久化键（`data.json` 的 `layers.<id>`）。**不许改名** —— 改名等于把用户那一层的开关丢掉。
 * - `label` / `hint` / `describe`：三个给人看的名字 —— 短名 / 悬停提示 / 设置页里"关掉之后你会看到什么"。
 * - `defaultVisible`：出厂默认（`data.json` 缺这一项时按它补齐）。
 * - `isDataLayer`：地图文件里有对应实体（地形 / 区域 / 路径 / 标记，以及将来的温度、深度）为 `true`；
 *   纯表现（网格、名称这类"只是怎么画"）为 `false`。
 * - `order`：**画布上的叠加次序**（自下而上，唯一的顺序来源）。绘制层遍历 `LAYERS_BY_DRAW_ORDER`，
 *   不许自己另写一份顺序 —— 见 `MapOverlay.drawPlan`；顺序回归（"地形盖住路径"）由断言钉住。
 * - `draw`：可选的画布绘制钩子。内置四层（地形 / 网格 / 区域 / 路径）由绘制层的内置遍负责；
 *   新层把自己的"画什么"挂在这里，就同时拿到了正确的叠加位置，不必再改绘制层的分支。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import type { MapRenderPlan } from './renderPlan.ts'

/**
 * 画布绘制钩子拿到的材料。
 *
 * 刻意**不给**钩子"自己推投影公式"的机会：世界 → 位图的换算只有一份（`worldToRaster`），
 * 钩子用 `toRaster` 即可。本项目已经因为"抄一份换算/调色板"出过真事故。
 */
export interface LayerDrawContext {
  /** 位图 2D 上下文（已 `setTransform` 归一，坐标一律用位图像素） */
  ctx: CanvasRenderingContext2D
  /** 世界坐标 → 位图坐标（与地形/网格/矢量层同一份换算） */
  toRaster: (x: number, y: number) => { x: number; y: number }
  /** 这一帧的渲染计划（含投影参数与可见世界范围） */
  plan: MapRenderPlan
  /** 当前地图文档（只读；钩子不许改数据） */
  document: MapDocument
  /** 全量图层开关（钩子想联动别的层时现读，不要缓存） */
  layers: LayerVisibility
}

interface LayerSpecShape {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly describe: string
  readonly defaultVisible: boolean
  readonly isDataLayer: boolean
  readonly order: number
  readonly draw?: (context: LayerDrawContext) => void
}

/**
 * 图层登记表。行序 = **界面上的显示顺序**（面板开关、设置页的先后），
 * 与画布上的绘制次序无关 —— 后者看每行的 `order`。
 */
export const LAYER_TABLE = [
  {
    id: 'terrain',
    label: '地形',
    hint: '六边形地形的填色 / 图片',
    describe: '六边形地形底色与图形。关掉后只剩矢量元素（路径/区域/标记），文档里的格子不受影响。',
    defaultVisible: true,
    isDataLayer: true,
    order: 10,
  },
  {
    id: 'grid',
    label: '网格',
    hint: '六边形网格线',
    describe: '六边形网格线。工具条上也有同一个开关（设置页原来那个「显示六边形网格」已并入这里）。',
    defaultVisible: true,
    isDataLayer: false,
    order: 20,
  },
  {
    id: 'regions',
    label: '区域',
    hint: '半透明的领地范围',
    describe: '半透明区域填充与边框（国境、领地）。',
    defaultVisible: true,
    isDataLayer: true,
    order: 30,
  },
  {
    id: 'paths',
    label: '路径',
    hint: '河流 / 道路 / 贸易路线 / 边界',
    describe: '河流、道路、贸易路线、边界。',
    defaultVisible: true,
    isDataLayer: true,
    order: 40,
  },
  {
    id: 'markers',
    label: '标记',
    hint: '地标标记与文字标注',
    describe: '标记与文字标注（画布上可点击、可拖动的那些实体）。',
    defaultVisible: true,
    isDataLayer: true,
    order: 50,
  },
  {
    id: 'labels',
    label: '名称',
    hint: '路径与区域的名称文字',
    describe: '路径与区域的名称标注。工具条上的「名称」按钮切换的是同一个值。',
    defaultVisible: true,
    isDataLayer: false,
    // 名称**不是独立的一遍**：区域的名称在区域那一遍里画、路径的名称在路径那一遍里画，
    // 所以它的位置跟着所属形状走。这里给的次序只表达"名称夹在矢量图形之间、且永远在标记之下"；
    // 绘制层不必为它单独安排一遍（它只作为标志被区域 / 路径两遍读走）。
    order: 35,
  },
] as const satisfies readonly LayerSpecShape[]

/** 图层键：直接由表推导 —— 加一行就多一个合法键，没有第二处清单要同步 */
export type LayerKey = (typeof LAYER_TABLE)[number]['id']

/** 表的一行（用接口而不是 `as const` 的推导结果：`draw` 是可选的，推导类型会给每行不同的形状） */
export interface LayerSpec {
  id: LayerKey
  label: string
  hint: string
  describe: string
  defaultVisible: boolean
  isDataLayer: boolean
  order: number
  draw?: (context: LayerDrawContext) => void
}

export type LayerVisibility = Record<LayerKey, boolean>

/** 图层键（顺序与 `LAYER_TABLE` 行序一致） */
export const LAYER_KEYS: readonly LayerKey[] = LAYER_TABLE.map((spec) => spec.id)

/**
 * 按**画布叠加次序**排列的层（自下而上）。
 *
 * 绘制层必须遍历它：顺序只有这一处来源，于是"谁在谁上面"是可读的、可断言的，
 * 而不是散落在绘制函数调用行里（那种顺序改动没人看得出来）。
 */
export const LAYERS_BY_DRAW_ORDER: readonly LayerSpec[] = [...LAYER_TABLE].sort((a, b) => a.order - b.order)

/** 出厂默认（全部按表里的 `defaultVisible`；每次返回新对象） */
export const DEFAULT_LAYER_VISIBILITY: LayerVisibility = defaultVisibility()

function defaultVisibility(): LayerVisibility {
  const out = {} as LayerVisibility
  for (const spec of LAYER_TABLE) out[spec.id] = spec.defaultVisible
  return out
}

/**
 * 把任意输入收敛成完整的图层开关表。
 *
 * 缺项按**出厂默认**补齐，而不是按"false"：用户手工改坏 data.json 时，
 * 宁可他看到东西多，也不要让他面对一张空白地图却不知道为什么。
 */
export function normalizeLayerVisibility(raw: unknown): LayerVisibility {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as LayerVisibility
  for (const spec of LAYER_TABLE) {
    const value = source[spec.id]
    out[spec.id] = typeof value === 'boolean' ? value : spec.defaultVisible
  }
  return out
}

/**
 * 从旧设置迁移：本插件早期只有 `showGrid` 一个开关，且 `showGrid=false` 表示**隐藏网格**。
 * 迁移时保留用户的选择，其余层按默认显示。
 */
export function layerVisibilityFromLegacy(raw: unknown): LayerVisibility {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const visibility = normalizeLayerVisibility(source.layers)
  if (typeof source.showGrid === 'boolean' && source.layers === undefined) {
    visibility.grid = source.showGrid
  }
  return visibility
}

export function isLayerVisible(visibility: LayerVisibility, key: LayerKey): boolean {
  return visibility[key] !== false
}

/** 返回一份新对象（不原地改，便于"设置变更 → 请求重绘"的比较与撤销语义清晰） */
export function withLayerVisibility(visibility: LayerVisibility, key: LayerKey, value: boolean): LayerVisibility {
  if (visibility[key] === value) return visibility
  return { ...visibility, [key]: value }
}

/** 当前被隐藏的图层名（给状态命令输出用，让"地图怎么少了东西"有一个可查的答案） */
export function hiddenLayerLabels(visibility: LayerVisibility): string[] {
  return LAYER_TABLE.filter((spec) => !isLayerVisible(visibility, spec.id)).map((spec) => spec.label)
}

/** 是否全部隐藏（用于给出"你把所有图层都关了"这种可读提示） */
export function allLayersHidden(visibility: LayerVisibility): boolean {
  return LAYER_TABLE.every((spec) => !isLayerVisible(visibility, spec.id))
}