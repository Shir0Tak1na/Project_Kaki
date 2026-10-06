/**
 * 「当前在操作哪张 Canvas」的判据测试（ISSUE-007）。
 *
 * 用户报的"致命问题"是：切到一篇普通笔记之后，侧栏面板照旧显示上一张 Canvas 的工具与读数，
 * 按钮点下去还会写进那张**已经不在前台**的画布。根因是 `activeCanvasHandle()` 的退路
 * `?? handles[0]` 只问"哪张画布开着"，从不问"用户在不在看它"。
 *
 * 这一份盯的是那条退路的三种情形（下表就是修法里那张结论表）：
 *
 * | 活动叶子是什么 | 结论 |
 * |---|---|
 * | 某张 Canvas | 就是它 |
 * | **别的文档**（markdown / PDF…） | **没有当前画布**（`null`） |
 * | 插件自己的面板 / 没有文档的视图 | 沿用"最近那张画布"（退路的正当用途） |
 *
 * 冒烟（场景 53）验的是端到端结果（面板空态、按钮置灰）；这里验的是判据本身，
 * 不依赖任何 DOM。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { activeCanvasHandle, activeViewIsOtherDocument, findCanvasHandles } from '../src/canvas/CanvasAdapter.ts'

/** 最小可用形状：`findCanvasHandles` 只要求 `view.canvas` 是个对象 */
function makeCanvasLeaf(path: string) {
  return {
    isDeferred: false,
    view: {
      canvas: {},
      file: { path },
      getViewType: () => 'canvas',
    },
  }
}

function makeDocumentLeaf(path: string, viewType = 'markdown') {
  return { view: { file: { path }, getViewType: () => viewType } }
}

/** 插件自己的面板：**没有 `file`** —— 这正是"退路仍该生效"的那一档 */
function makeFilelessLeaf(viewType = 'fictional-cartographer-panel') {
  return { view: { getViewType: () => viewType } }
}

function makeApp(leaves: unknown[], activeLeaf: unknown) {
  return {
    workspace: {
      getLeavesOfType: (type: string) => (type === 'canvas' ? leaves : []),
      getMostRecentLeaf: () => activeLeaf,
      activeLeaf,
    },
  } as never
}

test('活动叶子就是那张画布时，返回它', () => {
  const canvasLeaf = makeCanvasLeaf('Maps/A.canvas')
  const app = makeApp([canvasLeaf], canvasLeaf)
  const handle = activeCanvasHandle(app)
  assert.equal(handle?.file?.path, 'Maps/A.canvas')
  assert.equal(activeViewIsOtherDocument(app), false)
})

test('活动叶子是别的文档（画布仍开在后台）⇒ 没有当前画布', () => {
  const canvasLeaf = makeCanvasLeaf('Maps/A.canvas')
  const noteLeaf = makeDocumentLeaf('Notes/a.md')
  const app = makeApp([canvasLeaf], noteLeaf)
  assert.equal(activeViewIsOtherDocument(app), true, '有 file 且不是 canvas ⇒ 用户在看别的文档')
  assert.equal(activeCanvasHandle(app), null, '不许退回后台那张画布（ISSUE-007 的主入口）')
  // 画布本身仍然"开着"：这条只是"没有当前画布"，不是"没有画布"
  assert.equal(findCanvasHandles(app).totalLeaves, 1)
})

test('活动叶子是 PDF 之类的别的视图类型，同样算"在看别的文档"', () => {
  const canvasLeaf = makeCanvasLeaf('Maps/A.canvas')
  const app = makeApp([canvasLeaf], makeDocumentLeaf('Papers/x.pdf', 'pdf'))
  assert.equal(activeViewIsOtherDocument(app), true)
  assert.equal(activeCanvasHandle(app), null)
})

test('活动叶子是插件自己的面板（没有 file）⇒ 退路仍然生效', () => {
  const canvasLeaf = makeCanvasLeaf('Maps/A.canvas')
  const app = makeApp([canvasLeaf], makeFilelessLeaf())
  assert.equal(activeViewIsOtherDocument(app), false, '没有文档的视图不算"在看别的文档"')
  assert.equal(
    activeCanvasHandle(app)?.file?.path,
    'Maps/A.canvas',
    '点侧栏 / 点面板自己时不该丢掉当前画布（退路当初就是为它写的）',
  )
})

test('一张画布都没开 ⇒ 返回 null（与改动前一致）', () => {
  const noteLeaf = makeDocumentLeaf('Notes/a.md')
  const app = makeApp([], noteLeaf)
  assert.equal(activeCanvasHandle(app), null)
})

test('取不到活动视图（getMostRecentLeaf 返回 null）时退回 activeLeaf', () => {
  const canvasLeaf = makeCanvasLeaf('Maps/A.canvas')
  const app = {
    workspace: {
      getLeavesOfType: (type: string) => (type === 'canvas' ? [canvasLeaf] : []),
      getMostRecentLeaf: () => null,
      activeLeaf: canvasLeaf,
    },
  } as never
  assert.equal(activeCanvasHandle(app)?.file?.path, 'Maps/A.canvas')
})