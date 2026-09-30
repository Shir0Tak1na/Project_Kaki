/**
 * 自定义定义的**重命名迁移**：改一个定义的 ID 时，把地图里已经画好的引用一起改掉。
 *
 * 为什么要有这个：ID 是机器认的键，用户想改它（拼错了、想统一命名）时，
 * 光改设置里的定义只会让地图里那些对象**认不出自己的定义**（变成"未知（custom:xxx）"）。
 * 所以要么不改，要么**连引用一起改** —— 后者必须能说清影响面，且绝不能顺手改坏别的字段。
 *
 * 这一层只做**纯计算**：给出"哪里引用了它、改成什么"。真正的落盘由调用方负责
 * （见 `main.ts` 的 `renameCustomDefinition`），这样才能在没有 Obsidian 的环境里测。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import type { MapDefinitionSet } from '../data/mapDefinitions.ts'
import { markerIdProblem, normalizeMarkerId } from './markerCatalog.ts'
import { normalizePathTypeId, pathTypeIdProblem } from './pathTypeCatalog.ts'
import { normalizeRegionTypeId, regionTypeIdProblem } from './regionTypeCatalog.ts'
import { normalizeTerrainId, terrainIdProblem } from './terrainCatalog.ts'

/**
 * 改 ID 时用的校验与归一化 —— **直接转发各自目录里的实现**，不另写一套。
 *
 * 理由：新增定义与改 ID 必须共用同一套规则。两套规则一旦分叉，就会出现
 * "建得出来的 ID 改不过去"或者"改完之后下次解析被判非法"这种自相矛盾的状态。
 */
export function definitionIdProblem(kind: DefinitionKind, raw: unknown): string | null {
  switch (kind) {
    case 'terrain':
      return terrainIdProblem(raw)
    case 'marker':
      return markerIdProblem(raw)
    case 'path':
      return pathTypeIdProblem(raw)
    case 'region':
      return regionTypeIdProblem(raw)
  }
}

export function definitionIdNormalize(kind: DefinitionKind, raw: unknown): string | null {
  switch (kind) {
    case 'terrain':
      return normalizeTerrainId(raw)
    case 'marker':
      return normalizeMarkerId(raw)
    case 'path':
      return normalizePathTypeId(raw)
    case 'region':
      return normalizeRegionTypeId(raw)
  }
}

/**
 * 四类自定义定义（与设置里的四个数组一一对应）。
 *
 * 命名刻意与设置字段一致：`customTerrains` / `customMarkers` / `pathTypes` / `regionTypes`。
 */
export type DefinitionKind = 'terrain' | 'marker' | 'path' | 'region'

export const DEFINITION_KIND_LABELS: Record<DefinitionKind, string> = {
  terrain: '地形',
  marker: '标记',
  path: '路径类型',
  region: '区域类型',
}

/** 引用 ID 的字段名（报告文案里要说清"改的是哪个字段"） */
export const DEFINITION_KIND_FIELDS: Record<DefinitionKind, string> = {
  terrain: 'cells[].t',
  marker: 'markers[].icon',
  path: 'paths[].type',
  region: 'regions[].type',
}

/** 提示文案里用的「改的是哪里」说法（例如「地图文件里的 cells[].t」） */
export function definitionKindFieldHint(kind: DefinitionKind): string {
  return `地图文件里的 ${DEFINITION_KIND_FIELDS[kind]}` 
}

/** 一份地图文档里，某个定义 ID 被引用了多少次 */
export function countReferences(document: MapDocument, kind: DefinitionKind, id: string): number {
  switch (kind) {
    case 'terrain': {
      let count = 0
      for (const cell of Object.values(document.terrain)) {
        if (cell.t === id) count += 1
      }
      return count
    }
    case 'marker':
      return document.markers.filter((marker) => marker.icon === id).length
    case 'path':
      return document.paths.filter((path) => path.type === id).length
    case 'region':
      return document.regions.filter((region) => region.type === id).length
  }
}

/**
 * 一份地图文档里出现的每一个自定义 ID → 引用次数。
 *
 * 用途是"一次把影响面说清"：用户改一个 ID 之前，我们需要告诉他这份地图里
 * 还有哪些自定义定义在用（否则他会以为只影响自己正在改的那一个）。
 */
export function countReferencesById(document: MapDocument, kind: DefinitionKind): Map<string, number> {
  const out = new Map<string, number>()
  const bump = (id: unknown): void => {
    if (typeof id !== 'string' || id.length === 0) return
    out.set(id, (out.get(id) ?? 0) + 1)
  }
  switch (kind) {
    case 'terrain':
      for (const cell of Object.values(document.terrain)) bump(cell.t)
      break
    case 'marker':
      for (const marker of document.markers) bump(marker.icon)
      break
    case 'path':
      for (const path of document.paths) bump(path.type)
      break
    case 'region':
      for (const region of document.regions) bump(region.type)
      break
  }
  return out
}

export interface RenameResult {
  document: MapDocument
  /** 实际改动的引用条数（0 = 这份文档不受影响，调用方可以不写盘） */
  changed: number
}

/**
 * 把**定义集里**某一类的定义 ID 换掉（定义随图：定义本体住在地图文件里）。
 *
 * 为什么与 `renameReferences` 分开：那个改的是"对象引用的类型 ID"（`paths[].type` 之类），
 * 这个改的是 `definitions` 段里那一条定义自己 —— 两件事都必须做，
 * 只做前者会留下一条没人引用的旧定义，只做后者会让所有已画对象变成"未知"。
 *
 * 返回**新集合**；没改到时**原样返回同一个对象引用**，调用方据此判断"要不要写盘"
 * （与 `renameReferences` 用 `changed: 0` 表达同一件事，口径一致）。
 */
export function renameDefinitionEntry(
  set: MapDefinitionSet,
  kind: DefinitionKind,
  fromId: string,
  toId: string,
): MapDefinitionSet {
  if (fromId === toId) return set
  const rename = <T extends { id: string }>(list: T[]): T[] | null => {
    if (!list.some((item) => item.id === fromId)) return null
    return list.map((item) => (item.id === fromId ? { ...item, id: toId } : item))
  }
  switch (kind) {
    case 'terrain': {
      const list = rename(set.terrains)
      return list === null ? set : { ...set, terrains: list }
    }
    case 'marker': {
      const list = rename(set.markers)
      return list === null ? set : { ...set, markers: list }
    }
    case 'path': {
      const list = rename(set.pathTypes)
      return list === null ? set : { ...set, pathTypes: list }
    }
    case 'region': {
      const list = rename(set.regionTypes)
      return list === null ? set : { ...set, regionTypes: list }
    }
  }
}

/**
 * 把引用 `fromId` 的地方换成 `toId`，**其余字段原样保留**。
 *
 * 三个必须守住的点（都有单测钉住）：
 * 1. **只改该改的**：同类型里别的 ID、其它三类定义、以及每个对象自己的参数（颜色、线宽、虚线…）一律不动；
 * 2. **不留半成品**：`fromId === toId` 时原样返回（`changed: 0`），避免"改了个寂寞"却被记成改动；
 * 3. **不就地改入参**：返回新对象，调用方（撤销栈、预览）可以放心拿着旧文档比对。
 */
export function renameReferences(
  document: MapDocument,
  kind: DefinitionKind,
  fromId: string,
  toId: string,
): RenameResult {
  if (fromId === toId) return { document, changed: 0 }
  const terrain: MapDocument['terrain'] = { ...document.terrain }
  let changed = 0

  switch (kind) {
    case 'terrain':
      for (const [key, cell] of Object.entries(document.terrain)) {
        if (cell.t !== fromId) continue
        terrain[key] = { ...cell, t: toId }
        changed += 1
      }
      return changed === 0
        ? { document, changed: 0 }
        : { document: { ...document, terrain }, changed }
    case 'marker': {
      const markers = document.markers.map((marker) => {
        if (marker.icon !== fromId) return marker
        changed += 1
        return { ...marker, icon: toId }
      })
      return changed === 0 ? { document, changed: 0 } : { document: { ...document, markers }, changed }
    }
    case 'path': {
      const paths = document.paths.map((path) => {
        if (path.type !== fromId) return path
        changed += 1
        return { ...path, type: toId }
      })
      return changed === 0 ? { document, changed: 0 } : { document: { ...document, paths }, changed }
    }
    case 'region': {
      const regions = document.regions.map((region) => {
        if (region.type !== fromId) return region
        changed += 1
        return { ...region, type: toId }
      })
      return changed === 0 ? { document, changed: 0 } : { document: { ...document, regions }, changed }
    }
  }
}

export interface RenameFilePlan {
  /** 库内路径 */
  path: string
  /** 这份文件里会被改动的引用条数 */
  changed: number
}

export interface RenamePlan {
  kind: DefinitionKind
  fromId: string
  toId: string
  /** 逐文件的影响面（只含 `changed > 0` 的文件，按路径排序 —— 报告里顺序稳定才可比对） */
  files: RenameFilePlan[]
  totalChanged: number
}

export interface DeletionFilePlan {
  /** 库内路径 */
  path: string
  /** 这份文件里引用了多少次 */
  count: number
}

export interface DeletionPlan {
  kind: DefinitionKind
  /** 要删掉的定义 ID */
  id: string
  /** 逐文件的影响面（只含 `count > 0` 的文件，按路径排序 —— 报告里顺序稳定才可比对） */
  files: DeletionFilePlan[]
  /** 库里所有地图加起来引用了它多少次 */
  total: number
}

/**
 * 汇总一份"删除定义"的影响面。
 *
 * 为什么删除也要先说影响面：删除**不动地图数据**（格子/标记/路径/区域都还在文件里，
 * 只是画成"未知"回退样式），但用户看不到这一点 —— 他能看到的只是"我画的地形变成了灰菱形"。
 * 于是这段文案必须把**两件事分开说**：
 * 1. 有哪些地图、各多少处在用它（"变了的是什么"）；
 * 2. **这些对象不会被删除**、删除的只是这条定义、随时可以重建（"没变的是什么"）。
 *
 * `total === 0` 时不说任何"会变成未知"的话 —— 没有引用就没有影响面，
 * 那种情况下的额外解释只会变成噪音（用户删的是一条从没被用过的定义）。
 */
export function describeDeletionPlan(plan: DeletionPlan): string {
  const label = DEFINITION_KIND_LABELS[plan.kind]
  if (plan.total === 0) {
    return `没有地图引用它，可以安全删除：只会把${label}定义 ${plan.id} 从设置里移除。`
  }
  const lines = [`${plan.files.length} 张地图里共 ${plan.total} 处引用 ${plan.id}：`]
  for (const file of plan.files) {
    lines.push(`  · ${file.path}：${file.count} 处`)
  }
  lines.push(
    '这些对象不会被删除，仍留在文件里，只是画成回退样式（未知）。',
    `删除的只是这条${label}定义（${plan.id}），可随时重新建回。`,
  )
  return lines.join('\n')
}

/** 汇总一份计划：把"逐文件的改动数"拼成人话（确认框与报告共用，文案只有一份） */
export function describeRenamePlan(plan: RenamePlan): string {
  const label = DEFINITION_KIND_LABELS[plan.kind]
  if (plan.totalChanged === 0) {
    return `没有地图引用 ${plan.fromId}：只会把${label}定义的 ID 改成 ${plan.toId}。`
  }
  const lines = [
    `将把 ${plan.files.length} 张地图里共 ${plan.totalChanged} 处引用从 ${plan.fromId} 改成 ${plan.toId}，`,
    `并把${label}定义的 ID 一并改掉：`,
  ]
  for (const file of plan.files) {
    lines.push(`  · ${file.path}：${file.changed} 处`)
  }
  return lines.join('\n')
}
