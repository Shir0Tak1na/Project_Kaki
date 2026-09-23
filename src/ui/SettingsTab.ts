/**
 * 插件设置。
 *
 * 分两类：
 * - **缩放与显示**：名称字号倍率、网格开关、开发者模式；
 * - **样式**：路径颜色、区域颜色、名称字体族（见 `stylePalette.ts`）。
 *
 * 为什么把它们做成设置而不是写死常量：这些都是**纯视觉偏好**，
 * 而且我无法从代码里判断"多大才够看""什么颜色才合适"（真实反馈连续两轮都说字号太小）。
 * 与其再来回改常量，不如把旋钮交给用户 —— 改一下就能看到效果，不必等重新构建。
 *
 * 一条重要边界：样式设置只决定**新画的对象**用什么颜色。
 * 已经画好的对象把颜色存在地图文件里（`path.color` / `region.color`），
 * 改设置**不会**悄悄改掉你已有的地图。
 */

import { PluginSettingTab, Setting, type App } from 'obsidian'
import type ProjectKakiPlugin from '../main.ts'
import { PATH_TYPES, type PathType } from '../data/mapDocument.ts'
import { PATH_STYLES, REGION_PRESETS } from '../render/shapeStyle.ts'
import {
  CUSTOM_TERRAIN_PREFIX,
  DEFAULT_CUSTOM_TERRAIN_COLOR,
  MAX_CUSTOM_TERRAINS,
  checkTerrainImagePath,
  normalizeCustomTerrains,
  terrainIdProblem,
  type CustomTerrain,
} from '../render/terrainCatalog.ts'
import { listTerrainStyles } from '../render/terrainStyle.ts'
import {
  defaultPathColors,
  defaultRegionColors,
  isDefaultPathColors,
  isDefaultRegionColors,
  normalizeColor,
  normalizeFontFamily,
  normalizePathColors,
  normalizeRegionColors,
  type PathColorMap,
  type StylePalette,
} from '../render/stylePalette.ts'

export interface CartographerSettings {
  /** 名称字号倍率（1 = 默认）。范围 0.5–3.0，步长 0.1。 */
  labelScale: number
  /** 是否显示六边形网格线 */
  showGrid: boolean
  /**
   * 开发者模式：打开后才会出现开发用探针命令（诊断 Canvas / 监视视口变化）。
   * 关着时这些命令会从命令面板里**隐藏**，避免误触。
   */
  developerMode: boolean
  /** 每种路径类型的默认颜色（新画的路径用它） */
  pathColors: PathColorMap
  /** 区域预设色（新画的区域用它） */
  regionColors: string[]
  /** 名称字体族；`''` = 跟随主题 */
  labelFontFamily: string
  /**
   * 用户自定义地形（内置 9 种之外的）。
   *
   * 这里的 `id`（形如 `custom:swamp2`）就是写进地图文件的 `terrain.<格键>.t` 的值，
   * 与显示名完全解耦：改显示名不影响已存数据，删掉定义也不会删掉地图上的格子
   * （它们会退化成回退视觉，数据仍在文件里）。
   */
  customTerrains: CustomTerrain[]
}

export const DEFAULT_SETTINGS: CartographerSettings = {
  labelScale: 1,
  showGrid: true,
  developerMode: false,
  pathColors: defaultPathColors(),
  regionColors: defaultRegionColors(),
  labelFontFamily: '',
  customTerrains: [],
}

export const LABEL_SCALE_MIN = 0.5
export const LABEL_SCALE_MAX = 3
export const LABEL_SCALE_STEP = 0.1

/** 把任意输入收敛成合法倍率（数据文件可能被手工改坏） */
export function normalizeLabelScale(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.labelScale
  return Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, Math.round(numeric * 10) / 10))
}

/**
 * 把任意输入收敛成一份完整设置。
 *
 * **所有入口都走这里**（`loadData` 的结果、测试注入的对象），
 * 于是"data.json 被手工改坏"只会在一个地方被处理掉，而不是散落成一堆 `??` 兜底。
 */
export function normalizeSettings(raw: unknown): CartographerSettings {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    labelScale: normalizeLabelScale(source.labelScale),
    showGrid: source.showGrid !== false,
    developerMode: source.developerMode === true,
    pathColors: normalizePathColors(source.pathColors),
    regionColors: normalizeRegionColors(source.regionColors),
    labelFontFamily: normalizeFontFamily(source.labelFontFamily),
    // 自定义地形逐条独立校验：data.json 被手工改坏时只丢坏的那一条，其余照常可用
    customTerrains: normalizeCustomTerrains(source.customTerrains),
  }
}

/** 设置 → 绘制层消费的调色板 */
export function paletteOf(settings: CartographerSettings): StylePalette {
  return {
    pathColors: settings.pathColors,
    regionColors: settings.regionColors,
    fontFamily: settings.labelFontFamily,
  }
}

export class CartographerSettingTab extends PluginSettingTab {
  private readonly plugin: ProjectKakiPlugin
  /** 自定义地形区底部那一行就地提示（错误原因等）；每次 `display()` 重新绑定 */
  private noteEl: HTMLElement | null = null

  constructor(app: App, plugin: ProjectKakiPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl('h2', { text: 'Project Kaki' })
    // 译名只在设置页出现这一次：别在每个标题里都写两个名字
    containerEl.createEl('div', { cls: 'fc-settings-subtitle', text: 'Project 垣 · 六边形地图创作' })

    const settings = this.plugin.getSettings()
    const stats = this.plugin.getLayerManager()?.listStatus() ?? []
    const attached = stats.find((item) => item.attached && item.stats)

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
            this.display()
          }),
      )

    new Setting(containerEl)
      .setName('当前实际字号')
      .setDesc(
        attached?.stats?.labelCssPx
          ? `路径 ${attached.stats.labelCssPx.path} px · 区域 ${attached.stats.labelCssPx.region} px` +
            `（屏幕 CSS 像素；当前画布 1 CSS px = ${attached.stats.rasterPxPerCssPx.toFixed(2)} 位图像素）`
          : '先打开一张绑定了地图的 Canvas 并启用地图层，这里会显示当前的实际字号。',
      )

    new Setting(containerEl)
      .setName('显示六边形网格')
      .setDesc('关闭后只隐藏网格线，不会隐藏地形或地图层。')
      .addToggle((toggle) =>
        toggle.setValue(settings.showGrid).onChange((value) => {
          void this.plugin.setShowGrid(value)
          this.display()
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
          this.display()
        }),
      )

    // ---- 样式（路径颜色 / 区域颜色 / 字体）----
    containerEl.createEl('h3', { text: '样式' })
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      // 设置说明是纯文本（不是 Markdown），所以这里不要写 ** 强调
      text:
        '这些颜色只决定新画的路径与区域用什么颜色。已经画好的对象把颜色存在地图文件里' +
        '（path.color / region.color），改设置不会改动它们。',
    })

    for (const type of PATH_TYPES) {
      const style = PATH_STYLES[type]
      new Setting(containerEl)
        .setName(`路径颜色 · ${style.label}`)
        .setDesc(`新画的${style.label}用它（线宽 ${style.width}、${style.dash ? '虚线' : '实线'}等保持出厂设定）`)
        .addColorPicker((picker) =>
          picker.setValue(settings.pathColors[type]).onChange((value) => {
            void this.plugin.setPathColor(type, value)
          }),
        )
    }

    REGION_PRESETS.forEach((preset, index) => {
      new Setting(containerEl)
        .setName(`区域颜色 · ${preset.label}`)
        .setDesc('区域预设色块（工具条上那一排色块，按顺序对应）')
        .addColorPicker((picker) =>
          picker.setValue(settings.regionColors[index] ?? preset.color).onChange((value) => {
            void this.plugin.setRegionColor(index, value)
          }),
        )
    })

    new Setting(containerEl)
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

    const dirty = !isDefaultPathColors(settings.pathColors) || !isDefaultRegionColors(settings.regionColors) || settings.labelFontFamily.length > 0
    new Setting(containerEl)
      .setName('恢复出厂样式')
      .setDesc(dirty ? '当前样式已被改动。点这里把所有颜色与字体恢复为出厂默认。' : '当前就是出厂默认样式。')
      .addButton((button) =>
        button.setButtonText('恢复默认').onClick(() => {
          void this.plugin.resetStylePalette()
          this.display()
        }),
      )

    this.renderCustomTerrains(containerEl, settings)

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
   * 自定义地形：列表 + 新建。
   *
   * 为什么每条都带"完整 ID"的只读展示：ID 才是写进地图文件的东西，
   * 用户改显示名时如果看不到 ID，就会以为"改名字会把数据也改了"（这是最需要一眼看清的一件事）。
   *
   * 为什么错误信息就地显示而不是用 Notice：这一屏要同时看几个字段，
   * 弹出去的通知会遮住输入框，而用户往往需要边改边看原因。
   */
  private renderCustomTerrains(containerEl: HTMLElement, settings: CartographerSettings): void {
    containerEl.createEl('h3', { text: '自定义地形' })
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '自定义地形会出现在画布工具条里（内置 9 种之后），可以只用一个颜色 + 字形，' +
        '也可以关联库内的一张图片。ID 是写进地图文件的值（形如 custom:swamp2）——' +
        '显示名随时可以改，不影响已经画好的格子；反过来，删掉某个地形也不会删掉地图上的格子，' +
        '那些格子会变成回退样式（灰色菱形）并保留在文件里。',
    })

    settings.customTerrains.forEach((terrain, index) => {
      new Setting(containerEl)
        .setName(`地形 ${index + 1} · ${terrain.label}`)
        .setDesc(
          `写入地图文件的 ID：${terrain.id}（不可修改 —— 改它等于换一种地形）。` +
            (terrain.imagePath.length > 0
              ? `图片：${terrain.imagePath}（图片缺失时自动回退到颜色 + 字形）`
              : '当前只用颜色 + 字形（未设置图片）。'),
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
          button.setButtonText('删除').onClick(() => {
            void this.plugin.removeCustomTerrain(index)
            this.display()
          }),
        )

      new Setting(containerEl)
        .setName(`　└ 字形与图片 · ${terrain.label}`)
        .setDesc('字形：借用某种内置地形的图元；「通用」= 三个点。图片：库内路径，例如 Assets/forest.png')
        .addDropdown((dropdown) => {
          dropdown.addOption('', '通用')
          for (const style of listTerrainStyles()) dropdown.addOption(style.type, style.label)
          dropdown.setValue(terrain.glyph)
          dropdown.onChange((value) => {
            void this.plugin.updateCustomTerrain(index, { glyph: value })
          })
        })
        .addText((text) =>
          text
            .setPlaceholder('图片路径（留空 = 不用图片）')
            .setValue(terrain.imagePath)
            .onChange((value) => {
              const check = checkTerrainImagePath(value)
              if (check.problem.length > 0) {
                // 路径不合法就地提示，并且**不写进设置**（否则绘制层每帧都要处理一个坏路径）
                this.setNoteText(`图片路径不可用：${check.problem}`)
                return
              }
              void this.plugin.updateCustomTerrain(index, { imagePath: check.path })
              this.setNoteText('')
            }),
        )
    })

    // ---- 新建 ----
    const atLimit = settings.customTerrains.length >= MAX_CUSTOM_TERRAINS
    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.noteEl = note
    const pending: { id: string; label: string; color: string; glyph: string; imagePath: string } = {
      id: '',
      label: '',
      color: DEFAULT_CUSTOM_TERRAIN_COLOR,
      glyph: '',
      imagePath: '',
    }

    new Setting(containerEl)
      .setName('新增自定义地形')
      .setDesc(
        atLimit
          ? `已达上限（${MAX_CUSTOM_TERRAINS} 个）`
          : `ID 规则：小写字母开头，2–32 位，可用数字、下划线、连字符；` +
              `前缀 ${CUSTOM_TERRAIN_PREFIX} 会自动补上，避免与内置 9 种重名。`,
      )
      .addText((text) =>
        text
          .setPlaceholder('ID（例如 swamp2）')
          .setValue('')
          .onChange((value) => {
            pending.id = value
            // 边输入边给原因：用户不必等点了"新增"才知道哪里不对
            this.setNoteText(value.trim().length === 0 ? '' : (terrainIdProblem(value) ?? ''))
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
          const problem = terrainIdProblem(pending.id)
          if (problem !== null) {
            this.setNoteText(problem)
            return
          }
          void this.plugin.addCustomTerrain(pending).then((result) => {
            if (!result.ok) {
              this.setNoteText(result.problem)
              return
            }
            this.setNoteText('')
            this.display()
          })
        }),
      )
  }

  /** 设置页里那一行就地提示（错误原因、保存结果） */
  private setNoteText(text: string): void {
    if (this.noteEl) this.noteEl.textContent = text
  }
}
