/**
 * 标记与文字标注层（DOM）。
 *
 * 之所以不用 canvas（设计文档 ADR-3）：标记需要 hover 提示、点击打开笔记、可访问性，
 * 而且文字要让浏览器来排版与抗锯齿。它们挂在**未变换**的 wrapperEl 上，
 * 每帧由 `buildPlacements()` 算出屏幕坐标（billboard），因此字号恒定、不随缩放糊掉。
 *
 * 与绘制模式的边界：绘制模式下整层 `pointer-events: none` ——
 * 此时点击的意思是"在这里放一个新标记"，而不是"打开已有标记的链接"。
 * 切回选择模式后标记才可以点（打开链接）与右键删除。
 */

import { getIcon, setIcon } from 'obsidian'
import type { MarkerPlacement } from './markerPlacement.ts'
import { lucideIconFor } from './markerPlacement.ts'

export interface MarkerLayerOptions {
  host: HTMLElement
  /** 点击带链接的标记 */
  onOpenLink: (link: string) => void
  /** 右键删除 */
  onDelete: (placement: MarkerPlacement) => void
  /**
   * 拖动移动。回调给的是**客户端坐标**，由上层换算成世界坐标
   * （本层不该知道画布的内部坐标系统）。
   */
  onDragStart?: (placement: MarkerPlacement, client: { x: number; y: number }) => void
  onDragMove?: (client: { x: number; y: number }) => void
  onDragEnd?: (client: { x: number; y: number }) => void
  onDragCancel?: () => void
  /** 注入图标校验（测试用；默认用 obsidian 的 getIcon） */
  hasIcon?: (name: string) => boolean
}

/** 超过这个位移才算拖动（与放置时的点击判定共用同一阈值语义） */
const DRAG_SLOP_PX = 4

interface LayerEntry {
  kind: 'marker' | 'label'
  root: HTMLElement
  iconEl: HTMLElement | null
  labelEl: HTMLElement | null
  /** 已应用的图标名，避免每帧重复设置 */
  appliedIcon: string | null
}

interface DragState {
  id: string
  pointerId: number
  start: { x: number; y: number }
  moved: boolean
}

export class MarkerLayer {
  private readonly options: MarkerLayerOptions
  private readonly container: HTMLElement
  private readonly entries = new Map<string, LayerEntry>()
  /** id → 最近一次同步的 placement（右键删除与拖动时需要完整数据） */
  private readonly currentPlacement = new Map<string, MarkerPlacement>()
  private dragState: DragState | null = null
  /** 刚拖动完的那个 id：抑制紧随其后的 click（否则拖一下会顺带打开笔记） */
  private suppressClickId: string | null = null
  private interactive = false
  /** 图层可见性（与"有没有标记"是两件事，见 setVisible） */
  private visible = true
  private destroyed = false

  constructor(options: MarkerLayerOptions) {
    this.options = options
    const doc = options.host.ownerDocument ?? globalThis.document

    this.container = doc.createElement('div')
    this.container.className = 'fc-marker-layer'
    this.container.style.pointerEvents = 'none'
    options.host.appendChild(this.container)
  }

  getElement(): HTMLElement {
    return this.container
  }

  /**
   * 选择模式下实体可交互（打开链接 / 右键删除 / 拖动移动）。
   *
   * ⚠️ 只切**容器上的 class**，绝不把容器设成 `pointer-events: auto`：
   * 容器铺满整个视口，一旦可命中就会挡住原生画布的点选与拖拽。
   * 由 CSS 决定"仅实体元素可点"。
   */
  setInteractive(interactive: boolean): void {
    this.interactive = interactive
    this.container.classList.toggle('is-interactive', interactive)
  }

  isInteractive(): boolean {
    return this.interactive
  }

  /**
   * 整层显示/隐藏（图层开关用）。
   *
   * 为什么切容器的 `display` 而不是"把可见集清空"（`sync([])`）：
   * 清空会把每个标记的 DOM 真的销毁掉，重新打开图层时又要逐个重建 ——
   * 而图层开关的含义是"看不看"，不是"有没有"。DOM 留着，回来时一帧内就恢复原样。
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.container.style.display = visible ? '' : 'none'
  }

  isVisible(): boolean {
    return this.visible
  }

  /** 按当前的可见集合同步 DOM：新增、更新、移除 */
  sync(placements: MarkerPlacement[]): void {
    if (this.destroyed) return
    const seen = new Set<string>()

    for (const placement of placements) {
      seen.add(placement.id)
      let entry = this.entries.get(placement.id)
      if (!entry || entry.kind !== placement.kind) {
        if (entry) this.removeEntry(placement.id, entry)
        entry = this.createEntry(placement)
        this.entries.set(placement.id, entry)
      }
      this.updateEntry(entry, placement)
    }

    for (const [id, entry] of [...this.entries]) {
      if (!seen.has(id)) this.removeEntry(id, entry)
    }
  }

  /** 当前挂载的元素数量（诊断与测试用） */
  size(): number {
    return this.entries.size
  }

  destroy(): void {
    this.destroyed = true
    for (const [id, entry] of [...this.entries]) this.removeEntry(id, entry)
    this.container.remove()
  }

  // ------------------------------------------------------------ 内部

  private createEntry(placement: MarkerPlacement): LayerEntry {
    const doc = this.container.ownerDocument ?? globalThis.document
    const root = doc.createElement('div')

    if (placement.kind === 'marker') {
      root.className = 'fc-marker'
      const iconEl = doc.createElement('div')
      iconEl.className = 'fc-marker-icon'
      const labelEl = doc.createElement('span')
      labelEl.className = 'fc-marker-label'
      root.append(iconEl, labelEl)
      this.container.appendChild(root)
      this.attachInteraction(root, placement.id)
      return { kind: 'marker', root, iconEl, labelEl, appliedIcon: null }
    }

    root.className = 'fc-label'
    this.container.appendChild(root)
    this.attachInteraction(root, placement.id)
    return { kind: 'label', root, iconEl: null, labelEl: root, appliedIcon: null }
  }

  /**
   * 实体上的交互：点击打开链接、右键删除、按住拖动移动。
   * ⚠️ 标记与文字**必须走同一套**——文字标注曾因为只给标记注册了右键而删不掉。
   */
  private attachInteraction(root: HTMLElement, id: string): void {
    root.addEventListener('click', (event) => {
      event.stopPropagation()
      // 刚拖动过：这次 click 是拖动的副产物，忽略
      if (this.suppressClickId === id) {
        this.suppressClickId = null
        return
      }
      const link = root.dataset.fcLink
      if (link && link.length > 0) this.options.onOpenLink(link)
    })

    root.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const current = this.currentPlacement.get(id)
      if (current) this.options.onDelete(current)
    })

    root.addEventListener('pointerdown', (event: PointerEvent) => {
      if (!this.interactive || event.button !== 0) return
      const current = this.currentPlacement.get(id)
      if (!current) return
      // 不让事件冒泡到画布：拖动标记不应该同时框选/平移
      event.stopPropagation()
      this.dragState = { id, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false }
      try {
        root.setPointerCapture?.(event.pointerId)
      } catch {
        // 指针已被回收时忽略
      }
    })

    root.addEventListener('pointermove', (event: PointerEvent) => {
      const state = this.dragState
      if (!state || state.id !== id || state.pointerId !== event.pointerId) return
      if (!state.moved) {
        const dx = event.clientX - state.start.x
        const dy = event.clientY - state.start.y
        if (Math.hypot(dx, dy) <= DRAG_SLOP_PX) return
        state.moved = true
        const current = this.currentPlacement.get(id)
        if (current) this.options.onDragStart?.(current, { x: state.start.x, y: state.start.y })
      }
      event.preventDefault()
      event.stopPropagation()
      this.options.onDragMove?.({ x: event.clientX, y: event.clientY })
    })

    const finishDrag = (event: PointerEvent, cancelled: boolean): void => {
      const state = this.dragState
      if (!state || state.id !== id || state.pointerId !== event.pointerId) return
      this.dragState = null
      try {
        root.releasePointerCapture?.(event.pointerId)
      } catch {
        // 忽略
      }
      if (!state.moved) return
      event.stopPropagation()
      this.suppressClickId = id
      if (cancelled) this.options.onDragCancel?.()
      else this.options.onDragEnd?.({ x: event.clientX, y: event.clientY })
    }

    root.addEventListener('pointerup', (event: PointerEvent) => finishDrag(event, false))
    root.addEventListener('pointercancel', (event: PointerEvent) => finishDrag(event, true))
  }

  /** id → 最近一次同步的 placement（右键删除时需要完整数据） */
  private updateEntry(entry: LayerEntry, placement: MarkerPlacement): void {
    this.currentPlacement.set(placement.id, placement)

    // 位置用 translate3d（更新走合成层，不触发布局重排）。
    // 锚点：标记是"针"（底边中点落在坐标上），文字是中心对齐。
    // rotate 放在链尾：默认 transform-origin 是元素中心，因此围绕自身旋转。
    const anchor = placement.kind === 'marker' ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)'
    const rotation = placement.kind === 'label' && placement.rotation ? ` rotate(${placement.rotation}deg)` : ''
    entry.root.style.transform = `translate3d(${Math.round(placement.x)}px, ${Math.round(placement.y)}px, 0) ${anchor}${rotation}`
    entry.root.dataset.fcId = placement.id
    if (placement.link) entry.root.dataset.fcLink = placement.link
    else delete entry.root.dataset.fcLink

    if (placement.kind === 'marker') {
      const lucide = lucideIconFor(placement.icon ?? 'town')
      if (entry.appliedIcon !== lucide && entry.iconEl) {
        const available = this.options.hasIcon ? this.options.hasIcon(lucide) : getIcon(lucide) !== null
        if (available) {
          setIcon(entry.iconEl, lucide)
          entry.iconEl.classList.remove('fc-icon-fallback')
        } else {
          // 图标名在本地 Lucide 版本里不存在：退回中性圆点，而不是什么都不画
          entry.iconEl.textContent = ''
          entry.iconEl.classList.add('fc-icon-fallback')
        }
        entry.appliedIcon = lucide
      }
      if (entry.labelEl) entry.labelEl.textContent = placement.label
      if (placement.color) entry.root.style.setProperty('--fc-marker-color', placement.color)
      else entry.root.style.removeProperty('--fc-marker-color')
      entry.root.title = placement.description ?? placement.label
      return
    }

    if (entry.labelEl) entry.labelEl.textContent = placement.label
    entry.root.style.fontSize = `${placement.fontSize ?? 14}px`
    if (placement.color) entry.root.style.color = placement.color
    else entry.root.style.removeProperty('color')
    entry.root.classList.toggle('is-bold', placement.bold === true)
    entry.root.classList.toggle('is-italic', placement.italic === true)
  }

  private removeEntry(id: string, entry: LayerEntry): void {
    entry.root.remove()
    this.entries.delete(id)
    this.currentPlacement.delete(id)
  }
}
