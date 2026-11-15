/**
 * 运行时诊断报告 —— **采集侧**。
 *
 * 报告的文字、编号与判定口径全部在 `dev/diagnosticReport.ts`（纯函数、不 import obsidian、可单测）。
 * 这里只做三件「只有 App 才做得到」的事：
 *
 *   1. 找 Canvas 叶子与活动那张（`findCanvasHandles` / `activeCanvasHandle`）；
 *   2. 让 `CanvasAdapter` 把投影判出来（`buildProjection` / `readViewportRect`）；
 *   3. 从视图容器里量浮层与原生控件的屏幕矩形（`measureRects`）。
 *
 * 为什么要这样拆：这份报告是用户排查 Obsidian 版本漂移的**唯一输入**，不能靠人眼对错；
 * 而它原来整份长在这里、被顶部的 obsidian import 卡住，node 单测 import 不进来
 * （`FEATURE-AUDIT.md` §2 的缺口）。拆完以后 `tests/diagnosticReport.test.ts` 可以逐节判对错。
 */

import { apiVersion, Platform } from 'obsidian'
import type { App } from 'obsidian'
import {
  activeCanvasHandle,
  buildProjection,
  findCanvasHandles,
  readViewportRect,
  type CanvasHandle,
  type ProjectionResult,
} from '../canvas/CanvasAdapter.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import type { LayerVisibility } from '../render/layerVisibility.ts'
import type { CustomMarker } from '../render/markerCatalog.ts'
import { rectFromBounds, type ElementRect } from './overlayGeometry.ts'
import {
  NATIVE_SELECTORS,
  OVERLAY_SELECTORS,
  renderDiagnosticReport,
  type DiagnosticSnapshot,
  type DiagnosticViewportRect,
} from './diagnosticReport.ts'

/**
 * 报告需要、而 `app` 本身给不出的“当下运行时状态”。
 *
 * 由 `main.ts` 在调用处组装（只有它认识地图存储层、图层管理器与插件设置）。
 * 缺省值让“没有地图上下文”的调用者也能拿到一份完整报告，而不是抛错。
 */
export interface DiagnosticRuntime {
  /** 活动画布绑定的地图路径（`null` = 没绑定） */
  mapPath: string | null
  /** 地图文件里的版本号；读不到时 `null` */
  mapVersion: number | null
  /** 版本高于本插件（只读打开） */
  mapReadOnly: boolean
  /** 文件里有没有 `definitions` 段；读不到时 `null` */
  definitionsInFile: boolean | null
  /** 当前生效的图层可见性 */
  layers: LayerVisibility | null
  /** 图层可见性的解析来源 */
  layersSource: 'map' | 'library' | 'none'
  /** 覆盖层参数的解析来源 */
  overlaysSource: 'map' | 'library' | 'none'
  /** 图例显隐的解析来源 */
  showLegendSource: 'map' | 'library' | 'none'
  /** 图例是否显示 */
  showLegend: boolean
  /** 当前选中（一行标量描述；`null` = 没选中） */
  selection: string | null
  /** 已加载的地图文档（只用来算规模；报告绝不序列化它） */
  document: MapDocument | null
  /** 自定义标记目录（placement 解析用） */
  customMarkers: readonly CustomMarker[]
}

export const EMPTY_DIAGNOSTIC_RUNTIME: DiagnosticRuntime = {
  mapPath: null,
  mapVersion: null,
  mapReadOnly: false,
  definitionsInFile: null,
  layers: null,
  layersSource: 'none',
  overlaysSource: 'none',
  showLegendSource: 'none',
  showLegend: true,
  selection: null,
  document: null,
  customMarkers: [],
}

interface QueryableNode {
  querySelector?(selector: string): unknown
}

/** 取这个 Canvas 视图的容器元素（浮层与原生控件都在它里面）。拿不到就返回 undefined。 */
function viewContainerOf(handle: CanvasHandle): unknown {
  const view = handle.view as { containerEl?: unknown } | undefined
  return view?.containerEl
}

/**
 * 从容器里量出这些选择器对应元素的屏幕矩形。
 *
 * 每一步都先检查能力再调用：同一个函数也会被冒烟测试调用，那里的 DOM 是桩。
 * 宁可少一行数字，也不要抛错把整份报告弄没。
 */
function measureRects(container: unknown, selectors: readonly string[]): ElementRect[] {
  const node = container as QueryableNode | null | undefined
  if (!node || typeof node.querySelector !== 'function') return []
  const rects: ElementRect[] = []
  for (const selector of selectors) {
    const found = node.querySelector(selector) as { getBoundingClientRect?(): unknown } | null | undefined
    if (!found || typeof found.getBoundingClientRect !== 'function') continue
    const raw = found.getBoundingClientRect() as Parameters<typeof rectFromBounds>[1]
    const rect = rectFromBounds(selector, raw)
    if (rect) rects.push(rect)
  }
  return rects
}

/**
 * 组装一份快照并渲染。
 *
 * 没有已加载的 Canvas 时**不**去碰任何 Canvas API：快照里投影留 `null`，
 * 渲染侧会照旧输出第 1 节那句「请打开一个 .canvas 文件后重新运行诊断」并就此收尾。
 */
export function buildDiagnosticReport(app: App, runtime: DiagnosticRuntime = EMPTY_DIAGNOSTIC_RUNTIME): string {
  const p = Platform as unknown as Record<string, unknown>
  const platform = p.isDesktop === true ? 'desktop' : p.isMobile === true ? 'mobile' : 'unknown'
  const { handles, deferredLeaves, totalLeaves } = findCanvasHandles(app)
  const active = activeCanvasHandle(app)

  const canvases = handles.map((handle) => ({ path: handle.file?.path ?? '(无 file 字段)', isActive: handle.isActive }))

  let projection: ProjectionResult | null = null
  let viewportRect: DiagnosticViewportRect | null = null
  let overlayRects: ElementRect[] = []
  let nativeRects: ElementRect[] = []
  let canMeasureDom = false
  if (active !== null && active !== undefined) {
    const target = active as CanvasHandle
    const canvas = target.canvas
    const result = buildProjection(canvas)
    projection = result
    viewportRect = result.viewportRect ?? readViewportRect(canvas)
    const viewContainer = viewContainerOf(target)
    overlayRects = measureRects(viewContainer, OVERLAY_SELECTORS)
    nativeRects = measureRects(viewContainer, NATIVE_SELECTORS)
    canMeasureDom = typeof (viewContainer as QueryableNode | null | undefined)?.querySelector === 'function'
  }

  const snapshot: DiagnosticSnapshot = {
    environment: {
      generatedAt: new Date().toISOString(),
      apiVersion,
      platform,
      userAgent: typeof navigator === 'undefined' ? '(无 navigator)' : navigator.userAgent.slice(0, 120),
    },
    canvases,
    totalLeafCount: totalLeaves,
    deferredLeafCount: deferredLeaves.length,
    mapPath: runtime.mapPath,
    mapVersion: runtime.mapVersion,
    mapReadOnly: runtime.mapReadOnly,
    definitionsInFile: runtime.definitionsInFile,
    layers: runtime.layers,
    layersSource: runtime.layersSource,
    overlaysSource: runtime.overlaysSource,
    showLegendSource: runtime.showLegendSource,
    showLegend: runtime.showLegend,
    selection: runtime.selection,
    document: runtime.document,
    customMarkers: runtime.customMarkers,
    projection,
    viewportRect,
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    overlayRects,
    nativeRects,
    canMeasureDom,
  }
  return renderDiagnosticReport(snapshot)
}
