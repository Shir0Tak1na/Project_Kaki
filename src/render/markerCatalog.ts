/**
 * 自定义标记图标目录 —— 纯函数模块（与 `terrainCatalog.ts` 同一分工）。
 *
 * 为什么要有它：标记的图标名是**写进地图文件的数据**（`markers[].icon`）。
 * 现在的解析是"不认识的图标就替换成 town"，于是换台机器打开、或手工改错一个字，
 * 下一次保存就把用户原来的图标**永久改写**了 —— 这与地形那边"未知 t 曾被丢弃"是同一类损失
 * （见 `ENGINEERING-NOTES.md` §5.11 第 1 条）。这里的口径与地形一致：
 *
 * 1. **认不出 ≠ 丢弃**：未知 ID 原样保留在文件里，只在绘制时回退成一个看得见的占位图标；
 * 2. **ID 与显示名解耦**：`custom:` 前缀 + 稳定的 slug（改显示名不影响已存数据）；
 * 3. **三级回退**：内置 9 种 → 用户自定义 → 未知（回退图钉 + `unknown` 标记，供绘制层区别显示）；
 * 4. 解析**永不返回 null**：绘制层每帧都会问它，任何"这里没有图标"的分支都会变成"某个标记消失"。
 */

import { MARKER_ICONS, type MarkerIcon } from '../data/mapDocument.ts'
import { lucideIconFor } from './markerPlacement.ts'

/**
 * 自定义标记 ID 的前缀。
 *
 * 与地形用同一个前缀词（`custom:`）：内置标记是纯小写单词（`city` / `port` …），
 * 冒号让"这是用户命名空间"在文件里一眼可辨，而且内置名永远不会含冒号 ⇒ 冲突在结构上不可能发生。
 */
export const CUSTOM_MARKER_PREFIX = 'custom:'

/** 用户可填的 ID 主体（不含前缀） */
const MARKER_SLUG = /^[a-z][a-z0-9_-]{1,31}$/

/**
 * 自定义标记数量上限。
 *
 * 比地形的 40 可以宽松些（标记是 DOM 元素，不像地形图集那样受画布宽度限制），
 * 但**仍然要有上限**：设置页与工具条都是给人看的，几百个按钮等于没有界面。
 */
export const MAX_CUSTOM_MARKERS = 60

/** 显示名长度上限（工具条一行放得下） */
const MAX_LABEL_LENGTH = 24

/** 未知 ID / 没有可用图标时的回退：`circle-dot` 是既有映射表里就在用的有效名字 */
export const FALLBACK_MARKER_ICON_NAME = 'circle-dot'

export interface CustomMarker {
  /** 完整 ID（含 `custom:` 前缀）—— **就是写进地图文件的 `icon` 值** */
  id: string
  /** 显示名（工具条与设置页用）；改它不影响已存数据 */
  label: string
  /** 借用哪个内置图标的字形；`''` = 用通用图钉（回退名） */
  icon: string
  /** 库内图片路径（相对库根）；`''` = 只用图标字形 */
  imagePath: string
}

/** 绘制层真正消费的标记视觉（内置、自定义、未知三种情况被抹平成同一个形状） */
export interface ResolvedMarkerStyle {
  id: string
  label: string
  /** 交给 `setIcon` 的 Lucide 名（已保证是有效名，见 `lucideIconFor`） */
  iconName: string
  /** 非空表示这个标记要画图片（加载不出来时由绘制层回退到 iconName） */
  imagePath: string
  /** 内置 9 种之一 */
  builtin: boolean
  /** 设置里找不到这个 ID（旧文件、别人的文件、或用户刚把定义删了） */
  unknown: boolean
}

/* ------------------------------------------------------------------ ID */

export function isBuiltinMarkerIcon(value: unknown): value is MarkerIcon {
  return typeof value === 'string' && (MARKER_ICONS as readonly string[]).includes(value)
}

/** 把用户输入收敛成合法的标记 ID；不合法返回 `null` */
export function normalizeMarkerId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim().toLowerCase()
  if (text.length === 0) return null
  while (text.startsWith(CUSTOM_MARKER_PREFIX)) text = text.slice(CUSTOM_MARKER_PREFIX.length)
  if (!MARKER_SLUG.test(text)) return null
  return `${CUSTOM_MARKER_PREFIX}${text}`
}

/** 给设置界面用的可读原因；返回 `null` 表示合法 */
export function markerIdProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'ID 不能为空'
  if (normalizeMarkerId(raw) !== null) return null
  let text = raw.trim().toLowerCase()
  while (text.startsWith(CUSTOM_MARKER_PREFIX)) text = text.slice(CUSTOM_MARKER_PREFIX.length)
  if (!/^[a-z]/.test(text)) return 'ID 必须以小写字母开头（例如 lighthouse）'
  if (text.length < 2) return 'ID 至少 2 个字符'
  if (text.length > 32) return `ID 太长（${text.length} 字符，最多 32）`
  return 'ID 只能用小写字母、数字、下划线和连字符'
}

/** 显示名：去空白、限长；留空时退化为 ID 主体 */
export function normalizeMarkerLabel(raw: unknown, id: string): string {
  const fallback = id.startsWith(CUSTOM_MARKER_PREFIX) ? id.slice(CUSTOM_MARKER_PREFIX.length) : id
  if (typeof raw !== 'string') return fallback
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length === 0) return fallback
  return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH) : text
}

/* --------------------------------------------------------------- 集合 */

function normalizeOneMarker(raw: unknown): CustomMarker | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = normalizeMarkerId(source.id)
  if (id === null) return null
  return {
    id,
    label: normalizeMarkerLabel(source.label, id),
    // 字形只接受内置图标名；其余（含 null / 未知字符串）退化为通用图钉
    icon: isBuiltinMarkerIcon(source.icon) ? source.icon : '',
    // 图片路径的形状校验与地形共用同一套规则（在 wiring 时接上 checkTerrainImagePath，
    // 这里先只保证是字符串：真正的路径校验属于 `terrainCatalog` 的职责，不重复实现）
    imagePath: typeof source.imagePath === 'string' ? source.imagePath.trim().replace(/\\/g, '/') : '',
  }
}

/**
 * 把任意输入（可能是被手工改坏的 `data.json`）收敛成一份可用的自定义标记表。
 * 逐条独立校验、按 ID 去重（先出现的胜出）、截断到上限 —— 与自定义地形完全一致的口径。
 */
export function normalizeCustomMarkers(raw: unknown): CustomMarker[] {
  if (!Array.isArray(raw)) return []
  const out: CustomMarker[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_MARKERS) break
    const marker = normalizeOneMarker(item)
    if (marker === null || seen.has(marker.id)) continue
    seen.add(marker.id)
    out.push(marker)
  }
  return out
}

export function findCustomMarker(id: string, custom: readonly CustomMarker[]): CustomMarker | null {
  for (const marker of custom) if (marker.id === id) return marker
  return null
}

/* --------------------------------------------------------------- 解析 */

/**
 * 三级回退：内置 → 自定义 → 未知。**永不返回 null**。
 *
 * 未知 ID 也必须有看得见的视觉（这里给通用图钉 + `unknown: true`），
 * 而不是让那个标记从地图上消失 —— 用户至少应该看到"这里有东西，只是图标没定义"。
 */
export function resolveMarkerStyle(id: string, custom: readonly CustomMarker[] = []): ResolvedMarkerStyle {
  if (isBuiltinMarkerIcon(id)) {
    return {
      id,
      label: id,
      iconName: lucideIconFor(id),
      imagePath: '',
      builtin: true,
      unknown: false,
    }
  }
  const marker = findCustomMarker(id, custom)
  if (marker !== null) {
    return {
      id,
      label: marker.label,
      iconName: marker.icon.length > 0 ? lucideIconFor(marker.icon as MarkerIcon) : FALLBACK_MARKER_ICON_NAME,
      imagePath: marker.imagePath,
      builtin: false,
      unknown: false,
    }
  }
  return {
    id,
    label: `未知（${id}）`,
    iconName: FALLBACK_MARKER_ICON_NAME,
    imagePath: '',
    builtin: false,
    unknown: true,
  }
}

/** 目录顺序：内置在前（顺序不变），自定义按设置里的顺序排在后面 */
export function listResolvedMarkerStyles(custom: readonly CustomMarker[] = []): ResolvedMarkerStyle[] {
  const out: ResolvedMarkerStyle[] = MARKER_ICONS.map((icon) => resolveMarkerStyle(icon, custom))
  for (const marker of custom) out.push(resolveMarkerStyle(marker.id, custom))
  return out
}

/** 标记 ID → 显示名（状态报告、设置页都用它） */
export function markerLabelOf(id: string, custom: readonly CustomMarker[] = []): string {
  return resolveMarkerStyle(id, custom).label
}

/**
 * 目录签名：内容变了才需要重建工具条按钮。
 * 与地形图集同一思路（`terrainCatalogSignature`），避免每个标记都重建 DOM。
 */
export function markerCatalogSignature(custom: readonly CustomMarker[] = []): string {
  return custom.map((marker) => `${marker.id}|${marker.label}|${marker.icon}|${marker.imagePath}`).join(';')
}

/** 设置页保存前用它决定"能不能收" */
export function validateCustomMarkerInput(input: {
  id: unknown
  label?: unknown
  icon?: unknown
  imagePath?: unknown
}): { ok: true; marker: CustomMarker } | { ok: false; problem: string } {
  const id = normalizeMarkerId(input.id)
  if (id === null) return { ok: false, problem: markerIdProblem(input.id) ?? 'ID 不合法' }
  return {
    ok: true,
    marker: {
      id,
      label: normalizeMarkerLabel(input.label, id),
      icon: isBuiltinMarkerIcon(input.icon) ? input.icon : '',
      imagePath: typeof input.imagePath === 'string' ? input.imagePath.trim().replace(/\\/g, '/') : '',
    },
  }
}
