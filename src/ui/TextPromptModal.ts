/**
 * 极简文本输入对话框。
 *
 * Obsidian 没有内置的 prompt()，而创建地图需要一个名字输入。
 * 这里只做这一件事，避免引入额外的 UI 依赖。
 */

import { Modal, Setting, type App } from 'obsidian'

export interface TextPromptOptions {
  title: string
  description?: string
  placeholder?: string
  initialValue?: string
  /** 确认按钮文案 */
  cta?: string
  /**
   * 是否允许留空提交。
   * 用于"命名"场景：留空 = 明确地"不起名字"，因此按钮文案是"跳过"而不是"确定"。
   */
  allowEmpty?: boolean
  /** 字段标签（默认"名称"） */
  fieldName?: string
}

export class TextPromptModal extends Modal {
  private value: string
  private readonly options: TextPromptOptions
  private readonly onSubmit: (value: string | null) => void
  private submitted = false

  constructor(app: App, options: TextPromptOptions, onSubmit: (value: string | null) => void) {
    super(app)
    this.options = options
    this.value = options.initialValue ?? ''
    this.onSubmit = onSubmit
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.options.title })
    if (this.options.description) contentEl.createEl('p', { text: this.options.description })

    let inputEl: HTMLInputElement | null = null
    new Setting(contentEl).setName(this.options.fieldName ?? '名称').addText((text) => {
      inputEl = text.inputEl
      text
        .setPlaceholder(this.options.placeholder ?? '')
        .setValue(this.value)
        .onChange((value) => {
          this.value = value
        })
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          this.submit()
        }
      })
    })

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(this.options.cta ?? '确定')
          .setCta()
          .onClick(() => this.submit()),
      )
      .addButton((button) =>
        button.setButtonText(this.options.allowEmpty ? '跳过' : '取消').onClick(() => {
          if (this.options.allowEmpty) this.submitEmpty()
          else this.cancel()
        }),
      )

    // 打开后自动聚焦输入框
    globalThis.setTimeout(() => inputEl?.focus(), 0)
  }

  private submit(): void {
    if (this.submitted) return
    const value = this.value.trim()
    if (value.length === 0 && this.options.allowEmpty !== true) {
      // 名称是必填项：不关闭对话框，让用户补上
      return
    }
    this.submitted = true
    this.onSubmit(value.length > 0 ? value : null)
    this.close()
  }

  /** 明确地"留空提交"（跳过命名） */
  private submitEmpty(): void {
    if (this.submitted) return
    this.submitted = true
    this.onSubmit(null)
    this.close()
  }

  private cancel(): void {
    if (this.submitted) return
    this.submitted = true
    this.onSubmit(null)
    this.close()
  }

  override onClose(): void {
    // 直接关闭（Esc / 点遮罩）时也要回调，否则调用方会永远等下去
    if (!this.submitted) {
      this.submitted = true
      this.onSubmit(null)
    }
    this.contentEl.empty()
  }
}
