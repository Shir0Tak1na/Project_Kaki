/**
 * 选择系统的**筛选器规则表** —— **纯函数模块，不 import obsidian**。
 *
 * 设计依据：施工文件 `DATA-LAYER-PLAN-v5.md` §C.2。形状照 **Minecraft 目标选择器** 那一类：
 *
 * ```
 * 规则 := { join: 'and' | 'or', negate: boolean, clauses: 子句[] }
 * 子句 := { key: 规则键, op: 运算符, value: 值 }
 * ```
 *
 * 三条分工（写死，避免混成一锅）：
 * 1. **规则只做"逐格谓词"** —— 这一格满不满足，不碰集合；
 * 2. **动作负责集合运算** —— 替换 / 并入 / 移出选择（见 `selectionSet.ts`）；
 * 3. **连通扩展是动作**，不是规则（它要邻域遍历，不是逐格判断）。
 *
 * "加一条筛选规则 = 加一行"这条纪律落在这里：
 * - **数值字段的规则是生成的**（遍历 `OVERLAY_FIELDS` 里 `numeric` 的那些），
 *   于是以后加一个数值字段，筛选器自动多出"按这个字段筛"的能力，一行都不用写；
 * - 地形 / 生物群系这类**枚举**规则也各只占一行；
 * - 每个规则自带 `ops`（允许哪些运算符）与 `valueKind`（界面该渲染成下拉、数字框还是两个数字框），
 *   所以**界面不认识任何一条具体规则**（见 `ui/SelectionFilterModal.ts`）。
 *
 * 界面**不做文本语法**（用户提过"上手难度很大，建议做成 UI"）：IR 是共享的，
 * 将来要加语法补全只是"同一份 IR 的另一个输入方式"。
 */

import type { TerrainCell } from '../data/mapDocument.ts'
import { isNumericField, NUMERIC_OVERLAY_FIELDS, type NumericOverlayFieldSpec } from './overlayFields.ts'

/* ------------------------------------------------------------------ 规则 IR */

/** 允许的运算符。`in` 用于枚举多选，`between` 用于范围（值是两个数的数组） */
export type RuleOp = '=' | '≠' | '>' | '≥' | '<' | '≤' | 'in' | 'between' | 'exists'

/** 值的形状 → 界面渲染成什么控件（下拉 / 数字框 / 两个数字框 / 开关） */
export type RuleValueKind = 'enum' | 'number' | 'range' | 'boolean'

/** 子句的值：数字、两个数的范围、字符串（枚举）或它们的数组（`in`）、布尔（`exists`） */
export type RuleValue = number | string | boolean | readonly number[] | readonly string[]

export interface RuleClause {
  /** 规则键（`terrain` / `temp` / `depth` / `biome` …） */
  key: string
  op: RuleOp
  value: RuleValue
}

export interface RuleGroup {
  join: 'and' | 'or'
  /** 整组取反（"不是这些"）。子句级的取反用 `≠` / 移出动作表达，不另设字段 */
  negate: boolean
  clauses: RuleClause[]
}

/** 空的规则组（界面上的初始状态：一条子句都没有） */
export function emptyRuleGroup(): RuleGroup {
  return { join: 'and', negate: false, clauses: [] }
}

/* ------------------------------------------------------------------ 规则登记表 */

/** 枚举选项（地形类型、生物群系…）：由**调用方**从当前目录（内置 + 自定义）现取，表里不写死 */
export interface RuleEnumOption {
  value: string
  label: string
  /**
   * 这一项**自带的标签**（生物群系用）。
   *
   * 为什么标签挂在选项上、而不是另开一张"值 → 标签"的表：`biomeTag` 规则要在
   * **不知道目录**的纯函数里判断"这一格的群系带不带这个标签"，而 `match` 只拿得到
   * 规则上下文 —— 于是标签跟着选项一起进来，比再传一个映射函数少一层约定。
   */
  tags?: readonly string[]
}

export interface SelectionRuleSpec {
  /** 规则键：写进 IR、也用来在界面里定位这条规则 */
  key: string
  /** 下拉里显示的名字（`地形` / `温度` …） */
  label: string
  /** 这条规则允许的运算符（界面只列这几个，用户点不出非法组合） */
  ops: readonly RuleOp[]
  /** 值的形状 → 决定界面控件 */
  valueKind: RuleValueKind
  /** 单位后缀（数值规则用；`温度` 是 `℃`，`深度` 是 `m`），显示在 `describe` 里 */
  unit?: string
  /**
   * 枚举规则的候选项（**现取**：内置 + 用户自定义）。只有 `valueKind === 'enum'` 时给。
   *
   * 为什么做成函数而不是数组：地形 / 生物群系目录会随设置变化，
   * 表是模块级常量 —— 常量化它就等于"改了定义要重启插件才对"。
   */
  options?: (context: SelectionRuleContext) => readonly RuleEnumOption[]
  /** 纯函数：这条子句怎么念（人话回显）。`context` 用来把 ID 翻成显示名（地形 / 生物群系） */
  describe: (op: RuleOp, value: RuleValue, context: SelectionRuleContext) => string
  /**
   * 纯函数：**这一格**满不满足这条子句。
   *
   * `context` 给"目录相关"的规则用（`biomeTag` 要知道某个群系带哪些标签）。
   * **刻意是可选参数**：绝大多数规则（地形 / 温度 / 深度 / 精确匹配的 biome）不需要它，
   * 于是调用方与测试可以只传三个参数；不传时按"没有目录信息"处理 ——
   * 依赖目录的那条规则此时**筛不中**（而不是"筛中全部"：宁可少选，也不能多选错的东西）。
   */
  match: (
    cell: TerrainCell | undefined,
    op: RuleOp,
    value: RuleValue,
    context?: SelectionRuleContext,
  ) => boolean
}

/** 界面把"现在有哪些地形 / 生物群系（含各自的标签）"传进来（表不自己去看设置） */
export interface SelectionRuleContext {
  /** 地形（每一项可以带 `tags`，`terrainTag` 规则据此匹配） */
  terrains?: readonly RuleEnumOption[]
  /** 地形的**标签**候选（`terrainTag` 规则的下拉里列这些） */
  terrainTags?: readonly RuleEnumOption[]
  /** 生物群系（每一项可以带 `tags`，`biomeTag` 规则据此匹配） */
  biomes?: readonly RuleEnumOption[]
  /** 生物群系的**标签**候选（`biomeTag` 规则的下拉里列这些） */
  biomeTags?: readonly RuleEnumOption[]
}

/**
 * 运算符的**显示名**（值仍然是不变的 token）。
 *
 * 为什么必须有：ISSUE-003 的第一条证据就是"运算符下拉里写的是 `in` / `between` / `exists`"——
 * 用户看不懂，而这三个词与 IR 里的 token 同名，看起来像"界面没做完"。
 * 口径（`UI-COPY-REVIEW.md` §4.1）：**只改显示名，token 一个都不动** ——
 * IR 是共享的（将来要加文本语法也是同一份），把 token 改成中文才是真会出事的做法。
 * ``>` `≥` `<` `≤`` 保持符号：它们本来就是通用写法，换成"大于"反而更长。
 */
export const RULE_OP_LABELS: Record<RuleOp, string> = {
  '=': '等于',
  '≠': '不等于',
  '>': '>',
  '≥': '≥',
  '<': '<',
  '≤': '≤',
  in: '属于其中之一',
  between: '介于…之间',
  exists: '有 / 没有这个数据',
}

/** 取运算符的显示名（认不出的 token 原样返回 —— 手改过的 IR 也不该让界面空着） */
export function ruleOpLabel(op: RuleOp): string {
  return RULE_OP_LABELS[op] ?? op
}

const NUMERIC_OPS: readonly RuleOp[] = ['=', '≠', '>', '≥', '<', '≤', 'between', 'exists']
const ENUM_OPS: readonly RuleOp[] = ['=', '≠', 'in', 'exists']

function asNumber(value: RuleValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRange(value: RuleValue): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [min, max] = value as readonly number[]
  if (typeof min !== 'number' || typeof max !== 'number') return null
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return [min, max]
}

function asStrings(value: RuleValue): string[] | null {
  if (!Array.isArray(value)) {
    return typeof value === 'string' && value.length > 0 ? [value] : null
  }
  const list = (value as readonly unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0)
  return list.length > 0 ? [...list] : null
}

function asBoolean(value: RuleValue): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * 一条**数值字段**规则（温度 / 深度…按 `OVERLAY_FIELDS` 生成）。
 *
 * 口径：格上**没有这个值**时，所有比较都返回 `false`（"没量过"不满足"温度 ≥ 10"）；
 * 只有 `exists` 例外 —— 它问的就是"有没有值"。
 */
function numericFieldRule(spec: NumericOverlayFieldSpec): SelectionRuleSpec {
  return {
    key: spec.cellKey,
    label: spec.label,
    ops: NUMERIC_OPS,
    valueKind: 'number',
    unit: spec.unit,
    match: (cell, op, value) => {
      const actual = spec.read(cell)
      if (op === 'exists') {
        const wanted = asBoolean(value)
        return wanted === null ? false : wanted === (actual !== undefined)
      }
      if (actual === undefined) return false
      if (op === 'between') {
        const range = asRange(value)
        return range === null ? false : actual >= range[0] && actual <= range[1]
      }
      const expected = asNumber(value)
      if (expected === null) return false
      switch (op) {
        case '=':
          return actual === expected
        case '≠':
          return actual !== expected
        case '>':
          return actual > expected
        case '≥':
          return actual >= expected
        case '<':
          return actual < expected
        case '≤':
          return actual <= expected
        default:
          return false
      }
    },
    describe: (op, value) => {
      const unit = spec.unit ?? ''
      if (op === 'exists') return asBoolean(value) === true ? `有${spec.label}值` : `没有${spec.label}值`
      if (op === 'between') {
        const range = asRange(value)
        return range === null ? `${spec.label} 范围（未填完）` : `${spec.label} ${range[0]}–${range[1]}${unit}`
      }
      const expected = asNumber(value)
      return expected === null ? `${spec.label} ${op}（未填）` : `${spec.label} ${op} ${expected}${unit}`
    },
  }
}

function firstString(value: RuleValue): string | null {
  const wanted = asStrings(value)
  return wanted === null ? null : wanted[0]!
}

/**
 * 把枚举 ID 翻成显示名（"forest" → "森林"）。
 *
 * 为什么人话回显要带 context：回显是用户**唯一**能确认"我到底筛了什么"的地方，
 * 里面写英文 slug（`地形 = forest`）等于把 ID 当成名字给用户看 —— 与"界面不许显示内部名"
 * 是同一条纪律（见 `selection.ts` 里 `label` 那一列的用意）。取不到目录时**回退成 ID**，
 * 而不是显示空白（宁可显示 slug，也不能显示"未知"）。
 */
function enumLabel(options: readonly RuleEnumOption[] | undefined, id: string): string {
  return options?.find((option) => option.value === id)?.label ?? id
}

/** 地形类型规则：值就是格上的 `t`（未知地形也照比 —— 筛选器不该假装它不存在） */
const TERRAIN_RULE: SelectionRuleSpec = {
  key: 'terrain',
  label: '地形',
  ops: ENUM_OPS,
  valueKind: 'enum',
  options: (context) => context.terrains ?? [],
  match: (cell, op, value) => {
    const actual = typeof cell?.t === 'string' ? cell.t : undefined
    if (op === 'exists') {
      const wanted = asBoolean(value)
      return wanted === null ? false : wanted === (actual !== undefined)
    }
    if (op === 'in') {
      const wanted = asStrings(value)
      return wanted === null ? false : actual !== undefined && wanted.includes(actual)
    }
    const wanted = firstString(value)
    if (wanted === null) return false
    return op === '≠' ? actual !== wanted : actual === wanted
  },
  describe: (op, value, context) => {
    if (op === 'exists') return asBoolean(value) === true ? '有地形' : '没有地形'
    if (op === 'in') {
      const list = asStrings(value)
      return list === null
        ? '地形 属于其中之一（未选）'
        : `地形是 ${list.map((id) => enumLabel(context.terrains, id)).join(' / ')} 之一`
    }
    const wanted = asStrings(value)?.[0]
    return wanted === undefined
      ? '地形（未选）'
      : `地形 ${op} ${enumLabel(context.terrains, wanted)}`
  },
}

/** 格上的分类 ID（没填 / 空串 = 没有值；与"字段读取器"同一条口径） */
function categoryOf(cell: TerrainCell | undefined, key: 'biome'): string | undefined {
  const value = cell?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * **生物群系**规则（精确匹配）—— §D / `BIOMES.md` §3 决定二的第一条。
 *
 * 34 个值逐个勾确实麻烦，所以旁边还有一条 `biomeTag`（按标签一次命中一组）。
 * 两条并存是刻意的：既要"只选针叶林"，也要"所有森林类"。
 */
const BIOME_RULE: SelectionRuleSpec = {
  key: 'biome',
  label: '生物群系',
  ops: ENUM_OPS,
  valueKind: 'enum',
  options: (context) => context.biomes ?? [],
  match: (cell, op, value) => {
    const actual = categoryOf(cell, 'biome')
    if (op === 'exists') {
      const wanted = asBoolean(value)
      return wanted === null ? false : wanted === (actual !== undefined)
    }
    if (op === 'in') {
      const wanted = asStrings(value)
      return wanted === null ? false : actual !== undefined && wanted.includes(actual)
    }
    const wanted = firstString(value)
    if (wanted === null) return false
    return op === '≠' ? actual !== wanted : actual === wanted
  },
  describe: (op, value, context) => {
    if (op === 'exists') return asBoolean(value) === true ? '有生物群系' : '没有生物群系'
    if (op === 'in') {
      const list = asStrings(value)
      return list === null
        ? '生物群系 属于其中之一（未选）'
        : `生物群系是 ${list.map((id) => enumLabel(context.biomes, id)).join(' / ')} 之一`
    }
    const wanted = asStrings(value)?.[0]
    return wanted === undefined
      ? '生物群系（未选）'
      : `生物群系 ${op} ${enumLabel(context.biomes, wanted)}`
  },
}

/**
 * **按标签匹配地形**（`BORROWED-IDEAS.md` §0.2 / 用户口径：地形与群系共用同一批标签 ID）。
 *
 * 与 `BIOME_TAG_RULE` **逐字同构**，只有两处不同：读的是格上的 `t`（地形），
 * 标签从 `context.terrains` 里取。之所以要它：9 种内置地形逐个勾很麻烦，而
 * "所有水域"（含自定义的水域地形）本该是一个词的事 —— 沼泽既是水域又是湿地，
 * 这在单值枚举字段上根本表达不出来。
 *
 * 只提供 `in` 与 `=`：标签本来就是"一组"的语义，`>` / `between` 在这里没有意义。
 */
const TERRAIN_TAG_RULE: SelectionRuleSpec = {
  key: 'terrainTag',
  label: '地形标签',
  ops: ['in', '='],
  valueKind: 'enum',
  options: (context) => context.terrainTags ?? [],
  match: (cell, op, value, context) => {
    const actual = typeof cell?.t === 'string' ? cell.t : undefined
    if (actual === undefined) return false
    // 这一格的地形带哪些标签 —— 从**规则上下文**里的选项表读（`match` 拿不到目录）。
    // 没有上下文（调用方没给目录）时 `tags` 是空的 → 筛不中（见接口上那段注释）
    const tags = context?.terrains?.find((option) => option.value === actual)?.tags ?? []
    if (tags.length === 0) return false
    const wanted = asStrings(value)
    if (wanted === null) return false
    // `in` 与 `=` 在这里同义（值本来就是一组）；保留 `=` 是为了"只勾一个标签"时读起来顺
    void op
    return wanted.some((tag) => tags.includes(tag))
  },
  describe: (op, value, context) => {
    const list = asStrings(value)
    if (list === null) return '地形标签（未选）'
    const labels = list.map((tag) => enumLabel(context.terrainTags, tag))
    return `${labels.join(' / ')} 类的地形`
  },
}

/**
 * **按标签匹配生物群系**（`BIOMES.md` §3 决定二的核心）—— 一条子句命中一整组。
 *
 * 为什么需要它（而不是"给群系加一个 category 字段"）：一个群系常同时属于多个组
 * （「山地森林」既是 temperate 又是 forest 又是 mountain），单一枚举字段迟早会逼出任意选择。
 * Minecraft 在 1.19 正是**删掉了群系的 `category`、把归类整体移到标签**，这里照做。
 *
 * 只提供 `in` 与 `=`：标签本来就是"一组"的语义，`>` / `between` 在这里没有意义。
 */
const BIOME_TAG_RULE: SelectionRuleSpec = {
  key: 'biomeTag',
  label: '生物群系标签',
  ops: ['in', '='],
  valueKind: 'enum',
  options: (context) => context.biomeTags ?? [],
  match: (cell, op, value, context) => {
    const actual = categoryOf(cell, 'biome')
    if (actual === undefined) return false
    // 这一格的群系带哪些标签 —— 从**规则上下文**里的选项表读（`match` 拿不到目录）。
    // 没有上下文（调用方没给目录）时 `tags` 是空的 → 筛不中（见接口上那段注释）
    const tags = context?.biomes?.find((option) => option.value === actual)?.tags ?? []
    if (tags.length === 0) return false
    const wanted = asStrings(value)
    if (wanted === null) return false
    // `in` 与 `=` 在这里同义（值本来就是一组）；保留 `=` 是为了"只勾一个标签"时读起来顺
    void op
    return wanted.some((tag) => tags.includes(tag))
  },
  describe: (op, value, context) => {
    const list = asStrings(value)
    if (list === null) return '生物群系标签（未选）'
    const labels = list.map((tag) => enumLabel(context.biomeTags, tag))
    return `${labels.join(' / ')} 类的生物群系`
  },
}

/** 规则登记表：**加一条规则 = 加一行**（数值字段那些是自动生成的） */
export const SELECTION_RULE_SPECS: readonly SelectionRuleSpec[] = [
  TERRAIN_RULE,
  TERRAIN_TAG_RULE,
  BIOME_RULE,
  BIOME_TAG_RULE,
  ...NUMERIC_OVERLAY_FIELDS.map(numericFieldRule),
]

const RULE_BY_KEY = new Map(SELECTION_RULE_SPECS.map((spec) => [spec.key, spec]))

/** 按键取规则；取不到返回 `null`（用户手改过的 IR / 未来版本写的键都不该让界面炸） */
export function selectionRule(key: string): SelectionRuleSpec | null {
  return RULE_BY_KEY.get(key) ?? null
}

/* ------------------------------------------------------------------ 校验 / 人话 / 匹配 */

/**
 * 一条子句是否**可用**：`null` = 可用，否则是给人看的原因。
 *
 * 界面拿它做**即时校验**：非法的那一行标红并说明，而且**不把这个子句算进选择**
 * （施工文件 §C.2 第 4 条）。口径与设置页其它输入一致：拒绝，而不是悄悄夹取。
 */
export function validateClause(clause: RuleClause): string | null {
  const spec = selectionRule(clause.key)
  if (spec === null) return `不认识的筛选键：${clause.key}`
  if (!spec.ops.includes(clause.op)) return `${spec.label}不支持这个运算`
  if (clause.op === 'exists') return asBoolean(clause.value) === null ? '请选择"有 / 没有"' : null
  if (clause.op === 'between') {
    const range = asRange(clause.value)
    if (range === null) return `${spec.label}需要填两个数`
    if (range[0] > range[1]) return `${spec.label}的下限不能大于上限`
    return null
  }
  if (spec.valueKind === 'enum' || clause.op === 'in') {
    return asStrings(clause.value) === null ? `${spec.label}还没选` : null
  }
  return asNumber(clause.value) === null ? `${spec.label}要填一个数` : null
}

/** 这条子句现在算不算数（界面用它决定"要不要把它算进选择"） */
export function clauseIsUsable(clause: RuleClause): boolean {
  return validateClause(clause) === null
}

/** 一条子句的人话（不可用时给出原因，界面直接显示） */
export function describeClause(clause: RuleClause, context: SelectionRuleContext = {}): string {
  const problem = validateClause(clause)
  if (problem !== null) return problem
  const spec = selectionRule(clause.key)
  return spec === null ? clause.key : spec.describe(clause.op, clause.value, context)
}

/** 整组规则的人话回显：`温度 ≥ 10 且 ≤ 30、且 地形 = 森林`（界面放在子句列表下方） */
export function describeGroup(group: RuleGroup, context: SelectionRuleContext = {}): string {
  const usable = group.clauses.filter(clauseIsUsable)
  if (usable.length === 0) return '还没有可用的条件'
  const joiner = group.join === 'or' ? ' 或 ' : ' 且 '
  const text = usable.map((clause) => describeClause(clause, context)).join(joiner)
  return group.negate ? `不满足（${text}）` : text
}

/**
 * 这一格满不满足整组规则。
 *
 * - **不可用的子句被跳过**（不是"当成 false"）：界面刚添了一行还没填完时，
 *   不该让整张图突然一个都不选；
 * - 一个可用子句都没有时返回 `false`（空规则不匹配任何格 —— "什么都不填就全选"是另一个动作）；
 * - `negate` 对**整组结果**取反；`and` / `or` 按子句逐个求值（子句数量很少，不做短路优化）。
 */
export function matchesGroup(
  cell: TerrainCell | undefined,
  group: RuleGroup,
  context: SelectionRuleContext = {},
): boolean {
  const usable = group.clauses.filter(clauseIsUsable)
  if (usable.length === 0) return false
  const results = usable.map((clause) => {
    const spec = selectionRule(clause.key)
    return spec === null ? false : spec.match(cell, clause.op, clause.value, context)
  })
  const hit = group.join === 'or' ? results.some(Boolean) : results.every(Boolean)
  return group.negate ? !hit : hit
}

/** 一组规则是否"能用了"（界面据此启用「应用到选择」按钮） */
export function groupIsUsable(group: RuleGroup): boolean {
  return group.clauses.some(clauseIsUsable)
}