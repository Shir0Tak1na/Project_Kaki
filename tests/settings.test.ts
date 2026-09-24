/**
 * 设置模型的契约测试。
 *
 * 这个文件存在的原因很具体：`normalizeSettings` 是 `data.json` 的**唯一收敛入口**，
 * 但它原来住在 `SettingsTab.ts` 里，而那个文件 import 了 obsidian ——
 * 单元测试走 ESM，冒烟的 `Module._load` 猴补丁只管 CommonJS，于是它一条单测都没有。
 * 现在模型搬到了 `src/ui/settingsModel.ts`（不 import obsidian），契约可以钉死了。
 *
 * 这里断言的重点不是"函数能跑"，而是**坏输入必须被收敛到可用值**：
 * 用户的 `data.json` 会被手工编辑、会被旧版本写、会被同步工具截断，
 * 任何一种进来都不该让插件崩掉或悄悄丢掉他没改过的设置。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DEFAULT_SETTINGS,
  LABEL_SCALE_MAX,
  LABEL_SCALE_MIN,
  normalizeLabelScale,
  normalizeSettings,
  paletteOf,
  type CartographerSettings,
} from '../src/ui/settingsModel.ts'
import { DEFAULT_LAYER_VISIBILITY, LAYER_KEYS } from '../src/render/layerVisibility.ts'
import { PATH_STYLES, REGION_PRESETS } from '../src/render/shapeStyle.ts'
import { MAX_CUSTOM_TERRAINS } from '../src/render/terrainCatalog.ts'

test('彻底坏的输入一律收敛成完整默认值（而不是抛异常或留 undefined）', () => {
  // 用 keyof 而不是"转成 Record 再索引"：转换会被 tsc 拦（接口没有索引签名），
  // 而且 keyof 能在编译期保证这些字段真的存在于设置里 —— 少一个字段就编译不过。
  const keys = [
    'labelScale',
    'developerMode',
    'pathColors',
    'regionColors',
    'labelFontFamily',
    'customTerrains',
    'layers',
    'showLegend',
  ] as const satisfies readonly (keyof CartographerSettings)[]
  for (const bad of [null, undefined, 42, 'nope', [], true, Symbol('x')]) {
    const settings = normalizeSettings(bad)
    assert.deepEqual(settings, DEFAULT_SETTINGS, String(bad))
    for (const key of keys) assert.notEqual(settings[key], undefined, `${String(bad)} / ${key}`)
  }
})

test('未知键被丢掉（别的版本写的字段不该被带进来）', () => {
  const settings = normalizeSettings({ labelScale: 2, somethingElse: 123, showGrid2: false })
  assert.equal('somethingElse' in settings, false)
  assert.equal('showGrid2' in settings, false)
  assert.equal('showGrid' in settings, false, '旧字段只作为迁移输入，不该被写进新结构')
  assert.equal(settings.labelScale, 2)
})

test('字号倍率：越界 / NaN / 字符串都被收敛到合法区间', () => {
  assert.equal(normalizeLabelScale(99), LABEL_SCALE_MAX)
  assert.equal(normalizeLabelScale(-5), LABEL_SCALE_MIN)
  assert.equal(normalizeLabelScale(Number.NaN), DEFAULT_SETTINGS.labelScale)
  assert.equal(normalizeLabelScale('1.7'), 1.7)
  assert.equal(normalizeLabelScale('nope'), DEFAULT_SETTINGS.labelScale)
  assert.equal(normalizeLabelScale(null), DEFAULT_SETTINGS.labelScale)
  assert.equal(normalizeLabelScale(1.234), 1.2, '按 0.1 步长取整')
  // 边界值本身要保持（不是"回到默认"）
  assert.equal(normalizeLabelScale(LABEL_SCALE_MIN), LABEL_SCALE_MIN)
  assert.equal(normalizeLabelScale(LABEL_SCALE_MAX), LABEL_SCALE_MAX)
})

test('颜色表：缺项补齐、非法色回退、未知类型不进结果', () => {
  const settings = normalizeSettings({
    pathColors: { river: '#ff0000', road: 'var(--x)', nonsense: '#000000' },
    regionColors: ['#111111', 'nope', null],
  })
  const river = PATH_STYLES.river.color
  assert.equal(settings.pathColors.river, '#ff0000', '合法颜色要保留')
  assert.equal(settings.pathColors.road, PATH_STYLES.road.color, '非法颜色回退出厂色')
  assert.equal(settings.pathColors.border, PATH_STYLES.border.color, '缺项按出厂色补齐')
  assert.equal('nonsense' in settings.pathColors, false, '不认识的路径类型不该进设置')
  assert.equal(settings.regionColors.length, REGION_PRESETS.length)
  assert.equal(settings.regionColors[0], '#111111')
  assert.equal(settings.regionColors[1], REGION_PRESETS[1]!.color, '非法区域色回退出厂色')
})

test('字体族：整条 font 简写与 var() 都必须被拒（它们会让 ctx.font 静默失效）', () => {
  assert.equal(normalizeSettings({ labelFontFamily: 'var(--font-interface)' }).labelFontFamily, '')
  assert.equal(normalizeSettings({ labelFontFamily: '600 24px sans-serif' }).labelFontFamily, '')
  assert.equal(normalizeSettings({ labelFontFamily: 'Noto Serif SC, serif' }).labelFontFamily, 'Noto Serif SC, serif')
  assert.equal(normalizeSettings({ labelFontFamily: 42 }).labelFontFamily, '')
})

test('自定义地形：坏条目只丢自己、重复 ID 去重（先出现的胜出）、ID 被归一化', () => {
  const settings = normalizeSettings({
    customTerrains: [
      { id: 'Swamp2', label: '沼泽地', color: '#336655', glyph: 'forest', imagePath: 'Assets/a.png' },
      { id: 'custom:swamp2', label: '重复的', color: '#000000' }, // 归一化后与上一条同 ID → 应被丢掉
      { id: '!!bad!!' }, // 非法 ID → 丢掉它自己
      'not-an-object',
      { id: 'reef', color: 'nope' }, // 合法 ID，颜色非法 → 回退出厂色
    ],
  })
  assert.equal(settings.customTerrains.length, 2, JSON.stringify(settings.customTerrains))
  const [first, second] = settings.customTerrains
  assert.equal(first!.id, 'custom:swamp2', 'ID 统一小写并自动补前缀')
  assert.equal(first!.label, '沼泽地')
  assert.equal(first!.color, '#336655')
  assert.equal(first!.glyph, 'forest', '字形可以借内置类型')
  assert.equal(first!.imagePath, 'Assets/a.png')
  assert.equal(second!.id, 'custom:reef')
  assert.notEqual(second!.color, 'nope', '非法颜色不能透传')
})

test('自定义地形：图片路径的四种非法形态都要被挡掉（否则某一格会永远画不出来）', () => {
  const bad = ['../secret.png', 'C:\\pics\\a.png', '/abs/a.png', 'https://example.com/a.png', 'notes/a.txt', 'Assets/../../x.png']
  for (const imagePath of bad) {
    const settings = normalizeSettings({ customTerrains: [{ id: 'reef', imagePath }] })
    assert.equal(settings.customTerrains[0]!.imagePath, '', `${imagePath} 应被拒绝`)
  }
  const good = normalizeSettings({ customTerrains: [{ id: 'reef', imagePath: 'Assets\\sub\\Forest.PNG' }] })
  assert.equal(good.customTerrains[0]!.imagePath, 'Assets/sub/Forest.PNG', '反斜杠统一成正斜杠，扩展名不分大小写')
})

test('自定义地形：数量上限生效（图集位图宽度所限）', () => {
  const many = Array.from({ length: MAX_CUSTOM_TERRAINS + 12 }, (_value, index) => ({ id: `terrain-${index}` }))
  const settings = normalizeSettings({ customTerrains: many })
  assert.equal(settings.customTerrains.length, MAX_CUSTOM_TERRAINS)
  assert.equal(settings.customTerrains[0]!.id, 'custom:terrain-0', '保留的是靠前的那些（顺序可预期）')
})

test('图层迁移：旧 showGrid:false 必须变成"隐藏网格"，其余层照常显示', () => {
  const settings = normalizeSettings({ showGrid: false })
  assert.equal(settings.layers.grid, false)
  for (const key of LAYER_KEYS) {
    if (key === 'grid') continue
    assert.equal(settings.layers[key], true, key)
  }
  // 已经是新结构时，旧字段不许再覆盖它（否则老文件里残留的 showGrid 会一直压着用户的设置）
  assert.equal(normalizeSettings({ showGrid: false, layers: { grid: true } }).layers.grid, true)
  // 旧字段为 true 时也照常
  assert.equal(normalizeSettings({ showGrid: true }).layers.grid, true)
  // 坏值按默认（显示）处理：宁可多看到东西，也不要让用户面对一张空白地图
  assert.equal(normalizeSettings({ layers: { terrain: 'yes' } }).layers.terrain, true)
  assert.equal(normalizeSettings({ layers: { terrain: false } }).layers.terrain, false)
})

test('布尔字段：只有明确为 true 才为真（垃圾值一律当"关"）', () => {
  assert.equal(normalizeSettings({}).showLegend, false)
  assert.equal(normalizeSettings({ showLegend: 'yes' }).showLegend, false)
  assert.equal(normalizeSettings({ showLegend: 1 }).showLegend, false)
  assert.equal(normalizeSettings({ showLegend: true }).showLegend, true)
  assert.equal(normalizeSettings({ developerMode: 'on' }).developerMode, false)
  assert.equal(normalizeSettings({ developerMode: true }).developerMode, true)
})

test('图层对象是新建的（不与出厂默认共享引用，避免一处改动污染所有实例）', () => {
  const settings = normalizeSettings({})
  assert.deepEqual(settings.layers, DEFAULT_LAYER_VISIBILITY)
  assert.notEqual(settings.layers, DEFAULT_LAYER_VISIBILITY, '必须是新对象')
  settings.layers.terrain = false
  assert.equal(DEFAULT_LAYER_VISIBILITY.terrain, true, '改实例不该影响出厂默认')
})

test('幂等性：归一化两次与一次结果完全相同（能抓住"归一化不彻底"的回归）', () => {
  const messy = {
    labelScale: '2.76',
    developerMode: 'yes',
    showGrid: false,
    pathColors: { river: 'var(--x)', road: '#00ff00' },
    regionColors: ['nope'],
    labelFontFamily: '600 24px sans-serif',
    customTerrains: [{ id: 'Reef', color: 'nope' }, { id: 'bad id' }],
    layers: { terrain: 'maybe', paths: false },
    showLegend: 1,
    junk: true,
  }
  const once = normalizeSettings(messy)
  const twice = normalizeSettings(once)
  assert.deepEqual(twice, once)
  // 顺手确认这份"脏数据"确实被收敛成了有意义的值，而不是全都退化成默认
  assert.equal(once.labelScale, 2.8)
  assert.equal(once.pathColors.road, '#00ff00')
  assert.equal(once.pathColors.river, PATH_STYLES.river.color)
  assert.equal(once.layers.paths, false)
  assert.equal(once.layers.terrain, true)
  assert.equal(once.customTerrains.length, 1)
  assert.equal(once.customTerrains[0]!.id, 'custom:reef')
  assert.equal('junk' in once, false)
})

test('调色板：设置 → 绘制层的投影只含绘制需要的东西', () => {
  const settings = normalizeSettings({ pathColors: { river: '#ff0000' }, labelFontFamily: 'Georgia, serif' })
  const palette = paletteOf(settings)
  assert.equal(palette.pathColors.river, '#ff0000')
  assert.equal(palette.fontFamily, 'Georgia, serif')
  assert.equal(palette.regionColors.length, REGION_PRESETS.length)
  assert.deepEqual(Object.keys(palette).sort(), ['fontFamily', 'pathColors', 'regionColors'])
})

/* ------------------------------------------------- 区域类型迁移（⑤-2）

   与路径那一套逐条对应：旧字段只在加载时读一次，之后目录是唯一来源；
   迁移必须幂等，且"用户没改过"时结果逐字段等于出厂（= 升级前后视觉一致）。 */

test('没有旧字段时，区域类型目录就是出厂目录（用户没改过 = 视觉不变）', () => {
  const settings = normalizeSettings({})
  assert.deepEqual(
    settings.regionTypes,
    normalizeSettings({ regionTypes: undefined }).regionTypes,
  )
  assert.equal(settings.regionTypes.length, REGION_PRESETS.length)
  assert.deepEqual(
    settings.regionTypes.map((entry) => entry.params.color),
    REGION_PRESETS.map((preset) => preset.color),
  )
  assert.deepEqual(settings.regionColors, REGION_PRESETS.map((preset) => preset.color))
})

test('旧字段 regionColors 按下标迁进区域类型目录（颜色真的过去了）', () => {
  const settings = normalizeSettings({ regionColors: ['#111111', '#222222', '#333333'] })
  assert.equal(settings.regionTypes[0]!.params.color, '#111111')
  assert.equal(settings.regionTypes[1]!.params.color, '#222222')
  assert.equal(settings.regionTypes[2]!.params.color, '#333333')
  // 没写的下标仍然出厂
  assert.equal(settings.regionTypes[5]!.params.color, REGION_PRESETS[5]!.color)
  // 旧字段与目录保持一致（它是镜像，不是第二个来源）
  assert.deepEqual(settings.regionColors, ['#111111', '#222222', '#333333', ...REGION_PRESETS.slice(3).map((p) => p.color)])
})

test('区域类型迁移是幂等的：把收敛结果再收敛一次完全相同', () => {
  const once = normalizeSettings({ regionColors: ['#111111', '#222222'], regionTypes: [{ id: 'custom:march', label: '边境' }] })
  const twice = normalizeSettings(JSON.parse(JSON.stringify(once)))
  assert.deepEqual(twice.regionTypes, once.regionTypes)
  assert.deepEqual(twice.regionColors, once.regionColors)
})

test('目录里的参数优先于旧字段（显式写过的以它为准）', () => {
  const settings = normalizeSettings({
    regionColors: ['#111111'],
    regionTypes: [{ id: 'realm', params: { color: '#abcdef', opacity: 0.5, borderWidth: 0 } }],
  })
  assert.equal(settings.regionTypes[0]!.params.color, '#abcdef')
  assert.equal(settings.regionTypes[0]!.params.opacity, 0.5)
  assert.equal(settings.regionTypes[0]!.params.borderWidth, 0)
  // 镜像跟着目录走
  assert.equal(settings.regionColors[0], '#abcdef')
})

test('区域类型的坏输入被逐条独立处理（坏的那条回退，其余照常可用）', () => {
  const settings = normalizeSettings({
    regionTypes: [
      { id: 'realm', params: { color: 'not-a-color' } },
      { id: 'custom:march', label: '边境', params: { color: '#123456' } },
      { id: 'bad id', label: '无效' },
    ],
  })
  assert.equal(settings.regionTypes[0]!.params.color, REGION_PRESETS[0]!.color)
  const custom = settings.regionTypes.filter((entry) => entry.id.startsWith('custom:'))
  assert.equal(custom.length, 1)
  assert.equal(custom[0]!.params.color, '#123456')
})
