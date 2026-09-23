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
 * 2. 绘制模式下对左键 `stopPropagation()`：原生框选/拖拽一启动就被拦下；
 * 3. 用 `setPointerCapture` 把整条手势交给自己，拖动中的 `pointermove` 稳定到达；
 * 4. 其余按键（中键/右键）**不拦**，原生平移照旧；滚轮也完全不碰。
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

      // ---- 选择模式：不拦常规点击（原生框选/拖动照常），
      //      但"双击形状"要接管——它是重命名的入口 ----
      if (editor.mode === 'select') {
        // 只接管左键：中键留给原生平移
        if (event.button !== 0) return
        if (!world) return
        const now = Date.now()
        const isDoubleClick =
          this.lastClickAt !== null &&
          now - this.lastClickAt <= DOUBLE_CLICK_MS &&
          this.lastClickClient !== null &&
          Math.hypot(event.clientX - this.lastClickClient.x, event.clientY - this.lastClickClient.y) <= DOUBLE_CLICK_SLOP_PX
        this.lastClickAt = now
        this.lastClickClient = { x: event.clientX, y: event.clientY }
        if (!isDoubleClick) return

        const scale = readScale(this.options.handle.canvas).scale ?? 1
        const hit = editor.hitTestShape(world, SHAPE_HIT_TOLERANCE_PX / scale)
        if (!hit) return
        this.lastClickAt = null
        this.lastClickClient = null
        swallow(event)
        this.options.onShapeRenameRequest?.(hit)
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
      if (editor.mode !== 'paint') return
      if (!insideHost(event)) return

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

    const finish = (event: PointerEvent): void => {
      const down = this.downClient
      this.downClient = null

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
    add('pointercancel', finish as EventListener, true)
    add('pointerleave', onPointerLeave as EventListener, true)
    // 丢焦点时收尾，避免"卡在按住状态"
    const onBlur = (): void => {
      if (this.paintingPointerId !== null) {
        this.paintingPointerId = null
        this.options.editor.endStroke()
      }
    }
    add('blur', onBlur as EventListener, true)

    this.pushScope()
  }

  detach(): void {
    this.disposed = true
    for (const remove of this.listeners) remove()
    this.listeners = []
    this.paintingPointerId = null
    this.popScope()
    this.options.onHover(null)
  }

  /** 模式变化：退出绘制时清掉悬停高亮 */
  notifyModeChanged(mode: 'select' | 'paint'): void {
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
}
