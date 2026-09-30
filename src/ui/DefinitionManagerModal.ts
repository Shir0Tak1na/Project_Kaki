/**
 * 「地图定义」弹窗：五类定义的**增删改 + 参数编辑**。
 *
 * ## 住在哪一份定义上（存储轮 W4-1b 之后 = 定义随图）
 *
 * **地图文件是定义的权威**（方案 B，用户 m01845 裁定）。于是这个弹窗读写的是
 * **当前地图**那一份 `definitions` 段，不是库级设置：
 * - 有地图层 ⇒ 直接读它内存里那份（首帧就是对的），改动走编辑器的 `setDefinitions`（可撤销）；
 * - 只绑定、没开地图层 ⇒ 首帧先用库级模板铺一屏，异步读到盘再换（见 `refreshFromMap`），
 *   改动直接落那张文件；
 * - 完全没有地图 ⇒ 顶部一句人话说明"改动只进『新建地图的模板』"。
 *
 * 库级那一份从此只剩两个用途：新建地图的模板 + v1 老图的迁移快照（见 `main.ts#libraryDefinitionSet`）。
 *
 * ## 为什么路径 / 区域类型的**参数**也搬进来了（W4-1b）
 *
 * 用户裁定：参数的**家**跟着定义走 —— 它们只影响**新画**的对象，而"新画的对象长什么样"
 * 是这张地图的事（同一个 `custom:river` 在不同图里可以不一样）。于是设置页
 * 「新对象默认值」里那两节整节撤掉，参数控件搬到这里，**内置 4 种 / 6 种也一并给入口**
 * （以前内置参数只能去设置页改，现在它们和自定义项一样只有这一个家）。
 *
 * ## 2026-09-29 重做（UI 整理 W3-2）：三件用户点名的事
 *
 * 用户原话（`UI-REORG-PLAN.md` §5 第 3 条）：
 * 「自定义的和本身自带的混在一起，阅读量大且无用。其次新建和编辑定义的功能描述非常难懂，
 * 而且到现在都没有选择文件的功能，全靠手输」。
 *
 * | 口径 | 落法 |
 * |---|---|
 * | **自带 / 自定义分区** | 每一节固定两区：`自定义（N）`（可增删改）+ `内置（N）`。地形 / 标记的内置是**纯文本行、默认收起**（本来就没有可做的操作）；路径 / 区域类型的内置**可改参数**，所以做成可点开的条目 |
 * | **每条一段变一行** | 地形 / 标记 / 路径类型 / 区域类型每条都收成一个 `<details>`（`fc-defitem`），**点开才显示控件** |
 * | **文案重写** | 四段节说明从 70–150 字压到一句话；「新增」那一大段 ID 规则收进输入框的 `title` |
 * | **补文件选择** | 早已具备（地形 / 标记的图片那一栏有「从库中选择…」）—— 这里只把措辞说清楚 |
 *
 * ## 两条必须守住的工程约束
 *
 * 1. **展开状态要跨重建保留**（`openItems` / `openBuiltins`）：改了颜色、切了模式都会整块重建，
 *    重建出来的 `<details>` 一律收起 —— 不读回状态的话，用户改一个值就要重新点开一次
 *    （与 `MapPanel.captureOpenGroups` 同一个坑，教训 §5.64）。
 * 2. **四个就地提示元素**（`dataset.fcNote`）会在每次重建时被换掉，所以重建后要把各自那句话补回去。
 *
 * 校验仍走各目录的 `validateCustom*Input` / `apply*Patch` 纯函数，删除一律走
 * `plugin.requestRemoveCustomDefinition(kind, id)`（有引用时先弹影响面确认框）。
 */

import { Modal, Setting, type App } from 'obsidian'
import type ProjectKakiPlugin from '../main.ts'
import type { MapDefinitionSet } from '../data/mapDefinitions.ts'
import { sameDefinitionSet } from '../data/mapDefinitions.ts'
import { createCollapsibleGroup } from './collapsible.ts'
import { MARKER_ICONS } from '../data/mapDocument.ts'
import { ICON_LABELS } from './PlaceMarkerModal.ts'
import { resolveVaultResourceUrl } from '../base/vaultResource.ts'
import { DEFINITION_MODAL_LABELS, MODAL_ACTIONS } from './strings.ts'
import {
  CUSTOM_REGION_TYPE_PREFIX,
  DEFAULT_CUSTOM_REGION_COLOR,
  MAX_CUSTOM_REGION_TYPES,
  customRegionTypeEntries,
  describeRegionTypeParams,
  isBuiltinRegionType,
  regionTypeIdProblem,
  resolveRegionType,
  type RegionTypeEntry,
} from '../render/regionTypeCatalog.ts'
import {
  CUSTOM_PATH_TYPE_PREFIX,
  DEFAULT_CUSTOM_PATH_COLOR,
  DEFAULT_CUSTOM_PATH_WIDTH,
  MAX_CUSTOM_PATH_TYPES,
  PATH_CAP_LABELS,
  PATH_JOIN_LABELS,
  customPathTypeEntries,
  describePathTypeParams,
  isBuiltinPathType,
  listPathTypeEntries,
  parsePathDashInput,
  pathTypeIdProblem,
  type PathTypeEntry,
} from '../render/pathTypeCatalog.ts'
import {
  CUSTOM_MARKER_PREFIX,
  DEFAULT_CUSTOM_MARKER_MODE,
  MAX_CUSTOM_MARKERS,
  markerIdProblem,
  type CustomMarkerMode,
} from '../render/markerCatalog.ts'
import {
  CUSTOM_TERRAIN_PREFIX,
  DEFAULT_CUSTOM_TERRAIN_COLOR,
  DEFAULT_CUSTOM_TERRAIN_MODE,
  MAX_CUSTOM_TERRAINS,
  checkTerrainImagePath,
  terrainIdProblem,
  type CustomTerrainMode,
} from '../render/terrainCatalog.ts'
import { listTerrainStyles } from '../render/terrainStyle.ts'

/** 弹窗工厂：默认用真实弹窗，测试里可注入替身（或读回默认实现自行实例化） */
export type DefinitionModalFactory = (app: App, plugin: ProjectKakiPlugin) => { open(): void }

/** 自定义地形的两种模式（与设置页同源的两选一分段控件） */
const TERRAIN_MODE_OPTIONS: ReadonlyArray<{ mode: CustomTerrainMode; label: string; hint: string }> = [
  { mode: 'color', label: '调色', hint: '只用颜色 + 字形：不依赖任何外部资源，最不容易失败' },
  { mode: 'image', label: '图片', hint: '用库内的一张图片；图片缺失或解不开时回退到颜色 + 字形' },
]

/** 自定义标记的两种模式 */
const MARKER_MODE_OPTIONS: ReadonlyArray<{ mode: CustomMarkerMode; label: string; hint: string }> = [
  { mode: 'glyph', label: '字形', hint: '借用内置图标的形状：不依赖任何外部资源；之前选的图片会保留，切回来还在' },
  { mode: 'image', label: '图片', hint: '用库内的一张图片；图片丢失或打不开时回退到字形，标记不会消失' },
]

/** 弹窗顶部那句话 —— 只说"这里管什么"，不再复述四类各自的规矩 */
const MODAL_INTRO =
  '这里管五类定义：新增 / 删除 / 改 ID，以及路径类型与区域类型的参数。' +
  '改 ID 会一并改掉地图里已画的引用；删除不会删掉地图上的对象（它们变成回退样式并留在文件里）。'

export class DefinitionManagerModal extends Modal {
  private readonly plugin: ProjectKakiPlugin
  /** 地形区底部那一行就地提示 */
  private terrainNoteEl: HTMLElement | null = null
  /** 标记区底部那一行就地提示（与地形那行分开） */
  private markerNoteEl: HTMLElement | null = null
  /** 路径类型区底部那一行就地提示 */
  private pathTypeNoteEl: HTMLElement | null = null
  /** 区域类型区底部那一行就地提示 */
  private regionTypeNoteEl: HTMLElement | null = null
  /**
   * 每条定义的那个 `<details>`（键 = 定义 ID）。
   *
   * 重建前读一遍它们的 `open`，重建后据此还原 —— 否则"改一个值就把这条收回去"。
   * 内置的路径 / 区域类型也走这里（它们的 ID 是内置名，与自定义 ID 不会撞）。
   */
  private readonly itemEls = new Map<string, HTMLDetailsElement>()
  /** 哪些条目是展开的（跨重建保留） */
  private readonly openItems = new Set<string>()
  /** 地形 / 标记那两个「内置」清单的 `<details>`（键 = terrain / marker） */
  private readonly builtinEls = new Map<string, HTMLDetailsElement>()
  /** 哪些内置清单是展开的（跨重建保留；默认全收起） */
  private readonly openBuiltins = new Set<string>()
  /**
   * 异步刷新用的令牌：读到盘时若用户已经又改了/又重建了，那次结果就作废
   * （与 `MapBasesView.loadToken` 同一个套路，防"慢的那次回来覆盖新的一次"）。
   */
  private refreshToken = 0

  constructor(app: App, plugin: ProjectKakiPlugin) {
    super(app)
    this.plugin = plugin
  }

  override onOpen(): void {
    // **首帧必须同步画出来**：有地图层时读的就是权威那一份，没有时先用库级模板铺一屏
    // （见 `syncCurrentDefinitionSet`），再去盘上把"这张图真实的那一份"读回来换掉。
    this.render()
    void this.refreshFromMap()
  }

  /**
   * 异步把"这张地图真实的那一份定义"读进来。
   *
   * 只有"画布绑了地图、但没开地图层"这一种情况首帧会不准（同步读不到盘），
   * 读回来之后**只有内容真的不同才重画** —— 免得每开一次弹窗都白重建一遍 DOM。
   *
   * ⚠️ **不许在这里递归**：同一张图重新解析一次会得到身份不同、内容相同的一份，
   * 按身份判断就会"每次重画都发现不同"而成环（实测表现是直接 OOM）。
   * 判据因此是**内容**（`sameDefinitionSet`），而且只刷一次。
   */
  private async refreshFromMap(): Promise<void> {
    const token = ++this.refreshToken
    const before = this.plugin.syncCurrentDefinitionSet()
    let after = before
    try {
      const target = await this.plugin.currentDefinitionDocument()
      after = target === null ? before : this.plugin.definitionsOf(target.document)
    } catch (error) {
      // 读盘失败不该让弹窗变成空白：首帧那一份照样能用，只是可能不是这张图的（控制台留证据）
      console.warn('[project-kaki] 「地图定义」弹窗读盘失败，先按当前这一份显示', error)
      return
    }
    if (token !== this.refreshToken) return
    if (sameDefinitionSet(after, before)) return
    this.render()
  }

  /** 就地重画弹窗内容（**局部重建**：重画前先把展开状态读回来） */
  private rerender(): void {
    this.render()
    void this.refreshFromMap()
  }

  private render(): void {
    const { contentEl } = this
    // 重建前读回展开状态（与 MapPanel.captureOpenGroups 同一个坑）
    for (const [id, element] of this.itemEls) {
      if (element.open === true) this.openItems.add(id)
      else this.openItems.delete(id)
    }
    for (const [role, element] of this.builtinEls) {
      if (element.open === true) this.openBuiltins.add(role)
      else this.openBuiltins.delete(role)
    }
    this.itemEls.clear()
    this.builtinEls.clear()

    contentEl.empty()
    contentEl.addClass('fc-defmodal')
    try {
      this.renderBody(contentEl)
    } catch (error) {
      // 弹窗是"一次渲染四节"：中途抛异常会让**后面几节一起消失**，而 Obsidian 只在控制台报一下 ——
      // 用户看到的就是"很多功能是坏的 / 展开了是空的"。把原因写在弹窗里，别让人对着空白猜。
      const message = error instanceof Error ? error.message : String(error)
      console.error('[project-kaki] 「地图定义」弹窗渲染失败', error)
      contentEl.createEl('div', { cls: 'fc-render-error', text: `「地图定义」弹窗渲染失败：${message}` })
    }
  }

  private renderBody(contentEl: HTMLElement): void {
    contentEl.createEl('h2', { text: DEFINITION_MODAL_LABELS.title })
    contentEl.createEl('div', { cls: 'fc-settings-note', text: MODAL_INTRO })

    // "这些定义属于谁"——用户最需要知道的一句话（定义随图之后，它不再是全局的）
    const targetPath = this.plugin.definitionTargetPath()
    const scope = contentEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    scope.dataset.fcSettingsRole = 'definition-scope'
    scope.textContent =
      targetPath === null
        ? '当前没有打开地图：下面的改动会写进「新建地图的模板」—— 下次新建的图会用这套，已有地图不受影响。'
        : `这些定义属于当前地图：${targetPath}（只改这一张，别的图各有自己的一份）。`

    const set = this.plugin.syncCurrentDefinitionSet()

    const terrainGroup = createCollapsibleGroup(contentEl, {
      title: '地形',
      role: 'terrain',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderCustomTerrains(terrainGroup, set)

    const markerGroup = createCollapsibleGroup(contentEl, {
      title: '标记',
      role: 'marker',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderCustomMarkers(markerGroup, set)

    const pathGroup = createCollapsibleGroup(contentEl, {
      title: '路径类型',
      role: 'pathType',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderPathTypeSection(pathGroup, set)

    const regionGroup = createCollapsibleGroup(contentEl, {
      title: '区域类型',
      role: 'regionType',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderRegionTypeSection(regionGroup, set)

    this.renderStyleResetRow(contentEl)
  }

  /**
   * 最下面那一行「恢复出厂参数」：把**这张地图**的路径 / 区域类型参数恢复成工厂值。
   *
   * 它跟着参数控件一起来到弹窗里（设置页那一页已经没有参数了）：参数在哪改，恢复默认就该在哪。
   */
  private renderStyleResetRow(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName('路径与区域类型参数恢复出厂')
      .setDesc('把内置 4 种路径类型与 6 种区域类型的参数恢复为出厂默认（自定义类型的定义与参数都不动）。')
      .addButton((button) =>
        button.setButtonText('恢复默认参数').onClick(async () => {
          const result = await this.plugin.resetDefinitionTypeStyles()
          if (result.ok) this.rerender()
          this.setPathTypeNoteText(result.ok ? '' : this.noteProblem(result.problem))
        }),
      )
  }

  // ------------------------------------------------------------ 共用的版式件

  /** 节内分区的小标题（`自定义（N）` / `内置（N，只读）`）—— 纯文本行，不是控件 */
  private createSectionTitle(containerEl: HTMLElement, text: string, role: 'custom' | 'builtin'): void {
    const row = containerEl.createEl('div', { cls: 'fc-defsection', text })
    row.dataset.fcSection = role
  }

  /**
   * 一条自定义定义的「一行 + 点开才编辑」。
   *
   * 标题行只写序号与显示名（外加 ID），展开状态跨重建保留。
   * 返回 `<details>` 里的内容容器，调用方往它里面建控件。
   */
  private createDefinitionItem(containerEl: HTMLElement, id: string, label: string): HTMLElement {
    const details = containerEl.createEl('details', { cls: 'fc-defitem' })
    details.dataset.fcDef = id
    // 显式赋值：假 DOM 里没有 `open` 属性时，"默认收起"这条断言才有意义（与 collapsible.ts 同一条）
    details.open = this.openItems.has(id)
    this.itemEls.set(id, details)
    const summary = details.createEl('summary', { cls: 'fc-defitem-title' })
    summary.createEl('span', { cls: 'fc-defitem-name', text: label })
    summary.createEl('span', { cls: 'fc-defitem-id', text: id })
    return details.createEl('div', { cls: 'fc-defitem-body' })
  }

  /**
   * 「内置」清单：**只读、默认收起**。
   *
   * 刻意用纯文本行而不是 `Setting`：内置定义本来就没有可做的操作（不能删、不能改 ID），
   * 建成控件只会长出"点了没反应的按钮"，也会让"自定义 / 内置"两边看起来一样重要。
   */
  private renderBuiltinList(
    containerEl: HTMLElement,
    role: string,
    title: string,
    rows: ReadonlyArray<{ label: string; hint: string }>,
  ): void {
    const details = containerEl.createEl('details', { cls: 'fc-defbuiltin' })
    details.dataset.fcBuiltin = role
    details.open = this.openBuiltins.has(role)
    this.builtinEls.set(role, details)
    details.createEl('summary', { cls: 'fc-defbuiltin-title', text: title })
    for (const row of rows) {
      const line = details.createEl('div', { cls: 'fc-defbuiltin-row' })
      line.createEl('span', { cls: 'fc-defbuiltin-name', text: row.label })
      line.createEl('span', { cls: 'fc-defbuiltin-hint', text: row.hint })
    }
  }

  /**
   * 「模式」那两选一（地形：调色 / 图片；标记：字形 / 图片）。
   *
   * 标题里带上显示名（`模式 · 沼泽地`）——与这一节其它行同一个写法，
   * 断言与用户都靠它认人。**按钮必须能独立点**，所以它是一行独立控件，
   * 不放进条目标题（放进 `<summary>` 的话，点按钮会连带把条目开合一次）。
   */
  private renderModeRow<T extends string>(
    body: HTMLElement,
    label: string,
    options: ReadonlyArray<{ mode: T; label: string; hint: string }>,
    current: T,
    onChange: (mode: T) => void,
  ): void {
    const row = body.createEl('div', { cls: 'fc-terrain-mode' })
    row.createEl('span', { cls: 'fc-terrain-mode-title', text: `模式 · ${label}` })
    const group = row.createEl('div', { cls: 'fc-terrain-mode-group' })
    for (const option of options) {
      const button = group.createEl('button', { cls: 'fc-terrain-mode-button' })
      button.dataset.mode = option.mode
      if (current === option.mode) button.addClass('is-active')
      button.textContent = option.label
      button.title = option.hint
      button.addEventListener('click', () => onChange(option.mode))
    }
  }

  /** 两个区块都空时的一句提示（比一片空白更能说明"接下来做什么"） */
  private renderCustomEmpty(containerEl: HTMLElement, text: string): void {
    containerEl.createEl('div', { cls: 'fc-defempty', text })
  }

  // ------------------------------------------------------------ 地形

  private renderCustomTerrains(containerEl: HTMLElement, set: MapDefinitionSet): void {
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text: '自定义地形排在内置 9 种之后，出现在画布工具条里。',
    })

    const list = set.terrains
    this.createSectionTitle(containerEl, `自定义（${list.length}）`, 'custom')
    if (list.length === 0) this.renderCustomEmpty(containerEl, '还没有自定义地形 —— 用下面那一行加一个。')

    list.forEach((terrain, index) => {
      const imageMode = terrain.mode === 'image'
      const body = this.createDefinitionItem(containerEl, terrain.id, `${index + 1}. ${terrain.label}`)

      this.renderModeRow(body, terrain.label, TERRAIN_MODE_OPTIONS, terrain.mode, (mode) => {
        if (terrain.mode === mode) return
        void this.plugin.updateCustomTerrain(terrain.id, { mode }).then(() => this.rerender())
      })

      new Setting(body)
        .setName(`名称与颜色 · ${terrain.label}`)
        .setDesc(`ID ${terrain.id}（不可改 —— 改它等于换一种地形）。`)
        .addText((text) =>
          text
            .setPlaceholder('显示名（例如 沼泽地）')
            .setValue(terrain.label)
            .onChange(async (value) => {
              await this.plugin.updateCustomTerrain(terrain.id, { label: value })
            }),
        )
        .addColorPicker((picker) =>
          picker.setValue(terrain.color).onChange(async (value) => {
            await this.plugin.updateCustomTerrain(terrain.id, { color: value })
          }),
        )
        .addButton((button) =>
          button.setButtonText(MODAL_ACTIONS.renameId).setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('terrain', terrain.id, terrain.label)
          }),
        )
        .addButton((button) =>
          button.setButtonText(MODAL_ACTIONS.delete).setWarning().onClick(() => {
            // 有引用 → 弹影响面确认框；没有引用 → 直接删（见 requestRemoveCustomDefinition）
            this.plugin.requestRemoveCustomDefinition('terrain', terrain.id)
          }),
        )

      if (!imageMode) {
        new Setting(body)
          .setName(`字形 · ${terrain.label}`)
          .setDesc('借用某种内置地形的图元；「通用」= 三个点。')
          .addDropdown((dropdown) => {
            dropdown.addOption('', '通用')
            for (const style of listTerrainStyles()) dropdown.addOption(style.type, style.label)
            dropdown.setValue(terrain.glyph)
            dropdown.onChange(async (value) => {
              await this.plugin.updateCustomTerrain(terrain.id, { glyph: value })
            })
          })
      }

      new Setting(body)
        .setName(`图片 · ${terrain.label}`)
        .setDesc(
          imageMode
            ? '库内路径；也可以点右边的按钮从库里挑。'
            : '当前是「调色」模式，这一栏还不生效：点右边的按钮会自动切到「图片」模式。',
        )
        .addText((text) =>
          text
            .setPlaceholder('图片路径（留空 = 退回颜色 + 字形）')
            .setValue(terrain.imagePath)
            .onChange(async (value) => {
              const check = checkTerrainImagePath(value)
              if (check.problem.length > 0) {
                this.setTerrainNoteText(`图片路径不可用：${check.problem}`)
                return
              }
              const next: { imagePath: string; mode?: CustomTerrainMode } = { imagePath: check.path }
              if (!imageMode && check.path.length > 0) next.mode = 'image'
              await this.plugin.updateCustomTerrain(terrain.id, next)
              this.setTerrainNoteText('')
            }),
        )
        .addButton((button) =>
          button.setButtonText('从库中选择…').onClick(() => {
            const ensureImageMode = imageMode
              ? Promise.resolve()
              : this.plugin.updateCustomTerrain(terrain.id, { mode: 'image' }).then(() => {
                  this.rerender()
                })
            void ensureImageMode
              .then(() =>
                this.plugin.pickImageFile({
                  title: `选择「${terrain.label}」的图片`,
                  onChoose: (path) => {
                    const check = checkTerrainImagePath(path)
                    if (check.problem.length > 0) {
                      this.setTerrainNoteText(`图片路径不可用：${check.problem}`)
                      return
                    }
                    void this.plugin
                      .updateCustomTerrain(terrain.id, { imagePath: check.path })
                      .then(() => {
                        // 顺序要紧：`render()` 会重建提示行，所以提示必须写在重绘**之后**
                        this.rerender()
                        this.setTerrainNoteText(`已选择图片：${check.path}`)
                      })
                      .catch((error: unknown) => {
                        console.error('[project-kaki] 选择图片后刷新地图定义弹窗失败', error)
                        this.setTerrainNoteText(
                          `图片已设置，但弹窗刷新失败：${error instanceof Error ? error.message : String(error)}（重新打开即可看到新值）`,
                        )
                      })
                  },
                }),
              )
              .catch((error: unknown) => {
                console.error('[project-kaki] 切换到图片模式失败', error)
                this.setTerrainNoteText(`切换到「图片」模式失败：${error instanceof Error ? error.message : String(error)}`)
              })
          }),
        )

      new Setting(body)
        .setName(`图片排版 · ${terrain.label}`)
        .setDesc('单格一张：每格各贴一张。整片一张：连通的同类型格共用一张（等比缩放居中到这一片里）。')
        .addDropdown((dropdown) => {
          dropdown.addOption('cell', '单格一张')
          dropdown.addOption('region', '整片一张（连通区域）')
          dropdown.setValue(terrain.imageLayout)
          dropdown.onChange(async (value) => {
            await this.plugin.updateCustomTerrain(terrain.id, { imageLayout: value })
          })
        })
    })

    const atLimit = set.terrains.length >= MAX_CUSTOM_TERRAINS
    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    note.dataset.fcNote = 'terrain'
    this.terrainNoteEl = note
    const pending: { id: string; label: string; color: string; glyph: string; imagePath: string; mode: CustomTerrainMode } = {
      id: '',
      label: '',
      color: DEFAULT_CUSTOM_TERRAIN_COLOR,
      glyph: '',
      imagePath: '',
      mode: DEFAULT_CUSTOM_TERRAIN_MODE,
    }

    new Setting(containerEl)
      .setName(DEFINITION_MODAL_LABELS.addTerrain)
      .setDesc(atLimit ? `已达上限（${MAX_CUSTOM_TERRAINS} 个）` : 'ID 可以留空 —— 留空就按显示名自动生成。')
      .addText((text) => {
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 swamp2）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setTerrainNoteText(this.idNote(terrainIdProblem(value), value))
          })
        if (text.inputEl) text.inputEl.title = idRuleHint(CUSTOM_TERRAIN_PREFIX)
      })
      .addText((text) =>
        text
          .setPlaceholder('显示名（留空 = 用 ID）')
          .setValue('')
          .onChange((value) => {
            pending.label = value
          }),
      )
      .addColorPicker((picker) =>
        picker.setValue(DEFAULT_CUSTOM_TERRAIN_COLOR).onChange((value) => {
          pending.color = value
        }),
      )
      .addButton((button) =>
        button.setButtonText('新增').onClick(async () => {
          const problem = pending.id.trim().length === 0 ? null : terrainIdProblem(pending.id)
          if (problem !== null) {
            this.setTerrainNoteText(this.noteProblem(problem))
            return
          }
          const result = await this.plugin.addCustomTerrain(pending)
          if (!result.ok) {
            this.setTerrainNoteText(this.noteProblem(result.problem))
            return
          }
          this.setTerrainNoteText('')
          this.rerender()
        }),
      )

    const builtins = listTerrainStyles()
    this.renderBuiltinList(
      containerEl,
      'terrain',
      `内置（${builtins.length}，只读）`,
      builtins.map((style) => ({ label: style.label, hint: style.type })),
    )
  }

  // ------------------------------------------------------------ 标记

  private renderCustomMarkers(containerEl: HTMLElement, set: MapDefinitionSet): void {
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text: '自定义标记排在内置 9 种之后，出现在画布工具条与放置对话框里。',
    })

    const list = set.markers
    this.createSectionTitle(containerEl, `自定义（${list.length}）`, 'custom')
    if (list.length === 0) this.renderCustomEmpty(containerEl, '还没有自定义标记 —— 用下面那一行加一个。')

    list.forEach((marker, index) => {
      const imageMode = marker.mode === 'image'
      const body = this.createDefinitionItem(containerEl, marker.id, `${index + 1}. ${marker.label}`)

      this.renderModeRow(body, marker.label, MARKER_MODE_OPTIONS, marker.mode, (mode) => {
        if (marker.mode === mode) return
        void this.plugin.updateCustomMarker(marker.id, { mode }).then(() => this.rerender())
      })

      new Setting(body)
        .setName(`名称 · ${marker.label}`)
        .setDesc(`ID ${marker.id}（不可改 —— 改它等于换一种标记）。`)
        .addText((text) =>
          text
            .setPlaceholder('显示名（例如 灯塔）')
            .setValue(marker.label)
            .onChange(async (value) => {
              await this.plugin.updateCustomMarker(marker.id, { label: value })
            }),
        )
        .addButton((button) =>
          button.setButtonText(MODAL_ACTIONS.renameId).setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('marker', marker.id, marker.label)
          }),
        )
        .addButton((button) =>
          button.setButtonText(MODAL_ACTIONS.delete).setWarning().onClick(() => {
            this.plugin.requestRemoveCustomDefinition('marker', marker.id)
          }),
        )

      new Setting(body)
        .setName(`字形 · ${marker.label}`)
        .setDesc(imageMode ? '图片丢失或打不开时用它兜底显示。' : '借用某个内置图标的形状；「通用」= 一个圆点。')
        .addDropdown((dropdown) => {
          dropdown.addOption('', '通用（圆点）')
          for (const icon of MARKER_ICONS) dropdown.addOption(icon, ICON_LABELS[icon])
          dropdown.setValue(marker.icon)
          dropdown.onChange(async (value) => {
            await this.plugin.updateCustomMarker(marker.id, { icon: value })
          })
        })

      const imageSetting = new Setting(body)
        .setName(`图片 · ${marker.label}`)
        .setDesc(
          imageMode
            ? '库内路径；也可以点右边的按钮从库里挑。'
            : '当前是「字形」模式，这一栏还不生效：点右边的按钮会自动切到「图片」模式。',
        )
        .addText((text) =>
          text
            .setPlaceholder('图片路径（留空 = 退回字形）')
            .setValue(marker.imagePath)
            .onChange(async (value) => {
              const check = checkTerrainImagePath(value)
              if (check.problem.length > 0) {
                this.setMarkerNoteText(`图片路径不可用：${check.problem}`)
                return
              }
              const next: { imagePath: string; mode?: CustomMarkerMode } = { imagePath: check.path }
              if (!imageMode && check.path.length > 0) next.mode = 'image'
              await this.plugin.updateCustomMarker(marker.id, next)
              this.setMarkerNoteText('')
            }),
        )
        .addButton((button) =>
          button.setButtonText('从库中选择…').onClick(() => {
            const ensureImageMode = imageMode
              ? Promise.resolve()
              : this.plugin.updateCustomMarker(marker.id, { mode: 'image' }).then(() => {
                  this.rerender()
                })
            void ensureImageMode
              .then(() =>
                this.plugin.pickImageFile({
                  title: `选择「${marker.label}」的图标图片`,
                  onChoose: (path) => {
                    const check = checkTerrainImagePath(path)
                    if (check.problem.length > 0) {
                      this.setMarkerNoteText(`图片路径不可用：${check.problem}`)
                      return
                    }
                    void this.plugin
                      .updateCustomMarker(marker.id, { imagePath: check.path })
                      .then(() => {
                        this.rerender()
                        this.setMarkerNoteText(`已选择图片：${check.path}`)
                      })
                      .catch((error: unknown) => {
                        console.error('[project-kaki] 选择标记图片后刷新弹窗失败', error)
                        this.setMarkerNoteText(
                          `图片已设置，但弹窗刷新失败：${error instanceof Error ? error.message : String(error)}（重新打开即可看到新值）`,
                        )
                      })
                  },
                }),
              )
              .catch((error: unknown) => {
                console.error('[project-kaki] 切换标记到图片模式失败', error)
                this.setMarkerNoteText(`切换到「图片」模式失败：${error instanceof Error ? error.message : String(error)}`)
              })
          }),
        )

      if (imageMode && marker.imagePath.length > 0) {
        const url = resolveVaultResourceUrl(this.app, marker.imagePath)
        if (url.length > 0) {
          const preview = imageSetting.descEl.createEl('div', { cls: 'fc-marker-preview' })
          const img = preview.createEl('img', { cls: 'fc-marker-preview-image' })
          img.src = url
          img.alt = ''
          preview.createEl('span', { cls: 'fc-settings-note', text: `当前图片：${marker.imagePath}（按原比例缩放，不拉伸）` })
        } else {
          imageSetting.setDesc(
            `${imageSetting.descEl.textContent ?? ''}（当前取不到这张图的资源地址：文件可能已被移动或删除，画布上会退回字形）`,
          )
        }
      }
    })

    const atLimit = set.markers.length >= MAX_CUSTOM_MARKERS
    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    note.dataset.fcNote = 'marker'
    this.markerNoteEl = note
    const pending: { id: string; label: string; icon: string; imagePath: string; mode: CustomMarkerMode } = {
      id: '',
      label: '',
      icon: '',
      imagePath: '',
      mode: DEFAULT_CUSTOM_MARKER_MODE,
    }

    new Setting(containerEl)
      .setName(DEFINITION_MODAL_LABELS.addMarker)
      .setDesc(atLimit ? `已达上限（${MAX_CUSTOM_MARKERS} 个）` : 'ID 可以留空 —— 留空就按显示名自动生成。')
      .addText((text) => {
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 lighthouse）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setMarkerNoteText(this.idNote(markerIdProblem(value), value))
          })
        if (text.inputEl) text.inputEl.title = idRuleHint(CUSTOM_MARKER_PREFIX)
      })
      .addText((text) =>
        text
          .setPlaceholder('显示名（留空 = 用 ID）')
          .setValue('')
          .onChange((value) => {
            pending.label = value
          }),
      )
      .addButton((button) =>
        button.setButtonText('新增').onClick(async () => {
          const problem = pending.id.trim().length === 0 ? null : markerIdProblem(pending.id)
          if (problem !== null) {
            this.setMarkerNoteText(this.noteProblem(problem))
            return
          }
          const result = await this.plugin.addCustomMarker(pending)
          if (!result.ok) {
            this.setMarkerNoteText(this.noteProblem(result.problem))
            return
          }
          this.setMarkerNoteText('')
          this.rerender()
        }),
      )

    this.renderBuiltinList(
      containerEl,
      'marker',
      `内置（${MARKER_ICONS.length}，只读）`,
      MARKER_ICONS.map((icon) => ({ label: ICON_LABELS[icon], hint: icon })),
    )
  }

  // ------------------------------------------------------------ 路径类型（增删改 + 参数）

  /**
   * 路径类型一节：`自定义（N）`（可增删改 + 参数）+ 新增那一行 + `内置（4）`（**可改参数**）。
   *
   * 内置项的参数入口是 W4-1b 加的：参数的家跟着定义走之后，内置 4 种和自定义项一样
   * 只能在"这张地图"里改 —— 少了这个入口，内置类型的线宽就永远只能是出厂值。
   */
  private renderPathTypeSection(containerEl: HTMLElement, set: MapDefinitionSet): void {
    const pathTypes = listPathTypeEntries(set.pathTypes)
    const custom = customPathTypeEntries(set.pathTypes)
    const builtin = pathTypes.filter((entry) => isBuiltinPathType(entry.id))

    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text: '颜色、线宽、虚线、线头形状与拐角形状都在这里改（内置的也能改）。只影响新画的路径。',
    })

    this.createSectionTitle(containerEl, `自定义（${custom.length}）`, 'custom')
    if (custom.length === 0) this.renderCustomEmpty(containerEl, '还没有自定义路径类型 —— 用下面那一行加一个。')

    for (const [index, entry] of custom.entries()) {
      const body = this.createDefinitionItem(containerEl, entry.id, `${index + 1}. ${entry.label}`)
      new Setting(body)
        .setName(`名称 · ${entry.label}`)
        .setDesc(`ID ${entry.id}（不可改 —— 改它等于换一种路径类型）。`)
        .addButton((button) => {
          button.setButtonText(MODAL_ACTIONS.renameId).setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('path', entry.id, entry.label)
          })
        })
        .addButton((button) => {
          button.setButtonText(MODAL_ACTIONS.delete).setWarning().setTooltip(`删除自定义类型 ${entry.id}`).onClick(() => {
            this.plugin.requestRemoveCustomDefinition('path', entry.id)
          })
        })
      this.renderPathTypeParams(body, entry)
    }

    const atLimit = custom.length >= MAX_CUSTOM_PATH_TYPES
    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    note.dataset.fcNote = 'pathType'
    this.pathTypeNoteEl = note
    const pending: { id: string; label: string; color: string; width: string; dash: string } = {
      id: '',
      label: '',
      color: DEFAULT_CUSTOM_PATH_COLOR,
      width: String(DEFAULT_CUSTOM_PATH_WIDTH),
      dash: '',
    }

    new Setting(containerEl)
      .setName(DEFINITION_MODAL_LABELS.addPathType)
      .setDesc(atLimit ? `已达上限（${MAX_CUSTOM_PATH_TYPES} 个）` : 'ID 可以留空 —— 留空就按显示名自动生成。')
      .addText((text) => {
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 highway）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setPathTypeNoteText(this.idNote(pathTypeIdProblem(value), value))
          })
        if (text.inputEl) text.inputEl.title = idRuleHint(CUSTOM_PATH_TYPE_PREFIX)
      })
      .addText((text) =>
        text
          .setPlaceholder('显示名（留空 = 用 ID）')
          .setValue('')
          .onChange((value) => {
            pending.label = value
          }),
      )
      .addColorPicker((picker) =>
        picker.setValue(pending.color).onChange((value) => {
          pending.color = value
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder('线宽（默认 4）')
          .setValue('')
          .onChange((value) => {
            pending.width = value
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('虚线（留空 = 实线）')
          .setValue('')
          .onChange((value) => {
            pending.dash = value
          }),
      )
      .addButton((button) =>
        button.setButtonText('新增').onClick(async () => {
          const problem = pending.id.trim().length === 0 ? null : pathTypeIdProblem(pending.id)
          if (problem !== null) {
            this.setPathTypeNoteText(this.noteProblem(problem))
            return
          }
          const dash = parsePathDashInput(pending.dash)
          if (!dash.ok) {
            this.setPathTypeNoteText(`虚线：${dash.problem}`)
            return
          }
          const result = await this.plugin.addCustomPathType({
            id: pending.id,
            label: pending.label,
            color: pending.color,
            width: pending.width.trim().length > 0 ? pending.width : undefined,
            dash: dash.dash,
          })
          if (!result.ok) {
            this.setPathTypeNoteText(this.noteProblem(result.problem))
            return
          }
          this.setPathTypeNoteText('')
          this.rerender()
        }),
      )

    this.createSectionTitle(containerEl, `内置（${builtin.length}，可改参数）`, 'builtin')
    for (const entry of builtin) {
      const body = this.createDefinitionItem(containerEl, entry.id, entry.label)
      this.renderPathTypeParams(body, entry)
    }
  }

  /**
   * 一种路径类型的参数控件（自定义项与内置项**共用同一份**）。
   *
   * 为什么每种类型用**两个** Setting 而不是七个：一屏要放下最多 36 种类型，
   * 每个字段一行会让用户永远滚不到底。按"视觉（颜色/端点/连接）"与"尺寸（线宽/虚线）"
   * 分成两行，仍然每行都有名字与说明。
   */
  private renderPathTypeParams(body: HTMLElement, entry: PathTypeEntry): void {
    const dashText = entry.params.dash.join(',')
    new Setting(body)
      .setName(`外观 · ${entry.label}`)
      .setDesc(`ID ${entry.id} · ${describePathTypeParams(entry.params)}`)
      .addColorPicker((picker) =>
        picker.setValue(entry.params.color).onChange(async (value) => {
          const result = await this.plugin.updatePathType(entry.id, { color: value })
          if (!result.ok) this.setPathTypeNoteText(this.noteProblem(result.problem))
        }),
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(PATH_CAP_LABELS)
          .setValue(entry.params.cap)
          .onChange(async (value) => {
            await this.plugin.updatePathType(entry.id, { cap: value })
          }),
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(PATH_JOIN_LABELS)
          .setValue(entry.params.join)
          .onChange(async (value) => {
            await this.plugin.updatePathType(entry.id, { join: value })
          }),
      )

    new Setting(body)
      .setName(`线宽与虚线 · ${entry.label}`)
      .setDesc('线宽是世界单位（1–40）；虚线留空 = 实线')
      .addText((text) =>
        text
          .setPlaceholder('线宽，例如 5')
          .setValue(String(entry.params.width))
          .onChange(async (value) => {
            await this.plugin.updatePathType(entry.id, { width: value })
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('虚线，例如 14,10；留空 = 实线')
          .setValue(dashText)
          .onChange(async (value) => {
            const parsed = parsePathDashInput(value)
            if (!parsed.ok) {
              this.setPathTypeNoteText(`「${entry.label}」的虚线：${parsed.problem}`)
              return
            }
            const result = await this.plugin.updatePathType(entry.id, { dash: parsed.dash })
            this.setPathTypeNoteText(result.ok ? '' : `「${entry.label}」的虚线：${result.problem}`)
          }),
      )
  }

  // ------------------------------------------------------------ 区域类型（只管增删改）

  /** 区域类型：与 `renderPathTypeSection` 完全同构（两行布局、就地提示、内置可改参数） */
  private renderRegionTypeSection(containerEl: HTMLElement, set: MapDefinitionSet): void {
    const regionTypes = set.regionTypes
    const custom = customRegionTypeEntries(regionTypes)
    const builtin = regionTypes.filter((entry) => isBuiltinRegionType(entry.id))

    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text: '填充色、不透明度、边框色与边框宽都在这里改（内置的也能改）。它们只影响新画的区域 —— 已画好的把样式存在地图文件里。',
    })

    this.createSectionTitle(containerEl, `自定义（${custom.length}）`, 'custom')
    if (custom.length === 0) this.renderCustomEmpty(containerEl, '还没有自定义区域类型 —— 用下面那一行加一个。')

    for (const [index, entry] of custom.entries()) {
      const body = this.createDefinitionItem(containerEl, entry.id, `${index + 1}. ${entry.label}`)
      new Setting(body)
        .setName(`名称 · ${entry.label}`)
        .setDesc(`ID ${entry.id}（不可改 —— 改它等于换一种区域类型）。`)
        .addButton((button) => {
          button.setButtonText(MODAL_ACTIONS.renameId).setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('region', entry.id, entry.label)
          })
        })
        .addButton((button) => {
          button.setButtonText(MODAL_ACTIONS.delete).setWarning().setTooltip(`删除自定义区域类型 ${entry.id}`).onClick(() => {
            this.plugin.requestRemoveCustomDefinition('region', entry.id)
          })
        })
      this.renderRegionTypeParams(body, entry)
    }

    const atLimit = custom.length >= MAX_CUSTOM_REGION_TYPES
    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    note.dataset.fcNote = 'regionType'
    this.regionTypeNoteEl = note
    const pending: {
      id: string
      label: string
      color: string
      opacity: string
      borderWidth: string
      borderDash: string
    } = {
      id: '',
      label: '',
      color: DEFAULT_CUSTOM_REGION_COLOR,
      opacity: String(resolveRegionType('realm', regionTypes).params.opacity),
      borderWidth: String(resolveRegionType('realm', regionTypes).params.borderWidth),
      borderDash: '',
    }

    new Setting(containerEl)
      .setName(DEFINITION_MODAL_LABELS.addRegionType)
      .setDesc(atLimit ? `已达上限（${MAX_CUSTOM_REGION_TYPES} 个）` : 'ID 可以留空 —— 留空就按显示名自动生成。')
      .addText((text) => {
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 march）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setRegionTypeNoteText(this.idNote(regionTypeIdProblem(value), value))
          })
        if (text.inputEl) text.inputEl.title = idRuleHint(CUSTOM_REGION_TYPE_PREFIX)
      })
      .addText((text) =>
        text
          .setPlaceholder('显示名（留空 = 用 ID）')
          .setValue('')
          .onChange((value) => {
            pending.label = value
          }),
      )
      .addColorPicker((picker) =>
        picker.setValue(pending.color).onChange((value) => {
          pending.color = value
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder('不透明度（默认 0.22）')
          .setValue('')
          .onChange((value) => {
            pending.opacity = value
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('边框宽（默认 3）')
          .setValue('')
          .onChange((value) => {
            pending.borderWidth = value
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('边框虚线（留空 = 实线）')
          .setValue('')
          .onChange((value) => {
            pending.borderDash = value
          }),
      )
      .addButton((button) =>
        button.setButtonText('新增').onClick(async () => {
          const problem = pending.id.trim().length === 0 ? null : regionTypeIdProblem(pending.id)
          if (problem !== null) {
            this.setRegionTypeNoteText(this.noteProblem(problem))
            return
          }
          const dash = parsePathDashInput(pending.borderDash)
          if (!dash.ok) {
            this.setRegionTypeNoteText(`边框虚线：${dash.problem}`)
            return
          }
          const result = await this.plugin.addCustomRegionType({
            id: pending.id,
            label: pending.label,
            color: pending.color,
            opacity: pending.opacity.trim().length > 0 ? pending.opacity : undefined,
            borderWidth: pending.borderWidth.trim().length > 0 ? pending.borderWidth : undefined,
            borderDash: dash.dash,
          })
          if (!result.ok) {
            this.setRegionTypeNoteText(this.noteProblem(result.problem))
            return
          }
          this.setRegionTypeNoteText('')
          this.rerender()
        }),
      )

    this.createSectionTitle(containerEl, `内置（${builtin.length}，可改参数）`, 'builtin')
    for (const entry of builtin) {
      const body = this.createDefinitionItem(containerEl, entry.id, entry.label)
      this.renderRegionTypeParams(body, entry)
    }
  }

  /**
   * 一种区域类型的参数控件（自定义项与内置项共用一份）。
   *
   * 与 `renderPathTypeParams` 完全同构：同样是"视觉一行 + 尺寸一行"，
   * 区别只在参数本身 —— 区域是"填充色 / 不透明度 / 边框色"与"边框宽 / 边框虚线"。
   */
  private renderRegionTypeParams(body: HTMLElement, entry: RegionTypeEntry): void {
    const dashText = entry.params.borderDash.join(',')
    new Setting(body)
      .setName(`填充与边框 · ${entry.label}`)
      .setDesc(`ID ${entry.id} · ${describeRegionTypeParams(entry.params)}`)
      .addColorPicker((picker) =>
        picker.setValue(entry.params.color).onChange(async (value) => {
          const result = await this.plugin.updateRegionType(entry.id, { color: value })
          if (!result.ok) this.setRegionTypeNoteText(this.noteProblem(result.problem))
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder('不透明度 0–1，例如 0.22')
          .setValue(String(entry.params.opacity))
          .onChange(async (value) => {
            const result = await this.plugin.updateRegionType(entry.id, { opacity: value })
            this.setRegionTypeNoteText(result.ok ? '' : `「${entry.label}」的不透明度：${result.problem}`)
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('边框色（留空 = 跟随填充色）')
          .setValue(entry.params.borderColor ?? '')
          .onChange(async (value) => {
            await this.plugin.updateRegionType(entry.id, { borderColor: value })
          }),
      )

    new Setting(body)
      .setName(`边框宽与虚线 · ${entry.label}`)
      .setDesc('边框宽是世界单位（0–40，0 = 不画边框）；虚线留空 = 实线')
      .addText((text) =>
        text
          .setPlaceholder('边框宽，例如 3')
          .setValue(String(entry.params.borderWidth))
          .onChange(async (value) => {
            await this.plugin.updateRegionType(entry.id, { borderWidth: value })
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('虚线，例如 12,8；留空 = 实线')
          .setValue(dashText)
          .onChange(async (value) => {
            const parsed = parsePathDashInput(value)
            if (!parsed.ok) {
              this.setRegionTypeNoteText(`「${entry.label}」的边框虚线：${parsed.problem}`)
              return
            }
            const result = await this.plugin.updateRegionType(entry.id, { borderDash: parsed.dash })
            this.setRegionTypeNoteText(result.ok ? '' : `「${entry.label}」的边框虚线：${result.problem}`)
          }),
      )
  }

  // ------------------------------------------------------------ 就地提示与共用的文案

  /** 地形区那一行就地提示 */
  private setTerrainNoteText(text: string): void {
    if (this.terrainNoteEl) this.terrainNoteEl.textContent = text
  }

  /** 标记区那一行就地提示 */
  private setMarkerNoteText(text: string): void {
    if (this.markerNoteEl) this.markerNoteEl.textContent = text
  }

  /** 路径类型区那一行就地提示 */
  private setPathTypeNoteText(text: string): void {
    if (this.pathTypeNoteEl) this.pathTypeNoteEl.textContent = text
  }

  /** 区域类型区那一行就地提示 */
  private setRegionTypeNoteText(text: string): void {
    if (this.regionTypeNoteEl) this.regionTypeNoteEl.textContent = text
  }

  /** 把"为什么不行"变成"接下来怎么办"（与设置页同一段话，改一次全对） */
  private noteProblem(problem: string): string {
    return `${problem}（这一条还没写进设置；改好上面那一栏再点「新增」即可，已填的其它内容不会丢）`
  }

  /** ID 输入框那一行的提示：留空 = 什么都不说 */
  private idNote(problem: string | null, value: string): string {
    if (value.trim().length === 0) return ''
    return problem === null ? '' : this.noteProblem(problem)
  }
}

/**
 * 手填 ID 的规则（从「新增」那一大段说明里挪出来，挂到 ID 输入框的悬停提示上）。
 *
 * 为什么挪：这段规则是**技术细节**（正则、前缀），写进界面说明会让"我该点哪"被淹没
 * （`UI-REORG-PLAN.md` §1 第 3 条：技术细节不进界面）。但也不能删 —— 真要手填的人需要它，
 * 所以放在悬停提示里，不占阅读量。
 */
function idRuleHint(prefix: string): string {
  return `手填 ID 的规则：小写字母开头，2–32 位，可用数字、下划线、连字符；前缀 ${prefix} 会自动补上，避免与内置重名。`
}