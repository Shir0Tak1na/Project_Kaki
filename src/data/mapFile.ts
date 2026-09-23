/**
 * 地图文件（`.map.md`）的文本层 —— 纯函数模块。
 *
 * 文件形态（见设计文档 §2 ADR-2）：
 *
 *   ---
 *   type: fictional-cartographer-map
 *   fc-version: 1
 *   name: 艾尔登大陆
 *   canvases:
 *     - "Maps/World.canvas"
 *   ---
 *
 *   # 艾尔登大陆
 *
 *   > 说明性提示
 *
 *   ```json
 *   { ...地图文档... }
 *   ```
 *
 * frontmatter 只放可被 Obsidian 索引与 Base 查询的标量/短列表；
 * 几何数据全在 fenced JSON 里。
 *
 * ⚠️ 读取时以 Obsidian 的 metadataCache 为准（它正确处理完整 YAML）；
 * 本模块的 frontmatter 解析器是**针对我方自身输出格式的极简实现**，
 * 仅用于测试与元数据缓存尚未就绪的场合。
 */

import { MAP_DOCUMENT_VERSION, type MapDocument } from './mapDocument.ts'
import { serializeMapDocument } from './mapDocument.ts'

export const MAP_FILE_TYPE = 'fictional-cartographer-map'
export const MAP_FENCE_LANGUAGE = 'json'

export interface MapFileFrontmatter {
  type: string | null
  fcVersion: number | null
  name: string | null
  canvases: string[]
  /** 其余 frontmatter 字段（原样保留，写回时不丢失） */
  rest: Record<string, string | string[]>
}

export interface JsonBlock {
  text: string
  /** 代码块内容在原文中的起止下标，便于将来做局部替换 */
  start: number
  end: number
}

// ---------------------------------------------------------------- frontmatter

/** 取出文件开头的 `---` 块（不含分隔线本身） */
export function extractFrontmatterBlock(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return null
  const firstLineEnd = normalized.indexOf('\n')
  if (firstLineEnd === -1) return null
  const rest = normalized.slice(firstLineEnd + 1)
  const endMatch = /^---[ \t]*$/m.exec(rest)
  if (!endMatch) return null
  return rest.slice(0, endMatch.index)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if (first === '"' && last === '"') {
      try {
        return JSON.parse(trimmed) as string
      } catch {
        return trimmed.slice(1, -1)
      }
    }
    if (first === "'" && last === "'") {
      return trimmed.slice(1, -1).replace(/''/g, "'")
    }
  }
  return trimmed
}

/** 逗号分隔但尊重引号（路径里可能有逗号） */
function splitInlineList(inner: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  out.push(current)
  return out.map((item) => unquote(item)).filter((item) => item.length > 0)
}

/**
 * 极简 frontmatter 解析：支持 `key: value`、`key: [a, b]`、以及
 * `key:` 后跟缩进 `- item` 列表。其余内容原样保留在 `rest` 里。
 */
export function parseFrontmatter(block: string): MapFileFrontmatter {
  const rest: Record<string, string | string[]> = {}
  let type: string | null = null
  let name: string | null = null
  let fcVersion: number | null = null
  let canvases: string[] = []

  const lines = block.split(/\r?\n/)
  let pendingListKey: string | null = null

  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue

    const listItem = /^\s+-\s*(.*)$/.exec(line)
    if (listItem && pendingListKey !== null) {
      const item = unquote(listItem[1] ?? '')
      if (item.length > 0) {
        if (pendingListKey === 'canvases') canvases.push(item)
        else {
          const existing = rest[pendingListKey]
          rest[pendingListKey] = Array.isArray(existing) ? [...existing, item] : [item]
        }
      }
      continue
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) {
      pendingListKey = null
      continue
    }
    const key = pair[1]!
    const rawValue = (pair[2] ?? '').trim()

    if (rawValue.length === 0) {
      pendingListKey = key
      if (key === 'canvases') canvases = []
      continue
    }
    pendingListKey = null

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const items = splitInlineList(rawValue.slice(1, -1))
      if (key === 'canvases') canvases = items
      else rest[key] = items
      continue
    }

    const value = unquote(rawValue)
    if (key === 'type') type = value
    else if (key === 'name') name = value
    else if (key === 'fc-version') {
      const parsed = Number(value)
      fcVersion = Number.isFinite(parsed) ? parsed : null
    } else rest[key] = value
  }

  return { type, fcVersion, name, canvases, rest }
}

// ---------------------------------------------------------------- JSON 代码块

/** 找出第一个 ```json 代码块的内容与位置 */
export function extractJsonBlock(content: string): JsonBlock | null {
  const pattern = new RegExp('^[ \\t]*```' + MAP_FENCE_LANGUAGE + '[ \\t]*$', 'm')
  const open = pattern.exec(content)
  if (!open) return null
  const start = open.index + open[0].length + 1
  const closeMatch = /^[ \t]*```[ \t]*$/m.exec(content.slice(start))
  if (!closeMatch) return null
  const end = start + closeMatch.index
  return { text: content.slice(start, end), start, end }
}

export function isMapFileContent(content: string): boolean {
  const block = extractFrontmatterBlock(content)
  if (block === null) return false
  return parseFrontmatter(block).type === MAP_FILE_TYPE
}

// ---------------------------------------------------------------- 序列化

export interface SerializeMapFileOptions {
  name: string
  document: MapDocument
  /** 绑定到本图的 canvas 文件路径（vault 相对路径） */
  canvases: string[]
  /** 需要保留的其它 frontmatter 字段 */
  extraFrontmatter?: Record<string, string | string[]>
  /** 正文里的提示文本 */
  notice?: string
}

const DEFAULT_NOTICE = [
  '> [!info] 本文件由 Project Kaki 管理',
  '> 下方 JSON 代码块是地图数据。手工编辑请保持 JSON 合法；改动前建议先提交 Git。',
].join('\n')

function yamlScalar(value: string): string {
  // JSON 字符串是合法的 YAML 标量，用它避免引号/特殊字符问题
  return JSON.stringify(value)
}

export function serializeMapFile(options: SerializeMapFileOptions): string {
  const { name, document, canvases, extraFrontmatter } = options
  const lines: string[] = ['---']
  lines.push(`type: ${MAP_FILE_TYPE}`)
  lines.push(`fc-version: ${document.version}`)
  lines.push(`name: ${yamlScalar(name)}`)

  const otherKeys = Object.keys(extraFrontmatter ?? {}).filter((key) => key !== 'canvases')
  for (const key of otherKeys) {
    const value = extraFrontmatter![key]!
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`)
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`)
    }
  }

  if (canvases.length === 0) {
    lines.push('canvases: []')
  } else {
    lines.push('canvases:')
    for (const canvasPath of canvases) lines.push(`  - ${yamlScalar(canvasPath)}`)
  }
  lines.push('---', '')
  lines.push(`# ${name}`, '')
  lines.push(options.notice ?? DEFAULT_NOTICE, '')
  lines.push('```' + MAP_FENCE_LANGUAGE)
  lines.push(serializeMapDocument(document))
  lines.push('```', '')
  return lines.join('\n')
}

/** 从文件内容里读出地图文档（不做 frontmatter 归并，只负责 JSON 块） */
export function readMapDocumentFromFileContent(content: string): { text: string | null; block: JsonBlock | null } {
  const block = extractJsonBlock(content)
  return { text: block?.text ?? null, block }
}

/** 文件名 → 默认地图名（去掉扩展名，去掉 .map 后缀） */
export function defaultMapNameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.map\.md$/i, '').replace(/\.md$/i, '')
}

export { MAP_DOCUMENT_VERSION }
