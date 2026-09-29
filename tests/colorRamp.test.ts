/**
 * 色带（数值 → 颜色）的单测：解析 / 插值空间 / 越界 / 规范化。
 *
 * 重点盯两件事：
 * 1. **插值空间真的生效**（Oklab 与 RGB 的结果必须不同）—— 否则"用户选了 Oklab"是句空话；
 * 2. **越界与缺数据不是一回事**：越界是合法值（有颜色），NaN 是"没有数据"（返回 null）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OVER,
  DEFAULT_UNDER,
  RAMP_MAX_STOPS,
  colorForValue,
  defaultTemperatureRamp,
  describeRampProblem,
  mixColors,
  normalizeRampSpec,
  oklabToSrgb,
  oppositeTextColor,
  parseHexColor,
  relativeLuminance,
  rgbToHex,
  srgbToOklab,
  textColorOf,
  type RampSpec,
} from '../src/render/colorRamp.ts'

const DARK_TEXT = '#111827'

test('parseHexColor：3 位展开、6 位直读、8 位忽略 alpha，非法值一律 null', () => {
  assert.deepEqual(parseHexColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseHexColor('#0a0b0c'), [10, 11, 12])
  assert.deepEqual(parseHexColor('#0a0b0cff'), [10, 11, 12], '8 位只取 RGB，alpha 归图层管')
  assert.deepEqual(parseHexColor('  #ABC  '), [170, 187, 204], '两侧空白要容忍，大小写不敏感')
  for (const bad of ['#12', '#12345', '#1234567', 'rgb(1,2,3)', 'red', 'url(x)', '', null, 42]) {
    assert.equal(parseHexColor(bad), null, `${JSON.stringify(bad)} 不该被当成颜色`)
  }
})

test('rgbToHex：取整并夹在 0–255（空间外推会给出超范围值）', () => {
  assert.equal(rgbToHex([255, 0, 0]), '#ff0000')
  assert.equal(rgbToHex([-12, 300, 127.6]), '#00ff80')
})

test('Oklab 往返：sRGB → Oklab → sRGB 误差不超过 1/255', () => {
  const samples: Array<[number, number, number]> = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [0, 128, 64],
    [245, 158, 11],
    [17, 24, 39],
  ]
  for (const rgb of samples) {
    const back = oklabToSrgb(srgbToOklab(rgb))
    back.forEach((value, index) => {
      assert.ok(
        Math.abs(value - rgb[index]!) <= 1,
        `${JSON.stringify(rgb)} → ${JSON.stringify(back)}（第 ${index} 通道偏差过大）`,
      )
    })
  }
})

test('Oklab 里 0 是黑、1 是白（量纲对得上，不是随便一个变换）', () => {
  assert.ok(Math.abs(srgbToOklab([0, 0, 0])[0] - 0) < 1e-6)
  assert.ok(Math.abs(srgbToOklab([255, 255, 255])[0] - 1) < 1e-6)
})

test('插值空间真的生效：蓝红中点，Oklab 与 RGB 必须给出不同颜色（鉴别力）', () => {
  const blue: [number, number, number] = [0, 0, 255]
  const red: [number, number, number] = [255, 0, 0]
  const inOklab = rgbToHex(mixColors(blue, red, 0.5, 'oklab'))
  const inRgb = rgbToHex(mixColors(blue, red, 0.5, 'rgb'))
  assert.equal(inRgb, '#800080')
  assert.notEqual(inOklab, inRgb, '若两者相同，说明 Oklab 那条分支根本没被走到')
})

test('relativeLuminance：白 1、黑 0，且按线性空间加权', () => {
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-9)
  assert.equal(relativeLuminance([0, 0, 0]), 0)
})

test('textColorOf 按对比度选字色（浅黄底必须用深色字，这是"亮度阈值"写法会选错的地方）', () => {
  assert.equal(textColorOf('#ffffff'), DARK_TEXT)
  assert.equal(textColorOf('#000000'), '#ffffff')
  // #f59e0b 的相对亮度约 0.44 < 0.5，朴素写法会选白字 —— 但那对比度只有 2.1，读不清
  assert.equal(textColorOf('#f59e0b'), DARK_TEXT)
  assert.equal(textColorOf('#0000ff'), '#ffffff')
})

test('oppositeTextColor：与字色**相反**（白字配深边 / 深字配浅边），且与 textColorOf 恒不相等', () => {
  // 等值线数字的描边口径就靠这一条：写死白边会让"深字 + 白边"压在浅色场上糊成一坨（用户实测报过）
  assert.equal(oppositeTextColor('#0000ff'), DARK_TEXT, '深底白字 → 描边必须是深色')
  assert.equal(oppositeTextColor('#ffffff'), '#ffffff', '白底深字 → 描边必须是白色')
  assert.equal(oppositeTextColor('#f59e0b'), '#ffffff')
  // 不变量：描边色永远与字色不同（这一条对任何颜色都成立，包括解析不了的坏值）
  for (const color of ['#0000ff', '#ffffff', '#f59e0b', '#1e3a8a', 'not-a-color', '']) {
    assert.notEqual(oppositeTextColor(color), textColorOf(color), color)
  }
})

test('colorForValue：端点取锚点原色，带内插值，越界给纯色并标明方向', () => {
  const ramp: RampSpec = {
    stops: [
      { value: 0, color: '#0000ff' },
      { value: 10, color: '#00ff00' },
      { value: 20, color: '#ff0000' },
    ],
    under: { ...DEFAULT_UNDER },
    over: { ...DEFAULT_OVER },
    interpolate: 'oklab',
  }
  assert.equal(colorForValue(0, ramp)?.color, '#0000ff')
  assert.equal(colorForValue(20, ramp)?.color, '#ff0000')
  assert.equal(colorForValue(0, ramp)?.outOfRange, null, '等于下端不算越界')
  assert.equal(colorForValue(20, ramp)?.outOfRange, null, '等于上端不算越界')

  const middle = colorForValue(5, ramp)!
  assert.equal(middle.outOfRange, null)
  assert.notEqual(middle.color, '#0000ff')
  assert.notEqual(middle.color, '#00ff00')
  assert.match(middle.color, /^#[0-9a-f]{6}$/)

  assert.deepEqual(colorForValue(-1, ramp), { ...DEFAULT_UNDER, outOfRange: 'under' })
  assert.deepEqual(colorForValue(999, ramp), { ...DEFAULT_OVER, outOfRange: 'over' })
})

test('colorForValue：NaN / Infinity 返回 null（缺数据，不许冒充极值）', () => {
  const ramp = defaultTemperatureRamp()
  assert.equal(colorForValue(Number.NaN, ramp), null)
  assert.equal(colorForValue(Number.POSITIVE_INFINITY, ramp), null)
})

test('defaultTemperatureRamp：5 个体感分类（升序、颜色齐全）', () => {
  const ramp = defaultTemperatureRamp()
  assert.equal(ramp.stops.length, 5)
  assert.deepEqual(
    ramp.stops.map((stop) => stop.value),
    [-30, 0, 15, 30, 45],
  )
  for (const stop of ramp.stops) assert.equal(parseHexColor(stop.color) !== null, true, stop.color)
})

test('normalizeRampSpec：排序、去重（留第一条）、丢非法锚点、不足两条则整体回退', () => {
  const fallback = defaultTemperatureRamp()
  const normalized = normalizeRampSpec({
    stops: [
      { value: 30, color: '#F59E0B' },
      { value: 0, color: '#00C8C8' },
      { value: 0, color: '#000080' },
      { value: 10, color: 'rgb(1,2,3)' },
      { value: Number.NaN, color: '#ffffff' },
      'not-an-object',
    ],
    interpolate: 'rgb',
  })
  assert.deepEqual(
    normalized.stops.map((stop) => [stop.value, stop.color]),
    [
      [0, '#00c8c8'],
      [30, '#f59e0b'],
    ],
    '顺序被排好、同值只留第一条、非 hex 与非有限值被丢掉，颜色统一成小写',
  )
  assert.equal(normalized.interpolate, 'rgb')

  // 锚点不够两条 → 整体回退（而不是画出一个"单色带"）
  assert.deepEqual(normalizeRampSpec({ stops: [{ value: 0, color: '#ffffff' }] }, fallback), fallback)
  assert.deepEqual(normalizeRampSpec(null, fallback), fallback)
})

test('normalizeRampSpec：越界色缺失或非法时给出可用的默认（文字色跟着出厂白字）', () => {
  const normalized = normalizeRampSpec({
    stops: [
      { value: 0, color: '#000000' },
      { value: 1, color: '#ffffff' },
    ],
    under: { color: 'not-a-color', textColor: 'also-not' },
    over: { color: '#ffcc00' },
  })
  assert.deepEqual(normalized.under, DEFAULT_UNDER)
  assert.equal(normalized.over.color, '#ffcc00')
  // 需求原话是"超过两端用纯色底白字"：纯红底按对比度算会选深色，所以这里**不**自动改文字色
  assert.equal(normalized.over.textColor, '#ffffff')
  // 用户明确指定了就听用户的
  assert.equal(normalizeRampSpec({ stops: normalized.stops, over: { color: '#ffcc00', textColor: '#123456' } }).over.textColor, '#123456')
})

test('normalizeRampSpec：锚点数超上限时截断（防呆，不是产品限制）', () => {
  const stops = Array.from({ length: RAMP_MAX_STOPS + 5 }, (_, index) => ({ value: index, color: '#123456' }))
  assert.equal(normalizeRampSpec({ stops }).stops.length, RAMP_MAX_STOPS)
})

test('describeRampProblem：只挡"交给 canvas 会无效"的颜色', () => {
  assert.equal(describeRampProblem(defaultTemperatureRamp()), null)
  const broken: RampSpec = { ...defaultTemperatureRamp(), under: { color: 'not a color', textColor: '#fff' } }
  assert.match(describeRampProblem(broken) ?? '', /越界颜色/)
})