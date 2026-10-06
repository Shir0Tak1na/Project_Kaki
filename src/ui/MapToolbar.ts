/**
 * 地图工具条 —— 现在它是**左上角的状态浮窗**（施工文件 §F.2 / §F.3）。
 *
 * ## 它不再是什么
 *
 * 它原来是"什么都能干"的控制条：模式、工具切换、地形调色板、路径/区域类型、笔刷大小、
 * 数值图层笔刷（层 / 算法 / 数值 / 群系）、选择方式、筛选、撤销/重做、名称与图例开关，
 * 全挤在同一个框里。用户实测报的两条缺陷根因都是这个"一个框扮演好几个角色"：
 * - **ISSUE-002「找不到生物群系笔刷」**：控件确实做了，但长在画布浮窗里，用户找不到；
 * - **ISSUE-004「筛选和绘制在同一个框里，反直觉」**：同一个框按模式换内容却不换身份。
 *
 * 现在：**工具与参数都在侧栏**（`ui/toolSections.ts`），**这里只回答"现在是什么状态"** ——
 * 标题行（这个框属于谁）+ 副行（参数 / 为什么画不动）+ 提示行（下一步能按什么键），
 * 外加两件"随时要用、不该跑去侧栏找"的动作：进入/退出绘制、撤销/重做（§H.1 定的归属）。
 *
 * ## 三条不要动的东西
 *
 * - 挂在 `wrapperEl` 里（它的 transform 是 `none`，因此**不随画布缩放**），
 *   这样按钮尺寸恒定、位置固定；
 * - **标题行必须是第一个子元素**：它回答的是"身份"，要比下面所有控件先被看到（有冒烟钉着）；
 * - 覆盖层永久 `pointer-events: none`，工具条自己不在此列（`styles.css` 里给了 `auto`）。
 */

import type { EditorStatus, EditorTool } from '../editor/MapEditor.ts'
import { listResolvedTerrainStyles, type CustomTerrain } from '../render/terrainCatalog.ts'
import { resolveBiomeStyle } from '../render/biomeCatalog.ts'
import { OVERLAY_FIELDS } from '../render/overlayFields.ts'
import { TOOL_LABELS } from './toolSections.ts'
import { TOOLBAR_TEXT, drawModeHint, drawModeLabel, selectionModeLabel, unknownTypeLabel } from './strings.ts'

export interface MapToolbarOptions {
  editor: MapEditorLike
  /** 进入/退出绘制模式时同步指针策略 */
  onModeChanged: (mode: 'select' | 'paint') => void
  onUndo: () => void
  onRedo: () => void
  /**
   * 用户自定义地形（来自插件设置）。
   *
   * 浮窗降级成状态显示之后，这里**只剩一个用处**：副行要写出当前地形笔刷的中文名
   * （`编辑：地形笔刷 · 森林`）。自定义地形没有名字就会显示成一串 ID，
   * 所以这条依赖不能省 —— 它与"地形调色板"无关，调色板已经搬进侧栏。
   */
  getCustomTerrains?: () => readonly CustomTerrain[]
}

/** 工具条只用到编辑器的这三件事（写窄了接口，免得它又长回一个控制条） */
export interface MapEditorLike {
  getStatus: () => EditorStatus
  toggleMode: () => 'select' | 'paint'
}

export class MapToolbar {
  private readonly options: MapToolbarOptions
  private readonly root: HTMLElement
  private readonly modeButton: HTMLButtonElement
  /**
   * 标题行：**这个浮框属于谁**（ISSUE-004）。
   *
   * 只回答"现在是什么状态"（`空闲` / `绘制 · 地形笔刷` / `选择 · 矩形框选 · 14 格`），
   * **值、原因、细节一律留给副行**（`statusEl`）：两行各司其职，不重复说同一件事。
   */
  private readonly titleEl: HTMLElement
  /**
   * 副行：绘制模式下的**参数或"为什么不能画"**。
   *
   * 文案保持既有口径不变（`编辑：温度笔刷 · ＝12` / `编辑：数值图层笔刷 · 请先填一个数值`），
   * 因为 §E 那三条硬口径与它们的断言都挂在这一行上。
   *
   * 没有额外信息时整行隐藏：选择模式下方式与格数已在标题里，非笔刷工具也没有参数可报 ——
   * 留一行重复的字只会让浮框更长（浮框越长越容易压住画布）。
   */
  private readonly statusEl: HTMLElement
  /** 提示行：下一步能按什么键 / 去哪里找那些已经搬进侧栏的控件 */
  private readonly hintEl: HTMLElement
  private readonly undoButton: HTMLButtonElement
  private readonly redoButton: HTMLButtonElement

  constructor(container: HTMLElement, options: MapToolbarOptions) {
    this.options = options
    const doc = container.ownerDocument ?? globalThis.document

    this.root = doc.createElement('div')
    this.root.className = 'fc-toolbar'

    // 标题行放在**最前**且整行：它是这个框的名字（ISSUE-004），必须比所有控件先被看到
    this.titleEl = doc.createElement('div')
    this.titleEl.className = 'fc-toolbar-title'
    this.titleEl.dataset.fcToolbarTitle = '1'
    this.root.appendChild(this.titleEl)

    // 模式按钮：进入 / 退出绘制。它是**状态 + 唯一的模式入口**，
    // 工具怎么选、笔刷刷什么都在侧栏（见文件头）。
    this.modeButton = doc.createElement('button')
    this.modeButton.className = 'fc-ctl-button fc-toolbar-mode'
    this.modeButton.addEventListener('click', () => {
      const mode = options.editor.toggleMode()
      options.onModeChanged(mode)
      this.refresh()
    })
    this.root.appendChild(this.modeButton)

    // 撤销 / 重做（§H.1：放在浮窗里，不必跑去侧栏）
    const historyGroup = doc.createElement('div')
    historyGroup.className = 'fc-toolbar-group'
    this.undoButton = doc.createElement('button')
    this.undoButton.className = 'fc-ctl-button'
    this.undoButton.title = '撤销（Ctrl/Cmd+Z）'
    this.undoButton.addEventListener('click', () => {
      options.onUndo()
      this.refresh()
    })
    this.redoButton = doc.createElement('button')
    this.redoButton.className = 'fc-ctl-button'
    this.redoButton.title = '重做（Ctrl/Cmd+Shift+Z）'
    this.redoButton.addEventListener('click', () => {
      options.onRedo()
      this.refresh()
    })
    historyGroup.append(this.undoButton, this.redoButton)
    this.root.appendChild(historyGroup)

    this.hintEl = doc.createElement('div')
    this.hintEl.className = 'fc-toolbar-hint'
    this.root.appendChild(this.hintEl)

    this.statusEl = doc.createElement('div')
    this.statusEl.className = 'fc-toolbar-status'
    this.statusEl.dataset.fcToolbarStatus = '1'
    this.root.appendChild(this.statusEl)

    container.appendChild(this.root)
    this.refresh()
  }

  getElement(): HTMLElement {
    return this.root
  }

  /**
   * 标题行：这个框"现在属于谁"（ISSUE-004）。
   *
   * 三种说法，与副行严格分工（**不重复说同一件事**）：
   * - 绘制模式 → `绘制 · 地形笔刷` / `绘制 · 数值图层笔刷` / `绘制 · 路径`；
   * - 选择模式且有选择 → `选择 · 矩形框选 · 12 格`；
   * - 选择模式且没有选择 → `空闲`。
   *
   * 数值图层笔刷刻意只写到「数值图层笔刷」这一层：**具体是哪一层在副行里说**
   * （`编辑：温度笔刷 · ＝12`）—— 否则标题与副行会把同一个词写两遍。
   */
  private titleLine(status: EditorStatus, painting: boolean): string {
    if (!painting) {
      const count = status.cellSelection.length
      if (count === 0) return TOOLBAR_TEXT.idle
      return TOOLBAR_TEXT.selection(selectionModeLabel(status.selectionMode), count)
    }
    if (status.tool === 'brush') {
      return status.brushField === null ? TOOLBAR_TEXT.paintTerrainBrush : TOOLBAR_TEXT.paintFieldBrush
    }
    return TOOLBAR_TEXT.paintTool(TOOL_LABELS[status.tool].label)
  }

  /**
   * 副行：绘制模式下的**参数**（或"为什么现在画不出来"）。
   *
   * 地形显示名从**当前目录**现取（自定义地形也有名字），取不到就退回 ID —— 不显示空白。
   */
  private detailLine(status: EditorStatus, painting: boolean): string {
    // 只有笔刷工具才有"参数"可报；其余工具的标题已经写明工具名
    if (!painting || status.tool !== 'brush') return ''
    if (status.brushField !== null) {
      const spec = OVERLAY_FIELDS.find((item) => item.id === status.brushField)
      const label = spec?.label ?? status.brushField
      if (spec !== undefined && !spec.numeric) {
        const entry = status.brushBiome.length > 0 ? resolveBiomeStyle(status.brushBiome, []).label : '（未选）'
        return TOOLBAR_TEXT.categoryBrush(label, entry)
      }
      const value = status.brushValue === null ? '（未填）' : status.brushValue
      return TOOLBAR_TEXT.fieldBrush(label, TOOLBAR_TEXT.brushOpLabel(status.brushOp), value)
    }
    const terrain =
      listResolvedTerrainStyles(this.options.getCustomTerrains?.() ?? []).find(
        (style) => style.id === status.terrainType,
      )?.label ?? status.terrainType
    return TOOLBAR_TEXT.terrainBrush(terrain)
  }

  /**
   * 提示行：**下一步能按什么键、那些控件现在长在哪里**。
   *
   * 控件搬进侧栏之后，"去哪里改"这件事必须在浮窗里说一句 ——
   * 否则 ISSUE-002（找不到笔刷）会以另一种形式复发：功能还在，但没人知道它在侧栏。
   */
  private hintLine(status: EditorStatus, painting: boolean): string {
    if (!painting) {
      const count = status.cellSelection.length
      return count > 0
        ? `已选 ${count} 格 · 左键拖动=${selectionModeLabel(status.selectionMode)} · Shift 加选 / Alt 取消 · Esc 清空`
        : '按 D 进入绘制模式 · 左键拖动框选一片格（方式在侧栏「选择方式」）· 双击路径/区域可重命名'
    }
    if (status.tool === 'brush') {
      return '左键描绘 · 1-9 换地形 · [ ] 调笔刷 · 刷什么/半径在侧栏「笔刷」· Esc 退出'
    }
    if (status.tool === 'marker') return '左键点击放置标记（图标在侧栏「工具」）· 选择模式下可点开笔记 / 拖动 / 右键删除'
    if (status.tool === 'label') return '左键点击放置文字标注 · 选择模式下可拖动移动 / 右键删除'
    const shape = status.tool === 'path' ? '路径' : '区域'
    // 提示里带上当前绘制模式与它的画法差异 —— 四种模式的点击含义不同，
    // 不写出来用户只能靠试。名称与提示都从 strings.ts 取（单一来源）。
    const modeLabel = drawModeLabel(status.geometryMode)
    const modeHint = drawModeHint(status.geometryMode)
    // 自由绘制没有"已定 N 个顶点"这回事（轨迹点是采样），也不能说"双击结束"——
    // 它的结束方式是**松开左键**，写错会让用户以为要双击。
    if (status.geometryMode === 'free') {
      return status.draftPoints > 0
        ? `${shape}（${modeLabel}）：按住左键拖动随手画 · 松开即完成 · Esc 取消`
        : `${shape}（${modeLabel}）：${modeHint} · 按住左键拖动，松开完成 · 类型/绘制模式在侧栏「工具」`
    }
    return status.draftPoints > 0
      ? `${shape}（${modeLabel}）：已定 ${status.draftPoints} 个顶点 · 双击/回车/右键结束 · Esc 取消`
      : `${shape}（${modeLabel}）：${modeHint} · 类型/绘制模式在侧栏「工具」· 双击或回车结束`
  }

  /** 按编辑器当前状态刷新文案与可用性（工具条只剩状态与两个动作，所以很短） */
  refresh(): void {
    const status: EditorStatus = this.options.editor.getStatus()
    const painting = status.mode === 'paint'

    this.modeButton.textContent = painting ? '● 绘制中' : '选择'
    this.modeButton.classList.toggle('is-active', painting)
    this.modeButton.title = painting ? '退出绘制模式（Esc）' : '进入绘制模式（D）'

    this.titleEl.textContent = this.titleLine(status, painting)
    const detail = this.detailLine(status, painting)
    this.statusEl.textContent = detail
    this.statusEl.style.display = detail.length === 0 ? 'none' : ''

    // §E 第 2 条：笔刷不可用时把**原因**写在状态行里（用户不该靠猜"为什么刷不动"）。
    // ⚠️ 顺序：必须在上面的 detail 之后覆盖 —— 这行原因比"当前参数"更重要。
    // 侧栏「笔刷」一节下方也写了同一句（控件在那里，原因就该在那里看得见）。
    if (painting && status.tool === 'brush' && status.brushField !== null && !status.brushReady.ok) {
      this.statusEl.textContent = TOOLBAR_TEXT.fieldBrushBlocked(status.brushReady.reason)
      this.statusEl.style.display = ''
    }

    this.undoButton.disabled = status.undo === 0
    this.redoButton.disabled = status.redo === 0
    this.undoButton.textContent = `撤销${status.undo > 0 ? ` (${status.undo})` : ''}`
    this.redoButton.textContent = `重做${status.redo > 0 ? ` (${status.redo})` : ''}`

    this.hintEl.textContent = this.hintLine(status, painting)
  }

  destroy(): void {
    this.root.remove()
  }
}
