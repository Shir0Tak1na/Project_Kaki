/**
 * 编辑历史 —— 纯函数 + 纯数据结构模块。
 *
 * 设计（见设计文档 §5.3）：
 * - **操作型（op-based）栈**，不是整文档快照：每个 op 自带逆操作，撤销=应用逆操作；
 * - 一次**笔画**（按下→拖动→抬起）算**一条**历史，而不是每格一条 ——
 *   否则拖一笔要按几十次 Ctrl+Z 才能退回去；
 * - 上限 100 条，超出丢弃最旧的。
 */

import { cellKey } from '../core/hex.ts'
import type { MapDocument, MapLabel, MapMarker, MapPath, MapRegion, TerrainCell } from '../data/mapDocument.ts'

/** 改一格地形：next 为 null 表示删除（画回空白） */
export interface SetTerrainOp {
  kind: 'setTerrain'
  q: number
  r: number
  next: TerrainCell | null
  previous: TerrainCell | null
}

/**
 * 标记与文字标注的新增/删除。
 * 逆操作就是它的对偶（add ↔ remove），因此 op 里要**带上完整数据**，
 * 这样撤销/重做不需要去别处查原始状态。
 */
export interface AddMarkerOp {
  kind: 'addMarker'
  marker: MapMarker
}
export interface RemoveMarkerOp {
  kind: 'removeMarker'
  marker: MapMarker
}
export interface AddLabelOp {
  kind: 'addLabel'
  label: MapLabel
}
export interface RemoveLabelOp {
  kind: 'removeLabel'
  label: MapLabel
}

/** 移动：from/to 都记在 op 里，逆操作就是交换两者 */
export interface MoveMarkerOp {
  kind: 'moveMarker'
  id: string
  label: string
  from: [number, number]
  to: [number, number]
}
export interface MoveLabelOp {
  kind: 'moveLabel'
  id: string
  text: string
  from: [number, number]
  to: [number, number]
}

/** 路径与区域的新增/删除：与标记同构，op 里带完整数据 */
export interface AddPathOp {
  kind: 'addPath'
  path: MapPath
}
export interface RemovePathOp {
  kind: 'removePath'
  path: MapPath
}
export interface AddRegionOp {
  kind: 'addRegion'
  region: MapRegion
}
export interface RemoveRegionOp {
  kind: 'removeRegion'
  region: MapRegion
}

/** 重命名：from/to 都记在 op 里，逆操作就是交换 */
export interface RenamePathOp {
  kind: 'renamePath'
  id: string
  from: string
  to: string
}
export interface SetPathLinkOp {
  kind: 'setPathLink'
  id: string
  from: string
  to: string
}
export interface RenameRegionOp {
  kind: 'renameRegion'
  id: string
  from: string
  to: string
}

export type MapOp =
  | SetTerrainOp
  | AddMarkerOp
  | RemoveMarkerOp
  | AddLabelOp
  | RemoveLabelOp
  | MoveMarkerOp
  | MoveLabelOp
  | AddPathOp
  | RemovePathOp
  | AddRegionOp
  | RemoveRegionOp
  | RenamePathOp
  | SetPathLinkOp
  | RenameRegionOp

export function applyOp(document: MapDocument, op: MapOp): void {
  switch (op.kind) {
    case 'setTerrain': {
      const key = cellKey(op.q, op.r)
      if (op.next === null) delete document.terrain[key]
      else document.terrain[key] = { ...op.next }
      return
    }
    case 'addMarker': {
      if (!document.markers.some((marker) => marker.id === op.marker.id)) document.markers.push({ ...op.marker })
      return
    }
    case 'removeMarker': {
      document.markers = document.markers.filter((marker) => marker.id !== op.marker.id)
      return
    }
    case 'addLabel': {
      if (!document.labels.some((label) => label.id === op.label.id)) document.labels.push({ ...op.label })
      return
    }
    case 'removeLabel': {
      document.labels = document.labels.filter((label) => label.id !== op.label.id)
      return
    }
    case 'moveMarker': {
      const marker = document.markers.find((item) => item.id === op.id)
      if (marker) marker.p = [op.to[0], op.to[1]]
      return
    }
    case 'moveLabel': {
      const label = document.labels.find((item) => item.id === op.id)
      if (label) label.p = [op.to[0], op.to[1]]
      return
    }
    case 'addPath': {
      if (!document.paths.some((item) => item.id === op.path.id)) document.paths.push({ ...op.path })
      return
    }
    case 'removePath': {
      document.paths = document.paths.filter((item) => item.id !== op.path.id)
      return
    }
    case 'addRegion': {
      if (!document.regions.some((item) => item.id === op.region.id)) document.regions.push({ ...op.region })
      return
    }
    case 'removeRegion': {
      document.regions = document.regions.filter((item) => item.id !== op.region.id)
      return
    }
    case 'renamePath': {
      const path = document.paths.find((item) => item.id === op.id)
      if (!path) return
      if (op.to.length > 0) path.label = op.to
      else delete path.label
      return
    }
    case 'setPathLink': {
      const path = document.paths.find((item) => item.id === op.id)
      if (!path) return
      if (op.to.length > 0) path.link = op.to
      else delete path.link
      return
    }
    case 'renameRegion': {
      const region = document.regions.find((item) => item.id === op.id)
      if (!region) return
      region.label = op.to
      return
    }
  }
}

export function invertOp(op: MapOp): MapOp {
  switch (op.kind) {
    case 'setTerrain':
      return { kind: 'setTerrain', q: op.q, r: op.r, next: op.previous, previous: op.next }
    case 'addMarker':
      return { kind: 'removeMarker', marker: op.marker }
    case 'removeMarker':
      return { kind: 'addMarker', marker: op.marker }
    case 'addLabel':
      return { kind: 'removeLabel', label: op.label }
    case 'removeLabel':
      return { kind: 'addLabel', label: op.label }
    case 'moveMarker':
      return { ...op, from: op.to, to: op.from }
    case 'moveLabel':
      return { ...op, from: op.to, to: op.from }
    case 'addPath':
      return { kind: 'removePath', path: op.path }
    case 'removePath':
      return { kind: 'addPath', path: op.path }
    case 'addRegion':
      return { kind: 'removeRegion', region: op.region }
    case 'removeRegion':
      return { kind: 'addRegion', region: op.region }
    case 'renamePath':
      return { ...op, from: op.to, to: op.from }
    case 'setPathLink':
      return { ...op, from: op.to, to: op.from }
    case 'renameRegion':
      return { ...op, from: op.to, to: op.from }
  }
}

export interface HistoryEntry {
  label: string
  ops: MapOp[]
}

export class History {
  private readonly limit: number
  private undoEntries: HistoryEntry[] = []
  private redoEntries: HistoryEntry[] = []

  constructor(limit = 100) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  /** 压入一条历史（一次笔画调用一次）。压入后重做栈失效。 */
  push(entry: HistoryEntry): void {
    if (entry.ops.length === 0) return
    this.undoEntries.push(entry)
    if (this.undoEntries.length > this.limit) this.undoEntries.shift()
    this.redoEntries = []
  }

  canUndo(): boolean {
    return this.undoEntries.length > 0
  }

  canRedo(): boolean {
    return this.redoEntries.length > 0
  }

  /** 撤销一步；返回被撤销的条目（供调用方提示与触发重绘），无可撤销时返回 null */
  undo(document: MapDocument): HistoryEntry | null {
    const entry = this.undoEntries.pop()
    if (!entry) return null
    // 逆序应用逆操作：后做的先撤
    for (let index = entry.ops.length - 1; index >= 0; index -= 1) {
      applyOp(document, invertOp(entry.ops[index]!))
    }
    this.redoEntries.push(entry)
    return entry
  }

  /** 重做一步 */
  redo(document: MapDocument): HistoryEntry | null {
    const entry = this.redoEntries.pop()
    if (!entry) return null
    for (const op of entry.ops) applyOp(document, op)
    this.undoEntries.push(entry)
    return entry
  }

  clear(): void {
    this.undoEntries = []
    this.redoEntries = []
  }

  size(): { undo: number; redo: number } {
    return { undo: this.undoEntries.length, redo: this.redoEntries.length }
  }

  /** 最近一条历史的标签（用于状态提示） */
  peekLabel(): string | null {
    return this.undoEntries[this.undoEntries.length - 1]?.label ?? null
  }
}

/**
 * 由「一串目标格 + 新状态 + 逐格旧状态查询」生成 op 列表，并**跳过无变化的格**。
 *
 * 跳过很关键：同一笔画内重复经过同一格时，若把每次经过都记成 op，
 * 撤销会变成"逐次回退中间状态"，看起来像是没撤干净。
 *
 * `previousOf` 必须是**笔画开始前**的状态（编辑器在首次触碰某格时就记录下来），
 * 而不是当前文档里的值 —— 笔画是边拖边画的，当前值已经是新值了。
 */
export function opsFromPrevious(
  cells: Array<{ q: number; r: number }>,
  next: TerrainCell | null,
  previousOf: (q: number, r: number) => TerrainCell | null,
): MapOp[] {
  const seen = new Set<string>()
  const ops: MapOp[] = []
  for (const cell of cells) {
    const key = cellKey(cell.q, cell.r)
    if (seen.has(key)) continue
    seen.add(key)

    const previous = previousOf(cell.q, cell.r)
    const same =
      (previous === null && next === null) ||
      (previous !== null &&
        next !== null &&
        previous.t === next.t &&
        (previous.f ?? 0) === (next.f ?? 0) &&
        previous.c === next.c)
    if (same) continue

    // ⚠️ 必须显式判空：`{ ...null }` 得到的是 `{}` 而不是 `null`，
    // 直接展开会让"原本没有地形"的格在撤销时被写成空对象。
    ops.push({
      kind: 'setTerrain',
      q: cell.q,
      r: cell.r,
      next: next === null ? null : { ...next },
      previous: previous === null ? null : { ...previous },
    })
  }
  return ops
}

/** 以当前文档状态为基准的便捷版本（一次性填充、测试用） */
export function buildSetOps(
  document: MapDocument,
  cells: Array<{ q: number; r: number }>,
  next: TerrainCell | null,
): MapOp[] {
  return opsFromPrevious(cells, next, (q, r) => {
    const cell = document.terrain[cellKey(q, r)]
    return cell === undefined ? null : cell
  })
}
