/**
 * 自定义资源的"定义文件"：导出成一份 JSON，之后可以导入到别的库或分享给别人。
 *
 * W4-3 起它的定位是**搬运工具**（"把我在这张图上调好的整套样式搬到另一张图"）：
 * 导的是**当前地图的定义集**，而且**内置的路径 / 区域类型也进文件**（参数是每张图各自一份，
 * 用户调得最勤的恰恰是内置那几种的线宽 / 填充）—— 详见 `ResourceBundle.pathTypes` 的注释。
 *
 * 为什么值得单独一个模块：
 * 1. **导入是唯一会让"外部内容"进入用户设置的入口**，也是最容易造成不可逆损失的动作
 *    （搞错了就把用户自己配好的东西覆盖掉）。所以校验必须逐条给出**可读原因**，
 *    而不是"导入失败"四个字；冲突策略必须是**显式选择过的**，并且写在这里：
 *    **同 ID 默认保留用户现有的定义**（导入是"补充"，不是"替换"），
 *    但用户可以在确认对话框里**逐条勾「覆盖」**把它换成文件里那一条 ——
 *    那条路是用户显式选的（`PlanBundleOptions.overwrite`），于是
 *    "悄悄改掉"与"我要求它改"分得很清楚。
 * 2. **格式要能长大**。文件里带 `version`，遇到来自更新版本的文件**明确拒绝**并告诉用户升级插件，
 *    而不是"尽力解析" —— 后者会把新字段静默丢掉，用户以为导入成功了。
 * 3. 纯函数：不做任何 IO。读哪个文件、写到哪个路径由调用方决定（于是可单测）。
 *
 * 数据校验**复用各目录自己的那一套**（`validateCustomTerrainInput` /
 * `validateCustomMarkerInput` / `validateCustomPathTypeInput`），不在这里再写一遍规则 ——
 * 两套规则必然分叉，而分叉的后果是"设置页能加的，导入却加不进来"。
 * ⚠️ 但 **ID 例外**：那几个校验器是给"用户新增自定义项"用的，一律补 `custom:` 前缀；
 * 文件里带着**内置项**（W4-3），照它们的 ID 走会把 `river` 变成 `custom:river`
 * （认不出冲突，还凭空多一条）—— 所以解析侧用 `canonicalBundleId` 单独定 ID。
 * 教训：**"用户输入"与"文件内容"是两种输入，不能共用同一条规范化**。
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
 * 当时 v2 是本轮开发周期里刚引入、**还没有发布给任何用户**的格式 —— 世上不存在"旧版插件写下的
 * v2 文件"，因此没有需要区分的历史包袱；升到 v3 只会凭空制造一个版本号。
 *
 * ⚠️ **那个前提已经到期**：v2 随 **1.1.0**（2026-09-30）发布出去了。**从现在起**任何字段变化都必须
 * 老实升版本号（否则旧插件读新文件时会静默丢字段）。这段历史留着，是为了解释当时为什么没升。
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
  describePathTypeParams,
  isBuiltinPathType,
  normalizePathTypeId,
  normalizePathTypeKind,
  validateCustomPathTypeInput,
  type PathTypeEntry,
} from './pathTypeCatalog.ts'
import { describePathDashProblem } from './pathStyleSettings.ts'
import {
  MAX_CUSTOM_REGION_TYPES,
  customRegionTypeEntries,
  describeRegionTypeParams,
  isBuiltinRegionType,
  normalizeRegionTypeId,
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
   * **整套路径类型目录**（内置 4 种 + 自定义），W4-3 起内置的**也进文件**。
   *
   * 为什么改口：W4-1 之后"线宽 / 颜色"这些**参数是每张地图各自一份**，而用户调得最勤的
   * 恰恰是内置那四种的线宽。把它们排除在文件之外，跨地图搬运就只剩下一堆"自定义类型"，
   * 而那通常是空的 —— 于是这个功能在真实使用里等于没用（"搬过去线宽全变回出厂值"）。
   *
   * 代价与防护：内置 ID 在每张图里都存在 ⇒ 导入时**每一条都是同名冲突**，默认**跳过**
   * （只增不删的老口径不变）；用户要带走参数就在确认对话框里逐项勾「覆盖」。
   * 这正是当年那句"要分享整套样式需要另一条冲突规则，属于以后的功能"所等待的那条规则。
   */
  pathTypes: PathTypeEntry[]
  /**
   * **整套区域类型目录**（内置 6 种 + 自定义），与 `pathTypes` 同一条改动、同一个理由。
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

/**
 * 导出：把一份**定义集**（自定义地形 / 标记 + 整套路径与区域类型目录）打包成定义文件的内容。
 *
 * W4-3 起调用方传的是**当前地图的定义集**（"资源包是搬运工具"），于是内置类型的参数也在里面 ——
 * 详见 `ResourceBundle.pathTypes` 的注释（那是这一批最要紧的一处口径变化）。
 */
export function buildResourceBundle(input: ResourceBundleInput, options: BuildBundleOptions = {}): ResourceBundle {
  const now = options.now ?? new Date()
  return {
    version: RESOURCE_BUNDLE_VERSION,
    ...(options.generator !== undefined ? { generator: options.generator } : {}),
    exportedAt: now.toISOString(),
    terrains: input.terrains.map((terrain) => ({ ...terrain })),
    markers: (input.markers ?? []).map((marker) => ({ ...marker })),
    // 整套目录带走（含内置项的参数）：跨地图搬运要的正是"我调好的线宽"
    pathTypes: (input.pathTypes ?? []).map((entry) => ({
      ...entry,
      params: { ...entry.params, dash: [...entry.params.dash] },
    })),
    // 同上：整套区域类型目录（含内置 6 种的填充 / 边框参数）
    regionTypes: (input.regionTypes ?? []).map((entry) => ({
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
        '文件格式不对：不像是本插件导出的定义文件。',
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
    // ID 用 `canonicalBundleId` 而不是校验器的 `entry.id`：后者是给"新增自定义项"用的，
    // 一律补 `custom:` 前缀 —— 而文件里的内置项必须原样留住（见 `canonicalBundleId`）
    const entryId = canonicalBundleId(record.id, isBuiltinPathType, normalizePathTypeId) ?? result.entry.id
    if (seen.has(entryId)) {
      skipped.push({ id: entryId, reason: '文件里有重复 ID，只保留先出现的那条' })
      return
    }
    if (out.length >= max) {
      skipped.push({ id: entryId, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(entryId)
    // 大类原样保留（未知值按 `path` 收敛）：本轮只接线路径，但"文件里写的是什么"
    // 不该被我们悄悄改掉 —— 以后接线区域类型时，这份数据还得是对的。
    out.push({ ...result.entry, id: entryId, kind: normalizePathTypeKind(record.kind) })
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
    // 与路径类型段逐字同理：内置 ID 原样留住（否则文件里的 `realm` 会变成 `custom:realm`，
    // 既认不出冲突，又会凭空多出一条自定义区域类型）
    const entryId = canonicalBundleId(record.id, isBuiltinRegionType, normalizeRegionTypeId) ?? result.entry.id
    if (seen.has(entryId)) {
      skipped.push({ id: entryId, reason: '文件里有重复 ID，只保留先出现的那条' })
      return
    }
    if (out.length >= max) {
      skipped.push({ id: entryId, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(entryId)
    out.push({ ...result.entry, id: entryId })
  })
  return out
}

/**
 * 文件里的 ID → 规范 ID：**内置 ID 原样保留**，其余按用户输入规则补 `custom:` 前缀。
 *
 * 为什么解析侧必须做这件事（W4-3）：文件里现在带着**内置的**路径与区域类型，
 * 而 `validateCustomPathTypeInput` / `validateCustomRegionTypeInput` 是给"用户新增自定义项"
 * 用的 —— 它们一律补前缀（那是刻意的：内置名是留给内置的）。直接拿校验结果当 ID，
 * 文件里的 `river` 就会变成 `custom:river`：**既撞不上这张图里的内置 `river`（冲突认不出来），
 * 又会凭空多出一条自定义类型** —— 而"跨地图搬参数"这件事全靠 ID 对上号才成立。
 *
 * 与设置层 `normalizeRegionTypeEntries` 里的 `canonicalStoredId` 是同一条规则，
 * 所以"文件里是什么 ID"与"设置里存得下什么 ID"不会分叉。
 */
function canonicalBundleId(
  raw: unknown,
  isBuiltin: (value: unknown) => boolean,
  normalize: (raw: unknown) => string | null,
): string | null {
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase()
    if (isBuiltin(text)) return text
  }
  return normalize(raw)
}

/* ------------------------------------------------------------------ 合并 */
export interface MergeTerrainsResult {
  terrains: CustomTerrain[]
  added: string[]
  /** 与 `added` 一一对应的条目本身（调用方要"加到设置里"时用它，不必再按 ID 找回来） */
  addedItems: CustomTerrain[]
  /** 被**覆盖**掉的条目 ID（用户在同名冲突里选了"覆盖"） */
  replaced: string[]
  skipped: BundleSkip[]
}

export interface MergeMarkersResult {
  markers: CustomMarker[]
  added: string[]
  addedItems: CustomMarker[]
  replaced: string[]
  skipped: BundleSkip[]
}

export interface MergePathTypesResult {
  pathTypes: PathTypeEntry[]
  added: string[]
  addedItems: PathTypeEntry[]
  replaced: string[]
  skipped: BundleSkip[]
}

export interface MergeRegionTypesResult {
  regionTypes: RegionTypeEntry[]
  added: string[]
  addedItems: RegionTypeEntry[]
  replaced: string[]
  skipped: BundleSkip[]
}

/** 合并的通用规则：同 ID 默认保留现有的（勾了"覆盖"才替换）、超上限跳过、每条都给可读原因 */
function mergeById<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  options: {
    max: number
    /** 同 ID 冲突且**没有**勾选覆盖时的原因 */
    conflictReason: (id: string) => string
    /** 用户勾了"覆盖这张图里的同名项"的那些 ID（W4-3） */
    overwrite?: (id: string) => boolean
  },
): { items: T[]; added: T[]; addedIds: string[]; replaced: string[]; skipped: BundleSkip[] } {
  const items = [...existing]
  const known = new Set(existing.map((item) => item.id))
  const added: T[] = []
  const addedIds: string[] = []
  const replaced: string[] = []
  const skipped: BundleSkip[] = []

  for (const item of incoming) {
    if (known.has(item.id)) {
      if (options.overwrite?.(item.id) === true) {
        // 覆盖：**在原位**换成文件里那一条（顺序不动 —— 用户列表的次序也是他的东西）
        const index = items.findIndex((candidate) => candidate.id === item.id)
        if (index >= 0) items[index] = item
        replaced.push(item.id)
        continue
      }
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

  return { items, added, addedIds, replaced, skipped }
}

/**
 * 把导入的地形合并进现有目录。
 *
 * **同 ID 默认保留现有的**（导入是补充，不是替换）：用户自己调好的颜色/图片不该被一份
 * 外来文件悄悄改掉。**W4-3 起可以在确认对话框里逐项勾"覆盖"** —— 那条路是用户显式选的，
 * 于是"悄悄改掉"与"我要求它改"分得很清楚。
 */
export function mergeTerrains(
  existing: readonly CustomTerrain[],
  incoming: readonly CustomTerrain[],
  options: { maxTerrains?: number; overwrite?: (id: string) => boolean } = {},
): MergeTerrainsResult {
  const merged = mergeById(existing, incoming, {
    max: options.maxTerrains ?? MAX_CUSTOM_TERRAINS,
    conflictReason: () => CONFLICT_KEEP_EXISTING,
    ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
  })
  return {
    terrains: merged.items,
    added: merged.addedIds,
    addedItems: merged.added,
    replaced: merged.replaced,
    skipped: merged.skipped,
  }
}

/** 与地形同一条规则：同 ID 默认保留现有的（标记载着用户选好的图标与图片，更不该被改掉） */
export function mergeMarkers(
  existing: readonly CustomMarker[],
  incoming: readonly CustomMarker[],
  options: { maxMarkers?: number; overwrite?: (id: string) => boolean } = {},
): MergeMarkersResult {
  const merged = mergeById(existing, incoming, {
    max: options.maxMarkers ?? MAX_CUSTOM_MARKERS,
    conflictReason: () => CONFLICT_KEEP_EXISTING,
    ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
  })
  return {
    markers: merged.items,
    added: merged.addedIds,
    addedItems: merged.added,
    replaced: merged.replaced,
    skipped: merged.skipped,
  }
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
  options: { maxPathTypes?: number; overwrite?: (id: string) => boolean } = {},
): MergePathTypesResult {
  const existingCustom = customPathTypeEntries(existing)
  const base = [...existing]
  const known = new Set(existing.map((entry) => entry.id))
  const added: PathTypeEntry[] = []
  const addedIds: string[] = []
  const replaced: string[] = []
  const skipped: BundleSkip[] = []
  const max = options.maxPathTypes ?? MAX_CUSTOM_PATH_TYPES
  let customCount = existingCustom.length

  for (const entry of incoming) {
    if (known.has(entry.id)) {
      // W4-3：勾了"覆盖"就**在原位**换成文件里那一条（内置类型的参数也走这条路 ——
      // 参数是这张图自己的东西，用户显式要求带走就该带走）
      if (options.overwrite?.(entry.id) === true) {
        const index = base.findIndex((candidate) => candidate.id === entry.id)
        if (index >= 0) base[index] = entry
        replaced.push(entry.id)
        continue
      }
      skipped.push({
        id: entry.id,
        reason: isBuiltinPathType(entry.id)
          ? '内置类型在每个库里都有；要它换成本文件里的参数，请在下面那一项上勾「覆盖」'
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
    // ⚠️ 必须**同时**进 `base`：`added` 是"给用户看的新增清单"，`base` 是"这张图最终的目录"。
    // 只记清单不入目录，`plan.result` 就会少掉每一条新增 —— 而 `plan.result` 正是落盘用的那一份
    // （对话框说"将新增 1 条"、落盘却一条没进；这个缺陷被冒烟场景 36 抓住过一次）。
    added.push(entry)
    addedIds.push(entry.id)
    base.push(entry)
  }

  return { pathTypes: base, added: addedIds, addedItems: added, replaced, skipped }
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
  options: { maxRegionTypes?: number; overwrite?: (id: string) => boolean } = {},
): MergeRegionTypesResult {
  const existingCustom = customRegionTypeEntries(existing)
  const base = [...existing]
  const known = new Set(existing.map((entry) => entry.id))
  const added: RegionTypeEntry[] = []
  const addedIds: string[] = []
  const replaced: string[] = []
  const skipped: BundleSkip[] = []
  const max = options.maxRegionTypes ?? MAX_CUSTOM_REGION_TYPES
  let customCount = existingCustom.length

  for (const entry of incoming) {
    if (known.has(entry.id)) {
      // 与路径类型逐字同理：勾了"覆盖"就在原位换成文件里那一条
      if (options.overwrite?.(entry.id) === true) {
        const index = base.findIndex((candidate) => candidate.id === entry.id)
        if (index >= 0) base[index] = entry
        replaced.push(entry.id)
        continue
      }
      skipped.push({
        id: entry.id,
        reason: isBuiltinRegionType(entry.id)
          ? '内置类型在每个库里都有；要它换成本文件里的参数，请在下面那一项上勾「覆盖」'
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
    // 与路径类型逐字同理：新增的条目要**同时**进"给用户看的清单"和"最终的目录"
    added.push(entry)
    addedIds.push(entry.id)
    base.push(entry)
  }

  return { regionTypes: base, added: addedIds, addedItems: added, replaced, skipped }
}

/* ------------------------------------------------------- 导入计划（纯函数） */

/**
 * 一条**同名冲突**（文件里那一条的 ID 在这张图里已经有了）。
 *
 * 为什么要单独列出来：W4-3 起"同名怎么办"由用户决定 —— 对话框要为每一条画一个
 * 「跳过 / 覆盖」的选择，所以计划必须把冲突**原样摆出来**（而不是混在 `skipped` 里
 * 当成一条既成事实）。两侧各给一句人话描述，用户才有依据决定。
 */
export interface BundleConflict {
  id: string
  section: BundleSection
  /** 这张图里现在那一条的一句话（"现在是什么"） */
  current: string
  /** 文件里那一条的一句话（"勾覆盖之后会变成什么"） */
  incoming: string
}

/** 一段计划（新增 / 覆盖 / 跳过） */
export interface BundleSectionPlan<T> {
  added: T[]
  /** 被覆盖的条目 ID（用户在同名冲突里勾了"覆盖"） */
  replaced: string[]
  skipped: BundleSkip[]
}

export interface BundleImportPlan {
  /** 文件里出现过的段（缺失的段在导入时不动用户设置） */
  sections: BundleSection[]
  terrains: BundleSectionPlan<CustomTerrain>
  markers: BundleSectionPlan<CustomMarker>
  pathTypes: BundleSectionPlan<PathTypeEntry>
  regionTypes: BundleSectionPlan<RegionTypeEntry>
  /** 将新增的条目总数 */
  addedCount: number
  /** 将被**覆盖**的条目总数（用户勾出来的；没勾就是 0） */
  replacedCount: number
  /** 被跳过的条目总数（同 ID 未勾覆盖 + 非法 + 超上限） */
  skippedCount: number
  /**
   * **所有**同名冲突（不管用户有没有勾覆盖）—— 对话框照它画选择行。
   *
   * 与 `skipped` 的关系：没勾覆盖的那些冲突**同时**出现在这里与 `skipped` 里
   * （一处给用户选，一处给用户读原因）。
   */
  conflicts: BundleConflict[]
  /**
   * 应用之后的四类目录 —— **这就是最终状态**。
   *
   * 为什么把它放进计划：对话框里说的（新增 M、覆盖 N）与落盘做的必须是**同一次计算**的结果，
   * 于是"对话框说的与实际做的不一致"这类导入最该避免的缺陷从结构上不可能发生。
   */
  result: {
    terrains: CustomTerrain[]
    markers: CustomMarker[]
    pathTypes: PathTypeEntry[]
    regionTypes: RegionTypeEntry[]
  }
  /** "条目进来了，但有一处被回退"的记录（与 `skippedCount` 分开计） */
  notes: BundleNote[]
  /** 文件里没有任何一段（理论上不会走到这里：解析侧已经拒绝） */
  empty: boolean
}

export interface PlanBundleOptions extends ParseBundleOptions {
  /** 解析阶段收集到的回退说明（来自 `parseResourceBundle` 的 `notes`） */
  notes?: readonly BundleNote[]
  /**
   * 用户在同名冲突里勾了"覆盖这张图里的同名项"的那些 ID（W4-3）。
   *
   * 传进来重算即可：对话框每次改动都拿新的一组 ID 重新调一次 `planBundleImport`，
   * 于是"正文、按钮状态、最终落盘"三处永远来自同一份计划（同一个套路用了第三次）。
   */
  overwrite?: readonly string[]
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
  const overwriteSet = new Set(options.overwrite ?? [])
  const overwrite = (id: string) => overwriteSet.has(id)

  const terrains = has('terrains')
    ? mergeTerrains(current.terrains, bundle.terrains, {
        ...(options.maxTerrains !== undefined ? { maxTerrains: options.maxTerrains } : {}),
        overwrite,
      })
    : { terrains: [...current.terrains], addedItems: [] as CustomTerrain[], replaced: [] as string[], skipped: [] as BundleSkip[] }
  const markers = has('markers')
    ? mergeMarkers(current.markers, bundle.markers, {
        ...(options.maxMarkers !== undefined ? { maxMarkers: options.maxMarkers } : {}),
        overwrite,
      })
    : { markers: [...current.markers], addedItems: [] as CustomMarker[], replaced: [] as string[], skipped: [] as BundleSkip[] }
  const pathTypes = has('pathTypes')
    ? mergePathTypes(current.pathTypes, bundle.pathTypes, {
        ...(options.maxPathTypes !== undefined ? { maxPathTypes: options.maxPathTypes } : {}),
        overwrite,
      })
    : { pathTypes: [...current.pathTypes], addedItems: [] as PathTypeEntry[], replaced: [] as string[], skipped: [] as BundleSkip[] }
  const regionTypes = has('regionTypes')
    ? mergeRegionTypes(current.regionTypes, bundle.regionTypes, {
        ...(options.maxRegionTypes !== undefined ? { maxRegionTypes: options.maxRegionTypes } : {}),
        overwrite,
      })
    : { regionTypes: [...current.regionTypes], addedItems: [] as RegionTypeEntry[], replaced: [] as string[], skipped: [] as BundleSkip[] }

  const sectionsPlan = {
    terrains: { added: terrains.addedItems, replaced: terrains.replaced, skipped: terrains.skipped },
    markers: { added: markers.addedItems, replaced: markers.replaced, skipped: markers.skipped },
    pathTypes: { added: pathTypes.addedItems, replaced: pathTypes.replaced, skipped: pathTypes.skipped },
    regionTypes: { added: regionTypes.addedItems, replaced: regionTypes.replaced, skipped: regionTypes.skipped },
  }

  const addedCount =
    terrains.addedItems.length + markers.addedItems.length + pathTypes.addedItems.length + regionTypes.addedItems.length
  const replacedCount =
    terrains.replaced.length + markers.replaced.length + pathTypes.replaced.length + regionTypes.replaced.length
  const skippedCount =
    terrains.skipped.length + markers.skipped.length + pathTypes.skipped.length + regionTypes.skipped.length

  return {
    sections,
    ...sectionsPlan,
    addedCount,
    replacedCount,
    skippedCount,
    // 冲突清单**与勾选无关**：没勾的那些也照旧列出来（用户要能回头改主意、也要能看见自己跳过了什么）
    conflicts: [
      ...collectConflicts('terrains', current.terrains, bundle.terrains),
      ...collectConflicts('markers', current.markers, bundle.markers),
      ...collectConflicts('pathTypes', current.pathTypes, bundle.pathTypes),
      ...collectConflicts('regionTypes', current.regionTypes, bundle.regionTypes),
    ],
    result: {
      terrains: terrains.terrains,
      markers: markers.markers,
      pathTypes: pathTypes.pathTypes,
      regionTypes: regionTypes.regionTypes,
    },
    notes: [...(options.notes ?? [])],
    empty: sections.length === 0,
  }
}

/**
 * 列出"文件里那一条的 ID 在这张图里已经有了"的那些条目。
 *
 * 与合并逻辑**分开算**：合并要给出"最终状态"，这里要给出"用户看的清单" ——
 * 合成的结果里那些条目已经变成"新的那一条"了，看不出它原来撞了谁。
 */
function collectConflicts<T extends { id: string }>(
  section: BundleSection,
  current: readonly T[],
  incoming: readonly T[],
): BundleConflict[] {
  if (incoming.length === 0) return []
  const byId = new Map(current.map((item) => [item.id, item]))
  const out: BundleConflict[] = []
  for (const item of incoming) {
    const existing = byId.get(item.id)
    if (existing === undefined) continue
    out.push({
      id: item.id,
      section,
      current: describeEntry(section, existing),
      incoming: describeEntry(section, item),
    })
  }
  return out
}

/** 一条定义的一句话描述（给冲突清单用：用户凭它判断"要不要换成对方的"） */
function describeEntry(section: BundleSection, entry: unknown): string {
  const record = entry as Record<string, unknown>
  const label = typeof record.label === 'string' && record.label.length > 0 ? record.label : '（未命名）'
  switch (section) {
    case 'terrains': {
      const mode = record.mode === 'image' ? `图片 ${String(record.imagePath ?? '')}` : '调色'
      return `${label} · ${mode} · ${String(record.color ?? '')}`
    }
    case 'markers': {
      const mode = record.mode === 'image' ? `图片 ${String(record.imagePath ?? '')}` : `字形 ${String(record.icon ?? '')}`
      return `${label} · ${mode}`
    }
    case 'pathTypes':
      return `${label} · ${describePathTypeParams((entry as PathTypeEntry).params)}`
    case 'regionTypes':
      return `${label} · ${describeRegionTypeParams((entry as RegionTypeEntry).params)}`
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
  const parts: string[] = []
  if (plan.addedCount > 0) parts.push(`新增 ${plan.addedCount} 条`)
  if (plan.replacedCount > 0) parts.push(`覆盖 ${plan.replacedCount} 条`)
  lines.push(
    parts.length > 0
      ? `将${parts.join('、')}定义（地形 ${plan.terrains.added.length} · 标记 ${plan.markers.added.length} · 路径类型 ${plan.pathTypes.added.length} · 区域类型 ${plan.regionTypes.added.length}）。`
      : '没有可导入的定义：这份文件里的条目在你库里都已经有了（或全部不合法）。',
  )
  for (const line of [
    describeAdded('地形', plan.terrains.added.map((item) => item.id)),
    describeAdded('标记', plan.markers.added.map((item) => item.id)),
    describeAdded('路径类型', plan.pathTypes.added.map((item) => item.id)),
    describeAdded('区域类型', plan.regionTypes.added.map((item) => item.id)),
  ]) {
    if (line !== null) lines.push(line)
  }
  if (plan.replacedCount > 0) {
    const replaced = [
      ...plan.pathTypes.replaced,
      ...plan.regionTypes.replaced,
      ...plan.terrains.replaced,
      ...plan.markers.replaced,
    ]
    lines.push(`将覆盖 ${plan.replacedCount} 条（用文件里的定义换掉这张图现有的）：${replaced.join('、')}`)
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

  lines.push(
    plan.conflicts.length > 0
      ? `同名冲突 ${plan.conflicts.length} 条：默认不覆盖（保留你现有的），要换成文件里的版本，就在下面那一项上勾「覆盖」。导入不会删除任何东西。`
      : '导入只做补充：不会覆盖你现有的定义，也不会删除任何东西。',
  )
  return lines.join('\n')
}

/** 计划 → 一条短提示（导入完成之后；详细原因在对话框里已经看过） */
export function describeImportResult(plan: BundleImportPlan): string {
  const counts = `地形 ${plan.terrains.added.length} · 标记 ${plan.markers.added.length} · 路径类型 ${plan.pathTypes.added.length} · 区域类型 ${plan.regionTypes.added.length}`
  const extra: string[] = []
  if (plan.replacedCount > 0) extra.push(`覆盖 ${plan.replacedCount} 条`)
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
