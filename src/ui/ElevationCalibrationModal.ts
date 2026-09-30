/**
 * 「设置海拔标定…」对话框。
 *
 * 为什么需要它：深度的**相对值读数**（0–1）必须有一个锚 —— 这张地图最深到哪、最高到哪。
 * 那是**这个世界的事实**（不是"我现在想怎么看"），所以它写进**地图文件**的 `elevation` 段，
 * 与 `grid` 同级（见 `mapDocument.ts` 与设计草案 §2.2）。
 *
 * 对话框里就两件事：两个数字（最深深度 / 最高高度）+ 一张**换算预览表**。
 * 预览表是刻意的：光看两个数字，用户没法知道"海平面落在 0.73"这种事，
 * 而换个展示单位（米 / 千米 / 相对值）之后，同一格读数会变成什么样，一看就明白了。
 *
 * 与仓库里其它对话框同一套路：控件带稳定的 `dataset` 标记供冒烟断言，
 * 填不出合法值时**不关窗**（原因就在旁边，改一下就能重试）。
 */

import { Modal, Setting, type App } from 'obsidian'
import {
  normalizeElevationCalibration,
  parseCalibrationInput,
  previewCalibrationTable,
  type ElevationCalibration,
} from '../render/elevationUnits.ts'

export interface ElevationCalibrationModalOptions {
  /** 当前标定；`null` = 这张地图还没有这一段（未标定） */
  current: ElevationCalibration | null
  /** 点保存：`null` = 清空这一段（回到"未标定"） */
  onSubmit: (calibration: ElevationCalibration | null) => void
}

/** 弹窗工厂：默认用真实 `ElevationCalibrationModal`，测试里可注入替身 */
export type ElevationModalFactory = (app: App, options: ElevationCalibrationModalOptions) => { open(): void }

export class ElevationCalibrationModal extends Modal {
  private readonly options: ElevationCalibrationModalOptions
  private depthInputEl: HTMLInputElement | null = null
  private heightInputEl: HTMLInputElement | null = null
  private previewEl: HTMLElement | null = null
  private noteEl: HTMLElement | null = null
  private saveButtonEl: HTMLButtonElement | null = null

  constructor(app: App, options: ElevationCalibrationModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: '设置海拔标定' })
    contentEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '这两个数决定"相对值 0–1"锚在哪：填最深深度与最高高度（都是正数，单位米）。' +
        '它们写进地图文件（这个世界的事实），而"用米 / 千米 / 相对值来看"是你的显示偏好，在设置页的「数值图层」里。',
    })

    new Setting(contentEl)
      .setName('最深深度（m）')
      .setDesc('这张地图最深的地方有多深；留空 = 不填（不是 0 —— 0 表示"最深就是海平面"）')
      .addText((text) => {
        text.setPlaceholder('例如 8000')
        text.setValue(this.options.current?.maxDepth?.toString() ?? '')
        this.depthInputEl = text.inputEl
        this.depthInputEl.dataset.fcElevation = 'maxDepth'
        text.onChange(() => this.refresh())
      })

    new Setting(contentEl)
      .setName('最高高度（m）')
      .setDesc('这张地图最高的地方有多高；留空 = 不填')
      .addText((text) => {
        text.setPlaceholder('例如 3000')
        text.setValue(this.options.current?.maxHeight?.toString() ?? '')
        this.heightInputEl = text.inputEl
        this.heightInputEl.dataset.fcElevation = 'maxHeight'
        text.onChange(() => this.refresh())
      })

    this.previewEl = contentEl.createEl('pre', { cls: 'fc-elevation-preview', text: '' })
    this.previewEl.dataset.fcElevation = 'preview'
    this.noteEl = contentEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.noteEl.dataset.fcElevation = 'note'

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText('取消').onClick(() => this.close())
      })
      .addButton((button) => {
        button.setButtonText('清空标定').onClick(() => {
          // 清空 = 删掉这一段（回到"未标定"），与"填 0"是两件事
          this.options.onSubmit(null)
          this.close()
        })
      })
      .addButton((button) => {
        button.setButtonText('保存').setCta()
        this.saveButtonEl = button.buttonEl
        if (this.saveButtonEl !== null) this.saveButtonEl.dataset.fcElevation = 'save'
        button.onClick(() => this.submit())
      })

    this.refresh()
  }

  /** 读出当前输入（非法时给出原因，预览表与保存按钮据此反应） */
  private readInputs(): { ok: true; calibration: ElevationCalibration } | { ok: false; problem: string } {
    const depth = parseCalibrationInput(this.depthInputEl?.value ?? '', '最深深度')
    if (!depth.ok) return { ok: false, problem: depth.problem }
    const height = parseCalibrationInput(this.heightInputEl?.value ?? '', '最高高度')
    if (!height.ok) return { ok: false, problem: height.problem }
    return {
      ok: true,
      calibration: normalizeElevationCalibration({ unit: 'm', maxDepth: depth.value, maxHeight: height.value }),
    }
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
    if (this.previewEl !== null) this.previewEl.textContent = previewCalibrationTable(parsed.calibration)
    if (this.saveButtonEl !== null) this.saveButtonEl.disabled = false
  }

  private submit(): void {
    const parsed = this.readInputs()
    if (!parsed.ok) return
    const calibration = parsed.calibration
    // 两个都留空 = 没有能锚的东西 → 交给上层去删掉这一段（而不是在文件里写两个 null）
    const empty = calibration.maxDepth === null && calibration.maxHeight === null
    this.options.onSubmit(empty ? null : calibration)
    this.close()
  }
}