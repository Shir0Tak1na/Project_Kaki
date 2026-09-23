/**
 * 视口与坐标变换 —— 纯函数模块（见设计文档 §3）。
 *
 * ⚠️ 重要：本模块的公式是**推导**结果，不是 Obsidian 源码引用。
 * 唯一权威的指针 → 世界转换是 Canvas 内部的 posFromEvt()；
 * 本模块的公式只在这些私有方法不可用时兜底，并必须由 Phase 0 的 P4 探针实测校准。
 */

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  /** 世界空间中视口中心点的 x */
  tx: number
  /** 世界空间中视口中心点的 y */
  ty: number
  /** log2(scale) */
  tZoom: number
  /** 视口 CSS 像素宽度 */
  width: number
  /** 视口 CSS 像素高度 */
  height: number
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Obsidian Canvas 对 tZoom 的 clamp 区间（来源：Advanced Canvas zoomToRealBbox） */
export const MIN_TZOOM = -4
export const MAX_TZOOM = 1

export function scaleOf(vp: Viewport): number {
  return 2 ** vp.tZoom
}

export function clampTZoom(tZoom: number): number {
  return Math.min(MAX_TZOOM, Math.max(MIN_TZOOM, tZoom))
}

/** 世界坐标 → 视口内 CSS 像素坐标（左上角为原点） */
export function worldToScreen(vp: Viewport, p: Point): Point {
  const s = scaleOf(vp)
  return {
    x: (p.x - vp.tx) * s + vp.width / 2,
    y: (p.y - vp.ty) * s + vp.height / 2,
  }
}

/** 视口内 CSS 像素坐标 → 世界坐标 */
export function screenToWorld(vp: Viewport, p: Point): Point {
  const s = scaleOf(vp)
  return {
    x: (p.x - vp.width / 2) / s + vp.tx,
    y: (p.y - vp.height / 2) / s + vp.ty,
  }
}

/** 当前视口在世界空间中可见的矩形范围，用于视口裁剪 */
export function viewportWorldBBox(vp: Viewport): BBox {
  const s = scaleOf(vp)
  const halfW = vp.width / 2 / s
  const halfH = vp.height / 2 / s
  return {
    minX: vp.tx - halfW,
    minY: vp.ty - halfH,
    maxX: vp.tx + halfW,
    maxY: vp.ty + halfH,
  }
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}

/** 形状守卫：用于校验从私有对象读到的视口数据是否可用 */
export function isViewport(value: unknown): value is Viewport {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.tx === 'number' &&
    typeof v.ty === 'number' &&
    typeof v.tZoom === 'number' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    Number.isFinite(v.tx) &&
    Number.isFinite(v.ty) &&
    Number.isFinite(v.tZoom) &&
    v.width > 0 &&
    v.height > 0
  )
}
