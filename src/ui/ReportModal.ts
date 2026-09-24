/**
 * 报告面板：把长篇文字报告放进一个可读、可复制、可导出的对话框。
 *
 * ## 为什么长文本不该用 Notice 承载（用户的原始反馈）
 *
 * 状态报告原来是 `new Notice(多行文本, 15000)`。用户的原话是：
 * "初次启动弹窗遮挡侧边栏的按钮，过一会才消失，等待时间过久，要不直接做成可导出的调试模式内容？"
 * 这句话里其实是三个独立的问题，都指向同一个结论：
 *
 * 1. **位置**：Obsidian 的 Notice 出现在右上角，正是侧边栏按钮所在的地方 —— 挡住的恰好是
 *    "下一步该点的东西"；
 * 2. **时长**：15 秒是为了"让人读完"，但用户并不想读，他想在需要时**回头查**；
 * 3. **拿不出来**：Notice 里的文字**选不中、复制不了**，而报告最常见的用途就是贴给别人排查。
 *
 * 所以：正文进 `<pre>`（可选中复制、超长可滚动、`user-select: text`），
 * 把"复制"与"导出为库内文件"变成按钮；只有**操作结果**才用短提示（≤4 秒）——
 * "已复制"这种事不需要长时间阅读。
 *
 * ## 边界
 *
 * 这个类**不认识 vault**：写文件由调用方通过 `onExport` 注入（它知道怎么处理重名）。
 * 于是这个类可以在没有 Obsidian 的环境里被构造与断言（冒烟里就是这么做的）。
 */

import { Modal, Notice, Setting, type App } from 'obsidian'

/** 复制成功：够看清一句话即可 */
export const REPORT_COPY_NOTICE_MS = 3000
/** 剪贴板不可用、退化为"已帮你选中"——需要用户做一个动作，给足 4 秒 */
export const REPORT_FALLBACK_NOTICE_MS = 4000
/** 导出成功：路径要看清 */
export const REPORT_EXPORT_NOTICE_MS = 4000
/** 导出失败：可能是多行原因，稍长一点 */
export const REPORT_EXPORT_ERROR_NOTICE_MS = 6000

export interface ReportModalOptions {
  title: string
  /** 报告正文（原样展示，不做任何截断 —— 报告的价值就在于完整） */
  text: string
  /** 导出用的库内路径（相对库根）。不提供则不显示"导出"按钮 */
  fileName?: string
  /**
   * 导出动作：由插件注入（它负责重名规则与写库），返回最终路径。
   * 失败就往抛异常，面板会把 message 显示成一句人话。
   */
  onExport?: (fileName: string, text: string) => Promise<string>
}

/** 报告面板工厂：可注入替身，便于自动化测试 */
export type ReportModalFactory = (app: App, options: ReportModalOptions) => { open(): void }

export class ReportModal extends Modal {
  private readonly options: ReportModalOptions
  /** 正文元素：复制失败时要用它来"帮用户选中" */
  private bodyEl: HTMLElement | null = null

  constructor(app: App, options: ReportModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('fc-report')
    // 标题带一个 class：便于断言与样式（`h3` 没有 class 的话，靠 tag 找元素很难写对）
    contentEl.createEl('h3', { cls: 'fc-report-title', text: this.options.title })

    // 用 <pre> 而不是 <p>/<div>：报告的换行与缩进是有意义的
    // （地形分类、图例条目都是缩进列表，塌掉之后就读不出来了）
    const body = contentEl.createEl('pre', { cls: 'fc-report-body' })
    body.setText(this.options.text)
    this.bodyEl = body

    const canExport = this.options.fileName !== undefined && this.options.onExport !== undefined
    if (canExport) {
      contentEl.createEl('div', {
        cls: 'fc-report-hint',
        text: `导出文件名：${this.options.fileName}（重名时自动加 -2、-3，不会覆盖已有文件）`,
      })
    }

    const buttons = new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('复制')
        .setCta()
        .onClick(() => {
          void this.copy()
        }),
    )
    if (canExport) {
      buttons.addButton((button) =>
        button.setButtonText('导出为库内文件').onClick(() => {
          void this.exportToFile()
        }),
      )
    }
    buttons.addButton((button) =>
      button.setButtonText('关闭').onClick(() => {
        this.close()
      }),
    )
  }

  /** 复制正文；剪贴板不可用时退化为"帮用户选中"，并明确告诉他下一步按什么 */
  private async copy(): Promise<void> {
    const text = this.options.text
    if (await this.writeClipboard(text)) {
      new Notice(`已复制报告（${text.length} 字符）`, REPORT_COPY_NOTICE_MS)
      return
    }
    const selected = this.selectBody()
    new Notice(
      selected ? '已选中报告正文，请按 Ctrl/Cmd+C 复制。' : '无法访问剪贴板，请手动选中正文复制。',
      REPORT_FALLBACK_NOTICE_MS,
    )
  }

  private async exportToFile(): Promise<void> {
    const { fileName, onExport, text } = this.options
    if (fileName === undefined || onExport === undefined) return
    try {
      const path = await onExport(fileName, text)
      new Notice(`已导出报告：${path}`, REPORT_EXPORT_NOTICE_MS)
    } catch (error) {
      new Notice(`导出报告失败：${error instanceof Error ? error.message : String(error)}`, REPORT_EXPORT_ERROR_NOTICE_MS)
    }
  }

  /**
   * 写剪贴板。
   *
   * `navigator.clipboard` 在部分环境里不存在（非安全上下文、权限被拒、老版本 Electron），
   * 所以这里**先探再用**，返回布尔值让调用方决定退化行为 —— 而不是让一个未捕获的异常
   * 变成"点了复制但什么都没发生"。
   */
  private async writeClipboard(text: string): Promise<boolean> {
    try {
      const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
        .navigator?.clipboard
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') return false
      await clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  /**
   * 退路：把正文选中，用户按一次 Ctrl/Cmd+C 就行。
   *
   * 用 `ownerDocument` 而不是全局 `document`：与项目里其它 DOM 代码一致
   * （面板/图例都这么做），这样在测试用的假 DOM 里取不到选择对象时也能安全返回 false。
   */
  private selectBody(): boolean {
    const body = this.bodyEl
    const doc = body?.ownerDocument ?? null
    if (body === null || doc === null) return false
    const selection = doc.defaultView?.getSelection?.() ?? null
    if (selection === null || typeof doc.createRange !== 'function') return false
    const range = doc.createRange()
    range.selectNodeContents(body)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }

  override onClose(): void {
    this.bodyEl = null
    this.contentEl.empty()
  }
}
