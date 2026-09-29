/**
 * 选择系统 §C 的**格选择**单元测试：框选几何、三种集合运算、以及编辑器那一层的接线。
 *
 * 为什么值得单独钉：这一层全是"手势 + 状态"，最容易出的问题不是崩溃而是**语义悄悄变了** ——
 * 「Alt 取消单格」变成"集合取补"、「Shift 加选」把原来的选择冲掉、
 * 或者"框选"在缩放后框到的东西与看到的不一致。这些在实机上都不容易一眼看出来。
 *
 * 这里刻意**不测指针事件**（那是冒烟的活）：只测"给定世界坐标与修饰键，选择该变成什么"。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { axialToWorld, cellKey, type GridSpec } from '../src/core/hex.ts'
import { createEmptyMapDocument, type MapDocument, type TerrainCell } from '../src/data/mapDocument.ts'
import { MapEditor } from '../src/editor/MapEditor.ts'
import {
  applySelectionOperation,
  cellsInRect,
  expandSelectionByTerrain,
  normalizeSelection,
} from '../src/render/selectionSet.ts'
import { emptyRuleGroup, type RuleGroup } from '../src/render/selectionRules.ts'

const GRID: GridSpec = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }

function doc(cells: Array<[number, number, TerrainCell]>): MapDocument {
  const document = createEmptyMapDocument({ size: 40 })
  for (const [q, r, cell] of cells) document.terrain[cellKey(q, r)] = cell
  return document
}

/** 格心的世界坐标（与 `cellsInRect` 判据同一条：判的是格心） */
function center(q: number, r: number): { x: number; y: number } {
  return axialToWorld(GRID, q, r)
}

function makeEditor(document: MapDocument): MapEditor {
  return new MapEditor({
    getDocument: () => document,
    onChanged: () => {
      /* 单测不关心重绘 */
    },
  })
}

// ---------------------------------------------------------------- 框选几何

test('cellsInRect：只收「格心落在矩形里」的格（判据是格心，不是相交）', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'forest' }],
    [-1, 0, { t: 'forest' }],
    [0, 1, { t: 'forest' }],
  ])
  // 从 (0,0) 格心拉到 (1,0) 格心：这是一条 y 恒为 0 的退化矩形，
  // 只有 y === 0 的格心落在里面 —— (-1,0) 在左边、 (0,1) 在下边，都不该进来
  const keys = cellsInRect(document, GRID, center(0, 0), center(1, 0))
  assert.deepEqual([...keys], ['0_0', '1_0'])
})

test('cellsInRect：**只收地图里已有的格**（空区域不给选择，那是笔刷的活）', () => {
  const document = doc([[0, 0, { t: 'forest' }]])
  // 矩形盖住一大片（含很多不存在的格），但只有 0_0 真的在地图里
  const keys = cellsInRect(document, GRID, { x: -100, y: -100 }, { x: 100, y: 100 })
  assert.deepEqual([...keys], ['0_0'])
})

// ---------------------------------------------------------------- 三种集合运算

test('applySelectionOperation：并入保留原有、移出不是取补、替换才是覆盖', () => {
  const base = normalizeSelection(['0_0', '1_0'])
  assert.deepEqual([...applySelectionOperation(base, ['2_0'], 'add')], ['0_0', '1_0', '2_0'])
  assert.deepEqual([...applySelectionOperation(base, ['1_0'], 'remove')], ['0_0'], '移出只删点到的那些')
  assert.deepEqual([...applySelectionOperation(base, ['9_9'], 'remove')], ['0_0', '1_0'], '移出一个不在选择里的格不改变什么')
  assert.deepEqual([...applySelectionOperation(base, ['2_0'], 'replace')], ['2_0'])
})

// ---------------------------------------------------------------- 框选拖动

test('框选拖动：按下不拖动 = 不是拖动（抬手交给单击语义）；拖动过才算框选', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'forest' }],
  ])
  const editor = makeEditor(document)

  editor.beginCellDrag(center(0, 0), 'replace')
  assert.equal(editor.endCellDrag(), false, '没调用过 updateCellDrag = 没拖动过')
  assert.deepEqual([...editor.getCellSelection()], [], '没拖动过就不该凭空选出东西')

  editor.beginCellDrag(center(0, 0), 'replace')
  editor.updateCellDrag(center(1, 0))
  assert.equal(editor.endCellDrag(), true, '更新过就是拖动过')
  assert.deepEqual([...editor.getCellSelection()], ['0_0', '1_0'])
})

test('框选拖动：Shift 加选以「按下时的选择」为底，不会把自己越叠越多', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'forest' }],
    [2, 0, { t: 'forest' }],
  ])
  const editor = makeEditor(document)
  editor.setCellSelection(['2_0'])

  editor.beginCellDrag(center(0, 0), 'add')
  // 同一个矩形连算三次（真实拖动每帧都会重算）：结果必须稳定
  editor.updateCellDrag(center(1, 0))
  editor.updateCellDrag(center(1, 0))
  editor.updateCellDrag(center(1, 0))
  editor.endCellDrag()
  assert.deepEqual([...editor.getCellSelection()], ['0_0', '1_0', '2_0'])
})

// ---------------------------------------------------------------- 单击语义

test('单击：命中地块 = 格选择恰好一格且对象选中同步；命中标记 = 格选择清空', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [2, 0, { t: 'forest' }],
  ])
  document.markers.push({ id: 'mk-1', label: '港口', p: [0, 0], icon: 'town' })
  const editor = makeEditor(document)

  // (2,0) 上没有标记 → 命中地块
  editor.selectAtPoint(center(2, 0), 6)
  assert.deepEqual([...editor.getCellSelection()], ['2_0'])
  assert.deepEqual(editor.getSelection(), { kind: 'cell', id: '2_0' })

  // (0,0) 上有标记 → 标记优先命中，格选择被清空（信息卡不该同时显示两边）
  editor.selectAtPoint(center(0, 0), 6)
  assert.deepEqual([...editor.getCellSelection()], [])
  assert.deepEqual(editor.getSelection(), { kind: 'marker', id: 'mk-1' })
})

test('单击加选 / 取消单格：Shift 加进来、Alt 拿出去；且**不进撤销栈**', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'forest' }],
  ])
  const editor = makeEditor(document)

  editor.toggleCellAt(center(0, 0), 'add')
  editor.toggleCellAt(center(1, 0), 'add')
  assert.deepEqual([...editor.getCellSelection()], ['0_0', '1_0'])
  assert.equal(editor.getStatus().undo, 0, '选择不是对地图的修改，不该产生历史')

  editor.toggleCellAt(center(0, 0), 'remove')
  assert.deepEqual([...editor.getCellSelection()], ['1_0'], 'Alt 只拿掉点到的那一格')

  // 点在一格空白上（地图里没有这一格）→ 什么都不发生，而不是"新增一个空格"
  editor.toggleCellAt(center(5, 5), 'add')
  assert.deepEqual([...editor.getCellSelection()], ['1_0'])
})

test('多格选择时不保留「对象选中」：侧栏该改显整批编辑，而不是某一格', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'forest' }],
  ])
  const editor = makeEditor(document)
  editor.setCellSelection(['0_0'])
  assert.deepEqual(editor.getSelection(), { kind: 'cell', id: '0_0' })

  editor.setCellSelection(['0_0', '1_0'])
  assert.equal(editor.getSelection(), null, '多格时对象选中必须清掉')

  // 缩到一格：对象选中自动跟上（否则侧栏会莫名其妙没有可编辑的目标）
  editor.setCellSelection(['1_0'])
  assert.deepEqual(editor.getSelection(), { kind: 'cell', id: '1_0' })
})

// ---------------------------------------------------------------- 规则与连通扩展

test('规则筛选：替换 / 在当前选择内筛 是两条不同的动作（后者依赖当前选择）', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'water' }],
    [2, 0, { t: 'forest' }],
  ])
  const editor = makeEditor(document)
  const forest: RuleGroup = {
    join: 'and',
    negate: false,
    clauses: [{ key: 'terrain', op: '=', value: 'forest' }],
  }

  assert.equal(editor.applySelectionRule(forest, 'replace'), 2)
  assert.deepEqual([...editor.getCellSelection()], ['0_0', '2_0'])

  // 换一条"水"的规则做"在当前选择内筛"：选择里没有水 → 结果为空（这是正常结果）
  const water: RuleGroup = { ...emptyRuleGroup(), clauses: [{ key: 'terrain', op: '=', value: 'water' }] }
  assert.equal(editor.filterSelectionInPlace(water), 0)

  // 而"替换"是全局动作：水那一条会把选择换成水格
  assert.equal(editor.applySelectionRule(water, 'replace'), 1)
  assert.deepEqual([...editor.getCellSelection()], ['1_0'])
})

test('连通扩展：按同地形六邻域扩散，异地形挡住去路', () => {
  const document = doc([
    [0, 0, { t: 'forest' }],
    [1, 0, { t: 'forest' }],
    [2, 0, { t: 'forest' }],
    [1, -1, { t: 'forest' }],
    // 这两格是水：既是"挡路"的，也证明扩展不会顺手把别的地形收进来
    [3, 0, { t: 'water' }],
    [0, 1, { t: 'water' }],
  ])
  const editor = makeEditor(document)
  editor.setCellSelection(['0_0'])
  assert.equal(editor.expandSelectionByTerrain(), 4, '四格森林全连在一起')
  // 顺序 = 先 r 后 q（`normalizeSelection` 的规范序），所以 r = -1 的排最前
  assert.deepEqual([...editor.getCellSelection()], ['1_-1', '0_0', '1_0', '2_0'])
  // 直接对纯函数再确认一次（编辑器只是转发）
  assert.deepEqual([...expandSelectionByTerrain(document, normalizeSelection(['0_0']))].length, 4)
})

// ---------------------------------------------------------------- 整批编辑（§C.5）

test('整批编辑：一次提交 = 一条历史；值相同的格不产生 op；清除 = 删键', () => {
  const document = doc([
    [0, 0, { t: 'forest', temp: 20 }],
    [1, 0, { t: 'forest' }],
    [2, 0, { t: 'forest' }],
  ])
  const editor = makeEditor(document)
  editor.setCellSelection(['0_0', '1_0', '2_0'])

  // 0_0 本来就是 20 → 只改另外两格（否则历史里会有"改了 3 格"的假账）
  assert.equal(editor.setSelectionCellsField('temp', 20), 2)
  assert.equal(document.terrain['1_0']?.temp, 20)
  assert.equal(editor.getStatus().undo, 1, '一次提交只压一条历史')

  // 撤销一次：三格一起回到原状（1_0 / 2_0 没有 temp，0_0 还是 20）
  editor.undo()
  assert.equal(document.terrain['1_0']?.temp, undefined)
  assert.equal(document.terrain['0_0']?.temp, 20)

  // 清除 = 删掉那个键（不是写 0：0 ℃ 是一个合法读数）
  assert.equal(editor.setSelectionCellsField('temp', null), 1)
  assert.equal('temp' in (document.terrain['0_0'] ?? {}), false)

  // 表里没声明的字段一律拒绝（面板传错键名不该往用户文件里塞新键）
  assert.equal(editor.setSelectionCellsField('humidity', 3), 0)
})

test('整批编辑：选择里"地图里已经没有的格"被跳过，不报错也不写空', () => {
  const document = doc([[0, 0, { t: 'forest' }]])
  const editor = makeEditor(document)
  // 撤销 / 重载之后可能出现这种选择（生命周期那条：选择按 key 保留）
  editor.setCellSelection(['0_0', '9_9'])
  assert.equal(editor.setSelectionCellsField('depth', 100), 1)
  assert.equal(document.terrain['0_0']?.depth, 100)
  assert.equal('9_9' in document.terrain, false, '不存在的格不该被"顺手创建"出来')
  assert.equal(editor.selectionSummary()?.missing, 1)
})