/**
 * PNG 导出的单元测试。
 *
 * 重点不在"能不能跑通"，而在三件真会出错的事：
 * 1. **data URL 的编码**：地图名字是中文，用 `btoa` 会直接抛异常；
 * 2. **图片已缓存完成**的分支：命中缓存时浏览器不再触发 `load`，只挂 onload 会永远等下去；
 * 3. **失败路径的措辞**：不能抛异常、不能返回空白图，必须给人话。
 *
 * 真实光栅化（浏览器里的 Image + toBlob）不在单测覆盖范围内 —— 那是冒烟与真实库的事，
 * 这里用注入的替身把**逻辑**测完。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { exportBasePathFor, rasterizeSvgToPng, svgToDataUrl, uniqueExportPath } from '../src/base/pngExport.ts'
import type { BlobLike, RasterCanvasLike, RasterImageLike } from '../src/base/pngExport.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f6f8fb"/><text fill="#1f2937">北境领</text></svg>'

type Trigger = 'load' | 'error' | 'never'

/** 造一个可控的图片替身（不依赖 DOM），按剧本在 set src 时触发 onload/onerror */
function makeImageDouble(options: { complete?: boolean; naturalWidth?: number; trigger?: Trigger } = {}): RasterImageLike & { typed?: string } {
  const { complete = false, naturalWidth = 0, trigger = 'never' }: { complete?: boolean; naturalWidth?: number; trigger?: Trigger } = options
  let source = ''
  const image = {
    complete,
    naturalWidth,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    get src() {
      return source
    },
    set src(value: string) {
      source = value
      if (trigger === 'load') queueMicrotask(() => image.onload?.())
      if (trigger === 'error') queueMicrotask(() => image.onerror?.())
    },
  }
  return image
}

/** 画布替身：记录 drawImage 的实参，好断言"画的是哪张图、画到多大" */
function makeCanvasDouble(): RasterCanvasLike & { drawn: unknown[][] } {
  const canvas = {
    width: 0,
    height: 0,
    drawn: [] as unknown[][],
    getContext: (type: string) =>
      type === '2d'
        ? {
            drawImage: (...args: unknown[]) => {
              canvas.drawn.push(args)
            },
          }
        : null,
  }
  return canvas
}

function makeBlobDouble(size = 1): BlobLike {
  return { arrayBuffer: async () => new ArrayBuffer(size) }
}

test('SVG → data URL：中文与 # 颜色必须安全（btoa 会在中文上抛异常）', () => {
  const url = svgToDataUrl(SVG)
  assert.equal(url.startsWith('data:image/svg+xml;charset=utf-8,'), true)
  // 原始字符不能直接出现在 URL 里（否则 data URL 会被 # 截断、被 < 破坏）
  const payload = url.slice('data:image/svg+xml;charset=utf-8,'.length)
  assert.equal(payload.includes('<'), false, '未转义的 < 会破坏 data URL')
  assert.equal(payload.includes('>'), false)
  assert.equal(payload.includes('#'), false, '未转义的 # 会把 data URL 截断')
  assert.equal(payload.includes('北'), false, '中文必须被编码')
  // 解码回来必须逐字节等于原串（中文标签是最容易出问题的地方）
  assert.equal(decodeURIComponent(payload), SVG)
})

test('导出基础名：.map.md → 去后缀，其它路径不动', () => {
  assert.equal(exportBasePathFor('Maps/World.map.md'), 'Maps/World')
  assert.equal(exportBasePathFor('maps/北境.MAP.MD'), 'maps/北境')
  assert.equal(exportBasePathFor('Maps/World.md'), 'Maps/World.md')
})

test('重名规则：依次 -2、-3，且不会因 exists 恒真而死循环', () => {
  assert.equal(uniqueExportPath('Maps/World', '.png', () => false), 'Maps/World.png')
  const taken = new Set(['Maps/World.png', 'Maps/World-2.png'])
  assert.equal(uniqueExportPath('Maps/World', 'png', (path) => taken.has(path)), 'Maps/World-3.png')
  const all = uniqueExportPath('Maps/World', '.png', () => true)
  assert.equal(/^Maps\/World-\d+\.png$/.test(all), true, `必须收敛到一个确定的名字，实际 ${all}`)
})

test('光栅化：成功路径要把图片真的画进画布，并且用的是同一个 data URL', async () => {
  const image = makeImageDouble({ trigger: 'load' })
  const canvas = makeCanvasDouble()
  const blob = makeBlobDouble(1234)
  let blobsAsked = 0
  const result = await rasterizeSvgToPng(SVG, { width: 300, height: 200 }, {
    createImage: () => image,
    createCanvas: (width, height) => {
      canvas.width = width
      canvas.height = height
      return canvas
    },
    toBlob: async (_canvas, type) => {
      blobsAsked += 1
      assert.equal(type, 'image/png')
      return blob
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.blob, blob)
  assert.equal(result.width, 300)
  assert.equal(result.height, 200)
  assert.equal(blobsAsked, 1)
  assert.equal(image.src, svgToDataUrl(SVG), 'image.src 必须是同一份编码，不能二次编码')
  assert.equal(canvas.drawn.length, 1, '必须正好 drawImage 一次')
  const drawn = canvas.drawn[0]!
  assert.deepEqual(drawn.slice(-4), [0, 0, 300, 200])
  assert.equal(drawn[0], image)
})

test('光栅化：图片已缓存完成时不能被"等 load 事件"卡住', async () => {
  // complete=true 且 naturalWidth>0 —— 浏览器不会再触发 load
  const image = makeImageDouble({ complete: true, naturalWidth: 8, trigger: 'never' })
  const canvas = makeCanvasDouble()
  const result = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: () => image,
    createCanvas: () => canvas,
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(result.ok, true, `缓存命中时必须直接继续，实际 ${JSON.stringify(result)}`)
})

test('光栅化：缺少环境能力时给出可执行的人话，而不是抛异常', async () => {
  const noImage = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: () => null,
    createCanvas: () => makeCanvasDouble(),
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(noImage.ok, false)
  assert.match(noImage.reason, /图片|PNG|SVG/)

  // 三个能力全缺（例如某些移动端 WebView 没有 toBlob）
  const nothing = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: undefined,
    createCanvas: undefined,
    toBlob: undefined,
    waitForImage: async () => true,
  })
  assert.equal(nothing.ok, false)
  assert.match(nothing.reason, /不支持|SVG/, nothing.reason)

  const empty = await rasterizeSvgToPng('   ', { width: 10, height: 10 }, {
    createImage: () => makeImageDouble({ trigger: 'load' }),
    createCanvas: () => makeCanvasDouble(),
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /空/)
})

test('光栅化：解码失败 / 画布失败 / toBlob 返回空，三条失败路径都要有原因', async () => {
  const brokenImage = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: () => makeImageDouble({ trigger: 'error' }),
    createCanvas: () => makeCanvasDouble(),
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(brokenImage.ok, false)
  assert.match(brokenImage.reason, /解码|拒绝|SVG/)

  const noCanvas = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: () => makeImageDouble({ trigger: 'load' }),
    createCanvas: () => null,
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(noCanvas.ok, false)
  assert.match(noCanvas.reason, /画布/)

  const noBlob = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: () => makeImageDouble({ trigger: 'load' }),
    createCanvas: () => makeCanvasDouble(),
    toBlob: async () => null,
  })
  assert.equal(noBlob.ok, false)
  assert.match(noBlob.reason, /PNG|toBlob/)

  const noContext = await rasterizeSvgToPng(SVG, { width: 10, height: 10 }, {
    createImage: () => makeImageDouble({ trigger: 'load' }),
    createCanvas: () => ({ width: 0, height: 0, getContext: () => null }),
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(noContext.ok, false)
  assert.match(noContext.reason, /2D|上下文/)
})

test('光栅化：尺寸被夹取成合法整数像素（画布不能是 0 宽）', async () => {
  const canvas = makeCanvasDouble()
  const result = await rasterizeSvgToPng(SVG, { width: 0.4, height: -3 }, {
    createImage: () => makeImageDouble({ trigger: 'load' }),
    createCanvas: (width, height) => {
      canvas.width = width
      canvas.height = height
      return canvas
    },
    toBlob: async () => makeBlobDouble(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.width, 1)
  assert.equal(result.height, 1)
  assert.equal(canvas.width, 1)
  assert.equal(canvas.height, 1)
})
