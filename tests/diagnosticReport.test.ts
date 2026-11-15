/**
 * 诊断报告（`src/dev/diagnosticReport.ts`）的单元测试。
 *
 * 补的是 `FEATURE-AUDIT.md` §2 的缺口「**诊断报告无单测**」。
 * 这份报告是用户排查「Obsidian 版本漂移」的唯一输入（README「兼容性与已知限制」就是这么写的），
 * 所以每一节的**存在性、顺序与口径**都值得钉住 —— 少一节、少一句，用户就会拿着半份报告来问。
 *
 * 输入全是快照里的纯数据，不需要 Obsidian、不需要 DOM。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { projectionFrom } from '../src/core/projection.ts'
import { createEmptyMapDocument } from '../src/data/mapDocument.ts'
import type { ProjectionResult } from '../src/canvas/CanvasAdapter.ts'
import { renderDiagnosticReport, type DiagnosticSnapshot } from '../src/dev/diagnosticReport.ts'

/** 一份「什么都没开」的基线快照：每个用例只覆盖自己关心的那几个字段 */
function snapshot(over: Partial<DiagnosticSnapshot> = {}): DiagnosticSnapshot {
  return {
    environment: { generatedAt: '2026-11-15T00:00:00.000Z', apiVersion: '1.13.7', platform: 'desktop', userAgent: 'UA/1.0' },
    canvases: [{ path: '地图/世界.canvas', isActive: true }],
    totalLeafCount: 1,
    deferredLeafCount: 0,
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
    projection: null,
    viewportRect: null,
    devicePixelRatio: 1,
    overlayRects: [],
    nativeRects: [],
    canMeasureDom: false,
    ...over,
  }
}

function projectionResult(over: Partial<ProjectionResult> = {}): ProjectionResult {
  return {
    projection: projectionFrom({ x: 100, y: 50 }, { x: 0, y: 0 }, 1),
    anchorSource: 'closed-form',
    scale: 1,
    scaleSource: '2^tZoom',
    viewportRect: null,
    host: null,
    crossCheckDelta: 0.25,
    originDeltaPx: 0.5,
    scaleDelta: 0.0001,
    derivedOrigin: null,
    derivedOriginDelta: null,
    calibration: null,
    heldOutResidualWorld: null,
    quantization: null,
    notes: [],
    ...over,
  }
}

// ---------------------------------------------------------------- 第 1 节

test('没有已加载的 Canvas：第 1 节直接收尾，不再吐后面八节', () => {
  const report = renderDiagnosticReport(snapshot({ canvases: [], totalLeafCount: 3, deferredLeafCount: 3 }))
  assert.ok(report.includes('- 叶子总数：3 · 已加载：0 · 未加载/deferred：3'), '三个数都要报出来')
  assert.ok(report.includes('⚠️ 没有已加载的 Canvas 视图。请打开一个 .canvas 文件后重新运行诊断。'))
  assert.ok(!report.includes('## 2.'), '没有画布时不该出现第 2 节（否则是一份半残的报告）')
})

test('多个 Canvas：按顺序列出，活动那张打 ▶', () => {
  const report = renderDiagnosticReport(snapshot({
    canvases: [
      { path: '地图/世界.canvas', isActive: true },
      { path: '地图/地下.canvas', isActive: false },
    ],
    totalLeafCount: 2,
  }))
  assert.ok(report.includes('- ▶ 当前 #0 地图/世界.canvas'))
  assert.ok(report.includes('-    #1 地图/地下.canvas'), '非活动的叶子用空格占住「▶ 当前」的位置，保持对齐')
})

// ---------------------------------------------------------------- 第 2 / 3 节

test('第 2 节：未绑定地图时明说「未绑定」，而不是留空', () => {
  const report = renderDiagnosticReport(snapshot())
  assert.ok(report.includes('- 未绑定地图文档（当前画布没有对应的 .map.md）'))
})

test('第 2 节：definitions 在不在文件里，三种措辞分得开', () => {
  const inFile = renderDiagnosticReport(snapshot({ mapPath: 'a.map.md', mapVersion: 2, definitionsInFile: true }))
  assert.ok(inFile.includes('- 文件版本：v2 · definitions：在文件里（以文件为准）'))

  const legacy = renderDiagnosticReport(snapshot({ mapPath: 'a.map.md', mapVersion: 1, definitionsInFile: false }))
  assert.ok(legacy.includes('不在文件里（v1 老图'), 'v1 老图要说清「读到的是库级模板的内存快照」的前半句')

  const readOnly = renderDiagnosticReport(snapshot({ mapPath: 'a.map.md', mapVersion: 9, mapReadOnly: true, definitionsInFile: null }))
  assert.ok(readOnly.includes('- 文件版本：v9（只读：版本高于本插件）'), '只读必须显眼')
  assert.ok(readOnly.includes('definitions：未知'), '读不到时写「未知」，不要瞎猜')
})

test('第 3 节：三个解析来源各说自己的出处，图例那行带显示状态', () => {
  const report = renderDiagnosticReport(snapshot({ mapPath: 'a.map.md', layersSource: 'map', overlaysSource: 'library', showLegendSource: 'library', showLegend: false }))
  assert.ok(report.includes('- 图层可见性：`mapViews[a.map.md]`（这张图自己那一份）'))
  assert.ok(report.includes('- 覆盖层参数：库级模板（这张图没有自己的记录）'))
  assert.ok(report.includes('- 图例显隐：隐藏（库级模板（这张图没有自己的记录））'))
})

// ---------------------------------------------------------------- 第 4 / 5 / 6 节

test('第 4 节：没有文档时明说「无已加载」，有文档时按格数报规模', () => {
  const none = renderDiagnosticReport(snapshot())
  assert.ok(none.includes('- 当前选中：无'))
  assert.ok(none.includes('- 内容规模：无已加载的地图文档（启用地图层后可见）'))

  const doc = createEmptyMapDocument({})
  const some = renderDiagnosticReport(snapshot({ selection: '地块 0,0（森林）', document: doc }))
  assert.ok(some.includes('- 当前选中：地块 0,0（森林）'))
  assert.ok(some.includes('- 内容规模：地形 0 格 · 标记 0 · 文字 0 · 路径 0 · 区域 0'))
})

test('第 5 节：投影不可读时给一句话，并且不硬算后面两节', () => {
  const report = renderDiagnosticReport(snapshot())
  assert.ok(report.includes('- 投影不可读（没有可用的活动画布）'))
  assert.ok(!report.includes('## 6.'), '投影都没有，规模那节不该假装算得出来')
})

test('第 5 节：闭式裁决的五行数字齐全（缩放 / 原点 / 来源 / 偏差 / 往返）', () => {
  const report = renderDiagnosticReport(snapshot({ projection: projectionResult() }))
  assert.ok(report.includes('- 世界层挂载点 = 未找到（没有带缩放分量的变换元素）'))
  assert.ok(report.includes('- 缩放：1.000000000（来源：2^tZoom）'), '缩放保留 9 位')
  assert.ok(report.includes('- 原点：(100.000, 50.000)（client 坐标，对应世界 0,0）'))
  assert.ok(report.includes('- 判定来源：closed-form（闭式：wrapperRect 左上角 + 矩阵平移）'))
  assert.ok(report.includes('originDeltaPx=0.5000 · scaleDelta=0.000100'))
  assert.ok(report.includes('- 是否发生切换：否（闭式与采样一致，仍用闭式）'))
  assert.ok(report.includes('- posFromClient 往返偏差：0.2500 px'))
  assert.ok(report.includes('- 视口矩形：不可读（wrapperEl 不可用）'))
  assert.ok(report.includes('- world bbox：不可计算'))
})

test('第 5 节：非有限数一律显示破折号，不吐 NaN', () => {
  const report = renderDiagnosticReport(snapshot({ projection: projectionResult({ scale: Number.NaN, scaleDelta: null }) }))
  assert.ok(report.includes('- 缩放：—（来源：2^tZoom）'))
  assert.ok(report.includes('scaleDelta=—'))
  assert.ok(!report.includes('NaN'), '整份报告里不该出现 NaN')
})

test('第 6 节：投影与视口都有时，图元数 / 裁剪比 / placement 全部算出来', () => {
  const report = renderDiagnosticReport(snapshot({
    document: createEmptyMapDocument({}),
    projection: projectionResult(),
    viewportRect: { left: 0, top: 0, width: 800, height: 600 },
  }))
  assert.ok(report.includes('- 展平图元：地形 0 格（裁剪 0）· 路径 0（裁剪 0）· 区域 0（裁剪 0）'))
  assert.ok(report.includes('- 裁剪比：地形 — · 路径 — · 区域 —'), '分母为 0 时是破折号，不是 0.0%')
  assert.ok(report.includes('- placement：marker 0/0（保留 —）· label 0/0（保留 —）'))
  assert.ok(report.includes('- 浮层元素：我方 0 个 · 原生控件 0 个'))
})

// ---------------------------------------------------------------- 第 7 / 8 节

test('第 7 / 8 节：量不到 DOM 时两条都明说「读不到」，不留空白', () => {
  const report = renderDiagnosticReport(snapshot({ projection: projectionResult(), canMeasureDom: false }))
  assert.ok(report.includes('- 读不到视图容器（view.containerEl 的 querySelector 不可用）—— 这一条只能人工看左上角。'))
  assert.ok(report.includes('- 判定口径：**重叠面积 > 0 才算重叠**'))
  assert.ok(report.includes('- 读不到视图容器，无法检查选择器命中。'))
})

test('第 8 节：量得到 DOM 时给命中数与「点名未找到」的反空转行', () => {
  const report = renderDiagnosticReport(snapshot({ projection: projectionResult(), canMeasureDom: true }))
  assert.ok(report.includes('- 选择器命中：0 / 3'), '三个我方浮层一个都没命中时要明说')
  assert.ok(report.includes('未找到：`.fc-toolbar`'), '没命中的类名要点名，否则「没有重叠」是空转')
  assert.ok(report.includes('- 命中数少于总数时会把没找到的类名点名出来 —— 那是 Obsidian 改了类名，不是「没有重叠」。'))
})

test('九节的编号与顺序固定（用户报问题时会说「第几节」）', () => {
  const report = renderDiagnosticReport(snapshot({
    document: createEmptyMapDocument({}),
    projection: projectionResult(),
    viewportRect: { left: 0, top: 0, width: 800, height: 600 },
    canMeasureDom: true,
  }))
  const headings = report.split('\n').filter((line) => /^## \d\./.test(line)).map((line) => line.slice(3, 4))
  assert.deepEqual(headings, ['1', '2', '3', '4', '5', '6', '7', '8', '9'], '九节必须都在，且按 1..9 排')
})
