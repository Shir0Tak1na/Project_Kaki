/**
 * 标记与文字标注的**屏幕布局** —— 纯函数模块。
 *
 * 为什么标记层与地形层分开（设计文档 ADR-3）：
 * - 地形走 canvas（量大、要批量绘制）；
 * - 标记与文字走 **DOM**：需要 hover 提示、点击打开笔记、可访问性，以及**字号不随缩放糊掉**。
 *
 * 因此标记层挂在**未变换**的 wrapperEl 上，每帧由投影算出屏幕坐标（billboard）。
 * 本模块只负责算位置与裁剪，不碰 DOM —— 于是它可以被单元测试直接覆盖。
 */

import { axialToWorld, type GridSpec, type Point } from '../core/hex.ts'
import { worldToClient, type ClientProjection } from '../core/projection.ts'
import type { MapDocument, MapLabel, MapMarker, MarkerIcon } from '../data/mapDocument.ts'

/** 标记图标的显示字号与尺寸（屏幕像素，恒定不随缩放变化） */
export const MARKER_ICON_SIZE = 18
export const MARKER_LABEL_FONT_SIZE = 12
/**
 * 文字标注字号的 clamp 区间（屏幕像素）。
 *
 * 下限 13 而不是 11：常见缩放（约 45%）下 `24 × scale ≈ 10.7`，会直接落到下限，
 * 于是"下限"实际上就是用户看到的字号。11 px 在真实反馈里被判为过小，
 * 与画布上路径/区域名称的下限（15/16）也更接近了。
 */
export const MIN_LABEL_FONT_SIZE = 13
export const MAX_LABEL_FONT_SIZE = 28
/** 视口外这个范围内仍然保留 DOM（避免边缘突然出现/消失） */
export const MARKER_CULL_MARGIN = 160

export interface MarkerPlacement {
  id: string
  kind: 'marker' | 'label'
  /** 视口局部 CSS 像素坐标（相对 wrapperEl 左上角） */
  x: number
  y: number
  label: string
  icon?: MarkerIcon
  color?: string
  link?: string
  description?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  rotation?: number
  /** 世界坐标（放置与调试用） */
  world: Point
}

export interface ViewportRect {
  left: number
  top: number
  width: number
  height: number
}

export interface BuildPlacementsOptions {
  document: MapDocument
  projection: ClientProjection
  viewportRect: ViewportRect
  /** 裁剪留白（屏幕像素） */
  margin?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 世界坐标 → 视口局部屏幕坐标 */
export function worldToViewport(projection: ClientProjection, viewportRect: ViewportRect, world: Point): Point {
  const client = worldToClient(projection, world)
  return { x: client.x - viewportRect.left, y: client.y - viewportRect.top }
}

function inViewport(point: Point, viewportRect: ViewportRect, margin: number): boolean {
  return (
    point.x >= -margin &&
    point.x <= viewportRect.width + margin &&
    point.y >= -margin &&
    point.y <= viewportRect.height + margin
  )
}

/**
 * 计算当前应当显示的标记与文字标注。
 *
 * - 只返回视口（外扩 margin）内的条目 —— 这样 DOM 规模只与**可见数量**有关，与地图总量无关；
 * - 文字字号 = 世界字号 × 缩放，再 clamp 到 [11, 28] px：既能随缩放变大，又不会大到失态或小到看不清。
 */
export function buildPlacements(options: BuildPlacementsOptions): MarkerPlacement[] {
  const { document, projection, viewportRect } = options
  const margin = options.margin ?? MARKER_CULL_MARGIN
  const scale = projection.scale
  const out: MarkerPlacement[] = []

  for (const marker of document.markers) {
    const world = { x: marker.p[0], y: marker.p[1] }
    const screen = worldToViewport(projection, viewportRect, world)
    if (!inViewport(screen, viewportRect, margin)) continue
    const placement: MarkerPlacement = {
      id: marker.id,
      kind: 'marker',
      x: screen.x,
      y: screen.y,
      label: marker.label,
      icon: marker.icon,
      world,
    }
    if (marker.c !== undefined) placement.color = marker.c
    if (marker.link !== undefined) placement.link = marker.link
    if (marker.desc !== undefined) placement.description = marker.desc
    out.push(placement)
  }

  for (const label of document.labels) {
    const world = { x: label.p[0], y: label.p[1] }
    const screen = worldToViewport(projection, viewportRect, world)
    if (!inViewport(screen, viewportRect, margin)) continue
    const worldSize = label.size ?? 24
    const placement: MarkerPlacement = {
      id: label.id,
      kind: 'label',
      x: screen.x,
      y: screen.y,
      label: label.text,
      fontSize: Math.round(clamp(worldSize * scale, MIN_LABEL_FONT_SIZE, MAX_LABEL_FONT_SIZE)),
      world,
    }
    if (label.color !== undefined) placement.color = label.color
    if (label.link !== undefined) placement.link = label.link
    if (label.bold === true) placement.bold = true
    if (label.italic === true) placement.italic = true
    if (label.rotation !== undefined) placement.rotation = label.rotation
    out.push(placement)
  }

  return out
}

/** 放置判定：按下与抬起之间几乎没移动才算"点击"（否则视为拖动） */
export const CLICK_SLOP_PX = 4

export function isClickGesture(from: Point | null, to: Point, slop = CLICK_SLOP_PX): boolean {
  if (from === null) return false
  return Math.hypot(to.x - from.x, to.y - from.y) <= slop
}

/** 放置位置吸附到格心：六边形地图上的标记落在格心比落在任意像素位置更符合直觉 */
export function snapToCellCenter(grid: GridSpec, q: number, r: number): Point {
  return axialToWorld(grid, q, r)
}

/** 稳定 id：类型 + 递增序号（可读且便于排查） */
export function nextMarkerId(document: MapDocument, prefix = 'm'): string {
  return nextId(
    prefix,
    [...document.markers.map((marker) => marker.id), ...document.labels.map((label) => label.id)],
  )
}

export function nextLabelId(document: MapDocument, prefix = 'l'): string {
  return nextId(
    prefix,
    [...document.markers.map((marker) => marker.id), ...document.labels.map((label) => label.id)],
  )
}

function nextId(prefix: string, existing: string[]): string {
  const used = new Set(existing)
  for (let index = 1; index < 100000; index += 1) {
    const candidate = `${prefix}${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${prefix}${Date.now()}`
}

/** 供 UI 使用的默认图标 */
export function defaultMarkerIcon(): MarkerIcon {
  return 'town'
}

/**
 * 标记图标 → Lucide 图标名（Obsidian 内置图标集）。
 *
 * ⚠️ Lucide 的图标名跨版本可能变化。渲染层会先用 `getIcon()` 校验：
 * 取不到就退回一个中性圆点，而不是**什么都不显示** —— 图标缺失不应该让标记"消失"。
 */
export const MARKER_ICON_LUCIDE: Record<MarkerIcon, string> = {
  city: 'building-2',
  town: 'home',
  fortress: 'shield',
  ruin: 'landmark',
  port: 'anchor',
  temple: 'church',
  'mountain-peak': 'mountain',
  cave: 'circle-dot',
  tower: 'tower-control',
}

export function lucideIconFor(icon: MarkerIcon): string {
  return MARKER_ICON_LUCIDE[icon] ?? 'circle-dot'
}

export type { MapLabel, MapMarker }
