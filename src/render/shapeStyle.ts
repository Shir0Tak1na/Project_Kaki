/**
 * 路径与区域的默认样式 —— 纯数据模块。
 *
 * 与地形样式同样的思路：把"用什么颜色、多宽、是否虚线"定义成数据，
 * 绘制层只负责解释，工具栏与对话框直接复用同一份定义。
 */

import type { PathType } from '../data/mapDocument.ts'

export interface PathStyle {
  type: PathType
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
}

export const PATH_STYLES: Record<PathType, PathStyle> = {
  river: { type: 'river', label: '河流', color: '#4a9fd8', width: 8, taper: true, smooth: true },
  road: { type: 'road', label: '道路', color: '#b08968', width: 5, dash: [14, 10] },
  'trade-route': { type: 'trade-route', label: '贸易路线', color: '#c9a227', width: 4, dash: [4, 8] },
  border: { type: 'border', label: '边界', color: '#b3452f', width: 4, dash: [20, 8, 4, 8] },
}

export function getPathStyle(type: PathType): PathStyle {
  return PATH_STYLES[type]
}

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
