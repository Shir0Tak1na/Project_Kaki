/**
 * 标记图片的导出内联：**派生 + 封顶**。
 *
 * 这一组盯的是三条口径：
 * 1. 派生图按 `object-fit: contain` 等比缩到最长边 ≤64px（不能把 128×96 拉成 64×64）；
 * 2. 解不开 / 取不到 / 超上限 → 返回 `null`，调用方回退字形（**绝不内联坏数据**）；
 * 3. 同一路径只处理一次；单张与总量都有上限（导出文件不会失控）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MARKER_IMAGE_MAX_CHARS,
  MARKER_IMAGE_MAX_EDGE,
  MARKER_IMAGE_TOTAL_MAX_CHARS,
  deriveMarkerImageDataUrl,
  fitInsideBox,
  inlineMarkerImages,
  type MarkerCanvasLike,
  type MarkerImageLike,
} from '../src/render/markerImageInline.ts'

/** 一张"已经加载好"的图（走默认 waitForImage 的缓存分支） */
function loadedImage(width: number, height: number): MarkerImageLike {
  return {
    src: '',
    complete: true,
    naturalWidth: width,
    naturalHeight: height,
    onload: null,
    onerror: null,
  }
}

/** 记录画布尺寸与 drawImage 的落点，`toDataURL` 返回给定串 */
function fakeCanvas(dataUrl: string | null, sizes: Array<{ width: number; height: number; drawWidth: number }>): (width: number, height: number) => MarkerCanvasLike {
  return (width, height) => {
    const canvas: MarkerCanvasLike = {
      width,
      height,
      getContext: () => ({
        drawImage: (_image, _dx, _dy, dw) => {
          sizes.push({ width, height, drawWidth: dw })
        },
      }),
    }
    if (dataUrl !== null) canvas.toDataURL = () => dataUrl
    return canvas
  }
}

test('fitInsideBox：等比缩到最长边 ≤ 上限（不是硬拉成正方形）', () => {
  assert.deepEqual(fitInsideBox(128, 96, 64), { width: 64, height: 48 })
  assert.deepEqual(fitInsideBox(32, 16, 64), { width: 32, height: 16 }, '本来就小就不放大')
  assert.deepEqual(fitInsideBox(100, 400, 64), { width: 16, height: 64 })
})

test('fitInsideBox：尺寸非法返回 null（不产生 0×0 画布）', () => {
  assert.equal(fitInsideBox(0, 10, 64), null)
  assert.equal(fitInsideBox(10, 0, 64), null)
  assert.equal(fitInsideBox(Number.NaN, 10, 64), null)
})

test('派生成功：按 contain 的尺寸画进画布，返回 PNG data URL', async () => {
  const sizes: Array<{ width: number; height: number; drawWidth: number }> = []
  const dataUrl = await deriveMarkerImageDataUrl('app://local/Assets/lighthouse.png', {
    createImage: () => loadedImage(128, 96),
    createCanvas: fakeCanvas('data:image/png;base64,AAAA', sizes),
  })
  assert.equal(dataUrl, 'data:image/png;base64,AAAA')
  assert.deepEqual(sizes, [{ width: 64, height: 48, drawWidth: 64 }])
  assert.equal(MARKER_IMAGE_MAX_EDGE, 64)
})

test('加载失败 / 尺寸为 0 / 没有 toDataURL / 不是图片 data URL → 一律 null', async () => {
  const deps = (overrides: Record<string, unknown>) => ({
    createImage: () => loadedImage(64, 64),
    createCanvas: fakeCanvas('data:image/png;base64,AAAA', []),
    ...overrides,
  })

  assert.equal(await deriveMarkerImageDataUrl('app://x.png', deps({ waitForImage: async () => false })), null)
  assert.equal(await deriveMarkerImageDataUrl('app://x.png', deps({ createImage: () => loadedImage(0, 0) })), null)
  assert.equal(await deriveMarkerImageDataUrl('app://x.png', deps({ createCanvas: fakeCanvas(null, []) })), null)
  assert.equal(await deriveMarkerImageDataUrl('app://x.png', deps({ createCanvas: fakeCanvas('data:text/html,no', []) })), null)
  assert.equal(await deriveMarkerImageDataUrl('   ', deps({})), null)
})

test('单张超上限 → null（不把大图塞进导出）', async () => {
  const oversized = `data:image/png;base64,${'a'.repeat(MARKER_IMAGE_MAX_CHARS)}`
  const dataUrl = await deriveMarkerImageDataUrl('app://big.png', {
    createImage: () => loadedImage(64, 64),
    createCanvas: fakeCanvas(oversized, []),
  })
  assert.equal(dataUrl, null)
})

test('inlineMarkerImages：同一路径只处理一次，空路径与解析不到地址的都跳过', async () => {
  const resolved: string[] = []
  const map = await inlineMarkerImages(
    ['Assets/a.png', 'Assets/a.png', '   ', 'Assets/missing.png'],
    (path) => {
      resolved.push(path)
      return path === 'Assets/missing.png' ? '' : `app://local/${path}`
    },
    {
      createImage: () => loadedImage(64, 64),
      createCanvas: fakeCanvas('data:image/png;base64,AAAA', []),
    },
  )
  assert.deepEqual(resolved, ['Assets/a.png', 'Assets/missing.png'])
  assert.deepEqual([...map.keys()], ['Assets/a.png'])
})

test('inlineMarkerImages：总量封顶 —— 再多的图也不会让导出文件无限膨胀', async () => {
  const perImage = `data:image/png;base64,${'a'.repeat(MARKER_IMAGE_MAX_CHARS - 'data:image/png;base64,'.length)}`
  assert.equal(perImage.length, MARKER_IMAGE_MAX_CHARS)
  const fit = Math.floor(MARKER_IMAGE_TOTAL_MAX_CHARS / MARKER_IMAGE_MAX_CHARS)
  const paths = Array.from({ length: fit + 1 }, (_, index) => `Assets/${index}.png`)

  const map = await inlineMarkerImages(paths, (path) => `app://local/${path}`, {
    createImage: () => loadedImage(64, 64),
    createCanvas: fakeCanvas(perImage, []),
  })
  assert.equal(map.size, fit, `总量上限 ${MARKER_IMAGE_TOTAL_MAX_CHARS} 应只放得下 ${fit} 张`)
  assert.equal(map.has(`Assets/${fit}.png`), false, '超出总量的最后一张不该被内联')
})
