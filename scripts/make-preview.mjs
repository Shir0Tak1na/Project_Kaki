/**
 * 生成 README 用的示例地图预览图（`docs/images/preview.svg`）。
 *
 * 为什么要用脚本生成、而不是放一张截图：
 * 1. **可复现**：改渲染器后重跑一次即可，不会出现"图是半年前的版本"；
 * 2. **诚实**：这张图是插件**自己的导出渲染器**（`buildMapExportSvg`）画出来的，
 *    不是手绘的示意图 —— README 里的图和用户导出的 SVG 走同一条代码路径；
 * 3. **不需要 Obsidian**：`mapPreview.ts` 刻意不 import obsidian，因此可以直接
 *    用 Node 24 的类型剥离导入 TypeScript 源文件（注意它用的是带 `.ts` 后缀的导入）。
 *
 * 与插件导出的唯一差别（写在这里以免误解）：
 * - 在 `<svg>` 后插入一层浅色背景矩形，并把 `currentColor` 换成固定深色 ——
 *   否则在深色主题的浏览器/GitHub 里，透明背景 + currentColor 的文字会看不见；
 * - 其余内容（地形色块、路径、区域、标记、文字）**原样来自渲染器**。
 *
 * 用法：node scripts/make-preview.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { axialToWorld, cellKey, cellsInRadius, hexDistance, hexCorners } from '../src/core/hex.ts'
import { buildMapExportSvg } from '../src/base/mapPreview.ts'
import { TERRAIN_STYLES } from '../src/render/terrainStyle.ts'
import { TERRAIN_TYPES } from '../src/data/mapDocument.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(here, '../docs/images/preview.svg')

const WIDTH = 1600
const HEIGHT = 1000
// kind 与 origin 是 GridSpec 的必填字段：脚本是 .mjs，不参与 tsc，
// 少一个字段只有运行到这里才会炸（我第一次就漏了 origin）
const GRID = { kind: 'hex', orientation: 'pointy', size: 40, origin: [0, 0] }

// ---------------------------------------------------------------- 示例世界
// 一个圆形的岛：中心是高原/山脉，往下过渡到森林、平原、沙漠，外围是海。
const ISLAND_RADIUS = 3
const SEA_RADIUS = 4

/**
 * 按"离岛心的距离 + 方位角"分配地形。
 *
 * ⚠️ 每个分支都必须**可达**：我第一版最后写了一句 `return distance === 2 ? 'forest' : 'grass'`，
 * 其中 `'grass'` 永远不会被执行（distance 只有 0/1/2/3 四种情况，前面都返回了）——
 * 于是"示例里有没有用错 ID"这件事被藏了大半，我改完 ID 还以为验证过了。
 * 现在的写法让 9 种内置地形**每一种都真的出现在图上**，错误 ID 无处可藏。
 */
function terrainAt(q, r) {
  const distance = hexDistance({ q: 0, r: 0 }, { q, r })
  if (distance > ISLAND_RADIUS) return 'water' // 外海
  if (distance === ISLAND_RADIUS) return 'swamp' // 环岛沼泽带
  const center = axialToWorld(GRID, q, r)
  const angle = Math.atan2(center.y, center.x)
  if (distance === 0) return 'volcanic' // 岛心火山
  if (distance === 1) return 'mountain' // 内圈山脉
  // distance === 2：按方位分块，让示例里出现多种地貌
  if (angle < -1.9) return 'tundra'
  if (angle < -0.6) return 'hills'
  if (angle > 1.1) return 'desert'
  return angle > 0.2 ? 'plains' : 'forest'
}

const terrain = {}
for (const cell of cellsInRadius(SEA_RADIUS)) {
  terrain[cellKey(cell.q, cell.r)] = { t: terrainAt(cell.q, cell.r) }
}

/** 把格坐标转成世界坐标（路径/区域/标记用连续坐标） */
const at = (q, r) => {
  const point = axialToWorld(GRID, q, r)
  return [Math.round(point.x * 100) / 100, Math.round(point.y * 100) / 100]
}

const document = {
  version: 1,
  grid: GRID,
  terrain,
  regions: [
    {
      id: 'r1',
      label: '北境领',
      pts: [at(-2, -2), at(1, -3), at(3, -1), at(2, 2), at(-1, 3), at(-3, 1)],
      color: '#44cf6e',
      opacity: 0.22,
    },
    {
      id: 'r2',
      label: '霜脊山脉',
      pts: [at(-1, -2), at(0, -2), at(1, -2), at(1, -1), at(0, -1), at(-1, -1)],
      color: '#9aa5b1',
      opacity: 0.28,
    },
  ],
  paths: [
    {
      id: 'p1',
      type: 'river',
      pts: [at(0, -1), at(0, 0), at(-1, 1), at(-1, 2), at(-2, 3)],
      width: 9,
      color: '#4a9fd8',
      label: '长歌川',
      smooth: true,
      taper: true,
      mode: 'interior',
    },
    {
      id: 'p2',
      type: 'trade-route',
      pts: [at(-2, 0), at(-1, 0), at(0, 1), at(1, 1), at(2, 2)],
      width: 6,
      color: '#c98a3c',
      label: '商路',
      dash: [10, 6],
      smooth: true,
      mode: 'edge',
    },
    {
      id: 'p3',
      type: 'border',
      pts: [at(-3, 0), at(-2, -1), at(0, -2)],
      width: 5,
      color: '#b0563f',
      mode: 'edge',
    },
  ],
  markers: [
    { id: 'm1', label: '龙脊城', p: at(0, 1), icon: 'city', link: 'Cities/龙脊城.md' },
    { id: 'm2', label: '白沙港', p: at(2, 3), icon: 'port', link: 'Cities/白沙港.md' },
    { id: 'm3', label: '灰烬祭坛', p: at(0, 0), icon: 'temple' },
    { id: 'm4', label: '断刃关', p: at(-2, -1), icon: 'fortress' },
  ],
  labels: [
    { id: 'l1', text: '雾 海', p: at(-4, 2), size: 34, color: '#3f6f8f', italic: true },
    { id: 'l2', text: '无 人 之 境', p: at(2, -4), size: 28, color: '#7b6a4f' },
  ],
}

// ---------------------------------------------------------------- 生成
const raw = buildMapExportSvg(document, WIDTH, HEIGHT)

// 浅色底 + 固定文字色（见文件头说明）：只为了让这张图在深色主题下也看得清
const svg = raw
  .replace(
    /(<svg[^>]*>)/,
    `$1\n  <!-- 以下背景层由 scripts/make-preview.mjs 添加：保证深色主题下也看得见 -->\n  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f6f8fb"/>`,
  )
  .replaceAll('fill="currentColor"', 'fill="#1f2937"')

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${svg}\n`, 'utf8')

const cells = Object.keys(terrain).length
console.log(`✓ 已生成 ${outFile}`)
console.log(
  `  ${cells} 格地形 · ${document.paths.length} 条路径 · ${document.regions.length} 个区域 · ` +
    `${document.markers.length} 个标记 · ${document.labels.length} 条文字`,
)

// 自检：只查"真会失效"的性质。示例写坏了不该悄悄生成一张空图或一张跑到画布外的图。
// （注意：不要写成"拿 terrainAt 再比一遍 terrain" —— 那是同义反复，永远不会失败。）
const problems = []
const ring = cellsInRadius(SEA_RADIUS).filter((cell) => hexDistance({ q: 0, r: 0 }, cell) === SEA_RADIUS)
if (!ring.every((cell) => terrain[cellKey(cell.q, cell.r)]?.t === 'water')) problems.push('最外圈不全是水')
if (terrain[cellKey(0, 0)]?.t !== 'volcanic') problems.push('岛心不是火山')

// 地形 ID 必须都是**合法的内置 ID**。
// 这条是补上的：我第一版写的是 grass / hill / volcano —— 那三个 ID 根本不存在，
// 导出时静默走了"未知地形"的回退配色（回退色也在调色板里，所以原来的调色板断言照样通过），
// 结果 README 上那张预览图的配色是错的，而且没有任何地方报错。
const kinds = new Set(Object.values(terrain).map((cell) => cell.t))
const unknown = [...kinds].filter((type) => !TERRAIN_TYPES.includes(type))
if (unknown.length > 0) problems.push(`用了不存在的地形 ID：${unknown.join(', ')}（合法值：${TERRAIN_TYPES.join('/')}）`)
if (kinds.size < 5) problems.push(`地形种类过少（${kinds.size} 种）`)
if (hexCorners(GRID, 0, 0).length !== 6) problems.push('六边形顶点数不是 6')
if (document.paths.length !== 3 || document.markers.length !== 4) problems.push('路径/标记数量与预期不符')

// 所有绘制坐标都要落在画布内：投影写坏时不会报错，只会把东西画到画布外（图看起来"空"）
const outside = []
for (const match of svg.matchAll(/(?:x|cx)="(-?[\d.]+)"/g)) {
  const value = Number(match[1])
  if (value < 0 || value > WIDTH) outside.push(match[0])
}
for (const match of svg.matchAll(/(?:y|cy)="(-?[\d.]+)"/g)) {
  const value = Number(match[1])
  if (value < 0 || value > HEIGHT) outside.push(match[0])
}
for (const match of svg.matchAll(/points="([^"]+)"/g)) {
  for (const pair of match[1].trim().split(/\s+/)) {
    const [x, y] = pair.split(',').map(Number)
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) outside.push(pair)
  }
}
if (outside.length > 0) problems.push(`有 ${outside.length} 个元素画到画布外，例如 ${outside.slice(0, 3).join(' ')}`)

const counts = {
  polygon: (svg.match(/<polygon /g) ?? []).length,
  polyline: (svg.match(/<polyline /g) ?? []).length,
  circle: (svg.match(/<circle /g) ?? []).length,
  text: (svg.match(/<text /g) ?? []).length,
}

// 图的"内容占比"：如果投影退化成把所有东西挤成一点或挤在角落，元素数和坐标检查都还是会通过，
// 但这张图是废的。所以量一下实际绘制范围。
const drawnX = []
const drawnY = []
for (const match of svg.matchAll(/points="([^"]+)"/g)) {
  for (const pair of match[1].trim().split(/\s+/)) {
    const [x, y] = pair.split(',').map(Number)
    drawnX.push(x)
    drawnY.push(y)
  }
}
const spanX = (Math.max(...drawnX) - Math.min(...drawnX)) / WIDTH
const spanY = (Math.max(...drawnY) - Math.min(...drawnY)) / HEIGHT
if (spanX < 0.4 || spanY < 0.3) problems.push(`内容占比过小（X ${(spanX * 100).toFixed(0)}% · Y ${(spanY * 100).toFixed(0)}%）`)

// 调色板必须与画布**同源**：`mapPreview.ts` 曾经自己抄了一份 TERRAIN_COLORS，9 种颜色与画布全不同，
// 表现是"缩略图/导出图的颜色和画布上不一样"。这里把"只能用调色板里的颜色"钉成断言。
const palette = new Set([...Object.values(TERRAIN_STYLES).map((style) => style.base), ...document.regions.map((region) => region.color)])
for (const match of svg.matchAll(/<polygon[^>]*fill="([^"]+)"/g)) {
  if (!palette.has(match[1])) problems.push(`地形/区域用了画布调色板以外的颜色 ${match[1]}`)
}

// 每种地形必须画成**各自的颜色**。
// 这条比"颜色在调色板里"更强：如果某个 ID 不存在，它会和别的未知 ID 一起落到同一个回退色上，
// 于是"地形种类数"会大于"实际出现的颜色数" —— 上一版的错误就是被这样藏住的。
const terrainKinds = new Set(Object.values(terrain).map((cell) => cell.t))
const regionColors = new Set(document.regions.map((region) => region.color))
const usedTerrainColors = new Set(
  [...svg.matchAll(/<polygon[^>]*fill="([^"]+)"/g)].map((match) => match[1]).filter((color) => !regionColors.has(color)),
)
if (usedTerrainColors.size !== terrainKinds.size) {
  problems.push(`地形 ${terrainKinds.size} 种，却只画出 ${usedTerrainColors.size} 种颜色（有 ID 落到了同一个回退色）`)
}
console.log(`  地形配色：${kinds.size} 种 · 实际画出 ${usedTerrainColors.size} 种颜色`)

console.log(`  元素：${JSON.stringify(counts)}`)
console.log(`  内容占比：X ${(spanX * 100).toFixed(0)}% · Y ${(spanY * 100).toFixed(0)}%`)
console.log(`  自检：${problems.length === 0 ? '全部通过' : problems.join('；')}`)
if (problems.length !== 0) process.exitCode = 1
