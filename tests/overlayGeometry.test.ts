/**
 * 「浮层与原生控件是否重叠」的纯几何判定（`ISSUES.md` ISSUE-004 §4 第 5 条）。
 *
 * 为什么值得单测：这条结论过去只能靠人在真实库里目测，而"没找到元素"与"没重叠"
 * 在报告里长得一模一样 —— 于是这条纪律必须由断言钉住：**枚举了多少组就写多少组**，
 * 空列表要单独说"没有可测量的浮层"，而不是悄悄给一个 ✅。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { describeOverlayCollisions, describeSelectorCoverage, rectFromBounds, rectsOverlap, type ElementRect } from '../src/dev/overlayGeometry.ts'

function rect(name: string, left: number, top: number, right: number, bottom: number): ElementRect {
  return { name, left, top, right, bottom }
}

test('rectsOverlap：面积 > 0 才算重叠，贴边不算', () => {
  const a = rect('a', 0, 0, 10, 10)
  assert.equal(rectsOverlap(a, rect('b', 5, 5, 15, 15)), true, '交叠一块必须算重叠')
  assert.equal(rectsOverlap(a, rect('b', 0, 0, 10, 10)), true, '完全重合也算重叠')
  assert.equal(rectsOverlap(a, rect('b', 10, 0, 20, 10)), false, '右边贴边（x 从 10 开始）不算重叠')
  assert.equal(rectsOverlap(a, rect('b', 0, 10, 10, 20)), false, '下边贴边不算重叠')
  assert.equal(rectsOverlap(a, rect('b', 20, 20, 30, 30)), false, '完全分离不算重叠')
  assert.equal(rectsOverlap(a, rect('b', 1, 1, 2, 2)), true, '被包含也算重叠')
})

test('rectFromBounds：right/bottom 缺失时用 width/height 兜底，left/top 缺失则不报', () => {
  assert.deepEqual(rectFromBounds('.fc-toolbar', { left: 8, top: 8, right: 120, bottom: 40 }), {
    name: '.fc-toolbar',
    left: 8,
    top: 8,
    right: 120,
    bottom: 40,
  })
  assert.deepEqual(rectFromBounds('.fc-toolbar', { left: 8, top: 8, width: 112, height: 32 }), {
    name: '.fc-toolbar',
    left: 8,
    top: 8,
    right: 120,
    bottom: 40,
  })
  assert.equal(rectFromBounds('.fc-toolbar', { top: 8, width: 112, height: 32 }), null, '没有 left 的桩不能报成 (0,0)')
  assert.equal(rectFromBounds('.fc-toolbar', null), null, '拿不到 rect 时返回 null（调用方会跳过这一项）')
  assert.equal(rectFromBounds('.fc-toolbar', { left: Number.NaN, top: 8 }), null, 'NaN 不是数字')
})

test('describeOverlayCollisions：全不重叠时写清比了多少组', () => {
  const lines = describeOverlayCollisions(
    [rect('.fc-toolbar', 8, 8, 128, 48)],
    [rect('.canvas-controls', 400, 600, 480, 640), rect('.canvas-card-menu', 200, 640, 400, 680)],
  )
  assert.ok(lines.some((line) => line.includes('✅ 逐对比较 2 组，没有一组重叠')), lines.join('\n'))
  assert.ok(lines.some((line) => line.includes('我方浮层（1）')), '要列出我方浮层')
  assert.ok(lines.some((line) => line.includes('原生控件（2）')), '要列出原生控件')
})

test('describeOverlayCollisions：有重叠时报出每一对的尺寸，不吞掉', () => {
  const lines = describeOverlayCollisions(
    [rect('.fc-toolbar', 8, 8, 128, 48)],
    [rect('.view-header', 0, 0, 600, 40)],
  )
  const hit = lines.find((line) => line.includes('⚠️') && line.includes('组重叠'))
  assert.ok(hit !== undefined, lines.join('\n'))
  assert.ok(hit.includes('`.fc-toolbar` × `.view-header` = 120×32 px'), hit)
})

test('describeOverlayCollisions：两个空条件分开说，不能都写成 ✅', () => {
  const noOverlay = describeOverlayCollisions([], [rect('.view-header', 0, 0, 600, 40)])
  assert.equal(noOverlay.length, 1)
  const first = noOverlay[0] ?? ''
  assert.ok(first.includes('没有可测量的浮层'), noOverlay.join('\n'))
  const noNative = describeOverlayCollisions([rect('.fc-toolbar', 8, 8, 128, 48)], [])
  assert.ok(noNative.some((line) => line.includes('⚠️') && line.includes('没有找到 Obsidian 画布原生控件')), noNative.join('\n'))
})

test('describeOverlayCollisions：零尺寸的浮层不算数（隐藏元素 getBoundingClientRect 会给 0×0）', () => {
  const lines = describeOverlayCollisions(
    [rect('.fc-toolbar', 0, 0, 0, 0), rect('.fc-legend', 8, 8, 100, 60)],
    [rect('.view-header', 0, 0, 600, 40)],
  )
  assert.ok(lines.some((line) => line.includes('我方浮层（1）')), lines.join('\n'))
})

test('describeSelectorCoverage：全部命中时明说命中数', () => {
  const line = describeSelectorCoverage(
    ['.fc-toolbar', '.fc-legend'],
    [rect('.fc-toolbar', 8, 8, 128, 48), rect('.fc-legend', 8, 8, 100, 60)],
  )
  assert.equal(line, '- 选择器命中：2 / 2（全部命中）')
})

test('describeSelectorCoverage：没命中的选择器要点名（类名会随 Obsidian 版本变化）', () => {
  assert.equal(
    describeSelectorCoverage(['.fc-toolbar', '.fc-selection-card', '.fc-legend'], [rect('.fc-toolbar', 8, 8, 128, 48)]),
    '- 选择器命中：1 / 3（未找到：`.fc-selection-card` / `.fc-legend`）',
  )
  assert.equal(describeSelectorCoverage(['.a'], []), '- 选择器命中：0 / 1（未找到：`.a`）', '一个都没找到时要显眼，不能只说 0 / 1')
})

