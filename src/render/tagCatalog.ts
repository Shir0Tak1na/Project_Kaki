/**
 * **标签词表**（全库唯一来源）—— 地形与生物群系**共用同一批标签 ID**。
 *
 * ## 为什么要独立成一个模块
 *
 * `biomeCatalog.ts` 要用 `terrainCatalog.ts` 的 `CUSTOM_TERRAIN_PREFIX`；若地形反过来
 * `import` 群系那一张标签表，两边就成环。词表放在**中立**模块里（本文件不 import 任何东西），
 * 两个目录都只依赖它 —— 于是"水域"这件事在两边只有一个定义（`aquatic`），筛选器里一个词
 * 管到底（用户口径：地形标签与群系标签**共用同一批 ID**）。
 *
 * ## 与 Minecraft 的关系（为什么是"标签"而不是"分类字段"）
 *
 * Minecraft 1.19 把群系的 `category` 字段**删掉**、把归类整体移到标签，理由是
 * 一个东西常同时属于多个组（山地森林既是 temperate 又是 forest 又是 mountain）。
 * 地形同理：沼泽既是"水域"又是"湿地"，一个枚举字段表达不了。
 *
 * ## 稳定性（改这张表之前先读）
 *
 * 标签 ID 会写进**插件设置**与**定义文件**（`customTerrains[].tags` / `customBiomes[].tags`），
 * 一旦发出去就**不可改 ID**（要改只能"加新 ID + 迁移"）。显示名（`label`）与分组（`group`）
 * 只是界面文案，随时可以改。
 *
 * ## `kinds`：一条标签对谁有意义
 *
 * - 层位（`surface` / `underground` / `sky`）只对生物群系有意义 —— 一格地形谈不上"地下"；
 * - `volcanic` 只对地形有意义（群系那一侧的分类表 `BIOMES.md` §1 已定稿，不因这次改动而变）。
 *
 * 于是两边的下拉各自只列**自己那批**，而**共用的那批 ID 在两边是同一个词**。
 */

/** 标签对谁有意义 */
export type TagKind = 'terrain' | 'biome'

export interface TagDef {
  /** 稳定 ID（写进设置与定义文件，**不可改**） */
  id: string
  /** 显示名（中文；改它不影响已存数据） */
  label: string
  /** 界面下拉里的分组前缀（`气候·极地`） */
  group: string
  /** 这一条对谁有意义（两个都写 = 两边共用） */
  kinds: readonly TagKind[]
}

/**
 * 全部标签。
 *
 * ⚠️ **前 23 条的顺序不能动**：它同时是生物群系那一侧下拉的显示顺序
 * （`BIOME_TAGS` 就是这份表按 `kinds` 过滤的结果），改顺序会让界面顺序无理由地变。
 * 地形专有的那几条排在最后。
 */
export const TAG_DEFS: readonly TagDef[] = [
  // ---- 层位（只对生物群系有意义）----
  { id: 'surface', label: '地表', group: '层位', kinds: ['biome'] },
  { id: 'underground', label: '地下', group: '层位', kinds: ['biome'] },
  { id: 'sky', label: '高空', group: '层位', kinds: ['biome'] },
  // ---- 气候 ----
  { id: 'polar', label: '极地', group: '气候', kinds: ['biome', 'terrain'] },
  { id: 'boreal', label: '寒温带', group: '气候', kinds: ['biome'] },
  { id: 'temperate', label: '温带', group: '气候', kinds: ['biome'] },
  { id: 'mediterranean', label: '地中海', group: '气候', kinds: ['biome'] },
  { id: 'subtropical', label: '亚热带', group: '气候', kinds: ['biome'] },
  { id: 'tropical', label: '热带', group: '气候', kinds: ['biome'] },
  { id: 'arid', label: '干旱', group: '气候', kinds: ['biome', 'terrain'] },
  { id: 'alpine', label: '高山', group: '气候', kinds: ['biome', 'terrain'] },
  // ---- 植被 ----
  { id: 'forest', label: '森林', group: '植被', kinds: ['biome', 'terrain'] },
  { id: 'grassland', label: '草原', group: '植被', kinds: ['biome', 'terrain'] },
  { id: 'shrub', label: '灌木', group: '植被', kinds: ['biome', 'terrain'] },
  { id: 'desert', label: '荒漠', group: '植被', kinds: ['biome', 'terrain'] },
  { id: 'wetland', label: '湿地', group: '植被', kinds: ['biome', 'terrain'] },
  // ---- 特殊 ----
  { id: 'artificial', label: '人工', group: '特殊', kinds: ['biome'] },
  { id: 'aquatic', label: '水域', group: '特殊', kinds: ['biome', 'terrain'] },
  { id: 'nether', label: '地狱', group: '特殊', kinds: ['biome'] },
  { id: 'ore', label: '矿脉', group: '特殊', kinds: ['biome'] },
  { id: 'mountain', label: '山地', group: '特殊', kinds: ['biome', 'terrain'] },
  { id: 'dry', label: '干燥', group: '特殊', kinds: ['biome'] },
  { id: 'wet', label: '潮湿', group: '特殊', kinds: ['biome', 'terrain'] },
  // ---- 地形专有（群系那一侧的分类表已定稿，不因这次改动而变）----
  { id: 'volcanic', label: '火山', group: '特殊', kinds: ['terrain'] },
]

/** 某一侧用得上的那批标签（顺序 = `TAG_DEFS` 的顺序） */
export function tagsFor(kind: TagKind): readonly TagDef[] {
  return TAG_DEFS.filter((tag) => tag.kinds.includes(kind))
}

/** 按 ID 取一条标签（取不到返回 `null`） */
export function tagDefOf(id: string): TagDef | null {
  return TAG_DEFS.find((tag) => tag.id === id) ?? null
}

/**
 * 标签的显示名（不认识的标签**原样显示** ID）。
 *
 * 为什么原样显示：标签 ID 会出现在别的库导出的定义文件里，而本机的词表未必有它 ——
 * 显示成空白会让用户以为"这条标签是空的"，显示 ID 至少能看出是哪一条（§5.11 同一条口径）。
 */
export function tagLabelOf(id: string): string {
  return tagDefOf(id)?.label ?? id
}

/** 这个 ID 在**这一侧**是不是一个认识的内置标签 */
export function isKnownTagFor(kind: TagKind, id: string): boolean {
  const def = tagDefOf(id)
  return def !== null && def.kinds.includes(kind)
}

/**
 * 把一组原始输入收敛成合法的标签集（**这一侧认识的那些**，去重、保序）。
 *
 * 不认识 / 不是给这一侧用的标签**直接丢掉**（而不是让整条定义作废）：标签是**辅助信息**，
 * 不是用户在地图上画的数据 —— 为一个多出来的词丢掉一整条自定义地形，
 * 代价远大于收益。显式写入（设置页 / 定义文件导入）那一侧另有 `validate*` 会**拒绝并说明**。
 */
export function normalizeTagsFor(kind: TagKind, raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!isKnownTagFor(kind, tag)) continue
    if (!out.includes(tag)) out.push(tag)
  }
  return out
}