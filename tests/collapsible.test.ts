/**
 * 折叠分组（`collapsible.ts`）的契约测试。
 *
 * 这个文件盯的是一件具体的事：**`open = false` 必须由我们自己显式写出来**。
 *
 * `<details>` 在真实浏览器里默认就是收起，所以"不写也能跑"；但测试与渲染计划里用的
 * 假 DOM 只是普通对象 —— 不显式赋值就没有 `open` 这个成员，"默认收起"的断言会**静默失效**
 * （断言 `open === false` 时读到 `undefined`，或者干脆没人去读）。
 * 设置页、弹窗、侧栏检查器三处共用这一份实现，就是为了让这条细节只在一个地方成立。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createCollapsibleGroup } from '../src/ui/collapsible.ts'

interface FakeEl {
  tagName: string
  className: string
  textContent: string
  dataset: Record<string, string>
  children: FakeEl[]
  open?: boolean
  createEl: (tagName: string, options?: { cls?: string; text?: string }) => FakeEl
}

function makeEl(tagName: string, options: { cls?: string; text?: string } = {}): FakeEl {
  const el: FakeEl = {
    tagName,
    className: options.cls ?? '',
    textContent: options.text ?? '',
    dataset: {},
    children: [],
    createEl: (childTag, childOptions) => {
      const child = makeEl(childTag, childOptions)
      el.children.push(child)
      return child
    },
  }
  return el
}

const asEl = (el: FakeEl): HTMLElement => el as unknown as HTMLElement

test('建出来的是 <details>，且**显式**写死 open = false（假 DOM 里才读得到这个成员）', () => {
  const parent = makeEl('div')
  const group = createCollapsibleGroup(asEl(parent), { title: '图层' })
  const details = group as unknown as FakeEl
  assert.equal(details.tagName, 'details')
  assert.equal(details.open, false, '必须是显式的 false —— 否则"默认收起"的断言在假 DOM 里会空转')
})

test('标题写在 <summary> 里（点击展开靠它），不是普通 div', () => {
  const parent = makeEl('div')
  const details = createCollapsibleGroup(asEl(parent), { title: '新对象默认值' }) as unknown as FakeEl
  const summary = details.children[0]
  assert.equal(summary?.tagName, 'summary')
  assert.equal(summary?.textContent, '新对象默认值')
})

test('默认沿用侧栏检查器那套类名（面板三组用的就是默认值）', () => {
  const parent = makeEl('div')
  const details = createCollapsibleGroup(asEl(parent), { title: '类型' }) as unknown as FakeEl
  assert.equal(details.className, 'fc-selection-group')
  assert.equal(details.children[0]?.className, 'fc-selection-group-title')
})

test('给了 cls / titleCls 就用给的（设置页与弹窗各有一套自己的类名）', () => {
  const parent = makeEl('div')
  const details = createCollapsibleGroup(asEl(parent), {
    title: '地形',
    cls: 'fc-defmodal-group',
    titleCls: 'fc-defmodal-group-title',
  }) as unknown as FakeEl
  assert.equal(details.className, 'fc-defmodal-group')
  assert.equal(details.children[0]?.className, 'fc-defmodal-group-title')
})

test('role 写进 dataset.fcGroup（测试按角色定位，不依赖会改的标题文字）', () => {
  const parent = makeEl('div')
  const withRole = createCollapsibleGroup(asEl(parent), { title: '地形', role: 'terrain' }) as unknown as FakeEl
  assert.equal(withRole.dataset.fcGroup, 'terrain')
  // 不给 role 时不该凭空多出一个空字符串成员（那会让"按角色筛选"出现意外命中）
  const withoutRole = createCollapsibleGroup(asEl(parent), { title: '图层' }) as unknown as FakeEl
  assert.equal('fcGroup' in withoutRole.dataset, false)
})

test('返回的是那个 <details> 本身（调用方要往里继续建内容）', () => {
  const parent = makeEl('div')
  const group = createCollapsibleGroup(asEl(parent), { title: '图层' })
  ;(group as unknown as FakeEl).createEl('div', { cls: 'inner' })
  assert.equal((group as unknown as FakeEl).children.length, 2, 'summary + 后续加进去的内容')
  assert.equal(parent.children.length, 1, '组被挂到传入的父元素上')
})