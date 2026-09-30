/**
 * 「设置数值图层默认值…」对话框。
 *
 * 为什么需要它（用户原话 2026-09-28）："如果有地方没有温度和深度的话就没有渲染，
 * 我认为每个格子初始应该自带一个值，**这个定义值就放在定义里面**。"
 * —— 于是每个字段一个数字，写进**地图文件**的 `dataDefaults` 段（与 `elevation` 同级）。
 *
 * 三条要在界面上讲清楚的事（施工文件 §B）：
 * 1. **只影响渲染**：格上有真值就用真值，这个数只是"没量过的格"的兜底，**文件里的格一个字节都不改**；
 * 2. **值是权威单位**（温度 ℃、深度 米）：所以行标题用字段自己的单位，不做展示单位换算
 *    —— 否则"在千米下填 3"到底写进去什么就没法解释了；
 * 3. **留空 = 不兜底**（不是 0）：0 是合法值（摄氏 0 度、海平面），与"没设"是两件事。
 *
 * **行是从字段表里派生的**（`spec.numeric` 筛一遍），所以加一个数值字段就自动多一行，
 * 这里一行都不用改（纪律 §4.7：加同类东西理想是加一行）。
 *
 * 与仓库里其它对话框同一套路：控件带稳定的 `dataset` 标记供冒烟断言；
 * 填不出合法值时**不关窗**，原因就在旁边。
 */

import { Modal, Setting, type App } from 'obsidian'
import { normalizeDataDefaults, parseDefaultInput, type DataDefaults } from '../render/dataDefaults.ts'
import type { NumericDefaultRow } from '../render/overlayFields.ts'
import { MODAL_ACTIONS } from './strings.ts'

export interface DataDefaultsModalOptions {
  /** 当前默认值；`null` = 这张地图还没有这一段（不兜底） */
  current: DataDefaults | null
  /** 要渲染的行（由调用方从字段表派生，见 `numericDefaultRows`） */
  rows: readonly NumericDefaultRow[]
  /**
   * 文件里那些**不在字段表里**的键（已原样保留）。非空时在弹窗里说明一句 ——
   * 否则用户看到文件里有个键、界面上却没有对应输入框，只会以为插件坏了。
   */
  unknownKeys: readonly string[]
  /** 点保存：`null` = 清空这一段（回到"不兜底"） */
  onSubmit: (defaults: DataDefaults | null) => void
}

/** 弹窗工厂：默认用真实 `DataDefaultsModal`，测试里可注入替身 */
export type DataDefaultsModalFactory = (app: App, options: DataDefaultsModalOptions) => { open(): void }

export class DataDefaultsModal extends Modal {
  private readonly options: DataDefaultsModalOptions
  /** 每个字段一个输入框（按 `key` 索引，行是从字段表派生的，所以不能写死两个变量） */
  private readonly inputs = new Map<string, HTMLInputElement>()
  private noteEl: HTMLElement | null = null
  private previewEl: HTMLElement | null = null
  private saveButtonEl: HTMLButtonElement | null = null

  constructor(app: App, options: DataDefaultsModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: '设置数值图层默认值' })
    contentEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '没量过温度的格会用这里的值来上色（"画过的地方整片都有颜色"）。' +
        '格上已经写了值的以那个值为准，这个数只是兜底 —— 它不会改你的地图文件，' +
        '所以改完立刻全图生效。留空 = 这一层不兜底。',
    })

    for (const row of this.options.rows) {
      new Setting(contentEl)
        .setName(row.title)
        .setDesc(row.desc)
        .addText((text) => {
          const current = this.options.current?.[row.key]
          text.setPlaceholder('留空 = 不兜底')
          text.setValue(typeof current === 'number' ? String(current) : '')
          const inputEl = text.inputEl
          inputEl.dataset.fcDataDefault = row.key
          this.inputs.set(row.key, inputEl)
          text.onChange(() => this.refresh())
        })
    }

    if (this.options.unknownKeys.length > 0) {
      contentEl.createEl('div', {
        cls: 'fc-settings-note',
        text: `文件里还有这几个键本插件不认（已原样保留，不会因为保存而消失）：${this.options.unknownKeys.join('、')}`,
      })
    }

    this.previewEl = contentEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.previewEl.dataset.fcDataDefault = 'preview'
    this.noteEl = contentEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.noteEl.dataset.fcDataDefault = 'note'

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText('取消').onClick(() => this.close())
      })
      .addButton((button) => {
        button.setButtonText(MODAL_ACTIONS.clearAll).onClick(() => {
          // 清空 = 删掉这一段（回到"不兜底"），与"每个字段都填 0"是两件事
          this.options.onSubmit(null)
          this.close()
        })
      })
      .addButton((button) => {
        button.setButtonText(MODAL_ACTIONS.save).setCta()
        this.saveButtonEl = button.buttonEl
        if (this.saveButtonEl !== null) this.saveButtonEl.dataset.fcDataDefault = 'save'
        button.onClick(() => this.submit())
      })

    this.refresh()
  }

  /** 读出当前输入：任一行非法就整张表不成立（错的那一行旁边有原因） */
  private readInputs(): { ok: true; defaults: DataDefaults | null } | { ok: false; problem: string } {
    const raw: Record<string, number> = {}
    for (const row of this.options.rows) {
      const parsed = parseDefaultInput(this.inputs.get(row.key)?.value ?? '', row.title)
      if (!parsed.ok) return { ok: false, problem: parsed.problem }
      if (parsed.value !== null) raw[row.key] = parsed.value
    }
    // 归一化同时承担"全部留空 → null"：于是保存时**不会**在文件里留一个空对象（§B.5）
    return { ok: true, defaults: normalizeDataDefaults(raw) }
  }

  private refresh(): void {
    const parsed = this.readInputs()
    if (!parsed.ok) {
      if (this.previewEl !== null) this.previewEl.textContent = ''
      if (this.noteEl !== null) this.noteEl.textContent = parsed.problem
      if (this.saveButtonEl !== null) this.saveButtonEl.disabled = true
      return
    }
    if (this.noteEl !== null) this.noteEl.textContent = ''
    if (this.previewEl !== null) {
      this.previewEl.textContent =
        parsed.defaults === null
          ? '当前：不兜底（没量过值的格保持空白）'
          : `当前：${this.options.rows
              .filter((row) => parsed.defaults !== null && row.key in parsed.defaults)
              .map((row) => `${row.title} = ${parsed.defaults![row.key]}`)
              .join(' · ')}`
    }
    if (this.saveButtonEl !== null) this.saveButtonEl.disabled = false
  }

  private submit(): void {
    const parsed = this.readInputs()
    if (!parsed.ok) return
    this.options.onSubmit(parsed.defaults)
    this.close()
  }
}