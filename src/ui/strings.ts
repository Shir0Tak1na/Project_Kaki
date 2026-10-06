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

/**
 * 面板「工具 / 笔刷 / 选择方式」三节与「视图」一节在**空态**时说的两句话
 * （冒烟逐字比较 → 判据 ①）。
 *
 * 为什么必须分成两句（ISSUE-007）：`getStatus()` 为 `null` 有**两种完全不同的原因** ——
 * ①用户切到了一篇普通笔记 / PDF（**没有当前地图**，画布开在后台也算）；②画布开着但没启用地图层。
 * 不区分就会让用户在笔记里看到"当前没有启用的地图层"这句**假话**（地图层其实还开着），
 * 于是他不会意识到"这里已经不该动了"。
 */
export const PANEL_EMPTY_HINTS = {
  /** 没有当前画布（用户在看别的文档 / 一张画布都没开） */
  noActiveMap: '当前没有打开的地图：切回一张 Canvas（或点一下画布）之后，这里才有可改的东西。',
  /** 有当前画布，但它没启用地图层 */
  noLayer: '当前没有启用的地图层：打开一张地图并启用地图层之后，这里才有可改的东西。',
} as const

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

/* =========================================================================
 * C4 第三批（2026-10-06）：把"带数字 / 带原因"的**模板**收成函数。
 *
 * 与第二批的区别只有一处：那一批收的是**固定串**（常量就够），这一批是
 * 「`编辑：${层名}笔刷 · ${运算符}${数值}`」这类**模板** —— 它们面对的数据每一刻都在变，
 * 所以只能做成**函数**（`(值) => 串`），断言才可能读同一份实现。
 *
 * 判据仍然是那两条（见文件头）。**不收**的也写在这里，免得下次又被"顺手收进来"：
 * - 工具条的**提示行**（"按 D 进入绘制模式…"那几句）：描述性长句，按设计不收；
 * - 图例自己的标题 / 空态（`图例` / `地图上还没有可列出的内容`）：**没有任何断言钉它们**，
 *   也不属于"经常改"—— 按判据 ①② 都不该收（收了只会让这张表变长）；
 * - 错误 / 诊断长句（`找不到地图文档：…` 之类）：第二批就定过口径，不收。
 * ========================================================================= */

/**
 * 选择方式的界面名（`MapEditor.selectionMode` → 人话）。
 *
 * 两处共用：工具条状态行（`选择 · 矩形框选 · 14 格`）与侧栏「选择方式」那一组按钮，
 * 而冒烟对**两处**都做过逐字比较 ⇒ 判据 ①。
 */
export const SELECTION_MODE_LABELS = {
  rect: '矩形框选',
  /** 键是 `MapEditor.SelectionMode` 的取值 `brush`（它指的是**笔迹**扫过，不是地形笔刷） */
  brush: '笔迹框选',
} as const

export function selectionModeLabel(mode: 'rect' | 'brush'): string {
  return SELECTION_MODE_LABELS[mode]
}

/**
 * 画布左上角状态浮窗的三行（标题 / 副行）。
 *
 * 为什么这一组几乎全是函数：这一行是"**会计数**的一句话"（几格、哪一层、什么运算、多少值），
 * 关键词不多但每种组合都被冒烟逐字比过（判据 ①）。标题与副行的分工写在 `MapToolbar` 里，
 * 这里是它们**唯一**的写法 —— 改一个字只改这一处。
 *
 * ⚠️ 两个前缀必须是**下面这两个常量**（而不是在四串里各写一份 `'绘制 · '`）：
 * 它们既是"拼串时的一段"，又是"断言里那条正则的一段" —— 漏改一处不会报错，只会让正则对不上。
 * 这也是"改词验证（改常量 → 四道门应全绿）"能成立的前提：**片段与整串必须同源**。
 */
const PAINT_PREFIX = '绘制 · '
const EDIT_PREFIX = '编辑：'

export const TOOLBAR_TEXT = {
  /** 标题行的前缀（冒烟有一条 `^绘制 · .+` 的形状断言，它从这里拼正则） */
  paintPrefix: PAINT_PREFIX,
  idle: '空闲',
  paintTerrainBrush: `${PAINT_PREFIX}地形笔刷`,
  paintFieldBrush: `${PAINT_PREFIX}数值图层笔刷`,
  paintTool: (toolLabel: string): string => `${PAINT_PREFIX}${toolLabel}`,
  selection: (mode: string, count: number): string => `选择 · ${mode} · ${count} 格`,
  terrainBrush: (terrain: string): string => `${EDIT_PREFIX}地形笔刷 · ${terrain}`,
  /** 数值图层笔刷的参数（`＝12` / `+12`） */
  fieldBrush: (field: string, op: string, value: string | number): string =>
    `${EDIT_PREFIX}${field}笔刷 · ${op}${value}`,
  /** 分类字段（生物群系）的参数：显示名而不是 ID */
  categoryBrush: (field: string, entry: string): string => `${EDIT_PREFIX}${field}笔刷 · ${entry}`,
  /** 笔刷不可用时的状态行（原因来自 `BRUSH_REASONS`） */
  fieldBrushBlocked: (reason: string): string => `${EDIT_PREFIX}数值图层笔刷 · ${reason}`,
  /**
   * 运算符的界面写法（`set` → `＝`）。
   *
   * 做成函数而不是让调用方自己映射：这个符号是**状态行那个串的一部分**，
   * 而冒烟是拿"层名 + 运算符 + 数值"拼出期望串的 —— 两处各写一份 `'＝'` 就又是一次"改一处漏一处"。
   */
  brushOpLabel: (op: string): string => (op === 'set' ? '＝' : op),
} as const

/**
 * "笔刷现在刷不动"的四种原因（`MapEditor.brushReadiness`）。
 *
 * 它们会被**原样**显示在状态浮窗**和**侧栏「笔刷」一节的提示行里 —— 两处各写一份必然分叉，
 * 而分叉的表现是"浮窗说 A、侧栏说 B"，用户不知道该信哪个。
 * 冒烟与 `tests/biomes.test.ts` 都逐字（或正则）比过它们 ⇒ 判据 ①。
 */
export const BRUSH_REASONS = {
  noBiome: '请先选一个生物群系',
  noValue: '请先填一个数值',
  unconfirmedValue: '按回车确认这个数值后笔刷才生效',
  divideByZero: '不能除以 0',
} as const

/**
 * 「地图定义」弹窗里**每一行控件的名字**。
 *
 * 形状都是 `前缀 · <显示名>`：四条前缀 × 四类定义 = 十二种组合，冒烟对其中大多数
 * 逐字比较过（`外观 · 河流` / `线宽与虚线 · 河流` / `填充与边框 · 王国` / `字形 · 沼泽地`…）
 * ⇒ 判据 ①。**同一个前缀在多类定义里复用**（`名称 · …` 用于标记 / 路径 / 区域），
 * 所以这里是"一个函数一个前缀"，而不是"一类定义一张表"。
 */
export const DEFINITION_ROW_LABELS = {
  /** 恢复内置路径 / 区域类型参数的按钮（唯一一条不带显示名的） */
  resetPathRegionParams: '路径与区域类型参数恢复出厂',
  terrainNameColor: (label: string): string => `名称与颜色 · ${label}`,
  glyph: (label: string): string => `字形 · ${label}`,
  image: (label: string): string => `图片 · ${label}`,
  imageLayout: (label: string): string => `图片排版 · ${label}`,
  name: (label: string): string => `名称 · ${label}`,
  appearance: (label: string): string => `外观 · ${label}`,
  widthDash: (label: string): string => `线宽与虚线 · ${label}`,
  fillBorder: (label: string): string => `填充与边框 · ${label}`,
  borderWidthDash: (label: string): string => `边框宽与虚线 · ${label}`,
} as const

/**
 * Base 视图（`MapBasesView`）里**被断言盯着**的那些词。
 *
 * `kind` 那一列的五个人话名与"来源"列的 `笔记 / 地图` 是同一批（同一个词要在两处说得一样），
 * 而 `区域` / `笔记` / `地图` 三个都被冒烟逐字比较过 ⇒ 判据 ①。
 * 表头与空态说明**不收**：前者断言只按下标取值（没有逐字比），后者是描述性长句。
 */
export const BASE_TEXT = {
  kind: {
    note: '笔记',
    marker: '标记',
    label: '文字',
    path: '路径',
    region: '区域',
  },
  sourceNote: '笔记',
  sourceMap: '地图',
  noCoords: '—',
  /** 摘要行：`笔记 4 · 地图条目 2 · 共 6` */
  summary: (notes: number, mapEntries: number, total: number): string =>
    `笔记 ${notes} · 地图条目 ${mapEntries} · 共 ${total}`,
} as const
