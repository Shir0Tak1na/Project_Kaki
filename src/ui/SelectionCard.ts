/**
 * 画布上的**选择信息卡**（右上角）—— 施工文件 §C.4 / §F.3。
 *
 * 与工具条同一条挂载策略：挂在 `wrapperEl` 里（它的 transform 是 none，不随画布缩放），
 * 所以卡片尺寸恒定、位置固定。内容模型来自纯函数 `render/selectionCard.ts`，
 * 这里只负责**排版与刷新**。
 *
 * 三条纪律：
 * 1. **只做进行中的事**（§2.6）：框选拖动中给统计、不拖动时给**悬停读数**，两样都没有就整张收起。
 *    已确定的选择归侧栏「数据显示」（那是"选择"的唯一家）—— 这里再用 `is-empty` 切 `display`，
 *    而不是把元素删了重建（重建会让每次点击都动 DOM）；
 * 2. `refresh()` **每次现读**编辑器（`getCellSelection` / `isCellDragging` / `selectionSummary`）：
 *    与仓库里其它浮层一样，卡片不存第二份状态（§5.12）；
 * 3. 读数一律来自 `formatFieldReading`（与画布、图例同一条），所以"换成千米"卡片也跟着变。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import type { MapEditor } from '../editor/MapEditor.ts'
import type { HoverReadout } from '../editor/selection.ts'
import type { CellSelection } from '../render/selectionSet.ts'
import { buildSelectionCard, type SelectionCardModel } from '../render/selectionCard.ts'
import type { OverlayStyles } from '../render/overlayFields.ts'

export interface SelectionCardOptions {
  editor: MapEditor
  /** 当前文档（每帧现读；`null` = 还没加载出来） */
  getDocument: () => MapDocument | null
  /** 数值图层样式（决定读数的展示单位） */
  getOverlayStyles: () => OverlayStyles
  /** 地形 / 生物群系的显示名解析（与检查器读同一份目录） */
  terrainLabel: (id: string) => string
  biomeLabel: (id: string) => string
  /**
   * 当前的**悬停读数**（§2.6：命中对象报对象名、否则报格读数）。
   *
   * 由交互层（`MapInteraction` → `MapLayerManager`）现读注入：卡片不认识指针与画布。
   * 缺省 = 永远没悬停（老宿主 / 测试桩行为不变）。
   */
  getHover?: () => HoverReadout
}

export class SelectionCard {
  private readonly options: SelectionCardOptions
  private readonly root: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly bodyEl: HTMLElement
  /** 上一次渲染的**内容签名**：没变就不动 DOM（点击一下地图不该重建整张卡片） */
  private signature = ''

  constructor(container: HTMLElement, options: SelectionCardOptions) {
    this.options = options
    const doc = container.ownerDocument ?? globalThis.document

    this.root = doc.createElement('div')
    this.root.className = 'fc-selection-card is-empty'
    this.root.dataset.fcSelectionCard = 'root'

    this.titleEl = doc.createElement('div')
    this.titleEl.className = 'fc-selection-card-title'
    this.titleEl.dataset.fcSelectionCard = 'title'
    this.root.appendChild(this.titleEl)

    this.bodyEl = doc.createElement('div')
    this.bodyEl.className = 'fc-selection-card-body'
    this.bodyEl.dataset.fcSelectionCard = 'body'
    this.root.appendChild(this.bodyEl)

    container.appendChild(this.root)
    this.refresh()
  }

  getElement(): HTMLElement {
    return this.root
  }

  /** 现读编辑器并重绘（选中变化 / 状态变化时由地图层调用） */
  refresh(): void {
    /**
     * 「只做进行中的事」（§2.6）：**只有框选拖动中才把格选择交给卡片**。
     * 抬手之后选择就"确定了"，那一份归侧栏；卡片此时只显示悬停读数（或收起）。
     */
    const dragging = this.options.editor.isCellDragging()
    const selection: CellSelection = dragging ? this.options.editor.getCellSelection() : []
    const model = buildSelectionCard({
      cellSelection: selection,
      hover: this.options.getHover?.() ?? { kind: 'none' },
      summary: dragging ? this.options.editor.selectionSummary() : null,
      document: this.options.getDocument(),
      styles: this.options.getOverlayStyles(),
      terrainLabel: this.options.terrainLabel,
      biomeLabel: this.options.biomeLabel,
    })

    const signature = JSON.stringify(model)
    if (signature === this.signature) return
    this.signature = signature

    this.root.classList.toggle('is-empty', model.kind === 'empty')
    if (model.kind === 'empty') {
      this.titleEl.textContent = ''
      this.bodyEl.empty()
      return
    }
    this.render(model)
  }

  private render(model: Exclude<SelectionCardModel, { kind: 'empty' }>): void {
    this.titleEl.textContent = model.title
    this.bodyEl.empty()
    const doc = this.root.ownerDocument ?? globalThis.document
    for (const row of model.rows) {
      const line = doc.createElement('div')
      line.className = 'fc-selection-card-row'
      line.dataset.fcSelectionCard = 'row'
      const label = doc.createElement('span')
      label.className = 'fc-selection-card-label'
      label.textContent = row.label
      const value = doc.createElement('span')
      value.className = 'fc-selection-card-value'
      value.textContent = row.value
      line.append(label, value)
      this.bodyEl.appendChild(line)
    }
  }

  destroy(): void {
    this.root.remove()
  }
}