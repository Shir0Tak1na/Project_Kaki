/**
 * 放置标记 / 文字标注的输入对话框。
 *
 * 与 `TextPromptModal` 分开：这个需要多字段（名称 / 图标 / 链接），
 * 而复用同一个类会让两者都变得难读。表单结构很小，各写各的更清楚。
 */

import { Modal, Setting, type App } from 'obsidian'
import { type MarkerIcon, type MarkerId } from '../data/mapDocument.ts'
import { listResolvedMarkerStyles, type CustomMarker } from '../render/markerCatalog.ts'

export interface PlaceMarkerInput {
  label: string
  icon: MarkerId
  link: string
}

export interface PlaceMarkerOptions {
  /** 'marker' 显示图标选择；'label' 只显示文字 */
  kind: 'marker' | 'label'
  /** 当前工具选中的图标 */
  initialIcon: MarkerId
  onSubmit: (input: PlaceMarkerInput) => void
  /**
   * 当前自定义标记（来自插件设置）。
   *
   * 传函数而不是值：对话框可能长时间开着，期间用户在设置页增删了标记 ——
   * 打开时现读一次即可，但**必须是打开那一刻的现状**，不能是创建工厂时的旧快照。
   */
  getCustomMarkers?: () => readonly CustomMarker[]
}

export const ICON_LABELS: Record<MarkerIcon, string> = {
  city: '城市',
  town: '村镇',
  fortress: '要塞',
  ruin: '遗迹',
  port: '港口',
  temple: '神殿',
  'mountain-peak': '山峰',
  cave: '洞穴',
  tower: '塔',
}

/** 放置对话框的工厂类型：可注入替身，便于自动化测试与将来的批量导入 */
export type PlaceModalFactory = (app: App, options: PlaceMarkerOptions) => { open(): void }

export class PlaceMarkerModal extends Modal {
  private readonly options: PlaceMarkerOptions
  private label = ''
  private icon: MarkerId
  private link = ''
  private submitted = false

  constructor(app: App, options: PlaceMarkerOptions) {
    super(app)
    this.options = options
    this.icon = options.initialIcon
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.options.kind === 'marker' ? '放置标记' : '添加文字标注' })

    let inputEl: HTMLInputElement | null = null
    new Setting(contentEl)
      .setName(this.options.kind === 'marker' ? '名称' : '文字内容')
      .addText((text) => {
        inputEl = text.inputEl
        text.setPlaceholder(this.options.kind === 'marker' ? '例如：龙脊山脉' : '例如：此处有龙')
        text.onChange((value) => {
          this.label = value
        })
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            this.submit()
          }
        })
      })

    if (this.options.kind === 'marker') {
      new Setting(contentEl)
        .setName('图标')
        .setDesc('自定义标记在设置 → 自定义标记里维护。')
        .addDropdown((dropdown) => {
          const custom = this.options.getCustomMarkers?.() ?? []
          const styles = listResolvedMarkerStyles(custom)
          for (const style of styles) {
            // 内置用中文名（界面语言一致），自定义用用户自己起的显示名。
            // 值一律是**原始 ID**：它就是写进地图文件的那个值，界面文字与数据无关。
            dropdown.addOption(style.id, ICON_LABELS[style.id as MarkerIcon] ?? style.label)
          }
          // 当前选中的图标要保证在下拉里存在，否则 setValue 会静默落回第一项 ——
          // 用户会看到"图标自己换了"，而实际是他选的那个自定义标记刚被删掉。
          if (!styles.some((style) => style.id === this.icon)) {
            dropdown.addOption(this.icon, `未知（${this.icon}）`)
          }
          dropdown.setValue(this.icon)
          dropdown.onChange((value) => {
            this.icon = value
          })
        })
    }

    new Setting(contentEl)
      .setName('链接到笔记')
      .setDesc('可留空。填写后点击标记即可打开该笔记。')
      .addText((text) => {
        text.setPlaceholder('例如：Locations/龙脊山脉.md')
        text.onChange((value) => {
          this.link = value
        })
      })

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('放置')
          .setCta()
          .onClick(() => this.submit()),
      )
      .addButton((button) =>
        button.setButtonText('取消').onClick(() => {
          this.cancel()
        }),
      )

    globalThis.setTimeout(() => inputEl?.focus(), 0)
  }

  private submit(): void {
    if (this.submitted) return
    const label = this.label.trim()
    if (label.length === 0) {
      // 名称是必填项：不关闭对话框，让用户补上
      return
    }
    this.submitted = true
    this.options.onSubmit({ label, icon: this.icon, link: this.link.trim() })
    this.close()
  }

  private cancel(): void {
    if (this.submitted) return
    this.submitted = true
    this.close()
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
