/**
 * 插件设置。
 *
 * 目前只有一项：名称字号倍率。
 *
 * 为什么把它做成设置而不是写死常量：名称大小是**纯视觉偏好**，
 * 而且我无法从代码里判断"多大才够看"（真实反馈连续两轮都说小）。
 * 与其再来回改常量，不如把旋钮交给用户 —— 拖一下就能看到效果，不必等重新构建。
 */

import { PluginSettingTab, Setting, type App } from 'obsidian'
import type ProjectKakiPlugin from '../main.ts'

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
}

export const DEFAULT_SETTINGS: CartographerSettings = {
  labelScale: 1,
  showGrid: true,
  developerMode: false,
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

export class CartographerSettingTab extends PluginSettingTab {
  private readonly plugin: ProjectKakiPlugin

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

    new Setting(containerEl)
      .setName('地图面板')
      .setDesc('常用命令都在右侧边栏的「地图面板」里，不必每次翻命令面板。')
      .addButton((button) =>
        button.setButtonText('打开面板').onClick(() => {
          void this.plugin.activatePanel()
        }),
      )
  }
}
