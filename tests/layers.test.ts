/**
 * 图层开关与图例的单元测试。
 *
 * 两条最值钱的断言在这里：
 * 1. **图例顺序必须来自 `TERRAIN_TYPES`**（不许在渲染侧再抄一份清单 ——
 *    本项目已经因为"抄一份调色板"出过真事故）；
 * 2. **图层开关是纯数据**：隐藏某层只影响"画不画"，不该改动任何地图数据
 *    （所以这里的断言全部针对函数返回值，而不是"调用了几次 API"）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DEFAULT_LAYER_VISIBILITY,
  LAYER_KEYS,
  LAYER_TABLE,
  LAYERS_BY_DRAW_ORDER,
  allLayersHidden,
  hiddenLayerLabels,
  isLayerVisible,
  layerVisibilityFromLegacy,
  normalizeLayerVisibility,
  withLayerVisibility,
} from '../src/render/layerVisibility.ts'
import { buildLegendEntries, legendLines, rampGradientCss } from '../src/render/legend.ts'
import { DEFAULT_OVERLAY_STYLES } from '../src/render/overlayFields.ts'
import { PATH_STYLES } from '../src/render/shapeStyle.ts'
import { TERRAIN_TYPES } from '../src/data/mapDocument.ts'
import type { MapDocument } from '../src/data/mapDocument.ts'

/* ------------------------------------------------------------ 图层开关 */

test('出厂默认：键集合就是 LAYER_KEYS，且数据层（温度 / 深度）默认隐藏', () => {
  assert.deepEqual(Object.keys(DEFAULT_LAYER_VISIBILITY).sort(), [...LAYER_KEYS].sort())
  assert.equal(LAYER_KEYS.length, 8)
  for (const spec of LAYER_TABLE) assert.equal(DEFAULT_LAYER_VISIBILITY[spec.id], spec.defaultVisible, spec.id)
  assert.equal(isLayerVisible(DEFAULT_LAYER_VISIBILITY, 'terrain'), true)
  // 数据层默认关：新功能不该在用户没要求时改变现有画面（设计草案 §4.1）
  assert.equal(DEFAULT_LAYER_VISIBILITY.temperature, false)
  assert.equal(DEFAULT_LAYER_VISIBILITY.depth, false)
})

test('归一化：坏输入按"显示"补齐，而不是把地图变成空白', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    assert.deepEqual(normalizeLayerVisibility(bad), DEFAULT_LAYER_VISIBILITY, String(bad))
  }
  const partial = normalizeLayerVisibility({ terrain: false, markers: 'yes', extra: false })
  assert.equal(partial.terrain, false, '显式的 false 必须被保留')
  assert.equal(partial.markers, true, '非布尔值一律按默认（显示）处理')
  assert.equal(partial.paths, true, '缺项按默认补齐')
  assert.equal('extra' in partial, false, '不认识的键不该进入设置')
})

test('旧设置迁移：showGrid=false 表示隐藏网格，其余层照常显示', () => {
  const migrated = layerVisibilityFromLegacy({ showGrid: false, labelScale: 2 })
  assert.equal(migrated.grid, false)
  assert.equal(migrated.terrain, true)
  // 已经有 layers 时以 layers 为准（不能再被旧字段覆盖）
  const both = layerVisibilityFromLegacy({ showGrid: false, layers: { grid: true } })
  assert.equal(both.grid, true)
})

test('切换图层返回新对象（不原地改），且值相同时复用原对象', () => {
  const next = withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'terrain', false)
  assert.equal(next.terrain, false)
  assert.equal(DEFAULT_LAYER_VISIBILITY.terrain, true, '原对象不能被改（否则"设置变更"没法比较）')
  assert.equal(withLayerVisibility(next, 'terrain', false), next, '值没变就不该产生新对象')
})

test('隐藏清单：给状态命令一个可读答案', () => {
  const visibility = withLayerVisibility(withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'paths', false), 'labels', false)
  // 顺序取自表的行序（两条数据层在路径之前）
  assert.deepEqual(hiddenLayerLabels(visibility), ['温度', '深度', '路径', '名称'])
  // 出厂状态：只有数据层被隐着（它们不是"坏了"，是"还没打开"）
  assert.deepEqual(hiddenLayerLabels(DEFAULT_LAYER_VISIBILITY), ['温度', '深度'])
  assert.equal(allLayersHidden(DEFAULT_LAYER_VISIBILITY), false)
  let all = DEFAULT_LAYER_VISIBILITY
  for (const key of LAYER_KEYS) all = withLayerVisibility(all, key, false)
  assert.equal(allLayersHidden(all), true)
})

/* ------------------------------------------------------------ 图层描述表 */

test('层描述表：id 唯一、键集合与表一致（加一层 = 加一行）', () => {
  const ids = LAYER_TABLE.map((spec) => spec.id)
  assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.join(',')}`)
  assert.deepEqual([...LAYER_KEYS], ids, 'LAYER_KEYS 必须由表派生（不许另有第二份清单）')
  assert.equal(LAYER_TABLE.length, 8, '当前八层（温度 / 深度是两份数据层模板，见 §5.45 / §5.48）；加层时这一条要跟着改')
})

test('每一行都写清"叫什么 / 管什么 / 关掉会怎样"：三个给人看的字段都不许空', () => {
  for (const spec of LAYER_TABLE) {
    for (const field of ['label', 'hint', 'describe'] as const) {
      const value = spec[field]
      assert.equal(typeof value, 'string', `${spec.id}.${field} 必须是字符串`)
      assert.ok(value.trim().length > 0, `${spec.id}.${field} 不许留空（用户会看到一句空白提示）`)
    }
    assert.equal(LAYER_KEYS.includes(spec.id), true)
  }
})

test('绘制次序是显式的（自下而上）：钉住整条叠加序列，防"地貌盖住路径"这类回归', () => {
  assert.deepEqual(
    LAYERS_BY_DRAW_ORDER.map((spec) => spec.id),
    // 数据层压在地形之上、网格与矢量对象之下（设计草案 §4.1）
    ['terrain', 'temperature', 'depth', 'grid', 'regions', 'labels', 'paths', 'markers'],
    '改这张表的 order 等于改画面层次，必须是有意识的一步',
  )
  const orders = LAYER_TABLE.map((spec) => spec.order)
  assert.equal(new Set(orders).size, orders.length, '两层不许共用一个次序（排序结果会不稳定）')
  // 表里"谁在谁上面"不能只靠行序巧合：行序是界面显示顺序，两回事
  const rowOrder = [...LAYER_TABLE].map((spec) => spec.id).join(',')
  assert.notEqual(LAYERS_BY_DRAW_ORDER.map((spec) => spec.id).join(','), rowOrder, '本表里显示顺序与绘制顺序刻意不同（名称在路径之前显示、却在路径之下画）')
})

test('出厂默认与表一一对应，且"是否数据层"的界线写清（表现层不进地图数据）', () => {
  for (const spec of LAYER_TABLE) {
    assert.equal(DEFAULT_LAYER_VISIBILITY[spec.id], spec.defaultVisible, spec.id)
  }
  const displayLayers = LAYER_TABLE.filter((spec) => !spec.isDataLayer).map((spec) => spec.id)
  assert.deepEqual(displayLayers, ['grid', 'labels'], '网格与名称是纯表现：地图文件里没有它们的实体')
  const dataLayers = LAYER_TABLE.filter((spec) => spec.isDataLayer).map((spec) => spec.id)
  // 数据层 = 地图文件里有对应实体：格上的地形 / 温度 / 深度，文档里的区域 / 路径 / 标记
  assert.deepEqual(dataLayers, ['terrain', 'temperature', 'depth', 'regions', 'paths', 'markers'])
})

/* ---------------------------------------------------------------- 图例 */

/** 最小可用地图：3 格地形（两种）、1 条河、1 条路、2 个区域（同色 + 异色） */
function makeDocument(): MapDocument {
  return {
    version: 1,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: {
      '0_0': { t: 'forest' },
      '1_0': { t: 'water' },
      '-1_3': { t: 'forest' },
      '2_2': { t: 'custom-bog' },
    },
    paths: [
      { id: 'p1', type: 'river', pts: [[0, 0], [10, 10]], width: 8, color: '#4a9fd8' },
      { id: 'p2', type: 'road', pts: [[0, 0], [10, 10]], width: 5, color: '#b08968' },
      { id: 'p3', type: 'river', pts: [[2, 2], [12, 12]], width: 8, color: '#4a9fd8' },
    ],
    regions: [
      { id: 'r1', label: '北境', pts: [[0, 0], [1, 0], [1, 1]], color: '#44cf6e', opacity: 0.22 },
      { id: 'r2', label: '南境', pts: [[0, 0], [1, 0], [1, 1]], color: '#44cf6e', opacity: 0.22 },
      { id: 'r3', label: '海域', pts: [[0, 0], [1, 0], [1, 1]], color: '#4a9fd8', opacity: 0.22 },
    ],
    markers: [],
    labels: [],
  }
}

const deps = {
  resolveTerrain: (type: string) => ({ label: `地形:${type}`, color: type === 'custom-bog' ? '#6b8f71' : '#3f7d3f' }),
  // 类型放宽成 string：自定义/未知类型也要能进图例（内置表只在认识 ID 时用得着）
  resolvePath: (type: string) => {
    const style = (PATH_STYLES as Record<string, (typeof PATH_STYLES)[keyof typeof PATH_STYLES]>)[type]
    if (!style) return { label: `未知:${type}`, color: '#000000' }
    return { label: style.label, color: style.color, ...(style.dash ? { dash: style.dash } : {}) }
  },
  resolveRegion: (color: string) => ({ label: color === '#44cf6e' ? '王国' : '水域' }),
}

test('图例从地图实际内容生成：只列用到的，数量正确', () => {
  const entries = buildLegendEntries(makeDocument(), deps)
  const terrain = entries.filter((entry) => entry.kind === 'terrain')
  assert.deepEqual(terrain.map((entry) => entry.label), ['地形:forest', '地形:water', '地形:custom-bog'])
  assert.deepEqual(terrain.map((entry) => entry.count), [2, 1, 1])

  const paths = entries.filter((entry) => entry.kind === 'path')
  assert.deepEqual(paths.map((entry) => entry.label), ['河流', '道路'], '顺序取 PATH_TYPES，不按出现顺序')
  assert.deepEqual(paths.map((entry) => entry.count), [2, 1])
  assert.deepEqual(paths[1]!.dash, PATH_STYLES.road.dash, '虚线要带出来，否则图例分不清道路与河流')

  const regions = entries.filter((entry) => entry.kind === 'region')
  assert.equal(regions.length, 2, '同色区域归并为一条')
  assert.deepEqual(regions.map((entry) => entry.count).sort(), [1, 2])
})

test('图例的色带条目：只数有值的格、两端刻度、越界两项只在真有越界格时出现', () => {
  const document = makeDocument()
  // 4 格：1 格没温度（不计入）、1 格带内、1 格低于下限、1 格高于上限
  document.terrain['0_0']!.temp = 12
  document.terrain['1_0']!.temp = -60
  document.terrain['-1_3']!.temp = 80
  const rampEntries = buildLegendEntries(document, deps).filter((entry) => entry.kind === 'ramp')
  assert.equal(rampEntries.length, 1, '有温度就出一条色带')
  const entry = rampEntries[0]!
  assert.equal(entry.label, '温度（℃）')
  assert.equal(entry.count, 3, '没有温度的格不算"有值"')
  assert.deepEqual(entry.outOfRange, { under: 1, over: 1 })
  assert.equal(entry.ramp?.min, -30)
  assert.equal(entry.ramp?.max, 45)
  assert.equal(entry.ramp?.underColor, '#0000ff')
  assert.equal(entry.ramp?.overColor, '#ff0000')
  // 刻度文字由字段自己格式化（温度没有换算，就是"值 + 紧跟的单位"）
  assert.equal(entry.ramp?.minLabel, '-30℃')
  assert.equal(entry.ramp?.maxLabel, '45℃')
  assert.equal(rampGradientCss(entry.ramp!).startsWith('linear-gradient(90deg, #0000ff 0.00%'), true, rampGradientCss(entry.ramp!))

  // 没有越界格时，那两项**不该出现**（同"图例只列实际有的东西"）
  document.terrain = { '0_0': { temp: 12 } }
  const onlyInRange = buildLegendEntries(document, deps).filter((entry) => entry.kind === 'ramp')[0]!
  assert.equal(onlyInRange.outOfRange, undefined)
  assert.equal(onlyInRange.count, 1)

  // 地图上根本没有值 → 一条色带都不出现（不能写一条"空气色带"）
  document.terrain = { '0_0': { t: 'forest' } }
  assert.deepEqual(buildLegendEntries(document, deps).filter((entry) => entry.kind === 'ramp'), [])

  // 图层关掉 → 那一段整个不出现（与其它段同一个机制）
  document.terrain['0_0']!.temp = 12
  assert.deepEqual(
    buildLegendEntries(document, deps, withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'temperature', false)).filter(
      (entry) => entry.kind === 'ramp',
    ),
    [],
  )
})

test('图例的深度条目：刻度按展示单位换算（km / 相对值），标定从地图文件的 elevation 段现取', () => {
  const base = makeDocument()
  base.terrain = { '0_0': { depth: 3000 }, '1_0': { depth: -1000 } }

  const entryFor = (unit: 'm' | 'km' | 'rel', elevation?: MapDocument['elevation']) => {
    const target: MapDocument = elevation ? { ...base, elevation } : { ...base }
    const overlayStyles = { ...DEFAULT_OVERLAY_STYLES, depth: { ...DEFAULT_OVERLAY_STYLES.depth, unit } }
    const found = buildLegendEntries(target, { ...deps, overlayStyles }).filter((item) => item.kind === 'ramp')[0]
    assert.ok(found, `深度层没出条目（unit=${unit}）`)
    return found
  }

  const meters = entryFor('m')
  assert.equal(meters.label, '深度 / 海拔（m）')
  assert.equal(meters.count, 2, '有深度的两格都算"有值"')
  assert.equal(meters.ramp?.minLabel, '-4000 m', '米这一档就是原值')
  assert.equal(meters.ramp?.maxLabel, '4000 m')

  const km = entryFor('km')
  assert.equal(km.label, '深度 / 海拔（km）', '标题里的单位跟着展示单位走')
  assert.equal(km.ramp?.minLabel, '-4 km')
  assert.equal(km.ramp?.maxLabel, '4 km')

  // 相对值要标定才算得出来：没标定时读数是"未标定"，而不是编一个数字
  const uncalibrated = entryFor('rel')
  assert.equal(uncalibrated.label, '深度 / 海拔（相对值 0–1）')
  assert.equal(uncalibrated.ramp?.minLabel, '未标定')

  const calibrated = entryFor('rel', { unit: 'm', maxDepth: 8000, maxHeight: 3000 })
  // 最深 8000 → 0、最高 −3000 → 1；两端锚点是 −4000 / 4000：
  // rel(−4000) = (8000+4000)/11000 ≈ 1.09 → 夹到 1；rel(4000) = 4000/11000 ≈ 0.36
  assert.equal(calibrated.ramp?.minLabel, '1', '超出最高点的一端夹到 1')
  assert.equal(calibrated.ramp?.maxLabel, '0.36')
})

test('渐变的刻度按**值**归一化，而不是按锚点序号平均分', () => {
  const info = {
    stops: [
      { value: -30, color: '#0000ff' },
      { value: 0, color: '#00c8c8' },
      { value: 45, color: '#ff0000' },
    ],
    underColor: '#0000ff',
    overColor: '#ff0000',
    unit: '℃',
    min: -30,
    max: 45,
    minLabel: '-30℃',
    maxLabel: '45℃',
  }
  // 0 在 -30~45 里位于 30/75 = 40%（若按序号平均分会是 50% —— 那正是要防的写法）
  assert.equal(rampGradientCss(info), 'linear-gradient(90deg, #0000ff 0.00%, #00c8c8 40.00%, #ff0000 100.00%)')
  assert.equal(rampGradientCss({ ...info, stops: [{ value: 5, color: '#111111' }], min: 5, max: 5 }), 'linear-gradient(90deg, #111111 0.00%)', '零跨度不许除零')
  assert.equal(rampGradientCss({ ...info, stops: [] }), '')
})

test('图例的地形顺序来自 TERRAIN_TYPES（渲染侧不许再抄一份清单）', () => {
  const document = makeDocument()
  // 顺序故意给成乱序：图例必须自己排成出厂顺序。
  // ⚠️ 这里用的必须是**真的内置 ID**：我第一版写的是 volcano/grass/water，
  // 其中有两个根本不是合法 ID —— 断言照样"通过"，但它证明不了任何事（自欺）。
  const used = ['volcanic', 'plains', 'water'] as const
  document.terrain = { '0_0': { t: used[0] }, '1_0': { t: used[1] }, '2_0': { t: used[2] } }
  const labels = buildLegendEntries(document, deps)
    .filter((entry) => entry.kind === 'terrain')
    .map((entry) => entry.label.replace('地形:', ''))
  const expected = TERRAIN_TYPES.filter((type) => (used as readonly string[]).includes(type))
  assert.deepEqual(labels, expected, `实际 ${labels.join(',')} · 期望 ${expected.join(',')}`)
  assert.equal(expected.length, 3, '前提：三个 ID 都必须是合法内置类型，否则这条断言没有鉴别力')
  assert.ok(
    used.every((type) => (TERRAIN_TYPES as readonly string[]).includes(type)),
    `前提校验：${used.join('/')} 必须都在 TERRAIN_TYPES 里（写错 ID 的断言证明不了任何事）`,
  )
})

test('自定义地形排在内置之后，且按 ID 排序（顺序确定，不会每次重绘都跳）', () => {
  const document = makeDocument()
  document.terrain = { '0_0': { t: 'zzz' }, '1_0': { t: 'aaa' }, '2_0': { t: 'forest' }, '3_0': { t: 'water' } }
  const labels = buildLegendEntries(document, deps)
    .filter((entry) => entry.kind === 'terrain')
    .map((entry) => entry.label.replace('地形:', ''))
  assert.deepEqual(labels, ['forest', 'water', 'aaa', 'zzz'])
})

test('图例受图层开关影响：隐藏的层不出条目（这是"实际启用"的含义）', () => {
  const visibility = withLayerVisibility(withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'terrain', false), 'regions', false)
  const entries = buildLegendEntries(makeDocument(), deps, visibility)
  assert.deepEqual([...new Set(entries.map((entry) => entry.kind))], ['path'])
  // 关掉路径也关掉之后，图例为空（而不是保留一份静态清单）
  const none = buildLegendEntries(makeDocument(), deps, withLayerVisibility(visibility, 'paths', false))
  assert.deepEqual(none, [])
})

test('图例对空/坏数据安全：不抛异常、不产生空标签条目', () => {
  assert.deepEqual(buildLegendEntries(null, deps), [])
  const empty = { ...makeDocument(), terrain: {}, paths: [], regions: [] }
  assert.deepEqual(buildLegendEntries(empty, deps), [])
  // 没有地形的格（缺 t）应被跳过，而不是产生一个 label 为空的条目
  const broken = { ...makeDocument(), terrain: { '0_0': {} as { t: string } } }
  assert.deepEqual(buildLegendEntries(broken, deps).filter((entry) => entry.kind === 'terrain'), [])
  // 一条路径都没有的类型不该出现
  const onlyRiver = { ...makeDocument(), paths: makeDocument().paths.filter((path) => path.type === 'river') }
  assert.deepEqual(
    buildLegendEntries(onlyRiver, deps)
      .filter((entry) => entry.kind === 'path')
      .map((entry) => entry.label),
    ['河流'],
  )
})

test('一行文本：给命令输出用，能看出层与颜色', () => {
  const lines = legendLines(buildLegendEntries(makeDocument(), deps))
  assert.equal(lines.length > 0, true)
  assert.match(lines[0]!, /^(地形|路径|区域) · /)
  assert.equal(legendLines(buildLegendEntries(makeDocument(), deps), 1).length, 1)
})
