/**
 * 地图文档数据模型 —— 纯函数模块，不依赖 obsidian，可被单元测试直接覆盖。
 *
 * 设计要点（见设计文档 §6 与 §2 ADR-2）：
 * - 地形以六边形**轴向坐标**存储（键 `"q_r"`），而不是像素坐标；
 * - 标记 / 区域 / 路径 / 文字标注保留**世界坐标**；
 * - **未知字段必须原样保留**：旧版本插件打开新版本写的地图时，不得丢字段；
 * - 校验策略是「结构性错误拒绝加载，单条目错误跳过并告警」——
 *   手写的地图不该因为一个坏条目而整份打不开。
 */

import { parseCellKey, type GridSpec } from '../core/hex.ts'
import type { GeometryMode } from '../core/hexEdges.ts'

/** 当前插件支持的文档版本 */
export const MAP_DOCUMENT_VERSION = 1

export type TerrainType =
  | 'mountain'
  | 'forest'
  | 'water'
  | 'desert'
  | 'plains'
  | 'swamp'
  | 'hills'
  | 'tundra'
  | 'volcanic'

export const TERRAIN_TYPES: readonly TerrainType[] = [
  'mountain',
  'forest',
  'water',
  'desert',
  'plains',
  'swamp',
  'hills',
  'tundra',
  'volcanic',
]

export type MarkerIcon =
  | 'city'
  | 'town'
  | 'fortress'
  | 'ruin'
  | 'port'
  | 'temple'
  | 'mountain-peak'
  | 'cave'
  | 'tower'

export const MARKER_ICONS: readonly MarkerIcon[] = [
  'city',
  'town',
  'fortress',
  'ruin',
  'port',
  'temple',
  'mountain-peak',
  'cave',
  'tower',
]

/**
 * 标记图标标识。
 *
 * 刻意**不是** `MarkerIcon` 的字面量联合，理由与 `TerrainId` 完全相同：文件里可能出现
 * - 内置 9 种（`city` …）；
 * - 本插件的自定义标记（`custom:xxx`，由用户在设置里定义）；
 * - 别的库/别的版本写下的、本机设置里没有的 ID。
 *
 * 第三种必须能**原样通读通写**：把不认识的图标名替换成 `town`，用户一保存就永久改写了
 * 自己的数据（而且没有任何报错）。所以这里放宽成字符串，回退视觉由绘制层负责
 * （见 `markerCatalog.ts` 的 `resolveMarkerStyle`）。
 */
export type MarkerId = string

/** 内置路径类型（出厂 4 种）—— 只有它们有出厂样式（见 `shapeStyle.PATH_STYLES`） */
export type BuiltinPathType = 'river' | 'road' | 'trade-route' | 'border'
export const PATH_TYPES: readonly BuiltinPathType[] = ['river', 'road', 'trade-route', 'border']

/**
 * 路径类型标识。
 *
 * 刻意**不是** `BuiltinPathType` 的字面量联合，理由与 `TerrainId` / `MarkerId` 完全相同：
 * 文件里可能出现
 * - 内置 4 种（`river` …）；
 * - 本插件的自定义路径类型（`custom:xxx`，由用户在设置里定义）；
 * - 别的库/别的版本写下的、本机设置里没有的 ID。
 *
 * 第三种必须能**原样通读通写**。旧版本这里是一个字面量联合，`parsePath` 遇到不认识的值会把
 * `type` 置为 `null` 并**跳过整条路径** —— 用户只要打开一次别人的文件再保存，
 * 那条路径就永久消失了（而且只有一条 warning）。这与地形/标记图标曾经的问题同类，
 * 只是后果更重：丢的是**整个对象**而不是一个字段。现在一律保留，回退视觉由绘制层负责
 * （见 `pathTypeCatalog.resolvePathType`，它永不返回空）。
 */
export type PathType = string

/**
 * 路径端点样式（存进文件的画法参数之一）。
 *
 * 为什么这组词表定义在**数据层**：它要被写进 `.map.md`（`paths[].cap`），
 * 而"文件里能存什么"由本模块说了算（与 `GeometryMode` 放在 core 里同一个道理）。
 */
export type PathCapStyle = 'butt' | 'round' | 'square'
export const PATH_CAP_STYLES: readonly PathCapStyle[] = ['butt', 'round', 'square']

/** 路径连接样式 */
export type PathJoinStyle = 'miter' | 'round' | 'bevel'
export const PATH_JOIN_STYLES: readonly PathJoinStyle[] = ['miter', 'round', 'bevel']

/** 位标志：1=旋转，2=镜像，4=变体（比独立字段省体积） */
/**
 * 地形标识。
 *
 * 刻意**不是** `TerrainType` 的字面量联合：文件里可能出现
 * - 内置 9 种（`forest` …）；
 * - 本插件的自定义地形（`custom:xxx`，由用户在设置里定义）；
 * - 别的库/别的版本写下的、本机设置里没有的 ID。
 *
 * 第三种必须能**原样通读通写**：把不认识的格子丢掉，等于用户一保存就永久删掉自己的数据
 * （而且没有任何报错）。所以这里放宽成字符串，由绘制层负责回退视觉（见 `terrainCatalog.ts`）。
 */
export type TerrainId = string

export interface TerrainCell {
  t: TerrainId
  f?: number
  c?: string
}

export interface MapMarker {
  id: string
  label: string
  p: [number, number]
  icon: MarkerId
  c?: string
  link?: string
  desc?: string
}

export interface MapPath {
  id: string
  type: PathType
  pts: Array<[number, number]>
  width: number
  color: string
  /** 可选关联笔记；未设置时 Base 导航回地图文档 */
  link?: string
  /** 名称（河流名/道路名），渲染在折线中点旁边 */
  label?: string
  dash?: number[]
  taper?: boolean
  smooth?: boolean
  /**
   * 端点样式 / 连接样式。
   *
   * 与 `width` / `color` / `dash` 同一口径：**画的时候就把当时的设置存进文件**，
   * 之后改设置不会改动这条路径。缺字段 = 老数据 = 绘制层用 `round`，
   * 那正是升级前硬编码的值，所以旧地图的观感逐像素不变。
   */
  cap?: PathCapStyle
  join?: PathJoinStyle
  /**
   * 几何模式：`interior`（默认，穿过格子内部）或 `edge`（沿六边形边）。
   *
   * ⚠️ **几何本身在提交时就已经转换好了**（`pts` 就是沿格边的顶点序列），
   * 这个字段记录"当初按哪种模式画的"，用于界面回显（与将来的"重新吸附"）；
   * 渲染不需要读它。缺省即 `interior`，因此旧地图完全兼容。
   */
  mode?: GeometryMode
}

export interface MapRegion {
  id: string
  label: string
  pts: Array<[number, number]>
  color: string
  opacity: number
  borderColor?: string
  borderWidth?: number
  link?: string
  /** 见 `MapPath.mode` */
  mode?: GeometryMode
}

export interface MapLabel {
  id: string
  text: string
  p: [number, number]
  size?: number
  color?: string
  bold?: boolean
  italic?: boolean
  rotation?: number
  link?: string
}

export interface MapDocument {
  version: number
  grid: GridSpec
  /** 键为 `"q_r"` 的稀疏地形表 */
  terrain: Record<string, TerrainCell>
  paths: MapPath[]
  regions: MapRegion[]
  markers: MapMarker[]
  labels: MapLabel[]
  settings?: { colorPalette?: Record<string, string> }
  /** 本插件未知的顶层字段，原样保留以便前向兼容 */
  extra?: Record<string, unknown>
}

export type IssueLevel = 'error' | 'warning'

export interface MapDocumentIssue {
  level: IssueLevel
  /** 出问题的字段路径，便于在报告里精确定位 */
  path: string
  message: string
}

export interface ParseResult {
  ok: boolean
  document: MapDocument | null
  issues: MapDocumentIssue[]
}

// ---------------------------------------------------------------- 基础判断

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function readPoint2(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
    return [value[0], value[1]]
  }
  if (isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
    return [value.x, value.y]
  }
  return null
}

function readPointList(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null
  const out: Array<[number, number]> = []
  for (const item of value) {
    const point = readPoint2(item)
    if (point === null) return null
    out.push(point)
  }
  return out.length > 0 ? out : null
}

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'version',
  'grid',
  'terrain',
  'paths',
  'regions',
  'markers',
  'labels',
  'settings',
])

// ---------------------------------------------------------------- 解析

function parseGrid(value: unknown, issues: MapDocumentIssue[]): GridSpec | null {
  if (!isRecord(value)) {
    issues.push({ level: 'error', path: 'grid', message: '缺少 grid 或不是对象' })
    return null
  }
  if (value.kind !== 'hex') {
    issues.push({ level: 'error', path: 'grid.kind', message: `只支持 kind="hex"，实际为 ${JSON.stringify(value.kind)}` })
    return null
  }
  const orientation = value.orientation
  if (orientation !== 'pointy' && orientation !== 'flat') {
    issues.push({
      level: 'error',
      path: 'grid.orientation',
      message: `orientation 必须是 "pointy" 或 "flat"，实际为 ${JSON.stringify(orientation)}`,
    })
    return null
  }
  const size = value.size
  if (!isFiniteNumber(size) || size <= 0) {
    issues.push({ level: 'error', path: 'grid.size', message: `size 必须是正数，实际为 ${JSON.stringify(size)}` })
    return null
  }
  const origin = readPoint2(value.origin) ?? [0, 0]
  return { kind: 'hex', orientation, size, origin }
}

/**
 * 文件里的地形 ID 能长什么样 —— 比"用户能新建什么"**宽松得多**。
 *
 * 这里只挡住真正不可能当 ID 的东西（空串、空白、控制字符、超长），
 * 因为解析的职责是**尽量别丢数据**：设置里删掉一个自定义地形之后，
 * 旧地图里的 `custom:xxx` 仍然要能被读出来、原样写回去（只是画成回退视觉）。
 * 严格规则（前缀 + `^[a-z][a-z0-9_-]{1,31}$`）只用于用户新建，见 `terrainCatalog.ts`。
 */
function isStorableTerrainId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 64) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f]/.test(value)
}

function parseTerrain(value: unknown, issues: MapDocumentIssue[]): Record<string, TerrainCell> {
  const out: Record<string, TerrainCell> = {}
  if (value === undefined) return out
  if (!isRecord(value)) {
    issues.push({ level: 'warning', path: 'terrain', message: 'terrain 不是对象，已忽略' })
    return out
  }
  for (const [key, raw] of Object.entries(value)) {
    if (parseCellKey(key) === null) {
      issues.push({ level: 'warning', path: `terrain.${key}`, message: '键不是 "q_r" 形式的整数格，已跳过' })
      continue
    }
    if (!isRecord(raw)) {
      issues.push({ level: 'warning', path: `terrain.${key}`, message: '不是对象，已跳过' })
      continue
    }
    const type = raw.t
    if (!isStorableTerrainId(type)) {
      issues.push({
        level: 'warning',
        path: `terrain.${key}.t`,
        message: `地形标识 ${JSON.stringify(type)} 不是合法字符串，已跳过该格`,
      })
      continue
    }
    // 不认识的 ID **保留**（只告警）：丢掉它 = 用户一保存就永久删数据。
    // 绘制层对未知 ID 有回退视觉，所以保留是安全的，而丢弃是不可逆的。
    //
    // 只对"既不是内置、也不是 custom: 命名空间"的 ID 告警：解析层读不到用户设置，
    // 因此它**无权**判断某个 `custom:xxx` 是否已定义（那是设置的事），
    // 而"自定义地形被用户删掉了"这种情况由绘制层一次性告警（见 MapOverlay）。
    if (!TERRAIN_TYPES.includes(type as TerrainType) && !type.startsWith('custom:')) {
      issues.push({
        level: 'warning',
        path: `terrain.${key}.t`,
        message: `未知地形 ${JSON.stringify(type)}，已保留该格（按回退样式绘制；内置类型：${TERRAIN_TYPES.join('/')}）`,
      })
    }
    const cell: TerrainCell = { t: type }
    if (isFiniteNumber(raw.f) && raw.f !== 0) cell.f = Math.trunc(raw.f)
    if (isNonEmptyString(raw.c)) cell.c = raw.c
    out[key] = cell
  }
  return out
}

function parseArrayField<T>(
  value: unknown,
  field: string,
  issues: MapDocumentIssue[],
  parseOne: (raw: Record<string, unknown>, path: string, issues: MapDocumentIssue[]) => T | null,
): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    issues.push({ level: 'warning', path: field, message: `${field} 不是数组，已忽略` })
    return []
  }
  const out: T[] = []
  const seenIds = new Set<string>()
  value.forEach((item, index) => {
    const path = `${field}[${index}]`
    if (!isRecord(item)) {
      issues.push({ level: 'warning', path, message: '不是对象，已跳过' })
      return
    }
    const id = item.id
    if (isNonEmptyString(id)) {
      if (seenIds.has(id)) {
        issues.push({ level: 'warning', path: `${path}.id`, message: `id "${id}" 重复，已跳过该条目` })
        return
      }
      seenIds.add(id)
    }
    const parsed = parseOne(item, path, issues)
    if (parsed !== null) out.push(parsed)
  })
  return out
}

/**
 * 见 `isStorableTerrainId`：解析层只判断"能不能存成字符串"，不判断"认不认识"。
 *
 * 严格规则（前缀 + `^[a-z][a-z0-9_-]{1,31}$`）只用于用户新建自定义标记，
 * 见 `markerCatalog.ts` 的 `markerIdProblem`。
 */
function isStorableMarkerId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 64) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f]/.test(value)
}

/**
 * 读取标记图标标识。
 *
 * **不认识的图标名一律保留**（只告警）：把未知值改写成内置 `town`，
 * 等于用户一保存就永久抹掉自己（或别的插件）写下的图标，且不可逆。
 * 绘制层对未知 ID 有回退视觉（`resolveMarkerStyle` 永远返回非空），所以保留是安全的。
 *
 * 只对"既不是内置、也不在 `custom:` 命名空间"的 ID 告警：解析层读不到用户设置，
 * 无权判断某个 `custom:xxx` 是否已定义；"自定义标记被用户删掉了"由绘制层告警。
 */
function readMarkerId(value: unknown, path: string, issues: MapDocumentIssue[]): MarkerId {
  if (isStorableMarkerId(value)) {
    if (!MARKER_ICONS.includes(value as MarkerIcon) && !value.startsWith('custom:')) {
      issues.push({
        level: 'warning',
        path: `${path}.icon`,
        message: `未知图标 ${JSON.stringify(value)}，已保留（按回退样式绘制；内置图标：${MARKER_ICONS.join('/')}）`,
      })
    }
    return value
  }
  if (value !== undefined) {
    issues.push({
      level: 'warning',
      path: `${path}.icon`,
      message: `图标标识 ${JSON.stringify(value)} 不是合法字符串，已回退为 town`,
    })
  }
  return 'town'
}

function parseMarker(raw: Record<string, unknown>, path: string, issues: MapDocumentIssue[]): MapMarker | null {
  const id = isNonEmptyString(raw.id) ? raw.id : null
  const label = isNonEmptyString(raw.label) ? raw.label : null
  const p = readPoint2(raw.p)
  if (id === null || label === null || p === null) {
    issues.push({ level: 'warning', path, message: '标记缺少 id / label / 有效坐标 p，已跳过' })
    return null
  }
  const icon = readMarkerId(raw.icon, path, issues)
  const marker: MapMarker = { id, label, p, icon }
  if (isNonEmptyString(raw.c)) marker.c = raw.c
  if (isNonEmptyString(raw.link)) marker.link = raw.link
  if (isNonEmptyString(raw.desc)) marker.desc = raw.desc
  return marker
}

/**
 * 读取几何模式。
 *
 * 未知取值一律回退为 `interior`（自由模式）：这是旧地图与新地图都能渲染的安全默认，
 * 也不会因为手工编辑写错一个词就让形状消失。
 */
function readGeometryMode(value: unknown): GeometryMode {
  if (value === 'edge' || value === 'edge-step') return value
  return 'interior'
}

/**
 * 见 `isStorableTerrainId`：解析层只判断"能不能存成字符串"，不判断"认不认识"。
 *
 * 严格规则（前缀 + `^[a-z][a-z0-9_-]{1,31}$`）只用于用户新建自定义类型，
 * 见 `pathTypeCatalog.normalizePathTypeId`。
 */
function isStorablePathTypeId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 64) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f]/.test(value)
}

/**
 * 读取路径类型。
 *
 * **不认识的类型一律保留**（只告警）：旧版本遇到这种情况会把整条路径丢掉
 * （`type = null` → `return null`），用户打开一次别人的地图再保存就永久丢数据。
 * 绘制层对未知 ID 有回退视觉（`resolvePathType` 永不返回空），所以保留是安全的，丢弃不是。
 *
 * 只对"既不是内置、也不在 `custom:` 命名空间"的 ID 告警：解析层读不到用户设置，
 * 无权判断某个 `custom:xxx` 是否已定义；"自定义类型被用户删掉了"由绘制层告警。
 */
function readPathType(value: unknown, path: string, issues: MapDocumentIssue[]): PathType {
  if (isStorablePathTypeId(value)) {
    if (!PATH_TYPES.includes(value as BuiltinPathType) && !value.startsWith('custom:')) {
      issues.push({
        level: 'warning',
        path: `${path}.type`,
        message: `未知路径类型 ${JSON.stringify(value)}，已保留（按回退样式绘制；内置类型：${PATH_TYPES.join('/')}）`,
      })
    }
    return value
  }
  if (value !== undefined) {
    issues.push({
      level: 'warning',
      path: `${path}.type`,
      message: `路径类型 ${JSON.stringify(value)} 不是合法字符串，已回退为 river`,
    })
  }
  return 'river'
}

/** 读取端点 / 连接样式：未知取值不写进结果（绘制层回退到 `round`），并给出原因 */
function readCap(value: unknown, path: string, issues: MapDocumentIssue[]): PathCapStyle | undefined {
  if (value === undefined || value === null) return undefined
  if (PATH_CAP_STYLES.includes(value as PathCapStyle)) return value as PathCapStyle
  issues.push({
    level: 'warning',
    path: `${path}.cap`,
    message: `端点样式 ${JSON.stringify(value)} 不可识别，已回退为 round（可用：${PATH_CAP_STYLES.join('/')}）`,
  })
  return undefined
}

function readJoin(value: unknown, path: string, issues: MapDocumentIssue[]): PathJoinStyle | undefined {
  if (value === undefined || value === null) return undefined
  if (PATH_JOIN_STYLES.includes(value as PathJoinStyle)) return value as PathJoinStyle
  issues.push({
    level: 'warning',
    path: `${path}.join`,
    message: `连接样式 ${JSON.stringify(value)} 不可识别，已回退为 round（可用：${PATH_JOIN_STYLES.join('/')}）`,
  })
  return undefined
}

function parsePath(raw: Record<string, unknown>, path: string, issues: MapDocumentIssue[]): MapPath | null {
  const id = isNonEmptyString(raw.id) ? raw.id : null
  const type = readPathType(raw.type, path, issues)
  const pts = readPointList(raw.pts)
  if (id === null || pts === null) {
    issues.push({ level: 'warning', path, message: '路径缺少 id / 至少两个有效点，已跳过' })
    return null
  }
  const width = isFiniteNumber(raw.width) && raw.width > 0 ? raw.width : 4
  if (!isFiniteNumber(raw.width)) {
    issues.push({ level: 'warning', path: `${path}.width`, message: '缺少或非法 width，已回退为 4' })
  }
  const path2: MapPath = {
    id,
    type,
    pts,
    width,
    color: isNonEmptyString(raw.color) ? raw.color : '#8ab4f8',
  }
  if (isNonEmptyString(raw.label)) path2.label = raw.label
  if (isNonEmptyString(raw.link)) path2.link = raw.link
  if (Array.isArray(raw.dash) && raw.dash.every(isFiniteNumber)) path2.dash = raw.dash as number[]
  if (raw.taper === true) path2.taper = true
  if (raw.smooth === true) path2.smooth = true
  const cap = readCap(raw.cap, path, issues)
  if (cap !== undefined) path2.cap = cap
  const join = readJoin(raw.join, path, issues)
  if (join !== undefined) path2.join = join
  path2.mode = readGeometryMode(raw.mode)
  return path2
}

function parseRegion(raw: Record<string, unknown>, path: string, issues: MapDocumentIssue[]): MapRegion | null {
  const id = isNonEmptyString(raw.id) ? raw.id : null
  const pts = readPointList(raw.pts)
  if (id === null || pts === null || pts.length < 3) {
    issues.push({ level: 'warning', path, message: '区域缺少 id 或有效顶点（至少 3 个），已跳过' })
    return null
  }
  const region: MapRegion = {
    id,
    label: isNonEmptyString(raw.label) ? raw.label : '',
    pts,
    color: isNonEmptyString(raw.color) ? raw.color : '#44cf6e',
    opacity: isFiniteNumber(raw.opacity) ? Math.min(1, Math.max(0, raw.opacity)) : 0.2,
  }
  if (isNonEmptyString(raw.borderColor)) region.borderColor = raw.borderColor
  if (isFiniteNumber(raw.borderWidth)) region.borderWidth = raw.borderWidth
  if (isNonEmptyString(raw.link)) region.link = raw.link
  region.mode = readGeometryMode(raw.mode)
  return region
}

function parseLabel(raw: Record<string, unknown>, path: string, issues: MapDocumentIssue[]): MapLabel | null {
  const id = isNonEmptyString(raw.id) ? raw.id : null
  const text = isNonEmptyString(raw.text) ? raw.text : null
  const p = readPoint2(raw.p)
  if (id === null || text === null || p === null) {
    issues.push({ level: 'warning', path, message: '文字标注缺少 id / text / 有效坐标，已跳过' })
    return null
  }
  const label: MapLabel = { id, text, p }
  if (isFiniteNumber(raw.size)) label.size = raw.size
  if (isNonEmptyString(raw.color)) label.color = raw.color
  if (raw.bold === true) label.bold = true
  if (raw.italic === true) label.italic = true
  if (isFiniteNumber(raw.rotation)) label.rotation = raw.rotation
  if (isNonEmptyString(raw.link)) label.link = raw.link
  return label
}

/**
 * 解析地图文档。
 *
 * - `ok: false` 表示结构性问题（版本不可识别、grid 不可用）——调用方应拒绝加载；
 * - `ok: true` 且带 warning 时，问题条目已被跳过，其余数据可用。
 */
export function parseMapDocument(input: unknown): ParseResult {
  const issues: MapDocumentIssue[] = []

  if (!isRecord(input)) {
    issues.push({ level: 'error', path: '', message: '地图数据不是对象' })
    return { ok: false, document: null, issues }
  }

  const version = input.version
  if (!isFiniteNumber(version) || !Number.isInteger(version) || version < 1) {
    issues.push({ level: 'error', path: 'version', message: `缺少合法的整数 version，实际为 ${JSON.stringify(version)}` })
    return { ok: false, document: null, issues }
  }
  if (version > MAP_DOCUMENT_VERSION) {
    issues.push({
      level: 'error',
      path: 'version',
      message: `文档版本 ${version} 高于本插件支持的 ${MAP_DOCUMENT_VERSION}：将只读打开，绝不写回（避免丢弃新版字段）`,
    })
    return { ok: false, document: null, issues }
  }

  const grid = parseGrid(input.grid, issues)
  if (grid === null) return { ok: false, document: null, issues }

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) extra[key] = value
  }

  let settings: MapDocument['settings']
  if (isRecord(input.settings)) {
    const palette = input.settings.colorPalette
    settings = isRecord(palette)
      ? { colorPalette: Object.fromEntries(Object.entries(palette).filter(([, v]) => typeof v === 'string')) as Record<string, string> }
      : {}
  }

  const document: MapDocument = {
    version,
    grid,
    terrain: parseTerrain(input.terrain, issues),
    paths: parseArrayField(input.paths, 'paths', issues, parsePath),
    regions: parseArrayField(input.regions, 'regions', issues, parseRegion),
    markers: parseArrayField(input.markers, 'markers', issues, parseMarker),
    labels: parseArrayField(input.labels, 'labels', issues, parseLabel),
  }
  if (settings !== undefined) document.settings = settings
  if (Object.keys(extra).length > 0) document.extra = extra

  return { ok: true, document, issues }
}

// ---------------------------------------------------------------- 序列化

/** 地形按键排序（先 r 后 q），让 Git diff 稳定且人类可读 */
function sortedTerrainEntries(terrain: Record<string, TerrainCell>): Array<[string, TerrainCell]> {
  const entries = Object.entries(terrain).map(([key, cell]) => {
    const axial = parseCellKey(key)
    return { key, cell, q: axial?.q ?? 0, r: axial?.r ?? 0 }
  })
  entries.sort((a, b) => (a.r === b.r ? a.q - b.q : a.r - b.r))
  return entries.map((entry) => [entry.key, entry.cell])
}

/** 数组：每项一行（便于 diff），项内紧凑 */
function serializeArray(items: readonly unknown[], indent: number): string {
  if (items.length === 0) return '[]'
  const inner = ' '.repeat(indent + 2)
  const lines = items.map((item, index) => `${inner}${JSON.stringify(item)}${index === items.length - 1 ? '' : ','}`)
  return ['[', ...lines, `${' '.repeat(indent)}]`].join('\n')
}

/**
 * 地形表：**每格一行、格内紧凑**。
 *
 * 为什么不用 `JSON.stringify(x, null, 2)`：实测那样每格要 42.6 字节，
 * 6400 格就有 273 KB。这里的写法去掉格内的 `": "` 与换行缩进后约 28 字节/格，
 * 同时仍然是"一格一行"——Git diff 能精确到格，手工改一个格也只动一行。
 * 格的键只有 `q_r`（数字/负号/下划线），值用 JSON.stringify 保证转义正确。
 */
function serializeTerrain(terrain: Record<string, TerrainCell>, indent: number): string {
  const entries = sortedTerrainEntries(terrain)
  if (entries.length === 0) return '{}'
  const inner = ' '.repeat(indent + 2)
  const lines = entries.map(
    ([key, cell], index) => `${inner}${JSON.stringify(key)}: ${JSON.stringify(cell)}${index === entries.length - 1 ? '' : ','}`,
  )
  return ['{', ...lines, `${' '.repeat(indent)}}`].join('\n')
}

/**
 * 序列化为 JSON 文本。
 *
 * 结构保持缩进可读（每格/每个标记一行），格内与数组项内紧凑以控制体积。
 * 顺序固定：未知顶层字段在前、随后是已知字段、地形按键排序 —— 让 Git diff 稳定。
 * 「地图状态」命令会报告实际体积。
 */
export function serializeMapDocument(document: MapDocument, indent = 2): string {
  const pad = ' '.repeat(indent)
  const body: string[] = []
  const push = (key: string, value: string): void => {
    body.push(`${pad}${JSON.stringify(key)}: ${value}`)
  }

  // 未知字段先写，已知字段后写：保证已知字段不会被同名的未知字段覆盖
  if (document.extra) {
    for (const [key, value] of Object.entries(document.extra)) {
      if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue
      push(key, JSON.stringify(value))
    }
  }
  push('version', JSON.stringify(document.version))
  push('grid', JSON.stringify(document.grid))
  push('terrain', serializeTerrain(document.terrain, indent))
  push('paths', serializeArray(document.paths, indent))
  push('regions', serializeArray(document.regions, indent))
  push('markers', serializeArray(document.markers, indent))
  push('labels', serializeArray(document.labels, indent))
  if (document.settings) push('settings', JSON.stringify(document.settings))

  return `{\n${body.join(',\n')}\n}`
}

export function createEmptyMapDocument(options: {
  orientation?: GridSpec['orientation']
  size?: number
  origin?: [number, number]
}): MapDocument {
  return {
    version: MAP_DOCUMENT_VERSION,
    grid: {
      kind: 'hex',
      orientation: options.orientation ?? 'pointy',
      size: options.size ?? 40,
      origin: options.origin ?? [0, 0],
    },
    terrain: {},
    paths: [],
    regions: [],
    markers: [],
    labels: [],
  }
}

/** 粗略统计，供「地图状态」命令与诊断报告使用 */
export function summarizeMapDocument(document: MapDocument): {
  cells: number
  markers: number
  paths: number
  regions: number
  labels: number
  terrainBreakdown: Array<{ type: TerrainId; count: number }>
} {
  const breakdown = new Map<TerrainId, number>()
  for (const cell of Object.values(document.terrain)) {
    breakdown.set(cell.t, (breakdown.get(cell.t) ?? 0) + 1)
  }
  const terrainBreakdown = [...breakdown.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
  return {
    cells: Object.keys(document.terrain).length,
    markers: document.markers.length,
    paths: document.paths.length,
    regions: document.regions.length,
    labels: document.labels.length,
    terrainBreakdown,
  }
}
