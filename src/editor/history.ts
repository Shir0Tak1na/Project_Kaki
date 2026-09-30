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
import { cellsEqual } from '../data/mapDocument.ts'
import type {
  MapDefinitions,
  MapDocument,
  MapLabel,
  MapMarker,
  MapPath,
  MapRegion,
  TerrainCell,
} from '../data/mapDocument.ts'
import type { ElevationCalibration } from '../render/elevationUnits.ts'
import type { DataDefaults } from '../render/dataDefaults.ts'

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

/**
 * 可以被"改名 / 改链接"的四类对象。
 *
 * 为什么把它们收进**一个** op 而不是各写一套（标记改名、文字改名、区域改名…）：
 * 侧栏检查器对四类对象的操作是同一件事（改名称、改链接），
 * 一套 op = 一条撤销路径 = 一处要维护的地方。已有的 `renamePath` / `setPathLink` /
 * `renameRegion` 保持不变（老调用点与单测继续用），新的通用 op 覆盖全部四类。
 */
export type ObjectKind = 'marker' | 'label' | 'path' | 'region'

/** 改「对象 → 笔记」的链接；逆操作就是交换 from/to */
export interface SetLinkOp {
  kind: 'setLink'
  target: ObjectKind
  id: string
  from: string
  to: string
}

/**
 * 改名称（标记/路径/区域用 `label`，文字标注用 `text` —— 文字标注的"名字"就是它显示的文字）。
 *
 * 语义与既有 `renamePath` 一致：**清空 = 删掉该字段**（路径/标记的 label 是可选的）；
 * 而 `MapMarker.label` / `MapRegion.label` / `MapLabel.text` 是必填字段，清空写空串。
 * 这个差别写在 `applyOp` 里一处，避免四类对象各自解释"空名字"。
 */
export interface RenameObjectOp {
  kind: 'renameObject'
  target: ObjectKind
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
  | SetLinkOp
  | RenameObjectOp
  | SetObjectFieldOp
  | SetCellFieldOp
  | TranslateObjectOp
  | SetElevationOp
  | SetDataDefaultsOp
  | SetDefinitionsOp

/**
 * 改对象上的**一个字段**（类型 / 颜色 / 线宽 / 虚线 / 不透明度 / 位置…）。
 *
 * 为什么是一个通用 op、而不是给每种字段各写一个（`setMarkerIcon` / `setPathColor`…）：
 * 侧栏检查器里这些编辑是同一件事（改对象自己的一个参数），一套 op 就是一条撤销路径。
 * 加一个新字段（以后可能是"温度带"）不需要碰历史层。
 *
 * `to === null` = **删掉该字段**（例如"清除单格叠加色"），而不是写一个 null 进去 ——
 * 文件里少一个键和多一个 `null` 是两种不同的东西（解析层对前者的处理是"没有这个覆盖"）。
 */
export interface SetObjectFieldOp {
  kind: 'setObjectField'
  target: ObjectKind
  id: string
  field: string
  from: ObjectFieldValue
  to: ObjectFieldValue
}

/** 字段可接受的取值（`null` = 删除该字段） */
export type ObjectFieldValue = string | number | number[] | null

/**
 * 原地改**格上**的一个字段（地块的类型 `t` / 单格叠加色 `c`）。
 *
 * 为什么不能复用 `setObjectField`：地块不是"带 id 的对象数组"，而是 `terrain` 映射里的一项，
 * 键是 `cellKey(q, r)`。单独一个 op 比"给 setObjectField 加一个 key 分支"更好读，
 * 也避免把两种存储形状混进同一段代码。
 *
 * ⚠️ 实现里**改的是映射里那个对象本身**，不重建它：这样格上不认识的字段（`extra`，
 * 见 `mapDocument.ts` 的 `TerrainCell.extra`）在改类型时不会被顺手丢掉。
 */
export interface SetCellFieldOp {
  kind: 'setCellField'
  /** `cellKey(q, r)` */
  key: string
  field: string
  from: ObjectFieldValue
  to: ObjectFieldValue
}

/**
 * 整体平移一个路径或区域（顶点相对位置不变）。
 *
 * 为什么记 `dx/dy` 而不是新旧顶点列表：平移是**刚体**变换，记位移量就够还原，
 * op 也小得多（几十个顶点的区域不该把整套坐标抄两遍）。
 * 逆操作就是把 `dx/dy` 取反。
 */
export interface TranslateObjectOp {
  kind: 'translateObject'
  target: 'path' | 'region'
  id: string
  dx: number
  dy: number
}

/**
 * 改地图级的**海拔标定**（`document.elevation` 那一段）。
 *
 * 为什么单独一个 op、而复用 `setObjectField`：它不是"数组里某个带 id 的对象"，
 * 而是与 `grid` 同级的顶层段（见 `mapDocument.ts`）。`from` / `to` 都是**整段**，
 * 于是"清空标定"（`to: null`）与"从标定改成另一组值"是同一条路径，
 * 撤销一次就回到原样 —— 与"地图级元数据一次改一处"的形状一致。
 */
export interface SetElevationOp {
  kind: 'setElevation'
  /** 改之前的标定；`null` = 当时还没有这一段 */
  from: ElevationCalibration | null
  /** 改之后的标定；`null` = 删掉这一段（回到"未标定"） */
  to: ElevationCalibration | null
}

/**
 * 改地图级的**每格默认值**（`document.dataDefaults` 那一段）。
 *
 * 与 `SetElevationOp` 同一个形状、同一个理由：它是与 `grid` 同级的顶层段，
 * 不是"数组里某个带 id 的对象"。`from` / `to` 都是**整段**（`null` = 没有这一段），
 * 于是"清空默认值"与"从一组改成另一组"走同一条路径，撤销一次回到原样。
 */
export interface SetDataDefaultsOp {
  kind: 'setDataDefaults'
  from: DataDefaults | null
  to: DataDefaults | null
}

/**
 * 改地图级的**定义集**（`document.definitions` 那一段，v2 方案 B）。
 *
 * 与 `SetElevationOp` / `SetDataDefaultsOp` 同一个形状、同一个理由：它是与 `grid` 同级的顶层段。
 * `null` = 没有这一段（v1 老图）。
 *
 * ⚠️ 比那两个多一对**版本号**：老图（v1）第一次改定义要升到 v2，撤销必须把这个数字也还原 ——
 * 否则"改一次再撤销"会留下一张版本号变了、内容却没变的文件（老图「一个字节都不动」的承诺就破了）。
 */
export interface SetDefinitionsOp {
  kind: 'setDefinitions'
  from: MapDefinitions | null
  fromVersion: number
  to: MapDefinitions | null
  toVersion: number
}

/**
 * 按 `target` 取出对象本体（**返回原对象引用**，调用方只改它自己的字段）。
 *
 * 刻意不重建对象：改一个字段却重建整个对象，很容易顺手丢掉"这一版不认识的字段"
 * （`ENGINEERING-NOTES.md` §5.11：未知值属于用户的数据，不属于我们的显示偏好）。
 */
function objectOf(document: MapDocument, target: ObjectKind, id: string): Record<string, unknown> | null {
  switch (target) {
    case 'marker':
      return (document.markers.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'label':
      return (document.labels.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'path':
      return (document.paths.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
    case 'region':
      return (document.regions.find((item) => item.id === id) as unknown as Record<string, unknown>) ?? null
  }
}

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
    case 'setLink': {
      const object = objectOf(document, op.target, op.id)
      if (object === null) return
      if (op.to.length > 0) object.link = op.to
      else delete object.link
      return
    }
    case 'renameObject': {
      const object = objectOf(document, op.target, op.id)
      if (object === null) return
      if (op.target === 'label') {
        object.text = op.to
        return
      }
      if (op.target === 'path') {
        // 路径的 label 是可选的：清空 = 删掉字段（与既有 `renamePath` 同一语义）
        if (op.to.length > 0) object.label = op.to
        else delete object.label
        return
      }
      // 标记与区域的 label 是必填字段：清空写空串，不删字段（删了会让解析层以为缺字段）
      object.label = op.to
      return
    }
    case 'setObjectField': {
      const object = objectOf(document, op.target, op.id)
      if (object === null) return
      // 只动这一个键：对象上别的字段（含这一版不认识的）原样留着
      if (op.to === null) delete object[op.field]
      else object[op.field] = Array.isArray(op.to) ? [...op.to] : op.to
      return
    }
    case 'setCellField': {
      const cell = document.terrain[op.key] as unknown as Record<string, unknown> | undefined
      if (cell === undefined) return
      if (op.to === null) delete cell[op.field]
      else cell[op.field] = Array.isArray(op.to) ? [...op.to] : op.to
      return
    }
    case 'translateObject': {
      const list = op.target === 'path' ? document.paths : document.regions
      const shape = list.find((item) => item.id === op.id)
      if (!shape) return
      shape.pts = shape.pts.map((point) => [point[0] + op.dx, point[1] + op.dy] as [number, number])
      return
    }
    case 'setElevation': {
      // 整段替换 / 整段删除：`to === null` = 把这一段去掉（回到"未标定"，老地图的形状）
      if (op.to === null) delete document.elevation
      else document.elevation = { ...op.to }
      return
    }
    case 'setDataDefaults': {
      // 与标定同一条：`to === null` = 删掉这一段（回到"不兜底"）。
      // 注意**不写空对象** —— 归一化保证整段要么有值、要么不存在（见 `dataDefaults.ts`）
      if (op.to === null) delete document.dataDefaults
      else document.dataDefaults = { ...op.to }
      return
    }
    case 'setDefinitions': {
      // 整段替换 / 整段删除：与标定同一条路。
      // 版本号一起写回 —— 老图第一次改定义升到 v2，撤销时再落回 v1（见 `SetDefinitionsOp`）
      if (op.to === null) delete document.definitions
      else document.definitions = op.to
      document.version = op.toVersion
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
    case 'setLink':
      return { ...op, from: op.to, to: op.from }
    case 'renameObject':
      return { ...op, from: op.to, to: op.from }
    case 'setObjectField':
      return { ...op, from: op.to, to: op.from }
    case 'setCellField':
      return { ...op, from: op.to, to: op.from }
    case 'translateObject':
      // 逆操作就是把位移取反（刚体变换的逆还是刚体变换）
      return { ...op, dx: -op.dx, dy: -op.dy }
    case 'setElevation':
      // 整段对调：改回原标定、或重新删掉这一段
      return { kind: 'setElevation', from: op.to, to: op.from }
    case 'setDataDefaults':
      // 同一个形状：整段对调（`from` / `to` 里为 `null` 的那一端就是"删掉这一段"）
      return { kind: 'setDataDefaults', from: op.to, to: op.from }
    case 'setDefinitions':
      // 整段对调，**连同版本号一起**（见 `SetDefinitionsOp`）
      return {
        kind: 'setDefinitions',
        from: op.to,
        fromVersion: op.toVersion,
        to: op.from,
        toVersion: op.fromVersion,
      }
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
  return opsFromPreviousOf(cells, () => next, previousOf)
}

/** 逐格算出"这一格该变成什么"（`null` = 这一格要被删掉） */
export type CellNextOf = (q: number, r: number) => TerrainCell | null

/**
 * `opsFromPrevious` 的**逐格版本**：新状态按格现算，而不是所有格共用一个。
 *
 * 为什么必须有这一版：**格上除了地形还有别的东西**（单格叠加色、位标志、以及这一版
 * 不认识的键 —— 未来的温度 / 深度就挂在这里）。共用一个新建的 `{ t }` 等于"整格替换"，
 * 会把同一格上的其它键一起抹掉，而"有没有变化"的判断只看 `t/f/c` 时更糟：
 * **用同一种地形重刷一遍 → 判定成没变化 → 连 op 都不产生 → Ctrl+Z 也救不回来**。
 *
 * `nextOf` 的调用方要自己以"该格原有内容为底"来构造新值（见 `MapEditor.nextCellFor`）。
 */
export function opsFromPreviousOf(
  cells: Array<{ q: number; r: number }>,
  nextOf: CellNextOf,
  previousOf: (q: number, r: number) => TerrainCell | null,
): MapOp[] {
  const seen = new Set<string>()
  const ops: MapOp[] = []
  for (const cell of cells) {
    const key = cellKey(cell.q, cell.r)
    if (seen.has(key)) continue
    seen.add(key)

    const previous = previousOf(cell.q, cell.r)
    const next = nextOf(cell.q, cell.r)
    // 「有没有变化」与「写盘是什么形状」是同一个函数（`canonicalCellJson` / `cellsEqual`）。
    // 手写 `t/f/c` 三个字段的比较会漏掉"这一版不认识的键"，那正是丢数据的地方。
    if (cellsEqual(previous, next)) continue

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
