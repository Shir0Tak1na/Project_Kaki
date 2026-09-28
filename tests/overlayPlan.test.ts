/**
 * 数据层的**绘制计划**（`overlayPlan.ts`）单测。
 *
 * 这一组断言盯四件事：
 * 1. **几何只有一份**：画布与导出消费的是同一批图元（工单 D 的结构性要求）；
 * 2. **统计可信**：画了几块 / 几格越界 / 几条等值线，都从同一份图元清单数出来
 *    （"叠加层没画出来"要能被断言抓到，而不是靠肉眼看截图）；
 * 3. **连续场是"一张栅格"而不是一堆方块** —— 用户实机报的"呈方格状分布"就是后者；
 * 4. **缓存键的脾气**：平移不该失效、改了值必须失效、改了显示参数也必须失效。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { MapDocument } from '../src/data/mapDocument.ts'
import { buildMapPreviewSvg, buildMapPreviewSvgWithReport, describeOverlayExport } from '../src/base/mapPreview.ts'
import { DEFAULT_LAYER_VISIBILITY, withLayerVisibility } from '../src/render/layerVisibility.ts'
import {
  DEFAULT_OVERLAY_STYLES,
  OVERLAY_FIELDS,
  overlayField,
  type OverlayStyle,
  type OverlayStyles,
} from '../src/render/overlayFields.ts'
import {
  buildOverlayPlan,
  cachedOverlayPlan,
  collectOverlaySamples,
  createOverlayFieldCache,
  overlayFieldCacheKey,
} from '../src/render/overlayPlan.ts'

function makeDocument(): MapDocument {
  return {
    version: 1,
    grid: { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] },
    terrain: {
      '0_0': { t: 'forest', temp: 15 },
      '1_0': { temp: -200 },
      '2_0': { t: 'water', temp: 60 },
      '3_0': { t: 'plains' },
    },
    paths: [],
    regions: [],
    markers: [],
    labels: [],
  }
}

const temperature = overlayField('temperature')
const CELL_STYLE = DEFAULT_OVERLAY_STYLES.temperature
const FIELD_STYLE: OverlayStyle = { ...CELL_STYLE, mode: 'field', contourInterval: 20 }

test('采集样本：只有有限数才算数据；坏键跳过；逐格模式才做视口剔除', () => {
  const document = makeDocument()
  document.terrain['9_9'] = { temp: Number.NaN }
  const all = collectOverlaySamples(document, temperature)
  assert.deepEqual(
    all.map((sample) => [sample.q, sample.value]),
    [[0, 15], [1, -200], [2, 60]],
    '没有温度的格、坏值都不进样本',
  )
  const culled = collectOverlaySamples(document, temperature, { minX: -10000, minY: -10000, maxX: -9000, maxY: -9000 })
  assert.equal(culled.length, 0, '视口外的格被剔除（与地形用同一个 `cellIntersectsBBox`）')
})

test('逐格模式：越界格总是写数值；导出侧关掉数值（labels: false）', () => {
  const document = makeDocument()
  const canvas = buildOverlayPlan({ document, spec: temperature, style: CELL_STYLE })
  assert.equal(canvas.stats.mode, 'cell')
  assert.equal(canvas.stats.drawn, 3, '三个格有温度')
  assert.equal(canvas.stats.outOfRange, 2, '-200 与 60 越界')
  assert.equal(canvas.stats.labels, 2, '越界那两格总是写数值')
  assert.equal(canvas.stats.contours, 0)

  const svg = buildOverlayPlan({ document, spec: temperature, style: CELL_STYLE, labels: false })
  assert.equal(svg.stats.labels, 0, '导出不写逐格数值（导出要能看清地形）')
  assert.equal(svg.stats.drawn, 3, '但色块一个都不少')
})

test('连续场模式：颜色面是**一张栅格**（不是一堆方块）+ 等值线 + 线上数值', () => {
  const document = makeDocument()
  const { plan, stats } = buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE })
  assert.equal(stats.mode, 'field')
  assert.equal(stats.contours > 0, true, '有等值线')
  assert.equal(stats.sampled > 0, true, '采样网格有规模')
  assert.equal(plan.field !== null, true)
  const rasters = plan.primitives.filter((primitive) => primitive.kind === 'raster')
  assert.equal(rasters.length, 1, '颜色面只有一张栅格 —— "每格一个方块"正是用户看到的方格状')
  assert.equal(stats.drawn, 1, '统计里的"色块数"在连续场下就是 1（一整张面）')
  assert.equal(stats.labels > 0, true, '等值线上要有数值标注')
  assert.equal(
    plan.primitives.some((primitive) => primitive.kind === 'polygon'),
    false,
    '连续场不该再产出逐格多边形',
  )
})

test('几何只有一份：导出的叠加层图元数与画布计划逐项一致', () => {
  const document = makeDocument()
  const layers = withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'temperature', true)
  for (const style of [CELL_STYLE, FIELD_STYLE]) {
    const { stats } = buildOverlayPlan({ document, spec: temperature, style, labels: false })
    const svg = buildMapPreviewSvg(document, [], {
      width: 400,
      height: 300,
      overlayStyles: { ...DEFAULT_OVERLAY_STYLES, temperature: style },
      layers,
    })
    const polygons = (svg.match(/data-fc-primitive="polygon"/g) ?? []).length
    const polylines = (svg.match(/data-fc-primitive="polyline"/g) ?? []).length
    const rasters = (svg.match(/data-fc-primitive="raster"/g) ?? []).length
    assert.equal(polygons + rasters, stats.drawn, `导出与画布的色块数必须一致（${style.mode}）`)
    assert.equal(polylines, stats.contours, `导出与画布的等值线数必须一致（${style.mode}）`)
  }

  // ⚠️ 这条是为了让"导出默认不写数值"那条断言**真的有鉴别力**：
  // 一旦渲染器把 text 图元静默丢掉，`labels: false` 就变成了唯一执法点之外的第二套口径，
  // 而"改成 labels: true 也不红"这种空转断言正是本项目最忌讳的（鉴别力实测时真抓到过一次）。
  const offByDefault = buildMapPreviewSvg(document, [], {
    width: 400,
    height: 300,
    overlayStyles: DEFAULT_OVERLAY_STYLES,
    layers,
  })
  assert.equal((offByDefault.match(/data-fc-primitive="text"/g) ?? []).length, 0, '导出默认不写逐格数值')
  const withLabels = buildMapPreviewSvg(document, [], {
    width: 400,
    height: 300,
    overlayStyles: DEFAULT_OVERLAY_STYLES,
    layers,
    overlayLabels: true,
  })
  const texts = (withLabels.match(/data-fc-primitive="text"/g) ?? []).length
  assert.equal(
    texts,
    buildOverlayPlan({ document, spec: temperature, style: CELL_STYLE }).stats.labels,
    '开了数值就必须真的画出来',
  )
  assert.equal(texts > 0, true, '前提：这份数据确实会产出数值文字')
})

test('等值线的数值标注也进导出（它不是"逐格数值"，不受 labels 开关管）', () => {
  const document = makeDocument()
  const layers = withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'temperature', true)
  const svg = buildMapPreviewSvg(document, [], {
    width: 400,
    height: 300,
    overlayStyles: { ...DEFAULT_OVERLAY_STYLES, temperature: FIELD_STYLE },
    layers,
  })
  const texts = (svg.match(/data-fc-primitive="text"/g) ?? []).length
  assert.equal(texts, buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE }).stats.labels)
  assert.equal(texts > 0, true, '导出里也要能看到等值线上的数字')
  assert.match(svg, /font-family="ui-monospace/, '用等宽字体（用户实机要求）')
  assert.match(svg, /dy="0\.35em"/, '按基线偏移居中，而不是 dominant-baseline（那个会偏上）')
  assert.match(svg, /paint-order="stroke"/, '数字有白边，压在彩色场上才看得见')
})

test('数据层的取数不看地形计划：只有值、没有地形的格也进图元', () => {
  const document = makeDocument()
  const { plan } = buildOverlayPlan({ document, spec: temperature, style: CELL_STYLE })
  const centers = plan.primitives.filter((primitive) => primitive.kind === 'polygon').length
  assert.equal(centers, 3)
  assert.equal(document.terrain['1_0']?.t, undefined, '前提：这一格真的没有地形')
})

test('每格默认值（§B）：真值优先、兜底格照画但不写数值、空白区不画', () => {
  const document = makeDocument()
  // '2_0' 有真值 60；'1_0' 有真值 -200；'0_0' 有真值 15；'3_0' 只有地形、没有温度
  document.dataDefaults = { temp: 12 }

  const samples = collectOverlaySamples(document, temperature)
  const byKey = new Map(samples.map((sample) => [`${sample.q}_${sample.r}`, sample]))
  assert.equal(byKey.get('3_0')?.value, 12, '没有温度的格用默认值兜底')
  assert.equal(byKey.get('3_0')?.fallback, true, '兜底样本要打标志（逐格模式下据此不写数值）')
  assert.equal(byKey.get('0_0')?.value, 15, '真值优先：有 15 就不用 12')
  assert.equal(byKey.get('0_0')?.fallback, undefined, '真值不是兜底')
  assert.equal(samples.length, 4, '文件里存在的 4 格都有值了（空白区本来就不在文件里）')

  // 逐格模式：兜底格照画色块，但**不写数值**（满屏 12 会让人以为"这格量过"）
  const cellPlan = buildOverlayPlan({ document, spec: temperature, style: CELL_STYLE, labels: true })
  assert.equal(cellPlan.stats.drawn, 4, '兜底格也画色块（"画过的地方整片都有颜色"）')
  // 这一档没开"每格写数值"，所以只有**越界**的两格写（-200 / 60 都在色带之外，越界恒写是老口径）
  assert.equal(cellPlan.stats.labels, 2, '越界的两格照旧写数值')
  const withValues: OverlayStyle = { ...CELL_STYLE, showValues: true }
  const labelled = buildOverlayPlan({ document, spec: temperature, style: withValues, labels: true })
  assert.equal(labelled.stats.labels, 3, '只有 3 格是真值 → 只写 3 个数值')
  const labelledTexts = labelled.plan.primitives.filter((primitive) => primitive.kind === 'text')
  assert.equal(
    labelledTexts.some((primitive) => primitive.kind === 'text' && primitive.text === '12'),
    false,
    '兜底值不许写成数值文字',
  )

  // 越界兜底也**不写字**：颜色能表达"超过上限"，但兜底数不是量出来的数据（§B.3）。
  // 这里用一张"只有地形、没有温度"的图，免得真值的越界格混进来把计数搅乱
  const terrainOnly = makeDocument()
  terrainOnly.terrain = { '0_0': { t: 'plains' } }
  terrainOnly.dataDefaults = { temp: 400 }
  const outOfRange = buildOverlayPlan({ document: terrainOnly, spec: temperature, style: CELL_STYLE, labels: true })
  assert.equal(outOfRange.stats.drawn, 1, '前提：这一格被兜底画出来了')
  assert.equal(outOfRange.stats.outOfRange, 1, '前提：400 ℃ 走得是 over 纯色')
  assert.equal(outOfRange.stats.labels, 0, '越界格照写数值的老口径**不适用于兜底格**')

  // 没有这一段（老地图）：'3_0' 不出现，一切照旧
  const withoutDefaults = makeDocument()
  assert.equal(collectOverlaySamples(withoutDefaults, temperature).length, 3)
})

test('每格默认值：改默认值立刻生效（样本值进哈希 → 缓存重算），文件里的格不动', () => {
  const document = makeDocument()
  const cache = createOverlayFieldCache()
  document.dataDefaults = { temp: 12 }
  const first = buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE, cache })
  const keyWith12 = cache.key
  document.dataDefaults = { temp: 30 }
  const second = buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE, cache })
  assert.equal(cache.builds, 2, '默认值变了 → 必须重算')
  assert.notEqual(cache.key, keyWith12)
  assert.notEqual(second.plan, first.plan)
  // 关键：格上仍然没有 temp 这个键（默认值只影响渲染，不写进数据）
  assert.equal('temp' in document.terrain['3_0']!, false)
})

test('导出颜色面的体积上限：正常走内联栅格并报出体积；超上限**整层退回逐格多边形**', () => {
  const document = makeDocument()
  const layers = withLayerVisibility(DEFAULT_LAYER_VISIBILITY, 'temperature', true)
  const options = {
    width: 400,
    height: 300,
    overlayStyles: { ...DEFAULT_OVERLAY_STYLES, temperature: FIELD_STYLE },
    layers,
  }

  // ---- 正常路径：内联栅格，报告里写明体积与走法 ----
  const built = buildMapPreviewSvgWithReport(document, [], options)
  assert.deepEqual(
    built.overlays.map((note) => [note.label, note.path]),
    [['温度', 'raster']],
    '温度层是连续场 → 走内联栅格',
  )
  const rasterNote = built.overlays[0]!
  assert.equal(rasterNote.inlineChars > 0, true, '内联体积要真的被算出来（导出报告会写它）')
  assert.equal(built.svg.includes('data:image/png;base64,'), true)
  assert.match(describeOverlayExport(built.overlays), /温度：内联栅格（\d+ KiB）/)

  // ---- 超上限：同一份数据、同一个字段规格，**换一种显示方式**重新问一次（没有第二份几何）----
  // 上限比实际体积小 1 个字符 —— 这样这条断言与栅格分辨率无关（改采样口径也不会假绿）
  const tiny = buildMapPreviewSvgWithReport(document, [], {
    ...options,
    overlayRasterMaxChars: rasterNote.inlineChars - 1,
  })
  assert.equal(tiny.overlays[0]?.path, 'vector', '超上限必须退回矢量')
  assert.equal(tiny.overlays[0]?.inlineChars, 0, '走矢量时不再报内联体积')
  assert.equal(tiny.svg.includes('data:image/png;base64,'), false, '退回矢量后不许再有内联图片')
  assert.match(tiny.svg, /data-fc-primitive="polygon"/, '退回的那一层要有逐格多边形')
  assert.match(describeOverlayExport(tiny.overlays), /温度：退回矢量（内联会超过 128 KiB 上限）/)
  // 退回的是**同一层**：逐格模式的色块数 = 有值的格数（此处 3），且不残留等值线
  const cellPlan = buildOverlayPlan({ document, spec: temperature, style: { ...FIELD_STYLE, mode: 'cell' } })
  assert.equal(
    (tiny.svg.match(/data-fc-primitive="polygon"/g) ?? []).length,
    cellPlan.stats.drawn,
    '退回矢量用的是 buildOverlayPlan 的逐格那条路（不是另写一份画法）',
  )
  assert.equal((tiny.svg.match(/data-fc-primitive="polyline"/g) ?? []).length, 0, '退回矢量后不再有等值线')

  // ---- 逐格上色本来就没有颜色面：报告里如实标 cell（不是"走了栅格"）----
  const cellExport = buildMapPreviewSvgWithReport(document, [], {
    ...options,
    overlayStyles: { ...DEFAULT_OVERLAY_STYLES, temperature: CELL_STYLE },
  })
  assert.equal(cellExport.overlays[0]?.path, 'cell')
  assert.equal(describeOverlayExport(cellExport.overlays), '', '逐格层没有"哪条路"可说 → 报告里不提')

  // 没有任何连续场时导出提示不该多出一段（`main.ts` 靠空串决定要不要附加）
  assert.equal(describeOverlayExport([]), '')
})

test('缓存：键随数据与**显示参数**变、不随视口变；命中后不再重算', () => {
  const document = makeDocument()
  const samples = collectOverlaySamples(document, temperature)
  const key = overlayFieldCacheKey(temperature, document, samples, FIELD_STYLE)
  assert.equal(
    key,
    overlayFieldCacheKey(temperature, document, collectOverlaySamples(document, temperature), FIELD_STYLE),
    '同一份数据 = 同一个键',
  )
  // 平移只影响视口，样本集合不变（这就是"平移不该失效"）
  assert.equal(key, overlayFieldCacheKey(temperature, document, collectOverlaySamples(document, temperature, undefined), FIELD_STYLE))

  const cache = createOverlayFieldCache()
  let built = 0
  const build = () => {
    built += 1
    return buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE }).plan
  }
  const first = cachedOverlayPlan(cache, key, build)
  assert.equal(cache.builds, 1)
  assert.equal(cache.hits, 0)
  const second = cachedOverlayPlan(cache, key, build)
  assert.equal(second, first, '命中时返回同一份计划（证明没有重算）')
  assert.equal(built, 1, '第二帧没有重新采样/重新上色')
  assert.equal(cache.hits, 1)

  // 改一格的**值**（不是格集合）也必须换键，否则"改了一格画面不变"
  document.terrain['0_0']!.temp = 16
  const changed = overlayFieldCacheKey(
    temperature,
    document,
    collectOverlaySamples(document, temperature),
    FIELD_STYLE,
  )
  assert.notEqual(changed, key)

  // 改**显示参数**（色带 / 不透明度 / 等值线间距）同样必须换键：
  // 否则表现成"在设置里改了颜色，画布要等下一次数据变化才更新"（比不更新更隐蔽）
  const rampChanged: OverlayStyle = { ...FIELD_STYLE, ramp: { ...FIELD_STYLE.ramp, stops: FIELD_STYLE.ramp.stops.map((stop) => ({ ...stop, color: '#123456' })) } }
  assert.notEqual(overlayFieldCacheKey(temperature, document, samples, rampChanged), key, '色带进键')
  assert.notEqual(overlayFieldCacheKey(temperature, document, samples, { ...FIELD_STYLE, opacity: 0.9 }), key, '不透明度进键')
  assert.notEqual(overlayFieldCacheKey(temperature, document, samples, { ...FIELD_STYLE, contourInterval: 5 }), key, '等值线间距进键')
  assert.notEqual(overlayFieldCacheKey(temperature, document, samples, CELL_STYLE), key, '显示方式进键')

  // 展示单位与地图标定**不改几何、只改线上的数字**（"5" vs "5 km"），同样必须进键 ——
  // 否则在设置里换了单位，等值线还在、数字却要等下次数据变化才更新（比"颜色不刷新"更隐蔽）
  const depth = overlayField('depth')
  const depthField: OverlayStyle = { ...depth.defaultStyle(), mode: 'field', contourInterval: 1000 }
  const depthKey = overlayFieldCacheKey(depth, document, samples, depthField)
  assert.notEqual(
    overlayFieldCacheKey(depth, document, samples, { ...depthField, unit: 'km' }),
    depthKey,
    '展示单位进键',
  )
  const calibrated: MapDocument = { ...document, elevation: { unit: 'm', maxDepth: 8000, maxHeight: 3000 } }
  assert.notEqual(
    overlayFieldCacheKey(depth, calibrated, samples, { ...depthField, unit: 'rel' }),
    overlayFieldCacheKey(depth, document, samples, { ...depthField, unit: 'rel' }),
    '地图标定进键',
  )
})

test('缓存命中时图元清单也复用（连续场每帧只剩"画"）', () => {
  const document = makeDocument()
  const cache = createOverlayFieldCache()
  const first = buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE, cache })
  const second = buildOverlayPlan({ document, spec: temperature, style: FIELD_STYLE, cache })
  assert.equal(cache.builds, 1)
  assert.equal(cache.hits, 1)
  assert.equal(second.plan, first.plan, '命中的那一帧直接复用上一帧的计划对象')
  assert.deepEqual(second.stats, first.stats)
})

test('字段表里的每个字段都能走两种模式（加一行字段不用改计划层）', () => {
  const document = makeDocument()
  document.terrain['0_0'] = { t: 'water', temp: 15, depth: 3000 }
  for (const spec of OVERLAY_FIELDS) {
    for (const mode of ['cell', 'field'] as const) {
      const style = { ...spec.defaultStyle(), mode }
      const { stats } = buildOverlayPlan({ document, spec, style })
      assert.equal(stats.mode, mode, `${spec.id}/${mode}`)
      assert.equal(stats.drawn > 0, true, `${spec.id}/${mode} 至少要画出东西`)
    }
  }
})

/** 让类型检查确认 `OverlayStyles` 在测试里也是完整的一份（漏字段会在编译期报错） */
const STYLES_SAMPLE: OverlayStyles = DEFAULT_OVERLAY_STYLES
assert.equal(Object.keys(STYLES_SAMPLE).length, OVERLAY_FIELDS.length)