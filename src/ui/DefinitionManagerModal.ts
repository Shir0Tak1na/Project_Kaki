/**
 * 「地图定义」弹窗：四类自定义定义（地形 / 标记 / 路径类型 / 区域类型）的**增删改**。
 *
 * ## 为什么从设置页搬出来
 *
 * 分界线不是"重不重要"，而是**改动会不会波及已画的对象**：
 * - 自定义地形 / 标记的**定义内容**会改到已画对象（改一个地形的颜色，地图上那些格子跟着变）
 *   → 属于「定义」，搬到这个弹窗；
 * - 路径类型 / 区域类型的**参数**只影响**新画**的对象（已画对象把参数存在地图文件里）
 *   → 它们是「新对象默认值」，留在设置页。
 *
 * 于是设置页每次都摊开一大片输入框的问题没了，而定义管理仍然只有**一个**住处。
 *
 * ## 搬迁的口径：整段照搬，只换挂载点
 *
 * 四个渲染方法是从 `SettingsTab` **整段搬**过来的，校验仍走各目录的 `validateCustom*Input` 纯函数，
 * 所以"搬迁前后行为一字不变"，既有断言可以照旧比对。差别只有三处（都是刻意的）：
 * 1. 重建改成**局部重建**（`this.render()` 只重画弹窗内容）—— 不需要设置页那套 `rerenderKeepingScroll`；
 * 2. 路径 / 区域类型这里**只管增删改**，参数编辑留在设置页（那一节只给 改 ID / 删除 两个按钮）；
 * 3. 删除一律走 `plugin.requestRemoveCustomDefinition(kind, id)` —— 有引用时先弹影响面确认框，
 *    没有引用时直接删（见 `ConfirmDefinitionDeleteModal`）。
 *
 * 四个就地提示元素（`dataset.fcNote`）跟着搬过来，理由不变：四节同屏，
 * 提示必须出现在**出问题的那一节**下面，而不是共用一条。
 */

import { Modal, Setting, type App } from 'obsidian'
import type ProjectKakiPlugin from '../main.ts'
import type { CartographerSettings } from './settingsModel.ts'
import { createCollapsibleGroup } from './collapsible.ts'
import { MARKER_ICONS } from '../data/mapDocument.ts'
import { ICON_LABELS } from './PlaceMarkerModal.ts'
import { resolveVaultResourceUrl } from '../base/vaultResource.ts'
import {
  CUSTOM_REGION_TYPE_PREFIX,
  DEFAULT_CUSTOM_REGION_COLOR,
  MAX_CUSTOM_REGION_TYPES,
  customRegionTypeEntries,
  describeRegionTypeParams,
  regionTypeIdProblem,
  resolveRegionType,
} from '../render/regionTypeCatalog.ts'
import {
  CUSTOM_PATH_TYPE_PREFIX,
  DEFAULT_CUSTOM_PATH_COLOR,
  DEFAULT_CUSTOM_PATH_WIDTH,
  MAX_CUSTOM_PATH_TYPES,
  customPathTypeEntries,
  describePathTypeParams,
  listPathTypeEntries,
  parsePathDashInput,
  pathTypeIdProblem,
  resolvePathType,
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

  constructor(app: App, plugin: ProjectKakiPlugin) {
    super(app)
    this.plugin = plugin
  }

  override onOpen(): void {
    this.render()
  }

  /**
   * 就地重画弹窗内容（**局部重建**）。
   *
   * 弹窗比设置页小得多、也没有外部滚动容器，所以不需要设置页那套"记住滚动位置再写回"；
   * 但四个提示元素会在每次重建时被换掉，所以重建后要把各自那句话补回去 —— 与设置页同一坑。
   */
  private rerender(): void {
    this.render()
  }

  private render(): void {
    const { contentEl } = this
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
    contentEl.createEl('h2', { text: '地图定义' })
    contentEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '这里管四类自定义定义的**新增 / 删除 / 改 ID**。改 ID 会把地图里已画的引用一起改掉；' +
        '删除**不会**删掉地图上的对象（它们会变成回退样式并保留在文件里）。' +
        '每种类型的颜色、线宽、虚线等**参数**在设置页的「新对象默认值」里调 —— 那些只影响新画的对象。',
    })

    const settings = this.plugin.getSettings()

    const terrainGroup = createCollapsibleGroup(contentEl, {
      title: '地形',
      role: 'terrain',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderCustomTerrains(terrainGroup, settings)

    const markerGroup = createCollapsibleGroup(contentEl, {
      title: '标记',
      role: 'marker',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderCustomMarkers(markerGroup, settings)

    const pathGroup = createCollapsibleGroup(contentEl, {
      title: '路径类型',
      role: 'pathType',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderPathTypeManagement(pathGroup, settings)

    const regionGroup = createCollapsibleGroup(contentEl, {
      title: '区域类型',
      role: 'regionType',
      cls: 'fc-defmodal-group',
      titleCls: 'fc-defmodal-group-title',
    })
    this.renderRegionTypeManagement(regionGroup, settings)
  }

  // ------------------------------------------------------------ 地形（整段搬自 SettingsTab）

  private renderCustomTerrains(containerEl: HTMLElement, settings: CartographerSettings): void {
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '自定义地形会出现在画布工具条里（内置 9 种之后）。每条有两种模式：' +
        '「调色」只用颜色 + 字形（不依赖任何外部资源），「图片」用库内的一张图片' +
        '（图片加载失败时回退到颜色 + 字形）。ID 是写进地图文件的值（形如 custom:swamp2）——' +
        '显示名随时可以改，不影响已经画好的格子；反过来，删掉某个地形也不会删掉地图上的格子，' +
        '那些格子会变成回退样式（灰色菱形）并保留在文件里。',
    })

    settings.customTerrains.forEach((terrain, index) => {
      const modeRow = containerEl.createEl('div', { cls: 'fc-terrain-mode' })
      modeRow.createEl('span', { cls: 'fc-terrain-mode-title', text: `地形 ${index + 1} · ${terrain.label}` })
      const modeGroup = modeRow.createEl('div', { cls: 'fc-terrain-mode-group' })
      for (const option of TERRAIN_MODE_OPTIONS) {
        const button = modeGroup.createEl('button', { cls: 'fc-terrain-mode-button' })
        button.dataset.mode = option.mode
        button.dataset.index = String(index)
        if (terrain.mode === option.mode) button.addClass('is-active')
        button.textContent = option.label
        button.title = option.hint
        button.addEventListener('click', () => {
          if (terrain.mode === option.mode) return
          void this.plugin.updateCustomTerrain(index, { mode: option.mode }).then(() => this.rerender())
        })
      }

      const imageMode = terrain.mode === 'image'
      new Setting(containerEl)
        .setName(`　└ 名称与颜色 · ${terrain.label}`)
        .setDesc(
          `写入地图文件的 ID：${terrain.id}（不可修改 —— 改它等于换一种地形）。` +
            (imageMode
              ? '当前模式：图片 —— 颜色是「图片加载失败时的回退色」，也是图片底下的垫色。'
              : '当前模式：调色 —— 只用颜色 + 字形，不依赖任何外部资源。'),
        )
        .addText((text) =>
          text
            .setPlaceholder('显示名（例如 沼泽地）')
            .setValue(terrain.label)
            .onChange((value) => {
              void this.plugin.updateCustomTerrain(index, { label: value })
            }),
        )
        .addColorPicker((picker) =>
          picker.setValue(terrain.color).onChange((value) => {
            void this.plugin.updateCustomTerrain(index, { color: value })
          }),
        )
        .addButton((button) =>
          button.setButtonText('改 ID…').setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('terrain', terrain.id, terrain.label)
          }),
        )
        .addButton((button) =>
          button.setButtonText('删除').setWarning().onClick(() => {
            // 有引用 → 弹影响面确认框；没有引用 → 直接删（见 requestRemoveCustomDefinition）
            this.plugin.requestRemoveCustomDefinition('terrain', terrain.id)
          }),
        )

      if (!imageMode) {
        new Setting(containerEl)
          .setName(`　└ 字形 · ${terrain.label}`)
          .setDesc('字形：借用某种内置地形的图元；「通用」= 三个点。想用自己的图片见下面那一栏。')
          .addDropdown((dropdown) => {
            dropdown.addOption('', '通用')
            for (const style of listTerrainStyles()) dropdown.addOption(style.type, style.label)
            dropdown.setValue(terrain.glyph)
            dropdown.onChange((value) => {
              void this.plugin.updateCustomTerrain(index, { glyph: value })
            })
          })
      }

      new Setting(containerEl)
        .setName(`　└ 图片 · ${terrain.label}`)
        .setDesc(
          (imageMode
            ? '库内路径，例如 Assets/forest.png；也可以点右边的按钮从库里挑。'
            : '当前是「调色」模式：这一栏还不会生效。点右边的按钮会**自动切到「图片」模式**并选择库内图片；直接在这里填一个合法路径也一样。') +
            (terrain.imagePath.length === 0 ? '还没选图片：这一格会退回到颜色 + 字形。' : ''),
        )
        .addText((text) =>
          text
            .setPlaceholder('图片路径（留空 = 退回到颜色 + 字形）')
            .setValue(terrain.imagePath)
            .onChange((value) => {
              const check = checkTerrainImagePath(value)
              if (check.problem.length > 0) {
                this.setTerrainNoteText(`图片路径不可用：${check.problem}`)
                return
              }
              const next: { imagePath: string; mode?: CustomTerrainMode } = { imagePath: check.path }
              if (!imageMode && check.path.length > 0) next.mode = 'image'
              void this.plugin.updateCustomTerrain(index, next)
              this.setTerrainNoteText('')
            }),
        )
        .addButton((button) =>
          button.setButtonText('从库中选择…').onClick(() => {
            const ensureImageMode = imageMode
              ? Promise.resolve()
              : this.plugin.updateCustomTerrain(index, { mode: 'image' }).then(() => {
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
                      .updateCustomTerrain(index, { imagePath: check.path })
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

      new Setting(containerEl)
        .setName(`　└ 显示方式 · ${terrain.label}`)
        .setDesc(
          '单格一张：每个格子各贴一张图（默认）。' +
            '整片一张：**所有连通的同类型格**共用一张图 —— 图片等比缩放（不拉伸）居中放到这一片的范围里，' +
            '超出这一片的部分不渲染。适合"整片森林/整片海共用一张纹理"。',
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('cell', '单格一张')
          dropdown.addOption('region', '整片一张（连通区域）')
          dropdown.setValue(terrain.imageLayout)
          dropdown.onChange((value) => {
            void this.plugin.updateCustomTerrain(index, { imageLayout: value })
            this.rerender()
          })
        })
    })

    const atLimit = settings.customTerrains.length >= MAX_CUSTOM_TERRAINS
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
      .setName('新增自定义地形')
      .setDesc(
        atLimit
          ? `已达上限（${MAX_CUSTOM_TERRAINS} 个）`
          : `ID 可以留空 —— 留空就按显示名自动生成（「My Forest」→ custom:my-forest；纯中文名得到 custom:类别+序号 这样的短 ID），` +
              `省得为了记规则去查文档。要手填的话规则是：小写字母开头，2–32 位，可用数字、下划线、连字符；` +
              `前缀 ${CUSTOM_TERRAIN_PREFIX} 会自动补上，避免与内置 9 种重名。`,
      )
      .addText((text) =>
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 swamp2）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setTerrainNoteText(this.idNote(terrainIdProblem(value), value))
          }),
      )
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
        button.setButtonText('新增').onClick(() => {
          const problem = pending.id.trim().length === 0 ? null : terrainIdProblem(pending.id)
          if (problem !== null) {
            this.setTerrainNoteText(this.noteProblem(problem))
            return
          }
          void this.plugin.addCustomTerrain(pending).then((result) => {
            if (!result.ok) {
              this.setTerrainNoteText(this.noteProblem(result.problem))
              return
            }
            this.setTerrainNoteText('')
            this.rerender()
          })
        }),
      )
  }

  // ------------------------------------------------------------ 标记（整段搬自 SettingsTab）

  private renderCustomMarkers(containerEl: HTMLElement, settings: CartographerSettings): void {
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '自定义标记会出现在画布工具条的图标组里（内置 9 种之后），以及放置标记对话框的图标下拉里。' +
        '每条有两种模式：「字形」借用某个内置图标的形状（不依赖任何外部资源），' +
        '「图片」用库内的一张图片（图片丢失或打不开时回退到字形，标记不会因此消失）。' +
        'ID 是写进地图文件的值（形如 custom:lighthouse）—— 显示名随时可改，不影响已经放好的标记；' +
        '反过来，删掉某个标记也不会删掉地图上的标记，它们会变成回退图标并保留在文件里。' +
        '笔记的 frontmatter 里也可以直接写 map-type: custom:lighthouse。',
    })

    settings.customMarkers.forEach((marker, index) => {
      const modeRow = containerEl.createEl('div', { cls: 'fc-terrain-mode' })
      modeRow.createEl('span', { cls: 'fc-terrain-mode-title', text: `标记 ${index + 1} · ${marker.label}` })
      const modeGroup = modeRow.createEl('div', { cls: 'fc-terrain-mode-group' })
      for (const option of MARKER_MODE_OPTIONS) {
        const button = modeGroup.createEl('button', { cls: 'fc-terrain-mode-button' })
        button.dataset.mode = option.mode
        button.dataset.index = String(index)
        if (marker.mode === option.mode) button.addClass('is-active')
        button.textContent = option.label
        button.title = option.hint
        button.addEventListener('click', () => {
          if (marker.mode === option.mode) return
          void this.plugin.updateCustomMarker(index, { mode: option.mode }).then(() => this.rerender())
        })
      }

      const imageMode = marker.mode === 'image'
      new Setting(containerEl)
        .setName(`　└ 名称 · ${marker.label}`)
        .setDesc(
          `写入地图文件的 ID：${marker.id}（不可修改 —— 改它等于换一种标记）。` +
            (imageMode ? '当前模式：图片。' : '当前模式：字形。'),
        )
        .addText((text) =>
          text
            .setPlaceholder('显示名（例如 灯塔）')
            .setValue(marker.label)
            .onChange((value) => {
              void this.plugin.updateCustomMarker(index, { label: value })
            }),
        )
        .addButton((button) =>
          button.setButtonText('改 ID…').setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('marker', marker.id, marker.label)
          }),
        )
        .addButton((button) =>
          button.setButtonText('删除').setWarning().onClick(() => {
            this.plugin.requestRemoveCustomDefinition('marker', marker.id)
          }),
        )

      new Setting(containerEl)
        .setName(`　└ 字形 · ${marker.label}`)
        .setDesc(
          imageMode
            ? '当前是「图片」模式：字形只在图片丢失或打不开时兜底显示。'
            : '借用某个内置图标的形状；「通用」= 一个圆点。想用自己的图片见下面那一栏。',
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('', '通用（圆点）')
          for (const icon of MARKER_ICONS) dropdown.addOption(icon, ICON_LABELS[icon])
          dropdown.setValue(marker.icon)
          dropdown.onChange((value) => {
            void this.plugin.updateCustomMarker(index, { icon: value })
          })
        })

      const imageSetting = new Setting(containerEl)
        .setName(`　└ 图片 · ${marker.label}`)
        .setDesc(
          (imageMode
            ? '库内路径，例如 Assets/lighthouse.png；也可以点右边的按钮从库里挑。'
            : '当前是「字形」模式：这一栏还不会生效。点右边的按钮会**自动切到「图片」模式**并选择库内图片；直接在这里填一个合法路径也一样。') +
            (marker.imagePath.length === 0 ? '还没选图片：这个标记会退回字形。' : ''),
        )
        .addText((text) =>
          text
            .setPlaceholder('图片路径（留空 = 退回字形）')
            .setValue(marker.imagePath)
            .onChange((value) => {
              const check = checkTerrainImagePath(value)
              if (check.problem.length > 0) {
                this.setMarkerNoteText(`图片路径不可用：${check.problem}`)
                return
              }
              const next: { imagePath: string; mode?: CustomMarkerMode } = { imagePath: check.path }
              if (!imageMode && check.path.length > 0) next.mode = 'image'
              void this.plugin.updateCustomMarker(index, next)
              this.setMarkerNoteText('')
            }),
        )
        .addButton((button) =>
          button.setButtonText('从库中选择…').onClick(() => {
            const ensureImageMode = imageMode
              ? Promise.resolve()
              : this.plugin.updateCustomMarker(index, { mode: 'image' }).then(() => {
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
                      .updateCustomMarker(index, { imagePath: check.path })
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
          preview.createEl('span', {
            cls: 'fc-settings-note',
            text: `当前图片：${marker.imagePath}（画布上按原比例缩放，不拉伸）`,
          })
        } else {
          imageSetting.setDesc(
            `${imageSetting.descEl.textContent ?? ''}（当前取不到这张图的资源地址：文件可能已被移动或删除，画布上会退回字形）`,
          )
        }
      }
    })

    const atLimit = settings.customMarkers.length >= MAX_CUSTOM_MARKERS
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
      .setName('新增自定义标记')
      .setDesc(
        atLimit
          ? `已达上限（${MAX_CUSTOM_MARKERS} 个）`
          : `ID 可以留空 —— 留空就按显示名自动生成（「My Forest」→ custom:my-forest；纯中文名得到 custom:类别+序号 这样的短 ID），` +
              `省得为了记规则去查文档。要手填的话规则是：小写字母开头，2–32 位，可用数字、下划线、连字符；` +
              `前缀 ${CUSTOM_MARKER_PREFIX} 会自动补上，避免与内置 9 种重名。` +
              '建好之后可以在上面切模式、选字形或图片。',
      )
      .addText((text) =>
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 lighthouse）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setMarkerNoteText(this.idNote(markerIdProblem(value), value))
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder('显示名（留空 = 用 ID）')
          .setValue('')
          .onChange((value) => {
            pending.label = value
          }),
      )
      .addButton((button) =>
        button.setButtonText('新增').onClick(() => {
          const problem = pending.id.trim().length === 0 ? null : markerIdProblem(pending.id)
          if (problem !== null) {
            this.setMarkerNoteText(this.noteProblem(problem))
            return
          }
          void this.plugin.addCustomMarker(pending).then((result) => {
            if (!result.ok) {
              this.setMarkerNoteText(this.noteProblem(result.problem))
              return
            }
            this.setMarkerNoteText('')
            this.rerender()
          })
        }),
      )
  }

  // ------------------------------------------------------------ 路径类型（只管增删改）

  /**
   * 路径类型：列表（ID + 显示名）+ 改 ID / 删除 + 新增。
   *
   * **参数编辑不在这里**（颜色 / 线宽 / 虚线在设置页的「新对象默认值」）——
   * 那些只影响新画的对象，属于偏好；这里管的是**定义本身**（增删改）。
   */
  private renderPathTypeManagement(containerEl: HTMLElement, settings: CartographerSettings): void {
    const pathTypes = listPathTypeEntries(settings.pathTypes)
    const custom = customPathTypeEntries(settings.pathTypes)

    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '内置 4 种的名字固定，不能删也不能改 ID；自定义类型可以随时改名字（改名字不影响已经画好的路径）。' +
        '颜色、线宽、虚线与端点这些**参数**在设置页的「新对象默认值」里调。',
    })

    for (const entry of pathTypes) {
      const resolved = resolvePathType(entry.id, settings.pathTypes)
      const isCustom = !resolved.builtin

      const row = new Setting(containerEl)
        .setName(`${entry.label}${isCustom ? '（自定义）' : ''}`)
        .setDesc(`ID ${entry.id} · ${describePathTypeParams(entry.params)}`)
      // ⚠️ 内置项**不能"先把按钮建出来、再在回调里 return"**：
      // Obsidian 的 `addButton(cb)` 是**先创建按钮元素、再调用回调**，于是内置行右边会挂上
      // 两个没有任何文字、点了也没反应的**空按钮**（真实库里的实测现象，用户的原话是
      // "为什么地图定义里会有两个空按钮"）。内置行本来就没有可做的操作，所以直接不建。
      if (!isCustom) continue
      row
        .addButton((button) => {
          button.setButtonText('改 ID…').setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('path', entry.id, entry.label)
          })
        })
        .addButton((button) => {
          button.setButtonText('删除').setWarning().setTooltip(`删除自定义类型 ${entry.id}`).onClick(() => {
            this.plugin.requestRemoveCustomDefinition('path', entry.id)
          })
        })
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
      .setName('新增自定义路径类型')
      .setDesc(
        atLimit
          ? `已达上限（${MAX_CUSTOM_PATH_TYPES} 个）`
          : `ID 可以留空 —— 留空就按显示名自动生成（「My Forest」→ custom:my-forest；纯中文名得到 custom:类别+序号 这样的短 ID），` +
              `省得为了记规则去查文档。要手填的话规则是：小写字母开头，2–32 位，可用数字、下划线、连字符；` +
              `前缀 ${CUSTOM_PATH_TYPE_PREFIX} 会自动补上，避免与内置 4 种重名。` +
              '建好之后可以在设置页的「新对象默认值」里改颜色、线宽、端点与连接。',
      )
      .addText((text) =>
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 highway）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setPathTypeNoteText(this.idNote(pathTypeIdProblem(value), value))
          }),
      )
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
        button.setButtonText('新增').onClick(() => {
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
          void this.plugin
            .addCustomPathType({
              id: pending.id,
              label: pending.label,
              color: pending.color,
              width: pending.width.trim().length > 0 ? pending.width : undefined,
              dash: dash.dash,
            })
            .then((result) => {
              if (!result.ok) {
                this.setPathTypeNoteText(this.noteProblem(result.problem))
                return
              }
              this.setPathTypeNoteText('')
              this.rerender()
            })
        }),
      )
  }

  // ------------------------------------------------------------ 区域类型（只管增删改）

  /** 区域类型：与 `renderPathTypeManagement` 完全同构（参数编辑同样留在设置页） */
  private renderRegionTypeManagement(containerEl: HTMLElement, settings: CartographerSettings): void {
    const regionTypes = settings.regionTypes
    const custom = customRegionTypeEntries(regionTypes)

    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '内置 6 种（王国/帝国/公国/教区/荒原/海域）的名字固定，不能删也不能改 ID；自定义类型可以随时改名字。' +
        '填充色、不透明度与边框这些**参数**在设置页的「新对象默认值」里调。',
    })

    for (const entry of regionTypes) {
      const resolved = resolveRegionType(entry.id, regionTypes)
      const isCustom = !resolved.builtin

      const row = new Setting(containerEl)
        .setName(`${entry.label}${isCustom ? '（自定义）' : ''}`)
        .setDesc(`ID ${entry.id} · ${describeRegionTypeParams(entry.params)}`)
      // 同路径类型那一段：内置行不建按钮（`addButton` 先建元素再回调，提前 return 会留下空按钮）
      if (!isCustom) continue
      row
        .addButton((button) => {
          button.setButtonText('改 ID…').setTooltip('改内部标识，并把地图里已画的引用一起改掉').onClick(() => {
            this.plugin.openRenameDefinitionModal('region', entry.id, entry.label)
          })
        })
        .addButton((button) => {
          button.setButtonText('删除').setWarning().setTooltip(`删除自定义区域类型 ${entry.id}`).onClick(() => {
            this.plugin.requestRemoveCustomDefinition('region', entry.id)
          })
        })
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
      .setName('新增自定义区域类型')
      .setDesc(
        atLimit
          ? `已达上限（${MAX_CUSTOM_REGION_TYPES} 个）`
          : `ID 可以留空 —— 留空就按显示名自动生成（「My Forest」→ custom:my-forest；纯中文名得到 custom:类别+序号 这样的短 ID），` +
              `省得为了记规则去查文档。要手填的话规则是：小写字母开头，2–32 位，可用数字、下划线、连字符；` +
              `前缀 ${CUSTOM_REGION_TYPE_PREFIX} 会自动补上，避免与内置 6 种重名。` +
              '建好之后可以在设置页的「新对象默认值」里改颜色、不透明度与边框。',
      )
      .addText((text) =>
        text
          .setPlaceholder('ID（留空 = 自动生成，例如 march）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            this.setRegionTypeNoteText(this.idNote(regionTypeIdProblem(value), value))
          }),
      )
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
        button.setButtonText('新增').onClick(() => {
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
          void this.plugin
            .addCustomRegionType({
              id: pending.id,
              label: pending.label,
              color: pending.color,
              opacity: pending.opacity.trim().length > 0 ? pending.opacity : undefined,
              borderWidth: pending.borderWidth.trim().length > 0 ? pending.borderWidth : undefined,
              borderDash: dash.dash,
            })
            .then((result) => {
              if (!result.ok) {
                this.setRegionTypeNoteText(this.noteProblem(result.problem))
                return
              }
              this.setRegionTypeNoteText('')
              this.rerender()
            })
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