/**
 * 「Fictional Map」Base 视图。
 *
 * 这是地图与笔记之间的**双向桥**：地图文档里的标记/区域/路径，与笔记前置元数据里
 * 写了 `coordinates` 的条目，合并成同一张表；点任意一行都能跳到对应的文件。
 *
 * 设计取舍：
 * - **不把几何数据写进 `.base`**：`.base` 是 YAML，只放"指向地图文档"的视图选项，
 *   几何仍然只有一份（在 `.map.md` 里）。这样同一张地图能被多个 Base 视图与多个 canvas 共用。
 * - **数据准备全是纯函数**（`mapRows.ts` / `noteCoordinates.ts`），这个类只负责取数据与画 DOM。
 *   于是"坐标解析对不对、两个来源有没有漏"都能在没有 Obsidian 的情况下测。
 * - 选项缺失时**必须仍然可用**：用户可以完全不配视图选项，先看到笔记侧的数据，
 *   再按提示选地图文档。配置错误一律给出可读的原因，不静默留白。
 */

import { BasesView, Notice, type BasesPropertyId, type QueryController } from 'obsidian'
import type { MapDocument } from '../data/mapDocument.ts'
import type { MapDocumentStore } from '../data/MapDocumentStore.ts'
import {
  buildMapRows,
  sortRows,
  summarizeRows,
  type MapRow,
  type NoteRowInput,
  type RowSortKey,
} from './mapRows.ts'
import { buildMapPreviewSvg } from './mapPreview.ts'
import type { CustomTerrain } from '../render/terrainCatalog.ts'
import { pathTypeLabelOf, type PathTypeEntry } from '../render/pathTypeCatalog.ts'
import { regionTypeLabelOf, type RegionTypeEntry } from '../render/regionTypeCatalog.ts'
import { parseNoteMapProps } from './noteCoordinates.ts'
import {
  BASES_VIEW_TYPE,
  DEFAULT_COORD_PROPERTY,
  DEFAULT_REGION_PROPERTY,
  DEFAULT_TYPE_PROPERTY,
  OPTION_KEYS,
} from './viewContract.ts'

export { BASES_VIEW_TYPE, OPTION_KEYS, DEFAULT_COORD_PROPERTY, DEFAULT_TYPE_PROPERTY, DEFAULT_REGION_PROPERTY }

export interface BasesViewDeps {
  app: {
    vault: { getAbstractFileByPath(path: string): unknown }
    workspace: { openLinkText(link: string, source: string, newLeaf: boolean): void }
  }
  store: MapDocumentStore
  /**
   * 用户自定义地形（来自插件设置）。
   *
   * 缩略图与画布必须**同一套解析**：缩略图里出现一个和画布不同颜色的格子，
   * 用户第一反应是"地图文件坏了"。传函数而不是值，理由同 `getStylePalette`（现读）。
   */
  getCustomTerrains?: () => readonly CustomTerrain[]
  /**
   * 路径类型目录（来自插件设置）。
   *
   * Base 行里"（未命名河流）"这类文案必须与画布、图例用**同一套**名字 ——
   * 表里写 `custom:highway` 而画布上叫"官道"，用户会以为是两条不同的东西。
   */
  getPathTypes?: () => readonly PathTypeEntry[]
  /**
   * 区域类型目录（来自插件设置）。
   *
   * 与 `getPathTypes` 同理：Base 行里区域的类型名必须与画布、图例说同一句话。
   * 缺省时不带类型名（旧区域本来也没有类型字段）。
   */
  getRegionTypes?: () => readonly RegionTypeEntry[]
  /** 诊断与测试用：最近一次渲染的统计 */
  onRendered?: (info: { rows: number; notes: number; mapEntries: number; reason?: string }) => void
}

/** `config.get()` 的返回值可能是路径字符串，也可能是文件对象 */
function asPath(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null
  if (value && typeof value === 'object') {
    const candidate = (value as { path?: unknown }).path
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return null
}

function asPropertyId(value: unknown, fallback: string): BasesPropertyId {
  const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  return text as BasesPropertyId
}

export class MapBasesView extends BasesView {
  override type = BASES_VIEW_TYPE

  private readonly deps: BasesViewDeps
  private readonly containerEl: HTMLElement
  private document: MapDocument | null = null
  private mapPath: string | null = null
  private lastError: string | null = null
  /** 防止"文件加载完成后回来覆盖新一次渲染"的竞态 */
  private loadToken = 0
  private previewObserver: ResizeObserver | null = null

  constructor(controller: QueryController, containerEl: HTMLElement, deps: BasesViewDeps) {
    super(controller)
    this.deps = deps
    this.containerEl = containerEl
  }

  /** Bases 在数据/配置变化时调用它 */
  override onDataUpdated(): void {
    // 先用现有数据渲染一帧（不闪白屏），再异步把地图文档读进来后重绘。
    // 注意：地图文档的读取**必须**在这里发起 —— 漏掉这一步的表现是
    // "表格只有笔记、地图条目永远是 0"，而界面上没有任何报错。
    this.render()
    void this.loadMapDocument()
  }

  /** 最近一次渲染的错误（诊断用） */
  getLastError(): string | null {
    return this.lastError
  }

  // ------------------------------------------------------------ 取数据

  private noteInputs(): NoteRowInput[] {
    const coordId = asPropertyId(this.config.get(OPTION_KEYS.coordProperty), DEFAULT_COORD_PROPERTY)
    const typeId = asPropertyId(this.config.get(OPTION_KEYS.typeProperty), DEFAULT_TYPE_PROPERTY)
    const regionId = asPropertyId(this.config.get(OPTION_KEYS.regionProperty), DEFAULT_REGION_PROPERTY)

    const entries = this.data?.data ?? []
    return entries.map((entry) => {
      const file = entry.file
      const props = parseNoteMapProps({
        coordinates: readValue(entry, coordId),
        mapType: readValue(entry, typeId),
        region: readValue(entry, regionId),
      })
      return { path: file.path, name: file.basename, props }
    })
  }

  /**
   * 载入地图文档。
   *
   * `config.get('mapFile')` 是用户在视图选项里选的路径；没配时不报错 ——
   * 只显示笔记侧的数据，并在界面上提示怎么配（配置错误的静默留白最难查）。
   */
  private async loadMapDocument(): Promise<void> {
    const token = ++this.loadToken
    const path = asPath(this.config.get(OPTION_KEYS.mapFile))
    if (path === null) {
      // 没指定地图时，如果库里只有一张地图，就用它（省掉一次配置）
      const maps = this.deps.store.listMapFiles()
      if (maps.length === 1 && maps[0]) {
        await this.readMap(maps[0].path, token)
        return
      }
      this.mapPath = null
      this.document = null
      if (token === this.loadToken) this.render()
      return
    }
    await this.readMap(path, token)
  }

  private async readMap(path: string, token: number): Promise<void> {
    const abstract = this.deps.app.vault.getAbstractFileByPath(path)
    if (!abstract) {
      if (token === this.loadToken) {
        this.lastError = `找不到地图文档：${path}`
        this.mapPath = null
        this.document = null
        this.render()
      }
      return
    }
    const loaded = await this.deps.store.load(abstract as never)
    if (token !== this.loadToken) return
    if (loaded.document === null) {
      this.lastError = `地图文档无法解析：${path}`
      this.mapPath = null
      this.document = null
      this.render()
      return
    }
    this.lastError = null
    this.document = loaded.document
    this.mapPath = path
    this.render()
  }

  // ------------------------------------------------------------ 渲染

  private render(): void {
    this.previewObserver?.disconnect()
    this.previewObserver = null
    this.containerEl.empty()
    this.containerEl.addClass('fc-base-view')

    let rows: MapRow[]
    try {
      rows = buildMapRows({
        document: this.document,
        mapPath: this.mapPath,
        notes: this.noteInputs(),
        // 路径类型的显示名跟着**目录**走（自定义类型显示用户起的名字，未知 ID 显示「未知（…）」）
        resolvePathTypeLabel: (type) => pathTypeLabelOf(type, this.deps.getPathTypes?.() ?? []),
        // 区域同理；没有类型字段的旧区域由 mapRows 退回通用名「区域」
        resolveRegionTypeLabel: (type) => regionTypeLabelOf(type, this.deps.getRegionTypes?.() ?? []),
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.containerEl.createEl('div', { cls: 'fc-base-empty', text: `渲染失败：${this.lastError}` })
      return
    }

    const sortKey = this.sortKey()
    const sorted = sortRows(rows, sortKey)
    const summary = summarizeRows(sorted)
    this.deps.onRendered?.({
      rows: summary.total,
      notes: summary.notes,
      mapEntries: summary.mapEntries,
      ...(this.lastError ? { reason: this.lastError } : {}),
    })

    this.renderHeader(summary)
    if (this.document && this.mapPath) {
      this.renderPreview(sorted)
    }
    if (sorted.length === 0) {
      this.renderEmptyState()
      return
    }
    this.renderTable(sorted)
    this.renderWarnings(sorted)
  }

  private renderPreview(rows: readonly MapRow[]): void {
    const preview = this.containerEl.createEl('div', { cls: 'fc-base-preview-wrap' })
    const redraw = () => {
      const width = preview.clientWidth > 0 ? Math.min(1200, Math.max(240, preview.clientWidth)) : 360
      const height = Math.round(width * 0.5)
      preview.innerHTML = buildMapPreviewSvg(this.document, rows, {
        width,
        height,
        padding: 12,
        customTerrains: this.deps.getCustomTerrains?.() ?? [],
      })
    }
    redraw()
    preview.addEventListener('click', (event) => {
      const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null
      const shape = target?.closest?.('[data-row-id]')
      const rowId = shape?.getAttribute('data-row-id')
      const row = rowId ? rows.find((candidate) => candidate.id === rowId) : undefined
      if (row) this.openRow(row)
    })
    if (typeof ResizeObserver !== 'undefined') {
      this.previewObserver = new ResizeObserver(() => redraw())
      this.previewObserver.observe(preview)
    }
  }

  private sortKey(): RowSortKey {
    const raw = this.config.get(OPTION_KEYS.sortBy)
    const key = typeof raw === 'string' ? raw : 'name'
    return key === 'kind' || key === 'source' || key === 'x' || key === 'y' ? key : 'name'
  }

  private renderHeader(summary: ReturnType<typeof summarizeRows>): void {
    const line = this.containerEl.createEl('div', { cls: 'fc-base-summary' })
    const mapLabel = this.mapPath ?? '（未选择地图文档）'
    line.createEl('span', { cls: 'fc-base-summary-map', text: mapLabel })
    line.createEl('span', {
      cls: 'fc-base-summary-counts',
      text: `笔记 ${summary.notes} · 地图条目 ${summary.mapEntries} · 共 ${summary.total}`,
    })
    if (this.lastError) {
      line.createEl('span', { cls: 'fc-base-summary-error', text: this.lastError })
    }
  }

  private renderEmptyState(): void {
    const box = this.containerEl.createEl('div', { cls: 'fc-base-empty' })
    box.createEl('div', { text: '这张 Base 里还没有地图数据。' })
    const list = box.createEl('ul')
    list.createEl('li', {
      text: '给笔记加上 coordinates 属性，例如 coordinates: [320, -140]（也接受 "320,-140" 或 {x: 320, y: -140}）。',
    })
    list.createEl('li', { text: '在视图选项里选择「地图文档」，即可同时列出地图上的标记 / 区域 / 路径。' })
  }

  private renderTable(rows: readonly MapRow[]): void {
    const table = this.containerEl.createEl('table', { cls: 'fc-base-table' })
    const head = table.createEl('thead').createEl('tr')
    for (const title of ['名称', '类型', '来源', '坐标', '详情']) head.createEl('th', { text: title })

    const body = table.createEl('tbody')
    for (const row of rows) {
      const tr = body.createEl('tr', { cls: `fc-base-row fc-base-row-${row.source}` })
      if (row.invalid) tr.addClass('is-invalid')
      const nameCell = tr.createEl('td', { cls: 'fc-base-name' })
      nameCell.createEl('a', { text: row.name, href: '#' })
      nameCell.addEventListener('click', (event) => {
        event.preventDefault()
        this.openRow(row)
      })
      tr.createEl('td', { cls: 'fc-base-kind', text: KIND_LABELS[row.kind] })
      tr.createEl('td', { cls: 'fc-base-source', text: row.source === 'note' ? '笔记' : '地图' })
      tr.createEl('td', {
        cls: 'fc-base-coords',
        text: row.point ? `${Math.round(row.point.x)}, ${Math.round(row.point.y)}` : '—',
      })
      tr.createEl('td', { cls: 'fc-base-detail', text: row.detail })
    }
  }

  private renderWarnings(rows: readonly MapRow[]): void {
    const invalid = rows.filter((row) => row.invalid)
    if (invalid.length === 0) return
    const box = this.containerEl.createEl('div', { cls: 'fc-base-warning' })
    box.createEl('div', {
      text: `${invalid.length} 个笔记的 coordinates 无法解析，已按"没有坐标"处理：`,
    })
    const list = box.createEl('ul')
    for (const row of invalid) {
      list.createEl('li', { text: row.filePath })
    }
  }

  private openRow(row: MapRow): void {
    try {
      // 地图行指向地图文档本身；笔记行指向该笔记
      this.deps.app.workspace.openLinkText(row.filePath, '', false)
    } catch (error) {
      console.error('[project-kaki] 打开失败', error)
      new Notice(`无法打开：${row.filePath}`, 5000)
    }
  }
}

const KIND_LABELS: Record<MapRow['kind'], string> = {
  note: '笔记',
  marker: '标记',
  label: '文字',
  path: '路径',
  region: '区域',
}

/** 读取条目属性值；`getValue` 可能返回 null（属性不存在） */
function readValue(entry: { getValue(id: BasesPropertyId): unknown }, id: BasesPropertyId): unknown {
  try {
    return entry.getValue(id)
  } catch {
    // 属性名非法时 Obsidian 可能抛错；按"没有这个属性"处理，而不是让整个视图挂掉
    return null
  }
}
