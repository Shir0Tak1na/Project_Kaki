/**
 * 插件设置。
 *
 * ## 这一页现在只管这些（存储轮 W4-1b 之后的定稿）
 *
 * 1. **引导**：顶部一份「快速上手」清单（讲怎么开始画、以及"改单个对象去侧栏"）；
 * 2. **全局开关**：字号、开发者模式（`图层` 一组已经不在这里 —— 见 §F.1）；
 * 3. **新对象默认值**：只剩**名称字体族** + 一行指路。路径 / 区域类型的**参数**
 *    在 W4-1b 搬进了「地图定义…」弹窗 —— 定义随图之后它们是**每张地图各自一份**，
 *    而这一页的设置是全局的（两处都能改就必然分叉，§1 判据 1）；
 * 4. **数值图层**：配色 / 越界两端 / 不透明度 / 显示方式（**按地图**，见 `DATA-LAYER-UI-BRIEF`）；
 * 5. **定义文件（导入 / 导出）**：从侧栏「文件与导出」组搬来（施工文件 §F.2）。
 *
 * ## 为什么定义管理搬走了
 *
 * 分界线是**改动会不会波及已画的对象 / 是不是"这张图的事实"**：
 * - 自定义地形 / 标记 / 路径类型 / 区域类型的**定义内容**都属于地图文件（方案 B）
 *   → 全部搬进「地图定义」弹窗（`DefinitionManagerModal`）；
 * - **名称字体族**只是"怎么看" → 留在这一页。
 */

import { PluginSettingTab, Setting, type App } from 'obsidian'
import type ProjectKakiPlugin from '../main.ts'
import { OVERLAY_FIELDS, type OverlayFieldSpec } from '../render/overlayFields.ts'
import { createCollapsibleGroup } from './collapsible.ts'
import { QUICK_START_SETTINGS } from './quickStart.ts'
import { renderOverlayFieldSection, type OverlaySectionHost } from './settingsSections.ts'
import { SETTINGS_LABELS } from './strings.ts'

/**
 * 数据模型在 `settingsModel.ts`（纯函数、不 import obsidian，因此可单测）。
 *
 * 这里**转出**同名符号，是为了让既有调用点（`main.ts` 等）一行都不用改；
 * 同时把界面真正用到的几个常量 import 进来（转出不会让它们进入本文件作用域）。
 */
import {
  LABEL_SCALE_MAX,
  LABEL_SCALE_MIN,
  LABEL_SCALE_STEP,
  type CartographerSettings,
} from './settingsModel.ts'

export {
  DEFAULT_SETTINGS,
  LABEL_SCALE_MAX,
  LABEL_SCALE_MIN,
  LABEL_SCALE_STEP,
  normalizeExportFolder,
  normalizeLabelScale,
  normalizeSettings,
  paletteOf,
} from './settingsModel.ts'
export type { CartographerSettings, MapViewSettings } from './settingsModel.ts'

export class CartographerSettingTab extends PluginSettingTab {
  private readonly plugin: ProjectKakiPlugin
  constructor(app: App, plugin: ProjectKakiPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  /**
   * 重建设置页，但**保住滚动位置**。
   *
   * 用户实测反馈：「按新增的时候面板会跳到最顶上」。原因不在 Obsidian，而在这里：
   * 每次改动（新增/删除/切模式/选图片）我们都是整页 `display()` 重建，
   * 而重建第一步是 `containerEl.empty()` —— 内容被清空时滚动容器的 `scrollHeight` 变成 0，
   * 浏览器随即把 `scrollTop` **钳回 0**。于是用户每改一项就被弹回页面顶部，
   * 要建的条目在下面就得重新滚一遍。
   *
   * 修法是把"重建前后同一件事"写成一个入口：先记下滚动位置，重建后再放回去。
   * 只改这一处、所有调用点共用，避免以后有人新加一个 `this.display()` 又把这个坑带回来。
   */
  private rerenderKeepingScroll(): void {
    const scroller = this.findScroller()
    const top = scroller.scrollTop
    this.display()
    // 重建不会换掉滚动容器本身（换掉的是它的子节点），所以这里可以直接写回
    scroller.scrollTop = top
  }

  /**
   * 找到真正在滚动的那个祖先。
   *
   * Obsidian 的设置页把内容放进 `.vertical-tab-content` 之类的容器里由它来滚，
   * 而 `containerEl` 只是内容本身。这里从自身往上找第一个"内容比可视区高"的元素；
   * 一个都没有（内容不长、或假 DOM 里没设尺寸）就退回 `containerEl` 自己 ——
   * 写回一个本来就为 0 的位置也无害。
   */
  private findScroller(): HTMLElement {
    let node: HTMLElement | null = this.containerEl
    while (node !== null) {
      if (node.scrollHeight > node.clientHeight) return node
      node = node.parentElement
    }
    return this.containerEl
  }

  override display(): void {
    this.containerEl.empty()
    /**
     * 设置页的作用域类：`styles.css` 里那一组"控件多的一行不许溢出"的规则挂在它上面。
     *
     * ⚠️ 类名在 CSS 与这里各写一次，必须一致 —— 冒烟里有一条断言盯着这件事
     * （CSS 布局本身无法在假 DOM 里断言，见 `ENGINEERING-NOTES.md` §5.31）。
     */
    this.containerEl.addClass('fc-settings')
    try {
      this.renderAll()
    } catch (error) {
      // 设置页是"整页重建"：中途抛异常会让**它后面所有内容一起消失**，
      // 而 Obsidian 只在控制台报一下 —— 界面上看起来就是"某个分组是空的/设置页变短了"。
      // 把原因直接写在页面上，别让用户对着空白猜（这条是被真实库里的现象逼出来的）。
      const message = error instanceof Error ? error.message : String(error)
      console.error('[project-kaki] 设置页渲染失败', error)
      this.containerEl.createEl('div', { cls: 'fc-render-error', text: `设置页渲染失败：${message}` })
    }
  }

  /** 真正的渲染。`display()` 只负责"清空 + 兜住异常" */
  private renderAll(): void {
    const { containerEl } = this

    const settings = this.plugin.getSettings()
    const stats = this.plugin.getLayerManager()?.listStatus() ?? []
    const attached = stats.find((item) => item.attached && item.stats)

    // ---- 1. 快速上手（可关闭、可恢复）----
    this.renderQuickStart(containerEl, settings)

    containerEl.createEl('h2', { text: 'Project Kaki' })
    // 译名只在设置页出现这一次：别在每个标题里都写两个名字
    containerEl.createEl('div', { cls: 'fc-settings-subtitle', text: 'Project 垣 · 六边形地图创作' })

    new Setting(containerEl)
      .setName('路径与区域名称的字号')
      .setDesc(
        '名称是标注：它会随画布缩放变大，但不会小于一个下限。' +
          '如果觉得太小/太大，直接调这里。改动立即生效（已打开的地图会重绘）。',
      )
      .addSlider((slider) =>
        slider
          .setLimits(LABEL_SCALE_MIN, LABEL_SCALE_MAX, LABEL_SCALE_STEP)
          .setValue(settings.labelScale)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin.setLabelScale(value)
            this.rerenderKeepingScroll()
          }),
      )

    new Setting(containerEl)
      .setName(SETTINGS_LABELS.developerMode)
      .setDesc(
        '开发者工具：诊断当前 Canvas、监视视口变化。' +
          '它们平时会被从命令面板里隐藏，避免误触。地图面板里也会多出「开发工具」一组。',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.developerMode).onChange((value) => {
          void this.plugin.setDeveloperMode(value)
          this.rerenderKeepingScroll()
        }),
      )

    // 「当前实际字号」是**只读诊断信息**，不是设置项：只在**开发者模式**下出现
    // （用户 2026-09-27 的要求：把它移进开发者选项里 —— 普通用户看不到它，
    // 也就不会在"这一栏怎么没数字"上困惑）。
    if (settings.developerMode) {
      const advanced = createCollapsibleGroup(containerEl, {
        title: '开发者选项：当前实际字号',
        role: 'advanced',
        cls: 'fc-settings-group',
        titleCls: 'fc-settings-group-title',
      })
      new Setting(advanced)
        .setName(SETTINGS_LABELS.currentLabelPx)
        .setDesc(
          attached?.stats?.labelCssPx
            ? `路径 ${attached.stats.labelCssPx.path} px · 区域 ${attached.stats.labelCssPx.region} px` +
              `（屏幕 CSS 像素；当前画布 1 CSS px = ${attached.stats.rasterPxPerCssPx.toFixed(2)} 位图像素）`
            : '先打开一张绑定了地图的 Canvas 并启用地图层，这里会显示当前的实际字号。',
        )
    }

    // ---- 2. 图层开关**不在这一页**（UI 整理 W1c）----
    //
    // 用户 m01803 第 6 条（逐字）：「图层开关属于高频使用的功能，建议只留在侧栏里。」
    // ⇒ 侧栏「底图」「地物」两组是它们的**唯一家**（画布工具条那个「图例」按钮是画布表面的快捷入口）。
    // 这一页原来那一组（9 个图层开关 + 「显示图例」）已整组移除 —— 同一件事在两个表面各长一份
    // 就是"一个设置两个家"（§1 判据 1 / §5.60），而且它正是"改成中英不一致、两处说法不同"的来源。

    // ---- 3. 数值图层（温度 / 深度…）：默认收起 ----
    //
    // **开关不在这里**：它在侧栏「底图」一组里（表驱动，加一层只加一行）。
    // 这一组只管"怎么看"：配色、越界两端、不透明度、要不要在每个格上写数值。
    const dataGroup = createCollapsibleGroup(containerEl, {
      title: '数值图层',
      role: 'data',
      cls: 'fc-settings-group',
      titleCls: 'fc-settings-group-title',
    })
    dataGroup.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '数值图层的值（温度、深度 / 海拔、生物群系）存在地图文件的格上；这里只决定怎么把它画出来。' +
        '每一层的开关在侧栏面板的「底图」一组里（这一页不再重复摆一份）。' +
        '改了配色下一帧就是新颜色，不用重开画布。',
    })
    for (const spec of OVERLAY_FIELDS) {
      this.renderOverlayField(dataGroup, spec)
    }

    // ---- 4. 新对象默认值（只有名称字体族；路径 / 区域类型的参数搬进了「地图定义…」）----
    //
    // ⚠️ 2026-09-30（存储轮 W4-1b）：路径类型与区域类型的**参数**从这一页搬进了
    // 「地图定义…」弹窗 —— 因为"定义随图"之后它们是**这张地图**的那一套（改一张图不该动另一张）。
    // 字体族留在这里：它是"怎么看"（使用者的偏好），按 §5.1 的判据不进地图文件、也不按图分份。
    const defaults = createCollapsibleGroup(containerEl, {
      title: '新对象默认值',
      role: 'defaults',
      cls: 'fc-settings-group',
      titleCls: 'fc-settings-group-title',
    })
    defaults.createEl('div', {
      cls: 'fc-settings-note',
      // 设置说明是纯文本（不是 Markdown），所以这里不要写 ** 强调
      text:
        '路径类型与区域类型的参数（颜色 / 线宽 / 虚线 / 填充 / 边框）现在是每张地图各自一份，' +
        '在「地图定义…」弹窗里改（内置的也能改）。它们只决定新画的路径与区域长什么样 —— ' +
        '已经画好的对象把样式存在地图文件里，改参数不会改动它们。',
    })

    new Setting(defaults)
      .setName(SETTINGS_LABELS.labelFont)
      .setDesc('留空 = 跟随主题；只填字体名，例：Noto Serif SC, serif。')
      .addText((text) =>
        text
          .setPlaceholder(SETTINGS_LABELS.labelFontPlaceholder)
          .setValue(settings.labelFontFamily)
          .onChange((value) => {
            void this.plugin.setLabelFontFamily(value)
          }),
      )

    // 定义管理搬到「地图定义…」之后，这里只留一行指路 —— 用户不该找不到增删改的入口
    const hint = defaults.createEl('div', { cls: 'fc-settings-note', text: '' })
    hint.dataset.fcSettingsRole = 'definitions-hint'
    hint.textContent =
      '新增 / 删除 / 改 ID、以及路径与区域类型的参数，都在「地图定义…」里：' +
      '侧栏面板 →「地图定义」→「管理地图定义…」（自定义地形、标记、路径类型、区域类型都在那里）。'

    // ---- 5. 地图面板 ----
    new Setting(containerEl)
      .setName('地图面板')
      .setDesc('常用命令都在右侧边栏的「地图面板」里，不必每次翻命令面板。')
      .addButton((button) =>
        button.setButtonText('打开面板').onClick(() => {
          void this.plugin.activatePanel()
        }),
      )

    // ---- 6. 定义文件（导入 / 导出）----
    //
    // 从侧栏面板的「文件与导出」组搬来（§F.2）：这两个动作不依赖地图层，日常也不在画布上做。
    // 这里只是**多一个入口**：命令面板里的 `export-resource-bundle` / `import-resource-bundle`
    // 照旧能用，两边调的是同一个方法（面板那一侧由 `panelHidden` 挡掉，见 `MapPanel.PluginAction`）。
    containerEl.createEl('h3', { text: '定义文件（导入 / 导出）' })
    const bundleHint = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    bundleHint.dataset.fcSettingsRole = 'bundle-hint'
    bundleHint.textContent =
      '导出：把自定义地形、标记、路径类型与区域类型打包成一份 JSON（写在库根目录，同名不覆盖）。' +
      '导入：从库里的 .json 文件里挑一份，先看确认对话框再决定 —— 导入是只增不删的，同 ID 保留你现有的定义。' +
      '注意：这两个动作现在作用于「新建地图的模板」那一份（定义随图之后，按地图导入 / 导出、' +
      '以及同名项的选择还在路上）。'
    const bundleRow = containerEl.createEl('div', { cls: 'fc-settings-actions' })
    bundleRow.dataset.fcSettingsRole = 'bundle-actions'
    const exportBundle = bundleRow.createEl('button', { cls: 'fc-settings-action', text: '导出定义文件…' })
    exportBundle.dataset.fcBundle = 'export'
    exportBundle.addEventListener('click', () => {
      void this.plugin.exportResourceBundle()
    })
    const importBundle = bundleRow.createEl('button', { cls: 'fc-settings-action', text: '导入定义文件…' })
    importBundle.dataset.fcBundle = 'import'
    importBundle.addEventListener('click', () => {
      this.plugin.importResourceBundle()
    })
  }

  /**
   * 顶部那份「快速上手」清单（A3）。
   *
   * 两条设计约束（用户明确要求）：
   * - **可关闭且可逆**：点「不再显示」后清单消失，但留一行「重新显示」可点回来 ——
   *   引导本身正是"找不到入口"的解法，做成单向门就自相矛盾了；
   * - **文案独立**：这一份讲设置页的入口（开面板、建地图、改单个对象去侧栏），
   *   与面板那份（`QUICK_START_PANEL`）不是同一份文字。
   */
  private renderQuickStart(containerEl: HTMLElement, settings: CartographerSettings): void {
    if (!settings.hideQuickStartSettings) {
      const block = containerEl.createEl('div', { cls: 'fc-quickstart' })
      block.dataset.fcQuickStart = 'settings'
      block.createEl('div', { cls: 'fc-quickstart-title', text: '快速上手' })
      const list = block.createEl('ol', { cls: 'fc-quickstart-list' })
      for (const item of QUICK_START_SETTINGS) {
        const row = list.createEl('li', { cls: 'fc-quickstart-item' })
        row.createEl('span', { cls: 'fc-quickstart-item-title', text: item.title })
        row.createEl('span', { cls: 'fc-quickstart-item-hint', text: item.hint })
      }
      const hide = block.createEl('button', { cls: 'fc-quickstart-action' })
      hide.dataset.fcRole = 'quickstart-hide'
      hide.textContent = '不再显示'
      hide.addEventListener('click', () => {
        void this.plugin.setQuickStartHidden('settings', true).then(() => this.rerenderKeepingScroll())
      })
      return
    }

    // 已隐藏：只留一行，仍然能点回来（可逆 —— 不能做成单向门）
    const row = containerEl.createEl('div', { cls: 'fc-quickstart-restore' })
    row.dataset.fcQuickStart = 'settings-hidden'
    row.createEl('span', { cls: 'fc-quickstart-restore-text', text: '快速上手提示已隐藏。' })
    const show = row.createEl('button', { cls: 'fc-quickstart-action' })
    show.dataset.fcRole = 'quickstart-show'
    show.textContent = SETTINGS_LABELS.quickStartShowAgain
    show.addEventListener('click', () => {
      void this.plugin.setQuickStartHidden('settings', false).then(() => this.rerenderKeepingScroll())
    })
  }

  /**
   * 一个数值图层字段（温度 / 深度 / 生物群系）的参数区。
   *
   * **实现不在这里**：整节控件在 `settingsSections.ts`，与侧栏面板共用同一份渲染
   * （施工文件 §F.2 那条代码纪律）—— 两处各写一遍就必然分叉。
   * 这里只把"设置页这一侧的读写方式"注入进去：写设置、重绘时**保住滚动位置**。
   */
  private renderOverlayField(containerEl: HTMLElement, spec: OverlayFieldSpec): void {
    renderOverlayFieldSection(containerEl, spec, this.overlaySectionHost())
  }

  /**
   * 数值图层控件那一节要的读写入口（设置页版）。
   *
   * `getCategoryUsage` 交给插件算（"地图上出现了哪些群系"要读活动文档与自定义目录，
   * 设置页拿不到这些）；每次编辑都走 `plugin.setOverlayStyle` ——
   * 规范化（只存改过的那些 / 空表不留键）与落盘都在那一处，这里不重复实现。
   */
  private overlaySectionHost(): OverlaySectionHost {
    return {
      // W4-2：配色 / 不透明度按**当前地图**解析（设置页与侧栏面板共用同一份控件渲染，
      // 所以这一句必须跟 `MapPanelDeps.getOverlayStyles` 逐字同源）
      getOverlayStyles: () => this.plugin.overlaysFor(this.plugin.activeViewMapPath()),
      setOverlayStyle: (field, patch) => this.plugin.setOverlayStyle(field, patch),
      resetOverlayRamp: (field) => this.plugin.resetOverlayRamp(field),
      setOverlayCategoryColor: (field, categoryId, color) =>
        this.plugin.setOverlayCategoryColor(field, categoryId, color),
      getCategoryUsage: (spec) => this.plugin.categoryUsageOf(spec),
      // 只有"改了会影响后续控件"的那些项要重绘（显示方式、展示单位、恢复配色）——
      // 重绘要保住滚动位置，否则用户每改一项就被弹回页面顶部（§5.34）
      requestRerender: () => this.rerenderKeepingScroll(),
      heading: true,
    }
  }
}