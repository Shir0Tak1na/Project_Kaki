/**
 * Base 视图的行模型（**纯函数**）。
 *
 * 视图把两个来源合并成一张统一的表：
 * - **地图文档**：标记 / 文字标注 / 路径 / 区域（来自 `.map.md` 的 fenced JSON）；
 * - **查询结果**：每个带 `coordinates` 的笔记 —— 它同时也是一枚标记。
 *
 * 合并成"行"而不是直接渲染，是为了：
 * 1. 表与地图预览共用同一份数据（不会出现"列表里有、图上没有"）；
 * 2. 排序/统计/诊断都能用纯函数测，不必启动 Obsidian。
 */

import type { Point } from '../core/hex.ts'
import { polygonAnchor, polylineMidpoint } from '../render/shapeGeometry.ts'
import type { MapDocument, MapPath, PathType } from '../data/mapDocument.ts'
import type { NoteMapProps } from './noteCoordinates.ts'
import { iconOrDefault } from './noteCoordinates.ts'

export type MapRowSource = 'note' | 'map'
export type MapRowKind = 'note' | 'marker' | 'label' | 'path' | 'region'

export interface MapRow {
  /** 稳定 id：`note:<路径>` 或 `map:<kind>:<id>` */
  id: string
  source: MapRowSource
  kind: MapRowKind
  name: string
  /** 世界坐标；无坐标的条目（例如刚建的空区域）为 null */
  point: Point | null
  /** 关联文件：笔记行 = 该笔记；地图行 = 地图文档 */
  filePath: string
  /** 补充说明（路径类型、顶点数等），给表格的"详情"列用 */
  detail: string
  /** 笔记行带上图标（缺省 town），地图行不带 */
  icon?: string
  /** 地区（笔记属性 `region`） */
  region?: string
  /** 笔记行：属性写法有问题（坐标解析失败），需要在 UI 上提示 */
  invalid?: boolean
}

export interface NoteRowInput {
  /** 笔记路径（也是打开链接的目标） */
  path: string
  /** 显示名（一般是文件名，不含扩展名） */
  name: string
  props: NoteMapProps
}

export const PATH_KIND_LABELS: Record<PathType, string> = {
  river: '河流',
  road: '道路',
  'trade-route': '贸易路线',
  border: '边界',
}

function pathDetail(path: MapPath): string {
  const type = PATH_KIND_LABELS[path.type] ?? path.type
  return `${type} · ${path.pts.length} 点`
}

/**
 * 由地图文档生成行。
 *
 * 区域用面积质心、路径用弧长中点作为"代表性坐标"：
 * 与名称标签画在同一处，用户看到的位置和表里的坐标能对上。
 */
export function rowsFromDocument(document: MapDocument, mapPath: string): MapRow[] {
  const rows: MapRow[] = []

  for (const marker of document.markers) {
    rows.push({
      id: `map:marker:${marker.id}`,
      source: 'map',
      kind: 'marker',
      name: marker.label,
      point: { x: marker.p[0], y: marker.p[1] },
      filePath: marker.link ?? mapPath,
      detail: `标记 · ${marker.icon}`,
      icon: marker.icon,
    })
  }

  for (const label of document.labels) {
    rows.push({
      id: `map:label:${label.id}`,
      source: 'map',
      kind: 'label',
      name: label.text,
      point: { x: label.p[0], y: label.p[1] },
      filePath: label.link ?? mapPath,
      detail: '文字标注',
    })
  }

  for (const path of document.paths) {
    const anchor = polylineMidpoint(path.pts.map(([x, y]) => ({ x, y })))
    rows.push({
      id: `map:path:${path.id}`,
      source: 'map',
      kind: 'path',
      name: path.label && path.label.length > 0 ? path.label : `（未命名${PATH_KIND_LABELS[path.type] ?? path.type}）`,
      point: anchor ? anchor.point : null,
      filePath: path.link ?? mapPath,
      detail: pathDetail(path),
    })
  }

  for (const region of document.regions) {
    const anchor = polygonAnchor(region.pts.map(([x, y]) => ({ x, y })))
    rows.push({
      id: `map:region:${region.id}`,
      source: 'map',
      kind: 'region',
      name: region.label && region.label.length > 0 ? region.label : '（未命名区域）',
      point: anchor,
      filePath: region.link ?? mapPath,
      detail: `区域 · ${region.pts.length} 顶点`,
    })
  }

  return rows
}

/** 由查询结果（笔记）生成行 */
export function rowsFromNotes(notes: readonly NoteRowInput[]): MapRow[] {
  return notes.map((note) => {
    const row: MapRow = {
      id: `note:${note.path}`,
      source: 'note',
      kind: 'note',
      name: note.name,
      point: note.props.point,
      filePath: note.path,
      detail: note.props.point ? `${iconOrDefault(note.props)} · ${Math.round(note.props.point.x)}, ${Math.round(note.props.point.y)}` : '缺少坐标',
      icon: iconOrDefault(note.props),
    }
    if (note.props.region !== null) row.region = note.props.region
    if (note.props.invalid) row.invalid = true
    return row
  })
}

export function buildMapRows(options: {
  document: MapDocument | null
  mapPath: string | null
  notes: readonly NoteRowInput[]
}): MapRow[] {
  const rows = options.notes ? rowsFromNotes(options.notes) : []
  if (options.document && options.mapPath) {
    rows.push(...rowsFromDocument(options.document, options.mapPath))
  }
  return rows
}

export type RowSortKey = 'name' | 'kind' | 'source' | 'x' | 'y'

/**
 * 排序。`name` 用 `localeCompare` 以便中文按拼音排序；
 * 坐标排序时**没有坐标的行排在最后**（而不是被当成 0 混在中间）。
 */
export function sortRows(rows: readonly MapRow[], key: RowSortKey, descending = false): MapRow[] {
  const direction = descending ? -1 : 1
  const sorted = [...rows]
  sorted.sort((a, b) => {
    let result = 0
    switch (key) {
      case 'name':
        result = a.name.localeCompare(b.name, 'zh-Hans-CN')
        break
      case 'kind':
        result = a.kind.localeCompare(b.kind)
        break
      case 'source':
        result = a.source.localeCompare(b.source)
        break
      case 'x':
      case 'y': {
        const left = a.point ? (key === 'x' ? a.point.x : a.point.y) : null
        const right = b.point ? (key === 'x' ? b.point.x : b.point.y) : null
        if (left === null && right === null) result = 0
        else if (left === null) return 1
        else if (right === null) return -1
        else result = left - right
        break
      }
    }
    if (result === 0) result = a.id.localeCompare(b.id)
    return result * direction
  })
  return sorted
}

export interface RowSummary {
  total: number
  notes: number
  mapEntries: number
  withCoordinates: number
  invalidNotes: number
  byKind: Record<MapRowKind, number>
}

export function summarizeRows(rows: readonly MapRow[]): RowSummary {
  const byKind: Record<MapRowKind, number> = { note: 0, marker: 0, label: 0, path: 0, region: 0 }
  let withCoordinates = 0
  let invalidNotes = 0
  for (const row of rows) {
    byKind[row.kind] += 1
    if (row.point) withCoordinates += 1
    if (row.invalid) invalidNotes += 1
  }
  return {
    total: rows.length,
    notes: rows.filter((row) => row.source === 'note').length,
    mapEntries: rows.filter((row) => row.source === 'map').length,
    withCoordinates,
    invalidNotes,
    byKind,
  }
}

/**
 * 把"带坐标的笔记行"转成可直接绘制的标记形状。
 *
 * 地图预览要把笔记当成标记画出来，但它不该认识 Base 的数据结构 ——
 * 因此在这里完成转换（纯函数、可测）。
 */
export function noteRowsAsMarkers(
  rows: readonly MapRow[],
): Array<{ id: string; label: string; x: number; y: number; icon: string; link: string; region?: string }> {
  const out: Array<{ id: string; label: string; x: number; y: number; icon: string; link: string; region?: string }> = []
  for (const row of rows) {
    if (row.source !== 'note' || !row.point) continue
    const marker = {
      id: row.id,
      label: row.name,
      x: row.point.x,
      y: row.point.y,
      icon: row.icon ?? 'town',
      link: row.filePath,
    }
    out.push(row.region ? { ...marker, region: row.region } : marker)
  }
  return out
}
