/**
 * 路径与区域的默认样式 —— 纯数据模块。
 *
 * 与地形样式同样的思路：把"用什么颜色、多宽、是否虚线"定义成数据，
 * 绘制层只负责解释，工具栏与对话框直接复用同一份定义。
 */

import type { BuiltinPathType, PathCapStyle, PathJoinStyle } from '../data/mapDocument.ts'

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

/** 区域填充色（低透明度使用，因此取饱和度适中、明度偏高的颜色） */
export const REGION_PRESETS: RegionPreset[] = [
  { label: '王国', color: '#44cf6e' },
  { label: '帝国', color: '#c94f4f' },
  { label: '公国', color: '#a882ff' },
  { label: '教区', color: '#e0de71' },
  { label: '荒原', color: '#8b8b8b' },
  { label: '海域', color: '#4a9fd8' },
]

export const DEFAULT_REGION_OPACITY = 0.22
export const DEFAULT_REGION_BORDER_WIDTH = 3

export function defaultRegionColor(): string {
  return REGION_PRESETS[0]!.color
}
