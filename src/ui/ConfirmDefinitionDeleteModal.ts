/**
 * 「删除定义」确认对话框：删之前先把**影响面**说清楚。
 *
 * 为什么删除反而比"改 ID"更需要一个确认框（改 ID 早就有 `RenameDefinitionModal`）：
 * 删掉一条自定义定义**不会**删掉地图上的对象，但那些对象会立刻变成回退样式（未知）。
 * 用户在下决定之前必须知道三件事：**有多少、在哪几张地图、数据其实没丢**。
 * 只有把这三件事摆在眼前，"删除"才是一个有依据的决定。
 *
 * 正文由 `describeDeletionPlan` 算好（纯函数、可单测），对话框只负责画出来 ——
 * 于是"对话框里说的"与"真的会做的"来自同一份计划，不可能不一致。
 *
 * ## 只在**有引用**时才打开
 *
 * 一条从没被用过的定义，删除没有任何影响面可说 —— 那种情况下调用方**直接删**，
 * 根本不弹这个框（`requestRemoveCustomDefinition` 里分流）。这里只处理"确实要拦一下"的情形。
 *
 * 与仓库里其它对话框（`RenameDefinitionModal` / `ImportBundleModal`）同一套路：
 * 控件带稳定的 `dataset` 标记供冒烟断言，失败**不关窗**（原因就在旁边，改一下就能重试）。
 */

import { Modal, Notice, Setting, type App } from 'obsidian'

/** 失败提示的时长（与其它对话框同一套约定，不超过 6000ms） */
const DELETE_FAIL_NOTICE_MS = 6000

export type DeletePreview = { ok: true; text: string } | { ok: false; problem: string }
export type DeleteOutcome = { ok: true } | { ok: false; problem: string }

export interface ConfirmDefinitionDeleteModalOptions {
  /** 例如「地形」 */
  kindLabel: string
  /** 要删的定义 ID（例如 custom:marsh） */
  id: string
  /** 显示名，仅用于让人确认删的是哪一条 */
  displayName: string
  /** 打开时调用一次：**只算不写**（要读地图文件，所以是异步的） */
  onPreview: () => Promise<DeletePreview>
  /** 点确认时调用：真正删掉定义（只改插件设置，**不碰地图文件**） */
  onConfirm: () => Promise<DeleteOutcome>
}

/** 弹窗工厂：默认用真实 `ConfirmDefinitionDeleteModal`，测试里可注入替身 */
export type ConfirmDeleteModalFactory = (
  app: App,
  options: ConfirmDefinitionDeleteModalOptions,
) => { open(): void }

export class ConfirmDefinitionDeleteModal extends Modal {
  private readonly options: ConfirmDefinitionDeleteModalOptions
  private previewEl: HTMLElement | null = null
  private noteEl: HTMLElement | null = null
  private confirmButtonEl: HTMLButtonElement | null = null

  constructor(app: App, options: ConfirmDefinitionDeleteModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('fc-defdelete')
    contentEl.createEl('h3', { text: `删除定义 · ${this.options.displayName}` })
    contentEl.createEl('div', {
      cls: 'fc-rename-current',
      text: `要删除的是这条${this.options.kindLabel}定义：${this.options.id}`,
    })

    // 影响面正文：先占位，异步算完再填（用户会看到"正在统计…"而不是一个空格子）
    this.previewEl = contentEl.createEl('pre', { cls: 'fc-rename-preview', text: '正在统计引用…' })
    this.previewEl.dataset.fcDeleteRole = 'preview'
    this.noteEl = contentEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.noteEl.dataset.fcNote = 'delete'

    new Setting(contentEl)
      .addButton((button) => {
        if (button.buttonEl) button.buttonEl.dataset.fcDeleteRole = 'cancel'
        button.setButtonText('取消').onClick(() => this.close())
      })
      .addButton((button) => {
        button.setButtonText('删除').setWarning()
        this.confirmButtonEl = button.buttonEl
        if (this.confirmButtonEl !== null) this.confirmButtonEl.dataset.fcDeleteRole = 'confirm'
        button.onClick(() => {
          void this.submit()
        })
      })

    void this.refresh()
  }

  /** 算影响面（只读）；算不出来就说清原因并**禁用确认** —— 说不清影响面就不该允许删 */
  private async refresh(): Promise<void> {
    try {
      const preview = await this.options.onPreview()
      if (this.previewEl === null) return
      this.previewEl.textContent = preview.ok ? preview.text : `无法统计影响面：${preview.problem}`
      if (this.confirmButtonEl !== null) this.confirmButtonEl.disabled = preview.ok === false
    } catch (error) {
      if (this.previewEl === null) return
      this.previewEl.textContent = `无法统计影响面：${error instanceof Error ? error.message : String(error)}`
      if (this.confirmButtonEl !== null) this.confirmButtonEl.disabled = true
    }
  }

  private async submit(): Promise<void> {
    try {
      const outcome = await this.options.onConfirm()
      if (outcome.ok === false) {
        // 失败**不关窗**：用户可能想再试一次
        if (this.noteEl !== null) this.noteEl.textContent = `删除失败：${outcome.problem}`
        return
      }
      this.close()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (this.noteEl !== null) this.noteEl.textContent = `删除失败：${reason}`
      new Notice(`删除失败：${reason}`, DELETE_FAIL_NOTICE_MS)
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}