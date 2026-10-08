/**
 * 生物群系目录（§D）与数据层笔刷（§E）的单元测试。
 *
 * 两件事值得钉死：
 * 1. **分类值的颜色属于目录条目**（每条自带），认不出的 ID 必须**画得出来**（中性灰）；
 * 2. 笔刷那张表（§E）里最容易悄悄变的是**无值格的处理**：`＋/－` 从默认值起算、
 *    `×/÷` 跳过、`÷0` 拒绝 —— 这三条在屏幕上都不容易一眼看出来。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { cellKey } from '../src/core/hex.ts'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'
import { MapEditor } from '../src/editor/MapEditor.ts'
import {
  BUILTIN_BIOMES,
  BIOME_UNKNOWN_COLOR,
  MAX_CUSTOM_BIOMES,
  biomeColorMap,
  biomesWithTag,
  customBiomeIdProblem,
  listResolvedBiomeStyles,
  normalizeCustomBiomes,
  resolveBiomeStyle,
  validateCustomBiomeInput,
} from '../src/render/biomeCatalog.ts'
import { isCategoryField, overlayField } from '../src/render/overlayFields.ts'
import { buildLegendEntries, type LegendDeps } from '../src/render/legend.ts'
import { DEFAULT_LAYER_VISIBILITY, withLayerVisibility } from '../src/render/layerVisibility.ts'
// C4 第三批：笔刷"为什么刷不动"的四句话只有一份来源（状态浮窗与侧栏都显示它）
import { BRUSH_REASONS } from '../src/ui/strings.ts'

/** 笔刷不能作画时的原因（能作画时为空串）—— 收窄放在这里，断言里就不用重复调两次 */
function brushReason(editor: MapEditor): string {
  const readiness = editor.brushReadiness()
  return readiness.ok ? '' : readiness.reason
}

function makeEditor(document: MapDocument): MapEditor {
  return new MapEditor({
    getDocument: () => document,
    onChanged: () => {
      /* 单测不关心重绘 */
    },
  })
}

/** 世界原点起的笔迹：单格（半径 0） */
const ORIGIN = { x: 0, y: 0 }

// ---------------------------------------------------------------- 目录（§D）

test('内置目录 34 条（地表 18 + 地下 12 + 高空 4），每条有显示名 / 颜色 / 标签', () => {
  assert.equal(BUILTIN_BIOMES.length, 34)
  assert.equal(BUILTIN_BIOMES.filter((entry) => entry.tags.includes('surface')).length, 18)
  assert.equal(BUILTIN_BIOMES.filter((entry) => entry.tags.includes('underground')).length, 12)
  assert.equal(BUILTIN_BIOMES.filter((entry) => entry.tags.includes('sky')).length, 4)
  for (const entry of BUILTIN_BIOMES) {
    assert.ok(entry.label.trim().length > 0, `${entry.id} 缺显示名`)
    assert.match(entry.color, /^#[0-9a-fA-F]{6}$/, `${entry.id} 的颜色写法不对`)
    assert.ok(entry.tags.length > 0, `${entry.id} 一个标签都没有`)
    // 稳定 ID 是裸 slug（不加 biome: 前缀，见 BIOMES.md §3 决定一）
    assert.equal(entry.id.includes(':'), false, `${entry.id} 不该带命名空间前缀`)
  }
  // 待定 3 条**不入目录**（BIOMES.md §1.4）
  for (const pending of ['ocean', 'compound-wetland', 'special-landform']) {
    assert.equal(BUILTIN_BIOMES.some((entry) => entry.id === pending), false, `${pending} 是待定项，不该注册`)
  }
})

test('按标签一次命中一组，且允许一对多（"森林类"包含多条）', () => {
  const forests = biomesWithTag('forest')
  assert.ok(forests.length >= 6, `森林类应当有多条，实际 ${forests.length}`)
  assert.equal(forests.some((entry) => entry.id === 'montane-forest'), true, '山地森林既是 forest 又是 mountain')
  assert.equal(forests.some((entry) => entry.id === 'desert'), false)
  assert.equal(biomesWithTag('wetland').length, 0, '标签词表里有它，但目前没有条目用它（不该报错）')
})

test('认不出的 ID：显示名就是 ID、颜色是中性灰（"未知"必须看得见）', () => {
  const unknown = resolveBiomeStyle('另一个库的群系')
  assert.equal(unknown.label, '另一个库的群系')
  assert.equal(unknown.color, BIOME_UNKNOWN_COLOR)
  assert.equal(unknown.tags.length, 0, '不认识的 ID 不该凭空有标签')
  assert.equal(resolveBiomeStyle('desert').color, '#e0c477', '认识的走目录里那一条的颜色')
})

test('自定义条目：ID 必须带 custom:；坏项跳过而不是带塌整张表', () => {
  // 内置 ID 全是裸 slug，所以"没带前缀"这一条总是先拦下（也就**不会**有撞名这回事）
  assert.equal(customBiomeIdProblem('desert'), 'ID 必须以 custom: 开头')
  assert.equal(customBiomeIdProblem('custom:'), 'custom: 后面还要写名字')
  assert.equal(customBiomeIdProblem('custom:a b'), 'ID 里不能有空格')
  assert.equal(customBiomeIdProblem(' custom:x '), null)
  // 带前缀之后与内置同名是**合法**的（两套 ID 在各自的命名空间里，与 terrainIdProblem 同口径）
  assert.equal(customBiomeIdProblem('custom:desert'), null)
  assert.equal(validateCustomBiomeInput({ id: 'custom:x', label: '', color: '#fff' }).ok, false)
  assert.equal(validateCustomBiomeInput({ id: 'custom:x', label: 'X', color: '红' }).ok, false)
  assert.equal(
    validateCustomBiomeInput({ id: 'custom:x', label: 'X', color: '#fff', tags: ['nope'] }).ok,
    false,
    '标签只能取登记表里那些（否则筛选器会出现点不出来的值）',
  )
  const ok = validateCustomBiomeInput({ id: 'custom:x', label: 'X', color: '#ffffff', tags: ['sky', 'sky'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok ? ok.biome.tags : [], ['sky'], '标签去重')

  const list = normalizeCustomBiomes([
    { id: 'custom:x', label: 'X', color: '#ffffff', tags: ['sky'] },
    { id: 'custom:x', label: '重复', color: '#000000' },
    { id: 'desert', label: '没带前缀', color: '#000000' },
    'not an object',
  ])
  assert.equal(list.length, 1, '重复 / 不合法 / 坏形状一律跳过')

  // 颜色表：内置 + 自定义
  const map = biomeColorMap([{ id: 'custom:x', label: 'X', color: '#123456', tags: [] }])
  assert.equal(map.get('custom:x'), '#123456')
  assert.equal(map.get('desert'), '#e0c477')
  assert.equal(listResolvedBiomeStyles([]).length, 34)
  assert.equal(MAX_CUSTOM_BIOMES > 0, true)
})

// ---------------------------------------------------------------- 图例与图层

test('生物群系图层默认关；图例按"逐个群系一行"列出（含认不出的 ID），顺序不看遍历顺序', () => {
  const biome = overlayField('biome')
  assert.equal(isCategoryField(biome), true)
  assert.equal(DEFAULT_LAYER_VISIBILITY.biome, false, '数据层出厂默认关（新功能不该改变现有画面）')

  const deps: LegendDeps = {
    resolveTerrain: (id) => ({ label: id, color: '#000000' }),
    resolvePath: (id) => ({ label: id, color: '#000000' }),
    resolveRegion: () => ({ label: '区域' }),
    resolveBiome: (id) => ({ label: resolveBiomeStyle(id).label, color: resolveBiomeStyle(id).color }),
  }
  // 关着的那一层不该出现在图例里（"图例只列看得见的东西"），先钉住这一条
  const hidden = createEmptyMapDocument({ size: 40 })
  hidden.terrain[cellKey(0, 0)] = { t: 'forest', biome: 'desert' }
  assert.deepEqual(
    buildLegendEntries(hidden, deps, DEFAULT_LAYER_VISIBILITY).filter((row) => row.kind === 'biome'),
    [],
  )

  const visible = withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'biome', true)
  hidden.terrain[cellKey(1, 0)] = { t: 'forest', biome: 'desert' }
  hidden.terrain[cellKey(2, 0)] = { t: 'forest', biome: '别处的群系' }
  const rows = buildLegendEntries(hidden, deps, visible).filter((row) => row.kind === 'biome')
  assert.equal(rows.length, 2, '两个不同的群系各一行')
  const byLabel = new Map(rows.map((row) => [row.label, row]))
  assert.equal(byLabel.get('沙漠')?.count, 2, '显示名取自目录')
  assert.equal(byLabel.get('沙漠')?.color, '#e0c477')
  assert.equal(byLabel.get('别处的群系')?.count, 1, '认不出的 ID 也照列（否则用户对着灰块猜）')
  assert.equal(byLabel.get('别处的群系')?.color, BIOME_UNKNOWN_COLOR)

  // 顺序**不跟着遍历顺序变**（否则改一格就会重排，测试也没法钉住）
  const reversed = createEmptyMapDocument({ size: 40 })
  reversed.terrain[cellKey(2, 0)] = { t: 'forest', biome: '别处的群系' }
  reversed.terrain[cellKey(1, 0)] = { t: 'forest', biome: 'desert' }
  reversed.terrain[cellKey(0, 0)] = { t: 'forest', biome: 'desert' }
  assert.deepEqual(
    buildLegendEntries(reversed, deps, visible)
      .filter((row) => row.kind === 'biome')
      .map((row) => row.label),
    rows.map((row) => row.label),
  )
})

// ---------------------------------------------------------------- 笔刷（§E）

test('未确认 / 留空的笔刷**不生效**，并给出一句人话（§E 第 2 条）', () => {
  const document = createEmptyMapDocument({ size: 40 })
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('temperature')

  assert.equal(editor.brushReadiness().ok, false, '刚换到温度层、还没填数值')
  assert.equal(brushReason(editor), BRUSH_REASONS.noValue)
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.deepEqual(document.terrain, {}, '没值就一笔都不该落下')
  assert.equal(editor.getStatus().undo, 0, '没落笔就没有历史')

  editor.setBrushValue(12)
  assert.equal(editor.brushReadiness().ok, true)
  // 换算法 → 打回未确认（值保留，但要再确认一次，§E 第 3 条）
  editor.setBrushOp('+')
  assert.equal(editor.brushValue, 12, '值保留（不用重打）')
  assert.equal(editor.getStatus().brushValueConfirmed, false)
  assert.match(brushReason(editor), /确认/)
  editor.setBrushValue(12)
  assert.equal(editor.getStatus().brushValueConfirmed, true, '再确认一次（回车）就生效')

  // 换**层**同样打回未确认（§E 第 3 条）：温度层上留着"刚给深度填的数"才最容易出事故
  editor.setBrushField('depth')
  assert.equal(editor.brushValue, 12, '换层也保留数字（不用重打）')
  assert.equal(editor.getStatus().brushValueConfirmed, false, '但必须再确认一次')
  assert.match(brushReason(editor), /确认/)
  editor.setBrushValue(12)
  assert.equal(editor.getStatus().brushValueConfirmed, true)
})

test('＋：有值的格在原值上加（模板里那个"每格默认值"不参与）', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest', temp: 10 }
  document.dataDefaults = { temp: -5 }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('temperature')
  editor.setBrushOp('+')
  editor.setBrushValue(3)

  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.temp, 13, '有值的格在原来的数上加')
})

test('＋/－ 无值格：从默认值起算；没有默认值就从 0 —— 且**写进格**（从此不跟随默认值）', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest' }
  document.dataDefaults = { temp: -5 }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('temperature')
  editor.setBrushOp('+')
  editor.setBrushValue(3)
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.temp, -2, '-5 + 3（默认值被固化进这一格）')

  const bare = createEmptyMapDocument({ size: 40 })
  bare.terrain[cellKey(0, 0)] = { t: 'forest' }
  const editor2 = makeEditor(bare)
  editor2.setMode('paint')
  editor2.setBrushField('temperature')
  editor2.setBrushOp('+')
  editor2.setBrushValue(3)
  editor2.beginStroke(ORIGIN)
  editor2.endStroke()
  assert.equal(bare.terrain[cellKey(0, 0)]?.temp, 3, '没有默认值就从 0 起算')
})

test('×/÷：无值的格**跳过**；除以 0 整笔拒绝并说明', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest', temp: 10 }
  document.terrain[cellKey(1, 0)] = { t: 'forest' }
  document.dataDefaults = { temp: 100 }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('temperature')
  editor.setBrushOp('×')
  editor.setBrushValue(2)
  editor.beginStroke(ORIGIN)
  editor.extendStroke({ x: 70, y: 0 })
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.temp, 20, '有值的格乘 2')
  assert.equal(document.terrain[cellKey(1, 0)]?.temp, undefined, '无值的格跳过（**不用**默认值 100）')

  editor.setBrushOp('÷')
  editor.setBrushValue(0)
  const readiness = editor.brushReadiness()
  assert.equal(readiness.ok, false)
  assert.equal(readiness.ok ? '' : readiness.reason, BRUSH_REASONS.divideByZero)
  const before = document.terrain[cellKey(0, 0)]?.temp
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.temp, before, '除以 0 不生效（也不会写出 Infinity）')
})

test('一笔 = 一条历史（刷一片温度，Ctrl+Z 一次全部回退）', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest' }
  document.terrain[cellKey(1, 0)] = { t: 'forest' }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('temperature')
  editor.setBrushOp('set')
  editor.setBrushValue(7)
  editor.beginStroke(ORIGIN)
  editor.extendStroke({ x: 70, y: 0 })
  editor.endStroke()
  assert.equal(document.terrain[cellKey(1, 0)]?.temp, 7)
  assert.equal(editor.getStatus().undo, 1, '整笔压成一条历史')
  editor.undo()
  assert.equal(document.terrain[cellKey(0, 0)]?.temp, undefined)
  assert.equal(document.terrain[cellKey(1, 0)]?.temp, undefined)
})

test('生物群系笔刷：设为某个 ID；取消笔刷（切回地形）后地形行为一字不变', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest', temp: 5 }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('biome')
  assert.equal(editor.brushReadiness().ok, false, '还没选群系')
  editor.setBrushBiome('desert')
  assert.equal(editor.brushReadiness().ok, true)
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.biome, 'desert')
  assert.equal(document.terrain[cellKey(0, 0)]?.temp, 5, '一格多值：刷生物群系不该动温度')

  // 切回地形笔刷：既有行为（重刷即重置 t/f/c）不变
  editor.setBrushField(null)
  editor.setTerrainType('water')
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.t, 'water')
  assert.equal(document.terrain[cellKey(0, 0)]?.biome, 'desert', '地形笔刷不动 biome（它只负责 t/f/c）')
})

test('刷的地形与格子原本相同 ⇒ 记成"这一笔没有改变任何格"（不许静默，FEATURE-AUDIT §1.1 B1）', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest' }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setTerrainType('forest')
  assert.equal(editor.getStatus().strokeNoChange, false, '还没刷过，不该有这句提示')

  // 用同一种地形重刷：不产生 op（既有行为，不该为空操作堆历史），但必须**留下状态**可被界面说出来
  const undoBefore = editor.getStatus().undo
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(editor.getStatus().undo, undoBefore, '空操作不进撤销栈（既有行为不变）')
  assert.equal(editor.getStatus().strokeNoChange, true, '但必须能说出"这一笔没改变任何格"')

  // 真的画到东西之后，那句提示要消失（它是"上一笔"的事）
  editor.setTerrainType('water')
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(document.terrain[cellKey(0, 0)]?.t, 'water')
  assert.equal(editor.getStatus().strokeNoChange, false, '改到了东西就不该再说"没改变"')

  // 而在"改不到"的地方再刷一次，又会重新记上
  editor.beginStroke(ORIGIN)
  editor.endStroke()
  assert.equal(editor.getStatus().strokeNoChange, true)
})

test('换字段会取消进行中的笔画（不留下"半笔"）', () => {
  const document = createEmptyMapDocument({ size: 40 })
  document.terrain[cellKey(0, 0)] = { t: 'forest' }
  const editor = makeEditor(document)
  editor.setMode('paint')
  editor.setBrushField('temperature')
  editor.setBrushValue(3)
  editor.beginStroke(ORIGIN)
  assert.equal(editor.getStatus().painting, true)
  editor.setBrushField('depth')
  assert.equal(editor.getStatus().painting, false, '换层时把进行中的笔画收尾（已画的部分作为一条历史保留）')
})