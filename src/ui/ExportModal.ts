/**
 * 「导出地图」对话框：一次选好**范围**与**格式**，再导出。
 *
 * ## 为什么合成一个对话框
 *
 * 原来是两条独立命令（导出 SVG / 导出 PNG），各自只做一件事。加了"导出范围"之后，
 * 如果继续按两条命令 × 三种范围去铺命令面板，会变成 6 条命令 —— 命令面板是给人按名字找东西的地方，
 * 铺得越多越难找。所以改成**一条命令 + 一个对话框**：
 * 范围与格式都在里面选，命令面板里永远只有一条「导出地图…」。
 * 原有两条命令**保留**（不删）：老用户的手指记忆不该被我们作废。
 *
 * ## 边界
 *
 * 这个类**不认识 vault、也不认识地图文档**：范围解析与写文件都由调用方注入
 * （`describe` 给一行预览摘要，`onExport` 真去导）。于是它能在没有 Obsidian 的环境里
 * 被构造与断言 —— 与 `ReportModal` 同一个思路。
 *
 * 摘要与"能不能导"来自同一个 `describe`：范围不合法（例如"这张地图上还没有区域"）时，
 * 摘要位置直接显示那句原因，并且**导出按钮变灰** —— 点不动比点了报错好，
 * 而且这条判断在 `main.ts` 里还会再做一次（对话框可以被绕过，真正的守门要在导出那一侧）。
 */

import { Modal, Notice, Setting, type App } from 'obsidian'
import type { ExportRange, ExportRangeOption } from '../base/exportBounds.ts'

export type ExportFormat = 'svg' | 'png'

/** 导出失败：可能是多行原因 */
const EXPORT_FAIL_NOTICE_MS = 6000

export const EXPORT_FORMAT_OPTIONS: ReadonlyArray<{ value: ExportFormat; label: string }> = [
  { value: 'svg', label: 'SVG（矢量，可无损缩放）' },
  { value: 'png', label: 'PNG（1600 × 1000 位图，方便直接贴出去）' },
]

export interface ExportModalOptions {
  /** 可选范围（默认取 `EXPORT_RANGE_OPTIONS`，允许调用方收窄） */
  ranges: readonly ExportRangeOption[]
  /** 地图上画过的区域；`range.kind === 'region'` 时用它的下拉列表 */
  regions: ReadonlyArray<{ id: string; label: string }>
  initialRange: ExportRange
  initialFormat: ExportFormat
  /** 一行预览摘要；不合法时给出可读原因（此时导出按钮变灰） */
  describe: (range: ExportRange, format: ExportFormat) => { ok: true; text: string } | { ok: false; reason: string }
  /**
   * 真正去导（写库、重名规则都在调用方）。
   *
   * 返回 `{ ok: false }` 表示失败；**`reason` 留空表示调用方已经给过具体原因**
   * （例如"导出 PNG 失败：这个环境不支持 toBlob"），此时本对话框不再重复弹一条。
   * 失败**不关窗** —— 用户最可能做的就是换个范围/格式再试（例如 PNG 不可用时改用 SVG）。
   */
  onExport: (range: ExportRange, format: ExportFormat) => Promise<ExportOutcome>
}

/** 导出结果：`ok: false` 时对话框留在原地（`reason` 只用于"调用方还没说过原因"的情况） */
export type ExportOutcome = { ok: true } | { ok: false; reason?: string }

/** 导出对话框工厂：可注入替身，便于自动化测试 */
export type ExportModalFactory = (app: App, options: ExportModalOptions) => { open(): void }

export class ExportModal extends Modal {
  private readonly options: ExportModalOptions
  private range: ExportRange
  private format: ExportFormat

  constructor(app: App, options: ExportModalOptions) {
    super(app)
    this.options = options
    this.range = options.initialRange
    this.format = options.initialFormat
  }

  override onOpen(): void {
    this.contentEl.addClass('fc-export')
    this.render()
  }

  /**
   * 每次选择变化都整块重建。
   *
   * 这个对话框只有三行控件，重建的代价可以忽略；而"范围换成区域时才出现区域下拉"这种
   * 条件渲染，用重建来表达最不容易漏（改成原地显隐就得自己记状态，那正是"两份状态"的起点）。
   */
  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { cls: 'fc-export-title', text: '导出地图' })

    new Setting(contentEl)
      .setName('导出范围')
      .setDesc(this.options.ranges.find((item) => item.kind === this.range.kind)?.hint ?? '')
      .addDropdown((dropdown) => {
        for (const option of this.options.ranges) dropdown.addOption(option.kind, option.label)
        dropdown.setValue(this.range.kind)
        dropdown.onChange((value) => {
          const kind = value as ExportRange['kind']
          // 从"全部/视口"切到"区域"时，默认选第一个区域 —— 否则下拉是空的，
          // 用户得再点一次才知道要选什么
          const regionId = kind === 'region' ? (this.range.regionId ?? this.options.regions[0]?.id) : undefined
          this.range = { kind, ...(regionId !== undefined ? { regionId } : {}) }
          this.render()
        })
        // 稳定的 dataset 标记：断言按它找控件，就不怕以后改标题文案（§5.22 的教训）
        if (dropdown.selectEl) dropdown.selectEl.dataset.fcExportRole = 'range'
      })

    if (this.range.kind === 'region') {
      new Setting(contentEl)
        .setName('区域')
        .setDesc(
          this.options.regions.length === 0
            ? '这张地图上还没有区域。'
            : `共 ${this.options.regions.length} 个区域。导出会按该区域的范围 + 留白来取景。`,
        )
        .addDropdown((dropdown) => {
          for (const region of this.options.regions) dropdown.addOption(region.id, region.label)
          dropdown.setValue(this.range.regionId ?? '')
          dropdown.onChange((value) => {
            this.range = { kind: 'region', regionId: value }
            this.render()
          })
          if (dropdown.selectEl) dropdown.selectEl.dataset.fcExportRole = 'region'
        })
    }

    new Setting(contentEl)
      .setName('导出格式')
      .addDropdown((dropdown) => {
        for (const option of EXPORT_FORMAT_OPTIONS) dropdown.addOption(option.value, option.label)
        dropdown.setValue(this.format)
        dropdown.onChange((value) => {
          this.format = value as ExportFormat
          this.render()
        })
        if (dropdown.selectEl) dropdown.selectEl.dataset.fcExportRole = 'format'
      })

    const preview = this.options.describe(this.range, this.format)
    contentEl.createEl('div', {
      cls: preview.ok ? 'fc-export-summary' : 'fc-export-summary is-problem',
      text: preview.ok ? preview.text : preview.reason,
    })

    const buttons = new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('导出')
        .setCta()
        .setDisabled(!preview.ok)
        .onClick(() => {
          void this.runExport()
        }),
    )
    buttons.addButton((button) =>
      button.setButtonText('取消').onClick(() => {
        this.close()
      }),
    )
  }

  private async runExport(): Promise<void> {
    try {
      const outcome = await this.options.onExport(this.range, this.format)
      // 调用方说"没成功"时**不关窗**：用户可能想换个范围/格式再试一次
      // （PNG 光栅化在受限环境里不可用时，改用 SVG 就是一条正当的退路）。
      // 只有"调用方还没说过原因"时才由这里补一句提示 —— 一次失败只说一句话。
      if (outcome.ok === false) {
        if (typeof outcome.reason === 'string' && outcome.reason.length > 0) {
          new Notice(`导出失败：${outcome.reason}`, EXPORT_FAIL_NOTICE_MS)
        }
        return
      }
      this.close()
    } catch (error) {
      new Notice(`导出失败：${error instanceof Error ? error.message : String(error)}`, EXPORT_FAIL_NOTICE_MS)
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
