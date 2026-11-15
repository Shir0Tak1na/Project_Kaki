/**
 * Base 表格分批显示的窗口计算。
 *
 * 这些断言防的是「漏行」与「重复画同一行」—— 分批渲染最容易犯的两种错，肉眼很难发现
 * （表格看起来是满的，只是某几行不见了或出现两次）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { BASE_ROW_CHUNK, nextRowWindow } from '../src/base/rowWindow.ts'

test('没有行：窗口是空的，也不该出现「再显示」', () => {
  assert.deepEqual(nextRowWindow(0, 0), { start: 0, end: 0, shown: 0, remaining: 0 })
})

test('少于一批：一次画完，没有剩余', () => {
  assert.deepEqual(nextRowWindow(37, 0), { start: 0, end: 37, shown: 37, remaining: 0 })
})

test('正好一批：画完，没有剩余', () => {
  assert.deepEqual(nextRowWindow(BASE_ROW_CHUNK, 0), {
    start: 0,
    end: BASE_ROW_CHUNK,
    shown: BASE_ROW_CHUNK,
    remaining: 0,
  })
})

test('超过一批：第二批从上一批的终点接着画（不漏不重）', () => {
  const first = nextRowWindow(250, 0)
  assert.deepEqual(first, { start: 0, end: 100, shown: 100, remaining: 150 })
  const second = nextRowWindow(250, first.shown)
  assert.deepEqual(second, { start: 100, end: 200, shown: 200, remaining: 50 })
  const third = nextRowWindow(250, second.shown)
  assert.deepEqual(third, { start: 200, end: 250, shown: 250, remaining: 0 }, '最后一批只补差额，不越界')
})

test('脏输入被收敛：负数 / 非有限数 / 越界的 shown 都不会让区间错位', () => {
  assert.deepEqual(nextRowWindow(Number.NaN, Number.NaN), { start: 0, end: 0, shown: 0, remaining: 0 })
  assert.deepEqual(nextRowWindow(10, -5), { start: 0, end: 10, shown: 10, remaining: 0 })
  assert.deepEqual(nextRowWindow(10, 999), { start: 10, end: 10, shown: 10, remaining: 0 }, '已经画完就停在末尾')
  assert.deepEqual(nextRowWindow(10, 0, 0), { start: 0, end: 10, shown: 10, remaining: 0 }, 'chunk 非法时退回默认 100')
})
