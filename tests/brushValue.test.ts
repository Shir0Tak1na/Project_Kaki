/**
 * 数值图层笔刷的逐格算法（`src/editor/brushValue.ts`）。
 *
 * 补的是 `FEATURE-AUDIT.md` §2 记的那条缺口：「**深度笔刷无专测**」——
 * 温度 / 深度 / 任意自定义数值字段走的是同一段算式，以前只有冒烟场景 42 / 43 / 49 间接碰过，
 * 而冒烟只验"笔刷能不能画"，验不到"这一格**该不该**被写"。
 *
 * 每条断言对应施工文件 §E 那两张表的一格，能独立判对错。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBrushOp, brushCellValue } from '../src/editor/brushValue.ts'

// ---------------------------------------------------------------- 算式本身

test('set：把当前值原样写进去', () => {
  assert.equal(applyBrushOp('set', undefined, 5, undefined), 5, '没有值的格也能被 set 写入')
  assert.equal(applyBrushOp('set', 3, 5, undefined), 5, '有值时直接覆盖')
  assert.equal(applyBrushOp('set', 3, -2, 12), -2, 'set 不读每格默认值')
})

test('set：非有限数一律算不出来（不写 NaN / Infinity 进地图文件）', () => {
  assert.equal(applyBrushOp('set', undefined, Number.NaN, undefined), undefined)
  assert.equal(applyBrushOp('set', undefined, Number.POSITIVE_INFINITY, undefined), undefined)
  assert.equal(applyBrushOp('set', 7, Number.NEGATIVE_INFINITY, undefined), undefined)
})

test('＋ / －：没有值时从"每格默认值"起算', () => {
  assert.equal(applyBrushOp('+', 10, 3, undefined), 13)
  assert.equal(applyBrushOp('-', 10, 3, undefined), 7)
  assert.equal(applyBrushOp('+', undefined, 3, 20), 23, '无值格：默认值 + 3')
  assert.equal(applyBrushOp('-', undefined, 3, 20), 17, '无值格：默认值 - 3')
  assert.equal(applyBrushOp('+', undefined, 3, undefined), 3, '连默认值都没有就从 0 起算')
  assert.equal(applyBrushOp('-', undefined, 4, undefined), -4, '0 - 4 = -4（深度允许负值）')
})

test('＋ / －：结果不是有限数时算不出来', () => {
  assert.equal(applyBrushOp('+', Number.MAX_VALUE, Number.MAX_VALUE, undefined), undefined)
  assert.equal(applyBrushOp('-', undefined, Number.POSITIVE_INFINITY, undefined), undefined)
})

test('× / ÷：遇到没有值的格**不动**（不拿"没量过"去乘）', () => {
  assert.equal(applyBrushOp('×', undefined, 2, 50), undefined, '默认值也不参与乘法')
  assert.equal(applyBrushOp('÷', undefined, 2, 50), undefined, '默认值也不参与除法')
  assert.equal(applyBrushOp('×', 10, 2, undefined), 20)
  assert.equal(applyBrushOp('÷', 10, 4, undefined), 2.5)
})

test('÷ 0：算式层也拒绝（最后一道保险，UI 会先整笔拦下）', () => {
  assert.equal(applyBrushOp('÷', 10, 0, undefined), undefined, '10 / 0 = Infinity ⇒ 算不出来')
  assert.equal(applyBrushOp('÷', 0, 0, undefined), undefined, '0 / 0 = NaN ⇒ 算不出来')
})

// ---------------------------------------------------------------- 这一格动不动

test('值相同就不动：重刷一遍不会产生空历史', () => {
  assert.equal(brushCellValue('set', 5, 5, undefined), undefined, 'set 成同一个数')
  assert.equal(brushCellValue('+', 5, 0, undefined), undefined, '+ 0')
  assert.equal(brushCellValue('×', 5, 1, undefined), undefined, '× 1')
  assert.equal(brushCellValue('-', 5, 0, 12), undefined, '- 0')
})

test('没有值的格被 set 是一次**真实写入**（"相同"只对已有值成立）', () => {
  assert.equal(brushCellValue('set', undefined, 0, undefined), 0, '无值 → 0 是变化')
  assert.equal(brushCellValue('set', undefined, 5, 5), 5, '默认值也是 5，但仍然要写进这一格')
})

test('有值且结果不同 ⇒ 照常写入', () => {
  assert.equal(brushCellValue('+', 5, 3, undefined), 8)
  assert.equal(brushCellValue('×', 5, 2, undefined), 10)
  assert.equal(brushCellValue('set', 5, 8, undefined), 8)
})

// ---------------------------------------------------------------- 深度笔刷（本条补的缺口）

test('深度笔刷：× / ÷ 只作用于**量过深度**的格，没量过的格子保持原样', () => {
  // 深度字段的 cellKey 就是 'depth'（`overlayFields.ts` 里 `id: 'depth', layerId: 'depth', cellKey: 'depth'`）
  const raised = brushCellValue('×', 2, 3, undefined)
  assert.equal(raised, 6, '量过的格：2 × 3 = 6')
  const untouched = brushCellValue('×', undefined, 3, 0)
  assert.equal(untouched, undefined, '没量过的格：不写 0，也不写 0×3')
})

test('深度笔刷：＋ / － 会把"每格默认值"固化进这一格（刻意行为，UI 已写明）', () => {
  assert.equal(brushCellValue('+', undefined, 1, 100), 101, '默认深度 100 + 1')
  assert.equal(brushCellValue('+', 100, 0, 100), undefined, '本来就是 100，+0 之后仍是 100 ⇒ 不动')
  assert.equal(brushCellValue('+', undefined, 0, 0), 0, '无值格 +0 仍然是**一次写入**（0 从此固化进这一格），不是"不变"')
})
