/**
 * 地图文档的读写层（Obsidian 侧）。
 *
 * 关键决策：
 * - **不写 `.canvas`**：绑定关系记录在地图文档的 frontmatter 里（设计文档 §2 ADR-1）；
 * - **原子写**：用 `vault.process()` 做读-改-写，避免与外部编辑互相覆盖；
 * - **防抖 + flush**：编辑期间不频繁落盘，切换视图/退出插件时强制 flush；
 * - **自写保护**：记录自己写入的路径，忽略随之而来的 vault modify 事件，避免自触发循环；
 * - **安全闸**：只覆盖"确实是我们生成的"文件（缺少类型标记就拒绝写，防止误覆盖用户笔记）。
 */

import { TFile, TFolder, normalizePath } from 'obsidian'
import type { App } from 'obsidian'
import {
  createEmptyMapDocument,
  parseMapDocument,
  type MapDocument,
  type MapDocumentIssue,
} from './mapDocument.ts'
import {
  MAP_FILE_TYPE,
  extractFrontmatterBlock,
  extractJsonBlock,
  parseFrontmatter,
  serializeMapFile,
  type MapFileFrontmatter,
} from './mapFile.ts'
import type { GridSpec } from '../core/hex.ts'

/** 编辑期间延迟落盘的时间 */
export const SAVE_DEBOUNCE_MS = 400
/** 判定"这是我自己刚写的"的时间窗（配合 mtime 比对，窗口只用于记录清理） */
const SELF_WRITE_WINDOW_MS = 5000

interface SelfWriteRecord {
  at: number
  /** 写入后该文件的 mtime；与事件里的 mtime 相同才认定是自写 */
  mtime: number
}

export interface LoadedMapDocument {
  file: TFile
  document: MapDocument | null
  frontmatter: MapFileFrontmatter
  issues: MapDocumentIssue[]
  rawText: string
  /** 版本高于本插件支持时为 true：只读打开，绝不写回 */
  readOnly: boolean
}

export interface CreateMapOptions {
  folder?: string
  name: string
  grid?: Partial<GridSpec>
  /** 创建后立即绑定到的 canvas 路径 */
  canvasPath?: string | null
}

interface PendingWrite {
  file: TFile
  document: MapDocument
  name: string
  canvases: string[]
  extraFrontmatter?: Record<string, string | string[]>
  timer: ReturnType<typeof setTimeout>
}

function normalizeCanvasList(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return []
}

function dedupeFileName(base: string): string {
  return base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Map'
}

export class MapDocumentStore {
  private readonly app: App
  private readonly pending = new Map<string, PendingWrite>()
  private readonly selfWrites = new Map<string, SelfWriteRecord>()
  private indexCache: Map<string, string> | null = null
  private disposers: Array<() => void> = []
  /** 索引重建次数：用于验证「自写保护」确实抑制了自触发重建（诊断用） */
  indexBuildCount = 0

  constructor(app: App) {
    this.app = app
  }

  /**
   * 判断某个 modify 事件是否来自我们自己的写入。
   *
   * 只看时间窗是不够的：外部改动若恰好落在窗口内会被误判为自写，
   * 导致索引迟迟不失效（表现是"在外面改了绑定关系，插件却找不到地图"）。
   * 因此以 **mtime 比对**为准，时间窗只用于记录清理。
   */
  private isSelfWrite(file: TFile): boolean {
    const record = this.selfWrites.get(file.path)
    if (!record) return false
    if (Date.now() - record.at > SELF_WRITE_WINDOW_MS) {
      this.selfWrites.delete(file.path)
      return false
    }
    const mtime = file.stat?.mtime
    return typeof mtime === 'number' && mtime === record.mtime
  }

  /**
   * 对外暴露的自写判定。**渲染层必须用它**：
   * 我们的保存会触发 vault 的 modify 事件，若不加判断就把文件重新加载，
   * 会把内存里正在编辑的文档换掉并清空撤销历史 ——
   * 表现就是"画完一秒后撤销按钮自己变灰了"。
   */
  isOwnWrite(file: TFile): boolean {
    return this.isSelfWrite(file)
  }

  /** 注册 vault 事件（自写保护 + 索引失效）。插件 onload 时调用一次。 */
  start(): void {
    const modifyRef = this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile)) return
      if (this.isSelfWrite(file)) return
      if (this.isMapFile(file)) this.indexCache = null
    })
    const createRef = this.app.vault.on('create', () => {
      this.indexCache = null
    })
    const deleteRef = this.app.vault.on('delete', () => {
      this.indexCache = null
    })
    const renameRef = this.app.vault.on('rename', () => {
      this.indexCache = null
    })
    this.disposers = [
      () => this.app.vault.offref(modifyRef),
      () => this.app.vault.offref(createRef),
      () => this.app.vault.offref(deleteRef),
      () => this.app.vault.offref(renameRef),
    ]
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  // -------------------------------------------------------------- 索引

  private frontmatterOf(file: TFile): Record<string, unknown> | null {
    const cache = this.app.metadataCache.getFileCache(file)
    const frontmatter = cache?.frontmatter
    return frontmatter ? (frontmatter as Record<string, unknown>) : null
  }

  isMapFile(file: TFile): boolean {
    const frontmatter = this.frontmatterOf(file)
    return frontmatter?.type === MAP_FILE_TYPE
  }

  listMapFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isMapFile(file))
  }

  /**
   * canvas 路径 → 地图文档路径。来自 metadataCache 的 frontmatter（Obsidian 解析 YAML 最可靠），
   * 缓存到下一次 vault 变更。
   */
  private buildIndex(): Map<string, string> {
    if (this.indexCache) return this.indexCache
    const index = new Map<string, string>()
    for (const file of this.listMapFiles()) {
      const frontmatter = this.frontmatterOf(file)
      if (!frontmatter) continue
      for (const canvasPath of normalizeCanvasList(frontmatter.canvases)) {
        if (!index.has(canvasPath)) index.set(canvasPath, file.path)
      }
    }
    this.indexCache = index
    this.indexBuildCount += 1
    return index
  }

  mapFilePathForCanvas(canvasPath: string): string | null {
    return this.buildIndex().get(canvasPath) ?? null
  }

  invalidateIndex(): void {
    this.indexCache = null
  }

  // -------------------------------------------------------------- 读

  async load(file: TFile): Promise<LoadedMapDocument> {
    const rawText = await this.app.vault.read(file)
    const issues: MapDocumentIssue[] = []

    const frontmatterBlock = extractFrontmatterBlock(rawText)
    const frontmatter = frontmatterBlock !== null ? parseFrontmatter(frontmatterBlock) : {
      type: null,
      fcVersion: null,
      name: null,
      canvases: [],
      rest: {},
    }

    if (frontmatter.type !== MAP_FILE_TYPE) {
      issues.push({
        level: 'warning',
        path: 'frontmatter.type',
        message: `文件未标记为 ${MAP_FILE_TYPE}（实际为 ${JSON.stringify(frontmatter.type)}）`,
      })
    }

    const block = extractJsonBlock(rawText)
    if (!block) {
      issues.push({ level: 'error', path: '', message: '文件里找不到 ```json 代码块，无法读取地图数据' })
      return { file, document: null, frontmatter, issues, rawText, readOnly: false }
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(block.text)
    } catch (error) {
      issues.push({
        level: 'error',
        path: 'json',
        message: `JSON 代码块解析失败：${error instanceof Error ? error.message : String(error)}`,
      })
      return { file, document: null, frontmatter, issues, rawText, readOnly: false }
    }

    const parsed = parseMapDocument(parsedJson)
    issues.push(...parsed.issues)
    const readOnly = parsed.document === null && parsed.issues.some((issue) => issue.message.includes('高于本插件支持'))

    return { file, document: parsed.document, frontmatter, issues, rawText, readOnly }
  }

  // -------------------------------------------------------------- 写

  private serialize(document: MapDocument, name: string, canvases: string[], extraFrontmatter?: Record<string, string | string[]>): string {
    return serializeMapFile({ name, document, canvases, extraFrontmatter })
  }

  /** 立即写入（原子读-改-写）。缺少类型标记时拒绝覆盖。 */
  async writeNow(
    file: TFile,
    document: MapDocument,
    name: string,
    canvases: string[],
    extraFrontmatter?: Record<string, string | string[]>,
  ): Promise<void> {
    const text = this.serialize(document, name, canvases, extraFrontmatter)
    const selfWriteKey = file.path
    try {
      await this.app.vault.process(file, (current) => {
        if (!current.includes(MAP_FILE_TYPE)) {
          throw new Error(
            `拒绝写入 ${file.path}：文件里没有 ${MAP_FILE_TYPE} 标记，可能不是地图文档（防止覆盖普通笔记）`,
          )
        }
        return text
      })
      // 写入成功后才登记自写记录：mtime 用于区分"自己写的"与"外部改的"
      const mtime = file.stat?.mtime
      this.selfWrites.set(selfWriteKey, {
        at: Date.now(),
        mtime: typeof mtime === 'number' ? mtime : Number.NaN,
      })
    } finally {
      // 记录只用于短时间内的自写识别，过期清理避免无界增长
      setTimeout(() => {
        const record = this.selfWrites.get(selfWriteKey)
        if (record && Date.now() - record.at >= SELF_WRITE_WINDOW_MS) this.selfWrites.delete(selfWriteKey)
      }, SELF_WRITE_WINDOW_MS + 100)
    }
    this.indexCache = null
  }

  /** 防抖写入：编辑期间可以先调用它，落盘延迟到 SAVE_DEBOUNCE_MS 之后 */
  scheduleSave(
    file: TFile,
    document: MapDocument,
    name: string,
    canvases: string[],
    extraFrontmatter?: Record<string, string | string[]>,
  ): void {
    const existing = this.pending.get(file.path)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.pending.delete(file.path)
      void this.writeNow(file, document, name, canvases, extraFrontmatter).catch((error) => {
        console.error('[project-kaki] 保存地图失败', error)
      })
    }, SAVE_DEBOUNCE_MS)
    this.pending.set(file.path, { file, document, name, canvases, extraFrontmatter, timer })
  }

  hasPendingWrites(): boolean {
    return this.pending.size > 0
  }

  /** 强制落盘所有待写内容（切换视图、退出插件、手动保存时调用） */
  async flush(): Promise<void> {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      await this.writeNow(entry.file, entry.document, entry.name, entry.canvases, entry.extraFrontmatter)
    }
  }

  // -------------------------------------------------------------- 创建与绑定

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath)
    if (normalized.length === 0 || normalized === '/') return
    const existing = this.app.vault.getAbstractFileByPath(normalized)
    if (existing instanceof TFolder) return
    if (existing !== null) return
    try {
      await this.app.vault.createFolder(normalized)
    } catch (error) {
      // 并发创建时可能已被别人建好，忽略
      if (!(this.app.vault.getAbstractFileByPath(normalized) instanceof TFolder)) throw error
    }
  }

  private uniquePath(folder: string, baseName: string): string {
    const fileName = dedupeFileName(baseName)
    let candidate = normalizePath(`${folder}/${fileName}.map.md`)
    let counter = 2
    while (this.app.vault.getAbstractFileByPath(candidate) !== null) {
      candidate = normalizePath(`${folder}/${fileName} ${counter}.map.md`)
      counter += 1
    }
    return candidate
  }

  async createMap(options: CreateMapOptions): Promise<TFile> {
    const folder = options.folder ?? 'Maps'
    await this.ensureFolder(folder)

    const preset = options.grid ?? {}
    const document = createEmptyMapDocument({
      orientation: preset.orientation,
      size: preset.size,
      origin: preset.origin,
    })
    const canvases = options.canvasPath ? [options.canvasPath] : []
    const path = this.uniquePath(folder, options.name)
    const text = this.serialize(document, options.name, canvases)

    const file = await this.app.vault.create(path, text)
    this.indexCache = null
    return file
  }

  /** 把一个 canvas 绑定到已有的地图文档（幂等） */
  async bindCanvas(file: TFile, document: MapDocument, name: string, canvasPath: string): Promise<boolean> {
    const loaded = await this.load(file)
    const canvases = [...loaded.frontmatter.canvases]
    if (canvases.includes(canvasPath)) return false
    canvases.push(canvasPath)
    await this.writeNow(file, document, name, canvases, loaded.frontmatter.rest)
    return true
  }
}
