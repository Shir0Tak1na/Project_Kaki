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
  allLayersHidden,
  hiddenLayerLabels,
  isLayerVisible,
  layerVisibilityFromLegacy,
  normalizeLayerVisibility,
  withLayerVisibility,
} from '../src/render/layerVisibility.ts'
import { buildLegendEntries, legendLines } from '../src/render/legend.ts'
import { PATH_STYLES } from '../src/render/shapeStyle.ts'
import { TERRAIN_TYPES } from '../src/data/mapDocument.ts'
import type { MapDocument } from '../src/data/mapDocument.ts'

/* ------------------------------------------------------------ 图层开关 */

test('出厂默认：六层全部显示，且键集合就是 LAYER_KEYS', () => {
  assert.deepEqual(Object.keys(DEFAULT_LAYER_VISIBILITY).sort(), [...LAYER_KEYS].sort())
  assert.equal(LAYER_KEYS.length, 6)
  for (const key of LAYER_KEYS) assert.equal(DEFAULT_LAYER_VISIBILITY[key], true, key)
  assert.equal(isLayerVisible(DEFAULT_LAYER_VISIBILITY, 'terrain'), true)
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
  assert.deepEqual(hiddenLayerLabels(visibility), ['路径', '名称'])
  assert.deepEqual(hiddenLayerLabels(DEFAULT_LAYER_VISIBILITY), [])
  assert.equal(allLayersHidden(DEFAULT_LAYER_VISIBILITY), false)
  let all = DEFAULT_LAYER_VISIBILITY
  for (const key of LAYER_KEYS) all = withLayerVisibility(all, key, false)
  assert.equal(allLayersHidden(all), true)
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
  // 坏格（缺 t）应被跳过，而不是产生一个 label 为空的条目
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
