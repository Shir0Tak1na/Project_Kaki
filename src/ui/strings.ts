/**
 * 界面文案的**单一来源**（施工文件 `docs/UI-COPY-REVIEW.md` §5 的 C4）。
 *
 * 为什么要有它：冒烟里有几十处**逐字比较界面文本**（`scripts/smoke.mjs`）。文案写死在两处时，
 * 改一句话要同时改实现与断言 —— 那就是「改文案必然牵动测试」的根源。
 * 把**被断言钉住**的那些串收在这里：实现与断言读同一个常量，改文案只改这一个文件。
 *
 * 收进来的判据（**不是**所有中文串都要搬家）：
 * 1. **冒烟逐字比较过**它（硬判据，别凭感觉扩表）；
 * 2. 或者它**经常改**（数据层控件名、绘制模式名、未定义类型的标签）。
 * 描述性长句**不收**：它们本来就该随文案轮改，且很少被逐字断言。
 */

import type { GeometryMode } from '../core/hexEdges.ts'

/** 绘制模式的五个人话名（`GeometryMode` → 界面文字；侧栏按钮与浮窗提示共用） */
export const DRAW_MODE_LABELS = {
  edge: '沿网格走',
  center: '沿格心走',
  step: '逐格前进',
  interior: '锚点折线',
  free: '自由绘制',
} as const

/**
 * 每个绘制模式的一句话提示（**≤20 字**；侧栏按钮的 `title` 与浮窗提示行共用）。
 *
 * 为什么要写成短句而不是长说明：这五个按钮并排一行，长说明只能挂在 hover 上，
 * 而用户判断"该点哪一个"往往发生在**不 hover** 的时候（§5.77 的同一类问题）。
 * 短句读得完，长解释留在本文件与 `USER-MANUAL.md` 里。
 */
export const DRAW_MODE_HINTS = {
  edge: '落点吸附格点，段段沿网格线',
  center: '逐格点击，线穿过格心，顶点可编辑',
  step: '每次点击沿网格线前进一条边',
  interior: '点哪连哪的折线，顶点可再编辑',
  free: '按住左键随手画，没有可拖顶点',
} as const

/**
 * `GeometryMode` → `DRAW_MODE_*` 的键（界面上 `edge-step` 叫「step」）。
 *
 * ⚠️ 这个表的**顺序**要与侧栏按钮一致（两个「走」相邻：沿网格走 · 沿格心走，
 * 再是逐格前进 · 锚点折线 · 自由绘制）—— 按钮顺序的**单一来源**是 `toolSections.ts` 的
 * `GEOMETRY_OPTIONS`，这里跟着排只是为了让"读这张表"与"看界面"是同一个顺序。
 */
const DRAW_MODE_KEYS: Record<GeometryMode, keyof typeof DRAW_MODE_LABELS> = {
  edge: 'edge',
  center: 'center',
  'edge-step': 'step',
  interior: 'interior',
  free: 'free',
}

/** 绘制模式的界面名（浮窗 / 侧栏 / 任何要显示"现在是什么模式"的地方都走这里） */
export function drawModeLabel(mode: GeometryMode): string {
  return DRAW_MODE_LABELS[DRAW_MODE_KEYS[mode]]
}

/** 绘制模式的一句话提示（同上：单一来源，别在别处再写一份） */
export function drawModeHint(mode: GeometryMode): string {
  return DRAW_MODE_HINTS[DRAW_MODE_KEYS[mode]]
}

/**
 * 本机没有这条定义时的显示名（图例 / 下拉 / Base 行 / 面板共用一份）。
 *
 * 为什么带 ID：用户看到「未定义类型」还知道去改哪一条；只写「未知」等于让他自己猜。
 */
export function unknownTypeLabel(id: string): string {
  return `未定义类型（${id}）`
}

/** 数据层那一组控件的名字（`spec.label` 是字段名：温度 / 深度 / 生物群系） */
export const OVERLAY_CONTROL_LABELS = {
  unit: (field: string): string => `${field}的展示单位`,
  opacity: (field: string): string => `${field}层的不透明度`,
  mode: (field: string): string => `${field}的显示方式`,
  contourInterval: (field: string): string => `${field}的等值线间距`,
  contourLabelSpacing: (field: string): string => `${field}等值线数字的重复间隔`,
  categoryColors: (field: string): string => `${field}的逐条颜色`,
  showValues: '在每个格上写出数值',
  resetRamp: '恢复出厂配色',
  rampOnlyPointer: '不透明度 / 显示方式 / 等值线 / 写出数值在设置页的「数值图层」里。',
} as const

/* =========================================================================
 * C4 第二批（2026-10-01）：按**表面**分组继续收。
 *
 * 判据仍然是那两条（见文件头）—— ① 被 `scripts/smoke.mjs` / `tests/**` 逐字比较过；
 * ② 或者经常改。**描述性长句与错误 / 诊断文案一律不收**：
 * 它们本来就该随文案轮改，且极少被逐字断言（§5.78）。
 * 只收「断言直接盯着的那个元素所渲染的串」，不收"某句长说明里提到了某个词"。
 * ========================================================================= */

/** 设置页的控件名 / 占位符 / 按钮（冒烟逐字比较名称与占位符 → 判据 ①；`开发者模式` 还出现在面板「开发工具」组标题里 → 也满足 ②） */
export const SETTINGS_LABELS = {
  developerMode: '开发者模式',
  currentLabelPx: '当前实际字号',
  labelFont: '名称字体',
  labelFontPlaceholder: '留空 = 跟随主题',
  quickStartShowAgain: '重新显示',
  resetRampButton: '恢复默认',
} as const

/** 配色轴检视行：点两端端帽时报"这是哪一端"（冒烟逐字比较 `低于最低限度` → 判据 ①；两者成对，一起改） */
export const RAMP_AXIS_LABELS = {
  underMin: '低于最低限度',
  overMax: '高于最高限度',
} as const

/** 弹窗动作按钮：同一个词在多个弹窗里各写一份（判据 ②），且冒烟逐字比较 `保存` / `清空全部` / `删除` / `改 ID…`（判据 ①） */
export const MODAL_ACTIONS = {
  save: '保存',
  clearAll: '清空全部',
  delete: '删除',
  renameId: '改 ID…',
} as const

/** 「地图定义」弹窗自己的标题与四条"新增自定义…"（冒烟逐字比较 → 判据 ①） */
export const DEFINITION_MODAL_LABELS = {
  title: '地图定义',
  addTerrain: '新增自定义地形',
  addMarker: '新增自定义标记',
  addPathType: '新增自定义路径类型',
  addRegionType: '新增自定义区域类型',
} as const

/** 文件选择 / 导入弹窗的标题与按钮（冒烟逐字比较弹窗标题与按钮文字 → 判据 ①） */
export const DIALOG_LABELS = {
  importDefinitions: '导入定义文件',
  pickDefinitionFile: '选择定义文件…',
  overwriteAll: '全部设为覆盖',
} as const

/**
 * 侧栏面板各节的标题（冒烟按**从上到下的顺序**逐字比较这九个 → 判据 ①）。
 *
 * 顺序的单一来源仍是渲染代码；这里收的是"标题文字"本身 —— 断言里那一串
 * `数据显示>工具>…` 要能跟着这里一起改。
 */
export const PANEL_SECTION_TITLES = {
  data: '数据显示',
  tools: '工具',
  brush: '笔刷',
  selectionMode: '选择方式',
  edit: '编辑',
  view: '视图',
  mapLayers: '地图层',
  definitions: DEFINITION_MODAL_LABELS.title,
  fileExport: '文件与导出',
} as const

/** 面板「开发工具」组标题：它不是固定串（含 `开发者模式`），所以做成函数而不是常量 */
export function devToolsSectionTitle(): string {
  return `开发工具（仅${SETTINGS_LABELS.developerMode}）`
}

/** 面板里带数字的标题（冒烟逐字比较 `已选 2 个标记` / `整批编辑（14 格）` / `删除这 2 个` → 判据 ①） */
export const PANEL_TITLES = {
  objectBatch: (count: number, kind: string): string => `已选 ${count} 个${kind}`,
  batchEdit: (count: number): string => `整批编辑（${count} 格）`,
  deleteMany: (count: number): string => `删除这 ${count} 个`,
  /** 多选时公共类型"各不相同"的占位选项（冒烟按 `.includes('各不相同')` 比较 → 判据 ①） */
  typeMixed: '（各不相同 · 选一个就能统一）',
} as const

/** 选择信息卡 / 侧栏读数共用的几种写法（冒烟与 `tests/selectionCard.test.ts` 逐字比较 → 判据 ①） */
export const SELECTION_TEXT = {
  unfilled: '未填',
  rangeLabel: '坐标范围',
  multiTitle: (count: number): string => `已选 ${count} 格`,
  objectTitle: (kind: string, label: string): string => `${kind}：${label}`,
} as const

/** 命令名（冒烟按 `.includes` 逐字比较 → 判据 ①；命令名也是改得最频繁的一类界面文案 → ②） */
export const COMMAND_NAMES = {
  openPanel: '打开地图面板',
  toggleLayer: '启用/停用当前 Canvas 的地图层',
  exportSvg: '导出当前地图为 SVG',
  statusReport: '地图状态报告',
} as const

/** 状态报告里的两段前缀与"全部显示"那一行（冒烟逐字比较 → 判据 ①） */
export const STATUS_SECTIONS = {
  layerPrefix: '图层：',
  layersAllVisible: '图层：全部显示',
  legendPrefix: '图例：',
} as const

/** 常被冒烟搜到的短 Notice 句子（出现频次高、每轮文案都在动 → 判据 ①＋②） */
export const NOTICES = {
  layerEnabled: '已启用地图层',
  noExportableMap: '当前 Canvas 没有可导出的地图。请先启用地图层。',
  pngFailedPrefix: '导出 PNG 失败',
  svgExportedPrefix: '已导出地图 SVG',
  baseExists: '已存在同名 Base 文件',
} as const
