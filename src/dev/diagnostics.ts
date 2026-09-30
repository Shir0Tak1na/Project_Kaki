/**
 * 运行时诊断报告。
 *
 * 这份报告**不再**回答 Phase 0 的问题。它只回答当下真正有用的三类：
 *
 *   (a) 这一刻系统是什么状态 —— 活跃画布与地图路径、地图文件版本与 definitions、
 *       图层/覆盖层/图例的**解析来源**（`mapViews[该图]` 还是库级模板）、当前选中、
 *       标记 / 文字条数；
 *   (b) 投影是怎么判的 —— `scale` / `origin` / 来源（closed-form | posFromEvt | mixed）、
 *       闭式与采样的差（originDeltaPx / scaleDelta）、`posFromClient` 往返偏差、视口矩形与 world bbox；
 *   (c) 规模与 DOM —— 展平后的图元数、marker / label placement 数与裁剪比、浮层元素数。
 *
 * Phase 0 的结论（坐标换算、`posFromEvt` 量化、世界层挂载点）早已固化在
 * `docs/archive/PHASE-0-RESULTS.md`，本报告**只引用不再重测** —— 因此不再逐次重算
 * 量子估计（`estimateQuantum`）、25 点标定（`calibrateOrigin`）与中心公式三方对照。
 *
 * 报告只出现标量、数量与结论，绝不序列化活对象。
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
import { projectionWorldBBox } from '../core/projection.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import { summarizeMapDocument } from '../data/mapDocument.ts'
import type { LayerVisibility } from '../render/layerVisibility.ts'
import type { CustomMarker } from '../render/markerCatalog.ts'
import { buildPlacements } from '../render/markerPlacement.ts'
import { buildRenderPlan } from '../render/renderPlan.ts'
import { describeOverlayCollisions, describeSelectorCoverage, rectFromBounds, type ElementRect } from './overlayGeometry.ts'

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

/** 我方浮层（画布上叠加的东西）：工具条 / 选择信息卡 / 图例 */
const OVERLAY_SELECTORS = ['.fc-toolbar', '.fc-selection-card', '.fc-legend'] as const

/** Obsidian 画布自己的控件与视图标题栏 —— 浮层不该压住它们 */
const NATIVE_SELECTORS = ['.canvas-controls', '.canvas-card-menu', '.canvas-menu', '.view-header'] as const

interface QueryableNode {
  querySelector?(selector: string): unknown
}

function fixed(value: number | null | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function ratio(part: number, total: number): string {
  if (!(total > 0)) return '—'
  return `${((part / total) * 100).toFixed(1)}%`
}

function resolveSourceLabel(source: 'map' | 'library' | 'none', mapPath: string | null): string {
  if (source === 'map') return '`mapViews[' + (mapPath ?? '?') + ']`（这张图自己那一份）'
  if (source === 'library') return '库级模板（这张图没有自己的记录）'
  return '库级模板（当前没有绑定地图）'
}

function anchorLabel(source: ProjectionResult['anchorSource']): string {
  switch (source) {
    case 'closed-form':
      return 'closed-form（闭式：wrapperRect 左上角 + 矩阵平移）'
    case 'posFromEvt':
      return 'posFromEvt（采样：Obsidian 自己的坐标映射）'
    case 'mixed':
      return 'mixed（缩放取采样、原点取闭式）'
    case 'posFromClient':
      return 'posFromClient（单点兜底）'
    default:
      return 'none（不可用）'
  }
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

function describeHandle(handle: CanvasHandle, index: number): string[] {
  const path = handle.file?.path ?? '(无 file 字段)'
  return ['- ' + (handle.isActive ? '▶ 当前' : '  ') + ' #' + index + ' ' + path]
}

export function buildDiagnosticReport(app: App, runtime: DiagnosticRuntime = EMPTY_DIAGNOSTIC_RUNTIME): string {
  const p = Platform as unknown as Record<string, unknown>
  const platform = p.isDesktop === true ? 'desktop' : p.isMobile === true ? 'mobile' : 'unknown'
  const { handles, deferredLeaves, totalLeaves } = findCanvasHandles(app)
  const active = activeCanvasHandle(app)

  const out: string[] = []
  out.push('# Project Kaki — 运行时诊断')
  out.push('')
  out.push('- 生成时间：' + new Date().toISOString())
  out.push('- Obsidian apiVersion：' + apiVersion + ' · 平台：' + platform + ' · UA：' + navigator.userAgent.slice(0, 120))
  out.push(
    '- 本报告只回答「此刻状态 / 投影裁决 / 规模与 DOM」；Phase 0 的历史结论（坐标换算、posFromEvt 量化、挂载点）见 docs/archive/PHASE-0-RESULTS.md，**不再逐次重算**。',
  )
  out.push('')

  out.push('## 1. Canvas 叶子')
  out.push('')
  out.push('- 叶子总数：' + totalLeaves + ' · 已加载：' + handles.length + ' · 未加载/deferred：' + deferredLeaves.length)
  if (handles.length === 0) {
    out.push('')
    out.push('> ⚠️ 没有已加载的 Canvas 视图。请打开一个 .canvas 文件后重新运行诊断。')
    return out.join('\n')
  }
  for (let i = 0; i < handles.length; i++) out.push(...describeHandle(handles[i] as CanvasHandle, i))
  out.push('')

  const target = active as CanvasHandle
  const canvas = target.canvas
  const projectionResult = buildProjection(canvas)
  const viewportRect = projectionResult.viewportRect ?? readViewportRect(canvas)

  out.push('## 2. 地图文档')
  out.push('')
  if (runtime.mapPath === null) {
    out.push('- 未绑定地图文档（当前画布没有对应的 .map.md）')
  } else {
    out.push('- 地图文档：' + runtime.mapPath)
    if (runtime.mapVersion === null) {
      out.push('- 文件版本：读不到（文件缺失或解析失败，详见控制台）')
    } else {
      const definitions =
        runtime.definitionsInFile === true
          ? '在文件里（以文件为准）'
          : runtime.definitionsInFile === false
            ? '不在文件里（v1 老图 / 未写回 ⇒ 读到的是库级模板的内存快照）'
            : '未知'
      out.push('- 文件版本：v' + runtime.mapVersion + (runtime.mapReadOnly ? '（只读：版本高于本插件）' : '') + ' · definitions：' + definitions)
    }
  }
  out.push('')

  out.push('## 3. 图层与覆盖层的解析来源')
  out.push('')
  out.push('- 图层可见性：' + resolveSourceLabel(runtime.layersSource, runtime.mapPath))
  out.push('- 覆盖层参数：' + resolveSourceLabel(runtime.overlaysSource, runtime.mapPath))
  out.push('- 图例显隐：' + (runtime.showLegend ? '显示' : '隐藏') + '（' + resolveSourceLabel(runtime.showLegendSource, runtime.mapPath) + '）')
  out.push('')

  out.push('## 4. 当前选中与内容规模')
  out.push('')
  out.push('- 当前选中：' + (runtime.selection ?? '无'))
  if (runtime.document === null) {
    out.push('- 内容规模：无已加载的地图文档（启用地图层后可见）')
  } else {
    const summary = summarizeMapDocument(runtime.document)
    out.push(
      '- 内容规模：地形 ' + summary.cells + ' 格 · 标记 ' + summary.markers + ' · 文字 ' + summary.labels + ' · 路径 ' + summary.paths + ' · 区域 ' + summary.regions,
    )
  }
  out.push('')

  out.push('## 5. 投影是怎么判的')
  out.push('')
  out.push(
    projectionResult.host
      ? '- 世界层挂载点 = ' + '\`' + projectionResult.host.tag + '.' + projectionResult.host.cls + '\`'
      : '- 世界层挂载点 = 未找到（没有带缩放分量的变换元素）',
  )
  out.push('- 缩放：' + fixed(projectionResult.scale, 9) + '（来源：' + projectionResult.scaleSource + '）')
  const projection = projectionResult.projection
  if (projection) {
    const originX = projection.anchorClient.x - projection.anchorWorld.x * projection.scale
    const originY = projection.anchorClient.y - projection.anchorWorld.y * projection.scale
    out.push('- 原点：(' + originX.toFixed(3) + ', ' + originY.toFixed(3) + ')（client 坐标，对应世界 0,0）')
    out.push('- 判定来源：' + anchorLabel(projectionResult.anchorSource))
    out.push(
      '- 闭式 vs 采样：originDeltaPx=' + fixed(projectionResult.originDeltaPx, 4) + ' · scaleDelta=' + fixed(projectionResult.scaleDelta, 6),
    )
    out.push(
      projectionResult.anchorSource === 'closed-form'
        ? '- 是否发生切换：否（闭式与采样一致，仍用闭式）'
        : projectionResult.anchorSource === 'mixed'
          ? '- 是否发生切换：缩放发生了切换（原点仍取闭式）'
          : '- 是否发生切换：是（闭式与采样不一致，已改用采样）',
    )
  } else {
    out.push('- 投影不可用（原因见下面几行）')
  }
  out.push('- posFromClient 往返偏差：' + fixed(projectionResult.crossCheckDelta, 4) + ' px')
  out.push(
    viewportRect
      ? '- 视口矩形：left=' + viewportRect.left.toFixed(2) + ' top=' + viewportRect.top.toFixed(2) + ' ' + viewportRect.width.toFixed(0) + '×' + viewportRect.height.toFixed(0)
      : '- 视口矩形：不可读（wrapperEl 不可用）',
  )
  if (projection && viewportRect) {
    const bbox = projectionWorldBBox(projection, viewportRect)
    out.push(
      '- world bbox：x∈[' + bbox.minX.toFixed(1) + ', ' + bbox.maxX.toFixed(1) + '] y∈[' + bbox.minY.toFixed(1) + ', ' + bbox.maxY.toFixed(1) + ']',
    )
  } else {
    out.push('- world bbox：不可计算')
  }
  for (const note of projectionResult.notes) out.push('- ⚠️ ' + note)
  out.push('')

  const viewContainer = viewContainerOf(target)
  const overlayRects = measureRects(viewContainer, OVERLAY_SELECTORS)
  const nativeRects = measureRects(viewContainer, NATIVE_SELECTORS)

  out.push('## 6. 规模与 DOM')
  out.push('')
  if (runtime.document === null || projection === null || viewportRect === null) {
    out.push('- 无法计算：缺少地图文档、投影或视口矩形')
  } else {
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1
    const plan = buildRenderPlan({
      document: runtime.document,
      projection,
      viewportRect,
      devicePixelRatio,
      ...(runtime.layers !== null ? { layers: runtime.layers } : {}),
    })
    if (plan === null) {
      out.push('- 渲染计划无法生成（视口尺寸非法）')
    } else {
      out.push(
        '- 展平图元：地形 ' + plan.cells.length + ' 格（裁剪 ' + plan.culledCells + '）· 路径 ' + plan.paths.length + '（裁剪 ' + plan.culledPaths + '）· 区域 ' + plan.regions.length + '（裁剪 ' + plan.culledRegions + '）',
      )
      out.push(
        '- 裁剪比：地形 ' + ratio(plan.culledCells, plan.cells.length + plan.culledCells) + ' · 路径 ' + ratio(plan.culledPaths, plan.paths.length + plan.culledPaths) + ' · 区域 ' + ratio(plan.culledRegions, plan.regions.length + plan.culledRegions),
      )
    }
    const placements = buildPlacements({
      document: runtime.document,
      projection,
      viewportRect,
      customMarkers: runtime.customMarkers,
    })
    const visibleMarkers = placements.filter((item) => item.kind === 'marker').length
    const visibleLabels = placements.filter((item) => item.kind === 'label').length
    out.push(
      '- placement：marker ' + visibleMarkers + '/' + runtime.document.markers.length + '（保留 ' + ratio(visibleMarkers, runtime.document.markers.length) + '）· label ' + visibleLabels + '/' + runtime.document.labels.length + '（保留 ' + ratio(visibleLabels, runtime.document.labels.length) + '）',
    )
  }
  out.push('- 浮层元素：我方 ' + overlayRects.length + ' 个 · 原生控件 ' + nativeRects.length + ' 个')
  out.push('')

  out.push('## 7. 浮层与原生控件是否重叠（施工文件 §F.3 / ISSUES.md ISSUE-004 §4 第 5 条）')
  out.push('')
  const canMeasure = typeof (viewContainer as QueryableNode | null | undefined)?.querySelector === 'function'
  if (!canMeasure) {
    out.push('- 读不到视图容器（view.containerEl 的 querySelector 不可用）—— 这一条只能人工看左上角。')
  } else {
    out.push(...describeOverlayCollisions(overlayRects, nativeRects))
  }
  out.push('- 判定口径：**重叠面积 > 0 才算重叠**（只是贴边不算）；浮层挂在未变换的 wrapperEl 上，所以不随画布缩放。')
  out.push('')

  out.push('## 8. CSS 选择器命中')
  out.push('')
  if (!canMeasure) {
    out.push('- 读不到视图容器，无法检查选择器命中。')
  } else {
    out.push(describeSelectorCoverage(OVERLAY_SELECTORS, overlayRects))
    out.push(describeSelectorCoverage(NATIVE_SELECTORS, nativeRects))
    out.push('- 命中数少于总数时会把没找到的类名点名出来 —— 那是 Obsidian 改了类名，不是「没有重叠」。')
  }
  out.push('')

  out.push('## 9. 历史结论（Phase 0，仅引用）')
  out.push('')
  out.push('- 坐标换算（锚点 + 缩放）、posFromEvt 量化到 1 CSS px、世界层挂载点等结论已固化，见 docs/archive/PHASE-0-RESULTS.md。')
  out.push('- 本报告**不再重算**量子估计、25 点标定与中心公式对照；那三节随探针更新一并退休。')
  out.push('')

  return out.join('\n')
}
