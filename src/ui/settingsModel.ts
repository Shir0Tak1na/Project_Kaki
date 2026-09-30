/**
 * 设置的**数据模型**：接口、出厂默认、以及"把任何输入收敛成一份可用设置"的纯函数。
 *
 * 为什么它必须和设置界面分开（`SettingsTab.ts`）：
 * 界面要 `import { PluginSettingTab, Setting } from 'obsidian'`，而单元测试走 ESM ——
 * 冒烟那套 `Module._load` 猴补丁只能拦 CommonJS 的 `require`，**拦不住 ESM import**。
 * 也就是说：只要这些函数住在界面文件里，它们就一条单测都写不了（这正是抽出本模块的原因）。
 * 本项目已有同样的先例：`src/base/viewContract.ts` 的注释写着"刻意不 import obsidian，故可单测"。
 *
 * 这里是 `data.json` 的**唯一收敛入口**：用户手工把文件改坏、旧版本升级、字段换代，
 * 全都只在这一个地方被处理掉，而不是散落成一堆 `??` 兜底。
 * 因此本模块的契约要用 `tests/settings.test.ts` 钉死，包括**幂等性**。
 */

import type { CustomTerrain } from '../render/terrainCatalog.ts'
import { normalizeCustomTerrains } from '../render/terrainCatalog.ts'
import { normalizeCustomBiomes, type CustomBiome } from '../render/biomeCatalog.ts'
import type { CustomMarker } from '../render/markerCatalog.ts'
import { normalizeCustomMarkers } from '../render/markerCatalog.ts'
import type { PathTypeEntry } from '../render/pathTypeCatalog.ts'
import { normalizePathTypeEntries, pathColorsFromEntries } from '../render/pathTypeCatalog.ts'
import type { RegionTypeEntry } from '../render/regionTypeCatalog.ts'
import { normalizeRegionTypeEntries, regionColorsFromEntries } from '../render/regionTypeCatalog.ts'
import type { LayerVisibility } from '../render/layerVisibility.ts'
import { DEFAULT_LAYER_VISIBILITY, layerVisibilityFromLegacy, normalizeLayerVisibility } from '../render/layerVisibility.ts'
import {
  defaultOverlayStyles,
  normalizeOverlayStyles,
  type OverlayStyles,
} from '../render/overlayFields.ts'
import type { PathColorMap, StylePalette } from '../render/stylePalette.ts'
import { normalizeFontFamily } from '../render/stylePalette.ts'

/**
 * **一张地图自己的**视图偏好（W4-2「按地图分键」）。
 *
 * 三个字段都可选：**缺 = 这张图没单独调过，用库级那一份**（`CartographerSettings` 里那三个同名字段，
 * 语义是"默认值 / 新建地图的初值"）。按字段分别回落，而不是整块替换 ——
 * 于是"只调过不透明度"的那张图也只在那一处留一条覆盖，别处继续跟着模板走。
 */
export interface MapViewSettings {
  overlays?: OverlayStyles
  layers?: LayerVisibility
  showLegend?: boolean
}

export interface CartographerSettings {
  /** 名称字号倍率（1 = 默认）。范围 0.5–3.0，步长 0.1。 */
  labelScale: number
  /**
   * 开发者模式：打开后才会出现开发用探针命令（诊断 Canvas / 监视视口变化）。
   * 关着时这些命令会从命令面板里**隐藏**，避免误触。
   */
  developerMode: boolean
  /**
   * **每种路径类型的参数**（内置 4 种 + 用户自定义）—— 路径样式的唯一来源。
   *
   * 颜色、线宽、虚线、末端变细、平滑、端点、连接全都住在这里的 `params` 里。
   * 内置 4 种永远存在且顺序固定；自定义项由用户在设置页增删。
   */
  pathTypes: PathTypeEntry[]
  /**
   * 每种路径类型的颜色 —— **旧字段**，只读兼容。
   *
   * 它已经不再是渲染依据（渲染一律走 `pathTypes`）。保留是为了：
   * 1. 迁移上一代 `data.json`（那里只有这一个字段）；
   * 2. 写回时让旧字段与目录保持一致，用户回退到旧版插件仍能看到自己改过的颜色。
   */
  pathColors: PathColorMap
  /**
   * **每种区域类型的参数**（内置 6 种 + 用户自定义）—— 区域样式的唯一来源。
   *
   * 填充色、不透明度、边框色、边框宽、边框虚线都住在这里的 `params` 里。
   * 内置 6 种永远存在且顺序固定；自定义项由用户在设置页增删。
   *
   * ⚠️ 与 `MapRegion.type` 一样是**可选语义**：升级前画的区域没有类型字段，
   * 由颜色反查显示名（见 `regionTypeCatalog.regionLabelForColor`）。
   */
  regionTypes: RegionTypeEntry[]
  /**
   * 区域预设色 —— **旧字段**，只读兼容（与 `pathColors` 同一个处境）。
   *
   * 它已经不再是渲染依据（渲染一律走 `regionTypes`）。保留是为了：
   * 1. 迁移上一代 `data.json`（那里只有这一个字段）；
   * 2. 写回时让旧字段与目录保持一致，用户回退到旧版插件仍能看到自己改过的颜色。
   */
  regionColors: string[]
  /** 名称字体族；`''` = 跟随主题 */
  labelFontFamily: string
  /**
   * 用户自定义地形（内置 9 种之外的）。
   *
   * 这里的 `id`（形如 `custom:swamp2`）就是写进地图文件的 `terrain.<格键>.t` 的值，
   * 与显示名完全解耦：改显示名不影响已存数据，删掉定义也不会删掉地图上的格子
   * （它们会退化成回退视觉，数据仍在文件里）。
   */
  customTerrains: CustomTerrain[]
  /**
   * 用户自定义标记图标（内置 9 种之外的）。
   *
   * 与 `customTerrains` 完全同构：`id`（形如 `custom:lighthouse`）就是写进地图文件的
   * `markers[].icon` 的值，显示名与数据解耦；删掉定义不会删掉地图上的标记
   * （它们退化成回退视觉，数据仍在文件里）。
   */
  customMarkers: CustomMarker[]
  /**
   * 用户自定义生物群系（内置 34 条之外的）。
   *
   * 与 `customTerrains` / `customMarkers` 完全同构：`id`（形如 `custom:xxx`）就是写进地图文件的
   * `terrain[].biome` 的值；**颜色与标签也在这里**（`BIOMES.md` §3 决定三：每条自带颜色，
   * 组内只提供默认值）。删掉定义不会删掉格上的值（它们退化成"未知"并按中性灰画出来）。
   *
   * ⚠️ 本轮的**设置页还没有增删改的界面**（分类表是可整表替换的配置，编辑 UI 待做）——
   * 但目录工厂、规范化与"值 → 颜色"的整条通路都已就位，加 UI 只是接线。
   */
  customBiomes: CustomBiome[]
  /**
   * 图层可见性（地形 / 网格 / 区域 / 路径 / 标记 / 名称）—— **库级那一份**。
   *
   * 为什么放在设置里而不是写进地图文件：图层是"我现在想看到什么"，
   * 地图文件描述的是"世界上有什么"。把显示偏好写进数据，
   * 等于换个看法就改了用户的地图，还会污染 Git diff。
   *
   * ⚠️ W4-2 起它是**"默认值 / 新建地图的初值"**，不再是一张图的实况：某张图单独调过之后，
   * 它那一份住在 `mapViews[那张图的路径].layers`；读的时候"按地图优先、缺则回落到这里"。
   * 写入侧两处一起更新（镜像），于是"新建一张图会沿用你上次调好的样子"。
   */
  layers: LayerVisibility
  /**
   * 数值图层（温度 / 深度…）的渲染参数：配色、越界色、不透明度、是否画数值 —— **库级那一份**。
   *
   * 与 `layers` 的分工是**刻意**的：`layers` 管"看不看"，这里管"怎么看"。
   * 两边都只存一份（§5.12）—— 所以这里**没有** `visible` 字段，
   * 可见性一律去 `layers` 里读（设计草案 §4.6 曾把 `visible` 写进这一节，那是两处真相，已改）。
   * 值本身属于地图文件，**不在这里**。
   *
   * ⚠️ 与 `layers` 同一条（W4-2）：它是"默认值 / 初值"，某张图的实况在 `mapViews[…].overlays`。
   */
  overlays: OverlayStyles
  /** 是否显示画布上的图例（默认关）—— **库级那一份**（W4-2 起同样是"默认值 / 初值"） */
  showLegend: boolean
  /**
   * **按地图路径分份**的视图偏好（W4-2）。
   *
   * 键 = **库内相对路径**（`Maps/World.map.md`），与 `store` / frontmatter 用的是同一套标识：
   * - 不用 canvas 路径：同一张图可以被多个 Canvas 引用，按 canvas 分份会给**同一张图两份设置**
   *   （与"按地图分份"自相矛盾）；
   * - 不用 frontmatter 的 `name`：可能重名，而且改名会把设置丢掉。
   *
   * 老配置迁移**不需要做任何事**：老 `data.json` 里只有库级那三个字段 ⇒ 这张表是空的 ⇒
   * 每张图都用库级那一份 ⇒ 迁移前后视觉完全一致。**刻意不给现有地图各复制一条记录**：
   * 用户没改过的东西不该被写下来，也不该让 `data.json` 无端膨胀。
   */
  mapViews: Record<string, MapViewSettings>
  /**
   * 是否隐藏**设置页顶部**的「快速上手」清单。
   *
   * 两份引导各有一个开关（设置页 / 侧栏面板），因为它们是两份不同的文案、
   * 出现的时机也不同：用户可能只想关掉其中一份。
   * 语义是"用户主动关掉的" —— 默认 `false`（显示），垃圾值也当显示，
   * 这样"读不懂的设置"只会多一次引导，而不是让人再也找不到它。
   */
  hideQuickStartSettings: boolean
  /** 是否隐藏**侧栏面板顶部**的「快速上手」清单（同上，两份互不影响） */
  hideQuickStartPanel: boolean
  /**
   * 上次导出地图时用的库内文件夹（`''` = 库根）—— 导出的**默认落点**。
   *
   * 为什么留在这里而不是写进地图文件：它不是"这个世界的事实"，只是"我上次把图放哪了"。
   * 写进地图文件的话，把图分享给别人会连带改掉对方的导出位置（判据见 `UI-REORG-PLAN.md` §5 第 9 条）。
   * 没记录过（`''`）时，默认落点仍是**地图文件所在目录** —— 与加这个字段之前的行为一致。
   */
  exportFolder: string
}

/** 出厂路径类型目录（内置 4 种、参数即出厂值） */
const DEFAULT_PATH_TYPES: PathTypeEntry[] = normalizePathTypeEntries(undefined)

/** 出厂区域类型目录（内置 6 种、参数即出厂值） */
const DEFAULT_REGION_TYPES: RegionTypeEntry[] = normalizeRegionTypeEntries(undefined)

export const DEFAULT_SETTINGS: CartographerSettings = {
  labelScale: 1,
  developerMode: false,
  pathTypes: DEFAULT_PATH_TYPES,
  pathColors: pathColorsFromEntries(DEFAULT_PATH_TYPES),
  regionTypes: DEFAULT_REGION_TYPES,
  regionColors: regionColorsFromEntries(DEFAULT_REGION_TYPES),
  labelFontFamily: '',
  customTerrains: [],
  customMarkers: [],
  customBiomes: [],
  layers: DEFAULT_LAYER_VISIBILITY,
  // 出厂配色 / 透明度：每次新对象，避免与 DEFAULT_SETTINGS 共用同一份引用
  overlays: defaultOverlayStyles(),
  showLegend: false,
  // 按地图分份的视图偏好：出厂是空的（每张图都用上面那三份"模板"）
  mapViews: {},
  hideQuickStartSettings: false,
  hideQuickStartPanel: false,
  // 空串 = 没记录过：导出默认还落在地图文件所在目录（与加这个字段之前一致）
  exportFolder: '',
}

export const LABEL_SCALE_MIN = 0.5
export const LABEL_SCALE_MAX = 3
export const LABEL_SCALE_STEP = 0.1

/**
 * 把任意输入收敛成合法倍率（数据文件可能被手工改坏）。
 *
 * ⚠️ 只有 `number` 与"非空字符串"才算用户真的给了值。
 * 不能直接写 `Number(value)`：`Number(null)`、`Number('')`、`Number([])` 都是 **0**，
 * 于是本该"没填 → 用默认值"的情况会变成"夹到下限 0.5"——
 * 用户手工把 `data.json` 写成 `"labelScale": null` 之后，字号会莫名其妙变成最小，
 * 而且没有任何地方能看出原因（这条是补测试时当场抓到的）。
 */
export function normalizeLabelScale(value: unknown): number {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.labelScale
  return Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, Math.round(numeric * 10) / 10))
}

/**
 * 把任意输入收敛成"可用的库内文件夹路径"。
 *
 * 只做清洗、不做白名单：文件夹**不要求存在**（用户可以先写一个新目录名，
 * 导出时由 Obsidian 自己建 —— 与"能填库内路径"的既有口径一致）。
 * 反斜杠一律换成 `/`（Windows 上复制来的路径），空段、`.`、`..` 段丢掉 ——
 * 否则 `A/../B` 这种路径会绕过"库内"这个前提。
 * 幂等：再跑一次结果相同（`tests/settings.test.ts` 钉住）。
 */
export function normalizeExportFolder(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/')
}

/**
 * 把任意输入收敛成一份完整设置。
 *
 * 三条刻意的选择：
 * 1. **未知键丢掉**：`data.json` 里出现不认识的字段（别的版本写的、手工加的）不该被带进来；
 * 2. **缺项按出厂默认补齐**，而不是留 `undefined`：调用方各处 `?? 兜底` 才是真正的隐患来源；
 * 3. **布尔字段只在明确为 `true` 时为真**（`showLegend` / `developerMode`），
 *    垃圾值一律当"关" —— 反过来（垃圾值当"开"）会让用户莫名其妙多出一个面板。
 *
 * 迁移：`pathColors`（上一代唯一的路径样式字段）与 `pathStyleOverrides`（更早的画法表）
 * 都只作为**迁移输入**读一次，结果进 `pathTypes`；之后目录就是唯一来源。
 * 迁移是幂等的（再跑一次结果相同），而且**用户没改过任何东西时结果等于出厂值** ——
 * 也就是"迁移前后视觉完全一致"。
 */
export function normalizeSettings(raw: unknown): CartographerSettings {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pathTypes = normalizePathTypeEntries(source.pathTypes, {
    pathColors: asRecord(source.pathColors),
    pathStyleOverrides: asRecord(source.pathStyleOverrides),
  })
  const regionTypes = normalizeRegionTypeEntries(source.regionTypes, {
    // 旧字段只作为迁移输入读一次：`regionColors` 的下标与内置 6 种一一对应
    regionColors: source.regionColors,
  })
  return {
    labelScale: normalizeLabelScale(source.labelScale),
    developerMode: source.developerMode === true,
    pathTypes,
    // 旧字段与目录保持一致（不是第二个来源：渲染从不读它，见 CartographerSettings.pathColors）
    pathColors: pathColorsFromEntries(pathTypes),
    regionTypes,
    regionColors: regionColorsFromEntries(regionTypes),
    labelFontFamily: normalizeFontFamily(source.labelFontFamily),
    // 自定义地形逐条独立校验：data.json 被手工改坏时只丢坏的那一条，其余照常可用
    customTerrains: normalizeCustomTerrains(source.customTerrains),
    // 同上：自定义标记也逐条独立校验
    customMarkers: normalizeCustomMarkers(source.customMarkers),
    customBiomes: normalizeCustomBiomes(source.customBiomes),
    // 图层：**只有这一份状态**（网格也在里面，不再有并列的 showGrid 字段）。
    // `source.showGrid` 只作为**迁移输入**读一次：早期只有这一个开关，
    // 老用户把它关掉过的话必须变成"隐藏网格"，不能因为换代就把他的选择丢掉。
    layers: layerVisibilityFromLegacy({ showGrid: source.showGrid, layers: source.layers }),
    // 数值图层样式：缺项 / 坏值按出厂补齐（配色交给 colorRamp 自己的规范化）
    overlays: normalizeOverlayStyles(source.overlays),
    showLegend: source.showLegend === true,
    // 按地图分份的视图偏好（W4-2）：老配置里没有这一项 ⇒ 空表 ⇒ 每张图都用上面那三份模板
    // （于是"迁移前后视觉完全一致"，而且不需要给现有地图各复制一条记录）
    mapViews: normalizeMapViews(source.mapViews),
    // 引导可见性：与 showLegend / developerMode 同一口径 —— 只有明确写着 true 才算"关掉了"。
    // 反过来的话（垃圾值当"已隐藏"）会让用户与引导失联，而引导正是他唯一能找到入口的地方。
    hideQuickStartSettings: source.hideQuickStartSettings === true,
    hideQuickStartPanel: source.hideQuickStartPanel === true,
    // 导出落点：清洗成库内相对路径；垃圾值收敛成 `''`（= 没记录过，回落到地图所在目录）
    exportFolder: normalizeExportFolder(source.exportFolder),
  }
}

/** 只把"对象"当成迁移输入；数字、字符串、数组一律当没给（旧字段可能被手工改坏） */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 把任意输入收敛成 `mapViews`：键按"库内相对路径"清洗，值是三个可选字段。
 *
 * 三条刻意的选择：
 * 1. **键要去重与清洗**：`A//B`、`A\B`、` A/B ` 都应归到同一个键，否则同一张图会被拆成两份设置
 *    （与"值本身"那条纪律同源：**同一件事只能有一个键**）；
 * 2. **值不是对象就整条丢掉**（不是"填成默认值"）：填默认值会让这条**盖住**库级模板 ——
 *    数据被手工改坏时，用户宁可按模板显示，也不要莫名其妙看到"全部图层都开着"；
 * 3. **空条目（三个字段一个都没有）不留键**：与"空表不留键"同一条口径，别让 data.json 长垃圾。
 *
 * 幂等：再跑一次结果相同（`tests/settings.test.ts` 钉住）。
 */
export function normalizeMapViews(raw: unknown): Record<string, MapViewSettings> {
  const source = asRecord(raw)
  if (source === undefined) return {}
  const out: Record<string, MapViewSettings> = {}
  for (const [rawKey, value] of Object.entries(source)) {
    const key = normalizeExportFolder(rawKey)
    if (key.length === 0) continue
    const entry = asRecord(value)
    if (entry === undefined) continue
    const item: MapViewSettings = {}
    const overlays = asRecord(entry.overlays)
    if (overlays !== undefined) item.overlays = normalizeOverlayStyles(overlays)
    const layers = asRecord(entry.layers)
    if (layers !== undefined) item.layers = normalizeLayerVisibility(layers)
    if (typeof entry.showLegend === 'boolean') item.showLegend = entry.showLegend
    if (Object.keys(item).length > 0) out[key] = item
  }
  return out
}

/** 设置 → 绘制层消费的调色板 */
export function paletteOf(settings: CartographerSettings): StylePalette {
  return {
    pathColors: settings.pathColors,
    regionColors: settings.regionColors,
    fontFamily: settings.labelFontFamily,
  }
}
