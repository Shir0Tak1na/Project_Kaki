/**
 * 导出侧的外观（工单 A）：**区域的边框 / 不透明度**与**标记的字形**。
 *
 * 这一组断言盯的是"导出与画布同源"这件事：
 * 1. 区域的外观**取这条区域自己存的值**（width 0 = 不画边框、边框色缺省跟随填充色、虚线按同一比例换算）；
 * 2. 标记形状走**与画布同一份解析**（`resolveMarkerStyle` → Lucide 名），再由注入的函数换成片段；
 * 3. 拿不到片段时**回退成兜底圆点** —— 对象绝不消失；
 * 4. 导出的 SVG **自包含**：不许出现任何指向库内文件的引用。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildMapPreviewSvg } from '../src/base/mapPreview.ts'
import { createEmptyMapDocument, type MapDocument } from '../src/data/mapDocument.ts'

/** 一个 100×100 世界、含一条区域与一个标记的文档（bounding box 恰好 0–100，便于手算比例） */
function makeDocument(): MapDocument {
  const document = createEmptyMapDocument({})
  document.regions = [
    {
      id: 'r1',
      label: '北境',
      pts: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      color: '#44cf6e',
      opacity: 0.22,
    },
  ]
  document.markers = [{ id: 'm1', label: '城', p: [50, 50], icon: 'city' }]
  return document
}

/**
 * 导出比例：1600×1000、padding 32 → innerW 1536 / innerH 936，世界只有 100×100 → 取小者 9.36。
 * 断言里凡是"按比例换算"的数字都从这里来（改排版参数时这些断言会一起变，这是有意的）。
 */
const SCALE = 9.36

function render(options: { iconSvgFor?: (name: string) => string | null } = {}): string {
  return buildMapPreviewSvg(makeDocument(), [], {
    width: 1600,
    height: 1000,
    padding: 32,
    ...options,
  })
}

test('区域用自己存的边框：宽度 / 颜色 / 虚线（按导出比例换算，与画布同一条式子）', () => {
  const document = makeDocument()
  document.regions[0]!.borderColor = '#101010'
  document.regions[0]!.borderWidth = 2
  document.regions[0]!.borderDash = [6, 3]
  const svg = buildMapPreviewSvg(document, [], { width: 1600, height: 1000, padding: 32 })

  assert.match(svg, /data-row-id="map:region:r1"/)
  assert.match(svg, /fill="#44cf6e"/)
  assert.match(svg, /fill-opacity="0.22"/)
  assert.match(svg, /stroke="#101010"/)
  assert.match(svg, new RegExp(`stroke-width="${(2 * SCALE).toFixed(2)}"`))
  assert.match(
    svg,
    new RegExp(`stroke-dasharray="${[6, 3].map((value) => (value * SCALE).toFixed(2)).join(' ')}"`),
  )
})

test('区域没有边框宽度（旧区域）：不画边框 —— 与画布一致，而不是自己补一条描边', () => {
  const svg = render()
  const region = /<polygon data-row-id="map:region:r1"[^>]*>/.exec(svg)?.[0] ?? ''
  assert.match(region, /stroke="none"/, region)
  assert.equal(region.includes('stroke-dasharray'), false, region)
  assert.equal(region.includes('stroke-width'), false, region)
})

test('边框色缺省时跟随填充色（与画布的 `borderColor ?? color` 同一条口径）', () => {
  const document = makeDocument()
  document.regions[0]!.borderWidth = 3
  const svg = buildMapPreviewSvg(document, [], { width: 1600, height: 1000, padding: 32 })
  assert.match(svg, /data-row-id="map:region:r1"/)
  assert.match(svg, /stroke="#44cf6e"/)
})

test('标记按字形画：注入的片段被内联，位置与缩放写在 transform 里', () => {
  const calls: string[] = []
  const svg = render({
    iconSvgFor: (name) => {
      calls.push(name)
      return `<path data-fc-icon="${name}"/>`
    },
  })
  assert.equal(calls.length, 1, JSON.stringify(calls))
  assert.ok(calls[0]!.length > 0, '传进来的必须是已解析的图标名（不是空串）')
  assert.match(svg, /data-row-id="map:marker:m1" transform="translate\([\d.]+,[\d.]+\) scale\(0\.7500\)/)
  assert.match(svg, /<path data-fc-icon="/)
  assert.equal(svg.includes('<circle data-row-id="map:marker:m1"'), false, '走了字形就不该再画兜底圆点')
})

test('取不到字形（注入返回 null）时回退成兜底圆点 —— 对象绝不消失', () => {
  const svg = render({ iconSvgFor: () => null })
  assert.match(svg, /<circle data-row-id="map:marker:m1"/)
  assert.match(svg, /r="3"/)
})

test('未知图标名也走同一份解析：注入拿到的是目录给出的回退名字，而不是原样透传', () => {
  const document = makeDocument()
  document.markers[0]!.icon = 'not-a-real-icon'
  const calls: string[] = []
  buildMapPreviewSvg(document, [], {
    width: 1600,
    height: 1000,
    padding: 32,
    iconSvgFor: (name) => {
      calls.push(name)
      return null
    },
  })
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0], 'not-a-real-icon', '不该把认不出的 ID 直接丢给图标集')
  assert.ok(calls[0]!.length > 0, '必须给一个可用的回退字形名')
})

test('导出的 SVG 自包含：不出现指向库内文件或外部的引用', () => {
  const document = makeDocument()
  document.regions[0]!.borderWidth = 2
  const svg = buildMapPreviewSvg(document, [], {
    width: 1600,
    height: 1000,
    padding: 32,
    iconSvgFor: () => '<path d="M0 0"/>',
  })
  for (const forbidden of ['app://', 'url(', 'data:', 'xlink:href', '<image']) {
    assert.equal(svg.includes(forbidden), false, `导出里不该出现 ${forbidden}`)
  }
  // `xmlns="http://www.w3.org/2000/svg"` 是**命名空间声明**，不算外部引用；
  // 除此之外不该再有 http（图片、字体、样式表都会在这里露出来）
  const httpCount = (svg.match(/http/g) ?? []).length
  const xmlnsCount = (svg.match(/xmlns=/g) ?? []).length
  assert.equal(httpCount, xmlnsCount, `出现 ${httpCount} 处 http，但只有 ${xmlnsCount} 处 xmlns 声明`)
})