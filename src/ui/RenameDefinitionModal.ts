/**
 * 「改 ID…」确认对话框：改之前先把**影响面**说清楚。
 *
 * 为什么必须有一个对话框，而不是改完再报告：改 ID 会**改动用户已有的地图文件**
 * （把 `custom:old` 的引用逐个换成 `custom:new`）。这种不可逆操作必须先给数字：
 * 哪几张地图、各几处引用。用户看到"1 张地图里 3 处"才有可能判断该不该继续。
 *
 * 与仓库里其它对话框（`ImportBundleModal` / `ExportModal`）同一套路：
 * 控件带稳定的 `dataset` 标记供冒烟断言，失败时**不关窗**（原因就在旁边，改一下就能重试）。
 */

import { Modal, Setting, type App } from 'obsidian'

export type RenamePreview = { ok: true; text: string } | { ok: false; problem: string }
export type RenameOutcome = { ok: true; report: string } | { ok: false; problem: string }

export interface RenameDefinitionModalOptions {
  /** 例如「地形」 */
  kindLabel: string
  /** 当前 ID（例如 custom:marsh） */
  currentId: string
  /** 显示名，仅用于标题里让人确认改的是哪一条 */
  displayName: string
  /** 输入新 ID 时调用：只做校验与影响面统计（要读地图文件，所以是异步的），**不改任何东西** */
  onPreview: (rawNewId: string) => Promise<RenamePreview>
  /** 点确认时调用：真正执行迁移 */
  onConfirm: (rawNewId: string) => Promise<RenameOutcome>
}

/** 弹窗工厂：默认用真实 `RenameDefinitionModal`，测试里可注入替身 */
export type RenameModalFactory = (app: App, options: RenameDefinitionModalOptions) => { open(): void }

export class RenameDefinitionModal extends Modal {
  private readonly options: RenameDefinitionModalOptions
  private inputEl: HTMLInputElement | null = null
  private previewEl: HTMLElement | null = null
  private noteEl: HTMLElement | null = null
  private confirmButtonEl: HTMLButtonElement | null = null
  /** 异步预览的序号：丢弃过期结果，避免旧结果覆盖新结果 */
  private refreshToken = 0

  constructor(app: App, options: RenameDefinitionModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: `改 ID · ${this.options.displayName}` })
    contentEl.createEl('div', {
      cls: 'fc-rename-current',
      text: `当前 ID：${this.options.currentId}（这是写在地图文件里的内部标识，改它会把引用一起改掉）`,
    })

    new Setting(contentEl)
      .setName('新的 ID')
      .setDesc('留空 = 保持原样；字母小写、2–32 位，可用数字、下划线、连字符')
      .addText((text) => {
        text.setPlaceholder(this.options.currentId).setValue('')
        this.inputEl = text.inputEl
        if (this.inputEl !== null) this.inputEl.dataset.fcRenameRole = 'input'
        text.onChange((value) => {
          void this.refresh(value)
        })
      })

    this.previewEl = contentEl.createEl('pre', { cls: 'fc-rename-preview', text: '' })
    this.previewEl.dataset.fcRenameRole = 'preview'
    this.noteEl = contentEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.noteEl.dataset.fcNote = 'rename'

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText('取消').onClick(() => this.close())
      })
      .addButton((button) => {
        button.setButtonText('改 ID').setCta()
        this.confirmButtonEl = button.buttonEl
        if (this.confirmButtonEl !== null) this.confirmButtonEl.dataset.fcRenameRole = 'confirm'
        button.onClick(() => {
          void this.submit()
        })
      })

    void this.refresh('')
  }

  /** 输入变化 → 重新算影响面；确认按钮只在"确实要改"时可点 */
  private async refresh(rawNewId: string): Promise<void> {
    // 读地图文件是异步的：用户可能连着敲键，所以用序号丢弃过期结果，
    // 否则后到的旧结果会覆盖新结果（界面显示的影响面与实际不符）
    this.refreshToken += 1
    const token = this.refreshToken
    const preview = await this.options.onPreview(rawNewId)
    if (token !== this.refreshToken) return
    if (this.previewEl !== null) this.previewEl.textContent = preview.ok ? preview.text : ''
    if (this.noteEl !== null) this.noteEl.textContent = preview.ok ? '' : preview.problem
    if (this.confirmButtonEl !== null) {
      this.confirmButtonEl.disabled = !preview.ok || rawNewId.trim().length === 0
    }
  }

  private async submit(): Promise<void> {
    const raw = this.inputEl?.value ?? ''
    const result = await this.options.onConfirm(raw)
    if (!result.ok) {
      // 失败**不关窗**：原因就在旁边，用户改一下就能重试
      if (this.noteEl !== null) this.noteEl.textContent = result.problem
      return
    }
    // 结果由调用方（main.ts）用**报告面板**呈现：改动影响面是多行文本，
    // 塞进 Notice 会盖住右上角、还选不中复制不了（ReportModal 顶部注释记了这件事）
    this.close()
  }
}
