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
import { checkTerrainImagePath } from './terrainCatalog.ts'

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

/**
 * 自定义标记的两种模式。
 *
 * 与自定义地形同一条理由（那里是 `CustomTerrainMode`，此处是它的镜像）：
 * 靠"有图片就画图片"来推断，用户既看不出"两个都填会怎样"、也看不出自己现在处于哪种状态；
 * 而且想切回字形时只能**删掉图片路径** —— 删掉就丢了那条路径，改主意时得重新找图。
 * 显式模式让"用哪套视觉"与"配了哪些值"互不牵连：切回图片模式时之前选的图还在。
 */
export type CustomMarkerMode = 'glyph' | 'image'

/** 新建时的默认模式：字形不依赖任何外部资源，最不容易失败 */
export const DEFAULT_CUSTOM_MARKER_MODE: CustomMarkerMode = 'glyph'

export interface CustomMarker {
  /** 完整 ID（含 `custom:` 前缀）—— **就是写进地图文件的 `icon` 值** */
  id: string
  /** 显示名（工具条与设置页用）；改它不影响已存数据 */
  label: string
  /** 借用哪个内置图标的字形；`''` = 用通用图钉（回退名）。**两种模式下都保留** */
  icon: string
  /** 库内图片路径（相对库根）；**仅在 `mode === 'image'` 时参与绘制** */
  imagePath: string
  /** 用哪套视觉：字形（借用内置图标）还是图片 */
  mode: CustomMarkerMode
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

/* --------------------------------------------------------------- 模式 */

/**
 * 收敛模式，并**迁移旧数据**。
 *
 * 与 `normalizeTerrainMode` 逐字同一条规则（两处必须保持一致，否则同一个 `data.json`
 * 里地形与标记会对"配了图但没写模式"给出不同答案）：旧数据只有 `imagePath`，
 * **配了图片就按图片模式**，否则字形模式 —— 升级后看到的画面与升级前完全一致。
 *
 * 非法值走**同一条推断**，而不是默认成 `'glyph'`：把"配了图但 mode 写坏了"降级成字形模式，
 * 用户会看到"图明明配着却不显示"而界面一切正常 —— 那是最难自查的一类问题。
 */
export function normalizeMarkerMode(raw: unknown, imagePath: string): CustomMarkerMode {
  if (raw === 'glyph' || raw === 'image') return raw
  return imagePath.length > 0 ? 'image' : 'glyph'
}

/* --------------------------------------------------------------- 集合 */

function normalizeOneMarker(raw: unknown): CustomMarker | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = normalizeMarkerId(source.id)
  if (id === null) return null
  // 先算图片路径、再定模式：模式的迁移推断就建立在"有没有图片"上（同 normalizeOneTerrain）
  const imagePath = checkTerrainImagePath(source.imagePath).path
  return {
    id,
    label: normalizeMarkerLabel(source.label, id),
    // 字形只接受内置图标名；其余（含 null / 未知字符串）退化为通用图钉
    icon: isBuiltinMarkerIcon(source.icon) ? source.icon : '',
    // 图片路径的形状校验与地形**共用同一个函数**（扩展名白名单、反斜杠统一成 `/`）：
    // 两处各写一套的话，"地形接受了这张图、标记却不接受"会变成没法解释的行为差异
    imagePath,
    mode: normalizeMarkerMode(source.mode, imagePath),
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
      // 字形模式下**不把图片路径交出去**：绘制层拿不到它就绝不会去画图片，
      // 于是"模式"这件事只需要在这里判断一次，而不是散落到每一处绘制代码里（同 resolveTerrainStyle）。
      imagePath: marker.mode === 'image' ? marker.imagePath : '',
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
  return custom.map((marker) => `${marker.id}|${marker.label}|${marker.icon}|${marker.imagePath}|${marker.mode}`).join(';')
}

/** 设置页保存前用它决定"能不能收" */
export function validateCustomMarkerInput(input: {
  id: unknown
  label?: unknown
  icon?: unknown
  imagePath?: unknown
  mode?: unknown
}): { ok: true; marker: CustomMarker } | { ok: false; problem: string } {
  const id = normalizeMarkerId(input.id)
  if (id === null) return { ok: false, problem: markerIdProblem(input.id) ?? 'ID 不合法' }
  // 图片路径为什么**在这里**就拒绝、而不是留到绘制时回退：设置页需要一句可读的原因
  // （"只支持 png / jpg …"），而绘制层的回退只是兜底，不会告诉用户哪里写错了
  const image = checkTerrainImagePath(input.imagePath)
  if (image.problem.length > 0) return { ok: false, problem: image.problem }
  return {
    ok: true,
    marker: {
      id,
      label: normalizeMarkerLabel(input.label, id),
      icon: isBuiltinMarkerIcon(input.icon) ? input.icon : '',
      imagePath: image.path,
      mode: normalizeMarkerMode(input.mode, image.path),
    },
  }
}
