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
import { drawOverlayLayer } from './overlayDraw.ts'
import { OVERLAY_FIELDS, type FieldId, type OverlayFieldSpec, type OverlayMode, type OverlayStyle } from './overlayFields.ts'
import type { OverlayFieldCache } from './overlayPlan.ts'
import type { MapRenderPlan } from './renderPlan.ts'

/**
 * 绘制钩子的**回报**（可选）。让"这一层这一帧画了多少东西"进入覆盖层统计，
 * 于是"叠加层没画出来"能被断言抓到，而不是靠肉眼看截图（同 `lastGridCells` 的口径）。
 */
export interface LayerDrawOutcome {
  /** 本帧画出的图元个数（数值图层是"色块数"） */
  drawn: number
  /** 其中走了"越界纯色"的个数（只有配色类图层有这个概念） */
  outOfRange?: number
  /** 画出的数值文字个数（数值图层） */
  labels?: number
  /** 画出的等值线折线条数（连续场才有；逐格模式是 0） */
  contours?: number
  /**
   * 这一层本帧用的显示方式（数值图层才有）。
   *
   * 名字与 `drawOverlayLayer` 的返回值**必须一致**：统计字段是"真实渲染确实按设置走"的证据，
   * 名字对不上时它的表现是"永远是 null"（那种静默错位最难查）。
   */
  mode?: OverlayMode
}

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
  /**
   * 这一层要画的数据字段与它的渲染样式（配色 / 透明度 / 是否画数值）。
   *
   * 只有**声明了 `overlay` 的行**才有值；由绘制层每帧从设置里现读，
   * 所以"在设置里改了配色 → 下一帧就是新颜色"，不需要任何广播。
   */
  overlay?: { spec: OverlayFieldSpec; style: OverlayStyle }
  /**
   * 这一层**连续场采样的缓存**（由绘制层持有、每个字段一份）。
   *
   * 放在这里而不是让钩子自己存模块级变量：地图层实例活得比一帧长，而"哪个 canvas 的哪一层"
   * 只有绘制层知道。钩子只管用，不管它住在哪。
   */
  fieldCache?: OverlayFieldCache
  /**
   * 造一张**离屏画布**（连续场的颜色面要先落在自己的一张画布上，再缩放铺开）。
   *
   * 与地形图集同一条路：本模块（以及 `overlayDraw`）不碰 DOM，造画布的能力由绘制层注入。
   * 取不到时连续场**退回不画**，而不是抛异常把整帧带塌。
   */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement | null
  /**
   * **分类字段**的"分类 ID → 颜色"（现读目录：内置 + 自定义）。
   *
   * 与 `overlay` 同一条路：由绘制层每帧现读设置、递进钩子；钩子（`drawOverlayLayer`）
   * 原样转给 `buildOverlayPlan`。数值字段用不到它（它们有配色）。
   */
  categoryColors?: ReadonlyMap<string, string>
}

interface LayerSpecShape {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly describe: string
  readonly defaultVisible: boolean
  readonly isDataLayer: boolean
  readonly order: number
  /**
   * 侧栏「显示」里它属于哪一组（施工文件 §F.1 那条"每个开关只出现在一处"的切法）。
   *
   * - `base` = **底图**：地形、六边形网格，以及三条数值图层的覆盖染色（温度 / 深度 / 生物群系）——
   *   它们都是"地图的底色"，回答"这片地方长什么样"；
   * - `feature` = **地物**：区域、路径、标记、名称 —— 它们都是"画在底图上的东西"，
   *   回答"这片地方上有什么"。
   *
   * 刻意做成表里的一列（而不是在面板里按 id 硬编码）：**加一层仍然只加一行**，
   * 而且"这一层属于哪一组"与"它叫什么、出厂开不开"放在一起，不会分叉。
   */
  readonly displayGroup: 'base' | 'feature'
  /** 这一层画的是哪个**数据字段**（数值图层才有；见 `overlayFields.ts`） */
  readonly overlay?: FieldId
  readonly draw?: (context: LayerDrawContext) => LayerDrawOutcome | void
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
    displayGroup: 'base',
    order: 10,
  },
  {
    id: 'temperature',
    label: '温度',
    hint: '格上温度的配色染色（叠加在地形之上、网格之下）',
    describe:
      '把格上温度按配色染色；越出上下限的格按"离端值多远"渐变到极色。' +
      '开关只决定看不看，地图文件里的温度不受影响。',
    defaultVisible: false,
    isDataLayer: true,
    displayGroup: 'base',
    // 压在地形之上、网格与矢量对象之下（路径与名称不该被色块糊住）
    order: 12,
    overlay: 'temperature',
    draw: drawOverlayLayer,
  },
  {
    id: 'depth',
    label: '深度',
    hint: '格上深度 / 海拔的配色染色（与温度同一种数值图层，叠在地形之上）',
    describe:
      '0 = 海平面，正 = 向下，负 = 向上；按配色染色（出厂 低 → 高 = 黑 → 白）。' +
      '开关只决定看不看，地图文件里的深度值不受影响。',
    defaultVisible: false,
    isDataLayer: true,
    displayGroup: 'base',
    // 紧挨温度之下、仍在网格与矢量对象之下（两条数值图层不该互相遮挡，也不能糊住路径与名称）
    order: 14,
    overlay: 'depth',
    draw: drawOverlayLayer,
  },
  {
    id: 'biome',
    label: '生物群系',
    hint: '格上生物群系的分类配色（与温度 / 深度同一种数值图层，叠在地形之上）',
    describe:
      '每一格按它自己那条生物群系的颜色上色（分类配色可在设置页覆盖）。' +
      '开关只决定看不看，地图文件里的 biome 值不受影响。',
    defaultVisible: false,
    isDataLayer: true,
    displayGroup: 'base',
    // 与温度 / 深度同一条带（12 / 14 / 16）：三条数值图层叠在地形之上、网格与矢量对象之下。
    // 放在最后是因为它最"花"（分类配色），被路径与名称压住才不会喧宾夺主。
    order: 16,
    overlay: 'biome',
    draw: drawOverlayLayer,
  },
  {
    id: 'grid',
    label: '网格',
    hint: '六边形网格线',
    describe: '六边形网格线。工具条上也有同一个开关（设置页原来那个「显示六边形网格」已并入这里）。',
    defaultVisible: true,
    isDataLayer: false,
    displayGroup: 'base',
    order: 20,
  },
  {
    id: 'regions',
    label: '区域',
    hint: '半透明的领地范围',
    describe: '半透明区域填充与边框（国境、领地）。',
    defaultVisible: true,
    isDataLayer: true,
    displayGroup: 'feature',
    order: 30,
  },
  {
    id: 'paths',
    label: '路径',
    hint: '河流 / 道路 / 贸易路线 / 边界',
    describe: '河流、道路、贸易路线、边界。',
    defaultVisible: true,
    isDataLayer: true,
    displayGroup: 'feature',
    order: 40,
  },
  {
    id: 'markers',
    label: '标记',
    hint: '地标标记与文字标注',
    describe: '标记与文字标注（画布上可点击、可拖动的那些实体）。',
    defaultVisible: true,
    isDataLayer: true,
    displayGroup: 'feature',
    order: 50,
  },
  {
    id: 'labels',
    label: '名称',
    hint: '路径与区域的名称文字',
    describe: '路径与区域的名称标注。工具条上的「名称」按钮切换的是同一个值。',
    defaultVisible: true,
    isDataLayer: false,
    displayGroup: 'feature',
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
  /** 侧栏「视图」里它属于哪一小组（`base` = 底图 / `feature` = 地物） */
  displayGroup: 'base' | 'feature'
  overlay?: FieldId
  draw?: (context: LayerDrawContext) => LayerDrawOutcome | void
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

/**
 * 笔刷现在要刷的那个**数据字段**，它那一层是不是**关着的**（关着 ⇒ 刷进去看不见）。
 *
 * ## 为什么需要这一条（ISSUE-008，用户报"笔刷工作不正常"）
 *
 * 数据图层**出厂是关着的**（`defaultVisible: false`），而笔刷**照旧能写**（这是对的：
 * 图层是"看不看"、不是"有没有"，§E 与 `renderPlan.ts` 都把这条写死了）。
 * 但两者叠在一起就是一个**静默失败**：数据真的写进了文件，屏幕上**一个像素都不变**，
 * 也没有任何一句话解释 —— 用户只能得出"笔刷坏了"。
 *
 * ## 为什么是"提示"而不是"拦下"或"自动打开"
 *
 * - **不拦**：那会把"编辑数据"绑死在"看不看"上，与上面那条分层口径直接冲突；
 * - **不自动打开**：图层开关是用户自己的选择，替他改会让人困惑（"我没开它怎么亮了"）；
 * - 于是只剩一条**必须做到**的事：**说清为什么看不见、以及去哪里打开**（呼叫方负责说）。
 *
 * 地形层（`field === null`）永远返回 `false`：地形是底图，没有"看不见"这回事。
 */
export function brushFieldLayerHidden(field: FieldId | null, visibility: LayerVisibility): boolean {
  if (field === null) return false
  // 字段 → 图层 的权威映射写在字段表里（`OverlayFieldSpec.layerId`），别在这里另写一份
  const spec = OVERLAY_FIELDS.find((item) => item.id === field)
  return spec !== undefined && !isLayerVisible(visibility, spec.layerId)
}

/** 是否全部隐藏（用于给出"你把所有图层都关了"这种可读提示） */
export function allLayersHidden(visibility: LayerVisibility): boolean {
  return LAYER_TABLE.every((spec) => !isLayerVisible(visibility, spec.id))
}