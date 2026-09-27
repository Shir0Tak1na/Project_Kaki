/**
 * 选中状态、检查器信息、以及"改名 / 改链接"两个新 op 的单元测试。
 *
 * 这一层的赌注：检查器是用户**唯一**能改链接的入口（以前只在创建标记时能填一次）。
 * 所以两件事必须钉死：**点一下到底选中了谁**（顺序可预测），以及
 * **改完能撤销、且不顺手改坏别的字段**。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { axialToWorld, cellKey } from '../src/core/hex.ts'
import type { SelectionKind } from '../src/editor/selection.ts'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import { applyOp, invertOp, type MapOp } from '../src/editor/history.ts'
import {
  COLLECTION_KINDS,
  SELECTION_EMPTY_HINT,
  SELECTION_HIT_ORDER,
  SELECTION_KINDS,
  SELECTION_KIND_LABELS,
  describeSelection,
  formatSelectionFieldValue,
  hitTestSelection,
  isCollectionKind,
  pointHitRadius,
  sameObjectFieldValue,
  selectionSupports,
} from '../src/editor/selection.ts'

const LABELS = {
  terrain: (id: string) => (id === 'forest' ? '森林' : id),
  marker: (id: string) => (id === 'town' ? '村镇' : id),
  path: (id: string) => (id === 'river' ? '河流' : id),
  region: (id: string) => (id === 'realm' ? '王国' : id),
}

function doc(): MapDocument {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest' }
  // 第二块地形：放在没有标记的地方，用来单独验"地块命中"
  document.terrain[cellKey(2, 0)] = { t: 'forest' }
  document.markers.push({ id: 'mk-1', label: '港口', p: [0, 0], icon: 'town', link: 'Places/Port.md' })
  document.labels.push({ id: 'lb-1', text: '北境', p: [400, 0] })
  document.paths.push({ id: 'pa-1', type: 'river', pts: [[-400, 300], [0, 300], [400, 300]], width: 8, color: '#2288ff' })
  document.regions.push({ id: 'rg-1', label: '王国', pts: [[-300, -300], [300, -300], [300, 100]], color: '#44cf6e', opacity: 0.2, type: 'realm' })
  // 旧区域：升级前画的，**没有** type 字段（名字按颜色反查，见 regionTypeCatalog.ts）
  document.regions.push({ id: 'rg-legacy', label: '旧领地', pts: [[-500, 500], [-200, 500], [-200, 700]], color: '#c94f4f', opacity: 0.2 })
  return document
}

const noShape = () => null

test('命中顺序：标记优先于形状与地块（否则标记永远点不到）', () => {
  const hit = hitTestSelection({
    document: doc(),
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    world: { x: 0, y: 0 },
    toleranceWorld: 6,
    // 故意让形状也命中：标记必须赢
    hitShape: () => ({ kind: 'path', id: 'pa-1' }),
  })
  assert.deepEqual(hit, { kind: 'marker', id: 'mk-1' })
})

test('标记不在范围内时轮到形状（顺序：标记 → 名称 → 路径/区域 → 地块）', () => {
  const hit = hitTestSelection({
    document: doc(),
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    world: { x: 0, y: 0 },
    toleranceWorld: 6,
    hitShape: () => ({ kind: 'region', id: 'rg-1' }),
  })
  assert.deepEqual(hit, { kind: 'marker', id: 'mk-1' })

  const farFromMarker = hitTestSelection({
    document: doc(),
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    world: { x: 500, y: 500 },
    toleranceWorld: 6,
    hitShape: () => ({ kind: 'region', id: 'rg-1' }),
  })
  assert.deepEqual(farFromMarker, { kind: 'region', id: 'rg-1' })
})

test('名称（文字标注）优先于地块', () => {
  const hit = hitTestSelection({
    document: doc(),
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    world: { x: 400, y: 0 },
    toleranceWorld: 6,
    hitShape: noShape,
  })
  assert.deepEqual(hit, { kind: 'label', id: 'lb-1' })
})

test('地块只有**真的有地形**时才算命中（否则"点空白处清除选中"永远做不到）', () => {
  const grid = { kind: 'hex' as const, orientation: 'pointy' as const, size: 40, origin: [0, 0] as [number, number] }
  // 注意 (0,0) 那格上**还压着一个标记**：按命中顺序它会赢，所以这里用没有标记的第 (2,0) 格
  const onTerrain = hitTestSelection({ document: doc(), grid, world: axialToWorld(grid, 2, 0), toleranceWorld: 6, hitShape: noShape })
  assert.deepEqual(onTerrain, { kind: 'cell', id: cellKey(2, 0) })

  // (5,0) 那一格没有地形 → 不该被选中，于是点它返回 null（调用方据此清空选中）
  const empty = hitTestSelection({ document: doc(), grid, world: axialToWorld(grid, 5, 0), toleranceWorld: 6, hitShape: noShape })
  assert.equal(empty, null)
})

test('命中半径随格大小缩放（地图放大后不能变成"必须点得极准"）', () => {
  assert.equal(pointHitRadius({ kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }), 24)
  assert.equal(pointHitRadius({ kind: 'hex', orientation: 'pointy', size: 80, origin: [0, 0] }), 48)
  const grid = { kind: 'hex' as const, orientation: 'pointy' as const, size: 40, origin: [0, 0] as [number, number] }
  // 半径 24：距 23 命中标记；距 25 不再命中标记（会落到那一格的地块上，或什么都没有）
  assert.equal(
    hitTestSelection({ document: doc(), grid, world: { x: 23, y: 0 }, toleranceWorld: 0, hitShape: noShape })?.kind,
    'marker',
  )
  const outside = hitTestSelection({ document: doc(), grid, world: { x: 25, y: 0 }, toleranceWorld: 0, hitShape: noShape })
  assert.notEqual(outside?.kind, 'marker')
})

test('检查器信息：标记（可改名可链接，详情带坐标与图标名）', () => {
  const info = describeSelection(doc(), { kind: 'marker', id: 'mk-1' }, LABELS)
  assert.ok(info)
  assert.equal(info.kindLabel, '标记')
  assert.equal(info.name, '港口')
  assert.equal(info.link, 'Places/Port.md')
  assert.equal(info.canRename, true)
  assert.equal(info.canLink, true)
  assert.match(info.detail, /村镇/)
})

test('检查器信息：路径 / 区域带顶点数，名称与链接都能改', () => {
  const path = describeSelection(doc(), { kind: 'path', id: 'pa-1' }, LABELS)
  assert.ok(path)
  assert.equal(path.name, '')
  assert.match(path.detail, /3 个顶点/)
  assert.match(path.detail, /河流/)
  assert.equal(path.canLink, true)

  const region = describeSelection(doc(), { kind: 'region', id: 'rg-1' }, LABELS)
  assert.ok(region)
  assert.equal(region.name, '王国')
  assert.match(region.detail, /类型 王国/)

  // 旧区域没有 type：详情要说清"按颜色显示名字"，而不是写成「类型 未知（）」
  const legacy = describeSelection(doc(), { kind: 'region', id: 'rg-legacy' }, LABELS)
  assert.ok(legacy)
  assert.match(legacy.detail, /旧区域/)
  assert.doesNotMatch(legacy.detail, /未知（）/)
})

test('检查器信息：地块没有名字与链接（不能假装能改）', () => {
  const info = describeSelection(doc(), { kind: 'cell', id: cellKey(0, 0) }, LABELS)
  assert.ok(info)
  assert.equal(info.kindLabel, '地块')
  assert.equal(info.canRename, false)
  assert.equal(info.canLink, false)
  assert.equal(info.canDelete, true)
  assert.match(info.detail, /森林/)
})

test('检查器信息：对象已经不存在时返回 null（不显示指向幽灵的数据）', () => {
  assert.equal(describeSelection(doc(), { kind: 'marker', id: '没了' }, LABELS), null)
  assert.equal(describeSelection(doc(), { kind: 'cell', id: '99,99' }, LABELS), null)
  assert.equal(describeSelection(doc(), null, LABELS), null)
})

test('标签与引导文案齐备（界面上不出现内部名）', () => {
  assert.deepEqual(SELECTION_KIND_LABELS, {
    marker: '标记',
    label: '名称',
    path: '路径',
    region: '区域',
    cell: '地块',
  })
  assert.match(SELECTION_EMPTY_HINT, /点一下地图上的对象/)
})

test('setLink op：设置、清除、逆操作都对，且不动对象的其它字段', () => {
  const document = doc()
  // 给标记塞一个"本版还不认识的字段"：改链接不许把它弄丢（§5.11）
  ;(document.markers[0] as unknown as Record<string, unknown>).futureField = 'keep-me'
  const op: MapOp = { kind: 'setLink', target: 'marker', id: 'mk-1', from: 'Places/Port.md', to: 'Places/Harbor.md' }
  applyOp(document, op)
  assert.equal(document.markers[0]!.link, 'Places/Harbor.md')
  assert.equal((document.markers[0] as unknown as Record<string, unknown>).futureField, 'keep-me')
  assert.equal(document.markers[0]!.label, '港口')

  applyOp(document, invertOp(op))
  assert.equal(document.markers[0]!.link, 'Places/Port.md')

  // 清空 = 删掉字段（而不是留一个空串）
  applyOp(document, { kind: 'setLink', target: 'marker', id: 'mk-1', from: 'Places/Port.md', to: '' })
  assert.equal(document.markers[0]!.link, undefined)
})

test('renameObject op：文字标注改的是 text，路径清空名字会删掉 label 字段', () => {
  const document = doc()
  applyOp(document, { kind: 'renameObject', target: 'label', id: 'lb-1', from: '北境', to: '南境' })
  assert.equal(document.labels[0]!.text, '南境')

  document.paths[0]!.label = '旧名'
  applyOp(document, { kind: 'renameObject', target: 'path', id: 'pa-1', from: '旧名', to: '' })
  assert.equal(document.paths[0]!.label, undefined)
  assert.equal(document.paths[0]!.width, 8, '改名不许碰到别的字段')

  // 标记/区域的 label 是必填字段：清空写空串，不删字段
  applyOp(document, { kind: 'renameObject', target: 'marker', id: 'mk-1', from: '港口', to: '' })
  assert.equal(document.markers[0]!.label, '')
  assert.equal(document.markers[0]!.link, 'Places/Port.md', '改名不许碰到链接')
})

test('renameObject / setLink 的逆操作能精确还原', () => {
  const document = doc()
  const rename: MapOp = { kind: 'renameObject', target: 'region', id: 'rg-1', from: '王国', to: '北境王国' }
  applyOp(document, rename)
  assert.equal(document.regions[0]!.label, '北境王国')
  applyOp(document, invertOp(rename))
  assert.equal(document.regions[0]!.label, '王国')

  const link: MapOp = { kind: 'setLink', target: 'region', id: 'rg-1', from: '', to: 'Regions/Kingdom.md' }
  applyOp(document, link)
  assert.equal(document.regions[0]!.link, 'Regions/Kingdom.md')
  applyOp(document, invertOp(link))
  assert.equal(document.regions[0]!.link, undefined)
})

test('ops 对不存在的对象是空操作（不抛错、不新建）', () => {
  const document = doc()
  applyOp(document, { kind: 'setLink', target: 'marker', id: '没了', from: '', to: 'X.md' })
  applyOp(document, { kind: 'renameObject', target: 'path', id: '没了', from: '', to: 'X' })
  assert.equal(document.markers.length, 1)
  assert.equal(document.paths.length, 1)
})

// ---------------------------------------------------------------- 描述表本身

test('描述表：五种对象各有一行，字段齐备（这是"加新种类只加一行"的地基）', () => {
  const kinds = (Object.keys(SELECTION_KINDS) as SelectionKind[]).sort()
  assert.deepEqual(kinds, ['cell', 'label', 'marker', 'path', 'region'])
  for (const kind of kinds) {
    const spec = SELECTION_KINDS[kind]
    assert.equal(typeof spec.label, 'string')
    assert.ok(spec.label.length > 0, `${kind} 缺 label`)
    assert.equal(typeof spec.hitPriority, 'number')
    assert.equal(typeof spec.hit, 'function', `${kind} 缺 hit()`)
    assert.equal(typeof spec.data, 'function', `${kind} 缺 data()`)
    assert.ok(Array.isArray(spec.actions) && spec.actions.length > 0, `${kind} 缺 actions`)
  }
})

test('命中顺序**由表里的 hitPriority 排出来**（不是写死的 if 链）', () => {
  assert.deepEqual([...SELECTION_HIT_ORDER], ['marker', 'label', 'path', 'region', 'cell'])
  // 与"按优先级排序"的结果逐项一致 —— 加新 kind 时不用动任何分支代码
  const sorted = (Object.keys(SELECTION_KINDS) as Array<keyof typeof SELECTION_KINDS>).sort(
    (a, b) => SELECTION_KINDS[a].hitPriority - SELECTION_KINDS[b].hitPriority,
  )
  assert.deepEqual([...SELECTION_HIT_ORDER], sorted)
  // 优先级不许重复：重复就意味着"谁先命中"取决于对象键的顺序，那是不可预测的行为
  const priorities = [...SELECTION_HIT_ORDER].map((kind) => SELECTION_KINDS[kind].hitPriority)
  assert.equal(new Set(priorities).size, priorities.length)
})

test('人话标签与能力标志都是从表里**派生**的（不存在第二份状态）', () => {
  for (const kind of SELECTION_HIT_ORDER) {
    assert.equal(SELECTION_KIND_LABELS[kind], SELECTION_KINDS[kind].label)
  }
  const marker = describeSelection(doc(), { kind: 'marker', id: 'mk-1' }, LABELS)
  assert.deepEqual(marker?.actions, ['rename', 'link', 'delete'])
  assert.equal(marker?.canRename, true)
  assert.equal(marker?.canLink, true)
  assert.equal(marker?.canDelete, true)

  // 地块的动作表里只有删除 → 三个 canXxx 里只有 canDelete 为真
  const cell = describeSelection(doc(), { kind: 'cell', id: cellKey(0, 0) }, LABELS)
  assert.deepEqual(cell?.actions, ['delete'])
  assert.equal(cell?.canRename, false)
  assert.equal(cell?.canLink, false)
  assert.equal(cell?.canDelete, true)
})

test('每一行的 data() 对不存在的 id 都返回 null（不给指向幽灵的数据）', () => {
  for (const kind of SELECTION_HIT_ORDER) {
    assert.equal(SELECTION_KINDS[kind].data(doc(), '不存在的 id', LABELS), null, `${kind} 应返回 null`)
  }
})

test('每一行的 hit() 在没有任何对象时都不命中（加新 kind 也别破坏这条）', () => {
  const empty = createEmptyMapDocument({ size: 40 })
  const grid = { kind: 'hex' as const, orientation: 'pointy' as const, size: 40, origin: [0, 0] as [number, number] }
  for (const kind of SELECTION_HIT_ORDER) {
    const id = SELECTION_KINDS[kind].hit({ document: empty, grid, world: { x: 0, y: 0 }, toleranceWorld: 6, hitShape: () => null })
    assert.equal(id, null, `${kind} 在空文档里不该命中`)
  }
})

/* ------------------------------------------------ A2：类型 / 位置 / 外观三组的表驱动 */

test('类型字段与来源写进表里，且与"存在哪"一致（加新种类只加一行）', () => {
  assert.equal(SELECTION_KINDS.marker.typeField, 'icon')
  assert.equal(SELECTION_KINDS.marker.typeSource, 'marker')
  assert.equal(SELECTION_KINDS.cell.typeField, 't')
  assert.equal(SELECTION_KINDS.cell.typeSource, 'terrain')
  assert.equal(SELECTION_KINDS.path.typeField, 'type')
  assert.equal(SELECTION_KINDS.path.typeSource, 'path')
  assert.equal(SELECTION_KINDS.region.typeField, 'type')
  assert.equal(SELECTION_KINDS.region.typeSource, 'region')
  // 文字标注没有类型：这两列都不该有值（面板据此不渲染类型组）
  assert.equal(SELECTION_KINDS.label.typeField, undefined)
  assert.equal(SELECTION_KINDS.label.typeSource, undefined)
})

test('位置表达方式写进表里：点对象可编辑坐标、地块只读格号、形状只读顶点数', () => {
  assert.equal(SELECTION_KINDS.marker.position, 'point')
  assert.equal(SELECTION_KINDS.label.position, 'point')
  assert.equal(SELECTION_KINDS.cell.position, 'cell')
  assert.equal(SELECTION_KINDS.path.position, 'shape')
  assert.equal(SELECTION_KINDS.region.position, 'shape')
})

test('describeSelection 把类型 / 位置 / 外观的当前值一并给出（面板不再自己去文档里翻）', () => {
  const document = doc()
  const marker = describeSelection(document, { kind: 'marker', id: 'mk-1' }, LABELS)
  assert.equal(marker?.typeField, 'icon')
  assert.equal(marker?.typeValue, 'town')
  assert.deepEqual(marker?.positionValue, { kind: 'point', x: 0, y: 0 })
  assert.deepEqual(
    marker?.fields.map((field) => field.field),
    ['c'],
  )
  // 标记没有覆盖色：字段值是 null（面板据此把"清除"按钮灰掉）
  assert.equal(marker?.fieldValues.c, null)

  const path = describeSelection(document, { kind: 'path', id: 'pa-1' }, LABELS)
  assert.deepEqual(path?.positionValue, { kind: 'shape', points: 3 })
  assert.deepEqual(
    path?.fields.map((field) => field.field),
    ['color', 'width', 'dash'],
  )
  assert.equal(path?.fieldValues.color, '#2288ff')
  assert.equal(path?.fieldValues.width, 8)
  assert.equal(path?.fieldValues.dash, null)

  const cell = describeSelection(document, { kind: 'cell', id: cellKey(0, 0) }, LABELS)
  assert.deepEqual(cell?.positionValue, { kind: 'cell', q: 0, r: 0 })
  assert.equal(cell?.typeValue, 'forest')

  // 旧区域没有 type 字段 → typeValue 为 null（面板显示"未知"而不是编一个名字）
  const legacy = describeSelection(document, { kind: 'region', id: 'rg-legacy' }, LABELS)
  assert.equal(legacy?.typeValue, null)
})

test('字段值的显示文本：数字/颜色原样，虚线用逗号连接，缺失是空串', () => {
  const dash = SELECTION_KINDS.path.fields.find((field) => field.field === 'dash')
  assert.ok(dash)
  assert.equal(formatSelectionFieldValue(dash, null), '')
  assert.equal(formatSelectionFieldValue(dash, []), '')
  assert.equal(formatSelectionFieldValue(dash, [12, 4]), '12,4')
  assert.equal(formatSelectionFieldValue(dash, 3), '3')
})

test('字段值的"相同"判断按内容比：重复提交同样的虚线不该记成一次改动', () => {
  assert.equal(sameObjectFieldValue([12, 4], [12, 4]), true)
  assert.equal(sameObjectFieldValue([12, 4], [12, 5]), false)
  assert.equal(sameObjectFieldValue([12, 4], null), false)
  assert.equal(sameObjectFieldValue(null, null), true)
  assert.equal(sameObjectFieldValue('#fff', '#fff'), true)
})

test('能力判断只有一处来源：selectionSupports 与表里的 actions 完全一致', () => {
  for (const kind of SELECTION_HIT_ORDER) {
    for (const action of ['rename', 'link', 'delete'] as const) {
      assert.equal(selectionSupports(kind, action), SELECTION_KINDS[kind].actions.includes(action))
    }
  }
  // 地块：没有改名与链接（这是"检查器里不出现这两栏"的**唯一**依据）
  assert.equal(selectionSupports('cell', 'rename'), false)
  assert.equal(selectionSupports('cell', 'link'), false)
  assert.equal(selectionSupports('marker', 'rename'), true)
})

test('storage 列派生出的集合：地块不在"对象数组"里（编辑器据此选 op，不写 kind === cell）', () => {
  assert.deepEqual([...COLLECTION_KINDS].sort(), ['label', 'marker', 'path', 'region'])
  assert.equal(isCollectionKind('cell'), false)
  assert.equal(isCollectionKind('marker'), true)
})

/* ------------------------------------------------ A2：三个新 op 的可逆性与"别顺手改坏别的字段" */

test('setObjectField：只改一个键，别的字段（含不认识的）原样保留', () => {
  const document = doc()
  const marker = document.markers[0] as unknown as Record<string, unknown>
  marker.futureField = { hello: 'world' }
  const op: MapOp = {
    kind: 'setObjectField',
    target: 'marker',
    id: 'mk-1',
    field: 'icon',
    from: 'town',
    to: 'city',
  }
  applyOp(document, op)
  assert.equal(document.markers[0]?.icon, 'city')
  assert.equal(document.markers[0]?.label, '港口')
  // ⚠️ 必须**从文档里重新读**，不能拿改之前抓的那个对象引用去断言：
  // 实现若把对象换成一个新对象（丢掉未知字段），旧引用照样是好的 —— 断言会空转。
  // 这条是跑鉴别力验证时抓出来的（那次破坏一条都没红）。
  assert.deepEqual((document.markers[0] as unknown as Record<string, unknown>).futureField, { hello: 'world' })
  applyOp(document, invertOp(op))
  assert.equal(document.markers[0]?.icon, 'town')
  assert.deepEqual((document.markers[0] as unknown as Record<string, unknown>).futureField, { hello: 'world' })
})

test('setObjectField：值为 null = 删掉该字段（而不是写一个 null 进去）', () => {
  const document = doc()
  const op: MapOp = { kind: 'setObjectField', target: 'marker', id: 'mk-1', field: 'c', from: null, to: '#ff0000' }
  applyOp(document, op)
  assert.equal(document.markers[0]?.c, '#ff0000')
  const clear: MapOp = { kind: 'setObjectField', target: 'marker', id: 'mk-1', field: 'c', from: '#ff0000', to: null }
  applyOp(document, clear)
  assert.equal('c' in (document.markers[0] as object), false)
  applyOp(document, invertOp(clear))
  assert.equal(document.markers[0]?.c, '#ff0000')
})

test('setCellField：改地形种类时不碰格上的未知字段（extra 那套接缝）', () => {
  const document = doc()
  const key = cellKey(0, 0)
  const cell = document.terrain[key] as unknown as Record<string, unknown>
  cell.futureValue = 42
  const op: MapOp = { kind: 'setCellField', key, field: 't', from: 'forest', to: 'mountain' }
  applyOp(document, op)
  assert.equal(document.terrain[key]?.t, 'mountain')
  // 同上：从文档重新读，别用会被换掉的旧引用（否则"重建对象"这种破坏一条都不红）
  assert.equal((document.terrain[key] as unknown as Record<string, unknown>).futureValue, 42)
  applyOp(document, invertOp(op))
  assert.equal(document.terrain[key]?.t, 'forest')
  assert.equal((document.terrain[key] as unknown as Record<string, unknown>).futureValue, 42)
})

test('translateObject：整体平移后顶点相对位置不变，撤销回到原位', () => {
  const document = doc()
  const before = document.paths[0]?.pts.map((point) => [...point])
  const op: MapOp = { kind: 'translateObject', target: 'path', id: 'pa-1', dx: 100, dy: -50 }
  applyOp(document, op)
  assert.deepEqual(document.paths[0]?.pts, [
    [-300, 250],
    [100, 250],
    [500, 250],
  ])
  applyOp(document, invertOp(op))
  assert.deepEqual(document.paths[0]?.pts, before)
})

test('translateObject：区域同样按位移还原（op 里不抄整份顶点）', () => {
  const document = doc()
  const op: MapOp = { kind: 'translateObject', target: 'region', id: 'rg-1', dx: 10, dy: 20 }
  applyOp(document, op)
  assert.deepEqual(document.regions[0]?.pts[0], [-290, -280])
  applyOp(document, invertOp(op))
  assert.deepEqual(document.regions[0]?.pts[0], [-300, -300])
})

test('新 op 都进了 MapOp 联合：invertOp 对每一种都能来回（不会漏掉某种 op）', () => {
  const document = doc()
  // ⚠️ `from` 必须是**文档里真实的前值**：op 的"还原"就是把它写回去，
  // 随手编一个 from 会让这条断言失败 —— 而那正是它在防的事（op 记错前值 = 撤销后数据不对）
  const ops: MapOp[] = [
    { kind: 'setObjectField', target: 'path', id: 'pa-1', field: 'color', from: '#2288ff', to: '#222222' },
    { kind: 'setCellField', key: cellKey(0, 0), field: 'c', from: null, to: '#333333' },
    { kind: 'translateObject', target: 'region', id: 'rg-1', dx: 5, dy: 6 },
  ]
  const snapshot = JSON.stringify(document)
  for (const op of ops) {
    applyOp(document, op)
    applyOp(document, invertOp(op))
  }
  assert.equal(JSON.stringify(document), snapshot)
})
