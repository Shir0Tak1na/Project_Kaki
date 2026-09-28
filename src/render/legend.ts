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
import { DEFAULT_ELEVATION_CALIBRATION } from './elevationUnits.ts'
import { isLayerVisible, type LayerKey, type LayerVisibility } from './layerVisibility.ts'
import {
  DEFAULT_OVERLAY_STYLES,
  OVERLAY_FIELDS,
  formatFieldReading,
  overlayUnitSuffix,
  overlayUnitTitle,
  type OverlayFieldSpec,
  type OverlayStyles,
} from './overlayFields.ts'
import { colorForValue, type ColorStop } from './colorRamp.ts'

/** 色带条目要画的渐变（UI 直接拿它做 `linear-gradient`）：锚点 + 两端越界纯色 */
export interface LegendRampInfo {
  /** 渐变条上的锚点（值 + 颜色），UI 按值把位置归一化到 0–100% */
  stops: ColorStop[]
  /** 低于最低锚点时用的纯色 */
  underColor: string
  /** 高于最高锚点时用的纯色 */
  overColor: string
  /** 单位后缀（℃ / m），给刻度文字用 */
  unit: string
  /** 最低 / 最高锚点的值，UI 显示成「-30℃ … 45℃」 */
  min: number
  max: number
  /**
   * 两端**已经格式化好的**刻度文字（含单位）。
   *
   * 为什么由这里算而不是让 UI 拼 `min + unit`：深度的刻度要按**展示单位**换算
   * （`-4000 m` / `-4 km` / `0.33`），而"值怎么显示成字"的唯一入口是字段表里的 `format`
   * —— UI 那边拼字符串就又是一份会漂移的实现（本项目的老毛病，见 §5.9）。
   */
  minLabel: string
  maxLabel: string
}

export interface LegendEntry {
  kind: 'terrain' | 'path' | 'region' | 'ramp'
  /** 图例上显示的短标签（地形名 / 路径类型名 / 区域名 / 数据层名） */
  label: string
  color: string
  /** 地图上用了多少次（地形=格数，路径=条数，区域=个数，色带=有值的格数） */
  count: number
  /** 虚线样式（仅路径），让图例能区分道路与河流 */
  dash?: number[]
  /** 色带条目（仅 `kind: 'ramp'`）：怎么画那条渐变 */
  ramp?: LegendRampInfo
  /** 色带条目：有多少格落在色带之外（**只在真的有**的时候出现） */
  outOfRange?: { under: number; over: number }
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
  /**
   * 数据层（温度 / 深度…）的样式（色带 / 越界两端）。
   *
   * 缺省即出厂样式 —— 图例只是"给人看的清单"，拿不到设置时宁可按出厂画一条，
   * 也不要静默少一栏（那会让人以为"地图上根本没有温度"）。
   */
  overlayStyles?: OverlayStyles
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
  const terrainSection = (): void => {
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
  const pathSection = (): void => {
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
  const regionSection = (): void => {
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

  /**
   * 数据层（温度 / 深度…）：一条**色带** + 有值的格数 + 只在真有越界格时才出现的两端。
   *
   * 与别的段同一口径：**扫地图**（只看有值的格），所以"图例里有温度、地图上却没数据"这种矛盾不会出现。
   * 越界计数与画布同源（同一个 `colorForValue`）—— 这里绝不另写一套"值比大小"的比较。
   */
  const overlaySection = (spec: OverlayFieldSpec): void => {
    const style = (deps.overlayStyles ?? DEFAULT_OVERLAY_STYLES)[spec.id]
    let count = 0
    let under = 0
    let over = 0
    for (const cell of Object.values(document.terrain)) {
      const value = spec.read(cell)
      if (value === undefined) continue
      count += 1
      const color = colorForValue(value, style.ramp)
      if (color === null) continue
      if (color.outOfRange === 'under') under += 1
      else if (color.outOfRange === 'over') over += 1
    }
    if (count === 0) return
    const stops = style.ramp.stops
    const first = stops[0]!
    const last = stops[stops.length - 1]!
    // 读数与刻度都走字段自己的格式化（深度按展示单位换算，标定从地图文件现取）
    const calibration = document.elevation ?? DEFAULT_ELEVATION_CALIBRATION
    const suffix = overlayUnitSuffix(spec, style)
    const tick = (value: number): string => `${formatFieldReading(spec, value, style, calibration)}${suffix}`
    const unitTitle = overlayUnitTitle(spec, style)
    const entry: LegendEntry = {
      kind: 'ramp',
      label: unitTitle.length > 0 ? `${spec.label}（${unitTitle}）` : spec.label,
      // 色带条目的 `color` 是"这一栏的主色"（文字输出用）：取正中的锚点
      color: stops[Math.floor(stops.length / 2)]!.color,
      count,
      ramp: {
        stops: stops.map((stop) => ({ ...stop })),
        underColor: style.ramp.under.color,
        overColor: style.ramp.over.color,
        unit: unitTitle,
        min: first.value,
        max: last.value,
        minLabel: tick(first.value),
        maxLabel: tick(last.value),
      },
    }
    // 越界两项**只在真的有越界格时**才出现（同"图例只列实际有的东西"的口径）
    if (under > 0 || over > 0) entry.outOfRange = { under, over }
    entries.push(entry)
  }

  /**
   * 每一段归属哪一层。
   *
   * 图例是"给人看的清单"，**关掉那一层就不该再列它** —— 否则用户拿着图例找不着画上的东西。
   * 段与层的对应写在这张表里（而不是每段各抄一遍三层 if）：加一层、改一层的名字都不用来这里。
   *
   * 顺序 = **画布上的叠加次序**：地形 → 数据层（温度 / 深度…）→ 路径 → 区域。
   */
  const sections: Array<{ layer: LayerKey; build: () => void }> = [
    { layer: 'terrain', build: terrainSection },
    ...OVERLAY_FIELDS.map((spec) => ({
      layer: spec.layerId,
      build: () => overlaySection(spec),
    })),
    { layer: 'paths', build: pathSection },
    { layer: 'regions', build: regionSection },
  ]
  for (const section of sections) {
    if (visibility !== undefined && !isLayerVisible(visibility, section.layer)) continue
    section.build()
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

/**
 * 把色带条目变成一条 CSS 渐变（图例用它画那条带）。
 *
 * 位置按**值**归一化，而不是按锚点序号平均分：锚点值不均匀时（出厂是 -30/0/15/30/45），
 * 渐变的疏密也跟着不均匀 —— 这正是"渐变率就是相邻锚点的斜率"的可视化。
 * 越界两端**不混进渐变**（它们是纯色，单独用小色块表示），否则会让人以为"超出上限也会渐变过去"。
 */
export function rampGradientCss(info: LegendRampInfo): string {
  const stops = info.stops
  if (stops.length === 0) return ''
  const span = info.max - info.min
  const parts = stops.map((stop) => {
    const position = span === 0 ? 0 : (stop.value - info.min) / span
    return `${stop.color} ${(position * 100).toFixed(2)}%`
  })
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/** 一行图例文本（命令输出与故障排查用；渲染到画布上的版本由 UI 负责） */
export function legendLines(entries: readonly LegendEntry[], maxEntries = 24): string[] {
  return entries.slice(0, maxEntries).map((entry) => {
    if (entry.kind === 'ramp') {
      // 色带条目不是一个"用了多少次的类型"：报范围、有值格数与越界格数才是有用的信息
      const range = entry.ramp ? `${entry.ramp.minLabel}~${entry.ramp.maxLabel}` : ''
      const out = entry.outOfRange ? `，越界 低 ${entry.outOfRange.under} / 高 ${entry.outOfRange.over}` : ''
      return `数据层 · ${entry.label} · ${range} · 有值 ${entry.count} 格${out}`
    }
    const kind = entry.kind === 'terrain' ? '地形' : entry.kind === 'path' ? '路径' : '区域'
    return `${kind} · ${entry.label} · ${entry.color} · ${entry.count}`
  })
}
