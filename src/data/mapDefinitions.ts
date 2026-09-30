/**
 * 定义集：地图文件里的 `definitions` 块 ↔ 运行时用的那五个目录。
 *
 * ## 这一层为什么单独存在
 *
 * `mapDocument.ts` 只做**结构**校验（每类是不是数组），条目级校验必须 import 各目录的
 * `normalize*` —— 而各目录里有的会反过来 import `mapDocument`（例如 `markerCatalog` 要
 * `MARKER_ICONS`）。把"目录级规范化"放进本模块，`data/mapDocument.ts` 就只需要 `import type`，
 * 环因此不存在（见 `MapDefinitions` 的注释）。
 *
 * ## 三条口径（与 `UI-REORG-PLAN.md` §5.1 对齐）
 *
 * 1. **地图文件是定义的权威**（方案 B，用户 m01845 裁定）：分享一张图 ⇒ 对方拿到完整定义，
 *    不再出现"未定义类型"；同一个 `custom:xxx` 在不同地图里可能长得不一样，这是**已接受的风险**。
 * 2. **内置定义仍留在代码里**：文件里只放"自定义的 + 参数被改过的内置项"。
 *    地形 / 标记 / 生物群系三类的目录里本来就只有自定义项，直接整表带走；
 *    路径类型 / 区域类型的目录含内置项（参数可由用户改），也整表带走 ——
 *    于是"这张图用的是哪套线宽 / 填充色"在文件里是完整的，不依赖打开者本机的设置。
 * 3. **老文件一个字节都不动**：v1 地图没有 `definitions`，读的时候用"当时库级设置那一份"
 *    做**内存快照**（`definitionSetFromDocument` 的 `fallback`），只有用户真的改了定义才回写升版。
 *
 * ## 纯函数、不 import obsidian
 *
 * 与 `mapDocument.ts` 同一口径，于是规范化、迁移、回写三种情况都能被单元测试直接覆盖。
 */

import { normalizeCustomBiomes, type CustomBiome } from '../render/biomeCatalog.ts'
import { normalizeCustomMarkers, type CustomMarker } from '../render/markerCatalog.ts'
import { normalizePathTypeEntries, type PathTypeEntry } from '../render/pathTypeCatalog.ts'
import { normalizeRegionTypeEntries, type RegionTypeEntry } from '../render/regionTypeCatalog.ts'
import { normalizeCustomTerrains, type CustomTerrain } from '../render/terrainCatalog.ts'
import type { MapDefinitions, MapDocument } from './mapDocument.ts'

/** 一张地图的**定义集**（运行时形状）：五个目录。 */
export interface MapDefinitionSet {
  terrains: CustomTerrain[]
  markers: CustomMarker[]
  biomes: CustomBiome[]
  /** 内置 4 种 + 自定义（参数是"这张图用的那一套"） */
  pathTypes: PathTypeEntry[]
  /** 内置 6 种 + 自定义 */
  regionTypes: RegionTypeEntry[]
}

/**
 * 从"库级设置那一份目录"造一个定义集。
 *
 * 用途有两个：① **新建地图**时的出厂快照；② **老图（v1）**读进来时的迁移初值。
 * 入参用结构类型而不是 `CartographerSettings`：`data/` 不该 import `ui/`
 * （那个方向会让"数据层能被单测直接覆盖"这条失效）。
 */
export function definitionSetFromLibrary(input: {
  customTerrains?: unknown
  customMarkers?: unknown
  customBiomes?: unknown
  pathTypes?: unknown
  regionTypes?: unknown
}): MapDefinitionSet {
  return {
    terrains: normalizeCustomTerrains(input.customTerrains),
    markers: normalizeCustomMarkers(input.customMarkers),
    biomes: normalizeCustomBiomes(input.customBiomes),
    pathTypes: normalizePathTypeEntries(input.pathTypes),
    regionTypes: normalizeRegionTypeEntries(input.regionTypes),
  }
}

/**
 * 从地图文件里那一段还原定义集。
 *
 * - 有 `definitions` ⇒ **以文件为准**（缺的那一类按"这张图没有它"处理，退回内置默认）；
 * - 没有（v1 老图）⇒ 用 `fallback`（读时那份库级设置）做**内存快照**，**不写回文件**。
 */
export function definitionSetFromDocument(
  document: Pick<MapDocument, 'definitions'> | null,
  fallback: MapDefinitionSet,
): MapDefinitionSet {
  const block = document?.definitions
  if (block === undefined) return fallback
  return definitionSetFromBlock(block, fallback)
}

/**
 * 从 `definitions` 块还原定义集；块里缺的分类沿用 `fallback` 的那一类。
 *
 * 为什么要 fallback 而不是"缺了就退回内置"：老图升上来的那一刻，内存里的文档已经带了
 * 一份从库级设置拍的快照（见 `definitionSetFromDocument`），而块里可能只有用户改过的那几类
 * —— 缺的那些必须仍然是快照，否则一升级就悄悄丢掉了库级设置里那几条自定义定义。
 */
export function definitionSetFromBlock(block: MapDefinitions, fallback: MapDefinitionSet): MapDefinitionSet {
  return {
    terrains: block.terrains ? normalizeCustomTerrains(block.terrains) : fallback.terrains,
    markers: block.markers ? normalizeCustomMarkers(block.markers) : fallback.markers,
    biomes: block.biomes ? normalizeCustomBiomes(block.biomes) : fallback.biomes,
    pathTypes: block.pathTypes ? normalizePathTypeEntries(block.pathTypes) : fallback.pathTypes,
    regionTypes: block.regionTypes ? normalizeRegionTypeEntries(block.regionTypes) : fallback.regionTypes,
  }
}

/**
 * 把定义集写成 `definitions` 块。
 *
 * ## 五类**都写**，空的也写成 `[]`（W4-1b 修正，理由是一条真实的缺陷）
 *
 * 路径 / 区域类型整表带走：它们**参数可改**，不带就等于把用户的线宽留在了自己机器上
 * （分享出去就变样）。地形 / 标记 / 生物群系三类整表带走。
 *
 * 早先（W4-1a）空分类**不留键**，读的时候缺键就沿用库级快照 —— 那条路有一个说不通的后果：
 * **用户把最后一个自定义地形删掉之后，它会被库级快照顶回来**（键没了 ⇒ 读取认为"沿用模板"）。
 * 一旦"定义随图"（方案 B）成立，`definitions` 这一段就是**这张图的全部事实**，
 * 缺一个键只能是"这张图没有它"，于是写入必须把五类都摆出来（`[]` 也是明确的一句"没有"）。
 *
 * 读的一侧仍保留"缺键沿用快照"（见 `definitionSetFromBlock`）：那是给**手工写过 / 旧版插件写过**
 * 的不完整块留的安全网，不是常规路径。
 *
 * `carryOver` = 地图文件里**原有的那一段**：用它把本插件不认识的分类（`extra`）原样带过去 ——
 * 改一个地形的颜色不该顺手删掉别的版本写下的 `weathers`（§5.11「认不出 ≠ 丢弃」）。
 */
export function definitionsBlockOf(set: MapDefinitionSet, carryOver?: MapDefinitions): MapDefinitions {
  const block: MapDefinitions = {
    terrains: set.terrains,
    markers: set.markers,
    biomes: set.biomes,
    pathTypes: set.pathTypes,
    regionTypes: set.regionTypes,
  }
  if (carryOver?.extra !== undefined && Object.keys(carryOver.extra).length > 0) block.extra = carryOver.extra
  return block
}

/** 定义集是否为空（五类都没有）—— 空的时候不必给地图文件加这一段 */
export function isEmptyDefinitionSet(set: MapDefinitionSet): boolean {
  return (
    set.terrains.length === 0 &&
    set.markers.length === 0 &&
    set.biomes.length === 0 &&
    set.pathTypes.length === 0 &&
    set.regionTypes.length === 0
  )
}

/**
 * 这份定义集是不是**全是出厂值**（没有任何自定义项，路径与区域类型也都是出厂参数）。
 *
 * 用途是"没有可搬运的东西"这一道守门（W4-3 的导出）：定义随图之后，定义文件里总是带着
 * 内置路径 / 区域类型（整套目录），所以"四类都空"这条老判据永远为假 ——
 * 真正该拦的是"这份定义集跟出厂一模一样，搬过去等于什么都没搬"。
 *
 * 写出一份"什么也没带"的文件比不写更糟：用户会以为导出成功了（与 `ExportModal` 那条同源）。
 */
export function isFactoryDefinitionSet(set: MapDefinitionSet): boolean {
  if (set.terrains.length > 0 || set.markers.length > 0 || set.biomes.length > 0) return false
  return (
    JSON.stringify(set.pathTypes) === JSON.stringify(normalizePathTypeEntries(undefined)) &&
    JSON.stringify(set.regionTypes) === JSON.stringify(normalizeRegionTypeEntries(undefined))
  )
}

/**
 * 两份定义集**内容**是否相同（不比较对象身份）。
 *
 * 为什么需要它：`definitionsOf` 的备忘是按"那份 `definitions` 对象的身份"建的，
 * 而同一张地图**重新解析一次**会得到身份不同、内容相同的一份 —— 身份比较会把
 * "内容没变"误判成"变了"，于是界面白重建一次（严重时成环：见 `DefinitionManagerModal.refreshFromMap`）。
 * 比较的是写盘用的那一份（`definitionsBlockOf`），所以"文件里长什么样"就是判据。
 */
export function sameDefinitionSet(a: MapDefinitionSet, b: MapDefinitionSet): boolean {
  if (a === b) return true
  return JSON.stringify(definitionsBlockOf(a)) === JSON.stringify(definitionsBlockOf(b))
}