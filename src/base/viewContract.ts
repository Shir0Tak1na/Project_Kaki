/**
 * Base 视图的**契约常量**（不导入 obsidian，因此可被纯函数与单元测试直接使用）。
 *
 * 这里放的是"双方约定的字符串"：视图类型 id、视图选项 key、属性默认值。
 * `MapBasesView` 用它去读配置，`starterBase` 用它去生成 `.base` 文件 ——
 * 两边共用同一份常量，避免"生成的文件里的键名和代码里读的键名不一致"这类只会在真实环境暴露的错。
 */

/** 视图类型 id：`.base` 里的 `type:` 就是这个值 */
export const BASES_VIEW_TYPE = 'fictional-map'

/** 视图选项的 key（也是 `.base` YAML 里视图条目的键名） */
export const OPTION_KEYS = {
  mapFile: 'mapFile',
  coordProperty: 'coordProperty',
  typeProperty: 'typeProperty',
  regionProperty: 'regionProperty',
  sortBy: 'sortBy',
} as const

export type OptionKey = (typeof OPTION_KEYS)[keyof typeof OPTION_KEYS]

export const DEFAULT_COORD_PROPERTY = 'note.coordinates'
export const DEFAULT_TYPE_PROPERTY = 'note.map-type'
export const DEFAULT_REGION_PROPERTY = 'note.region'

/** 视图的排序选项（`sortBy` 下拉框的取值 → 显示名） */
export const SORT_OPTIONS: Record<string, string> = {
  name: '名称',
  kind: '类型',
  source: '来源',
  x: 'X 坐标',
  y: 'Y 坐标',
}

/** 可以当坐标属性用的属性 id 前缀（`note.` / `formula.` 都允许） */
export const PROPERTY_PREFIXES = ['note.', 'formula.'] as const

/**
 * `file` 选项的过滤函数：只允许选 Markdown 文件。
 *
 * 刻意**不**收紧到 `.map.md`：用户完全可以把地图文档命名成别的样子
 * （插件只在创建时给默认名）。选错了会在视图里给出"无法解析"的明确提示，
 * 而不是让候选列表空着、让人以为功能坏了。
 */
export function isMapDocumentLike(file: { path?: string; extension?: string }): boolean {
  if (file.extension === 'md') return true
  const path = typeof file.path === 'string' ? file.path : ''
  return path.toLowerCase().endsWith('.md')
}
