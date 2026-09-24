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
 * 数据校验**复用 `terrainCatalog` 的那一套**（`validateCustomTerrainInput`），
 * 不在这里再写一遍规则 —— 两套规则必然分叉，而分叉的后果是"设置页能加的，导入却加不进来"。
 */

import {
  MAX_CUSTOM_TERRAINS,
  validateCustomTerrainInput,
  type CustomTerrain,
} from './terrainCatalog.ts'

export const RESOURCE_BUNDLE_VERSION = 1

export interface ResourceBundle {
  version: number
  /** 生成者信息：只用于排查"这份文件是谁、什么时候导出的" */
  generator?: string
  exportedAt?: string
  terrains: CustomTerrain[]
}

export interface BundleSkip {
  /** 被跳过的条目 ID（拿不到 ID 时用它在数组里的序号，例如 `#3`） */
  id: string
  reason: string
}

export type ParseBundleResult =
  | { ok: true; bundle: ResourceBundle; skipped: BundleSkip[] }
  | { ok: false; reason: string }

/** 导出：把当前自定义地形打包成一份定义文件的内容 */
export function buildResourceBundle(
  terrains: readonly CustomTerrain[],
  options: { generator?: string; now?: Date } = {},
): ResourceBundle {
  const now = options.now ?? new Date()
  return {
    version: RESOURCE_BUNDLE_VERSION,
    ...(options.generator !== undefined ? { generator: options.generator } : {}),
    exportedAt: now.toISOString(),
    terrains: terrains.map((terrain) => ({ ...terrain })),
  }
}

/**
 * 序列化成文本。
 *
 * 键顺序固定（手写而不是 `JSON.stringify(bundle)`）：导出文件是要进 Git、要被 diff 的，
 * 稳定的字段顺序能让"只改了一条地形"在 diff 里只显示一行。
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
    ]
    const comma = index === bundle.terrains.length - 1 ? '' : ','
    lines.push(`    { ${fields.join(', ')} }${comma}`)
  })
  lines.push('  ]')
  lines.push('}')
  return `${lines.join('\n')}\n`
}

/**
 * 解析一份定义文件。
 *
 * **逐条独立校验**：一条坏数据只丢它自己（与地图文档解析的承诺一致），
 * 并把原因收集到 `skipped` 里让调用方展示 —— 用户需要知道"哪几条没进来、为什么"。
 */
export function parseResourceBundle(text: string, options: { maxTerrains?: number } = {}): ParseBundleResult {
  const max = options.maxTerrains ?? MAX_CUSTOM_TERRAINS
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
    return { ok: false, reason: '文件内容应当是一个对象（形如 { "version": 1, "terrains": [...] }）。' }
  }

  const source = raw as Record<string, unknown>
  const version = typeof source.version === 'number' && Number.isFinite(source.version) ? Math.trunc(source.version) : Number.NaN
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, reason: '缺少 version 字段（或它不是正整数）—— 这不像是本插件导出的定义文件。' }
  }
  if (version > RESOURCE_BUNDLE_VERSION) {
    // 明确拒绝而不是"尽力解析"：新版本的字段我们看不懂，静默丢掉等于骗用户说导入成功了
    return {
      ok: false,
      reason: `这份文件来自更新的版本（v${version}），当前插件只认到 v${RESOURCE_BUNDLE_VERSION}。请先升级插件再导入。`,
    }
  }

  const list = source.terrains
  if (list !== undefined && !Array.isArray(list)) {
    return { ok: false, reason: 'terrains 字段应当是一个数组。' }
  }
  const skipped: BundleSkip[] = []
  const terrains: CustomTerrain[] = []
  const seen = new Set<string>()
  const items = Array.isArray(list) ? list : []

  items.forEach((item, index) => {
    // 用与 `validateCustomTerrainInput` 一致的入参形状：缺 id 时由那个函数给出"ID 不能为空"，
    // 这里不重复判断（校验规则只有一份，见文件头注释）
    const input =
      item !== null && typeof item === 'object'
        ? (item as { id: unknown; label?: unknown; color?: unknown; glyph?: unknown; imagePath?: unknown })
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
    if (terrains.length >= max) {
      skipped.push({ id: result.terrain.id, reason: `超过上限（最多 ${max} 条）` })
      return
    }
    seen.add(result.terrain.id)
    terrains.push(result.terrain)
  })

  if (terrains.length === 0 && skipped.length > 0) {
    return { ok: false, reason: `文件里没有一条可用的地形定义。第一条的原因：${skipped[0]!.reason}` }
  }

  return {
    ok: true,
    bundle: {
      version,
      ...(typeof source.generator === 'string' ? { generator: source.generator } : {}),
      ...(typeof source.exportedAt === 'string' ? { exportedAt: source.exportedAt } : {}),
      terrains,
    },
    skipped,
  }
}

export interface MergeTerrainsResult {
  terrains: CustomTerrain[]
  added: string[]
  skipped: BundleSkip[]
}

/**
 * 把导入的定义合并进现有设置。
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
  const max = options.maxTerrains ?? MAX_CUSTOM_TERRAINS
  const terrains = [...existing]
  const known = new Set(existing.map((terrain) => terrain.id))
  const added: string[] = []
  const skipped: BundleSkip[] = []

  for (const terrain of incoming) {
    if (known.has(terrain.id)) {
      skipped.push({ id: terrain.id, reason: '已有同 ID 的定义，保留现有的（导入是补充，不会覆盖）' })
      continue
    }
    if (terrains.length >= max) {
      skipped.push({ id: terrain.id, reason: `超过上限（最多 ${max} 条）` })
      continue
    }
    known.add(terrain.id)
    terrains.push(terrain)
    added.push(terrain.id)
  }

  return { terrains, added, skipped }
}

/** 导出文件名：带日期，便于在同一次备份里区分；只用 ASCII，避免不同平台的文件名问题 */
export function bundleFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `project-kaki-terrains-${stamp}.json`
}

function idOf(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null
  const id = (item as Record<string, unknown>).id
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null
}
