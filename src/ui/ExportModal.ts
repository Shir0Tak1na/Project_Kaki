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
 *
 * ## 落点（保存位置 + 文件名）
 *
 * 加这一块是因为用户的抱怨「导出的时候应该有个文件资源管理器一样的浏览功能」：
 * 以前路径是**从地图文件推导出来的**，用户既看不到也改不了。
 * Obsidian 没有系统级文件选择器，所以「浏览」是**从库内文件夹里挑**
 * （由调用方注入 `pickFolder`，与图片选择器同一套 `AssetSuggestModal`）。
 *
 * 文件名默认跟着**范围**走（`World` / `World-视口` / `World-北境领`），
 * 但用户改过之后就不该被我们的默认值覆盖 —— 判据是"当前值是否还等于上一次推出来的默认值"：
 * 相等（没改过）⇒ 切范围时跟着重算；不等（改过）⇒ 一直保留用户写的那个。
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from 'obsidian'
import type { ExportRange, ExportRangeOption } from '../base/exportBounds.ts'

export type ExportFormat = 'svg' | 'png'

/**
 * 导出落点：写到哪个文件夹、叫什么名字。
 *
 * `fileName` **不含扩展名** —— 扩展名由 `format` 决定（见 `stripExportExtension`）。
 * `folder` 是库内相对路径，`''` = 库根。
 */
export interface ExportTarget {
  folder: string
  fileName: string
}

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
  /** 保存位置的初始值（`''` = 库根；调用方通常给"上次用的目录，没记录过就是地图所在目录"） */
  initialFolder: string
  /** 由范围推出**默认文件名**（不含扩展名）；用户改过文件名之后不再覆盖他改的那个 */
  defaultFileName: (range: ExportRange) => string
  /**
   * 让用户从**库内文件夹**里挑一个（由调用方注入；不注入就不显示「浏览…」按钮）。
   *
   * 注入而不是让本类去问 vault：这个类刻意不认识 vault（见文件头），
   * 而"库里有哪几个文件夹"是调用方的知识。
   */
  pickFolder?: (onChoose: (folder: string) => void) => void
  /** 一行预览摘要；范围或落点不合法时给出可读原因（此时导出按钮变灰） */
  describe: (
    range: ExportRange,
    format: ExportFormat,
    target: ExportTarget,
  ) => { ok: true; text: string } | { ok: false; reason: string }
  /**
   * 真正去导（写库、重名规则都在调用方）。
   *
   * 返回 `{ ok: false }` 表示失败；**`reason` 留空表示调用方已经给过具体原因**
   * （例如"导出 PNG 失败：这个环境不支持 toBlob"），此时本对话框不再重复弹一条。
   * 失败**不关窗** —— 用户最可能做的就是换个范围/格式再试（例如 PNG 不可用时改用 SVG）。
   */
  onExport: (range: ExportRange, format: ExportFormat, target: ExportTarget) => Promise<ExportOutcome>
}

/** 导出结果：`ok: false` 时对话框留在原地（`reason` 只用于"调用方还没说过原因"的情况） */
export type ExportOutcome = { ok: true } | { ok: false; reason?: string }

/** 导出对话框工厂：可注入替身，便于自动化测试 */
export type ExportModalFactory = (app: App, options: ExportModalOptions) => { open(): void }

export class ExportModal extends Modal {
  private readonly options: ExportModalOptions
  private range: ExportRange
  private format: ExportFormat
  /** 保存位置（库内相对路径，`''` = 库根） */
  private folder: string
  private fileName: string
  /** 上一次由范围推出来的默认文件名 —— 用它判断"用户改过没有"（见文件头） */
  private derivedFileName: string
  /** 摘要那一行；改输入框时就地刷新它（不整块重建，免得输入框失焦） */
  private previewEl: HTMLElement | null = null
  /** 导出按钮：摘要判定不合法时由 `renderPreview` 把它变灰 */
  private exportButton: ButtonComponent | null = null

  constructor(app: App, options: ExportModalOptions) {
    super(app)
    this.options = options
    this.range = options.initialRange
    this.format = options.initialFormat
    this.folder = options.initialFolder
    this.derivedFileName = options.defaultFileName(options.initialRange)
    this.fileName = this.derivedFileName
  }

  /**
   * 换范围：文件名若还等于上次推出来的默认值就跟着重算，否则保留用户写的那个。
   *
   * `region` 那一项还要决定用哪个区域（没选过就默认第一个，否则下拉是空的）。
   */
  private applyRange(kind: ExportRange['kind'], regionId?: string): void {
    const nextRegionId =
      kind === 'region' ? (regionId ?? this.range.regionId ?? this.options.regions[0]?.id) : undefined
    this.range = { kind, ...(nextRegionId !== undefined ? { regionId: nextRegionId } : {}) }
    const derived = this.options.defaultFileName(this.range)
    if (this.fileName === this.derivedFileName) this.fileName = derived
    this.derivedFileName = derived
    this.render()
  }

  override onOpen(): void {
    this.contentEl.addClass('fc-export')
    this.render()
  }

  /**
   * 每次选择变化都整块重建。
   *
   * 这个对话框只有几行控件，重建的代价可以忽略；而"范围换成区域时才出现区域下拉"这种
   * 条件渲染，用重建来表达最不容易漏（改成原地显隐就得自己记状态，那正是"两份状态"的起点）。
   *
   * ⚠️ 两个**输入框**（保存位置 / 文件名）反过来：它们的 `onChange` 只更新本地状态 +
   * 就地刷新摘要，**不重建** —— 重建会把正在打字的输入框换成新元素，焦点与光标位置一起丢，
   * 用户根本没法连续输入（`Focus` 那条教训的同一类问题）。
   */
  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    // 整块重建会把这两个引用指向已经不在 DOM 里的旧元素，必须一起清掉
    this.previewEl = null
    this.exportButton = null
    contentEl.createEl('h3', { cls: 'fc-export-title', text: '导出地图' })

    new Setting(contentEl)
      .setName('导出范围')
      .setDesc(this.options.ranges.find((item) => item.kind === this.range.kind)?.hint ?? '')
      .addDropdown((dropdown) => {
        for (const option of this.options.ranges) dropdown.addOption(option.kind, option.label)
        dropdown.setValue(this.range.kind)
        dropdown.onChange((value) => {
          // 从"全部/视口"切到"区域"时，默认选第一个区域 —— 否则下拉是空的，
          // 用户得再点一次才知道要选什么
          this.applyRange(value as ExportRange['kind'])
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
            this.applyRange('region', value)
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

    new Setting(contentEl)
      .setName('保存位置')
      .setDesc(
        (this.folder.trim().length === 0 ? '库根目录。' : `库内文件夹：${this.folder.trim()}。`) +
          '可以手动填一个新的目录名（导出时会自动建）。',
      )
      .addText((text) => {
        text
          .setPlaceholder('库内文件夹（留空 = 库根）')
          .setValue(this.folder)
          .onChange((value) => {
            // 只改本地状态、不整块重建：重建会让输入框失焦（用户根本没法连续打字）。
            // 摘要与按钮状态在**点导出前**才重新算 —— `describe` 是在下一次 render 里调的，
            // 所以这里要就地刷新那一行摘要。
            this.folder = value
            this.renderPreview()
          })
        if (text.inputEl) text.inputEl.dataset.fcExportRole = 'folder'
      })
      .addButton((button) => {
        button.setButtonText('浏览…').setTooltip('从库内文件夹里挑一个').onClick(() => {
          this.options.pickFolder?.((folder) => {
            this.folder = folder
            this.render()
          })
        })
        if (button.buttonEl) button.buttonEl.dataset.fcExportRole = 'browse'
      })

    new Setting(contentEl)
      .setName('文件名')
      .setDesc('不含扩展名 —— 扩展名跟着上面选的格式（.svg / .png）。')
      .addText((text) => {
        text
          .setPlaceholder('文件名')
          .setValue(this.fileName)
          .onChange((value) => {
            this.fileName = value
            this.renderPreview()
          })
        if (text.inputEl) text.inputEl.dataset.fcExportRole = 'fileName'
      })

    this.previewEl = contentEl.createEl('div', { cls: 'fc-export-summary' })
    this.previewEl.dataset.fcExportRole = 'summary'

    const buttons = new Setting(contentEl).addButton((button) => {
      this.exportButton = button
      button
        .setButtonText('导出')
        .setCta()
        .onClick(() => {
          void this.runExport()
        })
    })
    buttons.addButton((button) =>
      button.setButtonText('取消').onClick(() => {
        this.close()
      }),
    )
    // 创建之后再算一次摘要：可用状态（灰不灰）由它统一决定
    this.renderPreview()
  }

  /** 当前落点 */
  private target(): ExportTarget {
    return { folder: this.folder, fileName: this.fileName }
  }

  /** 重算摘要那一行与导出按钮的可用状态（改输入框时就地刷新，不整块重建） */
  private renderPreview(): void {
    const preview = this.options.describe(this.range, this.format, this.target())
    if (this.previewEl) {
      this.previewEl.setText(preview.ok ? preview.text : preview.reason)
      this.previewEl.classList.toggle('is-problem', !preview.ok)
    }
    this.exportButton?.setDisabled(!preview.ok)
  }

  private async runExport(): Promise<void> {
    try {
      const outcome = await this.options.onExport(this.range, this.format, this.target())
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
