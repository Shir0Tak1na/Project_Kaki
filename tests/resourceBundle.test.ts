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
  mergeTerrains,
  parseResourceBundle,
  serializeResourceBundle,
} from '../src/render/resourceBundle.ts'
import { MAX_CUSTOM_TERRAINS, type CustomTerrain } from '../src/render/terrainCatalog.ts'

const SAMPLE: CustomTerrain[] = [
  { id: 'custom:marsh', label: '沼泽地', color: '#336655', glyph: 'swamp', imagePath: '', mode: 'color', imageLayout: 'cell' },
  { id: 'custom:reef', label: '暗礁', color: '#2f6f8f', glyph: '', imagePath: 'Assets/reef.png', mode: 'image', imageLayout: 'region' },
]

test('导出 → 序列化 → 解析：内容往返一致', () => {
  const bundle = buildResourceBundle(SAMPLE, { generator: 'test', now: new Date('2026-09-24T00:00:00Z') })
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
  const text = serializeResourceBundle(buildResourceBundle(SAMPLE, { now: new Date('2026-09-24T00:00:00Z') }))
  assert.equal(text.endsWith('\n'), true)
  const first = text.indexOf('"id"')
  const label = text.indexOf('"label"')
  const color = text.indexOf('"color"')
  const glyph = text.indexOf('"glyph"')
  const image = text.indexOf('"imagePath"')
  assert.ok(first < label && label < color && color < glyph && glyph < image, '字段顺序必须固定')
  // 同样的输入必须产出同样的文本（否则每次导出都产生假 diff）
  const again = serializeResourceBundle(buildResourceBundle(SAMPLE, { now: new Date('2026-09-24T00:00:00Z') }))
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
  assert.equal(name, 'project-kaki-terrains-20260924-0705.json')
  assert.match(name, /^[\x20-\x7e]+$/, '不要出现中文/空格等容易出问题的字符')
})

test('空定义集也能导出（用于分享"我什么都没自定义"或作为模板）', () => {
  const text = serializeResourceBundle(buildResourceBundle([], { now: new Date('2026-09-24T00:00:00Z') }))
  const parsed = parseResourceBundle(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  if (parsed.ok) assert.deepEqual(parsed.bundle.terrains, [])
})
