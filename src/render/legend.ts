/**
 * 图例：从**地图上实际有的东西**生成条目，而不是抄一份写死的清单。
 *
 * 为什么强调这一点：静态图例与渲染很快就会分叉 —— 用户自定义了地形颜色、
 * 某张地图压根没用沙漠、路径类型改过色，静态表就会写错，而写错的图例比没有图例更坏
 * （它让人以为地图是错的）。所以这里一律"扫地图 + 问样式解析器"。
 *
 * 依赖用**注入的函数**而不是直接 import 具体模块：
 * - 地形可能是内置的 9 种，也可能是用户自定义的 ID（见 `terrainCatalog.ts`），
 *   解析规则归那边管，这里只问"这个 ID 长什么样"；
 * - 于是本模块是纯函数，可以脱离 Obsidian 与设置单测。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import { PATH_TYPES, TERRAIN_TYPES } from '../data/mapDocument.ts'
import { isLayerVisible, type LayerVisibility } from './layerVisibility.ts'

export interface LegendEntry {
  kind: 'terrain' | 'path' | 'region'
  /** 图例上显示的短标签（地形名 / 路径类型名 / 区域名） */
  label: string
  color: string
  /** 地图上用了多少次（地形=格数，路径=条数，区域=个数） */
  count: number
  /** 虚线样式（仅路径），让图例能区分道路与河流 */
  dash?: number[]
}

export interface LegendDeps {
  /** 地形 ID → 样式（内置或用户自定义，由 terrainCatalog 决定） */
  resolveTerrain: (type: string) => { label: string; color: string }
  /** 路径类型 → 样式（内置、自定义、未知都由 `pathTypeCatalog` 决定） */
  resolvePath: (type: string) => { label: string; color: string; dash?: number[] }
  /**
   * 区域 → 显示名。
   *
   * 参数是**两个**而不是一个：`type` 是新数据（可能有），`color` 是旧数据的身份
   * （升级前的区域没有类型字段）。解析器自己决定先看哪个 ——
   * 图例这里只负责把两者都递过去，不替它猜。
   */
  resolveRegion: (color: string, type: string) => { label: string }
}

/**
 * 生成图例条目。
 *
 * 排序刻意是**确定的**（内置顺序优先、其余按字母/颜色）：
 * 图例每次重绘都换顺序会让人以为地图变了，测试也没法钉住。
 */
export function buildLegendEntries(
  document: MapDocument | null,
  deps: LegendDeps,
  visibility?: LayerVisibility,
): LegendEntry[] {
  if (!document) return []
  const entries: LegendEntry[] = []

  // ---- 地形：按格数 ----
  if (visibility === undefined || isLayerVisible(visibility, 'terrain')) {
    const counts = new Map<string, number>()
    for (const cell of Object.values(document.terrain)) {
      const type = typeof cell?.t === 'string' ? cell.t : ''
      if (type.length === 0) continue
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    for (const type of sortTerrainTypes([...counts.keys()])) {
      const style = deps.resolveTerrain(type)
      entries.push({ kind: 'terrain', label: style.label, color: style.color, count: counts.get(type) ?? 0 })
    }
  }

  // ---- 路径：内置 4 种按 PATH_TYPES 的出厂顺序，其余（自定义 / 未知）按字母序排在后面 ----
  if (visibility === undefined || isLayerVisible(visibility, 'paths')) {
    const counts = new Map<string, number>()
    for (const path of document.paths) {
      const type = typeof path?.type === 'string' ? path.type : ''
      if (type.length === 0) continue
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    for (const type of sortPathTypes([...counts.keys()])) {
      const count = counts.get(type) ?? 0
      if (count === 0) continue
      const style = deps.resolvePath(type)
      const entry: LegendEntry = { kind: 'path', label: style.label, color: style.color, count }
      if (style.dash && style.dash.length > 0) entry.dash = [...style.dash]
      entries.push(entry)
    }
  }

  // ---- 区域：有类型就按类型归并，没有类型（升级前画的）就按颜色归并 ----
  //
  // 为什么保留"按颜色"这条路：老地图的区域里没有 `type` 字段，颜色就是它的身份，
  // 而升级前正是这么归并的 —— 于是同一张老地图的图例**一字不变**。
  // 归并键带上颜色（而不是只用类型）：两个类型被设成同一个颜色时，
  // 只用类型做键会把两条不同颜色的事实压成一行，图例会开始说谎。
  if (visibility === undefined || isLayerVisible(visibility, 'regions')) {
    const counts = new Map<string, { color: string; type: string; count: number }>()
    for (const region of document.regions) {
      const color = typeof region.color === 'string' && region.color.length > 0 ? region.color : '#7ab77b'
      const type = typeof region.type === 'string' ? region.type : ''
      const key = `${type}::${color}`
      const found = counts.get(key)
      if (found) found.count += 1
      else counts.set(key, { color, type, count: 1 })
    }
    for (const key of [...counts.keys()].sort()) {
      const item = counts.get(key)!
      entries.push({
        kind: 'region',
        label: deps.resolveRegion(item.color, item.type).label,
        color: item.color,
        count: item.count,
      })
    }
  }

  return entries
}

/**
 * 地形类型的展示顺序：内置的按 `TERRAIN_TYPES` 的出厂顺序（用户熟悉的顺序）,
 * 自定义的排在后面按 ID 字母序 —— 于是图例顺序稳定，且新增自定义地形不会打乱内置项。
 *
 * ⚠️ 顺序取自 `TERRAIN_TYPES` 而不是在这里再抄一份：本项目已经因为"抄一份调色板"
 * 出过一次真事故（缩略图与画布颜色全不同），同类错误不想再犯第二次。
 */
function sortTerrainTypes(types: string[]): string[] {
  const builtinOrder = TERRAIN_TYPES as readonly string[]
  return [...types].sort((a, b) => {
    const indexA = builtinOrder.indexOf(a)
    const indexB = builtinOrder.indexOf(b)
    if (indexA >= 0 && indexB >= 0) return indexA - indexB
    if (indexA >= 0) return -1
    if (indexB >= 0) return 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * 路径类型的展示顺序：内置 4 种的出厂顺序在前（用户熟悉的顺序），
 * 其余（自定义类型、别的版本写的未知类型）按 ID 字母序排在后面。
 *
 * 为什么不再"只遍历 `PATH_TYPES`"：自定义类型从 ⑤-1 起是一等公民，
 * 只遍历内置会让图例**漏掉**用户自己建的类型 —— 而图例漏项比顺序错更糟
 * （用户会以为自己画的那条路没画上）。顺序仍然确定，测试可以钉住。
 */
function sortPathTypes(types: string[]): string[] {
  const builtinOrder = PATH_TYPES as readonly string[]
  return [...types].sort((a, b) => {
    const indexA = builtinOrder.indexOf(a)
    const indexB = builtinOrder.indexOf(b)
    if (indexA >= 0 && indexB >= 0) return indexA - indexB
    if (indexA >= 0) return -1
    if (indexB >= 0) return 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** 一行图例文本（命令输出与故障排查用；渲染到画布上的版本由 UI 负责） */
export function legendLines(entries: readonly LegendEntry[], maxEntries = 24): string[] {
  return entries.slice(0, maxEntries).map((entry) => {
    const kind = entry.kind === 'terrain' ? '地形' : entry.kind === 'path' ? '路径' : '区域'
    return `${kind} · ${entry.label} · ${entry.color} · ${entry.count}`
  })
}
