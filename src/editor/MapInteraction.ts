/**
 * 指针与快捷键交互。
 *
 * ## 为什么监听在「视图容器」而不是覆盖层上（重要）
 *
 * 覆盖层为了让地形画在原生卡片**下方**，被插成了 `div.canvas` 的第一个子元素。
 * 但 **DOM 的绘制顺序与命中测试顺序是同一个** —— 覆盖层同时也是最底层，
 * 指针事件会优先落到它上面的元素（边层 SVG、节点、以及带框选处理的 canvas 元素）上。
 * 因此"把覆盖层设成 pointer-events: auto 来接收绘制手势"从根上就是错的：
 * 只能在启动时偶然收到一次事件，拖动过程中的 pointermove 根本收不到。
 *
 * 现在的做法：
 * 1. 在**视图容器**（`view.containerEl`，比 `wrapperEl` 和 canvas 元素都高）上，
 *    用**捕获阶段**监听 `pointerdown` —— 捕获阶段自外向内，因此我们的处理先于 Obsidian；
 * 2. **插件工具激活时**（绘制模式，或选择模式的左键）对左键 `stopPropagation()`：
 *    原生框选/拖拽一启动就被拦下；
 * 3. 用 `setPointerCapture` 把整条手势交给自己，拖动中的 `pointermove` 稳定到达；
 * 4. 其余按键（中键/右键）**不拦**，原生平移照旧；滚轮也完全不碰 ——
 *    选择模式同样如此（§C.1 硬纪律：插件永不接管右键 / 中键 / 滚轮 / 空格拖动）；
 * 5. **标记 / 名称元素上的左键放行**（它们排在 `getUiExclusions` 里）：那一层自己有
 *    打开笔记 / 拖动移动的手势，在捕获阶段吞掉它会让"点标记"彻底失灵。
 *
 * 覆盖层的 `pointer-events` 始终保持 `none`，它只负责画。
 *
 * ## 快捷键
 *
 * 用 Obsidian 的 `Scope` 挂在作用域栈上，并且**只在 canvas 成为活动视图时位于栈顶** ——
 * 否则 `Mod+Z` 会与当前获得焦点的编辑器抢（编辑器的撤销更接近用户预期）。
 * 工具条上的按钮不依赖焦点，任何情况下都可用，是这些操作的可靠入口。
 */

import { Scope, type App } from 'obsidian'
import { pointerToWorld, readScale, type CanvasHandle } from '../canvas/CanvasAdapter.ts'
import { TERRAIN_TYPES, type TerrainType } from '../data/mapDocument.ts'
import { isClickGesture } from '../render/markerPlacement.ts'
import type { SelectionOperation } from '../render/selectionSet.ts'
import type { HoverReadout } from './selection.ts'
import type { EditorTool, MapEditor } from './MapEditor.ts'

export interface MapInteractionOptions {
  app: App
  handle: CanvasHandle
  editor: MapEditor
  /**
   * 捕获阶段监听的宿主：应当是包含 canvas 元素的视图容器。
   * 越靠上越能保证我们的处理先于 Obsidian。
   */
  getHost: () => HTMLElement | null
  /**
   * 位于宿主内、但**不应被拦截**的 UI 元素（我们的工具条等）。
   * ⚠️ 必须提供：工具条也在同一个视图容器里，若不过滤，
   * 捕获阶段的 stopImmediatePropagation 会把点击直接吃掉，按钮完全点不动。
   */
  getUiExclusions?: () => Array<HTMLElement | null>
  /** 悬停预览（高亮笔刷落点），传 null 清除 */
  onHover: (hover: { x: number; y: number; radius: number } | null) => void
  /**
   * 悬停**读数**（§2.6）：指针下面是什么（命中对象报对象名、否则报格读数）。
   *
   * 与 `onHover`（笔刷落点高亮，只在绘制模式下有意义）分开：这一条在**选择模式**下工作，
   * 是"信息卡只做进行中的事"里那件"进行中"的事。读数的**计算**在编辑器里
   * （命中顺序与点击同一套），这里只负责"指针动了 / 离开了"。
   */
  onHoverReadout?: (readout: HoverReadout) => void
  onModeChanged: (mode: 'select' | 'paint') => void
  /** 请求在某个世界坐标放置标记 / 文字标注（由上层弹对话框并写入文档） */
  onPlaceRequest?: (tool: 'marker' | 'label', world: { x: number; y: number }) => void
  /** 右键删除了某个形状（用于提示） */
  onShapeDeleted?: (hit: { kind: 'path' | 'region'; id: string }) => void
  /** 形状绘制完成（用于提示命名） */
  onShapeCreated?: (shape: { kind: 'path' | 'region'; id: string }) => void
  /** 请求重命名（选择模式下双击形状） */
  onShapeRenameRequest?: (hit: { kind: 'path' | 'region'; id: string }) => void
}

/** 多点工具的共用手势判定（类型守卫，便于后续窄化 tool） */
function isMultiPointTool(tool: EditorTool): tool is 'path' | 'region' {
  return tool === 'path' || tool === 'region'
}

/** 双击判定的时间与位移窗口 */
const DOUBLE_CLICK_MS = 350
const DOUBLE_CLICK_SLOP_PX = 8
/** 右键命中形状的容差（屏幕像素） */
const SHAPE_HIT_TOLERANCE_PX = 6
/**
 * "按下 → 抬起"移动多少像素才算**拖动**（而不是点击）。
 *
 * 用**屏幕像素**而不是世界单位：手指/鼠标的抖动是屏幕上的事，与地图缩放无关。
 * 拖动才走框选，没超过阈值就走单击（选中对象 / 加选单格）。
 */
const DRAG_SLOP_PX = 4

/**
 * Obsidian 画布自带的 UI：它们位于 `wrapperEl` 内（与我们的捕获宿主重叠），
 * 必须放行，否则绘制模式下缩放控件与卡片菜单都会点不动。
 */
const CANVAS_UI_SELECTORS = [
  '.canvas-controls',
  '.canvas-card-menu',
  '.canvas-menu',
  '.canvas-node-menu',
  '.canvas-selection-menu',
]

/**
 * 事件焦点是否落在可编辑元素上。
 *
 * 我们的快捷键是**无修饰键**的字母（`p` / `r` / `b` …），一旦在输入框里打字就会误触发。
 * Obsidian 的 Modal 会把自己的作用域压到栈顶，但**只注册它用到的键**；
 * 未命中的按键会继续沿作用域栈往下走 —— 也就走到了我们这里。
 * 因此必须在自己的处理器里显式让行（返回 true = 未处理）。
 */
function isEditableTarget(event: unknown): boolean {
  const target = (event as { target?: unknown } | null)?.target
  if (!target || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return element.isContentEditable === true
}

function asElement(value: unknown): HTMLElement | null {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record !== 'object') return null
  return typeof record.addEventListener === 'function' ? (value as HTMLElement) : null
}

export class MapInteraction {
  private readonly options: MapInteractionOptions
  private scope: Scope | null = null
  private listeners: Array<() => void> = []
  private paintingPointerId: number | null = null
  /** 按下时的客户端坐标：用于区分"点击"与"拖动" */
  private downClient: { x: number; y: number } | null = null
  /** 上一次点击（用于双击判定） */
  private lastClickAt: number | null = null
  private lastClickClient: { x: number; y: number } | null = null
  /**
   * 选择模式下的左键手势（按下 → 抬起）。
   *
   * 与绘制手势一样用 `setPointerCapture` 把整条手势握在手里：拖动中才能稳定收到 `pointermove`
   * 并连续更新框选范围（否则指针一离开起始格就没有后续事件了）。
   * `selectDragged` 决定抬手时是"框选"还是"点击"——阈值按**屏幕像素**（见 `DRAG_SLOP_PX`）。
   */
  private selectPointerId: number | null = null
  private selectStartClient: { x: number; y: number } | null = null
  private selectOperation: SelectionOperation = 'replace'
  private selectDragged = false
  private disposed = false

  constructor(options: MapInteractionOptions) {
    this.options = options
  }

  /** 当前是否正在按住左键绘制 */
  isPainting(): boolean {
    return this.paintingPointerId !== null
  }

  attach(): void {
    if (this.disposed) return
    const host = asElement(this.options.getHost())
    if (!host) return

    const insideHost = (event: Event): boolean => {
      const target = event.target as Node | null
      if (target === null) return true
      if (target === host) return true
      return typeof host.contains === 'function' ? host.contains(target) : false
    }

    /** 事件是否落在"不该被拦截"的 UI 上（我们的工具条、Obsidian 的画布控件） */
    const isUiTarget = (event: Event): boolean => {
      const target = event.target as Element | null
      if (!target || typeof target.closest !== 'function') return false
      for (const excluded of this.options.getUiExclusions?.() ?? []) {
        if (!excluded) continue
        if (excluded === target || excluded.contains(target)) return true
      }
      return CANVAS_UI_SELECTORS.some((selector) => target.closest(selector) !== null)
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!insideHost(event)) return
      // UI 上的点击一律放行（工具条按钮、缩放控件、卡片菜单…）
      if (isUiTarget(event)) return

      const editor = this.options.editor
      const world = this.worldFromEvent(event)

      // 用户点到了画布：把按键作用域提到栈顶。
      // 焦点从编辑器挪到画布时 active-leaf-change 不一定触发，靠这一步兜底，
      // 否则 Mod+Z 会落到编辑器而不是地图。
      this.bringScopeToFront()

      // ---- 右键：绘制中结束草稿；选择模式下命中形状则删除 ----
      if (event.button === 2) {
        if (editor.mode === 'paint' && isMultiPointTool(editor.tool) && editor.isDrafting()) {
          swallow(event)
          const created = editor.finishDraft()
          if (created) this.options.onShapeCreated?.(created)
          return
        }
        if (editor.mode === 'select' && world) {
          const scale = readScale(this.options.handle.canvas).scale ?? 1
          const hit = editor.hitTestShape(world, SHAPE_HIT_TOLERANCE_PX / scale)
          if (hit) {
            // 只有真的命中形状才拦截：否则右键菜单应当照常弹出
            swallow(event)
            if (hit.kind === 'path') editor.removePath(hit.id)
            else editor.removeRegion(hit.id)
            this.options.onShapeDeleted?.(hit)
          }
        }
        return
      }

      // ---- 选择模式：**左键归我们**（拖动 = 框选 / 笔迹选择；点击 = 选中对象、加选、取消单格）。
      //      中键 / 右键 / 滚轮 / 空格拖动一概不碰 —— 那是 Canvas 的平移与菜单手势（§C.1 硬纪律）。
      //      双击形状仍然接管：它是重命名的入口 ----
      if (editor.mode === 'select') {
        // 只接管左键：中键留给原生平移
        if (event.button !== 0) return
        if (!world) return
        const now = Date.now()
        /**
         * 双击判定读的是**上一次"完整的点击"**（在 `finish` 里才记），不是"上一次按下"。
         *
         * 为什么必须在抬手时才记：拖动是以 `pointerdown` 开始的，如果按下就记时间，
         * 那么"刚拖完一片、马上又从同一点拖"会被当成双击 → 走进改名分支，
         * 这一次拖动**整段丢失**（画面上看起来就是"拖不动了"）。
         */
        const isDoubleClick =
          this.lastClickAt !== null &&
          now - this.lastClickAt <= DOUBLE_CLICK_MS &&
          this.lastClickClient !== null &&
          Math.hypot(event.clientX - this.lastClickClient.x, event.clientY - this.lastClickClient.y) <= DOUBLE_CLICK_SLOP_PX
        if (isDoubleClick) {
          const scale = readScale(this.options.handle.canvas).scale ?? 1
          const hit = editor.hitTestShape(world, SHAPE_HIT_TOLERANCE_PX / scale)
          if (!hit) return
          this.lastClickAt = null
          this.lastClickClient = null
          swallow(event)
          this.options.onShapeRenameRequest?.(hit)
          return
        }

        /**
         * 按下即接管（`swallow` + `setPointerCapture`）。
         *
         * 这里与"绘制模式"同一条理由：拖动过程中要靠 `pointermove` 连续更新框选范围，
         * 而原生画布的框选一旦启动就会把 `pointermove` 吃掉。
         * **代价是 Obsidian 原生的"左键拉框选卡片"在插件激活时不可用** ——
         * 这是 §C.1 那张表明确选的（左键拖动 = 框选格），不是遗漏。
         */
        swallow(event)
        this.selectPointerId = event.pointerId
        this.selectStartClient = { x: event.clientX, y: event.clientY }
        this.selectOperation = event.altKey ? 'remove' : event.shiftKey ? 'add' : 'replace'
        this.selectDragged = false
        editor.beginCellDrag(world, this.selectOperation)
        try {
          host.setPointerCapture(event.pointerId)
        } catch {
          // 某些环境下指针已被回收，忽略即可（后续靠 pointerup 兜底）
        }
        return
      }

      // 只接管左键：中键留给原生平移
      if (event.button !== 0) return

      // 捕获阶段拦下：原生框选/拖拽不会启动
      swallow(event)

      // 笔刷：按下即开始一笔
      if (editor.tool === 'brush') {
        this.downClient = { x: event.clientX, y: event.clientY }
        this.paintingPointerId = event.pointerId
        try {
          host.setPointerCapture(event.pointerId)
        } catch {
          // 某些环境下指针已被回收，忽略即可（后续靠 pointerup 兜底）
        }
        if (world) editor.beginStroke(world)
        return
      }

      // 路径 / 区域：逐点点击，双击结束
      if (isMultiPointTool(editor.tool)) {
        if (!world) return
        const now = Date.now()
        const isDoubleClick =
          this.lastClickAt !== null &&
          now - this.lastClickAt <= DOUBLE_CLICK_MS &&
          this.lastClickClient !== null &&
          Math.hypot(event.clientX - this.lastClickClient.x, event.clientY - this.lastClickClient.y) <= DOUBLE_CLICK_SLOP_PX
        if (isDoubleClick) {
          this.lastClickAt = null
          this.lastClickClient = null
          const created = editor.finishDraft()
          if (created) this.options.onShapeCreated?.(created)
          return
        }
        this.lastClickAt = now
        this.lastClickClient = { x: event.clientX, y: event.clientY }
        if (editor.isDrafting()) editor.addDraftPoint(world)
        else editor.beginDraft(editor.tool, world)
        return
      }

      // 标记 / 文字：在 pointerup 判定点击（避免拖动误放）
      this.downClient = { x: event.clientX, y: event.clientY }
    }

    const onPointerMove = (event: PointerEvent): void => {
      const editor = this.options.editor

      // 选择模式：拖动 = 框选（矩形 / 笔迹）。只有"这次手势的指针"才处理，
      // 别的指针（例如另一个手指、或原生平移）一律不管。
      // ⚠️ 必须同时确认**还在选择模式**：手势进行中用户可能按了 D 切到绘制模式
      // （或者指针在手势中途被系统回收），这时残留的手势状态会把绘制手势整段吃掉。
      if (this.selectPointerId !== null && this.selectPointerId === event.pointerId) {
        if (editor.mode !== 'select') {
          this.resetSelectGesture()
          return
        }
        const start = this.selectStartClient
        if (start === null) return
        if (!this.selectDragged) {
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_SLOP_PX) return
          this.selectDragged = true
        }
        const world = this.worldFromEvent(event)
        if (!world) return
        event.preventDefault()
        editor.updateCellDrag(world)
        return
      }

      if (editor.mode !== 'paint') {
        /**
         * **选择模式下的悬停读数**（§2.6）：指针下面是什么 —— 命中对象报对象名、
         * 否则报格读数（判定在编辑器里，与点击共用同一套命中顺序）。
         * 指针移出画布时上报 `none`：否则卡片会一直停在最后一次读数上。
         */
        if (!insideHost(event)) {
          this.options.onHoverReadout?.({ kind: 'none' })
          return
        }
        const world = this.worldFromEvent(event)
        if (!world) return
        const scale = readScale(this.options.handle.canvas).scale ?? 1
        this.options.onHoverReadout?.(editor.probeHoverAt(world, SHAPE_HIT_TOLERANCE_PX / scale))
        return
      }

      const world = this.worldFromEvent(event)
      if (!world) return

      // 仍在绘制：不拦事件（原生平移等不受影响），但持续落笔。
      // 绘制中**不做 UI 判定**：指针扫过工具条时笔画不该断。
      if (this.paintingPointerId === event.pointerId) {
        event.preventDefault()
        editor.extendStroke(world)
        return
      }
      if (isUiTarget(event)) return

      // 多点工具：橡皮筋跟随光标
      if (isMultiPointTool(editor.tool)) {
        if (editor.isDrafting()) editor.updateDraftCursor(world)
        return
      }
      // 悬停高亮只在笔刷工具下有意义
      if (editor.tool !== 'brush') return
      this.options.onHover({ x: world.x, y: world.y, radius: editor.getBrushRadius() })
    }

    const finish = (event: PointerEvent, cancelled = false): void => {
      const down = this.downClient
      this.downClient = null

      // 选择模式的左键手势收尾
      if (this.selectPointerId !== null && this.selectPointerId === event.pointerId) {
        const editor = this.options.editor
        const dragged = editor.endCellDrag()
        this.resetSelectGesture()
        try {
          host.releasePointerCapture?.(event.pointerId)
        } catch {
          // 忽略
        }
        // 取消（pointercancel / 焦点丢了）时**不做**单击语义：那会把"误触"变成一次改动。
        // 模式在手势中途变了（按了 D）时同样不做 —— 单击语义只属于选择模式。
        //
        // ⚠️ 拖动结束要**清掉双击基准**：双击的意思是"两次点击"，一次拖动不算。
        // 不清的话，"点一下 → 拖两下 → 又从同一点按下"会被判成双击，走进改名分支，
        // 那一次拖动整段丢失（冒烟场景 48 就是被这条卡住的）。
        if (dragged || cancelled) {
          this.lastClickAt = null
          this.lastClickClient = null
        }
        if (!cancelled && !dragged && editor.mode === 'select') {
          const world = this.worldFromEvent(event)
          if (world) {
            // 到这里才算"一次完整的点击"：双击判定的时间基准就在这里更新
            this.lastClickAt = Date.now()
            this.lastClickClient = { x: event.clientX, y: event.clientY }
            if (this.selectOperation === 'replace') {
              /**
               * 单击 = 选中"这一点下面的对象"（命中顺序见 `selection.ts`），
               * 命中地块时顺带把它设为唯一的格选择（见 `MapEditor.selectAtPoint`）。
               */
              const scale = readScale(this.options.handle.canvas).scale ?? 1
              editor.selectAtPoint(world, SHAPE_HIT_TOLERANCE_PX / scale)
            } else {
              /**
               * Shift / Alt 的单击形态：**先问对象**，命中对象就并入 / 移出**对象选择**
               * （§2.6 授权的"同类多对象选择"）；没命中对象才回退到既有的"这一格"语义。
               *
               * 顺序不能反：Shift 点一个标记，用户想要的是"把这个标记也选上"，
               * 而不是"选中它底下那一格"。而命中地块 / 空处时格语义照旧（§C.1 的手感）。
               */
              const scale = readScale(this.options.handle.canvas).scale ?? 1
              const handled = editor.toggleObjectAt(world, SHAPE_HIT_TOLERANCE_PX / scale, this.selectOperation)
              if (!handled) editor.toggleCellAt(world, this.selectOperation)
            }
          }
        }
        return
      }

      if (this.paintingPointerId !== null && this.paintingPointerId === event.pointerId) {
        this.paintingPointerId = null
        try {
          host.releasePointerCapture?.(event.pointerId)
        } catch {
          // 忽略
        }
        this.options.editor.endStroke()
        return
      }

      // 标记 / 文字：仅当"按下→抬起几乎没移动"才算放置，避免拖动时误放一片
      const tool = this.options.editor.tool
      if (this.options.editor.mode !== 'paint' || tool === 'brush' || isMultiPointTool(tool)) return
      if (!isClickGesture(down, { x: event.clientX, y: event.clientY })) return
      const world = this.worldFromEvent(event)
      if (world) this.options.onPlaceRequest?.(tool as 'marker' | 'label', world)
    }

    /** 拦下事件：既阻止原生处理，也避免冒泡到画布 */
    const swallow = (event: PointerEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
    }

    const onPointerLeave = (): void => {
      if (this.paintingPointerId === null) this.options.onHover(null)
    }

    const add = (type: string, handler: EventListener, capture: boolean): void => {
      host.addEventListener(type, handler, capture)
      this.listeners.push(() => host.removeEventListener(type, handler, capture))
    }

    // pointerdown 必须用捕获阶段（先于 Obsidian）；其余用捕获阶段只为稳定收到
    add('pointerdown', onPointerDown as EventListener, true)
    add('pointermove', onPointerMove as EventListener, true)
    add('pointerup', finish as EventListener, true)
    // 取消手势（系统抢走指针 / 触摸被系统打断）：与抬手同样收尾，但**不**执行单击语义
    add('pointercancel', ((event: Event) => finish(event as PointerEvent, true)) as EventListener, true)
    add('pointerleave', onPointerLeave as EventListener, true)
    // 丢焦点时收尾，避免"卡在按住状态"
    const onBlur = (): void => {
      if (this.paintingPointerId !== null) {
        this.paintingPointerId = null
        this.options.editor.endStroke()
      }
      // 框选也要收尾：留着它会让下一次 pointermove 继续改选择
      this.resetSelectGesture()
    }
    add('blur', onBlur as EventListener, true)

    this.pushScope()
  }

  detach(): void {
    this.disposed = true
    for (const remove of this.listeners) remove()
    this.listeners = []
    this.paintingPointerId = null
    this.resetSelectGesture()
    this.popScope()
    this.options.onHover(null)
  }

  /** 模式变化：退出选择模式时丢掉进行中的框选；退出绘制时清掉悬停高亮 */
  notifyModeChanged(mode: 'select' | 'paint'): void {
    if (mode !== 'select') this.resetSelectGesture()
    if (mode === 'select') this.options.onHover(null)
    this.options.onModeChanged(mode)
  }

  // ------------------------------------------------------------ 按键作用域

  /**
   * 把作用域移到栈顶：Obsidian 的 Scope 栈是"后进先出"的查找顺序，
   * 只有位于栈顶时 `Mod+Z` 才会先到我们手里。
   * canvas 成为活动视图时调用（否则让位给当前焦点所在的编辑器）。
   */
  bringScopeToFront(): void {
    if (this.disposed) return
    this.popScope()
    this.pushScope()
  }

  /** 弹出按键作用域（保留指针监听）：把按键让给获得焦点的其它视图 */
  detachScope(): void {
    this.popScope()
  }

  private pushScope(): void {
    if (this.scope) return
    const scope = new Scope(this.options.app.scope)
    const editor = this.options.editor
    const register = (modifiers: string[], key: string, handler: (event: KeyboardEvent) => boolean): void => {
      scope.register(
        modifiers as never,
        key,
        ((event: KeyboardEvent) => {
          // 焦点在输入框里时一律让行：命名对话框里打 p / r / b 不能切换工具，
          // 回车也不能去结束草稿。（返回 true = 未处理，继续向下传递。）
          if (isEditableTarget(event)) return true
          return handler(event)
        }) as never,
      )
    }

    register([], 'd', () => {
      const mode = editor.toggleMode()
      this.notifyModeChanged(mode)
      return false
    })

    register([], 'Escape', () => {
      // 选中优先：按 Esc 的第一意图通常是"取消选中"。
      // 有草稿时先清选中、再按一次才取消草稿 —— 顺序写死在这里，避免"有时取消草稿、有时清选中"
      // 「选中」= 对象选中 + 格选择（§C.1：Esc 先清空选择；选择已空时再退出工具）
      if (editor.hasSelection()) {
        editor.clearAllSelection()
        return false
      }
      // 先取消进行中的草稿，再退出绘制模式：Esc 的语义是"退出当前这一步"
      if (editor.isDrafting()) {
        editor.cancelDraft()
        return false
      }
      if (editor.mode !== 'paint') return true
      editor.setMode('select')
      this.notifyModeChanged('select')
      return false
    })

    // Enter：结束多点草稿（比双击更可靠，不依赖时序）
    register([], 'Enter', () => {
      if (!editor.isDrafting()) return true
      const created = editor.finishDraft()
      if (created) this.options.onShapeCreated?.(created)
      return false
    })

    // B / M / T / P / R：切换工具（设计文档 §5.2）
    register([], 'b', () => {
      editor.setTool('brush')
      return false
    })
    register([], 'm', () => {
      editor.setTool('marker')
      return false
    })
    register([], 't', () => {
      editor.setTool('label')
      return false
    })
    register([], 'p', () => {
      editor.setTool('path')
      return false
    })
    register([], 'r', () => {
      editor.setTool('region')
      return false
    })

    TERRAIN_TYPES.forEach((type: TerrainType, index: number) => {
      register([], String(index + 1), () => {
        editor.setTerrainType(type)
        return false
      })
    })

    register([], '[', () => {
      editor.adjustBrushRadius(-1)
      return false
    })
    register([], ']', () => {
      editor.adjustBrushRadius(1)
      return false
    })

    // 只在绘制模式下接管撤销/重做；选择模式下交还给 Obsidian（编辑器撤销更符合预期）
    register(['Mod'], 'z', () => {
      if (editor.mode !== 'paint') return true
      editor.undo()
      return false
    })
    register(['Mod', 'Shift'], 'z', () => {
      if (editor.mode !== 'paint') return true
      editor.redo()
      return false
    })

    this.options.app.keymap.pushScope(scope)
    this.scope = scope
  }

  private popScope(): void {
    if (!this.scope) return
    try {
      this.options.app.keymap.popScope(this.scope)
    } catch (error) {
      console.error('[project-kaki] 移除按键作用域失败', error)
    }
    this.scope = null
  }

  private worldFromEvent(event: PointerEvent): { x: number; y: number } | null {
    const result = pointerToWorld(this.options.handle.canvas, event as unknown as MouseEvent)
    return result?.point ?? null
  }

  /**
   * 丢掉进行中的**选择手势**（指针状态 + 编辑器里的框选状态）。
   *
   * 三处会用到：手势正常收尾、丢焦点/取消、**模式在手势中途变了**。
   * 最后一种最阴：按 D 切到绘制模式后，残留的 `selectPointerId` 会让后续的
   * `pointermove` 全部走进框选分支，于是"笔刷刷不动"，而画面上看不出任何异常。
   */
  private resetSelectGesture(): void {
    this.selectPointerId = null
    this.selectStartClient = null
    this.selectDragged = false
    this.options.editor.cancelCellDrag()
  }
}
