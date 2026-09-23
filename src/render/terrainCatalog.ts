/**
 * 自定义地形目录 —— 纯函数模块。
 *
 * 为什么单独一个模块（与 `stylePalette.ts` 同一分工）：
 * 1. **用户输入必须在这里被校验干净**，而且这三样东西都是"写错了不报错、只会静默变形"：
 *    - 地形 **ID** 会写进地图文件（`terrain.<格键>.t`），一旦与显示名耦合，改个中文名就可能
 *      让已有地图认不出自己的格子；
 *    - **颜色**非法时 canvas **静默忽略**该次 fill（沿用上一个颜色）；
 *    - **图片路径**非法或不存在时，如果不挡在这里，就会变成"某一格永远画不出来"而没有任何报错。
 * 2. **ID 与显示名解耦**：`id` 是数据，`label` 只是界面文案。改 label 绝不影响已存数据 ——
 *    这是整个功能里最容易做错、也最难补救的一点（数据已经写进用户文件里了）。
 * 3. **回退是显式的**：内置 9 种 → 用户自定义 → 未知 ID，三级回退都在这一个函数里决定，
 *    画布、工具条、Base 缩略图、SVG 导出都读同一份结果，于是"四处颜色不一致"这种老问题
 *    不会因为新增功能而重新出现。
 *
 * 语义边界：设置里的地形定义只决定**以后新画**的格子长什么样。
 * 已经画好的格子把 ID 存在地图文件里（`t: "custom:xxx"`），
 * 删除设置里的定义**不会**删掉你地图上的格子（它们退化为回退视觉，数据原样保留）。
 */

import { TERRAIN_TYPES, type TerrainType } from '../data/mapDocument.ts'
import { normalizeColor } from './stylePalette.ts'
import {
  FALLBACK_TERRAIN_BASE,
  FALLBACK_TERRAIN_OUTLINE,
  FALLBACK_TERRAIN_GLYPH,
  GENERIC_TERRAIN_GLYPH,
  TERRAIN_STYLES,
  type GlyphShape,
} from './terrainStyle.ts'

/**
 * 自定义地形 ID 的前缀。
 *
 * 为什么用 `custom:`（而不是 `custom-` 或者干脆不加前缀）：
 * 内置类型是**纯小写单词**（`forest` / `water` …），冒号让"这是用户命名空间"这件事在文件里
 * 一眼可辨，而且内置类型未来也永远不会含冒号 —— 冲突在结构上就不可能发生。
 * 用 `custom-` 的话，某天内置一个叫 `custom-foo` 的类型就会撞车；不加前缀则必然撞车。
 */
export const CUSTOM_TERRAIN_PREFIX = 'custom:'

/** 用户可填的 ID 主体（不含前缀）；与"文件里能存什么"是两回事，见 `mapDocument.ts` */
const TERRAIN_SLUG = /^[a-z][a-z0-9_-]{1,31}$/

/** 支持的图片扩展名（Obsidian 能内联显示的位图与矢量图） */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif']

/**
 * 自定义地形数量上限。
 *
 * 不是随手定的：地形图集是**一张单行位图**，宽度 = 精灵边长 ×（内置 9 + 自定义数），
 * 而精灵边长 = 默认半径 128 × 2 + 4 = 260 px。取 40 时：
 * `260 × 49 ≈ 12.7k px`，仍低于部分平台保守的画布宽度上限（16384）。
 * 若把上限提到 64，宽度会到 `≈19k px` —— 在那些平台上画布会被静默截断或被拒绝创建，
 * 表现是"地形全部不显示"，而这条静态上限恰好是防止那种情况的第一道闸。
 */
export const MAX_CUSTOM_TERRAINS = 40

/** 显示名长度上限（工具条一行放得下） */
const MAX_LABEL_LENGTH = 24

/** 未指定颜色时的出厂色：中性灰蓝，和 9 种内置色都不撞 */
export const DEFAULT_CUSTOM_TERRAIN_COLOR = '#8fa3b0'

export interface CustomTerrain {
  /** 完整 ID（含 `custom:` 前缀）—— **就是写进地图文件的 `t` 值** */
  id: string
  /** 显示名（工具条与设置页用）；改它不影响已存数据 */
  label: string
  /** 六边形底色 */
  color: string
  /** 叠哪种字形：内置类型 ID（借用它的字形）或 `''`（通用图元） */
  glyph: string
  /** 库内图片路径（相对库根）；`''` = 不用图片，只画颜色 + 字形 */
  imagePath: string
}

/** 绘制层真正消费的地形视觉（内置、自定义、未知三种情况被抹平成同一个形状） */
export interface ResolvedTerrainStyle {
  id: string
  label: string
  base: string
  outline: string
  glyph: GlyphShape[]
  /** 非空表示这一格要画图片（画不出来时由绘制层回退到颜色 + 字形） */
  imagePath: string
  /** 内置 9 种之一 */
  builtin: boolean
  /** 设置里找不到这个 ID（旧文件、别人的文件、或用户刚把定义删了） */
  unknown: boolean
}

/* ------------------------------------------------------------------ ID */

/** 内置类型判断（`TerrainType` 是字面量联合，这里做一次收窄） */
export function isBuiltinTerrain(value: unknown): value is TerrainType {
  return typeof value === 'string' && (TERRAIN_TYPES as readonly string[]).includes(value)
}

/**
 * 把用户输入收敛成合法的地形 ID；不合法返回 `null`（调用方负责显示原因）。
 *
 * 规则：先 trim、统一小写、去掉多余的 `custom:` 前缀，再校验主体为
 * `^[a-z][a-z0-9_-]{1,31}$`。
 *
 * 为什么**统一小写**而不是原样保留：ID 是写进文件的标识，`Swamp` 与 `swamp` 会变成两个
 * 看起来一样、数据却互不相认的地形 —— 这类"复制粘贴出来的重复项"在设置界面里极难排查。
 * 为什么**自动补前缀**：用户必然只关心自己想叫什么（`swamp2`），让前缀成为系统的一部分，
 * 冲突就由结构来避免，而不是靠用户记住规矩。
 */
export function normalizeTerrainId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim().toLowerCase()
  if (text.length === 0) return null
  // 允许用户把完整 ID 直接粘进来（包括重复写前缀的情况）
  while (text.startsWith(CUSTOM_TERRAIN_PREFIX)) text = text.slice(CUSTOM_TERRAIN_PREFIX.length)
  if (!TERRAIN_SLUG.test(text)) return null
  return `${CUSTOM_TERRAIN_PREFIX}${text}`
}

/**
 * 给设置界面用的**可读原因**。
 *
 * 返回 `null` 表示合法。分开写的理由：校验函数只回答"行不行"，
 * 而界面必须回答"为什么不行" —— 否则用户只能反复试错（这个项目已经吃过"只能猜"的亏）。
 *
 * 注意：这里**不**禁止用内置名当 ID（`forest` → `custom:forest`）。
 * 前缀已经保证了存储值不冲突，而"到底该不该叫这个名字"是用户的审美问题，
 * 不该由一个校验函数替他决定；真要有两条像样的定义，显示名里也看得见。
 */
export function terrainIdProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'ID 不能为空'
  if (normalizeTerrainId(raw) !== null) return null
  let text = raw.trim().toLowerCase()
  while (text.startsWith(CUSTOM_TERRAIN_PREFIX)) text = text.slice(CUSTOM_TERRAIN_PREFIX.length)
  if (!/^[a-z]/.test(text)) return 'ID 必须以小写字母开头（例如 swamp2）'
  if (text.length < 2) return 'ID 至少 2 个字符'
  if (text.length > 32) return `ID 太长（${text.length} 字符，最多 32）`
  return 'ID 只能用小写字母、数字、下划线和连字符'
}

/** 显示名：去空白、限长；留空时退化为 ID 主体（至少界面上认得出是哪一条） */
export function normalizeTerrainLabel(raw: unknown, id: string): string {
  const fallback = id.startsWith(CUSTOM_TERRAIN_PREFIX) ? id.slice(CUSTOM_TERRAIN_PREFIX.length) : id
  if (typeof raw !== 'string') return fallback
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length === 0) return fallback
  return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH) : text
}

/* ----------------------------------------------------------- 图片路径 */

export interface TerrainImagePathCheck {
  /** 合法路径；非法时为空串 */
  path: string
  /** 空串表示没填（= 不用图片）；非空表示为什么不能用 */
  problem: string
}

/**
 * 校验库内图片路径。
 *
 * 这里**只做形状校验**，不碰 vault —— 文件到底存不存在必须由注入的加载器去问，
 * 渲染层不允许直接访问库（见 `MapOverlayOptions.loadTerrainImage`）。
 * 但形状必须在进渲染层之前就干净：一个 `../../` 或 `http://` 路径交给加载器，
 * 换来的只是"某一格永远画不出来"。
 */
export function checkTerrainImagePath(raw: unknown): TerrainImagePathCheck {
  if (raw === undefined || raw === null) return { path: '', problem: '' }
  if (typeof raw !== 'string') return { path: '', problem: '图片路径必须是文本' }
  const text = raw.trim()
  if (text.length === 0) return { path: '', problem: '' }
  if (text.length > 256) return { path: '', problem: `路径太长（${text.length} 字符，最多 256）` }
  // ⚠️ 绝对路径必须在"网址"之前判断：`C:\Users\...` 里的 `C:` 同样符合 scheme 的形状，
  // 先走网址分支会给用户一句**错误**的解释（"这不是网址"），比没有解释更糟。
  if (text.startsWith('/') || text.startsWith('\\') || /^[a-z]:[\\/]/i.test(text)) {
    return { path: '', problem: '请用库内相对路径（例如 Assets/forest.png），不要用绝对路径' }
  }
  if (text.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return { path: '', problem: '这里要填库内文件路径，不是网址（例如 Assets/forest.png）' }
  }
  if (text.split(/[\\/]/).some((segment) => segment === '..')) {
    return { path: '', problem: '路径里不能出现 ..（会跑到库外面去）' }
  }
  const extension = text.slice(text.lastIndexOf('.') + 1).toLowerCase()
  if (!IMAGE_EXTENSIONS.includes(extension)) {
    return { path: '', problem: `只支持 ${IMAGE_EXTENSIONS.join(' / ')} 这些格式` }
  }
  // 统一成 `/` 分隔：Windows 上用户很容易粘反斜杠，而 vault 路径一律是正斜杠
  return { path: text.replace(/\\/g, '/'), problem: '' }
}

/** 收敛成合法图片路径（非法即当作"没有图片"，由调用方决定是否提示原因） */
export function normalizeTerrainImagePath(raw: unknown): string {
  return checkTerrainImagePath(raw).path
}

/* --------------------------------------------------------------- 集合 */

function normalizeOneTerrain(raw: unknown): CustomTerrain | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = normalizeTerrainId(source.id)
  if (id === null) return null
  return {
    id,
    label: normalizeTerrainLabel(source.label, id),
    color: normalizeColor(source.color, DEFAULT_CUSTOM_TERRAIN_COLOR),
    // 字形只接受内置类型名；其余（含 null / 未知字符串）退化为通用图元
    glyph: isBuiltinTerrain(source.glyph) ? source.glyph : '',
    imagePath: normalizeTerrainImagePath(source.imagePath),
  }
}

/**
 * 把任意输入（可能是被手工改坏的 `data.json`）收敛成一份可用的自定义地形表。
 *
 * - 逐条独立校验：一条坏数据只丢它自己，不影响其余（与地图文档的解析承诺一致）；
 * - **按 ID 去重、先出现的胜出**：`data.json` 里出现重复 ID 时，绘制层需要唯一的答案，
 *   而"后出现的覆盖前面的"会让手工编辑变得不可预测；
 * - 截断到 `MAX_CUSTOM_TERRAINS`：上限是图集位图的尺寸约束，不是随意定的。
 */
export function normalizeCustomTerrains(raw: unknown): CustomTerrain[] {
  if (!Array.isArray(raw)) return []
  const out: CustomTerrain[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_TERRAINS) break
    const terrain = normalizeOneTerrain(item)
    if (terrain === null || seen.has(terrain.id)) continue
    seen.add(terrain.id)
    out.push(terrain)
  }
  return out
}

export function findCustomTerrain(id: string, custom: readonly CustomTerrain[]): CustomTerrain | null {
  for (const terrain of custom) if (terrain.id === id) return terrain
  return null
}

/* --------------------------------------------------------------- 解析 */

function glyphFor(glyph: string): GlyphShape[] {
  if (isBuiltinTerrain(glyph)) return TERRAIN_STYLES[glyph].glyph
  return GENERIC_TERRAIN_GLYPH
}

/**
 * 三级回退：内置 → 自定义 → 未知。
 *
 * **永不返回 null**：绘制层每帧都会问它，任何"这里没有样式"的分支都会变成
 * "某一格突然画不出来"。未知 ID 也必须有一份看得见的视觉（这样用户至少能看到
 * "这里有东西，但设置里没有对应定义"），而不是消失。
 */
export function resolveTerrainStyle(id: string, custom: readonly CustomTerrain[] = []): ResolvedTerrainStyle {
  if (isBuiltinTerrain(id)) {
    const style = TERRAIN_STYLES[id]
    return {
      id,
      label: style.label,
      base: style.base,
      outline: style.outline,
      glyph: style.glyph,
      imagePath: '',
      builtin: true,
      unknown: false,
    }
  }
  const terrain = findCustomTerrain(id, custom)
  if (terrain !== null) {
    return {
      id,
      label: terrain.label,
      base: terrain.color,
      outline: FALLBACK_TERRAIN_OUTLINE,
      glyph: glyphFor(terrain.glyph),
      imagePath: terrain.imagePath,
      builtin: false,
      unknown: false,
    }
  }
  return {
    id,
    label: `未知（${id}）`,
    base: FALLBACK_TERRAIN_BASE,
    outline: FALLBACK_TERRAIN_OUTLINE,
    glyph: FALLBACK_TERRAIN_GLYPH,
    imagePath: '',
    builtin: false,
    unknown: true,
  }
}

/**
 * 目录顺序：**内置 9 种在前（顺序不变），自定义按设置里的顺序排在后面**。
 *
 * 顺序即"数字键 1–9 的位置"，所以内置部分必须保持出厂顺序 ——
 * 自定义地形不占用数字键（理由见 `MapToolbar`：1–9 已经占满，再抢键位会破坏既有的肌肉记忆）。
 */
export function listResolvedTerrainStyles(custom: readonly CustomTerrain[] = []): ResolvedTerrainStyle[] {
  const out: ResolvedTerrainStyle[] = TERRAIN_TYPES.map((type) => resolveTerrainStyle(type, custom))
  for (const terrain of custom) out.push(resolveTerrainStyle(terrain.id, custom))
  return out
}

/** 地形 ID → 显示名（图例、状态报告、工具条都用它） */
export function terrainLabelOf(id: string, custom: readonly CustomTerrain[] = []): string {
  return resolveTerrainStyle(id, custom).label
}

/**
 * 目录签名：内容变了才需要重建工具条按钮与地形图集。
 *
 * 与地图面板的"状态签名"同一思路（不要每帧重建 DOM），但这里比较的是**用户设置**，
 * 所以只需覆盖所有会改变视觉的字段。
 */
export function terrainCatalogSignature(custom: readonly CustomTerrain[] = []): string {
  return custom.map((terrain) => `${terrain.id}|${terrain.label}|${terrain.color}|${terrain.glyph}|${terrain.imagePath}`).join(';')
}

/** 一份自定义地形记录的自检（设置页保存前用它决定"能不能收"） */
export function validateCustomTerrainInput(input: {
  id: unknown
  label?: unknown
  color?: unknown
  glyph?: unknown
  imagePath?: unknown
}): { ok: true; terrain: CustomTerrain } | { ok: false; problem: string } {
  const id = normalizeTerrainId(input.id)
  if (id === null) return { ok: false, problem: terrainIdProblem(input.id) ?? 'ID 不合法' }
  const image = checkTerrainImagePath(input.imagePath)
  if (image.problem.length > 0) return { ok: false, problem: image.problem }
  return {
    ok: true,
    terrain: {
      id,
      label: normalizeTerrainLabel(input.label, id),
      color: normalizeColor(input.color, DEFAULT_CUSTOM_TERRAIN_COLOR),
      glyph: isBuiltinTerrain(input.glyph) ? input.glyph : '',
      imagePath: image.path,
    },
  }
}
