/**
 * 插件设置。
 *
 * ## 这一页现在只管三件事（A3 瘦身之后）
 *
 * 1. **引导**：顶部一份「快速上手」清单（讲怎么开始画、以及"改单个对象去侧栏"）；
 * 2. **全局开关**：字号、开发者模式、`图层`（默认收起，含图例）；
 * 3. **新对象默认值**：路径类型与区域类型的参数、名称字体族、恢复出厂（默认收起）。
 *
 * ## 为什么定义管理搬走了
 *
 * 分界线不是"重不重要"，而是**改动会不会波及已画的对象**：
 * - 自定义地形 / 标记的**定义内容**会影响已画对象 → 属于「定义」，搬进「地图定义…」弹窗
 *   （面板 → 地图定义 → 管理地图定义…，见 `DefinitionManagerModal`）；
 * - 路径类型 / 区域类型的**参数**只影响**新画**的对象（已画对象把参数存在地图文件里）
 *   → 它们是「新对象默认值」，留在这里。
 *
 * 一条重要边界：样式设置只决定**新画的对象**用什么颜色。
 * 已经画好的对象把颜色存在地图文件里（`path.color` / `region.color`），
 * 改设置**不会**悄悄改掉你已有的地图。
 */

import { PluginSettingTab, Setting, type App } from 'obsidian'
import type ProjectKakiPlugin from '../main.ts'
import {
  PATH_CAP_LABELS,
  PATH_JOIN_LABELS,
  describePathTypeParams,
  isDefaultPathTypeStyles,
  listPathTypeEntries,
  parsePathDashInput,
  resolvePathType,
} from '../render/pathTypeCatalog.ts'
import {
  describeRegionTypeParams,
  isDefaultRegionTypeStyles,
  resolveRegionType,
} from '../render/regionTypeCatalog.ts'
import { LAYER_TABLE, isLayerVisible } from '../render/layerVisibility.ts'
import { OVERLAY_FIELDS, type OverlayFieldSpec } from '../render/overlayFields.ts'
import { createCollapsibleGroup } from './collapsible.ts'
import { QUICK_START_SETTINGS } from './quickStart.ts'
import { renderOverlayFieldSection, type OverlaySectionHost } from './settingsSections.ts'

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
  normalizeLabelScale,
  normalizeSettings,
  paletteOf,
} from './settingsModel.ts'
export type { CartographerSettings } from './settingsModel.ts'

export class CartographerSettingTab extends PluginSettingTab {
  private readonly plugin: ProjectKakiPlugin
  /** 路径类型区底部那一行就地提示（参数编辑出错时显示在**出问题的那一节**下面） */
  private pathTypeNoteEl: HTMLElement | null = null
  /** 区域类型区底部那一行就地提示（同上） */
  private regionTypeNoteEl: HTMLElement | null = null
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
      .setName('开发者模式')
      .setDesc(
        '打开后才会出现开发用探针命令（诊断当前 Canvas、监视视口变化）——' +
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
        .setName('当前实际字号')
        .setDesc(
          attached?.stats?.labelCssPx
            ? `路径 ${attached.stats.labelCssPx.path} px · 区域 ${attached.stats.labelCssPx.region} px` +
              `（屏幕 CSS 像素；当前画布 1 CSS px = ${attached.stats.rasterPxPerCssPx.toFixed(2)} 位图像素）`
            : '先打开一张绑定了地图的 Canvas 并启用地图层，这里会显示当前的实际字号。',
        )
    }

    // ---- 2. 图层（地形 / 网格 / 区域 / 路径 / 标记 / 名称）：默认收起 ----
    const layerGroup = createCollapsibleGroup(containerEl, {
      title: '图层',
      role: 'layers',
      cls: 'fc-settings-group',
      titleCls: 'fc-settings-group-title',
    })
    layerGroup.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '图层开关只决定"看不看"，不写进地图数据 —— 关掉某层再打开，内容原样还在。' +
        '网格也在这一组里（画布工具条上的几个按钮切的是同一份设置）。',
    })

    for (const spec of LAYER_TABLE) {
      new Setting(layerGroup)
        .setName(`显示${spec.label}`)
        .setDesc(spec.describe)
        .addToggle((toggle) =>
          toggle.setValue(isLayerVisible(settings.layers, spec.id)).onChange((value) => {
            void this.plugin.setLayerVisible(spec.id, value)
            this.rerenderKeepingScroll()
          }),
        )
    }

    new Setting(layerGroup)
      .setName('显示图例')
      .setDesc(
        '在画布右下角显示图例。内容由地图上**实际有的**地形、路径、区域生成（不是固定清单），' +
          '所以它永远与画面一致；工具条上也有一个「图例」按钮。',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.showLegend).onChange((value) => {
          void this.plugin.setShowLegend(value)
          this.rerenderKeepingScroll()
        }),
      )

    // ---- 3. 数据层（温度 / 深度…）：默认收起 ----
    //
    // **开关不在这里**：它和别的图层一起在「图层」一组与侧栏面板顶部（表驱动，加一层只加一行）。
    // 这一组只管"怎么看"：色带、越界两端、不透明度、要不要在每个格上写数值。
    const dataGroup = createCollapsibleGroup(containerEl, {
      title: '数据层',
      role: 'data',
      cls: 'fc-settings-group',
      titleCls: 'fc-settings-group-title',
    })
    dataGroup.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '数据层的值（温度、深度…）存在地图文件的格上；这里只决定怎么把它画出来。' +
        '每一层的开关在「图层」一组里（侧栏面板顶部也有同一组）。' +
        '改了色带下一帧就是新颜色，不用重开画布。',
    })
    for (const spec of OVERLAY_FIELDS) {
      this.renderOverlayField(dataGroup, spec)
    }

    // ---- 4. 新对象默认值（路径类型参数 / 区域类型参数 / 字体 / 恢复出厂）：默认收起 ----
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
        '这些参数只决定新画的路径与区域用什么样式。已经画好的对象把样式存在地图文件里' +
        '（path.color / path.width / path.dash / path.cap / path.join），改设置不会改动它们。',
    })

    this.renderPathTypes(defaults, settings)

    this.renderRegionTypes(defaults, settings)

    new Setting(defaults)
      .setName('名称字体族')
      .setDesc(
        '留空 = 跟随 Obsidian 主题字体。可以写字体列表（例如 Noto Serif SC, serif）。' +
          '这里只接受字体族：整条 CSS font 简写（含 px 字号、斜杠等）会被拒绝 —— ' +
          '那种串会让画布静默忽略整条字体声明，结果就是"字号怎么调都不变"。',
      )
      .addText((text) =>
        text
          .setPlaceholder('留空 = 跟随主题')
          .setValue(settings.labelFontFamily)
          .onChange((value) => {
            void this.plugin.setLabelFontFamily(value)
          }),
      )

    const dirty =
      !isDefaultPathTypeStyles(settings.pathTypes) ||
      !isDefaultRegionTypeStyles(settings.regionTypes) ||
      settings.labelFontFamily.length > 0
    new Setting(defaults)
      .setName('恢复出厂样式')
      .setDesc(
        dirty
          ? '当前样式已被改动。点这里把内置 4 种路径类型与 6 种区域类型的参数、字体恢复为出厂默认' +
            '（自定义路径类型 / 区域类型的定义不会被删）。'
          : '当前就是出厂默认样式。',
      )
      .addButton((button) =>
        button.setButtonText('恢复默认').onClick(() => {
          void this.plugin.resetStylePalette()
          this.rerenderKeepingScroll()
        }),
      )

    // 定义管理搬到「地图定义…」之后，这里只留一行指路 —— 用户不该找不到增删改的入口
    const hint = defaults.createEl('div', { cls: 'fc-settings-note', text: '' })
    hint.dataset.fcSettingsRole = 'definitions-hint'
    hint.textContent =
      '新增 / 删除 / 改 ID 定义请到「地图定义…」：侧栏面板 →「地图定义」→「管理地图定义…」' +
      '（自定义地形、标记、路径类型、区域类型都在那里增删改）。'

    // ---- 5. 地图面板 ----
    new Setting(containerEl)
      .setName('地图面板')
      .setDesc('常用命令都在右侧边栏的「地图面板」里，不必每次翻命令面板。')
      .addButton((button) =>
        button.setButtonText('打开面板').onClick(() => {
          void this.plugin.activatePanel()
        }),
      )
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
    show.textContent = '重新显示'
    show.addEventListener('click', () => {
      void this.plugin.setQuickStartHidden('settings', false).then(() => this.rerenderKeepingScroll())
    })
  }

  /**
   * 一个数据层字段（温度 / 深度 / 生物群系）的参数区。
   *
   * **实现不在这里**：整节控件在 `settingsSections.ts`，与侧栏面板共用同一份渲染
   * （施工文件 §F.2 那条代码纪律）—— 两处各写一遍就必然分叉。
   * 这里只把"设置页这一侧的读写方式"注入进去：写设置、重绘时**保住滚动位置**。
   */
  private renderOverlayField(containerEl: HTMLElement, spec: OverlayFieldSpec): void {
    renderOverlayFieldSection(containerEl, spec, this.overlaySectionHost())
  }

  /**
   * 数据层控件那一节要的读写入口（设置页版）。
   *
   * `getCategoryUsage` 交给插件算（"地图上出现了哪些群系"要读活动文档与自定义目录，
   * 设置页拿不到这些）；每次编辑都走 `plugin.setOverlayStyle` ——
   * 规范化（只存改过的那些 / 空表不留键）与落盘都在那一处，这里不重复实现。
   */
  private overlaySectionHost(): OverlaySectionHost {
    return {
      getOverlayStyles: () => this.plugin.getSettings().overlays,
      setOverlayStyle: (field, patch) => this.plugin.setOverlayStyle(field, patch),
      resetOverlayRamp: (field) => this.plugin.resetOverlayRamp(field),
      setOverlayCategoryColor: (field, categoryId, color) =>
        this.plugin.setOverlayCategoryColor(field, categoryId, color),
      getCategoryUsage: (spec) => this.plugin.categoryUsageOf(spec),
      // 只有"改了会影响后续控件"的那些项要重绘（显示方式、展示单位、恢复色带）——
      // 重绘要保住滚动位置，否则用户每改一项就被弹回页面顶部（§5.34）
      requestRerender: () => this.rerenderKeepingScroll(),
      heading: true,
    }
  }


  /**
   * 路径类型的**参数**（内置 4 种 + 自定义项）。
   *
   * 为什么每种类型用**两个** Setting 而不是七个：一屏要放下最多 36 种类型，
   * 每个字段一行会让用户永远滚不到底。按"视觉（颜色/端点/连接）"与"尺寸（线宽/虚线）"
   * 分成两行，仍然每行都有名字与说明。
   *
   * ⚠️ 这里**没有**「新增 / 删除 / 改 ID」—— 那些是**定义**层面的改动，搬到了「地图定义…」弹窗
   * （这一节只管"新画出来的路径默认长什么样"）。底部的指引行会告诉用户去哪找。
   */
  private renderPathTypes(containerEl: HTMLElement, settings: CartographerSettings): void {
    const pathTypes = listPathTypeEntries(settings.pathTypes)

    containerEl.createEl('h3', { text: '路径类型' })
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '每种路径类型的颜色、线宽、虚线、端点与连接都在这里改。内置 4 种的名字固定，' +
        '自定义类型的名字在「地图定义…」里改。' +
        '虚线填成 实-空 成对的数字（例如 14,10），留空 = 实线。',
    })

    for (const entry of pathTypes) {
      const resolved = resolvePathType(entry.id, settings.pathTypes)
      const isCustom = !resolved.builtin
      const dashText = entry.params.dash.join(',')

      new Setting(containerEl)
        .setName(`${entry.label}${isCustom ? '（自定义）' : ''}`)
        .setDesc(`ID ${entry.id} · ${describePathTypeParams(entry.params)}`)
        .addColorPicker((picker) =>
          picker.setValue(entry.params.color).onChange((value) => {
            void this.plugin.updatePathType(entry.id, { color: value }).then((result) => {
              if (!result.ok) this.setPathTypeNoteText(this.noteProblem(result.problem))
            })
          }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(PATH_CAP_LABELS)
            .setValue(entry.params.cap)
            .onChange((value) => {
              void this.plugin.updatePathType(entry.id, { cap: value })
            }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(PATH_JOIN_LABELS)
            .setValue(entry.params.join)
            .onChange((value) => {
              void this.plugin.updatePathType(entry.id, { join: value })
            }),
        )

      new Setting(containerEl)
        .setName(`线宽与虚线 · ${entry.label}`)
        .setDesc('线宽是世界单位（1–40）；虚线留空 = 实线')
        .addText((text) =>
          text
            .setPlaceholder('线宽，例如 5')
            .setValue(String(entry.params.width))
            .onChange((value) => {
              void this.plugin.updatePathType(entry.id, { width: value })
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('虚线，例如 14,10；留空 = 实线')
            .setValue(dashText)
            .onChange((value) => {
              const parsed = parsePathDashInput(value)
              if (!parsed.ok) {
                this.setPathTypeNoteText(`「${entry.label}」的虚线：${parsed.problem}`)
                return
              }
              void this.plugin.updatePathType(entry.id, { dash: parsed.dash }).then((result) => {
                this.setPathTypeNoteText(result.ok ? '' : `「${entry.label}」的虚线：${result.problem}`)
              })
            }),
        )
    }

    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    note.dataset.fcNote = 'pathType'
    this.pathTypeNoteEl = note
  }

  /**
   * 把"为什么不行"变成"接下来怎么办"。
   *
   * 用户实测反馈：「输错也不知道怎么改」。原来提示只写原因（例如"虚线必须是成对数字"），
   * 用户得自己推出两件事：**这一项没被写进去**、**改哪里**。
   * 这里统一补上后半句 —— 文案只有一份，改一次全对。
   */
  private noteProblem(problem: string): string {
    return `${problem}（这一项还没写进设置；改成合法值即可，其它内容不会丢）`
  }

  /** 路径类型区底部那一行提示 */
  private setPathTypeNoteText(text: string): void {
    if (this.pathTypeNoteEl) this.pathTypeNoteEl.textContent = text
  }

  /**
   * 区域类型的**参数**（内置 6 种 + 自定义项）。
   *
   * 与 `renderPathTypes` 完全同构（同样的两行布局与就地提示）：
   * 一屏要放下最多 38 种类型，每个字段一行会让用户永远滚不到底。
   * 区别只在参数不同 —— 区域是"填充色 / 不透明度 / 边框色"与"边框宽 / 边框虚线"。
   * 同样**没有**增删改：那些在「地图定义…」里。
   */
  private renderRegionTypes(containerEl: HTMLElement, settings: CartographerSettings): void {
    const regionTypes = settings.regionTypes

    containerEl.createEl('h3', { text: '区域类型' })
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '每种区域类型的填充色、不透明度、边框色、边框宽与边框虚线都在这里改。' +
        '内置 6 种的名字固定（王国/帝国/公国/教区/荒原/海域），自定义类型的名字在「地图定义…」里改。' +
        '边框色留空 = 跟随填充色；边框宽填 0 = 不画边框；边框虚线留空 = 实线。',
    })

    for (const entry of regionTypes) {
      const resolved = resolveRegionType(entry.id, regionTypes)
      const isCustom = !resolved.builtin
      const dashText = entry.params.borderDash.join(',')

      new Setting(containerEl)
        .setName(`${entry.label}${isCustom ? '（自定义）' : ''}`)
        .setDesc(`ID ${entry.id} · ${describeRegionTypeParams(entry.params)}`)
        .addColorPicker((picker) =>
          picker.setValue(entry.params.color).onChange((value) => {
            void this.plugin.updateRegionType(entry.id, { color: value }).then((result) => {
              if (!result.ok) this.setRegionTypeNoteText(this.noteProblem(result.problem))
            })
          }),
        )
        .addText((text) =>
          text
            .setPlaceholder('不透明度 0–1，例如 0.22')
            .setValue(String(entry.params.opacity))
            .onChange((value) => {
              void this.plugin.updateRegionType(entry.id, { opacity: value }).then((result) => {
                this.setRegionTypeNoteText(result.ok ? '' : `「${entry.label}」的不透明度：${result.problem}`)
              })
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('边框色（留空 = 跟随填充色）')
            .setValue(entry.params.borderColor ?? '')
            .onChange((value) => {
              void this.plugin.updateRegionType(entry.id, { borderColor: value })
            }),
        )

      new Setting(containerEl)
        .setName(`边框 · ${entry.label}`)
        .setDesc('边框宽是世界单位（0–40，0 = 不画边框）；虚线留空 = 实线')
        .addText((text) =>
          text
            .setPlaceholder('边框宽，例如 3')
            .setValue(String(entry.params.borderWidth))
            .onChange((value) => {
              void this.plugin.updateRegionType(entry.id, { borderWidth: value })
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('虚线，例如 12,8；留空 = 实线')
            .setValue(dashText)
            .onChange((value) => {
              const parsed = parsePathDashInput(value)
              if (!parsed.ok) {
                this.setRegionTypeNoteText(`「${entry.label}」的边框虚线：${parsed.problem}`)
                return
              }
              void this.plugin
                .updateRegionType(entry.id, { borderDash: parsed.dash })
                .then((result) => {
                  this.setRegionTypeNoteText(
                    result.ok ? '' : `「${entry.label}」的边框虚线：${result.problem}`,
                  )
                })
            }),
        )
    }

    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    note.dataset.fcNote = 'regionType'
    this.regionTypeNoteEl = note
  }

  /** 区域类型区底部那一行提示 */
  private setRegionTypeNoteText(text: string): void {
    if (this.regionTypeNoteEl) this.regionTypeNoteEl.textContent = text
  }
}