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
import { PATH_TYPES } from '../data/mapDocument.ts'
import { PATH_STYLES, REGION_PRESETS } from '../render/shapeStyle.ts'
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
import { LAYER_KEYS, LAYER_LABELS, isLayerVisible, type LayerKey } from '../render/layerVisibility.ts'
import { isDefaultPathColors, isDefaultRegionColors } from '../render/stylePalette.ts'

/**
 * 自定义地形的两种模式（设置页的分段控件用）。
 *
 * 提示文字写清"这种模式依赖什么、失败了会怎样" —— 用户选模式时真正要知道的是这个，
 * 而不是"color / image 两个词的英文含义"。
 */
const TERRAIN_MODE_OPTIONS: ReadonlyArray<{ mode: CustomTerrainMode; label: string; hint: string }> = [
  { mode: 'color', label: '调色', hint: '只用颜色 + 字形：不依赖任何外部资源，最不容易失败' },
  { mode: 'image', label: '图片', hint: '用库内的一张图片；图片缺失或解不开时回退到颜色 + 字形' },
]

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
      .setDesc('关闭后只隐藏网格线，不会隐藏地形或地图层。它与下面「图层」一节里的网格是同一个开关。')
      .addToggle((toggle) =>
        toggle.setValue(isLayerVisible(settings.layers, 'grid')).onChange((value) => {
          // 内部写的是图层设置（`layers.grid`）—— 网格就是六个图层之一，
          // 保留这个开关是为了不让老用户重新找一遍位置
          void this.plugin.setLayerVisible('grid', value)
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

    // ---- 图层（地形 / 网格 / 区域 / 路径 / 标记 / 名称）----
    containerEl.createEl('h3', { text: '图层' })
    containerEl.createEl('div', {
      cls: 'fc-settings-note',
      text:
        '图层开关只决定"看不看"，不写进地图数据 —— 关掉某层再打开，内容原样还在。' +
        '网格也在这一组里（它同时是上面的「显示六边形网格」开关）。',
    })

    for (const key of LAYER_KEYS) {
      new Setting(containerEl)
        .setName(`显示${LAYER_LABELS[key]}`)
        .setDesc(this.describeLayer(key))
        .addToggle((toggle) =>
          toggle.setValue(isLayerVisible(settings.layers, key)).onChange((value) => {
            void this.plugin.setLayerVisible(key, value)
            this.display()
          }),
        )
    }

    new Setting(containerEl)
      .setName('显示图例')
      .setDesc(
        '在画布右下角显示图例。内容由地图上**实际有的**地形、路径、区域生成（不是固定清单），' +
          '所以它永远与画面一致；工具条上也有一个「图例」按钮。',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.showLegend).onChange((value) => {
          void this.plugin.setShowLegend(value)
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

  /** 每个图层的说明：写清"关掉之后你会看到什么"，而不是复述开关名字 */
  private describeLayer(key: LayerKey): string {
    switch (key) {
      case 'terrain':
        return '六边形地形底色与图形。关掉后只剩矢量元素（路径/区域/标记），文档里的格子不受影响。'
      case 'grid':
        return '六边形网格线。与上面的「显示六边形网格」是同一个开关。'
      case 'regions':
        return '半透明区域填充与边框（国境、领地）。'
      case 'paths':
        return '河流、道路、贸易路线、边界。'
      case 'markers':
        return '标记与文字标注（画布上可点击、可拖动的那些实体）。'
      case 'labels':
        return '路径与区域的名称标注。工具条上的「名称」按钮切换的是同一个值。'
    }
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
        '自定义地形会出现在画布工具条里（内置 9 种之后）。每条有两种模式：' +
        '「调色」只用颜色 + 字形（不依赖任何外部资源），「图片」用库内的一张图片' +
        '（图片加载失败时回退到颜色 + 字形）。ID 是写进地图文件的值（形如 custom:swamp2）——' +
        '显示名随时可以改，不影响已经画好的格子；反过来，删掉某个地形也不会删掉地图上的格子，' +
        '那些格子会变成回退样式（灰色菱形）并保留在文件里。',
    })

    settings.customTerrains.forEach((terrain, index) => {
      // ---- 模式：两选一 ----
      // 放在这一条的最上面：它决定下面显示哪些字段，用户得先知道自己在哪种模式里。
      // 刻意不用 Setting 的控件区（那些是给"一个字段"用的），而是自己搭一行两个按钮 ——
      // 分段控件要能看出"当前选的是哪个"，这与"点一下就执行"的按钮语义不同。
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
          // 只改模式：其余字段原样带着走（见 main.ts 的 updateCustomTerrain），
          // 所以来回切不会丢配置 —— 切回图片模式时之前选的图还在。
          void this.plugin.updateCustomTerrain(index, { mode: option.mode }).then(() => this.display())
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
          button.setButtonText('删除').onClick(() => {
            void this.plugin.removeCustomTerrain(index)
            this.display()
          }),
        )

      if (!imageMode) {
        // 调色模式：显示字形。
        //
        // ⚠️ 这里曾经在显示完字形后直接 `return` —— 结果是**图片那一栏连入口都不渲染**，
        // 用户实测反馈"没有看到图片导入按钮"。「当前模式用不到的字段不显示」这条做过了头：
        // **用户找不到入口，就等于这个功能不存在**。现在图片那一栏始终渲染（见下面），
        // 调色模式下点它还会自动把模式切过去 —— 一次点击到位。
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
                // 路径不合法就地提示，并且**不写进设置**（否则绘制层每帧都要处理一个坏路径）
                this.setNoteText(`图片路径不可用：${check.problem}`)
                return
              }
              // 填了图片路径的意图是明确的：顺手把模式切过去，否则用户会以为"填了没反应"
              // （调色模式下图片本来就不参与绘制）。
              const next: { imagePath: string; mode?: CustomTerrainMode } = { imagePath: check.path }
              if (!imageMode && check.path.length > 0) next.mode = 'image'
              void this.plugin.updateCustomTerrain(index, next)
              this.setNoteText('')
            }),
        )
        .addButton((button) =>
          button.setButtonText('从库中选择…').onClick(() => {
            // 手打输入框保留在上面：有人就是习惯粘贴路径，两条路都通。
            // 选择器只列**校验会接受的**图片（白名单同源，见 assetFiles.ts），
            // 所以这里再校验一次只是兜底 —— 真出现不合法，说明两处白名单分叉了，必须说出来。
            //
            // 调色模式下点这个按钮要**先切模式**：用户点"选图片"就是想要图片，
            // 让他先去点一下上面的分段控件是多余的摩擦（而且他很可能根本找不到）。
            const ensureImageMode = imageMode
              ? Promise.resolve()
              : this.plugin.updateCustomTerrain(index, { mode: 'image' }).then(() => {
                  this.display()
                })
            void ensureImageMode
              .then(() =>
                this.plugin.pickImageFile({
                  title: `选择「${terrain.label}」的图片`,
                  onChoose: (path) => {
                    const check = checkTerrainImagePath(path)
                    if (check.problem.length > 0) {
                      this.setNoteText(`图片路径不可用：${check.problem}`)
                      return
                    }
                    void this.plugin
                      .updateCustomTerrain(index, { imagePath: check.path })
                      .then(() => {
                        // 顺序要紧：`display()` 会重建提示行，所以提示必须写在重绘**之后**，
                        // 否则那句话刚写上去就被冲掉了（用户只会看到"点了没反应"）。
                        this.display()
                        this.setNoteText(`已选择图片：${check.path}`)
                      })
                      .catch((error: unknown) => {
                        // 不吞异常：重绘失败时用户看到的是"点了没反应"，而真相只有控制台知道。
                        console.error('[project-kaki] 选择图片后刷新设置页失败', error)
                        this.setNoteText(
                          `图片已设置，但设置页刷新失败：${error instanceof Error ? error.message : String(error)}（重新打开设置页即可看到新值）`,
                        )
                      })
                  },
                }),
              )
              .catch((error: unknown) => {
                console.error('[project-kaki] 切换到图片模式失败', error)
                this.setNoteText(`切换到「图片」模式失败：${error instanceof Error ? error.message : String(error)}`)
              })
          }),
        )
    })

    // ---- 新建 ----
    const atLimit = settings.customTerrains.length >= MAX_CUSTOM_TERRAINS
    const note = containerEl.createEl('div', { cls: 'fc-settings-note', text: '' })
    this.noteEl = note
    const pending: { id: string; label: string; color: string; glyph: string; imagePath: string; mode: CustomTerrainMode } = {
      id: '',
      label: '',
      color: DEFAULT_CUSTOM_TERRAIN_COLOR,
      glyph: '',
      imagePath: '',
      // 新建默认「调色」：不依赖任何外部资源，最不容易失败；想用图片建好之后切一下即可
      mode: DEFAULT_CUSTOM_TERRAIN_MODE,
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
