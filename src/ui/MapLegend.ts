/**
 * 画布上的图例（右下角一块小面板）。
 *
 * 三条约束，都是这个项目已经付过代价换来的：
 *
 * 1. **不每帧重建 DOM**。图例内容只跟"地图内容 + 样式设置 + 图层开关"有关，跟视口无关；
 *    所以刷新由"文档变化 / 设置变化"触发，而不是跟着每帧重绘走
 *    （侧边栏面板曾经每帧重建 DOM，表现就是发卡）。
 * 2. **原地更新**：内容变了也只在签名不匹配时重建，避免整块闪一下。
 * 3. **条目由调用方给**（`LegendEntry[]`），本类不认识地图数据结构 ——
 *    "从实际内容生成条目"是纯函数 `buildLegendEntries` 的事（那边有单测），
 *    这里只管画出来，薄到不需要单测也能看懂。
 *
 * 只用 Obsidian 惯用的 DOM 帮助方法（`empty` / `createEl` / `dataset` / `setText`），
 * 不用 `firstChild` / `setAttribute` 这类写法：测试里的假 DOM 是照着"插件实际用到的 API"
 * 复刻的，用没被复刻的 API 会让这一层在测试里直接炸掉，而炸掉的位置与真实原因毫无关系。
 *
 * 默认**隐藏**：图例是"要看的时候才看"的东西，不该默认占着画布。
 */

import type { LegendEntry } from '../render/legend.ts'

export interface MapLegendOptions {
  /** 隐藏/显示状态由外部持有（设置或工具条按钮），这里只问 */
  getVisible?: () => boolean
}

export class MapLegend {
  private readonly options: MapLegendOptions
  private readonly root: HTMLElement
  private readonly listEl: HTMLElement
  /** 上次渲染的签名：内容没变就不动 DOM */
  private lastSignature: string | null = null

  constructor(container: HTMLElement, options: MapLegendOptions = {}) {
    this.options = options
    this.root = container.createEl('div', { cls: 'fc-legend' })
    this.root.style.display = 'none'
    this.root.createEl('div', { cls: 'fc-legend-title', text: '图例' })
    this.listEl = this.root.createEl('div', { cls: 'fc-legend-list' })
  }

  getElement(): HTMLElement {
    return this.root
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none'
  }

  isVisible(): boolean {
    return this.root.style.display !== 'none'
  }

  /** 外部状态（设置/按钮）变化后同步一次可见性 */
  syncVisibility(): void {
    this.setVisible(this.options.getVisible?.() ?? false)
  }

  /**
   * 用一批条目刷新图例。
   *
   * 签名包含顺序：条目顺序是确定的（内置在前），顺序真的变了说明地图内容变了，那时重建才对。
   */
  refresh(entries: readonly LegendEntry[]): void {
    const signature = entries.map((entry) => `${entry.kind}|${entry.label}|${entry.color}|${entry.count}`).join(';')
    if (signature === this.lastSignature) return
    this.lastSignature = signature
    this.listEl.empty()

    if (entries.length === 0) {
      this.listEl.createEl('div', { cls: 'fc-legend-empty', text: '地图上还没有可列出的内容' })
      return
    }

    for (const entry of entries) {
      const row = this.listEl.createEl('div', { cls: 'fc-legend-row' })
      // 用 dataset 而不是 setAttribute：假 DOM 如实复刻了 dataset
      row.dataset.kind = entry.kind

      const swatch = row.createEl('span', { cls: 'fc-legend-swatch' })
      swatch.style.backgroundColor = entry.color
      // 虚线路径（道路/边界）在色块上也要能看出来，否则和河流长得一样
      if (entry.dash && entry.dash.length > 0) {
        const dash = dashCss(entry.color, entry.dash)
        if (dash.length > 0) swatch.style.backgroundImage = dash
      }

      row.createEl('span', { cls: 'fc-legend-label', text: entry.label })
      row.createEl('span', { cls: 'fc-legend-count', text: `${entry.count}` })
    }
  }

  destroy(): void {
    const parent = this.root.parentNode
    if (parent && typeof parent.removeChild === 'function') parent.removeChild(this.root)
  }
}

/**
 * 把虚线数组（世界单位）换成一段 `repeating-linear-gradient`。
 *
 * 一整个 dash 周期在色块上约 12px：色块本身只有十几像素宽，
 * 直接用世界单位会得到"全实心"或"全透明"两种极端，反而看不出区别。
 */
function dashCss(color: string, dash: readonly number[]): string {
  const total = dash.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return ''
  const scale = 12 / total
  const stops: string[] = []
  let cursor = 0
  dash.forEach((segment, index) => {
    const next = cursor + segment * scale
    const paint = index % 2 === 0 ? color : 'transparent'
    stops.push(`${paint} ${cursor.toFixed(2)}px ${next.toFixed(2)}px`)
    cursor = next
  })
  // repeating：最后一站的偏移量就是周期长度，于是"实-空-实-空"能自己循环起来
  return `repeating-linear-gradient(90deg, ${stops.join(', ')})`
}
