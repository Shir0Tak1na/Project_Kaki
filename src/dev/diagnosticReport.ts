/**
 * 诊断报告的**文字与判定口径**（纯函数，不 import obsidian，可单测）。
 *
 * 拆出来的理由：报告是用户排查「Obsidian 版本漂移」的**唯一输入**（`README.md` 的「兼容性与已知限制」
 * 就是这么写的），它不能靠人眼对照。而它原来整份长在 `dev/diagnostics.ts` 里 —— 那个文件顶部 import 了
 * obsidian，于是 node 的单测根本 import 不进来，只能靠冒烟碰运气（`FEATURE-AUDIT.md` §2 记的缺口）。
 *
 * 采集侧（找 Canvas 叶子、判投影、量 DOM 矩形）留在 `diagnostics.ts`；这里只吃快照、只吐文本。
 *
 * 与 `dev/overlayGeometry.ts` 同一条纪律：**能脱离宿主判对错的，就别让它 import 宿主**。
 */

import type { ProjectionResult } from '../canvas/CanvasAdapter.ts'
import { projectionWorldBBox } from '../core/projection.ts'
import type { MapDocument } from '../data/mapDocument.ts'
import { summarizeMapDocument } from '../data/mapDocument.ts'
import type { LayerVisibility } from '../render/layerVisibility.ts'
import type { CustomMarker } from '../render/markerCatalog.ts'
import { buildPlacements } from '../render/markerPlacement.ts'
import { buildRenderPlan } from '../render/renderPlan.ts'
import { describeOverlayCollisions, describeSelectorCoverage, type ElementRect } from './overlayGeometry.ts'

/** 报告里出现的环境事实（由采集侧从 obsidian 与 navigator 取） */
export interface DiagnosticEnvironment { generatedAt: string; apiVersion: string; platform: string; userAgent: string }

/** 一个 Canvas 叶子在报告里的最小事实（不需要活对象） */
export interface DiagnosticCanvasRef { path: string; isActive: boolean }

export interface DiagnosticViewportRect { left: number; top: number; width: number; height: number }

/** 一份报告需要的全部输入 —— 全是标量 / 纯数据，绝不含活对象 */
export interface DiagnosticSnapshot {
  environment: DiagnosticEnvironment
  canvases: readonly DiagnosticCanvasRef[]
  totalLeafCount: number
  deferredLeafCount: number
  mapPath: string | null
  mapVersion: number | null
  mapReadOnly: boolean
  definitionsInFile: boolean | null
  layers: LayerVisibility | null
  layersSource: 'map' | 'library' | 'none'
  overlaysSource: 'map' | 'library' | 'none'
  showLegendSource: 'map' | 'library' | 'none'
  showLegend: boolean
  selection: string | null
  document: MapDocument | null
  customMarkers: readonly CustomMarker[]
  projection: ProjectionResult | null
  viewportRect: DiagnosticViewportRect | null
  devicePixelRatio: number
  overlayRects: ElementRect[]
  nativeRects: ElementRect[]
  canMeasureDom: boolean
}

/** 我方浮层（画布上叠加的东西）：工具条 / 选择信息卡 / 图例 */
export const OVERLAY_SELECTORS = ['.fc-toolbar', '.fc-selection-card', '.fc-legend'] as const

/** Obsidian 画布自己的控件与视图标题栏 —— 浮层不该压住它们 */
export const NATIVE_SELECTORS = ['.canvas-controls', '.canvas-card-menu', '.canvas-menu', '.view-header'] as const

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

function describeHandle(canvas: DiagnosticCanvasRef, index: number): string[] {
  return ['- ' + (canvas.isActive ? '▶ 当前' : '  ') + ' #' + index + ' ' + canvas.path]
}

/** 渲染整份报告。输入里没有活对象，所以这一整条路径都能在 node 里跑 */
export function renderDiagnosticReport(snapshot: DiagnosticSnapshot): string {
  const out: string[] = []
  out.push('# Project Kaki — 运行时诊断')
  out.push('')
  out.push('- 生成时间：' + snapshot.environment.generatedAt)
  out.push('- Obsidian apiVersion：' + snapshot.environment.apiVersion + ' · 平台：' + snapshot.environment.platform + ' · UA：' + snapshot.environment.userAgent)
  out.push(
    '- 本报告只回答「此刻状态 / 投影裁决 / 规模与 DOM」；Phase 0 的历史结论（坐标换算、posFromEvt 量化、挂载点）见 docs/archive/PHASE-0-RESULTS.md，**不再逐次重算**。',
  )
  out.push('')

  out.push('## 1. Canvas 叶子')
  out.push('')
  out.push('- 叶子总数：' + snapshot.totalLeafCount + ' · 已加载：' + snapshot.canvases.length + ' · 未加载/deferred：' + snapshot.deferredLeafCount)
  if (snapshot.canvases.length === 0) {
    out.push('')
    out.push('> ⚠️ 没有已加载的 Canvas 视图。请打开一个 .canvas 文件后重新运行诊断。')
    return out.join('\n')
  }
  for (let i = 0; i < snapshot.canvases.length; i++) out.push(...describeHandle(snapshot.canvases[i]!, i))
  out.push('')

  const projectionResult = snapshot.projection
  const viewportRect = snapshot.viewportRect

  out.push('## 2. 地图文档')
  out.push('')
  if (snapshot.mapPath === null) {
    out.push('- 未绑定地图文档（当前画布没有对应的 .map.md）')
  } else {
    out.push('- 地图文档：' + snapshot.mapPath)
    if (snapshot.mapVersion === null) {
      out.push('- 文件版本：读不到（文件缺失或解析失败，详见控制台）')
    } else {
      const definitions =
        snapshot.definitionsInFile === true
          ? '在文件里（以文件为准）'
          : snapshot.definitionsInFile === false
            ? '不在文件里（v1 老图 / 未写回 ⇒ 读到的是库级模板的内存快照）'
            : '未知'
      out.push('- 文件版本：v' + snapshot.mapVersion + (snapshot.mapReadOnly ? '（只读：版本高于本插件）' : '') + ' · definitions：' + definitions)
    }
  }
  out.push('')

  out.push('## 3. 图层与覆盖层的解析来源')
  out.push('')
  out.push('- 图层可见性：' + resolveSourceLabel(snapshot.layersSource, snapshot.mapPath))
  out.push('- 覆盖层参数：' + resolveSourceLabel(snapshot.overlaysSource, snapshot.mapPath))
  out.push('- 图例显隐：' + (snapshot.showLegend ? '显示' : '隐藏') + '（' + resolveSourceLabel(snapshot.showLegendSource, snapshot.mapPath) + '）')
  out.push('')

  out.push('## 4. 当前选中与内容规模')
  out.push('')
  out.push('- 当前选中：' + (snapshot.selection ?? '无'))
  if (snapshot.document === null) {
    out.push('- 内容规模：无已加载的地图文档（启用地图层后可见）')
  } else {
    const summary = summarizeMapDocument(snapshot.document)
    out.push(
      '- 内容规模：地形 ' + summary.cells + ' 格 · 标记 ' + summary.markers + ' · 文字 ' + summary.labels + ' · 路径 ' + summary.paths + ' · 区域 ' + summary.regions,
    )
  }
  out.push('')

  if (projectionResult === null) {
    out.push('## 5. 投影是怎么判的')
    out.push('')
    out.push('- 投影不可读（没有可用的活动画布）')
    out.push('')
    return out.join('\n')
  }

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

  const overlayRects = snapshot.overlayRects
  const nativeRects = snapshot.nativeRects

  out.push('## 6. 规模与 DOM')
  out.push('')
  if (snapshot.document === null || projection === null || viewportRect === null) {
    out.push('- 无法计算：缺少地图文档、投影或视口矩形')
  } else {
    const devicePixelRatio = snapshot.devicePixelRatio
    const plan = buildRenderPlan({
      document: snapshot.document,
      projection,
      viewportRect,
      devicePixelRatio,
      ...(snapshot.layers !== null ? { layers: snapshot.layers } : {}),
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
      document: snapshot.document,
      projection,
      viewportRect,
      customMarkers: snapshot.customMarkers,
    })
    const visibleMarkers = placements.filter((item) => item.kind === 'marker').length
    const visibleLabels = placements.filter((item) => item.kind === 'label').length
    out.push(
      '- placement：marker ' + visibleMarkers + '/' + snapshot.document.markers.length + '（保留 ' + ratio(visibleMarkers, snapshot.document.markers.length) + '）· label ' + visibleLabels + '/' + snapshot.document.labels.length + '（保留 ' + ratio(visibleLabels, snapshot.document.labels.length) + '）',
    )
  }
  out.push('- 浮层元素：我方 ' + overlayRects.length + ' 个 · 原生控件 ' + nativeRects.length + ' 个')
  out.push('')

  out.push('## 7. 浮层与原生控件是否重叠（施工文件 §F.3 / ISSUES.md ISSUE-004 §4 第 5 条）')
  out.push('')
  const canMeasure = snapshot.canMeasureDom
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
