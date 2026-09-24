/**
 * 自定义资源的"定义文件"：导出成一份 JSON，之后可以导入到别的库或分享给别人。
 *
 * 为什么值得单独一个模块：
 * 1. **导入是唯一会让"外部内容"进入用户设置的入口**，也是最容易造成不可逆损失的动作
 *    （搞错了就把用户自己配好的东西覆盖掉）。所以校验必须逐条给出**可读原因**，
 *    而不是"导入失败"四个字；冲突策略必须是**显式选择过的**，并且写在这里：
 *     **同 ID 时保留用户现有的定义，不覆盖**（导入是"补充"，不是"替换"）。
 * 2. **格式要能长大**。文件里带 `version`，遇到来自更新版本的文件**明确拒绝**并告诉用户升级插件，
 *    而不是"尽力解析" —— 后者会把新字段静默丢掉，用户以为导入成功了。
 * 3. 纯函数：不做任何 IO。读哪个文件、写到哪个路径由调用方决定（于是可单测）。
 *
 * 数据校验**复用各目录自己的那一套**（`validateCustomTerrainInput` /
 * `validateCustomMarkerInput` / `validateCustomPathTypeInput`），不在这里再写一遍规则 ——
 * 两套规则必然分叉，而分叉的后果是"设置页能加的，导入却加不进来"。
 *
 * ## 段（section）与"缺失 ≠ 清空"
 *
 * 文件里的四类定义各占一段。**一段缺失与一段为空是两件不同的事**：
 * - 缺失：这份文件根本没提这件事（v1 文件就没有标记与路径类型）→ 导入时**保持用户现有设置不动**；
 * - 为空：文件里明确写了"没有"（`"markers": []`）→ 合并结果自然也是什么都不加。
 * 解析结果里的 `sections` 记录"文件里真的出现过哪几段"，合并只看它。
 * 这条规则是"导入绝不删东西"的技术保证：没有它，一个老文件就能把用户的标记定义清空。
 *
 * ## 版本策略
 *
 * `version` 停在 **2**（它同时带 `markers` / `pathTypes` / `regionTypes` 三段）。
 * 解析侧**接受 1 与 2**：v1 视为"没有后面几段"，于是老文件仍然能导入（回归项，测试里钉死）。
 *
 * 为什么 `regionTypes` 加进来时**不**把版本升到 3：
 * v2 是本轮开发周期里刚引入、**还没有发布给任何用户**的格式 —— 世上不存在"旧版插件写下的
 * v2 文件"，因此没有需要区分的历史包袱；升到 v3 只会凭空制造一个版本号，
 * 让以后读代码的人以为 v2 曾经对外发布过。
 * ⚠️ 这条判断的**前提**是"v2 未发布"：v2 一旦随正式版本发出去，
 * 之后任何字段变化都必须老实升版本号（否则旧插件读新文件时会静默丢字段）。
 *
 * 比当前支持更高的版本仍**明确拒绝**并给出升级提示 —— 新字段我们看不懂，
 * "尽力解析"等于骗用户说导入成功了。
 */

import {
  MAX_CUSTOM_MARKERS,
  validateCustomMarkerInput,
  type CustomMarker,
} from './markerCatalog.ts'
import {
  MAX_CUSTOM_PATH_TYPES,
  customPathTypeEntries,
  isBuiltinPathType,
  normalizePathTypeKind,
  validateCustomPathTypeInput,
  type PathTypeEntry,
} from './pathTypeCatalog.ts'
import { describePathDashProblem } from './pathStyleSettings.ts'
import {
  MAX_CUSTOM_REGION_TYPES,
  customRegionTypeEntries,
  isBuiltinRegionType,
  validateCustomRegionTypeInput,
  type RegionTypeEntry,
} from './regionTypeCatalog.ts'
import {
  MAX_CUSTOM_TERRAINS,
  validateCustomTerrainInput,
  type CustomTerrain,
} from './terrainCatalog.ts'

export const RESOURCE_BUNDLE_VERSION = 2

/** 仍然接受的最低版本：v1 文件只带地形，导入时不动用户的标记、路径类型与区域类型 */
export const MIN_RESOURCE_BUNDLE_VERSION = 1

/** 文件里的四个段（名字与 JSON 字段一致，便于把"哪一段"直接显示给用户） */
export type BundleSection = 'terrains' | 'markers' | 'pathTypes' | 'regionTypes'

export const BUNDLE_SECTION_LABELS: Record<BundleSection, string> = {
  terrains: '地形',
  markers: '标记',
  pathTypes: '路径类型',
  regionTypes: '区域类型',
}

export interface ResourceBundle {
  version: number
  /** 生成者信息：只用于排查"这份文件是谁、什么时候导出的" */
  generator?: string
  exportedAt?: string
  terrains: CustomTerrain[]
  markers: CustomMarker[]
  /**
   * **只含自定义路径类型**（内置 4 种不进文件）。
   *
   * 为什么内置的不导出：内置类型的 ID 在每个人的库里都存在，导出它们在导入侧
   * 只会得到一串"已有同 ID，保留现有的"—— 既带不走任何东西，又让用户以为导入失败。
   * 代价是"内置类型的画笔参数（颜色/线宽）不随文件分享"，这是一条明确的取舍，
   * 而不是遗漏（要分享整套样式需要另一条冲突规则，属于以后的功能）。
   */
  pathTypes: PathTypeEntry[]
  /**
   * **只含自定义区域类型**（内置 6 种不进文件）。
   *
   * 与内置路径类型同一条取舍、同一个理由：内置类型的 ID 在每个人的库里都存在
   * （`realm` / `empire` …由代码定义），导出它们在导入侧只会得到一串"已有同 ID，保留现有的"——
   * 既带不走任何东西，又让用户以为导入失败。
   * 代价同样是"内置区域类型的画笔参数（颜色/不透明度/边框）不随文件分享"，这是取舍不是遗漏。
   */
  regionTypes: RegionTypeEntry[]
}

/** 解析结果：`sections` 记录文件里**真的出现过**哪几段（缺失的段不许动用户设置） */
export interface ParsedBundle extends ResourceBundle {
  sections: BundleSection[]
}

export interface BundleSkip {
  /** 被跳过的条目 ID（拿不到 ID 时用它在数组里的序号，例如 `#3`） */
  id: string
  reason: string
}

export type ParseBundleResult =
  | { ok: true; bundle: ParsedBundle; skipped: BundleSkip[]; notes: BundleNote[] }
  | { ok: false; reason: string }

/**
 * "条目进来了，但有一项被本机回退掉了"的记录（与 `BundleSkip` 分开计数）。
 *
 * 为什么要有它：各目录的校验对**字形名**是白名单（只认内置那几种），文件里写了一个
 * 本机不认识的字形名时，条目会被收下、字形被换成回退视觉。这件事**不改变条目是否导入**，
 * 所以不能记进 `skipped`（那会让用户以为"这条没进来"）；但它确实是"有一处变了"，
 * 悄无声息地发生才是最糟的 —— 于是单独记一条给用户看。
 */
export interface BundleNote {
  id: string
  reason: string
}

/** 导出输入：四类自定义定义 */
export interface ResourceBundleInput {
  terrains: readonly CustomTerrain[]
  markers?: readonly CustomMarker[]
  pathTypes?: readonly PathTypeEntry[]
  regionTypes?: readonly RegionTypeEntry[]
}

export interface BuildBundleOptions {
  generator?: string
  now?: Date
}

/** 导出：把当前自定义地形 / 标记 / 路径类型 / 区域类型打包成一份定义文件的内容 */
export function buildResourceBundle(input: ResourceBundleInput, options: BuildBundleOptions = {}): ResourceBundle {
  const now = options.now ?? new Date()
  return {
    version: RESOURCE_BUNDLE_VERSION,
    ...(options.generator !== undefined ? { generator: options.generator } : {}),
    exportedAt: now.toISOString(),
    terrains: input.terrains.map((terrain) => ({ ...terrain })),
    markers: (input.markers ?? []).map((marker) => ({ ...marker })),
    // 内置类型由代码定义、不随文件走（见 ResourceBundle.pathTypes 的注释）
    pathTypes: customPathTypeEntries(input.pathTypes ?? []).map((entry) => ({
      ...entry,
      params: { ...entry.params, dash: [...entry.params.dash] },
    })),
    // 同上，内置 6 种区域类型也不进文件
    regionTypes: customRegionTypeEntries(input.regionTypes ?? []).map((entry) => ({
      ...entry,
      params: { ...entry.params, borderDash: [...entry.params.borderDash] },
    })),
  }
}

/**
 * 序列化成文本。
 *
 * 键顺序固定（手写而不是 `JSON.stringify(bundle)`）：导出文件是要进 Git、要被 diff 的，
 * 稳定的字段顺序能让"只改了一条地形"在 diff 里只显示一行。
 *
 * 四段**永远都写出来**（哪怕是空数组）：这样"我什么都没自定义"导出的文件也是一份
 * 自解释的文件，重新导入时是"0 新增"的一步干净操作，而不会被当成"这不像本插件的文件"。
 */
export function serializeResourceBundle(bundle: ResourceBundle): string {
  const lines: string[] = []
  lines.push('{')
  lines.push(`  "version": ${JSON.stringify(bundle.version)},`)
  if (bundle.generator !== undefined) lines.push(`  "generator": ${JSON.stringify(bundle.generator)},`)
  if (bundle.exportedAt !== undefined) lines.push(`  "exportedAt": ${JSON.stringify(bundle.exportedAt)},`)
  lines.push('  "terrains": [')
  bundle.terrains.forEach((terrain, index) => {
    const fields = [
      `"id": ${JSON.stringify(terrain.id)}`,
      `"label": ${JSON.stringify(terrain.label)}`,
      `"color": ${JSON.stringify(terrain.color)}`,
      `"glyph": ${JSON.stringify(terrain.glyph)}`,
      `"imagePath": ${JSON.stringify(terrain.imagePath)}`,
      // 模式必须一起带走：否则"图片模式下配好的图"导入到别处可能被当成调色模式而画不出来。
      // 旧格式没有这个字段，导入侧的迁移会按"有图就是图片模式"推断，所以加了它不会破坏兼容。
      `"mode": ${JSON.stringify(terrain.mode)}`,
      // 布局同样要带走：否则"整片一张（连通区域）"导入到别处会退回单格铺图 —— 看起来像导入失败。
      // 旧格式缺这个字段时推断为 `cell`（与升级前一致），所以也不破坏兼容。
      `"imageLayout": ${JSON.stringify(terrain.imageLayout)}`,
    ]
    const comma = index === bundle.terrains.length - 1 ? '' : ','
    lines.push(`    { ${fields.join(', ')} }${comma}`)
  })
  lines.push('  ],')
  lines.push('  "markers": [')
  bundle.markers.forEach((marker, index) => {
    const fields = [
      `"id": ${JSON.stringify(marker.id)}`,
      `"label": ${JSON.stringify(marker.label)}`,
      // 字形与图片路径**两个都带走**：它们是"两套视觉"，模式只是选择用哪一套。
      // 只带当前模式那一套的话，导入方切一下模式就会发现配置是空的（切回去也没了）。
      `"icon": ${JSON.stringify(marker.icon)}`,
      `"imagePath": ${JSON.stringify(marker.imagePath)}`,
      `"mode": ${JSON.stringify(marker.mode)}`,
    ]
    const comma = index === bundle.markers.length - 1 ? '' : ','
    lines.push(`    { ${fields.join(', ')} }${comma}`)
  })
  lines.push('  ],')
  lines.push('  "pathTypes": [')
  bundle.pathTypes.forEach((entry, index) => {
    const params = [
      `"color": ${JSON.stringify(entry.params.color)}`,
      `"width": ${JSON.stringify(entry.params.width)}`,
      `"dash": ${JSON.stringify(entry.params.dash)}`,
      `"taper": ${JSON.stringify(entry.params.taper)}`,
      `"smooth": ${JSON.stringify(entry.params.smooth)}`,
      `"cap": ${JSON.stringify(entry.params.cap)}`,
      `"join": ${JSON.stringify(entry.params.join)}`,
    ]
    const fields = [
      `"id": ${JSON.stringify(entry.id)}`,
      `"label": ${JSON.stringify(entry.label)}`,
      `"kind": ${JSON.stringify(entry.kind)}`,
      `"params": { ${params.join(', ')} }`,
    ]
    const comma = index === bundle.pathTypes.length - 1 ? '' : ','
    lines.push(`    { ${fields.join(', ')} }${comma}`)
  })
  lines.push('  ],')
  lines.push('  "regionTypes": [')
  bundle.regionTypes.forEach((entry, index) => {
    const params = [
      `"color": ${JSON.stringify(entry.params.color)}`,
      `"opacity": ${JSON.stringify(entry.params.opacity)}`,
      // `null` 在这里是**有意义的值**（边框跟随填充色），与"没写这个字段"不是一回事：
      // 丢掉它会让导入方拿到一个颜色被写死的边框，改填充色时边框不动。
      `"borderColor": ${JSON.stringify(entry.params.borderColor)}`,
      `"borderWidth": ${JSON.stringify(entry.params.borderWidth)}`,
      `"borderDash": ${JSON.stringify(entry.params.borderDash)}`,
    ]
    const fields = [
      `"id": ${JSON.stringify(entry.id)}`,
      `"label": ${JSON.stringify(entry.label)}`,
      `"params": { ${params.join(', ')} }`,
    ]
    const comma = index === bundle.regionTypes.length - 1 ? '' : ','
    lines.push(`    { ${fields.join(', ')} }${comma}`)
  })
  lines.push('  ]')
  lines.push('}')
  return `${lines.join('\n')}\n`
}

export interface ParseBundleOptions {
  maxTerrains?: number
  maxMarkers?: number
  maxPathTypes?: number
  maxRegionTypes?: number
}

/** 某一段：取出数组（缺失 → `null`；类型不对 → 可读原因） */
function readSection(
  source: Record<string, unknown>,
  key: BundleSection,
): { ok: true; list: unknown[] | null } | { ok: false; reason: string } {
  const value = source[key]
  if (value === undefined || value === null) return { ok: true, list: null }
  if (!Array.isArray(value)) {
    return { ok: false, reason: `${key} 字段应当是一个数组（现在是一个${typeof value}）。` }
  }
  return { ok: true, list: value }
}

/**
 * 解析一份定义文件。
 *
 * **逐条独立校验**：一条坏数据只丢它自己（与地图文档解析的承诺一致），
 * 并把原因收集到 `skipped` 里让调用方展示 —— 用户需要知道"哪几条没进来、为什么"。
 *
 * 段缺失与段为空是两件事，见文件头注释。
 */
export function parseResourceBundle(text: string, options: ParseBundleOptions = {}): ParseBundleResult {
  const maxTerrains = options.maxTerrains ?? MAX_CUSTOM_TERRAINS
  const maxMarkers = options.maxMarkers ?? MAX_CUSTOM_MARKERS
  const maxPathTypes = options.maxPathTypes ?? MAX_CUSTOM_PATH_TYPES
  const maxRegionTypes = options.maxRegionTypes ?? MAX_CUSTOM_REGION_TYPES
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: '文件是空的，没有可导入的内容。' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      reason:
        '文件内容应当是一个对象（形如 { "version": 2, "terrains": [], "markers": [], "pathTypes": [], "regionTypes": [] }）。',
    }
  }

  const source = raw as Record<string, unknown>
  const version = typeof source.version === 'number' && Number.isFinite(source.version) ? Math.trunc(source.version) : Number.NaN
  if (!Number.isFinite(version) || version < MIN_RESOURCE_BUNDLE_VERSION) {
    return { ok: false, reason: '缺少 version 字段（或它不是正整数）—— 这不像是本插件导出的定义文件。' }
  }
  if (version > RESOURCE_BUNDLE_VERSION) {
    // 明确拒绝而不是"尽力解析"：新版本的字段我们看不懂，静默丢掉等于骗用户说导入成功了
    return {
      ok: false,
      reason: `这份文件来自更新的版本（v${version}），当前插件只认到 v${RESOURCE_BUNDLE_VERSION}。请先升级插件再导入。`,
    }
  }

  const skipped: BundleSkip[] = []
  const notes: BundleNote[] = []
  const sections: BundleSection[] = []

  const terrainSection = readSection(source, 'terrains')
  if (!terrainSection.ok) return { ok: false, reason: terrainSection.reason }
  const markerSection = readSection(source, 'markers')
  if (!markerSection.ok) return { ok: false, reason: markerSection.reason }
  const pathTypeSection = readSection(source, 'pathTypes')
  if (!pathTypeSection.ok) return { ok: false, reason: pathTypeSection.reason }
  const regionTypeSection = readSection(source, 'regionTypes')
  if (!regionTypeSection.ok) return { ok: false, reason: regionTypeSection.reason }

  if (
    terrainSection.list === null &&
    markerSection.list === null &&
    pathTypeSection.list === null &&
    regionTypeSection.list === null
  ) {
    return {
      ok: false,
      reason: '文件里没有 terrains / markers / pathTypes / regionTypes 任何一段 —— 这不像是本插件导出的定义文件。',
    }
  }

  const terrains = terrainSection.list === null ? [] : parseTerrains(terrainSection.list, maxTerrains, skipped, notes)
  const markers = markerSection.list === null ? [] : parseMarkers(markerSection.list, maxMarkers, skipped, notes)
  const pathTypes = pathTypeSection.list === null ? [] : parsePathTypes(pathTypeSection.list, maxPathTypes, skipped)
  const regionTypes =
    regionTypeSection.list === null ? [] : parseRegionTypes(regionTypeSection.list, maxRegionTypes, skipped)
  if (terrainSection.list !== null) sections.push('terrains')
  if (markerSection.list !== null) sections.push('markers')
  if (pathTypeSection.list !== null) sections.push('pathTypes')
  if (regionTypeSection.list !== null) sections.push('regionTypes')

  const total = terrains.length + markers.length + pathTypes.length + regionTypes.length
  if (total === 0 && skipped.length > 0) {
    return { ok: false, reason: `文件里没有一条可用的定义。第一条的原因：${skipped[0]!.reason}` }
  }

  return {
    ok: true,
    bundle: {
      version,
      ...(typeof source.generator === 'string' ? { generator: source.generator } : {}),
      ...(typeof source.exportedAt === 'string' ? { exportedAt: source.exportedAt } : {}),
      terrains,
      markers,
      pathTypes,
      regionTypes,
      sections,
    },
    skipped,
    notes,
  }
}

function parseTerrains(
  list: unknown[],
  max: number,
  skipped: BundleSkip[],
  notes: BundleNote[],
): CustomTerrain[] {
  const out: CustomTerrain[] = []
  const seen = new Set<string>()
  list.forEach((item, index) => {
    // 用与 `validateCustomTerrainInput` 一致的入参形状：缺 id 时由那个函数给出"ID 不能为空"，
    // 这里不重复判断（校验规则只有一份，见文件头注释）
    const input =
      item !== null && typeof item === 'object'
        ? (item as {
            id: unknown
            label?: unknown
            color?: unknown
            glyph?: unknown
            imagePath?: unknown
            mode?: unknown
            imageLayout?: unknown
          })
        : ({ id: undefined } as { id: unknown })
    const result = validateCustomTerrainInput(input)
    if (!result.ok) {
      skipped.push({ id: idOf(item) ?? `#${index + 1}`, reason: result.problem })
      return
    }
    if (seen.has(result.terrain.id)) {
      skipped.push({ id: result.terrain.id, reason: '文件里有重复 ID，只保留先出现的那条' })
      return
    }
    if (out.length >= max) {
      skipped.push({ id: result.terrain.id, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(result.terrain.id)
    // 字形名被回退时**必须说出来**：白名单只认内置那几种，文件里写了别的名字时
    // 条目会被收下、字形换成通用形状（见 `BundleNote` 的注释）
    const rawGlyph = (item as { glyph?: unknown }).glyph
    if (typeof rawGlyph === 'string' && rawGlyph.trim().length > 0 && result.terrain.glyph !== rawGlyph.trim()) {
      notes.push({
        id: result.terrain.id,
        reason: `字形「${rawGlyph.trim()}」不是内置字形名，已按通用字形导入`,
      })
    }
    out.push(result.terrain)
  })
  return out
}

function parseMarkers(
  list: unknown[],
  max: number,
  skipped: BundleSkip[],
  notes: BundleNote[],
): CustomMarker[] {
  const out: CustomMarker[] = []
  const seen = new Set<string>()
  list.forEach((item, index) => {
    const input =
      item !== null && typeof item === 'object'
        ? (item as { id: unknown; label?: unknown; icon?: unknown; imagePath?: unknown; mode?: unknown })
        : ({ id: undefined } as { id: unknown })
    const result = validateCustomMarkerInput(input)
    if (!result.ok) {
      skipped.push({ id: idOf(item) ?? `#${index + 1}`, reason: result.problem })
      return
    }
    if (seen.has(result.marker.id)) {
      skipped.push({ id: result.marker.id, reason: '文件里有重复 ID，只保留先出现的那条' })
      return
    }
    if (out.length >= max) {
      skipped.push({ id: result.marker.id, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(result.marker.id)
    const rawIcon = (item as { icon?: unknown }).icon
    if (typeof rawIcon === 'string' && rawIcon.trim().length > 0 && result.marker.icon !== rawIcon.trim()) {
      notes.push({
        id: result.marker.id,
        reason: `字形「${rawIcon.trim()}」不是内置图标名，已按回退字形导入`,
      })
    }
    out.push(result.marker)
  })
  return out
}

/**
 * 路径类型段：`params` 既可以是嵌套对象，也可以是同级扁平字段。
 *
 * 嵌套是本插件导出的写法（参数聚在一起、diff 更稳），扁平是手工编辑时的自然写法
 * （与 `pathTypeCatalog.paramsSourceOf` 的容忍度一致）—— 两种都收，不因为写法不同就拒收。
 *
 * 虚线的非法值**在解析这一步就拒绝整条并给出原因**（不像参数回退那样静默变实线）：
 * 虚线是"分享样式"这件事的核心内容之一，静默变成实线等于把别人的定义改掉了还不说。
 */
function parsePathTypes(list: unknown[], max: number, skipped: BundleSkip[]): PathTypeEntry[] {
  const out: PathTypeEntry[] = []
  const seen = new Set<string>()
  list.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ id: `#${index + 1}`, reason: '这一项不是一个对象' })
      return
    }
    const record = item as Record<string, unknown>
    const params =
      record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : record
    const flush = {
      id: record.id,
      label: record.label,
      color: params.color,
      width: params.width,
      dash: params.dash,
      taper: params.taper,
      smooth: params.smooth,
      cap: params.cap,
      join: params.join,
    }
    const id = idOf(item)
    // `params` 优先（嵌套写法），否则看条目自身的扁平字段
    const dash = params.dash !== undefined ? params.dash : record.dash
    if (dash !== undefined) {
      const problem = describePathDashProblem(dash)
      if (problem !== null) {
        skipped.push({ id: id ?? `#${index + 1}`, reason: problem })
        return
      }
    }
    const result = validateCustomPathTypeInput(flush)
    if (!result.ok) {
      skipped.push({ id: id ?? `#${index + 1}`, reason: result.problem })
      return
    }
    if (seen.has(result.entry.id)) {
      skipped.push({ id: result.entry.id, reason: '文件里有重复 ID，只保留先出现的那条' })
      return
    }
    if (out.length >= max) {
      skipped.push({ id: result.entry.id, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(result.entry.id)
    // 大类原样保留（未知值按 `path` 收敛）：本轮只接线路径，但"文件里写的是什么"
    // 不该被我们悄悄改掉 —— 以后接线区域类型时，这份数据还得是对的。
    out.push({ ...result.entry, kind: normalizePathTypeKind(record.kind) })
  })
  return out
}

/**
 * 区域类型段：写法与路径类型段同构（`params` 嵌套或同级扁平都收）。
 *
 * 虚线的处理也照抄路径那一段：**在解析这一步就拒绝整条并给出原因**，
 * 而不是像参数回退那样静默变实线 —— 边框虚线是"分享样式"的内容之一，
 * 悄悄改掉它等于把别人的定义换了还不说。
 */
function parseRegionTypes(list: unknown[], max: number, skipped: BundleSkip[]): RegionTypeEntry[] {
  const out: RegionTypeEntry[] = []
  const seen = new Set<string>()
  list.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ id: `#${index + 1}`, reason: '这一项不是一个对象' })
      return
    }
    const record = item as Record<string, unknown>
    const params =
      record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : record
    const id = idOf(item)
    // `params` 优先（嵌套写法），否则看条目自身的扁平字段 —— 与路径类型段逐字同规则
    const borderDash = params.borderDash !== undefined ? params.borderDash : record.borderDash
    const result = validateCustomRegionTypeInput({
      id: record.id,
      label: record.label,
      color: params.color,
      opacity: params.opacity,
      borderColor: params.borderColor,
      borderWidth: params.borderWidth,
      ...(borderDash !== undefined ? { borderDash } : {}),
    })
    if (!result.ok) {
      skipped.push({ id: id ?? `#${index + 1}`, reason: result.problem })
      return
    }
    if (seen.has(result.entry.id)) {
      skipped.push({ id: result.entry.id, reason: '文件里有重复 ID，只保留先出现的那条' })
      return
    }
    if (out.length >= max) {
      skipped.push({ id: result.entry.id, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(result.entry.id)
    out.push(result.entry)
  })
  return out
}

/* ------------------------------------------------------------------ 合并 */
export interface MergeTerrainsResult {
  terrains: CustomTerrain[]
  added: string[]
  /** 与 `added` 一一对应的条目本身（调用方要"加到设置里"时用它，不必再按 ID 找回来） */
  addedItems: CustomTerrain[]
  skipped: BundleSkip[]
}

export interface MergeMarkersResult {
  markers: CustomMarker[]
  added: string[]
  addedItems: CustomMarker[]
  skipped: BundleSkip[]
}

export interface MergePathTypesResult {
  pathTypes: PathTypeEntry[]
  added: string[]
  addedItems: PathTypeEntry[]
  skipped: BundleSkip[]
}

export interface MergeRegionTypesResult {
  regionTypes: RegionTypeEntry[]
  added: string[]
  addedItems: RegionTypeEntry[]
  skipped: BundleSkip[]
}

/** 合并的通用规则：同 ID 保留现有的、超上限跳过、每条都给可读原因 */
function mergeById<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  options: {
    max: number
    /** 同 ID 冲突时的原因（内置类型需要一句话说明"内置的不能替换"） */
    conflictReason: (id: string) => string
  },
): { items: T[]; added: T[]; addedIds: string[]; skipped: BundleSkip[] } {
  const items = [...existing]
  const known = new Set(existing.map((item) => item.id))
  const added: T[] = []
  const addedIds: string[] = []
  const skipped: BundleSkip[] = []

  for (const item of incoming) {
    if (known.has(item.id)) {
      skipped.push({ id: item.id, reason: options.conflictReason(item.id) })
      continue
    }
    if (items.length >= options.max) {
      skipped.push({ id: item.id, reason: `超过上限（最多 ${options.max} 条）` })
      continue
    }
    known.add(item.id)
    items.push(item)
    added.push(item)
    addedIds.push(item.id)
  }

  return { items, added, addedIds, skipped }
}

/**
 * 把导入的地形合并进现有设置。
 *
 * **同 ID 时保留现有的**（导入是补充，不是替换）：用户自己调好的颜色/图片不该被一份
 * 外来文件悄悄改掉；真想要对方的版本，先删掉自己那条再导入即可 —— 这条规则写在这里，
 * 也写在设置页的提示里，避免"以为导入会覆盖"或"以为导入会合并"的两种误解。
 */
export function mergeTerrains(
  existing: readonly CustomTerrain[],
  incoming: readonly CustomTerrain[],
  options: { maxTerrains?: number } = {},
): MergeTerrainsResult {
  const merged = mergeById(existing, incoming, {
    max: options.maxTerrains ?? MAX_CUSTOM_TERRAINS,
    conflictReason: () => CONFLICT_KEEP_EXISTING,
  })
  return { terrains: merged.items, added: merged.addedIds, addedItems: merged.added, skipped: merged.skipped }
}

/** 与地形同一条规则：同 ID 保留现有的（标记载着用户选好的图标与图片，更不该被改掉） */
export function mergeMarkers(
  existing: readonly CustomMarker[],
  incoming: readonly CustomMarker[],
  options: { maxMarkers?: number } = {},
): MergeMarkersResult {
  const merged = mergeById(existing, incoming, {
    max: options.maxMarkers ?? MAX_CUSTOM_MARKERS,
    conflictReason: () => CONFLICT_KEEP_EXISTING,
  })
  return { markers: merged.items, added: merged.addedIds, addedItems: merged.added, skipped: merged.skipped }
}

/**
 * 合并路径类型。
 *
 * 与地形/标记有两处**刻意的不同**：
 * 1. 上限只数**自定义**条目（内置 4 种永远存在、不占用户的 32 个名额）；
 * 2. 与内置类型同 ID 的条目一定冲突（内置类型在每个库里都在），原因要写清"内置的不能被替换"
 *    —— 否则用户会以为"这个文件没导进来"。
 */
export function mergePathTypes(
  existing: readonly PathTypeEntry[],
  incoming: readonly PathTypeEntry[],
  options: { maxPathTypes?: number } = {},
): MergePathTypesResult {
  const existingCustom = customPathTypeEntries(existing)
  const base = [...existing]
  const known = new Set(existing.map((entry) => entry.id))
  const added: PathTypeEntry[] = []
  const addedIds: string[] = []
  const skipped: BundleSkip[] = []
  const max = options.maxPathTypes ?? MAX_CUSTOM_PATH_TYPES
  let customCount = existingCustom.length

  for (const entry of incoming) {
    if (known.has(entry.id)) {
      skipped.push({
        id: entry.id,
        reason: isBuiltinPathType(entry.id)
          ? '内置类型在每个库里都有，不能替换（导入是补充，不会覆盖）'
          : CONFLICT_KEEP_EXISTING,
      })
      continue
    }
    if (customCount >= max) {
      skipped.push({ id: entry.id, reason: `超过上限（最多 ${max} 条自定义路径类型）` })
      continue
    }
    known.add(entry.id)
    customCount += 1
    added.push(entry)
    addedIds.push(entry.id)
  }

  return { pathTypes: [...base, ...added], added: addedIds, addedItems: added, skipped }
}

const CONFLICT_KEEP_EXISTING = '已有同 ID 的定义，保留现有的（导入是补充，不会覆盖）'

/**
 * 合并区域类型。
 *
 * 与路径类型合并**逐条同构**（所以两处的行为不会分叉）：
 * 1. 上限只数**自定义**条目 —— 内置 6 种永远存在、不占用户的 32 个名额；
 * 2. 与内置类型同 ID 的条目一定冲突（内置类型在每个库里都有），原因要写清"内置的不能被替换"。
 */
export function mergeRegionTypes(
  existing: readonly RegionTypeEntry[],
  incoming: readonly RegionTypeEntry[],
  options: { maxRegionTypes?: number } = {},
): MergeRegionTypesResult {
  const existingCustom = customRegionTypeEntries(existing)
  const base = [...existing]
  const known = new Set(existing.map((entry) => entry.id))
  const added: RegionTypeEntry[] = []
  const addedIds: string[] = []
  const skipped: BundleSkip[] = []
  const max = options.maxRegionTypes ?? MAX_CUSTOM_REGION_TYPES
  let customCount = existingCustom.length

  for (const entry of incoming) {
    if (known.has(entry.id)) {
      skipped.push({
        id: entry.id,
        reason: isBuiltinRegionType(entry.id)
          ? '内置类型在每个库里都有，不能替换（导入是补充，不会覆盖）'
          : CONFLICT_KEEP_EXISTING,
      })
      continue
    }
    if (customCount >= max) {
      skipped.push({ id: entry.id, reason: `超过上限（最多 ${max} 条自定义区域类型）` })
      continue
    }
    known.add(entry.id)
    customCount += 1
    added.push(entry)
    addedIds.push(entry.id)
  }

  return { regionTypes: [...base, ...added], added: addedIds, addedItems: added, skipped }
}

/** 合并结果 → 计划里那一段（计划只关心"新增了哪些条目"与"跳过了哪些、为什么"） */
function pickAdded<T>(merged: { addedItems: T[]; skipped: BundleSkip[] }): { added: T[]; skipped: BundleSkip[] } {
  return { added: merged.addedItems, skipped: merged.skipped }
}

/* ------------------------------------------------------- 导入计划（纯函数） */

export interface BundleImportPlan {
  /** 文件里出现过的段（缺失的段在导入时不动用户设置） */
  sections: BundleSection[]
  terrains: { added: CustomTerrain[]; skipped: BundleSkip[] }
  markers: { added: CustomMarker[]; skipped: BundleSkip[] }
  pathTypes: { added: PathTypeEntry[]; skipped: BundleSkip[] }
  regionTypes: { added: RegionTypeEntry[]; skipped: BundleSkip[] }
  /** 将新增的条目总数 */
  addedCount: number
  /** 被跳过的条目总数（同 ID 冲突 + 非法 + 超上限） */
  skippedCount: number
  /** "条目进来了，但有一处被回退"的记录（与 `skippedCount` 分开计） */
  notes: BundleNote[]
  /** 文件里没有任何一段（理论上不会走到这里：解析侧已经拒绝） */
  empty: boolean
}

export interface PlanBundleOptions extends ParseBundleOptions {
  /** 解析阶段收集到的回退说明（来自 `parseResourceBundle` 的 `notes`） */
  notes?: readonly BundleNote[]
}

export interface BundleImportCurrent {
  terrains: readonly CustomTerrain[]
  markers: readonly CustomMarker[]
  pathTypes: readonly PathTypeEntry[]
  /**
   * 用户当前的区域类型目录。
   *
   * ⚠️ 刻意**必填**：它决定"文件里这条区域类型算新增还是算冲突"，
   * 漏传会让计划把已有的条目说成"将新增"（而落盘时会因为 ID 重复而被收敛掉）——
   * 于是"对话框里说的"与"实际做的"分叉，而这正是导入最该避免的缺陷。
   */
  regionTypes: readonly RegionTypeEntry[]
}

/**
 * 算出"这份文件导入之后会发生什么"，**不改任何状态**。
 *
 * 确认对话框靠它把话说清楚（新增几个、哪些因同 ID 被保留、哪些非法及原因）；
 * 确认之后真正落盘的也是同一份计划的计算结果 —— 于是"对话框里说的"与"实际做的"
 * 不可能不一致（这正是导入这类操作最该避免的缺陷）。
 */
export function planBundleImport(
  current: BundleImportCurrent,
  bundle: ParsedBundle,
  options: PlanBundleOptions = {},
): BundleImportPlan {
  const sections = bundle.sections
  /**
   * "文件里出现过这一段吗"。
   *
   * ⚠️ 今天这道判断**不可观测**：解析侧对缺失的段给的是空数组，而下面的合并只增不删，
   * 于是"合并空数组"与"跳过合并"结果完全一样（鉴别力验证时实测：把 `has()` 改成恒真，
   * 一条断言都不会红）。真正保护用户定义的是**合并语义只增不删**，`has()` 是第二道防线 ——
   * 它的价值在未来：一旦有人把合并改成"以文件为准的替换"，这道判断就是唯一挡住
   * "一份 v1 老文件清空用户标记"的东西。所以留着，但别把它当成当前的保护伞。
   */
  const has = (section: BundleSection) => sections.includes(section)

  const terrains: { added: CustomTerrain[]; skipped: BundleSkip[] } = has('terrains')
    ? pickAdded(mergeTerrains(current.terrains, bundle.terrains, { maxTerrains: options.maxTerrains }))
    : { added: [], skipped: [] }
  const markers: { added: CustomMarker[]; skipped: BundleSkip[] } = has('markers')
    ? pickAdded(mergeMarkers(current.markers, bundle.markers, { maxMarkers: options.maxMarkers }))
    : { added: [], skipped: [] }
  const pathTypes: { added: PathTypeEntry[]; skipped: BundleSkip[] } = has('pathTypes')
    ? pickAdded(mergePathTypes(current.pathTypes, bundle.pathTypes, { maxPathTypes: options.maxPathTypes }))
    : { added: [], skipped: [] }
  const regionTypes: { added: RegionTypeEntry[]; skipped: BundleSkip[] } = has('regionTypes')
    ? pickAdded(mergeRegionTypes(current.regionTypes, bundle.regionTypes, { maxRegionTypes: options.maxRegionTypes }))
    : { added: [], skipped: [] }

  const addedCount =
    terrains.added.length + markers.added.length + pathTypes.added.length + regionTypes.added.length
  const skippedCount =
    terrains.skipped.length + markers.skipped.length + pathTypes.skipped.length + regionTypes.skipped.length

  return {
    sections,
    terrains: { added: terrains.added, skipped: terrains.skipped },
    markers: { added: markers.added, skipped: markers.skipped },
    pathTypes: { added: pathTypes.added, skipped: pathTypes.skipped },
    regionTypes: { added: regionTypes.added, skipped: regionTypes.skipped },
    addedCount,
    skippedCount,
    notes: [...(options.notes ?? [])],
    empty: sections.length === 0,
  }
}

/** 一段的"新增 N 个：id、id、…"（超过 8 个就省略，避免对话框被一行长文撑爆） */
function describeAdded(label: string, ids: readonly string[]): string | null {
  if (ids.length === 0) return null
  const head = ids.slice(0, 8).join('、')
  const rest = ids.length > 8 ? ` 等 ${ids.length} 个` : ''
  return `${label} ${ids.length} 个：${head}${rest}`
}

/**
 * 计划 → 对话框正文（多行）。
 *
 * 刻意不用 `Notice`：这段文本可能十几行（每一条跳过都有自己的原因），
 * 长提示会盖住侧边栏、还复制不出来（见 `ReportModal` 的注释与 §5.16）。
 */
export function describeImportPlan(plan: BundleImportPlan): string {
  const lines: string[] = []
  lines.push(
    plan.addedCount > 0
      ? `将新增 ${plan.addedCount} 条定义（地形 ${plan.terrains.added.length} · 标记 ${plan.markers.added.length} · 路径类型 ${plan.pathTypes.added.length} · 区域类型 ${plan.regionTypes.added.length}）。`
      : '没有可新增的定义：这份文件里的条目在你库里都已经有了（或全部不合法）。',
  )
  for (const line of [
    describeAdded('地形', plan.terrains.added.map((item) => item.id)),
    describeAdded('标记', plan.markers.added.map((item) => item.id)),
    describeAdded('路径类型', plan.pathTypes.added.map((item) => item.id)),
    describeAdded('区域类型', plan.regionTypes.added.map((item) => item.id)),
  ]) {
    if (line !== null) lines.push(line)
  }

  const skipped = [
    ...plan.terrains.skipped,
    ...plan.markers.skipped,
    ...plan.pathTypes.skipped,
    ...plan.regionTypes.skipped,
  ]
  if (skipped.length > 0) {
    lines.push(`跳过 ${skipped.length} 条（不会被写入）：`)
    for (const item of skipped.slice(0, 12)) lines.push(`　· ${item.id} —— ${item.reason}`)
    if (skipped.length > 12) lines.push(`　· ……另有 ${skipped.length - 12} 条，原因同类`)
  }

  // "哪一段没被提到"必须说出来：否则用户会以为文件里的标记也导进来了
  const missing = (['terrains', 'markers', 'pathTypes', 'regionTypes'] as BundleSection[]).filter(
    (section) => !plan.sections.includes(section),
  )
  if (missing.length > 0) {
    lines.push(
      `这份文件里没有「${missing.map((section) => BUNDLE_SECTION_LABELS[section]).join('、')}」一节：` +
        '导入不会改动你现有的对应定义。',
    )
  }

  if (plan.notes.length > 0) {
    lines.push(`注意 ${plan.notes.length} 处（条目已导入，但有一项被本机回退）：`)
    for (const note of plan.notes.slice(0, 12)) lines.push(`　· ${note.id} —— ${note.reason}`)
  }

  lines.push('导入只做补充：同 ID 保留你现有的定义，且不会删除任何东西。')
  return lines.join('\n')
}

/** 计划 → 一条短提示（导入完成之后；详细原因在对话框里已经看过） */
export function describeImportResult(plan: BundleImportPlan): string {
  const counts = `地形 ${plan.terrains.added.length} · 标记 ${plan.markers.added.length} · 路径类型 ${plan.pathTypes.added.length} · 区域类型 ${plan.regionTypes.added.length}`
  const extra: string[] = []
  if (plan.skippedCount > 0) extra.push(`跳过 ${plan.skippedCount} 条`)
  // 回退也报一下：否则"导入成功了但视觉不一样"就没了线索（详情在对话框里）
  if (plan.notes.length > 0) extra.push(`${plan.notes.length} 处回退见导入对话框`)
  const tail = extra.length > 0 ? `，${extra.join('，')}` : ''
  return `已导入定义：新增 ${plan.addedCount} 条（${counts}）${tail}`
}

/** 定义文件默认文件名：带日期，便于在同一次备份里区分；只用 ASCII，避免不同平台的文件名问题 */
export function bundleFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `project-kaki-definitions-${stamp}.json`
}

function idOf(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null
  const id = (item as Record<string, unknown>).id
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null
}
