/**
 * 工具条上的「类型下拉」—— 路径类型与区域类型共用的一套实现。
 *
 * 为什么抽出来（而不是各写一遍）：两个下拉的交互完全一样 ——
 * 一个触发按钮（当前类型的色块 + 名字 + ▾）、一个选项列表、选中即高亮、点外面收起
 * **并拦下那一击**。复制两份的话，第二条修正（比如"收起时拦住这一击"这条真实缺陷）
 * 只会落到其中一个上，另一个继续悄悄多画一个顶点。
 *
 * 这里只管 DOM 与展开状态，**不碰设置、不碰编辑器**：选中后做什么由调用方决定，
 * 于是"选项从哪来、选中改什么"仍然各自只有一处。
 */

export interface ToolbarDropdownSkin {
  /** 整组的 class（用于显示/隐藏整组） */
  groupClass: string
  triggerClass: string
  /** 触发按钮的 dataset 键（形如 `fcPathTrigger`，值为 `'1'`） */
  triggerKey: string
  /** 触发按钮里色块的 dataset 键 */
  swatchKey: string
  labelClass: string
  caretClass: string
  menuClass: string
  menuKey: string
  optionClass: string
  /** 每个选项按 ID 索引时用的 dataset 键（形如 `pathType` / `regionType`） */
  optionKey: string
}

export interface ToolbarDropdownItem {
  id: string
  label: string
  color: string
  title: string
}

export class ToolbarDropdown {
  readonly group: HTMLElement
  private readonly options_: {
    doc: Document
    skin: ToolbarDropdownSkin
    onSelect: (id: string) => void
  }
  private readonly trigger_: HTMLButtonElement
  private readonly swatch_: HTMLElement
  private readonly label_: HTMLElement
  private readonly menu_: HTMLElement
  private readonly buttons = new Map<string, HTMLButtonElement>()
  private readonly swatches = new Map<string, HTMLElement>()
  /** 上一次构建时的目录签名：变了才重建 DOM（重建会把展开状态与焦点丢掉） */
  private signature = ''
  private open = false
  private outsideListener: ((event: Event) => void) | null = null

  constructor(
    host: HTMLElement,
    options: { skin: ToolbarDropdownSkin; onSelect: (id: string) => void },
  ) {
    const doc = host.ownerDocument ?? globalThis.document
    this.options_ = { doc, skin: options.skin, onSelect: options.onSelect }

    this.group = doc.createElement('div')
    this.group.className = options.skin.groupClass

    this.trigger_ = doc.createElement('button')
    this.trigger_.className = options.skin.triggerClass
    this.trigger_.dataset[options.skin.triggerKey] = '1'
    this.swatch_ = doc.createElement('span')
    this.swatch_.className = 'fc-toolbar-swatch'
    this.swatch_.dataset[options.skin.swatchKey] = '1'
    this.label_ = doc.createElement('span')
    this.label_.className = options.skin.labelClass
    const caret = doc.createElement('span')
    caret.className = options.skin.caretClass
    caret.textContent = '▾'
    this.trigger_.append(this.swatch_, this.label_, caret)
    this.trigger_.addEventListener('click', () => {
      this.setOpen(!this.open)
    })

    this.menu_ = doc.createElement('div')
    this.menu_.className = options.skin.menuClass
    this.menu_.dataset[options.skin.menuKey] = '1'
    this.menu_.style.display = 'none'

    this.group.append(this.trigger_, this.menu_)
    host.appendChild(this.group)
  }

  getElement(): HTMLElement {
    return this.group
  }

  getTrigger(): HTMLButtonElement {
    return this.trigger_
  }

  getMenu(): HTMLElement {
    return this.menu_
  }

  option(id: string): HTMLButtonElement | undefined {
    return this.buttons.get(id)
  }

  optionCount(): number {
    return this.buttons.size
  }

  isOpen(): boolean {
    return this.open
  }

  /**
   * 按目录重建选项。
   *
   * `signature` 由各目录自己的 `*CatalogSignature()` 给出：**不含参数** ——
   * 颜色/线宽改了只需要原地刷新（见 `refreshSelection`）。
   */
  rebuild(items: readonly ToolbarDropdownItem[], signature: string, current: ToolbarDropdownItem, force = false): void {
    if (!force && signature === this.signature && this.buttons.size > 0) {
      this.refreshSelection(items, current)
      return
    }
    const { doc, skin } = this.options_
    this.signature = signature
    this.menu_.empty()
    this.buttons.clear()
    this.swatches.clear()
    for (const item of items) {
      const button = doc.createElement('button')
      button.className = skin.optionClass
      // 选项按 ID 索引（断言与"当前选中项"都靠它，而不是靠显示名 —— 显示名可以改）
      button.dataset[skin.optionKey] = item.id
      button.title = item.title
      const swatch = doc.createElement('span')
      swatch.className = 'fc-toolbar-swatch'
      swatch.style.backgroundColor = item.color
      const label = doc.createElement('span')
      label.textContent = item.label
      button.append(swatch, label)
      button.addEventListener('click', () => {
        this.options_.onSelect(item.id)
        // 选完就收起：下拉常开会挡住画布
        this.setOpen(false)
      })
      this.buttons.set(item.id, button)
      this.swatches.set(item.id, swatch)
      this.menu_.appendChild(button)
    }
    this.refreshSelection(items, current)
  }

  /**
   * 原地刷新：触发按钮（色块 + 名字 + 提示）、当前选中项高亮、每个选项的色块与提示。
   *
   * `current` **必须传**，而且**允许不在 `items` 里**：当前类型可能是"已被删掉的自定义类型"
   * 或"别的库写的未知 ID" —— 那种情况下触发按钮要显示回退视觉（例如「未知（custom:xxx）」），
   * 而不是留着上一条类型的名字和颜色（那会让用户以为选中的还是它）。
   */
  refreshSelection(items: readonly ToolbarDropdownItem[], current: ToolbarDropdownItem): void {
    if (this.swatch_.style.backgroundColor !== current.color) this.swatch_.style.backgroundColor = current.color
    if (this.label_.textContent !== current.label) this.label_.textContent = current.label
    if (this.trigger_.title !== current.title) this.trigger_.title = current.title
    for (const item of items) {
      const button = this.buttons.get(item.id)
      const swatch = this.swatches.get(item.id)
      if (button) {
        button.classList.toggle('is-active', item.id === current.id)
        if (button.title !== item.title) button.title = item.title
      }
      if (swatch && swatch.style.backgroundColor !== item.color) swatch.style.backgroundColor = item.color
    }
  }

  setOpen(open: boolean): void {
    this.open = open
    this.menu_.style.display = open ? '' : 'none'
    this.trigger_.classList.toggle('is-open', open)
    const { doc } = this.options_
    if (open) {
      if (this.outsideListener === null) {
        this.outsideListener = (event: Event) => {
          const target = event.target
          // 点在下拉组内部（触发按钮或某个选项）时由它们各自的 handler 处理，别抢
          if (target !== null && this.group.contains(target as Node)) return
          this.setOpen(false)
          // 这一击**只**用来关下拉，不放它继续走到画布上。
          //
          // 为什么必须拦住：用户刚在下拉里选完类型，工具还停在绘制模式；此时点一下画布想把
          // 下拉收起来，如果这一击照常落到画布，就会顺手落下一个顶点 —— 用户没想画，
          // 却得到一笔要撤销的东西。拦截只影响"下拉正展开"的这一击，收起后监听立即摘掉。
          event.stopPropagation()
        }
        doc.addEventListener('pointerdown', this.outsideListener, true)
      }
    } else if (this.outsideListener !== null) {
      doc.removeEventListener('pointerdown', this.outsideListener, true)
      this.outsideListener = null
    }
  }

  destroy(): void {
    // 先摘掉全局监听：地图层被停用时工具条会整个销毁，留着监听就是一处泄漏
    this.setOpen(false)
    this.group.remove()
  }
}
