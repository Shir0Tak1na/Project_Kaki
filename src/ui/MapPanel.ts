/**
 * 地图面板：右侧边栏里的一个视图，把常用动作变成按钮。
 *
 * 为什么需要它：常用命令原本只能走 `Ctrl+P` 再搜一次，用起来很累。
 * 面板把动作按用途分组排好，点一下就等于执行命令 —— 而且**只在开发者模式**下
 * 才显示开发用探针，避免误触（命令面板里的探针同样会被隐藏，见 `registerActions`）。
 *
 * 这个类刻意不认识具体命令：它只拿"动作清单"并把它们画成按钮，
 * 因此命令面板与面板永远一致（同一份定义，`main.ts` 的 `buildActions`）。
 *
 * ## 关于"挤"和"卡"（第一版的真实反馈）
 *
 * 第一版每个按钮都带一行描述，侧边栏一窄就换行成三四行，又挤又乱；而且每次
 * 布局变化都整块重建 DOM。现在：
 * - **一行一个动作**：描述文字移到 `title`（悬停提示），只保留顶部一块状态区；
 * - **状态签名**：把「顶部状态 + 每个动作的可用性 + 开发者模式」压成一个字符串，
 *   签名不变就**直接跳过重绘** —— 切视图/改布局时通常什么都不会变，于是什么也不做；
 * - **只在可见时重绘**，并且同一帧内的多次请求合并成一次（`requestAnimationFrame`）。
 */

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian'
import {
  formatSelectionFieldValue,
  SELECTION_EMPTY_HINT,
  type SelectionActionId,
  type SelectionInfo,
} from '../editor/selection.ts'
import {
  LAYER_HINTS,
  LAYER_KEYS,
  LAYER_LABELS,
  isLayerVisible,
  type LayerKey,
  type LayerVisibility,
} from '../render/layerVisibility.ts'

export const MAP_PANEL_VIEW_TYPE = 'fictional-cartographer-panel'

export type PanelActionGroup = 'panel' | 'map' | 'edit' | 'file' | 'dev'

export interface PluginAction {
  /** 命令 id（不含插件前缀） */
  id: string
  name: string
  icon?: string
  group: PanelActionGroup
  /** 仅在开发者模式下可见（面板与命令面板同时隐藏） */
  devOnly?: boolean
  /** 现在是否可以执行（面板据此禁用按钮） */
  available?: () => boolean
  /** 悬停提示里的状态说明 */
  describe?: () => string
  run: () => void | Promise<void>
}

export interface MapPanelDeps {
  getActions: () => PluginAction[]
  /** 顶部状态行：当前地图与地图层 */
  getSummary: () => string
  /**
   * 当前选中的对象（检查器要显示的信息）；`null` = 没选中。
   *
   * 与 `getActions` / `getLayerVisibility` 同一思路：面板不认识编辑器，
   * 它只拿"要显示什么"，改状态全部回到外面执行。
   */
  getSelection: () => SelectionInfo | null
  /** 改名（文字标注改的是它的文字）；空串 = 清空名字 */
  onRenameSelection: (name: string) => void
  /** 改链接（空串 = 清除链接） */
  onSetSelectionLink: (link: string) => void
  /** 打开"从库里选笔记"的选择器 */
  onPickSelectionNote: () => void
  /** 删除当前选中项（走既有删除实现，可撤销） */
  onDeleteSelection: () => void
  /**
   * 「类型」下拉的候选清单（内置 + 自定义，由 `main.ts` 按 `SelectionInfo.typeSource` 去查目录）。
   *
   * 面板不认识任何目录：它只知道"给我当前选中项该有的候选项"。当前值不在候选里时
   * （本机没有这个定义），面板会自己补一条「未知（ID）」——用户因此**有办法改掉它**，
   * 而不是看着一个改不动、也看不懂的值。
   */
  getSelectionTypeOptions: () => ReadonlyArray<{ value: string; label: string }>
  /** 改类型（值就是候选里的 `value`） */
  onSetSelectionType: (value: string) => void
  /**
   * 改当前选中项的某个字段。**传原始文本**，解析与范围检查都在外面（编辑器那一层）做：
   * 面板不认识"虚线"该怎么解析，也不该认识 —— 否则同一套规则会出现两份。
   * 空串 = 清除该字段（`null`，例如"清除覆盖色"）。
   */
  onSetSelectionField: (field: string, rawValue: string) => void
  /** 给点对象（标记 / 名称）设坐标；面板已经把两个输入框解析成数字 */
  onSetSelectionPosition: (x: number, y: number) => void
  /** 把当前选中项整体移到视口中心（形状按包围盒中心平移） */
  onMoveSelectionToViewportCenter: () => void
  /**
   * 六个图层当前的可见性。
   *
   * 为什么由外部注入、而不是面板自己去读插件设置（以及为什么这两个依赖是**必填**的）：
   * - 面板是 `ItemView`，它不认识插件实例。动作清单已经是这个思路（`getActions`），
   *   图层开关沿用同一套 —— 面板只负责"画出来"，状态与副作用都在外面。
   * - **必填而不是可选 + 兜底**：上一批刚因为"两处状态 + 可选兜底"吃过亏
   *   （`ENGINEERING-NOTES.md` §5.12：名称可见性曾在编辑器和设置里各存一份）。
   *   改成必填之后，"忘了接线"会在编译期报错，而不是变成一个点了没反应的按钮。
   */
  getLayerVisibility: () => LayerVisibility
  /**
   * 切换某一层：写插件设置 → 广播 → 画布立刻变（面板随后自己刷新）。
   *
   * 注意面板**不**自己改状态：它连"状态存在哪里"都不该知道。
   */
  onToggleLayer: (key: LayerKey, value: boolean) => void
}

const GROUP_ORDER: ReadonlyArray<{ group: PanelActionGroup; title: string }> = [
  { group: 'panel', title: '' },
  { group: 'map', title: '地图层' },
  { group: 'edit', title: '编辑' },
  { group: 'file', title: '文件与导出' },
  { group: 'dev', title: '开发工具（仅开发者模式）' },
]

/** 渲染一个动作时拿得到的东西（面板只画界面，写入全部回 `deps`） */
interface SelectionActionContext {
  block: HTMLElement
  info: SelectionInfo
  deps: MapPanelDeps
}

/**
 * 检查器的**动作渲染表**：一个动作一个渲染函数。
 *
 * 这里只负责"画出控件 + 把用户的输入交回 `deps`"；**实现仍然复用既有代码**
 * （`main.ts` → `MapEditor.setSelectionLink / setSelectionName / removeSelection`，
 * 都走既有的撤销栈与落盘路径）。为表格另写一份实现，就等于把"可撤销"这件事
 * 复制成两份、迟早分叉。
 *
 * ### 加一个新 kind 时这里**不用改**（面板读的是 `SELECTION_KINDS[kind].actions`）
 * 只有当你需要一种**全新的动作**（例如"改温度带"）时，才在这里加一行，
 * 并在 `main.ts` / `MapEditor` 里给那个动作一个复用既有路径的实现。
 */
const SELECTION_ACTION_RENDERERS: Record<SelectionActionId, (context: SelectionActionContext) => void> = {
  rename: ({ block, info, deps }) => {
    const row = block.createEl('div', { cls: 'fc-selection-row' })
    const input = row.createEl('input', { cls: 'fc-selection-input' })
    input.type = 'text'
    input.value = info.name
    input.placeholder = '名称（留空 = 不显示名字）'
    input.dataset.fcRole = 'name'
    const commit = (): void => {
      if (input.value === info.name) return
      deps.onRenameSelection(input.value)
    }
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commit()
    })
    input.addEventListener('blur', commit)
    block.createEl('div', { cls: 'fc-selection-hintline', text: '名称：显示在地图上的文字' })
  },

  link: ({ block, info, deps }) => {
    const row = block.createEl('div', { cls: 'fc-selection-row' })
    const input = row.createEl('input', { cls: 'fc-selection-input' })
    input.type = 'text'
    input.value = info.link
    input.placeholder = '链接的笔记（留空 = 不链接）'
    input.dataset.fcRole = 'link'
    const commit = (): void => {
      if (input.value === info.link) return
      deps.onSetSelectionLink(input.value)
    }
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commit()
    })
    input.addEventListener('blur', commit)

    const buttons = block.createEl('div', { cls: 'fc-selection-buttons' })
    const pickButton = buttons.createEl('button', { cls: 'fc-panel-button fc-selection-button' })
    pickButton.dataset.fcRole = 'pick-note'
    pickButton.createEl('span', { cls: 'fc-panel-button-label', text: '选择笔记…' })
    pickButton.addEventListener('click', () => deps.onPickSelectionNote())

    const clearButton = buttons.createEl('button', { cls: 'fc-panel-button fc-selection-button' })
    clearButton.dataset.fcRole = 'clear-link'
    clearButton.createEl('span', { cls: 'fc-panel-button-label', text: '清除链接' })
    // 本来就没链接时按不动：点了也不会有任何变化（灰掉比"点了没反应"清楚）
    clearButton.disabled = info.link.length === 0
    clearButton.addEventListener('click', () => deps.onSetSelectionLink(''))

    block.createEl('div', {
      cls: 'fc-selection-hintline',
      text: '链接：在画布上点这个对象时会跳回那篇笔记',
    })
  },

  delete: ({ block, deps }) => {
    const row = block.createEl('div', { cls: 'fc-selection-buttons' })
    const button = row.createEl('button', { cls: 'fc-panel-button fc-selection-button mod-warning' })
    button.dataset.fcRole = 'delete'
    button.createEl('span', { cls: 'fc-panel-button-label', text: '删除' })
    button.addEventListener('click', () => deps.onDeleteSelection())
  },
}

export class MapPanelView extends ItemView {
  private readonly deps: MapPanelDeps
  /** 上次渲染时的状态签名：相同就跳过重绘（这是"卡"的主要对策） */
  private lastSignature: string | null = null
  /**
   * 是否已经画过至少一次。
   *
   * 用它而不是 `contentEl.childElementCount > 0` 来判断"DOM 是不是空的"：
   * 一是自明（"我画过没有"比"别人有没有塞东西"更贴近意图），
   * 二是假 DOM/精简环境里 `childElementCount` 未必存在，一旦缺失，
   * `undefined > 0` 恒为假 —— 跳过重绘的策略会静默失效，只表现为"莫名卡顿"。
   */
  private rendered = false
  private frameHandle: number | null = null

  constructor(leaf: WorkspaceLeaf, deps: MapPanelDeps) {
    super(leaf)
    this.deps = deps
  }

  override getViewType(): string {
    return MAP_PANEL_VIEW_TYPE
  }

  /** 标签页标题（`View` 的抽象成员叫 getDisplayText，不是 getDisplayName） */
  override getDisplayText(): string {
    return '地图'
  }

  override getIcon(): string {
    return 'map'
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('fc-panel-root')
    this.render(true)
  }

  override async onClose(): Promise<void> {
    if (this.frameHandle !== null) {
      window.cancelAnimationFrame(this.frameHandle)
      this.frameHandle = null
    }
  }

  /** 视图当前是否可见（不可见就根本不用重绘） */
  private isVisible(): boolean {
    const el = this.containerEl
    if (typeof el?.isShown === 'function') return el.isShown()
    return el?.offsetParent !== null
  }

  /**
   * 请求重绘：同一帧内多次请求只重绘一次，且**不可见时直接跳过**。
   *
   * 调用方（切视图、改布局）不必关心频率 —— 密集调用在这里被吸收掉。
   */
  requestRender(): void {
    if (this.frameHandle !== null) return
    if (!this.isVisible()) return
    const schedule =
      typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (callback: () => void) => globalThis.setTimeout(callback, 16)
    this.frameHandle = schedule(() => {
      this.frameHandle = null
      this.render()
    }) as unknown as number
  }

  /**
   * 重绘面板。
   *
   * `force` 为真时忽略签名比较（例如 `onOpen` 时 DOM 还是空的）。
   */
  render(force = false): void {
    const actions = this.deps.getActions()
    const summary = this.deps.getSummary()
    const visibility = this.deps.getLayerVisibility()
    const selection = this.deps.getSelection()
    const rows = actions.map((action) => ({
      action,
      available: action.available ? action.available() : true,
      description: action.describe?.() ?? '',
    }))
    // 状态签名：这些东西没变就没必要重建 DOM。
    // 图层开关必须进签名（它决定六个按钮的亮/暗）；但**不要**把每帧都在变的值放进来 ——
    // 上一版把"本帧画了多少格地形"写进签名，结果平移画布时面板每帧重建 DOM（§5.9）。
    const layerSignature = LAYER_KEYS.map((key) => `${key}:${isLayerVisible(visibility, key) ? 1 : 0}`).join(',')
    // 选中项也进签名：否则"选中了另一个对象"时面板不重绘，检查器会一直显示上一个对象的信息。
    // 只放**稳定**字段（名称/链接是用户改的，不是每帧变化的），不要放坐标这类每帧都变的值。
    const selectionSignature =
      selection === null
        ? 'none'
        : `${selection.kind}:${selection.id}:${selection.name}:${selection.link}:${selection.detail}`
    const signature = [
      summary,
      layerSignature,
      selectionSignature,
      ...rows.map((row) => `${row.action.id}:${row.available ? 1 : 0}:${row.description}`),
    ].join('|')
    if (!force && this.rendered && signature === this.lastSignature) return
    this.lastSignature = signature

    const root = this.contentEl
    root.empty()
    root.addClass('fc-panel-root')

    const summaryEl = root.createEl('div', { cls: 'fc-panel-summary' })
    summaryEl.createEl('div', { cls: 'fc-panel-summary-body', text: summary })

    this.renderSelection(root, selection)

    this.renderLayers(root, visibility)

    for (const { group, title } of GROUP_ORDER) {
      const items = rows.filter((row) => row.action.group === group)
      if (items.length === 0) continue
      const list = root.createEl('div', { cls: 'fc-panel-group' })
      if (title.length > 0) list.createEl('div', { cls: 'fc-panel-group-title', text: title })
      for (const row of items) this.renderAction(list, row.action, row.available, row.description)
    }
    this.rendered = true
  }

  /**
   * 「选中的对象」检查器。
   *
   * 用户的原话是：「每次先选中一个对象，然后再决定对他的操作……在侧边栏中显示对象的信息……
   * 我希望不用每次都去设置界面，而是尽可能利用侧边栏的功能」。
   *
   * 四条设计约束：
   * - **没选中时也要说一句怎么办**（用户还抱怨过"功能引导不清晰"）—— 这一行就是那个最小修复；
   * - **每个可编辑字段配一句人话**（链接是干什么的），但**不写教程**：用户嫌 UI 太多；
   * - 改完**必须落到文档并进撤销栈**：所以这里只调 `deps` 里的回调，
   *   真正的写入在编辑器/历史那一层（面板不认识文档，也不该认识）；
   * - **动作按表渲染**：这一节渲染哪些动作，读的是 `SelectionInfo.actions`
   *   （它来自 `selection.ts` 的 `SELECTION_KINDS`）。**加新对象种类时这里一行都不用改** ——
   *   这是那个"长期开放"要求里最容易退化成 if/else 的地方。
   */
  /**
   * 「类型 / 位置 / 外观」三组就地编辑（A2）。
   *
   * 用户的话是："在侧边栏中显示对象的信息，**方便调整位置，类型等等信息**……尽可能利用侧边栏"，
   * 同时反复强调"UI 有点多、功能引导不清晰"。所以这一节的做法是：
   *
   * - **默认收起**（`<details>`），面板首屏仍然只有"是什么 + 能干什么"；
   * - 三组**都从表里读**：有没有类型下拉看 `typeSource`，位置怎么表达看 `position`，
   *   外观有哪些字段看 `fields` —— 面板里**没有任何 `kind === 'xxx'` 判断**；
   * - 控件的写入全部交回 `deps`（解析、范围检查、历史与落盘都在编辑器那一层）。
   */
  private renderSelectionGroups(block: HTMLElement, info: SelectionInfo): void {
    if (info.typeField !== null && info.typeSource !== null) {
      const group = this.openGroup(block, '类型', 'type')
      const select = group.createEl('select', { cls: 'fc-selection-select dropdown' })
      select.dataset.fcField = 'type'
      const options = [...this.deps.getSelectionTypeOptions()]
      const current = info.typeValue ?? ''
      // 当前值不在候选里（本机没有这个定义）：补一条「未知（ID）」，否则下拉会显示成第一项，
      // 用户以为类型被改掉了。**保留原值**（§5.11：不认识的东西属于用户的数据）。
      if (current.length > 0 && !options.some((option) => option.value === current)) {
        options.unshift({ value: current, label: `未知（${current}）` })
      }
      for (const option of options) {
        const optionEl = select.createEl('option', { text: option.label })
        optionEl.value = option.value
      }
      select.value = current
      select.addEventListener('change', () => {
        this.lastSignature = null
        this.deps.onSetSelectionType(select.value)
        this.requestRender()
      })
      group.createEl('div', { cls: 'fc-selection-hintline', text: '类型：决定它长什么样（改这一个对象，不影响别的）' })
    }

    if (info.position !== 'none' && info.positionValue !== null) {
      const group = this.openGroup(block, '位置', 'position')
      const value = info.positionValue
      if (value.kind === 'point') {
        const row = group.createEl('div', { cls: 'fc-selection-row' })
        const commit = (): void => {
          const x = Number(xInput.value)
          const y = Number(yInput.value)
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            // 输入不是数字：把框子改回当前值，**不做任何写入**（静默夹取会让界面与文件不一致）
            xInput.value = String(value.x)
            yInput.value = String(value.y)
            return
          }
          this.lastSignature = null
          this.deps.onSetSelectionPosition(x, y)
          this.requestRender()
        }
        const xInput = row.createEl('input', { cls: 'fc-selection-input fc-selection-number' })
        xInput.type = 'number'
        xInput.value = String(value.x)
        xInput.dataset.fcField = 'x'
        const yInput = row.createEl('input', { cls: 'fc-selection-input fc-selection-number' })
        yInput.type = 'number'
        yInput.value = String(value.y)
        yInput.dataset.fcField = 'y'
        for (const input of [xInput, yInput]) {
          input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commit()
          })
          input.addEventListener('blur', commit)
        }
        group.createEl('div', { cls: 'fc-selection-hintline', text: '坐标：世界单位，回车或点别处后生效（可撤销）' })
      } else if (value.kind === 'cell') {
        group.createEl('div', { cls: 'fc-selection-readonly', text: `格 ${value.q}, ${value.r}（地块不能搬动）` })
      } else {
        group.createEl('div', { cls: 'fc-selection-readonly', text: `${value.points} 个顶点` })
      }

      // 点对象用坐标表达位置，形状与地块用"整体移动"更合理：只有形状给这个按钮
      if (value.kind === 'shape' || value.kind === 'point') {
        const row = group.createEl('div', { cls: 'fc-selection-buttons' })
        const button = row.createEl('button', { cls: 'fc-panel-button fc-selection-button' })
        button.dataset.fcField = 'center'
        button.createEl('span', { cls: 'fc-panel-button-label', text: '移到视口中心' })
        button.addEventListener('click', () => {
          this.lastSignature = null
          this.deps.onMoveSelectionToViewportCenter()
          this.requestRender()
        })
      }
    }

    if (info.fields.length > 0) {
      const group = this.openGroup(block, '外观', 'appearance')
      const values = info.fieldValues
      for (const field of info.fields) {
        const row = group.createEl('div', { cls: 'fc-selection-row' })
        row.createEl('span', { cls: 'fc-selection-field-label', text: field.label })
        const current = values[field.field] ?? null
        if (field.control === 'color') {
          const picker = row.createEl('input', { cls: 'fc-selection-color' })
          picker.type = 'color'
          picker.value = typeof current === 'string' && current.length > 0 ? current : '#888888'
          picker.dataset.fcField = `field-${field.field}`
          picker.addEventListener('change', () => {
            this.lastSignature = null
            this.deps.onSetSelectionField(field.field, picker.value)
            this.requestRender()
          })
          const clear = row.createEl('button', { cls: 'fc-selection-mini' })
          clear.dataset.fcField = `clear-${field.field}`
          clear.setText('清除')
          clear.disabled = current === null
          clear.addEventListener('click', () => {
            this.lastSignature = null
            this.deps.onSetSelectionField(field.field, '')
            this.requestRender()
          })
          continue
        }
        const input = row.createEl('input', { cls: 'fc-selection-input' })
        input.type = field.control === 'number' ? 'number' : 'text'
        if (field.min !== undefined) input.min = String(field.min)
        if (field.max !== undefined) input.max = String(field.max)
        input.value = formatSelectionFieldValue(field, current)
        input.placeholder = field.control === 'dash' ? '例如 12,4；留空 = 清除这一项' : ''
        input.dataset.fcField = `field-${field.field}`
        const commit = (): void => {
          if (input.value === formatSelectionFieldValue(field, current)) return
          this.lastSignature = null
          this.deps.onSetSelectionField(field.field, input.value)
          this.requestRender()
        }
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commit()
        })
        input.addEventListener('blur', commit)
      }
      group.createEl('div', {
        cls: 'fc-selection-hintline',
        text: '外观：存在地图文件里，只影响这一个对象（改设置里的默认值不会动它）',
      })
    }
  }

  /** 建一个默认收起的组（`<details>`）：首屏只留"是什么 + 能干什么" */
  private openGroup(parent: HTMLElement, title: string, role: string): HTMLElement {
    const details = parent.createEl('details', { cls: 'fc-selection-group' })
    details.dataset.fcGroup = role
    // 显式设成收起：假 DOM 里没有 `open` 属性时，断言"默认收起"才有意义
    details.open = false
    details.createEl('summary', { cls: 'fc-selection-group-title', text: title })
    return details
  }

  private renderSelection(root: HTMLElement, selection: SelectionInfo | null): void {
    const block = root.createEl('div', { cls: 'fc-panel-group fc-panel-selection' })
    block.createEl('div', { cls: 'fc-panel-group-title', text: '选中的对象' })

    if (selection === null) {
      block.createEl('div', { cls: 'fc-selection-hint', text: SELECTION_EMPTY_HINT })
      return
    }

    const head = block.createEl('div', { cls: 'fc-selection-head' })
    head.createEl('span', { cls: 'fc-selection-kind', text: selection.kindLabel })
    head.createEl('span', { cls: 'fc-selection-detail', text: selection.detail })

    // ID 是"信息"不是"动作"：它是写在地图文件里的标识，改名要用设置页的「改 ID…」
    block.createEl('div', { cls: 'fc-selection-id', text: `ID：${selection.id}` })

    for (const action of selection.actions) {
      SELECTION_ACTION_RENDERERS[action]({ block, info: selection, deps: this.deps })
    }

    // 三组就地编辑放在动作之后、且**默认收起**：首屏仍然是"是什么 + 能干什么"
    this.renderSelectionGroups(block, selection)
  }

  /**
   * 图层开关（六个）。
   *
   * 放在**最上面**、状态行下面：用户是"边看画布边切层"，而侧边栏很窄、
   * 动作列表可能比一屏还长 —— 放在中间或末尾就意味着每次切层都要先滚动。
   *
   * 这些按钮刻意用**独立的 class**（`fc-layer-toggle`）而不是复用 `fc-panel-button`：
   * 两者语义不同（一个执行动作、一个切换状态），样式与测试选择器都该分得开。
   */
  private renderLayers(root: HTMLElement, visibility: LayerVisibility): void {
    const list = root.createEl('div', { cls: 'fc-panel-group fc-panel-layers' })
    list.createEl('div', { cls: 'fc-panel-group-title', text: '图层' })
    for (const key of LAYER_KEYS) {
      const visible = isLayerVisible(visibility, key)
      const button = list.createEl('button', { cls: 'fc-layer-toggle' })
      button.dataset.layer = key
      if (visible) button.addClass('is-active')
      button.title = `${LAYER_LABELS[key]}：${LAYER_HINTS[key]}（点一下${visible ? '隐藏' : '显示'}）`
      // 用 ●/○ 而不是图标：状态一眼可辨，也不依赖图标库是否有这个名字
      button.createEl('span', { cls: 'fc-layer-toggle-mark', text: visible ? '●' : '○' })
      button.createEl('span', { cls: 'fc-layer-toggle-label', text: LAYER_LABELS[key] })
      button.addEventListener('click', () => {
        // 先清签名：状态马上会变，直接告诉面板"下次一定要重绘"
        this.lastSignature = null
        this.deps.onToggleLayer(key, !visible)
        this.requestRender()
      })
    }
  }

  private renderAction(container: HTMLElement, action: PluginAction, available: boolean, description: string): void {
    const button = container.createEl('button', { cls: 'fc-panel-button' })
    button.disabled = !available
    if (!available) button.addClass('is-disabled')
    // 描述移到悬停提示：侧边栏很窄，多一行文字就会挤成三四行
    button.title = description.length > 0 ? `${action.name} — ${description}` : action.name

    if (action.icon) {
      const iconEl = button.createEl('span', { cls: 'fc-panel-button-icon' })
      try {
        setIcon(iconEl, action.icon)
      } catch {
        iconEl.setText('•')
      }
    }
    button.createEl('span', { cls: 'fc-panel-button-label', text: action.name })

    button.addEventListener('click', () => {
      // 执行后重绘：动作多半改变了状态（地图层开/关、模式切换、撤销步数…）
      void Promise.resolve(action.run()).finally(() => {
        this.lastSignature = null
        this.requestRender()
      })
    })
  }
}
