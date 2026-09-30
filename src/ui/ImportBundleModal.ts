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
import { DIALOG_LABELS } from './strings.ts'

/** 导入失败提示的时长（与导出对话框同一套约定，不超过 6000ms） */
const IMPORT_FAIL_NOTICE_MS = 6000

export interface ImportBundleModalOptions {
  /** 来源文件（库内路径，显示给用户确认"我选的是哪一份"） */
  source: string
  /**
   * **导入到哪里**的一句话（W4-3：导入落的是"当前地图的定义集"）。
   *
   * 由调用方给：对话框不认识地图层，也不该去猜"当前是哪张图"。
   */
  target: string
  /** 计划正文（多行，由 `describeImportPlan` 生成） */
  planText: string
  /** 有东西可导入（新增或覆盖）时才允许确认 */
  canImport: boolean
  /**
   * 同名冲突清单（文件里那一条的 ID 在这张图里已经有了）—— 逐条给用户选「跳过 / 覆盖」。
   *
   * 默认全部**跳过**（只增不删的老口径）：覆盖是用户显式要求的动作，不能是默认值。
   */
  conflicts: readonly ImportBundleConflict[]
  /**
   * 勾选变了 → 调用方**重算计划**，把新的正文与按钮状态返回来。
   *
   * 为什么让调用方重算而不是在这里改一段文本：正文、按钮状态、最终落盘必须是**同一次计算**
   * 的结果（导入最该避免的就是"对话框说的与实际做的不一致"）。缺省 = 不重算。
   */
  replan?: (overwrite: readonly string[]) => { planText: string; canImport: boolean }
  /**
   * 真正去导入（合并进设置、落盘都在调用方）；`overwrite` 是用户勾出来的 ID。
   *
   * 返回 `{ ok: false }` 表示失败；`reason` 留空表示调用方已经给过具体原因，
   * 此时本对话框不再重复弹一条（一次失败只说一句话）。
   */
  onConfirm: (overwrite: readonly string[]) => Promise<ImportBundleOutcome>
}

/** 导入结果：`ok: false` 时对话框留在原地 */
export type ImportBundleOutcome = { ok: true } | { ok: false; reason?: string }

/** 一条同名冲突（结构来自 `resourceBundle.BundleConflict`，这里只声明用得到的那几项） */
export interface ImportBundleConflict {
  id: string
  /** 属于哪一类（`terrains` / `markers` / `pathTypes` / `regionTypes`） */
  section: string
  /** 这张图里现在那一条的一句话 */
  current: string
  /** 文件里那一条的一句话 */
  incoming: string
}

/** 导入对话框工厂：可注入替身，便于自动化测试 */
export type ImportBundleModalFactory = (app: App, options: ImportBundleModalOptions) => { open(): void }

export class ImportBundleModal extends Modal {
  private readonly options: ImportBundleModalOptions
  /**
   * 用户勾了「覆盖」的那些 ID。
   *
   * 存在这里而不是从控件读回来：控件会在重绘时被换掉，而"用户的选择"不该跟着 DOM 走
   * （与 `DefinitionManagerModal.openItems` 同一条教训）。
   */
  private readonly overwrite = new Set<string>()
  private planEl: HTMLElement | null = null
  private confirmButton: { setDisabled(value: boolean): unknown } | null = null

  constructor(app: App, options: ImportBundleModalOptions) {
    super(app)
    this.options = options
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('fc-import')
    contentEl.createEl('h3', { cls: 'fc-import-title', text: DIALOG_LABELS.importDefinitions })
    contentEl.createEl('div', { cls: 'fc-import-source', text: `来源：${this.options.source}` })
    // W4-3：导入落的是**当前地图的定义集** —— 这句话必须写在最显眼处（用户要知道改的是哪张图）
    const target = contentEl.createEl('div', { cls: 'fc-import-target', text: `导入到：${this.options.target}` })
    target.dataset.fcImportRole = 'target'
    // 用 <pre> 而不是普通 div：正文是逐条列出的多行文本，换行与缩进要保留下来
    this.planEl = contentEl.createEl('pre', { cls: 'fc-import-plan', text: this.options.planText })

    this.renderConflicts(contentEl)

    const buttons = new Setting(contentEl).addButton((button) => {
      // `buttonEl` 由组件自己带出来（**不能**去读 `Setting` 上的按钮数组：
      // 真实 `Setting` 没有公开这种数组，只有假 DOM 里才有）。
      // 判空只是不让"某个版本没有这个成员"变成一次崩溃 —— 少了标记，冒烟里
      // "确认按钮带稳定标记"那条断言会直接红，而不是悄悄少测一件事。
      if (button.buttonEl) button.buttonEl.dataset.fcImportRole = 'confirm'
      this.confirmButton = button
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

  /**
   * 同名冲突那一节：**逐条**给一个「覆盖」开关，外加一个"全部设为覆盖"的动作按钮。
   *
   * 为什么是"开关 + 动作按钮"而不是两个并列的控件：开关是**每一条的状态**，
   * 按钮只是"把它们一次性都拨到覆盖"的快捷动作（不持有状态）—— 于是同一件事只有一个家，
   * 不会出现"全选勾了、某一行还显示跳过"这种自相矛盾。
   */
  private renderConflicts(containerEl: HTMLElement): void {
    if (this.options.conflicts.length === 0) return
    const section = containerEl.createEl('div', { cls: 'fc-import-conflicts' })
    section.dataset.fcImportRole = 'conflicts'
    section.createEl('div', {
      cls: 'fc-import-conflicts-title',
      text: `同名冲突（${this.options.conflicts.length} 条）—— 想用文件里的版本，就把对应那条拨到「覆盖」：`,
    })
    const toggles: Array<{ id: string; setValue(value: boolean): unknown }> = []
    for (const conflict of this.options.conflicts) {
      const row = section.createEl('div', { cls: 'fc-import-conflict' })
      row.dataset.fcConflictId = conflict.id
      const describe = row.createEl('div', { cls: 'fc-import-conflict-desc' })
      describe.createEl('div', { cls: 'fc-import-conflict-current', text: `${conflict.id}（这张图）：${conflict.current}` })
      describe.createEl('div', { cls: 'fc-import-conflict-incoming', text: `文件里：${conflict.incoming}` })
      new Setting(row).addToggle((toggle) => {
        toggle.setTooltip('覆盖这张图里的同名项').setValue(this.overwrite.has(conflict.id)).onChange((value) => {
          if (value) this.overwrite.add(conflict.id)
          else this.overwrite.delete(conflict.id)
          this.applyReplan()
        })
        toggles.push({ id: conflict.id, setValue: (next: boolean) => toggle.setValue(next) })
      })
    }
    new Setting(section)
      .setName('全都是文件里的版本')
      .setDesc('把上面每一条都拨到「覆盖」—— 搬一整套线宽时用这个。')
      .addButton((button) =>
        button.setButtonText(DIALOG_LABELS.overwriteAll).onClick(() => {
          for (const conflict of this.options.conflicts) this.overwrite.add(conflict.id)
          for (const toggle of toggles) toggle.setValue(true)
          this.applyReplan()
        }),
      )
  }

  /** 勾选变了 → 让调用方重算计划，把正文与按钮状态一起换掉 */
  private applyReplan(): void {
    const replan = this.options.replan
    if (replan === undefined) return
    const next = replan([...this.overwrite])
    if (this.planEl) this.planEl.textContent = next.planText
    this.confirmButton?.setDisabled(!next.canImport)
  }

  private async runImport(): Promise<void> {
    try {
      const outcome = await this.options.onConfirm([...this.overwrite])
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
