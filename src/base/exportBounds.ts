/**
 * 导出范围：让**导出者自己决定导哪一块**。
 *
 * ## 为什么需要它（用户的原始问题）
 *
 * Base 缩略图与 SVG/PNG 导出一直是"扫全部内容取包围盒，等比缩进画布"。于是
 * **一个离主体很远的孤立格会把整张图缩小** —— 用户问"单独有一个离中心很远的格子，
 * 缩略图会变特别小吗"，答案是会；他随即提出"可以不可以让导出者自己选择区域"。
 *
 * 让他自己选，比我们替他裁掉内容更符合本项目的一条原则：
 * **不替用户丢数据**（孤立格属于用户的数据，不该被我们静默排除）。
 *
 * ## 三种范围
 *
 * - `all`：全部内容（默认，与既有行为完全一致）；
 * - `viewport`：当前可见的世界矩形（用户先平移/缩放到想要的区域再导出）；
 * - `region`：从地图上**画过的区域**里选一个，用它的多边形包围盒 + 留白。
 *
 * ## 实现口径（重要）
 *
 * 范围**只改变世界坐标 → 画布像素的映射**（即那个包围盒），内容仍然全部绘制，
 * **超出范围的部分由 SVG 的 viewport 自然裁掉**。
 * 刻意不写"先裁剪内容再绘制"的逻辑：那要复制一套几何判断，而每一处裁剪判断都是新的出错点；
 * 交给 SVG 自己的视口裁剪，行为由平台保证，我们只需要算对包围盒。
 *
 * 本模块**纯函数、不 import obsidian**：范围解析的每一种情况（空地图、没有区域、
 * 区域被删掉、视口还没画出来……）都能在没有 Obsidian 的环境里被测到。
 */

import type { MapDocument } from '../data/mapDocument.ts'
import type { BBox } from '../core/viewport.ts'
import { contentBounds } from './mapPreview.ts'
import type { MapRow } from './mapRows.ts'

export type ExportRangeKind = 'all' | 'viewport' | 'region'

export interface ExportRange {
  kind: ExportRangeKind
  /** 仅 `kind === 'region'` 时有意义 */
  regionId?: string
}

export interface ExportRangeOption {
  kind: ExportRangeKind
  label: string
  hint: string
}

/**
 * 界面上的三种范围。
 *
 * `all` 放第一位且是默认值：它是既有行为，也是最不容易让人意外的选择
 * （"我什么都没选，那就导全部"）。
 */
export const EXPORT_RANGE_OPTIONS: readonly ExportRangeOption[] = [
  {
    kind: 'all',
    label: '全部内容',
    hint: '把地图上所有东西装进一张图（与以前的导出行为一致）',
  },
  {
    kind: 'viewport',
    label: '当前视口',
    hint: '只导画布上现在能看到的那一块：先平移/缩放到想要的范围，再导出',
  },
  {
    kind: 'region',
    label: '某个区域',
    hint: '选一个你在画布上画过的区域，按它的范围导出（一区一张图）',
  },
]

/**
 * 世界单位的留白（不是图片那条 32 **像素**的内边距，两者单位不同、各管各的）。
 *
 * 留白的作用：让范围的边缘不至于紧贴图片边界 —— 否则区域边框、路径线宽会被切掉一半。
 */
export const EXPORT_WORLD_PADDING = 32

/**
 * 最小跨度（世界单位）。
 *
 * 为什么要挡：包围盒宽或高为 0 时，`pointToSvgPoint` 里 `spanX || 1` 这类兜底会把内容
 * 放大到荒谬的比例，而 SVG/PNG 本身仍会"成功产出" —— 用户得到一张看起来像坏掉的图，
 * 却没有任何报错。**0 尺寸不该流到导出层**，在这里就把它撑开成一个可用的最小范围。
 */
export const MIN_EXPORT_SPAN = 1

export interface ExportBoundsInput {
  document: MapDocument | null
  /** 笔记行（与缩略图同一份内容来源：带坐标的笔记点也算"内容"） */
  rows?: readonly MapRow[]
  /** 当前可见的世界矩形；来自地图层的最近一帧（没有就报可读原因） */
  viewportWorld?: BBox | null
}

export type ExportBoundsResult =
  | { ok: true; bounds: BBox; description: string }
  | { ok: false; reason: string }

/** 把包围盒按留白外扩，并保证两个方向的跨度都不小于 `MIN_EXPORT_SPAN`（见该常量的说明） */
export function padBounds(bounds: BBox, padding = EXPORT_WORLD_PADDING): BBox {
  const padded = {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  }
  return {
    minX: expandAxisStart(padded.minX, padded.maxX),
    minY: expandAxisStart(padded.minY, padded.maxY),
    maxX: expandAxisEnd(padded.minX, padded.maxX),
    maxY: expandAxisEnd(padded.minY, padded.maxY),
  }
}

/** 跨度太小就以中点为心撑开到最小跨度；否则原样返回 */
function expandAxisStart(min: number, max: number): number {
  return max - min >= MIN_EXPORT_SPAN ? min : (min + max) / 2 - MIN_EXPORT_SPAN / 2
}

function expandAxisEnd(min: number, max: number): number {
  return max - min >= MIN_EXPORT_SPAN ? max : (min + max) / 2 + MIN_EXPORT_SPAN / 2
}

/** 范围的尺寸（世界单位，四舍五入到整数，用于给人看的描述） */
export function boundsSize(bounds: BBox): { width: number; height: number } {
  return {
    width: Math.max(0, Math.round(bounds.maxX - bounds.minX)),
    height: Math.max(0, Math.round(bounds.maxY - bounds.minY)),
  }
}

/** 地图上可选的区域（给对话框的下拉用） */
export function listExportRegions(document: MapDocument | null): Array<{ id: string; label: string }> {
  if (!document) return []
  return document.regions.map((region, index) => ({
    // 没有名字的区域也要能选：用序号兜底，否则"未命名区域"在下拉里是一片空白
    id: region.id,
    label: region.label.length > 0 ? region.label : `未命名区域 ${index + 1}`,
  }))
}

function regionBounds(document: MapDocument | null, regionId: string | undefined): BBox | null {
  if (!document || regionId === undefined) return null
  const region = document.regions.find((item) => item.id === regionId)
  if (!region || region.pts.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of region.pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 解析范围 → 世界矩形 + 一句可读描述；解析不了就给出**可读原因**。
 *
 * 失败一律返回原因而不是抛异常：调用方是"点一下按钮"的命令，
 * 报错必须变成一句人话（"这张地图上还没有区域"），而不是控制台里的堆栈。
 */
export function resolveExportBounds(range: ExportRange, input: ExportBoundsInput): ExportBoundsResult {
  const rows = input.rows ?? []

  if (range.kind === 'viewport') {
    const viewport = input.viewportWorld
    if (!viewport) {
      return { ok: false, reason: '还没有可见视口：先把地图层显示出来（或平移一下画布）再导出。' }
    }
    const bounds = padBounds(viewport)
    const size = boundsSize(bounds)
    return { ok: true, bounds, description: `当前视口 · ${size.width} × ${size.height} 世界单位` }
  }

  if (range.kind === 'region') {
    const regions = listExportRegions(input.document)
    if (regions.length === 0) {
      return { ok: false, reason: '这张地图上还没有区域：先在画布上画一个区域，再按区域导出。' }
    }
    const raw = regionBounds(input.document, range.regionId)
    if (!raw) {
      return { ok: false, reason: '找不到这个区域：它可能已经被删除了。请重新选择。' }
    }
    const bounds = padBounds(raw)
    const size = boundsSize(bounds)
    const label = regions.find((item) => item.id === range.regionId)?.label ?? range.regionId ?? ''
    return { ok: true, bounds, description: `区域「${label}」· ${size.width} × ${size.height} 世界单位` }
  }

  const raw = contentBounds(rows, input.document)
  const bounds = padBounds(raw)
  const size = boundsSize(bounds)
  return { ok: true, bounds, description: `全部内容 · ${size.width} × ${size.height} 世界单位` }
}

/**
 * 清洗成可安全放进文件名的片段。
 *
 * 区域名是用户随手起的，可能带 `/`、`:`、`?` 这类字符 —— 直接拼进路径会造出子目录或非法名。
 * 这里保守处理：只保留中英文、数字、下划线、连字符与空格，其余换成 `-`，并截断长度。
 * 全空时返回 `''`（调用方据此退回不带后缀的文件名，而不是拼出一个以 `-` 结尾的名字）。
 */
export function sanitizeFileSegment(text: string, maxLength = 32): string {
  const cleaned = text
    .trim()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\w\u4e00-\u9fff\u3040-\u30ff -]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned
}

/**
 * 导出文件名（不含扩展名）。
 *
 * 为什么把范围写进名字：同一次会话里按"全部内容"和按"某个区域"各导一次是很自然的用法，
 * 名字不带范围就会出现 `Los.svg` / `Los-2.svg` 这种"看不出哪张是哪张"的结果。
 * `all` 不加后缀 —— 既有行为与既有文件名不变（避免让老用户的肌肉记忆失效）。
 */
export function exportFileNameFor(
  basePath: string,
  range: ExportRange,
  document: MapDocument | null,
): string {
  if (range.kind === 'viewport') return `${basePath}-视口`
  if (range.kind === 'region') {
    const label = listExportRegions(document).find((item) => item.id === range.regionId)?.label ?? ''
    const segment = sanitizeFileSegment(label)
    return segment.length > 0 ? `${basePath}-${segment}` : `${basePath}-区域`
  }
  return basePath
}
