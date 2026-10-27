/**
 * 数值图层的**画布绘制**（`overlayDraw.ts`）单测 —— 本文件只盯一件事：
 * **混合模式在绘制期间真的被设进了画布、画完被还原**。
 *
 * 为什么值得单开一个文件：`overlayDraw` 碰 canvas 但**不 import obsidian**，所以能给一个
 * 假 ctx 断言"状态改成什么、什么时候改的、最后有没有还回去"。这条断言正是
 * `BORROWED-IDEAS.md` §3.1 的验收口径 —— 没有它，"加了混合模式"就只是"加了一个下拉"，
 * 底层到底有没有生效、有没有把画布状态留给下一层，全靠肉眼。
 *
 * 几何不在这里测（逐格多边形的取数 / 插值在 `overlayPlan` / `fieldPlan` 各自的单测里）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { projectionFrom } from '../src/core/projection.ts'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import { buildRenderPlan, worldToRaster } from '../src/render/renderPlan.ts'
import { drawOverlayLayer, type OverlayDrawContext } from '../src/render/overlayDraw.ts'
import { DEFAULT_OVERLAY_STYLES, overlayField, type BlendMode, type OverlayStyle } from '../src/render/overlayFields.ts'

/** 与 Phase 0 实测一致的量级（同 `renderPlan.test.ts`）：视口中心附近能看见原点那几格 */
const SCALE = 0.44669732651951655
const DPR = 1.6500000953674316
const VIEWPORT = { left: 344.6, top: 78.9, width: 681, height: 724 }
const projection = projectionFrom({ x: 685, y: 441 }, { x: 100, y: 50 }, SCALE)

function makeDocument(): MapDocument {
  const doc = createEmptyMapDocument({ size: 40, orientation: 'pointy' })
  // 都在温度色带之内（不产生越界数值文字），于是这一帧只有多边形
  doc.terrain['0_0'] = { t: 'forest', temp: 15 }
  doc.terrain['1_0'] = { t: 'water', temp: 5 }
  doc.terrain['2_0'] = { t: 'plains', temp: 25 }
  return doc
}

/**
 * 假 ctx：够画逐格多边形，并**记录每次 `fill()` 当刻的合成模式**。
 *
 * 记录"填充发生在什么模式之下"而不是只看最终值 —— 否则"设了又立刻还原"这种
 * 空转实现也能骗过断言（本项目对"空转断言"有过教训，见 §5.53）。
 */
function makeFakeContext(initialComposite: string) {
  const compositeAtFill: string[] = []
  const context = {
    font: '10px sans-serif',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    globalAlpha: 1,
    globalCompositeOperation: initialComposite,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    getLineDash: () => [] as number[],
    setLineDash: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => {
      compositeAtFill.push(context.globalCompositeOperation)
    },
    stroke: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    fillText: () => {},
    strokeText: () => {},
    drawImage: () => {},
  }
  return { context, compositeAtFill }
}

function runDraw(blend: BlendMode, initialComposite = 'source-over') {
  const document = makeDocument()
  const plan = buildRenderPlan({ document, projection, viewportRect: VIEWPORT, devicePixelRatio: DPR })
  assert.ok(plan !== null, '这一组测试的前提是可绘制的视口')
  const { context, compositeAtFill } = makeFakeContext(initialComposite)
  const style: OverlayStyle = { ...DEFAULT_OVERLAY_STYLES.temperature, mode: 'cell', blend }
  const drawContext: OverlayDrawContext = {
    ctx: context as unknown as CanvasRenderingContext2D,
    toRaster: (x, y) => worldToRaster(plan!.layer, x, y),
    plan: plan!,
    document,
    overlay: { spec: overlayField('temperature'), style },
  }
  const result = drawOverlayLayer(drawContext)
  return { result, context, compositeAtFill }
}

test('混合模式在绘制期间生效：填充发生在 multiply 之下', () => {
  const { result, context, compositeAtFill } = runDraw('multiply')
  assert.ok(result.drawn > 0, '这一帧确实画了色块（否则下面的断言是空转）')
  assert.ok(compositeAtFill.length >= result.drawn, `每次色块填充都要记一笔（${compositeAtFill.length} vs ${result.drawn}）`)
  assert.ok(
    compositeAtFill.every((value) => value === 'multiply'),
    `色块必须在 multiply 之下填充，实际：${compositeAtFill.join(',')}`,
  )
  assert.equal(context.globalCompositeOperation, 'source-over', '画完要还原成进入这一层之前的模式')
})

test('还原的是**进入这一层之前**的模式，而不是写死的 source-over', () => {
  // 调用方可能正处在别的模式下（将来若支持图层组 / 叠加合成），还原不能想当然
  const { context, compositeAtFill } = runDraw('screen', 'multiply')
  assert.ok(compositeAtFill.every((value) => value === 'screen'), `本层用 screen，实际：${compositeAtFill.join(',')}`)
  assert.equal(context.globalCompositeOperation, 'multiply', '还原成进入这一层之前的 multiply，而不是 source-over')
})

test('对照组：出厂模式（正常）下填充发生在 source-over 之下', () => {
  // 反向对照 —— 证明上面两条断言有鉴别力："模式没变"与"模式被改成了对的值"是两件事
  const { compositeAtFill } = runDraw('source-over')
  assert.ok(compositeAtFill.length > 0)
  assert.ok(compositeAtFill.every((value) => value === 'source-over'), compositeAtFill.join(','))
})