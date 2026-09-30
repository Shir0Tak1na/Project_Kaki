/**
 * 「按规则筛选选择…」对话框 —— **UI 条件构建器**（施工文件 §C.2）。
 *
 * 为什么不是文本语法：用户明说过"上手难度很大，建议做成 UI"。IR（`RuleGroup`）是共享的，
 * 将来要加语法补全只是"同一份 IR 的另一个输入方式"，不必推翻这里。
 *
 * ## 这个对话框**不认识任何一条具体规则**
 *
 * 规则的键、允许哪些运算符、值该渲染成下拉 / 数字框 / 两个数字框 / 有-没有，
 * 全部从登记表 `SELECTION_RULE_SPECS` 读（见 `render/selectionRules.ts`）。
 * 于是"加一条筛选规则 = 加一行"，界面一行都不用改。
 *
 * ## 六条"易上手"措施（§C.2 + ISSUE-003）
 *
 * 1. 运算符下拉**只列这条规则允许的**，而且写**中文显示名**（`等于` / `属于其中之一` /
 *    `介于…之间`），token 只留在 IR 里（见 `RULE_OP_LABELS`）—— ISSUE-003 的第一条证据；
 * 2. 输入控件的形状由 `spec.valueKind` 决定；
 * 3. **顶部一行大字就是结果**："按这些条件会选中 37 格，其中 5 格没有温度"。
 *    关键是它算的是**应用后会选中什么**，而不是"你现在选了什么"（ISSUE-003 的主因）；
 * 4. 五个动作按钮上写着**前后格数**（"替换（→37 格）""并入（12 → 49 格）"）——
 *    点之前就知道会发生什么；
 * 5. 条件列表下方有**人话回显**（"温度 ≥ 10 且 地形 = 森林"）；
 * 6. **即时校验**：非法的那一行标红并说明原因，且**不会被算进选择**
 *    （`matchesGroup` 会跳过不可用的条件 —— 刚添了一行还没填完，不该让整张图突然一个都不选）。
 *
 * 五条动作：替换 / 并入 / 移出 / **在当前选择内再筛** / **按同地形连通扩展**。
 * 后两条在 §C.2 的分工里属于**动作**而不是规则（一条依赖当前选择、一条要邻域遍历）。
 *
 * ## 顶部那行数字从哪来
 *
 * 界面自己**不算**任何规则（否则"预览"与"真的应用一次"迟早分叉）：`preview` 由调用方给，
 * 而调用方走的就是应用时那条路径（`ruleHits`）—— ISSUE-003 验收第 2 条要的
 * "数字与实际应用结果一致"于是是**结构上成立**的，而不是靠两处实现碰巧一样。
 *
 * 与仓库里其它对话框同一套路：控件带稳定的 `dataset` 标记供冒烟断言（`fcFilter*`）。
 */

import { Modal, Setting, type App } from 'obsidian'
import type { RuleApplyMode } from '../render/selectionSet.ts'
import {
  describeClause,
  describeGroup,
  emptyRuleGroup,
  groupIsUsable,
  ruleOpLabel,
  SELECTION_RULE_SPECS,
  selectionRule,
  validateClause,
  type RuleClause,
  type RuleGroup,
  type RuleOp,
  type SelectionRuleContext,
  type SelectionRuleSpec,
} from '../render/selectionRules.ts'

/** 顶部那行大字 + 动作按钮上的数字（全部由调用方**试算**，界面不复制一遍规则） */
export interface SelectionFilterPreview {
  /** 按这些条件**会**命中多少格 */
  hits: number
  /** 当前选择格数（**现取**：弹窗开着时用户可能又去画布上点了几格） */
  current: number
  /** 命中格里"没有这个字段数据"的数量 —— 界面写成"其中 5 格没有温度"（为空 = 不提这一句） */
  missing: readonly { label: string; count: number }[]
  /** 四个动作做完之后的格数（"会变成几格"，点之前就能看见） */
  after: { replace: number; add: number; remove: number; inside: number }
}

export interface SelectionFilterModalOptions {
  /** 下拉里"现在有哪些地形 / 生物群系"（表不自己去看设置，由调用方现取） */
  context: SelectionRuleContext
  /** 试算（**不改选择**）：命中格数 / 当前选择 / 缺数据统计 / 四个动作后的格数 */
  preview: (group: RuleGroup) => SelectionFilterPreview
  /** 应用规则（替换 / 并入 / 移出）。返回应用后的格数 */
  apply: (group: RuleGroup, mode: RuleApplyMode) => number
  /** 在当前选择内再筛。返回筛选后的格数 */
  filterInside: (group: RuleGroup) => number
  /** 按同地形连通扩展。返回扩展后的格数 */
  expand: () => number
}

/** 弹窗工厂：默认用真实 `SelectionFilterModal`，测试里可注入替身 */
export type SelectionFilterModalFactory = (
  app: App,
  options: SelectionFilterModalOptions,
) => { open(): void }

/** 界面上"值"控件的形状：由 `spec.valueKind`（这条规则的值长什么样）+ 当前运算符共同决定 */
type ValueShape = 'boolean' | 'range' | 'multi' | 'enum' | 'number'

function valueControlOf(spec: SelectionRuleSpec, op: RuleOp): ValueShape {
  if (op === 'exists') return 'boolean'
  if (op === 'between') return 'range'
  // 枚举 + `in` = 多选；枚举 + `=` / `≠` = 单选下拉
  if (spec.valueKind === 'enum') return op === 'in' ? 'multi' : 'enum'
  return 'number'
}

/**
 * 数字输入 → 值；空 / 非法一律给 `NaN`。
 *
 * 为什么不用空串：`clause.value` 的联合类型里有 `number[]`（`between` 的值）。
 * 混进字符串就得把类型放宽成"数字和字符串的数组"—— 那会让 `asRange` 的收窄失去意义。
 * `NaN` 同样是"还没填好"的合法表示：`Number.isFinite` 会把它挡在判断之外，
 * 于是 `validateClause` 照常说"要填一个数"，而且**不会**被悄悄当成 0 参与筛选。
 */
function readNumberInput(input: HTMLInputElement | null): number {
  if (input === null) return Number.NaN
  const text = input.value.trim()
  if (text.length === 0) return Number.NaN
  const value = Number(text)
  return Number.isFinite(value) ? value : Number.NaN
}

/** 顶部那行大字的内容（框在自己的函数里，冒烟可以按同一口径断言） */
export function selectionPreviewHeadline(preview: SelectionFilterPreview, usable: boolean): string {
  if (!usable) return '还没有可用的条件 —— 每条条件都要填完整才算数'
  const missing = preview.missing.map((item) => `${item.count} 格没有${item.label}`).join('、')
  const head = `按这些条件会选中 ${preview.hits} 格`
  return missing.length > 0 ? `${head}，其中 ${missing}` : head
}

export class SelectionFilterModal extends Modal {
  private readonly options: SelectionFilterModalOptions
  private group: RuleGroup = emptyRuleGroup()
  private clauseListEl: HTMLElement | null = null
  private echoEl: HTMLElement | null = null
  private countEl: HTMLElement | null = null
  /** 顶部那行大字：**结果**（不是"你现在的选择"） */
  private resultEl: HTMLElement | null = null
  /** 动作按钮：文字每次都按当前试算重写（"并入（12 → 49 格）"） */
  private readonly actionViews: Array<{
    button: HTMLButtonElement
    key: string
    label: (preview: SelectionFilterPreview) => string
  }> = []
  /** 每行"标红 / 校验说明"的落点（`refresh()` 直接写它，不去 DOM 里查节点） */
  private readonly rowViews: Array<{ row: HTMLElement; flag: HTMLElement }> = []

  constructor(app: App, options: SelectionFilterModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: '按规则筛选选择' })

    // 1) 结果在**最上面**：这是用户唯一想知道的事，而且它算的是"会选中什么"
    this.resultEl = contentEl.createDiv({ cls: 'fc-filter-result', text: '' })
    this.resultEl.dataset.fcFilter = 'result'

    contentEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '每条条件只判断"这一格满不满足"。没填完的条件会标红，并且不参与判断 ——' +
        '所以刚加一条时不会把选择清空。',
    })

    // 2) 条件之间的关系放在**列表之上**：它管的正是下面那几条
    new Setting(contentEl)
      .setName('这些条件的关系')
      .setDesc('"且" = 全部满足；"或" = 满足任意一条')
      .addDropdown((dropdown) => {
        dropdown.addOption('and', '且（全部满足）')
        dropdown.addOption('or', '或（满足任一）')
        dropdown.setValue(this.group.join)
        dropdown.selectEl.dataset.fcFilter = 'join'
        dropdown.onChange((value) => {
          this.group.join = value === 'or' ? 'or' : 'and'
          this.refresh()
        })
      })
      .addToggle((toggle) => {
        toggle.setTooltip('反过来：命中的格不选，没命中的才选')
        toggle.setValue(this.group.negate)
        toggle.toggleEl.dataset.fcFilter = 'negate'
        toggle.onChange((value) => {
          this.group.negate = value
          this.refresh()
        })
      })

    this.clauseListEl = contentEl.createDiv({ cls: 'fc-filter-clauses' })
    this.clauseListEl.dataset.fcFilter = 'clauses'

    new Setting(contentEl).addButton((button) => {
      button.setButtonText('+ 再加一个条件').onClick(() => this.addClause())
      button.buttonEl.dataset.fcFilter = 'add'
    })

    this.echoEl = contentEl.createDiv({ cls: 'fc-filter-echo', text: '' })
    this.echoEl.dataset.fcFilter = 'echo'
    this.countEl = contentEl.createDiv({ cls: 'fc-settings-note', text: '' })
    this.countEl.dataset.fcFilter = 'count'

    // 3) 五个动作：文字里带**前后格数**，点之前就知道会发生什么
    const actions = contentEl.createDiv({ cls: 'fc-filter-actions' })
    const makeAction = (
      key: string,
      hint: string,
      label: (preview: SelectionFilterPreview) => string,
      run: () => number,
    ): void => {
      const button = actions.createEl('button', { text: '', cls: 'fc-filter-action' })
      button.title = hint
      button.dataset.fcFilter = key
      button.addEventListener('click', () => {
        // 数字**先执行再重画**：`refresh()` 会从调用方现取新的当前选择，
        // 于是按钮上的"12 → 49 格"立刻变成"49 → 49 格"，不必自己维护一份计数
        run()
        this.refresh()
      })
      this.actionViews.push({ button, key, label })
    }
    makeAction('apply-replace', '把命中的格变成新的选择', (preview) => `替换（→${preview.after.replace} 格）`, () =>
      this.options.apply(this.group, 'replace'),
    )
    makeAction(
      'apply-add',
      '把命中的格加进当前选择',
      (preview) => `并入（${preview.current} → ${preview.after.add} 格）`,
      () => this.options.apply(this.group, 'add'),
    )
    makeAction(
      'apply-remove',
      '把命中的格从当前选择里去掉（不是"取反"）',
      (preview) => `移出（${preview.current} → ${preview.after.remove} 格）`,
      () => this.options.apply(this.group, 'remove'),
    )
    makeAction(
      'apply-inside',
      '只在当前选择里保留命中的格',
      (preview) => `在当前选择内筛（${preview.current} → ${preview.after.inside} 格）`,
      () => this.options.filterInside(this.group),
    )
    makeAction(
      'expand',
      '以当前选择为种子，往同一种地形的相邻格扩到整片连通区',
      () => '按同地形连通扩展',
      () => this.options.expand(),
    )

    new Setting(contentEl).addButton((button) => {
      button.setButtonText('关闭').onClick(() => this.close())
      button.buttonEl.dataset.fcFilter = 'close'
    })

    this.renderClauses()
  }

  override onClose(): void {
    this.contentEl.empty()
  }

  private addClause(): void {
    const first = SELECTION_RULE_SPECS[0]
    if (first === undefined) return
    // 新条件从**合法但值为空**的形状起步：于是它一开始就是"标红且不算数"的状态
    this.group.clauses.push(emptyClauseFor(first, this.options.context))
    this.renderClauses()
  }

  /**
   * 重建**整张条件列表**。
   *
   * 只在**结构性变化**时调用（增删条件 / 换规则 / 换运算符）：值输入框的每次键入都重建 DOM
   * 会让输入框失去焦点（打第二个字符就跑到别处），所以值的改动只走 `refresh()`。
   */
  private renderClauses(): void {
    const list = this.clauseListEl
    if (list === null) return
    list.empty()
    this.rowViews.length = 0
    if (this.group.clauses.length === 0) {
      list.createDiv({ cls: 'fc-settings-note', text: '还没有条件。点「+ 再加一个条件」开始。' })
      this.refresh()
      return
    }
    this.group.clauses.forEach((clause, index) => this.renderClause(list, clause, index))
    this.refresh()
  }

  private renderClause(list: HTMLElement, clause: RuleClause, index: number): void {
    const doc = list.ownerDocument ?? globalThis.document
    const row = list.createDiv({ cls: 'fc-filter-row' })
    row.dataset.fcFilter = 'row'
    row.dataset.fcFilterIndex = String(index)

    // 校验原因先在行尾占一个位置（空串 = 这一行没毛病）。**始终存在**是有意的：
    // 于是 `refresh()` 不必去 DOM 里查它 —— 查节点在真实浏览器里没问题，
    // 但会让我们少掉一条"到底渲染出了什么"的确定性（也让测试桩必须实现选择器）。
    const flag = doc.createElement('span')
    flag.className = 'fc-filter-problem'
    flag.dataset.fcFilter = 'problem'
    this.rowViews.push({ row, flag })
    row.appendChild(flag)

    // 1) 规则键：一张下拉列出**登记表里所有规则**（含由字段表自动生成的数值规则）
    const keySelect = doc.createElement('select')
    keySelect.dataset.fcFilter = 'key'
    for (const spec of SELECTION_RULE_SPECS) {
      const option = doc.createElement('option')
      option.value = spec.key
      option.textContent = spec.label
      keySelect.appendChild(option)
    }
    keySelect.value = clause.key
    keySelect.addEventListener('change', () => {
      const spec = selectionRule(keySelect.value)
      if (spec === null) return
      // 换规则 = 换了允许的运算符与值的形状 → 整条条件重置（保留一个可读的默认运算符）
      const next = emptyClauseFor(spec, this.options.context)
      this.group.clauses[index] = next
      this.renderClauses()
    })
    row.appendChild(keySelect)

    const spec = selectionRule(clause.key)

    // 2) 运算符：**只列这条规则允许的**，显示名是中文（值仍是 token）
    const opSelect = doc.createElement('select')
    opSelect.dataset.fcFilter = 'op'
    for (const op of spec?.ops ?? []) {
      const option = doc.createElement('option')
      option.value = op
      option.textContent = ruleOpLabel(op)
      opSelect.appendChild(option)
    }
    opSelect.value = clause.op
    opSelect.addEventListener('change', () => {
      clause.op = opSelect.value as RuleOp
      clause.value = emptyValueFor(spec, clause.op)
      this.renderClauses()
    })
    row.appendChild(opSelect)

    // 3) 值：形状由规则与运算符共同决定
    row.appendChild(this.buildValueControl(doc, spec, clause))

    // 4) 删掉这一条
    const remove = doc.createElement('button')
    remove.className = 'fc-filter-remove'
    remove.textContent = '×'
    remove.title = '删掉这个条件'
    remove.dataset.fcFilter = 'remove'
    remove.addEventListener('click', () => {
      this.group.clauses.splice(index, 1)
      this.renderClauses()
    })
    row.appendChild(remove)
  }

  private buildValueControl(
    doc: Document,
    spec: SelectionRuleSpec | null,
    clause: RuleClause,
  ): HTMLElement {
    // 不认识的规则键（手改过的 IR / 未来版本写的）：给一个只读提示，别让界面炸
    if (spec === null) {
      const unknown = doc.createElement('span')
      unknown.className = 'fc-filter-problem'
      unknown.textContent = `不认识的筛选键：${clause.key}`
      return unknown
    }

    const shape = valueControlOf(spec, clause.op)
    if (shape === 'boolean') {
      const select = doc.createElement('select')
      select.dataset.fcFilter = 'value'
      for (const [value, label] of [['true', '有'], ['false', '没有']] as const) {
        const option = doc.createElement('option')
        option.value = value
        option.textContent = label
        select.appendChild(option)
      }
      select.value = clause.value === true ? 'true' : 'false'
      select.addEventListener('change', () => {
        clause.value = select.value === 'true'
        this.refresh()
      })
      return select
    }

    if (shape === 'range') {
      const wrap = doc.createElement('div')
      wrap.className = 'fc-filter-range'
      const range = Array.isArray(clause.value) ? (clause.value as readonly unknown[]) : []
      const makeInput = (position: number, mark: string): HTMLInputElement => {
        const input = doc.createElement('input')
        input.type = 'number'
        input.className = 'fc-filter-number'
        input.dataset.fcFilter = mark
        const raw = range[position]
        input.value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
        input.addEventListener('input', () => {
          // 任一改动都要把**两个**当前值一起写回（否则会把另一个抹掉）
          clause.value = [readNumberInput(minEl), readNumberInput(maxEl)]
          this.refresh()
        })
        return input
      }
      // 两个输入框互相引用：所以先造元素、后取变量（`makeInput` 里的回调只在输入时触发）
      const minEl = makeInput(0, 'value-min')
      const maxEl = makeInput(1, 'value-max')
      wrap.append(minEl, doc.createTextNode('–'), maxEl)
      return wrap
    }

    if (shape === 'number') {
      const input = doc.createElement('input')
      input.type = 'number'
      input.className = 'fc-filter-number'
      input.dataset.fcFilter = 'value'
      input.value = typeof clause.value === 'number' && Number.isFinite(clause.value) ? String(clause.value) : ''
      input.addEventListener('input', () => {
        clause.value = readNumberInput(input)
        this.refresh()
      })
      return input
    }

    const options = spec.options?.(this.options.context) ?? []
    if (shape === 'multi') {
      // `in` = 多选。用原生 `<select multiple>`：不用另造一套 chip 组件，
      // 而且键盘可达（Ctrl/⌘ + 点击多选是系统级肌肉记忆）。
      const select = doc.createElement('select')
      select.multiple = true
      select.className = 'fc-filter-multi'
      select.dataset.fcFilter = 'value'
      const selected = new Set(Array.isArray(clause.value) ? (clause.value as readonly unknown[]) : [])
      for (const option of options) {
        const item = doc.createElement('option')
        item.value = option.value
        item.textContent = option.label
        item.selected = selected.has(option.value)
        select.appendChild(item)
      }
      select.addEventListener('change', () => {
        clause.value = [...select.selectedOptions].map((option) => option.value)
        this.refresh()
      })
      return select
    }

    const select = doc.createElement('select')
    select.dataset.fcFilter = 'value'
    const enumOptions = singleEnumOptions(spec, this.options.context)
    for (const option of enumOptions) {
      const item = doc.createElement('option')
      item.value = option.value
      item.textContent = option.label
      select.appendChild(item)
    }
    select.value = typeof clause.value === 'string' && clause.value.length > 0 ? clause.value : enumOptions[0]!.value
    // 回写：下拉选中的那一个就是这条条件的值（否则"默认选中第一项"只停留在视觉上）
    clause.value = select.value
    select.addEventListener('change', () => {
      clause.value = select.value
      this.refresh()
    })
    return select
  }

  /**
   * 人话回显 + 每行的标红 + **顶部结果行** + 动作按钮上的格数（**不重建 DOM**，所以输入框不会丢焦点）。
   *
   * 为什么要试算：ISSUE-003 的主因是"组完条件得不到反馈"。这里每次改动都问调用方要一次
   * "会选中几格"，而调用方走的就是真应用那条路径 —— 于是顶部数字与按下去的结果不会分叉。
   */
  private refresh(): void {
    this.rowViews.forEach((view, index) => {
      const clause = this.group.clauses[index]
      const problem = clause === undefined ? null : validateClause(clause)
      view.row.classList.toggle('is-invalid', problem !== null)
      view.row.title = problem ?? (clause === undefined ? '' : describeClause(clause, this.options.context))
      view.flag.textContent = problem ?? ''
    })
    if (this.echoEl !== null) this.echoEl.textContent = describeGroup(this.group, this.options.context)
    const usable = groupIsUsable(this.group)
    const preview = this.options.preview(this.group)
    if (this.resultEl !== null) this.resultEl.textContent = selectionPreviewHeadline(preview, usable)
    if (this.countEl !== null) this.countEl.textContent = `当前选择 ${preview.current} 格`
    for (const view of this.actionViews) {
      view.button.textContent = view.label(preview)
      // 「连通扩展」不读规则（它只吃当前选择），所以任何情况下都可用
      if (view.key === 'expand') continue
      view.button.disabled = !usable
    }
  }
}

/** 一条新条件的初始形状：运算符取该规则第一个，值取"空"（数值类是 `NaN`，于是它一开始就标红、不算数） */
function emptyClauseFor(spec: SelectionRuleSpec, context: SelectionRuleContext): RuleClause {
  const op = spec.ops[0] ?? '='
  const clause: RuleClause = { key: spec.key, op, value: emptyValueFor(spec, op) }
  // 枚举单选的"空"就是它的第一个候选项 —— 添上来就是一条能用的规则，不必先点一下下拉
  if (clause.value === '' && spec.valueKind === 'enum') {
    clause.value = spec.options?.(context)?.[0]?.value ?? ''
  }
  return clause
}

/**
 * 某个运算符下"空的"值长什么样。
 *
 * 数值类一律给 `NaN`（`between` 是两个 `NaN`）：它是"还没填好"的表示，
 * `Number.isFinite` 会把它挡在判断之外 —— 于是这一行标红、且**不参与**筛选，
 * 而不是被悄悄当成 0。
 */
function emptyValueFor(spec: SelectionRuleSpec | null, op: RuleOp): RuleClause['value'] {
  if (op === 'exists') return true
  if (op === 'between') return [Number.NaN, Number.NaN]
  if (op === 'in') return []
  // 枚举单选：**默认取第一个候选项**（这样添上来就是一条能用的规则）；
  // 取不到候选（目录为空 / 数值规则）时给空串，那一行会标红提示"还没选"
  if (spec?.valueKind === 'enum') return ''
  return Number.NaN
}

/** 枚举单选下拉的候选（空目录时给一个占位项，让控件不至于是个空壳） */
function singleEnumOptions(spec: SelectionRuleSpec | null, context: SelectionRuleContext): readonly { value: string; label: string }[] {
  const options = spec?.options?.(context) ?? []
  return options.length > 0 ? options : [{ value: '', label: '（没有可选项）' }]
}
