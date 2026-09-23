/**
 * 图层可见性：地形 / 网格 / 区域 / 路径 / 标记 / 文字。
 *
 * 两条设计边界（都写在这里，避免以后被"顺手"破坏）：
 *
 * 1. **图层状态属于插件设置，绝不写进地图几何数据**。
 *    地图文件（`.map.md`）描述的是"世界上有什么"，图层开关描述的是"我现在想看到什么"。
 *    把后者写进前者，等于换个显示方式就改了用户的数据 —— 而且会污染 Git diff。
 * 2. **图层是纯数据 + 纯函数**，渲染层只读它。于是"隐藏某层到底该不该少画东西"
 *    可以脱离 Obsidian 单测，而不是靠肉眼看画布。
 */

export const LAYER_KEYS = ['terrain', 'grid', 'regions', 'paths', 'markers', 'labels'] as const

export type LayerKey = (typeof LAYER_KEYS)[number]

export type LayerVisibility = Record<LayerKey, boolean>

/** 面板/设置/命令里显示用的中文名（顺序与 `LAYER_KEYS` 一致） */
export const LAYER_LABELS: Record<LayerKey, string> = {
  terrain: '地形',
  grid: '网格',
  regions: '区域',
  paths: '路径',
  markers: '标记',
  labels: '名称',
}

export const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  terrain: true,
  grid: true,
  regions: true,
  paths: true,
  markers: true,
  labels: true,
}

/**
 * 把任意输入收敛成完整的图层开关表。
 *
 * 缺项按**出厂默认（显示）**补齐，而不是按"false"：用户手工改坏 data.json 时，
 * 宁可他看到东西多，也不要让他面对一张空白地图却不知道为什么。
 */
export function normalizeLayerVisibility(raw: unknown): LayerVisibility {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as LayerVisibility
  for (const key of LAYER_KEYS) {
    const value = source[key]
    out[key] = typeof value === 'boolean' ? value : DEFAULT_LAYER_VISIBILITY[key]
  }
  return out
}

/**
 * 从旧设置迁移：本插件早期只有 `showGrid` 一个开关，且 `showGrid=false` 表示**隐藏网格**。
 * 迁移时保留用户的选择，其余层按默认显示。
 */
export function layerVisibilityFromLegacy(raw: unknown): LayerVisibility {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const visibility = normalizeLayerVisibility(source.layers)
  if (typeof source.showGrid === 'boolean' && source.layers === undefined) {
    visibility.grid = source.showGrid
  }
  return visibility
}

export function isLayerVisible(visibility: LayerVisibility, key: LayerKey): boolean {
  return visibility[key] !== false
}

/** 返回一份新对象（不原地改，便于"设置变更 → 请求重绘"的比较与撤销语义清晰） */
export function withLayerVisibility(visibility: LayerVisibility, key: LayerKey, value: boolean): LayerVisibility {
  if (visibility[key] === value) return visibility
  return { ...visibility, [key]: value }
}

/** 当前被隐藏的图层名（给状态命令输出用，让"地图怎么少了东西"有一个可查的答案） */
export function hiddenLayerLabels(visibility: LayerVisibility): string[] {
  return LAYER_KEYS.filter((key) => !isLayerVisible(visibility, key)).map((key) => LAYER_LABELS[key])
}

/** 是否全部隐藏（用于给出"你把所有图层都关了"这种可读提示） */
export function allLayersHidden(visibility: LayerVisibility): boolean {
  return LAYER_KEYS.every((key) => !isLayerVisible(visibility, key))
}
