/**
 * 路径与区域的默认样式 —— 纯数据模块。
 *
 * 与地形样式同样的思路：把"用什么颜色、多宽、是否虚线"定义成数据，
 * 绘制层只负责解释，工具栏与对话框直接复用同一份定义。
 */

import type { BuiltinPathType, BuiltinRegionType, PathCapStyle, PathJoinStyle } from '../data/mapDocument.ts'
import { BUILTIN_REGION_TYPES } from '../data/mapDocument.ts'

export interface PathStyle {
  type: string
  label: string
  color: string
  /** 世界单位 */
  width: number
  /** 虚线（世界单位），仅道路/边界使用 */
  dash?: number[]
  /** 河流末端变细 */
  taper?: boolean
  /** 用平滑曲线而不是折线 */
  smooth?: boolean
  /**
   * 端点 / 连接样式。缺省 = 绘制层用 `round`（升级前硬编码的值），
   * 于是"没写这两个字段的旧数据"渲染结果与升级前完全一致。
   */
  cap?: PathCapStyle
  join?: PathJoinStyle
}

/**
 * 内置 4 种的出厂样式。
 *
 * 键类型是 `BuiltinPathType`（不是放宽后的 `PathType`）：这样"查一张没有的表"在编译期就过不去，
 * 而自定义/未知类型走 `pathTypeCatalog.resolvePathType()` —— 也就是唯一那处回退逻辑。
 */
export const PATH_STYLES: Record<BuiltinPathType, PathStyle> = {
  river: { type: 'river', label: '河流', color: '#4a9fd8', width: 8, taper: true, smooth: true },
  road: { type: 'road', label: '道路', color: '#b08968', width: 5, dash: [14, 10] },
  'trade-route': { type: 'trade-route', label: '贸易路线', color: '#c9a227', width: 4, dash: [4, 8] },
  border: { type: 'border', label: '边界', color: '#b3452f', width: 4, dash: [20, 8, 4, 8] },
}

export function getPathStyle(type: BuiltinPathType): PathStyle {
  return PATH_STYLES[type]
}

/**
 * 端点 / 连接样式的默认值 = **升级前 `drawPath()` 里硬编码的值**。
 *
 * 这两条常量是"旧地图渲染逐像素不变"的依据：缺 `cap` / `join` 的旧路径在绘制层取它们，
 * 于是结果与升级前完全一致。改动它们等于改动所有老地图的观感，不要随手改。
 */
export const DEFAULT_PATH_CAP: PathCapStyle = 'round'
export const DEFAULT_PATH_JOIN: PathJoinStyle = 'round'

export interface RegionPreset {
  label: string
  color: string
}

/**
 * 区域填充色（低透明度使用，因此取饱和度适中、明度偏高的颜色）。
 *
 * ⚠️ 这是区域**出厂颜色与显示名**的唯一一份数据：内置区域类型的 id 表（见下）
 * 按同样的顺序与它一一对应，`regionTypeCatalog.factoryRegionTypeParams()` 也从这里取色。
 * 想改内置区域的出厂色，只改这里 —— 在别处再抄一份就是本项目出过真事故的那种写法
 * （曾经抄过一份调色板，结果缩略图与画布颜色全不一样）。
 */
export const REGION_PRESETS: RegionPreset[] = [
  { label: '王国', color: '#44cf6e' },
  { label: '帝国', color: '#c94f4f' },
  { label: '公国', color: '#a882ff' },
  { label: '教区', color: '#e0de71' },
  { label: '荒原', color: '#8b8b8b' },
  { label: '海域', color: '#4a9fd8' },
]

/**
 * 内置区域类型的 ID（顺序 = `REGION_PRESETS` 的顺序 = 工具条下拉与图例的顺序）。
 *
 * ⚠️ id 表本身在 `data/mapDocument.ts`（与 `PATH_TYPES` 同一个位置）：解析层要据此判断
 * "认不认识这个 ID"。类型名直接从那张表推导，于是两处不可能对不上。
 *
 * 为什么 id 不是颜色、也不是中文名：id 是**写进地图文件** `regions[].type` 的值，
 * 与显示名解耦；用颜色当 ID 的话，用户改一次颜色就会让所有已画区域变成"未知类型"。
 */
export type { BuiltinRegionType } from '../data/mapDocument.ts'

/**
 * 内置区域类型的出厂显示名与颜色 —— 与 `REGION_PRESETS` 按下标对应。
 *
 * 中文名与颜色的定义处只有 `REGION_PRESETS` 一处，这里只做 id 与它的对齐。
 * `REGION_PRESETS` 的长度必须 ≥ id 表长度，由 `tests/regionTypeCatalog.test.ts` 钉死。
 */
export const REGION_TYPE_STYLES: Record<BuiltinRegionType, RegionPreset> = Object.fromEntries(
  BUILTIN_REGION_TYPES.map((id, index) => {
    const preset = REGION_PRESETS[index] ?? { label: id, color: '#8b8b8b' }
    return [id, { label: preset.label, color: preset.color }]
  }),
) as Record<BuiltinRegionType, RegionPreset>

/** 升级前的区域默认值：半透明填充 + 3 单位边界，边界色跟随填充色 */
export const DEFAULT_REGION_OPACITY = 0.22
export const DEFAULT_REGION_BORDER_WIDTH = 3

/** 新画区域时的默认类型（= 升级前工具条的第一个色块「王国」） */
export const DEFAULT_REGION_TYPE_ID: BuiltinRegionType = BUILTIN_REGION_TYPES[0]

export function defaultRegionColor(): string {
  return REGION_PRESETS[0]!.color
}
