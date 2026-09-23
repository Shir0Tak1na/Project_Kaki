/**
 * Phase 0 诊断报告（对应设计文档 §9 的 P1 / P2 / P4 探针）。
 *
 * 目的：在真实 Obsidian 里把三件事变成可粘贴的文本证据 ——
 *   1. 哪些私有字段可用（P2）；
 *   2. 哪一个元素才是承载世界变换的挂载点（P1）；
 *   3. 客户端 ↔ 世界坐标到底怎么换算（P4）。
 *
 * 报告只出现标量、数量与探测结论，绝不序列化活对象。
 * 客户端坐标保留 3 位小数、世界坐标保留 3 位小数：Phase 0 第一轮报告因只保留 1 位小数，
 * 引入了约 0.22 世界单位的取整残差，差点掩盖了模型的真实误差。
 */

import { apiVersion, Platform } from 'obsidian'
import type { App } from 'obsidian'
import {
  activeCanvasHandle,
  adapterCapabilities,
  buildProjection,
  findCanvasHandles,
  probeFields,
  probeTransformCandidates,
  readScale,
  readViewport,
  readViewportRect,
  type CanvasHandle,
  type CanvasLike,
  type TransformCandidate,
} from '../canvas/CanvasAdapter.ts'
import { clientToWorld, quantumNoiseBound, worldToClient, type ClientProjection } from '../core/projection.ts'
import { screenToWorld, viewportWorldBBox, type Viewport } from '../core/viewport.ts'

interface RoundTripRow {
  client: string
  viaEvt: string
  viaProjection: string
  viaCenter: string
  deltaProjection: number
  deltaCenter: number
}

interface RoundTripResult {
  rows: RoundTripRow[]
  maxDeltaProjection: number
  maxDeltaCenter: number
  legacyFormulaVerdict: string
}

function fmt(p: { x: number; y: number }): string {
  return `${p.x.toFixed(6)}, ${p.y.toFixed(6)}`
}

/**
 * P4：同一批采样点分别用三种方式换算，互相对照。
 * - posFromEvt：Obsidian 权威实现
 * - 锚点投影：本插件的换算方式
 * - 中心公式：设计文档 §3 的推导公式（基线改用未变换的视口矩形）
 */
function probeCoordinateRoundTrip(
  canvas: CanvasLike,
  viewport: Viewport | null,
  projection: ClientProjection | null,
  viewportRect: { left: number; top: number; width: number; height: number } | null,
  quantumWorld: number | null,
): RoundTripResult {
  const empty: RoundTripResult = { rows: [], maxDeltaProjection: Number.NaN, maxDeltaCenter: Number.NaN, legacyFormulaVerdict: '样本不足' }
  if (!viewportRect || !projection) return empty

  const fractions: Array<[number, number]> = [
    [0.25, 0.25],
    [0.5, 0.5],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.8, 0.8],
  ]

  const posFromEvt = (canvas as { posFromEvt?: unknown }).posFromEvt
  const rows: RoundTripRow[] = []
  let maxDeltaProjection = 0
  let maxDeltaCenter = 0

  for (const [fx, fy] of fractions) {
    const clientX = viewportRect.left + viewportRect.width * fx
    const clientY = viewportRect.top + viewportRect.height * fy
    const client = { x: clientX, y: clientY }

    const viaProjection = clientToWorld(projection, client)

    let viaEvtPoint: { x: number; y: number } | null = null
    if (typeof posFromEvt === 'function' && typeof MouseEvent === 'function') {
      try {
        const evt = new MouseEvent('mousemove', { clientX, clientY, bubbles: false })
        const raw = (posFromEvt as (e: MouseEvent) => unknown).call(canvas, evt)
        const rec = raw as { x?: unknown; y?: unknown } | null
        if (rec && typeof rec.x === 'number' && typeof rec.y === 'number') viaEvtPoint = { x: rec.x, y: rec.y }
      } catch {
        viaEvtPoint = null
      }
    }

    // 中心公式：screen 相对未变换视口矩形左上角，中心对应 (tx, ty)
    let viaCenterPoint: { x: number; y: number } | null = null
    if (viewport) {
      viaCenterPoint = screenToWorld(viewport, { x: clientX - viewportRect.left, y: clientY - viewportRect.top })
    }

    const deltaProjection = viaEvtPoint
      ? Math.hypot(viaProjection.x - viaEvtPoint.x, viaProjection.y - viaEvtPoint.y)
      : Number.NaN
    const deltaCenter =
      viaEvtPoint && viaCenterPoint
        ? Math.hypot(viaCenterPoint.x - viaEvtPoint.x, viaCenterPoint.y - viaEvtPoint.y)
        : Number.NaN

    if (Number.isFinite(deltaProjection)) maxDeltaProjection = Math.max(maxDeltaProjection, deltaProjection)
    if (Number.isFinite(deltaCenter)) maxDeltaCenter = Math.max(maxDeltaCenter, deltaCenter)

    rows.push({
      client: `${clientX.toFixed(4)}, ${clientY.toFixed(4)}`,
      viaEvt: viaEvtPoint ? fmt(viaEvtPoint) : '—',
      viaProjection: fmt(viaProjection),
      viaCenter: viaCenterPoint ? fmt(viaCenterPoint) : '—',
      deltaProjection,
      deltaCenter,
    })
  }

  let legacyFormulaVerdict: string
  if (!Number.isFinite(maxDeltaCenter) || !viewport) {
    legacyFormulaVerdict = '无法比较（缺视口数据）'
  } else if (quantumWorld !== null && maxDeltaCenter <= quantumWorld) {
    legacyFormulaVerdict = `✅ 与 posFromEvt 的偏差在量化步长（${quantumWorld.toFixed(3)} 世界单位）之内 —— 中心公式成立，但仍仅作兜底`
  } else if (maxDeltaCenter < 0.5) {
    legacyFormulaVerdict = '✅ 中心公式与 posFromEvt 一致 —— tx/ty 确实等于视口中心的世界坐标，可作为廉价兜底'
  } else if (maxDeltaCenter < 50) {
    legacyFormulaVerdict = '⚠️ 中心公式有小幅偏差，只能作为兜底'
  } else {
    legacyFormulaVerdict = '❌ 中心公式与 posFromEvt 不一致 —— 说明 tx/ty 不是视口中心的世界坐标，禁止用于坐标换算'
  }

  return { rows, maxDeltaProjection, maxDeltaCenter, legacyFormulaVerdict }
}

function hostVerdict(candidates: TransformCandidate[]): string {
  const withMatrix = candidates.filter((c) => c.matrix !== null)
  const host = withMatrix.find((c) => c.isWorldHost) ?? null

  if (withMatrix.length === 0) {
    return '未探测到任何带 transform 的元素 → 无法用 CSS 变换同步，需改用**策略 B**（覆盖层自持变换并跟随重绘）。'
  }
  if (!host) {
    return '探测到带 transform 的元素，但没有任何一个可以作为世界层（缩放不匹配且不含 canvas-node）→ 需人工核查 DOM。'
  }

  const evidence: string[] = []
  if (host.containsNodes) evidence.push('其子树包含 `.canvas-node`')
  if (host.matchesScale) evidence.push('其矩阵缩放分量等于当前 scale')
  evidence.push(`class=\`${host.cls}\``)

  return [
    `世界层挂载点 = \`${host.tag}.${host.cls}\`（${evidence.join('、')}）→ 采用**策略 A**：把覆盖层挂到该元素内部。`,
    '',
    '判据说明：本画布上同时有多个带 transform 的元素（卡片菜单、每个节点各带一个纯平移矩阵）。',
    '**只按「有没有 transform」判断会误判**，必须看矩阵的缩放分量是否等于当前 scale，或用「是否包含 canvas-node」这一结构证据。',
  ].join('\n')
}

function describeHandle(handle: CanvasHandle, index: number): string[] {
  const path = handle.file?.path ?? '(无 file 字段)'
  return [`- ${handle.isActive ? '▶ 当前' : '  '} #${index} \`${path}\``]
}

export function buildDiagnosticReport(app: App): string {
  const p = Platform as unknown as Record<string, unknown>
  const platform = p.isDesktop === true ? 'desktop' : p.isMobile === true ? 'mobile' : 'unknown'
  const { handles, deferredLeaves, totalLeaves } = findCanvasHandles(app)
  const active = activeCanvasHandle(app)

  const out: string[] = []
  out.push('# Project Kaki — Phase 0 诊断报告')
  out.push('')
  out.push(`- 生成时间：${new Date().toISOString()}`)
  out.push(`- Obsidian apiVersion：\`${apiVersion}\``)
  out.push(`- 平台：${platform} · UA：\`${navigator.userAgent.slice(0, 120)}\``)
  out.push('')

  out.push('## 1. Canvas 叶子')
  out.push('')
  out.push(`- 叶子总数：${totalLeaves} · 已加载：${handles.length} · 未加载/deferred：${deferredLeaves.length}`)
  if (handles.length === 0) {
    out.push('')
    out.push('> ⚠️ 没有已加载的 Canvas 视图。请打开一个 .canvas 文件后重新运行诊断。')
    return out.join('\n')
  }
  for (let i = 0; i < handles.length; i++) out.push(...describeHandle(handles[i] as CanvasHandle, i))
  out.push('')

  const target = active as CanvasHandle
  const canvas = target.canvas

  out.push('## 2. view.canvas 私有字段探测（P2）')
  out.push('')
  out.push('| 字段 | typeof | 备注 |')
  out.push('|---|---|---|')
  for (const field of probeFields(canvas)) {
    out.push(`| \`${field.name}\` | ${field.kind} | ${field.scalar || '—'} |`)
  }
  out.push('')

  // zoom 与 tZoom 的关系是本插件踩过的坑，必须显式判定
  const tZoom = canvas.tZoom
  const zoomField = canvas.zoom
  const scaleField = canvas.scale
  out.push('### 缩放字段语义')
  out.push('')
  out.push(
    typeof zoomField === 'number' && typeof tZoom === 'number' && Math.abs(zoomField - tZoom) < 1e-9
      ? '- ⚠️ `zoom` 与 `tZoom` 数值完全相同 → `zoom` 是 `tZoom` 的**别名**，不是线性比例'
      : '- `zoom` 与 `tZoom` 不同，需重新确认语义',
  )
  out.push(
    typeof scaleField === 'number' && typeof tZoom === 'number' && Math.abs(scaleField - 2 ** tZoom) < 1e-6
      ? `- ✅ \`scale\` = ${scaleField} = 2^tZoom → 线性比例用 \`scale\` 字段最直接`
      : `- ⚠️ \`scale\` 与 2^tZoom 的关系需要确认（scale=${String(scaleField)}，2^tZoom=${typeof tZoom === 'number' ? 2 ** tZoom : '—'}）`,
  )
  out.push('')

  const caps = adapterCapabilities(canvas)
  out.push('### 能力汇总')
  out.push('')
  for (const [key, ok] of Object.entries(caps)) out.push(`- ${ok ? '✅' : '❌'} \`${key}\``)
  out.push('')

  out.push('## 3. 挂载点探测（P1）')
  out.push('')
  const { scale: scaleHint, source: scaleHintSource } = readScale(canvas)
  const candidates = probeTransformCandidates(canvas, scaleHint)
  out.push(`- 判定用的当前缩放：${scaleHint ?? '未知'}（来源：${scaleHintSource}）`)
  out.push('')
  if (candidates.length === 0) {
    out.push('- 探测失败：wrapperEl / canvasEl 不可访问')
  } else {
    out.push('| host? | depth | 元素 | class | 矩阵 (a,d,e,f) | 缩放匹配 | 含节点 | 评分 |')
    out.push('|---|---|---|---|---|---|---|---|')
    for (const c of candidates) {
      const m = c.matrix
      out.push(
        `| ${c.isWorldHost ? '★' : ''} | ${c.depth} | \`${c.tag}\` | \`${c.cls}\` | ${
          m ? `${m.a},${m.d},${m.e.toFixed(2)},${m.f.toFixed(2)}` : '—'
        } | ${c.matchesScale ? '✓' : ''} | ${c.containsNodes ? '✓' : ''} | ${c.score} |`,
      )
    }
  }
  out.push('')
  out.push('### 挂载点判定')
  out.push('')
  out.push(hostVerdict(candidates))
  out.push('')

  const viewport = readViewport(canvas)
  const viewportRect = readViewportRect(canvas)
  const projectionResult = buildProjection(canvas, { calibrate: true })

  out.push('## 4. 视口读数')
  out.push('')
  if (viewport) {
    const bbox = viewportWorldBBox(viewport)
    out.push(`- tx=${viewport.tx.toFixed(3)} · ty=${viewport.ty.toFixed(3)} · tZoom=${viewport.tZoom.toFixed(6)} · scale=${(2 ** viewport.tZoom).toFixed(6)}`)
    out.push(`- canvasRect 尺寸：${viewport.width}×${viewport.height} (CSS px)`)
    out.push(
      `- 世界可见范围：x∈[${bbox.minX.toFixed(1)}, ${bbox.maxX.toFixed(1)}] y∈[${bbox.minY.toFixed(1)}, ${bbox.maxY.toFixed(1)}]`,
    )
  } else {
    out.push('- ❌ 读取失败（tx / ty / tZoom / canvasRect 中有缺失）')
  }
  if (viewportRect) {
    out.push(
      `- 未变换视口矩形（wrapperEl）：left=${viewportRect.left.toFixed(2)} top=${viewportRect.top.toFixed(2)} ${viewportRect.width.toFixed(0)}×${viewportRect.height.toFixed(0)}`,
    )
  } else {
    out.push('- ⚠️ 无法读取 wrapperEl 的视口矩形')
  }
  out.push('')

  out.push('## 5. 坐标换算对照（P4）')
  out.push('')
  out.push(`- 投影来源：${projectionResult.anchorSource} · 缩放=${projectionResult.scaleSource}`)
  if (projectionResult.projection) {
    const proj = projectionResult.projection
    const originX = proj.anchorClient.x - proj.anchorWorld.x * proj.scale
    const originY = proj.anchorClient.y - proj.anchorWorld.y * proj.scale
    out.push(
      `- 锚点：client(${proj.anchorClient.x.toFixed(3)}, ${proj.anchorClient.y.toFixed(3)}) ↔ world(${proj.anchorWorld.x.toFixed(3)}, ${proj.anchorWorld.y.toFixed(3)}) · scale=${proj.scale.toFixed(9)}`,
    )
    out.push(`- 投影原点：(${originX.toFixed(3)}, ${originY.toFixed(3)})`)
  }
  if (projectionResult.calibration) {
    const c = projectionResult.calibration
    out.push(
      `- 多点标定：${c.sampleCount} 点中位数 → 原点 (${c.origin.x.toFixed(3)}, ${c.origin.y.toFixed(3)}) · 样本散布 ${c.spread.toFixed(4)} px`,
    )
    if (c.agreementDelta !== null) {
      const quantumWorld = projectionResult.quantization?.x.quantumWorld ?? null
      const bound = quantumWorld !== null ? quantumNoiseBound(quantumWorld) : null
      const boundPx = bound !== null ? bound * (projectionResult.scale ?? 1) : null
      out.push(
        `- 标定原点与闭式原点的差异：${c.agreementDelta.toFixed(4)} px` +
          (boundPx !== null
            ? ` → ${
                c.agreementDelta <= boundPx
                  ? `在量化噪声上界（${boundPx.toFixed(4)} px）之内 ⇒ **不构成闭式关系有偏的证据**，运行时因此不施加偏差修正`
                  : `超出量化噪声上界（${boundPx.toFixed(4)} px）⇒ 闭式关系可能有系统偏差，需多次运行确认后再说`
              }`
            : ''),
      )
    }
  }
  if (projectionResult.heldOutResidualWorld !== null) {
    const q = projectionResult.quantization
    const quantumPx = q?.x.resolved ? q.x.quantumClientPx : null
    const quantumWorld = quantumPx !== null ? (quantumPx ?? 0) / (projectionResult.scale ?? 1) : null
    const verdict =
      quantumWorld !== null && projectionResult.heldOutResidualWorld <= quantumWorld
        ? '✅ 残差在量化步长之内 —— 已经到达可分辨精度的极限'
        : projectionResult.heldOutResidualWorld < 2
          ? '✅ 残差小于 2 个世界单位（约 1 px 以内）'
          : '❌ 残差偏大，需继续排查'
    out.push(
      `- 留出样本残差（不参与标定）：${projectionResult.heldOutResidualWorld.toFixed(4)} 世界单位 ≈ ${(
        projectionResult.heldOutResidualWorld * (projectionResult.projection?.scale ?? 1)
      ).toFixed(4)} px → ${verdict}`,
    )
  }
  if (projectionResult.derivedOrigin) {
    out.push(
      `- 闭式推导原点（wrapperRect.topLeft + 矩阵平移）：(${projectionResult.derivedOrigin.x.toFixed(3)}, ${projectionResult.derivedOrigin.y.toFixed(3)})`,
    )
  }
  if (projectionResult.crossCheckDelta !== null) {
    const quantumPx = projectionResult.quantization?.x.resolved ? projectionResult.quantization.x.quantumClientPx ?? 0 : null
    const withinNoise = quantumPx !== null && projectionResult.crossCheckDelta <= quantumPx
    out.push(
      `- posFromClient 与 posFromEvt 的往返偏差：${projectionResult.crossCheckDelta.toFixed(4)} px → ${
        withinNoise ? '在量化噪声内，两者语义一致 ✓' : '⚠️ 超出量化噪声，两者语义可能不同（本插件以 posFromEvt 为准）'
      }`,
    )
  }
  if (projectionResult.notes.length > 0) {
    for (const note of projectionResult.notes) out.push(`- ⚠️ ${note}`)
  }
  out.push('')

  const quantizationForThreshold = projectionResult.quantization
  const quantumWorldForThreshold =
    quantizationForThreshold?.x.resolved && projectionResult.scale
      ? (quantizationForThreshold.x.quantumClientPx ?? 0) / projectionResult.scale
      : null

  const roundTrip = probeCoordinateRoundTrip(
    canvas,
    viewport,
    projectionResult.projection,
    viewportRect,
    quantumWorldForThreshold,
  )
  if (roundTrip.rows.length > 0) {
    out.push('| client (px) | posFromEvt → world | 锚点投影 → world | 中心公式 → world | 锚点Δ | 中心Δ |')
    out.push('|---|---|---|---|---|---|')
    for (const row of roundTrip.rows) {
      out.push(
        `| ${row.client} | ${row.viaEvt} | ${row.viaProjection} | ${row.viaCenter} | ${row.deltaProjection.toFixed(4)} | ${row.deltaCenter.toFixed(4)} |`,
      )
    }
    out.push('')
    const quantumWorld =
      projectionResult.quantization?.x.resolved && projectionResult.scale
        ? (projectionResult.quantization.x.quantumClientPx ?? 0) / projectionResult.scale
        : null
    const projectionVerdict =
      quantumWorld !== null && roundTrip.maxDeltaProjection <= quantumWorld
        ? '✅ 已到达量化精度极限（残差 ≤ 一个量化步长）'
        : roundTrip.maxDeltaProjection < 2
          ? '✅ 偏差在 2 个世界单位以内（约 1 px），可用'
          : '❌ 仍有偏差，需继续排查'
    out.push(`- 锚点投影最大偏差：${roundTrip.maxDeltaProjection.toFixed(4)} 世界单位 → ${projectionVerdict}`)
    out.push(`- 中心公式最大偏差：${roundTrip.maxDeltaCenter.toFixed(4)}`)
    out.push(`- 中心公式判定：${roundTrip.legacyFormulaVerdict}`)
  } else {
    out.push('- 无法采样（缺少视口矩形或投影）')
  }
  out.push('')

  out.push('## 6. 量化探测（P6）')
  out.push('')
  const quantization = projectionResult.quantization
  if (!quantization) {
    out.push('- 探测失败（posFromEvt 不可用或视口过小）')
  } else {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : null
    out.push(`- devicePixelRatio：${dpr ?? '未知'}`)
    out.push('')
    out.push('| 方向 | 量子（世界单位） | 量子（CSS px） | 重复样本 | 已解析 | 说明 |')
    out.push('|---|---|---|---|---|---|')
    for (const [axis, estimate] of [
      ['水平', quantization.x],
      ['垂直', quantization.y],
    ] as const) {
      out.push(
        `| ${axis} | ${estimate.quantumWorld?.toFixed(6) ?? '—'} | ${estimate.quantumClientPx?.toFixed(6) ?? '—'} | ${estimate.duplicateCount}/${estimate.sampleCount} | ${estimate.resolved ? '✓' : '✗'} | ${estimate.note} |`,
      )
    }
    out.push('')
    const resolvedPx = quantization.x.resolved ? quantization.x.quantumClientPx : null
    if (resolvedPx !== null) {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : null
      out.push(`- 判定：\`posFromEvt\` **存在量化**，量子 = **${resolvedPx.toFixed(6)} CSS px**（横纵一致：${quantization.y.resolved ? '是' : '否'}）`)
      if (dpr !== null) {
        const inDevicePx = resolvedPx * dpr
        out.push(
          `  - 换算到设备像素 = ${inDevicePx.toFixed(4)}（devicePixelRatio=${dpr.toFixed(4)}）→ ${
            Math.abs(inDevicePx - 1) < 0.05
              ? '恰好一个设备像素，说明按设备像素取整'
              : '不是整数个设备像素 → 量化粒度是 **CSS 像素**，与显示器缩放无关'
          }`,
        )
      }
      out.push(
        `  - 由此得到噪声上界：每轴半个量子，二维合成 ${quantumNoiseBound(quantization.x.quantumWorld ?? 0).toFixed(4)} 世界单位`,
      )
      out.push(
        `  - 影响：只用 \`posFromEvt\` **无法**获得亚像素精度；多个样本反解缩放会产生 ±1.5% 散布，故缩放必须取变换矩阵。`,
      )
      out.push(
        `  - 对本插件无实质影响：地形按格吸附（格宽 40 世界单位），标记定位误差上限约 ${
          dpr !== null ? (quantumNoiseBound(quantization.x.quantumWorld ?? 0) * (projectionResult.scale ?? 1)).toFixed(2) : '—'
        } px。`,
      )
    } else {
      out.push('- 判定：未观察到量化（或采样步长仍不够细），`posFromEvt` 输出可视为连续')
    }
  }
  out.push('')

  out.push('## 7. 补丁可行性（P3）')
  out.push('')
  out.push(
    caps.canPatchViewport
      ? '- ✅ `markViewportChanged` 存在且可包装 → 可用事件驱动重绘（设计文档 §4.4 首选方案）'
      : '- ❌ `markViewportChanged` 不存在 → 必须降级到 rAF 轮询',
  )
  out.push('- ⚠️ 实测该回调在一次平移/缩放中会**逐帧触发多次**（首轮实测：6 次手势共 168 次），因此必须做视口去重与逐帧合并。')
  out.push('- 用命令「监视视口变化（Phase 0 探针）」实测：开启后平移/缩放画布，它会分别报告「事件总数」与「有效视口变化数」。')
  out.push('')

  out.push('## 8. 结论与下一步')
  out.push('')
  const ready = projectionResult.projection !== null && projectionResult.host !== null
  out.push(
    ready
      ? '- 适配层所需能力齐备（挂载点已确定、投影已建立），可进入 Phase 1（地图文档 + 网格 + 地形笔刷）。'
      : '- ⚠️ 挂载点或投影仍不可用：先把上面 ❌ 的项解决，否则渲染层无法与 Canvas 对齐。',
  )
  out.push('- 请把本报告整段贴回对话。')
  out.push('')

  return out.join('\n')
}
