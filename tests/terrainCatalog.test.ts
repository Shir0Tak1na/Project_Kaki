/**
 * 自定义地形目录的单测。
 *
 * 这一组测的是「写错了不会报错、只会静默变形」的三样东西：ID、颜色、图片路径。
 * 所以每个用例都同时钉住两件事：**合法输入被收敛成什么**，以及**非法输入的确切原因**
 * （原因是要显示给用户看的，含糊等于没写）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CUSTOM_TERRAIN_PREFIX,
  DEFAULT_CUSTOM_TERRAIN_COLOR,
  DEFAULT_CUSTOM_TERRAIN_MODE,
  MAX_CUSTOM_TERRAINS,
  checkTerrainImagePath,
  findCustomTerrain,
  isBuiltinTerrain,
  listResolvedTerrainStyles,
  normalizeCustomTerrains,
  normalizeTerrainId,
  normalizeTerrainImagePath,
  normalizeTerrainLabel,
  normalizeTerrainMode,
  resolveTerrainStyle,
  terrainCatalogSignature,
  terrainIdProblem,
  terrainLabelOf,
  validateCustomTerrainInput,
  type CustomTerrain,
} from '../src/render/terrainCatalog.ts'
import { TERRAIN_TYPES } from '../src/data/mapDocument.ts'
import { FALLBACK_TERRAIN_BASE, GENERIC_TERRAIN_GLYPH, TERRAIN_STYLES } from '../src/render/terrainStyle.ts'

const swamp = (over: Partial<CustomTerrain> = {}): CustomTerrain => ({
  id: 'custom:swamp2',
  label: '沼泽地',
  color: '#556644',
  glyph: '',
  imagePath: '',
  mode: 'color',
  imageLayout: 'cell',
  ...over,
})

/* ------------------------------------------------------------------ ID */

test('ID 收敛：自动补 custom: 前缀、统一小写、去掉重复前缀', () => {
  assert.equal(normalizeTerrainId('swamp2'), 'custom:swamp2')
  assert.equal(normalizeTerrainId('Swamp2'), 'custom:swamp2', '大小写不同的同一 ID 会变成两个看起来一样的地形，必须收敛')
  assert.equal(normalizeTerrainId('  swamp2  '), 'custom:swamp2')
  assert.equal(normalizeTerrainId('custom:swamp2'), 'custom:swamp2')
  assert.equal(normalizeTerrainId('custom:custom:swamp2'), 'custom:swamp2', '粘贴两次前缀也要能收敛')
  assert.equal(normalizeTerrainId('a-b_c9'), 'custom:a-b_c9')
})

test('ID：非法输入一律拒绝（返回 null），并给出可读原因', () => {
  const cases: Array<[unknown, string]> = [
    ['', 'ID 不能为空'],
    ['   ', 'ID 不能为空'],
    [42, 'ID 不能为空'],
    [null, 'ID 不能为空'],
    ['1swamp', 'ID 必须以小写字母开头（例如 swamp2）'],
    ['_swamp', 'ID 必须以小写字母开头（例如 swamp2）'],
    ['a', 'ID 至少 2 个字符'],
    ['swamp!', 'ID 只能用小写字母、数字、下划线和连字符'],
    ['沼泽', 'ID 必须以小写字母开头（例如 swamp2）'],
    ['s'.repeat(33), 'ID 太长（33 字符，最多 32）'],
  ]
  for (const [input, reason] of cases) {
    assert.equal(normalizeTerrainId(input), null, `应当拒绝 ${JSON.stringify(input)}`)
    assert.equal(terrainIdProblem(input), reason, `原因不对：${JSON.stringify(input)}`)
  }
})

test('ID：用内置名当自定义 ID 是允许的 —— 前缀已经保证存储值不冲突', () => {
  // 这条曾经被写成"拒绝内置名"，但那样校验函数就在替用户做审美决定，
  // 而且 `forest` 与 `custom:forest` 在文件里本来就分得清。这里把选择钉住。
  assert.equal(normalizeTerrainId('forest'), 'custom:forest')
  assert.equal(terrainIdProblem('forest'), null, '允许通过，但存的永远是带前缀的那个 ID')
})

test('内置类型判断不会把 custom: 前缀的 ID 当成内置', () => {
  assert.equal(isBuiltinTerrain('forest'), true)
  assert.equal(isBuiltinTerrain('custom:forest'), false, '否则自定义地形会拿到内置样式，用户改的颜色会失效')
  assert.equal(isBuiltinTerrain('Forest'), false, 'ID 是大小写敏感的存储值，不做模糊匹配')
  assert.equal(isBuiltinTerrain(42), false)
})

/* --------------------------------------------------------------- 显示名 */

test('显示名留空时退化为 ID 主体（界面上仍认得出一条）', () => {
  assert.equal(normalizeTerrainLabel('', 'custom:swamp2'), 'swamp2')
  assert.equal(normalizeTerrainLabel(null, 'custom:swamp2'), 'swamp2')
  assert.equal(normalizeTerrainLabel('  沼泽  地 ', 'custom:swamp2'), '沼泽 地', '多余空白折叠成一个空格')
  assert.equal(normalizeTerrainLabel('名'.repeat(30), 'custom:swamp2').length, 24, '显示名限长')
})

test('改显示名不影响 ID（这是"ID 与显示名解耦"的核心承诺）', () => {
  const before = swamp({ label: '沼泽地' })
  const after = validateCustomTerrainInput({ id: before.id, label: '烂泥滩', color: before.color })
  assert.equal(after.ok, true)
  assert.equal(after.ok && after.terrain.id, 'custom:swamp2')
  assert.equal(after.ok && after.terrain.label, '烂泥滩')
})

/* ----------------------------------------------------------- 图片路径 */

test('图片路径：合法路径被接受，Windows 反斜杠被统一成正斜杠', () => {
  assert.deepEqual(checkTerrainImagePath('Assets/forest.png'), { path: 'Assets/forest.png', problem: '' })
  assert.equal(normalizeTerrainImagePath('Assets\\deep\\tile.webp'), 'Assets/deep/tile.webp')
  assert.equal(normalizeTerrainImagePath('  Assets/a.svg  '), 'Assets/a.svg')
  assert.equal(checkTerrainImagePath('').problem, '', '留空是合法的（= 不用图片）')
  assert.equal(checkTerrainImagePath(null).path, '')
})

test('图片路径：绝对路径、网址、越级、未知格式都被拒绝并给出原因', () => {
  const absolute = checkTerrainImagePath('C:\\Users\\me\\a.png')
  assert.equal(absolute.path, '')
  assert.ok(absolute.problem.includes('相对路径'), absolute.problem)

  assert.ok(checkTerrainImagePath('/Assets/a.png').problem.includes('相对路径'))
  assert.ok(checkTerrainImagePath('https://example.com/a.png').problem.includes('网址'))
  assert.ok(checkTerrainImagePath('data:image/png;base64,AAAA').problem.includes('网址'))
  assert.ok(checkTerrainImagePath('Assets/../../secrets.png').problem.includes('..'))
  assert.ok(checkTerrainImagePath('Assets/tile.txt').problem.includes('只支持'))
  assert.ok(checkTerrainImagePath('Assets/noextension').problem.includes('只支持'))
  assert.ok(checkTerrainImagePath(`${'a'.repeat(300)}.png`).problem.includes('太长'))
})

/* --------------------------------------------------------------- 集合 */

test('目录归一化：坏条目只丢自己，重复 ID 先出现的胜出，超上限截断', () => {
  const raw = [
    { id: 'swamp2', label: '沼泽地', color: '#556644' },
    { id: 'bad id', label: '无效' },
    null,
    'not-an-object',
    { id: 'SWAMP2', label: '重复（大小写不同，归一化后同一个 ID）' },
    { id: 'dunes', label: '沙丘', color: 'var(--x)', glyph: 'mountain', imagePath: 'Assets/d.png' },
  ]
  const list = normalizeCustomTerrains(raw)
  assert.deepEqual(list.map((item) => item.id), ['custom:swamp2', 'custom:dunes'])
  assert.equal(list[0]!.label, '沼泽地', '重复 ID 时先出现的胜出（后出现的不能再改颜色，否则手工编辑会不可预测）')
  assert.equal(list[0]!.color, '#556644')
  assert.equal(list[1]!.color, DEFAULT_CUSTOM_TERRAIN_COLOR, '非法颜色回退到出厂色，绝不透传给 canvas')
  assert.equal(list[1]!.glyph, 'mountain', '字形可以借用内置地形')
  assert.equal(list[1]!.imagePath, 'Assets/d.png')
})

test('目录归一化：非数组 / undefined / 手工改坏的 data.json 都不抛异常', () => {
  assert.deepEqual(normalizeCustomTerrains(undefined), [])
  assert.deepEqual(normalizeCustomTerrains(null), [])
  assert.deepEqual(normalizeCustomTerrains({ customTerrains: [] }), [])
  assert.deepEqual(normalizeCustomTerrains([{}]), [])
  assert.deepEqual(normalizeCustomTerrains([{ id: 'ok' }])[0]!.glyph, '', '未知字形退化为通用图元')
})

test('目录归一化：超过上限时截断（图集是一列列位图，数量不能无限）', () => {
  const many = Array.from({ length: MAX_CUSTOM_TERRAINS + 5 }, (_item, index) => ({ id: `t${index}` }))
  assert.equal(normalizeCustomTerrains(many).length, MAX_CUSTOM_TERRAINS)
})

/* --------------------------------------------------------------- 解析 */

test('解析：内置 9 种与原来完全一致（自定义功能不得改动内置行为）', () => {
  for (const type of TERRAIN_TYPES) {
    const style = resolveTerrainStyle(type, [swamp()])
    assert.equal(style.builtin, true)
    assert.equal(style.unknown, false)
    assert.equal(style.base, TERRAIN_STYLES[type].base)
    assert.equal(style.glyph, TERRAIN_STYLES[type].glyph)
    assert.equal(style.imagePath, '', '内置地形不参与图片功能')
  }
})

test('解析：自定义地形用用户的颜色，字形可借用内置的，也可用通用图元', () => {
  const plain = resolveTerrainStyle('custom:swamp2', [swamp()])
  assert.equal(plain.builtin, false)
  assert.equal(plain.unknown, false)
  assert.equal(plain.base, '#556644')
  assert.equal(plain.label, '沼泽地')
  assert.equal(plain.glyph, GENERIC_TERRAIN_GLYPH, '没指定字形时用通用图元')

  const borrowed = resolveTerrainStyle('custom:swamp2', [swamp({ glyph: 'forest' })])
  assert.equal(borrowed.glyph, TERRAIN_STYLES.forest.glyph, '借用内置字形时必须拿到同一个数组')
  assert.notEqual(borrowed.base, TERRAIN_STYLES.forest.base, '但颜色仍然是用户自己的')
})

test('解析：未知 ID 永不返回 null，而是中性灰 + 空心菱形（可视化地告诉用户"这不是我定义的"）', () => {
  const unknown = resolveTerrainStyle('custom:ghost', [])
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.builtin, false)
  assert.equal(unknown.base, FALLBACK_TERRAIN_BASE)
  assert.ok(unknown.glyph.length > 0, '必须有可见字形，否则这一格看起来像"没画"')
  assert.ok(unknown.label.includes('custom:ghost'), unknown.label)
})

test('解析：目录顺序是"内置 9 种在前 + 自定义按设置顺序在后"', () => {
  const list = listResolvedTerrainStyles([swamp(), swamp({ id: 'custom:dunes', label: '沙丘' })])
  assert.equal(list.length, TERRAIN_TYPES.length + 2)
  assert.deepEqual(
    list.slice(0, TERRAIN_TYPES.length).map((style) => style.id),
    [...TERRAIN_TYPES],
    '内置顺序不能变 —— 它就是数字键 1–9 的位置',
  )
  assert.deepEqual(list.slice(TERRAIN_TYPES.length).map((style) => style.id), ['custom:swamp2', 'custom:dunes'])
})

test('解析：findCustomTerrain 命中与未命中', () => {
  const list = [swamp()]
  assert.equal(findCustomTerrain('custom:swamp2', list)?.label, '沼泽地')
  assert.equal(findCustomTerrain('custom:swamp2', []), null)
  assert.equal(findCustomTerrain('forest', list), null)
})

test('地形显示名：内置用中文名，自定义用显示名，未知用 ID 拼出的提示', () => {
  assert.equal(terrainLabelOf('forest', []), '森林')
  assert.equal(terrainLabelOf('custom:swamp2', [swamp()]), '沼泽地')
  assert.ok(terrainLabelOf('custom:gone', []).includes('未知'))
})

test('目录签名：内容不变则相同，任一字段变化都会变（工具条与图集据此决定要不要重建）', () => {
  const base = [swamp()]
  assert.equal(terrainCatalogSignature(base), terrainCatalogSignature([swamp()]))
  assert.notEqual(terrainCatalogSignature(base), terrainCatalogSignature([swamp({ color: '#111111' })]))
  assert.notEqual(terrainCatalogSignature(base), terrainCatalogSignature([swamp({ label: '别的名字' })]))
  assert.notEqual(terrainCatalogSignature(base), terrainCatalogSignature([swamp({ imagePath: 'Assets/a.png' })]))
  assert.notEqual(terrainCatalogSignature(base), terrainCatalogSignature([swamp(), swamp({ id: 'custom:b' })]))
  // 模式改变视觉表现（画图还是画颜色 + 字形），所以它必须进签名 —— 否则切换模式后图集不会重建，
  // 用户看到的是"切了没反应"
  assert.notEqual(
    terrainCatalogSignature([swamp({ mode: 'color' })]),
    terrainCatalogSignature([swamp({ mode: 'image' })]),
  )
  // 布局同样改变视觉（每格一张 vs 整片一张），也必须进签名：
  // 否则用户切了"显示方式"之后画面不变，看起来像没生效
  assert.notEqual(
    terrainCatalogSignature([swamp({ mode: 'image', imageLayout: 'cell' })]),
    terrainCatalogSignature([swamp({ mode: 'image', imageLayout: 'region' })]),
  )
  assert.equal(terrainCatalogSignature([]), '')
})

/* ------------------------------------------------------------------ 模式 */

test('模式：显式值原样保留，缺失/非法值按"有没有图片"推断', () => {
  assert.equal(normalizeTerrainMode('color', 'Assets/a.png'), 'color', '显式选了调色就听用户的')
  assert.equal(normalizeTerrainMode('image', ''), 'image', '显式选了图片即使还没配图也保持图片模式')
  assert.equal(normalizeTerrainMode(undefined, 'Assets/a.png'), 'image', '旧数据：配了图 → 迁移成图片模式')
  assert.equal(normalizeTerrainMode(undefined, ''), 'color', '旧数据：没配图 → 调色模式')
  assert.equal(normalizeTerrainMode('nonsense', 'Assets/a.png'), 'image', '非法值也走同一条推断，不静默降级成调色')
  assert.equal(normalizeTerrainMode(null, ''), 'color')
  assert.equal(normalizeTerrainMode(42, 'Assets/a.png'), 'image')
})

test('迁移端到端：data.json 里只有 imagePath 的旧条目 → 图片模式', () => {
  const list = normalizeCustomTerrains([{ id: 'reef', label: '暗礁', color: '#2f6f8f', imagePath: 'Assets/reef.png' }])
  assert.equal(list.length, 1)
  assert.equal(list[0]!.mode, 'image')
  assert.equal(list[0]!.imagePath, 'Assets/reef.png', '路径不能被迁移弄丢')
  assert.equal(list[0]!.mode === 'image' && resolveTerrainStyle('custom:reef', list).imagePath, 'Assets/reef.png')
})

test('解析：调色模式下**不把图片交出去**（绘制层因此绝不会去画图）', () => {
  const colorMode = [swamp({ mode: 'color', imagePath: 'Assets/a.png' })]
  const style = resolveTerrainStyle('custom:swamp2', colorMode)
  assert.equal(style.imagePath, '', '调色模式下 imagePath 必须为空')
  assert.equal(style.base, '#556644', '颜色照常交出去')
  assert.deepEqual(style.glyph, GENERIC_TERRAIN_GLYPH, '字形照常交出去')
  assert.equal(style.unknown, false, '它不是"未知地形"，只是选了另一种模式')

  const imageMode = [swamp({ mode: 'image', imagePath: 'Assets/a.png' })]
  assert.equal(resolveTerrainStyle('custom:swamp2', imageMode).imagePath, 'Assets/a.png')
})

test('切换模式不丢另一个字段的值（来回切不会白配一遍）', () => {
  // 这一条钉的是"存着备用"这个承诺：模式只决定画什么，不负责清空别的字段
  const list = normalizeCustomTerrains([
    { id: 'reef', label: '暗礁', mode: 'image', imagePath: 'Assets/reef.png', color: '#2f6f8f', glyph: 'swamp' },
  ])
  const terrain = list[0]!
  assert.equal(terrain.mode, 'image')
  const switched = validateCustomTerrainInput({ ...terrain, mode: 'color' })
  assert.equal(switched.ok, true)
  assert.equal(switched.ok === true && switched.terrain.imagePath, 'Assets/reef.png', '切到调色后图片路径仍要留着')
  assert.equal(switched.ok === true && switched.terrain.glyph, 'swamp', '字形也还在')
  assert.equal(resolveTerrainStyle('custom:reef', switched.ok === true ? [switched.terrain] : []).imagePath, '', '但这一帧不画图')
})

test('新增校验：ID 或图片路径不合法时拒绝，并且不返回半成品', () => {
  const bad = validateCustomTerrainInput({ id: 'no good' })
  assert.equal(bad.ok, false)
  assert.ok(bad.ok === false && bad.problem.length > 0)

  const badPath = validateCustomTerrainInput({ id: 'swamp2', imagePath: 'http://x/a.png' })
  assert.equal(badPath.ok, false)

  const good = validateCustomTerrainInput({ id: 'swamp2', label: '沼泽地', color: '#123456', imagePath: 'Assets/a.png' })
  assert.equal(good.ok, true)
  assert.deepEqual(good.ok === true && good.terrain, {
    id: 'custom:swamp2',
    label: '沼泽地',
    color: '#123456',
    glyph: '',
    imagePath: 'Assets/a.png',
    mode: 'image',
    // 没给布局 → `cell`（每格一张，与升级前的行为一致）
    imageLayout: 'cell',
  })

  // 布局也一样：缺失 → `cell`；只有显式的 `region` 才会走整片铺图
  const region = validateCustomTerrainInput({ id: 'swamp4', imagePath: 'Assets/a.png', imageLayout: 'region' })
  assert.equal(region.ok === true && region.terrain.imageLayout, 'region')
  const broken = validateCustomTerrainInput({ id: 'swamp5', imagePath: 'Assets/a.png', imageLayout: 'wat' })
  assert.equal(broken.ok === true && broken.terrain.imageLayout, 'cell', '非法布局绝不静默变成 region')

  // 新建时不给模式 + 不给图片 → 默认调色（最不容易失败的那一种）
  const created = validateCustomTerrainInput({ id: 'swamp3' })
  assert.equal(created.ok === true && created.terrain.mode, DEFAULT_CUSTOM_TERRAIN_MODE)
  assert.equal(DEFAULT_CUSTOM_TERRAIN_MODE, 'color')
  assert.ok(CUSTOM_TERRAIN_PREFIX.length > 0)
})
