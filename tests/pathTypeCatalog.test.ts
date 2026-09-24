/**
 * 路径类型目录的单元测试。
 *
 * 这是 ⑤-1 的核心：每种路径类型的参数（颜色/线宽/虚线/变细/平滑/端点/连接）从两处
 * 合成**一处**，而目录的每条规则都必须是可判伪的 —— 尤其是
 * 「旧字段迁移后视觉不变」「未知 ID 不丢」「幂等」这三条。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PATH_TYPES, type PathType } from '../src/data/mapDocument.ts'
import { PATH_STYLES } from '../src/render/shapeStyle.ts'
import {
  FALLBACK_PATH_TYPE_PARAMS,
  MAX_CUSTOM_PATH_TYPES,
  applyPathTypePatch,
  customPathTypeEntries,
  defaultPathTypeEntries,
  describePathTypeParams,
  factoryPathTypeParams,
  findPathTypeEntry,
  isBuiltinPathType,
  isDefaultPathTypeStyles,
  listPathTypeEntries,
  normalizePathTypeEntries,
  normalizePathTypeId,
  normalizePathTypeLabel,
  parsePathDashInput,
  pathColorsFromEntries,
  pathTypeCatalogSignature,
  pathTypeIdProblem,
  pathTypeLabelOf,
  resetPathTypeStyles,
  resolvePathType,
  resolvedPathStyle,
  validateCustomPathTypeInput,
} from '../src/render/pathTypeCatalog.ts'

// ------------------------------------------------------------ 出厂目录

test('出厂目录：内置 4 种、顺序取自 PATH_TYPES，参数全部照抄 PATH_STYLES', () => {
  const entries = defaultPathTypeEntries()
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [...PATH_TYPES],
    '顺序即工具条与图例的顺序，必须与 PATH_TYPES 一致',
  )
  for (const entry of entries) {
    const base = PATH_STYLES[entry.id as (typeof PATH_TYPES)[number]]
    assert.equal(entry.label, base.label, entry.id)
    assert.equal(entry.params.color, base.color, entry.id)
    assert.equal(entry.params.width, base.width, entry.id)
    assert.deepEqual(entry.params.dash, base.dash ? [...base.dash] : [], entry.id)
    assert.equal(entry.params.taper, base.taper === true, entry.id)
    assert.equal(entry.params.smooth, base.smooth === true, entry.id)
    assert.equal(entry.kind, 'path', entry.id)
  }
  assert.equal(customPathTypeEntries(entries).length, 0, '出厂没有自定义类型')
})

test('出厂端点/连接 = round：这正是升级前 drawPath 里硬编码的值（旧地图逐像素不变）', () => {
  for (const entry of defaultPathTypeEntries()) {
    assert.equal(entry.params.cap, 'round', entry.id)
    assert.equal(entry.params.join, 'round', entry.id)
  }
})

test('解析成绘制层样式：出厂河道带平滑与末端变细，道路带虚线', () => {
  const entries = defaultPathTypeEntries()
  const river = resolvedPathStyle('river', entries)
  assert.equal(river.label, '河流')
  assert.equal(river.smooth, true)
  assert.equal(river.taper, true)
  assert.equal(river.cap, 'round')
  const road = resolvedPathStyle('road', entries)
  assert.deepEqual(road.dash, PATH_STYLES.road.dash, '工厂虚线要带出来')
  assert.equal(road.smooth, undefined, '没开的可选项不写字段（PathStyle 的既有语义）')
})

// ------------------------------------------------------------ 迁移

test('迁移：只有颜色（上一代 pathColors）时，颜色进目录而结构字段保持出厂', () => {
  const entries = normalizePathTypeEntries(undefined, { pathColors: { river: '#ff0000' } })
  const river = findPathTypeEntry('river', entries)!
  assert.equal(river.params.color, '#ff0000')
  assert.equal(river.params.width, PATH_STYLES.river.width, '线宽仍取出厂值')
  assert.equal(river.params.taper, true, '末端变细仍取出厂值')
  assert.equal(river.params.cap, 'round')
  assert.equal(findPathTypeEntry('road', entries)!.params.color, PATH_STYLES.road.color, '没改过的类型保持出厂色')
})

test('迁移：什么都没改过时，迁移结果**逐字段等于出厂**（迁移前后视觉一致）', () => {
  const entries = normalizePathTypeEntries(undefined, { pathColors: undefined, pathStyleOverrides: undefined })
  assert.deepEqual(entries, defaultPathTypeEntries())
  // 用户手工把旧字段写成垃圾也一样：不合法就回退出厂值，不会出现"半套样式"
  const broken = normalizePathTypeEntries(undefined, { pathColors: { river: 'var(--x)' } })
  assert.deepEqual(broken, defaultPathTypeEntries())
})

test('迁移：显式写过的 pathStyleOverrides 优先于旧颜色表（颜色不会被旧字段悄悄盖回去）', () => {
  const entries = normalizePathTypeEntries(undefined, {
    pathColors: { river: '#ff0000' },
    pathStyleOverrides: { river: { color: '#111111', width: 9, dash: [] } },
  })
  const river = findPathTypeEntry('river', entries)!
  assert.equal(river.params.color, '#111111')
  assert.equal(river.params.width, 9)
  assert.deepEqual(river.params.dash, [], '显式实线要保住')
})

test('迁移：已有 pathTypes 的那一项以它为准，旧字段不会覆盖它', () => {
  const entries = normalizePathTypeEntries(
    [{ id: 'river', params: { color: '#00ff00', width: 12 } }],
    { pathColors: { river: '#ff0000' } },
  )
  const river = findPathTypeEntry('river', entries)!
  assert.equal(river.params.color, '#00ff00', '新字段优先')
  assert.equal(river.params.width, 12)
  assert.equal(river.params.cap, 'round', '缺的字段由出厂值补齐')
})

test('幂等：目录收敛再收敛一次完全相同（含自定义项与迁移输入）', () => {
  const raws: unknown[] = [
    undefined,
    [],
    [{ id: 'highway', label: '官道', params: { color: '#222222', width: 6, dash: [4, 4], cap: 'butt', join: 'miter' } }],
    [{ id: 'custom:highway', label: '官道' }, { id: 'custom:highway', label: '重复' }],
    'nonsense',
    [{ id: 42, label: null }, { id: 'river' }],
  ]
  for (const raw of raws) {
    const once = normalizePathTypeEntries(raw, { pathColors: { river: '#ff0000' } })
    const twice = normalizePathTypeEntries(once)
    assert.deepEqual(twice, once, JSON.stringify(raw))
  }
})

test('旧字段镜像（pathColors）与目录保持一致', () => {
  const entries = normalizePathTypeEntries(undefined, { pathColors: { border: '#0000ff' } })
  const colors = pathColorsFromEntries(entries)
  assert.equal(colors.border, '#0000ff')
  assert.equal(colors.river, PATH_STYLES.river.color)
  assert.deepEqual(Object.keys(colors).sort(), [...PATH_TYPES].sort(), '键只有内置 4 种')
})

// ------------------------------------------------------------ 未知值

test('未知类型不丢：解析出非空回退样式，并标明 unknown', () => {
  const entries = defaultPathTypeEntries()
  const resolved = resolvePathType('custom:gone', entries)
  assert.equal(resolved.unknown, true)
  assert.equal(resolved.builtin, false)
  assert.equal(resolved.label, '未知（custom:gone）')
  assert.deepEqual(resolved.params, FALLBACK_PATH_TYPE_PARAMS)
  // 关键：回退样式必须"看得见"，不能是透明或空
  assert.ok(resolved.params.width > 0)
  assert.ok(resolved.params.color.length > 0)
  assert.equal(pathTypeLabelOf('spaceship', entries), '未知（spaceship）')
})

test('未知类型的地图数据条目照样能拿到样式（绘制层永不空手）', () => {
  const weird = 'x'.repeat(64)
  const style = resolvedPathStyle(weird, [])
  assert.equal(style.label, `未知（${weird}）`)
  assert.equal(style.color, FALLBACK_PATH_TYPE_PARAMS.color)
})

// ------------------------------------------------------------ ID / 上限

test('用户输入的 ID 一律进 custom: 命名空间（哪怕写的是内置名）', () => {
  assert.equal(normalizePathTypeId('highway'), 'custom:highway')
  assert.equal(normalizePathTypeId('  Highway '), 'custom:highway')
  assert.equal(normalizePathTypeId('custom:custom:highway'), 'custom:highway', '重复前缀也要收敛')
  assert.equal(normalizePathTypeId('river'), 'custom:river', '内置名也不会与内置项撞存储值')
  assert.equal(normalizePathTypeId('9bad'), null)
  assert.equal(normalizePathTypeId('a'), null)
  assert.equal(normalizePathTypeId('has space'), null)
  assert.equal(normalizePathTypeId(42), null)
})

test('ID 不合法时给的是可读原因（设置页要照着显示）', () => {
  assert.equal(pathTypeIdProblem('highway'), null)
  assert.equal(pathTypeIdProblem(''), 'ID 不能为空')
  assert.equal(pathTypeIdProblem('9bad'), 'ID 必须以小写字母开头（例如 highway）')
  assert.equal(pathTypeIdProblem('a'), 'ID 至少 2 个字符')
  assert.equal(pathTypeIdProblem('x'.repeat(40)), `ID 太长（40 字符，最多 32）`)
  assert.equal(pathTypeIdProblem('bad!name'), 'ID 只能用小写字母、数字、下划线和连字符')
})

test('显示名：留空退化为 ID 主体；过长截断；空白折叠', () => {
  assert.equal(normalizePathTypeLabel('  官道  ', 'custom:highway'), '官道')
  assert.equal(normalizePathTypeLabel('', 'custom:highway'), 'highway')
  assert.equal(normalizePathTypeLabel(null, 'custom:highway'), 'highway')
  assert.equal(normalizePathTypeLabel('a  b', 'custom:x'), 'a b')
  assert.equal(normalizePathTypeLabel('x'.repeat(50), 'custom:x').length, 24)
})

test('上限：自定义类型截断到 MAX_CUSTOM_PATH_TYPES，内置永远不受影响', () => {
  const many = Array.from({ length: MAX_CUSTOM_PATH_TYPES + 5 }, (_value, index) => ({
    id: `type${index}`,
    label: `类型${index}`,
  }))
  const entries = normalizePathTypeEntries(many)
  assert.equal(customPathTypeEntries(entries).length, MAX_CUSTOM_PATH_TYPES)
  assert.equal(entries.length, PATH_TYPES.length + MAX_CUSTOM_PATH_TYPES)
  assert.deepEqual(
    entries.slice(0, PATH_TYPES.length).map((entry) => entry.id),
    [...PATH_TYPES],
    '内置 4 种始终在最前',
  )
})

test('去重：同一个 ID 两条定义时先出现的胜出（先出现的顺序也保留）', () => {
  const entries = normalizePathTypeEntries([
    { id: 'custom:aa', label: '先' },
    { id: 'custom:bb', label: '中' },
    // 同一个 ID 的第二种写法（少了前缀）：规范化之后是同一个 ID，必须被去重掉
    { id: 'aa', label: '后' },
    // 主体只有 1 个字符：按 ID 规则（至少 2 位）不合法，整条丢掉（与自定义地形/标记同一口径）
    { id: 'z', label: '太短' },
  ])
  const custom = customPathTypeEntries(entries)
  assert.deepEqual(custom.map((entry) => entry.id), ['custom:aa', 'custom:bb'])
  assert.equal(custom[0]!.label, '先')
  assert.equal(custom.length, 2, '"z" 不合法，不该混进来')
})

test('条目也接受"扁平写法"（手工编辑 data.json 时最自然的形状）', () => {
  const entries = normalizePathTypeEntries([{ id: 'custom:flat', label: '扁平', color: '#123456', width: 7 }])
  const flat = findPathTypeEntry('custom:flat', entries)!
  assert.equal(flat.params.color, '#123456')
  assert.equal(flat.params.width, 7)
})

// ------------------------------------------------------------ 参数校验

test('虚线三态：缺失 → 出厂虚线；显式 [] → 实线；非法 → 拒绝并给原因', () => {
  // 缺失
  const missing = applyPathTypePatch(findPathTypeEntry('road', defaultPathTypeEntries())!, { color: '#000000' })
  assert.equal(missing.ok, true)
  assert.deepEqual(missing.ok && missing.entry.params.dash, PATH_STYLES.road.dash, '缺字段不能把虚线变实线')
  // 显式实线
  const solid = applyPathTypePatch(findPathTypeEntry('road', defaultPathTypeEntries())!, { dash: [] })
  assert.deepEqual(solid.ok && solid.entry.params.dash, [])
  // 非法：奇数段 / 全 0 / 非数字
  for (const bad of [[1], [0, 0], [12, 'x'], 'oops']) {
    const result = applyPathTypePatch(findPathTypeEntry('road', defaultPathTypeEntries())!, { dash: bad })
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.ok(result.ok === false && result.problem.length > 0, '必须给可读原因')
  }
})

test('端点/连接：合法值保留，非法值回退 round（canvas 会静默忽略非法值）', () => {
  const entry = findPathTypeEntry('river', defaultPathTypeEntries())!
  const cap = applyPathTypePatch(entry, { cap: 'butt' })
  assert.equal(cap.ok && cap.entry.params.cap, 'butt')
  const join = applyPathTypePatch(entry, { join: 'bevel' })
  assert.equal(join.ok && join.entry.params.join, 'bevel')
  const bogus = applyPathTypePatch(entry, { cap: 'wobbly', join: 'nope' })
  assert.equal(bogus.ok && bogus.entry.params.cap, 'round')
  assert.equal(bogus.ok && bogus.entry.params.join, 'round')
})

test('内置类型的显示名不可改（补丁里带了也不采纳），自定义的可以改', () => {
  const builtin = applyPathTypePatch(findPathTypeEntry('river', defaultPathTypeEntries())!, { label: '大河' })
  assert.equal(builtin.ok && builtin.entry.label, '河流')
  const custom = findPathTypeEntry('custom:hw', normalizePathTypeEntries([{ id: 'custom:hw', label: '旧名' }]))!
  const renamed = applyPathTypePatch(custom, { label: '官道' })
  assert.equal(renamed.ok && renamed.entry.label, '官道')
  assert.equal(renamed.ok && renamed.entry.id, 'custom:hw', 'ID 绝不因改名而变（它是数据）')
})

test('补丁不改变 kind（数据大类不是可编辑字段）', () => {
  const entry = findPathTypeEntry('river', defaultPathTypeEntries())!
  const patched = applyPathTypePatch(entry, { color: '#000000' })
  assert.equal(patched.ok && patched.entry.kind, 'path')
})

test('新建自检：ID 非法或虚线非法都拒绝，且不返回半成品', () => {
  const bad = validateCustomPathTypeInput({ id: '9bad' })
  assert.equal(bad.ok, false)
  assert.ok(bad.ok === false && bad.problem.includes('小写字母'))
  const badDash = validateCustomPathTypeInput({ id: 'highway', dash: [1] })
  assert.equal(badDash.ok, false)
  const good = validateCustomPathTypeInput({ id: 'highway', label: '官道', color: '#334455', width: 6, dash: [6, 3], cap: 'square' })
  assert.equal(good.ok, true)
  assert.deepEqual(good.ok && good.entry, {
    id: 'custom:highway',
    label: '官道',
    kind: 'path',
    params: { color: '#334455', width: 6, dash: [6, 3], taper: false, smooth: false, cap: 'square', join: 'round' },
  })
})

test('新建时缺省参数写死且可读（不靠任何隐式推断）', () => {
  const result = validateCustomPathTypeInput({ id: 'plain' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.entry.params, {
    color: '#8fa3b0',
    width: 4,
    dash: [],
    taper: false,
    smooth: false,
    cap: 'round',
    join: 'round',
  })
})

test('虚线文本解析：空 = 实线，逗号/空格都行，非法给原因', () => {
  assert.deepEqual(parsePathDashInput(''), { ok: true, dash: [] })
  assert.deepEqual(parsePathDashInput('   '), { ok: true, dash: [] })
  assert.deepEqual(parsePathDashInput('14,10'), { ok: true, dash: [14, 10] })
  assert.deepEqual(parsePathDashInput('14 10'), { ok: true, dash: [14, 10] })
  assert.deepEqual(parsePathDashInput('14，10'), { ok: true, dash: [14, 10] }, '中文逗号也要认（中文输入法下很容易打出来）')
  const notNumber = parsePathDashInput('14,x')
  assert.equal(notNumber.ok, false)
  assert.ok(notNumber.ok === false && notNumber.problem.includes('x'))
  assert.equal(parsePathDashInput('1').ok, false, '奇数段会让线看起来像噪点')
  assert.equal(parsePathDashInput('0,0').ok, false, '全 0 会让线整条消失')
})

// ------------------------------------------------------------ 恢复 / 签名

test('恢复出厂：内置回到工厂参数，自定义定义原样保留', () => {
  const entries = normalizePathTypeEntries([
    { id: 'custom:hw', label: '官道', params: { color: '#111111', width: 9 } },
    { id: 'river', params: { color: '#ff0000', width: 20, cap: 'butt' } },
  ])
  assert.equal(isDefaultPathTypeStyles(entries), false)
  const reset = resetPathTypeStyles(entries)
  assert.equal(isDefaultPathTypeStyles(reset), true)
  const custom = findPathTypeEntry('custom:hw', reset)!
  assert.equal(custom.params.color, '#111111', '自定义类型是用户建的数据，不该被"恢复样式"顺手改掉')
  assert.equal(custom.params.width, 9)
})

test('工厂参数只对内置类型有意义（自定义类型的缺省值另有一套）', () => {
  for (const type of PATH_TYPES) {
    const params = factoryPathTypeParams(type)
    assert.equal(params.color, PATH_STYLES[type].color)
    assert.ok(params.dash.length === 0 || params.dash.length % 2 === 0)
  }
})

test('列表签名只含"有哪些、叫什么"：改颜色/线宽不会触发下拉重建', () => {
  const before = defaultPathTypeEntries()
  const after = applyPathTypePatch(findPathTypeEntry('river', before)!, { color: '#ff0000', width: 30 })
  assert.equal(after.ok, true)
  const recolored = after.ok ? before.map((entry) => (entry.id === 'river' ? after.entry : entry)) : before
  assert.equal(
    pathTypeCatalogSignature(recolored),
    pathTypeCatalogSignature(before),
    '签名里若有参数，改个颜色就会重建整排选项（丢掉展开状态）',
  )
  // 反过来：增删类型或改名必须改变签名
  assert.notEqual(pathTypeCatalogSignature(normalizePathTypeEntries([{ id: 'custom:hw' }])), pathTypeCatalogSignature(before))
  const renamed = before.map((entry) => (entry.id === 'road' ? { ...entry, label: '大路' } : entry))
  assert.notEqual(pathTypeCatalogSignature(renamed), pathTypeCatalogSignature(before))
})

test('kind 维度已就位（区域这一轮不接线，但数据结构不挡下一增量）', () => {
  const entries = normalizePathTypeEntries([
    { id: 'custom:kingdom', label: '王国', kind: 'region' },
    { id: 'custom:hw', label: '官道', kind: 'path' },
  ])
  assert.equal(findPathTypeEntry('custom:kingdom', entries)!.kind, 'region')
  assert.deepEqual(listPathTypeEntries(entries, 'path').map((entry) => entry.id), ['river', 'road', 'trade-route', 'border', 'custom:hw'])
  assert.deepEqual(listPathTypeEntries(entries, 'region').map((entry) => entry.id), ['custom:kingdom'])
  assert.equal(isBuiltinPathType('river'), true)
  assert.equal(isBuiltinPathType('custom:river'), false)
})

test('参数的可读描述包含线宽与虚实（工具条提示据此比较两种类型）', () => {
  const text = describePathTypeParams(resolvePathType('road', defaultPathTypeEntries()).params)
  assert.ok(text.includes('线宽 5'), text)
  assert.ok(text.includes('虚线'), text)
  const solid = describePathTypeParams(resolvePathType('river', defaultPathTypeEntries()).params)
  assert.ok(solid.includes('实线'), solid)
  assert.ok(solid.includes('末端变细'), solid)
})

test('类型别名：PathType 是字符串（未知 ID 也能当类型传）', () => {
  const weird: PathType = 'from-another-plugin'
  assert.equal(resolvePathType(weird, defaultPathTypeEntries()).unknown, true)
})
