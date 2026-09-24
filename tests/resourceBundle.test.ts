/**
 * 定义文件（导入/导出）的单元测试。
 *
 * 这一层的测试重点不是"能不能跑通"，而是三件会造成**不可逆损失或误导**的事：
 * 1. 坏文件必须给出**可读原因**（"导入失败"四个字让用户无从下手）；
 * 2. 来自更新版本的文件必须**明确拒绝**，而不是"尽力解析"后静默丢字段（那等于骗用户说成功了）；
 * 3. 合并时**同 ID 保留用户现有定义**（导入是补充，不是替换；不能悄悄改掉用户调好的东西）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  RESOURCE_BUNDLE_VERSION,
  buildResourceBundle,
  bundleFileName,
  describeImportPlan,
  describeImportResult,
  mergeMarkers,
  mergePathTypes,
  mergeRegionTypes,
  mergeTerrains,
  parseResourceBundle,
  planBundleImport,
  serializeResourceBundle,
} from '../src/render/resourceBundle.ts'
import { MAX_CUSTOM_TERRAINS, type CustomTerrain } from '../src/render/terrainCatalog.ts'
import type { CustomMarker } from '../src/render/markerCatalog.ts'
import { defaultRegionTypeEntries, type RegionTypeEntry } from '../src/render/regionTypeCatalog.ts'
import type { PathTypeEntry } from '../src/render/pathTypeCatalog.ts'

const SAMPLE: CustomTerrain[] = [
  { id: 'custom:marsh', label: '沼泽地', color: '#336655', glyph: 'swamp', imagePath: '', mode: 'color', imageLayout: 'cell' },
  { id: 'custom:reef', label: '暗礁', color: '#2f6f8f', glyph: '', imagePath: 'Assets/reef.png', mode: 'image', imageLayout: 'region' },
]

test('导出 → 序列化 → 解析：内容往返一致', () => {
  const bundle = buildResourceBundle({ terrains: SAMPLE }, { generator: 'test', now: new Date('2026-09-24T00:00:00Z') })
  assert.equal(bundle.version, RESOURCE_BUNDLE_VERSION)
  const text = serializeResourceBundle(bundle)
  const parsed = parseResourceBundle(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.terrains, SAMPLE)
  assert.equal(parsed.skipped.length, 0)
  assert.equal(parsed.bundle.generator, 'test')
  // 「显示方式」必须一起带走：否则"整片一张"配好的地形导入到别处会退回单格铺图，
  // 看起来像导入失败（这条断言就是钉住这件事）
  assert.equal(parsed.bundle.terrains[1]!.imageLayout, 'region')
})

test('旧格式（没有 imageLayout）导入时推断为 cell，不会突然变成整片铺图', () => {
  const legacy = JSON.stringify({
    version: 1,
    terrains: [{ id: 'custom:old', label: '旧地形', color: '#336655', imagePath: 'Assets/a.png', mode: 'image' }],
  })
  const parsed = parseResourceBundle(legacy)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.equal(parsed.bundle.terrains[0]!.imageLayout, 'cell')
})

test('序列化是稳定的：键顺序固定、末尾有换行（导出的文件要能被 diff）', () => {
  const text = serializeResourceBundle(buildResourceBundle({ terrains: SAMPLE }, { now: new Date('2026-09-24T00:00:00Z') }))
  assert.equal(text.endsWith('\n'), true)
  const first = text.indexOf('"id"')
  const label = text.indexOf('"label"')
  const color = text.indexOf('"color"')
  const glyph = text.indexOf('"glyph"')
  const image = text.indexOf('"imagePath"')
  assert.ok(first < label && label < color && color < glyph && glyph < image, '字段顺序必须固定')
  // 同样的输入必须产出同样的文本（否则每次导出都产生假 diff）
  const again = serializeResourceBundle(buildResourceBundle({ terrains: SAMPLE }, { now: new Date('2026-09-24T00:00:00Z') }))
  assert.equal(again, text)
})

test('坏文件给出可读原因，而不是"导入失败"四个字', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /空/],
    ['   ', /空/],
    ['不是 JSON', /JSON/],
    ['[1,2,3]', /对象/],
    ['{"terrains":[]}', /version/],
    ['{"version":0,"terrains":[]}', /version/],
    ['{"version":"1","terrains":[]}', /version/],
    ['{"version":1,"terrains":{}}', /数组/],
  ]
  for (const [text, pattern] of cases) {
    const result = parseResourceBundle(text)
    assert.equal(result.ok, false, text)
    if (result.ok) continue
    assert.match(result.reason, pattern, `${text} → ${result.reason}`)
    assert.ok(result.reason.length > 6, '原因要能看懂，不能是空话')
  }
})

test('来自更新版本的文件被明确拒绝（不"尽力解析"后静默丢字段）', () => {
  const result = parseResourceBundle(`{"version":${RESOURCE_BUNDLE_VERSION + 1},"terrains":[]}`)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /更新|升级/)
  assert.ok(result.reason.includes(String(RESOURCE_BUNDLE_VERSION + 1)), result.reason)
})

test('逐条独立校验：坏条目只丢它自己，其余照常导入并给出原因', () => {
  const text = JSON.stringify({
    version: 1,
    terrains: [
      { id: 'custom:good', label: '好的', color: '#123456', glyph: 'forest', imagePath: '' },
      { id: 'Swamp', label: '大小写会被归一化', color: '#336655' },
      { id: '1bad', label: '非法 ID' },
      { id: 'custom:img', label: '坏图片路径', color: '#111111', imagePath: '../../etc/passwd' },
      null,
    ],
  })
  const result = parseResourceBundle(text)
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return
  assert.deepEqual(
    result.bundle.terrains.map((terrain) => terrain.id),
    ['custom:good', 'custom:swamp'],
    JSON.stringify(result.bundle.terrains),
  )
  assert.equal(result.skipped.length, 3, JSON.stringify(result.skipped))
  assert.ok(result.skipped.every((item) => item.reason.length > 0), '每条跳过都要有原因')
  // 原因里要能看出是哪个条目的问题
  assert.ok(result.skipped.some((item) => item.id === '1bad'), JSON.stringify(result.skipped))
})

test('文件内重复 ID 只保留先出现的（并给出原因）', () => {
  const text = JSON.stringify({
    version: 1,
    terrains: [
      { id: 'custom:dup', label: '先', color: '#111111' },
      { id: 'custom:dup', label: '后', color: '#222222' },
    ],
  })
  const result = parseResourceBundle(text)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.bundle.terrains.length, 1)
  assert.equal(result.bundle.terrains[0]!.label, '先')
  assert.match(result.skipped[0]!.reason, /重复/)
})

test('全部条目都不可用时：报告第一条的原因（而不是返回一个空结果让用户困惑）', () => {
  const text = JSON.stringify({ version: 1, terrains: [{ id: '!!!' }, { id: 'also bad' }] })
  const result = parseResourceBundle(text)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /没有一条可用/)
})

test('合并：同 ID 保留用户现有的定义（导入是补充，不是替换）', () => {
  const existing: CustomTerrain[] = [
    { id: 'custom:marsh', label: '我的沼泽', color: '#000000', glyph: '', imagePath: 'Assets/mine.png', mode: 'image', imageLayout: 'cell' },
  ]
  const incoming: CustomTerrain[] = [
    { id: 'custom:marsh', label: '别人的沼泽', color: '#ffffff', glyph: 'swamp', imagePath: '', mode: 'color', imageLayout: 'cell' },
    { id: 'custom:reef', label: '暗礁', color: '#2f6f8f', glyph: '', imagePath: '', mode: 'color', imageLayout: 'cell' },
  ]
  const merged = mergeTerrains(existing, incoming)
  assert.deepEqual(merged.added, ['custom:reef'])
  assert.equal(merged.terrains.length, 2)
  const marsh = merged.terrains.find((terrain) => terrain.id === 'custom:marsh')!
  assert.equal(marsh.label, '我的沼泽', '用户现有的定义不能被覆盖')
  assert.equal(marsh.imagePath, 'Assets/mine.png')
  assert.equal(marsh.mode, 'image', '模式也是用户现有定义的一部分，不能被外来文件改掉')
  assert.match(merged.skipped[0]!.reason, /保留现有的/)
})

test('合并：respect 上限，超出的条目被跳过并说明原因', () => {
  const existing: CustomTerrain[] = Array.from({ length: MAX_CUSTOM_TERRAINS - 1 }, (_value, index) => ({
    id: `custom:e${index}`,
    label: `现有 ${index}`,
    color: '#123456',
    glyph: '',
    imagePath: '',
    mode: 'color' as const,
    imageLayout: 'cell' as const,
  }))
  const incoming: CustomTerrain[] = [
    { id: 'custom:new1', label: '新一', color: '#123456', glyph: '', imagePath: '', mode: 'color', imageLayout: 'cell' },
    { id: 'custom:new2', label: '新二', color: '#123456', glyph: '', imagePath: '', mode: 'color', imageLayout: 'cell' },
  ]
  const merged = mergeTerrains(existing, incoming)
  assert.equal(merged.terrains.length, MAX_CUSTOM_TERRAINS)
  assert.deepEqual(merged.added, ['custom:new1'])
  assert.match(merged.skipped[0]!.reason, /上限/)
  // 解析侧也要有同样的上限保护
  const many = parseResourceBundle(
    JSON.stringify({ version: 1, terrains: incoming.map((terrain) => ({ ...terrain })) }),
    { maxTerrains: 1 },
  )
  assert.equal(many.ok, true)
  if (many.ok) assert.equal(many.bundle.terrains.length, 1)
})

test('文件名带日期且只用 ASCII（跨平台安全）', () => {
  const name = bundleFileName(new Date('2026-09-24T07:05:00'))
  // 名字里是 `definitions` 而不是当初的 `terrains`：文件里现在还有标记与路径类型，
  // 叫 terrains 会让用户以为"标记没被导出"（这是有意的改名）
  assert.equal(name, 'project-kaki-definitions-20260924-0705.json')
  assert.match(name, /^[\x20-\x7e]+$/, '不要出现中文/空格等容易出问题的字符')
})

test('空定义集也能导出（用于分享"我什么都没自定义"或作为模板）', () => {
  const text = serializeResourceBundle(buildResourceBundle({ terrains: [] }, { now: new Date('2026-09-24T00:00:00Z') }))
  const parsed = parseResourceBundle(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (parsed.ok) assert.deepEqual(parsed.bundle.terrains, [])
})

/* ------------------------------------------------ 标记与路径类型（v2 的新增段） */

const SAMPLE_MARKERS: CustomMarker[] = [
  { id: 'custom:lighthouse', label: '灯塔', icon: 'port', imagePath: 'Assets/lighthouse.png', mode: 'image' },
  { id: 'custom:camp', label: '营地', icon: 'temple', imagePath: '', mode: 'glyph' },
]

/** 一条自定义路径类型（参数走嵌套写法，与导出文件一致） */
const SAMPLE_PATH_TYPES: PathTypeEntry[] = [
  {
    id: 'custom:highway',
    label: '官道',
    kind: 'path',
    params: { color: '#c9a227', width: 9, dash: [16, 6], taper: false, smooth: true, cap: 'square', join: 'bevel' },
  },
]

/** 一条自定义区域类型：五个参数都要能往返（尤其 `borderColor: null` = 跟随填充色） */
const SAMPLE_REGION_TYPES: RegionTypeEntry[] = [
  {
    id: 'custom:march',
    label: '边疆',
    params: { color: '#3355aa', opacity: 0.35, borderColor: null, borderWidth: 5, borderDash: [10, 6] },
  },
  {
    id: 'custom:oasis',
    label: '绿洲',
    params: { color: '#33aa88', opacity: 0.4, borderColor: '#105040', borderWidth: 0, borderDash: [] },
  },
]

test('v2 三段一起往返：标记（含两套视觉）与路径类型参数都不能丢', () => {
  const bundle = buildResourceBundle(
    { terrains: SAMPLE, markers: SAMPLE_MARKERS, pathTypes: SAMPLE_PATH_TYPES },
    { now: new Date('2026-09-24T00:00:00Z') },
  )
  assert.equal(bundle.version, RESOURCE_BUNDLE_VERSION)
  const parsed = parseResourceBundle(serializeResourceBundle(bundle))
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.markers, SAMPLE_MARKERS)
  assert.deepEqual(parsed.bundle.pathTypes, SAMPLE_PATH_TYPES)
  // 段必须被记录下来：合并只看"文件里出现过哪几段"
  // （四段永远都写出来，所以即使这份 bundle 没带区域类型，regionTypes 段也在）
  assert.deepEqual(parsed.bundle.sections, ['terrains', 'markers', 'pathTypes', 'regionTypes'])
  // 标记的"另一套视觉"也要在文件里：只带当前模式那一套的话，
  // 导入方切一下模式就会发现配置是空的（用户以为切坏了）
  const lighthouse = parsed.bundle.markers.find((marker) => marker.id === 'custom:lighthouse')!
  assert.equal(lighthouse.mode, 'image')
  assert.equal(lighthouse.icon, 'port', '图片模式下也要带着字形')
  assert.equal(lighthouse.imagePath, 'Assets/lighthouse.png')
})

test('区域类型一起往返：五个参数一个都不能丢（含"边框跟随填充色"的 null）', () => {
  const bundle = buildResourceBundle(
    { terrains: [], regionTypes: SAMPLE_REGION_TYPES },
    { now: new Date('2026-09-24T00:00:00Z') },
  )
  const parsed = parseResourceBundle(serializeResourceBundle(bundle))
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.regionTypes, SAMPLE_REGION_TYPES)
  // `borderColor: null` 是有意义的值（边框跟随填充色），不是"没写这个字段"：
  // 丢掉它会让导入方拿到一个颜色被写死的边框，之后改填充色时边框不动
  const march = parsed.bundle.regionTypes.find((entry) => entry.id === 'custom:march')!
  assert.equal(march.params.borderColor, null)
  assert.deepEqual(march.params.borderDash, [10, 6])
  assert.equal(march.params.opacity, 0.35)
  assert.equal(march.params.borderWidth, 5)
})

test('内置 6 种区域类型不进文件（带进去只会得到一串"同 ID 已存在"）', () => {
  const withBuiltin = [...defaultRegionTypeEntries(), ...SAMPLE_REGION_TYPES]
  const bundle = buildResourceBundle({ terrains: [], regionTypes: withBuiltin })
  assert.deepEqual(bundle.regionTypes.map((entry) => entry.id), ['custom:march', 'custom:oasis'])
})

test('内置路径类型不进文件（带进去只会得到一串"同 ID 已存在"）', () => {
  const withBuiltin: PathTypeEntry[] = [
    {
      id: 'river',
      label: '河流',
      kind: 'path',
      params: { color: '#4f9dd9', width: 8, dash: [], taper: true, smooth: false, cap: 'round', join: 'round' },
    },
    ...SAMPLE_PATH_TYPES,
  ]
  const bundle = buildResourceBundle({ terrains: [], pathTypes: withBuiltin })
  assert.deepEqual(bundle.pathTypes.map((entry) => entry.id), ['custom:highway'])
})

test('v1 文件（只有 terrains）仍然能导入，且不动用户的标记与路径类型', () => {
  const legacy = JSON.stringify({
    version: 1,
    terrains: [{ id: 'custom:old', label: '旧地形', color: '#336655', glyph: '', imagePath: '', mode: 'color' }],
  })
  const parsed = parseResourceBundle(legacy)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.sections, ['terrains'], 'v1 文件没提标记与路径类型')
  assert.deepEqual(parsed.bundle.markers, [])
  assert.deepEqual(parsed.bundle.pathTypes, [])
  assert.deepEqual(parsed.bundle.regionTypes, [])

  const plan = planBundleImport(
    { terrains: [], markers: SAMPLE_MARKERS, pathTypes: SAMPLE_PATH_TYPES, regionTypes: SAMPLE_REGION_TYPES },
    parsed.bundle,
  )
  assert.deepEqual(plan.markers.added, [], 'v1 文件不许动用户的标记')
  assert.deepEqual(plan.pathTypes.added, [], 'v1 文件不许动用户的路径类型')
  assert.deepEqual(plan.regionTypes.added, [], 'v1 文件不许动用户的区域类型')
  assert.equal(plan.skippedCount, 0, '缺失的段连"跳过"都不该报（它根本没提这件事）')
  assert.equal(plan.addedCount, 1)
})

test('v2 文件里没有 regionTypes 段时，同样不许动用户的区域类型定义', () => {
  // 这条钉住的是**可观测的契约**：文件没提区域类型 → 计划里不算新增、正文明说缺了这一节。
  // 注意别把它当成"has() 守卫"的证明：今天把那个守卫改成恒真也照样绿（合并只增不删，
  // 空数组合并没有效果）。守卫本身的意义写在 planBundleImport 的注释里。
  const v2WithoutRegions = JSON.stringify({
    version: 2,
    terrains: [],
    markers: [],
    pathTypes: [],
  })
  const parsed = parseResourceBundle(v2WithoutRegions)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.sections, ['terrains', 'markers', 'pathTypes'], 'regionTypes 段确实没出现过')
  const plan = planBundleImport({ terrains: [], markers: [], pathTypes: [], regionTypes: SAMPLE_REGION_TYPES }, parsed.bundle)
  assert.equal(plan.addedCount, 0)
  assert.equal(plan.skippedCount, 0)
  assert.deepEqual(plan.regionTypes.added, [])
  // 计划里"缺少哪一段"必须说到区域类型，否则用户以为区域类型也导进来了
  assert.match(describeImportPlan(plan), /没有「区域类型」一节/)
})

test('某一段类型不对时给出可读原因（说清是哪一段）', () => {
  const result = parseResourceBundle('{"version":2,"terrains":[],"markers":{}}')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /markers/)
  assert.match(result.reason, /数组/)
})

test('一段都没有的文件被拒绝（不像是本插件的定义文件）', () => {
  const result = parseResourceBundle('{"version":2}')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /terrains|markers|pathTypes/)
})

test('幂等：刚导出的文件立刻再导入 = 0 新增，且设置逐字段不变', () => {
  const bundle = buildResourceBundle({
    terrains: SAMPLE,
    markers: SAMPLE_MARKERS,
    pathTypes: SAMPLE_PATH_TYPES,
    regionTypes: SAMPLE_REGION_TYPES,
  })
  const parsed = parseResourceBundle(serializeResourceBundle(bundle))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return

  const current = {
    terrains: [] as CustomTerrain[],
    markers: [] as CustomMarker[],
    pathTypes: [] as PathTypeEntry[],
    regionTypes: [] as RegionTypeEntry[],
  }
  const first = planBundleImport(current, parsed.bundle)
  assert.equal(first.addedCount, 7, JSON.stringify(first))
  // 按计划写入（与 main.ts 的落盘逻辑同构）
  const after = {
    terrains: [...current.terrains, ...first.terrains.added],
    markers: [...current.markers, ...first.markers.added],
    pathTypes: [...current.pathTypes, ...first.pathTypes.added],
    regionTypes: [...current.regionTypes, ...first.regionTypes.added],
  }
  assert.deepEqual(after.terrains, SAMPLE)
  assert.deepEqual(after.markers, SAMPLE_MARKERS)
  assert.deepEqual(after.pathTypes, SAMPLE_PATH_TYPES)
  assert.deepEqual(after.regionTypes, SAMPLE_REGION_TYPES)

  const second = planBundleImport(after, parsed.bundle)
  assert.equal(second.addedCount, 0, '第二次导入不许再新增')
  assert.equal(second.skippedCount, 7, '同 ID 冲突要逐条报出来')
  assert.ok(second.terrains.skipped.every((item) => /保留现有的/.test(item.reason)), JSON.stringify(second.terrains.skipped))
  assert.ok(
    second.regionTypes.skipped.every((item) => /保留现有的/.test(item.reason)),
    JSON.stringify(second.regionTypes.skipped),
  )
  const afterSecond = {
    terrains: [...after.terrains, ...second.terrains.added],
    markers: [...after.markers, ...second.markers.added],
    pathTypes: [...after.pathTypes, ...second.pathTypes.added],
    regionTypes: [...after.regionTypes, ...second.regionTypes.added],
  }
  assert.deepEqual(afterSecond, after, '第二次导入之后设置必须逐字段不变')
})

test('合并标记：同 ID 保留现有的（用户选好的图标与图片不能被覆盖）', () => {
  const existing: CustomMarker[] = [
    { id: 'custom:camp', label: '我的营地', icon: 'ruin', imagePath: 'Assets/mine.png', mode: 'image' },
  ]
  const merged = mergeMarkers(existing, SAMPLE_MARKERS)
  assert.deepEqual(merged.added, ['custom:lighthouse'])
  assert.equal(merged.markers.length, 2)
  const camp = merged.markers.find((marker) => marker.id === 'custom:camp')!
  assert.equal(camp.label, '我的营地')
  assert.equal(camp.icon, 'ruin', '字形也是用户现有定义的一部分')
  assert.equal(camp.imagePath, 'Assets/mine.png')
  assert.match(merged.skipped[0]!.reason, /保留现有的/)
})

test('合并路径类型：内置 ID 的冲突要单独解释，且上限只数自定义条目', () => {
  const existing: PathTypeEntry[] = [
    {
      id: 'river',
      label: '河流',
      kind: 'path',
      params: { color: '#4f9dd9', width: 8, dash: [], taper: true, smooth: false, cap: 'round', join: 'round' },
    },
  ]
  const incoming: PathTypeEntry[] = [
    { ...existing[0]!, params: { ...existing[0]!.params, color: '#ff0000' } },
    ...SAMPLE_PATH_TYPES,
  ]
  const merged = mergePathTypes(existing, incoming)
  assert.deepEqual(merged.added, ['custom:highway'])
  assert.match(merged.skipped[0]!.reason, /内置类型/)
  assert.equal(merged.pathTypes.find((entry) => entry.id === 'river')!.params.color, '#4f9dd9', '内置参数不许被替换')
  // 上限按"自定义条目数"算：内置 4 种不占用户的名额
  const many = mergePathTypes(existing, SAMPLE_PATH_TYPES, { maxPathTypes: 0 })
  assert.equal(many.added.length, 0)
  assert.match(many.skipped[0]!.reason, /上限/)
})

test('路径类型里的非法虚线：整条跳过并给出原因（不许静默变成实线）', () => {
  const text = JSON.stringify({
    version: 2,
    pathTypes: [
      { id: 'custom:bad-dash', label: '坏虚线', params: { color: '#123456', width: 4, dash: [12, 8, 4] } },
      { id: 'custom:ok', label: '好虚线', params: { color: '#123456', width: 4, dash: [12, 8] } },
    ],
  })
  const parsed = parseResourceBundle(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.pathTypes.map((entry) => entry.id), ['custom:ok'])
  assert.equal(parsed.skipped.length, 1)
  assert.match(parsed.skipped[0]!.reason, /偶数/)
})

test('合并区域类型：内置 ID 的冲突要单独解释，且上限只数自定义条目', () => {
  const existing = [...defaultRegionTypeEntries(), SAMPLE_REGION_TYPES[0]!]
  const incoming: RegionTypeEntry[] = [
    // 内置 ID（手改文件时会出现）：必须明确说"内置的不能被替换"
    { id: 'realm', label: '冒名顶替', params: { color: '#ff0000', opacity: 0.9, borderColor: null, borderWidth: 9, borderDash: [] } },
    // 同 ID 的自定义条目：保留用户现有的
    { ...SAMPLE_REGION_TYPES[0]!, label: '别人的边疆', params: { ...SAMPLE_REGION_TYPES[0]!.params, color: '#ff00ff' } },
    SAMPLE_REGION_TYPES[1]!,
  ]
  const merged = mergeRegionTypes(existing, incoming)
  assert.deepEqual(merged.added, ['custom:oasis'])
  assert.match(merged.skipped[0]!.reason, /内置类型/)
  assert.match(merged.skipped[1]!.reason, /保留现有的/)
  const realm = merged.regionTypes.find((entry) => entry.id === 'realm')!
  assert.notEqual(realm.params.color, '#ff0000', '内置参数不许被替换')
  const march = merged.regionTypes.find((entry) => entry.id === 'custom:march')!
  assert.equal(march.label, '边疆', '用户现有的定义不许被外来文件改掉')
  // 上限按"自定义条目数"算：内置 6 种不占用户的名额
  // （existing 里已经有一条自定义的 custom:march，所以上限 1 时 custom:oasis 会被挡住；
  //  第一条 custom:march 走的是"同 ID 冲突"，所以这里要 some 而不是看第一条）
  const many = mergeRegionTypes(existing, SAMPLE_REGION_TYPES, { maxRegionTypes: 1 })
  assert.equal(many.added.length, 0)
  assert.ok(
    many.skipped.some((item) => /上限/.test(item.reason)),
    JSON.stringify(many.skipped),
  )
})

test('区域类型的非法边框虚线：整条跳过并给出原因（不许静默变成实线）', () => {
  const text = JSON.stringify({
    version: 2,
    regionTypes: [
      { id: 'custom:bad', label: '坏虚线', params: { color: '#123456', opacity: 0.3, borderWidth: 4, borderDash: [12, 8, 4] } },
      { id: 'custom:good', label: '好虚线', params: { color: '#123456', opacity: 0.3, borderWidth: 4, borderDash: [12, 8] } },
    ],
  })
  const parsed = parseResourceBundle(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.regionTypes.map((entry) => entry.id), ['custom:good'])
  assert.equal(parsed.skipped.length, 1)
  assert.match(parsed.skipped[0]!.reason, /偶数/)
})

test('计划正文说清三件事：新增几条、跳过哪些、哪一段文件里没有', () => {
  const parsed = parseResourceBundle(
    JSON.stringify({ version: 2, terrains: [], markers: SAMPLE_MARKERS }),
  )
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const plan = planBundleImport(
    { terrains: [], markers: [SAMPLE_MARKERS[1]!], pathTypes: [], regionTypes: [] },
    parsed.bundle,
  )
  const text = describeImportPlan(plan)
  assert.match(text, /将新增 1 条/)
  assert.match(text, /custom:lighthouse/)
  assert.match(text, /保留现有的/)
  // 文件里没有 pathTypes 与 regionTypes 两段：必须说出来，否则用户会以为它们也导进来了
  assert.match(text, /没有「路径类型、区域类型」一节/)
  assert.match(text, /不会删除任何东西/)
  assert.match(describeImportResult(plan), /跳过 1 条/)
})

test('没有可新增条目时正文要说清"为什么一条都进不来"', () => {
  const parsed = parseResourceBundle(JSON.stringify({ version: 2, markers: SAMPLE_MARKERS }))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const plan = planBundleImport(
    { terrains: [], markers: SAMPLE_MARKERS, pathTypes: [], regionTypes: [] },
    parsed.bundle,
  )
  assert.equal(plan.addedCount, 0)
  const text = describeImportPlan(plan)
  assert.match(text, /没有可新增的定义/)
  assert.match(text, /保留现有的/)
})

test('文件里的字形名本机不认识时：条目照样导入，但必须留下一条"回退说明"', () => {
  // 字形名是白名单（只认内置那几种），文件里写了别的名字时条目会被收下、字形被换成回退视觉。
  // 这件事不许悄悄发生 —— 否则用户导入别人的文件后只会觉得"我的图标怎么变了"。
  const parsed = parseResourceBundle(
    JSON.stringify({
      version: 2,
      markers: [{ id: 'custom:beacon', label: '信标', icon: 'some-future-icon', imagePath: '', mode: 'glyph' }],
      terrains: [{ id: 'custom:volcano', label: '火山', color: '#aa4411', glyph: 'lava', imagePath: '' }],
    }),
  )
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (!parsed.ok) return
  assert.deepEqual(parsed.bundle.markers.map((marker) => marker.id), ['custom:beacon'], '条目本身必须进来')
  assert.deepEqual(parsed.bundle.terrains.map((terrain) => terrain.id), ['custom:volcano'])
  assert.equal(parsed.skipped.length, 0, '这不是"跳过"，不该记进 skipped')
  assert.equal(parsed.notes.length, 2, JSON.stringify(parsed.notes))
  assert.ok(parsed.notes.every((note) => /不是内置/.test(note.reason)), JSON.stringify(parsed.notes))

  const plan = planBundleImport({ terrains: [], markers: [], pathTypes: [], regionTypes: [] }, parsed.bundle, {
    notes: parsed.notes,
  })
  assert.equal(plan.addedCount, 2)
  assert.equal(plan.skippedCount, 0)
  const text = describeImportPlan(plan)
  assert.match(text, /注意 2 处/)
  assert.match(text, /some-future-icon/)
  assert.match(describeImportResult(plan), /2 处回退/)
})
