/**
 * 区域类型目录的单测（⑤-2）。
 *
 * 这个模块是"设置 → 渲染"之间唯一的翻译层，而它处理的每一种输入都是
 * "写错了不报错、只会静默变形"的那种：颜色非法时 canvas 静默忽略、不透明度超界看不见、
 * 边框宽 0 与缺字段不是一回事、虚线段数为奇数会让边框看起来像噪点。
 * 因此这里把**每一条回退与每一条拒绝**都钉死，并且钉住两条与数据保全有关的性质：
 * 1. 收敛是**幂等**的；
 * 2. 用户没改过任何东西时，迁移结果**逐字段等于出厂**（= 升级前后视觉一致）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BUILTIN_REGION_TYPES } from '../src/data/mapDocument.ts'
import { REGION_PRESETS, DEFAULT_REGION_OPACITY, DEFAULT_REGION_BORDER_WIDTH } from '../src/render/shapeStyle.ts'
import {
  CUSTOM_REGION_TYPE_PREFIX,
  DEFAULT_CUSTOM_REGION_COLOR,
  FALLBACK_REGION_TYPE_PARAMS,
  MAX_CUSTOM_REGION_TYPES,
  applyRegionTypePatch,
  customRegionTypeEntries,
  customRegionTypeParams,
  defaultRegionTypeEntries,
  defaultRegionTypeId,
  describeRegionTypeParams,
  factoryRegionTypeParams,
  findRegionTypeEntry,
  isBuiltinRegionType,
  isDefaultRegionTypeStyles,
  normalizeRegionBorderColor,
  normalizeRegionBorderWidth,
  normalizeRegionOpacity,
  normalizeRegionTypeEntries,
  normalizeRegionTypeId,
  normalizeRegionTypeLabel,
  normalizeRegionTypeParams,
  regionColorsFromEntries,
  regionLabelForColor,
  regionTypeCatalogSignature,
  regionTypeIdProblem,
  resetRegionTypeStyles,
  resolveRegionType,
  resolvedRegionStyle,
  type RegionTypePatch,
} from '../src/render/regionTypeCatalog.ts'

describe('区域类型：内置 6 种', () => {
  it('内置 id 表与预设色一一对应（长度对得上，且顺序一致）', () => {
    assert.equal(BUILTIN_REGION_TYPES.length, REGION_PRESETS.length)
    const entries = defaultRegionTypeEntries()
    assert.deepEqual(
      entries.map((entry) => entry.id),
      [...BUILTIN_REGION_TYPES],
    )
    assert.deepEqual(
      entries.map((entry) => entry.label),
      REGION_PRESETS.map((preset) => preset.label),
    )
    assert.deepEqual(
      entries.map((entry) => entry.params.color),
      REGION_PRESETS.map((preset) => preset.color),
    )
  })

  it('出厂参数 = 升级前的行为（不透明度 0.22、边框宽 3、边框色跟随填充色、实线）', () => {
    for (const id of BUILTIN_REGION_TYPES) {
      const params = factoryRegionTypeParams(id)
      assert.equal(params.opacity, DEFAULT_REGION_OPACITY)
      assert.equal(params.borderWidth, DEFAULT_REGION_BORDER_WIDTH)
      assert.equal(params.borderColor, null)
      assert.deepEqual(params.borderDash, [])
    }
    assert.equal(DEFAULT_REGION_OPACITY, 0.22)
    assert.equal(DEFAULT_REGION_BORDER_WIDTH, 3)
  })

  it('默认区域类型是第一个内置类型（= 升级前工具条第一个色块「王国」）', () => {
    assert.equal(defaultRegionTypeId(), 'realm')
    assert.equal(isBuiltinRegionType(defaultRegionTypeId()), true)
  })

  it('isBuiltinRegionType 只认内置 id，不认自定义前缀', () => {
    assert.equal(isBuiltinRegionType('realm'), true)
    assert.equal(isBuiltinRegionType('custom:realm'), false)
    assert.equal(isBuiltinRegionType('realm '), false)
    assert.equal(isBuiltinRegionType(null), false)
  })
})

describe('区域类型：ID 规则', () => {
  it('用户输入统一小写并自动补 custom: 前缀', () => {
    assert.equal(normalizeRegionTypeId('March'), 'custom:march')
    assert.equal(normalizeRegionTypeId('  custom:march  '), 'custom:march')
    assert.equal(normalizeRegionTypeId('custom:custom:free-city'), 'custom:free-city')
  })

  it('非法 ID 一律拒绝（并给出可读原因）', () => {
    for (const bad of ['', '  ', '1march', 'm', 'a'.repeat(33), 'free city', 'free.city', null, 42]) {
      assert.equal(normalizeRegionTypeId(bad), null, `应拒绝：${String(bad)}`)
      assert.notEqual(regionTypeIdProblem(bad), null, `应给出原因：${String(bad)}`)
    }
    assert.equal(regionTypeIdProblem('march'), null)
  })

  it('哪怕用户写的是内置名，也会进用户命名空间（结构上不可能冲突）', () => {
    assert.equal(normalizeRegionTypeId('realm'), `${CUSTOM_REGION_TYPE_PREFIX}realm`)
  })

  it('显示名：去空白、限长、留空时退化为 ID 主体', () => {
    assert.equal(normalizeRegionTypeLabel('  边 境  侯国 ', 'custom:march'), '边 境 侯国')
    assert.equal(normalizeRegionTypeLabel('', 'custom:march'), 'march')
    assert.equal(normalizeRegionTypeLabel(undefined, 'custom:march'), 'march')
    assert.equal(normalizeRegionTypeLabel('x'.repeat(40), 'custom:march').length, 24)
  })
})

describe('区域类型：参数收敛', () => {
  const fallback = factoryRegionTypeParams('realm')

  it('不透明度：夹到 0–1，非法值回退（不做隐式推断）', () => {
    assert.equal(normalizeRegionOpacity(0.5, 0.22), 0.5)
    assert.equal(normalizeRegionOpacity(-1, 0.22), 0)
    assert.equal(normalizeRegionOpacity(9, 0.22), 1)
    assert.equal(normalizeRegionOpacity('0.5', 0.22), 0.5)
    assert.equal(normalizeRegionOpacity(Number.NaN, 0.22), 0.22)
    assert.equal(normalizeRegionOpacity(null, 0.22), 0.22)
    // 设置页的文本框给的是字符串：不认字符串的话，用户填的 0.6 会被静默换成 0.22
    assert.equal(normalizeRegionOpacity('0.6', 0.22), 0.6)
    assert.equal(normalizeRegionOpacity('', 0.22), 0.22)
    assert.equal(normalizeRegionOpacity('abc', 0.22), 0.22)
  })

  it('边框宽：0 是合法值（不画边框），不能被静默抬成 1', () => {
    assert.equal(normalizeRegionBorderWidth(0, 3), 0)
    assert.equal(normalizeRegionBorderWidth('0', 3), 0)
    assert.equal(normalizeRegionBorderWidth(-5, 3), 0)
    assert.equal(normalizeRegionBorderWidth(999, 3), 40)
    assert.equal(normalizeRegionBorderWidth('abc', 3), 3)
    assert.equal(normalizeRegionBorderWidth(undefined, 3), 3)
  })

  it('边框色：空 / null = 跟随填充色，非法颜色回退', () => {
    assert.equal(normalizeRegionBorderColor('', '#fff'), null)
    assert.equal(normalizeRegionBorderColor(null, '#fff'), null)
    assert.equal(normalizeRegionBorderColor('   ', '#fff'), null)
    assert.equal(normalizeRegionBorderColor('#123456', null), '#123456')
    assert.equal(normalizeRegionBorderColor('var(--x)', '#123456'), '#123456')
    assert.equal(normalizeRegionBorderColor(42, null), null)
  })

  it('缺失字段回退到回退值（虚线缺失不等于实线）', () => {
    const dashed = { ...fallback, borderDash: [10, 5] }
    assert.deepEqual(normalizeRegionTypeParams(undefined, dashed).borderDash, [10, 5])
    assert.deepEqual(normalizeRegionTypeParams({}, dashed).borderDash, [10, 5])
    // 显式写空数组才是实线
    assert.deepEqual(normalizeRegionTypeParams({ borderDash: [] }, dashed).borderDash, [])
  })

  it('坏掉的参数整体回退，而不是抛异常', () => {
    const params = normalizeRegionTypeParams({ color: 'nope', opacity: 'x', borderWidth: [], borderDash: 'x' }, fallback)
    assert.deepEqual(params, fallback)
  })
})

describe('区域类型：目录收敛与迁移', () => {
  it('内置 6 种永远存在，且顺序固定（顺序 = 工具条与图例的顺序）', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'custom:zzz', label: 'Z' }])
    assert.deepEqual(
      entries.slice(0, BUILTIN_REGION_TYPES.length).map((entry) => entry.id),
      [...BUILTIN_REGION_TYPES],
    )
    assert.equal(entries[entries.length - 1]!.id, 'custom:zzz')
  })

  it('用户没改过（没有旧字段）时，迁移结果逐字段等于出厂', () => {
    assert.deepEqual(normalizeRegionTypeEntries(undefined), defaultRegionTypeEntries())
    assert.deepEqual(normalizeRegionTypeEntries(undefined, {}), defaultRegionTypeEntries())
    assert.deepEqual(normalizeRegionTypeEntries(undefined, { regionColors: 'garbage' }), defaultRegionTypeEntries())
  })

  it('旧字段 regionColors 按下标迁进目录（颜色不是空转）', () => {
    const legacy = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666']
    const entries = normalizeRegionTypeEntries(undefined, { regionColors: legacy })
    assert.deepEqual(
      entries.map((entry) => entry.params.color),
      legacy,
    )
    // 除颜色外的参数仍然是出厂值（迁移不该改别的字段）
    assert.equal(entries[0]!.params.opacity, DEFAULT_REGION_OPACITY)
    assert.equal(entries[0]!.params.borderWidth, DEFAULT_REGION_BORDER_WIDTH)
  })

  it('旧字段里的非法颜色被挡在绘制层之外（canvas 会静默忽略非法色）', () => {
    const entries = normalizeRegionTypeEntries(undefined, { regionColors: ['var(--x)', '#222222'] })
    assert.equal(entries[0]!.params.color, REGION_PRESETS[0]!.color)
    assert.equal(entries[1]!.params.color, '#222222')
  })

  it('显式写在目录里的参数优先于旧字段', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'realm', params: { color: '#abcdef' } }], {
      regionColors: ['#111111'],
    })
    assert.equal(findRegionTypeEntry('realm', entries)?.params.color, '#abcdef')
  })

  it('幂等：收敛结果再收敛一次完全相同', () => {
    const sources = [
      undefined,
      [{ id: 'custom:march', label: '边境侯国', color: '#123456' }],
      [{ id: 'realm', params: { opacity: 0.5, borderDash: [4, 2] } }, { id: 'custom:a' }, { id: 'custom:a' }],
      [{ id: 'bad id' }, { id: null }],
      'garbage',
    ]
    for (const source of sources) {
      const once = normalizeRegionTypeEntries(source, { regionColors: ['#111111'] })
      const twice = normalizeRegionTypeEntries(once, { regionColors: ['#111111'] })
      assert.deepEqual(twice, once)
    }
  })

  it('自定义类型按 ID 去重（先出现的胜出）并截断到上限', () => {
    const raw = []
    for (let i = 0; i < MAX_CUSTOM_REGION_TYPES + 5; i += 1) raw.push({ id: `custom:t${i}`, label: `类型${i}` })
    const entries = normalizeRegionTypeEntries(raw)
    assert.equal(customRegionTypeEntries(entries).length, MAX_CUSTOM_REGION_TYPES)
    const dup = normalizeRegionTypeEntries([{ id: 'custom:aa', label: '第一个' }, { id: 'custom:aa', label: '第二个' }])
    assert.equal(customRegionTypeEntries(dup).length, 1)
    assert.equal(customRegionTypeEntries(dup)[0]!.label, '第一个')
  })

  it('内置显示名不可改（改画法可以，改名字会与图例/文档对不上）', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'realm', label: '我自己起的名字' }])
    assert.equal(findRegionTypeEntry('realm', entries)?.label, REGION_PRESETS[0]!.label)
  })

  it('自定义类型缺 label 时用 ID 主体', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'custom:march' }])
    assert.equal(customRegionTypeEntries(entries)[0]!.label, 'march')
  })
})

describe('区域类型：三级回退', () => {
  it('内置类型即使目录里没有也能解析出出厂参数', () => {
    const resolved = resolveRegionType('empire', [])
    assert.equal(resolved.builtin, true)
    assert.equal(resolved.unknown, false)
    assert.deepEqual(resolved.params, factoryRegionTypeParams('empire'))
  })

  it('目录里的参数优先于出厂值', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'empire', params: { color: '#ff0000', opacity: 0.5 } }])
    const resolved = resolveRegionType('empire', entries)
    assert.equal(resolved.params.color, '#ff0000')
    assert.equal(resolved.params.opacity, 0.5)
  })

  it('自定义类型被解析出来（不是内置，也不是未知）', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'custom:march', label: '边境侯国' }])
    const resolved = resolveRegionType('custom:march', entries)
    assert.equal(resolved.label, '边境侯国')
    assert.equal(resolved.builtin, false)
    assert.equal(resolved.unknown, false)
  })

  it('未知类型：永不返回空，标签是「未知（ID）」、参数是看得见的回退', () => {
    const resolved = resolveRegionType('alien-zone', [])
    assert.equal(resolved.unknown, true)
    assert.equal(resolved.label, '未知（alien-zone）')
    assert.deepEqual(resolved.params, FALLBACK_REGION_TYPE_PARAMS)
    assert.ok(resolved.params.opacity > 0, '回退样式必须看得见')
  })

  it('resolvedRegionStyle 把「边框色跟随填充色」解析成同一个颜色（升级前的行为）', () => {
    const style = resolvedRegionStyle('realm', [])
    assert.equal(style.borderColor, style.color)
    assert.equal(style.opacity, DEFAULT_REGION_OPACITY)
    assert.equal(style.borderWidth, DEFAULT_REGION_BORDER_WIDTH)
    assert.deepEqual(style.borderDash, [])
    const custom = resolvedRegionStyle('realm', normalizeRegionTypeEntries([{ id: 'realm', params: { borderColor: '#000000' } }]))
    assert.equal(custom.borderColor, '#000000')
  })
})

describe('区域类型：旧区域的显示名（图例标签不能变）', () => {
  it('能对上当前颜色的内置类型就报它的名字', () => {
    const entries = defaultRegionTypeEntries()
    assert.equal(regionLabelForColor('#44cf6e', entries), '王国')
    assert.equal(regionLabelForColor('#4a9fd8', entries), '海域')
  })

  it('用户改过颜色之后，仍按**当前**颜色反查（与升级前的语义一致）', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'realm', params: { color: '#123456' } }])
    assert.equal(regionLabelForColor('#123456', entries), '王国')
    // 旧颜色不再对应任何类型 → 通用名（升级前也是这个结果）
    assert.equal(regionLabelForColor('#44cf6e', entries), '区域')
  })

  it('颜色大小写不敏感，认不出来时给通用名「区域」', () => {
    assert.equal(regionLabelForColor('#44CF6E', defaultRegionTypeEntries()), '王国')
    assert.equal(regionLabelForColor('#ffffff', defaultRegionTypeEntries()), '区域')
  })

  it('目录为空时退回出厂颜色（没有设置上下文时的合理替身）', () => {
    assert.equal(regionLabelForColor('#44cf6e', []), '王国')
    assert.equal(regionLabelForColor('#ffffff', []), '区域')
  })
})

describe('区域类型：编辑与恢复', () => {
  it('补丁可以改参数，但改不了 ID', () => {
    const entry = findRegionTypeEntry('realm', defaultRegionTypeEntries())!
    // `RegionTypePatch` 里**没有** `id` 字段：改 ID 等于把地图文件里已有的区域指向另一个类型，
    // 那不是编辑而是数据迁移 —— 类型系统先挡一道，这里再用运行期断言钉死"带了也不采纳"。
    const patch = { color: '#010203', opacity: 0.9, borderWidth: 5, id: 'custom:hacked' } as unknown as RegionTypePatch
    const result = applyRegionTypePatch(entry, patch)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.entry.id, 'realm')
    assert.equal(result.entry.params.color, '#010203')
    assert.equal(result.entry.params.opacity, 0.9)
    assert.equal(result.entry.params.borderWidth, 5)
  })

  it('非法的边框虚线整条拒绝，并给出可读原因', () => {
    const entry = findRegionTypeEntry('realm', defaultRegionTypeEntries())!
    const result = applyRegionTypePatch(entry, { borderDash: [1] })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.problem, /偶数/)
  })

  it('内置类型的显示名不会被补丁改掉', () => {
    const entry = findRegionTypeEntry('realm', defaultRegionTypeEntries())!
    const result = applyRegionTypePatch(entry, { label: '新名字' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.entry.label, REGION_PRESETS[0]!.label)
  })

  it('恢复出厂只动内置类型的参数，自定义定义原样留着', () => {
    const entries = normalizeRegionTypeEntries([
      { id: 'realm', params: { color: '#000000', opacity: 0.9 } },
      { id: 'custom:march', label: '边境侯国', params: { color: '#abcdef' } },
    ])
    assert.equal(isDefaultRegionTypeStyles(entries), false)
    const reset = resetRegionTypeStyles(entries)
    assert.equal(isDefaultRegionTypeStyles(reset), true)
    assert.equal(customRegionTypeEntries(reset).length, 1)
    assert.equal(customRegionTypeEntries(reset)[0]!.params.color, '#abcdef')
  })

  it('旧字段镜像：长度固定 = 内置类型数，顺序与内置一致', () => {
    const entries = normalizeRegionTypeEntries([{ id: 'sea', params: { color: '#010203' } }])
    const mirror = regionColorsFromEntries(entries)
    assert.equal(mirror.length, BUILTIN_REGION_TYPES.length)
    assert.equal(mirror[BUILTIN_REGION_TYPES.indexOf('sea')], '#010203')
    assert.equal(mirror[0], REGION_PRESETS[0]!.color)
  })

  it('签名只含"选项有哪些、叫什么"（改颜色不该触发 DOM 重建）', () => {
    const a = defaultRegionTypeEntries()
    const b = normalizeRegionTypeEntries([{ id: 'realm', params: { color: '#ff0000' } }])
    assert.equal(regionTypeCatalogSignature(a), regionTypeCatalogSignature(b))
    const c = normalizeRegionTypeEntries([{ id: 'custom:march', label: '边境侯国' }])
    assert.notEqual(regionTypeCatalogSignature(a), regionTypeCatalogSignature(c))
  })

  it('参数描述说清了不透明度、边框与虚实（工具条提示用）', () => {
    const text = describeRegionTypeParams(customRegionTypeParams())
    assert.match(text, /不透明度/)
    assert.match(text, /边框/)
    assert.match(text, /实线/)
    const noBorder = describeRegionTypeParams({ ...customRegionTypeParams(), borderWidth: 0 })
    assert.match(noBorder, /无边框/)
  })

  it('自定义类型的出厂色是中性色（不与内置 6 色相撞）', () => {
    assert.equal(customRegionTypeParams().color, DEFAULT_CUSTOM_REGION_COLOR)
    assert.equal(
      REGION_PRESETS.some((preset) => preset.color.toLowerCase() === DEFAULT_CUSTOM_REGION_COLOR),
      false,
    )
  })
})
