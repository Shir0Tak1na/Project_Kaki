/**
 * 生物群系的**目录工厂 + 分类表 + 标签表** —— 纯函数模块（不 import obsidian）。
 *
 * 依据：施工文件 `DATA-LAYER-PLAN-v5.md` §D 与分类表 `docs/BIOMES.md`。
 *
 * ## 三条写死的决定（`BIOMES.md` §3）
 *
 * 1. **内置 ID 不加 `biome:` 前缀**：值的空间**只属于 `biome` 这一个字段**，不撞名；
 *    与仓库既有约定一致（内置地形/标记/路径/区域都是裸 ID，只有用户自定义才带 `custom:`）。
 * 2. **照顾筛选器的是「标签」，不是前缀**：34 个值逐个勾 → 按 8 组标签挑几个，
 *    而且允许**一对多**（"所有森林类"= 一个标签命中 7 条）。照 Minecraft 1.19 的做法
 *    （它正是**删掉了群系的 `category` 字段、把归类整体移到标签**：一个群系常同时属于多个组）。
 * 3. **配色「每条自带颜色 + 组内默认 + 可逐条覆盖」**：颜色存在**目录**里（不进 `biome` 值本身），
 *    于是"换一份分类表 = 换一批条目（含颜色）"不需要改代码。
 *
 * ## 稳定性
 *
 * 这些 ID 一旦发出去就写进用户的 `.map.md`，**不可改**（要改名只能"加新 ID + 迁移"，
 * 迁移机制已存在）。认不出的 ID 一律**原样保留**（§5.11），只由绘制层回退视觉。
 *
 * ## 不在目录里的东西
 *
 * `BIOMES.md` §1.4 的**待定 3 条**（海洋 / 复合型湿地 / 特殊地貌）**刻意不注册** ——
 * 注册了它们，笔刷 / 筛选器 / 图例就会把"还没定"当成"已定"。§2 也写明：
 * 「失乐园」「砂时间」「微光海」那类**地物不是生物群系**，不许塞进 `biome`。
 */

import { CUSTOM_TERRAIN_PREFIX } from './terrainCatalog.ts'
import { isKnownTagFor, tagLabelOf, tagsFor, type TagDef } from './tagCatalog.ts'

/** 用户自定义生物群系的 ID 前缀（与地形 / 标记 / 路径类型 / 区域类型共用同一套约定） */
export const CUSTOM_BIOME_PREFIX = CUSTOM_TERRAIN_PREFIX

/** 自定义生物群系的数量上限（与其它几类定义一致：够用，且不让界面失控） */
export const MAX_CUSTOM_BIOMES = 64

/**
 * 生物群系用得上的那批标签 —— 从**共用词表**里取（`render/tagCatalog.ts`）。
 *
 * 为什么不再在本文件里写一份：地形也要标签，而"水域"在两边必须是**同一个词**
 * （用户口径：两边共用同一批标签 ID）。词表放中立模块，两个目录都只依赖它 ——
 * 顺带避开"地形 ← 群系 ← 地形"的循环 import。
 *
 * ⚠️ **这批的顺序就是下拉里的显示顺序**（层位 → 气候 → 植被 → 特殊），改动会让界面顺序变。
 */
export const BIOME_TAGS: readonly TagDef[] = tagsFor('biome')

/** 标签的显示名（不认识的标签原样显示 —— 别的库写的自定义标签不该变成空白） */
export function biomeTagLabel(id: string): string {
  return tagLabelOf(id)
}

/** 目录里的一个生物群系：稳定 ID + 显示名 + 标签集 + 自己的颜色 */
export interface BiomeEntry {
  /** 稳定 ID（内置是裸 slug，自定义带 `custom:`）—— **就是写进地图文件的 `biome` 值** */
  id: string
  /** 显示名（中文；改它不影响已存数据） */
  label: string
  /** 标签集（筛选器按标签一次命中一组） */
  tags: readonly string[]
  /** 这个群系自己的颜色（`BIOMES.md` §3 决定三：每条自带，而不是由大类推） */
  color: string
}

/** 用户自定义生物群系（存在插件设置里，不进地图文件） */
export interface CustomBiome {
  id: string
  label: string
  color: string
  tags: readonly string[]
}

/** 解析后的条目（内置与自定义同构，绘制层不需要知道它是哪一种） */
export interface ResolvedBiomeStyle extends BiomeEntry {
  /** 是不是内置的（界面上"自定义"要能一眼区分） */
  builtin: boolean
}

/** 内置 34 条（地表 18 + 地下 12 + 高空 4），按 `BIOMES.md` §1 与 §4 的配色分组 */
export const BUILTIN_BIOMES: readonly BiomeEntry[] = [
  // ---- 地表 18 条 ----
  { id: 'ice-cap', label: '冰盖及极地荒漠', tags: ['surface', 'polar', 'desert'], color: '#e8f4f8' },
  { id: 'tundra', label: '冻原', tags: ['surface', 'polar', 'grassland'], color: '#a8bcc8' },
  { id: 'conifer', label: '针叶林', tags: ['surface', 'boreal', 'forest'], color: '#2f6b63' },
  { id: 'temperate-broadleaf', label: '温带阔叶林', tags: ['surface', 'temperate', 'forest'], color: '#4f9e52' },
  { id: 'temperate-grassland', label: '温带草原', tags: ['surface', 'temperate', 'grassland'], color: '#a8b74f' },
  {
    id: 'mediterranean-sclerophyll',
    label: '地中海硬叶林',
    tags: ['surface', 'mediterranean', 'shrub'],
    color: '#8a9138',
  },
  {
    id: 'montane-forest',
    label: '山地森林',
    tags: ['surface', 'temperate', 'forest', 'mountain'],
    color: '#2f6b3a',
  },
  { id: 'alpine-tundra', label: '高山苔原', tags: ['surface', 'alpine', 'grassland'], color: '#9a8fb0' },
  {
    id: 'subtropical-rainforest',
    label: '亚热带雨林',
    tags: ['surface', 'subtropical', 'forest', 'wet'],
    color: '#2f9e8f',
  },
  {
    id: 'subtropical-dry-forest',
    label: '亚热带干燥林',
    tags: ['surface', 'subtropical', 'forest', 'dry'],
    color: '#b08a4a',
  },
  { id: 'monsoon-forest', label: '季风雨林', tags: ['surface', 'subtropical', 'forest', 'wet'], color: '#1f7a6b' },
  { id: 'tropical-rainforest', label: '热带雨林', tags: ['surface', 'tropical', 'forest', 'wet'], color: '#1f7a33' },
  { id: 'savanna', label: '稀树草原', tags: ['surface', 'tropical', 'grassland'], color: '#d9b44a' },
  {
    id: 'tree-savanna',
    label: '多树草原',
    tags: ['surface', 'tropical', 'grassland', 'forest'],
    color: '#9ab04a',
  },
  { id: 'desert', label: '沙漠', tags: ['surface', 'arid', 'desert'], color: '#e0c477' },
  { id: 'near-desert', label: '近沙漠', tags: ['surface', 'arid', 'desert'], color: '#e8d7a4' },
  { id: 'semi-arid-desert', label: '半干旱沙漠', tags: ['surface', 'arid', 'desert'], color: '#c9a86a' },
  { id: 'arid-grassland', label: '干旱草原', tags: ['surface', 'arid', 'grassland'], color: '#b09540' },

  // ---- 地下 12 条（暗冷色系，按 ID 顺序逐渐加深）----
  { id: 'under-cave', label: '地下洞穴', tags: ['underground'], color: '#4a4f5a' },
  { id: 'under-moss-cave', label: '地下苔穴', tags: ['underground', 'wet'], color: '#45564a' },
  { id: 'under-special-rock', label: '地下特殊岩石群系', tags: ['underground'], color: '#4f4757' },
  { id: 'under-ore-vein', label: '地下矿脉', tags: ['underground', 'ore'], color: '#5a4a3f' },
  { id: 'under-city', label: '地下城', tags: ['underground', 'artificial'], color: '#3f4653' },
  { id: 'under-ancient-city', label: '古地下城', tags: ['underground', 'artificial'], color: '#3a3f4d' },
  { id: 'under-runoff', label: '地下径流', tags: ['underground', 'aquatic'], color: '#35505e' },
  { id: 'under-lake', label: '地下湖', tags: ['underground', 'aquatic'], color: '#2c4a5e' },
  {
    id: 'under-glimmer-lake',
    label: '地下微光湖',
    tags: ['underground', 'aquatic', 'wet'],
    color: '#2a5560',
  },
  { id: 'under-hell-ash', label: '近地狱灰烬带', tags: ['underground', 'nether'], color: '#4a3a3a' },
  { id: 'under-hell', label: '地狱', tags: ['underground', 'nether'], color: '#3a2a2e' },
  {
    id: 'under-hell-city',
    label: '地狱城',
    tags: ['underground', 'nether', 'artificial'],
    color: '#2f2130',
  },

  // ---- 高空 4 条（亮浅色系）----
  { id: 'sky-island', label: '空岛', tags: ['sky'], color: '#7fc4e8' },
  { id: 'sky-cloud-island', label: '云岛', tags: ['sky'], color: '#e6eef4' },
  { id: 'sky-dark-cloud-island', label: '乌云岛', tags: ['sky', 'wet'], color: '#8a93a0' },
  { id: 'sky-special-station', label: '特殊生物驻扎地', tags: ['sky', 'artificial'], color: '#7fd8d8' },
]

/**
 * 「未填 / 认不出的 ID」用什么颜色画。
 *
 * 刻意是一块**中性灰**而不是某个真实群系的颜色：它要一眼看出"这里没有数据"，
 * 而不是被误读成"这里是沙漠"（同类口径见 `dataDefaults` 与"缺数据不许用 0 冒充"）。
 */
export const BIOME_UNKNOWN_COLOR = '#8b8f96'

const BUILTIN_BY_ID = new Map(BUILTIN_BIOMES.map((entry) => [entry.id, entry]))

/** 内置目录（只读；`BIOMES.md` 就是它的来源与依据） */
export function builtinBiomes(): readonly BiomeEntry[] {
  return BUILTIN_BIOMES
}

/**
 * 内置目录里那一条的颜色；认不出（或本机没有这个自定义定义）时给**中性灰**。
 *
 * 为什么单独一个函数：字段描述表（`overlayFields.ts`）需要一个**不依赖插件设置**的
 * "值 → 颜色"兜底（它在纯函数层，拿不到自定义目录）；真实绘制时绘制层会把现读的目录
 * 覆盖进来（见 `OverlayPlanInput.categoryColors`）。
 */
export function builtinBiomeColor(id: string): string {
  return BUILTIN_BY_ID.get(id)?.color ?? BIOME_UNKNOWN_COLOR
}

/** 把自定义条目解析成"与内置同构"的一行（`builtin: false`） */
export function customBiomeEntry(custom: CustomBiome): ResolvedBiomeStyle {
  return {
    id: custom.id,
    label: custom.label.length > 0 ? custom.label : custom.id,
    tags: [...custom.tags],
    color: custom.color,
    builtin: false,
  }
}

/**
 * 完整目录：**内置在前、自定义在后**（顺序 = 笔刷 / 设置页 / 下拉的顺序）。
 *
 * 自定义的 ID 与内置撞名时**保留内置那一行**：用户改设置不该让内置条目消失
 * （同 ID 的情况在写入前已被 `validateCustomBiomeInput` 拦住）。
 */
export function listResolvedBiomeStyles(custom: readonly CustomBiome[] = []): ResolvedBiomeStyle[] {
  const out: ResolvedBiomeStyle[] = BUILTIN_BIOMES.map((entry) => ({ ...entry, tags: [...entry.tags], builtin: true }))
  for (const item of custom) {
    if (BUILTIN_BY_ID.has(item.id)) continue
    out.push(customBiomeEntry(item))
  }
  return out
}

/**
 * 按 ID 解析一条（**永不返回空**）。
 *
 * 认不出的 ID（别的库写的、用户刚把定义删了）给一条**回退条目**：
 * 显示名就是 ID 本身、颜色是中性灰、没有任何标签 ——
 * 于是"未知"在画布上、图例里、信息卡上都能被看见，而不是变成空白（§5.11）。
 */
export function resolveBiomeStyle(id: string, custom: readonly CustomBiome[] = []): ResolvedBiomeStyle {
  const builtin = BUILTIN_BY_ID.get(id)
  if (builtin !== undefined) return { ...builtin, tags: [...builtin.tags], builtin: true }
  const found = custom.find((item) => item.id === id)
  if (found !== undefined) return customBiomeEntry(found)
  return { id, label: id, tags: [], color: BIOME_UNKNOWN_COLOR, builtin: false }
}

/** 目录签名：变了就说明"选项数量或名字变了"，界面据此重建（与其它几类目录同一条） */
export function biomeCatalogSignature(custom: readonly CustomBiome[] = []): string {
  return custom.map((item) => `${item.id}|${item.label}|${item.color}|${item.tags.join(',')}`).join(';')
}

/** 按标签筛出命中哪些群系（筛选器的 `biomeTag` 规则用它一次命中一组） */
export function biomesWithTag(tag: string, custom: readonly CustomBiome[] = []): ResolvedBiomeStyle[] {
  return listResolvedBiomeStyles(custom).filter((entry) => entry.tags.includes(tag))
}

/** ID → 颜色的映射（渲染层用：分类字段的逐格上色需要"值 → 颜色"这一张表） */
export function biomeColorMap(custom: readonly CustomBiome[] = []): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of listResolvedBiomeStyles(custom)) map.set(entry.id, entry.color)
  return map
}

/* ------------------------------------------------------------------ 自定义条目的自检 */

/**
 * 一份自定义生物群系的 ID 有什么问题（`null` = 没问题）。
 *
 * ⚠️ **刻意不禁止"用内置名当 ID"**（`desert` → `custom:desert`）：与 `terrainIdProblem`
 * 同一口径 —— 前缀已经保证存储值不撞名，而"该不该叫这个名字"是用户的审美问题，
 * 不该由校验函数替他决定。（也正因为必须带前缀，内置 ID 与自定义 ID **在构造上**
 * 不可能撞名：内置全是裸 slug。）
 */
export function customBiomeIdProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'ID 必须是一段文本'
  const text = raw.trim()
  if (text.length === 0) return 'ID 不能为空'
  if (!text.startsWith(CUSTOM_BIOME_PREFIX)) return `ID 必须以 ${CUSTOM_BIOME_PREFIX} 开头`
  if (text.length === CUSTOM_BIOME_PREFIX.length) return `${CUSTOM_BIOME_PREFIX} 后面还要写名字`
  if (/\s/.test(text)) return 'ID 里不能有空格'
  return null
}

/** 把 ID 规范化（去空白）；不合法返回 `null` */
export function normalizeCustomBiomeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return customBiomeIdProblem(text) === null ? text : null
}

/**
 * 一份自定义生物群系记录的自检（设置页保存前用它决定"能不能收"）。
 *
 * 与 `validateCustomTerrainInput` 同一条口径：**拒绝并说明原因**，绝不悄悄夹取或改名。
 * 标签只允许登记表里那些 —— 否则筛选器的 `biomeTag` 会出现用户点不出来的值。
 * （标签**可以为空数组**：一个还没归类的自定义群系是合法的，它只是筛不到标签。）
 */
export function validateCustomBiomeInput(input: {
  id: unknown
  label?: unknown
  color?: unknown
  tags?: unknown
}): { ok: true; biome: CustomBiome } | { ok: false; problem: string } {
  const id = normalizeCustomBiomeId(input.id)
  if (id === null) return { ok: false, problem: customBiomeIdProblem(input.id) ?? 'ID 不合法' }
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (label.length === 0) return { ok: false, problem: '显示名不能为空' }
  const color = typeof input.color === 'string' ? input.color.trim() : ''
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) return { ok: false, problem: '颜色要写成 #rrggbb 这样的形式' }
  const rawTags = Array.isArray(input.tags) ? input.tags : []
  const tags: string[] = []
  for (const item of rawTags) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (tag.length === 0) continue
    if (!isKnownTagFor('biome', tag)) return { ok: false, problem: `不认识的标签：${tag}` }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return { ok: true, biome: { id, label, color, tags } }
}

/** 把任意输入收敛成一份可用的自定义目录（坏条目**跳过**，不让一份坏设置把整张表带塌） */
export function normalizeCustomBiomes(raw: unknown): CustomBiome[] {
  if (!Array.isArray(raw)) return []
  const out: CustomBiome[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const result = validateCustomBiomeInput({
      id: record.id,
      label: record.label,
      color: record.color,
      tags: record.tags,
    })
    if (!result.ok) continue
    if (seen.has(result.biome.id)) continue
    seen.add(result.biome.id)
    out.push(result.biome)
    if (out.length >= MAX_CUSTOM_BIOMES) break
  }
  return out
}