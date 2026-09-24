/**
 * 「导入定义文件」确认对话框。
 *
 * ## 为什么要一个确认对话框（而不是"选了文件就导入"）
 *
 * 导入是**外部内容进入用户设置**的动作：一份别人给的 JSON 会往你的地形/标记/路径类型列表里
 * 加东西。用户在下决定之前需要知道三件事：**新增几条、哪些因为同 ID 被保留、哪些不合法及原因**。
 * 只有把这三件事摆在眼前，"确认导入"才是一个有依据的决定，而不是一次赌博。
 *
 * 正文由 `resourceBundle.describeImportPlan` 算好（纯函数、可单测），对话框只负责画出来 ——
 * 这样"对话框里说的"与"真的会做的"来自同一份计划，不可能不一致。
 *
 * ## 边界
 *
 * 这个类**不认识 vault、也不认识设置**：读文件在调用方，写设置在 `onConfirm` 里。
 * 于是它能在没有 Obsidian 的环境里被构造与断言（与 `ExportModal` / `ReportModal` 同一思路）。
 *
 * 失败**不关窗**且只给一条提示：与导出对话框同一条规矩 —— 失败时用户最想做的就是再试一次。
 * 确认按钮在"没有可新增条目"时是灰的：**点不动比点了报错好**，而且此时正文已经说清了原因。
 */

import { Modal, Notice, Setting, type App } from 'obsidian'

/** 导入失败提示的时长（与导出对话框同一套约定，不超过 6000ms） */
const IMPORT_FAIL_NOTICE_MS = 6000

export interface ImportBundleModalOptions {
  /** 来源文件（库内路径，显示给用户确认"我选的是哪一份"） */
  source: string
  /** 计划正文（多行，由 `describeImportPlan` 生成） */
  planText: string
  /** 有东西可导入时才允许确认 */
  canImport: boolean
  /**
   * 真正去导入（合并进设置、落盘都在调用方）。
   *
   * 返回 `{ ok: false }` 表示失败；`reason` 留空表示调用方已经给过具体原因，
   * 此时本对话框不再重复弹一条（一次失败只说一句话）。
   */
  onConfirm: () => Promise<ImportBundleOutcome>
}

/** 导入结果：`ok: false` 时对话框留在原地 */
export type ImportBundleOutcome = { ok: true } | { ok: false; reason?: string }

/** 导入对话框工厂：可注入替身，便于自动化测试 */
export type ImportBundleModalFactory = (app: App, options: ImportBundleModalOptions) => { open(): void }

export class ImportBundleModal extends Modal {
  private readonly options: ImportBundleModalOptions

  constructor(app: App, options: ImportBundleModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('fc-import')
    contentEl.createEl('h3', { cls: 'fc-import-title', text: '导入定义文件' })
    contentEl.createEl('div', { cls: 'fc-import-source', text: `来源：${this.options.source}` })
    // 用 <pre> 而不是普通 div：正文是逐条列出的多行文本，换行与缩进要保留下来
    contentEl.createEl('pre', { cls: 'fc-import-plan', text: this.options.planText })

    const buttons = new Setting(contentEl).addButton((button) => {
      // `buttonEl` 由组件自己带出来（**不能**去读 `Setting` 上的按钮数组：
      // 真实 `Setting` 没有公开这种数组，只有假 DOM 里才有）。
      // 判空只是不让"某个版本没有这个成员"变成一次崩溃 —— 少了标记，冒烟里
      // "确认按钮带稳定标记"那条断言会直接红，而不是悄悄少测一件事。
      if (button.buttonEl) button.buttonEl.dataset.fcImportRole = 'confirm'
      button
        .setButtonText('导入')
        .setCta()
        .setDisabled(!this.options.canImport)
        .onClick(() => {
          void this.runImport()
        })
    })

    buttons.addButton((button) => {
      if (button.buttonEl) button.buttonEl.dataset.fcImportRole = 'cancel'
      button.setButtonText('取消').onClick(() => {
        this.close()
      })
    })
  }

  private async runImport(): Promise<void> {
    try {
      const outcome = await this.options.onConfirm()
      if (outcome.ok === false) {
        // 调用方说"没成功"时**不关窗**：用户可能想再试一次（或去看文件到底哪里不对）
        if (typeof outcome.reason === 'string' && outcome.reason.length > 0) {
          new Notice(`导入失败：${outcome.reason}`, IMPORT_FAIL_NOTICE_MS)
        }
        return
      }
      this.close()
    } catch (error) {
      new Notice(`导入失败：${error instanceof Error ? error.message : String(error)}`, IMPORT_FAIL_NOTICE_MS)
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
