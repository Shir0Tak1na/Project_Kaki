/**
 * 库内图片清单的单元测试。
 *
 * 重点：
 * 1. **白名单与 `terrainCatalog` 同源** —— 列出来的必须都是校验会接受的（否则"选了却被拒"）；
 * 2. **顺序确定** —— 否则弹窗每次顺序都变（用 `localeCompare` 就会这样，见实现里的注释）；
 * 3. 边界安全：空输入、非字符串、`Assets.v2/foo` 这种"点在目录里"的路径。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  assetFolderOf,
  assetNameOf,
  describeAssetChoice,
  emptyImageListHint,
  imageExtensionOf,
  isImagePath,
  listImagePaths,
} from '../src/base/assetFiles.ts'
import { IMAGE_EXTENSIONS, checkTerrainImagePath } from '../src/render/terrainCatalog.ts'

test('扩展名：大小写不敏感，点在目录里不算扩展名，无扩展名返回空串', () => {
  assert.equal(imageExtensionOf('Assets/forest.PNG'), 'png')
  assert.equal(imageExtensionOf('Assets/forest.png'), 'png')
  assert.equal(imageExtensionOf('Assets.v2/forest'), '', '目录里的点不是扩展名分隔符')
  assert.equal(imageExtensionOf('Assets/forest'), '')
  assert.equal(imageExtensionOf('Assets/forest.'), '')
  assert.equal(imageExtensionOf('Assets\\forest.jpg'), 'jpg', '反斜杠也算分隔符')
  assert.equal(imageExtensionOf(42), '')
  assert.equal(imageExtensionOf(null), '')
})

test('白名单与 terrainCatalog 同源：列出来的路径，校验必须接受', () => {
  // 这条是"选了却被拒"的防回归：遍历白名单里的每种扩展名，两边判断必须一致
  for (const extension of IMAGE_EXTENSIONS) {
    const path = `Assets/sample.${extension}`
    assert.equal(isImagePath(path), true, path)
    assert.equal(checkTerrainImagePath(path).problem, '', `校验也应接受 ${path}`)
  }
  // 反例：不在白名单里的，两边都该拒绝
  for (const path of ['Assets/notes.txt', 'Assets/data.json', 'Assets/画布.canvas', 'Assets/noext']) {
    assert.equal(isImagePath(path), false, path)
    assert.notEqual(checkTerrainImagePath(path).problem, '', `校验也应拒绝 ${path}`)
  }
})

test('筛选：只留图片、去重、反斜杠统一，且排序确定（两次调用完全一致）', () => {
  const input = [
    'Assets/b.png',
    'Assets/a.svg',
    'Notes/x.md',
    'Assets\\c.JPG',
    'Assets/a.svg',
    '.obsidian/app.json',
    'Assets/sub/deep.webp',
    'Assets/sample.gif',
    'Assets/old.jpeg',
    'Assets/noext',
  ]
  const first = listImagePaths(input)
  assert.deepEqual(first, [
    'Assets/a.svg',
    'Assets/b.png',
    'Assets/c.JPG',
    'Assets/old.jpeg',
    'Assets/sample.gif',
    'Assets/sub/deep.webp',
  ])
  const second = listImagePaths([...input].reverse())
  assert.deepEqual(second, first, '输入顺序不同，输出顺序必须相同')
})

test('筛选：空输入与坏输入安全（不抛异常、不产生空条目）', () => {
  assert.deepEqual(listImagePaths([]), [])
  assert.deepEqual(listImagePaths(null), [])
  assert.deepEqual(listImagePaths('Assets/a.png'), [], '不是数组就当没有')
  assert.deepEqual(listImagePaths([null, 42, {}, '   ', 'Assets/a.png']), ['Assets/a.png'])
})

test('短标签：带文件名与所在文件夹（同名文件要能分辨）', () => {
  assert.equal(assetNameOf('Assets/地形/forest.png'), 'forest.png')
  assert.equal(assetFolderOf('Assets/地形/forest.png'), 'Assets/地形')
  assert.equal(assetNameOf('forest.png'), 'forest.png')
  assert.equal(assetFolderOf('forest.png'), '')
  assert.equal(describeAssetChoice('Assets/地形/forest.png'), 'forest.png · Assets/地形')
  assert.equal(describeAssetChoice('forest.png'), 'forest.png')
  // 同名不同处：标签必须不同，否则用户在两行一样的条目里做选择
  assert.notEqual(describeAssetChoice('Assets/a/icon.png'), describeAssetChoice('Assets/b/icon.png'))
})

test('空清单提示：说清"为什么没有"与"该做什么"，并列出支持的格式', () => {
  const hint = emptyImageListHint()
  assert.match(hint, /没有找到图片/)
  assert.match(hint, /支持/)
  for (const extension of IMAGE_EXTENSIONS) assert.ok(hint.includes(extension), `提示里应列出 ${extension}`)
})
