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
import type { LayerVisibility } from '../render/layerVisibility.ts'
import { DEFAULT_LAYER_VISIBILITY, layerVisibilityFromLegacy } from '../render/layerVisibility.ts'
import type { PathColorMap, StylePalette } from '../render/stylePalette.ts'
import {
  defaultPathColors,
  defaultRegionColors,
  normalizeFontFamily,
  normalizePathColors,
  normalizeRegionColors,
} from '../render/stylePalette.ts'

export interface CartographerSettings {
  /** 名称字号倍率（1 = 默认）。范围 0.5–3.0，步长 0.1。 */
  labelScale: number
  /**
   * 开发者模式：打开后才会出现开发用探针命令（诊断 Canvas / 监视视口变化）。
   * 关着时这些命令会从命令面板里**隐藏**，避免误触。
   */
  developerMode: boolean
  /** 每种路径类型的默认颜色（新画的路径用它） */
  pathColors: PathColorMap
  /** 区域预设色（新画的区域用它） */
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
   * 图层可见性（地形 / 网格 / 区域 / 路径 / 标记 / 名称）。
   *
   * 为什么放在设置里而不是写进地图文件：图层是"我现在想看到什么"，
   * 地图文件描述的是"世界上有什么"。把显示偏好写进数据，
   * 等于换个看法就改了用户的地图，还会污染 Git diff。
   */
  layers: LayerVisibility
  /** 是否显示画布上的图例（默认关：图例是"要看的时候才看"的东西） */
  showLegend: boolean
}

export const DEFAULT_SETTINGS: CartographerSettings = {
  labelScale: 1,
  developerMode: false,
  pathColors: defaultPathColors(),
  regionColors: defaultRegionColors(),
  labelFontFamily: '',
  customTerrains: [],
  layers: DEFAULT_LAYER_VISIBILITY,
  showLegend: false,
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
 * 把任意输入收敛成一份完整设置。
 *
 * 三条刻意的选择：
 * 1. **未知键丢掉**：`data.json` 里出现不认识的字段（别的版本写的、手工加的）不该被带进来；
 * 2. **缺项按出厂默认补齐**，而不是留 `undefined`：调用方各处 `?? 兜底` 才是真正的隐患来源；
 * 3. **布尔字段只在明确为 `true` 时为真**（`showLegend` / `developerMode`），
 *    垃圾值一律当"关" —— 反过来（垃圾值当"开"）会让用户莫名其妙多出一个面板。
 */
export function normalizeSettings(raw: unknown): CartographerSettings {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    labelScale: normalizeLabelScale(source.labelScale),
    developerMode: source.developerMode === true,
    pathColors: normalizePathColors(source.pathColors),
    regionColors: normalizeRegionColors(source.regionColors),
    labelFontFamily: normalizeFontFamily(source.labelFontFamily),
    // 自定义地形逐条独立校验：data.json 被手工改坏时只丢坏的那一条，其余照常可用
    customTerrains: normalizeCustomTerrains(source.customTerrains),
    // 图层：**只有这一份状态**（网格也在里面，不再有并列的 showGrid 字段）。
    // `source.showGrid` 只作为**迁移输入**读一次：早期只有这一个开关，
    // 老用户把它关掉过的话必须变成"隐藏网格"，不能因为换代就把他的选择丢掉。
    layers: layerVisibilityFromLegacy({ showGrid: source.showGrid, layers: source.layers }),
    showLegend: source.showLegend === true,
  }
}

/** 设置 → 绘制层消费的调色板 */
export function paletteOf(settings: CartographerSettings): StylePalette {
  return {
    pathColors: settings.pathColors,
    regionColors: settings.regionColors,
    fontFamily: settings.labelFontFamily,
  }
}
